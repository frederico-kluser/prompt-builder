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
import { runOracle } from './oracle.js';
import { aggregateAgentVerdict, judgeDossier } from './agentJudge.js';
import { decideRepVerdict, type VerdictPath } from './verdictTree.js';
import { isControlSignal, RunCancelled } from '../budget.js';
import { emitEvent } from '../events.js';
import { blindRankMap, seedFromId } from '../duels.js';
import { tierFor } from '../openrouter.js';
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
  /**
   * null = SÓ cancelamento (sinal de controle — a etapa inteira sai do placar).
   * Corte por limite (timeout/maxTurns/maxCost/maxOutput) NÃO é null: conta
   * 'nao' (IMPL-032 / R-14a DEC-1 — ver `verdictTree.ts`).
   */
  verdict: Verdict | null;
  /** Caminho da árvore de veredito que decidiu esta repetição (1 dos 9). */
  path: VerdictPath;
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
  /**
   * true = nenhuma repetição tem veredito — só acontece por cancelamento (que,
   * na prática, sobe como RunCancelled antes daqui). Falha de preparação e
   * corte por limite NÃO são incomplete: pontuam 'nao'.
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
  const { runId, stageIndex, contestant, stage, agentConfig, apiKey, ctx, dataDir, catalog, forcedPromptMode } = opts;
  const gateway = opts.gateway ?? DEFAULT_GATEWAY;
  const task = stage.agentTask;
  const judgeModelIds = opts.judgeModelIds ?? [];
  const reps = Math.max(1, agentConfig.repetitions ?? 1);

  // Falha ANTES de qualquer execução (sem tarefa / executor não preparou): cada
  // repetição conta 'nao' pelo caminho 'error' — a MESMA regra de um workspace
  // que falha no meio da rep. Antes virava `incomplete` e o contestant sumia do
  // denominador daquela etapa; `incomplete` agora é só controle (IMPL-032). A
  // taxonomia transient × defect (defect invalida a célula de todos) é IMPL-094.
  if (!task) {
    const errorMsg = 'Etapa sem agentTask para contestant com runner=agent';
    return {
      response: { ...responseError(contestant, contestant.modelId, errorMsg, 0), text: 'agente: sem tarefa executável nesta etapa' },
      repResults: failedReps(runId, stageIndex, contestant.id, reps, errorMsg),
      incomplete: false,
      errorMsg,
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
      repResults: failedReps(runId, stageIndex, contestant.id, reps, errorMsg),
      incomplete: false,
      errorMsg,
    };
  }

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

        // 2) task.txt + system-prompt.txt no repetitionDir (§12.5).
        writeFileSync(path.join(repAbs, 'task.txt'), stage.question, 'utf8');
        writeFileSync(path.join(repAbs, 'system-prompt.txt'), systemPrompt, 'utf8');

        // 3) executor.run() — cwd=workspace, workDir=repetitionDir, limites.
        const execId = randomUUID();
        emitEvent({ type: 'agent.started', runId, stageIndex, contestantId: contestant.id, execId, repetition: rep });
        const env = {
          ...prepared.env,
          PI_MODEL_ID: modelId,
          PI_TASK: stage.question,
          PI_SYSTEM_PROMPT: systemPrompt,
        };

        const outcome = await gateway.run(
          { execId, task, config: runConfig, workspaceDir, workDir: repAbs, bin: prepared.bin, env },
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
        if (task.verify?.length || task.forbiddenPaths?.length) {
          oracle = await runOracle({
            workspaceDir,
            verify: task.verify ?? [],
            forbiddenPaths: task.forbiddenPaths,
            diffFiles: collect.nameStatus,
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
        //    sem oráculo com diff); corte por limite é 'nao' sem juiz.
        const adjudication = await adjudicateRep({
          stopReason,
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
          path: adjudication.path,
          explanation: adjudication.explanation,
          judgeUsed: adjudication.judgeUsed,
          costUsd: trajectory.usage.costUsd,
        });
        anyError = anyError || stopReason === 'error';

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
            status: stopReason === 'error' ? 'error' : 'ok',
            errorMsg: stopReason === 'error' ? (outcome.stderrTail ?? 'execução falhou') : undefined,
            execution,
          };
        }
      } catch (err) {
        // Qualquer falha não-controlada numa rep => 'nao' com status error (a rep
        // inteira foi perdida — caminho 'error', A5 até o IMPL-094). Controle
        // (orçamento/cancelamento) SOBE: é o único caminho para `incomplete`.
        if (isControlSignal(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        anyError = true;
        repResults.push({
          repetition: rep,
          execution: emptyExecution(relativeDir, rep, 0, 0, 0, 'error'),
          stopReason: 'error',
          verdict: 'nao',
          path: 'error',
          explanation: msg,
          judgeUsed: false,
          costUsd: 0,
        });
        if (rep === 0) {
          response = responseError(contestant, modelId, msg, 0);
        }
      } finally {
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

  // Só cancelamento deixa rep sem veredito (e ele sobe antes daqui).
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
// Veredito da repetição — a ÁRVORE de 9 caminhos vive, pura, em `verdictTree.ts`
// (IMPL-032: corte por limite conta 'nao'; `incomplete` só p/ cancelamento).
// Aqui só se chama o juiz LLM nos caminhos que graduam (§17.1: o oráculo MANDA,
// o juiz só age dentro da faixa dele).
// ---------------------------------------------------------------------------

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
}): Promise<{ verdict: Verdict | null; explanation: string; judgeUsed: boolean; path: VerdictPath }> {
  const { stopReason, oracle, diffEmpty, stage, dossierText, contestantId, judgeModelIds, apiKey, ctx } = opts;
  const d = decideRepVerdict({ stopReason, oracle, diffEmpty });

  // Cancelamento: sem veredito. Quem chama re-lança RunCancelled (§18.3) —
  // defensivo, porque o laço já sobe o sinal antes de chegar aqui.
  if (d.kind === 'incomplete') {
    return { verdict: null, explanation: d.explanation, judgeUsed: false, path: d.path };
  }
  if (d.kind === 'final') {
    return { verdict: d.verdict, explanation: d.explanation, judgeUsed: false, path: d.path };
  }
  const j = await runJudgeForGraduation({
    stage, dossierText, contestantId, judgeModelIds, apiKey, ctx,
    canDowngradeTo: d.floor,
    fallback: { verdict: d.candidate, explanation: d.explanation },
  });
  return { ...j, path: d.path };
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
  fallback: { verdict: Verdict; explanation: string };
}): Promise<{ verdict: Verdict | null; explanation: string; judgeUsed: boolean }> {
  const { stage, dossierText, contestantId, judgeModelIds, apiKey, ctx, canDowngradeTo, fallback } = opts;
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

/**
 * Repetições perdidas ANTES de executar (sem tarefa / executor não preparou):
 * uma por rep, todas 'nao' pelo caminho 'error' — nunca `incomplete`.
 */
function failedReps(
  runId: string,
  stageIndex: number,
  contestantId: string,
  reps: number,
  msg: string,
): AgentRepResult[] {
  return Array.from({ length: reps }, (_, rep) => ({
    repetition: rep,
    execution: emptyExecution(execDir(runId, stageIndex, contestantId, rep), rep, 0, 0, 0, 'error'),
    stopReason: 'error' as const,
    verdict: 'nao' as const,
    path: 'error' as const,
    explanation: msg,
    judgeUsed: false,
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