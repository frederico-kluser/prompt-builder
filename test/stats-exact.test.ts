// IMPL-001 (R-04:REC-1 / DEC-1) — teste pareado EXATO por troca de sinais no
// lugar do bootstrap percentil de `pairedSignificance`.
//
// Critérios de aceite provados aqui:
//   • sondas N2: "+0,5 em todos os 5" → p = 0,03125 unilateral e IC por
//     inversão contém 50 p.p.; "+0,5,+0,5,0,0,0" → p = 0,25;
//   • NENHUM p < 0,05 bilateral emitido com n′ < 6;
//   • p exato a ±1e-9 do valor teórico em 100% das sondas (fórmula fechada E
//     uma referência de força bruta independente, em aritmética INTEIRA);
//   • o shim web continua re-exportando o canônico de src/.
// Mais: IC por inversão = estatísticas de ordem das médias de subconjunto,
// dualidade IC × p, exclusão de pares ausentes, Monte Carlo semeado, e as
// métricas da R-04 (tipo I ≤ 5% + EM; cobertura do IC em [93%; 97%]).

import { describe, expect, it } from 'vitest';
import * as srcStats from '../src/stats.js';
import * as webStats from '../web/src/engine/stats';
import {
  exactSignTest,
  formatPValue,
  formatSignificance,
  MIN_PAIRS,
  MONTE_CARLO_B,
  mulberry32,
  pairDiffs,
  pairedSignificance,
  reportPValue,
  signFlipConfidenceInterval,
  signFlipTest,
} from '../src/stats.js';
import type { StoredSignificance } from '../src/types.js';

const TOL = 1e-9;

/** Monta (controle, campeão) na escala 0–1 que produz exatamente `diffs` (campeão − controle). */
function scoresFor(diffs: readonly number[]): { control: number[]; champion: number[] } {
  return {
    control: diffs.map((d) => (d < 0 ? -d : 0)),
    champion: diffs.map((d) => (d > 0 ? d : 0)),
  };
}

function sig(diffs: readonly number[]) {
  const { control, champion } = scoresFor(diffs);
  const res = pairedSignificance(control, champion);
  if (!res) throw new Error(`esperava resultado para n=${diffs.length}`);
  return res;
}

const binom = (n: number, k: number): number => {
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return Math.round(r);
};

// ---------------------------------------------------------------------------
// Referência de FORÇA BRUTA, independente da implementação: enumera os 2^n
// vetores de sinais sem agrupar nada, em aritmética INTEIRA (as diferenças são
// escaladas para inteiros — a escala do produto é k/2; repetições dão k/6), e o
// IC ordena as 2^n − 1 médias de subconjunto como racionais exatos.
// ---------------------------------------------------------------------------
const SCALE = 6;

function toInts(diffs: readonly number[]): number[] {
  return diffs.map((d) => {
    const v = Math.round(d * SCALE);
    if (Math.abs(v - d * SCALE) > 1e-9) throw new Error(`diff ${d} fora da grade 1/${SCALE}`);
    return v;
  });
}

function bruteForceP(diffs: readonly number[]): { greater: number; less: number; twoSided: number } {
  const ints = toInts(diffs);
  const n = ints.length;
  const tObs = ints.reduce((a, b) => a + b, 0);
  let ge = 0;
  let le = 0;
  let abs = 0;
  for (let mask = 0; mask < 1 << n; mask += 1) {
    let t = 0;
    for (let i = 0; i < n; i += 1) t += mask & (1 << i) ? -ints[i] : ints[i];
    if (t >= tObs) ge += 1;
    if (t <= tObs) le += 1;
    if (Math.abs(t) >= Math.abs(tObs)) abs += 1;
  }
  const total = 2 ** n;
  return { greater: ge / total, less: le / total, twoSided: abs / total };
}

