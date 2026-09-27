// IMPL-021 (R-09:REC-2) — gateway único com configuração INJETADA.
//
// Contratos:
//  (a) `src/openrouter.ts` não lê o ambiente (nem importa Node): quem traduz
//      OPENROUTER_* é `src/gatewayEnv.ts`, chamado pelos pontos de entrada;
//  (b) com transporte FALSO, `usage.cost` medido prevalece sobre o catálogo
//      (catálogo = fallback 'catalog'; sem os dois = 'unknown', nunca "grátis")
//      e soma(papéis) == total no ledger (ponto único: role + sink);
//  (c) limitador AIMD POR INSTÂNCIA: 429 → recuo pela metade, retry ≤ 6.
// O pipeline inteiro (Node e web) é exercitado em gateway-pipeline.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createGateway,
  DEFAULT_OPENROUTER_BASE_URL,
  extractUsage,
  getGateway,
  MAX_RETRIES,
  OpenRouterGateway,
  priceUsage,
  setDefaultGateway,
} from '../src/openrouter.js';
import { gatewayConfigFromEnv } from '../src/gatewayEnv.js';
import { BudgetLedger, isControlSignal } from '../src/budget.js';
import { COST_ROLES, type CostRole } from '../src/types.js';
import { generateStages } from '../src/datagen.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('IMPL-021 (a) — o gateway não lê o ambiente; os pontos de entrada injetam', () => {
  it('src/openrouter.ts não menciona process.env nem importa node:*', () => {
    const fonte = readFileSync(`${ROOT}src/openrouter.ts`, 'utf8');
    expect(fonte).not.toContain('process.env');
    expect(fonte).not.toMatch(/from ['"]node:/);
  });

  it('pontos de entrada Node configuram a partir do ambiente (CLI, servidor, biblioteca)', () => {
    for (const arq of ['src/cli/index.ts', 'src/server.ts', 'src/index.ts']) {
      expect(readFileSync(`${ROOT}${arq}`, 'utf8'), arq).toContain('configureGatewayFromEnv()');
    }
  });

  it('defaults sem configuração = comportamento histórico com o ambiente vazio', () => {
    const cfg = new OpenRouterGateway().config;
    expect(cfg.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(cfg.appUrl).toBe('http://localhost:3000');
    expect(cfg.appTitle).toBe('Prompt Builder');
    expect(cfg.maxConcurrency).toBe(32);
    expect(new OpenRouterGateway().currentConcurrency().limit).toBe(8);
  });

  it('gatewayConfigFromEnv traduz OPENROUTER_* (e ignora concorrência não numérica)', () => {
    expect(gatewayConfigFromEnv({})).toEqual({});
    const cfg = gatewayConfigFromEnv({
      OPENROUTER_BASE_URL: 'http://proxy.local/api/v1///',
      OPENROUTER_APP_URL: 'https://app.exemplo',
      OPENROUTER_APP_TITLE: 'Meu App',
      OPENROUTER_MAX_CONCURRENCY: '4',
    });
    const gw = createGateway(cfg);
    expect(gw.config.baseUrl).toBe('http://proxy.local/api/v1');
    expect(gw.config.appUrl).toBe('https://app.exemplo');
    expect(gw.config.appTitle).toBe('Meu App');
    expect(gw.config.maxConcurrency).toBe(4);
    expect(gw.currentConcurrency().limit).toBe(4); // min(8, teto)
    // Antes: Number('abc') = NaN travava o semáforo para sempre.
    expect(gatewayConfigFromEnv({ OPENROUTER_MAX_CONCURRENCY: 'abc' })).toEqual({});
    expect(gatewayConfigFromEnv({ OPENROUTER_BASE_URL: '   ' })).toEqual({});
  });

  it('base URL e headers de atribuição vêm da config injetada', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: 'oi' }) });
    const gw = createGateway({
      baseUrl: 'http://proxy.local/v1/',
      appUrl: 'https://spa.exemplo',
      appTitle: 'Titulo X',
      fetch: fake.fetch,
    });
    await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: [{ role: 'user', content: 'a' }] });
    await gw.listModels(KEY);
    expect((await gw.validateKey(KEY)).ok).toBe(true);
    expect(fake.requests.map((r) => r.url)).toEqual([
      'http://proxy.local/v1/chat/completions',
      'http://proxy.local/v1/models',
      'http://proxy.local/v1/key',
    ]);
    for (const r of fake.requests) {
      expect(r.headers['HTTP-Referer']).toBe('https://spa.exemplo');
      expect(r.headers['X-Title']).toBe('Titulo X');
      expect(r.headers.Authorization).toBe(`Bearer ${KEY}`);
    }
  });

  it('configure() é em lugar: cache de catálogo e limitador sobrevivem', async () => {
    const gw = createGateway();
    gw.primeModelsCache(KEY, [
      { id: 'a/b', name: 'a/b', pricing: { prompt: 1e-6, completion: 1e-6 } },
    ]);
    gw.configure({ appTitle: 'outro', maxConcurrency: 2 });
    expect(gw.peekModelsCache(KEY)?.data).toHaveLength(1);
    expect(gw.currentConcurrency().limit).toBe(2);
    // patch com obrigatório undefined não apaga a base
    gw.configure({ baseUrl: undefined });
    expect(gw.config.baseUrl).toBe(DEFAULT_OPENROUTER_BASE_URL);
  });

  it('fetch ausente = globalThis.fetch resolvido na hora (stubGlobal funciona)', async () => {
    const fake = fakeOpenRouter({ catalog: [catalogItem('g/h', 1e-6, 1e-6)] });
    vi.stubGlobal('fetch', fake.fetch);
    try {
      const models = await createGateway().listModels(KEY);
      expect(models.map((m) => m.id)).toEqual(['g/h']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shim do web: configuração do navegador usa a origem da página', async () => {
    const web = await import('../web/src/engine/openrouter.js');
    expect(web.browserGatewayConfig().appUrl).toBe('https://prompt-builder'); // sem window
    vi.stubGlobal('window', { location: { origin: 'https://spa.vercel.app' } });
    try {
      expect(web.browserGatewayConfig()).toEqual({
        baseUrl: DEFAULT_OPENROUTER_BASE_URL,
        appUrl: 'https://spa.vercel.app',
        appTitle: 'Prompt Builder',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('IMPL-021 (b) — usage.cost medido prevalece sobre o catálogo', () => {
  // Catálogo: 1e-6/token de entrada, 2e-6 de saída; faixa ≥ 2000 tokens = 3e-6/4e-6.
  const catalogo = [
    catalogItem('m/pago', 1e-6, 2e-6, {
      pricing: {
        prompt: '0.000001',
        completion: '0.000002',
        overrides: [{ min_prompt_tokens: 2000, prompt: '0.000003', completion: '0.000004' }],
      },
    }),
  ];
  const msgs = [{ role: 'user' as const, content: 'pergunta' }];

  async function gatewayCom(chat: Parameters<typeof fakeOpenRouter>[0]['chat']) {
    const fake = fakeOpenRouter({ catalog: catalogo, chat });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    await gw.listModels(KEY); // catálogo quente: o fallback EXISTE, mas perde para usage.cost
    return { gw, fake };
  }

  it('JSON: usage.cost vence o catálogo (source "usage")', async () => {
    const { gw } = await gatewayCom(() => ({
      text: 'r',
      usage: { prompt_tokens: 1000, completion_tokens: 500, cost: 0.0421, cost_details: { upstream_inference_cost: 0.01 } },
    }));
    const r = await gw.chatCompletion({ apiKey: KEY, modelId: 'm/pago', messages: msgs });
    expect(r.cost).toEqual({ usd: 0.0421, source: 'usage', upstreamUsd: 0.01 });
    // O catálogo diria 1000*1e-6 + 500*2e-6 = 0.002 — o valor medido manda.
    expect(r.cost.usd).not.toBeCloseTo(0.002, 6);
  });

  it('sem usage.cost: catálogo como fallback (com faixa de preço) — source "catalog"', async () => {
    const { gw } = await gatewayCom(() => ({
      text: 'r',
      usage: { prompt_tokens: 3000, completion_tokens: 100 },
    }));
    const r = await gw.chatCompletion({ apiKey: KEY, modelId: 'm/pago', messages: msgs });
    expect(r.cost.source).toBe('catalog');
    expect(r.cost.usd).toBeCloseTo(3000 * 3e-6 + 100 * 4e-6, 12); // faixa ≥ 2000
  });

  it('sem usage.cost e fora do catálogo: "unknown" (nunca "custou zero" medido)', async () => {
    const { gw } = await gatewayCom(() => ({ text: 'r', usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    const r = await gw.chatCompletion({ apiKey: KEY, modelId: 'fora/do-catalogo', messages: msgs });
    expect(r.cost).toEqual({ usd: 0, source: 'unknown' });
  });

  it('stream: usage do frame final vale mesmo com keep-alive depois; sem usage:{include} deprecado', async () => {
    const { gw, fake } = await gatewayCom(() => ({
      text: 'resposta em stream',
      usage: { prompt_tokens: 50, completion_tokens: 20, cost: 0.0077 },
      trailing: [': OPENROUTER PROCESSING', JSON.stringify({ choices: [{ delta: {} }] })],
    }));
    const deltas: string[] = [];
    const r = await gw.chatCompletionStream({
      apiKey: KEY,
      modelId: 'm/pago',
      messages: msgs,
      onDelta: (d) => deltas.push(d),
    });
    expect(r.text).toBe('resposta em stream');
    expect(deltas.join('')).toBe('resposta em stream');
    expect(r.cost).toEqual({ usd: 0.0077, source: 'usage', upstreamUsd: undefined });
    const body = fake.chatRequests()[0].body!;
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty('usage');
  });

  it('priceUsage/extractUsage são puros: mesma ordem usage > catálogo > unknown', () => {
    const u = extractUsage({ prompt_tokens: 7, completion_tokens: 3, cost: 0.5 });
    expect(priceUsage(u, undefined)).toEqual({ usd: 0.5, source: 'usage', upstreamUsd: undefined });
    expect(priceUsage({ tokensIn: 7, tokensOut: 3 }, undefined)).toEqual({ usd: 0, source: 'unknown' });
    expect(extractUsage(null)).toEqual({ tokensIn: 0, tokensOut: 0 });
  });

  it('200 com erro in-band: a chamada JÁ cobrada entra no ledger antes do throw', async () => {
    const { gw } = await gatewayCom(() => ({
      text: '',
      error: { message: 'provider rejeitou parametro' },
      usage: { prompt_tokens: 5, completion_tokens: 0, cost: 0.0003 },
    }));
    const ledger = new BudgetLedger();
    await expect(
      gw.chatCompletion({ apiKey: KEY, modelId: 'm/pago', messages: msgs, role: 'judge', sink: ledger }),
    ).rejects.toThrow(/provider rejeitou/);
    expect(ledger.spentUsd).toBeCloseTo(0.0003, 12);
    expect(ledger.byRole.judge.calls).toBe(1);
  });
});

describe('IMPL-021 (b) — soma(papéis) == total: contabilidade num ponto só', () => {
  it('cada papel cai no seu balde e a soma bate com o total e com a "fatura"', async () => {
    // Custo distinto por papel: dupla contagem ou papel trocado não passam.
    const custo: Record<CostRole, number> = {
      datagen: 0.011,
      gabarito: 0.013,
      competitor: 0.017,
      judge: 0.019,
      duel: 0.023,
      rewriter: 0.029,
      agent: 0.031,
    };
    const fake = fakeOpenRouter({
      chat: (req) => {
        const role = req.user as CostRole;
        return { text: `ok ${role}`, usage: { prompt_tokens: 100, completion_tokens: 10, cost: custo[role] } };
      },
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const pai = new BudgetLedger();
    const ledger = pai.fork(); // run filha de uma sessão: o gasto sobe para o pai
    for (const role of COST_ROLES) {
      const call = role === 'competitor' ? gw.chatCompletionStream.bind(gw) : gw.chatCompletion.bind(gw);
      await call({ apiKey: KEY, modelId: 'x/y', messages: [{ role: 'user', content: role }], role, sink: ledger });
    }
    const soma = COST_ROLES.reduce((s, r) => s + ledger.byRole[r].usd, 0);
    expect(soma).toBeCloseTo(ledger.spentUsd, 12);
    expect(ledger.spentUsd).toBeCloseTo(fake.billedUsd(), 12);
    for (const r of COST_ROLES) {
      expect(ledger.byRole[r].usd, r).toBeCloseTo(custo[r], 12);
      expect(ledger.byRole[r].calls, r).toBe(1);
    }
    expect(ledger.accuracy).toEqual({ exact: COST_ROLES.length, estimated: 0, unknown: 0 });
    expect(pai.spentUsd).toBeCloseTo(ledger.spentUsd, 12);
    expect(ledger.committedUsd).toBeCloseTo(ledger.spentUsd, 12); // sem reserva pendurada
  });

  it('chamada sem role explícito conta como competidor (default histórico)', async () => {
    const fake = fakeOpenRouter();
    const gw = createGateway({ fetch: fake.fetch });
    const ledger = new BudgetLedger();
    await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: [{ role: 'user', content: 'a' }], sink: ledger });
    expect(ledger.byRole.competitor.calls).toBe(1);
  });
});

describe('IMPL-021 (c) — limitador AIMD por instância', () => {
  const msgs = [{ role: 'user' as const, content: 'x' }];

  it('429 → recua pela metade a cada vez (8→4→2→1) e depois conclui; outra instância intacta', async () => {
    let gw!: OpenRouterGateway;
    const limites: number[] = [];
    const esperas: number[] = [];
    const fake = fakeOpenRouter({
      chat: (_req, n) => {
        limites.push(gw.currentConcurrency().limit);
        return n < 3 ? { status: 429, bodyText: 'rate limited' } : { text: 'ok' };
      },
    });
    gw = createGateway({ fetch: fake.fetch, sleep: async (ms) => void esperas.push(ms) });
    const outra = createGateway({ fetch: fake.fetch, sleep: noSleep });

    const r = await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs });
    expect(r.text).toBe('ok');
    expect(limites).toEqual([8, 4, 2, 1]);
    expect(fake.chatRequests()).toHaveLength(4);
    // Backoff exponencial com jitter < 250 ms: 250·2^tentativa.
    esperas.forEach((ms, i) => {
      expect(ms).toBeGreaterThanOrEqual(250 * 2 ** i);
      expect(ms).toBeLessThan(250 * 2 ** i + 250);
    });
    expect(outra.currentConcurrency().limit).toBe(8); // estado é da instância, não do módulo
    expect(getGateway().currentConcurrency().limit).toBe(8);
  });

  it('429 persistente: no máximo 6 re-tentativas (7 envios) e erro PT-BR claro; piso 1', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ status: 429, bodyText: 'slow down' }) });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    await expect(gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs })).rejects.toThrow(
      /rate limit \(HTTP 429\)/,
    );
    expect(MAX_RETRIES).toBe(6);
    expect(fake.chatRequests()).toHaveLength(1 + MAX_RETRIES);
    expect(gw.currentConcurrency()).toEqual({ limit: 1, active: 0, queued: 0 });
  });

  it('5xx repete SEM recuar o limite; 4xx não repete', async () => {
    const fake = fakeOpenRouter({
      chat: (_req, n) => (n < 2 ? { status: 502, bodyText: 'bad gateway' } : { text: 'ok' }),
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs });
    expect(fake.chatRequests()).toHaveLength(3);
    expect(gw.currentConcurrency().limit).toBe(8);

    const fake400 = fakeOpenRouter({ chat: () => ({ status: 400, bodyText: 'bad' }) });
    const gw400 = createGateway({ fetch: fake400.fetch, sleep: noSleep });
    await expect(gw400.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs })).rejects.toThrow(/HTTP 400/);
    expect(fake400.chatRequests()).toHaveLength(1);
  });

  it('abort externo não repete (e libera o slot)', async () => {
    const fake = fakeOpenRouter();
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const ac = new AbortController();
    ac.abort(new Error('cancelado'));
    const err = await gw
      .chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs, signal: ac.signal })
      .catch((e: unknown) => e);
    expect(String((err as Error).message)).toMatch(/cancelado/);
    // IMPL-020: sinal já abortado nem chega ao transporte (antes: 1 pedido
    // saía mesmo assim) e sai como SINAL DE CONTROLE — um erro comum seria
    // degradado pelos papéis em nota inventada.
    expect(isControlSignal(err)).toBe(true);
    expect(fake.chatRequests()).toHaveLength(0);
    expect(gw.currentConcurrency().active).toBe(0);
  });

  it('teto por instância: maxConcurrency 2 nunca deixa passar 3 em voo', async () => {
    let emVoo = 0;
    let pico = 0;
    const liberar: Array<() => void> = [];
    const fake = fakeOpenRouter({
      chat: async () => {
        emVoo += 1;
        pico = Math.max(pico, emVoo);
        await new Promise<void>((r) => liberar.push(r));
        emVoo -= 1;
        return { text: 'ok' };
      },
    });
    const gw = createGateway({ fetch: fake.fetch, maxConcurrency: 2 });
    const todas = Array.from({ length: 5 }, () =>
      gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs }),
    );
    for (let i = 0; i < 50 && liberar.length < 2; i++) await new Promise((r) => setTimeout(r, 1));
    expect(gw.currentConcurrency()).toMatchObject({ active: 2, queued: 3 });
    while (liberar.length || emVoo) {
      liberar.splice(0).forEach((r) => r());
      await new Promise((r) => setTimeout(r, 1));
    }
    await Promise.all(todas);
    expect(pico).toBe(2);
    expect(gw.currentConcurrency().limit).toBeLessThanOrEqual(2);
  });
});

describe('IMPL-021 — shim do datagen unificado (regras do perfil vão no system)', () => {
  it('generateStages com regras envia o grounding renderizado + contrato JSON no system', async () => {
    const cenario = {
      question: 'Qual o prazo de troca do produto X?',
      productContext: 'Politica: trocas em ate 30 dias.',
      maxTokens: 300,
      rubric: 'Deve citar 30 dias.',
    };
    const fake = fakeOpenRouter({ chat: () => ({ text: JSON.stringify({ stages: [cenario] }) }) });
    const anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    try {
      const out = await generateStages({
        apiKey: KEY,
        theme: 'trocas',
        count: 1,
        modelId: 'x/gen',
        rules: {
          templates: { system: 'GROUNDING-DO-PERFIL: {{context}}', user: 'Tema {{theme}}' },
          grounding: { context: 'catalogo real da loja' },
        },
      });
      expect(out).toHaveLength(1);
      const system = fake.chatRequests()[0].system;
      expect(system.startsWith('GROUNDING-DO-PERFIL: catalogo real da loja')).toBe(true);
      expect(system).toContain('Voce e um gerador de cenarios de benchmark');
    } finally {
      setDefaultGateway(anterior);
    }
  });
});
