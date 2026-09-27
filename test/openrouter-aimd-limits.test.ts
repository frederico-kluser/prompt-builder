// IMPL-076 (R-07a:REC-5) — limitador AIMD por (key, modelo), recuo limitado a
// 1 por janela, Retry-After como piso, tetos :free e 402 sem backoff.
//
// Critérios cobertos aqui (transporte falso/servidor falso, zero rede real):
//  (i)  rajada de 429 reduz o limite NO MÁXIMO 1x por janela (>= 1 s) —
//       fake timers, relógio congelado;
//  (ii) Retry-After: 30 implica espera >= 30 s;
//  (iii) duas keys distintas não compartilham limite (instância ÚNICA, como
//       no servidor multiusuário);
//  (iv) throughput >= 90% do teto simulado e taxa de 429 <= 2% sob carga
//       nominal, com servidor falso via OPENROUTER_BASE_URL;
//  +    402 (sem crédito) nunca é tratado com backoff — 1 envio, zero espera;
//  +    tetos :free por key (20/min espera reabastecimento; diário estourado
//       recusa com erro claro) e triagem do recuo por `error.metadata.provider_code`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  AIMD_DECREASE_WINDOW_MS,
  AimdLimiter,
  createGateway,
  FREE_DAILY_LIMIT_DEFAULT,
  FREE_PER_MINUTE,
  type OpenRouterGateway,
} from '../src/openrouter.js';
import { gatewayConfigFromEnv } from '../src/gatewayEnv.js';
import { fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY_A = 'sk-or-v1-chave-A-0000000000';
const KEY_B = 'sk-or-v1-chave-B-1111111111';
const msgs = [{ role: 'user' as const, content: 'x' }];

/** Espera que registra os ms (e opcionalmente AVANÇA o relógio falso). */
function sleepSpy(avancar = false): { esperas: number[]; sleep: (ms: number) => Promise<void> } {
  const esperas: number[] = [];
  return {
    esperas,
    sleep: async (ms: number) => {
      esperas.push(ms);
      if (avancar) vi.setSystemTime(new Date(Date.now() + ms));
    },
  };
}

let abertos: OpenRouterGateway[] = [];
afterEach(() => {
  abertos = [];
  vi.useRealTimers();
});

function gw(config: Parameters<typeof createGateway>[0]): OpenRouterGateway {
  const g = createGateway(config);
  abertos.push(g);
  return g;
}

describe('IMPL-076 (i) — rajada de 429 recua 1x por janela (>= 1 s)', () => {
  it('AimdLimiter: 5 recuos no MESMO instante cortam uma vez só (8→4), e a janela não desce de 1 s', () => {
    let relogio = 1_000_000;
    const l = new AimdLimiter(32, { now: () => relogio });
    expect(l.snapshot().limit).toBe(8); // min(INICIAL 8, teto 32)
    for (let i = 0; i < 5; i++) l.noteRateLimit(); // rajada: 5× 429 num segundo
    expect(l.snapshot().limit).toBe(4); // UM recuo, não 8→4→2→1→1→1

    // Janela nova (+1 s exato): cabe mais um recuo.
    relogio += AIMD_DECREASE_WINDOW_MS;
    l.noteRateLimit();
    expect(l.snapshot().limit).toBe(2);
    // Menos de 1 s depois: não conta.
    relogio += AIMD_DECREASE_WINDOW_MS - 1;
    l.noteRateLimit();
    expect(l.snapshot().limit).toBe(2);
  });

  it('o piso da janela é 1 s mesmo que o chamador peça menos (decreaseWindowMs: 10)', () => {
    let relogio = 0;
    const l = new AimdLimiter(32, { decreaseWindowMs: 10, now: () => relogio });
    l.noteRateLimit(); // 8→4
    relogio += 500; // 500 ms depois — caberia em "janela de 10 ms", mas o piso é 1 s
    l.noteRateLimit();
    expect(l.snapshot().limit).toBe(4);
    relogio += 1000;
    l.noteRateLimit();
    expect(l.snapshot().limit).toBe(2);
  });

  it('gateway: 3× 429 seguidos com relógio parado reduzem 8→4 e a chamada conclui', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let g!: OpenRouterGateway;
    const limites: number[] = [];
    const fake = fakeOpenRouter({
      chat: (_req, n) => {
        limites.push(g.currentConcurrency().limit);
        return n < 3 ? { status: 429, bodyText: 'rate limited' } : { text: 'ok' };
      },
    });
    g = gw({ fetch: fake.fetch, sleep: noSleep });
    const r = await g.chatCompletion({ apiKey: KEY_A, modelId: 'x/y', messages: msgs });
    expect(r.text).toBe('ok');
    expect(limites).toEqual([8, 4, 4, 4]);
    // Recuperação aditiva sob pressão: o recuo de 1x por janela não é "teto fixo".
    expect(g.currentConcurrency().limit).toBeGreaterThanOrEqual(4);
  });
});

