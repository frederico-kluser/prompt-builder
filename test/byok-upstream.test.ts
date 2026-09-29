// extra#1 — `upstream_inference_cost` NÃO é gasto BYOK por si só.
//
// Numa run paga real (2026-09-29, z-ai/glm-5.3-flash via Parasail, key sem
// BYOK) o OpenRouter devolveu em TODA chamada:
//   usage = { cost: 6.75e-06, is_byok: false,
//             cost_details: { upstream_inference_cost: 6.75e-06, … } }
// e o código tratava o upstream como "BYOK, cobrado fora dos créditos": a
// sessão gravou `upstreamCostUsd == totalCostUsd` (0.0998) — qualquer um que o
// somasse ao gasto (CLI, web, relatório, agente lendo o JSON) DOBRAVA o custo.
//
// Contratos provados aqui (transporte falso, zero rede, zero gasto):
//   1. extração: upstream só vira gasto à parte com `is_byok === true`;
//      `is_byok: false` ou AUSENTE nunca é BYOK (nunca inferir);
//   2. ledger: não-BYOK não gera `costLedger.byok`; BYOK soma o upstream à
//      parte, FORA de `spentUsd`, e conta a BYOK sem upstream como NÃO medida;
//   3. calibração estimado × real: BYOK não ensina a taxa como preço real;
//   4. conciliação pelo /generation segue a MESMA regra;
//   5. runs nos DOIS motores: `totalCostUsd` == Σ `usage.cost` (nunca 2×) e o
//      campo LEGADO `upstreamCostUsd` não é mais escrito;
//   6. consumidores: `renderSpend` (CLI) e o relatório de ciclos só falam de
//      BYOK com `costLedger.byok` — nunca pelo campo legado.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger } from '../src/budget.js';
import {
  createGateway,
  extractUsage,
  measuredCallUsd,
  parseGenerationInfo,
  peekCostSamples,
  priceUsage,
  resetCostSamples,
  setDefaultGateway,
  type FetchLike,
  type OpenRouterGateway,
} from '../src/openrouter.js';
import { renderSpend } from '../src/cli/output.js';
import { buildSessionReport } from '../src/engine/sessionReport.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWebEngine } from '../web/src/engine/orchestrator.js';
import type { CostLedgerSummary, RunConfig, RunRecord, SessionRecord } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeUsage } from './fakeOpenRouter.js';
import { duelReply, pointwiseReply } from './judgeReplies.js';
import { fixture } from './support/sessionReportFixture.js';

// O motor da SPA grava no IndexedDB; aqui não há navegador — storage no-op.
vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-byok-upstream-0000000000';
const msgs = [
  { role: 'system' as const, content: 'Voce e um assistente.' },
  { role: 'user' as const, content: 'Responda.' },
];
const gid = (n: number): string => `gen-1759150000-${String(n).padStart(20, 'y')}`;

/** Payload REAL da chamada não-BYOK medida em 2026-09-29 (upstream == cost). */
const USAGE_NAO_BYOK: FakeUsage = {
  prompt_tokens: 30,
  completion_tokens: 12,
  cost: 6.75e-6,
  is_byok: false,
  cost_details: {
    upstream_inference_cost: 6.75e-6,
    upstream_inference_prompt_cost: 2.25e-6,
    upstream_inference_completions_cost: 4.5e-6,
  },
};
/** BYOK: `cost` é só a taxa do OpenRouter; o provedor cobrou o upstream na key dele. */
const USAGE_BYOK: FakeUsage = {
  prompt_tokens: 30,
  completion_tokens: 12,
  cost: 0.00005,
  is_byok: true,
  cost_details: { upstream_inference_cost: 0.001 },
};

let anterior: OpenRouterGateway | undefined;
afterEach(() => {
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
  resetCostSamples();
});

