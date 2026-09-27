// Preço do catálogo com "desconhecido" EXPLÍCITO (IMPL-018 / R-07b:REC-7).
//
// O `/models` do OpenRouter manda preço como STRING de USD por token. Os
// roteadores (`openrouter/auto`, `openrouter/fusion`, …) vêm com "-1": o preço
// é VARIÁVEL (depende do modelo para onde a chamada for roteada). Antes o "-1"
// virava -1 numérico e multiplicava tokens: estimativa negativa, reserva de
// orçamento negativa (a porta dura AFROUXAVA a cada chamada) e "-1.000.000
// US$/M" na tela. Aqui o "-1" — e qualquer valor ausente, não numérico, não
// finito ou negativo — vira `null` = desconhecido, e `null` NUNCA é tratado
// como 0 ("grátis"): quem precisa de número decide explicitamente o que fazer.
//
// Módulo PURO (sem Node): fonte única para o gateway, o estimador, o CLI e a
// SPA (o web importa direto daqui, sem cópia).

import type { OpenRouterModel, OpenRouterModelPricing, TokenPrice } from '../types.js';

/** Rótulo PT-BR de preço desconhecido — o que a UI e o CLI mostram no lugar do número. */
export const UNKNOWN_PRICE_LABEL = 'variável';

/** Valor de preço desconhecido nos exports JSON (`models --json`, snapshot do catálogo). */
export const UNKNOWN_PRICE_JSON = 'unknown' as const;

/**
 * Como o catálogo trouxe um campo de preço:
 * - `ok`       número finito ≥ 0;
 * - `variable` o sentinela "-1" (roteador — preço variável, esperado, sem alerta);
 * - `missing`  ausente/vazio (fail-open: segue como desconhecido, com alerta);
 * - `invalid`  não numérico, não finito ou negativo ≠ -1 (fail-open, com alerta).
 */
export type PriceFieldKind = 'ok' | 'variable' | 'missing' | 'invalid';

export function classifyPrice(value: unknown): { price: TokenPrice; kind: PriceFieldKind } {
  if (value === undefined || value === null) return { price: null, kind: 'missing' };
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    if (!value.trim()) return { price: null, kind: 'missing' };
    n = Number(value);
  } else {
    return { price: null, kind: 'invalid' };
  }
  if (!Number.isFinite(n)) return { price: null, kind: 'invalid' };
  if (n === -1) return { price: null, kind: 'variable' };
  if (n < 0) return { price: null, kind: 'invalid' };
  return { price: n === 0 ? 0 : n, kind: 'ok' }; // normaliza -0
}

/** Converte um campo cru de preço. `null` = desconhecido (nunca negativo, nunca "grátis" por omissão). */
export function parsePrice(value: unknown): TokenPrice {
  return classifyPrice(value).price;
}

/** true = número utilizável (finito e ≥ 0). Blinda também records/caches antigos com -1. */
export function isKnownPrice(p: TokenPrice | undefined): p is number {
  return typeof p === 'number' && Number.isFinite(p) && p >= 0;
}

/** Os dois preços base, ou `null` se QUALQUER um for desconhecido (toda chamada tem entrada e saída). */
export function knownPricing(
  pricing: OpenRouterModelPricing | undefined,
): { prompt: number; completion: number } | null {
  if (!pricing) return null;
  const { prompt, completion } = pricing;
  return isKnownPrice(prompt) && isKnownPrice(completion) ? { prompt, completion } : null;
}

/** O modelo tem preço desconhecido/variável NO CATÁLOGO (≠ "fora do catálogo"). */
export function hasUnknownPrice(model: Pick<OpenRouterModel, 'pricing'>): boolean {
  if (!knownPricing(model.pricing)) return true;
  return (model.pricing.overrides ?? []).some(
    (t) => !isKnownPrice(t.prompt) || !isKnownPrice(t.completion),
  );
}