/** IC por inversão, por definição: k-ésima menor e k-ésima maior média de subconjunto. */
function bruteForceCi(diffs: readonly number[], alpha = 0.05): { lower: number; upper: number } {
  const ints = toInts(diffs);
  const n = ints.length;
  const means: { num: number; den: number }[] = [];
  for (let mask = 1; mask < 1 << n; mask += 1) {
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i += 1) {
      if (mask & (1 << i)) {
        num += ints[i];
        den += 1;
      }
    }
    means.push({ num, den });
  }
  means.sort((a, b) => a.num * b.den - b.num * a.den); // comparação racional exata
  const k = Math.floor((alpha / 2) * 2 ** n);
  if (k === 0) return { lower: -Infinity, upper: Infinity };
  const lo = means[k - 1];
  const hi = means[means.length - k];
  return { lower: lo.num / lo.den / SCALE, upper: hi.num / hi.den / SCALE };
}

// ---------------------------------------------------------------------------
// Sondas N2 (docs/evidencias/sondas_gt_stats — o bootstrap dava p=0 com IC
// [50;50] em "+0,5 em todos" e p=0,008 onde o exato dá 0,125)
// ---------------------------------------------------------------------------
interface Sonda {
  nome: string;
  diffs: number[];
  /** Valores TEÓRICOS (fórmula fechada, conferida à mão). */
  pUni: number;
  pBi: number;
  meanPp: number;
}

const SONDAS_N2: Sonda[] = [
  // Todas as 5 diferenças são +0,5: só a identidade atinge T ≥ 2,5 → 1/32.
  { nome: '+0,5 em todos os 5', diffs: [0.5, 0.5, 0.5, 0.5, 0.5], pUni: 1 / 32, pBi: 2 / 32, meanPp: 50 },
  // n′ = 2: só a identidade dos dois não nulos atinge T ≥ 1 → 1/4.
  { nome: '+0,5,+0,5,0,0,0', diffs: [0.5, 0.5, 0, 0, 0], pUni: 0.25, pBi: 0.5, meanPp: 20 },
  // O bootstrap dava p=0,008 aqui; o exato é 2^−3.
  { nome: 'campeão melhor em 3 (+0,5)', diffs: [0.5, 0.5, 0.5, 0, 0], pUni: 0.125, pBi: 0.25, meanPp: 30 },
  { nome: '[0,0,0,1,1] × [1,1,1,1,1]', diffs: [1, 1, 1, 0, 0], pUni: 0.125, pBi: 0.25, meanPp: 60 },
  { nome: '1 cenário melhor (nao→resolve)', diffs: [1, 0, 0, 0, 0], pUni: 0.5, pBi: 1, meanPp: 20 },
  // T = 0,5; T* ∈ {±1,5; ±0,5} equiprováveis → P(T* ≥ 0,5) = 1/2; |T*| ≥ 0,5 sempre.
  { nome: '1 melhor, 1 pior', diffs: [1, -0.5, 0, 0, 0], pUni: 0.5, pBi: 1, meanPp: 10 },
  // Magnitudes mistas: só a identidade soma 3 → 1/32.
  { nome: '+1 e quatro +0,5', diffs: [1, 0.5, 0.5, 0.5, 0.5], pUni: 1 / 32, pBi: 2 / 32, meanPp: 60 },
  // Quatro +1 e um −1: T* ≥ 3 ⇔ ≤ 1 sinal negativo → (1 + 5)/32.
  { nome: 'quatro +1, um −1', diffs: [1, 1, 1, 1, -1], pUni: 6 / 32, pBi: 12 / 32, meanPp: 60 },
  // Primeiro n′ em que o bilateral PODE cruzar 0,05: n′ = 6 → 2/64.
  { nome: '+1 em todos os 6', diffs: [1, 1, 1, 1, 1, 1], pUni: 1 / 64, pBi: 2 / 64, meanPp: 100 },
  // Espelho: campeão PIOR em tudo → unilateral ≈ 1 (1 − 2^−5 + 2^−5).
  { nome: '−0,5 em todos os 5', diffs: [-0.5, -0.5, -0.5, -0.5, -0.5], pUni: 1, pBi: 2 / 32, meanPp: -50 },
];

