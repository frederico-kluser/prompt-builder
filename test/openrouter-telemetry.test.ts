// IMPL-078 (R-08:REC-5) + IMPL-075 (R-07b:REC-4) — telemetria de uso por papel
// e proveniência do provedor, tudo no PONTO ÚNICO da contabilidade (gateway →
// sink, junto do custo):
//   (i)   os 5 campos por chamada (cached_tokens, reasoning_tokens,
//         finish_reason, latência, estimado x real) chegam ao ledger em 100%
//         das chamadas, em todos os papéis;
//   (ii)  cobertura de preenchimento = 1,0 (toda chamada anotada leva os campos);
//   (iii) contrato dos DOIS whitelists silenciosos (normalizeRunRecord e
//         variationConfigFrom) para os campos novos;
//   (iv)  reasoning tokens SEMPRE etiquetados como subconjunto de tokensOut
//         (o Codex dobra reasoning DENTRO de completion_tokens — nunca somar);
//   (v)   IMPL-075: provider_name gravado em 100% das chamadas (payload ou
//         GET /api/v1/generation com mock), upstream_id/service_tier via
//         /generation, e modo auditável envia require_parameters:true +
//         allow_fallbacks:false (visível no corpo/artefato).
// Tudo com transporte falso: zero rede, zero gasto.

import { describe, expect, it } from 'vitest';
import {
  createGateway,
  extractProviderInfo,
  parseModelsPayload,
  type FetchLike,
} from '../src/openrouter.js';
import { normalizeRunRecord } from '../src/normalize.js';
import { variationConfigFrom } from '../src/trainer.js';
import {
  COST_ROLES,
  type CallProviderInfo,
  type CostEntry,
  type CostRole,
  type CostSink,
  type Reservation,
  type TrainingConfig,
} from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeChatReply, type FakeRequest } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const msgs = [{ role: 'user' as const, content: 'Diga oi.' }];

/** Sink capturador: guarda o que o gateway entrega em note/pending. */
function sinkCapturador() {
  const notes: Array<Record<string, unknown>> = [];
  const pendings: Array<Record<string, unknown>> = [];
  const reserva = (): Reservation => ({ release: () => undefined, status: 'reserved', usd: 0.01 });
  const sink: CostSink = {
    reserve: () => reserva(),
    note: (_r, entry) => void notes.push(entry as unknown as Record<string, unknown>),
    pending: (_r, entry) => void pendings.push(entry as unknown as Record<string, unknown>),
  };
  return { sink, notes, pendings };
}

const USAGE_COMPLETO = {
  prompt_tokens: 20,
  completion_tokens: 10,
  cost: 0.0007,
  prompt_tokens_details: { cached_tokens: 7 },
  completion_tokens_details: { reasoning_tokens: 4 },
};

