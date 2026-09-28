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
//
// Negociação dual-era (IMPL-084, R-13:REC-2): o mesmo processo atende as duas
// revisões implementadas (2026-07-28 + 2025-11-25) e ACEITA as antigas
// (2025-06-18/2025-03-26) pela regra legacy. `server/discover` responde sempre
// (antes/depois de initialize) listando as suportadas; a versão pedida NUNCA é
// ecoada sem checar — desconhecida numa requisição moderna vira -32022
// (UnsupportedProtocolVersion) com data.supported/data.requested, e numa
// requisição legacy vira a mais recente implementada + lista de suportadas
// (regra antiga: "responder com uma versão suportada").
//
// Saídas (IMPL-086, R-13:REC-5): todo sucesso traz `structuredContent` + o
// MESMO JSON espelhado em content de texto COMPACTO (0 espaços após ':' e ','
// — indentação infla o contexto do agente sem dar nada). Teto de ~5 mil tokens
// por resposta (get_result resume por padrão e pagina por cursor), dura 25 mil
// no pico. Anotações (IMPL-085, R-13:REC-6) são honestas: um `readOnlyHint`
// NUNCA autoriza nada sozinho do lado do cliente.

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
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
import { PKG_DOCS_DIR, PKG_ROOT, pkgVersion } from '../../paths.js';
import { assertValidRecordId, isValidRecordId, publicErrorMessage } from '../../pathSafety.js';
import { readDocTopic } from './knowledge.js';
import { setDataDir, getDataDir, loadRun, loadSession, runSummary, sessionSummary } from '../../storage.js';
import { ensureCatalog } from '../../modelsCache.js';
import { toExportRow } from '../../modelCaps.js';
import { estimateInputFromConfig, estimateRunCost } from '../../estimate.js';
import { parseRunConfig } from '../../runConfigSchema.js';
import { ARENA_AGENT_CONFIG_FORMAT, parseArenaConfig, parseArenaAgentConfig } from '../../configFile.js';
import { arenaConfigToRunConfig, arenaAgentConfigToRunConfig } from '../../arenaConfig.js';
import { readArtifact } from '../../agent/store.js';
import { resolveHome, resolveKey, parse } from '../context.js';
import { ensureExecConfigApproved } from './agents.js';
import { EXIT } from '../output.js';
import type { RunConfig, RunRecord, SessionRecord, StageRecord } from '../../types.js';

// ---------------------------------------------------------------------------
// Negociação de versão do protocolo (IMPL-084, R-13:REC-2)
// ---------------------------------------------------------------------------

/**
 * Revisões IMPLEMENTADAS (dual-era no mesmo processo). O `server/discover`
 * lista exatamente estas duas e o cliente escolhe; é o que entra em
 * `data.supported` do -32022.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25'] as const;

/**
 * Revisões antigas ACEITAS pela regra legacy: a sessão funciona (dialecto de
 * tools é compatível) e a resposta ecoa a pedida — isto NÃO é "eco cego":
 * são versões reconhecidas, o eco proibido é o de versão desconhecida.
 */
export const LEGACY_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'] as const;

/** A mais recente implementada — resposta à versão desconhecida (regra legacy). */
export const LATEST_PROTOCOL_VERSION: string = SUPPORTED_PROTOCOL_VERSIONS[0];

/** UnsupportedProtocolVersion (renumerado de -32004 na spec 2026-07-28). */
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

const VERSOES_ACEITAS = new Set<string>([
  ...SUPPORTED_PROTOCOL_VERSIONS,
  ...LEGACY_PROTOCOL_VERSIONS,
]);

/** Versão declarada POR REQUISIÇÃO na era moderna (stateless): `_meta[...]`. */
const MODERN_VERSION_META = 'io.modelcontextprotocol/protocolVersion';

/** Requisição da era moderna? (`_meta` com chaves `io.modelcontextprotocol/*`). */
function requestDeclaresModernEra(params: unknown): boolean {
  const meta = (params as { _meta?: unknown } | null | undefined)?._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  return Object.keys(meta as Record<string, unknown>).some((k) => k.startsWith('io.modelcontextprotocol/'));
}

