// Split anti-overfit de holdout, portado do prompt-arena (`server/studio/holdout.mjs`).
// A fatia de holdout fica FORA da seleção: ao fim do treino o campeão final e o
// controle rodam nela de novo e uma regressão nela bloqueia a promoção.
//
// IMPL-050 (R-04:REC-5) — guardas de poder: com 5 cenários o poder para Δ = 10
// p.p. é ~10–14% (nada é decidido), então o piso virou ABSOLUTO em 10 cenários
// e o ratio default subiu para 0,3. Abaixo do piso o split NÃO é holdout — é
// "confirmação fraca" (a palavra "validado" fica bloqueada: sem poder, não há
// confirmação a declarar). Com o piso de 10 e o teto de ratio 0,5, seleções com
// menos de 20 cenários nunca produzem holdout — exatamente o limiar da pesquisa.

import type { HoldoutSkipReason, Verdict } from './types.js';
import { judgeScoreFromVerdicts } from './rank.js';
import { stageCountsInJudgeScore } from './engine/verdictAggregate.js';

/**
 * Mínimo de cenários em holdout para o gate final significar algo. Abaixo
 * disso 1 cenário balança o judge-score em ≥100/n pontos e a "regressão" é
 * ruído. Piso ABSOLUTO (IMPL-050): a fatia só se chama holdout com n ≥ 10.
 */
export const MIN_HOLDOUT_SCENARIOS = 10;
/** Fração default reservada para holdout (IMPL-050: era 0,2 — 5 cenários em 25). */
export const HOLDOUT_RATIO_DEFAULT = 0.3;
/** Teto da fração reservada (metade da seleção: treinar também é preciso). */
export const HOLDOUT_RATIO_MAX = 0.5;

/**
 * Força da confirmação final (IMPL-050): `holdout` só com o piso cumprido;
 * `confirmacao-fraca` com fatia curta demais para decidir; `nenhum` sem fatia.
 */
export type HoldoutStrength = 'holdout' | 'confirmacao-fraca' | 'nenhum';

export function holdoutStrength(n: number): HoldoutStrength {
  if (n >= MIN_HOLDOUT_SCENARIOS) return 'holdout';
  return n > 0 ? 'confirmacao-fraca' : 'nenhum';
}

/**
 * Tamanho da fatia de holdout: `max(ratio·n, MIN_HOLDOUT_SCENARIOS)`, limitado
 * a n/2. O piso de 10 é absoluto — por isso seleções com n < 20 nunca formam
 * holdout (o teto de 0,5 não deixa 10 cenários fora do treino).
 */
export function holdoutSplitSize(n: number, holdoutRatio: number): number {
  const total = Math.max(0, Math.floor(n));
  const ratio = Number.isFinite(holdoutRatio)
    ? Math.min(Math.max(holdoutRatio, 0), HOLDOUT_RATIO_MAX)
    : HOLDOUT_RATIO_DEFAULT;
  if (ratio === 0 || total === 0) return 0;
  return Math.min(Math.floor(total / 2), Math.max(Math.round(ratio * total), MIN_HOLDOUT_SCENARIOS));
}

/**
 * Divide a seleção pinada em fatias de treino + holdout.
 *
 * Split intercalado determinístico (índices espalhados pela seleção inteira)
 * para que AMBAS as fatias amostrem a seleção inteira, em vez de um bloco
 * contíguo de cabeça/cauda. A fatia sai com {@link holdoutSplitSize} cenários;
 * quando ela fica abaixo de {@link MIN_HOLDOUT_SCENARIOS} o split NÃO é
 * holdout — tudo treina e `strength` marca `confirmacao-fraca` (IMPL-050: o
 * chamador marca `holdoutSkipped` e nunca escreve "validado").
 *
 * @param items        os cenários pinados da run
 * @param holdoutRatio fração a reservar (clamp em [0, 0.5]; 0 desliga o holdout)
 */
export function splitHoldout<T>(
  items: T[],
  holdoutRatio: number = HOLDOUT_RATIO_DEFAULT,
): { train: T[]; holdout: T[]; reserved: T[]; strength: HoldoutStrength } {
  const list = Array.isArray(items) ? items : [];
  const alvo = holdoutSplitSize(list.length, holdoutRatio);
  const reserved: T[] = [];
  const train: T[] = [];
  if (alvo > 0) {
    const escolhidos = new Set<number>();
    for (let j = 0; j < alvo; j += 1) {
      // Último item do (j+1)-ésimo bloco de n/alvo: espalha sem sobrepor
      // (alvo ≤ n/2 ⇒ espaçamento ≥ 2 ⇒ índices sempre distintos).
      escolhidos.add(Math.min(list.length - 1, Math.ceil(((j + 1) * list.length) / alvo) - 1));
    }
    list.forEach((item, i) => {
      if (escolhidos.has(i)) reserved.push(item);
      else train.push(item);
    });
  } else {
    train.push(...list);
  }

  const strength = holdoutStrength(reserved.length);
  // Pouco poder para confiar ⇒ sem holdout: a seleção inteira treina e a
  // confirmação final fica rotulada "confirmação fraca" (nunca "holdout").
  return {
    train: strength === 'holdout' ? train : list.slice(),
    holdout: strength === 'holdout' ? reserved : [],
    reserved,
    strength,
  };
}

