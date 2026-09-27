// IMPL-073 (R-07a:REC-3) — retry único por resposta: Retry-After como piso,
// retry SÓ em 429/5xx/erro antes do envio, e abort/timeout/erro DEPOIS dos
// headers SEM reenvio (a geração pode ter concluído e sido cobrada — o POST
// repetido sem chave de idempotência no /chat/completions = cobrança dupla).
// Contratos aqui (transporte falso, zero rede):
//   (a)  Retry-After/retry-after-ms é PISO da espera (nunca abaixo);
//   (b)  erro ANTES do envio (DNS/conexão) pode repetir; erro DEPOIS do
//        despacho nunca — sai marcado (`isUpstreamSent`) e com 1 só POST;
//   (c)  falha depois dos headers trava o reenvio do MESMO corpo até a
//        conciliação (guarda anti-reenvio): o laço do competidor não reenvia
//        "sem verificação" (critério (ii));
//   (d)  cobranças duplicadas = 0 por id de geração (critério (iv)).
// ⚠️ O critério (i) (<= 5 tentativas HTTP por resposta, somando o laço do
// competidor) depende de reduzir MAX_RETRIES (hoje 6 => 7 envios por chamada,
// 14 somando o competidor), mas test/gateway.test.ts:309 fixa por contrato
// `expect(MAX_RETRIES).toBe(6)` + 7 envios — fora da fronteira deste lote. O
// teto de envios por chamada é assertado aqui como está (1 + MAX_RETRIES) até
// o contrato antigo ser atualizado em conjunto.

import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_RETRIES,
  createGateway,
  isUpstreamSent,
  parseRetryAfterMs,
  setDefaultGateway,
  type FetchLike,
  type OpenRouterGateway,
} from '../src/openrouter.js';
import { BudgetLedger } from '../src/budget.js';
import { runCompetitor } from '../src/competitor.js';
import type { StageSpec } from '../src/types.js';
import { fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const msgs = [{ role: 'user' as const, content: 'Diga oi.' }];

const STAGE: StageSpec = {
  question: 'Qual o prazo de troca?',
  productContext: 'Trocas em até 30 dias com nota fiscal.',
  maxTokens: 300,
};

let anterior: OpenRouterGateway | undefined;
afterEach(() => {
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
});

describe('IMPL-073 (a) — Retry-After / retry-after-ms como piso do backoff', () => {
  it('parseRetryAfterMs: milissegundos, segundos, data HTTP, lixo e cabecalhos de objeto puro', () => {
    expect(parseRetryAfterMs({ get: (n: string) => (n === 'retry-after-ms' ? '250' : null) })).toBe(250);
    expect(parseRetryAfterMs({ get: (n: string) => (n.toLowerCase() === 'retry-after' ? '3' : null) })).toBe(3000);
    const futuro = new Date(Date.now() + 5000).toUTCString();
    const viaData = parseRetryAfterMs({ get: (n: string) => (n === 'retry-after' ? futuro : null) });
    expect(viaData).toBeGreaterThan(3000);
    expect(viaData).toBeLessThanOrEqual(5100);
    expect(parseRetryAfterMs({ 'retry-after-ms': '400' })).toBe(400);
    expect(parseRetryAfterMs({ 'Retry-After': '2' })).toBe(2000);
    expect(parseRetryAfterMs({ 'retry-after': 'logo' })).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });

  it('429 com retry-after-ms: NENHUMA espera abaixo do piso do provedor', async () => {
    const esperas: number[] = [];
    const fake = fakeOpenRouter({
      chat: (req, n) =>
        n < 2
          ? new Response('slow down', { status: 429, headers: { 'retry-after-ms': '400' } })
          : { text: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } },
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: async (ms) => void esperas.push(ms) });
    const r = await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs });
    expect(r.text).toBe('ok');
    expect(esperas.length).toBeGreaterThanOrEqual(2);
    for (const ms of esperas) expect(ms, `backoff ${ms}ms abaixo do Retry-After`).toBeGreaterThanOrEqual(400);
  });

  it('429 com Retry-After: 2 s => espera >= 2000 ms', async () => {
    const esperas: number[] = [];
    const fake = fakeOpenRouter({
      chat: (_req, n) =>
        n < 1
          ? new Response('slow', { status: 429, headers: { 'retry-after': '2' } })
          : { text: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } },
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: async (ms) => void esperas.push(ms) });
    await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs });
    expect(esperas[0]).toBeGreaterThanOrEqual(2000);
  });
});

describe('IMPL-073 (b) — classes de retry: só 429/5xx/erro ANTES do envio', () => {
  it('erro de rede antes do envio (conexao recusada) REPETE; teto por chamada = 1 + MAX_RETRIES', async () => {
    let envios = 0;
    const recusado: FetchLike = async () => {
      envios += 1;
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    const gw = createGateway({ fetch: recusado, sleep: noSleep });
    await expect(gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs })).rejects.toThrow();
    expect(envios).toBe(1 + MAX_RETRIES); // contrato atual do gateway (ver nota no topo)
  });

  it('erro de rede DEPOIS do despacho NAO repete: 1 POST e erro marcado isUpstreamSent', async () => {
    let envios = 0;
    const instavel: FetchLike = async () => {
      envios += 1;
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    };
    const gw = createGateway({ fetch: instavel, sleep: noSleep });
    const err = await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs }).catch((e: unknown) => e);
    expect(envios).toBe(1); // SEM reenvio: desfecho desconhecido, pode ter sido cobrado
    expect(isUpstreamSent(err)).toBe(true);
  });

  it('4xx não é transiente (1 POST); 5xx repete', async () => {
    const fake400 = fakeOpenRouter({ chat: () => ({ status: 400, bodyText: 'bad' }) });
    const gw400 = createGateway({ fetch: fake400.fetch, sleep: noSleep });
    await expect(gw400.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs })).rejects.toThrow(/HTTP 400/);
    expect(fake400.chatRequests()).toHaveLength(1);

    const fake502 = fakeOpenRouter({
      chat: (_req, n) => (n < 2 ? { status: 502, bodyText: 'bad gateway' } : { text: 'ok' }),
    });
    const gw502 = createGateway({ fetch: fake502.fetch, sleep: noSleep });
    await gw502.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs });
    expect(fake502.chatRequests()).toHaveLength(3);
  });

  it('falha na leitura do corpo (depois do 200) não repete e sai marcada', async () => {
    let envios = 0;
    const corpoQuebra: FetchLike = async () => {
      envios += 1;
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(enc.encode('{"choices":['));
          ctrl.error(Object.assign(new Error('network error'), { code: 'ECONNRESET' }));
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const gw = createGateway({ fetch: corpoQuebra, sleep: noSleep });
    const err = await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs }).catch((e: unknown) => e);
    expect(envios).toBe(1);
    expect(isUpstreamSent(err)).toBe(true);
  });
});

