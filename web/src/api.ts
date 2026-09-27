import { requestPersistentStorage, type StorageSubject } from './storageHealth';
import type { ExpectedSpec } from '../../src/engine/groundTruth.js';
import type { PromptContracts } from '../../src/engine/contracts.js';
import type { PromptGroup } from '../../src/engine/promptGroup.js';
import type {
  CallFinishSignals,
  CostEntry,
  CostRole,
  FinishSignalCounts,
  RunCtx,
  RunPhase,
  StageIncompleteReason,
  StoredSignificance,
  TruncationSignal,
} from '../../src/types.js';
export type { CostEntry, CostRole, RunPhase } from '../../src/types.js';
import {
  estimateLaunchCost,
  type LaunchCostEstimate,
} from '../../src/engine/costConfirmation.js';
export type {
  CostConfirmationReason,
  CostDriver,
  LaunchCostEstimate,
} from '../../src/engine/costConfirmation.js';
export { COST_CONFIRM_THRESHOLD_USD, costConfirmationReason } from '../../src/engine/costConfirmation.js';
// Significância pareada: fonte única em src/types.ts (IMPL-001), como os tipos de custo.
export type { PairedSignificance, SignificanceMethod, StoredSignificance } from '../../src/types.js';
// Pareamento honesto (IMPL-005): fonte única em src/types.ts, como a significância.
import type { IterationGate, RunCompleteness, SessionPairing } from '../../src/types.js';
export type {
  BestOfKEntry,
  BestOfKTest,
  GateHoldReason,
  IterationGate,
  MultiplicityMethod,
  ObservationCoverage,
  PairCoverage,
  PairSensitivity,
  RunCompleteness,
  SessionPairing,
} from '../../src/types.js';
// Sinais de fim / truncamento (IMPL-014): fonte única em src/types.ts.
export type {
  CallFinishSignals,
  FinishSignalCounts,
  StageIncompleteReason,
  TruncationSignal,
} from '../../src/types.js';
export type { PromptContracts } from '../../src/engine/contracts.js';
import type { ModelLifecycleSnapshot } from '../../src/engine/modelLifecycle.js';
export type {
  ModelLifecycleAlert,
  ModelLifecycleEntry,
  ModelLifecycleSnapshot,
} from '../../src/engine/modelLifecycle.js';
import type { ModelReasoningMeta } from './modelCaps';
import type { LgpdData } from './lgpd';
import lgpdData from './data/lgpd-compliance.json';
import { cancelRun as engineCancelRun, isRunCancellable, startRun } from './engine/orchestrator';
import { cancelTraining, isTrainingCancellable, startTraining } from './engine/trainer';
import { generateContestants, generateBasePrompt as engineGenerateBasePrompt } from './engine/variator';
import { listModels, validateKey as engineValidateKey, currentConcurrency } from './engine/openrouter';
import { listTechniques } from './engine/techniques';
import {
  subscribeRun,
  getRunRecord,
  cacheRunRecord,
  subscribeSession,
  getSessionRecord,
  cacheSessionRecord,
} from './engine/events';
import {
  loadRun,
  loadSession,
  listRuns as engineListRuns,
  listSessions as engineListSessions,
  saveRun as engineSaveRun,
  saveSession as engineSaveSession,
} from './engine/storage';
import {
  savePrompt as engineSavePrompt,
  updatePrompt as engineUpdatePrompt,
  getPrompt as engineGetPrompt,
  listPrompts as engineListPrompts,
  deletePrompt as engineDeletePrompt,
} from './engine/promptStore';
import { parseScenarioPack, SCENARIO_PACK_FORMAT, SCENARIO_PACK_FORMAT_LEGACY } from './engine/scenarioPack';
import { parseArenaConfig, ARENA_CONFIG_FORMAT, type ArenaConfigFile } from './engine/configFile';
import { isHeldHere } from './engine/runLocks';
import {
  markRunInterrupted as engineMarkRunInterrupted,
  markSessionInterrupted as engineMarkSessionInterrupted,
  reconcileRun,
  reconcileSession,
  sweepOrphans,
  watchRun,
  watchSession,
  type OrphanCheck,
  type SweepResult,
} from './engine/orphans';

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength?: number;
  /** USD por token. `null` = preço DESCONHECIDO/variável (ex.: roteadores; "-1" no catálogo). */
  pricing: { prompt: number | null; completion: number | null };
  /** `supported_parameters` do OpenRouter — usado p/ determinismo por modelo. */
  supportedParameters?: string[];
  /** Metadados de raciocínio: quais degraus de esforço este modelo aceita. */
  reasoning?: ModelReasoningMeta;
  /** Ciclo de vida (IMPL-019): snapshot datado, data de deprecação e alvo do alias. */
  canonicalSlug?: string;
  expirationDate?: string | null;
  aliasTarget?: string;
  created?: number;
}

// Capacidades de ajuste por modelo (temperatura/esforço) — a UI consome pela
// porta única (api.ts), a regra mora em modelCaps.ts.
export type { ModelCaps, ModelReasoningMeta } from './modelCaps';
export { modelCaps, effortOptions, EFFORT_LABEL } from './modelCaps';
// Preço com "desconhecido" explícito (IMPL-018): fonte única em src/engine/pricing.ts.
// IMPL-043: filtro de preço com decisão explícita p/ o variável, contagem "X de Y",
// prévia de custo com contribuição neutra e o aviso "custo não estimável".
export {
  createCostPreviewPricer,
  describeMaxPriceFilter,
  filterByMaxPrice,
  formatPricePerMTok,
  formatPricingLabel,
  isKnownPrice,
  knownPricing,
  priceTokens,
  unestimableCostNotice,
  unknownPriceNote,
  withinMaxPricePerMTok,
  UNESTIMABLE_COST_LABEL,
  UNKNOWN_PRICE_LABEL,
} from '../../src/engine/pricing.js';

export type RunMode = 'compare' | 'variation' | 'training';

/** Nivel de esforco: espelha a escala `effort` do OpenRouter (7 degraus). */
export type ReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Reasoning por papel da run; papel ausente = desligado. */
export interface ReasoningConfig {
  competitor?: ReasoningLevel;
  judge?: ReasoningLevel;
  rewriter?: ReasoningLevel;
  datagen?: ReasoningLevel;
}

export interface ManualVariant {
  label: string;
  systemPrompt: string;
}

