// Nº de cenários de uma run — faixa DOCUMENTADA (schema: inteiro 1–50) aplicada
// DENTRO dos dois orquestradores (left#13 / web-code#15, defesa em
// profundidade). O schema do Node recusa fora da faixa e o formulário da SPA
// faz o clamp no envio, mas quem chama o motor direto (teste, biblioteca, um
// import de JSON que pula o form) mandava 0 ou 2.5 cru: 0 cenários terminava
// a run 'inconclusive' sem nada rodado e 2.5 virava "alvo: 2.5" no pedido ao
// gerador. Puro: os dois motores importam daqui (fonte única).

export const STAGE_COUNT_MIN = 1;
export const STAGE_COUNT_MAX = 50;

/** Inteiro em [1, 50]; não-número/NaN => 1 (o mínimo que ainda roda algo). */
export function normalizeStageCount(stages: unknown): number {
  if (typeof stages !== 'number' || Number.isNaN(stages)) return STAGE_COUNT_MIN;
  return Math.max(STAGE_COUNT_MIN, Math.min(STAGE_COUNT_MAX, Math.round(stages)));
}

/**
 * A config com `stages` dentro da faixa (mesma referência quando já estava).
 * `stages` ausente fica ausente: etapas pinadas/customStages ditam a contagem
 * sozinhas (o schema força `stages` = tamanho da lista).
 */
export function withStageCountInRange<T extends { stages?: number }>(cfg: T): T {
  if (cfg.stages === undefined) return cfg;
  const n = normalizeStageCount(cfg.stages);
  return n === cfg.stages ? cfg : { ...cfg, stages: n };
}
