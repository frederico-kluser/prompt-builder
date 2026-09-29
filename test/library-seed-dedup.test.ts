// IMPL-063 (left#4, onda 3) — `library seed --generate` passa pelo MESMO dedup
// da run: o banco atual é ÂNCORA (gerado que repete item existente sai antes
// da reposição e é contado em `droppedVsSeed`), `--semantic-dedup` liga os
// embeddings (mesmo gateway/ledger, papel datagen) e o relatório da geração
// (`datagenReport`) sai no resultado. Antes o seed não passava `scenarioDedup`
// e o relatório ia só para o stderr.
//
// Sem rede: OpenRouter falso servindo chat + /embeddings.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway, type FetchLike } from '../src/openrouter.js';
import { cmdLibrary } from '../src/cli/commands/library.js';
import { EXIT, resetOutputState } from '../src/cli/output.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { listItems, saveItems, saveProfile } from '../src/library.js';
import { DEFAULT_DEDUP_EMBED_MODEL } from '../src/embeddings.js';
import type { LibraryItem } from '../src/engine/libraryCore.js';
import type { DatagenReport } from '../src/datagen.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const CTX_TROCA = 'Loja ACME: trocas em 30 dias.';

const EXISTENTE: LibraryItem = {
  id: 'troca-01',
  title: 'troca',
  tier: 'mft',
  question: 'Como faço para trocar um produto com defeito?',
  productContext: CTX_TROCA,
  maxTokens: 200,
  reference: 'Pelo site, em até 30 dias.',
  origin: 'manual',
  createdAt: '2026-09-01T00:00:00.000Z',
} as LibraryItem;

const cen = (question: string, productContext: string) => ({ question, productContext, maxTokens: 200, rubric: 'Responde a política.' });

/** Lote 0: uma cópia EXATA do item do banco, uma PARÁFRASE dele e um novo. Reposições: novos. */
function lote(n: number): Record<string, unknown>[] {
  if (n === 0) {
    return [
      cen(EXISTENTE.question, CTX_TROCA),
      cen('Quero trocar um item defeituoso, como proceder?', CTX_TROCA),
      cen('Qual o prazo do frete para Manaus?', 'Frete: 10 dias úteis para o Norte.'),
    ];
  }
  return [
    cen(`Posso pagar com boleto na compra ${n}?`, 'Pagamento: cartão ou boleto.'),
    cen(`Vocês emitem nota fiscal no pedido ${n}?`, 'Toda compra sai com NF-e.'),
  ];
}

/** Vetor por TEMA: a paráfrase da troca colide com o item do banco (cosseno 1). */
function vetor(texto: string): number[] {
  if (/trocar/i.test(texto)) return [1, 0, 0, 0];
  if (/Manaus/.test(texto)) return [0, 1, 0, 0];
  if (/boleto/.test(texto)) return [0, 0, 1, 0];
  return [0, 0, 0, 1];
}

function instalar(): { embeddings: string[][] } {
  let nLote = 0;
  const base = fakeOpenRouter({
    catalog: [catalogItem('fake/gen', 1e-6, 2e-6), catalogItem(DEFAULT_DEDUP_EMBED_MODEL, 1e-7, 0)],
    chat: (req) => {
      const usage = { prompt_tokens: 50, completion_tokens: 20, cost: 0.001 };
      if (req.system.includes('gerador de cenarios de benchmark')) {
        return { text: JSON.stringify({ stages: lote(nLote++) }), usage };
      }
      return { text: 'Resposta de referência ideal.', usage };
    },
  });
  const embeddings: string[][] = [];
  const fetch: FetchLike = async (url, init) => {
    if (!new URL(url).pathname.endsWith('/embeddings')) return base.fetch(url, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as { model: string; input: string[] };
    embeddings.push(body.input);
    return new Response(
      JSON.stringify({
        object: 'list',
        data: body.input.map((t, index) => ({ object: 'embedding', index, embedding: vetor(t) })),
        model: body.model,
        usage: { prompt_tokens: 10, total_tokens: 10, cost: 0.00001 },
      }),
      { status: 200 },
    );
  };
  anterior = setDefaultGateway(createGateway({ fetch, sleep: noSleep }));
  return { embeddings };
}

let dir = '';
let dataDirAnterior = '';
let anterior: ReturnType<typeof setDefaultGateway> | undefined;
let stdout: string[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pb-seeddedup-'));
  dataDirAnterior = getDataDir();
  setDataDir(dir);
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    stdout.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await saveProfile({ id: 'acme', name: 'acme' });
  await saveItems('acme', [EXISTENTE]);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
  setDataDir(dataDirAnterior);
  rmSync(dir, { recursive: true, force: true });
});

async function seed(extra: string[]): Promise<Record<string, unknown>> {
  resetOutputState();
  stdout = [];
  const code = await cmdLibrary([
    'seed', '--profile', 'acme', '--generate', '2', '--theme', 'loja', '--model', 'fake/gen',
    '--budget', 'none', '--key', KEY, '--data-dir', dir, '--json', ...extra,
  ]);
  expect(code).toBe(EXIT.OK);
  return (JSON.parse(stdout.filter((c) => c.trimStart().startsWith('{')).pop()!) as { data: Record<string, unknown> }).data;
}

describe('library seed --generate — o banco é âncora do dedup (IMPL-063)', () => {
  it('cópia EXATA de item existente sai antes da reposição e o relatório vai no resultado', async () => {
    const { embeddings } = instalar();
    const data = await seed([]);
    const r = data.datagenReport as DatagenReport;
    expect(r).toMatchObject({ requested: 2, seed: 1, final: 2, shortfall: 0, semantic: false });
    expect(r.dedupedExact).toBe(1);
    expect(r.droppedVsSeed).toBe(1);
    // Sem --semantic-dedup: nenhuma chamada de /embeddings.
    expect(embeddings).toEqual([]);
    const perguntas = (await listItems('acme')).map((i) => i.question);
    expect(perguntas.filter((q) => q === EXISTENTE.question)).toHaveLength(1);
  });

  it('--semantic-dedup: a PARÁFRASE do item existente também sai (cosseno), com custo medido', async () => {
    const { embeddings } = instalar();
    const data = await seed(['--semantic-dedup']);
    const r = data.datagenReport as DatagenReport;
    expect(r.semantic).toBe(true);
    expect(r.embedModelId).toBe(DEFAULT_DEDUP_EMBED_MODEL);
    expect(r.dedupedSemantic).toBeGreaterThanOrEqual(1);
    expect(r.droppedVsSeed).toBe(2);
    expect(embeddings.length).toBeGreaterThan(0);
    const perguntas = (await listItems('acme')).map((i) => i.question);
    expect(perguntas).not.toContain('Quero trocar um item defeituoso, como proceder?');
    // Embeddings entram no MESMO ledger (papel datagen), nunca "custou zero".
    expect(((data.byRole as Record<string, { usd: number }>).datagen?.usd ?? 0)).toBeGreaterThan(0);
  });
});
