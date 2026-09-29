// Decisões de SESSÃO em texto (CLI, UI, handoff e relatório leem a MESMA frase).
//
// Módulo puro (sem node:*, sem I/O): o web importa direto de src/engine/ — não
// é uma terceira cópia. A entrada é ESTRUTURAL (subconjunto do SessionRecord),
// para servir aos dois motores (o do web aceita `stoppedReason: 'orphan'`) e a
// records antigos, gravados antes de `holdoutSkipReason`/`reevalRunIds`.
//
// - `holdoutSkipReasonOf`: POR QUE a sessão ficou sem holdout (web-code#8,
//   cli#9) — gravado pelo trainer; em record antigo, derivado dos campos que
//   já existiam (o caminho do piso nunca grava `stoppedReason`).
// - `sessionConfirmationText`: a palavra "validado" só com holdout forte que
//   rodou E confirmou (IMPL-050) — o texto antigo ignorava regressão e p.
// - `convergenceReasonText`: o motivo da convergência (IMPL-051), platão vs
//   paciência, com o mesmo texto no CLI e na UI.
// - `reevalRunIdsOf`: as runs de re-avaliação limpa (web-code#18), fora de
//   `runIds` de propósito.
// - `sessionRecommendationOf`: o veredito de recomendação com recusa honesta
//   (IMPL-046) — o MESMO objeto em `sessions show`/`winner` e na TrainingView,
//   com os braços rotulados (nunca o id interno `holdout-control`).

import {
  holdoutConfirmationText,
  holdoutStrength,
  type HoldoutOutcome,
} from '../holdout.js';
import {
  recommendationFromStored,
  reportPValue,
  significanceOrigin,
  type RecommendationDecision,
  type SignificanceWithOrigin,
} from '../stats.js';
import type { HoldoutSkipReason } from '../types.js';
import { TRAINING_PATIENCE } from './trainingPolicy.js';

/** O que as decisões de sessão leem do SessionRecord (subconjunto estrutural). */
export interface SessionDecisionInput {
  holdout?: { n: number; gain: number; regressed: boolean } | null;
  holdoutSkipped?: boolean;
  holdoutSkipReason?: HoldoutSkipReason;
  stoppedReason?: string | null;
  budgetExhausted?: boolean;
  significance?: SignificanceWithOrigin | null;
  pairing?: { source: 'holdout' | 'training'; controlId?: string; championId?: string } | null;
}

/**
 * Por que a sessão ficou sem resultado de holdout. O motivo GRAVADO pelo
 * trainer vence; em record antigo (sem o campo) deriva: parada por
 * orçamento/cancelamento grava `stoppedReason`/`budgetExhausted`, e o caminho
 * do piso de 10 cenários nunca grava — `holdoutSkipped` sem parada é seleção
 * pequena demais. Com `holdout` presente não há o que explicar (`undefined`).
 */
export function holdoutSkipReasonOf(s: SessionDecisionInput): HoldoutSkipReason | undefined {
  if (s.holdoutSkipReason) return s.holdoutSkipReason;
  if (s.holdout) return undefined;
  if (!s.holdoutSkipped) return undefined;
  if (s.stoppedReason === 'budget' || s.budgetExhausted) return 'budget';
  if (s.stoppedReason) return 'cancelled';
  return 'min-scenarios';
}

/**
 * Origem do p gravado. Sessões entre o IMPL-001 e o IMPL-050 não gravavam
 * `pOrigin`, mas o pareamento final dizia de onde o teste veio — o p exato
 * (com `pValueTwoSided`) de um pareamento `holdout` É do holdout.
 */
function pOriginOf(s: SessionDecisionInput): HoldoutOutcome['pOrigin'] {
  const sig = s.significance;
  if (!sig) return 'sem p';
  if (sig.pOrigin) return sig.pOrigin;
  if (s.pairing?.source === 'holdout' && reportPValue(sig).kind === 'two-sided') return 'holdout';
  return significanceOrigin(sig);
}