describe('extra#1 — extração: upstream só é gasto à parte com is_byok === true', () => {
  it('não-BYOK real (upstream == cost): nenhum upstream à parte, custo = usage.cost', () => {
    const u = extractUsage(USAGE_NAO_BYOK);
    expect(u.cost).toBe(6.75e-6);
    expect(u.isByok).toBe(false);
    expect(u.byokUpstreamCost).toBeUndefined();
    const c = priceUsage(u, undefined);
    expect(c).toEqual({ usd: 6.75e-6, source: 'usage' });
    expect(c.byok).toBeUndefined();
    expect(c.byokUpstreamUsd).toBeUndefined();
    expect(measuredCallUsd(c)).toBe(6.75e-6); // nunca cost + upstream
  });

  it('BYOK: taxa em `usd`, upstream em `byokUpstreamUsd` (fora dos créditos)', () => {
    const c = priceUsage(extractUsage(USAGE_BYOK), undefined);
    expect(c).toEqual({ usd: 0.00005, source: 'usage', byok: true, byokUpstreamUsd: 0.001 });
    expect(measuredCallUsd(c)).toBeCloseTo(0.00105, 12);
  });

  it('is_byok AUSENTE com upstream presente: NÃO é BYOK (nunca inferir)', () => {
    const u = extractUsage({ prompt_tokens: 1, completion_tokens: 1, cost: 0.02, cost_details: { upstream_inference_cost: 0.02 } });
    expect(u.isByok).toBeUndefined();
    expect(u.byokUpstreamCost).toBeUndefined();
    expect(priceUsage(u, undefined)).toEqual({ usd: 0.02, source: 'usage' });
  });

  it('BYOK sem upstream informado: é BYOK, mas o custo do provedor NÃO foi medido (não é zero)', () => {
    const c = priceUsage(extractUsage({ prompt_tokens: 1, completion_tokens: 1, cost: 0.0001, is_byok: true }), undefined);
    expect(c).toEqual({ usd: 0.0001, source: 'usage', byok: true });
    expect(measuredCallUsd(c)).toBeNull();
  });

  it('is_byok não-booleano (lixo) é ignorado', () => {
    const u = extractUsage({ cost: 0.1, is_byok: 'true', cost_details: { upstream_inference_cost: 0.3 } });
    expect(u.isByok).toBeUndefined();
    expect(priceUsage(u, undefined)).toEqual({ usd: 0.1, source: 'usage' });
  });
});

describe('extra#1 — ledger real via gateway (JSON e SSE)', () => {
  it('não-BYOK (JSON + SSE): gasto = Σ usage.cost, sem `byok` no resumo', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: 'ok', usage: USAGE_NAO_BYOK }) });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep, providerLookup: 'off' });
    const ledger = new BudgetLedger({ estimateCall: () => 0.01 });
    await gw.chatCompletion({ apiKey: KEY, modelId: 'm/x', messages: msgs, role: 'judge', sink: ledger });
    await gw.chatCompletionStream({ apiKey: KEY, modelId: 'm/x', messages: msgs, role: 'competitor', sink: ledger, onDelta: () => undefined });
    expect(ledger.spentUsd).toBeCloseTo(2 * 6.75e-6, 15);
    expect(ledger.spentUsd).toBeCloseTo(fake.billedUsd(), 15); // a fatura, não o dobro
    const snap = ledger.snapshot();
    expect(snap).toMatchObject({ byokCalls: 0, byokUpstreamUsd: 0, byokUpstreamUnknownCalls: 0 });
    expect(ledger.summary().byok).toBeUndefined();
    expect(snap).not.toHaveProperty('upstreamUsd');
  });

  it('BYOK misturado: upstream à parte (fora de spentUsd e do teto); BYOK sem upstream = não medida', async () => {
    const roteiro: FakeUsage[] = [
      USAGE_NAO_BYOK,
      USAGE_BYOK,
      { ...USAGE_BYOK, cost: 0.00002, cost_details: { upstream_inference_cost: 0.0004 } },
      { prompt_tokens: 5, completion_tokens: 5, cost: 0.00001, is_byok: true },
    ];
    const fake = fakeOpenRouter({ chat: (_r, n) => ({ text: 'ok', usage: roteiro[n] }) });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep, providerLookup: 'off' });
    const sessao = new BudgetLedger({ budgetUsd: 1, estimateCall: () => 0.01 });
    const run = sessao.fork();
    for (let i = 0; i < roteiro.length; i++) {
      await gw.chatCompletion({ apiKey: KEY, modelId: 'm/x', messages: msgs, role: 'competitor', sink: run });
    }
    const creditos = 6.75e-6 + 0.00005 + 0.00002 + 0.00001;
    for (const l of [run, sessao]) {
      expect(l.spentUsd).toBeCloseTo(creditos, 15);
      expect(l.committedUsd).toBeCloseTo(creditos, 15); // o upstream BYOK não ocupa o teto
      expect(l.summary().byok).toEqual({ calls: 3, upstreamUsd: expect.closeTo(0.0014, 15), upstreamUnknownCalls: 1 });
    }
    expect(fake.billedUsd()).toBeCloseTo(creditos, 15);
    // Registo por chamada: só as BYOK são marcadas; a não-BYOK não carrega upstream.
    expect(run.callLog().map((c) => [c.byok ?? false, c.byokUpstreamUsd])).toEqual([
      [false, undefined],
      [true, 0.001],
      [true, 0.0004],
      [true, undefined],
    ]);
  });
});

