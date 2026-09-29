// Transporte do gateway (onda 1, cluster gateway) — transporte falso, zero rede:
//   IMPL-072: streaming é o DEFAULT de runtime (Node por gatewayConfigFromEnv,
//     SPA por browserGatewayConfig) para juiz/duelo/gabarito/datagen/reescritor,
//     com válvula OPENROUTER_STREAM_TRANSPORT=0; um corpo JSON devolvido a um
//     pedido de stream (proxy/mock) é lido igual (mesmo custo, mesmos sinais);
//     e a run completa em streaming não perde veredito;
//   IMPL-073: rajada de 20× 429 => <= 5 tentativas HTTP por RESPOSTA do
//     competidor (antes 14), esperando >= Retry-After;
//   IMPL-077: /models, /key e /generation com corpo TRAVADO abortam no teto
//     (o timer cobre o corpo, não só os headers); OPENROUTER_ROLE_TIMEOUTS;
//   IMPL-114: juiz Anthropic recebe o prefixo estável numa mensagem com
//     `cache_control` (parte de conteúdo), IGUAL entre candidatos da etapa; os
//     outros juízes seguem com a montagem de sempre; aquecimento: a 1ª chamada
//     de um prefixo vai sozinha, as demais esperam ela terminar;
//   IMPL-120 (4): PROMPT_BUILDER_NO_ATTRIBUTION suprime HTTP-Referer/X-Title
//     NO FIO (chat, /models, /key, /generation), no Node e na SPA.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion } from '../src/orchestrator.js';
import {
  createGateway,
  getGateway,
  isCallerRetryable,
  isGatewayTimeout,
  GatewayError,
  setDefaultGateway,
  supportsPromptCacheControl,
  type FetchLike,
  type OpenRouterGateway,
} from '../src/openrouter.js';
import { gatewayConfigFromEnv, parseRoleTimeouts } from '../src/gatewayEnv.js';
import { BudgetLedger } from '../src/budget.js';
import { runCompetitor } from '../src/competitor.js';
import { judgeStageReference } from '../src/refJudge.js';
import { generateReferences } from '../src/gabarito.js';
import { generateStages } from '../src/datagen.js';
import { llmReflectLessons } from '../src/variator.js';
import type { CompetitorResponse, Contestant, StageSpec } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { duelReply, pointwiseReply } from './judgeReplies.js';

const KEY = 'sk-or-v1-fake-key-transport-00000000000';
const msgs = [{ role: 'user' as const, content: 'Diga oi.' }];

let anterior: OpenRouterGateway | undefined;
afterEach(() => {
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
  vi.unstubAllGlobals();
});

