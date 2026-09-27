// Estimativa de custo ANTES de gastar.
//
// Portado do estimador que vivia dentro de um componente React
// (web/src/pages/NewRun.tsx), com quatro correcoes que faltavam la:
//
//   1. O REESCRITOR nao era contado. `generateOneVariant` roda uma vez por
//      tecnica por iteracao, com um prompt inteiro entrando e outro saindo —
//      dinheiro real, invisivel na conta.
//   2. Datagen e em LOTE, nao por etapa. A UI cobrava uma chamada por cenario;
//      `generateStages` faz `batchCountFor(count)` lotes. Erro de ~4x.
//   3. `high` era ficticio (`high = point`). Agora sai dos tetos que o codigo
//      realmente envia: gabarito 1500, refJudge 1024, duelo 512, competidor
//      `min(maxOutputTokens, stage.maxTokens)`.
//   4. O HOLDOUT do treino nao era contado (uma run extra de N cenarios x 2).
//
// A faixa `low..high` e larga de proposito (~2.2x). Quem consome deve olhar
// `assumptions`, nao tratar `point` como promessa.

import { batchCountFor } from './datagen.js';
import { tierFor } from './openrouter.js';
import type { CostRole, OpenRouterModel, RunConfig, RunMode } from './types.js';

/** USD por token -> USD por milhao. A conversao 1e6 mora SO aqui e em toPerToken. */
export const PER_MTOK = 1_000_000;
export const toPerMTok = (usdPerToken: number): number => usdPerToken * PER_MTOK;
export const toPerToken = (usdPerMTok: number): number => usdPerMTok / PER_MTOK;

/** Tetos reais que o pipeline envia — base do limite superior da faixa. */
const MAX_TOKENS_GABARITO = 1500;
const MAX_TOKENS_REF_JUDGE = 1024;
const MAX_TOKENS_DUEL = 512;
const MAX_TOKENS_DATAGEN_BATCH = 2000;
/** Contexto de entrada assumido por cenario (pergunta + productContext). */
const DEFAULT_CTX_IN = 500;
/** Piso empirico da faixa: respostas raramente usam o teto de tokens. */
const LOW_FACTOR = 0.45;

export interface EstimateInput {
  mode: RunMode;
  plannedStages: number;
  /**
   * Repeticoes por cenario (so compare, 1..3 — `config.repeats`). Multiplica
   * competidores, juiz e finais; gabarito e datagen continuam 1x por cenario
   * (os clones compartilham a referencia, como no orchestrator).
   */
  repeats?: number;
  /** 1 fora de training. Em training e um TETO (o laco pode convergir antes). */
  iterations: number;
  /** Um id por contestant (variantes repetem o mesmo modelo). */
  contestantModelIds: string[];
  /** Ausente = nada a gerar (tudo pinado/seed). */
  datagenModelId?: string;
  /** Modelo do gabarito. Ausente = sem julgamento por referencia. */
  referenceModelId?: string;
  judgeModelIds: string[];
  referenceJudging: boolean;
  duels: boolean;
  finalists: number;
  maxOutputTokens: number;
  judgePasses: 1 | 2;
  /** Meta-modelo que reescreve as variantes (variation/training). */
  optimizerModelId?: string;
  /** Quantas variantes o reescritor produz por iteracao. */
  variantsPerIteration?: number;
  /** Cenarios reservados para o holdout (training). */
  holdoutStages?: number;
  ctxInTokens?: number;
  /**
   * Modo agente — numero de execucoes de agente planejadas
   * (= contestants x stages x repetitions). >0 liga o papel `agent`.
   */
  agentRuns?: number;
  /** Teto de gasto POR execucao de agente (USD). Vindo de `agent.limits.maxCostUsd`. */
  agentMaxCostUsd?: number;
}

export interface CostEstimate {
  point: number;
  low: number;
  high: number;
  byRole: Record<CostRole, number>;
  /** Custo de UMA iteracao (training); igual a `point` nos outros modos. */
  perIteration: number;
  /** Modelos que nao estao no catalogo — a estimativa os conta como 0. */
  unpricedModelIds: string[];
  assumptions: {
    ctxInTokens: number;
    maxOutputTokens: number;
    stages: number;
    /** Repeticoes por cenario (1 fora do compare): etapas executadas = stages x repeats. */
    repeats: number;
    iterations: number;
    contestants: number;
    judges: number;
    datagenBatches: number;
    duelPairs: number;
    lowFactor: number;
  };
}

/** Custo de UMA chamada, pelo catalogo, respeitando as faixas de preco. */
export function priceCall(
  model: OpenRouterModel | undefined,
  promptTokens: number,
  completionTokens: number,
): number {
  if (!model) return 0;
  const preco = tierFor(model.pricing, promptTokens);
  return promptTokens * preco.prompt + completionTokens * preco.completion;
}

function indexModels(models: OpenRouterModel[]): Map<string, OpenRouterModel> {
  return new Map(models.map((m) => [m.id, m]));
}

