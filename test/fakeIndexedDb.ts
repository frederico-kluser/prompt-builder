// IndexedDB FALSO, escrito à mão (IMPL-022). O repo não usa fake-indexeddb
// (node_modules é compartilhado entre worktrees; nada de dependência nova) e o
// vitest roda em Node, sem IndexedDB. Não é arquivo de teste (sem `.test.`):
// é um helper para qualquer teste da camada web/src/idb.ts.
//
// Modela SÓ a semântica que a camada usa, fiel à spec:
//  • transação = unidade atômica: as escritas vão para uma cópia de trabalho e
//    só entram nos dados confirmados no commit — erro de requisição não
//    prevenido ou abort => NADA do lote fica (rollback);
//  • erro de requisição dispara `request.onerror` e borbulha para
//    `tx.onerror` (event.target = requisição) antes do `tx.onabort`;
//  • QuotaExceededError no COMMIT (como o Chromium faz ao passar da cota);
//  • `put` clona na hora (structuredClone): valor não clonável lança
//    DataCloneError SÍNCRONO;
//  • transações executam na ordem de criação (tarefas separadas);
//  • `durability` pedida fica no log de cada transação.

type Handler = ((ev: FakeEvent) => void) | null;

interface FakeEvent {
  type: string;
  target: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
}

