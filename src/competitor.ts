import {
  catalogDeniesReasoning,
  chatCompletionStream,
  guessPromptTokens,
  isCallerRetryable,
  isGatewayBlocked,
  peekModelsCache,
  type ChatMessage,
} from './openrouter.js';
import { isControlSignal } from './budget.js';
import { finishSignalsOf, retryMaxTokens } from './engine/truncation.js';
import { buildCaseInput } from './engine/caseInput.js';
import { competitorContextRoom, competitorMaxTokens, type CompetitorModelHint } from './roleLimits.js';
import type {
  CallCost,
  CallFinishSignals,
  CompetitorOutcomeCounts,
  CompetitorResponse,
  CompetitorStatus,
  OpenRouterModel,
  ReasoningLevel,
  RunCtx,
  StageSpec,
} from './types.js';

/**
 * O que o catálogo diz do competidor para dimensionar o teto (IMPL-016): o
 * degrau EFETIVO (allowlist/`mandatory`/`default_effort`), se o catálogo nega
 * raciocínio (nada vai no fio) e o contexto. Fora do catálogo = `{}` (só o
 * degrau pedido). Fonte única de competidor.ts, estimate.ts e da prévia de
 * custo do SPA — a porta suave precifica o mesmo teto que a porta dura reserva.
 */
export function competitorModelHint(
  model: Pick<OpenRouterModel, 'reasoning' | 'supportedParameters' | 'contextLength'> | undefined,
  promptTokens?: number,
): CompetitorModelHint {
  if (!model) return {};
  return {
    ...(model.reasoning ? { reasoning: model.reasoning } : {}),
    ...(catalogDeniesReasoning(model) ? { deniesReasoning: true } : {}),
    ...(model.contextLength ? { contextLength: model.contextLength } : {}),
    ...(typeof promptTokens === 'number' ? { promptTokens } : {}),
  };
}

export interface RunCompetitorParams {
  apiKey: string;
  /** Chave estavel do competidor. compare: === modelId. */
  contestantId: string;
  modelId: string;
  /**
   * Variante sob teste: vira o system message, e SÓ ele (ausente => sem
   * system). O productContext chega SEMPRE, como bloco de dado delimitado no
   * user (`buildCaseInput`, IMPL-009).
   */
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

  // Teto TOTAL (IMPL-016 / R-07b:REC-1): a RESPOSTA (stage.maxTokens, limitada
  // por maxOutputTokens) + folga de raciocinio do degrau EFETIVO (o que o
  // gateway envia, lido do catalogo em cache). Raciocinio conta contra
  // max_tokens: sem a folga, um modelo que pensa comia o teto da resposta
  // inteiro e saia `length` com conteudo vazio.
  // Montagem única do caso (IMPL-009 / R-05:REC-1): antes era
  // `systemPrompt ?? stage.productContext` e, com variante, o contexto
  // do cenário sumia do payload enquanto gabarito e juiz o viam.
  const messages: ChatMessage[] = buildCaseInput(stage, systemPrompt);
  const answerTokens =
    typeof maxOutputTokens === 'number' && maxOutputTokens > 0
      ? Math.min(maxOutputTokens, stage.maxTokens)
      : stage.maxTokens;
  const hint = competitorModelHint(
    peekModelsCache(apiKey)?.data.find((m) => m.id === modelId),
    guessPromptTokens(messages),
  );
  const effectiveMaxTokens = competitorMaxTokens(answerTokens, reasoningLevel, hint);
  /** Contexto livre (catalogo): o retry x2 nao passa dele (prompt + max_tokens > contexto = HTTP 400). */
  const contextRoom = competitorContextRoom(hint);

  // Truncamento (IMPL-014 / R-07b:DEC-2): UM retry com teto x2, fora da conta
  // dos retries de erro (truncar nao e falha de infra). O teto dobrado passa
  // do `maxOutputTokens` de proposito: o modelo nao ve `max_tokens` (nao e
  // instrucao de concisao), entao cortar a resposta so mede o NOSSO teto; o
  // dinheiro continua contido pelo ledger, que reserva com o teto novo.
  let maxTokens = effectiveMaxTokens;
  let truncationRetried = false;
  /** Custo da 1a tentativa truncada — o dinheiro saiu, entra no costUsd final. */
  let spentOnTruncated = 0;
  /**
   * Custo LANCADO no ledger por tentativas que falharam depois de despachadas
   * (timeout = gasto conservador; 200 com erro in-band = custo medido). Sem
   * isto o competidor saia com `costUsd` 0 e `soma(costByContestant)` ficava
   * abaixo do `totalCostUsd` (IMPL-017, revisao). Pendente nao entra: segue a
   * regra do ledger (fora do gasto ate conciliar).
   */
  let spentOnFailed = 0;
  /**
   * Sinais da 1a tentativa (a truncada): sem isto so sobrava `truncationRetried`
   * e uma linha de log — qual sinal disparou e quanto raciocinio ela gastou
   * (o que calibra o teto) se perdiam. Persistidos em `firstAttempt`.
   */
  let firstAttempt: CallFinishSignals | undefined;
  const retryFields = (): Pick<CompetitorResponse, 'truncationRetried' | 'firstAttempt'> =>
    truncationRetried ? { truncationRetried: true, ...(firstAttempt ? { firstAttempt } : {}) } : {};

