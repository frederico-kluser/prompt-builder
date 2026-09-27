// Jobs DURÁVEIS de runs pesadas (IMPL-026, R-13:REC-3 / DEC-3) — lado Node.
//
// Por que existe: uma run leva minutos e o `tools/call` bloqueante estourava
// o penhasco de ~60 s dos clientes MCP; o retry que o agente faz depois do
// timeout virava uma SEGUNDA run inteira, cobrada em silêncio (gasto N×). O
// modelo aqui é start → status → cancel:
//
//   • `start` grava o job em disco ANTES de responder ("durably created" da
//     extensão Tasks: um status pelo id resolve assim que o id existe) e
//     devolve na hora — a parte cara (catálogo, datagen, competidores…) roda
//     depois, na fila de runs pesadas do processo (1 por vez, `HeavyLane`);
//   • a IDEMPOTENCY-KEY liga uma chave a UM job, em disco e com criação
//     atômica (hard link / O_EXCL): 20 retries — no mesmo processo ou em
//     processos diferentes sobre o mesmo data dir — devolvem o MESMO id e rodam
//     UMA run. Chave repetida com pedido diferente é recusada (a impressão
//     digital é o JSON canônico de tipo + config + orçamento);
//   • `cancel` aborta o MESMO AbortSignal do motor (ledger para de reservar,
//     fetch em voo cai) e a run grava o parcial 'aborted'/'cancelled'. Job de
//     OUTRO processo é cancelado por marcador em disco que a vigia do dono lê a
//     cada 500 ms — é o caminho que o `runs cancel` do CLI reusa;
//   • plano B para cliente que some sem cancelar (Codex): prazo por job (TTL,
//     padrão 2 h) e dono marcado por PID + batimento — job cujo dono morreu é
//     dado como órfão ('failed') e a run fica 'aborted', legível.
//
// Layout (tudo 0700/0600, IMPL-024): <data>/jobs/<jobId>.json,
// <data>/jobs/<jobId>.cancel (pedido de cancelamento) e
// <data>/jobs/keys/<sha256>.json (idempotency-key → jobId).

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunCancelled, isBudgetSignal, isControlSignal } from './budget.js';
import {
  DEFAULT_JOB_TTL_MS,
  HeavyLane,
  JOB_HEARTBEAT_MS,
  JOB_ORPHAN_AFTER_MS,
  JOB_POLL_INTERVAL_MS,
  JOB_RETENTION_MS,
  JOB_WATCH_INTERVAL_MS,
  canonicalJson,
  isTerminalJobStatus,
  processLane,
  throwIfAborted,
  type JobKind,
  type JobStatus,
} from './jobs.js';
import { ensureCatalog } from './modelsCache.js';
import { runToCompletion } from './orchestrator.js';
import { assertValidRecordId, publicErrorMessage, resolveInside } from './pathSafety.js';
import { prepareOptsFor } from './prepareRun.js';
import {
  ensurePrivateDataDir,
  getDataDir,
  loadRun,
  loadSession,
  saveRun,
  saveSession,
  writePrivateDataFile,
} from './storage.js';
import { trainToCompletion } from './trainer.js';
import type { RunConfig, RunRecord, SessionRecord } from './types.js';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** O trabalho pedido, já validado (config parseada, orçamento aplicado). */
export interface RunJobInput {
  kind: JobKind;
  config: RunConfig;
  budgetUsd: number;
}

/** Progresso barato (lido do record em disco, regravado a cada ~800 ms). */
export interface JobProgress {
  stagesPlanned?: number;
  stagesJudged?: number;
  iterationsPlanned?: number;
  iterationsDone?: number;
  spentUsd?: number;
}

/** Por que um job terminou 'failed'. */
export type JobFailure = 'tool' | 'orphaned';

/** Registro de um job em disco (<data>/jobs/<id>.json). */
export interface JobRecord {
  id: string;
  kind: JobKind;
  /** Ferramenta/comando que criou o job (start_run, run_benchmark, …). */
  tool: string;
  status: JobStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  finishedAt?: string;
  /** Prazo de execução contado de `createdAt` (o `ttlMs` da extensão Tasks). */
  ttlMs: number;
  pollIntervalMs: number;
  budgetUsd: number;
  /** Pré-atribuído na criação (benchmark/agente): conhecido antes de a run começar. */
  runId?: string;
  /** Treino: conhecido quando o laço começa. */
  sessionId?: string;
  /** sha256 do pedido canônico (tipo + config + orçamento). */
  fingerprint: string;
  /** sha256 da idempotency-key (a chave crua não é gravada). */
  idempotencyKeyHash?: string;
  ownerPid: number;
  ownerHost: string;
  heartbeatAt: string;
  cancelRequestedAt?: string;
  cancelReason?: string;
  /** Resumo compacto (o MESMO que a ferramenta bloqueante devolvia). */
  result?: Record<string, unknown>;
  /** Mensagem pública (sem caminho absoluto) quando 'failed'. */
  error?: string;
  failure?: JobFailure;
}

