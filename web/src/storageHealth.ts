// Saúde do armazenamento local da SPA (IMPL-022, R-09:REC-6 + R-10:DEC-2).
//
// Duas coisas que antes eram INVISÍVEIS passam a ser estado observável pela UI:
//  1. persistência — `navigator.storage.persist()` é pedido na PRIMEIRA run da
//     página; sem ele os dados do IndexedDB são "best-effort" e o navegador pode
//     apagá-los sob pressão de espaço (o Safari despeja sites sem uso recente).
//     Negado => a UI MOSTRA (não é detalhe de console).
//  2. gravações que falharam — cada run/sessão cuja ÚLTIMA gravação falhou fica
//     em `unsaved` até uma gravação posterior dar certo. Ela segue viva na
//     memória da aba; a UI oferece baixar o JSON e tentar de novo, e fechar a
//     aba com algo não salvo pede confirmação (runs perdidas em silêncio = 0).
//
// Módulo sem React: estado imutável + assinatura (useSyncExternalStore).

import { classifyIdbError, isIdbWriteError, type IdbFailureKind } from './idb';

export type PersistState = 'unknown' | 'granted' | 'denied' | 'unsupported';
export type StorageSubject = 'run' | 'session';

export interface StorageIssue {
  subject: StorageSubject;
  id: string;
  kind: IdbFailureKind;
  /** Mensagem do navegador (DOMException), para diagnóstico. */
  error: string;
  /** Primeira falha do episódio (ISO). */
  since: string;
  /** Tentativas que falharam desde a última gravação bem-sucedida. */
  failures: number;
}

export interface StorageHealth {
  persist: PersistState;
  /** persist() já foi pedido nesta página (a primeira run pede). */
  persistRequested: boolean;
  /** Chave `${subject}:${id}` => última gravação falhou (vivo só nesta aba). */
  unsaved: Readonly<Record<string, StorageIssue>>;
}

/** Subconjunto de `StorageManager` que usamos (injetável em teste). */
export interface StorageManagerLike {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
}

const PERSIST_MEMO_KEY = 'pb.storage.persist';

const INITIAL: StorageHealth = { persist: 'unknown', persistRequested: false, unsaved: {} };
let health: StorageHealth = INITIAL;
const listeners = new Set<() => void>();

function setHealth(patch: Partial<StorageHealth>): void {
  health = { ...health, ...patch };
  syncUnloadGuard();
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch (err) {
      console.warn('[storage] listener de saúde do armazenamento falhou:', err);
    }
  }
}

export function getStorageHealth(): StorageHealth {
  return health;
}

export function subscribeStorageHealth(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const keyOf = (subject: StorageSubject, id: string): string => `${subject}:${id}`;

export function unsavedIssue(subject: StorageSubject, id: string): StorageIssue | undefined {
  return health.unsaved[keyOf(subject, id)];
}

/**
 * Registra uma gravação que falhou. `isNew` = começo de episódio (ou mudança
 * de tipo): é quando quem chama emite o evento — a batida de 800 ms repetindo
 * a mesma falha não inunda o barramento.
 */
export function reportWriteFailure(
  subject: StorageSubject,
  id: string,
  err: unknown,
): { issue: StorageIssue; isNew: boolean } {
  const kind = classifyIdbError(err);
  const error = isIdbWriteError(err)
    ? err.message
    : err instanceof Error
      ? err.message
      : String(err);
  const k = keyOf(subject, id);
  const prev = health.unsaved[k];
  const issue: StorageIssue = {
    subject,
    id,
    kind,
    error,
    since: prev?.since ?? new Date().toISOString(),
    failures: (prev?.failures ?? 0) + 1,
  };
  setHealth({ unsaved: { ...health.unsaved, [k]: issue } });
  return { issue, isNew: !prev || prev.kind !== kind };
}

/** Gravação deu certo: o registro no disco está completo, o episódio acabou. */
export function reportWriteSuccess(subject: StorageSubject, id: string): void {
  const k = keyOf(subject, id);
  if (!(k in health.unsaved)) return;
  const { [k]: _resolvido, ...resto } = health.unsaved;
  setHealth({ unsaved: resto });
}

// ---------------------------------------------------------------------------
// Fechar a aba com run não salva: o navegador pede confirmação. É a última
// barreira contra "perdi a run e ninguém me avisou".
// ---------------------------------------------------------------------------

let unloadGuardOn = false;
function onBeforeUnload(ev: BeforeUnloadEvent): void {
  ev.preventDefault();
  // Legado (Chrome < 119 / Safari): exige returnValue não vazio.
  ev.returnValue = 'Há runs não salvas no navegador.';
}

function syncUnloadGuard(): void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  const precisa = Object.keys(health.unsaved).length > 0;
  if (precisa && !unloadGuardOn) window.addEventListener('beforeunload', onBeforeUnload);
  if (!precisa && unloadGuardOn) window.removeEventListener('beforeunload', onBeforeUnload);
  unloadGuardOn = precisa;
}

