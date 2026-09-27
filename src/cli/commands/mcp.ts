// Servidor MCP por stdio, no MESMO binario (precedente: `npx -y prisma mcp`).
//
// Implementado a mao, sem SDK: o transporte stdio do MCP e JSON-RPC 2.0
// delimitado por linha, e `initialize` + `tools/list` + `tools/call` cabem em
// ~150 linhas. Puxar o SDK custaria dezenas de pacotes transitivos em TODA
// instalacao — inclusive de quem so quer o CLI — e o cold start rapido e
// metade da vantagem de um binario sobre um servidor MCP.
//
// A superficie e deliberadamente PEQUENA: o schema de cada ferramenta entra no
// contexto do agente a cada turno, entao cada ferramenta a mais e um imposto
// permanente de tokens.
//
// Cancelamento cooperativo (IMPL-025, R-13:REC-4): o laço de leitura NUNCA
// espera uma ferramenta — `ping`, `tools/list` e `notifications/cancelled`
// são atendidos enquanto uma run de minutos está em voo (antes o `await
// tool.run` serial travava tudo: deadlock MDAT e gasto órfão). Cada
// `tools/call` ganha um AbortController cujo sinal É o AbortSignal do motor
// (ledger + fetch em voo); cancelada pelo cliente, a chamada grava o parcial
// (record 'aborted', stoppedReason 'cancelled') e NÃO recebe resposta. EOF do
// stdin e SIGTERM abortam tudo com graça de ~10 s antes de sair.
//
// Jobs (IMPL-026, R-13:REC-3): runs levam MINUTOS e o penhasco dos clientes é
// ~60 s — o retry depois do timeout virava uma 2ª run cobrada (gasto N×). O
// caminho universal é start_run → run_status → cancel_run (idempotency-key no
// start: retry = MESMO job); nenhum tools/call segura mais de 25 s (as tools
// longas de antes esperam até isso e devolvem o jobId); 1 run pesada por
// processo, com fila; e `CreateTaskResult` (extensão io.modelcontextprotocol/
// tasks) SÓ para o cliente que declarou a extensão — sem ela, -32021.

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { RunCancelled, isControlSignal } from '../../budget.js';
import {
  BLOCKING_TOOL_LIMIT_MS,
  HeavyLane,
  SHUTDOWN_GRACE_MS,
  clampJobTtlMs,
  clampWaitMs,
  isTerminalJobStatus,
  isValidIdempotencyKey,
  processLane,
  settleWithin,
} from '../../jobs.js';
import { JobManager, defaultJobManager, type JobView, type RunJobInput } from '../../jobManager.js';
import { PKG_DOCS_DIR, pkgVersion } from '../../paths.js';
import { assertValidRecordId, isValidRecordId, publicErrorMessage } from '../../pathSafety.js';
import { readDocTopic } from './knowledge.js';
import { setDataDir, loadRun, loadSession } from '../../storage.js';
import { ensureCatalog } from '../../modelsCache.js';
import { toExportRow } from '../../modelCaps.js';
import { estimateInputFromConfig, estimateRunCost } from '../../estimate.js';
import { parseRunConfig } from '../../runConfigSchema.js';
import { ARENA_AGENT_CONFIG_FORMAT, parseArenaConfig, parseArenaAgentConfig } from '../../configFile.js';
import { arenaConfigToRunConfig, arenaAgentConfigToRunConfig } from '../../arenaConfig.js';
import { readArtifact } from '../../agent/store.js';
import { resolveHome, resolveKey, parse } from '../context.js';
import { EXIT } from '../output.js';
import type { RunConfig } from '../../types.js';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'prompt-builder', version: pkgVersion() };

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

