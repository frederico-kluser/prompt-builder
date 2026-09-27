// IMPL-092 (R-12:REC-2) — teto DEFAULT de 50 itens em toda lista
// (`--limit <N>` / `--all`, truncar avisa no stderr) e JSON COMPACTO por
// padrão com `--pretty` opcional.
//
// O defeito medido: `models list --json` sem flags devolvia o catálogo INTEIRO
// (~594 KB ≈ 150 mil tokens, satura o contexto do agente) e o JSON saía sempre
// indentado. Zero rede: o catálogo vem do cache em disco semeado aqui.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT } from '../src/cli/output.js';
import { DEFAULT_LIST_LIMIT, limitList, parseListLimit } from '../src/cli/context.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const ENTRY = path.join(ROOT, 'src', 'cli', 'index.ts');
const DEAD_BASE = 'http://127.0.0.1:9/api/v1';

/** Catálogo semeado MAIOR que o teto: dá para ver o truncamento de verdade. */
const TOTAL = 60;

let home = '';

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'pb-list-limit-'));
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
  const r = spawnSync(TSX, [ENTRY, ...args], { env, encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

interface ModelsPayload {
  count: number;
  total: number;
  truncated: boolean;
  data: { id: string }[];
}

describe('teto de lista: --limit/--all (IMPL-092)', { timeout: 120_000 }, () => {
  it('`models list --json` sem flags devolve ≤ 50 itens e < 200 KB', () => {
    const r = cli(['models', 'list', '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const payload = JSON.parse(r.stdout) as ModelsPayload;
    expect(payload.data.length).toBe(DEFAULT_LIST_LIMIT);
    expect(payload.data.length).toBeLessThanOrEqual(50);
    expect(payload.count).toBe(50);
    expect(payload.total).toBe(TOTAL);
    expect(payload.truncated).toBe(true);
    // Meta do item: saída de lista padrão < 25 mil tokens (aqui: < 200 KB).
    expect(Buffer.byteLength(r.stdout, 'utf-8')).toBeLessThan(200_000);
    // O truncamento NUNCA é silencioso (stderr = narração).
    expect(r.stderr).toContain(`mostrando 50 de ${TOTAL}`);
    expect(r.stderr).toContain('--all');
  });

  it('`--all` devolve a lista inteira e o --limit explícito respeita o pedido', () => {
    const tudo = cli(['models', 'list', '--json', '--all']);
    expect(tudo.status, tudo.stderr).toBe(EXIT.OK);
    const pTudo = JSON.parse(tudo.stdout) as ModelsPayload;
    expect(pTudo.data.length).toBe(TOTAL);
    expect(pTudo.truncated).toBe(false);
    expect(tudo.stderr).not.toContain('mostrando');

    const sete = cli(['models', 'list', '--json', '--limit', '7']);
    expect(sete.status, sete.stderr).toBe(EXIT.OK);
    const pSete = JSON.parse(sete.stdout) as ModelsPayload;
    expect(pSete.data.length).toBe(7);
    expect(sete.stderr).toContain(`mostrando 7 de ${TOTAL}`);
  });

  it('--limit inválido é uso (exit 2), não silêncio', () => {
    const r = cli(['models', 'list', '--json', '--limit', '0']);
    expect(r.status).toBe(EXIT.USAGE);
    const env = JSON.parse(r.stdout) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('usage.invalid_flag_value');
    expect(env.error.message).toContain('--limit');
  });
});

describe('JSON compacto por padrão, --pretty formata (IMPL-092)', { timeout: 120_000 }, () => {
  it('`models list --json` sai em UMA linha; --pretty indent 2', () => {
    const compacto = cli(['models', 'list', '--json', '--limit', '3']);
    expect(compacto.status, compacto.stderr).toBe(EXIT.OK);
    expect(compacto.stdout.trim().includes('\n')).toBe(false);
    // compacto = o parse re-serializa para o MESMO byte
    expect(compacto.stdout.trim()).toBe(JSON.stringify(JSON.parse(compacto.stdout)));

    const pretty = cli(['models', 'list', '--json', '--pretty', '--limit', '3']);
    expect(pretty.status, pretty.stderr).toBe(EXIT.OK);
    expect(pretty.stdout).toContain('\n  ');
    expect(JSON.parse(pretty.stdout).data.length).toBe(3);
  });

  it('o envelope --json (result) também é compacto por padrão', () => {
    const compacto = cli(['runs', 'list', '--json']);
    expect(compacto.status, compacto.stderr).toBe(EXIT.OK);
    expect(compacto.stdout.trim().includes('\n')).toBe(false);
    const pretty = cli(['runs', 'list', '--json', '--pretty']);
    expect(pretty.status, pretty.stderr).toBe(EXIT.OK);
    expect(pretty.stdout).toContain('\n  ');
  });
});

describe('helper de teto (unidade)', () => {
  const avisos: string[] = [];
  const outFalso = { warn: (m: string) => avisos.push(m) } as unknown as Parameters<typeof limitList>[2];

  it('default 50, --all sem teto, --limit explícito e validação', () => {
    expect(parseListLimit({}).limit).toBe(DEFAULT_LIST_LIMIT);
    expect(parseListLimit({ all: true }).limit).toBeNull();
    expect(parseListLimit({ limit: '12', all: true }).limit).toBeNull(); // --all vence
    expect(parseListLimit({ limit: '12' }).limit).toBe(12);
    expect(() => parseListLimit({ limit: 'x' })).toThrow(/--limit/);
    expect(() => parseListLimit({ limit: '-3' })).toThrow(/--limit/);
  });

  it('limitList trunca avisando e devolve tudo sob --all', () => {
    avisos.length = 0;
    const linhas = Array.from({ length: 60 }, (_, i) => i);
    expect(limitList(linhas, { limit: 50 }, outFalso, 'runs')).toHaveLength(50);
    expect(avisos.join()).toContain('mostrando 50 de 60 runs');
    avisos.length = 0;
    expect(limitList(linhas, { limit: null }, outFalso, 'runs')).toHaveLength(60);
    expect(avisos).toHaveLength(0);
  });
});
