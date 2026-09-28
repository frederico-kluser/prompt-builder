// Traducao `arena-config@1` -> `RunConfig`.
//
// Ate agora essa traducao nao existia como codigo reusavel: eram dois saltos
// por React (`applyArenaConfig` -> estado do componente -> `submit()` em
// web/src/pages/NewRun.tsx). O CLI precisa dela, e escreve-la aqui e melhor do
// que duplicar — a tela pode passar a chamar esta funcao e apagar a logica.
//
// O `arena-config@1` descreve o ESTADO DO ASSISTENTE (esforco POR MODELO,
// modelos por papel, toggles), enquanto o `RunConfig` e o contrato do motor
// (esforco POR PAPEL). As regras nao-obvias da conversao estao comentadas
// abaixo, cada uma marcando o que se perde se ela for esquecida.

import { parseRunConfig } from './runConfigSchema.js';
import type { ArenaAgentConfigFile, ArenaConfigFile } from './configFile.js';
import type { ReasoningConfig, RunConfig, StageSpec } from './types.js';

/** Defaults da UI, aplicados quando o arquivo omite o campo. */
export interface ArenaConfigDefaults {
  stages?: number;
  iterations?: number;
  finalists?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  concurrency?: number;
}

const DEFAULTS: Required<ArenaConfigDefaults> = {
  stages: 5,
  iterations: 3,
  finalists: 3,
  maxOutputTokens: 500,
  timeoutMs: 60_000,
  concurrency: 8,
};

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

/**
 * Referência à biblioteca de cenários do config (`scenarios.from: 'library'`),
 * quando presente. A RESOLUÇÃO é assíncrona e vive no CLI (fs em
 * `<data-dir>/library/<profile>/`): quem chama carrega os itens, RECUSA os sem
 * gabarito (paridade com o 409 do prompt-arena) e vira `customStages`.
 */
export function libraryRefFrom(
  file: ArenaConfigFile,
): { profile: string; ids?: string[] } | undefined {
  const s = file.scenarios;
  if (Array.isArray(s) || !s) return undefined;
  return { profile: s.profile, ids: s.ids };
}

export type ArenaConfigToRunConfigResult =
  | { ok: true; config: RunConfig }
  | { ok: false; error: string };