/** Contexto de UMA chamada de ferramenta (IMPL-025). */
export interface ToolCtx {
  /**
   * Aborta em `notifications/cancelled`, EOF do stdin ou SIGTERM. É o MESMO
   * AbortSignal que vai ao motor: o ledger para de reservar e o fetch em voo cai.
   */
  signal: AbortSignal;
  /**
   * Roda `fn` na fila de runs pesadas do processo (1 por vez, FIFO). A espera
   * é cancelável e só a parte cara entra nela — validação e catálogo não.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** Jobs do processo (IMPL-026): start_run/run_status/cancel_run e as tools longas. */
  jobs: JobManager;
  /**
   * O cliente declarou a extensão Tasks (nesta requisição ou no initialize):
   * só então uma tool longa pode devolver `CreateTaskResult`.
   */
  tasks: boolean;
  /** Teto da espera de uma tool longa antes de devolver o jobId (< 30 s). */
  blockingWaitMs: number;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Não precisa de key (lê disco/docs embarcadas): funciona sem OPENROUTER_API_KEY. */
  noKey?: boolean;
  /** Saída em JSON compacto (tools de poll: cada chamada custa tokens). */
  compact?: boolean;
  run: (args: Record<string, unknown>, apiKey: string, ctx: ToolCtx) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Extensão Tasks (io.modelcontextprotocol/tasks, SEP-2663 — spec 2026-07-28)
// ---------------------------------------------------------------------------

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
/** MissingRequiredClientCapability (renumerado de -32003 na spec 2026-07-28). */
export const MISSING_CAPABILITY = -32021;
const CLIENT_CAPS_META = 'io.modelcontextprotocol/clientCapabilities';

/** `capabilities` declara a extensão Tasks? (`extensions[TASKS_EXTENSION]` objeto) */
function declaresTasks(capabilities: unknown): boolean {
  const ext = (capabilities as { extensions?: unknown } | null | undefined)?.extensions;
  if (!ext || typeof ext !== 'object') return false;
  const v = (ext as Record<string, unknown>)[TASKS_EXTENSION];
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Declaração POR REQUISIÇÃO (era 2026-07-28): `params._meta[clientCapabilities]`. */
function requestDeclaresTasks(params: unknown): boolean {
  const meta = (params as { _meta?: unknown } | null | undefined)?._meta;
  if (!meta || typeof meta !== 'object') return false;
  return declaresTasks((meta as Record<string, unknown>)[CLIENT_CAPS_META]);
}

/** Resultado de `tools/call` que é uma TASK (em vez de CallToolResult). */
export interface CreateTaskResult {
  resultType: 'task';
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs: number;
}

export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

/**
 * Job → estado de task. Fila e execução = `working`. Erro da FERRAMENTA
 * (config inválida em tempo de execução, catálogo fora) é `completed` com
 * `isError` — a spec proíbe `failed` para isso; `failed` fica para o que não
 * é resultado de ferramenta (dono do job morreu).
 */
function taskStatusOf(job: JobView): TaskStatus {
  if (job.status === 'queued' || job.status === 'working') return 'working';
  if (job.status === 'failed') return job.failure === 'orphaned' ? 'failed' : 'completed';
  return job.status;
}

function taskBase(job: JobView): Omit<CreateTaskResult, 'resultType'> {
  return {
    taskId: job.jobId,
    status: taskStatusOf(job),
    statusMessage:
      job.status === 'queued' && job.queuePosition
        ? `na fila de runs pesadas (posição ${job.queuePosition})`
        : job.statusMessage,
    createdAt: job.createdAt,
    lastUpdatedAt: job.lastUpdatedAt,
    ttlMs: job.ttlMs,
    pollIntervalMs: job.pollIntervalMs,
  };
}

/**
 * Resultado de `tasks/get`: o estado da task e, quando `completed`, o
 * CallToolResult (o MESMO resumo que a tool bloqueante devolvia; erro de
 * ferramenta vai como `isError`). `cancelled` não promete resultado: o
 * parcial é lido por get_result (o id está no statusMessage).
 */
export function taskGetResult(job: JobView): Record<string, unknown> {
  const base: Record<string, unknown> = { resultType: 'complete', ...taskBase(job) };
  const status = taskStatusOf(job);
  if (status === 'completed') {
    base.result =
      job.status === 'failed'
        ? { content: [{ type: 'text', text: job.error ?? 'o job falhou' }], isError: true }
        : { content: [{ type: 'text', text: JSON.stringify(job.result ?? {}, null, 2) }], isError: false };
  } else if (status === 'failed') {
    base.error = { code: -32603, message: job.error ?? 'o job falhou' };
  }
  return base;
}

/** Marca um resultado JÁ no formato do protocolo (não vira texto JSON). */
const RAW_RESULT = Symbol('mcp.rawResult');
type RawResult = { [RAW_RESULT]: Record<string, unknown> };

function rawResult(result: Record<string, unknown>): RawResult {
  return { [RAW_RESULT]: result };
}

function isRawResult(v: unknown): v is RawResult {
  return typeof v === 'object' && v !== null && RAW_RESULT in v;
}

// ---------------------------------------------------------------------------
// Tools longas sobre jobs (IMPL-026)
// ---------------------------------------------------------------------------

/** Graça para o job parar depois que a requisição que o esperava foi cancelada. */
const CANCEL_SETTLE_MS = SHUTDOWN_GRACE_MS;

function budgetOf(v: unknown): number {
  const budgetUsd = numOf(v);
  if (budgetUsd === undefined || !Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    throw new Error('budgetUsd é obrigatório e deve ser maior que zero.');
  }
  return budgetUsd;
}

function optionalIdempotencyKey(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isValidIdempotencyKey(v)) {
    throw new Error('idempotencyKey deve ser um texto de 1 a 256 caracteres (ex.: um UUID seu).');
  }
  return v;
}

/** Motivo legível de um sinal abortado (sem o prefixo "Run cancelada:"). */
function motivoDoSinal(signal: AbortSignal): string {
  const r: unknown = signal.reason;
  const msg = r instanceof Error ? r.message : typeof r === 'string' ? r : 'requisição cancelada';
  return umaLinha(msg.replace(/^Run cancelada:\s*/u, '') || 'requisição cancelada');
}

/** Resposta de job ainda em andamento: o agente segue por run_status. */
function emAndamento(job: JobView): Record<string, unknown> {
  return {
    jobId: job.jobId,
    status: job.status,
    statusMessage: job.statusMessage,
    runId: job.runId,
    sessionId: job.sessionId,
    queuePosition: job.queuePosition,
    progress: job.progress,
    pollIntervalMs: job.pollIntervalMs,
    next:
      'A run segue em segundo plano. Acompanhe com run_status({jobId}) a cada ≥ 5 s; ' +
      'pare com cancel_run({jobId}). Não chame esta tool de novo sem a MESMA idempotencyKey.',
  };
}

/**
 * Resultado de uma tool longa a partir do job: terminal = o MESMO resumo que
 * a tool sempre devolveu; em andamento = o handle do job.
 */
function resultadoDoJob(job: JobView, errosComoResultado: boolean): unknown {
  if (job.status === 'failed') {
    const msg = job.error ?? 'o job falhou';
    if (errosComoResultado) return { ok: false, error: msg, jobId: job.jobId };
    throw new Error(msg);
  }
  if (job.result) return job.result;
  if (isTerminalJobStatus(job.status)) {
    return { jobId: job.jobId, status: job.status, statusMessage: job.statusMessage };
  }
  return emAndamento(job);
}

/**
 * Tool longa (run_benchmark/train_prompt/run_agent_benchmark) sobre um job:
 * cria (ou reencontra pela idempotency-key) e espera no MÁXIMO
 * `blockingWaitMs` (< 30 s). Cliente com Tasks declarada recebe a task na
 * hora. Requisição cancelada (notifications/cancelled, EOF, SIGTERM) cancela
 * o job que ela esperava e devolve o parcial (o session suprime a resposta
 * quando quem cancelou foi o cliente).
 */
async function runLongTool(
  tool: string,
  input: RunJobInput,
  args: Record<string, unknown>,
  apiKey: string,
  ctx: ToolCtx,
  errosComoResultado = false,
): Promise<unknown> {
  const { job } = await ctx.jobs.start(input, apiKey, {
    tool,
    idempotencyKey: optionalIdempotencyKey(args.idempotencyKey),
    ttlMs: clampJobTtlMs(args.ttlSeconds),
  });
  // "Durably created": o registro já está em disco — tasks/get resolve.
  if (ctx.tasks) return rawResult({ resultType: 'task', ...taskBase(job) });
  // A requisição cancelada cancela o job que ela espera DENTRO do evento de
  // abort: `cancel` de um job deste processo aborta o sinal do motor antes do
  // primeiro await. Qualquer salto assíncrono aqui (ler status, progresso)
  // deixava chamadas pagas saírem depois do cancel.
  const pararJob = (): void => void ctx.jobs.cancel(job.jobId, motivoDoSinal(ctx.signal)).catch(() => undefined);
  if (ctx.signal.aborted) pararJob();
  else ctx.signal.addEventListener('abort', pararJob, { once: true });
  try {
    const fim = await ctx.jobs.wait(job.jobId, ctx.blockingWaitMs, ctx.signal);
    if (ctx.signal.aborted) {
      const parado = await ctx.jobs.wait(job.jobId, CANCEL_SETTLE_MS);
      return resultadoDoJob(parado ?? job, errosComoResultado);
    }
    return resultadoDoJob(fim ?? job, errosComoResultado);
  } finally {
    ctx.signal.removeEventListener('abort', pararJob);
  }
}

/**
 * Config de start_run: arena-agent-config@1 (objeto ou JSON string),
 * arena-config@1 ou RunConfig. O TIPO do job sai da própria config.
 */
async function jobInputFromStartArgs(args: Record<string, unknown>): Promise<RunJobInput> {
  const budgetUsd = budgetOf(args.budgetUsd);
  let raw: unknown = args.config;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error('config não é um JSON válido.');
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config é obrigatório (objeto).');
  if ((raw as Record<string, unknown>).format === ARENA_AGENT_CONFIG_FORMAT) {
    const cfg = parseAgentConfigRaw(raw);
    return { kind: cfg.mode === 'training' ? 'training' : 'agent', config: { ...cfg, budgetUsd }, budgetUsd };
  }
  const cfg = await toRunConfig(raw);
  return { kind: cfg.mode === 'training' ? 'training' : 'benchmark', config: { ...cfg, budgetUsd }, budgetUsd };
}

// Schemas curtos de propósito: tools/list entra no contexto do agente a cada
// turno. `ttlSeconds` só aparece no start_run (as tools longas o aceitam igual).
const IDEMPOTENCY_KEY_SCHEMA = { type: 'string', description: 'retry com a mesma chave = mesmo job' };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const numOf = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

async function toRunConfig(raw: unknown): Promise<RunConfig> {
  if (typeof (raw as Record<string, unknown>)?.format === 'string') {
    const p = parseArenaConfig(raw);
    if (!p.ok) throw new Error(p.error);
    const c = arenaConfigToRunConfig(p.config);
    if (!c.ok) throw new Error(c.error);
    return c.config;
  }
  const p = parseRunConfig(raw);
  if (!p.ok) throw new Error(p.error);
  return p.config;
}

// Config de agente chega como STRING JSON (arena-agent-config@1). Aceita tambem
// objeto por robustez, mas o contrato do schema e a string.
function parseAgentConfigRaw(config: unknown): RunConfig {
  let raw: unknown = config;
  if (typeof config === 'string') {
    try {
      raw = JSON.parse(config);
    } catch {
      throw new Error('config não é um JSON válido de arena-agent-config@1.');
    }
  }
  const p = parseArenaAgentConfig(raw);
  if (!p.ok) throw new Error(p.error);
  const c = arenaAgentConfigToRunConfig(p.config);
  if (!c.ok) throw new Error(c.error);
  return c.config;
}

const TOOLS: McpTool[] = [
  {
    name: 'list_models',
    description:
      'Lista modelos do OpenRouter com preço e, principalmente, quais níveis de raciocínio ' +
      '(think levels) cada um aceita. Use ANTES de escolher um modelo ou um nível de esforço.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'filtra por parte do id ou do nome' },
        limit: { type: 'number', description: 'máximo de resultados (padrão 20)' },
      },
    },
    run: async (args, apiKey) => {
      const cat = await ensureCatalog(apiKey);
      const busca = str(args.search)?.toLowerCase();
      let rows = cat.models;
      if (busca) {
        rows = rows.filter(
          (m) => m.id.toLowerCase().includes(busca) || m.name.toLowerCase().includes(busca),
        );
      }
      return {
        count: rows.length,
        models: rows.slice(0, numOf(args.limit) ?? 20).map(toExportRow),
      };
    },
  },
  {
    name: 'estimate_cost',
    description:
      'Estima quanto uma configuração vai custar, SEM chamar nenhum modelo. ' +
      'Aceita arena-config@1 ou RunConfig. Rode isto antes de qualquer run cara.',
    inputSchema: {
      type: 'object',
      properties: { config: { type: 'object', description: 'a configuração da run' } },
      required: ['config'],
    },
    run: async (args, apiKey) => {
      const cfg = await toRunConfig(args.config);
      const cat = await ensureCatalog(apiKey);
      return estimateRunCost(estimateInputFromConfig(cfg), cat.models);
    },
  },
  {
    name: 'start_run',
    description:
      'Inicia uma run (compare/vary/training/agentes) em segundo plano e devolve o jobId na hora. ' +
      'Depois: run_status (poll ≥ 5 s) e cancel_run. idempotencyKey obrigatória: reuse-a nos retries ' +
      '(mesma chave = mesmo job, nunca uma 2ª run paga).',
    inputSchema: {
      type: 'object',
      properties: {
        // `type` único de propósito: clientes com schema subconjunto de
        // OpenAPI (Gemini) recusam união de tipos. String JSON é aceita também.
        config: { type: 'object', description: 'arena-config@1, RunConfig ou arena-agent-config@1' },
        budgetUsd: { type: 'number', description: 'teto de gasto em USD' },
        idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
        ttlSeconds: { type: 'number', description: 'prazo máximo; passado, cancela (padrão 7200)' },
      },
      required: ['config', 'budgetUsd', 'idempotencyKey'],
    },
    compact: true,
    run: async (args, apiKey, { jobs }) => {
      if (!isValidIdempotencyKey(args.idempotencyKey)) {
        throw new Error(
          'idempotencyKey é obrigatória (texto de 1 a 256 caracteres): gere uma (ex.: UUID) e REUSE-a ' +
            'nos retries deste mesmo pedido.',
        );
      }
      const input = await jobInputFromStartArgs(args);
      // Só valida e grava: o catálogo e a run rodam no job (fora do caminho da
      // resposta — o id sai em < 500 ms). Se ESTA requisição for cancelada
      // depois daqui, o job segue: o retry com a mesma chave o reencontra.
      const { job, created } = await jobs.start(input, apiKey, {
        tool: 'start_run',
        idempotencyKey: args.idempotencyKey,
        ttlMs: clampJobTtlMs(args.ttlSeconds),
      });
      return { created, ...job };
    },
  },
  {
    name: 'run_status',
    description: 'Estado de um job (fila, progresso, gasto) e, no fim, o resumo. waitSeconds ≤ 25 espera o fim.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' }, waitSeconds: { type: 'number' } },
      required: ['jobId'],
    },
    noKey: true,
    compact: true,
    run: async (args, _key, { jobs, signal }) => {
      assertValidRecordId(args.jobId, 'jobId');
      const v = await jobs.wait(args.jobId, clampWaitMs(args.waitSeconds), signal);
      if (!v) throw new Error('job não encontrado (id desconhecido ou já expirado).');
      return v;
    },
  },
  {
    name: 'cancel_run',
    description: 'Cancela um job: nenhuma chamada paga nova; o parcial fica gravado (get_result).',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' }, waitSeconds: { type: 'number' } },
      required: ['jobId'],
    },
    noKey: true,
    compact: true,
    run: async (args, _key, { jobs, signal }) => {
      assertValidRecordId(args.jobId, 'jobId');
      const pedido = await jobs.cancel(args.jobId, 'cancel_run');
      if (!pedido) throw new Error('job não encontrado (id desconhecido ou já expirado).');
      const v = await jobs.wait(args.jobId, clampWaitMs(args.waitSeconds, 10_000), signal);
      return v ?? pedido;
    },
  },
  {
    name: 'run_benchmark',
    description:
      'Benchmark (compare ou vary): espera até 25 s e devolve o resultado ou o jobId (siga com ' +
      'run_status). Prefira start_run. budgetUsd é OBRIGATÓRIO.',
    inputSchema: {
      type: 'object',
      properties: {
        config: { type: 'object' },
        budgetUsd: { type: 'number', description: 'teto de gasto em USD' },
        idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
      },
      required: ['config', 'budgetUsd'],
    },
    run: async (args, apiKey, ctx) => {
      const base = await toRunConfig(args.config);
      const budgetUsd = budgetOf(args.budgetUsd);
      if (base.mode === 'training') {
        throw new Error('Use train_prompt para o modo training.');
      }
      const input: RunJobInput = { kind: 'benchmark', config: { ...base, budgetUsd }, budgetUsd };
      return runLongTool('run_benchmark', input, args, apiKey, ctx);
    },
  },
  {
    name: 'train_prompt',
    description:
      'Treina um system prompt (campeão, holdout, significância): espera até 25 s e devolve o ' +
      'resultado ou o jobId. Prefira start_run. budgetUsd é OBRIGATÓRIO.',
    inputSchema: {
      type: 'object',
      properties: {
        config: { type: 'object', description: 'configuração com mode "training"' },
        budgetUsd: { type: 'number' },
        idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
      },
      required: ['config', 'budgetUsd'],
    },
    run: async (args, apiKey, ctx) => {
      const base = await toRunConfig(args.config);
      const budgetUsd = budgetOf(args.budgetUsd);
      if (base.mode !== 'training') throw new Error('config.mode precisa ser "training".');
      const input: RunJobInput = { kind: 'training', config: { ...base, budgetUsd }, budgetUsd };
      return runLongTool('train_prompt', input, args, apiKey, ctx);
    },
  },
  {
    name: 'get_result',
    description: 'Lê o resultado completo de uma run ou sessão já executada, pelo id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        kind: { type: 'string', enum: ['run', 'session'] },
      },
      required: ['id'],
    },
    noKey: true,
    run: async (args) => {
      // IMPL-024: id com '../' (ou fora do formato) é REJEITADO antes de tocar o
      // disco — a mensagem não ecoa o valor recebido.
      const id = args.id;
      assertValidRecordId(id);
      const kind = args.kind;
      if (kind !== undefined && kind !== 'run' && kind !== 'session') {
        throw new Error('kind deve ser "run" ou "session".');
      }
      if (kind === 'session') return (await loadSession(id)) ?? { error: 'sessão não encontrada' };
      return (await loadRun(id)) ?? (await loadSession(id)) ?? { error: 'não encontrado' };
    },
  },
  {
    name: 'run_agent_benchmark',
    description:
      'Benchmark de AGENTES (arena-agent-config@1): espera até 25 s e devolve o resumo ou o jobId. ' +
      'Prefira start_run. config é um JSON string; budgetUsd é OBRIGATÓRIO.',
    inputSchema: {
      type: 'object',
      properties: {
        config: { type: 'string', description: 'JSON string de arena-agent-config@1' },
        budgetUsd: { type: 'number', description: 'teto de gasto em USD' },
        idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
      },
      required: ['config', 'budgetUsd'],
    },
    run: async (args, apiKey, ctx) => {
      // Validacao nunca derruba o servidor: erros viram {ok:false, error}.
      let cfg: RunConfig;
      try {
        cfg = parseAgentConfigRaw(args.config);
      } catch (err) {
        return { ok: false, error: publicErrorMessage(err) };
      }
      const budgetUsd = numOf(args.budgetUsd);
      if (budgetUsd === undefined || budgetUsd <= 0) {
        return { ok: false, error: 'budgetUsd é obrigatório e deve ser maior que zero.' };
      }
      const input: RunJobInput = { kind: 'agent', config: { ...cfg, budgetUsd }, budgetUsd };
      try {
        return await runLongTool('run_agent_benchmark', input, args, apiKey, ctx, true);
      } catch (err) {
        if (isControlSignal(err)) throw err;
        // IMPL-024: erro de workspace/executor costuma citar caminho absoluto.
        return { ok: false, error: publicErrorMessage(err) };
      }
    },
  },
  {
    name: 'get_agent_dossier',
    description:
      'Lê o dossiê (dossier.md) de uma execução de agente — o MESMO texto que o juiz viu. ' +
      'Diagnóstico: para entender por que um contestant perdeu uma etapa.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        stageIndex: { type: 'number' },
        contestantId: { type: 'string' },
        repetition: { type: 'number', description: '0-based; default 0' },
      },
      required: ['runId', 'stageIndex', 'contestantId'],
    },
    noKey: true,
    run: async (args) => {
      assertValidRecordId(args.runId, 'runId');
      const rec = await loadRun(args.runId);
      const stage = rec?.stages[numOf(args.stageIndex) ?? 0];
      const ref = stage?.responses.find(
        (r) => r.contestantId === str(args.contestantId) && r.execution && r.execution.repetition === (numOf(args.repetition) ?? 0),
      )?.execution;
      if (!ref) return { ok: false, error: 'dossier não encontrado' };
      const content = await readArtifact(ref, 'dossier.md');
      if (content === null) return { ok: false, error: 'dossier não encontrado' };
      const sha256 = createHash('sha256').update(content).digest('hex');
      return { ok: true, dossier: content, sha256, truncated: Boolean(ref.dossierTruncated) };
    },
  },
  {
    name: 'read_docs',
    description:
      'Lê a documentação embarcada nesta versão do prompt-builder. ' +
      'Sem "topic", devolve a lista de tópicos. Comece por "quickstart".',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string' } },
    },
    noKey: true,
    run: async (args) => {
      if (args.topic === undefined || args.topic === '') {
        const raw = await fs.readFile(path.join(PKG_DOCS_DIR, 'index.json'), 'utf-8');
        return JSON.parse(raw);
      }
      // IMPL-024: tópico por ALLOWLIST (mesma função do `docs` do CLI) — o input
      // nunca entra num path.join; `{topic:'../README'}` é rejeitado.
      const lido = await readDocTopic(args.topic);
      if (!lido.ok) throw new Error(lido.message);
      return { topic: lido.topic, content: lido.content };
    },
  },
];

