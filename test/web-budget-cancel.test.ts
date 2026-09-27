// IMPL-020 (R-10:REC-3) — a SPA respeita o teto de gasto e pode ser cancelada.
//
// Antes: `budgetUsd` aparecia ZERO vezes em web/src, o trainer admitia "sem
// budget ledger no browser" e nenhum chamador passava AbortSignal — a run só
// parava fechando a aba. Estes testes provam, com transporte FALSO (zero rede,
// zero gasto real), os critérios de aceite:
//   (i)   teto menor que a estimativa => `aborted` + stoppedReason 'budget',
//         parcial honesto (etapas cortadas `incomplete`, sem nota inventada);
//   (ii)  Cancelar aborta as chamadas em voo e NENHUMA chamada nova começa
//         depois do clique (chamadas de 30 s simuladas);
//   (iii) estimativa > US$ 1 exige confirmação com faixa e drivers;
//   (iv)  o ledger é o de src/budget.ts (ver também test/engine-sync.test.ts).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGateway,
  setDefaultGateway,
  type FetchLike,
  type OpenRouterGateway,
} from '../src/openrouter.js';
import { isControlSignal, RunCancelled, toControlSignal, BudgetExceeded } from '../src/budget.js';
import {
  COST_CONFIRM_THRESHOLD_USD,
  costConfirmationReason,
  estimateLaunchCost,
  requiresCostConfirmation,
} from '../src/engine/costConfirmation.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { prepareOptsFor } from '../src/prepareRun.js';
import { subscribe as subscribeNodeRun } from '../src/events.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion as runWeb, cancelRun, isRunCancellable } from '../web/src/engine/orchestrator.js';
import {
  startTraining as startWebTraining,
  cancelTraining,
  variationConfigFrom as webVariationConfigFrom,
} from '../web/src/engine/trainer.js';
import { subscribeRun, subscribeSession } from '../web/src/engine/events.js';
import { normalizeRunRecord } from '../web/src/engine/normalize.js';
import type { RunEvent, RunRecord, SessionRecord } from '../web/src/engine/types.js';
import type { OpenRouterModel, RunConfig } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter } from './fakeOpenRouter.js';
import { expectPipelineDone } from './runOutcome.js';
import { duelReply, pointwiseReply } from './judgeReplies.js';

// O storage do web é IndexedDB — fora do navegador, um no-op em memória.
vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

const CENARIOS = [
  {
    question: 'Qual o prazo para trocar um tenis comprado na loja online?',
    productContext: 'Politica de trocas: 30 dias corridos a partir do recebimento, com nota fiscal.',
    maxTokens: 300,
    rubric: 'Deve citar 30 dias e a nota fiscal.',
  },
  {
    question: 'Explique como calcular juros compostos de um investimento mensal em renda fixa.',
    productContext: 'Voce e um assistente financeiro. Formula: M = C (1 + i)^n.',
    maxTokens: 400,
    rubric: 'Deve apresentar a formula M = C(1+i)^n corretamente.',
  },
];

// Treino que PROMOVE precisa de n suficiente: desde o gate da melhor de K
// (IMPL-002, max-T exato) 2 pares nunca chegam a p <= 0,05 (piso 2^-n), e sem
// promoção a sessão converge na rodada 0. Com 6 pares unânimes, p = 2^-6.
const CENARIOS_TREINO = [
  ...CENARIOS,
  {
    question: 'Como cancelo a assinatura mensal do aplicativo de musica sem pagar multa?',
    productContext: 'Assinatura mensal sem fidelidade: cancelamento pelo app, efetivo no fim do ciclo pago.',
    maxTokens: 300,
    rubric: 'Deve dizer que nao ha multa e que vale no fim do ciclo.',
  },
  {
    question: 'Minha geladeira nova chegou com a porta amassada, o que devo fazer?',
    productContext: 'Avaria no transporte: recusar ou abrir chamado em ate 7 dias com fotos da embalagem.',
    maxTokens: 300,
    rubric: 'Deve citar 7 dias e as fotos.',
  },
  {
    question: 'Quais documentos preciso levar para retirar um pedido na agencia dos Correios?',
    productContext: 'Retirada em agencia: documento oficial com foto e codigo de rastreio do objeto.',
    maxTokens: 300,
    rubric: 'Deve citar documento com foto e codigo de rastreio.',
  },
  {
    question: 'Posso parcelar a compra de um notebook no boleto bancario?',
    productContext: 'Boleto: somente a vista, com 5% de desconto; parcelamento so no cartao em ate 10x.',
    maxTokens: 300,
    rubric: 'Deve dizer que boleto e so a vista e citar o cartao em 10x.',
  },
];

const MODELOS = ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b', 'fake/opt'];

interface PipelineOpts {
  /** Preço de catálogo (USD/token) por modelo — base das ESTIMATIVAS. */
  price?: (modelId: string) => number;
  /** `usage.cost` servido (a "fatura") por chamada. */
  cost?: (modelId: string, n: number) => number;
  /** Juiz reprova a resposta do prompt base (força promoção no treino). */
  harshOnBase?: boolean;
  /** Cenários que o datagen devolve (default: os 2 de {@link CENARIOS}). */
  cenarios?: readonly (typeof CENARIOS)[number][];
}