/** O que as ferramentas devolvem sobre um job (compacto: cada poll custa tokens). */
export interface JobView {
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  statusMessage?: string;
  runId?: string;
  sessionId?: string;
  budgetUsd: number;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs: number;
  /** Posição na fila de runs pesadas DESTE processo (1 = a próxima). */
  queuePosition?: number;
  progress?: JobProgress;
  result?: Record<string, unknown>;
  error?: string;
  failure?: JobFailure;
}

export interface JobExecHooks {
  /** O AbortSignal do motor (cancel_run, TTL, encerramento). */
  signal: AbortSignal;
  /** Id pré-atribuído da run (benchmark/agente). */
  runId?: string;
  /** Treino: o id da sessão assim que ela existe. */
  onSessionId(id: string): void;
}

export interface JobOutcome {
  /** Resumo compacto do record final. */
  summary: Record<string, unknown>;
  /** A run parou por cancelamento (record 'aborted' + stoppedReason 'cancelled'). */
  cancelled: boolean;
  runId?: string;
  sessionId?: string;
}

/** Executa a parte CARA de um job. Injetável (testes); o padrão é o motor real. */
export type JobExecutor = (input: RunJobInput, apiKey: string, hooks: JobExecHooks) => Promise<JobOutcome>;

/** Mesma idempotency-key com pedido diferente (a Stripe responde 422). */
export class IdempotencyConflict extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor() {
    super(
      'idempotencyKey já usada por OUTRO pedido (config, orçamento ou tipo diferentes). ' +
        'Para uma run nova use uma chave nova; para acompanhar a antiga, reuse o pedido original.',
    );
    this.name = 'IdempotencyConflict';
  }
}

// ---------------------------------------------------------------------------
// Resumos (o que as ferramentas bloqueantes sempre devolveram)
// ---------------------------------------------------------------------------

// "cut" = a execução parou pela parede/teto (não é um veredito 'nao').
const AGENT_CUT_REASONS = new Set(['maxTurns', 'maxCost', 'timeout', 'maxOutput', 'cancelled']);

/** Resumo de uma run de agentes: derivado do record, não inferido. */
export function agentSummary(rec: {
  stages: { responses: { costUsd: number; execution?: { turns: number; stopReason: string; oracle?: { score: number } } }[] }[];
}) {
  const execs = rec.stages.flatMap((s) => s.responses.filter((r) => r.execution));
  if (execs.length === 0) return undefined;
  const executions = execs.length;
  const failed = execs.filter((r) => r.execution!.stopReason === 'error').length;
  const incomplete = execs.filter((r) => AGENT_CUT_REASONS.has(r.execution!.stopReason)).length;
  const avgTurns = execs.reduce((a, r) => a + r.execution!.turns, 0) / executions;
  const avgCostUsd = execs.reduce((a, r) => a + r.costUsd, 0) / executions;
  const withOracle = execs.filter((r) => r.execution!.oracle !== undefined);
  const oracleRate =
    withOracle.length > 0
      ? withOracle.reduce((a, r) => a + (r.execution!.oracle!.score ?? 0), 0) / withOracle.length
      : undefined;
  return { executions, failed, incomplete, avgTurns, avgCostUsd, oracleRate };
}

export function benchmarkSummary(rec: RunRecord): Record<string, unknown> {
  return {
    runId: rec.id,
    status: rec.status,
    stoppedReason: rec.stoppedReason,
    totalCostUsd: rec.totalCostUsd,
    costByRole: rec.costByRole,
    budgetExhausted: Boolean(rec.budgetExhausted),
    stoppedAtPhase: rec.stoppedAtPhase,
    standings: rec.standings,
    judgeScoreByContestant: rec.judgeScoreByContestant,
  };
}

