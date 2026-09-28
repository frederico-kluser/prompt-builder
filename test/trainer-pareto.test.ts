// IMPL-062 (R-02b:REC-4) — pool Pareto: elitismo explícito na fatia única,
// matriz candidato × cenário com amostragem ∝ cobertura atrás de flag, e
// métricas do front reportadas com alerta de RUÍDO (n < 20).
//
// Critérios de aceite:
//  1) com fatia única, RunRecord/SessionRecord.pool NÃO existe mais (elitismo
//     explícito) e nenhum teste espera paretoFront;
//  2) amostragem ∝ cobertura com distribuição verificável (qui-quadrado em
//     test/pareto.test.ts — matriz 3×25, 1.000 amostras, p > 0,05);
//  3) métricas de fração de pares não dominados e tamanho do front reportadas,
//     com alerta > 60% em n < 20.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Contestant,
  RunRecord,
  SessionRecord,
  StageSpec,
  TrainingConfig,
  Verdict,
} from '../src/types.js';
import { normalizeRunRecord } from '../src/normalize.js';
import { PARETO_MIN_N } from '../src/engine/pareto.js';

// ----------------------------------------------------------------------------
// Dublês determinísticos (orchestrator/variator) — sem rede, sem gasto.
// ----------------------------------------------------------------------------

const dubles = vi.hoisted(() => {
  type Kind = 'selection' | 'reeval' | 'holdout';
  interface Ctx {
    kind: Kind;
    iteration: number;
    scenario: number;
  }
  const estado: {
    politica: (ctx: Ctx, contestantId: string) => Verdict | undefined;
    nCenarios: number;
    variantes: string[];
    /** 'geral' = fatia única; 'fatias' = tier mft/adv por cenário. */
    fatias: 'geral' | 'fatias';
    geracoes: { analysisHint?: string; carryPrompt?: string }[];
  } = {
    politica: () => 'parcial',
    nCenarios: 12,
    variantes: ['v0', 'v1', 'v2'],
    fatias: 'geral',
    geracoes: [],
  };

  function fakeRun(config: Record<string, unknown>, _key: string, opts: Record<string, unknown>): RunRecord {
    const contestants = opts.contestants as Contestant[];
    const pinned = opts.pinnedStages as StageSpec[] | undefined;
    const iteration = opts.iteration as number;
    const kind: Kind = contestants.some((c) => c.id === 'holdout-control')
      ? 'holdout'
      : config.duels === false
        ? 'reeval'
        : 'selection';
    const specs: StageSpec[] =
      pinned ??
      Array.from({ length: estado.nCenarios }, (_, i) => ({
        question: `cenario ${i}`,
        productContext: 'ctx',
        maxTokens: 100,
        reference: 'ref',
        ...(estado.fatias === 'fatias' ? { tier: i < estado.nCenarios / 2 ? 'mft' : 'adv' } : {}),
      }));
    const stages = specs.map((spec, i) => {
      const scenario = Number(spec.question.replace('cenario ', ''));
      const verdictByContestant: Record<string, Verdict> = {};
      const explanationByContestant: Record<string, string> = {};
      for (const c of contestants) {
        const v = estado.politica({ kind, iteration, scenario }, c.id);
        if (v) verdictByContestant[c.id] = v;
        explanationByContestant[c.id] = `motivo-${c.id}-it${iteration}-c${scenario}`;
      }
      return {
        index: i,
        spec,
        responses: [],
        referenceJudge: { verdictByContestant, explanationByContestant, judgeModelId: 'fake/judge' },
        startedAt: '2026-09-27T00:00:00.000Z',
      };
    });
    const score = { resolve: 1, parcial: 0.5, nao: 0 } as const;
    const judgeScoreByContestant = Object.fromEntries(
      contestants.map((c) => {
        const vs = stages
          .map((s) => (s.referenceJudge as { verdictByContestant: Record<string, Verdict> }).verdictByContestant[c.id])
          .filter((v): v is Verdict => v !== undefined);
        return [c.id, vs.length ? (vs.reduce((a, v) => a + score[v], 0) / vs.length) * 100 : 0];
      }),
    );
    return {
      id: opts.runId as string,
      status: 'finished',
      config,
      mode: 'variation',
      contestants,
      stages,
      scoreboard: {},
      judgeScoreByContestant,
      totalCostUsd: 0,
      startedAt: '2026-09-27T00:00:00.000Z',
      finishedAt: '2026-09-27T00:00:01.000Z',
      sessionId: opts.sessionId as string,
      iteration,
    } as unknown as RunRecord;
  }

  function fakeGenerate(p: {
    modelId: string;
    includeOriginal?: boolean;
    originalPrompt?: string;
    carryPrompt?: string;
    analysisHint?: string;
  }): Contestant[] {
    estado.geracoes.push({ analysisHint: p.analysisHint, carryPrompt: p.carryPrompt });
    const out: Contestant[] = [];
    if (p.includeOriginal && p.originalPrompt) {
      out.push({ id: 'original', label: 'Original', modelId: p.modelId, systemPrompt: p.originalPrompt });
    }
    if (p.carryPrompt) out.push({ id: 'carry', label: 'Carry', modelId: p.modelId, systemPrompt: p.carryPrompt });
    for (const id of estado.variantes) {
      out.push({ id, label: id, modelId: p.modelId, systemPrompt: `prompt ${id} da geracao` });
    }
    return out;
  }

  return { estado, fakeRun, fakeGenerate };
});

