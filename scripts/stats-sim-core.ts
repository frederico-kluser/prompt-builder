// Núcleo do harness de simulação do gate de promoção (IMPL-002, R-04:REC-3).
//
// Reproduz o modelo de ruído da simulação N1 (evidência `sim_promotion.ts`, hoje
// na memória CoALA) e mede o gate REAL (`pickWinner` com `scoresById`, o mesmo
// caminho do trainer): promoção falsa por iteração sob H0 e viés do ganho
// exibido (bruto × corrigido) sob H1. Usado por `scripts/stats-sim.ts`
// (`npm run stats:sim`, a grade completa) e por `test/stats-sim.test.ts` (a
// versão reduzida e rápida). Não entra no pacote publicado (fora de `src/`).
//
// Modelo de ruído (N1): o veredito "verdadeiro" de cada cenário é sorteado
// 60/25/15 (resolve/parcial/nao) e COMPARTILHADO (dificuldade comum); cada
// resposta — controle e cada variante — redesenha o veredito do seu cenário com
// probabilidade `flip` (ruído do competidor + do juiz). Sob H0 as variantes têm
// a MESMA qualidade do controle: qualquer promoção é falsa por construção.
// Sob H1 cada resposta de uma variante com efeito vira 'resolve' com
// probabilidade q = 0,10/0,275 — como a marginal de toda resposta é 60/25/15
// (E[1 − s] = 0,275), o efeito verdadeiro é EXATAMENTE +10 p.p.
// As premissas de ruído não foram calibradas com dados reais (como na N1).

import { mulberry32 } from '../src/stats.js';
import { judgeScoreFromVerdicts, pickWinner, type RankEntry } from '../src/rank.js';
import type { MultiplicityMethod, Verdict } from '../src/types.js';
import { pickReevalMinibatch, reevalDecision, shouldStopForPatience, TRAINING_PATIENCE } from '../src/engine/trainingPolicy.js';

/** Efeito verdadeiro de H1 (p.p.). */
export const H1_EFFECT_PP = 10;
/** Marginal 60/25/15 → E[1 − score] = 0,275; q converte isso em +10 p.p. exatos. */
const UPGRADE_Q = H1_EFFECT_PP / 100 / 0.275;
const SCORE: Record<Verdict, number> = { resolve: 1, parcial: 0.5, nao: 0 };

/**
 * `h0`: todas as K variantes iguais ao controle. `h1`: TODAS com +10 p.p. — a
 * verdade da selecionada é +10 qualquer que seja ela, então o viés do ganho
 * exibido é bem definido (é o winner's curse puro). `h1-sparse`: só a 1ª
 * variante tem +10 (as outras são nulas) — informativo.
 */
export type SimMode = 'h0' | 'h1' | 'h1-sparse';

export interface CellSpec {
  n: number;
  K: number;
  flip: number;
  mode: SimMode;
  trials: number;
  /** minGain explícito; ausente = o default do gate, max(1; 50/n). */
  minGain?: number;
  multiplicity?: MultiplicityMethod;
  /** Fração de vereditos ausentes (sorteada por resposta) — 0 na grade de aceite. */
  missingRate?: number;
}

export interface CellResult extends CellSpec {
  seed: number;
  /** Promoções pelo gate IMPL-002 / ensaios (sob H0: promoção FALSA; sob H1: poder). */
  promotionRate: number;
  /** Limite superior de Wilson a 95% da taxa acima. */
  promotionRateUpper95: number;
  /** O gate ANTIGO (Δ ≥ 1 p.p., sem teste) nos MESMOS ensaios — a linha de base N1. */
  legacyPromotionRate: number;
  /** Viés médio (p.p.) do ganho BRUTO da selecionada, sobre todos os ensaios. */
  biasRawPp: number;
  /** Viés médio (p.p.) do ganho CORRIGIDO da selecionada, sobre todos os ensaios. */
  biasCorrectedPp: number;
  /** Erro-padrão Monte Carlo do viés corrigido. */
  biasCorrectedSe: number;
  /** Viés condicionado à promoção (o que o evento `iteration.promoted` mostra); null sem promoção. */
  biasRawPromotedPp: number | null;
  biasCorrectedPromotedPp: number | null;
  ms: number;
}

