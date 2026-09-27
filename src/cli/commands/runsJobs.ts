// `runs status | wait | cancel <id>` (IMPL-030, R-12:REC-5).
//
// `<id>` aceita o jobId de um `--detach`, o runId ou o sessionId (runs em
// foreground de OUTRO shell também: o arquivo de dono diz quem as executa).
// Toda leitura começa pela varredura de órfã daquele alvo: uma run cujo
// processo morreu (SIGKILL do host) aparece 'aborted' na hora, sem timeout.

import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { findJobFor, jobNdjsonFile, JobManager, type JobRecord } from '../../jobManager.js';
import {
  isTerminalJobStatus,
  LOCKLESS_ORPHAN_AFTER_MS,
  OWNER_STALE_AFTER_MS,
  RUNS_CANCEL_DEFAULT_TIMEOUT_S,
  RUNS_WAIT_DEFAULT_TIMEOUT_S,
  WAIT_NARRATION_MS,
  type JobStatus,
} from '../../jobs.js';
import { isValidRecordId } from '../../pathSafety.js';
import { isOwnerAlive, pidAlive } from '../../procOwner.js';
import { loadRun, loadSession, ownerStateOf, sweepOrphanRecords, type OwnedRecordKind } from '../../storage.js';
import type { CliContext } from '../context.js';
import { CliError, EXIT, fmtUsd } from '../output.js';

/** O que `runs status/wait/cancel` devolvem sobre um alvo. */
export interface RunStatusView {
  id: string;
  jobId: string | null;
  runId: string | null;
  sessionId: string | null;
  /** Estado unificado: o do job quando há job; senão o do record. */
  status: string;
  terminal: boolean;
  jobStatus: JobStatus | null;
  recordStatus: string | null;
  stoppedReason: string | null;
  /** O código que `runs wait` devolve (null enquanto não terminal). */
  exitCode: number | null;
  pid: number | null;
  processAlive: boolean | null;
  /** O processo dono morreu sem gravar o fim (varredura de órfã). */
  orphan: boolean;
  totalCostUsd: number | null;
  budgetUsd: number | null;
  statusMessage: string | null;
  ndjsonFile: string | null;
}

/**
 * Código de saída de um record TERMINAL — o mesmo que o comando em foreground
 * devolveria: 130 cancelada, 7 parcial por orçamento, 6 inconclusiva, 0
 * concluída, 1 erro ou ÓRFÃ (o processo morreu sem gravar o fim). "Terminal" é
 * `status !== 'running'`, o que já cobre o 'inconclusive' do cluster judge.
 */
export function exitCodeForRecord(r: {
  status: string;
  stoppedReason?: string;
  budgetExhausted?: boolean;
}): number | null {
  if (r.status === 'running') return null;
  if (r.status === 'error') return EXIT.ERROR;
  if (r.stoppedReason === 'cancelled') return EXIT.SIGINT;
  if (r.stoppedReason === 'budget' || r.budgetExhausted) return EXIT.BUDGET;
  if (r.status === 'inconclusive') return EXIT.INCONCLUSIVE;
  if (r.status === 'finished') return EXIT.OK;
  return EXIT.ERROR;
}

function exitCodeForJob(status: JobStatus, rec: { status: string } | null, own?: number): number | null {
  if (!isTerminalJobStatus(status)) return null;
  if (own !== undefined) return own;
  const doRecord = rec ? exitCodeForRecord(rec as Parameters<typeof exitCodeForRecord>[0]) : null;
  if (doRecord !== null) return doRecord;
  return status === 'completed' ? EXIT.OK : status === 'cancelled' ? EXIT.SIGINT : EXIT.ERROR;
}

interface Resolved {
  view: RunStatusView;
  job: JobRecord | null;
  owner: { kind: OwnedRecordKind; id: string } | null;
}

