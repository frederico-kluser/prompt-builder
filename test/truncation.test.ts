// IMPL-014 (R-07b:DEC-2 + REC-2) — truncamento detectado, repetido 1x com teto
// x2 e, persistindo, a etapa fica `incomplete` FORA do placar e das médias.
//
// Antes: `finish_reason` não era lido em lugar nenhum; resposta cortada por
// `max_tokens` (finish_reason: length) virava status 'ok' com texto truncado,
// entrava no placar e o juiz a punia como 'nao' — truncagem silenciosa. Contratos
// provados aqui (transporte FALSO, zero rede, zero gasto):
//  (i)   o record persiste finishReason/nativeFinishReason em 100% das chamadas
//        de competidor e de gabarito (por chamada, com a 1ª tentativa truncada
//        em `firstAttempt`) e de JUIZ/duelo/datagen (agregado por papel em
//        `finishSignalsByRole`, contado no gateway -> ledger — ponto único); a
//        `truncationRate` cobre TODOS os papéis. Invalidar o veredito de um
//        juiz truncado é o IMPL-015;
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
  truncationStatsByRole,
  tallyFinish,
  emptyFinishCounts,
  FINISH_ABSENT,
  FINISH_OTHER,
  MAX_REASON_KEYS,
  describeTruncatedReference,
} from '../src/engine/truncation.js';
import { competitorMaxTokens, ROLE_MAX_TOKENS } from '../src/roleLimits.js';
import { BudgetLedger } from '../src/budget.js';
import { normalizeRunRecord } from '../src/normalize.js';
import { variationConfigFrom } from '../src/trainer.js';
import { setDataDir, getDataDir } from '../src/storage.js';
import { subscribe } from '../src/events.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { subscribeRun } from '../web/src/engine/events.js';
import { cmdRun } from '../src/cli/commands/run.js';
import { Output } from '../src/cli/output.js';
import { emitRunEvent, truncationFields } from '../src/cli/ndjson.js';
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
// (i) Juiz/duelo/datagen: sinais de fim no ponto único (gateway -> ledger)
// ---------------------------------------------------------------------------

