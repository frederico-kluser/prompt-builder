// Tetos de `max_tokens` POR PAPEL (IMPL-016 / R-07b:REC-1) — FONTE ÚNICA.
//
// Na maioria dos provedores os tokens de RACIOCÍNIO contam contra `max_tokens`:
// o teto do topo do corpo é TOTAL (raciocínio + resposta). Com os tetos antigos
// (gabarito 1500, juiz pointwise 1024, duelo 512, juiz listwise SEM teto,
// competidor = stage.maxTokens) um modelo que raciocina gastava o teto inteiro
// pensando e devolvia `content` vazio com `finish_reason: length` — que virava
// 'nao'/empate automático (modo de falha medido: glm-5.2 com max_tokens=20 →
// content null, 20 completion tokens todos de raciocínio).
//
// Aqui só moram os NÚMEROS; cada papel troca o literal pela constante. A
// invariante do corpo NÃO muda: o esforço vai como `reasoning: { effort }` e
// nunca junto de `reasoning.max_tokens` (src/reasoning.ts, applyReasoning).
//
// Módulo PURO (sem rede, sem Node): o web re-exporta por shim
// (web/src/engine/roleLimits.ts) — o duelo do SPA é mirror e lê daqui.

import type { ReasoningLevel } from './types.js';

/** Papéis de JUÍZO com teto fixo (o competidor tem teto por etapa + folga). */
export type JudgingRole = 'judge' | 'duel' | 'gabarito';

/**
 * PISOS da pesquisa (R-07b:REC-1). Um teto de papel abaixo disto é bug:
 * `test/role-limits.test.ts` reprova com os números LITERAIS, então baixar
 * piso e teto juntos aqui também quebra o teste.
 */
export const ROLE_MAX_TOKENS_FLOOR: Readonly<Record<JudgingRole, number>> = Object.freeze({
  judge: 4096,
  duel: 2048,
  gabarito: 3072,
});

/**
 * Teto TOTAL (raciocínio + resposta) que cada papel de juízo ENVIA. Hoje = piso.
 * `judge` vale para os três juízes: pointwise (refJudge), listwise (judge) e o
 * do dossiê de agente (agentJudge). Subir é livre; o ledger reserva pelo teto
 * enviado e cobra pelo `usage.cost` medido, então teto maior só aumenta a
 * RESERVA (e a estimativa), não o gasto real.
 */
export const ROLE_MAX_TOKENS: Readonly<Record<JudgingRole, number>> = Object.freeze({
  judge: 4096,
  duel: 2048,
  gabarito: 3072,
});

/**
 * Folga de raciocínio do COMPETIDOR por degrau, somada à resposta
 * (`stage.maxTokens`, limitada por `maxOutputTokens`). Heurística calibrável
 * pela `truncationRate` por papel (IMPL-014): a razão effort→tokens por degrau
 * não tem fonte pública consistente (R-07b:abertas #1), então a escada dobra a
 * cada degrau a partir do orçamento mínimo de raciocínio da Anthropic (1024).
 * `off` e `minimal` ficam com 1024 e não 0: num modelo `mandatory` o `off` NÃO
 * é enviado (o provedor rejeita `none`) e ele raciocina do mesmo jeito.
 */
export const COMPETITOR_REASONING_HEADROOM: Readonly<Record<ReasoningLevel, number>> = Object.freeze({
  off: 1024,
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 12288,
  max: 16384,
});

/** Degrau AUSENTE = padrão do modelo (`default_effort` do catálogo, tipicamente medium). */
export const COMPETITOR_DEFAULT_HEADROOM = COMPETITOR_REASONING_HEADROOM.medium;

/** Folga de raciocínio do competidor para o degrau pedido (desconhecido/ausente => padrão). */
export function competitorReasoningHeadroom(level?: ReasoningLevel): number {
  if (!level) return COMPETITOR_DEFAULT_HEADROOM;
  return COMPETITOR_REASONING_HEADROOM[level] ?? COMPETITOR_DEFAULT_HEADROOM;
}

/**
 * Teto TOTAL do competidor: a resposta pedida + a folga de raciocínio do degrau.
 * `answerTokens` é o orçamento da RESPOSTA (`min(maxOutputTokens, stage.maxTokens)`);
 * o modelo não vê `max_tokens` (não é instrução de concisão), então a folga só
 * evita que o raciocínio coma a resposta — não a alonga.
 */
export function competitorMaxTokens(answerTokens: number, level?: ReasoningLevel): number {
  const answer = Number.isFinite(answerTokens) && answerTokens > 0 ? Math.ceil(answerTokens) : 0;
  return answer + competitorReasoningHeadroom(level);
}

/**
 * Violações de piso numa config de tetos por papel (vazio = ok). É o que o
 * teste de contrato roda sobre `ROLE_MAX_TOKENS`; papel ausente ou teto não
 * numérico também é violação (sem teto o raciocínio não tem sala garantida
 * e o ledger reservaria às cegas).
 */
export function roleMaxTokensViolations(
  limits: Partial<Record<JudgingRole, number>>,
  floors: Readonly<Record<JudgingRole, number>> = ROLE_MAX_TOKENS_FLOOR,
): string[] {
  const out: string[] = [];
  for (const role of Object.keys(floors) as JudgingRole[]) {
    const v = limits[role];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      out.push(`${role}: teto ausente (piso ${floors[role]})`);
    } else if (v < floors[role]) {
      out.push(`${role}: teto ${v} abaixo do piso ${floors[role]}`);
    }
  }
  return out;
}
