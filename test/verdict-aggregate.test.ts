// IMPL-007 (R-03a:DEC-3 + R-04:DEC-5) — fim do arredondamento-para-cima do
// painel de juízes e placar dos duelos com rótulo honesto (taxa de vitória).
//
// Contrato verificado aqui, com transporte FALSO (zero rede, zero gasto):
//   • agregação multi-juiz/reps por MAIORIA SIMPLES: resolve+parcial NÃO vira
//     'resolve' e parcial+nao NÃO vira 'parcial' — sem maioria clara é EMPATE
//     TÉCNICO (marcado), gravado com o nível que a maioria endossa;
//   • a explanation agregada vem de quem votou o veredito agregado, nunca do
//     juiz que deu o voto inflado;
//   • runs novas carimbam `verdictAggregation: 'majority'`; record antigo com
//     painel >= 2 juízes ganha aviso de mudança de escala;
//   • o placar dos duelos é `winRate` (records antigos com `points` seguem
//     legíveis via normalize) e 'Copeland'/'pts' somem da UI e dos docs da CLI.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway, type FetchLike } from '../src/openrouter.js';
import { judgeStageReference } from '../src/refJudge.js';
import { judgeStage } from '../src/judge.js';
import { aggregateAgentVerdict } from '../src/agent/agentJudge.js';
import { judgeScoreFromVerdicts } from '../src/rank.js';
import {
  aggregateVerdicts,
  judgeScaleWarning,
  VERDICT_AGGREGATION,
} from '../src/engine/verdictAggregate.js';
import { standingsFromDuels } from '../src/engine/duelCore.js';
import { normalizeRunRecord } from '../src/normalize.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { getDataDir, loadRun, setDataDir } from '../src/storage.js';
import type {
  CompetitorResponse,
  Contestant,
  DuelOutcome,
  RunConfig,
  RunRecord,
  StageSpec,
  Verdict,
} from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { candidateOf, duelReply, listwiseReply, pointwiseReply } from './judgeReplies.js';

vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

const STAGE: StageSpec = {
  question: 'Qual o prazo para trocar um produto?',
  productContext: 'Trocas em até 30 dias com nota fiscal.',
  maxTokens: 200,
  reference: 'Trinta dias a partir do recebimento, com nota fiscal.',
};

const resp = (id: string, text: string): CompetitorResponse => ({
  contestantId: id,
  modelId: 'fake/a',
  text,
  latencyMs: 1,
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
  status: 'ok',
});
const cont = (id: string): Contestant => ({ id, label: id, modelId: 'fake/a' });
// Contrato do IMPL-006: JSON estrito com o canário do pedido (`test/judgeReplies.ts`).
const OK_JSON = (req: { user: string }, verdict: Verdict, explanation: string): string =>
  pointwiseReply(req, verdict, explanation);

async function comGateway<T>(fetch: FetchLike, fn: () => Promise<T>): Promise<T> {
  const anterior = setDefaultGateway(createGateway({ fetch, sleep: noSleep }));
  try {
    return await fn();
  } finally {
    setDefaultGateway(anterior);
  }
}

/** A média ordinal ANTIGA (limiares 1.5/0.5) — só para provar a diferença. */
function mediaOrdinalAntiga(vs: Verdict[]): Verdict {
  const ord: Record<Verdict, number> = { nao: 0, parcial: 1, resolve: 2 };
  const avg = vs.reduce((s, v) => s + ord[v], 0) / vs.length;
  return avg >= 1.5 ? 'resolve' : avg >= 0.5 ? 'parcial' : 'nao';
}

// ---------------------------------------------------------------------------
// Núcleo puro
// ---------------------------------------------------------------------------