describe('IMPL-014 (i) — sinais de fim de TODO papel chegam ao ledger (juiz e duelo inclusive)', () => {
  it('juiz truncado é contado; falha in-band é cobrada SEM sinal de fim; sobe a cadeia; snapshot é cópia', async () => {
    const respostas: FakeChatReply[] = [
      { text: '{"verdict":"resolve","explanation":"ok"}', finishReason: 'stop', nativeFinishReason: 'end_turn' },
      // Juiz pointwise a 1024 com raciocínio alto: cortado no teto (o caso do IMPL-015).
      {
        text: '{"verdict":"res',
        finishReason: 'length',
        nativeFinishReason: 'max_tokens',
        usage: { prompt_tokens: 10, completion_tokens: 1024, cost: 0.002, completion_tokens_details: { reasoning_tokens: 1000 } },
      },
      // 200 com corpo de erro: cobrada, mas não completou — sem sinal de fim.
      { text: '', error: { message: 'provider rejeitou o parâmetro' } },
      // Duelo (stream) sem finish_reason: a ausência também é contada.
      { text: '{"winner":"A","explanation":"ok"}' },
    ];
    const fake = fakeOpenRouter({ chat: (_r, n) => respostas[n] });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const sessao = new BudgetLedger();
    const ledger = sessao.fork();
    await gw.chatCompletion({ apiKey: KEY, modelId: 'j', messages: msgs, maxTokens: 1024, role: 'judge', sink: ledger });
    const cortada = await gw.chatCompletion({ apiKey: KEY, modelId: 'j', messages: msgs, maxTokens: 1024, role: 'judge', sink: ledger });
    expect(cortada.truncated).toBe(true);
    await expect(
      gw.chatCompletion({ apiKey: KEY, modelId: 'j', messages: msgs, maxTokens: 1024, role: 'judge', sink: ledger }),
    ).rejects.toThrow(/provider rejeitou/);
    await gw.chatCompletionStream({ apiKey: KEY, modelId: 'd', messages: msgs, maxTokens: 512, role: 'duel', sink: ledger });

    const snap = ledger.snapshot();
    expect(snap.byRole.judge.calls).toBe(3); // a falha in-band foi cobrada…
    expect(snap.finishByRole.judge).toEqual({
      calls: 2, // …mas só as 2 que completaram têm sinal de fim
      truncated: 1,
      finishReasons: { stop: 1, length: 1 },
      nativeFinishReasons: { end_turn: 1, max_tokens: 1 },
      signals: { finish_length: 1, native_length: 1, reasoning_at_cap: 1 },
    });
    expect(snap.finishByRole.duel).toEqual({
      calls: 1,
      truncated: 0,
      finishReasons: { [FINISH_ABSENT]: 1 },
      nativeFinishReasons: { [FINISH_ABSENT]: 1 },
      signals: {},
    });
    expect(snap.finishByRole.competitor).toBeUndefined(); // só papéis com chamada
    // Sobe a cadeia como o custo: a sessão de treino vê o total.
    expect(sessao.snapshot().finishByRole.judge).toMatchObject({ calls: 2, truncated: 1 });
    // O snapshot vai direto para o record: não pode ser o objeto vivo do ledger.
    snap.finishByRole.judge!.calls = 99;
    snap.finishByRole.judge!.finishReasons.stop = 99;
    expect(ledger.snapshot().finishByRole.judge).toMatchObject({ calls: 2, finishReasons: { stop: 1 } });
  });

  it('finish_reason malformado (não-string) não lança antes da contabilidade: a chamada segue cobrada', async () => {
    const fake = fakeOpenRouter({
      chat: () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'veredito' }, finish_reason: 123, native_finish_reason: { x: 1 } }],
            usage: { prompt_tokens: 1, completion_tokens: 3, cost: 0.004 },
          }),
          { status: 200 },
        ),
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const ledger = new BudgetLedger();
    const r = await gw.chatCompletion({ apiKey: KEY, modelId: 'j', messages: msgs, maxTokens: 64, role: 'judge', sink: ledger });
    expect(r.finishReason).toBeUndefined();
    expect(r.truncated).toBe(false);
    expect(ledger.snapshot().spentUsd).toBeCloseTo(0.004, 10);
    expect(ledger.snapshot().finishByRole.judge).toMatchObject({ calls: 1, finishReasons: { [FINISH_ABSENT]: 1 } });
  });

  it('tallyFinish: ausente vira (none), histograma limitado a MAX_REASON_KEYS, sinais contados', () => {
    const c = emptyFinishCounts();
    tallyFinish(c, { tokensOut: 1, contentChars: 1, truncated: false });
    expect(c.finishReasons).toEqual({ [FINISH_ABSENT]: 1 });
    for (let k = 0; k < MAX_REASON_KEYS + 5; k++) {
      tallyFinish(c, { finishReason: `motivo-${k}`, tokensOut: 1, contentChars: 1, truncated: false });
    }
    // 1 (none) + 23 motivos preenchem as 24 chaves; os 6 seguintes caem em (other).
    expect(Object.keys(c.finishReasons)).toHaveLength(MAX_REASON_KEYS + 1);
    expect(c.finishReasons[FINISH_OTHER]).toBe(6);
    tallyFinish(c, { finishReason: 'motivo-0', tokensOut: 1, contentChars: 1, truncated: false });
    expect(c.finishReasons['motivo-0']).toBe(2); // chave conhecida segue contando
    expect(c.calls).toBe(MAX_REASON_KEYS + 7);

    const t = emptyFinishCounts();
    tallyFinish(t, { finishReason: 'length', tokensOut: 9, contentChars: 0, truncated: true, truncationSignals: ['finish_length', 'empty_with_tokens'] });
    expect(t).toEqual({
      calls: 1,
      truncated: 1,
      finishReasons: { length: 1 },
      nativeFinishReasons: { [FINISH_ABSENT]: 1 },
      signals: { finish_length: 1, empty_with_tokens: 1 },
    });
  });

  it('truncationStatsByRole soma TODOS os papéis; o alerta diz quais papéis truncaram', () => {
    const porPapel = { judge: { calls: 10, truncated: 3 }, competitor: { calls: 90, truncated: 0 } };
    const stats = truncationStatsByRole(porPapel);
    expect(stats).toEqual({ calls: 100, truncated: 3, rate: 0.03 });
    const msg = truncationAlert(stats, porPapel);
    expect(msg).toMatch(/3 de 100 chamadas \(3,0%\) saíram truncadas no teto de tokens \(juiz 3 de 10\)/);
    expect(msg).not.toMatch(/competidor/); // quem não truncou não aparece
    expect(truncationStatsByRole(undefined)).toEqual({ calls: 0, truncated: 0, rate: 0 });
  });
});

