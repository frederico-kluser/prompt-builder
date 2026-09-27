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
// - O executor (`piExecutor.run`) recebe a tarefa pelo env `PI_TASK` OU
//   `<workDir>/task.txt`; o system prompt pelo env `PI_SYSTEM_PROMPT` OU
//   `<workDir>/system-prompt.txt`; o modelo pelo env `PI_MODEL_ID`. O 2º
//   parâmetro (`PiRunOptions`) leva signal + priceTokensIn/Out do catálogo.
// - O executor NÃO expõe os events crus do stream `--mode json` (consome-os
//   internamente) e devolve a `trajectory` já normalizada no `outcome`. Por isso
//   este módulo usa `outcome.trajectory` direto (§10 passo 9). Um gateway
//   injetado (fake no smoke) devolve a MESMA forma.
// - A `CompetitorResponse.execution` é um `ExecutionRef` RELATIVO a getDataDir().
// ----------------------------------------------------------------------------
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentRunOpts, PrepareOpts } from './executor.js';
import { piExecutor } from './pi.js';
import type { PiRunOptions, PiRunOutcome } from './pi.js';
import { createWorkspaceManager, type CollectResult } from './workspace.js';
import { execDir, redactEnv, sha256Of, writeExecution } from './store.js';
import { buildDossier } from './dossier.js';
import { captureSeedGuard, runOracle } from './oracle.js';
import { aggregateAgentVerdict, judgeDossier } from './agentJudge.js';
import { decideInfraError } from './infraError.js';
import { acquireRunInferenceProxy, type InferenceProxyLease } from './inferenceProxy.js';
import { isControlSignal, RunCancelled } from '../budget.js';
import { emitEvent } from '../events.js';
import { blindRankMap, seedFromId } from '../duels.js';
import { getGateway, tierFor } from '../openrouter.js';
import type {
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
  OpenRouterModel,
  RunCtx,
  StageSpec,
  Verdict,
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
  /** null = incomplete (§18.3 — fora do placar, sem contar 'nao'). */
  verdict: Verdict | null;
  explanation: string;
  /** true quando o juiz LLM rodou de verdade nesta repetição. */
  judgeUsed: boolean;
  costUsd: number;
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
}

export interface RunAgentStageResult {
  response: CompetitorResponse; // text = resumo 1 linha; execution = rep 0
  repResults: AgentRepResult[]; // 1 por repetição
  /** true = todas as repetições ficaram incomplete (não pontua). */
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
  run(opts: AgentRunOpts, base?: PiRunOptions): Promise<PiRunOutcome>;
}

const DEFAULT_GATEWAY: AgentGateway = {
  id: piExecutor.id,
  prepare: (o) => piExecutor.prepare(o),
  // O `AgentExecutor.run` da interface declara só 1 parâmetro, mas a
  // implementação do pi aceita o 2º (`PiRunOptions`). O cast modela o contrato
  // REAL de `piExecutor.run` (2º param opcional) sem tocar em executor.ts.
  run: piExecutor.run as (opts: AgentRunOpts, base?: PiRunOptions) => Promise<PiRunOutcome>,
};

