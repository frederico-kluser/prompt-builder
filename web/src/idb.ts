// Cache local (IndexedDB) das runs e sessões do usuário, para o histórico voltar
// ao fechar/reabrir o navegador — e para visualizar runs/sessões mesmo se o
// servidor não as tiver mais.
//
// IMPL-022 (R-09:REC-6): GRAVAÇÃO NUNCA FALHA EM SILÊNCIO. Antes, idbPut/
// idbPutMany terminavam em `catch {}` — QuotaExceededError, despejo do Safari ou
// IndexedDB indisponível viravam perda silenciosa de runs. Agora toda escrita
// REJEITA com `IdbWriteError` (tipo classificado: quota | unavailable | failed)
// e quem chama decide o que avisar (engine/storage.ts transforma em evento +
// aviso na UI; a biblioteca de prompts mostra toast). Leituras continuam
// degradando para vazio: ler não perde dado.
//
// Escrita = UMA transação por lote (`idbWrite`), mesmo cobrindo várias stores:
// o IndexedDB confirma tudo ou nada (record + resumo não divergem mais).

const DB_NAME = 'prompt-builder';
// v2: adiciona a store 'prompts' (biblioteca de prompts salvos/evoluídos).
// O upgrade de clientes existentes já está coberto: o onupgradeneeded itera
// STORES e cria apenas as stores que faltam, então quem vem da v1 ganha a
// store nova sem perder os dados das demais.
const DB_VERSION = 2;
export const STORES = ['runs', 'sessions', 'runSummaries', 'sessionSummaries', 'prompts'] as const;
export type Store = (typeof STORES)[number];

/** quota = sem espaço · unavailable = não abriu (bloqueado/privado/ausente) · failed = o resto. */
export type IdbFailureKind = 'quota' | 'unavailable' | 'failed';

/**
 * 'strict' = o navegador só confirma depois de o dado ir para o disco (flush).
 * O Chromium passou a usar 'relaxed' por default — por isso checkpoint pede
 * 'strict' EXPLICITAMENTE (R-10:DEC-2); batidas periódicas podem ser 'relaxed'.
 */
export type IdbDurability = 'strict' | 'relaxed';

/** Falha de escrita classificada. Reconheça por `isIdbWriteError`, nunca `instanceof`. */
export class IdbWriteError extends Error {
  readonly code = 'idb-write-failed' as const;
  constructor(
    readonly kind: IdbFailureKind,
    readonly stores: readonly Store[],
    readonly cause: unknown,
  ) {
    super(describeFailure(kind, cause));
    this.name = 'IdbWriteError';
  }
}

/**
 * Reconhece por PROPRIEDADE (mesma regra de `isControlSignal`): com instância
 * dupla do módulo (HMR do Vite, ESM duplicado) `instanceof` daria false.
 */
export function isIdbWriteError(err: unknown): err is IdbWriteError {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'idb-write-failed';
}

function errName(err: unknown): string | undefined {
  const n = (err as { name?: unknown } | null)?.name;
  return typeof n === 'string' ? n : undefined;
}

function errMessage(err: unknown): string {
  if (err === null || err === undefined) return 'transação abortada';
  const m = (err as { message?: unknown }).message;
  return typeof m === 'string' && m ? m : String(err);
}

/** Classifica o erro de uma transação/requisição do IndexedDB. */
export function classifyIdbError(err: unknown): IdbFailureKind {
  if (isIdbWriteError(err)) return err.kind;
  if ((err as { idbUnavailable?: unknown } | null)?.idbUnavailable === true) return 'unavailable';
  const name = errName(err);
  // QuotaExceededError (código legado 22) em todos os motores; o Firefox antigo
  // usava NS_ERROR_DOM_QUOTA_REACHED. Algumas versões embrulham como
  // UnknownError com "quota" na mensagem.
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return 'quota';
  if ((err as { code?: unknown } | null)?.code === 22) return 'quota';
  if (/quota/i.test(errMessage(err))) return 'quota';
  return 'failed';
}

function describeFailure(kind: IdbFailureKind, cause: unknown): string {
  const detalhe = errMessage(cause);
  if (kind === 'quota') return `Sem espaço no armazenamento do navegador (${detalhe}).`;
  if (kind === 'unavailable') return `Armazenamento local (IndexedDB) indisponível (${detalhe}).`;
  return `Falha ao gravar no armazenamento local (${detalhe}).`;
}

function unavailable(message: string, cause?: unknown): Error {
  const detalhe = cause === undefined ? '' : `: ${errMessage(cause)}`;
  return Object.assign(new Error(`${message}${detalhe}`), { idbUnavailable: true, cause });
}

// ---------------------------------------------------------------------------
// Conexão. A fábrica é INJETÁVEL (`setIdbFactory`) para testar sem navegador —
// o vitest roda em Node, sem IndexedDB, e o repo não usa fake-indexeddb.
// ---------------------------------------------------------------------------

/** undefined = `globalThis.indexedDB`; null = simula navegador sem IndexedDB. */
let factoryOverride: IDBFactory | null | undefined;
let dbPromise: Promise<IDBDatabase> | null = null;

function currentFactory(): IDBFactory | undefined {
  if (factoryOverride !== undefined) return factoryOverride ?? undefined;
  return typeof indexedDB === 'undefined' ? undefined : indexedDB;
}

/** Troca a fábrica do IndexedDB (testes) e descarta a conexão em cache. */
export function setIdbFactory(factory: IDBFactory | null | undefined): void {
  factoryOverride = factory;
  resetIdbConnection();
}

