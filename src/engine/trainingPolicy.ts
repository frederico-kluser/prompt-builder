// Política do LAÇO de treino (IMPL-013 — R-02b:REC-2). Módulo puro: roda igual
// no Node e no navegador (o trainer do web o importa direto, como `halving`).
//
// O PROBLEMA. O laço encerrava a sessão na PRIMEIRA iteração sem promoção
// (paciência implícita 1) e confirmava a promoção com as MESMAS avaliações que
// escolheram a melhor de K — o winner's curse entra duas vezes: na escolha e na
// confirmação. Com veredito ternário ruidoso a simulação local da pesquisa mediu
// 51–86% de promoção falsa (60,8% com n = 8, K = 4, flip 0,15). Os defaults de
// referência (MIPROv2 / DeepEval-GEPA / CAPO) usam minibatch de aceitação,
// paciência 2–3 e proposta múltipla.
//
// A POLÍTICA (defaults fixados aqui, consumidos pelos dois trainers, pelo
// estimador e pelo harness `npm run stats:sim`):
// - paciência 2: a sessão só encerra depois de 2 iterações SEGUIDAS sem
//   promoção (uma iteração azarada não mata a busca);
// - re-avaliação LIMPA: o candidato que passou no gate da melhor de K (IMPL-002)
//   roda de novo contra a régua num minibatch de max(5, ceil(0,3·n)) cenários de
//   TREINO, com respostas e vereditos NOVOS (nada reaproveitado da seleção). Só
//   promove se melhorar ESTRITAMENTE no minibatch (regra de aceitação do GEPA);
// - K = 4–6 técnicas por iteração: acima de 6, as técnicas escolhidas RODAM entre
//   as iterações (subconjunto determinístico por sessão) — o max-T corrige a
//   multiplicidade, mas K grande custa poder e dinheiro;
// - 3–5 iterações (o default das telas/arena-config é 3; o schema aceita 2–10).
// A parada dura por orçamento (ledger) continua valendo, e a estimativa
// pré-iteração conta TODA avaliação extra (re-avaliação e carry) — ver
// `estimateInputFromConfig`.

import { mulberry32, pairCoverage, type PairScore } from '../stats.js';
import { HOLDOUT_RATIO_DEFAULT, holdoutSplitSize, holdoutStrength } from '../holdout.js';
import { FEWSHOT_MAX_DEMOS, fewShotDemosOf, labeledScenariosFrom, type LabeledScenario } from '../techniques.js';
import { stageHasHumanApproval } from './libraryCore.js';
import { GATE_ALPHA } from './bestOfK.js';
import type { ChampionDeclaration, PairCoverage, StageSpec } from '../types.js';

/** Iterações seguidas SEM promoção que encerram a sessão. */
export const TRAINING_PATIENCE = 2;
/** Faixa recomendada de iterações (o default das telas é o mínimo). */
export const TRAINING_ITERATIONS = { min: 3, max: 5, default: 3 } as const;
/** Técnicas (variantes reescritas) por iteração. */
export const TECHNIQUES_PER_ITERATION = { min: 4, max: 6 } as const;
/** Piso do minibatch de re-avaliação limpa. */
export const REEVAL_MIN_SCENARIOS = 5;

/**
 * Tamanho do minibatch de re-avaliação: max(5, ceil(0,3·n)), limitado a n (com
 * menos de 5 cenários de treino, re-avalia todos). Aritmética inteira
 * (`ceil(3n/10)`) para o `ceil` nunca depender de arredondamento de double.
 */
export function selectionMinibatchSize(n: number): number {
  const total = Math.max(0, Math.floor(n));
  if (total === 0) return 0;
  return Math.min(total, Math.max(REEVAL_MIN_SCENARIOS, Math.ceil((3 * total) / 10)));
}

/**
 * Paciência: `true` quando a sequência de iterações sem promoção atingiu o
 * limite e a sessão deve encerrar (convergiu).
 */
