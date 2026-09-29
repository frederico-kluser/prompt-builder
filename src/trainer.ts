import { randomUUID } from 'node:crypto';
import { runToCompletion } from './orchestrator.js';
import { generateContestants, lessonsEnabled, llmReflectLessons } from './variator.js';
import { composePrompt } from './engine/promptGroup.js';
import {
  addToPool,
  coverageWins,
  paretoDiagnostics,
  pickParent,
  pickParentByCoverage,
  sliceScores,
  PARETO_MIN_N,
  type ParetoEntry,
} from './engine/pareto.js';
import {
  judgeIdentity,
  judgeIdentityChanged,
  mergeJudgeIdentity,
  type JudgeIdentity,
} from './engine/modelLifecycle.js';
import { seedFromId } from './engine/duelCore.js';
import {
  championDeclarationFor,
  demoQuestionsOf,
  humanReferenceIndex,
  pickReevalMinibatch,
  plannedTrainingStages,
  questionKey,
  reevalDecision,
  shouldStopForPatience,
  techniquesForIteration,
  trainingLabeledPool,
  trainingPromotionPower,
  TRAINING_PATIENCE,
} from './engine/trainingPolicy.js';
import { VerdictCache } from './engine/verdictCache.js';
import { assertRoleSeparation } from './engine/roleSeparation.js';
import { targetModelFor, type LabeledScenario } from './techniques.js';
import { emitSessionEvent } from './events.js';
import { saveSession } from './storage.js';
import { computeMedals } from './medals.js';
import {
  contaminationInputFromRun,
  judgeScoreFromVerdicts,
  pickWinner,
  promotionEventFields,
  safetyInputFromRun,
  type RankEntry,
} from './rank.js';
import {
  holdoutConfirmationText,
  HOLDOUT_RATIO_DEFAULT,
  holdoutSkipLeavesUnvalidated,
  MIN_HOLDOUT_SCENARIOS,
  selectionView,
  splitHoldout,
  trainOnlyView,
} from './holdout.js';
import { meanCiSummary, pairCoverage, pairDiffs, pairedStageScores, stageScoresByContestant, type PairScore } from './stats.js';
import { formatIterationGate, pairedSignificance, VERDICT_SCORE } from './stats.js';
import { BudgetLedger, isControlSignal } from './budget.js';
import { mergeFailureCounts } from './engine/verdictIntegrity.js';
import { estimateInputFromConfig, estimateRunCost, makeCallEstimator } from './estimate.js';
import { reasoningLevelForRole } from './modelCaps.js';
import { AUDITABLE_ROLES, listModels, reconcileAtRunEnd } from './openrouter.js';
import { enforceRunCompliance } from './lgpd.js';
import type {
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
} from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function log(sessionId: string, msg: string): void {
  // stderr: ver a nota em orchestrator.ts — stdout e payload.
  console.error(`[train ${sessionId}] ${msg}`);
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

// IMPL-065 (R-05:REC-4): a régua de item CURADO e a declaração de campeão são
// FONTE ÚNICA em `engine/trainingPolicy.ts` (os dois trainers re-exportam) — a
// cópia por motor já tinha divergido uma vez; aqui ela ganhou o índice de
// gabaritos HUMANOS (gabarito gerado por IA na run não é âncora).
export {
  DEFAULT_MIN_CURATED_ITEMS,
  championDeclarationFor,
  isCuratedItem,
} from './engine/trainingPolicy.js';

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
 * Paciência do laço (IMPL-051): `config.patience` (1–5, schema) ou o default
 * {@link TRAINING_PATIENCE} = 2. Paciência 1 com veredito ruidoso é anti-padrão
 * (sob H0 25,8–35,8% das sessões param cedo por azar — R-04:REC-4).
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
 * IMPL-060 (R-02b:REC-1) — dossiê POR VARIANTE da reflexão GEPA: pergunta
 * completa, resposta do candidato, explicação integral do juiz, veredito e
 * acertos representativos. O dono é SEMPRE o contestant da SUA run (nunca as
 * falhas do campeão injetadas em todas as variantes). Campos versionados:
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
 * silenciosa — o chamador regista este texto em stderr. `undefined` = cabe tudo.
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
  /** Sinal de abort (Ctrl-C). */
  signal?: AbortSignal;
  /**
   * Chamado com o id ANTES do laco comecar. E onde um consumidor assina o bus
   * de eventos sem corrida — `session.started` e emitido dentro do laco.
   */
  onSession?: (sessionId: string, record: SessionRecord) => void;
  /**
   * Ledger EXTERNO (IMPL-031): a sessao vira FILHA dele e o teto segue na raiz
   * (que o chamador cria com o `budgetUsd` da sessao). O CLI passa aqui a raiz
   * que tambem reserva no ledger EM ARQUIVO da maquina (teto diario somando
   * processos). Ausente => raiz propria a partir de cfg.budgetUsd, como antes.
   * Seam so do Node: o mirror web nao tem ledger de maquina.
   */
  parentLedger?: BudgetLedger;
  /**
   * IMPL-080: cache de vereditos da sessão. Ausente = um novo por sessão
   * (default); `false` = desligado; instância = injetada (testes/diagnóstico).
   */
  verdictCache?: VerdictCache | false;
}

