// Teste de significância pareado, portado do prompt-arena (`server/studio/stats.mjs`).
// Campeão e controle rodam nos MESMOS cenários pinados, então o teste certo é
// pareado: bootstrap da média dos diffs por cenário. É SUPORTE À DECISÃO (a UI
// mostra) — os gates duros continuam sendo min-gain + holdout sem regressão.

import type { Verdict } from './types.js';

/**
 * Score por veredito na escala do judge-score ÷100 (0–1). ATENÇÃO: não confundir
 * com o score ordinal 0–2 de `duels.ts` — lá a ordem entre resolve/parcial/nao é o
 * que importa; aqui é a fração de crédito que alimenta o judge-score e o bootstrap.
 */
export const VERDICT_SCORE: Record<Verdict, number> = { resolve: 1, parcial: 0.5, nao: 0 };

/**
 * PRNG determinístico (mulberry32). Duplicado de `duels.ts` DE PROPÓSITO, como no
 * original: cada módulo semeia o seu (aqui a seed fixa o bootstrap; lá a seed
 * deriva do scenarioId para o shuffle cego), e um helper compartilhado acoplaria
 * duas fontes de aleatoriedade que devem evoluir independentes.
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

/**
 * Bootstrap pareado de (campeão − controle) sobre os cenários compartilhados.
 * Os scores entram como arrays paralelos posição a posição (na escala 0–1 de
 * {@link VERDICT_SCORE}); o pareamento usa as primeiras `min(length)` posições.
 * Retorna tudo em PONTOS de judge-score (×100, 2 casas) ou `null` com n<5 pares
 * (amostra pequena demais para confiar — mesmo piso de `MIN_HOLDOUT_SCENARIOS`).
 *
 * Determinístico (mulberry32 semeado): recomputar um resultado salvo reproduz o
 * mesmo p-valor. `pValue` é unilateral na direção da promoção (H1: campeão >
 * controle) = fração dos resamples com média de diff ≤ 0.
 *
 * **Pareamento.** Por padrão os pares são posicionais (indice i do campeão
 * emparelha com o indice i do controle). Quando os dados têm repeticoes por
 * cenario (§18.4), o par correto é `(cenario, repeticão)`, e a chamada deve
 * passar `pairKeys`: um vetor de chaves (uma por score, mesma ordem) usado
 * para emparelhar por CHAVE em vez de por indice. Chaves presentes nos dois
 * lados formam os pares; a ordem preservada é a de `controlScores` (a chamada
 * deve fornecer os lacos na mesma ordem). Sem `pairKeys`, comportamento
 * idêntico ao legado (posicional) — `opts` ausente nao muda nada.
 */
export function pairedSignificance(
  controlScores: number[],
  championScores: number[],
  opts?: { iterations?: number; seed?: number; pairKeys?: string[] },
): { n: number; meanDiffPp: number; ci95Pp: [number, number]; pValue: number } | null {
  let diffs: number[];
  if (opts?.pairKeys) {
    // Pareamento por (cenario x repeticão): a chave e a identidade do par.
    const champByName = new Map<string, number>();
    const nChamp = Math.min(championScores.length, opts.pairKeys.length);
    for (let i = 0; i < nChamp; i += 1) champByName.set(opts.pairKeys[i], championScores[i]);
    diffs = [];
    const nCtrl = Math.min(controlScores.length, opts.pairKeys.length);
    for (let i = 0; i < nCtrl; i += 1) {
      const v = champByName.get(opts.pairKeys[i]);
      if (v !== undefined) diffs.push(v - controlScores[i]);
    }
  } else {
    // Legado: pareamento posicional pelas primeiras min(length) posicoes.
    const n = Math.min(controlScores.length, championScores.length);
    diffs = [];
    for (let i = 0; i < n; i += 1) diffs.push(championScores[i] - controlScores[i]);
  }
  const n = diffs.length;
  if (n < 5) return null;

  const iterations = opts?.iterations ?? 2000;
  const rng = mulberry32(opts?.seed ?? 1337);
  const means: number[] = new Array(iterations);
  for (let it = 0; it < iterations; it += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += diffs[Math.floor(rng() * n)];
    means[it] = sum / n;
  }
  means.sort((a, b) => a - b);
  const q = (p: number) => means[Math.min(iterations - 1, Math.max(0, Math.floor(p * iterations)))];
  let atOrBelowZero = 0;
  for (const m of means) if (m <= 0) atOrBelowZero += 1;
  const meanDiff = diffs.reduce((s, x) => s + x, 0) / n;

  return {
    n,
    meanDiffPp: Number((meanDiff * 100).toFixed(2)),
    ci95Pp: [Number((q(0.025) * 100).toFixed(2)), Number((q(0.975) * 100).toFixed(2))],
    pValue: Number((atOrBelowZero / iterations).toFixed(4)),
  };
}
