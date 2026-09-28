// IMPL-060 (R-02b:REC-1) — dossiê POR VARIANTE das lições GEPA, nos dois motores.
//
// Critérios de aceite:
//  1) snapshot do payload do reescritor com pergunta NÃO truncada, resposta,
//     explicação integral do juiz e ≥ 1 entrada de acerto;
//  2) cada variante lê as lições da SUA run (duas runs com falhas distintas ⇒
//     payloads distintos);
//  3) truncagem explícita reportada em log (nunca silenciosa);
//  4) cobertura do dossiê = 100% das falhas com resposta + explicação integral,
//     e a reflexão LLM custa UMA chamada limitada por iteração (≤ 10% do custo
//     da iteração, que emite stages × contestants × (competidor + juiz)).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Contestant,
  RunRecord,
  SessionEvent,
  SessionRecord,
  StageRecord,
  StageSpec,
  TrainingConfig,
  Verdict,
} from '../src/types.js';
import {
  DEFAULT_LESSON_TOKENS,
  buildLessonDossier,
  buildLessons,
  lessonTruncationNotice,
  renderLessonDossier,
} from '../src/trainer.js';
import * as webTrainer from '../web/src/engine/trainer.js';
import { MAX_TOKENS_REWRITER } from '../src/engine/callCaps.js';
import { llmReflectLessons } from '../src/variator.js';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { fakeOpenRouter, catalogItem, noSleep } from './fakeOpenRouter.js';

// ----------------------------------------------------------------------------
// Fixtures puras (sem LLM, sem rede)
// ----------------------------------------------------------------------------

const PERGUNTA_LONGA =
  'Qual é a política de reembolso para assinaturas anuais canceladas depois do prazo de ' +
  'carência de 30 dias, considerando descontos promocionais já aplicados na primeira fatura ' +
  'e a proporcionalidade dos meses restantes do contrato?';
const RESPOSTA_LONGA =
  'Segundo a política vigente, assinaturas anuais canceladas após o prazo de carência de 30 dias ' +
  'não têm direito a reembolso integral; aplica-se devolução proporcional aos meses não ' +
  'consumidos, descontando-se o valor promocional concedido na primeira fatura, que é ' +
  'recuperado integralmente antes do cálculo da restituição ao cliente.';
const EXPLICACAO_LONGA =
  'A resposta erra o alvo em dois pontos decisivos: primeiro, afirma que não há reembolso quando ' +
  'a política prevê devolução proporcional aos meses não consumidos; segundo, omite que o ' +
  'desconto promocional da primeira fatura é recuperado ANTES do cálculo da restituição, o que ' +
  'muda o valor final recebido pelo cliente e é exatamente o núcleo da pergunta feita.';

function specDe(i: number, over: Partial<StageSpec> = {}): StageSpec {
  return {
    question: `Pergunta ${i} do cenário de suporte com enunciado longo o suficiente para nunca caber em 60 caracteres?`,
    productContext: 'ctx',
    maxTokens: 100,
    reference: `gabarito ${i}`,
    ...over,
  };
}

function stageDe(args: {
  index: number;
  spec: StageSpec;
  verdicts: Record<string, Verdict | undefined>;
  explanations?: Record<string, string>;
  responses?: Record<string, string>;
}): StageRecord {
  const responses = Object.entries(args.responses ?? {}).map(([contestantId, text]) => ({
    contestantId,
    text: text ?? '',
    status: 'ok' as const,
  }));
  const verdictByContestant: Record<string, Verdict> = {};
  for (const [id, v] of Object.entries(args.verdicts)) if (v) verdictByContestant[id] = v;
  return {
    index: args.index,
    spec: args.spec,
    responses,
    referenceJudge: {
      verdictByContestant,
      explanationByContestant: args.explanations ?? {},
      judgeModelId: 'fake/judge',
    },
    startedAt: '2026-09-27T00:00:00.000Z',
  } as unknown as StageRecord;
}

function runDe(id: string, stages: StageRecord[]): RunRecord {
  return {
    id,
    status: 'finished',
    config: { mode: 'variation' },
    mode: 'variation',
    contestants: [{ id: 'v0', label: 'v0', modelId: 'fake/a', systemPrompt: 'prompt' }],
    stages,
    scoreboard: {},
    totalCostUsd: 0,
    startedAt: '2026-09-27T00:00:00.000Z',
    finishedAt: '2026-09-27T00:00:01.000Z',
  } as unknown as RunRecord;
}