async function resolve(mgr: JobManager, id: string): Promise<Resolved | null> {
  const jobAntes = await findJobFor(id);
  // `status` reconcilia o job órfão (dono morto → 'failed' + run 'aborted')
  const jobView = jobAntes ? await mgr.status(jobAntes.id) : null;
  const job = jobAntes ? ((await findJobFor(jobAntes.id)) ?? jobAntes) : null;

  let runId = jobView?.runId ?? null;
  let sessionId = jobView?.sessionId ?? null;
  if (!job) {
    if (await loadRun(id).catch(() => null)) runId = id;
    else if (await loadSession(id).catch(() => null)) sessionId = id;
    else return null;
  }

  const kind: OwnedRecordKind | null = sessionId ? 'session' : runId ? 'run' : null;
  const recId = sessionId ?? runId;
  let orphan = jobView?.failure === 'orphaned';
  let rec: { status: string; stoppedReason?: string; budgetExhausted?: boolean; totalCostUsd?: number; budgetUsd?: number } | null =
    null;
  let ownerPid: number | null = null;
  if (kind && recId) {
    // Treino: as iterações também são runs 'running' — a varredura completa as pega.
    const varrida = await sweepOrphanRecords(
      kind === 'run' ? { only: { kind, id: recId }, locklessAfterMs: LOCKLESS_ORPHAN_AFTER_MS } : { locklessAfterMs: LOCKLESS_ORPHAN_AFTER_MS },
    );
    if ((kind === 'run' ? varrida.runs : varrida.sessions).includes(recId)) orphan = true;
    rec = kind === 'run' ? await loadRun(recId).catch(() => null) : await loadSession(recId).catch(() => null);
    if (rec?.status === 'running') ownerPid = (await ownerStateOf(kind, recId)).owner?.pid ?? null;
    if (rec && rec.status === 'aborted' && !rec.stoppedReason && !rec.budgetExhausted) orphan = true;
  }

  const pid = job ? job.ownerPid : ownerPid;
  const mesmoHost = job ? job.ownerHost === os.hostname() : true;
  const terminal = jobView ? isTerminalJobStatus(jobView.status) : rec ? rec.status !== 'running' : false;
  const view: RunStatusView = {
    id,
    jobId: job?.id ?? null,
    runId,
    sessionId,
    status: jobView?.status ?? rec?.status ?? 'unknown',
    terminal,
    jobStatus: jobView?.status ?? null,
    recordStatus: rec?.status ?? null,
    stoppedReason: rec?.stoppedReason ?? null,
    exitCode: jobView ? exitCodeForJob(jobView.status, rec, jobView.exitCode) : rec ? exitCodeForRecord(rec) : null,
    pid,
    processAlive: pid !== null && mesmoHost ? pidAlive(pid) : null,
    orphan,
    totalCostUsd: rec?.totalCostUsd ?? null,
    budgetUsd: rec?.budgetUsd ?? jobView?.budgetUsd ?? null,
    statusMessage: jobView?.statusMessage ?? null,
    ndjsonFile: job?.tool.startsWith('cli:') ? jobNdjsonFile(job.id) : null,
  };
  return { view, job, owner: kind && recId ? { kind, id: recId } : null };
}

function idArg(ctx: CliContext, sub: string): string {
  const id = ctx.positionals[0];
  if (!id) throw new CliError(`Uso: prompt-builder runs ${sub} <jobId|runId|sessionId>`, EXIT.USAGE);
  if (!isValidRecordId(id)) {
    throw new CliError('Id inválido: use o jobId do `--detach` ou o id de `runs list`/`sessions list`.', EXIT.USAGE);
  }
  return id;
}

function naoEncontrado(): CliError {
  return new CliError(
    'Nenhum job, run ou sessão com esse id no diretório de dados (confira `runs list` e --data-dir).',
    EXIT.USAGE,
  );
}

