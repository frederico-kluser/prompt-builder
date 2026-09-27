// Política do LAÇO de treino (IMPL-013 — R-02b:REC-2). Módulo puro: roda igual
// no Node e no navegador (o trainer do web o importa direto, como `halving`).
//
// O PROBLEMA. O laço encerrava a sessão na PRIMEIRA iteração sem promoção
// (paciência implícita 1) e confirmava a promoção com as MESMAS avaliações que
// escolheram a melhor de K — o winner's curse entra duas vezes: na escolha e na
// confirmação. Com veredito ternário ruidoso a simulação local da pesquisa mediu
// 51–86% de promoção falsa (60,8% com n = 8, K = 4, flip 0,15). Os defaults de
// referência (MIPROv2 / DeepEval-GEPA / CAPO) usam minibatch de aceitação,
// paciência 2–3 e proposta múltipla.
//
// A POLÍTICA (defaults fixados aqui, consumidos pelos dois trainers, pelo
// estimador e pelo harness `npm run stats:sim`):
// - paciência 2: a sessão só encerra depois de 2 iterações SEGUIDAS sem
//   promoção (uma iteração azarada não mata a busca);
// - re-avaliação LIMPA: o candidato que passou no gate da melhor de K (IMPL-002)
//   roda de novo contra a régua num minibatch de max(5, ceil(0,3·n)) cenários de
//   TREINO, com respostas e vereditos NOVOS (nada reaproveitado da seleção). Só
//   promove se melhorar ESTRITAMENTE no minibatch (regra de aceitação do GEPA);
// - K = 4–6 técnicas por iteração: acima de 6, as técnicas escolhidas RODAM entre
//   as iterações (subconjunto determinístico por sessão) — o max-T corrige a
//   multiplicidade, mas K grande custa poder e dinheiro;
// - 3–5 iterações (o default das telas/arena-config é 3; o schema aceita 2–10).
// A parada dura por orçamento (ledger) continua valendo, e a estimativa
// pré-iteração conta TODA avaliação extra (re-avaliação e carry) — ver
// `estimateInputFromConfig`.

import { mulberry32, pairCoverage, type PairScore } from '../stats.js';
import type { PairCoverage } from '../types.js';

/** Iterações seguidas SEM promoção que encerram a sessão. */
export const TRAINING_PATIENCE = 2;
/** Faixa recomendada de iterações (o default das telas é o mínimo). */
export const TRAINING_ITERATIONS = { min: 3, max: 5, default: 3 } as const;
/** Técnicas (variantes reescritas) por iteração. */
export const TECHNIQUES_PER_ITERATION = { min: 4, max: 6 } as const;
/** Piso do minibatch de re-avaliação limpa. */
export const REEVAL_MIN_SCENARIOS = 5;

/**
 * Tamanho do minibatch de re-avaliação: max(5, ceil(0,3·n)), limitado a n (com
 * menos de 5 cenários de treino, re-avalia todos). Aritmética inteira
 * (`ceil(3n/10)`) para o `ceil` nunca depender de arredondamento de double.
 */
export function selectionMinibatchSize(n: number): number {
  const total = Math.max(0, Math.floor(n));
  if (total === 0) return 0;
  return Math.min(total, Math.max(REEVAL_MIN_SCENARIOS, Math.ceil((3 * total) / 10)));
}

/**
 * Paciência: `true` quando a sequência de iterações sem promoção atingiu o
 * limite e a sessão deve encerrar (convergiu).
 */
export function shouldStopForPatience(streakWithoutPromotion: number, patience = TRAINING_PATIENCE): boolean {
  return streakWithoutPromotion >= Math.max(1, Math.floor(patience));
}

/** Embaralhamento de Fisher-Yates semeado (determinístico, não muta a entrada). */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rng = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Técnicas da iteração `iteration`. Até {@link TECHNIQUES_PER_ITERATION}.max a
 * lista vai inteira (mesma referência). Acima, uma janela de `max` técnicas
 * desliza sobre uma ordem embaralhada UMA vez por sessão (`seed`): iterações
 * seguidas cobrem técnicas diferentes e, em ⌈len/max⌉ iterações, todas rodam.
 * Abaixo do mínimo (4) nada é inventado — a escolha do usuário é respeitada.
 */
export function techniquesForIteration(
  techniqueIds: readonly string[] | undefined,
  iteration: number,
  seed: number,
  max: number = TECHNIQUES_PER_ITERATION.max,
): string[] | undefined {
  if (!techniqueIds) return undefined;
  const cap = Math.max(1, Math.floor(max));
  if (techniqueIds.length <= cap) return techniqueIds as string[];
  const order = seededShuffle(techniqueIds, seed);
  const start = (Math.max(0, iteration) * cap) % order.length;
  return Array.from({ length: cap }, (_, k) => order[(start + k) % order.length]);
}

/**
 * Sorteia o minibatch de re-avaliação entre os cenários de TREINO (o holdout
 * nunca entra). Determinístico por `seed`; preserva a ordem original.
 */
export function pickReevalMinibatch<T>(stages: readonly T[], seed: number): T[] {
  const m = selectionMinibatchSize(stages.length);
  if (m >= stages.length) return [...stages];
  const chosen = new Set(seededShuffle(Array.from(stages.keys()), seed).slice(0, m));
  return stages.filter((_, i) => chosen.has(i));
}

/** Decisão da re-avaliação limpa sobre os pares do minibatch. */
export interface ReevalDecision {
  pairing: PairCoverage;
  /** Δ candidato − régua nos pares completos do minibatch (p.p.); 0 sem par. */
  gainPp: number;
  confirmed: boolean;
}

/**
 * Aceitação estilo GEPA: confirma só com melhora ESTRITA do candidato sobre a
 * régua nos pares completos do minibatch (ausente sai dos dois lados, IMPL-005).
 * Sem par completo não há evidência → não confirma.
 */
export function reevalDecision(
  controlScores: readonly PairScore[],
  candidateScores: readonly PairScore[],
): ReevalDecision {
  const pairing = pairCoverage(controlScores, candidateScores);
  const gainPp = pairing.meanDiffPp ?? 0;
  return { pairing, gainPp, confirmed: pairing.nEfetivo > 0 && gainPp > 1e-9 };
}