/** Fecha e esquece a conexão em cache; a próxima operação reabre. */
export function resetIdbConnection(): void {
  const p = dbPromise;
  dbPromise = null;
  // Abrir já tinha falhado => não há conexão para fechar (o erro foi entregue a quem abriu).
  void p?.then((db) => db.close(), () => undefined);
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    const factory = currentFactory();
    if (!factory) {
      reject(unavailable('IndexedDB indisponível neste navegador'));
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(unavailable('não foi possível abrir o IndexedDB', err));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Outra aba pediu upgrade de versão: fecha para não travá-la; a próxima
      // operação desta aba reabre já na versão nova.
      db.onversionchange = () => {
        db.close();
        if (dbPromise === p) dbPromise = null;
      };
      // Conexão fechada pelo navegador (despejo de dados, erro interno do
      // Safari): sem isto, toda escrita seguinte falharia na conexão morta.
      db.onclose = () => {
        if (dbPromise === p) dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(unavailable('não foi possível abrir o IndexedDB', req.error));
  });
  dbPromise = p;
  // Falha ao abrir NÃO fica em cache: a próxima operação tenta de novo (o
  // erro em si segue para quem chamou, por `p`).
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  return p;
}

function reqProm<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

export type IdbWriteOp =
  | { store: Store; put: { id: string } }
  | { store: Store; delete: string };

export interface IdbWriteOpts {
  /** Default 'strict': toda escrita explícita é tratada como checkpoint. */
  durability?: IdbDurability;
}

function runTransaction(
  db: IDBDatabase,
  stores: Store[],
  ops: IdbWriteOp[],
  durability: IdbDurability,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores, 'readwrite', { durability });
    } catch (err) {
      reject(err);
      return;
    }
    // O `error` da requisição que falhou chega primeiro (evento borbulha até a
    // transação) e é mais específico; o `abort` que vem depois é o desfecho.
    let requestError: unknown;
    tx.oncomplete = () => resolve();
    tx.onerror = (ev) => {
      requestError ??= (ev.target as IDBRequest | null)?.error ?? tx.error;
    };
    tx.onabort = () => reject(tx.error ?? requestError ?? new Error('transação abortada'));
    try {
      for (const op of ops) {
        const os = tx.objectStore(op.store);
        if ('put' in op) os.put(op.put);
        else os.delete(op.delete);
      }
    } catch (err) {
      // put síncrono falhou (ex.: DataCloneError). Aborta a transação inteira:
      // nada do lote é gravado — o abort dispara o reject acima.
      requestError = err;
      try {
        tx.abort();
      } catch (abortErr) {
        // Já tinha terminado (não deveria, no mesmo tick): rejeita direto.
        reject(requestError ?? abortErr);
      }
    }
  });
}

/**
 * Grava um lote em UMA transação `readwrite` sobre todas as stores tocadas:
 * o IndexedDB confirma tudo ou nada (rollback conjunto). REJEITA com
 * `IdbWriteError` classificado — nunca engole.
 */
export async function idbWrite(ops: IdbWriteOp[], opts: IdbWriteOpts = {}): Promise<void> {
  if (!ops.length) return;
  const stores = [...new Set(ops.map((o) => o.store))];
  const durability = opts.durability ?? 'strict';
  for (let tentativa = 0; ; tentativa++) {
    let db: IDBDatabase;
    try {
      db = await openDb();
    } catch (err) {
      throw new IdbWriteError('unavailable', stores, err);
    }
    try {
      await runTransaction(db, stores, ops, durability);
      return;
    } catch (err) {
      // Conexão morta (fechada pelo navegador entre a abertura e a transação):
      // reabre UMA vez. Qualquer outro erro sobe classificado.
      if (tentativa === 0 && errName(err) === 'InvalidStateError') {
        resetIdbConnection();
        continue;
      }
      throw new IdbWriteError(classifyIdbError(err), stores, err);
    }
  }
}

export async function idbPut(store: Store, value: { id: string }, opts?: IdbWriteOpts): Promise<void> {
  await idbWrite([{ store, put: value }], opts);
}

export async function idbPutMany(store: Store, values: { id: string }[], opts?: IdbWriteOpts): Promise<void> {
  await idbWrite(
    values.map((v) => ({ store, put: v })),
    opts,
  );
}

export async function idbDelete(store: Store, key: string, opts?: IdbWriteOpts): Promise<void> {
  await idbWrite([{ store, delete: key }], opts);
}

// ---------------------------------------------------------------------------
// Leitura: degrada para vazio (ler não perde dado), mas deixa rastro no console.
// ---------------------------------------------------------------------------

function warnRead(store: Store, err: unknown): void {
  console.warn(`[idb] leitura de '${store}' falhou — seguindo sem cache local: ${errMessage(err)}`);
}

export async function idbGet<T>(store: Store, key: string): Promise<T | undefined> {
  try {
    const db = await openDb();
    const tx = db.transaction(store, 'readonly');
    return await reqProm<T>(tx.objectStore(store).get(key) as IDBRequest<T>);
  } catch (err) {
    warnRead(store, err);
    return undefined;
  }
}

export async function idbGetAll<T>(store: Store): Promise<T[]> {
  try {
    const db = await openDb();
    const tx = db.transaction(store, 'readonly');
    return (await reqProm<T[]>(tx.objectStore(store).getAll() as IDBRequest<T[]>)) ?? [];
  } catch (err) {
    warnRead(store, err);
    return [];
  }
}
