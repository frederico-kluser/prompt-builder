// Testes de CONTRATO da seleção Pareto/população (F4.1, GEPA).

import { describe, expect, it } from 'vitest';
import {
  addToPool,
  coverageWins,
  dominates,
  paretoDiagnostics,
  paretoFront,
  pickParent,
  pickParentByCoverage,
  sliceScores,
  PARETO_MIN_N,
  PARETO_NOISE_FRACTION,
  type ParetoEntry,
} from '../src/engine/pareto.js';

const e = (id: string, bySlice: Record<string, number>): ParetoEntry => ({ id, bySlice });

describe('pareto.ts — dominância e front', () => {
  it('domina: ≥ em todas as fatias e > em ao menos uma', () => {
    expect(dominates({ a: 80, b: 60 }, { a: 70, b: 50 })).toBe(true);
    expect(dominates({ a: 80, b: 40 }, { a: 70, b: 50 })).toBe(false); // pior em b
    expect(dominates({ a: 80 }, { a: 80 })).toBe(false); // igual não domina
  });

  it('fatia ausente conta como 0 (quem não tem evidência não pontua)', () => {
    expect(dominates({ a: 10, b: 5 }, { a: 10 })).toBe(true);
  });

  it('paretoFront: especialistas coexistem (diversidade > topo único)', () => {
    const front = paretoFront([
      e('bom-geral', { mft: 80, adversarial: 60 }),
      e('especialista-mft', { mft: 95, adversarial: 30 }),
      e('especialista-adv', { mft: 50, adversarial: 90 }),
      e('dominado', { mft: 40, adversarial: 20 }),
    ]);
    const ids = front.map((x) => x.id);
    expect(ids).toContain('bom-geral');
    expect(ids).toContain('especialista-mft');
    expect(ids).toContain('especialista-adv');
    expect(ids).not.toContain('dominado'); // pior em tudo
  });
});

describe('pareto.ts — pool', () => {
  it('candidata dominada não entra; entrada atualiza scores por id', () => {
    let pool = addToPool([], e('a', { mft: 80 }), { maxSize: 3 });
    pool = addToPool(pool, e('b', { mft: 70 }), { maxSize: 3 });
    pool = addToPool(pool, e('b', { mft: 95 }), { maxSize: 3 }); // atualiza
    expect(pool.find((x) => x.id === 'b')?.bySlice.mft).toBe(95);
  });

  it('estourando o tamanho, sai a dominada de menor média (diversidade preservada)', () => {
    let pool = addToPool([], e('topo', { mft: 90 }), { maxSize: 2 });
    pool = addToPool(pool, e('especialista', { mft: 20, adv: 95 }), { maxSize: 2 });
    // Uma variante medíocre em tudo: dominada pelos dois → não entra.
    pool = addToPool(pool, e('mediocre', { mft: 50, adv: 50 }), { maxSize: 2 });
    expect(pool.map((x) => x.id).sort()).toEqual(['especialista', 'topo']);
  });

  it('sem dominada, a de menor média sai — o pool nunca excede maxSize', () => {
    // Três especialistas INCOMPARÁVEIS (nenhum domina outro): a de menor média
    // é que sai ao estourar o tamanho.
    let pool = addToPool([], e('a', { mft: 90, adv: 20 }), { maxSize: 2 }); // média 55
    pool = addToPool(pool, e('b', { mft: 20, adv: 70 }), { maxSize: 2 }); // média 45
    pool = addToPool(pool, e('c', { mft: 60, adv: 60 }), { maxSize: 2 }); // média 60
    expect(pool).toHaveLength(2);
    expect(pool.map((x) => x.id)).not.toContain('b'); // menor média
  });

  it('maxSize 1 = elitismo clássico (comportamento atual preservado)', () => {
    let pool = addToPool([], e('a', { mft: 70 }), { maxSize: 1 });
    pool = addToPool(pool, e('b', { mft: 90 }), { maxSize: 1 });
    expect(pool.map((x) => x.id)).toEqual(['b']);
  });
});

describe('pareto.ts — escolha de pai (rodízio)', () => {
  it('o menos usado vence (pais diversos), empate vai para a maior média', () => {
    const pool = [e('a', { mft: 90 }), e('b', { mft: 80 })];
    expect(pickParent(pool, { a: 2, b: 0 })?.id).toBe('b');
    expect(pickParent(pool, { a: 1, b: 1 })?.id).toBe('a'); // empate → maior média
    expect(pickParent([], {})).toBeUndefined();
  });
});

