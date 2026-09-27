// IMPL-002 (R-04:REC-3) — GATE DA MELHOR DE K. Testes de contrato:
//
//   • max-T por permutação (Westfall-Young step-down, troca de sinais CONJUNTA
//     por cenário) conferido contra um ORÁCULO de força bruta (2^n vetores, sem
//     agrupamento), com ausentes; K = 1 coincide com o teste pareado do IMPL-001;
//   • Monte Carlo semeado (B = 10.000) acima do teto da enumeração exata;
//   • Holm como fallback; minGain default max(1; 50/n);
//   • K = 8 variantes idênticas sob H0 não promovem (o gate antigo promovia);
//   • ganho corrigido do winner's curse ≤ bruto, = bruto com K = 1.
//
// Zero rede: tudo aqui é aritmética pura.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bestOfKTest,
  defaultMinGain,
  GATE_ALPHA,
  holmAdjust,
  resolveMinGain,
  winnersCurseInflation,
} from '../src/engine/bestOfK.js';
import {
  formatGateSummary,
  formatIterationGate,
  mulberry32,
  signFlipTest,
  type PairScore,
} from '../src/stats.js';
import * as webStats from '../web/src/engine/stats.js';
import * as webRank from '../web/src/engine/rank.js';
import { pickWinner, promotionEventFields, type RankEntry } from '../src/rank.js';
import { getDataDir, loadSession, saveSession, setDataDir } from '../src/storage.js';
import { cmdSessions } from '../src/cli/commands/misc.js';
import { emitSessionEventNdjson } from '../src/cli/ndjson.js';
import { Output } from '../src/cli/output.js';
import type { SessionRecord } from '../src/types.js';
import { parseArenaConfig } from '../src/configFile.js';
import { arenaConfigToRunConfig } from '../src/arenaConfig.js';

// --- oráculo de força bruta -------------------------------------------------------

/**
 * Max-T step-down ingênuo: enumera TODOS os 2^n vetores de sinais (um por
 * cenário, o MESMO para as K variantes), sem agrupamento nem atalhos. Ausente
 * sai dos dois lados (par inexistente = não entra na média da variante).
 */
function oracle(control: PairScore[], variants: PairScore[][]) {
  const n = control.length;
  const K = variants.length;
  const obs = (v: PairScore): v is number => typeof v === 'number';
  const d = variants.map((v) => control.map((c, i) => (obs(c) && obs(v[i]) ? v[i]! - c : null)));
  const nk = d.map((row) => row.filter((x) => x !== null).length);
  const T = (s: number[]) => d.map((row, k) => (nk[k] ? row.reduce<number>((a, x, i) => a + (x ?? 0) * s[i], 0) / nk[k] : NaN));
  const tObs = T(new Array(n).fill(1));
  const testable = [...Array(K).keys()].filter((k) => nk[k] > 0);
  const order = [...testable].sort((a, b) => tObs[b] - tObs[a] || a - b);
  const total = 2 ** n;
  const step = new Array(order.length).fill(0);
  const raw = new Array(K).fill(0);
  for (let mask = 0; mask < total; mask += 1) {
    const s = Array.from({ length: n }, (_, i) => ((mask >> i) & 1 ? -1 : 1));
    const t = T(s);
    for (const k of testable) if (t[k] >= tObs[k] - 1e-9) raw[k] += 1;
    order.forEach((k, j) => {
      const u = Math.max(...order.slice(j).map((q) => t[q]));
      if (u >= tObs[k] - 1e-9) step[j] += 1;
    });
  }
  const pAdj = new Array(K).fill(1);
  let run = 0;
  order.forEach((k, j) => {
    run = Math.max(run, step[j] / total);
    pAdj[k] = run;
  });
  return { pAdj, pRaw: raw.map((r, k) => (nk[k] ? r / total : 1)), tObs };
}

const TERNARY = [0, 0.5, 1];

function randomCase(rng: () => number, n: number, K: number, missing: number) {
  const pick = (): PairScore => (rng() < missing ? null : TERNARY[Math.floor(rng() * 3)]);
  return { control: Array.from({ length: n }, pick), variants: Array.from({ length: K }, () => Array.from({ length: n }, pick)) };
}

