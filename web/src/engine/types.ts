// Shape do rotulo esperado e da validacao do gabarito vem do motor
// compartilhado (fonte unica).
import type { ExpectedSpec, ReferenceValidation } from '../../../src/engine/groundTruth.js';
import type { PromptContracts } from '../../../src/engine/contracts.js';
import type { PromptGroup } from '../../../src/engine/promptGroup.js';
import type { PiiRunReport } from '../../../src/engine/pii.js';
import type {
  CallFinishSignals,
  CostEntry,
  CostRole,
  FinishSignalCounts,
  JudgeCutKind,
  PricingTier,
  RunPhase,
  StageIncompleteReason,
  StoredSignificance,
  TokenPrice,
  TruncationSignal,
} from '../../../src/types.js';
import type { ModelLifecycleSnapshot } from '../../../src/engine/modelLifecycle.js';

// Ciclo de vida de modelos (IMPL-019): fonte única em src/engine/modelLifecycle.ts.
export type {
  ModelLifecycleAlert,
  ModelLifecycleEntry,
  ModelLifecycleSnapshot,
  ModelUsageRole,
  RemovalAction,
  SuccessorSuggestion,
} from '../../../src/engine/modelLifecycle.js';

// Contabilidade de custo: FONTE ÚNICA em src/types.ts (IMPL-021). Desde que os
// módulos de papel e o gateway viraram shims, o web usa o MESMO ledger
// (src/budget.ts) — duplicar estes tipos aqui só abriria espaço p/ divergir.
export type {
  CallCost,
  CostEntry,
  CostLedgerSummary,
  CostRole,
  CostSink,
  CostSource,
  PendingReason,
  PricingTier,
  Reservation,
  ReservationStatus,
  RunCtx,
  RunPhase,
  TokenPrice,
} from '../../../src/types.js';
export { COST_ROLES } from '../../../src/types.js';
// Sinais de fim / truncamento (IMPL-014): fonte única em src/types.ts — o
// gateway e o competidor já são shims, os dois motores gravam o MESMO formato.
export type {
  CallFinishSignals,
  FinishSignalCounts,
  JudgeCutKind,
  StageIncompleteReason,
  TruncationSignal,
} from '../../../src/types.js';

// Significância pareada: FONTE ÚNICA em src/types.ts (IMPL-001). O cálculo já é
// shim (src/stats.ts), então o shape que ele devolve também não se duplica.
export type {
  PairedSignificance,
  SignificanceMethod,
  StoredSignificance,
} from '../../../src/types.js';
// Pareamento honesto (IMPL-005): FONTE ÚNICA em src/types.ts, como a significância.
import type { IterationGate, MultiplicityMethod, RunCompleteness, SessionPairing } from '../../../src/types.js';
export type {
  BestOfKEntry,
  BestOfKTest,
  GateConclusion,
  GateHoldReason,
  IterationGate,
  MultiplicityMethod,
  ObservationCoverage,
  PairCoverage,
  PairSensitivity,
  PromotionReeval,
  RunCompleteness,
  SensitivityCase,
  SessionPairing,
  SignificanceConclusion,
} from '../../../src/types.js';

// Integridade do veredito (IMPL-004): FONTE ÚNICA em src/types.ts — os juízes
// (refJudge/judge) já são shims e devolvem estes tipos; o helper de status
// terminal é runtime e tem de ser o MESMO nos dois motores.
export type {
  DuelFailure,
  DuelOrderResult,
  VerdictError,
  VerdictErrorKind,
  VerdictIntegrity,
  VerdictSource,
} from '../../../src/types.js';
// Confiança do veredito + componentes do contrato + fonte das amostras de
// verbosidade (IMPL-047/049/052): FONTE ÚNICA em src/types.ts, como acima.
export type {
  JudgeConfidence,
  JudgeContractComponents,
  VerdictSampleSource,
} from '../../../src/types.js';
// Fila `needs-human-review` + voto de cada juiz + diagnóstico de verbosidade em
// camadas (IMPL-055/057/053): FONTE ÚNICA em src/types.ts, como acima — os
// juízes (refJudge/judgeCalibration) já são shim/compartilhados e devolvem
// estes shapes.
export type {
  HumanReviewItem,
  HumanReviewReason,
  JudgeCallFinish,
  JudgeVote,
  VerbosityDiag,
} from '../../../src/types.js';
export { TERMINAL_RUN_STATUSES, isTerminalRunStatus } from '../../../src/types.js';
import type {
  DuelFailure,
  DuelOrderResult,
  HumanReviewItem,
  JudgeCallFinish,
  JudgeConfidence,
  JudgeContractComponents,
  JudgeVote,
  VerdictError,
  VerdictIntegrity,
  VerdictSampleSource,
  VerdictSource,
  VerbosityDiag,
} from '../../../src/types.js';

export interface OpenRouterModelPricing {
  /** USD por token. `null` = desconhecido ("-1"/roteador, ausente, inválido) — ver src/types.ts. */
  prompt: TokenPrice;
  completion: TokenPrice;
  /** Faixas de preço por tamanho de prompt (`pricing.overrides` do catálogo). */
  overrides?: PricingTier[];
}

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength?: number;
  pricing: OpenRouterModelPricing;
  /**
   * Parametros de amostragem que o modelo aceita (campo `supported_parameters`
   * do OpenRouter). Fonte de verdade para enviar `temperature`/`seed` so a quem
   * suporta — reasoning models (gpt-5*, serie o*) NAO listam `temperature` e
   * respondem vazio (HTTP 400) se ela for enviada. Ausente = desconhecido;
   * `[]` = declara que não aceita nenhum (também o fail-closed de campo malformado).
   */
  supportedParameters?: string[];
  /** Metadados de raciocinio declarados pelo modelo (campo `reasoning` de /models). */
  reasoning?: ModelReasoningMeta;
  /**
   * Ciclo de vida (IMPL-019, campos `canonical_slug`/`expiration_date`/
   * `alias_target`/`created` de /models): o snapshot datado por tras do id, a
   * data de deprecacao do endpoint (AAAA-MM-DD; null = catalogo diz "sem data")
   * e, para aliases `~…-latest`, o id para o qual apontam HOJE.
   */
  canonicalSlug?: string;
  expirationDate?: string | null;
  aliasTarget?: string;
  created?: number;
  raw?: unknown;
}

/**
 * O que o modelo declara sobre raciocinio em `GET /models`. E a fonte de verdade
 * para saber QUAIS degraus de esforco ele aceita — sem isto so daria para chutar
 * (medido: 20 conjuntos distintos de `supported_efforts` no catalogo).
 */
export interface ModelReasoningMeta {
  /** true = raciocinio nao pode ser desligado (o degrau 'none' e rejeitado). */
  mandatory?: boolean;
  /** Raciocinio ja vem ligado por default neste modelo. */
  defaultEnabled?: boolean;
  /** Degraus permitidos, em ordem decrescente. AUSENTE = sem restricao. */
  supportedEfforts?: string[];
  /** Degrau usado quando nao mandamos `effort`. */
  defaultEffort?: string;
  /** Aceita budget por `reasoning.max_tokens` (raro: 7 de 214 modelos). */
  supportsMaxTokens?: boolean;
}

