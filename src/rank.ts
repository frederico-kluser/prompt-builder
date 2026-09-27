// Seleção do vencedor, portada do `select.mjs` do prompt-arena.
// Métrica primária: judge-score = (resolve + 0.5·parcial) / total · 100.
// Uma variante só é promovida se superar o judge-score do controle por uma
// margem mínima (`minGain`); sem ganho, o controle se mantém (convergência).

import type { GateConclusion, IterationGate, SensitivityCase, Verdict } from './types.js';
import { pairCoverage, pairDiffs, sensitivityAnalysis, type PairScore } from './stats.js';

/**
 * Judge-score em [0,100] a partir dos vereditos pointwise de um contestant.
 * `undefined` conta como 'nao' (resposta com erro/ausente não pontua);
 * lista vazia → 0 (sem evidência, sem score).
 */
export function judgeScoreFromVerdicts(verdicts: (Verdict | undefined)[]): number {
  if (verdicts.length === 0) return 0;
  let resolve = 0;
  let parcial = 0;
  for (const v of verdicts) {
    if (v === 'resolve') resolve++;
    else if (v === 'parcial') parcial++;
  }
  return ((resolve + 0.5 * parcial) / verdicts.length) * 100;
}

/** Uma entrada do ranking de seleção (variante ou controle) de uma run. */
export interface RankEntry {
  id: string;
  label: string;
  /** true = o prompt base do usuário, rodado como controle. */
  isControl: boolean;
  /** Judge-score agregado em [0,100] (métrica primária). */
  judgeScore: number;
  /** Placement médio nos duelos/listwise (menor = melhor). Ausente = não duelou. */
  meanPlacement?: number;
  /** Quantidade de respostas com erro no pipeline (menor = melhor). */
  errored: number;
  /** Tamanho do system prompt (regularização: em empate, o mais curto vence). */
  promptLen: number;
}

/**
 * Ordena as entradas da melhor para a pior, sem mutar o array de entrada.
 * Cadeia de desempate: judge-score (desc) → placement médio (asc; ausente →
 * Infinity, para quem nunca duelou não vencer um empate espuriamente) →
 * menos erros → prompt mais curto (regularização por tamanho).
 */
export function rankEntries(entries: RankEntry[]): RankEntry[] {
  return [...entries].sort(
    (a, b) =>
      b.judgeScore - a.judgeScore ||
      (a.meanPlacement ?? Infinity) - (b.meanPlacement ?? Infinity) ||
      a.errored - b.errored ||
      a.promptLen - b.promptLen,
  );
}

/** Resultado do gate de promoção de uma iteração. */
export interface PickResult {
  best: RankEntry | undefined;
  control: RankEntry | undefined;
  /** Vantagem do `best` sobre o controle em p.p. (pareada quando há `scoresById`). */
  gain: number;
  isWinner: boolean;
  /**
   * Pareamento honesto best × controle (IMPL-005) — presente quando
   * `scoresById` cobre os dois. É o registro auditável da decisão.
   */
  gate?: IterationGate;
}

const round2 = (x: number): number => Number(x.toFixed(2)) + 0;
const meanPp = (diffs: readonly number[]): number =>
  diffs.length ? (diffs.reduce((s, d) => s + d, 0) / diffs.length) * 100 : 0;

/**
 * Escolhe o vencedor entre as entradas. `best` é a melhor variante (controle
 * excluído — ele é a régua, não um candidato); `gain` é a vantagem do `best`
 * sobre o controle em pontos de judge-score; `isWinner` exige `gain >= minGain`
 * (default 1.0 — promoção só com margem real, senão o treino convergiu).
 *
 * **Pareamento honesto (IMPL-005, R-04:REC-2).** Com `scoresById` (score por
 * etapa na escala 0–1, `null` = sem veredito — ver `stageScoresByContestant`),
 * o ganho é o Δ PAREADO: média de (best − controle) só nas etapas com veredito
 * nos DOIS lados. Antes eram dois judge-scores sobre conjuntos de etapas
 * diferentes (e o ausente contava 'nao'). Com exclusões > 10% dos pares, a
 * decisão é refeita no pior caso (best perde todo ausente, controle ganha) e no
 * melhor; se ela muda, o gate é INCONCLUSIVO e não promove — margem que só
 * existe com imputação favorável não é margem real.
 */
export function pickWinner(
  entries: RankEntry[],
  opts?: { minGain?: number; scoresById?: Readonly<Record<string, readonly PairScore[]>> },
): PickResult {
  const minGain = opts?.minGain ?? 1.0;
  const control = entries.find((e) => e.isControl);
  const best = rankEntries(entries.filter((e) => !e.isControl))[0];
  if (!best) return { best: undefined, control, gain: 0, isWinner: false };
  if (!control) {
    // Sem controle não há régua para medir ganho: a melhor variante vence por
    // definição (gain 0), pois não faz sentido bloquear a promoção pela
    // ausência de um baseline que a run nunca teve.
    return { best, control: undefined, gain: 0, isWinner: true };
  }
  const controlScores = opts?.scoresById?.[control.id];
  const bestScores = opts?.scoresById?.[best.id];
  if (!controlScores || !bestScores) {
    const gain = best.judgeScore - control.judgeScore;
    return { best, control, gain, isWinner: gain >= minGain };
  }

  const { diffs } = pairDiffs(controlScores, bestScores);
  const gain = meanPp(diffs);
  // Sem nenhum par completo não há evidência de ganho: nunca promove.
  const decide = (d: readonly number[]): SensitivityCase<GateConclusion> => {
    const g = meanPp(d);
    return { meanDiffPp: round2(g), conclusion: d.length > 0 && g >= minGain ? 'promote' : 'hold' };
  };
  const passes = decide(diffs).conclusion === 'promote';
  const sensitivity = sensitivityAnalysis(controlScores, bestScores, decide);
  const inconclusive = sensitivity?.inconclusive === true;
  const isWinner = passes && !inconclusive;
  const gate: IterationGate = {
    controlId: control.id,
    bestId: best.id,
    minGain,
    gainPp: round2(gain),
    pairing: pairCoverage(controlScores, bestScores),
    ...(sensitivity ? { sensitivity } : {}),
    decision: inconclusive ? 'inconclusive' : isWinner ? 'promoted' : 'held',
  };
  return { best, control, gain, isWinner, gate };
}