/** Resultado de `tools/call` (o `result` do JSON-RPC). */
export interface ToolCallResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface CallToolOptions {
  /** Cancelamento cooperativo (IMPL-025): vira o AbortSignal do motor. */
  signal?: AbortSignal;
  /** Fila de runs pesadas. Padrão: a do processo (1 run por vez). */
  lane?: HeavyLane;
  /** Narração (stderr no servidor real). */
  log?: (msg: string) => void;
  /** Só testes: substitui a tabela de ferramentas. */
  tools?: readonly McpTool[];
  /** Jobs (IMPL-026). Padrão: o gerente do processo (fila do processo). */
  jobs?: JobManager;
  /** O cliente declarou a extensão Tasks para esta chamada. */
  tasks?: boolean;
  /** Teto da espera de uma tool longa (padrão e máximo: BLOCKING_TOOL_LIMIT_MS). */
  blockingWaitMs?: number;
}

/** Resultado de `tools/call`: CallToolResult ou, com Tasks declarada, a task. */
export type ToolCallResponse = ToolCallResult | CreateTaskResult;

/** Sinal que nunca aborta — chamadas diretas (testes, CLI) sem cancelamento. */
const NUNCA_ABORTA = new AbortController().signal;

/**
 * Executa UMA tool e devolve o `result` do `tools/call`. Exportado para os
 * testes de contrato (test/security-baseline.test.ts). Erro de ferramenta vai
 * como resultado com `isError`, não como erro de protocolo: o agente precisa
 * LER a mensagem para se corrigir — e ela sai sem caminho absoluto (IMPL-024).
 */
