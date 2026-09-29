// http-api#3 — o SPA servido JUNTO do backend (self-host: `npm start` em
// :3001, ou Vite com proxy de /v1 em `npm run dev`) lê as runs/sessões criadas
// pela API HTTP. Antes nenhum código do web falava com /v1: uma run criada por
// `curl POST /v1/benchmark/runs` ia para data/runs/*.json e a UI da MESMA
// porta nunca a mostrava (`/runs/<id>` = "Run nao encontrada").
//
// E o deploy estático (Vercel) NÃO muda: lá `/health` é o index.html (rewrite)
// e o modo fica desligado — nenhuma chamada a /v1.
//
// Aqui o "navegador" é: `location` apontando para o servidor real (Express em
// processo, porta efêmera), IndexedDB falso e um EventSource mínimo sobre o
// fetch do Node (o Node não tem EventSource global). Zero rede externa.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { getDataDir, saveRun, saveSession, setDataDir } from '../src/storage.js';
import { emitEvent, emitSessionEvent } from '../src/events.js';
import type { RunRecord, SessionRecord } from '../src/types.js';
import { FakeIdb } from './fakeIndexedDb.js';

// ---------------------------------------------------------------------------
// EventSource mínimo (o do navegador não existe no Node)
// ---------------------------------------------------------------------------

class FetchEventSource {
  static instances: FetchEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly ctrl = new AbortController();