// ----------------------------------------------------------------------------
// Modos de run e o conceito de "contestant"
// ----------------------------------------------------------------------------

export type RunMode = 'compare' | 'variation' | 'training';

/**
 * Um competidor genérico. No modo `compare`, cada contestant e um modelo
 * distinto (id === modelId, sem systemPrompt). Nos modos `variation`/`training`,
 * todos os contestants compartilham o MESMO modelId e diferem pelo `systemPrompt`
 * (a variacao do prompt sendo testada).
 */
export interface Contestant {
  /** Chave estavel. compare: === modelId. variation/training: "v0".."vN" | "original". */
  id: string;
  /** Rotulo humano: nome da tecnica, "Original (controle)", ou o proprio modelId (compare). */
  label: string;
  /** Modelo real OpenRouter (usado para preco/getModel). */
  modelId: string;
  /** Variante: vira o system message (ausente => sem system, compare). O productContext vai sempre no user, como dado (buildCaseInput). */
  systemPrompt?: string;
  /** Tecnica da biblioteca que gerou esta variante (ausente = verbatim/original). */
  techniqueId?: string;
  /** true = o prompt base do usuario, rodado como controle. */
  isOriginal?: boolean;
  /** Lineage de treino: contestant vencedor de onde esta variante derivou. */
  parentContestantId?: string;
  /** Multi-prompt (F2/P0.4): texto do fragmento evoluido (systemPrompt = composicao). */
  promptFragment?: string;
  /** Override de temperatura deste contestant (compare-llms). Default 0. */
  temperature?: number;
  /** Nivel de reasoning deste contestant (compare-llms; identidade = tripla modelo/temp/reasoning). */
  reasoningLevel?: ReasoningLevel;
}

/** Variacao de prompt fornecida manualmente (toggle de otimizacao desligado). */
export interface ManualVariant {
  label: string;
  systemPrompt: string;
}

/** Tecnica de variacao de prompt da biblioteca curada (`src/techniques.ts`). */
export interface PromptTechnique {
  id: string;
  name: string;
  /** Nivel de confianca da evidencia (revisao sistematica): alta/media/baixa. Opcional no acervo interno; sempre preenchido por listTechniques(). */
  confidence?: 'alta' | 'media' | 'baixa';
  /** Por que a tecnica ajuda. */
  good: string;
  /** Quando a tecnica atrapalha. */
  bad: string;
  /** Meta-instrucao entregue ao optimizer (NAO exposta ao front). */
  metaInstruction: string;
}
/** Tecnica sem o meta-prompt — o que `GET /techniques` expoe. */
export type PublicTechnique = Omit<PromptTechnique, 'metaInstruction'>;

// ----------------------------------------------------------------------------
// Reasoning (esforco de raciocinio por papel)
// ----------------------------------------------------------------------------

/**
 * Nivel de esforco de raciocinio. Espelha a escala de `effort` do OpenRouter
 * (none < minimal < low < medium < high < xhigh < max), com `off` no lugar de
 * 'none'. Cada modelo aceita so um SUBCONJUNTO destes degraus — ver
 * `ModelReasoningMeta.supportedEfforts` e `fitEffort` em reasoning.ts.
 */
export type ReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Reasoning por papel da run (secao avancada do assistente); papel ausente = desligado. */
export interface ReasoningConfig {
  competitor?: ReasoningLevel;
  judge?: ReasoningLevel;
  /** IMPL-079: esforço do DUELO das finais (default `low`; ausente → `judge`). */
  duel?: ReasoningLevel;
  /** IMPL-079: esforço do GABARITO/referência (default `high`; ausente → `judge`). */
  gab?: ReasoningLevel;
  rewriter?: ReasoningLevel;
  datagen?: ReasoningLevel;
}

// ----------------------------------------------------------------------------
// Config da run (uniao discriminada por `mode`)
// ----------------------------------------------------------------------------

export interface RunConfigBase {
  theme: string;
  stages: number;
  datagenModelId: string;
  /** Um ou mais juizes — rodam em paralelo (gateados pelo limitador global). */
  judgeModelIds: string[];
  concurrency?: number;
  timeoutMs?: number;
  /** Cap absoluto de max_tokens da resposta dos competidores. */
  maxOutputTokens?: number;
  /** Liga/desliga a geracao automatica de variacoes por LLM (variation/training). */
  promptOptimization?: boolean;
  /** Meta-modelo que gera variacoes e analisa no treino. Default = datagenModelId. */
  optimizerModelId?: string;
  /** Passes do juiz: 2 = avalia em duas ordens e media (anti-vies de posicao). Default 1. */
  judgePasses?: 1 | 2;
  /**
   * Perfil de conformidade LGPD escolhido no assistente (passo Tema). Em area
   * SENSIVEL e fail-closed: pre-voo contra a allowlist ZDR (IMPL-041) e TODA
   * requisicao sai com `provider { zdr, data_collection:'deny', only,
   * allow_fallbacks:false }` (IMPL-040, src/engine/sensitiveRouting.ts). A area
   * "geral" segue consultiva. Ausente = "livre" (sem filtro de conformidade).
   */
  compliance?: { area: string; includeRessalvas: boolean };
  /**
   * Dado pessoal (LGPD, IMPL-042). A cascata PT-BR roda em TODA chamada de LLM
   * nos dois modos (identificadores estruturados saem pseudonimizados; nomes
   * em texto livre NAO sao cobertos). 'synthetic' ("so sintetico") alem disso
   * RECUSA a run no pre-voo se algum campo fornecido pelo usuario tiver dado
   * pessoal de aparencia real. Ausente = 'redact'.
   */
  piiMode?: 'redact' | 'synthetic';
  /**
   * O usuario REVISOU o dado pessoal de aparencia real apontado no config e
   * confirmou que a run pode seguir no modo 'redact' (identificadores
   * pseudonimizados no envio; nomes NAO cobertos). Sem ele a run e recusada
   * no pre-voo nomeando o campo. Ignorado no 'synthetic' e no modo agente.
   */
  allowPii?: boolean;
  /**
   * Etapas fornecidas pelo usuario (JSON), substituindo o datagen automatico.
   * Quando presente e nao-vazio, o pipeline PULA a geracao de cenarios e usa
   * estas specs verbatim; `stages` passa a valer o tamanho desta lista. Cada
   * etapa traz a pergunta, o contexto de produto e (opcional) a `rubric` que
   * ancora os juizes. Vale para todos os modos; no treino, vira o benchmark
   * pinado (mesmas etapas em todas as iteracoes).
   */
  customStages?: StageSpec[];
  /** Reasoning (esforco) por papel: competitor/judge/rewriter/datagen. */
  reasoning?: ReasoningConfig;
  /** Modelo que gera os gabaritos (respostas de referencia). Default = 1o juiz. */
  referenceModelId?: string;
  /** Julgamento por referencia (pointwise vs gabarito + duelos). Default: true em variation/training, false em compare. */
  referenceJudging?: boolean;
  /** Descricao detalhada do que testar — guia o datagen na geracao de cenarios. */
  scenarioBrief?: string;
  /** Cenarios importados de pacote JSON (seed); o datagen complementa ate `stages`. */
  scenarioSeed?: StageSpec[];
  /**
   * No de FINALISTAS que disputam os duelos depois do julgamento pointwise.
   * Os melhores por judge-score medio (todos os cenarios) duelam entre si em
   * cada cenario. 0 = sem duelos. Default 3.
   */
  finalists?: number;
  /** Liga/desliga a fase de finais (duelos). Default: true quando ha gabarito. */
  duels?: boolean;
  /**
   * Contratos NEVER-BREAK do prompt base (F2/P0.3): invariantes, placeholders
   * verbatim e piso de comprimento — o pos-rewriter rejeita o que quebrar.
   */
  contracts?: PromptContracts;
  /**
   * Teto de gasto em USD para a run (ou para a SESSAO inteira, em training).
   * Ausente = sem limite. Espelho de src/types.ts (IMPL-020: a SPA passou a
   * respeitar o teto — antes o campo nem existia aqui).
   *
   * ⚠️ `variationConfigFrom` (trainer.ts) NAO copia este campo de proposito:
   * cada uma das N iteracoes receberia o teto inteiro da sessao. O ledger da
   * sessao (parentLedger) e quem controla.
   */
  budgetUsd?: number;
}

