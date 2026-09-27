// Significância pareada campeão × controle. Os dois rodam nos MESMOS cenários
// pinados, então a unidade de análise é a DIFERENÇA por cenário (o par).
//
// IMPL-001 (R-04:REC-1 / DEC-1): o bootstrap percentil herdado do prompt-arena
// SAIU. A "fração de médias reamostradas ≤ 0" não é p-valor — reamostra da
// distribuição centrada no OBSERVADO (não sob H0) e degenera com dados
// discretos: a sonda N2 mediu p=0 com IC [50;50] para "+0,5 em todos os 5" e
// p=0,008 onde o exato dá 0,125. No lugar, permutação EXATA por TROCA DE SINAIS
// (Fisher-Pitman pareado): sob H0 campeão e controle são intercambiáveis dentro
// do cenário, cada diferença troca de sinal com prob. 1/2, e enumerar os 2^n′
// sinais dá a distribuição nula exata — para qualquer n, com empates e zeros.
// IC95% por INVERSÃO do mesmo teste e teste do sinal exato como sensibilidade.
// É SUPORTE À DECISÃO; o gate da melhor de K (max-T) é outro item.

import type {
  PairedSignificance,
  SignificanceMethod,
  StoredSignificance,
  Verdict,
} from './types.js';

/**
 * Score por veredito na escala do judge-score ÷100 (0–1). ATENÇÃO: não confundir
 * com o score ordinal 0–2 de `duels.ts` — lá a ordem entre resolve/parcial/nao é o
 * que importa; aqui é a fração de crédito que alimenta o judge-score e o teste pareado.
 */
export const VERDICT_SCORE: Record<Verdict, number> = { resolve: 1, parcial: 0.5, nao: 0 };

/**
 * PRNG determinístico (mulberry32). Duplicado de `duels.ts` DE PROPÓSITO, como no
 * original: cada módulo semeia o seu (aqui a seed fixa o Monte Carlo da troca de
 * sinais; lá a seed deriva do scenarioId para o shuffle cego), e um helper
 * compartilhado acoplaria duas fontes de aleatoriedade que devem evoluir independentes.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Piso de pares com observação nos DOIS lados (mesmo piso de `MIN_HOLDOUT_SCENARIOS`). */
export const MIN_PAIRS = 5;
/**
 * Teto de combinações da enumeração exata. A enumeração é AGRUPADA por valor
 * repetido (Π(c+1) combinações em vez de 2^n′), então cobre n′ ≤ 20 com valores
 * todos distintos (2^20) e, na escala ternária do produto (|d| ∈ {0,5; 1}), fica
 * exata para qualquer n realista — Monte Carlo só entra além do teto.
 */
export const EXACT_ENUM_CAP = 1 << 20;
/** Reamostragens de troca de sinais quando a enumeração passa do teto (R-04: B=10.000). */
export const MONTE_CARLO_B = 10_000;
/** Seed default do Monte Carlo (a mesma do bootstrap antigo: recomputar reproduz o resultado). */
const DEFAULT_SEED = 1337;
/** Nível do IC (bilateral, caudas iguais): 95%. */
const CI_ALPHA = 0.05;
/**
 * Acima disso a linha de Pascal estoura o double (C(1030,515) > 1e308): a pmf
 * binomial vai por log e o teste/IC vão por Monte Carlo (fora do uso real).
 */
const MAX_EXACT_N = 1000;

/** Uma observação ausente é `null`/`undefined`/não-finito: o par sai dos DOIS lados. */
export type PairScore = number | null | undefined;
const isObs = (v: PairScore): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Forma os pares (campeão − controle). Pares com observação ausente em QUALQUER
 * lado são excluídos dos dois — nunca imputados (R-04 DEC-1: imputar 0/0 infla n).
 *
 * Posicional por padrão (as primeiras `min(length)` posições). Com `pairKeys`, o
 * par é identificado pela CHAVE: a lista de pares é a do controle (posições
 * `< min(controle, chaves)`) e o valor do campeão é buscado pela mesma chave;
 * chave do controle sem valor do campeão conta como par excluído, chave só do
 * campeão é ignorada (legado).
 */
