// Confirmação de custo ANTES de rodar (IMPL-020, R-10:REC-3 / Q5c).
//
// Padrão de UX para produto que gasta crédito do usuário: mostrar uma FAIXA
// low–high (não se sabe quantos tokens de saída virão) e DECOMPOR os drivers do
// custo (competidores, juiz, finais, gabaritos…), em vez de um número mágico.
// O limiar de US$ 1 é de engenharia (proporcional aos ~US$ 3/iteração medidos
// no dry-run) — é o ponto a partir do qual a run exige um "sim" explícito.
//
// Puro e isomórfico: a SPA usa no formulário (faixa do rodapé + diálogo) e no
// `api.ts` (portão que recusa iniciar sem confirmação); o estimador é o MESMO
// `estimateRunCost` que alimenta as portas de orçamento do motor — a faixa que o
// usuário confirma é a mesma conta que o ledger usa para parar a run.

import { estimateInputFromConfig, estimateRunCost, type CostEstimate, type EstimateInput } from '../estimate.js';
import { splitHoldout } from '../holdout.js';
import type { CostRole, OpenRouterModel, RunConfig } from '../types.js';
import { COST_ROLES } from '../types.js';

/** Acima disto (faixa ALTA), iniciar exige confirmação explícita. */
export const COST_CONFIRM_THRESHOLD_USD = 1;

/** Rótulos PT-BR dos drivers, na linguagem da tela (não a do log). */
export const COST_DRIVER_LABEL: Record<CostRole, string> = {
  datagen: 'geração de cenários',
  gabarito: 'gabaritos',
  competitor: 'respostas dos participantes',
  judge: 'julgamento',
  duel: 'finais (duelos)',
  rewriter: 'reescrita das variantes',
  agent: 'execução de agentes',
};

export interface CostDriver {
  role: CostRole;
  label: string;
  /** USD no teto de tokens (a ponta ALTA da faixa), já multiplicado pelas iterações. */
  usd: number;
  /** Chamadas planejadas deste papel (teto: o treino pode convergir antes). */
  calls: number;
  /** Fração do total (0..1). */
  share: number;
}

export interface LaunchCostEstimate {
  low: number;
  high: number;
  /** Drivers com custo ou chamada, do mais caro para o mais barato. Soma == high. */
  drivers: CostDriver[];
  /** Modelos sem preço no catálogo — contados como ZERO; a faixa não é confiável. */
  unpricedModelIds: string[];
  /**
   * Modelos NO catálogo com preço variável/desconhecido ("-1", roteadores —
   * IMPL-018/043): fora da soma (neutros), então a faixa é PARCIAL. Contam para
   * o portão como os sem preço: custo que não dá para limitar pede um "sim".
   */
  unknownPriceModelIds: string[];
  assumptions: CostEstimate['assumptions'];
  thresholdUsd: number;
  /** true = iniciar exige confirmação (faixa alta > limiar, ou custo desconhecido). */
  requiresConfirmation: boolean;
  /** Teto configurado (`config.budgetUsd`), quando há. */
  budgetUsd?: number;
  /** Teto abaixo do PISO da faixa: a run quase certamente para antes do fim. */
  budgetBelowLow: boolean;
  /** Teto abaixo do TETO da faixa: a run pode parar antes do fim. */
  budgetBelowHigh: boolean;
}

/** Decisão do portão: faixa alta acima do limiar OU custo que não dá para limitar. */
export function requiresCostConfirmation(
  high: number,
  unpricedModelIds: readonly string[] = [],
  thresholdUsd = COST_CONFIRM_THRESHOLD_USD,
): boolean {
  return high > thresholdUsd || unpricedModelIds.length > 0;
}

/**
 * POR QUE a confirmação foi pedida — o texto do diálogo depende disso. Com só
 * preço desconhecido a faixa pode caber no limiar, e dizer "pode custar mais de
 * US$ 1" seria falso: o que falta é poder LIMITAR o custo, não um custo alto.
 * `null` = não precisa confirmar.
 */
export type CostConfirmationReason = 'threshold' | 'unpriced' | 'both';

export function costConfirmationReason(
  e: Pick<LaunchCostEstimate, 'high' | 'thresholdUsd' | 'unpricedModelIds'>,
): CostConfirmationReason | null {
  const acima = e.high > e.thresholdUsd;
  const semPreco = e.unpricedModelIds.length > 0;
  if (acima && semPreco) return 'both';
  if (acima) return 'threshold';
  if (semPreco) return 'unpriced';
  return null;
}

/**
 * Cenários que o treino reserva para o holdout (mesmo split do trainer). Zero
 * fora de training, com `holdoutRatio: 0` ou quando a fatia ficaria abaixo do
 * piso (o trainer descarta o holdout inteiro nesse caso).
 */
