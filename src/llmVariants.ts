// Identidade de competidor como TRIPLA {modelId, reasoningLevel, temperature}
// (portado do prompt-arena: o mesmo modelo compete 2x com configs diferentes).
// O id é determinístico e não-posicional: mesma tripla => mesmo id, em
// qualquer posição da lista — isso ancora scoreboard, medalhas e lineage.

import type { Contestant, ReasoningLevel } from './types.js';
import { REASONING_LEVELS } from './reasoning.js';

export const MIN_LLM_VARIANTS = 2;
export const MAX_LLM_VARIANTS = 12;

/** Rótulo PT-BR de cada nível de raciocínio (UI e label da variante). */
export const LEVEL_LABEL_PT: Record<ReasoningLevel, string> = {
  off: 'Sem raciocínio',
  minimal: 'Raciocínio mínimo',
  low: 'Raciocínio baixo',
  medium: 'Raciocínio médio',
  high: 'Raciocínio alto',
  xhigh: 'Raciocínio muito alto',
  max: 'Raciocínio máximo',
};

/** Slug estável p/ ids: minúsculas; qualquer run de não-[a-z0-9] vira um único '-'. */
export function slugSafe(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/**
 * Id determinístico e não-posicional da tripla. `def` marca o default
 * (nível/temperatura não especificados) para não colidir com valores
 * explícitos: `llm__openai-gpt-4o__def__tdef` != `llm__openai-gpt-4o__off__t0`.
 */
export function llmVariantId(v: {
  modelId: string;
  reasoningLevel?: ReasoningLevel | null;
  temperature?: number | null;
}): string {
  return `llm__${slugSafe(v.modelId)}__${v.reasoningLevel ?? 'def'}__t${v.temperature ?? 'def'}`;
}

/** Rótulo humano: `slug · Raciocínio alto · t0.7` (omite as partes indefinidas). */
export function llmVariantLabel(v: {
  modelId: string;
  reasoningLevel?: ReasoningLevel | null;
  temperature?: number | null;
}): string {
  const parts = [slugSafe(v.modelId)];
  if (v.reasoningLevel != null) parts.push(LEVEL_LABEL_PT[v.reasoningLevel]);
  if (v.temperature != null) parts.push(`t${v.temperature}`);
  return parts.join(' · ');
}

/** Variante de config de LLM saneada (identidade = tripla modelo/raciocínio/temperatura). */
export interface LlmVariant {
  id: string;
  label: string;
  modelId: string;
  reasoningLevel: ReasoningLevel | null;
  temperature: number | null;
}

/** Valida um item cru; inválido vira warning (PT-BR) e é descartado, nunca derruba a run. */
function sanitizeItem(raw: unknown, index: number): { variant?: LlmVariant; warning?: string } {
  const pos = index + 1;
  if (typeof raw !== 'object' || raw === null) {
    return {
      warning: `Variante ${pos} descartada: não é um objeto { modelId, reasoningLevel?, temperature? }.`,
    };
  }
  const item = raw as Record<string, unknown>;
  const modelId = typeof item.modelId === 'string' ? item.modelId.trim() : '';
  if (!modelId) {
    return { warning: `Variante ${pos} descartada: modelId ausente ou vazio.` };
  }
  let reasoningLevel: ReasoningLevel | null = null;
  if (item.reasoningLevel != null) {
    if (
      typeof item.reasoningLevel !== 'string' ||
      !(REASONING_LEVELS as readonly string[]).includes(item.reasoningLevel)
    ) {
      return {
        warning: `Variante ${pos} descartada: nível de raciocínio "${String(
          item.reasoningLevel,
        )}" inválido (use ${REASONING_LEVELS.join(', ')}).`,
      };
    }
    reasoningLevel = item.reasoningLevel as ReasoningLevel;
  }
  let temperature: number | null = null;
  if (item.temperature != null) {
    const t = item.temperature;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 2) {
      return {
        warning: `Variante ${pos} descartada: temperatura deve ser um número entre 0 e 2 (recebido: ${String(
          t,
        )}).`,
      };
    }
    // Arredonda a 2 casas para o id ficar estável (0.7 e 0.700001 viram a mesma variante).
    temperature = Math.round(t * 100) / 100;
  }
  return {
    variant: {
      id: llmVariantId({ modelId, reasoningLevel, temperature }),
      label: llmVariantLabel({ modelId, reasoningLevel, temperature }),
      modelId,
      reasoningLevel,
      temperature,
    },
  };
}

/**
 * Saneia a lista crua de variantes (vinda da UI/JSON): 2–12 itens, modelId
 * obrigatório, nível ∈ REASONING_LEVELS (ausente → null), temperatura ∈ [0,2]
 * arredondada a 2 casas (ausente → null). Itens inválidos viram warnings e são
 * descartados — se sobrarem ≥ MIN válidos, segue; senão, erro. Ids duplicados
 * (mesma tripla) são erro, porque quebrariam o placar por-id.
 */