/** Preço efetivo do modelo para um prompt deste tamanho (respeita as faixas). */
export function tierFor(
  pricing: OpenRouterModelPricing,
  promptTokens: number,
): { prompt: TokenPrice; completion: TokenPrice } {
  let melhor: { prompt: TokenPrice; completion: TokenPrice } = {
    prompt: pricing.prompt,
    completion: pricing.completion,
  };
  let melhorMin = -1;
  for (const t of pricing.overrides ?? []) {
    if (promptTokens >= t.minPromptTokens && t.minPromptTokens > melhorMin) {
      melhor = { prompt: t.prompt, completion: t.completion };
      melhorMin = t.minPromptTokens;
    }
  }
  return melhor;
}

/**
 * Custo de uma chamada pelo catálogo (respeita as faixas). `null` = impossível
 * precificar: preço desconhecido na faixa que se aplica. Nunca negativo.
 */
export function priceTokens(
  pricing: OpenRouterModelPricing,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const preco = tierFor(pricing, promptTokens);
  const tin = Math.max(0, promptTokens);
  const tout = Math.max(0, completionTokens);
  // Um lado com 0 token não depende do preço daquele lado.
  if (tin > 0 && !isKnownPrice(preco.prompt)) return null;
  if (tout > 0 && !isKnownPrice(preco.completion)) return null;
  const pIn = isKnownPrice(preco.prompt) ? preco.prompt : 0;
  const pOut = isKnownPrice(preco.completion) ? preco.completion : 0;
  return tin * pIn + tout * pOut;
}

/** Teto de preço por requisição em USD por MILHÃO (`RunConfig.maxPricePerMTok`). */
export interface PriceCapPerMTok {
  prompt?: number;
  completion?: number;
}

/**
 * PIOR CASO dos endpoints ELEGÍVEIS para um modelo de preço variável: o maior
 * preço de entrada e o maior de saída entre os modelos com preço conhecido
 * (inclui faixas), LIMITADO pelo teto por requisição quando a run tem um
 * (`maxPricePerMTok` vai no pedido como `provider.max_price`: endpoint acima
 * dele não é elegível). É o valor usado para RESERVAR orçamento — um roteador
 * pode cair em qualquer modelo do catálogo, e `/models/{id}/endpoints` de
 * roteador vem vazio (medido em 2026-09-27), então sem teto não há lista menor.
 * `null` num lado = impossível limitar aquele lado (catálogo sem preço
 * conhecido e sem teto); `null` inteiro = nenhum dos dois lados limitável.
 */
export function worstCasePricing(
  models: readonly OpenRouterModel[],
  cap?: PriceCapPerMTok,
): { prompt: number; completion: number } | null {
  let prompt = -1;
  let completion = -1;
  for (const m of models) {
    const faixas = [m.pricing, ...(m.pricing.overrides ?? [])];
    for (const f of faixas) {
      if (isKnownPrice(f.prompt) && f.prompt > prompt) prompt = f.prompt;
      if (isKnownPrice(f.completion) && f.completion > completion) completion = f.completion;
    }
  }
  const limita = (pior: number, tetoPerM: number | undefined): number => {
    const teto =
      typeof tetoPerM === 'number' && Number.isFinite(tetoPerM) && tetoPerM >= 0 ? tetoPerM / 1_000_000 : undefined;
    if (teto === undefined) return pior;
    return pior < 0 ? teto : Math.min(pior, teto);
  };
  prompt = limita(prompt, cap?.prompt);
  completion = limita(completion, cap?.completion);
  if (prompt < 0 || completion < 0) return null;
  return { prompt, completion };
}

/**
 * Custo de uma chamada em que cada LADO de preço desconhecido é substituído
 * pelo `fallback` (tipicamente `worstCasePricing`). O lado conhecido usa o
 * próprio preço (respeita faixas). `null` = há lado desconhecido e não há
 * fallback. Nunca negativo.
 */
