// IMPL-005 — contrato do pareamento honesto NO TREINO, nos dois motores.
// IMPL-002 — e o gate da melhor de K no laço: max-T sobre as K variantes, p
// ajustado e ganho corrigido no record e no evento `iteration.promoted`.
//
// O laço real (`trainToCompletion` no Node, `startTraining` na SPA) roda com
// o orchestrator e o reescritor trocados por dublês DETERMINÍSTICOS: cada
// "run" devolve vereditos escolhidos à mão, com etapas SEM veredito. O que se
// testa é o que o trainer faz com elas — gate da iteração, holdout,
// significância e o record da sessão —, sem rede e sem gasto.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Contestant, RunRecord, SessionRecord, StageSpec, TrainingConfig, Verdict } from '../src/types.js';

/** Política de vereditos por run: (etapa, contestantId) → veredito | undefined (= ausente). */
type Politica = (stageIdx: number, contestantId: string) => Verdict | undefined;

const dubles = vi.hoisted(() => {
  const estado: {
    /** Política da run de TREINO (sem `pinnedStages`) e da run de holdout. */
    treino: Politica;
    holdout: Politica;
    nCenarios: number;
    contestants: Contestant[];
  } = {
    treino: () => 'nao',
    holdout: () => 'nao',
    nCenarios: 20,
    contestants: [],
  };

  const score = { resolve: 1, parcial: 0.5, nao: 0 } as const;

  /** Monta um RunRecord a partir da política (o que o orchestrator gravaria). */
  function fakeRun(config: unknown, _key: string, opts: Record<string, unknown>): RunRecord {
    const contestants = opts.contestants as Contestant[];
    const pinned = opts.pinnedStages as StageSpec[] | undefined;
    const holdout = contestants.some((c) => c.id === 'holdout-control');
    const specs: StageSpec[] =
      pinned ??
      Array.from({ length: estado.nCenarios }, (_, i) => ({
        question: `cenario ${i}`,
        productContext: 'ctx',
        maxTokens: 100,
        reference: 'ref',
      }));
    const politica = holdout ? estado.holdout : estado.treino;
    const stages = specs.map((spec, i) => {
      const verdictByContestant: Record<string, Verdict> = {};
      const verdictErrorByContestant: Record<string, { kind: string; message: string }> = {};
      for (const c of contestants) {
        const v = politica(i, c.id);
        if (v) verdictByContestant[c.id] = v;
        else verdictErrorByContestant[c.id] = { kind: 'judge_failed', message: 'juiz caiu' };
      }
      return {
        index: i,
        spec,
        responses: [],
        referenceJudge: {
          verdictByContestant,
          explanationByContestant: {},
          verdictErrorByContestant,
          judgeModelId: 'fake/judge',
        },
        startedAt: '2026-09-27T00:00:00.000Z',
      };
    });
    const judgeScoreByContestant = Object.fromEntries(
      contestants.map((c) => {
        const vs = stages
          .map((s) => s.referenceJudge.verdictByContestant[c.id])
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
      iteration: opts.iteration as number,
    } as unknown as RunRecord;
  }

  return { estado, fakeRun };
});

vi.mock('../src/orchestrator.js', async (orig) => ({
  ...(await orig<typeof import('../src/orchestrator.js')>()),
  runToCompletion: vi.fn(async (c: unknown, k: string, o: Record<string, unknown>) => dubles.fakeRun(c, k, o)),
}));
vi.mock('../web/src/engine/orchestrator', async (orig) => ({
  ...(await orig<typeof import('../web/src/engine/orchestrator.js')>()),
  runToCompletion: vi.fn(async (c: unknown, k: string, o: Record<string, unknown>) => dubles.fakeRun(c, k, o)),
}));
// O web re-exporta o variator de src/ (shim): o mesmo dublê vale nos dois.
vi.mock('../src/variator.js', async (orig) => ({
  ...(await orig<typeof import('../src/variator.js')>()),
  generateContestants: vi.fn(async () => dubles.estado.contestants),
}));
vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { subscribeSession as subscribeNodeSession } from '../src/events.js';
import type { SessionEvent } from '../src/types.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { trainToCompletion } from '../src/trainer.js';
import { startTraining as startWebTraining } from '../web/src/engine/trainer.js';
import { subscribeSession } from '../web/src/engine/events.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const BASE = 'Voce e um atendente de suporte. Responda com base no contexto do produto.';

function config(over: Partial<TrainingConfig> = {}): TrainingConfig {
  return {
    mode: 'training',
    theme: 'suporte ao cliente',
    stages: 20,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceModelId: 'fake/ref',
    referenceJudging: true,
    contestantModelId: 'fake/a',
    basePrompt: BASE,
    iterations: 1,
    minGain: 1,
    feedbackDriven: false,
    timeoutMs: 5_000,
    ...over,
  } as TrainingConfig;
}

const CONTESTANTS: Contestant[] = [
  { id: 'original', label: 'Base', modelId: 'fake/a', systemPrompt: BASE },
  { id: 'v1', label: 'Variante 1', modelId: 'fake/a', systemPrompt: 'Prompt variante com regras explicitas.' },
];

let prevGw: OpenRouterGateway;
let dir: string;
let dataDirAnterior: string;
beforeAll(() => {
  dataDirAnterior = getDataDir();
  dir = mkdtempSync(join(tmpdir(), 'pb-impl005-train-'));
  setDataDir(dir);
  // Só o catálogo (GET /models) é consultado — nenhuma chamada de chat.
  const fake = fakeOpenRouter({
    catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a'].map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: () => {
      throw new Error('o teste não deveria chamar chat/completions');
    },
  });
  prevGw = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
  dubles.estado.contestants = CONTESTANTS;
});
afterAll(() => {
  setDefaultGateway(prevGw);
  setDataDir(dataDirAnterior);
  rmSync(dir, { recursive: true, force: true });
});

async function treinarWeb(cfg: TrainingConfig): Promise<SessionRecord> {
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
  return record as unknown as SessionRecord;
}

const MOTORES = [
  ['Node', (cfg: TrainingConfig) => trainToCompletion(cfg, KEY)],
  ['SPA', treinarWeb],
] as const;

describe('IMPL-005 — holdout com 2 etapas sem veredito (critério de aceite)', () => {
  // Treino: v1 resolve tudo, base erra tudo → promoção robusta. Holdout (10
  // cenários, ratio 0,5): controle parcial, campeão resolve, e DUAS etapas sem
  // veredito — a 2 (juiz caiu para o campeão) e a 6 (caiu para os dois).
  beforeAll(() => {
    dubles.estado.treino = (_i, id) => (id === 'v1' ? 'resolve' : 'nao');
    dubles.estado.holdout = (i, id) => {
      if (i === 6) return undefined;
      if (i === 2 && id === 'holdout-champion') return undefined;
      return id === 'holdout-champion' ? 'resolve' : 'parcial';
    };
  });

  for (const [nome, treinar] of MOTORES) {
    it(`${nome}: nEfetivo = n−2 e completude no holdout, no pareamento e na significância`, async () => {
      const rec = await treinar(config({ holdoutRatio: 0.5 }));
      expect(rec.status, rec.error).toBe('finished');

      // Gate da iteração 0: pareado e completo (20 de 20 — o split do holdout
      // acontece DEPOIS da run 0).
      const gate = rec.bestPromptByIteration[0].gate;
      expect(gate).toMatchObject({ controlId: 'original', bestId: 'v1', decision: 'promoted', gainPp: 100 });
      expect(gate?.pairing).toMatchObject({ n: 20, nEfetivo: 20, excludedPairs: 0, completeness: 1 });

      // Holdout: médias SÓ sobre os 8 pares completos (parcial 50 × resolve 100).
      expect(rec.holdout).toMatchObject({
        n: 10,
        nEfetivo: 8,
        excludedPairs: 2,
        completeness: 0.8,
        controlScore: 50,
        championScore: 100,
        gain: 50,
        regressed: false,
      });
      expect(rec.pairing).toMatchObject({
        source: 'holdout',
        controlId: 'holdout-control',
        championId: 'holdout-champion',
        n: 10,
        nEfetivo: 8,
        excludedPairs: 2,
        completeness: 0.8,
        meanDiffPp: 50,
      });
      // 20% excluídos > 10%: os extremos vão para o record.
      expect(rec.pairing?.worstMeanDiffPp).toBeDefined();
      expect(rec.pairing?.bestMeanDiffPp).toBeDefined();

      expect(rec.significance).toMatchObject({ n: 10, nEfetivo: 8, excludedPairs: 2, completeness: 0.8, meanDiffPp: 50 });
      expect(rec.significance?.sensitivity).toBeDefined();
    });
  }
});

describe('IMPL-005 — sem holdout: pareamento da última run de treino', () => {
  beforeAll(() => {
    // 20 cenários; v1 sem veredito nas etapas 4 e 9 (juiz caiu), resolve no resto.
    dubles.estado.treino = (i, id) => {
      if (id === 'v1') return i === 4 || i === 9 ? undefined : 'resolve';
      return 'nao';
    };
  });

  for (const [nome, treinar] of MOTORES) {
    it(`${nome}: significância e pairing com nEfetivo = n−2`, async () => {
      const rec = await treinar(config({ holdoutRatio: 0 }));
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.holdout).toBeUndefined();
      expect(rec.pairing).toMatchObject({ source: 'training', controlId: 'original', championId: 'v1', n: 20, nEfetivo: 18, excludedPairs: 2, completeness: 0.9 });
      expect(rec.significance).toMatchObject({ n: 20, nEfetivo: 18, excludedPairs: 2, completeness: 0.9 });
      // 10% não passa do limiar: sem sensibilidade.
      expect(rec.significance?.sensitivity).toBeUndefined();
      expect(rec.bestPromptByIteration[0].gate?.pairing).toMatchObject({ n: 20, nEfetivo: 18, excludedPairs: 2 });
    });
  }
});

