// Modo JEV — pontuação e métricas (§8 do desenho). Tudo PURO e determinístico:
// a nota é grátis, então "competidor + nota" é atômico por construção (toda
// célula respondida é pontuada no fim da run).
//
// Escopo das métricas de uma pergunta q e um competidor c:
//   - ENTRAM: casos com ouro para q e célula ok/invalid em TODAS as reps;
//   - SAEM: casos incompletos (orçamento/cancelamento — de todos os
//     competidores) e casos com alguma rep error/blocked (SEM NOTA, dos dois lados);
//   - repetições: distribuições promediadas ANTES; o caso é pontuado uma vez;
//   - resposta fora do contrato em qualquer rep: ERRADA e no PIOR CASO das
//     métricas probabilísticas (Brier 1, pTrue 0, log-loss −ln ε) — a MESMA
//     regra no placar, no teste pareado da comparação e no gate do treino.
//     Com p uniforme ela sairia MELHOR que um erro confiante (1−Brier 0,75
//     numa noul) e premiaria quem quebra o contrato de resposta.
//
// Estatística (crítica A2): valores na escala 0–1 para `pairedSignificance`
// (que multiplica por 100), vetores JÁ agregados por caso e alinhados por
// `caseId` (sem `repeatsPerScenario`, sem `pairKeys` posicional) e McNemar
// BILATERAL (`pValueTwoSided`).

import { exactSignTest, pairedSignificance } from '../../stats.js';
import type {
  JevBandDefaults,
  JevBin,
  JevCalibratedMetrics,
  JevCascade,
  JevCascadePoint,
  JevCase,
  JevCell,
  JevComparison,
  JevContestant,
  JevExpected,
  JevMetrics,
  JevMetricsHeadline,
  JevPrimitive,
  JevQuestionPolicy,
  JevQuestionSpec,
  JevScoredAnswer,
  JevSpec,
} from './types.js';
import {
  PROB_EPS,
  applyTemperature,
  averageDists,
  distFromAnswer,
  predictedOf,
  pTopOf,
  pTrueOf,
  uniformDist,
  type Dist,
} from './dist.js';
import { expectedList } from './wire.js';

export const DEFAULT_SCORE_TOLERANCE = 0.5;
/**
 * Bandas por TIPO (D-9): `choice`/`score` sobre o `confidence` da API;
 * `noul` sobre a certeza max(p,1−p) com hitl 0,60 — com 0,50 uma noul NUNCA
 * abstém (a certeza é sempre ≥ 0,5). O desvio do simulador/skill (0,50) é
 * declarado no relatório e configurável.
 */
export const DEFAULT_BANDS: JevBandDefaults = {
  noul: { auto: 0.9, hitl: 0.6 },
  choice: { auto: 0.9, hitl: 0.5 },
  score: { auto: 0.9, hitl: 0.5 },
};
export const DEFAULT_TARGET_PRECISION = 0.95;
/** Run inconclusiva: células sem nota acima disto (IMPL-004, exit 6). */
export const INCONCLUSIVE_NO_SCORE_RATIO = 0.1;
/** …ou menos que isto de pontuados numa pergunta com ouro. */
export const MIN_SCORED_PER_QUESTION = 5;

// ---------------------------------------------------------------------------
// Política
// ---------------------------------------------------------------------------

export function defaultPolicyFor(q: Pick<JevQuestionSpec, 'type'>, bands: JevBandDefaults = DEFAULT_BANDS): JevQuestionPolicy {
  const b = bands[q.type] ?? DEFAULT_BANDS[q.type];
  return { auto: b.auto, hitl: b.hitl, signal: q.type === 'noul' ? 'certainty' : 'confidence' };
}

/** Default do tipo ← política da spec ← política ajustada (fit). */
export function policyFor(
  spec: Pick<JevSpec, 'policy'>,
  q: JevQuestionSpec,
  bands: JevBandDefaults = DEFAULT_BANDS,
  fitted?: JevQuestionPolicy,
): JevQuestionPolicy {
  return { ...defaultPolicyFor(q, bands), ...(spec.policy?.questions?.[q.id] ?? {}), ...(fitted ?? {}) };
}

export function bandFor(signal: number, policy: Pick<JevQuestionPolicy, 'auto' | 'hitl'>): JevScoredAnswer['band'] {
  if (signal >= policy.auto) return 'auto';
  if (signal >= policy.hitl) return 'hitl';
  return 'abstain';
}

