// ----------------------------------------------------------------------------
// `runAgentStage` — roda UMA etapa para UM contestant de runner 'agent'.
//
// É o "dez passos" do §10 do plano, orquestrando os módulos do diretório:
// workspace (prepare/collect/dispose), executor (pi), trajetória, oráculo,
// dossiê, store (writeExecution) e o juiz por dossiê. Por repetição (cada rep é
// INDEPENDENTE — §18.4) produz um `AgentRepResult`; ao fim devolve a
// `CompetitorResponse` da etapa (text = resumo de 1 linha, §29.12; execution =
// ref da repetição 0) e o agregado das reps.
//
// ⚠️ ESPELHO CLIENT-SIDE: NÃO existe — o modo agente é impossível na SPA (§7.3).
//
// Notas de contrato (casar com os módulos merged, nunca adivinhar):
// - O executor (`piExecutor.run`) recebe TUDO pelo `AgentRunOpts` (contrato v2,
//   IMPL-095): `instruction` (tarefa), `systemPrompt` + `promptMode`, `modelId`,
//   `thinking`, `contextFiles`, `signal`, `onEvent` (custo real por turno),
//   preços do catálogo, `inference` (credentialRef/baseUrl), `sandbox` (alça do
//   sandbox preparado) e `costBrake` (costSink). Sem canal `PI_*` de env e sem
//   2º parâmetro fora do contrato.
// - O executor NÃO expõe os events crus do stream `--mode json` (consome-os
//   internamente) e devolve a `trajectory` já normalizada (`fromPi`) no `outcome`. Por isso
//   este módulo usa `outcome.trajectory` direto (§10 passo 9). Um gateway
//   injetado (fake no smoke) devolve a MESMA forma.
// - A `CompetitorResponse.execution` é um `ExecutionRef` RELATIVO a getDataDir().
// ----------------------------------------------------------------------------
import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensurePrivateSubtree } from '../pathSafety.js';
import type { AgentRunOpts, PrepareOpts } from './executor.js';
import { piExecutor } from './pi.js';
import type { PiRunOutcome } from './pi.js';
import { createWorkspaceManager, type CollectResult } from './workspace.js';
import { execDir, redactEnv, sha256Of, writeExecution } from './store.js';
import { buildDossier } from './dossier.js';
import { captureSeedGuard, runOracle } from './oracle.js';
import { aggregateAgentVerdict, judgeDossier, type AgentJudgeRubric } from './agentJudge.js';
import {
  AGENT_VERDICT_TREE_VERSION,
  classifyStop,
  decideRepVerdict,
  mergeOracleRecheck,
  recheckIndices,
  settleRepVerdict,
  shouldRecheckOracle,
  type JudgeOutcome,
  type SettledRepVerdict,
  type VerdictPath,
} from './verdictTree.js';
import {
  classifyAgentFailure,
  decideInfraError,
  failureExplanation,
  INFRA_RETRIES,
  shouldRetryAttempt,
  type AgentFailure,
  type AgentFailureClass,
  type FailurePhase,
} from './infraError.js';
import { acquireRunInferenceProxy, type InferenceProxyLease } from './inferenceProxy.js';
import {
  acquireRunCostMeter,
  applyMeasuredCost,
  COST_PROXY_VERSION,
  type RunCostMeter,
  type RunCostMeterLease,
} from './costProxy.js';
import { hostCommandRunner, removeTreeBestEffort, writeFileNoFollow, type CommandRunner } from './sandboxExec.js';
import { combinedChecks, copyTestsDirInto } from './taskValidate.js';
import { isDigestRef, sandboxCommandRunner, sandboxProfile } from './container.js';
import { BudgetExceeded, isControlSignal, RunCancelled } from '../budget.js';
import { emitEvent } from '../events.js';
import { blindRankMap, seedFromId } from '../duels.js';
import { getGateway, tierFor } from '../openrouter.js';
import { isKnownPrice } from '../engine/pricing.js';
import type {
  AgentCostSource,
  AgentLimits,
  AgentRunnerConfig,
  AgentStopReason,
  AgentTrajectory,
  ExecutionRef,
  OracleResult as AgentOracleResult,
} from './types.js';
import type {
  CompetitorResponse,
  Contestant,
  CostSource,
  OpenRouterModel,
  RunCtx,
  StageSpec,
  Verdict,
  VerdictError,
  VerdictSource,
} from '../types.js';

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

/** Veredito de UMA repetição. */
export interface AgentRepResult {
  /** 0-based. */
  repetition: number;
  execution: ExecutionRef;
  /** Por que a execução terminou. */
  stopReason: AgentStopReason;
  /** Resultado do oráculo (quando houve). */
  oracle?: AgentOracleResult;
  /**
   * null = sem observação: cancelamento (controle — a etapa inteira sai), rep
   * SEM oráculo cujo juiz falhou/não foi chamado (IMPL-033) OU falha que não é
   * do agente (IMPL-094: `infraClass` — infra/transitória esgotada fica fora
   * dos denominadores; `defect` invalida a etapa para TODOS). Corte por limite
   * (timeout/maxTurns/maxCost/maxOutput) NÃO é null: conta 'nao' (IMPL-032);
   * check do oráculo que não terminou também não: conta como check falho (ou a
   * ETAPA inteira sai para todos, se o comando não rodou em nenhuma execução —
   * `oracleCellDefect` no orquestrador).
   */
  verdict: Verdict | null;
  /** Caminho da árvore de veredito que decidiu esta repetição (1 dos 9). */
  path: VerdictPath;
  explanation: string;
  /** true quando o veredito do juiz LLM foi usado (dentro da faixa do oráculo). */
  judgeUsed: boolean;
  /** Origem do veredito presente (nomes do CONVENTIONS). */
  source?: VerdictSource;
  /**
   * Flag `judgeError` (IMPL-033 / R-14a DEC-3): o juiz falhou (exceção,
   * timeout, saída sem veredito) mesmo após as 2 retentativas. O veredito é o
   * do oráculo (preservado) ou nenhum — nunca 'parcial' imputado.
   */
  judgeError?: VerdictError;
  /** Veredito CRU do juiz quando a faixa do oráculo o confinou (auditoria). */
  judgeVerdictBeforeClamp?: Verdict;
  /** Rubrica de processo do juiz (IMPL-034): resultado/escopo/burla/manipulação. */
  judgeRubric?: AgentJudgeRubric;
  /** Vezes que o oráculo rodou (> 1 = re-verificação cega de check que nem começou). */
  oracleAttempts?: number;
  /**
   * Erro de INFRA (provedor/rede — IMPL-036) que deixou a rep SEM veredito
   * (`verdict: null`, oráculo não conclusivo). É falha do ambiente, não do
   * agente nem do juiz: a procedência vira `competitor_error`.
   */
  infraError?: string;
  /**
   * IMPL-094 — classe da falha que deixou a rep SEM veredito (não é do
   * agente): `transient` (retentativas cegas esgotadas) e `infra` ficam fora
   * dos denominadores e contam no `infraErrorRate`; `defect` invalida a etapa
   * para TODOS (`stageInfraDefect` no orquestrador).
   */
  infraClass?: AgentFailureClass;
  /** IMPL-094 — tentativas desta rep (1 + retentativas cegas por falha transitória). */
  attempts?: number;
  /** IMPL-094 — tentativas DESCARTADAS (falha transitória), com o dir arquivado para auditoria. */
  discardedAttempts?: DiscardedAttempt[];
  /** Custo desta rep — soma de TODAS as tentativas (dinheiro gasto é medido, descartado ou não). */
  costUsd: number;
}

/** Uma tentativa descartada por falha TRANSITÓRIA (retentativa cega, IMPL-094). */
export interface DiscardedAttempt {
  attempt: number;
  reason: string;
  costUsd: number;
  /** Dir da tentativa arquivada (relativo ao data dir), quando o arquivamento deu certo. */
  dir?: string;
}

export interface RunAgentStageParams {
  runId: string;
  stageIndex: number;
  contestant: Contestant; // runner === 'agent'
  stage: StageSpec; // stage.agentTask presente
  agentConfig: AgentRunnerConfig; // record.config.agent (defaults resolvidos)
  apiKey: string;
  ctx: RunCtx; // signal + sink (ledger)
  dataDir: string; // getDataDir()
  catalog: OpenRouterModel[]; // precificação
  forcedPromptMode?: 'replace' | 'append' | 'none';
  /**
   * Ids de TODOS os contestants da etapa (agent + chat), na MESMA ordem que o
   * orquestrador usa para o `blindRankMap` — garante que as LETRAS cegas do
   * dossiê casem com o ranking/desempate cego. Ausente => [contestant.id].
   */
  blindIds?: string[];
  /** Gateway do executor — injetável para o smoke/fake. Default: piExecutor. */
  gateway?: AgentGateway;
  /** Fim pretendido: valor REAL. */
  judgeModelIds?: string[];
  /**
   * ONDE rodam `setup[]`/`verify[]` (IMPL-038). Default: `resolveStageRunners`
   * pela `isolation.kind`. Injetável para o teste de contrato sem Docker.
   */
  runners?: StageRunners;
}

