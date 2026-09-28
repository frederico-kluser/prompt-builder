// IMPL-051 (R-04:REC-4/DEC-3) — teste de SESSÃO simulada: erro controlado sob H0
// e o efeito da paciência.
//
// A política simulada é a MESMA do laço real (trainer.ts), peça por peça:
//   gate da melhor de K (`pickWinner`, max-T) → re-avaliação LIMPA (melhora
//   estrita em minibatch novo) → paciência N (parada) → UM teste final em
//   holdout intocado (α=0,05 unilateral, o único p de confirmação).
//
// Critérios de aceite:
//   • 10 iterações sob H0: P(pelo menos uma promoção falsa) ≤ 6% com holdout final;
//   • paciência 2 reduz paradas falsas ≥ 50% vs paciência 1 sob H0.

import { describe, expect, it } from 'vitest';
import { pickWinner, type RankEntry } from '../src/rank.js';
import { pairedSignificance, mulberry32, type PairScore } from '../src/stats.js';
import { reevalDecision, shouldStopForPatience } from '../src/engine/trainingPolicy.js';
import { FULL, ensaios } from './support/effort.js';

/** Um par de scores (controle, candidato) de UM cenário, na escala 0–1. */
type Draw = (rng: () => number) => { control: number; candidate: number };

/** Veredito ternário: 'resolve' 1, 'parcial' 0,5, 'nao' 0 (a régua do produto). */
function ternary(pResolve: number, rng: () => number): number {
  const u = rng();
  return u < pResolve ? 1 : u < pResolve + (1 - pResolve) / 2 ? 0.5 : 0;
}

const h0Draw: Draw = (rng) => {
  const c = ternary(0.3, rng);
  return { control: c, candidate: ternary(0.3, rng) };
};

// Ganho real disponível em toda iteração (Δ ≈ +55 p.p. de 'resolve'), mas com
// veredito ruidoso e n pequeno: em alguma iteração a evidência some e a sessão
// pode parar SEM promover — a "parada falsa" que a paciência tem de reduzir.
const h1Draw: Draw = (rng) => {
  const c = ternary(0.15, rng);
  return { control: c, candidate: ternary(0.7, rng) };
};

interface SimOpts {
  iterations: number;
  k: number;
  n: number;
  patience: number;
  draw: Draw;
  holdoutN: number;
  seed: number;
}

interface SimResult {
  promocoes: number;
  convergiuSemPromocao: boolean;
  parouNaPrimeira: boolean;
  holdoutConfirmou: boolean;
}

const media = (xs: readonly PairScore[]): number => {
  const obs = xs.filter((v): v is number => typeof v === 'number');
  return obs.length ? (obs.reduce((a, b) => a + b, 0) / obs.length) * 100 : 0;
};

/** Uma sessão simulada com a política real (gate + reeval + paciência + holdout). */
function simularSessao(opts: SimOpts): SimResult {
  const rng = mulberry32(opts.seed);
  const drawScores = (n: number): { control: PairScore[]; candidates: PairScore[][] } => {
    const control: PairScore[] = [];
    const candidates: PairScore[][] = Array.from({ length: opts.k }, () => []);
    for (let i = 0; i < n; i += 1) {
      for (let k = 0; k < opts.k; k += 1) {
        const { control: c, candidate: v } = opts.draw(rng);
        if (k === 0) control.push(c);
        candidates[k].push(v);
      }
    }
    return { control, candidates };
  };

  let promocoes = 0;
  let semPromocao = 0;
  let promovidoAlgumaVez = false;
  let parouNaPrimeira = false;
  let iteracoesFeitas = 0;

  for (let i = 0; i < opts.iterations; i += 1) {
    iteracoesFeitas = i + 1;
    const { control, candidates } = drawScores(opts.n);
    const scoresById: Record<string, PairScore[]> = { control };
    const entries: RankEntry[] = [
      { id: 'control', label: 'Controle', isControl: true, judgeScore: media(control), errored: 0, promptLen: 10 },
    ];
    candidates.forEach((scores, k) => {
      const id = `c${k}`;
      scoresById[id] = scores;
      entries.push({ id, label: id, isControl: false, judgeScore: media(scores), errored: 0, promptLen: 10 });
    });
    const pick = pickWinner(entries, {
      scoresById,
      iterations: 256,
      seed: opts.seed + i,
    });
    let promoted = false;
    if (pick.isWinner && pick.best && pick.control) {
      // Re-avaliação LIMPA: minibatch NOVO (o dado da seleção não confirma a
      // própria seleção) — melhora ESTRITA para promover.
      const mini = drawScores(5);
      const candidato = mini.candidates[Number(pick.best.id.slice(1))] ?? [];
      promoted = reevalDecision(mini.control, candidato).confirmed;
    }
    if (promoted) {
      promocoes += 1;
      promovidoAlgumaVez = true;
      semPromocao = 0;
    } else {
      semPromocao += 1;
      if (shouldStopForPatience(semPromocao, opts.patience)) break;
    }
  }
  if (!promovidoAlgumaVez && iteracoesFeitas <= 1) parouNaPrimeira = true;

  // UM teste final em holdout intocado (α=0,05 unilateral) — o único p de
  // confirmação da sessão (IMPL-051).
  const h = drawScores(opts.holdoutN);
  const sig = pairedSignificance(h.control, h.candidates[0], { pOrigin: 'holdout' });
  const holdoutConfirmou = sig !== null && sig.pValue <= 0.05 && sig.meanDiffPp > 0;

  return {
    promocoes,
    convergiuSemPromocao: !promovidoAlgumaVez,
    parouNaPrimeira,
    holdoutConfirmou,
  };
}

