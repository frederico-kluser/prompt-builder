// Testes de CONTRATO do proxy de CUSTO do modo agente (IMPL-035 / R-14b REC-2,
// DEC-4, DEC-5): "custo MEDIDO no último chunk SSE, pelo mesmo ledger, e freio
// ANTES da chamada seguinte".
//
// Camadas (nunca o OpenRouter real — upstream FALSO no loopback, SSE sintético):
//   1. Puras: freio (`fitsBudget`), projeção, leitor incremental de usage (SSE
//      cortado em qualquer fronteira, comentários, keep-alive depois do usage,
//      JSON, comprimido), resumo do log e fidelidade medido × cobrado.
//   2. Proxy real + medidor: custo registrado == `usage.cost` do último chunk
//      (ledger, execução e log); orçamento US$ 0,10 com chamadas de US$ 0,04 ⇒ a
//      3ª é recusada ANTES do provedor (escopo execução E run); estouro ≤ 1
//      chamada média por execução em voo; stream abortado = custo `unknown`
//      (nunca zero) contado pelo freio; erro do provedor não cobra; limitador
//      AIMD global das chamadas do agente; overhead p50 ≤ 50 ms e TTFT ≤ 5% em
//      50 chamadas de 1.000 chunks.
//   3. Executor: a recusa vira `stopReason: 'maxCost'` NA HORA (agente mudo em
//      backoff é morto pelo gatilho externo do spawn), sem `infraError`; o custo
//      da execução passa a ser o medido.
//   4. `runAgentStage`: escopo RUN sobe `BudgetExceeded` (controle); escopo
//      execução = 'maxCost' fora do placar; o ledger anota POR CHAMADA (sem
//      dobrar); executor fora do proxy cai no derivado, como antes.
//   5. `pi` REAL no host (se instalado) e Docker real (se a imagem existir).

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BudgetLedger, isBudgetSignal, isControlSignal } from '../src/budget.js';
import { AimdLimiter, createGateway, setDefaultGateway } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import {
  acquireRunCostMeter,
  applyMeasuredCost,
  BUDGET_EXHAUSTED_CODE,
  costFidelity,
  createRunCostMeter,
  createUsageTap,
  fetchGenerationCost,
  fitsBudget,
  openRunCostMeters,
  projectCallCost,
  reconcileGenerations,
  summarizeProxyCostLog,
  usageFromRaw,
  type RunCostMeter,
} from '../src/agent/costProxy.js';
import { startInferenceProxy, type InferenceProxy } from '../src/agent/inferenceProxy.js';
import { spawnAgent } from '../src/agent/spawn.js';
import { CLEAN_PATH, costBrakeHint, piExecutor, type PiRunOptions, type PiRunOutcome } from '../src/agent/pi.js';
import type { AgentRunOpts, AgentRunOutcome } from '../src/agent/executor.js';
import { runAgentStage, type AgentGateway, type RunAgentStageParams } from '../src/agent/runAgentStage.js';
import type { AgentTrajectory, ExecutionRecord } from '../src/agent/types.js';
import { UNSAFE_NETWORK_ENV } from '../src/agent/container.js';
import { manyChunks, startFakeUpstream, type FakeReply, type FakeUpstream } from './fakeInferenceUpstream.js';

const KEY = 'sk-or-v1-CHAVE-REAL-FALSA-impl035-0123456789abcdef';

// ----------------------------------------------------------------------------
// Infra de teste
// ----------------------------------------------------------------------------

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of closers.reverse()) await c().catch(() => undefined);
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

async function upstream(script?: Parameters<typeof startFakeUpstream>[0]): Promise<FakeUpstream> {
  const up = await startFakeUpstream(script);
  closers.push(() => up.close());
  return up;
}

/** Proxy de inferência real com o medidor de custo pendurado (limitador desligado por default). */
async function metered(
  up: FakeUpstream,
  meterOpts: Parameters<typeof createRunCostMeter>[0] = {},
): Promise<{ meter: RunCostMeter; proxy: InferenceProxy; logFile: string }> {
  const meter = createRunCostMeter({ limiter: null, ...meterOpts });
  const logFile = path.join(mkTmp('pb035-log-'), 'inference-proxy.jsonl');
  const proxy = await startInferenceProxy({
    apiKey: KEY,
    upstreamBaseUrl: up.baseUrl,
    listen: { tcp: true },
    logFile,
    hooks: meter.hooks,
  });
  closers.push(() => proxy.close());
  return { meter, proxy, logFile };
}

interface CallResult {
  status: number;
  body: string;
  ttftMs: number;
  totalMs: number;
}

/** Uma chamada de chat pelo `fetch` (content-length real, como o SDK do agente). */
async function chat(baseUrl: string, token: string | undefined, opts: { abortAfterFirstChunk?: boolean } = {}): Promise<CallResult> {
  const t0 = performance.now();
  const ac = new AbortController();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'oi' }], stream: true }),
    signal: ac.signal,
  });
  const reader = res.body?.getReader();
  let body = '';
  let ttftMs = -1;
  const dec = new TextDecoder();
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (ttftMs < 0) ttftMs = performance.now() - t0;
        body += dec.decode(value, { stream: true });
        if (opts.abortAfterFirstChunk) {
          ac.abort();
          break;
        }
      }
    } catch {
      /* abortado de propósito */
    }
  }
  return { status: res.status, body, ttftMs, totalMs: performance.now() - t0 };
}

const logEntries = (file: string): Array<Record<string, unknown>> =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

