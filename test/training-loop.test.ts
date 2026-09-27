// IMPL-013 (R-02b:REC-2) — defaults do LAÇO de treino, nos dois motores.
//
// 1. Política pura (`src/engine/trainingPolicy.ts`): paciência 2, minibatch
//    max(5, ceil(0,3·n)), K ≤ 6 técnicas por iteração, decisão da re-avaliação.
// 2. Sessão com juiz mockado: o laço real (`trainToCompletion` no Node,
//    `startTraining` na SPA) com o orchestrator e o reescritor trocados por
//    dublês DETERMINÍSTICOS — cada run devolve vereditos escolhidos à mão, por
//    TIPO de run (seleção, re-avaliação limpa, holdout). Sem rede, sem gasto.
// 3. Estimativa pré-iteração conta as avaliações extras (re-avaliação + carry),
//    e a porta de orçamento do trainer usa essa conta.

import { competitorMaxTokens, ROLE_MAX_TOKENS } from '../src/roleLimits.js';
import { competitorModelHint } from '../src/competitor.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Contestant,
  RunRecord,
  SessionEvent,
  SessionRecord,
  StageSpec,
  TrainingConfig,
  Verdict,
} from '../src/types.js';

type Kind = 'selection' | 'reeval' | 'holdout';
interface Ctx {
  kind: Kind;
  iteration: number;
  /** Índice do cenário na lista ORIGINAL (`cenario <i>`), não na run. */
  scenario: number;
}
type Politica = (ctx: Ctx, contestantId: string) => Verdict | undefined;

