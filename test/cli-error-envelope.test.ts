// Contrato do ENVELOPE ÚNICO DE ERRO do CLI (IMPL-028, R-12:REC-1).
//
// O furo medido: o formato de saída só era conhecido DEPOIS do parse, então um
// erro de parse (flag desconhecida) sob `--json` saía como texto no stderr e o
// stdout ficava com 0 bytes. E havia duas formas de erro divergentes (JSON com
// `error:{code,message,details}`, NDJSON com `error:<string>, code`).
//
// Aqui provamos, em três camadas:
//   1. PROCESSO REAL (tsx): flag inválida sob --json/ndjson → envelope no STDOUT,
//      exit != 0; NDJSON termina em {type:'result', ok:false}; os objetos `error`
//      de JSON e NDJSON são IDÊNTICOS (mesmas chaves, mesmo conteúdo).
//   2. UNIDADE: exit code → kind, normalização de qualquer throw, sniff do
//      formato ≡ resolveFormat, estado terminal do stream.
//   3. VARREDURA DE CÓDIGO: nenhum caminho de erro em src/cli renderiza por fora
//      do envelope (process.exit, .fail, stderr "Erro", result(false…)).
//
// Nenhum teste toca a rede: o gateway aponta para uma porta local fechada
// (OPENROUTER_BASE_URL), o data-dir é temporário e não há OPENROUTER_API_KEY.
// Desde o IMPL-029 o pré-voo confere a config contra o catálogo PÚBLICO antes
// de exigir a key, então o caso "key ausente" semeia um catálogo em cache.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CliError,
  DEFAULT_HINT,
  ERROR_FIELDS,
  EXIT,
  EXIT_KIND,
  Output,
  errorEnvelope,
  isCliError,
  kindForExit,
  resetOutputState,
  toCliError,
  type ErrorKind,
} from '../src/cli/output.js';
import {
  closestMatch,
  commandLabel,
  parse,
  resolveFormat,
  sniffOutputFormat,
} from '../src/cli/context.js';
import { BudgetExceeded, RunCancelled } from '../src/budget.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const ENTRY = path.join(ROOT, 'src', 'cli', 'index.ts');

// --- 1. processo real ---------------------------------------------------------

let home = '';

