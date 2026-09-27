// IMPL-005 (R-04:REC-2) — PAREAMENTO HONESTO. Testes de contrato:
//
//   • par sem veredito sai DOS DOIS lados (antes o trainer fazia
//     `VERDICT_SCORE[v ?? 'nao']` e um erro de infra virava par (0,0) ou (x,0),
//     inflando n e movendo o Δ);
//   • n nominal × n efetivo, pares excluídos e completude ficam no record
//     (run e sessão) e SEMPRE visíveis em `runs show`;
//   • exclusões > 10% disparam a sensibilidade pior/melhor caso; conclusão que
//     muda entre os casos é "inconclusivo" (no relatório e no gate).
//
// Zero rede: fixtures montadas à mão + transporte falso do OpenRouter.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatPairCoverage,
  formatRunCompleteness,
  formatSignificance,
  pairCoverage,
  pairDiffs,
  pairedSignificance,
  pairedStageScores,
  primaryRuler,
  runCompleteness,
  sensitivityAnalysis,
  significanceConclusion,
  stageScoresByContestant,
  SENSITIVITY_EXCLUSION_THRESHOLD,
  type PairScore,
} from '../src/stats.js';
import * as webStats from '../web/src/engine/stats.js';
import { pickWinner, type RankEntry } from '../src/rank.js';
import { normalizeRunRecord } from '../src/normalize.js';
import { getDataDir, saveRun, saveSession, setDataDir } from '../src/storage.js';
import { cmdRuns, cmdSessions } from '../src/cli/commands/misc.js';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import type { RunRecord, SessionRecord, Verdict } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

// O storage do web é IndexedDB — fora do navegador, um no-op em memória.
vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

// --- fixtures ----------------------------------------------------------------

interface StageOpts {
  /** Veredito por contestant; `undefined` = SEM veredito (chave ausente). */
  verdicts: Record<string, Verdict | undefined>;
  /** Motivo do ausente (formato do IMPL-004, lido estruturalmente). */
  errors?: Record<string, string>;
  /** Etapa pulada (datagen falhou): sem juiz nenhum. */
  stageError?: boolean;
  incomplete?: boolean;
  /** Etapa só com juiz listwise (gabarito falhou numa run por referência). */
  listwiseOnly?: boolean;
}

function stage(i: number, o: StageOpts): Record<string, unknown> {
  const verdictByContestant = Object.fromEntries(
    Object.entries(o.verdicts).filter((e): e is [string, Verdict] => e[1] !== undefined),
  );
  const base = {
    index: i,
    spec: { question: `cenario ${i}`, productContext: 'ctx', maxTokens: 100, reference: 'ref' },
    responses: [],
    startedAt: '2026-09-27T00:00:00.000Z',
    ...(o.incomplete ? { incomplete: true } : {}),
  };
  if (o.stageError) return { ...base, error: 'datagen falhou' };
  const judge = {
    verdictByContestant,
    ...(o.errors
      ? {
          verdictErrorByContestant: Object.fromEntries(
            Object.entries(o.errors).map(([id, kind]) => [id, { kind, message: 'falhou' }]),
          ),
        }
      : {}),
  };
  if (o.listwiseOnly) {
    return { ...base, judge: { ...judge, rankedContestantIds: [], acceptableByContestant: {}, judges: [], blindMap: {}, rawJudgeText: '' } };
  }
  return {
    ...base,
    referenceJudge: { ...judge, explanationByContestant: {}, judgeModelId: 'fake/judge' },
  };
}

function run(stages: Record<string, unknown>[], ids: string[], extra: Record<string, unknown> = {}): RunRecord {
  return {
    id: `run-${Math.random().toString(36).slice(2, 10)}`,
    status: 'finished',
    config: { mode: 'variation', theme: 'suporte', stages: stages.length, datagenModelId: 'fake/gen', judgeModelIds: ['fake/judge'] },
    mode: 'variation',
    contestants: ids.map((id) => ({ id, label: id === 'original' ? 'Base' : `Variante ${id}`, modelId: 'fake/a', systemPrompt: `prompt ${id}` })),
    stages,
    scoreboard: {},
    totalCostUsd: 0,
    startedAt: '2026-09-27T00:00:00.000Z',
    ...extra,
  } as unknown as RunRecord;
}