function timeoutArg(v: unknown, padraoS: number): number {
  if (v === undefined) return padraoS * 1000;
  const s = Number(v);
  if (typeof v !== 'string' || !v.trim() || !Number.isFinite(s) || s < 0) {
    throw new CliError('--timeout deve ser um número de segundos ≥ 0.', EXIT.USAGE);
  }
  return s * 1000;
}

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function linhaDeEstado(v: RunStatusView): string {
  const alvo = v.sessionId ? `sessão ${v.sessionId}` : v.runId ? `run ${v.runId}` : `job ${v.jobId}`;
  const custo = v.totalCostUsd !== null ? ` · ${fmtUsd(v.totalCostUsd)}` : '';
  const proc = v.pid !== null ? ` · pid ${v.pid}${v.processAlive === false ? ' (morto)' : ''}` : '';
  return `${alvo}: ${v.status}${v.orphan ? ' (órfã)' : ''}${custo}${proc}`;
}

function imprimir(ctx: CliContext, v: RunStatusView): void {
  const { out } = ctx;
  if (!out.isText) return;
  out.line(linhaDeEstado(v));
  if (v.jobId) out.line(`job       ${v.jobId}`);
  if (v.statusMessage) out.line(`mensagem  ${v.statusMessage}`);
  if (v.exitCode !== null) out.line(`exit      ${v.exitCode}`);
}

/** `runs status <id>` — uma leitura (com varredura de órfã). */
export async function runsStatus(ctx: CliContext): Promise<number> {
  const id = idArg(ctx, 'status');
  const r = await resolve(new JobManager(), id);
  if (!r) throw naoEncontrado();
  imprimir(ctx, r.view);
  ctx.out.result(true, 'runs.status', { ...r.view });
  return EXIT.OK;
}

async function esperarTerminal(
  mgr: JobManager,
  id: string,
  timeoutMs: number,
  opts: { narrar?: (v: RunStatusView) => void; processoTambem?: boolean } = {},
): Promise<{ view: RunStatusView; timedOut: boolean }> {
  const fim = Date.now() + timeoutMs;
  let ultimaNarracao = Date.now();
  for (;;) {
    const r = await resolve(mgr, id);
    if (!r) throw naoEncontrado();
    const v = r.view;
    const pronto = v.terminal && (!opts.processoTambem || v.processAlive !== true);
    if (pronto) return { view: v, timedOut: false };
    if (Date.now() >= fim) return { view: v, timedOut: true };
    if (opts.narrar && Date.now() - ultimaNarracao >= WAIT_NARRATION_MS) {
      opts.narrar(v);
      ultimaNarracao = Date.now();
    }
    await dormir(Math.min(100, fim - Date.now()));
  }
}

/**
 * `runs wait <id> [--timeout <s>]` — espera o estado terminal. Devolve o
 * código de saída do COMANDO que rodou (0/6/7/130/1); esgotado o prazo (padrão
 * 600 s), `EXIT.WAIT_TIMEOUT` (9) — a run segue rodando: chame de novo.
 */
export async function runsWait(ctx: CliContext): Promise<number> {
  const id = idArg(ctx, 'wait');
  const timeoutMs = timeoutArg(ctx.values.timeout, RUNS_WAIT_DEFAULT_TIMEOUT_S);
  const { out } = ctx;
  // Uma linha no stderr a cada 30 s: o Gemini CLI cancela o comando após 5 min sem saída.
  const { view, timedOut } = await esperarTerminal(new JobManager(), id, timeoutMs, {
    narrar: (v) => out.info(`aguardando… ${linhaDeEstado(v)}`),
  });
  if (timedOut) {
    out.warn(
      `prazo de ${Math.round(timeoutMs / 1000)} s esgotado; a run segue (${view.status}). ` +
        `Chame \`prompt-builder runs wait ${id}\` de novo.`,
    );
    imprimir(ctx, view);
    out.result(false, 'runs.wait', { ...view, timedOut: true });
    return EXIT.WAIT_TIMEOUT;
  }
  imprimir(ctx, view);
  out.result(true, 'runs.wait', { ...view, timedOut: false });
  return view.exitCode ?? EXIT.OK;
}