// ---------------------------------------------------------------------------
// Competidor e gabarito: 1 retry com teto x2
// ---------------------------------------------------------------------------

const STAGE: StageSpec = { question: 'Explique a política de trocas.', productContext: 'Trocas em 30 dias.', maxTokens: 300 };
// IMPL-016: o teto enviado é TOTAL — resposta + folga de raciocínio do degrau (aqui o padrão do modelo).
const C300 = competitorMaxTokens(300);
const C200 = competitorMaxTokens(200); // maxOutputTokens: 200 limita a RESPOSTA
const GAB = ROLE_MAX_TOKENS.gabarito;

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
    expect(pedidos.map((p) => p.body?.max_tokens)).toEqual([C300, retryMaxTokens(C300)]);
    expect(r).toMatchObject({
      status: 'ok',
      text: 'Resposta inteira.',
      truncated: false,
      truncationRetried: true,
      maxTokens: retryMaxTokens(C300),
      finishReason: 'stop',
      nativeFinishReason: 'end_turn',
      tokensOut: 350,
    });
    expect(r.costUsd).toBeCloseTo(0.005, 10);
    // A 1ª tentativa (a truncada) não some: sinal que disparou, teto e gasto de tokens.
    expect(r.firstAttempt).toEqual({
      finishReason: 'length',
      tokensOut: 300,
      contentChars: 'Metade da resp'.length,
      maxTokens: C300,
      truncated: true,
      truncationSignals: ['finish_length'],
    });
  });

  it('truncou nas DUAS: truncated=true, exatamente 2 chamadas (sem laço)', async () => {
    const fake = usar(() => ({ text: 'Cortada', finishReason: 'length', nativeFinishReason: 'MAX_TOKENS' }));
    const r = await runCompetitor({ apiKey: KEY, contestantId: 'c', modelId: 'm', stage: STAGE, maxOutputTokens: 200 });
    expect(fake.chatRequests().map((p) => p.body?.max_tokens)).toEqual([C200, retryMaxTokens(C200)]);
    expect(r).toMatchObject({
      status: 'ok',
      truncated: true,
      truncationRetried: true,
      maxTokens: retryMaxTokens(C200),
      finishReason: 'length',
      nativeFinishReason: 'MAX_TOKENS',
      truncationSignals: ['finish_length', 'native_length'],
    });
    expect(r.firstAttempt).toMatchObject({ truncated: true, maxTokens: C200, nativeFinishReason: 'MAX_TOKENS' });
  });

  it('resposta completa: 1 chamada, truncated=false persistido (sinal de fim em 100% das respostas)', async () => {
    const fake = usar(() => ({ text: 'ok', finishReason: 'stop' }));
    const r = await runCompetitor({ apiKey: KEY, contestantId: 'c', modelId: 'm', stage: STAGE });
    expect(fake.chatRequests()).toHaveLength(1);
    expect(r).toMatchObject({ truncated: false, finishReason: 'stop', maxTokens: C300 });
    expect(r.truncationRetried).toBeUndefined();
    expect(r.firstAttempt).toBeUndefined();
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
    // O retry falhou, mas os sinais da 1ª (truncada) ficam no record.
    expect(r.firstAttempt).toMatchObject({ truncated: true, finishReason: 'length', maxTokens: C300, tokensOut: 300 });
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
    expect(fake.chatRequests().map((p) => p.body?.max_tokens)).toEqual([GAB, retryMaxTokens(GAB)]);
    expect(out[0].reference).toBe('Gabarito completo.');
    expect(calls.get(0)).toMatchObject({ finishReason: 'stop', truncated: false, truncationRetried: true, maxTokens: retryMaxTokens(GAB) });
    // A 1ª tentativa (a truncada) fica em `firstAttempt` — antes o retry sobrescrevia.
    expect(calls.get(0)?.firstAttempt).toMatchObject({
      finishReason: 'length',
      truncated: true,
      maxTokens: GAB,
      truncationSignals: ['finish_length', 'empty_with_tokens'],
    });
  });

  it('truncada nas duas: referência DESCARTADA (etapa segue sem gabarito) e sinal truncated persistido', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: 'Gabarito pela met', finishReason: 'length' }) });
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    const calls = new Map<number, CallFinishSignals>();
    const out = await generateReferences({ stages: [STAGE], apiKey: KEY, modelId: 'ref', onCall: (i, c) => calls.set(i, c) });
    expect(out[0].reference).toBeUndefined();
    expect(calls.get(0)).toMatchObject({ finishReason: 'length', truncated: true, truncationRetried: true, maxTokens: retryMaxTokens(GAB) });
    expect(calls.get(0)?.firstAttempt).toMatchObject({ finishReason: 'length', truncated: true, maxTokens: GAB });
  });

  it('finishSignalsOf copia a decisão do gateway (não recalcula); com a 1ª tentativa marca o retry', () => {
    const s = finishSignalsOf({ text: 'abc', tokensOut: 9, finishReason: 'stop', truncated: false }, 100);
    expect(s).toEqual({ finishReason: 'stop', tokensOut: 9, contentChars: 3, maxTokens: 100, truncated: false });
    const primeira = finishSignalsOf({ text: '', tokensOut: 100, finishReason: 'length', truncated: true }, 100);
    const retry = finishSignalsOf({ text: 'abc', tokensOut: 9, finishReason: 'stop', truncated: false }, 200, primeira);
    expect(retry).toMatchObject({ truncationRetried: true, maxTokens: 200, firstAttempt: primeira });
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
  expect(longP1.map((r) => r.body?.max_tokens)).toEqual([C300, retryMaxTokens(C300)]);

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
  expect(truncada).toMatchObject({ truncated: true, truncationRetried: true, maxTokens: retryMaxTokens(C300), finishReason: 'length' });
  // …e de gabarito (1 chamada por cenário).
  for (const st of [st1, st2]) {
    expect(st.gabaritoCall).toMatchObject({ finishReason: 'stop', nativeFinishReason: 'end_turn', truncated: false });
  }
  // A 1ª tentativa (a truncada) fica persistida — qual sinal disparou e o teto.
  expect(truncada.firstAttempt).toMatchObject({
    finishReason: 'length',
    nativeFinishReason: 'max_tokens',
    truncated: true,
    maxTokens: C300,
    truncationSignals: ['finish_length', 'native_length'],
  });
  // O custo das DUAS tentativas fica na fatia do contestant (usage.cost default 0.001).
  expect(rec.costByContestant?.['fake/long']).toBeCloseTo(0.003, 10);

  // (i) JUIZ, duelo e datagen: os sinais de fim chegam ao record pelo ponto
  // único (gateway -> ledger -> finishSignalsByRole) — 100% das chamadas que
  // completaram, papel a papel, igual ao que o ledger cobrou.
  const porPapel = rec.finishSignalsByRole!;
  expect(Object.keys(porPapel).sort()).toEqual(['competitor', 'datagen', 'duel', 'gabarito', 'judge']);
  for (const papel of ['datagen', 'gabarito', 'competitor', 'judge', 'duel'] as const) {
    expect(porPapel[papel]!.calls, papel).toBe(rec.costByRole![papel].calls);
    const somaMotivos = Object.values(porPapel[papel]!.finishReasons).reduce((a, b) => a + b, 0);
    expect(somaMotivos, `${papel}: todo finish_reason contado (ausente = ${FINISH_ABSENT})`).toBe(porPapel[papel]!.calls);
  }
  // Juiz: 3 chamadas (só a Pergunta 2 foi julgada), finish_reason 'stop' nas 3.
  expect(porPapel.judge).toEqual({
    calls: 3,
    truncated: 0,
    finishReasons: { stop: 3 },
    nativeFinishReasons: { [FINISH_ABSENT]: 3 },
    signals: {},
  });
  // Competidor: 7 tentativas (a, b, long×2 na P1; 3 na P2), 2 truncadas.
  expect(porPapel.competitor).toEqual({
    calls: 7,
    truncated: 2,
    finishReasons: { stop: 5, length: 2 },
    nativeFinishReasons: { end_turn: 5, max_tokens: 2 },
    signals: { finish_length: 2, native_length: 2 },
  });
  expect(porPapel.gabarito).toMatchObject({ calls: 2, truncated: 0, finishReasons: { stop: 2 }, nativeFinishReasons: { end_turn: 2 } });
  // Duelo sem finish_reason (o fake não manda): a AUSÊNCIA também é registrada, não some.
  expect(porPapel.duel).toMatchObject({ calls: 2, truncated: 0, finishReasons: { [FINISH_ABSENT]: 2 } });
  expect(porPapel.datagen).toMatchObject({ calls: 1, truncated: 0 });
  // Nada escapa do agregado: soma dos papéis = toda requisição de chat que o fake viu.
  expect(fake.chatRequests()).toHaveLength(15);

  // truncationRate da run: TODOS os papéis — datagen 1 + gabaritos 2 +
  // competidor 7 + juiz 3 + duelo 2 = 15 chamadas, 2 truncadas.
  expect(rec.truncationCounts).toEqual({ calls: 15, truncated: 2 });
  expect(rec.truncationRate).toBe(Number((2 / 15).toFixed(4)));
  // Conferência independente: a visão por etapa (competidor + gabarito, sinais
  // guardados por chamada) bate com as duas fatias do agregado do ledger.
  expect(truncationStats(rec.stages)).toEqual({ calls: 9, truncated: 2, rate: Number((2 / 9).toFixed(4)) });
  expect(porPapel.competitor!.calls + porPapel.gabarito!.calls).toBe(9);

  // (iv) sobrevive a um F5 (disco/IndexedDB): nada engolido pelo whitelist.
  const relido = normalizeRunRecord(JSON.parse(JSON.stringify(rec)));
  expect(relido.truncationRate).toBe(rec.truncationRate);
  expect(relido.truncationCounts).toEqual(rec.truncationCounts);
  expect(relido.finishSignalsByRole).toEqual(rec.finishSignalsByRole);
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
    // stage.generated leva os sinais do gabarito (a UI marca "gabarito truncado" ao vivo).
    const gabaritoCall = { finishReason: 'length', tokensOut: 3000, contentChars: 0, maxTokens: 3000, truncated: true };
    const gerada = applyEvent(prev as never, {
      type: 'stage.generated',
      runId: 'r',
      stageIndex: 0,
      spec: { question: 'P?', productContext: 'ctx', maxTokens: 300 },
      gabaritoCall,
      warning: 'x',
    });
    expect(gerada.stages[0].gabaritoCall).toEqual(gabaritoCall);
  });
});