/** Os dois motores exportam o MESMO contrato de dossiê (mirror em par). */
const MOTORES = [
  ['Node', {
    buildLessonDossier: buildLessonDossier,
    renderLessonDossier: renderLessonDossier,
    lessonTruncationNotice: lessonTruncationNotice,
    buildLessons: buildLessons,
  }],
  ['SPA', {
    buildLessonDossier: webTrainer.buildLessonDossier,
    renderLessonDossier: webTrainer.renderLessonDossier,
    lessonTruncationNotice: webTrainer.lessonTruncationNotice,
    buildLessons: webTrainer.buildLessons,
  }],
] as const;

describe('IMPL-060 (1) — snapshot do payload do reescritor (pergunta/resposta/explicação integrais)', () => {
  for (const [nome, api] of MOTORES) {
    it(`${nome}: payload versionado com pergunta NÃO truncada, resposta, explicação integral e ≥ 1 acerto`, () => {
      const run = runDe('run-snap', [
        stageDe({
          index: 0,
          spec: specDe(0, { question: PERGUNTA_LONGA }),
          verdicts: { v0: 'nao' },
          explanations: { v0: EXPLICACAO_LONGA },
          responses: { v0: RESPOSTA_LONGA },
        }),
        stageDe({
          index: 1,
          spec: specDe(1),
          verdicts: { v0: 'parcial' },
          explanations: { v0: 'Faltou mencionar o prazo de carência.' },
          responses: { v0: 'Resposta parcial do candidato.' },
        }),
        stageDe({
          index: 2,
          spec: specDe(2),
          verdicts: { v0: 'resolve' },
          explanations: { v0: 'Cobriu tudo: prazo, proporcionalidade e recuperação do desconto.' },
          responses: { v0: 'Resposta completa do candidato.' },
        }),
      ]);
      const d = api.buildLessonDossier(run, 'v0');
      // SNAPSHOT do payload estruturado (R-02a:REC-2: campos versionados
      // pergunta/resposta/gabarito/veredito/explicacao). Igualdade EXATA com as
      // strings INTEIRAS reprova qualquer recorte novo (60/200 chars) em silêncio.
      expect(d).toEqual({
        version: 2,
        kind: 'licoes-gepa',
        contestantId: 'v0',
        runId: 'run-snap',
        falhas: [
          { pergunta: PERGUNTA_LONGA, resposta: RESPOSTA_LONGA, veredito: 'nao', explicacao: EXPLICACAO_LONGA },
          {
            pergunta: specDe(1).question.replace(/\s+/g, ' ').trim(),
            resposta: 'Resposta parcial do candidato.',
            veredito: 'parcial',
            explicacao: 'Faltou mencionar o prazo de carência.',
          },
        ],
        acertos: [
          {
            pergunta: specDe(2).question.replace(/\s+/g, ' ').trim(),
            resposta: 'Resposta completa do candidato.',
            veredito: 'resolve',
            explicacao: 'Cobriu tudo: prazo, proporcionalidade e recuperação do desconto.',
          },
        ],
      });
      // O TEXTO do reescritor (analysisHint → <licoes_da_iteracao_anterior>)
      // também carrega as strings integrais + o bloco de acertos.
      const texto = api.renderLessonDossier(d);
      expect(texto).toContain(PERGUNTA_LONGA);
      expect(texto).toContain(RESPOSTA_LONGA);
      expect(texto).toContain(EXPLICACAO_LONGA);
      expect(texto).toContain('Acertos representativos');
      expect(texto).toContain('Resposta completa do candidato.');
      expect(d.truncation).toBeUndefined(); // nada encurtou: cabe no default
    });
  }
});