/** O número que decide a banda. `confidence` ausente → pTop. */
export function signalOf(d: Dist, policy: Pick<JevQuestionPolicy, 'signal'>): number {
  if (policy.signal === 'certainty' || policy.signal === 'pTop') return pTopOf(d);
  if (d.type === 'noul') return pTopOf(d);
  return typeof d.confidence === 'number' ? d.confidence : pTopOf(d);
}

// ---------------------------------------------------------------------------
// Regras por primitiva
// ---------------------------------------------------------------------------

/** Brier normalizado 0..1 para UM rótulo-alvo (`null` = pergunta degenerada). */
function brierFor(d: Dist, y: JevExpected): number | null {
  if (d.type === 'noul') {
    const t = y === true ? 1 : 0;
    return (d.pYes - t) ** 2;
  }
  if (d.type === 'choice') {
    if (d.labels.length < 2) return null;
    let s = 0;
    d.labels.forEach((l, k) => {
      s += (d.probs[k] - (l === y ? 1 : 0)) ** 2;
    });
    return s / 2;
  }
  const L = d.probs.length;
  if (L < 2 || typeof y !== 'number') return null;
  // RPS: (1/(L−1)) Σ_{j=0}^{L−2} (F_j − 1[y ≤ j])²
  let F = 0;
  let s = 0;
  for (let j = 0; j <= L - 2; j++) {
    F += d.probs[j];
    s += (F - (y <= j ? 1 : 0)) ** 2;
  }
  return s / (L - 1);
}

/** Melhor Brier entre as alternativas aceitas. */
function brierOf(d: Dist, expected: readonly JevExpected[]): number | null {
  let best: number | null = null;
  for (const y of expected) {
    const b = brierFor(d, y);
    if (b !== null && (best === null || b < best)) best = b;
  }
  return best;
}

export function logLossOf(pTrue: number): number {
  return -Math.log(Math.max(PROB_EPS, Math.min(1, pTrue)));
}

/**
 * Resposta fora do contrato: Brier de PIOR caso (1; `null` segue `null` na
 * pergunta degenerada), pTrue 0 e o log-loss máximo (−ln ε). Uma regra só
 * para `scoreDist` — e por ela para o placar, a comparação e o gate.
 */
function worstCaseOf(brier: number | null): { brier: number | null; pTrue: number; logLoss: number } {
  return { brier: brier === null ? null : 1, pTrue: 0, logLoss: logLossOf(0) };
}

export interface ScoreOptions {
  tolerance?: number;
  invalid?: boolean;
  flipped?: boolean;
  /** Política ajustada (T + limiares): preenche `calibrated`. */
  calibratedPolicy?: JevQuestionPolicy;
}

