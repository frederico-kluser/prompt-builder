// API de biblioteca do `prompt-builder`.
//
// Tudo aqui roda sem servidor: `runToCompletion` e `trainToCompletion` executam
// o pipeline inteiro em processo. Quem importa isto assume duas
// responsabilidades que o CLI cumpre por conta propria:
//
//   1. `setDataDir()` antes do primeiro save (senao grava em `./data`);
//   2. `ensureCatalog()` antes da primeira chamada de LLM — com o catalogo frio,
//      o custo sai 0 e o esforco de raciocinio vai sem encaixe na allowlist.
//
// O gateway de LLM e configurado a partir do ambiente (OPENROUTER_BASE_URL,
// OPENROUTER_APP_URL, OPENROUTER_APP_TITLE, OPENROUTER_MAX_CONCURRENCY) no
// IMPORT deste modulo — o mesmo comportamento de quando `openrouter.ts` lia o
// processo direto. Quem quiser outra config chama `configureGateway` depois.

import { configureGatewayFromEnv } from './gatewayEnv.js';

configureGatewayFromEnv();

export { runToCompletion, startRun } from './orchestrator.js';
export type { StartRunOpts, StartRunResult } from './orchestrator.js';
export { startTraining, trainToCompletion } from './trainer.js';
export type { StartTrainingOpts, StartTrainingResult } from './trainer.js';

export { prepareOptsFor } from './prepareRun.js';
export { parseRunConfig, runConfigSchema } from './runConfigSchema.js';
export { parseArenaConfig, arenaConfigSummary, ARENA_CONFIG_FORMAT } from './configFile.js';
export type { ArenaConfigFile, ArenaConfigScenario } from './configFile.js';
export { arenaConfigToRunConfig } from './arenaConfig.js';

export {
  BudgetLedger,
  BudgetExceeded,
  RunCancelled,
  isControlSignal,
  isBudgetSignal,
} from './budget.js';
export type { BudgetSnapshot } from './budget.js';

export {
  estimateRunCost,
  estimateInputFromConfig,
  makeCallEstimator,
  toPerMTok,
  toPerToken,
} from './estimate.js';
export type { CostEstimate, EstimateInput } from './estimate.js';

export {
  modelCaps,
  effortOptions,
  thinkLevelsFor,
  toExportRow,
  MODELS_EXPORT_FORMAT,
  reasoningForRole,
  reasoningLevelForRole,
  REASONING_ROLE_DEFAULT,
} from './modelCaps.js';
export type { ModelCaps, ModelExportRow, ThinkLevels, JudgingRole } from './modelCaps.js';

export { ensureCatalog, clearCatalog, catalogPath } from './modelsCache.js';
export {
  listModels,
  getModel,
  validateKey,
  computeCost,
  chatCompletion,
  chatCompletionStream,
  pseudonymize,
  primeModelsCache,
  peekModelsCache,
  currentConcurrency,
  // Gateway unico com configuracao injetada (IMPL-021).
  OpenRouterGateway,
  AimdLimiter,
  createGateway,
  getGateway,
  configureGateway,
  setDefaultGateway,
  extractUsage,
  priceUsage,
  DEFAULT_OPENROUTER_BASE_URL,
  // Taxonomia bloqueio/recusa/erro (IMPL-010): 403 de moderacao nao e key.
  GatewayError,
  gatewayErrorKind,
  isGatewayBlocked,
  classifyHttpError,
} from './openrouter.js';
export type {
  GatewayConfig,
  FetchLike,
  LimiterSnapshot,
  UsageInfo,
  GatewayBlock,
  GatewayErrorKind,
} from './openrouter.js';

// Dado pessoal PT-BR (IMPL-042): a cascata que o gateway aplica em toda chamada.
export {
  scanPii,
  assessPii,
  checkImportPii,
  checkRunPii,
  assertRunPii,
  runPiiRefusal,
  runPiiMessage,
  summarizeRunPii,
  isPiiPolicyError,
  createPiiGuard,
  PiiGuard,
  PiiVault,
  PII_COVERAGE,
  PII_MODES,
  isValidCpf,
  isValidCnpj,
  isValidCns,
} from './engine/pii.js';
export type {
  PiiFinding,
  PiiKind,
  PiiMode,
  PiiImportCheck,
  PiiGuardStats,
  PiiFieldReport,
  PiiRunReport,
} from './engine/pii.js';
export { gatewayConfigFromEnv, configureGatewayFromEnv } from './gatewayEnv.js';
export type { ChatCompletionParams, ChatCompletionResult, KeyInfo } from './openrouter.js';

// Saturação por item (IMPL-112) e relatório da geração de cenários
// (web-live#7): o MESMO cálculo que a run grava em `record.itemSaturation` /
// `record.datagenReport` — quem consome a biblioteca audita records antigos ou
// monta a fila de revisão de gabarito sem reimplementar a régua.
export {
  itemSaturationReport,
  gabaritoReviewQueue,
  assertIrtSampleSize,
  IrtSampleSizeError,
  DEFAULT_SATURATION_MIN_EXECUTIONS,
  IRT_MIN_CONTESTANTS,
  rubricAnswerability,
  describeDatagenShortfall,
  DATAGEN_MAX_BACKFILL_ROUNDS,
} from './datagen.js';
export type {
  ItemSaturationReport,
  ItemSaturationRow,
  ItemSaturationCell,
  ItemSaturationClass,
  ItemSaturationStage,
  DatagenReport,
} from './datagen.js';

export { REASONING_LEVELS, fitEffort, applyReasoning, coerceLevel } from './reasoning.js';
export { listTechniques, getTechnique } from './techniques.js';
export { subscribe, subscribeSession } from './events.js';
export {
  setDataDir,
  getDataDir,
  loadRun,
  listRuns,
  loadSession,
  listSessions,
} from './storage.js';
export type { RunSummary, SessionSummary } from './storage.js';

export * from './types.js';