describe('IMPL-060 (2) — lições da PRÓPRIA run da variante', () => {
  for (const [nome, api] of MOTORES) {
    it(`${nome}: duas runs com falhas distintas ⇒ payloads distintos (mesmo contestantId)`, () => {
      const runA = runDe('run-a', [
        stageDe({
          index: 0,
          spec: { ...specDe(0), question: 'FALHA-ALFA única da run A sobre faturamento?' },
          verdicts: { v0: 'nao' },
          explanations: { v0: 'explicacao-ALFA da run A' },
          responses: { v0: 'resposta-ALFA da run A' },
        }),
      ]);
      const runB = runDe('run-b', [
        stageDe({
          index: 0,
          spec: { ...specDe(0), question: 'FALHA-BETA única da run B sobre cancelamento?' },
          verdicts: { v0: 'nao' },
          explanations: { v0: 'explicacao-BETA da run B' },
          responses: { v0: 'resposta-BETA da run B' },
        }),
      ]);
      const dA = api.buildLessonDossier(runA, 'v0');
      const dB = api.buildLessonDossier(runB, 'v0');
      const tA = api.renderLessonDossier(dA);
      const tB = api.renderLessonDossier(dB);
      // Payloads distintos: cada variante vê as falhas da SUA run.
      expect(tA).not.toBe(tB);
      expect(dA.runId).toBe('run-a');
      expect(dB.runId).toBe('run-b');
      expect(tA).toContain('FALHA-ALFA');
      expect(tA).toContain('resposta-ALFA');
      expect(tA).toContain('explicacao-ALFA');
      expect(tA).not.toContain('FALHA-BETA');
      expect(tB).toContain('FALHA-BETA');
      expect(tB).not.toContain('FALHA-ALFA');
    });
  }
});

describe('IMPL-060 (3) — truncagem EXPLÍCITA (reportada, nunca silenciosa)', () => {
  for (const [nome, api] of MOTORES) {
    it(`${nome}: acima do teto os campos encolhem, o relato sai e NENHUMA falha é descartada`, () => {
      const gigante = (marca: string): string => `${marca} ${'x'.repeat(2400)}`;
      const run = runDe('run-big', [
        stageDe({ index: 0, spec: specDe(0), verdicts: { v0: 'nao' }, explanations: { v0: gigante('exp1') }, responses: { v0: gigante('resp1') } }),
        stageDe({ index: 1, spec: specDe(1), verdicts: { v0: 'nao' }, explanations: { v0: gigante('exp2') }, responses: { v0: gigante('resp2') } }),
        stageDe({ index: 2, spec: specDe(2), verdicts: { v0: 'nao' }, explanations: { v0: gigante('exp3') }, responses: { v0: gigante('resp3') } }),
      ]);
      const d = api.buildLessonDossier(run, 'v0', { maxLessonTokens: 600 });
      // Cobertura 100%: as 3 falhas continuam lá (critério 4).
      expect(d.falhas).toHaveLength(3);
      expect(d.truncation, 'sem relato de truncagem').toBeDefined();
      expect(d.truncation!.limitTokens).toBe(600);
      expect(d.truncation!.truncatedFields).toBeGreaterThanOrEqual(1);
      expect(d.truncation!.entries.length).toBeGreaterThanOrEqual(1);
      // Relato para o LOG (critério 3): texto que o trainer escreve em stderr.
      const aviso = api.lessonTruncationNotice(d)!;
      expect(aviso).toMatch(/dossie de licoes truncado para 600 tokens/);
      expect(aviso).toMatch(/nenhuma falha foi descartada/);
      // O render final cabe no teto (600 tokens × 4 chars).
      expect(api.renderLessonDossier(d).length).toBeLessThanOrEqual(600 * 4);
      // Campos truncados terminam em reticências; sem truncagem não há relato.
      expect(d.falhas[0].explicacao.endsWith('…')).toBe(true);
      const semCorte = api.buildLessonDossier(run, 'v0'); // default 4000 tokens
      expect(semCorte.truncation).toBeUndefined();
      expect(api.lessonTruncationNotice(semCorte)).toBeUndefined();
    });
  }
});

