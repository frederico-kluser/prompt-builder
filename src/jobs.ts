// Primitivas de JOBS do processo (cluster jobs — IMPL-025 R-13:REC-4, IMPL-026
// R-13:REC-3). A execução durável (disco, idempotency-key, cancel entre
// processos) mora em `jobManager.ts`; aqui só o que é puro.
//
// Um processo do prompt-builder (servidor MCP, start_run e o processo filho do
// `--detach` do CLI) roda NO MÁXIMO UMA run pesada por vez. Duas runs
// simultâneas disputariam o MESMO limitador global do gateway (um por
// processo) e o tempo — e portanto o gasto em voo — de cada uma ficaria
// imprevisível. As demais esperam numa fila FIFO cuja espera é CANCELÁVEL:
// quem desiste na fila não chega a gastar nada.
//
// Chamadas leves (ler resultado, docs, catálogo, estimativa) NÃO passam pela
// fila: elas precisam responder enquanto uma run de minutos está em andamento.
//
// Sem `node:*` aqui de propósito: o módulo é puro e pode ser reusado por
// qualquer ponto de entrada.

import { isControlSignal, RunCancelled } from './budget.js';

/**
 * Graça do encerramento (EOF do stdin, SIGTERM): tempo para as runs em voo
 * gravarem o parcial depois do abort. ~10 s é o que a pesquisa fixou (R-13:REC-4
 * — o cliente MCP manda SIGKILL pouco depois); o backoff máximo do gateway
 * (8 s + jitter) cabe dentro dela.
 */
export const SHUTDOWN_GRACE_MS = 10_000;

/**
 * O erro de cancelamento de um sinal abortado. Reaproveita o motivo quando ele
 * já é um sinal de controle (o MCP aborta com `RunCancelled`, e o fetch em voo
 * rejeita com o PRÓPRIO motivo) — assim o cancelamento atravessa os catch que
 * degradam (`isControlSignal`) em vez de virar "erro de competidor".
 */
export function cancellationOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (isControlSignal(reason)) return reason;
  return new RunCancelled(typeof reason === 'string' ? reason : undefined);
}

/** Lança o sinal de controle de cancelamento se `signal` já abortou. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationOf(signal);
}

export interface LaneSnapshot {
  /** Runs pesadas em execução (0 ou 1 com o padrão de 1 vaga). */
  active: number;
  /** Runs esperando a vez. */
  queued: number;
}

interface Waiter {
  grant: () => void;
}

/**
 * Fila de runs pesadas: `slots` execuções simultâneas (padrão 1), o resto em
 * FIFO. Abortar o sinal de quem está NA FILA tira o pedido da fila e rejeita
 * com `RunCancelled` sem nunca chamar `fn`; abortar quem já está rodando é
 * problema de `fn` (o sinal chega ao motor pelo próprio chamador).
 */
export class HeavyLane {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly slots = 1) {}

  snapshot(): LaneSnapshot {
    return { active: this.active, queued: this.queue.length };
  }

  /** Haveria espera se um pedido chegasse agora? */
  get busy(): boolean {
    return this.active >= this.slots;
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      // Abortado entre ganhar a vaga e começar: não começa.
      throwIfAborted(signal);
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(cancellationOf(signal));
    if (this.active < this.slots) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        reject(cancellationOf(signal!));
      };
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          this.active += 1;
          resolve();
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private release(): void {
    this.active -= 1;
    while (this.active < this.slots && this.queue.length > 0) this.queue.shift()!.grant();
  }
}

/** A fila do PROCESSO: 1 run pesada por vez (servidor MCP, jobs). */
export const processLane = new HeavyLane(1);

// ---------------------------------------------------------------------------
// Jobs explícitos (IMPL-026, R-13:REC-3 / DEC-3)
// ---------------------------------------------------------------------------
// Uma run de minutos NÃO cabe num `tools/call` bloqueante: o penhasco dos
// clientes é ~60 s (Codex `tool_timeout_sec`, cancel do Claude Desktop) e o
// retry que vem depois do timeout era uma SEGUNDA run inteira (gasto N×). O
// caminho universal é o job: start (devolve o id na hora) → status (poll) →
// cancel. As constantes abaixo são o contrato; a execução mora em
// `jobManager.ts` (Node).

/** Tipo de trabalho pesado que um job executa. */
export type JobKind = 'benchmark' | 'training' | 'agent';

/**
 * Estado de um job. `queued`/`working` não são terminais; `completed` (a
 * ferramenta devolveu — inclusive run parada por orçamento ou com status
 * 'error'), `failed` (a ferramenta LANÇOU, ou o processo dono morreu) e
 * `cancelled` são terminais.
 */
export type JobStatus = 'queued' | 'working' | 'completed' | 'failed' | 'cancelled';

const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(['completed', 'failed', 'cancelled']);

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

/**
 * Teto de uma chamada BLOQUEANTE. Regra do estado da arte (R-13 Q8): < 1 s
 * síncrono, 1–30 s com progresso, > 30 s = job. 25 s deixa folga para o
 * transporte antes dos 30 s — e bem longe do penhasco de 60 s dos clientes.
 * Nenhuma ferramenta segura um `tools/call` além disto.
 */
export const BLOCKING_TOOL_LIMIT_MS = 25_000;

/** Intervalo de polling sugerido (≥ 5 s: cada poll custa tokens do agente). */
export const JOB_POLL_INTERVAL_MS = 5_000;

