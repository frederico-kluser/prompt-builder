// Contrato da DEFESA ANTI-GASTO-N× do CLI (IMPL-031, R-12:REC-6/DEC-5).
//
// O furo medido: nada impedia dois processos com a mesma config de gastar 2×
// (o ledger era por processo), não havia teto diário nem --idempotency-key, e
// o `doctor` saía 0 com a key falhando e nunca falava do limite por key do
// OpenRouter (a única camada que vale entre máquinas).
//
// Aqui provamos, em camadas:
//   1. UNIDADE: hash de config (sem o teto), lock (livre/ocupado/velho por PID
//      morto/velho por idade), ledger em arquivo (soma instâncias, teto diário,
//      reconciliação de processo morto), teto diário por env/arquivo/default,
//      recomendações de limite da key.
//   2. MÉTRICA COM 2 PROCESSOS (operários tsx + OpenRouter falso em 127.0.0.1):
//      custo real ≤ 1,01× a soma dos tetos; com teto diário, ≤ 1,01× o teto
//      (e o controle negativo — ledger só em memória — gasta 2×); o ledger em
//      arquivo fecha com a fatura (diferença ≤ 1%).
//   3. CLI EM PROCESSO: a run inteira passa pelo ledger da máquina (arquivo ==
//      fatura == record) e o teto diário para a run com exit 7.
//   4. CLI COM 2 PROCESSOS REAIS: o 2º com a mesma config sai `run.locked`;
//      `--idempotency-key` repetida se anexa/reusa sem gastar; `doctor` sai 4
//      sem key válida e recomenda limit/limit_reset.
//
// Nada aqui sai da máquina nem é pago: gateway falso em processo ou servidor
// HTTP em 127.0.0.1.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmdRun } from '../src/cli/commands/run.js';
import { keyLimitAdvice } from '../src/cli/commands/misc.js';
import { EXIT, resetOutputState, toCliError } from '../src/cli/output.js';
import {
  acquireRunLock,
  canonicalJson,
  claimIdempotency,
  configHash,
  IDEMPOTENCY_TTL_MS,
  idempotencyFile,
  inspectRunLock,
  lockFileFor,
  pruneIdempotency,
  readIdempotency,
} from '../src/cli/runLock.js';
import {
  DEFAULT_DAILY_CAP_USD,
  DAILY_CAP_ENV,
  DailyCapExceeded,
  FileSpendLedger,
  isDailyCapSignal,
  LEDGER_KEEP_DAYS,
  nextUtcMidnight,
  openMachineLedger,
  pruneLedgerDays,
  readDailySnapshot,
  resolveDailyCap,
  utcDay,
  writeDailyCap,
} from '../src/cli/spendLedger.js';
import { hostName, withMutexSync } from '../src/cli/fileGuard.js';
import { isBudgetSignal, isControlSignal } from '../src/budget.js';
import { createGateway, setDefaultGateway, type FetchLike } from '../src/openrouter.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter, type FakeRequest } from './fakeOpenRouter.js';
import type { RunConfig } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const ENTRY = path.join(ROOT, 'src', 'cli', 'index.ts');
const WORKER = path.join(ROOT, 'test', 'fixtures', 'spendWorker.ts');