/** Pipeline falso completo: datagen → gabarito → competidores (stream) → juiz → duelos. */
function fakePipeline(opts: PipelineOpts = {}): FakeOpenRouter {
  const price = opts.price ?? (() => 1e-9);
  const cost = opts.cost ?? ((_m: string, n: number) => Number((0.0001 * (n + 1)).toFixed(6)));
  return fakeOpenRouter({
    catalog: MODELOS.map((id) => catalogItem(id, price(id), price(id))),
    chat: (req, n) => {
      const usage = { prompt_tokens: 100, completion_tokens: 20, cost: cost(req.model, n) };
      if (req.model === 'fake/gen') return { text: JSON.stringify({ stages: opts.cenarios ?? CENARIOS }), usage };
      if (req.model === 'fake/opt') {
        const tecnica = /tecnica id="([^"]+)"/.exec(req.user)?.[1] ?? 'x';
        return {
          text: `Voce e um atendente cordial e preciso (${tecnica}). Responda sempre com base no contexto do produto, cite prazos e regras exatamente como aparecem e recuse o que estiver fora do escopo.`,
          usage,
        };
      }
      if (req.model === 'fake/ref') return { text: `Gabarito: ${req.user.slice(0, 40)}`, usage };
      // Variante reescrita (traz a técnica no prompt) responde BEM; o prompt
      // base, MAL — assim o treino promove na rodada 0 em vez de convergir.
      if (req.stream) {
        const boa = /\((persona|constraints)\)/.test(req.system);
        return { text: `Resposta ${boa ? 'boa' : 'fraca'} de ${req.model}`, usage };
      }
      if (req.system.includes('DUELO')) return { text: duelReply(req, 'A', 'A melhor'), usage };
      if (opts.harshOnBase && req.user.includes('Resposta fraca')) {
        return { text: pointwiseReply(req, 'nao', 'nao resolve'), usage };
      }
      return { text: pointwiseReply(req, 'resolve', 'confere'), usage };
    },
  });
}

const COMPARE = {
  mode: 'compare',
  theme: 'suporte ao cliente',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  finalists: 2,
  timeoutMs: 60_000,
} as const;

const TRAINING = {
  mode: 'training',
  theme: 'suporte ao cliente',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  contestantModelId: 'fake/a',
  basePrompt: 'Voce e um atendente de suporte. Responda com base no contexto do produto.',
  techniqueIds: ['persona', 'constraints'],
  promptOptimization: true,
  optimizerModelId: 'fake/opt',
  iterations: 2,
  holdoutRatio: 0,
  finalists: 2,
  timeoutMs: 60_000,
} as const;

// Variation standalone: as variantes nascem no `prepare` (reescritor), DEPOIS
// de o motor montar a estimativa inicial — é o caso que a revisão pegou.
const VARIATION = {
  mode: 'variation',
  theme: 'suporte ao cliente',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  contestantModelId: 'fake/a',
  basePrompt: 'Voce e um atendente de suporte. Responda com base no contexto do produto.',
  techniqueIds: ['persona', 'constraints'],
  promptOptimization: true,
  optimizerModelId: 'fake/opt',
  finalists: 3,
  timeoutMs: 60_000,
} as const;

/**
 * Catálogo da sonda da revisão: competidor e juiz caros na ESTIMATIVA
 * (G2 ≈ US$ 3,3 para 3 variantes × 2 cenários), o resto ~grátis; na FATURA
 * cada resposta de competidor custa US$ 0,20 — 6 delas passam do teto de 1.
 */
function fakeVariationCara(): FakeOpenRouter {
  return fakePipeline({
    price: (id) => (id === 'fake/a' || id === 'fake/judge' ? 1e-4 : 1e-9),
    cost: (m) => (m === 'fake/a' ? 0.2 : 0.0001),
  });
}

/** O que a porta atômica G2 garante numa variation cortada antes das respostas. */
function conferirVariationCortadaNoG2(rec: RunRecord, fake: FakeOpenRouter, eventos: RunEvent[]): void {
  expect(rec.status, rec.error).toBe('aborted');
  expect(rec.stoppedReason).toBe('budget');
  expect(rec.budgetExhausted).toBe(true);
  expect(rec.stoppedAtPhase).toBe('competitors');
  // As variantes existiam (original + 2 técnicas) e a porta mediu com ELAS.
  expect(rec.contestants).toHaveLength(3);
  const papeis = fake.chatRequests().map(papel);
  expect(papeis.filter((p) => p === 'rewriter')).toHaveLength(2);
  // Nenhuma resposta paga sem poder pagar o julgamento — nem juiz, nem duelo.
  expect(papeis.filter((p) => p === 'competitor')).toHaveLength(0);
  expect(papeis.filter((p) => p === 'judge')).toHaveLength(0);
  expect(papeis.filter((p) => p === 'duel')).toHaveLength(0);
  const porta = eventos.find((e) => e.type === 'run.budget');
  expect(porta, 'a porta G2 não emitiu run.budget').toMatchObject({
    type: 'run.budget',
    phase: 'competitors',
    decision: 'stop',
  });
  expect((porta as { projectedUsd: number }).projectedUsd).toBeGreaterThan(1);
  for (const st of rec.stages) {
    expect(st.incomplete).toBe(true);
    expect(st.incompleteReason).toBe('budget');
    expect(st.responses).toHaveLength(0);
    expect(st.judge).toBeUndefined();
    expect(st.referenceJudge).toBeUndefined();
  }
  expect(rec.judgeScoreByContestant).toBeUndefined();
  // Antes da correção: US$ 1,2005 gastos com teto de US$ 1,00.
  expect(rec.totalCostUsd).toBeLessThanOrEqual(1);
  expect(rec.totalCostUsd).toBeCloseTo(fake.billedUsd(), 10);
}

