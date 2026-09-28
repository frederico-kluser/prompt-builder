// Contrato do DRY-RUN COM PARIDADE DE RECUSA (IMPL-029, R-12:REC-4).
//
// O furo medido: o `--dry-run` devolvia ANTES do pré-voo e aprovava com exit 0
// o que a execução real recusava (modelo inexistente, teto de preço, saldo,
// faixa duvidosa sem --yes) — e `models`/`estimate` exigiam key para ler o
// catálogo, que é PÚBLICO.
//
// Aqui provamos:
//   1. TABELA PAREADA (em processo, gateway falso): para CADA recusa conhecida,
//      a mesma config roda como dry-run e como execução real e as duas devolvem
//      o MESMO error.code e o MESMO exit — paridade medida = 100%. Uma varredura
//      do src/cli/preflight.ts garante que recusa nova sem caso pareado derruba
//      o teste. Nenhum caso faz chamada de chat (nada pago).
//   2. PROCESSO REAL (tsx + servidor HTTP local): `compare … --dry-run --json`
//      sem key sai 0 com estimativa e wouldRefuse []; com modelo inexistente, o
//      envelope traz config.unknown_model com o exit da recusa real; `models
//      list`, `estimate` e `agents run --dry-run` funcionam sem key.
//   3. UNIDADE: catálogo público em disco (sem key), variantes de roteamento,
//      ids efetivamente chamados.
//
// Nada aqui sai da máquina: o gateway é falso (em processo) ou aponta para um
// servidor HTTP em 127.0.0.1 (processo real).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeOrTsx } from './support/cli.js';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmdRun } from '../src/cli/commands/run.js';
import { EXIT, resetOutputState, toCliError } from '../src/cli/output.js';
import { isKnownModel, modelIdsCalledBy, runPreflight, type Refusal } from '../src/cli/preflight.js';
import { createGateway, setDefaultGateway, type FetchLike, type OpenRouterGateway } from '../src/openrouter.js';
import { catalogPath, ensureCatalog } from '../src/modelsCache.js';
import { setDataDir } from '../src/storage.js';
import { acquireRunLock, configHash, type RunLock } from '../src/cli/runLock.js';
import { FileSpendLedger, writeDailyCap } from '../src/cli/spendLedger.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import type { RunConfig, RunMode } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { cmd: TSX, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));

const VALID_KEY = `sk-or-v1-${'a'.repeat(48)}`;
const BAD_KEY = `sk-or-v1-${'b'.repeat(48)}`;

/** Catálogo cru (formato do OpenRouter), preço por token. */
const CATALOG = [
  catalogItem('acme/alpha', 1e-6, 2e-6),
  catalogItem('acme/beta', 2e-6, 4e-6),
  catalogItem('acme/judge', 3e-6, 1.5e-5),
  catalogItem('acme/pricey', 3e-5, 6e-5),
  // Preço variável (o `openrouter/auto` real vem com "-1"): sem estimativa possível.
  catalogItem('openrouter/auto', -1, -1),
];

// --- mundo falso por invocação ---------------------------------------------

interface Seen {
  method: string;
  path: string;
  auth: string;
}

interface World {
  dir: string;
  seen: Seen[];
  chats: () => number;
  gateway: OpenRouterGateway;
}

interface WorldOpts {
  /** `'down'` = GET /models responde 503 (e não há cache em disco). */
  catalog?: unknown[] | 'down';
  keyData?: Record<string, unknown>;
  /** `GET /key` sem rede (a key pode estar boa): falha de transporte. */
  keyDown?: boolean;
}

/** Transporte falso: o fake do IMPL-021 + /models fora do ar + key recusada (401). */
function fakeTransport(opts: WorldOpts): { fetch: FetchLike; seen: Seen[]; chats: () => number } {
  const fake = fakeOpenRouter({
    catalog: opts.catalog === 'down' ? [] : (opts.catalog ?? CATALOG),
    keyData: opts.keyData ?? { label: 'fake', usage: 0, limit: null, limit_remaining: null },
    // Qualquer chat aqui é BUG: o pré-voo tem de recusar antes de gastar.
    chat: () => ({ status: 500, bodyText: 'chat proibido neste teste' }),
  });
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.Authorization ?? headers.authorization ?? '';
    const p = new URL(url).pathname;
    seen.push({ method: (init?.method ?? 'GET').toUpperCase(), path: p, auth });
    if (opts.catalog === 'down' && p.endsWith('/models')) return new Response('fora do ar', { status: 503 });
    if (opts.keyDown && p.endsWith('/key')) throw new TypeError('fetch failed');
    if (p.endsWith('/key') && auth.includes(BAD_KEY)) return new Response('{"error":"invalid"}', { status: 401 });
    return fake.fetch(url, init);
  };
  return { fetch, seen, chats: () => fake.chatRequests().length };
}

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function newWorld(opts: WorldOpts = {}): World {
  const t = fakeTransport(opts);
  const gateway = createGateway({ fetch: t.fetch, sleep: noSleep });
  return { dir: tmp('pb-parity-'), seen: t.seen, chats: t.chats, gateway };
}

