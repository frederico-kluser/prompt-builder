// IMPL-090 / IMPL-087 (left#7, onda 3) — `library review`: o fluxo de APROVAÇÃO.
//
// Antes não havia comando para aprovar item: `aprovado` só entrava importando o
// item já com estado + contentHash (JSON à mão). Então `--require-approved`, o
// holdout 100% aprovado e a âncora humana do treino (IMPL-065) não tinham
// caminho de uso. Contrato aqui (sem rede):
//   - sem ação = FILA (k de n curados + o que não conta e por quê);
//   - --approve/--reject/--adjust/--reopen amarram a revisão ao contentHash;
//   - tudo ou nada: id ruim/transição ilegal = exit 2, aprovar sem gabarito = 3,
//     e NADA é gravado;
//   - fora de TTY o --reviewer é obrigatório (aprovar é afirmação humana);
//   - aprovado pelo comando satisfaz `--require-approved` e vira âncora.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cmdLibrary } from '../src/cli/commands/library.js';
import { EXIT, resetOutputState, type CliError } from '../src/cli/output.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { getItem, listItems, saveItems, saveProfile } from '../src/library.js';
import {
  computeContentHash,
  isApproved,
  markItemReviewed,
  planItemReviews,
  type LibraryItem,
} from '../src/engine/libraryCore.js';
import { readConfigFile } from '../src/cli/commands/run.js';

const NOW = '2026-09-29T00:00:00.000Z';
const REVISORA = 'Ana Revisora <ana@exemplo.pt>';

function item(i: number, over: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: `item-${String(i).padStart(2, '0')}`,
    title: `item ${i}`,
    tier: 'mft',
    question: `Pergunta ${i}?`,
    productContext: 'Loja ACME: trocas em 30 dias.',
    maxTokens: 200,
    reference: `Resposta ${i}.`,
    origin: 'ai',
    createdAt: NOW,
    ...over,
  } as LibraryItem;
}

let dir = '';
let anterior = '';
let stdout: string[] = [];
let stderr: string[] = [];

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'pb-review-'));
  anterior = getDataDir();
  setDataDir(dir);
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    stdout.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    stderr.push(String(c));
    return true;
  });
  await saveProfile({ id: 'acme', name: 'acme' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setDataDir(anterior);
  rmSync(dir, { recursive: true, force: true });
});

async function review(args: string[]): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; err: CliError }> {
  resetOutputState();
  stdout = [];
  try {
    const code = await cmdLibrary(['review', '--profile', 'acme', ...args, '--data-dir', dir, '--json']);
    expect(code).toBe(EXIT.OK);
    const env = JSON.parse(stdout.filter((c) => c.trimStart().startsWith('{')).pop()!) as { data: Record<string, unknown> };
    return { ok: true, data: env.data };
  } catch (e) {
    return { ok: false, err: e as CliError };
  }
}

function sucesso(r: Awaited<ReturnType<typeof review>>): Record<string, unknown> {
  if (!r.ok) throw new Error(`esperava sucesso: ${r.err.message}`);
  return r.data;
}

function falha(r: Awaited<ReturnType<typeof review>>): CliError {
  if (r.ok) throw new Error('esperava recusa');
  return r.err;
}

describe('library review — fila de curadoria (sem ação)', () => {
  it('lista o que NÃO conta como curado e por quê: sem estado, rejeitado, aprovação velha', async () => {
    const aprovado = markItemReviewed(item(1), { state: 'aprovado', reviewer: REVISORA, now: NOW });
    const velho = { ...markItemReviewed(item(2), { state: 'aprovado', reviewer: REVISORA, now: NOW }), reference: 'mudou' };
    const rejeitado = markItemReviewed(item(3), {
      state: 'rejeitado',
      reviewer: REVISORA,
      rejectReason: { kind: 'duplicado' },
      now: NOW,
    });
    await saveItems('acme', [aprovado, velho as LibraryItem, rejeitado, item(4)]);
    const data = sucesso(await review([]));
    expect(data).toMatchObject({ mode: 'queue', curated: 1, total: 4, curatedKofN: '1 de 4 itens curados' });
    const fila = data.queue as { id: string; issue: string }[];
    expect(fila.map((f) => f.id)).toEqual(['item-02', 'item-03', 'item-04']);
    expect(fila[0].issue).toMatch(/contentHash não bate/);
    expect(fila[1].issue).toBe('estado rejeitado');
    expect(fila[2].issue).toMatch(/sem estado/);
  });
});