export function shouldStopForPatience(streakWithoutPromotion: number, patience = TRAINING_PATIENCE): boolean {
  return streakWithoutPromotion >= Math.max(1, Math.floor(patience));
}

/** Embaralhamento de Fisher-Yates semeado (determinístico, não muta a entrada). */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rng = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Técnicas da iteração `iteration`. Até {@link TECHNIQUES_PER_ITERATION}.max a
 * lista vai inteira (mesma referência). Acima, uma janela de `max` técnicas
 * desliza sobre uma ordem embaralhada UMA vez por sessão (`seed`): iterações
 * seguidas cobrem técnicas diferentes e, em ⌈len/max⌉ iterações, todas rodam.
 * Abaixo do mínimo (4) nada é inventado — a escolha do usuário é respeitada.
 */
export function techniquesForIteration(
  techniqueIds: readonly string[] | undefined,
  iteration: number,
  seed: number,
  max: number = TECHNIQUES_PER_ITERATION.max,
): string[] | undefined {
  if (!techniqueIds) return undefined;
  const cap = Math.max(1, Math.floor(max));
  if (techniqueIds.length <= cap) return techniqueIds as string[];
  const order = seededShuffle(techniqueIds, seed);
  const start = (Math.max(0, iteration) * cap) % order.length;
  return Array.from({ length: cap }, (_, k) => order[(start + k) % order.length]);
}

/**
 * Sorteia o minibatch de re-avaliação entre os cenários de TREINO (o holdout
 * nunca entra). Determinístico por `seed`; preserva a ordem original.
 */
export function pickReevalMinibatch<T>(stages: readonly T[], seed: number): T[] {
  const m = selectionMinibatchSize(stages.length);
  if (m >= stages.length) return [...stages];
  const chosen = new Set(seededShuffle(Array.from(stages.keys()), seed).slice(0, m));
  return stages.filter((_, i) => chosen.has(i));
}

/** Decisão da re-avaliação limpa sobre os pares do minibatch. */
export interface ReevalDecision {
  pairing: PairCoverage;
  /** Δ candidato − régua nos pares completos do minibatch (p.p.); 0 sem par. */
  gainPp: number;
  confirmed: boolean;
}

/**
 * Aceitação estilo GEPA: confirma só com melhora ESTRITA do candidato sobre a
 * régua nos pares completos do minibatch (ausente sai dos dois lados, IMPL-005).
 * Sem par completo não há evidência → não confirma.
 */
export function reevalDecision(
  controlScores: readonly PairScore[],
  candidateScores: readonly PairScore[],
): ReevalDecision {
  const pairing = pairCoverage(controlScores, candidateScores);
  const gainPp = pairing.meanDiffPp ?? 0;
  return { pairing, gainPp, confirmed: pairing.nEfetivo > 0 && gainPp > 1e-9 };
}

// ---------------------------------------------------------------------------
// PODER do gate de promoção (web-live#5) — o treino default precisa CONSEGUIR
// promover.
// ---------------------------------------------------------------------------
// O gate da melhor de K (IMPL-002, `engine/bestOfK.ts`) é um max-T por troca
// de sinais EXATA sobre os n cenários de SELEÇÃO. O menor p ajustado possível
// é o do desfecho identidade sozinho no topo: 2^-n — e só quando a melhor
// variante vence a régua em TODOS os n cenários. Cenário em que régua e as K
// variantes empatam não mexe na estatística e sai da conta (n efetivo cai).
// Com α = 0,05: n = 4 dá 1/16 = 0,0625 (NENHUMA promoção possível) e n = 5 dá
// 1/32 = 0,031 (promove só se a melhor vencer nos 5 — um empate ou uma derrota
// já seguram). Medido na sessão s17 (tela guiada, 5 cenários): a melhor
// variante venceu todos os cenários por +50 p.p. e ainda assim foi segurada
// (p ajustado 0,063 com um cenário empatado). O K (técnicas por iteração) não
// move este piso — a enumeração é exata —, só a chance de alcançá-lo.

