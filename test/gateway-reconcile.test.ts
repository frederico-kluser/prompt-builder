// IMPL-074 / IMPL-017 (iv) / IMPL-075 / IMPL-078 — o LEDGER REAL guarda o que
// o gateway mede, e a conciliação pela fatura roda sozinha no fim da run.
//
// Contratos provados aqui (transporte falso, zero rede, zero gasto):
//   IMPL-078 (i/ii): o BudgetLedger real (não um sink de teste) soma por papel
//     cachedTokensIn / reasoningTokens / latencyTotalMs / estimatedUsd — e o
//     registro sobrevive a normalizeRunRecord (JSON de ida e volta);
//   IMPL-075 (i/iii): provedor que serviu contado por papel no ledger real —
//     cobertura (Σ providers / calls) = 1,0 em TODOS os papéis; modo auditável
//     ligável por ambiente (OPENROUTER_AUDITABLE) e pela política da run no
//     ledger, visível no registro (`auditableCalls`, `callLog[].auditable`);
//   IMPL-074 (i): TODA chamada 200 deixa o id de geração no registro por
//     chamada, com a validade do formato `gen-…`;
//   IMPL-074 (ii): GET /generation 404 → retry com backoff → sucesso;
//   IMPL-017 (iv): run com timeouts/sem-usage injetados concilia SOZINHA no
//     fim: |ledger − Σ fatura| ≤ 1% sem nenhum settlePending manual.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger, CALL_LOG_LIMIT, isGenerationId } from '../src/budget.js';
import {
  AUDITABLE_ROLES,
  createGateway,
  setDefaultGateway,
  type FetchLike,
  type OpenRouterGateway,
} from '../src/openrouter.js';
import { gatewayConfigFromEnv } from '../src/gatewayEnv.js';
import { normalizeRunRecord } from '../src/normalize.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion } from '../src/orchestrator.js';
import { COST_ROLES, type RunConfig, type RunRecord } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { duelReply, pointwiseReply } from './judgeReplies.js';

const KEY = 'sk-or-v1-fake-key-reconcile-000000000000';
const msgs = [
  { role: 'system' as const, content: 'Voce e um juiz.' },
  { role: 'user' as const, content: 'Julgue.' },
];
/** Ids no formato real do OpenRouter (`gen-<unix>-<20 chars>`). */
const gid = (n: number): string => `gen-1758926640-${String(n).padStart(20, 'x')}`;

let anterior: OpenRouterGateway | undefined;
afterEach(() => {
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
});