describe('IMPL-076 (ii) — Retry-After é PISO do backoff', () => {
  it('Retry-After: 30 implica espera >= 30 s antes do reenvio', async () => {
    const { esperas, sleep } = sleepSpy();
    const fake = fakeOpenRouter({
      chat: (_req, n) =>
        n === 0
          ? new Response('slow down', { status: 429, headers: { 'retry-after': '30' } })
          : { text: 'ok' },
    });
    const g = gw({ fetch: fake.fetch, sleep });
    const r = await g.chatCompletion({ apiKey: KEY_A, modelId: 'x/y', messages: msgs });
    expect(r.text).toBe('ok');
    expect(fake.chatRequests()).toHaveLength(2);
    expect(esperas).toHaveLength(1);
    expect(esperas[0]).toBeGreaterThanOrEqual(30_000);
    // …e nunca menos que o piso, mesmo com jitter do backoff exponencial.
    expect(esperas[0]).toBeLessThan(30_000 + 250);
  });
});

describe('IMPL-076 (iii) — limites por (key, modelo): keys não compartilham', () => {
  it('o 429 da key A não derruba o limite da key B na MESMA instância', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fake = fakeOpenRouter({
      chat: (req) =>
        req.headers.Authorization === `Bearer ${KEY_A}` ? { status: 429, bodyText: 'rate limited' } : { text: 'ok' },
    });
    const g = gw({ fetch: fake.fetch, sleep: noSleep });

    // A leva 3× 429 (rajada = 1 recuo); B conclui direto.
    await expect(g.chatCompletion({ apiKey: KEY_A, modelId: 'x/y', messages: msgs })).rejects.toThrow(
      /rate limit \(HTTP 429\)/,
    );
    const r = await g.chatCompletion({ apiKey: KEY_B, modelId: 'x/y', messages: msgs });
    expect(r.text).toBe('ok');

    const escopoA = g.currentConcurrency(KEY_A, 'x/y');
    const escopoB = g.currentConcurrency(KEY_B, 'x/y');
    expect(escopoA.limit).toBe(4); // 8→4 (1 recuo na rajada)
    expect(escopoB.limit).toBe(8); // intacto — estado por key
    // E o agregado segue o teto mais apertado dos escopos vivos.
    expect(g.currentConcurrency().limit).toBe(4);
  });

  it('o escopo também é por MODELO: o 429 de (key A, m1) não toca (key A, m2)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fake = fakeOpenRouter({
      chat: (req) => (req.model === 'm/um' ? { status: 429, bodyText: 'rate limited' } : { text: 'ok' }),
    });
    const g = gw({ fetch: fake.fetch, sleep: noSleep });
    await expect(g.chatCompletion({ apiKey: KEY_A, modelId: 'm/um', messages: msgs })).rejects.toThrow(/429/);
    const r = await g.chatCompletion({ apiKey: KEY_A, modelId: 'm/dois', messages: msgs });
    expect(r.text).toBe('ok');
    expect(g.currentConcurrency(KEY_A, 'm/um').limit).toBe(4);
    expect(g.currentConcurrency(KEY_A, 'm/dois').limit).toBe(8);
  });

  it('triagem por provider_code: recuo no refino (key, modelo, provedor) quando o provedor é identificado', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const erro = {
      status: 429,
      bodyText: JSON.stringify({ error: { message: 'rate limited', metadata: { provider_code: 'prov-x' } } }),
    };
    // Sempre 429 (a chamada toda falha) — o que interessa é ONDE o recuo cai.
    const fake = fakeOpenRouter({ chat: () => erro });
    // Chamada LIVRE (sem provedor fixado): recua o base e o refino do upstream nomeado.
    const g = gw({ fetch: fake.fetch, sleep: noSleep });
    await expect(g.chatCompletion({ apiKey: KEY_A, modelId: 'x/y', messages: msgs })).rejects.toThrow(/429/);
    expect(g.currentConcurrency(KEY_A, 'x/y').limit).toBe(4);
    expect(g.currentConcurrency(KEY_A, 'x/y', 'prov-x').limit).toBe(4);

    // Chamada FIXADA no provedor (modo auditável, order de 1): só o refino recua.
    const fake2 = fakeOpenRouter({ chat: () => erro });
    const g2 = gw({
      fetch: fake2.fetch,
      sleep: noSleep,
      auditableRoles: ['judge'],
      auditableProviderOrder: ['prov-x'],
    });
    await expect(
      g2.chatCompletion({ apiKey: KEY_B, modelId: 'x/y', messages: msgs, role: 'judge' }),
    ).rejects.toThrow(/429/);
    expect(g2.currentConcurrency(KEY_B, 'x/y').limit).toBe(8); // base intacto
    expect(g2.currentConcurrency(KEY_B, 'x/y', 'prov-x').limit).toBe(4); // o refino absorve
  });
});

