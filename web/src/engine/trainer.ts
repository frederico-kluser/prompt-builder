const randomUUID = (): string => crypto.randomUUID();
import { runToCompletion } from './orchestrator';
import { listModels } from './openrouter';
import { enforceRunCompliance } from '../lgpd';
import { generateContestants, lessonsEnabled, llmReflectLessons } from './variator';
import { composePrompt } from '../../../src/engine/promptGroup.js';
import {
  addToPool,
  coverageWins,
  paretoDiagnostics,
  pickParent,
  pickParentByCoverage,
  sliceScores,
  PARETO_MIN_N,
  type ParetoEntry,
} from '../../../src/engine/pareto.js';
import {
  judgeIdentity,
  judgeIdentityChanged,
  mergeJudgeIdentity,
  type JudgeIdentity,
} from '../../../src/engine/modelLifecycle.js';
import { seedFromId } from '../../../src/engine/duelCore.js';
import {
  pickReevalMinibatch,
  reevalDecision,
  shouldStopForPatience,
  techniquesForIteration,
  TRAINING_PATIENCE,
} from '../../../src/engine/trainingPolicy.js';
import { emitSessionEvent } from './events';
import { saveSession } from './storage';
import { acquireLock } from './runLocks';
import { computeMedals } from './medals';
import { judgeScoreFromVerdicts, pickWinner, promotionEventFields, type RankEntry } from './rank';
import {
  holdoutConfirmationText,
  HOLDOUT_RATIO_DEFAULT,
  holdoutSkipLeavesUnvalidated,
  MIN_HOLDOUT_SCENARIOS,
  splitHoldout,
  trainOnlyView,
} from './holdout';
import { meanCiSummary, pairCoverage, pairDiffs, pairedStageScores, stageScoresByContestant, type PairScore } from './stats';
import { formatIterationGate, pairedSignificance, VERDICT_SCORE } from './stats';
import { BudgetLedger, isControlSignal, RunCancelled } from './budget';
import { estimateInputFromConfig, estimateRunCost, makeCallEstimator } from './estimate';
import { reasoningLevelForRole } from '../modelCaps';
import { mergeFailureCounts } from '../../../src/engine/verdictIntegrity.js';
import type {
  ChampionDeclaration,
  Contestant,
  HoldoutSkipReason,
  IterationGate,
  PromotionReeval,
  RunCtx,
  RunRecord,
  SessionRecord,
  StageRecord,
  StageSpec,
  TrainingConfig,
  VariationConfig,
  Verdict,
} from './types';

function nowIso(): string {
  return new Date().toISOString();
}

function log(sessionId: string, msg: string): void {
  console.log(`[train ${sessionId}] ${msg}`);
}

/** Campeao corrente do treino (prompt + rotulo + o id que tinha na run em que venceu). */
interface Champion {
  contestantId: string;
  systemPrompt: string;
  label: string;
}

/**
 * Judge-score 0-100 do contestant na run. Usa o agregado do orchestrator
 * (preenchido quando houve juiz de referencia); em runs legadas, sem
 * `judgeScoreByContestant`, cai nos vereditos listwise dos estagios
 * (`stage.judge.verdictByContestant`).
 */
function judgeScoreOf(run: RunRecord, contestantId: string): number {
  const agg = run.judgeScoreByContestant?.[contestantId];
  if (agg !== undefined) return agg;
  return judgeScoreFromVerdicts(
    run.stages.map(
      (s) =>
        s.referenceJudge?.verdictByContestant?.[contestantId] ??
        s.judge?.verdictByContestant?.[contestantId],
    ),
  );
}

/** Placement medio do contestant nos estagios COM duelo (undefined se nenhum duelo). */
function meanPlacementOf(run: RunRecord, contestantId: string): number | undefined {
  const placements = run.stages
    .map((s) => s.duels?.placementByContestant?.[contestantId])
    .filter((p): p is number => p !== undefined);
  if (!placements.length) return undefined;
  return placements.reduce((sum, p) => sum + p, 0) / placements.length;
}

/**
 * Monta as entradas do ranking de selecao (port do evolve.mjs do prompt-arena).
 * `controlId` e a REGUA desta iteracao ('original' na 0, 'carry' nas demais):
 * ela nao disputa o titulo, entao seu promptLen e zerado — o desempate por
 * tamanho so vale entre candidatas.
 * IMPL-071 (R-20:REC-6): e, dentre as candidatas, so vale entre as com o
 * contrato never-break v2 VERDE (variante gerada pelo reescritor que passou
 * pelo gate de 3 camadas com `contracts` ativo). Sem isso o desempate
 * "o mais curto vence" premiava quem APAGA texto — inclusive cláusulas
 * defensivas que o gate substring nao protege.
 * Exportado para os testes de contrato (test/trainer-size-floor.test.ts).
 */
export function buildRankEntries(
  run: RunRecord,
  controlId: string,
  opts: { contractsActive?: boolean } = {},
): RankEntry[] {
  return run.contestants.map((c) => {
    const isControl = c.id === controlId;
    let errored = 0;
    for (const s of run.stages) {
      for (const r of s.responses) {
        if (r.contestantId === c.id && r.status === 'error') errored++;
      }
    }
    const contratoVerde = !isControl && Boolean(opts.contractsActive) && Boolean(c.techniqueId);
    return {
      id: c.id,
      label: c.label,
      isControl,
      judgeScore: judgeScoreOf(run, c.id),
      meanPlacement: meanPlacementOf(run, c.id),
      errored,
      promptLen: contratoVerde ? (c.systemPrompt ?? '').length : 0,
    };
  });
}

/** IMPL-065 (R-05:REC-4): piso DEFAULT de itens curados (ancora humana). Proposta sem fonte — calibrar. */
export const DEFAULT_MIN_CURATED_ITEMS = 20;

/**
 * IMPL-065 (R-05:REC-4) — item CURADO (ancora humana): proveniencia humana
 * (`origin` !== 'ai' — o datagen marca os sintéticos como 'ai') E gabarito
 * acompanhando o item (`reference`/`expected`). Gabarito gerado por IA junto do
 * item sintético NAO serve de ancora: benchmarks bem-sucedidos mantêm
 * verificação humana mesmo com dados sintéticos (IFEval/IFBench). Espelho de
 * src/trainer.ts.
 */
export function isCuratedItem(spec: StageSpec): boolean {
  return spec.origin !== 'ai' && Boolean(spec.reference ?? spec.expected);
}

/**
 * IMPL-065 (R-05:REC-4) — declaração de campeão sob ancora HUMANA. Com
 * `curatedItems < minCuratedItems` (default {@link DEFAULT_MIN_CURATED_ITEMS})
 * o treino NAO declara campeão: o zero-dataset e BOOTSTRAP, nao evidência
 * (84–89% em sintético vs 25–34% em real). Itens sintéticos entram como
 * treino/apoio; a recusa cita o numero de itens curados e o piso.
 */
export function championDeclarationFor(
  specs: readonly StageSpec[],
  opts: { minCuratedItems?: number; scoreCi95Pp?: [number, number] | null } = {},
): ChampionDeclaration {
  const raw = opts.minCuratedItems;
  const minCuratedItems =
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_MIN_CURATED_ITEMS;
  const curatedItems = specs.filter(isCuratedItem).length;
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
      'Gabaritos exigem verificacao humana para servir de ancora; o piso N e uma PROPOSTA sem fonte (calibrar).',
    scoreCi95Pp,
  };
}

/** Fatias (tier/dimensionTags) dos cenarios — 'geral' quando o cenario nao traz curriculo. */
function sliceKeysOf(specs: readonly (StageSpec | undefined)[]): string[] {
  const fatias = new Set<string>();
  for (const s of specs) {
    if (!s) continue;
    if (s.dimensionTags?.length) for (const t of s.dimensionTags) fatias.add(t);
    else fatias.add(s.tier ?? 'geral');
  }
  return [...fatias];
}

/**
 * IMPL-062 — matriz candidato × cenário: score (VERDICT_SCORE) do contestant em
 * cada etapa da SUA run. Ausente = sem observação (nunca pontua).
 */
function scenarioScoresOf(run: RunRecord | undefined, contestantId: string): (number | null | undefined)[] {
  return (run?.stages ?? []).map((s) => {
    const v =
      s.referenceJudge?.verdictByContestant?.[contestantId] ??
      s.judge?.verdictByContestant?.[contestantId];
    return v === undefined ? undefined : VERDICT_SCORE[v];
  });
}

/**
 * Paciência do laço (IMPL-051, espelho de src/trainer.ts): `config.patience`
 * (1–5, schema) ou o default {@link TRAINING_PATIENCE} = 2.
 */
function resolvePatience(cfg: TrainingConfig): number {
  const raw = cfg.patience;
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : TRAINING_PATIENCE;
  return Math.max(1, n);
}

/**
 * IC95% do ganho pareado (candidato − régua) em p.p. — o que a parada por
 * platão lê (IMPL-051): se o limite SUPERIOR do IC fica abaixo de minGain,
 * nenhum ganho plausível alcança a margem. `undefined` sem par completo.
 */
function pairedGainCi(
  scoresById: Readonly<Record<string, readonly (number | null | undefined)[]>>,
  controlId: string,
  bestId: string | undefined,
): [number, number] | undefined {
  if (!bestId) return undefined;
  const control = scoresById[controlId];
  const best = scoresById[bestId];
  if (!control || !best) return undefined;
  const { diffs } = pairDiffs(control, best);
  if (diffs.length === 0) return undefined;
  return meanCiSummary(diffs).ci95Pp;
}