/** Campos comuns aos modos de 1 LLM (variation/training). */
export interface SingleModelFields {
  /** O unico modelo sob teste (eixo contestant). */
  contestantModelId: string;
  /** Prompt base opcional; ausente => variacoes partem do tema. */
  basePrompt?: string;
  /** Tecnicas selecionadas (quando promptOptimization=true). */
  techniqueIds?: string[];
  /** Variacoes verbatim (quando promptOptimization=false). */
  manualVariants?: ManualVariant[];
  /** Temperatura aplicada ao modelo sob teste em TODAS as variantes. Ausente = 0. */
  temperature?: number;
  /**
   * Grupo multi-prompt (F2/P0.4, coordinate ascent): evolucao de UM fragmento
   * por sessao, irmaos congelados (`src/engine/promptGroup.ts`).
   */
  promptGroup?: PromptGroup;
  /** Fragmento do grupo que esta sessao/run evolui. Obrigatorio se o grupo tem >1. */
  promptId?: string;
}

export interface CompareConfig extends RunConfigBase {
  mode: 'compare';
  /**
   * Repeticoes por cenario (1–3, F2 §7.9): cada cenario roda N× para medir a
   * INSTABILIDADE estocastica do modelo — a variancia real so aparece com
   * repeticao, sobretudo com poucos cenarios. So no compare; cada copia vira
   * uma observacao independente no judge-score/placar.
   */
  repeats?: 1 | 2 | 3;
  competitorModelIds: string[];
  /** compare-llms: variantes de config {modelo, temperatura, reasoning} no eixo de contestants (identidade = tripla). */
  competitorConfigs?: { modelId: string; temperature?: number; reasoningLevel?: ReasoningLevel }[];
}
export interface VariationConfig extends RunConfigBase, SingleModelFields {
  mode: 'variation';
}
export interface TrainingConfig extends RunConfigBase, SingleModelFields {
  mode: 'training';
  /** Numero fixo de iteracoes. */
  iterations: number;
  /**
   * Margem PRATICA minima de ganho (pp) sobre o campeao para promover; sem ganho
   * = convergiu. Ausente = max(1; 50/n), n = pares com veredito nos dois lados
   * (meia granularidade — IMPL-002). Alem da margem, o gate exige p ajustado
   * (max-T sobre as K variantes) <= 0,05.
   */
  minGain?: number;
  /** Fracao de cenarios reservada p/ holdout (clamp [0, 0.5]). Default 0.3 (IMPL-050). */
  holdoutRatio?: number;
  /** Paciencia do laco (IMPL-051): iteracoes seguidas sem promocao antes de convergir. Default 2. */
  patience?: number;
  /** Reflection estilo GEPA: variantes recebem licoes das falhas do campeao. */
  feedbackDriven?: boolean;
  /** Como as licoes GEPA sao produzidas: 'deterministic' (default, zero custo) | 'llm' (meta-modelo) | 'off'. */
  reflection?: 'off' | 'deterministic' | 'llm';
  /**
   * Tamanho do POOL Pareto (F4.1, GEPA): >1 mantém uma população de prompts
   * (pais diversos por dominância de fatia) em vez do campeão único elitista.
   * 0/ausente = comportamento clássico (1).
   * IMPL-062: com FATIA ÚNICA o pool não se forma — o treino roda como
   * elitismo EXPLÍCITO (sem estado de pool/paretoFront), porque com fatia única
   * a dominância de Pareto vira comparação de média com overhead de estado.
   */
  paretoPool?: number;
  /**
   * IMPL-062 (R-02b:REC-4): amostragem de pai ∝ COBERTURA (matriz candidato ×
   * cenário — quantas instâncias cada candidato vence) em vez do rodízio pelo
   * menos usado. Só atua com fatias múltiplas e n ≥ 20 (abaixo disso o front é
   * ruído — a ablação do GEPA foi com 111–300 instâncias).
   */
  paretoCoverageSampling?: boolean;
  /**
   * IMPL-060 (R-02b:REC-1): teto do DOSSIÊ de lições (GEPA) em TOKENS
   * (aprox. chars/4). Default 4000. A truncagem é explícita: reportada em log
   * e marcada no payload — nenhuma falha é descartada em silêncio.
   */
  maxLessonTokens?: number;
  /**
   * IMPL-060: inclui o GABARITO do cenário no dossiê de lições. Default OFF —
   * mostrar o gabarito ao reescritor abre risco de exploração do juiz
   * (aguarda R-03b).
   */
  lessonsIncludeReference?: boolean;
  /**
   * IMPL-065 (R-05:REC-4): piso de ITENS CURADOS (âncora humana) para declarar
   * campeão. Default 20 (proposta sem fonte — calibrar). Abaixo do piso o
   * treino roda como bootstrap e NÃO declara campeão (ver
   * `SessionRecord.championDeclaration`).
   */
  minCuratedItems?: number;
  // `halving` (F4.3) foi REMOVIDO no IMPL-012 (R-02b:REC-3, H4/H5/H6 — ver o
  // comentário no laço de `trainer.ts`). Records antigos que ainda o tragam
  // são lidos normalmente; o campo é ignorado.
}
export type RunConfig = CompareConfig | VariationConfig | TrainingConfig;

// ----------------------------------------------------------------------------