/** Pontua UMA pergunta de UM caso (reps já agregadas em `d`). */
export function scoreDist(
  q: JevQuestionSpec,
  caseId: string,
  d: Dist,
  expectedRaw: JevExpected | JevExpected[],
  policy: JevQuestionPolicy,
  opts: ScoreOptions = {},
): JevScoredAnswer {
  const expected = expectedList(expectedRaw);
  const tol = opts.tolerance ?? DEFAULT_SCORE_TOLERANCE;
  const predicted = predictedOf(d);
  const pior = opts.invalid ? worstCaseOf(brierOf(d, expected)) : null;
  const pTrue = pior ? pior.pTrue : pTrueOf(d, expected);
  const pTop = pTopOf(d);
  const topCorrect = !opts.invalid && expected.includes(predicted);
  let correct = topCorrect;
  let absError: number | undefined;
  if (d.type === 'score') {
    const nums = expected.filter((y): y is number => typeof y === 'number');
    absError = nums.length ? Math.min(...nums.map((y) => Math.abs(d.expectation - y))) : undefined;
    correct = !opts.invalid && absError !== undefined && absError <= tol + 1e-9;
  }
  const signal = signalOf(d, policy);
  const out: JevScoredAnswer = {
    qid: q.id,
    caseId,
    type: q.type,
    predicted: opts.invalid ? null : predicted,
    correct,
    pTrue,
    pTop,
    topCorrect,
    signal,
    // Fora do contrato nunca fica em "auto": abstém.
    band: opts.invalid ? 'abstain' : bandFor(signal, policy),
    brier: pior ? pior.brier : brierOf(d, expected),
    logLoss: pior ? pior.logLoss : logLossOf(pTrue),
    ...(absError !== undefined ? { absError } : {}),
    ...(opts.invalid ? { invalid: true } : {}),
    ...(opts.flipped ? { flipped: true } : {}),
  };
  const cal = opts.calibratedPolicy;
  if (cal) {
    const dc = applyTemperature(d, cal.temperature);
    const cpior = opts.invalid ? worstCaseOf(brierOf(dc, expected)) : null;
    const pT = cpior ? cpior.pTrue : pTrueOf(dc, expected);
    const sig = signalOf(dc, cal);
    out.calibrated = {
      pTrue: pT,
      pTop: pTopOf(dc),
      brier: cpior ? cpior.brier : brierOf(dc, expected),
      logLoss: cpior ? cpior.logLoss : logLossOf(pT),
      signal: sig,
      band: opts.invalid ? 'abstain' : bandFor(sig, cal),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Agregação por caso (reps)
// ---------------------------------------------------------------------------

export interface CaseQuestionOutcome {
  /** `null` = sem nota (error/blocked/skipped em alguma rep, ou sem ouro). */
  dist: Dist | null;
  invalid: boolean;
  flipped: boolean;
}

/**
 * Reps de (caso, competidor) → distribuição por pergunta. Qualquer rep sem
 * resposta (error/blocked/skipped) = SEM NOTA para o caso inteiro; qualquer rep
 * fora do contrato numa pergunta = aquela pergunta INVÁLIDA (dist uniforme só
 * como marcador; `scoreDist` a pontua errada e no pior caso).
 */
export function aggregateReps(q: JevQuestionSpec, reps: readonly JevCell[]): CaseQuestionOutcome {
  if (reps.length === 0) return { dist: null, invalid: false, flipped: false };
  const dists: Dist[] = [];
  let invalid = false;
  for (const c of reps) {
    if (c.status !== 'ok' && c.status !== 'invalid') return { dist: null, invalid: false, flipped: false };
    const a = c.answers?.[q.id];
    if (c.status === 'invalid' || c.invalid?.[q.id] || !a) {
      invalid = true;
      continue;
    }
    dists.push(distFromAnswer(q, a));
  }
  if (invalid) return { dist: uniformDist(q), invalid: true, flipped: false };
  const preds = new Set(dists.map((d) => JSON.stringify(predictedOf(d))));
  return { dist: averageDists(dists), invalid: false, flipped: preds.size > 1 };
}

// ---------------------------------------------------------------------------
// Estatísticas auxiliares
// ---------------------------------------------------------------------------

/** Percentil nearest-rank (p em 0..100). */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

/** ECE top-label, 10 bins de MESMA LARGURA (pTop × topCorrect — NUNCA o `confidence` opaco). */
export function eceEqualWidth(points: readonly { conf: number; hit: boolean }[], nBins = 10): { ece: number; bins: JevBin[] } {
  const bins: JevBin[] = Array.from({ length: nBins }, (_, b) => ({ lo: b / nBins, hi: (b + 1) / nBins, n: 0, acc: 0, conf: 0 }));
  for (const p of points) {
    const b = Math.min(nBins - 1, Math.max(0, Math.floor(p.conf * nBins)));
    bins[b].n += 1;
    bins[b].acc += p.hit ? 1 : 0;
    bins[b].conf += p.conf;
  }
  let ece = 0;
  const n = points.length;
  for (const b of bins) {
    if (b.n > 0) {
      b.acc /= b.n;
      b.conf /= b.n;
      ece += (b.n / n) * Math.abs(b.acc - b.conf);
    }
  }
  return { ece: n ? ece : 0, bins };
}

/** ECE adaptativo: 10 bins de MESMA MASSA em ordem de pTop (o Jev aglomera em 0,99/1,00). */
export function eceEqualMass(points: readonly { conf: number; hit: boolean }[], nBins = 10): number {
  const n = points.length;
  if (!n) return 0;
  const s = [...points].sort((a, b) => a.conf - b.conf);
  let ece = 0;
  for (let b = 0; b < nBins; b++) {
    const lo = Math.floor((b * n) / nBins);
    const hi = Math.floor(((b + 1) * n) / nBins);
    if (hi <= lo) continue;
    let acc = 0;
    let conf = 0;
    for (let i = lo; i < hi; i++) {
      acc += s[i].hit ? 1 : 0;
      conf += s[i].conf;
    }
    const m = hi - lo;
    ece += (m / n) * Math.abs(acc / m - conf / m);
  }
  return ece;
}

/** AURC: ordena por sinal decrescente; média do risco acumulado. */
export function aurc(points: readonly { signal: number; correct: boolean; key: string }[]): number {
  if (!points.length) return 0;
  const s = [...points].sort((a, b) => b.signal - a.signal || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let erros = 0;
  let soma = 0;
  s.forEach((p, i) => {
    if (!p.correct) erros += 1;
    soma += erros / (i + 1);
  });
  return soma / s.length;
}

/** AUROC (Mann-Whitney) do sinal → acerto; `null` sem as duas classes. */
export function auroc(points: readonly { signal: number; correct: boolean }[]): number | null {
  const pos = points.filter((p) => p.correct).map((p) => p.signal);
  const neg = points.filter((p) => !p.correct).map((p) => p.signal);
  if (!pos.length || !neg.length) return null;
  const all = [...pos.map((s) => ({ s, pos: true })), ...neg.map((s) => ({ s, pos: false }))].sort((a, b) => a.s - b.s);
  // postos médios com empate
  let i = 0;
  let somaPostosPos = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].s === all[i].s) j++;
    const posto = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) if (all[k].pos) somaPostosPos += posto;
    i = j + 1;
  }
  const u = somaPostosPos - (pos.length * (pos.length + 1)) / 2;
  return u / (pos.length * neg.length);
}