export function priceTokensOrWorst(
  pricing: OpenRouterModelPricing,
  promptTokens: number,
  completionTokens: number,
  fallback: { prompt: number; completion: number } | null,
): number | null {
  const direto = priceTokens(pricing, promptTokens, completionTokens);
  if (direto !== null) return direto;
  if (!fallback) return null;
  const preco = tierFor(pricing, promptTokens);
  const pIn = isKnownPrice(preco.prompt) ? preco.prompt : fallback.prompt;
  const pOut = isKnownPrice(preco.completion) ? preco.completion : fallback.completion;
  return Math.max(0, promptTokens) * pIn + Math.max(0, completionTokens) * pOut;
}

/** USD/token → texto "$x" por 1M tokens; desconhecido → "variável". Nunca "-1". */
export function formatPricePerMTok(usdPerToken: TokenPrice | undefined): string {
  if (!isKnownPrice(usdPerToken)) return UNKNOWN_PRICE_LABEL;
  const perM = usdPerToken * 1_000_000;
  if (perM === 0) return '$0';
  if (perM < 0.01) return `$${perM.toFixed(4)}`;
  return `$${perM.toFixed(2)}`;
}

/**
 * Rótulo curto de preço de um modelo (seletor da SPA, tabela do CLI). Os dois
 * lados desconhecidos (roteador, "-1") → "preço variável"; um lado só → o lado
 * desconhecido aparece como "variável". Nunca "-1" nem "$-1000000.00".
 */
export function formatPricingLabel(
  pricing: Pick<OpenRouterModelPricing, 'prompt' | 'completion'> | undefined,
): string {
  if (!pricing || (!isKnownPrice(pricing.prompt) && !isKnownPrice(pricing.completion))) {
    return `preço ${UNKNOWN_PRICE_LABEL}`;
  }
  return `in ${formatPricePerMTok(pricing.prompt)} / out ${formatPricePerMTok(pricing.completion)} /1M`;
}

/** Valor de preço para export JSON: número, ou a string `'unknown'`. */
export function exportPrice(
  usdPerToken: TokenPrice | undefined,
  scale = 1,
): number | typeof UNKNOWN_PRICE_JSON {
  return isKnownPrice(usdPerToken) ? usdPerToken * scale : UNKNOWN_PRICE_JSON;
}

/**
 * Filtro "preço máximo" (USD por MILHÃO). Preço desconhecido NÃO passa: não dá
 * para garantir que um roteador fique abaixo do teto (antes o -1 passava em
 * qualquer filtro de preço máximo).
 */
export function withinMaxPricePerMTok(
  usdPerToken: TokenPrice | undefined,
  maxPerMTok: number,
): boolean {
  return isKnownPrice(usdPerToken) && usdPerToken * 1_000_000 <= maxPerMTok;
}

/** Grátis de verdade: os dois preços CONHECIDOS e iguais a zero (desconhecido não é grátis). */
export function isFreePricing(pricing: OpenRouterModelPricing | undefined): boolean {
  const k = knownPricing(pricing);
  return k !== null && k.prompt === 0 && k.completion === 0;
}

// ---------------------------------------------------------------------------
// Preço variável na SPA: filtro de preço máximo, contagem "X de Y" e prévia de
// custo (IMPL-043 / R-11b:REC-7).
//
// A pesquisa manda rotular o "-1" como "variável" e EXCLUÍ-LO da estimativa e
// dos filtros de economia: antes o -1 REDUZIA o total estimado (tokens × -1) e
// passava em QUALQUER teto de preço (-1e6 > teto é sempre falso). Aqui:
//   - filtro: preço desconhecido num lado com teto fica FORA por default; só
//     entra por decisão EXPLÍCITA do usuário (`includeUnknown`), e a contagem
//     diz quantos saíram/entraram por isso;
//   - prévia: contribuição NEUTRA (0) + o modelo listado para o aviso "custo
//     não estimável" — o total é declarado incompleto, nunca "barateado".
// ---------------------------------------------------------------------------

/** Aviso PT-BR para modelo cujo custo não entra na estimativa (preço variável ou fora do catálogo). */
export const UNESTIMABLE_COST_LABEL = 'custo não estimável';