export interface StageSpec {
  question: string;
  productContext: string;
  maxTokens: number;
  /**
   * Criterio de corretude desta etapa: o que uma boa resposta DEVE conter/fazer
   * e o que a tornaria inaceitavel. Quando presente, e injetado no juiz como
   * RUBRICA ANCORADA (estilo G-Eval) — ancora a nocao de "correto" num criterio
   * explicito em vez de deixar o juiz inventar o seu, mitigando reward-hacking.
   * Em etapas fornecidas pelo usuario (customStages) e a "explicacao do que a
   * etapa resolve"; o datagen tambem pode gera-la automaticamente.
   */
  rubric?: string;
  /** Gabarito: resposta de referencia ideal (juiz pointwise + duelos). */
  reference?: string;
  /**
   * Validacao do GABARITO (IMPL-055): verificacao dirigida pela rubrica +
   * 2º gabarito de familia distinta (condicionado) + itens `needs-human-review`.
   * Preenchida por `validateGeneratedReferences` (`src/gabarito.ts`); a fila
   * agregada vive em `RunRecord.needsHumanReview`.
   */
  referenceValidation?: ReferenceValidation;
  /**
   * Rotulo ESPERADO (ground-truth): veredito deterministico sem juiz LLM
   * (`src/engine/groundTruth.ts`, fonte unica do shape).
   */
  expected?: ExpectedSpec;
  /**
   * Todos os rotulos validos da etapa (IMPL-003). Obrigatorio com `expected`
   * curto (<=5 palavras) — regra unica em `labelSetIssue` (src/engine/groundTruth.ts).
   */
  labelSet?: string[];
  /** Proveniencia da etapa: gerada pela IA ou importada de pacote JSON. */
  origin?: 'ai' | 'import';
  /**
   * Metadados de CURRICULO (F1/F4.1): tier curatorial e dimensoes medidas.
   * Sobrevivem da biblioteca (`toStageSpec`) e alimentam a selecao Pareto por
   * fatia — sem eles a populacao nao sabe onde cada prompt e especialista.
   * O datagen v2 (IMPL-064) tambem os emite — antes o zod os stripava em
   * silencio e todo item gerado caia na fatia 'geral'.
   */
  tier?: string;
  dimensionTags?: string[];
  /**
   * Idioma do cenario (IMPL-056 / R-03a:REC-6). Default 'pt-BR': o produto e
   * monolinguue e misturar idiomas e confundidor no veredito. Variado so via
   * opt-in (`languages`); cenario fora da politica da run vira warning.
   */
  language?: string;
  /** Quem pergunta (persona do usuario) — realismo/curadoria (IMPL-064). */
  persona?: string;
  /**
   * Estimativa de dificuldade (1-5) emitida pelo gerador (IMPL-064).
   * SINAL DE CURADORIA, NUNCA rotulo: a validacao humana decide.
   */
  difficultyEstimate?: number;
  /** Grupo de invariancia (pares cuja saida esperada nao pode mudar) — IMPL-064. */
  invarianceGroup?: string;
  /**
   * Metadados ADVERSARIAIS (IMPL-068): categoria (uma das 6 minimas), rotulo
   * de turno ('single-turn' = ASR@1, limite inferior) e hash do system
   * prompt-base que condicionou a geracao (amarracao item↔politica).
   */
  adversarialCategory?: string;
  turnLabel?: string;
  basePromptHash?: string;
}

/**
 * Desfecho de UMA resposta (IMPL-010): `ok`; `blocked` = moderacao/guardrail
 * ou filtro de conteudo (sem veredito para o prompt); `refused` = o modelo
 * recusou (julgavel); `error` = infraestrutura. Espelho de src/types.ts.
 */
export type CompetitorStatus = 'ok' | 'error' | 'blocked' | 'refused';

/** Contagens dos desfechos nao-ok dos competidores de uma run (IMPL-010). */
export interface CompetitorOutcomeCounts {
  blocked: number;
  refused: number;
  error: number;
}

export interface CompetitorResponse {
  /** Chave universal. compare: === modelId. */
  contestantId: string;
  modelId: string;
  text: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  status: CompetitorStatus;
  /** Motivo do `error` (infra) ou do `blocked` (mensagem de moderacao — nunca "key invalida"). */
  errorMsg?: string;
  /** `finish_reason` normalizado pelo OpenRouter (ex.: stop, length, content_filter). */
  finishReason?: string;
  /** `native_finish_reason` cru do provedor (ex.: SAFETY, end_turn). */
  nativeFinishReason?: string;
  /** Resposta final cortada no teto mesmo após o retry x2 (IMPL-014) — etapa fica `incomplete`. */
  truncated?: boolean;
  /** `reasoning_tokens` da tentativa final. */
  reasoningTokens?: number;
  /** `max_tokens` enviado na tentativa final (dobra no retry por truncamento). */
  maxTokens?: number;
  /** Sinais de truncamento observados na tentativa final. */
  truncationSignals?: TruncationSignal[];
  /** true = a 1a tentativa truncou; `costUsd` soma as duas tentativas. */
  truncationRetried?: boolean;
  /** Sinais da 1a tentativa (a truncada), quando houve retry por truncamento. */
  firstAttempt?: CallFinishSignals;
}

/**
 * Veredito TERNARIO de uma etapa: a resposta resolve a tarefa, resolve
 * parcialmente, ou nao resolve. Mais robusto que o binario como portao de
 * qualidade (G-Eval / score absoluto como filtro). Ordem implicita: nao < parcial < resolve.
 */
export type Verdict = 'resolve' | 'parcial' | 'nao';

/** Veredito COMPACTO de UM juiz para UMA resposta: justificativa + veredito ternario. */
export interface JudgeVerdict {
  contestantId: string;
  /** Veredito ternario: resolve / parcial / nao. */
  verdict: Verdict;
  /**
   * Justificativa do juiz — gerada ANTES da classificacao (estilo G-Eval:
   * raciocinio primeiro, rotulo depois). Curta (1-2 frases).
   */
  motivo: string;
  /** @deprecated compat: records antigos guardavam so o binario. Derive de `verdict`. */
  acceptable?: boolean;
  /** Canário do veredito (IMPL-006) — espelho de src/types.ts. */
  canary?: string;
}

/** Resultado compacto de UM juiz numa etapa: ranking + vereditos. */
export interface SingleJudgeResult {
  judgeModelId: string;
  /** Melhor -> pior, por contestantId (deste juiz). */
  rankedContestantIds: string[];
  /** Aceitabilidade por resposta (deste juiz). */
  verdicts: JudgeVerdict[];
  /** letra -> contestantId desta avaliacao (cosmetico p/ a UI "(era X)"). */
  blindMap: Record<string, string>;
  inconclusive?: boolean;
  /** Sinais de fim de CADA passagem deste juiz (IMPL-014) — espelho de src/types.ts. */
  passFinish?: JudgeCallFinish[];
}

/**
 * Resultado do estagio de julgamento (UM ou MAIS juizes). Compacto: cada juiz
 * devolve ranking + aceitavel/motivo por resposta. Agregamos um CONSENSO de
 * ranking (posicao media) e a aceitabilidade por MAIORIA dos juizes; guardamos
 * tambem o resultado individual de cada juiz (placar aditivo + justificativas).
 */
