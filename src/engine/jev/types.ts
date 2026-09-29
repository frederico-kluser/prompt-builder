// Modo JEV — tipos de domínio (FONTE ÚNICA, D-4). O web re-exporta pelo shim
// `web/src/engine/jev.ts`; `src/types.ts`, `web/src/engine/types.ts` e
// `web/src/api.ts` NÃO mudam (a triplicação não cresce). Só os tipos que já são
// fonte única em `src/types.ts` vêm de lá.
//
// Vocabulário:
//   - "fio" = o formato do endpoint de decisões (verificado ao vivo): perguntas
//     `noul` (sim/não → P(sim)), `choice` (1 de N opções) e `score` (régua
//     ordenada de níveis). O estado é texto/JSON; a resposta é uma distribuição.
//   - "definição de decisão" (`JevSpec`) = o "prompt" do modo: instruções +
//     rubricas + projeção do estado. É o artefato que o benchmark MEDE e o
//     treino EVOLUI.
//   - "caso" = estado + rótulo-ouro por pergunta (a verdade é o rótulo, não um juiz).

import type { CallCost, CostLedgerSummary, CostRole, ReasoningLevel, RunStatus } from '../../types.js';
import type { PiiRunReport } from '../pii.js';

// ---------------------------------------------------------------------------
// Fio (espelha a API, verificado ao vivo)
// ---------------------------------------------------------------------------

export type JevPrimitive = 'noul' | 'choice' | 'score';
export const JEV_PRIMITIVES: readonly JevPrimitive[] = ['noul', 'choice', 'score'] as const;

/** `EntryType` do fio: texto, objeto (`{what, not_for, examples}` é convenção) ou lista. */
export type NonNullCriterion = string | Record<string, unknown> | unknown[];
/** Em `choice`/`score` a rubrica de uma opção/nível pode ser `null` (autoexplicativa). */
export type CriterionEntry = NonNullCriterion | null;
export type JevInstructions = string | Record<string, unknown> | unknown[];

export interface JevNoulCriteria {
  true: NonNullCriterion;
  false: NonNullCriterion;
}

export type JevWireQuestion =
  | { type: 'noul'; instructions: JevInstructions; criteria?: JevNoulCriteria }
  | { type: 'choice'; instructions: JevInstructions; criteria: Record<string, CriterionEntry> }
  | { type: 'score'; instructions: JevInstructions; criteria: CriterionEntry[] };

export type JevState = string | Record<string, unknown> | unknown[];

export interface DecisionsRequest {
  model: string;
  state: JevState;
  questions: Record<string, JevWireQuestion>;
  session_id?: string;
}

export type JevWireAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities?: Record<string, number>; confidence?: number }
  | { type: 'score'; score: number; probabilities?: Record<string, number>; confidence?: number };

