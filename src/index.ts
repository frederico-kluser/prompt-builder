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
} from './modelCaps.js';
export type { ModelCaps, ModelExportRow, ThinkLevels } from './modelCaps.js';

export { ensureCatalog, clearCatalog, catalogPath } from './modelsCache.js';
export {
  listModels,
  getModel,
  validateKey,
  computeCost,
  chatCompletion,
  chatCompletionStream,
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
} from './openrouter.js';
export type { GatewayConfig, FetchLike, LimiterSnapshot, UsageInfo } from './openrouter.js';
export { gatewayConfigFromEnv, configureGatewayFromEnv } from './gatewayEnv.js';
export type { ChatCompletionParams, ChatCompletionResult, KeyInfo } from './openrouter.js';

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
