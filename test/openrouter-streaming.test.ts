// IMPL-072 (R-07a:REC-1) — streaming obrigatório nos papéis de avaliação.
//
// ~98,7% do gasto passava por `chatCompletion` NÃO-streaming (juiz, duelo,
// gabarito, datagen, reescritor): em abort/timeout o provedor continua
// processando e cobra a resposta inteira (efeito 0% vs ~100% do custo). O
// gateway ganhou transporte SSE unificado (`streamTransport`) que TODOS os
// papéis podem ligar sem mudar de API; o parser SSE é o MESMO de
// `chatCompletionStream` (parser unificado) e o frame final de usage é tratado
// defensivamente (o OpenRouter emite chunk extra de usage antes do [DONE] e
// keep-alives depois dele já derrubaram clientes).
// Contratos aqui (tudo com transporte falso, zero rede):
//   (i)   100% dos papéis em streaming (stream: true no fio) com response_format
//         preservado e resultado íntegro;
//   (ii)  fumaça com juiz/duelo/gabarito completos — vereditos preservados;
//   (iii) abort no meio do stream => CONTROLE (não erro), pendente pelo id e
//         SEM reenvio — custo anotado < resposta completa no /generation;
//   (iv)  conciliação do abort injetado fecha em <= 1% (settlePending).

import { afterEach, describe, expect, it } from 'vitest';
import {
  createGateway,
  setDefaultGateway,
  type FetchLike,
  type OpenRouterGateway,
} from '../src/openrouter.js';
import { BudgetLedger, isControlSignal } from '../src/budget.js';
import { generateReferences } from '../src/gabarito.js';
import { judgeStageReference } from '../src/refJudge.js';
import { judgeStage } from '../src/judge.js';
import { runStageDuels } from '../src/duels.js';
import { generateStage } from '../src/datagen.js';
import { llmReflectLessons } from '../src/variator.js';
import { runCompetitor } from '../src/competitor.js';
import { COST_ROLES, type Contestant, type CompetitorResponse, type StageSpec } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeChatReply, type FakeRequest } from './fakeOpenRouter.js';
import { canaryOf, duelReply, listwiseReply, pointwiseReply } from './judgeReplies.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

const STAGE: StageSpec = {
  question: 'Qual o prazo de troca?',
  productContext: 'Trocas em até 30 dias com nota fiscal.',
  maxTokens: 300,
  reference: 'O prazo de troca é de 30 dias, com nota fiscal.',
};
const CONTESTANTS: Contestant[] = [
  { id: 'v0', label: 'Original (controle)', modelId: 'fake/m', isOriginal: true },
  { id: 'v1', label: 'Variante', modelId: 'fake/m' },
];
const resposta = (contestantId: string, text: string): CompetitorResponse => ({
  contestantId,
  modelId: 'fake/m',
  text,
  latencyMs: 1,
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
  status: 'ok',
});
const RESPOSTAS = [resposta('v0', 'Você tem 30 dias para trocar.'), resposta('v1', 'Trocas em 30 dias, com nota.')];

const CATALOGO = ['fake/gen', 'fake/ref', 'fake/judge', 'fake/m', 'fake/opt'].map((id) => catalogItem(id, 1e-9, 1e-9));

/**
 * Roteamento por MODELO e marcadores (aqui TUDO é stream, então `req.stream`
 * não discrimina papel): canário do IMPL-006 em todo veredito.
 */
function replyPorPapel(req: FakeRequest): FakeChatReply {
  if (req.model === 'fake/gen') {
    const st = { question: STAGE.question, productContext: STAGE.productContext, maxTokens: STAGE.maxTokens };
    return { text: JSON.stringify({ ...st, stages: [st] }), finishReason: 'stop' };
  }
  if (req.model === 'fake/ref') return { text: `Gabarito: ${STAGE.reference}`, finishReason: 'stop' };
  if (/duelo/i.test(req.system)) return { text: duelReply(req, 'A', 'A mais completa'), finishReason: 'stop' };
  const rotulos = /ordene TODOS estes rotulos da melhor para a pior[^:]*: (\[[^\]]*\])/.exec(req.user)?.[1];
  if (rotulos) {
    const labels = JSON.parse(rotulos) as string[];
    return {
      text: listwiseReply(req, labels, labels.map((label) => ({ label, justificativa: 'confere', veredito: 'resolve' }))),
      finishReason: 'stop',
    };
  }
  if (!canaryOf(req)) {
    return {
      text: JSON.stringify({
        rubrica: { resultado: 'cumpre', escopo: 'no_escopo', burla: 'nao_detectada', manipulacao: 'nao_detectada' },
        verdict: 'resolve',
        explanation: 'confere com a referência',
      }),
      finishReason: 'stop',
    };
  }
  return { text: pointwiseReply(req, 'resolve', 'confere com a referência'), finishReason: 'stop' };
}