// ---------------------------------------------------------------------------
// (i) + aviso visível: juiz truncado no record e gabarito truncado descartado
// ---------------------------------------------------------------------------

/**
 * O gabarito da Pergunta 2 trunca SEMPRE (inclusive no retry x2) e o juiz
 * pointwise trunca ao julgar `fake/b` na Pergunta 1. Os competidores completam.
 */
function fakeJuizEGabaritoTruncados() {
  return fakeOpenRouter({
    catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b'].map((id) => catalogItem(id, 1e-9, 1e-9)),
    chat: (req) => {
      if (req.model === 'fake/gen') return { text: JSON.stringify({ stages: CENARIOS }) };
      if (req.model === 'fake/ref') {
        return req.user.includes('Pergunta 2')
          ? { text: 'Gabarito pela met', finishReason: 'length', nativeFinishReason: 'max_tokens' }
          : { text: 'Gabarito completo.', finishReason: 'stop', nativeFinishReason: 'end_turn' };
      }
      if (req.stream) return { text: `Resposta de ${req.model}`, finishReason: 'stop', nativeFinishReason: 'end_turn' };
      if (req.system.includes('juiz técnico estrito')) {
        // Pointwise: o raciocínio comeu o teto de 1024 ao julgar fake/b.
        return req.user.includes('Resposta de fake/b')
          ? { text: '{"verdict":"resolve","explanation":"confere"}', finishReason: 'length', nativeFinishReason: 'max_tokens' }
          : { text: '{"verdict":"resolve","explanation":"confere"}', finishReason: 'stop' };
      }
      // Listwise (etapa sem gabarito): ranking + vereditos válidos.
      return {
        text: JSON.stringify({
          ranking: ['A', 'B'],
          verdicts: [
            { label: 'A', acceptable: true, motivo: 'ok' },
            { label: 'B', acceptable: true, motivo: 'ok' },
          ],
        }),
        finishReason: 'stop',
      };
    },
  });
}

