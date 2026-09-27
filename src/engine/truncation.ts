// Deteccao de TRUNCAMENTO por chamada (IMPL-014 / R-07b:DEC-2 + REC-2).
//
// Os provedores devolvem 200 OK tanto para a resposta completa quanto para a
// cortada no teto de `max_tokens` (OpenAI `length`, Anthropic `max_tokens`,
// Gemini `MAX_TOKENS`) — sem ler os sinais de fim as duas sao
// indistinguiveis, e a cortada virava veredito 'nao' em silencio. O caso mais
// comum hoje e o raciocinio comer o teto inteiro: `finish_reason: length`,
// `content` vazio e `completion_tokens` todos de raciocinio.
//
// Modulo PURO (sem rede, sem Node): o gateway (`src/openrouter.ts`) decide o
// `truncated` de cada chamada aqui, os papeis persistem os sinais e os dois
// orquestradores (Node e SPA) calculam a `truncationRate` da run com a mesma
// funcao — fonte unica, o web importa direto de `src/engine/`.

import type { CallFinishSignals, TruncationSignal } from '../types.js';

/**
 * `native_finish_reason` que significam "parou no teto", comparados sem caixa:
 * OpenAI/Mistral `length`, Anthropic `max_tokens`, Gemini/Cohere `MAX_TOKENS`,
 * Responses API `max_output_tokens`, vLLM `model_length` (janela esgotada).
 */
const NATIVE_LENGTH = new Set(['length', 'max_tokens', 'max_output_tokens', 'model_length']);

/**
 * "reasoning_tokens ≈ teto": >= 95% do `max_tokens` enviado. A folga de 5%
 * cobre a diferenca de contagem entre provedores (alguns somam o separador de
 * raciocinio, outros nao) sem virar um limiar arbitrariamente baixo.
 */
export const REASONING_CAP_RATIO = 0.95;

/** Retry unico por truncamento: teto x2 (R-07b:DEC-2). */
export const TRUNCATION_RETRY_FACTOR = 2;

/** Acima desta fracao de chamadas truncadas numa run, CLI e UI alertam (R-07b:REC-2). */
export const TRUNCATION_ALERT_RATE = 0.02;

/** O que o gateway observou no fim de UMA chamada. */
export interface FinishObservation {
  finishReason?: string;
  nativeFinishReason?: string;
  reasoningTokens?: number;
  /** `completion_tokens` (inclui raciocinio). */
  tokensOut: number;
  /** Tamanho do conteudo VISIVEL (sem a recusa declarada). */
  contentChars: number;
  /** `max_tokens` enviado (ausente = sem teto no corpo => `reasoning_at_cap` nao se aplica). */
  maxTokens?: number;
  /**
   * O conteudo vazio JA tem explicacao (bloqueio de moderacao, recusa
   * declarada em `message.refusal`): nao conta como `empty_with_tokens`.
   */
  explainedEmpty?: boolean;
}

/** Todos os sinais presentes — inclusive os auxiliares que, sozinhos, nao decidem. */
export function truncationSignals(o: FinishObservation): TruncationSignal[] {
  const sinais: TruncationSignal[] = [];
  if (o.finishReason?.trim().toLowerCase() === 'length') sinais.push('finish_length');
  const nativo = o.nativeFinishReason?.trim().toLowerCase();
  if (nativo && NATIVE_LENGTH.has(nativo)) sinais.push('native_length');
  if (
    typeof o.maxTokens === 'number' &&
    o.maxTokens > 0 &&
    typeof o.reasoningTokens === 'number' &&
    o.reasoningTokens >= REASONING_CAP_RATIO * o.maxTokens
  ) {
    sinais.push('reasoning_at_cap');
  }
  if (!o.explainedEmpty && o.contentChars === 0 && o.tokensOut > 0) sinais.push('empty_with_tokens');
  return sinais;
}

/**
 * A DECISAO. `length` (normalizado ou nativo) decide sozinho. Os sinais
 * auxiliares (`reasoning_at_cap`, `empty_with_tokens`) decidem quando o
 * provedor nao declarou `finish_reason` nenhum; com um motivo explicito que
 * nao e teto (ex.: `stop`), so decidem se os DOIS concordarem — o raciocinio
 * comeu o teto E nao sobrou conteudo. Assim uma resposta vazia com `stop`
 * legitimo segue sendo resposta (o juiz a pune como 'nao'), e um `stop` mal
 * rotulado por um provedor com o teto consumido nao passa como completo.
 */
export function isTruncated(o: FinishObservation, sinais: TruncationSignal[] = truncationSignals(o)): boolean {
  if (sinais.includes('finish_length') || sinais.includes('native_length')) return true;
  const semMotivo = !o.finishReason?.trim() && !o.nativeFinishReason?.trim();
  if (semMotivo) return sinais.includes('reasoning_at_cap') || sinais.includes('empty_with_tokens');
  return sinais.includes('reasoning_at_cap') && sinais.includes('empty_with_tokens');
}

/** O que `finishSignalsOf` le do `ChatCompletionResult` (estrutural: modulo puro). */
export interface FinishedCallLike {
  text: string;
  tokensOut: number;
  reasoningTokens?: number;
  finishReason?: string;
  nativeFinishReason?: string;
  truncated?: boolean;
  truncationSignals?: TruncationSignal[];
}