export function arenaConfigToRunConfig(
  file: ArenaConfigFile,
  overrides: ArenaConfigDefaults = {},
): ArenaConfigToRunConfigResult {
  const d = { ...DEFAULTS, ...overrides };
  const maxOutputTokens = Math.max(50, file.limits?.maxOutputTokens ?? d.maxOutputTokens);

  // Cenarios pinados viram `scenarioSeed` — sem o `id` (o motor re-rotula) e
  // herdando `maxTokens` do limite global quando o arquivo nao especifica.
  // `scenarios` tambem pode ser uma REFERENCIA a biblioteca (F1/P0.1): ela e
  // resolvida pelo CLI (filesystem) via `libraryRefFrom` + `customStages` —
  // aqui so a forma de LISTA vira seed.
  const pinados = Array.isArray(file.scenarios) ? file.scenarios : [];
  const scenarioSeed: StageSpec[] = pinados.map((s) => ({
    question: s.question,
    productContext: s.productContext ?? '',
    maxTokens: s.maxTokens && s.maxTokens > 0 ? s.maxTokens : maxOutputTokens,
    ...(s.rubric ? { rubric: s.rubric } : {}),
    ...(s.reference ? { reference: s.reference } : {}),
    ...(s.expected !== undefined ? { expected: s.expected } : {}),
    // Sem esta linha o labelSet sumiria na tradução e o parseRunConfig abaixo
    // recusaria o cenário de rótulo curto (IMPL-003) — whitelist campo a campo.
    ...(s.labelSet !== undefined ? { labelSet: s.labelSet } : {}),
    origin: 'import' as const,
  }));

  // `stages` nunca pode ser menor que o numero de cenarios pinados, senao parte
  // da curadoria do usuario ficaria de fora (o motor so completa o que falta).
  const stages = clamp(Math.max(file.stages ?? d.stages, scenarioSeed.length), 1, 50);

  // Esforco POR PAPEL. ⚠️ O juiz cai para o esforco do modelo de REFERENCIA
  // quando nao tem o proprio: no motor, juiz e gabarito compartilham
  // `reasoning.judge`, entao sem esse fallback o ajuste do gabarito sumiria.
  const reasoning: ReasoningConfig = {};
  if (file.effort?.competitor) reasoning.competitor = file.effort.competitor;
  const judgeEffort = file.effort?.judge;
  if (judgeEffort) reasoning.judge = judgeEffort;
  if (file.effort?.datagen) reasoning.datagen = file.effort.datagen;
  if (file.effort?.rewriter) reasoning.rewriter = file.effort.rewriter;

  // `duels`/`finalists` moram na raiz, mas arquivos antigos os punham dentro de
  // `training` — a raiz vence.
  const duelsOn = file.duels ?? file.training?.duels ?? true;
  const finalists = clamp(Math.round(file.finalists ?? file.training?.finalists ?? d.finalists), 0, 12);
  const semFinais = !duelsOn || finalists === 0;

  // `referenceJudging` vai SEMPRE explicito: o default muda por modo/eixo, e
  // deixa-lo implicito faria o arquivo significar coisas diferentes por modo.
  const referenceJudging =
    file.judging?.reference ??
    (file.mode !== 'compare' || Boolean(file.models.competitorConfigs?.length));

  const common = {
    theme: file.theme.trim(),
    stages,
    datagenModelId: file.models.datagen,
    judgeModelIds: file.models.judges,
    concurrency: clamp(Math.round(file.limits?.concurrency ?? d.concurrency), 1, 32),
    timeoutMs: clamp(Math.round(file.limits?.timeoutMs ?? d.timeoutMs), 1_000, 300_000),
    maxOutputTokens,
    referenceJudging,
    finalists,
    judgePasses: (file.judging?.passes === 2 ? 2 : 1) as 1 | 2,
    ...(semFinais ? { duels: false } : {}),
    // Repeticoes por cenario (F2 §7.9): so o compare expande; nos demais modos
    // a chave e descartada pelo schema (retrocompat).
    ...(file.mode === 'compare' && file.repeats ? { repeats: file.repeats } : {}),
    ...(scenarioSeed.length ? { scenarioSeed } : {}),
    ...(file.scenarioBrief?.trim() ? { scenarioBrief: file.scenarioBrief.trim() } : {}),
    ...(file.models.reference ? { referenceModelId: file.models.reference } : {}),
    ...(Object.keys(reasoning).length ? { reasoning } : {}),
    ...(file.compliance ? { compliance: file.compliance } : {}),
    ...(file.piiMode ? { piiMode: file.piiMode } : {}),
    ...(file.allowPii ? { allowPii: true } : {}),
    // Contratos never-break (F2/P0.3): vivem no perfil do prompt, valem para
    // toda reescrita do variator.
    ...(file.prompt?.contracts ? { contracts: file.prompt.contracts } : {}),
    // Multi-prompt (F2/P0.4): grupo de fragmentos + fragmento-alvo. O
    // `prompt.text` do arquivo e o texto ATUAL do fragmento-alvo (basePrompt).
    ...(file.prompt?.group?.length
      ? {
          promptGroup: { prompts: file.prompt.group },
          ...(file.prompt.promptId ? { promptId: file.prompt.promptId } : {}),
        }
      : {}),
  };

  let candidate: Record<string, unknown>;

  if (file.mode === 'compare') {
    if (file.models.competitorConfigs?.length) {
      // Eixo configs: NAO enviar competitorModelIds — a identidade do
      // concorrente e a tripla modelo/temperatura/reasoning.
      candidate = {
        mode: 'compare',
        ...common,
        competitorConfigs: file.models.competitorConfigs.map((c) => ({
          modelId: c.model,
          ...(c.temperature !== undefined ? { temperature: clamp(c.temperature, 0, 2) } : {}),
          ...(c.reasoning ? { reasoningLevel: c.reasoning } : {}),
        })),
      };
    } else {
      candidate = { mode: 'compare', ...common, competitorModelIds: file.models.competitors ?? [] };
    }
  } else {
    const optimize = file.variation?.optimize !== false;
    const manualVariants = (file.variation?.manualVariants ?? []).filter((v) =>
      v.systemPrompt.trim(),
    );
    candidate = {
      mode: file.mode,
      ...common,
      contestantModelId: file.models.contestant ?? '',
      ...(file.prompt?.text?.trim() ? { basePrompt: file.prompt.text.trim() } : {}),
      promptOptimization: optimize,
      ...(optimize ? { techniqueIds: file.variation?.techniques ?? [] } : { manualVariants }),
      ...(optimize && file.models.rewriter ? { optimizerModelId: file.models.rewriter } : {}),
      ...(file.mode === 'training'
        ? {
            iterations: clamp(Math.round(file.training?.iterations ?? d.iterations), 2, 10),
            // IMPL-002: sem minGain no arquivo o gate usa o default max(1; 50/n)
            // — cravar 1 aqui desligaria a margem ligada à granularidade.
            ...(file.training?.minGain !== undefined ? { minGain: clamp(file.training.minGain, 0, 100) } : {}),
            holdoutRatio: clamp(file.training?.holdoutRatio ?? 0.2, 0, 0.5),
            feedbackDriven: file.training?.feedbackDriven !== false,
            ...(file.training?.reflection ? { reflection: file.training.reflection } : {}),
            ...(file.training?.paretoPool !== undefined ? { paretoPool: file.training.paretoPool } : {}),
          }
        : {}),
    };
  }

  // Passa pelo MESMO schema que o servidor usa — bounds, XOR do compare e a
  // regra de juiz-nao-compete valem igual para arquivo e para formulario.
  const parsed = parseRunConfig(candidate);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, config: parsed.config };
}

