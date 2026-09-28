// Agregação de vereditos de PAINEL (vários juízes / repetições) — núcleo PURO
// (IMPL-007, R-03a:DEC-3). Fonte única para refJudge.ts, judge.ts e o juiz de
// agente: antes cada um tinha uma cópia da MÉDIA ORDINAL (resolve=2, parcial=1,
// nao=0; média >= 1.5 => resolve, >= 0.5 => parcial), que ARREDONDAVA PARA CIMA
// todo painel dividido — resolve+parcial virava 'resolve' e parcial+nao virava
// 'parcial'. Com 2 juízes isso inflava o judge-score de quem dividia o painel e
// virava vantagem sistemática no treino.
//
// Regra agora: MAIORIA SIMPLES. O veredito é o MAIOR nível que uma maioria
// ESTRITA do painel endossa como "pelo menos isso" (= mediana inferior). Com
// maioria clara é exatamente o veredito da maioria; SEM maioria clara num único
// veredito é EMPATE TÉCNICO: `tie: true`, e o valor gravado é o nível que a
// maioria endossa (resolve+parcial => 'parcial'; parcial+nao => 'nao') — nunca o
// voto de cima. Painel ímpar de 3 (PoLL) raramente empata; é por isso que a
// pesquisa o recomenda para promoção/finais.
//
// Só lê — zero LLM, zero I/O.

import type { RunRecord, Verdict } from '../types.js';

const RANK: Record<Verdict, number> = { nao: 0, parcial: 1, resolve: 2 };

export interface AggregatedVerdict {
  /** Veredito do painel (maioria simples; em empate, o nível que a maioria endossa). */
  verdict: Verdict;
  /** true = nenhum veredito teve maioria ESTRITA: EMPATE TÉCNICO. */
  tie: boolean;
  /** Votos legítimos do painel, do pior ao melhor (auditoria/rótulo do empate). */
  votes: Verdict[];
}

/**
 * Agrega os votos LEGÍTIMOS de um painel. Lista vazia => `null`: sem voto não há
 * veredito (IMPL-004 — nunca imputar 'parcial').
 */
export function aggregateVerdicts(votes: readonly Verdict[]): AggregatedVerdict | null {
  const n = votes.length;
  if (n === 0) return null;
  const sorted = [...votes].sort((a, b) => RANK[a] - RANK[b]);
  // Mediana INFERIOR: o maior nível L com #(votos >= L) > n/2.
  const verdict = sorted[Math.ceil(n / 2) - 1];
  const doVeredito = sorted.filter((v) => v === verdict).length;
  return { verdict, tie: doVeredito * 2 <= n, votes: sorted };
}

/** Rótulo curto do empate para explicação/UI: "empate técnico (parcial × resolve)". */
export function tieLabel(votes: readonly Verdict[]): string {
  const distintos = [...new Set([...votes].sort((a, b) => RANK[a] - RANK[b]))];
  return `empate técnico (${distintos.join(' × ')})`;
}

/**
 * Convenção de agregação gravada no RunRecord. Ausente = record anterior ao
 * IMPL-007 (média ordinal arredondada para cima).
 */
export const VERDICT_AGGREGATION = 'majority' as const;
export type VerdictAggregation = typeof VERDICT_AGGREGATION;

/**
 * Aviso de MUDANÇA DE ESCALA do judge-score para runs antigas. Só runs com
 * painel (>= 2 juízes) foram afetadas: com juiz único não havia o que agregar
 * e a nota é a mesma nas duas convenções. `undefined` = comparável.
 */
export function judgeScaleWarning(
  record: Pick<RunRecord, 'verdictAggregation'> & { config?: { judgeModelIds?: readonly string[] } },
): string | undefined {
  if (record.verdictAggregation === VERDICT_AGGREGATION) return undefined;
  const juizes = record.config?.judgeModelIds?.length ?? 0;
  if (juizes < 2) return undefined;
  return (
    'Run anterior à agregação por maioria (IMPL-007): com painel de ' +
    `${juizes} juízes o judge-score foi calculado por média ordinal ARREDONDADA PARA CIMA ` +
    '(resolve+parcial contava como resolve). Não compare esse judge-score com o de runs novas.'
  );
}
