import { z } from 'zod';
import { chatCompletion } from './openrouter.js';
import { isControlSignal } from './budget.js';
import { getTechnique } from './techniques.js';
import type { Contestant, ManualVariant, PromptTechnique, ReasoningLevel, RunCtx } from './types.js';

const variantSchema = z.object({ systemPrompt: z.string().min(1) });

// Meta-prompt do reescritor (portado do rewriter do prompt-arena): TEXTO PURO
// in/out, sem JSON — assim o prompt reescrito, cheio de backticks e quebras de
// linha, nao precisa sobreviver ao escaping de JSON na ida nem na volta.
const SYSTEM_PROMPT = `Voce e um reescritor cirurgico de system prompts. Recebe um system prompt base (ou apenas um tema, quando nao houver base) e UMA tecnica de engenharia de prompt a aplicar.
Sua reescrita sera benchmarkada contra o prompt base atual — so uma variante genuinamente melhor vence.

REGRAS DURAS (violar qualquer uma torna a variante inutil — ela simplesmente pontua pior):
- Responda APENAS com o prompt reescrito. Sem preambulo, sem explicacao, sem comentarios, sem code fences.
- O texto e um drop-in replacement do prompt base, no mesmo papel.
- Seja CIRURGICO: mude APENAS o que a tecnica pede e o que as licoes expoem; preserve o SIGNIFICADO de todas as demais regras intacto (reformular por clareza vale; remover ou enfraquecer uma regra, nao). Evite inchar o prompt — mudanca fora do escopo esconde se a tecnica ajudou.
- NAO adicione exemplos few-shot a menos que a tecnica peca explicitamente.
- Mantenha o idioma do prompt base.
- NAO responda a tarefa do usuario; apenas reescreva o system prompt.`;

/** Remove UM par de fences ``` envolvendo a saida inteira (fences internos ficam intactos). */
function stripFences(text: string): string {
  const t = text.trim();
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(t);
  return m ? m[1].trim() : t;
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) return match[1].trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

export interface GenerateContestantsParams {
  apiKey: string;
  /** O unico modelo sob teste (eixo contestant). */
  modelId: string;
  theme: string;
  /** Base de derivacao das variantes (variation: base do usuario; treino i>0: vencedora). */
  basePrompt?: string;
  /** Prompt original do usuario, rodado como controle quando includeOriginal. */
  originalPrompt?: string;
  /** Melhor da iteracao anterior, re-testado verbatim (treino i>0). */
  carryPrompt?: string;
  carryLabel?: string;
  carryParentId?: string;
  includeOriginal: boolean;
  techniqueIds?: string[];
  manualVariants?: ManualVariant[];
  /** Liga/desliga a geracao por LLM. Off => usa manualVariants/base verbatim. */
  promptOptimization: boolean;
  /** Meta-modelo que reescreve os prompts. */
  optimizerModelId: string;
  /** Aprendizados da iteracao anterior (treino) injetados na geracao. */
  analysisHint?: string;
  /** Nivel de raciocinio do papel "rewriter" (RunConfig.reasoning.rewriter). */
  reasoningLevel?: ReasoningLevel;
  /**
   * Runner dos contestants gerados. 'agent' quando a run e de agente
   * (`config.agent` presente): sem isso o treino com agente rodaria as
   * iteracoes (e o holdout) como CHAT em silencio (§29.2). Ausente/undefined
   * mantém o comportamento de chat intacto.
   */
  runner?: 'chat' | 'agent';
  timeoutMs?: number;
  /** Sinal de abort + ledger de custo. */
  ctx?: RunCtx;
  maxPricePerMTok?: { prompt?: number; completion?: number };
}