/**
 * A run do critério de aceite: 10 etapas, controle 'original' = parcial e
 * variante 'v1' = resolve (Δ real = +0,5 por par), e DUAS etapas sem veredito:
 *   - etapa 3: o juiz falhou só para v1 (controle = resolve ali);
 *   - etapa 7: a etapa foi pulada (sem juiz para ninguém).
 * Os valores são escolhidos para a imputação antiga se DENUNCIAR: a etapa 3
 * imputada daria (1, 0) → Δ −1 e a 7 daria (0, 0) → Δ 0 — nenhum dos dois é
 * o +0,5 dos pares reais.
 */
function runDoCriterio(): RunRecord {
  const stages = Array.from({ length: 10 }, (_, i) => {
    if (i === 3) return stage(i, { verdicts: { original: 'resolve', v1: undefined }, errors: { v1: 'judge_failed' } });
    if (i === 7) return stage(i, { verdicts: {}, stageError: true });
    return stage(i, { verdicts: { original: 'parcial', v1: 'resolve' } });
  });
  return run(stages, ['original', 'v1']);
}

// --- 1. contrato do critério de aceite ------------------------------------------

describe('IMPL-005 — run com 2 etapas sem veredito', () => {
  it('reporta nEfetivo = n−2 e a completude (run, pareamento e teste)', () => {
    const r = runDoCriterio();
    const c = runCompleteness(r);
    expect(c.n).toBe(10);
    expect(c.ruler).toBe('reference');
    expect(c.byContestant.v1).toEqual({
      n: 10,
      nEfetivo: 8,
      missing: 2,
      completeness: 0.8,
      missingByReason: { judge_failed: 1, stage_error: 1 },
    });
    expect(c.byContestant.original).toMatchObject({ n: 10, nEfetivo: 9, missing: 1, missingByReason: { stage_error: 1 } });
    expect(c.controlId).toBe('original');
    expect(c.vsControl?.v1).toMatchObject({ n: 10, nEfetivo: 8, excludedPairs: 2, completeness: 0.8 });

    const { controlScores, championScores } = pairedStageScores(r.stages, 'original', 'v1');
    const sig = pairedSignificance(controlScores, championScores);
    expect(sig).not.toBeNull();
    expect(sig).toMatchObject({ n: 10, nEfetivo: 8, excludedPairs: 2, completeness: 0.8 });
  });

  it('nenhum par imputado: ausente vira null (nunca 0) e fica fora dos diffs', () => {
    const r = runDoCriterio();
    const { controlScores, championScores } = pairedStageScores(r.stages, 'original', 'v1');
    // Onde não há veredito o score é null — o antigo `VERDICT_SCORE[v ?? 'nao']` dava 0.
    expect(championScores[3]).toBeNull();
    expect(controlScores[7]).toBeNull();
    expect(championScores[7]).toBeNull();
    expect(controlScores[3]).toBe(1); // o controle TEM veredito ali; o par sai mesmo assim
    // Nenhum outro null: só as 2 etapas sem veredito saem.
    expect(controlScores.filter((x) => x === null)).toHaveLength(1);
    expect(championScores.filter((x) => x === null)).toHaveLength(2);

    const { diffs, nominal, excluded } = pairDiffs(controlScores, championScores);
    expect(nominal).toBe(10);
    expect(excluded).toBe(2);
    // Todos os diffs são os +0,5 REAIS: um par imputado apareceria como −1 ou 0.
    expect(diffs).toEqual(Array(8).fill(0.5));

    const sig = pairedSignificance(controlScores, championScores)!;
    const limpo = pairedSignificance(Array(8).fill(0.5), Array(8).fill(1))!;
    expect(sig.meanDiffPp).toBe(50);
    expect(sig.pValue).toBe(limpo.pValue);
    expect(sig.pValueTwoSided).toBe(limpo.pValueTwoSided);
    expect(sig.ci95Pp).toEqual(limpo.ci95Pp);

    // O que a imputação antiga produzia — o teste acima a distingue.
    const imputado = pairedSignificance(
      controlScores.map((x) => x ?? 0),
      championScores.map((x) => x ?? 0),
    )!;
    expect(imputado.meanDiffPp).toBe(30);
    expect(imputado.nEfetivo).toBe(10);
  });

  it('as médias do pareamento são SÓ sobre os pares completos (os dois lados)', () => {
    const r = runDoCriterio();
    const { controlScores, championScores } = pairedStageScores(r.stages, 'original', 'v1');
    const cov = pairCoverage(controlScores, championScores);
    // Controle na etapa 3 era 'resolve' — com o par excluído ele não entra na média dele.
    expect(cov.controlMeanPp).toBe(50);
    expect(cov.championMeanPp).toBe(100);
    expect(cov.meanDiffPp).toBe(50);
  });

  it('formatPairCoverage deixa n nominal × efetivo visível (e também sem exclusão)', () => {
    const r = runDoCriterio();
    const c = runCompleteness(r);
    expect(formatPairCoverage(c.vsControl!.v1)).toContain('n efetivo 8 de 10 (2 pares excluídos, completude 80%)');
    const completo = runCompleteness(
      run(Array.from({ length: 5 }, (_, i) => stage(i, { verdicts: { original: 'nao', v1: 'resolve' } })), ['original', 'v1']),
    );
    expect(formatPairCoverage(completo.vsControl!.v1)).toContain('n efetivo 5 de 5 (0 pares excluídos, completude 100%)');
  });
});

