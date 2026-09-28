// Testes de CONTRATO dos jobs do servidor MCP (IMPL-026, R-13:REC-3 / DEC-3).
//
//   (i)   start_run devolve o id em < 500 ms para uma run de 8 cenários — a
//         parte cara (catálogo, datagen, competidores) roda DEPOIS, no job;
//   (ii)  20 retries com a MESMA idempotency-key → o MESMO id e UMA run (em
//         processo, entre gerentes sobre o mesmo data dir e entre processos
//         reais); chave repetida com pedido diferente é recusada;
//   (iii) CreateTaskResult SÓ para quem declarou io.modelcontextprotocol/tasks
//         (teste negativo: sem a extensão, CallToolResult e -32021);
//   (iv)  depois de cancel_run, 0 chamada paga nova em < 2 s e 100% dos
//         cancels deixam o parcial legível (todos os pontos de corte + fila +
//         treino + cancelamento vindo de OUTRO processo);
//   +     nenhum tools/call segura mais de 25 s; 1 run pesada por processo com
//         fila; plano B por TTL/órfão para cliente que some sem cancelar.
//
// Zero rede e zero gasto: o motor fala com o transporte FALSO do OpenRouter.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createGateway, setDefaultGateway, type FetchLike, type OpenRouterGateway } from '../src/openrouter.js';
import {
  getDataDir,
  listRuns,
  listSessions,
  loadRun,
  loadSession,
  saveRun,
  setDataDir,
  writePrivateDataFile,
} from '../src/storage.js';
import {
  BLOCKING_TOOL_LIMIT_MS,
  DEFAULT_JOB_TTL_MS,
  HeavyLane,
  MAX_JOB_TTL_MS,
  MIN_JOB_TTL_MS,
  canonicalJson,
  clampJobTtlMs,
  clampWaitMs,
  isTerminalJobStatus,
  isValidIdempotencyKey,
} from '../src/jobs.js';
import {
  IdempotencyConflict,
  JobManager,
  hashIdempotencyKey,
  isOrphanJob,
  type JobExecutor,
  type JobRecord,
  type JobView,
  type RunJobInput,
} from '../src/jobManager.js';
import {
  MISSING_CAPABILITY,
  McpSession,
  TASKS_EXTENSION,
  callTool,
  type McpTool,
} from '../src/cli/commands/mcp.js';
import { COST_ROLES, type RunConfig, type RunRecord } from '../src/types.js';
import { noSleep, type FakeOpenRouter } from './fakeOpenRouter.js';
import {
  COMPARE,
  KEY,
  TRAINING,
  ate,
  cenarios,
  dormir,
  fakeDoPipeline,
  openRouterHttp,
  processoMcp,
  recordsDoDisco,
  transporte,
  type Msg,
  type Papel,
} from './mcpHarness.js';

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

interface ToolText {
  content?: { type: string; text: string }[];
  isError?: boolean;
  resultType?: string;
}

/** Sessão MCP de teste: escreve em memória e casa respostas por id. */
function novaSessao(opts: {
  jobs?: JobManager;
  lane?: HeavyLane;
  blockingWaitMs?: number;
  tools?: readonly McpTool[];
} = {}) {
  const out: Msg[] = [];
  const logs: string[] = [];
  const session = new McpSession({
    write: (m) => out.push(m as Msg),
    log: (m) => logs.push(m),
    getKey: async () => KEY,
    lane: opts.lane ?? new HeavyLane(1),
    jobs: opts.jobs,
    blockingWaitMs: opts.blockingWaitMs,
    tools: opts.tools,
    graceMs: 3_000,
  });
  let seq = 0;
  const enviar = (m: Record<string, unknown>): void => session.handleLine(JSON.stringify({ jsonrpc: '2.0', ...m }));
  const resposta = (id: unknown): Msg | undefined => out.find((m) => m.id === id);
  const aguardar = async (id: unknown, maxMs = 5_000): Promise<Msg> => {
    await ate(() => resposta(id) !== undefined, maxMs, `resposta ${String(id)}`);
    return resposta(id)!;
  };
  /** tools/call e espera a resposta; `meta` = _meta da requisição. */
  const chamar = async (
    name: string,
    args: Record<string, unknown>,
    extra: { meta?: Record<string, unknown>; maxMs?: number } = {},
  ): Promise<{ msg: Msg; ms: number; result: ToolText; json: Record<string, unknown> | undefined }> => {
    const id = `c-${++seq}`;
    const params: Record<string, unknown> = { name, arguments: args };
    if (extra.meta) params._meta = extra.meta;
    const t0 = performance.now();
    enviar({ id, method: 'tools/call', params });
    const msg = await aguardar(id, extra.maxMs ?? 5_000);
    const ms = performance.now() - t0;
    const result = (msg.result ?? {}) as ToolText;
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(result.content?.[0]?.text ?? '') as Record<string, unknown>;
    } catch {
      json = undefined;
    }
    return { msg, ms, result, json };
  };
  return { session, out, logs, enviar, resposta, aguardar, chamar };
}

const TASKS_META = { 'io.modelcontextprotocol/clientCapabilities': { extensions: { [TASKS_EXTENSION]: {} } } };

/**
 * Executor FALSO controlável: cada job espera `soltar(runId)` ou o abort.
 * Conta quantas vezes a parte cara começou (= runs de verdade).
 */
