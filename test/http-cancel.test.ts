// http-api#2 — cancelamento pela API HTTP (/v1/benchmark) e encerramento
// gracioso do servidor.
//
// Antes: nenhuma rota cancelava, o motor era chamado SEM sinal de abort, e o
// `runs cancel` do CLI mandava para um `DELETE /v1/benchmark/runs/<id>` que
// nunca existiu. O único jeito de parar era matar o servidor — e o SIGTERM
// deixava o record 'running' em disco e cortava o SSE sem evento terminal.
//
// Zero rede e zero gasto: o chat do OpenRouter falso NUNCA responde (a run
// fica 'running' até o abort) — só o datagen e o reescritor respondem, para o
// treino chegar à 1ª iteração.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { createGateway, setDefaultGateway, type FetchLike, type OpenRouterGateway } from '../src/openrouter.js';
import { getDataDir, loadRun, loadSession, setDataDir } from '../src/storage.js';
import { isControlled, shutdownControlled } from '../src/httpRunControl.js';
import { subscribeSession } from '../src/events.js';
import type { RunRecord } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { nodeOrTsx, ROOT } from './support/cli.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000000000000000000000';
const MODELOS = ['fake/gen', 'fake/opt', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b'];

const CENARIOS = [
  { question: 'Qual o prazo de troca?', productContext: 'Trocas em 30 dias.', maxTokens: 200, rubric: 'Cita 30 dias.' },
  { question: 'Como pedir reembolso?', productContext: 'Reembolso pelo app.', maxTokens: 200, rubric: 'Cita o app.' },
];

const COMPARE = {
  mode: 'compare',
  theme: 'suporte',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  competitorModelIds: ['fake/a', 'fake/b'],
  timeoutMs: 60_000,
};

const TRAINING = {
  mode: 'training',
  theme: 'suporte',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  contestantModelId: 'fake/a',
  basePrompt: 'Voce e um atendente de suporte. Responda com base no contexto do produto.',
  techniqueIds: ['persona', 'cot'],
  optimizerModelId: 'fake/opt',
  iterations: 2,
  holdoutRatio: 0,
  timeoutMs: 60_000,
};

/** Chat que só termina pelo abort do sinal (rejeita com o motivo, como o fetch). */
function pendurar(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function fetchPendurado(): FetchLike {
  const base = fakeOpenRouter({
    catalog: MODELOS.map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: (req) => {
      if (req.model === 'fake/gen') return { text: JSON.stringify({ stages: CENARIOS }) };
      return {
        text:
          'Voce e um atendente cordial e preciso. Responda sempre com base no contexto do produto, ' +
          'cite prazos e regras exatamente como aparecem e recuse o que estiver fora do escopo.',
      };
    },
  });
  return async (url, init) => {
    if (url.endsWith('/chat/completions')) {
      const model = String((JSON.parse(String(init?.body ?? '{}')) as { model?: string }).model ?? '');
      if (model !== 'fake/gen' && model !== 'fake/opt') return pendurar(init?.signal);
    }
    return base.fetch(url, init);
  };
}

async function esperar<T>(fn: () => Promise<T | undefined | null | false>, ms = 10_000, passo = 25): Promise<T> {
  const fim = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > fim) throw new Error('tempo esgotado esperando a condição');
    await new Promise((r) => setTimeout(r, passo));
  }
}

async function api(port: number, method: string, rota: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${rota}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-openrouter-key': KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

function runRunning(id: string, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    status: 'running',
    mode: 'compare',
    config: COMPARE,
    contestants: [],
    stages: [],
    scoreboard: {},
    totalCostUsd: 0,
    startedAt: new Date().toISOString(),
    ...extra,
  } as unknown as RunRecord;
}

