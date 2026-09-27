// IMPL-021 — sanidade de custo PONTA A PONTA nos DOIS motores, com transporte
// falso (zero rede, zero gasto). Uma run compare completa (datagen → gabarito
// → competidores em stream → juiz pointwise → finais por duelo) roda pelo
// gateway único e o record precisa fechar a conta:
//   record.totalCostUsd == soma(costByRole) == soma do usage.cost servido,
//   todas as chamadas com preço EXATO (source 'usage'), e a fatia dos
//   competidores == soma(costByContestant).
// No web isso é o que o item corrige: antes a SPA somava só os competidores a
// preço de catálogo (subcontagem por um múltiplo, cache/raciocínio ignorados).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { setDataDir, getDataDir } from '../src/storage.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { startTraining as startWebTraining } from '../web/src/engine/trainer.js';
import { subscribeRun, subscribeSession, getRunRecord } from '../web/src/engine/events.js';
import { prepareOptsFor } from '../src/prepareRun.js';
import { COST_ROLES, type CostEntry, type CostRole, type RunConfig } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter } from './fakeOpenRouter.js';
import { duelReply, pointwiseReply } from './judgeReplies.js';

// O storage do web é IndexedDB — fora do navegador, um no-op em memória.
vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

const CENARIOS = [
  {
    question: 'Qual o prazo para trocar um tenis comprado na loja online?',
    productContext: 'Politica de trocas: 30 dias corridos a partir do recebimento, com nota fiscal.',
    maxTokens: 300,
    rubric: 'Deve citar 30 dias e a nota fiscal.',
  },
  {
    question: 'Explique como calcular juros compostos de um investimento mensal em renda fixa.',
    productContext: 'Voce e um assistente financeiro. Formula: M = C (1 + i)^n.',
    maxTokens: 400,
    rubric: 'Deve apresentar a formula M = C(1+i)^n corretamente.',
  },
];

/**
 * Roteia o fake por modelo/prompt e cobra um custo DISTINTO por chamada
 * (0.0001·(n+1)): dupla contagem, papel perdido ou custo trocado pelo
 * catálogo não fecham a soma.
 */
function fakeDoPipeline(): FakeOpenRouter {
  return fakeOpenRouter({
    catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b', 'fake/opt'].map((id) =>
      // Catálogo CARO de propósito: se o custo viesse dele, o total explodiria.
      catalogItem(id, 1e-3, 1e-3),
    ),
    chat: (req, n) => {
      const usage = { prompt_tokens: 100 + n, completion_tokens: 20, cost: Number((0.0001 * (n + 1)).toFixed(6)) };
      if (req.model === 'fake/gen') return { text: JSON.stringify({ stages: CENARIOS }), usage };
      if (req.model === 'fake/opt') {
        // Reescritor: variante longa o bastante para o piso de comprimento.
        const tecnica = /tecnica id="([^"]+)"/.exec(req.user)?.[1] ?? 'x';
        return {
          text: `Voce e um atendente cordial e preciso (${tecnica}). Responda sempre com base no contexto do produto, cite prazos e regras exatamente como aparecem e recuse o que estiver fora do escopo.`,
          usage,
        };
      }
      if (req.model === 'fake/ref') return { text: `Gabarito: ${req.user.slice(0, 40)}`, usage };
      if (req.stream) return { text: `Resposta de ${req.model}`, usage };
      // Juízes no contrato do IMPL-006: JSON estrito com o canário do pedido.
      if (req.system.includes('DUELO')) return { text: duelReply(req, 'A', 'A melhor'), usage };
      return { text: pointwiseReply(req, 'resolve'), usage };
    },
  });
}

const CONFIG = {
  mode: 'compare',
  theme: 'suporte ao cliente',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  finalists: 2,
  timeoutMs: 5_000,
} as const;

interface CostView {
  status: string;
  error?: string;
  failureCountByRole?: Partial<Record<CostRole, number>>;
  verdictIntegrity?: { reasons: string[] };
  totalCostUsd: number;
  costByRole?: Record<CostRole, CostEntry>;
  costAccuracy?: { exact: number; estimated: number; unknown: number };
  costByContestant?: Record<string, number>;
}