export async function callTool(
  name: unknown,
  args: Record<string, unknown>,
  getKey: () => Promise<string> = async () => '',
  opts: CallToolOptions = {},
): Promise<ToolCallResponse | null> {
  const tool = (opts.tools ?? TOOLS).find((t) => t.name === name);
  if (!tool) return null;
  const signal = opts.signal ?? NUNCA_ABORTA;
  const lane = opts.lane ?? processLane;
  const ctx: ToolCtx = {
    signal,
    exclusive: (fn) => {
      if (lane.busy) {
        opts.log?.(
          `[mcp] ${tool.name} aguardando a vez — 1 run pesada por processo ` +
            `(${lane.snapshot().queued + 1} na fila)`,
        );
      }
      return lane.run(fn, signal);
    },
    jobs: opts.jobs ?? defaultJobManager(),
    tasks: opts.tasks === true,
    // Nenhum tools/call segura mais que o teto (< 30 s), nem por configuração.
    blockingWaitMs: Math.min(opts.blockingWaitMs ?? BLOCKING_TOOL_LIMIT_MS, BLOCKING_TOOL_LIMIT_MS),
  };
  try {
    const key = tool.noKey ? '' : await getKey();
    const out = await tool.run(args, key, ctx);
    if (isRawResult(out)) return out[RAW_RESULT] as unknown as CreateTaskResult;
    const text = tool.compact ? JSON.stringify(out) : JSON.stringify(out, null, 2);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: publicErrorMessage(err) }], isError: true };
  }
}