describe('library review — aprovação amarrada ao contentHash', () => {
  it('--approve grava estado/revisor/instante/hash do conteúdo atual e o k de n sobe', async () => {
    await saveItems('acme', [item(1), item(2), item(3)]);
    const data = sucesso(await review(['--approve', 'item-01,item-02', '--reviewer', REVISORA]));
    expect(data).toMatchObject({ mode: 'review', reviewer: REVISORA, curated: 2, total: 3 });
    expect(data.reviewed).toEqual([
      { id: 'item-01', from: 'sem_estado', to: 'aprovado', contentHash: computeContentHash(item(1)) },
      { id: 'item-02', from: 'sem_estado', to: 'aprovado', contentHash: computeContentHash(item(2)) },
    ]);
    const gravado = (await getItem('acme', 'item-01'))!;
    expect(gravado).toMatchObject({ state: 'aprovado', reviewer: REVISORA });
    expect(isApproved(gravado)).toBe(true);
    expect((await getItem('acme', 'item-03'))!.state).toBeUndefined();
  });

  it('aprovado pelo comando satisfaz --require-approved e chega à run como âncora (humanApproval)', async () => {
    await saveItems('acme', [item(1), item(2)]);
    const arquivo = path.join(dir, 'arena.json');
    writeFileSync(
      arquivo,
      JSON.stringify({
        format: 'arena-config@1',
        mode: 'variation',
        theme: 'suporte',
        prompt: { text: 'Você é um atendente.' },
        models: { datagen: 'fake/gen', judges: ['fake/judge'], contestant: 'fake/a', reference: 'fake/ref' },
        variation: { techniques: ['persona', 'constraints'] },
        scenarios: { from: 'library', profile: 'acme' },
      }),
    );
    // Antes da revisão: --require-approved recusa (exit 3).
    await expect(readConfigFile(arquivo, {}, { library: { requireApproved: true } })).rejects.toMatchObject({
      code: EXIT.CONFIG,
      errorCode: 'library.unapproved_items',
    });
    sucesso(await review(['--approve', 'item-01,item-02', '--reviewer', REVISORA]));
    const config = await readConfigFile(arquivo, {}, { library: { requireApproved: true } });
    expect(config.customStages?.every((s) => s.humanApproval?.contentHash)).toBe(true);
  });

  it('--reject exige --reason do enum; grava o motivo; --reopen e depois --approve funcionam', async () => {
    await saveItems('acme', [item(1)]);
    expect(falha(await review(['--reject', 'item-01', '--reviewer', REVISORA]))).toMatchObject({
      code: EXIT.USAGE,
      errorCode: 'usage.invalid_flag_value',
    });
    expect(falha(await review(['--reject', 'item-01', '--reason', 'feio', '--reviewer', REVISORA])).code).toBe(EXIT.USAGE);
    sucesso(await review(['--reject', 'item-01', '--reason', 'gabarito_errado', '--note', 'o prazo é 30 dias', '--reviewer', REVISORA]));
    expect((await getItem('acme', 'item-01'))!).toMatchObject({
      state: 'rejeitado',
      rejectReason: { kind: 'gabarito_errado', note: 'o prazo é 30 dias' },
    });
    // rejeitado → aprovado direto é transição ilegal (exit 2, nada gravado).
    const ilegal = falha(await review(['--approve', 'item-01', '--reviewer', REVISORA]));
    expect(ilegal).toMatchObject({ code: EXIT.USAGE, errorCode: 'library.review_invalid' });
    expect(ilegal.message).toMatch(/transição inválida: rejeitado → aprovado/);
    expect((await getItem('acme', 'item-01'))!.state).toBe('rejeitado');
    // O caminho legal: reabrir e aprovar — o motivo da rejeição antiga some.
    sucesso(await review(['--reopen', 'item-01', '--reviewer', REVISORA]));
    sucesso(await review(['--approve', 'item-01', '--reviewer', REVISORA]));
    const final = (await getItem('acme', 'item-01'))!;
    expect(final.state).toBe('aprovado');
    expect(final.rejectReason).toBeUndefined();
  });

  it('tudo ou nada: um id inexistente recusa o lote (exit 2) e NENHUM item é gravado', async () => {
    await saveItems('acme', [item(1)]);
    const e = falha(await review(['--approve', 'item-01,nao-existe', '--reviewer', REVISORA]));
    expect(e).toMatchObject({ code: EXIT.USAGE, errorCode: 'library.review_invalid' });
    expect((e.details as { issues: { id: string; kind: string }[] }).issues).toEqual([
      expect.objectContaining({ id: 'nao-existe', kind: 'not_found' }),
    ]);
    expect((await getItem('acme', 'item-01'))!.state).toBeUndefined();
  });

  it('aprovar item SEM gabarito é conteúdo inválido (exit 3) — aprovar certifica o gabarito', async () => {
    const { reference: _r, ...semGabarito } = item(1);
    void _r;
    await saveItems('acme', [semGabarito as LibraryItem, item(2)]);
    const e = falha(await review(['--approve', 'item-01,item-02', '--reviewer', REVISORA]));
    expect(e).toMatchObject({ code: EXIT.CONFIG, errorCode: 'library.review_invalid_item' });
    expect((await getItem('acme', 'item-02'))!.state).toBeUndefined();
  });

  it('fora de TTY o --reviewer é obrigatório; revisor com quebra de linha é recusado', async () => {
    vi.stubEnv('CI', 'true'); // contexto de agente, mesmo rodando num terminal
    await saveItems('acme', [item(1)]);
    expect(falha(await review(['--approve', 'item-01']))).toMatchObject({
      code: EXIT.USAGE,
      errorCode: 'usage.reviewer_required',
    });
    expect(falha(await review(['--approve', 'item-01', '--reviewer', 'Ana\nOutra: x'])).errorCode).toBe(
      'usage.invalid_flag_value',
    );
    // Flags de ação sem ação, e --reason fora do --reject: uso inválido.
    expect(falha(await review(['--reviewer', REVISORA])).errorCode).toBe('usage.review_without_action');
    expect(falha(await review(['--approve', 'item-01', '--reason', 'duplicado', '--reviewer', REVISORA])).code).toBe(
      EXIT.USAGE,
    );
    expect(falha(await review(['--approve', ''])).errorCode).toBe('usage.missing_flag_value');
    expect((await listItems('acme')).every((i) => i.state === undefined)).toBe(true);
  });
});

describe('planItemReviews (puro)', () => {
  it('id pedido em duas ações é recusado (sem ambiguidade de estado)', () => {
    const plano = planItemReviews(
      [item(1)],
      [
        { ids: ['item-01'], state: 'aprovado' },
        { ids: ['item-01'], state: 'ajustar' },
      ],
      { reviewer: REVISORA, now: NOW },
    );
    expect(plano.issues).toEqual([expect.objectContaining({ id: 'item-01', kind: 'duplicate' })]);
  });

  it('re-aprovar um aprovado VELHO (conteúdo editado fora do fluxo) re-amarra ao conteúdo atual', () => {
    const velho = { ...markItemReviewed(item(1), { state: 'aprovado', reviewer: 'x', now: NOW }), reference: 'nova régua' };
    expect(isApproved(velho as LibraryItem)).toBe(false);
    const plano = planItemReviews([velho as LibraryItem], [{ ids: ['item-01'], state: 'aprovado' }], {
      reviewer: REVISORA,
      now: NOW,
    });
    expect(plano.issues).toEqual([]);
    expect(isApproved(plano.items[0])).toBe(true);
    expect(plano.items[0].reviewer).toBe(REVISORA);
  });
});