// ---------------------------------------------------------------------------
// Defaults (espelham §AgentLimits do plano — o executor usa os mesmos).
// ---------------------------------------------------------------------------
const DEFAULT_MAX_TURNS = 30;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_DIFF_BYTES = 512 * 1024;
const DEFAULT_DOSSIER_TOKENS = 12_000;

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
    return t * tierFor(model.pricing, Math.max(1, t))[kind];
  };
  return {
    priceTokensIn: (n) => rate(n, 'prompt'),
    priceTokensOut: (n) => rate(n, 'completion'),
  };
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
  const { runId, contestant, stage, agentConfig, apiKey, dataDir, forcedPromptMode } = opts;
  const gateway = opts.gateway ?? DEFAULT_GATEWAY;
  const task = stage.agentTask;
  const judgeModelIds = opts.judgeModelIds ?? [];

  if (!task) {
    return {
      response: {
        contestantId: contestant.id,
        modelId: contestant.modelId,
        text: 'agente: sem tarefa executável nesta etapa',
        latencyMs: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        status: 'error',
        errorMsg: 'Etapa sem agentTask para contestant com runner=agent',
      },
      repResults: [],
      incomplete: true,
      errorMsg: 'Etapa sem agentTask para contestant com runner=agent',
    };
  }

  const reps = Math.max(1, agentConfig.repetitions ?? 1);
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
    const errorMsg = `Falha ao preparar o executor (${agentConfig.executorVersion})`;
    return {
      response: responseError(contestant, modelId, errorMsg, 0),
      repResults: [],
      incomplete: true,
      errorMsg,
    };
  }

  // Proxy de inferência da RUN (IMPL-037 / R-15 DEC-2): a key real (`apiKey`)
  // fica NELE; o agente recebe só base URL local + token fictício por execução.
  // Modo container: socket Unix (o sandbox roda com `--network none`); modo
  // host: TCP no loopback. Upstream = gateway do processo (OPENROUTER_BASE_URL).
  // UM por run: as etapas paralelas pegam empréstimos do mesmo proxy e o último
  // a devolver o fecha. O log redigido fica em `<runDir>/inference-proxy.jsonl`,
  // fora de qualquer mount do sandbox.
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
    });
  } catch (err) {
    if (isControlSignal(err)) throw err;
    const errorMsg = `Falha ao subir o proxy de inferência local: ${(err as Error).message}`;
    return {
      response: responseError(contestant, modelId, errorMsg, 0),
      repResults: [],
      incomplete: true,
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
    });
  } finally {
    await proxyLease.release();
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
}