// ---------------------------------------------------------------------------
// Sessão JSON-RPC (transporte-agnóstica: o stdio real e os testes a dirigem)
// ---------------------------------------------------------------------------

export interface McpSessionOptions {
  /** Escreve UMA mensagem JSON-RPC (uma linha) no transporte. */
  write: (msg: Record<string, unknown>) => void;
  /** Resolvida preguiçosamente: `read_docs` funciona sem key. */
  getKey?: () => Promise<string>;
  log?: (msg: string) => void;
  lane?: HeavyLane;
  /** Graça do encerramento (EOF/SIGTERM). Padrão SHUTDOWN_GRACE_MS (10 s). */
  graceMs?: number;
  /** Só testes: substitui a tabela de ferramentas. */
  tools?: readonly McpTool[];
  /** Jobs do processo (IMPL-026). Padrão: um gerente sobre `lane`. */
  jobs?: JobManager;
  /** Teto da espera de uma tool longa (padrão/máximo BLOCKING_TOOL_LIMIT_MS). */
  blockingWaitMs?: number;
}

export interface ShutdownResult {
  /** A graça esgotou com chamadas ainda pendentes (o processo sai assim mesmo). */
  forced: boolean;
  /** Chamadas ainda pendentes quando a espera terminou. */
  pending: number;
}