export function agentRunSummary(rec: RunRecord): Record<string, unknown> {
  return {
    ok: true,
    runId: rec.id,
    status: rec.status,
    stoppedReason: rec.stoppedReason,
    totalCostUsd: rec.totalCostUsd,
    agentSummary: agentSummary(rec),
  };
}

export function trainingSummary(rec: SessionRecord): Record<string, unknown> {
  const campeao = rec.bestPromptByIteration.at(-1);
  return {
    sessionId: rec.id,
    status: rec.status,
    stoppedReason: rec.stoppedReason,
    totalCostUsd: rec.totalCostUsd,
    costByRole: rec.costByRole,
    iterationsDone: rec.bestPromptByIteration.length,
    championPrompt: campeao?.systemPrompt,
    holdout: rec.holdout,
    significance: rec.significance,
    // Sem o holdout o ganho NÃO está validado contra sobreajuste.
    holdoutSkipped: Boolean(rec.holdoutSkipped),
    budgetExhausted: Boolean(rec.budgetExhausted),
  };
}

const foiCancelada = (rec: { status: string; stoppedReason?: string }): boolean =>
  rec.status === 'aborted' && rec.stoppedReason === 'cancelled';

/**
 * Executor REAL: o mesmo caminho das ferramentas bloqueantes de antes —
 * catálogo quente, depois `runToCompletion`/`trainToCompletion` com o sinal do
 * job como AbortSignal do motor (IMPL-025).
 */
export const executeRunJob: JobExecutor = async (input, apiKey, hooks) => {
  await ensureCatalog(apiKey);
  // Cancelado durante o catálogo (que não aceita sinal): não começa a gastar.
  throwIfAborted(hooks.signal);
  const cfg = input.config;
  if (cfg.mode === 'training' && input.kind === 'training') {
    const rec = await trainToCompletion(cfg, apiKey, {
      signal: hooks.signal,
      onSession: (id) => hooks.onSessionId(id),
    });
    return { summary: trainingSummary(rec), cancelled: foiCancelada(rec), sessionId: rec.id };
  }
  const rec = await runToCompletion(
    cfg,
    apiKey,
    prepareOptsFor(cfg, apiKey, { ctx: { signal: hooks.signal }, runId: hooks.runId }),
  );
  const summary = input.kind === 'agent' ? agentRunSummary(rec) : benchmarkSummary(rec);
  return { summary, cancelled: foiCancelada(rec), runId: rec.id };
};

// ---------------------------------------------------------------------------
// Disco
// ---------------------------------------------------------------------------

function jobsDir(): string {
  return path.join(getDataDir(), 'jobs');
}

function keysDir(): string {
  return path.join(jobsDir(), 'keys');
}

function jobFile(id: string): string {
  assertValidRecordId(id, 'jobId');
  return resolveInside(jobsDir(), `${id}.json`);
}

function cancelMarkerFile(id: string): string {
  assertValidRecordId(id, 'jobId');
  return resolveInside(jobsDir(), `${id}.cancel`);
}

function keyFile(keyHash: string): string {
  return resolveInside(keysDir(), `${keyHash}.json`);
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Namespace fixo: a mesma chave em outro contexto não colide com a nossa. */
export function hashIdempotencyKey(key: string): string {
  return sha256(`prompt-builder/idempotency-key\0${key}`);
}

export function fingerprintOf(input: RunJobInput): string {
  return sha256(canonicalJson({ kind: input.kind, budgetUsd: input.budgetUsd, config: input.config }));
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (err instanceof SyntaxError) return null; // arquivo corrompido = inexistente
    throw err;
  }
}

/** Lê o registro de um job do disco (null se não existe). Id validado. */
export async function readJobRecord(id: string): Promise<JobRecord | null> {
  const rec = await readJson<JobRecord>(jobFile(id));
  return rec && rec.id === id ? rec : null;
}

interface KeyBinding {
  jobId: string;
  fingerprint: string;
  createdAt: string;
}

/**
 * Cria `target` com `content` SÓ se ele não existe, atomicamente e já com o
 * conteúdo completo: tmp 0600 + `link` (falha com EEXIST se outro processo
 * ganhou). FS sem hard link cai para `wx` (O_EXCL) — conteúdo escrito logo
 * depois; o leitor trata arquivo vazio como "ainda sendo criado".
 */
