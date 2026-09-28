// IMPL-015 (R-08:REC-11) — saída de juiz TRUNCADA não é veredito.
//
// Antes: o juiz (pointwise, listwise, duelos) jogava fora os sinais de fim da
// chamada (`.text` só) e parseava o que viesse. Uma resposta cortada por
// `max_tokens` cujo pedaço por acaso fosse um JSON válido virava veredito
// normal ('parcial' inclusive); um pedaço inválido ganhava um 2º pedido com
// lembrete de formato (gasto inútil: o problema é o teto, não o formato).
// Contratos provados aqui (transporte FALSO, zero rede, zero gasto):
//  (i)   finish_reason length (ou timeout) => veredito INVÁLIDO (kind
//        'truncated'/'timeout'), fora do placar/médias, e evento
//        `judge.truncated` visível — pointwise, listwise e duelo, Node e SPA;
//  (ii)  nenhum 'parcial' (nem empate) nasce de conteúdo truncado — fixture de
//        JSON cortado e de JSON completo com finish_reason length;
//  (iii) taxa de truncamento por papel × esforço no relatório (record →
//        `--json`/NDJSON/UI), alerta por célula acima de 1%.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway, type FetchLike } from '../src/openrouter.js';
import { judgeStageReference } from '../src/refJudge.js';
import { judgeStage } from '../src/judge.js';
import { runStageDuels as runDuelsNode } from '../src/duels.js';
import { runStageDuels as runDuelsWeb } from '../web/src/engine/duels.js';
import { callJudgeWithRetry } from '../src/engine/judgeRetry.js';
import {
  cloneFinishCounts,
  cutDuels,
  cutVerdicts,
  EFFORT_DEFAULT,
  effortLabelOf,
  emptyFinishCounts,
  judgeReplyCut,
  tallyFinish,
  TRUNCATION_CELL_ALERT_RATE,
  truncationByRoleEffort,
  truncationCellAlert,
} from '../src/engine/truncation.js';
import { BudgetLedger } from '../src/budget.js';
import { judgeScoreFromVerdicts } from '../src/rank.js';
import { normalizeRunRecord } from '../src/normalize.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { subscribe } from '../src/events.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { subscribeRun } from '../web/src/engine/events.js';
import { Output, resetOutputState } from '../src/cli/output.js';
import { emitRunEvent, truncationFields } from '../src/cli/ndjson.js';
import type {
  CompetitorResponse,
  Contestant,
  FinishSignalCounts,
  RunConfig,
  RunEvent,
  RunRecord,
  StageSpec,
  Verdict,
} from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeRequest } from './fakeOpenRouter.js';
import { candidateOf, duelReply, listwiseReply, pointwiseReply, questionOf } from './judgeReplies.js';

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

const STAGE: StageSpec = {
  question: 'Qual o prazo para trocar um produto?',
  productContext: 'Trocas em até 30 dias com nota fiscal.',
  maxTokens: 200,
  reference: 'Trinta dias a partir do recebimento, com nota fiscal.',
};

const resp = (id: string, text: string): CompetitorResponse => ({
  contestantId: id,
  modelId: 'fake/a',
  text,
  latencyMs: 1,
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
  status: 'ok',
});
const cont = (id: string): Contestant => ({ id, label: id, modelId: 'fake/a' });

async function comGateway<T>(fetch: FetchLike, fn: () => Promise<T>): Promise<T> {
  const anterior = setDefaultGateway(createGateway({ fetch, sleep: noSleep }));
  try {
    return await fn();
  } finally {
    setDefaultGateway(anterior);
  }
}

/** Corta um JSON no meio (o que o provedor devolve com finish_reason length). */
const cortado = (json: string): string => json.slice(0, Math.floor(json.length * 0.6));

// ---------------------------------------------------------------------------
// Núcleo: checagem ANTES do parse
// ---------------------------------------------------------------------------

