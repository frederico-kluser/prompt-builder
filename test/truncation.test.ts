// IMPL-014 (R-07b:DEC-2 + REC-2) — truncamento detectado, repetido 1x com teto
// x2 e, persistindo, a etapa fica `incomplete` FORA do placar e das médias.
//
// Antes: `finish_reason` não era lido em lugar nenhum; resposta cortada por
// `max_tokens` (finish_reason: length) virava status 'ok' com texto truncado,
// entrava no placar e o juiz a punia como 'nao' — truncagem silenciosa. Contratos
// provados aqui (transporte FALSO, zero rede, zero gasto):
//  (i)   o record persiste finishReason/nativeFinishReason em 100% das respostas
//        de competidor e do gabarito; o juiz recebe os sinais no resultado de
//        chatCompletion (a parte do juiz truncado é o IMPL-015);
//  (ii)  fixture com finish_reason: length marca a etapa incomplete
//        (incompleteReason 'truncation') e a exclui do placar e das médias —
//        Node e SPA (mirror);
//  (iii) `run --json` emite truncationRate e truncationAlert quando > 0,02;
//  (iv)  normalizeRunRecord preserva os campos novos e a config derivada por
//        variationConfigFrom (treino) mantém o comportamento.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { runCompetitor } from '../src/competitor.js';
import { generateReferences } from '../src/gabarito.js';
import {
  describeTruncatedStage,
  finishSignalsOf,
  isTruncated,
  retryMaxTokens,
  TRUNCATION_ALERT_RATE,
  truncationAlert,
  truncationSignals,
  truncationStats,
} from '../src/engine/truncation.js';
import { normalizeRunRecord } from '../src/normalize.js';
import { variationConfigFrom } from '../src/trainer.js';
import { setDataDir, getDataDir } from '../src/storage.js';
import { subscribe } from '../src/events.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { subscribeRun } from '../web/src/engine/events.js';
import { cmdRun } from '../src/cli/commands/run.js';
import { Output } from '../src/cli/output.js';
import { emitRunEvent } from '../src/cli/ndjson.js';
import type {
  CallFinishSignals,
  Contestant,
  RunConfig,
  RunEvent,
  RunRecord,
  StageSpec,
  TrainingConfig,
} from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeChatReply } from './fakeOpenRouter.js';

vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));
// O reducer da UI (runShared.tsx) importa peças do Motion UI/shadcn pelo alias
// `@/` — aqui viram stubs: o que se testa é a dobra do evento no record.
vi.mock('@/components/motion-ui/accordion', () => ({
  Accordion: () => null,
  AccordionItem: () => null,
  AccordionTrigger: () => null,
  AccordionPanel: () => null,
}));
vi.mock('@/components/motion-ui/progress-bar', () => ({ ProgressBar: () => null }));
vi.mock('@/lib/utils', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }));
vi.mock('../web/src/components/primitives', () => ({ Tag: () => null }));
vi.mock('../web/src/theme', () => ({ useTheme: () => ({ theme: 'light' }) }));

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// As dependências do web/ exigem MOTION_TOKEN (`npm run setup`); sem elas o
// teste do reducer é pulado (o resto do arquivo não precisa delas).
const temWebDeps = existsSync(join(ROOT, 'web', 'node_modules', 'react', 'index.js'));

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const msgs = [{ role: 'user' as const, content: 'oi' }];

// ---------------------------------------------------------------------------
// Regra pura
// ---------------------------------------------------------------------------

