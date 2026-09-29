// Modo JEV — métricas e calibração conferidas com valores feitos À MÃO (§8).

import { describe, expect, it } from 'vitest';
import {
  applyTemperature,
  aurc,
  auroc,
  compareToControl,
  computeMetrics,
  distFromAnswer,
  eceEqualMass,
  eceEqualWidth,
  fitTemperature,
  fitThresholds,
  fitQuestionPolicy,
  bandUnder,
  ceilThreshold,
  headlineOf,
  parseLlmAnswer,
  aggregateReps,
  percentile,
  policyFor,
  scoreDist,
  simulateCascade,
  DEFAULT_BANDS,
  AUTO_OFF,
  type Dist,
  type JevCell,
  type JevQuestionSpec,
  type JevScoredAnswer,
} from '../src/engine/jev/index.js';
import { mulberry32 } from '../src/stats.js';

const NOUL = { id: 'b', type: 'noul', instructions: 'É bug?' } as JevQuestionSpec;
const CHOICE = { id: 't', type: 'choice', instructions: 'Time?', criteria: { a: 'x', b: 'y', c: null } } as JevQuestionSpec;
const SCORE = { id: 'u', type: 'score', instructions: 'Urgência?', criteria: ['baixa', 'média', 'alta'] } as JevQuestionSpec;
const pol = (q: JevQuestionSpec) => policyFor({}, q, DEFAULT_BANDS);

