// Integridade do holdout e das paradas do TREINO — dois motores (Node e SPA:
// o trainer é mirror editado em par).
//
//   web-code#1  a fatia de holdout NUNCA é vista pela seleção: a run da
//               iteração 0 cobre todos os cenários (é nela que eles nascem),
//               mas o gate, a re-avaliação e as lições da iteração seguinte
//               leem só as etapas de TREINO;
//   web-code#0  re-avaliação limpa abortada (cancelamento/orçamento) PARA a
//               sessão — antes o web seguia para a paciência e gravava
//               'finished' + 'converged';
//   cli#8       gate com re-avaliação interrompida não inventa "Δ +0.0pp em 5
//               cenários";
//   web-code#8  o MOTIVO de não haver holdout fica gravado
//   cli#9       (`holdoutSkipReason`) e é o que CLI/UI/handoff escrevem;
//   web-code#18 as runs de re-avaliação ficam alcançáveis (`reevalRunIds`),
//               fora de `runIds` (uma run por iteração + holdout).
//
// Orchestrator e reescritor trocados por dublês DETERMINÍSTICOS (vereditos por
// cenário ORIGINAL e por tipo de run). Sem rede, sem gasto.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Contestant,
  IterationGate,
  RunRecord,
  SessionEvent,
  SessionRecord,
  StageSpec,
  TrainingConfig,
  Verdict,
} from '../src/types.js';

type Kind = 'selection' | 'reeval' | 'holdout';
interface Ctx {
  kind: Kind;
  iteration: number;
  /** Índice do cenário na lista ORIGINAL (`cenario <i>`), não na run. */
  scenario: number;
}
type Politica = (ctx: Ctx, contestantId: string) => Verdict | undefined;
type Desfecho = { status: 'aborted' | 'error'; stoppedReason?: 'budget' | 'cancelled' } | undefined;

