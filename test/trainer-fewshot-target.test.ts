// O TREINO alimenta o reescritor com o que ele precisa — dois motores (Node e
// SPA; o trainer é mirror editado em par).
//
//   IMPL-061  few-shot com demos REAIS: o trainer passa o conjunto ROTULADO de
//             TREINO (âncora humana; nunca holdout, nunca adversarial, nunca
//             gabarito gerado por IA) em `labeledScenarios`. Na iteração 0 os
//             cenários ainda não congelaram: só lista exata SEM holdout vira
//             demo (senão a demo poderia ser um futuro cenário do teste cego).
//             Contaminação dados→prompt: pergunta usada como demo sai da
//             SELEÇÃO (leave-demos-out) — o prompt a acertaria de graça.
//   IMPL-066  as capacidades do modelo sob teste vêm do CATÁLOGO
//             (`targetModel`: reasoning.mandatory, degraus) — antes nenhum
//             chamador as passava.
//
// Orchestrator e reescritor trocados por dublês determinísticos (o reescritor
// usa as funções REAIS de demo: `selectFewShotDemos` + `applyFewShotDemos`).
// Sem rede, sem gasto.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Contestant,
  IterationGate,
  RunRecord,
  SessionRecord,
  StageSpec,
  TrainingConfig,
  Verdict,
} from '../src/types.js';

type Kind = 'selection' | 'reeval' | 'holdout';

const dubles = vi.hoisted(() => {
  const estado: {
    geracoes: { iteration: number; labeled: { question: string }[]; targetModel?: unknown }[];
    runs: { kind: Kind; iteration: number; questions: string[] }[];
    /** Perguntas que algum prompt da run carrega como demo (medido no dublê). */
    politica: (kind: Kind, question: string, contestantId: string, demos: Set<string>) => Verdict;
  } = { geracoes: [], runs: [], politica: () => 'parcial' };
  return { estado };
});

vi.mock('../src/orchestrator.js', async (orig) => {
  const { fewShotDemosOf } = await import('../src/techniques.js');
  const fakeRun = (config: Record<string, unknown>, _k: string, opts: Record<string, unknown>): RunRecord => {
    const contestants = opts.contestants as Contestant[];
    const pinned = opts.pinnedStages as StageSpec[] | undefined;
    const iteration = opts.iteration as number;
    const kind: Kind = contestants.some((c) => c.id === 'holdout-control')
      ? 'holdout'
      : config.duels === false
        ? 'reeval'
        : 'selection';
    // Como o orchestrator real: pinadas > customStages (o gabarito por IA
    // preenche `reference` onde falta).
    const custom = config.customStages as StageSpec[] | undefined;
    const specs = pinned ?? (custom ?? []).map((s) => (s.reference ? s : { ...s, reference: `gabarito IA ${s.question}` }));
    const demos = new Set(contestants.flatMap((c) => fewShotDemosOf(c.systemPrompt).map((d) => d.question)));
    dubles.estado.runs.push({ kind, iteration, questions: specs.map((s) => s.question) });
    const stages = specs.map((spec, i) => {
      const verdictByContestant: Record<string, Verdict> = {};
      for (const c of contestants) verdictByContestant[c.id] = dubles.estado.politica(kind, spec.question, c.id, demos);
      return {
        index: i,
        spec,
        responses: [],
        referenceJudge: { verdictByContestant, explanationByContestant: {}, judgeModelId: 'fake/judge' },
        startedAt: '2026-09-29T00:00:00.000Z',
      };
    });
    const score = { resolve: 1, parcial: 0.5, nao: 0 } as const;
    return {
      id: opts.runId as string,
      status: 'finished',
      config,
      mode: 'variation',
      contestants,
      stages,
      scoreboard: {},
      judgeScoreByContestant: Object.fromEntries(
        contestants.map((c) => [
          c.id,
          (stages.reduce((a, s) => a + score[s.referenceJudge.verdictByContestant[c.id]], 0) / Math.max(1, stages.length)) * 100,
        ]),
      ),
      totalCostUsd: 0,
      startedAt: '2026-09-29T00:00:00.000Z',
      finishedAt: '2026-09-29T00:00:01.000Z',
      sessionId: opts.sessionId as string,
      iteration,
    } as unknown as RunRecord;
  };
  return {
    ...(await orig<typeof import('../src/orchestrator.js')>()),
    runToCompletion: vi.fn(async (c: Record<string, unknown>, k: string, o: Record<string, unknown>) => fakeRun(c, k, o)),
  };
});
vi.mock('../web/src/engine/orchestrator', async (orig) => {
  const node = await import('../src/orchestrator.js');
  return {
    ...(await orig<typeof import('../web/src/engine/orchestrator.js')>()),
    runToCompletion: node.runToCompletion,
  };
});
vi.mock('../src/variator.js', async (orig) => {
  const { applyFewShotDemos, selectFewShotDemos } = await import('../src/techniques.js');
  return {
    ...(await orig<typeof import('../src/variator.js')>()),
    generateContestants: vi.fn(
      async (p: {
        modelId: string;
        includeOriginal?: boolean;
        originalPrompt?: string;
        carryPrompt?: string;
        labeledScenarios?: { question: string; response?: string; label?: string }[];
        targetModel?: unknown;
      }): Promise<Contestant[]> => {
        const g = dubles.estado.geracoes.push({
          iteration: dubles.estado.geracoes.length,
          labeled: (p.labeledScenarios ?? []).map((l) => ({ question: l.question })),
          targetModel: p.targetModel,
        });
        const out: Contestant[] = [];
        if (p.includeOriginal && p.originalPrompt) {
          out.push({ id: 'original', label: 'Original', modelId: p.modelId, systemPrompt: p.originalPrompt });
        }
        if (p.carryPrompt) out.push({ id: 'carry', label: 'Carry', modelId: p.modelId, systemPrompt: p.carryPrompt });
        // v0 = few-shot (demos REAIS anexadas como o variator faz); v1 = outra técnica.
        const demos = selectFewShotDemos(p.labeledScenarios ?? []);
        out.push({
          id: 'v0',
          label: 'fewshot',
          modelId: p.modelId,
          systemPrompt: applyFewShotDemos(`prompt fewshot da geracao ${g}`, demos),
          techniqueId: 'fewshot',
        });
        out.push({ id: 'v1', label: 'persona', modelId: p.modelId, systemPrompt: `prompt persona da geracao ${g}`, techniqueId: 'persona' });
        return out;
      },
    ),
  };
});
vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { trainToCompletion } from '../src/trainer.js';
import { startTraining as startWebTraining } from '../web/src/engine/trainer.js';
import { subscribeSession } from '../web/src/engine/events.js';
import { splitHoldout } from '../src/holdout.js';
import { FEWSHOT_MAX_DEMOS } from '../src/techniques.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const BASE = 'Voce e um atendente de suporte. Responda com base no contexto do produto.';

