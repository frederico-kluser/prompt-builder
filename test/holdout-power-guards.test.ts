// IMPL-050 + IMPL-051 (R-04:REC-5/REC-4) — guardas de poder e de parada no TREINO.
//
// O que se testa (dois motores, Node e SPA — o trainer é mirror editado em par):
//   1. holdout < 10 cenários ⇒ `holdoutSkipped` + "confirmação fraca" e a
//      palavra "validado" NÃO aparece (o campeão não é "validado" sem poder);
//   2. holdout forte (n ≥ 10) ⇒ teste final rotulado (origem do p = holdout,
//      α=0,05 unilateral) e só aí a palavra "validado" aparece;
//   3. paciência configurável (default 2) e a convergência reporta iteração E
//      motivo (platão vs paciência), no record e no evento `session.converged`;
//   4. `patience` é exposta no config (schema) com default 2.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Contestant, RunRecord, SessionRecord, StageSpec, TrainingConfig, Verdict } from '../src/types.js';
import { parseRunConfig } from '../src/runConfigSchema.js';
import {
  holdoutConfirmationText,
  holdoutStrength,
  HOLDOUT_RATIO_DEFAULT,
  holdoutSplitSize,
  MIN_HOLDOUT_SCENARIOS,
  splitHoldout,
} from '../src/holdout.js';
import { TRAINING_PATIENCE } from '../src/engine/trainingPolicy.js';
import { sessionConfirmationText } from '../src/engine/sessionDecision.js';

type Politica = (stageIdx: number, contestantId: string) => Verdict | undefined;