/**
 * ONDE roda o código não confiável de UMA etapa (IMPL-038 / R-15 REC-4).
 * - `container`: `setup[]` num sandbox endurecido sobre o workspace (antes do
 *   agente) e `verify[]` num sandbox verificador NOVO, montado numa CÓPIA do
 *   estado final do agente com os fixtures prístinos reescritos depois dele.
 * - `host`: modo EXPLÍCITO sem Docker — SEM ISOLAMENTO (`isolated: false`),
 *   registrado no `exec.json`; a única defesa é o env mínimo.
 */
export interface StageRunners {
  mode: 'host' | 'container';
  isolated: boolean;
  setup: (workspaceDir: string) => CommandRunner;
  verify: (verifierDir: string) => CommandRunner;
  setupNetwork?: 'none' | 'bridge';
  verifierImage?: string;
}

/** Aviso de "modo host = sem isolamento": uma vez por run (stderr — stdout do CLI é payload). */
const hostModeWarned = new Set<string>();

/**
 * Monta os runners da etapa. Em modo container a imagem do verificador é a do
 * executor, PINADA por digest no `prepare()` (`PI_CONTAINER_IMAGE`: node + git +
 * bash); sem digest não há sandbox — e não há fallback silencioso para o host.
 */
export async function resolveStageRunners(
  agentConfig: AgentRunnerConfig,
  preparedEnv: Record<string, string>,
): Promise<StageRunners> {
  if (agentConfig.isolation?.kind !== 'container') {
    return {
      mode: 'host',
      isolated: false,
      setup: () => hostCommandRunner(),
      verify: () => hostCommandRunner(),
    };
  }
  const image = preparedEnv.PI_CONTAINER_IMAGE;
  if (!image || !isDigestRef(image)) {
    throw new Error(
      `modo container exige a imagem do sandbox pinada por digest (PI_CONTAINER_IMAGE="${image ?? ''}") — ` +
        'setup[]/verify[] não caem para o host em silêncio.',
    );
  }
  const profile = await sandboxProfile({ runtime: agentConfig.isolation?.runtime });
  // Setup COM rede (decisão IMPL-038): roda ANTES do agente, com comandos da
  // TAREFA (npm ci/pip install precisam de registry), sem segredo no env e sem
  // nada do host montado além do próprio workspace. O verificador roda depois
  // do agente e fica com o perfil da execução (rede `none`, salvo a válvula).
  const setupProfile = { ...profile, network: 'bridge' as const };
  return {
    mode: 'container',
    isolated: true,
    setup: (workspaceDir) => sandboxCommandRunner({ image, profile: setupProfile, mountDir: workspaceDir }),
    verify: (verifierDir) => sandboxCommandRunner({ image, profile, mountDir: verifierDir }),
    setupNetwork: 'bridge',
    verifierImage: image,
  };
}

export interface RunAgentStageResult {
  response: CompetitorResponse; // text = resumo 1 linha; execution = rep 0
  repResults: AgentRepResult[]; // 1 por repetição
  /**
   * true = TODAS as repetições foram canceladas (que, na prática, sobe como
   * RunCancelled antes daqui). Falha de preparação e corte por limite NÃO são
   * incomplete (pontuam 'nao'); rep sem veredito por execução inválida ou juiz
   * sem oráculo também não (é "sem observação", não controle — IMPL-033).
   */
  incomplete: boolean;
  errorMsg?: string;
}

/**
 * Forma mínima do executor vista por este módulo. O `piExecutor` casa
 * estruturalmente. Permitir injetar um fake é o que viabiliza o smoke SEM gastar
 * com agente real.
 */
export interface AgentGateway {
  id: string;
  prepare(opts: PrepareOpts): Promise<{ bin: string; env: Record<string, string> }>;
  /**
   * UM parâmetro só (IMPL-095): `AgentRunOpts` carrega TODO o contrato
   * (modelId/instruction/systemPrompt/signal/onEvent/preços/sandbox) — sem canal
   * `PI_*` de env e sem 2º parâmetro fora do contrato.
   */
  run(opts: AgentRunOpts): Promise<PiRunOutcome>;
}

const DEFAULT_GATEWAY: AgentGateway = {
  id: piExecutor.id,
  prepare: (o) => piExecutor.prepare(o),
  run: (o) => piExecutor.run(o),
};

// ---------------------------------------------------------------------------
// Defaults (espelham §AgentLimits do plano — o executor usa os mesmos).
// ---------------------------------------------------------------------------
const DEFAULT_MAX_TURNS = 30;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_DIFF_BYTES = 512 * 1024;
const DEFAULT_DOSSIER_TOKENS = 12_000;
/**
 * Re-verificações CEGAS de check que nem começou (`notRun: 'spawn'` — comando
 * ausente/sem permissão; cobre o soluço do ambiente, ex.: EAGAIN sob carga).
 * Só esses checks rodam de novo, no mesmo workspace, sem LLM — e só quando o
 * oráculo ainda pode mudar a nota (`shouldRecheckOracle`). Timeout/sinal do
 * check NÃO são re-verificados: é desfecho do código sob teste (conta falho).
 * Persistindo, o check fica FALHO na rep e a célula decide se o ambiente é que
 * está quebrado (`oracleCellDefect` → etapa inválida para TODOS). Reexecutar a
 * rep INTEIRA (novo agente) não ajuda aqui: defeito do ambiente é determinístico,
 * e repetir a execução de quem quebrou o verificador seria retry dependente de
 * resultado; a reexecução por infra transitória é a do laço de tentativas
 * (IMPL-094, `shouldRetryAttempt`), que roda a execução INTEIRA de novo.
 */
const ORACLE_RETRIES = 2;

/** Precedência dos limites: tarefa > config do agente > defaults. */
function resolveLimits(
  taskLimits: AgentLimits | undefined,
  agentConfig: AgentRunnerConfig,
): AgentLimits & { maxDiffBytes: number } {
  const base: AgentLimits & { maxDiffBytes: number } = {
    maxTurns: DEFAULT_MAX_TURNS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    maxDiffBytes: DEFAULT_MAX_DIFF_BYTES,
  };
  return { ...base, ...(agentConfig.limits ?? {}), ...(taskLimits ?? {}) };
}

/** Preço por token (entrada/saída) a partir do catálogo — fallback do custo. */
function priceFns(catalog: OpenRouterModel[], modelId: string): {
  priceTokensIn: (n: number) => number;
  priceTokensOut: (n: number) => number;
} {
  const model = catalog.find((m) => m.id === modelId);
  const rate = (t: number, kind: 'prompt' | 'completion'): number => {
    if (!model) return 0;
    const preco = tierFor(model.pricing, Math.max(1, t))[kind];
    // IMPL-018: preco desconhecido ("-1", roteador) nunca multiplica tokens —
    // antes dava custo NEGATIVO. Mesmo tratamento do modelo fora do catalogo.
    return isKnownPrice(preco) ? t * preco : 0;
  };
  return {
    priceTokensIn: (n) => rate(n, 'prompt'),
    priceTokensOut: (n) => rate(n, 'completion'),
  };
}

/**
 * Fonte do custo no LEDGER (IMPL-096): o que o executor reportou vira
 * 'agent-derived' (nunca 'catalog' — tabela é outra coisa); o que foi medido
 * no gateway (ou conciliado com o /generation) vira 'usage', a única fonte
 * exata; estimativa por tabela do /models continua 'catalog'. Nada cai em
 * 'unknown' por aqui: nestas anotações o valor é sempre conhecido.
 */
function ledgerCostSource(src: AgentCostSource): CostSource {
  if (src === 'usage' || src === 'reconciled') return 'usage';
  if (src === 'catalog') return 'catalog';
  return 'agent-derived';
}

/** Resumo de 1 linha da etapa (padrão §29.12). */
function summarizeResponse(rep: AgentRepResult): string {
  const parts: string[] = [];
  parts.push(`${rep.execution.turns ?? 0} turnos`);
  const stat = rep.execution.diffStat;
  if (stat) parts.push(`${stat.files} arquivo${stat.files === 1 ? '' : 's'}`);
  if (rep.oracle) {
    if (rep.oracle.score >= 1) parts.push('testes ✓');
    else if (rep.oracle.score === 0) parts.push('testes ✗');
    else parts.push(`testes ${Math.round(rep.oracle.score * 100)}%`);
  }
  return `agente: ${parts.join(' · ')}`;
}

/**
 * Roda UMA etapa do modo agente: N execuções independentes (repetitions) e o
 * julgamento de cada uma. Ver fluxo em §10 do plano.
 */
