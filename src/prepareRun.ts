// Monta os StartRunOpts corretos para cada modo.
//
// ARMADILHA que este modulo existe para eliminar: no modo `variation`, quem
// gera as variantes de prompt NAO e o orquestrador — e uma closure `prepare`
// que morava so dentro da rota POST /runs. Chamar
// `runToCompletion(variationCfg, key)` sem ela produz uma run com ZERO
// contestants e NENHUM erro. Servidor e CLI agora passam pelo mesmo lugar.

import type { StartRunOpts } from './orchestrator.js';
import { generateContestants } from './variator.js';
import type { RunConfig, RunCtx } from './types.js';

export interface PrepareRunOptions {
  /** Encadeado nos opts resultantes (sinal de abort + ledger de custo). */
  ctx?: RunCtx;
  /** Id pre-gerado — permite assinar o bus de eventos ANTES de a run comecar. */
  runId?: string;
}

/**
 * Opcoes de start para `startRun`/`runToCompletion`. Em `variation` injeta o
 * `prepare` que gera as variantes; nos outros modos nao ha nada a preparar
 * (compare deriva contestants do proprio config; training e montado no trainer).
 */
export function prepareOptsFor(
  cfg: RunConfig,
  apiKey: string,
  options: PrepareRunOptions = {},
): StartRunOpts {
  const base: StartRunOpts = {};
  if (options.runId) base.runId = options.runId;
  if (options.ctx) base.ctx = options.ctx;

  if (cfg.mode !== 'variation') return base;

  const optimizerModelId = cfg.optimizerModelId ?? cfg.datagenModelId;
  const promptOptimization = cfg.promptOptimization !== false;
  return {
    ...base,
    prepare: () =>
      generateContestants({
        apiKey,
        // F5: em modo agente (config.agent presente), as variantes de uma run
        // variation com agente também rodam como 'agent' — sem isso o variator
        // geraria contestants sem runner (= chat). O trainer ja passa o mesmo.
        runner: cfg.agent ? 'agent' : undefined,
        modelId: cfg.contestantModelId,
        theme: cfg.theme,
        basePrompt: cfg.basePrompt,
        originalPrompt: cfg.basePrompt,
        includeOriginal: Boolean(cfg.basePrompt && cfg.basePrompt.trim()),
        techniqueIds: cfg.techniqueIds,
        manualVariants: cfg.manualVariants,
        promptOptimization,
        optimizerModelId,
        reasoningLevel: cfg.reasoning?.rewriter,
        timeoutMs: cfg.timeoutMs,
        ctx: options.ctx,
      }),
  };
}