export interface Contestant {
  id: string;
  label: string;
  modelId: string;
  systemPrompt?: string;
  techniqueId?: string;
  isOriginal?: boolean;
  parentContestantId?: string;
  /** Override de temperatura deste contestant (compare-llms). Default 0. */
  temperature?: number;
  /** Nivel de reasoning deste contestant (compare-llms; identidade = tripla modelo/temp/reasoning). */
  reasoningLevel?: ReasoningLevel;
}

/** Tecnica exposta por GET /techniques (sem o meta-prompt). */
export interface Technique {
  id: string;
  name: string;
  /** Nivel de confianca da evidencia: alta/media/baixa. */
  confidence?: 'alta' | 'media' | 'baixa';
  good: string;
  bad: string;
}

export interface RunConfig {
  mode?: RunMode;
  /** compare: repeticoes por cenario (1–3) p/ medir instabilidade (F2 §7.9). */
  repeats?: 1 | 2 | 3;
  theme: string;
  stages: number;
  // compare:
  competitorModelIds?: string[];
  // variation/training:
  contestantModelId?: string;
  basePrompt?: string;
  promptOptimization?: boolean;
  techniqueIds?: string[];
  manualVariants?: ManualVariant[];
  optimizerModelId?: string;
  judgePasses?: 1 | 2;
  iterations?: number;
  /** Perfil de conformidade LGPD (consultivo; gravado no record). Ausente = "livre". */
  compliance?: { area: string; includeRessalvas: boolean };
  /** Etapas fornecidas pelo usuario (JSON); pulam o datagen e fixam `stages`. */
  customStages?: StageSpec[];
  // evolucao de prompts / compare-llms:
  /** Reasoning (esforco) por papel: competitor/judge/rewriter/datagen. */
  reasoning?: ReasoningConfig;
  /** Modelo que gera os gabaritos (respostas de referencia). Default = 1o juiz. */
  referenceModelId?: string;
  /** Julgamento por referencia (pointwise vs gabarito + duelos). */
  referenceJudging?: boolean;
  /**
   * No de FINALISTAS que disputam os duelos depois do julgamento pointwise.
   * Os melhores por judge-score medio (todos os cenarios) duelam entre si em
   * cada cenario. 0 = sem duelos. Default 3.
   */
  finalists?: number;
  /** Liga/desliga a fase de finais (duelos). Default: true quando ha gabarito. */
  duels?: boolean;
  /** Descricao detalhada do que testar — guia o datagen. */
  scenarioBrief?: string;
  /** Contratos never-break do prompt base (pos-rewriter rejeita o que quebrar). */
  contracts?: PromptContracts;
  /** Multi-prompt (F2/P0.4): grupo de fragmentos; evolui-se `promptId` por sessao. */
  promptGroup?: PromptGroup;
  promptId?: string;
  /** Cenarios importados de pacote JSON (seed). */
  scenarioSeed?: StageSpec[];
  /** compare-llms: variantes de config {modelo, temp, reasoning}. */
  competitorConfigs?: { modelId: string; temperature?: number; reasoningLevel?: ReasoningLevel }[];
  /**
   * training: margem PRATICA minima de ganho (pp) p/ promover; sem ganho =
   * convergiu. Ausente = max(1; 50/n) (meia granularidade — IMPL-002); o gate
   * tambem exige p ajustado (max-T sobre as K variantes) <= 0,05.
   */
  minGain?: number;
  /** training: fracao de cenarios p/ holdout (clamp [0, 0.5]). Default 0.2. */
  holdoutRatio?: number;
  /** training: variantes recebem licoes das falhas do campeao (GEPA). */
  feedbackDriven?: boolean;
  /** Reflexao GEPA: 'deterministic' (default) | 'llm' (meta-modelo reescreve as licoes) | 'off'. */
  reflection?: 'off' | 'deterministic' | 'llm';
  // meta:
  datagenModelId: string;
  /** Um ou mais juizes — rodam em paralelo. */
  judgeModelIds: string[];
  concurrency?: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
  /**
   * Teto de gasto em USD da run (ou da SESSÃO inteira, em training). Ausente =
   * sem limite. O ledger do motor para a run numa porta de fase (aborted +
   * stoppedReason 'budget') em vez de estourar o teto.
   */
  budgetUsd?: number;
}

export interface CompetitorResponse {
  contestantId: string;
  modelId: string;
  text: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** `blocked` = moderação/guardrail (sem veredito); `refused` = o modelo recusou (julgável); `error` = infra. */
  status: 'ok' | 'error' | 'blocked' | 'refused';
  errorMsg?: string;
  finishReason?: string;
  nativeFinishReason?: string;
  /** Cortada no teto mesmo após o retry x2 (IMPL-014) — a etapa fica fora do placar. */
  truncated?: boolean;
  reasoningTokens?: number;
  maxTokens?: number;
  truncationSignals?: TruncationSignal[];
  truncationRetried?: boolean;
  /** Sinais da 1a tentativa (a truncada), quando houve retry por truncamento. */
  firstAttempt?: CallFinishSignals;
}

export interface StageSpec {
  question: string;
  productContext: string;
  maxTokens: number;
  /** Criterio de corretude da etapa; injetado no juiz como rubrica ancorada. */
  rubric?: string;
  /** Gabarito: resposta de referencia ideal (juiz pointwise + duelos). */
  reference?: string;
  /** Rotulo esperado (ground-truth): veredito deterministico sem juiz LLM. */
  expected?: ExpectedSpec;
  /** Proveniencia da etapa: gerada pela IA ou importada de pacote JSON. */
  origin?: 'ai' | 'import';
}

/** Veredito ternario: resolve / parcial / nao. */
export type Verdict = 'resolve' | 'parcial' | 'nao';

export interface JudgeVerdict {
  contestantId: string;
  /** Veredito ternario: resolve / parcial / nao. */
  verdict: Verdict;
  /** Justificativa gerada ANTES da classificacao (estilo G-Eval). */
  motivo: string;
  /** @deprecated compat: records antigos guardavam so o binario. */
  acceptable?: boolean;
}

export interface SingleJudgeResult {
  judgeModelId: string;
  rankedContestantIds: string[];
  verdicts: JudgeVerdict[];
  blindMap: Record<string, string>;
  inconclusive?: boolean;
}

export interface JudgeResult {
  /** Consenso entre juizes (posicao media): melhor -> pior. */
  rankedContestantIds: string[];
  /** Aceitavel por contestant = maioria dos juizes (derivado do ternario). */
  acceptableByContestant: Record<string, boolean>;
  /** Veredito ternario agregado por contestant (consenso). Ausente em records antigos. */
  verdictByContestant?: Record<string, Verdict>;
  /** Resultado individual de cada juiz. */
  judges: SingleJudgeResult[];
  blindMap: Record<string, string>;
  rawJudgeText: string;
  inconclusive?: boolean;
}

