// FAKE de web/src/api.ts para o harness de browser da TrainingView, do
// relatório de ciclos e da biblioteca de prompts (test/web-views-e2e.test.ts).
// O esbuild troca o módulo real por este em TODO o grafo das páginas
// (TrainingView, TrainingReport, PromptsPage, StorageNotice, runShared…), então
// ele exporta o que esse grafo importa — e só isso.
//
// O ponto que importa reproduzir do api.ts real: `fetchSession` e o snapshot
// de `openSessionStream` devolvem a referência VIVA que o "motor" muta em
// lugar (é o que o motor do navegador faz — web/src/engine/events.ts guarda o
// record e o trainer o muta até `session.finished`). Tudo é controlado pelo
// teste via `window.__tvFake`. Zero rede, zero IndexedDB.

// Armazenamento: o módulo real é puro o bastante para o browser (só lê
// navigator.storage quando pedido) — reusar evita um fake paralelo.
export {
  estimateStorage,
  getStorageHealth,
  refreshPersistState,
  requestPersistentStorage,
  storageNoticeContent,
  subscribeStorageHealth,
} from '../../web/src/storageHealth';

type AnyRecord = Record<string, any>;
type Listener = (e: AnyRecord) => void;

interface SavedPromptLike {
  id: string;
  name: string;
  text: string;
  version: number;
  history: { version: number; text: string; savedAt: string; note?: string }[];
  origin?: AnyRecord;
  createdAt: string;
  updatedAt: string;
}

const state = {
  /** Records VIVOS de sessão (mutados em lugar pelo teste, como o trainer faz). */
  sessions: new Map<string, AnyRecord>(),
  runs: new Map<string, AnyRecord>(),
  /** true = `fetchRun` nunca resolve (sessão aberta antes das runs chegarem). */
  runsPending: false,
  cancellable: new Set<string>(),
  listeners: new Map<string, Set<Listener>>(),
  prompts: [] as SavedPromptLike[],
  cancelCalls: [] as string[],
};

function listenersOf(id: string): Set<Listener> {
  let set = state.listeners.get(id);
  if (!set) {
    set = new Set();
    state.listeners.set(id, set);
  }
  return set;
}

/** Controle do teste (page.evaluate). */
const control = {
  state,
  reset(): void {
    state.sessions.clear();
    state.runs.clear();
    state.runsPending = false;
    state.cancellable.clear();
    state.listeners.clear();
    state.prompts = [];
    state.cancelCalls = [];
  },
  /** Emite um evento de sessão para quem assina (como `emitSessionEvent`). */
  emit(sessionId: string, event: AnyRecord): void {
    for (const l of [...listenersOf(sessionId)]) l(event);
  },
  /**
   * Simula o fim do treino EXATAMENTE como o trainer do navegador: muta o
   * record vivo (status/finishedAt), a aba deixa de poder cancelar e o
   * `session.finished` carrega a MESMA referência.
   */
  finish(sessionId: string, patch: AnyRecord = {}): void {
    const live = state.sessions.get(sessionId);
    if (!live) throw new Error(`sessão ${sessionId} não semeada`);
    live.status = 'finished';
    live.finishedAt = new Date().toISOString();
    Object.assign(live, patch);
    state.cancellable.delete(sessionId);
    control.emit(sessionId, { type: 'session.finished', sessionId, record: live });
  },
  listenerCount(sessionId: string): number {
    return listenersOf(sessionId).size;
  },
};

(globalThis as unknown as { __tvFake: typeof control }).__tvFake = control;

// ------------------------------------------------------------------ sessão

export async function fetchSession(id: string): Promise<AnyRecord> {
  const live = state.sessions.get(id);
  if (!live) throw new Error('Sessão não encontrada');
  return live; // referência VIVA, como o api.ts real
}

export function openSessionStream(id: string, onEvent: Listener): () => void {
  const live = state.sessions.get(id);
  if (live) onEvent({ type: 'snapshot', record: live });
  const set = listenersOf(id);
  set.add(onEvent);
  return () => {
    set.delete(onEvent);
  };
}

export async function cacheSession(): Promise<void> {}

export function canCancelSession(id: string): boolean {
  return state.cancellable.has(id);
}

export function cancelSession(id: string): boolean {
  state.cancelCalls.push(id);
  return state.cancellable.has(id);
}

export async function markSessionInterrupted(): Promise<null> {
  return null;
}

// --------------------------------------------------------------------- runs

export function fetchRun(id: string): Promise<AnyRecord> {
  if (state.runsPending) return new Promise(() => undefined);
  const r = state.runs.get(id);
  return r ? Promise.resolve(r) : Promise.reject(new Error('Run nao encontrada'));
}

export function getLiveRun(): undefined {
  return undefined;
}

export function subscribeRunLive(): () => void {
  return () => undefined;
}

export function runMode(record: AnyRecord): string {
  return record.mode ?? record.config?.mode ?? 'compare';
}

export function normalizeContestants(record: AnyRecord): AnyRecord[] {
  if (record.contestants && record.contestants.length) return record.contestants;
  const ids: string[] = record.config?.competitorModelIds ?? [];
  return ids.map((id) => ({ id, label: id, modelId: id }));
}

// ---------------------------------------------------------- armazenamento

export async function retrySave(): Promise<boolean> {
  return false;
}

export function liveStorageRecord(): undefined {
  return undefined;
}

// ------------------------------------------------------------- biblioteca

export async function listPrompts(): Promise<SavedPromptLike[]> {
  return [...state.prompts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function savePrompt(input: { name: string; text: string; origin?: AnyRecord; note?: string }): Promise<SavedPromptLike> {
  const now = new Date().toISOString();
  const p: SavedPromptLike = {
    id: `p${state.prompts.length + 1}`,
    name: input.name,
    text: input.text,
    version: 1,
    history: [{ version: 1, text: input.text, savedAt: now, note: input.note }],
    origin: input.origin,
    createdAt: now,
    updatedAt: now,
  };
  state.prompts.push(p);
  return p;
}

export async function updatePrompt(
  id: string,
  input: { text?: string; name?: string; note?: string },
): Promise<SavedPromptLike | undefined> {
  const p = state.prompts.find((x) => x.id === id);
  if (!p) return undefined;
  const now = new Date().toISOString();
  if (input.name !== undefined) p.name = input.name;
  if (input.text !== undefined && input.text !== p.text) {
    p.text = input.text;
    p.version += 1;
    p.history.push({ version: p.version, text: p.text, savedAt: now, note: input.note });
  }
  p.updatedAt = now;
  return { ...p, history: [...p.history] };
}

export async function deletePrompt(id: string): Promise<void> {
  state.prompts = state.prompts.filter((x) => x.id !== id);
}

// ------------------------------------------------------ pacote de cenários

export function buildScenarioPack(input: AnyRecord): AnyRecord {
  return { format: 'prompt-builder-pack@1', ...input };
}

export function downloadScenarioPack(): void {}