/** O mínimo de uma etapa que a visão de seleção lê (estrutural: serve aos dois motores). */
interface SelectionStage {
  spec?: unknown;
  incomplete?: boolean;
  referenceJudge?: {
    verdictByContestant: Record<string, Verdict>;
    verdictsByRep?: Record<string, Verdict[]>;
  };
}

/**
 * Visão de SELEÇÃO de uma run que cobriu a fatia de holdout (web-code#1).
 *
 * A iteração 0 roda em TODOS os cenários — é nela que eles são gerados e
 * congelam — e o split só acontece depois. Sem esta visão o gate da iteração 0,
 * a re-avaliação, as lições da iteração 1 e o pool Pareto liam a fatia que o
 * gate final depois "valida": o campeão era escolhido em parte nos MESMOS
 * cenários do teste cego. Aqui ficam só as etapas de TREINO (identidade de
 * objeto: `splitHoldout` devolve as mesmas specs que vieram de `run.stages`),
 * o judge-score é RECOMPUTADO sobre elas com a regra do orchestrator (etapas
 * com juiz de referência e não cortadas; o vetor por repetição quando existe —
 * §18.4 —, senão o veredito agregado; ausente não é observação) e os demais
 * agregados de run inteira saem. A run gravada não muda (a UI segue mostrando
 * tudo).
 */
export function trainOnlyView<
  R extends { stages: readonly SelectionStage[]; contestants: readonly { id: string }[] },
>(run: R, train: readonly unknown[]): R {
  const keep = new Set<unknown>(train);
  return selectionView(run, (spec) => keep.has(spec));
}

/**
 * Visão de SELEÇÃO genérica: só as etapas cuja spec passa em `keep`, com o
 * judge-score RECOMPUTADO sobre elas (a mesma regra de {@link trainOnlyView})
 * e os agregados de run inteira fora. Serve também ao "leave-demos-out" do
 * few-shot (IMPL-061): a pergunta que um prompt carrega como demo não pode
 * decidir a seleção (o prompt a acerta de graça).
 */
export function selectionView<
  R extends { stages: readonly SelectionStage[]; contestants: readonly { id: string }[] },
>(run: R, keep: (spec: unknown) => boolean): R {
  const stages = run.stages.filter((s) => s.spec !== undefined && keep(s.spec));
  const view = { ...run, stages } as Record<string, unknown>;
  for (const k of RUN_WIDE_AGGREGATES) delete view[k];
  // Regra ÚNICA de "a etapa vale no judge-score" (a mesma dos orquestradores).
  const comRef = stages.filter(stageCountsInJudgeScore);
  if (comRef.length > 0) {
    view.judgeScoreByContestant = Object.fromEntries(
      run.contestants.map((c) => [
        c.id,
        judgeScoreFromVerdicts(
          comRef.flatMap((s) => {
            const porRep = s.referenceJudge!.verdictsByRep?.[c.id];
            if (porRep) return porRep;
            const v = s.referenceJudge!.verdictByContestant[c.id];
            return v === undefined ? [] : [v];
          }),
        ),
      ]),
    );
  }
  return view as R;
}

/** Agregados de run inteira (cobrem a fatia de holdout) — fora da visão de seleção. */
const RUN_WIDE_AGGREGATES = [
  'judgeScoreByContestant',
  'standings',
  'completeness',
  'resolveRateByContestant',
  'censoredResolveRateByContestant',
  'limitCutsByContestant',
] as const;

/** α unilateral do teste final em holdout (o único p de confirmação da sessão). */
export const HOLDOUT_ALPHA = 0.05;

/** Menor seleção que forma holdout: o piso de 10 com o teto de metade (n/2 ≥ 10). */
export const MIN_SCENARIOS_FOR_HOLDOUT = Math.ceil(MIN_HOLDOUT_SCENARIOS / HOLDOUT_RATIO_MAX);

/**
 * Resultado do holdout que decide a palavra "validado" (IMPL-050): só um
 * holdout forte que RODOU, sem regressão, com o p do PRÓPRIO holdout ≤ α.
 */
export interface HoldoutOutcome {
  regressed: boolean;
  /** Δ campeão − controle (p.p.) nos pares completos do holdout. */
  gainPp: number;
  /** p UNILATERAL do teste final (o do gate, α=0,05). null/ausente = sem p válido. */
  pValue?: number | null;
  /** Origem do p — só `holdout` confirma (seleção é anti-conservador). */
  pOrigin?: 'holdout' | 'selecao' | 'sem p';
}

