// ARTEFATO DE REPRODUÇÃO/AUDITORIA de runs (§8.8 do PLANO-PARIDADE).
//
// Dois recursos de operação compartilham a mesma matéria-prima — o `RunRecord`
// salvo em disco — e por isso moram juntos aqui, longe do CLI:
//
//   • `runs reproduce` — reconstrói o config equivalente ao da run salva e a
//     linha de comando EXATA para re-rodá-la;
//   • `runs export`    — emite UM artefato auto-contido (`prompt-builder-run@1`)
//     com config, cenários+gabaritos, system prompts e vereditos do juiz: tudo
//     que se precisa para auditar/reproduzir sem o disco original.
//
// Tudo aqui é PURO (recebe o record, devolve estrutura) — os testes
// (`test/cli-ops.test.ts`) cobrem sem tocar em filesystem.
//
// ⚠️ DOIS DIALETOS DE CONFIG, UM ARTEFATO CADA:
//   • `config` (RunConfig)      — a fonte de verdade LOSSLESS. É o que
//     `parseRunConfig` valida (critério de aceite) e o que o `--config` do CLI
//     re-executa quando o arquivo não tem `format`. Guarda tudo que o
//     arena-config@1 não expressa (budgetUsd, maxPricePerMTok, temperature,
//     customStages com `expected`, `agent`, contratos sem prompt base…).
//   • `arenaConfig` (arena-config@1) — a mesma config no dialeto declarativo
//     documentado (`docs config`), para leitura humana e interoperabilidade.
//     É o "arena-config@1 equivalente" da tarefa; a conversão de volta
//     (arenaConfigToRunConfig) é SEMPRE validada pelos testes.
// A vista arena tem mapeamento inerentemente lossy (ex.: `scenarios` vira
// `scenarioSeed`, não `customStages`) — quem re-rodar com fidelidade total deve
// salvar o `config`, não o `arenaConfig`.

import type {
  Contestant,
  RunConfig,
  RunMode,
  RunRecord,
  StageSpec,
  Verdict,
} from './types.js';
import {
  ARENA_CONFIG_FORMAT,
  type ArenaConfigFile,
  type ArenaConfigScenario,
} from './configFile.js';

// ----------------------------------------------------------------------------
// runs export — artefato auto-contido
// ----------------------------------------------------------------------------

/** Valor do campo `format` do artefato exportado. */
export const RUN_ARTIFACT_FORMAT = 'prompt-builder-run@1';

/** Contestante resumido: identidade + o system prompt que realmente competiu. */
export interface RunArtifactContestant {
  id: string;
  label: string;
  modelId: string;
  systemPrompt?: string;
  techniqueId?: string;
  isOriginal?: boolean;
}

/** Vereditos de UMA etapa (por contestant), para auditoria sem o disco. */
export interface RunArtifactJudgeStage {
  stageIndex: number;
  /** Veredito ternário por contestant (pointwise vs gabarito quando houver). */
  verdictByContestant?: Record<string, Verdict>;
  /** Consenso do juiz: melhor -> pior (quando houve julgamento listwise). */
  rankedContestantIds?: string[];
}

export interface RunArtifact {
  format: typeof RUN_ARTIFACT_FORMAT;
  exportedAt: string;
  /** O record inteiro — custo, placar, lineage, tudo. */
  record: RunRecord;
  /** Specs das etapas executadas (com gabaritos `reference`). */
  stages: StageSpec[];
  /** System prompts dos contestants (o "o que" foi medido). */
  contestants: RunArtifactContestant[];
  judge: {
    judgeModelIds: string[];
    verdictsPorEtapa: RunArtifactJudgeStage[];
  };
}

/**
 * Monta o artefato auto-contido de uma run. Puro: `exportedAt` é injetável para
 * teste determinístico.
 */