export async function runAgentStage(opts: RunAgentStageParams): Promise<RunAgentStageResult> {
  const { runId, stageIndex, contestant, stage, agentConfig, apiKey, dataDir, forcedPromptMode } = opts;
  const gateway = opts.gateway ?? DEFAULT_GATEWAY;
  const task = stage.agentTask;
  const judgeModelIds = opts.judgeModelIds ?? [];
  const reps = Math.max(1, agentConfig.repetitions ?? 1);

  // Falha ANTES de qualquer execução (sem tarefa, testsDir inválido, executor
  // que não prepara, sandbox/proxy que não sobe) é DEFEITO da tarefa/ambiente
  // (IMPL-094, R-14a DEC-2): cada rep sai SEM veredito com `infraClass:
  // 'defect'` e o orquestrador invalida a etapa para TODOS os contestants —
  // antes cada rep contava 'nao' (a falha do ambiente virava nota de alguém).
  // `incomplete` continua só controle (IMPL-032).
  if (!task) {
    const errorMsg = 'Etapa sem agentTask para contestant com runner=agent';
    return {
      response: { ...responseError(contestant, contestant.modelId, errorMsg, 0), text: 'agente: sem tarefa executável nesta etapa' },
      repResults: defectReps(runId, stageIndex, contestant.id, reps, errorMsg),
      incomplete: false,
      errorMsg,
    };
  }

  // IMPL-098: `testsDir` chega RESOLVIDO pelo CLI (absoluto, existente) — é
  // conferido ANTES de executar qualquer coisa. Relativo (config vinda sem
  // diretório de origem: MCP/HTTP) nunca é resolvido contra o cwd nem contra o
  // workspace — o agente plantaria o próprio "teste".
  const testsDirErr = testsDirIssue(task);
  if (testsDirErr) {
    return {
      response: responseError(contestant, contestant.modelId, testsDirErr, 0),
      repResults: defectReps(runId, stageIndex, contestant.id, reps, testsDirErr),
      incomplete: false,
      errorMsg: testsDirErr,
    };
  }

  const promptMode = agentConfig.promptMode ?? forcedPromptMode ?? 'append';
  // O executor (pi) lê `config.promptMode` p/ montar o argv (`--system-prompt` vs
  // `--append-system-prompt`). Passamos a config com o modo RESOLVIDO para que o
  // `forcedPromptMode` do orquestrador tenha efeito também no argv do executor.
  const runConfig: AgentRunnerConfig = { ...agentConfig, promptMode };
  const limits = resolveLimits(task.limits, agentConfig);
  const modelId = contestant.modelId;
  const systemPrompt = buildSystemPrompt(opts);

  // Preparação do executor UMA vez por etapa (bin/env não mudam entre reps).
  const runDir = path.join(dataDir, 'agent-runs', runId);
  // IMPL-024: agent-runs/<runId> em 0700 ANTES de prepare/workspace/reps criarem
  // qualquer coisa dentro (sessões, diffs, cache do repo): com raiz não dedicada
  // (./data, --data-dir) a árvore do agente não nasce legível por outros.
  await ensurePrivateSubtree(dataDir, runDir).catch(() => undefined);
  let prepared: { bin: string; env: Record<string, string> };
  try {
    prepared = await gateway.prepare({
      install: agentConfig.install ?? 'isolated',
      executorVersion: agentConfig.executorVersion,
      runDir,
      // Isolamento da config (kind container → o prepare garante a imagem do pi
      // e devolve bin='docker'). Campo aditivo em PrepareOpts — ver executor.ts.
      isolation: agentConfig.isolation,
    });
  } catch (err) {
    if (isControlSignal(err)) throw err;
    const errorMsg =
      `Falha ao preparar o executor (${agentConfig.executorVersion}): ` +
      `${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
    return {
      response: responseError(contestant, modelId, errorMsg, 0),
      repResults: defectReps(runId, stageIndex, contestant.id, reps, errorMsg),
      incomplete: false,
      errorMsg,
    };
  }

  let runners: StageRunners;
  try {
    runners = opts.runners ?? (await resolveStageRunners(agentConfig, prepared.env));
  } catch (err) {
    if (isControlSignal(err)) throw err;
    const errorMsg = `Falha ao preparar o sandbox de setup/verify: ${(err as Error).message}`;
    // Ambiente que não serve (sem digest pinado, runtime ausente): defeito —
    // antes saía `incomplete` sem reps (o contestant sumia da etapa).
    return {
      response: responseError(contestant, modelId, errorMsg, 0),
      repResults: defectReps(runId, stageIndex, contestant.id, reps, errorMsg),
      incomplete: false,
      errorMsg,
    };
  }
  if (!runners.isolated && !hostModeWarned.has(runId)) {
    hostModeWarned.add(runId);
    console.error(
      `[agent] ⚠️ modo host (isolation.kind="${agentConfig.isolation?.kind ?? 'worktree'}"): SEM ISOLAMENTO — ` +
        'o agente, setup[] e verify[] rodam com o seu usuário. Use isolation.kind="container" para sandbox.',
    );
  }

  // Proxy de inferência da RUN (IMPL-037 / R-15 DEC-2): a key real (`apiKey`)
  // fica NELE; o agente recebe só base URL local + token fictício por execução.
  // Modo container: socket Unix (o sandbox roda com `--network none`); modo
  // host: TCP no loopback. Upstream = gateway do processo (OPENROUTER_BASE_URL).
  // UM por run: as etapas paralelas pegam empréstimos do mesmo proxy e o último
  // a devolver o fecha. O log redigido fica em `<runDir>/inference-proxy.jsonl`,
  // fora de qualquer mount do sandbox.
  // Pendurado nele, o proxy de CUSTO da run (IMPL-035): mede o `usage.cost` de
  // cada chamada do agente no MESMO ledger (`ctx.sink`), recusa a chamada que não
  // cabe (429 `budget_exhausted`) ANTES de ir ao provedor e limita a taxa.
  const meterLease: RunCostMeterLease = acquireRunCostMeter(runId, {
    sink: opts.ctx.sink,
    signal: opts.ctx.signal,
    catalog: opts.catalog,
  });
  let proxyLease: InferenceProxyLease;
  try {
    const gw = getGateway().config;
    const inContainer = agentConfig.isolation?.kind === 'container';
    proxyLease = await acquireRunInferenceProxy(runId, {
      apiKey,
      upstreamBaseUrl: gw.baseUrl,
      appUrl: gw.appUrl,
      appTitle: gw.appTitle,
      listen: inContainer ? { unix: true } : { tcp: true },
      logFile: path.join(runDir, 'inference-proxy.jsonl'),
      hooks: meterLease.meter.hooks,
      logMeta: { costProxy: COST_PROXY_VERSION },
    });
  } catch (err) {
    meterLease.release();
    if (isControlSignal(err)) throw err;
    const errorMsg = `Falha ao subir o proxy de inferência local: ${(err as Error).message}`;
    // Mesma regra do executor que não preparou: defeito do ambiente (IMPL-094)
    // — `incomplete` é só controle.
    return {
      response: responseError(contestant, modelId, errorMsg, 0),
      repResults: defectReps(runId, stageIndex, contestant.id, reps, errorMsg),
      incomplete: false,
      errorMsg,
    };
  }
  try {
    return await runAgentReps(opts, {
      gateway,
      task,
      judgeModelIds,
      reps,
      promptMode,
      runConfig,
      limits,
      modelId,
      systemPrompt,
      prepared,
      proxy: proxyLease.proxy,
      meter: meterLease.meter,
      runners,
    });
  } catch (err) {
    // Falha fora de uma rep (bug do produto): o contestant NÃO pode sumir da
    // etapa em silêncio (o orquestrador descarta rejeição que não é controle).
    if (isControlSignal(err)) throw err;
    const errorMsg = `Falha inesperada na etapa do agente: ${(err as Error)?.message ?? String(err)}`;
    return { response: responseError(contestant, modelId, errorMsg, 0), repResults: [], incomplete: true, errorMsg };
  } finally {
    await proxyLease.release();
    meterLease.release();
  }
}

/** O que `runAgentReps` herda da preparação da etapa. */
interface RepsContext {
  gateway: AgentGateway;
  task: NonNullable<StageSpec['agentTask']>;
  judgeModelIds: string[];
  reps: number;
  promptMode: 'replace' | 'append' | 'none';
  runConfig: AgentRunnerConfig;
  limits: AgentLimits & { maxDiffBytes: number };
  modelId: string;
  systemPrompt: string;
  prepared: { bin: string; env: Record<string, string> };
  proxy: InferenceProxyLease['proxy'];
  /** Medidor de custo da run (freio + medição por chamada). */
  meter: RunCostMeter;
  /** Onde setup/verify rodam (IMPL-038: sandbox em modo container). */
  runners: StageRunners;
}

/** Desfecho de UMA tentativa de uma rep (IMPL-094: o laço decide se re-executa). */
interface AttemptOutcome {
  rep: AgentRepResult;
  /** Resposta candidata da etapa (só a da rep 0 vira a `CompetitorResponse`). */
  response?: CompetitorResponse;
  execFailed: boolean;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** Falha que não é do agente (a CLASSE decide a retentativa — nunca o resultado). */
  failure?: AgentFailure;
}

/**
 * Arquiva o dir de uma tentativa DESCARTADA ao lado do canônico
 * (`<rep>.attempt-<n>`) — a auditoria fica, e a tentativa seguinte nasce num dir
 * limpo (o `writeExecution` não mistura artefatos). Melhor esforço.
 */
function archiveAttemptDir(repAbs: string, attempt: number): string | undefined {
  const dest = `${repAbs}.attempt-${attempt}`;
  try {
    renameSync(repAbs, dest);
    return dest;
  } catch {
    return undefined;
  }
}

/** As N repetições da etapa (o laço do §10), com o proxy da run já no ar. */
async function runAgentReps(opts: RunAgentStageParams, rc: RepsContext): Promise<RunAgentStageResult> {
  const { runId, stageIndex, contestant, stage, agentConfig, apiKey, ctx, dataDir, catalog } = opts;
  const { gateway, task, judgeModelIds, reps, promptMode, runConfig, limits, modelId, systemPrompt, prepared, proxy, meter, runners } = rc;

  // Letra cega do candidato: MESMO mapa/shuffle que o orquestrador usa no ranking.
  const blindOrder = blindRankMap(opts.blindIds ?? [contestant.id], seedFromId(stage.question));
  const contestantLabel = String.fromCharCode(65 + (blindOrder.get(contestant.id) ?? 0));

  const workspaceMgr = createWorkspaceManager({
    cacheDir: path.join(dataDir, 'agent-runs', runId, 'repo-cache'),
  });
  const price = priceFns(catalog, modelId);

  const repResults: AgentRepResult[] = [];
  let totalCostUsd = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let anyError = false;
  let response: CompetitorResponse | null = null;
  const container = runners.mode === 'container';

  /**
   * UMA tentativa de UMA repetição (IMPL-094): workspace, agente, coleta,
   * oráculo e adjudicação. Não lança por falha comum — devolve a rep com a
   * CLASSE da falha que não é do agente (quando houve) para o laço decidir, às
   * cegas quanto ao resultado, se re-executa. Controle (orçamento/cancelamento) SOBE.
   */
  const attemptOnce = async (rep: number, relativeDir: string, repAbs: string): Promise<AttemptOutcome> => {
      mkdirSync(repAbs, { recursive: true });
      // Fase corrente: decide a CLASSE de uma exceção (prepare = defeito da
      // tarefa; execute = por tipo do erro; harness = infra).
      let phase: FailurePhase = 'prepare';

      let workspaceDir = '';
      let seedCommit = '';
      let cacheRepoDir = '';
      let auditGitDir = '';
      let verifierDir: string | undefined;
      let credential: ReturnType<typeof proxy.issueCredential> | undefined;
      let execMeter: ReturnType<RunCostMeter['openExecution']> | undefined;

      try {
        // 1) workspace.prepare() — setup[] + files[] + seedCommit (§10.1).
        //    setup[] roda ONDE o runner da etapa manda (sandbox em container).
        const ws = await workspaceMgr.prepare(
          {
            repo: task.repo,
            setup: task.setup,
            files: task.files,
            limits,
          },
          { setupRunner: runners.setup },
        );
        workspaceDir = ws.workspaceDir;
        seedCommit = ws.seedCommit;
        cacheRepoDir = ws.cacheRepoDir;
        auditGitDir = ws.auditGitDir;
        phase = 'harness';
        // SHA-256 dos protegidos NO SEED, antes do agente acordar (IMPL-039):
        // pelo filesystem, não pelo git — pega arquivo ignorado e rename.
        const seedGuard = await captureSeedGuard(workspaceDir, task);

        // 2) task.txt + system-prompt.txt no repetitionDir (§12.5).
        writeFileSync(path.join(repAbs, 'task.txt'), stage.question, 'utf8');
        writeFileSync(path.join(repAbs, 'system-prompt.txt'), systemPrompt, 'utf8');

        // 3) executor.run() — cwd=workspace, workDir=repetitionDir, limites.
        const execId = randomUUID();
        emitEvent({ type: 'agent.started', runId, stageIndex, contestantId: contestant.id, execId, repetition: rep });
        // A key NUNCA vai ao env do executor (IMPL-037) — nem se um `prepare`
        // antigo/injetado a estampar: quem a detém é o proxy da run. E nada do
        // contrato viaja por env (IMPL-095): modelo/tarefa/prompt vão em
        // `AgentRunOpts`, nunca em `PI_*`.
        const { OPENROUTER_API_KEY: _keyFora, ...preparedEnv } = prepared.env;
        void _keyFora;
        const env = preparedEnv;
        // Freio/medidor de custo DESTA execução (IMPL-035), registrado ANTES do
        // token: a 1ª chamada já é medida contra o teto `maxCostUsd`.
        execMeter = meter.openExecution({ execId, modelId, maxCostUsd: limits.maxCostUsd });
        // Token fictício DESTA execução (mapeamento execução → chamada conhecido
        // só do produto); revogado assim que a execução termina.
        credential = proxy.issueCredential({ runId, stageIndex, contestantId: contestant.id, repetition: rep, execId, role: 'agent' });
        const inference = proxy.route(credential);

        // IMPL-095: TODO o contrato viaja em `AgentRunOpts` — UM argumento, sem
        // canal `PI_*` de env e sem 2º parâmetro fora do contrato.
        phase = 'execute';
        const rawOutcome = await gateway.run({
          execId,
          task,
          config: runConfig,
          workspaceDir,
          workDir: repAbs,
          bin: prepared.bin,
          env,
          modelId,
          instruction: stage.question,
          systemPrompt,
          promptMode,
          thinking: runConfig.thinking,
          contextFiles: task.contextFiles ?? false,
          signal: ctx.signal,
          priceTokensIn: price.priceTokensIn,
          priceTokensOut: price.priceTokensOut,
          sessionDir: path.join(repAbs, 'session'),
          inference,
          costBrake: execMeter,
          // Alça do sandbox preparado (IMPL-095): o digest pinado pelo `prepare`
          // viaja no contrato, não por env.
          sandbox: prepared.env.PI_CONTAINER_IMAGE
            ? {
                kind: 'container',
                imageDigest: prepared.env.PI_CONTAINER_IMAGE,
                imageRef: prepared.env.PI_CONTAINER_IMAGE_REF,
                runtime: agentConfig.isolation?.runtime,
              }
            : undefined,
          // onEvent é a ponte de progresso do agente rodando — o `turn` leva o
          // custo REAL do turno (medido), nunca o placeholder 0 de antes.
          onEvent: (e) => {
            if (e.type === 'turn' && execId) {
              emitEvent({
                type: 'agent.turn',
                runId,
                stageIndex,
                contestantId: contestant.id,
                execId,
                turn: e.index,
                costUsd: e.costUsd,
              });
            }
          },
        });

        // As chamadas em voo desta execução terminam de ser anotadas (o agente
        // morto no meio de um stream fecha a troca logo em seguida).
        await execMeter.settled();
        phase = 'harness';

        // §18.3/§29.3: cancelamento da RUN é sinal de controle e SOBE — não vira
        // 'incomplete' mudo (o pipeline precisa saber que a run foi abortada).
        if (ctx.signal?.aborted || rawOutcome.stopReason === 'cancelled') {
          throw new RunCancelled(ctx.signal?.reason);
        }
        // IMPL-035: o proxy recusou a chamada seguinte por falta de saldo DA RUN
        // → o `BudgetExceeded` do ledger SOBE como de qualquer papel (a run sai
        // parcial por orçamento, exit 7). O gasto já está no ledger, por chamada.
        const brakeStop = execMeter.stopped();
        const runBudget = brakeStop?.scope === 'run' ? execMeter.budgetSignal() : undefined;
        if (runBudget) throw runBudget;
        // Teto da EXECUÇÃO: a recusa é controle traduzido em 'maxCost' — mesmo que
        // o executor (um fake, um adaptador novo) não o tenha traduzido. Não é erro
        // do provedor: sem `infraError`.
        const outcome: typeof rawOutcome =
          brakeStop && (rawOutcome.stopReason === 'completed' || rawOutcome.stopReason === 'error' || rawOutcome.stopReason === 'maxOutput')
            ? { ...rawOutcome, stopReason: 'maxCost', infraError: undefined, trajectory: { ...rawOutcome.trajectory, stopReason: 'maxCost' } }
            : brakeStop
              ? { ...rawOutcome, infraError: undefined }
              : rawOutcome;

        // 4) collect (diff/stat/files) + oráculo + trajetória (§10.4-9).
        //    IMPL-038: collect por CÓPIA de árvore (nunca git no `.git` do
        //    agente); a cópia vira a base do verificador NOVO, com os fixtures
        //    PRÍSTINOS da tarefa reescritos DEPOIS do agente (padrão Harbor/
        //    SWE-bench) — o agente não entrega o próprio teste adulterado.
        // `rebuild` (IMPL-039) também roda na cópia: nunca no workspace do agente.
        // IMPL-098: `regression[]` entra no oráculo como PASS_TO_PASS e o
        // `testsDir` só existe no verificador — os dois exigem a cópia.
        const checks = combinedChecks(task);
        const needsVerifier = checks.length > 0 || task.rebuild !== undefined || task.testsDir !== undefined;
        const collect = await workspaceMgr.collect(workspaceDir, seedCommit, limits.maxDiffBytes, {
          keepSnapshot: needsVerifier,
        });
        verifierDir = collect.snapshotDir;

        let oracle: AgentOracleResult | undefined;
        let oracleAttempts = 0;
        if (checks.length || task.forbiddenPaths?.length || task.rebuild) {
          const verify = checks;
          oracleAttempts = 1;
          if (verifierDir) {
            for (const f of task.files ?? []) writeFileNoFollow(verifierDir, f.path, f.content);
            // IMPL-098: o material de `testsDir` entra DEPOIS do agente e SÓ na
            // cópia do verificador (padrão Harbor/SWE-bench) — durante a
            // execução ele não existe no workspace. Mesma função da validação
            // (`task validate`): régua igual nos dois lados. O CLI já o resolveu
            // para absoluto (a etapa recusa relativo antes de executar).
            if (task.testsDir) copyTestsDirInto(task.testsDir, verifierDir);
          }
          // Checks (e rebuild) na CÓPIA com os fixtures prístinos; o hash dos
          // protegidos olha o workspace que o agente deixou (`guardDir`).
          const verifierRunner = verifierDir ? runners.verify(verifierDir) : undefined;
          oracle = await runOracle({
            workspaceDir: verifierDir ?? workspaceDir,
            guardDir: workspaceDir,
            runner: verifierRunner,
            // Rebuild precisa do registry: sandbox COM rede (o de setup) na mesma cópia.
            rebuildRunner: verifierDir ? runners.setup(verifierDir) : undefined,
            verify,
            forbiddenPaths: task.forbiddenPaths,
            diffFiles: collect.nameStatus,
            seedSnapshot: seedGuard,
            rebuild: task.rebuild,
            detectors: task.detectors,
            diff: collect.diff,
            onCheck: (c) =>
              emitEvent({
                type: 'agent.verified',
                runId,
                stageIndex,
                contestantId: contestant.id,
                execId,
                results: [c],
              }),
          });
          // Re-verificação CEGA só do check que nem começou (spawn), e só se o
          // oráculo ainda muda a nota. O evento marca a tentativa: o consumidor
          // não vê dois resultados "da mesma" verificação sem saber qual vale.
          while (
            oracleAttempts <= ORACLE_RETRIES &&
            !ctx.signal?.aborted &&
            shouldRecheckOracle(outcome.stopReason, oracle)
          ) {
            oracleAttempts += 1;
            const attempt = oracleAttempts;
            const indices = recheckIndices(oracle);
            // Mesma cópia e mesmo sandbox (IMPL-038): nunca o workspace do agente no host.
            const recheck = await runOracle({
              workspaceDir: verifierDir ?? workspaceDir,
              runner: verifierRunner,
              verify: indices.map((i) => ({ ...verify[i], label: oracle!.checks[i].label })),
              onCheck: (c) =>
                emitEvent({
                  type: 'agent.verified',
                  runId,
                  stageIndex,
                  contestantId: contestant.id,
                  execId,
                  results: [c],
                  attempt,
                }),
            });
            oracle = mergeOracleRecheck(oracle, indices, recheck);
          }
          if (ctx.signal?.aborted) throw new RunCancelled(ctx.signal.reason);
        }

        // Custo MEDIDO pelo proxy (`usage.cost` de cada chamada) substitui o
        // derivado do executor; o derivado fica como auditoria.
        const measured = execMeter.measured();
        const trajectory: AgentTrajectory = applyMeasuredCost(outcome.trajectory, measured);
        // F1 (§14 + reconciliação futura do proxy §20.4): persiste os
        // `responseIds` capturados pelo executor no próprio `trajectory.json`
        // como campo ADITIVO (cast — não altera o tipo `AgentTrajectory`). É a
        // ponte entre o custo DERIVADO 'agent-derived' reportado aqui e a
        // cobrança REAL do provedor, que virá por estes ids na reconciliação.
        (trajectory as unknown as { responseIds?: string[] }).responseIds = outcome.responseIds ?? [];
        const stopReason = outcome.stopReason;
        const durationMs = outcome.durationMs;
        // Erro de INFRA (provedor/rede — IMPL-036): sem veredito, salvo oráculo
        // conclusivo. Decidido AQUI, na fronteira do executor, ANTES da árvore:
        // para ela, `stopReason: 'error'` é "processo morreu" e contaria `nao`.
        // IMPL-039: rebuild de dependências que falhou (registry/rede fora,
        // lockfile ausente…) também é INFRA: os checks não rodaram e o oráculo
        // não disse nada sobre o agente — sem veredito, salvo violação (que é
        // conclusiva). Cancelamento segue a árvore (controle).
        const rebuildFalhou =
          oracle?.rebuild && !oracle.rebuild.ok && classifyStop(outcome.stopReason) !== 'cancelled'
            ? `rebuild de dependências falhou (\`${oracle.rebuild.cmd}\`, exit ${oracle.rebuild.exitCode}); checks não rodaram`
            : undefined;
        // IMPL-094: a CLASSE da falha do executor — transitória (provedor
        // 429/5xx, rede, sandbox morto) ou infra (erro do provedor que repetir não
        // conserta) —, decidida pelo TIPO do erro, nunca pelo resultado.
        const execFailure = classifyAgentFailure({ phase: 'execute', outcome, container });
        const infra = decideInfraError(execFailure?.reason ?? rebuildFalhou, oracle);
        // Sem veredito ⇒ a falha classificada (rebuild falho = infra, sem retry:
        // o agente não é refeito por causa do registry).
        const failure: AgentFailure | undefined =
          infra.kind !== 'no-verdict'
            ? undefined
            : (execFailure ?? { class: 'infra', reason: rebuildFalhou ?? 'falha de infraestrutura' });
        // A execução "falhou" de verdade? Infra resgatada pelo oráculo NÃO: ela
        // tem resultado verificável, fica `ok` e duela nas finais.
        const execFailed = stopReason === 'error' && infra.kind !== 'oracle-decides';

        // 5) dossiê (full, cego) + writeExecution (§16).
        const dossier = buildDossier({
          header: {
            stageQuestion: stage.question,
            contestantLabel,
            promptMode,
            limits: { maxTurns: limits.maxTurns ?? DEFAULT_MAX_TURNS, maxCostUsd: limits.maxCostUsd, timeoutMs: limits.timeoutMs ?? DEFAULT_TIMEOUT_MS },
            stopReason,
            turns: outcome.turns,
            durationMs,
            toolCalls: outcome.toolCalls,
            costUsd: trajectory.usage.costUsd,
            truncationNote: outcome.parseErrors ? `stream com ${outcome.parseErrors} linha(s) ilegível(eis)` : undefined,
          },
          oracle: oracle
            ? {
                checks: oracle.checks.map((c) => ({
                  label: c.label,
                  ok: c.ok,
                  exitCode: c.exitCode,
                  expected: c.expected,
                  tail: c.tail,
                  ...(c.notRun ? { notRun: c.notRun } : {}),
                })),
                score: oracle.score,
                violations: oracle.violations,
              }
            : undefined,
          diffStat: { files: collect.files, added: collect.added, removed: collect.removed },
          filesChanged: collect.nameStatus.map((f) => ({ path: f.path, status: f.status })),
          diff: collect.diff,
          steps: buildStepsFromTrajectory(trajectory),
          finalMessage: lastAssistantText(trajectory),
          parseErrors: outcome.parseErrors ?? trajectory.parseErrors ?? 0,
          redactIdentity: true,
          judgeTokens: agentConfig.dossierTokens ?? DEFAULT_DOSSIER_TOKENS,
          mode: 'full',
        });
        const dossierSha256 = sha256Of(dossier.text);

        const { dir } = await writeExecution({
          execId,
          runId,
          stageIndex,
          contestantId: contestant.id,
          repetition: rep,
          record: {
            format: 'agent-execution@1',
            execId,
            runId,
            stageIndex,
            contestantId: contestant.id,
            repetition: rep,
            invocation: {
              executor: { id: gateway.id, version: agentConfig.executorVersion, bin: prepared.bin },
              argv: [],
              env: redactEnv(env),
              cwd: workspaceDir,
              stdinSha256: sha256Of(stage.question),
              startedAt: trajectory.startedAt,
              finishedAt: trajectory.finishedAt,
            },
            workspace: {
              kind: task.repo ? 'worktree' : 'empty',
              repo: task.repo ? { url: task.repo.url, path: task.repo.path, ref: task.repo.ref } : undefined,
              seedCommit,
              afterCommit: collect.commitSha,
              files: collect.nameStatus.map((f) => ({
                path: f.path,
                status: f.status,
                added: collect.added,
                removed: collect.removed,
              })),
              diffStat: { files: collect.files, added: collect.added, removed: collect.removed },
              diffTruncated: collect.diffTruncated,
            },
            process: {
              exitCode: outcome.exitCode ?? null,
              signal: outcome.signal ?? null,
              stdoutBytes: 0,
              stderrBytes: 0,
            },
            trajectorySummary: {
              turns: outcome.turns,
              toolCalls: outcome.toolCalls,
              toolErrors: 0,
              stopReason,
              parseErrors: outcome.parseErrors ?? trajectory.parseErrors ?? 0,
              compactions: trajectory.compactions.length,
              byTool: {},
            },
            usage: {
              tokensIn: trajectory.usage.tokensIn,
              tokensOut: trajectory.usage.tokensOut,
              tokensReasoning: trajectory.usage.tokensReasoning,
              cacheRead: trajectory.usage.cacheRead,
              cacheWrite: trajectory.usage.cacheWrite,
              costUsd: trajectory.usage.costUsd,
              costSource: trajectory.usage.costSource,
              ...(trajectory.usage.agentDerivedCostUsd !== undefined
                ? { agentDerivedCostUsd: trajectory.usage.agentDerivedCostUsd }
                : {}),
              proxy: {
                calls: measured.calls,
                exact: measured.exact,
                estimated: measured.estimated,
                unknown: measured.unknown,
                refused: measured.refused,
                generationIds: measured.generationIds,
                ...(brakeStop
                  ? {
                      budgetStop: {
                        scope: brakeStop.scope,
                        committedUsd: brakeStop.committedUsd,
                        projectedUsd: brakeStop.projectedUsd,
                        limitUsd: brakeStop.limitUsd,
                      },
                    }
                  : {}),
              },
            },
            oracle,
            dossier: {
              sha256: dossierSha256,
              tokensApprox: dossier.tokensApprox,
              truncatedSections: dossier.truncatedSections,
              complete: dossier.complete,
              redactions: dossier.redactions,
              mode: 'full',
              marker: dossier.marker,
              neutralized: dossier.neutralized,
            },
            digests: {},
            sandbox: {
              mode: runners.mode,
              isolated: runners.isolated,
              setup: runners.mode === 'container' ? 'sandbox' : 'host',
              verify: runners.mode === 'container' ? 'sandbox' : 'host',
              collect: 'tree-copy',
              ...(runners.setupNetwork ? { setupNetwork: runners.setupNetwork } : {}),
              ...(runners.verifierImage ? { verifierImage: runners.verifierImage } : {}),
              ...(runners.isolated ? {} : { note: 'modo host: sem isolamento (setup/verify/agente com o uid do operador)' }),
            },
          },
          // Os arquivos crus que o executor gravou no dir (events.raw.jsonl,
          // stderr.raw.log, argv.json, session/ do copy-out) também entram no
          // digests.json — a conferência cobre o dir inteiro (IMPL-038).
          includeExisting: true,
          artifacts: {
            'trajectory.json': JSON.stringify(trajectory, null, 2),
            'dossier.md': dossier.text,
            'workspace.diff': collect.diff,
            'workspace.stat': collect.statText,
            'files.json': JSON.stringify(collect.nameStatus, null, 2),
            ...(oracle ? { 'oracle.json': JSON.stringify(oracle, null, 2) } : {}),
            // REMOVIDOS os placeholders vazios 'stdout.log'/'events.jsonl' (eram
            // sempre ''): o executor (pi) grava agora os arquivos CRUS de
            // auditoria — `<workDir>/events.raw.jsonl` (JSONL íntegro do stdout)
            // e `<workDir>/stderr.raw.log` (stderr INTEGRAL) — diretamente no
            // próprio dir de execução (workDir === execDir aqui, ver
            // `execDir`/`pi.run`), que é a fonte de auditoria (§14 do plano).
            // `stderr.log` (tail) continua por reflexo para leituras curtas.
            'stderr.log': outcome.stderrTail ?? '',
          },
        });

        const execution: ExecutionRef = {
          execId,
          repetition: rep,
          dir,
          turns: outcome.turns,
          toolCalls: outcome.toolCalls,
          durationMs,
          stopReason,
          ...(execFailure ? { infraError: execFailure.reason } : {}),
          diffStat: { files: collect.files, added: collect.added, removed: collect.removed },
          oracle: oracle
            ? {
                passed: oracle.checks.filter((c) => c.ok).length,
                failed: oracle.checks.filter((c) => !c.ok).length,
                score: oracle.score,
              }
            : undefined,
          dossierSha256,
          dossierTruncated: !dossier.complete,
          parseErrors: outcome.parseErrors ?? trajectory.parseErrors ?? 0,
        };

        // 6) VEREDITO da repetição — árvore de 9 caminhos (`verdictTree.ts`). O
        //    juiz LLM só roda nos caminhos que graduam (oráculo 100%/parcial ou
        //    sem oráculo com diff), CONFINADO à faixa do oráculo; corte por
        //    limite é 'nao' sem juiz; check que não terminou já é falho no score.
        //    Erro de INFRA (IMPL-036) sem oráculo conclusivo: SEM veredito (a
        //    árvore contaria 'error' como processo morto => 'nao'); com oráculo
        //    conclusivo, a árvore decide como numa execução concluída (o
        //    `stopReason` gravado continua 'error').
        const adjudication: SettledRepVerdict & { path: VerdictPath } =
          infra.kind === 'no-verdict'
            ? { verdict: null, explanation: infra.explanation, judgeUsed: false, path: 'error' }
            : await adjudicateRep({
                stopReason: infra.kind === 'oracle-decides' ? 'completed' : stopReason,
                oracle,
                diffEmpty: collect.files === 0 && collect.added === 0 && collect.removed === 0,
                stage,
                dossierText: dossier.text,
                contestantId: contestant.id,
                judgeModelIds,
                apiKey,
                ctx,
              });

        const repResult: AgentRepResult = {
          repetition: rep,
          execution,
          stopReason,
          oracle,
          verdict: adjudication.verdict,
          path: adjudication.path,
          explanation: adjudication.explanation,
          judgeUsed: adjudication.judgeUsed,
          ...(adjudication.source ? { source: adjudication.source } : {}),
          ...(adjudication.judgeError ? { judgeError: adjudication.judgeError } : {}),
          ...(adjudication.judgeVerdictBeforeClamp
            ? { judgeVerdictBeforeClamp: adjudication.judgeVerdictBeforeClamp }
            : {}),
          ...(adjudication.judgeRubric ? { judgeRubric: adjudication.judgeRubric } : {}),
          ...(oracleAttempts > 0 ? { oracleAttempts } : {}),
          costUsd: trajectory.usage.costUsd,
          ...(infra.kind === 'no-verdict' ? { infraError: infra.explanation } : {}),
          ...(failure ? { infraClass: failure.class } : {}),
        };
        // O `verdict.json` (auditoria POR REP) é gravado pelo laço, que sabe das
        // tentativas — o exec.json fica aqui, na coleta.

        // 7) Ledger. Com chamadas pelo proxy, CADA uma já foi anotada lá (papel
        //    'agent', `usage.cost` medido) — anotar de novo aqui contaria em
        //    dobro. Só um executor que NÃO passou pelo proxy (fake, adaptador sem
        //    base URL configurável) cai no custo DERIVADO dele, anotado aqui
        //    com a fonte real (IMPL-096).
        if (measured.calls === 0 && trajectory.usage.costUsd > 0) {
          try {
            // IMPL-096: reserva NULA (o gasto já aconteceu — a reserva de 0
            // tokens só poluía o ledger) e fonte HONESTA: 'agent-derived' para o
            // que o executor calculou, 'usage' para medido/reconciliado no
            // gateway, 'catalog' só para estimativa por tabela — nunca
            // 'unknown', nunca 'catalog' para valor reportado pelo executor.
            ctx.sink?.note(
              { release: () => undefined },
              {
                role: 'agent',
                modelId,
                cost: { usd: trajectory.usage.costUsd, source: ledgerCostSource(trajectory.usage.costSource) },
                tokensIn: trajectory.usage.tokensIn,
                tokensOut: trajectory.usage.tokensOut,
              },
            );
            // O teto da RUN vira sinal de controle DEPOIS do registo — antes era
            // o `reserve(0,0)` que disparava e ele PERDIA o gasto da rep que
            // estourava (contava em menos o que já saiu do bolso). O snapshot é
            // acessado de forma estrutural: `CostSink` não o declara, mas todo
            // ledger real tem (um sink-espelho sem ele só não tem porta dura).
            const snap = (
              ctx.sink as { snapshot?: () => { budgetUsd?: number; committedUsd: number; spentUsd: number } } | undefined
            )?.snapshot?.();
            if (snap && snap.budgetUsd !== undefined && snap.committedUsd > snap.budgetUsd) {
              throw new BudgetExceeded(snap.spentUsd, snap.budgetUsd, 'agent');
            }
          } catch (err) {
            if (isControlSignal(err)) throw err; // fronteira de controle
          }
        }

        emitEvent({
          type: 'agent.finished',
          runId,
          stageIndex,
          contestantId: contestant.id,
          execId,
          stopReason,
          turns: outcome.turns,
          costUsd: Math.round(trajectory.usage.costUsd * 10000) / 10000,
          diffStat: { files: collect.files, added: collect.added, removed: collect.removed },
        });

        return {
          rep: repResult,
          response:
            rep === 0
              ? {
                  contestantId: contestant.id,
                  modelId,
                  text: summarizeResponse(repResult),
                  latencyMs: durationMs,
                  tokensIn: trajectory.usage.tokensIn,
                  tokensOut: trajectory.usage.tokensOut,
                  costUsd: trajectory.usage.costUsd,
                  status: execFailed ? 'error' : 'ok',
                  errorMsg: execFailed ? (outcome.stderrTail ?? 'execução falhou') : undefined,
                  execution,
                }
              : undefined,
          execFailed,
          costUsd: trajectory.usage.costUsd,
          tokensIn: trajectory.usage.tokensIn,
          tokensOut: trajectory.usage.tokensOut,
          ...(failure ? { failure } : {}),
        };
      } catch (err) {
        // Falha não-controlada numa tentativa (IMPL-094 — fim do A5): NUNCA
        // vira 'nao'. A fase diz a classe: workspace (clone/setup/fixtures) =
        // DEFEITO da tarefa (a etapa sai para todos); executor que lançou =
        // pelo tipo (429/5xx/rede/sandbox morto = transitória, refeita às cegas;
        // comando ausente = defeito; resto = infra); coleta/oráculo/escrita =
        // infra. Controle (orçamento/cancelamento) SOBE: é o único caminho para
        // `incomplete`.
        if (isControlSignal(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        const failure = classifyAgentFailure({ phase, error: err, container }) ?? { class: 'infra' as const, reason: msg };
        // Dinheiro é medido: o que o proxy já anotou desta tentativa (no ledger,
        // por chamada) entra no custo da rep — nunca "custou zero" por ter lançado.
        const medido = execMeter?.measured();
        const perdida: AgentRepResult = {
          repetition: rep,
          execution: emptyExecution(relativeDir, rep, 0, 0, 0, 'error'),
          stopReason: 'error',
          verdict: null,
          path: 'error',
          explanation: failureExplanation(failure),
          judgeUsed: false,
          infraError: failure.reason,
          infraClass: failure.class,
          costUsd: medido?.usd ?? 0,
        };
        return {
          rep: perdida,
          response: rep === 0 ? responseError(contestant, modelId, msg, medido?.usd ?? 0) : undefined,
          execFailed: true,
          costUsd: medido?.usd ?? 0,
          tokensIn: medido?.tokensIn ?? 0,
          tokensOut: medido?.tokensOut ?? 0,
          failure,
        };
      } finally {
        // NADA aqui pode lançar (revisão IMPL-038): o `verify` roda código do
        // agente na cópia e pode deixar diretório 0555/0000 lá dentro — um
        // EACCES neste `finally` derrubaria as reps seguintes, pularia o
        // dispose e sumiria com o contestant da etapa (sem resposta, sem 'nao').
        try {
          credential?.revoke();
        } catch {
          /* melhor esforço */
        }
        try {
          execMeter?.close();
        } catch {
          /* melhor esforço */
        }
        if (verifierDir && !removeTreeBestEffort(verifierDir)) {
          console.error(`[agent] ⚠️ cópia do verificador não pôde ser apagada: ${verifierDir}`);
        }
        // 9) dispose do workspace (preserva com isolation.keepWorkspace).
        const keep = agentConfig.isolation?.keepWorkspace === true;
        try {
          if (!keep && workspaceDir) await workspaceMgr.dispose(cacheRepoDir, workspaceDir);
          else if (keep && workspaceDir) {
            // 1ª linha = workspace (formato antigo); 2ª = repo de AUDITORIA
            // (seed/agent-result), que também fica para o debug.
            writeFileSync(path.join(repAbs, '.workspace-kept'), `${workspaceDir}\n${auditGitDir}\n`, 'utf8');
          }
        } catch {
          /* melhor esforço */
        }
      }
  };

  for (let rep = 0; rep < reps; rep++) {
    const relativeDir = execDir(runId, stageIndex, contestant.id, rep);
    const repAbs = path.join(dataDir, relativeDir);
    // IMPL-094: retentativa CEGA — decidida pela CLASSE da falha (transitória)
    // e pelo teto (2), nunca pelo resultado: tentativa que produziu observação
    // (qualquer veredito) jamais é refeita. As descartadas ficam arquivadas e
    // pagas (o custo delas soma na rep e na resposta).
    const descartadas: DiscardedAttempt[] = [];
    let custoRep = 0;
    let a = await attemptOnce(rep, relativeDir, repAbs);
    for (let attempt = 1; ; attempt++) {
      totalCostUsd += a.costUsd;
      totalTokensIn += a.tokensIn;
      totalTokensOut += a.tokensOut;
      custoRep += a.costUsd;
      if (!shouldRetryAttempt(a.failure?.class, attempt) || ctx.signal?.aborted) break;
      writeVerdictArtifact(repAbs, { ...a.rep, attempts: attempt }, { discarded: true });
      const arquivado = archiveAttemptDir(repAbs, attempt);
      descartadas.push({
        attempt,
        reason: a.failure!.reason,
        costUsd: a.costUsd,
        ...(arquivado ? { dir: path.relative(dataDir, arquivado) } : {}),
      });
      console.error(
        `[agent] etapa ${stageIndex + 1} · ${contestant.id} · rep ${rep}: falha transitória ` +
          `(${a.failure!.reason.slice(0, 160)}) — retentativa cega ${attempt}/${INFRA_RETRIES}`,
      );
      a = await attemptOnce(rep, relativeDir, repAbs);
    }
    const attempts = descartadas.length + 1;
    const repResult: AgentRepResult = {
      ...a.rep,
      // Sem veredito por infra depois das retentativas: a explicação diz quantas.
      ...(a.rep.verdict === null && a.failure && a.failure.class !== 'defect' && attempts > 1
        ? { explanation: failureExplanation(a.failure, attempts) }
        : {}),
      attempts,
      costUsd: custoRep,
      ...(descartadas.length > 0 ? { discardedAttempts: descartadas } : {}),
    };
    repResults.push(repResult);
    // Auditoria POR REP depois da run: o exec.json é gravado ANTES da
    // adjudicação e o RunRecord só guarda contagens — sem isto não dá para
    // saber qual execução teve o juiz falho/confinado ou quantas tentativas.
    writeVerdictArtifact(repAbs, repResult);
    anyError = anyError || a.execFailed;
    if (rep === 0 && a.response) response = a.response;
    // Defeito da tarefa/ambiente: a etapa sai para TODOS (orquestrador) — as
    // reps seguintes deste contestant só gastariam.
    if (a.failure?.class === 'defect') break;
  }

  // `incomplete` é SÓ cancelamento (e ele sobe antes daqui). Rep sem veredito
  // (sem oráculo, juiz falho/não chamado) é "sem observação", não controle.
  const incomplete = response === null || repResults.every((r) => r.path === 'cancelled');

  if (response === null) {
    response = {
      contestantId: contestant.id,
      modelId,
      text: 'agente: sem execução válida',
      latencyMs: 0,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      costUsd: totalCostUsd,
      status: anyError ? 'error' : 'ok',
      errorMsg: anyError ? 'todas as repetições falharam' : undefined,
    };
  } else {
    // Contrato: costUsd/tokens da resposta = somatório das reps.
    response = { ...response, costUsd: totalCostUsd, tokensIn: totalTokensIn, tokensOut: totalTokensOut };
  }

  return { response, repResults, incomplete, errorMsg: anyError ? response.errorMsg : undefined };
}

// ---------------------------------------------------------------------------
// Veredito da repetição — a ÁRVORE de 9 caminhos e o fechamento dentro da
// faixa do oráculo vivem, puros, em `verdictTree.ts` (IMPL-032: corte por limite
// conta 'nao'; IMPL-033: juiz confinado ao oráculo, falha do juiz cai no
// oráculo + judgeError). Aqui só se CHAMA o juiz LLM nos caminhos que graduam.
// ---------------------------------------------------------------------------

/**
 * Explicação de `nao` por violação, separando CAMINHO PROTEGIDO de ACHADO DOS
 * DETECTORES (modo `fail`): "arquivos proibidos modificados: src/x.ts" para um
 * `|| true` num arquivo de código enganava quem lê o veredito.
 */
function violationExplanation(oracle: AgentOracleResult): string {
  const byDetector = new Set(oracle.detectorViolations ?? []);
  const protectedPaths = oracle.violations.filter((p) => !byDetector.has(p));
  const parts: string[] = [];
  if (protectedPaths.length > 0) parts.push(`arquivos proibidos modificados: ${protectedPaths.join(', ')}`);
  if (byDetector.size > 0) {
    const kinds = (p: string): string =>
      [...new Set((oracle.findings ?? []).filter((f) => f.path === p).map((f) => f.kind))].join('/') || 'suspeito';
    parts.push(`atalho suspeito (detectores em modo fail): ${[...byDetector].map((p) => `${p} [${kinds(p)}]`).join(', ')}`);
  }
  return parts.join('; ');
}

async function adjudicateRep(opts: {
  stopReason: AgentStopReason;
  oracle?: AgentOracleResult;
  diffEmpty: boolean;
  stage: StageSpec;
  dossierText: string;
  contestantId: string;
  judgeModelIds: string[];
  apiKey: string;
  ctx: RunCtx;
}): Promise<SettledRepVerdict & { path: VerdictPath }> {
  const { stopReason, oracle, diffEmpty, stage, dossierText, contestantId, judgeModelIds, apiKey, ctx } = opts;
  const d0 = decideRepVerdict({ stopReason, oracle, diffEmpty });
  // IMPL-039: violação separa CAMINHO PROTEGIDO de ACHADO DOS DETECTORES.
  const d =
    d0.kind === 'final' && d0.path === 'oracle-violation' && oracle
      ? { ...d0, explanation: violationExplanation(oracle) }
      : d0;

  // Cancelamento (quem chama re-lança RunCancelled — §18.3; defensivo, o laço
  // já sobe o sinal antes daqui) e veredito final: sem juiz.
  if (d.kind !== 'judge') return { ...settleRepVerdict(d), path: d.path };

  const outcome = await callJudge({ stage, dossierText, contestantId, judgeModelIds, apiKey, ctx });
  return { ...settleRepVerdict(d, outcome), path: d.path };
}

/**
 * Chama o juiz de dossiê e traduz o resultado em `JudgeOutcome`. Nunca lança
 * erro comum: `judgeDossier` já re-tenta 2× e devolve a falha estruturada; um
 * erro inesperado aqui também vira falha (`judgeError`), nunca 'parcial'.
 * Controle (orçamento/cancelamento) sobe na fronteira.
 */
async function callJudge(opts: {
  stage: StageSpec;
  dossierText: string;
  contestantId: string;
  judgeModelIds: string[];
  apiKey: string;
  ctx: RunCtx;
}): Promise<JudgeOutcome> {
  const { stage, dossierText, contestantId, judgeModelIds, apiKey, ctx } = opts;
  // Sem juiz configurado — ou dossiê vazio, sem nada a ler — não há graduação:
  // o veredito do oráculo permanece (sem oráculo, nenhum). O juiz nem foi
  // chamado: não é falha do juiz e não levanta `judgeError`.
  if (judgeModelIds.length === 0) return { status: 'skipped', reason: 'sem juiz configurado' };
  if (!dossierText.trim()) return { status: 'skipped', reason: 'dossiê vazio (nada para o juiz ler)' };
  try {
    const j = await judgeDossier({ stage, dossierText, contestantId, judgeModelIds, apiKey, ctx });
    if (j.verdict === null && j.skipped) return { status: 'skipped', reason: j.explanation };
    if (j.verdict === null) {
      return {
        status: 'failed',
        error: j.judgeError ?? { kind: 'judge_failed', message: j.explanation },
        attempts: j.attempts,
      };
    }
    return {
      status: 'ok',
      verdict: j.verdict,
      explanation: j.explanation,
      degraded: j.degraded,
      ...(j.rubric ? { rubric: j.rubric } : {}),
    };
  } catch (err) {
    if (isControlSignal(err)) throw err;
    if (ctx.signal?.aborted) throw new RunCancelled(ctx.signal.reason);
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 160);
    return { status: 'failed', error: { kind: 'judge_failed', message }, attempts: 1 };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSystemPrompt(opts: RunAgentStageParams): string {
  const { stage, contestant } = opts;
  const parts: string[] = [stage.productContext ?? ''];
  if (contestant.systemPrompt) parts.push(contestant.systemPrompt);
  return parts.filter((p) => p.trim().length > 0).join('\n\n');
}

function lastAssistantText(trajectory: AgentTrajectory): string | undefined {
  for (let i = trajectory.turns.length - 1; i >= 0; i--) {
    const t = trajectory.turns[i];
    if (t.text && t.text.trim().length > 0) return t.text;
  }
  return undefined;
}

/** Traduz a trajetória na lista de passos do dossiê (§16.3 seção 5). */
function buildStepsFromTrajectory(
  trajectory: AgentTrajectory,
): { turn: number; tool: string; arg: string; ok: boolean; exitCode?: number; outputTail?: string }[] {
  const steps: { turn: number; tool: string; arg: string; ok: boolean; exitCode?: number; outputTail?: string }[] = [];
  for (const turn of trajectory.turns) {
    for (const step of turn.steps) {
      steps.push({
        turn: turn.index + 1,
        tool: step.tool,
        arg: summarizeArgs(step.args),
        ok: step.ok,
        exitCode: step.exitCode,
        outputTail: !step.ok ? step.output : undefined,
      });
    }
  }
  return steps;
}

function summarizeArgs(args?: Record<string, unknown>): string {
  if (!args) return '';
  if (typeof args.command === 'string') return args.command;
  if (typeof args.file_path === 'string') return args.file_path;
  if (typeof args.path === 'string') return args.path;
  const entries = Object.entries(args)
    .slice(0, 2)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 120) : JSON.stringify(v).slice(0, 120)}`);
  return entries.join(' ');
}

/**
 * `verdict.json` no diretório da execução: o veredito da REP, a origem, o
 * caminho da árvore, a flag `judgeError`, o veredito cru do juiz quando a
 * faixa o confinou e as tentativas do oráculo. Escrita atômica (tmp+rename) e
 * melhor esforço: falha de disco aqui não derruba a rep nem muda a nota.
 * O `exec.json`/`digests.json` fecham ANTES (são a coleta); este arquivo é a
 * adjudicação. A invalidação da etapa inteira (defeito do ambiente) é decidida
 * depois, na célula, e fica no `StageRecord.error` do RunRecord.
 */
function writeVerdictArtifact(absDir: string, rep: AgentRepResult, extra: { discarded?: boolean } = {}): void {
  const payload = {
    format: 'agent-verdict@1',
    verdictTreeVersion: AGENT_VERDICT_TREE_VERSION,
    ...(extra.discarded ? { discarded: true } : {}),
    execId: rep.execution.execId,
    repetition: rep.repetition,
    stopReason: rep.stopReason,
    path: rep.path,
    verdict: rep.verdict,
    ...(rep.source ? { source: rep.source } : {}),
    judgeUsed: rep.judgeUsed,
    ...(rep.judgeError ? { judgeError: rep.judgeError } : {}),
    ...(rep.judgeVerdictBeforeClamp ? { judgeVerdictBeforeClamp: rep.judgeVerdictBeforeClamp } : {}),
    ...(rep.judgeRubric ? { judgeRubric: rep.judgeRubric } : {}),
    ...(rep.oracle
      ? {
          oracle: {
            score: rep.oracle.score,
            violations: rep.oracle.violations,
            attempts: rep.oracleAttempts ?? 1,
            notRun: rep.oracle.checks
              .filter((c) => c.notRun !== undefined)
              .map((c) => ({ label: c.label, cause: c.notRun })),
          },
        }
      : {}),
    explanation: rep.explanation,
    // IMPL-094: tentativas contadas; classe da falha que não é do agente.
    ...(rep.attempts !== undefined ? { attempts: rep.attempts } : {}),
    ...(rep.infraClass ? { infraClass: rep.infraClass } : {}),
    ...(rep.discardedAttempts?.length ? { discardedAttempts: rep.discardedAttempts } : {}),
  };
  const target = path.join(absDir, 'verdict.json');
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, target);
  } catch {
    /* melhor esforço — a nota já está no AgentRepResult */
  }
}

/** IMPL-098: problema do `testsDir` da tarefa na RUN (absoluto e diretório), ou `undefined`. */
function testsDirIssue(task: NonNullable<StageSpec['agentTask']>): string | undefined {
  const td = task.testsDir;
  if (!td) return undefined;
  if (!path.isAbsolute(td)) {
    return (
      `testsDir "${td}" relativo sem diretório de origem — só \`agents run --config <arq>\` o resolve ` +
      '(pelo diretório do arquivo)'
    );
  }
  try {
    if (!statSync(td).isDirectory()) return `testsDir "${td}" não é um diretório`;
  } catch {
    return `testsDir "${td}" não existe`;
  }
  return undefined;
}