/** Julgamento pointwise contra o gabarito (`StageSpec.reference`). Base do judge-score. */
export interface ReferenceJudgeResult {
  /** Veredito ternario por contestant (consenso entre juizes, quando ha mais de um). */
  verdictByContestant: Record<string, Verdict>;
  /** Explicacao curta (1 frase) por contestant. */
  explanationByContestant: Record<string, string>;
  judgeModelId: string;
  inconclusive?: boolean;
}

/** Resultado de UM duelo pairwise (2 ordens; desacordo entre ordens = empate). */
export interface DuelOutcome {
  a: string;
  b: string;
  order1: { winner: 'a' | 'b' | 'tie'; explanation: string };
  order2: { winner: 'a' | 'b' | 'tie'; explanation: string };
  /** Resultado combinado das 2 ordens. */
  outcome: 'a' | 'b' | 'tie';
}

/** Duelos round-robin da etapa (bracket top-K): placar Copeland, placements fracionarios em empate. */
export interface StageDuels {
  /** Placement final por contestant (1 = melhor; fracionario em empate). */
  placementByContestant: Record<string, number>;
  /** ContestantIds ordenados do melhor ao pior placement. */
  order: string[];
  /** Pontos Copeland por contestant (vitoria 1, empate 0.5). */
  points: Record<string, number>;
  duels: DuelOutcome[];
  /** Tamanho do bracket usado (0 = round-robin completo). */
  topK: number;
}

/** @deprecated Avaliador fundido no juiz; mantido p/ ler records antigos. */
export interface EvaluationVerdict {
  contestantId: string;
  acceptable: boolean;
  justification: string;
}

/** @deprecated Avaliador fundido no juiz; mantido p/ ler records antigos. */
export interface StageEvaluation {
  bestContestantId: string;
  bestReasons: string;
  verdicts: EvaluationVerdict[];
  blindMap: Record<string, string>;
  raw: string;
  inconclusive?: boolean;
}

export interface StageRecord {
  index: number;
  spec?: StageSpec;
  responses: CompetitorResponse[];
  live?: Record<string, CompetitorLiveState>;
  judge?: JudgeResult;
  /** Julgamento pointwise contra o gabarito (quando a etapa tem `reference`). */
  referenceJudge?: ReferenceJudgeResult;
  /** Duelos pairwise (Copeland) da etapa (quando duelos ligados). */
  duels?: StageDuels;
  /** @deprecated Avaliador fundido no juiz. Presente so em records antigos. */
  evaluation?: StageEvaluation;
  /** Preenchido quando a etapa falhou (datagen/imprevisto) e foi pulada. */
  error?: string;
  /** Etapa fora do placar e das médias (orçamento/cancelamento/truncamento). */
  incomplete?: boolean;
  /** Motivo do `incomplete` (IMPL-014: `truncation` = resposta cortada no teto mesmo após o retry x2). */
  incompleteReason?: StageIncompleteReason;
  /** Sinais de fim da chamada do gabarito (IMPL-014). */
  gabaritoCall?: CallFinishSignals;
  startedAt: string;
  finishedAt?: string;
}

export interface CompetitorLiveState {
  contestantId: string;
  modelId: string;
  label?: string;
  startedAt: number;
  chars: number;
  charsPerSec: number;
  preview: string;
  done: boolean;
}

export interface RunRecord {
  id: string;
  status: 'running' | 'finished' | 'error' | 'aborted';
  config: RunConfig;
  mode?: RunMode;
  contestants?: Contestant[];
  stages: StageRecord[];
  scoreboard: Record<string, number>;
  costByContestant?: Record<string, number>;
  /** Judge-score agregado por contestant: (resolve + 0.5*parcial) / total * 100. */
  judgeScoreByContestant?: Record<string, number>;
  /** n nominal × efetivo por contestant e pares com a regua (IMPL-005). */
  completeness?: RunCompleteness;
  /** Ids dos finalistas (top-N por judge-score) que disputaram os duelos. */
  finalists?: string[];
  /** Classificacao final agregada (Copeland dos duelos / pontos do placar). */
  standings?: {
    id: string;
    label: string;
    isControl: boolean;
    points: number;
    wins: number;
    ties: number;
    losses: number;
    winRate: number;
  }[];
  /** Custo TOTAL (todos os papéis), medido por `usage.cost` via ledger. */
  totalCostUsd: number;
  /** Quebra do gasto por papel do pipeline. */
  costByRole?: Record<CostRole, CostEntry>;
  /** Quantas chamadas tiveram preço exato, estimado ou desconhecido. */
  costAccuracy?: { exact: number; estimated: number; unknown: number };
  /** BYOK: cobrado pelo provedor upstream, fora dos créditos do OpenRouter. */
  upstreamCostUsd?: number;
  /** Ciclo de vida de todo modelo da run + alertas 30/14/7 dias (IMPL-019). */
  modelLifecycle?: ModelLifecycleSnapshot;
  /**
   * Teto de gasto configurado (ausente = sem limite). Em run de rodada de treino
   * (`sessionId`) é o teto da SESSÃO — a tela precisa rotulá-lo assim.
   */
  budgetUsd?: number;
  /** true = a run parou porque o orçamento acabou. */
  budgetExhausted?: boolean;
  /** Fase em que a run parou (só quando parou cedo). */
  stoppedAtPhase?: RunPhase;
  /**
   * Por que parou cedo. Discrimina o status 'aborted'. 'orphan' (IMPL-023, só
   * na SPA): a aba que executava foi fechada/recarregada/travou — o lock da run
   * (Web Locks) ficou livre com o record ainda 'running'.
   */
  stoppedReason?: 'budget' | 'cancelled' | 'orphan';
  /** Desfechos não-ok dos competidores, separados (IMPL-010): bloqueio ≠ recusa ≠ erro. */
  competitorOutcomeCounts?: { blocked: number; refused: number; error: number };
  /** Fração das chamadas de LLM da run (todos os papéis) truncadas no teto (IMPL-014); alerta acima de 2%. */
  truncationRate?: number;
  truncationCounts?: { calls: number; truncated: number };
  /** Os 4 sinais de fim agregados por papel — 100% das chamadas que completaram (IMPL-014). */
  finishSignalsByRole?: Partial<Record<CostRole, FinishSignalCounts>>;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  sessionId?: string;
  iteration?: number;
  parentRunId?: string;
}