describe('IMPL-014 — regra pura de truncamento (engine/truncation.ts)', () => {
  const base = { tokensOut: 50, contentChars: 120 };

  it('finish_reason "length" decide sozinho; stop com conteúdo não é truncamento', () => {
    expect(isTruncated({ ...base, finishReason: 'length' })).toBe(true);
    expect(truncationSignals({ ...base, finishReason: 'length' })).toEqual(['finish_length']);
    expect(isTruncated({ ...base, finishReason: 'stop' })).toBe(false);
    expect(truncationSignals({ ...base, finishReason: 'stop' })).toEqual([]);
  });

  it('native_finish_reason de teto (Anthropic/Gemini/Responses/vLLM) decide mesmo com "stop" normalizado', () => {
    for (const nativo of ['max_tokens', 'MAX_TOKENS', 'length', 'max_output_tokens', 'model_length']) {
      const o = { ...base, finishReason: 'stop', nativeFinishReason: nativo };
      expect(isTruncated(o), nativo).toBe(true);
      expect(truncationSignals(o)).toContain('native_length');
    }
    expect(isTruncated({ ...base, finishReason: 'stop', nativeFinishReason: 'end_turn' })).toBe(false);
  });

  it('sem finish_reason, os sinais auxiliares decidem (vazio com tokens; raciocínio ≈ teto)', () => {
    expect(isTruncated({ tokensOut: 20, contentChars: 0 })).toBe(true);
    expect(truncationSignals({ tokensOut: 20, contentChars: 0 })).toEqual(['empty_with_tokens']);
    const noTeto = { tokensOut: 100, contentChars: 40, reasoningTokens: 96, maxTokens: 100 };
    expect(truncationSignals(noTeto)).toEqual(['reasoning_at_cap']);
    expect(isTruncated(noTeto)).toBe(true);
    // Abaixo de 95% do teto não é "≈ teto".
    expect(truncationSignals({ ...noTeto, reasoningTokens: 90 })).toEqual([]);
    // Sem max_tokens no corpo, "raciocínio ≈ teto" não tem teto contra o qual medir.
    expect(truncationSignals({ ...noTeto, maxTokens: undefined })).toEqual([]);
  });

  it('com "stop" explícito, UM sinal auxiliar só é registrado; os DOIS juntos decidem', () => {
    const vazioStop = { finishReason: 'stop', tokensOut: 30, contentChars: 0 };
    expect(truncationSignals(vazioStop)).toEqual(['empty_with_tokens']);
    expect(isTruncated(vazioStop)).toBe(false); // resposta vazia legítima: o juiz pune
    const tetoStop = { finishReason: 'stop', tokensOut: 100, contentChars: 0, reasoningTokens: 99, maxTokens: 100 };
    expect(isTruncated(tetoStop)).toBe(true); // raciocínio comeu o teto e nada sobrou
  });

  it('vazio explicado (recusa declarada / bloqueio) não conta como "vazio com tokens"', () => {
    expect(truncationSignals({ tokensOut: 12, contentChars: 0, explainedEmpty: true })).toEqual([]);
    expect(isTruncated({ tokensOut: 12, contentChars: 0, explainedEmpty: true })).toBe(false);
    // Vazio SEM tokens também não é truncamento (nada foi gerado).
    expect(isTruncated({ tokensOut: 0, contentChars: 0 })).toBe(false);
  });

  it('retry com teto x2 (inteiro, sempre maior)', () => {
    expect(retryMaxTokens(300)).toBe(600);
    expect(retryMaxTokens(1500)).toBe(3000);
    expect(retryMaxTokens(1)).toBe(2);
  });

  it('truncationStats conta CADA tentativa; resposta sem sinal (erro/antiga) fica fora do denominador', () => {
    const t = truncationStats([
      {
        responses: [
          { truncated: false },
          { truncated: true, truncationRetried: true }, // 2 chamadas, 2 truncadas
          { truncated: false, truncationRetried: true }, // 2 chamadas, 1 truncada (a 1ª)
          {}, // erro de infra / record antigo: fora
          { truncationRetried: true }, // retry falhou depois de uma 1ª truncada: 1 e 1
        ],
        gabaritoCall: { truncated: false, tokensOut: 1, contentChars: 1 } as CallFinishSignals,
      },
      { responses: [] },
      {},
    ]);
    expect(t).toEqual({ calls: 7, truncated: 4, rate: Number((4 / 7).toFixed(4)) });
    expect(truncationStats([])).toEqual({ calls: 0, truncated: 0, rate: 0 });
  });

  it('alerta só ACIMA de 2% (limiar do R-07b:REC-2)', () => {
    expect(TRUNCATION_ALERT_RATE).toBe(0.02);
    expect(truncationAlert({ calls: 100, truncated: 2, rate: 0.02 })).toBeUndefined();
    expect(truncationAlert({ calls: 0, truncated: 0, rate: 0 })).toBeUndefined();
    const msg = truncationAlert({ calls: 100, truncated: 3, rate: 0.03 });
    expect(msg).toMatch(/3 de 100 chamadas \(3,0%\)/);
    expect(msg).toMatch(/acima do limite de 2%/);
  });

  it('describeTruncatedStage cita quem truncou e o teto — nunca o texto', () => {
    const txt = describeTruncatedStage(0, [{ contestantId: 'm/x', maxTokens: 600 }], (id) => `rótulo ${id}`);
    expect(txt).toMatch(/Etapa 1 incompleta por truncamento: rótulo m\/x \(teto 600\)/);
    expect(txt).toMatch(/fora do placar e das médias/);
  });
});

// ---------------------------------------------------------------------------
// Gateway: sinais extraídos (JSON e SSE) e chegam ao chamador (inclusive juiz)
// ---------------------------------------------------------------------------

