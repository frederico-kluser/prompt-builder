// IMPL-090 (R-22:REC-7) — runs que consomem itens de biblioteca dizem quantos
// foram CURADOS (aprovado E com o contentHash do conteúdo atual):
//  (1) o resultado traz `curatedKofN` e o NDJSON uma linha `run.warning`
//      AGREGADA (uma só, fora dos eventos de etapa) quando há não aprovados;
//  (2) `--require-approved` recusa com exit 3 havendo item não aprovado;
//  (3) holdout com item não aprovado é recusado (exit 3) quando o perfil usa
//      curadoria — sem curadoria nenhuma só avisa (sem bloqueio por default:
//      bloqueio total = curadoria nunca acontece com mantenedor solo);
//  (4) o aviso é agregado e não é um RunEvent (nenhum reducer de etapas o vê).
// Zero rede: catálogo semeado em disco; dry-run sem key.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXIT } from '../src/cli/output.js';
import { readConfigFile, type LibraryCuration } from '../src/cli/commands/run.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { saveItems, saveProfile } from '../src/library.js';
import { markItemReviewed, type LibraryItem } from '../src/engine/libraryCore.js';
import { nodeOrTsx, ROOT } from './support/cli.js';

const { cmd: NODE, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));
const DEAD_BASE = 'http://127.0.0.1:9/api/v1';

let dir = '';
let anterior = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pb-curation-'));
  anterior = getDataDir();
  setDataDir(dir);
});
afterEach(() => {
  setDataDir(anterior);
  rmSync(dir, { recursive: true, force: true });
});

function item(i: number): LibraryItem {
  return {
    id: `item-${String(i).padStart(2, '0')}`,
    title: `item ${i}`,
    tier: 'mft',
    question: `Pergunta ${i}?`,
    productContext: 'ctx',
    maxTokens: 200,
    reference: `resposta ${i}`,
    origin: 'manual',
    createdAt: '2026-09-01T00:00:00.000Z',
  } as LibraryItem;
}
const aprovar = (x: LibraryItem): LibraryItem => markItemReviewed(x, { state: 'aprovado', reviewer: 'revisora' });

const ARENA = (mode: 'variation' | 'training', extra: Record<string, unknown> = {}) => ({
  format: 'arena-config@1',
  mode,
  theme: 'suporte',
  prompt: { text: 'Você é um atendente.' },
  models: { datagen: 'fake/gen', judges: ['fake/judge'], contestant: 'fake/a', reference: 'fake/ref' },
  variation: { techniques: ['persona', 'constraints'] },
  scenarios: { from: 'library', profile: 'curado' },
  ...extra,
});

function grava(nome: string, json: unknown): string {
  const f = path.join(dir, nome);
  writeFileSync(f, JSON.stringify(json));
  return f;
}

async function ler(file: string, library: { requireApproved?: boolean } = {}) {
  let curation: LibraryCuration | undefined;
  const config = await readConfigFile(file, {}, { library: { ...library, onCuration: (c) => (curation = c) } });
  return { config, curation };
}

async function erroDe(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { code: number; errorCode: string; details: Record<string, unknown> };
  }
  throw new Error('esperava recusa');
}

describe('IMPL-090 — curadoria relatada, opt-in bloqueia', () => {
  it('(1) k de n curados + aviso AGREGADO (um só) quando há não aprovados — sem bloquear', async () => {
    await saveProfile({ id: 'curado', name: 'curado' });
    await saveItems('curado', [aprovar(item(1)), aprovar(item(2)), item(3), { ...item(4), state: 'gerado' } as LibraryItem]);
    const { config, curation } = await ler(grava('v.json', ARENA('variation')));
    expect(config.customStages).toHaveLength(4);
    expect(curation).toMatchObject({ curated: 2, total: 4, curatedKofN: '2 de 4 itens curados' });
    expect(curation!.unapproved.map((u) => u.id)).toEqual(['item-03', 'item-04']);
    expect(curation!.warnings).toHaveLength(1);
    expect(curation!.warnings[0]).toContain('2 de 4 itens curados');
  });

  it('aprovação velha (conteúdo editado depois) não conta como curado', async () => {
    await saveProfile({ id: 'curado', name: 'curado' });
    const editado = { ...aprovar(item(1)), question: 'mudou depois da revisão?' } as LibraryItem;
    await saveItems('curado', [editado, aprovar(item(2))]);
    const { curation } = await ler(grava('v.json', ARENA('variation')));
    expect(curation).toMatchObject({ curated: 1, total: 2 });
  });

  it('(2) --require-approved com item não aprovado → exit 3 library.unapproved_items', async () => {
    await saveProfile({ id: 'curado', name: 'curado' });
    await saveItems('curado', [aprovar(item(1)), item(2)]);
    const e = await erroDe(ler(grava('v.json', ARENA('variation')), { requireApproved: true }));
    expect(e.code).toBe(EXIT.CONFIG);
    expect(e.errorCode).toBe('library.unapproved_items');
  });

  it('--require-approved com 100% aprovados passa, sem aviso', async () => {
    await saveProfile({ id: 'curado', name: 'curado' });
    await saveItems('curado', [aprovar(item(1)), aprovar(item(2))]);
    const { curation } = await ler(grava('v.json', ARENA('variation')), { requireApproved: true });
    expect(curation).toMatchObject({ curated: 2, total: 2, warnings: [] });
  });

  it('(3) holdout com item não aprovado num perfil COM curadoria → exit 3 library.unapproved_holdout', async () => {
    await saveProfile({ id: 'curado', name: 'curado' });
    // 20 itens → holdout de 10 (piso absoluto); só os 5 primeiros aprovados.
    const itens = Array.from({ length: 20 }, (_, i) => (i < 5 ? aprovar(item(i)) : item(i)));
    await saveItems('curado', itens);
    const e = await erroDe(ler(grava('t.json', ARENA('training', { training: { iterations: 2 } }))));
    expect(e.code).toBe(EXIT.CONFIG);
    expect(e.errorCode).toBe('library.unapproved_holdout');
    expect((e.details.holdoutIds as string[]).length).toBe(10);
  });

  it('holdout 100% aprovado passa mesmo com itens de TREINO não aprovados (só avisa)', async () => {
    await saveProfile({ id: 'curado', name: 'curado' });
    // O split intercalado reserva os índices 1,3,5,…,19 (20 itens, 10 no holdout).
    const itens = Array.from({ length: 20 }, (_, i) => (i % 2 === 1 ? aprovar(item(i)) : item(i)));
    await saveItems('curado', itens);
    const { curation } = await ler(grava('t.json', ARENA('training', { training: { iterations: 2 } })));
    expect(curation).toMatchObject({ curated: 10, total: 20 });
    expect(curation!.warnings).toHaveLength(1);
  });

  it('perfil SEM curadoria nenhuma: holdout não bloqueia (mantenedor solo) — avisa', async () => {
    await saveProfile({ id: 'curado', name: 'curado' });
    await saveItems('curado', Array.from({ length: 20 }, (_, i) => item(i)));
    const { curation } = await ler(grava('t.json', ARENA('training', { training: { iterations: 2 } })));
    expect(curation).toMatchObject({ curated: 0, total: 20 });
    expect(curation!.warnings.join(' ')).toMatch(/holdout usa 10 cenário/);
  });

  it('`training.holdoutRatio: 0` (sem holdout) não aciona a recusa do holdout', async () => {
    await saveProfile({ id: 'curado', name: 'curado' });
    const itens = Array.from({ length: 20 }, (_, i) => (i < 5 ? aprovar(item(i)) : item(i)));
    await saveItems('curado', itens);
    const { curation } = await ler(grava('t.json', ARENA('training', { training: { iterations: 2, holdoutRatio: 0 } })));
    expect(curation?.total).toBe(20);
  });
});