export interface RunSummary {
  id: string;
  status: RunRecord['status'];
  mode?: RunMode;
  theme: string;
  stages: number;
  contestants?: number;
  competitors: number;
  totalCostUsd: number;
  startedAt: string;
  finishedAt?: string;
  sessionId?: string;
  iteration?: number;
}

// -------------- Contestant helpers (retrocompat: 1 ponto de verdade) --------------

export function runMode(record: RunRecord): RunMode {
  return record.mode ?? record.config?.mode ?? 'compare';
}

/** Lista de contestants do record; deriva de competitorModelIds em runs antigas. */
export function normalizeContestants(record: RunRecord): Contestant[] {
  if (record.contestants && record.contestants.length) return record.contestants;
  const ids = record.config?.competitorModelIds ?? [];
  return ids.map((id) => ({ id, label: id, modelId: id }));
}

// -------------- API key (localStorage) --------------

const KEY_STORAGE = 'openrouter_api_key';

export function getStoredKey(): string {
  return localStorage.getItem(KEY_STORAGE) ?? '';
}

export function setStoredKey(key: string): void {
  if (key) localStorage.setItem(KEY_STORAGE, key);
  else localStorage.removeItem(KEY_STORAGE);
}

function authHeaders(): Record<string, string> {
  const key = getStoredKey();
  return key ? { 'x-openrouter-key': key } : {};
}

// -------------- Calls --------------

export interface ValidateKeyResponse {
  ok: boolean;
  error?: string;
  /** Metadados retornados por GET /api/v1/key quando a key e valida. */
  label?: string;
  usageUsd?: number;
  limitUsd?: number | null;
  limitRemainingUsd?: number | null;
  isFreeTier?: boolean;
}

export async function validateKey(key: string): Promise<ValidateKeyResponse> {
  // Client-side: valida direto contra o OpenRouter (GET /key).
  const r = await engineValidateKey(key);
  if (r.ok) {
    return {
      ok: true,
      label: r.label,
      usageUsd: r.usageUsd,
      limitUsd: r.limitUsd,
      limitRemainingUsd: r.limitRemainingUsd,
      isFreeTier: r.isFreeTier,
    };
  }
  return { ok: false, error: r.error };
}

export async function fetchModels(): Promise<OpenRouterModel[]> {
  // Client-side: catálogo direto do OpenRouter (/models é público; usa a key p/ conta).
  return (await listModels(getStoredKey())) as unknown as OpenRouterModel[];
}

// -------------- Custo: estimativa e portão de confirmação (IMPL-020) --------------

/**
 * Faixa low–high + drivers da config, com o MESMO estimador que alimenta as
 * portas de orçamento do motor. Síncrona: recebe o catálogo que a tela já tem.
 */
export function estimateConfigCost(config: RunConfig, models: OpenRouterModel[]): LaunchCostEstimate {
  return estimateLaunchCost(config as never, models as never);
}

/** Recusa de iniciar: a estimativa pede um "sim" explícito (faixa alta > US$ 1). */
export class CostConfirmationRequiredError extends Error {
  readonly code = 'cost-confirmation-required' as const;
  constructor(readonly estimate: LaunchCostEstimate) {
    super(
      `Custo estimado de US$ ${estimate.low.toFixed(2)} – ${estimate.high.toFixed(2)}: confirme antes de iniciar.`,
    );
    this.name = 'CostConfirmationRequiredError';
  }
}

/**
 * Reconhece a recusa por PROPRIEDADE (mesma regra de `isControlSignal`): sob
 * ESM com instância dupla do módulo, `instanceof` daria false em silêncio.
 */
export function isCostConfirmationRequired(err: unknown): err is CostConfirmationRequiredError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'cost-confirmation-required'
  );
}

export interface LaunchOpts {
  /**
   * O usuário VIU a faixa e os drivers e confirmou. Sem isto, uma estimativa
   * acima do limiar recusa iniciar — o portão mora aqui (e não só no botão)
   * para nenhum caminho da SPA gastar acima de US$ 1 sem confirmação.
   */
  costConfirmed?: boolean;
}

async function assertCostConfirmed(config: RunConfig, opts: LaunchOpts): Promise<void> {
  if (opts.costConfirmed) return;
  // Catálogo em cache (o formulário já o carregou); indisponível => preço
  // desconhecido, que também exige confirmação.
  const models = await listModels(getStoredKey()).catch(() => []);
  const est = estimateLaunchCost(config as never, models);
  if (est.requiresConfirmation) throw new CostConfirmationRequiredError(est);
}

// -------------- Cancelamento (IMPL-020) --------------

/**
 * Cancela a run NESTA aba: aborta a raiz — o que está em voo morre, a fila do
 * limitador esvazia e nenhuma chamada nova começa. A run fecha como
 * `aborted` + `stoppedReason: 'cancelled'`, com o parcial honesto.
 */
export function cancelRun(id: string): boolean {
  return engineCancelRun(id);
}

/** Cancela o treino NESTA aba (a run da iteração em voo cai junto). */
export function cancelSession(id: string): boolean {
  return cancelTraining(id);
}

/** true = a run roda nesta aba e ainda pode ser cancelada. */
export function canCancelRun(id: string): boolean {
  return isRunCancellable(id);
}

/** true = o treino roda nesta aba e ainda pode ser cancelado. */
export function canCancelSession(id: string): boolean {
  return isTrainingCancellable(id);
}