/** Papel de uma chamada de chat do fake, pelo que ela pede. */
function papel(req: { model: string; stream: boolean; system: string }): string {
  if (req.model === 'fake/gen') return 'datagen';
  if (req.model === 'fake/ref') return 'gabarito';
  if (req.model === 'fake/opt') return 'rewriter';
  if (req.stream) return 'competitor';
  if (req.system.includes('DUELO')) return 'duel';
  return 'judge';
}

let anterior: OpenRouterGateway | undefined;
let silencio: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  silencio = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
});

afterEach(() => {
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
  silencio.forEach((s) => s.mockRestore());
  vi.unstubAllGlobals();
});

function usarGateway(fetch: FetchLike, extra: { maxConcurrency?: number } = {}): OpenRouterGateway {
  const gw = createGateway({ fetch, sleep: noSleep, ...extra });
  const prev = setDefaultGateway(gw);
  anterior ??= prev;
  return gw;
}

async function esperar(cond: () => boolean, ms = 5_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condição não chegou a tempo');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/**
 * Transporte com chamadas LENTAS (30 s) para os papéis escolhidos. A chamada
 * lenta só termina antes disso se o sinal abortar — e aí rejeita com um
 * `AbortError` GENÉRICO (como o navegador faz), para provar que o gateway o
 * converte em sinal de controle. Conta toda chamada que CHEGOU ao transporte.
 */
function transporteLento(base: FakeOpenRouter, lentos: (r: string) => boolean) {
  const st = { chegaram: 0, lentasEmVoo: 0, abortadas: 0, timers: new Set<ReturnType<typeof setTimeout>>() };
  const fetch: FetchLike = async (url, init) => {
    if (new URL(url).pathname.endsWith('/chat/completions')) {
      st.chegaram += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        model?: string;
        stream?: boolean;
        messages?: { role: string; content: string }[];
      };
      const req = {
        model: String(body.model ?? ''),
        stream: body.stream === true,
        system: body.messages?.find((m) => m.role === 'system')?.content ?? '',
      };
      if (lentos(papel(req))) {
        st.lentasEmVoo += 1;
        const signal = init?.signal;
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 30_000);
          st.timers.add(t);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              st.timers.delete(t);
              st.abortadas += 1;
              st.lentasEmVoo -= 1;
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            },
            { once: true },
          );
        });
      }
    }
    return base.fetch(url, init);
  };
  return { fetch, st };
}

// ===========================================================================
// (iii) Confirmação de custo: faixa low–high + drivers, portão > US$ 1
// ===========================================================================

