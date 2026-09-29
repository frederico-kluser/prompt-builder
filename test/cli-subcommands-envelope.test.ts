// Onda 2 (cluster cli-a) — o CLI nunca finge sucesso:
//
//  • cli#13: subcomando desconhecido em QUALQUER família sai exit 2 com
//    `usage.unknown_subcommand` ANTES de parse/disco/rede (antes `runs bogus
//    <id>` virava `runs show` com exit 0, `models shwo x` listava o catálogo,
//    `key remove` validava a key na rede, `config explain f.json` validava).
//  • IMPL-028: o comando é o 1º token que não é flag (nem valor de flag
//    global) — `--json compare --bogus` sai pelo envelope, não pelo help em
//    texto com exit 0; flags sem comando são `usage.missing_command`.
//  • cli#19: consumidor que fecha o pipe (`docs --all | head -1`) NÃO é
//    "Falha de rede" com exit 8 — sai 0 em silêncio.
//
// Zero rede: OPENROUTER_BASE_URL aponta para uma porta morta e não há key.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXIT } from '../src/cli/output.js';
import { assertKnownSubcommand, commandLabel, isBareHelpRequest, locateCommand } from '../src/cli/context.js';
import { nodeOrTsx, ROOT } from './support/cli.js';

const { cmd: NODE, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));
const DEAD_BASE = 'http://127.0.0.1:9/api/v1';

