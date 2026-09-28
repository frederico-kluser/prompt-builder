// IMPL-114 (R-08:REC-4) — cache de prompt do provedor: `cache_control` no fim do
// prefixo estável + medição via `prompt_tokens_details.cached_tokens`.
//
// Contratos provados aqui:
//  (i)  `cacheControlAfter: k` posiciona `cache_control: {type:'ephemeral'}` na
//       mensagem k (o fim do prefixo estável — no refJudge, a RÚBRICA) e SÓ
//       nela; as mensagens seguintes (o candidato, que muda a cada chamada)
//       ficam fora do prefixo cacheado;
//  (ii) sem o pedido explícito NADA muda no corpo (fail-closed: cache no lugar
//       errado seria pior que cache nenhum) e índice fora do alcance deixa o
//       corpo intacto;
//  (iii) a medição de ganho é `usage.prompt_tokens_details.cached_tokens`
//       (extraído como `cachedTokensIn` — o ganho nunca é prometido, é medido);
//  (iv)  o layout de mensagens do julgamento está DOCUMENTADO e versionado
//       (v1) junto do parâmetro — mudar o layout invalida o cache e isso tem
//       de ser uma decisão visível, não um acidente.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createGateway, resetCostSamples, setDefaultGateway } from '../src/openrouter.js';
import { fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-impl114-0000000000000000';
const raiz = fileURLToPath(new URL('..', import.meta.url));

const CATALOGO = [
  {
    id: 'anthropic/claude-x',
    name: 'claude-x',
    context_length: 128_000,
    pricing: { prompt: 3e-6, completion: 15e-6 },
  },
];

/** O layout do refJudge v1: REFERENCIA → PERGUNTA → RUBRICA → CANDIDATO. */
const MENSAGENS = [
  { role: 'system' as const, content: 'REFERENCIA: o gabarito da resposta.' },
  { role: 'user' as const, content: 'PERGUNTA: qual o prazo de troca?' },
  { role: 'user' as const, content: 'RUBRICA: exige prazo e nota fiscal.' },
  { role: 'user' as const, content: 'CANDIDATO: a resposta que muda a cada chamada.' },
];

type Corpo = { messages?: Array<Record<string, unknown>> };

async function comGateway<T>(fake: ReturnType<typeof fakeOpenRouter>, fn: (gw: ReturnType<typeof createGateway>) => Promise<T>): Promise<T> {
  const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
  const anterior = setDefaultGateway(gw);
  try {
    await gw.listModels(KEY);
    return await fn(gw);
  } finally {
    setDefaultGateway(anterior);
    resetCostSamples();
  }
}

afterEach(() => resetCostSamples());

describe('IMPL-114 (i/ii) — `cache_control` no fim do prefixo estável, e só lá', () => {
  it('posiciona o cache_control na mensagem `cacheControlAfter` (fim do prefixo)', async () => {
    const fake = fakeOpenRouter({ catalog: CATALOGO, chat: () => ({ text: 'resolve' }) });
    await comGateway(fake, (gw) =>
      gw.chatCompletion({
        apiKey: KEY,
        modelId: 'anthropic/claude-x',
        messages: MENSAGENS,
        maxTokens: 300,
        role: 'judge',
        cacheControlAfter: 2, // a RÚBRICA fecha o prefixo estável
      }),
    );
    const msgs = (fake.chatRequests()[0].body as Corpo).messages!;
    expect(msgs).toHaveLength(4);
    // Só a mensagem k leva a marca de cache…
    expect(msgs[2].cache_control).toEqual({ type: 'ephemeral' });
    // …e as outras ficam limpas (o candidato NÃO entra no prefixo cacheado).
    expect(msgs[0].cache_control).toBeUndefined();
    expect(msgs[1].cache_control).toBeUndefined();
    expect(msgs[3].cache_control).toBeUndefined();
  });

  it('sem `cacheControlAfter` o corpo não muda; índice fora do alcance é fail-closed', async () => {
    const fake = fakeOpenRouter({ catalog: CATALOGO, chat: () => ({ text: 'resolve' }) });
    await comGateway(fake, async (gw) => {
      await gw.chatCompletion({
        apiKey: KEY,
        modelId: 'anthropic/claude-x',
        messages: MENSAGENS,
        maxTokens: 300,
        role: 'judge',
      });
      await gw.chatCompletion({
        apiKey: KEY,
        modelId: 'anthropic/claude-x',
        messages: MENSAGENS,
        maxTokens: 300,
        role: 'judge',
        cacheControlAfter: 99, // fora do alcance
      });
    });
    for (const req of fake.chatRequests()) {
      const msgs = (req.body as Corpo).messages!;
      for (const m of msgs) expect(m.cache_control).toBeUndefined();
    }
  });

  it('vale também no transporte streaming (o corpo SSE leva o mesmo layout)', async () => {
    const fake = fakeOpenRouter({ catalog: CATALOGO, chat: () => ({ text: 'parcial' }) });
    await comGateway(fake, (gw) =>
      gw.chatCompletion({
        apiKey: KEY,
        modelId: 'anthropic/claude-x',
        messages: MENSAGENS,
        maxTokens: 300,
        role: 'judge',
        streamTransport: true,
        cacheControlAfter: 2,
      }),
    );
    const req = fake.chatRequests()[0];
    expect(req.stream).toBe(true);
    const msgs = (req.body as Corpo).messages!;
    expect(msgs[2].cache_control).toEqual({ type: 'ephemeral' });
    expect(msgs.filter((m) => m.cache_control !== undefined)).toHaveLength(1);
  });
});

describe('IMPL-114 (iii) — o ganho é MEDIDO em `cached_tokens`, nunca prometido', () => {
  it('`prompt_tokens_details.cached_tokens` chega como `cachedTokensIn`', async () => {
    const fake = fakeOpenRouter({
      catalog: CATALOGO,
      chat: () => ({
        text: 'resolve',
        usage: {
          prompt_tokens: 500,
          completion_tokens: 40,
          cost: 0.002,
          prompt_tokens_details: { cached_tokens: 420 },
        },
      }),
    });
    const r = await comGateway(fake, (gw) =>
      gw.chatCompletion({
        apiKey: KEY,
        modelId: 'anthropic/claude-x',
        messages: MENSAGENS,
        maxTokens: 300,
        role: 'judge',
        cacheControlAfter: 2,
      }),
    );
    expect(r.cachedTokensIn).toBe(420);
  });
});

describe('IMPL-114 (iv) — layout de mensagens do julgamento versionado (v1)', () => {
  const fonte = readFileSync(join(raiz, 'src', 'openrouter.ts'), 'utf-8');

  it('o layout v1 está documentado junto do parâmetro (quebra após a RÚBRICA)', () => {
    expect(fonte).toMatch(/LAYOUT DE MENSAGENS DO JULGAMENTO — v1/);
    expect(fonte).toMatch(/RUBRICA.*prefixo ESTÁVEL|prefixo ESTÁVEL.*RUBRICA/s);
  });

  it('a documentação não promete ganho sem cache_control nem aquecimento', () => {
    expect(fonte).toMatch(/NENHUM ganho é prometido/);
    expect(fonte).toMatch(/cached_tokens/);
  });
});