// ----------------------------------------------------------------------------
// Traducao `arena-agent-config@1` -> `RunConfig` (modo agente, §25).
//
// Diferente do chat, aqui o ROUTER do contestant fica preso em 'agent' para
// TODOS os contestants quando mode==='compare': eles sao `models.competitors`
// (os agentes sendo comparados). `agent.limits` e default para o
// `scenario[].agentTask.limits` ausente; sem essa heranca, cada cenario
// repetiria o bloco e uma divergencia acidental viraria experimento invalido
// silencioso. `stages` e forcado a `scenarios.length` — datagen de tarefa de
// agente nao existe na v1 (um LLM nao gera repo+setup+verify que rodem sem
// executa-los). `judging.dossierTokens` vira `agent.dossierTokens`.
//
// Fase 4 (§29.2): variation/training tambem sao aceitos. Como o arquivo de
// agente nao traz modelo sob teste nem basePrompt (o `ArenaAgentConfigFile` só
// tem `models.competitors`), o caminho varia o prompt do PRIMEIRO competidor —
// as variações (systemPrompts) são geradas pelo variator com runner='agent'.
// ----------------------------------------------------------------------------

export type ArenaAgentConfigToRunConfigResult =
  | { ok: true; config: RunConfig }
  | { ok: false; error: string };

