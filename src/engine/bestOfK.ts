// Gate da MELHOR DE K (IMPL-002 — R-04:REC-3 / DEC-2 / D-21). Módulo puro:
// roda igual no Node e no navegador (o web o recebe por `rank.ts`, que é shim).
//
// O PROBLEMA. A cada iteração o treino roda K variantes contra a régua nos
// MESMOS cenários e promovia a melhor se Δ ≥ minGain (1 p.p. fixo). Sem teste,
// "a melhor de K" ganha sozinha: a simulação N1 (evidência `sim_promotion.ts`,
// hoje na memória CoALA) mediu 25,8–85,7% de promoção FALSA por iteração com
// variantes idênticas ao controle — o máximo de K estimativas ruidosas é
// enviesado para cima por construção (winner's curse).
//
// O GATE. Max-T por permutação, step-down de Westfall & Young (1993): sob H0 a
// variante e a régua são intercambiáveis DENTRO do cenário, então o sinal da
// diferença pode ser trocado — e a troca é CONJUNTA (o MESMO sinal para as K
// variantes no cenário i), o que preserva a correlação entre as K comparações
// (todas dividem a mesma régua). A estatística é o Δ médio, como no pseudocódigo
// da R-04 §3.Q3(b) — sem studentizar: com n = 5 e escore ternário a variância
// amostral degenera (diferenças todas iguais dariam t infinito). O p ajustado do
// j-ésimo mais forte é P(máximo dos T* dos que restam ≥ T_obs), monotonizado:
// controla o FWER forte, logo P(promover alguma variante sem efeito) ≤ α.
// Enumeração EXATA (agrupada por vetor repetido; cobre n′ ≤ 20 e mais) e, acima
// do teto, Monte Carlo com B = 10.000 vetores semeados, p = (1 + #)/(B + 1).
// Holm (1979) sobre os p marginais fica como fallback simples (`method: 'holm'`).
//
// Premissa honesta: a troca conjunta supõe o VETOR de diferenças simétrico sob
// H0 — exato para K = 1, aproximado para K ≥ 2 com escore assimétrico (o 3º
// cumulante do controle entra com sinal oposto). Por isso o critério de aceite
// é EMPÍRICO: `npm run stats:sim` mede a promoção falsa na grade n 5–50 × K 1–8.
//
// minGain. Margem PRÁTICA, não inferência (R-04 Q3c): default max(1 p.p.; 50/n),
// meia granularidade — um cenário resolve→parcial move a média em 50/n p.p.; com
// n = 8 isso é 6,25 p.p., e 1 p.p. exigiria 0,16 cenário de diferença.
//
// Ganho corrigido (winner's curse, R-04 Q3d). O ganho BRUTO é o máximo entre K:
// E[máx] > máx E. A correção subtrai a inflação esperada da seleção estimada por
// TROCA DE SINAIS DOS RESÍDUOS (bootstrap de sinais ancorado em "variantes
// igualmente boas"): E*[máx_k Σᵢ sᵢ·rₖᵢ/nₖ], com rₖᵢ = dₖᵢ − ḡₖ inflado por
// √(n/(n−1)). É a inflação do caso em que ela é MÁXIMA (efeitos iguais), então o
// corrigido é CONSERVADOR: ≈ não enviesado quando as K variantes são igualmente
// boas e pessimista (nunca otimista) quando só uma é real. O shrinkage empírico
// de Bayes (MoM, τ² truncado em 0) foi testado e ficou enviesado para CIMA em
// n = 5 (+1,3 p.p.): o τ² espúrio espalha as estimativas. Números na memória.

import type { MultiplicityMethod, SignificanceMethod } from '../types.js';
import { EXACT_ENUM_CAP, MONTE_CARLO_B, halfBinomialPmf, mulberry32, type PairScore } from '../stats.js';

/** α do gate de promoção: unilateral (H1: variante > régua), FWER sobre as K. */
export const GATE_ALPHA = 0.05;
/** Seed default do Monte Carlo do gate (a mesma do teste pareado: recomputar reproduz). */
export const GATE_SEED = 1337;
/** Piso da margem prática default (p.p.). */
export const MIN_GAIN_FLOOR_PP = 1;
/** Meia granularidade: um cenário resolve→parcial move a média em 50/n p.p. */
export const MIN_GAIN_HALF_STEP_PP = 50;

/** Tolerância das comparações T* ≥ T_obs (somas em ordens diferentes diferem ~1e-16). */
const EPS = 1e-9;

export type { MultiplicityMethod };

/**
 * minGain default = max(1 p.p.; 50/n), n = pares com observação nos DOIS lados
 * (a granularidade é a da média que o gate de fato calcula). Sem par: o piso.
 */
