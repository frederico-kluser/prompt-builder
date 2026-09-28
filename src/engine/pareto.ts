// Seleção Pareto / população (F4 do PLANO-PARIDADE, §8.1 — estado da arte GEPA,
// ICLR 2026). Fonte única e pura.
//
// Tanto o prompt-arena quanto o prompt-builder eram ELITISTAS: um campeão vira
// a base da próxima rodada. O GEPA mantém uma POPULAÇÃO DIVERSA e seleciona
// pais por dominância de Pareto — prompts diferentes ganham em subconjuntos
// diferentes do dataset; colapsar cedo num único campeão é preso a ótimo local.
// Aqui vive a matemática: front de Pareto por FATIAS (tier/dimensão do cenário),
// manutenção do pool com evicção de dominados e escolha de pai por rodízio.

export interface ParetoEntry {
  id: string;
  label?: string;
  /** Judge-score por fatia (0–100). Ex.: `{ mft: 80, adversarial: 40 }`. */
  bySlice: Record<string, number>;
}

/** true quando `a` domina `b` (≥ em todas as fatias, > em ao menos uma). */
export function dominates(a: Record<string, number>, b: Record<string, number>): boolean {
  const fatias = new Set([...Object.keys(a), ...Object.keys(b)]);
  let melhor = false;
  for (const f of fatias) {
    const va = a[f] ?? 0;
    const vb = b[f] ?? 0;
    if (va < vb) return false;
    if (va > vb) melhor = true;
  }
  return melhor;
}

/**
 * Front de Pareto: as entradas NÃO dominadas por nenhuma outra. Ordem de saída:
 * média das fatias desc (o front é um conjunto — a ordem é só conveniência).
 */
export function paretoFront(entries: ParetoEntry[]): ParetoEntry[] {
  const front = entries.filter((e) => !entries.some((o) => o !== e && dominates(o.bySlice, e.bySlice)));
  const media = (e: ParetoEntry): number => {
    const vs = Object.values(e.bySlice);
    return vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : 0;
  };
  return [...front].sort((a, b) => media(b) - media(a));
}

export interface PoolOptions {
  /** Tamanho máximo do pool. 1 = elitismo clássico (só o melhor). */
  maxSize: number;
}

/**
 * Atualiza o pool com uma candidata: entra se não for dominada por ninguém do
 * pool; ao estourar `maxSize`, sai a DOMINADA de menor média (sem dominada,
 * sai a de menor média — a população preserva diversidade, não só o topo).
 * Ids repetidos (mesma variante promovida de novo) atualizam os scores.
 */
export function addToPool<T extends ParetoEntry>(pool: T[], candidate: T, opts: PoolOptions): T[] {
  const semDuplicata = pool.filter((e) => e.id !== candidate.id);
  const dominada = semDuplicata.some((e) => dominates(e.bySlice, candidate.bySlice));
  const novo = dominada ? semDuplicata : [...semDuplicata, candidate];
  if (novo.length <= opts.maxSize) return ordenarPool(novo);
  const media = (e: ParetoEntry): number => {
    const vs = Object.values(e.bySlice);
    return vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : 0;
  };
  // Evicção: primeiro as dominadas (pior média entre elas); sem dominada,
  // a de menor média sai mesmo — o pool nunca excede o tamanho.
  const dominadas = novo.filter((e) => novo.some((o) => o !== e && dominates(o.bySlice, e.bySlice)));
  const alvo = (dominadas.length ? dominadas : novo).reduce((pior, e) => (media(e) < media(pior) ? e : pior));
  return ordenarPool(novo.filter((e) => e !== alvo));
}

function ordenarPool<T extends ParetoEntry>(pool: T[]): T[] {
  const media = (e: ParetoEntry): number => {
    const vs = Object.values(e.bySlice);
    return vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : 0;
  };
  return [...pool].sort((a, b) => media(b) - media(a));
}

/**
 * Escolhe o PAI da próxima rodada: rodízio pelo menos usado (contadores
 * passados pelo chamador) — pais diversos evitam que a população colapse numa
 * mesma linhagem. Empate de uso: maior média de fatia.
 */
export function pickParent<T extends ParetoEntry>(
  pool: T[],
  useCount: Record<string, number>,
): T | undefined {
  if (!pool.length) return undefined;
  const media = (e: ParetoEntry): number => {
    const vs = Object.values(e.bySlice);
    return vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : 0;
  };
  return [...pool].sort(
    (a, b) =>
      (useCount[a.id] ?? 0) - (useCount[b.id] ?? 0) || media(b) - media(a),
  )[0];
}