export function buildRunArtifact(record: RunRecord, exportedAt = new Date().toISOString()): RunArtifact {
  const stages = record.stages
    .map((s) => s.spec)
    .filter((s): s is StageSpec => s !== undefined);

  const contestants: RunArtifactContestant[] = record.contestants.map((c: Contestant) => ({
    id: c.id,
    label: c.label,
    modelId: c.modelId,
    ...(c.systemPrompt !== undefined ? { systemPrompt: c.systemPrompt } : {}),
    ...(c.techniqueId !== undefined ? { techniqueId: c.techniqueId } : {}),
    ...(c.isOriginal !== undefined ? { isOriginal: c.isOriginal } : {}),
  }));

  const verdictsPorEtapa: RunArtifactJudgeStage[] = record.stages.map((s) => {
    // Preferir o veredito pointwise vs gabarito (o que de fato virou judge-score
    // em variation/training); cair para o consenso listwise em etapa sem gabarito.
    const verdictByContestant =
      s.referenceJudge?.verdictByContestant ?? s.judge?.verdictByContestant;
    return {
      stageIndex: s.index,
      ...(verdictByContestant ? { verdictByContestant } : {}),
      ...(s.judge?.rankedContestantIds?.length
        ? { rankedContestantIds: s.judge.rankedContestantIds }
        : {}),
    };
  });

  return {
    format: RUN_ARTIFACT_FORMAT,
    exportedAt,
    record,
    stages,
    contestants,
    judge: {
      judgeModelIds: [...record.config.judgeModelIds],
      verdictsPorEtapa,
    },
  };
}

// ----------------------------------------------------------------------------
// runs reproduce — config reconstruído + comando sugerido
// ----------------------------------------------------------------------------

/** Nome do comando do CLI por modo de run. */
export function commandForMode(mode: RunMode): 'compare' | 'vary' | 'train' {
  return mode === 'compare' ? 'compare' : mode === 'variation' ? 'vary' : 'train';
}

/** Nome de arquivo sugerido para o config exportado pela reprodução. */
export function configFileForRun(runId: string): string {
  return `run-${runId}.config.json`;
}

/** Linha de comando EXATA para re-rodar (o `--budget` é obrigatório fora de TTY). */
export function suggestedReproduceCommand(
  mode: RunMode,
  configFile: string,
  budgetUsd: number | undefined,
): string {
  const budget = budgetUsd !== undefined ? String(budgetUsd) : 'none';
  return `prompt-builder ${commandForMode(mode)} --config ${configFile} --budget ${budget}`;
}

/**
 * Reconstrói o RunConfig equivalente ao da run salva.
 *
 * Cópia profunda do `record.config` SEM whitelist de campos: um whitelist aqui
 * seria o terceiro silenciador de campo novo do repo (irmão de
 * `normalizeRunRecord` e `variationConfigFrom`, ver AGENTS.md) — cada campo que
 * faltasse sumiria da reprodução em silêncio. O que se normaliza é só chaves com
 * valor `undefined`, que não sobrevivem ao JSON e sujariam a comparação
 * "campo ausente => campo ausente" de quem audita o artefato.
 */
export function rebuildRunConfig(record: RunRecord): RunConfig {
  const clone = structuredClone(record.config) as unknown as Record<string, unknown>;
  for (const key of Object.keys(clone)) {
    if (clone[key] === undefined) delete clone[key];
  }
  return clone as unknown as RunConfig;
}

function stageSpecToScenario(spec: StageSpec): ArenaConfigScenario {
  return {
    question: spec.question,
    productContext: spec.productContext,
    maxTokens: spec.maxTokens,
    ...(spec.rubric ? { rubric: spec.rubric } : {}),
    ...(spec.reference ? { reference: spec.reference } : {}),
    ...(spec.expected !== undefined ? { expected: spec.expected } : {}),
  };
}

/**
 * Vista `arena-config@1` do config — o dialeto declarativo que o assistente
 * Nova Run e `docs config` documentam. Lossy por construção (ver cabeçalho do
 * arquivo); o `config` (RunConfig) segue sendo a fonte de verdade.
 */