// --- 2. régua primária e motivos --------------------------------------------------

describe('IMPL-005 — de onde vem a observação', () => {
  it('run por referência: etapa só com listwise sai como no_reference (mesma régua do judge-score)', () => {
    const r = run(
      [
        stage(0, { verdicts: { original: 'nao', v1: 'resolve' } }),
        stage(1, { verdicts: { original: 'nao', v1: 'resolve' }, listwiseOnly: true }),
        stage(2, { verdicts: { original: 'nao', v1: 'resolve' } }),
      ],
      ['original', 'v1'],
    );
    expect(primaryRuler(r.stages)).toBe('reference');
    const m = stageScoresByContestant(r.stages, ['original', 'v1']);
    expect(m.v1).toEqual([1, null, 1]);
    expect(runCompleteness(r).byContestant.v1.missingByReason).toEqual({ no_reference: 1 });
  });

  it('run legada sem juiz por referência: a régua é o listwise', () => {
    const r = run(
      [0, 1, 2].map((i) => stage(i, { verdicts: { original: 'parcial', v1: 'resolve' }, listwiseOnly: true })),
      ['original', 'v1'],
    );
    expect(primaryRuler(r.stages)).toBe('listwise');
    expect(stageScoresByContestant(r.stages, ['v1']).v1).toEqual([1, 1, 1]);
  });

  it('etapa incompleta (orçamento) não conta, mesmo com veredito gravado', () => {
    const r = run(
      [
        stage(0, { verdicts: { original: 'nao', v1: 'resolve' } }),
        stage(1, { verdicts: { original: 'nao', v1: 'resolve' }, incomplete: true }),
      ],
      ['original', 'v1'],
    );
    expect(stageScoresByContestant(r.stages, ['v1']).v1).toEqual([1, null]);
    expect(runCompleteness(r).byContestant.v1.missingByReason).toEqual({ stage_incomplete: 1 });
  });

  it('sem motivo registrado (record antigo) o ausente é no_verdict — e continua fora', () => {
    const r = run([stage(0, { verdicts: { original: 'nao' } })], ['original', 'v1']);
    expect(runCompleteness(r).byContestant.v1).toMatchObject({ nEfetivo: 0, missingByReason: { no_verdict: 1 } });
  });

  it('a régua da run: holdout-control > carry > original; compare não tem régua', () => {
    const s = [stage(0, { verdicts: {} })];
    expect(runCompleteness(run(s, ['original', 'carry', 'v1'])).controlId).toBe('carry');
    expect(runCompleteness(run(s, ['holdout-control', 'holdout-champion'])).controlId).toBe('holdout-control');
    const compare = runCompleteness(run(s, ['openai/a', 'openai/b']));
    expect(compare.controlId).toBeUndefined();
    expect(compare.vsControl).toBeUndefined();
  });

  it('o web recebe as mesmas funções pelo shim (fonte única)', () => {
    expect(webStats.runCompleteness).toBe(runCompleteness);
    expect(webStats.pairedStageScores).toBe(pairedStageScores);
    expect(webStats.stageScoresByContestant).toBe(stageScoresByContestant);
    expect(webStats.pairCoverage).toBe(pairCoverage);
  });
});