interface InflightCall {
  tool: string;
  controller: AbortController;
  /** Cancelada pelo CLIENTE (notifications/cancelled): nenhuma resposta sai. */
  cancelled: boolean;
  done: Promise<void>;
}

/**
 * Chave do mapa de chamadas em voo. JSON-RPC distingue `1` de `"1"`, e o
 * `requestId` do cancelamento precisa casar com o id EXATO da requisição.
 */
function requestKey(id: unknown): string {
  return JSON.stringify(id);
}

/** Texto curto e de uma linha para a narração (motivo vem do cliente). */
function umaLinha(v: unknown, max = 200): string {
  return String(v).replace(/\s+/gu, ' ').trim().slice(0, max);
}

/**
 * Linha de narração do parcial de uma chamada cancelada, a partir do resumo
 * que a ferramenta devolveu (e que NÃO vai ao cliente): onde ficou gravado,
 * como terminou e quanto o ledger mediu. É o "log do ledger" do cancelamento.
 */
function resumoDoParcial(result: ToolCallResponse | null): string | undefined {
  try {
    const texto = result && 'content' in result ? result.content[0]?.text : undefined;
    const out = JSON.parse(texto ?? '') as {
      runId?: unknown;
      sessionId?: unknown;
      status?: unknown;
      stoppedReason?: unknown;
      totalCostUsd?: unknown;
    };
    const alvo =
      typeof out.runId === 'string'
        ? `run ${out.runId}`
        : typeof out.sessionId === 'string'
          ? `sessão ${out.sessionId}`
          : undefined;
    if (!alvo) return undefined;
    const fim = [out.status, out.stoppedReason].filter((x) => typeof x === 'string').join('/');
    const gasto = typeof out.totalCostUsd === 'number' ? `, gasto medido US$ ${out.totalCostUsd.toFixed(6)}` : '';
    return `${alvo} ${fim}${gasto} — parcial em get_result`;
  } catch {
    return undefined;
  }
}

export class McpSession {
  private readonly inflight = new Map<string, InflightCall>();
  private closing: Promise<ShutdownResult> | null = null;
  private readonly log: (msg: string) => void;
  /** Jobs deste processo: start_run/run_status/cancel_run, tools longas e Tasks. */
  readonly jobs: JobManager;
  /**
   * O cliente declarou a extensão Tasks no `initialize` (sessão legacy). Na
   * era 2026-07-28 a declaração vem POR REQUISIÇÃO em `_meta` — as duas valem.
   */
  private tasksNaSessao = false;

  constructor(private readonly opts: McpSessionOptions) {
    this.log = opts.log ?? (() => undefined);
    this.jobs = opts.jobs ?? new JobManager({ lane: opts.lane, log: this.log });
  }

  /** Chamadas de ferramenta ainda em andamento. */
  get pendingCalls(): number {
    return this.inflight.size;
  }

  /** Encerramento já pedido (EOF/SIGTERM): novas `tools/call` são recusadas. */
  get isClosing(): boolean {
    return this.closing !== null;
  }

