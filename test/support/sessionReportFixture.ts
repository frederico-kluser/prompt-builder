// Fixture do relatório de ciclos: uma sessão de treino de 2 ciclos com holdout,
// construída à mão (sem rede). Usada por test/session-report.test.ts e por
// scripts de inspeção visual do HTML.
import type { CompetitorResponse, RunRecord, SessionRecord, StageRecord, Verdict } from '../../src/types.js';

export const ORIG = 'Você é um atendente. Responda com base no contexto.';
export const CHAMP = 'Você é um atendente sênior.\nResponda com base no contexto.\nCite a política quando houver.';

export interface CallSpec {
  cost: number;
  tin: number;
  tout: number;
  lat: number;
  status?: CompetitorResponse['status'];
}

function resp(contestantId: string, c: CallSpec): CompetitorResponse {
  return {
    contestantId,
    modelId: 'fake/a',
    text: 'ok',
    latencyMs: c.lat,
    tokensIn: c.tin,
    tokensOut: c.tout,
    costUsd: c.cost,
    status: c.status ?? 'ok',
  };
}

function stage(i: number, calls: Record<string, CallSpec>, verdicts: Record<string, Verdict>): StageRecord {
  return {
    index: i,
    spec: { question: `pergunta ${i}`, productContext: 'ctx', maxTokens: 200, reference: 'ref' },
    responses: Object.entries(calls).map(([id, c]) => resp(id, c)),
    referenceJudge: { verdictByContestant: verdicts, explanationByContestant: {}, judgeModelId: 'fake/j' },
    startedAt: '2026-09-28T10:00:00.000Z',
  } as unknown as StageRecord;
}

function run(
  id: string,
  iteration: number,
  contestants: { id: string; label?: string; techniqueId?: string }[],
  stages: StageRecord[],
  totalCostUsd: number,
): RunRecord {
  return {
    id,
    status: 'finished',
    mode: 'variation',
    config: {} as RunRecord['config'],
    contestants: contestants.map((c) => ({ modelId: 'fake/a', label: c.id, ...c })),
    stages,
    scoreboard: {},
    totalCostUsd,
    startedAt: '2026-09-28T10:00:00.000Z',
    finishedAt: '2026-09-28T10:01:00.000Z',
    sessionId: 's1',
    iteration,
  } as unknown as RunRecord;
}

export const CHEAP: CallSpec = { cost: 0.001, tin: 400, tout: 200, lat: 1000 };
export const PRICY: CallSpec = { cost: 0.0013, tin: 520, tout: 210, lat: 1200 };

