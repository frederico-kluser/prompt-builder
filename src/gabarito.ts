import { chatCompletion } from './openrouter.js';
import type { ChatMessage } from './openrouter.js';
import { isControlSignal } from './budget.js';
import type { ReasoningLevel, RunCtx, StageSpec } from './types.js';

// Gabaritos (respostas de referência), portados do prompt-arena: UMA chamada
// temp-0 do modelo de referência por etapa, recebendo o MESMO contexto de
// produto que os competidores — o gabarito é a "resposta ideal" sob as mesmas
// regras/políticas. As chamadas rodam em paralelo via Promise.all confiando no
// limitador GLOBAL de openrouter.ts (sem semáforo local). Falha ou resposta
// vazia NUNCA derruba a run: a etapa segue sem `reference` e o juiz pointwise
// degrada para 'parcial'.

const MAX_TOKENS_GABARITO = 1500;

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
   * Número da etapa (1-based) de cada item de `stages`, para os avisos no stderr.
   * O orquestrador passa só o SUBCONJUNTO que precisa de gabarito (IMPL-034):
   * sem isto, a falha da etapa 2 de uma run mista sairia como "etapa 1".
   */
  stageNumbers?: number[];
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
  const { stages, apiKey, modelId, reasoningLevel, timeoutMs, ctx, maxPricePerMTok, onProgress, stageNumbers } =
    params;
  const etapa = (index: number): number => stageNumbers?.[index] ?? index + 1;

  const out = stages.slice();
  const pending = stages
    .map((stage, index) => ({ stage, index }))
    .filter(({ stage }) => !stage.reference?.trim());
  const total = pending.length;
  if (total === 0) return out;

  let done = 0;
  const settled = await Promise.allSettled(
    pending.map(async ({ stage, index }) => {
      try {
        const result = await chatCompletion({
          apiKey,
          modelId,
          messages: buildMessages(stage),
          temperature: 0,
          maxTokens: MAX_TOKENS_GABARITO,
          timeoutMs,
          reasoningLevel,
          role: 'gabarito',
          signal: ctx?.signal,
          sink: ctx?.sink,
          maxPricePerMTok,
        });
        const reference = result.text.trim();
        if (reference) {
          out[index] = { ...stage, reference };
        } else {
          console.warn(
            `[gabarito] resposta vazia na etapa ${etapa(index)}; etapa segue sem referência.`,
          );
        }
      } catch (err) {
        // Orcamento/cancelamento nao sao "falha de gabarito": deixar passar aqui
        // faria a run seguir SEM referencia e o juiz degradar tudo p/ 'parcial'.
        if (isControlSignal(err)) throw err;
        // Degradação, nunca crash: sem gabarito o juiz pointwise cai para 'parcial'.
        console.warn(
          `[gabarito] falha ao gerar referência da etapa ${etapa(index)}: ${(err as Error).message}`,
        );
      } finally {
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
