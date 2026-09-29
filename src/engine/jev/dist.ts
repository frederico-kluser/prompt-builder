// Modo JEV — a DISTRIBUIÇÃO de uma resposta (por pergunta), em rótulos
// CANÔNICOS: é sobre ela que acurácia, Brier, log-loss, ECE e bandas são
// calculados, e é ela que a temperatura pós-hoc transforma.
//
//   noul   → P(sim)                         (sem `confidence` no fio)
//   choice → p por rótulo canônico (ordem do fio, `keyMap` aplicado) + confidence
//   score  → p por nível 0..L−1 + E[ŝ] + confidence
//
// O `confidence` da API é OPACO (≠ p da escolha: 0,63 → 0,45 ao vivo): só
// decide a banda. Calibração usa a probabilidade da classe PREVISTA.
//
// PREVISTO = resposta DECLARADA (`pick`): o `choice` da API, o `answer`/`level`
// do LLM. As probabilidades do fio vêm em 2 casas (`{a: 0.5, b: 0.5}` com
// `choice: "b"` acontece) e as do LLM são verbalizadas — o argmax delas NÃO é a
// resposta. Sem `pick` (noul do Jev; score do Jev), o previsto é p ≥ 0,5 / o
// nível argmax.

import type { JevExpected, JevQuestionSpec, JevWireAnswer } from './types.js';
import { canonicalLabel, canonicalLabelsOf, levelCountOf, wireKeysOf } from './wire.js';

/** ε do log-loss e da temperatura: o fio arredonda em 2 casas (0 e 1 exatos aparecem). */
export const PROB_EPS = 1e-3;

export type Dist =
  | { type: 'noul'; pYes: number; pick?: boolean }
  | { type: 'choice'; labels: string[]; probs: number[]; confidence?: number; pick?: string }
  | { type: 'score'; probs: number[]; expectation: number; confidence?: number; pick?: number };

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

function normalize(ps: number[]): number[] {
  const s = ps.reduce((a, b) => a + b, 0);
  if (!(s > 0)) return ps.map(() => 1 / Math.max(1, ps.length));
  return ps.map((p) => p / s);
}

const argmaxOf = (ps: readonly number[]): number => {
  let best = 0;
  for (let i = 1; i < ps.length; i++) if (ps[i] > ps[best] + 1e-12) best = i;
  return best;
};

/** Resposta do fio (validada) → distribuição canônica. Sem probabilidades = one-hot. */
export function distFromAnswer(q: JevQuestionSpec, a: JevWireAnswer): Dist {
  if (q.type === 'noul' && a.type === 'noul') {
    return { type: 'noul', pYes: clamp01(a.noul), ...(typeof a.answer === 'boolean' ? { pick: a.answer } : {}) };
  }
  if (q.type === 'choice' && a.type === 'choice') {
    const keys = wireKeysOf(q);
    const labels = keys.map((k) => canonicalLabel(q, k));
    let probs = keys.map((k) => clamp01(a.probabilities?.[k] ?? 0));
    if (!a.probabilities || !(probs.reduce((s, x) => s + x, 0) > 0)) {
      probs = keys.map((k) => (k === a.choice ? 1 : 0));
    }
    return {
      type: 'choice',
      labels,
      probs: normalize(probs),
      ...(typeof a.confidence === 'number' ? { confidence: a.confidence } : {}),
      ...(keys.includes(a.choice) ? { pick: canonicalLabel(q, a.choice) } : {}),
    };
  }
  if (q.type === 'score' && a.type === 'score') {
    const L = levelCountOf(q);
    let probs = Array.from({ length: L }, (_, i) => clamp01(a.probabilities?.[String(i)] ?? 0));
    if (!a.probabilities || !(probs.reduce((s, x) => s + x, 0) > 0)) {
      const alvo = Math.min(L - 1, Math.max(0, Math.round(a.score)));
      probs = Array.from({ length: L }, (_, i) => (i === alvo ? 1 : 0));
    }
    probs = normalize(probs);
    const nivel = a.level;
    return {
      type: 'score',
      probs,
      expectation: Number.isFinite(a.score) ? a.score : probs.reduce((s, p, l) => s + l * p, 0),
      ...(typeof a.confidence === 'number' ? { confidence: a.confidence } : {}),
      ...(typeof nivel === 'number' && Number.isInteger(nivel) && nivel >= 0 && nivel < L ? { pick: nivel } : {}),
    };
  }
  return uniformDist(q);
}

/** Distribuição uniforme (resposta fora do contrato: conta errada, sem opinião). */
export function uniformDist(q: JevQuestionSpec): Dist {
  if (q.type === 'noul') return { type: 'noul', pYes: 0.5 };
  if (q.type === 'choice') {
    const labels = canonicalLabelsOf(q);
    return { type: 'choice', labels, probs: labels.map(() => 1 / Math.max(1, labels.length)) };
  }
  const L = Math.max(1, levelCountOf(q));
  const probs = Array.from({ length: L }, () => 1 / L);
  return { type: 'score', probs, expectation: (L - 1) / 2 };
}

/**
 * Resposta declarada das repetições: a mais votada; empate desempata pela
 * probabilidade MÉDIA da opção (depois, a ordem de chegada). Alguma rep sem
 * `pick` = sem pick agregado (o previsto cai na regra das probabilidades).
 */
