// Seleção do vencedor, portada do `select.mjs` do prompt-arena.
// Métrica primária: judge-score = (resolve + 0.5·parcial) / total · 100.
// Uma variante só é promovida se superar o controle por uma margem prática
// (`minGain`) E passar no teste da melhor de K (max-T, IMPL-002); sem isso, o
// controle se mantém (convergência).

import type {
  BestOfKTest,
  GateConclusion,
  GateHoldReason,
  IterationGate,
  MultiplicityMethod,
  PairSensitivity,
  SensitivityCase,
  Verdict,
} from './types.js';
import { imputeExtremes, pairCoverage, SENSITIVITY_EXCLUSION_THRESHOLD, type PairScore } from './stats.js';
import { bestOfKTest, GATE_ALPHA, resolveMinGain, winnersCurseInflation } from './engine/bestOfK.js';
import { contaminationCheck, contaminationCorpus, type ContaminationStage } from './engine/contracts.js';
// O web recebe a margem default e o α do gate pelo shim de `rank` (UI da Nova run).
export { defaultMinGain, GATE_ALPHA } from './engine/bestOfK.js';

/**
 * Judge-score em [0,100] a partir dos vereditos pointwise de um contestant.
 * `undefined` = veredito AUSENTE (juiz falhou, competidor com erro de infra,
 * bloqueio do gateway — IMPL-004/IMPL-005): é "sem observação" e sai do
 * NUMERADOR e do DENOMINADOR. Antes contava como 'nao' — um veredito imputado
 * que movia o score mais que o `minGain` (R-03b:REC-4, R-04:REC-2). Sem
 * nenhuma observação → 0 (sem evidência, sem score); a run que chega aí já é
 * `inconclusive` pelo piso de n efetivo (`engine/verdictIntegrity.ts`).
 */
export function judgeScoreFromVerdicts(verdicts: (Verdict | undefined)[]): number {
  let resolve = 0;
  let parcial = 0;
  let n = 0;
  for (const v of verdicts) {
    if (v === undefined) continue;
    n++;
    if (v === 'resolve') resolve++;
    else if (v === 'parcial') parcial++;
  }
  if (n === 0) return 0;
  return ((resolve + 0.5 * parcial) / n) * 100;
}

/** Uma entrada do ranking de seleção (variante ou controle) de uma run. */
export interface RankEntry {
  id: string;
  label: string;
  /** true = o prompt base do usuário, rodado como controle. */
  isControl: boolean;
  /** Judge-score agregado em [0,100] (métrica primária). */
  judgeScore: number;
  /** Placement médio nos duelos/listwise (menor = melhor). Ausente = não duelou. */
  meanPlacement?: number;
  /** Quantidade de respostas com erro no pipeline (menor = melhor). */
  errored: number;
  /** Tamanho do system prompt (regularização: em empate, o mais curto vence). */
  promptLen: number;
}

/**
 * Ordena as entradas da melhor para a pior, sem mutar o array de entrada.
 * Cadeia de desempate: judge-score (desc) → placement médio (asc; ausente →
 * Infinity, para quem nunca duelou não vencer um empate espuriamente) →
 * menos erros → prompt mais curto (regularização por tamanho).
 */
export function rankEntries(entries: RankEntry[]): RankEntry[] {
  return [...entries].sort(
    (a, b) =>
      b.judgeScore - a.judgeScore ||
      (a.meanPlacement ?? Infinity) - (b.meanPlacement ?? Infinity) ||
      a.errored - b.errored ||
      a.promptLen - b.promptLen,
  );
}

/** Resultado do gate de promoção de uma iteração. */
export interface PickResult {
  best: RankEntry | undefined;
  control: RankEntry | undefined;
  /**
   * Vantagem do `best` sobre o controle em p.p. (pareada quando há `scoresById`).
   * É o ganho BRUTO — o máximo entre K, inflado pela seleção.
   */
  gain: number;
  isWinner: boolean;
  /**
   * Gate auditável (IMPL-005 + IMPL-002) — presente quando `scoresById` cobre
   * régua e best: pareamento, teste da melhor de K, ganho corrigido, margem.
   */
  gate?: IterationGate;
  /** IMPL-067: contaminação dados→prompt do `best` (com `opts.contamination`). */
  contamination?: NonNullable<IterationGate['contamination']>;
}

/**
 * Entrada da métrica de contaminação no gate (IMPL-067, R-20:REC-9): o prompt
 * de cada contestant, o corpus protegido (cenários ∪ gabaritos ∪ explicações
 * do juiz) e o que NÃO conta (o prompt de base/régua — a política do usuário).
 */