export function arenaAgentConfigToRunConfig(
  file: ArenaAgentConfigFile,
  overrides: Pick<ArenaConfigDefaults, 'finalists' | 'maxOutputTokens' | 'timeoutMs'> = {},
): ArenaAgentConfigToRunConfigResult {
  // `agent.limits` e o default de todo `scenario.agentTask.limits` ausente.
  const agentLimits = file.agent.limits;
  const maxOutputTokens = Math.max(50, overrides.maxOutputTokens ?? 1000);
  const timeoutMs = clamp(Math.round(overrides.timeoutMs ?? agentLimits.timeoutMs ?? 600_000), 1_000, 300_000);

  // Cenarios: cada um vira uma StageSpec de agentTask. `stages` = scenarios.length
  // (datagen de tarefa de agente nao existe na v1). scenario SEM agentTask => ERRO,
  // nao fallback para chat (cair em silencio mediria outra coisa, §25).
  const stageSpecs: StageSpec[] = [];
  for (const s of file.scenarios) {
    if (!s.agentTask) {
      return {
        ok: false,
        error: 'Em modo agente, todo cenário precisa de agentTask (não vira chat)',
      };
    }
    const taskLimits = agentLimitsSchemaToAgentLimits(s.agentTask.limits) ?? agentLimitsSchemaToAgentLimits(file.agent.limits);
    if (!taskLimits) {
      return { ok: false, error: 'agent.limits.maxCostUsd é obrigatório em modo agente (§20.1)' };
    }
    stageSpecs.push({
      question: s.question,
      // productContext e OPTIONAL no arquivo — o schema do StageSpec exige min(1),
      // entao quando ausente herdamos o contexto mais proximo (brief ou tema).
      productContext: s.productContext?.trim() || file.scenarioBrief?.trim() || file.theme.trim(),
      maxTokens: maxOutputTokens,
      ...(s.rubric ? { rubric: s.rubric } : {}),
      origin: 'import' as const,
      agentTask: {
        ...(s.agentTask.repo ? { repo: s.agentTask.repo } : {}),
        ...(s.agentTask.setup ? { setup: s.agentTask.setup } : {}),
        ...(s.agentTask.files ? { files: s.agentTask.files } : {}),
        ...(s.agentTask.verify ? { verify: s.agentTask.verify } : {}),
        ...(s.agentTask.forbiddenPaths ? { forbiddenPaths: s.agentTask.forbiddenPaths } : {}),
        ...(s.agentTask.rebuild ? { rebuild: s.agentTask.rebuild } : {}),
        ...(s.agentTask.detectors ? { detectors: s.agentTask.detectors } : {}),
        ...(s.agentTask.contextFiles ? { contextFiles: s.agentTask.contextFiles } : {}),
        limits: taskLimits,
      },
    });
  }

  const finalists = clamp(
    Math.round(overrides.finalists ?? file.finalists ?? 3),
    0,
    12,
  );
  const duelsOn = file.duels ?? true;
  const semFinais = !duelsOn || finalists === 0;

  // Reasoning no modo agente: juiz e datagen vao em `config.reasoning` (o agente
  // em si usa `agent.thinking`). Sem ajuste por papel aqui — defaults do pipeline.
  const reasoning: ReasoningConfig = {};

  // IMPL-034 (R-14a DEC-7): com `verify[]` o oráculo decide (veredito e finais)
  // e o juiz de agente NÃO lê o gabarito textual — gerá-lo era custo sem leitor
  // (64% de uma run trivial medida). Todas as etapas com verify[] ⇒ `false`
  // automático, mesmo com `judging.reference: true` explícito (não há quem leia
  // a referência). Com alguma etapa sem verify[], o default segue ligado e o
  // orquestrador pula o gabarito POR ETAPA (`needsTextReference`).
  const todasComVerify =
    stageSpecs.length > 0 && stageSpecs.every((s) => (s.agentTask?.verify?.length ?? 0) > 0);
  const referenceJudging = todasComVerify ? false : (file.judging?.reference ?? true);

  const common = {
    theme: file.theme.trim(),
    stages: stageSpecs.length,
    datagenModelId: file.models.datagen,
    judgeModelIds: file.models.judges,
    concurrency: 4, // execucoes de agente sao pesadas de CPU — gateado pelo maxParallel do agente
    timeoutMs,
    maxOutputTokens,
    referenceJudging,
    finalists,
    judgePasses: (file.judging?.passes === 2 ? 2 : 1) as 1 | 2,
    customStages: stageSpecs,
    ...(semFinais ? { duels: false } : {}),
    ...(file.scenarioBrief?.trim() ? { scenarioBrief: file.scenarioBrief.trim() } : {}),
    ...(file.models.reference ? { referenceModelId: file.models.reference } : {}),
    // O agente controla os proprios tokens; maxOutputTokens/timeoutMs ficam
    // preenchidos aqui pois a etapa tambem pode rodar em modo chat (§29.11).
    ...(Object.keys(reasoning).length ? { reasoning } : {}),
    agent: {
      executor: 'pi' as const,
      executorVersion: file.agent.executorVersion,
      ...(file.agent.install ? { install: file.agent.install } : {}),
      ...(file.agent.provider ? { provider: file.agent.provider } : {}),
      ...(file.agent.promptMode ? { promptMode: file.agent.promptMode } : {}),
      ...(file.agent.thinking ? { thinking: file.agent.thinking } : {}),
      ...(file.agent.tools ? { tools: file.agent.tools } : {}),
      ...(file.agent.repetitions ? { repetitions: file.agent.repetitions } : {}),
      ...(file.agent.maxParallel ? { maxParallel: file.agent.maxParallel } : {}),
      ...(file.agent.isolation ? { isolation: file.agent.isolation } : {}),
      limits: agentLimitsSchemaToAgentLimits(file.agent.limits),
      ...(file.judging?.dossierTokens ? { dossierTokens: file.judging.dossierTokens } : {}),
    },
  };

  // Fase 4 (§29.2): variation/training com agente também são aceitos.
  // `agent` (incl. limits/promptMode etc.) é preservado verbatim no `common`
  // acima; quem dirige o runner='agent' dos contestants é o variator/trainer
  // quando `config.agent` presente.
  const candidate: Record<string, unknown> = file.mode === 'compare'
    ? {
        mode: 'compare',
        ...common,
        // TODOS os contestants rodam como agentes (runner preso em 'agent').
        competitorConfigs: file.models.competitors.map((id) => ({ modelId: id })),
      }
    : {
        mode: file.mode,
        ...common,
        // O arena-agent-config@1 nao traz modelo sob teste, promp base nem
        // tecnicas (so `models.competitors`, min 2, para o compare). No caminho
        // variation/training com agente, o modelo sob teste e o primeiro
        // competidor e as variacoes de prompt (systemPrompts) sao geradas pelo
        // variator com runner='agent'. Para um single-model VALIDO (o schema de
        // run exige >= 2 candidatos), defaultamos a otimizacao ligada com duas
        // tecnicas gerais (`getTechnique` aceita so ids reais — conferidas no
        // catalogo). TODO: quando o arena-agent-config@1 ganhar base/tecnicas
        // p/ variation/training, leia daqui em vez de defaultar.
        contestantModelId: file.models.competitors[0],
        promptOptimization: true,
        techniqueIds: ['specificity', 'constraints'],
        ...(file.mode === 'training'
          ? { iterations: clamp(Math.round(3), 2, 10) }
          : {}),
      };

  const parsed = parseRunConfig(candidate);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, config: parsed.config };
}

// `ArenaAgentConfigLimits` exige maxCostUsd; `AgentLimits` o tem opcional. Converte
// o objeto do arquivo para o tipo do dominio (remove extras, normaliza para AgentLimits).
function agentLimitsSchemaToAgentLimits(
  l: { maxTurns?: number; maxCostUsd: number; timeoutMs?: number; maxOutputBytes?: number; maxDiffBytes?: number } | undefined,
): { maxTurns?: number; maxCostUsd?: number; timeoutMs?: number; maxOutputBytes?: number; maxDiffBytes?: number } | undefined {
  if (!l) return undefined;
  return {
    ...(l.maxTurns !== undefined ? { maxTurns: l.maxTurns } : {}),
    ...(l.maxCostUsd !== undefined ? { maxCostUsd: l.maxCostUsd } : {}),
    ...(l.timeoutMs !== undefined ? { timeoutMs: l.timeoutMs } : {}),
    ...(l.maxOutputBytes !== undefined ? { maxOutputBytes: l.maxOutputBytes } : {}),
    ...(l.maxDiffBytes !== undefined ? { maxDiffBytes: l.maxDiffBytes } : {}),
  };
}
