// Web Locks FALSO, escrito à mão (IMPL-023). Não é arquivo de teste (sem
// `.test.`): é um helper para simular VÁRIAS ABAS da mesma origem.
//
// Por que não o `navigator.locks` do Node 24: ele é por THREAD (medido: um lock
// segurado num Worker não aparece no principal, e terminar o Worker não muda
// nada para o principal) — não dá para simular duas abas nem a morte de uma.
// Aqui um BROKER faz o papel do navegador (o gerenciador de locks da origem) e
// cada aba é um CONTEXTO dele. Modela só a semântica que o motor usa, fiel à
// spec (W3C Web Locks):
//  • modo exclusivo; o lock é concedido e o callback roda numa tarefa depois;
//  • o lock fica segurado até a promise do callback assentar;
//  • `ifAvailable`: concede só se ninguém segura e a fila está vazia — senão o
//    callback recebe `null` (não enfileira);
//  • sem `ifAvailable` o pedido espera na fila (FIFO); `signal` abortado tira-o
//    da fila e rejeita com AbortError;
//  • `destroy()` do contexto = aba fechada/recarregada/travada: o NAVEGADOR
//    solta todo lock que ela segurava e descarta os pedidos dela na fila.
//  • NÃO há relógio: congelar a aba (não rodar nada por minutos) não muda nada.

import type { LockLike, LockManagerLike, LockRequestOptions } from '../web/src/engine/runLocks.js';

type Callback = (lock: LockLike | null) => unknown;

interface Pending {
  ctx: FakeLockContext;
  name: string;
  cb: Callback;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  cleanup?: () => void;
}

interface Held {
  ctx: FakeLockContext;
  token: object;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The request was aborted.', 'AbortError');
}

export class FakeLockBroker {
  private readonly held = new Map<string, Held>();
  private readonly queues = new Map<string, Pending[]>();
  /** Concessões por nome — conta "quantas vezes alguém virou dono". */
  readonly grants: { ctx: string; name: string }[] = [];

  context(label: string): FakeLockContext {
    return new FakeLockContext(this, label);
  }

  /** Rótulo do contexto que segura `name` agora (undefined = livre). */
  holder(name: string): string | undefined {
    return this.held.get(name)?.ctx.label;
  }

  queued(name: string): number {
    return this.queues.get(name)?.length ?? 0;
  }

  request(ctx: FakeLockContext, name: string, opts: LockRequestOptions, cb: Callback): Promise<unknown> {
    if (ctx.destroyed) return Promise.reject(new DOMException('contexto destruído', 'InvalidStateError'));
    if ((opts.mode ?? 'exclusive') !== 'exclusive') {
      return Promise.reject(new Error('fakeWebLocks: só o modo exclusive é modelado'));
    }
    if (opts.signal?.aborted) return Promise.reject(abortError(opts.signal));
    return new Promise((resolve, reject) => {
      const p: Pending = { ctx, name, cb, resolve, reject };
      const grantable = !this.held.has(name) && this.queued(name) === 0;
      if (grantable) {
        this.grant(p);
        return;
      }
      if (opts.ifAvailable) {
        setTimeout(() => {
          Promise.resolve()
            .then(() => cb(null))
            .then(resolve, reject);
        }, 0);
        return;
      }
      const q = this.queues.get(name) ?? [];
      q.push(p);
      this.queues.set(name, q);
      const signal = opts.signal;
      if (signal) {
        const onAbort = (): void => {
          const fila = this.queues.get(name);
          const i = fila?.indexOf(p) ?? -1;
          if (fila && i >= 0) {
            fila.splice(i, 1);
            if (!fila.length) this.queues.delete(name);
            reject(abortError(signal));
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        p.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
    });
  }

  private grant(p: Pending): void {
    const token = {};
    this.held.set(p.name, { ctx: p.ctx, token });
    this.grants.push({ ctx: p.ctx.label, name: p.name });
    p.cleanup?.();
    setTimeout(() => {
      Promise.resolve()
        .then(() => p.cb({ name: p.name, mode: 'exclusive' }))
        .then(
          (v) => {
            this.release(p.name, token);
            if (!p.ctx.destroyed) p.resolve(v);
          },
          (e) => {
            this.release(p.name, token);
            if (!p.ctx.destroyed) p.reject(e);
          },
        );
    }, 0);
  }

  private release(name: string, token: object): void {
    const h = this.held.get(name);
    if (!h || h.token !== token) return; // já solto (contexto destruído antes)
    this.held.delete(name);
    this.grantNext(name);
  }

  private grantNext(name: string): void {
    if (this.held.has(name)) return;
    const q = this.queues.get(name);
    const next = q?.shift();
    if (q && !q.length) this.queues.delete(name);
    if (next) this.grant(next);
  }

  /** A aba morreu: solta o que ela segurava e descarta os pedidos dela na fila. */
  destroy(ctx: FakeLockContext): void {
    if (ctx.destroyed) return;
    ctx.destroyed = true;
    const nomes = new Set<string>();
    for (const [name, q] of this.queues) {
      const resto = q.filter((p) => p.ctx !== ctx);
      if (resto.length !== q.length) nomes.add(name);
      if (resto.length) this.queues.set(name, resto);
      else this.queues.delete(name);
    }
    for (const [name, h] of [...this.held]) {
      if (h.ctx === ctx) {
        this.held.delete(name);
        nomes.add(name);
      }
    }
    for (const name of nomes) this.grantNext(name);
  }
}

/** Uma "aba": o `navigator.locks` dela. */
export class FakeLockContext implements LockManagerLike {
  destroyed = false;

  constructor(
    private readonly broker: FakeLockBroker,
    readonly label: string,
  ) {}

  request<T>(
    name: string,
    options: LockRequestOptions,
    callback: (lock: LockLike | null) => Promise<T> | T,
  ): Promise<T> {
    return this.broker.request(this, name, options, callback as Callback) as Promise<T>;
  }

  /** Fecha/recarrega/trava a aba. */
  destroy(): void {
    this.broker.destroy(this);
  }
}