const dubles = vi.hoisted(() => {
  const estado: {
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
vi.mock('../src/variator.js', async (orig) => ({
  ...(await orig<typeof import('../src/variator.js')>()),
  generateContestants: vi.fn(async (p: { includeOriginal?: boolean; carryPrompt?: string }) => [
    ...dubles.estado.contestants.filter((c) => c.id !== 'original' || p.includeOriginal !== false),
    ...(p.carryPrompt ? [{ id: 'carry', label: 'Carry', modelId: 'fake/a', systemPrompt: p.carryPrompt }] : []),
  ]),
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
    iterations: 4,
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
  dir = mkdtempSync(join(tmpdir(), 'pb-impl050-guardas-'));
  setDataDir(dir);
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

interface ComEventos {
  rec: SessionRecord;
  eventos: SessionEvent[];
}

async function treinarNode(cfg: TrainingConfig): Promise<ComEventos> {
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

async function treinarWeb(cfg: TrainingConfig): Promise<ComEventos> {
  const eventos: SessionEvent[] = [];
  const { sessionId, record } = await startWebTraining(cfg as never, KEY);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sessão não terminou')), 15_000);
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

const MOTORES = [
  ['Node', treinarNode],
  ['SPA', treinarWeb],
] as const;

// --- puro: holdout.ts -----------------------------------------------------------

describe('IMPL-050 — piso de 10 cenários de holdout + ratio 0,3', () => {
  it('piso absoluto 10 e ratio default 0,3', () => {
    expect(MIN_HOLDOUT_SCENARIOS).toBe(10);
    expect(HOLDOUT_RATIO_DEFAULT).toBe(0.3);
  });

  it('o tamanho da fatia é max(ratio·n, 10) limitado a n/2', () => {
    expect(holdoutSplitSize(20, 0.2)).toBe(10); // piso absoluto
    expect(holdoutSplitSize(50, 0.3)).toBe(15); // ratio 0,3
    expect(holdoutSplitSize(12, 0.5)).toBe(6); // teto n/2 ⇒ abaixo do piso
    expect(holdoutSplitSize(30, 0)).toBe(0); // 0 desliga
    expect(holdoutSplitSize(30, 7)).toBe(holdoutSplitSize(30, 0.5)); // clamp
  });

  it('abaixo do piso: NÃO é holdout — é "confirmação fraca", e tudo treina', () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    const split = splitHoldout(items, 0.5);
    expect(split.strength).toBe('confirmacao-fraca');
    expect(split.holdout).toHaveLength(0);
    expect(split.train).toEqual(items);
    expect(holdoutStrength(6)).toBe('confirmacao-fraca');
    expect(holdoutStrength(10)).toBe('holdout');
    expect(holdoutStrength(0)).toBe('nenhum');
  });

  it('split intercalado determinístico com a fatia do tamanho planejado', () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const a = splitHoldout(items, 0.2);
    const b = splitHoldout(items, 0.2);
    expect(a.strength).toBe('holdout');
    expect(a.holdout).toHaveLength(10);
    expect(a.holdout).toEqual(b.holdout);
    // As duas fatias amostram a seleção inteira e a união recompõe tudo.
    expect([...a.train, ...a.holdout].sort((x, y) => x - y)).toEqual(items);
    expect(a.train).toHaveLength(15);
  });

  it('a palavra "validado" SÓ aparece com holdout forte, rodado E confirmado', () => {
    const confirmou = { regressed: false, gainPp: 25, pValue: 0.01, pOrigin: 'holdout' as const };
    const forte = holdoutConfirmationText(10, { outcome: confirmou });
    expect(forte).toContain('validado');
    expect(forte).toContain('n=10');
    for (const fraco of [
      holdoutConfirmationText(6, { strength: 'confirmacao-fraca' }),
      holdoutConfirmationText(0, { skipped: true }),
      holdoutConfirmationText(10, { skipped: true }),
      holdoutConfirmationText(0),
    ]) {
      expect(fraco, fraco).toContain('confirmação fraca');
      expect(fraco, fraco).not.toContain('validado');
    }
    // IMPL-050 (gap 1): holdout forte que RODOU mas regrediu, não bateu α ou
    // não tem p do próprio holdout NUNCA diz "validado" — antes dizia só por n ≥ 10.
    for (const naoConfirmou of [
      holdoutConfirmationText(10, { outcome: { ...confirmou, regressed: true, gainPp: -30, pValue: 0.99 } }),
      holdoutConfirmationText(10, { outcome: { ...confirmou, gainPp: -5 } }),
      holdoutConfirmationText(10, { outcome: { ...confirmou, gainPp: 5, pValue: 0.2 } }),
      holdoutConfirmationText(10, { outcome: { ...confirmou, pOrigin: 'selecao' } }),
      holdoutConfirmationText(10, { outcome: { ...confirmou, pValue: null } }),
      holdoutConfirmationText(10),
    ]) {
      expect(naoConfirmou, naoConfirmou).not.toContain('validado');
    }
    expect(
      holdoutConfirmationText(10, { outcome: { ...confirmou, regressed: true, gainPp: -30, pValue: 0.99 } }),
    ).toContain('REGREDIU');
    expect(holdoutConfirmationText(10, { outcome: { ...confirmou, gainPp: 5, pValue: 0.2 } })).toContain('NÃO confirmado');
  });
});

// --- config: `patience` exposta --------------------------------------------------

describe('IMPL-051 — config `patience` exposta, default 2', () => {
  const base = {
    mode: 'training',
    theme: 'suporte',
    stages: 8,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceModelId: 'fake/ref',
    contestantModelId: 'fake/a',
    basePrompt: BASE,
    techniqueIds: ['persona', 'cot'],
    iterations: 3,
  };

  it('o schema aceita `patience` e preserva o valor', () => {
    const r = parseRunConfig({ ...base, patience: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.config as TrainingConfig).patience).toBe(3);
    const r2 = parseRunConfig(base);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect((r2.config as TrainingConfig).patience).toBeUndefined();
  });

  it('recusa patience fora da faixa 1–5 (config inválida)', () => {
    expect(parseRunConfig({ ...base, patience: 0 }).ok).toBe(false);
    expect(parseRunConfig({ ...base, patience: 9 }).ok).toBe(false);
    expect(parseRunConfig({ ...base, patience: 2.5 }).ok).toBe(false);
  });

  it('default 2 fixado na política do laço', () => {
    expect(TRAINING_PATIENCE).toBe(2);
  });
});

// --- integração: o laço real (dois motores) --------------------------------------

describe('IMPL-050/051 — o laço do treino respeita as guardas', () => {
  for (const [nome, treinar] of MOTORES) {
    it(`${nome}: holdout < 10 ⇒ holdoutSkipped + confirmação fraca, SEM "validado"`, async () => {
      dubles.estado.nCenarios = 12;
      dubles.estado.treino = (_i, id) => (id === 'v1' ? 'resolve' : 'nao');
      const { rec } = await treinar(config({ holdoutRatio: 0.5, iterations: 1 }));
      expect(rec.status, rec.error).toBe('finished');
      // 12 cenários com ratio 0,5 → fatia de 6 (< 10): não é holdout.
      expect(rec.holdoutSkipped).toBe(true);
      expect(rec.holdout).toBeUndefined();
      // A significância cai na run de SELEÇÃO e vem rotulada como anti-conservadora.
      expect(rec.significance?.pOrigin).toBe('selecao');
      // A palavra "validado" não aparece em NENHUM texto da confirmação.
      const confirma = holdoutConfirmationText(6, { strength: 'confirmacao-fraca' });
      expect(confirma).toContain('confirmação fraca');
      expect(confirma).not.toContain('validado');
      // Nem no record inteiro.
      expect(JSON.stringify(rec)).not.toContain('validado');
      dubles.estado.nCenarios = 20;
    });

    it(`${nome}: holdout forte (n ≥ 10) ⇒ teste final rotulado como holdout`, async () => {
      dubles.estado.nCenarios = 20;
      dubles.estado.treino = (_i, id) => (id === 'v1' ? 'resolve' : 'nao');
      dubles.estado.holdout = (_i, id) => (id === 'holdout-champion' ? 'resolve' : 'parcial');
      const { rec } = await treinar(config({ holdoutRatio: 0.5, iterations: 1 }));
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.holdout?.n).toBe(10);
      expect(rec.holdoutSkipped).toBeFalsy();
      // IMPL-051: UM teste final em holdout intocado (α=0,05 unilateral) é o
      // único p de confirmação — e a origem vem gravada.
      expect(rec.significance?.pOrigin).toBe('holdout');
      // A frase da sessão (CLI/UI) lê o RESULTADO: campeão 100 × controle 50
      // em 10 pares, p unilateral ≤ 0,05 → "validado".
      expect(sessionConfirmationText(rec)).toContain('validado em holdout');
      expect(rec.holdoutSkipReason).toBeUndefined();
    });

    it(`${nome}: holdout forte que REGREDIU ⇒ "NÃO confirmado", nunca "validado" (IMPL-050)`, async () => {
      dubles.estado.nCenarios = 20;
      dubles.estado.treino = (_i, id) => (id === 'v1' ? 'resolve' : 'nao');
      dubles.estado.holdout = (_i, id) => (id === 'holdout-champion' ? 'nao' : 'resolve');
      const { rec } = await treinar(config({ holdoutRatio: 0.5, iterations: 1 }));
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.holdout).toMatchObject({ n: 10, regressed: true });
      const texto = sessionConfirmationText(rec);
      expect(texto).toContain('REGREDIU');
      expect(texto).not.toContain('validado');
      dubles.estado.holdout = (_i, id) => (id === 'holdout-champion' ? 'resolve' : 'parcial');
    });

    it(`${nome}: paciência default 2 + motivo da convergência (platão vs paciência)`, async () => {
      dubles.estado.nCenarios = 20;
      // Ninguém promove e o ganho é exatamente 0 (IC do ganho abaixo de minGain).
      dubles.estado.treino = () => 'parcial';
      const { rec, eventos } = await treinar(config({ holdoutRatio: 0, iterations: 5 }));
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.bestPromptByIteration).toHaveLength(2); // 2 seguidas sem promoção
      expect(rec.convergedAtIteration).toBe(1);
      // Motivo reportado: platão (IC95 do ganho [0;0]pp < minGain).
      expect(rec.convergenceReason).toBe('plateau');
      const conv = eventos.filter((e) => e.type === 'session.converged');
      expect(conv).toHaveLength(1);
      expect(conv[0]).toMatchObject({ iteration: 1, reason: 'plateau' });
    });

    it(`${nome}: com evidência borderline o motivo é 'patience'`, async () => {
      dubles.estado.nCenarios = 20;
      // v1 resolve em 1 cenário: Δ = 2,5 p.p. com IC cobrindo a margem → o gate
      // segura por significância e a parada vem da PACIÊNCIA (não do platão).
      dubles.estado.treino = (i, id) => (id === 'v1' && i === 0 ? 'resolve' : 'parcial');
      const { rec } = await treinar(config({ holdoutRatio: 0, iterations: 5 }));
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.convergedAtIteration).toBe(1);
      expect(rec.convergenceReason).toBe('patience');
    });

    it(`${nome}: paciência configurável (patience: 1 encerra na 1ª sem promoção)`, async () => {
      dubles.estado.treino = () => 'parcial';
      const { rec } = await treinar(config({ holdoutRatio: 0, iterations: 5, patience: 1 }));
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.bestPromptByIteration).toHaveLength(1);
      expect(rec.convergedAtIteration).toBe(0);
      expect(rec.convergenceReason).toBeDefined();
    });
  }
});