const CONFIG_JUIZ = {
  mode: 'compare',
  theme: 'suporte',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  finalists: 0,
  timeoutMs: 5_000,
} as const;

function conferirJuizEGabarito(rec: RunRecord, fake: ReturnType<typeof fakeJuizEGabaritoTruncados>, eventos: RunEvent[]): void {
  expect(rec.status, rec.error).toBe('finished');
  const i1 = rec.stages.findIndex((s) => s.spec?.question.includes('Pergunta 1'));
  const i2 = rec.stages.findIndex((s) => s.spec?.question.includes('Pergunta 2'));
  const [st1, st2] = [rec.stages[i1], rec.stages[i2]];

  // Gabarito da P2: truncado nas duas tentativas, descartado; 1ª tentativa persistida.
  expect(st2.spec?.reference).toBeUndefined();
  expect(st2.gabaritoCall).toMatchObject({
    finishReason: 'length',
    nativeFinishReason: 'max_tokens',
    truncated: true,
    truncationRetried: true,
    maxTokens: retryMaxTokens(GAB),
    firstAttempt: { finishReason: 'length', truncated: true, maxTokens: GAB },
  });
  // A etapa segue (julgada sem régua, listwise) — não é incomplete.
  expect(st2.incomplete).toBeFalsy();
  expect(st2.referenceJudge).toBeUndefined();
  expect(st2.judge?.inconclusive).toBeFalsy();
  // Aviso VISÍVEL no stage.generated (antes: só console.warn) — sem o texto do gabarito.
  const gerados = eventos.filter((e): e is Extract<RunEvent, { type: 'stage.generated' }> => e.type === 'stage.generated');
  const ev2 = gerados.find((e) => e.stageIndex === i2)!;
  expect(ev2.warning).toMatch(new RegExp(`Gabarito da etapa ${i2 + 1} truncado no teto de ${retryMaxTokens(GAB)} tokens`));
  expect(ev2.warning).toMatch(/julgada SEM gabarito/);
  expect(ev2.warning).not.toContain('Gabarito pela met');
  expect(ev2.gabaritoCall).toMatchObject({ truncated: true });
  expect(gerados.find((e) => e.stageIndex === i1)?.warning).toBeUndefined();
  expect(st1.gabaritoCall).toMatchObject({ truncated: false, finishReason: 'stop' });

  // (i) JUIZ: o finish_reason de 100% das chamadas do juiz está no record,
  // inclusive a truncada (antes o refJudge jogava o sinal fora).
  const juiz = rec.finishSignalsByRole!.judge!;
  expect(juiz.calls).toBe(rec.costByRole!.judge.calls);
  expect(juiz.calls).toBe(fake.chatRequests().filter((r) => r.model === 'fake/judge').length);
  expect(juiz).toEqual({
    calls: 3, // 2 pointwise (P1) + 1 listwise (P2)
    truncated: 1,
    finishReasons: { stop: 2, length: 1 },
    nativeFinishReasons: { [FINISH_ABSENT]: 2, max_tokens: 1 },
    signals: { finish_length: 1, native_length: 1 },
  });
  expect(rec.finishSignalsByRole!.gabarito).toMatchObject({ calls: 3, truncated: 2 });
  // A truncationRate conta o juiz: 1 (juiz) + 2 (gabarito da P2) de 11
  // chamadas (datagen 1 + gabaritos 3 + competidores 4 + juiz 3).
  expect(fake.chatRequests()).toHaveLength(11);
  expect(rec.truncationCounts).toEqual({ calls: 11, truncated: 3 });
  // O resultado (--json/NDJSON) quebra por papel e o alerta diz quem truncou.
  const campos = truncationFields(rec);
  expect(campos.truncationByRole).toMatchObject({ judge: { calls: 3, truncated: 1 }, gabarito: { calls: 3, truncated: 2 } });
  expect(campos.truncationAlert).toMatch(/gabarito 2 de 3/);
  expect(campos.truncationAlert).toMatch(/juiz 1 de 3/);

  // Sobrevive a um F5 (disco/IndexedDB).
  const relido = normalizeRunRecord(JSON.parse(JSON.stringify(rec)));
  expect(relido.finishSignalsByRole).toEqual(rec.finishSignalsByRole);
  expect(relido.stages[i2].gabaritoCall).toEqual(st2.gabaritoCall);
}

