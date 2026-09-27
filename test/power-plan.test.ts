// IMPL-050 (R-04:REC-5) — guardas de poder: estimate com Δ detectável, n para
// um Δ alvo, σd de run-piloto pelo limite superior do IC (marcado como não
// calibrado quando vem de tabela) e ORIGEM DO P rotulada em todo relatório de
// significância (holdout | seleção | sem p).

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIGMA_D,
  deltaDetectavelPp,
  formatPowerPlan,
  formatSignificance,
  formatSignificanceOrigin,
  invNormalCdf,
  nParaDeltaPp,
  pairedSignificance,
  planPower,
  POWER_TARGET,
  POWER_UNCALIBRATED,
  significanceOrigin,
  sigmaFromPilot,
  studentTCritical,
  chi2Quantile,
} from '../src/stats.js';

describe('IMPL-050 — estimate publica poder e Δ detectável', () => {
  it('defaults (n=5, σd=0,5): Δ detectável ≥ 45 p.p. (≈55,6 ± 1 p.p.)', () => {
    const plan = planPower({ n: 5 });
    expect(plan.n).toBe(5);
    expect(plan.deltaDetectavelPp).toBeGreaterThanOrEqual(45);
    expect(Math.abs(plan.deltaDetectavelPp - 55.6)).toBeLessThanOrEqual(1);
    expect(plan.power).toBe(POWER_TARGET);
    expect(plan.alpha).toBe(0.05);
  });

  it('n para Δ=20 p.p. com 80% de poder (tolerância 1 p.p. no Δ)', () => {
    const plan = planPower({ n: 5 });
    // ⌈((z_{0,95}+z_{0,8})·σd/Δ)²⌉ = ⌈(2,4865·0,5/0,2)²⌉ = 39.
    expect(plan.nParaDelta).toBe(39);
    expect(plan.targetDeltaPp).toBe(20);
    expect(nParaDeltaPp(20, DEFAULT_SIGMA_D)).toBe(39);
    // A tolerância de 1 p.p. no Δ: ±1 p.p. no alvo move o n, nunca some.
    expect(nParaDeltaPp(21, DEFAULT_SIGMA_D)).toBeGreaterThanOrEqual(30);
    expect(nParaDeltaPp(19, DEFAULT_SIGMA_D)).toBeGreaterThanOrEqual(plan.nParaDelta);
  });

  it('σd de run-piloto: limite SUPERIOR do IC (conservador), nunca a tabela', () => {
    // Piloto com IC95% [−18; +22] p.p. em n=5 → s ≈ 0,228 e limite superior ≈ 0,54.
    const sigma = sigmaFromPilot([-18, 22], 5);
    expect(sigma).toBeGreaterThan(0.228); // acima do ponto estimado
    expect(Math.abs(sigma - 0.54)).toBeLessThanOrEqual(0.02);
    const plan = planPower({ n: 20, pilotCi95Pp: [-18, 22], pilotN: 5 });
    expect(plan.sigmaSource).toBe('pilot');
    expect(plan.uncalibrated).toBe(false);
    // Com σd MAIOR o Δ detectável sobe (mais ruído ⇒ menos poder).
    expect(plan.deltaDetectavelPp).toBeGreaterThan(planPower({ n: 20 }).deltaDetectavelPp);
  });

  it('sem piloto: fallback marcado como estimativa NÃO calibrada', () => {
    const plan = planPower({ n: 5 });
    expect(plan.sigmaSource).toBe('fallback');
    expect(plan.uncalibrated).toBe(true);
    const linhas = formatPowerPlan(plan).join('\n');
    expect(linhas).toContain(POWER_UNCALIBRATED);
    expect(linhas).toMatch(/Δ detectável ≥ [\d,]+ p\.p\./);
    expect(linhas).toMatch(/n para Δ=20 p\.p\.: 39 cenários/);
  });

  it('toda probabilidade do relatório de poder traz dígito (sem rótulo verbal)', () => {
    const texto = formatPowerPlan(planPower({ n: 12 })).join('\n');
    expect(texto).toMatch(/\d/);
    for (const proibido of ['provável', 'significativo', 'robusta', 'forte']) {
      expect(texto.toLowerCase()).not.toContain(proibido);
    }
  });
});

describe('IMPL-050 — núcleo numérico do planejamento', () => {
  it('studentTCritical bate com os valores tabelados (t de Student, prob. central)', () => {
    expect(studentTCritical(0.9, 4)).toBeCloseTo(2.132, 2); // P(|T|≤t)=0,90, 4 gl
    expect(studentTCritical(0.95, 4)).toBeCloseTo(2.776, 2); // P(|T|≤t)=0,95, 4 gl
    expect(studentTCritical(0.95, 10)).toBeCloseTo(2.228, 2);
    expect(studentTCritical(0.95, 30)).toBeCloseTo(2.042, 2);
  });

  it('chi2Quantile bate com os valores tabelados (χ²)', () => {
    expect(chi2Quantile(0.05, 4)).toBeCloseTo(0.7107, 2);
    expect(chi2Quantile(0.5, 4)).toBeCloseTo(3.357, 2);
  });

  it('deltaDetectavelPp cresce com σd e cai com n', () => {
    expect(deltaDetectavelPp(5, 0.5)).toBeGreaterThan(deltaDetectavelPp(20, 0.5));
    expect(deltaDetectavelPp(5, 0.8)).toBeGreaterThan(deltaDetectavelPp(5, 0.5));
    expect(invNormalCdf(0.95)).toBeCloseTo(1.6449, 3);
  });
});

describe('IMPL-050 — origem do p (holdout | seleção | sem p) em TODO relatório', () => {
  const diffs = [0.5, 0.5, 0.5, 0.5, 0.5, -0.5];

  it('p do holdout vem rotulado como confirmatório (α=0,05 unilateral)', () => {
    const sig = pairedSignificance(diffs.map(() => 0), diffs, { pOrigin: 'holdout' });
    expect(sig).not.toBeNull();
    expect(significanceOrigin(sig!)).toBe('holdout');
    const linha = formatSignificance(sig!);
    expect(linha).toContain('origem do p: holdout');
    expect(linha).toContain('α=0,05 unilateral');
  });

  it('p da SELEÇÃO vem rotulado como anti-conservador (R-04 DEC-7)', () => {
    const sig = pairedSignificance(diffs.map(() => 0), diffs, { pOrigin: 'selecao' });
    expect(significanceOrigin(sig!)).toBe('selecao');
    expect(formatSignificance(sig!)).toContain('origem do p: seleção (anti-conservador)');
  });

  it('sem p (null) também reporta a origem', () => {
    expect(formatSignificanceOrigin(null)).toContain('origem do p: sem p');
  });

  it('legado sem rótulo: bootstrap antigo NÃO é p-valor → "sem p"; o resto é tratado como seleção', () => {
    const legado = { n: 5, meanDiffPp: 50, ci95Pp: [50, 50] as [number, number], pValue: 0 };
    expect(significanceOrigin(legado)).toBe('sem p');
    expect(formatSignificance(legado)).toContain('origem do p: sem p');
    const semRotulo = {
      n: 6,
      meanDiffPp: 50,
      ci95Pp: [10, 90] as [number, number],
      pValue: 0.01,
      pValueTwoSided: 0.02,
      nEfetivo: 6,
    };
    expect(significanceOrigin(semRotulo)).toBe('selecao');
    expect(formatSignificance(semRotulo)).toContain('origem do p: seleção');
  });
});