vi.mock('../src/orchestrator.js', async (orig) => ({
  ...(await orig<typeof import('../src/orchestrator.js')>()),
  runToCompletion: vi.fn(async (c: Record<string, unknown>, k: string, o: Record<string, unknown>) =>
    dubles.fakeRun(c, k, o),
  ),
}));
vi.mock('../web/src/engine/orchestrator', async (orig) => ({
  ...(await orig<typeof import('../web/src/engine/orchestrator.js')>()),
  runToCompletion: vi.fn(async (c: Record<string, unknown>, k: string, o: Record<string, unknown>) =>
    dubles.fakeRun(c, k, o),
  ),
}));
vi.mock('../src/variator.js', async (orig) => ({
  ...(await orig<typeof import('../src/variator.js')>()),
  generateContestants: vi.fn(async (p: Parameters<typeof dubles.fakeGenerate>[0]) => dubles.fakeGenerate(p)),
}));
vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

import { trainToCompletion } from '../src/trainer.js';
import { startTraining as startWebTraining } from '../web/src/engine/trainer.js';
import { subscribeSession as subscribeWebSession } from '../web/src/engine/events.js';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { fakeOpenRouter, catalogItem, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const BASE = 'Voce e um atendente de suporte. Responda com base no contexto do produto.';

function config(over: Partial<TrainingConfig> = {}): TrainingConfig {
  return {
    mode: 'training',
    theme: 'suporte ao cliente',
    stages: 12,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceModelId: 'fake/ref',
    referenceJudging: true,
    contestantModelId: 'fake/a',
    basePrompt: BASE,
    iterations: 2,
    holdoutRatio: 0,
    feedbackDriven: false,
    timeoutMs: 5_000,
    ...over,
  } as TrainingConfig;
}

let dir: string;
let dataDirAnterior: string;
let prevGw: OpenRouterGateway;
beforeAll(() => {
  dataDirAnterior = getDataDir();
  dir = mkdtempSync(join(tmpdir(), 'pb-impl062-'));
  setDataDir(dir);
  const fake = fakeOpenRouter({
    catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a'].map((id) => catalogItem(id, 1e-6, 2e-6)),
    chat: () => {
      throw new Error('o teste não deveria chamar chat/completions');
    },
  });
  prevGw = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
});
afterAll(() => {
  setDefaultGateway(prevGw);
  setDataDir(dataDirAnterior);
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  dubles.estado.nCenarios = 12;
  dubles.estado.variantes = ['v0', 'v1', 'v2'];
  dubles.estado.fatias = 'geral';
  dubles.estado.politica = () => 'parcial';
  dubles.estado.geracoes = [];
});

async function treinarNode(cfg: TrainingConfig, logs: string[]): Promise<SessionRecord> {
  const espiao = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  try {
    return await trainToCompletion(cfg, KEY);
  } finally {
    espiao.mockRestore();
  }
}

async function treinarWeb(cfg: TrainingConfig, logs: string[]): Promise<SessionRecord> {
  const espiao = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  try {
    const { sessionId, record } = await startWebTraining(cfg as never, KEY);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('sessão não terminou')), 10_000);
      const unsub = subscribeWebSession(sessionId, (e) => {
        if (e.type === 'session.finished' || e.type === 'session.error') {
          clearTimeout(t);
          unsub();
          resolve();
        }
      });
    });
    return record as unknown as SessionRecord;
  } finally {
    espiao.mockRestore();
  }
}