describe('IMPL-078 (i/ii) — os 5 campos de uso por chamada chegam ao ledger em 100% dos papéis', () => {
  it('todo papel anota cached/reasoning/latência/estimado×real + finish_reason', async () => {
    const fake = fakeOpenRouter({
      catalog: [catalogItem('x/y', 1e-6, 1e-5)],
      chat: (): FakeChatReply => ({ text: 'ok', finishReason: 'stop', usage: USAGE_COMPLETO }),
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    await gw.listModels(KEY); // aquece o catálogo (a estimativa de reserva usa o preço)
    const { sink, notes } = sinkCapturador();

    for (const role of COST_ROLES) {
      await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs, role, sink, maxTokens: 100 });
    }

    expect(notes).toHaveLength(COST_ROLES.length); // cobertura = 1,0
    for (const [i, entry] of notes.entries()) {
      const role = COST_ROLES[i];
      expect(entry.role, `papel ${role}`).toBe(role);
      expect(entry.cachedTokensIn, `papel ${role}: cached_tokens`).toBe(7);
      expect(entry.reasoningTokens, `papel ${role}: reasoning_tokens`).toBe(4);
      expect(entry.tokensOut).toBe(10);
      expect(entry.latencyMs, `papel ${role}: latência`).toBeGreaterThanOrEqual(0);
      // Estimado x real: a estimativa do catálogo viaja junto (real = cost.usd).
      expect(entry.estimatedUsd, `papel ${role}: estimado`).toBeGreaterThan(0);
      expect((entry.cost as { usd: number }).usd).toBeCloseTo(0.0007, 12);
      // finish_reason por chamada (o 5º campo) viaja nos sinais de fim.
      expect((entry.finish as { finishReason?: string }).finishReason).toBe('stop');
    }
  });

  it('chamada sem usage ainda registra latência/provedor no pending (nunca some)', async () => {
    const fake = fakeOpenRouter({ chat: (): FakeChatReply => ({ text: 'ok', usage: null }) });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const { sink, pendings } = sinkCapturador();
    const r = await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs, role: 'judge', sink });
    expect(r.cost.source).toBe('unknown'); // "não medido" ≠ "custou zero"
    expect(pendings).toHaveLength(1);
    expect(pendings[0].reason).toBe('no_usage');
    expect(pendings[0].latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('IMPL-078 (iv) — reasoning tokens sempre etiquetados (subconjunto de tokensOut)', () => {
  it('Codex dobra reasoning dentro de completion_tokens: tokensOut NUNCA vira 16', async () => {
    const fake = fakeOpenRouter({
      chat: (): FakeChatReply => ({ text: 'ok', usage: USAGE_COMPLETO }), // 10 completion, 4 reasoning
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const { sink, notes } = sinkCapturador();
    const r = await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs, sink });
    expect(r.tokensOut).toBe(10); // reasoning já CONTIDO em completion_tokens
    expect(r.reasoningTokens).toBe(4);
    expect(r.cachedTokensIn).toBe(7);
    expect(notes[0].tokensOut).toBe(10);
    expect(notes[0].reasoningTokens).toBe(4); // etiquetado à parte, nunca somado
  });
});

describe('IMPL-075 (i) — provider_name em 100% das chamadas (payload e/ou GET /generation)', () => {
  /** Roteador: chat JSON com/sem `provider`; /generation com a ficha da geração. */
  const roteador = (
    cont: { generation: number; chats: number },
    corpoChat: Record<string, unknown>,
    ficha: Record<string, unknown>,
  ): FetchLike => {
    return async (url, init) => {
      const u = String(url);
      if (u.includes('/generation')) {
        cont.generation += 1;
        return new Response(JSON.stringify({ data: ficha }), { status: 200 });
      }
      if (u.endsWith('/chat/completions')) {
        cont.chats += 1;
        return new Response(JSON.stringify(corpoChat), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };
  };

  const chatComProvider = {
    id: 'gen-9',
    provider: 'Azure',
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: USAGE_COMPLETO,
  };

  it('payload já traz o provedor: registrado sem chamar /generation (modo off)', async () => {
    const cont = { generation: 0, chats: 0 };
    const gw = createGateway({ fetch: roteador(cont, chatComProvider, {}), sleep: noSleep });
    const { sink, notes } = sinkCapturador();
    const r = await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs, role: 'judge', sink });
    expect(r.provider).toEqual({ name: 'Azure' });
    expect((notes[0].provider as CallProviderInfo).name).toBe('Azure');
    expect(cont.generation).toBe(0);
  });

  it("modo 'missing' busca no /generation quando o payload não traz nome (cobertura 1,0)", async () => {
    const cont = { generation: 0, chats: 0 };
    const semProvider = {
      id: 'gen-10',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: USAGE_COMPLETO,
    };
    const gw = createGateway({
      fetch: roteador(cont, semProvider, {
        provider_name: 'OpenAI',
        upstream_id: 'up-42',
        service_tier: 'standard',
        total_cost: 0.0007,
      }),
      sleep: noSleep,
      providerLookup: 'missing',
    });
    const { sink, notes } = sinkCapturador();
    const r = await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs, role: 'judge', sink });
    expect(cont.generation).toBe(1);
    expect(r.provider).toEqual({ name: 'OpenAI', upstreamId: 'up-42', serviceTier: 'standard' });
    expect(notes[0].provider).toEqual({ name: 'OpenAI', upstreamId: 'up-42', serviceTier: 'standard' });
  });

  it("modo 'always' completa upstream_id/service_tier mesmo com o payload nomeado", async () => {
    const cont = { generation: 0, chats: 0 };
    const gw = createGateway({
      fetch: roteador(cont, chatComProvider, { provider_name: 'Azure', upstream_id: 'up-1', service_tier: 'flex' }),
      sleep: noSleep,
      providerLookup: 'always',
    });
    const { sink, notes } = sinkCapturador();
    const r = await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs, role: 'judge', sink });
    expect(cont.generation).toBe(1);
    expect(r.provider).toEqual({ name: 'Azure', upstreamId: 'up-1', serviceTier: 'flex' });
    expect(notes[0].provider).toEqual({ name: 'Azure', upstreamId: 'up-1', serviceTier: 'flex' });
  });

  it('extractProviderInfo tolera payload só com provider_name/upstream_id cru', () => {
    expect(extractProviderInfo({ provider: 'OpenAI' })).toEqual({ name: 'OpenAI' });
    expect(extractProviderInfo({ provider_name: ' Azure ', upstream_id: ' u1 ', service_tier: ' flex ' })).toEqual({
      name: 'Azure',
      upstreamId: 'u1',
      serviceTier: 'flex',
    });
    expect(extractProviderInfo({})).toBeUndefined();
    expect(extractProviderInfo(null)).toBeUndefined();
  });
});