/** Folga de empates/derrotas que o piso RECOMENDADO tolera (cenários além do mínimo do gate). */
export const TRAINING_TIE_ALLOWANCE = 3;
/** Default de cenários no treino (telas/CLI/arena-config quando omitido): 10 = folga ampla. */
export const TRAINING_DEFAULT_STAGES = 10;

/** Menor p ajustado que o gate consegue dar com `nPairs` cenários de seleção: 2^-n. */
export function minAchievableGateP(nPairs: number): number {
  return 2 ** -Math.max(0, Math.floor(nPairs));
}

/** Menor n de cenários de seleção com que o gate AINDA pode promover (2^-n ≤ α): 5 para α = 0,05. */
export function minPairsForPromotion(alpha: number = GATE_ALPHA): number {
  const a = Number.isFinite(alpha) && alpha > 0 && alpha < 1 ? alpha : GATE_ALPHA;
  return Math.ceil(Math.log2(1 / a) - 1e-12);
}

/** Piso RECOMENDADO de cenários de seleção: o mínimo do gate + {@link TRAINING_TIE_ALLOWANCE} (= 8). */
export const TRAINING_MIN_STAGES_RECOMMENDED = minPairsForPromotion() + TRAINING_TIE_ALLOWANCE;

/**
 * Cenários que a SELEÇÃO do treino vê com `stages` configurados: tira a fatia
 * de holdout quando ela se forma (≥ 20 cenários — `splitHoldout`); abaixo
 * disso tudo treina (a confirmação final fica "fraca").
 */
export function selectionScenariosFor(stages: number, holdoutRatio: number = HOLDOUT_RATIO_DEFAULT): number {
  const n = Math.max(0, Math.floor(Number.isFinite(stages) ? stages : 0));
  const reservados = holdoutSplitSize(n, holdoutRatio);
  return holdoutStrength(reservados) === 'holdout' ? n - reservados : n;
}

/**
 * Menor nº de cenários CONFIGURADOS (`stages`) com que o treino consegue
 * promover COM FOLGA: a seleção (depois do holdout) precisa de
 * {@link minPairsForPromotion} + `tieAllowance` cenários. `k` (técnicas por
 * iteração) é aceito pela assinatura comum às telas: a enumeração é exata e o
 * piso não depende dele. É a regra que o formulário (NewRun/guiado), o
 * pré-voo/estimativa do CLI e o log do trainer usam — uma cópia só.
 */
export function minScenariosForPromotion(
  k?: number,
  opts: { holdoutRatio?: number; alpha?: number; tieAllowance?: number } = {},
): number {
  void k;
  const alvo =
    minPairsForPromotion(opts.alpha) + Math.max(0, Math.floor(opts.tieAllowance ?? TRAINING_TIE_ALLOWANCE));
  for (let n = alvo; n <= 1000; n += 1) {
    if (selectionScenariosFor(n, opts.holdoutRatio) >= alvo) return n;
  }
  return alvo;
}

/**
 * Cenários que a sessão VAI ter: `customStages` fixam o tamanho; o seed
 * (`scenarioSeed`) nunca é cortado, então pode passar de `stages`.
 */
export function plannedTrainingStages(cfg: {
  stages?: number;
  customStages?: readonly unknown[];
  scenarioSeed?: readonly unknown[];
}): number {
  if (cfg.customStages?.length) return cfg.customStages.length;
  const alvo = Number.isFinite(cfg.stages) ? Math.floor(cfg.stages as number) : 0;
  return Math.max(0, alvo, cfg.scenarioSeed?.length ?? 0);
}

