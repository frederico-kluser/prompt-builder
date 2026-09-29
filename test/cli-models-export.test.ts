// cli#10 — `models export -o <arquivo>` gravava 50 de ~460 modelos (o teto de
// lista do IMPL-092, que existe para proteger o CONTEXTO do agente, não um
// arquivo) e o `baseline check --catalog` acusava o juiz de "removido". Agora
// `export` e `-o` não levam o teto default; `--limit` explícito continua valendo
// e o envelope diz se o arquivo é parcial.
//
// cli#18 — `models list --format csv --json` descartava o CSV (sobrava
// {count}); `--output-format ndjson` saía sem a linha `result` do contrato.
//
// Zero rede: o catálogo vem do cache em disco semeado aqui (60 > teto de 50).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeOrTsx } from './support/cli.js';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT } from '../src/cli/output.js';
import { DEFAULT_LIST_LIMIT } from '../src/cli/context.js';
import { loadCatalogFile } from '../src/publicCatalog.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { cmd: NODE, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));
const DEAD_BASE = 'http://127.0.0.1:9/api/v1';
const TOTAL = 60;

let home = '';

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'pb-models-export-'));
  const modelo = (id: string) => ({ id, name: `Modelo ${id}`, pricing: { prompt: 1e-6, completion: 2e-6 } });
  mkdirSync(path.join(home, 'cache'), { recursive: true });
  writeFileSync(
    path.join(home, 'cache', 'models-public.json'),
    JSON.stringify({
      v: 1,
      fetchedAt: Date.now(),
      base: DEAD_BASE,
      count: TOTAL,
      data: Array.from({ length: TOTAL }, (_, i) => modelo(`fake/m${String(i).padStart(2, '0')}`)),
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

function cli(args: string[]): CliRun {
  const env: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: home, OPENROUTER_BASE_URL: DEAD_BASE };
  delete env.OPENROUTER_API_KEY;
  const r = spawnSync(NODE, [ENTRY, ...args], { env, cwd: home, encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function ultimaLinha(r: CliRun): Record<string, unknown> {
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
}

interface ExportFile {
  format: string;
  count: number;
  total: number;
  truncated: boolean;
  data: { id: string }[];
}

describe('cli#10 — export/-o gravam o catálogo INTEIRO (sem o teto de 50)', { timeout: 120_000 }, () => {
  it('`models export -o f --json`: arquivo com os 60 e envelope truncated:false', () => {
    const alvo = path.join(home, 'export.json');
    const r = cli(['models', 'export', '-o', alvo, '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const arq = JSON.parse(readFileSync(alvo, 'utf-8')) as ExportFile;
    expect(arq.data).toHaveLength(TOTAL);
    expect(arq).toMatchObject({ count: TOTAL, total: TOTAL, truncated: false });
    expect(ultimaLinha(r)).toMatchObject({
      ok: true,
      command: 'models.export',
      data: { count: TOTAL, total: TOTAL, truncated: false, file: alvo, format: 'json' },
    });
    // nada de aviso de truncamento: o arquivo é o catálogo pedido
    expect(r.stderr).not.toMatch(/truncad/iu);
  });

  it('`models export -o f` (texto): o arquivo exportado é o que `baseline check --catalog` lê', async () => {
    const alvo = path.join(home, 'export-texto.json');
    const r = cli(['models', 'export', '-o', alvo]);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const catalogo = await loadCatalogFile(alvo);
    expect(catalogo.length).toBe(TOTAL);
  });

  it('`models export` sem -o também não trunca (o catálogo é o produto)', () => {
    const r = cli(['models', 'export']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect((JSON.parse(r.stdout) as ExportFile).data).toHaveLength(TOTAL);
  });

  it('`models list -o f --json`: arquivo sem teto (nada vai para o contexto)', () => {
    const alvo = path.join(home, 'list.json');
    const r = cli(['models', 'list', '-o', alvo, '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect((JSON.parse(readFileSync(alvo, 'utf-8')) as ExportFile).data).toHaveLength(TOTAL);
  });

  it('`--limit` explícito continua valendo e o envelope diz que o arquivo é parcial', () => {
    const alvo = path.join(home, 'parcial.json');
    const r = cli(['models', 'export', '-o', alvo, '--limit', '2', '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect((JSON.parse(readFileSync(alvo, 'utf-8')) as ExportFile)).toMatchObject({ count: 2, total: TOTAL, truncated: true });
    expect(ultimaLinha(r)).toMatchObject({ data: { count: 2, total: TOTAL, truncated: true } });
  });

  it('`models list --json` no stdout segue com o teto de 50 (IMPL-092 intacto)', () => {
    const r = cli(['models', 'list', '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect((JSON.parse(r.stdout) as ExportFile).data).toHaveLength(DEFAULT_LIST_LIMIT);
  });
});

describe('cli#18 — saída de máquina do `models list` é parseável e completa', { timeout: 120_000 }, () => {
  it('`--format csv --json`: o CSV vai DENTRO do envelope (antes sumia)', () => {
    const r = cli(['models', 'list', '--format', 'csv', '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const env = JSON.parse(r.stdout) as { ok: boolean; data: { format: string; payload: string; count: number } };
    expect(env.ok).toBe(true);
    expect(env.data.format).toBe('csv');
    expect(env.data.count).toBe(DEFAULT_LIST_LIMIT);
    const linhas = env.data.payload.trim().split('\n');
    expect(linhas).toHaveLength(DEFAULT_LIST_LIMIT + 1); // cabeçalho + linhas
    expect(linhas[1]).toContain('fake/m00');
  });

  it('`--format ids --json`: os ids no envelope', () => {
    const r = cli(['models', 'list', '--format', 'ids', '--limit', '3', '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const env = JSON.parse(r.stdout) as { data: { payload: string } };
    expect(env.data.payload.split('\n')).toEqual(['fake/m00', 'fake/m01', 'fake/m02']);
  });

  it('`--output-format ndjson`: linhas `model` tipadas + `result` final com count/total/truncated', () => {
    const r = cli(['models', 'list', '--output-format', 'ndjson']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const linhas = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const modelos = linhas.filter((l) => l.type === 'model');
    expect(modelos).toHaveLength(DEFAULT_LIST_LIMIT);
    expect(modelos[0]).toMatchObject({ id: 'fake/m00' });
    expect(linhas.at(-1)).toMatchObject({
      type: 'result',
      ok: true,
      command: 'models.list',
      count: DEFAULT_LIST_LIMIT,
      total: TOTAL,
      truncated: true,
    });
  });

  it('`--format ndjson` em modo texto segue sendo o export cru (uma linha por modelo)', () => {
    const r = cli(['models', 'list', '--format', 'ndjson', '--limit', '2']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const linhas = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as { id: string; type?: string });
    expect(linhas.map((l) => l.id)).toEqual(['fake/m00', 'fake/m01']);
    expect(linhas[0].type).toBeUndefined();
  });
});