export function defaultMinGain(nEfetivo: number): number {
  if (!(nEfetivo > 0)) return MIN_GAIN_FLOOR_PP;
  return Math.max(MIN_GAIN_FLOOR_PP, MIN_GAIN_HALF_STEP_PP / nEfetivo);
}

/** minGain explícito (config) vence; ausente → {@link defaultMinGain}. */
export function resolveMinGain(
  explicit: number | undefined,
  nEfetivo: number,
): { minGain: number; source: 'config' | 'default' } {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return { minGain: explicit, source: 'config' };
  return { minGain: defaultMinGain(nEfetivo), source: 'default' };
}

// ---------------------------------------------------------------------------
// Layout: diferenças por cenário × variante, com ausentes fora dos dois lados
// ---------------------------------------------------------------------------

const isObs = (v: PairScore): v is number => typeof v === 'number' && Number.isFinite(v);

interface Layout {
  /** Um vetor por cenário com ≥ 1 par completo: dₖ = variante − régua (0 = ausente). */
  rows: Float64Array[];
  /** present[i][k] = o par (i, k) existe (observação nos DOIS lados). */
  present: Uint8Array[];
  /** Pares completos por variante. */
  nEff: number[];
  /** Σ dₖᵢ sobre os pares completos. */
  sum: number[];
}

/**
 * Alinha régua e variantes por POSIÇÃO (etapa i da mesma run). Par sem
 * observação em qualquer lado sai dos dois (IMPL-005): vira 0 no vetor — a troca
 * de sinal não o altera — e não conta em nₖ.
 */
function layout(control: readonly PairScore[], variants: readonly (readonly PairScore[])[]): Layout {
  const K = variants.length;
  const rows: Float64Array[] = [];
  const present: Uint8Array[] = [];
  const nEff = new Array<number>(K).fill(0);
  const sum = new Array<number>(K).fill(0);
  for (let i = 0; i < control.length; i += 1) {
    const c = control[i];
    if (!isObs(c)) continue;
    const row = new Float64Array(K);
    const pres = new Uint8Array(K);
    let any = false;
    for (let k = 0; k < K; k += 1) {
      const v = variants[k][i];
      if (!isObs(v)) continue;
      const d = v - c;
      row[k] = d;
      pres[k] = 1;
      nEff[k] += 1;
      sum[k] += d;
      any = true;
    }
    if (any) {
      rows.push(row);
      present.push(pres);
    }
  }
  return { rows, present, nEff, sum };
}

// ---------------------------------------------------------------------------
// Distribuição de troca de sinais CONJUNTA
// ---------------------------------------------------------------------------

interface FlipGroup {
  /** Vetor canônico (1ª componente não nula positiva). */
  vec: Float64Array;
  /** Quantos cenários têm ±vec. */
  count: number;
}

/**
 * Agrupa cenários com o MESMO vetor a menos de sinal: dentro do grupo só importa
 * QUANTOS ficam positivos (binomial), não quais — compressão exata, como a
 * enumeração agrupada de `signFlipTest`. Vetores nulos não mexem em T* e saem.
 */
function groupRows(rows: readonly Float64Array[]): FlipGroup[] {
  const byKey = new Map<string, FlipGroup>();
  for (const row of rows) {
    let first = 0;
    while (first < row.length && row[first] === 0) first += 1;
    if (first === row.length) continue;
    const sign = row[first] < 0 ? -1 : 1;
    const vec = row.map((v) => (v === 0 ? 0 : v * sign));
    const key = Array.from(vec).join(',');
    const g = byKey.get(key);
    if (g) g.count += 1;
    else byKey.set(key, { vec, count: 1 });
  }
  return [...byKey.values()];
}

/** Π(count+1) com saída antecipada (Infinity) ao passar do teto. */
function comboCount(groups: readonly FlipGroup[], cap: number): number {
  let c = 1;
  for (const g of groups) {
    c *= g.count + 1;
    if (c > cap) return Infinity;
  }
  return c;
}

interface FlipOpts {
  /** B do Monte Carlo (default 10.000). */
  iterations?: number;
  /** Seed do Monte Carlo (default {@link GATE_SEED}). */
  seed?: number;
  /** Teto de combinações da enumeração exata (default 2^20). */
  exactCap?: number;
}

interface FlipWalk {
  method: SignificanceMethod;
  /** 2^m (exato: a distribuição inteira) ou B (Monte Carlo). */
  permutations: number;
  seed?: number;
}

/**
 * Percorre a distribuição de T* = Σᵢ sᵢ·rowᵢ sob troca de sinais conjunta.
 * Exato: `visit(t, w)` com Σw = 1 (cada vetor de sinais tem peso 2^−m, agrupado
 * por binomial). Monte Carlo: `visit(t, 1)` B vezes (o chamador divide). O vetor
 * `t` é reusado entre visitas — copie se precisar guardar.
 */