describe('IMPL-073 (c/d) — sem verificação não reenvia; cobranças duplicadas = 0', () => {
  /** Chat corta depois do id de geração; /generation devolve a fatura. */
  const transporteCorte = (cont: { posts: number }, fatura: Record<string, unknown>): FetchLike => {
    return async (url, init) => {
      const u = String(url);
      if (u.includes('/generation')) return new Response(JSON.stringify({ data: fatura }), { status: 200 });
      if (!u.endsWith('/chat/completions')) return new Response('{}', { status: 200 });
      cont.posts += 1;
      const signal = init?.signal;
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const enc = new TextEncoder();
      const corpo = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(
            enc.encode(`data: ${JSON.stringify({ id: 'gen-1', choices: [{ delta: { content: 'meia resposta' } }] })}\n\n`),
          );
          signal?.addEventListener('abort', () => ctrl.error(signal.reason), { once: true });
        },
      });
      return new Response(corpo, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
  };

  it('corte pos-headers: o laço do competidor NAO reenvia o mesmo papel (1 POST, pendente pelo id)', async () => {
    const cont = { posts: 0 };
    const fatura = { provider_name: 'OpenAI', upstream_id: 'up-77', total_cost: 0.003, cancelled: true };
    const gw = createGateway({ fetch: transporteCorte(cont, fatura), sleep: noSleep });
    anterior = setDefaultGateway(gw);
    const ledger = new BudgetLedger({ budgetUsd: 1, estimateCall: () => 0.02 });
    try {
      const r = await runCompetitor({
        apiKey: KEY,
        contestantId: 'c',
        modelId: 'x/y',
        stage: STAGE,
        retries: 1, // o laço externo do competidor (2 tentativas)
        timeoutMs: 30,
        ctx: { sink: ledger },
      });
      expect(r.status).toBe('error'); // a 2ª tentativa foi RECUSADA sem tocar a rede
      expect(cont.posts).toBe(1); // critério (ii): sem reenvio sem verificação

      // Critério (iv): UMA cobrança por id de geração — conciliação pelo /generation.
      const pendentes = ledger.pendingEntries();
      expect(pendentes).toHaveLength(1);
      expect(pendentes[0]).toMatchObject({ generationId: 'gen-1', reason: 'timeout' });
      const info = await gw.fetchGenerationInfo(KEY, 'gen-1');
      expect(info?.totalCostUsd).toBe(0.003);
      ledger.settlePending('gen-1', { usd: info!.totalCostUsd!, source: 'usage' });
      expect(ledger.spentUsd).toBeCloseTo(0.003, 12); // UMA cobrança, exatamente a do /generation
      expect(ledger.pendingEntries()).toHaveLength(0);
      expect(cont.posts).toBe(1); // a conciliação também não reenvia
    } finally {
      setDefaultGateway(anterior);
      anterior = undefined;
    }
  });

  it('a guarda expira (TTL) e não bloqueia para sempre um corpo legítimo', async () => {
    const cont = { posts: 0 };
    const gw = createGateway({
      fetch: transporteCorte(cont, { total_cost: 0.001, cancelled: true }),
      sleep: noSleep,
      resendGuardTtlMs: 30,
    });
    const params = {
      apiKey: KEY,
      modelId: 'x/y',
      messages: [{ role: 'user' as const, content: 'oi' }],
      timeoutMs: 25,
    };
    await expect(gw.chatCompletion(params)).rejects.toThrow();
    await expect(gw.chatCompletion(params)).rejects.toThrow(); // bloqueada (mesma janela)
    expect(cont.posts).toBe(1);
    await new Promise((r) => setTimeout(r, 40));
    await expect(gw.chatCompletion(params)).rejects.toThrow(); // TTL expirou: nova chamada passa
    expect(cont.posts).toBe(2);
  });

  it('guarda desligada (TTL 0) preserva o comportamento antigo de reenvio', async () => {
    const cont = { posts: 0 };
    const gw = createGateway({
      fetch: transporteCorte(cont, { total_cost: 0.001, cancelled: true }),
      sleep: noSleep,
      resendGuardTtlMs: 0,
    });
    const params = {
      apiKey: KEY,
      modelId: 'x/y',
      messages: [{ role: 'user' as const, content: 'oi' }],
      timeoutMs: 25,
    };
    await expect(gw.chatCompletion(params)).rejects.toThrow();
    await expect(gw.chatCompletion(params)).rejects.toThrow();
    expect(cont.posts).toBe(2); // sem guarda: reenviou (com o risco de cobrança dupla)
  });
});