const MOTORES = [
  ['Node', treinarNode],
  ['SPA', treinarWeb],
] as const;

describe('IMPL-062 (1) — fatia única = elitismo EXPLÍCITO (sem pool/paretoFront)', () => {
  for (const [nome, treinar] of MOTORES) {
    it(`${nome}: mesmo com paretoPool 3, fatia única NÃO forma pool nem paretoFront`, async () => {
      dubles.estado.fatias = 'geral'; // todas as specs caem em 'geral'
      // v0 resolve tudo na iteração 0 (promove); nada muda o fato de haver 1 fatia.
      dubles.estado.politica = (c, id) => (c.iteration === 0 && id === 'v0' ? 'resolve' : 'nao');
      const logs: string[] = [];
      const rec = await treinar(config({ paretoPool: 3 }), logs);
      expect(rec.status, rec.error).toBe('finished');
      // Critério 1: o record NÃO traz pool/paretoFront — o campeão É o estado.
      expect(rec.pool).toBeUndefined();
      expect(rec).not.toHaveProperty('paretoFront');
      // O diagnóstico existe e diz EXPLICITAMENTE que foi elitismo.
      expect(rec.paretoMetrics).toMatchObject({
        mode: 'elitismo',
        n: 12,
        frontSize: 1,
        nonDominatedPairFraction: 0,
      });
    });
  }
});