export interface JudgeResult {
  /** Consenso entre juizes (posicao media): melhor -> pior. Placar/heatmap/CSV usam isto. */
  rankedContestantIds: string[];
  /**
   * Aceitavel por contestant (compat/placar): MAIORIA dos juizes; derivado do
   * ternario (resolve|parcial => aceitavel). Resposta vazia = false; contestant
   * SEM veredito (erro de infra, bloqueio, juiz que falhou — IMPL-004) = sem chave.
   */
  acceptableByContestant: Record<string, boolean>;
  /**
   * Veredito TERNARIO agregado por contestant (consenso entre juizes). Ausente em
   * records antigos. Contestant SEM veredito legitimo nao tem chave aqui (IMPL-004).
   */
  verdictByContestant?: Record<string, Verdict>;
  /** Origem de cada veredito presente (IMPL-004). */
  verdictSourceByContestant?: Record<string, VerdictSource>;
  /** Motivo de cada veredito AUSENTE (IMPL-004) — nunca vira 'parcial'/'nao'. */
  verdictErrorByContestant?: Record<string, VerdictError>;
  /**
   * EMPATE TECNICO do painel (IMPL-007): contestantId -> votos (pior -> melhor)
   * quando nenhum veredito teve maioria estrita. O veredito gravado e o nivel
   * que a maioria endossa (nunca o voto de cima). So a chave dos empatados.
   */
  verdictTieByContestant?: Record<string, Verdict[]>;
  /** Resultado individual de cada juiz (placar aditivo por juiz + justificativas na UI). */
  judges: SingleJudgeResult[];
  blindMap: Record<string, string>; // letra -> contestantId (do 1o juiz; cosmetico)
  rawJudgeText: string;
  inconclusive?: boolean;
}

/**
 * Julgamento POINTWISE contra o gabarito (`StageSpec.reference`): cada resposta
 * e classificada isoladamente (resolve/parcial/nao) por aderencia a referencia,
 * sem comparar contestants entre si. Base do judge-score.
 */
export interface ReferenceJudgeResult {
  /**
   * Veredito ternario por contestant (consenso entre juizes, quando ha mais de
   * um). SO vereditos legitimos: falha do juiz/competidor deixa a chave AUSENTE
   * (IMPL-004) — o motivo fica em `verdictErrorByContestant`.
   */
  verdictByContestant: Record<string, Verdict>;
  /** Explicacao curta (1 frase) por contestant — so para vereditos presentes. */
  explanationByContestant: Record<string, string>;
  /**
   * Confiança do juiz no veredito (IMPL-047): campo `confianca` do JSON do
   * juiz, por veredito (triagem de revisão humana). Com painel, vale o MENOR
   * entre os votos legítimos. Ausente quando o juiz não devolveu o campo.
   */
  confidenceByContestant?: Record<string, JudgeConfidence>;
  /** Origem de cada veredito presente (IMPL-004). */
  verdictSourceByContestant?: Record<string, VerdictSource>;
  /** Motivo de cada veredito AUSENTE (IMPL-004). */
  verdictErrorByContestant?: Record<string, VerdictError>;
  /**
   * EMPATE TECNICO do painel (IMPL-007): contestantId -> votos (pior -> melhor)
   * quando nenhum veredito teve maioria estrita. O veredito gravado e o nivel
   * que a maioria endossa (nunca o voto de cima). So a chave dos empatados.
   */
  verdictTieByContestant?: Record<string, Verdict[]>;
  /** Canário de cada voto legítimo, 1 por juiz (IMPL-006). */
  canaryByContestant?: Record<string, string[]>;
  /**
   * Voto de CADA juiz por contestant (IMPL-057): veredito + explicação +
   * confiança + canário, ou a falha do juiz (`error`, sem veredito — badge
   * 'avaliador falhou' ≠ veredito). A UI mostra a concordância do painel
   * ("2 de 3: resolve") com o divergente destacado. Ausente em records antigos
   * e em vereditos determinísticos (ground-truth/auto — não há painel).
   */
  judgeVotesByContestant?: Record<string, JudgeVote[]>;
  judgeModelId: string;
  inconclusive?: boolean;
}

/** Resultado de UM duelo pairwise (2 ordens; desacordo entre ordens = empate). */
export interface DuelOutcome {
  a: string;
  b: string;
  order1: DuelOrderResult;
  order2: DuelOrderResult;
  /** Resultado combinado das 2 ordens. */
  outcome: 'a' | 'b' | 'tie';
  /** Quem decidiu (IMPL-004): juiz LLM ou oráculo. Ausente em records antigos. */
  source?: VerdictSource;
}

/**
 * Duelos round-robin da etapa (bracket top-K): placar por TAXA DE VITÓRIA
 * (vitoria 1, empate 0.5, dividido pelos duelos disputados) com placements
 * fracionarios quando ha empate de taxa.
 */
export interface StageDuels {
  /** Placement final por contestant (1 = melhor; fracionario em empate). */
  placementByContestant: Record<string, number>;
  /** ContestantIds ordenados do melhor ao pior placement. */
  order: string[];
  /**
   * Taxa de vitória por contestant nos duelos da etapa (IMPL-007, R-04:DEC-5):
   * (vitórias + ½·empates) / duelos disputados, em 0..1. É a régua do placar —
   * NÃO é Copeland (Copeland = maioria par-a-par). Fora do bracket = 0.
   */
  winRate: Record<string, number>;
  /**
   * @deprecated Records anteriores ao IMPL-007: soma vitória 1/empate 0.5,
   * rotulada "pontos Copeland" por engano. `normalizeRunRecord` deriva `winRate`.
   */
  points?: Record<string, number>;
  /** Só duelos com resultado LEGÍTIMO — os únicos que pontuam. */
  duels: DuelOutcome[];
  /** Duelos sem resultado (IMPL-004): fora do placar, contados em `failureCountByRole.duel`. */
  failedDuels?: DuelFailure[];
  /** Tamanho do bracket usado (0 = round-robin completo). */
  topK: number;
}

/**
 * @deprecated O avaliador foi fundido no juiz (ver JudgeResult). Tipo mantido
 * apenas para LER records antigos que tinham um estagio de avaliacao separado.
 */
export interface EvaluationVerdict {
  contestantId: string;
  /** true = utilizavel em producao sem causar erro/dano, mesmo nao sendo a melhor. */
  acceptable: boolean;
  justification: string;
}

/**
 * Avaliacao QUALITATIVA da etapa, rodada em paralelo com o juiz de ranking.
 * Explica por que o vencedor venceu e classifica cada resposta como
 * aceitavel ou nao para o trabalho (mesmo que nao seja a ideal).
 */
export interface StageEvaluation {
  bestContestantId: string; // vencedor segundo a avaliacao qualitativa
  bestReasons: string; // motivos do vitorioso
  verdicts: EvaluationVerdict[];
  blindMap: Record<string, string>; // letra -> contestantId (avaliacao cega)
  raw: string;
  inconclusive?: boolean;
}

/**
 * @deprecated Streaming ao vivo removido do pipeline. Tipo mantido apenas para
 * LER records antigos (IndexedDB) que ainda trazem `StageRecord.live`.
 */
export interface CompetitorLiveState {
  contestantId: string;
  modelId: string;
  label?: string;
  startedAt: number; // epoch ms
  chars: number;
  charsPerSec: number;
  preview: string; // ultimos N chars do texto gerado
  done: boolean;
}