// --- 3. sensibilidade pior/melhor caso ---------------------------------------------

const rep = <T,>(x: T, k: number): T[] => Array(k).fill(x);

describe('IMPL-005 — sensibilidade quando exclusões > 10%', () => {
  it('limiar estrito: 1 de 10 (10%) não dispara; 2 de 10 dispara', () => {
    expect(SENSITIVITY_EXCLUSION_THRESHOLD).toBe(0.1);
    const umAusente = pairCoverage([...rep(0.5, 9), 1], [...rep(1, 9), null]);
    expect(umAusente.worstMeanDiffPp).toBeUndefined();
    expect(umAusente.bestMeanDiffPp).toBeUndefined();
    expect(pairedSignificance([...rep(0.5, 9), 1], [...rep(1, 9), null])?.sensitivity).toBeUndefined();
  });

  it('pior caso: campeão perde todo ausente e controle ganha; melhor: o inverso', () => {
    // 8 pares +0,5; par 9: campeão ausente (controle 1); par 10: os dois ausentes.
    const control: PairScore[] = [...rep(0.5, 8), 1, null];
    const champion: PairScore[] = [...rep(1, 8), null, null];
    const cov = pairCoverage(control, champion);
    // pior: (8·0,5 + (0−1) + (0−1)) / 10 = 0,2 ; melhor: (8·0,5 + (1−1) + (1−0)) / 10 = 0,5
    expect(cov.worstMeanDiffPp).toBe(20);
    expect(cov.bestMeanDiffPp).toBe(50);
    expect(cov.meanDiffPp).toBe(50);
  });

  it('relatório: conclusão que muda no pior caso vira INCONCLUSIVO', () => {
    // Observado: 8 × (+1) → p bilateral 2/256 → "better". Pior: 8 × (+1) e
    // 2 × (−1) → p bilateral 112/1024 ≈ 0,109 → "no-difference".
    const sig = pairedSignificance([...rep(0, 8), null, null], [...rep(1, 8), null, null])!;
    expect(sig.nEfetivo).toBe(8);
    expect(sig.sensitivity).toBeDefined();
    const s = sig.sensitivity!;
    expect(s.excludedFraction).toBe(0.2);
    expect(s.threshold).toBe(0.1);
    expect(s.observed).toMatchObject({ conclusion: 'better', pValueTwoSided: 2 / 256 });
    expect(s.worst.pValueTwoSided).toBeCloseTo(112 / 1024, 12);
    expect(s.worst.conclusion).toBe('no-difference');
    expect(s.best.conclusion).toBe('better');
    expect(s.inconclusive).toBe(true);
    expect(formatSignificance(sig)).toContain('INCONCLUSIVO');
    expect(formatSignificance(sig)).toContain('sensibilidade (20% excluídos)');
  });

  it('relatório: efeito grande sobrevive aos extremos → conclusão robusta', () => {
    // 35 × (+1) e 5 ausentes (12,5%): mesmo com os 5 como −1 o Δ segue enorme.
    const sig = pairedSignificance([...rep(0, 35), ...rep(null, 5)], [...rep(1, 35), ...rep(null, 5)])!;
    expect(sig.sensitivity?.inconclusive).toBe(false);
    expect(sig.sensitivity?.worst.conclusion).toBe('better');
    expect(formatSignificance(sig)).toContain('conclusão robusta');
  });

  it('significanceConclusion: bilateral a 5% com direção pelo sinal do Δ', () => {
    expect(significanceConclusion(0.3, 0.01)).toBe('better');
    expect(significanceConclusion(-0.3, 0.01)).toBe('worse');
    expect(significanceConclusion(0.3, 0.05)).toBe('no-difference');
    expect(significanceConclusion(0, 0.001)).toBe('no-difference');
  });

  it('sensitivityAnalysis é genérica na conclusão (o gate usa Δ ≥ minGain)', () => {
    const s = sensitivityAnalysis([...rep(0, 8), null, null], [...rep(1, 8), null, null], (d) => ({
      meanDiffPp: 0,
      conclusion: d.length === 8 ? 'observado' : 'extremo',
    }));
    expect(s?.observed.conclusion).toBe('observado');
    expect(s?.worst.conclusion).toBe('extremo');
    expect(s?.inconclusive).toBe(true);
  });
});