describe('http-api#2 — POST /v1/benchmark/{runs,sessions}/:id/cancel', () => {
  let tmp: string;
  let dirAnterior: string;
  let server: Server;
  let port: number;
  let gatewayAnterior: OpenRouterGateway;
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pb-http-cancel-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    gatewayAnterior = setDefaultGateway(createGateway({ fetch: fetchPendurado(), sleep: noSleep }));
    server = await startServer({ port: 0, webDist: null });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await shutdownControlled(2_000);
    await new Promise<void>((r) => server.close(() => r()));
    setDefaultGateway(gatewayAnterior);
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('run iniciada pela API é cancelável: 202 → record aborted/cancelled com o parcial; depois 409', async () => {
    const criada = await api(port, 'POST', '/v1/benchmark/runs', COMPARE);
    expect(criada.status, JSON.stringify(criada.json)).toBe(202);
    const runId = criada.json.runId as string;
    expect(isControlled('run', runId)).toBe(true);

    // O chat do fake nunca responde: a run fica 'running' no disco.
    await esperar(async () => (await loadRun(runId))?.status === 'running');

    const cancel = await api(port, 'POST', `/v1/benchmark/runs/${runId}/cancel`);
    expect(cancel.status).toBe(202);
    expect(cancel.json).toEqual({ runId, aborted: true });

    const final = await esperar(async () => {
      const r = await loadRun(runId);
      return r && r.status !== 'running' ? r : undefined;
    });
    // Cancelamento é CONTROLE, não erro: 'aborted' com stoppedReason.
    expect(final.status).toBe('aborted');
    expect(final.stoppedReason).toBe('cancelled');
    await esperar(async () => !isControlled('run', runId));

    const denovo = await api(port, 'POST', `/v1/benchmark/runs/${runId}/cancel`);
    expect(denovo.status).toBe(409);
    expect(denovo.json.error).toMatch(/já terminou/u);
  });

  it('cancelar duas vezes antes do terminal é idempotente (202 nas duas)', async () => {
    const { json } = await api(port, 'POST', '/v1/benchmark/runs', COMPARE);
    const runId = json.runId as string;
    const [a, b] = await Promise.all([
      api(port, 'POST', `/v1/benchmark/runs/${runId}/cancel`),
      api(port, 'POST', `/v1/benchmark/runs/${runId}/cancel`),
    ]);
    expect([a.status, b.status]).toEqual([202, 202]);
    const final = await esperar(async () => {
      const r = await loadRun(runId);
      return r && r.status !== 'running' ? r : undefined;
    });
    expect(final.status).toBe('aborted');
  });

  it('id inexistente → 404 JSON; run de OUTRO processo → 409 com o caminho certo (CLI/MCP), sem fingir', async () => {
    const nada = await api(port, 'POST', `/v1/benchmark/runs/${randomUUID()}/cancel`);
    expect(nada.status).toBe(404);
    expect(nada.json.error).toMatch(/nao encontrada/u);

    // Gravada "por outro processo" (direto no disco: um saveRun daqui faria
    // ESTE processo dono dela) — sem controller aqui.
    const alheia = randomUUID();
    mkdirSync(path.join(tmp, 'runs'), { recursive: true });
    writeFileSync(path.join(tmp, 'runs', `${alheia}.json`), JSON.stringify(runRunning(alheia)));
    const r = await api(port, 'POST', `/v1/benchmark/runs/${alheia}/cancel`);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/não roda neste servidor/u);
    expect(r.json.error).toContain(`prompt-builder runs cancel ${alheia}`);
    expect((await loadRun(alheia))?.status).toBe('running'); // intocada

    const semSessao = await api(port, 'POST', `/v1/benchmark/sessions/${randomUUID()}/cancel`);
    expect(semSessao.status).toBe(404);
  });

  it('id malicioso na rota de cancel → 400 (mesma guarda de :id)', async () => {
    const r = await api(port, 'POST', '/v1/benchmark/runs/..%2Fpackage/cancel');
    expect(r.status).toBe(400);
  });

  it('sessão de treino: cancel da iteração aponta para a sessão; cancel da sessão fecha aborted', async () => {
    const criada = await api(port, 'POST', '/v1/benchmark/sessions', TRAINING);
    expect(criada.status, JSON.stringify(criada.json)).toBe(202);
    const sessionId = criada.json.sessionId as string;
    expect(isControlled('session', sessionId)).toBe(true);

    // A 1ª iteração começa (datagen + reescritor respondem; o resto pendura).
    const iterRunId = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('iteração não começou')), 10_000);
      const off = subscribeSession(sessionId, (e) => {
        if (e.type === 'iteration.started') {
          clearTimeout(t);
          off();
          resolve(e.runId);
        }
      });
    });
    await esperar(async () => (await loadRun(iterRunId))?.status === 'running');
    const daIteracao = await api(port, 'POST', `/v1/benchmark/runs/${iterRunId}/cancel`);
    expect(daIteracao.status).toBe(409);
    expect(daIteracao.json.error).toContain(`POST /v1/benchmark/sessions/${sessionId}/cancel`);

    const cancel = await api(port, 'POST', `/v1/benchmark/sessions/${sessionId}/cancel`);
    expect(cancel.status).toBe(202);
    expect(cancel.json).toEqual({ sessionId, aborted: true });

    const sessao = await esperar(async () => {
      const s = await loadSession(sessionId);
      return s && s.status !== 'running' ? s : undefined;
    });
    expect(sessao.status).toBe('aborted');
    expect(sessao.stoppedReason).toBe('cancelled');
    // A run da iteração também fecha — não fica 'running' pendurada.
    const iter = await esperar(async () => {
      const r = await loadRun(iterRunId);
      return r && r.status !== 'running' ? r : undefined;
    });
    expect(iter.status).toBe('aborted');
  });

  it('shutdownControlled (SIGTERM do servidor) aborta TODAS as runs vivas e espera a escrita terminal', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { json } = await api(port, 'POST', '/v1/benchmark/runs', COMPARE);
      ids.push(json.runId as string);
    }
    await esperar(async () => {
      const rs = await Promise.all(ids.map((id) => loadRun(id)));
      return rs.every((r) => r?.status === 'running');
    });
    const out = await shutdownControlled(5_000);
    expect(out.aborted).toBe(2);
    expect(out.forced).toEqual({ runs: [], sessions: [] });
    for (const id of ids) {
      const r = await loadRun(id);
      expect(r?.status).toBe('aborted');
      expect(r?.stoppedReason).toBe('cancelled');
      expect(isControlled('run', id)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Processo REAL: SIGTERM no meio da run grava 'aborted' e sai.
// ---------------------------------------------------------------------------

/** OpenRouter falso por HTTP (o servidor filho usa OPENROUTER_BASE_URL). */
function fakeOpenRouterHttp(): Promise<{ server: Server; baseUrl: string }> {
  const pendurados = new Set<http.ServerResponse>();
  const srv = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: MODELOS.map((id) => catalogItem(id, 1e-6, 1e-6)) }));
      return;
    }
    if (req.method === 'GET' && url.endsWith('/key')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: { label: 'fake', usage: 0, limit: null } }));
      return;
    }
    // chat: nunca responde (o cliente aborta)
    pendurados.add(res);
    res.on('close', () => pendurados.delete(res));
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      resolve({ server: srv, baseUrl: `http://127.0.0.1:${port}/api/v1` });
    });
  });
}