describe('IMPL-002 — max-T step-down (troca de sinais conjunta)', () => {
  it('coincide com o oráculo de força bruta (K 1–4, n 3–10, com ausentes e empates)', () => {
    const rng = mulberry32(2024);
    for (let rep = 0; rep < 60; rep += 1) {
      const n = 3 + (rep % 8);
      const K = 1 + (rep % 4);
      const { control, variants } = randomCase(rng, n, K, rep % 3 === 0 ? 0.15 : 0);
      const got = bestOfKTest(control, variants);
      const want = oracle(control, variants);
      expect(got.enumeration).toBe('exact');
      for (let k = 0; k < K; k += 1) {
        expect(got.pAdjusted[k], `rep ${rep} k ${k}`).toBeCloseTo(want.pAdj[k], 12);
        expect(got.pRaw[k], `rep ${rep} k ${k}`).toBeCloseTo(want.pRaw[k], 12);
      }
    }
  });

  it('K = 1: o p ajustado É o p unilateral exato do teste pareado (IMPL-001)', () => {
    const rng = mulberry32(7);
    for (const n of [5, 8, 20, 40]) {
      const { control, variants } = randomCase(rng, n, 1, 0);
      const diffs = control.map((c, i) => (variants[0][i] as number) - (c as number));
      const got = bestOfKTest(control, variants);
      expect(got.pAdjusted[0]).toBeCloseTo(signFlipTest(diffs).pGreater, 12);
      expect(got.pRaw[0]).toBe(got.pAdjusted[0]);
    }
  });

  it('p ajustado ≥ p marginal e monótono na ordem de T_obs', () => {
    const rng = mulberry32(99);
    for (let rep = 0; rep < 20; rep += 1) {
      const { control, variants } = randomCase(rng, 10, 6, 0.1);
      const r = bestOfKTest(control, variants);
      const order = [...Array(6).keys()].filter((k) => r.nEfetivo[k] > 0).sort((a, b) => r.meanDiff[b] - r.meanDiff[a]);
      for (let j = 0; j < order.length; j += 1) {
        expect(r.pAdjusted[order[j]]).toBeGreaterThanOrEqual(r.pRaw[order[j]] - 1e-12);
        if (j > 0) expect(r.pAdjusted[order[j]]).toBeGreaterThanOrEqual(r.pAdjusted[order[j - 1]] - 1e-12);
      }
    }
  });

  it('variante sem nenhum par completo fica fora da família (p = 1, k não a conta)', () => {
    const control = [0, 0, 0, 0, 0, 0];
    const r = bestOfKTest(control, [[1, 1, 1, 1, 1, 1], [null, null, null, null, null, null]]);
    expect(r.k).toBe(1);
    expect(r.pAdjusted[1]).toBe(1);
    expect(r.pAdjusted[0]).toBeCloseTo(1 / 64, 12);
    expect(Number.isNaN(r.meanDiff[1])).toBe(true);
  });

  it('a troca é CONJUNTA: a correlação pela régua comum pesa no p ajustado', () => {
    // As K variantes são IDÊNTICAS entre si: o máximo de K cópias é a própria
    // cópia, então o p ajustado tem de ser o p de UMA comparação — Bonferroni
    // (K·p) ou trocas independentes por variante inflariam em ~K×.
    const control = [0, 0.5, 0, 0, 0.5, 0, 0, 0.5];
    const v = [1, 1, 0.5, 1, 1, 0.5, 1, 1];
    const one = bestOfKTest(control, [v]);
    const eight = bestOfKTest(control, Array.from({ length: 8 }, () => v));
    expect(eight.pAdjusted[0]).toBeCloseTo(one.pAdjusted[0], 12);
    expect(holmAdjust(new Array(8).fill(one.pRaw[0]))[0]).toBeCloseTo(Math.min(1, 8 * one.pRaw[0]), 12);
  });

  it('acima do teto: Monte Carlo com B = 10.000 semeado, reprodutível', () => {
    // 26 cenários com diferenças todas distintas: 2^26 > 2^20 → Monte Carlo.
    const control = Array.from({ length: 26 }, () => 0);
    const variants = [0, 1, 2].map((k) => Array.from({ length: 26 }, (_, i) => ((i * 7 + k * 3) % 11) / 10 - 0.3 + i / 1000));
    const a = bestOfKTest(control, variants);
    const b = bestOfKTest(control, variants);
    expect(a.enumeration).toBe('monte-carlo');
    expect(a.permutations).toBe(10_000);
    expect(a.seed).toBe(1337);
    expect(a.pAdjusted).toEqual(b.pAdjusted);
    // p = (1 + #)/(B + 1): nunca 0.
    for (const p of a.pAdjusted) expect(p).toBeGreaterThanOrEqual(1 / 10_001);
    // Outra seed: mesmo p a menos do erro Monte Carlo.
    const c = bestOfKTest(control, variants, { seed: 42 });
    for (let k = 0; k < 3; k += 1) expect(Math.abs(c.pAdjusted[k] - a.pAdjusted[k])).toBeLessThan(0.02);
  });

  it('forçar Monte Carlo reproduz o exato a menos do erro de amostragem', () => {
    const rng = mulberry32(5);
    const { control, variants } = randomCase(rng, 12, 4, 0);
    const exact = bestOfKTest(control, variants);
    const mc = bestOfKTest(control, variants, { exactCap: 1 });
    expect(exact.enumeration).toBe('exact');
    expect(mc.enumeration).toBe('monte-carlo');
    for (let k = 0; k < 4; k += 1) expect(Math.abs(mc.pAdjusted[k] - exact.pAdjusted[k])).toBeLessThan(0.015);
  });
});