describe('IMPL-005 — gate inconclusivo não promove', () => {
  beforeAll(() => {
    // 10 cenários: base parcial em 0–7 e resolve em 8–9; v1 resolve em 0–7 e
    // SEM veredito em 8–9 → Δ observado 50pp com p = 2^−8 (promoveria: IMPL-002
    // exige o teste, não só a margem), mas no pior caso (v1 perde os 2
    // ausentes) Δ = 20pp com p = 0,232: a promoção dependeria dos ausentes.
    dubles.estado.nCenarios = 10;
    dubles.estado.treino = (i, id) => {
      if (id === 'original') return i >= 8 ? 'resolve' : 'parcial';
      if (i >= 8) return undefined;
      return 'resolve';
    };
  });
  afterAll(() => {
    dubles.estado.nCenarios = 20;
  });

  for (const [nome, treinar] of MOTORES) {
    it(`${nome}: decisão 'inconclusive', campeão segue a base e o treino para`, async () => {
      const rec = await treinar(config({ holdoutRatio: 0, iterations: 3 }));
      expect(rec.status, rec.error).toBe('finished');
      const it0 = rec.bestPromptByIteration[0];
      expect(it0.gate?.decision).toBe('inconclusive');
      expect(it0.gate?.gainPp).toBe(50);
      expect(it0.gate?.sensitivity?.worst.conclusion).toBe('hold');
      expect(it0.winnerContestantId).toBe('original');
      expect(rec.bestPromptByIteration).toHaveLength(1);
      expect(rec.convergedAtIteration).toBe(0);
    });
  }
});