const VALID_KEY = `sk-or-v1-${'a'.repeat(48)}`;
const BAD_KEY = `sk-or-v1-${'b'.repeat(48)}`;

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const envSalvo: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ['CI', 'OPENROUTER_API_KEY', 'PROMPT_BUILDER_HOME', DAILY_CAP_ENV]) envSalvo[k] = process.env[k];
  process.env.CI = '1';
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.PROMPT_BUILDER_HOME;
  delete process.env[DAILY_CAP_ENV];
});
afterAll(() => {
  for (const [k, v] of Object.entries(envSalvo)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** PID garantidamente MORTO: o de um processo que acabou de sair. */
function pidMorto(): number {
  const r = spawnSync(process.execPath, ['-e', '0']);
  return r.pid as number;
}

/** Soma do gasto MEDIDO em todos os arquivos de dia do ledger (a virada UTC não quebra o teste). */
function ledgerTotal(dataDir: string): number {
  const dir = path.join(dataDir, 'ledger');
  if (!existsSync(dir)) return 0;
  let s = 0;
  for (const f of readdirSync(dir).filter((n) => /^spend-.*\.json$/.test(n))) {
    const d = JSON.parse(readFileSync(path.join(dir, f), 'utf-8')) as {
      entries: Record<string, { spentUsd: number; presumedUsd: number }>;
    };
    for (const e of Object.values(d.entries)) s += e.spentUsd + e.presumedUsd;
  }
  return s;
}

// --- 1. unidade -----------------------------------------------------------------

const CFG_BASE = {
  mode: 'compare',
  theme: 'suporte',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  competitorModelIds: ['fake/a', 'fake/b'],
} as unknown as RunConfig;

describe('hash de config (identidade do experimento)', () => {
  it('ordem de chaves não importa; o teto (budgetUsd) não entra; qualquer outro campo entra', () => {
    const a = configHash(CFG_BASE);
    const reordenado = JSON.parse(canonicalJson(CFG_BASE)) as RunConfig;
    const embaralhado = Object.fromEntries(Object.entries(reordenado).reverse()) as unknown as RunConfig;
    expect(configHash(embaralhado)).toBe(a);
    expect(configHash({ ...CFG_BASE, budgetUsd: 5 })).toBe(a);
    expect(configHash({ ...CFG_BASE, budgetUsd: 50 })).toBe(a);
    expect(configHash({ ...CFG_BASE, stages: 3 })).not.toBe(a);
    expect(configHash({ ...CFG_BASE, mode: 'variation' } as RunConfig)).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('canonicalJson ignora undefined e ordena recursivamente', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  });
});

describe('lock de run por hash de config', () => {
  it('livre → toma; 2ª tomada com o mesmo hash → run.locked (exit 2) com o dono; release libera', () => {
    const dir = tmp('pb-lock-');
    const hash = configHash(CFG_BASE);
    const l1 = acquireRunLock(dir, { command: 'compare', configHash: hash, runId: 'run-1' });
    expect(existsSync(lockFileFor(dir, hash))).toBe(true);
    let erro: unknown;
    try {
      acquireRunLock(dir, { command: 'compare', configHash: hash });
    } catch (e) {
      erro = e;
    }
    const cli = toCliError(erro);
    expect(cli.errorCode).toBe('run.locked');
    expect(cli.code).toBe(EXIT.USAGE);
    expect(cli.kind).toBe('usage');
    const det = cli.details as { holder: { pid: number; runId: string; command: string } };
    expect(det.holder).toMatchObject({ pid: process.pid, runId: 'run-1', command: 'compare' });
    expect(cli.hint).toContain('--idempotency-key');

    // Outra config não conflita.
    const outra = acquireRunLock(dir, { command: 'compare', configHash: configHash({ ...CFG_BASE, stages: 9 }) });
    outra.release();

    l1.release();
    expect(existsSync(lockFileFor(dir, hash))).toBe(false);
    acquireRunLock(dir, { command: 'compare', configHash: hash }).release();
  });

  it('lock de PID MORTO nesta máquina é velho: é quebrado e a nova run toma', () => {
    const dir = tmp('pb-lock-dead-');
    const hash = configHash(CFG_BASE);
    const file = lockFileFor(dir, hash);
    const l = acquireRunLock(dir, { command: 'compare', configHash: hash });
    l.release();
    writeFileSync(
      file,
      JSON.stringify({ pid: pidMorto(), host: hostName(), token: 'velho', command: 'compare', configHash: hash, runId: null, sessionId: null, startedAt: '', idempotencyKey: null }),
    );
    expect(inspectRunLock(dir, hash)?.stale).toBe(true);
    const novo = acquireRunLock(dir, { command: 'compare', configHash: hash });
    expect((JSON.parse(readFileSync(file, 'utf-8')) as { pid: number }).pid).toBe(process.pid);
    novo.release();
  });

  it('lock com PID VIVO mas heartbeat parado há > 2 min é velho (stale por idade)', () => {
    const dir = tmp('pb-lock-age-');
    const hash = configHash(CFG_BASE);
    const file = lockFileFor(dir, hash);
    acquireRunLock(dir, { command: 'compare', configHash: hash }).release();
    writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, host: hostName(), token: 'congelado', command: 'compare', configHash: hash, runId: null, sessionId: null, startedAt: '', idempotencyKey: null }),
    );
    // Fresco: ocupado.
    expect(inspectRunLock(dir, hash)?.stale).toBe(false);
    const velho = new Date(Date.now() - 3 * 60_000);
    utimesSync(file, velho, velho);
    expect(inspectRunLock(dir, hash)?.stale).toBe(true);
    acquireRunLock(dir, { command: 'compare', configHash: hash }).release();
  });
});

describe('idempotency-key (registro atômico)', () => {
  it('só um vence a criação; a key volta com o hash e o dono', () => {
    const dir = tmp('pb-idem-');
    const hash = configHash(CFG_BASE);
    const a = claimIdempotency(dir, { key: 'k-1', configHash: hash, command: 'compare', runId: 'r1', sessionId: null });
    const b = claimIdempotency(dir, { key: 'k-1', configHash: hash, command: 'compare', runId: 'r2', sessionId: null });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(readIdempotency(dir, 'k-1')).toMatchObject({ runId: 'r1', configHash: hash, pid: process.pid });
    expect(existsSync(idempotencyFile(dir, 'k-1'))).toBe(true);
    expect(readIdempotency(dir, 'outra')).toBeNull();
  });
});

describe('ledger em arquivo (soma processos) e teto diário', () => {
  const CAP = { capUsd: 1, source: 'env' as const };

  it('duas instâncias somam no MESMO arquivo; o teto vale para o comprometido de todas', () => {
    const dir = tmp('pb-ledger-');
    const a = new FileSpendLedger({ dataDir: dir, cap: CAP, label: 'A' });
    const b = new FileSpendLedger({ dataDir: dir, cap: CAP, label: 'B' });
    const ha = a.reserve(0.4);
    const hb = b.reserve(0.4);
    // Em voo: 0,8 comprometidos → mais 0,3 não cabe em NENHUMA instância.
    expect(() => a.reserve(0.3)).toThrow(DailyCapExceeded);
    expect(b.canAfford(0.3)).toBe(false);
    expect(b.canAfford(0.2)).toBe(true);
    a.settle(ha, 0.35);
    b.release(hb);
    const s = a.snapshot();
    expect(s.spentUsd).toBeCloseTo(0.35, 12);
    expect(s.pendingUsd).toBeCloseTo(0, 12);
    expect(s.remainingUsd).toBeCloseTo(0.65, 12);
    expect(s.processes).toBe(2);
    expect(s.day).toBe(utcDay());
    expect(a.capHit).toBe(true);
  });

  it('DailyCapExceeded é sinal de CONTROLE de orçamento (reconhecido por forma) e vira control.daily_cap_reached (exit 7)', () => {
    const e = new DailyCapExceeded(1.2, 1, 'judge');
    expect(isControlSignal(e)).toBe(true);
    expect(isBudgetSignal(e)).toBe(true);
    expect(isDailyCapSignal(e)).toBe(true);
    const cli = toCliError(e);
    expect(cli.code).toBe(EXIT.BUDGET);
    expect(cli.errorCode).toBe('control.daily_cap_reached');
    expect(cli.kind).toBe('control');
    expect(cli.details).toMatchObject({ capUsd: 1, spentTodayUsd: 1.2, role: 'judge' });
  });

  it('reconciliação: reserva em voo de processo MORTO vira gasto presumido (falha fechada), separado do medido', () => {
    const dir = tmp('pb-ledger-dead-');
    const dia = utcDay();
    const file = path.join(dir, 'ledger', `spend-${dia}.json`);
    const vivo = new FileSpendLedger({ dataDir: dir, cap: CAP, label: 'vivo' });
    vivo.settle(vivo.reserve(0.1), 0.1);
    const d = JSON.parse(readFileSync(file, 'utf-8')) as { entries: Record<string, unknown> };
    d.entries['morto'] = {
      pid: pidMorto(),
      host: hostName(),
      label: 'morto',
      startedAt: '',
      updatedAt: '',
      spentUsd: 0.2,
      pendingUsd: 0.3,
      presumedUsd: 0,
      calls: 1,
    };
    writeFileSync(file, JSON.stringify(d));
    const snap = vivo.snapshot();
    expect(snap.spentUsd).toBeCloseTo(0.6, 12); // 0,1 + 0,2 medidos + 0,3 presumidos
    expect(snap.presumedUsd).toBeCloseTo(0.3, 12);
    expect(snap.pendingUsd).toBeCloseTo(0, 12);
    // Uma escrita qualquer persiste a reconciliação.
    vivo.release(vivo.reserve(0));
    const depois = JSON.parse(readFileSync(file, 'utf-8')) as { entries: Record<string, { pendingUsd: number; presumedUsd: number }> };
    expect(depois.entries['morto']).toMatchObject({ pendingUsd: 0, presumedUsd: 0.3 });
  });

  it('MachineBudgetLedger no gateway REAL: arquivo == fatura; teto da RUN segue valendo; teto DIÁRIO para a chamada', async () => {
    const dir = tmp('pb-ledger-gw-');
    const fake = fakeOpenRouter({ chat: () => ({ text: 'ok', usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.009 } }) });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const { root, machine } = openMachineLedger({
      dataDir: dir,
      label: 'teste',
      budgetUsd: 0.05,
      estimateCall: () => 0.01,
      cap: { capUsd: 0.03, source: 'env' },
    });
    const run = root.fork();
    const chamar = () =>
      gw.chatCompletion({ apiKey: VALID_KEY, modelId: 'x/y', messages: [{ role: 'user', content: 'oi' }], sink: run, role: 'judge' });
    await chamar();
    await chamar();
    await chamar();
    // 3 × 0,009 = 0,027; +0,01 reservado passaria do teto DIÁRIO (0,03) antes do da run (0,05).
    const err = await chamar().catch((e: unknown) => e);
    expect(isDailyCapSignal(err)).toBe(true);
    expect(machine.capHit).toBe(true);
    expect(fake.billedCalls()).toBe(3);
    expect(run.spentUsd).toBeCloseTo(fake.billedUsd(), 12);
    expect(ledgerTotal(dir)).toBeCloseTo(fake.billedUsd(), 12);
    expect(machine.snapshot().pendingUsd).toBeCloseTo(0, 12);
    expect(run.remainingUsd()).toBeCloseTo(0.003, 12); // min(0,05−0,027 ; 0,03−0,027)
    expect(run.byRole.judge.calls).toBe(3);

    // Sem teto diário, o teto da RUN (raiz) é quem para — semântica de antes.
    const dir2 = tmp('pb-ledger-gw2-');
    const m2 = openMachineLedger({ dataDir: dir2, label: 't2', budgetUsd: 0.02, estimateCall: () => 0.01, cap: { capUsd: null, source: 'env' } });
    const run2 = m2.root.fork();
    const chamar2 = () =>
      gw.chatCompletion({ apiKey: VALID_KEY, modelId: 'x/y', messages: [{ role: 'user', content: 'oi' }], sink: run2 });
    // 0,009 + 0,009 = 0,018; a 3ª reservaria 0,01 → 0,028 > 0,02 (teto da run).
    await chamar2();
    await chamar2();
    const err2 = await chamar2().catch((e: unknown) => e);
    expect(isBudgetSignal(err2)).toBe(true);
    expect(isDailyCapSignal(err2)).toBe(false);
    expect(m2.machine.capHit).toBe(false);
    expect(run2.spentUsd).toBeCloseTo(0.018, 12);
    expect(ledgerTotal(dir2)).toBeCloseTo(run2.spentUsd, 12);
  });
});