describe('IMPL-076 — 402 (sem crédito) NUNCA é backoff', () => {
  it('402 sai classificado no primeiro envio: 1 POST e zero esperas', async () => {
    const { esperas, sleep } = sleepSpy();
    const fake = fakeOpenRouter({ chat: () => ({ status: 402, bodyText: 'out of credits' }) });
    const g = gw({ fetch: fake.fetch, sleep });
    await expect(g.chatCompletion({ apiKey: KEY_A, modelId: 'x/y', messages: msgs })).rejects.toThrow(
      /sem credito|HTTP 402/i,
    );
    expect(fake.chatRequests()).toHaveLength(1);
    expect(esperas).toEqual([]);
  });
});

describe('IMPL-076 — tetos :free por key (token bucket)', () => {
  it('20/min: a 21ª chamada :free ESPERA o reabastecimento em vez de estourar', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { esperas, sleep } = sleepSpy(true); // a espera AVANÇA o relógio (reabastece)
    const fake = fakeOpenRouter({ chat: () => ({ text: 'ok' }) });
    const g = gw({ fetch: fake.fetch, sleep, freeDailyLimit: 1000 });
    for (let i = 0; i < FREE_PER_MINUTE; i++) {
      await g.chatCompletion({ apiKey: KEY_A, modelId: 'meta/llama:free', messages: msgs });
    }
    expect(esperas).toEqual([]); // 20 cabem no bucket
    await g.chatCompletion({ apiKey: KEY_A, modelId: 'meta/llama:free', messages: msgs });
    expect(fake.chatRequests()).toHaveLength(FREE_PER_MINUTE + 1);
    // A 21ª esperou a ficha (≈ 1/20 do minuto) — nunca mandou para o provedor.
    expect(esperas.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...esperas)).toBeGreaterThan(1000);
    // Modelo pago NÃO passa pelo bucket.
    await g.chatCompletion({ apiKey: KEY_A, modelId: 'x/y', messages: msgs });
    expect(esperas.length).toBeGreaterThanOrEqual(1);
  });

  it('diário estourado recusa com erro PT-BR claro (esperar um dia não é backoff)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { esperas, sleep } = sleepSpy(true);
    const fake = fakeOpenRouter({ chat: () => ({ text: 'ok' }) });
    const g = gw({ fetch: fake.fetch, sleep, freeDailyLimit: 2 });
    await g.chatCompletion({ apiKey: KEY_A, modelId: 'meta/llama:free', messages: msgs });
    await g.chatCompletion({ apiKey: KEY_A, modelId: 'meta/llama:free', messages: msgs });
    await expect(
      g.chatCompletion({ apiKey: KEY_A, modelId: 'meta/llama:free', messages: msgs }),
    ).rejects.toThrow(/Teto diario/);
    expect(fake.chatRequests()).toHaveLength(2); // nada foi ao provedor
    expect(FREE_DAILY_LIMIT_DEFAULT).toBe(50); // default conservador documentado
  });
});