/**
 * A run TERMINOU o pipeline. IMPL-004: com 2 cenários (< piso de 5 julgados
 * por contestant) ela sai `inconclusive`, não `finished` — e o ÚNICO motivo
 * pode ser o n efetivo: nenhum veredito perdido em papel nenhum.
 */
function conferirTermino(rec: CostView): void {
  expect(rec.status, rec.error).toBe('inconclusive');
  expect(rec.verdictIntegrity?.reasons).toEqual([expect.stringMatching(/^n efetivo < 5 cenários julgados/)]);
  expect(rec.failureCountByRole).toBeDefined();
  expect(Object.values(rec.failureCountByRole ?? {}).every((n) => n === 0)).toBe(true);
}

function conferirConta(rec: CostView, fake: FakeOpenRouter): void {
  conferirTermino(rec);
  const byRole = rec.costByRole!;
  expect(byRole, 'record sem costByRole: custo não veio do ledger').toBeDefined();
  const soma = COST_ROLES.reduce((s, r) => s + byRole[r].usd, 0);
  // soma(papéis) == total == fatura
  expect(soma).toBeCloseTo(rec.totalCostUsd, 10);
  expect(rec.totalCostUsd).toBeCloseTo(fake.billedUsd(), 10);
  // todo papel do pipeline contou, com o número certo de chamadas
  expect(byRole.datagen.calls).toBe(1);
  expect(byRole.gabarito.calls).toBe(2);
  expect(byRole.competitor.calls).toBe(4);
  expect(byRole.judge.calls).toBe(4);
  expect(byRole.duel.calls).toBe(4); // 2 cenários × 1 par × 2 ordens
  expect(byRole.rewriter.calls).toBe(0);
  const chamadas = COST_ROLES.reduce((s, r) => s + byRole[r].calls, 0);
  expect(chamadas).toBe(fake.billedCalls());
  // preço MEDIDO em 100% das chamadas (o catálogo caro não entrou)
  expect(rec.costAccuracy).toEqual({ exact: chamadas, estimated: 0, unknown: 0 });
  // a fatia dos competidores é a soma por contestant
  const porContestant = Object.values(rec.costByContestant ?? {}).reduce((s, v) => s + v, 0);
  expect(porContestant).toBeCloseTo(byRole.competitor.usd, 10);
}