/** Macro-F1 de UMA pergunta (noul/choice). Saída prevista `null` (inválida) conta como FN. */
export function macroF1(items: readonly JevScoredAnswer[], goldOf: (it: JevScoredAnswer) => string): number | undefined {
  if (!items.length) return undefined;
  const tp = new Map<string, number>();
  const fp = new Map<string, number>();
  const fn = new Map<string, number>();
  const inc = (m: Map<string, number>, k: string): void => {
    m.set(k, (m.get(k) ?? 0) + 1);
  };
  for (const it of items) {
    const gold = goldOf(it);
    const pred = it.predicted === null ? null : String(it.predicted);
    if (pred === gold) inc(tp, gold);
    else {
      inc(fn, gold);
      if (pred !== null) inc(fp, pred);
    }
  }
  const classes = new Set([...tp.keys(), ...fp.keys(), ...fn.keys()]);
  let soma = 0;
  for (const k of classes) {
    const t = tp.get(k) ?? 0;
    const denom = 2 * t + (fp.get(k) ?? 0) + (fn.get(k) ?? 0);
    soma += denom > 0 ? (2 * t) / denom : 0;
  }
  return classes.size ? soma / classes.size : undefined;
}

/** Rótulo-ouro "de referência" de um item (o previsto, se aceito; senão a 1ª alternativa). */
function goldKey(it: JevScoredAnswer, expected: readonly JevExpected[]): string {
  if (it.predicted !== null && expected.includes(it.predicted)) return String(it.predicted);
  return String(expected[0]);
}

// ---------------------------------------------------------------------------
// Métricas
// ---------------------------------------------------------------------------

export interface MetricsInput {
  items: readonly JevScoredAnswer[];
  /** Ouro por `caseId` (para o macro-F1). */
  goldOf: (caseId: string, qid: string) => JevExpected[];
  /** Perguntas×casos planejados (com ouro, casos completos). */
  planned: number;
  noScore: number;
  /** Células do competidor (latência/custo; casos incompletos já fora). */
  cells: readonly JevCell[];
  /** Perguntas por célula (custo por 1k decisões). */
  questionsPerCell: number;
  repeats: number;
}

function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

/**
 * Métricas de um conjunto. Com `nScored = 0` (tudo sem nota, spec recusada)
 * acurácia, log-loss, ECE, AURC e cobertura saem `null` — nunca 0: "ECE 0 /
 * log-loss 0 / AURC 0" leria como calibração perfeita num conjunto VAZIO.
 */