describe('IMPL-014 (i) — gateway extrai finish_reason/native_finish_reason e decide o truncamento', () => {
  const gw = (reply: FakeChatReply) =>
    createGateway({ fetch: fakeOpenRouter({ chat: () => reply }).fetch, sleep: noSleep });

  it('não-streaming: length + max_tokens nativo => truncated, sinais e motivos no resultado', async () => {
    const r = await gw({ text: 'Resposta cortada no me', finishReason: 'length', nativeFinishReason: 'max_tokens' })
      .chatCompletion({ apiKey: KEY, modelId: 'm', messages: msgs, maxTokens: 50, role: 'judge' });
    expect(r.finishReason).toBe('length');
    expect(r.nativeFinishReason).toBe('max_tokens');
    expect(r.truncated).toBe(true);
    expect(r.truncationSignals).toEqual(['finish_length', 'native_length']);
  });

  it('juiz (role judge) recebe finishReason no resultado de chatCompletion — base do IMPL-015', async () => {
    const r = await gw({ text: '{"verdict":"resolve"}', finishReason: 'stop', nativeFinishReason: 'end_turn' })
      .chatCompletion({ apiKey: KEY, modelId: 'm', messages: msgs, maxTokens: 1024, role: 'judge' });
    expect(r).toMatchObject({ finishReason: 'stop', nativeFinishReason: 'end_turn', truncated: false });
    expect(r.truncationSignals).toBeUndefined();
  });

  it('streaming: finish_reason no penúltimo chunk + reasoning_tokens no último => os 3 sinais', async () => {
    const r = await gw({
      text: '',
      finishReason: 'length',
      usage: { prompt_tokens: 10, completion_tokens: 100, cost: 0.001, completion_tokens_details: { reasoning_tokens: 100 } },
    }).chatCompletionStream({ apiKey: KEY, modelId: 'm', messages: msgs, maxTokens: 100 });
    expect(r.finishReason).toBe('length');
    expect(r.reasoningTokens).toBe(100);
    expect(r.truncated).toBe(true);
    expect(r.truncationSignals).toEqual(['finish_length', 'reasoning_at_cap', 'empty_with_tokens']);
  });

  it('streaming sem finish_reason e conteúdo vazio com tokens => truncado pelo sinal auxiliar', async () => {
    const r = await gw({ text: '', usage: { prompt_tokens: 5, completion_tokens: 40, cost: 0.001 } })
      .chatCompletionStream({ apiKey: KEY, modelId: 'm', messages: msgs, maxTokens: 400 });
    expect(r.finishReason).toBeUndefined();
    expect(r.truncated).toBe(true);
    expect(r.truncationSignals).toEqual(['empty_with_tokens']);
  });

  it('recusa declarada com conteúdo vazio NÃO é truncamento', async () => {
    const r = await gw({ text: '', refusal: 'Não posso.', finishReason: 'stop' })
      .chatCompletionStream({ apiKey: KEY, modelId: 'm', messages: msgs, maxTokens: 100 });
    expect(r.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Competidor e gabarito: 1 retry com teto x2
// ---------------------------------------------------------------------------

const STAGE: StageSpec = { question: 'Explique a política de trocas.', productContext: 'Trocas em 30 dias.', maxTokens: 300 };

describe('IMPL-014 — competidor: 1 retry com max_tokens x2', () => {
  let anterior: OpenRouterGateway | undefined;
  let silencio: Array<{ mockRestore(): void }> = [];
  beforeEach(() => {
    silencio = [vi.spyOn(console, 'error').mockImplementation(() => undefined)];
  });
  afterEach(() => {
    if (anterior) setDefaultGateway(anterior);
    anterior = undefined;
    silencio.forEach((s) => s.mockRestore());
  });
  const usar = (chat: (n: number) => FakeChatReply) => {
    const fake = fakeOpenRouter({ chat: (_req, n) => chat(n) });
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    return fake;
  };

  it('truncou e o retry x2 completou: resposta válida, sinais da tentativa final, custo das duas', async () => {
    const fake = usar((n) =>
      n === 0
        ? { text: 'Metade da resp', finishReason: 'length', usage: { prompt_tokens: 10, completion_tokens: 300, cost: 0.002 } }
        : { text: 'Resposta inteira.', finishReason: 'stop', nativeFinishReason: 'end_turn', usage: { prompt_tokens: 10, completion_tokens: 350, cost: 0.003 } },
    );
    const r = await runCompetitor({ apiKey: KEY, contestantId: 'c', modelId: 'm', stage: STAGE });
    const pedidos = fake.chatRequests();
    expect(pedidos.map((p) => p.body?.max_tokens)).toEqual([300, 600]);
    expect(r).toMatchObject({
      status: 'ok',
      text: 'Resposta inteira.',
      truncated: false,
      truncationRetried: true,
      maxTokens: 600,
      finishReason: 'stop',
      nativeFinishReason: 'end_turn',
      tokensOut: 350,
    });
    expect(r.costUsd).toBeCloseTo(0.005, 10);
  });

  it('truncou nas DUAS: truncated=true, exatamente 2 chamadas (sem laço)', async () => {
    const fake = usar(() => ({ text: 'Cortada', finishReason: 'length', nativeFinishReason: 'MAX_TOKENS' }));
    const r = await runCompetitor({ apiKey: KEY, contestantId: 'c', modelId: 'm', stage: STAGE, maxOutputTokens: 200 });
    expect(fake.chatRequests().map((p) => p.body?.max_tokens)).toEqual([200, 400]);
    expect(r).toMatchObject({
      status: 'ok',
      truncated: true,
      truncationRetried: true,
      maxTokens: 400,
      finishReason: 'length',
      nativeFinishReason: 'MAX_TOKENS',
      truncationSignals: ['finish_length', 'native_length'],
    });
  });

  it('resposta completa: 1 chamada, truncated=false persistido (sinal de fim em 100% das respostas)', async () => {
    const fake = usar(() => ({ text: 'ok', finishReason: 'stop' }));
    const r = await runCompetitor({ apiKey: KEY, contestantId: 'c', modelId: 'm', stage: STAGE });
    expect(fake.chatRequests()).toHaveLength(1);
    expect(r).toMatchObject({ truncated: false, finishReason: 'stop', maxTokens: 300 });
    expect(r.truncationRetried).toBeUndefined();
  });

  it('bloqueio por filtro não é repetido nem marcado como truncado', async () => {
    const fake = usar(() => ({ text: 'Parc', finishReason: 'content_filter', nativeFinishReason: 'SAFETY' }));
    const r = await runCompetitor({ apiKey: KEY, contestantId: 'c', modelId: 'm', stage: STAGE });
    expect(fake.chatRequests()).toHaveLength(1);
    expect(r.status).toBe('blocked');
    expect(r.truncated).toBe(false);
  });

  it('retry falhou por infra depois de uma 1ª truncada: status error, custo da 1ª preservado', async () => {
    usar((n) =>
      n === 0
        ? { text: 'Cortada', finishReason: 'length', usage: { prompt_tokens: 1, completion_tokens: 300, cost: 0.004 } }
        : { status: 400, bodyText: 'provider caiu' },
    );
    const r = await runCompetitor({ apiKey: KEY, contestantId: 'c', modelId: 'm', stage: STAGE, retries: 1 });
    expect(r.status).toBe('error');
    expect(r.truncationRetried).toBe(true);
    expect(r.costUsd).toBeCloseTo(0.004, 10);
    // Entra na taxa: 1 chamada completou e truncou.
    expect(truncationStats([{ responses: [r] }])).toMatchObject({ calls: 1, truncated: 1 });
  });
});

describe('IMPL-014 (i) — gabarito: sinais persistidos, retry x2 e régua cortada descartada', () => {
  let anterior: OpenRouterGateway | undefined;
  let silencio: Array<{ mockRestore(): void }> = [];
  beforeEach(() => {
    silencio = [vi.spyOn(console, 'warn').mockImplementation(() => undefined)];
  });
  afterEach(() => {
    if (anterior) setDefaultGateway(anterior);
    anterior = undefined;
    silencio.forEach((s) => s.mockRestore());
  });

  it('1ª truncada, retry completa: referência usada e onCall com truncationRetried', async () => {
    const fake = fakeOpenRouter({
      chat: (_r, n) => (n === 0 ? { text: '', finishReason: 'length' } : { text: 'Gabarito completo.', finishReason: 'stop' }),
    });
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    const calls = new Map<number, CallFinishSignals>();
    const out = await generateReferences({
      stages: [STAGE],
      apiKey: KEY,
      modelId: 'ref',
      onCall: (i, c) => calls.set(i, c),
    });
    expect(fake.chatRequests().map((p) => p.body?.max_tokens)).toEqual([1500, 3000]);
    expect(out[0].reference).toBe('Gabarito completo.');
    expect(calls.get(0)).toMatchObject({ finishReason: 'stop', truncated: false, truncationRetried: true, maxTokens: 3000 });
  });

  it('truncada nas duas: referência DESCARTADA (etapa segue sem gabarito) e sinal truncated persistido', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: 'Gabarito pela met', finishReason: 'length' }) });
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    const calls = new Map<number, CallFinishSignals>();
    const out = await generateReferences({ stages: [STAGE], apiKey: KEY, modelId: 'ref', onCall: (i, c) => calls.set(i, c) });
    expect(out[0].reference).toBeUndefined();
    expect(calls.get(0)).toMatchObject({ finishReason: 'length', truncated: true, truncationRetried: true });
  });

  it('finishSignalsOf copia a decisão do gateway (não recalcula)', () => {
    const s = finishSignalsOf({ text: 'abc', tokensOut: 9, finishReason: 'stop', truncated: false }, 100);
    expect(s).toEqual({ finishReason: 'stop', tokensOut: 9, contentChars: 3, maxTokens: 100, truncated: false });
  });
});

