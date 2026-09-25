import { z } from 'zod';
import { chatCompletion } from './openrouter';
import { dedupeAdvanced } from './dedup';
import { renderScenarioRules } from '../../../src/engine/scenarioRules.js';
import type { ScenarioRules } from '../../../src/engine/libraryCore.js';
import type { ReasoningLevel, StageSpec } from './types';

const stageSchema = z.object({
  question: z.string().min(1),
  productContext: z.string().min(1),
  maxTokens: z.number().int().positive().max(8000),
  rubric: z.string().optional().default(''),
});

const SYSTEM_PROMPT = `Voce e um gerador de cenarios de benchmark para LLMs.
Voce recebe um TEMA, o indice da etapa atual (1-based) e o total de etapas.
Sua tarefa: produzir UM cenario realista representando uma interacao em que um usuario faz uma pergunta a um sistema de IA de produto, e esse sistema possui um CONTEXTO DE PRODUTO para responder.

Regras:
- Saida ESTRITAMENTE em JSON valido (sem markdown, sem comentarios).
- Campos obrigatorios: "question" (a pergunta do usuario), "productContext" (texto que sera passado como system prompt aos competidores; pode incluir politicas, dados de produto, manuais, FAQs, restricoes), "maxTokens" (inteiro 200..2000 sugerindo o teto razoavel de tokens da resposta), "rubric" (CRITERIO DE CORRETUDE: o que uma resposta CORRETA precisa conter/fazer com base no contexto, e os erros que a tornariam inaceitavel — servira de gabarito ancorado para o juiz; 1 a 3 frases objetivas).
- A etapa deve ser auto-contida: nao referencie etapas anteriores.
- Varie o tipo de tarefa entre etapas (extracao, raciocinio, comparacao, criatividade controlada, recusa, etc.) coerente com o tema.
- Idioma: portugues, salvo se o tema exigir outro.`;