function walkSignFlips(
  rows: readonly Float64Array[],
  dim: number,
  visit: (t: Float64Array, w: number) => void,
  opts: FlipOpts = {},
): FlipWalk {
  const groups = groupRows(rows);
  const m = groups.reduce((s, g) => s + g.count, 0);
  if (comboCount(groups, opts.exactCap ?? EXACT_ENUM_CAP) !== Infinity) {
    const pmfs = groups.map((g) => halfBinomialPmf(g.count));
    const stack = Array.from({ length: groups.length + 1 }, () => new Float64Array(dim));
    const rec = (gi: number, w: number): void => {
      const cur = stack[gi];
      if (gi === groups.length) {
        visit(cur, w);
        return;
      }
      const { vec, count: c } = groups[gi];
      const pmf = pmfs[gi];
      const next = stack[gi + 1];
      // j = quantos dos c cenários do grupo ficam com +vec nesta permutação.
      for (let j = 0; j <= c; j += 1) {
        const mult = 2 * j - c;
        for (let k = 0; k < dim; k += 1) next[k] = cur[k] + vec[k] * mult;
        rec(gi + 1, w * pmf[j]);
      }
    };
    rec(0, 1);
    return { method: 'exact', permutations: 2 ** m };
  }
  const iterations = Math.max(1, Math.floor(opts.iterations ?? MONTE_CARLO_B));
  const seed = opts.seed ?? GATE_SEED;
  const rng = mulberry32(seed);
  const nz = rows.filter((r) => r.some((v) => v !== 0));
  const t = new Float64Array(dim);
  for (let b = 0; b < iterations; b += 1) {
    t.fill(0);
    for (const row of nz) {
      if (rng() < 0.5) for (let k = 0; k < dim; k += 1) t[k] -= row[k];
      else for (let k = 0; k < dim; k += 1) t[k] += row[k];
    }
    visit(t, 1);
  }
  return { method: 'monte-carlo', permutations: iterations, seed };
}

// ---------------------------------------------------------------------------
// Max-T step-down (Westfall-Young) e Holm
// ---------------------------------------------------------------------------

export interface BestOfKTestResult {
  /** Correção de multiplicidade aplicada ao `pAdjusted`. */
  method: MultiplicityMethod;
  /** Como a distribuição nula foi obtida (a mesma serve aos p marginais). */
  enumeration: SignificanceMethod;
  /** 2^m (exato) ou B (Monte Carlo). */
  permutations: number;
  /** Seed do Monte Carlo (ausente no exato). */
  seed?: number;
  /** Variantes com ≥ 1 par completo — a FAMÍLIA do FWER. */
  k: number;
  /** Cenários com ≥ 1 par completo. */
  nScenarios: number;
  /** Pares completos por variante (mesma ordem da entrada). */
  nEfetivo: number[];
  /** Δ médio por variante, escala 0–1 (NaN sem par). */
  meanDiff: number[];
  /** p unilateral MARGINAL por variante (troca de sinais, sem correção); 1 sem par. */
  pRaw: number[];
  /** p unilateral AJUSTADO (FWER) por variante; 1 sem par. */
  pAdjusted: number[];
}

/**
 * Holm (1979): p ajustado step-down de Bonferroni, sem pressuposto de
 * dependência — o fallback simples do max-T. Ordem dos p preservada.
 */
export function holmAdjust(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const order = [...pValues.keys()].sort((a, b) => pValues[a] - pValues[b] || a - b);
  const out = new Array<number>(m).fill(1);
  let run = 0;
  order.forEach((idx, j) => {
    run = Math.max(run, Math.min(1, (m - j) * pValues[idx]));
    out[idx] = run;
  });
  return out;
}

/**
 * Teste da melhor de K: cada variante contra a MESMA régua, nos mesmos cenários
 * (posicional). `variants[k][i]` e `control[i]` na escala 0–1 do judge-score;
 * ausente (`null`/`undefined`/não-finito) exclui o par dos dois lados.
 *
 * `max-t` (default): step-down de Westfall-Young sobre a troca de sinais
 * CONJUNTA por cenário. `holm`: Holm sobre os p marginais da MESMA distribuição.
 * Determinístico: exato não sorteia; Monte Carlo é semeado.
 */