// ---------------------------------------------------------------------------
// Pipeline inteiro (Node + SPA): etapa incomplete fora do placar e das médias
// ---------------------------------------------------------------------------

const CENARIOS = [
  { question: 'Pergunta 1 sobre trocas', productContext: 'Trocas em 30 dias.', maxTokens: 300, rubric: 'Cita 30 dias.' },
  { question: 'Pergunta 2 sobre juros', productContext: 'M = C(1+i)^n.', maxTokens: 300, rubric: 'Cita a fórmula.' },
];

/** `fake/long` trunca SEMPRE na Pergunta 1 (inclusive no retry x2); o resto completa. */
function fakeDaRun() {
  return fakeOpenRouter({
    catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b', 'fake/long'].map((id) =>
      catalogItem(id, 1e-9, 1e-9),
    ),
    chat: (req) => {
      if (req.model === 'fake/gen') return { text: JSON.stringify({ stages: CENARIOS }) };
      if (req.model === 'fake/ref') return { text: `Gabarito: ${req.user.slice(0, 30)}`, finishReason: 'stop', nativeFinishReason: 'end_turn' };
      if (req.stream) {
        if (req.model === 'fake/long' && req.user.includes('Pergunta 1')) {
          return { text: 'Resposta longa cortada no', finishReason: 'length', nativeFinishReason: 'max_tokens' };
        }
        return { text: `Resposta de ${req.model}`, finishReason: 'stop', nativeFinishReason: 'end_turn' };
      }
      if (req.system.includes('DUELO')) return { text: '{"winner":"A","explanation":"A melhor"}' };
      return { text: '{"verdict":"resolve","explanation":"confere"}', finishReason: 'stop' };
    },
  });
}