let anterior: OpenRouterGateway | undefined;
afterEach(() => {
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
});

describe('IMPL-072 (i) — 100% dos papéis em transporte streaming', () => {
  it('todo papel sai com stream:true no fio, texto íntegro e response_format preservado', async () => {
    const fake = fakeOpenRouter({
      catalog: CATALOGO,
      chat: (req) => ({ text: JSON.stringify({ veredito: 'ok', papel: req.model }), finishReason: 'stop' }),
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep, streamTransport: true });
    for (const role of COST_ROLES) {
      const r = await gw.chatCompletion({
        apiKey: KEY,
        modelId: 'fake/judge',
        messages: [{ role: 'user', content: `papel ${role}` }],
        role,
        responseFormatJson: true,
      });
      expect(r.text).toContain('veredito');
    }
    const chats = fake.chatRequests();
    expect(chats).toHaveLength(COST_ROLES.length);
    for (const c of chats) {
      expect(c.stream, `papel sem stream: ${String(c.body?.model)}`).toBe(true);
      // Mantém response_format JSON nos papéis de avaliação (o parser é SSE,
      // o formato de saída pedido continua json_object).
      expect(c.body?.response_format).toEqual({ type: 'json_object' });
    }
  });

  it('frame final de usage é capturado mesmo com keep-alives DEPOIS dele', async () => {
    const fake = fakeOpenRouter({
      chat: () => ({
        text: 'resposta parcial',
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0042 },
        // Chunks extras depois do frame de usage: keep-alive, delta vazio e lixo.
        trailing: [': keep-alive', JSON.stringify({ choices: [{ delta: { content: '' } }] }), 'frame-invalido'],
      }),
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep, streamTransport: true });
    const r = await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: [{ role: 'user', content: 'oi' }] });
    expect(r.text).toBe('resposta parcial');
    expect(r.cost).toMatchObject({ usd: 0.0042, source: 'usage' });
  });
});

describe('IMPL-072 (ii) — fumaça juiz/duelo/gabarito em streaming sem perda de veredito', () => {
  it('gabarito → juiz por referência → listwise → duelo completam com vereditos corretos', async () => {
    const fake = fakeOpenRouter({ catalog: CATALOGO, chat: (req) => replyPorPapel(req) });
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep, streamTransport: true }));
    try {
      const refs = await generateReferences({ stages: [{ ...STAGE, reference: undefined }], apiKey: KEY, modelId: 'fake/ref' });
      expect(refs[0]?.reference).toContain('30 dias');

      const refJudge = await judgeStageReference({
        stage: STAGE,
        responses: RESPOSTAS,
        contestants: CONTESTANTS,
        judgeModelIds: ['fake/judge'],
        apiKey: KEY,
      });
      expect(refJudge.verdictByContestant).toEqual({ v0: 'resolve', v1: 'resolve' });

      const listwise = await judgeStage({
        apiKey: KEY,
        stage: STAGE,
        responses: RESPOSTAS,
        judgeModelIds: ['fake/judge'],
      });
      expect(listwise.rankedContestantIds.length).toBeGreaterThan(0);

      const duels = await runStageDuels({
        stage: STAGE,
        responses: RESPOSTAS,
        contestants: CONTESTANTS,
        judgeModelId: 'fake/judge',
        topK: 0,
        duelists: ['v0', 'v1'],
        apiKey: KEY,
      });
      expect(duels.duels.length).toBeGreaterThan(0);

      const gen = await generateStage({ apiKey: KEY, theme: 'suporte', stageIndex: 0, totalStages: 1, modelId: 'fake/gen' });
      expect(gen.question).toBeTruthy();

      const licoes = await llmReflectLessons({ apiKey: KEY, modelId: 'fake/opt', baseLessons: '- errou prazos' });
      expect(typeof licoes).toBe('string');

      const comp = await runCompetitor({ apiKey: KEY, contestantId: 'v0', modelId: 'fake/m', stage: STAGE });
      expect(comp.status).toBe('ok');

      // (i) 100% dos papéis do pipeline em streaming: nenhum chat sem stream.
      const chats = fake.chatRequests();
      expect(chats.length).toBeGreaterThan(4);
      for (const c of chats) expect(c.stream, `chamada não-streaming do papel ${c.model}`).toBe(true);
    } finally {
      setDefaultGateway(anterior);
      anterior = undefined;
    }
  });
});