export function computeMetrics(inp: MetricsInput): JevMetrics {
  const items = inp.items;
  const nScored = items.length;
  const briers = items.map((i) => i.brier).filter((b): b is number => b !== null);
  const brier = briers.length ? mean(briers) : null;
  const worst = items.filter((i) => i.brier !== null || i.invalid).map((i) => (i.invalid ? 1 : (i.brier as number)));
  const pts = items.map((i) => ({ conf: i.pTop, hit: i.topCorrect }));
  const { ece, bins } = eceEqualWidth(pts);
  const auto = items.filter((i) => i.band === 'auto');
  const byQ = new Map<string, JevScoredAnswer[]>();
  for (const it of items) {
    let l = byQ.get(it.qid);
    if (!l) byQ.set(it.qid, (l = []));
    l.push(it);
  }
  const f1s: number[] = [];
  for (const [qid, lst] of byQ) {
    if (lst[0].type === 'score') continue;
    const f = macroF1(lst, (it) => goldKey(it, inp.goldOf(it.caseId, qid)));
    if (f !== undefined) f1s.push(f);
  }
  const scoreItems = items.filter((i) => i.type === 'score' && typeof i.absError === 'number');

  // Latência e custo (por célula = por request).
  const respondidas = inp.cells.filter((c) => c.status === 'ok' || c.status === 'invalid');
  const lat = respondidas.filter((c) => !c.cold && typeof c.latencyMs === 'number').map((c) => c.latencyMs as number);
  const fria = respondidas.find((c) => c.cold && typeof c.latencyMs === 'number');
  const despachadas = inp.cells.filter((c) => c.status !== 'skipped');
  const requests = despachadas.reduce((s, c) => s + (c.requests ?? (c.cost ? 1 : 0)), 0);
  const total = despachadas.reduce((s, c) => s + (c.cost?.usd ?? 0), 0);
  const pending = despachadas.reduce((s, c) => s + (c.cost?.pendingUsd ?? 0), 0);
  const unknown = despachadas.filter((c) => c.cost && c.cost.source !== 'usage').length;
  const decisoes = respondidas.length * inp.questionsPerCell;

  const m: JevMetrics = {
    n: inp.planned,
    nScored,
    nInvalid: items.filter((i) => i.invalid).length,
    nNoScore: inp.noScore,
    accuracy: nScored ? items.filter((i) => i.correct).length / nScored : null,
    ...(f1s.length ? { macroF1: mean(f1s) } : {}),
    brier,
    brierScore: brier === null ? null : 100 * (1 - brier),
    brierWorstCase: worst.length ? mean(worst) : null,
    logLoss: nScored ? mean(items.map((i) => i.logLoss)) : null,
    ece: nScored ? ece : null,
    eceAdaptive: nScored ? eceEqualMass(pts) : null,
    bins,
    bands: {
      auto: nScored ? auto.length / nScored : 0,
      hitl: nScored ? items.filter((i) => i.band === 'hitl').length / nScored : 0,
      abstain: nScored ? items.filter((i) => i.band === 'abstain').length / nScored : 0,
    },
    precisionAtAuto: auto.length ? auto.filter((i) => i.correct).length / auto.length : null,
    coverageAtAuto: nScored ? auto.length / nScored : null,
    wrongAuto: auto.filter((i) => !i.correct).length,
    aurc: nScored ? aurc(items.map((i) => ({ signal: i.signal, correct: i.correct, key: `${i.caseId}\u0000${i.qid}` }))) : null,
    auroc: auroc(items.map((i) => ({ signal: i.signal, correct: i.correct }))),
    ...(scoreItems.length ? { scoreMae: mean(scoreItems.map((i) => i.absError as number)) } : {}),
    flipRate: inp.repeats > 1 && nScored ? items.filter((i) => i.flipped).length / nScored : null,
    latencyP50: percentile(lat, 50),
    latencyP95: percentile(lat, 95),
    coldLatencyMs: fria?.latencyMs ?? null,
    requests,
    totalCostUsd: total,
    costPer1kRequests: requests > 0 ? (1000 * total) / requests : null,
    costPer1kDecisions: decisoes > 0 ? (1000 * total) / decisoes : null,
    costExact: unknown === 0 && pending === 0,
    unknownCostCalls: unknown,
    pendingUsd: pending,
  };
  const cal = items.filter((i) => i.calibrated);
  if (cal.length) {
    const cb = cal.map((i) => i.calibrated!.brier).filter((b): b is number => b !== null);
    const cauto = cal.filter((i) => i.calibrated!.band === 'auto');
    const calibrated: JevCalibratedMetrics = {
      n: cal.length,
      brier: cb.length ? mean(cb) : null,
      brierScore: cb.length ? 100 * (1 - mean(cb)) : null,
      logLoss: mean(cal.map((i) => i.calibrated!.logLoss)),
      ece: eceEqualWidth(cal.map((i) => ({ conf: i.calibrated!.pTop, hit: i.topCorrect }))).ece,
      bands: {
        auto: cauto.length / cal.length,
        hitl: cal.filter((i) => i.calibrated!.band === 'hitl').length / cal.length,
        abstain: cal.filter((i) => i.calibrated!.band === 'abstain').length / cal.length,
      },
      precisionAtAuto: cauto.length ? cauto.filter((i) => i.correct).length / cauto.length : null,
      coverageAtAuto: cauto.length / cal.length,
    };
    m.calibrated = calibrated;
  }
  return m;
}

export function headlineOf(m: JevMetrics): JevMetricsHeadline {
  return {
    accuracy: m.accuracy,
    macroF1: m.macroF1 ?? null,
    brierScore: m.brierScore,
    ece: m.ece,
    coverageAtAuto: m.coverageAtAuto,
    precisionAtAuto: m.precisionAtAuto,
    wrongAuto: m.wrongAuto,
    p50Ms: m.latencyP50,
    p95Ms: m.latencyP95,
    costPer1kDecisions: m.costPer1kDecisions,
    costExact: m.costExact,
    flipRate: m.flipRate ?? null,
  };
}