const CONFIG = {
  mode: 'compare',
  theme: 'suporte',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b', 'fake/long'],
  finalists: 2,
  timeoutMs: 5_000,
} as const;

function conferirTruncamento(rec: RunRecord, fake: ReturnType<typeof fakeDaRun>, eventos: RunEvent[]): void {
  expect(rec.status, rec.error).toBe('finished');
  const i1 = rec.stages.findIndex((s) => s.spec?.question.includes('Pergunta 1'));
  const i2 = rec.stages.findIndex((s) => s.spec?.question.includes('Pergunta 2'));
  const [st1, st2] = [rec.stages[i1], rec.stages[i2]];

  // (ii) etapa com resposta truncada: incomplete por truncamento, NÃO julgada.
  expect(st1.incomplete).toBe(true);
  expect(st1.incompleteReason).toBe('truncation');
  expect(st1.judge).toBeUndefined();
  expect(st1.referenceJudge).toBeUndefined();
  expect(st1.duels).toBeUndefined();
  expect(st2.incomplete).toBeFalsy();
  expect(st2.referenceJudge?.verdictByContestant).toEqual({ 'fake/a': 'resolve', 'fake/b': 'resolve', 'fake/long': 'resolve' });
  // Nenhuma chamada de juiz sobre a etapa truncada (não paga veredito descartado).
  expect(fake.chatRequests().filter((r) => r.model === 'fake/judge' && r.user.includes('Pergunta 1'))).toHaveLength(0);
  // O competidor truncado foi repetido 1x com teto x2 — e só 1x.
  const longP1 = fake.chatRequests().filter((r) => r.model === 'fake/long' && r.user.includes('Pergunta 1'));
  expect(longP1.map((r) => r.body?.max_tokens)).toEqual([300, 600]);

  // Fora do PLACAR: 3 contestants numa só etapa julgada => 2+1+0 = 3 pontos.
  expect(Object.values(rec.scoreboard).reduce((a, b) => a + b, 0)).toBe(3);
  // Fora das MÉDIAS: se a etapa contasse como 'nao', o judge-score seria 50.
  expect(rec.judgeScoreByContestant).toEqual({ 'fake/a': 100, 'fake/b': 100, 'fake/long': 100 });

  // Evento visível, sem texto de resposta.
  const ev = eventos.find((e) => e.type === 'stage.incomplete');
  expect(ev).toMatchObject({ type: 'stage.incomplete', stageIndex: i1, reason: 'truncation', contestantIds: ['fake/long'] });
  expect(JSON.stringify(ev)).not.toContain('Resposta longa cortada');

  // (i) finishReason/nativeFinishReason em 100% das respostas de competidor…
  const respostas = rec.stages.flatMap((s) => s.responses);
  expect(respostas).toHaveLength(6);
  for (const r of respostas) {
    expect(r.finishReason, r.contestantId).toBeTruthy();
    expect(r.nativeFinishReason, r.contestantId).toBeTruthy();
    expect(typeof r.truncated).toBe('boolean');
    expect(r.maxTokens).toBeGreaterThan(0);
  }
  const truncada = st1.responses.find((r) => r.contestantId === 'fake/long')!;
  expect(truncada).toMatchObject({ truncated: true, truncationRetried: true, maxTokens: 600, finishReason: 'length' });
  // …e de gabarito (1 chamada por cenário).
  for (const st of [st1, st2]) {
    expect(st.gabaritoCall).toMatchObject({ finishReason: 'stop', nativeFinishReason: 'end_turn', truncated: false });
  }
  // O custo das DUAS tentativas fica na fatia do contestant (usage.cost default 0.001).
  expect(rec.costByContestant?.['fake/long']).toBeCloseTo(0.003, 10);

  // truncationRate: gabaritos 2 + etapa 1 (a, b, long×2) + etapa 2 (3) = 9 chamadas, 2 truncadas.
  expect(rec.truncationCounts).toEqual({ calls: 9, truncated: 2 });
  expect(rec.truncationRate).toBe(Number((2 / 9).toFixed(4)));

  // (iv) sobrevive a um F5 (disco/IndexedDB): nada engolido pelo whitelist.
  const relido = normalizeRunRecord(JSON.parse(JSON.stringify(rec)));
  expect(relido.truncationRate).toBe(rec.truncationRate);
  expect(relido.truncationCounts).toEqual(rec.truncationCounts);
  expect(relido.stages[i1]).toMatchObject({ incomplete: true, incompleteReason: 'truncation' });
  expect(relido.stages[i1].gabaritoCall).toEqual(st1.gabaritoCall);
  expect(relido.stages[i1].responses.find((r) => r.contestantId === 'fake/long')).toEqual(truncada);
}