// ---------------------------------------------------------------------------
// Persistência (navigator.storage.persist)
// ---------------------------------------------------------------------------

/** undefined = `navigator.storage`; null = simula navegador sem a API. */
let smOverride: StorageManagerLike | null | undefined;
let persistRequest: Promise<PersistState> | null = null;

function storageManager(): StorageManagerLike | undefined {
  if (smOverride !== undefined) return smOverride ?? undefined;
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as { storage?: StorageManagerLike }).storage;
}

function readMemo(): PersistState | undefined {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(PERSIST_MEMO_KEY);
    return v === 'granted' || v === 'denied' ? v : undefined;
  } catch {
    return undefined; // localStorage bloqueado (modo privado/iframe): só perde a memória entre recargas
  }
}

function writeMemo(state: PersistState): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(PERSIST_MEMO_KEY, state);
  } catch (err) {
    console.warn('[storage] não foi possível lembrar o estado de persistência:', err);
  }
}

/**
 * Pede armazenamento persistente. Chamado na PRIMEIRA run da página (dentro do
 * clique em Iniciar: no Firefox o pedido vira um prompt ao usuário; Chrome e
 * Safari decidem por heurística). Memoizado por página — `again: true` (botão
 * explícito em Configurações) pede de novo. NUNCA lança.
 */
export function requestPersistentStorage(opts: { again?: boolean } = {}): Promise<PersistState> {
  if (persistRequest && !opts.again) return persistRequest;
  const sm = storageManager();
  setHealth({ persistRequested: true });
  persistRequest = (async (): Promise<PersistState> => {
    let state: PersistState;
    if (!sm?.persist) {
      state = 'unsupported';
    } else {
      try {
        // persist() direto (sem persisted() antes): preserva a ativação do
        // clique e devolve true sem perguntar quando já foi concedido.
        state = (await sm.persist()) ? 'granted' : 'denied';
      } catch (err) {
        // SecurityError (iframe/sandbox) etc.: o armazenamento segue best-effort.
        console.warn('[storage] navigator.storage.persist() falhou:', err);
        state = 'denied';
      }
      writeMemo(state);
    }
    setHealth({ persist: state });
    return state;
  })();
  return persistRequest;
}

/**
 * Estado atual SEM pedir nada (persisted() não mostra prompt). Usado ao abrir
 * telas: um "negado" de uma visita anterior continua visível após recarregar.
 */
export async function refreshPersistState(): Promise<PersistState> {
  if (persistRequest) return persistRequest;
  const sm = storageManager();
  let state: PersistState;
  if (!sm?.persist) state = 'unsupported';
  else {
    let persisted = false;
    try {
      persisted = sm.persisted ? await sm.persisted() : false;
    } catch (err) {
      console.warn('[storage] navigator.storage.persisted() falhou:', err);
    }
    state = persisted ? 'granted' : readMemo() === 'denied' ? 'denied' : 'unknown';
  }
  if (!persistRequest && state !== health.persist) setHealth({ persist: state });
  return state;
}