describe('IMPL-060 (4) — cobertura 100% das falhas + gabarito atrás de flag', () => {
  for (const [nome, api] of MOTORES) {
    it(`${nome}: toda falha tem resposta + explicação integral; veredito ausente nunca vira lição`, () => {
      const run = runDe('run-cov', [
        stageDe({ index: 0, spec: specDe(0), verdicts: { v0: 'nao' }, explanations: { v0: 'exp 0' }, responses: { v0: 'resp 0' } }),
        stageDe({ index: 1, spec: specDe(1), verdicts: { v0: 'parcial' }, explanations: { v0: 'exp 1' }, responses: { v0: 'resp 1' } }),
        stageDe({ index: 2, spec: specDe(2), verdicts: { v0: 'resolve' }, explanations: { v0: 'exp 2' }, responses: { v0: 'resp 2' } }),
        // Sem veredito (juiz falhou/competidor com erro): NUNCA é lição.
        stageDe({ index: 3, spec: specDe(3), verdicts: { v0: undefined }, explanations: { v0: 'erro de infra' }, responses: {} }),
        // 4 acertos: só 3 entram (máx. de acertos representativos).
        stageDe({ index: 4, spec: specDe(4), verdicts: { v0: 'resolve' }, explanations: { v0: 'exp 4' }, responses: { v0: 'resp 4' } }),
        stageDe({ index: 5, spec: specDe(5), verdicts: { v0: 'resolve' }, explanations: { v0: 'exp 5' }, responses: { v0: 'resp 5' } }),
        stageDe({ index: 6, spec: specDe(6), verdicts: { v0: 'resolve' }, explanations: { v0: 'exp 6' }, responses: { v0: 'resp 6' } }),
      ]);
      const d = api.buildLessonDossier(run, 'v0');
      // 100% das falhas (2), cada uma com resposta + explicação integral.
      expect(d.falhas).toHaveLength(2);
      for (const f of d.falhas) {
        expect(f.resposta.length).toBeGreaterThan(0);
        expect(f.explicacao.length).toBeGreaterThan(0);
        expect(f.veredito === 'nao' || f.veredito === 'parcial').toBe(true);
      }
      expect(d.falhas.map((f) => f.resposta)).toEqual(['resp 0', 'resp 1']);
      expect(d.falhas.map((f) => f.explicacao)).toEqual(['exp 0', 'exp 1']);
      // Acertos representativos: até 3.
      expect(d.acertos).toHaveLength(3);
      // Veredito ausente ficou de fora (a "falha" era do PIPELINE).
      expect(api.renderLessonDossier(d)).not.toContain('erro de infra');
    });

    it(`${nome}: gabarito fora do payload por DEFAULT; entra só com includeReference`, () => {
      const run = runDe('run-ref', [
        stageDe({ index: 0, spec: specDe(0), verdicts: { v0: 'nao' }, explanations: { v0: 'exp' }, responses: { v0: 'resp' } }),
      ]);
      const semFlag = api.buildLessonDossier(run, 'v0');
      expect('gabarito' in semFlag.falhas[0]).toBe(false);
      expect(api.renderLessonDossier(semFlag)).not.toContain('gabarito 0');
      const comFlag = api.buildLessonDossier(run, 'v0', { includeReference: true });
      expect(comFlag.falhas[0].gabarito).toBe('gabarito 0');
      expect(api.renderLessonDossier(comFlag)).toContain('gabarito: gabarito 0');
    });

    it(`${nome}: buildLessons = render do dossiê; default de teto é ${DEFAULT_LESSON_TOKENS} tokens`, () => {
      expect(DEFAULT_LESSON_TOKENS).toBe(4000);
      const run = runDe('run-bl', [
        stageDe({ index: 0, spec: specDe(0), verdicts: { v0: 'nao' }, explanations: { v0: 'exp' }, responses: { v0: 'resp' } }),
      ]);
      expect(api.buildLessons(run, 'v0')).toBe(api.renderLessonDossier(api.buildLessonDossier(run, 'v0')));
      // Sem falhas = '' (como antes) — nada é injetado no reescritor.
      const soAcertos = runDe('run-ok', [
        stageDe({ index: 0, spec: specDe(0), verdicts: { v0: 'resolve' }, explanations: { v0: 'exp' }, responses: { v0: 'resp' } }),
      ]);
      expect(api.buildLessons(soAcertos, 'v0')).toBe('');
    });
  }
});

// --- reflexão LLM: UMA chamada limitada por iteração (custo ≤ 10%) ------------