// ---------------------------------------------------------------------------
// IMPL-062 (R-02b:REC-4): amostragem de pai ∝ COBERTURA + diagnóstico do front.
// O rodízio pelo menos usado ignora QUANTAS instâncias cada candidato vence;
// o GEPA escolhe o pai proporcionalmente à cobertura (vitórias por cenário).
// E, com veredito ruidoso e n pequeno, o front de Pareto é ruído — daí as
// métricas de diagnóstico (fração de pares não dominados + tamanho do front).
// ---------------------------------------------------------------------------

/** n mínimo para a amostragem ∝ cobertura (abaixo disso, o front é ruído). */
export const PARETO_MIN_N = 20;
/** Fração de pares não dominados acima da qual o front vira alerta de ruído. */
export const PARETO_NOISE_FRACTION = 0.6;

export interface ParetoDiagnostics {
  /** Instâncias (cenários) por trás da matriz. */
  n: number;
  /** Tamanho do front de Pareto (entradas não dominadas). */
  frontSize: number;
  /** Fração de pares (a,b) em que NENHUM domina o outro (0–1). */
  nonDominatedPairFraction: number;
  /**
   * true = front provavelmente RUÍDO: fração de pares não dominados >
   * {@link PARETO_NOISE_FRACTION} com n < {@link PARETO_MIN_N} (a ablação do
   * GEPA foi com D_pareto de 111–300 instâncias).
   */
  noiseAlert: boolean;
}

/**
 * Diagnóstico do pool: fração de pares não dominados e tamanho do front.
 * `n` = número de instâncias (cenários) da matriz candidato × cenário.
 */
export function paretoDiagnostics(entries: ParetoEntry[], n: number): ParetoDiagnostics {
  const frontSize = paretoFront(entries).length;
  let pares = 0;
  let naoDominados = 0;
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      pares += 1;
      const a = entries[i].bySlice;
      const b = entries[j].bySlice;
      if (!dominates(a, b) && !dominates(b, a)) naoDominados += 1;
    }
  }
  const frac = pares ? naoDominados / pares : 0;
  return {
    n,
    frontSize,
    nonDominatedPairFraction: Number(frac.toFixed(4)),
    noiseAlert: frac > PARETO_NOISE_FRACTION && n < PARETO_MIN_N,
  };
}

/**
 * COBERTURA de cada candidato: em quantas instâncias (cenários) ele vence —
 * empate no topo conta como vitória para todos os empatados. `scoresByCandidate`
 * é a matriz candidato × cenário (score por instância; null/undefined = sem
 * observação, nunca pontua).
 */
export function coverageWins(
  scoresByCandidate: Record<string, readonly (number | null | undefined)[]>,
): Record<string, number> {
  const ids = Object.keys(scoresByCandidate);
  const n = ids.reduce((m, id) => Math.max(m, scoresByCandidate[id]?.length ?? 0), 0);
  const wins: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  for (let s = 0; s < n; s++) {
    let best = Number.NEGATIVE_INFINITY;
    for (const id of ids) {
      const v = scoresByCandidate[id]?.[s];
      if (typeof v === 'number' && Number.isFinite(v) && v > best) best = v;
    }
    if (best === Number.NEGATIVE_INFINITY) continue;
    for (const id of ids) {
      const v = scoresByCandidate[id]?.[s];
      if (typeof v === 'number' && Number.isFinite(v) && v >= best) wins[id] += 1;
    }
  }
  return wins;
}

/**
 * Escolhe o PAI por amostragem ∝ cobertura (quantas instâncias o candidato
 * vence — GEPA). `rng` é injetável para os testes (determinísticos). Sem
 * vitória registrada ninguém tem peso: cai numa amostragem uniforme (o pai
 * nunca some).
 */
export function pickParentByCoverage<T extends ParetoEntry>(
  pool: T[],
  wins: Record<string, number>,
  rng: () => number = Math.random,
): T | undefined {
  if (!pool.length) return undefined;
  const pesos = pool.map((e) => Math.max(0, wins[e.id] ?? 0));
  const total = pesos.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
  }
  let alvo = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    alvo -= pesos[i];
    if (alvo < 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/** Judge-score (0–100) por fatia de um contestant, a partir de pares (fatia, veredito). */
export function sliceScores(
  observations: { slice: string; score: number }[],
): Record<string, number> {
  const soma = new Map<string, { total: number; n: number }>();
  for (const o of observations) {
    const slot = soma.get(o.slice) ?? { total: 0, n: 0 };
    slot.total += o.score;
    slot.n += 1;
    soma.set(o.slice, slot);
  }
  return Object.fromEntries(
    [...soma.entries()].map(([f, { total, n }]) => [f, n ? Number(((total / n) * 100).toFixed(2)) : 0]),
  );
}