/**
 * IMPL-065 (R-05:REC-4): IC95 do SCORE do campeão (p.p.) sobre os pares
 * COMPLETOS (pareado — mesmos pares do ganho; ausente nunca vira nota). É o
 * intervalo que o resultado reporta ao lado do score. `null` sem par completo.
 */
function scoreCiOf(controlScores: readonly PairScore[], championScores: readonly PairScore[]): [number, number] | null {
  const valores: number[] = [];
  for (let i = 0; i < championScores.length; i++) {
    const c = controlScores[i];
    const v = championScores[i];
    if (typeof c === 'number' && typeof v === 'number') valores.push(v);
  }
  if (!valores.length) return null;
  return meanCiSummary(valores).ci95Pp ?? null;
}

const LESSONS_PREFIX =
  'Fraquezas observadas ao benchmarkar o prompt base ATUAL. Enderece-as SEM quebrar o contrato de saida:\n';
const LESSONS_SUCCESSES_HEADER =
  '\nAcertos representativos (preserve este comportamento — nao o reescreva para pior):\n';

/** IMPL-060: teto DEFAULT do dossiê de lições em TOKENS (configurável, ≤ 4000). */
export const DEFAULT_LESSON_TOKENS = 4000;
/** Conversão aproximada tokens → chars usada no teto do dossiê. */
const CHARS_PER_TOKEN = 4;
/** Piso de um campo do dossiê antes de qualquer truncagem (chars). */
const MIN_LESSON_FIELD_CHARS = 80;
/** Acertos representativos no dossiê (2–3, GEPA). */
const MAX_LESSON_SUCCESSES = 3;

/** Entrada do dossiê de lições (payload versionado — R-02a:REC-2). */
export interface LessonEntry {
  /** Pergunta COMPLETA do cenário (IMPL-060: sem recorte de 60 chars). */
  pergunta: string;
  /** Resposta do candidato sob avaliação — a trajetória completa (GEPA/ProTeGi). */
  resposta: string;
  /** Gabarito do cenário — só com `includeReference` (default OFF, R-03b). */
  gabarito?: string;
  veredito: Verdict;
  /** Explicação INTEGRAL do juiz (IMPL-060: sem recorte de 200 chars). */
  explicacao: string;
}

/** Relato de truncagem do dossiê (teto `maxLessonTokens`). */
export interface LessonTruncation {
  limitTokens: number;
  /** Campos encurtados — nenhuma falha é descartada (cobertura é 100%). */
  truncatedFields: number;
  /** Quais entradas encurtaram ("falha 2", "acerto 1", …). */
  entries: string[];
}

/**
 * IMPL-060 (R-02b:REC-1) — dossiê POR VARIANTE da reflexão GEPA (espelho de
 * src/trainer.ts): pergunta completa, resposta do candidato, explicação
 * integral do juiz, veredito e acertos representativos. O dono é SEMPRE o
 * contestant da SUA run (nunca as falhas do campeão injetadas em todas as
 * variantes). Campos versionados:
 * `pergunta`/`resposta`/`gabarito`/`veredito`/`explicacao`.
 */
export interface LessonDossier {
  version: 2;
  kind: 'licoes-gepa';
  /** Dono do dossiê — cada variante lê as falhas da SUA run. */
  contestantId: string;
  runId: string;
  /** 100% das falhas com resposta + explicação integral. */
  falhas: LessonEntry[];
  /** Acertos representativos (até 3) — mostram o que a reescrita deve preservar. */
  acertos: LessonEntry[];
  /** Presente só se algo encurtou para caber no teto (reportado em log). */
  truncation?: LessonTruncation;
}

export interface LessonDossierOpts {
  /** Teto em TOKENS (default {@link DEFAULT_LESSON_TOKENS}). */
  maxLessonTokens?: number;
  /** Inclui o gabarito do cenário. Default OFF (risco de exploração do juiz — R-03b). */
  includeReference?: boolean;
}

function resolveLessonTokens(raw: number | undefined): number {
  const t = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_LESSON_TOKENS;
  return t;
}

/** Resposta do candidato na etapa (trajetória completa — sem recorte). */
function lessonResponseOf(s: StageRecord, contestantId: string): string {
  return (s.responses ?? []).find((r) => r.contestantId === contestantId)?.text ?? '';
}