describe('aggregateVerdicts — maioria simples, empate técnico, nunca arredonda para cima', () => {
  it('[resolve, parcial] ≠ resolve e [parcial, nao] ≠ parcial: EMPATE técnico', () => {
    const a = aggregateVerdicts(['resolve', 'parcial'])!;
    expect(a.verdict).not.toBe('resolve');
    expect(a.tie).toBe(true);
    expect(a.verdict).toBe('parcial'); // o nível que os 2 juízes endossam
    expect(a.votes).toEqual(['parcial', 'resolve']);

    const b = aggregateVerdicts(['parcial', 'nao'])!;
    expect(b.verdict).not.toBe('parcial');
    expect(b.tie).toBe(true);
    expect(b.verdict).toBe('nao');

    // A regra antiga fazia exatamente o contrário (é o bug do item).
    expect(mediaOrdinalAntiga(['resolve', 'parcial'])).toBe('resolve');
    expect(mediaOrdinalAntiga(['parcial', 'nao'])).toBe('parcial');
  });

  it('maioria estrita decide sem empate; painel ímpar de 3 dividido em 3 é empate', () => {
    expect(aggregateVerdicts(['resolve', 'resolve', 'parcial'])).toMatchObject({ verdict: 'resolve', tie: false });
    expect(aggregateVerdicts(['nao', 'parcial', 'nao'])).toMatchObject({ verdict: 'nao', tie: false });
    expect(aggregateVerdicts(['resolve'])).toMatchObject({ verdict: 'resolve', tie: false });
    expect(aggregateVerdicts(['resolve', 'resolve'])).toMatchObject({ verdict: 'resolve', tie: false });
    expect(aggregateVerdicts(['nao', 'parcial', 'resolve'])).toMatchObject({ verdict: 'parcial', tie: true });
    expect(aggregateVerdicts(['resolve', 'nao'])).toMatchObject({ verdict: 'nao', tie: true });
    expect(aggregateVerdicts(['resolve', 'resolve', 'parcial', 'parcial'])).toMatchObject({
      verdict: 'parcial',
      tie: true,
    });
  });

  it('todo painel de 1..4 votos: maioria estrita decide; sem ela, empate NUNCA acima da média', () => {
    const ord: Record<Verdict, number> = { nao: 0, parcial: 1, resolve: 2 };
    const niveis: Verdict[] = ['nao', 'parcial', 'resolve'];
    // todos os painéis de 1..4 votos
    const paineis: Verdict[][] = [[]];
    for (let n = 0; n < 4; n++) {
      const prox: Verdict[][] = [];
      for (const p of paineis) for (const v of niveis) prox.push([...p, v]);
      paineis.push(...prox.filter((p) => p.length === n + 1));
    }
    for (const p of paineis.filter((x) => x.length > 0)) {
      const agg = aggregateVerdicts(p)!;
      const media = p.reduce((s, v) => s + ord[v], 0) / p.length;
      const maioria = niveis.find((v) => p.filter((x) => x === v).length * 2 > p.length);
      if (maioria) {
        expect(agg, JSON.stringify(p)).toMatchObject({ verdict: maioria, tie: false });
      } else {
        expect(agg.tie, JSON.stringify(p)).toBe(true);
        expect(ord[agg.verdict], JSON.stringify(p)).toBeLessThanOrEqual(media);
      }
      expect(p, 'o agregado é sempre um dos votos').toContain(agg.verdict);
    }
  });

  it('lista vazia => null (sem voto não há veredito)', () => {
    expect(aggregateVerdicts([])).toBeNull();
  });

  it('judge-score deixa de ser inflado por painel dividido', () => {
    const paineis: Verdict[][] = [
      ['resolve', 'parcial'],
      ['resolve', 'parcial'],
      ['parcial', 'nao'],
      ['resolve', 'resolve'],
    ];
    const novo = judgeScoreFromVerdicts(paineis.map((p) => aggregateVerdicts(p)!.verdict));
    const antigo = judgeScoreFromVerdicts(paineis.map(mediaOrdinalAntiga));
    expect(antigo).toBeCloseTo(87.5, 10); // 3 resolve + 1 parcial
    expect(novo).toBeCloseTo(50, 10); // 1 resolve + 2 parcial + 1 nao
  });

  it('juiz de agente (juízes/reps) usa a mesma maioria', () => {
    expect(aggregateAgentVerdict(['resolve', 'parcial'])).toBe('parcial');
    expect(aggregateAgentVerdict(['parcial', 'nao'])).toBe('nao');
    expect(aggregateAgentVerdict(['resolve', 'resolve', 'nao'])).toBe('resolve');
  });
});

// ---------------------------------------------------------------------------
// Juízes (pointwise e listwise) com painel de 2
// ---------------------------------------------------------------------------