/** Espera o log conter `n` linhas `exchange` (a linha sai no fim da troca, fora do caminho do cliente). */
async function waitExchanges(file: string, n: number): Promise<Array<Record<string, unknown>>> {
  for (let i = 0; i < 200; i++) {
    const ex = logEntries(file).filter((e) => e.event === 'exchange');
    if (ex.length >= n) return ex;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`log sem ${n} trocas`);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

// ----------------------------------------------------------------------------
// 1. Puras
// ----------------------------------------------------------------------------

describe('proxy de custo — regras puras', () => {
  it('fitsBudget: recusa quando o teto já foi atingido OU quando a chamada o ultrapassaria', () => {
    expect(fitsBudget(0, 0.04, 0.1)).toBe(true);
    expect(fitsBudget(0.04, 0.04, 0.1)).toBe(true);
    expect(fitsBudget(0.08, 0.04, 0.1)).toBe(false); // a 3ª chamada de US$ 0,04 num teto de US$ 0,10
    expect(fitsBudget(0.05, 0.05, 0.1)).toBe(true); // exato cabe
    expect(fitsBudget(0.1, 0, 0.1)).toBe(false); // teto atingido: nem projeção zero passa
    expect(fitsBudget(0, 0, 0)).toBe(false); // teto zero = nada
    expect(fitsBudget(0.1 + 0.2, 0, 0.3000001)).toBe(true); // folga numérica
  });

  it('projeção: execução > run (mesmo modelo) > piso do catálogo; max(última, média) — contexto cresce', () => {
    const exec = { n: 2, sumUsd: 0.06, lastUsd: 0.04 };
    const run = { n: 5, sumUsd: 0.5, lastUsd: 0.2 };
    expect(projectCallCost(exec, run, 0.9)).toBeCloseTo(0.04); // max(0.04, 0.03)
    expect(projectCallCost({ n: 2, sumUsd: 0.1, lastUsd: 0.02 }, run, 0)).toBeCloseTo(0.05); // média > última
    expect(projectCallCost(undefined, run, 0.9)).toBeCloseTo(0.2);
    expect(projectCallCost({ n: 0, sumUsd: 0, lastUsd: 0 }, undefined, 0.003)).toBeCloseTo(0.003);
    expect(projectCallCost(undefined, undefined, 0)).toBe(0);
  });

  it('usage: formato OpenRouter (cost/upstream/detalhes) e Anthropic/Responses (input/output_tokens)', () => {
    expect(
      usageFromRaw({ prompt_tokens: 10, completion_tokens: 2, cost: 0.0123, cost_details: { upstream_inference_cost: 0.01 } }),
    ).toMatchObject({ tokensIn: 10, tokensOut: 2, cost: 0.0123, upstreamCost: 0.01 });
    expect(usageFromRaw({ input_tokens: 7, output_tokens: 3 })).toMatchObject({ tokensIn: 7, tokensOut: 3, cost: undefined });
    expect(usageFromRaw(null)).toBeUndefined();
  });

  it('tap SSE: lê o usage do ÚLTIMO chunk mesmo cortado em QUALQUER fronteira (byte a byte, UTF-8 multibyte)', () => {
    const base = { id: 'gen-ABCDEFGHIJKLMNOPQRSTUVWX', object: 'chat.completion.chunk', model: 'openai/gpt-4o-mini' };
    const stream = [
      ': OPENROUTER PROCESSING\n\n',
      sse({ ...base, choices: [{ index: 0, delta: { content: 'olá, ação — ✓ "usage" no texto' } }] }),
      sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      sse({ ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.0421 } }),
      ': keep-alive depois do usage\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const bytes = Buffer.from(stream, 'utf8');
    for (const step of [1, 3, 7, 64, bytes.length]) {
      const tap = createUsageTap({ 'content-type': 'text/event-stream' });
      for (let i = 0; i < bytes.length; i += step) tap.push(bytes.subarray(i, i + step));
      const r = tap.end();
      expect(r.format).toBe('sse');
      expect(r.usage?.cost).toBe(0.0421);
      expect(r.usage?.tokensIn).toBe(12);
      expect(r.generationId).toBe('gen-ABCDEFGHIJKLMNOPQRSTUVWX');
      expect(r.model).toBe('openai/gpt-4o-mini');
      expect(r.malformed).toBe(0);
    }
  });

  it('tap SSE: vale o ÚLTIMO bloco usage; linha ilegível conta, não derruba; sem usage ⇒ nada inventado', () => {
    const tap = createUsageTap({ 'content-type': 'text/event-stream; charset=utf-8' });
    tap.push(Buffer.from(sse({ id: 'gen-1', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.5 } })));
    tap.push(Buffer.from('data: {"usage": quebrado\n\n'));
    tap.push(Buffer.from(sse({ id: 'gen-1', choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, cost: 0.02 } })));
    const r = tap.end();
    expect(r.usage?.cost).toBe(0.02);
    expect(r.malformed).toBe(1);
    const vazio = createUsageTap({ 'content-type': 'text/event-stream' });
    vazio.push(Buffer.from(sse({ id: 'gen-2', choices: [{ delta: { content: 'x' } }] })));
    expect(vazio.end().usage).toBeUndefined();
  });

  it('tap JSON (sem stream) lê usage/id/model; comprimido é pulado com motivo (custo desconhecido, nunca zero)', () => {
    const tap = createUsageTap({ 'content-type': 'application/json' });
    const body = JSON.stringify({ id: 'gen-json', model: 'm/x', choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0.007 } });
    tap.push(Buffer.from(body.slice(0, 10)));
    tap.push(Buffer.from(body.slice(10)));
    expect(tap.end()).toMatchObject({ format: 'json', generationId: 'gen-json', model: 'm/x', usage: { cost: 0.007 } });
    const gz = createUsageTap({ 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
    gz.push(Buffer.from('lixo'));
    expect(gz.end()).toMatchObject({ skipped: 'content-encoding gzip' });
  });

  it('resumo do log e fidelidade medido × cobrado (≤ 2%)', () => {
    const lines = [
      { event: 'proxy.started' },
      { event: 'exchange', label: { execId: 'e1' }, cost: { usd: 0.04, source: 'usage', generationId: 'gen-a', tokensIn: 10, tokensOut: 2 } },
      { event: 'exchange', label: { execId: 'e1' }, cost: { usd: 0.04, source: 'usage', generationId: 'gen-b', tokensIn: 10, tokensOut: 2 } },
      { event: 'exchange', label: { execId: 'e1' }, rejected: BUDGET_EXHAUSTED_CODE, budget: { scope: 'execution' } },
      { event: 'exchange', label: { execId: 'e2' }, cost: { usd: 0, source: 'unknown', incomplete: true } },
      { event: 'exchange', label: { execId: 'e2' }, cost: { billed: false } },
      { event: 'exchange', label: {}, health: true },
    ];
    const s = summarizeProxyCostLog(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n{quebrada\n`);
    expect(s).toMatchObject({ usd: 0.08, calls: 3, exact: 2, unknown: 1, refused: 1, badLines: 1, generationIds: ['gen-a', 'gen-b'] });
    expect(s.byExec.e1).toMatchObject({ usd: 0.08, calls: 2, refused: 1 });
    expect(s.costByGenerationId).toEqual({ 'gen-a': 0.04, 'gen-b': 0.04 });
    expect(costFidelity(0.0201, 0.0201).withinTolerance).toBe(true);
    expect(costFidelity(0.0204, 0.02).withinTolerance).toBe(true); // 2,0%
    expect(costFidelity(0.0205, 0.02).withinTolerance).toBe(false); // 2,5%
    expect(costFidelity(0, 0).relative).toBe(0);
  });

  it('applyMeasuredCost: o medido substitui o derivado, que fica como auditoria; sem chamadas, nada muda', () => {
    const t = { usage: { tokensIn: 1, tokensOut: 1, tokensReasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.5, costSource: 'agent-derived' } } as AgentTrajectory;
    const m = { usd: 0.08, calls: 2, exact: 2, estimated: 0, unknown: 0, refused: 1, tokensIn: 0, tokensOut: 0, generationIds: [] };
    expect(applyMeasuredCost(t, m).usage).toMatchObject({ costUsd: 0.08, costSource: 'usage', agentDerivedCostUsd: 0.5 });
    expect(applyMeasuredCost(t, { ...m, exact: 1, unknown: 1 }).usage.costSource).toBe('catalog');
    expect(applyMeasuredCost(t, { ...m, calls: 0 })).toBe(t);
  });

  it('/generation: total_cost da fatura; 404 transitório com retry; key só no header', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    let n = 0;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
      n++;
      if (n === 1) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ data: { id: 'gen-x', total_cost: 0.0402 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const g = await fetchGenerationCost('gen-x', { baseUrl: 'https://or.test/api/v1/', apiKey: KEY, fetch: fakeFetch, sleep: async () => undefined });
    expect(g).toEqual({ id: 'gen-x', status: 'ok', totalCostUsd: 0.0402 });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://or.test/api/v1/generation?id=gen-x');
    expect(calls[0].auth).toBe(`Bearer ${KEY}`);
    const nunca = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    expect((await fetchGenerationCost('gen-y', { baseUrl: 'https://or.test/api/v1', apiKey: KEY, fetch: nunca, sleep: async () => undefined, attempts: 3 })).status).toBe(
      'not_found',
    );
  });
});

// ----------------------------------------------------------------------------
// 2. Proxy real + medidor (upstream falso)
// ----------------------------------------------------------------------------

describe('proxy de custo — custo MEDIDO == usage.cost do último chunk SSE', () => {
  it('ledger (papel agent, source usage), execução e log registram exatamente o usage.cost servido', async () => {
    const custos = [0.0123, 0.0456];
    const up = await upstream((_r, n) => ({ text: `r${n}`, cost: custos[n], id: `gen-impl035-${n}` }));
    const ledger = new BudgetLedger();
    const { meter, proxy, logFile } = await metered(up, { sink: ledger });
    const exec = meter.openExecution({ execId: 'e-med', modelId: 'openai/gpt-4o-mini', maxCostUsd: 1 });
    const token = proxy.issueCredential({ execId: 'e-med', contestantId: 'ag', role: 'agent' }).token;
    const r1 = await chat(proxy.tcpBaseUrl as string, token);
    const r2 = await chat(proxy.tcpBaseUrl as string, token);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(r1.body).toContain('"cost":0.0123'); // pass-through: o agente recebe o stream intacto
    await exec.settled();
    const esperado = custos[0] + custos[1];
    expect(ledger.byRole.agent.usd).toBeCloseTo(esperado, 12);
    expect(ledger.byRole.agent.calls).toBe(2);
    expect(ledger.accuracy).toEqual({ exact: 2, estimated: 0, unknown: 0 });
    expect(ledger.byRole.agent.tokensIn).toBe(24);
    expect(exec.measured()).toMatchObject({ usd: esperado, calls: 2, exact: 2, generationIds: ['gen-impl035-0', 'gen-impl035-1'] });
    expect(up.billedUsd()).toBeCloseTo(ledger.spentUsd, 12); // Σ usage.cost == "fatura" do fake
    const ex = await waitExchanges(logFile, 2);
    expect(ex.map((e) => (e.cost as { usd: number; source: string; generationId: string }))).toMatchObject([
      { usd: 0.0123, source: 'usage', generationId: 'gen-impl035-0' },
      { usd: 0.0456, source: 'usage', generationId: 'gen-impl035-1' },
    ]);
    expect(summarizeProxyCostLog(readFileSync(logFile, 'utf8')).usd).toBeCloseTo(esperado, 9);
    expect(readFileSync(logFile, 'utf8')).not.toContain(KEY);
  });

  it('stream com keep-alive DEPOIS do usage e 1.000 chunks: continua o último usage (não o último chunk cru)', async () => {
    const payload = manyChunks(1000, 0.0333, 'gen-burst');
    payload.splice(payload.length - 1, 0, ': keep-alive\n\n', ': keep-alive\n\n');
    const up = await upstream(() => ({ burst: payload, ttftMs: 0 }));
    const ledger = new BudgetLedger();
    const { meter, proxy } = await metered(up, { sink: ledger });
    const exec = meter.openExecution({ execId: 'e-burst', modelId: 'openai/gpt-4o-mini' });
    const r = await chat(proxy.tcpBaseUrl as string, proxy.issueCredential({ execId: 'e-burst' }).token);
    expect(r.status).toBe(200);
    await exec.settled();
    expect(ledger.byRole.agent.usd).toBe(0.0333);
    expect(exec.measured()).toMatchObject({ exact: 1, tokensOut: 1000, generationIds: ['gen-burst'] });
  });

  it('usage sem cost ⇒ catálogo (estimado); sem usage ⇒ unknown (NUNCA zero silencioso)', async () => {
    const base = { id: 'gen-sem-cost', model: 'openai/gpt-4o-mini', object: 'chat.completion.chunk' };
    const up = await upstream((_r, n) =>
      n === 0
        ? { rawChunks: [sse({ ...base, choices: [{ delta: { content: 'x' } }] }), sse({ ...base, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100 } }), 'data: [DONE]\n\n'], gapMs: 0 }
        : { rawChunks: [sse({ ...base, choices: [{ delta: { content: 'y' } }] }), 'data: [DONE]\n\n'], gapMs: 0 },
    );
    const ledger = new BudgetLedger();
    const catalog = [{ id: 'openai/gpt-4o-mini', name: 'mini', pricing: { prompt: 1e-6, completion: 2e-6 } }];
    const { meter, proxy } = await metered(up, { sink: ledger, catalog });
    const exec = meter.openExecution({ execId: 'e-cat', modelId: 'openai/gpt-4o-mini' });
    const token = proxy.issueCredential({ execId: 'e-cat' }).token;
    await chat(proxy.tcpBaseUrl as string, token);
    await chat(proxy.tcpBaseUrl as string, token);
    await exec.settled();
    expect(ledger.accuracy).toEqual({ exact: 0, estimated: 1, unknown: 1 });
    expect(ledger.byRole.agent.usd).toBeCloseTo(1000 * 1e-6 + 100 * 2e-6, 12);
    expect(exec.measured()).toMatchObject({ calls: 2, estimated: 1, unknown: 1 });
  });

  it('erro do provedor (não-2xx) não é cobrado: a reserva volta, nada é anotado', async () => {
    const up = await upstream(() => ({ status: 500, error: 'provedor caiu' }));
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    const { meter, proxy, logFile } = await metered(up, { sink: ledger });
    const exec = meter.openExecution({ execId: 'e-500', modelId: 'm/x' });
    const r = await chat(proxy.tcpBaseUrl as string, proxy.issueCredential({ execId: 'e-500' }).token);
    expect(r.status).toBe(500);
    await exec.settled();
    expect(ledger.byRole.agent.calls).toBe(0);
    expect(ledger.committedUsd).toBe(0);
    expect(exec.measured().calls).toBe(0);
    const [e] = await waitExchanges(logFile, 1);
    expect(e.cost).toMatchObject({ billed: false });
  });
});

describe('proxy de custo — freio ANTES da chamada seguinte (429 budget_exhausted)', () => {
  it('teto da EXECUÇÃO US$ 0,10, chamadas de US$ 0,04: a 3ª é recusada sem ir ao provedor (e as seguintes também)', async () => {
    const up = await upstream(() => ({ text: 'ok', cost: 0.04 }));
    const ledger = new BudgetLedger(); // run SEM teto: quem freia é a execução
    const { meter, proxy, logFile } = await metered(up, { sink: ledger });
    const exec = meter.openExecution({ execId: 'e-teto', modelId: 'openai/gpt-4o-mini', maxCostUsd: 0.1 });
    const paradas: string[] = [];
    exec.onStop((s) => paradas.push(s.scope));
    const token = proxy.issueCredential({ execId: 'e-teto' }).token;
    const url = proxy.tcpBaseUrl as string;
    const r = [await chat(url, token), await chat(url, token), await chat(url, token), await chat(url, token)];
    expect(r.map((x) => x.status)).toEqual([200, 200, 429, 429]);
    const erro = JSON.parse(r[2].body).error;
    expect(erro).toMatchObject({ code: 429, type: BUDGET_EXHAUSTED_CODE, metadata: { scope: 'execution', committedUsd: 0.08, projectedUsd: 0.04, limitUsd: 0.1 } });
    expect(erro.message).toMatch(/NÃO foi ao provedor/);
    expect(up.requests.filter((q) => q.url.endsWith('/chat/completions'))).toHaveLength(2); // a 3ª NUNCA chegou
    expect(ledger.spentUsd).toBeCloseTo(0.08, 12);
    expect(exec.stopped()).toMatchObject({ scope: 'execution', limitUsd: 0.1 });
    expect(paradas).toEqual(['execution']); // avisa UMA vez
    expect(exec.measured()).toMatchObject({ calls: 2, refused: 2 });
    const ex = await waitExchanges(logFile, 4);
    expect(ex.filter((e) => e.rejected === BUDGET_EXHAUSTED_CODE)).toHaveLength(2);
    expect(ex[2].budget).toMatchObject({ scope: 'execution' });
    expect(costBrakeHint(exec.stopped()!)).toMatch(/teto da execução.*recusada \(429 budget_exhausted\) ANTES/);
  });

  it('orçamento da RUN US$ 0,10 (ledger), chamadas de US$ 0,04: a 3ª é recusada ANTES do provedor com o BudgetExceeded do ledger', async () => {
    const up = await upstream(() => ({ text: 'ok', cost: 0.04 }));
    const ledger = new BudgetLedger({ budgetUsd: 0.1 });
    const { meter, proxy } = await metered(up, { sink: ledger });
    const exec = meter.openExecution({ execId: 'e-run', modelId: 'openai/gpt-4o-mini' }); // sem teto próprio
    const token = proxy.issueCredential({ execId: 'e-run' }).token;
    const url = proxy.tcpBaseUrl as string;
    const s = [(await chat(url, token)).status, (await chat(url, token)).status, (await chat(url, token)).status];
    expect(s).toEqual([200, 200, 429]);
    expect(up.requests).toHaveLength(2);
    expect(exec.stopped()).toMatchObject({ scope: 'run' });
    const sig = exec.budgetSignal();
    expect(isControlSignal(sig)).toBe(true);
    expect(isBudgetSignal(sig)).toBe(true);
    expect(ledger.spentUsd).toBeCloseTo(0.08, 12);
    expect(ledger.committedUsd).toBeCloseTo(0.08, 12); // nenhuma reserva órfã
  });

  it('ledger já estourado por OUTRO papel: a porta dura do ledger recusa a 1ª chamada do agente', async () => {
    const up = await upstream(() => ({ text: 'ok', cost: 0.04 }));
    const ledger = new BudgetLedger({ budgetUsd: 0.05 });
    // Juiz em voo com reserva maior que o saldo (committed > budget).
    ledger.committedUsd = 0.06;
    const { meter, proxy } = await metered(up, { sink: ledger });
    const exec = meter.openExecution({ execId: 'e-hard', modelId: 'm/x' });
    const r = await chat(proxy.tcpBaseUrl as string, proxy.issueCredential({ execId: 'e-hard' }).token);
    expect(r.status).toBe(429);
    expect(up.requests).toHaveLength(0);
    expect(isBudgetSignal(exec.budgetSignal())).toBe(true);
  });

  it('run cancelada: chamada nova é recusada (503 run_cancelled) sem ir ao provedor e sem virar maxCost', async () => {
    const up = await upstream();
    const ac = new AbortController();
    const { meter, proxy } = await metered(up, { sink: new BudgetLedger({ signal: ac.signal }), signal: ac.signal });
    const exec = meter.openExecution({ execId: 'e-cancel', modelId: 'm/x' });
    ac.abort('teste');
    const r = await chat(proxy.tcpBaseUrl as string, proxy.issueCredential({ execId: 'e-cancel' }).token);
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body).error.type).toBe('run_cancelled');
    expect(up.requests).toHaveLength(0);
    expect(exec.stopped()).toBeNull();
  });

  it('GET /models (público) não é medido nem freado', async () => {
    const up = await upstream(() => ({ text: 'ok', cost: 0.04 }));
    const { meter, proxy } = await metered(up, { sink: new BudgetLedger({ budgetUsd: 0 }) });
    meter.openExecution({ execId: 'e-models', modelId: 'm/x', maxCostUsd: 0 });
    const res = await fetch(`${proxy.tcpBaseUrl}/models`, { headers: { authorization: `Bearer ${proxy.issueCredential({ execId: 'e-models' }).token}` } });
    expect(res.status).toBe(200);
    await res.text();
  });

  it('1ª chamada sem medição: o piso do catálogo (content-length/4 × preço de entrada) já freia um teto minúsculo', async () => {
    const up = await upstream(() => ({ text: 'ok', cost: 0.04 }));
    const catalog = [{ id: 'caro/modelo', name: 'caro', pricing: { prompt: 1e-3, completion: 1e-3 } }];
    const { meter, proxy } = await metered(up, { catalog });
    const exec = meter.openExecution({ execId: 'e-piso', modelId: 'caro/modelo', maxCostUsd: 0.001 });
    const r = await chat(proxy.tcpBaseUrl as string, proxy.issueCredential({ execId: 'e-piso' }).token);
    expect(r.status).toBe(429);
    expect(up.requests).toHaveLength(0);
    expect(exec.stopped()?.projectedUsd).toBeGreaterThan(0.001);
  });

  it('stream abortado pelo agente: custo `unknown` (nunca zero) e o freio conta a projeção como sombra', async () => {
    const payload = manyChunks(50, 0.04, 'gen-abort');
    const up = await upstream((_r, n) => (n === 0 ? { text: 'primeira', cost: 0.04 } : { rawChunks: payload, gapMs: 20 }));
    const ledger = new BudgetLedger();
    const { meter, proxy } = await metered(up, { sink: ledger });
    const exec = meter.openExecution({ execId: 'e-abort', modelId: 'openai/gpt-4o-mini', maxCostUsd: 0.1 });
    const token = proxy.issueCredential({ execId: 'e-abort' }).token;
    const url = proxy.tcpBaseUrl as string;
    expect((await chat(url, token)).status).toBe(200); // medida: 0.04
    const cortada = await chat(url, token, { abortAfterFirstChunk: true });
    expect(cortada.status).toBe(200);
    await exec.settled();
    expect(ledger.accuracy).toMatchObject({ exact: 1, unknown: 1 });
    expect(exec.measured()).toMatchObject({ calls: 2, unknown: 1 });
    // 0.04 medido + 0.04 de sombra (a abortada PODE ter sido cobrada) + 0.04 projetado > 0.10.
    const terceira = await chat(url, token);
    expect(terceira.status).toBe(429);
    expect(JSON.parse(terceira.body).error.metadata.committedUsd).toBeCloseTo(0.08, 9);
  });
});

describe('proxy de custo — estouro ≤ 1 chamada média por execução em voo', () => {
  it('4 execuções em paralelo, custos variáveis, orçamento da run US$ 0,50: estouro ≤ 4 × média; ledger == fatura', async () => {
    // Custos determinísticos em [0,01; 0,05], com latência para as chamadas se sobreporem.
    const custo = (n: number): number => 0.01 + ((n * 37) % 41) / 1000;
    const up = await upstream((_r, n) => ({ text: 'x', cost: custo(n), delayMs: 5 + (n % 4) * 3 }));
    const orcamento = 0.5;
    const ledger = new BudgetLedger({ budgetUsd: orcamento });
    const { meter, proxy } = await metered(up, { sink: ledger });
    const url = proxy.tcpBaseUrl as string;
    const execs = ['a', 'b', 'c', 'd'].map((id) => ({
      meter: meter.openExecution({ execId: id, modelId: 'openai/gpt-4o-mini' }),
      token: proxy.issueCredential({ execId: id }).token,
    }));
    await Promise.all(
      execs.map(async (e) => {
        for (let i = 0; i < 100; i++) {
          const r = await chat(url, e.token);
          if (r.status === 429) break;
        }
      }),
    );
    for (const e of execs) await e.meter.settled();
    const chamadas = ledger.byRole.agent.calls;
    const media = ledger.spentUsd / chamadas;
    const estouro = Math.max(0, ledger.spentUsd - orcamento);
    console.error(
      `[IMPL-035] estouro com 4 execuções em voo: US$ ${estouro.toFixed(4)} (média/chamada US$ ${media.toFixed(4)}; ${chamadas} chamadas; gasto US$ ${ledger.spentUsd.toFixed(4)})`,
    );
    expect(estouro).toBeLessThanOrEqual(4 * media);
    expect(ledger.spentUsd).toBeGreaterThan(orcamento - 4 * 0.05); // não freou cedo demais
    expect(ledger.spentUsd).toBeCloseTo(up.billedUsd(), 9); // |Σ usage.cost − fatura| = 0
    expect(execs.every((e) => e.meter.stopped()?.scope === 'run')).toBe(true);
  }, 30_000);

  it('teto por execução: cada execução para com gasto ≤ maxCostUsd + 1 chamada média', async () => {
    const custo = (n: number): number => 0.01 + ((n * 13) % 29) / 1000;
    const up = await upstream((_r, n) => ({ text: 'x', cost: custo(n), delayMs: 2 }));
    const { meter, proxy } = await metered(up, { sink: new BudgetLedger() });
    const url = proxy.tcpBaseUrl as string;
    const teto = 0.12;
    const execs = ['p', 'q', 'r'].map((id) => ({
      meter: meter.openExecution({ execId: id, modelId: 'm/x', maxCostUsd: teto }),
      token: proxy.issueCredential({ execId: id }).token,
    }));
    await Promise.all(
      execs.map(async (e) => {
        for (let i = 0; i < 100; i++) if ((await chat(url, e.token)).status === 429) break;
      }),
    );
    for (const e of execs) {
      await e.meter.settled();
      const m = e.meter.measured();
      expect(m.usd).toBeLessThanOrEqual(teto + m.usd / m.calls);
      expect(e.meter.stopped()?.scope).toBe('execution');
    }
  }, 30_000);
});

describe('proxy de custo — fidelidade |Σ usage.cost − fatura| ≤ 2% por run (/generation falso)', () => {
  /** Uma "run" de 5 chamadas pelo proxy; devolve o resumo do log e o upstream (com a fatura). */
  async function runComFatura(invoice?: (id: string, served: number | undefined) => number | null) {
    const custos = [0.0101, 0.0234, 0.0042, 0.0377, 0.0199];
    const up = await startFakeUpstream((_r, n) => ({ text: `r${n}`, cost: custos[n % custos.length], id: `gen-fid-${n}` }), { invoice });
    closers.push(() => up.close());
    const ledger = new BudgetLedger();
    const { meter, proxy, logFile } = await metered(up, { sink: ledger });
    const exec = meter.openExecution({ execId: 'e-fid', modelId: 'openai/gpt-4o-mini' });
    const token = proxy.issueCredential({ execId: 'e-fid' }).token;
    for (let i = 0; i < custos.length; i++) expect((await chat(proxy.tcpBaseUrl as string, token)).status).toBe(200);
    await exec.settled();
    await waitExchanges(logFile, custos.length);
    const summary = summarizeProxyCostLog(readFileSync(logFile, 'utf8'));
    return { up, ledger, summary, esperado: custos.reduce((a, b) => a + b, 0) };
  }

  it('fatura == Σ usage.cost servido: reconciliada, id a id, dentro de 2%', async () => {
    const { up, ledger, summary, esperado } = await runComFatura();
    expect(summary.usd).toBeCloseTo(esperado, 9);
    expect(ledger.spentUsd).toBeCloseTo(esperado, 12); // o ledger é o mesmo número do log
    const rec = await reconcileGenerations(summary, { baseUrl: up.baseUrl, apiKey: KEY, sleep: async () => undefined });
    expect(rec).toMatchObject({ found: 5, notFound: 0, errors: 0, complete: true });
    expect(rec.billedUsd).toBeCloseTo(esperado, 9);
    expect(rec.fidelity.withinTolerance).toBe(true);
    expect(rec.fidelity.relative).toBeLessThanOrEqual(0.02);
    // a auditoria é GET /generation (não é chamada de LLM): nenhum chat a mais no provedor
    expect(up.requests.filter((q) => q.url.endsWith('/chat/completions'))).toHaveLength(5);
  });

  it('fatura divergente (+5%) sai FORA da tolerância; geração sem lançamento (404) deixa a conciliação incompleta', async () => {
    const { up, summary } = await runComFatura((id, served) => (id === 'gen-fid-2' ? null : (served ?? 0) * 1.05));
    const rec = await reconcileGenerations(summary, { baseUrl: up.baseUrl, apiKey: KEY, sleep: async () => undefined, attempts: 2 });
    expect(rec).toMatchObject({ found: 4, notFound: 1, complete: false });
    expect(rec.missing).toEqual([{ id: 'gen-fid-2', status: 'not_found', error: 'HTTP 404' }]);
    expect(rec.fidelity.relative).toBeGreaterThan(0.02); // 5% ⇒ reprovado
    expect(rec.fidelity.withinTolerance).toBe(false);
  });
});

describe('proxy de custo — limitador global das chamadas do agente (AIMD)', () => {
  it('fila acima do limite (o agente espera, não é recusado) e recua pela metade no 429 do provedor', async () => {
    let rate429 = false;
    const up = await upstream(() => (rate429 ? { status: 429, error: 'rate limited' } : { text: 'x', cost: 0.001, delayMs: 60 }));
    const limiter = new AimdLimiter(2);
    const { meter, proxy, logFile } = await metered(up, { limiter });
    meter.openExecution({ execId: 'e-lim', modelId: 'm/x' });
    const token = proxy.issueCredential({ execId: 'e-lim' }).token;
    const url = proxy.tcpBaseUrl as string;
    const r = await Promise.all(Array.from({ length: 6 }, () => chat(url, token)));
    expect(r.every((x) => x.status === 200)).toBe(true);
    expect(up.maxConcurrent()).toBeLessThanOrEqual(2);
    expect(limiter.snapshot()).toMatchObject({ active: 0, queued: 0, limit: 2 });
    const ex = await waitExchanges(logFile, 6);
    expect(ex.some((e) => typeof e.limiterWaitMs === 'number' && (e.limiterWaitMs as number) >= 30)).toBe(true);
    rate429 = true;
    expect((await chat(url, token)).status).toBe(429); // o 429 do PROVEDOR volta como veio
    expect(limiter.snapshot().limit).toBe(1);
  });
});

describe('proxy de custo — overhead p50 ≤ 50 ms e TTFT ≤ 5% (50 chamadas, 1.000 chunks)', () => {
  it('pareado direto × via proxy (com o medidor lendo o SSE inteiro)', async () => {
    const payload = manyChunks(1000, 0.0001);
    const up = await upstream(() => ({ burst: payload, ttftMs: 100 }));
    const ledger = new BudgetLedger();
    const { meter, proxy } = await metered(up, { sink: ledger, limiter: new AimdLimiter(32) });
    meter.openExecution({ execId: 'e-lat', modelId: 'openai/gpt-4o-mini', maxCostUsd: 10 });
    const token = proxy.issueCredential({ execId: 'e-lat' }).token;
    for (let i = 0; i < 3; i++) {
      await chat(up.baseUrl, undefined);
      await chat(proxy.tcpBaseUrl as string, token);
    }
    const over: number[] = [];
    const ttftDireto: number[] = [];
    const ttftProxy: number[] = [];
    for (let i = 0; i < 50; i++) {
      const d = await chat(up.baseUrl, undefined);
      const p = await chat(proxy.tcpBaseUrl as string, token);
      expect(p.status).toBe(200);
      expect(p.body.length).toBe(d.body.length); // pass-through íntegro
      over.push(p.totalMs - d.totalMs);
      ttftDireto.push(d.ttftMs);
      ttftProxy.push(p.ttftMs);
    }
    const p50 = median(over);
    const razaoTtft = median(ttftProxy) / median(ttftDireto);
    console.error(`[IMPL-035] overhead p50=${p50.toFixed(2)} ms · TTFT proxy/direto=${razaoTtft.toFixed(4)} (50 chamadas × 1.000 chunks)`);
    expect(p50).toBeLessThanOrEqual(50);
    expect(razaoTtft).toBeLessThanOrEqual(1.05);
    expect(ledger.byRole.agent.calls).toBe(53);
  }, 60_000);
});

describe('proxy de custo — UM medidor por run', () => {
  it('etapas paralelas compartilham o medidor; o último a devolver o solta', () => {
    const base = openRunCostMeters();
    const a = acquireRunCostMeter('run-035-A', {});
    const b = acquireRunCostMeter('run-035-A', {});
    const c = acquireRunCostMeter('run-035-B', {});
    expect(a.meter).toBe(b.meter);
    expect(c.meter).not.toBe(a.meter);
    expect(openRunCostMeters()).toBe(base + 2);
    a.release();
    a.release();
    expect(openRunCostMeters()).toBe(base + 2);
    b.release();
    c.release();
    expect(openRunCostMeters()).toBe(base);
  });
});

// ----------------------------------------------------------------------------
// 3. Executor: recusa → 'maxCost' NA HORA
// ----------------------------------------------------------------------------

describe('spawnAgent — gatilho externo de parada', () => {
  it('mata a árvore na hora com a razão dada (sem esperar stdout nem timeout)', async () => {
    const t0 = Date.now();
    const r = await spawnAgent({
      bin: '/bin/sh',
      argv: ['-c', 'sleep 30'],
      cwd: tmpdir(),
      env: { PATH: '/usr/bin:/bin' },
      stdin: '',
      timeoutMs: 60_000,
      maxOutputBytes: 1024,
      onStdoutChunk: () => undefined,
      onStderrChunk: () => undefined,
      onExternalStop: (stop) => {
        const t = setTimeout(() => stop('maxCost'), 100);
        return () => clearTimeout(t);
      },
    });
    expect(r.stopReason).toBe('maxCost');
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});

/** "pi" falso: lê o models.json (base do proxy + token), chama até levar 429 e aí fica MUDO (backoff). */
function loopingPi(): { bin: string; mark: string } {
  const dir = mkTmp('pb035-fakepi-');
  const bin = path.join(dir, 'pi');
  const mark = path.join(dir, 'recusa.json');
  writeFileSync(
    bin,
    [
      `#!${process.execPath}`,
      "const fs = require('fs'); const path = require('path');",
      "process.stdin.resume(); process.stdin.on('data', () => {});",
      "const p = JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8')).providers.openrouter;",
      '(async () => {',
      '  for (let i = 0; i < 50; i++) {',
      "    const r = await fetch(p.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + p.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'oi' }], stream: true }) });",
      '    const t = await r.text();',
      "    process.stdout.write(JSON.stringify({ type: 'turn_start' }) + '\\n');",
      '    if (r.status === 429) { fs.writeFileSync(process.env.PB_MARK, t); setInterval(() => {}, 1000); return; }',
      '  }',
      '})();',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(bin, 0o755);
  return { bin, mark };
}

const runPi = (opts: AgentRunOpts, base?: PiRunOptions): Promise<PiRunOutcome> =>
  (piExecutor.run as (o: AgentRunOpts, b?: PiRunOptions) => Promise<AgentRunOutcome>).call(piExecutor, opts, base) as Promise<PiRunOutcome>;

function runOpts(over: Partial<AgentRunOpts> & { env: Record<string, string> }): AgentRunOpts {
  const base = mkTmp('pb035-run-');
  const workspaceDir = path.join(base, 'ws');
  const workDir = path.join(base, 'exec');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  return {
    execId: `t${Date.now()}${Math.floor(Math.random() * 1e6)}`,
    task: {},
    config: { executor: 'pi', executorVersion: '0.84.2' },
    workspaceDir,
    workDir,
    bin: 'pi',
    ...over,
  } as AgentRunOpts;
}

describe('executor pi — a recusa do proxy vira stopReason maxCost (controle, não erro do provedor)', () => {
  it('proxy PRÓPRIO da execução: teto US$ 0,10 com chamadas de US$ 0,04 → 2 no provedor, agente mudo morto na hora, custo medido', async () => {
    const up = await upstream(() => ({ text: 'ok', cost: 0.04 }));
    const prev = setDefaultGateway(createGateway({ baseUrl: up.baseUrl }));
    const { bin, mark } = loopingPi();
    try {
      const t0 = Date.now();
      const opts = runOpts({
        bin,
        env: { PI_MODEL_ID: 'openai/gpt-4o-mini', OPENROUTER_API_KEY: KEY, PATH: '/usr/bin:/bin', PB_MARK: mark, PI_TASK: 't' },
        config: { executor: 'pi', executorVersion: '0.84.2', limits: { maxCostUsd: 0.1, timeoutMs: 60_000 } },
      });
      const out = await runPi(opts);
      expect(out.stopReason).toBe('maxCost');
      expect(out.infraError).toBeUndefined();
      expect(Date.now() - t0).toBeLessThan(20_000); // não esperou a parede de 60 s
      expect(up.requests.filter((q) => q.url.endsWith('/chat/completions'))).toHaveLength(2);
      // A 3ª chamada foi recusada NO PROXY (log da execução). O gatilho externo
      // costuma matar o agente antes de ele ler a resposta — o marcador que o
      // falso grava ao receber o 429 é só uma prova extra, quando dá tempo.
      const trocas = logEntries(path.join(opts.workDir, 'inference-proxy.jsonl')).filter((e) => e.event === 'exchange');
      expect(trocas.filter((e) => e.rejected === BUDGET_EXHAUSTED_CODE).length).toBeGreaterThanOrEqual(1);
      expect(trocas.filter((e) => (e.cost as { source?: string } | undefined)?.source === 'usage')).toHaveLength(2);
      if (existsSync(mark)) expect(JSON.parse(readFileSync(mark, 'utf8')).error.type).toBe(BUDGET_EXHAUSTED_CODE);
      expect(out.usage.costUsd).toBeCloseTo(0.08, 12);
      expect(out.trajectory.usage).toMatchObject({ costSource: 'usage', costUsd: 0.08 });
      expect(out.stderrTail).toMatch(/freio de custo do proxy \(teto da execução/);
    } finally {
      setDefaultGateway(prev);
    }
  }, 60_000);
});

// ----------------------------------------------------------------------------
// 4. runAgentStage
// ----------------------------------------------------------------------------

/** Gateway falso que fala com o proxy pela rota recebida até levar 429 (ou `max` chamadas). */
function proxyCallingGateway(opts: { max?: number; derivedCostUsd?: number; callProxy?: boolean } = {}): AgentGateway & { seen: AgentRunOpts[] } {
  const seen: AgentRunOpts[] = [];
  return {
    id: 'pi-fake-035',
    seen,
    prepare: async () => ({ bin: 'pi-fake', env: { PATH: '/usr/bin:/bin' } }),
    run: async (o) => {
      seen.push(o);
      if (opts.callProxy !== false) {
        for (let i = 0; i < (opts.max ?? 20); i++) {
          const r = await chat(o.inference?.baseUrl as string, o.inference?.token);
          if (r.status === 429) break;
        }
      }
      return {
        stopReason: 'completed',
        turns: 1,
        toolCalls: 0,
        durationMs: 5,
        usage: { tokensIn: 1, tokensOut: 1, costUsd: opts.derivedCostUsd ?? 0 },
        trajectory: {
          format: 'agent-trajectory@1',
          executor: { id: 'pi-fake-035', version: '0' },
          model: { provider: 'openrouter', id: o.env.PI_MODEL_ID },
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 5,
          stopReason: 'completed',
          turns: [],
          usage: { tokensIn: 1, tokensOut: 1, tokensReasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: opts.derivedCostUsd ?? 0, costSource: 'agent-derived' },
          parseErrors: 0,
          compactions: [],
        },
        parseErrors: 0,
        responseIds: [],
        stderrTail: '',
        exitCode: 0,
        signal: null,
      } as PiRunOutcome;
    },
  };
}

async function withStage<T>(up: FakeUpstream, fn: (dataDir: string) => Promise<T>): Promise<T> {
  const prev = setDefaultGateway(createGateway({ baseUrl: up.baseUrl }));
  const dataDir = mkTmp('pb035-stage-');
  const anterior = getDataDir();
  setDataDir(dataDir);
  try {
    return await fn(dataDir);
  } finally {
    setDefaultGateway(prev);
    setDataDir(anterior);
  }
}

function stageParams(over: Partial<RunAgentStageParams> & Pick<RunAgentStageParams, 'runId' | 'gateway' | 'ctx' | 'dataDir'>): RunAgentStageParams {
  return {
    stageIndex: 0,
    contestant: { id: 'ag', label: 'ag', modelId: 'openai/gpt-4o-mini', runner: 'agent' },
    stage: { question: 'q', productContext: 'c', maxTokens: 10, agentTask: {} },
    agentConfig: { executor: 'pi', executorVersion: '0', limits: { maxCostUsd: 1 } },
    apiKey: KEY,
    catalog: [],
    judgeModelIds: [],
    ...over,
  };
}

describe('runAgentStage — freio e custo medido pelo proxy da run', () => {
  it('escopo EXECUÇÃO: stopReason maxCost (fora do placar), ledger POR CHAMADA com usage.cost, exec.json auditável, sem dobrar', async () => {
    const up = await upstream((_r, n) => ({ text: 'ok', cost: 0.04, id: `gen-stage-${n}` }));
    await withStage(up, async (dataDir) => {
      const ledger = new BudgetLedger();
      // O executor "diria" US$ 0,50 (tabela própria): o ledger precisa ficar com o MEDIDO.
      const gw = proxyCallingGateway({ derivedCostUsd: 0.5 });
      const res = await runAgentStage(
        stageParams({
          runId: 'run-035-exec',
          gateway: gw,
          ctx: { sink: ledger },
          dataDir,
          agentConfig: { executor: 'pi', executorVersion: '0', limits: { maxCostUsd: 0.1 } },
        }),
      );
      const r0 = res.repResults[0];
      expect(gw.seen[0].costBrake).toBeDefined();
      expect(r0.stopReason).toBe('maxCost');
      // IMPL-032: corte por limite (o freio do teto da EXECUÇÃO) é 'nao' e fica no
      // denominador — tirá-lo recriava o viés de sobrevivência.
      expect(r0.verdict).toBe('nao');
      expect(r0.path).toBe('limit-cut');
      expect(r0.execution.infraError).toBeUndefined();
      expect(r0.costUsd).toBeCloseTo(0.08, 12);
      expect(res.response.costUsd).toBeCloseTo(0.08, 12);
      expect(ledger.byRole.agent).toMatchObject({ calls: 2 });
      expect(ledger.byRole.agent.usd).toBeCloseTo(0.08, 12);
      expect(ledger.accuracy.exact).toBe(2);
      expect(up.requests).toHaveLength(2);
      const exec = JSON.parse(readFileSync(path.join(dataDir, r0.execution.dir, 'exec.json'), 'utf8')) as ExecutionRecord;
      expect(exec.usage).toMatchObject({
        costUsd: 0.08,
        costSource: 'usage',
        agentDerivedCostUsd: 0.5,
        proxy: { calls: 2, exact: 2, refused: 1, generationIds: ['gen-stage-0', 'gen-stage-1'], budgetStop: { scope: 'execution', limitUsd: 0.1 } },
      });
      expect(exec.trajectorySummary.stopReason).toBe('maxCost');
      const log = readFileSync(path.join(dataDir, 'agent-runs/run-035-exec/inference-proxy.jsonl'), 'utf8');
      expect(log).toContain('"costProxy":1');
      expect(summarizeProxyCostLog(log)).toMatchObject({ calls: 2, refused: 1 });
    });
  });

  it('escopo RUN: o BudgetExceeded do ledger SOBE como sinal de controle (a run sai parcial por orçamento)', async () => {
    const up = await upstream(() => ({ text: 'ok', cost: 0.04 }));
    await withStage(up, async (dataDir) => {
      const ledger = new BudgetLedger({ budgetUsd: 0.1 });
      let pego: unknown;
      try {
        await runAgentStage(stageParams({ runId: 'run-035-run', gateway: proxyCallingGateway(), ctx: { sink: ledger }, dataDir }));
      } catch (err) {
        pego = err;
      }
      expect(isBudgetSignal(pego)).toBe(true);
      expect(up.requests).toHaveLength(2);
      expect(ledger.spentUsd).toBeCloseTo(0.08, 12);
      expect(openRunCostMeters()).toBe(0);
    });
  });

  it('executor que NÃO passa pelo proxy (fake/adaptador sem base URL): cai no custo derivado, como antes', async () => {
    const up = await upstream();
    await withStage(up, async (dataDir) => {
      const ledger = new BudgetLedger();
      const res = await runAgentStage(
        stageParams({ runId: 'run-035-fallback', gateway: proxyCallingGateway({ callProxy: false, derivedCostUsd: 0.03 }), ctx: { sink: ledger }, dataDir }),
      );
      expect(res.repResults[0].stopReason).toBe('completed');
      expect(ledger.byRole.agent).toMatchObject({ calls: 1 });
      expect(ledger.byRole.agent.usd).toBeCloseTo(0.03, 12);
      expect(ledger.accuracy.estimated).toBe(1);
      const exec = JSON.parse(readFileSync(path.join(dataDir, res.repResults[0].execution.dir, 'exec.json'), 'utf8')) as ExecutionRecord;
      expect(exec.usage.costSource).toBe('agent-derived');
      expect(exec.usage.proxy?.calls).toBe(0);
    });
  });
});

// ----------------------------------------------------------------------------
// 5. pi REAL no host / Docker real
// ----------------------------------------------------------------------------

const piOnHost = spawnSync('pi', ['--version'], { encoding: 'utf8', env: { PATH: CLEAN_PATH }, timeout: 20_000 }).status === 0;

/** Agente que nunca termina: toda resposta é uma tool call de bash de US$ 0,04. */
const loopForever = (): FakeReply => ({ toolCall: { name: 'bash', args: { command: 'echo passo >> passos.txt' } }, cost: 0.04 });

describe.runIf(piOnHost)('pi REAL no host — o freio do proxy para o agente antes da 3ª chamada', () => {
  it('teto da execução US$ 0,10 × chamadas de US$ 0,04: 2 no provedor, maxCost, ledger == usage.cost', async () => {
    const up = await upstream(loopForever);
    await withStage(up, async (dataDir) => {
      const ledger = new BudgetLedger();
      const res = await runAgentStage(
        stageParams({
          runId: 'run-035-pi-host',
          gateway: undefined,
          ctx: { sink: ledger },
          dataDir,
          stage: { question: 'rode o passo até terminar', productContext: 'repo vazio', maxTokens: 100, agentTask: {} },
          agentConfig: { executor: 'pi', executorVersion: '0.84.2', install: 'system', limits: { maxCostUsd: 0.1, timeoutMs: 120_000 } },
        }),
      );
      const r0 = res.repResults[0];
      expect(r0.stopReason).toBe('maxCost');
      expect(r0.execution.infraError).toBeUndefined();
      expect(up.requests.filter((q) => q.url.endsWith('/chat/completions'))).toHaveLength(2);
      expect(ledger.byRole.agent.usd).toBeCloseTo(0.08, 12);
      expect(ledger.accuracy.exact).toBe(2);
      const exec = JSON.parse(readFileSync(path.join(dataDir, r0.execution.dir, 'exec.json'), 'utf8')) as ExecutionRecord;
      expect(exec.usage).toMatchObject({ costSource: 'usage', costUsd: 0.08, proxy: { calls: 2, budgetStop: { scope: 'execution' } } });
      expect(r0.execution.durationMs).toBeLessThan(60_000);
    });
  }, 150_000);
});

const PI_IMAGE = 'prompt-builder-pi:0.84.2';
const dockerReady =
  process.env.PB_SKIP_DOCKER_TESTS !== '1' &&
  spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 15_000 }).status === 0;
const piImagePresent =
  dockerReady && spawnSync('docker', ['image', 'inspect', PI_IMAGE], { encoding: 'utf8', timeout: 15_000 }).status === 0;

describe.runIf(piImagePresent)('Docker real — o freio atravessa relay + socket e o kill derruba o container', () => {
  it('modo container: 2 chamadas no provedor, a 3ª recusada no proxy, maxCost, container removido', async () => {
    const up = await upstream(loopForever);
    const savedNet = process.env[UNSAFE_NETWORK_ENV];
    delete process.env[UNSAFE_NETWORK_ENV];
    try {
      await withStage(up, async (dataDir) => {
        const ledger = new BudgetLedger();
        const res = await runAgentStage(
          stageParams({
            runId: 'run-035-docker',
            gateway: undefined,
            ctx: { sink: ledger },
            dataDir,
            stage: { question: 'rode o passo até terminar', productContext: 'repo vazio', maxTokens: 100, agentTask: {} },
            agentConfig: {
              executor: 'pi',
              executorVersion: '0.84.2',
              isolation: { kind: 'container', image: PI_IMAGE },
              limits: { maxCostUsd: 0.1, timeoutMs: 120_000 },
            },
          }),
        );
        const r0 = res.repResults[0];
        expect(r0.stopReason).toBe('maxCost');
        expect(up.requests.filter((q) => q.url.endsWith('/chat/completions'))).toHaveLength(2);
        expect(ledger.byRole.agent.usd).toBeCloseTo(0.08, 12);
        const vivos = spawnSync('docker', ['ps', '-q', '--filter', `name=${r0.execution.execId}`], { encoding: 'utf8' }).stdout.trim();
        expect(vivos).toBe('');
      });
    } finally {
      if (savedNet !== undefined) process.env[UNSAFE_NETWORK_ENV] = savedNet;
    }
  }, 180_000);
});
