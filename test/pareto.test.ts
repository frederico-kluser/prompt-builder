// Testes de CONTRATO da seleção Pareto/população (F4.1, GEPA).

import { describe, expect, it } from 'vitest';
import {
  addToPool,
  dominates,
  paretoFront,
  pickParent,
  sliceScores,
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
