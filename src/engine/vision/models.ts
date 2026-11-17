// BENCHMARK DE VISÃO — capacidades de visão do catálogo (Node, puro).
//
// O catálogo do OpenRouter diz, em `architecture.input_modalities`, o que o
// modelo aceita na ENTRADA. `OpenRouterModel` não normaliza esse campo (ele
// continua em `raw`), então a leitura vive aqui — um lugar só, com fallback
// explícito: catálogo SEM o campo = desconhecido (não recusa), catálogo COM o
// campo e sem `image` = recusa ANTES de gastar.

import type { OpenRouterModel } from '../../types.js';

export interface ModelVisionSupport {
  modelId: string;
  /** O catálogo declarou `architecture.input_modalities`? */
  declared: boolean;
  /** Aceita imagem na entrada? (quando `declared === false`, é só um palpite otimista.) */
  supportsImages: boolean;
  inputModalities: string[];
}

export function visionSupportOf(
  model: Pick<OpenRouterModel, 'id' | 'raw' | 'inputModalities'> | undefined,
): ModelVisionSupport | null {
  if (!model) return null;
  // O cache do catálogo não guarda `raw` (payload cru), então a modalidade
  // vem persistida em `inputModalities`; `raw` cobre o catálogo recém-buscado.
  const arch = (model.raw as { architecture?: { input_modalities?: unknown } } | undefined)?.architecture;
  const bruto = model.inputModalities ?? arch?.input_modalities;
  const lista = Array.isArray(bruto) ? bruto.filter((v): v is string => typeof v === 'string') : [];
  const declared = lista.length > 0;
  return {
    modelId: model.id,
    declared,
    supportsImages: !declared || lista.includes('image') || lista.includes('file'),
    inputModalities: lista,
  };
}

/** Modelos do catálogo que declaram NÃO aceitar imagem (recusa de pré-voo). */
export function modelsWithoutImageInput(
  modelIds: readonly string[],
  catalog: readonly OpenRouterModel[],
): string[] {
  const porId = new Map(catalog.map((m) => [m.id, m]));
  return modelIds.filter((id) => {
    const s = visionSupportOf(porId.get(id));
    return s !== null && s.declared && !s.supportsImages;
  });
}
