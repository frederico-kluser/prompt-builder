// Modo SELF-HOST do SPA (http-api#3): leitura das runs/sessões do backend.
//
// O SPA roda o pipeline NA ABA e guarda no IndexedDB — é o que a Vercel serve
// (estático, sem backend). Mas o mesmo `web/dist` também é servido pelo
// Express (`npm start`, :3001) e pelo Vite com proxy de /v1 (`npm run dev`),
// e aí as runs criadas pela API HTTP (curl, agentes, `POST /v1/benchmark/runs`)
// moravam em `data/runs/*.json` e NUNCA apareciam na UI da mesma porta
// (`/runs/<id>` dava "Run nao encontrada").
//
// Agora, quando `GET /health` da MESMA origem responde o JSON do backend, o
// histórico junta as runs/sessões do servidor às do IndexedDB e a tela de
// run/treino as acompanha pelo SSE de `/v1/benchmark/.../events`. É SOMENTE
// LEITURA: runs criadas na UI continuam rodando na aba (a key do OpenRouter
// não vai para o servidor).
//
// Na SPA estática `/health` é o index.html (rewrite do vercel.json): o modo
// fica desligado e nada muda — nenhuma chamada além do probe único.

import type { RunRecord, RunSummary, SessionRecord, SessionSummary } from './api';
import { normalizeRunRecord } from './engine/normalize';

const API = '/v1/benchmark';

/** Teto de cada GET: um backend travado não pode segurar o histórico local. */
const GET_TIMEOUT_MS = 5_000;

function getInit(): RequestInit {
  return {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(GET_TIMEOUT_MS) : undefined,
  };
}

/** Origem da página (http/https). Fora do navegador (testes/SSR) = sem backend. */
function pageOrigin(): string | null {
  try {
    const loc = (globalThis as { location?: Location }).location;
    if (!loc || !/^https?:$/u.test(loc.protocol)) return null;
    return loc.origin;
  } catch {
    return null;
  }
}

function urlFor(path: string): string | null {
  const origin = pageOrigin();
  return origin ? new URL(path, origin).toString() : null;
}

let probe: Promise<boolean> | null = null;

/**
 * O SPA está sendo servido junto do backend? Probe ÚNICO (memoizado) de
 * `/health`: só vale o JSON `{ service: 'prompt-builder' }` — o index.html da
 * Vercel (200 text/html), um 404 ou um proxy sem backend (502) = não.
 */
export function backendAvailable(): Promise<boolean> {
  probe ??= (async () => {
    const url = urlFor('/health');
    if (!url || typeof fetch !== 'function') return false;
    try {
      const res = await fetch(url, getInit());
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) return false;
      const body = (await res.json()) as { service?: unknown } | null;
      return body?.service === 'prompt-builder';
    } catch {
      return false;
    }
  })();
  return probe;
}

/** Só para testes: esquece o resultado do probe. */
export function resetBackendProbe(): void {
  probe = null;
}

/** GET JSON do backend. `null` = sem backend, 404 ou falha (a UI segue com o local). */
async function getJson<T>(path: string): Promise<T | null> {
  if (!(await backendAvailable())) return null;
  const url = urlFor(path);
  if (!url) return null;
  try {
    const res = await fetch(url, getInit());
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchBackendRuns(): Promise<RunSummary[]> {
  return (await getJson<{ data?: RunSummary[] }>(`${API}/runs`))?.data ?? [];
}

export async function fetchBackendSessions(): Promise<SessionSummary[]> {
  return (await getJson<{ data?: SessionSummary[] }>(`${API}/sessions`))?.data ?? [];
}

export async function fetchBackendRun(id: string): Promise<RunRecord | null> {
  const raw = await getJson<RunRecord>(`${API}/runs/${encodeURIComponent(id)}`);
  // Mesma normalização da leitura do IndexedDB (campos novos aditivos).
  return raw ? (normalizeRunRecord(raw as never) as unknown as RunRecord) : null;
}

export function fetchBackendSession(id: string): Promise<SessionRecord | null> {
  return getJson<SessionRecord>(`${API}/sessions/${encodeURIComponent(id)}`);
}

/** Junta o histórico local com o do servidor; o LOCAL vence no mesmo id. */
export function mergeById<T extends { id: string }>(local: readonly T[], remote: readonly T[]): T[] {
  const ids = new Set(local.map((r) => r.id));
  return [...local, ...remote.filter((r) => !ids.has(r.id))];
}

const RUN_TERMINAL = new Set(['run.finished', 'run.error']);
const SESSION_TERMINAL = new Set(['session.finished', 'session.error']);

/**
 * Acompanha o SSE do backend (snapshot + eventos) até o evento terminal. O
 * `EventSource` FECHA no terminal e em qualquer erro — reconectar sozinho
 * depois do fim (ou de um 404) seria um laço infinito (AGENTS.md). `true` =
 * o stream foi aberto (o record existe no servidor).
 */
async function follow(
  path: string,
  terminal: ReadonlySet<string>,
  onEvent: (e: any) => void,
  signal: AbortSignal,
  mapSnapshot?: (e: any) => any,
): Promise<boolean> {
  if (!(await backendAvailable()) || signal.aborted) return false;
  const url = urlFor(path);
  const ES = (globalThis as { EventSource?: typeof EventSource }).EventSource;
  if (!url || !ES) return false;
  const es = new ES(url);
  const close = (): void => {
    es.close();
    signal.removeEventListener('abort', close);
  };
  signal.addEventListener('abort', close, { once: true });
  es.onmessage = (msg: MessageEvent<string>) => {
    let event: any;
    try {
      event = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (signal.aborted) return;
    onEvent(mapSnapshot && event?.type === 'snapshot' ? mapSnapshot(event) : event);
    if (terminal.has(event?.type)) close();
  };
  es.onerror = () => close();
  return true;
}

/** SSE de uma run do servidor (mesmos eventos do motor da aba). */
export function followBackendRun(id: string, onEvent: (e: any) => void, signal: AbortSignal): Promise<boolean> {
  return follow(`${API}/runs/${encodeURIComponent(id)}/events`, RUN_TERMINAL, onEvent, signal);
}

/** SSE de uma sessão de treino do servidor. */
export function followBackendSession(id: string, onEvent: (e: any) => void, signal: AbortSignal): Promise<boolean> {
  return follow(`${API}/sessions/${encodeURIComponent(id)}/events`, SESSION_TERMINAL, onEvent, signal);
}

/**
 * Variante da cockpit de treino (`subscribeRunLive`): ela não trata
 * `snapshot` — o record inicial chega como `run.started`, igual ao motor.
 */
export function followBackendRunLive(id: string, onEvent: (e: any) => void, signal: AbortSignal): Promise<boolean> {
  return follow(`${API}/runs/${encodeURIComponent(id)}/events`, RUN_TERMINAL, onEvent, signal, (e) => ({
    type: 'run.started',
    runId: id,
    record: e.record,
  }));
}
