// Contrato do CLI `vision` — o caminho que um agente realmente usa.
//
// Roda o binário COMPILADO (com fallback para tsx) e confere: payload no
// stdout, exit codes distintos, recusa de orçamento fora de TTY e do modelo
// inexistente — sem gastar nada (tudo com --dry-run ou dataset offline).

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeOrTsx, ROOT } from './support/cli.js';

const { cmd: BIN, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));

function run(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(BIN, [ENTRY, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CLAUDECODE: '1', OPENROUTER_API_KEY: '', ...env },
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

async function dataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'vision-cli-'));
}

describe('prompt-builder vision', () => {
  it('dataset list --json devolve o manifesto em payload', () => {
    const r = run(['vision', 'dataset', 'list', '--json']);
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout) as { ok: boolean; data: { scenes: Array<{ id: string }>; hash: string } };
    expect(env.ok).toBe(true);
    const ids = env.data.scenes.map((s) => s.id);
    expect(ids).toContain('bootstrap-login');
    expect(ids).toContain('macos-finder');
    expect(env.data.hash).toMatch(/^sha256:/);
  });

  it('dataset verify --json confere sha256 e sai 0', () => {
    const r = run(['vision', 'dataset', 'verify', '--json']);
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout) as { ok: boolean; data: { ok: boolean; issues: string[] } };
    expect(env.ok).toBe(true);
    expect(env.data.ok).toBe(true);
    expect(env.data.issues).toEqual([]);
  });

  it('dataset show traz elementos e tarefas do cenário', () => {
    const r = run(['vision', 'dataset', 'show', 'bootstrap-login', '--json']);
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout) as {
      ok: boolean;
      data: { scene: { elements: Array<{ id: string; bbox: unknown }>; tasks: Array<{ id: string }> } };
    };
    expect(env.data.scene.elements.length).toBeGreaterThanOrEqual(5);
    expect(env.data.scene.elements[0]?.bbox).toBeDefined();
    expect(env.data.scene.tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('subcomando desconhecido é exit 2 com "você quis dizer"', () => {
    const r = run(['vision', 'bogus', '--json']);
    expect(r.code).toBe(2);
    const env = JSON.parse(r.stdout) as { ok: boolean; error: { code: string; kind: string } };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('usage.unknown_subcommand');
    expect(env.error.kind).toBe('usage');
  });

  it('run real sem --budget (agente) recusa exit 2 antes de gastar', () => {
    const r = run(['vision', 'run', '--models', 'google/gemini-2.5-flash', '--json']);
    expect(r.code).toBe(2);
    const env = JSON.parse(r.stdout) as { ok: boolean; error: { code: string } };
    expect(env.error.code).toBe('usage.budget_required');
  });

  it('--dry-run com orçamento planeja sem key e devolve contagem de células', () => {
    const r = run([
      'vision', 'run', '--models', 'google/gemini-2.5-flash', '--tasks', 'map', '--limit', '2',
      '--budget', '0.5', '--dry-run', '--json',
    ]);
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout) as { ok: boolean; data: { cells: number; dryRun: boolean } };
    expect(env.ok).toBe(true);
    expect(env.data.dryRun).toBe(true);
    expect(env.data.cells).toBe(2);
  });

  it('run real sem key sai 4 (auth) e não gasta', async () => {
    const dir = await dataDir();
    const r = run(['vision', 'run', '--models', 'google/gemini-2.5-flash', '--limit', '1', '--budget', '0.5', '--data-dir', dir, '--json']);
    expect(r.code).toBe(4);
    const env = JSON.parse(r.stdout) as { ok: boolean; error: { code: string; kind: string } };
    expect(env.error.kind).toBe('auth');
  });

  it('report de id inexistente sai 3 com code estável', () => {
    const r = run(['vision', 'report', 'vision-nao-existe', '--json']);
    expect(r.code).toBe(3);
    const env = JSON.parse(r.stdout) as { ok: boolean; error: { code: string } };
    expect(env.error.code).toBe('vision.run_not_found');
  });
});

describe('prompt-builder vision — bancos de probe', () => {
  it('--benchmark resolution planeja cenário × escalas e recusa action', () => {
    const r = run([
      'vision', 'run', '--models', 'google/gemini-2.5-flash', '--benchmark', 'resolution',
      '--limit', '2', '--budget', '0.5', '--dry-run', '--json',
    ]);
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout) as {
      ok: boolean;
      data: { benchmark: string; variants: string[]; cells: number; tasks: string[] };
    };
    expect(env.ok).toBe(true);
    expect(env.data.benchmark).toBe('resolution');
    expect(env.data.variants).toEqual(['1920x1080', '1280x720', '960x540', '640x360']);
    expect(env.data.tasks).toEqual(['map']);
    expect(env.data.cells).toBe(8);

    const invalido = run([
      'vision', 'run', '--models', 'google/gemini-2.5-flash', '--benchmark', 'resolution',
      '--tasks', 'action', '--budget', '0.5', '--dry-run', '--json',
    ]);
    expect(invalido.code).toBe(2);
  });

  it('--benchmark grid planeja tarefa × variantes e cobra a 2ª rodada no teto', () => {
    const r = run([
      'vision', 'run', '--models', 'google/gemini-2.5-flash', '--benchmark', 'grid',
      '--scenes', 'bootstrap-login', '--grid-variants', 'plain,mark-grid',
      '--budget', '0.5', '--dry-run', '--json',
    ]);
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout) as {
      ok: boolean;
      data: { benchmark: string; variants: string[]; cells: number; tasks: string[]; estimateUsd: number | null };
    };
    expect(env.ok).toBe(true);
    expect(env.data.benchmark).toBe('grid');
    expect(env.data.variants).toEqual(['plain', 'mark-grid']);
    expect(env.data.tasks).toEqual(['action']);
    expect(env.data.cells).toBe(8); // 4 tarefas × 2 variantes
    expect(env.data.estimateUsd).toBeGreaterThan(0);
  });
});

describe('prompt-builder vision — matriz resolução × grade', () => {
  it('planeja resolução × grade sem overlay e aceita sidecar', () => {
    const r = run([
      'vision', 'run', '--models', 'google/gemini-2.5-flash', '--benchmark', 'matrix',
      '--scenes', 'bootstrap-login', '--resolutions', '1920x1080,640x360',
      '--matrix-grids', 'plain,frame-axis,sidecar-grid',
      '--budget', '1', '--dry-run', '--json',
    ]);
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout) as {
      ok: boolean;
      data: { benchmark: string; variants: string[]; cells: number; tasks: string[] };
    };
    expect(env.ok).toBe(true);
    expect(env.data.benchmark).toBe('matrix');
    expect(env.data.tasks).toEqual(['action']);
    expect(env.data.cells).toBe(24); // 4 tarefas × 2 resoluções × 3 grades
    expect(env.data.variants).toEqual([
      '1920x1080+plain',
      '1920x1080+frame-axis',
      '1920x1080+sidecar-grid',
      '640x360+plain',
      '640x360+frame-axis',
      '640x360+sidecar-grid',
    ]);
  });

  it('recusa grade de matriz desconhecida', () => {
    const r = run([
      'vision', 'run', '--models', 'google/gemini-2.5-flash', '--benchmark', 'matrix',
      '--matrix-grids', 'overlay', '--budget', '1', '--dry-run', '--json',
    ]);
    expect(r.code).toBe(2);
  });
});