/** Explicação integral do juiz (referência primeiro; listwise cai no `motivo`). */
function lessonExplanationOf(s: StageRecord, contestantId: string): string {
  return (
    s.referenceJudge?.explanationByContestant?.[contestantId] ??
    (s.judge?.judges ?? [])
      .map((j) => j.verdicts.find((v) => v.contestantId === contestantId)?.motivo)
      .find((m) => m && m.trim()) ??
    ''
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function lessonEntryOf(
  s: StageRecord,
  contestantId: string,
  veredito: Verdict,
  includeReference: boolean,
): LessonEntry {
  const ref = s.spec?.reference;
  return {
    pergunta: (s.spec?.question ?? '?').replace(/\s+/g, ' ').trim(),
    resposta: lessonResponseOf(s, contestantId),
    ...(includeReference && ref ? { gabarito: ref } : {}),
    veredito,
    explicacao: lessonExplanationOf(s, contestantId),
  };
}

function lessonRenderEntry(e: LessonEntry): string {
  const linhas = [`- [${e.pergunta}] veredito=${e.veredito}`, `  resposta: ${e.resposta}`];
  if (e.gabarito) linhas.push(`  gabarito: ${e.gabarito}`);
  linhas.push(`  explicacao: ${e.explicacao}`);
  return linhas.join('\n');
}

function lessonRenderLength(falhas: LessonEntry[], acertos: LessonEntry[]): number {
  let n = LESSONS_PREFIX.length + falhas.map(lessonRenderEntry).join('\n').length;
  if (acertos.length) n += LESSONS_SUCCESSES_HEADER.length + acertos.map(lessonRenderEntry).join('\n').length;
  return n;
}

/**
 * Truncagem EXPLÍCITA (IMPL-060): encurta os campos mais longos até o payload
 * caber em `maxLessonTokens` — nenhuma falha é descartada (a cobertura do
 * dossiê é 100% das falhas), só os campos encolhem, nunca abaixo do piso.
 */
function truncateToFit(
  falhas: LessonEntry[],
  acertos: LessonEntry[],
  limitChars: number,
): LessonTruncation | undefined {
  let over = lessonRenderLength(falhas, acertos) - limitChars;
  if (over <= 0) return undefined;
  const alvos: { rotulo: string; entry: LessonEntry; campo: 'pergunta' | 'resposta' | 'explicacao' | 'gabarito' }[] =
    [];
  falhas.forEach((entry, i) => {
    for (const campo of ['pergunta', 'resposta', 'explicacao', 'gabarito'] as const) {
      const v = entry[campo];
      if (typeof v === 'string' && v.length > MIN_LESSON_FIELD_CHARS) {
        alvos.push({ rotulo: `falha ${i + 1}`, entry, campo });
      }
    }
  });
  acertos.forEach((entry, i) => {
    for (const campo of ['pergunta', 'resposta', 'explicacao', 'gabarito'] as const) {
      const v = entry[campo];
      if (typeof v === 'string' && v.length > MIN_LESSON_FIELD_CHARS) {
        alvos.push({ rotulo: `acerto ${i + 1}`, entry, campo });
      }
    }
  });
  let truncatedFields = 0;
  const tocadas = new Set<string>();
  const camposTocados = new Set<string>();
  while (over > 0 && alvos.length) {
    let maior = alvos[0];
    for (const a of alvos) {
      if ((a.entry[a.campo] ?? '').length > (maior.entry[maior.campo] ?? '').length) maior = a;
    }
    const atual = (maior.entry[maior.campo] ?? '') as string;
    const corte = Math.min(over + 1, atual.length - MIN_LESSON_FIELD_CHARS);
    // corte <= 1 = o campo só tem 1 char de folga acima do piso: recortá-lo não
    // encolhe nada (o "…" repõe o char cortado) e prenderia o laço para sempre —
    // sai dos alvos e o próximo campo mais longo assume.
    if (corte <= 1) {
      alvos.splice(alvos.indexOf(maior), 1);
      continue;
    }
    maior.entry[maior.campo] = `${atual.slice(0, atual.length - corte).trimEnd()}…`;
    over -= corte - 1;
    if (!camposTocados.has(`${maior.rotulo}:${maior.campo}`)) {
      camposTocados.add(`${maior.rotulo}:${maior.campo}`);
      truncatedFields += 1;
    }
    tocadas.add(maior.rotulo);
    if ((maior.entry[maior.campo] ?? '').length <= MIN_LESSON_FIELD_CHARS + 1) {
      alvos.splice(alvos.indexOf(maior), 1);
    }
  }
  if (!truncatedFields) return undefined;
  return { limitTokens: Math.ceil(limitChars / CHARS_PER_TOKEN), truncatedFields, entries: [...tocadas] };
}

/**
 * Monta o dossiê de lições (GEPA) do contestant `contestantId` na SUA run.
 * Determinístico: zero custo LLM. Ver {@link LessonDossier}.
 */
export function buildLessonDossier(
  run: RunRecord,
  contestantId: string,
  opts: LessonDossierOpts = {},
): LessonDossier {
  // Gabarito atrás de flag com default OFF (IMPL-060): risco de exploração do
  // juiz pelo reescritor — aguarda R-03b.
  const includeReference = opts.includeReference === true;
  const falhas: LessonEntry[] = [];
  const acertos: LessonEntry[] = [];
  for (const s of run.stages ?? []) {
    const veredito =
      s.referenceJudge?.verdictByContestant?.[contestantId] ??
      s.judge?.verdictByContestant?.[contestantId];
    // Veredito AUSENTE (juiz que falhou, competidor com erro de infra/bloqueado
    // — IMPL-004) NUNCA vira lição: o motivo dele descreve o PIPELINE, nao uma
    // fraqueza do candidato, e a lição falsa empurraria o reescritor para
    // "consertar" o que nao estava quebrado (R-03b:REC-4).
    if (veredito === undefined) continue;
    const entrada = lessonEntryOf(s, contestantId, veredito, includeReference);
    if (veredito === 'resolve') {
      if (acertos.length < MAX_LESSON_SUCCESSES) acertos.push(entrada);
    } else {
      falhas.push(entrada);
    }
  }
  const base: LessonDossier = {
    version: 2,
    kind: 'licoes-gepa',
    contestantId,
    runId: run.id ?? '',
    falhas,
    acertos,
  };
  if (!falhas.length) return base;
  const limitChars = resolveLessonTokens(opts.maxLessonTokens) * CHARS_PER_TOKEN;
  const truncation = truncateToFit(falhas, acertos, limitChars);
  return truncation ? { ...base, truncation } : base;
}

/** Renderiza o dossiê no texto que o reescritor recebe. Sem falhas = '' (como antes). */
export function renderLessonDossier(d: LessonDossier): string {
  if (!d.falhas.length) return '';
  let out = LESSONS_PREFIX + d.falhas.map(lessonRenderEntry).join('\n');
  if (d.acertos.length) out += LESSONS_SUCCESSES_HEADER + d.acertos.map(lessonRenderEntry).join('\n');
  return out;
}

/**
 * Aviso de truncagem para o LOG (IMPL-060, critério 3): a truncagem nunca é
 * silenciosa — o chamador regista este texto. `undefined` = cabe tudo.
 */
export function lessonTruncationNotice(d: LessonDossier): string | undefined {
  if (!d.truncation) return undefined;
  const t = d.truncation;
  return (
    `dossie de licoes truncado para ${t.limitTokens} tokens: ${t.truncatedFields} campos encurtados ` +
    `(${t.entries.join(', ')}) — nenhuma falha foi descartada`
  );
}

/**
 * Reflection estilo GEPA (port do evolve.mjs): SUBSTITUI a antiga analise por
 * LLM (`analyzeIteration`, removida — a analise deixou de ser uma etapa do
 * pipeline, e o evento `iteration.analyzing` nao e mais emitido; o tipo
 * permanece em types.ts apenas para sessoes antigas). IMPL-060: o material é o
 * DOSSIÊ POR VARIANTE (pergunta/resposta/gabarito/explicacao integrais, com
 * acertos representativos) da run do PRÓPRIO candidato — não mais um resumo
 * truncado em 60+200 chars das falhas do campeão. O variator injeta o resultado
 * em `<licoes_da_iteracao_anterior>`.
 */
export function buildLessons(
  run: RunRecord,
  contestantId: string,
  opts: LessonDossierOpts = {},
): string {
  return renderLessonDossier(buildLessonDossier(run, contestantId, opts));
}


/**
 * F4.1 — judge-score (escala 0–1) por FATIA (tier/dimensionTags do cenário) de
 * um contestant. É o vetor que a dominância de Pareto compara: prompts
 * diferentes são especialistas em fatias diferentes, e o campeão único não vê
 * isso.
 */
function sliceScoresOf(run: RunRecord, contestantId: string): Record<string, number> {
  const obs: { slice: string; score: number }[] = [];
  for (const st of run.stages) {
    const v =
      st.referenceJudge?.verdictByContestant?.[contestantId] ??
      st.judge?.verdictByContestant?.[contestantId];
    if (!v) continue;
    const fatias = st.spec?.dimensionTags?.length
      ? st.spec.dimensionTags
      : [st.spec?.tier ?? 'geral'];
    for (const f of fatias) obs.push({ slice: f, score: VERDICT_SCORE[v] });
  }
  return sliceScores(obs);
}

interface PoolMember extends ParetoEntry {
  text: string;
  /** IMPL-060/IMPL-062: run em que este membro foi avaliado — o dossiê de lições vem DELA. */
  runId: string;
  /** Id que o membro tinha na run dele (cada variante lê as falhas da SUA run). */
  contestantId: string;
}

export interface StartTrainingResult {
  sessionId: string;
  record: SessionRecord;
}

export interface StartTrainingOpts {
  /** Sinal EXTERNO (espelho de src/trainer.ts). A sessão tem sempre a própria raiz. */
  signal?: AbortSignal;
}

/**
 * Registra POR QUE a sessão fica sem holdout (web-code#8/cli#9, espelho de
 * src/trainer.ts): o 1º motivo vence e `holdoutSkipped` liga só para os
 * motivos que deixam o campeão NÃO validado.
 */
function markHoldoutSkip(record: SessionRecord, reason: HoldoutSkipReason): void {
  record.holdoutSkipReason ??= reason;
  if (holdoutSkipLeavesUnvalidated(record.holdoutSkipReason)) record.holdoutSkipped = true;
}

// Cancelamento da SESSÃO (IMPL-020): um AbortController raiz por sessão; as
// runs de cada iteração (e o holdout) herdam o sinal — abortar a raiz aborta a
// run em voo e impede a próxima iteração de começar.
const sessionControllers = new Map<string, AbortController>();

/** Cancela um treino em andamento NESTA aba. false = não está rodando aqui. */
export function cancelTraining(sessionId: string, reason = 'cancelado pelo usuario'): boolean {
  const ctrl = sessionControllers.get(sessionId);
  if (!ctrl || ctrl.signal.aborted) return false;
  ctrl.abort(new RunCancelled(reason));
  return true;
}

/** true = o treino está rodando nesta aba e ainda pode ser cancelado. */
export function isTrainingCancellable(sessionId: string): boolean {
  const ctrl = sessionControllers.get(sessionId);
  return Boolean(ctrl && !ctrl.signal.aborted);
}

export async function startTraining(
  config: TrainingConfig,
  apiKey: string,
  opts: StartTrainingOpts = {},
): Promise<StartTrainingResult> {
  const sessionId = randomUUID();
  const record: SessionRecord = {
    id: sessionId,
    status: 'running',
    config,
    runIds: [],
    bestPromptByIteration: [],
    totalCostUsd: 0,
    startedAt: nowIso(),
  };
  const root = new AbortController();
  const onParentAbort = (): void => root.abort(opts.signal?.reason);
  if (opts.signal?.aborted) root.abort(opts.signal.reason);
  else opts.signal?.addEventListener('abort', onParentAbort, { once: true });
  sessionControllers.set(sessionId, root);
  // IMPL-023 (R-10:REC-1): lock EXCLUSIVO da sessão (Web Locks) antes da 1ª
  // gravação, solto só depois da última (no `finally` do laço). Aba fechada ou
  // recarregada => o navegador solta o lock e a próxima carga marca a sessão
  // órfã (aborted + stoppedReason 'orphan'). As runs das iterações seguram o
  // lock PRÓPRIO (orchestrator.executeRun).
  const lock = await acquireLock('session', sessionId);
  if (!lock) {
    sessionControllers.delete(sessionId);
    opts.signal?.removeEventListener('abort', onParentAbort);
    throw new Error('Esta sessão de treino já está em execução em outra aba deste navegador.');
  }
  const liberar = (): void => {
    sessionControllers.delete(sessionId);
    opts.signal?.removeEventListener('abort', onParentAbort);
    lock.release();
  };
  // Persiste ANTES de responder ao cliente, para a TrainingView nunca pegar 404.
  await saveSession(record);
  void trainingLoop(record, apiKey, root.signal)
    .catch(async (err) => {
      record.status = 'error';
      record.error = err instanceof Error ? err.message : String(err);
      record.finishedAt = nowIso();
      // saveSession nunca rejeita: falha de gravacao vira evento storage.* (IMPL-022).
      await saveSession(record);
      emitSessionEvent({ type: 'session.error', sessionId, error: record.error });
    })
    .finally(liberar);
  return { sessionId, record };
}

/**
 * Config da run de cada iteração. ⚠️ Whitelist campo a campo: o que faltar
 * aqui some em silêncio. `budgetUsd` fica de fora DE PROPÓSITO (espelho de
 * src/trainer.ts): copiá-lo daria a cada uma das N iterações o teto inteiro da
 * sessão; quem controla o dinheiro é o ledger da sessão, via `parentLedger`.
 */
export function variationConfigFrom(cfg: TrainingConfig): VariationConfig {
  return {
    mode: 'variation',
    theme: cfg.theme,
    stages: cfg.stages,
    datagenModelId: cfg.datagenModelId,
    judgeModelIds: cfg.judgeModelIds,
    concurrency: cfg.concurrency,
    timeoutMs: cfg.timeoutMs,
    maxOutputTokens: cfg.maxOutputTokens,
    promptOptimization: cfg.promptOptimization,
    optimizerModelId: cfg.optimizerModelId,
    judgePasses: cfg.judgePasses,
    customStages: cfg.customStages,
    // Campos declarativos repassados verbatim p/ a run nao perder o intent do
    // usuario (datagen guiado, julgamento por referencia, reasoning por papel).
    compliance: cfg.compliance,
    // IMPL-042: o modo de dado pessoal vale para toda iteracao e o holdout.
    piiMode: cfg.piiMode,
    // ...e a revisao do usuario (`allowPii`) vale para a sessao inteira.
    allowPii: cfg.allowPii,
    reasoning: cfg.reasoning,
    referenceModelId: cfg.referenceModelId,
    referenceJudging: cfg.referenceJudging,
    // IMPL-053/IMPL-055: sondas de verbosidade e validação dos gabaritos são
    // escolhas da SESSÃO — valem em toda iteração e no holdout.
    verbosityProbes: cfg.verbosityProbes,
    validateReferences: cfg.validateReferences,
    secondReferenceModelId: cfg.secondReferenceModelId,
    scenarioBrief: cfg.scenarioBrief,
    scenarioSeed: cfg.scenarioSeed,
    // Fase de finais: sem repassar, TODA iteracao (e o holdout) cairia no
    // default de 3 finalistas — a escolha do usuario era descartada em silencio.
    duels: cfg.duels,
    finalists: cfg.finalists,
    contestantModelId: cfg.contestantModelId,
    basePrompt: cfg.basePrompt,
    techniqueIds: cfg.techniqueIds,
    manualVariants: cfg.manualVariants,
    // Sem repassar, a temperatura do modelo sob teste sumiria em toda iteracao.
    temperature: cfg.temperature,
    // Contratos never-break (F2/P0.3): valem para toda reescrita da sessao.
    contracts: cfg.contracts,
    // Multi-prompt (F2/P0.4): grupo + fragmento-alvo atravessam as iteracoes.
    promptGroup: cfg.promptGroup,
    promptId: cfg.promptId,
  };
}

/**
 * IMPL-013 — re-avaliação LIMPA do candidato antes de confirmar a promoção
 * (aceitação estilo GEPA). O gate da melhor de K escolheu E testou o candidato
 * nas MESMAS avaliações (winner's curse); aqui candidato e régua rodam de novo —
 * respostas e vereditos NOVOS, nada reaproveitado — num minibatch de
 * max(5, ceil(0,3·n)) cenários de TREINO (o holdout nunca entra), sem finais.
 * Confirma só com melhora ESTRITA. O custo entra no ledger da sessão
 * (`parentLedger`) e na estimativa pré-iteração (`estimateInputFromConfig`).
 * A run é paga e persistida: o id entra em `record.reevalRunIds` ANTES de ela
 * começar (web-code#18) — fora de `runIds`, que é "uma run por iteração".
 */
async function reevaluateCandidate(args: {
  cfg: TrainingConfig;
  apiKey: string;
  record: SessionRecord;
  iteration: number;
  selectionRun: RunRecord;
  controlId: string;
  candidateId: string;
  trainStages: StageSpec[];
  ledger: BudgetLedger;
  signal?: AbortSignal;
}): Promise<{ reeval: PromotionReeval; run?: RunRecord }> {
  const { cfg, selectionRun, controlId, candidateId, trainStages, record } = args;
  const sessionId = record.id;
  const minibatch = pickReevalMinibatch(trainStages, seedFromId(`reeval:${sessionId}:${args.iteration}`));
  const base = { candidateId, controlId, size: minibatch.length, poolSize: trainStages.length };
  const control = selectionRun.contestants.find((c) => c.id === controlId);
  const candidate = selectionRun.contestants.find((c) => c.id === candidateId);
  // Sem régua/candidato/cenário não há evidência limpa: não confirma.
  if (!control || !candidate || minibatch.length === 0) {
    return { reeval: { ...base, gainPp: 0, confirmed: false } };
  }
  const runId = randomUUID();
  (record.reevalRunIds ??= []).push(runId);
  await saveSession(record);
  const run = await runToCompletion(
    {
      ...variationConfigFrom(cfg),
      stages: minibatch.length,
      customStages: undefined,
      scenarioSeed: undefined,
      // Só o veredito por referência decide; finais seriam custo sem uso aqui.
      duels: false,
    },
    args.apiKey,
    {
      runId,
      contestants: [{ ...control }, { ...candidate }],
      pinnedStages: minibatch,
      sessionId,
      iteration: args.iteration,
      parentRunId: selectionRun.id,
      parentLedger: args.ledger,
      signal: args.signal,
    },
  );
  if (run.status !== 'finished') {
    return { reeval: { ...base, runId, gainPp: 0, confirmed: false, runStatus: run.status }, run };
  }
  const { controlScores, championScores } = pairedStageScores(run.stages, controlId, candidateId);
  const d = reevalDecision(controlScores, championScores);
  return { reeval: { ...base, runId, pairing: d.pairing, gainPp: d.gainPp, confirmed: d.confirmed }, run };
}

async function trainingLoop(
  record: SessionRecord,
  apiKey: string,
  signal: AbortSignal,
): Promise<void> {
  const cfg = record.config;
  const sessionId = record.id;
  const optimizerModelId = cfg.optimizerModelId ?? cfg.datagenModelId;
  const promptOptimization = cfg.promptOptimization !== false;
  const hasBase = Boolean(cfg.basePrompt && cfg.basePrompt.trim());
  // IMPL-002: ausente = margem pratica default max(1; 50/n), resolvida NO GATE
  // (depende do n de pares da iteracao). O gate tambem exige p ajustado <= 0,05.
  const minGain = cfg.minGain;
  // IMPL-051: paciencia configuravel (default 2, IMPL-013) — iteracoes seguidas
  // sem promocao antes de convergir.
  const patience = resolvePatience(cfg);

  // Catálogo quente antes do primeiro gasto (espelho do Node): o reescritor da
  // iteração 0 roda ANTES da 1ª run, e sem catálogo perde a allowlist de
  // esforço/amostragem, o fallback de preço e a base das portas de orçamento.
  const catalogo = await listModels(apiKey).catch(() => []);

  // UM ledger raiz para a sessão inteira (espelho de src/trainer.ts): o teto é
  // da SESSÃO, não da iteração. As runs escrevem nele via `parentLedger` e o
  // reescritor via `ctx`. É a fonte de verdade do gasto (IMPL-021/IMPL-020).
  const ledger = new BudgetLedger({
    budgetUsd: cfg.budgetUsd,
    signal,
    estimateCall: makeCallEstimator(catalogo),
  });
  const ctx: RunCtx = { signal, sink: ledger };
  record.budgetUsd = cfg.budgetUsd;
  // Porta de orçamento: preço desconhecido pelo pior caso (IMPL-018) — espelho do Node.
  const estIter = estimateRunCost(estimateInputFromConfig(cfg as never), catalogo, {
    unknownPrice: 'worst-case',
  }).perIteration;
  const syncLedger = (): void => {
    const snap = ledger.snapshot();
    record.totalCostUsd = snap.spentUsd;
    record.costByRole = snap.byRole;
    record.costAccuracy = snap.accuracy;
    record.costLedger = ledger.summary(); // IMPL-017: spent/committed/pending
    if (snap.upstreamUsd > 0) record.upstreamCostUsd = snap.upstreamUsd;
  };

  await saveSession(record);
  emitSessionEvent({ type: 'session.started', sessionId, record });
  log(sessionId, `started: ${cfg.iterations} iteracoes (minGain=${minGain ?? 'auto max(1; 50/n)'}, gate max-T a 5%, paciencia ${patience})`);

  let pinnedStages: StageSpec[] | undefined;
  // Fatia de holdout (split anti-overfit na iteracao 0): fica so EM MEMORIA —
  // sessoes nao resumem entre processos hoje, entao nao precisa ir para o disco.
  let holdoutStages: StageSpec[] = [];
  // Holdout ainda devido: há fatia reservada sem resultado, ou a sessão parou
  // antes de os cenários congelarem (fatia não decidida, holdout ligado).
  const holdoutPendente = (): boolean =>
    !record.holdout && (holdoutStages.length > 0 || (!record.pinnedStages && cfg.holdoutRatio !== 0));
  let prevRun: RunRecord | undefined;
  // F4.1: pool Pareto (populacao diversa). maxSize 1 = elitismo classico.
  const poolSize = Math.max(1, Math.round(cfg.paretoPool ?? 1));
  let pool: PoolMember[] = [];
  const usoPai: Record<string, number> = {};
  // IMPL-060: runs por id — o dossiê de lições de cada membro do pool vem da
  // run DELE (não da última run, nem do campeão).
  const runsById = new Map<string, RunRecord>();
  // IMPL-062 (R-02b:REC-4): com FATIA ÚNICA a dominância de Pareto vira
  // comparação de média — o treino roda como elitismo EXPLÍCITO (sem estado de
  // pool/paretoFront). O pool só se forma com poolSize > 1 E fatias múltiplas
  // (só conhecidas depois da iteração 0, quando os cenários congelam).
  let fatiasMultiplas = false;
  let todasSpecs: StageSpec[] = [];
  let nInstancias = 0;
  // F4.2: 1o hash do contrato do juiz visto na sessao (detecta drift).
  let primeiroIdJuiz: JudgeIdentity | undefined;
  let champion: Champion | undefined;
  // Id que o campeao teve na run MAIS RECENTE (promovido: o id da variante;
  // convergido: a regua, que segurou o titulo). Usado na linhagem e no
  // pareamento da significancia.
  let championIdInLastRun = '';
  // IMPL-013: paciência — iterações SEGUIDAS sem promoção (encerra em 2).
  let semPromocao = 0;
  // Enquanto nada foi promovido o campeão É a base: o carry já a re-testa, e
  // repetir o 'original' seria um candidato nulo pago (e mais um no max-T).
  let promovidas = 0;
  // IMPL-013: K ≤ 6 técnicas por iteração; acima disso elas rodam na sessão.
  const techSeed = seedFromId(`techniques:${sessionId}`);

  // IMPL-062: escolha do PAI da próxima derivação. Elitismo explícito (fatia
  // única) não tem pai — o campeão é a base. Com pool, o pai sai do pool:
  // amostragem ∝ COBERTURA (quantas instâncias o candidato vence) quando a
  // feature-flag está ligada E n ≥ 20; senão, o rodízio pelo menos usado.
  const selecionarPai = (): PoolMember | undefined => {
    if (!(poolSize > 1 && fatiasMultiplas && pool.length)) return undefined;
    const coberturaAtiva = cfg.paretoCoverageSampling === true && nInstancias >= PARETO_MIN_N;
    const pai = coberturaAtiva
      ? pickParentByCoverage(
          pool,
          coverageWins(Object.fromEntries(pool.map((m) => [m.id, scenarioScoresOf(runsById.get(m.runId), m.contestantId)]))),
        )
      : pickParent(pool, usoPai);
    if (pai) usoPai[pai.id] = (usoPai[pai.id] ?? 0) + 1;
    return pai;
  };

  // IMPL-062: métricas do pool reportadas (fração de pares não dominados +
  // tamanho do front) com alerta de RUÍDO (fração > 0,6 com n < 20).
  const registrarDiagnostico = (): void => {
    const ativo = poolSize > 1 && fatiasMultiplas;
    const diag = paretoDiagnostics(pool, nInstancias);
    record.paretoMetrics = ativo
      ? { mode: 'pareto', ...diag }
      : { mode: 'elitismo', n: nInstancias, frontSize: champion ? 1 : 0, nonDominatedPairFraction: 0 };
    if (!ativo) return;
    log(
      sessionId,
      `pool Pareto: front ${diag.frontSize}/${pool.length}, pares nao dominados ${(diag.nonDominatedPairFraction * 100).toFixed(0)}%` +
        (diag.noiseAlert
          ? ` — ALERTA: front = RUIDO (fração de pares não dominados > 60% com n=${diag.n} < ${PARETO_MIN_N})`
          : ''),
    );
  };

  // Rodada em curso — vira `stoppedAtIteration` se um sinal de controle subir
  // fora de uma run (reescritor/reflexão da rodada).
  let iterAtual = 0;
  try {
    // LGPD (IMPL-041): recusa a sessão sensível fora da allowlist ANTES do
    // reescritor da iteração 0 (que roda antes da 1ª run e do pré-voo dela).
    // IMPL-040: + liga o roteamento ZDR forçado no ledger da SESSÃO (o
    // reescritor e todas as runs aninhadas, que são forks dele, herdam).
    ledger.setSensitiveRouting((await enforceRunCompliance(cfg)).sensitiveRouting);
    for (let i = 0; i < cfg.iterations; i++) {
      iterAtual = i;
      // Porta suave por ITERAÇÃO (espelho do Node): uma iteração inteira é
      // descartável, e parar aqui deixa o campeão da anterior intacto. Compara
      // contra a ponta ALTA — começar uma iteração que provavelmente não
      // termina é o desperdício que esta porta existe para evitar.
      ledger.throwIfCancelled();
      if (i > 0 && !ledger.canAfford(estIter)) {
        record.budgetExhausted = true;
        record.stoppedAtPhase = 'competitors';
        record.stoppedReason = 'budget';
        record.stoppedAtIteration = i;
        log(sessionId, `orcamento esgotado antes da iteracao ${i + 1}; encerrando com o campeao atual`);
        break;
      }

      // 1) Resolve as variantes desta iteracao.
      let contestants: Contestant[];
      if (i === 0) {
        contestants = await generateContestants({
          apiKey,
          modelId: cfg.contestantModelId,
          theme: cfg.theme,
          basePrompt: cfg.basePrompt,
          originalPrompt: cfg.basePrompt,
          includeOriginal: hasBase,
          techniqueIds: techniquesForIteration(cfg.techniqueIds, i, techSeed),
          manualVariants: cfg.manualVariants,
          promptOptimization,
          optimizerModelId,
          reasoningLevel: cfg.reasoning?.rewriter,
          contracts: cfg.contracts,
          // IMPL-011: juiz do diff do contrato = 1º juiz da run (não o reescritor).
          contractJudgeModelId: cfg.judgeModelIds?.[0],
          // Verificações do contrato no MESMO raciocínio da run (juiz/competidor).
          contractJudgeReasoningLevel: reasoningLevelForRole(cfg.reasoning, 'judge'),
          contestantReasoningLevel: cfg.reasoning?.competitor,
          // Multi-prompt (F2/P0.4): evolui 1 fragmento, irmaos congelados.
          promptGroup: cfg.promptGroup,
          promptId: cfg.promptId,
          timeoutMs: cfg.timeoutMs,
          ctx,
        });
      } else {
        // IMPL-060/IMPL-062: a base de derivação é o PAI (pool Pareto com
        // fatias múltiplas) ou o campeão (elitismo explícito). O dossiê de
        // lições vem da run do PRÓPRIO pai — antes eram sempre as falhas do
        // campeão, o mesmo bloco injetado em todas as K variantes.
        const pai = selecionarPai();
        const dossieRun = pai ? runsById.get(pai.runId) : prevRun;
        const dossieDono = pai ? pai.contestantId : championIdInLastRun;
        // IMPL-013: com paciência a iteração anterior pode não ter promovido —
        // o campeão rodou nela como 'carry'; `v<k>` de lá é OUTRA variante. O
        // dono do dossiê é o que vale (o id da SUA run).
        const dossie =
          lessonsEnabled(cfg) && dossieRun && dossieDono
            ? buildLessonDossier(dossieRun, dossieDono, {
                maxLessonTokens: cfg.maxLessonTokens,
                includeReference: cfg.lessonsIncludeReference,
              })
            : undefined;
        // IMPL-060, critério 3: truncagem NUNCA é silensiosa — vai para o log.
        const avisoTruncagem = dossie ? lessonTruncationNotice(dossie) : undefined;
        if (avisoTruncagem) log(sessionId, avisoTruncagem);
        const hint0 = dossie ? renderLessonDossier(dossie) : '';
        // Reflexao GEPA POR LLM (opt-in, §7.5): o meta-modelo reescreve as
        // licoes deterministicas num bloco acionavel. Custo extra contado no
        // ledger; falha DEGRADA para o deterministico — nunca derruba a iteracao.
        let hint = hint0;
        if (hint0 && cfg.reflection === 'llm') {
          try {
            hint = await llmReflectLessons({
              apiKey,
              modelId: optimizerModelId,
              baseLessons: hint0,
              theme: cfg.theme,
              reasoningLevel: cfg.reasoning?.rewriter,
              timeoutMs: cfg.timeoutMs,
              ctx,
            });
            log(sessionId, `reflexao LLM aplicada (${hint.length} chars de licoes)`);
          } catch (err) {
            // Sinal de controle sobe; qualquer outra falha degrada para as
            // licoes deterministicas — nunca derruba a iteracao.
            if (isControlSignal(err)) throw err;
            log(
              sessionId,
              `reflexao LLM falhou; licoes deterministicas seguem: ${err instanceof Error ? err.message : String(err)}`,
            );
            hint = hint0;
          }
        }
        contestants = await generateContestants({
          apiKey,
          modelId: cfg.contestantModelId,
          theme: cfg.theme,
          // F4.1: com pool >1 a base de DERIVACAO vem do pai amostrado (pais
          // diversos — o GEPA mostra que colapsar num unico campeao e preso a
          // otimo local). A REGUA ('carry') continua sendo o campeao: o gate por
          // margem nao muda de significado.
          basePrompt: pai?.text ?? champion!.systemPrompt,
          originalPrompt: cfg.basePrompt,
          carryPrompt: champion!.systemPrompt,
          carryLabel: `Melhor it.${i}`,
          carryParentId: champion!.contestantId,
          includeOriginal: hasBase && promovidas > 0,
          techniqueIds: techniquesForIteration(cfg.techniqueIds, i, techSeed),
          manualVariants: cfg.manualVariants,
          promptOptimization,
          optimizerModelId,
          analysisHint: hint,
          reasoningLevel: cfg.reasoning?.rewriter,
          contracts: cfg.contracts,
          // IMPL-011: juiz do diff do contrato = 1º juiz da run (não o reescritor).
          contractJudgeModelId: cfg.judgeModelIds?.[0],
          // Verificações do contrato no MESMO raciocínio da run (juiz/competidor).
          contractJudgeReasoningLevel: reasoningLevelForRole(cfg.reasoning, 'judge'),
          contestantReasoningLevel: cfg.reasoning?.competitor,
          // Multi-prompt (F2/P0.4): evolui 1 fragmento, irmaos congelados.
          promptGroup: cfg.promptGroup,
          promptId: cfg.promptId,
          timeoutMs: cfg.timeoutMs,
          ctx,
        });
      }

      if (contestants.length < 2) {
        throw new Error(`Iteracao ${i + 1}: variantes insuficientes (${contestants.length}).`);
      }

      // 2) Roda a iteracao (benchmark pinado a partir da iteracao 1).
      // IMPL-012 (R-02b:REC-3): o sequential halving (F4.3, `training.halving`)
      // foi REMOVIDO daqui. A triagem rodava uma run completa (competidores +
      // juiz + finais), a rodada 1 mantinha keep = V (0 eliminadas sempre) e o
      // rascunho era descartado: custo puro. As simulacoes da pesquisa vetam
      // religar como estava: H4 — P(eliminar a verdadeira melhor) 21,7–24,3% com
      // c <= 3 cenarios por rodada; H5 — nenhuma configuracao economiza >= 20%
      // com P(melhor sobreviver) >= 0,9; H6 — reusar as avaliacoes da triagem
      // infla o ganho reportado do vencedor em 4,9–8,7 p.p. So reimplementar do
      // zero se K >= 8 e n >= 20 virarem rotina: corte real (keepCount < V desde
      // a rodada 1), re-avaliacao limpa e as simulacoes como teste de regressao.

      const runId = randomUUID();
      record.runIds.push(runId);
      await saveSession(record);
      emitSessionEvent({ type: 'iteration.started', sessionId, iteration: i, runId });
      log(sessionId, `iteracao ${i + 1}/${cfg.iterations} -> run ${runId} (${contestants.length} variantes)`);

      const runRec = await runToCompletion(variationConfigFrom(cfg), apiKey, {
        runId,
        contestants,
        pinnedStages,
        sessionId,
        iteration: i,
        parentRunId: prevRun?.id,
        parentLedger: ledger,
        signal,
      });

      // O ledger e a fonte de verdade do gasto (todos os papeis de todas as
      // runs + reescritor); somar `runRec.totalCostUsd` contaria duas vezes.
      // IMPL-060: guarda a run por id — o dossiê de lições de cada membro do
      // pool vem da run DELE (lições da própria run da variante).
      runsById.set(runRec.id, runRec);
      syncLedger();

      // IMPL-004: vereditos perdidos da sessao = soma das runs (iteracoes,
      // triagem e holdout) — a mesma conta que cada run carrega.
      record.failureCountByRole = mergeFailureCounts(record.failureCountByRole, runRec.failureCountByRole);
      // A run da iteração parou por orçamento/cancelamento => a sessão para
      // também, com o campeão da iteração ANTERIOR (a desta ficou parcial e
      // não pode promover ninguém).
      if (runRec.stoppedReason) {
        record.budgetExhausted = runRec.stoppedReason === 'budget';
        record.stoppedReason = runRec.stoppedReason;
        record.stoppedAtPhase = runRec.stoppedAtPhase;
        record.stoppedAtIteration = i;
        await saveSession(record);
        break;
      }

      // F4.2: calibration drift — contrato do juiz diferente no meio da sessao
      // significa que o delta entre iteracoes pode ser do JUIZ, nao do prompt.
      // IMPL-019: a identidade inclui o snapshot (canonicalSlug/aliasTarget) do
      // juiz e do gabarito — alias `~…-latest` movido no meio da sessao e outro
      // modelo com o MESMO id, e o hash sozinho nao veria.
      const idJuiz = judgeIdentity(runRec);
      if (idJuiz) {
        if (primeiroIdJuiz && judgeIdentityChanged(primeiroIdJuiz, idJuiz)) record.judgeDrift = true;
        primeiroIdJuiz = primeiroIdJuiz ? mergeJudgeIdentity(primeiroIdJuiz, idJuiz) : idJuiz;
      }

      // 3) Pina o benchmark depois da iteracao 0 (mesmas perguntas em todas),
      //    com split anti-overfit: a fatia de holdout fica FORA da selecao e so
      //    entra no gate final (ver finalizeHoldout).
      if (i === 0) {
        const specs = runRec.stages
          .map((s) => s.spec)
          .filter((s): s is StageSpec => Boolean(s));
        // IMPL-065: os cenários da sessão congelam aqui — é deles que vem a
        // contagem de itens curados (âncora humana) da declaração de campeão.
        // As fatias do pool (IMPL-062) saem só do TREINO, logo abaixo.
        todasSpecs = specs;
        if (cfg.holdoutRatio !== 0) {
          // IMPL-050: piso ABSOLUTO de 10 cenários + ratio default 0,3. Fatia
          // curta não é holdout: é "confirmação fraca" (`strength`), o campeão
          // sai com `holdoutSkipped` e a palavra "validado" fica bloqueada
          // (ver `holdoutConfirmationText`).
          const split = splitHoldout(specs, cfg.holdoutRatio ?? HOLDOUT_RATIO_DEFAULT);
          pinnedStages = split.train;
          holdoutStages = split.holdout;
          if (split.strength === 'confirmacao-fraca') {
            // web-code#8/cli#9: o MOTIVO fica gravado — sessão pequena não é
            // "pulada por orçamento".
            markHoldoutSkip(record, 'min-scenarios');
            log(sessionId, holdoutConfirmationText(split.reserved.length, { strength: split.strength }));
          }
        } else {
          pinnedStages = specs;
          markHoldoutSkip(record, 'disabled');
        }
        record.pinnedStages = pinnedStages;
        // O pool/diagnóstico Pareto medem a SELEÇÃO: instâncias e fatias do
        // TREINO (a fatia de holdout não entra na matriz candidato × cenário).
        nInstancias = pinnedStages.length;
        fatiasMultiplas = sliceKeysOf(pinnedStages).length > 1;
      }

      // web-code#1 (espelho de src/trainer.ts): a SELEÇÃO nunca vê a fatia de
      // holdout. A run da iteração 0 cobriu todos os cenários (é nela que eles
      // nascem); daqui em diante o gate, a re-avaliação, as medalhas, o pool e
      // as lições da próxima iteração leem só as etapas de TREINO. Só na
      // iteração 0: as seguintes já rodam pinadas no treino (e o orchestrator
      // clona as specs pinadas — a identidade de objeto só vale aqui).
      const selRun = i === 0 && holdoutStages.length > 0 ? trainOnlyView(runRec, pinnedStages ?? []) : runRec;
      runsById.set(selRun.id, selRun);

      // 4) Gate de promocao (port do evolve.mjs + IMPL-002): a melhor variante
      //    so vira campea se superar a REGUA desta iteracao por >= minGain
      //    pontos de judge-score E passar no max-T sobre as K variantes (p
      //    ajustado <= 0,05 — a "melhor de K" nao ganha mais sozinha). A regua e
      //    o 'original' (base) na iteracao 0 e o 'carry' (campeao anterior
      //    re-testado verbatim) nas demais.
      const controlId = i === 0 ? 'original' : 'carry';
      // IMPL-005: o ganho e o Δ PAREADO (so etapas com veredito nos DOIS
      // lados; ausente nunca vira 'nao') e, com >10% de pares excluidos, a
      // promocao so vale se sobreviver ao pior/melhor caso (ver pickWinner).
      const scoresById = stageScoresByContestant(
        selRun.stages,
        selRun.contestants.map((c) => c.id),
      );
      // IMPL-071: o desempate por tamanho só vale entre variantes com o
      // contrato never-break v2 verde (ver buildRankEntries).
      const pick = pickWinner(
        buildRankEntries(selRun, controlId, { contractsActive: Boolean(cfg.contracts) }),
        {
          minGain,
          scoresById,
        },
      );
      // IMPL-013: passou no gate da melhor de K → re-avaliação LIMPA num
      // minibatch antes de confirmar (as avaliações da seleção não confirmam a
      // própria seleção). Sem régua (treino sem prompt base, iteração 0) não há
      // contra quem re-avaliar: a melhor vence por definição, como antes.
      let gate: IterationGate | undefined = pick.gate;
      let reevalRun: RunRecord | undefined;
      let confirmed = pick.isWinner && Boolean(pick.best);
      if (confirmed && pick.best && pick.control) {
        const r = await reevaluateCandidate({
          cfg,
          apiKey,
          record,
          iteration: i,
          selectionRun: selRun,
          controlId,
          candidateId: pick.best.id,
          trainStages: pinnedStages ?? [],
          ledger,
          signal,
        });
        reevalRun = r.run;
        syncLedger();
        confirmed = r.reeval.confirmed;
        if (gate) {
          gate = confirmed
            ? { ...gate, reeval: r.reeval }
            : { ...gate, reeval: r.reeval, decision: 'held', heldBy: [...(gate.heldBy ?? []), 'reeval'] };
        }
        log(
          sessionId,
          `re-avaliacao limpa de ${pick.best.id} em ${r.reeval.size} cenarios: Δ ${r.reeval.gainPp.toFixed(1)}pp — ${
            confirmed ? 'confirmada' : `NAO confirmada${r.reeval.runStatus ? ` (run ${r.reeval.runStatus})` : ''}`
          }`,
        );
      }
      let promoted = false;
      if (confirmed && pick.best) {
        const wc = runRec.contestants.find((c) => c.id === pick.best!.id);
        champion = {
          contestantId: pick.best.id,
          // Multi-prompt: o campeao e o FRAGMENTO evoluido (nunca o composto).
          systemPrompt: wc?.promptFragment ?? wc?.systemPrompt ?? champion?.systemPrompt ?? cfg.basePrompt ?? '',
          label: wc?.label ?? pick.best.id,
        };
        championIdInLastRun = pick.best.id;
        promoted = true;
        promovidas += 1;
      } else if (!champion) {
        // A regua segurou o titulo logo na 1a rodada.
        const controlC = runRec.contestants.find((c) => c.id === controlId);
        champion = {
          contestantId: controlId,
          // Multi-prompt: o FRAGMENTO (com paciência o laço segue e o carry
          // compõe de novo — o composto seria composto duas vezes).
          systemPrompt: controlC?.promptFragment ?? controlC?.systemPrompt ?? cfg.basePrompt ?? '',
          label: controlC?.label ?? controlId,
        };
        championIdInLastRun = controlId;
      } else {
        // Convergencia em i>0: o campeao anterior rodou como 'carry' e se manteve.
        championIdInLastRun = controlId;
      }

      // 5) Linhagem: registra o CAMPEAO POS-GATE de cada iteracao (score e
      //    medalhas seguem de computeMedals apenas para a UI — a decisao de
      //    promocao e do gate por margem, nao do quadro de medalhas).
      // Cast: o RunRecord do web aceita stoppedReason 'orphan' (IMPL-023, só
      // SPA) e o de src/ ainda não — uma run desta aba nunca é órfã aqui.
      const medalRow = computeMedals(selRun as Parameters<typeof computeMedals>[0]).find(
        (r) => r.contestantId === championIdInLastRun,
      );
      record.bestPromptByIteration.push({
        iteration: i,
        runId: runRec.id,
        winnerContestantId: championIdInLastRun,
        systemPrompt: champion.systemPrompt,
        score: medalRow?.golds ?? 0,
        medals: medalRow?.medals ?? [],
        golds: medalRow?.golds ?? 0,
        silvers: medalRow?.silvers ?? 0,
        bronzes: medalRow?.bronzes ?? 0,
        ...(gate ? { gate } : {}),
      });

      // F4.1: promocao entra no POOL (nunca derruba o campeao unico — o pool
      // e aditivo e o champion segue sendo o melhor absoluto p/ holdout).
      // IMPL-062 (R-02b:REC-4): o pool SÓ existe com fatias múltiplas — com
      // fatia única a dominância de Pareto vira comparação de média e o treino
      // roda como elitismo EXPLÍCITO (sem estado de pool/paretoFront; o record
      // não traz `pool` e nenhum teste/consumidor deve esperar paretoFront).
      const paretoAtivo = poolSize > 1 && fatiasMultiplas;
      if (promoted) {
        if (paretoAtivo) {
          pool = addToPool(
            pool,
            {
              id: `it-${i}`,
              label: champion.label,
              bySlice: sliceScoresOf(selRun, championIdInLastRun),
              text: champion.systemPrompt,
              // Proveniência: o dossiê de lições do membro vem DESTE run/id.
              runId: runRec.id,
              contestantId: championIdInLastRun,
            },
            { maxSize: poolSize },
          );
          // F4.1: o front (sem o texto — grande demais p/ o record) mostra a
          // POPULACAO que sobreviveu, nao so o campeao.
          record.pool = pool.map((e) => ({ id: e.id, label: e.label ?? e.id, bySlice: e.bySlice }));
        }
        // ...com elitismo explícito o campeão É o estado: `record.pool` não existe.
      }
      registrarDiagnostico();

      // web-code#1: as lições da próxima iteração (e a significância de
      // fallback) leem a visão de SELEÇÃO — sem as perguntas do holdout.
      prevRun = selRun;
      emitSessionEvent({
        type: 'iteration.finished',
        sessionId,
        iteration: i,
        runId: runRec.id,
        winnerContestantId: championIdInLastRun,
      });
      if (promoted) {
        emitSessionEvent({
          type: 'iteration.promoted',
          sessionId,
          iteration: i,
          championId: champion.contestantId,
          gain: pick.gain,
          // IMPL-002: bruto (gain) e corrigido lado a lado, com o p ajustado.
          ...promotionEventFields(gate),
        });
        log(
          sessionId,
          `iteracao ${i + 1}: promovido ${champion.contestantId} (${
            gate ? formatIterationGate(gate) : `ganho +${pick.gain.toFixed(1)}pp`
          })`,
        );
      }
      await saveSession(record);

      // IMPL-013 (web-code#0, espelho de src/trainer.ts): a re-avaliação parou
      // por orçamento/cancelamento → a sessão para também (o candidato NÃO foi
      // promovido: faltou a evidência limpa). Sem isto o treino seguia para a
      // paciência e terminava 'finished' + 'converged' depois de cancelado.
      if (reevalRun?.status === 'aborted' && reevalRun.stoppedReason) {
        record.budgetExhausted = reevalRun.stoppedReason === 'budget';
        record.stoppedReason = reevalRun.stoppedReason;
        record.stoppedAtPhase = reevalRun.stoppedAtPhase;
        record.stoppedAtIteration = i;
        await saveSession(record);
        break;
      }

      // IMPL-013/IMPL-051 — paciência configurável (default 2): uma iteração
      // sem promoção NÃO encerra a sessão (antes encerrava: paciência implícita
      // 1). A próxima deriva de novo do campeão atual, com lições novas; só
      // `patience` SEGUIDAS sem promoção = convergiu.
      semPromocao = promoted ? 0 : semPromocao + 1;
      // IMPL-051 — parada por PLATÃO: o IC95 do ganho termina ABAIXO de minGain
      // (nenhum valor plausível do ganho alcança a margem: a curva platôou).
      // Só depois de 2 seguidas sem promoção — a 1ª nunca mata a busca
      // (IMPL-013: sob H0 25,8–35,8% das sessões param cedo por azar) — e
      // antecipa a paciência quando ela é configurada acima de 2.
      const ciGanho = pairedGainCi(scoresById, controlId, pick.best?.id);
      const minGainPp = gate?.minGain ?? minGain ?? 1;
      const plateau =
        !promoted &&
        semPromocao >= Math.min(2, patience) &&
        ciGanho !== undefined &&
        ciGanho[1] < minGainPp;
      if (!promoted && (plateau || shouldStopForPatience(semPromocao, patience))) {
        // IMPL-051: a convergência reporta iteração E motivo (platão vs paciência).
        const reason: 'patience' | 'plateau' = plateau ? 'plateau' : 'patience';
        record.convergedAtIteration = i;
        record.convergenceReason = reason;
        emitSessionEvent({ type: 'session.converged', sessionId, iteration: i, reason });
        const detalheIc = ciGanho
          ? `; IC95 do ganho [${ciGanho[0].toFixed(1)}; ${ciGanho[1].toFixed(1)}]pp vs minGain ${minGainPp.toFixed(1)}pp`
          : '';
        log(
          sessionId,
          gate?.decision === 'inconclusive'
            ? `parou sem promocao na iteracao ${i + 1} (${semPromocao} seguidas, motivo ${reason}): gate INCONCLUSIVO (${gate.pairing.excludedPairs} de ${gate.pairing.n} pares sem veredito; a decisao muda no pior/melhor caso)`
            : `convergiu na iteracao ${i + 1} por ${reason === 'plateau' ? 'platao' : 'paciencia'} (${semPromocao} seguidas sem promocao${detalheIc}; ${
                gate ? formatIterationGate(gate) : `ganho ${pick.gain.toFixed(1)}pp < minGain ${minGainPp}`
              })`,
        );
        await saveSession(record);
        break;
      }
      if (!promoted) {
        log(
          sessionId,
          `iteracao ${i + 1} sem promocao (${semPromocao}/${patience} da paciencia): segue com o campeao atual`,
        );
      }
    }

    // 6) Gate final: holdout + significancia. NUNCA derruba a sessao — falha
    //    aqui vira warn e o treino termina com o que se tem.
    let scoreCi95Pp: [number, number] | null = null;
    try {
      // O holdout é uma run extra. Sem orçamento para ela o campeão fica sem
      // CONFIRMAÇÃO contra sobreajuste — e isso precisa aparecer no resultado
      // (`holdoutSkipped`), não sumir. Espelho de src/trainer.ts. IMPL-050: a
      // palavra "validado" só aparece com holdout forte e rodado (ver
      // `holdoutConfirmationText`).
      const estHoldout =
        holdoutStages.length > 0 ? estIter * (holdoutStages.length / Math.max(1, cfg.stages)) : 0;
      if (record.stoppedReason || (estHoldout > 0 && !ledger.canAfford(estHoldout))) {
        // Só há o que "pular" se havia fatia de holdout reservada — ou se a
        // sessão parou antes de os cenários congelarem (sem fatia decidida, o
        // motivo já foi gravado na iteração 0: piso de cenários ou desligado).
        if (holdoutPendente()) {
          markHoldoutSkip(record, record.stoppedReason && record.stoppedReason !== 'budget' ? 'cancelled' : 'budget');
        }
        log(
          sessionId,
          holdoutConfirmationText(holdoutStages.length, {
            skipped: true,
            skipReason: record.holdoutSkipReason,
          }),
        );
      } else {
        const gateFinal = await finalizeHoldout(record, apiKey, champion, championIdInLastRun, holdoutStages, prevRun, {
          ledger,
          signal,
        });
        scoreCi95Pp = gateFinal.scoreCi95Pp ?? null;
      }
    } catch (err) {
      if (isControlSignal(err)) {
        record.stoppedReason ??= err.benchControl === 'budget' ? 'budget' : 'cancelled';
        if (err.benchControl === 'budget') record.budgetExhausted = true;
        if (holdoutPendente()) markHoldoutSkip(record, err.benchControl === 'budget' ? 'budget' : 'cancelled');
      } else {
        console.warn(
          `[train ${sessionId}] gate de holdout/significancia falhou (sessao segue): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        if (holdoutStages.length > 0 && !record.holdout) markHoldoutSkip(record, 'run-failed');
      }
    }

    // IMPL-065 (R-05:REC-4): declaração de campeão sob âncora HUMANA. Com
    // curatedItems < minCuratedItems o treino NÃO declara campeão — o dataset
    // sintético é bootstrap/treino, não evidência — e a recusa entra no
    // resultado citando o número de itens curados e o piso.
    const specsDeclaracao = todasSpecs.length
      ? todasSpecs
      : (record.pinnedStages ?? cfg.customStages ?? cfg.scenarioSeed ?? []);
    record.championDeclaration = championDeclarationFor(specsDeclaracao, {
      minCuratedItems: cfg.minCuratedItems,
      scoreCi95Pp,
    });
    log(sessionId, record.championDeclaration.message);

    syncLedger();
    // Parou cedo (orçamento/cancelamento): resultado PARCIAL, e diz isso.
    record.status = record.stoppedReason ? 'aborted' : 'finished';
    record.finishedAt = nowIso();
    await saveSession(record);
    emitSessionEvent({ type: 'session.finished', sessionId, record });
    log(sessionId, `finished: custo ${record.totalCostUsd}`);
  } catch (err) {
    syncLedger();
    if (isControlSignal(err)) {
      // Orçamento/cancelamento fora de uma run (reescritor, porta da
      // iteração): sessão interrompida COM o resultado parcial, não erro.
      record.status = 'aborted';
      record.stoppedReason = err.benchControl === 'budget' ? 'budget' : 'cancelled';
      if (err.benchControl === 'budget') record.budgetExhausted = true;
      record.stoppedAtIteration ??= iterAtual;
      // A fatia reservada nunca chegou ao teste final: o motivo é a parada.
      if (holdoutPendente()) markHoldoutSkip(record, record.stoppedReason);
      record.finishedAt = nowIso();
      await saveSession(record);
      emitSessionEvent({ type: 'session.finished', sessionId, record });
      log(sessionId, `sessao interrompida (${record.stoppedReason})`);
      return;
    }
    record.status = 'error';
    record.error = err instanceof Error ? err.message : String(err);
    record.finishedAt = nowIso();
    await saveSession(record);
    emitSessionEvent({ type: 'session.error', sessionId, error: record.error });
    log(sessionId, `error: ${record.error}`);
  }
}

/**
 * Gate final do treino (port do evolve.mjs): re-score do campeao contra o
 * controle (base) nos cenarios de HOLDOUT — que ficaram fora da selecao — mais
 * significancia estatistica (teste pareado exato por troca de sinais + IC por
 * inversao, IMPL-001). E SUPORTE A DECISAO (a UI mostra ganho/regressao/
 * p-valor); nao bloqueia a promocao nem derruba a sessao (o chamador envolve
 * em try/catch).
 */
async function finalizeHoldout(
  record: SessionRecord,
  apiKey: string,
  champion: Champion | undefined,
  championIdInLastRun: string,
  holdoutStages: StageSpec[],
  lastRun: RunRecord | undefined,
  ctxOpts: { ledger?: BudgetLedger; signal?: AbortSignal } = {},
): Promise<{ scoreCi95Pp?: [number, number] | null }> {
  const cfg = record.config;
  const sessionId = record.id;
  const basePrompt = cfg.basePrompt ?? '';
  // IMPL-065: IC95 do score do campeão (pareado) — reportado na declaração.
  let scoreCi95Pp: [number, number] | null = null;
  // Multi-prompt: no holdout o systemPrompt efetivo e a composicao do grupo.
  const comporHoldout = (fragmento: string): string =>
    cfg.promptGroup ? composePrompt(cfg.promptGroup, cfg.promptId, fragmento) : fragmento;

  let holdoutRun: RunRecord | undefined;
  // So ha o que re-testar se a fatia de holdout e confiavel, existe um prompt
  // base p/ servir de controle e o campeao final e uma VARIANTE (se o treino
  // convergiu sem ganho, campeao == base e a run compararia ele consigo mesmo).
  // web-code#8: quando não roda, o MOTIVO fica gravado.
  if (champion && holdoutStages.length >= MIN_HOLDOUT_SCENARIOS) {
    if (!basePrompt.trim()) markHoldoutSkip(record, 'no-base');
    else if (champion.systemPrompt === basePrompt) markHoldoutSkip(record, 'no-change');
  }
  if (
    champion &&
    holdoutStages.length >= MIN_HOLDOUT_SCENARIOS &&
    basePrompt.trim() &&
    champion.systemPrompt !== basePrompt
  ) {
    const runId = randomUUID();
    record.runIds.push(runId);
    await saveSession(record);
    log(sessionId, `holdout: run ${runId} (${holdoutStages.length} cenarios reservados)`);

    const contestants: Contestant[] = [
      {
        id: 'holdout-control',
        label: 'Controle (base)',
        modelId: cfg.contestantModelId,
        systemPrompt: comporHoldout(basePrompt),
      },
      {
        id: 'holdout-champion',
        label: 'Campeao (final)',
        modelId: cfg.contestantModelId,
        systemPrompt: comporHoldout(champion.systemPrompt),
      },
    ];
    holdoutRun = await runToCompletion(
      { ...variationConfigFrom(cfg), stages: holdoutStages.length, customStages: undefined },
      apiKey,
      {
        runId,
        contestants,
        pinnedStages: holdoutStages,
        sessionId,
        // Marcador "rodada H": a iteracao logo apos a ultima do treino — na UI
        // a run de holdout aparece como uma iteracao extra (N+1).
        iteration: cfg.iterations,
        parentRunId: lastRun?.id,
        parentLedger: ctxOpts.ledger,
        signal: ctxOpts.signal,
      },
    );
    if (ctxOpts.ledger) {
      const snap = ctxOpts.ledger.snapshot();
      record.totalCostUsd = snap.spentUsd;
      record.costByRole = snap.byRole;
      record.costAccuracy = snap.accuracy;
      record.costLedger = ctxOpts.ledger.summary(); // IMPL-017: spent/committed/pending
    } else {
      record.totalCostUsd += holdoutRun.totalCostUsd;
    }
    // Holdout cortado por orçamento/cancelamento: o gate não aconteceu — o
    // campeão fica sem confirmação, e o motivo sobe para a sessão.
    if (holdoutRun.stoppedReason) {
      record.stoppedReason ??= holdoutRun.stoppedReason;
      if (holdoutRun.stoppedReason === 'budget') {
        record.budgetExhausted = true;
        record.stoppedAtPhase ??= 'holdout';
      }
      markHoldoutSkip(record, holdoutRun.stoppedReason === 'budget' ? 'budget' : 'cancelled');
    }
    record.failureCountByRole = mergeFailureCounts(record.failureCountByRole, holdoutRun.failureCountByRole);
    // `inconclusive` (IMPL-004) tambem descarta o gate: holdout com vereditos
    // perdidos demais ou n efetivo < 5 nao valida campeao nenhum.
    if (holdoutRun.status !== 'finished') {
      console.warn(
        `[train ${sessionId}] run de holdout terminou com status ${holdoutRun.status}; gate descartado`,
      );
      // Erro/inconclusiva (sem parada): run sem veredito — o motivo fica gravado.
      markHoldoutSkip(record, 'run-failed');
      holdoutRun = undefined; // cai no fallback de significancia abaixo
    }
  }

  if (holdoutRun) {
    // IMPL-005: medias, ganho e teste sobre OS MESMOS pares — so etapas com
    // veredito nos DOIS lados (ausente sai dos dois, nunca vira 'nao').
    const { controlScores, championScores } = pairedStageScores(
      holdoutRun.stages,
      'holdout-control',
      'holdout-champion',
    );
    scoreCi95Pp = scoreCiOf(controlScores, championScores);
    const coverage = pairCoverage(controlScores, championScores);
    const controlScore = coverage.controlMeanPp ?? 0;
    const championScore = coverage.championMeanPp ?? 0;
    record.holdout = {
      n: holdoutStages.length,
      controlScore,
      championScore,
      gain: coverage.meanDiffPp ?? 0,
      regressed: championScore < controlScore,
      nEfetivo: coverage.nEfetivo,
      excludedPairs: coverage.excludedPairs,
      completeness: coverage.completeness,
    };
    record.pairing = {
      source: 'holdout',
      controlId: 'holdout-control',
      championId: 'holdout-champion',
      ...coverage,
    };
    emitSessionEvent({ type: 'session.holdout', sessionId, holdout: record.holdout });
    // IMPL-051/IMPL-050: UM teste final em holdout intocado (α=0,05 unilateral)
    // é o ÚNICO p de confirmação da sessão — rotulado com a origem ('holdout').
    record.significance = pairedSignificance(controlScores, championScores, { pOrigin: 'holdout' });
    // IMPL-050: "validado" só se o holdout CONFIRMOU (sem regressão, p ≤ α).
    log(
      sessionId,
      holdoutConfirmationText(holdoutStages.length, {
        outcome: {
          regressed: record.holdout.regressed,
          gainPp: record.holdout.gain,
          pValue: record.significance?.pValue ?? null,
          pOrigin: 'holdout',
        },
      }),
    );
  } else if (lastRun && champion) {
    // Sem run de holdout (split invalido, campeao == base ou run falhou): a
    // significancia vem da ultima run de treino, pareando a BASE ('original',
    // quando presente — mesma comparacao que o holdout faria) com o campeao;
    // sem base na run, cai na regua da iteracao ('carry'). null se n<5 — a
    // funcao ja trata.
    const lastControlId = (lastRun.iteration ?? 0) === 0 ? 'original' : 'carry';
    const pairingControl = lastRun.contestants.some((c) => c.id === 'original')
      ? 'original'
      : lastControlId;
    const pairable =
      pairingControl !== championIdInLastRun &&
      lastRun.contestants.some((c) => c.id === pairingControl) &&
      lastRun.contestants.some((c) => c.id === championIdInLastRun);
    if (pairable) {
      const { controlScores, championScores } = pairedStageScores(
        lastRun.stages,
        pairingControl,
        championIdInLastRun,
      );
      scoreCi95Pp = scoreCiOf(controlScores, championScores);
      record.pairing = {
        source: 'training',
        controlId: pairingControl,
        championId: championIdInLastRun,
        ...pairCoverage(controlScores, championScores),
      };
      // IMPL-050 (R-04 DEC-7): este p veio da PRÓPRIA run de seleção —
      // anti-conservador (mede o mesmo dado que escolheu o melhor) e vem
      // rotulado como tal em todo relatório.
      record.significance = pairedSignificance(controlScores, championScores, { pOrigin: 'selecao' });
    } else {
      // Campeao == controle (convergiu sem ganho) ou ids ausentes na run:
      // nao ha comparacao a testar.
      record.significance = null;
    }
  }
  await saveSession(record);
  return { scoreCi95Pp };
}