describe('IMPL-072 — streaming é o default de RUNTIME em todos os papéis', () => {
  it('gatewayConfigFromEnv liga o stream; OPENROUTER_STREAM_TRANSPORT=0 é a válvula', () => {
    expect(gatewayConfigFromEnv({}).streamTransport).toBe(true);
    for (const v of ['0', 'off', 'false', 'no']) {
      expect(gatewayConfigFromEnv({ OPENROUTER_STREAM_TRANSPORT: v }).streamTransport, v).toBe(false);
    }
    expect(gatewayConfigFromEnv({ OPENROUTER_STREAM_TRANSPORT: '1' }).streamTransport).toBe(true);
  });

  it('SPA: browserGatewayConfig liga o stream no navegador', async () => {
    const web = await import('../web/src/engine/openrouter.js');
    vi.stubGlobal('window', { location: { origin: 'https://spa.exemplo' } });
    expect(web.browserGatewayConfig(undefined).streamTransport).toBe(true);
  });

  it('gateway de runtime: juiz/duelo/gabarito/datagen/reescritor vão com stream:true (os papéis reais)', async () => {
    const fake = fakeOpenRouter({
      catalog: [catalogItem('m/x', 1e-6, 1e-6)],
      chat: (req) => {
        if (req.system.includes('DUELO')) return { text: '{"winner":"A"}' };
        if (/cenario|cenários|stages/i.test(req.system + req.user) && req.body?.response_format) {
          return { text: JSON.stringify({ stages: [{ question: 'Pergunta longa o bastante?', productContext: 'Contexto.', maxTokens: 200 }] }) };
        }
        return { text: pointwiseReply(req, 'resolve') };
      },
    });
    anterior = setDefaultGateway(createGateway({ ...gatewayConfigFromEnv({}), fetch: fake.fetch, sleep: noSleep }));
    const ledger = new BudgetLedger();
    const ctx = { sink: ledger };
    const silencio = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await generateStages({ apiKey: KEY, modelId: 'm/x', theme: 'suporte', count: 1, ctx } as never).catch(() => undefined);
      await generateReferences({
        apiKey: KEY,
        modelId: 'm/x',
        stages: [{ question: 'Qual o prazo?', productContext: 'Trinta dias.', maxTokens: 200 }],
        ctx,
      } as never).catch(() => undefined);
      await llmReflectLessons({ apiKey: KEY, modelId: 'm/x', baseLessons: '- errou o prazo', ctx } as never).catch(
        () => undefined,
      );
      // Duelo: a decisão de transporte é do gateway (não do papel) — o mesmo default.
      await getGateway().chatCompletion({ apiKey: KEY, modelId: 'm/x', messages: [{ role: 'system', content: 'DUELO' }], role: 'duel', sink: ledger });
      const stage: StageSpec = { question: 'Qual o prazo?', productContext: 'Trinta dias.', maxTokens: 200, reference: 'Trinta dias.' };
      await judgeStageReference({
        stage,
        responses: [{ contestantId: 'c1', modelId: 'm/x', text: 'Trinta dias.', latencyMs: 1, tokensIn: 1, tokensOut: 1, costUsd: 0, status: 'ok' }],
        contestants: [{ id: 'c1', label: 'c1', modelId: 'm/x', systemPrompt: 's' } as Contestant],
        judgeModelIds: ['m/x'],
        apiKey: KEY,
        ctx,
      });
    } finally {
      silencio.mockRestore();
    }
    const papeis = ['datagen', 'gabarito', 'rewriter', 'duel', 'judge'] as const;
    const papeisComChamada = papeis.filter((r) => ledger.snapshot().byRole[r].calls > 0);
    expect(papeisComChamada).toEqual([...papeis]);
    // TODO pedido de chat saiu em stream (inclusive os de response_format JSON).
    expect(fake.chatRequests().length).toBeGreaterThanOrEqual(3);
    for (const r of fake.chatRequests()) expect(r.stream, r.system.slice(0, 40)).toBe(true);
    const comFormato = fake.chatRequests().filter((r) => r.body?.response_format);
    expect(comFormato.length).toBeGreaterThan(0); // stream + response_format juntos
  });

  it('pedido de stream respondido com JSON inteiro (proxy/mock): mesmo texto, custo medido e sinais', async () => {
    const soJson: FetchLike = async () =>
      new Response(
        JSON.stringify({
          id: 'gen-1758926640-aaaaaaaaaaaaaaaaaaaa',
          provider: 'OpenAI',
          choices: [{ message: { content: 'ola' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0.0003 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const gw = createGateway({ fetch: soJson, sleep: noSleep, streamTransport: true });
    const ledger = new BudgetLedger();
    const deltas: string[] = [];
    const r = await gw.chatCompletionStream({
      apiKey: KEY,
      modelId: 'x/y',
      messages: msgs,
      role: 'judge',
      sink: ledger,
      onDelta: (_d, full) => deltas.push(full),
    });
    expect(r.text).toBe('ola');
    expect(r.finishReason).toBe('stop');
    expect(r.cost).toEqual({ usd: 0.0003, source: 'usage' });
    expect(r.provider?.name).toBe('OpenAI');
    expect(deltas).toEqual(['ola']);
    expect(ledger.spentUsd).toBeCloseTo(0.0003, 12);
    expect(ledger.callLog()[0].generationId).toBe('gen-1758926640-aaaaaaaaaaaaaaaaaaaa');
  });

  it('erro in-band num corpo JSON 200 a um pedido de stream: contabiliza ANTES de lançar', async () => {
    const soJson: FetchLike = async () =>
      new Response(JSON.stringify({ error: { message: 'provider rejeitou' }, usage: { prompt_tokens: 1, completion_tokens: 0, cost: 0.0001 } }), {
        status: 200,
      });
    const gw = createGateway({ fetch: soJson, sleep: noSleep, streamTransport: true });
    const ledger = new BudgetLedger();
    await expect(gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs, role: 'duel', sink: ledger })).rejects.toThrow(
      /provider rejeitou/,
    );
    expect(ledger.spentUsd).toBeCloseTo(0.0001, 12);
  });
});

describe('IMPL-073 — no máximo 5 tentativas HTTP por resposta', () => {
  it('20× 429 consecutivos: o competidor faz <= 5 POSTs e espera >= Retry-After', async () => {
    const esperas: number[] = [];
    const fake = fakeOpenRouter({
      chat: (_req, n) =>
        n < 20
          ? new Response('slow down', { status: 429, headers: { 'retry-after': '1' } })
          : { text: 'ok' },
    });
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: async (ms) => void esperas.push(ms) }));
    const silencio = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const r = await runCompetitor({
        apiKey: KEY,
        contestantId: 'c',
        modelId: 'x/y',
        stage: { question: 'Oi?', productContext: 'ctx', maxTokens: 100 },
        retries: 1, // o laço externo NÃO repete o que o gateway já re-tentou
      });
      expect(r.status).toBe('error');
    } finally {
      silencio.mockRestore();
    }
    expect(fake.chatRequests().length).toBeLessThanOrEqual(5);
    expect(esperas.length).toBeGreaterThan(0);
    for (const ms of esperas) expect(ms).toBeGreaterThanOrEqual(1000);
  });

  it('isCallerRetryable: HTTP classificado / pós-despacho / pré-envio esgotado não repetem; timeout repete', () => {
    expect(isCallerRetryable(new GatewayError('rate_limit', 'x', { httpStatus: 429 }))).toBe(false);
    expect(isCallerRetryable(new GatewayError('http', 'x', { httpStatus: 502 }))).toBe(false);
    expect(isCallerRetryable(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }))).toBe(false);
    expect(isCallerRetryable(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))).toBe(true);
    expect(isCallerRetryable(new Error('OpenRouter: provider rejeitou'))).toBe(true);
  });
});