export function sanitizeLlmVariants(raw: unknown): {
  variants: LlmVariant[];
  warnings: string[];
  error?: string;
} {
  if (!Array.isArray(raw)) {
    return {
      variants: [],
      warnings: [],
      error: 'Variantes de LLM devem ser uma lista de objetos { modelId, reasoningLevel?, temperature? }.',
    };
  }
  if (raw.length < MIN_LLM_VARIANTS) {
    return {
      variants: [],
      warnings: [],
      error: `São necessárias ao menos ${MIN_LLM_VARIANTS} variantes; recebidas ${raw.length}.`,
    };
  }
  if (raw.length > MAX_LLM_VARIANTS) {
    return {
      variants: [],
      warnings: [],
      error: `Máximo de ${MAX_LLM_VARIANTS} variantes; recebidas ${raw.length}.`,
    };
  }
  const variants: LlmVariant[] = [];
  const warnings: string[] = [];
  raw.forEach((item, i) => {
    const { variant, warning } = sanitizeItem(item, i);
    if (variant) variants.push(variant);
    if (warning) warnings.push(warning);
  });
  if (variants.length < MIN_LLM_VARIANTS) {
    return {
      variants: [],
      warnings,
      error: `Sobraram apenas ${variants.length} variante(s) válida(s); o mínimo é ${MIN_LLM_VARIANTS}.`,
    };
  }
  const countById = new Map<string, number>();
  for (const v of variants) countById.set(v.id, (countById.get(v.id) ?? 0) + 1);
  const duplicated = [...countById.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  if (duplicated.length > 0) {
    return {
      variants: [],
      warnings,
      error: `Variantes com identidade duplicada (modelo + raciocínio + temperatura): ${duplicated.join(
        ', ',
      )}. Ajuste o nível de raciocínio ou a temperatura para diferenciá-las.`,
    };
  }
  return { variants, warnings };
}

/** Vendor do modelo = prefixo antes de '/' (OpenRouter: "openai/gpt-4o" → "openai"). */
function vendorOf(modelId: string): string {
  return modelId.split('/')[0];
}

/**
 * Avisos NÃO-bloqueantes de imparcialidade do painel de juízes: um juiz que
 * também compete tende a se auto-preferir, e um juiz do mesmo vendor de um
 * competidor tende a favorecer a própria família. Uma mensagem por juiz e
 * categoria; lista vazia = painel sem conflito aparente.
 */
export function fairnessWarnings(variants: LlmVariant[], judgeModelIds: string[]): string[] {
  const warnings: string[] = [];
  for (const judgeId of judgeModelIds) {
    const self = variants.filter((v) => v.modelId === judgeId);
    if (self.length > 0) {
      warnings.push(
        `O juiz "${judgeId}" também compete nesta run (${self
          .map((v) => v.label)
          .join(', ')}) — risco de viés de auto-preferência.`,
      );
    }
    const family = variants.filter(
      (v) => v.modelId !== judgeId && vendorOf(v.modelId) === vendorOf(judgeId),
    );
    if (family.length > 0) {
      const models = [...new Set(family.map((v) => v.modelId))].join(', ');
      warnings.push(
        `O juiz "${judgeId}" é do mesmo vendor ("${vendorOf(judgeId)}") de ${
          family.length === 1 ? 'um competidor' : `${family.length} competidores`
        } (${models}) — modelos tendem a preferir a própria família.`,
      );
    }
  }
  return warnings;
}

/**
 * Avisos de imparcialidade para o caso GENÉRICO (variation/training: o eixo é
 * um modelo só; compare clássico usa `fairnessWarnings` com variantes). Mesma
 * regra: auto-preferência (juiz compete) e mesmo vendor (viés de família).
 */
export function fairnessWarningsForModels(
  modelIds: string[],
  judgeModelIds: string[],
): string[] {
  return fairnessWarnings(
    modelIds.map((m) => ({ id: m, label: m, modelId: m, reasoningLevel: null, temperature: null })),
    judgeModelIds,
  );
}

/**
 * Converte variantes saneadas em contestants do modo compare. Usa `undefined`
 * (não null) nos opcionais: ausente = default do pipeline (temperatura 0 e
 * reasoning do RunConfig, aplicados pelo competitor).
 */
export function variantsToContestants(variants: LlmVariant[]): Contestant[] {
  return variants.map((v) => ({
    id: v.id,
    label: v.label,
    modelId: v.modelId,
    temperature: v.temperature ?? undefined,
    reasoningLevel: v.reasoningLevel ?? undefined,
  }));
}