describe('IMPL-090 — pelo processo real (dry-run, sem key)', { timeout: 120_000 }, () => {
  function semearCatalogo(): void {
    mkdirSync(path.join(dir, 'cache'), { recursive: true });
    const modelo = (id: string) => ({ id, name: id, pricing: { prompt: 1e-6, completion: 2e-6 } });
    writeFileSync(
      path.join(dir, 'cache', 'models-public.json'),
      JSON.stringify({
        v: 1,
        fetchedAt: Date.now(),
        base: DEAD_BASE,
        count: 4,
        data: ['fake/gen', 'fake/judge', 'fake/a', 'fake/ref'].map(modelo),
      }),
    );
  }

  function cli(args: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env, OPENROUTER_BASE_URL: DEAD_BASE, CI: '1' };
    delete env.OPENROUTER_API_KEY;
    delete env.PROMPT_BUILDER_HOME;
    const r = spawnSync(NODE, [ENTRY, ...args, '--data-dir', dir], { env, encoding: 'utf-8', timeout: 60_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it('resultado traz curatedKofN; NDJSON tem UMA linha run.warning agregada', async () => {
    semearCatalogo();
    await saveProfile({ id: 'curado', name: 'curado' });
    await saveItems('curado', [aprovar(item(1)), item(2), item(3)]);
    const f = grava('v.json', ARENA('variation'));

    const js = cli(['vary', '--config', f, '--dry-run', '--budget', '1000', '--json']);
    expect(js.status, js.stderr).toBe(EXIT.OK);
    const env = JSON.parse(js.stdout) as { data: { curatedKofN: string; curation: { curated: number; total: number } } };
    expect(env.data.curatedKofN).toBe('1 de 3 itens curados');
    expect(env.data.curation).toMatchObject({ curated: 1, total: 3 });
    expect(js.stderr).toContain('itens não aprovados em uso');

    const nd = cli(['vary', '--config', f, '--dry-run', '--budget', '1000', '--output-format', 'ndjson']);
    expect(nd.status, nd.stderr).toBe(EXIT.OK);
    const linhas = nd.stdout.trim().split('\n').map((l) => JSON.parse(l) as { type: string; code?: string; stageIndex?: number });
    const avisos = linhas.filter((l) => l.type === 'run.warning');
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ code: 'library.unapproved_items', curated: 1, total: 3 });
    expect(avisos[0].stageIndex).toBeUndefined(); // não é evento de etapa
  });

  it('--require-approved: exit 3 no dry-run (mesma recusa da execução real); sem biblioteca = uso (exit 2)', async () => {
    semearCatalogo();
    await saveProfile({ id: 'curado', name: 'curado' });
    await saveItems('curado', [aprovar(item(1)), item(2)]);
    const f = grava('v.json', ARENA('variation'));
    const r = cli(['vary', '--config', f, '--dry-run', '--budget', '1000', '--require-approved', '--json']);
    expect(r.status).toBe(EXIT.CONFIG);
    expect((JSON.parse(r.stdout) as { error: { code: string } }).error.code).toBe('library.unapproved_items');

    const semLib = grava('sem-lib.json', { ...ARENA('variation'), scenarios: [{ question: 'q', productContext: 'c', reference: 'r' }] });
    const u = cli(['vary', '--config', semLib, '--dry-run', '--budget', '1000', '--require-approved', '--json']);
    expect(u.status).toBe(EXIT.USAGE);
    expect((JSON.parse(u.stdout) as { error: { code: string } }).error.code).toBe('usage.require_approved_without_library');
  });
});