  /**
   * Uma linha do transporte. NUNCA espera a ferramenta terminar: devolve o
   * controle ao laço de leitura na hora, e a resposta sai quando ela assentar.
   */
  handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.replyError(null, -32700, 'JSON inválido');
      return;
    }
    this.handleMessage(msg);
  }

  handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this.replyError(null, -32600, 'Requisição inválida');
      return;
    }
    const req = msg as JsonRpcRequest & { result?: unknown; error?: unknown };
    // Notificacoes (sem `id`) nao recebem resposta — responder quebra o cliente.
    const isNotification = req.id === undefined || req.id === null;
    if (typeof req.method !== 'string') {
      // Resposta do cliente (este servidor nunca pede nada) ou lixo sem método.
      if (!isNotification && !('result' in req) && !('error' in req)) {
        this.replyError(req.id, -32600, 'Requisição inválida');
      }
      return;
    }

    try {
      switch (req.method) {
        case 'initialize': {
          const params = (req.params ?? {}) as Record<string, unknown>;
          const pedido = str(params.protocolVersion);
          this.tasksNaSessao = declaresTasks(params.capabilities);
          this.reply(req.id, {
            // Ecoa a versao pedida quando conhecida; senao anuncia a nossa.
            protocolVersion: pedido ?? PROTOCOL_VERSION,
            // A extensão só é anunciada a quem a declarou: cliente legacy sem
            // ela não vê campo desconhecido em `capabilities`.
            capabilities: this.tasksNaSessao ? { tools: {}, extensions: { [TASKS_EXTENSION]: {} } } : { tools: {} },
            serverInfo: SERVER_INFO,
          });
          return;
        }
        case 'notifications/initialized':
          return;
        case 'notifications/cancelled':
          this.cancel(req.params);
          return;
        case 'ping':
          if (!isNotification) this.reply(req.id, {});
          return;
        case 'tools/list':
          if (!isNotification) {
            this.reply(req.id, {
              tools: (this.opts.tools ?? TOOLS).map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
            });
          }
          return;
        case 'tools/call':
          // Sem id não haveria como devolver o resultado nem cancelar: uma run
          // paga disparada assim seria gasto órfão por construção.
          if (isNotification) {
            this.log('[mcp] tools/call sem id ignorado (notificação não pode disparar ferramenta)');
            return;
          }
          this.startCall(req.id as string | number, req.params);
          return;
        case 'tasks/get':
        case 'tasks/cancel':
        case 'tasks/update':
          if (!isNotification) this.handleTask(req.id as string | number, req.method, req.params);
          return;
        default:
          if (!isNotification) {
            this.replyError(req.id, -32601, `Método não suportado: ${umaLinha(req.method, 80)}`);
          }
      }
    } catch (err) {
      if (!isNotification) this.replyError(req.id, -32603, publicErrorMessage(err));
    }
  }

  /**
   * Encerramento gracioso (EOF do stdin, SIGTERM, stdout quebrado): aborta
   * TODAS as chamadas em voo — as runs gravam o parcial como 'aborted' — e
   * espera no máximo `graceMs`. As respostas dessas chamadas ainda saem (o
   * cliente não as cancelou; só foi embora). Idempotente.
   */
  shutdown(reason: string): Promise<ShutdownResult> {
    if (this.closing) return this.closing;
    const graceMs = this.opts.graceMs ?? SHUTDOWN_GRACE_MS;
    const calls = [...this.inflight.values()];
    for (const c of calls) c.controller.abort(new RunCancelled(`servidor MCP encerrando (${reason})`));
    // Jobs deste processo morrem com ele: cada run grava o parcial (IMPL-026).
    const jobs = this.jobs.shutdown(`servidor MCP encerrando (${reason})`);
    if (calls.length > 0 || jobs.length > 0) {
      this.log(
        `[mcp] encerrando (${reason}): ${calls.length} chamada(s) e ${jobs.length} job(s) em andamento ` +
          `abortado(s); graça de ${Math.round(graceMs / 1000)} s para gravar o parcial`,
      );
    }
    this.closing = settleWithin(
      [...calls.map((c) => c.done), ...jobs],
      graceMs,
    ).then((ok) => {
      const pending = this.inflight.size;
      if (!ok) this.log(`[mcp] graça esgotada com ${pending} chamada(s) pendente(s); saindo assim mesmo`);
      return { forced: !ok, pending };
    });
    return this.closing;
  }

  // --- interno ---------------------------------------------------------------

  private startCall(id: string | number, params: unknown): void {
    if (this.closing) {
      this.replyError(id, -32000, 'Servidor MCP encerrando: chamada recusada.');
      return;
    }
    const key = requestKey(id);
    if (this.inflight.has(key)) {
      // Ids precisam ser únicos na sessão; reusar um em voo tornaria o
      // cancelamento ambíguo (qual das duas parar?).
      this.replyError(id, -32600, 'id de requisição já em uso por uma chamada em andamento.');
      return;
    }
    const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
    const args =
      p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments)
        ? (p.arguments as Record<string, unknown>)
        : {};
    const call: InflightCall = {
      tool: umaLinha(p.name, 80),
      controller: new AbortController(),
      cancelled: false,
      done: Promise.resolve(),
    };
    this.inflight.set(key, call);
    call.done = (async () => {
      try {
        const result = await callTool(p.name, args, this.opts.getKey, {
          signal: call.controller.signal,
          lane: this.opts.lane,
          log: this.log,
          tools: this.opts.tools,
          jobs: this.jobs,
          tasks: this.tasksNaSessao || requestDeclaresTasks(params),
          blockingWaitMs: this.opts.blockingWaitMs,
        });
        if (call.cancelled) {
          // Spec (Cancellation): quem recebe o cancelamento NÃO responde. Não
          // existe "resultado parcial" no protocolo — o parcial vive no disco.
          const parcial = resumoDoParcial(result);
          this.log(
            `[mcp] ${umaLinha(id, 80)} (${call.tool}) cancelada — resposta suprimida` +
              (parcial ? `; ${parcial}` : ''),
          );
          return;
        }
        if (!result) {
          this.replyError(id, -32602, `Ferramenta desconhecida: ${call.tool}`);
          return;
        }
        this.reply(id, result);
      } catch (err) {
        // callTool não rejeita (erro de ferramenta vira isError); rede de segurança.
        if (!call.cancelled) this.replyError(id, -32603, publicErrorMessage(err));
      } finally {
        this.inflight.delete(key);
      }
    })();
  }

  private cancel(params: unknown): void {
    const p = (params ?? {}) as { requestId?: unknown; reason?: unknown };
    if (typeof p.requestId !== 'string' && typeof p.requestId !== 'number') return;
    const call = this.inflight.get(requestKey(p.requestId));
    // Desconhecida ou já respondida (a notificação cruzou com a resposta) — e
    // `initialize`, que nunca fica em voo: a spec manda ignorar.
    if (!call || call.cancelled) return;
    call.cancelled = true;
    const motivo = typeof p.reason === 'string' && p.reason.trim() ? umaLinha(p.reason) : 'sem motivo';
    this.log(
      `[mcp] notifications/cancelled para ${umaLinha(p.requestId, 80)} (${call.tool}): ${motivo} — ` +
        'abortando; nenhuma chamada paga nova e nenhuma resposta',
    );
    // O motivo é um SINAL DE CONTROLE: o fetch em voo rejeita com ele e os
    // catch que degradam (competidor/juiz/duelo) o re-lançam (isControlSignal).
    call.controller.abort(new RunCancelled(`cliente MCP cancelou (${motivo})`));
  }

  /**
   * `tasks/get` | `tasks/cancel` | `tasks/update` (extensão Tasks). Cliente que
   * não declarou a extensão recebe -32021 com `data.requiredCapabilities`
   * (MUST da spec). Assíncrono (lê disco), mas nunca prende o laço de leitura.
   */
  private handleTask(id: string | number, method: string, params: unknown): void {
    if (!this.tasksNaSessao && !requestDeclaresTasks(params)) {
      this.replyError(id, MISSING_CAPABILITY, 'Missing required client capability', {
        requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
      });
      return;
    }
    const taskId = (params as { taskId?: unknown } | null | undefined)?.taskId;
    void (async () => {
      try {
        if (method === 'tasks/update') {
          // Nenhum job daqui pede input (nunca fica em input_required).
          this.replyError(id, -32602, 'A task não está aguardando input (input_required).');
          return;
        }
        if (!isValidRecordId(taskId)) {
          this.replyError(id, -32602, 'taskId inválido.');
          return;
        }
        if (method === 'tasks/cancel') {
          // Cooperativo: reconhece o pedido; o estado vira 'cancelled' quando a
          // run gravar o parcial (tasks/get mostra).
          const v = await this.jobs.cancel(taskId, 'tasks/cancel do cliente');
          if (!v) this.replyError(id, -32602, 'Failed to retrieve task: Task not found');
          else this.reply(id, { resultType: 'complete' });
          return;
        }
        const job = await this.jobs.status(taskId, { progress: false });
        if (!job) {
          this.replyError(id, -32602, 'Failed to retrieve task: Task not found');
          return;
        }
        this.reply(id, taskGetResult(job));
      } catch (err) {
        this.replyError(id, -32603, publicErrorMessage(err));
      }
    })();
  }

  private reply(id: unknown, result: unknown): void {
    this.opts.write({ jsonrpc: '2.0', id, result });
  }

  private replyError(id: unknown, code: number, message: string, data?: unknown): void {
    this.opts.write({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });
  }
}