describe('Brier / RPS / log-loss / acerto por primitiva', () => {
  it('noul: Brier (p−y)², acerto por p ≥ 0,5, log-loss com ε', () => {
    const d = distFromAnswer(NOUL, { type: 'noul', noul: 0.8 });
    const it = scoreDist(NOUL, 'c1', d, true, pol(NOUL));
    expect(it.brier).toBeCloseTo(0.04, 12);
    expect(it.correct).toBe(true);
    expect(it.pTrue).toBeCloseTo(0.8, 12);
    expect(it.logLoss).toBeCloseTo(-Math.log(0.8), 12);
    const zero = scoreDist(NOUL, 'c1', distFromAnswer(NOUL, { type: 'noul', noul: 0 }), true, pol(NOUL));
    expect(zero.logLoss).toBeCloseTo(-Math.log(1e-3), 12); // ε: nunca infinito
  });

  it('choice: Brier ½Σ(p−1[k=y])² ∈ [0,1], pTop/argmax; alternativas somam no pTrue', () => {
    const d = distFromAnswer(CHOICE, { type: 'choice', choice: 'a', probabilities: { a: 0.6, b: 0.3, c: 0.1 }, confidence: 0.45 });
    const it = scoreDist(CHOICE, 'x', d, 'b', pol(CHOICE));
    // ½[(0,6)² + (0,3−1)² + (0,1)²] = ½[0,36 + 0,49 + 0,01] = 0,43
    expect(it.brier).toBeCloseTo(0.43, 12);
    expect(it.correct).toBe(false);
    expect(it.pTop).toBeCloseTo(0.6, 12);
    // O ECE usa pTop, NUNCA o confidence opaco da API (0,45 aqui).
    expect(it.signal).toBeCloseTo(0.45, 12);
    const alt = scoreDist(CHOICE, 'x', d, ['b', 'c'], pol(CHOICE));
    expect(alt.pTrue).toBeCloseTo(0.4, 12);
  });

  it('score: RPS normalizado e acerto por |E[ŝ]−y| ≤ τ', () => {
    const d = distFromAnswer(SCORE, { type: 'score', score: 1.5, probabilities: { '0': 0.1, '1': 0.3, '2': 0.6 }, confidence: 0.7 });
    const it = scoreDist(SCORE, 'x', d, 2, pol(SCORE), { tolerance: 0.5 });
    // F0=0,1 F1=0,4; y=2 → (0,1−0)² + (0,4−0)² = 0,17; /(L−1=2) = 0,085
    expect(it.brier).toBeCloseTo(0.085, 12);
    expect(it.correct).toBe(true); // |1,5−2| = 0,5 ≤ 0,5
    expect(it.absError).toBeCloseTo(0.5, 12);
    expect(scoreDist(SCORE, 'x', d, 0, pol(SCORE), { tolerance: 0.5 }).correct).toBe(false);
  });

  it('perguntas degeneradas (1 opção, 1 nível) saem do Brier (null)', () => {
    const um = { id: 'o', type: 'choice', instructions: 'x', criteria: { a: 'x' } } as JevQuestionSpec;
    expect(scoreDist(um, 'x', distFromAnswer(um, { type: 'choice', choice: 'a' }), 'a', pol(um)).brier).toBeNull();
    const nivel = { id: 'n', type: 'score', instructions: 'x', criteria: ['só'] } as JevQuestionSpec;
    expect(scoreDist(nivel, 'x', distFromAnswer(nivel, { type: 'score', score: 0 }), 0, pol(nivel)).brier).toBeNull();
  });

  it('bandas: com hitl 0,5 uma noul NUNCA abstém; com 0,6 (default) abstém', () => {
    const d = distFromAnswer(NOUL, { type: 'noul', noul: 0.55 });
    expect(scoreDist(NOUL, 'x', d, true, { auto: 0.9, hitl: 0.5, signal: 'certainty' }).band).toBe('hitl');
    expect(scoreDist(NOUL, 'x', d, true, pol(NOUL)).band).toBe('abstain');
  });

  it('célula inválida: ERRADA, abstém e no PIOR caso (Brier 1, pTrue 0, log-loss −ln ε) — placar e pior-caso concordam', () => {
    const cells: JevCell[] = [{ caseId: 'x', contestantId: 'k', rep: 0, status: 'ok', answers: {}, invalid: { t: 'choice.not_in_criteria' } }];
    const oc = aggregateReps(CHOICE, cells);
    expect(oc.invalid).toBe(true);
    const it = scoreDist(CHOICE, 'x', oc.dist!, 'a', pol(CHOICE), { invalid: true });
    expect(it.correct).toBe(false);
    expect(it.band).toBe('abstain');
    expect(it.predicted).toBeNull();
    expect(it.pTrue).toBe(0);
    expect(it.brier).toBe(1);
    expect(it.logLoss).toBeCloseTo(-Math.log(1e-3), 12);
    const m = computeMetrics({ items: [it], goldOf: () => ['a'], planned: 1, noScore: 0, cells, questionsPerCell: 1, repeats: 1 });
    expect(m.brierWorstCase).toBe(1);
    expect(m.brier).toBe(1);
    expect(m.brierScore).toBe(0);
    expect(m.nInvalid).toBe(1);
    // com a política ajustada, o calibrado segue a MESMA regra
    const cal = scoreDist(CHOICE, 'x', oc.dist!, 'a', pol(CHOICE), { invalid: true, calibratedPolicy: { ...pol(CHOICE), temperature: 2 } });
    expect(cal.calibrated).toMatchObject({ brier: 1, pTrue: 0, band: 'abstain' });
  });

  it('L1: inválida NUNCA sai melhor que um erro confiante — nem no placar, nem na comparação pareada', () => {
    // noul: erro confiante (p=0,9 no lado errado) × resposta fora do contrato.
    const errado = scoreDist(NOUL, 'x', distFromAnswer(NOUL, { type: 'noul', noul: 0.1 }), true, pol(NOUL));
    const invalida = scoreDist(NOUL, 'x', aggregateReps(NOUL, [{ caseId: 'x', contestantId: 'k', rep: 0, status: 'invalid' }]).dist!, true, pol(NOUL), { invalid: true });
    expect(errado.brier).toBeCloseTo(0.81, 12);
    expect(invalida.brier!).toBeGreaterThanOrEqual(errado.brier!);
    // Comparação pareada (1−Brier por caso): o competidor que quebra o contrato
    // em todos os casos PERDE para o que erra com confiança — antes (uniforme)
    // ganhava 0,75 × 0,19 por caso.
    const casos = Array.from({ length: 8 }, (_, i) => `c${i}`);
    const ctrl = casos.map((c) => ({ ...errado, caseId: c }));
    const quebra = casos.map((c) => ({ ...invalida, caseId: c }));
    const cmp = compareToControl('ctrl', 'quebra', ctrl, quebra, 'brierScore');
    expect(cmp.meanDiffPp!).toBeLessThan(0);
  });

  it('reps: distribuições promediadas antes; flip quando o previsto muda', () => {
    const cells: JevCell[] = [
      { caseId: 'x', contestantId: 'k', rep: 0, status: 'ok', answers: { b: { type: 'noul', noul: 0.8 } } },
      { caseId: 'x', contestantId: 'k', rep: 1, status: 'ok', answers: { b: { type: 'noul', noul: 0.4 } } },
    ];
    const oc = aggregateReps(NOUL, cells);
    expect((oc.dist as { pYes: number }).pYes).toBeCloseTo(0.6, 12);
    expect(oc.flipped).toBe(true);
    // qualquer rep com erro de infraestrutura = SEM NOTA
    expect(aggregateReps(NOUL, [...cells, { caseId: 'x', contestantId: 'k', rep: 2, status: 'error' }]).dist).toBeNull();
  });
});