describe('IMPL-002 — Holm (fallback) e minGain default', () => {
  it('holmAdjust: step-down de Bonferroni monotonizado, ordem preservada', () => {
    const adj = holmAdjust([0.01, 0.04, 0.03]);
    expect(adj[0]).toBeCloseTo(0.03, 12);
    expect(adj[1]).toBeCloseTo(0.06, 12);
    expect(adj[2]).toBeCloseTo(0.06, 12);
    expect(holmAdjust([0.2])).toEqual([0.2]);
    expect(holmAdjust([0.6, 0.6])).toEqual([1, 1]);
  });

  it("method 'holm' aplica Holm sobre os p marginais da MESMA distribuição", () => {
    const rng = mulberry32(11);
    const { control, variants } = randomCase(rng, 9, 4, 0);
    const holm = bestOfKTest(control, variants, { method: 'holm' });
    expect(holm.method).toBe('holm');
    const want = holmAdjust(holm.pRaw);
    holm.pAdjusted.forEach((p, k) => expect(p).toBeCloseTo(want[k], 12));
  });

  it('minGain default = max(1 p.p.; 50/n) — meia granularidade', () => {
    expect(defaultMinGain(8)).toBe(6.25);
    expect(defaultMinGain(5)).toBe(10);
    expect(defaultMinGain(50)).toBe(1);
    expect(defaultMinGain(200)).toBe(1);
    expect(defaultMinGain(0)).toBe(1);
    expect(resolveMinGain(undefined, 8)).toEqual({ minGain: 6.25, source: 'default' });
    expect(resolveMinGain(0, 8)).toEqual({ minGain: 0, source: 'config' });
    expect(resolveMinGain(2, 50)).toEqual({ minGain: 2, source: 'config' });
    expect(GATE_ALPHA).toBe(0.05);
  });
});

// --- pickWinner com o gate --------------------------------------------------------

const entry = (id: string, judgeScore: number, isControl = false, promptLen = 10): RankEntry => ({
  id,
  label: id,
  isControl,
  judgeScore,
  errored: 0,
  promptLen: isControl ? 0 : promptLen,
});
const mean = (xs: PairScore[]) => (xs.reduce<number>((a, x) => a + (x ?? 0), 0) / xs.length) * 100;

