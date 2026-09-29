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
// É SUPORTE À DECISÃO; o gate da melhor de K (max-T) vive em `engine/bestOfK.ts`
// (IMPL-002) e reusa este núcleo (pmf binomial, PRNG, tetos da enumeração).
//
// IMPL-005 (R-04:REC-2): pareamento HONESTO. Par sem veredito sai dos DOIS
// lados — antes o trainer imputava 'nao' (0/0), inflando n e misturando falha
// de infraestrutura com métrica. n nominal × efetivo e completude vão para o
// record, e exclusões > 10% disparam a sensibilidade pior/melhor caso.

import type {
  IterationGate,
  MultiplicityMethod,
  ObservationCoverage,
  PairCoverage,
  PairedSignificance,
  PairSensitivity,
  RunCompleteness,
  SensitivityCase,
  SignificanceConclusion,
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
  const pairs = alignPairs(controlScores, championScores, pairKeys);
  const diffs = completeDiffs(pairs);
  return { diffs, nominal: pairs.length, excluded: pairs.length - diffs.length };
}

/** Um par nominal (controle, campeão) — qualquer lado pode estar ausente. */
interface AlignedPair {
  control: PairScore;
  champion: PairScore;
}

/** Alinha os pares nominais (posicional ou por chave — ver {@link pairDiffs}). */
function alignPairs(
  controlScores: readonly PairScore[],
  championScores: readonly PairScore[],
  pairKeys?: readonly string[],
): AlignedPair[] {
  const pairs: AlignedPair[] = [];
  if (pairKeys) {
    const champByKey = new Map<string, PairScore>();
    const nChamp = Math.min(championScores.length, pairKeys.length);
    for (let i = 0; i < nChamp; i += 1) champByKey.set(pairKeys[i], championScores[i]);
    const nominal = Math.min(controlScores.length, pairKeys.length);
    for (let i = 0; i < nominal; i += 1) {
      pairs.push({ control: controlScores[i], champion: champByKey.get(pairKeys[i]) });
    }
  } else {
    const nominal = Math.min(controlScores.length, championScores.length);
    for (let i = 0; i < nominal; i += 1) {
      pairs.push({ control: controlScores[i], champion: championScores[i] });
    }
  }
  return pairs;
}

/** Δ (campeão − controle) SÓ dos pares com observação nos dois lados. */
function completeDiffs(pairs: readonly AlignedPair[]): number[] {
  const diffs: number[] = [];
  for (const { control: c, champion: h } of pairs) if (isObs(c) && isObs(h)) diffs.push(h - c);
  return diffs;
}

// ---------------------------------------------------------------------------
// Núcleo numérico
// ---------------------------------------------------------------------------

/**
 * C(c, j)·2^−c para j = 0..c. Linha de Pascal em inteiros exatos (até c = 56 cabem
 * em 53 bits) escalada por potência de 2 (exata): as probabilidades saem diádicas
 * e EXATAS, e somas delas também — é o que garante "p exato ±1e-9" nas sondas.
 * Acima de {@link MAX_EXACT_N} (fora do uso real) vai por log para não estourar.
 * Exportada para a enumeração conjunta do gate da melhor de K (`engine/bestOfK.ts`).
 */
export function halfBinomialPmf(c: number): Float64Array {
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
 *
 * **Sensibilidade (IMPL-005).** Com exclusões > 10% de `n`, `sensitivity`
 * refaz o teste imputando os ausentes no pior caso (campeão 0, controle 1) e no
 * melhor (o inverso), com a conclusão bilateral a 5% de cada um
 * ({@link significanceConclusion}); se ela muda, `sensitivity.inconclusive`.
 */
export function pairedSignificance(
  controlScores: readonly PairScore[],
  championScores: readonly PairScore[],
  opts?: {
    iterations?: number;
    seed?: number;
    pairKeys?: string[];
    /** IMPL-054: reps por cenário — o par analítico é o CENÁRIO (reps agregadas). */
    repeatsPerScenario?: number;
    /** IMPL-050: origem do p (holdout | seleção) — gravada e sempre exibida. */
    pOrigin?: SignificanceOrigin;
  },
): PairedSignificanceResult | null {
  const m = Math.max(1, Math.floor(opts?.repeatsPerScenario ?? 1));
  // IMPL-054: repetição NÃO é observação independente. Com reps > 1 as reps de
  // um cenário são agregadas (média das observadas) e o teste pareado fica com
  // n = CENÁRIOS — antes o vetor plano dobrava o n e subestimava o erro-padrão
  // pelo design effect DE = 1+(m−1)·ICC.
  const control0 = m > 1 ? aggregateByScenario(controlScores, m) : controlScores;
  const champion0 = m > 1 ? aggregateByScenario(championScores, m) : championScores;
  const { diffs, nominal, excluded } = pairDiffs(control0, champion0, opts?.pairKeys);
  const nEfetivo = diffs.length;
  if (nEfetivo < MIN_PAIRS) return null;

  const mc = { iterations: opts?.iterations, seed: opts?.seed };
  const sensitivity = sensitivityAnalysis(
    control0,
    champion0,
    (d) => significanceCase(d, mc),
    { pairKeys: opts?.pairKeys },
  );
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
    ...(opts?.pOrigin ? { pOrigin: opts.pOrigin } : {}),
    ...(sensitivity ? { sensitivity } : {}),
  };
}

/** `PairedSignificance` + a origem do p (IMPL-050). */
export type PairedSignificanceResult = PairedSignificance & { pOrigin?: SignificanceOrigin };

// ---------------------------------------------------------------------------
// IMPL-005 (R-04:REC-2) — pareamento honesto, n efetivo e sensibilidade
// ---------------------------------------------------------------------------

/**
 * Exclusões ACIMA desta fração dos pares tornam obrigatória a análise de
 * sensibilidade (R-04:REC-2: "quando exclusões > 10%"). Limiar da pesquisa,
 * gravado em `PairSensitivity.threshold` para a decisão ser reproduzível.
 */
export const SENSITIVITY_EXCLUSION_THRESHOLD = 0.1;
/** α da CONCLUSÃO do relatório — bilateral, como o p que ele exibe (R-04 DEC-1). */
export const REPORT_ALPHA = 0.05;
/** Extremos da escala de {@link VERDICT_SCORE}: pior caso = 'nao', melhor = 'resolve'. */
const SCORE_FLOOR = VERDICT_SCORE.nao;
const SCORE_CEIL = VERDICT_SCORE.resolve;

const round2 = (x: number): number => Number(x.toFixed(2)) + 0;
const round4 = (x: number): number => Number(x.toFixed(4)) + 0;
const meanOf = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
};
const exceeds = (excluded: number, nominal: number, threshold: number): boolean =>
  nominal > 0 && excluded / nominal > threshold;

/**
 * Δ de TODOS os pares nominais com os ausentes imputados no extremo — só para
 * a sensibilidade, NUNCA para o Δ/teste reportados. `worst`: o campeão perde
 * todo ausente (0) e o controle ganha todo ausente (1); `best`: o inverso.
 */
function extremeDiffs(pairs: readonly AlignedPair[], scenario: 'worst' | 'best'): number[] {
  const controlMissing = scenario === 'worst' ? SCORE_CEIL : SCORE_FLOOR;
  const championMissing = scenario === 'worst' ? SCORE_FLOOR : SCORE_CEIL;
  return pairs.map(
    ({ control: c, champion: h }) =>
      (isObs(h) ? h : championMissing) - (isObs(c) ? c : controlMissing),
  );
}

/**
 * Scores (controle, campeão) de TODOS os pares nominais (posicionais) com os
 * ausentes imputados no extremo — mesma regra de {@link extremeDiffs}. O gate
 * da melhor de K (IMPL-002) precisa dos SCORES, não só das diferenças, para
 * refazer o max-T conjunto no pior/melhor caso.
 */
export function imputeExtremes(
  controlScores: readonly PairScore[],
  championScores: readonly PairScore[],
  scenario: 'worst' | 'best',
): { control: number[]; champion: number[] } {
  const controlMissing = scenario === 'worst' ? SCORE_CEIL : SCORE_FLOOR;
  const championMissing = scenario === 'worst' ? SCORE_FLOOR : SCORE_CEIL;
  const pairs = alignPairs(controlScores, championScores);
  return {
    control: pairs.map(({ control: c }) => (isObs(c) ? c : controlMissing)),
    champion: pairs.map(({ champion: h }) => (isObs(h) ? h : championMissing)),
  };
}

/**
 * Cobertura do pareamento campeão × controle: n nominal, n efetivo, pares
 * excluídos (dos DOIS lados), completude e as médias SÓ sobre os pares
 * completos — é o Δ honesto que o gate e o holdout usam. Com exclusões > 10%
 * acrescenta o Δ nos extremos (`worstMeanDiffPp`/`bestMeanDiffPp`).
 */