function executorControlado() {
  const inicios: string[] = [];
  const soltar = new Map<string, () => void>();
  const sinais = new Map<string, AbortSignal>();
  const executor: JobExecutor = async (input, _key, hooks) => {
    const id = hooks.runId ?? `sessao-${inicios.length}`;
    inicios.push(id);
    sinais.set(id, hooks.signal);
    if (input.kind === 'training') hooks.onSessionId(id);
    return new Promise((resolve) => {
      const fim = (cancelled: boolean): void =>
        resolve({
          summary: {
            runId: id,
            status: cancelled ? 'aborted' : 'finished',
            stoppedReason: cancelled ? 'cancelled' : undefined,
            totalCostUsd: 0.01,
          },
          cancelled,
          runId: input.kind === 'training' ? undefined : id,
          sessionId: input.kind === 'training' ? id : undefined,
        });
      soltar.set(id, () => fim(false));
      if (hooks.signal.aborted) fim(true);
      hooks.signal.addEventListener('abort', () => fim(true), { once: true });
    });
  };
  return { executor, inicios, soltar, sinais };
}

function entrada(budgetUsd = 1, extra: Partial<RunConfig> = {}): RunJobInput {
  return { kind: 'benchmark', config: { ...(COMPARE as unknown as RunConfig), ...extra, budgetUsd } as RunConfig, budgetUsd };
}

function arquivosDeJob(dir = getDataDir()): { jobs: string[]; keys: string[] } {
  const j = path.join(dir, 'jobs');
  const jobs = existsSync(j) ? readdirSync(j).filter((f) => f.endsWith('.json')) : [];
  const k = path.join(j, 'keys');
  const keys = existsSync(k) ? readdirSync(k).filter((f) => f.endsWith('.json')) : [];
  return { jobs, keys };
}

let dataDirAnterior: string;
let raizTmp: string;
let silencio: Array<{ mockRestore(): void }> = [];

beforeAll(() => {
  raizTmp = mkdtempSync(path.join(tmpdir(), 'pb-impl026-'));
  dataDirAnterior = getDataDir();
  silencio = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
});
afterAll(() => {
  silencio.forEach((s) => s.mockRestore());
  setDataDir(dataDirAnterior);
  rmSync(raizTmp, { recursive: true, force: true });
});

/** Data dir NOVO por teste: jobs/chaves de um teste não vazam para o outro. */
function dirNovo(): string {
  const d = mkdtempSync(path.join(raizTmp, 'd-'));
  setDataDir(d);
  return d;
}

// ---------------------------------------------------------------------------
// Contrato puro
// ---------------------------------------------------------------------------

