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

import type { HumanReviewItem, JudgeConfidence, RunRecord, Verdict } from '../types.js';
import { HUMAN_REVIEW_COST_USD } from './groundTruth.js';

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

// ----------------------------------------------------------------------------
// Quais etapas FORMAM o judge-score (web-code#12). A regra mora aqui — fonte
// única para os dois orquestradores (`judgeScoreByContestant`) e para quem
// mostra contagens/nota por contestant (heatmap, narrativa, CLI): antes a tela
// contava também os vereditos LISTWISE das etapas cujo gabarito falhou ou foi
// descartado (cortado), e a nota/ordem do heatmap divergia da nota oficial.
// ----------------------------------------------------------------------------

/** Fatia de etapa que a regra lê (compatível com `StageRecord` dos dois lados). */
export interface JudgeScoreStageLike {
  referenceJudge?: { verdictByContestant?: Record<string, Verdict> } | null;
  incomplete?: boolean;
}

/**
 * A etapa entra no judge-score oficial? Só etapa julgada POR REFERÊNCIA e não
 * cortada (`incomplete` — orçamento/cancelamento/truncamento). Etapa listwise
 * (sem gabarito) é outro instrumento: fica FORA da nota por referência.
 */
export function stageCountsInJudgeScore(stage: JudgeScoreStageLike): boolean {
  return Boolean(stage.referenceJudge) && !stage.incomplete;
}

/** Contagem que FORMA o judge-score de um contestant (resolve/parcial/nao sobre as etapas que valem). */
export function judgeScoreTally(
  stages: ReadonlyArray<JudgeScoreStageLike>,
  contestantId: string,
): { resolve: number; parcial: number; nao: number; judged: number } {
  let resolve = 0;
  let parcial = 0;
  let nao = 0;
  for (const s of stages) {
    if (!stageCountsInJudgeScore(s)) continue;
    const v = s.referenceJudge?.verdictByContestant?.[contestantId];
    if (v === 'resolve') resolve += 1;
    else if (v === 'parcial') parcial += 1;
    else if (v === 'nao') nao += 1;
  }
  return { resolve, parcial, nao, judged: resolve + parcial + nao };
}

// ----------------------------------------------------------------------------
// Triagem de revisão humana por CONFIANÇA (IMPL-047 → IMPL-055): o juiz
// devolve `confianca` por veredito; 'baixa' é candidato natural a revisão e
// entra na fila `needs-human-review` da run (zero LLM — só lê o que foi gravado).
// ----------------------------------------------------------------------------

/** Fatia de etapa lida pela triagem por confiança. */
export interface ConfidenceStageLike {
  index: number;
  incomplete?: boolean;
  referenceJudge?: { confidenceByContestant?: Record<string, JudgeConfidence> } | null;
}

/** Itens `low_confidence_verdict` (1 por etapa × contestant com `confianca: 'baixa'`). */
export function lowConfidenceReviewItems(stages: ReadonlyArray<ConfidenceStageLike>): HumanReviewItem[] {
  const itens: HumanReviewItem[] = [];
  for (const st of stages) {
    if (st.incomplete) continue;
    for (const [contestantId, conf] of Object.entries(st.referenceJudge?.confidenceByContestant ?? {})) {
      if (conf !== 'baixa') continue;
      itens.push({
        stageIndex: st.index,
        contestantId,
        reason: 'low_confidence_verdict',
        detail: "o juiz declarou confiança 'baixa' neste veredito — confira o veredito (e o gabarito) antes de usá-lo.",
        estimatedCostUsd: HUMAN_REVIEW_COST_USD,
      });
    }
  }
  return itens;
}