/** Sessão de 2 ciclos: v1 promovida no ciclo 1, régua segura no ciclo 2, holdout confirma. */
export function fixture(over: { champCall?: CallSpec; withHoldout?: boolean; champion?: string } = {}): {
  session: SessionRecord;
  runs: RunRecord[];
} {
  const champCall = over.champCall ?? PRICY;
  const champion = over.champion ?? CHAMP;
  const withHoldout = over.withHoldout ?? true;
  const r0 = run(
    'r0',
    0,
    [{ id: 'original', label: 'Original' }, { id: 'v0', techniqueId: 'cot' }, { id: 'v1', label: 'Persona sênior', techniqueId: 'persona' }],
    Array.from({ length: 6 }, (_, i) =>
      stage(
        i,
        { original: CHEAP, v0: CHEAP, v1: champCall },
        { original: i < 3 ? 'parcial' : 'nao', v0: 'parcial', v1: i < 5 ? 'resolve' : 'parcial' },
      ),
    ),
    0.12,
  );
  const r1 = run(
    'r1',
    1,
    [{ id: 'carry', label: 'Carry' }, { id: 'w0', techniqueId: 'format' }],
    Array.from({ length: 6 }, (_, i) =>
      stage(i, { carry: champCall, w0: CHEAP }, { carry: i < 5 ? 'resolve' : 'parcial', w0: 'parcial' }),
    ),
    0.1,
  );
  const reeval = run('rr0', 0, [{ id: 'original' }, { id: 'v1' }], [], 0.02);
  const rh = run(
    'rh',
    2,
    [{ id: 'holdout-control' }, { id: 'holdout-champion' }],
    Array.from({ length: 6 }, (_, i) =>
      stage(
        i + 100,
        { 'holdout-control': CHEAP, 'holdout-champion': champCall },
        { 'holdout-control': i < 5 ? 'parcial' : 'nao', 'holdout-champion': i < 5 ? 'resolve' : 'parcial' },
      ),
    ),
    0.08,
  );
  const session = {
    id: 's1',
    status: 'finished',
    config: {
      mode: 'training',
      theme: 'suporte ao cliente',
      stages: 8,
      iterations: 3,
      datagenModelId: 'fake/g',
      judgeModelIds: ['fake/j'],
      contestantModelId: 'fake/a',
      basePrompt: ORIG,
    },
    runIds: withHoldout ? ['r0', 'r1', 'rh'] : ['r0', 'r1'],
    bestPromptByIteration: [
      {
        iteration: 0,
        runId: 'r0',
        winnerContestantId: champion === ORIG ? 'original' : 'v1',
        systemPrompt: champion,
        score: 3,
        gate: {
          controlId: 'original',
          bestId: 'v1',
          minGain: 5,
          gainPp: 45.83,
          gainCorrectedPp: 38.2,
          pairing: {
            n: 6,
            nEfetivo: 6,
            excludedPairs: 0,
            completeness: 1,
            controlMeanPp: 25,
            championMeanPp: 91.67,
            meanDiffPp: 66.67,
          },
          test: { pAdjusted: 0.031 },
          decision: champion === ORIG ? 'held' : 'promoted',
          ...(champion === ORIG ? { heldBy: ['significance'] } : {}),
          reeval: { candidateId: 'v1', controlId: 'original', size: 5, poolSize: 6, gainPp: 40, confirmed: true, runId: 'rr0' },
        },
      },
      {
        iteration: 1,
        runId: 'r1',
        winnerContestantId: 'carry',
        systemPrompt: champion,
        score: 3,
        gate: {
          controlId: 'carry',
          bestId: 'w0',
          minGain: 5,
          gainPp: -41.67,
          pairing: {
            n: 6,
            nEfetivo: 6,
            excludedPairs: 0,
            completeness: 1,
            controlMeanPp: 91.67,
            championMeanPp: 50,
            meanDiffPp: -41.67,
          },
          decision: 'held',
          heldBy: ['min-gain'],
        },
      },
    ],
    totalCostUsd: 0.32,
    budgetUsd: 2,
    costByRole: {
      competitor: { calls: 40, usd: 0.1, tokensIn: 1, tokensOut: 1 },
      judge: { calls: 40, usd: 0.16, tokensIn: 1, tokensOut: 1 },
      rewriter: { calls: 6, usd: 0.06, tokensIn: 1, tokensOut: 1 },
    },
    costAccuracy: { exact: 86, estimated: 0, unknown: 0 },
    startedAt: '2026-09-28T10:00:00.000Z',
    finishedAt: '2026-09-28T10:05:30.000Z',
    ...(withHoldout
      ? {
          holdout: { n: 6, controlScore: 41.67, championScore: 91.67, gain: 50, regressed: false, nEfetivo: 6 },
          significance: { n: 6, meanDiffPp: 50, ci95Pp: [25, 75], pValue: 0.031, pOrigin: 'holdout' },
          pairing: {
            source: 'holdout',
            controlId: 'holdout-control',
            championId: 'holdout-champion',
            n: 6,
            nEfetivo: 6,
            excludedPairs: 0,
            completeness: 1,
            controlMeanPp: 41.67,
            championMeanPp: 91.67,
            meanDiffPp: 50,
          },
        }
      : {
          significance: { n: 6, meanDiffPp: 45.83, ci95Pp: [20, 70], pValue: 0.031, pOrigin: 'selecao' },
          pairing: {
            source: 'training',
            controlId: 'original',
            championId: 'v1',
            n: 6,
            nEfetivo: 6,
            excludedPairs: 0,
            completeness: 1,
            controlMeanPp: 25,
            championMeanPp: 91.67,
            meanDiffPp: 66.67,
          },
        }),
  } as unknown as SessionRecord;
  return { session, runs: withHoldout ? [r0, r1, reeval, rh] : [r0, r1, reeval] };
}

