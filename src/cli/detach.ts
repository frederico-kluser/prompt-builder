// `--detach` dos comandos de run do CLI (IMPL-030, R-12:REC-5 / DEC-4).
//
// Foreground de 20–40 min não é confiável para um agente: o host corta o shell
// em 2–10 min (Claude Code 2/10 min, Cursor ~10 min, Gemini 5 min sem saída).
// Com `--detach` o comando:
//   PAI  — valida tudo (config, orçamento, pré-voo: mesmos códigos de saída do
//          foreground, nada gasto), cria um job em disco, dispara o PRÓPRIO
//          binário num processo filho destacado (sessão nova: o SIGKILL do
//          grupo do shell não o alcança) com stdout NDJSON em
//          <data>/jobs/<jobId>.ndjson, espera o filho anunciar a run e sai 0;
//   FILHO — o mesmo comando, sem `--detach`, que ADOTA o job (dono = seu PID) e
//          roda a run até o fim. `runs status/wait/cancel` acompanham pelo job
//          (e pela run), de qualquer processo.

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  agentRunSummary,
  benchmarkSummary,
  ensureJobsDir,
  jobLogFile,
  jobNdjsonFile,
  JobManager,
  trainingSummary,
  type JobOutcome,
} from '../jobManager.js';
import { DETACH_HANDSHAKE_MS, isTerminalJobStatus, type JobKind } from '../jobs.js';
import { isValidRecordId, publicErrorMessage } from '../pathSafety.js';
import { loadRun, loadSession, setDataDir } from '../storage.js';
import { onForcedExit, requestStop } from './runControl.js';
import { CliError, EXIT } from './output.js';
import type { CliContext } from './context.js';

/** Variável que transforma o comando no FILHO de um `--detach` (valor = jobId). */
export const DETACHED_JOB_ENV = 'PROMPT_BUILDER_DETACHED_JOB';

/**
 * O jobId que este processo deve adotar (null = não é filho de `--detach`). A
 * variável é CONSUMIDA: um subprocesso deste (executor de agente, git…) não a
 * herda nem tenta adotar o mesmo job.
 */
export function takeDetachedJobId(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env[DETACHED_JOB_ENV]?.trim();
  delete env[DETACHED_JOB_ENV];
  return v && isValidRecordId(v) ? v : null;
}

/**
 * argv do filho: o mesmo comando sem `--detach`, com o orçamento JÁ resolvido
 * (o filho não tem TTY: sem isto recusaria por falta de `--budget` o que o
 * humano aceitou no terminal), o data dir absoluto e NDJSON no stdout. Em
 * `parseArgs` a última ocorrência de uma opção vence.
 */
export function detachedChildArgv(
  argv: string[],
  o: { budgetUsd: number | undefined; dataDir: string },
): string[] {
  return [
    ...argv.filter((a) => a !== '--detach'),
    '--budget',
    o.budgetUsd === undefined ? 'none' : String(o.budgetUsd),
    '--data-dir',
    o.dataDir,
    '--output-format',
    'ndjson',
  ];
}

export interface LaunchDetachedOptions {
  /** Nome do comando (`compare`, `vary`, `train`, `agents.run`). */
  command: string;
  kind: JobKind;
  /** argv do comando (sem o nome do comando). */
  argv: string[];
  budgetUsd: number | undefined;
  /** Prefixo do comando para o filho (ex.: `['agents', 'run']`). */
  commandPrefix: string[];
  /** Só testes. */
  handshakeMs?: number;
}

/**
 * PAI: cria o job, dispara o filho destacado e espera ele anunciar a run (ou
 * falhar). Devolve o código de saída do PAI: 0 com a run em andamento; o
 * código do filho se ele morreu antes de começar.
 */