describe('IMPL-078 — telemetria de uso no LEDGER REAL (não num sink de teste)', () => {
  it('byRole soma cached/reasoning/latência/estimado e sobrevive a normalizeRunRecord', async () => {
    const fake = fakeOpenRouter({
      catalog: [catalogItem('m/judge', 1e-6, 1e-5)],
      chat: () => ({
        text: '{"verdict":"resolve"}',
        id: gid(1),
        provider: 'OpenAI',
        usage: {
          prompt_tokens: 20,
          completion_tokens: 10,
          cost: 0.0007,
          prompt_tokens_details: { cached_tokens: 7 },
          completion_tokens_details: { reasoning_tokens: 4 },
        },
      }),
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    await gw.listModels(KEY);
    const ledger = new BudgetLedger();
    await gw.chatCompletion({ apiKey: KEY, modelId: 'm/judge', messages: msgs, maxTokens: 300, role: 'judge', sink: ledger });
    await gw.chatCompletion({ apiKey: KEY, modelId: 'm/judge', messages: msgs, maxTokens: 300, role: 'judge', sink: ledger });

    const j = ledger.snapshot().byRole.judge;
    expect(j).toMatchObject({ calls: 2, cachedTokensIn: 14, reasoningTokens: 8 });
    expect(j.usd).toBeCloseTo(0.0014, 12);
    expect(j.latencyTotalMs).toBeGreaterThanOrEqual(0);
    expect(j.estimatedUsd).toBeGreaterThan(0); // estimado (catálogo) × real (usd)
    expect(j.providers).toEqual({ OpenAI: 2 });

    // Export de run: o record relido guarda os 5 campos por papel.
    const rec = normalizeRunRecord(
      JSON.parse(JSON.stringify({ id: 'r', status: 'finished', stages: [], costByRole: ledger.snapshot().byRole })) as never,
    ) as RunRecord;
    expect(rec.costByRole?.judge).toMatchObject({
      cachedTokensIn: 14,
      reasoningTokens: 8,
      providers: { OpenAI: 2 },
    });
    expect(typeof rec.costByRole?.judge.latencyTotalMs).toBe('number');
    expect(typeof rec.costByRole?.judge.estimatedUsd).toBe('number');
  });

  it('chamada pendente/conservadora leva latência e provedor ao ledger quando ganha custo', () => {
    const ledger = new BudgetLedger({ estimateCall: () => 0.01 });
    const r = ledger.reserve('duel', 'm', 10, 100);
    ledger.pending(r, { role: 'duel', modelId: 'm', reason: 'timeout', latencyMs: 1234, provider: { name: 'Azure' } });
    const d = ledger.snapshot().byRole.duel;
    expect(d).toMatchObject({ calls: 1, latencyTotalMs: 1234, providers: { Azure: 1 } });
    expect(ledger.callLog()).toEqual([
      expect.objectContaining({ role: 'duel', status: 'conservative', usd: 0.01, source: 'unknown', provider: 'Azure' }),
    ]);
  });
});

describe('IMPL-075 — provedor por papel no ledger real; modo auditável ligável', () => {
  it('cobertura de registro = 1,0 em TODOS os papéis (payload nomeia o provedor)', async () => {
    const fake = fakeOpenRouter({
      catalog: [catalogItem('m/x', 1e-6, 1e-6)],
      chat: (_req, n) => ({ text: 'ok', id: gid(n), provider: n % 2 ? 'Together' : 'Fireworks' }),
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const ledger = new BudgetLedger();
    for (const role of COST_ROLES) {
      await gw.chatCompletion({ apiKey: KEY, modelId: 'm/x', messages: msgs, maxTokens: 50, role, sink: ledger });
    }
    const byRole = ledger.snapshot().byRole;
    for (const role of COST_ROLES) {
      const e = byRole[role];
      const cobertos = Object.values(e.providers ?? {}).reduce((s, n) => s + n, 0);
      expect(cobertos / e.calls, role).toBe(1);
    }
    // O /generation não foi consultado: o payload já trazia o provedor.
    expect(fake.requests.filter((r) => r.path.endsWith('/generation'))).toHaveLength(0);
  });

  it('OPENROUTER_AUDITABLE=on liga o preset (juiz + gabarito): corpo travado e visível no registro', async () => {
    expect(gatewayConfigFromEnv({ OPENROUTER_AUDITABLE: 'on' }).auditableRoles).toEqual([...AUDITABLE_ROLES]);
    expect(gatewayConfigFromEnv({ OPENROUTER_AUDITABLE: 'judge,duel,nada' }).auditableRoles).toEqual(['judge', 'duel']);
    expect(gatewayConfigFromEnv({ OPENROUTER_AUDITABLE: '0' }).auditableRoles).toBeUndefined();
    expect(
      gatewayConfigFromEnv({ OPENROUTER_AUDITABLE_PROVIDERS: 'OpenAI, Azure' }).auditableProviderOrder,
    ).toEqual(['OpenAI', 'Azure']);

    const fake = fakeOpenRouter({ chat: () => ({ text: 'ok', id: gid(3), provider: 'OpenAI' }) });
    const gw = createGateway({
      ...gatewayConfigFromEnv({ OPENROUTER_AUDITABLE: 'on', OPENROUTER_AUDITABLE_PROVIDERS: 'OpenAI' }),
      fetch: fake.fetch,
      sleep: noSleep,
    });
    const ledger = new BudgetLedger();
    await gw.chatCompletion({ apiKey: KEY, modelId: 'm/x', messages: msgs, role: 'judge', sink: ledger });
    await gw.chatCompletion({ apiKey: KEY, modelId: 'm/x', messages: msgs, role: 'competitor', sink: ledger });
    const [juiz, competidor] = fake.chatRequests().map((r) => r.body?.provider as Record<string, unknown> | undefined);
    expect(juiz).toMatchObject({ order: ['OpenAI'], allow_fallbacks: false, require_parameters: true });
    expect(competidor).toBeUndefined();
    expect(ledger.snapshot().byRole.judge.auditableCalls).toBe(1);
    expect(ledger.snapshot().byRole.competitor.auditableCalls).toBeUndefined();
    expect(ledger.callLog().map((c) => [c.role, c.auditable ?? false])).toEqual([
      ['judge', true],
      ['competitor', false],
    ]);
  });

  it('política da RUN no ledger (setAuditableRoles) vale para a cadeia inteira (sessão → runs)', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: 'ok' }) });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const sessao = new BudgetLedger();
    sessao.setAuditableRoles(['duel']);
    sessao.setAuditableRoles(undefined); // só liga, nunca desliga
    const run = sessao.fork();
    await gw.chatCompletion({ apiKey: KEY, modelId: 'm/x', messages: msgs, role: 'duel', sink: run });
    expect(fake.chatRequests()[0].body?.provider).toMatchObject({ allow_fallbacks: false, require_parameters: true });
    expect(run.snapshot().byRole.duel.auditableCalls).toBe(1);
    expect(sessao.snapshot().byRole.duel.auditableCalls).toBe(1);
  });
});