export function pairDiffs(
  controlScores: readonly PairScore[],
  championScores: readonly PairScore[],
  pairKeys?: readonly string[],
): { diffs: number[]; nominal: number; excluded: number } {
  const diffs: number[] = [];
  let nominal = 0;
  if (pairKeys) {
    const champByKey = new Map<string, PairScore>();
    const nChamp = Math.min(championScores.length, pairKeys.length);
    for (let i = 0; i < nChamp; i += 1) champByKey.set(pairKeys[i], championScores[i]);
    nominal = Math.min(controlScores.length, pairKeys.length);
    for (let i = 0; i < nominal; i += 1) {
      const c = controlScores[i];
      const h = champByKey.get(pairKeys[i]);
      if (isObs(c) && isObs(h)) diffs.push(h - c);
    }
  } else {
    nominal = Math.min(controlScores.length, championScores.length);
    for (let i = 0; i < nominal; i += 1) {
      const c = controlScores[i];
      const h = championScores[i];
      if (isObs(c) && isObs(h)) diffs.push(h - c);
    }
  }
  return { diffs, nominal, excluded: nominal - diffs.length };
}

// ---------------------------------------------------------------------------
// Núcleo numérico
// ---------------------------------------------------------------------------

/**
 * C(c, j)·2^−c para j = 0..c. Linha de Pascal em inteiros exatos (até c = 56 cabem
 * em 53 bits) escalada por potência de 2 (exata): as probabilidades saem diádicas
 * e EXATAS, e somas delas também — é o que garante "p exato ±1e-9" nas sondas.
 * Acima de {@link MAX_EXACT_N} (fora do uso real) vai por log para não estourar.
 */
function halfBinomialPmf(c: number): Float64Array {
  const row = new Float64Array(c + 1);
  if (c <= MAX_EXACT_N) {
    row[0] = 1;
    for (let i = 1; i <= c; i += 1) for (let j = i; j >= 1; j -= 1) row[j] += row[j - 1];
    const scale = 2 ** -c;
    for (let j = 0; j <= c; j += 1) row[j] *= scale;
    return row;
  }
  let logP = -c * Math.LN2;
  for (let j = 0; j <= c; j += 1) {
    row[j] = Math.exp(logP);
    logP += Math.log((c - j) / (j + 1));
  }
  return row;
}

/** Agrupa valores iguais (−0 ≡ 0). Agrupar é só compressão: a enumeração segue exata. */
function groupValues(values: readonly number[]): { value: number; count: number }[] {
  const m = new Map<number, number>();
  for (const v of values) {
    const k = v === 0 ? 0 : v;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, count }));
}

/** Π(count+1) com saída antecipada (Infinity) ao passar do teto. */
function comboCount(groups: readonly { count: number }[]): number {
  let c = 1;
  for (const g of groups) {
    c *= g.count + 1;
    if (c > EXACT_ENUM_CAP) return Infinity;
  }
  return c;
}

/**
 * Tolerância de comparação: somas iguais em ordens diferentes diferem ~1e-16;
 * valores reais distintos da estatística (escala 0–1, denominadores pequenos)
 * diferem ordens de grandeza mais.
 */
function tolerance(values: readonly number[]): number {
  let s = 0;
  for (const v of values) s += Math.abs(v);
  return 1e-10 * Math.max(1, s);
}

/** Uma reamostragem de troca de sinais: T* = Σ sᵢdᵢ e a média do subconjunto S = {sᵢ = −1}. */
interface SignFlipDraws {
  tStar: Float64Array;
  /** Média de dᵢ em S; NaN quando S é vazio (identidade). */
  subsetMean: Float64Array;
}

/**
 * B vetores de sinais uniformes (mulberry32 semeado), sobre TODAS as diferenças
 * (zeros inclusive: não mexem em T*, mas mexem nas médias de subconjunto do IC).
 * Teste e IC usam a MESMA semente e a mesma ordem de sorteio → os mesmos vetores.
 */