export function pairCoverage(
  controlScores: readonly PairScore[],
  championScores: readonly PairScore[],
  opts?: { pairKeys?: readonly string[]; threshold?: number },
): PairCoverage {
  const pairs = alignPairs(controlScores, championScores, opts?.pairKeys);
  const n = pairs.length;
  let nEfetivo = 0;
  let sumControl = 0;
  let sumChampion = 0;
  for (const { control: c, champion: h } of pairs) {
    if (!isObs(c) || !isObs(h)) continue;
    nEfetivo += 1;
    sumControl += c;
    sumChampion += h;
  }
  const excludedPairs = n - nEfetivo;
  const cov: PairCoverage = {
    n,
    nEfetivo,
    excludedPairs,
    completeness: n > 0 ? round4(nEfetivo / n) : 1,
    controlMeanPp: nEfetivo > 0 ? round2((sumControl / nEfetivo) * 100) : null,
    championMeanPp: nEfetivo > 0 ? round2((sumChampion / nEfetivo) * 100) : null,
    meanDiffPp: nEfetivo > 0 ? round2(((sumChampion - sumControl) / nEfetivo) * 100) : null,
  };
  if (exceeds(excludedPairs, n, opts?.threshold ?? SENSITIVITY_EXCLUSION_THRESHOLD)) {
    cov.worstMeanDiffPp = round2(meanOf(extremeDiffs(pairs, 'worst')) * 100);
    cov.bestMeanDiffPp = round2(meanOf(extremeDiffs(pairs, 'best')) * 100);
  }
  return cov;
}

/**
 * Análise de sensibilidade pior/melhor caso (R-04:REC-2). `undefined` enquanto
 * as exclusões não passam do limiar (10%). Senão aplica `conclude` a três
 * vetores de Δ — os pares completos (observado) e TODOS os pares com os
 * ausentes nos extremos — e marca `inconclusive` se a conclusão de algum
 * extremo difere da observada. Genérica na conclusão: o relatório usa
 * {@link significanceConclusion}; o gate de promoção usa Δ ≥ minGain.
 */
export function sensitivityAnalysis<C extends string>(
  controlScores: readonly PairScore[],
  championScores: readonly PairScore[],
  conclude: (diffs: readonly number[]) => SensitivityCase<C>,
  opts?: { pairKeys?: readonly string[]; threshold?: number },
): PairSensitivity<C> | undefined {
  const threshold = opts?.threshold ?? SENSITIVITY_EXCLUSION_THRESHOLD;
  const pairs = alignPairs(controlScores, championScores, opts?.pairKeys);
  const observedDiffs = completeDiffs(pairs);
  const excluded = pairs.length - observedDiffs.length;
  if (!exceeds(excluded, pairs.length, threshold)) return undefined;
  const observed = conclude(observedDiffs);
  const worst = conclude(extremeDiffs(pairs, 'worst'));
  const best = conclude(extremeDiffs(pairs, 'best'));
  return {
    excludedFraction: round4(excluded / pairs.length),
    threshold,
    observed,
    worst,
    best,
    inconclusive: worst.conclusion !== observed.conclusion || best.conclusion !== observed.conclusion,
  };
}

/**
 * Conclusão do RELATÓRIO: bilateral a {@link REPORT_ALPHA} (o relatório mostra
 * o p bilateral — R-04 DEC-1), com a direção dada pelo sinal do Δ.
 */
export function significanceConclusion(
  meanDiff: number,
  pValueTwoSided: number,
  alpha = REPORT_ALPHA,
): SignificanceConclusion {
  if (!(pValueTwoSided < alpha) || meanDiff === 0) return 'no-difference';
  return meanDiff > 0 ? 'better' : 'worse';
}

function significanceCase(
  diffs: readonly number[],
  mc: { iterations?: number; seed?: number },
): SensitivityCase<SignificanceConclusion> {
  const test = signFlipTest(diffs, mc);
  const mean = meanOf(diffs);
  return {
    meanDiffPp: round2(mean * 100),
    pValue: test.pGreater,
    pValueTwoSided: test.pTwoSided,
    conclusion: significanceConclusion(mean, test.pTwoSided),
  };
}

// --- Extração dos vereditos por etapa (o que o pareamento lê do record) -----

/** Veredito(s) de UM juiz de etapa, no mínimo que o pareamento lê. */
interface StageVerdictMapLike {
  verdictByContestant?: Readonly<Record<string, Verdict>>;
  /**
   * Motivo do veredito AUSENTE (IMPL-004, cluster `judge`): lido só para o
   * relatório de completude. Tipado estruturalmente para aceitar o
   * `VerdictError` sem acoplar este módulo ao union de motivos.
   */
  verdictErrorByContestant?: Readonly<Record<string, { kind: string }>>;
  /**
   * Veredito de CADA repetição (IMPL-054, §18.4): contestantId → vetor de reps.
   * Presente quando a etapa rodou com `agent.repetitions > 1`.
   */
  verdictsByRep?: Readonly<Record<string, readonly (Verdict | undefined)[]>>;
}

/**
 * O mínimo de uma etapa que o pareamento lê. Estrutural de propósito: o
 * `StageRecord` do Node e o do web (mirror de tipos) passam sem conversão.
 */
export interface StageVerdictsLike {
  error?: string;
  incomplete?: boolean;
  referenceJudge?: StageVerdictMapLike;
  judge?: StageVerdictMapLike;
}

/**
 * Régua PRIMÁRIA da run: com julgamento por referência em alguma etapa válida,
 * o judge-score só usa vereditos pointwise (é o que o orchestrator agrega em
 * `judgeScoreByContestant`); sem nenhum, a régua é o listwise legado. O
 * pareamento mede na MESMA régua do judge-score — misturar as duas daria um Δ
 * de uma escala e um gate de outra.
 */
export function primaryRuler(stages: readonly StageVerdictsLike[]): 'reference' | 'listwise' {
  return stages.some((s) => !s.incomplete && s.referenceJudge) ? 'reference' : 'listwise';
}

const isVerdict = (v: unknown): v is Verdict => v === 'resolve' || v === 'parcial' || v === 'nao';

/** Observação de um contestant numa etapa: o veredito, ou o motivo de não haver. */
function stageObservation(
  stage: StageVerdictsLike,
  contestantId: string,
  ruler: 'reference' | 'listwise',
): { verdict: Verdict } | { reason: string } {
  // Etapa cortada (orçamento/cancelamento) está fora do placar e das médias.
  if (stage.incomplete) return { reason: 'stage_incomplete' };
  const bearer = ruler === 'reference' ? stage.referenceJudge : stage.judge;
  const v = bearer?.verdictByContestant?.[contestantId];
  if (isVerdict(v)) return { verdict: v };
  const kind = bearer?.verdictErrorByContestant?.[contestantId]?.kind;
  if (kind) return { reason: kind };
  if (stage.error) return { reason: 'stage_error' };
  if (ruler === 'reference' && !stage.referenceJudge) return { reason: 'no_reference' };
  return { reason: 'no_verdict' };
}

/**
 * Score por etapa (escala 0–1 de {@link VERDICT_SCORE}) de cada contestant, na
 * régua primária da run. Etapa sem veredito vira `null` — "sem observação",
 * NUNCA 'nao' (IMPL-005: antes `VERDICT_SCORE[v ?? 'nao']` imputava 0).
 */
export function stageScoresByContestant(
  stages: readonly StageVerdictsLike[],
  contestantIds: readonly string[],
): Record<string, PairScore[]> {
  const ruler = primaryRuler(stages);
  const out: Record<string, PairScore[]> = {};
  for (const id of contestantIds) {
    out[id] = stages.map((s) => {
      const obs = stageObservation(s, id, ruler);
      return 'verdict' in obs ? VERDICT_SCORE[obs.verdict] : null;
    });
  }
  return out;
}

/**
 * Scores por etapa de controle e campeão, posição a posição, para o teste
 * pareado. Veredito ausente em qualquer lado vira `null` e o par sai dos DOIS
 * lados em {@link pairedSignificance}/{@link pairCoverage} — antes era imputado
 * como 'nao' (0/0), inflando n e misturando falha de infra com métrica.
 */
export function pairedStageScores(
  stages: readonly StageVerdictsLike[],
  controlId: string,
  championId: string,
): { controlScores: PairScore[]; championScores: PairScore[] } {
  const m = stageScoresByContestant(stages, [controlId, championId]);
  return { controlScores: m[controlId], championScores: m[championId] };
}

/** Réguas de uma run, em ordem de precedência (holdout > iteração > base). */
export const CONTROL_IDS = ['holdout-control', 'carry', 'original'] as const;

/** A régua da run (quem é o controle do pareamento), se existir. */
export function controlIdOf(contestantIds: readonly string[]): string | undefined {
  return CONTROL_IDS.find((id) => contestantIds.includes(id));
}