describe('extra#1 — calibração estimado × real (IMPL-113) não aprende a taxa BYOK como preço', () => {
  it('não-BYOK: real = cost; BYOK: real = taxa + upstream; BYOK sem upstream: sem amostra', async () => {
    const roteiro: FakeUsage[] = [
      USAGE_NAO_BYOK,
      USAGE_BYOK,
      { prompt_tokens: 5, completion_tokens: 5, cost: 0.00001, is_byok: true },
    ];
    const fake = fakeOpenRouter({
      catalog: [catalogItem('m/x', 1e-6, 2e-6)],
      chat: (_r, n) => ({ text: 'ok', usage: roteiro[n] }),
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep, providerLookup: 'off' });
    await gw.listModels(KEY);
    resetCostSamples();
    const ledger = new BudgetLedger();
    for (let i = 0; i < roteiro.length; i++) {
      await gw.chatCompletion({ apiKey: KEY, modelId: 'm/x', messages: msgs, maxTokens: 200, role: 'judge', sink: ledger });
    }
    const reais = peekCostSamples().map((s) => s.actualUsd);
    expect(reais).toHaveLength(2);
    expect(reais[0]).toBe(6.75e-6);
    expect(reais[1]).toBeCloseTo(0.00105, 12);
  });
});

describe('extra#1 — conciliação pelo GET /generation segue a mesma regra', () => {
  it('parseGenerationInfo: upstream só com is_byok === true', () => {
    const nao = parseGenerationInfo('g', { data: { total_cost: 0.002, is_byok: false, upstream_inference_cost: 0.002 } });
    expect(nao).toMatchObject({ totalCostUsd: 0.002 });
    expect(nao?.byok).toBeUndefined();
    expect(nao?.byokUpstreamUsd).toBeUndefined();
    const sim = parseGenerationInfo('g', { data: { total_cost: 0.0001, is_byok: true, upstream_inference_cost: 0.002 } });
    expect(sim).toMatchObject({ totalCostUsd: 0.0001, byok: true, byokUpstreamUsd: 0.002 });
  });

  it('pendentes conciliadas: não-BYOK entra só no gasto; BYOK leva o upstream a `costLedger.byok`', async () => {
    const [a, b] = [gid(1), gid(2)];
    const ids = [a, b];
    const chat = fakeOpenRouter({ chat: (_r, n) => ({ text: 'x', id: ids[n], usage: null }) }); // sem usage => pendente
    const fichas: Record<string, Record<string, unknown>> = {
      [a]: { id: a, total_cost: 0.003, is_byok: false, upstream_inference_cost: 0.003 },
      [b]: { id: b, total_cost: 0.0002, is_byok: true, upstream_inference_cost: 0.004 },
    };
    const fetch: FetchLike = async (url, init) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/generation')) {
        return new Response(JSON.stringify({ data: fichas[u.searchParams.get('id') ?? ''] }), { status: 200 });
      }
      return chat.fetch(url, init);
    };
    const gw = createGateway({ fetch, sleep: noSleep, providerLookup: 'off' });
    const ledger = new BudgetLedger({ estimateCall: () => 0.05 });
    for (let i = 0; i < 2; i++) {
      await gw.chatCompletion({ apiKey: KEY, modelId: 'm/x', messages: [{ role: 'user', content: `c${i}` }], role: 'judge', sink: ledger });
    }
    expect(ledger.pendingEntries()).toHaveLength(2);
    const r = await gw.reconcilePending(ledger, KEY);
    expect(r.settled).toBe(2);
    expect(ledger.spentUsd).toBeCloseTo(0.0032, 12); // faturas; nunca + upstream não-BYOK
    expect(ledger.summary().byok).toEqual({ calls: 1, upstreamUsd: 0.004, upstreamUnknownCalls: 0 });
    const log = Object.fromEntries(ledger.callLog().map((c) => [c.generationId, c]));
    expect(log[a]).toMatchObject({ status: 'reconciled', usd: 0.003 });
    expect(log[a].byok).toBeUndefined();
    expect(log[b]).toMatchObject({ status: 'reconciled', usd: 0.0002, byok: true, byokUpstreamUsd: 0.004 });
  });
});