/** Uma iteração sob H0 no modelo de ruído da N1: K variantes iguais ao controle. */
function h0Iteration(rng: () => number, n: number, K: number, flip: number) {
  const pick = () => {
    const u = rng();
    return u < 0.6 ? 1 : u < 0.85 ? 0.5 : 0;
  };
  const base = Array.from({ length: n }, pick);
  const draw = () => base.map((b) => (rng() < flip ? pick() : b));
  const scoresById: Record<string, number[]> = { original: draw() };
  const entries: RankEntry[] = [entry('original', mean(scoresById.original), true)];
  for (let k = 0; k < K; k += 1) {
    scoresById[`v${k}`] = draw();
    entries.push(entry(`v${k}`, mean(scoresById[`v${k}`]), false, 100 + k));
  }
  return { entries, scoresById };
}

describe('IMPL-002 — pickWinner usa o gate da melhor de K', () => {
  it('K = 8 variantes idênticas sob H0 NÃO promovem (o gate antigo promovia)', () => {
    // Procura, na simulação semeada, uma iteração em que "a melhor de 8" abre
    // ≥ 12,5 p.p. sobre a régua só por acaso — o gate antigo (Δ ≥ 1) promovia.
    const rng = mulberry32(8);
    let achou = false;
    for (let t = 0; t < 200 && !achou; t += 1) {
      const { entries, scoresById } = h0Iteration(rng, 8, 8, 0.3);
      const pick = pickWinner(entries, { scoresById });
      if (pick.gain < 12.5) continue;
      achou = true;
      expect(pickWinner(entries).isWinner, 'o gate legado promoveria').toBe(true);
      expect(pick.isWinner).toBe(false);
      expect(pick.gate?.decision).toBe('held');
      expect(pick.gate?.heldBy).toContain('significance');
      expect(pick.gate?.test?.k).toBe(8);
      expect(pick.gate?.test?.method).toBe('max-t');
      expect(pick.gate?.test?.pAdjusted).toBeGreaterThan(0.05);
      // O corrigido desconta a seleção entre 8.
      expect(pick.gate!.gainCorrectedPp!).toBeLessThan(pick.gate!.gainPp);
    }
    expect(achou).toBe(true);
  });

  it('K = 8 idênticas sob H0 em 400 iterações: promoção falsa ≤ 5,5% (antes > 50%)', () => {
    const rng = mulberry32(80);
    let novo = 0;
    let antigo = 0;
    for (let t = 0; t < 400; t += 1) {
      const { entries, scoresById } = h0Iteration(rng, 8, 8, 0.3);
      if (pickWinner(entries, { scoresById }).isWinner) novo += 1;
      if (pickWinner(entries, { minGain: 1 }).isWinner) antigo += 1;
    }
    expect(novo / 400).toBeLessThanOrEqual(0.055);
    expect(antigo / 400).toBeGreaterThan(0.5);
  });

  it('literalmente idênticas (mesmas respostas): Δ = 0, segura por margem E por teste', () => {
    const same = [1, 0.5, 1, 0, 1, 1, 0.5, 1];
    const scoresById: Record<string, number[]> = { original: same };
    const entries = [entry('original', mean(same), true)];
    for (let k = 0; k < 8; k += 1) {
      scoresById[`v${k}`] = [...same];
      entries.push(entry(`v${k}`, mean(same), false, 100 + k));
    }
    const pick = pickWinner(entries, { scoresById });
    expect(pick.isWinner).toBe(false);
    expect(pick.gate?.heldBy).toEqual(['min-gain', 'significance']);
    expect(pick.gate?.test?.pAdjusted).toBe(1);
  });

  it('efeito real passa: p ajustado ≤ 0,05 com K = 4 e o gate registra tudo', () => {
    const control = Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? 0.5 : 0));
    const scoresById: Record<string, number[]> = {
      original: control,
      forte: control.map((c) => Math.min(1, c + 0.5)),
      v1: control.map((c, i) => (i % 2 ? c : Math.min(1, c + 0.5))),
      v2: control.map((c, i) => (i % 4 === 1 ? 0 : c)),
      v3: [...control],
    };
    const entries = Object.entries(scoresById).map(([id, s]) => entry(id, mean(s), id === 'original'));
    const pick = pickWinner(entries, { scoresById });
    expect(pick.best?.id).toBe('forte');
    expect(pick.isWinner).toBe(true);
    const g = pick.gate!;
    expect(g.decision).toBe('promoted');
    expect(g.heldBy).toBeUndefined();
    expect(g.minGainSource).toBe('default');
    expect(g.minGain).toBeCloseTo(50 / 12, 2);
    expect(g.test).toMatchObject({ method: 'max-t', enumeration: 'exact', k: 4, alpha: 0.05, nScenarios: 12 });
    expect(g.test!.pAdjusted).toBeLessThanOrEqual(0.05);
    expect(g.test!.pAdjusted).toBeGreaterThanOrEqual(g.test!.pRaw);
    expect(Object.keys(g.test!.byContestant).sort()).toEqual(['forte', 'v1', 'v2', 'v3']);
    expect(g.test!.byContestant.forte.gainPp).toBe(g.gainPp);
    expect(g.gainCorrectedPp).toBeLessThanOrEqual(g.gainPp);
    // Evento iteration.promoted: bruto e corrigido lado a lado com o p ajustado.
    expect(promotionEventFields(g)).toEqual({
      gainCorrected: g.gainCorrectedPp,
      pAdjusted: g.test!.pAdjusted,
      k: 4,
      method: 'max-t',
      minGain: g.minGain,
    });
  });

  it("minGain explícito vence o default (source 'config') e 'holm' troca o método", () => {
    const scoresById = { original: [0, 0, 0, 0, 0, 0, 0, 0], v1: [1, 1, 1, 1, 1, 1, 1, 1] };
    const entries = [entry('original', 0, true), entry('v1', 100)];
    const pick = pickWinner(entries, { scoresById, minGain: 2, multiplicity: 'holm' });
    expect(pick.gate).toMatchObject({ minGain: 2, minGainSource: 'config', decision: 'promoted' });
    expect(pick.gate?.test?.method).toBe('holm');
    // K = 1: não há seleção a corrigir.
    expect(pick.gate?.gainCorrectedPp).toBe(pick.gate?.gainPp);
  });

  it('margem default pela granularidade: n = 8 exige 6,25 p.p. mesmo com p pequeno', () => {
    // 8 cenários, Δ = +0,5 em 1 só (6,25 p.p.) seria "margem" suficiente mas
    // p = 0,5; e 1 p.p. (o default antigo) nem é resolúvel com n = 8.
    const control = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    const pick = pickWinner([entry('original', 50, true), entry('v1', 56.25)], {
      scoresById: { original: control, v1: [1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] },
    });
    expect(pick.gate?.minGain).toBe(6.25);
    expect(pick.gate?.heldBy).toEqual(['significance']);
  });

  it('o web recebe o MESMO gate pelo shim (fonte única)', () => {
    expect(webRank.pickWinner).toBe(pickWinner);
    expect(webRank.promotionEventFields).toBe(promotionEventFields);
    expect(webStats.formatIterationGate).toBe(formatIterationGate);
  });
});