describe('IMPL-072 (iii/iv) — abort no meio do stream: controle, sem reenvio, custo parcial', () => {
  /** Stream que emite UM chunk (com id de geração) e fica mudo até o abort. */
  const corteComId = (id: string): FetchLike => {
    return async (_url, init) => {
      const signal = init?.signal;
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const enc = new TextEncoder();
      const corpo = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(
            enc.encode(`data: ${JSON.stringify({ id, choices: [{ delta: { content: 'meia resposta' } }] })}\n\n`),
          );
          // nunca mais emite; o abort do gateway corta a leitura de verdade
          signal?.addEventListener('abort', () => ctrl.error(signal.reason), { once: true });
        },
      });
      return new Response(corpo, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
  };

  /** Roteador falso: chat cortado + GET /generation simulado (a "fatura"). */
  const transporte = (
    cutId: string,
    generation: Record<string, unknown>,
    counters: { posts: number },
  ): FetchLike => {
    const base = corteComId(cutId);
    return async (url, init) => {
      const u = String(url);
      if (u.includes('/generation')) {
        return new Response(JSON.stringify({ data: generation }), { status: 200 });
      }
      if (u.endsWith('/chat/completions')) {
        counters.posts += 1;
        return base(url, init);
      }
      return new Response('{}', { status: 200 });
    };
  };

  it('abort mid-stream vira CONTROLE, pendente pelo id e SEM novo POST', async () => {
    const cont = { posts: 0 };
    const gw = createGateway({
      fetch: transporte('gen-abort-1', { provider_name: 'OpenAI', upstream_id: 'up-1', total_cost: 0.002, cancelled: true }, cont),
      sleep: noSleep,
      streamTransport: true,
    });
    const ledger = new BudgetLedger({ budgetUsd: 1, estimateCall: () => 0.05 });
    const ctl = new AbortController();
    const p = gw.chatCompletion({
      apiKey: KEY,
      modelId: 'x/y',
      messages: [{ role: 'user', content: 'oi' }],
      role: 'judge',
      timeoutMs: 5_000,
      sink: ledger,
      signal: ctl.signal,
    });
    await new Promise((r) => setTimeout(r, 15));
    ctl.abort(new Error('cancelado pelo usuário'));
    const err = await p.catch((e: unknown) => e);
    // Controle, não erro: sem isto o papel degradaria em nota inventada.
    expect(isControlSignal(err)).toBe(true);
    expect(cont.posts).toBe(1); // SEM reenvio depois do corte

    // A reserva vira PENDENTE pelo id (nunca zero, nunca gasto cheio).
    const pendentes = ledger.pendingEntries();
    expect(pendentes).toHaveLength(1);
    expect(pendentes[0].generationId).toBe('gen-abort-1');
    expect(ledger.spentUsd).toBe(0); // nada lançado como gasto ainda

    // O /generation do provedor mostra a geração cancelada e o custo PARCIAL.
    const geracao = await gw.fetchGenerationInfo(KEY, 'gen-abort-1');
    expect(geracao?.cancelled).toBe(true);
    expect(geracao?.totalCostUsd).toBe(0.002);
    expect(geracao?.provider).toMatchObject({ name: 'OpenAI', upstreamId: 'up-1' });

    // (iv) conciliação: o anotado bate com o /generation em <= 1%.
    expect(ledger.settlePending('gen-abort-1', { usd: geracao!.totalCostUsd!, source: 'usage' })).toBe(true);
    expect(ledger.pendingUsd).toBe(0);
    expect(Math.abs(ledger.spentUsd - 0.002) / 0.002).toBeLessThanOrEqual(0.01);
    // Custo anotado < resposta completa (a reserva de 0.05 nunca virou gasto).
    expect(ledger.spentUsd).toBeLessThan(0.05);
    expect(cont.posts).toBe(1); // conciliar também não reenvia
  });

  it('timeout no meio do stream também é pendente sem reenvio (o provedor pode ter cobrado)', async () => {
    const cont = { posts: 0 };
    const gw = createGateway({
      fetch: transporte('gen-abort-2', { provider_name: 'OpenAI', total_cost: 0.001, cancelled: true }, cont),
      sleep: noSleep,
      streamTransport: true,
    });
    const ledger = new BudgetLedger({ budgetUsd: 1, estimateCall: () => 0.05 });
    const params = {
      apiKey: KEY,
      modelId: 'x/y',
      messages: [{ role: 'user' as const, content: 'oi' }],
      role: 'judge' as const,
      idleTimeoutMs: 25,
      timeoutMs: 2_000,
      sink: ledger,
    };
    await expect(gw.chatCompletion(params)).rejects.toThrow(/timeout/i);
    expect(cont.posts).toBe(1);
    expect(ledger.pendingEntries()[0]?.generationId).toBe('gen-abort-2');
    // Reenvio do MESMO corpo é recusado sem tocar a rede (guarda IMPL-073).
    await expect(gw.chatCompletion(params)).rejects.toThrow();
    expect(cont.posts).toBe(1);
    expect(ledger.pendingEntries()).toHaveLength(1);
  });
});