describe('IMPL-001 — sondas N2 com p exato', () => {
  it('"+0,5 em todos os 5" → p = 0,03125 unilateral e o IC por inversão contém 50 p.p.', () => {
    const r = sig([0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(Math.abs(r.pValue - 0.03125)).toBeLessThanOrEqual(TOL);
    expect(r.ci95Pp[0]).toBeLessThanOrEqual(50);
    expect(r.ci95Pp[1]).toBeGreaterThanOrEqual(50);
    // Com n = 5 o teste não tem resolução para rejeitar nada: IC honesto = a
    // escala inteira (o bootstrap dizia [50; 50], certeza que não existe).
    expect(r.ci95Pp).toEqual([-100, 100]);
    expect(r.method).toBe('exact');
    expect(r.nEfetivo).toBe(5);
    expect(r.nNonZero).toBe(5);
    expect(Math.abs(r.pMinUnilateral - 1 / 32)).toBeLessThanOrEqual(TOL);
    // O bilateral nem alcança 0,05 com n′ = 5.
    expect(r.pValueTwoSided).toBeGreaterThanOrEqual(0.05);
  });

  it('"+0,5,+0,5,0,0,0" → p = 0,25 (zeros ficam fora do n′)', () => {
    const r = sig([0.5, 0.5, 0, 0, 0]);
    expect(Math.abs(r.pValue - 0.25)).toBeLessThanOrEqual(TOL);
    expect(r.nNonZero).toBe(2);
    expect(r.nEfetivo).toBe(5);
    expect(Math.abs(r.pMinUnilateral - 0.25)).toBeLessThanOrEqual(TOL);
  });

  it('100% das sondas: p exato a ±1e-9 do teórico (uni, bilateral e teste do sinal) e da força bruta', () => {
    for (const s of SONDAS_N2) {
      const r = sig(s.diffs);
      const bf = bruteForceP(s.diffs);
      expect(Math.abs(r.pValue - s.pUni), s.nome).toBeLessThanOrEqual(TOL);
      expect(Math.abs(r.pValueTwoSided - s.pBi), s.nome).toBeLessThanOrEqual(TOL);
      expect(Math.abs(r.pValue - bf.greater), s.nome).toBeLessThanOrEqual(TOL);
      expect(Math.abs(r.pValueTwoSided - bf.twoSided), s.nome).toBeLessThanOrEqual(TOL);
      expect(r.meanDiffPp, s.nome).toBe(s.meanPp);
      expect(r.method, s.nome).toBe('exact');
      // Teste do sinal exato (sensibilidade): binomial(n′, 1/2) sobre os não nulos.
      const pos = s.diffs.filter((d) => d > 0).length;
      const m = s.diffs.filter((d) => d !== 0).length;
      let upper = 0;
      for (let j = pos; j <= m; j += 1) upper += binom(m, j) / 2 ** m;
      expect(Math.abs(r.signTest.pValue - upper), s.nome).toBeLessThanOrEqual(TOL);
      expect(r.signTest.positive + r.signTest.negative, s.nome).toBe(m);
    }
  });

  it('teste do sinal exato: valores de tabela (sensibilidade)', () => {
    expect(exactSignTest(5, 0).pValue).toBeCloseTo(1 / 32, 12);
    expect(exactSignTest(5, 0).pValueTwoSided).toBeCloseTo(1 / 16, 12);
    // 8 de 10: P(X ≥ 8) = (45 + 10 + 1)/1024.
    expect(exactSignTest(8, 2).pValue).toBeCloseTo(56 / 1024, 12);
    expect(exactSignTest(8, 2).pValueTwoSided).toBeCloseTo(112 / 1024, 12);
    // Metade/metade: bilateral satura em 1; sem não nulos, p = 1.
    expect(exactSignTest(3, 3).pValueTwoSided).toBe(1);
    expect(exactSignTest(0, 0)).toEqual({ positive: 0, negative: 0, pValue: 1, pValueTwoSided: 1 });
  });
});

describe('IMPL-001 — nenhum p < 0,05 bilateral com n′ < 6', () => {
  const STEPS = [-1, -0.5, 0, 0.5, 1];

  /** Todos os multisets de tamanho n sobre a grade ternária (o teste só depende do multiset). */
  function* multisets(n: number, from = 0): Generator<number[]> {
    if (n === 0) {
      yield [];
      return;
    }
    for (let i = from; i < STEPS.length; i += 1) {
      for (const rest of multisets(n - 1, i)) yield [STEPS[i], ...rest];
    }
  }

  it('exaustivo na escala do produto: n = 5..20, todo multiset com n′ ≤ 5', () => {
    let checked = 0;
    for (let n = MIN_PAIRS; n <= 20; n += 1) {
      for (const diffs of multisets(n)) {
        const nNonZero = diffs.filter((d) => d !== 0).length;
        if (nNonZero >= 6) continue;
        const r = sig(diffs);
        checked += 1;
        expect(r.pValueTwoSided, diffs.join(',')).toBeGreaterThanOrEqual(0.05);
        expect(r.signTest.pValueTwoSided, diffs.join(',')).toBeGreaterThanOrEqual(0.05);
        expect(r.pMinUnilateral).toBeGreaterThanOrEqual(1 / 32 - TOL);
        // Dualidade: sem significância bilateral, o IC95 contém 0.
        expect(r.ci95Pp[0], diffs.join(',')).toBeLessThanOrEqual(0);
        expect(r.ci95Pp[1], diffs.join(',')).toBeGreaterThanOrEqual(0);
      }
    }
    // Por n: Σ_{j=0..5} C(j+3, 3) = 126 multisets de não nulos (o resto é zero).
    expect(checked).toBe(16 * 126);
  });

  it('também com diferenças contínuas quaisquer (n′ ≤ 5, zeros à vontade)', () => {
    const rng = mulberry32(7);
    for (let t = 0; t < 500; t += 1) {
      const nNonZero = 1 + Math.floor(rng() * 5);
      const zeros = Math.floor(rng() * 8);
      const diffs = [
        ...Array.from({ length: nNonZero }, () => (rng() < 0.9 ? 1 : -1) * (0.01 + rng())),
        ...Array.from({ length: zeros }, () => 0),
      ];
      if (diffs.length < MIN_PAIRS) continue;
      const r = signFlipTest(diffs);
      expect(r.pTwoSided).toBeGreaterThanOrEqual(0.05);
      expect(r.pGreater).toBeGreaterThanOrEqual(2 ** -nNonZero - TOL);
    }
  });
});

describe('IMPL-001 — exatidão contra força bruta (sondas aleatórias)', () => {
  it('p unilateral, p bilateral e IC por inversão batem com a enumeração inteira (±1e-9)', () => {
    const rng = mulberry32(2026);
    for (let t = 0; t < 300; t += 1) {
      const n = 5 + Math.floor(rng() * 8); // 5..12
      // Grade de 1/6 (média de repetições) com massa em zero, como no produto.
      const diffs = Array.from({ length: n }, () =>
        rng() < 0.4 ? 0 : (Math.floor(rng() * 13) - 5) / 6,
      );
      const r = signFlipTest(diffs);
      const bf = bruteForceP(diffs);
      expect(r.method).toBe('exact');
      expect(Math.abs(r.pGreater - bf.greater)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(r.pLess - bf.less)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(r.pTwoSided - bf.twoSided)).toBeLessThanOrEqual(TOL);

      const ci = signFlipConfidenceInterval(diffs);
      const bci = bruteForceCi(diffs);
      expect(ci.method).toBe('exact');
      if (bci.lower === -Infinity) {
        expect(ci.lower).toBe(-Infinity);
        expect(ci.upper).toBe(Infinity);
      } else {
        expect(Math.abs(ci.lower - bci.lower)).toBeLessThanOrEqual(TOL);
        expect(Math.abs(ci.upper - bci.upper)).toBeLessThanOrEqual(TOL);
      }
    }
  });

  it('dualidade do IC por inversão: IC exclui 0 ⇔ p bilateral ≤ 0,05', () => {
    const rng = mulberry32(99);
    let rejeicoes = 0;
    for (let t = 0; t < 400; t += 1) {
      const n = 6 + Math.floor(rng() * 9); // 6..14
      const diffs = Array.from({ length: n }, () => [-1, -0.5, 0, 0.5, 1, 0.5, 1][Math.floor(rng() * 7)]);
      const ci = signFlipConfidenceInterval(diffs);
      const p = signFlipTest(diffs);
      const excluiZero = ci.lower > 0 || ci.upper < 0;
      expect(excluiZero).toBe(p.pTwoSided <= 0.05);
      // E o lado: limite inferior > 0 ⇔ p unilateral ≤ α/2.
      expect(ci.lower > 0).toBe(p.pGreater <= 0.025);
      if (excluiZero) rejeicoes += 1;
    }
    expect(rejeicoes).toBeGreaterThan(20); // a grade tem casos dos dois lados
  });

  it('golden: 6×(+0,5) e 4 zeros → p = 2^−6, IC [12,5; 50] = 25ª menor/maior média de subconjunto', () => {
    const r = sig([0.5, 0.5, 0, 0.5, 0, 0.5, 0.5, 0, 0, 0.5]);
    expect(r.pValue).toBe(1 / 64);
    expect(r.pValueTwoSided).toBe(1 / 32);
    expect(r.ci95Pp).toEqual([12.5, 50]);
  });
});

describe('IMPL-001 — pares com observação ausente saem dos DOIS lados', () => {
  it('null/undefined/NaN excluem o par; nunca viram 0', () => {
    const control = [0, 0, 0, 0, 0, null, 0, 0];
    const champion = [0.5, 0.5, 0.5, 0.5, 0.5, 1, undefined, Number.NaN];
    const r = pairedSignificance(control, champion);
    expect(r).not.toBeNull();
    expect(r?.n).toBe(8);
    expect(r?.nEfetivo).toBe(5);
    expect(r?.excludedPairs).toBe(3);
    expect(r?.completeness).toBe(0.625);
    // Mesmo resultado que só os 5 pares completos (imputar 0 mudaria o p e a média).
    const limpo = sig([0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(r?.pValue).toBe(limpo.pValue);
    expect(r?.meanDiffPp).toBe(limpo.meanDiffPp);
  });

  it('piso de 5 pares vale para o n EFETIVO', () => {
    expect(pairedSignificance([0, 0, 0, 0, null], [1, 1, 1, 1, 1])).toBeNull();
    expect(pairDiffs([0, 0, 0, 0, null], [1, 1, 1, 1, 1])).toEqual({ diffs: [1, 1, 1, 1], nominal: 5, excluded: 1 });
  });

  it('com pairKeys: chave do controle sem campeão conta como par excluído', () => {
    const res = pairDiffs([0, 0, 0], [1, 1], ['a', 'b', 'c']);
    expect(res).toEqual({ diffs: [1, 1], nominal: 3, excluded: 1 });
  });
});

describe('IMPL-001 — Monte Carlo semeado além do teto da enumeração', () => {
  // 21 valores contínuos distintos: 2^21 combinações > teto → B = 10.000 trocas semeadas.
  const rng = mulberry32(5);
  const diffs = Array.from({ length: 21 }, () => rng() - 0.35);

  it('determinístico, válido (p ≥ 1/(B+1)) e perto do exato', () => {
    const a = signFlipTest(diffs);
    const b = signFlipTest(diffs);
    expect(a.method).toBe('monte-carlo');
    expect(a).toEqual(b);
    expect(a.pGreater).toBeGreaterThanOrEqual(1 / (MONTE_CARLO_B + 1));
    expect(a.pMinUnilateral).toBeCloseTo(1 / (MONTE_CARLO_B + 1), 12);
    // Referência exata por enumeração direta (2^21 somas) na grade original.
    let ge = 0;
    let abs = 0;
    const tObs = diffs.reduce((s, x) => s + x, 0);
    for (let mask = 0; mask < 1 << diffs.length; mask += 1) {
      let t = 0;
      for (let i = 0; i < diffs.length; i += 1) t += mask & (1 << i) ? -diffs[i] : diffs[i];
      if (t >= tObs - 1e-9) ge += 1;
      if (Math.abs(t) >= Math.abs(tObs) - 1e-9) abs += 1;
    }
    const pEx = ge / 2 ** diffs.length;
    const pExBi = abs / 2 ** diffs.length;
    const em = (p: number) => 4 * Math.sqrt((p * (1 - p)) / MONTE_CARLO_B) + 2 / MONTE_CARLO_B;
    expect(Math.abs(a.pGreater - pEx)).toBeLessThanOrEqual(em(pEx));
    expect(Math.abs(a.pTwoSided - pExBi)).toBeLessThanOrEqual(em(pExBi));
  });

  it('B e seed são respeitados; IC Monte Carlo contém a média observada', () => {
    const b999 = signFlipTest(diffs, { iterations: 999, seed: 1 });
    expect(b999.pMinUnilateral).toBeCloseTo(1 / 1000, 12);
    expect(b999).toEqual(signFlipTest(diffs, { iterations: 999, seed: 1 }));
    const mean = diffs.reduce((s, x) => s + x, 0) / diffs.length;
    const ci = signFlipConfidenceInterval(diffs);
    expect(ci.method).toBe('monte-carlo');
    expect(ci.lower).toBeLessThan(mean);
    expect(ci.upper).toBeGreaterThan(mean);
    const r = pairedSignificance(diffs.map(() => 0.5), diffs.map((d) => 0.5 + d / 2));
    expect(r?.method).toBe('monte-carlo');
    expect(r).toEqual(pairedSignificance(diffs.map(() => 0.5), diffs.map((d) => 0.5 + d / 2)));
  });
});

describe('IMPL-001 — métricas da R-04 (tipo I e cobertura)', () => {
  // Nula SIMÉTRICA com empates, na escala do produto (|d| ∈ {0,5; 1} e zeros).
  function drawSym(rng: () => number, pZero: number): number {
    if (rng() < pZero) return 0;
    const mag = rng() < 0.5 ? 0.5 : 1;
    return rng() < 0.5 ? mag : -mag;
  }

  it('tipo I do p unilateral ≤ 5% + EM (0,7 p.p. com 4.000 ensaios) em toda a grade', () => {
    const rng = mulberry32(42);
    const TRIALS = 4000;
    const em = 1.96 * Math.sqrt((0.05 * 0.95) / TRIALS);
    for (const n of [5, 8, 10, 20]) {
      for (const pZero of [0.5, 0.7, 0.9]) {
        let rej = 0;
        let rejBi = 0;
        for (let t = 0; t < TRIALS; t += 1) {
          const r = signFlipTest(Array.from({ length: n }, () => drawSym(rng, pZero)));
          if (r.pGreater <= 0.05) rej += 1;
          if (r.pTwoSided <= 0.05) rejBi += 1;
        }
        expect(rej / TRIALS, `n=${n} zeros=${pZero}`).toBeLessThanOrEqual(0.05 + em);
        expect(rejBi / TRIALS, `n=${n} zeros=${pZero}`).toBeLessThanOrEqual(0.05 + em);
      }
    }
  });

  it('cobertura do IC95% por inversão ∈ [93%; 97%] com diferenças contínuas (n = 10)', () => {
    const rng = mulberry32(11);
    const TRIALS = 1000;
    const delta = 0.2;
    let cobre = 0;
    for (let t = 0; t < TRIALS; t += 1) {
      const d = Array.from({ length: 10 }, () => delta + (rng() - 0.5));
      const ci = signFlipConfidenceInterval(d);
      if (ci.lower <= delta && delta <= ci.upper) cobre += 1;
    }
    // Teórico: 1 − 2·⌊0,025·1024⌋/1024 = 95,1%.
    expect(cobre / TRIALS).toBeGreaterThanOrEqual(0.93);
    expect(cobre / TRIALS).toBeLessThanOrEqual(0.97);
  });

  it('com empates (escala ternária) o IC é CONSERVADOR: cobertura ≥ 95% − EM, nunca sub-cobre', () => {
    const rng = mulberry32(12);
    const TRIALS = 1000;
    for (const n of [8, 10, 20]) {
      let cobre = 0;
      for (let t = 0; t < TRIALS; t += 1) {
        const ci = signFlipConfidenceInterval(Array.from({ length: n }, () => drawSym(rng, 0.5)));
        if (ci.lower <= 0 && 0 <= ci.upper) cobre += 1;
      }
      expect(cobre / TRIALS, `n=${n}`).toBeGreaterThanOrEqual(0.93);
    }
  });
});

describe('IMPL-001 — relatório e compatibilidade', () => {
  it('relatório usa o p BILATERAL; o unilateral fica rotulado como o do gate', () => {
    const r = sig([0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(reportPValue(r)).toEqual({ p: 0.0625, kind: 'two-sided' });
    // IMPL-050: toda saída de significância traz a ORIGEM do p — sem rótulo
    // gravado, a origem desconhecida é tratada como SELEÇÃO (o caso anti-conservador).
    expect(formatSignificance(r)).toBe(
      'p=0.063 bilateral (gate unilateral p=0.031) · IC95 [-100.0, 100.0]pp · n=5 · exato · origem do p: seleção (anti-conservador)',
    );
    expect(formatPValue(0.0004)).toBe('p<0.001');
  });

  it('exclusões aparecem no relatório', () => {
    const r = pairedSignificance([0, 0, 0, 0, 0, null], [1, 1, 1, 1, 1, 1]);
    expect(r && formatSignificance(r)).toContain('n=5 de 6 (1 sem observação)');
  });

  it('sessão gravada antes do IMPL-001 (só os 4 campos do bootstrap) continua legível', () => {
    const legado: StoredSignificance = { n: 5, meanDiffPp: 50, ci95Pp: [50, 50], pValue: 0 };
    expect(reportPValue(legado)).toEqual({ p: 0, kind: 'legacy' });
    // IMPL-050: o bootstrap legado NÃO é p-valor → a origem sai como "sem p".
    expect(formatSignificance(legado)).toBe(
      'p<0.001 (bootstrap, legado) · IC95 [50.0, 50.0]pp · n=5 · origem do p: sem p',
    );
  });

  it('assinatura mantida: n, meanDiffPp, ci95Pp, pValue + campos novos', () => {
    const r = sig([1, 0.5, 0, 0.5, 1, 0.5, -0.5, 1]);
    for (const k of [
      'n', 'meanDiffPp', 'ci95Pp', 'pValue', 'pValueTwoSided', 'nEfetivo', 'nNonZero',
      'pMinUnilateral', 'excludedPairs', 'completeness', 'method', 'ciMethod', 'signTest',
    ]) {
      expect(r, k).toHaveProperty(k);
    }
    expect(r.ci95Pp[0]).toBeLessThanOrEqual(r.meanDiffPp);
    expect(r.ci95Pp[1]).toBeGreaterThanOrEqual(r.meanDiffPp);
  });

  it('o shim web continua re-exportando o canônico de src/ (mesmas funções, mesma identidade)', () => {
    expect(Object.keys(webStats).sort()).toEqual(Object.keys(srcStats).sort());
    expect(webStats.pairedSignificance).toBe(srcStats.pairedSignificance);
    expect(webStats.signFlipTest).toBe(srcStats.signFlipTest);
    expect(webStats.signFlipConfidenceInterval).toBe(srcStats.signFlipConfidenceInterval);
    expect(webStats.exactSignTest).toBe(srcStats.exactSignTest);
    expect(webStats.formatSignificance).toBe(srcStats.formatSignificance);
  });
});