/** Pares de um round-robin de k finalistas. */
function pares(k: number): number {
  return k >= 2 ? (k * (k - 1)) / 2 : 0;
}

/** Mesmo clamp do orchestrator: `max(1, min(3, round(repeats ?? 1)))`. */
export function clampRepeats(repeats: number | undefined): number {
  const r = Math.round(repeats ?? 1);
  return Number.isFinite(r) ? Math.max(1, Math.min(3, r)) : 1;
}

export function estimateRunCost(input: EstimateInput, models: OpenRouterModel[]): CostEstimate {
  const idx = indexModels(models);
  const ctxIn = input.ctxInTokens ?? DEFAULT_CTX_IN;
  const stages = Math.max(0, input.plannedStages);
  // REPEATS (F2 §7.9): o orchestrator roda alvo x repeats etapas (so compare,
  // clamp 1..3). Sem isto a estimativa (e o portao de confirmacao de custo)
  // subcontava competidores+juiz ate 3x (IMPL-045).
  const repeats = input.mode === 'compare' ? clampRepeats(input.repeats) : 1;
  const runStages = stages * repeats;
  const iterations = input.mode === 'training' ? Math.max(1, input.iterations) : 1;
  const nContestants = Math.max(1, input.contestantModelIds.length);
  const judges = input.judgeModelIds.length;
  const maxOut = Math.max(1, input.maxOutputTokens);

  const unpriced = new Set<string>();
  const model = (id?: string): OpenRouterModel | undefined => {
    if (!id) return undefined;
    const m = idx.get(id);
    if (!m) unpriced.add(id);
    return m;
  };

  // Um acumulador por papel, para "point" (teto de tokens) e "low" (piso).
  const byRole: Record<CostRole, number> = {
    datagen: 0,
    gabarito: 0,
    competitor: 0,
    judge: 0,
    duel: 0,
    rewriter: 0,
    // Onda 4 (estimativa de agente) computa o valor real — aqui só satisfaz o Record.
    agent: 0,
  };

  // --- datagen: LOTES, nao um por cenario ---
  const datagenBatches = input.datagenModelId && stages > 0 ? batchCountFor(stages) : 0;
  if (datagenBatches > 0) {
    const m = model(input.datagenModelId);
    byRole.datagen += datagenBatches * priceCall(m, 400, MAX_TOKENS_DATAGEN_BATCH);
  }

  // --- gabaritos: um por cenario ---
  if (input.referenceJudging && stages > 0) {
    const m = model(input.referenceModelId ?? input.judgeModelIds[0]);
    byRole.gabarito += stages * priceCall(m, ctxIn + 200, MAX_TOKENS_GABARITO);
  }

  // --- reescritor: uma chamada por variante por iteracao ---
  const variantes = input.variantsPerIteration ?? 0;
  if (variantes > 0 && input.optimizerModelId) {
    const m = model(input.optimizerModelId);
    byRole.rewriter += variantes * priceCall(m, 1200, 1200);
  }

  // --- competidores: cada contestant responde cada cenario ---
  for (const id of input.contestantModelIds) {
    byRole.competitor += runStages * priceCall(model(id), ctxIn, maxOut);
  }

  // --- julgamento ---
  if (input.referenceJudging) {
    // pointwise: uma chamada por (juiz x contestant x cenario)
    for (const jid of input.judgeModelIds) {
      const m = model(jid);
      byRole.judge +=
        runStages * nContestants * priceCall(m, ctxIn + maxOut + MAX_TOKENS_GABARITO, MAX_TOKENS_REF_JUDGE);
    }
  } else {
    // listwise: uma chamada por (juiz x passe x cenario), com TODAS as respostas
    for (const jid of input.judgeModelIds) {
      const m = model(jid);
      byRole.judge += runStages * input.judgePasses * priceCall(m, ctxIn + nContestants * maxOut, 800);
    }
  }

  // --- finais: C(k,2) pares x 2 ordens x cenarios com gabarito ---
  const k = input.duels ? Math.min(input.finalists, nContestants) : 0;
  const duelPairs = pares(k);
  if (duelPairs > 0 && input.referenceJudging) {
    const m = model(input.judgeModelIds[0]);
    byRole.duel +=
      runStages *
      duelPairs *
      2 *
      priceCall(m, ctxIn + 2 * maxOut + MAX_TOKENS_GABARITO, MAX_TOKENS_DUEL);
  }

  // --- agente: custo declarado por construção (§20.1) ---
  // O agente NAO e precificado por tokens aqui: `maxCostUsd` e um TETO por
  // execucao, entao `agentRuns * maxCostUsd` e o limite superior da faixa e e
  // EXATO por construcao (o executor mata no teto). Entra em `byRole.agent`,
  // soma ao ponto e a `perIteration`. `unpricedModelIds` fica intocado: o
  // agente nao consulta o catalogo por tokens — nada a marcar como imprecificavel.
  const agentRuns = input.agentRuns ?? 0;
  const agentMaxCostUsd = input.agentMaxCostUsd ?? 0;
  if (agentRuns > 0 && agentMaxCostUsd > 0) {
    byRole.agent = agentRuns * agentMaxCostUsd;
  }

  const perIteration = Object.values(byRole).reduce((a, b) => a + b, 0);
  let point = perIteration * iterations;

  // --- holdout (training): uma run extra, 2 contestants, sem finais ---
  const holdoutStages = input.mode === 'training' ? (input.holdoutStages ?? 0) : 0;
  if (holdoutStages > 0) {
    const mComp = model(input.contestantModelIds[0]);
    const holdoutComp = holdoutStages * 2 * priceCall(mComp, ctxIn, maxOut);
    let holdoutJudge = 0;
    for (const jid of input.judgeModelIds) {
      holdoutJudge +=
        holdoutStages *
        2 *
        priceCall(model(jid), ctxIn + maxOut + MAX_TOKENS_GABARITO, MAX_TOKENS_REF_JUDGE);
    }
    byRole.competitor += holdoutComp;
    byRole.judge += holdoutJudge;
    point += holdoutComp + holdoutJudge;
  }

  return {
    point,
    low: point * LOW_FACTOR,
    high: point,
    byRole,
    perIteration,
    unpricedModelIds: [...unpriced],
    assumptions: {
      ctxInTokens: ctxIn,
      maxOutputTokens: maxOut,
      stages,
      repeats,
      iterations,
      contestants: nContestants,
      judges,
      datagenBatches,
      duelPairs,
      lowFactor: LOW_FACTOR,
    },
  };
}