function evento(type: string, target: unknown): FakeEvent {
  return {
    type,
    target,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

const tarefa = (fn: () => void): void => {
  setTimeout(fn, 0);
};

export interface FakeTxLog {
  stores: string[];
  mode: 'readonly' | 'readwrite';
  durability?: string;
  ops: { store: string; kind: 'put' | 'delete'; id: string }[];
  outcome?: 'complete' | 'abort';
  error?: string;
}

class FakeRequest {
  result: unknown = undefined;
  error: DOMException | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  readyState: 'pending' | 'done' = 'pending';
}

type PendingOp =
  | { req: FakeRequest; store: string; kind: 'put'; id: string; value: unknown }
  | { req: FakeRequest; store: string; kind: 'delete'; id: string }
  | { req: FakeRequest; store: string; kind: 'get'; id: string }
  | { req: FakeRequest; store: string; kind: 'getAll' };

class FakeObjectStore {
  constructor(
    private readonly tx: FakeTransaction,
    private readonly name: string,
  ) {}

  private push(op: Omit<PendingOp, 'req'>): FakeRequest {
    this.tx.assertActive();
    const req = new FakeRequest();
    this.tx.pending.push({ ...op, req } as PendingOp);
    return req;
  }

  put(value: { id?: unknown }): FakeRequest {
    this.tx.assertActive();
    if (this.tx.mode !== 'readwrite') throw new DOMException('readonly', 'ReadOnlyError');
    // Clona NA HORA, como o navegador: mutação posterior não vaza e valor não
    // clonável lança DataCloneError síncrono.
    const clone = structuredClone(value) as { id?: unknown };
    if (typeof clone?.id !== 'string') throw new DOMException('keyPath id ausente', 'DataError');
    this.tx.log.ops.push({ store: this.name, kind: 'put', id: clone.id });
    return this.push({ store: this.name, kind: 'put', id: clone.id, value: clone });
  }

  delete(id: string): FakeRequest {
    this.tx.log.ops.push({ store: this.name, kind: 'delete', id });
    return this.push({ store: this.name, kind: 'delete', id });
  }

  get(id: string): FakeRequest {
    return this.push({ store: this.name, kind: 'get', id });
  }

  getAll(): FakeRequest {
    return this.push({ store: this.name, kind: 'getAll' });
  }
}

class FakeTransaction {
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  error: DOMException | null = null;
  readonly pending: PendingOp[] = [];
  readonly log: FakeTxLog;
  private finished = false;
  private abortedExplicitly = false;

  constructor(
    private readonly idb: FakeIdb,
    readonly storeNames: string[],
    readonly mode: 'readonly' | 'readwrite',
    durability: string | undefined,
  ) {
    this.log = { stores: [...storeNames], mode, durability, ops: [] };
    idb.transactions.push(this.log);
    tarefa(() => this.run());
  }

  assertActive(): void {
    if (this.finished || this.abortedExplicitly) {
      throw new DOMException('transação inativa', 'TransactionInactiveError');
    }
  }

  objectStore(name: string): FakeObjectStore {
    if (!this.storeNames.includes(name)) throw new DOMException(name, 'NotFoundError');
    return new FakeObjectStore(this, name);
  }

  abort(): void {
    if (this.finished) throw new DOMException('já terminou', 'InvalidStateError');
    this.abortedExplicitly = true;
  }

  private fail(err: DOMException | null): void {
    this.finished = true;
    this.error = err;
    this.log.outcome = 'abort';
    this.log.error = err?.name ?? 'AbortError';
    this.onabort?.(evento('abort', this));
  }

  private run(): void {
    if (this.abortedExplicitly) return this.fail(null);
    // Cópia de trabalho das stores do escopo: só vira dado confirmado no commit.
    const work = new Map<string, Map<string, unknown>>();
    for (const s of this.storeNames) work.set(s, new Map(this.idb.data.get(s)));
    for (const op of this.pending) {
      const injected = op.kind === 'put' || op.kind === 'delete' ? this.idb.takePutFailure(op.store) : undefined;
      if (injected) {
        op.req.readyState = 'done';
        op.req.error = new DOMException(`falha injetada em ${op.store}`, injected);
        const ev = evento('error', op.req);
        op.req.onerror?.(ev);
        this.onerror?.(ev); // borbulha até a transação
        if (!ev.defaultPrevented) return this.fail(op.req.error);
        continue;
      }
      const store = work.get(op.store)!;
      if (op.kind === 'put') {
        store.set(op.id, op.value);
        op.req.result = op.id;
      } else if (op.kind === 'delete') {
        store.delete(op.id);
      } else if (op.kind === 'get') {
        op.req.result = structuredClone(store.get(op.id));
      } else {
        op.req.result = [...store.values()].map((v) => structuredClone(v));
      }
      op.req.readyState = 'done';
      op.req.onsuccess?.(evento('success', op.req));
    }
    if (this.mode === 'readwrite') {
      const commitErr = this.idb.takeCommitFailure();
      if (commitErr) return this.fail(new DOMException('falha injetada no commit', commitErr));
      // Cota: mede o banco inteiro COMO FICARIA com este commit.
      const depois = new Map(this.idb.data);
      for (const [s, m] of work) depois.set(s, m);
      if (FakeIdb.sizeOf(depois) > this.idb.quotaBytes) {
        return this.fail(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
      }
      for (const [s, m] of work) this.idb.data.set(s, m);
    }
    this.finished = true;
    this.log.outcome = 'complete';
    this.oncomplete?.(evento('complete', this));
  }
}

class FakeDatabase {
  onversionchange: Handler = null;
  onclose: Handler = null;
  closed = false;
  readonly objectStoreNames = {
    contains: (name: string): boolean => this.idb.data.has(name),
  };

  constructor(private readonly idb: FakeIdb) {}

  createObjectStore(name: string): void {
    if (!this.idb.data.has(name)) this.idb.data.set(name, new Map());
  }

  transaction(
    names: string | string[],
    mode: 'readonly' | 'readwrite' = 'readonly',
    options?: { durability?: string },
  ): FakeTransaction {
    if (this.closed) throw new DOMException('conexão fechada', 'InvalidStateError');
    const list = Array.isArray(names) ? names : [names];
    for (const n of list) if (!this.idb.data.has(n)) throw new DOMException(n, 'NotFoundError');
    return new FakeTransaction(this.idb, list, mode, options?.durability);
  }

  close(): void {
    this.closed = true;
  }
}

class FakeOpenRequest extends FakeRequest {
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

export class FakeIdb {
  /** Dados CONFIRMADOS: store -> id -> valor. */
  readonly data = new Map<string, Map<string, unknown>>();
  readonly transactions: FakeTxLog[] = [];
  /** Cota em bytes (JSON do banco inteiro). Infinity = sem limite. */
  quotaBytes = Number.POSITIVE_INFINITY;
  /** Nome do DOMException ao abrir (ex.: 'InvalidStateError' do modo privado). */
  openFailure: string | undefined;
  opens = 0;
  private version = 0;
  private readonly connections: FakeDatabase[] = [];
  private putFailures: { store: string; name: string; times: number }[] = [];
  private commitFailures: string[] = [];

  /** A próxima put/delete em `store` falha na requisição (erro borbulha e aborta). */
  failNextPut(store: string, name = 'ConstraintError', times = 1): void {
    this.putFailures.push({ store, name, times });
  }

  /** Os próximos `times` commits abortam com `name`. */
  failNextCommit(name = 'QuotaExceededError', times = 1): void {
    for (let i = 0; i < times; i++) this.commitFailures.push(name);
  }

  takePutFailure(store: string): string | undefined {
    const f = this.putFailures.find((x) => x.store === store && x.times > 0);
    if (!f) return undefined;
    f.times -= 1;
    return f.name;
  }

  takeCommitFailure(): string | undefined {
    return this.commitFailures.shift();
  }

  /** Despejo (Safari/pressão de espaço): apaga tudo e o navegador fecha as conexões. */
  evict(): void {
    for (const s of this.data.values()) s.clear();
    for (const db of this.connections) {
      if (db.closed) continue;
      db.closed = true;
      db.onclose?.(evento('close', db));
    }
  }

  get(store: string, id: string): unknown {
    return this.data.get(store)?.get(id);
  }

  static sizeOf(data: Map<string, Map<string, unknown>>): number {
    let n = 0;
    for (const m of data.values()) for (const v of m.values()) n += JSON.stringify(v)?.length ?? 0;
    return n;
  }

  usedBytes(): number {
    return FakeIdb.sizeOf(this.data);
  }

  /** A fábrica para `setIdbFactory`. */
  readonly factory = {
    open: (_name: string, version?: number): FakeOpenRequest => {
      this.opens += 1;
      const req = new FakeOpenRequest();
      tarefa(() => {
        if (this.openFailure) {
          req.error = new DOMException('falha ao abrir', this.openFailure);
          req.onerror?.(evento('error', req));
          return;
        }
        const db = new FakeDatabase(this);
        this.connections.push(db);
        req.result = db;
        if ((version ?? 1) > this.version) {
          this.version = version ?? 1;
          req.onupgradeneeded?.(evento('upgradeneeded', req));
        }
        req.readyState = 'done';
        req.onsuccess?.(evento('success', req));
      });
      return req;
    },
  } as unknown as IDBFactory;
}