describe('ECE, AURC, AUROC, percentil', () => {
  it('ECE top-label de largura igual e de massa igual', () => {
    const pts = [
      { conf: 0.95, hit: true },
      { conf: 0.95, hit: false },
      { conf: 0.55, hit: true },
      { conf: 0.55, hit: true },
    ];
    // bin 9: acc 0,5 conf 0,95 → 0,45·½ ; bin 5: acc 1 conf 0,55 → 0,45·½  ⇒ 0,45
    expect(eceEqualWidth(pts).ece).toBeCloseTo(0.45, 12);
    expect(eceEqualMass(pts, 2)).toBeCloseTo(0.45, 12);
  });
  it('AURC e AUROC do sinal', () => {
    const pts = [
      { signal: 0.9, correct: true, key: 'a' },
      { signal: 0.8, correct: true, key: 'b' },
      { signal: 0.3, correct: false, key: 'c' },
    ];
    // risco acumulado: 0/1, 0/2, 1/3 → média = (0 + 0 + 1/3)/3
    expect(aurc(pts)).toBeCloseTo(1 / 9, 12);
    expect(auroc(pts)).toBe(1);
    expect(auroc([{ signal: 1, correct: true }])).toBeNull();
  });
  it('percentil nearest-rank', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('calibração pós-hoc', () => {
  it('temperatura não muda o argmax; fitTemperature recupera T conhecido em dados sintéticos', () => {
    const d: Dist = { type: 'choice', labels: ['a', 'b', 'c'], probs: [0.7, 0.2, 0.1] };
    const t2 = applyTemperature(d, 2) as { probs: number[] };
    expect(t2.probs.indexOf(Math.max(...t2.probs))).toBe(0);
    expect(t2.probs[0]).toBeLessThan(0.7);
    // Verdade: P(acerto) = σ(z/2) — o modelo reporta σ(z) (superconfiante, T=2).
    const rand = mulberry32(7);
    const pontos = [];
    for (let i = 0; i < 4000; i++) {
      const z = (rand() - 0.5) * 8;
      const pReal = 1 / (1 + Math.exp(-z / 2));
      const y = rand() < pReal;
      const pRep = 1 / (1 + Math.exp(-z));
      pontos.push({ dist: { type: 'noul' as const, pYes: pRep }, expected: [y], correct: pRep >= 0.5 === y });
    }
    const T = fitTemperature(pontos);
    expect(T).toBeGreaterThan(1.7);
    expect(T).toBeLessThan(2.3);
  });
  it('limiar auto para a precisão-alvo, com suporte mínimo; inatingível desliga a banda', () => {
    const pts = [
      ...Array.from({ length: 10 }, () => ({ signal: 0.95, correct: true })),
      ...Array.from({ length: 10 }, (_, i) => ({ signal: 0.7, correct: i < 5 })),
    ];
    expect(fitThresholds(pts, 0.95, 0.5)).toMatchObject({ auto: 0.95, coverage: 0.5, precision: 1 });
    expect(fitThresholds(pts.map((p) => ({ ...p, correct: false })), 0.95, 0.5).auto).toBe(AUTO_OFF);
  });
});

describe('comparação pareada e cascata', () => {
  const item = (caseId: string, correct: boolean, brier: number, signal = 0.9, band: JevScoredAnswer['band'] = 'auto'): JevScoredAnswer => ({
    qid: 'q', caseId, type: 'noul', predicted: correct, correct, pTrue: 1 - Math.sqrt(brier), pTop: 0.9, topCorrect: correct, signal, band, brier, logLoss: 0.1,
  });
  it('alinha por caseId (ordens diferentes) e usa McNemar BILATERAL', () => {
    const ctrl = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((k) => item(k, false, 0.5));
    const comp = ['g', 'f', 'e', 'd', 'c', 'b', 'a'].map((k) => item(k, true, 0.1));
    const cmp = compareToControl('ctrl', 'comp', ctrl, comp, 'brierScore');
    expect(cmp.meanDiffPp).toBeCloseTo(40, 6);
    expect(cmp.nEfetivo).toBe(7);
    expect(cmp.discordant).toEqual({ better: 7, worse: 0 });
    expect(cmp.mcnemarP).toBeCloseTo(2 / 128, 12); // bilateral: 2·(1/2)^7
    expect(cmp.accuracyDiffPp).toBeCloseTo(100, 9);
  });
  it('cascata: acurácia × % escalado × custo, e quanto escalar para empatar com o LLM', () => {
    const dec = [item('a', true, 0.01, 0.99), item('b', true, 0.01, 0.95), item('c', false, 0.8, 0.6, 'hitl'), item('d', false, 0.8, 0.4, 'abstain')];
    const llm = ['a', 'b', 'c', 'd'].map((k) => item(k, true, 0.05));
    const k = simulateCascade({ decisionId: 'd', llmId: 'l', decision: dec, llm, decisionCostPer1k: 0.02, llmCostPer1k: 1 });
    expect(k.atDefault).toMatchObject({ accuracy: 1, escalatedRate: 0.5 });
    expect(k.atDefault.costPer1kDecisions).toBeCloseTo(0.52, 12);
    expect(k.escalationToMatchLlm).toBeCloseTo(0.5, 12);
    expect(k.decisionOnly.accuracy).toBeCloseTo(0.5, 12);
    expect(k.curve.length).toBe(21);
  });
});

describe('M1: o PREVISTO é a resposta DECLARADA (choice da API, answer/level do LLM)', () => {
  it('choice: `choice` da API decide mesmo com as probabilidades de 2 casas empatadas ou invertidas', () => {
    const empate = distFromAnswer(CHOICE, { type: 'choice', choice: 'b', probabilities: { a: 0.5, b: 0.5, c: 0 }, confidence: 0.6 });
    const i1 = scoreDist(CHOICE, 'x', empate, 'b', pol(CHOICE));
    expect(i1).toMatchObject({ predicted: 'b', correct: true, topCorrect: true });
    expect(i1.pTop).toBeCloseTo(0.5, 12);
    const invertida = distFromAnswer(CHOICE, { type: 'choice', choice: 'b', probabilities: { a: 0.51, b: 0.49, c: 0 } });
    const i2 = scoreDist(CHOICE, 'x', invertida, 'b', pol(CHOICE));
    expect(i2).toMatchObject({ predicted: 'b', correct: true, topCorrect: true });
    // ECE/certeza usam a p da classe PREVISTA; Brier segue as probabilidades.
    expect(i2.pTop).toBeCloseTo(0.49, 12);
    expect(i2.brier).toBeCloseTo(0.5 * (0.51 ** 2 + 0.51 ** 2), 12);
    // e o erro de verdade continua erro
    expect(scoreDist(CHOICE, 'x', invertida, 'a', pol(CHOICE)).correct).toBe(false);
  });

  it('LLM noul: `answer` declarado decide; p_yes verbalizado só nas métricas (e na certeza)', () => {
    const p = parseLlmAnswer(NOUL, { answer: true, p_yes: 0.3 });
    if (!p.ok) throw new Error(p.code);
    expect(p.answer).toEqual({ type: 'noul', noul: 0.3, answer: true });
    const it = scoreDist(NOUL, 'x', distFromAnswer(NOUL, p.answer), true, pol(NOUL));
    expect(it).toMatchObject({ predicted: true, correct: true, topCorrect: true });
    expect(it.pTrue).toBeCloseTo(0.3, 12);
    expect(it.pTop).toBeCloseTo(0.3, 12);
    expect(it.band).toBe('abstain'); // resposta que contradiz a própria p não fica em auto
    // sem p_yes: o answer vira p 0/1 e segue sendo o previsto
    const so = parseLlmAnswer(NOUL, { answer: false });
    if (!so.ok) throw new Error(so.code);
    expect(scoreDist(NOUL, 'x', distFromAnswer(NOUL, so.answer), false, pol(NOUL)).correct).toBe(true);
  });

  it('LLM choice e score: `choice`/`level` declarados vencem a distribuição verbalizada', () => {
    const c = parseLlmAnswer(CHOICE, { choice: 'c', probabilities: { a: 0.6, b: 0.3, c: 0.1 } });
    if (!c.ok) throw new Error(c.code);
    expect(scoreDist(CHOICE, 'x', distFromAnswer(CHOICE, c.answer), 'c', pol(CHOICE))).toMatchObject({ predicted: 'c', correct: true });
    const sc = parseLlmAnswer(SCORE, { level: 2, probabilities: { '0': 0.5, '1': 0.3, '2': 0.2 } });
    if (!sc.ok) throw new Error(sc.code);
    expect(sc.answer).toMatchObject({ type: 'score', level: 2 });
    const it = scoreDist(SCORE, 'x', distFromAnswer(SCORE, sc.answer), 2, pol(SCORE));
    expect(it.predicted).toBe(2);
    expect(it.topCorrect).toBe(true);
    expect(it.pTop).toBeCloseTo(0.2, 12);
  });

  it('reps: a resposta declarada mais votada; empate pela p média; temperatura preserva o pick', () => {
    const cel = (rep: number, choice: string, a: number): JevCell => ({
      caseId: 'x', contestantId: 'k', rep, status: 'ok', answers: { t: { type: 'choice', choice, probabilities: { a, b: 1 - a, c: 0 } } },
    });
    const maioria = aggregateReps(CHOICE, [cel(0, 'b', 0.5), cel(1, 'b', 0.6), cel(2, 'a', 0.9)]);
    // p média de a = 0,667 > b, mas 2 das 3 reps DISSERAM b
    expect(scoreDist(CHOICE, 'x', maioria.dist!, 'b', pol(CHOICE)).predicted).toBe('b');
    expect(maioria.flipped).toBe(true);
    const empate = aggregateReps(CHOICE, [cel(0, 'a', 0.4), cel(1, 'b', 0.4)]);
    expect(scoreDist(CHOICE, 'x', empate.dist!, 'b', pol(CHOICE)).predicted).toBe('b'); // p média b 0,6
    const quente = applyTemperature(maioria.dist!, 3);
    expect((quente as { pick?: string }).pick).toBe('b');
    const noul = applyTemperature({ type: 'noul', pYes: 0.3, pick: true }, 0.5);
    expect((noul as { pick?: boolean }).pick).toBe(true);
  });
});

describe('L2: conjunto VAZIO não parece perfeito', () => {
  it('nScored = 0 → acurácia, log-loss, ECE, AURC e cobertura null (nunca 0)', () => {
    const m = computeMetrics({ items: [], goldOf: () => [], planned: 4, noScore: 4, cells: [], questionsPerCell: 1, repeats: 1 });
    expect(m.nScored).toBe(0);
    for (const k of ['accuracy', 'logLoss', 'ece', 'eceAdaptive', 'aurc', 'coverageAtAuto', 'brier', 'brierScore'] as const) expect(m[k]).toBeNull();
    expect(headlineOf(m)).toMatchObject({ accuracy: null, ece: null, coverageAtAuto: null, brierScore: null });
  });
});

describe('L3: limiar auto ajustado arredonda para CIMA', () => {
  it('ceilThreshold não sobe um corte já com 4 casas e nunca desce abaixo do corte', () => {
    for (const x of [0.9, 0.85, 0.29, 0.57, 0.1234, 1.01]) expect(ceilThreshold(x)).toBe(x);
    expect(ceilThreshold(0.912345)).toBe(0.9124);
    expect(ceilThreshold(0.12340000001)).toBeGreaterThanOrEqual(0.12340000001);
  });

  it('um ponto ERRADO logo abaixo do corte contínuo nunca entra na banda auto', () => {
    const pt = (conf: number, correct: boolean) => ({
      dist: { type: 'choice' as const, labels: ['a', 'b', 'c'], probs: correct ? [0.8, 0.1, 0.1] : [0.1, 0.8, 0.1], confidence: conf, pick: correct ? 'a' : 'b' },
      expected: ['a'],
      correct,
    });
    const pontos = [
      ...Array.from({ length: 20 }, () => pt(0.99, true)),
      pt(0.912345, true), // o corte ajustado (precisão 21/21)
      pt(0.912341, false), // logo abaixo: com ele, 21/22 < 0,99
      ...Array.from({ length: 4 }, () => pt(0.5, false)),
    ];
    const base = policyFor({}, CHOICE, DEFAULT_BANDS);
    const pol2 = fitQuestionPolicy(CHOICE, base, pontos, { targetPrecision: 0.99, split: 'calib' });
    expect(pol2.fitted).toBe(true);
    expect(pol2.auto).toBeGreaterThanOrEqual(0.912345);
    expect(bandUnder(pontos[21], pol2)).not.toBe('auto');
    // o antigo toFixed(4) daria 0,9123 e admitiria o ponto errado
    expect(Number((0.912345).toFixed(4))).toBeLessThan(0.912341);
  });
});