export function plannedHoldoutStages(config: RunConfig): number {
  if (config.mode !== 'training' || config.holdoutRatio === 0) return 0;
  const pinned = config.customStages?.length ?? 0;
  const seed = config.scenarioSeed?.length ?? 0;
  const planned = pinned > 0 ? pinned : Math.max(config.stages, seed);
  return splitHoldout(Array.from({ length: planned }, (_, i) => i), config.holdoutRatio ?? 0.2).holdout
    .length;
}

/** Chamadas por papel em UMA iteração (mesma contabilidade de `estimateRunCost`). */
function callsPerIteration(input: EstimateInput, a: CostEstimate['assumptions']): Record<CostRole, number> {
  const judges = input.judgeModelIds.length;
  // Etapas EXECUTADAS (repeats clona cenários no compare); gabarito segue 1×/cenário.
  const exec = a.stages * a.repeats;
  // IMPL-013: a re-avaliação limpa do treino executa 2 contestants × minibatch
  // (candidato + régua) — chamadas que o `usd` do papel JÁ paga em
  // `estimateRunCost`; sem contá-las aqui o driver mostrava chamadas a menos
  // do que o custo dele cobria (a contabilidade tem de fechar com a faixa).
  const reeval = input.mode === 'training' ? Math.max(0, Math.floor(a.reevalStages ?? 0)) : 0;
  const reevalJudge = input.referenceJudging ? reeval * 2 : reeval * input.judgePasses;
  return {
    datagen: a.datagenBatches,
    gabarito: input.referenceJudging ? a.stages : 0,
    rewriter: input.optimizerModelId ? (input.variantsPerIteration ?? 0) : 0,
    competitor: exec * input.contestantModelIds.length + reeval * 2,
    judge:
      (input.referenceJudging ? exec * a.contestants * judges : exec * input.judgePasses * judges) +
      reevalJudge * judges,
    duel: input.referenceJudging ? exec * a.duelPairs * 2 : 0,
    agent: input.agentRuns ?? 0,
  };
}

/**
 * Estimativa de lançamento: faixa + drivers + decisão de confirmação.
 *
 * `estimateRunCost` devolve `byRole` POR ITERAÇÃO (com o holdout somado por
 * fora); aqui os drivers saem TOTAIS — `(porIteração × iterações) + holdout` —
 * para que a soma dos drivers feche com a ponta alta da faixa.
 */
export function estimateLaunchCost(
  config: RunConfig,
  models: OpenRouterModel[],
  opts: { thresholdUsd?: number } = {},
): LaunchCostEstimate {
  const thresholdUsd = opts.thresholdUsd ?? COST_CONFIRM_THRESHOLD_USD;
  const holdoutStages = plannedHoldoutStages(config);
  const input = estimateInputFromConfig(config, { holdoutStages });
  const est = estimateRunCost(input, models);
  // Sem o holdout, para separar a parte que NÃO se repete por iteração.
  const semHoldout = holdoutStages > 0 ? estimateRunCost({ ...input, holdoutStages: 0 }, models) : est;
  const iterations = est.assumptions.iterations;
  const porIter = callsPerIteration(input, est.assumptions);
  const judges = input.judgeModelIds.length;

  const drivers: CostDriver[] = [];
  for (const role of COST_ROLES) {
    const holdoutUsd = est.byRole[role] - semHoldout.byRole[role];
    const usd = semHoldout.byRole[role] * iterations + holdoutUsd;
    let calls = porIter[role] * iterations;
    if (holdoutStages > 0 && role === 'competitor') calls += holdoutStages * 2;
    if (holdoutStages > 0 && role === 'judge') calls += holdoutStages * 2 * judges;
    if (usd <= 0 && calls <= 0) continue;
    drivers.push({ role, label: COST_DRIVER_LABEL[role], usd, calls, share: 0 });
  }
  const total = drivers.reduce((s, d) => s + d.usd, 0);
  for (const d of drivers) d.share = total > 0 ? d.usd / total : 0;
  drivers.sort((a, b) => b.usd - a.usd || b.calls - a.calls);

  const budgetUsd = config.budgetUsd;
  return {
    low: est.low,
    high: est.high,
    drivers,
    unpricedModelIds: est.unpricedModelIds,
    unknownPriceModelIds: est.unknownPriceModelIds,
    assumptions: est.assumptions,
    thresholdUsd,
    requiresConfirmation: requiresCostConfirmation(
      est.high,
      [...est.unpricedModelIds, ...est.unknownPriceModelIds],
      thresholdUsd,
    ),
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    budgetBelowLow: budgetUsd !== undefined && budgetUsd < est.low,
    budgetBelowHigh: budgetUsd !== undefined && budgetUsd < est.high,
  };
}