/** Um problema de contrato do fio (erro da API ou validação local). */
export interface DecisionsIssue {
  /** `edge` = validação do gateway (todos os problemas, ~50 ms); `upstream` = provedor (só o 1º); `local` = nosso. */
  layer: 'edge' | 'upstream' | 'local';
  /** Caminho no corpo (`questions.team.criteria.false`). */
  path: string;
  code?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// A definição que evolui
// ---------------------------------------------------------------------------

interface JevQuestionBase {
  /** Chave do mapa `questions` (nunca vai ao modelo: escreva a pergunta inteira em `instructions`). */
  id: string;
  instructions: JevInstructions;
  /** Pergunta de guarda (injeção etc.): invisível ao otimizador (J12). */
  guard?: boolean;
}

export type JevQuestionSpec =
  | (JevQuestionBase & { type: 'noul'; criteria?: JevNoulCriteria; keyMap?: undefined })
  | (JevQuestionBase & {
      type: 'choice';
      criteria: Record<string, CriterionEntry>;
      /**
       * Chave de opção NO FIO → rótulo CANÔNICO do ouro (J3: o nome da opção é
       * texto lido pelo modelo). Ausente = identidade.
       */
      keyMap?: Record<string, string>;
    })
  | (JevQuestionBase & { type: 'score'; criteria: CriterionEntry[]; keyMap?: undefined });

/** Projeção do caso bruto (J8): escolhe/renomeia/trunca campos — nunca altera o conteúdo. */
export interface JevStateView {
  fields: { from: string; as: string; maxChars?: number; untrusted?: boolean }[];
}

/** O que decide a banda: `confidence` da API (choice/score), certeza `max(p,1−p)` (noul) ou pTop. */
export type BandSignal = 'confidence' | 'certainty' | 'pTop';

export interface JevQuestionPolicy {
  /** Sinal ≥ auto → age sozinho. `> 1` = banda auto desligada (nenhum limiar atinge a precisão-alvo). */
  auto: number;
  /** Sinal ≥ hitl → revisão humana; abaixo → abstém. */
  hitl: number;
  signal: BandSignal;
  /** Temperatura pós-hoc (J13); ausente = 1. */
  temperature?: number;
  fittedOn?: { split: 'calib' | 'train'; n: number; resolvedModel?: string; targetPrecision?: number };
}

export type JevOperatorId =
  | 'add_examples'
  | 'add_not_for'
  | 'describe_option'
  | 'literalize'
  | 'structure_rubric'
  | 'project_state'
  | 'add_exit'
  | 'polarity_align'
  | 'rewrite_levels'
  | 'rename_key'
  | 'translate_spec'
  | 'fit_policy';

export interface JevSpec {
  /** `contentHash` de `{questions, stateView}` (política fora: ela não muda o que o modelo vê). */
  id: string;
  label: string;
  /** Ordem estável. */
  questions: JevQuestionSpec[];
  stateView?: JevStateView;
  policy?: { questions: Record<string, Partial<JevQuestionPolicy>> };
  origin?: {
    kind: 'user' | 'variant' | 'rewriter' | 'deterministic' | 'import';
    parentId?: string;
    operatorId?: JevOperatorId;
    iteration?: number;
    /** `add_examples`: ids de caso copiados para a rubrica — saem do gate (A2.6). */
    exampleCaseIds?: string[];
  };
}

// ---------------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------------

/** noul = boolean | choice = rótulo canônico | score = índice do nível (0 = mais baixo). */
export type JevExpected = boolean | string | number;
export type JevSplit = 'train' | 'calib' | 'holdout';

export interface JevCase {
  /** Explícito ou `c-<hash do estado>` — chave de PAREAMENTO entre competidores. */
  id: string;
  state: JevState;
  /** Parcial (nem todo caso rotula toda pergunta). Lista = alternativas aceitas. */
  expected: Record<string, JevExpected | JevExpected[]>;
  split?: JevSplit;
  tags?: string[];
  language?: string;
  provenance?: { origin: 'import' | 'example' | 'ai'; humanReviewed?: boolean; source?: string };
}

// ---------------------------------------------------------------------------
// Competidores e células
// ---------------------------------------------------------------------------

export type ProbabilitySource = 'native' | 'verbalized' | 'none';

export interface JevContestant {
  /** `d:<spec>@<modelo>` | `l:<spec>@<modelo>#<esforço>` — determinístico. */
  id: string;
  label: string;
  kind: 'decision' | 'llm';
  modelId: string;
  specId: string;
  isControl?: boolean;
  /** Só LLM. */
  temperature?: number;
  reasoning?: ReasoningLevel;
  batching?: 'per-question' | 'per-case';
  maxTokens?: number;
  /** decisão = native; LLM = verbalized (probabilidade dita pelo modelo, não calibrada). */
  probabilitySource: ProbabilitySource;
}

export type JevCellStatus = 'ok' | 'invalid' | 'error' | 'blocked' | 'skipped';

export interface JevCell {
  caseId: string;
  contestantId: string;
  rep: number;
  /**
   * ok = respondeu (perguntas fora do contrato vão em `invalid`: contam ERRADO);
   * invalid = TODAS as perguntas fora do contrato → erradas;
   * error/blocked = infraestrutura/gateway/LGPD → SEM NOTA (sai dos dois lados);
   * skipped = orçamento/cancelamento/spec recusada — nunca despachada.
   */
  status: JevCellStatus;
  answers?: Record<string, JevWireAnswer>;
  /** Pergunta → código do problema (resposta ausente, fora das opções, JSON inválido…). */
  invalid?: Record<string, string>;
  /** Chamadas HTTP desta célula (decisão = 1; LLM por pergunta = nº de perguntas). */
  requests?: number;
  latencyMs?: number;
  /** 1ª célula do competidor (conexão fria): fora de p50/p95. */
  cold?: boolean;
  cost?: CallCost;
  tokensIn?: number;
  tokensOut?: number;
  resolvedModel?: string;
  provider?: string;
  generationId?: string;
  skippedBy?: 'budget' | 'cancelled' | 'spec-rejected';
  error?: { kind: string; message: string; issues?: DecisionsIssue[]; httpStatus?: number };
}

/** Uma resposta pontuada (pergunta × caso × competidor, reps já agregadas). */
export interface JevScoredAnswer {
  qid: string;
  caseId: string;
  type: JevPrimitive;
  /** Rótulo canônico (choice), boolean (noul) ou nível argmax (score). */
  predicted: JevExpected | null;
  correct: boolean;
  /** Probabilidade atribuída ao rótulo certo (alternativas somam). */
  pTrue: number;
  /** Probabilidade da classe prevista (ECE top-label). */
  pTop: number;
  /** argmax == ouro (score: nível modal). */
  topCorrect: boolean;
  /** O que decide a banda. */
  signal: number;
  band: 'auto' | 'hitl' | 'abstain';
  /** Brier normalizado 0..1 (score = RPS). `null` = pergunta degenerada (1 opção/nível). */
  brier: number | null;
  logLoss: number;
  /** score: |E[ŝ] − y| em níveis. */
  absError?: number;
  /** A célula veio fora do contrato (conta errado; p uniforme). */
  invalid?: boolean;
  /** As reps discordaram do previsto. */
  flipped?: boolean;
  calibrated?: { pTrue: number; pTop: number; brier: number | null; logLoss: number; signal: number; band: JevScoredAnswer['band'] };
}

// ---------------------------------------------------------------------------
// Métricas, comparações, cascata
// ---------------------------------------------------------------------------

export interface JevBin {
  lo: number;
  hi: number;
  n: number;
  acc: number;
  conf: number;
}

export interface JevCalibratedMetrics {
  n: number;
  brier: number | null;
  brierScore: number | null;
  logLoss: number;
  ece: number;
  bands: { auto: number; hitl: number; abstain: number };
  precisionAtAuto: number | null;
  coverageAtAuto: number;
}

export interface JevMetrics {
  /** Perguntas×casos planejados (com ouro). */
  n: number;
  /** Pontuados (ok + invalid em todas as reps). */
  nScored: number;
  nInvalid: number;
  /** Sem nota (error/blocked). */
  nNoScore: number;
  accuracy: number;
  macroF1?: number;
  /** Média do Brier normalizado (sem as perguntas degeneradas). `null` = nada pontuável. */
  brier: number | null;
  /** 100·(1−brier) — a régua do gate, em p.p. */
  brierScore: number | null;
  /** Brier de PIOR caso: resposta fora do contrato = 1 (B2 — invalid não pode sair "melhor" que erro confiante). */
  brierWorstCase: number | null;
  logLoss: number;
  ece: number;
  eceAdaptive: number;
  bins: JevBin[];
  bands: { auto: number; hitl: number; abstain: number };
  precisionAtAuto: number | null;
  coverageAtAuto: number;
  /** Erros dentro da banda auto ("errado com confiança"). */
  wrongAuto: number;
  aurc: number;
  auroc: number | null;
  scoreMae?: number;
  flipRate?: number | null;
  latencyP50: number | null;
  latencyP95: number | null;
  coldLatencyMs?: number | null;
  requests: number;
  totalCostUsd: number;
  costPer1kRequests: number | null;
  costPer1kDecisions: number | null;
  costExact: boolean;
  unknownCostCalls: number;
  pendingUsd: number;
  calibrated?: JevCalibratedMetrics;
}

/** Manchete de uma métrica (evento/NDJSON — nunca estado nem rubrica). */
export interface JevMetricsHeadline {
  accuracy: number;
  macroF1: number | null;
  brierScore: number | null;
  ece: number;
  coverageAtAuto: number;
  precisionAtAuto: number | null;
  wrongAuto: number;
  p50Ms: number | null;
  p95Ms: number | null;
  costPer1kDecisions: number | null;
  costExact: boolean;
  flipRate: number | null;
}

export interface JevComparison {
  contestantId: string;
  controlId: string;
  /** Métrica primária declarada (`compare.primary`). */
  metric: 'brierScore' | 'accuracy';
  /** Δ (competidor − controle) em p.p. na métrica primária. */
  meanDiffPp: number | null;
  ci95Pp: [number, number] | null;
  /** p BILATERAL do sign-flip pareado (null com < 5 pares). */
  pValue: number | null;
  nEfetivo: number;
  /** Acurácia: McNemar exato (teste do sinal nos discordantes), BILATERAL. */
  accuracyDiffPp: number;
  mcnemarP: number | null;
  discordant: { better: number; worse: number };
}

export interface JevCascadePoint {
  threshold: number;
  accuracy: number;
  escalatedRate: number;
  costPer1kDecisions: number | null;
}

export interface JevCascade {
  decisionId: string;
  llmId: string;
  n: number;
  curve: JevCascadePoint[];
  /** Na política do competidor de decisão (banda auto fica no Jev, resto escala). */
  atDefault: JevCascadePoint;
  decisionOnly: { accuracy: number; costPer1kDecisions: number | null };
  llmOnly: { accuracy: number; costPer1kDecisions: number | null };
  /** Menor % escalado com acurácia ≥ a do LLM sozinho (null = nunca empata). */
  escalationToMatchLlm: number | null;
}

// ---------------------------------------------------------------------------
// Config resolvida (sem apiKey)
// ---------------------------------------------------------------------------

export type JevMode = 'eval' | 'compare' | 'train';

export interface JevBandDefaults {
  noul: { auto: number; hitl: number };
  choice: { auto: number; hitl: number };
  score: { auto: number; hitl: number };
}

export interface JevTrainConfig {
  iterations: number;
  variantsPerIteration: number;
  repeats: number;
  rewriterModelId?: string;
  targetQuestions: string[];
  metric: 'brier-cal' | 'accuracy';
  minGainPp: number;
  maxAccuracyDropPp: number;
  operators: JevOperatorId[];
  patience: number;
  targetPrecision: number;
  maxCostIncreasePct?: number;
}

export interface ResolvedJevConfig {
  format: 'jev-config@1';
  mode: JevMode;
  theme: string;
  language?: string;
  specs: JevSpec[];
  contestants: JevContestant[];
  cases: JevCase[];
  repeats: number;
  scoreTolerance: number;
  bands: JevBandDefaults;
  targetPrecision: number;
  /** Ajusta T + limiares no split `calib` (eval/compare). */
  fit: boolean;
  primary: 'accuracy' | 'brierScore';
  split: { holdoutRatio: number; calibrationRatio: number; seed: number; stratifyBy?: string };
  train?: JevTrainConfig;
  budgetUsd?: number;
  compliance?: { area: string; includeRessalvas: boolean };
  piiMode?: 'redact' | 'synthetic';
  allowPii?: boolean;
  specHash: string;
  datasetHash: string;
}

export type ResolvedJevConfigSnapshot = Omit<ResolvedJevConfig, 'cases' | 'specs' | 'contestants'>;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type JevStoppedReason = 'budget' | 'cancelled' | 'snapshot-drift' | 'spec-rejected' | 'patience';

export interface JevCost {
  totalUsd: number;
  pendingUsd: number;
  byRole: Partial<Record<CostRole, number>>;
  byContestant: Record<string, number>;
  byKind: { decision: number; llm: number; rewriter: number };
  ledger?: CostLedgerSummary;
}

/** Dono do processo (IMPL-030): run `running` de dono morto vira `aborted` ao carregar. */
export interface JevOwner {
  pid: number;
  host: string;
  startToken: string | null;
}

export interface JevRunRecord {
  format: 'jev-run@1';
  id: string;
  mode: JevMode;
  /** `inconclusive` já existe em RunStatus: > 10% sem nota ou < 5 pontuados numa pergunta. */
  status: RunStatus;
  theme: string;
  client: 'node' | 'browser';
  config: ResolvedJevConfigSnapshot;
  specs: JevSpec[];
  contestants: JevContestant[];
  /** Com estado: é dado do usuário (retenção LGPD vale). */
  cases: JevCase[];
  /** Perguntas efetivamente perguntadas (treino: só as-alvo). */
  questionIds: string[];
  cells: JevCell[];
  progress: { requestsPlanned: number; requestsDone: number; cellsPlanned: number; cellsDone: number; spentUsd: number };
  /** Por competidor (perguntas agregadas). */
  metrics: Record<string, JevMetrics>;
  /** competidor → pergunta. */
  byQuestion: Record<string, Record<string, JevMetrics>>;
  byType: Record<string, Partial<Record<JevPrimitive, JevMetrics>>>;
  /** competidor → pergunta → "ouro→previsto" → n. */
  confusion: Record<string, Record<string, Record<string, number>>>;
  comparisons?: JevComparison[];
  cascade?: JevCascade[];
  /** Política ajustada no `calib` (fit), por competidor → pergunta. */
  policy?: Record<string, Record<string, JevQuestionPolicy>>;
  /** Casos sem TODAS as células de TODOS os competidores (orçamento/cancelamento): fora das métricas. */
  incompleteCaseIds: string[];
  inconclusiveReasons?: string[];
  warnings: string[];
  /** Modelo pedido → snapshots vistos (mais de um = deriva). */
  resolvedModels: Record<string, string[]>;
  cost: JevCost;
  // Campos de topo compatíveis com o RunRecord (o código de status/exit os lê).
  totalCostUsd: number;
  budgetUsd?: number;
  budgetExhausted?: boolean;
  stoppedReason?: JevStoppedReason;
  /** competidor → problemas do 400 do edge (spec recusada). */
  rejected?: Record<string, DecisionsIssue[]>;
  datasetHash: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  owner?: JevOwner;
  sessionId?: string;
  iteration?: number;
  /** Campos com dado pessoal (caminho + tipos, nunca o valor) — do pré-voo. */
  piiReport?: PiiRunReport;
}

export interface JevIterationCandidate {
  specId: string;
  label: string;
  operatorId: JevOperatorId;
  status: 'evaluated' | 'rejected-local' | 'proposal-failed';
  reason?: string;
}

export interface JevIterationRecord {
  iteration: number;
  runId?: string;
  controlSpecId: string;
  candidates: JevIterationCandidate[];
  gate: {
    metric: 'brier-cal' | 'accuracy';
    controlScorePp: number | null;
    bestSpecId?: string;
    bestScorePp?: number | null;
    meanDiffPp: (number | null)[];
    pRaw: number[];
    pAdjusted: number[];
    minGainPp: number;
    accuracyDeltaPp?: number | null;
    winnersCurseInflationPp: number;
    /** Casos fora do gate por terem virado exemplo numa rubrica (A2.6). */
    excludedExampleCaseIds: string[];
    nPairs: number;
    decision: 'promoted' | 'held' | 'inconclusive' | 'baseline' | 'stopped';
    heldBy?: string[];
  };
  costUsd: number;
  resolvedModel?: string;
}

export interface JevHoldout {
  runId: string;
  n: number;
  strength: 'holdout' | 'confirmacao-fraca' | 'nenhum';
  comparison: JevComparison | null;
  original: JevMetrics | null;
  champion: JevMetrics | null;
  regressed: boolean;
  text: string;
}

export interface JevSessionRecord {
  format: 'jev-session@1';
  id: string;
  status: RunStatus;
  theme: string;
  config: ResolvedJevConfigSnapshot;
  modelId: string;
  originalSpec: JevSpec;
  championSpec: JevSpec;
  iterations: JevIterationRecord[];
  runIds: string[];
  /** Do fit final (campeã) no `calib`. */
  policy: Record<string, JevQuestionPolicy>;
  originalPolicy?: Record<string, JevQuestionPolicy>;
  holdout?: JevHoldout;
  convergedAtIteration?: number;
  stoppedReason?: JevStoppedReason;
  cost: JevCost;
  totalCostUsd: number;
  budgetUsd?: number;
  budgetExhausted?: boolean;
  resolvedModels: string[];
  warnings: string[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
  owner?: JevOwner;
}

// ---------------------------------------------------------------------------
// Eventos (enxutos: nunca estado, rubrica nem record inteiro)
// ---------------------------------------------------------------------------

export type JevEvent =
  | {
      type: 'jev.run.started';
      runId: string;
      mode: JevMode;
      cases: number;
      contestants: string[];
      requestsPlanned: number;
    }
  | {
      type: 'jev.cell.done';
      runId: string;
      caseId: string;
      contestantId: string;
      rep: number;
      status: JevCellStatus;
      correct: Record<string, boolean>;
      latencyMs?: number;
      costUsd?: number;
    }
  | { type: 'jev.progress'; runId: string; done: number; total: number; spentUsd: number; pendingUsd: number }
  | { type: 'jev.contestant.done'; runId: string; contestantId: string; metrics: JevMetricsHeadline }
  | { type: 'jev.run.finished'; runId: string; status: RunStatus; stoppedReason?: string }
  | {
      type: 'jev.iteration.gated';
      sessionId: string;
      iteration: number;
      decision: string;
      gainPp: number | null;
      pAdjusted: number | null;
      costUsd: number;
    }
  | { type: 'jev.session.finished'; sessionId: string; status: RunStatus; verdict: string }
  | { type: 'jev.budget.exhausted'; spentUsd: number; budgetUsd: number };

/** Um problema de lint (spec/casos/dataset). Nível `error` impede o gasto. */
export interface JevLintIssue {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  questionId?: string;
  path?: string;
  /** Linha/coluna (datasets). */
  line?: number;
  column?: number;
  fix?: string;
}