/** O mínimo de modelo que os helpers de UI leem (serve o `OpenRouterModel` do motor e o do web). */
export interface PricedModel {
  id: string;
  pricing: OpenRouterModelPricing;
}

/** Filtro de preço dos PARTICIPANTES, em USD por MILHÃO (o que o formulário mostra). */
export interface MaxPriceFilter {
  /** Teto de entrada. `undefined`/NaN/negativo = sem teto neste lado. */
  maxPromptPerMTok?: number;
  /** Teto de saída. `undefined`/NaN/negativo = sem teto neste lado. */
  maxCompletionPerMTok?: number;
  /**
   * Decisão EXPLÍCITA do usuário: manter os modelos de preço variável/desconhecido
   * mesmo com teto ativo. Default `false` — não dá para garantir que um roteador
   * fique abaixo do teto (ele pode cair em qualquer modelo do catálogo).
   */
  includeUnknown?: boolean;
}

export interface MaxPriceFilterResult<M> {
  /** Os que ficam na lista (o "X" da contagem). */
  models: M[];
  /** Tamanho da entrada (o "Y"). */
  total: number;
  /** Há pelo menos um teto válido. Sem teto, `models` é a entrada inteira. */
  active: boolean;
  /** Preço CONHECIDO acima do teto (saem sempre, com ou sem `includeUnknown`). */
  aboveCap: number;
  /** Preço desconhecido num lado COM teto — fora da lista, salvo `includeUnknown`. */
  unknownIds: string[];
  /** Eco da decisão do usuário (a contagem diz "incluídos" × "fora"). */
  includeUnknown: boolean;
}