describe('IMPL-075 (ii) — modo auditável: require_parameters + allow_fallbacks:false no corpo', () => {
  /** Corpo capturado por papel; replies JSON simples. */
  const corposPorPapel = async (opts: {
    auditableRoles?: CostRole[];
    auditablePorChamada?: boolean;
    maxPrice?: { prompt: number; completion: number };
  }): Promise<{ corpos: Record<string, unknown>[]; auditable: Array<boolean | undefined> }> => {
    const fake = fakeOpenRouter({
      catalog: [catalogItem('x/y', 1e-6, 1e-5)],
      chat: (): FakeChatReply => ({ text: 'ok', finishReason: 'stop' }),
    });
    const gw = createGateway({
      fetch: fake.fetch,
      sleep: noSleep,
      ...(opts.auditableRoles ? { auditableRoles: opts.auditableRoles } : {}),
      auditableProviderOrder: ['Azure', 'OpenAI'],
      auditableQuantizations: ['bf16'],
    });
    const auditable: Array<boolean | undefined> = [];
    for (const role of ['judge', 'gabarito', 'competitor'] as CostRole[]) {
      const r = await gw.chatCompletion({
        apiKey: KEY,
        modelId: 'x/y',
        messages: msgs,
        role,
        ...(opts.auditablePorChamada ? { auditable: true } : {}),
        ...(opts.maxPrice ? { maxPricePerMTok: opts.maxPrice } : {}),
      });
      auditable.push(r.auditable);
    }
    const corpos = fake.chatRequests().map((r) => r.body as Record<string, unknown>);
    return { corpos, auditable };
  };

  it('preset por papel (juiz/gabarito): corpo leva provider { order, quantizations, allow_fallbacks:false, require_parameters:true }', async () => {
    const { corpos, auditable } = await corposPorPapel({ auditableRoles: ['judge', 'gabarito'] });
    for (const i of [0, 1]) {
      const provider = corpos[i].provider as Record<string, unknown>;
      expect(provider.allow_fallbacks).toBe(false);
      expect(provider.require_parameters).toBe(true);
      expect(provider.order).toEqual(['Azure', 'OpenAI']);
      expect(provider.quantizations).toEqual(['bf16']);
      expect(auditable[i]).toBe(true); // visível no artefato de replay
    }
    // Competidor fora do preset: NADA do modo auditável no corpo.
    const providerComp = corpos[2].provider as Record<string, unknown> | undefined;
    expect(providerComp?.require_parameters).toBeUndefined();
    expect(auditable[2]).toBeUndefined();
  });

  it('mescla com max_price sem apagar (provider é sempre mesclado, nunca reescrito)', async () => {
    const { corpos } = await corposPorPapel({
      auditableRoles: ['judge'],
      maxPrice: { prompt: 2, completion: 4 },
    });
    const provider = corpos[0].provider as Record<string, unknown>;
    expect(provider.max_price).toEqual({ prompt: 2, completion: 4 });
    expect(provider.require_parameters).toBe(true);
  });

  it('flag por chamada ativa o modo em QUALQUER papel (além do preset)', async () => {
    const { corpos, auditable } = await corposPorPapel({ auditablePorChamada: true });
    for (const [i, corpo] of corpos.entries()) {
      expect((corpo.provider as Record<string, unknown>).require_parameters, `papel ${i}`).toBe(true);
      expect(auditable[i]).toBe(true);
    }
  });
});