describe('IMPL-026 — contrato puro dos jobs', () => {
  it('nenhuma espera bloqueante passa de 25 s (< 30 s); TTL e espera são limitados', () => {
    expect(BLOCKING_TOOL_LIMIT_MS).toBeLessThan(30_000);
    expect(clampWaitMs(3600)).toBe(BLOCKING_TOOL_LIMIT_MS);
    expect(clampWaitMs(-5)).toBe(0);
    expect(clampWaitMs(undefined, 10_000)).toBe(10_000);
    expect(clampWaitMs('10' as unknown)).toBe(0);
    expect(clampJobTtlMs(undefined)).toBe(DEFAULT_JOB_TTL_MS);
    expect(clampJobTtlMs(1)).toBe(MIN_JOB_TTL_MS);
    expect(clampJobTtlMs(10 ** 9)).toBe(MAX_JOB_TTL_MS);
    expect(clampJobTtlMs(600)).toBe(600_000);
  });

  it('JSON canônico não depende da ordem das chaves; idempotency-key validada', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
      canonicalJson({ a: { d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(isValidIdempotencyKey('k-1')).toBe(true);
    expect(isValidIdempotencyKey('')).toBe(false);
    expect(isValidIdempotencyKey('   ')).toBe(false);
    expect(isValidIdempotencyKey('x'.repeat(257))).toBe(false);
    expect(isValidIdempotencyKey(42)).toBe(false);
    expect(hashIdempotencyKey('a')).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashIdempotencyKey('a')).not.toBe(hashIdempotencyKey('b'));
    expect(isTerminalJobStatus('queued')).toBe(false);
    expect(isTerminalJobStatus('working')).toBe(false);
    expect(['completed', 'failed', 'cancelled'].every((s) => isTerminalJobStatus(s as never))).toBe(true);
  });

  it('órfão: mesmo host → pelo PID; outro host → pelo batimento', () => {
    const morto = spawnSync(process.execPath, ['-e', '']).pid!;
    const base: JobRecord = {
      id: 'j',
      kind: 'benchmark',
      tool: 't',
      status: 'working',
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      ttlMs: 1000,
      pollIntervalMs: 5000,
      budgetUsd: 1,
      fingerprint: 'f',
      ownerPid: process.pid,
      ownerHost: os.hostname(),
      heartbeatAt: new Date(Date.now() - 3_600_000).toISOString(),
    };
    // dono vivo no mesmo host: nunca órfão, mesmo com batimento velho
    expect(isOrphanJob(base)).toBe(false);
    expect(isOrphanJob({ ...base, ownerPid: morto })).toBe(true);
    expect(isOrphanJob({ ...base, ownerPid: morto, status: 'completed' })).toBe(false);
    expect(isOrphanJob({ ...base, ownerHost: 'outro-host' })).toBe(true);
    expect(isOrphanJob({ ...base, ownerHost: 'outro-host', heartbeatAt: new Date().toISOString() })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gerente de jobs com executor falso (semântica: idempotência, fila, cancel)
// ---------------------------------------------------------------------------

describe('IMPL-026 — JobManager: idempotência, fila e cancelamento', () => {
  beforeEach(() => {
    dirNovo();
  });

  it('(ii) 20 retries CONCORRENTES + 20 sequenciais com a MESMA chave (start_run) → o MESMO id e UMA run', async () => {
    const ex = executorControlado();
    const jobs = new JobManager({ lane: new HeavyLane(1), executor: ex.executor });
    const s = novaSessao({ jobs });
    const args = { config: COMPARE, budgetUsd: 1, idempotencyKey: 'retry-do-agente-1' };

    const concorrentes = await Promise.all(Array.from({ length: 20 }, () => s.chamar('start_run', args)));
    const ids = new Set(concorrentes.map((r) => r.json?.jobId));
    expect(ids.size).toBe(1);
    expect(concorrentes.filter((r) => r.json?.created === true)).toHaveLength(1);
    const sequenciais: unknown[] = [];
    for (let i = 0; i < 20; i++) sequenciais.push((await s.chamar('start_run', args)).json?.jobId);
    expect(new Set(sequenciais)).toEqual(ids);

    await ate(() => ex.inicios.length > 0, 1000, 'job começar');
    await dormir(20);
    expect(ex.inicios).toHaveLength(1); // 0 runs duplicadas
    expect(arquivosDeJob()).toMatchObject({ jobs: [expect.any(String)], keys: [expect.any(String)] });
    // a chave crua nunca vai para o disco
    const cru = readFileSync(path.join(getDataDir(), 'jobs', arquivosDeJob().jobs[0]), 'utf-8');
    expect(cru).not.toContain('retry-do-agente-1');

    ex.soltar.get(ex.inicios[0])!();
    const fim = await s.chamar('run_status', { jobId: [...ids][0], waitSeconds: 2 });
    expect(fim.json).toMatchObject({ status: 'completed', result: { status: 'finished' } });
    // retry DEPOIS do fim: mesmo job, com o resultado — nada roda de novo
    const depois = await s.chamar('start_run', args);
    expect(depois.json).toMatchObject({ jobId: [...ids][0], created: false, status: 'completed' });
    expect(ex.inicios).toHaveLength(1);
  });

  it('(ii) entre GERENTES sobre o mesmo data dir (≈ processos): a chave é atômica em disco', async () => {
    const exA = executorControlado();
    const exB = executorControlado();
    const a = new JobManager({ lane: new HeavyLane(1), executor: exA.executor });
    const b = new JobManager({ lane: new HeavyLane(1), executor: exB.executor });
    const pedidos = Array.from({ length: 20 }, (_, i) =>
      (i % 2 === 0 ? a : b).start(entrada(), KEY, { tool: 'start_run', idempotencyKey: 'k-cross' }),
    );
    const r = await Promise.all(pedidos);
    expect(new Set(r.map((x) => x.job.jobId)).size).toBe(1);
    expect(r.filter((x) => x.created)).toHaveLength(1);
    await dormir(30);
    expect(exA.inicios.length + exB.inicios.length).toBe(1);
    expect(arquivosDeJob().jobs).toHaveLength(1); // o perdedor da corrida apagou o próprio job
    // um terceiro "processo" vê o job do dono pelo disco
    const c = new JobManager({ lane: new HeavyLane(1), executor: executorControlado().executor });
    const visto = await c.start(entrada(), KEY, { tool: 'start_run', idempotencyKey: 'k-cross' });
    expect(visto).toMatchObject({ created: false, job: { jobId: r[0].job.jobId } });
    const dono = exA.inicios.length ? exA : exB;
    dono.soltar.get(dono.inicios[0])!();
    const st = await c.wait(r[0].job.jobId, 3_000);
    expect(st?.status).toBe('completed');
  });

  it('mesma chave com pedido DIFERENTE → recusado (sem job novo); chave ausente/ inválida → erro de uso', async () => {
    const ex = executorControlado();
    const jobs = new JobManager({ lane: new HeavyLane(1), executor: ex.executor });
    const s = novaSessao({ jobs });
    const ok = await s.chamar('start_run', { config: COMPARE, budgetUsd: 1, idempotencyKey: 'k' });
    expect(ok.json?.created).toBe(true);
    // ordem das chaves diferente = MESMO pedido (JSON canônico)
    const reordenado = Object.fromEntries(Object.entries(COMPARE).reverse());
    const mesmo = await s.chamar('start_run', { idempotencyKey: 'k', budgetUsd: 1, config: reordenado });
    expect(mesmo.json).toMatchObject({ jobId: ok.json?.jobId, created: false });

    const outro = await s.chamar('start_run', { config: COMPARE, budgetUsd: 2, idempotencyKey: 'k' });
    expect(outro.result.isError).toBe(true);
    expect(outro.result.content?.[0].text).toMatch(/idempotencyKey já usada/u);
    await expect(jobs.start(entrada(2), KEY, { tool: 'x', idempotencyKey: 'k' })).rejects.toBeInstanceOf(
      IdempotencyConflict,
    );

    const semChave = await s.chamar('start_run', { config: COMPARE, budgetUsd: 1 });
    expect(semChave.result.isError).toBe(true);
    expect(semChave.result.content?.[0].text).toMatch(/idempotencyKey é obrigatória/u);
    const semOrcamento = await s.chamar('start_run', { config: COMPARE, idempotencyKey: 'z' });
    expect(semOrcamento.result.content?.[0].text).toMatch(/budgetUsd/u);
    const configRuim = await s.chamar('start_run', { config: { mode: 'nada' }, budgetUsd: 1, idempotencyKey: 'y' });
    expect(configRuim.result.isError).toBe(true);
    expect(arquivosDeJob().jobs).toHaveLength(1); // nenhum job novo por pedido inválido
    expect(ex.inicios).toHaveLength(1);
    ex.soltar.get(ex.inicios[0])!();
  });

  it('1 run pesada por processo: as outras esperam na FILA (posição) e cancelar a da fila não gasta nada', async () => {
    const ex = executorControlado();
    const jobs = new JobManager({ lane: new HeavyLane(1), executor: ex.executor });
    const s = novaSessao({ jobs });
    // em sequência: a ordem de criação é a ordem da fila (FIFO)
    const a = await s.chamar('start_run', { config: COMPARE, budgetUsd: 1, idempotencyKey: 'a' });
    const b = await s.chamar('start_run', { config: COMPARE, budgetUsd: 1, idempotencyKey: 'b' });
    const c = await s.chamar('start_run', { config: COMPARE, budgetUsd: 1, idempotencyKey: 'c' });
    await ate(() => ex.inicios.length === 1, 1000, 'a começar');
    const sb = await s.chamar('run_status', { jobId: b.json?.jobId });
    const sc = await s.chamar('run_status', { jobId: c.json?.jobId });
    expect(sb.json).toMatchObject({ status: 'queued', queuePosition: 1 });
    expect(sc.json).toMatchObject({ status: 'queued', queuePosition: 2 });
    // chamada leve continua livre com a fila cheia
    const leve = await s.chamar('run_status', { jobId: a.json?.jobId });
    expect(leve.ms).toBeLessThan(200);
    expect(leve.json?.status).toBe('working');

    const cb = await s.chamar('cancel_run', { jobId: b.json?.jobId, waitSeconds: 2 });
    expect(cb.json).toMatchObject({ status: 'cancelled' });
    expect(String(cb.json?.statusMessage)).toMatch(/nada foi gasto/u);
    ex.soltar.get(ex.inicios[0])!();
    await ate(() => ex.inicios.length === 2, 2000, 'c começar');
    expect(ex.inicios).toEqual([a.json?.runId, c.json?.runId]); // b nunca começou
    ex.soltar.get(ex.inicios[1])!();
    const fimC = await s.chamar('run_status', { jobId: c.json?.jobId, waitSeconds: 2 });
    expect(fimC.json?.status).toBe('completed');
    // cancelar job terminal é idempotente (nada muda)
    const de_novo = await s.chamar('cancel_run', { jobId: c.json?.jobId, waitSeconds: 0 });
    expect(de_novo.json?.status).toBe('completed');
  });

  it('run_status/cancel_run: id inválido → erro sem eco; id desconhecido → "não encontrado"', async () => {
    const s = novaSessao({ jobs: new JobManager({ lane: new HeavyLane(1), executor: executorControlado().executor }) });
    for (const tool of ['run_status', 'cancel_run']) {
      const mal = await s.chamar(tool, { jobId: '../../etc/passwd' });
      expect(mal.result.isError).toBe(true);
      expect(mal.result.content?.[0].text).not.toContain('passwd');
      const nada = await s.chamar(tool, { jobId: '3f1b8a52-9d7e-4c1a-8f00-000000000000' });
      expect(nada.result.isError).toBe(true);
      expect(nada.result.content?.[0].text).toMatch(/não encontrado/u);
    }
  });

  it('plano B — TTL: job que passa do prazo é CANCELADO (parcial) mesmo sem cancel do cliente', async () => {
    const ex = executorControlado();
    const jobs = new JobManager({ lane: new HeavyLane(1), executor: ex.executor, watchIntervalMs: 20 });
    const { job } = await jobs.start(entrada(), KEY, { tool: 'start_run', ttlMs: 150 });
    const fim = await jobs.wait(job.jobId, 3_000);
    expect(fim).toMatchObject({ status: 'cancelled', result: { status: 'aborted', stoppedReason: 'cancelled' } });
    expect(String(fim?.statusMessage)).toMatch(/ttl/u);
    expect(ex.sinais.get(ex.inicios[0])!.aborted).toBe(true);
  });

  it('plano B — cancelamento vindo de OUTRO processo (marcador em disco) para o job em ≤ 2 s', async () => {
    const ex = executorControlado();
    const dono = new JobManager({ lane: new HeavyLane(1), executor: ex.executor, watchIntervalMs: 50 });
    const outro = new JobManager({ lane: new HeavyLane(1), executor: executorControlado().executor });
    const { job } = await dono.start(entrada(), KEY, { tool: 'start_run', idempotencyKey: 'remoto' });
    await ate(() => ex.inicios.length === 1, 1000, 'job começar');
    const t0 = performance.now();
    const pedido = await outro.cancel(job.jobId, 'runs cancel');
    expect(pedido?.statusMessage).toMatch(/processo dono/u);
    const fim = await outro.wait(job.jobId, 2_000);
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(fim?.status).toBe('cancelled');
    expect(ex.sinais.get(ex.inicios[0])!.aborted).toBe(true);
    expect(existsSync(path.join(getDataDir(), 'jobs', `${job.jobId}.cancel`))).toBe(false);
  });

  it('plano B — órfão: dono morto → job "failed/orphaned" e a run "running" vira "aborted" legível', async () => {
    const morto = spawnSync(process.execPath, ['-e', '']).pid!;
    const runId = '7d0c1c7e-0000-4000-8000-00000000abcd';
    const jobId = '7d0c1c7e-0000-4000-8000-00000000j0b1';
    await saveRun({
      id: runId,
      status: 'running',
      config: COMPARE as unknown as RunConfig,
      mode: 'compare',
      contestants: [],
      stages: [],
      scoreboard: {},
      totalCostUsd: 0.02,
      startedAt: new Date().toISOString(),
    } as RunRecord);
    const agora = new Date().toISOString();
    const rec: JobRecord = {
      id: jobId,
      kind: 'benchmark',
      tool: 'start_run',
      status: 'working',
      createdAt: agora,
      lastUpdatedAt: agora,
      ttlMs: DEFAULT_JOB_TTL_MS,
      pollIntervalMs: 5000,
      budgetUsd: 1,
      runId,
      fingerprint: 'f',
      ownerPid: morto,
      ownerHost: os.hostname(),
      heartbeatAt: agora,
    };
    await writePrivateDataFile(path.join(getDataDir(), 'jobs', `${jobId}.json`), JSON.stringify(rec));
    const s = novaSessao();
    const st = await s.chamar('run_status', { jobId });
    expect(st.json).toMatchObject({ status: 'failed', failure: 'orphaned', runId });
    expect((await loadRun(runId))?.status).toBe('aborted');
    const lido = await callTool('get_result', { id: runId });
    expect((lido as ToolText).isError).toBeUndefined();
  });

  it('retenção: job terminal velho sai do disco (e libera a chave); job recente fica', async () => {
    const ex = executorControlado();
    const jobs = new JobManager({ lane: new HeavyLane(1), executor: ex.executor });
    const { job } = await jobs.start(entrada(), KEY, { tool: 'start_run', idempotencyKey: 'velha' });
    await ate(() => ex.inicios.length === 1, 1000, 'começar');
    ex.soltar.get(ex.inicios[0])!();
    await jobs.wait(job.jobId, 2_000);
    expect(await jobs.sweepExpired(Date.now())).toBe(0); // recente: fica
    expect(await jobs.sweepExpired(Date.now() + 25 * 3_600_000)).toBe(1);
    expect(arquivosDeJob()).toEqual({ jobs: [], keys: [] });
    expect(await jobs.status(job.jobId)).toBeNull();
    const nova = await jobs.start(entrada(), KEY, { tool: 'start_run', idempotencyKey: 'velha' });
    expect(nova.created).toBe(true);
    expect(nova.job.jobId).not.toBe(job.jobId);
    await ate(() => ex.inicios.length === 2, 1000, 'nova começar');
    ex.soltar.get(ex.inicios[1])!();
  });

  it('batimento: o dono regrava heartbeatAt de um job ativo sem mexer em lastUpdatedAt', async () => {
    const ex = executorControlado();
    const jobs = new JobManager({ lane: new HeavyLane(1), executor: ex.executor, watchIntervalMs: 20, heartbeatMs: 40 });
    const { job } = await jobs.start(entrada(), KEY, { tool: 'start_run' });
    await ate(() => ex.inicios.length === 1, 1000, 'começar');
    const ler = (): JobRecord =>
      JSON.parse(readFileSync(path.join(getDataDir(), 'jobs', `${job.jobId}.json`), 'utf-8')) as JobRecord;
    await dormir(60);
    const antes = ler();
    await ate(() => ler().heartbeatAt > antes.heartbeatAt, 2_000, 'batimento avançar');
    expect(ler().lastUpdatedAt).toBe(antes.lastUpdatedAt);
    ex.soltar.get(ex.inicios[0])!();
    await jobs.wait(job.jobId, 2_000);
  });
});

// ---------------------------------------------------------------------------
// Extensão Tasks: só com a extensão declarada
// ---------------------------------------------------------------------------

describe('IMPL-026 — extensão Tasks (io.modelcontextprotocol/tasks)', () => {
  beforeEach(() => {
    dirNovo();
  });

  it('(iii) NEGATIVO: sem a extensão declarada, nenhuma task — CallToolResult; tasks/* → -32021', async () => {
    const ex = executorControlado();
    const s = novaSessao({ jobs: new JobManager({ lane: new HeavyLane(1), executor: ex.executor }), blockingWaitMs: 100 });
    s.enviar({ id: 'i', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    const init = (await s.aguardar('i')).result as { capabilities: Record<string, unknown> };
    expect(init.capabilities).toEqual({ tools: {} });

    // _meta sem a extensão (ou com ela como não-objeto) não conta
    for (const meta of [undefined, { 'io.modelcontextprotocol/clientCapabilities': { extensions: { [TASKS_EXTENSION]: true } } }]) {
      const r = await s.chamar('run_benchmark', { config: COMPARE, budgetUsd: 1 }, { meta });
      expect(r.result.resultType).toBeUndefined();
      expect(r.result.content?.[0].type).toBe('text');
      expect(r.json).toMatchObject({ status: expect.stringMatching(/queued|working/u), jobId: expect.any(String) });
      await s.chamar('cancel_run', { jobId: r.json?.jobId });
    }
    for (const method of ['tasks/get', 'tasks/cancel', 'tasks/update']) {
      s.enviar({ id: method, method, params: { taskId: 'qualquer' } });
      const e = (await s.aguardar(method)).error as { code: number; message: string; data?: unknown };
      expect(e.code).toBe(MISSING_CAPABILITY);
      expect(e.data).toEqual({ requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } });
    }
  });

  it('(iii) POSITIVO por requisição (_meta): CreateTaskResult durável, tasks/get até completed com o resultado', async () => {
    const ex = executorControlado();
    const s = novaSessao({ jobs: new JobManager({ lane: new HeavyLane(1), executor: ex.executor }) });
    const r = await s.chamar('run_benchmark', { config: COMPARE, budgetUsd: 1 }, { meta: TASKS_META });
    const task = r.msg.result as Record<string, unknown>;
    expect(r.ms).toBeLessThan(500);
    expect(task).toMatchObject({
      resultType: 'task',
      taskId: expect.any(String),
      status: 'working',
      ttlMs: DEFAULT_JOB_TTL_MS,
      pollIntervalMs: 5000,
      createdAt: expect.any(String),
      lastUpdatedAt: expect.any(String),
    });
    expect(task.content).toBeUndefined();
    // "durably created": tasks/get resolve na hora
    s.enviar({ id: 'g1', method: 'tasks/get', params: { taskId: task.taskId, _meta: TASKS_META } });
    expect((await s.aguardar('g1')).result).toMatchObject({ resultType: 'complete', taskId: task.taskId, status: 'working' });

    await ate(() => ex.inicios.length === 1, 1000, 'começar');
    ex.soltar.get(ex.inicios[0])!();
    await dormir(50);
    s.enviar({ id: 'g2', method: 'tasks/get', params: { taskId: task.taskId, _meta: TASKS_META } });
    const fim = (await s.aguardar('g2')).result as { status: string; result: ToolText };
    expect(fim.status).toBe('completed');
    expect(fim.result.isError).toBe(false);
    expect(JSON.parse(fim.result.content![0].text)).toMatchObject({ status: 'finished' });

    // tasks/cancel: reconhecido; o estado vira cancelled
    const r2 = await s.chamar('train_prompt', { config: TRAINING, budgetUsd: 1 }, { meta: TASKS_META });
    const t2 = (r2.msg.result as { taskId: string }).taskId;
    s.enviar({ id: 'c', method: 'tasks/cancel', params: { taskId: t2, _meta: TASKS_META } });
    expect((await s.aguardar('c')).result).toEqual({ resultType: 'complete' });
    await dormir(50);
    s.enviar({ id: 'g3', method: 'tasks/get', params: { taskId: t2, _meta: TASKS_META } });
    const cancelada = (await s.aguardar('g3')).result as { status: string; result?: unknown };
    expect(cancelada.status).toBe('cancelled');
    expect(cancelada.result).toBeUndefined();

    s.enviar({ id: 'g4', method: 'tasks/get', params: { taskId: '3f1b8a52-9d7e-4c1a-8f00-000000000000', _meta: TASKS_META } });
    expect(((await s.aguardar('g4')).error as { code: number }).code).toBe(-32602);
    s.enviar({ id: 'u', method: 'tasks/update', params: { taskId: t2, _meta: TASKS_META } });
    expect(((await s.aguardar('u')).error as { code: number }).code).toBe(-32602);
    // start_run NUNCA vira task (o próprio resultado já é o handle do job)
    const sr = await s.chamar('start_run', { config: COMPARE, budgetUsd: 1, idempotencyKey: 'x' }, { meta: TASKS_META });
    expect(sr.result.resultType).toBeUndefined();
    await s.chamar('cancel_run', { jobId: sr.json?.jobId });
  });

  it('(iii) declaração no initialize (sessão legacy): anuncia a extensão e devolve task sem _meta', async () => {
    const ex = executorControlado();
    const s = novaSessao({ jobs: new JobManager({ lane: new HeavyLane(1), executor: ex.executor }) });
    s.enviar({
      id: 'i',
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: { extensions: { [TASKS_EXTENSION]: {} } } },
    });
    const init = (await s.aguardar('i')).result as { capabilities: Record<string, unknown> };
    expect(init.capabilities).toEqual({ tools: {}, extensions: { [TASKS_EXTENSION]: {} } });
    const r = await s.chamar('run_benchmark', { config: COMPARE, budgetUsd: 1 });
    expect((r.msg.result as { resultType: string }).resultType).toBe('task');
    s.enviar({ id: 'c', method: 'tasks/cancel', params: { taskId: (r.msg.result as { taskId: string }).taskId } });
    expect((await s.aguardar('c')).result).toEqual({ resultType: 'complete' });
  });
});

// ---------------------------------------------------------------------------
// Motor REAL (transporte falso em processo)
// ---------------------------------------------------------------------------

describe('IMPL-026 — start_run/run_status/cancel_run com o motor real', () => {
  beforeEach(() => {
    dirNovo();
  });

  async function comGateway<T>(fetch: FetchLike, fn: () => Promise<T>): Promise<T> {
    const anterior: OpenRouterGateway = setDefaultGateway(createGateway({ fetch, sleep: noSleep }));
    try {
      return await fn();
    } finally {
      setDefaultGateway(anterior);
    }
  }

  it('(i) start_run devolve o id em < 500 ms para 8 cenários (catálogo lento de 1,5 s fora do caminho) e a run completa', async () => {
    const fake = fakeDoPipeline(cenarios(8));
    const lento: FetchLike = async (url, init) => {
      if (url.endsWith('/models')) await dormir(1_500);
      return fake.fetch(url, init);
    };
    await comGateway(lento, async () => {
      const s = novaSessao();
      const cfg = { ...COMPARE, stages: 8 };
      const r = await s.chamar('start_run', { config: cfg, budgetUsd: 5, idempotencyKey: 'oito' });
      expect(r.result.isError).toBeUndefined();
      expect(r.ms).toBeLessThan(500);
      expect(r.json).toMatchObject({
        created: true,
        jobId: expect.any(String),
        runId: expect.any(String),
        kind: 'benchmark',
        status: expect.stringMatching(/queued|working/u),
        pollIntervalMs: 5000,
      });
      expect(fake.chatRequests()).toHaveLength(0); // nada foi gasto antes da resposta

      let st: Record<string, unknown> | undefined;
      for (let i = 0; i < 20 && st?.status !== 'completed'; i++) {
        st = (await s.chamar('run_status', { jobId: r.json?.jobId, waitSeconds: 2 }, { maxMs: 5_000 })).json;
      }
      expect(st).toMatchObject({ status: 'completed', runId: r.json?.runId, result: { status: 'finished' } });
      const rec = await loadRun(String(r.json?.runId));
      expect(rec?.stages).toHaveLength(8);
      expect(rec?.status).toBe('finished');
      expect(rec?.totalCostUsd).toBeCloseTo(fake.billedUsd(), 10);
    });
  }, 20_000);

  it('(ii) 20 retries concorrentes com a mesma chave no motor real → 1 run (1 datagen, 1 record)', async () => {
    const fake = fakeDoPipeline();
    await comGateway(fake.fetch, async () => {
      const s = novaSessao();
      const antes = (await listRuns()).length;
      const rs = await Promise.all(
        Array.from({ length: 20 }, () => s.chamar('start_run', { config: COMPARE, budgetUsd: 5, idempotencyKey: 'real' })),
      );
      expect(new Set(rs.map((x) => x.json?.jobId)).size).toBe(1);
      const jobId = rs[0].json?.jobId;
      let st: Record<string, unknown> | undefined;
      for (let i = 0; i < 20 && st?.status !== 'completed'; i++) {
        st = (await s.chamar('run_status', { jobId, waitSeconds: 2 })).json;
      }
      expect(st?.status).toBe('completed');
      expect(fake.chatRequests().filter((q) => q.model === 'fake/gen')).toHaveLength(1);
      expect((await listRuns()).length - antes).toBe(1);
    });
  }, 20_000);

  // (iv) em TODOS os pontos de corte: 100% dos cancels com parcial legível.
  it.each<Papel>(['datagen', 'gabarito', 'competitor', 'judge', 'duel'])(
    '(iv) cancel_run durante %s: 0 chamada paga nova em < 2 s, run aborted/cancelled legível',
    async (papel) => {
      const fake = fakeDoPipeline();
      const t = transporte(fake, papel);
      await comGateway(t.fetch, async () => {
        const s = novaSessao();
        const r = await s.chamar('start_run', { config: COMPARE, budgetUsd: 5, idempotencyKey: `corte-${papel}` });
        await Promise.race([
          t.alvoChegou,
          dormir(8_000).then(() => Promise.reject(new Error(`${papel} nunca foi chamado`))),
        ]);
        const pagasAntes = fake.billedCalls();
        t.marcarCancel();
        const c = await s.chamar('cancel_run', { jobId: r.json?.jobId, waitSeconds: 5 });
        expect(c.ms).toBeLessThan(2_000);
        expect(c.json).toMatchObject({ status: 'cancelled', result: { status: 'aborted', stoppedReason: 'cancelled' } });
        await dormir(50);
        expect(t.pagasDepoisDoCancel()).toBe(0);
        expect(fake.billedCalls()).toBe(pagasAntes);

        const rec = await loadRun(String(r.json?.runId));
        expect(rec?.status).toBe('aborted');
        expect(rec?.stoppedReason).toBe('cancelled');
        expect(rec?.stages).toHaveLength(2);
        const byRole = rec!.costByRole!;
        // IMPL-017: abortada em voo sem id = gasto CONSERVADOR; o medido bate com a fatura.
        const lg = rec!.costLedger ?? { conservativeUsd: 0, conservativeCalls: 0 };
        expect(COST_ROLES.reduce((acc, role) => acc + byRole[role].calls, 0) - lg.conservativeCalls).toBe(fake.billedCalls());
        expect(rec!.totalCostUsd - lg.conservativeUsd).toBeCloseTo(fake.billedUsd(), 10);
        const lido = (await callTool('get_result', { id: rec!.id })) as ToolText;
        expect(lido.isError).toBeUndefined();
        expect((JSON.parse(lido.content![0].text) as RunRecord).status).toBe('aborted');
      });
    },
    15_000,
  );

  it('(iv) cancel_run de job NA FILA: nunca começa, nada gasto; o que roda segue até o seu cancel', async () => {
    const fake = fakeDoPipeline();
    const t = transporte(fake, 'competitor');
    await comGateway(t.fetch, async () => {
      const s = novaSessao();
      const a = await s.chamar('start_run', { config: COMPARE, budgetUsd: 5, idempotencyKey: 'fila-a' });
      const b = await s.chamar('start_run', { config: COMPARE, budgetUsd: 5, idempotencyKey: 'fila-b' });
      expect(b.json?.status).toBe('queued');
      await t.alvoChegou;
      const cb = await s.chamar('cancel_run', { jobId: b.json?.jobId });
      expect(cb.json).toMatchObject({ status: 'cancelled' });
      expect(await loadRun(String(b.json?.runId))).toBeNull(); // nunca existiu
      t.marcarCancel();
      const ca = await s.chamar('cancel_run', { jobId: a.json?.jobId });
      expect(ca.json?.status).toBe('cancelled');
      expect(t.pagasDepoisDoCancel()).toBe(0);
      expect((await loadRun(String(a.json?.runId)))?.stoppedReason).toBe('cancelled');
    });
  }, 15_000);

  it('(iv) cancel_run de treino: sessão e run filha aborted/cancelled, 0 chamada paga nova', async () => {
    const fake = fakeDoPipeline();
    const t = transporte(fake, 'competitor');
    await comGateway(t.fetch, async () => {
      const antes = new Set((await listSessions()).map((x) => x.id));
      const s = novaSessao();
      const r = await s.chamar('start_run', { config: TRAINING, budgetUsd: 5, idempotencyKey: 'treino' });
      expect(r.json?.kind).toBe('training');
      await Promise.race([t.alvoChegou, dormir(8_000).then(() => Promise.reject(new Error('sem competidor')))]);
      const pagasAntes = fake.billedCalls();
      t.marcarCancel();
      const c = await s.chamar('cancel_run', { jobId: r.json?.jobId });
      expect(c.ms).toBeLessThan(2_000);
      expect(c.json).toMatchObject({ status: 'cancelled', sessionId: expect.any(String) });
      expect(t.pagasDepoisDoCancel()).toBe(0);
      expect(fake.billedCalls()).toBe(pagasAntes);
      const nova = (await listSessions()).find((x) => !antes.has(x.id));
      expect(nova?.id).toBe(c.json?.sessionId);
      const sessao = await loadSession(nova!.id);
      expect(sessao).toMatchObject({ status: 'aborted', stoppedReason: 'cancelled' });
      expect((await loadRun(sessao!.runIds[0]))?.stoppedReason).toBe('cancelled');
    });
  }, 15_000);

  it('tools longas: devolvem o jobId dentro do teto (sem segurar o tools/call) e o retry com a chave reencontra o job', async () => {
    const fake = fakeDoPipeline();
    const t = transporte(fake, 'competitor');
    await comGateway(t.fetch, async () => {
      const s = novaSessao({ blockingWaitMs: 300 });
      const r = await s.chamar('run_benchmark', { config: COMPARE, budgetUsd: 5, idempotencyKey: 'longa' });
      expect(r.ms).toBeLessThan(1_500);
      expect(r.json).toMatchObject({ status: expect.stringMatching(/queued|working/u), jobId: expect.any(String) });
      expect(String(r.json?.next)).toMatch(/run_status/u);
      // retry (depois de um "timeout" do cliente) com a mesma chave: MESMO job
      const retry = await s.chamar('start_run', { config: COMPARE, budgetUsd: 5, idempotencyKey: 'longa' });
      expect(retry.json).toMatchObject({ jobId: r.json?.jobId, created: false });
      t.marcarCancel();
      const c = await s.chamar('cancel_run', { jobId: r.json?.jobId });
      expect(c.json?.status).toBe('cancelled');
      expect(t.pagasDepoisDoCancel()).toBe(0);
    });
  }, 15_000);

  it('o teto da espera bloqueante é aplicado mesmo se configurado acima de 25 s', async () => {
    let visto = -1;
    const espia: McpTool = {
      name: 'espia',
      description: 't',
      inputSchema: { type: 'object' },
      noKey: true,
      run: async (_a, _k, ctx) => {
        visto = ctx.blockingWaitMs;
        return {};
      },
    };
    await callTool('espia', {}, undefined, { tools: [espia], blockingWaitMs: 120_000 });
    expect(visto).toBe(BLOCKING_TOOL_LIMIT_MS);
    await callTool('espia', {}, undefined, { tools: [espia] });
    expect(visto).toBe(BLOCKING_TOOL_LIMIT_MS);
  });
});

// ---------------------------------------------------------------------------
// Processos REAIS: dois `prompt-builder mcp` sobre o mesmo data dir
// ---------------------------------------------------------------------------

describe('IMPL-026 — processos reais (stdio): start_run, idempotência e cancel entre processos', () => {
  it('start_run < 500 ms; o 2º processo reencontra o job pela chave, vê o status e o cancela; 0 chamada paga depois', async () => {
    const or = await openRouterHttp({ stages: cenarios(8) });
    const dir = mkdtempSync(path.join(raizTmp, 'proc-'));
    const p1 = processoMcp(dir, or.baseUrl);
    const p2 = processoMcp(dir, or.baseUrl);
    try {
      p1.enviar({ id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
      p2.enviar({ id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
      await p1.aguardar(0, 15_000);
      await p2.aguardar(0, 15_000);
      const args = { config: { ...COMPARE, stages: 8 }, budgetUsd: 5, idempotencyKey: 'entre-processos' };

      const t0 = p1.enviar({ id: 's1', method: 'tools/call', params: { name: 'start_run', arguments: args } });
      const r1 = await p1.aguardar('s1');
      expect(r1.t - t0).toBeLessThan(500);
      const j1 = JSON.parse((r1.msg.result as ToolText).content![0].text) as JobView & { created: boolean };
      expect(j1).toMatchObject({ created: true, jobId: expect.any(String) });

      // retry pelo OUTRO processo (cliente reiniciou): mesmo job, nada novo
      p2.enviar({ id: 's2', method: 'tools/call', params: { name: 'start_run', arguments: args } });
      const j2 = JSON.parse(((await p2.aguardar('s2')).msg.result as ToolText).content![0].text) as JobView & {
        created: boolean;
      };
      expect(j2).toMatchObject({ created: false, jobId: j1.jobId, runId: j1.runId });

      await Promise.race([
        or.competidorChegou,
        dormir(10_000).then(() => Promise.reject(new Error(`competidor nunca chamado\n${p1.stderr()}`))),
      ]);
      p2.enviar({ id: 'st', method: 'tools/call', params: { name: 'run_status', arguments: { jobId: j1.jobId } } });
      const st = JSON.parse(((await p2.aguardar('st')).msg.result as ToolText).content![0].text) as JobView;
      expect(st.status).toBe('working');
      expect(st.progress?.stagesPlanned).toBe(8);

      // cancel_run pelo processo 2 → marcador → o dono (processo 1) aborta
      const cancelAt = Date.now();
      p2.enviar({ id: 'c', method: 'tools/call', params: { name: 'cancel_run', arguments: { jobId: j1.jobId } } });
      const c = JSON.parse(((await p2.aguardar('c', 15_000)).msg.result as ToolText).content![0].text) as JobView;
      expect(c.status).toBe('cancelled');
      expect(Date.now() - cancelAt).toBeLessThan(2_000);
      await dormir(300);
      expect(or.chegadas.filter((x) => x.t > cancelAt + 750)).toEqual([]);
      const competidores = or.chegadas.filter((x) => x.papel === 'competitor');
      expect(competidores.every((x) => x.abortada && !x.servida)).toBe(true);

      const recs = recordsDoDisco(dir);
      expect(recs).toHaveLength(1); // UMA run, apesar dos dois processos
      expect(recs[0]).toMatchObject({ id: j1.runId, status: 'aborted', stoppedReason: 'cancelled' });
      expect(recs[0].totalCostUsd).toBeCloseTo(or.fake.billedUsd(), 10);

      p1.child.stdin.end();
      p2.child.stdin.end();
      expect((await p1.saiu).code).toBe(0);
      expect((await p2.saiu).code).toBe(0);
    } finally {
      p1.child.kill('SIGKILL');
      p2.child.kill('SIGKILL');
      await or.close();
    }
  }, 40_000);
});