describe('IMPL-074 (i) — todo 200 deixa o id de geração no registro por chamada', () => {
  it('id válido/ inválido/ ausente ficam distinguíveis; o registro tem teto', async () => {
    const ids = [gid(1), 'gen-1', undefined];
    const fake = fakeOpenRouter({ chat: (_req, n) => ({ text: 'ok', ...(ids[n] ? { id: ids[n] } : {}) }) });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const ledger = new BudgetLedger();
    for (let i = 0; i < 3; i++) {
      await gw.chatCompletionStream({ apiKey: KEY, modelId: 'm/x', messages: msgs, role: 'competitor', sink: ledger });
    }
    expect(ledger.callLog().map((c) => [c.generationId, c.generationIdValid, c.status])).toEqual([
      [gid(1), true, 'measured'],
      ['gen-1', false, 'measured'],
      [undefined, undefined, 'measured'],
    ]);
    expect(isGenerationId(gid(9))).toBe(true);
    expect(isGenerationId('gen-3bhGkxlo4XFrqiabUM7NDtwDzWwG')).toBe(true); // formato da documentação
    expect(isGenerationId('gen-1727545566-abc')).toBe(false); // sintetizado (executor pi)
    expect(CALL_LOG_LIMIT).toBeGreaterThanOrEqual(1000);
  });

  it('o registro por chamada fica FORA do costLedger enxuto (não viaja em NDJSON/MCP)', () => {
    const ledger = new BudgetLedger();
    const r = ledger.reserve('judge', 'm', 1, 1);
    ledger.note(r, { role: 'judge', modelId: 'm', cost: { usd: 0.1, source: 'usage' }, tokensIn: 1, tokensOut: 1, generationId: gid(2) });
    expect('calls' in ledger.summary()).toBe(false);
    expect('callLog' in ledger.summary()).toBe(false);
    expect(ledger.callLog()).toHaveLength(1);
  });
});

/** Transporte: chat do fake + GET /generation roteirizado por id. */
function comGeneration(
  chat: FetchLike,
  generation: (id: string, n: number) => Response,
): { fetch: FetchLike; gets: string[] } {
  const gets: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/generation')) {
      const id = u.searchParams.get('id') ?? '';
      gets.push(id);
      return generation(id, gets.filter((g) => g === id).length - 1);
    }
    return chat(url, init);
  };
  return { fetch, gets };
}

const ficha = (id: string, total: number, extra: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ data: { id, total_cost: total, ...extra } }), { status: 200 });