export async function createRun(config: RunConfig, launch: LaunchOpts = {}): Promise<string> {
  // IMPL-022: persist() na PRIMEIRA run, ANTES de qualquer await — ainda dentro
  // da ativação do clique em Iniciar (o Firefox pergunta ao usuário). Memoizado
  // por página; o estado (negado inclusive) aparece na UI via storageHealth.
  void requestPersistentStorage();
  await assertCostConfirmed(config, launch);
  // Client-side: o run roda na própria aba (engine). Para variação, as variantes
  // são geradas via "optimizer" antes do loop (igual ao prepare do backend).
  const apiKey = getStoredKey();
  const cfg = config as Record<string, any>;
  const opts: Record<string, unknown> = {};
  if (cfg.mode === 'variation') {
    const optimizerModelId = cfg.optimizerModelId ?? cfg.datagenModelId;
    const promptOptimization = cfg.promptOptimization !== false;
    // `runCtx` = ledger da run: o custo do reescritor entra na conta da run.
    opts.prepare = (runCtx: RunCtx) =>
      generateContestants({
        apiKey,
        modelId: cfg.contestantModelId,
        theme: cfg.theme,
        basePrompt: cfg.basePrompt,
        originalPrompt: cfg.basePrompt,
        includeOriginal: Boolean(cfg.basePrompt && String(cfg.basePrompt).trim()),
        techniqueIds: cfg.techniqueIds,
        manualVariants: cfg.manualVariants,
        promptOptimization,
        optimizerModelId,
        reasoningLevel: cfg.reasoning?.rewriter,
        timeoutMs: cfg.timeoutMs,
        // Contratos never-break (F2/P0.3): o gate pós-rewriter vale na SPA igual.
        contracts: cfg.contracts,
        // IMPL-011: juiz do diff do contrato = 1º juiz da run (não o reescritor).
        contractJudgeModelId: cfg.judgeModelIds?.[0],
        // Verificações do contrato no MESMO raciocínio da run (juiz/competidor).
        contractJudgeReasoningLevel: cfg.reasoning?.judge,
        contestantReasoningLevel: cfg.reasoning?.competitor,
        // Multi-prompt (F2/P0.4): grupo + fragmento-alvo.
        promptGroup: cfg.promptGroup,
        promptId: cfg.promptId,
        ctx: runCtx,
      });
  }
  const { runId, record } = startRun(config as never, apiKey, opts as never);
  cacheRunRecord(record);
  return runId;
}

export async function fetchTechniques(): Promise<Technique[]> {
  return listTechniques() as unknown as Technique[];
}

/**
 * Gera um system prompt base a partir de uma descricao de tarefa (client-side).
 * Preenche o campo do prompt base no assistente — que roda como controle.
 */
export async function generateBasePrompt(
  taskDescription: string,
  modelId: string,
  theme?: string,
): Promise<string> {
  return engineGenerateBasePrompt({ apiKey: getStoredKey(), modelId, taskDescription, theme });
}

// -------------- Telemetria / subscricao ao vivo (cockpit de treino) --------------

/** Estado atual do limitador global de concorrencia (barra de paralelismo). */
export function getConcurrency(): { limit: number; active: number; queued: number } {
  return currentConcurrency();
}

/** Record vivo (em memoria) de um run — semeia a iteracao corrente na cockpit. */
export function getLiveRun(id: string): RunRecord | undefined {
  return getRunRecord(id) as unknown as RunRecord | undefined;
}

/**
 * Assina os eventos de um run vivo (sem snapshot inicial). A cockpit de treino
 * assina a iteracao corrente e NAO perde o `run.started` mesmo assinando antes
 * de ele emitir (diferente de openRunStream, que exige o record ja em memoria).
 */
export function subscribeRunLive(id: string, onEvent: (e: any) => void): () => void {
  return subscribeRun(id, onEvent as any);
}

export async function fetchLgpd(): Promise<LgpdData> {
  // Client-side: a base de conhecimento LGPD é empacotada no bundle.
  return lgpdData as unknown as LgpdData;
}

// -------------- Sessões de treino --------------

export interface SessionIterationSummary {
  iteration: number;
  runId: string;
  winnerContestantId: string;
  systemPrompt: string;
  /** Retrocompat: no de OUROS da vencedora (antes era pontos aditivos do placar). */
  score: number;
  /** Quadro de medalhas da vencedora: [0]=ouro,[1]=prata,[2]=bronze,... */
  medals?: number[];
  golds?: number;
  silvers?: number;
  bronzes?: number;
  /** Gate da iteracao com o pareamento honesto (IMPL-005). */
  gate?: IterationGate;
}

export interface SessionRecord {
  id: string;
  status: RunRecord['status'];
  config: RunConfig;
  runIds: string[];
  /** Cenarios congelados apos a iteracao 0 (benchmark pinado). */
  pinnedStages?: StageSpec[];
  bestPromptByIteration: SessionIterationSummary[];
  totalCostUsd: number;
  costByRole?: Record<CostRole, CostEntry>;
  costAccuracy?: { exact: number; estimated: number; unknown: number };
  upstreamCostUsd?: number;
  budgetUsd?: number;
  budgetExhausted?: boolean;
  stoppedAtPhase?: RunPhase;
  stoppedReason?: 'budget' | 'cancelled' | 'orphan';
  /** Iteração em que o orçamento/cancelamento interrompeu a sessão. */
  stoppedAtIteration?: number;
  /** true = o campeão NÃO passou pelo holdout (pulado): não validado contra sobreajuste. */
  holdoutSkipped?: boolean;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Gate de holdout: re-score campeao vs controle nos cenarios reservados. */
  holdout?: {
    n: number;
    controlScore: number;
    championScore: number;
    gain: number;
    regressed: boolean;
    /** IMPL-005: pares com veredito nos DOIS lados (scores sao medias SO sobre eles). */
    nEfetivo?: number;
    excludedPairs?: number;
    completeness?: number;
  };
  /**
   * Significancia estatistica: teste pareado EXATO por troca de sinais + IC por
   * inversao (IMPL-001; antes era bootstrap percentil). null = < 5 pares. Tipo
   * canonico em src/types.ts (fonte unica, sessoes antigas so tem os 4 campos base).
   */
  significance?: StoredSignificance | null;
  /** Pareamento final (IMPL-005): n nominal × efetivo, mesmo com significance null. */
  pairing?: SessionPairing;
  /** Iteracao em que o treino convergiu (ganho < minGain), quando parou antes do fim. */
  convergedAtIteration?: number;
}

/** Prompt versionado da biblioteca local no IndexedDB (nova versao a cada promocao). */
export interface SavedPrompt {
  id: string;
  name: string;
  text: string;
  version: number;
  /** Versoes anteriores (a versao corrente esta em `text`/`version`). */
  history: { version: number; text: string; savedAt: string; note?: string }[];
  /** Proveniencia do prompt. */
  origin?: {
    kind: 'training' | 'variation' | 'manual';
    sessionId?: string;
    runId?: string;
    techniqueId?: string;
    iteration?: number;
  };
  createdAt: string;
  updatedAt: string;
}

/** Pacote JSON de cenarios+gabaritos exportado ao fim da run (importavel como seed). */
export interface ScenarioPack {
  /** Escrita usa `prompt-builder-pack@1`; o nome antigo segue aceito na leitura. */
  format: 'prompt-builder-pack@1' | 'ai-benchmark-pack@1';
  theme: string;
  exportedAt: string;
  /** Prompt escolhido na exportacao (campeao ou base). */
  prompt: { text: string; source: 'champion' | 'base'; label?: string };
  scenarios: (StageSpec & { id: string })[];
}