describe('pareto.ts — sliceScores', () => {
  it('média por fatia × 100 (escala do judge-score), sem observações = sem entrada', () => {
    const s = sliceScores([
      { slice: 'mft', score: 1 },
      { slice: 'mft', score: 0.5 },
      { slice: 'adv', score: 0 },
    ]);
    expect(s.mft).toBe(75);
    expect(s.adv).toBe(0);
    expect(sliceScores([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// IMPL-062 (R-02b:REC-4) — amostragem de pai ∝ COBERTURA + diagnóstico do front.
// ---------------------------------------------------------------------------

/** LCG determinístico (Numerical Recipes) — os testes de distribuição são fixos. */
const lcg = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
};

/**
 * Matriz sintética 3 candidatos × 25 cenários (critério 2): vitórias DISJUNTAS
 * A=15, B=7, C=3 (25 cenários — acima do piso n ≥ 20 para a amostragem ∝ cobertura).
 */
const MATRIZ_3x25: Record<string, readonly (number | null | undefined)[]> = {
  A: [...Array(15).fill(1), ...Array(7).fill(0), ...Array(3).fill(0)],
  B: [...Array(15).fill(0.5), ...Array(7).fill(1), ...Array(3).fill(0)],
  C: [...Array(15).fill(0), ...Array(7).fill(0.5), ...Array(3).fill(1)],
};

describe('IMPL-062 — cobertura (quantas instâncias o candidato vence)', () => {
  it('vitória por instância: A=15, B=7, C=3 na matriz 3×25', () => {
    expect(coverageWins(MATRIZ_3x25)).toEqual({ A: 15, B: 7, C: 3 });
  });

  it('empate no topo conta como vitória para TODOS os empatados', () => {
    const wins = coverageWins({ A: [1, 0], B: [1, 0.5] });
    // cenário 0: ambos no topo ⇒ vitória para os DOIS; cenário 1: só B.
    expect(wins).toEqual({ A: 1, B: 2 });
  });

  it('null/undefined = sem observação: NUNCA pontua', () => {
    const wins = coverageWins({ A: [null, 1, undefined], B: [1, null, 1] });
    // cenário 0: só B tem valor; cenário 1: só A; cenário 2: só B.
    expect(wins).toEqual({ A: 1, B: 2 });
  });
});

describe('IMPL-062 — amostragem de pai ∝ cobertura (feature-flag, n ≥ 20)', () => {
  it('matriz 3×25: 1.000 amostras reproduzem ∝ cobertura (qui-quadrado < 5.99 ⇒ p > 0,05)', () => {
    const pool = [e('A', {}), e('B', {}), e('C', {})];
    const wins = coverageWins(MATRIZ_3x25);
    const total = 25;
    const N = 1000;
    // Várias seeds: a régua estatística vale para QUALQUER sequência do rng.
    for (const seed of [42, 7, 2026]) {
      const rng = lcg(seed);
      const cont: Record<string, number> = { A: 0, B: 0, C: 0 };
      for (let i = 0; i < N; i++) {
        const pai = pickParentByCoverage(pool, wins, rng);
        expect(pai).toBeDefined();
        cont[pai!.id] += 1;
      }
      // Qui-quadrado de aderência (gl = 2): esperado ∝ cobertura (600/280/120).
      let qui2 = 0;
      for (const id of ['A', 'B', 'C']) {
        const esperado = (N * wins[id]) / total;
        const obs = cont[id];
        qui2 += ((obs - esperado) ** 2) / esperado;
        // Frequência observada colada na proporção esperada (± 5 p.p.).
        expect(Math.abs(obs / N - wins[id] / total), `seed ${seed}, ${id}`).toBeLessThan(0.05);
      }
      // χ² < 5.991 (gl 2, α = 0,05) ⇒ não se rejeita a distribuição ∝ cobertura.
      expect(qui2, `seed ${seed}: qui-quadrado ${qui2.toFixed(2)}`).toBeLessThan(5.991);
    }
  });

  it('sem vitória registrada ninguém tem peso: amostragem uniforme, o pai nunca some', () => {
    const pool = [e('A', {}), e('B', {}), e('C', {})];
    const rng = lcg(99);
    const cont: Record<string, number> = { A: 0, B: 0, C: 0 };
    for (let i = 0; i < 3000; i++) cont[pickParentByCoverage(pool, {}, rng)!.id] += 1;
    for (const id of ['A', 'B', 'C']) {
      expect(cont[id], `${id} nunca some`).toBeGreaterThan(0);
      expect(Math.abs(cont[id] / 3000 - 1 / 3)).toBeLessThan(0.05);
    }
    expect(pickParentByCoverage([], {}, rng)).toBeUndefined();
  });
});

describe('IMPL-062 — diagnóstico do front (métricas + alerta de RUÍDO)', () => {
  it('reporta tamanho do front e fração de pares (a,b) não dominados', () => {
    // 3 entradas: topo domina as outras 2 → pares (topo,a) e (topo,b) dominados,
    // par (a,b) incomparável ⇒ fração 1/3.
    const entradas = [e('topo', { mft: 90, adv: 90 }), e('a', { mft: 40, adv: 10 }), e('b', { mft: 10, adv: 40 })];
    const d = paretoDiagnostics(entradas, 30);
    expect(d.n).toBe(30);
    expect(d.frontSize).toBe(1);
    expect(d.nonDominatedPairFraction).toBeCloseTo(1 / 3, 3);
    expect(d.noiseAlert).toBe(false);
  });

  it('alerta de RUÍDO: fração de pares não dominados > 60% com n < 20', () => {
    // Réguas do motor: piso n = 20 e limiar de fração 0,6.
    expect(PARETO_MIN_N).toBe(20);
    expect(PARETO_NOISE_FRACTION).toBe(0.6);
    // Dois especialistas INCOMPARÁVEIS: o único par não é dominado ⇒ fração 1,0.
    const especialistas = [e('mft', { mft: 95, adv: 20 }), e('adv', { mft: 20, adv: 95 })];
    const ruidoso = paretoDiagnostics(especialistas, 8);
    expect(ruidoso.nonDominatedPairFraction).toBe(1);
    expect(ruidoso.noiseAlert).toBe(true); // n = 8 < 20: front = ruído
    const robusto = paretoDiagnostics(especialistas, 25);
    expect(robusto.noiseAlert).toBe(false); // n ≥ 20: ablação do GEPA foi com 111–300
    // Fração ≤ 60% nunca alerta, mesmo com n pequeno.
    const dominado = paretoDiagnostics(
      [e('topo', { mft: 90, adv: 90 }), e('a', { mft: 40, adv: 10 }), e('b', { mft: 10, adv: 40 })],
      8,
    );
    expect(dominado.noiseAlert).toBe(false);
  });
});