const dubles = vi.hoisted(() => {
  const estado: {
    politica: Politica;
    nCenarios: number;
    variantes: string[];
    /** Força o desfecho de um TIPO de run (a run não termina). */
    desfecho: Partial<Record<Kind, Desfecho>>;
    runs: { id: string; kind: Kind; iteration: number; ids: string[]; questions: string[] }[];
    geracoes: { analysisHint?: string }[];
  } = {
    politica: () => 'parcial',
    nCenarios: 20,
    variantes: ['v0', 'v1'],
    desfecho: {},
    runs: [],
    geracoes: [],
  };
  const score = { resolve: 1, parcial: 0.5, nao: 0 } as const;

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
    estado.runs.push({
      id: opts.runId as string,
      kind,
      iteration,
      ids: contestants.map((c) => c.id),
      questions: specs.map((s) => s.question),
    });
    const stages = specs.map((spec, i) => {
      const scenario = Number(spec.question.replace('cenario ', ''));
      const verdictByContestant: Record<string, Verdict> = {};
      const explanationByContestant: Record<string, string> = {};
      for (const c of contestants) {
        const v = estado.politica({ kind, iteration, scenario }, c.id);
        if (v) verdictByContestant[c.id] = v;
        explanationByContestant[c.id] = `motivo-${c.id}`;
      }
      return {
        index: i,
        spec,
        responses: [],
        referenceJudge: { verdictByContestant, explanationByContestant, judgeModelId: 'fake/judge' },
        startedAt: '2026-09-28T00:00:00.000Z',
      };
    });
    const judgeScoreByContestant = Object.fromEntries(
      contestants.map((c) => {
        const vs = stages
          .map((s) => s.referenceJudge.verdictByContestant[c.id])
          .filter((v): v is Verdict => v !== undefined);
        return [c.id, vs.length ? (vs.reduce((a, v) => a + score[v], 0) / vs.length) * 100 : 0];
      }),
    );
    const desfecho = estado.desfecho[kind];
    return {
      id: opts.runId as string,
      status: desfecho?.status ?? 'finished',
      ...(desfecho?.stoppedReason
        ? { stoppedReason: desfecho.stoppedReason, stoppedAtPhase: 'competitors', budgetExhausted: desfecho.stoppedReason === 'budget' }
        : {}),
      config,
      mode: 'variation',
      contestants,
      stages,
      scoreboard: {},
      judgeScoreByContestant,
      totalCostUsd: 0,
      startedAt: '2026-09-28T00:00:00.000Z',
      finishedAt: '2026-09-28T00:00:01.000Z',
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
    const g = estado.geracoes.push({ analysisHint: p.analysisHint });
    const out: Contestant[] = [];
    if (p.includeOriginal && p.originalPrompt) {
      out.push({ id: 'original', label: 'Original', modelId: p.modelId, systemPrompt: p.originalPrompt });
    }
    if (p.carryPrompt) out.push({ id: 'carry', label: 'Carry', modelId: p.modelId, systemPrompt: p.carryPrompt });
    estado.variantes.forEach((id) =>
      out.push({ id, label: id, modelId: p.modelId, systemPrompt: `prompt ${id} da geracao ${g}` }),
    );
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

import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { subscribeSession as subscribeNodeSession } from '../src/events.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { trainToCompletion } from '../src/trainer.js';
import { startTraining as startWebTraining } from '../web/src/engine/trainer.js';
import { subscribeSession } from '../web/src/engine/events.js';
import { formatIterationGate } from '../src/stats.js';
import {
  holdoutSkipReasonText,
  MIN_SCENARIOS_FOR_HOLDOUT,
  splitHoldout,
  trainOnlyView,
} from '../src/holdout.js';
import {
  convergenceReasonText,
  holdoutSkipReasonOf,
  reevalRunIdsOf,
  sessionConfirmationText,
} from '../src/engine/sessionDecision.js';
import { evaluateHandoffGuards } from '../src/engine/handoffGuards.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const BASE = 'Voce e um atendente de suporte. Responda com base no contexto do produto.';

function config(over: Partial<TrainingConfig> = {}): TrainingConfig {
  return {
    mode: 'training',
    theme: 'suporte ao cliente',
    stages: 20,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceModelId: 'fake/ref',
    referenceJudging: true,
    contestantModelId: 'fake/a',
    basePrompt: BASE,
    iterations: 1,
    holdoutRatio: 0.3,
    feedbackDriven: false,
    timeoutMs: 5_000,
    ...over,
  } as TrainingConfig;
}

let prevGw: OpenRouterGateway;
let dir: string;
let dataDirAnterior: string;
beforeAll(() => {
  dataDirAnterior = getDataDir();
  dir = mkdtempSync(join(tmpdir(), 'pb-holdout-integrity-'));
  setDataDir(dir);
  const fake = fakeOpenRouter({
    catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a'].map((id) => catalogItem(id, 1e-6, 2e-6)),
    chat: () => {
      throw new Error('o teste não deveria chamar chat/completions');
    },
  });
  prevGw = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
});
afterAll(() => {
  setDefaultGateway(prevGw);
  setDataDir(dataDirAnterior);
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  dubles.estado.runs = [];
  dubles.estado.geracoes = [];
  dubles.estado.nCenarios = 20;
  dubles.estado.variantes = ['v0', 'v1'];
  dubles.estado.desfecho = {};
  dubles.estado.politica = () => 'parcial';
});

type ComEventos = { rec: SessionRecord; eventos: SessionEvent[] };

async function treinarNode(cfg: TrainingConfig): Promise<ComEventos> {
  const eventos: SessionEvent[] = [];
  let unsub = (): void => undefined;
  const rec = await trainToCompletion(cfg, KEY, {
    onSession: (id) => {
      unsub = subscribeNodeSession(id, (e) => eventos.push(e));
    },
  });
  unsub();
  return { rec, eventos };
}

async function treinarWeb(cfg: TrainingConfig): Promise<ComEventos> {
  const eventos: SessionEvent[] = [];
  const { sessionId, record } = await startWebTraining(cfg as never, KEY);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sessão não terminou')), 10_000);
    const unsub = subscribeSession(sessionId, (e) => {
      eventos.push(e as unknown as SessionEvent);
      if (e.type === 'session.finished' || e.type === 'session.error') {
        clearTimeout(t);
        unsub();
        resolve();
      }
    });
  });
  return { rec: record as unknown as SessionRecord, eventos };
}

const MOTORES = [
  ['Node', treinarNode],
  ['SPA', treinarWeb],
] as const;

const doTipo = (k: Kind) => dubles.estado.runs.filter((r) => r.kind === k);

/** Índices ORIGINAIS reservados para o holdout (o mesmo split do trainer). */
function holdoutIdx(n: number, ratio: number): Set<number> {
  return new Set(splitHoldout(Array.from({ length: n }, (_, i) => i), ratio).holdout);
}

// ---------------------------------------------------------------------------
// web-code#1 — a seleção nunca vê a fatia de holdout
// ---------------------------------------------------------------------------

describe('web-code#1 — o holdout fica FORA da seleção da iteração 0', () => {
  for (const [nome, treinar] of MOTORES) {
    it(`${nome}: variante que só ganha nos cenários de HOLDOUT não é promovida`, async () => {
      const reservados = holdoutIdx(20, 0.3);
      expect(reservados.size).toBe(10);
      // A v0 só é melhor exatamente na fatia que o gate final depois "valida".
      // Com a contaminação ela passava no gate da iteração 0 (Δ +25 p.p. em 20
      // pares, p ajustado < 0,01) e o holdout "confirmava" o que já tinha visto.
      dubles.estado.politica = (c, id) =>
        c.kind === 'selection' && id === 'v0' && reservados.has(c.scenario) ? 'resolve' : 'parcial';
      const { rec } = await treinar(config({ iterations: 1 }));
      expect(rec.status, rec.error).toBe('finished');
      const it0 = rec.bestPromptByIteration[0];
      const gate = it0.gate as IterationGate;
      // O gate pareou SÓ o treino: n = cenários pinados (10), nunca 20.
      expect(rec.pinnedStages).toHaveLength(10);
      expect(gate.pairing.n).toBe(rec.pinnedStages!.length);
      expect(gate.gainPp).toBe(0);
      expect(gate.decision).toBe('held');
      expect(it0.winnerContestantId).toBe('original');
      expect(doTipo('reeval')).toHaveLength(0);
      // Nenhuma pergunta pinada é da fatia reservada.
      const treino = new Set(rec.pinnedStages!.map((s) => s.question));
      for (const i of reservados) expect(treino.has(`cenario ${i}`)).toBe(false);
      // A run 0 (gravada) segue cobrindo os 20 — a UI mostra tudo.
      expect(doTipo('selection')[0].questions).toHaveLength(20);
    });

    it(`${nome}: as lições da iteração 1 não citam nenhuma pergunta do holdout`, async () => {
      const reservados = holdoutIdx(20, 0.3);
      // Ninguém promove; a base falha ('nao') em TODO cenário — sem o filtro, o
      // dossiê do campeão (a base) levaria as 10 perguntas do holdout ao reescritor.
      dubles.estado.politica = () => 'nao';
      const { rec } = await treinar(config({ iterations: 2, feedbackDriven: true }));
      expect(rec.status, rec.error).toBe('finished');
      expect(dubles.estado.geracoes).toHaveLength(2);
      const hint = dubles.estado.geracoes[1].analysisHint ?? '';
      const citados = [...hint.matchAll(/\[cenario (\d+)\]/g)].map((m) => Number(m[1]));
      expect(citados.length).toBeGreaterThan(0);
      expect(citados.filter((i) => reservados.has(i))).toEqual([]);
      expect(new Set(citados).size).toBe(10); // as 10 do treino, todas
    });
  }

  it('trainOnlyView: só as etapas de treino, judge-score recomputado nelas, sem agregados de run inteira', () => {
    const specs = Array.from({ length: 5 }, (_, i) => ({ question: `q${i}` }));
    const ref = (a: Verdict, b: Verdict, extra: Record<string, unknown> = {}) => ({
      verdictByContestant: { a, b } as Record<string, Verdict>,
      ...extra,
    });
    const run = {
      id: 'r',
      contestants: [{ id: 'a' }, { id: 'b' }],
      stages: [
        { index: 0, spec: specs[0], referenceJudge: ref('resolve', 'nao') },
        { index: 1, spec: specs[1], referenceJudge: ref('nao', 'resolve') }, // holdout
        // treino com repetições (§18.4): cada rep é uma observação
        { index: 2, spec: specs[2], referenceJudge: ref('resolve', 'nao', { verdictsByRep: { a: ['parcial', 'nao'] } }) },
        { index: 3, spec: specs[3], referenceJudge: ref('nao', 'nao'), incomplete: true }, // cortada: fora
        { index: 4, spec: specs[4], referenceJudge: ref('nao', 'resolve') }, // holdout
        { index: 5 }, // sem spec (datagen curto): fora
      ],
      judgeScoreByContestant: { a: 100, b: 100 },
      standings: [{ contestantId: 'a' }],
      completeness: { n: 6 },
      resolveRateByContestant: { a: 1 },
    };
    const view = trainOnlyView(run, [specs[0], specs[2], specs[3]]);
    expect(view.stages.map((s) => s.index)).toEqual([0, 2, 3]);
    // a: resolve (etapa 0) + reps parcial/nao (etapa 2) → (1 + 0,5 + 0)/3; b: nao, nao → 0.
    expect(view.judgeScoreByContestant).toEqual({ a: 50, b: 0 });
    expect(view).not.toHaveProperty('standings');
    expect(view).not.toHaveProperty('completeness');
    expect(view).not.toHaveProperty('resolveRateByContestant');
    expect(view.id).toBe('r');
    // A run original não muda.
    expect(run.stages).toHaveLength(6);
    expect(run.judgeScoreByContestant).toEqual({ a: 100, b: 100 });
    // Sem juiz de referência nas etapas de treino, o agregado some (o
    // trainer cai nos vereditos listwise das etapas, como numa run legada).
    const semRef = trainOnlyView({ ...run, stages: [{ index: 0, spec: specs[0] }] }, [specs[0]]);
    expect(semRef).not.toHaveProperty('judgeScoreByContestant');
  });
});

// ---------------------------------------------------------------------------
// web-code#0 + cli#8 + web-code#18 — re-avaliação limpa
// ---------------------------------------------------------------------------

describe('web-code#0 — re-avaliação abortada PARA a sessão (dois motores)', () => {
  for (const [nome, treinar] of MOTORES) {
    for (const motivo of ['cancelled', 'budget'] as const) {
      it(`${nome}: re-avaliação ${motivo} ⇒ aborted/${motivo} na iteração 0, sem convergência`, async () => {
        // v0 passa no gate da iteração 0 (resolve tudo); a re-avaliação não termina.
        dubles.estado.politica = (c, id) => (c.kind === 'selection' && id === 'v0' ? 'resolve' : 'parcial');
        dubles.estado.desfecho = { reeval: { status: 'aborted', stoppedReason: motivo } };
        const { rec, eventos } = await treinar(config({ iterations: 3, patience: 1 }));
        expect(rec).toMatchObject({ status: 'aborted', stoppedReason: motivo, stoppedAtIteration: 0 });
        expect(Boolean(rec.budgetExhausted)).toBe(motivo === 'budget');
        expect(rec.convergedAtIteration).toBeUndefined();
        expect(eventos.some((e) => e.type === 'session.converged')).toBe(false);
        // Nada mais roda depois da parada: nem a iteração 1, nem o holdout.
        expect(doTipo('selection')).toHaveLength(1);
        expect(doTipo('holdout')).toHaveLength(0);
        // Holdout devido e não feito: o MOTIVO é a parada (web-code#8).
        expect(rec.holdoutSkipped).toBe(true);
        expect(rec.holdoutSkipReason).toBe(motivo);

        const gate = rec.bestPromptByIteration[0].gate!;
        expect(gate.decision).toBe('held');
        expect(gate.heldBy).toContain('reeval');
        expect(gate.reeval).toMatchObject({ confirmed: false, runStatus: 'aborted' });
        expect(gate.reeval!.pairing).toBeUndefined();
        // cli#8: nada de Δ/n inventados para uma comparação que não aconteceu.
        const texto = formatIterationGate(gate);
        expect(texto).toContain('re-avaliação limpa interrompida (run aborted)');
        expect(texto).toContain('sem evidência');
        expect(texto).not.toMatch(/não confirmou \(Δ/);

        // web-code#18: a run paga da re-avaliação é alcançável, fora de runIds.
        const reeval = doTipo('reeval');
        expect(reeval).toHaveLength(1);
        expect(rec.reevalRunIds).toEqual([reeval[0].id]);
        expect(gate.reeval!.runId).toBe(reeval[0].id);
        expect(rec.runIds).not.toContain(reeval[0].id);
        expect(rec.runIds).toEqual(doTipo('selection').map((r) => r.id));
      });
    }

    it(`${nome}: re-avaliação que confirma ⇒ reevalRunIds, runIds = uma run por iteração + holdout`, async () => {
      dubles.estado.politica = (c, id) => (id === 'v0' || id === 'holdout-champion' ? 'resolve' : 'parcial');
      const { rec } = await treinar(config({ iterations: 1 }));
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.bestPromptByIteration[0].gate?.decision).toBe('promoted');
      const reeval = doTipo('reeval');
      expect(reeval).toHaveLength(1);
      expect(rec.reevalRunIds).toEqual([reeval[0].id]);
      expect(rec.runIds).toEqual([...doTipo('selection'), ...doTipo('holdout')].map((r) => r.id));
      expect(reevalRunIdsOf(rec)).toEqual([reeval[0].id]);
      // Holdout forte, rodou e confirmou: sem motivo de "pulado".
      expect(rec.holdout?.n).toBe(10);
      expect(rec.holdoutSkipReason).toBeUndefined();
      expect(sessionConfirmationText(rec)).toContain('validado em holdout');
    });
  }

  it('reevalRunIdsOf: record antigo (sem a lista) cai nos ids do gate, sem repetir', () => {
    const it0 = { gate: { reeval: { runId: 'r-a' } } };
    const it1 = { gate: { reeval: { runId: 'r-b' } } };
    expect(reevalRunIdsOf({ bestPromptByIteration: [it0, {}, it1] })).toEqual(['r-a', 'r-b']);
    expect(reevalRunIdsOf({ reevalRunIds: ['r-a', 'r-x'], bestPromptByIteration: [it0, it1] })).toEqual([
      'r-a',
      'r-x',
      'r-b',
    ]);
    expect(reevalRunIdsOf({})).toEqual([]);
  });
});

describe('cli#8 — formatIterationGate com re-avaliação', () => {
  const base = {
    controlId: 'original',
    bestId: 'v0',
    minGain: 5,
    gainPp: 40,
    pairing: { n: 10, nEfetivo: 10, excludedPairs: 0, completeness: 1 },
    heldBy: ['reeval'],
    decision: 'held',
  } as unknown as IterationGate;
  const reeval = { candidateId: 'v0', controlId: 'original', size: 5, poolSize: 10, gainPp: 0, confirmed: false };

  it('interrompida: rótulo e motivo sem Δ nem n', () => {
    const t = formatIterationGate({ ...base, reeval: { ...reeval, runId: 'r', runStatus: 'aborted' } });
    expect(t.startsWith('mantida a régua (re-avaliação interrompida):')).toBe(true);
    expect(t).toContain('re-avaliação limpa interrompida (run aborted) — sem evidência');
    expect(t).not.toContain('+0.0pp em 5');
  });

  it('não rodou (sem régua/candidato/cenário): diz que não rodou', () => {
    const t = formatIterationGate({ ...base, reeval: { ...reeval, size: 0 } });
    expect(t).toContain('re-avaliação limpa não rodou');
    expect(t).not.toContain('em 0 cenários');
  });

  it('terminou e não confirmou: o n é o de pares completos que entraram', () => {
    const t = formatIterationGate({
      ...base,
      reeval: {
        ...reeval,
        runId: 'r',
        gainPp: -10,
        pairing: { n: 5, nEfetivo: 4, excludedPairs: 1, completeness: 0.8 },
      },
    });
    expect(t).toContain('re-avaliação limpa não confirmou (Δ -10.0pp em 4 cenários)');
  });
});

// ---------------------------------------------------------------------------
// web-code#8 + cli#9 — o MOTIVO de não haver holdout
// ---------------------------------------------------------------------------

describe('web-code#8/cli#9 — holdoutSkipReason gravado pelos dois motores', () => {
  for (const [nome, treinar] of MOTORES) {
    it(`${nome}: < 20 cenários ⇒ 'min-scenarios' (nunca "orçamento")`, async () => {
      dubles.estado.nCenarios = 12;
      const { rec } = await treinar(config({ stages: 12, holdoutRatio: 0.5 }));
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.stoppedReason).toBeUndefined();
      expect(rec).toMatchObject({ holdoutSkipped: true, holdoutSkipReason: 'min-scenarios' });
      const texto = sessionConfirmationText(rec);
      expect(texto).toContain(`${MIN_SCENARIOS_FOR_HOLDOUT} cenários`);
      expect(texto).not.toMatch(/orçamento|cancel/);
      const guards = evaluateHandoffGuards(rec);
      const aviso = guards.warnings.find((w) => w.code === 'holdout.skipped')!;
      expect(aviso.message).toContain('seleção pequena demais');
      expect(aviso.message).not.toContain('orçamento');
    });

    it(`${nome}: holdoutRatio 0 ⇒ 'disabled', sem holdoutSkipped`, async () => {
      const { rec } = await treinar(config({ holdoutRatio: 0 }));
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.holdoutSkipReason).toBe('disabled');
      expect(rec.holdoutSkipped).toBeFalsy();
    });

    it(`${nome}: ninguém promovido ⇒ 'no-change' (campeão = base, nada a validar)`, async () => {
      const { rec } = await treinar(config());
      expect(rec.status, rec.error).toBe('finished');
      expect(doTipo('holdout')).toHaveLength(0);
      expect(rec.holdoutSkipReason).toBe('no-change');
      expect(rec.holdoutSkipped).toBeFalsy();
      const aviso = evaluateHandoffGuards(rec).warnings.find((w) => w.code === 'holdout.missing')!;
      expect(aviso.message).toContain('prompt base');
    });

    it(`${nome}: run de holdout com erro ⇒ 'run-failed' (sessão segue 'finished')`, async () => {
      dubles.estado.politica = (c, id) => (id === 'v0' ? 'resolve' : 'parcial');
      dubles.estado.desfecho = { holdout: { status: 'error' } };
      const { rec } = await treinar(config());
      expect(rec.status, rec.error).toBe('finished');
      expect(doTipo('holdout')).toHaveLength(1);
      expect(rec.holdout).toBeUndefined();
      expect(rec).toMatchObject({ holdoutSkipped: true, holdoutSkipReason: 'run-failed' });
    });

    it(`${nome}: run de holdout cortada por orçamento ⇒ sessão PARCIAL por orçamento`, async () => {
      dubles.estado.politica = (c, id) => (id === 'v0' ? 'resolve' : 'parcial');
      dubles.estado.desfecho = { holdout: { status: 'aborted', stoppedReason: 'budget' } };
      const { rec } = await treinar(config());
      expect(rec).toMatchObject({
        status: 'aborted',
        stoppedReason: 'budget',
        budgetExhausted: true,
        stoppedAtPhase: 'holdout',
        holdoutSkipped: true,
        holdoutSkipReason: 'budget',
      });
    });

    it(`${nome}: run de holdout CANCELADA ⇒ sessão aborted/cancelled com motivo 'cancelled'`, async () => {
      dubles.estado.politica = (c, id) => (id === 'v0' ? 'resolve' : 'parcial');
      dubles.estado.desfecho = { holdout: { status: 'aborted', stoppedReason: 'cancelled' } };
      const { rec } = await treinar(config());
      expect(doTipo('holdout')).toHaveLength(1);
      expect(rec.holdout).toBeUndefined();
      expect(rec).toMatchObject({
        status: 'aborted',
        stoppedReason: 'cancelled',
        holdoutSkipped: true,
        holdoutSkipReason: 'cancelled',
      });
      // Cancelar não é orçamento: nada de budgetExhausted/fase de orçamento.
      expect(rec.budgetExhausted).toBeFalsy();
      expect(rec.stoppedAtPhase).toBeUndefined();
      expect(sessionConfirmationText(rec)).not.toMatch(/orçamento/u);
    });

    it(`${nome}: sem prompt base ⇒ 'no-base' (não há controle para o holdout), sem holdoutSkipped`, async () => {
      // A variante é promovida (há campeão e fatia forte), mas sem prompt base
      // não existe o que o holdout re-testaria contra.
      dubles.estado.politica = (c, id) => (id === 'v0' ? 'resolve' : 'parcial');
      const { rec } = await treinar(config({ basePrompt: '' }));
      expect(rec.status, rec.error).toBe('finished');
      expect(doTipo('holdout')).toHaveLength(0);
      expect(rec.holdout).toBeUndefined();
      expect(rec.holdoutSkipReason).toBe('no-base');
      expect(rec.holdoutSkipped).toBeFalsy();
    });
  }
});