// ---------------------------------------------------------------------------
// Servidor por stdio
// ---------------------------------------------------------------------------

/** 128 + 15: convenção POSIX para "encerrado por SIGTERM". */
const EXIT_SIGTERM = 143;

type MotivoFim = 'eof' | 'SIGTERM' | 'SIGINT' | 'EPIPE';

function codigoDeSaida(motivo: MotivoFim): number {
  if (motivo === 'SIGTERM') return EXIT_SIGTERM;
  if (motivo === 'SIGINT') return EXIT.SIGINT;
  return EXIT.OK;
}

/** Espera o stdout escoar (pipe assíncrono fora do Linux), com teto. */
function flushStdout(maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, maxMs);
    process.stdout.write('', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export async function cmdMcp(argv: string[]): Promise<number> {
  const parsed = parse(argv, {});
  setDataDir(resolveHome(parsed.values));

  // A key e resolvida preguicosamente: `read_docs` funciona sem nenhuma key, e
  // um servidor MCP nao deve morrer no boot por causa disso.
  let apiKeyCache: string | null = null;
  const getKey = async (): Promise<string> => {
    if (apiKeyCache) return apiKeyCache;
    apiKeyCache = await resolveKey(parsed.values);
    return apiKeyCache;
  };

  // stdout é o canal JSON-RPC; narração vai para o stderr (o cliente a loga).
  let stdoutQuebrado = false;
  const session = new McpSession({
    write: (msg) => {
      if (!stdoutQuebrado) process.stdout.write(`${JSON.stringify(msg)}\n`);
    },
    getKey,
    log: (m) => {
      process.stderr.write(`${m}\n`);
    },
  });

  let motivo: MotivoFim | null = null;
  let terminar!: (m: MotivoFim) => void;
  const fim = new Promise<MotivoFim>((resolve) => (terminar = resolve));
  const pedirFim = (m: MotivoFim): void => {
    if (motivo) return;
    motivo = m;
    terminar(m);
  };

  // O laço de leitura só DESPACHA: nenhum handler espera ferramenta.
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => session.handleLine(line));
  // EOF do stdin = o cliente pediu o encerramento (transporte stdio do MCP).
  rl.once('close', () => pedirFim('eof'));

  const onSinal = (sig: 'SIGTERM' | 'SIGINT'): void => {
    // Segundo sinal durante a graça: o cliente perdeu a paciência — sai já.
    if (motivo) process.exit(codigoDeSaida(sig));
    pedirFim(sig);
  };
  const onSigterm = (): void => onSinal('SIGTERM');
  const onSigint = (): void => onSinal('SIGINT');
  // Cliente morreu: escrever no pipe fechado daria EPIPE e derrubaria o
  // processo SEM gravar o parcial das runs em voo.
  const onStdoutError = (): void => {
    stdoutQuebrado = true;
    pedirFim('EPIPE');
  };
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);
  process.stdout.on('error', onStdoutError);

  const razao = await fim;
  await session.shutdown(razao);
  rl.close();
  process.stdin.destroy();
  if (!stdoutQuebrado) await flushStdout(1000);
  process.off('SIGTERM', onSigterm);
  process.off('SIGINT', onSigint);
  // Saída EXPLÍCITA: depois da graça pode sobrar trabalho que ignorou o abort
  // (ou um socket vivo) e o cliente não pode ficar esperando o processo sumir.
  process.exit(codigoDeSaida(razao));
}
