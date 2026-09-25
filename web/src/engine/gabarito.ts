import { chatCompletion } from './openrouter';
import type { ChatMessage } from './openrouter';
import type { ReasoningLevel, StageSpec } from './types';

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
  /** Chamado a cada etapa concluída (sucesso ou falha); total = etapas sem gabarito. */
  onProgress?: (done: number, total: number) => void;
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
  const { stages, apiKey, modelId, reasoningLevel, timeoutMs, onProgress } = params;

  const out = stages.slice();
  // Etapas com rotulo ESPERADO (ground-truth) NAO ganham gabarito LLM: o
  // veredito ali e deterministico e o gabarito custaria a toa (F1.4/P0.5).
  const pending = stages
    .map((stage, index) => ({ stage, index }))
    .filter(({ stage }) => !stage.reference?.trim() && stage.expected === undefined);
  const total = pending.length;
  if (total === 0) return out;

  let done = 0;
  await Promise.all(
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
        });
        const reference = result.text.trim();
        if (reference) {
          out[index] = { ...stage, reference };
        } else {
          console.warn(
            `[gabarito] resposta vazia na etapa ${index + 1}; etapa segue sem referência.`,
          );
        }
      } catch (err) {
        // Degradação, nunca crash: sem gabarito o juiz pointwise cai para 'parcial'.
        console.warn(
          `[gabarito] falha ao gerar referência da etapa ${index + 1}: ${(err as Error).message}`,
        );
      } finally {
        done += 1;
        onProgress?.(done, total);
      }
    }),
  );
  return out;
}
