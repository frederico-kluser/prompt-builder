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
//      realmente envia — importados de `engine/callCaps.ts`, a MESMA constante
//      que vai no corpo e na reserva da porta dura (gabarito, juiz pointwise e
//      listwise e duelo re-exportam `ROLE_MAX_TOKENS` de roleLimits.ts, IMPL-016,
//      com sala p/ raciocinio; reescritor e datagen, IMPL-017) e, no
//      competidor, do MESMO teto que a porta dura reserva: resposta
//      (`maxOutputTokens`) + folga de raciocinio do degrau EFETIVO
//      (`competitorMaxTokens`). Numero copiado aqui fazia a porta suave aprovar
//      uma fase que a porta dura cortava no meio (revisoes IMPL-016/017).
//      E pior caso por construcao; prever os reasoning_tokens reais por
//      esforco x familia e o R-08:DEC-5.
//   4. O HOLDOUT do treino nao era contado (uma run extra de N cenarios x 2).
//
// A faixa `low..high` e, desde o IMPL-113 (R-08:REC-8), QUANTIS EMPÍRICOS POR
// PAPEL (p10/p50/p90 da razão real/estimado do ledger) + predição CONFORMAL
// (cobertura alvo 90%). O antigo `LOW_FACTOR = 0.45` (fator fixo publicado)
// ficou para trás: sem amostras a faixa usa o PRIOR documentado abaixo (ponto e
// topo = teto por construção; piso pela previsão de raciocínio por esforço x
// família) e, com amostras, os quantis do papel substituem tudo. Quem consome
// deve olhar `assumptions.range` (fonte por papel: 'empirico' | 'pool' |
// 'prior') e `assumptions`, nao tratar `point` como promessa.
//
// Preco DESCONHECIDO (IMPL-018 / R-07b:REC-7): modelo com preco "-1" no
// catalogo (roteadores — preco variavel) sai SEMPRE listado em
// `unknownPriceModelIds` e nunca vira numero negativo nem "gratis". Duas
// politicas, escolhidas por quem consome:
//   - `exclude` (default; o que se REPORTA ao humano): fica fora da soma, com
//     aviso de que o total real e maior;
//   - `worst-case` (o que as PORTAS de orcamento usam): cada lado desconhecido
//     vira o pior caso dos endpoints elegiveis (`worstCasePricing`: o preco
//     mais alto do catalogo, limitado pelo `maxPricePerMTok` da run quando ha).
//     `/models/{id}/endpoints` de roteador vem vazio, entao sem teto o
//     "elegivel" e o catalogo inteiro. Projetar de menos estoura o orcamento;
//     projetar de mais so corta cedo.
// A reserva da porta dura (`makeCallEstimator`) e sempre `worst-case`.

import { batchCountFor } from './datagen.js';
import { CANARY_MAX_TOKENS, JUDGE_MAX_TOKENS } from './contractGate.js';
import {
  DATAGEN_PROMPT_TOKENS,
  MAX_TOKENS_DATAGEN_BATCH,
  MAX_TOKENS_DUEL,
  MAX_TOKENS_GABARITO,
  MAX_TOKENS_JUDGE_LISTWISE,
  MAX_TOKENS_REF_JUDGE,
  MAX_TOKENS_REWRITER,
  REWRITER_PROMPT_TOKENS,
} from './engine/callCaps.js';
import {
  priceTokens,
  priceTokensOrWorst,
  worstCasePricing,
  type PriceCapPerMTok,
} from './engine/pricing.js';
import { selectionMinibatchSize, TECHNIQUES_PER_ITERATION } from './engine/trainingPolicy.js';
import { competitorModelHint } from './competitor.js';
import { competitorMaxTokens } from './roleLimits.js';
import { modelFamilyOf, takeCostSamples, type CostCalibrationSample } from './openrouter.js';
import { COST_ROLES } from './types.js';
import type {
  CostRole,
  OpenRouterModel,
  OpenRouterModelPricing,
  ReasoningLevel,
  RunConfig,
  RunMode,
  TokenPrice,
} from './types.js';

/** USD por token -> USD por milhao. A conversao 1e6 mora SO aqui e em toPerToken. */
export const PER_MTOK = 1_000_000;
export const toPerMTok = (usdPerToken: number): number => usdPerToken * PER_MTOK;
export const toPerToken = (usdPerMTok: number): number => usdPerMTok / PER_MTOK;

// Tetos reais que o pipeline envia: `engine/callCaps.ts` (fonte unica).
/** Contexto de entrada assumido por cenario (pergunta + productContext). */
const DEFAULT_CTX_IN = 500;
/** Entrada do juiz do contrato: instrucoes + invariantes + base + reescrita + diff. */
const CONTRACT_JUDGE_IN = 3600;
/**
 * Tamanho do gabarito como ENTRADA do juiz/duelo. Nao e o teto do papel: o
 * teto (IMPL-016) inclui o raciocinio, que nao volta no texto da referencia.
 */