/**
 * Sinaliza o processo dono com SIGTERM — só quando ele é um comando de run do
 * CLI (para só aquela run, graciosamente), no mesmo host, e o PID ainda é o
 * MESMO processo (token de início): nunca um PID reaproveitado.
 */
function sinalizar(owner: { pid: number; host: string; startToken?: string | null }): boolean {
  if (owner.host !== os.hostname() || owner.pid === process.pid) return false;
  if (!isOwnerAlive(owner, OWNER_STALE_AFTER_MS)) return false;
  try {
    process.kill(owner.pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/**
 * `runs cancel <id> [--timeout <s>] [--reason <txt>]` — pede a parada
 * graciosa e espera o record terminal (e o processo sair, quando é um processo
 * do CLI). Job do `--detach`: marcador em disco (durável) + SIGTERM direto
 * (imediato). Run em foreground de outro shell: SIGTERM ao dono. Run de um
 * servidor/MCP: recusa (use `cancel_run`/DELETE). Idempotente em terminal.
 */
export async function runsCancel(ctx: CliContext): Promise<number> {
  const id = idArg(ctx, 'cancel');
  const timeoutMs = timeoutArg(ctx.values.timeout, RUNS_CANCEL_DEFAULT_TIMEOUT_S);
  const motivo =
    typeof ctx.values.reason === 'string' && ctx.values.reason.trim()
      ? ctx.values.reason.trim().slice(0, 200)
      : 'runs cancel (CLI)';
  const { out } = ctx;
  const mgr = new JobManager();
  const r = await resolve(mgr, id);
  if (!r) throw naoEncontrado();
  if (r.view.terminal) {
    imprimir(ctx, r.view);
    out.result(true, 'runs.cancel', { ...r.view, alreadyTerminal: true, signalled: false });
    return EXIT.OK;
  }

  const t0 = performance.now();
  let sinalizado = false;
  if (r.job) {
    await mgr.cancel(r.job.id, motivo);
    if (r.job.tool.startsWith('cli:')) {
      sinalizado = sinalizar({ pid: r.job.ownerPid, host: r.job.ownerHost, startToken: r.job.ownerStartToken ?? null });
    }
  } else if (r.owner) {
    const { state, owner } = await ownerStateOf(r.owner.kind, r.owner.id);
    if (state === 'alive' && owner) {
      if (!owner.signalStop) {
        throw new CliError(
          'Essa run pertence a um servidor/MCP, não a um comando do CLI — cancele por lá ' +
            '(`cancel_run` no MCP ou DELETE /v1/benchmark/runs/<id>).',
          EXIT.ERROR,
        );
      }
      sinalizado = sinalizar(owner);
    } else if (state === 'unknown') {
      throw new CliError(
        'Essa run está "running" sem processo dono registrado (versão antiga?) e não mudou há pouco — ' +
          `ela é dada como órfã após ${Math.round(LOCKLESS_ORPHAN_AFTER_MS / 60_000)} min parada.`,
        EXIT.ERROR,
      );
    }
    // 'dead': a varredura já a marcou 'aborted' — a espera abaixo devolve na hora.
  }

  const { view, timedOut } = await esperarTerminal(mgr, id, timeoutMs, { processoTambem: sinalizado });
  const elapsedMs = Math.round(performance.now() - t0);
  const payload = { ...view, cancelRequested: true, signalled: sinalizado, elapsedMs, timedOut };
  if (timedOut) {
    out.warn(`a run não confirmou a parada em ${Math.round(timeoutMs / 1000)} s (${view.status}).`);
    imprimir(ctx, view);
    out.result(false, 'runs.cancel', payload);
    return EXIT.WAIT_TIMEOUT;
  }
  out.info(`cancelada em ${elapsedMs} ms.`);
  imprimir(ctx, view);
  out.result(true, 'runs.cancel', payload);
  return EXIT.OK;
}