function majorityPick<T extends string | number | boolean>(picks: readonly (T | undefined)[], probOf: (p: T) => number): T | undefined {
  if (!picks.length || picks.some((p) => p === undefined)) return undefined;
  const votos = new Map<T, number>();
  for (const p of picks as T[]) votos.set(p, (votos.get(p) ?? 0) + 1);
  let best: T | undefined;
  for (const [p, n] of votos) {
    if (best === undefined) {
      best = p;
      continue;
    }
    const nb = votos.get(best) ?? 0;
    if (n > nb || (n === nb && probOf(p) > probOf(best) + 1e-12)) best = p;
  }
  return best;
}

/** Média das distribuições das repetições (confiança média só se todas têm). */
export function averageDists(dists: readonly Dist[]): Dist {
  const first = dists[0];
  if (dists.length === 1) return first;
  const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
  if (first.type === 'noul') {
    const pYes = mean(dists.map((d) => (d as { pYes: number }).pYes));
    const pick = majorityPick(
      dists.map((d) => (d as { pick?: boolean }).pick),
      (p) => (p ? pYes : 1 - pYes),
    );
    return { type: 'noul', pYes, ...(pick !== undefined ? { pick } : {}) };
  }
  const confs = dists.map((d) => (d as { confidence?: number }).confidence);
  const conf = confs.every((c) => typeof c === 'number') ? mean(confs as number[]) : undefined;
  const K = (first as { probs: number[] }).probs.length;
  const probs = Array.from({ length: K }, (_, k) => mean(dists.map((d) => (d as { probs: number[] }).probs[k] ?? 0)));
  if (first.type === 'choice') {
    const pick = majorityPick(
      dists.map((d) => (d as { pick?: string }).pick),
      (l) => probs[first.labels.indexOf(l)] ?? 0,
    );
    return { type: 'choice', labels: first.labels, probs, ...(conf !== undefined ? { confidence: conf } : {}), ...(pick !== undefined ? { pick } : {}) };
  }
  const pick = majorityPick(
    dists.map((d) => (d as { pick?: number }).pick),
    (l) => probs[l] ?? 0,
  );
  return {
    type: 'score',
    probs,
    expectation: mean(dists.map((d) => (d as { expectation: number }).expectation)),
    ...(conf !== undefined ? { confidence: conf } : {}),
    ...(pick !== undefined ? { pick } : {}),
  };
}

/**
 * Rótulo previsto = a resposta DECLARADA (`pick`). Sem ela: noul p ≥ 0,5;
 * choice/score argmax (empate = a 1ª opção na ordem do fio).
 */
export function predictedOf(d: Dist): JevExpected {
  if (d.type === 'noul') return d.pick ?? d.pYes >= 0.5;
  if (d.type === 'choice') return d.pick ?? d.labels[argmaxOf(d.probs)] ?? '';
  return d.pick ?? argmaxOf(d.probs);
}

/**
 * Probabilidade atribuída à classe PREVISTA (ECE top-label, sinal `certainty`).
 * Sem `pick` é o máximo; com ele, a p da resposta declarada — um LLM que diz
 * "sim" com p_yes 0,3 tem certeza 0,3 (e abstém), não 0,7.
 */
export function pTopOf(d: Dist): number {
  const pred = predictedOf(d);
  if (d.type === 'noul') return pred === true ? d.pYes : 1 - d.pYes;
  if (d.type === 'choice') {
    const i = d.labels.indexOf(pred as string);
    return i >= 0 ? (d.probs[i] ?? 0) : d.probs.length ? Math.max(...d.probs) : 0;
  }
  return d.probs[pred as number] ?? (d.probs.length ? Math.max(...d.probs) : 0);
}

/** Probabilidade somada das alternativas aceitas no ouro. */
export function pTrueOf(d: Dist, expected: readonly JevExpected[]): number {
  if (d.type === 'noul') {
    let p = 0;
    if (expected.includes(true)) p += d.pYes;
    if (expected.includes(false)) p += 1 - d.pYes;
    return clamp01(p);
  }
  if (d.type === 'choice') {
    let p = 0;
    d.labels.forEach((l, i) => {
      if (expected.includes(l)) p += d.probs[i];
    });
    return clamp01(p);
  }
  let p = 0;
  d.probs.forEach((x, l) => {
    if (expected.includes(l)) p += x;
  });
  return clamp01(p);
}

/**
 * Temperatura pós-hoc (J13). noul: σ(logit(p̃)/T); choice/score:
 * p_k(T) ∝ p̃_k^{1/T}, com p̃ = (p + ε)/(1 + Kε). T muda Brier/log-loss/ECE,
 * NÃO muda o argmax nem a ordenação (logo nem a AURC) e preserva a resposta
 * declarada (`pick`). O `confidence` opaco não é tocado (a banda por
 * `confidence` não se recalibra).
 */
export function applyTemperature(d: Dist, T: number | undefined): Dist {
  if (T === undefined || !Number.isFinite(T) || T <= 0 || Math.abs(T - 1) < 1e-12) return d;
  if (d.type === 'noul') {
    const p = (d.pYes + PROB_EPS) / (1 + 2 * PROB_EPS);
    const logit = Math.log(p / (1 - p)) / T;
    return { type: 'noul', pYes: 1 / (1 + Math.exp(-logit)), ...(d.pick !== undefined ? { pick: d.pick } : {}) };
  }
  const K = d.probs.length;
  const logs = d.probs.map((p) => Math.log((p + PROB_EPS) / (1 + K * PROB_EPS)) / T);
  const m = Math.max(...logs);
  const probs = normalize(logs.map((x) => Math.exp(x - m)));
  if (d.type === 'choice') return { ...d, probs };
  return { ...d, probs, expectation: probs.reduce((s, p, l) => s + l * p, 0) };
}