/** Versão pedida: `params.protocolVersion` (legacy) ou `_meta` (moderna). */
function requestedVersion(params: Record<string, unknown>): string | undefined {
  const direto = str(params.protocolVersion);
  if (direto !== undefined) return direto;
  const meta = params._meta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    return str((meta as Record<string, unknown>)[MODERN_VERSION_META]);
  }
  return undefined;
}

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

/**
 * Anotações de ferramenta (spec MCP). São DADO para o cliente decidir permissão
 * — mas `readOnlyHint` NUNCA autoriza nada sozinho: quem implementa cliente não
 * deve auto-aprovar por ele (a spec trata a anotação como dica, não mandato).
 */
export interface ToolAnnotations {
  /** Nome legível para humano (spec: `annotations.title`). */
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Anotações honestas (IMPL-085). Ausente = tool de teste/plugin sem declaração
   * (o cliente cai nos defaults conservadores da spec). As tools daqui declaram
   * todas as 4 dicas + title.
   */
  annotations?: ToolAnnotations;
  /**
   * Schema Zod ESTRITO dos argumentos (IMPL-085): campo desconhecido é
   * rejeitado com sugestão do mais parecido. `inputSchema` exposto é a
   * conversão deste schema para JSON Schema.
   */
  argsSchema?: z.ZodType;
  /** Shape da saída: sucesso devolve `structuredContent` + espelho compacto (IMPL-086). */
  outputSchema?: Record<string, unknown>;
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
        : // IMPL-086: espelho em JSON COMPACTO (o formato antigo indentava).
          { content: [{ type: 'text', text: JSON.stringify(job.result ?? {}) }], isError: false };
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

// ---------------------------------------------------------------------------
// Resumo de record (IMPL-086, R-13:REC-5)
// ---------------------------------------------------------------------------

/** Heurística do teste de contrato: ~3,5 caracteres por token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Teto padrão de uma resposta — 1/5 do default de 25 mil tokens do Claude Code. */
export const SOFT_RESULT_TOKENS = 5000;

/** Teto duro: acima disto a resposta estouraria qualquer cliente conhecido. */
export const HARD_RESULT_TOKENS = 25000;

/** Etapa em uma linha: nada de texto de resposta nem de julgamento inteiro. */
function etapaResumo(s: StageRecord): Record<string, unknown> {
  return {
    index: s.index,
    question: (s.spec?.question ?? '').slice(0, 160),
    done: Boolean(s.finishedAt),
    incomplete: s.incomplete === true,
    ...(s.incompleteReason ? { incompleteReason: s.incompleteReason } : {}),
    ...(s.error ? { error: umaLinha(s.error, 160) } : {}),
    judged: Boolean(s.judge ?? s.referenceJudge),
  };
}

/**
 * Referência ao record em disco (relativa ao data dir + `file://` para o
 * cliente que entende resource link). O resumo NUNCA embute o record inteiro:
 * quem quer tudo lê o arquivo ou pagina.
 */
function recordRef(kind: 'run' | 'session', id: string): Record<string, unknown> {
  const rel = kind === 'run' ? `runs/${id}.json` : `sessions/${id}.json`;
  return {
    file: rel,
    uri: `file://${path.join(getDataDir(), rel)}`,
    note: 'record completo em disco; peça fatias com cursor/limit ou detail:"full"',
  };
}

/**
 * Resumo por padrão (≤ 5 mil tokens): campos do `runSummary`/`sessionSummary`
 * (o MESMO cálculo do CLI) + uma fatia paginada de etapas por cursor.
 */
export function summarizeRecord(
  kind: 'run' | 'session',
  rec: RunRecord | SessionRecord,
  opts: { cursor?: string; limit?: number },
): Record<string, unknown> {
  const base =
    kind === 'run' ? runSummary(rec as RunRecord) : sessionSummary(rec as SessionRecord);
  const saida: Record<string, unknown> = {
    kind,
    detail: 'summary',
    ...base,
    // O parcial de um record cortado tem que dizer POR QUE parou ('budget' |
    // 'cancelled'): sem isto o resumo nao distingue corte de orcamento de
    // cancelamento do cliente — e o parcial so e "legivel" se denunciar o corte.
    ...(rec.stoppedReason ? { stoppedReason: rec.stoppedReason } : {}),
    ref: recordRef(kind, rec.id),
  };
  if (kind === 'run') {
    const run = rec as RunRecord;
    const etapas = run.stages ?? [];
    const limite = Math.min(Math.max(Math.trunc(opts.limit ?? 5), 1), 50);
    const inicio = opts.cursor === undefined ? 0 : Number.parseInt(opts.cursor, 10);
    if (!Number.isInteger(inicio) || inicio < 0) {
      throw new Error('cursor inválido: use o nextCursor devolvido pela resposta anterior.');
    }
    const fatia = etapas.slice(inicio, inicio + limite);
    const proximo = inicio + fatia.length;
    saida.stages = fatia.map(etapaResumo);
    saida.stageCount = etapas.length;
    saida.cursor = String(inicio);
    saida.nextCursor = proximo < etapas.length ? String(proximo) : null;
    saida.hasMore = proximo < etapas.length;
  }
  return saida;
}

/** Serializa um record completo OU o resumo + referência quando ele estoura o teto. */
function recordOuResumo(
  kind: 'run' | 'session',
  rec: RunRecord | SessionRecord,
  opts: { cursor?: string; limit?: number },
): Record<string, unknown> {
  const texto = JSON.stringify(rec);
  if (estimateTokens(texto) <= HARD_RESULT_TOKENS) return { kind, detail: 'full', ...rec };
  return {
    ...summarizeRecord(kind, rec, opts),
    truncated: true,
    note: `record com ~${estimateTokens(texto)} tokens — acima do teto de ${HARD_RESULT_TOKENS}; resumo + referência`,
  };
}

// Schemas curtos de propósito: tools/list entra no contexto do agente a cada
// turno. `ttlSeconds` está declarado em toda tool que o aceita (antes só o
// start_run o expunha, mas as longas aceitavam igual — campo aceito sem estar
// no schema é o mesmo que schema frouxo).

// --- argumentos por tool (fonte: Zod; o inputSchema é a conversão) -----------

/** `config` de run: objeto (arena-config@1/RunConfig) OU string JSON (robustez). */
const zRunConfig = z.union([z.record(z.string(), z.unknown()), z.string()]);
/** União de tipos no JSON Schema quebra clientes OpenAPI-subconjunto (Gemini). */
const CONFIG_OBJECT_SCHEMA = {
  type: 'object',
  description: 'a configuração da run (aceita também string JSON)',
};
const CONFIG_STRING_SCHEMA = {
  type: 'string',
  description: 'JSON string de arena-agent-config@1 (aceita também objeto)',
};

const LIST_MODELS_ARGS = z.strictObject({
  search: z.string().describe('filtra por parte do id ou do nome').optional(),
  limit: z.number().describe('máximo de resultados (padrão 20)').optional(),
});
const ESTIMATE_COST_ARGS = z.strictObject({
  config: zRunConfig.describe('a configuração da run'),
});
const START_RUN_ARGS = z.strictObject({
  config: zRunConfig.describe('arena-config@1, RunConfig ou arena-agent-config@1'),
  budgetUsd: z.number('budgetUsd é obrigatório e deve ser maior que zero.').describe('teto de gasto em USD'),
  idempotencyKey: z
    .string('idempotencyKey é obrigatória (texto de 1 a 256 caracteres): gere uma (ex.: UUID) e REUSE-a nos retries deste mesmo pedido.')
    .describe('retry com a mesma chave = mesmo job'),
  ttlSeconds: z.number().describe('prazo máximo; passado, cancela (padrão 7200)').optional(),
  allowExecConfig: z
    .boolean()
    .describe('aceite do config EXECUTÁVEL de agente (grava o pin SHA-256; IMPL-099)')
    .optional(),
});
const RUN_STATUS_ARGS = z.strictObject({
  jobId: z.string('jobId obrigatório').describe('id devolvido por start_run'),
  waitSeconds: z.number().describe('espera até 25 s pelo fim').optional(),
});
const CANCEL_RUN_ARGS = z.strictObject({
  jobId: z.string('jobId obrigatório').describe('id devolvido por start_run'),
  waitSeconds: z.number().describe('espera o parcial ser gravado (padrão 10 s)').optional(),
});
const RUN_BENCHMARK_ARGS = z.strictObject({
  config: zRunConfig.describe('arena-config@1 ou RunConfig'),
  budgetUsd: z.number('budgetUsd é obrigatório e deve ser maior que zero.').describe('teto de gasto em USD'),
  idempotencyKey: z.string().describe('retry com a mesma chave = mesmo job').optional(),
  ttlSeconds: z.number().describe('prazo máximo; passado, cancela (padrão 7200)').optional(),
});
const TRAIN_PROMPT_ARGS = z.strictObject({
  config: zRunConfig.describe('configuração com mode "training"'),
  budgetUsd: z.number('budgetUsd é obrigatório e deve ser maior que zero.').describe('teto de gasto em USD'),
  idempotencyKey: z.string().describe('retry com a mesma chave = mesmo job').optional(),
  ttlSeconds: z.number().describe('prazo máximo; passado, cancela (padrão 7200)').optional(),
});
const GET_RESULT_ARGS = z.strictObject({
  id: z.string('id obrigatório').describe('id da run ou sessão'),
  kind: z.enum(['run', 'session']).describe('"run" ou "session"').optional(),
  detail: z.enum(['summary', 'full']).describe('padrão summary (≤ 5 mil tokens)').optional(),
  cursor: z.string().describe('cursor da página de etapas').optional(),
  limit: z.number().describe('etapas por página (padrão 5)').optional(),
});
const RUN_AGENT_ARGS = z.strictObject({
  config: zRunConfig.describe('JSON string de arena-agent-config@1'),
  budgetUsd: z.number('budgetUsd é obrigatório e deve ser maior que zero.').describe('teto de gasto em USD'),
  idempotencyKey: z.string().describe('retry com a mesma chave = mesmo job').optional(),
  allowExecConfig: z
    .boolean()
    .describe('aceite do config EXECUTÁVEL (grava o pin SHA-256; IMPL-099)')
    .optional(),
  ttlSeconds: z.number().describe('prazo máximo; passado, cancela (padrão 7200)').optional(),
});
const GET_DOSSIER_ARGS = z.strictObject({
  runId: z.string('runId obrigatório').describe('id da run'),
  stageIndex: z.number('stageIndex obrigatório').describe('índice da etapa'),
  contestantId: z.string('contestantId obrigatório').describe('id do contestant'),
  repetition: z.number().describe('0-based; default 0').optional(),
});
const READ_DOCS_ARGS = z.strictObject({
  topic: z.string().describe('tópico da allowlist; vazio lista os tópicos').optional(),
});

const MODELOS_OUTPUT = {
  type: 'object',
  properties: { count: { type: 'number' }, models: { type: 'array' } },
  additionalProperties: true,
} as const;

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

/** O `config` da tool como OBJETO (string JSON parseada); `null` se não der. */
function rawConfigObject(config: unknown): Record<string, unknown> | null {
  let raw: unknown = config;
  if (typeof config === 'string') {
    try {
      raw = JSON.parse(config);
    } catch {
      return null;
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/**
 * Portão de config EXECUTÁVEL das tools (IMPL-099, R-15:REC-6): as tools que
 * rodam `arena-agent-config` (setup[]/verify[] na máquina de quem chama) passam
 * pelo MESMO portão do `agents run` — aceite explícito (`allowExecConfig:
 * true`) + pin SHA-256 do conteúdo, aprovação ÚNICA por conteúdo (mudou ⇒ a
 * revisão revive). Devolve a recusa estruturada ou `null` quando aprovado.
 */
async function execConfigGateForTool(
  toolName: string,
  rawConfig: Record<string, unknown>,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    await ensureExecConfigApproved({
      dataDir: getDataDir(),
      content: JSON.stringify(rawConfig),
      identity: `mcp:${toolName}`,
      label: `config de ${toolName}`,
      command: `${toolName}({…, allowExecConfig: true})`,
      allowExecConfig: args.allowExecConfig === true,
    });
    return null;
  } catch (err) {
    if (isControlSignal(err)) throw err;
    const e = err as { message?: unknown; errorCode?: unknown; hint?: unknown };
    return {
      ok: false,
      code: typeof e.errorCode === 'string' ? e.errorCode : 'config.exec_not_approved',
      error: typeof e.message === 'string' ? e.message : String(err),
      hint: typeof e.hint === 'string' ? e.hint : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Schemas de argumentos (IMPL-085): Zod ESTRITO → JSON Schema
// ---------------------------------------------------------------------------

/**
 * Converte o schema Zod em JSON Schema enxuto para o `tools/list` (que entra no
 * contexto do agente a cada turno). `overrides` corrige o que a conversão não
 * pode expressar sem quebrar clientes com subconjunto de OpenAPI (Gemini):
 * união de tipos vira o tipo único declarado (o runtime continua aceitando os
 * dois — ex.: `config` como objeto OU string JSON).
 */
function inputSchemaFrom(
  schema: z.ZodType,
  overrides: Record<string, Record<string, unknown>> = {},
): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete js.$schema;
  const props = js.properties as Record<string, unknown> | undefined;
  if (props) for (const [k, v] of Object.entries(overrides)) props[k] = v;
  return js;
}

/** Distância de edição simples (sugestão de campo parecido). */
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

/** Campo aceito mais parecido com o digitado (para a sugestão do erro). */
function sugestaoDeCampo(desconhecido: string, aceitos: string[]): string | undefined {
  let melhor: string | undefined;
  let melhorDist = Math.max(2, Math.floor(desconhecido.length / 3));
  for (const aceito of aceitos) {
    const d = editDistance(desconhecido.toLowerCase(), aceito.toLowerCase());
    if (d < melhorDist || (melhor === undefined && aceito.toLowerCase().startsWith(desconhecido.toLowerCase()))) {
      melhor = aceito;
      melhorDist = d;
    }
  }
  return melhor;
}

/**
 * Valida os argumentos contra o schema ESTRITO: campo desconhecido é rejeitado
 * com sugestão do mais parecido; os demais problemas saem em PT-BR citando o
 * campo (sem caminho absoluto, sem eco de valor). Devolve os dados validados.
 */
function validateToolArgs(schema: z.ZodType, args: Record<string, unknown>): Record<string, unknown> {
  const parsed = schema.safeParse(args);
  if (parsed.success) return parsed.data as Record<string, unknown>;
  const aceitos = Object.keys((schema as unknown as { def?: { shape?: Record<string, unknown> } }).def?.shape ?? {});
  const partes: string[] = [];
  for (const issue of parsed.error.issues.slice(0, 3)) {
    const caminho = issue.path.map(String).join('.') || '(raiz)';
    if (issue.code === 'unrecognized_keys') {
      for (const k of (issue as unknown as { keys: string[] }).keys) {
        const sugestao = sugestaoDeCampo(k, aceitos);
        partes.push(
          `campo desconhecido "${k}"` + (sugestao ? ` — quis dizer "${sugestao}"?` : '') +
            (aceitos.length ? `. Campos aceitos: ${aceitos.join(', ')}.` : ''),
        );
      }
      continue;
    }
    if (issue.code === 'invalid_type') {
      // Mensagem CUSTOM do schema (ex.: "idempotencyKey é obrigatória…") tem
      // prioridade sobre o texto genérico: era engolida aqui e o cliente via
      // "com tipo errado" para um campo que faltou por completo (IMPL-093).
      // O default do zod é sempre "Invalid input: …" (locale en) — fora disso,
      // a mensagem é do schema e vai para o erro.
      const custom = issue.message && !/^Invalid input:/i.test(issue.message) ? issue.message : undefined;
      partes.push(
        custom ??
          `campo "${caminho}" com tipo errado (esperado ${(issue as { expected?: string }).expected ?? 'outro'})`,
      );
      continue;
    }
    if (issue.code === 'invalid_union') {
      partes.push(`campo "${caminho}" não é um valor aceito (veja o inputSchema da tool)`);
      continue;
    }
    if (issue.code === 'invalid_value') {
      partes.push(`campo "${caminho}" fora do conjunto aceito (veja o inputSchema da tool)`);
      continue;
    }
    partes.push(`${caminho}: ${issue.message}`);
  }
  throw new Error(partes.join('; ') || 'Argumentos inválidos.');
}

const TOOLS: McpTool[] = [
  {
    name: 'list_models',
    annotations: {
      title: 'Listar modelos',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Lista modelos do OpenRouter com preço e, principalmente, quais níveis de raciocínio ' +
      '(think levels) cada um aceita. Use ANTES de escolher um modelo ou um nível de esforço.',
    argsSchema: LIST_MODELS_ARGS,
    inputSchema: inputSchemaFrom(LIST_MODELS_ARGS),
    outputSchema: MODELOS_OUTPUT,
    run: async (args, apiKey) => {
      const cat = await ensureCatalog(apiKey);
      const busca = str(args.search)?.toLowerCase();
      let rows = cat.models;
      if (busca) {
        rows = rows.filter(
          (m) => m.id.toLowerCase().includes(busca) || m.name.toLowerCase().includes(busca),
        );
      }
      // Teto do catálogo fatiado: sem ele, `limit: 100000` estouraria o teto de
      // tokens da resposta de qualquer cliente.
      const limite = Math.min(Math.max(Math.trunc(numOf(args.limit) ?? 20), 1), 200);
      return {
        count: rows.length,
        models: rows.slice(0, limite).map(toExportRow),
      };
    },
  },
  {
    name: 'estimate_cost',
    annotations: {
      title: 'Estimar custo',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Estima quanto uma configuração vai custar, SEM chamar nenhum modelo. ' +
      'Aceita arena-config@1 ou RunConfig. Rode isto antes de qualquer run cara.',
    argsSchema: ESTIMATE_COST_ARGS,
    inputSchema: inputSchemaFrom(ESTIMATE_COST_ARGS, { config: CONFIG_OBJECT_SCHEMA }),
    outputSchema: { type: 'object', additionalProperties: true },
    run: async (args, apiKey) => {
      const cfg = await toRunConfig(args.config);
      const cat = await ensureCatalog(apiKey);
      return estimateRunCost(estimateInputFromConfig(cfg), cat.models);
    },
  },
  {
    name: 'start_run',
    annotations: {
      title: 'Iniciar run',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Inicia uma run (compare/vary/training/agentes) em segundo plano e devolve o jobId na hora. ' +
      'Depois: run_status (poll ≥ 5 s) e cancel_run. idempotencyKey obrigatória: reuse-a nos retries ' +
      '(mesma chave = mesmo job, nunca uma 2ª run paga). arena-agent-config é EXECUTÁVEL e exige ' +
      'allowExecConfig: true no primeiro aceite (pin SHA-256; ver run_agent_benchmark).',
    argsSchema: START_RUN_ARGS,
    inputSchema: inputSchemaFrom(START_RUN_ARGS, { config: CONFIG_OBJECT_SCHEMA }),
    outputSchema: { type: 'object', additionalProperties: true },
    compact: true,
    run: async (args, apiKey, { jobs }) => {
      if (!isValidIdempotencyKey(args.idempotencyKey)) {
        throw new Error(
          'idempotencyKey é obrigatória (texto de 1 a 256 caracteres): gere uma (ex.: UUID) e REUSE-a ' +
            'nos retries deste mesmo pedido.',
        );
      }
      // IMPL-099: config de agente é EXECUTÁVEL — MESMO portão do `agents run`.
      const cru = rawConfigObject(args.config);
      if (cru && cru.format === ARENA_AGENT_CONFIG_FORMAT) {
        const recusa = await execConfigGateForTool('start_run', cru, args);
        if (recusa) return recusa;
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
    annotations: {
      title: 'Estado do job',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: 'Estado de um job (fila, progresso, gasto) e, no fim, o resumo. waitSeconds ≤ 25 espera o fim.',
    argsSchema: RUN_STATUS_ARGS,
    inputSchema: inputSchemaFrom(RUN_STATUS_ARGS),
    outputSchema: { type: 'object', additionalProperties: true },
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
    annotations: {
      title: 'Cancelar run',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Cancela um job: nenhuma chamada paga nova; o parcial fica gravado (get_result). ' +
      'Destrutiva de propósito: interrompe o trabalho em voo (o parcial é preservado).',
    argsSchema: CANCEL_RUN_ARGS,
    inputSchema: inputSchemaFrom(CANCEL_RUN_ARGS),
    outputSchema: { type: 'object', additionalProperties: true },
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
    annotations: {
      title: 'Rodar benchmark',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Benchmark (compare ou vary): espera até 25 s e devolve o resultado ou o jobId (siga com ' +
      'run_status). Prefira start_run. budgetUsd é OBRIGATÓRIO.',
    argsSchema: RUN_BENCHMARK_ARGS,
    inputSchema: inputSchemaFrom(RUN_BENCHMARK_ARGS, { config: CONFIG_OBJECT_SCHEMA }),
    outputSchema: { type: 'object', additionalProperties: true },
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
    annotations: {
      title: 'Treinar prompt',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Treina um system prompt (campeão, holdout, significância): espera até 25 s e devolve o ' +
      'resultado ou o jobId. Prefira start_run. budgetUsd é OBRIGATÓRIO.',
    argsSchema: TRAIN_PROMPT_ARGS,
    inputSchema: inputSchemaFrom(TRAIN_PROMPT_ARGS, { config: CONFIG_OBJECT_SCHEMA }),
    outputSchema: { type: 'object', additionalProperties: true },
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
    annotations: {
      title: 'Resultado de run',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Lê o resultado de uma run ou sessão pelo id. POR PADRÃO devolve um RESUMO (≤ 5 mil tokens) ' +
      'com paginação de etapas (cursor/limit); detail:"full" devolve o record inteiro (máx. 25 mil ' +
      'tokens — acima disso, resumo + referência ao arquivo em disco).',
    argsSchema: GET_RESULT_ARGS,
    inputSchema: inputSchemaFrom(GET_RESULT_ARGS),
    outputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['run', 'session'] },
        detail: { type: 'string', enum: ['summary', 'full'] },
        id: { type: 'string' },
        status: { type: 'string' },
      },
      additionalProperties: true,
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
      const paginacao = { cursor: str(args.cursor), limit: numOf(args.limit) };
      let rec: RunRecord | SessionRecord | null;
      let tipo: 'run' | 'session';
      if (kind === 'session') {
        rec = await loadSession(id);
        tipo = 'session';
        if (!rec) return { error: 'sessão não encontrada' };
      } else {
        const run = await loadRun(id);
        if (run) {
          rec = run;
          tipo = 'run';
        } else {
          rec = await loadSession(id);
          tipo = 'session';
          if (!rec) return { error: 'não encontrado' };
        }
      }
      if (args.detail === 'full') return recordOuResumo(tipo, rec, paginacao);
      return summarizeRecord(tipo, rec, paginacao);
    },
  },
  {
    name: 'run_agent_benchmark',
    annotations: {
      title: 'Benchmark de agentes',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Benchmark de AGENTES (arena-agent-config@1): espera até 25 s e devolve o resumo ou o jobId. ' +
      'Prefira start_run. config é um JSON string; budgetUsd é OBRIGATÓRIO. ⚠️ O config é EXECUTÁVEL ' +
      '(setup[]/verify[] rodam comandos): sem allowExecConfig: true + pin SHA-256 aprovado, NÃO executa.',
    argsSchema: RUN_AGENT_ARGS,
    inputSchema: inputSchemaFrom(RUN_AGENT_ARGS, { config: CONFIG_STRING_SCHEMA }),
    outputSchema: { type: 'object', additionalProperties: true },
    run: async (args, apiKey, ctx) => {
      // Validacao nunca derruba o servidor: erros viram {ok:false, error}.
      let cfg: RunConfig;
      try {
        cfg = parseAgentConfigRaw(args.config);
      } catch (err) {
        return { ok: false, error: publicErrorMessage(err) };
      }
      // IMPL-099: portão de config executável — MESMO portão do `agents run`.
      const cru = rawConfigObject(args.config);
      if (cru) {
        const recusa = await execConfigGateForTool('run_agent_benchmark', cru, args);
        if (recusa) return recusa;
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
    annotations: {
      title: 'Ler dossiê do agente',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Lê o dossiê (dossier.md) de uma execução de agente — o MESMO texto que o juiz viu. ' +
      'Diagnóstico: para entender por que um contestant perdeu uma etapa.',
    argsSchema: GET_DOSSIER_ARGS,
    inputSchema: inputSchemaFrom(GET_DOSSIER_ARGS),
    outputSchema: { type: 'object', additionalProperties: true },
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
    annotations: {
      title: 'Ler documentação',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Lê a documentação embarcada nesta versão do prompt-builder. ' +
      'Sem "topic", devolve a lista de tópicos. Comece por "quickstart".',
    argsSchema: READ_DOCS_ARGS,
    inputSchema: inputSchemaFrom(READ_DOCS_ARGS),
    // Sem outputSchema de propósito: a saída é índice (array) OU tópico (objeto)
    // — e o contrato do índice é ARRAY puro (security-baseline.test.ts).
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
  /** Espelho estruturado do JSON de texto (IMPL-086) — presente em tool com outputSchema. */
  structuredContent?: Record<string, unknown>;
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
    // IMPL-085: argumentos contra o schema ESTRITO — campo desconhecido é
    // rejeitado (com sugestão) em vez de engolido sem erro.
    const dados = tool.argsSchema ? validateToolArgs(tool.argsSchema, args) : args;
    const out = await tool.run(dados, key, ctx);
    if (isRawResult(out)) return out[RAW_RESULT] as unknown as CreateTaskResult;
    // IMPL-086: JSON COMPACTO (0 espaços após ':' e ',') em toda saída — a
    // indentação infla o contexto do agente sem dar nada (o texto é o que os
    // clientes injetam de forma confiável).
    const text = JSON.stringify(out);
    if (estimateTokens(text) > HARD_RESULT_TOKENS) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error:
                `resposta grande demais (~${estimateTokens(text)} tokens; teto ${HARD_RESULT_TOKENS}). ` +
                'Use paginação/verbosidade (ex.: get_result com cursor/limit) ou um filtro mais estreito.',
            }),
          },
        ],
        isError: true,
      };
    }
    // IMPL-086: structuredContent + o MESMO JSON espelhado em texto. O espelho
    // é obrigatório: é ele que os clientes sem structuredContent injetam.
    const estruturado =
      tool.outputSchema && out !== null && typeof out === 'object' && !Array.isArray(out)
        ? (out as Record<string, unknown>)
        : undefined;
    return {
      content: [{ type: 'text', text }],
      ...(estruturado ? { structuredContent: estruturado } : {}),
    };
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
          const pedido = requestedVersion(params);
          this.tasksNaSessao = declaresTasks(params.capabilities) || requestDeclaresTasks(params);
          const capabilities = this.tasksNaSessao
            ? { tools: {}, extensions: { [TASKS_EXTENSION]: {} } }
            : { tools: {} };
          if (pedido === undefined || VERSOES_ACEITAS.has(pedido)) {
            // Suportada (ou aceita pela regra legacy): ecoar é o correto nas duas eras.
            this.reply(req.id, {
              protocolVersion: pedido ?? LATEST_PROTOCOL_VERSION,
              // A extensão só é anunciada a quem a declarou: cliente legacy sem
              // ela não vê campo desconhecido em `capabilities`.
              capabilities,
              serverInfo: SERVER_INFO,
            });
            return;
          }
          // Versão NUNCA é ecoada sem checar (IMPL-084). Era moderna → -32022
          // (MUST da spec 2026-07-28) com os dois campos de data; era legacy →
          // regra antiga: responder com uma versão suportada (a mais recente
          // implementada) e NOMEAR as suportadas no diagnóstico.
          if (requestDeclaresModernEra(params)) {
            this.replyError(req.id, UNSUPPORTED_PROTOCOL_VERSION, 'UnsupportedProtocolVersion', {
              supported: [...SUPPORTED_PROTOCOL_VERSIONS],
              requested: pedido,
            });
            return;
          }
          this.reply(req.id, {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities,
            serverInfo: SERVER_INFO,
            supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
            _meta: {
              'io.modelcontextprotocol/negotiation': {
                requested: pedido,
                supported: [...SUPPORTED_PROTOCOL_VERSIONS],
              },
            },
          });
          return;
        }
        case 'server/discover':
          // MUST da era moderna (IMPL-084): sempre disponível, antes/depois de
          // qualquer initialize, listando as duas revisões implementadas.
          if (!isNotification) {
            this.reply(req.id, {
              resultType: 'complete',
              supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
              capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } },
              _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
            });
          }
          return;
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
                title: t.annotations?.title,
                description: t.description,
                inputSchema: t.inputSchema,
                // IMPL-085: as 4 dicas em toda tool declarada (sem elas a spec
                // trata tudo como escrita destrutiva de mundo aberto).
                ...(t.annotations
                  ? {
                      annotations: {
                        title: t.annotations.title,
                        readOnlyHint: t.annotations.readOnlyHint,
                        destructiveHint: t.annotations.destructiveHint,
                        idempotentHint: t.annotations.idempotentHint,
                        openWorldHint: t.annotations.openWorldHint,
                      },
                    }
                  : {}),
                ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
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