// --- 4. gate de promoção pareado --------------------------------------------------

const entry = (id: string, judgeScore: number, isControl = false): RankEntry => ({
  id,
  label: id,
  isControl,
  judgeScore,
  errored: 0,
  promptLen: isControl ? 0 : 10,
});

describe('IMPL-005 — gate de promoção com Δ pareado', () => {
  it('sem ausentes, o Δ pareado = diferença dos judge-scores (comportamento preservado)', () => {
    const scoresById = { original: rep(0.5, 6), v1: rep(1, 6) };
    const pick = pickWinner([entry('original', 50, true), entry('v1', 100)], { minGain: 1, scoresById });
    expect(pick.gain).toBeCloseTo(50, 10);
    expect(pick.isWinner).toBe(true);
    expect(pick.gate).toMatchObject({
      controlId: 'original',
      bestId: 'v1',
      minGain: 1,
      gainPp: 50,
      decision: 'promoted',
      pairing: { n: 6, nEfetivo: 6, excludedPairs: 0, completeness: 1 },
    });
    expect(pick.gate?.sensitivity).toBeUndefined();
  });

  it('o ganho é medido SÓ nas etapas com veredito dos dois lados', () => {
    // Controle sem veredito na etapa em que a variante tirou 'nao': os
    // judge-scores (conjuntos diferentes) dariam 90 − 50 = 40; o pareado dá 50.
    const scoresById = { original: [...rep(0.5, 9), null], v1: [...rep(1, 9), 0] };
    const pick = pickWinner([entry('original', 50, true), entry('v1', 90)], { minGain: 1, scoresById });
    expect(pick.gain).toBeCloseTo(50, 10);
    expect(pick.gate?.pairing).toMatchObject({ n: 10, nEfetivo: 9, excludedPairs: 1 });
  });

  it('decisão que muda no pior caso = gate INCONCLUSIVO: não promove', () => {
    // 8 pares completos: 1 × (+0,5) e 7 × 0 → Δ 6,25pp ≥ 1 (promoveria). Os 2
    // ausentes da variante (controle 'resolve' ali) no pior caso: Δ = −15pp.
    const scoresById = { original: [...rep(0.5, 8), 1, 1], v1: [1, ...rep(0.5, 7), null, null] };
    const pick = pickWinner([entry('original', 60, true), entry('v1', 56.25)], { minGain: 1, scoresById });
    expect(pick.gain).toBeCloseTo(6.25, 10);
    expect(pick.isWinner).toBe(false);
    expect(pick.gate?.decision).toBe('inconclusive');
    expect(pick.gate?.sensitivity).toMatchObject({
      excludedFraction: 0.2,
      observed: { conclusion: 'promote', meanDiffPp: 6.25 },
      worst: { conclusion: 'hold', meanDiffPp: -15 },
      best: { conclusion: 'promote' },
      inconclusive: true,
    });
  });

  it('efeito robusto aos extremos promove mesmo com > 10% excluídos', () => {
    const scoresById = { original: rep(0, 10), v1: [...rep(1, 8), null, null] };
    const pick = pickWinner([entry('original', 0, true), entry('v1', 100)], { minGain: 1, scoresById });
    expect(pick.isWinner).toBe(true);
    expect(pick.gate?.decision).toBe('promoted');
    expect(pick.gate?.sensitivity?.inconclusive).toBe(false);
    expect(pick.gate?.sensitivity?.worst.meanDiffPp).toBe(80);
  });

  it('sem nenhum par completo não há evidência: não promove', () => {
    const scoresById = { original: rep(null, 5), v1: rep(1, 5) };
    const pick = pickWinner([entry('original', 0, true), entry('v1', 100)], { minGain: 1, scoresById });
    expect(pick.isWinner).toBe(false);
    expect(pick.gain).toBe(0);
    expect(pick.gate?.pairing.nEfetivo).toBe(0);
    expect(pick.gate?.decision).toBe('inconclusive'); // o melhor caso promoveria
  });

  it('sem scoresById o gate legado (judge-score) segue igual', () => {
    const pick = pickWinner([entry('original', 50, true), entry('v1', 55)], { minGain: 1 });
    expect(pick.gain).toBe(5);
    expect(pick.isWinner).toBe(true);
    expect(pick.gate).toBeUndefined();
  });
});