let prevGw: OpenRouterGateway | undefined;
let fakeReflexao: ReturnType<typeof fakeOpenRouter> | undefined;
describe('IMPL-060 (4b) — reflexão LLM: 1 chamada por iteração, teto MAX_TOKENS_REWRITER', () => {
  beforeAll(() => {
    fakeReflexao = fakeOpenRouter({
      catalog: ['fake/opt'].map((id) => catalogItem(id, 1e-6, 2e-6)),
      chat: () => ({ text: 'bloco de licoes reescrito' }),
    });
    prevGw = setDefaultGateway(createGateway({ fetch: fakeReflexao.fetch, sleep: noSleep }));
  });
  afterAll(() => {
    if (prevGw) setDefaultGateway(prevGw);
  });

  it('a reflexão é UM chatCompletion com teto explícito (vs stages × contestants da iteração)', async () => {
    const fake = fakeReflexao!;
    const antes = fake.billedCalls();
    const saida = await llmReflectLessons({
      apiKey: 'sk-or-v1-fake-key-para-teste-0000000000',
      modelId: 'fake/opt',
      baseLessons: 'Fraquezas: uma falha observada.',
    });
    expect(saida).toContain('bloco de licoes');
    // Exatamente UMA chamada por reflexão — o custo da reflexão é limitado a ela,
    // enquanto uma iteração emite stages × contestants × (competidor + juiz).
    expect(fake.billedCalls() - antes).toBe(1);
    const req = fake.chatRequests().at(-1)!;
    expect(req.body?.max_tokens).toBe(MAX_TOKENS_REWRITER);
  });
});

// ----------------------------------------------------------------------------
// Integração: laço real do treino com orchestrator/variator mockados — prova
// que o dossiê injetado no reescritor vem da run do DONO e que a truncagem
// chega ao LOG (critério 3).
// ----------------------------------------------------------------------------

const dubles = vi.hoisted(() => {
  type Kind = 'selection' | 'reeval' | 'holdout';
  interface Ctx {
    kind: Kind;
    iteration: number;
    scenario: number;
  }
  const estado: {
    politica: (ctx: Ctx, contestantId: string) => Verdict | undefined;
    nCenarios: number;
    variantes: string[];
    explicacao: (id: string, ctx: Ctx) => string;
    resposta: (id: string, ctx: Ctx) => string;
    geracoes: { analysisHint?: string; carryPrompt?: string }[];
  } = {
    politica: () => 'parcial',
    nCenarios: 6,
    variantes: ['v0', 'v1', 'v2'],
    explicacao: (id, ctx) => `explicacao-${id}-it${ctx.iteration}-c${ctx.scenario}`,
    resposta: (id, ctx) => `resposta-${id}-it${ctx.iteration}-c${ctx.scenario}`,
    geracoes: [],
  };

  function fakeRun(config: Record<string, unknown>, _key: string, opts: Record<string, unknown>): RunRecord {
    const contestants = opts.contestants as Contestant[];
    const pinned = opts.pinnedStages as StageSpec[] | undefined;
    const iteration = opts.iteration as number;
    const kind: Kind = contestants.some((c) => c.id === 'holdout-control')
      ? 'holdout'
      : config.duels === false
        ? 'reeval'
        : 'selection';
    const specs: StageSpec[] =
      pinned ??
      Array.from({ length: estado.nCenarios }, (_, i) => ({
        question: `cenario ${i}`,
        productContext: 'ctx',
        maxTokens: 100,
        reference: 'ref',
      }));
    const stages = specs.map((spec, i) => {
      const scenario = Number(spec.question.replace('cenario ', ''));
      const verdictByContestant: Record<string, Verdict> = {};
      const explanationByContestant: Record<string, string> = {};
      const responses: Record<string, unknown>[] = [];
      for (const c of contestants) {
        const v = estado.politica({ kind, iteration, scenario }, c.id);
        if (v) verdictByContestant[c.id] = v;
        const ctx = { kind, iteration, scenario };
        explanationByContestant[c.id] = estado.explicacao(c.id, ctx);
        responses.push({ contestantId: c.id, text: estado.resposta(c.id, ctx), status: 'ok' });
      }
      return {
        index: i,
        spec,
        responses,
        referenceJudge: { verdictByContestant, explanationByContestant, judgeModelId: 'fake/judge' },
        startedAt: '2026-09-27T00:00:00.000Z',
      };
    });
    const judgeScoreByContestant = Object.fromEntries(
      contestants.map((c) => {
        const vs = stages
          .map((s) => (s.referenceJudge as { verdictByContestant: Record<string, Verdict> }).verdictByContestant[c.id])
          .filter((v): v is Verdict => v !== undefined);
        const score = { resolve: 1, parcial: 0.5, nao: 0 } as const;
        return [c.id, vs.length ? (vs.reduce((a, v) => a + score[v], 0) / vs.length) * 100 : 0];
      }),
    );
    return {
      id: opts.runId as string,
      status: 'finished',
      config,
      mode: 'variation',
      contestants,
      stages,
      scoreboard: {},
      judgeScoreByContestant,
      totalCostUsd: 0,
      startedAt: '2026-09-27T00:00:00.000Z',
      finishedAt: '2026-09-27T00:00:01.000Z',
      sessionId: opts.sessionId as string,
      iteration,
    } as unknown as RunRecord;
  }

  function fakeGenerate(p: {
    modelId: string;
    includeOriginal?: boolean;
    originalPrompt?: string;
    carryPrompt?: string;
    analysisHint?: string;
  }): Contestant[] {
    estado.geracoes.push({ analysisHint: p.analysisHint, carryPrompt: p.carryPrompt });
    const out: Contestant[] = [];
    if (p.includeOriginal && p.originalPrompt) {
      out.push({ id: 'original', label: 'Original', modelId: p.modelId, systemPrompt: p.originalPrompt });
    }
    if (p.carryPrompt) out.push({ id: 'carry', label: 'Carry', modelId: p.modelId, systemPrompt: p.carryPrompt });
    for (const id of estado.variantes) {
      out.push({ id, label: id, modelId: p.modelId, systemPrompt: `prompt ${id}` , techniqueId: 'cot' });
    }
    return out;
  }

  return { estado, fakeRun, fakeGenerate };
});