function drawSignFlips(diffs: readonly number[], iterations: number, seed: number): SignFlipDraws {
  const rng = mulberry32(seed);
  const tStar = new Float64Array(iterations);
  const subsetMean = new Float64Array(iterations);
  for (let b = 0; b < iterations; b += 1) {
    let t = 0;
    let s = 0;
    let cnt = 0;
    for (const d of diffs) {
      if (rng() < 0.5) {
        t -= d;
        s += d;
        cnt += 1;
      } else {
        t += d;
      }
    }
    tStar[b] = t;
    subsetMean[b] = cnt > 0 ? s / cnt : Number.NaN;
  }
  return { tStar, subsetMean };
}

const clamp01 = (p: number): number => Math.min(1, Math.max(0, p));

export interface SignFlipResult {
  /** P(T* ≥ T_obs) — unilateral na direção H1: média > 0 (o gate). */
  pGreater: number;
  /** P(T* ≤ T_obs) — unilateral na direção oposta. */
  pLess: number;
  /** P(|T*| ≥ |T_obs|) — bilateral (o relatório). */
  pTwoSided: number;
  /** n′: diferenças não nulas (as únicas que informam o teste). */
  nNonZero: number;
  /** Menor p unilateral atingível: 2^−n′ (exato) ou max(2^−n′, 1/(B+1)) (Monte Carlo). */
  pMinUnilateral: number;
  method: SignificanceMethod;
}

/**
 * Teste de permutação pareado por troca de sinais, estatística T = Σ dᵢ.
 *
 * Exato por enumeração (agrupada) dos 2^n′ vetores de sinais quando cabe no teto
 * — sempre que n′ ≤ 20 —; senão Monte Carlo com B reamostragens semeadas e
 * p = (1 + #{T* ≥ T_obs})/(B+1), que é válido (nunca anti-conservador) por
 * construção. Zeros não mudam a distribuição de T* e ficam de fora do n′.
 */
export function signFlipTest(
  diffs: readonly number[],
  opts?: { iterations?: number; seed?: number },
): SignFlipResult {
  const nonzero = diffs.filter((d) => d !== 0);
  const nNonZero = nonzero.length;
  let tObs = 0;
  for (const d of nonzero) tObs += d;
  const eps = tolerance(nonzero);
  const absObs = Math.abs(tObs);

  const groups = groupValues(nonzero.map(Math.abs));
  if (nNonZero <= MAX_EXACT_N && comboCount(groups) <= EXACT_ENUM_CAP) {
    const pmfs = groups.map((g) => halfBinomialPmf(g.count));
    let ge = 0;
    let le = 0;
    let abs = 0;
    const walk = (gi: number, t: number, w: number): void => {
      if (gi === groups.length) {
        if (t >= tObs - eps) ge += w;
        if (t <= tObs + eps) le += w;
        if (Math.abs(t) >= absObs - eps) abs += w;
        return;
      }
      const { value: a, count: c } = groups[gi];
      const pmf = pmfs[gi];
      // j = quantos dos c valores |d| = a ficam POSITIVOS nesta permutação.
      for (let j = 0; j <= c; j += 1) walk(gi + 1, t + a * (2 * j - c), w * pmf[j]);
    };
    walk(0, 0, 1);
    return {
      pGreater: clamp01(ge),
      pLess: clamp01(le),
      pTwoSided: clamp01(abs),
      nNonZero,
      pMinUnilateral: 2 ** -nNonZero,
      method: 'exact',
    };
  }

  const iterations = Math.max(1, Math.floor(opts?.iterations ?? MONTE_CARLO_B));
  const { tStar } = drawSignFlips(diffs, iterations, opts?.seed ?? DEFAULT_SEED);
  let ge = 0;
  let le = 0;
  let abs = 0;
  for (let b = 0; b < iterations; b += 1) {
    const t = tStar[b];
    if (t >= tObs - eps) ge += 1;
    if (t <= tObs + eps) le += 1;
    if (Math.abs(t) >= absObs - eps) abs += 1;
  }
  const denom = iterations + 1;
  return {
    pGreater: (1 + ge) / denom,
    pLess: (1 + le) / denom,
    pTwoSided: (1 + abs) / denom,
    nNonZero,
    pMinUnilateral: Math.max(2 ** -nNonZero, 1 / denom),
    method: 'monte-carlo',
  };
}