describe('IMPL-062 (3) — fatias múltiplas: pool + métricas do front + alerta de RUÍDO', () => {
  // Metade 'mft', metade 'adv'. Vencedor de cada iteração (v0 → v1) resolve o
  // mft e vai 'parcial' no adv ⇒ vetor {mft: 100, adv: 50} IGUAL nas duas runs
  // ⇒ nenhum domina ⇒ pares não dominados (fração 1,0) e front 2.
  // Réguas: controle 'nao' em tudo; carry 'parcial' no mft e 'nao' no adv — os
  // diffs do vencedor são positivos em TODO cenário (re-avaliação nunca empata).
  const politicaDuasLinhas = (c: { iteration: number; scenario: number }, id: string): Verdict | undefined => {
    const mft = c.scenario < dubles.estado.nCenarios / 2;
    const vencedor = c.iteration === 0 ? 'v0' : 'v1';
    const regua = c.iteration === 0 ? 'original' : 'carry';
    if (id === vencedor) return mft ? 'resolve' : 'parcial';
    if (id === regua) return c.iteration === 0 ? 'nao' : mft ? 'parcial' : 'nao';
    return 'nao';
  };

  for (const [nome, treinar] of MOTORES) {
    it(`${nome}: pool forma com fatias múltiplas; métricas reportadas e ALERTA com n < 20`, async () => {
      dubles.estado.fatias = 'fatias';
      dubles.estado.nCenarios = 12;
      dubles.estado.politica = politicaDuasLinhas;
      const logs: string[] = [];
      const rec = await treinar(config({ paretoPool: 3, paretoCoverageSampling: true }), logs);
      expect(rec.status, rec.error).toBe('finished');
      // Duas promoções em runs distintas ⇒ 2 membros no pool (vetores iguais:
      // nenhum domina ⇒ front 2).
      expect(rec.pool).toHaveLength(2);
      for (const membro of rec.pool!) {
        expect(membro.bySlice).toEqual({ mft: 100, adv: 50 });
      }
      // Critério 3: fração de pares não dominados + tamanho do front REPORTADOS.
      expect(rec.paretoMetrics).toMatchObject({
        mode: 'pareto',
        n: 12,
        frontSize: 2,
        nonDominatedPairFraction: 1,
      });
      // Alerta de RUÍDO: fração > 60% com n < PARETO_MIN_N (20) — e ele vai
      // para o log, não só para o record.
      expect(PARETO_MIN_N).toBe(20);
      expect(rec.paretoMetrics!.noiseAlert).toBe(true);
      expect(logs.some((l) => l.includes('ALERTA: front = RUIDO'))).toBe(true);
    });

    it(`${nome}: a matriz é alimentada pela run do PRÓPRIO membro (runsById)`, async () => {
      dubles.estado.fatias = 'fatias';
      dubles.estado.nCenarios = 12;
      dubles.estado.politica = politicaDuasLinhas;
      const logs: string[] = [];
      // feedbackDriven ligado: as lições do pai entram no reescritor.
      const rec = await treinar(config({ paretoPool: 3, feedbackDriven: true }), logs);
      expect(rec.status, rec.error).toBe('finished');
      // Com pool ativo o pai da iteração 1 é o membro it-0 e o dossiê vem da
      // RUN DELE (run-0, dono 'v0') — exercita o runsById do IMPL-060.
      const hint = dubles.estado.geracoes[1].analysisHint ?? '';
      expect(hint).toContain('motivo-v0-it0');
      expect(hint).not.toContain('motivo-v1-it0');
    });

    it(`${nome}: n ≥ 20 com a mesma fração NÃO alerta (front sustentado pela amostra)`, async () => {
      // Regra pura já coberta em test/pareto.test.ts; aqui a régua do record.
      dubles.estado.fatias = 'fatias';
      dubles.estado.nCenarios = 25;
      dubles.estado.politica = politicaDuasLinhas;
      const logs: string[] = [];
      const rec = await treinar(config({ paretoPool: 3 }), logs);
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.paretoMetrics!.n).toBe(25);
      expect(rec.paretoMetrics!.nonDominatedPairFraction).toBe(1);
      expect(rec.paretoMetrics!.noiseAlert).toBe(false);
      expect(logs.some((l) => l.includes('ALERTA: front = RUIDO'))).toBe(false);
    });
  }
});

describe('IMPL-062 — subscores por etapa sobrevivem à persistência (whitelists)', () => {
  it('normalizeRunRecord NÃO engole os vereditos por etapa (fonte da matriz)', () => {
    const run = {
      id: 'run-x',
      status: 'finished',
      config: { mode: 'variation', judgeModelIds: ['fake/judge'] },
      mode: 'variation',
      contestants: [{ id: 'v0', label: 'v0', modelId: 'fake/a' }],
      stages: [
        {
          index: 0,
          spec: { question: 'cenario 0', productContext: 'ctx', maxTokens: 100, tier: 'mft' },
          responses: [],
          referenceJudge: {
            verdictByContestant: { v0: 'resolve' },
            explanationByContestant: { v0: 'motivo' },
            judgeModelId: 'fake/judge',
          },
          startedAt: '2026-09-27T00:00:00.000Z',
        },
      ],
      scoreboard: {},
      totalCostUsd: 0,
      startedAt: '2026-09-27T00:00:00.000Z',
    };
    const relido = normalizeRunRecord(JSON.parse(JSON.stringify(run)));
    const st = relido.stages[0];
    // Os SUBSCORES por etapa (vereditos + spec/fatia) são o que alimenta a
    // matriz candidato × cenário — sem eles o pool recompute viraria ruído.
    expect(st.spec?.tier).toBe('mft');
    expect(st.referenceJudge?.verdictByContestant).toEqual({ v0: 'resolve' });
    expect(st.referenceJudge?.explanationByContestant).toEqual({ v0: 'motivo' });
  });
});