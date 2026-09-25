// Testes de CONTRATO do sequential halving (F4.3, §8.5).

import { describe, expect, it } from 'vitest';
import { planHalving, survivorsOf, type HalvingEntry } from '../src/engine/halving.js';

const variantes = ['ctl', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'];
const cenarios = Array.from({ length: 20 }, (_, i) => `c${i + 1}`);
const e = (id: string, score: number): HalvingEntry => ({ id, score });

describe('halving.ts — plano do torneio', () => {
  it('3 rodadas: keepCount corta pela metade e os cenários crescem até todos', () => {
    const plano = planHalving(variantes, cenarios, 42, { protectedIds: ['ctl'] });
    expect(plano.rounds).toHaveLength(3);
    expect(plano.rounds.map((r) => r.keepCount)).toEqual([8, 4, 2]);
    // Cenários crescendo, nunca decrescente, último cobre tudo.
    const contagens = plano.rounds.map((r) => r.scenarioIds.length);
    expect(contagens[0]).toBeLessThan(contagens[1]);
    expect(contagens[1]).toBeLessThan(contagens[2]);
    expect(contagens[2]).toBe(cenarios.length);
    // Primeira rodada ≈ 30% (6 de 20).
    expect(contagens[0]).toBe(6);
    // Cada rodada é PREFIXO da mesma ordem semeada (comparável entre si).
    for (let r = 1; r < plano.rounds.length; r++) {
      const prev = plano.rounds[r - 1].scenarioIds;
      expect(plano.rounds[r].scenarioIds.slice(0, prev.length)).toEqual(prev);
    }
    // União da última rodada = todos os cenários.
    expect([...plano.rounds[2].scenarioIds].sort()).toEqual([...cenarios].sort());
  });

  it('determinístico: mesma seed ⇒ mesmo plano; seeds diferentes ⇒ planos diferentes', () => {
    const a = planHalving(variantes, cenarios, 7);
    const b = planHalving(variantes, cenarios, 7);
    expect(a).toEqual(b);
    const c = planHalving(variantes, cenarios, 8);
    expect(a.rounds[0].scenarioIds).not.toEqual(c.rounds[0].scenarioIds);
  });

  it('keepCount nunca < 2 nem > nº de variantes; variantes < 3 ⇒ plano trivial', () => {
    const plano = planHalving(['a', 'b'], cenarios, 1);
    expect(plano.rounds.every((r) => r.keepCount >= 2)).toBe(true);
    expect(plano.rounds.every((r) => r.keepCount <= 2)).toBe(true);
  });
});

describe('halving.ts — sobreviventes', () => {
  it('os melhores por score sobrevivem; os piores são eliminados', () => {
    const { survivors, eliminated } = survivorsOf(
      [e('a', 90), e('b', 80), e('c', 30), e('d', 20)],
      2,
      { seed: 1 },
    );
    expect(survivors.sort()).toEqual(['a', 'b']);
    expect(eliminated.sort()).toEqual(['c', 'd']);
  });

  it('o controle protegido NUNCA é eliminado, mesmo com o pior score', () => {
    const { survivors, eliminated } = survivorsOf(
      [e('ctl', 0), e('a', 90), e('b', 80), e('c', 70)],
      2,
      { seed: 1, protectedIds: ['ctl'] },
    );
    expect(survivors).toContain('ctl');
    expect(eliminated).not.toContain('ctl');
  });

  it('empate de score decidido pelo shuffle semeado, não pela ordem da entrada', () => {
    const entradas = [e('a', 50), e('b', 50), e('c', 50), e('d', 50)];
    const frente = survivorsOf(entradas, 2, { seed: 9 });
    const tras = survivorsOf([...entradas].reverse(), 2, { seed: 9 });
    // Mesmo CONJUNTO sobrevivente independente da ordem (o shuffle é por id).
    expect([...frente.survivors].sort()).toEqual([...tras.survivors].sort());
    // Determinismo puro.
    expect(survivorsOf(entradas, 2, { seed: 9 })).toEqual(frente);
  });

  it('keepCount é limitado pelo nº de entradas (nunca sobrevive mais que o total)', () => {
    const { survivors } = survivorsOf([e('a', 1), e('b', 2)], 10, { seed: 3 });
    expect(survivors).toHaveLength(2);
  });
});