export async function launchDetached(ctx: CliContext, o: LaunchDetachedOptions): Promise<number> {
  const { out } = ctx;
  const mgr = new JobManager();
  await ensureJobsDir();
  const argvFilho = [...o.commandPrefix, ...detachedChildArgv(o.argv, { budgetUsd: o.budgetUsd, dataDir: ctx.dataDir })];
  const job = await mgr.createDetached({
    kind: o.kind,
    tool: `cli:${o.command}`,
    ...(o.budgetUsd !== undefined ? { budgetUsd: o.budgetUsd } : {}),
    fingerprint: createHash('sha256').update(JSON.stringify(argvFilho)).digest('hex'),
  });
  const ndjsonFile = jobNdjsonFile(job.id);
  const logFile = jobLogFile(job.id);

  // O stdout/stderr do filho vão DIRETO para arquivos (0600): o pai pode sair
  // sem que um pipe fechado derrube o filho com EPIPE.
  const outFd = openSync(ndjsonFile, 'a', 0o600);
  const errFd = openSync(logFile, 'a', 0o600);
  let pid: number | undefined;
  let spawnErr: Error | null = null;
  try {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...argvFilho], {
      // sessão/grupo próprios: sobrevive ao fim do pai e ao kill do grupo do shell
      detached: true,
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env, [DETACHED_JOB_ENV]: job.id },
    });
    child.once('error', (err) => {
      spawnErr = err;
    });
    child.unref();
    pid = child.pid;
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  if (pid === undefined) {
    // spawn síncrono não deu PID (binário sumiu, EAGAIN…): o erro chega num tick
    await new Promise((r) => setImmediate(r));
    const msg = `não consegui iniciar o processo destacado: ${publicErrorMessage(spawnErr ?? new Error('sem PID'))}`;
    await mgr.failDetached(job.id, msg, EXIT.ERROR);
    throw new CliError(msg, EXIT.ERROR);
  }
  await mgr.assignOwner(job.id, pid);

  // Handshake: o filho sobe, adota o job e anuncia a run (runId/sessionId).
  const limite = Date.now() + (o.handshakeMs ?? DETACH_HANDSHAKE_MS);
  let v = await mgr.status(job.id);
  while (v && !isTerminalJobStatus(v.status) && !v.runId && !v.sessionId && Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 100));
    v = await mgr.status(job.id);
  }

  const proximos = {
    status: `prompt-builder runs status ${job.id}`,
    wait: `prompt-builder runs wait ${job.id} --timeout 540`,
    cancel: `prompt-builder runs cancel ${job.id}`,
  };
  const payload = {
    jobId: job.id,
    pid,
    runId: v?.runId ?? null,
    sessionId: v?.sessionId ?? null,
    status: v?.status ?? 'queued',
    ndjsonFile,
    logFile,
    next: proximos,
  };

  if (v && isTerminalJobStatus(v.status) && v.status !== 'completed') {
    // O filho falhou antes de a run começar (key, catálogo, config): o pai
    // devolve o mesmo código que o foreground devolveria.
    const code = v.exitCode ?? EXIT.ERROR;
    throw new CliError(
      `o processo destacado terminou antes de a run começar (${v.status}): ${v.error ?? v.statusMessage ?? 'sem detalhes'}`,
      code === EXIT.OK ? EXIT.ERROR : code,
      payload,
    );
  }
  if (!payload.runId && !payload.sessionId) {
    out.warn(
      `o processo destacado (pid ${pid}) ainda não anunciou a run — acompanhe por \`${proximos.status}\`.`,
    );
  }
  if (out.isText) {
    out.line(`job      ${job.id}`);
    out.line(`pid      ${pid}`);
    if (payload.runId) out.line(`run      ${payload.runId}`);
    if (payload.sessionId) out.line(`sessão   ${payload.sessionId}`);
    out.line(`ndjson   ${ndjsonFile}`);
    out.line();
    out.line(`acompanhe:  ${proximos.wait}`);
    out.line(`cancele:    ${proximos.cancel}`);
  }
  out.result(true, `${o.command}.detach`, payload);
  return EXIT.OK;
}

/** O que o corpo do comando devolve ao rodar como filho de `--detach`. */
export interface DetachedBodyHooks {
  onRunId(id: string): void;
  onSessionId(id: string): void;
}

/**
 * FILHO: adota o job e roda `body` (o comando de run de sempre) sob os ganchos
 * do gerente — o cancelamento pedido por `runs cancel` (marcador lido pela
 * vigia de 500 ms, ou o prazo do job) vira a MESMA parada graciosa do SIGTERM
 * (`requestStop`). O job termina com o código de saída do comando; erro do
 * comando (CliError) termina o job 'failed' e é relançado para o `main()`
 * imprimir no NDJSON.
 */
export async function runAsDetachedChild(
  jobId: string,
  kind: JobKind,
  dataDir: string,
  body: (hooks: DetachedBodyHooks) => Promise<number>,
): Promise<number> {
  // O job mora no data dir do pai (o argv do filho o traz absoluto): antes de adotar.
  setDataDir(dataDir);
  const mgr = new JobManager({ log: (m) => process.stderr.write(`${m}\n`) });
  let erro: unknown = null;
  let code: number = EXIT.ERROR;
  // Graça esgotada / segundo sinal: o job também sai terminal antes do exit.
  const tirarGancho = onForcedExit(() => mgr.forceFinishLive('graça esgotada', EXIT.SIGINT));
  try {
    const { done } = await mgr.adopt(jobId, async (hooks): Promise<JobOutcome> => {
      const onAbort = (): void => {
        const r: unknown = hooks.signal.reason;
        requestStop(r instanceof Error ? r.message : 'runs cancel');
      };
      if (hooks.signal.aborted) onAbort();
      else hooks.signal.addEventListener('abort', onAbort, { once: true });
      let runId: string | undefined;
      let sessionId: string | undefined;
      try {
        code = await body({
          onRunId: (id) => {
            runId = id;
            hooks.onRunId?.(id);
          },
          onSessionId: (id) => {
            sessionId = id;
            hooks.onSessionId(id);
          },
        });
        return {
          summary: await resumoDoDisco(kind, runId, sessionId),
          cancelled: code === EXIT.SIGINT,
          exitCode: code,
          ...(runId ? { runId } : {}),
          ...(sessionId ? { sessionId } : {}),
        };
      } catch (err) {
        erro = err;
        code = err instanceof CliError ? err.code : EXIT.ERROR;
        return {
          summary: await resumoDoDisco(kind, runId, sessionId),
          cancelled: false,
          exitCode: code,
          failed: publicErrorMessage(err),
          ...(runId ? { runId } : {}),
          ...(sessionId ? { sessionId } : {}),
        };
      } finally {
        hooks.signal.removeEventListener('abort', onAbort);
      }
    });
    await done;
  } finally {
    tirarGancho();
  }
  if (erro) throw erro;
  return code;
}

async function resumoDoDisco(
  kind: JobKind,
  runId: string | undefined,
  sessionId: string | undefined,
): Promise<Record<string, unknown>> {
  if (sessionId) {
    const s = await loadSession(sessionId).catch(() => null);
    return s ? trainingSummary(s) : { sessionId };
  }
  if (runId) {
    const r = await loadRun(runId).catch(() => null);
    if (!r) return { runId };
    return kind === 'agent' ? agentRunSummary(r) : benchmarkSummary(r);
  }
  return {};
}