// --- IMPL-002: o laço usa o gate da melhor de K ------------------------------------

type ComEventos = { rec: SessionRecord; eventos: SessionEvent[] };

async function treinarNodeComEventos(cfg: TrainingConfig): Promise<ComEventos> {
  const eventos: SessionEvent[] = [];
  let unsub = (): void => undefined;
  const rec = await trainToCompletion(cfg, KEY, {
    onSession: (id) => {
      unsub = subscribeNodeSession(id, (e) => eventos.push(e));
    },
  });
  unsub();
  return { rec, eventos };
}

async function treinarWebComEventos(cfg: TrainingConfig): Promise<ComEventos> {
  const eventos: SessionEvent[] = [];
  const { sessionId, record } = await startWebTraining(cfg as never, KEY);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sessão não terminou')), 10_000);
    const unsub = subscribeSession(sessionId, (e) => {
      eventos.push(e as unknown as SessionEvent);
      if (e.type === 'session.finished' || e.type === 'session.error') {
        clearTimeout(t);
        unsub();
        resolve();
      }
    });
  });
  return { rec: record as unknown as SessionRecord, eventos };
}

const MOTORES_EVENTOS = [
  ['Node', treinarNodeComEventos],
  ['SPA', treinarWebComEventos],
] as const;

const K3: Contestant[] = [
  ...CONTESTANTS,
  { id: 'v2', label: 'Variante 2', modelId: 'fake/a', systemPrompt: 'Prompt variante 2.' },
  { id: 'v3', label: 'Variante 3', modelId: 'fake/a', systemPrompt: 'Prompt variante 3, mais longa.' },
];