describe('extra#1 — runs nos DOIS motores: total == Σ usage.cost, nunca o dobro', () => {
  type Rodar = (config: RunConfig) => Promise<RunRecord>;
  const MOTORES: ReadonlyArray<readonly [string, Rodar]> = [
    ['Node', (c) => runNode(c, KEY, {})],
    ['SPA', (c) => runWebEngine(c as never, KEY, {} as never) as unknown as Promise<RunRecord>],
  ];
  for (const [motor, runToCompletion] of MOTORES) {
    let dir = '';
    let dirAnterior = '';
    afterEach(() => {
      if (dir) {
        setDataDir(dirAnterior);
        rmSync(dir, { recursive: true, force: true });
        dir = '';
      }
    });

    it(`${motor}: competidor BYOK + resto não-BYOK — totalCostUsd = créditos; BYOK só em costLedger.byok`, async () => {
      dir = mkdtempSync(join(tmpdir(), 'pb-byok-'));
      dirAnterior = getDataDir();
      setDataDir(dir);
      const silencio = [
        vi.spyOn(console, 'log').mockImplementation(() => undefined),
        vi.spyOn(console, 'warn').mockImplementation(() => undefined),
        vi.spyOn(console, 'error').mockImplementation(() => undefined),
      ];
      let upstreamByok = 0;
      let chamadasByok = 0;
      const fake = fakeOpenRouter({
        catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b'].map((id) => catalogItem(id, 1e-6, 1e-6)),
        chat: (req) => {
          if (req.model === 'fake/gen') {
            return {
              usage: USAGE_NAO_BYOK,
              text: JSON.stringify({
                stages: [
                  { question: 'Qual o prazo de troca de um tenis?', productContext: 'Troca em 30 dias com nota.', maxTokens: 200, rubric: '30 dias.' },
                  { question: 'Como calcular juros compostos mensais?', productContext: 'M = C (1 + i)^n.', maxTokens: 200, rubric: 'Formula.' },
                ],
              }),
            };
          }
          if (req.model === 'fake/ref') return { usage: USAGE_NAO_BYOK, text: `Gabarito: ${req.user.slice(0, 30)}` };
          if (req.model === 'fake/judge') {
            if (req.system.includes('DUELO')) return { usage: USAGE_NAO_BYOK, text: duelReply(req, 'A', 'A') };
            return { usage: USAGE_NAO_BYOK, text: pointwiseReply(req, 'resolve') };
          }
          if (req.model === 'fake/a') {
            chamadasByok += 1;
            upstreamByok += USAGE_BYOK.cost_details!.upstream_inference_cost!;
            return { usage: USAGE_BYOK, text: `Resposta de ${req.model}` };
          }
          return { usage: USAGE_NAO_BYOK, text: `Resposta de ${req.model}` };
        },
      });
      anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep, providerLookup: 'off' }));
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
        const rec = await runToCompletion(config);
        expect(rec.status, rec.error).not.toBe('error');
        expect(chamadasByok).toBeGreaterThan(0);
        // O gasto do record é a FATURA de créditos — nunca + upstream não-BYOK.
        expect(rec.totalCostUsd).toBeCloseTo(fake.billedUsd(), 12);
        // O campo legado não é mais escrito (ele valia == totalCostUsd numa key sem BYOK).
        expect(rec.upstreamCostUsd).toBeUndefined();
        expect(rec.costLedger?.byok).toEqual({
          calls: chamadasByok,
          upstreamUsd: expect.closeTo(upstreamByok, 12),
          upstreamUnknownCalls: 0,
        });
      } finally {
        silencio.forEach((s) => s.mockRestore());
      }
    });
  }
});