describe('IMPL-078 (iii) — contrato dos whitelists silenciosos para os campos novos', () => {
  it('normalizeRunRecord preserva costByRole com a telemetria nova (e campos desconhecidos)', () => {
    const costByRole: Record<CostRole, CostEntry> = {
      judge: {
        calls: 2,
        usd: 0.01,
        tokensIn: 10,
        tokensOut: 20,
        cachedTokensIn: 5,
        reasoningTokens: 8,
        latencyTotalMs: 1234,
        estimatedUsd: 0.02,
      },
      competitor: { calls: 0, usd: 0, tokensIn: 0, tokensOut: 0 },
      datagen: { calls: 0, usd: 0, tokensIn: 0, tokensOut: 0 },
      gabarito: { calls: 0, usd: 0, tokensIn: 0, tokensOut: 0 },
      duel: { calls: 0, usd: 0, tokensIn: 0, tokensOut: 0 },
      rewriter: { calls: 0, usd: 0, tokensIn: 0, tokensOut: 0 },
      agent: { calls: 0, usd: 0, tokensIn: 0, tokensOut: 0 },
    };
    const rec = normalizeRunRecord(
      JSON.parse(
        JSON.stringify({
          id: 'r1',
          status: 'done',
          stages: [],
          costByRole,
          campoFuturoQueNinguemConhece: { ainda: 'assim sobrevive' },
        }),
      ),
    ) as unknown as Record<string, unknown>;
    const byRole = rec.costByRole as Record<string, CostEntry>;
    expect(byRole.judge.cachedTokensIn).toBe(5);
    expect(byRole.judge.reasoningTokens).toBe(8);
    expect(byRole.judge.latencyTotalMs).toBe(1234);
    expect(byRole.judge.estimatedUsd).toBe(0.02);
    // O spread de `raw` é contrato: campo novo do record não pode sumir no reload.
    expect(rec.campoFuturoQueNinguemConhece).toEqual({ ainda: 'assim sobrevive' });
  });

  it('variationConfigFrom repassa todo campo do TrainingConfig (exceto as exclusões documentadas)', () => {
    const cfg: TrainingConfig = {
      mode: 'training',
      theme: 'tema',
      stages: 3,
      datagenModelId: 'g/x',
      judgeModelIds: ['j/x'],
      contestantModelId: 'c/x',
      iterations: 2,
      reflection: 'llm',
      paretoPool: 3,
      compliance: { area: 'saude', includeRessalvas: true },
      piiMode: 'synthetic',
      allowPii: true,
      reasoning: { competitor: 'low', judge: 'high', rewriter: 'medium', datagen: 'off' },
      referenceModelId: 'r/x',
      referenceJudging: true,
      scenarioBrief: 'brief',
      duels: false,
      finalists: 4,
      temperature: 0.3,
      maxPricePerMTok: { prompt: 1, completion: 2 },
      judgePasses: 2,
      concurrency: 2,
      timeoutMs: 5000,
      maxOutputTokens: 400,
      promptOptimization: false,
      optimizerModelId: 'o/x',
      scenarioSeed: [{ question: 'q', productContext: 'p', maxTokens: 100 }],
      customStages: [{ question: 'q2', productContext: 'p2', maxTokens: 200 }],
      contracts: { neverBreak: ['NUNCA invente'], placeholders: ['{os}'], minLengthRatio: 0.4 },
      promptGroup: { prompts: [{ id: 'regras', text: 'REGRAS' }, { id: 'criticas', text: 'CRITICAS' }] },
      promptId: 'regras',
      agent: undefined,
      budgetUsd: 42, // proposital: NÃO pode ser copiado (teto é da sessão)
    };
    const v = variationConfigFrom(cfg) as unknown as Record<string, unknown>;
    // Mesma lista de exclusões DOCUMENTADAS do guard de runtime: loop do treino
    // ou cópia que seria bug (budgetUsd). Campo novo tem de ser copiado ou
    // excluído com decisão — nunca engolido em silêncio.
    const exclusoes = new Set([
      'mode',
      'iterations',
      'minGain',
      'holdoutRatio',
      'feedbackDriven',
      'reflection',
      'paretoPool',
      'budgetUsd',
    ]);
    for (const [key, value] of Object.entries(cfg)) {
      if (exclusoes.has(key)) continue;
      expect(v[key], `campo "${key}" foi engolido por variationConfigFrom`).toEqual(value);
    }
    expect(v.budgetUsd).toBeUndefined();
  });

  it('parseModelsPayload continua de pé com o catálogo de sempre (nada mudou no fio)', () => {
    const modelos = parseModelsPayload({ data: [catalogItem('x/y', 1e-6, 1e-5)] });
    expect(modelos).toHaveLength(1);
    expect(modelos[0].id).toBe('x/y');
  });
});