/** Transporte cujo corpo manda os headers 200 e TRAVA (nunca termina). */
const corpoTravado: FetchLike = async (_url, init) => {
  const signal = init?.signal;
  const corpo = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode('{"data": ['));
      signal?.addEventListener('abort', () => ctrl.error(signal.reason), { once: true });
    },
  });
  return new Response(corpo, { status: 200 });
};

describe('IMPL-077 — metadados: o teto cobre o CORPO, não só os headers', () => {
  it('listModels com corpo travado aborta no teto com timeout TIPADO', async () => {
    const gw = createGateway({ fetch: corpoTravado, metaTimeoutMs: 1000 });
    const t0 = Date.now();
    const err = await gw.listModels(KEY).catch((e: unknown) => e);
    expect(isGatewayTimeout(err)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it('validateKey e /generation com corpo travado também voltam dentro do teto', async () => {
    const gw = createGateway({ fetch: corpoTravado, metaTimeoutMs: 1000 });
    const t0 = Date.now();
    const v = await gw.validateKey(KEY);
    expect(v).toMatchObject({ ok: false, network: true });
    expect(await gw.fetchGenerationInfo(KEY, 'gen-1758926640-bbbbbbbbbbbbbbbbbbbb')).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(6000);
  });

  it('OPENROUTER_ROLE_TIMEOUTS (s): inatividade/total por papel, lixo ignorado', () => {
    expect(parseRoleTimeouts('judge=60/120, competitor=90/600, duel=45, bogus=1/2, gabarito=x')).toEqual({
      judge: { idleMs: 60_000, totalMs: 120_000 },
      competitor: { idleMs: 90_000, totalMs: 600_000 },
      duel: { totalMs: 45_000 },
    });
    expect(parseRoleTimeouts('')).toBeUndefined();
    const gw = createGateway(gatewayConfigFromEnv({ OPENROUTER_ROLE_TIMEOUTS: 'judge=30/90', OPENROUTER_META_TIMEOUT_MS: '15000' }));
    expect(gw.config.roleTimeouts?.judge).toEqual({ idleMs: 30_000, totalMs: 90_000 });
    expect(gw.config.metaTimeoutMs).toBe(15_000);
  });
});

describe('IMPL-114 — cache de prompt no juiz Anthropic + aquecimento', () => {
  const STAGE: StageSpec = {
    question: 'Qual o prazo de troca de um tenis?',
    productContext: 'Troca em 30 dias com nota fiscal.',
    maxTokens: 200,
    reference: 'Trinta dias, com nota fiscal.',
    rubric: 'Deve citar 30 dias.',
  };
  const resp = (id: string, text: string): CompetitorResponse => ({
    contestantId: id,
    modelId: 'm/x',
    text,
    latencyMs: 1,
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
    status: 'ok',
  });
  const contestants = ['a', 'b', 'c'].map((id) => ({ id, label: id, modelId: 'm/x', systemPrompt: 's' }) as Contestant);
  const responses = [resp('a', 'Trinta dias.'), resp('b', 'Sete dias.'), resp('c', 'Depende.')];

  it('supportsPromptCacheControl: só a família Anthropic', () => {
    expect(supportsPromptCacheControl('anthropic/claude-sonnet-4.5')).toBe(true);
    expect(supportsPromptCacheControl('openai/gpt-5-mini')).toBe(false);
  });

  it('juiz Anthropic: [system, prefixo com cache_control, candidato]; prefixo IGUAL entre candidatos', async () => {
    const fake = fakeOpenRouter({ chat: (req) => ({ text: pointwiseReply(req, 'resolve') }) });
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    const r = await judgeStageReference({ stage: STAGE, responses, contestants, judgeModelIds: ['anthropic/claude-x'], apiKey: KEY });
    expect(Object.keys(r.verdictByContestant).sort()).toEqual(['a', 'b', 'c']); // nenhum veredito perdido
    const corpos = fake.chatRequests().map((q) => q.body?.messages as Array<{ role: string; content: unknown }>);
    expect(corpos).toHaveLength(3);
    for (const m of corpos) {
      expect(m.map((x) => x.role)).toEqual(['system', 'user', 'user']);
      expect(Array.isArray(m[1].content)).toBe(true);
      expect((m[1].content as Array<Record<string, unknown>>)[0].cache_control).toEqual({ type: 'ephemeral' });
      expect(typeof m[2].content).toBe('string'); // o candidato NÃO entra no prefixo cacheado
    }
    const prefixos = new Set(corpos.map((m) => JSON.stringify(m.slice(0, 2))));
    expect(prefixos.size).toBe(1); // byte a byte igual: é o que o cache do provedor reusa
    const canarios = new Set(corpos.map((m) => /CANÁRIO deste veredito: (\w+)/.exec(String(m[2].content))?.[1]));
    expect(canarios.size).toBe(3); // canário segue NOVO por veredito
  });

  it('juiz não-Anthropic: a montagem de sempre (1 mensagem de usuário, sem cache_control)', async () => {
    const fake = fakeOpenRouter({ chat: (req) => ({ text: pointwiseReply(req, 'resolve') }) });
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    await judgeStageReference({ stage: STAGE, responses, contestants, judgeModelIds: ['openai/gpt-x'], apiKey: KEY });
    for (const q of fake.chatRequests()) {
      const m = q.body?.messages as Array<{ role: string; content: unknown }>;
      expect(m.map((x) => x.role)).toEqual(['system', 'user']);
      expect(JSON.stringify(m)).not.toContain('cache_control');
    }
  });

  it('aquecimento: a 1ª chamada de um prefixo vai sozinha; as demais saem depois dela', async () => {
    let liberar: () => void = () => undefined;
    const trava = new Promise<void>((r) => (liberar = r));
    const ordem: string[] = [];
    let n = 0;
    const fake = fakeOpenRouter({
      chat: async (req) => {
        const i = n++;
        ordem.push(`inicio-${i}`);
        if (i === 0) await trava;
        ordem.push(`fim-${i}`);
        return { text: pointwiseReply(req, 'resolve') };
      },
    });
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    const todas = judgeStageReference({ stage: STAGE, responses, contestants, judgeModelIds: ['anthropic/claude-x'], apiKey: KEY });
    await new Promise((r) => setTimeout(r, 30));
    expect(ordem).toEqual(['inicio-0']); // as outras 2 esperam o aquecimento
    liberar();
    await todas;
    expect(ordem.slice(0, 2)).toEqual(['inicio-0', 'fim-0']);
    expect(ordem).toHaveLength(6);
  });
});

describe('IMPL-120 (4) — PROMPT_BUILDER_NO_ATTRIBUTION vale NO FIO', () => {
  const temAtribuicao = (h: Record<string, string>): boolean =>
    Object.keys(h).some((k) => ['http-referer', 'x-title', 'x-openrouter-categories'].includes(k.toLowerCase()));

  it('Node: sem a flag os headers saem; com a flag, nenhum (chat, /models, /key, /generation)', async () => {
    expect(gatewayConfigFromEnv({ PROMPT_BUILDER_NO_ATTRIBUTION: 'on' }).attribution).toBe(false);
    expect(gatewayConfigFromEnv({}).attribution).toBeUndefined();

    for (const [env, esperado] of [
      [{}, true],
      [{ PROMPT_BUILDER_NO_ATTRIBUTION: '1' }, false],
    ] as const) {
      const fake = fakeOpenRouter({ chat: () => ({ text: 'ok' }) });
      const gw = createGateway({ ...gatewayConfigFromEnv(env), fetch: fake.fetch, sleep: noSleep });
      await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs });
      await gw.listModels(KEY);
      await gw.validateKey(KEY);
      await gw.fetchGenerationInfo(KEY, 'gen-1758926640-cccccccccccccccccccc');
      expect(fake.requests.map((r) => r.path.split('/').pop())).toEqual(['completions', 'models', 'key', 'generation']);
      for (const r of fake.requests) expect(temAtribuicao(r.headers), `${r.path} ${JSON.stringify(env)}`).toBe(esperado);
      for (const r of fake.requests) expect(r.headers.Authorization).toBe(`Bearer ${KEY}`);
    }
  });

  it('SPA: a preferência salva (pb.noAttribution) desliga a atribuição do gateway', async () => {
    const web = await import('../web/src/engine/openrouter.js');
    const mem = new Map<string, string>();
    const store = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
    expect(web.browserGatewayConfig(store).attribution).toBeUndefined();
    web.setAttributionEnabled(false, store);
    expect(mem.get(web.NO_ATTRIBUTION_STORAGE_KEY)).toBe('1');
    expect(web.browserGatewayConfig(store).attribution).toBe(false);
    expect(web.getGateway().config.attribution).toBe(false);
    web.setAttributionEnabled(true, store);
    expect(mem.has(web.NO_ATTRIBUTION_STORAGE_KEY)).toBe(false);
    expect(web.getGateway().config.attribution).toBe(true);
  });
});

describe('IMPL-072 (ii) — run de fumaça INTEIRA em streaming: nenhum veredito perdido', () => {
  it('compare com juiz/duelo/gabarito/datagen em stream: failureCountByRole zerado, vereditos em toda etapa', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-stream-smoke-'));
    const dirAnterior = getDataDir();
    setDataDir(dir);
    const silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    const fake = fakeOpenRouter({
      catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b'].map((id) => catalogItem(id, 1e-6, 1e-6)),
      chat: (req) => {
        if (req.model === 'fake/gen') {
          return {
            text: JSON.stringify({
              stages: [
                { question: 'Qual o prazo de troca de um tenis?', productContext: 'Troca em 30 dias com nota.', maxTokens: 200, rubric: '30 dias.' },
                { question: 'Como calcular juros compostos mensais?', productContext: 'M = C (1 + i)^n.', maxTokens: 200, rubric: 'Formula.' },
              ],
            }),
          };
        }
        if (req.model === 'fake/ref') return { text: `Gabarito: ${req.user.slice(0, 30)}` };
        if (req.model === 'fake/judge') {
          return { text: req.system.includes('DUELO') ? duelReply(req, 'A', 'A') : pointwiseReply(req, 'resolve') };
        }
        return { text: `Resposta de ${req.model}` };
      },
    });
    anterior = setDefaultGateway(createGateway({ ...gatewayConfigFromEnv({}), fetch: fake.fetch, sleep: noSleep }));
    try {
      const rec = await runToCompletion(
        {
          mode: 'compare',
          theme: 'suporte',
          stages: 2,
          datagenModelId: 'fake/gen',
          judgeModelIds: ['fake/judge'],
          referenceModelId: 'fake/ref',
          referenceJudging: true,
          competitorModelIds: ['fake/a', 'fake/b'],
          finalists: 2,
          timeoutMs: 5_000,
        } as never,
        KEY,
      );
      expect(rec.status, rec.error).not.toBe('error');
      for (const r of fake.chatRequests()) expect(r.stream, r.model).toBe(true); // TODO papel em stream
      expect(Object.values(rec.failureCountByRole ?? {}).every((n) => n === 0)).toBe(true);
      for (const st of rec.stages) {
        expect(Object.keys(st.judge?.verdictByContestant ?? {}).length, 'vereditos da etapa').toBe(2);
      }
    } finally {
      silencio.forEach((s) => s.mockRestore());
      setDataDir(dirAnterior);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