describe('IMPL-020 (iii) — confirmação de custo com faixa e drivers', () => {
  const catalogo = (p: number): OpenRouterModel[] =>
    MODELOS.map((id) => ({
      id,
      name: id,
      context_length: 128_000,
      pricing: { prompt: p, completion: p },
    })) as unknown as OpenRouterModel[];

  it('o limiar é US$ 1 na ponta ALTA; custo desconhecido também exige confirmação', () => {
    expect(COST_CONFIRM_THRESHOLD_USD).toBe(1);
    expect(requiresCostConfirmation(1)).toBe(false);
    expect(requiresCostConfirmation(1.0001)).toBe(true);
    expect(requiresCostConfirmation(0.2, ['modelo/sem-preco'])).toBe(true);
  });

  it('o MOTIVO da confirmação separa "caro" de "sem preço" (o texto do diálogo depende dele)', () => {
    const base = { thresholdUsd: 1, unpricedModelIds: [] as string[] };
    expect(costConfirmationReason({ ...base, high: 0.5 })).toBeNull();
    expect(costConfirmationReason({ ...base, high: 1.5 })).toBe('threshold');
    // Só preço desconhecido, faixa ≤ US$ 1: dizer "pode custar mais de US$ 1" seria falso.
    expect(costConfirmationReason({ ...base, high: 0.2, unpricedModelIds: ['x/sem-preco'] })).toBe('unpriced');
    expect(costConfirmationReason({ ...base, high: 3, unpricedModelIds: ['x/sem-preco'] })).toBe('both');
    // Coerente com o portão: motivo presente <=> exige confirmação.
    for (const e of [
      { ...base, high: 0.5 },
      { ...base, high: 1.5 },
      { ...base, high: 0.2, unpricedModelIds: ['x/y'] },
    ]) {
      expect(costConfirmationReason(e) !== null).toBe(requiresCostConfirmation(e.high, e.unpricedModelIds));
    }
  });

  it('drivers por papel somam a ponta alta, com chamadas e fatia, do mais caro ao mais barato', () => {
    const est = estimateLaunchCost(COMPARE as unknown as RunConfig, catalogo(1e-4));
    expect(est.low).toBeGreaterThan(0);
    expect(est.low).toBeLessThan(est.high);
    const soma = est.drivers.reduce((s, d) => s + d.usd, 0);
    expect(soma).toBeCloseTo(est.high, 10);
    const porPapel = Object.fromEntries(est.drivers.map((d) => [d.role, d.calls]));
    // 2 cenários × 2 participantes, 1 juiz, 1 par de finalistas × 2 ordens.
    expect(porPapel).toMatchObject({ datagen: 1, gabarito: 2, competitor: 4, judge: 4, duel: 4 });
    for (let i = 1; i < est.drivers.length; i++) {
      expect(est.drivers[i - 1].usd).toBeGreaterThanOrEqual(est.drivers[i].usd);
    }
    expect(est.drivers.every((d) => d.label.length > 0 && d.share >= 0 && d.share <= 1)).toBe(true);
    expect(est.requiresConfirmation).toBe(est.high > 1);
  });

  it('treino: drivers = por rodada × rodadas + holdout, e ainda fecham com a faixa', () => {
    const cfg = { ...TRAINING, stages: 10, holdoutRatio: 0.5, iterations: 3 } as unknown as RunConfig;
    const est = estimateLaunchCost(cfg, catalogo(1e-4));
    expect(est.assumptions.iterations).toBe(3);
    expect(est.drivers.reduce((s, d) => s + d.usd, 0)).toBeCloseTo(est.high, 10);
    const rewriter = est.drivers.find((d) => d.role === 'rewriter')!;
    expect(rewriter.calls).toBe(2 * 3); // 2 técnicas × 3 rodadas
    const competitor = est.drivers.find((d) => d.role === 'competitor')!;
    // 10 cenários × 3 variantes × 3 rodadas + re-avaliação limpa por rodada
    // (IMPL-013: 2 contestants × minibatch de max(5; 30% dos 5 de treino) = 5)
    // + holdout (5 cenários × 2).
    expect(competitor.calls).toBe(10 * 3 * 3 + 3 * 2 * 5 + 5 * 2);
  });

  it('teto abaixo do piso da faixa é sinalizado (a run vai parar antes do fim)', () => {
    const est = estimateLaunchCost({ ...COMPARE, budgetUsd: 0.01 } as unknown as RunConfig, catalogo(1e-4));
    expect(est.budgetUsd).toBe(0.01);
    expect(est.budgetBelowLow).toBe(true);
    expect(est.budgetBelowHigh).toBe(true);
  });

  it('api.ts RECUSA iniciar acima de US$ 1 sem confirmação — e nenhuma chamada paga sai', async () => {
    vi.stubGlobal('localStorage', { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined });
    const fake = fakePipeline({ price: () => 1e-3 }); // catálogo CARO: faixa bem acima de US$ 1
    usarGateway(fake.fetch);
    const api = await import('../web/src/api.js');
    const err = await api.createRun(COMPARE as never).catch((e: unknown) => e);
    expect(api.isCostConfirmationRequired(err)).toBe(true);
    const est = (err as InstanceType<typeof api.CostConfirmationRequiredError>).estimate;
    expect(est.high).toBeGreaterThan(1);
    expect(est.low).toBeLessThan(est.high);
    expect(est.drivers.map((d) => d.role)).toEqual(expect.arrayContaining(['competitor', 'judge', 'duel']));
    // Treino passa pelo MESMO portão.
    const errT = await api.createSession(TRAINING as never).catch((e: unknown) => e);
    expect(api.isCostConfirmationRequired(errT)).toBe(true);
    expect(fake.chatRequests()).toHaveLength(0);
  });

  it('abaixo de US$ 1 a run começa sem pedir confirmação', async () => {
    vi.stubGlobal('localStorage', { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined });
    const fake = fakePipeline({ price: () => 1e-9 });
    usarGateway(fake.fetch);
    const api = await import('../web/src/api.js');
    const runId = await api.createRun(COMPARE as never);
    expect(typeof runId).toBe('string');
    await esperar(() => !api.canCancelRun(runId), 10_000);
    expect(fake.chatRequests().length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// (i) Teto de orçamento => aborted/budget, parcial honesto
// ===========================================================================

describe('IMPL-020 (i) — teto menor que a estimativa para a run com parcial honesto', () => {
  it('porta suave G2: competidores+julgamento não cabem => nenhuma resposta, etapas incompletas', async () => {
    // Catálogo caro => estimativa de G2 (competidores + juiz) >> teto; a fatura
    // real do fake é de centésimos de centavo.
    const fake = fakePipeline({ price: (id) => (id === 'fake/gen' || id === 'fake/ref' ? 1e-9 : 1e-3) });
    usarGateway(fake.fetch);
    const eventos: RunEvent[] = [];
    const runId = 'budget-g2';
    const unsub = subscribeRun(runId, (e) => eventos.push(e));
    const rec = (await runWeb({ ...COMPARE, budgetUsd: 1 } as never, KEY, { runId })) as RunRecord;
    unsub();

    expect(rec.status).toBe('aborted');
    expect(rec.stoppedReason).toBe('budget');
    expect(rec.budgetExhausted).toBe(true);
    expect(rec.stoppedAtPhase).toBe('competitors');
    expect(rec.budgetUsd).toBe(1);
    // Parcial honesto: as etapas existem (cenários + gabaritos gerados), mas
    // estão marcadas como cortadas e SEM nenhuma nota.
    expect(rec.stages).toHaveLength(2);
    for (const st of rec.stages) {
      expect(st.spec?.question).toBeTruthy();
      expect(st.incomplete).toBe(true);
      expect(st.incompleteReason).toBe('budget');
      expect(st.responses).toHaveLength(0);
      expect(st.judge).toBeUndefined();
      expect(st.referenceJudge).toBeUndefined();
    }
    expect(rec.judgeScoreByContestant).toBeUndefined();
    expect(Object.values(rec.scoreboard).every((v) => v === 0)).toBe(true);
    // Só G1 gastou; o total do record é a fatura.
    expect(fake.chatRequests().map(papel).sort()).toEqual(['datagen', 'gabarito', 'gabarito']);
    expect(rec.totalCostUsd).toBeCloseTo(fake.billedUsd(), 10);
    expect(rec.totalCostUsd).toBeLessThanOrEqual(1);
    const porta = eventos.find((e) => e.type === 'run.budget');
    expect(porta).toMatchObject({ type: 'run.budget', phase: 'competitors', decision: 'stop' });
    expect(eventos.some((e) => e.type === 'run.finished')).toBe(true);
  });

  it('porta dura (BudgetExceeded no meio do grupo): etapa respondida e não julgada NÃO vira nota', async () => {
    // Estimativas ~0 (portas suaves passam), mas cada resposta de competidor
    // custa US$ 0,40 de verdade: depois de 4 respostas o juiz não cabe mais e
    // a reserva dele lança BudgetExceeded — que o refJudge NÃO pode degradar
    // para 'parcial' (sinal de controle, via isControlSignal).
    const fake = fakePipeline({
      price: () => 1e-9,
      cost: (m) => (m === 'fake/a' || m === 'fake/b' ? 0.4 : 0.0001),
    });
    usarGateway(fake.fetch);
    const rec = (await runWeb({ ...COMPARE, budgetUsd: 1 } as never, KEY, {})) as RunRecord;

    expect(rec.status).toBe('aborted');
    expect(rec.stoppedReason).toBe('budget');
    expect(rec.budgetExhausted).toBe(true);
    const papeis = fake.chatRequests().map(papel);
    expect(papeis.filter((p) => p === 'competitor')).toHaveLength(4);
    expect(papeis.filter((p) => p === 'judge')).toHaveLength(0); // nenhum juiz chegou a sair
    expect(papeis.filter((p) => p === 'duel')).toHaveLength(0);
    for (const st of rec.stages) {
      expect(st.incomplete).toBe(true);
      expect(st.incompleteReason).toBe('budget');
      expect(st.judge).toBeUndefined();
      expect(st.referenceJudge).toBeUndefined();
    }
    expect(rec.judgeScoreByContestant).toBeUndefined();
    expect(rec.totalCostUsd).toBeCloseTo(fake.billedUsd(), 10);
  });

  it('porta das finais: julgamento completo, finais cortadas => aborted/budget sem duelo pela metade', async () => {
    // Por cenário: juiz = 2 × (3000 in + 1024 out) = 8048 tokens × p; finais =
    // 1 par × 2 ordens × (4000 + 512) = 9024 × p. Com p = 1e-4 e competidores
    // ~grátis: G2 ≈ US$ 1,61 cabe no teto de 1,70; as finais (≈ 1,80) não.
    const fake = fakePipeline({ price: (id) => (id === 'fake/judge' ? 1e-4 : 1e-9) });
    usarGateway(fake.fetch);
    const rec = (await runWeb({ ...COMPARE, budgetUsd: 1.7 } as never, KEY, {})) as RunRecord;

    expect(rec.status).toBe('aborted');
    expect(rec.stoppedReason).toBe('budget');
    expect(rec.stoppedAtPhase).toBe('finals');
    // O que foi julgado fica — e só isso.
    for (const st of rec.stages) {
      expect(st.incomplete).toBeFalsy();
      expect(st.referenceJudge?.verdictByContestant).toBeDefined();
      expect(st.duels).toBeUndefined();
    }
    expect(rec.judgeScoreByContestant).toBeDefined();
    expect(rec.standings).toBeUndefined();
    expect(fake.chatRequests().map(papel).filter((p) => p === 'duel')).toHaveLength(0);
  });

  it('variation standalone (createRun → prepare): a porta G2 mede com as variantes geradas', async () => {
    // Revisão IMPL-020: a estimativa era montada ANTES do `prepare`, com
    // `contestantIds: []` => ZERO competidores estimados, G2 nunca disparava e a
    // run pagava 6 respostas sem nota, passando do teto (US$ 1,20 de 1,00).
    vi.stubGlobal('localStorage', { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined });
    const fake = fakeVariationCara();
    usarGateway(fake.fetch);
    const cfg = { ...VARIATION, budgetUsd: 1 };
    const api = await import('../web/src/api.js');
    const eventos: RunEvent[] = [];
    // A faixa de lançamento (até ~US$ 8,7) já exige o "sim" do diálogo.
    const runId = await api.createRun(cfg as never, { costConfirmed: true });
    const rec = await new Promise<RunRecord>((resolve) => {
      const unsub = subscribeRun(runId, (e) => {
        eventos.push(e);
        if (e.type === 'run.finished') {
          unsub();
          resolve(e.record as RunRecord);
        } else if (e.type === 'run.error') {
          unsub();
          resolve({ status: 'error', error: e.error } as unknown as RunRecord);
        }
      });
    });
    conferirVariationCortadaNoG2(rec, fake, eventos);
    expect(rec.budgetUsd).toBe(1);
  });

  it('sem teto nada muda: a run termina `finished`, sem stoppedReason', async () => {
    const fake = fakePipeline();
    usarGateway(fake.fetch);
    const rec = (await runWeb(COMPARE as never, KEY, {})) as RunRecord;
    expectPipelineDone(rec);
    expect(rec.stoppedReason).toBeUndefined();
    expect(rec.budgetUsd).toBeUndefined();
    expect(rec.stages.every((s) => !s.incomplete)).toBe(true);
  });

  it('treino: o teto é da SESSÃO — a run da iteração cortada para a sessão (aborted/budget)', async () => {
    const fake = fakePipeline({
      price: (id) => (id === 'fake/gen' || id === 'fake/ref' || id === 'fake/opt' ? 1e-9 : 1e-3),
    });
    usarGateway(fake.fetch);
    const { sessionId, record } = await startWebTraining({ ...TRAINING, budgetUsd: 1 } as never, KEY);
    await esperar(() => record.status !== 'running', 10_000);
    const sessao = record as SessionRecord;
    expect(sessionId).toBe(sessao.id);
    expect(sessao.status).toBe('aborted');
    expect(sessao.stoppedReason).toBe('budget');
    expect(sessao.budgetExhausted).toBe(true);
    expect(sessao.stoppedAtIteration).toBe(0);
    expect(sessao.budgetUsd).toBe(1);
    // Nenhum campeão promovido a partir de uma rodada cortada.
    expect(sessao.bestPromptByIteration).toHaveLength(0);
    expect(sessao.totalCostUsd).toBeCloseTo(fake.billedUsd(), 10);
    expect(sessao.totalCostUsd).toBeLessThanOrEqual(1);
    expect(fake.chatRequests().map(papel).filter((p) => p === 'competitor')).toHaveLength(0);
  });


  it('treino: a porta POR ITERAÇÃO para antes de uma rodada que não cabe, mantendo o campeão', async () => {
    // Cada chamada custa US$ 0,05 de verdade (rodada 0 com 6 cenários ≈ US$ 2,9);
    // a estimativa de uma rodada (catálogo) ≈ US$ 2,5. Teto 4: a rodada 0 cabe
    // inteira, mas gasto(≈2,9) + rodada(≈2,5) > 4 => a rodada 1 nem começa.
    // 6 cenários (não 2): a rodada 0 precisa PROMOVER para haver rodada 1, e o
    // gate da melhor de K (IMPL-002) não promove com menos de 5 pares.
    const fake = fakePipeline({
      price: (id) => (id === 'fake/judge' ? 2e-5 : 1e-9),
      cost: () => 0.05,
      harshOnBase: true,
      cenarios: CENARIOS_TREINO,
    });
    usarGateway(fake.fetch);
    const { record } = await startWebTraining(
      { ...TRAINING, stages: CENARIOS_TREINO.length, budgetUsd: 4 } as never,
      KEY,
    );
    await esperar(() => record.status !== 'running', 10_000);
    const sessao = record as SessionRecord;
    expect(sessao.stoppedReason, JSON.stringify({ st: sessao.status, err: sessao.error })).toBe('budget');
    expect(sessao.status).toBe('aborted');
    expect(sessao.stoppedAtIteration).toBe(1);
    expect(sessao.bestPromptByIteration).toHaveLength(1); // a rodada 0 completa ficou
    expect(sessao.bestPromptByIteration[0]?.gate?.decision).toBe('promoted');
    expect(sessao.runIds).toHaveLength(1); // a rodada 1 nem foi criada
    expect(sessao.totalCostUsd).toBeLessThanOrEqual(4);
  });

  it('variationConfigFrom do web NÃO copia budgetUsd (senão N iterações gastariam N× o teto)', () => {
    const v = webVariationConfigFrom({ ...TRAINING, budgetUsd: 42 } as never) as unknown as Record<
      string,
      unknown
    >;
    expect(v.budgetUsd).toBeUndefined();
    expect(v.theme).toBe(TRAINING.theme);
  });

  it('normalizeRunRecord preserva os campos novos de parada (whitelist silencioso)', () => {
    const rec = normalizeRunRecord({
      id: 'r',
      status: 'aborted',
      config: { mode: 'compare', budgetUsd: 2 },
      stages: [{ index: 0, startedAt: 'now', responses: [], incomplete: true, incompleteReason: 'budget' }],
      scoreboard: {},
      totalCostUsd: 1,
      startedAt: 'now',
      budgetUsd: 2,
      budgetExhausted: true,
      stoppedAtPhase: 'competitors',
      stoppedReason: 'budget',
    }) as unknown as RunRecord;
    expect(rec).toMatchObject({
      budgetUsd: 2,
      budgetExhausted: true,
      stoppedAtPhase: 'competitors',
      stoppedReason: 'budget',
    });
    expect(rec.stages[0]).toMatchObject({ incomplete: true, incompleteReason: 'budget' });
  });
});

// ===========================================================================
// Mirror Node (src/orchestrator.ts): a mesma porta, pelo caminho do CLI/servidor
// ===========================================================================

describe('IMPL-020 — mirror Node: variation (prepareOptsFor) respeita a porta G2', () => {
  let tmp: string;
  let dirAnterior: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl020-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
  });

  afterAll(() => {
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('teto abaixo de G2: nenhuma resposta paga, run.budget emitido, etapas com motivo', async () => {
    const fake = fakeVariationCara();
    usarGateway(fake.fetch);
    const cfg = { ...VARIATION, budgetUsd: 1 } as unknown as RunConfig;
    const runId = 'node-variation-g2';
    const eventos: RunEvent[] = [];
    const unsub = subscribeNodeRun(runId, (e) => eventos.push(e as unknown as RunEvent));
    const rec = (await runNode(cfg, KEY, prepareOptsFor(cfg, KEY, { runId }))) as unknown as RunRecord;
    unsub();
    conferirVariationCortadaNoG2(rec, fake, eventos);
  });

  it('cancelar no meio do julgamento marca a etapa com incompleteReason "cancelled"', async () => {
    const lento = transporteLento(fakePipeline(), (p) => p === 'judge');
    usarGateway(lento.fetch);
    const ac = new AbortController();
    const fim = runNode(COMPARE as unknown as RunConfig, KEY, { ctx: { signal: ac.signal } });
    await esperar(() => lento.st.lentasEmVoo === 4);
    const noClique = lento.st.chegaram;
    ac.abort(new RunCancelled('clique'));
    const rec = (await fim) as unknown as RunRecord;
    expect(lento.st.chegaram).toBe(noClique);
    expect(rec.status).toBe('aborted');
    expect(rec.stoppedReason).toBe('cancelled');
    for (const st of rec.stages) {
      expect(st.incomplete).toBe(true);
      expect(st.incompleteReason).toBe('cancelled');
      expect(st.referenceJudge).toBeUndefined();
    }
    for (const t of lento.st.timers) clearTimeout(t);
  });
});

// ===========================================================================
// (ii) Cancelar: aborta o que está em voo, nenhuma chamada nova depois do clique
// ===========================================================================

describe('IMPL-020 (ii) — Cancelar aborta tudo e nada novo começa', () => {
  it('run: 2 respostas de 30 s em voo + 2 na fila do limitador => cancelar encerra em ms', async () => {
    const lento = transporteLento(fakePipeline(), (p) => p === 'competitor');
    // Teto 2 no limitador: 2 competidores em voo, 2 ESPERANDO vaga — a fila
    // também precisa esvaziar sem tocar o transporte.
    const gw = usarGateway(lento.fetch, { maxConcurrency: 2 });
    const runId = 'cancel-run';
    const fim = runWeb(COMPARE as never, KEY, { runId });
    await esperar(() => lento.st.lentasEmVoo === 2 && gw.currentConcurrency().queued === 2);
    expect(isRunCancellable(runId)).toBe(true);

    const noClique = lento.st.chegaram;
    const t0 = Date.now();
    expect(cancelRun(runId)).toBe(true);
    const rec = (await fim) as RunRecord;
    const ms = Date.now() - t0;

    expect(ms).toBeLessThan(2_000); // não esperou os 30 s
    expect(lento.st.abortadas).toBe(2); // as duas em voo morreram
    expect(lento.st.chegaram).toBe(noClique); // ZERO chamadas novas depois do clique
    expect(gw.currentConcurrency()).toMatchObject({ active: 0, queued: 0 });
    expect(rec.status).toBe('aborted');
    expect(rec.stoppedReason).toBe('cancelled');
    expect(rec.budgetExhausted).toBeFalsy();
    for (const st of rec.stages) {
      expect(st.incomplete).toBe(true);
      expect(st.incompleteReason).toBe('cancelled');
      expect(st.judge).toBeUndefined();
      expect(st.referenceJudge).toBeUndefined();
      // Competidor abortado não vira "resposta com erro" (nem nota).
      expect(st.responses).toHaveLength(0);
    }
    expect(isRunCancellable(runId)).toBe(false);
    expect(cancelRun(runId)).toBe(false); // idempotente: já terminou
    for (const t of lento.st.timers) clearTimeout(t);
  });

  it('run: cancelar durante o julgamento não deixa veredito degradado ("parcial" inventado)', async () => {
    const lento = transporteLento(fakePipeline(), (p) => p === 'judge');
    usarGateway(lento.fetch);
    const runId = 'cancel-judge';
    const fim = runWeb(COMPARE as never, KEY, { runId });
    await esperar(() => lento.st.lentasEmVoo === 4);
    const noClique = lento.st.chegaram;
    cancelRun(runId);
    const rec = (await fim) as RunRecord;
    expect(lento.st.chegaram).toBe(noClique);
    expect(rec.status).toBe('aborted');
    expect(rec.stoppedReason).toBe('cancelled');
    for (const st of rec.stages) {
      expect(st.responses).toHaveLength(2); // as respostas chegaram antes
      expect(st.incomplete).toBe(true);
      expect(st.referenceJudge).toBeUndefined(); // nenhum 'parcial' de juiz abortado
      expect(st.judge).toBeUndefined();
    }
    expect(rec.judgeScoreByContestant).toBeUndefined();
    for (const t of lento.st.timers) clearTimeout(t);
  });

  it('treino: cancelar a SESSÃO derruba a run da iteração e impede a próxima', async () => {
    const lento = transporteLento(fakePipeline(), (p) => p === 'competitor');
    usarGateway(lento.fetch);
    const { sessionId, record } = await startWebTraining(TRAINING as never, KEY);
    const terminou = new Promise<void>((resolve) => {
      const unsub = subscribeSession(sessionId, (e) => {
        if (e.type === 'session.finished' || e.type === 'session.error') {
          unsub();
          resolve();
        }
      });
    });
    await esperar(() => lento.st.lentasEmVoo > 0);
    const noClique = lento.st.chegaram;
    const t0 = Date.now();
    expect(cancelTraining(sessionId)).toBe(true);
    await terminou;
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(lento.st.chegaram).toBe(noClique);
    const sessao = record as SessionRecord;
    expect(sessao.status).toBe('aborted');
    expect(sessao.stoppedReason).toBe('cancelled');
    expect(sessao.stoppedAtIteration).toBe(0);
    expect(sessao.runIds).toHaveLength(1);
    expect(cancelTraining(sessionId)).toBe(false);
    for (const t of lento.st.timers) clearTimeout(t);
  });
});

// ===========================================================================
// Gateway: abort vira SINAL DE CONTROLE em qualquer ponto da chamada
// ===========================================================================

describe('IMPL-020 — gateway: abort é controle, na fila, no envio e no meio do corpo', () => {
  const msgs = [{ role: 'user' as const, content: 'oi' }];

  it('toControlSignal: motivo qualquer vira RunCancelled; sinal de controle passa intacto', () => {
    const c = toControlSignal(new DOMException('aborted', 'AbortError'));
    expect(isControlSignal(c)).toBe(true);
    expect(c.benchControl).toBe('cancel');
    const b = new BudgetExceeded(1, 1);
    expect(toControlSignal(b)).toBe(b);
    const r = new RunCancelled('x');
    expect(toControlSignal(r)).toBe(r);
    expect(toControlSignal('SIGINT').message).toMatch(/SIGINT/);
  });

  it('quem espera vaga no limitador sai da fila no abort, sem tocar o transporte', async () => {
    const lento = transporteLento(fakeOpenRouter(), () => true);
    const gw = createGateway({ fetch: lento.fetch, sleep: noSleep, maxConcurrency: 1 });
    const a = new AbortController();
    const b = new AbortController();
    const pa = gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs, signal: a.signal }).catch((e) => e);
    await esperar(() => lento.st.lentasEmVoo === 1);
    const pb = gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs, signal: b.signal }).catch((e) => e);
    await esperar(() => gw.currentConcurrency().queued === 1);
    b.abort(new RunCancelled('fila'));
    const eb = await pb;
    expect(isControlSignal(eb)).toBe(true);
    expect(lento.st.chegaram).toBe(1); // B nunca chegou ao transporte
    expect(gw.currentConcurrency()).toMatchObject({ active: 1, queued: 0 });
    a.abort(); // motivo genérico => ainda assim controle
    const ea = await pa;
    expect(isControlSignal(ea)).toBe(true);
    expect(gw.currentConcurrency()).toMatchObject({ active: 0, queued: 0 });
  });

  it('Cancelar durante o BACKOFF de retry (429) fecha na hora, sem esperar o sono', async () => {
    // Revisão IMPL-020: o sono do backoff (até ~8 s) não era abortável — nenhuma
    // chamada nova saía, mas a run só fechava quando ele acabava (sonda: 3014 ms).
    let chamadas = 0;
    const fetch: FetchLike = async (url) => {
      if (!new URL(url).pathname.endsWith('/chat/completions')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      chamadas += 1;
      return new Response('{"error":{"message":"rate limited"}}', { status: 429 });
    };
    // Espera de 3 s que IGNORA o sinal: o gateway tem de correr contra o abort
    // por fora, qualquer que seja a espera injetada. O sinal chega como dica.
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const dicas: Array<AbortSignal | undefined> = [];
    const sleep = (_ms: number, sig?: AbortSignal): Promise<void> =>
      new Promise((resolve) => {
        dicas.push(sig);
        timers.add(setTimeout(resolve, 3_000));
      });
    const gw = createGateway({ fetch, sleep });
    const ac = new AbortController();
    const p = gw
      .chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs, signal: ac.signal })
      .catch((e: unknown) => e);
    await esperar(() => dicas.length === 1);
    const t0 = Date.now();
    ac.abort(new RunCancelled('clique durante o backoff'));
    const err = await p;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(isControlSignal(err)).toBe(true);
    expect(chamadas).toBe(1); // o retry nunca saiu
    expect(dicas[0]).toBe(ac.signal);
    expect(gw.currentConcurrency()).toMatchObject({ active: 0, queued: 0 });
    for (const t of timers) clearTimeout(t);
  });

  it('backoff com a espera PADRÃO também solta no abort (e sem sinal segue dormindo normal)', async () => {
    let chamadas = 0;
    const fetch: FetchLike = async (url) => {
      if (!new URL(url).pathname.endsWith('/chat/completions')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      chamadas += 1;
      // 1ª tentativa: 503 (backoff de 250–500 ms); a seguinte responde OK.
      if (chamadas === 1) return new Response('indisponivel', { status: 503 });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const gw = createGateway({ fetch }); // sem `sleep` => espera padrão
    const ac = new AbortController();
    const p = gw
      .chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs, signal: ac.signal })
      .catch((e: unknown) => e);
    await esperar(() => chamadas === 1);
    const t0 = Date.now();
    ac.abort(new RunCancelled('clique'));
    const err = await p;
    // O backoff da 1ª tentativa dura ≥ 250 ms: sair antes disso prova que o
    // abort cortou o sono (e não o `acquire` da tentativa seguinte).
    expect(Date.now() - t0).toBeLessThan(200);
    expect(isControlSignal(err)).toBe(true);
    await new Promise((r) => setTimeout(r, 600)); // passou o backoff: nada saiu
    expect(chamadas).toBe(1);
    // Sem sinal, o retry acontece depois do sono (comportamento de sempre).
    chamadas = 0;
    const ok = await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs });
    expect(chamadas).toBe(2);
    expect(ok.text).toBe('ok');
  });

  it('abort no MEIO do stream (resposta chegando) sai como controle, não como erro comum', async () => {
    const enc = new TextEncoder();
    const fetch: FetchLike = async (url, init) => {
      if (!new URL(url).pathname.endsWith('/chat/completions')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'meia ' } }] })}\n\n`));
          // O navegador erra o corpo com um AbortError genérico quando a
          // requisição é abortada no meio da leitura.
          signal?.addEventListener('abort', () => ctrl.error(new DOMException('aborted', 'AbortError')), {
            once: true,
          });
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const gw = createGateway({ fetch, sleep: noSleep });
    const ac = new AbortController();
    let parcial = '';
    const p = gw
      .chatCompletionStream({
        apiKey: KEY,
        modelId: 'x/y',
        messages: msgs,
        signal: ac.signal,
        onDelta: (_d, full) => {
          parcial = full;
        },
      })
      .catch((e: unknown) => e);
    await esperar(() => parcial.length > 0);
    ac.abort(new RunCancelled('meio do stream'));
    const err = await p;
    expect(isControlSignal(err)).toBe(true);
    expect(gw.currentConcurrency()).toMatchObject({ active: 0, queued: 0 });
  });
});