  let attempt = 0;
  let lastError: unknown;
  while (attempt <= retries) {
    const start = Date.now();
    let attemptCost: CallCost | undefined;
    try {
      const res = await chatCompletionStream({
        apiKey,
        modelId,
        messages,
        // deterministicSampling (openrouter.ts) so envia temperature a quem
        // suporta — reasoning models ignoram sem quebrar.
        temperature,
        reasoningLevel,
        maxTokens,
        timeoutMs,
        role: 'competitor',
        signal: ctx?.signal,
        sink: ctx?.sink,
        maxPricePerMTok,
        onCost: (c) => {
          attemptCost = c;
        },
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
      // Bloqueio tem desfecho proprio (IMPL-010): o texto parcial nao e
      // "resposta truncada", e repetir nao desbloqueia.
      const truncated = status !== 'blocked' && res.truncated === true;
      if (truncated && !truncationRetried) {
        truncationRetried = true;
        spentOnTruncated += res.cost.usd;
        firstAttempt = finishSignalsOf(res, maxTokens);
        const doubled = retryMaxTokens(maxTokens);
        maxTokens = contextRoom !== undefined ? Math.max(maxTokens, Math.min(doubled, contextRoom)) : doubled;
        console.error(
          `[competitor ${modelId}] resposta truncada no teto (${(res.truncationSignals ?? []).join(', ')}); ` +
            `repetindo 1x com max_tokens=${maxTokens}`,
        );
        continue;
      }
      return {
        contestantId,
        modelId,
        text: res.text || (status === 'refused' ? res.refusal! : ''),
        latencyMs: res.latencyMs,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        // Custo EXATO vindo de `usage.cost` (fallback: catalogo). Antes era
        // sempre derivado do catalogo, ignorando cache e faixas de preco.
        // Com retry por truncamento, soma as duas tentativas.
        costUsd: res.cost.usd + spentOnTruncated + spentOnFailed,
        status,
        ...(res.blocked ? { errorMsg: res.blocked.message } : {}),
        ...(res.finishReason ? { finishReason: res.finishReason } : {}),
        ...(res.nativeFinishReason ? { nativeFinishReason: res.nativeFinishReason } : {}),
        // Os 4 sinais de fim (R-07b:REC-2): finish/native acima, raciocinio vs
        // teto e o tamanho do conteudo (= `text`/`tokensOut`, ja persistidos).
        truncated,
        ...(typeof res.reasoningTokens === 'number' ? { reasoningTokens: res.reasoningTokens } : {}),
        maxTokens,
        ...(res.truncationSignals?.length ? { truncationSignals: res.truncationSignals } : {}),
        ...retryFields(),
        // IMPL-075: o provedor que serviu (payload/GET /generation) vai para o
        // record — sem ele a variação de provedor se confundia com a de prompt.
        ...(res.provider && (res.provider.name || res.provider.upstreamId || res.provider.serviceTier)
          ? { provider: { ...res.provider } }
          : {}),
      };
    } catch (err) {
      // Orcamento/cancelamento sao SINAIS DE CONTROLE: repetir a chamada so
      // gastaria mais, e devolver status 'error' faria a run parecer completa
      // com um competidor "que falhou". Sai do laco propagando.
      if (isControlSignal(err)) throw err;
      spentOnFailed += attemptCost?.usd ?? 0;
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
          // O 403 nao e cobrado; uma 1a tentativa truncada antes dele, sim.
          costUsd: spentOnTruncated + spentOnFailed,
          status: 'blocked',
          errorMsg: err.message,
          ...retryFields(),
        };
      }
      lastError = err;
      attempt += 1;
      console.error(`[competitor ${modelId}] tentativa ${attempt} falhou:`, err);
      // IMPL-073 (R-07a:REC-3): UM nível de retry por resposta. HTTP
      // classificado (429/5xx já re-tentados pelo gateway; 4xx não muda) e
      // desfecho desconhecido depois do despacho (pode ter sido cobrado) NÃO
      // repetem aqui — antes 429 em rajada virava 2 × 7 = 14 POSTs.
      if (!isCallerRetryable(err)) break;
    }
  }

  return {
    contestantId,
    modelId,
    text: '',
    latencyMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    // Erro de infra: so o que o ledger LANCOU (timeout conservador, erro
    // in-band medido) e a 1a tentativa truncada.
    costUsd: spentOnTruncated + spentOnFailed,
    status: 'error',
    errorMsg: lastError instanceof Error ? lastError.message : String(lastError),
    ...retryFields(),
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