describe("IMPL-002 — ganho corrigido do winner's curse", () => {
  it('K = 1: inflação 0 (não há seleção)', () => {
    const r = winnersCurseInflation([0, 0.5, 1, 0.5, 0], [[1, 0.5, 1, 1, 0]]);
    expect(r.inflation).toBe(0);
  });

  it('K > 1: inflação > 0, determinística, exata até o teto e Monte Carlo acima', () => {
    const rng = mulberry32(3);
    const { control, variants } = randomCase(rng, 10, 5, 0);
    const a = winnersCurseInflation(control, variants);
    expect(a.enumeration).toBe('exact');
    expect(a.inflation).toBeGreaterThan(0);
    expect(winnersCurseInflation(control, variants).inflation).toBe(a.inflation);
    const mc = winnersCurseInflation(control, variants, { exactCap: 1 });
    expect(mc.enumeration).toBe('monte-carlo');
    expect(Math.abs(mc.inflation - a.inflation)).toBeLessThan(0.1 * a.inflation + 1e-3);
  });

  it('variantes idênticas entre si: sem ruído próprio, nada a corrigir', () => {
    const control = [0, 0.5, 0, 1, 0.5, 0];
    const v = [1, 1, 0.5, 1, 1, 0.5];
    expect(winnersCurseInflation(control, [v, v, v]).inflation).toBeCloseTo(0, 12);
  });

  it('sob H1 (+10 p.p. em todas) o corrigido tira o viés que o bruto tem', () => {
    // Versão mínima do harness: n = 12, K = 4, 300 iterações semeadas.
    const rng = mulberry32(12);
    const pick = () => {
      const u = rng();
      return u < 0.6 ? 1 : u < 0.85 ? 0.5 : 0;
    };
    const q = 0.1 / 0.275;
    let raw = 0;
    let cor = 0;
    const T = 300;
    for (let t = 0; t < T; t += 1) {
      const base = Array.from({ length: 12 }, pick);
      const draw = (eff: boolean) => base.map((b) => {
        const v = rng() < 0.15 ? pick() : b;
        return eff && rng() < q ? 1 : v;
      });
      const scoresById: Record<string, number[]> = { original: draw(false) };
      const entries = [entry('original', mean(scoresById.original), true)];
      for (let k = 0; k < 4; k += 1) {
        scoresById[`v${k}`] = draw(true);
        entries.push(entry(`v${k}`, mean(scoresById[`v${k}`]), false, 100 + k));
      }
      const g = pickWinner(entries, { scoresById }).gate!;
      raw += g.gainPp - 10;
      cor += g.gainCorrectedPp! - 10;
    }
    expect(raw / T).toBeGreaterThan(4); // winner's curse: o máximo de 4 infla
    expect(Math.abs(cor / T)).toBeLessThan(1.5); // o corrigido fica perto de +10
  });
});