/** Porta local fechada: qualquer ida à rede falharia rápido (exit 8), nunca sai da máquina. */
const DEAD_BASE = 'http://127.0.0.1:9/api/v1';

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'pb-envelope-'));
  writeFileSync(path.join(home, 'quebrado.json'), '{ "mode": "compare", ');
  writeFileSync(path.join(home, 'vazio.json'), '{}');
  // Catálogo público FRESCO em cache (formato de src/modelsCache.ts), com os
  // ids usados no caso "key ausente": o pré-voo aprova a config sem rede e só
  // então exige a key.
  const modelo = (id: string) => ({ id, name: id, pricing: { prompt: 1e-6, completion: 2e-6 } });
  mkdirSync(path.join(home, 'cache'), { recursive: true });
  writeFileSync(
    path.join(home, 'cache', 'models-public.json'),
    JSON.stringify({ v: 1, fetchedAt: Date.now(), base: DEAD_BASE, count: 3, data: ['a/x', 'b/y', 'a/j'].map(modelo) }),
  );
});

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): CliRun {
  const env: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: home, OPENROUTER_BASE_URL: DEAD_BASE };
  // Sem key em lugar nenhum: nenhum caso pode chegar à rede.
  delete env.OPENROUTER_API_KEY;
  const r = spawnSync(TSX, [ENTRY, ...args], { env, encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

interface Envelope {
  ok: false;
  command: string;
  error: { code: string; kind: ErrorKind; message: string; hint: string | null; details: unknown };
}

function parseJsonEnvelope(r: CliRun): Envelope {
  expect(r.stdout.length, `stdout vazio; stderr: ${r.stderr}`).toBeGreaterThan(0);
  return JSON.parse(r.stdout) as Envelope;
}

function ndjsonLines(r: CliRun): Record<string, unknown>[] {
  expect(r.stdout.length, `stdout vazio; stderr: ${r.stderr}`).toBeGreaterThan(0);
  // Toda linha do stdout é JSON — nada de texto misturado no payload.
  return r.stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('envelope de erro — processo real (tsx)', { timeout: 90_000 }, () => {
  it('flag inválida sob --json imprime {ok:false, error:{...}} no STDOUT e sai != 0', () => {
    const r = cli(['models', 'list', '--json', '--serch', 'gpt']);
    expect(r.status).toBe(EXIT.USAGE);
    const env = parseJsonEnvelope(r);
    expect(env.ok).toBe(false);
    expect(env.command).toBe('models.list');
    expect(Object.keys(env.error)).toEqual([...ERROR_FIELDS]);
    expect(env.error.code).toBe('usage.unknown_flag');
    expect(env.error.kind).toBe('usage');
    expect(env.error.hint).toContain('--search');
    expect(env.error.details).toMatchObject({ flag: '--serch', suggestion: '--search' });
    // Narração não vaza para o payload e o payload não vaza para a narração.
    expect(r.stderr).not.toContain('"ok"');
  });

  it('NDJSON de erro termina em {type:"result", ok:false} com o MESMO objeto error do JSON', () => {
    const argv = ['models', 'list', '--serch', 'gpt'];
    const json = parseJsonEnvelope(cli([...argv, '--json']));
    const r = cli([...argv, '--output-format', 'ndjson']);
    expect(r.status).toBe(EXIT.USAGE);
    const linhas = ndjsonLines(r);
    const ultima = linhas.at(-1)!;
    expect(ultima.type).toBe('result');
    expect(ultima.ok).toBe(false);
    expect(ultima.command).toBe(json.command);
    const erroNd = ultima.error as Record<string, unknown>;
    // Asserção de igualdade de chaves (critério de aceite) + conteúdo idêntico.
    expect(Object.keys(erroNd)).toEqual(Object.keys(json.error));
    expect(erroNd).toEqual(json.error);
    // Nada de `code`/`error` soltos no topo da linha (a forma antiga do NDJSON).
    expect(Object.keys(ultima).sort()).toEqual(['command', 'error', 'ok', 'seq', 'ts', 'type']);
  });

  it('`--output-format=ndjson` (forma com =) também é detectado antes do dispatch', () => {
    const r = cli(['config', 'validate', path.join(home, 'quebrado.json'), '--output-format=ndjson']);
    expect(r.status).toBe(EXIT.CONFIG);
    const ultima = ndjsonLines(r).at(-1)!;
    expect(ultima).toMatchObject({ type: 'result', ok: false, command: 'config.validate' });
    expect(ultima.error).toMatchObject({ code: 'config.invalid_json', kind: 'config' });
  });

  it('sem --json o erro continua texto no STDERR (Erro:/Dica:) e o stdout fica limpo', () => {
    const r = cli(['models', 'list', '--serch', 'gpt']);
    expect(r.status).toBe(EXIT.USAGE);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Erro: Flag desconhecida: --serch.');
    expect(r.stderr).toContain('Dica: Você quis dizer --search?');
  });

  it('key ausente → kind auth, exit 4, dica acionável (antes de qualquer rede)', () => {
    // Config VÁLIDA contra o catálogo em cache: a key é a última checagem do
    // pré-voo (IMPL-029) e, com o gateway numa porta fechada, chegar ao exit 4
    // prova que nada foi à rede.
    const r = cli(['compare', '--theme', 't', '--judge', 'a/j', '--models', 'a/x,b/y', '--budget', '1', '--json']);
    expect(r.status).toBe(EXIT.AUTH);
    const env = parseJsonEnvelope(r);
    expect(env.command).toBe('compare');
    expect(env.error).toMatchObject({ code: 'auth.key_missing', kind: 'auth' });
    expect(env.error.hint).toContain('key set --stdin');
    expect(env.error.hint).toContain('OPENROUTER_API_KEY');
  });

  it('config inválida → kind config (JSON quebrado e schema recusado), arquivo ausente → usage', () => {
    const quebrado = parseJsonEnvelope(cli(['config', 'validate', path.join(home, 'quebrado.json'), '--json']));
    expect(quebrado.error).toMatchObject({ code: 'config.invalid_json', kind: 'config' });
    expect(quebrado.error.hint).toContain('config validate');

    const vazio = cli(['config', 'validate', path.join(home, 'vazio.json'), '--json']);
    expect(vazio.status).toBe(EXIT.CONFIG);
    expect(parseJsonEnvelope(vazio).error.kind).toBe('config');

    const ausente = cli(['config', 'validate', path.join(home, 'nao-existe.json'), '--json']);
    expect(ausente.status).toBe(EXIT.USAGE);
    expect(parseJsonEnvelope(ausente).error).toMatchObject({ code: 'usage.file_unreadable', kind: 'usage' });
  });

  it('comando desconhecido e --output-format inválido também saem no envelope', () => {
    const cmd = cli(['comapre', '--json']);
    expect(cmd.status).toBe(EXIT.USAGE);
    const envCmd = parseJsonEnvelope(cmd);
    expect(envCmd.error).toMatchObject({ code: 'usage.unknown_command', kind: 'usage' });
    expect(envCmd.error.hint).toContain('prompt-builder compare');

    // Quem pediu formato de máquina recebe o erro estruturado mesmo tendo
    // errado o NOME do formato.
    const fmt = cli(['config', 'validate', 'x.json', '--output-format', 'xml']);
    expect(fmt.status).toBe(EXIT.USAGE);
    expect(parseJsonEnvelope(fmt).error).toMatchObject({ code: 'usage.invalid_output_format', kind: 'usage' });
  });

  it('flag sem valor → usage.invalid_flag_value com a forma correta na dica', () => {
    const r = cli(['config', 'example', '--json', '--mode']);
    expect(r.status).toBe(EXIT.USAGE);
    const env = parseJsonEnvelope(r);
    expect(env.error).toMatchObject({ code: 'usage.invalid_flag_value', kind: 'usage' });
    expect(env.error.hint).toContain('--mode <valor>');
  });
});

// --- 2. unidade ---------------------------------------------------------------

describe('exit code → kind', () => {
  it('a tabela EXIT tem INCONCLUSIVE=6 e WAIT_TIMEOUT=9 (CONVENTIONS §6)', () => {
    expect(EXIT.INCONCLUSIVE).toBe(6);
    expect(EXIT.WAIT_TIMEOUT).toBe(9);
  });

  it('todo exit code != 0 da tabela tem kind; fora dela é internal', () => {
    const esperado: Record<number, ErrorKind> = {
      [EXIT.ERROR]: 'internal',
      [EXIT.USAGE]: 'usage',
      [EXIT.CONFIG]: 'config',
      [EXIT.AUTH]: 'auth',
      [EXIT.NO_CREDIT]: 'credit',
      [EXIT.INCONCLUSIVE]: 'inconclusive',
      [EXIT.BUDGET]: 'control',
      [EXIT.NETWORK]: 'network',
      [EXIT.WAIT_TIMEOUT]: 'timeout',
      [EXIT.SIGINT]: 'control',
    };
    for (const code of Object.values(EXIT)) {
      if (code === EXIT.OK) continue;
      expect(EXIT_KIND[code], `exit ${code} sem kind`).toBeDefined();
      expect(kindForExit(code)).toBe(esperado[code]);
    }
    expect(kindForExit(42)).toBe('internal');
  });

  it('todo kind tem dica padrão não vazia (nenhum erro sai sem próximo passo)', () => {
    for (const kind of new Set(Object.values(EXIT_KIND))) {
      expect(DEFAULT_HINT[kind].length).toBeGreaterThan(10);
    }
  });
});

describe('toCliError — qualquer throw vira envelope', () => {
  it('CliError passa intacto; code/hint próprios vencem os padrões', () => {
    const e = new CliError('x', EXIT.CONFIG, { a: 1 }, { code: 'run.locked', hint: 'espere' });
    expect(toCliError(e)).toBe(e);
    expect(errorEnvelope('c', e).error).toEqual({
      code: 'run.locked',
      kind: 'config',
      message: 'x',
      hint: 'espere',
      details: { a: 1 },
    });
  });

  it('reconhece CliError por FORMA (duas instâncias do módulo), não por instanceof', () => {
    const alheio = { name: 'CliError', message: 'de outra instância', code: EXIT.AUTH, errorCode: 'auth.x', hint: 'h' };
    expect(isCliError(alheio)).toBe(true);
    expect(toCliError(alheio)).toBe(alheio);
    expect(isCliError(new Error('x'))).toBe(false);
  });

  it('sinais de controle: orçamento → 7 control, cancelamento → 130 control', () => {
    const b = toCliError(new BudgetExceeded(1.5, 1, 'judge'));
    expect(b.code).toBe(EXIT.BUDGET);
    expect(b.kind).toBe('control');
    expect(b.errorCode).toBe('control.budget_exceeded');
    expect(b.details).toEqual({ spentUsd: 1.5, budgetUsd: 1, role: 'judge' });
    const c = toCliError(new RunCancelled('SIGINT'));
    expect(c.code).toBe(EXIT.SIGINT);
    expect(c.kind).toBe('control');
    // Abort cru (fetch/AbortSignal) também é interrupção, não bug.
    const ab = toCliError(new DOMException('This operation was aborted', 'AbortError'));
    expect(ab).toMatchObject({ code: EXIT.SIGINT, errorCode: 'control.cancelled' });
  });

  it('erro de arquivo → usage; erro de socket → network; o resto → internal', () => {
    const fsErr = Object.assign(new Error("ENOENT: no such file, open 'a.json'"), {
      code: 'ENOENT',
      path: 'a.json',
      syscall: 'open',
    });
    expect(toCliError(fsErr)).toMatchObject({ code: EXIT.USAGE, errorCode: 'usage.file_unreadable' });

    const net = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    expect(toCliError(net)).toMatchObject({ code: EXIT.NETWORK, errorCode: 'network.unreachable' });

    const bug = toCliError(new RangeError('boom'));
    expect(bug).toMatchObject({ code: EXIT.ERROR, errorCode: 'internal.unexpected', message: 'boom' });
    expect(bug.kind).toBe('internal');
    expect(toCliError('string crua').message).toBe('string crua');
  });

  it('details que não serializa (ciclo) não derruba o próprio erro', () => {
    const ciclo: Record<string, unknown> = {};
    ciclo.eu = ciclo;
    const env = errorEnvelope('c', new CliError('x', EXIT.USAGE, ciclo));
    expect(() => JSON.stringify(env)).not.toThrow();
    expect(env.error.details).toMatchObject({ unserializable: true });
  });
});

describe('Output — um só ponto de renderização, estado terminal', () => {
  let escrito: string[] = [];

  function capturar(): void {
    escrito = [];
    resetOutputState();
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      escrito.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  }

  afterEach(() => {
    vi.restoreAllMocks();
    resetOutputState();
  });

  const erro = (): CliError =>
    new CliError('saldo baixo', EXIT.NO_CREDIT, { remainingUsd: 0.1 }, { code: 'credit.insufficient' });

  it('JSON e NDJSON produzem o MESMO objeto error, na ordem canônica de campos', () => {
    capturar();
    new Output({ format: 'json' }).fail('train', erro());
    const json = JSON.parse(escrito.join('')) as Envelope;

    capturar();
    new Output({ format: 'ndjson' }).fail('train', erro());
    const nd = JSON.parse(escrito.join('').trim()) as Record<string, unknown>;

    expect(Object.keys(json)).toEqual(['ok', 'command', 'error']);
    expect(Object.keys(json.error)).toEqual([...ERROR_FIELDS]);
    expect(nd).toMatchObject({ type: 'result', ok: false, command: 'train' });
    expect(nd.error).toEqual(json.error);
    expect(json.error.kind).toBe('credit');
    expect(json.error.hint).toBe(DEFAULT_HINT.credit);
  });

  it('erro no MEIO de um stream NDJSON: a última linha é o result ok:false; nada depois', () => {
    capturar();
    const cmdOut = new Output({ format: 'ndjson' });
    cmdOut.event('start', { command: 'train', sessionId: 's1' });
    cmdOut.event('budget', { spentUsd: 0.1 });
    // O main usa OUTRA instância de Output (criada antes do dispatch).
    const mainOut = new Output({ format: 'ndjson' });
    mainOut.fail('train', new BudgetExceeded(1, 1));
    cmdOut.event('budget', { spentUsd: 0.2 }); // depois do terminal: descartado
    cmdOut.result(true, 'train', {}); // idem
    const linhas = escrito.join('').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(linhas.map((l) => l.type)).toEqual(['start', 'budget', 'result']);
    expect(linhas.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(linhas[2]).toMatchObject({ ok: false, error: { kind: 'control', code: 'control.budget_exceeded' } });
  });

  it('--json continua UM objeto: erro depois de um result de sucesso vai para o stderr', () => {
    capturar();
    const out = new Output({ format: 'json' });
    out.result(true, 'runs.show', { id: 'r1' });
    out.fail('runs.show', erro());
    expect(() => JSON.parse(escrito.join(''))).not.toThrow();
    expect(JSON.parse(escrito.join(''))).toMatchObject({ ok: true });
  });

  it('em texto nada vai para o stdout', () => {
    capturar();
    const cli = new Output({ format: 'text' }).fail('x', erro());
    expect(escrito).toEqual([]);
    expect(cli.code).toBe(EXIT.NO_CREDIT);
  });
});

describe('formato resolvido ANTES do dispatch', () => {
  // Para todo argv que o parse aceita, a varredura crua tem de concordar com o
  // resolveFormat — senão o erro sairia num formato e o sucesso noutro.
  const casos: string[][] = [
    [],
    ['--json'],
    ['--output-format', 'ndjson'],
    ['--output-format=json'],
    ['--json', '--output-format', 'text'],
    ['--output-format', 'text', '--json'],
    ['--output-format', 'ndjson', '--output-format', 'json'],
    ['pos', '--', '--json'],
    ['--quiet', '--output-format=ndjson', 'pos'],
  ];
  for (const argv of casos) {
    it(`sniff ≡ resolveFormat para [${argv.join(' ')}]`, () => {
      expect(sniffOutputFormat(argv)).toBe(resolveFormat(parse(argv, {}).values));
    });
  }

  it('formato inválido/ausente em --output-format → json (o erro sai estruturado)', () => {
    expect(sniffOutputFormat(['--output-format', 'xml'])).toBe('json');
    expect(sniffOutputFormat(['--output-format'])).toBe('json');
    expect(sniffOutputFormat(['--output-format', '--json'])).toBe('json');
    expect(() => resolveFormat(parse(['--output-format', 'xml'], {}).values)).toThrow(/output-format/);
  });

  it('rótulo do comando sai do argv cru; id no lugar do subcomando não vira rótulo', () => {
    expect(commandLabel(['runs', 'show', 'abc'])).toBe('runs.show');
    expect(commandLabel(['compare', '--json'])).toBe('compare');
    expect(commandLabel(['runs', '3f2a9c1e-77b0'])).toBe('runs');
    expect(commandLabel(['--json'])).toBe('?');
  });

  /** O CliError lançado por `fn` — falha o teste se nada for lançado. */
  function lancado(fn: () => unknown): CliError {
    try {
      fn();
    } catch (e) {
      expect(isCliError(e)).toBe(true);
      return e as CliError;
    }
    throw new Error('esperava um CliError');
  }

  it('parse devolve códigos estáveis e dica com a forma certa', () => {
    const opts = { search: { type: 'string' }, out: { type: 'string', short: 'o' } } as const;
    const unknown = lancado(() => parse(['--serch', 'x'], opts));
    expect(unknown.code).toBe(EXIT.USAGE);
    expect(unknown.errorCode).toBe('usage.unknown_flag');
    expect(unknown.hint).toContain('--search');

    const semValor = lancado(() => parse(['-o'], opts));
    expect(semValor.errorCode).toBe('usage.invalid_flag_value');
    expect(semValor.hint).toContain('--out <valor>');

    const comValor = lancado(() => parse(['--json=1'], opts));
    expect(comValor.errorCode).toBe('usage.invalid_flag_value');
    expect(comValor.hint).toContain('liga/desliga');

    expect(closestMatch('comapre', ['compare', 'config'])).toBe('compare');
    expect(closestMatch('xyzzy', ['compare', 'config'])).toBeUndefined();
  });
});

// --- 3. varredura de código ---------------------------------------------------

describe('varredura: 100% dos caminhos de erro de src/cli passam pelo envelope', () => {
  const CLI_DIR = path.join(ROOT, 'src', 'cli');

  function arquivos(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? arquivos(p) : p.endsWith('.ts') ? [p] : [];
    });
  }

  /** Código sem comentários (as regras valem para código, não para a prosa). */
  function codigo(file: string): string {
    return readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  // O servidor MCP (mcp.ts) fala JSON-RPC no stdout: erro dele é `error` do
  // protocolo, não o envelope do CLI (e o arquivo é do cluster `jobs`).
  const fontes = arquivos(CLI_DIR)
    .filter((f) => !f.endsWith(path.join('commands', 'mcp.ts')))
    .map((f) => ({ rel: path.relative(CLI_DIR, f), src: codigo(f) }));

  it('a varredura enxerga os comandos (sanidade)', () => {
    const nomes = fontes.map((f) => f.rel);
    for (const n of ['index.ts', 'output.ts', 'context.ts', path.join('commands', 'run.ts')]) {
      expect(nomes).toContain(n);
    }
  });

  it('process.exit só em output.ts (failAndExit) e no --help/--version do index (EXIT.OK)', () => {
    for (const { rel, src } of fontes) {
      const chamadas = src.match(/process\.exit\([^)]*\)/g) ?? [];
      if (rel === 'output.ts') continue;
      if (rel === 'index.ts') {
        expect(chamadas.every((c) => c === 'process.exit(EXIT.OK)'), `${rel}: ${chamadas}`).toBe(true);
        continue;
      }
      expect(chamadas, rel).toEqual([]);
    }
  });

  it('só o main (index.ts) e o failAndExit renderizam erro: .fail( e exitCode em nenhum outro lugar', () => {
    for (const { rel, src } of fontes) {
      if (rel === 'index.ts' || rel === 'output.ts') continue;
      expect(src.match(/\.fail\(/g) ?? [], rel).toEqual([]);
      expect(src.match(/process\.exitCode\s*=/g) ?? [], rel).toEqual([]);
    }
  });

  it('nenhum result(ok:false…) e nenhum "Erro:" escrito à mão fora do output.ts', () => {
    for (const { rel, src } of fontes) {
      // result() só aceita `true` (literal): desfecho negativo é throw.
      const results = src.match(/\.result\(\s*([^,]+),/g) ?? [];
      for (const r of results) expect(r.replace(/\s+/g, ''), rel).toBe('.result(true,');
      if (rel === 'output.ts') continue;
      expect(src, rel).not.toMatch(/console\.(error|log|warn)\(/);
      expect(src, rel).not.toMatch(/stderr\.write\([^)]*Erro/);
    }
  });

  it('exit != 0 sem throw só nos exitFor (parcial 7/130) — e o ERROR dos agentes vira throw', () => {
    for (const { rel, src } of fontes) {
      for (const m of src.matchAll(/return\s+EXIT\.(\w+)/g)) {
        if (m[1] === 'OK') continue;
        const antes = src.slice(0, m.index);
        const fn = /function\s+(\w+)[^]*$/.exec(antes.slice(antes.lastIndexOf('function ')))?.[1];
        expect(fn, `${rel}: return EXIT.${m[1]} fora de exitFor`).toBe('exitFor');
        expect(['BUDGET', 'SIGINT', 'ERROR'], rel).toContain(m[1]);
      }
    }
    const agents = fontes.find((f) => f.rel === path.join('commands', 'agents.ts'))!.src;
    expect(agents).toMatch(/if \(code === EXIT\.ERROR\) \{[\s\S]{0,600}?throw new CliError/);
  });
});