export interface StageRecord {
  index: number;
  spec?: StageSpec;
  responses: CompetitorResponse[];
  /** @deprecated Estado ao vivo dos competidores; so em records antigos (ninguem mais escreve). */
  live?: Record<string, CompetitorLiveState>;
  judge?: JudgeResult;
  /** Julgamento pointwise contra o gabarito (quando a etapa tem `reference`). */
  referenceJudge?: ReferenceJudgeResult;
  /** Duelos pairwise da etapa, placar por taxa de vitória (quando duelos ligados). */
  duels?: StageDuels;
  /** @deprecated Avaliador fundido no juiz. Presente so em records antigos. */
  evaluation?: StageEvaluation;
  /** Preenchido quando a etapa falhou (ex.: datagen) e foi pulada sem matar a run. */
  error?: string;
  /**
   * Etapa interrompida no meio (orcamento/cancelamento) ou com resposta
   * truncada no teto (IMPL-014) — NAO entra no placar nem nas medias. E o que
   * separa "parou cedo, honesto" de "terminou, mentindo": sem a marca, uma
   * etapa cortada viraria veredito inventado. Espelho de src/types.ts.
   */
  incomplete?: boolean;
  /** Motivo do `incomplete` (CONVENTIONS §4; `truncation` desde o IMPL-014). */
  incompleteReason?: StageIncompleteReason;
  /** Sinais de fim da chamada do gabarito (so no 1o clone com repeats) — IMPL-014. */
  gabaritoCall?: CallFinishSignals;
  startedAt: string;
  finishedAt?: string;
}

/** `inconclusive` (IMPL-004): terminou, mas a evidência não sustenta conclusão. É TERMINAL. */
export type RunStatus = 'running' | 'finished' | 'inconclusive' | 'error' | 'aborted';

export interface RunRecord {
  id: string;
  status: RunStatus;
  config: RunConfig;
  mode: RunMode; // denormalizado para listagem barata
  contestants: Contestant[]; // fonte de verdade para heatmap/standings
  stages: StageRecord[];
  scoreboard: Record<string, number>; // contestantId -> wins points (N-1 for first, ...)
  /** Custo acumulado por contestant (opcional, p/ painel de variantes). */
  costByContestant?: Record<string, number>;
  /** Judge-score agregado por contestant: (resolve + 0.5*parcial) / total * 100. */
  judgeScoreByContestant?: Record<string, number>;
  /** n nominal × efetivo por contestant e pares com a regua (IMPL-005). */
  completeness?: RunCompleteness;
  /**
   * Convencao de agregacao do painel de juizes (IMPL-007). `'majority'` =
   * maioria simples com empate tecnico. AUSENTE = record antigo (media ordinal
   * arredondada para cima): judge-score de painel >= 2 juizes NAO comparavel.
   */
  verdictAggregation?: 'majority';
  /** Ids dos finalistas (top-N por judge-score) que disputaram os duelos. */
  finalists?: string[];
  /** Avisos de imparcialidade (F3.6): juiz da familia do competidor, etc. NAO-bloqueantes. */
  fairnessWarnings?: string[];
  /**
   * Fila `needs-human-review` (IMPL-055): gabarito divergente da rubrica, 2º
   * gabarito discordante ou amostra humana de auditoria (5–10%). Sai de
   * `humanReviewQueueFromStages` (src/engine/groundTruth.ts); o re-read preserva
   * o campo (`normalizeRunRecord` espalha `...raw`).
   */
  needsHumanReview?: HumanReviewItem[];
  /**
   * LGPD (IMPL-042): campos do config com dado pessoal que o pre-voo achou
   * (caminho + tipos + veredito, NUNCA o valor) e se o usuario os liberou com
   * `allowPii`. E o registro de que os identificadores foram pseudonimizados
   * no envio — nao uma correcao silenciosa.
   */
  piiReport?: PiiRunReport;
  /** Diagnostico do juiz (F4.2): pin do contrato (hash) + vies de verbosidade medido. */
  judgeDiagnostics?: {
    /**
     * Pin do contrato do juiz (IMPL-049): hash cobre juízes + prompts
     * (pointwise/duelo/listwise) + modelo de referência + think level +
     * provedor; `components` guarda a entrada canônica (auditoria).
     */
    contract: {
      hash: string;
      modelIds: string[];
      pinnedAt: string;
      components?: JudgeContractComponents;
    };
    /**
     * Viés de verbosidade (IMPL-052): regressão só com amostras VÁLIDAS da
     * fonte-alvo; n por fonte e por célula (fonte × contestant) + excluídos.
     */
    verbosity: {
      n: number;
      r: number;
      biased: boolean;
      warning: string;
      alvo?: VerdictSampleSource;
      nPorFonte?: Record<string, number>;
      nPorCelula?: Record<string, number>;
      excluidos?: { vazios: number; truncados: number; imputados: number };
      /**
       * Diagnóstico de verbosidade em CAMADAS (IMPL-053): regressão ordinal +
       * permutação dentro do cenário + sondas contrafactuais + nota LC
       * auxiliar. Publicado por `verbosityReport`; `null`/ausente = n
       * insuficiente para ajustar o modelo.
       */
      verbosityDiag?: VerbosityDiag;
    };
  };
  /**
   * Ciclo de vida de TODO modelo da run (IMPL-019): canonicalSlug/
   * expirationDate/aliasTarget do catalogo no inicio da run, por papel, + os
   * alertas 30/14/7 dias / expirado / ausente. E o que permite, meses depois,
   * saber se o id de hoje ainda e o snapshot que foi medido (alias movido =
   * outro modelo com o mesmo nome). Ausente em records antigos.
   */
  modelLifecycle?: ModelLifecycleSnapshot;

  /**
   * Classificacao final agregada dos duelos das finais, ordenada por TAXA DE
   * VITÓRIA (`winRate` = (vitórias + ½·empates) / duelos disputados).
   */
  standings?: {
    id: string;
    label: string;
    isControl: boolean;
    /** @deprecated records anteriores ao IMPL-007 (soma vitória 1/empate 0.5); use `winRate`. */
    points?: number;
    wins: number;
    ties: number;
    losses: number;
    winRate: number;
  }[];
  /**
   * Custo TOTAL da run — todos os papéis, lido do ledger (`usage.cost` medido;
   * catálogo só como fallback). Antes o web somava só os competidores, com o
   * preço do catálogo — subcontando por um múltiplo.
   */
  totalCostUsd: number;
  /** Quebra do gasto por papel do pipeline. */
  costByRole?: Record<CostRole, CostEntry>;
  /** Quantas chamadas tiveram preço exato, estimado ou desconhecido. */
  costAccuracy?: { exact: number; estimated: number; unknown: number };
  /** Ledger: spent/committed/pending (IMPL-017). Ausente em records antigos. */
  costLedger?: import('../../../src/types.js').CostLedgerSummary;
  /** BYOK: cobrado pelo provedor upstream, fora dos créditos do OpenRouter. */
  upstreamCostUsd?: number;
  /** Teto de gasto configurado (ausente = sem limite). */
  budgetUsd?: number;
  /** true = a run parou porque o orcamento acabou. */
  budgetExhausted?: boolean;
  /** Fase em que a run parou (so quando parou cedo). */
  stoppedAtPhase?: RunPhase;
  /**
   * Por que parou cedo. Discrimina o status 'aborted'. 'orphan' (IMPL-023, só
   * na SPA): a aba que executava foi fechada/recarregada/travou — o lock da run
   * (Web Locks) ficou livre com o record ainda 'running'.
   */
  stoppedReason?: 'budget' | 'cancelled' | 'orphan';
  /** Desfechos nao-ok dos competidores, separados (blocked/refused/error) — IMPL-010. */
  competitorOutcomeCounts?: CompetitorOutcomeCounts;
  /** Fracao das chamadas de LLM da run (TODOS os papeis) truncadas no teto — IMPL-014; alerta > 2%. */
  truncationRate?: number;
  /** Numerador/denominador de `truncationRate`. */
  truncationCounts?: { calls: number; truncated: number };
  /** Os 4 sinais de fim agregados por papel (100% das chamadas que completaram) — IMPL-014. */
  finishSignalsByRole?: Partial<Record<CostRole, FinishSignalCounts>>;
  /** Vereditos PERDIDOS por papel (IMPL-004) — espelho de src/types.ts. */
  failureCountByRole?: Partial<Record<CostRole, number>>;
  /** A conta que decidiu `inconclusive` (IMPL-004). */
  verdictIntegrity?: VerdictIntegrity;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  // Lineage de treino (ausente em compare/variation):
  sessionId?: string;
  iteration?: number; // 0-based
  parentRunId?: string;
}