/** As N repetições da etapa (o laço do §10), com o proxy da run já no ar. */
async function runAgentReps(opts: RunAgentStageParams, rc: RepsContext): Promise<RunAgentStageResult> {
  const { runId, stageIndex, contestant, stage, agentConfig, apiKey, ctx, dataDir, catalog } = opts;
  const { gateway, task, judgeModelIds, reps, promptMode, runConfig, limits, modelId, systemPrompt, prepared, proxy } = rc;

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

  for (let rep = 0; rep < reps; rep++) {
      const relativeDir = execDir(runId, stageIndex, contestant.id, rep);
      const repAbs = path.join(dataDir, relativeDir);
      mkdirSync(repAbs, { recursive: true });

      let workspaceDir = '';
      let seedCommit = '';
      let cacheRepoDir = '';
      let credential: ReturnType<typeof proxy.issueCredential> | undefined;

      try {
        // 1) workspace.prepare() — setup[] + files[] + seedCommit (§10.1).
        const ws = await workspaceMgr.prepare({
          repo: task.repo,
          setup: task.setup,
          files: task.files,
          limits,
        });
        workspaceDir = ws.workspaceDir;
        seedCommit = ws.seedCommit;
        cacheRepoDir = ws.cacheRepoDir;
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
        // antigo/injetado a estampar: quem a detém é o proxy da run.
        const { OPENROUTER_API_KEY: _keyFora, ...preparedEnv } = prepared.env;
        void _keyFora;
        const env = {
          ...preparedEnv,
          PI_MODEL_ID: modelId,
          PI_TASK: stage.question,
          PI_SYSTEM_PROMPT: systemPrompt,
        };
        // Token fictício DESTA execução (mapeamento execução → chamada conhecido
        // só do produto); revogado assim que a execução termina.
        credential = proxy.issueCredential({ runId, stageIndex, contestantId: contestant.id, repetition: rep, execId, role: 'agent' });
        const inference = proxy.route(credential);

        const outcome = await gateway.run(
          { execId, task, config: runConfig, workspaceDir, workDir: repAbs, bin: prepared.bin, env, inference },
          {
            signal: ctx.signal,
            priceTokensIn: price.priceTokensIn,
            priceTokensOut: price.priceTokensOut,
            // onEvent é a ponte p/ emissão mínima de progresso do agente rodando.
            onEvent: (e) => {
              if (e.type === 'turn' && execId) {
                emitEvent({
                  type: 'agent.turn',
                  runId,
                  stageIndex,
                  contestantId: contestant.id,
                  execId,
                  turn: e.index,
                  // Emissão mínima de progresso; o custo real sai no agent.finished.
                  costUsd: 0,
                });
              }
            },
          },
        );

        // §18.3/§29.3: cancelamento da RUN é sinal de controle e SOBE — não vira
        // 'incomplete' mudo (o pipeline precisa saber que a run foi abortada).
        if (ctx.signal?.aborted || outcome.stopReason === 'cancelled') {
          throw new RunCancelled(ctx.signal?.reason);
        }

        // 4) collect (diff/stat/files) + oráculo + trajetória (§10.4-9).
        const collect = await workspaceMgr.collect(workspaceDir, seedCommit, limits.maxDiffBytes);

        let oracle: AgentOracleResult | undefined;
        if (task.verify?.length || task.forbiddenPaths?.length || task.rebuild) {
          oracle = await runOracle({
            workspaceDir,
            verify: task.verify ?? [],
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
        }

        const trajectory: AgentTrajectory = outcome.trajectory;
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
        const infra = decideInfraError(outcome.infraError, oracle);
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
            },
            oracle,
            dossier: {
              sha256: dossierSha256,
              tokensApprox: dossier.tokensApprox,
              truncatedSections: dossier.truncatedSections,
              complete: dossier.complete,
              redactions: dossier.redactions,
              mode: 'full',
            },
            digests: {},
          },
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
          ...(outcome.infraError ? { infraError: outcome.infraError } : {}),
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

        // 6) VEREDITO da repetição (§17.1 / §18.3 / §15.2). Só o serve quem NÃO
        //    ficou incomplete e precisa de juiz LLM (graduação / sem oráculo).
        const adjudication =
          infra.kind === 'no-verdict'
            ? { verdict: null, explanation: infra.explanation, judgeUsed: false }
            : await adjudicateRep({
                // Oráculo conclusivo após erro de infra: a árvore decide como numa
                // execução concluída (o `stopReason` gravado continua 'error').
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

        repResults.push({
          repetition: rep,
          execution,
          stopReason,
          oracle,
          verdict: adjudication.verdict,
          explanation: adjudication.explanation,
          judgeUsed: adjudication.judgeUsed,
          costUsd: trajectory.usage.costUsd,
        });
        anyError = anyError || execFailed;

        // 7) Ledger: UMA nota por rep (§20.3) — custo derivado, nunca 'unknown'.
        try {
          const reservation = ctx.sink?.reserve('agent', modelId, 0, 0) ?? { release: () => undefined };
          ctx.sink?.note(reservation, {
            role: 'agent',
            modelId,
            cost: { usd: trajectory.usage.costUsd, source: 'catalog' },
            tokensIn: trajectory.usage.tokensIn,
            tokensOut: trajectory.usage.tokensOut,
          });
        } catch (err) {
          if (isControlSignal(err)) throw err; // fronteira de controle
        }

        totalCostUsd += trajectory.usage.costUsd;
        totalTokensIn += trajectory.usage.tokensIn;
        totalTokensOut += trajectory.usage.tokensOut;

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

        if (rep === 0) {
          response = {
            contestantId: contestant.id,
            modelId,
            text: summarizeResponse(repResults[repResults.length - 1]),
            latencyMs: durationMs,
            tokensIn: trajectory.usage.tokensIn,
            tokensOut: trajectory.usage.tokensOut,
            costUsd: trajectory.usage.costUsd,
            status: execFailed ? 'error' : 'ok',
            errorMsg: execFailed ? (outcome.stderrTail ?? 'execução falhou') : undefined,
            execution,
          };
        }
      } catch (err) {
        // Qualquer falha não-controlada numa rep => 'nao' com status error (a rep
        // inteira foi perdida). Controle (orçamento/cancelamento) SOBE.
        if (isControlSignal(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        anyError = true;
        repResults.push({
          repetition: rep,
          execution: emptyExecution(relativeDir, rep, 0, 0, 0, 'error'),
          stopReason: 'error',
          verdict: 'nao',
          explanation: msg,
          judgeUsed: false,
          costUsd: 0,
        });
        if (rep === 0) {
          response = responseError(contestant, modelId, msg, 0);
        }
      } finally {
        credential?.revoke();
        // 9) dispose do workspace (preserva com isolation.keepWorkspace).
        const keep = agentConfig.isolation?.keepWorkspace === true;
        try {
          if (!keep && workspaceDir) await workspaceMgr.dispose(cacheRepoDir, workspaceDir);
          else if (keep && workspaceDir) writeFileSync(path.join(repAbs, '.workspace-kept'), workspaceDir, 'utf8');
        } catch {
          /* melhor esforço */
        }
      }
    }

  const incomplete = response === null || repResults.every((r) => r.verdict === null);

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
// Veredito da repetição — §17.1 (oráculo MANDA) + §18.3 (erro vs incomplete)
// + §15.2 (stopReason !== 'completed'). O juiz LLM SÓ roda quando é de fato útil.
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
}): Promise<{ verdict: Verdict | null; explanation: string; judgeUsed: boolean }> {
  const { stopReason, oracle, diffEmpty, stage, dossierText, contestantId, judgeModelIds, apiKey, ctx } = opts;

  // §18.3: cancelamento é sinal de controle — a fronteira re-lança. Aqui marcamos
  // incomplete e o ORQUESTRADOR sobe o sinal (o pipeline sabe que foi cancelado).
  if (stopReason === 'cancelled') {
    return { verdict: null, explanation: 'execução cancelada (sinal de controle)', judgeUsed: false };
  }

  // IMPL-039: tocar caminho protegido é reward hacking — `nao` SEM juiz, qualquer
  // que seja o motivo do fim (um agente cortado por timeout depois de editar o
  // teste não escapa como "incompleto, fora do placar").
  if (oracle && oracle.violations.length > 0) {
    return { verdict: 'nao', explanation: violationExplanation(oracle), judgeUsed: false };
  }

  // §18.3: processo morreu => é do contestant => 'nao' com status error.
  if (stopReason === 'error') {
    return { verdict: 'nao', explanation: 'a execução do agente falhou (processo morreu)', judgeUsed: false };
  }

  // IMPL-039: rebuild de dependências falhou (registry/rede fora, lockfile
  // ausente…) ⇒ os checks não rodaram e o oráculo não disse NADA sobre o agente.
  // Regra das CONVENTIONS §2: infra → sem veredito, fora do placar — nunca
  // imputar `nao` (antes o score 0 dos checks pulados virava `nao` sem juiz).
  if (oracle?.rebuild && !oracle.rebuild.ok) {
    return {
      verdict: null,
      explanation:
        `rebuild de dependências falhou (\`${oracle.rebuild.cmd}\`, exit ${oracle.rebuild.exitCode}) — ` +
        'checks não rodaram, oráculo inconclusivo: sem veredito, fora do placar',
      judgeUsed: false,
    };
  }

  // §15.2 exceção: stopReason !== 'completed' é incomplete, EXCETO se o oráculo
  // passou inteiro (score===1, sem P2P não aferido) — aí o mundo mudou de forma
  // verificável e segue.
  const p2pUnverified = (oracle?.p2p?.unverified ?? 0) > 0;
  const oraclePassing = oracle !== undefined && oracle.violations.length === 0 && oracle.score === 1 && !p2pUnverified;
  if (stopReason !== 'completed' && !oraclePassing) {
    return { verdict: null, explanation: `execução cortada (${stopReason}) — fora do placar`, judgeUsed: false };
  }

  // Daqui, o julgamento segue §17.1: o ORÁCULO MANDA; o juiz só gradua.
  if (oracle) {
    if (oracle.p2p?.broken) {
      // IMPL-039: regressão (PASS_TO_PASS quebrado, travado ou morto por sinal) = a execução FALHOU.
      return { verdict: 'nao', explanation: 'regressão: teste(s) PASS_TO_PASS quebrado(s)', judgeUsed: false };
    }
    if (oracle.score === 1 && p2pUnverified) {
      // IMPL-039: F2P verdes, mas a regressão NÃO foi aferida (P2P não rodou):
      // o oráculo não sustenta `resolve`. Cai para o juiz com teto `parcial`.
      return runJudgeForGraduation({
        stage, dossierText, contestantId, judgeModelIds, apiKey, ctx,
        canDowngradeTo: 'nao',
        ceiling: 'parcial',
        fallback: {
          verdict: 'parcial' as Verdict,
          explanation: 'F2P passaram, mas PASS_TO_PASS não pôde ser aferido — regressão não descartada',
        },
      });
    }
    if (oracle.score === 1) {
      // 'resolve' candidato; o juiz roda SÓ para graduar (pode rebaixar a
      // 'parcial' com justificativa, NUNCA a 'nao' — §17.1).
      const j = await runJudgeForGraduation({
        stage, dossierText, contestantId, judgeModelIds, apiKey, ctx,
        canDowngradeTo: 'parcial',
        fallback: { verdict: 'resolve' as Verdict, explanation: 'verificação automática passou integralmente (score 1)' },
      });
      return j;
    }
    if (oracle.score === 0) {
      return { verdict: 'nao', explanation: 'verificação automática falhou integralmente (score 0)', judgeUsed: false };
    }
    // 0 < score < 1 => 'parcial' (candidato); o juiz confirma ou rebaixa a 'nao'.
    const j = await runJudgeForGraduation({
      stage, dossierText, contestantId, judgeModelIds, apiKey, ctx,
      canDowngradeTo: 'nao',
      fallback: { verdict: 'parcial' as Verdict, explanation: 'verificação automática incompleta (score parcial)' },
    });
    return j;
  }

  // Sem oráculo:
  if (diffEmpty) {
    // §18.3: completou e não mudou nada => é uma resposta, e é errada.
    return { verdict: 'nao', explanation: 'o agente terminou sem alterar nada', judgeUsed: false };
  }
  // Sem oráculo com diff => julgamento pleno por dossiê (judgeDossier).
  return runJudgeForGraduation({
    stage, dossierText, contestantId, judgeModelIds, apiKey, ctx,
    canDowngradeTo: 'nao',
    fallback: { verdict: 'parcial' as Verdict, explanation: 'sem oráculo, sem veredito do juiz' },
  });
}

/**
 * Juiz LLM com clampeamento: `canDowngradeTo` limita até onde o juiz pode
 * rebaixar o veredito candidato (§17.1). Falha de chamada => 'parcial' (motivo).
 */
async function runJudgeForGraduation(opts: {
  stage: StageSpec;
  dossierText: string;
  contestantId: string;
  judgeModelIds: string[];
  apiKey: string;
  ctx: RunCtx;
  canDowngradeTo: 'parcial' | 'nao';
  /** Teto do veredito: com `'parcial'`, um `resolve` do juiz é rebaixado a `parcial`. */
  ceiling?: 'parcial';
  fallback: { verdict: Verdict; explanation: string };
}): Promise<{ verdict: Verdict | null; explanation: string; judgeUsed: boolean }> {
  const { stage, dossierText, contestantId, judgeModelIds, apiKey, ctx, canDowngradeTo, ceiling, fallback } = opts;
  // Sem juiz configurado não há rebaixamento: o veredito candidato (do oráculo)
  // permanece. Evita punir quem o oráculo aprovou por falta de modelo de juiz.
  if (judgeModelIds.length === 0) {
    return { verdict: fallback.verdict, explanation: fallback.explanation, judgeUsed: false };
  }
  try {
    const j = await judgeDossier({
      stage,
      dossierText,
      contestantId,
      judgeModelIds,
      apiKey,
      ctx,
    });
    // Clampeia o veredito do juiz ao piso permitido (§17.1: score 1 nunca vira
    // 'nao' — o juiz só pode rebaixar a 'parcial' com justificativa).
    let verdict = j.verdict;
    if (ceiling === 'parcial' && verdict === 'resolve') verdict = 'parcial';
    if (canDowngradeTo === 'parcial' && verdict === 'nao') {
      verdict = 'parcial';
      return {
        verdict,
        explanation: j.explanation,
        judgeUsed: true,
      };
    }
    return { verdict, explanation: j.explanation, judgeUsed: true };
  } catch (err) {
    // Controle sobe na fronteira.
    if (isControlSignal(err)) throw err;
    return { verdict: 'parcial', explanation: `juiz falhou: ${(err as Error).message}`, judgeUsed: false };
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