vi.mock('../src/orchestrator.js', async (orig) => ({
  ...(await orig<typeof import('../src/orchestrator.js')>()),
  runToCompletion: vi.fn(async (c: Record<string, unknown>, k: string, o: Record<string, unknown>) =>
    dubles.fakeRun(c, k, o),
  ),
}));
vi.mock('../web/src/engine/orchestrator', async (orig) => ({
  ...(await orig<typeof import('../web/src/engine/orchestrator.js')>()),
  runToCompletion: vi.fn(async (c: Record<string, unknown>, k: string, o: Record<string, unknown>) =>
    dubles.fakeRun(c, k, o),
  ),
}));
// O web re-exporta o variator de src/ (shim): o mesmo dublê vale nos dois.
vi.mock('../src/variator.js', async (orig) => ({
  ...(await orig<typeof import('../src/variator.js')>()),
  generateContestants: vi.fn(async (p: Parameters<typeof dubles.fakeGenerate>[0]) => dubles.fakeGenerate(p)),
}));
vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

import { trainToCompletion } from '../src/trainer.js';
import { startTraining as startWebTraining } from '../web/src/engine/trainer.js';
import { subscribeSession as subscribeWebSession } from '../web/src/engine/events.js';
import { getDataDir, setDataDir } from '../src/storage.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const BASE = 'Voce e um atendente de suporte. Responda com base no contexto do produto.';

function config(over: Partial<TrainingConfig> = {}): TrainingConfig {
  return {
    mode: 'training',
    theme: 'suporte ao cliente',
    stages: 6,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceModelId: 'fake/ref',
    referenceJudging: true,
    contestantModelId: 'fake/a',
    basePrompt: BASE,
    iterations: 2,
    holdoutRatio: 0,
    timeoutMs: 5_000,
    ...over,
  } as TrainingConfig;
}