describe('extra#1 — consumidores: BYOK só por costLedger.byok, nunca pelo campo legado', () => {
  const ledgerBase: CostLedgerSummary = {
    spentUsd: 0.0998,
    committedUsd: 0.0998,
    pendingUsd: 0,
    pendingCalls: 0,
    conservativeUsd: 0,
    conservativeCalls: 0,
  };

  it('renderSpend (CLI): sem `byok` não há linha BYOK e o gasto é o total — com `byok` a linha diz "fora do orçamento"', () => {
    const sem = renderSpend(undefined, 0.0998, 1, undefined, ledgerBase).join('\n');
    expect(sem).not.toMatch(/BYOK/);
    expect(sem).toContain('0.0998');
    const com = renderSpend(undefined, 0.0998, 1, undefined, {
      ...ledgerBase,
      byok: { calls: 3, upstreamUsd: 0.5, upstreamUnknownCalls: 1 },
    }).join('\n');
    const linha = com.split('\n').find((l) => l.startsWith('BYOK'));
    expect(linha).toBeDefined();
    expect(linha).toMatch(/3 chamada\(s\)/);
    expect(linha).toMatch(/1 sem custo informado/);
    expect(linha).toMatch(/fora dos créditos do OpenRouter e fora do orçamento/);
    // A linha do gasto NÃO soma o upstream BYOK.
    expect(com.split('\n')[0]).toContain('0.0998');
  });

  it('relatório de ciclos: sessão LEGADA com upstreamCostUsd == total não vira BYOK nem dobra o custo', () => {
    const { session, runs } = fixture();
    const legado = { ...session, upstreamCostUsd: session.totalCostUsd } as SessionRecord;
    const r = buildSessionReport(legado, runs, { generatedAt: '2026-09-29T00:00:00.000Z' });
    expect(r.optimization.totalUsd).toBeCloseTo(session.totalCostUsd, 12);
    expect(r.warnings.some((w) => /BYOK/.test(w))).toBe(false);
    expect(JSON.stringify(r)).not.toContain('upstream');
  });

  it('relatório de ciclos: com costLedger.byok avisa o gasto do provedor, fora do total', () => {
    const { session, runs } = fixture();
    const comByok = {
      ...session,
      costLedger: { ...ledgerBase, spentUsd: session.totalCostUsd, byok: { calls: 4, upstreamUsd: 0.25, upstreamUnknownCalls: 0 } },
    } as SessionRecord;
    const r = buildSessionReport(comByok, runs, { generatedAt: '2026-09-29T00:00:00.000Z' });
    expect(r.optimization.totalUsd).toBeCloseTo(session.totalCostUsd, 12);
    const aviso = r.warnings.find((w) => /BYOK/.test(w));
    expect(aviso).toMatch(/4 chamada\(s\) BYOK/);
    expect(aviso).toMatch(/US\$ 0\.2500/);
  });
});