describe('IMPL-021 — soma(papéis) == total nos dois motores (transporte falso)', () => {
  let anterior: OpenRouterGateway;
  let dirAnterior: string;
  let tmp: string;
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl021-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
  });

  afterAll(() => {
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  async function comFake<T>(fn: (fake: FakeOpenRouter) => Promise<T>): Promise<T> {
    const fake = fakeDoPipeline();
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    try {
      return await fn(fake);
    } finally {
      setDefaultGateway(anterior);
    }
  }

  it('Node (src/orchestrator): record fecha com a fatura, por papel', async () => {
    await comFake(async (fake) => {
      const rec = await runNode(CONFIG as unknown as RunConfig, KEY, {});
      conferirConta(rec, fake);
    });
  });

  it('SPA (web/src/engine/orchestrator): mesmo gateway, mesmo ledger, mesma conta', async () => {
    await comFake(async (fake) => {
      const rec = await runWeb(CONFIG as never, KEY, {});
      conferirConta(rec as unknown as CostView, fake);
      // O catálogo foi aquecido ANTES do primeiro gasto (espelho do Node).
      const primeiraChat = fake.requests.findIndex((r) => r.path.endsWith('/chat/completions'));
      const catalogo = fake.requests.findIndex((r) => r.path.endsWith('/models'));
      expect(catalogo).toBeGreaterThanOrEqual(0);
      expect(catalogo).toBeLessThan(primeiraChat);
    });
  });

  // Variation: o reescritor roda no `prepare` — que agora recebe o ctx DA RUN.
  // Antes (Node E web) ele chamava o gateway sem sink: o custo das variantes
  // escapava do ledger (e das portas de orçamento no Node).
  const VARIATION = {
    mode: 'variation',
    theme: 'suporte ao cliente',
    stages: 2,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceModelId: 'fake/ref',
    referenceJudging: true,
    contestantModelId: 'fake/a',
    basePrompt: 'Voce e um atendente de suporte. Responda com base no contexto do produto.',
    techniqueIds: ['persona', 'constraints'],
    promptOptimization: true,
    optimizerModelId: 'fake/opt',
    finalists: 2,
    timeoutMs: 5_000,
  } as const;

  function conferirVariation(rec: CostView, fake: FakeOpenRouter): void {
    conferirTermino(rec);
    const byRole = rec.costByRole!;
    expect(byRole.rewriter.calls).toBe(2); // uma reescrita por técnica
    expect(byRole.competitor.calls).toBe(6); // original + 2 variantes × 2 cenários
    const soma = COST_ROLES.reduce((s, r) => s + byRole[r].usd, 0);
    expect(soma).toBeCloseTo(rec.totalCostUsd, 10);
    expect(rec.totalCostUsd).toBeCloseTo(fake.billedUsd(), 10);
    expect(COST_ROLES.reduce((s, r) => s + byRole[r].calls, 0)).toBe(fake.billedCalls());
  }

  it('Node — variation (prepareOptsFor, como CLI/servidor/MCP): reescritor entra no ledger da run', async () => {
    await comFake(async (fake) => {
      const cfg = VARIATION as unknown as RunConfig;
      const rec = await runNode(cfg, KEY, prepareOptsFor(cfg, KEY));
      conferirVariation(rec, fake);
    });
  });

  it('SPA — variation pelo api.ts (createRun): reescritor entra no ledger da run', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => KEY,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    try {
      await comFake(async (fake) => {
        const { createRun } = await import('../web/src/api.js');
        const runId = await createRun(VARIATION as never);
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('run não terminou')), 10_000);
          const fim = (): void => {
            clearTimeout(t);
            unsub();
            resolve();
          };
          const unsub = subscribeRun(runId, (e) => {
            if (e.type === 'run.finished' || e.type === 'run.error') fim();
          });
          if (getRunRecord(runId)?.status !== 'running') fim();
        });
        conferirVariation(getRunRecord(runId) as unknown as CostView, fake);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('SPA — treino: ledger da SESSÃO soma runs + reescritor (antes o reescritor sumia)', async () => {
    await comFake(async (fake) => {
      const cfg = {
        mode: 'training',
        theme: 'suporte ao cliente',
        stages: 2,
        datagenModelId: 'fake/gen',
        judgeModelIds: ['fake/judge'],
        referenceModelId: 'fake/ref',
        referenceJudging: true,
        contestantModelId: 'fake/a',
        basePrompt: 'Voce e um atendente de suporte. Responda com base no contexto do produto.',
        techniqueIds: ['persona', 'constraints'],
        promptOptimization: true,
        optimizerModelId: 'fake/opt',
        iterations: 1,
        holdoutRatio: 0,
        finalists: 2,
        timeoutMs: 5_000,
      };
      const { sessionId, record } = await startWebTraining(cfg as never, KEY);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('sessão não terminou')), 10_000);
        const fim = (): void => {
          clearTimeout(t);
          unsub();
          resolve();
        };
        const unsub = subscribeSession(sessionId, (e) => {
          if (e.type === 'session.finished' || e.type === 'session.error') fim();
        });
        if (record.status !== 'running') fim();
      });
      expect(record.status, record.error).toBe('finished');
      const byRole = record.costByRole!;
      expect(byRole, 'sessão sem costByRole').toBeDefined();
      const soma = COST_ROLES.reduce((s, r) => s + byRole[r].usd, 0);
      expect(soma).toBeCloseTo(record.totalCostUsd, 10);
      expect(record.totalCostUsd).toBeCloseTo(fake.billedUsd(), 10);
      expect(byRole.rewriter.calls).toBe(2); // uma reescrita por técnica
      expect(byRole.competitor.calls).toBe(6); // original + 2 variantes × 2 cenários
      const chamadas = COST_ROLES.reduce((s, r) => s + byRole[r].calls, 0);
      expect(chamadas).toBe(fake.billedCalls());
      expect(record.costAccuracy).toEqual({ exact: chamadas, estimated: 0, unknown: 0 });
    });
  });
});
