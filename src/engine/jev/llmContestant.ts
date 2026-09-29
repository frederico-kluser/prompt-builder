// Modo JEV — um LLM respondendo a MESMA decisão (competidor `llm`). Passa pelo
// gateway único (`chatCompletion`, role `competitor`, sink do ledger da run):
// limitador, contabilidade e LGPD são os de sempre. `per-question` (default):
// uma chamada por pergunta — várias perguntas num prompt de LLM não são
// independentes; `per-case` é opção, medida como tal.

import { isControlSignal } from '../../budget.js';
import type { CallCost, CostSink } from '../../types.js';
import type { ChatCompletionResult, OpenRouterGateway } from '../../openrouter.js';
import type { JevCase, JevCell, JevContestant, JevSpec, JevWireAnswer } from './types.js';
import { llmAnswerSchema, parseLlmText, renderLlmDecisionMessages } from './llmRender.js';

export interface LlmCellContext {
  apiKey: string;
  gateway: OpenRouterGateway;
  sink?: CostSink;
  signal?: AbortSignal;
}

/** Soma de custos de várias chamadas (fonte exata só se TODAS forem `usage`). */
export function combineCosts(costs: readonly CallCost[]): CallCost | undefined {
  if (!costs.length) return undefined;
  const usd = costs.reduce((s, c) => s + c.usd, 0);
  const pending = costs.reduce((s, c) => s + (c.pendingUsd ?? 0), 0);
  const source = costs.every((c) => c.source === 'usage')
    ? 'usage'
    : costs.some((c) => c.source === 'unknown')
      ? 'unknown'
      : 'catalog';
  return { usd, source, ...(pending > 0 ? { pendingUsd: pending } : {}) } as CallCost;
}

/** Teto de saída: JSON curto sem raciocínio; com raciocínio o teto inclui os tokens de pensamento. */
export function llmMaxTokens(ct: JevContestant): number {
  return ct.maxTokens ?? (ct.reasoning && ct.reasoning !== 'off' ? 8192 : 512);
}

export type LlmCellResult = Pick<
  JevCell,
  'status' | 'answers' | 'invalid' | 'requests' | 'latencyMs' | 'cost' | 'tokensIn' | 'tokensOut' | 'resolvedModel' | 'provider' | 'error'
>;

/**
 * Responde as perguntas `qids` do caso. Sinal de controle (orçamento/cancelar)
 * atravessa (rethrow); falha de infraestrutura vira `error` (sem nota) com o
 * custo já lançado; bloqueio de conteúdo vira `blocked`; parse inválido marca a
 * pergunta como inválida (conta ERRADA).
 */
export async function answerWithLlm(
  ct: JevContestant,
  spec: JevSpec,
  jevCase: JevCase,
  qids: readonly string[],
  ctx: LlmCellContext,
): Promise<LlmCellResult> {
  const lotes = ct.batching === 'per-case' ? [[...qids]] : qids.map((q) => [q]);
  const custos: CallCost[] = [];
  const resultados = await Promise.allSettled(
    lotes.map(async (lote) => {
      const qs = spec.questions.filter((q) => lote.includes(q.id));
      const r: ChatCompletionResult = await ctx.gateway.chatCompletion({
        apiKey: ctx.apiKey,
        modelId: ct.modelId,
        messages: renderLlmDecisionMessages(spec, lote, jevCase.state),
        temperature: ct.temperature ?? 0,
        maxTokens: llmMaxTokens(ct),
        ...(ct.reasoning ? { reasoningLevel: ct.reasoning } : {}),
        responseSchema: llmAnswerSchema(qs),
        role: 'competitor',
        sink: ctx.sink,
        signal: ctx.signal,
        onCost: (c) => custos.push(c),
      });
      return { r, parsed: parseLlmText(qs, r.text), lote };
    }),
  );
  const cost = combineCosts(custos);
  // Controle primeiro: nenhuma falha comum pode mascarar orçamento/cancelamento.
  for (const x of resultados) if (x.status === 'rejected' && isControlSignal(x.reason)) throw x.reason;
  const falha = resultados.find((x): x is PromiseRejectedResult => x.status === 'rejected');
  const ok = resultados.filter((x): x is PromiseFulfilledResult<{ r: ChatCompletionResult; parsed: ReturnType<typeof parseLlmText>; lote: string[] }> => x.status === 'fulfilled');
  const base = {
    requests: lotes.length,
    ...(cost ? { cost } : {}),
    tokensIn: ok.reduce((s, x) => s + x.value.r.tokensIn, 0),
    tokensOut: ok.reduce((s, x) => s + x.value.r.tokensOut, 0),
    latencyMs: ok.length ? Math.max(...ok.map((x) => x.value.r.latencyMs)) : undefined,
    resolvedModel: ct.modelId,
    ...(ok[0]?.value.r.provider?.name ? { provider: ok[0].value.r.provider.name } : {}),
  };
  if (falha) {
    const e = falha.reason as { message?: unknown; httpStatus?: unknown; gatewayError?: unknown };
    return {
      ...base,
      status: e?.gatewayError === 'blocked' ? 'blocked' : 'error',
      error: {
        kind: typeof e?.gatewayError === 'string' ? e.gatewayError : 'llm',
        message: typeof e?.message === 'string' ? e.message.slice(0, 500) : String(falha.reason).slice(0, 500),
        ...(typeof e?.httpStatus === 'number' ? { httpStatus: e.httpStatus } : {}),
      },
    };
  }
  if (ok.some((x) => x.value.r.blocked)) {
    return { ...base, status: 'blocked', error: { kind: 'blocked', message: ok.find((x) => x.value.r.blocked)!.value.r.blocked!.message } };
  }
  const answers: Record<string, JevWireAnswer> = {};
  const invalid: Record<string, string> = {};
  for (const x of ok) {
    for (const [qid, p] of Object.entries(x.value.parsed)) {
      if (p.ok) answers[qid] = p.answer;
      else invalid[qid] = x.value.r.truncated ? 'llm.truncated' : p.code;
    }
  }
  const nInv = Object.keys(invalid).length;
  return {
    ...base,
    status: nInv === qids.length ? 'invalid' : 'ok',
    answers,
    ...(nInv ? { invalid } : {}),
  };
}
