// IMPL-065 (R-05:REC-4) — zero-dataset é BOOTSTRAP: campeão só sob âncora HUMANA.
//
// Critérios de aceite:
//  1) recusa explícita citando o número de itens curados quando < N;
//  2) N e a sua natureza (proposta sem fonte — calibrar) documentados — aqui no
//     contrato/mensagem da recusa (a documentação no help do comando train/vary
//     vive em src/cli/, FORA da fronteira deste lote);
//  3) IC95 do score reportado no resultado (championDeclaration.scoreCi95Pp);
//  4) teste cobre a recusa E a passagem com ≥ N itens curados.

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
import {
  DEFAULT_MIN_CURATED_ITEMS,
  championDeclarationFor,
  isCuratedItem,
} from '../src/trainer.js';
import * as webTrainer from '../web/src/engine/trainer.js';

function specDe(i: number, over: Partial<StageSpec> = {}): StageSpec {
  return { question: `Pergunta ${i}?`, productContext: 'ctx', maxTokens: 100, ...over };
}

/** Os dois motores exportam o MESMO contrato (mirror em par). */
const MOTORES = [
  ['Node', { championDeclarationFor, isCuratedItem, DEFAULT_MIN_CURATED_ITEMS }],
  ['SPA', {
    championDeclarationFor: webTrainer.championDeclarationFor,
    isCuratedItem: webTrainer.isCuratedItem,
    DEFAULT_MIN_CURATED_ITEMS: webTrainer.DEFAULT_MIN_CURATED_ITEMS,
  }],
] as const;

describe('IMPL-065 — item curado (âncora humana)', () => {
  for (const [nome, api] of MOTORES) {
    it(`${nome}: sintético (origin 'ai') NUNCA é âncora, mesmo com gabarito`, () => {
      expect(api.isCuratedItem(specDe(0, { origin: 'ai', reference: 'gabarito gerado' }))).toBe(false);
      expect(api.isCuratedItem(specDe(0, { origin: 'ai', expected: 'rotulo' }))).toBe(false);
    });

    it(`${nome}: proveniência humana ('import'/custom) com gabarito É âncora`, () => {
      expect(api.isCuratedItem(specDe(0, { origin: 'import', reference: 'gabarito humano' }))).toBe(true);
      expect(api.isCuratedItem(specDe(0, { reference: 'gabarito humano' }))).toBe(true); // custom do usuário
      expect(api.isCuratedItem(specDe(0, { expected: 'rotulo' }))).toBe(true);
    });

    it(`${nome}: sem gabarito não há âncora (referência/expected exigidos)`, () => {
      expect(api.isCuratedItem(specDe(0, { origin: 'import' }))).toBe(false);
      expect(api.isCuratedItem(specDe(0))).toBe(false);
    });
  }
});

describe('IMPL-065 (1/2/4) — declaração de campeão sob piso de itens curados', () => {
  const sinteticos = (n: number): StageSpec[] =>
    Array.from({ length: n }, (_, i) => specDe(i, { origin: 'ai', reference: `gabarito ${i}` }));
  const curados = (n: number): StageSpec[] =>
    Array.from({ length: n }, (_, i) => specDe(i, { reference: `gabarito humano ${i}` }));

  for (const [nome, api] of MOTORES) {
    it(`${nome}: piso DEFAULT é ${DEFAULT_MIN_CURATED_ITEMS} (proposta sem fonte — calibrar)`, () => {
      expect(api.DEFAULT_MIN_CURATED_ITEMS).toBe(20);
    });

    it(`${nome}: zero-dataset (tudo sintético) RECUSA declarar campeão, citando 0 itens curados`, () => {
      const d = api.championDeclarationFor(sinteticos(30));
      expect(d.declared).toBe(false);
      expect(d.curatedItems).toBe(0);
      expect(d.minCuratedItems).toBe(20);
      expect(d.reason).toBe('sem-ancora-humana');
      // Critério 1: a recusa cita o NÚMERO de itens curados e o piso.
      expect(d.message).toContain('0 itens curados');
      expect(d.message).toContain('piso 20');
      // Critério 2: a natureza de N está dita na mensagem (proposta, calibrar).
      expect(d.message).toContain('PROPOSTA sem fonte (calibrar)');
    });

    it(`${nome}: abaixo do piso a recusa cita a contagem real (ex.: 7 de 20)`, () => {
      const specs = [...curados(7), ...sinteticos(13)];
      const d = api.championDeclarationFor(specs);
      expect(d.declared).toBe(false);
      expect(d.curatedItems).toBe(7);
      expect(d.message).toContain('7 itens curados (ancora humana) < piso 20');
    });

    it(`${nome}: ≥ N itens curados DECLARA campeão (critério 4 — passagem)`, () => {
      const d = api.championDeclarationFor(curados(20));
      expect(d.declared).toBe(true);
      expect(d.curatedItems).toBe(20);
      expect(d.reason).toBeUndefined();
      expect(d.message).toBe('campeao declarado com 20 itens curados (ancora humana; piso 20)');
    });

    it(`${nome}: N configurável (minCuratedItems) — e valores inválidos caem no default`, () => {
      expect(api.championDeclarationFor(curados(2), { minCuratedItems: 2 }).declared).toBe(true);
      expect(api.championDeclarationFor(curados(2), { minCuratedItems: 3 }).declared).toBe(false);
      // 0 explícito = piso desligado (decisão consciente do usuário).
      expect(api.championDeclarationFor([], { minCuratedItems: 0 }).declared).toBe(true);
      // Inválido/NaN/negativo ⇒ default 20 (nunca comparação com NaN).
      for (const invalido of [Number.NaN, -1, Number.POSITIVE_INFINITY, 'x']) {
        const d = api.championDeclarationFor(curados(5), { minCuratedItems: invalido as number });
        expect(d.minCuratedItems, String(invalido)).toBe(20);
        expect(d.declared).toBe(false);
      }
    });

    it(`${nome}: IC95 do score entra no resultado (declarado e recusado) — critério 3`, () => {
      const ic: [number, number] = [42.5, 61.0];
      const ok = api.championDeclarationFor(curados(20), { scoreCi95Pp: ic });
      expect(ok.scoreCi95Pp).toEqual(ic);
      const recusado = api.championDeclarationFor(sinteticos(5), { scoreCi95Pp: ic });
      expect(recusado.scoreCi95Pp).toEqual(ic);
      // Sem pares completos o IC é null — presente, nunca sumido.
      expect(api.championDeclarationFor(curados(20)).scoreCi95Pp).toBeNull();
    });
  }
});