/**
 * Deriva o input do estimador a partir de um RunConfig ja validado. `contestants`
 * so e conhecido depois de gerar as variantes; ate la, use `variantsPerIteration`
 * como aproximacao (tecnicas + base).
 */
export function estimateInputFromConfig(
  config: RunConfig,
  opts: { contestantIds?: string[]; holdoutStages?: number } = {},
): EstimateInput {
  const judgeModelIds = config.judgeModelIds ?? [];
  const referenceJudging =
    config.referenceJudging ??
    (config.mode !== 'compare' || Boolean(config.competitorConfigs?.length));

  let contestantModelIds: string[];
  let variantsPerIteration = 0;
  if (config.mode === 'compare') {
    contestantModelIds =
      config.competitorConfigs?.map((c) => c.modelId) ?? config.competitorModelIds ?? [];
  } else {
    const base = config.basePrompt?.trim() ? 1 : 0;
    const tecnicas = config.techniqueIds?.length ?? 0;
    const manuais = (config.manualVariants ?? []).length;
    const n =
      opts.contestantIds?.length ??
      Math.max(2, (config.promptOptimization !== false ? tecnicas : manuais) + base);
    contestantModelIds = Array.from({ length: n }, () => config.contestantModelId);
    variantsPerIteration = config.promptOptimization !== false ? tecnicas : 0;
  }

  const pinned = config.customStages?.length ?? 0;
  const seed = config.scenarioSeed?.length ?? 0;
  const plannedStages = pinned > 0 ? pinned : Math.max(config.stages, seed);
  // Datagen so e chamado se o seed nao cobre o alvo e nao ha etapas pinadas.
  const precisaGerar = pinned === 0 && seed < config.stages;

  // Modo agente: numero de execucoes planejadas = contestants x cenarios x
  // repeticoes; teto por execucao = `agent.limits.maxCostUsd` (o schema ja exige
  // o campo em modo agente, entao aqui `undefined` = config invalida / nao caiu
  // por schema).
  const repetitions = config.agent?.repetitions ?? 1;
  const agentRuns = config.agent ? contestantModelIds.length * plannedStages * repetitions : 0;
  const agentMaxCostUsd = config.agent?.limits?.maxCostUsd;

  return {
    mode: config.mode,
    plannedStages,
    ...(config.mode === 'compare' && config.repeats !== undefined ? { repeats: config.repeats } : {}),
    iterations: config.mode === 'training' ? config.iterations : 1,
    contestantModelIds,
    datagenModelId: precisaGerar ? config.datagenModelId : undefined,
    referenceModelId: config.referenceModelId ?? judgeModelIds[0],
    judgeModelIds,
    referenceJudging,
    duels: config.duels !== false,
    finalists: config.finalists ?? 3,
    maxOutputTokens: config.maxOutputTokens ?? 1000,
    judgePasses: config.judgePasses ?? 1,
    optimizerModelId: config.optimizerModelId ?? config.datagenModelId,
    variantsPerIteration,
    holdoutStages: opts.holdoutStages,
    ...(config.agent ? { agentRuns, agentMaxCostUsd } : {}),
  };
}

/**
 * Estimativa de UMA chamada avulsa, usada pela reserva otimista da porta dura.
 * Grosseira de proposito: so dimensiona o quanto reservar, nunca o que reportar.
 */
export function makeCallEstimator(
  models: OpenRouterModel[],
): (modelId: string, promptTokens: number, maxTokens: number) => number {
  const idx = indexModels(models);
  return (modelId, promptTokens, maxTokens) => priceCall(idx.get(modelId), promptTokens, maxTokens);
}