describe('IMPL-074 (ii) — GET /generation: 404 transitório → retry com backoff → sucesso', () => {
  it('404, 404, 200: concilia pelo total_cost e grava provedor/cancelled/tempos no registro', async () => {
    const id = gid(7);
    const chat = fakeOpenRouter({ chat: () => ({ text: 'meia', id, usage: null }) }); // sem usage => pendente
    const t = comGeneration(chat.fetch, (_id, tentativa) =>
      tentativa < 2
        ? new Response('{"error":{"message":"Generation not found"}}', { status: 404 })
        : ficha(id, 0.0042, {
            provider_name: 'Anthropic',
            upstream_id: 'up-9',
            cancelled: true,
            generation_time: 812,
            latency: 950,
          }),
    );
    const esperas: number[] = [];
    const gw = createGateway({ fetch: t.fetch, sleep: async (ms) => void esperas.push(ms), providerLookup: 'off' });
    const ledger = new BudgetLedger({ estimateCall: () => 0.05 });
    await gw.chatCompletion({ apiKey: KEY, modelId: 'm/x', messages: msgs, role: 'judge', sink: ledger });
    expect(ledger.pendingEntries()).toHaveLength(1);

    const r = await gw.reconcilePending(ledger, KEY);
    expect(r).toEqual({ attempted: 1, settled: 1, notFound: 0, failed: 0 });
    expect(t.gets).toEqual([id, id, id]);
    expect(esperas).toEqual([1000, 2000]); // backoff exponencial entre as tentativas
    expect(ledger.pendingUsd).toBe(0);
    expect(ledger.spentUsd).toBeCloseTo(0.0042, 12); // a FATURA, não a reserva
    expect(ledger.snapshot().byRole.judge.providers).toEqual({ Anthropic: 1 });
    expect(ledger.callLog()[0]).toMatchObject({
      generationId: id,
      status: 'reconciled',
      usd: 0.0042,
      source: 'usage',
      provider: 'Anthropic',
      upstreamId: 'up-9',
      cancelled: true,
      generationTimeMs: 812,
      latencyMs: 950,
    });
    expect(ledger.summary().reconciliation).toEqual({ attempted: 1, settled: 1, notFound: 0, failed: 0 });
  });

  it('404 persistente vira gasto conservador; id fora do formato nem vai à rede; falha de rede segue pendente', async () => {
    const [persistente, rede] = [gid(1), gid(2)];
    const ids = [persistente, 'gen-sintetizado', rede];
    const chat = fakeOpenRouter({ chat: (_req, n) => ({ text: 'x', id: ids[n], usage: null }) });
    const t = comGeneration(chat.fetch, (id) => {
      if (id === rede) throw new Error('socket hang up');
      return new Response('not found', { status: 404 });
    });
    const gw = createGateway({ fetch: t.fetch, sleep: noSleep, providerLookup: 'off' });
    const ledger = new BudgetLedger({ estimateCall: () => 0.01 });
    for (let i = 0; i < 3; i++) {
      await gw.chatCompletion({ apiKey: KEY, modelId: 'm/x', messages: [{ role: 'user', content: `c${i}` }], role: 'datagen', sink: ledger });
    }
    const r = await gw.reconcilePending(ledger, KEY, { attempts: 3 });
    expect(r).toEqual({ attempted: 3, settled: 0, notFound: 2, failed: 1 });
    expect(t.gets.filter((g) => g === 'gen-sintetizado')).toHaveLength(0);
    expect(ledger.pendingEntries().map((p) => p.generationId)).toEqual([rede]);
    expect(ledger.conservativeCalls).toBe(2);
    expect(ledger.spentUsd).toBeCloseTo(0.02, 12); // nunca zero: a reserva inteira
  });
});