describe('IMPL-014 (ii) — run inteira: etapa truncada fica incomplete e fora do placar/médias', () => {
  let anterior: OpenRouterGateway | undefined;
  let dirAnterior: string;
  let tmp: string;
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl014-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
  });
  afterEach(() => {
    if (anterior) setDefaultGateway(anterior);
    anterior = undefined;
  });
  afterAll(() => {
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('Node (src/orchestrator)', async () => {
    const fake = fakeDaRun();
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    const eventos: RunEvent[] = [];
    const unsub = subscribe('run-impl014-node', (e) => eventos.push(e));
    try {
      const rec = await runNode(CONFIG as unknown as RunConfig, KEY, { runId: 'run-impl014-node' });
      conferirTruncamento(rec, fake, eventos);
    } finally {
      unsub();
    }
  });

  it('SPA (web/src/engine/orchestrator) — mirror com o mesmo resultado', async () => {
    const fake = fakeDaRun();
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    const eventos: RunEvent[] = [];
    const unsub = subscribeRun('run-impl014-web', (e) => eventos.push(e as unknown as RunEvent));
    try {
      const rec = await runWeb(CONFIG as never, KEY, { runId: 'run-impl014-web' });
      conferirTruncamento(rec as unknown as RunRecord, fake, eventos);
    } finally {
      unsub();
    }
  });

  it.skipIf(!temWebDeps)('reducer da UI marca a etapa incomplete ao receber stage.incomplete (fora de ordem)', async () => {
    const { applyEvent } = await import('../web/src/pages/runShared');
    const prev = {
      id: 'r',
      status: 'running',
      config: { mode: 'compare', competitorModelIds: [], judgeModelIds: [] },
      stages: [{ index: 0, responses: [], startedAt: 'x' }],
      scoreboard: {},
      totalCostUsd: 0,
      startedAt: 'x',
    };
    const next = applyEvent(prev as never, {
      type: 'stage.incomplete',
      runId: 'r',
      stageIndex: 0,
      reason: 'truncation',
      detail: 'x',
    });
    expect(next.stages[0]).toMatchObject({ incomplete: true, incompleteReason: 'truncation' });
    // Índice inexistente não quebra (evento antes do stage.generating).
    expect(() => applyEvent(prev as never, { type: 'stage.incomplete', stageIndex: 5, reason: 'truncation' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// (iii) CLI: --json e NDJSON
// ---------------------------------------------------------------------------

describe('IMPL-014 (iii) — `run --json` emite truncationRate e o alerta acima de 2%', () => {
  let dir: string;
  let prevDataDir: string;
  let restore: OpenRouterGateway | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pb-impl014-cli-'));
    prevDataDir = getDataDir();
    restore = setDefaultGateway(createGateway({ fetch: fakeDaRun().fetch, sleep: noSleep }));
  });
  afterEach(() => {
    if (restore) setDefaultGateway(restore);
    setDataDir(prevDataDir);
    rmSync(dir, { recursive: true, force: true });
  });

  it('compare ponta a ponta (gateway falso): truncationRate, truncationCounts e truncationAlert no payload; alerta no stderr', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => (stdout.push(String(c)), true)),
      vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => (stderr.push(String(c)), true)),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    let code: number;
    try {
      code = await cmdRun('compare', [
        '--theme', 'suporte',
        '--stages', '2',
        '--models', 'fake/a,fake/b,fake/long',
        '--judge', 'fake/judge',
        '--datagen', 'fake/gen',
        '--reference', 'fake/ref',
        '--max-output-tokens', '300',
        '--no-duels',
        '--budget', '5',
        '--yes',
        '--json',
        '--key', KEY,
        '--data-dir', dir,
        '--refresh-models',
      ]);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join('')) as { ok: boolean; data: Record<string, unknown> };
    expect(payload.ok).toBe(true);
    const counts = payload.data.truncationCounts as { calls: number; truncated: number };
    expect(counts.truncated).toBe(2); // fake/long na Pergunta 1: 1ª + retry x2
    expect(payload.data.truncationRate).toBe(Number((counts.truncated / counts.calls).toFixed(4)));
    expect(payload.data.truncationRate as number).toBeGreaterThan(TRUNCATION_ALERT_RATE);
    expect(payload.data.truncationAlert).toMatch(/acima do limite de 2%/);
    // Narração (stderr) também avisa; o stdout segue sendo SÓ o payload JSON.
    expect(stderr.join('')).toMatch(/truncadas no teto de tokens/);
  });

  it('NDJSON: stage.incomplete enxuto e run.finished com truncationRate; sem alerta em ≤ 2%', () => {
    const linhas: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => (linhas.push(String(c)), true));
    try {
      const out = new Output({ format: 'ndjson' });
      emitRunEvent(out, {
        type: 'stage.incomplete',
        runId: 'r',
        stageIndex: 3,
        reason: 'truncation',
        detail: 'Etapa 4 incompleta por truncamento',
        contestantIds: ['m/x'],
      });
      const base = { id: 'r', status: 'finished', config: { stages: 1 }, mode: 'compare', contestants: [], stages: [], scoreboard: {}, totalCostUsd: 0, startedAt: 'x' };
      emitRunEvent(out, { type: 'run.finished', runId: 'r', record: { ...base, truncationRate: 0.02, truncationCounts: { calls: 100, truncated: 2 } } as unknown as RunRecord });
      emitRunEvent(out, { type: 'run.finished', runId: 'r', record: { ...base, truncationRate: 0.5, truncationCounts: { calls: 2, truncated: 1 } } as unknown as RunRecord });
      // Record anterior ao IMPL-014: nenhum campo novo inventado.
      emitRunEvent(out, { type: 'run.finished', runId: 'r', record: base as unknown as RunRecord });
    } finally {
      spy.mockRestore();
    }
    const ev = linhas.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(ev[0]).toMatchObject({ type: 'stage.incomplete', stageIndex: 3, reason: 'truncation', contestantIds: ['m/x'] });
    expect(ev[1]).toMatchObject({ type: 'run.finished', truncationRate: 0.02, truncationCounts: { calls: 100, truncated: 2 } });
    expect(ev[1].truncationAlert).toBeUndefined();
    expect(ev[2].truncationAlert).toMatch(/1 de 2 chamadas \(50,0%\)/);
    expect('truncationRate' in ev[3]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (iv) whitelists silenciosos
// ---------------------------------------------------------------------------

describe('IMPL-014 (iv) — whitelists: normalizeRunRecord e variationConfigFrom', () => {
  it('normalizeRunRecord preserva truncationRate/Counts, incompleteReason, gabaritoCall e os sinais das respostas', () => {
    const raw = JSON.parse(
      JSON.stringify({
        id: 'r1',
        status: 'finished',
        config: { mode: 'compare', competitorModelIds: ['m'], judgeModelIds: [] },
        stages: [
          {
            index: 0,
            startedAt: 'x',
            incomplete: true,
            incompleteReason: 'truncation',
            gabaritoCall: { finishReason: 'stop', tokensOut: 10, contentChars: 40, maxTokens: 1500, truncated: false },
            responses: [
              {
                modelId: 'm',
                text: 'cortad',
                status: 'ok',
                finishReason: 'length',
                nativeFinishReason: 'max_tokens',
                truncated: true,
                reasoningTokens: 12,
                maxTokens: 600,
                truncationSignals: ['finish_length', 'native_length'],
                truncationRetried: true,
              },
            ],
          },
        ],
        scoreboard: {},
        totalCostUsd: 0,
        startedAt: 'x',
        truncationRate: 0.6667,
        truncationCounts: { calls: 3, truncated: 2 },
      }),
    );
    const rec = normalizeRunRecord(raw);
    expect(rec.truncationRate).toBe(0.6667);
    expect(rec.truncationCounts).toEqual({ calls: 3, truncated: 2 });
    expect(rec.stages[0]).toMatchObject({
      incomplete: true,
      incompleteReason: 'truncation',
      gabaritoCall: { finishReason: 'stop', maxTokens: 1500, truncated: false },
    });
    expect(rec.stages[0].responses[0]).toMatchObject({
      contestantId: 'm',
      finishReason: 'length',
      nativeFinishReason: 'max_tokens',
      truncated: true,
      reasoningTokens: 12,
      maxTokens: 600,
      truncationSignals: ['finish_length', 'native_length'],
      truncationRetried: true,
    });
  });

  it('IMPL-014 não cria campo de CONFIG (política fixa); a run derivada por variationConfigFrom aplica o truncamento igual', async () => {
    const silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    const tmp = mkdtempSync(join(tmpdir(), 'pb-impl014-train-'));
    const dirAnterior = getDataDir();
    setDataDir(tmp);
    // A variante "verbosa" trunca sempre na Pergunta 1; a base completa.
    const fake = fakeOpenRouter({
      catalog: ['fake/c', 'fake/ref', 'fake/judge'].map((id) => catalogItem(id, 1e-9, 1e-9)),
      chat: (req) => {
        if (req.model === 'fake/ref') return { text: 'Gabarito.', finishReason: 'stop' };
        if (req.stream) {
          if (req.system.includes('VERBOSA') && req.user.includes('Pergunta 1')) {
            return { text: 'Longa demais', finishReason: 'length' };
          }
          return { text: 'Curta.', finishReason: 'stop' };
        }
        if (req.system.includes('DUELO')) return { text: '{"winner":"A","explanation":"ok"}' };
        return { text: '{"verdict":"resolve","explanation":"ok"}', finishReason: 'stop' };
      },
    });
    const anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    try {
      const training: TrainingConfig = {
        mode: 'training',
        theme: 'suporte',
        stages: 2,
        datagenModelId: 'fake/ref',
        judgeModelIds: ['fake/judge'],
        referenceModelId: 'fake/ref',
        contestantModelId: 'fake/c',
        basePrompt: 'Seja breve.',
        iterations: 1,
        customStages: CENARIOS,
        finalists: 0,
        timeoutMs: 5_000,
      };
      const cfg = variationConfigFrom(training);
      // Nenhuma chave de truncamento na config: a política vive no motor.
      expect(Object.keys(cfg).filter((k) => /trunc/i.test(k))).toEqual([]);
      const contestants: Contestant[] = [
        { id: 'original', label: 'base', modelId: 'fake/c', systemPrompt: 'Seja breve.', isOriginal: true },
        { id: 'v1', label: 'verbosa', modelId: 'fake/c', systemPrompt: 'Seja VERBOSA.' },
      ];
      const rec = await runNode(cfg, KEY, { contestants });
      expect(rec.status, rec.error).toBe('finished');
      const st1 = rec.stages.find((s) => s.spec?.question.includes('Pergunta 1'))!;
      expect(st1).toMatchObject({ incomplete: true, incompleteReason: 'truncation' });
      expect(rec.judgeScoreByContestant).toEqual({ original: 100, v1: 100 });
      expect(rec.truncationCounts).toEqual({ calls: 7, truncated: 2 }); // 2 gabaritos + (1 + 2) + 2
    } finally {
      setDefaultGateway(anterior);
      setDataDir(dirAnterior);
      rmSync(tmp, { recursive: true, force: true });
      silencio.forEach((s) => s.mockRestore());
    }
  });
});
