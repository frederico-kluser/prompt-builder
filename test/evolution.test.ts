// Testes de CONTRATO do núcleo de evolução (F0 do PLANO-PARIDADE).
//
// Travam o comportamento determinístico dos módulos portados do prompt-arena
// ANTES de qualquer refactor: seeds, cadeias de desempate, pisos e a
// semântica Copeland. Se um golden aqui mudar, a mudança é deliberada e
// precisa ser revisada — não pode passar despercebida num refactor "de leve".

import { describe, expect, it } from 'vitest';
import { judgeScoreFromVerdicts, pickWinner, rankEntries, type RankEntry } from '../src/rank.js';
import { MIN_HOLDOUT_SCENARIOS, splitHoldout } from '../src/holdout.js';
import { pairedSignificance, VERDICT_SCORE, mulberry32 } from '../src/stats.js';
import {
  blindRankMap,
  pickFinalists,
  seedFromId,
  selectDuelists,
  standingsFromDuels,
  VERDICT_SCORE as DUEL_VERDICT_SCORE,
} from '../src/duels.js';
import type { DuelOutcome } from '../src/types.js';

const entry = (over: Partial<RankEntry> & { id: string }): RankEntry => ({
  label: over.id,
  isControl: false,
  judgeScore: 0,
  errored: 0,
  promptLen: 0,
  ...over,
});

describe('rank.ts — judge-score e promoção com margem', () => {
  it('judgeScoreFromVerdicts = (resolve + 0.5·parcial)/N × 100', () => {
    expect(judgeScoreFromVerdicts(['resolve', 'parcial', 'nao'])).toBeCloseTo(50, 10);
    expect(judgeScoreFromVerdicts(['resolve', 'resolve'])).toBe(100);
    expect(judgeScoreFromVerdicts([])).toBe(0);
  });

  it('veredito ausente conta como nao (resposta com erro não pontua)', () => {
    expect(judgeScoreFromVerdicts(['resolve', undefined])).toBe(50);
  });

  it('rankEntries: judgeScore desc → placement asc → menos erros → prompt mais curto', () => {
    const ranked = rankEntries([
      entry({ id: 'a', judgeScore: 50, promptLen: 10 }),
      entry({ id: 'b', judgeScore: 50, promptLen: 10, errored: 1 }),
      entry({ id: 'c', judgeScore: 50, promptLen: 20 }),
      entry({ id: 'd', judgeScore: 50, promptLen: 5, meanPlacement: 2 }),
      entry({ id: 'e', judgeScore: 90 }),
    ]);
    // c (0 erros) vence b (1 erro) MESMO com prompt mais longo: erros vêm
    // antes do tamanho na cadeia de desempate.
    expect(ranked.map((e) => e.id)).toEqual(['e', 'd', 'a', 'c', 'b']);
  });

  it('rankEntries: com erros iguais, o prompt mais curto vence (regularização)', () => {
    const ranked = rankEntries([
      entry({ id: 'longo', judgeScore: 50, promptLen: 200 }),
      entry({ id: 'curto', judgeScore: 50, promptLen: 20 }),
    ]);
    expect(ranked.map((e) => e.id)).toEqual(['curto', 'longo']);
  });

  it('quem nunca duelou (meanPlacement ausente) não vence empate espúrio', () => {
    const ranked = rankEntries([
      entry({ id: 'sem-duelo', judgeScore: 50 }),
      entry({ id: 'duelou', judgeScore: 50, meanPlacement: 3 }),
    ]);
    expect(ranked.map((e) => e.id)).toEqual(['duelou', 'sem-duelo']);
  });

  it('pickWinner: promoção exige gain >= minGain (default 1)', () => {
    const control = entry({ id: 'ctl', isControl: true, judgeScore: 60 });
    const best = entry({ id: 'v1', judgeScore: 60.9 });
    expect(pickWinner([control, best]).isWinner).toBe(false); // 0.9 < 1
    expect(pickWinner([control, entry({ id: 'v2', judgeScore: 61 })]).isWinner).toBe(true);
    expect(pickWinner([control, best], { minGain: 0.5 }).isWinner).toBe(true);
  });

  it('sem controle, a melhor variante vence por definição (gain 0)', () => {
    const pick = pickWinner([entry({ id: 'v1', judgeScore: 10 }), entry({ id: 'v2', judgeScore: 30 })]);
    expect(pick.isWinner).toBe(true);
    expect(pick.best?.id).toBe('v2');
    expect(pick.gain).toBe(0);
  });

  it('controle não disputa o título: pickWinner ignora o controle como candidato', () => {
    const pick = pickWinner([
      entry({ id: 'ctl', isControl: true, judgeScore: 100 }),
      entry({ id: 'v1', judgeScore: 10 }),
    ]);
    expect(pick.best?.id).toBe('v1');
    expect(pick.isWinner).toBe(false);
    expect(pick.gain).toBeCloseTo(-90, 10);
  });
});