export interface PickWinnerContamination {
  promptById: Readonly<Record<string, string | undefined>>;
  protectedTexts: readonly string[];
  allowedTexts?: readonly string[];
}

const round2 = (x: number): number => Number(x.toFixed(2)) + 0;
const round4 = (x: number): number => Number(x.toFixed(4)) + 0;
/** Tolerância da comparação Δ ≥ minGain (50/3 etc. não são exatos em double). */
const GAIN_EPS = 1e-9;

/** Opções do gate de promoção. */
export interface PickWinnerOpts {
  /**
   * Margem prática (p.p.). Ausente → max(1; 50/nEfetivo) com `scoresById`
   * (IMPL-002); sem `scoresById` (caminho legado, sem n) → 1.
   */
  minGain?: number;
  /** Score por etapa (0–1; `null` = sem veredito) de cada contestant. */
  scoresById?: Readonly<Record<string, readonly PairScore[]>>;
  /** α do gate (FWER unilateral). Default {@link GATE_ALPHA} = 0,05. */
  alpha?: number;
  /** Correção de multiplicidade. Default `max-t`; `holm` é o fallback simples. */
  multiplicity?: MultiplicityMethod;
  /** B e seed do Monte Carlo (quando a enumeração exata passa do teto). */
  iterations?: number;
  seed?: number;
  /**
   * IMPL-067: com isto, a campeã que COLA um span exato ≥ 8 tokens do corpus
   * protegido NÃO é promovida (`heldBy: ['contamination']`) e o containment
   * de 8-gramas vai no gate — reportado para toda campeã.
   */
  contamination?: PickWinnerContamination;
}

/**
 * Corpus/prompts da métrica de contaminação a partir da RUN de seleção
 * (IMPL-067): cada contestant pelo fragmento evoluído (o que vira campeão) ou
 * pelo prompt; o corpus = cenários (pergunta, contexto, gabarito, rubrica) +
 * explicações/justificativas do juiz; permitido = o prompt da régua e o
 * original (o que a base já trazia não é contaminação).
 */
export function contaminationInputFromRun(
  run: {
    stages: readonly {
      spec?: ContaminationStage | null;
      referenceJudge?: { explanationByContestant?: Record<string, string> } | null;
      judge?: { judges?: readonly { verdicts?: readonly { motivo?: string }[] }[] } | null;
    }[];
    contestants: readonly { id: string; systemPrompt?: string; promptFragment?: string; isOriginal?: boolean }[];
  },
  controlId: string,
): PickWinnerContamination {
  const explicacoes: string[] = [];
  for (const st of run.stages ?? []) {
    explicacoes.push(...Object.values(st.referenceJudge?.explanationByContestant ?? {}));
    for (const j of st.judge?.judges ?? []) for (const v of j.verdicts ?? []) if (v.motivo) explicacoes.push(v.motivo);
  }
  const promptById: Record<string, string | undefined> = {};
  const allowed: string[] = [];
  for (const c of run.contestants ?? []) {
    promptById[c.id] = c.promptFragment ?? c.systemPrompt;
    if (c.id === controlId || c.isOriginal) {
      for (const t of [c.promptFragment, c.systemPrompt]) if (t) allowed.push(t);
    }
  }
  return {
    promptById,
    protectedTexts: contaminationCorpus(
      (run.stages ?? []).map((s) => s.spec),
      explicacoes,
    ),
    allowedTexts: allowed,
  };
}

/** Aplica a métrica/barreira de contaminação ao resultado do gate (IMPL-067). */
function withContamination(r: PickResult, c: PickWinnerContamination | undefined): PickResult {
  if (!c || !r.best) return r;
  const prompt = c.promptById[r.best.id];
  if (typeof prompt !== 'string' || !prompt.trim()) return r;
  const check = contaminationCheck(prompt, c.protectedTexts, { allowedTexts: c.allowedTexts ?? [] });
  const contamination = {
    containment: round4(check.containment),
    alert: check.alert,
    blocked: check.blocked,
    ...(check.detail ? { detail: check.detail } : {}),
  };
  if (!check.blocked) {
    return { ...r, contamination, ...(r.gate ? { gate: { ...r.gate, contamination } } : {}) };
  }
  // Barreira: campeã contaminada NUNCA é promovida, qualquer que seja o ganho.
  const gate: IterationGate | undefined = r.gate
    ? {
        ...r.gate,
        contamination,
        heldBy: [...(r.gate.heldBy ?? []), 'contamination'],
        decision: r.gate.decision === 'inconclusive' ? 'inconclusive' : 'held',
      }
    : undefined;
  return { ...r, isWinner: false, contamination, ...(gate ? { gate } : {}) };
}

