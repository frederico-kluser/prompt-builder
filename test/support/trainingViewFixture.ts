// Records de sessão/rodadas para o harness de browser da TrainingView
// (test/web-views-e2e.test.ts). Construídos à mão, sem rede.
//
// A sessão "tres-rodadas" reproduz o caso do web-live#1: a rodada 1 SEGUROU
// o original com muitos ouros (score 20), a rodada 2 PROMOVEU "Cadeia de
// raciocínio" (score 6) e a rodada 3 segurou o campeão carregado (score 10).
// O argmax de `score` abria o estúdio no ORIGINAL da rodada 1; o campeão da
// sessão é o pós-gate da ÚLTIMA rodada.

type Verdict = 'resolve' | 'parcial' | 'nao';
type AnyRecord = Record<string, any>;

export const ORIG = 'Você é um atendente. Responda com base no contexto.';
export const CHAMP = 'Você é um atendente sênior.\nPense passo a passo antes de responder.\nCite a política quando houver.';
export const OTHER = 'Você é um atendente. Seja breve.';

const T0 = '2026-09-28T10:00:00.000Z';

function stage(i: number, verdicts: Record<string, Verdict>): AnyRecord {
  return {
    index: i,
    spec: { question: `pergunta ${i}`, productContext: 'ctx', maxTokens: 200, reference: 'ref' },
    responses: Object.keys(verdicts).map((id) => ({
      contestantId: id,
      modelId: 'fake/a',
      text: 'ok',
      latencyMs: 900,
      tokensIn: 300,
      tokensOut: 120,
      costUsd: 0.001,
      status: 'ok',
    })),
    referenceJudge: { verdictByContestant: verdicts, explanationByContestant: {}, judgeModelId: 'fake/j' },
    startedAt: T0,
  };
}

function run(
  id: string,
  sessionId: string,
  iteration: number,
  contestants: { id: string; label: string; systemPrompt: string; isOriginal?: boolean; techniqueId?: string }[],
  verdictOf: (cid: string, stageIdx: number) => Verdict,
  scores: Record<string, number>,
): AnyRecord {
  return {
    id,
    status: 'finished',
    mode: 'variation',
    config: { mode: 'variation', theme: 'suporte', stages: 4, judgeModelIds: ['fake/j'] },
    contestants: contestants.map((c) => ({ modelId: 'fake/a', ...c })),
    stages: Array.from({ length: 4 }, (_, i) =>
      stage(i, Object.fromEntries(contestants.map((c) => [c.id, verdictOf(c.id, i)]))),
    ),
    scoreboard: {},
    judgeScoreByContestant: scores,
    totalCostUsd: 0.05,
    startedAt: T0,
    finishedAt: '2026-09-28T10:01:00.000Z',
    sessionId,
    iteration,
  };
}

function baseSession(id: string, over: AnyRecord): AnyRecord {
  return {
    id,
    status: 'finished',
    config: {
      mode: 'training',
      theme: 'suporte ao cliente',
      stages: 5,
      iterations: 3,
      datagenModelId: 'fake/g',
      judgeModelIds: ['fake/j'],
      contestantModelId: 'fake/a',
      basePrompt: ORIG,
    },
    runIds: [],
    bestPromptByIteration: [],
    totalCostUsd: 0.15,
    startedAt: T0,
    ...over,
  };
}