/** Uso/cota estimados pelo navegador (bytes). undefined = API ausente. */
export async function estimateStorage(): Promise<{ usageBytes: number; quotaBytes: number } | undefined> {
  const sm = storageManager();
  if (!sm?.estimate) return undefined;
  try {
    const e = await sm.estimate();
    return { usageBytes: e.usage ?? 0, quotaBytes: e.quota ?? 0 };
  } catch (err) {
    console.warn('[storage] navigator.storage.estimate() falhou:', err);
    return undefined;
  }
}

/** Testes: troca o StorageManager e zera o estado do módulo. */
export function setStorageManager(sm: StorageManagerLike | null | undefined): void {
  smOverride = sm;
  resetStorageHealth();
}

/** Testes: volta ao estado inicial (sem pedido de persist, sem falhas). */
export function resetStorageHealth(): void {
  persistRequest = null;
  health = INITIAL;
  syncUnloadGuard();
  for (const cb of [...listeners]) cb();
}

// ---------------------------------------------------------------------------
// Texto do aviso (puro — a UI só desenha). Um aviso por tela, na prioridade:
// gravação falhou (dado em risco AGORA) > persistência negada (risco futuro).
// ---------------------------------------------------------------------------

export interface StorageNotice {
  kind: 'unsaved' | 'persist-denied';
  tone: 'error' | 'warn' | 'neutral';
  title: string;
  body: string;
  /** Itens não salvos cobertos pelo aviso (vazio no de persistência). */
  issues: StorageIssue[];
}

const CAUSA: Record<IdbFailureKind, string> = {
  quota: 'o espaço de armazenamento do navegador acabou',
  unavailable: 'o armazenamento local (IndexedDB) está indisponível — janela anônima ou bloqueado pelo navegador',
  failed: 'a gravação no armazenamento local falhou',
};

/**
 * `targets` = os itens da tela (run; sessão + runs das rodadas), ou 'all' no
 * Histórico — que lê do IndexedDB e por isso NÃO mostra o que não foi salvo.
 */
export function storageNoticeContent(
  h: StorageHealth,
  targets: ReadonlyArray<{ subject: StorageSubject; id: string }> | 'all',
): StorageNotice | null {
  const issues =
    targets === 'all'
      ? Object.values(h.unsaved)
      : targets.flatMap((t) => {
          const i = h.unsaved[keyOf(t.subject, t.id)];
          return i ? [i] : [];
        });
  if (issues.length > 0) {
    const pior = issues.find((i) => i.kind === 'quota') ?? issues[0];
    const umaRun = issues[0].subject === 'run';
    const curto = issues[0].id.slice(0, 8);
    // Na tela do item: "esta run". No Histórico (vários itens possíveis): nomeia.
    const alvo =
      issues.length > 1
        ? `${issues.length} itens desta aba`
        : targets === 'all'
          ? umaRun
            ? `a run ${curto}`
            : `o treino ${curto}`
          : umaRun
            ? 'esta run'
            : 'este treino';
    const lista = '(o Histórico só lista o que foi salvo)';
    const onde =
      targets !== 'all'
        ? 'O resultado continua aberto nesta aba, mas se perde ao fechá-la. '
        : issues.length > 1
          ? `Eles continuam abertos nesta aba ${lista} e se perdem ao fechá-la. `
          : umaRun
            ? `Ela continua aberta nesta aba ${lista} e se perde ao fechá-la. `
            : `Ele continua aberto nesta aba ${lista} e se perde ao fechá-la. `;
    return {
      kind: 'unsaved',
      tone: pior.kind === 'quota' ? 'error' : 'warn',
      title: `Não foi possível salvar ${alvo} no navegador: ${CAUSA[pior.kind]}.`,
      body: `${onde}Baixe o JSON agora — ou libere espaço no navegador e tente salvar de novo.`,
      issues,
    };
  }
  if (h.persist === 'denied') {
    return {
      kind: 'persist-denied',
      tone: 'neutral',
      title: 'Armazenamento não persistente.',
      body:
        'O navegador não garantiu o armazenamento deste site: sob pressão de espaço (ou, no Safari, ' +
        'depois de dias sem uso) ele pode apagar o histórico local de runs sem avisar. ' +
        'Baixe o JSON das runs que importam.',
      issues: [],
    };
  }
  return null;
}
