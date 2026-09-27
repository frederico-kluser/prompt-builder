// IMPL-092 (R-12:REC-2) — matriz de CÓDIGOS DE SAÍDA do CLI + a tabela de
// códigos em TODO `--help` de comando.
//
// Os códigos importam mais que o normal: o consumidor é um agente. A matriz
// cobre os 8 códigos do contrato do modo agente (0/2/3/4/5/7/8/130), ao menos
// um teste por código — os 5 primeiros pelo PROCESSO REAL (tsx, exit code do
// SO) e 5/7/130 pela normalização do envelope (toCliError/fail), que é o único
// renderizador de erro do CLI e determina o exit do processo.
//
// Zero rede real: gateway apontado para porta local fechada, data-dir
// temporário, sem OPENROUTER_API_KEY.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetExceeded, RunCancelled } from '../src/budget.js';
import { GatewayError } from '../src/openrouter.js';
import { EXIT, Output, resetOutputState, toCliError } from '../src/cli/output.js';
import { COMMANDS, HELP_TAIL, renderCommandHelp } from '../src/cli/help.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const ENTRY = path.join(ROOT, 'src', 'cli', 'index.ts');
const DEAD_BASE = 'http://127.0.0.1:9/api/v1';

let home = '';

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'pb-exits-'));
  // Config com typo para o exit 3 (`config unknown_key`, IMPL-093).
  writeFileSync(
    path.join(home, 'typo.json'),
    JSON.stringify({
      format: 'arena-config@1',
      mode: 'training',
      theme: 'suporte',
      stages: 3,
      prompt: { text: 'Você é um assistente.' },
      models: {
        datagen: 'openai/gpt-5-mini',
        judges: ['anthropic/claude-sonnet-5'],
        reference: 'google/gemini-2.5-pro',
        contestant: 'openai/gpt-5-mini',
      },
      trainig: { iterations: 3 },
    }),
  );
});

afterAll(() => {
  if (home) rmSync(home, { force: true, recursive: true });
});

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], homeDir: string = home): CliRun {
  const env: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: homeDir, OPENROUTER_BASE_URL: DEAD_BASE };
  delete env.OPENROUTER_API_KEY;
  const r = spawnSync(TSX, [ENTRY, ...args], { env, encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('matriz de exit codes (processo real)', { timeout: 120_000 }, () => {
  it('0 — ok: `config example` sai 0 e imprime o JSON no stdout', () => {
    const r = cli(['config', 'example', '--mode', 'compare']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(JSON.parse(r.stdout).format).toBe('arena-config@1');
  });

  it('2 — uso: flag desconhecida sai 2 com envelope usage.unknown_flag', () => {
    const r = cli(['models', 'list', '--json', '--serch', 'gpt']);
    expect(r.status).toBe(EXIT.USAGE);
    const env = JSON.parse(r.stdout) as { ok: boolean; error: { code: string; kind: string } };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('usage.unknown_flag');
    expect(env.error.kind).toBe('usage');
  });

  it('3 — config: chave desconhecida sai 3 (fail-closed, IMPL-093) citando a sugestão', () => {
    const r = cli(['config', 'validate', path.join(home, 'typo.json'), '--json']);
    expect(r.status).toBe(EXIT.CONFIG);
    const env = JSON.parse(r.stdout) as { error: { code: string; kind: string; message: string } };
    expect(env.error.code).toBe('config.unknown_key');
    expect(env.error.kind).toBe('config');
    expect(env.error.message).toContain('training'); // "você quis dizer training"
  });

  it('4 — auth: key ausente sai 4 com auth.key_missing', () => {
    const r = cli(['key', 'check', '--json']);
    expect(r.status).toBe(EXIT.AUTH);
    const env = JSON.parse(r.stdout) as { error: { code: string; kind: string } };
    expect(env.error.code).toBe('auth.key_missing');
    expect(env.error.kind).toBe('auth');
  });

  it('8 — rede: catálogo inalcançável sai 8 com network.catalog_unavailable', () => {
    // Home SEM cache de catálogo: o único caminho é a rede (porta fechada).
    const semCache = mkdtempSync(path.join(tmpdir(), 'pb-exits-rede-'));
    try {
      const r = cli(['models', 'list', '--json'], semCache);
      expect(r.status).toBe(EXIT.NETWORK);
      const env = JSON.parse(r.stdout) as { error: { code: string; kind: string } };
      expect(env.error.code).toBe('network.catalog_unavailable');
      expect(env.error.kind).toBe('network');
    } finally {
      rmSync(semCache, { force: true, recursive: true });
    }
  });

  it('5 — credit: gateway sem crédito (402) normaliza para exit 5 (credit)', () => {
    resetOutputState();
    const out = new Output({ format: 'json' });
    const err = out.fail('compare', new GatewayError('no_credit', 'Sem créditos na conta.', { httpStatus: 402 }));
    expect(err.code).toBe(EXIT.NO_CREDIT);
    expect(err.errorCode).toBe('credit.insufficient');
  });

  it('7 — control: BudgetExceeded normaliza para exit 7 (parcial por orçamento)', () => {
    resetOutputState();
    const out = new Output({ format: 'json' });
    const err = out.fail('train', new BudgetExceeded(5, 5, 'judge'));
    expect(err.code).toBe(EXIT.BUDGET);
    expect(err.errorCode).toBe('control.budget_exceeded');
  });

  it('130 — control: RunCancelled normaliza para exit 130 (interrompido)', () => {
    resetOutputState();
    const out = new Output({ format: 'json' });
    const err = out.fail('compare', new RunCancelled('SIGINT'));
    expect(err.code).toBe(EXIT.SIGINT);
    expect(err.errorCode).toBe('control.cancelled');
    resetOutputState();
  });
});

describe('help por comando lista a tabela de códigos de saída (IMPL-092)', () => {
  it('todo comando do dispatch tem help com a tabela de códigos', () => {
    for (const cmd of COMMANDS) {
      const texto = renderCommandHelp(cmd);
      expect(texto, cmd).toContain('CÓDIGOS DE SAÍDA');
      expect(texto, cmd).toContain('error.kind');
      // Os 8 códigos do contrato do agente aparecem na tabela.
      for (const codigo of ['0 ok', '2 uso', '3 config', '4 auth', '5 sem crédito', '7 parcial', '8 rede', '130']) {
        expect(texto, `${cmd}: ${codigo}`).toContain(codigo);
      }
    }
    // Sanidade: o rodapé compartilhado é o mesmo do help global.
    expect(HELP_TAIL).toContain('CÓDIGOS DE SAÍDA');
  });

  it('`<comando> --help` no processo real imprime o help DO comando + tabela', () => {
    for (const cmd of ['models', 'agents', 'config']) {
      const r = cli([cmd, '--help']);
      expect(r.status, r.stderr).toBe(EXIT.OK);
      expect(r.stdout, cmd).toContain(`prompt-builder ${cmd}`);
      expect(r.stdout, cmd).toContain('CÓDIGOS DE SAÍDA');
      expect(r.stdout, cmd).toContain('130 interrompido');
    }
  });
});