describe('refJudge — painel de 2 juízes dividido', () => {
  const base = { apiKey: KEY, stage: STAGE, timeoutMs: 2_000 };

  it('resolve (j1) + parcial (j2) => parcial com empate técnico; explanation NÃO é a do voto inflado', async () => {
    const fake = fakeOpenRouter({
      chat: (req) =>
        req.model === 'fake/j1'
          ? { text: OK_JSON(req, 'resolve', 'EXPLICACAO-INFLADA') }
          : { text: OK_JSON(req, 'parcial', 'EXPLICACAO-DA-MAIORIA') },
    });
    const r = await comGateway(fake.fetch, () =>
      judgeStageReference({
        ...base,
        judgeModelIds: ['fake/j1', 'fake/j2'],
        responses: [resp('a', 'RESP-A')],
        contestants: [cont('a')],
      }),
    );
    expect(r.verdictByContestant.a).not.toBe('resolve');
    expect(r.verdictByContestant.a).toBe('parcial');
    expect(r.verdictTieByContestant?.a).toEqual(['parcial', 'resolve']);
    expect(r.explanationByContestant.a).toContain('EXPLICACAO-DA-MAIORIA');
    expect(r.explanationByContestant.a).not.toContain('EXPLICACAO-INFLADA');
    expect(r.explanationByContestant.a).toMatch(/^empate técnico \(parcial × resolve\)/);
    expect(r.verdictSourceByContestant?.a).toBe('judge');
  });

  it('parcial + nao => nao (empate); unânime => sem marca de empate', async () => {
    const fake = fakeOpenRouter({
      chat: (req) => {
        if (candidateOf(req) === 'RESP-U') return { text: OK_JSON(req, 'resolve', 'ok') };
        return req.model === 'fake/j1' ? { text: OK_JSON(req, 'parcial', 'meio') } : { text: OK_JSON(req, 'nao', 'errado') };
      },
    });
    const r = await comGateway(fake.fetch, () =>
      judgeStageReference({
        ...base,
        judgeModelIds: ['fake/j1', 'fake/j2'],
        responses: [resp('a', 'RESP-A'), resp('u', 'RESP-U')],
        contestants: [cont('a'), cont('u')],
      }),
    );
    expect(r.verdictByContestant.a).not.toBe('parcial');
    expect(r.verdictByContestant.a).toBe('nao');
    expect(r.explanationByContestant.a).toContain('errado');
    expect(r.verdictByContestant.u).toBe('resolve');
    expect(r.verdictTieByContestant).toEqual({ a: ['nao', 'parcial'] });
  });

  it('painel de 3 com maioria: 2×resolve + 1×parcial => resolve, sem empate', async () => {
    const fake = fakeOpenRouter({
      chat: (req) => ({ text: OK_JSON(req, req.model === 'fake/j3' ? 'parcial' : 'resolve', 'x') }),
    });
    const r = await comGateway(fake.fetch, () =>
      judgeStageReference({
        ...base,
        judgeModelIds: ['fake/j1', 'fake/j2', 'fake/j3'],
        responses: [resp('a', 'RESP-A')],
        contestants: [cont('a')],
      }),
    );
    expect(r.verdictByContestant.a).toBe('resolve');
    expect(r.verdictTieByContestant).toBeUndefined();
  });
});

describe('judge (listwise) — painel de 2 juízes dividido', () => {
  const saida = (req: { user: string }, veredito: Verdict): string =>
    listwiseReply(req, ['A', 'B'], [
      { label: 'A', justificativa: 'x', veredito },
      { label: 'B', justificativa: 'x', veredito },
    ]);

  it('j1 resolve + j2 parcial => parcial (empate técnico), ainda aceitável', async () => {
    const fake = fakeOpenRouter({
      chat: (req) => ({ text: saida(req, req.model === 'fake/j1' ? 'resolve' : 'parcial') }),
    });
    const r = await comGateway(fake.fetch, () =>
      judgeStage({
        apiKey: KEY,
        stage: STAGE,
        timeoutMs: 2_000,
        judgeModelIds: ['fake/j1', 'fake/j2'],
        responses: [resp('a', 'RESP-A'), resp('b', 'RESP-B')],
      }),
    );
    expect(r.verdictByContestant).toEqual({ a: 'parcial', b: 'parcial' });
    expect(r.acceptableByContestant).toEqual({ a: true, b: true });
    expect(r.verdictTieByContestant).toEqual({ a: ['parcial', 'resolve'], b: ['parcial', 'resolve'] });
  });

  it('j1 parcial + j2 nao => nao: deixa de ser aceitável', async () => {
    const fake = fakeOpenRouter({
      chat: (req) => ({ text: saida(req, req.model === 'fake/j1' ? 'parcial' : 'nao') }),
    });
    const r = await comGateway(fake.fetch, () =>
      judgeStage({
        apiKey: KEY,
        stage: STAGE,
        timeoutMs: 2_000,
        judgeModelIds: ['fake/j1', 'fake/j2'],
        responses: [resp('a', 'RESP-A'), resp('b', 'RESP-B')],
      }),
    );
    expect(r.verdictByContestant).toEqual({ a: 'nao', b: 'nao' });
    expect(r.acceptableByContestant).toEqual({ a: false, b: false });
  });
});

