// Núcleo PURO dos duelos (F0 do PLANO-PARIDADE: fonte única).
//
// Vive separado de `src/duels.ts` porque o `runStageDuels` (que chama o juiz e
// lê dossiês de agente em disco) é Node-only e tem um espelho próprio no
// navegador; a MATEMÁTICA do bracket/placar, não — e é ela que decide
// colocação. Ambos os lados importam daqui: mesma seed ⇒ mesmo bracket, nos
// dois motores, para sempre.
//
// Import type de `../types.js` (src/types.ts) é seguro para o bundle do
// navegador: só tipos, zero runtime.

import type { DuelOutcome, Verdict } from '../types.js';

/** Hash FNV-1a 32-bit do id/conteúdo — seed estável p/ o shuffle cego por etapa. */
export function seedFromId(id: string): number {
  let h = 2166136261;
  for (const ch of String(id)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** PRNG determinístico (mesma seed => mesma sequência) p/ embaralhamentos cegos. */
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

/** Pontuação do veredito pointwise usada na seleção do bracket. */
export const VERDICT_SCORE: Record<Verdict, number> = { resolve: 2, parcial: 1, nao: 0 };

/** Rank cego e determinístico por id: chave aleatória semeada, nunca ordem de entrada. */
export function blindRankMap(ids: string[], seed: number): Map<string, number> {
  const rng = mulberry32(seed);
  const arr = ids.map((id) => ({ id, k: rng() })).sort((a, b) => a.k - b.k);
  return new Map(arr.map((x, i) => [x.id, i]));
}

/**
 * Escolhe QUEM duelo numa etapa — o governador de custo do round-robin.
 * O controle entra SEMPRE (é a baseline); as outras vagas vão aos melhores por
 * `score` (veredito pointwise da etapa). Empate de score é desempatado pelo
 * shuffle semeado cego, NUNCA pela ordem de entrada — senão a variante listada
 * primeiro se classificaria sistematicamente. `topK <= 0` ou `>= entries.length`
 * => round-robin completo. Determinístico: mesma etapa => mesmo bracket.
 */
export function selectDuelists(
  entries: { id: string; score: number }[],
  controlId: string | undefined,
  topK: number,
  seed: number,
): string[] {
  const list = entries ?? [];
  if (topK <= 0 || topK >= list.length) return list.map((e) => e.id);
  const rank = blindRankMap(
    list.map((e) => e.id),
    seed,
  );
  const control = controlId !== undefined ? list.find((e) => e.id === controlId) : undefined;
  const rest = list
    .filter((e) => e !== control)
    .sort((a, b) => b.score - a.score || (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  return control
    ? [control.id, ...rest.slice(0, topK - 1).map((e) => e.id)]
    : rest.slice(0, topK).map((e) => e.id);
}

/**
 * Escolhe os N FINALISTAS globais: maiores `score` (judge-score médio da run).
 * Empate é desempatado pelo shuffle cego semeado (nunca pela ordem de entrada).
 * `count <= 0` ou `>= entries.length` => todos, **mas ainda ordenados por score**:
 * a lista sai como ranking (é ela que vira `record.finalists`, o evento
 * `finals.started` e o pódio provisório da UI enquanto os duelos rodam). Devolver
 * a ordem de entrada aqui numerava 1º/2º/3º por ordem de cadastro.
 */
export function pickFinalists(
  entries: { id: string; score: number }[],
  count: number,
  seed: number,
): string[] {
  const list = entries ?? [];
  const rank = blindRankMap(
    list.map((e) => e.id),
    seed,
  );
  const ordenados = [...list]
    .sort((a, b) => b.score - a.score || (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    .map((e) => e.id);
  return count <= 0 || count >= list.length ? ordenados : ordenados.slice(0, count);
}

/**
 * Placar dos duelos de uma etapa por TAXA DE VITÓRIA (IMPL-007, R-04:DEC-5):
 * vitória 1, empate 0.5, derrota 0, dividido pelos duelos que o contestant
 * DISPUTOU (0..1). Antes a soma crua era chamada de "pontos Copeland" — mas
 * Copeland é maioria par-a-par; isto é win-rate. Dividir pelos disputados
 * também para de punir quem perdeu um duelo por falha do juiz (IMPL-004): o
 * duelo sem resultado não entra no numerador NEM no denominador.
 * Placement 1-based por taxa desc; empates de taxa DIVIDEM a média dos ranks
 * que ocupam (placements fracionários). `order` = ids do melhor ao pior
 * placement (empate mantém a ordem de `ids` — o chamador passa a ordem cega).
 */
export function standingsFromDuels(
  ids: string[],
  duels: DuelOutcome[],
): { winRate: Record<string, number>; placementById: Record<string, number>; order: string[] } {
  const acc = new Map<string, { score: number; played: number }>(ids.map((id) => [id, { score: 0, played: 0 }]));
  for (const d of duels ?? []) {
    const A = acc.get(d.a);
    const B = acc.get(d.b);
    if (!A || !B) continue;
    A.played += 1;
    B.played += 1;
    if (d.outcome === 'a') A.score += 1;
    else if (d.outcome === 'b') B.score += 1;
    else {
      A.score += 0.5;
      B.score += 0.5;
    }
  }
  const winRate = new Map<string, number>(
    [...acc.entries()].map(([id, s]) => [id, s.played > 0 ? Number((s.score / s.played).toFixed(4)) : 0]),
  );
  const sorted = [...winRate.entries()].sort((x, y) => y[1] - x[1]);
  const placementById = new Map<string, number>();
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1][1] === sorted[i][1]) j += 1;
    const avgRank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k += 1) placementById.set(sorted[k][0], avgRank);
    i = j + 1;
  }
  const order = [...placementById.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id);
  return { winRate: Object.fromEntries(winRate), placementById: Object.fromEntries(placementById), order };
}

// ----------------------------------------------------------------------------
// Classificação das FINAIS (cli#1). Antes cada orquestrador ordenava por
// `winRate || wins` com sort ESTÁVEL: empate nos duelos (juiz com viés de
// posição ⇒ as duas ordens discordam ⇒ todo duelo empata) mantinha a ordem dos
// contestants — e o controle é sempre o 1º do array. `runs winner` pegava
// `standings[0]` e nomeava o PIOR contestant (judge-score 0 × 100) como
// vencedor, sem dizer que houve empate. O desempate agora é a régua que
// escolheu os finalistas (judge-score) e, persistindo, o shuffle cego semeado
// — nunca a ordem de cadastro.
// ----------------------------------------------------------------------------

/** Linha da classificação das finais (o que a ordenação lê). */
export interface StandingRowLike {
  id: string;
  wins: number;
  winRate: number;
}

/** Linha completa da classificação das finais (`RunRecord.standings`). */
export interface FinalStandingRow extends StandingRowLike {
  label: string;
  isControl: boolean;
  ties: number;
  losses: number;
}

/**
 * Ordena a classificação das finais: taxa de vitória ↓, vitórias ↓, judge-score
 * ↓ (desempate: a régua que escolheu os finalistas) e, por fim, o rank CEGO
 * semeado (mesmo critério neutro de `pickFinalists`). Devolve uma cópia.
 */
export function sortStandings<T extends StandingRowLike>(
  rows: readonly T[],
  judgeScoreByContestant: Record<string, number> | undefined,
  seed: number,
): T[] {
  const js = judgeScoreByContestant ?? {};
  // Ids ORDENADOS antes do shuffle: `blindRankMap` sorteia por posição, e a
  // posição de entrada aqui é a ordem de cadastro (controle 1º) — o rank cego
  // tem de independer dela.
  const cego = blindRankMap(
    rows.map((r) => r.id).sort(),
    seed,
  );
  const score = (id: string): number => (typeof js[id] === 'number' && Number.isFinite(js[id]) ? js[id] : -1);
  return [...rows].sort(
    (a, b) =>
      b.winRate - a.winRate ||
      b.wins - a.wins ||
      score(b.id) - score(a.id) ||
      (cego.get(a.id) ?? 0) - (cego.get(b.id) ?? 0),
  );
}

/**
 * Classificação agregada das finais (IMPL-007: vitória 1, empate 0.5, derrota
 * 0, dividido pelos duelos disputados — NÃO é Copeland), já ordenada por
 * `sortStandings`. Fonte única dos dois orquestradores (mirror).
 */
export function buildFinalStandings(params: {
  contestantIds: readonly string[];
  duels: ReadonlyArray<Pick<DuelOutcome, 'a' | 'b' | 'outcome'>>;
  labelOf: (id: string) => string;
  controlId?: string;
  judgeScoreByContestant?: Record<string, number>;
  seed: number;
}): FinalStandingRow[] {
  const acc = new Map(params.contestantIds.map((id) => [id, { wins: 0, ties: 0, losses: 0 }]));
  for (const d of params.duels) {
    const A = acc.get(d.a);
    const B = acc.get(d.b);
    if (!A || !B) continue;
    if (d.outcome === 'a') {
      A.wins += 1;
      B.losses += 1;
    } else if (d.outcome === 'b') {
      B.wins += 1;
      A.losses += 1;
    } else {
      A.ties += 1;
      B.ties += 1;
    }
  }
  const rows: FinalStandingRow[] = [...acc.entries()].map(([id, s]) => {
    const played = s.wins + s.ties + s.losses;
    return {
      id,
      label: params.labelOf(id),
      isControl: id === params.controlId,
      ...s,
      winRate: played > 0 ? Number(((s.wins + 0.5 * s.ties) / played).toFixed(4)) : 0,
    };
  });
  return sortStandings(rows, params.judgeScoreByContestant, params.seed);
}

/** Como o vencedor das finais foi decidido. */
export type StandingsTieBreak = 'none' | 'wins' | 'judge-score' | 'blind';

/** Vencedor da run pela régua explícita — com o empate NUNCA escondido. */
export interface StandingsWinner {
  /** Id vencedor (ausente = run sem finais nem judge-score). */
  contestantId?: string;
  /** Régua: finais (`duels`), finais desempatadas pelo judge-score, ou só judge-score. */
  ruler: 'duels' | 'duels+judge-score' | 'judge-score';
  /** true = mais de um contestant dividiu a MAIOR taxa de vitória das finais. */
  tie: boolean;
  /** Quem dividiu a maior taxa de vitória (inclui o vencedor); [] sem finais. */
  tiedIds: string[];
  /** Critério que separou os empatados na taxa (`none` = sem empate). */
  tieBreak: StandingsTieBreak;
  /**
   * true = o empate persistiu até no judge-score: o vencedor saiu do rank CEGO
   * semeado (determinístico, neutro), não dos dados — quem consome deve avisar.
   */
  unresolved: boolean;
}

/**
 * Vencedor a partir do record (re-ordena `standings` com `sortStandings`, então
 * vale também para records gravados antes do desempate — que tinham a ordem de
 * cadastro no empate). Sem finais, o maior judge-score (desempate cego).
 */
export function winnerFromStandings(record: {
  id: string;
  standings?: ReadonlyArray<StandingRowLike>;
  judgeScoreByContestant?: Record<string, number>;
}): StandingsWinner {
  const seed = seedFromId(record.id);
  const js = record.judgeScoreByContestant;
  if (record.standings?.length) {
    const ord = sortStandings(record.standings, js, seed);
    const top = ord[0];
    const tiedIds = ord.filter((r) => r.winRate === top.winRate).map((r) => r.id);
    const tie = tiedIds.length > 1;
    let tieBreak: StandingsTieBreak = 'none';
    let unresolved = false;
    if (tie) {
      const empatadosNaTaxa = ord.filter((r) => r.winRate === top.winRate);
      const mesmasVitorias = empatadosNaTaxa.filter((r) => r.wins === top.wins);
      if (mesmasVitorias.length === 1) tieBreak = 'wins';
      else {
        const s = (id: string): number | undefined => (typeof js?.[id] === 'number' ? js[id] : undefined);
        const topo = s(top.id);
        const mesmoScore = mesmasVitorias.filter((r) => s(r.id) === topo);
        if (topo !== undefined && mesmoScore.length === 1) tieBreak = 'judge-score';
        else {
          tieBreak = 'blind';
          unresolved = true;
        }
      }
    }
    return {
      contestantId: top.id,
      ruler: tieBreak === 'judge-score' ? 'duels+judge-score' : 'duels',
      tie,
      tiedIds: tie ? tiedIds : [top.id],
      tieBreak,
      unresolved,
    };
  }
  const ids = Object.keys(js ?? {});
  if (ids.length === 0) {
    return { ruler: 'judge-score', tie: false, tiedIds: [], tieBreak: 'none', unresolved: false };
  }
  const cego = blindRankMap([...ids].sort(), seed);
  const ord = [...ids].sort((a, b) => js![b] - js![a] || (cego.get(a) ?? 0) - (cego.get(b) ?? 0));
  const empatados = ord.filter((id) => js![id] === js![ord[0]]);
  return {
    contestantId: ord[0],
    ruler: 'judge-score',
    tie: empatados.length > 1,
    tiedIds: empatados,
    tieBreak: empatados.length > 1 ? 'blind' : 'none',
    unresolved: empatados.length > 1,
  };
}

/**
 * Combina as duas ordens de um par num resultado único: acordo ⇒ vencedor,
 * desacordo ⇒ EMPATE (a regra anti-viés de posição). Extraído para o núcleo
 * porque é a semântica que os dois motores precisam compartilhar byte a byte.
 */
export function combineDuelOrders(
  o1: 'a' | 'b' | 'tie',
  o2: 'a' | 'b' | 'tie',
): 'a' | 'b' | 'tie' {
  return o1 === o2 ? o1 : 'tie';
}

/**
 * Converte vereditos DETERMINÍSTICOS (ground-truth F1.4 / oráculo do agente) em
 * scores de oráculo na escala 0–2 do bracket: `runStageDuels` decide o par pelo
 * maior score, sem chamada LLM (§19.1 — "o oráculo manda").
 */
export function oracleScoresFromVerdicts(
  verdicts: Record<string, Verdict> | undefined,
): Record<string, number> | undefined {
  if (!verdicts || Object.keys(verdicts).length === 0) return undefined;
  return Object.fromEntries(Object.entries(verdicts).map(([id, v]) => [id, VERDICT_SCORE[v]]));
}