/** 30 cenários: 0/1 sintéticos, 2 adversarial, 3 sem gabarito (a run gera por IA); o resto humano. */
const CENARIOS: StageSpec[] = Array.from({ length: 30 }, (_, i) => ({
  question: `cenario ${String(i).padStart(2, '0')}`,
  productContext: 'ctx',
  maxTokens: 100,
  ...(i === 3 ? {} : { reference: `gabarito humano ${i}` }),
  ...(i <= 1 ? { origin: 'ai' as const } : { origin: 'import' as const }),
  ...(i === 2 ? { adversarialCategory: 'jailbreak' } : {}),
}));
const EXCLUIDOS = new Set(['cenario 00', 'cenario 01', 'cenario 02', 'cenario 03']);

function config(over: Partial<TrainingConfig> = {}): TrainingConfig {
  return {
    mode: 'training',
    theme: 'suporte',
    stages: CENARIOS.length,
    customStages: CENARIOS,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceModelId: 'fake/ref',
    referenceJudging: true,
    contestantModelId: 'fake/alvo',
    basePrompt: BASE,
    techniqueIds: ['fewshot', 'persona'],
    iterations: 2,
    holdoutRatio: 0.3,
    feedbackDriven: false,
    timeoutMs: 5_000,
    ...over,
  } as TrainingConfig;
}

let prevGw: OpenRouterGateway;
let dir: string;
let dataDirAnterior: string;
beforeAll(() => {
  dataDirAnterior = getDataDir();
  dir = mkdtempSync(join(tmpdir(), 'pb-fewshot-target-'));
  setDataDir(dir);
  const fake = fakeOpenRouter({
    catalog: [
      ...['fake/gen', 'fake/ref', 'fake/judge'].map((id) => catalogItem(id, 1e-6, 2e-6)),
      // Modelo sob teste que SEMPRE raciocina (catálogo real: 114 modelos assim).
      catalogItem('fake/alvo', 1e-6, 2e-6, {
        supported_parameters: ['reasoning', 'max_tokens'],
        reasoning: { supported_efforts: ['high', 'medium'], default_effort: 'medium', mandatory: true },
      }),
    ],
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
  dubles.estado.geracoes = [];
  dubles.estado.runs = [];
  dubles.estado.politica = () => 'parcial';
});

async function treinarNode(cfg: TrainingConfig): Promise<SessionRecord> {
  return trainToCompletion(cfg, KEY);
}
async function treinarWeb(cfg: TrainingConfig): Promise<SessionRecord> {
  const { sessionId, record } = await startWebTraining(cfg as never, KEY);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sessão não terminou')), 10_000);
    const unsub = subscribeSession(sessionId, (e) => {
      if (e.type === 'session.finished' || e.type === 'session.error') {
        clearTimeout(t);
        unsub();
        resolve();
      }
    });
  });
  return record as unknown as SessionRecord;
}
const MOTORES = [
  ['Node', treinarNode],
  ['SPA', treinarWeb],
] as const;

