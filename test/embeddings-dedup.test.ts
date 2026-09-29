// IMPL-063 (restante) — embedder de PRODUÇÃO do dedup semântico de cenários.
//
// Antes a camada semântica do dedup existia, mas nenhum `EmbedFn` real: o
// caminho de produção nunca passava `dedup.embed` e a recuperação de paráfrase
// em run real era 0. Contratos aqui (transporte falso, zero rede):
//   (1) `createOpenRouterEmbedder` chama POST /embeddings pelo MESMO gateway do
//       chat: cascata de dado pessoal no `input`, retry/limitador de
//       `guardedFetch` (429 → re-tenta), custo MEDIDO por `usage.cost` no
//       ledger com o papel 'datagen' e, sem usage, pendente — nunca zero;
//   (2) `generateStages` com `scenarioDedup.semantic` usa o embedder e funde a
//       paráfrase (relatório: semantic + embedModelId + descartes semânticos);
//   (3) embedder que falha degrada para a passe exata (com registro); 402 é
//       FATAL (cli#3) e sobe;
//   (4) a RUN (Node e SPA) repassa `config.scenarioDedup` ao datagen: o custo
//       do /embeddings entra no ledger da run no papel datagen;
//   (5) o veto do IMPL-116 (reuso de VEREDITO por parecença) segue verde — o
//       embedder mora fora do caminho de avaliação (o arch test roda à parte).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway, type FetchLike, type OpenRouterGateway } from '../src/openrouter.js';
import { BudgetLedger } from '../src/budget.js';
import {
  createOpenRouterEmbedder,
  DEFAULT_DEDUP_EMBED_MODEL,
  parseEmbeddingsPayload,
} from '../src/embeddings.js';
import { generateStages, type DatagenReport } from '../src/datagen.js';
import { setDataDir, getDataDir } from '../src/storage.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import type { RunConfig, RunRecord } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeRequest } from './fakeOpenRouter.js';
import { pointwiseReply } from './judgeReplies.js';

vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const EMB = DEFAULT_DEDUP_EMBED_MODEL;
const CUSTO_EMB = 0.00002;

interface PedidoEmb {
  model: string;
  input: string[];
}

/**
 * Serve POST /embeddings sobre o fake do chat. `vetor(texto)` decide a
 * representação; `resposta` sobrescreve o status/corpo (429, 402, sem usage…).
 */