// ----------------------------------------------------------------------------
// Sessao de treino (encadeia varias runs)
// ----------------------------------------------------------------------------

export interface SessionIterationSummary {
  iteration: number;
  runId: string;
  winnerContestantId: string;
  systemPrompt: string;
  /** Retrocompat: no de OUROS da vencedora (antes era pontos aditivos do placar). */
  score: number;
  /** Quadro de medalhas da vencedora: [0]=ouro,[1]=prata,[2]=bronze,... (ausente em sessoes antigas). */
  medals?: number[];
  golds?: number;
  silvers?: number;
  bronzes?: number;
  /** Gate da iteracao com o pareamento honesto (IMPL-005). */
  gate?: IterationGate;
}

/**
 * IMPL-065 (R-05:REC-4): declaração de campeão sob âncora HUMANA. O zero-dataset
 * (tudo sintético) é BOOTSTRAP, não evidência: modelos atingem 84–89% em
 * benchmarks sintéticos e 25–34% em tarefas reais. Item curado = proveniência
 * humana (`origin` !== 'ai') E gabarito acompanhando o item (gabarito gerado
 * por IA não serve de âncora). Espelho de src/types.ts.
 */
export interface ChampionDeclaration {
  /** false = recusa declarar campeão (piso de itens curados não atingido). */
  declared: boolean;
  /** Itens curados (âncora humana) presentes nos cenários da sessão. */
  curatedItems: number;
  /** Piso aplicado (`minCuratedItems`, default 20 — proposta sem fonte, calibrar). */
  minCuratedItems: number;
  /** Motivo da recusa, quando houver. */
  reason?: 'sem-ancora-humana';
  /** Mensagem em PT-BR citando o piso e o número de itens curados. */
  message: string;
  /** IC95 do score do campeão (p.p.) — bootstrap/inversão pareada. */
  scoreCi95Pp?: [number, number] | null;
}

export interface SessionRecord {
  id: string;
  status: RunStatus;
  config: TrainingConfig;
  runIds: string[]; // ordenados por iteracao
  pinnedStages?: StageSpec[]; // congelado apos a iteracao 0
  bestPromptByIteration: SessionIterationSummary[];
  totalCostUsd: number;
  /** Quebra do gasto por papel, somando todas as runs da sessão + reescritor. */
  costByRole?: Record<CostRole, CostEntry>;
  /** Soma do `failureCountByRole` de todas as runs da sessão (IMPL-004). */
  failureCountByRole?: Partial<Record<CostRole, number>>;
  costAccuracy?: { exact: number; estimated: number; unknown: number };
  /** Ledger da sessão: spent/committed/pending (IMPL-017). */
  costLedger?: import('../../../src/types.js').CostLedgerSummary;
  upstreamCostUsd?: number;
  budgetUsd?: number;
  budgetExhausted?: boolean;
  stoppedAtPhase?: RunPhase;
  stoppedReason?: 'budget' | 'cancelled' | 'orphan';
  /** Iteracao em que o orcamento/cancelamento interrompeu a sessao. */
  stoppedAtIteration?: number;
  /**
   * true = o campeao NAO passou pelo gate de holdout (pulado por orcamento ou
   * cancelamento): nao validado contra sobreajuste — a UI precisa dizer isso.
   */
  holdoutSkipped?: boolean;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Gate de holdout: re-score campeao vs controle nos cenarios reservados. */
  holdout?: {
    n: number;
    controlScore: number;
    championScore: number;
    gain: number;
    regressed: boolean;
    /** IMPL-005: pares com veredito nos DOIS lados (scores sao medias SO sobre eles). */
    nEfetivo?: number;
    excludedPairs?: number;
    completeness?: number;
  };
  /**
   * Significancia estatistica: teste pareado EXATO por troca de sinais + IC por
   * inversao (IMPL-001; antes era bootstrap percentil). null = < 5 pares. Tipo
   * canonico em src/types.ts (fonte unica, sessoes antigas so tem os 4 campos base).
   */
  significance?: StoredSignificance | null;
  /** Pareamento final (IMPL-005): n nominal × efetivo, mesmo com significance null. */
  pairing?: SessionPairing;
  /** Iteracao em que o treino convergiu (ganho < minGain), quando parou antes do fim. */
  convergedAtIteration?: number;
  /** Motivo da convergencia (IMPL-051): 'patience' (streak sem promocao) | 'plateau' (IC do ganho abaixo de minGain). */
  convergenceReason?: 'patience' | 'plateau';
  /** Pool Pareto final (F4.1): prompts não-dominados por fatia que sobreviveram. */
  pool?: { id: string; label: string; bySlice: Record<string, number> }[];
  /**
   * IMPL-062 (R-02b:REC-4): diagnóstico Pareto da última iteração — fração de
   * pares não dominados e tamanho do front (com alerta de RUÍDO quando a
   * fração > 0,6 com n < 20). Com fatia única o treino roda como elitismo
   * explícito e o diagnóstico vem com `mode: 'elitismo'`.
   */
  paretoMetrics?: {
    mode: 'elitismo' | 'pareto';
    /** Instâncias (cenários) por trás da matriz. */
    n: number;
    /** Tamanho do front de Pareto (entradas não dominadas). */
    frontSize: number;
    /** Fração de pares (a,b) em que nenhum domina o outro (0–1). */
    nonDominatedPairFraction: number;
    /** true = front provavelmente ruído (ver regra em engine/pareto.ts). */
    noiseAlert?: boolean;
  };
  /**
   * IMPL-065 (R-05:REC-4): declaração de campeão sob âncora HUMANA. Com menos
   * itens curados que `minCuratedItems` (default 20) o treino NÃO declara
   * campeão — os sintéticos servem de treino/apoio, nunca de âncora — e o
   * resultado traz a recusa com o número de itens curados.
   */
  championDeclaration?: ChampionDeclaration;
  /**
   * true = as runs da sessao compararam CONTRATOS DE JUIZ diferentes (F4.2):
   * calibration drift — o delta entre iteracoes pode ser do juiz, nao do prompt.
   */
  judgeDrift?: boolean;
}