/**
 * Escolhe o vencedor entre as entradas. `best` é a melhor variante (controle
 * excluído — ele é a régua, não um candidato, e a ordem é a de
 * {@link rankEntries}); `gain` é a vantagem do `best` sobre o controle em pontos
 * de judge-score.
 *
 * **Gate da melhor de K (IMPL-002, R-04:REC-3).** Com `scoresById` (score por
 * etapa na escala 0–1, `null` = sem veredito — ver `stageScoresByContestant`),
 * promover exige as TRÊS coisas:
 * 1. Δ pareado ≥ minGain — margem PRÁTICA, default max(1 p.p.; 50/n): meia
 *    granularidade de uma média sobre n pares;
 * 2. p ajustado ≤ α (0,05) no max-T por permutação sobre TODAS as K variantes
 *    da iteração (troca de sinais conjunta por cenário, Westfall-Young
 *    step-down) — "a melhor de K" não ganha mais sozinha: sem o teste, a
 *    simulação N1 mediu 25,8–85,7% de promoção falsa por iteração;
 * 3. a decisão sobrevive à sensibilidade pior/melhor caso quando os pares
 *    best × régua excluídos passam de 10% (IMPL-005): se muda, INCONCLUSIVO.
 * O gate registra ainda o ganho CORRIGIDO do winner's curse, lado a lado com o
 * bruto e o p ajustado.
 *
 * **Pareamento honesto (IMPL-005, R-04:REC-2).** O ganho é o Δ PAREADO: média
 * de (best − controle) só nas etapas com veredito nos DOIS lados.
 *
 * Sem `scoresById` fica o gate legado (Δ de judge-scores ≥ minGain, default 1):
 * sem os scores por etapa não há teste possível.
 */
export function pickWinner(entries: RankEntry[], opts?: PickWinnerOpts): PickResult {
  return withContamination(pickWinnerCore(entries, opts), opts?.contamination);
}