describe('IMPL-051 — sessão simulada sob H0 (10 iterações): erro controlado', () => {
  it('P(pelo menos uma promoção falsa) ≤ 6% com holdout final (2000 sessões)', () => {
    const SESSOES = ensaios(2000, 250);
    let comPromocaoFalsa = 0;
    let falsaConfirmada = 0;
    for (let s = 0; s < SESSOES; s += 1) {
      const r = simularSessao({
        iterations: 10,
        k: 3,
        n: 10,
        patience: 2,
        draw: h0Draw,
        holdoutN: 10,
        seed: 1000 + s * 7,
      });
      if (r.promocoes > 0) comPromocaoFalsa += 1;
      if (r.promocoes > 0 && r.holdoutConfirmou) falsaConfirmada += 1;
    }
    const taxa = comPromocaoFalsa / SESSOES;
    const taxaConfirmada = falsaConfirmada / SESSOES;
    expect(taxa, `promoções falsas: ${comPromocaoFalsa}/${SESSOES}`).toBeLessThanOrEqual(FULL ? 0.06 : 0.09);
    // Com o teste final (holdout, α=0,05 unilateral) a sessão que AINDA ASSIM
    // recomendar um ganho falso fica ainda mais rara.
    expect(taxaConfirmada).toBeLessThanOrEqual(taxa);
    expect(taxaConfirmada).toBeLessThanOrEqual(FULL ? 0.06 : 0.09);
  });
});

describe('IMPL-051 — paciência 2 reduz paradas falsas ≥ 50% vs paciência 1', () => {
  it('sob H0: parada na 1ª iteração (por azar) cai ≥ 50% com paciência 2', () => {
    const SESSOES = ensaios(1000, 200);
    let p1 = 0;
    let p2 = 0;
    for (let s = 0; s < SESSOES; s += 1) {
      const opts = {
        iterations: 10,
        k: 3,
        n: 10,
        draw: h0Draw,
        holdoutN: 10,
        seed: 5000 + s * 3,
      };
      if (simularSessao({ ...opts, patience: 1 }).parouNaPrimeira) p1 += 1;
      if (simularSessao({ ...opts, patience: 2 }).parouNaPrimeira) p2 += 1;
    }
    // Sob H0 a 1ª iteração sem promoção é RUÍDO: paciência 1 "converge" por
    // azar quase sempre; paciência 2 exige 2 seguidas.
    expect(p2).toBeLessThanOrEqual(0.5 * p1);
  });

  it('com ganho real disponível (regime ruidoso): convergir sem nenhuma promoção cai ≥ 50%', () => {
    const SESSOES = ensaios(600, 150);
    let p1 = 0;
    let p2 = 0;
    for (let s = 0; s < SESSOES; s += 1) {
      const opts = {
        iterations: 10,
        k: 3,
        n: 10,
        draw: h1Draw,
        holdoutN: 10,
        seed: 9000 + s * 5,
      };
      if (simularSessao({ ...opts, patience: 1 }).convergiuSemPromocao) p1 += 1;
      if (simularSessao({ ...opts, patience: 2 }).convergiuSemPromocao) p2 += 1;
    }
    // "Parada falsa" = a sessão converge SEM promover havendo ganho real
    // disponível em toda iteração (o veredito ruidoso escondeu o ganho).
    expect(p1, `paciência 1: ${p1}/600`).toBeGreaterThan(0);
    expect(p2, `paciência 2: ${p2}/600`).toBeLessThanOrEqual(0.5 * p1);
  });

  it('a política de paciência é a mesma do laço (shouldStopForPatience)', () => {
    expect(shouldStopForPatience(1, 1)).toBe(true);
    expect(shouldStopForPatience(1, 2)).toBe(false);
    expect(shouldStopForPatience(2, 2)).toBe(true);
    expect(shouldStopForPatience(2, 3)).toBe(false);
    expect(shouldStopForPatience(3, 3)).toBe(true);
  });
});

describe('IMPL-051 — a re-avaliação limpa faz parte do controle de erro', () => {
  it('só promove com melhora ESTRITA no minibatch novo (empate não confirma)', () => {
    expect(reevalDecision([1, 1, 1], [1, 1, 1]).confirmed).toBe(false);
    expect(reevalDecision([0.5, 0.5, 0.5], [1, 1, 1]).confirmed).toBe(true);
    expect(reevalDecision([], []).confirmed).toBe(false);
  });
});