describe('IMPL-002 — relatório (CLI/UI usam os mesmos helpers)', () => {
  it('formatGateSummary: bruto e corrigido lado a lado com o p ajustado', () => {
    expect(
      formatGateSummary({
        gainPp: 18.75,
        gainCorrectedPp: 6.2,
        pAdjusted: 0.031,
        k: 4,
        method: 'max-t',
        enumeration: 'exact',
        minGain: 6.25,
        minGainSource: 'default',
      }),
    ).toBe('ganho bruto +18.8pp (máximo entre 4) · corrigido +6.2pp · p ajustado=0.031 (max-T, exato) · margem 6.25pp (auto)');
    // Evento sem enumeração/fonte (payload do iteration.promoted) e K = 1.
    expect(formatGateSummary({ gainPp: 50, gainCorrectedPp: 50, pAdjusted: 0.0039, k: 1, method: 'max-t', minGain: 1 })).toBe(
      'ganho +50.0pp · p ajustado=0.004 (max-T) · margem 1pp',
    );
    // Gate antigo (sem teste): só o Δ.
    expect(formatGateSummary({ gainPp: 3 })).toBe('ganho +3.0pp');
  });

  it('formatIterationGate: decisão + o que segurou', () => {
    const control = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    const pick = pickWinner([entry('original', 50, true), entry('v1', 56.25)], {
      scoresById: { original: control, v1: [1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] },
    });
    expect(formatIterationGate(pick.gate!)).toBe(
      'mantida a régua: ganho +6.3pp · p ajustado=0.500 (max-T, exato) · margem 6.25pp (auto) — segurou: p ajustado > 0.05',
    );
  });
});

// --- record, CLI e NDJSON ------------------------------------------------------------

async function capturar(fn: () => unknown): Promise<string> {
  const chunks: string[] = [];
  const spyOut = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
    return true;
  });
  const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await fn();
    return chunks.join('');
  } finally {
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
}