const REFERENCE_TEXT_TOKENS = 1500;

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
  /**
   * Degrau de raciocinio de cada contestant (alinhado a `contestantModelIds`;
   * ja com a prioridade contestant ?? `reasoning.competitor`). Ausente = padrao
   * do modelo. Dimensiona a folga do teto do competidor (IMPL-016).
   */
  contestantReasoningLevels?: Array<ReasoningLevel | undefined>;
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
  /**
   * Contrato never-break (IMPL-011): verificar cada variante custa chamadas
   * alem da reescrita — correcao, juiz do diff e canarios, todas lancadas no
   * papel `rewriter` do ledger (`contractGate.ts`). Ausente = sem contrato.
   */
  contract?: {
    /** Camada 2 ligada (ha `neverBreak` e `judgeDiff !== false`). */
    judgeDiff: boolean;
    /** Juiz do diff. Ausente = o reescritor. */
    judgeModelId?: string;
    /** Teto de saida de cada canario ativo (vazio = sem camada 3). */
    canaryMaxTokens: number[];
  };
  /**
   * IMPL-113: degrau efetivo do juiz (`reasoning.judge`) — ancora a previsão de
   * `reasoning_tokens` por esforço x família dos papéis de juízo (pointwise,
   * listwise, duelo e gabarito). Ausente = padrão do modelo.
   */
  judgeReasoningLevel?: ReasoningLevel;
  /** IMPL-113: degrau do datagen (`reasoning.datagen`). */
  datagenReasoningLevel?: ReasoningLevel;
  /** IMPL-113: degrau do reescritor (`reasoning.rewriter`). */
  optimizerReasoningLevel?: ReasoningLevel;
  /**
   * IMPL-013 (training): cenarios do minibatch de RE-AVALIACAO LIMPA por
   * iteracao — candidato + regua respondem e sao julgados de novo, sem finais.
   * Entra em `perIteration` (e na porta de orcamento pre-iteracao) como teto:
   * so roda quando o gate da melhor de K promove, mas pode rodar em toda.
   */
  reevalStages?: number;
  ctxInTokens?: number;
  /**
   * Modo agente — numero de execucoes de agente planejadas
   * (= contestants x stages x repetitions). >0 liga o papel `agent`.
   */
  agentRuns?: number;
  /** Teto de gasto POR execucao de agente (USD). Vindo de `agent.limits.maxCostUsd`. */
  agentMaxCostUsd?: number;
  /**
   * Cenarios que usam gabarito textual (fase 1.5) e duelo LLM nas finais.
   * Ausente = todos. Etapa de agente com `verify[]` fica de fora: o oraculo
   * decide veredito e finais sem gabarito (IMPL-034).
   */
  referenceStages?: number;
  /**
   * Teto de preco por requisicao (USD por MILHAO; `RunConfig.maxPricePerMTok`).
   * So limita o PIOR CASO de modelo de preco desconhecido (IMPL-018): endpoint
   * acima do teto nao e elegivel. Preco conhecido nao e afetado.
   */
  maxPricePerMTok?: PriceCapPerMTok;
}

/**
 * Como tratar modelo de preco desconhecido/variavel (IMPL-018). `exclude` =
 * fora da soma, com aviso (reportar); `worst-case` = pior caso dos endpoints
 * elegiveis (portas de orcamento).
 */
export type UnknownPricePolicy = 'exclude' | 'worst-case';

export interface EstimateOptions {
  /** Default `exclude`. */
  unknownPrice?: UnknownPricePolicy;
  /**
   * IMPL-113: calibração estimado × real do ledger (quantis por papel). Ausente
   * = PRIOR documentado (ver `CostCalibration`): ponto/topo = teto, piso pela
   * previsão de raciocínio. Passar `CostCalibration.live()` consome as amostras
   * registadas pelo gateway (`recordCostSample` em openrouter.ts).
   */
  calibration?: CostCalibration;
}

export interface CostEstimate {
  /**
   * IMPL-113: centro da faixa = razão p50 real/estimado por papel (sem amostras
   * = o teto de tokens, pior caso por construção). ⚠️ `byRole`/`perIteration`
   * continuam o TETO (base de tokens) — é o que as portas comparam (a porta
   * suave nunca pode ficar abaixo da reserva); a faixa calibrada serve para
   * REPORTAR, nunca para afrouxar as portas.
   */
  point: number;
  /** Piso da faixa: p10 por papel − margem conformal (prior sem amostras). */
  low: number;
  /** Topo da faixa: p90 por papel + margem conformal (= o teto sem amostras). */
  high: number;
  byRole: Record<CostRole, number>;
  /** Custo de UMA iteracao (training); igual a `point` nos outros modos. */
  perIteration: number;
  /** Modelos que nao estao no catalogo — ficam FORA da soma (nao sao "gratis"). */
  unpricedModelIds: string[];
  /**
   * Modelos NO catalogo com preco desconhecido/variavel ("-1", ex.: roteadores).
   * Ficam FORA da soma: `point/low/high` sao so a parte precificavel e quem
   * consome precisa avisar que o total real e maior (nunca "custou zero").
   */
  unknownPriceModelIds: string[];
  assumptions: {
    /** Politica aplicada a `unknownPriceModelIds` (IMPL-018). */
    unknownPrice: UnknownPricePolicy;
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
    /** IMPL-013: cenarios da re-avaliacao limpa por iteracao (0 fora de training). */
    reevalStages: number;
    /**
     * IMPL-113: como a faixa foi construída — fonte por papel ('empirico' =
     * quantis do próprio papel; 'pool' = quantis de todas as amostras; 'prior' =
     * sem amostras, ver `CostCalibration`), a margem conformal aplicada e o n.
     */
    range: {
      /** Cobertura alvo do intervalo (predição conformal). */
      coverage: number;
      /** Amostras estimado × real disponíveis na calibração. */
      n: number;
      perRole: Partial<
        Record<
          CostRole,
          {
            low: number;
            point: number;
            high: number;
            n: number;
            source: RatioSource;
            /** Margem conformal (≥ 0) somada/subtraída aos quantis p90/p10. */
            conformal: number;
            /** Previsão de `reasoning_tokens` do papel (esforço × família). */
            predictedReasoningTokens: number;
          }
        >
      >;
    };
  };
}

// ---------------------------------------------------------------------------
// Estimativa v2 (IMPL-113 / R-08:REC-8) — quantis empíricos por papel e
// predição CONFORMAL da faixa.
//
// A faixa publicada sai da distribuição real/estimado do LEDGER: cada chamada
// medida regista o par (estimado do catálogo, real cobrado) em
// `recordCostSample` (openrouter.ts) e daqui saem os quantis p10/p50/p90 POR
// PAPEL (com fallback no pool e recorte por célula esforço × família). O
// intervalo [low, high] ainda leva a margem CONFORMAL (CQR: score = distância
// do quantil-base; margem = quantil finito `ceil((n+1)·cobertura)/n`) — é ela
// que sustenta cobertura ≥ 90% em amostras trocáveis, com correção de amostra
// finita (nunca "90% porque dissemos").
//
// SEM amostras (ou com célula fina) vem o PRIOR documentado:
//   - ponto e topo = 1,0 (o teto de tokens é pior caso por construção — sem
//     dados, assumir o teto é o único número honesto);
//   - piso = fração do teto que o real raramente fica abaixo, COM a previsão de
//     `reasoning_tokens` por esforço × família (família empírica > budget
//     declarado do provedor > referências effort↔budget 1.024/8.192/16.384):
//     raciocínio quase sempre gasta o budget previsto, resposta raramente usa o
//     teto — as constantes abaixo reproduzem o piso histórico 0,45 do custo
//     total (R-08) quando o raciocínio ocupa ~1/3 do teto.
// O prior NUNCA é o que se publica com dados: `assumptions.range` diz, papel a
// papel, de onde veio cada número ('empirico' | 'pool' | 'prior'). E a faixa é
// sempre POR PAPEL — não existe fator fixo multiplicando o total publicado.
// ---------------------------------------------------------------------------