/**
 * Menor valor v tal que Σ pesos(vals ≤ v) ≥ target. Quickselect ponderado de 3
 * vias, in place, O(M) esperado (M ≤ 2^20 médias de subconjunto).
 */
function weightedSelect(vals: Float64Array, w: Float64Array, len: number, target: number): number {
  let lo = 0;
  let hi = len;
  let need = target;
  const swap = (i: number, j: number): void => {
    const v = vals[i];
    vals[i] = vals[j];
    vals[j] = v;
    const x = w[i];
    w[i] = w[j];
    w[j] = x;
  };
  while (hi > lo) {
    const a = vals[lo];
    const b = vals[(lo + hi) >>> 1];
    const c = vals[hi - 1];
    const pivot = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c)); // mediana de 3
    let lt = lo;
    let i = lo;
    let gt = hi;
    let wLt = 0;
    let wEq = 0;
    while (i < gt) {
      const v = vals[i];
      if (v < pivot) {
        swap(lt, i);
        wLt += w[lt];
        lt += 1;
        i += 1;
      } else if (v > pivot) {
        gt -= 1;
        swap(i, gt);
      } else {
        wEq += w[i];
        i += 1;
      }
    }
    if (need <= wLt) {
      hi = lt;
    } else if (need <= wLt + wEq) {
      return pivot;
    } else {
      need -= wLt + wEq;
      lo = gt;
    }
  }
  // Só por arredondamento (target > massa total): devolve o maior valor visto.
  let max = -Infinity;
  for (let k = 0; k < len; k += 1) if (vals[k] > max) max = vals[k];
  return max;
}

export interface SignFlipInterval {
  /** Limite inferior na escala das diferenças; −Infinity = o teste não rejeita nada abaixo. */
  lower: number;
  /** Limite superior; +Infinity = o teste não rejeita nada acima. */
  upper: number;
  method: SignificanceMethod;
}

/**
 * IC por INVERSÃO do teste de troca de sinais: { δ : nenhum dos dois testes
 * unilaterais a α/2 rejeita H0: média = δ } (caudas iguais, 95% por padrão).
 *
 * Para T(δ) = Σ(dᵢ − δ), trocar os sinais do subconjunto S não aumenta T ⇔
 * S = ∅ ou média_S(d) ≤ δ — então p⁺(δ) = (1 + #{S≠∅: média_S ≤ δ})/2^n e os
 * limites são estatísticas de ordem das MÉDIAS DE SUBCONJUNTOS (Hartigan 1969):
 * inferior = k-ésima menor, superior = k-ésima maior, k = ⌊(α/2)·2^n⌋. Com k = 0
 * (n ≤ 5 a 95%) o teste não tem resolução para rejeitar nada: o IC é a reta toda
 * — honesto, ao contrário do [50;50] do bootstrap. Exato quando a enumeração
 * agrupada cabe no teto; senão os mesmos B vetores semeados do Monte Carlo.
 */
