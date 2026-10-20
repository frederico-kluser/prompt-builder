// Modelos LOCAIS (src/localModels.ts): leitura do ambiente, o fetch que atende `local/*` (chat com e sem
// streaming, decisões via /v1/systemone, catálogo mesclado, geração local) e a integração com o gateway
// de verdade — transporte falso, zero rede.

import { describe, expect, it } from 'vitest';
import {
  createLocalModelsFetch,
  localCatalogEntries,
  parseLocalModelsEnv,
  type LocalModelsRegistry,
} from '../src/localModels.js';
import { createGateway, type FetchLike } from '../src/openrouter.js';
import { gatewayConfigFromEnv } from '../src/gatewayEnv.js';

interface Call {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

/** Transporte falso: K2 em :18100, Laya em :18081, nuvem em openrouter.ai. */
function fakeTransport(opts: { delayMs?: number; cloudDown?: boolean } = {}) {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const f: FetchLike = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url: input, method, ...(body ? { body } : {}) });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (input === 'http://127.0.0.1:18100/v1/chat/completions') {
        return new Response(
          JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'olá do K2' }, finish_reason: 'stop' }] }),
          { status: 200 },
        );
      }
      if (input === 'http://127.0.0.1:18081/v1/systemone') {
        return new Response(JSON.stringify({ answers: { serve: { type: 'noul', noul: 0.91 } }, usage: { input_tokens: 412 } }), { status: 200 });
      }
      if (input.startsWith('https://openrouter.ai/api/v1/models')) {
        if (opts.cloudDown) throw new Error('offline');
        return new Response(JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4-flash', pricing: { prompt: '0.0000001', completion: '0.0000003' } }] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ passthrough: input }), { status: 200 });
    } finally {
      inFlight -= 1;
    }
  };
  return { f, calls, maxInFlight: () => maxInFlight };
}

const REG: LocalModelsRegistry = parseLocalModelsEnv({
  PB_LOCAL_MODELS: 'local/laya-ptes=http://127.0.0.1:18081/',
  PB_LOCAL_CHAT: 'local/k2-horizon=http://127.0.0.1:18100/v1',
});

describe('ambiente', () => {
  it('lê decisões e chat; recusa id sem local/, alvo vazio e duplicado', () => {
    const reg = parseLocalModelsEnv({
      PB_LOCAL_MODELS: 'local/laya-ptes=http://127.0.0.1:18081,laya=http://x,local/vazio=',
      PB_LOCAL_CHAT: 'local/k2-horizon=@/tmp/k2.json,local/laya-ptes=http://dup',
      PB_LOCAL_CHAT_CONTEXT: '8192',
      PB_LOCAL_API_KEY: 'segredo',
    });
    expect(reg.models).toEqual([
      { id: 'local/laya-ptes', kind: 'decision', target: 'http://127.0.0.1:18081' },
      { id: 'local/k2-horizon', kind: 'chat', target: '@/tmp/k2.json' },
    ]);
    expect(reg.chatContext).toBe(8192);
    expect(reg.apiKey).toBe('segredo');
    expect(reg.issues).toHaveLength(3);
  });

  it('sem variáveis: o gateway segue com o fetch de sempre', () => {
    expect(gatewayConfigFromEnv({}).fetch).toBeUndefined();
    expect(typeof gatewayConfigFromEnv({ PB_LOCAL_CHAT: 'local/k2=http://127.0.0.1:1/v1' }).fetch).toBe('function');
  });
});