// --- 5. o record: whitelist e os dois orchestrators ----------------------------------

describe('IMPL-005 — completude no RunRecord', () => {
  it('normalizeRunRecord preserva `completeness` (whitelist)', () => {
    const r = runDoCriterio();
    const comCampo = { ...r, completeness: runCompleteness(r) };
    const relido = normalizeRunRecord(JSON.parse(JSON.stringify(comCampo)));
    expect(relido.completeness).toEqual(runCompleteness(r));
  });

  describe('os dois orchestrators gravam record.completeness (transporte falso)', () => {
    let prev: OpenRouterGateway;
    let dir: string;
    let dataDirAnterior: string;
    const CENARIOS = [
      { question: 'Qual o prazo de troca?', productContext: 'Trocas em 30 dias com nota.', maxTokens: 200 },
      { question: 'Como calcular juros compostos?', productContext: 'M = C (1 + i)^n.', maxTokens: 200 },
    ];
    beforeAll(() => {
      dataDirAnterior = getDataDir();
      dir = mkdtempSync(join(tmpdir(), 'pb-impl005-orch-'));
      setDataDir(dir);
      const fake = fakeOpenRouter({
        catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b'].map((id) => catalogItem(id, 1e-6, 1e-6)),
        chat: (req) => {
          const usage = { prompt_tokens: 10, completion_tokens: 5, cost: 0.00001 };
          if (req.model === 'fake/gen') return { text: JSON.stringify({ stages: CENARIOS }), usage };
          if (req.model === 'fake/ref') return { text: 'Gabarito.', usage };
          if (req.stream) return { text: `Resposta de ${req.model}`, usage };
          if (req.system.includes('DUELO')) return { text: '{"winner":"A","explanation":"A"}', usage };
          return { text: '{"verdict":"resolve","explanation":"ok"}', usage };
        },
      });
      prev = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    });
    afterAll(() => {
      setDefaultGateway(prev);
      setDataDir(dataDirAnterior);
      rmSync(dir, { recursive: true, force: true });
    });
    const CONFIG = {
      mode: 'compare',
      theme: 'suporte ao cliente',
      stages: 2,
      datagenModelId: 'fake/gen',
      judgeModelIds: ['fake/judge'],
      referenceModelId: 'fake/ref',
      referenceJudging: true,
      competitorModelIds: ['fake/a', 'fake/b'],
      finalists: 0,
      timeoutMs: 5_000,
    } as const;

    for (const [nome, runner] of [
      ['Node', runNode],
      ['SPA', runWeb],
    ] as const) {
      it(nome, async () => {
        const rec = (await runner(CONFIG as never, 'sk-or-v1-fake-key-para-teste-0000000000')) as unknown as RunRecord;
        expect(rec.status, rec.error).toBe('finished');
        expect(rec.completeness).toBeDefined();
        expect(rec.completeness).toEqual(runCompleteness(rec));
        expect(rec.completeness?.n).toBe(2);
        expect(rec.completeness?.byContestant['fake/a']).toMatchObject({ n: 2, nEfetivo: 2, completeness: 1 });
      });
    }
  });
});

// --- 6. CLI: `runs show` e `sessions show` ------------------------------------------

async function capturar(fn: () => Promise<number>): Promise<{ code: number; stdout: string }> {
  const chunks: string[] = [];
  const spyOut = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
    return true;
  });
  const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const code = await fn();
    return { code, stdout: chunks.join('') };
  } finally {
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
}

