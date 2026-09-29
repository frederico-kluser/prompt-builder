// Modo JEV — calibração pós-hoc (J13): temperatura por pergunta + limiares das
// bandas para uma precisão-alvo. É POLÍTICA (código), não reescrita da
// definição: ajustada SÓ no split `calib`, reportada no resto, com o resultado
// cru ao lado. Determinístico (busca áurea com iterações fixas).
//
// Sinal oposto por tipo (sondas + material do dono): `choice`/`score` saem
// superconfiantes (T > 1 achata), `noul` subconfiante (T < 1 afia).

import type { JevExpected, JevQuestionPolicy, JevQuestionSpec } from './types.js';
import { applyTemperature, pTrueOf, type Dist } from './dist.js';
import { bandFor, logLossOf, signalOf } from './scoring.js';

export const TEMPERATURE_RANGE = { min: 0.2, max: 10 } as const;
const GOLDEN_ITERATIONS = 40;
/** Pontos mínimos para ajustar (abaixo disso: T = 1 e limiares default). */
export const MIN_FIT_POINTS = 20;
/** Auto só com pelo menos isto de casos acima do limiar (senão a precisão é ruído). */
export const MIN_AUTO_SUPPORT = 5;
/** `auto > 1` = banda auto DESLIGADA: nenhum limiar atinge a precisão-alvo. */
export const AUTO_OFF = 1.01;

export interface FitPoint {
  dist: Dist;
  expected: JevExpected[];
  correct: boolean;
  invalid?: boolean;
}

function nll(points: readonly FitPoint[], T: number): number {
  let s = 0;
  for (const p of points) s += logLossOf(pTrueOf(applyTemperature(p.dist, T), p.expected));
  return s / points.length;
}

/**
 * T que minimiza a NLL em `ln T ∈ [ln 0,2, ln 10]` (busca áurea, 40 iterações).
 * Respostas fora do contrato (uniformes) ficam de fora: não há o que calibrar.
 */
export function fitTemperature(points: readonly FitPoint[]): number {
  const pts = points.filter((p) => !p.invalid);
  if (pts.length === 0) return 1;
  let a = Math.log(TEMPERATURE_RANGE.min);
  let b = Math.log(TEMPERATURE_RANGE.max);
  const phi = (Math.sqrt(5) - 1) / 2;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = nll(pts, Math.exp(c));
  let fd = nll(pts, Math.exp(d));
  for (let i = 0; i < GOLDEN_ITERATIONS; i++) {
    if (fc <= fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - phi * (b - a);
      fc = nll(pts, Math.exp(c));
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + phi * (b - a);
      fd = nll(pts, Math.exp(d));
    }
  }
  const T = Math.exp((a + b) / 2);
  // Ganho desprezível sobre T = 1: fica 1 (sem mexer à toa).
  return nll(pts, T) < nll(pts, 1) - 1e-9 ? Number(T.toFixed(4)) : 1;
}

/**
 * Menor limiar t com precisão(sinal ≥ t) ≥ alvo — a MAIOR cobertura auto que
 * respeita a precisão-alvo — com suporte mínimo. Sem nenhum: `AUTO_OFF`.
 * O hitl fica o default do tipo (nunca acima do auto).
 */
export function fitThresholds(
  points: readonly { signal: number; correct: boolean }[],
  targetPrecision: number,
  defaultHitl: number,
): { auto: number; hitl: number; coverage: number; precision: number | null } {
  const s = [...points].sort((x, y) => y.signal - x.signal);
  let best: { t: number; cov: number; prec: number } | null = null;
  let acertos = 0;
  for (let i = 0; i < s.length; i++) {
    acertos += s[i].correct ? 1 : 0;
    // só fecha grupo no fim de uma sequência de empates
    if (i + 1 < s.length && s[i + 1].signal === s[i].signal) continue;
    const n = i + 1;
    const prec = acertos / n;
    if (n >= MIN_AUTO_SUPPORT && prec >= targetPrecision - 1e-12) best = { t: s[i].signal, cov: n / s.length, prec };
  }
  if (!best) return { auto: AUTO_OFF, hitl: Math.min(defaultHitl, 1), coverage: 0, precision: null };
  return { auto: best.t, hitl: Math.min(defaultHitl, best.t), coverage: best.cov, precision: best.prec };
}

/**
 * Limiar arredondado para CIMA em 4 casas. Arredondar para baixo (o antigo
 * `toFixed(4)`) admitia na banda auto pontos logo ABAIXO do corte ajustado —
 * com sinal contínuo (temperatura) isso fura a precisão-alvo. Para cima, o
 * pior efeito é deixar de fora o próprio ponto do corte (mais conservador).
 * O `−1e-9` (em unidades de 1e-4) só absorve o ruído de ponto flutuante de
 * `x·1e4` — um corte já com 4 casas (0,9; 0,85) não sobe um degrau.
 */
export function ceilThreshold(x: number): number {
  return Math.ceil(x * 1e4 - 1e-9) / 1e4;
}

/**
 * Política ajustada de UMA pergunta: T (NLL) e, com o sinal calibrado, o
 * limiar auto para a precisão-alvo. Com menos de `MIN_FIT_POINTS`: devolve a
 * base (T = 1) marcada como não ajustada.
 */
export function fitQuestionPolicy(
  _q: JevQuestionSpec,
  base: JevQuestionPolicy,
  points: readonly FitPoint[],
  opts: { targetPrecision: number; split: 'calib' | 'train'; resolvedModel?: string },
): JevQuestionPolicy & { fitted: boolean } {
  if (points.filter((p) => !p.invalid).length < MIN_FIT_POINTS) return { ...base, fitted: false };
  const T = fitTemperature(points);
  const pol: JevQuestionPolicy = { ...base, temperature: T };
  const sinais = points.map((p) => ({
    signal: p.invalid ? 0 : signalOf(applyTemperature(p.dist, T), pol),
    correct: p.correct,
  }));
  const th = fitThresholds(sinais, opts.targetPrecision, base.hitl);
  return {
    ...pol,
    auto: ceilThreshold(th.auto),
    hitl: ceilThreshold(th.hitl),
    fittedOn: {
      split: opts.split,
      n: points.length,
      ...(opts.resolvedModel ? { resolvedModel: opts.resolvedModel } : {}),
      targetPrecision: opts.targetPrecision,
    },
    fitted: true,
  };
}

/** Banda de um ponto sob uma política (útil a relatórios/UI). */
export function bandUnder(p: FitPoint, pol: JevQuestionPolicy): 'auto' | 'hitl' | 'abstain' {
  if (p.invalid) return 'abstain';
  return bandFor(signalOf(applyTemperature(p.dist, pol.temperature), pol), pol);
}