async function generateOneVariant(
  p: GenerateContestantsParams,
  technique: PromptTechnique,
): Promise<string | null> {
  const lessonsBlock = p.analysisHint?.trim()
    ? `\n<licoes_da_iteracao_anterior>\n${p.analysisHint.trim()}\n</licoes_da_iteracao_anterior>\n`
    : '';
  const baseText =
    p.basePrompt?.trim() ??
    'Não há prompt base — escreva um prompt completo do zero sobre o tema.';

  const userPrompt = `<contexto_da_tarefa>
${p.theme}
</contexto_da_tarefa>

<tecnica id="${technique.id}" nome="${technique.name}">
<quando_ajuda>${technique.good}</quando_ajuda>
<cuidado>${technique.bad}</cuidado>
<instrucao>${technique.metaInstruction}</instrucao>
</tecnica>
${lessonsBlock}
<prompt_base>
${baseText}
</prompt_base>

Reescreva o prompt agora, aplicando a tecnica.`;

  try {
    const result = await chatCompletion({
      apiKey: p.apiKey,
      modelId: p.optimizerModelId,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.4,
      timeoutMs: p.timeoutMs ?? 90_000,
      reasoningLevel: p.reasoningLevel,
      role: 'rewriter',
      signal: p.ctx?.signal,
      sink: p.ctx?.sink,
      maxPricePerMTok: p.maxPricePerMTok,
    });
    const text = stripFences(result.text);
    // Gate de usabilidade: reescrita vazia ou colapsada nao vale um benchmark —
    // a variante e pulada (sem base, o piso e so o minimo absoluto de 40 chars).
    const baseLen = p.basePrompt?.trim().length ?? 0;
    if (!text || text.length < Math.max(40, baseLen * 0.3)) {
      console.warn(
        `[variator] tecnica ${technique.id}: reescrita inutilizavel (${text.length} chars vs base ${baseLen})`,
      );
      return null;
    }
    return text;
  } catch (err) {
    // Sem o rethrow, orcamento estourado produziria uma lista de variantes
    // menor do que o pedido — o treino "converge" por falta de candidatos.
    if (isControlSignal(err)) throw err;
    console.warn(`[variator] tecnica ${technique.id} falhou: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Resolve a lista de contestants de uma run de variacao/treino:
 * (controle original) + (carry da vencedora anterior) + (variantes geradas/manuais).
 * Garante ids unicos. Pode retornar menos do que o pedido se variantes falharem —
 * o chamador deve exigir >= 2 contestants.
 */
export async function generateContestants(
  p: GenerateContestantsParams,
): Promise<Contestant[]> {
  const contestants: Contestant[] = [];

  // Runner de agente (quando `config.agent` presente). Sem isso os contestants
  // de uma run de agente sairiam com runner indefinido (= chat) e o treino
  // mediria respostas de chat em PASSO de agente, sem erro nenhum (§29.2).
  const stampRunner = (): void => {
    if (p.runner && p.runner !== 'chat') {
      for (const c of contestants) c.runner = p.runner;
    }
  };

  // 1) Controle: o prompt original do usuario (sempre, quando fornecido e pedido).
  const original = (p.originalPrompt ?? p.basePrompt)?.trim();
  if (p.includeOriginal && original) {
    contestants.push({
      id: 'original',
      label: 'Original (controle)',
      modelId: p.modelId,
      systemPrompt: original,
      isOriginal: true,
    });
  }

  // 2) Carry: a melhor da iteracao anterior, re-testada verbatim (treino i>0).
  if (p.carryPrompt?.trim()) {
    contestants.push({
      id: 'carry',
      label: p.carryLabel ?? 'Melhor anterior',
      modelId: p.modelId,
      systemPrompt: p.carryPrompt.trim(),
      parentContestantId: p.carryParentId,
    });
  }

  // 3) Variantes.
  if (!p.promptOptimization) {
    // Toggle OFF: variantes manuais verbatim (sem LLM).
    (p.manualVariants ?? []).forEach((v, i) => {
      const sp = v.systemPrompt.trim();
      if (!sp) return;
      contestants.push({
        id: `m${i}`,
        label: v.label?.trim() || `Variante ${i + 1}`,
        modelId: p.modelId,
        systemPrompt: sp,
      });
    });
    stampRunner();
    return contestants;
  }

  // Toggle ON: gera uma variante por tecnica selecionada (em paralelo).
  const techniques = (p.techniqueIds ?? [])
    .map((id) => getTechnique(id))
    .filter((t): t is PromptTechnique => Boolean(t));

  const results = await Promise.all(techniques.map((t) => generateOneVariant(p, t)));
  results.forEach((systemPrompt, i) => {
    if (!systemPrompt) return;
    const t = techniques[i];
    contestants.push({
      id: `v${i}`,
      label: t.name,
      modelId: p.modelId,
      systemPrompt,
      techniqueId: t.id,
      parentContestantId: p.carryParentId,
    });
  });

  stampRunner();
  return contestants;
}

// ---------------------------------------------------------------------------
// Geracao de PROMPT BASE a partir de uma descricao de tarefa (opcional no
// assistente). O prompt gerado preenche o campo do prompt base — que sempre
// roda como CONTROLE/original no treino.
// ---------------------------------------------------------------------------

export interface GenerateBasePromptParams {
  apiKey: string;
  /** Modelo que redige o prompt (reusa o gerador/optimizer do assistente). */
  modelId: string;
  /** O que o usuario descreveu que a tarefa precisa fazer. */
  taskDescription: string;
  /** Contexto/tema extra opcional. */
  theme?: string;
  timeoutMs?: number;
  ctx?: RunCtx;
}

const BASE_PROMPT_SYSTEM = `Voce e um engenheiro de prompts senior. Recebe a DESCRICAO de uma tarefa e produz um SYSTEM PROMPT completo e reutilizavel para um assistente que executa essa tarefa.
NAO responda a tarefa; escreva APENAS o system prompt (instrucoes para o assistente), pronto para uso, claro e conciso.
Saida ESTRITAMENTE em JSON valido, sem markdown, sem comentarios: {"systemPrompt":"<system prompt completo>"}`;

/**
 * Gera um system prompt base a partir de uma descricao em linguagem natural.
 * Lanca erro (mensagem PT-BR) se o modelo nao devolver um prompt valido.
 */
export async function generateBasePrompt(p: GenerateBasePromptParams): Promise<string> {
  const themeBlock = p.theme?.trim() ? `\n\nCONTEXTO/TEMA:\n${p.theme.trim()}` : '';
  const userPrompt = `DESCRICAO DA TAREFA:\n${p.taskDescription.trim()}${themeBlock}\n\nDevolva o JSON {"systemPrompt":"..."}.`;

  const result = await chatCompletion({
    apiKey: p.apiKey,
    modelId: p.modelId,
    messages: [
      { role: 'system', content: BASE_PROMPT_SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.4,
    timeoutMs: p.timeoutMs ?? 90_000,
    responseFormatJson: true,
    role: 'rewriter',
    signal: p.ctx?.signal,
    sink: p.ctx?.sink,
  });

  let parsed;
  try {
    parsed = variantSchema.safeParse(JSON.parse(extractJson(result.text)));
  } catch {
    throw new Error('Nao consegui interpretar a resposta do modelo como JSON. Tente novamente.');
  }
  if (!parsed.success) {
    throw new Error('O modelo nao devolveu um system prompt valido. Tente novamente.');
  }
  const sp = parsed.data.systemPrompt.trim();
  if (!sp) throw new Error('O modelo devolveu um system prompt vazio.');
  return sp;
}