/** Cobertura alvo do intervalo conformal (R-08:REC-8: "cobertura >= 90%"). */
export const CALIBRATION_TARGET_COVERAGE = 0.9;

/** Piso de amostras numa célula para falar em "empírico" (abaixo disso: pool/prior). */
export const MIN_CELL_SAMPLES = 5;

/** Amostras mínimas de `reasoning_tokens` numa célula para prever por ela. */
export const MIN_REASONING_SAMPLES = 3;

/** De onde veio o número de uma célula da faixa. */
export type RatioSource = 'empirico' | 'pool' | 'prior';

/** Quantis da razão real/estimado de uma célula. */
export interface RatioQuantiles {
  p10: number;
  p50: number;
  p90: number;
  n: number;
  source: RatioSource;
}

/** Faixa de razão publicada por papel (quantis + margem conformal). */
export interface RatioBand extends RatioQuantiles {
  /** Extremos finais (p10 − margem; clamp ≥ 0) multiplicados pelo teto do papel. */
  low: number;
  point: number;
  /** Extremos finais (p90 + margem). */
  high: number;
  /** Margem conformal aplicada (≥ 0). */
  conformal: number;
}

/** Célula da faixa/previsão: esforço × família de um papel. */
export interface CalibrationCell {
  /** Degrau efetivo no fio (`reasoning.effort`). */
  effort?: ReasoningLevel | string;
  /** Família do modelo (`modelFamilyOf` do gateway). */
  family?: string;
  /** Teto de saída do papel (`max_tokens`) — ancora o prior pela previsão. */
  capTokens?: number;
  /** Budget de raciocínio declarado pelo provedor (2º fallback da previsão). */
  declaredReasoningBudget?: number;
}

/** Resultado da previsão de `reasoning_tokens` (esforço × família). */
export interface ReasoningPrediction {
  tokens: number;
  source: 'empirico' | 'declarado' | 'referencia';
  /** Amostras por trás da previsão empírica (0 quando não é empírica). */
  n: number;
}

/**
 * Referências esforço ↔ budget de raciocínio (R-08:REC-8): low = 1.024,
 * medium = 8.192, high = 16.384 — as âncoras que os provedores usam como
 * budget. Os degraus intermédios interpolam/extrapolam a partir delas.
 */
export const REASONING_BUDGET_REF: Readonly<Record<'low' | 'medium' | 'high', number>> = Object.freeze({
  low: 1024,
  medium: 8192,
  high: 16384,
});

/** Previsão de raciocínio SEM dados: budget por degrau (âncoras acima). */
export const REASONING_BUDGET_BY_EFFORT: Readonly<Record<ReasoningLevel, number>> = Object.freeze({
  off: 0,
  minimal: 512, // interpolação (low / 2)
  low: REASONING_BUDGET_REF.low,
  medium: REASONING_BUDGET_REF.medium,
  high: REASONING_BUDGET_REF.high,
  xhigh: 24576, // extrapolação (high x 1,5)
  max: 32768, // extrapolação (high x 2)
});

/** Budget de referência de um degrau (desconhecido => `medium`). */
export function reasoningBudgetRef(effort?: string): number {
  const key = (effort ?? 'medium') as ReasoningLevel;
  return REASONING_BUDGET_BY_EFFORT[key] ?? REASONING_BUDGET_BY_EFFORT.medium;
}

/**
 * PRIOR do piso (sem amostras), pela fatia de raciocínio do teto. Calibrado no
 * piso histórico 0,45 (R-08): com raciocínio em ~1/3 do teto, 0,30 + 0,45/3 =
 * 0,45. Raciocínio no teto inteiro => 0,75 (quase tudo é budget previsto);
 * sem raciocínio => 0,30 (resposta raramente usa o teto).
 */
const PRIOR_ANSWER_LOW = 0.3;
const PRIOR_REASONING_LOW = 0.75;