const dubles = vi.hoisted(() => {
  const estado: {
    politica: Politica;
    nCenarios: number;
    variantes: string[];
    runs: { kind: Kind; iteration: number; ids: string[]; questions: string[]; duels: unknown }[];
    geracoes: { includeOriginal?: boolean; carryPrompt?: string; techniqueIds?: string[]; analysisHint?: string }[];
  } = {
    politica: () => 'parcial',
    nCenarios: 20,
    variantes: ['v0', 'v1', 'v2'],
    runs: [],
    geracoes: [],
  };
  const score = { resolve: 1, parcial: 0.5, nao: 0 } as const;

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
      }));
    estado.runs.push({
      kind,
      iteration,
      ids: contestants.map((c) => c.id),
      questions: specs.map((s) => s.question),
      duels: config.duels,
    });
    const stages = specs.map((spec, i) => {
      const scenario = Number(spec.question.replace('cenario ', ''));
      const verdictByContestant: Record<string, Verdict> = {};
      const explanationByContestant: Record<string, string> = {};
      for (const c of contestants) {
        const v = estado.politica({ kind, iteration, scenario }, c.id);
        if (v) verdictByContestant[c.id] = v;
        explanationByContestant[c.id] = `motivo-${c.id}-it${iteration}`;
      }
      return {
        index: i,
        spec,
        responses: [],
        referenceJudge: { verdictByContestant, explanationByContestant, judgeModelId: 'fake/judge' },
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
      iteration,
    } as unknown as RunRecord;
  }

  /** Como o `generateContestants` real: original (se pedido) + carry + variantes. */
  function fakeGenerate(p: {
    modelId: string;
    includeOriginal?: boolean;
    originalPrompt?: string;
    carryPrompt?: string;
    techniqueIds?: string[];
    analysisHint?: string;
  }): Contestant[] {
    const g = estado.geracoes.push({
      includeOriginal: p.includeOriginal,
      carryPrompt: p.carryPrompt,
      techniqueIds: p.techniqueIds,
      analysisHint: p.analysisHint,
    });
    const out: Contestant[] = [];
    if (p.includeOriginal && p.originalPrompt) {
      out.push({ id: 'original', label: 'Original', modelId: p.modelId, systemPrompt: p.originalPrompt });
    }
    if (p.carryPrompt) out.push({ id: 'carry', label: 'Carry', modelId: p.modelId, systemPrompt: p.carryPrompt });
    estado.variantes.forEach((id) =>
      out.push({ id, label: id, modelId: p.modelId, systemPrompt: `prompt ${id} da geracao ${g}` }),
    );
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
// O web re-exporta o variator de src/ (shim): o mesmo dublê vale nos dois.
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

import { createGateway, listModels, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { subscribeSession as subscribeNodeSession } from '../src/events.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { trainToCompletion } from '../src/trainer.js';
import { startTraining as startWebTraining } from '../web/src/engine/trainer.js';
import { subscribeSession } from '../web/src/engine/events.js';
import { estimateInputFromConfig, estimateRunCost, priceCall } from '../src/estimate.js';
import {
  pickReevalMinibatch,
  reevalDecision,
  selectionMinibatchSize,
  shouldStopForPatience,
  techniquesForIteration,
  TECHNIQUES_PER_ITERATION,
  TRAINING_ITERATIONS,
  TRAINING_PATIENCE,
} from '../src/engine/trainingPolicy.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const BASE = 'Voce e um atendente de suporte. Responda com base no contexto do produto.';
const OITO = ['persona', 'cot', 'constraints', 'format', 'fewshot', 'specificity', 'role', 'stepback'];

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
    iterations: 5,
    holdoutRatio: 0,
    feedbackDriven: false,
    timeoutMs: 5_000,
    ...over,
  } as TrainingConfig;
}

// --- 1. política pura -------------------------------------------------------------

describe('IMPL-013 — política do laço (pura)', () => {
  it('defaults fixados: paciência 2, K 4–6, 3–5 iterações', () => {
    expect(TRAINING_PATIENCE).toBe(2);
    expect(TECHNIQUES_PER_ITERATION).toEqual({ min: 4, max: 6 });
    expect(TRAINING_ITERATIONS).toMatchObject({ min: 3, max: 5, default: 3 });
  });

  it('paciência 2: 1 iteração sem promoção NÃO encerra; 2 seguidas encerram', () => {
    expect(shouldStopForPatience(0)).toBe(false);
    expect(shouldStopForPatience(1)).toBe(false);
    expect(shouldStopForPatience(2)).toBe(true);
    expect(shouldStopForPatience(3)).toBe(true);
    // Paciência explícita (o harness usa 1 para reproduzir o laço antigo).
    expect(shouldStopForPatience(1, 1)).toBe(true);
    expect(shouldStopForPatience(2, 3)).toBe(false);
  });

  it('minibatch = max(5, ceil(0,3·n)), limitado a n', () => {
    const casos: [number, number][] = [
      [0, 0],
      [1, 1],
      [4, 4],
      [5, 5],
      [8, 5],
      [16, 5],
      [17, 6], // ceil(5,1)
      [20, 6],
      [21, 7], // ceil(6,3)
      [30, 9],
      [50, 15],
      [51, 16], // ceil(15,3)
    ];
    for (const [n, m] of casos) expect(selectionMinibatchSize(n), `n=${n}`).toBe(m);
    for (let n = 5; n <= 200; n += 1) {
      expect(selectionMinibatchSize(n)).toBe(Math.max(5, Math.ceil((3 * n) / 10)));
    }
  });

  it('minibatch sorteado: tamanho certo, subconjunto, ordem preservada, determinístico', () => {
    const cenarios = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const a = pickReevalMinibatch(cenarios, 42);
    expect(a).toHaveLength(6);
    expect(a.every((c) => cenarios.includes(c))).toBe(true);
    expect([...a].sort((x, y) => cenarios.indexOf(x) - cenarios.indexOf(y))).toEqual(a);
    expect(pickReevalMinibatch(cenarios, 42)).toEqual(a);
    expect(pickReevalMinibatch(cenarios, 43)).not.toEqual(a);
    // Menos de 5 cenários: re-avalia todos.
    expect(pickReevalMinibatch(['x', 'y', 'z'], 1)).toEqual(['x', 'y', 'z']);
  });

  it('K ≤ 6 técnicas por iteração: acima disso elas RODAM e cobrem tudo', () => {
    const seis = OITO.slice(0, 6);
    expect(techniquesForIteration(seis, 3, 7)).toBe(seis);
    expect(techniquesForIteration(undefined, 0, 7)).toBeUndefined();
    const it0 = techniquesForIteration(OITO, 0, 7)!;
    const it1 = techniquesForIteration(OITO, 1, 7)!;
    expect(it0).toHaveLength(6);
    expect(it1).toHaveLength(6);
    expect(new Set(it0).size).toBe(6);
    expect(it1).not.toEqual(it0);
    expect(new Set([...it0, ...it1])).toEqual(new Set(OITO));
    expect(techniquesForIteration(OITO, 0, 7)).toEqual(it0);
  });

  it('re-avaliação: confirma só com melhora ESTRITA nos pares completos', () => {
    expect(reevalDecision([0.5, 0.5, 0.5, 0.5, 0.5], [1, 0.5, 0.5, 0.5, 0.5])).toMatchObject({
      confirmed: true,
      gainPp: 10,
    });
    // Empate não confirma (aceitação estilo GEPA exige melhora).
    expect(reevalDecision([0.5, 1, 0, 0.5, 0.5], [0.5, 1, 0, 0.5, 0.5]).confirmed).toBe(false);
    expect(reevalDecision([1, 1, 1, 1, 1], [0.5, 1, 1, 1, 1]).confirmed).toBe(false);
    // Ausente sai dos dois lados; sem par completo não há evidência.
    const d = reevalDecision([0.5, null, 0.5, 0.5, 0.5], [1, 1, null, 0.5, 0.5]);
    expect(d.pairing).toMatchObject({ n: 5, nEfetivo: 3, excludedPairs: 2 });
    expect(d.confirmed).toBe(true);
    expect(reevalDecision([null, null], [1, 1]).confirmed).toBe(false);
  });
});

// --- 2. sessão com juiz mockado --------------------------------------------------

let prevGw: OpenRouterGateway;
let dir: string;
let dataDirAnterior: string;
beforeAll(() => {
  dataDirAnterior = getDataDir();
  dir = mkdtempSync(join(tmpdir(), 'pb-impl013-'));
  setDataDir(dir);
  // Só o catálogo (GET /models) é consultado — nenhuma chamada de chat.
  const fake = fakeOpenRouter({
    catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/opt'].map((id) => catalogItem(id, 1e-6, 2e-6)),
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
  dubles.estado.runs = [];
  dubles.estado.geracoes = [];
  dubles.estado.nCenarios = 20;
  dubles.estado.variantes = ['v0', 'v1', 'v2'];
});

type ComEventos = { rec: SessionRecord; eventos: SessionEvent[] };

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

const MOTORES = [
  ['Node', treinarNode],
  ['SPA', treinarWeb],
] as const;

const selecoes = () => dubles.estado.runs.filter((r) => r.kind === 'selection');
const reevals = () => dubles.estado.runs.filter((r) => r.kind === 'reeval');

describe('IMPL-013 — paciência 2 numa sessão com juiz mockado', () => {
  for (const [nome, treinar] of MOTORES) {
    it(`${nome}: nunca promove → para só depois de 2 iterações sem promoção (antes: na 1ª)`, async () => {
      dubles.estado.politica = () => 'parcial';
      const { rec, eventos } = await treinar(config({ techniqueIds: OITO }));
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.bestPromptByIteration).toHaveLength(2);
      expect(rec.bestPromptByIteration.map((b) => b.gate?.decision)).toEqual(['held', 'held']);
      expect(rec.convergedAtIteration).toBe(1);
      expect(selecoes()).toHaveLength(2);
      expect(reevals()).toHaveLength(0); // o gate segurou: nada a re-avaliar
      const conv = eventos.filter((e) => e.type === 'session.converged');
      expect(conv).toHaveLength(1);
      expect(conv[0]).toMatchObject({ iteration: 1 });
      // Campeão ainda é a base: o carry a re-testa e o 'original' não se repete.
      const [g0, g1] = dubles.estado.geracoes;
      expect(g0.includeOriginal).toBe(true);
      expect(g1.includeOriginal).toBe(false);
      expect(g1.carryPrompt).toBe(BASE);
      // K ≤ 6: 8 técnicas escolhidas → 6 por iteração, rodando.
      expect(g0.techniqueIds).toHaveLength(6);
      expect(g1.techniqueIds).toHaveLength(6);
      expect(g1.techniqueIds).not.toEqual(g0.techniqueIds);
    });

    it(`${nome}: promoção zera a contagem — sem, promove, sem, sem → para na 4ª`, async () => {
      // Só a iteração 1 tem uma variante real (v0 resolve tudo); a re-avaliação
      // limpa confirma (v0 resolve, régua parcial).
      dubles.estado.politica = (c, id) => (c.iteration === 1 && id === 'v0' ? 'resolve' : 'parcial');
      const { rec, eventos } = await treinar(config());
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.bestPromptByIteration.map((b) => b.gate?.decision)).toEqual(['held', 'promoted', 'held', 'held']);
      expect(rec.bestPromptByIteration.map((b) => b.winnerContestantId)).toEqual(['original', 'v0', 'carry', 'carry']);
      expect(rec.convergedAtIteration).toBe(3);
      expect(eventos.filter((e) => e.type === 'iteration.promoted')).toHaveLength(1);
    });
  }
});

describe('IMPL-013 — re-avaliação LIMPA antes de confirmar a promoção', () => {
  for (const [nome, treinar] of MOTORES) {
    it(`${nome}: passa no gate, a re-avaliação empata → NÃO promove (antes promovia)`, async () => {
      dubles.estado.politica = (c, id) =>
        c.kind === 'selection' && c.iteration === 0 && id === 'v0' ? 'resolve' : 'parcial';
      const { rec, eventos } = await treinar(config({ iterations: 2 }));
      expect(rec.status, rec.error).toBe('finished');
      const g = rec.bestPromptByIteration[0].gate!;
      // O gate da melhor de K sozinho promoveria (Δ 50 p.p., p ajustado ≤ 0,05)...
      expect(g.gainPp).toBe(50);
      expect(g.test!.pAdjusted).toBeLessThanOrEqual(0.05);
      // ...mas a re-avaliação limpa não confirmou.
      expect(g.decision).toBe('held');
      expect(g.heldBy).toEqual(['reeval']);
      expect(g.reeval).toMatchObject({
        candidateId: 'v0',
        controlId: 'original',
        size: 6, // max(5, ceil(0,3 · 20))
        poolSize: 20,
        gainPp: 0,
        confirmed: false,
      });
      expect(g.reeval!.runId).toBeTruthy();
      expect(rec.bestPromptByIteration[0].winnerContestantId).toBe('original');
      expect(eventos.some((e) => e.type === 'iteration.promoted')).toBe(false);
      // A run de re-avaliação: SÓ candidato + régua, 6 cenários de treino, sem finais.
      expect(reevals()).toHaveLength(1);
      const r = reevals()[0];
      expect(r.ids).toEqual(['original', 'v0']);
      expect(r.questions).toHaveLength(6);
      expect(r.duels).toBe(false);
      expect(r.iteration).toBe(0);
    });

    it(`${nome}: re-avaliação confirma → promove, com o Δ limpo no gate`, async () => {
      dubles.estado.politica = (c, id) => (c.iteration === 0 && id === 'v0' ? 'resolve' : 'parcial');
      const { rec, eventos } = await treinar(config({ iterations: 1 }));
      expect(rec.status, rec.error).toBe('finished');
      const g = rec.bestPromptByIteration[0].gate!;
      expect(g.decision).toBe('promoted');
      expect(g.heldBy).toBeUndefined();
      expect(g.reeval).toMatchObject({ confirmed: true, gainPp: 50, size: 6, poolSize: 20 });
      expect(g.reeval!.pairing).toMatchObject({ n: 6, nEfetivo: 6 });
      expect(rec.bestPromptByIteration[0].winnerContestantId).toBe('v0');
      expect(eventos.filter((e) => e.type === 'iteration.promoted')).toHaveLength(1);
    });

    it(`${nome}: minibatch sai SÓ da fatia de treino (holdout fora) — n = 10 → 5`, async () => {
      dubles.estado.politica = (c, id) => (id === 'v0' || id === 'holdout-champion' ? 'resolve' : 'parcial');
      const { rec } = await treinar(config({ iterations: 1, holdoutRatio: 0.25 }));
      expect(rec.status, rec.error).toBe('finished');
      const g = rec.bestPromptByIteration[0].gate!;
      // IMPL-050: 20 cenários, ratio 0,25 sobe para o piso ABSOLUTO de 10 no
      // holdout → 10 de treino → max(5, ceil(3)) = 5 no minibatch.
      expect(g.reeval).toMatchObject({ size: 5, poolSize: 10, confirmed: true });
      const treino = new Set((rec.pinnedStages ?? []).map((s) => s.question));
      expect(treino.size).toBe(10);
      const holdout = dubles.estado.runs.find((r) => r.kind === 'holdout')!;
      expect(reevals()[0].questions.every((q) => treino.has(q) && !holdout.questions.includes(q))).toBe(true);
    });

    it(`${nome}: lições depois de uma iteração sem promoção vêm do CAMPEÃO (carry), não de outra variante`, async () => {
      // it0: v0 promovida. it1: a NOVA v0 passa no gate mas a re-avaliação
      // empata → campeão segue (rodou como 'carry', que falha tudo). it2: as
      // lições têm de ser as falhas do 'carry' — antes vinham da v0 da it1.
      dubles.estado.politica = (c, id) => {
        if (c.iteration === 0) return id === 'v0' ? 'resolve' : 'parcial';
        if (c.iteration === 1) {
          if (c.kind === 'reeval') return 'nao';
          return id === 'v0' ? 'resolve' : 'nao';
        }
        return 'parcial';
      };
      const { rec } = await treinar(config({ iterations: 3, feedbackDriven: true }));
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.bestPromptByIteration.map((b) => b.gate?.decision)).toEqual(['promoted', 'held', 'held']);
      const hint = dubles.estado.geracoes[2].analysisHint ?? '';
      expect(hint).toContain('motivo-carry-it1');
      expect(hint).not.toContain('motivo-v0-it1');
    });
  }
});

