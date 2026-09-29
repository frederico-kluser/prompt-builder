// cli#20 — as dicas de erro de config apontavam `config validate`, que não
// conseguia validar o que o usuário tinha na mão:
//  • arena-agent-config@1 → "Arquivo não é uma configuração do prompt-builder"
//    (exit 3) — agora valida com a MESMA leitura do `agents run`;
//  • config montada por FLAGS → dica "valide o arquivo" sem arquivo nenhum —
//    agora a dica fala da flag, e `--effort-*` inválido é USO (exit 2) já na
//    flag, com os 7 degraus aceitos.
// Zero rede: a recusa vem antes do catálogo/key.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXIT } from '../src/cli/output.js';
import { nodeOrTsx, ROOT } from './support/cli.js';

const { cmd: NODE, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));

let home = '';
beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'pb-cfg-agent-'));
});
afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

function cli(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: home, OPENROUTER_BASE_URL: 'http://127.0.0.1:9/api/v1', CI: '1' };
  delete env.OPENROUTER_API_KEY;
  const r = spawnSync(NODE, [ENTRY, ...args, '--json'], { env, encoding: 'utf-8', timeout: 60_000 });
  return {
    status: r.status,
    json: JSON.parse(r.stdout.trim().split('\n').at(-1) as string) as {
      ok: boolean;
      data?: { format: string; config: { agent?: { executor: string } } };
      error?: { code: string; hint: string; details?: Record<string, unknown> };
    },
    stderr: r.stderr,
  };
}

function grava(nome: string, json: unknown): string {
  const file = path.join(home, nome);
  writeFileSync(file, JSON.stringify(json));
  return file;
}

const AGENTE = {
  format: 'arena-agent-config@1',
  mode: 'compare',
  theme: 'Correção de bugs',
  agent: { executor: 'pi', executorVersion: '0.84.2', limits: { maxCostUsd: 0.2 } },
  models: { datagen: 'acme/judge', judges: ['acme/judge'], competitors: ['acme/alpha', 'acme/beta'] },
  scenarios: [{ question: 'Conserte o parser.', agentTask: { files: [{ path: 'src/a.ts', content: 'x' }] } }],
};

describe('cli#20 — `config validate` aceita o arquivo de AGENTE', { timeout: 120_000 }, () => {
  it('arena-agent-config@1 válido → exit 0 com o RunConfig convertido', () => {
    const r = cli(['config', 'validate', grava('agente.json', AGENTE)]);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(r.json.data?.format).toBe('arena-agent-config@1');
    expect(r.json.data?.config.agent?.executor).toBe('pi');
  });

  it('arena-agent-config@1 com typo → exit 3 config.unknown_key (fail-closed do agents run)', () => {
    const r = cli(['config', 'validate', grava('agente-typo.json', { ...AGENTE, scenarioz: [] })]);
    expect(r.status).toBe(EXIT.CONFIG);
    expect(r.json.error?.code).toBe('config.unknown_key');
  });

  it('arena-agent-config@1 com files[] fora do workspace → exit 3 (mesma checagem do agents run)', () => {
    const fora = { ...AGENTE, scenarios: [{ question: 'x', agentTask: { files: [{ path: '../fora.txt', content: 'x' }] } }] };
    expect(cli(['config', 'validate', grava('agente-fora.json', fora)]).status).toBe(EXIT.CONFIG);
  });
});

describe('cli#20 — config montada por FLAGS tem dica de flag', { timeout: 120_000 }, () => {
  const BASE = ['compare', '--theme', 't', '--models', 'acme/alpha,acme/beta', '--judge', 'acme/judge', '--budget', '1'];

  it('`--effort-competitor bogus` → exit 2 usage.invalid_flag_value citando a flag e os 7 degraus', () => {
    const r = cli([...BASE, '--effort-competitor', 'bogus']);
    expect(r.status).toBe(EXIT.USAGE);
    expect(r.json.error?.code).toBe('usage.invalid_flag_value');
    expect(r.json.error?.details).toMatchObject({ flag: '--effort-competitor', value: 'bogus' });
    expect(r.json.error?.details?.accepted).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('typo de degrau sugere o certo (`hihg` → `high`)', () => {
    const r = cli([...BASE, '--effort-judge', 'hihg']);
    expect(r.status).toBe(EXIT.USAGE);
    expect(r.json.error?.hint).toContain('--effort-judge high');
  });

  it('config inválida vinda das flags → config.invalid com dica que NÃO manda validar arquivo', () => {
    // O juiz não pode competir: o schema recusa — mas não há arquivo nenhum.
    const r = cli(['compare', '--theme', 't', '--models', 'acme/alpha,acme/beta', '--judge', 'acme/alpha', '--budget', '1']);
    expect(r.status).toBe(EXIT.CONFIG);
    expect(r.json.error?.code).toBe('config.invalid');
    expect(r.json.error?.hint).toMatch(/veio das flags/);
    expect(r.json.error?.hint).not.toMatch(/^Valide o arquivo/);
  });
});