describe('IMPL-017 (iv) — a run concilia SOZINHA no fim: |ledger − Σ fatura| ≤ 1%', () => {
  let dir = '';
  let dirAnterior = '';
  afterEach(() => {
    if (dir) {
      setDataDir(dirAnterior);
      rmSync(dir, { recursive: true, force: true });
      dir = '';
    }
  });

  it('compare com competidores sem usage (pendentes pelo id): o record fecha com a fatura', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pb-reconcile-'));
    dirAnterior = getDataDir();
    setDataDir(dir);
    const silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    const fatura = new Map<string, number>();
    let n = 0;
    const fake = fakeOpenRouter({
      catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b'].map((id) => catalogItem(id, 1e-6, 1e-6)),
      chat: (req) => {
        const id = gid(n++);
        const custo = Number((0.0001 * n).toFixed(6));
        fatura.set(id, custo);
        const usage = { prompt_tokens: 50, completion_tokens: 10, cost: custo };
        if (req.model === 'fake/gen') {
          return {
            id,
            usage,
            text: JSON.stringify({
              stages: [
                { question: 'Qual o prazo de troca de um tenis?', productContext: 'Troca em 30 dias com nota.', maxTokens: 200, rubric: '30 dias.' },
                { question: 'Como calcular juros compostos mensais?', productContext: 'M = C (1 + i)^n.', maxTokens: 200, rubric: 'Formula.' },
              ],
            }),
          };
        }
        if (req.model === 'fake/ref') return { id, usage, text: `Gabarito: ${req.user.slice(0, 30)}` };
        if (req.model === 'fake/judge') {
          if (req.system.includes('DUELO')) return { id, usage, text: duelReply(req, 'A', 'A') };
          return { id, usage, text: pointwiseReply(req, 'resolve') };
        }
        // Competidores: metade SEM bloco usage (cobrado, mas sem custo medido).
        return n % 2 ? { id, text: `Resposta de ${req.model}`, usage: null } : { id, usage, text: `Resposta de ${req.model}` };
      },
    });
    const t = comGeneration(fake.fetch, (id) => (fatura.has(id) ? ficha(id, fatura.get(id)!) : new Response('', { status: 404 })));
    anterior = setDefaultGateway(createGateway({ fetch: t.fetch, sleep: noSleep, providerLookup: 'off' }));
    try {
      const config = {
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
        budgetUsd: 5,
      } as unknown as RunConfig;
      const rec = await runToCompletion(config, KEY);
      expect(rec.status, rec.error).not.toBe('error');
      const totalFatura = [...fatura.values()].reduce((s, v) => s + v, 0);
      // Houve pendentes de verdade (competidores sem usage) — e NENHUM ficou.
      expect(rec.costLedger?.reconciliation?.settled).toBeGreaterThan(0);
      expect(rec.costLedger?.pendingUsd).toBe(0);
      expect(rec.costLedger?.pendingEntries).toBeUndefined();
      expect(Math.abs(rec.totalCostUsd - totalFatura) / totalFatura).toBeLessThanOrEqual(0.01);
      // Registro por chamada: um id válido por chamada 200, reconciliadas marcadas.
      expect(rec.callLog?.length).toBe(fatura.size);
      expect(rec.callLog?.every((c) => c.generationIdValid === true)).toBe(true);
      expect(rec.callLog?.some((c) => c.status === 'reconciled')).toBe(true);
      // Nada foi cobrado em dobro: um id por geração no registro.
      const ids = rec.callLog!.map((c) => c.generationId);
      expect(new Set(ids).size).toBe(ids.length);
      const porPapel = Object.values(rec.costByRole ?? {}) as { usd: number }[];
      expect(porPapel.reduce((s, e) => s + e.usd, 0)).toBeCloseTo(rec.totalCostUsd, 10);
    } finally {
      silencio.forEach((s) => s.mockRestore());
    }
  });

  it('Cancelar NÃO espera a conciliação: sai na hora e as pendentes ficam no record para depois', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pb-reconcile-cancel-'));
    dirAnterior = getDataDir();
    setDataDir(dir);
    const silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    let n = 0;
    let competidoresNoAr = 0;
    const base = fakeOpenRouter({
      catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b'].map((id) => catalogItem(id, 1e-6, 1e-6)),
      chat: (req) => {
        if (req.model === 'fake/gen') {
          return {
            text: JSON.stringify({
              stages: [{ question: 'Qual o prazo de troca de um tenis?', productContext: 'Troca em 30 dias.', maxTokens: 200 }],
            }),
          };
        }
        return { text: `Gabarito: ${req.user.slice(0, 20)}` };
      },
    });
    // Competidor: 200 + 1 chunk COM id e depois trava até o abort (stream cortado).
    const chat: FetchLike = async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      if (!new URL(url).pathname.endsWith('/chat/completions') || !String(body.model).match(/^fake\/[ab]$/)) {
        return base.fetch(url, init);
      }
      const id = gid(100 + n++);
      competidoresNoAr += 1;
      const signal = init?.signal;
      const enc = new TextEncoder();
      const corpo = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ id, choices: [{ delta: { content: 'meia' } }] })}\n\n`));
          signal?.addEventListener('abort', () => ctrl.error(signal.reason), { once: true });
        },
      });
      return new Response(corpo, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const t = comGeneration(chat, (id) => ficha(id, 0.001));
    anterior = setDefaultGateway(createGateway({ fetch: t.fetch, sleep: noSleep, providerLookup: 'off' }));
    const ctl = new AbortController();
    try {
      const config = {
        mode: 'compare',
        theme: 'suporte',
        stages: 1,
        datagenModelId: 'fake/gen',
        judgeModelIds: ['fake/judge'],
        referenceModelId: 'fake/ref',
        referenceJudging: true,
        competitorModelIds: ['fake/a', 'fake/b'],
        timeoutMs: 60_000,
      } as unknown as RunConfig;
      const fim = runToCompletion(config, KEY, { signal: ctl.signal });
      const t0 = Date.now();
      while (competidoresNoAr < 2 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 5));
      ctl.abort(new Error('Cancelar'));
      const rec = await fim;
      expect(rec.stoppedReason).toBe('cancelled');
      expect(t.gets).toEqual([]); // nenhuma consulta depois do Cancelar
      expect(rec.costLedger?.pendingEntries?.length).toBe(2); // conciliáveis depois
    } finally {
      silencio.forEach((s) => s.mockRestore());
    }
  });
});