/**
 * Texto de confirmação do campeão contra sobreajuste (IMPL-050) — o que
 * `sessions show`/`sessions winner` e a UI mostram. "validado" SÓ quando o
 * holdout é forte (n ≥ 10), rodou, não regrediu e o p unilateral DO HOLDOUT
 * ficou ≤ 0,05; sem holdout, a frase traz o MOTIVO (nunca "orçamento" por
 * padrão).
 */
export function sessionConfirmationText(s: SessionDecisionInput): string {
  if (s.holdout) {
    const sig = s.significance;
    return holdoutConfirmationText(s.holdout.n, {
      strength: holdoutStrength(s.holdout.n),
      outcome: {
        regressed: s.holdout.regressed,
        gainPp: s.holdout.gain,
        pValue: sig ? sig.pValue : null,
        pOrigin: pOriginOf(s),
      },
    });
  }
  return holdoutConfirmationText(0, {
    skipped: Boolean(s.holdoutSkipped),
    strength: 'nenhum',
    skipReason: holdoutSkipReasonOf(s),
  });
}

/**
 * Rótulo legível de um braço do pareamento final (IMPL-046). Os ids são
 * internos do trainer (`holdout-control`, `carry`, …) e vazavam no texto do
 * veredito ("recomendo manter holdout-control"). O candidato é sempre o
 * campeão da sessão; o controle é a régua do pareamento.
 */
export function pairingArmLabel(role: 'control' | 'candidate', id?: string): string {
  if (role === 'candidate') return 'campeão';
  switch (id) {
    case 'holdout-control':
      return 'controle (base)';
    case 'original':
      return 'original';
    case 'carry':
      return 'campeão anterior';
    case undefined:
    case '':
      return 'controle';
    default:
      return id;
  }
}

/**
 * Veredito de recomendação da sessão (IMPL-046, R-11a:REC-4) — o objeto
 * ESTÁVEL de `recommendationFromStored` sobre a significância gravada, com os
 * braços rotulados por `pairingArmLabel`. É a MESMA chamada no CLI
 * (`sessions show`/`sessions winner`) e na tela de Treino: a recusa honesta
 * ("empate técnico … rode N=…") sai igual nas duas. `null` = sem significância
 * gravada (menos de 5 pares) — quem chama mostra o "amostra insuficiente".
 */
export function sessionRecommendationOf(s: SessionDecisionInput): RecommendationDecision | null {
  return recommendationFromStored(s.significance, {
    labels: {
      candidate: pairingArmLabel('candidate', s.pairing?.championId),
      control: pairingArmLabel('control', s.pairing?.controlId),
    },
  });
}

/**
 * Motivo da convergência (IMPL-051) em PT-BR — platão (IC95 do ganho abaixo
 * de minGain) ou paciência (N iterações seguidas sem promoção).
 */
export function convergenceReasonText(reason: 'patience' | 'plateau' | undefined, patience?: number): string {
  if (reason === 'plateau') return 'platão — IC95 do ganho abaixo de minGain';
  if (reason === 'patience') {
    // Sem `patience` no config vale o default do laço (o mesmo do trainer).
    const p = typeof patience === 'number' && patience > 0 ? Math.floor(patience) : TRAINING_PATIENCE;
    return `paciência — ${p} iteraç${p === 1 ? 'ão' : 'ões'} seguida${p === 1 ? '' : 's'} sem promoção`;
  }
  return 'motivo não registrado';
}

/**
 * Runs de re-avaliação limpa da sessão (web-code#18): a lista gravada
 * (`reevalRunIds`) ∪ os ids que ficaram no gate de cada iteração — records
 * antigos só têm os do gate. Sem repetição, na ordem em que apareceram.
 */
export function reevalRunIdsOf(s: {
  reevalRunIds?: readonly string[];
  bestPromptByIteration?: readonly { gate?: { reeval?: { runId?: string } } }[];
}): string[] {
  const ids = new Set<string>(s.reevalRunIds ?? []);
  for (const it of s.bestPromptByIteration ?? []) {
    const rid = it.gate?.reeval?.runId;
    if (rid) ids.add(rid);
  }
  return [...ids];
}
