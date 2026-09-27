// Primitivas de JOBS do processo (cluster jobs — IMPL-025, R-13:REC-4).
//
// Um processo do prompt-builder (hoje o servidor MCP; depois start_run e o
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