export function signFlipConfidenceInterval(
  diffs: readonly number[],
  opts?: { iterations?: number; seed?: number; alpha?: number },
): SignFlipInterval {
  const alpha = opts?.alpha ?? CI_ALPHA;
  const n = diffs.length;
  const groups = groupValues(diffs);
  if (n <= MAX_EXACT_N && comboCount(groups) <= EXACT_ENUM_CAP) {
    const total = 2 ** n;
    const k = Math.floor((alpha / 2) * total);
    if (k <= 0) return { lower: -Infinity, upper: Infinity, method: 'exact' };
    const size = comboCount(groups);
    const means = new Float64Array(size);
    const probs = new Float64Array(size);
    const pmfs = groups.map((g) => halfBinomialPmf(g.count));
    let len = 0;
    const walk = (gi: number, sum: number, cnt: number, w: number): void => {
      if (gi === groups.length) {
        if (cnt > 0) {
          means[len] = sum / cnt;
          probs[len] = w;
          len += 1;
        }
        return;
      }
      const { value: v, count: c } = groups[gi];
      const pmf = pmfs[gi];
      // j = quantos dos c valores iguais a v entram no subconjunto S.
      for (let j = 0; j <= c; j += 1) walk(gi + 1, sum + v * j, cnt + j, w * pmf[j]);
    };
    walk(0, 0, 0, 1);
    // Em probabilidade (÷2^n): k-ésima menor ⇔ massa acumulada ≥ k/2^n; a k-ésima
    // MAIOR é a (2^n − k)-ésima menor entre as 2^n − 1 médias de S ≠ ∅.
    const lower = weightedSelect(means, probs, len, k / total);
    const upper = weightedSelect(means, probs, len, (total - k) / total);
    return { lower, upper, method: 'exact' };
  }

  const iterations = Math.max(1, Math.floor(opts?.iterations ?? MONTE_CARLO_B));
  const { subsetMean } = drawSignFlips(diffs, iterations, opts?.seed ?? DEFAULT_SEED);
  const sorted = subsetMean.filter((m) => !Number.isNaN(m)).sort();
  const empty = iterations - sorted.length;
  // p̂⁺(δ) = (1 + vazios + #{média ≤ δ})/(B+1) > α/2 ⇔ #{média ≤ δ} ≥ kk.
  const kk = Math.floor((alpha / 2) * (iterations + 1) - 1 - empty) + 1;
  if (kk <= 0 || kk > sorted.length) return { lower: -Infinity, upper: Infinity, method: 'monte-carlo' };
  return { lower: sorted[kk - 1], upper: sorted[sorted.length - kk], method: 'monte-carlo' };
}

/**
 * Teste do sinal exato (binomial sobre os não nulos, zeros descartados) — a
 * SENSIBILIDADE do teste principal: usa só o sinal, perde poder, mas não depende
 * da magnitude das diferenças.
 */
export function exactSignTest(
  positive: number,
  negative: number,
): { positive: number; negative: number; pValue: number; pValueTwoSided: number } {
  const m = positive + negative;
  if (m === 0) return { positive, negative, pValue: 1, pValueTwoSided: 1 };
  const pmf = halfBinomialPmf(m);
  let upper = 0;
  for (let j = positive; j <= m; j += 1) upper += pmf[j];
  let lower = 0;
  for (let j = 0; j <= positive; j += 1) lower += pmf[j];
  return {
    positive,
    negative,
    pValue: clamp01(upper),
    pValueTwoSided: clamp01(2 * Math.min(upper, lower)),
  };
}

/** Arredonda p.p. para 2 casas PARA FORA (o IC nunca encolhe) e mata o −0. */
const floorPp = (x: number): number => Math.floor(x * 100 + 1e-9) / 100 + 0;
const ceilPp = (x: number): number => Math.ceil(x * 100 - 1e-9) / 100 + 0;
const clampPp = (x: number): number => Math.min(100, Math.max(-100, x));

/**
 * Teste pareado de (campeão − controle) sobre os cenários compartilhados, com
 * scores na escala 0–1 de {@link VERDICT_SCORE}. Devolve tudo em PONTOS de
 * judge-score (×100) ou `null` com menos de {@link MIN_PAIRS} pares com
 * observação nos dois lados (mesmo piso de `MIN_HOLDOUT_SCENARIOS`).
 *
 * - `pValue`: UNILATERAL (H1: campeão > controle) — o que o gate usa.
 * - `pValueTwoSided`: bilateral — o que o relatório mostra.
 * - `ci95Pp`: IC95% por inversão do mesmo teste, arredondado para fora;
 *   [−100, 100] quando o n não tem resolução para excluir nada (n ≤ 5).
 * - `nEfetivo` = pares que entraram (n − excluídos); `nNonZero` = n′, pares com
 *   diferença ≠ 0; `pMinUnilateral` = 2^−n′ deixa explícito o menor p possível
 *   (n′ = 5 → 0,031 unilateral, e o bilateral nem alcança 0,05).
 * - `signTest`: teste do sinal exato, sensibilidade.
 *
 * Determinístico: o caminho exato não sorteia nada; o Monte Carlo é semeado
 * (`seed`, default 1337) e recomputar reproduz o mesmo p. `iterations` = B.
 *
 * **Pareamento.** Posicional por padrão; com `pairKeys` o par é identificado
 * pela chave (ver {@link pairDiffs}). Observação ausente (`null`/`undefined`/
 * não-finito) em qualquer lado exclui o par dos DOIS lados (`excludedPairs`,
 * `completeness`) — nunca vira 0.
 */
