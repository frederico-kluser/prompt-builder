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
    // `runCtx` = contexto DA RUN (ledger da run + sinal): e ele que faz o custo
    // do reescritor entrar no ledger. `options.ctx` so cobre chamadores antigos.
    prepare: (runCtx?: RunCtx) =>
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
        ctx: runCtx ?? options.ctx,
        // Contratos never-break (F2/P0.3) valem para a run variation solta,
        // igual ao treino — senão o modo variation escaparia do gate.
        contracts: cfg.contracts,
        // IMPL-011: juiz do diff do contrato = 1º juiz da run (não o reescritor).
        contractJudgeModelId: cfg.judgeModelIds?.[0],
        // Verificações do contrato no MESMO raciocínio da run (juiz/competidor).
        contractJudgeReasoningLevel: cfg.reasoning?.judge,
        contestantReasoningLevel: cfg.reasoning?.competitor,
        // Multi-prompt (F2/P0.4): grupo + fragmento-alvo.
        promptGroup: cfg.promptGroup,
        promptId: cfg.promptId,
        // Teto por requisição idem ao trainer (sem isto a run variation ignora
        // o maxPricePerMTok do config em silêncio).
        maxPricePerMTok: cfg.maxPricePerMTok,
        // IMPL-066: `targetModel` fica de fora DE PROPÓSITO — o variator lê as
        // capacidades do catálogo em cache (o orchestrator o aquece antes do
        // `prepare`). IMPL-061: `labeledScenarios` também: na variation TODO
        // cenário é avaliado, então uma demo tirada deles daria ao few-shot o
        // gabarito de parte do próprio placar (não há seleção de onde tirá-la,
        // como o leave-demos-out do treino). Aqui a técnica decai sem inventar.
      }),
  };
}
