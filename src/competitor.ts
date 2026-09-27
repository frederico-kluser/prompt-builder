import { chatCompletionStream, isGatewayBlocked } from './openrouter.js';
import { isControlSignal } from './budget.js';
import type {
  CompetitorOutcomeCounts,
  CompetitorResponse,
  CompetitorStatus,
  ReasoningLevel,
  RunCtx,
  StageSpec,
} from './types.js';

export interface RunCompetitorParams {
  apiKey: string;
  /** Chave estavel do competidor. compare: === modelId. */
  contestantId: string;
  modelId: string;
  /** Override do system message; ausente => usa stage.productContext. */
  systemPrompt?: string;
  stage: StageSpec;
  timeoutMs?: number;
  retries?: number;
  maxOutputTokens?: number;
  /** Temperatura deste contestant (compare-llms: parte da tripla de identidade). Default 0. */
  temperature?: number;
  /**
   * Nivel de reasoning ja RESOLVIDO pelo chamador (orquestrador aplica a
   * prioridade contestant.reasoningLevel ?? config.reasoning.competitor).
   */
  reasoningLevel?: ReasoningLevel;
  /** Sinal de abort + ledger de custo. */
  ctx?: RunCtx;
  /** Teto por requisicao (USD por MILHAO de tokens). */
  maxPricePerMTok?: { prompt?: number; completion?: number };
  onProgress?: (chars: number, charsPerSec: number, preview: string) => void;
}

const PREVIEW_TAIL_CHARS = 240;

export async function runCompetitor(params: RunCompetitorParams): Promise<CompetitorResponse> {
  const {
    apiKey,
    contestantId,
    modelId,
    systemPrompt,
    stage,
    timeoutMs = 60_000,
    retries = 1,
    maxOutputTokens,
    temperature = 0,
    reasoningLevel,
    ctx,
    maxPricePerMTok,
    onProgress,
  } = params;

  const effectiveMaxTokens =
    typeof maxOutputTokens === 'number' && maxOutputTokens > 0
      ? Math.min(maxOutputTokens, stage.maxTokens)
      : stage.maxTokens;

  let attempt = 0;
  let lastError: unknown;
  while (attempt <= retries) {
    const start = Date.now();
    try {
      const res = await chatCompletionStream({
        apiKey,
        modelId,
        messages: [
          { role: 'system', content: systemPrompt ?? stage.productContext },
          { role: 'user', content: stage.question },
        ],
        // deterministicSampling (openrouter.ts) so envia temperature a quem
        // suporta — reasoning models ignoram sem quebrar.
        temperature,
        reasoningLevel,
        maxTokens: effectiveMaxTokens,
        timeoutMs,
        role: 'competitor',
        signal: ctx?.signal,
        sink: ctx?.sink,
        maxPricePerMTok,
        onDelta: (_delta, fullText) => {
          if (!onProgress) return;
          const elapsedSec = Math.max(0.001, (Date.now() - start) / 1000);
          const charsPerSec = fullText.length / elapsedSec;
          const preview =
            fullText.length > PREVIEW_TAIL_CHARS
              ? '…' + fullText.slice(-PREVIEW_TAIL_CHARS)
              : fullText;
          onProgress(fullText.length, charsPerSec, preview);
        },
      });

      // Taxonomia (IMPL-010): filtro de conteudo do provedor => 'blocked'
      // (defesa do gateway, sem veredito para o prompt); recusa DECLARADA pelo
      // modelo => 'refused' (resposta legitima, julgada normalmente — o texto
      // da recusa vira o `text` quando nao ha conteudo). Recusa so em texto
      // corrido ("nao posso ajudar") segue 'ok': o juiz a le como resposta.
      const status: CompetitorStatus = res.blocked ? 'blocked' : res.refusal ? 'refused' : 'ok';
      return {
        contestantId,
        modelId,
        text: res.text || (status === 'refused' ? res.refusal! : ''),
        latencyMs: res.latencyMs,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        // Custo EXATO vindo de `usage.cost` (fallback: catalogo). Antes era
        // sempre derivado do catalogo, ignorando cache e faixas de preco.
        costUsd: res.cost.usd,
        status,
        ...(res.blocked ? { errorMsg: res.blocked.message } : {}),
        ...(res.finishReason ? { finishReason: res.finishReason } : {}),
        ...(res.nativeFinishReason ? { nativeFinishReason: res.nativeFinishReason } : {}),
      };
    } catch (err) {
      // Orcamento/cancelamento sao SINAIS DE CONTROLE: repetir a chamada so
      // gastaria mais, e devolver status 'error' faria a run parecer completa
      // com um competidor "que falhou". Sai do laco propagando.
      if (isControlSignal(err)) throw err;
      // Bloqueio de moderacao/guardrail (403) e DETERMINISTICO para a mesma
      // entrada: repetir so gastaria tempo, e nao e falha de infraestrutura
      // nem de key. Sai do laco como 'blocked' — o OpenRouter nao cobra a
      // requisicao bloqueada, logo custo 0.
      if (isGatewayBlocked(err)) {
        return {
          contestantId,
          modelId,
          text: '',
          latencyMs: Date.now() - start,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          status: 'blocked',
          errorMsg: err.message,
        };
      }
      lastError = err;
      attempt += 1;
      console.error(`[competitor ${modelId}] tentativa ${attempt} falhou:`, err);
    }
  }

  return {
    contestantId,
    modelId,
    text: '',
    latencyMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    status: 'error',
    errorMsg: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

/**
 * Contagem dos desfechos NAO-ok dos competidores de uma run (IMPL-010): tres
 * numeros separados porque sao tres coisas diferentes — `blocked` e a defesa
 * do gateway (metrica de seguranca propria, cenario inconclusivo para o
 * prompt), `refused` e o modelo recusando (julgavel) e `error` e infra.
 * Puro e idempotente: recalculado do record inteiro, nunca incrementado.
 */
export function countCompetitorOutcomes(
  stages: ReadonlyArray<{ responses?: ReadonlyArray<{ status: CompetitorStatus }> }>,
): CompetitorOutcomeCounts {
  const counts: CompetitorOutcomeCounts = { blocked: 0, refused: 0, error: 0 };
  for (const st of stages) {
    for (const r of st.responses ?? []) {
      if (r.status === 'blocked' || r.status === 'refused' || r.status === 'error') counts[r.status] += 1;
    }
  }
  return counts;
}
