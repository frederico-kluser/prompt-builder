import { chatCompletion } from './openrouter.js';
import type { ChatCompletionResult, ChatMessage } from './openrouter.js';
import { isControlSignal } from './budget.js';
import { finishSignalsOf, retryMaxTokens } from './engine/truncation.js';
import { ROLE_MAX_TOKENS } from './roleLimits.js';
import type { CallFinishSignals, ReasoningLevel, RunCtx, StageSpec } from './types.js';

// Gabaritos (respostas de referência), portados do prompt-arena: UMA chamada
// temp-0 do modelo de referência por etapa, recebendo o MESMO contexto de
// produto que os competidores — o gabarito é a "resposta ideal" sob as mesmas
// regras/políticas. As chamadas rodam em paralelo via Promise.all confiando no
// limitador GLOBAL de openrouter.ts (sem semáforo local). Falha ou resposta
// vazia NUNCA derruba a run: a etapa segue sem `reference` e o juiz pointwise
// degrada para 'parcial'.

// Teto TOTAL (raciocinio + resposta) do papel — fonte unica em roleLimits.ts (IMPL-016).
const MAX_TOKENS_GABARITO = ROLE_MAX_TOKENS.gabarito;

export interface GenerateReferencesParams {
  stages: StageSpec[];
  apiKey: string;
  /** Modelo de referência que escreve os gabaritos (default do orquestrador: 1º juiz). */
  modelId: string;
  reasoningLevel?: ReasoningLevel;
  timeoutMs?: number;
  /** Sinal de abort + ledger de custo. */
  ctx?: RunCtx;
  maxPricePerMTok?: { prompt?: number; completion?: number };
  /** Chamado a cada etapa concluída (sucesso ou falha); total = etapas sem gabarito. */
  onProgress?: (done: number, total: number) => void;
  /**
   * Sinais de fim da chamada que gerou o gabarito de `stages[stageIndex]`
   * (IMPL-014): finish_reason, native_finish_reason, raciocínio vs teto e
   * tamanho do conteúdo. Só é chamado quando uma chamada COMPLETOU.
   */
  onCall?: (stageIndex: number, call: CallFinishSignals) => void;
}

// System = productContext da etapa (idêntico ao que os competidores recebem) +
// o papel de modelo de referência. User = pergunta + rubrica (quando houver)
// como critério obrigatório + instrução de saída limpa (sem meta-comentários,
// para o gabarito poder ser comparado diretamente com as respostas).
function buildMessages(stage: StageSpec): ChatMessage[] {
  const rubrica = stage.rubric?.trim();
  return [
    {
      role: 'system',
      content: `${stage.productContext}

Você é o MODELO DE REFERÊNCIA deste benchmark: sua tarefa é produzir o GABARITO — a resposta ideal que servirá de régua para julgar as respostas dos competidores.`,
    },
    {
      role: 'user',
      content: `${stage.question}${
        rubrica
          ? `\n\nCRITÉRIO DE CORRETUDE (rubrica) — a resposta ideal DEVE satisfazer:\n${rubrica}`
          : ''
      }

Responda APENAS com a resposta de referência ideal, completa e direta, sem preâmbulo nem meta-comentários.`,
    },
  ];
}

/**
 * Preenche `reference` nas etapas que ainda não têm gabarito. Etapas que já
 * trazem `reference` (importadas de pacote JSON) passam intactas. Retorna um
 * NOVO array: etapas preenchidas são cópias, as demais mantêm identidade.
 */
export async function generateReferences(
  params: GenerateReferencesParams,
): Promise<StageSpec[]> {
  const { stages, apiKey, modelId, reasoningLevel, timeoutMs, ctx, maxPricePerMTok, onProgress, onCall } =
    params;

  const out = stages.slice();
  const pending = stages
    .map((stage, index) => ({ stage, index }))
    .filter(({ stage }) => !stage.reference?.trim());
  const total = pending.length;
  if (total === 0) return out;

  let done = 0;
  const settled = await Promise.allSettled(
    pending.map(async ({ stage, index }) => {
      const chamar = (maxTokens: number): Promise<ChatCompletionResult> =>
        chatCompletion({
          apiKey,
          modelId,
          messages: buildMessages(stage),
          temperature: 0,
          maxTokens,
          timeoutMs,
          reasoningLevel,
          role: 'gabarito',
          signal: ctx?.signal,
          sink: ctx?.sink,
          maxPricePerMTok,
        });
      // Sinais da ultima chamada que COMPLETOU (reportados mesmo se o retry falhar).
      let ultima: CallFinishSignals | undefined;
      try {
        let maxTokens = MAX_TOKENS_GABARITO;
        let result = await chamar(maxTokens);
        ultima = finishSignalsOf(result, maxTokens);
        // Truncamento (IMPL-014 / R-07b:DEC-2): UM retry com teto x2. E o
        // modo de falha tipico do gabarito — juiz/referencia com raciocinio
        // alto consome o teto e devolve `length` com conteudo vazio.
        // Os sinais da 1a tentativa (a truncada) ficam em `firstAttempt`:
        // qual sinal disparou e quanto raciocinio ela gastou calibram o teto.
        if (result.truncated) {
          const primeira = ultima;
          maxTokens = retryMaxTokens(maxTokens);
          result = await chamar(maxTokens);
          ultima = finishSignalsOf(result, maxTokens, primeira);
        }
        const reference = result.text.trim();
        if (result.truncated) {
          // Regua CORTADA nao julga ninguem: descartada, a etapa segue sem
          // `reference` (mesma degradacao do gabarito vazio). O sinal fica
          // persistido em `StageRecord.gabaritoCall`, entra na truncationRate e
          // o orquestrador AVISA no `stage.generated` (`warning`) — ver
          // `describeTruncatedReference`.
          console.warn(
            `[gabarito] referência da etapa ${index + 1} truncada no teto mesmo com max_tokens=${maxTokens}; descartada.`,
          );
        } else if (reference) {
          out[index] = { ...stage, reference };
        } else {
          console.warn(
            `[gabarito] resposta vazia na etapa ${index + 1}; etapa segue sem referência.`,
          );
        }
      } catch (err) {
        // Orcamento/cancelamento nao sao "falha de gabarito": deixar passar aqui
        // faria a run seguir SEM referencia e o juiz degradar tudo p/ 'parcial'.
        if (isControlSignal(err)) throw err;
        // Degradação, nunca crash: sem gabarito o juiz pointwise cai para 'parcial'.
        console.warn(
          `[gabarito] falha ao gerar referência da etapa ${index + 1}: ${(err as Error).message}`,
        );
      } finally {
        if (ultima) onCall?.(index, ultima);
        done += 1;
        onProgress?.(done, total);
      }
    }),
  );
  // allSettled em vez de all: com `all`, a primeira rejeicao desenrola o
  // chamador enquanto as irmas continuam gastando e perdendo o resultado.
  for (const s of settled) {
    if (s.status === 'rejected' && isControlSignal(s.reason)) throw s.reason;
  }
  return out;
}