describe('IMPL-076 (iv) — throughput >= 90% do teto e 429 <= 2% sob carga nominal', () => {
  it('servidor falso via OPENROUTER_BASE_URL: regime nominal satura o teto sem derrubar 429', async () => {
    const CEIL = 16;
    // Latência do servidor DOMINANTE (como numa chamada de LLM de verdade,
    // onde gerar leva segundos): o custo fixo de CPU do cliente por chamada
    // (JSON, guarda PII, hash do corpo) não pode mascarar o teto medido.
    const LAT_MS = 250;
    const MEDIDOS = 96;
    const AQUECIMENTO = 24;
    let ativos = 0;
    let total = 0;
    let erros429 = 0;

    const server: Server = createServer((req, res) => {
      if (!req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      total += 1;
      // Servidor de verdade: além do teto responde 429 (é o que o provedor faz).
      if (ativos >= CEIL) {
        erros429 += 1;
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' }).end(
          JSON.stringify({ error: { message: 'rate limited' } }),
        );
        return;
      }
      ativos += 1;
      setTimeout(() => {
        ativos -= 1;
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: `gen-${total}`,
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          }),
        );
      }, LAT_MS);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      // A configuração vem DO AMBIENTE, como os pontos de entrada fazem.
      const cfg = gatewayConfigFromEnv({
        OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
        OPENROUTER_MAX_CONCURRENCY: String(CEIL),
      });
      const g = gw(cfg);

      // Aquecimento: o AIMD sobe de 8 até o teto sob pressão.
      await Promise.all(
        Array.from({ length: AQUECIMENTO }, () =>
          g.chatCompletion({ apiKey: KEY_A, modelId: 'x/y', messages: msgs }),
        ),
      );
      expect(g.currentConcurrency().limit).toBeGreaterThanOrEqual(CEIL - 2);

      total = 0;
      erros429 = 0;
      const t0 = Date.now();
      await Promise.all(
        Array.from({ length: MEDIDOS }, () =>
          g.chatCompletion({ apiKey: KEY_A, modelId: 'x/y', messages: msgs }),
        ),
      );
      const decorrido = Date.now() - t0;

      // Throughput = produção real vs a do teto simulado (MEDIDOS × latência / teto).
      const tempoIdeal = (MEDIDOS * LAT_MS) / CEIL;
      const razao = tempoIdeal / decorrido;
      console.error(
        `[IMPL-076] throughput=${(razao * 100).toFixed(1)}% do teto (${decorrido} ms vs ideal ${tempoIdeal.toFixed(0)} ms), 429=${erros429}/${total}`,
      );
      expect(razao).toBeGreaterThanOrEqual(0.9);
      expect(erros429 / Math.max(1, total)).toBeLessThanOrEqual(0.02);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});