interface Outcome {
  exit: number;
  errorCode?: string;
  details?: unknown;
  stdout: string;
}

/** Roda `cmdRun` em processo com o gateway falso; erro vira o que o `main` renderizaria. */
async function invoke(world: World, mode: RunMode, argv: string[]): Promise<Outcome> {
  const prev = setDefaultGateway(world.gateway);
  resetOutputState();
  const out: string[] = [];
  const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    out.push(String(c));
    return true;
  });
  const se = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const exit = await cmdRun(mode, [...argv, '--data-dir', world.dir, '--json']);
    return { exit, stdout: out.join('') };
  } catch (e) {
    const err = toCliError(e);
    return { exit: err.code, errorCode: err.errorCode, details: err.details, stdout: out.join('') };
  } finally {
    so.mockRestore();
    se.mockRestore();
    resetOutputState();
    setDefaultGateway(prev);
  }
}

// Fora de TTY (agente): a faixa duvidosa recusa e --budget é obrigatório.
/**
 * Locks tomados no setup (o "outro processo" é o próprio processo de teste):
 * soltos no afterAll — senão o heartbeat (unref) e o listener de 'exit'
 * sobreviviam ao arquivo de teste.
 */
const locksDoSetup: RunLock[] = [];

const envSalvo: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ['CI', 'OPENROUTER_API_KEY', 'PROMPT_BUILDER_HOME']) envSalvo[k] = process.env[k];
  process.env.CI = '1';
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.PROMPT_BUILDER_HOME;
});
afterAll(() => {
  for (const l of locksDoSetup.splice(0)) l.release();
  for (const [k, v] of Object.entries(envSalvo)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// --- 1. tabela pareada ------------------------------------------------------

const BASE = ['--theme', 'Suporte de faturamento', '--judge', 'acme/judge', '--stages', '3'];
const COMPARE = [...BASE, '--models', 'acme/alpha,acme/beta'];
/** vary/train precisam de contestants suficientes (2 técnicas). */
const TECNICAS = ['--techniques', 'persona,constraints'];

/** Faixa estimada da config COMPARE (sonda por dry-run com key e sem teto). */
let faixa = { low: 0, high: 0 };
beforeAll(async () => {
  const r = await invoke(newWorld(), 'compare', [...COMPARE, '--budget', 'none', '--key', VALID_KEY, '--dry-run']);
  expect(r.exit, r.stdout).toBe(EXIT.OK);
  const est = (JSON.parse(r.stdout) as { data: { estimate: { low: number; high: number } } }).data.estimate;
  faixa = { low: est.low, high: est.high };
  expect(faixa.high).toBeGreaterThan(faixa.low);
  expect(faixa.low).toBeGreaterThan(0);
});

interface Caso {
  nome: string;
  /** error.code que a execução real devolve. */
  code: string;
  exit: number;
  mode?: RunMode;
  argv: () => string[];
  world?: WorldOpts;
  /** `parse` = recusado antes do pré-voo (parse/schema) — sem `wouldRefuse` em details. */
  stage?: 'parse' | 'preflight';
  /** Estado da máquina ANTES de invocar (IMPL-031: lock ativo, gasto do dia). Roda nos 2 mundos. */
  setup?: (dir: string) => Promise<void> | void;
}

const CASOS: Caso[] = [
  {
    nome: 'orçamento ausente fora de TTY',
    code: 'usage.budget_required',
    exit: EXIT.USAGE,
    argv: () => [...COMPARE, '--key', VALID_KEY],
  },
  {
    nome: 'catálogo indisponível (sem cache em disco)',
    code: 'network.catalog_unavailable',
    exit: EXIT.NETWORK,
    argv: () => [...COMPARE, '--budget', '100', '--key', VALID_KEY],
    world: { catalog: 'down' },
  },
  {
    nome: 'modelo inexistente, SEM key',
    code: 'config.unknown_model',
    exit: EXIT.CONFIG,
    argv: () => [...BASE, '--models', 'acme/alpha,ghost/nao-existe', '--budget', '100'],
  },
  {
    nome: 'modelo inexistente, com key',
    code: 'config.unknown_model',
    exit: EXIT.CONFIG,
    argv: () => [...BASE, '--models', 'acme/alpha,ghost/nao-existe', '--budget', '100', '--key', VALID_KEY],
  },
  {
    nome: 'modelo inexistente em train (contestant)',
    code: 'config.unknown_model',
    exit: EXIT.CONFIG,
    mode: 'training',
    // `--reference acme/beta` (IMPL-048: papéis separados, obrigatório em
    // training/variation) é um modelo CONHECIDO: o alvo da recusa segue sendo
    // o contestant inexistente.
    argv: () => [...BASE, ...TECNICAS, '--model', 'ghost/nao-existe', '--reference', 'acme/beta', '--iterations', '2', '--budget', '100', '--key', VALID_KEY],
  },
  {
    nome: 'variante de roteamento (:nitro) sem preço exato, com teto',
    code: 'config.unpriced_models',
    exit: EXIT.CONFIG,
    argv: () => [...BASE, '--models', 'acme/alpha,acme/beta:nitro', '--budget', '100', '--key', VALID_KEY],
  },
  {
    nome: 'modelo de preço variável (openrouter/auto), com teto',
    code: 'config.unpriced_models',
    exit: EXIT.CONFIG,
    mode: 'variation',
    // `--reference acme/beta` (IMPL-048): conhecido e precificado — o alvo da
    // recusa segue sendo o contestant de preço variável.
    argv: () => [...BASE, ...TECNICAS, '--model', 'openrouter/auto', '--reference', 'acme/beta', '--budget', '100', '--key', VALID_KEY],
  },
  {
    nome: 'teto por requisição abaixo do preço de um modelo',
    code: 'config.price_cap_below_model',
    exit: EXIT.CONFIG,
    argv: () => [...BASE, '--models', 'acme/alpha,acme/pricey', '--max-price-in', '5', '--budget', '100', '--key', VALID_KEY],
  },
  {
    nome: 'orçamento abaixo do piso estimado',
    code: 'usage.budget_below_estimate',
    exit: EXIT.USAGE,
    argv: () => [...COMPARE, '--budget', String(faixa.low / 10), '--key', VALID_KEY],
  },
  {
    nome: 'orçamento dentro da faixa, sem --yes',
    code: 'usage.confirmation_required',
    exit: EXIT.USAGE,
    argv: () => [...COMPARE, '--budget', String((faixa.low + faixa.high) / 2), '--key', VALID_KEY],
  },
  {
    nome: '--force sem --yes abaixo do piso ainda pede confirmação',
    code: 'usage.confirmation_required',
    exit: EXIT.USAGE,
    argv: () => [...COMPARE, '--budget', String(faixa.low / 10), '--force', '--key', VALID_KEY],
  },
  {
    nome: 'key recusada pelo OpenRouter',
    code: 'auth.key_invalid',
    exit: EXIT.AUTH,
    argv: () => [...COMPARE, '--budget', '100', '--key', BAD_KEY],
  },
  {
    nome: 'saldo da key abaixo do piso',
    code: 'credit.insufficient',
    exit: EXIT.NO_CREDIT,
    argv: () => [...COMPARE, '--budget', '100', '--key', VALID_KEY],
    world: { keyData: { label: 'fake', usage: 1, limit: 1, limit_remaining: 1e-9 } },
  },
  {
    nome: 'GET /key sem rede (key não verificada)',
    code: 'network.key_check_failed',
    exit: EXIT.NETWORK,
    argv: () => [...COMPARE, '--budget', '100', '--key', VALID_KEY],
    world: { keyDown: true },
  },
  {
    // IMPL-031: outro processo VIVO roda a MESMA config (o lock é do próprio
    // processo de teste — PID vivo, heartbeat fresco).
    nome: 'lock ativo da mesma config (outro processo rodando)',
    code: 'run.locked',
    exit: EXIT.USAGE,
    argv: () => [...COMPARE, '--budget', '100', '--key', VALID_KEY],
    setup: async (dir) => {
      const sonda = await invoke(newWorld(), 'compare', [...COMPARE, '--budget', '100', '--key', VALID_KEY, '--dry-run']);
      const cfg = (JSON.parse(sonda.stdout) as { data: { config: RunConfig } }).data.config;
      locksDoSetup.push(acquireRunLock(dir, { command: 'compare', configHash: configHash(cfg), runId: 'run-de-outro-processo' }));
    },
  },
  {
    // IMPL-031: o teto diário da máquina já foi gasto por outro processo hoje.
    nome: 'teto diário da máquina esgotado',
    code: 'control.daily_cap_reached',
    exit: EXIT.BUDGET,
    argv: () => [...COMPARE, '--budget', '100', '--key', VALID_KEY],
    setup: (dir) => {
      writeDailyCap(dir, 0.5);
      const outro = new FileSpendLedger({ dataDir: dir, cap: { capUsd: 0.5, source: 'file' }, label: 'outro' });
      outro.settle(outro.reserve(0.5), 0.5);
    },
  },
  {
    nome: 'key ausente com config válida',
    code: 'auth.key_missing',
    exit: EXIT.AUTH,
    argv: () => [...COMPARE, '--budget', '100'],
  },
  {
    nome: '--budget malformado (antes do pré-voo)',
    code: 'usage.invalid_budget',
    exit: EXIT.USAGE,
    argv: () => [...COMPARE, '--budget', 'abc', '--key', VALID_KEY],
    stage: 'parse',
  },
  {
    nome: 'juiz competindo (schema, antes do pré-voo)',
    code: 'config.invalid',
    exit: EXIT.CONFIG,
    argv: () => ['--theme', 't', '--judge', 'acme/alpha', '--models', 'acme/alpha,acme/beta', '--budget', '100'],
    stage: 'parse',
  },
];

interface Linha {
  caso: string;
  real: Outcome;
  dry: Outcome;
  coincide: boolean;
}
const placar: Linha[] = [];

/** Códigos que o dry-run devolve: o error.code (recusa) ou o de `requires` (key). */
function codigosDoDry(dry: Outcome): string[] {
  if (dry.errorCode) return [dry.errorCode];
  const data = (JSON.parse(dry.stdout) as { data: { requires: { code: string }[] } }).data;
  return data.requires.map((r) => r.code);
}

describe('dry-run × execução real — MESMO error.code para cada recusa conhecida', () => {
  for (const c of CASOS) {
    it(`${c.nome} → ${c.code} (exit ${c.exit})`, async () => {
      const mode = c.mode ?? 'compare';
      // Mundos separados: o cache em disco de uma rota não pode ajudar a outra.
      const wReal = newWorld(c.world);
      await c.setup?.(wReal.dir);
      const real = await invoke(wReal, mode, c.argv());
      const wDry = newWorld(c.world);
      await c.setup?.(wDry.dir);
      const dry = await invoke(wDry, mode, [...c.argv(), '--dry-run']);

      // A execução real recusa ANTES de gastar: zero chamadas de chat.
      expect(real.errorCode, real.stdout).toBe(c.code);
      expect(real.exit).toBe(c.exit);
      expect(wReal.chats()).toBe(0);
      expect(wDry.chats()).toBe(0);

      if (c.code === 'auth.key_missing') {
        // Única diferença POR DESENHO (critério da REC-4): sem key o dry-run
        // aprova a config (exit 0, wouldRefuse []) e lista a key em `requires`
        // com o code exato que a execução real devolve.
        expect(dry.exit).toBe(EXIT.OK);
        const data = (JSON.parse(dry.stdout) as { data: { wouldRefuse: Refusal[]; requires: { code: string }[] } }).data;
        expect(data.wouldRefuse).toEqual([]);
        expect(data.requires[0].code).toBe(real.errorCode);
      } else {
        expect(dry.errorCode).toBe(real.errorCode);
        expect(dry.exit).toBe(real.exit);
        if (c.stage !== 'parse') {
          const det = dry.details as { dryRun: boolean; wouldRefuse: Refusal[]; estimate: unknown };
          expect(det.dryRun).toBe(true);
          expect(det.wouldRefuse[0]).toMatchObject({ code: real.errorCode, exit: real.exit });
          expect(det.estimate).toBeDefined();
        }
      }

      placar.push({ caso: c.nome, real, dry, coincide: codigosDoDry(dry)[0] === real.errorCode });
    });
  }

  it('toda recusa emitida pelo pré-voo tem caso pareado (recusa nova sem teste derruba isto)', () => {
    const fonte = readFileSync(path.join(ROOT, 'src', 'cli', 'preflight.ts'), 'utf-8');
    const doPreflight = [...fonte.matchAll(/code: '([a-z]+\.[a-z_]+)'/g)].map((m) => m[1]);
    // Recusas que o pré-voo repassa de context.ts (key/catálogo).
    const repassadas = [
      'auth.key_missing',
      'auth.key_invalid',
      'network.catalog_unavailable',
      // IMPL-031: repassadas de context.ts (GET /key sem rede) e de runLock.ts (lock ativo).
      'network.key_check_failed',
      'run.locked',
    ];
    const cobertos = new Set(CASOS.map((c) => c.code));
    for (const code of new Set([...doPreflight, ...repassadas])) {
      expect(cobertos.has(code), `recusa ${code} sem caso pareado`).toBe(true);
    }
  });

  it('paridade medida = 100% de coincidência de código de recusa', () => {
    expect(placar.length).toBe(CASOS.length);
    const coincidem = placar.filter((l) => l.coincide).length;
    expect(coincidem / placar.length).toBe(1);
  });
});

describe('dry-run — ordem e conteúdo do relatório', () => {
  it('várias recusas: todas em wouldRefuse, NA ORDEM da real; a real para na 1ª sem tocar a rede', async () => {
    const argv = [...BASE, '--models', 'acme/alpha,ghost/x', '--key', VALID_KEY]; // sem --budget
    const wReal = newWorld();
    const real = await invoke(wReal, 'compare', argv);
    expect(real.errorCode).toBe('usage.budget_required');
    expect(wReal.seen).toEqual([]); // nem catálogo, nem /key

    const dry = await invoke(newWorld(), 'compare', [...argv, '--dry-run']);
    expect(dry.errorCode).toBe('usage.budget_required');
    const det = dry.details as { wouldRefuse: Refusal[]; estimate: { high: number } };
    expect(det.wouldRefuse.map((r) => r.code)).toEqual(['usage.budget_required', 'config.unknown_model']);
    expect(det.wouldRefuse[1].details).toMatchObject({ unknownModelIds: ['ghost/x'] });
    // A estimativa sai mesmo recusando: é com ela que o agente escolhe o --budget.
    expect(det.estimate.high).toBeGreaterThan(0);
  });

  it('config válida com key: exit 0, wouldRefuse [], saldo consultado (GET /key) e nenhum chat', async () => {
    const w = newWorld({ keyData: { label: 'fake', usage: 0, limit: 50, limit_remaining: 42 } });
    const r = await invoke(w, 'compare', [...COMPARE, '--budget', '100', '--key', VALID_KEY, '--dry-run']);
    expect(r.exit).toBe(EXIT.OK);
    const env = JSON.parse(r.stdout) as {
      ok: boolean;
      command: string;
      data: { wouldRefuse: unknown[]; requires: unknown[]; checks: Record<string, unknown>; config: RunConfig };
    };
    expect(env).toMatchObject({ ok: true, command: 'compare.dry-run' });
    expect(env.data.wouldRefuse).toEqual([]);
    expect(env.data.requires).toEqual([]);
    expect(env.data.checks).toMatchObject({ key: 'ok', creditRemainingUsd: 42, catalog: { scope: 'key', models: CATALOG.length } });
    expect(env.data.config.budgetUsd).toBe(100);
    expect(w.seen.map((s) => s.path.split('/').pop())).toEqual(['models', 'key']);
    expect(w.chats()).toBe(0);
  });

  it('sem key: catálogo PÚBLICO, nenhum GET /key, e o saldo vira pré-condição em requires', async () => {
    const w = newWorld();
    const r = await invoke(w, 'compare', [...COMPARE, '--budget', '100', '--dry-run']);
    expect(r.exit).toBe(EXIT.OK);
    const data = (JSON.parse(r.stdout) as {
      data: { requires: { code: string; what: string }[]; checks: Record<string, unknown> };
    }).data;
    expect(data.requires.map((x) => [x.what, x.code])).toEqual([
      ['key', 'auth.key_missing'],
      ['credit', 'credit.insufficient'],
    ]);
    expect(data.checks).toMatchObject({ key: 'missing', catalog: { scope: 'public' } });
    expect(w.seen.filter((s) => s.path.endsWith('/key'))).toEqual([]);
    // O catálogo público foi buscado SEM key (header vazio) e gravado em disco.
    expect(w.seen[0]).toMatchObject({ method: 'GET', auth: 'Bearer ' });
    expect(existsSync(path.join(w.dir, 'cache', 'models-public.json'))).toBe(true);
  });
});

// --- 2. processo real (tsx + servidor HTTP local) ---------------------------

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe('processo real (tsx) — sem OPENROUTER_API_KEY', { timeout: 120_000 }, () => {
  let server: Server;
  let base = '';
  let transport: ReturnType<typeof fakeTransport>;
  let home = '';

  beforeAll(async () => {
    transport = fakeTransport({});
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
        void transport
          .fetch(`http://127.0.0.1${req.url ?? '/'}`, { method: req.method, headers, body: body || undefined })
          .then(async (r) => {
            res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
            res.end(Buffer.from(await r.arrayBuffer()));
          });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    home = tmp('pb-parity-proc-');
  });

  /** spawn ASSÍNCRONO: o servidor falso vive neste processo e precisa do event loop. */
  function cli(args: string[]): Promise<CliRun> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PROMPT_BUILDER_HOME: home,
      OPENROUTER_BASE_URL: base,
      CI: '1',
    };
    delete env.OPENROUTER_API_KEY;
    return new Promise((resolve) => {
      const child = spawn(TSX, [ENTRY, ...args], { env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf-8')));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  }

  function json<T>(r: CliRun): T {
    expect(r.stdout.length, `stdout vazio; stderr: ${r.stderr}`).toBeGreaterThan(0);
    return JSON.parse(r.stdout) as T;
  }

  it('`compare … --dry-run --json` sem key: exit 0, estimativa e wouldRefuse []', async () => {
    const antes = transport.seen.length;
    const r = await cli(['compare', ...COMPARE, '--budget', '5', '--dry-run', '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const env = json<{
      ok: boolean;
      data: { estimate: { low: number; high: number }; wouldRefuse: unknown[]; requires: { code: string }[] };
    }>(r);
    expect(env.ok).toBe(true);
    expect(env.data.wouldRefuse).toEqual([]);
    expect(env.data.estimate.high).toBeGreaterThan(0);
    expect(env.data.requires.map((x) => x.code)).toContain('auth.key_missing');
    const idas = transport.seen.slice(antes).map((s) => s.path);
    expect(idas.every((p) => p.endsWith('/models'))).toBe(true); // só o catálogo público
    expect(transport.chats()).toBe(0);
  });

  it('`--models` inexistente: dry-run e real devolvem config.unknown_model com o MESMO exit', async () => {
    const argv = ['compare', ...BASE, '--models', 'acme/alpha,ghost/nao-existe', '--budget', '5', '--json'];
    const dry = await cli([...argv, '--dry-run']);
    const real = await cli(argv);
    const envDry = json<{ ok: boolean; error: { code: string; kind: string; details: { wouldRefuse: { code: string }[] } } }>(dry);
    const envReal = json<{ ok: boolean; error: { code: string; kind: string } }>(real);
    expect(envDry.ok).toBe(false);
    expect(envDry.error.code).toBe('config.unknown_model');
    expect(envDry.error.details.wouldRefuse).toEqual([expect.objectContaining({ code: 'config.unknown_model' })]);
    expect(envReal.error.code).toBe(envDry.error.code);
    expect(envReal.error.kind).toBe('config');
    expect(dry.status).toBe(EXIT.CONFIG);
    expect(real.status).toBe(dry.status);
    expect(transport.chats()).toBe(0);
  });

  it('`models list --json` e `models show` funcionam sem key (catálogo público)', async () => {
    const list = await cli(['models', 'list', '--json']);
    expect(list.status, list.stderr).toBe(EXIT.OK);
    const payload = json<{ count: number; scope: string; data: { id: string }[] }>(list);
    expect(payload.count).toBe(CATALOG.length);
    expect(payload.scope).toBe('public');

    const show = await cli(['models', 'show', 'acme/alpha', '--json']);
    expect(show.status, show.stderr).toBe(EXIT.OK);
    expect(json<{ data: { model: { id: string } } }>(show).data.model.id).toBe('acme/alpha');
  });

  it('`estimate --config` funciona sem key e precifica pelo catálogo', async () => {
    const file = path.join(home, 'run.json');
    writeFileSync(
      file,
      JSON.stringify({
        mode: 'compare',
        theme: 'Suporte',
        stages: 3,
        datagenModelId: 'acme/judge',
        judgeModelIds: ['acme/judge'],
        competitorModelIds: ['acme/alpha', 'acme/beta'],
      }),
    );
    const r = await cli(['estimate', '--config', file, '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const data = json<{ data: { estimate: { high: number; unpricedModelIds: string[] }; catalog: { scope: string } } }>(r).data;
    expect(data.estimate.high).toBeGreaterThan(0);
    expect(data.estimate.unpricedModelIds).toEqual([]);
    expect(data.catalog.scope).toBe('public');
  });

  it('`config validate` segue sem key e sem rede', async () => {
    const file = path.join(home, 'run.json');
    writeFileSync(
      file,
      JSON.stringify({
        mode: 'compare',
        theme: 'Suporte',
        stages: 3,
        datagenModelId: 'acme/judge',
        judgeModelIds: ['acme/judge'],
        competitorModelIds: ['acme/alpha', 'acme/beta'],
      }),
    );
    const antes = transport.seen.length;
    const r = await cli(['config', 'validate', file, '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(transport.seen.length).toBe(antes);
  });

  it('`agents run --dry-run` carrega o catálogo (estimativa dos papéis de LLM deixa de sair $0)', async () => {
    const file = path.join(home, 'agent.json');
    writeFileSync(
      file,
      JSON.stringify({
        format: 'arena-agent-config@1',
        mode: 'compare',
        theme: 'Correção de bugs',
        agent: { executor: 'pi', executorVersion: '0.84.2', limits: { maxCostUsd: 0.2 } },
        models: { datagen: 'acme/judge', judges: ['acme/judge'], competitors: ['acme/alpha', 'acme/beta'] },
        scenarios: [{ question: 'Conserte o parser.', agentTask: { files: [{ path: 'a.ts', content: 'x' }] } }],
      }),
    );
    const r = await cli(['agents', 'run', '--config', file, '--budget', '5', '--dry-run', '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const data = json<{
      data: {
        estimate: { byRole: Record<string, number>; unpricedModelIds: string[] };
        wouldRefuse: unknown[];
        requires: { code: string }[];
        checks: { catalog: { scope: string } | null };
      };
    }>(r).data;
    expect(data.checks.catalog?.scope).toBe('public');
    expect(data.estimate.byRole.judge + data.estimate.byRole.gabarito).toBeGreaterThan(0);
    expect(data.wouldRefuse).toEqual([]);
    expect(data.requires.map((x) => x.code)).toEqual(['auth.key_missing']);

    // Paridade com a execução real de agentes: sem --budget fora de TTY os dois recusam igual.
    const semBudget = ['agents', 'run', '--config', file, '--json'];
    const dry = json<{ error: { code: string } }>(await cli([...semBudget, '--dry-run']));
    const real = json<{ error: { code: string } }>(await cli(semBudget));
    expect(dry.error.code).toBe('usage.budget_required');
    expect(real.error.code).toBe(dry.error.code);
  });
});

// --- 3. unidade -------------------------------------------------------------

describe('catálogo público em disco (src/modelsCache.ts)', () => {
  let prev: OpenRouterGateway;
  let dir = '';
  let t: ReturnType<typeof fakeTransport>;

  beforeEach(() => {
    dir = tmp('pb-cat-');
    setDataDir(dir);
    t = fakeTransport({});
    prev = setDefaultGateway(createGateway({ fetch: t.fetch, sleep: noSleep }));
  });
  afterEach(() => {
    setDefaultGateway(prev);
  });

  it('sem key: busca o público uma vez, grava models-public.json e depois lê do disco', async () => {
    expect(catalogPath('')).toBe(path.join(dir, 'cache', 'models-public.json'));
    const a = await ensureCatalog('');
    expect(a).toMatchObject({ source: 'network', scope: 'public' });
    expect(a.models).toHaveLength(CATALOG.length);
    const b = await ensureCatalog('');
    expect(b).toMatchObject({ source: 'disk', scope: 'public' });
    expect(t.seen.filter((s) => s.path.endsWith('/models'))).toHaveLength(1);
  });

  it('sem key e sem cache público: reaproveita o cache FRESCO de uma key (sem rede)', async () => {
    await ensureCatalog(VALID_KEY); // grava o cache da key
    const idas = t.seen.length;
    const r = await ensureCatalog('');
    expect(r).toMatchObject({ source: 'disk', scope: 'public' });
    expect(t.seen.length).toBe(idas);
  });

  it('sem key, rede fora e só cache VENCIDO: usa o vencido e avisa (models list offline)', async () => {
    const velho = { v: 1, fetchedAt: Date.now() - 48 * 3_600_000, base: 'https://openrouter.ai/api/v1', count: 1 };
    mkdirSync(path.join(dir, 'cache'), { recursive: true });
    writeFileSync(
      path.join(dir, 'cache', 'models-0123456789abcdef.json'),
      JSON.stringify({ ...velho, data: [{ id: 'acme/velho', name: 'velho', pricing: { prompt: 0, completion: 0 } }] }),
    );
    setDefaultGateway(createGateway({ fetch: fakeTransport({ catalog: 'down' }).fetch, sleep: noSleep }));
    const avisos: string[] = [];
    const r = await ensureCatalog('', { onWarn: (m) => avisos.push(m) });
    expect(r).toMatchObject({ source: 'stale', scope: 'public' });
    expect(r.models.map((m) => m.id)).toEqual(['acme/velho']);
    expect(avisos[0]).toMatch(/offline/);
  });
});

describe('ids chamados e variantes de roteamento (src/cli/preflight.ts)', () => {
  it('variante dinâmica (:nitro/:floor/:online/:exacto) é conhecida se o id base é', () => {
    const ids = new Set(['acme/alpha', 'acme/beta:free']);
    expect(isKnownModel('acme/alpha', ids)).toBe(true);
    expect(isKnownModel('acme/alpha:nitro', ids)).toBe(true);
    expect(isKnownModel('acme/alpha:online', ids)).toBe(true);
    expect(isKnownModel('acme/beta:free', ids)).toBe(true);
    expect(isKnownModel('acme/beta', ids)).toBe(false);
    expect(isKnownModel('acme/alpha:inventada', ids)).toBe(false);
    expect(isKnownModel('ghost/x:nitro', ids)).toBe(false);
  });

  it('datagen só conta quando há cenário a gerar; reescritor só fora do compare', () => {
    const base = {
      mode: 'compare',
      theme: 't',
      stages: 1,
      datagenModelId: 'gen/x',
      judgeModelIds: ['j/x'],
      competitorModelIds: ['a/x', 'b/x'],
    } as RunConfig;
    expect(modelIdsCalledBy(base)).toEqual(['a/x', 'b/x', 'j/x', 'gen/x']);
    const pinado = {
      ...base,
      customStages: [{ question: 'q', productContext: 'c', maxTokens: 100 }],
    } as RunConfig;
    // Tudo pinado: o datagen configurado nunca é chamado — não pode virar recusa.
    expect(modelIdsCalledBy(pinado)).toEqual(['a/x', 'b/x', 'j/x']);
    const vary = {
      mode: 'variation',
      theme: 't',
      stages: 1,
      datagenModelId: 'gen/x',
      judgeModelIds: ['j/x'],
      contestantModelId: 'c/x',
      optimizerModelId: 'opt/x',
    } as RunConfig;
    expect(modelIdsCalledBy(vary)).toEqual(['c/x', 'j/x', 'gen/x', 'opt/x']);
  });

  it('modo real lança a 1ª recusa; dry-run coleta todas na mesma ordem (paridade por construção)', async () => {
    const config = {
      mode: 'compare',
      theme: 't',
      stages: 2,
      datagenModelId: 'acme/judge',
      judgeModelIds: ['acme/judge'],
      competitorModelIds: ['acme/alpha', 'ghost/x'],
      maxPricePerMTok: { prompt: 0.1 },
      budgetUsd: 1e-9,
    } as RunConfig;
    const models = (await createGateway({ fetch: fakeTransport({}).fetch }).listModels('', true));
    const deps = {
      loadCatalog: async () => ({ models, catalogSource: 'disk' as const, catalogScope: 'key' as const, fetchedAt: Date.now() }),
      checkKey: async () => ({ limitRemainingUsd: 0 }),
      info: () => undefined,
      warn: () => undefined,
    };
    const input = {
      config,
      budget: { kind: 'usd' as const, usd: 1e-9 },
      apiKey: VALID_KEY,
      yes: false,
      force: false,
      agentContext: true,
    };
    const rep = await runPreflight(input, deps, 'dry-run');
    const codes = rep.wouldRefuse.map((r) => r.code);
    expect(codes[0]).toBe('config.unknown_model');
    expect(codes).toContain('config.price_cap_below_model');
    expect(codes).toContain('usage.budget_below_estimate');
    expect(codes.at(-1)).toBe('credit.insufficient');
    await expect(runPreflight(input, deps, 'real')).rejects.toMatchObject({ errorCode: codes[0] });
  });
});
