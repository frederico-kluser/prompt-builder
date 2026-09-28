// Exclusão entre abas por Web Locks (IMPL-023, R-10:REC-1 / DEC-2). Só na SPA:
// no Node a run vive no processo e a órfã é detectada no boot do servidor.
//
// Cada run/sessão em execução segura um lock EXCLUSIVO com o nome do seu id
// enquanto roda. O idiom é o da promise pendente: o callback do
// `navigator.locks.request` fica parado num `await` que só a própria run
// resolve ao terminar — e, se a aba fecha, recarrega ou trava de vez, o
// NAVEGADOR solta o lock junto com o contexto. Por isso:
//  • Web Locks é a FONTE DE VERDADE de "ainda roda?"; o IndexedDB é cache.
//    Record 'running' cujo lock está livre = ninguém o executa = órfã.
//  • Aba congelada/em segundo plano MANTÉM o lock (o contexto está vivo): zero
//    falso positivo. Um heartbeat por timestamp marcaria como morta toda aba
//    congelada, com o SO suspenso ou com o relógio ajustado — nunca é o
//    detector aqui.
//  • `ifAvailable` separa "há dono" (null) de "sou o dono" sem esperar.
//  • bfcache (medido no Chrome 153 via CDP): aba que SEGURA o lock e navega
//    para outra página é despejada do bfcache quando outra aba pede o lock
//    (motivo `WebLocksContention`) — o lock solta e a órfã aparece. Já um
//    pedido PENDENTE levado para o bfcache prenderia o lock numa página
//    congelada: por isso `whenLockReleased` sai da fila no `pagehide`.
//
// Feature detection: sem `navigator.locks` (navegador antigo, contexto não
// seguro, iframe sandbox) o módulo degrada — a run executa sem exclusão e NADA
// é marcado como órfão automaticamente (não dá para saber); a UI oferece a
// marcação manual.
//
// O LockManager é INJETÁVEL (`setLockManager`) para testar sem navegador: o
// vitest roda em Node e cada "aba" do teste é um contexto de um broker falso.

export type LockMode = 'exclusive' | 'shared';

export interface LockLike {
  readonly name: string;
  readonly mode: LockMode;
}

export interface LockRequestOptions {
  mode?: LockMode;
  ifAvailable?: boolean;
  signal?: AbortSignal;
}

/** O subconjunto do `LockManager` (Web Locks) que o motor usa. */
export interface LockManagerLike {
  request<T>(
    name: string,
    options: LockRequestOptions,
    callback: (lock: LockLike | null) => Promise<T> | T,
  ): Promise<T>;
}

export type LockSubject = 'run' | 'session';

/** undefined = autodetecta `navigator.locks`; null = simula navegador sem Web Locks. */
let managerOverride: LockManagerLike | null | undefined;

/** Troca o LockManager (testes). `undefined` volta à detecção automática. */
export function setLockManager(manager: LockManagerLike | null | undefined): void {
  managerOverride = manager;
}

/** O LockManager desta aba, ou null quando o navegador não tem Web Locks. */
export function getLockManager(): LockManagerLike | null {
  if (managerOverride !== undefined) return managerOverride;
  // Feature detection: `navigator.locks` só existe em contexto seguro (https,
  // localhost) e em navegadores com Web Locks (baseline desde mar/2022).
  if (typeof navigator === 'undefined') return null;
  const locks = navigator.locks as unknown as Partial<LockManagerLike> | undefined;
  return locks && typeof locks.request === 'function' ? (locks as LockManagerLike) : null;
}

/** true = há Web Locks: exclusão entre abas e detecção de órfãs automáticas. */
export function locksSupported(): boolean {
  return getLockManager() !== null;
}

/** Nome do lock. Prefixo próprio: a origem pode ter outros usuários de Web Locks. */
export function lockName(subject: LockSubject, id: string): string {
  return `prompt-builder:${subject}:${id}`;
}

/** Locks que ESTA aba segura (para "sou o dono?" sem ir ao navegador). */
const heldHere = new Set<string>();

/** true = esta aba executa a run/sessão (segura o lock dela, ou o handle degradado). */
export function isHeldHere(subject: LockSubject, id: string): boolean {
  return heldHere.has(lockName(subject, id));
}

export interface HeldLock {
  readonly name: string;
  /** false = navegador sem Web Locks: handle degradado, sem exclusão real. */
  readonly supported: boolean;
  /** Solta o lock (idempotente). Chame DEPOIS da última gravação da run. */
  release(): void;
}

function degradedHandle(name: string): HeldLock {
  heldHere.add(name);
  let solto = false;
  return {
    name,
    supported: false,
    release() {
      if (solto) return;
      solto = true;
      heldHere.delete(name);
    },
  };
}