/** Quantil empírico (interpolação linear sobre os valores ordenados). */
export function quantile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const xs = [...values].sort((a, b) => a - b);
  if (xs.length === 1) return xs[0];
  const pos = Math.min(1, Math.max(0, p)) * (xs.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

/**
 * Margem CONFORMAL (conformalized quantile regression): score de cada amostra =
 * distância para fora do intervalo-base [p10, p90]; a margem é o quantil
 * `ceil((n+1)·cobertura)/n` dos scores (correção de amostra finita). Com
 * amostras trocáveis, [p10 − margem, p90 + margem] cobre ≥ `cobertura` do
 * real. n < 2 = sem margem (não há score que sustente).
 */
export function conformalMargin(
  ratios: readonly number[],
  p10: number,
  p90: number,
  coverage = CALIBRATION_TARGET_COVERAGE,
): number {
  const n = ratios.length;
  if (n < 2) return 0;
  const scores = ratios.map((r) => Math.max(p10 - r, r - p90, 0));
  const nivel = Math.min(1, Math.ceil((n + 1) * coverage) / n);
  return quantile(scores, nivel);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Calibração estimado × real do ledger (IMPL-113): quantis por papel, faixa
 * conformal e previsão de `reasoning_tokens` por esforço × família.
 */
/**
 * Amostra estimado × real PERSISTIDA (JSONL do Node, `pb.costSamples` da SPA)
 * só é aceita com a forma certa — papel conhecido, modelo, estimado > 0 e real
 * ≥ 0, ambos finitos. Fonte ÚNICA dos dois leitores: o da SPA aceitava qualquer
 * objeto, e amostra velha/corrompida (estimado 0 ou ausente, modelo ausente)
 * virava razão Infinity/NaN — ou derrubava o `modelFamilyOf` na carga.
 */
export function isCostCalibrationSample(v: unknown): v is CostCalibrationSample {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.role === 'string' &&
    (COST_ROLES as readonly string[]).includes(s.role) &&
    typeof s.modelId === 'string' &&
    s.modelId.length > 0 &&
    typeof s.estimatedUsd === 'number' &&
    Number.isFinite(s.estimatedUsd) &&
    s.estimatedUsd > 0 &&
    typeof s.actualUsd === 'number' &&
    Number.isFinite(s.actualUsd) &&
    s.actualUsd >= 0
  );
}

export class CostCalibration {
  private readonly items: CostCalibrationSample[] = [];

  constructor(samples: Iterable<CostCalibrationSample> = []) {
    for (const s of samples) this.add(s);
  }

  /**
   * Calibração viva: consome o buffer de amostras registadas pelo gateway
   * (`recordCostSample`, uma por chamada medida). O buffer é anel (as últimas
   * bastam para quantis); quem quer histórico acumula `toJSON()` por run.
   */
  static live(): CostCalibration {
    return new CostCalibration(takeCostSamples());
  }

  /**
   * Aceita só amostra com estimado > 0 e real medido ≥ 0 — razão não existe sem
   * isto, e preço desconhecido ("-1", IMPL-018) NUNCA entra como valor
   * negativo (também não entra como zero: simplesmente não é amostra).
   */
  add(s: CostCalibrationSample): void {
    // A MESMA régua dos leitores persistidos: nada de razão Infinity/NaN.
    if (!isCostCalibrationSample(s)) return;
    this.items.push({ ...s, family: s.family || modelFamilyOf(s.modelId) });
  }

  get size(): number {
    return this.items.length;
  }

  all(): readonly CostCalibrationSample[] {
    return this.items;
  }

  /** Serialização para persistir a calibração por run/sessão (costAccuracy). */
  toJSON(): CostCalibrationSample[] {
    return this.items.map((s) => ({ ...s }));
  }

  static fromJSON(samples: Iterable<CostCalibrationSample>): CostCalibration {
    return new CostCalibration(samples);
  }

  private ratios(pred: (s: CostCalibrationSample) => boolean): number[] {
    const out: number[] = [];
    for (const s of this.items) {
      if (pred(s)) out.push(s.actualUsd / s.estimatedUsd);
    }
    return out;
  }

  /** Cadeia de fallback: célula (esforço × família) => papel => pool => prior. */
  private ratiosFor(role: CostRole, cell: CalibrationCell): { ratios: number[]; source: RatioSource } {
    const mesmaCelula = (s: CostCalibrationSample): boolean =>
      s.role === role &&
      (!cell.effort || s.effort === cell.effort) &&
      (!cell.family || s.family === cell.family);
    const mesmoPapel = (s: CostCalibrationSample): boolean => s.role === role;
    const cadeia: Array<{ pred: (s: CostCalibrationSample) => boolean; source: RatioSource }> = [
      { pred: mesmaCelula, source: 'empirico' },
      { pred: mesmoPapel, source: 'empirico' },
      { pred: () => true, source: 'pool' },
    ];
    for (const { pred, source } of cadeia) {
      const rs = this.ratios(pred);
      if (rs.length >= MIN_CELL_SAMPLES) return { ratios: rs, source };
    }
    return { ratios: [], source: 'prior' };
  }

  /** Quantis p10/p50/p90 da razão real/estimado da célula do papel. */
  quantilesFor(role: CostRole, cell: CalibrationCell = {}): RatioQuantiles {
    const { ratios, source } = this.ratiosFor(role, cell);
    if (ratios.length === 0) {
      return { p10: this.priorLowRatio(cell), p50: 1, p90: 1, n: 0, source: 'prior' };
    }
    return {
      p10: quantile(ratios, 0.1),
      p50: quantile(ratios, 0.5),
      p90: quantile(ratios, 0.9),
      n: ratios.length,
      source,
    };
  }

  /** Faixa publicada do papel: quantis conformalizados (cobertura alvo 90%). */
  bandFor(role: CostRole, cell: CalibrationCell = {}): RatioBand {
    const q = this.quantilesFor(role, cell);
    if (q.source === 'prior' || q.n < 2) {
      return { ...q, low: q.p10, point: q.p50, high: q.p90, conformal: 0 };
    }
    const { ratios } = this.ratiosFor(role, cell);
    const margem = conformalMargin(ratios, q.p10, q.p90, CALIBRATION_TARGET_COVERAGE);
    return {
      ...q,
      low: Math.max(0, q.p10 - margem),
      point: q.p50,
      high: q.p90 + margem,
      conformal: margem,
    };
  }

  /**
   * Previsão de `reasoning_tokens` por esforço × família (IMPL-113), em ordem:
   * mediana empírica da célula (esforço × família, n ≥ 3) > budget declarado do
   * provedor > referências effort↔budget (`REASONING_BUDGET_REF`). Família NÃO
   * vaza para família: os budgets de raciocínio são do provedor — sem amostras
   * da célula, o declarado/referência é mais honesto que a mediana alheia.
   * Nunca negativa.
   */
  reasoningTokensFor(effort?: string, family?: string, declaredBudget?: number): ReasoningPrediction {
    const norm = (v: string | undefined): string => v ?? 'default';
    const mesmaCelula = this.items.filter(
      (s) => typeof s.reasoningTokens === 'number' && norm(s.effort) === norm(effort) && (!family || s.family === family),
    );
    if (mesmaCelula.length >= MIN_REASONING_SAMPLES) {
      return {
        tokens: Math.max(0, quantile(mesmaCelula.map((s) => s.reasoningTokens!), 0.5)),
        source: 'empirico',
        n: mesmaCelula.length,
      };
    }
    if (typeof declaredBudget === 'number' && Number.isFinite(declaredBudget) && declaredBudget >= 0) {
      return { tokens: declaredBudget, source: 'declarado', n: 0 };
    }
    return { tokens: Math.max(0, reasoningBudgetRef(effort)), source: 'referencia', n: 0 };
  }

  /** Piso prior: fatia de raciocínio do teto pela previsão (ver `PRIOR_*`). */
  private priorLowRatio(cell: CalibrationCell): number {
    const cap = cell.capTokens ?? 0;
    const previsto = this.reasoningTokensFor(cell.effort, cell.family, cell.declaredReasoningBudget).tokens;
    const fatiaRaciocinio = cap > 0 ? Math.min(previsto, cap) / cap : 0;
    return clamp01(PRIOR_ANSWER_LOW + (PRIOR_REASONING_LOW - PRIOR_ANSWER_LOW) * fatiaRaciocinio);
  }
}

/**
 * IMPL-113 — PROVEDOR da calibração padrão: quem persiste as amostras
 * estimado × real (CLI: `src/costSamplesStore.ts`; SPA: o shim do gateway)
 * registra aqui a função que devolve a calibração acumulada. `estimateRunCost`
 * sem `calibration` explícita usa ela — é o que faz a faixa publicada sair dos
 * quantis empíricos em vez do prior. `undefined` desliga (volta ao prior).
 * ⚠️ Só a FAIXA reportada muda: `byRole`/`perIteration` (o que as portas de
 * orçamento comparam) continuam o teto — calibração nunca afrouxa porta.
 */
let calibrationProvider: (() => CostCalibration | undefined) | undefined;

export function setCostCalibrationProvider(provider: (() => CostCalibration | undefined) | undefined): void {
  calibrationProvider = provider;
}

/** A calibração do provedor registrado (ou `undefined`: sem provedor/sem amostras). */
export function defaultCostCalibration(): CostCalibration | undefined {
  try {
    const cal = calibrationProvider?.();
    return cal && cal.size > 0 ? cal : undefined;
  } catch {
    return undefined; // provedor quebrado nunca derruba a estimativa
  }
}

// ---------------------------------------------------------------------------
// Precificação com variantes de lote (IMPL-113): o slug `:batch` (lote, 0,5x do
// preço do modelo base) não vem no catálogo — resolve pelo id base AO VIVO e
// precifica pela metade. Slug desconhecido continua imprecificável (nunca 0
// silencioso, nunca negativo).
// ---------------------------------------------------------------------------

const BATCH_SUFFIX = ':batch';
/** Preço da variante `:batch` (lote) como fração do preço do modelo base. */
export const BATCH_PRICE_FACTOR = 0.5;

function halfPrice(v: TokenPrice): TokenPrice {
  return typeof v === 'number' && Number.isFinite(v) ? v * BATCH_PRICE_FACTOR : v;
}

/** Resolve um id contra o índice do catálogo, com a variante `:batch` (0,5x). */
export function resolveModel(
  idx: Map<string, OpenRouterModel>,
  id: string,
): OpenRouterModel | undefined {
  const direto = idx.get(id);
  if (direto) return direto;
  const slug = id.trim();
  if (!slug.toLowerCase().endsWith(BATCH_SUFFIX)) return undefined;
  const base = idx.get(slug.slice(0, -BATCH_SUFFIX.length));
  if (!base) return undefined;
  const p: OpenRouterModelPricing = {
    prompt: halfPrice(base.pricing.prompt),
    completion: halfPrice(base.pricing.completion),
    ...(base.pricing.overrides
      ? {
          overrides: base.pricing.overrides.map((t) => ({
            ...t,
            prompt: halfPrice(t.prompt),
            completion: halfPrice(t.completion),
          })),
        }
      : {}),
  };
  return { ...base, id: slug, pricing: p };
}

/**
 * Custo de UMA chamada, pelo catalogo, respeitando as faixas de preco.
 * `null` = impossivel precificar (fora do catalogo ou preco desconhecido) —
 * nunca 0 "por omissao" e nunca negativo.
 */
export function priceCall(
  model: OpenRouterModel | undefined,
  promptTokens: number,
  completionTokens: number,
): number | null {
  if (!model) return null;
  return priceTokens(model.pricing, promptTokens, completionTokens);
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

export function estimateRunCost(
  input: EstimateInput,
  models: OpenRouterModel[],
  opts: EstimateOptions = {},
): CostEstimate {
  const idx = indexModels(models);
  const politica: UnknownPricePolicy = opts.unknownPrice ?? 'exclude';
  // Pior caso so e calculado quando a politica pede (varre o catalogo inteiro).
  const pior = politica === 'worst-case' ? worstCasePricing(models, input.maxPricePerMTok) : null;
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
  const unknownPrice = new Set<string>();
  const model = (id?: string): OpenRouterModel | undefined => {
    if (!id) return undefined;
    // IMPL-113: slug vivo — a variante `:batch` (0,5x) resolve pelo id base.
    const m = resolveModel(idx, id);
    if (!m) unpriced.add(id);
    return m;
  };
  /**
   * Preco de uma chamada para a SOMA. Desconhecido vai SEMPRE para
   * `unknownPriceModelIds`; na soma entra pelo pior caso (`worst-case`) ou
   * fica de fora (`exclude` — o total e declarado incompleto, nao zerado).
   * Fora do catalogo ja foi para `unpricedModelIds` em `model()`.
   */
  const price = (m: OpenRouterModel | undefined, promptTokens: number, completionTokens: number): number => {
    const v = priceCall(m, promptTokens, completionTokens);
    if (v !== null) return v;
    if (!m) return 0;
    unknownPrice.add(m.id);
    return priceTokensOrWorst(m.pricing, promptTokens, completionTokens, pior) ?? 0;
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
    byRole.datagen += datagenBatches * price(m, DATAGEN_PROMPT_TOKENS, MAX_TOKENS_DATAGEN_BATCH);
  }

  // --- gabaritos: um por cenario que usa regua textual (IMPL-034) ---
  const refStages = Math.min(stages, Math.max(0, input.referenceStages ?? stages));
  if (input.referenceJudging && refStages > 0) {
    const m = model(input.referenceModelId ?? input.judgeModelIds[0]);
    byRole.gabarito += refStages * price(m, ctxIn + 200, MAX_TOKENS_GABARITO);
  }

  // --- reescritor: uma chamada por variante por iteracao ---
  const variantes = input.variantsPerIteration ?? 0;
  if (variantes > 0 && input.optimizerModelId) {
    const m = model(input.optimizerModelId);
    byRole.rewriter += variantes * price(m, REWRITER_PROMPT_TOKENS, MAX_TOKENS_REWRITER);
  }

  // --- contrato never-break: verificar cada variante (IMPL-011) ---
  // Pior caso por variante: 1 correcao do reescritor + 2 checagens (a 1a e a
  // pos-correcao), cada uma com o juiz do diff (ate 2 tentativas) e cada
  // canario (ate 2 confirmacoes); + a baseline dos canarios no base, 1x por
  // lote. Tetos de saida SEM a folga de raciocinio (como o refJudge acima).
  const contrato = input.contract;
  if (contrato && variantes > 0 && input.optimizerModelId) {
    const checagens = 2;
    byRole.rewriter += variantes * price(model(input.optimizerModelId), 2600, 1200);
    if (contrato.judgeDiff) {
      const mJuiz = model(contrato.judgeModelId ?? input.optimizerModelId);
      byRole.rewriter +=
        variantes * checagens * 2 * price(mJuiz, CONTRACT_JUDGE_IN, JUDGE_MAX_TOKENS);
    }
    const mAlvo = model(input.contestantModelIds[0]);
    for (const teto of contrato.canaryMaxTokens) {
      byRole.rewriter += (variantes * checagens * 2 + 1) * price(mAlvo, 1300, teto);
    }
  }

  // --- competidores: cada contestant responde cada cenario ---
  // Teto = o que a porta dura RESERVA (resposta + folga do degrau efetivo);
  // a ENTRADA do juiz segue so `maxOut` (o raciocinio nao volta no texto).
  const competitorCap = (m: OpenRouterModel | undefined, i: number): number =>
    competitorMaxTokens(maxOut, input.contestantReasoningLevels?.[i], competitorModelHint(m, ctxIn));
  input.contestantModelIds.forEach((id, i) => {
    const m = model(id);
    byRole.competitor += runStages * price(m, ctxIn, competitorCap(m, i));
  });

  // --- julgamento ---
  if (input.referenceJudging) {
    // pointwise: uma chamada por (juiz x contestant x cenario)
    for (const jid of input.judgeModelIds) {
      const m = model(jid);
      byRole.judge +=
        runStages * nContestants * price(m, ctxIn + maxOut + REFERENCE_TEXT_TOKENS, MAX_TOKENS_REF_JUDGE);
    }
  } else {
    // listwise: uma chamada por (juiz x passe x cenario), com TODAS as respostas
    for (const jid of input.judgeModelIds) {
      const m = model(jid);
      // Listwise envia o teto do juiz (IMPL-016/017); antes ia sem teto e aqui se supunha 800.
      byRole.judge +=
        runStages * input.judgePasses * price(m, ctxIn + nContestants * maxOut, MAX_TOKENS_JUDGE_LISTWISE);
    }
  }

  // --- finais: C(k,2) pares x 2 ordens x cenarios com gabarito ---
  const k = input.duels ? Math.min(input.finalists, nContestants) : 0;
  const duelPairs = pares(k);
  if (duelPairs > 0 && input.referenceJudging) {
    const m = model(input.judgeModelIds[0]);
    byRole.duel +=
      // Finais so nos cenarios com gabarito (IMPL-034), x repeats (IMPL-045).
      refStages *
      repeats *
      duelPairs *
      2 *
      price(m, ctxIn + 2 * maxOut + REFERENCE_TEXT_TOKENS, MAX_TOKENS_DUEL);
  }

  // --- re-avaliacao limpa (IMPL-013, training): 2 contestants x m cenarios ---
  // Avaliacao EXTRA da iteracao: sem ela a porta pre-iteracao deixava passar
  // uma iteracao que o orcamento nao cobre. Gabarito nao conta (os cenarios sao
  // os pinados, ja com referencia) e nao ha finais (duels: false).
  const reevalStages =
    input.mode === 'training' ? Math.max(0, Math.floor(input.reevalStages ?? 0)) : 0;
  if (reevalStages > 0) {
    const mComp = model(input.contestantModelIds[0]);
    // `price` (IMPL-018): preço desconhecido vai para unknownPriceModelIds /
    // pior caso, nunca soma null nem "grátis".
    // Mesmo teto do competidor que a porta dura reserva (IMPL-016).
    byRole.competitor += reevalStages * 2 * price(mComp, ctxIn, competitorCap(mComp, 0));
    for (const jid of input.judgeModelIds) {
      const m = model(jid);
      byRole.judge += input.referenceJudging
        ? reevalStages * 2 * price(m, ctxIn + maxOut + REFERENCE_TEXT_TOKENS, MAX_TOKENS_REF_JUDGE)
        : reevalStages * input.judgePasses * price(m, ctxIn + 2 * maxOut, MAX_TOKENS_JUDGE_LISTWISE);
    }
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

  // Base POR PAPEL da faixa: iterações + holdout. O `byRole` publicado continua
  // como sempre (por iteração + holdout somado): é o que os drivers e as portas
  // comparam — a faixa calibrada serve para REPORTAR, nunca para afrouxar porta.
  const iterShare: Record<CostRole, number> = { ...byRole };
  const holdoutShare: Partial<Record<CostRole, number>> = {};
  const perIteration = Object.values(byRole).reduce((a, b) => a + b, 0);

  // --- holdout (training): uma run extra, 2 contestants, sem finais ---
  const holdoutStages = input.mode === 'training' ? (input.holdoutStages ?? 0) : 0;
  if (holdoutStages > 0) {
    const mComp = model(input.contestantModelIds[0]);
    const holdoutComp = holdoutStages * 2 * price(mComp, ctxIn, competitorCap(mComp, 0));
    let holdoutJudge = 0;
    for (const jid of input.judgeModelIds) {
      holdoutJudge +=
        holdoutStages *
        2 *
        price(model(jid), ctxIn + maxOut + REFERENCE_TEXT_TOKENS, MAX_TOKENS_REF_JUDGE);
    }
    byRole.competitor += holdoutComp;
    byRole.judge += holdoutJudge;
    holdoutShare.competitor = holdoutComp;
    holdoutShare.judge = holdoutJudge;
  }

  // --- faixa v2 (IMPL-113): quantis por papel + predição conformal ---
  // Cada papel multiplica o seu teto pela banda da SUA distribuição
  // real/estimado (p10 − margem, p50, p90 + margem); sem amostras vem o prior
  // documentado em `CostCalibration`. Sem fator fixo sobre o total publicado.
  // IMPL-113: sem calibração explícita, a do PROVEDOR registrado pelo ponto de
  // entrada (CLI: amostras persistidas no diretório de dados; SPA: no
  // navegador) — antes nenhum chamador passava `calibration` e a faixa
  // publicada era SEMPRE o prior. Sem provedor/amostras = prior (como antes).
  const cal = opts.calibration ?? defaultCostCalibration() ?? new CostCalibration();
  const familiaDe = (id?: string): string | undefined => (id && id.trim() ? modelFamilyOf(id) : undefined);
  const compId = input.contestantModelIds[0];
  const juizId = input.judgeModelIds[0];
  const refId = input.referenceModelId ?? juizId;
  const celulas: Record<CostRole, CalibrationCell> = {
    datagen: {
      ...(input.datagenReasoningLevel ? { effort: input.datagenReasoningLevel } : {}),
      family: familiaDe(input.datagenModelId),
      capTokens: MAX_TOKENS_DATAGEN_BATCH,
    },
    gabarito: {
      ...(input.judgeReasoningLevel ? { effort: input.judgeReasoningLevel } : {}),
      family: familiaDe(refId),
      capTokens: MAX_TOKENS_GABARITO,
    },
    competitor: {
      ...(input.contestantReasoningLevels?.[0] ? { effort: input.contestantReasoningLevels[0] } : {}),
      family: familiaDe(compId),
      capTokens: competitorCap(idx.get(compId ?? ''), 0),
    },
    judge: {
      ...(input.judgeReasoningLevel ? { effort: input.judgeReasoningLevel } : {}),
      family: familiaDe(juizId),
      capTokens: input.referenceJudging ? MAX_TOKENS_REF_JUDGE : MAX_TOKENS_JUDGE_LISTWISE,
    },
    duel: {
      ...(input.judgeReasoningLevel ? { effort: input.judgeReasoningLevel } : {}),
      family: familiaDe(juizId),
      capTokens: MAX_TOKENS_DUEL,
    },
    rewriter: {
      ...(input.optimizerReasoningLevel ? { effort: input.optimizerReasoningLevel } : {}),
      family: familiaDe(input.optimizerModelId),
      capTokens: MAX_TOKENS_REWRITER,
    },
    // Agente: custo declarado por construção (§20.1) — sem esforço/família a
    // prever; entra pelo prior puro.
    agent: {},
  };
  let low = 0;
  let point = 0;
  let high = 0;
  const perRole: NonNullable<CostEstimate['assumptions']['range']['perRole']> = {};
  for (const role of COST_ROLES) {
    const total = (iterShare[role] ?? 0) * iterations + (holdoutShare[role] ?? 0);
    if (!(total > 0)) continue;
    const celula = celulas[role];
    const band = cal.bandFor(role, celula);
    low += total * band.low;
    point += total * band.point;
    high += total * band.high;
    perRole[role] = {
      low: band.low,
      point: band.point,
      high: band.high,
      n: band.n,
      source: band.source,
      conformal: band.conformal,
      predictedReasoningTokens: cal.reasoningTokensFor(
        celula.effort,
        celula.family,
        celula.declaredReasoningBudget,
      ).tokens,
    };
  }

  return {
    point,
    low,
    high,
    byRole,
    perIteration,
    unpricedModelIds: [...unpriced],
    unknownPriceModelIds: [...unknownPrice],
    assumptions: {
      unknownPrice: politica,
      ctxInTokens: ctxIn,
      maxOutputTokens: maxOut,
      stages,
      repeats,
      iterations,
      contestants: nContestants,
      judges,
      datagenBatches,
      duelPairs,
      reevalStages,
      range: {
        coverage: CALIBRATION_TARGET_COVERAGE,
        n: cal.size,
        perRole,
      },
    },
  };
}

/**
 * cli#11 — linhas "Por papel" da estimativa para humanos. Em TRAINING o
 * `byRole` é o teto de UMA iteração (a soma dele = `perIteration`, e o total
 * publicado = iterações × isso, + holdout): o rótulo diz isso e cada linha
 * mostra também o valor × iterações — antes as linhas somavam ~1/N do total
 * sem aviso nenhum. `fmt` formata dólar (o CLI passa o seu `fmtUsd`).
 */
export function formatRoleBreakdown(
  est: Pick<CostEstimate, 'byRole' | 'perIteration' | 'assumptions'>,
  mode: RunMode,
  fmt: (usd: number) => string,
): string[] {
  const treino = mode === 'training';
  const iters = Math.max(1, est.assumptions.iterations);
  const linhas = [treino ? `Por papel (teto por iteração; × ${iters} iterações):` : 'Por papel (no teto):'];
  for (const [role, usd] of Object.entries(est.byRole).sort((a, b) => b[1] - a[1])) {
    if (!(usd > 0)) continue;
    linhas.push(`  ${role.padEnd(12)} ${fmt(usd)}${treino ? `  (× ${iters} = ${fmt(usd * iters)})` : ''}`);
  }
  if (treino) linhas.push(`  ${'por iteração'.padEnd(12)} ${fmt(est.perIteration)}`);
  return linhas;
}

/**
 * cli#11 — linhas "Premissas" (chave × valor). O objeto `range` (IMPL-113) sai
 * resumido — cobertura, n e a FONTE da faixa por papel (empirico/pool/prior) —
 * em vez do `[object Object]` que a interpolação crua imprimia.
 */
export function formatAssumptions(assumptions: CostEstimate['assumptions']): string[] {
  const linhas: string[] = [];
  for (const [k, v] of Object.entries(assumptions)) {
    if (k === 'range') {
      const r = assumptions.range;
      const fontes = Object.entries(r.perRole)
        .map(([papel, b]) => `${papel}:${b!.source}`)
        .join(' ');
      linhas.push(`  ${'faixa'.padEnd(18)} cobertura ${(r.coverage * 100).toFixed(0)}% · n=${r.n}${fontes ? ` · ${fontes}` : ''}`);
      continue;
    }
    linhas.push(`  ${k.padEnd(18)} ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`);
  }
  return linhas;
}

/**
 * Deriva o input do estimador a partir de um RunConfig ja validado. `contestants`
 * so e conhecido depois de gerar as variantes; ate la, use `variantsPerIteration`
 * como aproximacao (tecnicas + base).
 */
export function estimateInputFromConfig(
  config: RunConfig,
  opts: {
    contestantIds?: string[];
    holdoutStages?: number;
    /** Degrau efetivo de cada contestant real (alinhado a `contestantIds`). */
    contestantReasoningLevels?: Array<ReasoningLevel | undefined>;
  } = {},
): EstimateInput {
  const judgeModelIds = config.judgeModelIds ?? [];
  const referenceJudging =
    config.referenceJudging ??
    (config.mode !== 'compare' || Boolean(config.competitorConfigs?.length));

  let contestantModelIds: string[];
  let contestantReasoningLevels: Array<ReasoningLevel | undefined>;
  let variantsPerIteration = 0;
  // Mesma prioridade do orquestrador: contestant.reasoningLevel ?? reasoning.competitor.
  const nivelRun = config.reasoning?.competitor;
  if (config.mode === 'compare') {
    contestantModelIds =
      config.competitorConfigs?.map((c) => c.modelId) ?? config.competitorModelIds ?? [];
    contestantReasoningLevels =
      config.competitorConfigs?.map((c) => c.reasoningLevel ?? nivelRun) ??
      contestantModelIds.map(() => nivelRun);
  } else {
    const base = config.basePrompt?.trim() ? 1 : 0;
    const training = config.mode === 'training';
    // IMPL-013: no treino, no maximo 6 tecnicas por iteracao (as demais rodam
    // nas iteracoes seguintes — ver `techniquesForIteration`).
    const tecnicas = Math.min(
      config.techniqueIds?.length ?? 0,
      training ? TECHNIQUES_PER_ITERATION.max : Infinity,
    );
    const manuais = (config.manualVariants ?? []).length;
    // O carry (campeao re-testado verbatim) e um contestant EXTRA em toda
    // iteracao a partir da 2a — a porta pre-iteracao so age nelas.
    const carry = training ? 1 : 0;
    const n =
      opts.contestantIds?.length ??
      Math.max(2, (config.promptOptimization !== false ? tecnicas : manuais) + base) + carry;
    contestantModelIds = Array.from({ length: n }, () => config.contestantModelId);
    contestantReasoningLevels = contestantModelIds.map(() => nivelRun);
    variantsPerIteration = config.promptOptimization !== false ? tecnicas : 0;
  }

  const pinned = config.customStages?.length ?? 0;
  const seed = config.scenarioSeed?.length ?? 0;
  const plannedStages = pinned > 0 ? pinned : Math.max(config.stages, seed);
  // IMPL-013: minibatch sobre TODOS os cenarios planejados (o de treino e menor
  // depois do holdout — teto conservador).
  const reevalStages = config.mode === 'training' ? selectionMinibatchSize(plannedStages) : 0;
  // Datagen so e chamado se o seed nao cobre o alvo e nao ha etapas pinadas.
  const precisaGerar = pinned === 0 && seed < config.stages;

  // Modo agente: numero de execucoes planejadas = contestants x cenarios x
  // repeticoes; teto por execucao = `agent.limits.maxCostUsd` (o schema ja exige
  // o campo em modo agente, entao aqui `undefined` = config invalida / nao caiu
  // por schema).
  const repetitions = config.agent?.repetitions ?? 1;
  // IMPL-013: a re-avaliacao limpa do treino tambem executa o agente (2 x m).
  const agentRuns = config.agent
    ? (contestantModelIds.length * plannedStages + 2 * reevalStages) * repetitions
    : 0;
  const agentMaxCostUsd = config.agent?.limits?.maxCostUsd;
  // IMPL-034: em modo agente (todo contestant e agente), etapa com verify[] nao
  // gera gabarito nem duelo LLM — o oraculo decide.
  const referenceStages =
    config.agent && pinned > 0
      ? config.customStages!.filter((s) => !(s.agentTask?.verify?.length ?? 0)).length
      : undefined;

  return {
    mode: config.mode,
    plannedStages,
    ...(config.mode === 'compare' && config.repeats !== undefined ? { repeats: config.repeats } : {}),
    iterations: config.mode === 'training' ? config.iterations : 1,
    contestantModelIds,
    contestantReasoningLevels: opts.contestantReasoningLevels ?? contestantReasoningLevels,
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
    contract: contractEstimateFrom(config, variantsPerIteration),
    // IMPL-113: degraus por papel (previsão de raciocínio da faixa).
    judgeReasoningLevel: config.reasoning?.judge,
    datagenReasoningLevel: config.reasoning?.datagen,
    optimizerReasoningLevel: config.reasoning?.rewriter,
    ...(reevalStages > 0 ? { reevalStages } : {}),
    ...(config.agent ? { agentRuns, agentMaxCostUsd } : {}),
    ...(referenceStages !== undefined ? { referenceStages } : {}),
    ...(config.maxPricePerMTok ? { maxPricePerMTok: config.maxPricePerMTok } : {}),
  };
}

/** O que o contrato never-break vai cobrar de cada variante (ver `EstimateInput.contract`). */
function contractEstimateFrom(config: RunConfig, variants: number): EstimateInput['contract'] {
  const c = config.contracts;
  if (!c || variants === 0 || config.mode === 'compare') return undefined;
  const temInvariante = (c.neverBreak ?? []).some((s) => typeof s === 'string' && s.trim());
  // Canario e teste de chat: run de agente pula a camada 3 (contractGate.ts).
  const canarios = config.agent ? [] : (c.canaries ?? []);
  const judgeDiff = temInvariante && c.judgeDiff !== false;
  if (!judgeDiff && canarios.length === 0) {
    // So a camada 1 (local, gratis) — mas a correcao do reescritor ainda pode rodar.
    return { judgeDiff: false, canaryMaxTokens: [] };
  }
  return {
    judgeDiff,
    judgeModelId: config.judgeModelIds?.[0],
    canaryMaxTokens: canarios.map((k) => k.maxTokens ?? CANARY_MAX_TOKENS),
  };
}

/**
 * Estimativa de UMA chamada avulsa, usada pela reserva otimista da porta dura.
 * Grosseira de proposito: so dimensiona o quanto reservar, nunca o que reportar.
 *
 * Preco desconhecido (roteador, "-1") reserva pelo PIOR CASO dos endpoints
 * elegiveis (`worstCasePricing`, limitado por `maxPricePerMTok` quando a run tem
 * teto): antes o -1 entrava direto e a reserva saia NEGATIVA — cada chamada
 * afrouxava a porta dura em vez de aperta-la. Reservar de mais so limita quantas
 * chamadas cabem em voo; o valor real (`usage.cost`) substitui a reserva quando
 * a resposta chega. Fora do catalogo segue 0 (o pre-voo do CLI recusa orcamento
 * com modelo fora do catalogo). Nunca negativo.
 */
export function makeCallEstimator(
  models: OpenRouterModel[],
  opts: { maxPricePerMTok?: PriceCapPerMTok } = {},
): (modelId: string, promptTokens: number, maxTokens: number) => number {
  const idx = indexModels(models);
  let pior: { prompt: number; completion: number } | null | undefined; // preguicoso: so com roteador
  return (modelId, promptTokens, maxTokens) => {
    // IMPL-113: slug vivo — `:batch` (lote, 0,5x) resolve pelo id base.
    const m = resolveModel(idx, modelId);
    if (!m) return 0;
    const v = priceCall(m, promptTokens, maxTokens);
    if (v !== null) return v;
    if (pior === undefined) pior = worstCasePricing(models, opts.maxPricePerMTok);
    return priceTokensOrWorst(m.pricing, promptTokens, maxTokens, pior) ?? 0;
  };
}