function comEmbeddings(
  base: FetchLike,
  vetor: (texto: string) => number[],
  resposta?: (n: number) => { status?: number; body?: unknown; semUsage?: boolean } | undefined,
): { fetch: FetchLike; pedidos: PedidoEmb[] } {
  const pedidos: PedidoEmb[] = [];
  let n = 0;
  const fetch: FetchLike = async (url, init) => {
    if (!new URL(url).pathname.endsWith('/embeddings')) return base(url, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as PedidoEmb;
    pedidos.push(body);
    const custom = resposta?.(n++);
    if (custom?.status && custom.status !== 200) {
      return new Response(JSON.stringify(custom.body ?? { error: { message: 'x' } }), { status: custom.status });
    }
    const json = {
      id: `gen-emb-${n}`,
      object: 'list',
      // Ordem INVERTIDA de propósito: o parser tem de usar `index`.
      data: body.input.map((t, index) => ({ object: 'embedding', index, embedding: vetor(t) })).reverse(),
      model: body.model,
      ...(custom?.semUsage ? {} : { usage: { prompt_tokens: 12 * body.input.length, total_tokens: 12 * body.input.length, cost: CUSTO_EMB } }),
    };
    return new Response(JSON.stringify(json), { status: 200 });
  };
  return { fetch, pedidos };
}

let anterior: OpenRouterGateway | undefined;
function instalar(fetch: FetchLike): OpenRouterGateway {
  const gw = createGateway({ fetch, sleep: noSleep });
  anterior = setDefaultGateway(gw);
  return gw;
}
afterEach(() => {
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
});

const CATALOGO = ['fake/gen', 'fake/judge', 'fake/a', 'fake/b', EMB].map((id) => catalogItem(id, 1e-6, 1e-6));

describe('IMPL-063 (1) — createOpenRouterEmbedder: mesmo gateway, mesmo ledger', () => {
  it('POST /embeddings com PII pseudonimizada, 429 re-tentado, custo MEDIDO no papel datagen', async () => {
    const base = fakeOpenRouter({ catalog: CATALOGO });
    const emb = comEmbeddings(base.fetch, (t) => [t.length, 1, 0], (n) => (n === 0 ? { status: 429 } : undefined));
    const gw = instalar(emb.fetch);
    await gw.listModels(KEY);
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    const embed = createOpenRouterEmbedder({ apiKey: KEY, ctx: { sink: ledger } });
    const vetores = await embed(['Meu CPF é 529.982.247-25, cadê o pedido?', 'Outra pergunta']);
    expect(vetores).toHaveLength(2);
    // `index` respeitado (a resposta veio invertida).
    expect(vetores[1][0]).toBe('Outra pergunta'.length);
    // 429 → o retry do gateway refez o MESMO pedido.
    expect(emb.pedidos).toHaveLength(2);
    expect(emb.pedidos[1].model).toBe(EMB);
    // LGPD (IMPL-042): o CPF real NUNCA sai no fio.
    expect(JSON.stringify(emb.pedidos)).not.toContain('529.982.247-25');
    // Custo medido (usage.cost) no ledger, papel datagen.
    expect(ledger.byRole.datagen.calls).toBe(1);
    expect(ledger.byRole.datagen.usd).toBeCloseTo(CUSTO_EMB, 12);
    expect(ledger.spentUsd).toBeCloseTo(CUSTO_EMB, 12);
    expect(ledger.accuracy.exact).toBe(1);
    expect(gw.currentConcurrency().active).toBe(0);
  });

  it('200 sem usage: pendente/conservador — nunca "custou zero"', async () => {
    const base = fakeOpenRouter({ catalog: CATALOGO });
    const emb = comEmbeddings(base.fetch, () => [1, 0], () => ({ semUsage: true }));
    const gw = instalar(emb.fetch);
    await gw.listModels(KEY);
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    await createOpenRouterEmbedder({ apiKey: KEY, ctx: { sink: ledger } })(['a', 'b']);
    // Com o id da geração: PENDENTE (conciliável pela fatura), fora do "zero".
    expect(ledger.committedUsd).toBeGreaterThan(0);
    expect(ledger.pendingUsd).toBeGreaterThan(0);
    expect(ledger.pendingEntries()).toMatchObject([{ role: 'datagen', reason: 'no_usage', generationId: 'gen-emb-1' }]);
  });

  it('lotes respeitam o tamanho; resposta incompleta é erro (nunca vetor inventado)', async () => {
    expect(() => parseEmbeddingsPayload({ data: [{ index: 0, embedding: [1] }] }, 2)).toThrow(/incompleta/);
    expect(() => parseEmbeddingsPayload({ data: [{ index: 0, embedding: ['x'] }] }, 1)).toThrow(/inválido/);
    const base = fakeOpenRouter({ catalog: CATALOGO });
    const emb = comEmbeddings(base.fetch, () => [1, 0]);
    instalar(emb.fetch);
    const out = await createOpenRouterEmbedder({ apiKey: KEY, batchSize: 2 })(['a', 'b', 'c', 'd', 'e']);
    expect(out).toHaveLength(5);
    expect(emb.pedidos.map((p) => p.input.length)).toEqual([2, 2, 1]);
  });
});

// ---------------------------------------------------------------------------
// (2)/(3) — generateStages com o embedder de produção.
// ---------------------------------------------------------------------------

const PARAFRASE_A = { question: 'Como faço para trocar um produto com defeito?', productContext: 'Trocas em 30 dias.', maxTokens: 200 };
const PARAFRASE_B = { question: 'De que forma eu troco um item que veio com defeito?', productContext: 'Trocas em 30 dias.', maxTokens: 200 };
const OUTRO = { question: 'Qual o prazo de entrega para Manaus?', productContext: 'Entrega em 10 dias úteis.', maxTokens: 200 };

/** Paráfrases de troca → o mesmo vetor; entrega → ortogonal. */
const vetorTema = (t: string): number[] => (/troc/i.test(t) ? [1, 0, 0] : [0, 1, 0]);

describe('IMPL-063 (2)/(3) — generateStages com scenarioDedup.semantic', () => {
  it('funde a paráfrase pelo /embeddings (sem vetor injetado) e registra no relatório', async () => {
    const base = fakeOpenRouter({
      catalog: CATALOGO,
      chat: () => ({ text: JSON.stringify({ stages: [PARAFRASE_A, PARAFRASE_B, OUTRO] }) }),
    });
    const emb = comEmbeddings(base.fetch, vetorTema);
    instalar(emb.fetch);
    let rel: DatagenReport | undefined;
    const out = await generateStages({
      apiKey: KEY,
      theme: 'trocas',
      count: 2,
      modelId: 'fake/gen',
      scenarioDedup: { semantic: true },
      maxBackfillRounds: 0,
      onReport: (r) => (rel = r),
    });
    expect(emb.pedidos.length).toBeGreaterThan(0);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.question)).toContain(OUTRO.question);
    expect(rel).toMatchObject({ semantic: true, embedModelId: EMB, dedupedSemantic: 1 });
    expect(rel!.semanticError).toBeUndefined();
  });

  it('sem a opção: nenhuma chamada de /embeddings (o comportamento de antes)', async () => {
    const base = fakeOpenRouter({
      catalog: CATALOGO,
      chat: () => ({ text: JSON.stringify({ stages: [PARAFRASE_A, PARAFRASE_B] }) }),
    });
    const emb = comEmbeddings(base.fetch, vetorTema);
    instalar(emb.fetch);
    const out = await generateStages({ apiKey: KEY, theme: 'trocas', count: 2, modelId: 'fake/gen', maxBackfillRounds: 0 });
    expect(emb.pedidos).toHaveLength(0);
    expect(out).toHaveLength(2);
  });

  it('embedder falha (500 esgotado): degrada para a passe exata, com registro — nunca derruba', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const base = fakeOpenRouter({
        catalog: CATALOGO,
        chat: () => ({ text: JSON.stringify({ stages: [PARAFRASE_A, PARAFRASE_B] }) }),
      });
      const emb = comEmbeddings(base.fetch, vetorTema, () => ({ status: 500 }));
      instalar(emb.fetch);
      let rel: DatagenReport | undefined;
      const out = await generateStages({
        apiKey: KEY,
        theme: 'trocas',
        count: 2,
        modelId: 'fake/gen',
        scenarioDedup: { semantic: true },
        maxBackfillRounds: 0,
        onReport: (r) => (rel = r),
      });
      expect(out).toHaveLength(2);
      expect(rel!.semantic).toBe(false);
      expect(rel!.semanticError).toMatch(/HTTP 500|500/);
    } finally {
      warn.mockRestore();
    }
  });

  it('402 no /embeddings é FATAL (cli#3): sobe em vez de degradar', async () => {
    const base = fakeOpenRouter({
      catalog: CATALOGO,
      chat: () => ({ text: JSON.stringify({ stages: [PARAFRASE_A, PARAFRASE_B] }) }),
    });
    const emb = comEmbeddings(base.fetch, vetorTema, () => ({ status: 402, body: { error: { message: 'Insufficient credits' } } }));
    instalar(emb.fetch);
    await expect(
      generateStages({ apiKey: KEY, theme: 'trocas', count: 2, modelId: 'fake/gen', scenarioDedup: { semantic: true }, maxBackfillRounds: 0 }),
    ).rejects.toMatchObject({ gatewayError: 'no_credit' });
  });
});