async function createExclusive(target: string, content: string): Promise<boolean> {
  const tmp = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, content, { encoding: 'utf-8', mode: 0o600 });
  try {
    await fs.link(tmp, target);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EXDEV') throw err;
    try {
      await fs.writeFile(target, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = existe, mas é de outro usuário.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * O dono de um job não-terminal morreu? Mesmo host: pelo PID (vivo = não é
 * órfão, mesmo com batimento velho — laptop que dormiu acorda os dois lados
 * juntos). Outro host (data dir compartilhado): pelo batimento.
 */
export function isOrphanJob(rec: JobRecord, nowMs = Date.now(), host = os.hostname()): boolean {
  if (isTerminalJobStatus(rec.status)) return false;
  if (rec.ownerHost === host) return !pidAlive(rec.ownerPid);
  return nowMs - Date.parse(rec.heartbeatAt) > JOB_ORPHAN_AFTER_MS;
}

// ---------------------------------------------------------------------------
// Gerente
// ---------------------------------------------------------------------------

export interface JobManagerOptions {
  /** Fila de runs pesadas. Padrão: a do processo (1 por vez). */
  lane?: HeavyLane;
  executor?: JobExecutor;
  /** Narração (stderr no processo real). */
  log?: (msg: string) => void;
  /** Só testes: período da vigia e do batimento. */
  watchIntervalMs?: number;
  heartbeatMs?: number;
}

export interface StartJobOptions {
  /** Quem criou (start_run, run_benchmark, …) — só diagnóstico. */
  tool: string;
  idempotencyKey?: string;
  /** Prazo de execução (padrão DEFAULT_JOB_TTL_MS). */
  ttlMs?: number;
}

export interface StartJobResult {
  job: JobView;
  /** false = a idempotency-key já apontava para este job (nada novo foi criado). */
  created: boolean;
}

interface LiveJob {
  rec: JobRecord;
  controller: AbortController;
  /** Resolve depois da escrita terminal. */
  done: Promise<void>;
  started: boolean;
  writes: Promise<void>;
}

const nowIso = (): string => new Date().toISOString();

export class JobManager {
  private readonly live = new Map<string, LiveJob>();
  /** Reservas de chave EM ANDAMENTO neste processo (retries concorrentes). */
  private readonly claiming = new Map<string, Promise<{ rec: JobRecord; created: boolean }>>();
  private readonly lane: HeavyLane;
  private readonly executor: JobExecutor;
  private readonly log: (msg: string) => void;
  private readonly watchIntervalMs: number;
  private readonly heartbeatMs: number;
  private readonly host = os.hostname();
  private watcher: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(opts: JobManagerOptions = {}) {
    this.lane = opts.lane ?? processLane;
    this.executor = opts.executor ?? executeRunJob;
    this.log = opts.log ?? (() => undefined);
    this.watchIntervalMs = opts.watchIntervalMs ?? JOB_WATCH_INTERVAL_MS;
    this.heartbeatMs = opts.heartbeatMs ?? JOB_HEARTBEAT_MS;
  }

  /** Jobs deste processo ainda não terminados. */
  get activeCount(): number {
    return [...this.live.values()].filter((j) => !isTerminalJobStatus(j.rec.status)).length;
  }

  /**
   * Cria (ou, pela idempotency-key, reencontra) um job e devolve SEM esperar a
   * run: o registro já está em disco quando isto resolve.
   */
  async start(input: RunJobInput, apiKey: string, opts: StartJobOptions): Promise<StartJobResult> {
    const fingerprint = fingerprintOf(input);
    this.sweepOnce();
    if (opts.idempotencyKey === undefined) {
      const rec = await this.createAndLaunch(input, apiKey, opts, fingerprint);
      return { job: await this.view(rec), created: true };
    }
    const keyHash = hashIdempotencyKey(opts.idempotencyKey);
    let pending = this.claiming.get(keyHash);
    let mine = false;
    if (!pending) {
      mine = true;
      pending = this.claimKey(keyHash, input, apiKey, opts, fingerprint).finally(() => {
        this.claiming.delete(keyHash);
      });
      this.claiming.set(keyHash, pending);
    }
    const { rec, created } = await pending;
    if (rec.fingerprint !== fingerprint) throw new IdempotencyConflict();
    return { job: await this.view(rec), created: mine && created };
  }

  /** Estado atual (memória para os jobs deste processo; disco para os outros). */
  async status(jobId: string, opts: { progress?: boolean } = {}): Promise<JobView | null> {
    assertValidRecordId(jobId, 'jobId');
    const live = this.live.get(jobId);
    if (live) return this.view(live.rec, opts);
    const rec = await readJobRecord(jobId);
    if (!rec) return null;
    if (isOrphanJob(rec, Date.now(), this.host)) return this.view(await this.reconcileOrphan(rec), opts);
    return this.view(rec, opts);
  }

  /**
   * Espera o job terminar por no máximo `ms` (ou até `signal` abortar) e
   * devolve o estado. `ms` é limitado por quem chama (< 30 s numa ferramenta).
   */
  async wait(jobId: string, ms: number, signal?: AbortSignal): Promise<JobView | null> {
    assertValidRecordId(jobId, 'jobId');
    const fim = Date.now() + Math.max(0, ms);
    const live = this.live.get(jobId);
    if (live) {
      await esperarAte(live.done, fim - Date.now(), signal);
      return this.status(jobId, { progress: true });
    }
    // Job de outro processo: poll do disco.
    for (;;) {
      const v = await this.status(jobId, { progress: false });
      if (!v || isTerminalJobStatus(v.status) || Date.now() >= fim || signal?.aborted) {
        return v && !isTerminalJobStatus(v.status) ? this.status(jobId, { progress: true }) : v;
      }
      await esperarAte(new Promise(() => undefined), Math.min(250, fim - Date.now()), signal);
    }
  }

  /**
   * Pede o cancelamento. Job deste processo: aborta o sinal do motor na hora —
   * SÍNCRONO, antes do primeiro await (quem chama de dentro de um evento de
   * abort conta com isso) — na fila = nunca começa; rodando = parcial
   * 'aborted'/'cancelled'. Job de
   * outro processo: marcador em disco que a vigia do dono lê em ≤ 500 ms.
   * Terminal: nada muda (idempotente). `null` = job desconhecido.
   */
  async cancel(jobId: string, reason: string): Promise<JobView | null> {
    assertValidRecordId(jobId, 'jobId');
    const live = this.live.get(jobId);
    if (live) {
      this.abortLive(live, reason);
      return this.view(live.rec);
    }
    const rec = await readJobRecord(jobId);
    if (!rec) return null;
    if (isTerminalJobStatus(rec.status)) return this.view(rec);
    if (isOrphanJob(rec, Date.now(), this.host)) return this.view(await this.reconcileOrphan(rec));
    await writePrivateDataFile(cancelMarkerFile(jobId), JSON.stringify({ reason, at: nowIso() }));
    this.log(`[jobs] ${jobId}: cancelamento pedido ao processo dono (pid ${rec.ownerPid})`);
    return this.view({ ...rec, statusMessage: 'cancelamento pedido ao processo dono do job' });
  }

  /**
   * Encerramento do processo (EOF/SIGTERM): cancela TODOS os jobs deste
   * processo — cada run grava o parcial — e devolve as promessas de término
   * para quem espera a graça.
   */
  shutdown(reason: string): Promise<void>[] {
    const pendentes: Promise<void>[] = [];
    for (const live of this.live.values()) {
      // Terminal mas ainda na memória = a escrita final está saindo: espera também.
      if (!isTerminalJobStatus(live.rec.status)) this.abortLive(live, reason);
      pendentes.push(live.done);
    }
    return pendentes;
  }

  // --- criação ----------------------------------------------------------------

  private newRecord(input: RunJobInput, opts: StartJobOptions, fingerprint: string, keyHash?: string): JobRecord {
    const agora = nowIso();
    return {
      id: randomUUID(),
      kind: input.kind,
      tool: opts.tool,
      status: 'queued',
      statusMessage: 'na fila de runs pesadas',
      createdAt: agora,
      lastUpdatedAt: agora,
      ttlMs: opts.ttlMs ?? DEFAULT_JOB_TTL_MS,
      pollIntervalMs: JOB_POLL_INTERVAL_MS,
      budgetUsd: input.budgetUsd,
      // benchmark/agente: o id da run já é conhecido (get_result responde assim
      // que ela começar); treino: o id da sessão chega por onSessionId.
      runId: input.kind === 'training' ? undefined : randomUUID(),
      fingerprint,
      idempotencyKeyHash: keyHash,
      ownerPid: process.pid,
      ownerHost: this.host,
      heartbeatAt: agora,
    };
  }

  private async createAndLaunch(
    input: RunJobInput,
    apiKey: string,
    opts: StartJobOptions,
    fingerprint: string,
  ): Promise<JobRecord> {
    const rec = this.newRecord(input, opts, fingerprint);
    await this.persist(rec);
    this.launch(rec, input, apiKey);
    return rec;
  }

  /**
   * Liga a chave a UM job, entre processos. Ordem: o arquivo do JOB é gravado
   * ANTES da chave (chave existe ⇒ job existe); a chave nasce por criação
   * exclusiva; quem perde a corrida apaga o próprio job (nunca lançado) e
   * adota o do vencedor.
   */
  private async claimKey(
    keyHash: string,
    input: RunJobInput,
    apiKey: string,
    opts: StartJobOptions,
    fingerprint: string,
  ): Promise<{ rec: JobRecord; created: boolean }> {
    await ensurePrivateDataDir(keysDir());
    const alvo = keyFile(keyHash);
    for (let tentativa = 0; tentativa < 8; tentativa++) {
      const existente = await this.readBinding(alvo);
      if (existente === 'creating') {
        await dormir(10);
        continue;
      }
      if (existente) {
        const rec = this.live.get(existente.jobId)?.rec ?? (await readJobRecord(existente.jobId));
        if (rec) return { rec, created: false };
        // Chave sem job (varrido): libera e tenta de novo.
        await fs.rm(alvo, { force: true });
        continue;
      }
      const rec = this.newRecord(input, opts, fingerprint, keyHash);
      await this.persist(rec);
      const binding: KeyBinding = { jobId: rec.id, fingerprint, createdAt: rec.createdAt };
      if (await createExclusive(alvo, JSON.stringify(binding))) {
        this.launch(rec, input, apiKey);
        return { rec, created: true };
      }
      await fs.rm(jobFile(rec.id), { force: true });
    }
    throw new Error('Não consegui reservar a idempotencyKey (disputa persistente); tente de novo.');
  }

  private async readBinding(file: string): Promise<KeyBinding | 'creating' | null> {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    if (raw.trim() === '') return 'creating'; // fallback `wx`: conteúdo a caminho
    try {
      const b = JSON.parse(raw) as KeyBinding;
      if (typeof b.jobId === 'string') return b;
    } catch {
      // corrompido: tratado como ausente abaixo
    }
    await fs.rm(file, { force: true });
    return null;
  }

  // --- execução ---------------------------------------------------------------

  private launch(rec: JobRecord, input: RunJobInput, apiKey: string): void {
    const live: LiveJob = {
      rec,
      controller: new AbortController(),
      done: Promise.resolve(),
      started: false,
      writes: Promise.resolve(),
    };
    this.live.set(rec.id, live);
    const signal = live.controller.signal;
    live.done = this.lane
      .run(async () => {
        live.started = true;
        this.update(live, { status: 'working', statusMessage: 'em execução' });
        return this.executor(input, apiKey, {
          signal,
          runId: rec.runId,
          onSessionId: (id) => this.update(live, { sessionId: id }),
        });
      }, signal)
      .then(
        (out) => {
          const alvo = out.sessionId ? `sessão ${out.sessionId}` : `run ${out.runId ?? rec.runId}`;
          this.update(live, {
            status: out.cancelled ? 'cancelled' : 'completed',
            statusMessage: out.cancelled
              ? `cancelada (${live.rec.cancelReason ?? 'sem motivo'}); parcial gravado na ${alvo} — leia com get_result`
              : `concluída; ${alvo} — detalhes com get_result`,
            result: out.summary,
            runId: out.runId ?? live.rec.runId,
            sessionId: out.sessionId ?? live.rec.sessionId,
            finishedAt: nowIso(),
          });
        },
        (err: unknown) => {
          if (isControlSignal(err)) {
            // Cancelado NA FILA (ou antes do 1º gasto): nada foi gasto.
            const orcamento = isBudgetSignal(err);
            this.update(live, {
              status: orcamento ? 'completed' : 'cancelled',
              statusMessage: orcamento
                ? 'orçamento esgotado antes de a run começar'
                : live.started
                  ? `cancelada (${live.rec.cancelReason ?? 'sem motivo'}) antes do primeiro gasto`
                  : `cancelada na fila (${live.rec.cancelReason ?? 'sem motivo'}); nada foi gasto`,
              finishedAt: nowIso(),
            });
            return;
          }
          const msg = publicErrorMessage(err);
          this.update(live, {
            status: 'failed',
            failure: 'tool',
            error: msg,
            statusMessage: `falhou: ${msg}`,
            finishedAt: nowIso(),
          });
        },
      )
      .then(async () => {
        await live.writes;
        await fs.rm(cancelMarkerFile(rec.id), { force: true }).catch(() => undefined);
        this.live.delete(rec.id);
        this.stopWatcherIfIdle();
      });
    this.ensureWatcher();
  }

  private abortLive(live: LiveJob, reason: string): void {
    if (isTerminalJobStatus(live.rec.status) || live.controller.signal.aborted) return;
    this.update(live, {
      cancelRequestedAt: nowIso(),
      cancelReason: reason,
      statusMessage: `cancelando (${reason})`,
    });
    this.log(`[jobs] ${live.rec.id}: cancelando (${reason}) — nenhuma chamada paga nova`);
    // Sinal de CONTROLE: atravessa os catch que degradam (isControlSignal).
    live.controller.abort(new RunCancelled(reason));
  }

  /** Aplica `patch` e grava. Patch vazio = só batimento (não mexe em lastUpdatedAt). */
  private update(live: LiveJob, patch: Partial<JobRecord>): void {
    const agora = nowIso();
    Object.assign(live.rec, patch, { heartbeatAt: agora });
    if (Object.keys(patch).length > 0) live.rec.lastUpdatedAt = agora;
    // Snapshot síncrono + fila por job: as escritas saem na ordem das mudanças.
    const snapshot = { ...live.rec };
    live.writes = live.writes
      .then(() => this.persist(snapshot))
      .catch((err: unknown) => this.log(`[jobs] falha ao gravar o job ${live.rec.id}: ${publicErrorMessage(err)}`));
  }

  private async persist(rec: JobRecord): Promise<void> {
    await writePrivateDataFile(jobFile(rec.id), JSON.stringify(rec));
  }

  // --- vigia (cancel de outro processo, TTL, batimento) -----------------------

  private ensureWatcher(): void {
    if (this.watcher) return;
    this.watcher = setInterval(() => void this.tick(), this.watchIntervalMs);
    // Não segura o processo: quem o mantém vivo é a run (ou o stdin do MCP).
    this.watcher.unref?.();
  }

  private stopWatcherIfIdle(): void {
    if (this.watcher && this.live.size === 0) {
      clearInterval(this.watcher);
      this.watcher = null;
    }
  }

  private ticking = false;

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const agora = Date.now();
      for (const live of [...this.live.values()]) {
        if (isTerminalJobStatus(live.rec.status) || live.controller.signal.aborted) continue;
        const marcador = await readJson<{ reason?: unknown }>(cancelMarkerFile(live.rec.id)).catch(() => null);
        if (marcador) {
          const motivo = typeof marcador.reason === 'string' ? marcador.reason : 'cancel_run de outro processo';
          this.abortLive(live, motivo.slice(0, 200));
          continue;
        }
        if (agora >= Date.parse(live.rec.createdAt) + live.rec.ttlMs) {
          this.abortLive(live, `prazo do job (ttl de ${Math.round(live.rec.ttlMs / 1000)} s) esgotado`);
          continue;
        }
        if (agora - Date.parse(live.rec.heartbeatAt) >= this.heartbeatMs) this.update(live, {});
      }
    } finally {
      this.ticking = false;
    }
  }

  // --- órfãos e retenção ------------------------------------------------------

  /**
   * Job cujo dono morreu: 'failed' (órfão) e a run/sessão, se ainda
   * 'running', vira 'aborted' — o parcial fica legível por get_result.
   */
  async reconcileOrphan(rec: JobRecord): Promise<JobRecord> {
    const out: JobRecord = {
      ...rec,
      status: 'failed',
      failure: 'orphaned',
      error: `o processo dono (pid ${rec.ownerPid}) morreu antes de terminar`,
      statusMessage: `órfão: o processo dono (pid ${rec.ownerPid}) morreu; o parcial fica em get_result`,
      lastUpdatedAt: nowIso(),
      finishedAt: nowIso(),
    };
    await this.persist(out);
    if (rec.runId) {
      const run = await loadRun(rec.runId).catch(() => null);
      if (run && run.status === 'running') {
        run.status = 'aborted';
        run.finishedAt = nowIso();
        await saveRun(run).catch(() => undefined);
      }
    }
    if (rec.sessionId) {
      const s = await loadSession(rec.sessionId).catch(() => null);
      if (s && s.status === 'running') {
        s.status = 'aborted';
        s.finishedAt = nowIso();
        await saveSession(s).catch(() => undefined);
      }
    }
    this.log(`[jobs] ${rec.id}: órfão (pid ${rec.ownerPid} morreu) — marcado failed`);
    return out;
  }

  /**
   * Varredura de retenção (uma vez por gerente, em segundo plano): job
   * TERMINAL sem mudança há mais de JOB_RETENTION_MS sai do disco — primeiro a
   * chave (para "chave ⇒ job" continuar valendo), depois o job.
   */
  sweepOnce(nowMs = Date.now()): Promise<number> {
    if (this.sweeping) return Promise.resolve(0);
    this.sweeping = true;
    return this.sweepExpired(nowMs).catch((err: unknown) => {
      this.log(`[jobs] varredura falhou: ${publicErrorMessage(err)}`);
      return 0;
    });
  }

  /** A varredura em si (exposta para o `runs` do CLI e para os testes). */
  async sweepExpired(nowMs = Date.now()): Promise<number> {
    let nomes: string[];
    try {
      nomes = await fs.readdir(jobsDir());
    } catch {
      return 0;
    }
    let removidos = 0;
    for (const nome of nomes) {
      if (!nome.endsWith('.json')) continue;
      const id = nome.slice(0, -'.json'.length);
      if (this.live.has(id)) continue;
      const rec = await readJobRecord(id).catch(() => null);
      if (!rec || !isTerminalJobStatus(rec.status)) continue;
      if (nowMs - Date.parse(rec.lastUpdatedAt) < JOB_RETENTION_MS) continue;
      if (rec.idempotencyKeyHash) {
        const k = keyFile(rec.idempotencyKeyHash);
        const b = await readJson<KeyBinding>(k).catch(() => null);
        if (b?.jobId === rec.id) await fs.rm(k, { force: true });
      }
      await fs.rm(jobFile(id), { force: true });
      await fs.rm(cancelMarkerFile(id), { force: true });
      removidos++;
    }
    return removidos;
  }

  // --- visão ------------------------------------------------------------------

  private async view(rec: JobRecord, opts: { progress?: boolean } = {}): Promise<JobView> {
    const v: JobView = {
      jobId: rec.id,
      kind: rec.kind,
      status: rec.status,
      statusMessage: rec.statusMessage,
      runId: rec.runId,
      sessionId: rec.sessionId,
      budgetUsd: rec.budgetUsd,
      createdAt: rec.createdAt,
      lastUpdatedAt: rec.lastUpdatedAt,
      ttlMs: rec.ttlMs,
      pollIntervalMs: rec.pollIntervalMs,
    };
    if (rec.status === 'queued' && this.live.has(rec.id)) {
      const fila = [...this.live.values()].filter((j) => j.rec.status === 'queued');
      const pos = fila.findIndex((j) => j.rec.id === rec.id);
      if (pos >= 0) v.queuePosition = pos + 1;
    }
    if (opts.progress && !isTerminalJobStatus(rec.status)) {
      const p = await progressOf(rec).catch(() => undefined);
      if (p) v.progress = p;
    }
    if (rec.result) v.result = rec.result;
    if (rec.error) v.error = rec.error;
    if (rec.failure) v.failure = rec.failure;
    return v;
  }
}

async function progressOf(rec: JobRecord): Promise<JobProgress | undefined> {
  if (rec.sessionId) {
    const s = await loadSession(rec.sessionId);
    if (!s) return undefined;
    return {
      iterationsPlanned: s.config.iterations,
      iterationsDone: s.bestPromptByIteration?.length ?? 0,
      spentUsd: s.totalCostUsd,
    };
  }
  if (!rec.runId) return undefined;
  const r = await loadRun(rec.runId);
  if (!r) return undefined;
  return {
    stagesPlanned: r.config.stages,
    stagesJudged: r.stages.filter((s) => !s.incomplete && (s.judge || s.referenceJudge)).length,
    spentUsd: r.totalCostUsd,
  };
}

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Espera `p` por no máximo `ms`, ou até `signal` abortar (nunca rejeita). */
function esperarAte(p: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const fim = (): void => {
      clearTimeout(t);
      signal?.removeEventListener('abort', fim);
      resolve();
    };
    const t = setTimeout(fim, ms);
    signal?.addEventListener('abort', fim, { once: true });
    p.then(fim, fim);
  });
}

let padrao: JobManager | null = null;

/** O gerente do PROCESSO (usa a fila do processo). */
export function defaultJobManager(): JobManager {
  padrao ??= new JobManager({ log: (m) => process.stderr.write(`${m}\n`) });
  return padrao;
}