export async function createSession(config: RunConfig, launch: LaunchOpts = {}): Promise<string> {
  void requestPersistentStorage(); // IMPL-022: ver createRun
  await assertCostConfirmed(config, launch);
  // Client-side: a sessão de treino roda na própria aba (engine trainer).
  const { sessionId, record } = await startTraining(config as never, getStoredKey());
  cacheSessionRecord(record);
  return sessionId;
}

export async function fetchSession(id: string): Promise<SessionRecord> {
  const live = getSessionRecord(id);
  if (live) {
    void cacheSession(live as unknown as SessionRecord);
    return live as unknown as SessionRecord;
  }
  const rec = await loadSession(id);
  if (!rec) throw new Error('Sessão não encontrada');
  // IMPL-023: 'running' que NÃO roda nesta aba — o lock decide se é órfã.
  if (rec.status !== 'running' || isHeldHere('session', id)) return rec as unknown as SessionRecord;
  const chk = await reconcileSession(id);
  return (chk.state === 'missing' ? rec : chk.record) as unknown as SessionRecord;
}

export interface SessionSummary {
  id: string;
  status: RunRecord['status'];
  theme: string;
  iterationsPlanned: number;
  iterationsDone: number;
  totalCostUsd: number;
  startedAt: string;
  finishedAt?: string;
}

export async function fetchSessions(): Promise<SessionSummary[]> {
  await sweepOrphansShared(); // IMPL-023: o histórico não lista treino zumbi
  return await engineListSessions<SessionSummary>();
}

export function openSessionStream(
  id: string,
  onEvent: (e: any) => void,
  _onError?: (err: Event) => void,
): () => void {
  // Client-side: assina o barramento em memória da sessão (sem SSE).
  const live = getSessionRecord(id);
  if (live) {
    onEvent({ type: 'snapshot', record: live });
    if (live.status !== 'running') return () => undefined;
    return subscribeSession(id, onEvent);
  }
  // Roda nesta aba mas o record vivo ainda não foi publicado: os eventos vêm do motor.
  if (isHeldHere('session', id)) return subscribeSession(id, onEvent);
  // IMPL-023: sem record vivo aqui — o disco é cache; o lock diz se ainda roda.
  const ctrl = new AbortController();
  void followStoredRecord<SessionRecord>(
    () => loadSession(id) as Promise<SessionRecord | null>,
    () => reconcileSession(id) as Promise<OrphanCheck<SessionRecord>>,
    () => watchSession(id, ctrl.signal) as Promise<OrphanCheck<SessionRecord> | null>,
    (rec) => onEvent({ type: 'snapshot', record: rec }),
    (state) => onEvent({ type: 'ownership', state } satisfies OwnershipEvent),
    ctrl.signal,
  );
  return () => ctrl.abort();
}

// -------------- Biblioteca de prompts (IndexedDB, client-only) --------------

// Client-side-first: estes wrappers delegam direto ao engine (promptStore,
// store 'prompts' do IndexedDB) — não há backend envolvido. O versionamento é
// por TEXTO: mudar o texto cria versão nova no history; renomear não versiona.

export async function savePrompt(input: {
  name: string;
  text: string;
  origin?: SavedPrompt['origin'];
  note?: string;
}): Promise<SavedPrompt> {
  return engineSavePrompt(input);
}

export async function updatePrompt(
  id: string,
  input: { text?: string; name?: string; note?: string },
): Promise<SavedPrompt | undefined> {
  return engineUpdatePrompt(id, input);
}

export async function getPrompt(id: string): Promise<SavedPrompt | undefined> {
  return engineGetPrompt(id);
}

export async function listPrompts(): Promise<SavedPrompt[]> {
  return engineListPrompts();
}

export async function deletePrompt(id: string): Promise<void> {
  return engineDeletePrompt(id);
}

// -------------- Pacotes de cenários (export/import JSON) --------------

// Re-exportados do engine para a UI consumir só pela porta única (api.ts).
export { buildScenarioPack, parseScenarioPack, SCENARIO_PACK_FORMAT } from './engine/scenarioPack';