describe('IMPL-014 (i) — juiz truncado no record e gabarito truncado com aviso visível (Node + SPA)', () => {
  let anterior: OpenRouterGateway | undefined;
  let dirAnterior: string;
  let tmp: string;
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl014-juiz-'));
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
    const fake = fakeJuizEGabaritoTruncados();
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    const eventos: RunEvent[] = [];
    const unsub = subscribe('run-impl014-juiz-node', (e) => eventos.push(e));
    try {
      const rec = await runNode(CONFIG_JUIZ as unknown as RunConfig, KEY, { runId: 'run-impl014-juiz-node' });
      conferirJuizEGabarito(rec, fake, eventos);
    } finally {
      unsub();
    }
  });

  it('SPA (web/src/engine/orchestrator) — mirror', async () => {
    const fake = fakeJuizEGabaritoTruncados();
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    const eventos: RunEvent[] = [];
    const unsub = subscribeRun('run-impl014-juiz-web', (e) => eventos.push(e as unknown as RunEvent));
    try {
      const rec = await runWeb(CONFIG_JUIZ as never, KEY, { runId: 'run-impl014-juiz-web' });
      conferirJuizEGabarito(rec as unknown as RunRecord, fake, eventos);
    } finally {
      unsub();
    }
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
    // Quebra por papel (o juiz entra no denominador; quem truncou foi o competidor).
    const porPapel = payload.data.truncationByRole as Record<string, { calls: number; truncated: number }>;
    expect(porPapel.competitor).toEqual({ calls: 7, truncated: 2 });
    // compare clássico (sem julgamento por referência): a P2 é julgada listwise — 1 chamada de juiz.
    expect(porPapel.judge).toEqual({ calls: 1, truncated: 0 });
    expect(porPapel.datagen).toEqual({ calls: 1, truncated: 0 });
    expect(Object.values(porPapel).reduce((a, c) => a + c.calls, 0)).toBe(counts.calls);
    expect(counts).toEqual({ calls: 9, truncated: 2 });
    expect(payload.data.truncationAlert).toMatch(/\(competidor 2 de 7\)/);
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
      // Gabarito truncado e descartado: aviso no stage.generated (sem o texto do gabarito).
      const gabaritoCall = { finishReason: 'length', tokensOut: 3000, contentChars: 12, maxTokens: 3000, truncated: true };
      const spec = { question: 'P?', productContext: 'ctx', maxTokens: 300 };
      emitRunEvent(out, { type: 'stage.generated', runId: 'r', stageIndex: 1, spec, gabaritoCall, warning: describeTruncatedReference(1, gabaritoCall) });
      emitRunEvent(out, { type: 'stage.generated', runId: 'r', stageIndex: 0, spec: { ...spec, reference: 'ok' } });
      // Quebra por papel a partir do agregado do record.
      emitRunEvent(out, {
        type: 'run.finished',
        runId: 'r',
        record: {
          ...base,
          truncationRate: 0.1,
          truncationCounts: { calls: 10, truncated: 1 },
          finishSignalsByRole: {
            judge: { calls: 4, truncated: 1, finishReasons: { stop: 3, length: 1 }, nativeFinishReasons: {}, signals: {} },
            competitor: { calls: 6, truncated: 0, finishReasons: { stop: 6 }, nativeFinishReasons: {}, signals: {} },
          },
        } as unknown as RunRecord,
      });
    } finally {
      spy.mockRestore();
    }
    const ev = linhas.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(ev[0]).toMatchObject({ type: 'stage.incomplete', stageIndex: 3, reason: 'truncation', contestantIds: ['m/x'] });
    expect(ev[1]).toMatchObject({ type: 'run.finished', truncationRate: 0.02, truncationCounts: { calls: 100, truncated: 2 } });
    expect(ev[1].truncationAlert).toBeUndefined();
    expect(ev[2].truncationAlert).toMatch(/1 de 2 chamadas \(50,0%\)/);
    expect('truncationRate' in ev[3]).toBe(false);
    expect(ev[4]).toMatchObject({ type: 'stage.generated', stageIndex: 1, hasReference: false, referenceTruncated: true });
    expect(ev[4].warning).toMatch(/Gabarito da etapa 2 truncado no teto de 3000 tokens/);
    expect(ev[5]).toMatchObject({ type: 'stage.generated', stageIndex: 0, hasReference: true });
    expect('warning' in ev[5] || 'referenceTruncated' in ev[5]).toBe(false);
    // O histograma completo fica no record (`runs show`); o stream leva só calls/truncated.
    expect(ev[6].truncationByRole).toEqual({ judge: { calls: 4, truncated: 1 }, competitor: { calls: 6, truncated: 0 } });
    expect(ev[6].truncationAlert).toMatch(/\(juiz 1 de 4\)/);
  });
});