// --- 3. estimativa pré-iteração ---------------------------------------------------

describe('IMPL-013 — estimativa pré-iteração conta as avaliações extras', () => {
  it('re-avaliação (2 × m cenários) e carry entram em perIteration; K ≤ 6', async () => {
    const catalogo = await listModels(KEY);
    const cfg = config({ techniqueIds: OITO, maxOutputTokens: 300, optimizerModelId: 'fake/opt' });
    const input = estimateInputFromConfig(cfg);
    expect(input.reevalStages).toBe(6); // max(5, ceil(0,3 · 20))
    expect(input.variantsPerIteration).toBe(6); // 8 técnicas → 6 por iteração
    expect(input.contestantModelIds).toHaveLength(6 + 1 + 1); // técnicas + base + carry

    const com = estimateRunCost(input, catalogo);
    const sem = estimateRunCost({ ...input, reevalStages: 0 }, catalogo);
    const m = (id: string) => catalogo.find((x) => x.id === id);
    // Tetos do IMPL-016: competidor = resposta + folga do degrau; juiz = ROLE_MAX_TOKENS.judge.
    const tetoComp = competitorMaxTokens(300, input.contestantReasoningLevels?.[0], competitorModelHint(m('fake/a'), 500));
    const extra =
      6 * 2 * (priceCall(m('fake/a'), 500, tetoComp) + priceCall(m('fake/judge'), 500 + 300 + 1500, ROLE_MAX_TOKENS.judge));
    expect(extra).toBeGreaterThan(0);
    expect(com.perIteration - sem.perIteration).toBeCloseTo(extra, 12);
    expect(com.point - sem.point).toBeCloseTo(extra * cfg.iterations, 12);
    expect(com.assumptions.reevalStages).toBe(6);
    expect(sem.assumptions.reevalStages).toBe(0);
  });

  it('fora do treino não há re-avaliação nem carry', async () => {
    const catalogo = await listModels(KEY);
    const variation = { ...config(), mode: 'variation', techniqueIds: OITO } as never;
    const input = estimateInputFromConfig(variation);
    expect(input.reevalStages).toBeUndefined();
    expect(input.contestantModelIds).toHaveLength(8 + 1);
    // Mesmo forçando o campo, só o treino o conta.
    expect(estimateRunCost({ ...input, reevalStages: 6 }, catalogo).perIteration).toBe(
      estimateRunCost(input, catalogo).perIteration,
    );
  });

  it('Node: a porta pré-iteração usa a estimativa COM extras (orçamento entre as duas → para)', async () => {
    dubles.estado.politica = () => 'parcial'; // it0 segura; a paciência deixaria seguir
    const catalogo = await listModels(KEY);
    const cfg = config({ techniqueIds: OITO.slice(0, 4), maxOutputTokens: 300, optimizerModelId: 'fake/opt' });
    const input = estimateInputFromConfig(cfg);
    const comExtras = estimateRunCost(input, catalogo).perIteration;
    // A conta ANTIGA: sem re-avaliação e sem o carry.
    const antiga = estimateRunCost(
      { ...input, reevalStages: 0, contestantModelIds: input.contestantModelIds.slice(1) },
      catalogo,
    ).perIteration;
    expect(comExtras).toBeGreaterThan(antiga);
    const budgetUsd = (antiga + comExtras) / 2; // a conta antiga deixaria a it1 começar

    const { rec } = await treinarNode({ ...cfg, budgetUsd });
    expect(rec.status).toBe('aborted');
    expect(rec.stoppedReason).toBe('budget');
    expect(rec.stoppedAtIteration).toBe(1);
    expect(rec.bestPromptByIteration).toHaveLength(1);
    expect(selecoes()).toHaveLength(1);
  });
});