describe('IMPL-005 — `runs show` mostra n nominal × efetivo', () => {
  let dir: string;
  let anterior: string;
  let homeAnterior: string | undefined;
  // O contexto do CLI re-aponta o data dir (padrão ~/.prompt-builder): TODA
  // chamada leva --data-dir e o env aponta p/ o tmp — o teste nunca toca o
  // diretório real do usuário.
  const cli = (argv: string[]): string[] => [...argv, '--data-dir', dir];
  beforeAll(() => {
    anterior = getDataDir();
    homeAnterior = process.env.PROMPT_BUILDER_HOME;
    dir = mkdtempSync(join(tmpdir(), 'pb-impl005-cli-'));
    process.env.PROMPT_BUILDER_HOME = dir;
    setDataDir(dir);
  });
  afterAll(() => {
    if (homeAnterior === undefined) delete process.env.PROMPT_BUILDER_HOME;
    else process.env.PROMPT_BUILDER_HOME = homeAnterior;
    setDataDir(anterior);
    rmSync(dir, { recursive: true, force: true });
  });

  it('--json: `completeness` no payload, com nEfetivo = n−2 e os pares excluídos', async () => {
    const r = runDoCriterio();
    await saveRun({ ...r, completeness: runCompleteness(r) });
    const { code, stdout } = await capturar(() => cmdRuns(cli(['show', r.id, '--json'])));
    expect(code).toBe(0);
    const payload = JSON.parse(stdout) as { data: { completeness: ReturnType<typeof runCompleteness> } };
    expect(payload.data.completeness.byContestant.v1).toMatchObject({ n: 10, nEfetivo: 8, missing: 2 });
    expect(payload.data.completeness.vsControl?.v1).toMatchObject({ n: 10, nEfetivo: 8, excludedPairs: 2, completeness: 0.8 });
  });

  it('texto: a diferença aparece — e run ANTIGA (sem o campo) é recalculada das etapas', async () => {
    const r = runDoCriterio(); // sem `completeness` gravado: record antigo
    await saveRun(r);
    const { stdout } = await capturar(() => cmdRuns(cli(['show', r.id, '--output-format', 'text'])));
    expect(stdout).toContain('n nominal 10');
    expect(stdout).toContain('Variante v1: n efetivo 8 de 10 (completude 80%) — sem veredito: judge_failed 1, stage_error 1');
    expect(stdout).toContain('Base: n efetivo 9 de 10');
    expect(stdout).toContain('pares com a régua (Base):');
    expect(stdout).toContain('Variante v1: n efetivo 8 de 10 (2 pares excluídos, completude 80%)');
  });

  it('texto: SEMPRE visível — run completa mostra "n efetivo 5 de 5"', async () => {
    const r = run(
      Array.from({ length: 5 }, (_, i) => stage(i, { verdicts: { original: 'nao', v1: 'resolve' } })),
      ['original', 'v1'],
    );
    await saveRun(r);
    const { stdout } = await capturar(() => cmdRuns(cli(['show', r.id, '--output-format', 'text'])));
    expect(stdout).toContain('n efetivo 5 de 5 (completude 100%)');
    expect(stdout).toContain('n efetivo 5 de 5 (0 pares excluídos, completude 100%)');
  });

  it('formatRunCompleteness usa o rótulo do contestant', () => {
    const linhas = formatRunCompleteness(runCompleteness(runDoCriterio()), (id) => id.toUpperCase());
    expect(linhas[0]).toBe('observações (régua por referência): n nominal 10');
    expect(linhas).toContain('pares com a régua (ORIGINAL):');
  });

  it('`sessions show` mostra o pareamento final e a significância com n efetivo', async () => {
    const r = runDoCriterio();
    const { controlScores, championScores } = pairedStageScores(r.stages, 'original', 'v1');
    const sessao: SessionRecord = {
      id: 'sessao-impl005',
      status: 'finished',
      config: { mode: 'training', theme: 'suporte', stages: 10, datagenModelId: 'fake/gen', judgeModelIds: ['fake/judge'], contestantModelId: 'fake/a', iterations: 1 },
      runIds: [r.id],
      bestPromptByIteration: [],
      totalCostUsd: 0,
      startedAt: '2026-09-27T00:00:00.000Z',
      significance: pairedSignificance(controlScores, championScores),
      pairing: { source: 'training', controlId: 'original', championId: 'v1', ...pairCoverage(controlScores, championScores) },
    };
    await saveSession(sessao);
    const { stdout } = await capturar(() => cmdSessions(cli(['show', sessao.id, '--output-format', 'text'])));
    expect(stdout).toContain('pareamento (training): n efetivo 8 de 10 (2 pares excluídos, completude 80%)');
    expect(stdout).toContain('significância: ');
    expect(stdout).toContain('n=8 de 10 (2 sem observação)');
  });
});