/**
 * Registra POR QUE a sessão fica sem holdout (web-code#8/cli#9) — o texto de
 * CLI/UI/handoff sai daqui, nunca é adivinhado. O 1º motivo vence (a fatia que
 * nunca se formou explica mais que uma parada posterior) e `holdoutSkipped`
 * liga só para os motivos que deixam o campeão NÃO validado.
 */
function markHoldoutSkip(record: SessionRecord, reason: HoldoutSkipReason): void {
  record.holdoutSkipReason ??= reason;
  if (holdoutSkipLeavesUnvalidated(record.holdoutSkipReason)) record.holdoutSkipped = true;
}

function newSessionRecord(config: TrainingConfig): SessionRecord {
  return {
    id: randomUUID(),
    status: 'running',
    config,
    runIds: [],
    bestPromptByIteration: [],
    totalCostUsd: 0,
    startedAt: nowIso(),
  };
}

export async function startTraining(
  config: TrainingConfig,
  apiKey: string,
  opts: StartTrainingOpts = {},
): Promise<StartTrainingResult> {
  // IMPL-048: papéis separados (referência/2º gabarito × juiz × modelo sob
  // teste) — defesa em profundidade para quem chama o motor sem o schema.
  assertRoleSeparation(config);
  const record = newSessionRecord(config);
  const sessionId = record.id;
  // Persiste ANTES de responder ao cliente, para a TrainingView nunca pegar 404.
  await saveSession(record);
  opts.onSession?.(sessionId, record);
  void trainingLoop(record, apiKey, opts).catch(async (err) => {
    record.status = 'error';
    record.error = err instanceof Error ? err.message : String(err);
    record.finishedAt = nowIso();
    await saveSession(record).catch(() => undefined);
    emitSessionEvent({ type: 'session.error', sessionId, error: record.error });
  });
  return { sessionId, record };
}

/**
 * Roda o treino ate o fim e resolve com o record final — a simetrica de
 * `runToCompletion` do lado da sessao, que faltava. `trainingLoop` ja tem o
 * proprio try/catch terminal, entao herda o contrato "nunca rejeita".
 */
export async function trainToCompletion(
  config: TrainingConfig,
  apiKey: string,
  opts: StartTrainingOpts = {},
): Promise<SessionRecord> {
  assertRoleSeparation(config); // IMPL-048 (ver startTraining)
  const record = newSessionRecord(config);
  await saveSession(record);
  opts.onSession?.(record.id, record);
  await trainingLoop(record, apiKey, opts);
  return record;
}