/**
 * Motivo de a sessão ter terminado sem holdout, em PT-BR — a MESMA frase no
 * CLI, na UI e no handoff (web-code#8/cli#9: antes toda sessão pequena dizia
 * "pulado por orçamento/cancelamento", mandando subir o teto quando o remédio
 * era ter mais cenários).
 */
export function holdoutSkipReasonText(reason: HoldoutSkipReason): string {
  switch (reason) {
    case 'min-scenarios':
      return (
        `seleção pequena demais: com menos de ${MIN_SCENARIOS_FOR_HOLDOUT} cenários a fatia reservada fica abaixo do ` +
        `piso de ${MIN_HOLDOUT_SCENARIOS} (limitada à metade da seleção) — use ≥ ${MIN_SCENARIOS_FOR_HOLDOUT} cenários para ter teste cego`
      );
    case 'disabled':
      return 'holdout desligado (holdoutRatio 0)';
    case 'budget':
      return 'pulado por orçamento: o teto não cobria a run de holdout (ou a sessão parou por orçamento) — aumente o orçamento';
    case 'cancelled':
      return 'pulado: a sessão foi cancelada/interrompida antes do teste final';
    case 'no-change':
      return 'o campeão final é o próprio prompt base (nenhuma variante promovida) — nada a validar';
    case 'no-base':
      return 'sem prompt base não há controle para o holdout';
    case 'run-failed':
      return 'a run de holdout terminou sem veredito válido (erro ou inconclusiva)';
  }
}

/** Motivos que deixam o campeão NÃO validado (os que ligam `holdoutSkipped`). */
export function holdoutSkipLeavesUnvalidated(reason: HoldoutSkipReason): boolean {
  return reason === 'min-scenarios' || reason === 'budget' || reason === 'cancelled' || reason === 'run-failed';
}

const fmtSignedPp = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(1)}pp`;
const fmtP = (p: number): string => (p < 0.001 ? 'p<0.001' : `p=${p.toFixed(3)}`);

/**
 * Texto honesto da confirmação do campeão contra sobreajuste (IMPL-050).
 *
 * ⚠️ A palavra "validado" SÓ aparece quando o holdout é forte (n ≥ 10), de
 * fato rodou E confirmou: sem regressão, com o p UNILATERAL do próprio holdout
 * ≤ α=0,05 (`outcome`). Holdout que rodou e regrediu ou não bateu α diz
 * "NÃO confirmado" com Δ e p; abaixo do piso, ou pulado, sai "confirmação
 * fraca" com o motivo (`skipReason`). Nenhum desses textos traz "validado" (a
 * asserção vive em `test/holdout-power-guards.test.ts`).
 */
export function holdoutConfirmationText(
  n: number,
  opts: {
    skipped?: boolean;
    strength?: HoldoutStrength;
    skipReason?: HoldoutSkipReason;
    outcome?: HoldoutOutcome;
  } = {},
): string {
  const strength = opts.strength ?? holdoutStrength(n);
  const motivo = opts.skipReason ? holdoutSkipReasonText(opts.skipReason) : undefined;
  if (!opts.skipped && strength === 'holdout') {
    const o = opts.outcome;
    if (!o) return `holdout (n=${n} cenários) sem resultado avaliado — campeão ainda sem confirmação contra sobreajuste`;
    const delta = `Δ ${fmtSignedPp(o.gainPp)}`;
    if (o.regressed || o.gainPp < 0) {
      return `holdout rodado (n=${n} cenários): campeão REGREDIU (${delta}) — NÃO confirmado contra sobreajuste`;
    }
    if (o.pOrigin !== 'holdout' || typeof o.pValue !== 'number' || !Number.isFinite(o.pValue)) {
      return `holdout rodado (n=${n} cenários): ${delta} sem p válido do próprio holdout — campeão NÃO confirmado`;
    }
    if (!(o.pValue <= HOLDOUT_ALPHA)) {
      return (
        `holdout rodado (n=${n} cenários): ${delta}, ${fmtP(o.pValue)} unilateral > α=0,05 — ` +
        'campeão NÃO confirmado (ganho indistinguível de ruído fora do treino)'
      );
    }
    return `validado em holdout intocado (n=${n} cenários, ${delta}, ${fmtP(o.pValue)} unilateral ≤ α=0,05)`;
  }
  if (opts.skipped && strength === 'holdout') {
    return (
      `confirmação fraca: sem teste de holdout (${n} cenários reservados; ${motivo ?? 'pulado por orçamento/cancelamento'}) ` +
      '— sem confirmação contra sobreajuste'
    );
  }
  if (strength === 'confirmacao-fraca') {
    return `confirmação fraca: holdout com n=${n} < ${MIN_HOLDOUT_SCENARIOS} cenários — sem confirmação contra sobreajuste`;
  }
  return (
    `confirmação fraca: sem confirmação de holdout (${motivo ?? `abaixo do piso de ${MIN_HOLDOUT_SCENARIOS} cenários ou pulado`}) ` +
    `— campeão sem confirmação contra sobreajuste`
  );
}