// ---------------------------------------------------------------------------
// (iv) whitelists silenciosos
// ---------------------------------------------------------------------------

describe('IMPL-014 (iv) — whitelists: normalizeRunRecord e variationConfigFrom', () => {
  it('normalizeRunRecord preserva truncationRate/Counts, finishSignalsByRole, incompleteReason, gabaritoCall e os sinais das respostas (com a 1ª tentativa)', () => {
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
            gabaritoCall: {
              finishReason: 'stop',
              tokensOut: 10,
              contentChars: 40,
              maxTokens: 3000,
              truncated: false,
              truncationRetried: true,
              firstAttempt: { finishReason: 'length', tokensOut: 1500, contentChars: 0, maxTokens: 1500, truncated: true },
            },
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
                firstAttempt: { finishReason: 'length', tokensOut: 300, contentChars: 4, maxTokens: 300, truncated: true },
              },
            ],
          },
        ],
        scoreboard: {},
        totalCostUsd: 0,
        startedAt: 'x',
        truncationRate: 0.6667,
        truncationCounts: { calls: 3, truncated: 2 },
        finishSignalsByRole: {
          judge: { calls: 1, truncated: 0, finishReasons: { stop: 1 }, nativeFinishReasons: { '(none)': 1 }, signals: {} },
        },
      }),
    );
    const rec = normalizeRunRecord(raw);
    expect(rec.truncationRate).toBe(0.6667);
    expect(rec.truncationCounts).toEqual({ calls: 3, truncated: 2 });
    expect(rec.finishSignalsByRole).toEqual({
      judge: { calls: 1, truncated: 0, finishReasons: { stop: 1 }, nativeFinishReasons: { '(none)': 1 }, signals: {} },
    });
    expect(rec.stages[0]).toMatchObject({
      incomplete: true,
      incompleteReason: 'truncation',
      gabaritoCall: { finishReason: 'stop', maxTokens: 3000, truncated: false, firstAttempt: { maxTokens: 1500, truncated: true } },
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
      firstAttempt: { finishReason: 'length', maxTokens: 300, truncated: true },
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
      // 2 gabaritos + competidor (1 + 2 na P1, 2 na P2) + juiz 2 (só a P2 julgada) = 9.
      expect(rec.truncationCounts).toEqual({ calls: 9, truncated: 2 });
      expect(rec.finishSignalsByRole?.judge).toMatchObject({ calls: 2, truncated: 0, finishReasons: { stop: 2 } });
      expect(truncationStats(rec.stages)).toMatchObject({ calls: 7, truncated: 2 });
    } finally {
      setDefaultGateway(anterior);
      setDataDir(dirAnterior);
      rmSync(tmp, { recursive: true, force: true });
      silencio.forEach((s) => s.mockRestore());
    }
  });
});