export function runConfigToArenaConfig(config: RunConfig): ArenaConfigFile {
  const models: ArenaConfigFile['models'] = {
    datagen: config.datagenModelId,
    judges: [...config.judgeModelIds],
    ...(config.referenceModelId ? { reference: config.referenceModelId } : {}),
    ...(config.optimizerModelId ? { rewriter: config.optimizerModelId } : {}),
  };
  if (config.mode === 'compare') {
    if (config.competitorConfigs?.length) {
      models.competitorConfigs = config.competitorConfigs.map((c) => ({
        model: c.modelId,
        ...(c.temperature !== undefined ? { temperature: c.temperature } : {}),
        ...(c.reasoningLevel ? { reasoning: c.reasoningLevel } : {}),
      }));
    } else {
      models.competitors = [...(config.competitorModelIds ?? [])];
    }
  } else {
    models.contestant = config.contestantModelId;
  }

  const arena: ArenaConfigFile = {
    format: ARENA_CONFIG_FORMAT,
    mode: config.mode,
    theme: config.theme,
    models,
  };

  if (config.scenarioBrief) arena.scenarioBrief = config.scenarioBrief;
  arena.stages = config.stages;

  // Cenários pinados: `customStages` (o que de fato rodou) tem prioridade sobre
  // `scenarioSeed`. Na volta viram `scenarioSeed` — ver o aviso do cabeçalho.
  const pinados = config.customStages?.length ? config.customStages : config.scenarioSeed;
  if (pinados?.length) arena.scenarios = pinados.map(stageSpecToScenario);

  // Prompt base + contratos never-break (no arena-config os contratos vivem no
  // perfil do prompt, que exige `prompt.text`). Sem prompt base a vista arena
  // não os expressa — o `config` (fonte de verdade) os preserva.
  const basePrompt = config.mode === 'compare' ? undefined : config.basePrompt;
  if (basePrompt?.trim()) {
    arena.prompt = {
      text: basePrompt.trim(),
      ...(config.contracts ? { contracts: config.contracts } : {}),
    };
  }

  const effort: NonNullable<ArenaConfigFile['effort']> = {};
  if (config.reasoning?.competitor) effort.competitor = config.reasoning.competitor;
  if (config.reasoning?.judge) effort.judge = config.reasoning.judge;
  if (config.reasoning?.rewriter) effort.rewriter = config.reasoning.rewriter;
  if (config.reasoning?.datagen) effort.datagen = config.reasoning.datagen;
  if (Object.keys(effort).length) arena.effort = effort;

  if (config.mode !== 'compare') {
    const optimize = config.promptOptimization !== false;
    arena.variation = {
      optimize,
      ...(optimize
        ? config.techniqueIds?.length
          ? { techniques: [...config.techniqueIds] }
          : {}
        : config.manualVariants?.length
          ? { manualVariants: config.manualVariants.map((v) => ({ ...v })) }
          : {}),
    };
  }

  if (config.mode === 'training') {
    arena.training = {
      ...(config.iterations !== undefined ? { iterations: config.iterations } : {}),
      ...(config.minGain !== undefined ? { minGain: config.minGain } : {}),
      ...(config.holdoutRatio !== undefined ? { holdoutRatio: config.holdoutRatio } : {}),
      ...(config.feedbackDriven !== undefined ? { feedbackDriven: config.feedbackDriven } : {}),
    };
  }

  const judging: NonNullable<ArenaConfigFile['judging']> = {};
  if (config.referenceJudging !== undefined) judging.reference = config.referenceJudging;
  if (config.judgePasses !== undefined) judging.passes = config.judgePasses;
  if (Object.keys(judging).length) arena.judging = judging;

  const limits: NonNullable<ArenaConfigFile['limits']> = {};
  if (config.maxOutputTokens !== undefined) limits.maxOutputTokens = config.maxOutputTokens;
  if (config.timeoutMs !== undefined) limits.timeoutMs = config.timeoutMs;
  if (config.concurrency !== undefined) limits.concurrency = config.concurrency;
  if (Object.keys(limits).length) arena.limits = limits;

  if (config.duels !== undefined) arena.duels = config.duels;
  if (config.finalists !== undefined) arena.finalists = config.finalists;
  if (config.compliance) arena.compliance = { ...config.compliance };
  // LGPD (IMPL-042): sem isto uma run "só sintético" reproduzida pelo dialeto
  // arena voltava ao "redigir" (e a revisão `allowPii` se perdia).
  if (config.piiMode) arena.piiMode = config.piiMode;
  if (config.allowPii) arena.allowPii = true;

  return arena;
}

export interface ReproduceArtifact {
  runId: string;
  /** RunConfig lossless — o que se salva em arquivo para re-rodar com fidelidade. */
  config: RunConfig;
  /** A mesma config no dialeto arena-config@1 (leitura humana/interop; lossy). */
  arenaConfig: ArenaConfigFile;
  suggestedCommand: string;
}

/**
 * Monta o payload do `runs reproduce`: config reconstruído + comando sugerido.
 * Puro — o CLI só imprime.
 */
export function buildReproduceArtifact(record: RunRecord): ReproduceArtifact {
  const config = rebuildRunConfig(record);
  // O teto vale para a run inteira: prioriza o do config (o que a run declarou);
  // `record.budgetUsd` cobre records antigos que o guardavam só no envelope.
  const budgetUsd = config.budgetUsd ?? record.budgetUsd;
  return {
    runId: record.id,
    config,
    arenaConfig: runConfigToArenaConfig(config),
    suggestedCommand: suggestedReproduceCommand(
      config.mode,
      configFileForRun(record.id),
      budgetUsd,
    ),
  };
}