// ---------------------------------------------------------------------------
// Pontuação de uma run inteira
// ---------------------------------------------------------------------------

export interface ScoreRunInput {
  specs: readonly JevSpec[];
  contestants: readonly JevContestant[];
  cases: readonly JevCase[];
  cells: readonly JevCell[];
  questionIds: readonly string[];
  bands: JevBandDefaults;
  tolerance: number;
  repeats: number;
  /** Casos fora de tudo (orçamento/cancelamento). */
  incompleteCaseIds: ReadonlySet<string>;
  /** competidor → pergunta → política ajustada (preenche `calibrated`). */
  fitted?: Record<string, Record<string, JevQuestionPolicy>>;
  /** Só estes casos entram nas métricas. */
  caseFilter?: (c: JevCase) => boolean;
  /**
   * Casos onde a política ajustada vale (`calibrated`). Default: fora do split
   * `calib` — medir a calibração nos casos que a ajustaram seria vazamento.
   */
  calibratedCaseFilter?: (c: JevCase) => boolean;
}

export interface ScoredRun {
  /** competidor → itens pontuados. */
  items: Record<string, JevScoredAnswer[]>;
  metrics: Record<string, JevMetrics>;
  byQuestion: Record<string, Record<string, JevMetrics>>;
  byType: Record<string, Partial<Record<JevPrimitive, JevMetrics>>>;
  confusion: Record<string, Record<string, Record<string, number>>>;
  /** competidor → pergunta → casos sem nota. */
  noScore: Record<string, Record<string, number>>;
}

/** Índice (caso, competidor) → células das reps. */
export function cellIndex(cells: readonly JevCell[]): Map<string, JevCell[]> {
  const idx = new Map<string, JevCell[]>();
  for (const c of cells) {
    const k = `${c.caseId}\u0000${c.contestantId}`;
    let l = idx.get(k);
    if (!l) idx.set(k, (l = []));
    l.push(c);
  }
  for (const l of idx.values()) l.sort((a, b) => a.rep - b.rep);
  return idx;
}