let home = '';
beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'pb-subcmd-'));
});
afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: home, OPENROUTER_BASE_URL: DEAD_BASE, CI: '1' };
  delete e.OPENROUTER_API_KEY;
  return e;
}

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(NODE, [ENTRY, ...args], { env: env(), encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

interface Envelope {
  ok: boolean;
  command: string;
  error?: { code: string; kind: string; message: string; hint?: string; details?: Record<string, unknown> };
}

function envelope(stdout: string): Envelope {
  return JSON.parse(stdout.trim().split('\n').at(-1) as string) as Envelope;
}

describe('cli#13 — subcomando desconhecido é exit 2 em toda família', { timeout: 120_000 }, () => {
  const casos: Array<{ argv: string[]; sugestao?: RegExp }> = [
    { argv: ['runs', 'bogus', 'x'] },
    { argv: ['runs', 'rm', 'x'], sugestao: /runs delete/ },
    { argv: ['sessions', 'bogus', 'x'] },
    { argv: ['key', 'remove'], sugestao: /key rm/ },
    { argv: ['key', 'bogus'] },
    { argv: ['models', 'shwo', 'x'], sugestao: /models show/ },
    { argv: ['config', 'explain', 'f.json'], sugestao: /config validate/ },
    { argv: ['registry', 'bogus'] },
    { argv: ['limits', 'bogus'] },
    // Modo JEV (merge sobre a onda 2): a família nova segue o mesmo contrato.
    { argv: ['jev', 'bogus'] },
    { argv: ['jev', 'ls'], sugestao: /jev list/ },
  ];
  for (const c of casos) {
    it(`${c.argv.join(' ')} → exit 2 usage.unknown_subcommand (nada roda)`, () => {
      const r = cli([...c.argv, '--json']);
      expect(r.status, r.stderr).toBe(EXIT.USAGE);
      const env = envelope(r.stdout);
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe('usage.unknown_subcommand');
      expect(env.error?.details?.subcommand).toBe(c.argv[1]);
      if (c.sugestao) expect(env.error?.hint).toMatch(c.sugestao);
      // Nada de rede/"key" no caminho: o guard vem antes de tudo.
      expect(r.stderr).not.toMatch(/Falha de rede|OPENROUTER_API_KEY ausente/);
    });
  }

  it('um id no lugar do subcomando aponta `runs show <id>`', () => {
    const id = '0b6f7c1e-1d2a-4c8e-9f00-123456789abc';
    const r = cli(['runs', id, '--json']);
    expect(r.status).toBe(EXIT.USAGE);
    expect(envelope(r.stdout).error?.hint).toContain(`runs show ${id}`);
  });

  it('comandos sem subcomando recusam argumento solto (lgpd/techniques)', () => {
    for (const argv of [['lgpd', 'delete'], ['techniques', 'bogus']]) {
      const r = cli([...argv, '--json']);
      expect(r.status, argv.join(' ')).toBe(EXIT.USAGE);
      expect(envelope(r.stdout).error?.code).toBe('usage.unexpected_argument');
    }
  });

  it('assertKnownSubcommand: aceito passa; alias vira sugestão; detalhes listam os aceitos', () => {
    expect(() => assertKnownSubcommand('runs', 'list', ['list', 'show'], { usage: '' })).not.toThrow();
    try {
      assertKnownSubcommand('key', 'remove', ['check', 'rm'], { usage: 'key check | key rm', aliases: { remove: 'rm' } });
      expect.unreachable();
    } catch (e) {
      const err = e as { code: number; errorCode: string; details: { accepted: string[]; suggestion: string } };
      expect(err.code).toBe(EXIT.USAGE);
      expect(err.errorCode).toBe('usage.unknown_subcommand');
      expect(err.details.accepted).toEqual(['check', 'rm']);
      expect(err.details.suggestion).toBe('rm');
    }
  });
});

describe('IMPL-028 — flag global ANTES do comando ainda sai pelo envelope', { timeout: 120_000 }, () => {
  it('locateCommand pula flags globais e seus valores; as flags de antes vão para o fim', () => {
    expect(locateCommand(['--json', 'compare', '--bogus'])).toEqual({ cmd: 'compare', rest: ['--bogus', '--json'] });
    expect(locateCommand(['--data-dir', '/tmp/x', 'runs', 'list'])).toEqual({
      cmd: 'runs',
      rest: ['list', '--data-dir', '/tmp/x'],
    });
    expect(locateCommand(['--output-format=ndjson', 'runs', 'show', 'a'])).toEqual({
      cmd: 'runs',
      rest: ['show', 'a', '--output-format=ndjson'],
    });
    expect(locateCommand(['--budget', '5', 'compare'])).toEqual({ cmd: 'compare', rest: ['--budget', '5'] });
    expect(locateCommand(['--json'])).toEqual({ cmd: undefined, rest: ['--json'] });
    expect(commandLabel(['--json', 'runs', 'list'])).toBe('runs.list');
    expect(isBareHelpRequest([])).toBe(true);
    expect(isBareHelpRequest(['--help'])).toBe(true);
    expect(isBareHelpRequest(['--json'])).toBe(false);
  });

  it('`--json compare --bogus` → envelope JSON no stdout, exit 2', () => {
    const r = cli(['--json', 'compare', '--bogus']);
    expect(r.status, r.stderr).toBe(EXIT.USAGE);
    const env = envelope(r.stdout);
    expect(env).toMatchObject({ ok: false, command: 'compare' });
    expect(env.error?.kind).toBe('usage');
  });

  it('`--json` sozinho → usage.missing_command (nunca o help em texto com exit 0)', () => {
    const r = cli(['--json']);
    expect(r.status).toBe(EXIT.USAGE);
    expect(envelope(r.stdout).error?.code).toBe('usage.missing_command');
  });

  it('`--output-format ndjson <cmd inexistente>` termina em type:"result" ok:false', () => {
    const r = cli(['--output-format', 'ndjson', 'nonexistentcmd']);
    expect(r.status).toBe(EXIT.USAGE);
    const ultima = JSON.parse(r.stdout.trim().split('\n').at(-1) as string) as { type: string; ok: boolean };
    expect(ultima).toMatchObject({ type: 'result', ok: false });
  });

  it('`--data-dir X runs list --json` roda o comando (exit 0, JSON)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pb-subcmd-dd-'));
    try {
      const r = cli(['--data-dir', dir, 'runs', 'list', '--json']);
      expect(r.status, r.stderr).toBe(EXIT.OK);
      expect(envelope(r.stdout)).toMatchObject({ ok: true, command: 'runs.list' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sem nada (ou só --help) continua o help com exit 0', () => {
    expect(cli([]).status).toBe(EXIT.OK);
    expect(cli(['--help']).status).toBe(EXIT.OK);
  });
});

describe('cli#19 — pipe fechado pelo consumidor não é falha de rede', { timeout: 60_000 }, () => {
  it('`docs --all | head -1` sai 0, sem "Falha de rede" no stderr', async () => {
    const child = spawn(NODE, [ENTRY, 'docs', '--all'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (c: string) => (stderr += c));
    // Como o `head`: lê o 1º pedaço e fecha a ponta de leitura.
    child.stdout.once('data', () => child.stdout.destroy());
    const status = await new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    expect(stderr).not.toMatch(/Falha de rede|EPIPE/);
    expect(status).toBe(EXIT.OK);
  });
});