describe('IMPL-002 — efeito real: promove com p ajustado e ganho corrigido', () => {
  beforeAll(() => {
    dubles.estado.contestants = K3;
    // 20 cenários: base parcial; v1 resolve tudo (+50pp); v3 resolve metade; v2 = base.
    dubles.estado.treino = (i, id) => {
      if (id === 'v1') return 'resolve';
      if (id === 'v3') return i % 2 ? 'resolve' : 'parcial';
      return 'parcial';
    };
  });
  afterAll(() => {
    dubles.estado.contestants = CONTESTANTS;
  });

  for (const [nome, treinar] of MOTORES_EVENTOS) {
    it(`${nome}: gate max-T sobre K = 3 no record e no evento iteration.promoted`, async () => {
      const { rec, eventos } = await treinar(config({ holdoutRatio: 0, minGain: undefined }));
      expect(rec.status, rec.error).toBe('finished');
      const gate = rec.bestPromptByIteration[0].gate!;
      expect(gate).toMatchObject({
        bestId: 'v1',
        decision: 'promoted',
        gainPp: 50,
        minGain: 2.5, // default max(1; 50/20)
        minGainSource: 'default',
      });
      expect(gate.test).toMatchObject({ method: 'max-t', enumeration: 'exact', k: 3, alpha: 0.05, nScenarios: 20 });
      expect(gate.test!.pAdjusted).toBeLessThanOrEqual(0.05);
      expect(gate.gainCorrectedPp).toBeLessThanOrEqual(gate.gainPp);
      const promo = eventos.find((e) => e.type === 'iteration.promoted');
      expect(promo).toMatchObject({
        type: 'iteration.promoted',
        championId: 'v1',
        gain: 50,
        gainCorrected: gate.gainCorrectedPp,
        pAdjusted: gate.test!.pAdjusted,
        k: 3,
        method: 'max-t',
        minGain: 2.5,
      });
    });
  }
});

describe('IMPL-002 — melhor de K por acaso: o gate segura (o antigo promovia)', () => {
  beforeAll(() => {
    dubles.estado.contestants = K3;
    // v1 = base + 'resolve' num único cenário: Δ 2,5pp ≥ margem (2,5pp com
    // n = 20; o gate antigo, 1pp, promovia) mas p = 0,5 → não é evidência.
    dubles.estado.treino = (i, id) => (id === 'v1' && i === 0 ? 'resolve' : 'parcial');
  });
  afterAll(() => {
    dubles.estado.contestants = CONTESTANTS;
  });

  for (const [nome, treinar] of MOTORES_EVENTOS) {
    it(`${nome}: 'held' por significância, sem iteration.promoted, treino converge`, async () => {
      const { rec, eventos } = await treinar(config({ holdoutRatio: 0, iterations: 3, minGain: undefined }));
      expect(rec.status, rec.error).toBe('finished');
      const gate = rec.bestPromptByIteration[0].gate!;
      expect(gate).toMatchObject({ bestId: 'v1', decision: 'held', gainPp: 2.5, minGain: 2.5 });
      expect(gate.heldBy).toEqual(['significance']);
      expect(gate.test!.pAdjusted).toBeGreaterThan(0.05);
      expect(rec.bestPromptByIteration).toHaveLength(1);
      expect(rec.convergedAtIteration).toBe(0);
      expect(eventos.some((e) => e.type === 'iteration.promoted')).toBe(false);
    });
  }
});