/**
 * Completude da run (IMPL-005): por contestant, n nominal (todas as etapas,
 * inclusive puladas/cortadas) × n efetivo (etapas com veredito na régua
 * primária) e o motivo de cada ausência; com régua na run, o pareamento de cada
 * contestant com ela. Puro: o orchestrator grava no record e `runs show`
 * recalcula para runs antigas.
 */
export function runCompleteness(run: {
  stages: readonly StageVerdictsLike[];
  contestants: readonly { id: string }[];
}): RunCompleteness {
  const ruler = primaryRuler(run.stages);
  const ids = run.contestants.map((c) => c.id);
  const n = run.stages.length;
  const byContestant: Record<string, ObservationCoverage> = {};
  const scores: Record<string, PairScore[]> = {};
  for (const id of ids) {
    const reasons: Record<string, number> = {};
    const sc: PairScore[] = [];
    let nEfetivo = 0;
    for (const s of run.stages) {
      const obs = stageObservation(s, id, ruler);
      if ('verdict' in obs) {
        nEfetivo += 1;
        sc.push(VERDICT_SCORE[obs.verdict]);
      } else {
        reasons[obs.reason] = (reasons[obs.reason] ?? 0) + 1;
        sc.push(null);
      }
    }
    byContestant[id] = {
      n,
      nEfetivo,
      missing: n - nEfetivo,
      completeness: n > 0 ? round4(nEfetivo / n) : 1,
      ...(n - nEfetivo > 0 ? { missingByReason: reasons } : {}),
    };
    scores[id] = sc;
  }
  const out: RunCompleteness = { n, ruler, byContestant };
  const controlId = controlIdOf(ids);
  if (controlId) {
    out.controlId = controlId;
    out.vsControl = Object.fromEntries(
      ids.filter((id) => id !== controlId).map((id) => [id, pairCoverage(scores[controlId], scores[id])]),
    );
  }
  return out;
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
 * IC95 por inversão, o n que DE FATO entrou no teste (com os excluídos) e a
 * ORIGEM do p (IMPL-050 — holdout | seleção | sem p, sempre rotulada).
 * Ex.: `p=0.063 bilateral (gate unilateral p=0.031) · IC95 [-100.0, 100.0]pp · n=5 · exato · origem do p: seleção (anti-conservador)`.
 */
export function formatSignificance(sig: SignificanceWithOrigin): string {
  const { p, kind } = reportPValue(sig);
  const ci = `IC95 [${sig.ci95Pp[0].toFixed(1)}, ${sig.ci95Pp[1].toFixed(1)}]pp`;
  const origem = ` · origem do p: ${ORIGIN_LABEL[significanceOrigin(sig)]}`;
  if (kind === 'legacy') return `${formatPValue(p)} (bootstrap, legado) · ${ci} · n=${sig.n}${origem}`;
  const nEf = sig.nEfetivo ?? sig.n;
  const nTxt =
    sig.excludedPairs && sig.excludedPairs > 0
      ? `n=${nEf} de ${sig.n} (${sig.excludedPairs} sem observação)`
      : `n=${nEf}`;
  const method = sig.method === 'monte-carlo' ? 'Monte Carlo' : 'exato';
  const base = `${formatPValue(p)} bilateral (gate unilateral ${formatPValue(sig.pValue)}) · ${ci} · ${nTxt} · ${method}`;
  const s = sig.sensitivity;
  if (!s) return base + origem;
  // IMPL-005: exclusões > 10% — a conclusão só vale se sobreviver aos extremos.
  return (
    `${base} · sensibilidade (${fmtPct(s.excludedFraction)} excluídos): ` +
    `pior Δ ${fmtSignedPp(s.worst.meanDiffPp)}, melhor Δ ${fmtSignedPp(s.best.meanDiffPp)} → ` +
    (s.inconclusive ? 'INCONCLUSIVO' : 'conclusão robusta') +
    origem
  );
}

/** O que a linha do gate da melhor de K mostra (gate gravado ou evento `iteration.promoted`). */
export interface GateSummaryLike {
  /** Ganho BRUTO (p.p.) — o máximo entre K. */
  gainPp: number;
  /** Ganho corrigido do winner's curse (p.p.). */
  gainCorrectedPp?: number;
  /** p ajustado (FWER) da melhor. */
  pAdjusted?: number;
  /** Variantes testadas. */
  k?: number;
  method?: MultiplicityMethod;
  enumeration?: SignificanceMethod;
  minGain?: number;
  minGainSource?: 'config' | 'default';
}

/**
 * Linha do gate da melhor de K (IMPL-002, R-04:REC-3): ganho BRUTO e CORRIGIDO
 * lado a lado com o p AJUSTADO — o mesmo texto no CLI, no log do treino e na UI.
 * Ex.: `ganho bruto +18.8pp (máximo entre 4) · corrigido +6.2pp · p ajustado=0.031
 * (max-T, exato) · margem 6.25pp (auto)`. Gates antigos (sem teste) mostram só o Δ.
 */
export function formatGateSummary(g: GateSummaryLike): string {
  const parts = [
    typeof g.k === 'number' && g.k > 1
      ? `ganho bruto ${fmtSignedPp(g.gainPp)} (máximo entre ${g.k})`
      : `ganho ${fmtSignedPp(g.gainPp)}`,
  ];
  if (typeof g.gainCorrectedPp === 'number' && typeof g.k === 'number' && g.k > 1) {
    parts.push(`corrigido ${fmtSignedPp(g.gainCorrectedPp)}`);
  }
  if (typeof g.pAdjusted === 'number') {
    const how = [g.method === 'holm' ? 'Holm' : 'max-T', g.enumeration === 'monte-carlo' ? 'Monte Carlo' : g.enumeration ? 'exato' : '']
      .filter(Boolean)
      .join(', ');
    parts.push(`${formatPValue(g.pAdjusted).replace('p', 'p ajustado')} (${how})`);
  }
  if (typeof g.minGain === 'number') {
    parts.push(`margem ${g.minGain.toFixed(2).replace(/\.?0+$/, '')}pp${g.minGainSource === 'default' ? ' (auto)' : ''}`);
  }
  return parts.join(' · ');
}

const GATE_DECISION_LABEL: Record<IterationGate['decision'], string> = {
  promoted: 'promovida',
  held: 'mantida a régua',
  inconclusive: 'INCONCLUSIVO',
};

/**
 * Linha completa do gate de uma iteração: decisão, a linha de
 * {@link formatGateSummary} e, quando segurou, o que segurou.
 */
export function formatIterationGate(gate: IterationGate): string {
  const summary = formatGateSummary({
    gainPp: gate.gainPp,
    gainCorrectedPp: gate.gainCorrectedPp,
    pAdjusted: gate.test?.pAdjusted,
    k: gate.test?.k,
    method: gate.test?.method,
    enumeration: gate.test?.enumeration,
    minGain: gate.minGain,
    minGainSource: gate.minGainSource,
  });
  const why = (gate.heldBy ?? []).map((r) =>
    r === 'no-pairs'
      ? 'sem par completo'
      : r === 'min-gain'
        ? `Δ abaixo da margem`
        : r === 'reeval'
          ? formatReevalHold(gate.reeval)
          : `p ajustado > ${gate.test?.alpha ?? 0.05}`,
  );
  // IMPL-013: promoção só vale depois da re-avaliação limpa — o Δ dela fica visível.
  const reeval = gate.reeval?.confirmed
    ? ` — confirmado na re-avaliação limpa (Δ ${fmtSignedPp(gate.reeval.gainPp)} em ${gate.reeval.pairing?.nEfetivo ?? gate.reeval.size} cenários)`
    : '';
  // cli#8: re-avaliação que NÃO terminou não é evidência — a decisão segue
  // 'held' (nada promovido), mas o rótulo diz que ela foi interrompida.
  const label = gate.reeval?.runStatus ? `${GATE_DECISION_LABEL[gate.decision]} (re-avaliação interrompida)` : GATE_DECISION_LABEL[gate.decision];
  return `${label}: ${summary}${why.length && gate.decision !== 'inconclusive' ? ` — segurou: ${why.join(', ')}` : ''}${reeval}`;
}

/**
 * Por que a re-avaliação limpa segurou (IMPL-013). cli#8: quando a run dela
 * NÃO terminou (`runStatus` — cancelada, sem orçamento, erro) não houve
 * comparação nenhuma: nada de "Δ +0.0pp em 5 cenários" inventado (o 0 é o
 * default e o 5 era o tamanho PLANEJADO do minibatch). O n exibido é o de
 * pares completos que de fato entraram (`pairing.nEfetivo`).
 */
function formatReevalHold(r: IterationGate['reeval']): string {
  if (!r) return 're-avaliação limpa não confirmou';
  if (r.runStatus) return `re-avaliação limpa interrompida (run ${r.runStatus}) — sem evidência`;
  if (!r.runId) return 're-avaliação limpa não rodou (sem régua, candidato ou cenário de treino) — sem evidência';
  const n = r.pairing?.nEfetivo ?? r.size;
  return `re-avaliação limpa não confirmou (Δ ${fmtSignedPp(r.gainPp)} em ${n} cenários)`;
}

/** `80%` / `62.5%` — completude e frações no relatório. */
const fmtPct = (x: number): string => `${(x * 100).toFixed(1).replace(/\.0$/, '')}%`;
/** `+12.5pp` / `-7.5pp`. */
const fmtSignedPp = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(1)}pp`;

/**
 * Linha de relatório de um pareamento (IMPL-005): a diferença entre n nominal
 * e n efetivo SEMPRE visível — mesmo sem exclusão ("n efetivo 10 de 10").
 * Ex.: `n efetivo 8 de 10 (2 pares excluídos, completude 80%) · Δ +12.5pp ·
 * sensibilidade: pior -7.5pp, melhor +22.5pp`.
 */
export function formatPairCoverage(
  c: Pick<PairCoverage, 'n' | 'nEfetivo' | 'excludedPairs' | 'completeness'> & Partial<PairCoverage>,
): string {
  const excl = c.excludedPairs === 1 ? '1 par excluído' : `${c.excludedPairs} pares excluídos`;
  let s = `n efetivo ${c.nEfetivo} de ${c.n} (${excl}, completude ${fmtPct(c.completeness)})`;
  if (c.meanDiffPp !== undefined && c.meanDiffPp !== null) s += ` · Δ ${fmtSignedPp(c.meanDiffPp)}`;
  if (c.worstMeanDiffPp !== undefined && c.bestMeanDiffPp !== undefined) {
    s += ` · sensibilidade: pior ${fmtSignedPp(c.worstMeanDiffPp)}, melhor ${fmtSignedPp(c.bestMeanDiffPp)}`;
  }
  return s;
}

/**
 * Linhas de texto da completude de uma run (`runs show`): n nominal × efetivo
 * por contestant (com os motivos das ausências) e o pareamento com a régua.
 */
export function formatRunCompleteness(
  c: RunCompleteness,
  labelOf: (id: string) => string = (id) => id,
): string[] {
  const lines = [`observações (régua ${c.ruler === 'reference' ? 'por referência' : 'listwise'}): n nominal ${c.n}`];
  for (const [id, o] of Object.entries(c.byContestant)) {
    const motivos = o.missingByReason
      ? ` — sem veredito: ${Object.entries(o.missingByReason)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')}`
      : '';
    lines.push(`  ${labelOf(id)}: n efetivo ${o.nEfetivo} de ${o.n} (completude ${fmtPct(o.completeness)})${motivos}`);
  }
  if (c.controlId && c.vsControl) {
    lines.push(`pares com a régua (${labelOf(c.controlId)}):`);
    for (const [id, p] of Object.entries(c.vsControl)) lines.push(`  ${labelOf(id)}: ${formatPairCoverage(p)}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// IMPL-050 (R-04:REC-5) — poder estatístico: Δ detectável, n para um Δ alvo
// ---------------------------------------------------------------------------

/**
 * Poder planejado padrão (1−β = 0,8) e α unilateral do teste final/planejamento.
 * O gate de recomendação é direcional ("o candidato é melhor?"), então o
 * planejamento usa α UNILATERAL — ~16% menos n que o bilateral (R-04 DEC-3).
 */
export const POWER_TARGET = 0.8;
export const POWER_ALPHA = 0.05;
/**
 * σd default das DIFERENÇAS pareadas (escala 0–1) quando não há run-piloto.
 * 0,5 = desvio-padrão de um veredito ~Bernoulli(0,5) — pior caso plausível de
 * uma diferença de scores ternários centrada em 0. ⚠️ É fallback, nunca régua:
 * o planejamento real deve calibrar σd numa run-piloto
 * ({@link sigmaFromPilot}) — ver {@link POWER_UNCALIBRATED}.
 */
export const DEFAULT_SIGMA_D = 0.5;
/** Marca honesta do planejamento sem σd calibrado (R-04:REC-5). */
export const POWER_UNCALIBRATED = 'estimativa não calibrada';

const zOf = (p: number): number => invNormalCdf(p);

/**
 * σd estimado de uma run-piloto pelo LIMITE SUPERIOR do IC (R-04:REC-5:
 * "planejando pelo limite superior do IC; nunca tabela fixa σ=0,5").
 *
 * O IC95% do Δ dá o erro-padrão (meia-amplitude / z_{0,975}); o desvio-padrão
 * das diferenças sai por s = SE·√n e o limite SUPERIOR de confiança (95%) de s
 * é s·√((n−1)/χ²_{0,05;n−1}). Planejar por ele é o conservador honesto com n
 * pequeno. Com n < 2 (sem dispersão conhecível) devolve o fallback.
 */
export function sigmaFromPilot(
  ci95Pp: readonly [number, number],
  n: number,
  fallback = DEFAULT_SIGMA_D,
): number {
  const nn = Math.max(0, Math.floor(n));
  if (nn < 2 || !Number.isFinite(ci95Pp[0]) || !Number.isFinite(ci95Pp[1])) return fallback;
  // O IC vem em p.p. (×100); σd vive na escala 0–1.
  const half = Math.abs(ci95Pp[1] - ci95Pp[0]) / 2 / 100;
  if (!(half > 0)) return fallback;
  const se = half / zOf(0.975); // escala 0–1
  const s = se * Math.sqrt(nn);
  const chi2Low = chi2Quantile(0.05, nn - 1);
  if (!(chi2Low > 0)) return fallback;
  return Math.min(1, s * Math.sqrt((nn - 1) / chi2Low));
}

/**
 * Menor Δ (p.p.) detectável com `n` cenários pareados, poder `power` e α
 * `alpha` unilateral: (z_{1−α} + z_{power})·σd/√n. Ex.: n = 5 e σd = 0,5 →
 * 55,6 p.p. — com 5 cenários só se detectam efeitos ENORMES (R-04:REC-5).
 */
export function deltaDetectavelPp(
  n: number,
  sigmaD: number = DEFAULT_SIGMA_D,
  opts?: { alpha?: number; power?: number },
): number {
  const nn = Math.max(1, Math.floor(n));
  const alpha = opts?.alpha ?? POWER_ALPHA;
  const power = opts?.power ?? POWER_TARGET;
  return ((zOf(1 - alpha) + zOf(power)) * sigmaD) / Math.sqrt(nn) * 100;
}

/**
 * n de cenários para detectar `deltaPp` com `power` a α `alpha` unilateral:
 * ⌈((z_{1−α} + z_{power})·σd/Δ)²⌉. Ex.: Δ = 20 p.p., σd = 0,5 → 39 cenários.
 */
export function nParaDeltaPp(
  deltaPp: number,
  sigmaD: number = DEFAULT_SIGMA_D,
  opts?: { alpha?: number; power?: number },
): number {
  const d = Math.abs(deltaPp) / 100;
  if (!(d > 0)) return Infinity;
  const alpha = opts?.alpha ?? POWER_ALPHA;
  const power = opts?.power ?? POWER_TARGET;
  return Math.ceil(((zOf(1 - alpha) + zOf(power)) * sigmaD / d) ** 2);
}

/** Plano de amostra (o que `prompt-builder estimate` publica). */
export interface PowerPlan {
  /** Cenários configurados (o n do plano). */
  n: number;
  /** α unilateral do planejamento. */
  alpha: number;
  power: number;
  /** σd usado (escala 0–1). */
  sigmaD: number;
  /** `pilot` = calibrado de run-piloto (limite superior do IC); `fallback` = tabela. */
  sigmaSource: 'pilot' | 'fallback';
  /** Menor Δ (p.p.) detectável com o n configurado. */
  deltaDetectavelPp: number;
  /** Δ alvo (p.p.) do planejamento de n; default 20. */
  targetDeltaPp: number;
  /** n para detectar `targetDeltaPp`. */
  nParaDelta: number;
  /** true quando σd veio de fallback — o relatório MARCA como não calibrado. */
  uncalibrated: boolean;
}

/**
 * Plano de poder para o n configurado. Com `pilotCi95Pp` + `pilotN` o σd vem da
 * run-piloto (limite superior do IC); sem ele usa {@link DEFAULT_SIGMA_D} e o
 * resultado sai marcado {@link POWER_UNCALIBRATED}.
 */
export function planPower(input: {
  n: number;
  sigmaD?: number;
  pilotCi95Pp?: readonly [number, number];
  pilotN?: number;
  alpha?: number;
  power?: number;
  targetDeltaPp?: number;
}): PowerPlan {
  const alpha = input.alpha ?? POWER_ALPHA;
  const power = input.power ?? POWER_TARGET;
  const fallback = input.sigmaD ?? DEFAULT_SIGMA_D;
  const fromPilot = input.pilotCi95Pp && input.pilotN ? sigmaFromPilot(input.pilotCi95Pp, input.pilotN, fallback) : undefined;
  const sigmaD = fromPilot ?? fallback;
  return {
    n: Math.max(0, Math.floor(input.n)),
    alpha,
    power,
    sigmaD,
    sigmaSource: fromPilot !== undefined ? 'pilot' : 'fallback',
    deltaDetectavelPp: round2(deltaDetectavelPp(Math.max(1, Math.floor(input.n)), sigmaD, { alpha, power })),
    targetDeltaPp: input.targetDeltaPp ?? 20,
    nParaDelta: nParaDeltaPp(input.targetDeltaPp ?? 20, sigmaD, { alpha, power }),
    uncalibrated: fromPilot === undefined,
  };
}

/**
 * Linhas de relatório do plano de poder — com dígitos em toda probabilidade
 * (nada de "provável"/"significativo" solto: R-11a:REC-4).
 */
export function formatPowerPlan(p: PowerPlan): string[] {
  const pct = (x: number): string => `${Math.round(x * 100)}%`;
  const lines = [
    `poder: Δ detectável ≥ ${fmtPpText(p.deltaDetectavelPp)} p.p. com n=${p.n} (α=${p.alpha}, poder ${pct(p.power)}, unilateral)`,
    `n para Δ=${fmtPpText(p.targetDeltaPp)} p.p.: ${p.nParaDelta} cenários (σd=${p.sigmaD.toFixed(2)})`,
  ];
  if (p.uncalibrated) {
    lines.push(
      `σd ${POWER_UNCALIBRATED} (${DEFAULT_SIGMA_D.toFixed(2)} por tabela; calibre com run-piloto — o IC do piloto traz o limite superior)`,
    );
  } else {
    lines.push(`σd=${p.sigmaD.toFixed(2)} calibrado de run-piloto (limite superior do IC)`);
  }
  return lines;
}

/** `2` / `2,5` — p.p. em texto PT-BR (sem decimal desnecessário). */
function fmtPpText(x: number): string {
  const r = Math.round(x * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1).replace('.', ',');
}

// ---------------------------------------------------------------------------
// Núcleo numérico auxiliar: normal padrão e qui-quadrado (poder e limites)
// ---------------------------------------------------------------------------

/**
 * Φ(z) — CDF da normal padrão via erf (Abramowitz & Stegun 7.1.26, |erro| < 1,5e-7).
 */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return clamp01(0.5 * (1 + Math.sign(z) * erf));
}

/**
 * Φ⁻¹(p) — inversa da CDF normal (Acklam) + 1 passo de Halley. Usada pelo
 * planejamento de poder e pelo intervalo paramétrico do Δ.
 */
export function invNormalCdf(p: number): number {
  if (!(p > 0 && p < 1)) return p >= 1 ? Infinity : -Infinity;
  const a = [-39.696830286653757, 220.9460984245205, -275.92851044696869, 138.357751867269, -30.66479806614716, 2.5066282774592392];
  const b = [-54.476098798224058, 161.58583685804089, -155.69897985988661, 66.80131188771972, -13.280681552885721];
  const c = [-0.0077848940024302926, -0.32239645804113648, -2.4007582771618381, -2.5497325393437338, 4.3746641414649678, 2.9381639826987831];
  const d = [0.0077846957090414622, 0.32246712907003983, 2.4451341137772671, 3.7544086619074162];
  const pl = 0.02425;
  let q: number;
  let r: number;
  let x: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pl) {
    q = p - 0.5;
    r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // Um passo de Halley: erro residual < 1e-9 (suficiente para teste de unidade).
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/** P(a, x) regularizada inferior — série + fração contínuda (Numerical Recipes). */
function regularizedGammaP(a: number, x: number): number {
  if (!(x > 0) || !(a > 0)) return 0;
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 1; n <= 200; n += 1) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-12) break;
    }
    return clamp01(sum * Math.exp(-x + a * Math.log(x) - logGamma(a)));
  }
  // Fração contínua para o complemento (x ≥ a+1).
  let b = x + 1 - a;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 200; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return clamp01(1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * h);
}

/** log Γ(x) — aproximação de Lanczos (g = 7). */
function logGamma(x: number): number {
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = g[0];
  const t = x + 7.5;
  for (let i = 1; i < g.length; i += 1) a += g[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Quantil da qui-quadrado por bisseção sobre P regularizada (df > 0). */
export function chi2Quantile(p: number, df: number): number {
  if (!(df > 0)) return Number.NaN;
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  let lo = 0;
  let hi = Math.max(2 * df, 16);
  while (regularizedGammaP(df / 2, hi / 2) < p && hi < 1e12) hi *= 2;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (regularizedGammaP(df / 2, mid / 2) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** P(a, b, x) regularizada (fração contínua de Lentz + logGamma). */
function regularizedBetaP(a: number, b: number, x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  const lnBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta);
  const useCF = x < (a + 1) / (a + b + 2);
  const aa = useCF ? a : b;
  const bb = useCF ? b : a;
  const xx = useCF ? x : 1 - x;
  // Fração contínua (betacf, Numerical Recipes).
  let c = 1;
  let d = 1 - ((aa + bb) * xx) / (aa + 1);
  if (Math.abs(d) < 1e-300) d = 1e-300;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    const num1 = (m * (bb - m) * xx) / ((aa + m2 - 1) * (aa + m2));
    d = 1 + num1 * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + num1 / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    h *= d * c;
    const num2 = (-((aa + m) * (aa + bb + m) * xx)) / ((aa + m2) * (aa + m2 + 1));
    d = 1 + num2 * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + num2 / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  const value = (front * h) / aa;
  return clamp01(useCF ? value : 1 - value);
}

/**
 * Quantil bilateral da t de Student: `tOf(conf, df)` tal que P(|T| ≤ t) = conf.
 * Bissecção sobre a CDF (incomplete beta). Usado pelo IC do Δ — com n pequeno a
 * normal subestima as caudas ("don't use the CLT with fewer than a few hundred
 * datapoints") e a recomendação falsa passaria do α nominal.
 */
export function studentTCritical(conf: number, df: number): number {
  if (!(df > 0)) return Infinity;
  if (df > 1e6) return invNormalCdf((1 + conf) / 2);
  const target = 1 - (1 - conf) / 2; // CDF no quantil superior
  let lo = 0;
  let hi = 1;
  const cdf = (t: number): number =>
    1 - 0.5 * regularizedBetaP(df / 2, 0.5, df / (df + t * t));
  while (cdf(hi) < target && hi < 1e6) hi *= 2;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// IMPL-046 (R-11a:REC-4) — regra de RECUSA de recomendação (veredito estável)
// ---------------------------------------------------------------------------

/** Condição que segurou a recomendação (auditoria + texto honesto). */
export type RecommendationHoldReason =
  | 'no-pairs'
  | 'ci-covers-zero'
  | 'low-superiority'
  | 'below-granularity';

/**
 * Veredito de recomendação — MESMO shape para CLI e UI (o web o recebe pelo
 * shim de `stats`). `winner` só existe quando `verdict === 'conclusivo'`.
 */
export interface RecommendationDecision {
  /** Recomendado (rótulo); `undefined` = RECUSA (empate técnico/inconclusivo). */
  winner: string | undefined;
  /** Régua da decisão: judge-score com IC — nunca "sensação". */
  ruler: 'judge-score+ci';
  /** IC95% do Δ (candidato − controle) em p.p. */
  ci95: [number, number];
  /** P(Δ > 0) — probabilidade de superioridade do candidato. */
  p_superiority: number;
  verdict: 'conclusivo' | 'inconclusivo';
  /** Δ observado (candidato − controle) em p.p. */
  deltaPp: number;
  /** Pares com veredito nos DOIS lados (a unidade é o cenário). */
  nEfetivo: number;
  /** Granularidade mínima de Δ: 100/nEfetivo p.p. */
  granularityPp: number;
  /** Limiar de P(superioridade) aplicado. */
  minPSuperiority: number;
  /** O que segurou (vazio = conclusivo). */
  holds: RecommendationHoldReason[];
  /** n sugerido para detectar `targetDeltaPp` com 80% de poder (sempre presente). */
  suggestedN: number;
  /** Δ alvo (p.p.) da sugestão de n. */
  targetDeltaPp: number;
  /** Texto honesto — toda probabilidade vem com dígito adjacente. */
  text: string;
}

export interface RecommendationOpts {
  labels?: { candidate: string; control: string };
  /** K candidatos comparados ("melhor de K"): o IC sai com α/k (Bonferroni). */
  k?: number;
  /** Limiar de P(superioridade). Default 0,8 (R-11a:REC-4). */
  minPSuperiority?: number;
  alpha?: number;
  /** Δ alvo (p.p.) para a sugestão de n. Default 20. */
  targetDeltaPp?: number;
  power?: number;
  sigmaD?: number;
}

/**
 * Resumo paramétrico do Δ pareado (IC t com correção da melhor de K). O
 * `pSuperiority` é Φ(Δ/SE) — a probabilidade de o candidato ser melhor; com
 * SE = 0 o Δ é exato (0/0,5/1 sem dispersão) e a probabilidade é 1/0/0,5.
 * O IC usa a t de Student (n−1 gl) — com n pequeno a normal subestima as caudas
 * e a recomendação falsa passaria do α nominal (verificado no harness H0).
 */
export function meanCiSummary(
  diffs: readonly number[],
  opts?: { alpha?: number; k?: number },
): MeanCiSummary {
  const n = diffs.length;
  if (n === 0) {
    return { n: 0, meanPp: 0, sdPp: 0, sePp: 0, ci95Pp: [-100, 100], pSuperiority: 0.5 };
  }
  let sum = 0;
  for (const d of diffs) sum += d;
  const mean = sum / n;
  let ss = 0;
  for (const d of diffs) ss += (d - mean) ** 2;
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  const se = sd / Math.sqrt(n);
  const k = Math.max(1, Math.floor(opts?.k ?? 1));
  const alpha = opts?.alpha ?? 0.05;
  // Bonferroni sobre as K comparações (a "melhor de K"): o IC do candidato
  // escolhido entre K precisa do α/k para a recomendação não vencer por azar.
  const tCrit = n > 1 ? studentTCritical(1 - alpha / k, n - 1) : Infinity;
  const pSuperiority = se > 0 ? normalCdf(mean / se) : mean > 0 ? 1 : mean < 0 ? 0 : 0.5;
  return {
    n,
    meanPp: round2(mean * 100),
    sdPp: round2(sd * 100),
    sePp: round2(se * 100),
    ci95Pp: se > 0 ? [round2((mean - tCrit * se) * 100), round2((mean + tCrit * se) * 100)] : [round2(mean * 100), round2(mean * 100)],
    pSuperiority: Number(pSuperiority.toFixed(4)),
  };
}

/** Resumo paramétrico do Δ pareado em p.p. */
export interface MeanCiSummary {
  n: number;
  meanPp: number;
  sdPp: number;
  sePp: number;
  ci95Pp: [number, number];
  pSuperiority: number;
}

/**
 * Veredito de recomendação (R-11a:REC-4): RECUSA quando (i) nEfetivo < 5 pares
 * com veredito, (ii) o IC95% do Δ cobre zero, (iii) P(superioridade) < 80%
 * (limiar configurável) ou (iv) Δ < granularidade 100/n. O objeto devolvido é
 * estável e o texto é honesto: empate técnico traz Δ, IC e P(A>B) COM dígitos e
 * a sugestão de n para o próximo passo ("rode N=… cenários para detectar Δ=…
 * p.p. com 80% de poder"). Nenhum rótulo verbal de probabilidade sem dígito.
 *
 * Com `k > 1` (candidato escolhido entre K — a "melhor de K") o IC sai com α/k
 * (Bonferroni): sob H0 a recomendação falsa fica ≤ α (verificado no harness
 * Monte Carlo de `test/recommendation-decision.test.ts`).
 */
export function recommendationDecision(
  controlScores: readonly PairScore[],
  candidateScores: readonly PairScore[],
  opts?: RecommendationOpts,
): RecommendationDecision {
  const { diffs } = pairDiffs(controlScores, candidateScores);
  const alpha = opts?.alpha ?? 0.05;
  const k = Math.max(1, Math.floor(opts?.k ?? 1));
  return recommendationFromSummary(meanCiSummary(diffs, { alpha, k }), opts);
}

/**
 * O MESMO veredito a partir de um resumo já calculado — o caminho do CLI/UI
 * quando só o record gravado existe (`sessions show`: o significativo guardado
 * na sessão). A regra de recusa é idêntica.
 */
export function recommendationFromSummary(
  s: MeanCiSummary,
  opts?: RecommendationOpts,
): RecommendationDecision {
  const labels = opts?.labels ?? { candidate: 'Candidato', control: 'Controle' };
  const alpha = opts?.alpha ?? 0.05;
  const k = Math.max(1, Math.floor(opts?.k ?? 1));
  const minPSuperiority = opts?.minPSuperiority ?? 0.8;
  const targetDeltaPp = opts?.targetDeltaPp ?? 20;
  const power = opts?.power ?? POWER_TARGET;
  const nEfetivo = s.n;
  const granularityPp = nEfetivo > 0 ? round2(100 / nEfetivo) : 100;
  const holds: RecommendationHoldReason[] = [];
  if (nEfetivo < MIN_PAIRS) holds.push('no-pairs');
  if (s.ci95Pp[0] <= 0 && s.ci95Pp[1] >= 0) holds.push('ci-covers-zero');
  if (!(s.pSuperiority >= minPSuperiority) && !(s.pSuperiority <= 1 - minPSuperiority)) {
    holds.push('low-superiority');
  }
  if (Math.abs(s.meanPp) < granularityPp - 1e-9) holds.push('below-granularity');
  // A recusa cobre a recomendação do CANDIDATO; o controle só é recomendado
  // com a mesma evidência na direção oposta (simetria da regra).
  const candidateBetter = holds.length === 0 && s.meanPp > 0;
  const controlBetter = holds.length === 0 && s.meanPp < 0;
  const verdict: 'conclusivo' | 'inconclusivo' = candidateBetter || controlBetter ? 'conclusivo' : 'inconclusivo';
  const winner = candidateBetter ? labels.candidate : controlBetter ? labels.control : undefined;
  const sigmaD = opts?.sigmaD ?? (s.sdPp > 0 ? s.sdPp / 100 : DEFAULT_SIGMA_D);
  const suggestedN = nParaDeltaPp(targetDeltaPp, sigmaD, { alpha, power });
  const decision: RecommendationDecision = {
    winner,
    ruler: 'judge-score+ci',
    ci95: s.ci95Pp,
    p_superiority: s.pSuperiority,
    verdict,
    deltaPp: s.meanPp,
    nEfetivo,
    granularityPp,
    minPSuperiority,
    holds,
    suggestedN,
    targetDeltaPp,
    text: '',
  };
  decision.text = recommendationText(decision, labels, power);
  return decision;
}

/**
 * Veredito a partir da significância GRAVADA numa sessão (`sessions show`/UI):
 * o IC e o Δ já estão no record; o erro-padrão sai da meia-amplitude do IC e a
 * probabilidade de superioridade de Φ(Δ/SE) — a mesma régua do caminho com
 * scores brutos.
 */
export function recommendationFromStored(
  sig: SignificanceWithOrigin | null | undefined,
  opts?: RecommendationOpts,
): RecommendationDecision | null {
  if (!sig) return null;
  const n = sig.nEfetivo ?? sig.n;
  const half = Math.abs(sig.ci95Pp[1] - sig.ci95Pp[0]) / 2;
  const sePp = Number.isFinite(half) ? half / zOf(0.975) : 0;
  const pSuperiority =
    sePp > 0 ? normalCdf(sig.meanDiffPp / sePp) : sig.meanDiffPp > 0 ? 1 : sig.meanDiffPp < 0 ? 0 : 0.5;
  return recommendationFromSummary(
    {
      n,
      meanPp: sig.meanDiffPp,
      sdPp: sePp > 0 ? round2(sePp * Math.sqrt(Math.max(1, n))) : 0,
      sePp: round2(sePp),
      ci95Pp: [sig.ci95Pp[0], sig.ci95Pp[1]],
      pSuperiority: Number(pSuperiority.toFixed(4)),
    },
    opts,
  );
}

/** Texto honesto do veredito (toda probabilidade com dígito adjacente). */
function recommendationText(
  d: RecommendationDecision,
  labels: { candidate: string; control: string },
  power: number,
): string {
  const pct = (x: number): string => `${Math.round(x * 100)}%`;
  const ic = `IC95% [${fmtPpText(d.ci95[0])}; ${fmtPpText(d.ci95[1])}]`;
  const pAB = `P(${labels.candidate}>${labels.control})=${pct(d.p_superiority)}`;
  const rodada = `Rode N=${d.suggestedN} cenários para detectar Δ=${fmtPpText(d.targetDeltaPp)} p.p. com ${pct(power)} de poder.`;
  if (d.verdict === 'conclusivo' && d.winner === labels.candidate) {
    return (
      `${labels.candidate} supera ${labels.control} (Δ=${fmtPpText(d.deltaPp)} p.p.; ${ic}; ${pAB}; n=${d.nEfetivo} pares): ` +
      `recomendação conclusiva (limiar ${pct(d.minPSuperiority)} de P, granularidade ${fmtPpText(d.granularityPp)} p.p.). ${rodada}`
    );
  }
  if (d.verdict === 'conclusivo' && d.winner === labels.control) {
    return (
      `${labels.control} supera ${labels.candidate} (Δ=${fmtPpText(d.deltaPp)} p.p.; ${ic}; ${pAB}; n=${d.nEfetivo} pares): ` +
      `recomendo manter ${labels.control}. ${rodada}`
    );
  }
  const motivo =
    d.holds.includes('no-pairs')
      ? `pares com veredito nos dois lados: ${d.nEfetivo} (mínimo ${MIN_PAIRS})`
      : d.holds.includes('ci-covers-zero')
        ? `o ${ic} cobre zero`
        : d.holds.includes('low-superiority')
          ? `${pAB} abaixo de ${pct(d.minPSuperiority)}`
          : `Δ abaixo da granularidade ${fmtPpText(d.granularityPp)} p.p.`;
  return (
    `Empate técnico entre ${labels.control} e ${labels.candidate} ` +
    `(Δ=${fmtPpText(d.deltaPp)} p.p.; ${ic}; ${pAB}): ${motivo} — evidência insuficiente para recomendar. ${rodada}`
  );
}

// ---------------------------------------------------------------------------
// IMPL-050 (R-04:REC-5) — origem do p em TODO relatório de significância
// ---------------------------------------------------------------------------

/**
 * De onde veio o p exibido (R-04 DEC-7): `holdout` = UM teste final em holdout
 * intocado (α=0,05 unilateral, confirmatório); `selecao` = a PRÓPRIA run de
 * seleção (anti-conservador: o p mede o mesmo dado que escolheu o melhor);
 * `sem p` = não há p válido (n efetivo < 5, ou bootstrap legado — que nem
 * p-valor é).
 */
export type SignificanceOrigin = 'holdout' | 'selecao' | 'sem p';

/** `StoredSignificance` com a origem do p (registrada pelo trainer no gate final). */
export type SignificanceWithOrigin = StoredSignificance & { pOrigin?: SignificanceOrigin };

const ORIGIN_LABEL: Record<SignificanceOrigin, string> = {
  holdout: 'holdout (α=0,05 unilateral, confirmatório)',
  selecao: 'seleção (anti-conservador)',
  'sem p': 'sem p',
};

/** Origem do p de uma significância gravada — SEMPRE rotulada. */
export function significanceOrigin(sig: SignificanceWithOrigin): SignificanceOrigin {
  if (sig.pOrigin) return sig.pOrigin;
  // Legado sem rótulo: o bootstrap antigo não é p-valor; o resto é tratado como
  // seleção (o pior caso — anti-conservador) até a origem ser registrada.
  return reportPValue(sig).kind === 'legacy' ? 'sem p' : 'selecao';
}

/** Linha de origem do p — o mesmo texto no CLI e na UI. */
export function formatSignificanceOrigin(sig: SignificanceWithOrigin | null | undefined): string {
  if (!sig) return `origem do p: ${ORIGIN_LABEL['sem p']}`;
  return `origem do p: ${ORIGIN_LABEL[significanceOrigin(sig)]}`;
}

// ---------------------------------------------------------------------------
// IMPL-054 (R-04:REC-7 / R-14a:REC-5) — repetição ≠ observação independente
// ---------------------------------------------------------------------------

/**
 * Agrega repetições DENTRO de cada cenário (o par analítico é o CENÁRIO).
 * O vetor plano do orchestrator é cenário-major ([c0r0, c0r1, c1r0, …]): cada
 * bloco de `repeatsPerScenario` posições vira a MÉDIA das reps observadas
 * (cenário sem nenhuma observação → `null` — sem observação, nunca 'nao').
 */
export function aggregateByScenario(
  values: readonly PairScore[],
  repeatsPerScenario: number,
): PairScore[] {
  const m = Math.max(1, Math.floor(repeatsPerScenario));
  if (m <= 1) return [...values];
  const out: PairScore[] = [];
  for (let i = 0; i < values.length; i += m) {
    let sum = 0;
    let n = 0;
    for (let r = 0; r < m && i + r < values.length; r += 1) {
      const v = values[i + r];
      if (isObs(v)) {
        sum += v;
        n += 1;
      }
    }
    out.push(n > 0 ? sum / n : null);
  }
  return out;
}

/**
 * Diagnóstico de repetição de UM contestant: ICC (efeitos aleatórios de via
 * única, design balanceado), design effect DE = 1+(m−1)·ICC, inflação do
 * erro-padrão √DE e o n EFETIVO = n·m/DE (o n honesto do teste pareado —
 * repetição não dobra o n).
 */
export interface RepetitionDiagnostics {
  /** Cenários distintos. */
  scenarios: number;
  /** Repeticoes por cenário (m). */
  repsPerScenario: number;
  /** Observações planas (cenario × rep) com veredito. */
  observations: number;
  /** ICC em [0,1]; null quando m = 1 ou não há dispersão estimável. */
  icc: number | null;
  /** DE = 1+(m−1)·ICC; null quando ICC é null. */
  designEffect: number | null;
  /** √DE — quanto o erro-padrão infla ao tratar reps como independentes. */
  seInflation: number | null;
  /** n efetivo = n·m/DE (com m = 1 é o próprio n). */
  nEfetivo: number;
  /** ICC < 0,5 (faixa de tarefas agênticas) → mais cenários, não mais reps. */
  advice: 'more-scenarios' | 'balanced' | 'single-shot';
}

/**
 * ICC de uma matriz [cenário][rep] de scores 0–1 (ANOVA de via única,
 * balanceado: só cenários com TODAS as m reps observadas informam). Negativos
 * (ruído maior que o sinal) são truncados em 0 — o design effect não pode ser
 * < 1. ICC > 0,3 ⇒ mais cenários valem mais que mais repetições (R-14a:REC-10).
 */
export function iccOneWay(rows: readonly (readonly PairScore[])[]): number | null {
  const complete = rows.filter((r) => r.length >= 2 && r.every(isObs)) as number[][];
  const m = complete.length > 0 ? complete[0].length : 0;
  if (m < 2 || complete.length < 2) return null;
  const bal = complete.filter((r) => r.length === m);
  if (bal.length < 2) return null;
  const n = bal.length;
  let grand = 0;
  for (const row of bal) for (const v of row) grand += v;
  grand /= n * m;
  let ssBetween = 0;
  let ssWithin = 0;
  for (const row of bal) {
    const mean = row.reduce((a, b) => a + b, 0) / m;
    ssBetween += m * (mean - grand) ** 2;
    for (const v of row) ssWithin += (v - mean) ** 2;
  }
  const msBetween = ssBetween / (n - 1);
  const msWithin = ssWithin > 0 ? ssWithin / (n * (m - 1)) : 0;
  if (msWithin === 0) return msBetween > 0 ? 1 : 0;
  const icc = (msBetween - msWithin) / (msBetween + (m - 1) * msWithin);
  return Math.min(1, Math.max(0, icc));
}

/**
 * Diagnóstico de repetição a partir do vetor PLANO (cenário-major) de scores.
 * Com m = 1 não há o que estimar: ICC null, DE 1, nEfetivo = n observado.
 */
export function repetitionDiagnostics(
  flatScores: readonly PairScore[],
  repeatsPerScenario: number,
): RepetitionDiagnostics {
  const m = Math.max(1, Math.floor(repeatsPerScenario));
  const rows: PairScore[][] = [];
  if (m > 1) {
    for (let i = 0; i < flatScores.length; i += m) {
      rows.push(Array.from({ length: Math.min(m, flatScores.length - i) }, (_, r) => flatScores[i + r]));
    }
  } else {
    for (const v of flatScores) rows.push([v]);
  }
  return repetitionDiagnosticsFromRows(rows);
}

/**
 * O mesmo diagnóstico a partir da matriz [cenário][rep] (geometria do agente:
 * reps DENTRO da etapa via `verdictsByRep`). nEfetivo = observações/DE — o n
 * honesto do teste pareado, com repetição agregada dentro do cenário.
 */
export function repetitionDiagnosticsFromRows(
  rows: readonly (readonly PairScore[])[],
): RepetitionDiagnostics {
  const scenarios = rows.length;
  const m = rows.reduce((mx, r) => Math.max(mx, r.length), 0);
  let observations = 0;
  for (const r of rows) for (const v of r) if (isObs(v)) observations += 1;
  if (m <= 1) {
    return {
      scenarios,
      repsPerScenario: 1,
      observations,
      icc: null,
      designEffect: null,
      seInflation: null,
      nEfetivo: observations,
      advice: observations >= 20 ? 'balanced' : 'more-scenarios',
    };
  }
  const icc = iccOneWay(rows);
  const designEffect = icc === null ? null : 1 + (m - 1) * icc;
  const seInflation = designEffect === null ? null : Math.sqrt(designEffect);
  const nEfetivo =
    designEffect === null || designEffect <= 0
      ? scenarios
      : Math.max(1, Math.round((observations / designEffect) * 100) / 100);
  return {
    scenarios,
    repsPerScenario: m,
    observations,
    icc,
    designEffect: designEffect === null ? null : round2(designEffect),
    seInflation: seInflation === null ? null : round2(seInflation),
    nEfetivo,
    advice: icc !== null && icc > 0.3 ? 'more-scenarios' : 'balanced',
  };
}

/** Regra de sucesso do pass@k/pass^k — SUCESSO EXPLÍCITO, nunca implícito. */
export type SuccessRule = 'resolve' | 'resolve-ou-parcial';

export const SUCCESS_RULE_DEFINITION: Record<SuccessRule, string> = {
  resolve: 'sucesso = veredito "resolve" (regra principal)',
  'resolve-ou-parcial': 'sensibilidade: sucesso = "resolve" OU "parcial"',
};

const isSuccess = (v: Verdict | undefined, rule: SuccessRule): boolean =>
  v === 'resolve' || (rule === 'resolve-ou-parcial' && v === 'parcial');

/**
 * pass@k pelo estimador NÃO ENVIESADO de Chen et al. (2021):
 * 1 − C(n−c, k)/C(n, k), computado como 1 − Π_{i=n−c+1}^{n} (1 − k/i).
 * `n` = tentativas, `c` = sucessos, `k` = escolhidas. Sem enviesar para cima
 * com o plug-in c/n (com k = n o plug-in subestima o "pelo menos k de n").
 */
export function passAtK(n: number, c: number, k: number): number {
  const nn = Math.max(0, Math.floor(n));
  const cc = Math.min(Math.max(0, Math.floor(c)), nn);
  const kk = Math.floor(k);
  if (nn === 0 || kk <= 0) return 0;
  if (kk > nn) return Number.NaN;
  if (nn - cc < kk) return 1;
  let prod = 1;
  for (let i = nn - cc + 1; i <= nn; i += 1) prod *= 1 - kk / i;
  return clamp01(1 - prod);
}

/** Relatório pass@k / pass^k de UM contestant (matriz [cenário][rep]). */
export interface PassAtKReport {
  k: number;
  scenarios: number;
  rule: SuccessRule;
  /** Definição explícita da regra de sucesso (vai no relatório). */
  ruleDefinition: string;
  /** pass@k (Chen) — média sobre os cenários. */
  passAtK: number;
  /**
   * pass^k (τ-bench): fração de cenários em que TODAS as k tentativas
   * tiveram sucesso — a confiabilidade de "acerta sempre", não "acerta uma vez".
   */
  passK: number;
  /** Sucessos por cenário (contagem sobre as reps observadas). */
  successesByScenario: number[];
}

/**
 * pass@k (Chen) e pass^k sobre a matriz [cenário][rep] de vereditos.
 * `k` padrão = número de reps observadas por cenário.
 */
export function passAtKReport(
  rows: readonly (readonly (Verdict | undefined)[])[],
  k: number,
  rule: SuccessRule = 'resolve',
): PassAtKReport {
  const successesByScenario = rows.map((r) => r.filter((v) => isSuccess(v, rule)).length);
  const sizes = rows.map((r) => r.length);
  const kk = Math.max(1, Math.floor(k));
  let atK = 0;
  let allK = 0;
  let counted = 0;
  rows.forEach((r, i) => {
    const n = sizes[i];
    if (n === 0) return;
    counted += 1;
    atK += passAtK(n, successesByScenario[i], Math.min(kk, n));
    // pass^k: só cenários com k tentativas declaráveis entram; sucesso = todas.
    if (n >= kk) allK += successesByScenario[i] >= kk ? 1 : 0;
  });
  return {
    k: kk,
    scenarios: rows.length,
    rule,
    ruleDefinition: SUCCESS_RULE_DEFINITION[rule],
    passAtK: counted > 0 ? round4(atK / counted) : 0,
    passK: counted > 0 ? round4(allK / counted) : 0,
    successesByScenario,
  };
}

/**
 * Matriz [cenário][rep] de vereditos de um contestant (IMPL-054). Duas
 * geometrias de repetição:
 * - `agent.repetitions` > 1: `referenceJudge.verdictsByRep` (reps DENTRO da etapa);
 * - `repeats` > 1 (compare): vetor PLANO cenário-major (clones consecutivos).
 * Etapa `incomplete`/`error` entra como linha vazia (sem observação).
 */
export function repVerdictMatrix(
  stages: readonly StageVerdictsLike[],
  contestantId: string,
  opts: { repeatsPerScenario?: number; ruler?: 'reference' | 'listwise' } = {},
): (Verdict | undefined)[][] {
  const ruler = opts.ruler ?? primaryRuler(stages);
  const m = Math.max(1, Math.floor(opts.repeatsPerScenario ?? 1));
  const rows: (Verdict | undefined)[][] = [];
  for (let i = 0; i < stages.length; i += m) {
    const row: (Verdict | undefined)[] = [];
    for (let r = 0; r < m && i + r < stages.length; r += 1) {
      const stage = stages[i + r];
      const bearer = ruler === 'reference' ? stage.referenceJudge : stage.judge;
      const porRep = bearer?.verdictsByRep?.[contestantId];
      if (porRep && porRep.length > 0) {
        for (const v of porRep) row.push(isVerdict(v) ? v : undefined);
      } else {
        const obs = stageObservation(stage, contestantId, ruler);
        row.push('verdict' in obs ? obs.verdict : undefined);
      }
    }
    rows.push(row);
  }
  return rows;
}

/** Linhas de relatório de repetição (`runs show`), sempre com dígitos. */
export function formatRepetitionReport(d: RepetitionDiagnostics, pass?: PassAtKReport): string[] {
  const lines = [
    `repetições: m=${d.repsPerScenario} × ${d.scenarios} cenários (${d.observations} observações)`,
  ];
  if (d.icc !== null && d.designEffect !== null && d.seInflation !== null) {
    lines.push(
      `ICC=${d.icc.toFixed(3)} · design effect DE=${d.designEffect.toFixed(3)} (√DE=${d.seInflation.toFixed(3)} inflação do erro-padrão) · nEfetivo=${d.nEfetivo} (de ${d.observations} observações)`,
    );
  } else {
    lines.push(`nEfetivo=${d.nEfetivo} (sem ICC estimável: m=1 ou reps incompletas)`);
  }
  if (d.advice === 'more-scenarios') {
    lines.push(
      `ICC=${(d.icc ?? 0).toFixed(3)} > 0,3: repetições agregam pouco — prefira MAIS CENÁRIOS (cada cenário novo vale mais que uma rep nova)`,
    );
  }
  if (pass) {
    lines.push(
      `pass@${pass.k}=${(pass.passAtK * 100).toFixed(1)}% · pass^${pass.k}=${(pass.passK * 100).toFixed(1)}% (${pass.ruleDefinition}; ${pass.scenarios} cenários)`,
    );
  }
  return lines;
}

/** Relatório de repetição de UM contestant — dados puros (IMPL-054). */
export interface ContestantRepetitionReport {
  contestantId: string;
  label: string;
  diagnostics: RepetitionDiagnostics;
  /** pass@k (Chen) / pass^k com SUCESSO EXPLÍCITO: 'resolve' (regra principal). */
  pass: PassAtKReport;
  /** Sensibilidade: sucesso = 'resolve' OU 'parcial'. */
  sensitivity: PassAtKReport;
}

/**
 * Relatórios de repetição por contestant (IMPL-054) — fonte ÚNICA do texto E do
 * payload JSON de `runs show`: ICC, design effect e nEfetivo SEMPRE que há
 * repetição, nas duas geometrias (`agent.repetitions` dentro da etapa via
 * `verdictsByRep`; `repeats` do compare como clones consecutivos). O par
 * analítico é o CENÁRIO: repetições não dobram o n do teste pareado.
 */
export function contestantRepetitionReports(
  stages: readonly StageVerdictsLike[],
  contestants: readonly { id: string; label: string }[],
  opts: { repeatsPerScenario?: number } = {},
): ContestantRepetitionReport[] {
  const m = Math.max(1, Math.floor(opts.repeatsPerScenario ?? 1));
  return contestants.map((c) => {
    const rows = repVerdictMatrix(stages, c.id, { repeatsPerScenario: m });
    const scoreRows = rows.map((r) => r.map((v) => (v === undefined ? null : VERDICT_SCORE[v])));
    const diagnostics = repetitionDiagnosticsFromRows(scoreRows);
    const k = Math.max(1, diagnostics.repsPerScenario);
    return {
      contestantId: c.id,
      label: c.label,
      diagnostics,
      pass: passAtKReport(rows, k),
      sensitivity: passAtKReport(rows, k, 'resolve-ou-parcial'),
    };
  });
}