export interface DatagenParams {
  apiKey: string;
  theme: string;
  stageIndex: number; // 0-based
  totalStages: number;
  modelId: string;
  timeoutMs?: number;
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) return match[1].trim();
  // Tolerante a prosa em volta do JSON: recorta do primeiro { ou [ ao seu fecho.
  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');
  const start =
    firstBrace < 0 ? firstBracket : firstBracket < 0 ? firstBrace : Math.min(firstBrace, firstBracket);
  if (start < 0) return trimmed;
  const close = trimmed[start] === '{' ? '}' : ']';
  const end = trimmed.lastIndexOf(close);
  if (end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export async function generateStage(params: DatagenParams): Promise<StageSpec> {
  const { apiKey, theme, stageIndex, totalStages, modelId, timeoutMs } = params;

  const userPrompt = `TEMA: ${theme}
ETAPA: ${stageIndex + 1} de ${totalStages}

Gere o cenario desta etapa em JSON conforme as regras.`;

  const result = await chatCompletion({
    apiKey,
    modelId,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,
    timeoutMs: timeoutMs ?? 90_000,
    responseFormatJson: true,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(result.text));
  } catch (err) {
    throw new Error(
      `Datagen retornou JSON invalido: ${(err as Error).message}. Texto: ${result.text.slice(0, 300)}`,
    );
  }

  const validated = stageSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Datagen schema invalido: ${validated.error.message}`);
  }

  return validated.data;
}

// ---------------------------------------------------------------------------
// Geracao em LOTES paralelos (portada do prompt-arena): em vez de 1 chamada por
// cenario, K lotes pedem varios cenarios de uma vez (temp 0.8 p/ variedade),
// com exclusao dos prompts ja existentes e dedup exato + ROUGE-L ao final.
// ---------------------------------------------------------------------------

const BATCH_SYSTEM_PROMPT = `Voce e um gerador de cenarios de benchmark para LLMs.
Voce recebe um TEMA e uma QUANTIDADE de cenarios.
Sua tarefa: produzir os cenarios pedidos, cada um representando uma interacao em que um usuario faz uma pergunta a um sistema de IA de produto, e esse sistema possui um CONTEXTO DE PRODUTO para responder.

Regras:
- Saida ESTRITAMENTE em JSON valido (sem markdown, sem comentarios): um array de cenarios, ou um objeto {"stages": [...]}.
- Campos obrigatorios de cada cenario: "question" (a pergunta do usuario), "productContext" (texto que sera passado como system prompt aos competidores; pode incluir politicas, dados de produto, manuais, FAQs, restricoes), "maxTokens" (inteiro 200..2000 sugerindo o teto razoavel de tokens da resposta), "rubric" (CRITERIO DE CORRETUDE: o que uma resposta CORRETA precisa conter/fazer com base no contexto, e os erros que a tornariam inaceitavel — servira de gabarito ancorado para o juiz; 1 a 3 frases objetivas).
- Cada cenario deve ser auto-contido: nao referencie outros cenarios.
- Varie o tipo de tarefa entre os cenarios (extracao, raciocinio, comparacao, criatividade controlada, recusa, etc.) coerente com o tema.
- Idioma: portugues, salvo se o tema exigir outro.`;

export interface GenerateStagesParams {
  apiKey: string;
  theme: string;
  /** Descricao detalhada do usuario sobre o que testar — prioridade na distribuicao dos cenarios. */
  scenarioBrief?: string;
  count: number;
  modelId: string;
  /** Perguntas ja existentes (ex.: seed importada) — os lotes devem evita-las. */
  excludePrompts?: string[];
  /**
   * Regras de geracao POR PERFIL/PROMPT com grounding real (F1.3): templates
   * `{{context}}`/`{{fewShot}}`/`{{setupKeys}}` + matriz de cobertura.
   */
  rules?: ScenarioRules;
  /** Instrucao de curriculum (lacunas de cobertura) embutida no user. */
  coverageInstructionText?: string;
  timeoutMs?: number;
  reasoningLevel?: ReasoningLevel;
}

function batchSystemPrompt(scenarioBrief?: string): string {
  const brief = scenarioBrief?.trim();
  if (!brief) return BATCH_SYSTEM_PROMPT;
  return `${BATCH_SYSTEM_PROMPT}

BRIEFING DETALHADO DO USUÁRIO — o que testar:
${brief}
(Este briefing tem PRIORIDADE na distribuicao dos cenarios.)`;
}

/** Um lote = uma chamada pedindo `count` cenarios. Falha → excecao (o chamador
 * converte em lote vazio); itens que nao passam no schema sao descartados. */
async function runBatch(params: {
  apiKey: string;
  modelId: string;
  theme: string;
  count: number;
  batchIndex?: number;
  batchCount?: number;
  excludePrompts: string[];
  scenarioBrief?: string;
  rules?: ScenarioRules;
  coverageInstructionText?: string;
  extraInstruction?: string;
  timeoutMs?: number;
  reasoningLevel?: ReasoningLevel;
}): Promise<StageSpec[]> {
  const {
    apiKey,
    modelId,
    theme,
    count,
    batchIndex,
    batchCount,
    excludePrompts,
    scenarioBrief,
    rules,
    coverageInstructionText,
    extraInstruction,
    timeoutMs,
    reasoningLevel,
  } = params;

  const sliceLine =
    batchCount && batchCount > 1
      ? `\nEste é o lote ${(batchIndex ?? 0) + 1} de ${batchCount}. Gere itens DISTINTOS entre si e dos demais lotes; varie tipos de tarefa, dificuldade e idioma.`
      : '';
  const excludeLine = excludePrompts.length
    ? `\nEVITE perguntas equivalentes a estas já existentes:\n${excludePrompts.map((p) => `- ${p}`).join('\n')}`
    : '';

  // Regras do perfil (F1.3): grounding real vem primeiro, o contrato JSON fecha.
  const rendered = rules
    ? renderScenarioRules(rules, {
        theme,
        count,
        excludePrompts,
        coverageInstruction: coverageInstructionText,
      })
    : undefined;
  const system = rendered
    ? `${rendered.system}\n\n---\n\n${BATCH_SYSTEM_PROMPT}`
    : batchSystemPrompt(scenarioBrief);
  const userPrompt = rendered
    ? `${rendered.user}\n\nTEMA: ${theme}
QUANTIDADE: ${count} cenarios${sliceLine}${extraInstruction ?? ''}

Gere os ${count} cenarios em JSON conforme as regras.`
    : `TEMA: ${theme}
QUANTIDADE: ${count} cenarios
${sliceLine}${excludeLine}${extraInstruction ?? ''}

Gere os ${count} cenarios em JSON conforme as regras.`;

  const result = await chatCompletion({
    apiKey,
    modelId,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.8,
    timeoutMs: timeoutMs ?? 120_000,
    responseFormatJson: true,
    reasoningLevel,
  });

  const parsed: unknown = JSON.parse(extractJson(result.text));
  const rawList: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { stages?: unknown }).stages)
      ? ((parsed as { stages: unknown[] }).stages)
      : [];

  const out: StageSpec[] = [];
  for (const raw of rawList) {
    const v = stageSchema.safeParse(raw);
    if (v.success) out.push({ ...v.data, origin: 'ai' });
  }
  return out;
}

/** K = um lote para cada ~4 cenarios pedidos, clampado em [1, 8]. */
export function batchCountFor(count: number): number {
  return Math.max(1, Math.min(8, Math.ceil(count / 4)));
}

/**
 * Gera `count` cenarios de uma vez: lotes paralelos → dedup (exato + ROUGE-L
 * 0.7) → UM backfill se faltar (pede ceil(falta*1.5), exclusao ampliada) →
 * dedup de novo → slice(0, count). Falha de um lote = lote vazio (console.warn),
 * nunca derruba. Itens voltam SEM id (o consumidor atribui) e com origin 'ai'.
 */
export async function generateStages(opts: GenerateStagesParams): Promise<StageSpec[]> {
  const {
    apiKey,
    theme,
    scenarioBrief,
    count,
    modelId,
    excludePrompts,
    rules,
    coverageInstructionText,
    timeoutMs,
    reasoningLevel,
  } = opts;
  if (count <= 0) return [];

  const batchCount = batchCountFor(count);
  const perBatch = Math.max(1, Math.ceil(count / batchCount));
  const exclude = (excludePrompts ?? []).slice(0, 30);

  const batches = await Promise.all(
    Array.from({ length: batchCount }, (_, b) => {
      // O ultimo lote absorve o resto (count nem sempre e multiplo de perBatch).
      const ask = b === batchCount - 1 ? Math.max(1, count - perBatch * (batchCount - 1)) : perBatch;
      return runBatch({
        apiKey,
        modelId,
        theme,
        count: ask,
        batchIndex: b,
        batchCount,
        excludePrompts: exclude,
        scenarioBrief,
        rules,
        coverageInstructionText,
        timeoutMs,
        reasoningLevel,
      }).catch((err: unknown) => {
        console.warn(`[datagen] lote ${b + 1}/${batchCount} falhou: ${(err as Error).message}`);
        return [] as StageSpec[];
      });
    }),
  );

  let merged = dedupeAdvanced(batches.flat()).kept;

  // Backfill unico e limitado, se o dedup deixou faltar cenario.
  if (merged.length < count) {
    const falta = count - merged.length;
    const excludeAll = [...(excludePrompts ?? []), ...merged.map((s) => s.question)].slice(0, 40);
    const backfill = await runBatch({
      apiKey,
      modelId,
      theme,
      count: Math.ceil(falta * 1.5),
      excludePrompts: excludeAll,
      scenarioBrief,
      rules,
      coverageInstructionText,
      extraInstruction:
        '\nCubra LACUNAS DE VARIEDADE: tipos de tarefa, dificuldades e idiomas ainda sub-representados.',
      timeoutMs,
      reasoningLevel,
    }).catch((err: unknown) => {
      console.warn(`[datagen] backfill falhou: ${(err as Error).message}`);
      return [] as StageSpec[];
    });
    merged = dedupeAdvanced(merged.concat(backfill)).kept;
  }

  return merged.slice(0, count);
}