export function pairedSignificance(
  controlScores: readonly PairScore[],
  championScores: readonly PairScore[],
  opts?: { iterations?: number; seed?: number; pairKeys?: string[] },
): PairedSignificance | null {
  const { diffs, nominal, excluded } = pairDiffs(controlScores, championScores, opts?.pairKeys);
  const nEfetivo = diffs.length;
  if (nEfetivo < MIN_PAIRS) return null;

  const mc = { iterations: opts?.iterations, seed: opts?.seed };
  const test = signFlipTest(diffs, mc);
  const ci = signFlipConfidenceInterval(diffs, mc);
  let positive = 0;
  let negative = 0;
  let sum = 0;
  for (const d of diffs) {
    sum += d;
    if (d > 0) positive += 1;
    else if (d < 0) negative += 1;
  }
  const meanDiff = sum / nEfetivo;

  return {
    n: nominal,
    meanDiffPp: Number((meanDiff * 100).toFixed(2)) + 0,
    ci95Pp: [floorPp(clampPp(ci.lower * 100)), ceilPp(clampPp(ci.upper * 100))],
    pValue: test.pGreater,
    pValueTwoSided: test.pTwoSided,
    nEfetivo,
    nNonZero: test.nNonZero,
    pMinUnilateral: test.pMinUnilateral,
    excludedPairs: excluded,
    completeness: Number((nEfetivo / nominal).toFixed(4)),
    method: test.method,
    ciMethod: ci.method,
    signTest: exactSignTest(positive, negative),
  };
}

// ---------------------------------------------------------------------------
// Relatório (CLI e UI usam os MESMOS helpers — o web os recebe pelo shim)
// ---------------------------------------------------------------------------

/**
 * O p que o RELATÓRIO exibe. R-04 DEC-1: unilateral só no gate, BILATERAL no
 * relatório. Sessões gravadas antes do IMPL-001 só têm o `pValue` do bootstrap
 * percentil (que nem p-valor é) — cai nele, marcado como `legacy`.
 */
export function reportPValue(sig: StoredSignificance): { p: number; kind: 'two-sided' | 'legacy' } {
  return typeof sig.pValueTwoSided === 'number'
    ? { p: sig.pValueTwoSided, kind: 'two-sided' }
    : { p: sig.pValue, kind: 'legacy' };
}

/** `p<0.001` ou `p=0.063` (3 casas) — mesmo formato no CLI e na UI. */
export function formatPValue(p: number): string {
  return p < 0.001 ? 'p<0.001' : `p=${p.toFixed(3)}`;
}

/**
 * Linha de relatório da significância: p bilateral, o p unilateral do gate, o
 * IC95 por inversão e o n que DE FATO entrou no teste (com os excluídos).
 * Ex.: `p=0.063 bilateral (gate unilateral p=0.031) · IC95 [-100.0, 100.0]pp · n=5 · exato`.
 */
export function formatSignificance(sig: StoredSignificance): string {
  const { p, kind } = reportPValue(sig);
  const ci = `IC95 [${sig.ci95Pp[0].toFixed(1)}, ${sig.ci95Pp[1].toFixed(1)}]pp`;
  if (kind === 'legacy') return `${formatPValue(p)} (bootstrap, legado) · ${ci} · n=${sig.n}`;
  const nEf = sig.nEfetivo ?? sig.n;
  const nTxt =
    sig.excludedPairs && sig.excludedPairs > 0
      ? `n=${nEf} de ${sig.n} (${sig.excludedPairs} sem observação)`
      : `n=${nEf}`;
  const method = sig.method === 'monte-carlo' ? 'Monte Carlo' : 'exato';
  return `${formatPValue(p)} bilateral (gate unilateral ${formatPValue(sig.pValue)}) · ${ci} · ${nTxt} · ${method}`;
}
