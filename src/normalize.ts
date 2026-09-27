import type {
  Contestant,
  RunConfig,
  RunMode,
  RunRecord,
  StageRecord,
} from './types.js';
import { standingsFromDuels } from './engine/duelCore.js';

/**
 * Deriva os contestants a partir da config.
 * - compare: 1 contestant por modelo (id === modelId), sem systemPrompt.
 * - variation/training: contestants sao resolvidos em runtime pelo variator e
 *   passados via opts.contestants; aqui retornamos [] (o orquestrador exige os
 *   contestants explicitos nesses modos).
 */
export function contestantsFromConfig(config: RunConfig): Contestant[] {
  if (config.mode === 'compare') {
    return config.competitorModelIds.map((modelId) => ({
      id: modelId,
      label: modelId,
      modelId,
    }));
  }
  return [];
}

/**
 * Migracao-na-leitura: aceita um RunRecord em formato antigo (sem `mode`,
 * `contestants`, `contestantId`, `rankedContestantIds`, etc.) e devolve um
 * RunRecord no formato atual. Em runs antigas, `contestantId === modelId`,
 * entao nada e reescrito em disco — apenas preenchemos os campos derivados.
 */
export function normalizeRunRecord(raw: any): RunRecord {
  const config = raw?.config ?? {};
  const mode: RunMode = raw?.mode ?? config.mode ?? 'compare';
  config.mode = config.mode ?? mode;
  // Retrocompat: juiz unico (judgeModelId: string) -> judgeModelIds: string[].
  if (!Array.isArray(config.judgeModelIds)) {
    config.judgeModelIds = typeof config.judgeModelId === 'string' ? [config.judgeModelId] : [];
  }

  const contestants: Contestant[] =
    raw?.contestants ??
    (Array.isArray(config.competitorModelIds)
      ? config.competitorModelIds.map((m: string) => ({ id: m, label: m, modelId: m }))
      : []);

  const stages: StageRecord[] = Array.isArray(raw?.stages)
    ? raw.stages.map(normalizeStage)
    : [];

  // Espalha `raw` ANTES dos campos normalizados: a lista explicita era um
  // whitelist e engolia em silencio todo campo novo do RunRecord — foi assim que
  // `judgeScoreByContestant`, `standings` e `finalists` sumiam ao reler a run do
  // disco/IndexedDB (o painel de finais vinha vazio depois de um F5).
  // IMPL-007: `winRate` e a regua das finais. Record muito antigo sem ela =>
  // deriva de V/E/D (mesma conta do orquestrador).
  const standings = Array.isArray(raw?.standings)
    ? raw.standings.map((st: any) => {
        if (typeof st?.winRate === 'number') return st;
        const played = (st?.wins ?? 0) + (st?.ties ?? 0) + (st?.losses ?? 0);
        const winRate = played > 0 ? Number((((st?.wins ?? 0) + 0.5 * (st?.ties ?? 0)) / played).toFixed(4)) : 0;
        return { ...st, winRate };
      })
    : raw?.standings;

  return {
    ...raw,
    ...(standings ? { standings } : {}),
    id: raw.id,
    status: raw.status,
    config,
    mode,
    contestants,
    stages,
    scoreboard: raw.scoreboard ?? {},
    costByContestant: raw.costByContestant,
    totalCostUsd: raw.totalCostUsd ?? 0,
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    error: raw.error,
    sessionId: raw.sessionId,
    iteration: raw.iteration,
    parentRunId: raw.parentRunId,
  };
}

function normalizeStage(raw: any): StageRecord {
  const responses = Array.isArray(raw?.responses)
    ? raw.responses.map((r: any) => ({ ...r, contestantId: r.contestantId ?? r.modelId }))
    : [];

  let judge = raw?.judge;
  if (judge) {
    // Retrocompat: records antigos so tinham ranking; a aceitabilidade vinha do
    // estagio "evaluation" separado. Derivamos acceptableByContestant dele.
    const acceptableByContestant: Record<string, boolean> = judge.acceptableByContestant ?? {};
    if (!judge.acceptableByContestant && Array.isArray(raw?.evaluation?.verdicts)) {
      for (const v of raw.evaluation.verdicts) {
        const cid = v.contestantId ?? v.modelId;
        if (cid) acceptableByContestant[cid] = Boolean(v.acceptable);
      }
    }
    judge = {
      ...judge,
      rankedContestantIds: judge.rankedContestantIds ?? judge.rankedModelIds ?? [],
      acceptableByContestant,
      judges: Array.isArray(judge.judges) ? judge.judges : [],
      blindMap: judge.blindMap ?? {},
      rawJudgeText: judge.rawJudgeText ?? '',
    };
  }

  let evaluation = raw?.evaluation;
  if (evaluation) {
    evaluation = {
      ...evaluation,
      bestContestantId: evaluation.bestContestantId ?? evaluation.bestModelId ?? '',
      verdicts: Array.isArray(evaluation.verdicts)
        ? evaluation.verdicts.map((v: any) => ({
            ...v,
            contestantId: v.contestantId ?? v.modelId,
          }))
        : [],
      blindMap: evaluation.blindMap ?? {},
    };
  }

  let live = raw?.live;
  if (live && typeof live === 'object') {
    const mapped: Record<string, any> = {};
    for (const [k, v] of Object.entries(live as Record<string, any>)) {
      mapped[k] = { ...v, contestantId: v.contestantId ?? v.modelId ?? k };
    }
    live = mapped;
  }

  // IMPL-007: o placar dos duelos virou `winRate` (a soma `points` era chamada
  // de "Copeland" por engano). Record antigo sem `winRate` => recomputa dos
  // duelos gravados; `points` fica como estava (so leitura, @deprecated).
  let duels = raw?.duels;
  if (duels && typeof duels === 'object' && !duels.winRate) {
    const ids = [
      ...new Set([
        ...Object.keys(duels.placementByContestant ?? {}),
        ...Object.keys(duels.points ?? {}),
      ]),
    ];
    duels = {
      ...duels,
      winRate: standingsFromDuels(ids, Array.isArray(duels.duels) ? duels.duels : []).winRate,
    };
  }

  return { ...raw, responses, judge, evaluation, live, ...(duels ? { duels } : {}) };
}