describe('fetch dos modelos locais', () => {
  it('chat local sem streaming: endpoint local, custo 0, id local-', async () => {
    const t = fakeTransport();
    const f = createLocalModelsFetch(t.f, REG, { newId: () => 'local-1' });
    const r = await f('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'local/k2-horizon', messages: [{ role: 'user', content: 'oi' }] }),
    });
    const body = (await r.json()) as { id: string; usage: { cost: number }; choices: Array<{ message: { content: string } }> };
    expect(t.calls.map((c) => c.url)).toEqual(['http://127.0.0.1:18100/v1/chat/completions']);
    expect(t.calls[0].body?.stream).toBe(false);
    expect(body.id).toBe('local-1');
    expect(body.usage.cost).toBe(0);
    expect(body.choices[0].message.content).toBe('olá do K2');
  });

  it('chat local com streaming: um turno SSE com usage e [DONE]', async () => {
    const t = fakeTransport();
    const f = createLocalModelsFetch(t.f, REG);
    const r = await f('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'local/k2-horizon', stream: true, messages: [{ role: 'user', content: 'oi' }] }),
    });
    const text = await r.text();
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toContain('"content":"olá do K2"');
    expect(text).toContain('"cost":0');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('decisão local: /v1/systemone e a forma do endpoint de decisões', async () => {
    const t = fakeTransport();
    const f = createLocalModelsFetch(t.f, REG, { newId: () => 'local-d' });
    const r = await f('https://openrouter.ai/api/alpha/decisions', {
      method: 'POST',
      body: JSON.stringify({ model: 'local/laya-ptes', state: { pedido: 'x' }, questions: { serve: { type: 'noul', instructions: 'serve?' } } }),
    });
    const body = (await r.json()) as Record<string, unknown>;
    expect(t.calls[0].url).toBe('http://127.0.0.1:18081/v1/systemone');
    expect(t.calls[0].body).toEqual({ state: { pedido: 'x' }, questions: { serve: { type: 'noul', instructions: 'serve?' } } });
    expect(body).toMatchObject({ id: 'local-d', model: 'local/laya-ptes', provider: 'local', usage: { input_tokens: 412, output_tokens: 0, cost: 0 } });
  });

  it('catálogo: nuvem + locais; sem rede, só os locais', async () => {
    const online = createLocalModelsFetch(fakeTransport().f, REG);
    const chat = (await (await online('https://openrouter.ai/api/v1/models')).json()) as { data: Array<{ id: string }> };
    expect(chat.data.map((m) => m.id)).toEqual(['deepseek/deepseek-v4-flash', 'local/k2-horizon']);
    const decisions = (await (await online('https://openrouter.ai/api/v1/models?output_modalities=decisions')).json()) as { data: Array<{ id: string }> };
    expect(decisions.data.map((m) => m.id)).toContain('local/laya-ptes');
    const offline = createLocalModelsFetch(fakeTransport({ cloudDown: true }).f, REG);
    const only = (await (await offline('https://openrouter.ai/api/v1/models')).json()) as { data: Array<{ id: string }> };
    expect(only.data.map((m) => m.id)).toEqual(['local/k2-horizon']);
    expect(localCatalogEntries(REG, 'chat')[0]).toMatchObject({ pricing: { prompt: '0', completion: '0' }, context_length: 16384 });
  });

  it('geração local respondida aqui; o resto passa intacto', async () => {
    const t = fakeTransport();
    const f = createLocalModelsFetch(t.f, REG);
    const gen = (await (await f('https://openrouter.ai/api/v1/generation?id=local-xyz')).json()) as { data: { total_cost: number } };
    expect(gen.data.total_cost).toBe(0);
    await f('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash' }) });
    await f('https://openrouter.ai/api/v1/key');
    expect(t.calls.map((c) => c.url)).toEqual(['https://openrouter.ai/api/v1/chat/completions', 'https://openrouter.ai/api/v1/key']);
  });

  it('uma chamada por vez por endpoint local', async () => {
    const t = fakeTransport({ delayMs: 15 });
    const f = createLocalModelsFetch(t.f, REG);
    const one = (): Promise<Response> =>
      f('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'local/k2-horizon', messages: [] }),
      });
    await Promise.all([one(), one(), one()]);
    expect(t.maxInFlight()).toBe(1);
  });

  it('registro vazio devolve o próprio transporte', () => {
    const t = fakeTransport();
    expect(createLocalModelsFetch(t.f, parseLocalModelsEnv({}))).toBe(t.f);
  });
});

describe('gateway com modelos locais', () => {
  it('chatCompletion (streaming de runtime) e decide atendidos localmente, custo 0', async () => {
    const t = fakeTransport();
    const gw = createGateway({ fetch: createLocalModelsFetch(t.f, REG), streamTransport: true, sleep: async () => undefined });
    const chat = await gw.chatCompletion({ apiKey: 'k', modelId: 'local/k2-horizon', messages: [{ role: 'user', content: 'oi' }] });
    expect(chat.text).toBe('olá do K2');
    expect(chat.cost.usd ?? 0).toBe(0);
    expect(chat.finishReason).toBe('stop');
    const dec = await gw.decide({ apiKey: 'k', modelId: 'local/laya-ptes', state: { pedido: 'x' }, questions: { serve: { type: 'noul', instructions: 'serve?' } } });
    expect(dec.answers).toEqual({ serve: { type: 'noul', noul: 0.91 } });
  });
});