describe('http-api#2 — processo real: SIGTERM no meio da run', () => {
  const { cmd, entry } = nodeOrTsx(path.join(ROOT, 'src', 'server.ts'));

  it('SIGTERM aborta a run (record aborted/cancelled em disco) e o processo sai com 0', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'pb-http-sigterm-'));
    const fake = await fakeOpenRouterHttp();
    const child = spawn(cmd, [entry], {
      cwd: home,
      env: {
        ...process.env,
        BENCHMARK_PORT: '0',
        PROMPT_BUILDER_HOME: home,
        OPENROUTER_BASE_URL: fake.baseUrl,
        HOST: '',
        PB_HOST: '',
        PROMPT_BUILDER_AGENTS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let buf = '';
        const t = setTimeout(() => reject(new Error(`servidor não subiu: ${buf} ${stderr}`)), 15_000);
        child.stdout.on('data', (c: Buffer) => {
          buf += c.toString();
          const m = /listening on http:\/\/[^:]+:(\d+)/u.exec(buf);
          if (m) {
            clearTimeout(t);
            resolve(Number(m[1]));
          }
        });
        child.on('exit', (code) => reject(new Error(`servidor saiu (${code}): ${buf} ${stderr}`)));
      });

      const criada = await api(port, 'POST', '/v1/benchmark/runs', COMPARE);
      expect(criada.status, JSON.stringify(criada.json)).toBe(202);
      const runId = criada.json.runId as string;
      const arquivo = path.join(home, 'runs', `${runId}.json`);
      const lerStatus = (): { status?: string; stoppedReason?: string } | undefined => {
        try {
          return JSON.parse(readFileSync(arquivo, 'utf-8')) as { status?: string; stoppedReason?: string };
        } catch {
          return undefined;
        }
      };
      await esperar(async () => lerStatus()?.status === 'running');

      const saida = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
      child.kill('SIGTERM');
      const code = await saida;
      expect(code, stderr).toBe(0);
      expect(stderr).toMatch(/SIGTERM: abortando/u);
      expect(lerStatus()).toMatchObject({ status: 'aborted', stoppedReason: 'cancelled' });
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      fake.server.closeAllConnections?.();
      await new Promise<void>((r) => fake.server.close(() => r()));
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