export function scoreRun(inp: ScoreRunInput): ScoredRun {
  const specById = new Map(inp.specs.map((s) => [s.id, s]));
  const idx = cellIndex(inp.cells);
  const casos = inp.cases.filter((c) => !inp.incompleteCaseIds.has(c.id) && (inp.caseFilter ? inp.caseFilter(c) : true));
  const caseById = new Map(inp.cases.map((c) => [c.id, c]));
  const goldOf = (caseId: string, qid: string): JevExpected[] => expectedList(caseById.get(caseId)?.expected[qid]);
  const out: ScoredRun = { items: {}, metrics: {}, byQuestion: {}, byType: {}, confusion: {}, noScore: {} };
  const qset = new Set(inp.questionIds);
  for (const ct of inp.contestants) {
    const spec = specById.get(ct.specId);
    if (!spec) continue;
    const perguntas = spec.questions.filter((q) => qset.has(q.id));
    const items: JevScoredAnswer[] = [];
    const planned: Record<string, number> = {};
    const noScore: Record<string, number> = {};
    const confusion: Record<string, Record<string, number>> = {};
    for (const c of casos) {
      const reps = idx.get(`${c.id}\u0000${ct.id}`) ?? [];
      for (const q of perguntas) {
        const gold = expectedList(c.expected[q.id]);
        if (!gold.length) continue;
        planned[q.id] = (planned[q.id] ?? 0) + 1;
        const oc = aggregateReps(q, reps);
        if (!oc.dist) {
          noScore[q.id] = (noScore[q.id] ?? 0) + 1;
          continue;
        }
        const policy = policyFor(spec, q, inp.bands);
        const podeCalibrar = inp.calibratedCaseFilter ? inp.calibratedCaseFilter(c) : c.split !== 'calib';
        const fitted = podeCalibrar ? inp.fitted?.[ct.id]?.[q.id] : undefined;
        const it = scoreDist(q, c.id, oc.dist, c.expected[q.id], policy, {
          tolerance: inp.tolerance,
          invalid: oc.invalid,
          flipped: oc.flipped,
          ...(fitted ? { calibratedPolicy: policyFor(spec, q, inp.bands, fitted) } : {}),
        });
        items.push(it);
        const g = goldKey(it, gold);
        const p = it.predicted === null ? '∅' : String(it.predicted);
        const tab = (confusion[q.id] ??= {});
        tab[`${g}→${p}`] = (tab[`${g}→${p}`] ?? 0) + 1;
      }
    }
    // Células dos casos completos, para latência e custo.
    const cellsCt = inp.cells.filter((cl) => cl.contestantId === ct.id && !inp.incompleteCaseIds.has(cl.caseId));
    const totalPlanned = Object.values(planned).reduce((s, x) => s + x, 0);
    const totalNoScore = Object.values(noScore).reduce((s, x) => s + x, 0);
    out.items[ct.id] = items;
    out.noScore[ct.id] = noScore;
    out.confusion[ct.id] = confusion;
    out.metrics[ct.id] = computeMetrics({
      items,
      goldOf,
      planned: totalPlanned,
      noScore: totalNoScore,
      cells: cellsCt,
      questionsPerCell: perguntas.length,
      repeats: inp.repeats,
    });
    out.byQuestion[ct.id] = {};
    for (const q of perguntas) {
      out.byQuestion[ct.id][q.id] = computeMetrics({
        items: items.filter((i) => i.qid === q.id),
        goldOf,
        planned: planned[q.id] ?? 0,
        noScore: noScore[q.id] ?? 0,
        cells: cellsCt,
        questionsPerCell: perguntas.length,
        repeats: inp.repeats,
      });
    }
    out.byType[ct.id] = {};
    for (const t of ['noul', 'choice', 'score'] as const) {
      const qs = perguntas.filter((q) => q.type === t);
      if (!qs.length) continue;
      const ids = new Set(qs.map((q) => q.id));
      out.byType[ct.id][t] = computeMetrics({
        items: items.filter((i) => ids.has(i.qid)),
        goldOf,
        planned: qs.reduce((s, q) => s + (planned[q.id] ?? 0), 0),
        noScore: qs.reduce((s, q) => s + (noScore[q.id] ?? 0), 0),
        cells: cellsCt,
        questionsPerCell: perguntas.length,
        repeats: inp.repeats,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparação pareada contra o controle
// ---------------------------------------------------------------------------

/** Por caso: média (sobre as perguntas) de 1−Brier e de acerto — escala 0–1. */
export function perCaseScores(items: readonly JevScoredAnswer[]): Map<string, { brier: number | null; acc: number }> {
  const acc = new Map<string, { b: number[]; a: number[] }>();
  for (const it of items) {
    let e = acc.get(it.caseId);
    if (!e) acc.set(it.caseId, (e = { b: [], a: [] }));
    if (it.brier !== null) e.b.push(1 - it.brier);
    e.a.push(it.correct ? 1 : 0);
  }
  const out = new Map<string, { brier: number | null; acc: number }>();
  for (const [k, e] of acc) out.set(k, { brier: e.b.length ? mean(e.b) : null, acc: mean(e.a) });
  return out;
}

export function compareToControl(
  controlId: string,
  contestantId: string,
  controlItems: readonly JevScoredAnswer[],
  items: readonly JevScoredAnswer[],
  primary: 'accuracy' | 'brierScore',
): JevComparison {
  const ctrl = perCaseScores(controlItems);
  const comp = perCaseScores(items);
  const keys = [...new Set([...ctrl.keys(), ...comp.keys()])].sort();
  const pick = (m: Map<string, { brier: number | null; acc: number }>, k: string): number | null => {
    const v = m.get(k);
    if (!v) return null;
    return primary === 'accuracy' ? v.acc : v.brier;
  };
  // Vetores ALINHADOS por caseId (A2.3), já agregados por caso (A2.2): sem pairKeys nem reps.
  const c = keys.map((k) => pick(ctrl, k));
  const x = keys.map((k) => pick(comp, k));
  const sig = pairedSignificance(c, x);
  let better = 0;
  let worse = 0;
  const diffsAcc: number[] = [];
  for (const k of keys) {
    const a = ctrl.get(k);
    const b = comp.get(k);
    if (!a || !b) continue;
    diffsAcc.push(b.acc - a.acc);
    if (b.acc > a.acc) better += 1;
    else if (b.acc < a.acc) worse += 1;
  }
  const mc = exactSignTest(better, worse);
  return {
    contestantId,
    controlId,
    metric: primary,
    meanDiffPp: sig ? sig.meanDiffPp : null,
    ci95Pp: sig ? sig.ci95Pp : null,
    pValue: sig ? sig.pValueTwoSided : null,
    nEfetivo: sig ? sig.nEfetivo : diffsAcc.length,
    accuracyDiffPp: diffsAcc.length ? 100 * mean(diffsAcc) : 0,
    mcnemarP: better + worse > 0 ? mc.pValueTwoSided : null,
    discordant: { better, worse },
  };
}

// ---------------------------------------------------------------------------
// Cascata: Jev decide na banda de confiança, o resto escala para o LLM
// ---------------------------------------------------------------------------

export function simulateCascade(input: {
  decisionId: string;
  llmId: string;
  decision: readonly JevScoredAnswer[];
  llm: readonly JevScoredAnswer[];
  /** Custo por 1k decisões de cada lado (medido). */
  decisionCostPer1k: number | null;
  llmCostPer1k: number | null;
}): JevCascade {
  const llmByKey = new Map(input.llm.map((i) => [`${i.caseId}\u0000${i.qid}`, i]));
  const pares = input.decision
    .map((d) => ({ d, l: llmByKey.get(`${d.caseId}\u0000${d.qid}`) }))
    .filter((p): p is { d: JevScoredAnswer; l: JevScoredAnswer } => Boolean(p.l));
  const n = pares.length;
  const custo = (esc: number): number | null =>
    input.decisionCostPer1k === null || input.llmCostPer1k === null ? null : input.decisionCostPer1k + esc * input.llmCostPer1k;
  const pontoPor = (t: number, fica: (d: JevScoredAnswer) => boolean): JevCascadePoint => {
    let acertos = 0;
    let escaladas = 0;
    for (const { d, l } of pares) {
      if (fica(d) && !d.invalid) acertos += d.correct ? 1 : 0;
      else {
        escaladas += 1;
        acertos += l.correct ? 1 : 0;
      }
    }
    const esc = n ? escaladas / n : 0;
    return { threshold: t, accuracy: n ? acertos / n : 0, escalatedRate: esc, costPer1kDecisions: custo(esc) };
  };
  const ponto = (t: number): JevCascadePoint => pontoPor(t, (d) => d.signal >= t);
  const grade = Array.from({ length: 21 }, (_, i) => Number((i * 0.05).toFixed(2)));
  const curve = grade.map(ponto);
  const llmAcc = n ? pares.filter((p) => p.l.correct).length / n : 0;
  const decAcc = n ? pares.filter((p) => p.d.correct).length / n : 0;
  // Menor % escalado que empata com o LLM: varre TODOS os sinais distintos (+∞ = tudo no LLM).
  const limiares = [...new Set(pares.map((p) => p.d.signal))].sort((a, b) => b - a);
  let match: number | null = null;
  for (const t of [...limiares, Infinity]) {
    const p = ponto(t);
    if (p.accuracy >= llmAcc - 1e-12) {
      match = match === null ? p.escalatedRate : Math.min(match, p.escalatedRate);
    }
  }
  return {
    decisionId: input.decisionId,
    llmId: input.llmId,
    n,
    curve,
    // Na política do competidor de decisão: fica no Jev o que caiu na banda auto.
    atDefault: pontoPor(Number.NaN, (d) => d.band === 'auto'),
    decisionOnly: { accuracy: decAcc, costPer1kDecisions: input.decisionCostPer1k },
    llmOnly: { accuracy: llmAcc, costPer1kDecisions: input.llmCostPer1k },
    escalationToMatchLlm: n ? match : null,
  };
}

/** Motivos de run inconclusiva (§8.4): > 10% sem nota, ou < 5 pontuados numa pergunta com ouro. */
export function inconclusiveReasons(
  scored: ScoredRun,
  contestants: readonly JevContestant[],
  cellsPlanned: Record<string, number>,
  cellsNoScore: Record<string, number>,
): string[] {
  const out: string[] = [];
  for (const ct of contestants) {
    const plan = cellsPlanned[ct.id] ?? 0;
    const sem = cellsNoScore[ct.id] ?? 0;
    if (plan > 0 && sem / plan > INCONCLUSIVE_NO_SCORE_RATIO) {
      out.push(`${ct.label}: ${sem} de ${plan} células sem nota (erro/bloqueio) — acima de ${Math.round(INCONCLUSIVE_NO_SCORE_RATIO * 100)}%`);
    }
    for (const [qid, m] of Object.entries(scored.byQuestion[ct.id] ?? {})) {
      if (m.n > 0 && m.nScored < MIN_SCORED_PER_QUESTION) {
        out.push(`${ct.label}: pergunta "${qid}" com ${m.nScored} caso(s) pontuado(s) (< ${MIN_SCORED_PER_QUESTION})`);
      }
    }
  }
  return out;
}