describe('IMPL-002 — session record, `sessions show` e NDJSON', () => {
  let dir: string;
  let anterior: string;
  let homeAnterior: string | undefined;
  const cli = (argv: string[]): string[] => [...argv, '--data-dir', dir];
  beforeAll(() => {
    anterior = getDataDir();
    homeAnterior = process.env.PROMPT_BUILDER_HOME;
    dir = mkdtempSync(join(tmpdir(), 'pb-impl002-'));
    process.env.PROMPT_BUILDER_HOME = dir;
    setDataDir(dir);
  });
  afterAll(() => {
    if (homeAnterior === undefined) delete process.env.PROMPT_BUILDER_HOME;
    else process.env.PROMPT_BUILDER_HOME = homeAnterior;
    setDataDir(anterior);
    rmSync(dir, { recursive: true, force: true });
  });

  function gateReal() {
    const control = Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? 0.5 : 0));
    const scoresById: Record<string, number[]> = {
      original: control,
      forte: control.map((c) => Math.min(1, c + 0.5)),
      v1: control.map((c, i) => (i % 2 ? c : Math.min(1, c + 0.5))),
    };
    const entries = Object.entries(scoresById).map(([id, sc]) => entry(id, mean(sc), id === 'original'));
    return pickWinner(entries, { scoresById }).gate!;
  }

  it('o gate (teste, corrigido, margem) sobrevive ao disco e aparece em `sessions show`', async () => {
    const gate = gateReal();
    const sessao: SessionRecord = {
      id: 'sessao-impl002',
      status: 'finished',
      config: { mode: 'training', theme: 't', stages: 12, datagenModelId: 'g', judgeModelIds: ['j'], contestantModelId: 'a', iterations: 1 },
      runIds: ['r0'],
      bestPromptByIteration: [
        { iteration: 0, runId: 'r0', winnerContestantId: 'forte', systemPrompt: 'p', score: 0, gate },
      ],
      totalCostUsd: 0,
      startedAt: '2026-09-27T00:00:00.000Z',
    };
    await saveSession(sessao);
    const relido = await loadSession(sessao.id);
    expect(relido?.bestPromptByIteration[0].gate).toEqual(gate);
    const stdout = await capturar(() => cmdSessions(cli(['show', sessao.id, '--output-format', 'text'])));
    expect(stdout).toContain(`iteração 1: ${formatIterationGate(gate)}`);
    expect(stdout).toContain('ganho bruto +50.0pp (máximo entre 2)');
    expect(stdout).toContain('p ajustado');
  });

  it('NDJSON de `iteration.promoted` leva bruto, corrigido, p ajustado, K, método e margem', async () => {
    const gate = gateReal();
    const out = new Output({ format: 'ndjson' });
    const stdout = await capturar(() =>
      emitSessionEventNdjson(out, {
        type: 'iteration.promoted',
        sessionId: 's1',
        iteration: 0,
        championId: 'forte',
        gain: gate.gainPp,
        ...promotionEventFields(gate),
      }),
    );
    const ev = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(ev).toMatchObject({
      type: 'iteration.promoted',
      gain: gate.gainPp,
      gainCorrected: gate.gainCorrectedPp,
      pAdjusted: gate.test!.pAdjusted,
      k: 2,
      method: 'max-t',
      minGain: gate.minGain,
    });
  });
});

describe('IMPL-002 — o default chega ao motor (arquivo de config sem minGain)', () => {
  const arquivo = (training: Record<string, unknown>) => ({
    format: 'arena-config@1',
    mode: 'training',
    theme: 'suporte',
    stages: 8,
    prompt: { text: 'Você é um assistente de suporte.' },
    models: {
      datagen: 'openai/gpt-5-mini',
      judges: ['anthropic/claude-sonnet-5'],
      contestant: 'openai/gpt-5-mini',
      // IMPL-048: obrigatório em training (papéis separados — distinto de juiz e competidor).
      reference: 'openai/gpt-5-nano',
    },
    variation: { optimize: true, techniques: ['persona', 'constraints'] },
    training,
  });

  it('sem `training.minGain`: o RunConfig NÃO crava 1 (o gate aplica max(1; 50/n))', () => {
    const parsed = parseArenaConfig(arquivo({ iterations: 3 }));
    expect(parsed.ok ? 'ok' : parsed.error).toBe('ok');
    if (!parsed.ok) return;
    const conv = arenaConfigToRunConfig(parsed.config);
    expect(conv.ok ? 'ok' : conv.error).toBe('ok');
    if (!conv.ok || conv.config.mode !== 'training') throw new Error('esperava training');
    expect(conv.config.minGain).toBeUndefined();
  });

  it('com `training.minGain`: vale o explícito (clamp 0–100)', () => {
    const parsed = parseArenaConfig(arquivo({ iterations: 3, minGain: 3 }));
    if (!parsed.ok) throw new Error(parsed.error);
    const conv = arenaConfigToRunConfig(parsed.config);
    if (!conv.ok || conv.config.mode !== 'training') throw new Error('esperava training');
    expect(conv.config.minGain).toBe(3);
  });
});
