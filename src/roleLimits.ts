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
// Módulo PURO (sem rede, sem Node; só `fitEffort`, também puro): o web re-exporta por shim
// (web/src/engine/roleLimits.ts) — o duelo do SPA é mirror e lê daqui.

import { fitEffort } from './reasoning.js';
import type { ModelReasoningMeta, ReasoningLevel } from './types.js';

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
 * Folga de raciocínio do COMPETIDOR por degrau EFETIVO, somada à resposta
 * (`stage.maxTokens`, limitada por `maxOutputTokens`). Heurística calibrável
 * pela `truncationRate` por papel (IMPL-014): a razão effort→tokens por degrau
 * não tem fonte pública consistente (R-07b:abertas #1), então a escada dobra a
 * cada degrau a partir do orçamento mínimo de raciocínio da Anthropic (1024).
 * `off` fica com 1024 e não 0 como margem para provedor que ignora
 * `{ enabled: false }`; o `off` de modelo `mandatory` NÃO usa esta linha (ver
 * `competitorReasoningHeadroom`).
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

/**
 * O que o CATÁLOGO diz do competidor — o que decide o esforço que REALMENTE vai
 * (ou não vai) no fio. Tudo opcional: catálogo frio / modelo fora dele = só o
 * degrau pedido (o comportamento de antes).
 */
export interface CompetitorModelHint {
  /** `OpenRouterModel.reasoning` (allowlist, `default_effort`, `mandatory`). */
  reasoning?: ModelReasoningMeta;
  /**
   * O catálogo DECLARA que o modelo não raciocina (`catalogDeniesReasoning` do
   * gateway): nenhum `reasoning` vai no fio e não há o que reservar.
   */
  deniesReasoning?: boolean;
  /** `context_length` do catálogo: prompt + max_tokens acima dele = HTTP 400. */
  contextLength?: number;
  /** Tokens de prompt estimados (mesma conta da reserva do gateway). */
  promptTokens?: number;
}

/** Folga do degrau que o provedor usa (nome do fio: 'none' = off). Desconhecido => padrão. */
function headroomOfEffort(effort: string | undefined): number {
  if (!effort) return COMPETITOR_DEFAULT_HEADROOM;
  const level = effort === 'none' ? 'off' : effort;
  return COMPETITOR_REASONING_HEADROOM[level as ReasoningLevel] ?? COMPETITOR_DEFAULT_HEADROOM;
}

/**
 * Folga de raciocínio do competidor pelo degrau EFETIVO — o mesmo que
 * `applyReasoning` envia (revisão IMPL-016): folga pelo degrau PEDIDO errava
 * nos dois casos em que o fio difere do pedido:
 *   - `off` em modelo `mandatory` não é enviado: o modelo raciocina no
 *     `default_effort` e a folga é a desse degrau (não a de `off`);
 *   - degrau fora da allowlist é encaixado por `fitEffort` ('minimal' em
 *     [high, medium, low] vira 'low'): a folga é a do degrau encaixado.
 * Catálogo nega raciocínio => 0 (nada vai no fio; reservar só incharia a porta).
 * Sem `hint` = só o degrau pedido (ausente => padrão do modelo).
 */
export function competitorReasoningHeadroom(level?: ReasoningLevel, hint: CompetitorModelHint = {}): number {
  if (hint.deniesReasoning) return 0;
  const meta = hint.reasoning;
  // Nada enviado => o modelo usa o próprio padrão.
  if (!level) return headroomOfEffort(meta?.defaultEffort);
  if (level === 'off') {
    return meta?.mandatory ? headroomOfEffort(meta.defaultEffort) : COMPETITOR_REASONING_HEADROOM.off;
  }
  return headroomOfEffort(fitEffort(level, meta));
}

/**
 * Teto TOTAL do competidor: a resposta pedida + a folga de raciocínio do degrau
 * efetivo. `answerTokens` é o orçamento da RESPOSTA (`min(maxOutputTokens,
 * stage.maxTokens)`); o modelo não vê `max_tokens` (não é instrução de
 * concisão), então a folga só evita que o raciocínio coma a resposta — não a
 * alonga. Com `contextLength` no catálogo a FOLGA é limitada ao que cabe
 * (prompt + max_tokens acima do contexto = HTTP 400); a resposta em si nunca é
 * cortada (é o teto de antes do IMPL-016). É ESTE número que a reserva da porta
 * dura usa e que `estimateRunCost` precifica — as duas portas usam o mesmo teto.
 */
export function competitorMaxTokens(
  answerTokens: number,
  level?: ReasoningLevel,
  hint: CompetitorModelHint = {},
): number {
  const answer = Number.isFinite(answerTokens) && answerTokens > 0 ? Math.ceil(answerTokens) : 0;
  let headroom = competitorReasoningHeadroom(level, hint);
  const room = competitorContextRoom(hint);
  if (room !== undefined) headroom = Math.max(0, Math.min(headroom, room - answer));
  return answer + headroom;
}

/**
 * `max_tokens` máximo que cabe no contexto do modelo (contexto − prompt), ou
 * `undefined` quando o catálogo não informa. Limita também o retry x2 por
 * truncamento (IMPL-014) do competidor.
 */
export function competitorContextRoom(hint: CompetitorModelHint = {}): number | undefined {
  const ctx = hint.contextLength;
  if (typeof ctx !== 'number' || !Number.isFinite(ctx) || ctx <= 0) return undefined;
  const prompt = typeof hint.promptTokens === 'number' && hint.promptTokens > 0 ? hint.promptTokens : 0;
  return Math.max(0, Math.floor(ctx - prompt));
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