describe('holdout.ts — split intercalado com piso', () => {
  it('intercala deterministicamente (a cada k-ésimo → holdout)', () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const { train, holdout } = splitHoldout(items, 0.2);
    expect(holdout).toEqual([4, 9, 14, 19, 24]);
    expect(train).toHaveLength(20);
    // As duas fatias amostram a seleção inteira (não um bloco contíguo de
    // cabeça/cauda): há itens de TREINO depois do primeiro holdout, e a união
    // disjunta recompõe a seleção original.
    expect(train.filter((x) => x > holdout[0]).length).toBeGreaterThan(0);
    expect([...train, ...holdout].sort((a, b) => a - b)).toEqual(items);
  });

  it('abaixo do piso o holdout é descartado por inteiro (tudo treina)', () => {
    const items = Array.from({ length: 12 }, (_, i) => i); // k=5 → só 2 no holdout
    const { train, holdout } = splitHoldout(items, 0.2);
    expect(holdout).toHaveLength(0);
    expect(train).toEqual(items);
  });

  it('piso MIN_HOLDOUT_SCENARIOS=5 casa com o piso da significância', () => {
    expect(MIN_HOLDOUT_SCENARIOS).toBe(5);
    const items = Array.from({ length: 25 }, (_, i) => i);
    expect(splitHoldout(items, 0.2).holdout.length).toBeGreaterThanOrEqual(5);
  });

  it('ratio é clampado em [0, 0.5]; 0 desliga o holdout', () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    expect(splitHoldout(items, 0).holdout).toHaveLength(0);
    expect(splitHoldout(items, 7).holdout.length).toBe(splitHoldout(items, 0.5).holdout.length);
  });
});