// ---------------------------------------------------------------------------
// (4) — a RUN repassa a opção ao datagen, nos dois motores.
// ---------------------------------------------------------------------------

describe('IMPL-063 (4) — config.scenarioDedup chega ao datagen da run (Node e SPA)', () => {
  let tmp: string;
  let dirAnterior: string;
  let mudos: Array<{ mockRestore(): void }> = [];
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl063-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    mudos = (['log', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
  });
  afterAll(() => {
    mudos.forEach((m) => m.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  const chat = (req: FakeRequest) => {
    if (req.model === 'fake/gen') return { text: JSON.stringify({ stages: [PARAFRASE_A, PARAFRASE_B, OUTRO] }) };
    if (req.model === 'fake/judge') return { text: pointwiseReply(req, 'resolve') };
    return { text: `Resposta de ${req.model}` };
  };

  for (const [motor, run] of [
    ['Node', runNode],
    ['SPA', runWeb],
  ] as const) {
    it(`${motor}: /embeddings chamado, paráfrase fundida e custo no papel datagen`, async () => {
      const base = fakeOpenRouter({ catalog: CATALOGO, chat });
      const emb = comEmbeddings(base.fetch, vetorTema);
      instalar(emb.fetch);
      const cfg = {
        mode: 'compare',
        theme: 'trocas',
        stages: 2,
        datagenModelId: 'fake/gen',
        judgeModelIds: ['fake/judge'],
        referenceJudging: false,
        competitorModelIds: ['fake/a', 'fake/b'],
        finalists: 0,
        timeoutMs: 5_000,
        scenarioDedup: { semantic: true },
      } as unknown as RunConfig;
      const rec = (await run(cfg as never, KEY, { runId: `impl063-${motor}` } as never)) as RunRecord;
      expect(emb.pedidos.length).toBeGreaterThan(0);
      expect(rec.datagenReport).toMatchObject({ semantic: true, embedModelId: EMB, final: 2 });
      expect(rec.datagenReport!.dedupedSemantic).toBeGreaterThanOrEqual(1);
      // O custo do /embeddings entrou no ledger da run (papel datagen).
      expect(rec.costByRole?.datagen?.usd ?? 0).toBeGreaterThanOrEqual(CUSTO_EMB);
    });
  }
});