// ----------------------------------------------------------------------------
// Integração: o resultado da SESSÃO carrega a declaração (recusa/passagem).
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
    specsSinteticos: boolean;
  } = {
    politica: () => 'parcial',
    nCenarios: 20,
    variantes: ['v0', 'v1', 'v2'],
    specsSinteticos: true,
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
        // IMPL-065: o datagen marca os sintéticos como 'ai'; itens curados
        // (humanos, importados de pacote) vêm SEM essa marca.
        ...(estado.specsSinteticos ? { origin: 'ai' as const } : {}),
      }));
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
  }): Contestant[] {
    const out: Contestant[] = [];
    if (p.includeOriginal && p.originalPrompt) {
      out.push({ id: 'original', label: 'Original', modelId: p.modelId, systemPrompt: p.originalPrompt });
    }
    if (p.carryPrompt) out.push({ id: 'carry', label: 'Carry', modelId: p.modelId, systemPrompt: p.carryPrompt });
    for (const id of estado.variantes) {
      out.push({ id, label: id, modelId: p.modelId, systemPrompt: `prompt ${id}` });
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
    stages: 20,
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
  dir = mkdtempSync(join(tmpdir(), 'pb-impl065-'));
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
  dubles.estado.nCenarios = 20;
  dubles.estado.variantes = ['v0', 'v1', 'v2'];
  dubles.estado.specsSinteticos = true;
  dubles.estado.politica = () => 'parcial';
});

async function treinarNode(cfg: TrainingConfig): Promise<SessionRecord> {
  return await trainToCompletion(cfg, KEY);
}

async function treinarWeb(cfg: TrainingConfig): Promise<SessionRecord> {
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
}

const MOTORES_INT = [
  ['Node', treinarNode],
  ['SPA', treinarWeb],
] as const;

describe('IMPL-065 — integração: o RESULTADO da sessão carrega a declaração', () => {
  for (const [nome, treinar] of MOTORES_INT) {
    it(`${nome}: dataset 100% sintético ⇒ recusa no resultado, citando 0 itens curados e o piso`, async () => {
      dubles.estado.specsSinteticos = true;
      const rec = await treinar(config());
      expect(rec.status, rec.error).toBe('finished');
      const d = rec.championDeclaration!;
      expect(d).toBeDefined();
      expect(d.declared).toBe(false);
      expect(d.curatedItems).toBe(0);
      expect(d.minCuratedItems).toBe(20);
      expect(d.reason).toBe('sem-ancora-humana');
      expect(d.message).toContain('0 itens curados');
      expect(d.message).toContain('piso 20');
      // Critério 3: o IC95 do score está no resultado (null sem par completo,
      // nunca SUMIDO).
      expect('scoreCi95Pp' in d).toBe(true);
    });

    it(`${nome}: ≥ N itens curados ⇒ campeão declarado no resultado`, async () => {
      dubles.estado.specsSinteticos = false;
      const rec = await treinar(config());
      expect(rec.status, rec.error).toBe('finished');
      const d = rec.championDeclaration!;
      expect(d.declared).toBe(true);
      expect(d.curatedItems).toBe(20);
      expect(d.message).toContain('campeao declarado com 20 itens curados');
    });

    it(`${nome}: minCuratedItems configurável vale para a sessão inteira`, async () => {
      dubles.estado.specsSinteticos = true; // 0 curados < 2
      const recusado = await treinar(config({ minCuratedItems: 2 }));
      expect(recusado.championDeclaration!.declared).toBe(false);
      expect(recusado.championDeclaration!.minCuratedItems).toBe(2);
      expect(recusado.championDeclaration!.message).toContain('piso 2');
      // Piso 0 = decisão consciente: declara mesmo sem âncora.
      const liberado = await treinar(config({ minCuratedItems: 0 }));
      expect(liberado.championDeclaration!.declared).toBe(true);
    });
  }
});