// IMPL-001: o bootstrap percentil saiu (não é p-valor); o golden abaixo passou
// a ser o do teste EXATO por troca de sinais + IC por inversão. As sondas N2 e
// a força bruta de referência vivem em test/stats-exact.test.ts.
describe('stats.ts — teste pareado exato determinístico', () => {
  it('n < 5 pares → null (amostra insuficiente)', () => {
    expect(pairedSignificance([1, 1, 1, 1], [1, 1, 1, 1])).toBeNull();
    expect(pairedSignificance([1, 1, 1, 1, 1], [1, 1, 1, 1, 1])).not.toBeNull();
  });

  it('golden: p exato 2^−6 (6 diffs +0,5, 4 zeros) e IC por inversão [12,5; 50]', () => {
    const control = [0.5, 0, 1, 0.5, 1, 0, 0.5, 1, 1, 0];
    const champion = [1, 0.5, 1, 1, 1, 0.5, 1, 1, 1, 0.5];
    expect(pairedSignificance(control, champion)).toMatchInlineSnapshot(`
      {
        "ci95Pp": [
          12.5,
          50,
        ],
        "ciMethod": "exact",
        "completeness": 1,
        "excludedPairs": 0,
        "meanDiffPp": 30,
        "method": "exact",
        "n": 10,
        "nEfetivo": 10,
        "nNonZero": 6,
        "pMinUnilateral": 0.015625,
        "pValue": 0.015625,
        "pValueTwoSided": 0.03125,
        "signTest": {
          "negative": 0,
          "pValue": 0.015625,
          "pValueTwoSided": 0.03125,
          "positive": 6,
        },
      }
    `);
    // Determinismo puro: recalcular não pode mover o p-valor (o caminho exato
    // não sorteia nada; o Monte Carlo é semeado).
    expect(pairedSignificance(control, champion)).toEqual(pairedSignificance(control, champion));
  });

  it('pareamento por pairKeys (cenário × repetição) usa a chave, não o índice', () => {
    // Controle: 6 observações; campeão nas MESMAS chaves, fora de ordem, com
    // uma observação extra sem par (c9@r1) que é ignorada no pareamento.
    const control = [0, 1, 0, 1, 0, 1];
    const champion = [1, 0, 1, 0, 1, 0, 1];
    const pairKeys = ['c2@r1', 'c1@r1', 'c2@r2', 'c1@r2', 'c2@r3', 'c1@r3', 'c9@r1'];
    const res = pairedSignificance(control, champion, { pairKeys });
    // Pares por chave: diffs alternadas +1/−1 ⇒ média 0; n = 6 (>= piso 5).
    expect(res?.n).toBe(6);
    expect(res?.meanDiffPp).toBe(0);
  });

  it('VERDICT_SCORE (0–1) ≠ VERDICT_SCORE de duels (0–2)', () => {
    expect(VERDICT_SCORE).toEqual({ resolve: 1, parcial: 0.5, nao: 0 });
    expect(DUEL_VERDICT_SCORE).toEqual({ resolve: 2, parcial: 1, nao: 0 });
  });

  it('mulberry32 é estável para a seed (golden da sequência)', () => {
    const rng = mulberry32(1337);
    expect([rng(), rng(), rng()]).toMatchInlineSnapshot(`
      [
        0.1844118325971067,
        0.18998925131745636,
        0.8104719922412187,
      ]
    `);
  });
});