function pickWinnerCore(entries: RankEntry[], opts?: PickWinnerOpts): PickResult {
  const control = entries.find((e) => e.isControl);
  const best = rankEntries(entries.filter((e) => !e.isControl))[0];
  if (!best) return { best: undefined, control, gain: 0, isWinner: false };
  if (!control) {
    // Sem controle não há régua para medir ganho: a melhor variante vence por
    // definição (gain 0), pois não faz sentido bloquear a promoção pela
    // ausência de um baseline que a run nunca teve.
    return { best, control: undefined, gain: 0, isWinner: true };
  }
  const controlScores = opts?.scoresById?.[control.id];
  const bestScores = opts?.scoresById?.[best.id];
  if (!controlScores || !bestScores) {
    const minGain = opts?.minGain ?? 1.0;
    const gain = best.judgeScore - control.judgeScore;
    return { best, control, gain, isWinner: gain >= minGain };
  }

  // A FAMÍLIA do teste: toda variante da iteração com scores (a régua fica de
  // fora — ela é o controle de todas as comparações).
  const candidates = entries.filter((e) => !e.isControl && opts?.scoresById?.[e.id]);
  const bestIdx = candidates.findIndex((e) => e.id === best.id);
  const pairing = pairCoverage(controlScores, bestScores);
  const { minGain, source: minGainSource } = resolveMinGain(opts?.minGain, pairing.nEfetivo);
  const alpha = opts?.alpha ?? GATE_ALPHA;
  const flip = {
    method: opts?.multiplicity,
    iterations: opts?.iterations,
    seed: opts?.seed,
  };

  /** Decide num conjunto de scores (observado ou imputado na sensibilidade). */
  const evaluate = (control0: readonly PairScore[], scores: readonly (readonly PairScore[])[]) => {
    const test = bestOfKTest(control0, scores, flip);
    const nEf = test.nEfetivo[bestIdx];
    const gainPp = nEf > 0 ? test.meanDiff[bestIdx] * 100 : 0;
    const pAdj = test.pAdjusted[bestIdx];
    const heldBy: GateHoldReason[] = [];
    if (nEf === 0) heldBy.push('no-pairs');
    else {
      if (gainPp < minGain - GAIN_EPS) heldBy.push('min-gain');
      if (!(pAdj <= alpha)) heldBy.push('significance');
    }
    const conclusion: GateConclusion = heldBy.length === 0 ? 'promote' : 'hold';
    return { test, gainPp, pAdj, heldBy, conclusion };
  };

  const candScores = candidates.map((e) => opts!.scoresById![e.id]);
  const observed = evaluate(controlScores, candScores);

  // Sensibilidade (IMPL-005) no gate conjunto: imputa SÓ o par best × régua nos
  // extremos; as demais variantes mantêm exatamente os pares que tinham (onde a
  // régua não tinha veredito, seguem sem par). A margem é a MESMA do observado
  // (resolvida sobre o n efetivo): só a evidência muda entre os casos.
  let sensitivity: PairSensitivity<GateConclusion> | undefined;
  const nominal = pairing.n;
  if (nominal > 0 && pairing.excludedPairs / nominal > SENSITIVITY_EXCLUSION_THRESHOLD) {
    const toCase = (r: ReturnType<typeof evaluate>): SensitivityCase<GateConclusion> => ({
      meanDiffPp: round2(r.gainPp),
      pValue: r.pAdj,
      conclusion: r.conclusion,
    });
    const extreme = (scenario: 'worst' | 'best') => {
      const imp = imputeExtremes(controlScores, bestScores, scenario);
      const scores = candScores.map((sc, k) =>
        k === bestIdx
          ? imp.champion
          : imp.control.map((_, i) => (isObsScore(controlScores[i]) ? sc[i] : null)),
      );
      return evaluate(imp.control, scores);
    };
    const worst = extreme('worst');
    const bestCase = extreme('best');
    sensitivity = {
      excludedFraction: round4(pairing.excludedPairs / nominal),
      threshold: SENSITIVITY_EXCLUSION_THRESHOLD,
      observed: toCase(observed),
      worst: toCase(worst),
      best: toCase(bestCase),
      inconclusive: worst.conclusion !== observed.conclusion || bestCase.conclusion !== observed.conclusion,
    };
  }
  const inconclusive = sensitivity?.inconclusive === true;
  const isWinner = observed.conclusion === 'promote' && !inconclusive;

  // Winner's curse: bruto − inflação esperada da seleção entre as K.
  const curse = winnersCurseInflation(controlScores, candScores, { iterations: flip.iterations, seed: flip.seed });
  const gain = observed.gainPp;
  const t = observed.test;
  const test: BestOfKTest = {
    method: t.method,
    enumeration: t.enumeration,
    permutations: t.permutations,
    ...(t.seed !== undefined ? { seed: t.seed } : {}),
    alpha,
    k: t.k,
    nScenarios: t.nScenarios,
    pAdjusted: round4p(t.pAdjusted[bestIdx]),
    pRaw: round4p(t.pRaw[bestIdx]),
    byContestant: Object.fromEntries(
      candidates.map((e, k) => [
        e.id,
        {
          gainPp: t.nEfetivo[k] > 0 ? round2(t.meanDiff[k] * 100) : 0,
          nEfetivo: t.nEfetivo[k],
          pRaw: round4p(t.pRaw[k]),
          pAdjusted: round4p(t.pAdjusted[k]),
        },
      ]),
    ),
  };
  const gate: IterationGate = {
    controlId: control.id,
    bestId: best.id,
    minGain: round2(minGain),
    minGainSource,
    gainPp: round2(gain),
    gainCorrectedPp: round2(pairing.nEfetivo > 0 ? gain - curse.inflation * 100 : 0),
    pairing,
    test,
    ...(observed.heldBy.length ? { heldBy: observed.heldBy } : {}),
    ...(sensitivity ? { sensitivity } : {}),
    decision: inconclusive ? 'inconclusive' : isWinner ? 'promoted' : 'held',
  };
  return { best, control, gain, isWinner, gate };
}

const isObsScore = (v: PairScore): v is number => typeof v === 'number' && Number.isFinite(v);
/**
 * p com 4 algarismos SIGNIFICATIVOS (não casas): o exato pode ser 2^−20 ≈ 9,5e-7
 * e 4 casas o zeraria — p = 0 é uma afirmação que o teste nunca faz.
 */
const round4p = (p: number): number => Number(p.toPrecision(4));

/**
 * Campos IMPL-002 do evento `iteration.promoted` a partir do gate: ganho
 * corrigido, p ajustado, K, método e margem — lado a lado com o `gain` bruto.
 * Um helper só para os dois trainers (mirror) emitirem o MESMO payload.
 */
export function promotionEventFields(gate: IterationGate | undefined): {
  gainCorrected?: number;
  pAdjusted?: number;
  k?: number;
  method?: MultiplicityMethod;
  minGain?: number;
} {
  if (!gate) return {};
  return {
    ...(gate.gainCorrectedPp !== undefined ? { gainCorrected: gate.gainCorrectedPp } : {}),
    ...(gate.test
      ? { pAdjusted: gate.test.pAdjusted, k: gate.test.k, method: gate.test.method }
      : {}),
    minGain: gate.minGain,
  };
}