  constructor(readonly url: string) {
    FetchEventSource.instances.push(this);
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      const res = await fetch(this.url, { signal: this.ctrl.signal, headers: { accept: 'text/event-stream' } });
      if (!res.ok || !res.body) {
        if (!this.closed) this.onerror?.();
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n');
          if (data && !this.closed) this.onmessage?.({ data });
        }
      }
      // O servidor fechou o stream: o navegador dispararia `error` (e reconectaria).
      if (!this.closed) this.onerror?.();
    } catch {
      if (!this.closed) this.onerror?.();
    }
  }

  close(): void {
    this.closed = true;
    this.ctrl.abort();
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function runFixture(id: string, status: RunRecord['status'], theme = 'via API'): RunRecord {
  return {
    id,
    status,
    mode: 'compare',
    config: {
      mode: 'compare',
      theme,
      stages: 1,
      datagenModelId: 'a/gen',
      judgeModelIds: ['a/judge'],
      competitorModelIds: ['a/x', 'a/y'],
    },
    contestants: [],
    stages: [],
    scoreboard: {},
    totalCostUsd: 0.25,
    startedAt: new Date().toISOString(),
    ...(status === 'running' ? {} : { finishedAt: new Date().toISOString() }),
  } as unknown as RunRecord;
}

function sessionFixture(id: string, status: SessionRecord['status']): SessionRecord {
  return {
    id,
    status,
    config: { mode: 'training', theme: 'treino via API', iterations: 2 },
    runIds: [],
    bestPromptByIteration: [],
    totalCostUsd: 0,
    startedAt: new Date().toISOString(),
  } as unknown as SessionRecord;
}

function memoryLocalStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

/** Uma "aba": módulos novos do web sobre um IndexedDB falso, com `location` = origem. */
async function abrirAba(origin: string | null) {
  vi.resetModules();
  if (origin) {
    const u = new URL(origin);
    vi.stubGlobal('location', { origin: u.origin, protocol: u.protocol, href: u.href });
  }
  vi.stubGlobal('EventSource', FetchEventSource);
  vi.stubGlobal('localStorage', memoryLocalStorage());
  const idb = await import('../web/src/idb.js');
  const disco = new FakeIdb();
  idb.setIdbFactory(disco.factory);
  const runLocks = await import('../web/src/engine/runLocks.js');
  runLocks.setLockManager(null);
  const storageHealth = await import('../web/src/storageHealth.js');
  storageHealth.setStorageManager(null);
  const api = await import('../web/src/api.js');
  const backend = await import('../web/src/backend.js');
  const storage = await import('../web/src/engine/storage.js');
  return { api, backend, storage, disco };
}

async function esperar<T>(fn: () => T | undefined | null | false, ms = 5_000): Promise<T> {
  const fim = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > fim) throw new Error('tempo esgotado esperando a condição');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ---------------------------------------------------------------------------

describe('http-api#3 — SPA self-host lê as runs/sessões do backend', () => {
  let tmp: string;
  let dirAnterior: string;
  let server: Server;
  let origin: string;
  const finalizada = randomUUID();
  const rodando = randomUUID();
  const sessao = randomUUID();
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pb-web-backend-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    await saveRun(runFixture(finalizada, 'finished', 'run finalizada via curl'));
    await saveRun(runFixture(rodando, 'running', 'run em andamento via curl'));
    await saveSession(sessionFixture(sessao, 'running'));
    server = await startServer({ port: 0, webDist: null });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    // termina o que ficou 'running' (libera o dono em disco deste processo)
    await saveRun({ ...runFixture(rodando, 'aborted') });
    await saveSession({ ...sessionFixture(sessao, 'aborted') });
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  afterEach(() => {
    silencio.forEach((s) => s.mockRestore());
    silencio = [];
    vi.unstubAllGlobals();
    FetchEventSource.instances = [];
  });

  it('detecta o backend pelo /health JSON e junta o histórico (o local vence no mesmo id)', async () => {
    const aba = await abrirAba(origin);
    expect(await aba.backend.backendAvailable()).toBe(true);

    // Uma run LOCAL (IndexedDB) com o mesmo id da finalizada do servidor: a local vence.
    await aba.storage.saveRun({ ...runFixture(finalizada, 'finished', 'cópia local') } as never);
    const runs = await aba.api.fetchRuns();
    const porId = new Map(runs.map((r) => [r.id, r]));
    expect(porId.get(finalizada)?.theme).toBe('cópia local');
    expect(porId.get(rodando)?.theme).toBe('run em andamento via curl');
    expect(runs.filter((r) => r.id === finalizada)).toHaveLength(1);

    const sessoes = await aba.api.fetchSessions();
    expect(sessoes.map((s) => s.id)).toContain(sessao);
  });

  it('fetchRun/fetchSession caem no backend quando o IndexedDB não tem o id', async () => {
    const aba = await abrirAba(origin);
    const r = await aba.api.fetchRun(rodando);
    expect(r.id).toBe(rodando);
    expect(r.status).toBe('running');
    const s = await aba.api.fetchSession(sessao);
    expect(s.id).toBe(sessao);
    await expect(aba.api.fetchRun(randomUUID())).rejects.toThrow(/nao encontrada/u);
  });

  it('openRunStream de uma run do servidor: snapshot + eventos pelo SSE, e o EventSource FECHA no terminal', async () => {
    const aba = await abrirAba(origin);
    const eventos: any[] = [];
    const parar = aba.api.openRunStream(rodando, (e) => eventos.push(e));
    await esperar(() => eventos.find((e) => e.type === 'snapshot'));
    expect(eventos[0]).toMatchObject({ type: 'snapshot', record: { id: rodando, status: 'running' } });
    const es = await esperar(() => FetchEventSource.instances[0]);
    expect(es.url).toBe(`${origin}/v1/benchmark/runs/${rodando}/events`);

    // O servidor (mesmo processo) emite o terminal no barramento da run.
    emitEvent({ type: 'run.finished', runId: rodando, record: runFixture(rodando, 'finished') } as never);
    await esperar(() => eventos.find((e) => e.type === 'run.finished'));
    expect(es.closed).toBe(true); // sem reconexão infinita (AGENTS.md: SSE)
    parar();
  });

  it('openSessionStream de uma sessão do servidor: snapshot + terminal, e fecha', async () => {
    const aba = await abrirAba(origin);
    const eventos: any[] = [];
    const parar = aba.api.openSessionStream(sessao, (e) => eventos.push(e));
    await esperar(() => eventos.find((e) => e.type === 'snapshot'));
    const es = await esperar(() => FetchEventSource.instances[0]);
    emitSessionEvent({ type: 'session.finished', sessionId: sessao, record: sessionFixture(sessao, 'finished') } as never);
    await esperar(() => eventos.find((e) => e.type === 'session.finished'));
    expect(es.closed).toBe(true);
    parar();
  });

  it('fechar a tela (closer do openRunStream) fecha o EventSource do backend', async () => {
    const aba = await abrirAba(origin);
    const eventos: any[] = [];
    const parar = aba.api.openRunStream(rodando, (e) => eventos.push(e));
    const es = await esperar(() => FetchEventSource.instances[0]);
    await esperar(() => eventos.find((e) => e.type === 'snapshot'));
    parar();
    expect(es.closed).toBe(true);
  });

  it('subscribeRunLive (cockpit de treino) de uma run do servidor: record inicial chega como run.started', async () => {
    const aba = await abrirAba(origin);
    const eventos: any[] = [];
    const parar = aba.api.subscribeRunLive(rodando, (e) => eventos.push(e));
    const primeiro = await esperar(() => eventos[0]);
    expect(primeiro).toMatchObject({ type: 'run.started', runId: rodando, record: { id: rodando } });
    parar();
    const es = FetchEventSource.instances[0];
    expect(es?.closed).toBe(true);
  });
});

describe('http-api#3 — SPA estática (Vercel) e fora do navegador: modo desligado', () => {
  let estatico: Server;
  let origin: string;
  const pedidos: string[] = [];

  beforeAll(async () => {
    // Simula o rewrite do vercel.json: TODO caminho devolve o index.html.
    estatico = http.createServer((req, res) => {
      pedidos.push(req.url ?? '');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><title>SPA</title>');
    });
    await new Promise<void>((r) => estatico.listen(0, '127.0.0.1', () => r()));
    origin = `http://127.0.0.1:${(estatico.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    estatico.closeAllConnections?.();
    await new Promise<void>((r) => estatico.close(() => r()));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('/health = index.html (200 text/html) → sem backend: nenhuma chamada a /v1, histórico só local', async () => {
    const aba = await abrirAba(origin);
    await aba.storage.saveRun(runFixture(randomUUID(), 'finished', 'local') as never);
    expect(await aba.backend.backendAvailable()).toBe(false);
    const runs = await aba.api.fetchRuns();
    expect(runs.map((r) => r.theme)).toEqual(['local']);
    await expect(aba.api.fetchRun(randomUUID())).rejects.toThrow(/nao encontrada/u);
    expect(pedidos).toEqual(['/health']); // o probe é único e memoizado
  });

  it('sem `location` (Node/SSR/testes) → sem backend e sem fetch', async () => {
    const aba = await abrirAba(null);
    const espiao = vi.fn();
    vi.stubGlobal('fetch', espiao);
    expect(await aba.backend.backendAvailable()).toBe(false);
    expect(await aba.backend.fetchBackendRuns()).toEqual([]);
    expect(espiao).not.toHaveBeenCalled();
  });

  it('mergeById: local primeiro, remoto só com id novo', async () => {
    const { mergeById } = await import('../web/src/backend.js');
    expect(mergeById([{ id: 'a', v: 1 }], [{ id: 'a', v: 2 }, { id: 'b', v: 3 }])).toEqual([
      { id: 'a', v: 1 },
      { id: 'b', v: 3 },
    ]);
  });
});