let dir: string;
let dataDirAnterior: string;
let gwCatalogo: OpenRouterGateway;
beforeAll(() => {
  dataDirAnterior = getDataDir();
  dir = mkdtempSync(join(tmpdir(), 'pb-impl060-'));
  setDataDir(dir);
  const fake = fakeOpenRouter({
    catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a'].map((id) => catalogItem(id, 1e-6, 2e-6)),
    chat: () => {
      throw new Error('o teste não deveria chamar chat/completions');
    },
  });
  gwCatalogo = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
});
afterAll(() => {
  setDefaultGateway(gwCatalogo);
  setDataDir(dataDirAnterior);
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  dubles.estado.geracoes = [];
  dubles.estado.nCenarios = 6;
  dubles.estado.variantes = ['v0', 'v1', 'v2'];
  dubles.estado.politica = () => 'parcial';
  dubles.estado.explicacao = (id, ctx) => `explicacao-${id}-it${ctx.iteration}-c${ctx.scenario}`;
  dubles.estado.resposta = (id, ctx) => `resposta-${id}-it${ctx.iteration}-c${ctx.scenario}`;
});

async function treinarNode(cfg: TrainingConfig, logs: string[]): Promise<SessionRecord> {
  const espiao = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  try {
    return await trainToCompletion(cfg, KEY);
  } finally {
    espiao.mockRestore();
  }
}

async function treinarWeb(cfg: TrainingConfig, logs: string[]): Promise<SessionRecord> {
  const espiao = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  try {
    const { sessionId, record } = await startWebTraining(cfg as never, KEY);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('sessão não terminou')), 10_000);
      const unsub = subscribeWebSession(sessionId, (e) => {
        if (e.type === 'session.finished' || e.type === 'session.error') {
          clearTimeout(t);
          unsub();
          resolve();
        }
      });
    });
    return record as unknown as SessionRecord;
  } finally {
    espiao.mockRestore();
  }
}

const MOTORES_INT = [
  ['Node', treinarNode],
  ['SPA', treinarWeb],
] as const;

describe('IMPL-060 — integração: dossiê do DONO no reescritor + truncagem no log', () => {
  for (const [nome, treinar] of MOTORES_INT) {
    it(`${nome}: lições da run do campeão (dono), com marcadores da SUA run — não de outra variante`, async () => {
      // Iteração 0: v0 resolve 15/20 (promove com p minúsculo no max-T) e erra
      // 5 (parcial) — são essas falhas que viram lições. Iteração 1: o dossiê
      // do reescritor vem da run do PRÓPRIO campeão ('v0').
      dubles.estado.nCenarios = 20;
      dubles.estado.politica = (c, id) =>
        c.iteration === 0 && id === 'v0' ? (c.scenario % 4 === 3 ? 'parcial' : 'resolve') : 'parcial';
      const logs: string[] = [];
      const rec = await treinar(config(), logs);
      expect(rec.status, rec.error).toBe('finished');
      const hint = dubles.estado.geracoes[1].analysisHint ?? '';
      expect(hint).not.toBe('');
      // Dono = v0 (campeão promovido na iteração 0): só as falhas DELE entram.
      expect(hint).toContain('explicacao-v0-it0');
      expect(hint).toContain('resposta-v0-it0');
      expect(hint).not.toContain('explicacao-original-it0');
      expect(hint).not.toContain('explicacao-carry-it0');
      expect(hint).not.toContain('explicacao-v1-it0');
      // Acertos representativos no payload do reescritor.
      expect(hint).toContain('Acertos representativos');
    });

    it(`${nome}: truncagem do dossiê é reportada em LOG (nunca silenciosa)`, async () => {
      const gigante = (marca: string): string => `${marca} ${'x'.repeat(3000)}`;
      dubles.estado.nCenarios = 20;
      dubles.estado.politica = () => 'nao';
      dubles.estado.explicacao = (id, ctx) => gigante(`explicacao-${id}-it${ctx.iteration}`);
      dubles.estado.resposta = (id, ctx) => gigante(`resposta-${id}-it${ctx.iteration}`);
      const logs: string[] = [];
      const rec = await treinar(config({ maxLessonTokens: 300 }), logs);
      expect(rec.status, rec.error).toBe('finished');
      const aviso = logs.find((l) => l.includes('dossie de licoes truncado'));
      expect(aviso, `sem aviso de truncagem nos logs: ${logs.join('\n')}`).toBeDefined();
      expect(aviso).toMatch(/dossie de licoes truncado para 300 tokens/);
      expect(aviso).toMatch(/nenhuma falha foi descartada/);
    });
  }
});