const holdoutQs = (): Set<string> =>
  new Set(splitHoldout(CENARIOS, 0.3).holdout.map((s) => s.question));

describe('IMPL-061 — demos few-shot REAIS do treino, nunca do teste cego', () => {
  for (const [nome, treinar] of MOTORES) {
    it(`${nome}: iteração 0 sem demos (o holdout vai sair desta lista); iteração 1 só do TREINO com âncora humana`, async () => {
      const rec = await treinar(config());
      expect(rec.status, rec.error).toBe('finished');
      const [g0, g1] = dubles.estado.geracoes;
      expect(g0.labeled).toEqual([]); // cenários ainda não congelaram + haverá holdout
      const treino = new Set(rec.pinnedStages!.map((s) => s.question));
      const reservados = holdoutQs();
      expect(reservados.size).toBe(10);
      expect(g1.labeled.length).toBeGreaterThan(0);
      for (const l of g1.labeled) {
        expect(treino.has(l.question), `${l.question} fora do treino`).toBe(true);
        expect(reservados.has(l.question), `${l.question} é do HOLDOUT`).toBe(false);
        expect(EXCLUIDOS.has(l.question), `${l.question} não tem âncora humana / é adversarial`).toBe(false);
      }
      // Todo item de treino com âncora humana entrou; os excluídos, não.
      const esperados = [...treino].filter((q) => !EXCLUIDOS.has(q));
      expect(g1.labeled.map((l) => l.question).sort()).toEqual(esperados.sort());
    });

    it(`${nome}: leave-demos-out — a pergunta que o prompt carrega como demo NÃO decide a seleção`, async () => {
      // A v0 (few-shot) "acerta de graça" exatamente os cenários que carrega
      // como demo; empata no resto. Sem o leave-demos-out ela ganharia o gate
      // com dados que ela mesma traz no prompt.
      dubles.estado.politica = (kind, q, id, demos) =>
        kind === 'selection' && id === 'v0' && demos.has(q) ? 'resolve' : 'parcial';
      const rec = await treinar(config());
      expect(rec.status, rec.error).toBe('finished');
      const it1 = rec.bestPromptByIteration[1];
      const gate = it1.gate as IterationGate;
      const nTreino = rec.pinnedStages!.length;
      expect(nTreino).toBe(20);
      // n da seleção = treino − demos (e as demos existiram).
      expect(gate.pairing.n).toBe(nTreino - FEWSHOT_MAX_DEMOS);
      expect(gate.gainPp).toBe(0);
      expect(gate.decision).toBe('held');
      expect(it1.winnerContestantId).toBe('carry');
      expect(dubles.estado.runs.filter((r) => r.kind === 'reeval')).toHaveLength(0);
      // A iteração 0 (sem demos) pareou o treino inteiro.
      expect((rec.bestPromptByIteration[0].gate as IterationGate).pairing.n).toBe(nTreino);
    });

    it(`${nome}: holdout desligado + lista exata → demos já na iteração 0 (sem teste cego a proteger)`, async () => {
      const rec = await treinar(config({ holdoutRatio: 0, iterations: 1 }));
      expect(rec.status, rec.error).toBe('finished');
      const [g0] = dubles.estado.geracoes;
      expect(g0.labeled.length).toBe(CENARIOS.length - EXCLUIDOS.size);
    });

    it(`${nome}: seleção pequena demais para perder cenários → sem demos (o gate precisa de poder)`, async () => {
      const poucos = CENARIOS.slice(4, 16); // 12 humanos, holdout desligado: 12 − 5 < 8
      const rec = await treinar(config({ customStages: poucos, stages: poucos.length, holdoutRatio: 0 }));
      expect(rec.status, rec.error).toBe('finished');
      for (const g of dubles.estado.geracoes) expect(g.labeled).toEqual([]);
    });
  }
});

describe('IMPL-066 — o trainer passa as capacidades do CATÁLOGO do modelo sob teste', () => {
  for (const [nome, treinar] of MOTORES) {
    it(`${nome}: targetModel com reasoning.mandatory chega ao reescritor em TODA iteração`, async () => {
      const rec = await treinar(config({ holdoutRatio: 0 }));
      expect(rec.status, rec.error).toBe('finished');
      expect(dubles.estado.geracoes.length).toBeGreaterThanOrEqual(2);
      for (const g of dubles.estado.geracoes) {
        expect(g.targetModel).toMatchObject({ reasoning: { mandatory: true, supportedEfforts: ['high', 'medium'] } });
      }
    });
  }
});