describe('IMPL-015 — judgeRetry checa o fim da chamada ANTES do parse', () => {
  it('finish_reason length com JSON VÁLIDO: veredito inválido (truncated), 1 chamada, parse nunca roda', async () => {
    const parse = vi.fn(() => 'parcial' as const);
    const lembretes: (string | undefined)[] = [];
    const r = await callJudgeWithRetry({
      call: async (reminder) => {
        lembretes.push(reminder);
        return { text: '{"verdict":"parcial"}', finishReason: 'length', nativeFinishReason: 'max_tokens' };
      },
      parse,
      formatReminder: 'LEMBRETE',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('truncated');
      expect(r.error.message).toMatch(/cortada no teto de tokens \(length \/ max_tokens\)/);
    }
    expect(r.calls).toBe(1);
    expect(lembretes).toEqual([undefined]); // truncamento NÃO ganha lembrete de formato
    expect(parse).not.toHaveBeenCalled();
  });

  it('só o nativo (MAX_TOKENS) ou só a decisão do gateway (raciocínio no teto) também invalidam', async () => {
    for (const reply of [
      { text: '{"verdict":"resolve"}', finishReason: 'stop', nativeFinishReason: 'MAX_TOKENS' },
      { text: '', finishReason: 'stop', truncated: true, truncationSignals: ['reasoning_at_cap', 'empty_with_tokens'] },
    ]) {
      const parse = vi.fn(() => 'x');
      const r = await callJudgeWithRetry({ call: async () => reply, parse, formatReminder: 'L' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('truncated');
      expect(parse).not.toHaveBeenCalled();
    }
  });

  it('finish_reason timeout: 1 nova chance (política do timeout); dois => kind timeout', async () => {
    let n = 0;
    const r = await callJudgeWithRetry({
      call: async () => {
        n += 1;
        return { text: '{"verdict":"resolve"}', finishReason: 'timeout' };
      },
      parse: () => 'resolve',
      formatReminder: 'L',
    });
    expect(n).toBe(2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('timeout');

    let m = 0;
    const recupera = await callJudgeWithRetry({
      call: async () => (m++ === 0 ? { text: '{', finishReason: 'timeout' } : { text: 'ok', finishReason: 'stop' }),
      parse: (t) => (t === 'ok' ? 'resolve' : null),
      formatReminder: 'L',
    });
    expect(recupera).toMatchObject({ ok: true, value: 'resolve', calls: 2 });
  });

  it('saída completa (stop) e texto puro seguem para o parse normalmente', async () => {
    expect(judgeReplyCut({ text: 'x', finishReason: 'stop' })).toBeUndefined();
    expect(judgeReplyCut({ text: 'x' })).toBeUndefined();
    const r = await callJudgeWithRetry({ call: async () => 'ok', parse: (t) => t, formatReminder: 'L' });
    expect(r).toMatchObject({ ok: true, value: 'ok', calls: 1 });
  });
});

// ---------------------------------------------------------------------------
// (i)+(ii) Os 3 juízes com o gateway (fake): nenhum veredito de conteúdo cortado
// ---------------------------------------------------------------------------

describe('IMPL-015 — pointwise: truncado => SEM veredito, nunca parcial', () => {
  const base = { stage: STAGE, judgeModelIds: ['fake/judge'], apiKey: KEY, timeoutMs: 2_000 };

  it('JSON COMPLETO de "parcial" com finish_reason length: ausente (truncated), 1 pedido; o irmão fica intacto', async () => {
    const fake = fakeOpenRouter({
      chat: (req) =>
        candidateOf(req) === 'RESP-A'
          ? { text: pointwiseReply(req, 'parcial', 'parcialmente'), finishReason: 'length', nativeFinishReason: 'max_tokens' }
          : { text: pointwiseReply(req, 'resolve'), finishReason: 'stop' },
    });
    const r = await comGateway(fake.fetch, () =>
      judgeStageReference({
        ...base,
        responses: [resp('a', 'RESP-A'), resp('b', 'RESP-B')],
        contestants: [cont('a'), cont('b')],
      }),
    );
    // O código antigo aceitava o JSON (parse estrito passa) => 'parcial' inventado.
    expect('a' in r.verdictByContestant).toBe(false);
    expect(r.verdictErrorByContestant?.a?.kind).toBe('truncated');
    expect(r.explanationByContestant.a).toBeUndefined();
    expect(fake.chatRequests().filter((q) => candidateOf(q) === 'RESP-A')).toHaveLength(1);
    expect(r.verdictByContestant.b).toBe('resolve');
    expect(Object.values(r.verdictByContestant)).not.toContain('parcial');
    expect(judgeScoreFromVerdicts([r.verdictByContestant.a, r.verdictByContestant.b])).toBe(100);
    expect(cutVerdicts(r)).toEqual([{ contestantId: 'a', kind: 'truncated' }]);
  });

  it('JSON CORTADO no meio: truncated sem o 2º pedido com lembrete (antes: invalid_output após 2 chamadas)', async () => {
    const fake = fakeOpenRouter({
      chat: (req) => ({ text: cortado(pointwiseReply(req, 'parcial', 'faltou parte')), finishReason: 'length' }),
    });
    const r = await comGateway(fake.fetch, () =>
      judgeStageReference({ ...base, responses: [resp('a', 'RESP-A')], contestants: [cont('a')] }),
    );
    expect(r.verdictByContestant).toEqual({});
    expect(r.verdictErrorByContestant?.a?.kind).toBe('truncated');
    expect(fake.chatRequests()).toHaveLength(1);
    expect(fake.chatRequests()[0].user).not.toContain('LEMBRETE DE FORMATO');
    expect(r.inconclusive).toBe(true);
  });

  it('painel de 2 juízes, um truncado: o veredito vem SÓ do voto legítimo (degraded)', async () => {
    const fake = fakeOpenRouter({
      chat: (req) =>
        req.model === 'fake/j1'
          ? { text: pointwiseReply(req, 'parcial'), finishReason: 'length' }
          : { text: pointwiseReply(req, 'resolve'), finishReason: 'stop' },
    });
    const r = await comGateway(fake.fetch, () =>
      judgeStageReference({
        ...base,
        judgeModelIds: ['fake/j1', 'fake/j2'],
        responses: [resp('a', 'RESP-A')],
        contestants: [cont('a')],
      }),
    );
    expect(r.verdictByContestant.a).toBe('resolve');
    expect(r.verdictSourceByContestant?.a).toBe('degraded');
    expect(r.verdictTieByContestant).toBeUndefined();
  });
});

describe('IMPL-015 — listwise: truncado => todos SEM veredito, etapa inconclusiva', () => {
  it('ranking completo mas finish_reason length: nenhum veredito/aceitável; motivo truncated', async () => {
    const fake = fakeOpenRouter({
      chat: (req) => ({
        text: listwiseReply(req, ['A', 'B'], [
          { label: 'A', justificativa: 'ok', veredito: 'resolve' },
          { label: 'B', justificativa: 'meio', veredito: 'parcial' },
        ]),
        finishReason: 'length',
      }),
    });
    const r = await comGateway(fake.fetch, () =>
      judgeStage({
        apiKey: KEY,
        stage: STAGE,
        judgeModelIds: ['fake/judge'],
        timeoutMs: 2_000,
        responses: [resp('a', 'RESP-A'), resp('b', 'RESP-B')],
      }),
    );
    expect(r.verdictByContestant).toEqual({});
    expect(r.acceptableByContestant).toEqual({});
    expect(r.rankedContestantIds).toEqual([]);
    expect(r.verdictErrorByContestant?.a?.kind).toBe('truncated');
    expect(r.verdictErrorByContestant?.b?.kind).toBe('truncated');
    expect(r.inconclusive).toBe(true);
    expect(fake.chatRequests()).toHaveLength(1);
  });
});

describe.each([
  ['src/duels', runDuelsNode],
  ['web/src/engine/duels', runDuelsWeb],
] as const)('IMPL-015 — %s: duelo truncado fica SEM resultado, nunca empate', (_nome, runStageDuels) => {
  it('uma ordem com finish_reason length => failedDuels (truncated); o par não pontua nem empata', async () => {
    const fake = fakeOpenRouter({
      chat: (req) => {
        const aPrimeiro = req.user.indexOf('TXT-A') < req.user.indexOf('TXT-B');
        // Ordem (a, b): o juiz declara empate, mas foi cortado — um "tie" inventado.
        return aPrimeiro
          ? { text: duelReply(req, 'tie', 'iguais'), finishReason: 'length' }
          : { text: duelReply(req, 'tie', 'iguais'), finishReason: 'stop' };
      },
    });
    const d = await comGateway(fake.fetch, () =>
      runStageDuels({
        stage: STAGE,
        judgeModelId: 'fake/judge',
        apiKey: KEY,
        topK: 0,
        timeoutMs: 2_000,
        responses: [resp('a', 'TXT-A'), resp('b', 'TXT-B')],
        contestants: ['a', 'b'].map(cont),
        duelists: ['a', 'b'],
      }),
    );
    expect(d.duels).toEqual([]);
    expect(d.failedDuels).toHaveLength(1);
    expect(d.failedDuels![0].error.kind).toBe('truncated');
    // Só a ordem LEGÍTIMA fica registrada (auditoria); a cortada não.
    const f = d.failedDuels![0];
    expect([f.order1, f.order2].filter(Boolean)).toEqual([expect.objectContaining({ winner: 'tie' })]);
    const cortes = cutDuels(d);
    expect(cortes.map((c) => c.kind)).toEqual(['truncated']);
    expect([cortes[0].a, cortes[0].b].sort()).toEqual(['a', 'b']);
    // Nenhum 0,5 de empate: o par saiu do numerador E do denominador.
    expect(d.winRate).toEqual({ a: 0, b: 0 });
  });
});

// ---------------------------------------------------------------------------
// (iii) papel × esforço
// ---------------------------------------------------------------------------

describe('IMPL-015 (iii) — taxa de truncamento por papel × esforço', () => {
  const msgs = [{ role: 'user' as const, content: 'oi' }];

  it('o gateway grava o esforço EFETIVO do corpo (high/off/padrão) no agregado do ledger', async () => {
    const respostas = [
      { text: '{"v":1}', finishReason: 'stop' },
      { text: '{"v":', finishReason: 'length', nativeFinishReason: 'max_tokens' },
      { text: 'ok', finishReason: 'stop' },
      { text: 'ok', finishReason: 'stop' },
    ];
    const fake = fakeOpenRouter({ chat: (_r, n) => respostas[n] });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const ledger = new BudgetLedger();
    const call = (reasoningLevel?: 'high' | 'off') =>
      gw.chatCompletion({ apiKey: KEY, modelId: 'j', messages: msgs, maxTokens: 1024, role: 'judge', sink: ledger, reasoningLevel });
    await call('high');
    await call('high');
    await call('off');
    await call();
    const bodies = fake.chatRequests().map((r) => r.body?.reasoning);
    expect(bodies).toEqual([{ effort: 'high' }, { effort: 'high' }, { enabled: false }, undefined]);
    const judge = ledger.snapshot().finishByRole.judge!;
    expect(judge).toMatchObject({ calls: 4, truncated: 1 });
    expect(judge.byEffort).toEqual({ high: { calls: 2, truncated: 1 }, off: { calls: 1, truncated: 0 } });
    expect(truncationByRoleEffort({ judge })).toEqual([
      { role: 'judge', effort: 'high', calls: 2, truncated: 1, rate: 0.5, alert: true },
      { role: 'judge', effort: 'off', calls: 1, truncated: 0, rate: 0, alert: false },
      { role: 'judge', effort: EFFORT_DEFAULT, calls: 1, truncated: 0, rate: 0, alert: false },
    ]);
  });

  it('limiar por célula: 1% exato não alerta, acima de 1% alerta; record antigo cai todo em "padrão"', () => {
    expect(TRUNCATION_CELL_ALERT_RATE).toBe(0.01);
    const mk = (calls: number, truncated: number, byEffort?: FinishSignalCounts['byEffort']): FinishSignalCounts => ({
      ...emptyFinishCounts(),
      calls,
      truncated,
      ...(byEffort ? { byEffort } : {}),
    });
    const celulas = truncationByRoleEffort({
      duel: mk(300, 3, { high: { calls: 100, truncated: 1 }, low: { calls: 100, truncated: 2 } }),
      competitor: mk(50, 0),
    });
    expect(celulas.map((c) => [c.role, c.effort, c.rate, c.alert])).toEqual([
      ['competitor', EFFORT_DEFAULT, 0, false],
      ['duel', 'high', 0.01, false],
      ['duel', 'low', 0.02, true],
      ['duel', EFFORT_DEFAULT, 0, false],
    ]);
    const alerta = truncationCellAlert(celulas);
    expect(alerta).toMatch(/acima de 1% por papel × esforço/);
    expect(alerta).toMatch(/duelo @ low: 2 de 100 \(2,0%\)/);
    expect(alerta).not.toMatch(/@ high/);
    expect(truncationCellAlert(truncationByRoleEffort({ duel: mk(100, 1, { high: { calls: 100, truncated: 1 } }) }))).toBeUndefined();
  });

  it('tallyFinish/cloneFinishCounts/effortLabelOf: contagem por esforço e cópia profunda', () => {
    const c = emptyFinishCounts();
    tallyFinish(c, { tokensOut: 1, contentChars: 1, truncated: true, effort: 'xhigh' });
    tallyFinish(c, { tokensOut: 1, contentChars: 1, truncated: false });
    expect(c.byEffort).toEqual({ xhigh: { calls: 1, truncated: 1 } });
    const copia = cloneFinishCounts(c);
    copia.byEffort!.xhigh.calls = 99;
    expect(c.byEffort!.xhigh.calls).toBe(1);
    expect(effortLabelOf({ reasoning: { effort: 'minimal' } })).toBe('minimal');
    expect(effortLabelOf({ reasoning: { enabled: false } })).toBe('off');
    expect(effortLabelOf({})).toBeUndefined();
  });

  it('relatório: --json/NDJSON levam as células e o alerta > 1%; judge.truncated enxuto; F5 preserva byEffort', () => {
    const finishSignalsByRole = {
      judge: {
        calls: 14,
        truncated: 1,
        finishReasons: { stop: 13, length: 1 },
        nativeFinishReasons: {},
        signals: { finish_length: 1 },
        byEffort: { high: { calls: 14, truncated: 1 } },
      },
      competitor: { calls: 86, truncated: 0, finishReasons: { stop: 86 }, nativeFinishReasons: {}, signals: {} },
    };
    const base = { id: 'r', status: 'finished', config: { stages: 1 }, mode: 'compare', contestants: [], stages: [], scoreboard: {}, totalCostUsd: 0, startedAt: 'x' };
    const rec = { ...base, truncationRate: 0.01, truncationCounts: { calls: 100, truncated: 1 }, finishSignalsByRole } as unknown as RunRecord;
    const campos = truncationFields(rec);
    // A run inteira está em 1% (sem o alerta de 2%), mas a célula juiz@high está em 7,1%.
    expect(campos.truncationAlert).toBeUndefined();
    expect(campos.truncationByRoleEffort).toEqual([
      { role: 'competitor', effort: EFFORT_DEFAULT, calls: 86, truncated: 0, rate: 0, alert: false },
      { role: 'judge', effort: 'high', calls: 14, truncated: 1, rate: 0.0714, alert: true },
    ]);
    expect(campos.truncationCellAlert).toMatch(/juiz @ high: 1 de 14 \(7,1%\)/);
    expect(normalizeRunRecord(JSON.parse(JSON.stringify(rec))).finishSignalsByRole).toEqual(finishSignalsByRole);

    resetOutputState();
    const linhas: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => (linhas.push(String(c)), true));
    try {
      const out = new Output({ format: 'ndjson' });
      emitRunEvent(out, {
        type: 'judge.truncated',
        runId: 'r',
        stageIndex: 2,
        phase: 'judge',
        contestantIds: ['m/x'],
        kinds: ['truncated'],
        detail: 'Etapa 3: saída do juiz cortada',
      });
      emitRunEvent(out, { type: 'run.finished', runId: 'r', record: rec });
    } finally {
      spy.mockRestore();
    }
    const ev = linhas.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(ev[0]).toMatchObject({ type: 'judge.truncated', stageIndex: 2, phase: 'judge', contestantIds: ['m/x'], kinds: ['truncated'] });
    expect(ev[1].truncationCellAlert).toMatch(/juiz @ high/);
    expect(ev[1].truncationByRoleEffort).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Pipeline completo, nos DOIS motores (transporte falso)
// ---------------------------------------------------------------------------

const SETE: StageSpec[] = Array.from({ length: 7 }, (_, i) => ({
  question: `CEN-${i} Qual o prazo de troca do item ${i}?`,
  productContext: 'Trocas em até 30 dias com nota fiscal.',
  maxTokens: 200,
  reference: `Trinta dias (item ${i}).`,
}));

const JUIZ_COM_ESFORCO = catalogItem('fake/judge', 1e-9, 1e-9, {
  supported_parameters: ['temperature', 'max_tokens', 'response_format', 'reasoning'],
  reasoning: { supported_efforts: ['high', 'medium', 'low'] },
});

/**
 * O juiz pointwise trunca ao julgar fake/b no CEN-0 (com um 'parcial' em JSON
 * VÁLIDO — o código antigo o registrava) e o juiz de duelo trunca no CEN-1
 * (com um empate válido — o antigo o contava). Todo o resto completa.
 */
function fakeComJuizTruncado() {
  return fakeOpenRouter({
    catalog: [JUIZ_COM_ESFORCO, ...['fake/a', 'fake/b', 'fake/ref', 'fake/gen'].map((id) => catalogItem(id, 1e-9, 1e-9))],
    chat: (req: FakeRequest) => {
      if (req.stream) return { text: `Resposta de ${req.model}`, finishReason: 'stop' };
      if (req.model === 'fake/ref') return { text: 'gabarito', finishReason: 'stop' };
      const q = questionOf(req);
      if (req.system.includes('DUELO')) {
        return q.startsWith('CEN-1')
          ? { text: duelReply(req, 'tie'), finishReason: 'length', nativeFinishReason: 'max_tokens' }
          : { text: duelReply(req, 'A'), finishReason: 'stop' };
      }
      if (q.startsWith('CEN-0') && candidateOf(req) === 'Resposta de fake/b') {
        return { text: pointwiseReply(req, 'parcial', 'cortado'), finishReason: 'length', nativeFinishReason: 'max_tokens' };
      }
      return { text: pointwiseReply(req, 'resolve'), finishReason: 'stop' };
    },
  });
}

const CONFIG = {
  mode: 'compare',
  theme: 'suporte',
  stages: 7,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  customStages: SETE,
  finalists: 2,
  reasoning: { judge: 'high' },
  timeoutMs: 5_000,
} as const;

function conferir(rec: RunRecord, eventos: RunEvent[], fake: ReturnType<typeof fakeComJuizTruncado>): void {
  const i0 = rec.stages.findIndex((s) => s.spec?.question.startsWith('CEN-0'));
  const i1 = rec.stages.findIndex((s) => s.spec?.question.startsWith('CEN-1'));
  const [s0, s1] = [rec.stages[i0], rec.stages[i1]];

  // (i) pointwise: o item fica INVÁLIDO — sem veredito, motivo truncated, fora do placar.
  expect(s0.referenceJudge?.verdictByContestant['fake/b']).toBeUndefined();
  expect(s0.referenceJudge?.verdictErrorByContestant?.['fake/b']?.kind).toBe('truncated');
  expect(s0.judge?.rankedContestantIds).toEqual(['fake/a']);
  expect(s0.judge?.acceptableByContestant['fake/b']).toBeUndefined();
  // Sem 2º pedido com lembrete para o veredito truncado.
  const pedidosB0 = fake
    .chatRequests()
    .filter((r) => !r.system.includes('DUELO') && questionOf(r).startsWith('CEN-0') && candidateOf(r) === 'Resposta de fake/b');
  expect(pedidosB0).toHaveLength(1);
  // (ii) nenhum 'parcial' no record: o único 'parcial' do fake veio truncado.
  for (const s of rec.stages) {
    expect(Object.values(s.referenceJudge?.verdictByContestant ?? {})).not.toContain('parcial' satisfies Verdict);
    expect(Object.values(s.judge?.verdictByContestant ?? {})).not.toContain('parcial' satisfies Verdict);
  }
  // Média: fake/b tem 6 'resolve' julgados => 100 (imputar 'parcial' daria 92,9).
  expect(rec.judgeScoreByContestant).toEqual({ 'fake/a': 100, 'fake/b': 100 });
  expect(rec.failureCountByRole?.judge).toBe(1);

  // Duelo do CEN-1: sem resultado (nunca o empate que o juiz cortado "disse").
  expect(s1.duels?.duels).toEqual([]);
  expect(s1.duels?.failedDuels?.map((d) => d.error.kind)).toEqual(['truncated']);
  expect(rec.failureCountByRole?.duel).toBe(1);

  // Evento VISÍVEL nos dois casos — ids e motivo, sem texto de resposta.
  const cortes = eventos.filter((e): e is Extract<RunEvent, { type: 'judge.truncated' }> => e.type === 'judge.truncated');
  expect(cortes).toHaveLength(2);
  const doJuiz = cortes.find((e) => e.phase === 'judge')!;
  expect(doJuiz).toMatchObject({ stageIndex: i0, contestantIds: ['fake/b'], kinds: ['truncated'] });
  expect(doJuiz.detail).toMatch(new RegExp(`^Etapa ${i0 + 1}: saída do juiz cortada ao julgar fake/b \\(teto de tokens\\)`));
  expect(doJuiz.detail).not.toContain('Resposta de fake/b');
  const doDuelo = cortes.find((e) => e.phase === 'duel')!;
  expect(doDuelo).toMatchObject({ stageIndex: i1, kinds: ['truncated'] });
  expect([...doDuelo.contestantIds].sort()).toEqual(['fake/a', 'fake/b']);
  expect(doDuelo.detail).toMatch(/duelo SEM resultado/);

  // (iii) papel × esforço no record: juiz e duelo em `high` (as DUAS ordens do
  // duelo do CEN-1 truncaram: 2 de 14 chamadas de duelo).
  const porPapel = rec.finishSignalsByRole!;
  expect(porPapel.judge?.byEffort).toEqual({ high: { calls: 14, truncated: 1 } });
  expect(porPapel.duel?.byEffort).toEqual({ high: { calls: 14, truncated: 2 } });
  const celulas = truncationFields(rec).truncationByRoleEffort!;
  expect(celulas.filter((c) => c.alert).map((c) => `${c.role}@${c.effort}`)).toEqual(['judge@high', 'duel@high']);
  expect(truncationFields(rec).truncationCellAlert).toMatch(/juiz @ high: 1 de 14 \(7,1%\).*duelo @ high: 2 de 14 \(14,3%\)/);
}

describe('IMPL-015 — pipeline: juiz/duelo truncado => veredito inválido + evento (Node e SPA)', () => {
  let dirAnterior: string;
  let tmp: string;
  let silencio: Array<{ mockRestore(): void }> = [];
  let anterior: ReturnType<typeof setDefaultGateway> | undefined;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl015-'));
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
    const fake = fakeComJuizTruncado();
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    const eventos: RunEvent[] = [];
    const unsub = subscribe('run-impl015-node', (e) => eventos.push(e));
    try {
      const rec = await runNode(CONFIG as unknown as RunConfig, KEY, { runId: 'run-impl015-node' });
      conferir(rec, eventos, fake);
    } finally {
      unsub();
    }
  });

  it('SPA (web/src/engine/orchestrator) — mirror', async () => {
    const fake = fakeComJuizTruncado();
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    const eventos: RunEvent[] = [];
    const unsub = subscribeRun('run-impl015-web', (e) => eventos.push(e as unknown as RunEvent));
    try {
      const rec = await runWeb(CONFIG as never, KEY, { runId: 'run-impl015-web' });
      conferir(rec as unknown as RunRecord, eventos, fake);
    } finally {
      unsub();
    }
  });
});