/**
 * Registro persistido (`CallFinishSignals`) de uma chamada que completou. NAO
 * recalcula a decisao: ela e do gateway (`ChatCompletionResult.truncated`),
 * ponto unico — aqui so se copia o que ele observou + o teto usado.
 */
export function finishSignalsOf(
  res: FinishedCallLike,
  maxTokens: number | undefined,
  truncationRetried = false,
): CallFinishSignals {
  return {
    ...(res.finishReason ? { finishReason: res.finishReason } : {}),
    ...(res.nativeFinishReason ? { nativeFinishReason: res.nativeFinishReason } : {}),
    ...(typeof res.reasoningTokens === 'number' ? { reasoningTokens: res.reasoningTokens } : {}),
    tokensOut: res.tokensOut,
    contentChars: res.text.length,
    ...(typeof maxTokens === 'number' ? { maxTokens } : {}),
    truncated: res.truncated === true,
    ...(res.truncationSignals?.length ? { truncationSignals: [...res.truncationSignals] } : {}),
    ...(truncationRetried ? { truncationRetried: true } : {}),
  };
}

/** Teto do retry por truncamento (inteiro, nunca menor que o original + 1). */
export function retryMaxTokens(maxTokens: number): number {
  return Math.max(maxTokens + 1, Math.ceil(maxTokens * TRUNCATION_RETRY_FACTOR));
}

/** Forma minima que `truncationStats` le de um StageRecord (Node e SPA). */
interface StageLike {
  responses?: ReadonlyArray<{ truncated?: boolean; truncationRetried?: boolean }>;
  gabaritoCall?: { truncated?: boolean; truncationRetried?: boolean };
}

export interface TruncationStats {
  /** Chamadas com sinal de fim observado (cada tentativa conta; o retry x2 e uma chamada). */
  calls: number;
  /** Quantas dessas sairam truncadas. */
  truncated: number;
  /** truncated / calls, 4 casas (0 quando nao houve chamada). */
  rate: number;
}

/**
 * Taxa de truncamento da run: competidores + gabaritos, CADA TENTATIVA conta
 * (a 1a tentativa que truncou e foi repetida tambem e uma chamada truncada — e
 * justamente o que calibra o teto, R-07b:REC-1). Respostas sem `truncated`
 * (erro de infra, 403, records antigos, agente) ficam fora do denominador.
 * Puro e idempotente: recalculado do record inteiro, nunca incrementado.
 */
export function truncationStats(stages: ReadonlyArray<StageLike>): TruncationStats {
  let calls = 0;
  let truncated = 0;
  const contar = (c: { truncated?: boolean; truncationRetried?: boolean }): void => {
    const repetida = c.truncationRetried === true;
    if (typeof c.truncated !== 'boolean') {
      // O retry falhou (erro/403) depois de uma 1a tentativa truncada: essa 1a
      // chamada completou e truncou — conta; a que falhou nao tem sinal de fim.
      if (repetida) {
        calls += 1;
        truncated += 1;
      }
      return;
    }
    calls += repetida ? 2 : 1;
    truncated += (repetida ? 1 : 0) + (c.truncated ? 1 : 0);
  };
  for (const st of stages) {
    for (const r of st.responses ?? []) contar(r);
    if (st.gabaritoCall) contar(st.gabaritoCall);
  }
  return { calls, truncated, rate: calls > 0 ? Number((truncated / calls).toFixed(4)) : 0 };
}

/**
 * Mensagem de alerta (PT-BR) quando a taxa passa de 2%; `undefined` abaixo.
 * Estritamente ACIMA do limiar ("> 2%"), como no criterio da pesquisa.
 */
export function truncationAlert(stats: Pick<TruncationStats, 'calls' | 'truncated' | 'rate'>): string | undefined {
  if (!(stats.calls > 0) || !(stats.rate > TRUNCATION_ALERT_RATE)) return undefined;
  const pct = (stats.rate * 100).toFixed(1).replace('.', ',');
  return (
    `${stats.truncated} de ${stats.calls} chamadas (${pct}%) saíram truncadas no teto de tokens — ` +
    `acima do limite de ${(TRUNCATION_ALERT_RATE * 100).toFixed(0)}%. Etapas com resposta truncada ficaram ` +
    `fora do placar; aumente o teto (maxTokens/--max-output-tokens) ou baixe o esforço de raciocínio.`
  );
}

/** Respostas de competidor que TRUNCARAM (mesmo apos o retry) — o gatilho da etapa `incomplete`. */
export function truncatedResponses<R extends { truncated?: boolean }>(responses: ReadonlyArray<R>): R[] {
  return responses.filter((r) => r.truncated === true);
}

/**
 * Texto (PT-BR) do evento `stage.incomplete` por truncamento — o MESMO nos dois
 * orquestradores. Nunca inclui o texto das respostas (so quem, e em que teto).
 */
export function describeTruncatedStage(
  stageIndex: number,
  truncadas: ReadonlyArray<{ contestantId: string; maxTokens?: number }>,
  labelOf: (id: string) => string = (id) => id,
): string {
  const quem = truncadas
    .map((r) => `${labelOf(r.contestantId)}${typeof r.maxTokens === 'number' ? ` (teto ${r.maxTokens})` : ''}`)
    .join(', ');
  return (
    `Etapa ${stageIndex + 1} incompleta por truncamento: ${quem} — resposta cortada no teto de tokens ` +
    `mesmo após o retry com teto x2. Etapa fora do placar e das médias (não foi julgada).`
  );
}