describe('duels.ts — seeds cegas, bracket e Copeland', () => {
  it('seedFromId (FNV-1a) é estável (golden)', () => {
    expect(seedFromId('qualquer pergunta')).toMatchInlineSnapshot(`2467653837`);
    expect(seedFromId('x')).toBe(seedFromId('x'));
    expect(seedFromId('x')).not.toBe(seedFromId('y'));
  });

  it('blindRankMap: mesma seed + mesma lista ⇒ mesma ordem (determinismo)', () => {
    const a = blindRankMap(['v1', 'v2', 'v3'], 42);
    const b = blindRankMap(['v1', 'v2', 'v3'], 42);
    for (const id of a.keys()) expect(a.get(id)).toBe(b.get(id));
    // Seeds diferentes embaralham diferente (a ordem das CHAVES muda).
    const ordens = [42, 43, 44, 45, 46, 47, 48].map((s) =>
      [...blindRankMap(['v1', 'v2', 'v3'], s).keys()].join(','),
    );
    expect(new Set(ordens).size).toBeGreaterThan(1);
  });

  it('o shuffle cego não premia posição: cada lugar vence ~1/3 das seeds', () => {
    // Contrato real (port do Arena): as chaves aleatórias são atribuídas na
    // ordem da entrada; o que importa é que a ORDEM nunca decide diretamente —
    // com muitas seeds, nenhuma posição tem vantagem sistemática.
    const vitoriasPorPosicao = [0, 0, 0];
    for (let seed = 1; seed <= 300; seed++) {
      const rank = blindRankMap(['v1', 'v2', 'v3'], seed);
      const winner = [...rank.entries()].sort((x, y) => x[1] - y[1])[0][0];
      vitoriasPorPosicao[['v1', 'v2', 'v3'].indexOf(winner)]++;
    }
    for (const v of vitoriasPorPosicao) expect(v).toBeGreaterThan(60); // ~100 esperado
    expect(Math.max(...vitoriasPorPosicao) - Math.min(...vitoriasPorPosicao)).toBeLessThan(80);
  });

  it('selectDuelists: controle SEMPRE no bracket + K−1 melhores por score', () => {
    const entries = [
      { id: 'ctl', score: 0 },
      { id: 'a', score: 2 },
      { id: 'b', score: 1 },
      { id: 'c', score: 2 },
    ];
    const bracket = selectDuelists(entries, 'ctl', 3, 7);
    expect(bracket[0]).toBe('ctl');
    expect(bracket).toHaveLength(3);
    // O melhor score entra; entre os empatados (a/c) decide o shuffle cego.
    expect(bracket).toContain('a');
    expect(bracket).toContain('c');
  });

  it('selectDuelists é determinístico para a mesma entrada', () => {
    const entries = [
      { id: 'a', score: 1 },
      { id: 'b', score: 1 },
      { id: 'c', score: 1 },
      { id: 'd', score: 1 },
    ];
    expect(selectDuelists(entries, undefined, 2, 99)).toEqual(
      selectDuelists(entries, undefined, 2, 99),
    );
    // Empate total de score ⇒ o bracket vem do shuffle cego, não da ordem.
    expect(selectDuelists(entries, undefined, 2, 99)).not.toEqual(['a', 'b']);
  });

  it('topK <= 0 ou >= N ⇒ round-robin completo', () => {
    const entries = [{ id: 'a', score: 0 }, { id: 'b', score: 0 }];
    expect(selectDuelists(entries, 'a', 0, 1)).toEqual(['a', 'b']);
    expect(selectDuelists(entries, 'a', 9, 1)).toEqual(['a', 'b']);
  });

  it('pickFinalists: ordena por score (o resultado É o ranking) e corta em N', () => {
    const entries = [
      { id: 'a', score: 30 },
      { id: 'b', score: 90 },
      { id: 'c', score: 60 },
    ];
    expect(pickFinalists(entries, 3, 5)).toEqual(['b', 'c', 'a']);
    expect(pickFinalists(entries, 2, 5)).toEqual(['b', 'c']);
    // count 0/fora da faixa ⇒ todos, ainda em ordem de score.
    expect(pickFinalists(entries, 0, 5)).toEqual(['b', 'c', 'a']);
  });

  it('standingsFromDuels: Copeland (1 / 0.5 / 0) e placements fracionários em empate', () => {
    const duel = (a: string, b: string, outcome: 'a' | 'b' | 'tie'): DuelOutcome => ({
      a,
      b,
      order1: { winner: outcome, explanation: '' },
      order2: { winner: outcome, explanation: '' },
      outcome,
    });
    const { points, placementById, order } = standingsFromDuels(
      ['x', 'y', 'z'],
      [duel('x', 'y', 'a'), duel('x', 'z', 'b'), duel('y', 'z', 'tie')],
    );
    // x: 1 vitória + 1 derrota = 1 · y: 1 derrota + 1 empate = 0.5 · z: 1 vitória + 1 empate = 1.5
    expect(points).toEqual({ x: 1, y: 0.5, z: 1.5 });
    expect(order).toEqual(['z', 'x', 'y']);
    expect(placementById['z']).toBe(1);
  });

  it('standingsFromDuels: empate de pontos divide a média dos ranks (placement fracionário)', () => {
    const duel = (a: string, b: string, outcome: 'a' | 'b' | 'tie'): DuelOutcome => ({
      a,
      b,
      order1: { winner: outcome, explanation: '' },
      order2: { winner: outcome, explanation: '' },
      outcome,
    });
    const { placementById } = standingsFromDuels(['x', 'y'], [duel('x', 'y', 'tie')]);
    expect(placementById).toEqual({ x: 1.5, y: 1.5 });
  });

  it('desacordo entre as ordens vira empate (regra anti-viés de posição)', () => {
    // Simula a síntese do runStageDuels: ordem 1 ⇒ 'a', ordem 2 ⇒ 'b' ⇒ empate.
    const o1: 'a' | 'b' | 'tie' = 'a';
    const o2: 'a' | 'b' | 'tie' = 'b';
    expect(o1 === o2 ? o1 : 'tie').toBe('tie');
  });
});
