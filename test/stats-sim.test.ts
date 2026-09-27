// IMPL-002 (R-04:REC-3) — versão REDUZIDA e rápida do harness `npm run stats:sim`.
//
// Mesmo núcleo (`scripts/stats-sim-core.ts`, que chama o `pickWinner` REAL com
// `scoresById`), poucas células e poucos ensaios: prova que o harness roda,
// que é determinístico por seed de célula, e que o gate novo segura a promoção
// falsa onde o antigo (Δ ≥ 1 p.p., sem teste) promovia ruído. A grade completa
// (n 5–50 × K 1–8, 20.000 ensaios/célula) roda com `npm run stats:sim`.

import { describe, expect, it } from 'vitest';
import {
  acceptanceGrid,
  cellSeed,
  MAX_ABS_BIAS_PP,
  MAX_FALSE_PROMOTION,
  simulateCell,
} from '../scripts/stats-sim-core.js';

describe('stats:sim reduzido — promoção falsa sob H0', () => {
  const cells = [
    { n: 5, K: 8, flip: 0.3 },
    { n: 8, K: 8, flip: 0.3 },
    { n: 8, K: 4, flip: 0.15 },
    { n: 12, K: 4, flip: 0.15 },
    { n: 10, K: 1, flip: 0.3 },
  ];
  for (const c of cells) {
    it(`n=${c.n} K=${c.K} flip=${c.flip}: ≤ 5,5% (o gate antigo promovia muito mais)`, () => {
      const r = simulateCell({ ...c, mode: 'h0', trials: 1500 });
      expect(r.promotionRate).toBeLessThanOrEqual(MAX_FALSE_PROMOTION);
      // Linha de base N1: o gate antigo promove ruído em 25–86% das iterações.
      expect(r.legacyPromotionRate).toBeGreaterThan(0.25);
    });
  }
});

describe('stats:sim reduzido — viés do ganho exibido sob H1 (+10 p.p.)', () => {
  it('n=12 K=4: o bruto é inflado pela seleção; o corrigido fica a ≤ 1 p.p.', () => {
    const r = simulateCell({ n: 12, K: 4, flip: 0.15, mode: 'h1', trials: 1200 });
    expect(r.biasRawPp).toBeGreaterThan(4);
    expect(Math.abs(r.biasCorrectedPp)).toBeLessThanOrEqual(MAX_ABS_BIAS_PP);
  });

  it('K=1: nada a corrigir (corrigido = bruto)', () => {
    const r = simulateCell({ n: 8, K: 1, flip: 0.15, mode: 'h1', trials: 800 });
    expect(r.biasCorrectedPp).toBe(r.biasRawPp);
  });
});

describe('stats:sim — reprodutibilidade e grade', () => {
  it('a célula é determinística (seed derivada de modo/n/K/flip)', () => {
    const a = simulateCell({ n: 8, K: 3, flip: 0.3, mode: 'h0', trials: 300 });
    const b = simulateCell({ n: 8, K: 3, flip: 0.3, mode: 'h0', trials: 300 });
    expect({ ...a, ms: 0 }).toEqual({ ...b, ms: 0 });
    expect(a.seed).toBe(cellSeed({ n: 8, K: 3, flip: 0.3, mode: 'h0' }));
    expect(cellSeed({ n: 8, K: 3, flip: 0.3, mode: 'h1' })).not.toBe(a.seed);
  });

  it('a grade de aceite cobre n 5–50 × K 1–8 × flip {0,15; 0,30} × {H0, H1}', () => {
    const grid = acceptanceGrid(20_000);
    expect(grid).toHaveLength(9 * 8 * 2 * 2);
    expect(new Set(grid.map((c) => c.n))).toEqual(new Set([5, 8, 10, 12, 15, 20, 30, 40, 50]));
    expect(new Set(grid.map((c) => c.K))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(grid.every((c) => c.trials === 20_000)).toBe(true);
  });
});