// ----------------------------------------------------------------------------
// Biblioteca de prompts (IndexedDB, client-only) e pacote JSON de cenarios
// ----------------------------------------------------------------------------

/** Prompt versionado da biblioteca local (nova versao a cada evolucao promovida). */
export interface SavedPrompt {
  id: string;
  name: string;
  text: string;
  version: number;
  /** Versoes anteriores (a versao corrente esta em `text`/`version`). */
  history: { version: number; text: string; savedAt: string; note?: string }[];
  /** Proveniencia do prompt. */
  origin?: {
    kind: 'training' | 'variation' | 'manual';
    sessionId?: string;
    runId?: string;
    techniqueId?: string;
    iteration?: number;
  };
  createdAt: string;
  updatedAt: string;
}

/** Pacote JSON de cenarios+gabaritos exportado ao fim da run (importavel como seed). */
export interface ScenarioPack {
  /** Escrita usa `prompt-builder-pack@1`; o nome antigo segue aceito na leitura. */
  format: 'prompt-builder-pack@1' | 'ai-benchmark-pack@1';
  theme: string;
  exportedAt: string;
  /** Prompt escolhido na exportacao (campeao ou base). */
  prompt: { text: string; source: 'champion' | 'base'; label?: string };
  scenarios: (StageSpec & { id: string })[];
}

// ----------------------------------------------------------------------------
// Eventos
// ----------------------------------------------------------------------------

export type RunEvent =
  | { type: 'run.started'; runId: string; record: RunRecord }
  | { type: 'variants.generating'; runId: string }
  | { type: 'variants.generated'; runId: string; contestants: Contestant[] }
  | { type: 'stage.generating'; runId: string; stageIndex: number }
  | {
      type: 'stage.generated';
      runId: string;
      stageIndex: number;
      spec: StageSpec;
      /** Sinais de fim da chamada do gabarito (IMPL-014). */
      gabaritoCall?: CallFinishSignals;
      /** Aviso visivel — hoje: gabarito truncado e descartado (etapa julgada sem gabarito). */
      warning?: string;
    }
  | { type: 'stage.failed'; runId: string; stageIndex: number; error: string }
  /** Etapa fora do placar e das medias (IMPL-014: truncamento). Sem texto de resposta. */
  | {
      type: 'stage.incomplete';
      runId: string;
      stageIndex: number;
      reason: StageIncompleteReason;
      detail: string;
      contestantIds?: string[];
    }
  | { type: 'competitor.finished'; runId: string; stageIndex: number; response: CompetitorResponse }
  /** Veredito invalidado por saida de juiz cortada (IMPL-015, espelho de src/types.ts). */
  | {
      type: 'judge.truncated';
      runId: string;
      stageIndex: number;
      phase: 'judge' | 'duel';
      contestantIds: string[];
      kinds: JudgeCutKind[];
      detail: string;
    }
  /**
   * Contrato do juiz mudou entre runs (IMPL-049, espelho de src/types.ts):
   * sugere recalibração. Agregado, sem `stageIndex` — não entra no reducer.
   */
  | {
      type: 'judge.contract.changed';
      runId: string;
      previousHash: string;
      currentHash: string;
      detail: string;
    }
  | { type: 'stage.judging'; runId: string; stageIndex: number }
  | {
      type: 'stage.judged';
      runId: string;
      stageIndex: number;
      judge: JudgeResult;
      scoreboard: Record<string, number>;
      totalCostUsd: number;
    }
  | { type: 'stage.gabarito'; runId: string; stageIndex: number; done: number; total: number }
  | {
      type: 'finals.started';
      runId: string;
      finalists: { id: string; label: string; score: number }[];
    }
  | { type: 'stage.dueled'; runId: string; stageIndex: number; duels: StageDuels }
  | { type: 'duel.progress'; runId: string; done: number; total: number }
  /** Gasto acumulado (espelho de src/types.ts). */
  | {
      type: 'run.spend';
      runId: string;
      spentUsd: number;
      budgetUsd?: number;
      byRole: Record<CostRole, CostEntry>;
    }
  /** Decisao de uma porta de orcamento numa fronteira de fase. */
  | {
      type: 'run.budget';
      runId: string;
      phase: RunPhase;
      projectedUsd: number;
      remainingUsd: number;
      decision: 'go' | 'stop';
    }
  | { type: 'run.finished'; runId: string; record: RunRecord }
  | { type: 'run.error'; runId: string; error: string }
  /**
   * IMPL-022: a gravação no IndexedDB falhou — SÓ a SPA emite (o Node grava em
   * disco e lança). A run segue viva na memória da aba; o aviso na UI oferece
   * baixar o JSON. Um evento por episódio (a batida periódica não repete).
   */
  | StorageEvent<{ runId: string }>;

/** Tipo da falha de gravação local (espelha `IdbFailureKind` de web/src/idb.ts). */
export type StorageFailureKind = 'quota' | 'unavailable' | 'failed';

/** Falha de gravação local, no barramento da run OU da sessão. */
export type StorageEvent<Scope> =
  | ({ type: 'storage.quota_exceeded'; kind: 'quota'; error: string } & Scope)
  | ({ type: 'storage.write_failed'; kind: Exclude<StorageFailureKind, 'quota'>; error: string } & Scope);

export type SessionEvent =
  | { type: 'session.started'; sessionId: string; record: SessionRecord }
  | { type: 'iteration.started'; sessionId: string; iteration: number; runId: string }
  | {
      type: 'iteration.finished';
      sessionId: string;
      iteration: number;
      runId: string;
      winnerContestantId: string;
    }
  | {
      type: 'iteration.promoted';
      sessionId: string;
      iteration: number;
      championId: string;
      /** Ganho BRUTO (p.p.) — o máximo entre K (mantido por compatibilidade). */
      gain: number;
      /** IMPL-002: ganho corrigido do winner's curse (p.p.), lado a lado com o bruto. */
      gainCorrected?: number;
      /** IMPL-002: p ajustado (FWER sobre as K variantes) da promovida. */
      pAdjusted?: number;
      /** IMPL-002: variantes testadas na iteração (a família do FWER). */
      k?: number;
      /** IMPL-002: correção de multiplicidade aplicada. */
      method?: MultiplicityMethod;
      /** IMPL-002: margem aplicada (p.p.). */
      minGain?: number;
    }
  | { type: 'session.holdout'; sessionId: string; holdout: SessionRecord['holdout'] }
  /** IMPL-051: `reason` = por que a sessão convergiu (platão vs paciência). */
  | { type: 'session.converged'; sessionId: string; iteration: number; reason?: 'patience' | 'plateau' }
  | { type: 'session.finished'; sessionId: string; record: SessionRecord }
  | { type: 'session.error'; sessionId: string; error: string }
  /** IMPL-022: gravação da sessão no IndexedDB falhou (só a SPA emite). */
  | StorageEvent<{ sessionId: string }>;