/**
 * Prazo de EXECUÇÃO padrão de um job, contado da criação (o `ttlMs` da
 * extensão Tasks). Passado o prazo a run é CANCELADA e o parcial gravado: é o
 * plano B para cliente que some sem mandar `notifications/cancelled` (o Codex
 * não manda — openai/codex#26956). O orçamento continua sendo o teto de gasto.
 */
export const DEFAULT_JOB_TTL_MS = 2 * 60 * 60 * 1000;
export const MIN_JOB_TTL_MS = 60 * 1000;
export const MAX_JOB_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Retenção do registro de um job TERMINAL (e da ligação da idempotency-key
 * com ele). Depois disso a varredura apaga; a run/sessão em si fica.
 */
export const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

/** O dono de um job ativo regrava o batimento a cada tanto… */
export const JOB_HEARTBEAT_MS = 5_000;
/** …e sem batimento há este tempo (em outro host) o job é dado como órfão. */
export const JOB_ORPHAN_AFTER_MS = 60_000;

/**
 * Período da vigia do dono (pedido de cancelamento vindo de OUTRO processo,
 * prazo esgotado, batimento). 500 ms mantém o "0 chamada paga nova em < 2 s".
 */
export const JOB_WATCH_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// Execução longa no CLI (IMPL-030, R-12:REC-5 / DEC-4)
// ---------------------------------------------------------------------------
// Foreground de 20–40 min não é confiável: os agentes cortam o shell em
// ~2–10 min. O CLI oferece `--detach` (processo filho destacado, NDJSON em
// arquivo) + `runs status/wait/cancel`, e todo processo que grava uma run
// 'running' deixa um arquivo de DONO (PID/host/início) ao lado dela — é o que
// permite a qualquer comando reconhecer a run órfã (processo morto por
// SIGKILL) e marcá-la 'aborted' na hora.

/** O dono de uma run/sessão regrava o batimento do arquivo de dono a cada tanto… */
export const OWNER_HEARTBEAT_MS = 15_000;
/** …e, em OUTRO host (data dir compartilhado), sem batimento há isto = morto. */
export const OWNER_STALE_AFTER_MS = JOB_ORPHAN_AFTER_MS;
/**
 * Record 'running' SEM arquivo de dono (gravado por uma versão antiga, ou a
 * escrita do dono falhou): só vira órfão se o arquivo não muda há isto. No
 * boot do servidor o limiar é 0 (comportamento histórico: tudo o que ficou
 * 'running' de um processo anterior é órfão).
 */
export const LOCKLESS_ORPHAN_AFTER_MS = 10 * 60 * 1000;

/** `runs wait` sem `--timeout`: 600 s (o teto do shell do Claude Code é 10 min). */
export const RUNS_WAIT_DEFAULT_TIMEOUT_S = 600;
/** `runs cancel` espera a confirmação (record terminal + processo encerrado) por até isto. */
export const RUNS_CANCEL_DEFAULT_TIMEOUT_S = 15;
/**
 * Durante o `runs wait`, uma linha de narração (stderr) a cada tanto: o Gemini
 * CLI cancela o comando por INATIVIDADE de saída (5 min); a linha zera o timer.
 */
export const WAIT_NARRATION_MS = 30_000;
/** O pai do `--detach` espera o filho anunciar a run (ou recusar) por até isto. */
export const DETACH_HANDSHAKE_MS = 30_000;
/**
 * Prazo de execução de um job destacado do CLI: o teto do gerente (24 h). O
 * orçamento é o teto de gasto; o prazo só evita um processo esquecido para
 * sempre.
 */
export const DETACHED_JOB_TTL_MS = MAX_JOB_TTL_MS;

/** Idempotency-key aceita: texto não vazio, até 256 caracteres. */
export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && key.trim().length > 0 && key.length <= 256;
}

/** Prazo pedido (segundos) → ms dentro de [MIN, MAX]; ausente → padrão. */
export function clampJobTtlMs(ttlSeconds: unknown): number {
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds)) return DEFAULT_JOB_TTL_MS;
  return Math.min(MAX_JOB_TTL_MS, Math.max(MIN_JOB_TTL_MS, Math.round(ttlSeconds * 1000)));
}

/** Espera pedida (segundos) → ms dentro de [0, BLOCKING_TOOL_LIMIT_MS]. */
export function clampWaitMs(waitSeconds: unknown, fallbackMs = 0): number {
  const ms =
    typeof waitSeconds === 'number' && Number.isFinite(waitSeconds) ? Math.round(waitSeconds * 1000) : fallbackMs;
  return Math.min(BLOCKING_TOOL_LIMIT_MS, Math.max(0, ms));
}

/**
 * JSON CANÔNICO (chaves ordenadas em todo nível, `undefined` omitido): a
 * impressão digital de um pedido não pode depender da ordem das chaves que o
 * agente mandou. Base da checagem "mesma idempotency-key, pedido diferente".
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/**
 * Espera `promises` assentarem por no máximo `ms`. `true` = todas assentaram
 * dentro do prazo; `false` = a graça esgotou com alguma ainda pendente. O
 * timer é limpo assim que tudo assenta — não segura o processo depois disso
 * (e NÃO é `unref`: durante a graça ele é justamente o que mantém a espera).
 */
export function settleWithin(promises: Iterable<Promise<unknown>>, ms: number): Promise<boolean> {
  const todas = Promise.allSettled([...promises]).then(() => true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
  });
  return Promise.race([todas, prazo]).finally(() => clearTimeout(timer));
}