/** Seed determinística por célula (independe da ordem/paralelismo de execução). */
export function cellSeed(c: Pick<CellSpec, 'n' | 'K' | 'flip' | 'mode'>): number {
  const key = `${c.mode}|${c.n}|${c.K}|${c.flip}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function wilsonUpper(x: number, n: number, z = 1.96): number {
  if (n === 0) return 1;
  const p = x / n;
  const den = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.min(1, (center + half) / den);
}

const r4 = (x: number): number => Number(x.toFixed(4));
const r2 = (x: number): number => Number(x.toFixed(2));

/** Roda UMA célula da grade com o `pickWinner` real. Determinística por `cellSeed`. */
export function simulateCell(spec: CellSpec): CellResult {
  const t0 = performance.now();
  const seed = cellSeed(spec);
  const rng = mulberry32(seed);
  const pick = (): Verdict => {
    const u = rng();
    return u < 0.6 ? 'resolve' : u < 0.85 ? 'parcial' : 'nao';
  };
  const { n, K, flip, mode, trials } = spec;
  const missing = spec.missingRate ?? 0;
  const effects = Array.from({ length: K }, (_, k) =>
    mode === 'h1' || (mode === 'h1-sparse' && k === 0) ? H1_EFFECT_PP : 0,
  );

  let promoted = 0;
  let legacy = 0;
  let sumRaw = 0;
  let sumCor = 0;
  let sumCor2 = 0;
  let sumRawP = 0;
  let sumCorP = 0;
  for (let t = 0; t < trials; t += 1) {
    const base: Verdict[] = Array.from({ length: n }, pick);
    const draw = (effect: number): (Verdict | undefined)[] =>
      base.map((b) => {
        let v = rng() < flip ? pick() : b;
        if (effect > 0 && rng() < UPGRADE_Q) v = 'resolve';
        return missing > 0 && rng() < missing ? undefined : v;
      });
    const ctrl = draw(0);
    const vars = effects.map((e) => draw(e));
    const toScores = (vs: (Verdict | undefined)[]) => vs.map((v) => (v ? SCORE[v] : null));
    const scoresById: Record<string, (number | null)[]> = { ctl: toScores(ctrl) };
    const entries: RankEntry[] = [
      { id: 'ctl', label: 'ctl', isControl: true, judgeScore: judgeScoreFromVerdicts(ctrl.filter(Boolean)), errored: 0, promptLen: 0 },
    ];
    vars.forEach((v, k) => {
      scoresById[`v${k}`] = toScores(v);
      entries.push({
        id: `v${k}`,
        label: `v${k}`,
        isControl: false,
        judgeScore: judgeScoreFromVerdicts(v.filter(Boolean)),
        errored: 0,
        // Desempate determinístico por índice (como na N1).
        promptLen: 100 + k,
      });
    });
    const res = pickWinner(entries, {
      ...(spec.minGain !== undefined ? { minGain: spec.minGain } : {}),
      scoresById,
      multiplicity: spec.multiplicity,
    });
    const gate = res.gate!;
    const truth = effects[Number(res.best!.id.slice(1))];
    if (res.isWinner) promoted += 1;
    if (res.gain >= 1) legacy += 1;
    const raw = res.gain - truth;
    const cor = (gate.gainCorrectedPp ?? res.gain) - truth;
    sumRaw += raw;
    sumCor += cor;
    sumCor2 += cor * cor;
    if (res.isWinner) {
      sumRawP += raw;
      sumCorP += cor;
    }
  }
  const meanCor = sumCor / trials;
  const varCor = Math.max(0, sumCor2 / trials - meanCor * meanCor);
  return {
    ...spec,
    seed,
    promotionRate: r4(promoted / trials),
    promotionRateUpper95: r4(wilsonUpper(promoted, trials)),
    legacyPromotionRate: r4(legacy / trials),
    biasRawPp: r2(sumRaw / trials),
    biasCorrectedPp: r2(meanCor),
    biasCorrectedSe: r2(Math.sqrt(varCor / trials)),
    biasRawPromotedPp: promoted ? r2(sumRawP / promoted) : null,
    biasCorrectedPromotedPp: promoted ? r2(sumCorP / promoted) : null,
    ms: Math.round(performance.now() - t0),
  };
}

/** Limiar de aceite (R-04:REC-3): promoção falsa por iteração ≤ 5,5% em TODA célula H0. */
export const MAX_FALSE_PROMOTION = 0.055;
/** Limiar de aceite: |viés médio| do ganho corrigido ≤ 1 p.p. sob H1 de +10 p.p. */
export const MAX_ABS_BIAS_PP = 1;

/** A grade do critério de aceite: n 5–50 × K 1–8 × flip {0,15; 0,30}. */
export function acceptanceGrid(trials: number, modes: SimMode[] = ['h0', 'h1']): CellSpec[] {
  const cells: CellSpec[] = [];
  for (const mode of modes) {
    for (const flip of [0.15, 0.3]) {
      for (const n of [5, 8, 10, 12, 15, 20, 30, 40, 50]) {
        for (let K = 1; K <= 8; K += 1) cells.push({ n, K, flip, mode, trials });
      }
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// IMPL-013 (R-02b:REC-2) — simulação da SESSÃO inteira (o laço, não só o gate).
//
// A pergunta do item é a do usuário: "o treino promoveu um prompt que não é
// melhor?". Sob H0 as variantes de TODA iteração têm a qualidade do campeão, então
// qualquer promoção na sessão é falsa. O laço simulado é o do trainer, com as
// MESMAS funções puras (`pickWinner`, `pickReevalMinibatch`, `reevalDecision`,
// `shouldStopForPatience`):
// - cenários pinados: o veredito "verdadeiro" de cada cenário é sorteado uma vez
//   por sessão (60/25/15) e vale em todas as iterações;
// - cada iteração: régua (carry) + K variantes redesenham com `flip`; gate da
//   melhor de K; se passar, re-avaliação LIMPA do candidato contra a régua no
//   minibatch max(5, ceil(0,3·n)) com respostas NOVAS; promove só com melhora
//   estrita;
// - paciência 2 e teto de `maxIterations` (5, o topo da faixa 3–5).
// A linha de base (`legacy*`) é o laço antigo nos mesmos parâmetros: Δ ≥ 1 p.p.
// sem teste, sem re-avaliação e paciência 1 — a sessão para na 1ª iteração sem
// promoção. Sob H0 a taxa de sessão dele é a de promoção falsa da iteração 0
// (≈ 60,8% com n = 8, K = 4, flip 0,15 — o "hoje" do item).

export interface SessionSpec {
  n: number;
  K: number;
  flip: number;
  trials: number;
  /** Teto de iterações da sessão (default 5). */
  maxIterations?: number;
  /** Paciência (default {@link TRAINING_PATIENCE} = 2). */
  patience?: number;
  /** Re-avaliação limpa antes de promover (default true). */
  reeval?: boolean;
}

export interface SessionResult extends SessionSpec {
  seed: number;
  /** Sessões com ≥ 1 promoção (sob H0: promoção FALSA na sessão). */
  sessionFalsePromotionRate: number;
  sessionFalsePromotionUpper95: number;
  /** Promoções / iterações rodadas (taxa por iteração dentro do laço novo). */
  perIterationPromotionRate: number;
  /** Iterações médias por sessão (a paciência faz rodar mais que 1). */
  meanIterations: number;
  /** Candidatos que passaram no gate e a re-avaliação barrou / que passaram no gate. */
  reevalRejectionRate: number | null;
  /** Laço antigo (Δ ≥ 1 p.p., paciência 1, sem re-avaliação) nas mesmas condições. */
  legacySessionFalsePromotionRate: number;
  ms: number;
}

/** Seed da sessão: independe da seed das células por iteração. */
export function sessionSeed(s: Pick<SessionSpec, 'n' | 'K' | 'flip'>): number {
  return cellSeed({ n: s.n, K: s.K, flip: s.flip, mode: 'h0' }) ^ 0x5e55_1013;
}

/** Roda `trials` sessões sob H0 com o laço IMPL-013 e o laço antigo. Determinística. */
export function simulateSession(spec: SessionSpec): SessionResult {
  const t0 = performance.now();
  const seed = sessionSeed(spec) >>> 0;
  const rng = mulberry32(seed);
  const pick = (): Verdict => {
    const u = rng();
    return u < 0.6 ? 'resolve' : u < 0.85 ? 'parcial' : 'nao';
  };
  const { n, K, flip, trials } = spec;
  const maxIterations = spec.maxIterations ?? 5;
  const patience = spec.patience ?? TRAINING_PATIENCE;
  const useReeval = spec.reeval !== false;
  const redraw = (b: Verdict): Verdict => (rng() < flip ? pick() : b);
  const score = (v: Verdict): number => SCORE[v];

  const gate = (base: Verdict[], legacy: boolean) => {
    const ctrl = base.map(redraw);
    const vars = Array.from({ length: K }, () => base.map(redraw));
    const scoresById: Record<string, number[]> = { ctl: ctrl.map(score) };
    const entries: RankEntry[] = [
      { id: 'ctl', label: 'ctl', isControl: true, judgeScore: judgeScoreFromVerdicts(ctrl), errored: 0, promptLen: 0 },
    ];
    vars.forEach((v, k) => {
      scoresById[`v${k}`] = v.map(score);
      entries.push({ id: `v${k}`, label: `v${k}`, isControl: false, judgeScore: judgeScoreFromVerdicts(v), errored: 0, promptLen: 100 + k });
    });
    const res = pickWinner(entries, legacy ? { minGain: 1 } : { scoresById });
    return legacy ? res.gain >= 1 : res.isWinner;
  };

  let sessionsPromoted = 0;
  let promotions = 0;
  let iterations = 0;
  let gatePassed = 0;
  let reevalRejected = 0;
  let legacyPromoted = 0;
  for (let t = 0; t < trials; t += 1) {
    const base: Verdict[] = Array.from({ length: n }, pick);
    // Laço IMPL-013.
    let streak = 0;
    let promotedHere = false;
    for (let it = 0; it < maxIterations; it += 1) {
      iterations += 1;
      let promoted = gate(base, false);
      if (promoted && useReeval) {
        gatePassed += 1;
        // Minibatch de cenários de treino + respostas NOVAS de régua e candidato.
        const idx = pickReevalMinibatch(Array.from(base.keys()), Math.floor(rng() * 2 ** 32));
        const d = reevalDecision(
          idx.map((i) => score(redraw(base[i]))),
          idx.map((i) => score(redraw(base[i]))),
        );
        if (!d.confirmed) reevalRejected += 1;
        promoted = d.confirmed;
      }
      if (promoted) {
        promotions += 1;
        promotedHere = true;
      }
      streak = promoted ? 0 : streak + 1;
      if (!promoted && shouldStopForPatience(streak, patience)) break;
    }
    if (promotedHere) sessionsPromoted += 1;
    // Laço antigo: sob H0 só a iteração 0 importa — sem promoção ele para ali, e
    // com promoção a sessão já promoveu algo falso.
    if (gate(base, true)) legacyPromoted += 1;
  }
  return {
    ...spec,
    maxIterations,
    patience,
    reeval: useReeval,
    seed,
    sessionFalsePromotionRate: r4(sessionsPromoted / trials),
    sessionFalsePromotionUpper95: r4(wilsonUpper(sessionsPromoted, trials)),
    perIterationPromotionRate: r4(promotions / iterations),
    meanIterations: r2(iterations / trials),
    reevalRejectionRate: gatePassed ? r4(reevalRejected / gatePassed) : null,
    legacySessionFalsePromotionRate: r4(legacyPromoted / trials),
    ms: Math.round(performance.now() - t0),
  };
}

/** Limiar de aceite do IMPL-013: promoção falsa por SESSÃO < 30% (n = 8, K = 4, flip 0,15). */
export const MAX_SESSION_FALSE_PROMOTION = 0.3;