/**
 * Monta a VariationConfig de cada iteração a partir do TrainingConfig da sessão.
 * ⚠️ WHITELIST campo a campo (ver AGENTS.md): o que faltar aqui é descartado em
 * silêncio em TODA iteração e no holdout. O teste `test/runtime-guards.test.ts`
 * falha quando um campo novo de RunConfigBase não aparece nem aqui nem na lista
 * de exclusões documentadas.
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
    // IMPL-056: sem repassar, TODA iteracao (e o holdout) voltaria ao pt-BR
    // exclusivo e os avisos de idioma usariam a politica errada.
    languages: cfg.languages,
    // IMPL-063/IMPL-115: dedup semântico e modo econômico do juiz são escolhas
    // da SESSÃO — sem repassar, a iteração 0 (que gera os cenários) e todas as
    // outras voltariam ao exato/ao juiz normal em silêncio.
    scenarioDedup: cfg.scenarioDedup,
    judgeCascade: cfg.judgeCascade,
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
    // Teto por requisicao vale para toda chamada da sessao.
    maxPricePerMTok: cfg.maxPricePerMTok,
    // Contratos never-break (F2/P0.3): valem para toda reescrita da sessao.
    contracts: cfg.contracts,
    // Multi-prompt (F2/P0.4): o grupo e o fragmento-alvo atravessam as iteracoes.
    promptGroup: cfg.promptGroup,
    promptId: cfg.promptId,
    // ⚠️ `budgetUsd` NAO entra aqui DE PROPOSITO. Este whitelist normalmente
    // engole campo novo em silencio (ver AGENTS.md) e a reacao natural e
    // "corrigir" a ausencia — mas copiar o orcamento daria a CADA uma das N
    // iteracoes o teto inteiro da sessao, e o gasto total seria N x o teto.
    // Quem controla o dinheiro e o ledger da sessao, repassado por parentLedger.
    //
    // `agent` (Fase 4, §29.2): copiado por REQUERIDO. Sem isso o treino com
    // agente rodaria todas as iteracoes (e o holdout) como CHAT em silencio —
    // o bug mais caro e mais silencioso do plano. O runner='agent' dos
    // contestants e marcado pelo variator/trainer quando `agent` presente.
    agent: cfg.agent,
    // IMPL-075: o modo AUDITÁVEL (juiz + gabarito com provedor travado) vale
    // para toda iteração, a re-avaliação e o holdout — sem esta linha a flag da
    // sessão sumia na run e o artefato dizia "auditável" sem ter sido.
    auditable: cfg.auditable,
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
  opts: StartTrainingOpts = {},
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

  // Catalogo quente antes do primeiro gasto (senao o custo sai 0 e a porta de
  // orcamento acha que tudo e de graca).
  const catalogo = await listModels(apiKey).catch(() => []);

  // UM ledger raiz para a sessao inteira: o teto e da sessao, nao da iteracao.
  // Com `parentLedger` (CLI, IMPL-031) a sessao e filha dele — o teto continua
  // UM so, na raiz, e a reserva passa tambem pelo ledger da maquina.
  const ledger =
    opts.parentLedger?.fork() ??
    new BudgetLedger({
      budgetUsd: cfg.budgetUsd,
      signal: opts.signal,
      estimateCall: makeCallEstimator(catalogo, { maxPricePerMTok: cfg.maxPricePerMTok }),
    });
  const ctx: RunCtx = { signal: opts.signal, sink: ledger };
  record.budgetUsd = cfg.budgetUsd;
  // IMPL-075: modo AUDITÁVEL da sessão — juiz e gabarito com provedor travado
  // (só liga; as runs das iterações são forks e herdam, além de lerem
  // `config.auditable` repassado por variationConfigFrom).
  if (cfg.auditable) ledger.setAuditableRoles(AUDITABLE_ROLES);
  // IMPL-080 (R-08:REC-3): cache EXATO de vereditos com escopo da SESSÃO — a
  // régua (carry/original) re-julgada a cada iteração com a MESMA pergunta, o
  // MESMO gabarito e a MESMA resposta não paga o juiz de novo. Re-teste
  // amostral (~10%) obrigatório dentro do cache; área sensível desliga no
  // gateway (fail-closed). A re-avaliação limpa e o holdout rodam SEM ele
  // (`semCache`): reusar veredito ali reintroduziria a correlação com a
  // seleção que eles existem para quebrar.
  const verdictCache = opts.verdictCache === false ? undefined : (opts.verdictCache ?? new VerdictCache());
  if (verdictCache) ledger.setVerdictCache(verdictCache);
  const semCache = (): BudgetLedger => {
    const f = ledger.fork();
    f.setVerdictCache(null);
    return f;
  };
  // IMPL-065/IMPL-061: gabaritos HUMANOS (os que o usuário trouxe na config).
  // O orchestrator preenche `reference` por IA onde falta — só o índice separa.
  const humanRefs = humanReferenceIndex(cfg.customStages, cfg.scenarioSeed);
  // IMPL-066 (R-20:REC-2): capacidades do modelo sob teste DIRETO do catálogo
  // (reasoning.mandatory, degraus aceitos) — antes nenhum chamador as passava
  // e cot/fewshot eram propostas a modelos que sempre raciocinam.
  const targetModel = targetModelFor(catalogo, cfg.contestantModelId);

  // Porta de orcamento: preco desconhecido pelo pior caso (IMPL-018).
  const estIter = estimateRunCost(estimateInputFromConfig(cfg), catalogo, { unknownPrice: 'worst-case' })
    .perIteration;

  const syncLedger = (): void => {
    const snap = ledger.snapshot();
    record.totalCostUsd = snap.spentUsd;
    record.costByRole = snap.byRole;
    record.costAccuracy = snap.accuracy;
    record.costLedger = ledger.summary(); // IMPL-017: spent/committed/pending
  };

  await saveSession(record);
  emitSessionEvent({ type: 'session.started', sessionId, record });
  log(sessionId, `started: ${cfg.iterations} iteracoes (minGain=${minGain ?? 'auto max(1; 50/n)'}, gate max-T a 5%, paciencia ${patience})`);
  // web-live#5: o gate da melhor de K é exato — com poucos cenários de SELEÇÃO
  // ele matematicamente não promove (ou promove só sem nenhum empate). Avisa
  // ALTO no início, antes de gastar: a sessão roda (o usuário pode querer só
  // o diagnóstico), mas ninguém lê "0 promoções" como "o prompt já era ótimo".
  const poder = trainingPromotionPower({
    stages: plannedTrainingStages(cfg),
    holdoutRatio: cfg.holdoutRatio,
    techniques: cfg.techniqueIds?.length,
  });
  if (poder.message) log(sessionId, `AVISO (poder do gate): ${poder.message}`);

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
  // IMPL-061: conjunto rotulado (demos few-shot REAIS) da iteração 0. Os
  // cenários só congelam DEPOIS da run 0 — então aqui só entra lista EXATA da
  // config (customStages, ou seed que já cobre `stages`) e só quando NENHUMA
  // fatia de holdout vai sair dela: demo tirada de um futuro cenário de holdout
  // tornaria o teste cego visível. Da iteração 1 em diante: o treino pinado.
  const labeledIt0 = ((): LabeledScenario[] => {
    const exata = cfg.customStages?.length
      ? cfg.customStages
      : (cfg.scenarioSeed?.length ?? 0) >= cfg.stages
        ? cfg.scenarioSeed
        : undefined;
    if (!exata) return [];
    const reservaria =
      cfg.holdoutRatio === 0 ? 0 : splitHoldout(exata, cfg.holdoutRatio ?? HOLDOUT_RATIO_DEFAULT).holdout.length;
    return reservaria > 0 ? [] : trainingLabeledPool(exata, humanRefs);
  })();

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

  // IMPL-080: o cache de vereditos da sessão no log (hits/total e re-testes).
  const logVerdictCache = (): void => {
    const st = verdictCache?.stats();
    if (!st) return;
    if (st.cacheTotal === 0) return;
    log(
      sessionId,
      `cache de vereditos: ${st.cacheHits}/${st.cacheTotal} reusados, ${st.retests} re-teste(s) amostral(is), ` +
        `${st.disagreements} discordancia(s)${st.invalidations ? `, ${st.invalidations} invalidacao(oes)` : ''}`,
    );
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

  try {
    // LGPD (IMPL-041): recusa a sessão sensível fora da allowlist ANTES do
    // reescritor da iteração 0 (que roda antes da 1ª run e do pré-voo dela).
    // IMPL-040: + liga o roteamento ZDR forçado no ledger da SESSÃO (o
    // reescritor e todas as runs aninhadas, que são forks dele, herdam).
    ledger.setSensitiveRouting((await enforceRunCompliance(cfg)).sensitiveRouting);
    for (let i = 0; i < cfg.iterations; i++) {
      // Porta suave por ITERACAO: uma iteracao inteira e descartavel, e parar
      // aqui deixa o campeao da anterior intacto. Compara contra `high`, nao
      // `low` — comecar uma iteracao que provavelmente nao termina e o
      // desperdicio que este gate existe para evitar.
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
          timeoutMs: cfg.timeoutMs,
          ctx,
          maxPricePerMTok: cfg.maxPricePerMTok,
          // Contratos never-break (F2/P0.3): valem em toda iteracao.
          contracts: cfg.contracts,
          // IMPL-011: juiz do diff do contrato = 1º juiz da run (não o reescritor).
          contractJudgeModelId: cfg.judgeModelIds?.[0],
          // Verificações do contrato no MESMO raciocínio da run (juiz/competidor).
          contractJudgeReasoningLevel: reasoningLevelForRole(cfg.reasoning, 'judge'),
          contestantReasoningLevel: cfg.reasoning?.competitor,
          // Multi-prompt (F2/P0.4): evolui 1 fragmento, irmaos congelados.
          promptGroup: cfg.promptGroup,
          promptId: cfg.promptId,
          // Fase 4: sem `runner='agent'` o treino com agente rodaria como chat (§29.2).
          runner: cfg.agent ? 'agent' : undefined,
          // IMPL-066: capacidades do catálogo do modelo sob teste.
          targetModel,
          // IMPL-061: demos few-shot REAIS (vazio = a técnica decai sem inventar).
          labeledScenarios: labeledIt0,
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
              maxPricePerMTok: cfg.maxPricePerMTok,
            });
            log(sessionId, `reflexao LLM aplicada (${hint.length} chars de licoes)`);
          } catch (err) {
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
          timeoutMs: cfg.timeoutMs,
          ctx,
          maxPricePerMTok: cfg.maxPricePerMTok,
          // Contratos never-break (F2/P0.3): valem em toda iteracao.
          contracts: cfg.contracts,
          // IMPL-011: juiz do diff do contrato = 1º juiz da run (não o reescritor).
          contractJudgeModelId: cfg.judgeModelIds?.[0],
          // Verificações do contrato no MESMO raciocínio da run (juiz/competidor).
          contractJudgeReasoningLevel: reasoningLevelForRole(cfg.reasoning, 'judge'),
          contestantReasoningLevel: cfg.reasoning?.competitor,
          // Multi-prompt (F2/P0.4): evolui 1 fragmento, irmaos congelados.
          promptGroup: cfg.promptGroup,
          promptId: cfg.promptId,
          // Fase 4: mesmo runner nas iteracoes seguintes (agente quando config.agent).
          runner: cfg.agent ? 'agent' : undefined,
          // IMPL-066: capacidades do catálogo do modelo sob teste.
          targetModel,
          // IMPL-061: demos do TREINO pinado (holdout fora; só âncora humana).
          labeledScenarios: trainingLabeledPool(pinnedStages ?? [], humanRefs),
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
        signal: opts.signal,
      });

      // IMPL-004: vereditos perdidos da sessao = soma das runs (iteracoes,
      // triagem e holdout) — a mesma conta que cada run carrega.
      record.failureCountByRole = mergeFailureCounts(record.failureCountByRole, runRec.failureCountByRole);

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
      // O ledger e a fonte de verdade do gasto (soma todos os papeis de todas
      // as runs); somar `runRec.totalCostUsd` aqui contaria duas vezes.
      // IMPL-060: guarda a run por id — o dossiê de lições de cada membro do
      // pool vem da run DELE (lições da própria run da variante).
      runsById.set(runRec.id, runRec);
      syncLedger();

      // A run filha parou por orcamento/cancelamento => a sessao para tambem.
      if (runRec.status === 'aborted' && runRec.stoppedReason) {
        record.budgetExhausted = runRec.stoppedReason === 'budget';
        record.stoppedReason = runRec.stoppedReason;
        record.stoppedAtPhase = runRec.stoppedAtPhase;
        record.stoppedAtIteration = i;
        await saveSession(record);
        break;
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

      // web-code#1: a SELEÇÃO nunca vê a fatia de holdout. A run da iteração 0
      // cobriu todos os cenários (é nela que eles nascem); daqui em diante o
      // gate, a re-avaliação, as medalhas, o pool e as lições da próxima
      // iteração leem só as etapas de TREINO — senão o campeão seria escolhido
      // em parte nos mesmos cenários que o gate final depois "valida". Só na
      // iteração 0: as seguintes já rodam pinadas no treino (e o orchestrator
      // clona as specs pinadas — a identidade de objeto só vale aqui).
      // IMPL-061 — leave-demos-out: a pergunta que algum prompt da run carrega
      // como demo (bloco <exemplos_reais>) sai da SELEÇÃO para todos (o prompt
      // a acertaria de graça). O holdout nunca é fonte de demo; por defesa, se
      // uma demo coincidir com ele, a pergunta sai também do teste cego.
      const demoQs = demoQuestionsOf(runRec.contestants.map((c) => c.systemPrompt));
      if (demoQs.size && holdoutStages.some((s) => demoQs.has(questionKey(s.question)))) {
        holdoutStages = holdoutStages.filter((s) => !demoQs.has(questionKey(s.question)));
        log(sessionId, `holdout: pergunta(s) usada(s) como demo removida(s) do teste cego (${holdoutStages.length} restam)`);
      }
      const visaoTreino = i === 0 && holdoutStages.length > 0 ? trainOnlyView(runRec, pinnedStages ?? []) : runRec;
      const selRun = demoQs.size
        ? selectionView(visaoTreino, (spec) => !demoQs.has(questionKey((spec as StageSpec).question)))
        : visaoTreino;
      if (demoQs.size) {
        log(sessionId, `few-shot: ${demoQs.size} cenario(s) usados como demo fora da selecao desta iteracao (leave-demos-out)`);
      }
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
          // IMPL-067: campeã que cola span ≥ 8 tokens de cenário/gabarito/
          // explicação do juiz NÃO é promovida; o containment vai no gate.
          contamination: contaminationInputFromRun(selRun, controlId),
          // IMPL-069: nova violação em âncora crítica (adversarial) = fora da
          // disputa antes da utilidade (segurança → utilidade).
          safety: safetyInputFromRun(selRun),
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
          // IMPL-061: cenário usado como demo não re-avalia (seria acerto de graça).
          trainStages: (pinnedStages ?? []).filter((s) => !demoQs.has(questionKey(s.question))),
          // IMPL-080: re-avaliação LIMPA = vereditos novos (sem o cache da sessão).
          ledger: semCache(),
          signal: opts.signal,
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
      const medalRow = computeMedals(selRun).find((r) => r.contestantId === championIdInLastRun);
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

      // IMPL-013: a re-avaliação parou por orçamento/cancelamento → a sessão
      // para também (o candidato NÃO foi promovido: faltou a evidência limpa).
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
      // O holdout e uma run extra. Sem orcamento para ela o campeao fica sem
      // CONFIRMACAO contra sobreajuste — e isso precisa aparecer no resultado,
      // nao sumir. Ver `holdoutSkipped` (IMPL-050: a palavra "validado" so
      // aparece com holdout forte e rodado — ver `holdoutConfirmationText`).
      const estHoldout =
        holdoutStages.length > 0 ? estIter * (holdoutStages.length / Math.max(1, cfg.stages)) : 0;
      if (record.stoppedReason || (estHoldout > 0 && !ledger.canAfford(estHoldout))) {
        // Só há o que "pular" se havia fatia de holdout reservada — ou se a
        // sessão parou antes de os cenários congelarem (sem fatia decidida, o
        // motivo já foi gravado na iteração 0: piso de cenários ou desligado).
        if (holdoutPendente()) {
          markHoldoutSkip(record, record.stoppedReason === 'cancelled' ? 'cancelled' : 'budget');
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
          // IMPL-080: o teste cego mede de novo — sem o cache de vereditos.
          runLedger: semCache(),
          signal: opts.signal,
        });
        scoreCi95Pp = gateFinal.scoreCi95Pp ?? null;
      }
    } catch (err) {
      if (isControlSignal(err)) {
        record.stoppedReason =
          record.stoppedReason ?? (err.benchControl === 'budget' ? 'budget' : 'cancelled');
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
      // Gabarito gerado por IA na run não é âncora: só os da config contam.
      humanReferences: humanRefs,
    });
    log(sessionId, record.championDeclaration.message);

    // IMPL-074: pendentes lançadas DIRETO no ledger da sessão (reescritor,
    // reflexão LLM, gate de contrato) — e as das runs que seguiram pendentes —
    // conciliadas pela fatura antes da escrita terminal. Nunca lança; o
    // Cancelar pula (sair rápido é o pedido; as pendentes ficam no record).
    if (record.stoppedReason !== 'cancelled') await reconcileAtRunEnd(ledger, apiKey);
    logVerdictCache();
    syncLedger();
    record.status = record.stoppedReason ? 'aborted' : 'finished';
    record.finishedAt = nowIso();
    await saveSession(record);
    emitSessionEvent({ type: 'session.finished', sessionId, record });
    log(sessionId, `finished: custo ${record.totalCostUsd}`);
  } catch (err) {
    // IMPL-074: a conciliação da sessão vale em todo desfecho, menos o Cancelar.
    const cancelou = isControlSignal(err) && err.benchControl !== 'budget';
    if (!cancelou) await reconcileAtRunEnd(ledger, apiKey);
    syncLedger();
    if (isControlSignal(err)) {
      // Orcamento/cancelamento: sessao interrompida COM resultado parcial.
      record.status = 'aborted';
      record.stoppedReason = err.benchControl === 'budget' ? 'budget' : 'cancelled';
      if (err.benchControl === 'budget') record.budgetExhausted = true;
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
  ctxOpts: {
    ledger?: BudgetLedger;
    /** Ledger PAI da run de holdout (default `ledger`) — o trainer passa um fork sem cache de vereditos. */
    runLedger?: BudgetLedger;
    signal?: AbortSignal;
  } = {},
): Promise<{ scoreCi95Pp?: [number, number] | null }> {
  const cfg = record.config;
  const sessionId = record.id;
  const basePrompt = cfg.basePrompt ?? '';
  // IMPL-065: IC95 do score do campeão (pareado) — reportado na declaração.
  let scoreCi95Pp: [number, number] | null = null;

  let holdoutRun: RunRecord | undefined;
  // Fase 4, treino com agente e reps>1 (IMPL-054): repetição NÃO é observação
  // independente — o pareamento do holdout (e da significancia) usa o veredito
  // AGREGADO por cenário (a maioria das reps, `verdictByContestant`), nunca o
  // vetor plano (cenário × rep): reps não dobram o n do teste pareado.
  if (cfg.agent && (cfg.agent.repetitions ?? 1) > 1) {
    console.warn(
      `[train ${sessionId}] holdout pareado por cenário (reps agregadas dentro do cenário) — agent.repetitions=${cfg.agent.repetitions}`,
    );
  }
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

    // Multi-prompt: no holdout o systemPrompt efetivo e a composicao do grupo
    // (controle = base do fragmento + irmaos; campeao = fragmento vencedor).
    const comporHoldout = (fragmento: string): string =>
      cfg.promptGroup ? composePrompt(cfg.promptGroup, cfg.promptId, fragmento) : fragmento;
    const contestants: Contestant[] = [
      {
        id: 'holdout-control',
        label: 'Controle (base)',
        modelId: cfg.contestantModelId,
        systemPrompt: comporHoldout(basePrompt),
        // Fase 4: holdout com agente precisa do runner para nao medir chat (§29.2).
        ...(cfg.agent ? { runner: 'agent' as const } : {}),
      },
      {
        id: 'holdout-champion',
        label: 'Campeao (final)',
        modelId: cfg.contestantModelId,
        systemPrompt: comporHoldout(champion.systemPrompt),
        // Fase 4: mesmo runner no campeao do holdout.
        ...(cfg.agent ? { runner: 'agent' as const } : {}),
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
        parentLedger: ctxOpts.runLedger ?? ctxOpts.ledger,
        signal: ctxOpts.signal,
      },
    );
    if (ctxOpts.ledger) {
      const snap = ctxOpts.ledger.snapshot();
      record.totalCostUsd = snap.spentUsd;
      record.costByRole = snap.byRole;
      record.costLedger = ctxOpts.ledger.summary(); // IMPL-017
    } else {
      record.totalCostUsd += holdoutRun.totalCostUsd;
    }
    record.failureCountByRole = mergeFailureCounts(record.failureCountByRole, holdoutRun.failureCountByRole);
    // `inconclusive` (IMPL-004) tambem descarta o gate: holdout com vereditos
    // perdidos demais ou n efetivo < 5 nao valida campeao nenhum.
    if (holdoutRun.status !== 'finished') {
      console.warn(
        `[train ${sessionId}] run de holdout terminou com status ${holdoutRun.status}; gate descartado`,
      );
      // Holdout cortado por orçamento/cancelamento: o gate não aconteceu — o
      // campeão fica sem confirmação e o motivo sobe para a sessão (resultado
      // PARCIAL, como no espelho web); erro/inconclusiva = run sem veredito.
      if (holdoutRun.stoppedReason) {
        record.stoppedReason ??= holdoutRun.stoppedReason;
        if (holdoutRun.stoppedReason === 'budget') {
          record.budgetExhausted = true;
          record.stoppedAtPhase ??= 'holdout';
        }
        markHoldoutSkip(record, holdoutRun.stoppedReason === 'budget' ? 'budget' : 'cancelled');
      } else {
        markHoldoutSkip(record, 'run-failed');
      }
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
    // é o ÚNICO p de confirmação da sessão — e ele vem ROTULADO com a origem
    // ('holdout'); a UI e o CLI exibem o rótulo em todo relatório.
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
      // rotulado como tal em todo relatório. O p de confirmação da sessão é o
      // do holdout; sem holdout não há confirmação.
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