// ---------------------------------------------------------------------------
// Mudança de escala: carimbo nas runs novas + aviso nas antigas
// ---------------------------------------------------------------------------

describe('mudança de escala do judge-score', () => {
  it('record antigo (sem carimbo) com painel >= 2 juízes => aviso; juiz único ou carimbado => nada', () => {
    const antigo = { config: { judgeModelIds: ['j1', 'j2'] } };
    expect(judgeScaleWarning(antigo)).toMatch(/não compare/i);
    expect(judgeScaleWarning({ config: { judgeModelIds: ['j1'] } })).toBeUndefined();
    expect(judgeScaleWarning({ ...antigo, verdictAggregation: VERDICT_AGGREGATION })).toBeUndefined();
  });

  it('o aviso sobrevive ao normalizeRunRecord de um record antigo (juiz único legado vira lista)', () => {
    const rec = normalizeRunRecord({
      id: 'r-old',
      status: 'finished',
      config: { mode: 'compare', judgeModelIds: ['j1', 'j2'] },
      stages: [],
    });
    expect(rec.verdictAggregation).toBeUndefined();
    expect(judgeScaleWarning(rec)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Placar dos duelos: winRate (não "pontos Copeland")
// ---------------------------------------------------------------------------

const duel = (a: string, b: string, outcome: 'a' | 'b' | 'tie'): DuelOutcome => ({
  a,
  b,
  order1: { winner: outcome, explanation: '' },
  order2: { winner: outcome, explanation: '' },
  outcome,
});

describe('duelos — taxa de vitória', () => {
  it('divide pelos duelos DISPUTADOS: duelo sem resultado não pune (a soma antiga empatava a e b)', () => {
    // a×b falhou (fora de `duels`); a venceu c; b venceu c e perdeu de d; d só jogou com b.
    const { winRate, order } = standingsFromDuels(
      ['a', 'b', 'c', 'd'],
      [duel('a', 'c', 'a'), duel('b', 'c', 'a'), duel('b', 'd', 'b')],
    );
    expect(winRate).toEqual({ a: 1, b: 0.5, c: 0, d: 1 });
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
  });

  it('normalize: record antigo só com `points` ganha `winRate` derivado dos duelos; standings sem winRate idem', () => {
    const rec = normalizeRunRecord({
      id: 'r-old',
      status: 'finished',
      config: { mode: 'compare', judgeModelIds: ['j'] },
      stages: [
        {
          index: 0,
          responses: [],
          duels: {
            placementByContestant: { x: 1, y: 2, z: 3 },
            order: ['x', 'y', 'z'],
            points: { x: 1, y: 0, z: 0 },
            duels: [duel('x', 'y', 'a')],
            topK: 2,
          },
        },
      ],
      standings: [{ id: 'x', label: 'X', isControl: false, points: 1, wins: 1, ties: 1, losses: 0 }],
    });
    expect(rec.stages[0].duels?.winRate).toEqual({ x: 1, y: 0, z: 0 });
    expect(rec.stages[0].duels?.points).toEqual({ x: 1, y: 0, z: 0 }); // legado preservado
    expect(rec.standings?.[0].winRate).toBe(0.75);
  });

  it("rótulos de usuário: 'Copeland' e 'pts' = 0 na UI e nos docs da CLI", () => {
    const raiz = join(__dirname, '..');
    const alvos = ['agent-docs', 'skills', 'src/cli', 'web/src/pages', 'web/src/components'];
    const ignorar = new Set(['ui', 'motion-ui', 'node_modules']);
    const achados: string[] = [];
    const varrer = (dir: string): void => {
      for (const nome of readdirSync(dir)) {
        const p = join(dir, nome);
        if (statSync(p).isDirectory()) {
          if (!ignorar.has(nome)) varrer(p);
          continue;
        }
        if (!/\.(md|ts|tsx)$/.test(nome)) continue;
        readFileSync(p, 'utf8')
          .split('\n')
          .forEach((linha, i) => {
            if (/copeland/i.test(linha) || /\bpts\b/.test(linha)) achados.push(`${p.slice(raiz.length + 1)}:${i + 1}`);
          });
      }
    };
    for (const a of alvos) varrer(join(raiz, a));
    expect(achados).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pipeline (Node e SPA): carimbo, empate técnico no record e standings por winRate
// ---------------------------------------------------------------------------

const SEIS: StageSpec[] = Array.from({ length: 6 }, (_, i) => ({
  question: `CEN-${i} Qual o prazo para trocar?`,
  productContext: 'Trocas em até 30 dias com nota fiscal.',
  maxTokens: 200,
  reference: `Trinta dias (item ${i}).`,
}));

const PAINEL = {
  mode: 'compare',
  theme: 'suporte',
  stages: 6,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/j1', 'fake/j2'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  customStages: SEIS,
  finalists: 2,
  judgeEngine: 'llm',
  timeoutMs: 5_000,
} as const;

function fakePainel() {
  return fakeOpenRouter({
    catalog: ['fake/j1', 'fake/j2', 'fake/a', 'fake/b', 'fake/ref', 'fake/gen'].map((id) =>
      catalogItem(id, 1e-6, 1e-6),
    ),
    chat: (req) => {
      if (req.stream) return { text: `Resposta de ${req.model}` };
      if (req.system.includes('DUELO')) return { text: duelReply(req, 'A', 'x') };
      if (req.model === 'fake/ref') return { text: 'gabarito' };
      // fake/a divide o painel (j1 resolve, j2 parcial); fake/b é unânime 'resolve'.
      const doA = candidateOf(req) === 'Resposta de fake/a';
      const v: Verdict = doA && req.model === 'fake/j2' ? 'parcial' : 'resolve';
      return { text: OK_JSON(req, v, `voto ${req.model}`) };
    },
  });
}

describe('pipeline — painel de 2 juízes (Node e SPA)', () => {
  let dirAnterior: string;
  let tmp: string;
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl007-'));
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

  const motores = [
    ['Node', (cfg: RunConfig) => runNode(cfg, KEY, {})],
    ['SPA', (cfg: RunConfig) => runWeb(cfg as never, KEY, {}) as unknown as Promise<RunRecord>],
  ] as const;

  for (const [nome, rodar] of motores) {
    it(`${nome}: painel dividido não infla o judge-score; record carimbado; standings por winRate`, async () => {
      const rec = await comGateway(fakePainel().fetch, () => rodar(PAINEL as unknown as RunConfig));
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.verdictAggregation).toBe('majority');
      expect(judgeScaleWarning(rec)).toBeUndefined();
      // fake/a: resolve+parcial em todo cenário => parcial (50), nunca resolve (100).
      expect(rec.judgeScoreByContestant).toEqual({ 'fake/a': 50, 'fake/b': 100 });
      expect(rec.stages[0].referenceJudge?.verdictTieByContestant).toEqual({ 'fake/a': ['parcial', 'resolve'] });
      expect(rec.standings?.length).toBe(2);
      for (const s of rec.standings ?? []) {
        expect(typeof s.winRate).toBe('number');
        expect(s).not.toHaveProperty('points');
      }
      for (const s of rec.stages.filter((x) => x.duels)) {
        expect(s.duels).toHaveProperty('winRate');
        expect(s.duels).not.toHaveProperty('points');
      }
    });
  }

  it('carimbo e empate sobrevivem ao disco + normalizeRunRecord', async () => {
    const rec = await comGateway(fakePainel().fetch, () => runNode(PAINEL as unknown as RunConfig, KEY, {}));
    const relido = await loadRun(rec.id);
    expect(relido?.verdictAggregation).toBe('majority');
    expect(relido?.stages[0].referenceJudge?.verdictTieByContestant).toEqual({ 'fake/a': ['parcial', 'resolve'] });
  });
});
