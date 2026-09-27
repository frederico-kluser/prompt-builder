// Sequential halving (F4 do PLANO-PARIDADE, §8.5). Fonte única e pura.
//
// Com V variantes × C cenários, rodar tudo é caro. Halving: rodar TODAS as
// variantes num subconjunto pequeno de cenários (triagem), eliminar as piores,
// e repetir com mais cenários e menos variantes — corta custo sem afetar o
// ranking final. O CONTROLE (prompt base) nunca é eliminado: é a régua do
// experimento. Aqui vive a matemática; o trainer consome (triagem opt-in).

import { blindRankMap, seedFromId } from './duelCore.js';

export interface HalvingRound {
  /** Rodada 1-based. */
  round: number;
  /** Cenários avaliados NESTA rodada (prefixo determinístico da lista semeada). */
  scenarioIds: string[];
  /** Quantas variantes sobrevivem AO FIM desta rodada. */
  keepCount: number;
}

export interface HalvingPlan {
  rounds: HalvingRound[];
  /** Variante(s) imunes à eliminação (controle). */
  protectedIds: string[];
}

/**
 * Planeja o torneio: `rounds` rodadas (default 3), cenários crescendo
 * (~firstRatio=0.3 / ~0.6 / 1.0 de C, no mínimo 1 por rodada, nunca decrescente),
 * `keepCount` cortando pela metade a cada rodada (arredondado para cima, nunca
 * abaixo de 2, nunca acima do nº de variantes). A ordem dos cenários é
 * determinística: shuffle semeado (FNV-1a da seed + mulberry32) — mesma seed ⇒
 * mesmo plano, e a ordem de entrada nunca decide diretamente.
 */
export function planHalving(
  variantIds: string[],
  scenarioIds: string[],
  seed: number,
  opts?: { rounds?: number; protectedIds?: string[]; firstRatio?: number },
): HalvingPlan {
  const nRounds = Math.max(1, Math.round(opts?.rounds ?? 3));
  const protectedIds = opts?.protectedIds ?? [];
  const firstRatio = Math.min(Math.max(opts?.firstRatio ?? 0.3, 0.05), 1);
  // Shuffle determinístico dos cenários: cada rodada usa um PREFIXO da ordem
  // semeada (crescer o prefixo mantém as rodadas comparáveis entre si).
  const rank = blindRankMap(scenarioIds, seedFromId(String(seed)));
  const ordenados = [...scenarioIds].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));

  const nVariants = Math.max(1, variantIds.length);
  const rounds: HalvingRound[] = [];
  let keep = nVariants;
  let prevCount = 0;
  for (let r = 1; r <= nRounds; r++) {
    // Fração dos cenários: cresce de firstRatio a 1.0 de forma linear nas rodadas.
    const ratio = nRounds === 1 ? 1 : firstRatio + ((1 - firstRatio) * (r - 1)) / (nRounds - 1);
    const count = Math.min(
      ordenados.length,
      Math.max(prevCount, Math.max(1, Math.round(ordenados.length * ratio))),
    );
    prevCount = count;
    // keepCount corta pela metade por rodada; ≥2 (um par ainda disputa) e ≤ vivas.
    if (r > 1) keep = Math.max(2, Math.ceil(keep / 2));
    keep = Math.min(keep, nVariants);
    rounds.push({ round: r, scenarioIds: ordenados.slice(0, count), keepCount: keep });
  }
  return { rounds, protectedIds };
}

export interface HalvingEntry {
  id: string;
  /** Judge-score médio NA RODADA ATUAL (0–100). */
  score: number;
}

/**
 * Decide os sobreviventes da rodada: melhores `keepCount` por score;
 * `protectedIds` NUNCA são eliminados (ocupam vaga mesmo se ruins); empate de
 * score é desempatado pelo shuffle cego semeado (nunca pela ordem de entrada).
 * Determinístico: mesma seed ⇒ mesmo resultado.
 */
export function survivorsOf(
  entries: HalvingEntry[],
  keepCount: number,
  opts: { seed: number; protectedIds?: string[] },
): { survivors: string[]; eliminated: string[] } {
  const protectedSet = new Set(opts.protectedIds ?? []);
  const rank = blindRankMap(
    entries.map((e) => e.id),
    seedFromId(`halving:${opts.seed}`),
  );
  const ordenados = [...entries].sort(
    (a, b) => b.score - a.score || (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0),
  );
  const alvo = Math.max(2, Math.min(Math.round(keepCount), entries.length));
  const survivors: string[] = [];
  // Protegidos entram primeiro (imunes), depois os melhores por score.
  for (const e of ordenados) {
    if (survivors.length >= alvo) break;
    if (protectedSet.has(e.id)) survivors.push(e.id);
  }
  for (const e of ordenados) {
    if (survivors.length >= alvo) break;
    if (!survivors.includes(e.id)) survivors.push(e.id);
  }
  const eliminated = ordenados.map((e) => e.id).filter((id) => !survivors.includes(id));
  return { survivors, eliminated };
}