function responseError(contestant: Contestant, modelId: string, errorMsg: string, costUsd: number): CompetitorResponse {
  return {
    contestantId: contestant.id,
    modelId,
    text: 'agente: falha na execução',
    latencyMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd,
    status: 'error',
    errorMsg,
  };
}

/**
 * Repetições perdidas ANTES de executar por DEFEITO da tarefa/ambiente (sem
 * tarefa, testsDir inválido, executor/sandbox/proxy que não sobe): uma por rep,
 * SEM veredito e com `infraClass: 'defect'` — o orquestrador invalida a etapa
 * para TODOS (IMPL-094). Nunca 'nao' (a falha não é do contestant) e nunca
 * `incomplete` (não é controle).
 */
function defectReps(
  runId: string,
  stageIndex: number,
  contestantId: string,
  reps: number,
  msg: string,
): AgentRepResult[] {
  const failure: AgentFailure = { class: 'defect', reason: msg };
  return Array.from({ length: reps }, (_, rep) => ({
    repetition: rep,
    execution: emptyExecution(execDir(runId, stageIndex, contestantId, rep), rep, 0, 0, 0, 'error'),
    stopReason: 'error' as const,
    verdict: null,
    path: 'error' as const,
    explanation: failureExplanation(failure),
    judgeUsed: false,
    infraError: msg,
    infraClass: 'defect' as const,
    attempts: 0,
    costUsd: 0,
  }));
}

function emptyExecution(
  dir: string,
  rep: number,
  turns: number,
  toolCalls: number,
  durationMs: number,
  stopReason: AgentStopReason,
): ExecutionRef {
  return { execId: '', repetition: rep, dir, turns, toolCalls, durationMs, stopReason };
}

// Re-export p/ o orquestrador agregar vereditos de reps sem importar direto.
export { aggregateAgentVerdict };