function capValido(v: number | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Aplica o teto de preço (preço BASE do catálogo, como o formulário sempre fez).
 * Preço conhecido acima do teto sai; preço desconhecido num lado com teto sai
 * por default e só fica com `includeUnknown`. Um lado SEM teto não olha preço
 * (roteador com teto só de saída ainda precisa do lado de saída conhecido).
 */
export function filterByMaxPrice<M extends PricedModel>(
  models: readonly M[],
  filtro: MaxPriceFilter = {},
): MaxPriceFilterResult<M> {
  const capIn = capValido(filtro.maxPromptPerMTok);
  const capOut = capValido(filtro.maxCompletionPerMTok);
  const includeUnknown = filtro.includeUnknown === true;
  if (capIn === undefined && capOut === undefined) {
    return { models: [...models], total: models.length, active: false, aboveCap: 0, unknownIds: [], includeUnknown };
  }
  const kept: M[] = [];
  const unknownIds: string[] = [];
  let aboveCap = 0;
  for (const m of models) {
    let acima = false;
    let desconhecido = false;
    const lados: [number | undefined, TokenPrice | undefined][] = [
      [capIn, m.pricing?.prompt],
      [capOut, m.pricing?.completion],
    ];
    for (const [cap, preco] of lados) {
      if (cap === undefined) continue;
      if (!isKnownPrice(preco)) desconhecido = true;
      else if (!withinMaxPricePerMTok(preco, cap)) acima = true;
    }
    if (acima) {
      aboveCap += 1; // conhecido e caro: nem a escolha explícita o traz de volta
      continue;
    }
    if (desconhecido) {
      unknownIds.push(m.id);
      if (includeUnknown) kept.push(m);
      continue;
    }
    kept.push(m);
  }
  return { models: kept, total: models.length, active: true, aboveCap, unknownIds, includeUnknown };
}

/**
 * O que o teto fez, em partes: quantos acima do teto e o caso do preço variável
 * EXPLÍCITO (quantos ficaram fora, ou entraram por escolha do usuário). Vazio
 * sem teto ativo ou quando o teto não tirou ninguém.
 */
export function maxPriceFilterDetails(r: MaxPriceFilterResult<unknown>): string[] {
  if (!r.active) return [];
  const partes: string[] = [];
  if (r.aboveCap > 0) partes.push(`${r.aboveCap} acima do teto`);
  const n = r.unknownIds.length;
  if (n > 0) {
    const s = n === 1 ? '' : 's';
    partes.push(
      r.includeUnknown
        ? `${n} de preço ${UNKNOWN_PRICE_LABEL} incluído${s} por escolha sua (${UNESTIMABLE_COST_LABEL}; o teto não é garantido)`
        : `${n} de preço ${UNKNOWN_PRICE_LABEL} fora do filtro (não dá para garantir o teto)`,
    );
  }
  return partes;
}

/**
 * Contagem honesta "Mostrando X de Y" do filtro de preço + `maxPriceFilterDetails`.
 * `null` sem teto ativo.
 */
export function describeMaxPriceFilter(r: MaxPriceFilterResult<unknown>): string | null {
  if (!r.active) return null;
  return [`Mostrando ${r.models.length} de ${r.total} modelos`, ...maxPriceFilterDetails(r)].join(' · ');
}

/** Precificador da PRÉVIA de custo da SPA (rodapé da Nova run). */
export interface CostPreviewPricer {
  /**
   * Custo (USD) de UMA chamada pelo catálogo, respeitando as faixas. Preço
   * desconhecido/variável ou modelo fora do catálogo contribuem 0 — NEUTRO: o
   * total é declarado incompleto (aviso), nunca reduzido nem negativo.
   */
  cost(modelId: string, promptTokens: number, completionTokens: number): number;
  /** Modelos NO catálogo com preço desconhecido/variável que ficaram fora da soma. */
  unknownPriceIds(): string[];
  /** Modelos fora do catálogo carregado (também fora da soma). */
  unpricedIds(): string[];
}

export function createCostPreviewPricer(
  catalog: ReadonlyMap<string, PricedModel> | readonly PricedModel[],
): CostPreviewPricer {
  const idx: ReadonlyMap<string, PricedModel> = Array.isArray(catalog)
    ? new Map((catalog as readonly PricedModel[]).map((m) => [m.id, m]))
    : (catalog as ReadonlyMap<string, PricedModel>);
  const unknown = new Set<string>();
  const unpriced = new Set<string>();
  return {
    cost(modelId, promptTokens, completionTokens) {
      const m = idx.get(modelId);
      if (!m) {
        unpriced.add(modelId);
        return 0;
      }
      const v = priceTokens(m.pricing, promptTokens, completionTokens);
      if (v === null || !Number.isFinite(v) || v < 0) {
        unknown.add(modelId);
        return 0;
      }
      return v;
    },
    unknownPriceIds: () => [...unknown],
    unpricedIds: () => [...unpriced],
  };
}

/**
 * Aviso "custo não estimável" da prévia: `null` quando tudo foi precificado.
 * Singular/plural ("para este modelo" / "para estes modelos") e o motivo de cada
 * um (preço variável × fora do catálogo). Nunca números.
 */
export function unestimableCostNotice(
  unknownPriceIds: readonly string[],
  unpricedIds: readonly string[] = [],
): string | null {
  const total = unknownPriceIds.length + unpricedIds.length;
  if (total === 0) return null;
  const alvo = total === 1 ? 'para este modelo' : 'para estes modelos';
  const partes: string[] = [];
  if (unknownPriceIds.length) partes.push(`${unknownPriceIds.join(', ')} (preço ${UNKNOWN_PRICE_LABEL})`);
  if (unpricedIds.length) partes.push(`${unpricedIds.join(', ')} (fora do catálogo)`);
  return `Custo não estimável ${alvo}: ${partes.join('; ')} — fica fora da soma; o custo real será maior.`;
}

/**
 * Nota de UM modelo de preço desconhecido (chip/lista do seletor). `null` quando
 * os dois preços base são conhecidos.
 */
export function unknownPriceNote(model: Pick<PricedModel, 'pricing'> | undefined): string | null {
  if (!model || knownPricing(model.pricing)) return null;
  return `Preço ${UNKNOWN_PRICE_LABEL} (ex.: roteado pelo OpenRouter): ${UNESTIMABLE_COST_LABEL} para este modelo — fica fora da estimativa e dos filtros de preço, salvo escolha explícita.`;
}