/** Diagnóstico de poder do treino para a config (o que o pré-voo/estimativa/tela mostram). */
export interface TrainingPowerCheck {
  /** `impossible` = nenhuma promoção possível; `fragile` = só sem nenhum empate/derrota (ou quase); `ok`. */
  level: 'ok' | 'fragile' | 'impossible';
  stages: number;
  /** Cenários que a seleção vê (depois do holdout). */
  selectionScenarios: number;
  /** 2^-n: o menor p ajustado alcançável. */
  minPAdjusted: number;
  alpha: number;
  /** Empates/derrotas que ainda cabem (n − mínimo do gate; negativo = impossível). */
  tieAllowance: number;
  /** `stages` recomendado (ver {@link minScenariosForPromotion}). */
  recommendedStages: number;
  /** Técnicas por iteração (K) consideradas — informativo. */
  techniques?: number;
  /** Aviso PT-BR (ausente quando `ok`). */
  message?: string;
}

function fmtP(p: number): string {
  return p.toFixed(p < 0.01 ? 4 : 3).replace('.', ',');
}

/**
 * Poder do gate de promoção para a config de treino. `impossible` quando
 * 2^-n > α (o treino NÃO consegue promover nenhuma variante); `fragile`
 * abaixo do piso recomendado (qualquer empate ou derrota além da folga segura
 * a promoção). `stages` é o configurado (customStages fixam o tamanho).
 */