/** Baixa o pacote de cenários como arquivo JSON (Blob + <a download> temporário). */
export function downloadScenarioPack(pack: ScenarioPack): void {
  const slug =
    pack.theme
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'pack';
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const ymd = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `arena-pack-${slug}-${ymd}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Lê um arquivo de pacote de cenários (input type=file). Nunca lança:
 * JSON inválido ou pacote malformado viram `{ ok: false, error }` em PT-BR.
 */
export async function readScenarioPackFile(
  file: File,
): Promise<{ ok: true; pack: ScenarioPack } | { ok: false; error: string }> {
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    return { ok: false, error: 'Arquivo não é um JSON válido' };
  }
  return parseScenarioPack(json);
}

// -------------- Arquivo de configuração do assistente (arena-config@1) --------------

// Re-exportados do engine para a UI consumir só pela porta única (api.ts).
// ATENÇÃO: `export { ... } from '...'` NÃO cria binding local neste módulo —
// por isso parseArenaConfig/ArenaConfigFile/ARENA_CONFIG_FORMAT também são
// importados no topo, para uso em readArenaConfigFile/readImportFile.
export { parseArenaConfig, arenaConfigSummary, ARENA_CONFIG_FORMAT } from './engine/configFile';
export type { ArenaConfigFile, ArenaConfigScenario } from './engine/configFile';

/**
 * Lê um arquivo de configuração do assistente Nova Run (input type=file).
 * Nunca lança: JSON inválido ou config malformada viram `{ ok: false, error }`
 * em PT-BR, para a UI exibir num banner.
 */
export async function readArenaConfigFile(
  file: File,
): Promise<{ ok: true; config: ArenaConfigFile } | { ok: false; error: string }> {
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    return { ok: false, error: 'Arquivo não é um JSON válido' };
  }
  return parseArenaConfig(json);
}

// -------------- Import unificado (um input de arquivo só) --------------

/** Resultado do import unificado de arquivo JSON do assistente. */
export type ImportedFile =
  | { kind: 'config'; config: ArenaConfigFile }
  | { kind: 'pack'; pack: ScenarioPack }
  | { kind: 'stages'; stages: StageSpec[] };

/** Teto de cenarios crus por arquivo — protege a UI de um JSON gigante. */
const MAX_IMPORTED_STAGES = 200;
/** maxTokens usado quando o cenario cru nao traz o campo (o assistente pode sobrescrever). */
const IMPORTED_STAGE_MAX_TOKENS = 500;

/** Valida um array cru de cenarios (`[{question, productContext, ...}]`). Nunca lanca. */
function parseRawStages(
  arr: unknown[],
): { ok: true; stages: StageSpec[] } | { ok: false; error: string } {
  if (arr.length === 0) return { ok: false, error: 'Forneça ao menos 1 cenário.' };
  if (arr.length > MAX_IMPORTED_STAGES)
    return { ok: false, error: `Máximo de ${MAX_IMPORTED_STAGES} cenários.` };
  const out: StageSpec[] = [];
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i] as Record<string, unknown>;
    const onde = `Cenário ${i + 1}`;
    if (!s || typeof s !== 'object' || Array.isArray(s))
      return { ok: false, error: `${onde}: deve ser um objeto.` };
    if (typeof s.question !== 'string' || !s.question.trim())
      return { ok: false, error: `${onde}: "question" obrigatória.` };
    if (typeof s.productContext !== 'string' || !s.productContext.trim())
      return { ok: false, error: `${onde}: "productContext" obrigatório.` };
    if (s.rubric !== undefined && typeof s.rubric !== 'string')
      return { ok: false, error: `${onde}: "rubric" deve ser texto.` };
    if (s.reference !== undefined && typeof s.reference !== 'string')
      return { ok: false, error: `${onde}: "reference" deve ser texto.` };
    const tokens = s.maxTokens;
    if (tokens !== undefined && (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0))
      return { ok: false, error: `${onde}: "maxTokens" deve ser número positivo.` };
    out.push({
      question: s.question.trim(),
      productContext: s.productContext.trim(),
      rubric: typeof s.rubric === 'string' && s.rubric.trim() ? s.rubric.trim() : undefined,
      reference: typeof s.reference === 'string' && s.reference.trim() ? s.reference.trim() : undefined,
      maxTokens: typeof tokens === 'number' ? Math.round(tokens) : IMPORTED_STAGE_MAX_TOKENS,
      origin: 'import',
    });
  }
  return { ok: true, stages: out };
}

/**
 * Le UM arquivo JSON e descobre sozinho o que e: `arena-config@1` (config completa),
 * `prompt-builder-pack@1`/`ai-benchmark-pack@1` (pacote de cenarios) ou um array cru de etapas
 * (`[{question, productContext, rubric?, maxTokens?, reference?}]`, ou `{stages:[…]}`).
 * NUNCA lanca: erro vira `{ ok: false, error }` em PT-BR.
 */
export async function readImportFile(
  file: File,
): Promise<{ ok: true; data: ImportedFile } | { ok: false; error: string }> {
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    return { ok: false, error: 'Arquivo não é um JSON válido' };
  }
  // Discriminador `format` primeiro: so quem nao o tem cai no array cru.
  const formato =
    json && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>).format
      : undefined;
  if (formato === ARENA_CONFIG_FORMAT) {
    const r = parseArenaConfig(json);
    // Chave descontinuada (ex.: training.halving, IMPL-012): lida e ignorada.
    if (r.ok) for (const w of r.warnings ?? []) console.warn(w);
    return r.ok ? { ok: true, data: { kind: 'config', config: r.config } } : r;
  }
  // Aceita tambem o nome legado: pacotes ja exportados pelo usuario nao podem
  // deixar de abrir por causa de uma troca de marca.
  if (formato === SCENARIO_PACK_FORMAT || formato === SCENARIO_PACK_FORMAT_LEGACY) {
    const r = parseScenarioPack(json);
    return r.ok ? { ok: true, data: { kind: 'pack', pack: r.pack } } : r;
  }
  const arr = Array.isArray(json)
    ? json
    : Array.isArray((json as { stages?: unknown } | null)?.stages)
      ? (json as { stages: unknown[] }).stages
      : null;
  if (arr) {
    const r = parseRawStages(arr);
    return r.ok ? { ok: true, data: { kind: 'stages', stages: r.stages } } : r;
  }
  return {
    ok: false,
    error:
      'Arquivo não reconhecido: esperado arena-config@1, prompt-builder-pack@1 ou um array de cenários.',
  };
}

// -------------- Cache local (IndexedDB) --------------

// IMPL-022: a UI grava pelo MESMO caminho do motor (engine/storage.ts): record +
// resumo numa transação só e falha de gravação vira evento/aviso — antes eram
// dois idbPut soltos num Promise.all, com a falha engolida dentro do idbPut.
// 'relaxed': é re-gravação de cache (o motor já fez o checkpoint 'strict').

// IMPL-023: só a aba DONA (que segura o lock) grava um record 'running'. Outra
// aba que abre a mesma run tem uma cópia velha do disco; regravá-la podia
// passar por cima do checkpoint final da dona e ressuscitar um 'running' que a
// próxima carga marcaria, por engano, como órfão.

/** Persiste uma run completa no cache local (chamado ao carregar/finalizar). */
export async function cacheRun(r: RunRecord): Promise<void> {
  if (!r?.id) return;
  if (r.status === 'running' && !isHeldHere('run', r.id)) return;
  await engineSaveRun(r as never, { durability: 'relaxed' });
}

/** Persiste uma sessão completa no cache local. */
export async function cacheSession(s: SessionRecord): Promise<void> {
  if (!s?.id) return;
  if (s.status === 'running' && !isHeldHere('session', s.id)) return;
  await engineSaveSession(s as never, { durability: 'relaxed' });
}

/**
 * "Tentar salvar de novo" do aviso de gravação: regrava o record VIVO (em
 * memória nesta aba) como checkpoint. true = salvou (o aviso some sozinho).
 */
export async function retrySave(subject: StorageSubject, id: string): Promise<boolean> {
  if (subject === 'run') {
    const live = getRunRecord(id);
    return live ? engineSaveRun(live) : false;
  }
  const live = getSessionRecord(id);
  return live ? engineSaveSession(live) : false;
}

/** Record VIVO (memória desta aba) de um item não salvo — o "Baixar JSON" do aviso. */
export function liveStorageRecord(subject: StorageSubject, id: string): RunRecord | SessionRecord | undefined {
  return (subject === 'run' ? getRunRecord(id) : getSessionRecord(id)) as unknown as
    | RunRecord
    | SessionRecord
    | undefined;
}

// Estado do armazenamento local (persistência + gravações que falharam) — a UI
// consome pela porta única; a regra mora em storageHealth.ts.
export type {
  PersistState,
  StorageHealth,
  StorageIssue,
  StorageNotice,
  StorageSubject,
} from './storageHealth';
export {
  estimateStorage,
  getStorageHealth,
  refreshPersistState,
  requestPersistentStorage,
  storageNoticeContent,
  subscribeStorageHealth,
} from './storageHealth';

export async function fetchRuns(): Promise<RunSummary[]> {
  await sweepOrphansShared(); // IMPL-023: o histórico não lista run zumbi
  return await engineListRuns<RunSummary>();
}

export async function fetchRun(id: string): Promise<RunRecord> {
  const live = getRunRecord(id);
  if (live) {
    void cacheRun(live as unknown as RunRecord);
    return live as unknown as RunRecord;
  }
  const rec = await loadRun(id);
  if (!rec) throw new Error('Run nao encontrada');
  // IMPL-023: 'running' que NÃO roda nesta aba — o lock decide se é órfã
  // (recarregar no meio da run reabre aborted/orphan, sem intervenção).
  if (rec.status !== 'running' || isHeldHere('run', id)) return rec as unknown as RunRecord;
  const chk = await reconcileRun(id);
  return (chk.state === 'missing' ? rec : chk.record) as unknown as RunRecord;
}

export function openRunStream(
  id: string,
  onEvent: (e: any) => void,
  _onError?: (err: Event) => void,
): () => void {
  // Client-side: assina o barramento em memória do run (sem SSE). Snapshot
  // imediato do record vivo + eventos subsequentes; se já terminou, snapshot +
  // evento terminal a partir do IndexedDB.
  const live = getRunRecord(id);
  if (live) {
    onEvent({ type: 'snapshot', record: live });
    if (live.status !== 'running') return () => undefined;
    return subscribeRun(id, onEvent);
  }
  // Roda nesta aba mas o record vivo ainda não foi publicado: os eventos vêm do motor.
  if (isHeldHere('run', id)) return subscribeRun(id, onEvent);
  // IMPL-023: sem record vivo aqui — o disco é cache; o lock diz se ainda roda.
  const ctrl = new AbortController();
  const emitRecord = (rec: RunRecord): void => {
    onEvent({ type: 'snapshot', record: rec });
    if (rec.status === 'error') {
      onEvent({ type: 'run.error', runId: id, error: rec.error ?? 'Run terminou com erro.' });
    } else if (rec.status !== 'running') {
      onEvent({ type: 'run.finished', runId: id, record: rec });
    }
  };
  void followStoredRecord<RunRecord>(
    () => loadRun(id) as Promise<RunRecord | null>,
    () => reconcileRun(id) as Promise<OrphanCheck<RunRecord>>,
    () => watchRun(id, ctrl.signal) as Promise<OrphanCheck<RunRecord> | null>,
    emitRecord,
    (state) => onEvent({ type: 'ownership', state } satisfies OwnershipEvent),
    ctrl.signal,
  );
  return () => ctrl.abort();
}

// -------------- Runs de outra aba e órfãs (IMPL-023, Web Locks) --------------

/**
 * Evento SÓ da UI (não vem do motor): a run/sessão 'running' aberta nesta tela
 * não roda nesta aba. `elsewhere` = outra aba segura o lock (a tela mostra o
 * último salvamento e se atualiza sozinha no fim); `unsupported` = navegador
 * sem Web Locks — não dá para saber se ainda roda (a UI oferece marcar como
 * interrompida).
 */
export interface OwnershipEvent {
  type: 'ownership';
  state: 'elsewhere' | 'unsupported';
}

/**
 * Record lido do disco (não roda nesta aba): se está 'running', o lock decide —
 * órfã vira aborted(orphan) na hora; com dono vivo, espera o dono soltar (fim
 * da run OU morte da aba dela) e publica o record final. Sem polling, sem
 * heartbeat: a espera é a fila do próprio Web Locks.
 */
async function followStoredRecord<R extends { status: string }>(
  load: () => Promise<R | null>,
  reconcile: () => Promise<OrphanCheck<R>>,
  watch: () => Promise<OrphanCheck<R> | null>,
  emit: (rec: R) => void,
  ownership: (state: OwnershipEvent['state']) => void,
  signal: AbortSignal,
): Promise<void> {
  try {
    const rec = await load();
    if (signal.aborted || !rec) return;
    if (rec.status !== 'running') {
      emit(rec);
      return;
    }
    const chk = await reconcile();
    if (signal.aborted || chk.state === 'missing') return;
    emit(chk.record);
    if (chk.state === 'unsupported') ownership('unsupported');
    if (chk.state !== 'alive') return;
    ownership('elsewhere');
    const fim = await watch();
    if (signal.aborted || !fim || fim.state === 'missing') return;
    emit(fim.record);
  } catch (err) {
    console.warn('[locks] falha ao acompanhar record salvo:', err);
  }
}

let sweepEmVoo: Promise<SweepResult | null> | null = null;

/** Uma varredura por vez nesta aba (a lista de runs e a de sessões pedem juntas). */
function sweepOrphansShared(): Promise<SweepResult | null> {
  sweepEmVoo ??= sweepOrphans()
    .catch((err: unknown) => {
      console.warn('[locks] varredura de órfãs falhou:', err);
      return null;
    })
    .finally(() => {
      sweepEmVoo = null;
    });
  return sweepEmVoo;
}

let orphanWatchStarted = false;

/**
 * Chamado UMA vez na carga da página (main.tsx): marca as órfãs sem ninguém
 * precisar abrir a run e deixa esta aba esperando na fila do lock das runs que
 * rodam em OUTRAS abas — se uma delas for fechada, a run vira órfã na hora.
 */
export function startOrphanWatch(): void {
  if (orphanWatchStarted) return;
  orphanWatchStarted = true;
  void sweepOrphansShared().then((r) => {
    if (!r) return;
    for (const id of r.aliveRuns) void watchRun(id).catch(() => undefined);
    for (const id of r.aliveSessions) void watchSession(id).catch(() => undefined);
  });
}

/**
 * Sem Web Locks não há detecção automática: o usuário marca a run como
 * interrompida (a aba que a executava já foi fechada). Com Web Locks só marca
 * se o lock estiver livre — nunca derruba uma run viva.
 */
export async function markRunInterrupted(id: string): Promise<RunRecord | null> {
  const chk = await engineMarkRunInterrupted(id);
  return chk.state === 'missing' ? null : (chk.record as unknown as RunRecord);
}

/** Idem para uma sessão de treino. */
export async function markSessionInterrupted(id: string): Promise<SessionRecord | null> {
  const chk = await engineMarkSessionInterrupted(id);
  return chk.state === 'missing' ? null : (chk.record as unknown as SessionRecord);
}
