// Seleção do vencedor, portada do `select.mjs` do prompt-arena.
// Métrica primária: judge-score = (resolve + 0.5·parcial) / total · 100.
// Uma variante só é promovida se superar o judge-score do controle por uma
// margem mínima (`minGain`); sem ganho, o controle se mantém (convergência).

import type { Verdict } from './types.js';

/**
 * Judge-score em [0,100] a partir dos vereditos pointwise de um contestant.
 * `undefined` = veredito AUSENTE (juiz falhou, competidor com erro de infra,
 * bloqueio do gateway — IMPL-004/IMPL-005): é "sem observação" e sai do
 * NUMERADOR e do DENOMINADOR. Antes contava como 'nao' — um veredito imputado
 * que movia o score mais que o `minGain` (R-03b:REC-4, R-04:REC-2). Sem
 * nenhuma observação → 0 (sem evidência, sem score); a run que chega aí já é
 * `inconclusive` pelo piso de n efetivo (`engine/verdictIntegrity.ts`).
 */
export function judgeScoreFromVerdicts(verdicts: (Verdict | undefined)[]): number {
  let resolve = 0;
  let parcial = 0;
  let n = 0;
  for (const v of verdicts) {
    if (v === undefined) continue;
    n++;
    if (v === 'resolve') resolve++;
    else if (v === 'parcial') parcial++;
  }
  if (n === 0) return 0;
  return ((resolve + 0.5 * parcial) / n) * 100;
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

/**
 * Escolhe o vencedor entre as entradas. `best` é a melhor variante (controle
 * excluído — ele é a régua, não um candidato); `gain` é a vantagem do `best`
 * sobre o controle em pontos de judge-score; `isWinner` exige `gain >= minGain`
 * (default 1.0 — promoção só com margem real, senão o treino convergiu).
 */
export function pickWinner(
  entries: RankEntry[],
  opts?: { minGain?: number },
): { best: RankEntry | undefined; control: RankEntry | undefined; gain: number; isWinner: boolean } {
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
  const gain = best.judgeScore - control.judgeScore;
  return { best, control, gain, isWinner: gain >= minGain };
}