export function trainingPromotionPower(input: {
  stages: number;
  holdoutRatio?: number;
  techniques?: number;
  alpha?: number;
}): TrainingPowerCheck {
  const alpha = input.alpha ?? GATE_ALPHA;
  const stages = Math.max(0, Math.floor(input.stages));
  const n = selectionScenariosFor(stages, input.holdoutRatio);
  const minP = minAchievableGateP(n);
  const folga = n - minPairsForPromotion(alpha);
  const recommendedStages = minScenariosForPromotion(input.techniques, { holdoutRatio: input.holdoutRatio, alpha });
  const base: TrainingPowerCheck = {
    level: 'ok',
    stages,
    selectionScenarios: n,
    minPAdjusted: minP,
    alpha,
    tieAllowance: folga,
    recommendedStages,
    ...(input.techniques !== undefined ? { techniques: input.techniques } : {}),
  };
  const alfa = String(alpha).replace('.', ',');
  if (minP > alpha) {
    return {
      ...base,
      level: 'impossible',
      message:
        `Com ${n} cenário(s) de seleção o treino NÃO consegue promover nenhuma variante: o menor p ajustado ` +
        `possível do gate é ${fmtP(minP)} (2^-${n}) > α=${alfa}. Use ao menos ${recommendedStages} cenários.`,
    };
  }
  if (n < minPairsForPromotion(alpha) + TRAINING_TIE_ALLOWANCE) {
    return {
      ...base,
      level: 'fragile',
      // Exato para EMPATES (cada empate total tira 1 do n efetivo); uma
      // DERROTA pesa mais que um empate — daí "já seguram", nunca "precisa de".
      message:
        `Com ${n} cenários de seleção o gate só promove se a melhor variante vencer a régua em ` +
        `${folga === 0 ? 'TODOS eles' : 'quase todos'} (p mínimo ${fmtP(minP)}; α=${alfa}): ` +
        `${folga === 0 ? 'um único empate' : `${folga + 1} empates`} já ${folga === 0 ? 'segura' : 'seguram'} a promoção ` +
        `(e uma derrota pesa mais que um empate). Use ao menos ${recommendedStages} cenários.`,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Âncora HUMANA (IMPL-065 — R-05:REC-4) — fonte ÚNICA dos dois trainers.
// ---------------------------------------------------------------------------
// Item CURADO = proveniência humana (o datagen marca os sintéticos com
// `origin: 'ai'`) E gabarito escrito por GENTE (ou `expected` — rótulo que o
// datagen nunca produz). ⚠️ A spec da run NÃO basta: o orchestrator preenche
// `reference` com o gabarito do modelo de referência (`gabarito.ts`) em toda
// etapa que chega sem ele — 20 perguntas escritas à mão viravam "20 itens
// curados (âncora humana)" com gabaritos de IA. O gabarito só é humano quando
// veio da CONFIG (customStages/scenarioSeed — o que o usuário trouxe) com o
// mesmo texto: {@link humanReferenceIndex}.
// IMPL-065 (onda 3): item da BIBLIOTECA nascido de IA e APROVADO por gente
// (`humanApproval`, carimbado por `toStageSpec` só com o `contentHash` vigente)
// também é proveniência humana — a revisão cobre pergunta + gabarito.

/**
 * Proveniência HUMANA da spec: não gerada por IA, OU gerada por IA e aprovada
 * por gente na biblioteca (aprovação vigente — {@link stageHasHumanApproval}).
 */
export function humanProvenance(spec: StageSpec): boolean {
  return spec.origin !== 'ai' || stageHasHumanApproval(spec);
}

/** IMPL-065: piso DEFAULT de itens curados (âncora humana). Proposta sem fonte — calibrar. */
export const DEFAULT_MIN_CURATED_ITEMS = 20;

/** Pergunta → gabarito HUMANO (texto aparado), das specs que o usuário trouxe. */
export type HumanReferenceIndex = ReadonlyMap<string, string>;

/** Chave da pergunta (espaços colapsados): a mesma na config, na run e nas demos. */
export function questionKey(question: string | undefined): string {
  return (question ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Índice dos gabaritos HUMANOS: só specs da CONFIG (customStages/scenarioSeed)
 * com proveniência não-IA e `reference` não vazia. É o que distingue o
 * gabarito do usuário do gabarito que a run gerou por IA para a mesma pergunta.
 */
export function humanReferenceIndex(
  ...sources: readonly (readonly (StageSpec | undefined)[] | undefined)[]
): Map<string, string> {
  const out = new Map<string, string>();
  for (const lista of sources) {
    for (const s of lista ?? []) {
      if (!s || !humanProvenance(s)) continue;
      const ref = s.reference?.trim();
      if (ref) out.set(questionKey(s.question), ref);
    }
  }
  return out;
}

/**
 * O gabarito da spec é HUMANO? Com índice: só se a config trouxe ESTE texto
 * para esta pergunta (gabarito gerado por IA na run nunca bate). Sem índice
 * (chamador legado/unitário), a proveniência da spec é a única pista.
 */
export function hasHumanReference(spec: StageSpec, index?: HumanReferenceIndex): boolean {
  const ref = spec.reference?.trim();
  if (!ref || !humanProvenance(spec)) return false;
  if (!index) return true;
  return index.get(questionKey(spec.question)) === ref;
}

function hasExpected(spec: StageSpec): boolean {
  const e = spec.expected as unknown;
  if (e === undefined || e === null) return false;
  if (typeof e === 'string') return e.trim().length > 0;
  if (Array.isArray(e)) return e.length > 0;
  return typeof e === 'object' && Object.keys(e as object).length > 0;
}

/**
 * IMPL-065 — item CURADO (âncora humana): proveniência humana E gabarito
 * humano (ver {@link hasHumanReference}) ou `expected`. Gabarito gerado por IA
 * junto do item NÃO serve de âncora: benchmarks bem-sucedidos mantêm
 * verificação humana mesmo com dados sintéticos (IFEval/IFBench).
 */
export function isCuratedItem(spec: StageSpec, humanReferences?: HumanReferenceIndex): boolean {
  if (!humanProvenance(spec)) return false;
  return hasExpected(spec) || hasHumanReference(spec, humanReferences);
}

/**
 * IMPL-065 — declaração de campeão sob âncora HUMANA. Com `curatedItems <
 * minCuratedItems` (default {@link DEFAULT_MIN_CURATED_ITEMS}) o treino NÃO
 * declara campeão: o zero-dataset é BOOTSTRAP, não evidência (84–89% em
 * sintético vs 25–34% em real). Itens sintéticos entram como treino/apoio; a
 * recusa cita o número de itens curados e o piso.
 */
export function championDeclarationFor(
  specs: readonly StageSpec[],
  opts: {
    minCuratedItems?: number;
    scoreCi95Pp?: [number, number] | null;
    /** Gabaritos humanos da config (sem ele, a spec da run é a única pista). */
    humanReferences?: HumanReferenceIndex;
  } = {},
): ChampionDeclaration {
  const raw = opts.minCuratedItems;
  const minCuratedItems =
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_MIN_CURATED_ITEMS;
  const curatedItems = specs.filter((s) => isCuratedItem(s, opts.humanReferences)).length;
  const scoreCi95Pp = opts.scoreCi95Pp ?? null;
  if (curatedItems >= minCuratedItems) {
    return {
      declared: true,
      curatedItems,
      minCuratedItems,
      message: `campeao declarado com ${curatedItems} itens curados (ancora humana; piso ${minCuratedItems})`,
      scoreCi95Pp,
    };
  }
  return {
    declared: false,
    curatedItems,
    minCuratedItems,
    reason: 'sem-ancora-humana',
    message:
      `campeao NAO declarado: ${curatedItems} itens curados (ancora humana) < piso ${minCuratedItems} — ` +
      'o dataset e sintetico demais para ancorar um campeao (84-89% em sintetico vs 25-34% em tarefas reais); ' +
      'a sessao vale como bootstrap/treino (itens sinteticos entram como apoio). ' +
      'Gabaritos exigem verificacao humana para servir de ancora (gabarito gerado por IA na run nao conta); ' +
      'o piso N e uma PROPOSTA sem fonte (calibrar).',
    scoreCi95Pp,
  };
}

// ---------------------------------------------------------------------------
// Few-shot com demos REAIS no treino (IMPL-061 — R-02a:REC-3)
// ---------------------------------------------------------------------------
// As demos saem do conjunto ROTULADO de TREINO: itens com âncora humana (a
// mesma régua do IMPL-065 — gabarito gerado por IA não é "verificado"), nunca
// do holdout (é o teste cego) nem de cenário adversarial/de guarda (Goodhart).
// ⚠️ Contaminação dados→prompt: um prompt que CARREGA a pergunta e o gabarito
// de um cenário acerta aquele cenário de graça. Por isso toda pergunta que
// aparece como demo em QUALQUER prompt da run sai da visão de SELEÇÃO (gate,
// re-avaliação, lições, pool) — "leave-demos-out", para todos os contestants
// (pareamento justo) — e as demos só são oferecidas quando a seleção, sem
// elas, ainda tem o piso recomendado de cenários do gate (web-live#5).

/** A seleção comporta demos sem perder o poder do gate? (seleção − demos ≥ piso recomendado). */
export function fewShotDemosFit(selectionScenarios: number): boolean {
  return selectionScenarios - FEWSHOT_MAX_DEMOS >= TRAINING_MIN_STAGES_RECOMMENDED;
}

/**
 * Conjunto rotulado (matéria-prima das demos) a partir das specs de TREINO de
 * uma iteração: só âncora humana; adversarial/guarda e sintético ficam fora
 * (ver `labeledScenariosFrom`). Vazio quando a seleção não comporta as demos
 * ({@link fewShotDemosFit}) — a técnica decai para formato sem demos.
 */
export function trainingLabeledPool(
  trainSpecs: readonly (StageSpec | undefined)[],
  humanReferences: HumanReferenceIndex,
): LabeledScenario[] {
  if (!fewShotDemosFit(trainSpecs.filter(Boolean).length)) return [];
  return labeledScenariosFrom(trainSpecs, { aiReference: (s) => !hasHumanReference(s, humanReferences) });
}

/**
 * Perguntas usadas como DEMO (bloco `<exemplos_reais>`) em algum dos prompts —
 * as que saem da visão de seleção (leave-demos-out). Chave: {@link questionKey}.
 */
export function demoQuestionsOf(prompts: readonly (string | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const p of prompts) {
    if (!p) continue;
    for (const d of fewShotDemosOf(p)) out.add(questionKey(d.question));
  }
  return out;
}