describe('GC do estado anti-gasto no disco (ledger por dia, --idempotency-key)', () => {
  it('pruneLedgerDays: apaga dias UTC além da janela (pelo NOME), mantém o de hoje e os recentes', () => {
    const dir = tmp('pb-gc-ledger-');
    const agora = Date.parse('2026-09-27T12:00:00Z');
    const led = path.join(dir, 'ledger');
    mkdirSync(led, { recursive: true });
    for (const n of ['spend-2026-07-01.json', 'spend-2026-07-01.json.lock', 'spend-2026-08-27.json', 'spend-2026-08-28.json', 'spend-2026-09-27.json', 'outro.txt']) {
      writeFileSync(path.join(led, n), '{}');
    }
    expect(pruneLedgerDays(dir, LEDGER_KEEP_DAYS, agora)).toBe(3);
    expect(readdirSync(led).sort()).toEqual(['outro.txt', 'spend-2026-08-28.json', 'spend-2026-09-27.json']);
    expect(pruneLedgerDays(tmp('pb-gc-vazio-'))).toBe(0); // sem diretório: nada, sem lançar
  });

  it('pruneIdempotency: registro vencido sai (mesmo com PID vivo: sem heartbeat há > TTL é PID reciclado); recente fica; temporário órfão sai', () => {
    const dir = tmp('pb-gc-idem-');
    const velho = (Date.now() - IDEMPOTENCY_TTL_MS - 3_600_000) / 1000;
    const morto = claimIdempotency(dir, { key: 'k-velha', configHash: 'h', command: 'compare', runId: 'r1', sessionId: null })!;
    writeFileSync(idempotencyFile(dir, 'k-velha'), JSON.stringify({ ...morto, pid: pidMorto() }));
    utimesSync(idempotencyFile(dir, 'k-velha'), velho, velho);
    claimIdempotency(dir, { key: 'k-viva-velha', configHash: 'h', command: 'compare', runId: 'r2', sessionId: null });
    // Dono = este processo (PID vivo), mas sem heartbeat há > TTL: um dono de
    // verdade renova o mtime a cada 15 s — isto é PID reciclado, sai também.
    utimesSync(idempotencyFile(dir, 'k-viva-velha'), velho, velho);
    claimIdempotency(dir, { key: 'k-nova', configHash: 'h', command: 'compare', runId: 'r3', sessionId: null });
    const tmpOrfao = path.join(dir, 'idempotency', 'x.json.tmp');
    writeFileSync(tmpOrfao, '{');
    utimesSync(tmpOrfao, velho, velho);
    expect(pruneIdempotency(dir)).toBe(3);
    expect(readIdempotency(dir, 'k-velha')).toBeNull();
    expect(readIdempotency(dir, 'k-viva-velha')).toBeNull();
    expect(readIdempotency(dir, 'k-nova')).not.toBeNull();
    expect(existsSync(tmpOrfao)).toBe(false);
  });
});

describe('teto diário: configuração e relógio UTC', () => {
  it('precedência env > arquivo > default (US$ 20); "none" desliga; valor inválido é erro de config', () => {
    const dir = tmp('pb-cap-');
    expect(resolveDailyCap(dir, {})).toEqual({ capUsd: DEFAULT_DAILY_CAP_USD, source: 'default' });
    expect(DEFAULT_DAILY_CAP_USD).toBe(20);
    writeDailyCap(dir, 7.5);
    expect(resolveDailyCap(dir, {})).toEqual({ capUsd: 7.5, source: 'file' });
    writeDailyCap(dir, null);
    expect(resolveDailyCap(dir, {})).toEqual({ capUsd: null, source: 'file' });
    expect(resolveDailyCap(dir, { [DAILY_CAP_ENV]: '3' })).toEqual({ capUsd: 3, source: 'env' });
    expect(resolveDailyCap(dir, { [DAILY_CAP_ENV]: 'none' })).toEqual({ capUsd: null, source: 'env' });
    const err = (() => {
      try {
        resolveDailyCap(dir, { [DAILY_CAP_ENV]: 'muito' });
      } catch (e) {
        return toCliError(e);
      }
      return null;
    })();
    expect(err?.code).toBe(EXIT.CONFIG);
    expect(err?.errorCode).toBe('config.invalid_daily_cap');
  });

  it('o dia é UTC (mesmo relógio do limit_reset diário do OpenRouter)', () => {
    const quaseMeiaNoite = Date.UTC(2026, 8, 27, 23, 59, 59);
    expect(utcDay(quaseMeiaNoite)).toBe('2026-09-27');
    expect(utcDay(quaseMeiaNoite + 2000)).toBe('2026-09-28');
    expect(nextUtcMidnight(quaseMeiaNoite)).toBe('2026-09-28T00:00:00.000Z');
  });
});

describe('doctor — recomendação de limite por key (limit + limit_reset)', () => {
  it('sem limite → recomenda limit + limit_reset=daily (reset 00:00 UTC) com o teto local como sugestão', () => {
    const r = keyLimitAdvice({ limitUsd: null, limitReset: null }, 12);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain('limit_reset=daily');
    expect(r[0]).toContain('UTC');
    expect(r[0]).toContain('US$ 12');
  });
  it('limite sem reset (vitalício) e reset semanal → recomenda o diário; diário → nada a recomendar', () => {
    expect(keyLimitAdvice({ limitUsd: 10, limitReset: null }, 20)[0]).toContain('SEM reset');
    expect(keyLimitAdvice({ limitUsd: 10, limitReset: 'weekly' }, 20)[0]).toContain('limit_reset=daily');
    expect(keyLimitAdvice({ limitUsd: 10, limitReset: 'daily' }, 20)).toEqual([]);
    expect(keyLimitAdvice(null, 20)).toEqual([]);
  });
});

// --- 2. métrica com 2 processos (operários) ------------------------------------

