// IMPL-112 (R-05:REC-8) — relatório de saturação por item × contestants,
// flag `needsReview` em 100%/0% com k calibrável, fila de REVISÃO HUMANA do
// gabarito (nunca descarte automático) e guarda de IRT (< 30 contestants =
// erro específico citando a limitação, arXiv 2607.15190).

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SATURATION_MIN_EXECUTIONS,
  IRT_MIN_CONTESTANTS,
  IrtSampleSizeError,
  assertIrtSampleSize,
  gabaritoReviewQueue,
  itemSaturationReport,
  type ItemSaturationStage,
} from '../src/datagen.js';
import type { Verdict } from '../src/types.js';

const spec = (question: string, productContext = 'ctx') => ({ question, productContext });

/** Etapa com veredito por contestant (caminho por referência = padrão). */
function refStage(
  index: number,
  question: string,
  verdicts: Record<string, Verdict | Verdict[]>,
): ItemSaturationStage {
  const verdictByContestant: Record<string, Verdict> = {};
  const verdictsByRep: Record<string, Verdict[]> = {};
  for (const [cid, v] of Object.entries(verdicts)) {
    const vs = Array.isArray(v) ? v : [v];
    verdictsByRep[cid] = vs;
    verdictByContestant[cid] = vs[vs.length - 1];
  }
  return { index, spec: spec(question), referenceJudge: { verdictByContestant, verdictsByRep } };
}

describe('itemSaturationReport — taxa de acerto por item × contestants', () => {
  it('reporta taxa de acerto por item e a decomposição por contestant (criterio 1)', () => {
    const report = itemSaturationReport([
      refStage(0, 'item A', { c1: 'resolve', c2: 'nao', c3: 'parcial' }),
    ]);
    expect(report.items).toHaveLength(1);
    const item = report.items[0];
    expect(item.question).toBe('item A');
    expect(item.executions).toBe(3);
    expect(item.resolve).toBe(1);
    expect(item.parcial).toBe(1);
    expect(item.nao).toBe(1);
    expect(item.hitRate).toBeCloseTo(1 / 3, 5);
    // "por item × contestants": uma célula por contestant, na ordem estável.
    expect(item.byContestant.map((c) => c.contestantId)).toEqual(['c1', 'c2', 'c3']);
    const c1 = item.byContestant.find((c) => c.contestantId === 'c1')!;
    expect(c1).toMatchObject({ executions: 1, resolve: 1, parcial: 0, nao: 0, hitRate: 1 });
    const c2 = item.byContestant.find((c) => c.contestantId === 'c2')!;
    expect(c2).toMatchObject({ executions: 1, resolve: 0, nao: 1, hitRate: 0 });
  });

  it('clones de repeat do mesmo item caem na MESMA linha (identidade de conteúdo)', () => {
    const report = itemSaturationReport([
      refStage(0, 'item A', { c1: 'resolve' }),
      refStage(1, 'item A', { c1: 'nao' }), // clone da mesma pergunta
      refStage(2, 'item B', { c1: 'resolve' }),
    ]);
    expect(report.items).toHaveLength(2);
    const itemA = report.items.find((i) => i.question === 'item A')!;
    expect(itemA.stageIndexes).toEqual([0, 1]);
    expect(itemA.executions).toBe(2);
    expect(itemA.resolve).toBe(1);
    expect(itemA.nao).toBe(1);
  });

  it('usa o veredito do juiz listwise como fallback quando não há gabarito', () => {
    const report = itemSaturationReport([
      { index: 0, spec: spec('item A'), judge: { verdictByContestant: { c1: 'resolve', c2: 'resolve' } } },
    ]);
    expect(report.items[0]).toMatchObject({ executions: 2, resolve: 2, hitRate: 1 });
  });
});

