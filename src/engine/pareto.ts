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