/** Servidor HTTP em 127.0.0.1 a partir de um transporte falso (FetchLike). */
async function servir(fetchFn: FetchLike): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      void fetchFn(`http://127.0.0.1${req.url ?? '/'}`, { method: req.method, headers, body: body || undefined })
        .then(async (r) => {
          res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
          res.end(Buffer.from(await r.arrayBuffer()));
        })
        .catch((e: unknown) => {
          res.writeHead(500);
          res.end(String(e));
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

interface ProcRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function spawnTsx(args: string[], env: NodeJS.ProcessEnv): { done: Promise<ProcRun>; stderrSoFar: () => string } {
  const child = spawn(TSX, args, { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf-8')));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
  const done = new Promise<ProcRun>((resolve) => child.on('close', (status) => resolve({ status, stdout, stderr })));
  return { done, stderrSoFar: () => stderr };
}

async function ateQue(cond: () => boolean, ms = 30_000, what = 'condição'): Promise<void> {
  const fim = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fim) throw new Error(`timeout esperando ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('MÉTRICA — 2 processos concorrentes: custo real ≤ 1,01× a soma dos tetos', { timeout: 120_000 }, () => {
  const COST = 0.009; // cobrado por chamada (usage.cost)
  const EST = 0.01; // reserva por chamada (a estimativa é conservadora, como a do catálogo)
  let srv: { base: string; close: () => Promise<void> };
  let billed = 0;
  let calls = 0;

  beforeAll(async () => {
    srv = await servir(async (url, init) => {
      if (!new URL(url).pathname.endsWith('/chat/completions')) return new Response('{}', { status: 404 });
      // Latência variável: as reservas dos dois processos se intercalam de verdade.
      await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 20)));
      billed += COST;
      calls += 1;
      void init;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 2, cost: COST } }),
        { status: 200 },
      );
    });
  });
  afterAll(async () => {
    await srv.close();
  });
  beforeEach(() => {
    billed = 0;
    calls = 0;
  });

  async function dois(cfg: (i: number) => Record<string, unknown>): Promise<{ spentUsd: number; calls: number; stoppedBy: string[] }[]> {
    // Barreira: os dois sobem (tsx), avisam que estão prontos e só então
    // largam juntos — a disputa pelo teto é simultânea de verdade.
    const barrier = path.join(tmp('pb-barrier-'), 'b');
    const procs = [0, 1].map((i) => spawnTsx([WORKER, JSON.stringify({ ...cfg(i), barrier })], { ...process.env }).done);
    await ateQue(() => existsSync(`${barrier}.ready-p0`) && existsSync(`${barrier}.ready-p1`), 60_000, 'operários prontos');
    writeFileSync(`${barrier}.go`, '');
    const rs = await Promise.all(procs);
    return rs.map((r) => {
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout.trim().split('\n').at(-1) as string) as { spentUsd: number; calls: number; stoppedBy: string[] };
    });
  }

  it('tetos por run (B1 + B2), sem teto diário: fatura ≤ 1,01 × (B1+B2) e o ledger em arquivo fecha com a fatura (≤ 1%)', async () => {
    const dir = tmp('pb-metric-a-');
    const B = 0.1;
    const rs = await dois((i) => ({ dataDir: dir, baseUrl: srv.base, label: `p${i}`, budgetUsd: B, capUsd: null, estUsd: EST, concurrency: 4 }));
    const ctx = JSON.stringify({ billed, B, ledger: ledgerTotal(dir), rs });
    expect(billed, ctx).toBeLessThanOrEqual(1.01 * (2 * B));
    for (const r of rs) expect(r.spentUsd, ctx).toBeGreaterThan(0.5 * B); // cada um gastou o próprio teto (não houve corte cruzado)
    const soma = rs[0].spentUsd + rs[1].spentUsd;
    expect(soma).toBeCloseTo(billed, 9);
    expect(Math.abs(ledgerTotal(dir) - billed) / billed, ctx).toBeLessThanOrEqual(0.01);
  });

  it('teto DIÁRIO D < B1+B2: os dois processos somam no arquivo e a fatura fica ≤ 1,01 × D', async () => {
    const dir = tmp('pb-metric-b-');
    const D = 0.12;
    // Teto por run = 2D em cada processo: sozinho, cada um gastaria até 2D (4D
    // no total). Só o teto DIÁRIO, somado no arquivo, pode segurar em D.
    const rs = await dois((i) => ({ dataDir: dir, baseUrl: srv.base, label: `p${i}`, budgetUsd: 2 * D, capUsd: D, estUsd: EST, concurrency: 4 }));
    const ctx = JSON.stringify({ billed, D, ledger: ledgerTotal(dir), rs });
    expect(billed, ctx).toBeLessThanOrEqual(1.01 * D);
    expect(billed, ctx).toBeGreaterThan(0.5 * D); // o teto foi o limite de fato, não um corte precoce
    // TODOS os laços dos DOIS processos pararam no teto diário da máquina
    // (nenhum no próprio teto): cada processo foi barrado pelo gasto somado.
    for (const r of rs) expect(r.stoppedBy, ctx).toEqual(['daily', 'daily', 'daily', 'daily']);
    expect(Math.abs(ledgerTotal(dir) - billed) / billed, ctx).toBeLessThanOrEqual(0.01);
    expect(calls, ctx).toBe(rs[0].calls + rs[1].calls);
  });

  it('controle negativo (ledger só em memória, o comportamento anterior): o mesmo "teto" D vira ~2×D', async () => {
    const dir = tmp('pb-metric-neg-');
    const D = 0.12;
    const rs = await dois((i) => ({ dataDir: dir, baseUrl: srv.base, label: `p${i}`, budgetUsd: D, capUsd: D, estUsd: EST, concurrency: 4, plain: true }));
    expect(billed, JSON.stringify({ billed, D, rs })).toBeGreaterThan(1.5 * D);
    expect(ledgerTotal(dir)).toBe(0); // e o ledger em arquivo nem soube
  });
});

// --- 2b. mutex entre processos: soma EXATA -------------------------------------------
//
// Regressão da revisão: `withMutexSync` perdia a exclusão sob contenção NORMAL
// (sem dono morto): o lock sumia entre o `open` e o `stat`, a idade de arquivo
// inexistente valia +Infinity (> staleMs) e o processo apagava o lock NOVO de
// outro — o read-modify-write do ledger perdia atualizações e o teto diário
// estourava de forma intermitente (medido: 5864/6000 e 3855/4000 com o código
// antigo). Aqui a soma tem de ser EXATA: nada de tolerância que mascare o bug
// como flakiness do teste de métrica.

const MUTEX_WORKER = path.join(ROOT, 'test', 'fixtures', 'mutexWorker.ts');

describe('MUTEX entre processos — soma EXATA sob contenção (N processos × M operações)', { timeout: 180_000 }, () => {
  async function largar(n: number, cfg: (i: number) => Record<string, unknown>): Promise<void> {
    const barrier = path.join(tmp('pb-mx-barrier-'), 'b');
    const procs = Array.from({ length: n }, (_, i) =>
      spawnTsx([MUTEX_WORKER, JSON.stringify({ ...cfg(i), label: `p${i}`, barrier })], { ...process.env }).done,
    );
    await ateQue(() => Array.from({ length: n }, (_, i) => existsSync(`${barrier}.ready-p${i}`)).every(Boolean), 60_000, 'operários prontos');
    writeFileSync(`${barrier}.go`, '');
    for (const r of await Promise.all(procs)) expect(r.status, r.stderr).toBe(0);
  }

  it('withMutexSync: 4 processos × 2000 incrementos = 8000 exatos', async () => {
    const dir = tmp('pb-mx-');
    const counter = path.join(dir, 'contador.json');
    await largar(4, () => ({ mode: 'mutex', dataDir: dir, counter, ops: 2000 }));
    expect(JSON.parse(readFileSync(counter, 'utf-8'))).toEqual({ n: 8000 });
    expect(existsSync(`${counter}.lock`)).toBe(false);
  });

  it('FileSpendLedger: 4 processos × 800 reserve/settle — calls e gasto EXATOS, nada pendente', async () => {
    const dir = tmp('pb-mx-ledger-');
    await largar(4, () => ({ mode: 'ledger', dataDir: dir, counter: path.join(dir, 'x'), ops: 800, costUsd: 0.001 }));
    const [arquivo] = readdirSync(path.join(dir, 'ledger')).filter((n) => /^spend-.*\.json$/.test(n));
    const d = JSON.parse(readFileSync(path.join(dir, 'ledger', arquivo), 'utf-8')) as {
      entries: Record<string, { calls: number; spentUsd: number; pendingUsd: number }>;
    };
    const es = Object.values(d.entries);
    expect(es).toHaveLength(4);
    for (const e of es) {
      expect(e.calls).toBe(800);
      expect(e.pendingUsd).toBeCloseTo(0, 12);
    }
    expect(es.reduce((s, e) => s + e.calls, 0)).toBe(3200);
    expect(ledgerTotal(dir)).toBeCloseTo(3.2, 9);
  });

  it('lock FRESCO de outro dono nunca é apagado (timeout, arquivo intacto); lock VELHO (dono morto) é quebrado', () => {
    const dir = tmp('pb-mx-unit-');
    const lock = path.join(dir, 'x.lock');
    writeFileSync(lock, 'outro-dono token-fresco');
    let rodou = false;
    expect(() => withMutexSync(lock, () => (rodou = true), { timeoutMs: 150 })).toThrow(/Não consegui o lock/);
    expect(rodou).toBe(false);
    expect(readFileSync(lock, 'utf-8')).toBe('outro-dono token-fresco');

    const velho = (Date.now() - 60_000) / 1000;
    utimesSync(lock, velho, velho);
    expect(withMutexSync(lock, () => 42, { staleMs: 10_000, timeoutMs: 2_000 })).toBe(42);
    // Soltou o PRÓPRIO lock e não deixou sobra (nem a guarda de quebra).
    expect(readdirSync(dir)).toEqual([]);
  });
});

// --- 3. CLI em processo -----------------------------------------------------------

const CENARIOS = [
  { question: 'Qual o prazo de troca?', productContext: 'Trocas em 30 dias com nota.', maxTokens: 300, rubric: 'Citar 30 dias.' },
  { question: 'Como calcular juros compostos?', productContext: 'M = C (1 + i)^n.', maxTokens: 300, rubric: 'Fórmula certa.' },
];

/** Catálogo BARATO (1e-6/token): reservas pequenas, a run cabe folgada em US$ 5. */
const CATALOGO = ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b', 'fake/opt'].map((id) => catalogItem(id, 1e-6, 1e-6));

function rotaDoPipeline(req: FakeRequest, n: number): { text: string; usage: { prompt_tokens: number; completion_tokens: number; cost: number } } {
  const usage = { prompt_tokens: 100, completion_tokens: 20, cost: Number((0.0001 * (n + 1)).toFixed(6)) };
  if (req.model === 'fake/gen') return { text: JSON.stringify({ stages: CENARIOS }), usage };
  if (req.model === 'fake/opt') {
    // Reescritor (treino): variante longa o bastante para o piso de comprimento.
    const tecnica = /tecnica id="([^"]+)"/.exec(req.user)?.[1] ?? 'x';
    return {
      text: `Voce e um atendente cordial e preciso (${tecnica}). Responda sempre com base no contexto do produto, cite prazos e regras exatamente como aparecem e recuse o que estiver fora do escopo.`,
      usage,
    };
  }
  if (req.model === 'fake/ref') return { text: `Gabarito: ${req.user.slice(0, 30)}`, usage };
  if (req.stream) return { text: `Resposta de ${req.model}`, usage };
  if (req.system.includes('DUELO')) return { text: '{"winner":"A","explanation":"A melhor"}', usage };
  return { text: '{"verdict":"resolve","explanation":"confere"}', usage };
}

const PIPE_CONFIG = {
  mode: 'compare',
  theme: 'suporte ao cliente',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  finalists: 2,
  timeoutMs: 60_000,
};

function configFile(dir: string, patch: Record<string, unknown> = {}): string {
  const f = path.join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify({ ...PIPE_CONFIG, ...patch }));
  return f;
}

interface Invocacao {
  exit: number;
  errorCode?: string;
  details?: unknown;
  json?: { ok: boolean; data: Record<string, unknown> };
  /** `formato: 'ndjson'`: uma linha (evento) por item, na ordem do stdout. */
  linhas?: Record<string, unknown>[];
}

async function invocar(
  fake: FakeOpenRouter,
  dir: string,
  argv: string[],
  mode: 'compare' | 'training' = 'compare',
  formato: 'json' | 'ndjson' = 'json',
): Promise<Invocacao> {
  const prev = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
  resetOutputState();
  const out: string[] = [];
  const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    out.push(String(c));
    return true;
  });
  const se = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const cl = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const cw = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const fmt = formato === 'json' ? ['--json'] : ['--output-format', 'ndjson'];
    const exit = await cmdRun(mode, [...argv, '--data-dir', dir, ...fmt]);
    if (formato === 'ndjson') {
      const linhas = out.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      return { exit, linhas };
    }
    return { exit, json: JSON.parse(out.join('')) as Invocacao['json'] };
  } catch (e) {
    const err = toCliError(e);
    return { exit: err.code, errorCode: err.errorCode, details: err.details };
  } finally {
    so.mockRestore();
    se.mockRestore();
    cl.mockRestore();
    cw.mockRestore();
    resetOutputState();
    setDefaultGateway(prev);
  }
}

const TRAIN_CONFIG = {
  mode: 'training',
  theme: 'suporte ao cliente',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  contestantModelId: 'fake/a',
  basePrompt: 'Voce e um atendente de suporte. Responda com base no contexto do produto.',
  techniqueIds: ['persona', 'constraints'],
  promptOptimization: true,
  optimizerModelId: 'fake/opt',
  iterations: 2,
  holdoutRatio: 0,
  finalists: 2,
  timeoutMs: 60_000,
};

describe('CLI em processo — a run inteira passa pelo ledger da máquina', { timeout: 60_000 }, () => {
  afterEach(() => {
    delete process.env[DAILY_CAP_ENV];
  });

  it('compare completo: ledger em arquivo == fatura == record.totalCostUsd (todos os papéis), lock liberado no fim', async () => {
    const dir = tmp('pb-cli-ledger-');
    const fake = fakeOpenRouter({ catalog: CATALOGO, chat: rotaDoPipeline });
    const r = await invocar(fake, dir, ['--config', configFile(dir), '--budget', '5', '--yes', '--key', VALID_KEY]);
    expect(r.exit, JSON.stringify(r)).toBe(EXIT.OK);
    const data = r.json!.data as { runId: string; totalCostUsd: number; dailyCapReached?: boolean };
    expect(fake.billedCalls()).toBeGreaterThan(5);
    expect(data.totalCostUsd).toBeCloseTo(fake.billedUsd(), 10);
    expect(ledgerTotal(dir)).toBeCloseTo(fake.billedUsd(), 10);
    expect(data.dailyCapReached).toBeUndefined();
    expect(readdirSync(path.join(dir, 'locks')).filter((f) => f.endsWith('.lock'))).toEqual([]);
    const snap = readDailySnapshot(dir);
    expect(snap.pendingUsd).toBeCloseTo(0, 12);
    expect(snap.entries[0].label).toContain(data.runId);
  });

  it('train completo: o ledger da SESSÃO é filho da raiz da máquina (parentLedger) — arquivo == fatura == sessão; key reusa a sessão', async () => {
    const dir = tmp('pb-cli-train-');
    const fake = fakeOpenRouter({ catalog: CATALOGO, chat: rotaDoPipeline });
    const f = path.join(dir, 'train.json');
    writeFileSync(
      f,
      JSON.stringify({
        mode: 'training',
        theme: 'suporte ao cliente',
        stages: 2,
        datagenModelId: 'fake/gen',
        judgeModelIds: ['fake/judge'],
        referenceModelId: 'fake/ref',
        referenceJudging: true,
        contestantModelId: 'fake/a',
        basePrompt: 'Voce e um atendente de suporte. Responda com base no contexto do produto.',
        techniqueIds: ['persona', 'constraints'],
        promptOptimization: true,
        optimizerModelId: 'fake/opt',
        iterations: 2,
        holdoutRatio: 0,
        finalists: 2,
        timeoutMs: 60_000,
      }),
    );
    const argv = ['--config', f, '--budget', '5', '--yes', '--force', '--key', VALID_KEY, '--idempotency-key', 'treino-1'];
    const r = await invocar(fake, dir, argv, 'training');
    expect(r.exit, JSON.stringify(r)).toBe(EXIT.OK);
    const data = r.json!.data as { sessionId: string; totalCostUsd: number; idempotency: unknown };
    expect(fake.billedCalls()).toBeGreaterThan(5);
    expect(data.totalCostUsd).toBeCloseTo(fake.billedUsd(), 10);
    expect(ledgerTotal(dir)).toBeCloseTo(fake.billedUsd(), 10);
    expect(data.idempotency).toEqual({ key: 'treino-1', reused: false });
    // O id da sessão só nasce no onSession: o registro da key foi atualizado com ele.
    expect(readIdempotency(dir, 'treino-1')).toMatchObject({ sessionId: data.sessionId, runId: null });
    const chamadas = fake.billedCalls();
    const again = await invocar(fake, dir, argv, 'training');
    expect(again.exit).toBe(EXIT.OK);
    expect(again.json!.data.sessionId).toBe(data.sessionId);
    expect(again.json!.data.idempotency).toEqual({ key: 'treino-1', reused: true, attached: false });
    expect(fake.billedCalls()).toBe(chamadas);
  });

  it('teto DIÁRIO menor que a run: para com exit 7, dailyCapReached e fatura ≤ 1,01 × teto', async () => {
    const dir = tmp('pb-cli-cap-');
    const CAP = 0.003;
    process.env[DAILY_CAP_ENV] = String(CAP);
    const fake = fakeOpenRouter({ catalog: CATALOGO, chat: rotaDoPipeline });
    const r = await invocar(fake, dir, ['--config', configFile(dir), '--budget', '5', '--yes', '--force', '--key', VALID_KEY]);
    expect(r.exit, JSON.stringify(r)).toBe(EXIT.BUDGET);
    const data = r.json!.data as { stoppedReason: string; dailyCapReached: boolean; totalCostUsd: number };
    expect(data.stoppedReason).toBe('budget');
    expect(data.dailyCapReached).toBe(true);
    expect(fake.billedUsd()).toBeLessThanOrEqual(1.01 * CAP);
    expect(ledgerTotal(dir)).toBeCloseTo(fake.billedUsd(), 10);
  });

  it('teto diário já esgotado por OUTRO processo: recusa antes de gastar (control.daily_cap_reached, exit 7), igual no dry-run', async () => {
    const dir = tmp('pb-cli-cap-esgotado-');
    writeDailyCap(dir, 0.5);
    const outro = new FileSpendLedger({ dataDir: dir, cap: { capUsd: 0.5, source: 'file' }, label: 'outro processo' });
    outro.settle(outro.reserve(0.5), 0.5);
    for (const extra of [[], ['--dry-run']]) {
      const fake = fakeOpenRouter({ catalog: CATALOGO, chat: rotaDoPipeline });
      const r = await invocar(fake, dir, ['--config', configFile(dir), '--budget', '5', '--yes', '--key', VALID_KEY, ...extra]);
      expect(r.exit).toBe(EXIT.BUDGET);
      expect(r.errorCode).toBe('control.daily_cap_reached');
      expect(fake.billedCalls()).toBe(0);
    }
  });

  it('--idempotency-key em processo: a 2ª invocação REUSA (reused:true, mesma run, zero chamadas novas); outra config = conflito', async () => {
    const dir = tmp('pb-cli-idem-');
    const fake = fakeOpenRouter({ catalog: CATALOGO, chat: rotaDoPipeline });
    const cfg = configFile(dir);
    const a = await invocar(fake, dir, ['--config', cfg, '--budget', '5', '--yes', '--key', VALID_KEY, '--idempotency-key', 'tarefa-7']);
    expect(a.exit).toBe(EXIT.OK);
    const chamadas = fake.billedCalls();
    const b = await invocar(fake, dir, ['--config', cfg, '--budget', '9', '--yes', '--key', VALID_KEY, '--idempotency-key', 'tarefa-7']);
    expect(b.exit).toBe(EXIT.OK);
    expect(fake.billedCalls()).toBe(chamadas);
    expect(b.json!.data.runId).toBe(a.json!.data.runId);
    expect(b.json!.data.idempotency).toEqual({ key: 'tarefa-7', reused: true, attached: false });
    expect(a.json!.data.idempotency).toEqual({ key: 'tarefa-7', reused: false });
    // Reuso não precisa nem de key nem de --budget (nada vai ser gasto).
    const semKey = await invocar(fake, dir, ['--config', cfg, '--idempotency-key', 'tarefa-7']);
    expect(semKey.exit).toBe(EXIT.OK);
    // dry-run diz o que a real faria: reusar.
    const dry = await invocar(fake, dir, ['--config', cfg, '--idempotency-key', 'tarefa-7', '--dry-run']);
    expect(dry.exit).toBe(EXIT.OK);
    expect(dry.json!.data.idempotency).toMatchObject({ wouldReuse: true, runId: a.json!.data.runId });
    // Mesma key, outra config: erro de uso, nunca reuso de outro experimento.
    const c = await invocar(fake, dir, ['--config', configFile(dir, { stages: 3 }), '--budget', '5', '--yes', '--key', VALID_KEY, '--idempotency-key', 'tarefa-7']);
    expect(c.exit).toBe(EXIT.USAGE);
    expect(c.errorCode).toBe('usage.idempotency_conflict');
    expect(fake.billedCalls()).toBe(chamadas);
  });

  it('dona da key MORTA sem terminar: o reuso devolve run.orphaned (nada roda de novo)', async () => {
    const dir = tmp('pb-cli-orfa-');
    const cfgFile = configFile(dir);
    // O hash é o da config JÁ normalizada pelo schema: descobre pelo dry-run.
    const fake = fakeOpenRouter({ catalog: CATALOGO, chat: rotaDoPipeline });
    const dry = await invocar(fake, dir, ['--config', cfgFile, '--budget', '5', '--yes', '--key', VALID_KEY, '--dry-run']);
    const hash = configHash(dry.json!.data.config as RunConfig);
    const rec = claimIdempotency(dir, { key: 'k-orfa', configHash: hash, command: 'compare', runId: 'run-que-nunca-terminou', sessionId: null });
    const file = idempotencyFile(dir, 'k-orfa');
    writeFileSync(file, JSON.stringify({ ...rec, pid: pidMorto() }));
    const r = await invocar(fake, dir, ['--config', cfgFile, '--budget', '5', '--yes', '--key', VALID_KEY, '--idempotency-key', 'k-orfa']);
    expect(r.exit).toBe(EXIT.ERROR);
    expect(r.errorCode).toBe('run.orphaned');
    expect(fake.billedCalls()).toBe(0);
  });

  it('verbo do CLI ≠ mode do arquivo (`train --config compare.json`): segue o mode EFETIVO — NDJSON com os eventos da run, key com o runId e o reuso devolve a MESMA run', async () => {
    const dir = tmp('pb-cli-verbo-');
    const fake = fakeOpenRouter({ catalog: CATALOGO, chat: rotaDoPipeline });
    const argv = ['--config', configFile(dir), '--budget', '5', '--yes', '--force', '--key', VALID_KEY, '--idempotency-key', 'verbo-1'];
    const nd = await invocar(fake, dir, argv, 'training', 'ndjson');
    expect(nd.exit, JSON.stringify(nd)).toBe(EXIT.OK);
    const tipos = nd.linhas!.map((l) => l.type);
    // Antes: runId null no subscribe → só `start` + `result`, nenhum evento da run.
    for (const t of ['run.started', 'stage.generated', 'stage.judged', 'run.finished']) expect(tipos, tipos.join(',')).toContain(t);
    // Linha `result` do NDJSON: o payload vem espalhado na raiz da linha.
    const resultado = nd.linhas!.at(-1) as { type: string; command: string; runId: string };
    expect(resultado.type).toBe('result');
    expect(resultado.command).toBe('compare'); // o resultado leva o mode que RODOU (o do arquivo)
    const runId = resultado.runId;
    expect(typeof runId).toBe('string');
    expect(nd.linhas!.find((l) => l.type === 'run.started')).toMatchObject({ runId });
    // O registro da key grava o id do que RODOU (run), não o do verbo (sessão).
    expect(readIdempotency(dir, 'verbo-1')).toMatchObject({ runId, sessionId: null, command: 'compare' });
    // O lançamento do ledger da máquina também leva o id da run.
    expect(readDailySnapshot(dir).entries[0].label).toContain(runId);

    // Mesma key, mesmo verbo divergente: REUSA na hora (antes: run.orphaned
    // falso depois de ~2 min, e o agente pagava de novo com key nova).
    const chamadas = fake.billedCalls();
    const again = await invocar(fake, dir, argv, 'training');
    expect(again.exit, JSON.stringify(again)).toBe(EXIT.OK);
    expect(again.json!.data.runId).toBe(runId);
    expect(again.json!.data.idempotency).toEqual({ key: 'verbo-1', reused: true, attached: false });
    // O verbo que o agente digitou não muda o reuso: com o certo, idem.
    const certo = await invocar(fake, dir, argv, 'compare');
    expect(certo.exit).toBe(EXIT.OK);
    expect(certo.json!.data.runId).toBe(runId);
    expect(fake.billedCalls()).toBe(chamadas);
  });

  it('o inverso (`compare --config train.json`): roda a SESSÃO, a key grava o sessionId e o reuso devolve a mesma sessão', async () => {
    const dir = tmp('pb-cli-verbo-inv-');
    const fake = fakeOpenRouter({ catalog: CATALOGO, chat: rotaDoPipeline });
    const f = path.join(dir, 'train.json');
    writeFileSync(f, JSON.stringify(TRAIN_CONFIG));
    const argv = ['--config', f, '--budget', '5', '--yes', '--force', '--key', VALID_KEY, '--idempotency-key', 'verbo-2'];
    const a = await invocar(fake, dir, argv, 'compare');
    expect(a.exit, JSON.stringify(a)).toBe(EXIT.OK);
    const sessionId = a.json!.data.sessionId as string;
    expect(typeof sessionId).toBe('string');
    expect(readIdempotency(dir, 'verbo-2')).toMatchObject({ sessionId, runId: null, command: 'train' });
    const chamadas = fake.billedCalls();
    const b = await invocar(fake, dir, argv, 'compare');
    expect(b.exit, JSON.stringify(b)).toBe(EXIT.OK);
    expect(b.json!.data.sessionId).toBe(sessionId);
    expect(b.json!.data.idempotency).toEqual({ key: 'verbo-2', reused: true, attached: false });
    expect(fake.billedCalls()).toBe(chamadas);
  });
});

// --- 4. CLI com 2 processos reais ---------------------------------------------------

describe('CLI — 2 processos reais (tsx) contra OpenRouter falso em 127.0.0.1', { timeout: 180_000 }, () => {
  let srv: { base: string; close: () => Promise<void> };
  let fake: FakeOpenRouter;
  /** Enquanto `true`, TODA chamada de chat espera: a run 1 fica viva segurando o lock. */
  let segurar = false;
  let keyData: Record<string, unknown> = { label: 'fake', usage: 0, limit: null, limit_remaining: null, limit_reset: null };

  beforeAll(async () => {
    fake = fakeOpenRouter({
      catalog: CATALOGO,
      chat: async (req, n) => {
        await ateQue(() => !segurar, 120_000, 'liberar o chat');
        return rotaDoPipeline(req, n);
      },
    });
    srv = await servir(async (url, init) => {
      const p = new URL(url).pathname;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = headers.authorization ?? headers.Authorization ?? '';
      if (p.endsWith('/key')) {
        if (auth.includes(BAD_KEY)) return new Response('{"error":"invalid"}', { status: 401 });
        return new Response(JSON.stringify({ data: keyData }), { status: 200 });
      }
      return fake.fetch(url, init);
    });
  });
  afterAll(async () => {
    segurar = false;
    await srv.close();
  });

  function envCli(home: string, extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: home, OPENROUTER_BASE_URL: srv.base, CI: '1' };
    delete env.OPENROUTER_API_KEY;
    delete env[DAILY_CAP_ENV];
    // `extraEnv` por ÚLTIMO: um teste pode ligar o teto diário por env.
    return { ...env, ...extraEnv };
  }

  function cli(home: string, args: string[], extraEnv: Record<string, string> = {}) {
    return spawnTsx([ENTRY, ...args], envCli(home, extraEnv));
  }

  /**
   * Servidor MCP REAL (`prompt-builder mcp`, stdio): manda as requisições
   * JSON-RPC, fecha o stdin e devolve as respostas (uma por `id`).
   */
  async function mcp(home: string, calls: { name: string; arguments: Record<string, unknown> }[]): Promise<{
    status: number | null;
    stderr: string;
    respostas: { id: number; result?: { content: { text: string }[]; isError?: boolean } }[];
  }> {
    const child = spawn(TSX, [ENTRY, 'mcp', '--key', VALID_KEY], { env: envCli(home) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf-8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
    const done = new Promise<number | null>((resolve) => child.on('close', resolve));
    const linhas = [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      ...calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: c })),
    ];
    child.stdin.end(linhas.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const status = await done;
    const respostas = stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id: number; result?: { content: { text: string }[]; isError?: boolean } })
      .filter((r) => r.id !== 0);
    return { status, stderr, respostas };
  }

  function envelope(r: ProcRun): { ok: boolean; data?: Record<string, unknown>; error?: { code: string; kind: string; details: Record<string, unknown> } } {
    expect(r.stdout.length, `stdout vazio; stderr: ${r.stderr}`).toBeGreaterThan(0);
    return JSON.parse(r.stdout) as ReturnType<typeof envelope>;
  }

  function locks(home: string): string[] {
    const d = path.join(home, 'locks');
    return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.lock')) : [];
  }

  it('2º processo com a MESMA config → run.locked (exit 2) sem tocar a rede; o 1º termina normal e solta o lock', async () => {
    const home = tmp('pb-2proc-lock-');
    const cfg = configFile(home);
    const args = ['compare', '--config', cfg, '--budget', '5', '--yes', '--key', VALID_KEY, '--json'];
    segurar = true;
    const chatsAntes = fake.chatRequests().length;
    const p1 = cli(home, args);
    await ateQue(() => locks(home).length === 1 && fake.chatRequests().length > chatsAntes, 60_000, 'run 1 com lock e em voo');
    const dono = JSON.parse(readFileSync(path.join(home, 'locks', locks(home)[0]), 'utf-8')) as { pid: number; runId: string };

    const reqsAntes = fake.requests.length;
    const p2 = await cli(home, args).done;
    expect(p2.status, p2.stderr).toBe(EXIT.USAGE);
    const env2 = envelope(p2);
    expect(env2.ok).toBe(false);
    expect(env2.error!.code).toBe('run.locked');
    expect(env2.error!.kind).toBe('usage');
    expect(env2.error!.details.holder).toMatchObject({ pid: dono.pid, runId: dono.runId, command: 'compare' });
    // Recusou no passo 0 do pré-voo: nem catálogo, nem /key, nem chat.
    expect(fake.requests.length).toBe(reqsAntes);

    // O dry-run com a mesma config reporta a MESMA recusa (paridade).
    const dry = await cli(home, [...args, '--dry-run']).done;
    expect(dry.status).toBe(EXIT.USAGE);
    expect(envelope(dry).error!.code).toBe('run.locked');

    segurar = false;
    const r1 = await p1.done;
    expect(r1.status, r1.stderr).toBe(EXIT.OK);
    expect(envelope(r1).data!.runId).toBe(dono.runId);
    expect(locks(home)).toEqual([]);
  });

  it('--idempotency-key repetida: o 2º processo se ANEXA à run em voo e devolve a MESMA run sem gastar; o 3º reusa na hora', async () => {
    const home = tmp('pb-2proc-idem-');
    const cfg = configFile(home);
    const args = ['compare', '--config', cfg, '--budget', '5', '--yes', '--key', VALID_KEY, '--json', '--idempotency-key', 'job-42'];
    segurar = true;
    const chatsAntes = fake.billedCalls();
    const p1 = cli(home, args);
    await ateQue(() => locks(home).length === 1, 60_000, 'run 1 com lock');

    const p2 = cli(home, args);
    await ateQue(() => p2.stderrSoFar().includes('anexando'), 60_000, 'processo 2 anexado');
    segurar = false;

    const [r1, r2] = await Promise.all([p1.done, p2.done]);
    expect(r1.status, r1.stderr).toBe(EXIT.OK);
    expect(r2.status, r2.stderr).toBe(EXIT.OK);
    const e1 = envelope(r1);
    const e2 = envelope(r2);
    expect(e2.data!.runId).toBe(e1.data!.runId);
    expect(e2.data!.idempotency).toEqual({ key: 'job-42', reused: true, attached: true });
    expect(e1.data!.idempotency).toEqual({ key: 'job-42', reused: false });
    // Só UMA run foi paga: as chamadas cobradas são exatamente as da run 1.
    const chamadasDaRun = fake.billedCalls() - chatsAntes;
    expect(chamadasDaRun).toBeGreaterThan(5);
    const rec = JSON.parse(readFileSync(path.join(home, 'runs', `${e1.data!.runId as string}.json`), 'utf-8')) as {
      costByRole: Record<string, { calls: number }>;
    };
    expect(Object.values(rec.costByRole).reduce((s, x) => s + x.calls, 0)).toBe(chamadasDaRun);

    // 3º, depois do fim: reusa na hora, zero chamadas.
    const r3 = await cli(home, args).done;
    expect(r3.status, r3.stderr).toBe(EXIT.OK);
    expect(envelope(r3).data!.idempotency).toEqual({ key: 'job-42', reused: true, attached: false });
    expect(fake.billedCalls() - chatsAntes).toBe(chamadasDaRun);

    // Mesma key com outra config: conflito de uso.
    const r4 = await cli(home, ['compare', '--config', configFile(home, { stages: 3 }), '--budget', '5', '--yes', '--key', VALID_KEY, '--json', '--idempotency-key', 'job-42']).done;
    expect(r4.status).toBe(EXIT.USAGE);
    expect(envelope(r4).error!.code).toBe('usage.idempotency_conflict');
  });

  it('doctor sem key válida sai 4 (ausente: auth.key_missing; recusada: auth.key_invalid) com o relatório em details', async () => {
    const home = tmp('pb-doctor-');
    const semKey = await cli(home, ['doctor', '--json']).done;
    expect(semKey.status, semKey.stderr).toBe(EXIT.AUTH);
    const e1 = envelope(semKey);
    expect(e1.error!.code).toBe('auth.key_missing');
    expect(e1.error!.kind).toBe('auth');
    expect((e1.error!.details.checks as Record<string, unknown>).dailyCap).toMatchObject({ capUsd: 20, source: 'default' });

    const recusada = await cli(home, ['doctor', '--json', '--key', BAD_KEY]).done;
    expect(recusada.status).toBe(EXIT.AUTH);
    expect(envelope(recusada).error!.code).toBe('auth.key_invalid');
  });

  it('doctor com key válida SEM limite: exit 0 e recomenda limit + limit_reset=daily; com limite diário, nada a recomendar', async () => {
    const home = tmp('pb-doctor-ok-');
    keyData = { label: 'fake', usage: 1, usage_daily: 0.5, limit: null, limit_remaining: null, limit_reset: null };
    const r = await cli(home, ['doctor', '--json', '--key', VALID_KEY]).done;
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const d = envelope(r).data!;
    expect(d.key).toBe('ok');
    expect((d.recommendations as string[])[0]).toContain('limit_reset=daily');
    expect(d.keyLimit).toMatchObject({ limitUsd: null, limitReset: null, usageDailyUsd: 0.5 });

    keyData = { label: 'fake', usage: 1, limit: 10, limit_remaining: 9, limit_reset: 'daily' };
    const r2 = await cli(home, ['doctor', '--json', '--key', VALID_KEY]).done;
    expect(r2.status, r2.stderr).toBe(EXIT.OK);
    expect(envelope(r2).data!.recommendations).toEqual([]);
    expect(envelope(r2).data!.keyLimit).toMatchObject({ limitUsd: 10, limitReset: 'daily' });
  });

  it('doctor com a rede fora: exit 8 (rede), não 4 — a key pode estar boa', async () => {
    const home = tmp('pb-doctor-net-');
    const r = await cli(home, ['doctor', '--json', '--key', VALID_KEY], { OPENROUTER_BASE_URL: 'http://127.0.0.1:9/api/v1' }).done;
    expect(r.status, r.stderr).toBe(EXIT.NETWORK);
    expect(envelope(r).error!.code).toBe('network.key_check_failed');
  });

  it('limits set/show: grava o teto no data-dir e mostra o gasto do dia', async () => {
    const home = tmp('pb-limits-');
    const set = await cli(home, ['limits', 'set', '--daily', '7', '--json']).done;
    expect(set.status, set.stderr).toBe(EXIT.OK);
    expect(envelope(set).data!.dailyCapUsd).toBe(7);
    const show = await cli(home, ['limits', 'show', '--json']).done;
    expect(show.status, show.stderr).toBe(EXIT.OK);
    const d = envelope(show).data!;
    expect(d.dailyCap).toEqual({ capUsd: 7, source: 'file' });
    expect((d.today as { day: string }).day).toBe(utcDay());
    const bad = await cli(home, ['limits', 'set', '--daily', 'muito', '--json']).done;
    expect(bad.status).toBe(EXIT.USAGE);
    expect(envelope(bad).error!.code).toBe('usage.invalid_daily_cap');
  });

  it('MCP `run_benchmark` passa pelas MESMAS camadas: o gasto entra no ledger do dia (== fatura) e o teto diário esgotado barra a tool antes de gastar', async () => {
    const home = tmp('pb-mcp-');
    const antes = fake.billedUsd();
    const r = await mcp(home, [{ name: 'run_benchmark', arguments: { config: PIPE_CONFIG, budgetUsd: 5 } }]);
    expect(r.status, r.stderr).toBe(0);
    const [resp] = r.respostas;
    expect(resp.result!.isError, resp.result!.content[0].text).toBeFalsy();
    const out = JSON.parse(resp.result!.content[0].text) as { runId: string; totalCostUsd: number; dailyCapReached?: boolean };
    const gasto = fake.billedUsd() - antes;
    expect(gasto).toBeGreaterThan(0);
    expect(out.totalCostUsd).toBeCloseTo(gasto, 10);
    // Antes: runToCompletion sem parentLedger — o ledger da máquina nem soube.
    expect(ledgerTotal(home)).toBeCloseTo(gasto, 10);
    const snap = readDailySnapshot(home);
    expect(snap.entries.map((e) => e.label).join(',')).toContain('mcp run_benchmark');
    expect(snap.pendingUsd).toBeCloseTo(0, 12);
    expect(out.dailyCapReached).toBeUndefined();
    expect(locks(home)).toEqual([]); // o lock da config foi solto no fim

    // Teto diário já comido (pelo gasto acima + outro processo): a tool recusa
    // ANTES de gastar, com a mensagem do teto — o agente via MCP não passa.
    writeDailyCap(home, gasto + 0.01);
    const outro = new FileSpendLedger({ dataDir: home, cap: { capUsd: gasto + 0.01, source: 'file' }, label: 'outro processo' });
    outro.settle(outro.reserve(0.01), 0.01);
    const chamadas = fake.billedCalls();
    const barrado = await mcp(home, [{ name: 'run_benchmark', arguments: { config: PIPE_CONFIG, budgetUsd: 5 } }]);
    expect(barrado.status, barrado.stderr).toBe(0);
    expect(barrado.respostas[0].result!.isError).toBe(true);
    expect(barrado.respostas[0].result!.content[0].text).toMatch(/teto diário/i);
    expect(fake.billedCalls()).toBe(chamadas);
  });

  it('doctor com teto diário INVÁLIDO (env ou limits.json): exit 3 config.invalid_daily_cap — o mesmo com que toda run sai —, com o relatório em details', async () => {
    keyData = { label: 'fake', usage: 0, limit: 10, limit_remaining: 10, limit_reset: 'daily' };
    const home = tmp('pb-doctor-cap-');
    const r = await cli(home, ['doctor', '--json', '--key', VALID_KEY], { [DAILY_CAP_ENV]: 'abc' }).done;
    expect(r.status, r.stderr).toBe(EXIT.CONFIG);
    const e = envelope(r);
    expect(e.error!.code).toBe('config.invalid_daily_cap');
    expect((e.error!.details.checks as Record<string, unknown>).dailyCap).toMatch(/^inválido/);
    // A run com o mesmo teto sai com o MESMO código (paridade doctor × run).
    const run = await cli(home, ['compare', '--config', configFile(home), '--budget', '5', '--yes', '--key', VALID_KEY, '--json'], {
      [DAILY_CAP_ENV]: 'abc',
    }).done;
    expect(run.status).toBe(EXIT.CONFIG);
    expect(envelope(run).error!.code).toBe('config.invalid_daily_cap');

    const home2 = tmp('pb-doctor-cap-file-');
    writeFileSync(path.join(home2, 'limits.json'), '{"dailyCapUsd": "muito"}');
    const r2 = await cli(home2, ['doctor', '--json', '--key', VALID_KEY]).done;
    expect(r2.status, r2.stderr).toBe(EXIT.CONFIG);
    expect(envelope(r2).error!.code).toBe('config.invalid_daily_cap');
  });
});