/** Sessão encerrada de 3 rodadas (web-live#1) + as runs de cada rodada. */
export function tresRodadas(): { session: AnyRecord; runs: AnyRecord[] } {
  const sid = 'tres-rodadas';
  const r0 = run(
    'r0',
    sid,
    0,
    [
      { id: 'original', label: 'Original (controle)', systemPrompt: ORIG, isOriginal: true },
      { id: 'v0', label: 'Formato enxuto', systemPrompt: OTHER, techniqueId: 'format' },
    ],
    (cid) => (cid === 'original' ? 'resolve' : 'parcial'),
    { original: 80, v0: 50 },
  );
  const r1 = run(
    'r1',
    sid,
    1,
    [
      { id: 'carry', label: 'Campeão atual', systemPrompt: ORIG },
      { id: 'v2', label: 'Cadeia de raciocínio', systemPrompt: CHAMP, techniqueId: 'cot' },
    ],
    (cid) => (cid === 'v2' ? 'resolve' : 'nao'),
    { carry: 40, v2: 95 },
  );
  const r2 = run(
    'r2',
    sid,
    2,
    [
      { id: 'carry', label: 'Campeão atual', systemPrompt: CHAMP },
      { id: 'w1', label: 'Persona', systemPrompt: OTHER, techniqueId: 'persona' },
    ],
    (cid) => (cid === 'carry' ? 'resolve' : 'parcial'),
    { carry: 90, w1: 55 },
  );
  const session = baseSession(sid, {
    runIds: ['r0', 'r1', 'r2'],
    bestPromptByIteration: [
      { iteration: 0, runId: 'r0', winnerContestantId: 'original', systemPrompt: ORIG, score: 20 },
      { iteration: 1, runId: 'r1', winnerContestantId: 'v2', systemPrompt: CHAMP, score: 6 },
      { iteration: 2, runId: 'r2', winnerContestantId: 'carry', systemPrompt: CHAMP, score: 10 },
    ],
    // Seleção < 20 cenários: nunca houve fatia reservada (web-live#11).
    holdoutSkipped: true,
    holdoutSkipReason: 'min-scenarios',
    // p unilateral do gate 0,001; o BILATERAL exibido é 0,002 (web-live#17).
    significance: {
      n: 6,
      nEfetivo: 6,
      meanDiffPp: 50,
      ci95Pp: [25, 75],
      pValue: 0.001,
      pValueTwoSided: 0.002,
      method: 'exact',
      pOrigin: 'selecao',
    },
    pairing: {
      source: 'training',
      controlId: 'original',
      championId: 'v2',
      n: 6,
      nEfetivo: 6,
      excludedPairs: 0,
      completeness: 1,
      controlMeanPp: 40,
      championMeanPp: 90,
      meanDiffPp: 50,
    },
  });
  return { session, runs: [r0, r1, r2] };
}

/**
 * Sessão aberta ANTES de as runs chegarem (web-live#0): o record da sessão
 * existe, mas nenhuma rodada foi carregada ainda. `status` escolhe o caso.
 */
export function semRodadasCarregadas(status: 'finished' | 'running'): AnyRecord {
  return baseSession(`sem-rodadas-${status}`, {
    status,
    runIds: ['x0', 'x1'],
    bestPromptByIteration:
      status === 'finished'
        ? [
            { iteration: 0, runId: 'x0', winnerContestantId: 'original', systemPrompt: ORIG, score: 3 },
            { iteration: 1, runId: 'x1', winnerContestantId: 'v1', systemPrompt: CHAMP, score: 2 },
          ]
        : [{ iteration: 0, runId: 'x0', winnerContestantId: 'original', systemPrompt: ORIG, score: 3 }],
    ...(status === 'running' ? { finishedAt: undefined } : { finishedAt: '2026-09-28T10:05:00.000Z' }),
  });
}

/** Treino AO VIVO nesta aba (cancelável), para o fim chegar por evento (web-live#2). */
export function aoVivo(): { session: AnyRecord; runs: AnyRecord[] } {
  const sid = 'ao-vivo';
  const r0 = run(
    'l0',
    sid,
    0,
    [
      { id: 'original', label: 'Original (controle)', systemPrompt: ORIG, isOriginal: true },
      { id: 'v1', label: 'Cadeia de raciocínio', systemPrompt: CHAMP, techniqueId: 'cot' },
    ],
    (cid) => (cid === 'v1' ? 'resolve' : 'parcial'),
    { original: 50, v1: 90 },
  );
  const session = baseSession(sid, {
    status: 'running',
    config: {
      mode: 'training',
      theme: 'suporte ao cliente',
      stages: 5,
      iterations: 1,
      datagenModelId: 'fake/g',
      judgeModelIds: ['fake/j'],
      contestantModelId: 'fake/a',
      basePrompt: ORIG,
    },
    runIds: ['l0'],
    bestPromptByIteration: [{ iteration: 0, runId: 'l0', winnerContestantId: 'v1', systemPrompt: CHAMP, score: 4 }],
  });
  return { session, runs: [r0] };
}