describe('needsReview — 100%/0% em k execuções (criterio 2)', () => {
  it('dispara needsReview em 100% resolve e em 100% nao, com o motivo certo', () => {
    const report = itemSaturationReport([
      refStage(0, 'facil d+', { c1: 'resolve', c2: 'resolve', c3: 'resolve' }),
      refStage(1, 'impossivel?', { c1: 'nao', c2: 'nao', c3: 'nao' }),
      refStage(2, 'normal', { c1: 'resolve', c2: 'nao' }),
    ]);
    const [facil, impossivel, normal] = report.items;
    expect(facil.saturated).toBe('all-resolve');
    expect(facil.needsReview).toBe(true);
    expect(facil.needsReviewReason).toMatch(/gabarito/i);
    expect(impossivel.saturated).toBe('all-nao');
    expect(impossivel.needsReview).toBe(true);
    expect(impossivel.needsReviewReason).toMatch(/gabarito/i);
    expect(normal.saturated).toBeNull();
    expect(normal.needsReview).toBe(false);
    expect(normal.needsReviewReason).toBeUndefined();
    expect(report.needsReviewCount).toBe(2);
  });

  it('abaixo de k execuções "100%" é amostra pequena, não sinal', () => {
    const report = itemSaturationReport([
      refStage(0, 'poucas execucoes', { c1: 'resolve', c2: 'resolve' }),
    ]);
    expect(report.items[0].executions).toBe(2);
    expect(report.items[0].saturated).toBeNull();
    expect(report.items[0].needsReview).toBe(false);
  });

  it('k é calibrável (opts.minExecutions)', () => {
    const stages = [refStage(0, 'item A', { c1: 'resolve', c2: 'resolve' })];
    expect(itemSaturationReport(stages).items[0].needsReview).toBe(false);
    expect(itemSaturationReport(stages, { minExecutions: 2 }).items[0].needsReview).toBe(true);
    expect(itemSaturationReport(stages, { minExecutions: 2 }).minExecutions).toBe(2);
    expect(DEFAULT_SATURATION_MIN_EXECUTIONS).toBeGreaterThanOrEqual(1);
  });

  it('reps planas (verdictsByRep) contam como execuções independentes', () => {
    const report = itemSaturationReport([
      refStage(0, 'com reps', { c1: ['resolve', 'resolve', 'resolve'] }),
    ]);
    expect(report.items[0]).toMatchObject({ executions: 3, resolve: 3, saturated: 'all-resolve', needsReview: true });
  });
});

describe('fila de revisão humana do gabarito — NUNCA descarte automático (criterio 4)', () => {
  it('reviewQueue enfileira os needsReview e o relatório mantém TODOS os itens', () => {
    const report = itemSaturationReport([
      refStage(0, 'impossivel?', { c1: 'nao', c2: 'nao', c3: 'nao' }),
      refStage(1, 'normal', { c1: 'resolve', c2: 'nao' }),
      refStage(2, 'impossivel tambem', { c1: 'nao', c2: 'nao', c3: 'nao' }),
    ]);
    // Fila de revisão HUMANA (ordem de entrada) — não é descarte.
    expect(report.reviewQueue.map((i) => i.question)).toEqual(['impossivel?', 'impossivel tambem']);
    expect(gabaritoReviewQueue(report)).toEqual(report.reviewQueue);
    // Criterio 4: NENHUM item some do relatório por ser "impossível"/saturado —
    // inclusive os 100% 'nao' continuam presentes como item da run.
    expect(report.items.map((i) => i.question)).toEqual(['impossivel?', 'normal', 'impossivel tambem']);
  });

  it('o relatório não tem nenhum caminho de descarte de item', () => {
    const report = itemSaturationReport([
      refStage(0, 'impossivel?', { c1: 'nao', c2: 'nao', c3: 'nao' }),
    ]);
    // Semântica do contrato: o item saturado VIRA fila de revisão, nunca some.
    expect(report.items).toHaveLength(1);
    expect(report.reviewQueue).toHaveLength(1);
    expect(report.reviewQueue[0]).toBe(report.items[0]);
  });
});

describe('guarda de IRT — < 30 contestants é erro específico (criterio 3)', () => {
  it('lança IrtSampleSizeError citando a limitação abaixo do piso', () => {
    expect(() => assertIrtSampleSize(29)).toThrow(IrtSampleSizeError);
    try {
      assertIrtSampleSize(5);
      expect.unreachable('devia ter lançado IrtSampleSizeError');
    } catch (err) {
      const e = err as IrtSampleSizeError;
      expect(e).toBeInstanceOf(IrtSampleSizeError);
      expect(e.code).toBe('irt.sample_too_small');
      expect(e.contestantCount).toBe(5);
      expect(e.minimum).toBe(IRT_MIN_CONTESTANTS);
      // O erro cita a limitação (N insuficiente) e a fonte da evidência.
      expect(e.message).toContain('30');
      expect(e.message).toMatch(/arXiv 2607\.15190/);
      expect(e.message).toMatch(/nao sao\s+recuperaveis/i);
    }
  });

  it('passa no piso (>= 30) e o piso default é 30', () => {
    expect(IRT_MIN_CONTESTANTS).toBe(30);
    expect(() => assertIrtSampleSize(30)).not.toThrow();
    expect(() => assertIrtSampleSize(100)).not.toThrow();
    expect(() => assertIrtSampleSize(Number.NaN)).toThrow(IrtSampleSizeError);
  });
});