export function bestOfKTest(
  control: readonly PairScore[],
  variants: readonly (readonly PairScore[])[],
  opts: FlipOpts & { method?: MultiplicityMethod } = {},
): BestOfKTestResult {
  const method = opts.method ?? 'max-t';
  const K = variants.length;
  const L = layout(control, variants);
  const meanDiff = L.sum.map((s, k) => (L.nEff[k] > 0 ? s / L.nEff[k] : Number.NaN));
  const pRaw = new Array<number>(K).fill(1);
  const pAdjusted = new Array<number>(K).fill(1);
  const testable = [...Array(K).keys()].filter((k) => L.nEff[k] > 0);
  const base = { method, k: testable.length, nScenarios: L.rows.length, nEfetivo: L.nEff, meanDiff, pRaw, pAdjusted };
  if (testable.length === 0) return { ...base, enumeration: 'exact', permutations: 1 };

  const Kt = testable.length;
  const tObs = testable.map((k) => meanDiff[k]);
  // Linhas já divididas por nₖ: a soma na folha É a média T*ₖ.
  const rows = L.rows.map((row) => Float64Array.from(testable, (k) => row[k] / L.nEff[k]));
  // Ordem decrescente de T_obs (empate: ordem de entrada — determinístico).
  const order = [...Array(Kt).keys()].sort((a, b) => tObs[b] - tObs[a] || a - b);
  const stepCount = new Float64Array(Kt);
  const rawCount = new Float64Array(Kt);
  const walk = walkSignFlips(
    rows,
    Kt,
    (t, w) => {
      // uⱼ = máx dos T* dos j-ésimo em diante (mais fracos) — o "max-T" do passo j.
      let u = -Infinity;
      for (let j = Kt - 1; j >= 0; j -= 1) {
        const k = order[j];
        const tk = t[k];
        if (tk > u) u = tk;
        if (u >= tObs[k] - EPS) stepCount[j] += w;
        if (tk >= tObs[k] - EPS) rawCount[k] += w;
      }
    },
    opts,
  );
  const toP =
    walk.method === 'exact'
      ? (c: number) => Math.min(1, Math.max(0, c))
      : (c: number) => (1 + c) / (walk.permutations + 1);
  for (let j = 0; j < Kt; j += 1) pRaw[testable[j]] = toP(rawCount[j]);
  if (method === 'holm') {
    const adj = holmAdjust(testable.map((k) => pRaw[k]));
    testable.forEach((k, j) => {
      pAdjusted[k] = adj[j];
    });
  } else {
    // Monotonização step-down: o ajustado nunca é menor que o do mais forte.
    let run = 0;
    for (let j = 0; j < Kt; j += 1) {
      run = Math.max(run, toP(stepCount[j]));
      pAdjusted[testable[order[j]]] = run;
    }
  }
  return {
    ...base,
    enumeration: walk.method,
    permutations: walk.permutations,
    ...(walk.seed !== undefined ? { seed: walk.seed } : {}),
  };
}

// ---------------------------------------------------------------------------
// Winner's curse
// ---------------------------------------------------------------------------

export interface WinnersCurse {
  /** Inflação esperada da seleção do máximo (escala 0–1, ≥ 0). */
  inflation: number;
  /** Variantes que entraram (nₖ ≥ 2). Com < 2 não há seleção a corrigir. */
  k: number;
  enumeration: SignificanceMethod;
  permutations: number;
}

/**
 * Inflação do winner's curse do máximo entre K, por troca de sinais dos
 * RESÍDUOS (rₖᵢ = dₖᵢ − ḡₖ, × √(nₖ/(nₖ−1)) para a variância não encolher),
 * ancorada em efeitos iguais: E*[máx_k Σᵢ sᵢ·rₖᵢ/nₖ]. A parte comum a todas as
 * variantes no cenário (a régua) tem o MESMO sinal nas K e sai do máximo; o que
 * sobra é o ruído próprio de cada variante — exatamente o que a seleção infla.
 * Ganho corrigido = ganho bruto − inflação (ver o cabeçalho do módulo).
 */
export function winnersCurseInflation(
  control: readonly PairScore[],
  variants: readonly (readonly PairScore[])[],
  opts: FlipOpts = {},
): WinnersCurse {
  const L = layout(control, variants);
  const K = variants.length;
  const used = [...Array(K).keys()].filter((k) => L.nEff[k] >= 2);
  if (used.length < 2) return { inflation: 0, k: used.length, enumeration: 'exact', permutations: 1 };
  const mean = used.map((k) => L.sum[k] / L.nEff[k]);
  const scale = used.map((k) => Math.sqrt(L.nEff[k] / (L.nEff[k] - 1)) / L.nEff[k]);
  const rows = L.rows.map((row, i) =>
    Float64Array.from(used, (k, j) => (L.present[i][k] ? (row[k] - mean[j]) * scale[j] : 0)),
  );
  let acc = 0;
  const walk = walkSignFlips(
    rows,
    used.length,
    (t, w) => {
      let mx = -Infinity;
      for (let j = 0; j < t.length; j += 1) if (t[j] > mx) mx = t[j];
      acc += w * mx;
    },
    opts,
  );
  const inflation = walk.method === 'exact' ? acc : acc / walk.permutations;
  // E[máx] ≥ máx E = 0 (Jensen); o piso só apara arredondamento.
  return { inflation: Math.max(0, inflation), k: used.length, enumeration: walk.method, permutations: walk.permutations };
}