describe('web-code#8/cli#9 — decisões de sessão (puras)', () => {
  it('record antigo sem o campo: parada ⇒ budget/cancelled; sem parada ⇒ piso de cenários', () => {
    expect(holdoutSkipReasonOf({ holdoutSkipped: true })).toBe('min-scenarios');
    expect(holdoutSkipReasonOf({ holdoutSkipped: true, stoppedReason: 'budget' })).toBe('budget');
    expect(holdoutSkipReasonOf({ holdoutSkipped: true, budgetExhausted: true })).toBe('budget');
    expect(holdoutSkipReasonOf({ holdoutSkipped: true, stoppedReason: 'cancelled' })).toBe('cancelled');
    expect(holdoutSkipReasonOf({ holdoutSkipped: true, stoppedReason: 'orphan' })).toBe('cancelled');
    expect(holdoutSkipReasonOf({})).toBeUndefined();
    // Com resultado de holdout não há o que explicar; o gravado sempre vence.
    expect(holdoutSkipReasonOf({ holdoutSkipped: true, holdout: { n: 10, gain: 5, regressed: false } })).toBeUndefined();
    expect(holdoutSkipReasonOf({ holdoutSkipped: true, holdoutSkipReason: 'run-failed' })).toBe('run-failed');
  });

  it('handoff: a mensagem segue o motivo (e o código não muda)', () => {
    const porParada = evaluateHandoffGuards({ holdoutSkipped: true, stoppedReason: 'budget', significance: null });
    const w = porParada.warnings.find((x) => x.code === 'holdout.skipped')!;
    expect(w.message).toContain('orçamento');
    const pequeno = evaluateHandoffGuards({ holdoutSkipped: true, significance: null });
    const w2 = pequeno.warnings.find((x) => x.code === 'holdout.skipped')!;
    expect(w2.message).not.toContain('orçamento');
    expect(w2.message).toContain(holdoutSkipReasonText('min-scenarios'));
    // Aviso de "sem holdout" sem motivo conhecido: o piso citado é o atual (10), não 5.
    const semNada = evaluateHandoffGuards({ significance: null });
    const w3 = semNada.warnings.find((x) => x.code === 'holdout.missing')!;
    expect(w3.message).toContain('< 20 cenários');
    expect(w3.message).not.toContain('< 5');
  });

  it('confirmação legada: p exato de pareamento holdout (sem pOrigin) conta como do holdout', () => {
    const legado = {
      holdout: { n: 12, gain: 25, regressed: false },
      pairing: { source: 'holdout' as const },
      significance: { n: 12, meanDiffPp: 25, ci95Pp: [5, 45] as [number, number], pValue: 0.01, pValueTwoSided: 0.02 },
    };
    expect(sessionConfirmationText(legado)).toContain('validado em holdout');
    // Bootstrap antigo (sem p bilateral) não é p-valor: nunca "validado".
    const bootstrap = { ...legado, significance: { n: 12, meanDiffPp: 25, ci95Pp: [5, 45] as [number, number], pValue: 0.01 } };
    expect(sessionConfirmationText(bootstrap)).not.toContain('validado');
  });

  it('IMPL-051: motivo da convergência em texto (platão × paciência)', () => {
    expect(convergenceReasonText('plateau')).toContain('platão');
    expect(convergenceReasonText('patience')).toBe('paciência — 2 iterações seguidas sem promoção');
    expect(convergenceReasonText('patience', 1)).toBe('paciência — 1 iteração seguida sem promoção');
    expect(convergenceReasonText(undefined)).toBe('motivo não registrado');
  });
});