function warnUnsupported(name: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[locks] Web Locks indisponível para ${name} (${msg}) — seguindo sem exclusão entre abas.`);
}

/**
 * Tenta tomar o lock EXCLUSIVO sem esperar. Devolve:
 *  • o handle (esta aba agora é a dona — segure até a última gravação);
 *  • `null` = OUTRA aba/contexto já é dono: NÃO execute (seria execução dupla,
 *    somando gasto na mesma key sem ninguém perceber).
 * Sem Web Locks devolve um handle degradado (`supported: false`).
 *
 * `manager` é lido na hora da chamada (antes de qualquer await).
 */
export function acquireLock(
  subject: LockSubject,
  id: string,
  manager: LockManagerLike | null = getLockManager(),
): Promise<HeldLock | null> {
  const name = lockName(subject, id);
  if (!manager) return Promise.resolve(degradedHandle(name));
  return new Promise<HeldLock | null>((resolve) => {
    let concedido = false;
    manager
      .request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        concedido = true;
        heldHere.add(name);
        // A promise pendente: só `release()` a resolve. Fecho/reload/crash da
        // aba destroem o contexto e o navegador solta o lock sozinho.
        await new Promise<void>((soltar) => {
          let solto = false;
          resolve({
            name,
            supported: true,
            release() {
              if (solto) return;
              solto = true;
              heldHere.delete(name);
              soltar();
            },
          });
        });
      })
      .catch((err: unknown) => {
        // Rejeição ANTES da concessão = a API existe mas recusa este contexto
        // (SecurityError em origem opaca, por exemplo): degrada como sem API.
        if (!concedido) {
          warnUnsupported(name, err);
          resolve(degradedHandle(name));
        }
      });
  });
}

export type ProbeResult<T> =
  | { state: 'free'; value: T }
  | { state: 'held' }
  | { state: 'unsupported' };

/**
 * Se o lock está LIVRE, segura-o enquanto `fn` roda (ninguém começa a executar
 * no meio) e solta no fim. 'held' = há dono vivo. 'unsupported' = sem Web Locks.
 */
export async function withLockIfFree<T>(
  subject: LockSubject,
  id: string,
  fn: () => Promise<T>,
  manager: LockManagerLike | null = getLockManager(),
): Promise<ProbeResult<T>> {
  if (!manager) return { state: 'unsupported' };
  const name = lockName(subject, id);
  let erroDoFn: { err: unknown } | undefined;
  try {
    return await manager.request<ProbeResult<T>>(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) return { state: 'held' };
      try {
        return { state: 'free', value: await fn() };
      } catch (err) {
        erroDoFn = { err };
        throw err;
      }
    });
  } catch (err) {
    // Erro do próprio `fn` sobe; recusa do navegador (SecurityError…) degrada.
    if (erroDoFn) throw erroDoFn.err;
    warnUnsupported(name, err);
    return { state: 'unsupported' };
  }
}

export type WaitResult<T> = { state: 'released'; value: T } | { state: 'aborted' } | { state: 'unsupported' };

/** O `window` da aba, se houver (bfcache: `pagehide`/`pageshow`). */
function pageTarget(): EventTarget | null {
  const w = (globalThis as { window?: EventTarget }).window;
  return w && typeof w.addEventListener === 'function' ? w : null;
}

/** Resolve no próximo `pageshow` (volta do bfcache) ou quando `signal` aborta. */
function nextPageShow(page: EventTarget, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const fim = (): void => {
      page.removeEventListener('pageshow', fim);
      signal?.removeEventListener('abort', fim);
      resolve();
    };
    page.addEventListener('pageshow', fim);
    signal?.addEventListener('abort', fim, { once: true });
  });
}

/**
 * ESPERA o dono atual soltar o lock — a run terminou OU a aba dela morreu — e
 * então roda `fn` segurando-o (para reler o record sem corrida). Não consome
 * CPU nem timer: é a fila do próprio navegador. `signal` desiste da espera.
 *
 * bfcache: a espera sai da fila no `pagehide` e volta no `pageshow`. Medido no
 * Chrome 153: uma página que foi para o bfcache com pedido PENDENTE recebe o
 * lock quando o dono solta — congelada, não roda o callback nem o devolve, e as
 * outras abas passam a ver a run como "viva" para sempre (não houve despejo por
 * contenção, ao contrário de quem já SEGURAVA o lock ao sair).
 */
export async function whenLockReleased<T>(
  subject: LockSubject,
  id: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
  manager: LockManagerLike | null = getLockManager(),
): Promise<WaitResult<T>> {
  if (!manager) return { state: 'unsupported' };
  const name = lockName(subject, id);
  const page = pageTarget();
  for (;;) {
    if (signal?.aborted) return { state: 'aborted' };
    const ctrl = new AbortController();
    let saiuDaPagina = false;
    const onPageHide = (): void => {
      saiuDaPagina = true;
      ctrl.abort(new DOMException('pagehide', 'AbortError'));
    };
    const onAbort = (): void => ctrl.abort(signal?.reason);
    page?.addEventListener('pagehide', onPageHide);
    signal?.addEventListener('abort', onAbort, { once: true });
    let erroDoFn: { err: unknown } | undefined;
    try {
      const value = await manager.request<T>(name, { mode: 'exclusive', signal: ctrl.signal }, async () => {
        try {
          return await fn();
        } catch (err) {
          erroDoFn = { err };
          throw err;
        }
      });
      return { state: 'released', value };
    } catch (err) {
      if (erroDoFn) throw erroDoFn.err;
      if (signal?.aborted) return { state: 'aborted' };
      if (saiuDaPagina && page) {
        await nextPageShow(page, signal);
        continue; // voltou do bfcache: entra de novo na fila
      }
      if (isAbortError(err)) return { state: 'aborted' };
      warnUnsupported(name, err);
      return { state: 'unsupported' };
    } finally {
      page?.removeEventListener('pagehide', onPageHide);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}
