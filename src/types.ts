// ----------------------------------------------------------------------------
// Modo agente (Agent Arena) — campos/eventos ADITIVOS.
//
// Tudo que este arquivo acrescenta abaixo é opcional e NÃO muda o significado
// de nenhum campo existente: records antigos continuam abrindo e o modo chat
// segue com o mesmo comportamento. Os TIPOS DE DOMÍNIO do modo agente (a
// tarefa executável, a config do executor, o registro de execução em disco)
// vivem em `src/agent/types.ts` — este arquivo só importa os poucos tipos que
// precisam aparecer nos tipos compartilhados.
//
// ⚠️ O modo agente NÃO é espelhado em `web/src/engine`: ali não há
// `child_process`, filesystem nem git no navegador, então o pipeline client-side
// não consegue (nem deve) rodar um executor de agente. A SPA da Vercel continua
// fazendo compare/variation/training de chat apenas.
// ----------------------------------------------------------------------------
import type {
  AgentRunnerConfig,
  AgentStopReason,
  AgentTaskSpec,
  ExecutionRef,
} from './agent/types.js';
import type { ExpectedSpec, ReferenceValidation } from './engine/groundTruth.js';
import type { PromptContracts } from './engine/contracts.js';
import type { PromptGroup } from './engine/promptGroup.js';
import type { ModelLifecycleSnapshot } from './engine/modelLifecycle.js';

// Ciclo de vida de modelos (IMPL-019): fonte única em src/engine/modelLifecycle.ts.
export type {
  ModelLifecycleAlert,
  ModelLifecycleEntry,
  ModelLifecycleSnapshot,
  ModelUsageRole,
  RemovalAction,
  SuccessorSuggestion,
} from './engine/modelLifecycle.js';

/**
 * Preco em USD por token. `null` = DESCONHECIDO (IMPL-018 / R-07b:REC-7): o
 * catalogo trouxe "-1" (roteadores como `openrouter/auto` — preco variavel),
 * valor ausente, nao numerico, nao finito ou negativo. Nunca vira 0 ("gratis")
 * nem numero negativo: antes o "-1" entrava como -1 e produzia estimativa e
 * reserva de orcamento NEGATIVAS em silencio. Quem precisa do numero trata o
 * `null` explicitamente (a tipagem obriga).
 */
export type TokenPrice = number | null;
import type { PiiRunReport } from './engine/pii.js';
import type { SensitiveRouting } from './engine/sensitiveRouting.js';

export interface OpenRouterModelPricing {
  prompt: TokenPrice; // USD per token (null = desconhecido)
  completion: TokenPrice; // USD per token (null = desconhecido)
  /**
   * Precificacao POR FAIXA de tamanho de prompt (campo `pricing.overrides`,
   * vivo no catalogo mas nao documentado). Ignorar isto subestima runs de
   * contexto longo em 3-7x — e o prompt do juiz pointwise (gabarito + pergunta
   * + rubrica + candidato) cruza a faixa de 32k rotineiramente.
   */
  overrides?: PricingTier[];
}

export interface PricingTier {
  minPromptTokens: number;
  prompt: TokenPrice; // USD per token (null = desconhecido)
  completion: TokenPrice; // USD per token (null = desconhecido)
}

// ----------------------------------------------------------------------------
// Contabilidade de custo
// ----------------------------------------------------------------------------

/** Papel da chamada no pipeline — a granularidade do ledger de gasto. */
export type CostRole =
  | 'datagen'
  | 'gabarito'
  | 'competitor'
  | 'judge'
  | 'duel'
  | 'rewriter'
  /** NOVO: gasto de LLM feito DENTRO de uma execução de agente. */
  | 'agent';

export const COST_ROLES: readonly CostRole[] = [
  'datagen',
  'gabarito',
  'competitor',
  'judge',
  'duel',
  'rewriter',
  'agent',
] as const;

/**
 * De onde veio o numero. `usage` = o OpenRouter cobrou exatamente isso (inclui
 * cache, tokens de raciocinio e faixas de preco) — a ÚNICA fonte "exata".
 * `agent-derived` = o EXECUTOR do agente calculou o custo (tabela própria ou o
 * relatório dele); nunca rotular isto de `catalog` (IMPL-096). `catalog` =
 * derivado dos precos do /models (estimativa por tabela NOSSA). `unknown` =
 * modelo fora do catalogo, NAO conseguimos precificar — nunca confundir com
 * "custou zero".
 */
export type CostSource = 'usage' | 'catalog' | 'agent-derived' | 'unknown';

export interface CallCost {
  usd: number;
  source: CostSource;
  /** BYOK: cobrado direto pelo provedor upstream, fora dos creditos. */
  upstreamUsd?: number;
  /**
   * Chamada despachada sem custo medido e com id de geracao (IMPL-017): a
   * reserva ficou PENDENTE no ledger — fora de `usd`/`totalCostUsd` ate a
   * conciliacao. `usd: 0` com este campo NAO e "custou zero".
   */
  pendingUsd?: number;
}

export interface CostEntry {
  calls: number;
  usd: number;
  tokensIn: number;
  tokensOut: number;
  /**
   * IMPL-078 (R-08:REC-5) — telemetria de uso AGREGADA por papel, somada pelo
   * ledger no ponto único da contabilidade. Ausente = nada medido ainda
   * (record anterior ao IMPL-078 ou papel sem chamada registrada).
   */
  /** Soma dos tokens de entrada lidos DO CACHE (`prompt_tokens_details.cached_tokens`). */
  cachedTokensIn?: number;
  /**
   * Soma dos tokens de raciocínio (`completion_tokens_details.reasoning_tokens`).
   * ⚠️ São SUBCONJUNTO de `tokensOut` (o Codex dobra o raciocínio DENTRO de
   * `completion_tokens`): sempre etiquetados, NUNCA somados a `tokensOut`.
   */
  reasoningTokens?: number;
  /** Soma das latências das chamadas (média = latencyTotalMs / calls). */
  latencyTotalMs?: number;
  /**
   * Soma do custo ESTIMADO (catálogo, usado na reserva) — o "estimado x real"
   * por papel sai daqui contra `usd` (o valor efetivamente cobrado).
   */
  estimatedUsd?: number;
  /**
   * IMPL-080 (R-08:REC-3) — cache EXATO de vereditos, agregado por papel:
   * `cacheTotal` = lookups de veredito (hits + misses), `cacheHits` = servidos
   * do cache. Sobem em `run.spend` junto com `byRole`. Um hit NÃO conta em
   * `calls` (não houve chamada upstream nem gasto).
   */
  cacheHits?: number;
  cacheTotal?: number;
  /**
   * IMPL-075 (R-07b:REC-4) — chamadas por PROVEDOR que as serviu
   * (`provider_name` do payload ou do GET /generation), somadas pelo ledger no
   * ponto único. Cobertura de registro do papel = Σ providers / calls.
   */
  providers?: Record<string, number>;
  /** IMPL-075 — chamadas deste papel enviadas no modo AUDITÁVEL (provider travado). */
  auditableCalls?: number;
}

/**
 * IMPL-074 (R-07a:REC-4) — UMA chamada contabilizada, com o id de geração
 * (`gen-…`) que a liga à fatura (GET /api/v1/generation). Vai no RunRecord
 * (`callLog`), FORA do `costLedger`: o ledger enxuto viaja em NDJSON/MCP e o
 * registo por chamada só interessa a auditoria/conciliação.
 */
export interface CallLogEntry {
  role: CostRole;
  modelId: string;
  /** Id de geração do OpenRouter; ausente = a resposta não trouxe id. */
  generationId?: string;
  /** false = o id não tem o formato `gen-…` documentado (não é conciliável). */
  generationIdValid?: boolean;
  /** Valor lançado (medido, reserva pendente/conservadora ou conciliado). */
  usd: number;
  source: CostSource;
  /**
   * `measured` = `usage.cost` da resposta; `pending` = reserva mantida à
   * espera do /generation; `conservative` = reserva inteira (sem id ou 404
   * persistente); `reconciled` = trocada pelo `total_cost` do /generation.
   */
  status: 'measured' | 'pending' | 'conservative' | 'reconciled';
  /** Provedor que serviu (IMPL-075). */
  provider?: string;
  /** Latência observada pelo cliente (ms). */
  latencyMs?: number;
  /** true = corpo enviado no modo auditável (IMPL-075). */
  auditable?: boolean;
  /** Do GET /generation (IMPL-074): a geração foi cancelada no provedor. */
  cancelled?: boolean;
  /** Do GET /generation: tempo de geração no provedor (ms). */
  generationTimeMs?: number;
  /** Do GET /generation: `upstream_id` no provedor. */
  upstreamId?: string;
}

/**
 * IMPL-075 (R-07b:REC-4) — provedor que EFETIVAMENTE serviu a chamada. Sem
 * isto a variação entre provedores do mesmo id de pesos abertos (>20 pp de
 * schema_accuracy; entrada 4,5x entre endpoints) é inseparável da variação de
 * prompt. `name` vem do payload da resposta (`provider`); `upstreamId` e
 * `serviceTier` do GET /api/v1/generation (conciliação IMPL-074).
 */
export interface CallProviderInfo {
  /** `provider_name` do provedor (ex.: 'OpenAI', 'Azure'). */
  name?: string;
  /** `upstream_id` da geração no provedor (identifica a cobrança). */
  upstreamId?: string;
  /** `service_tier` efetivo (ex.: 'standard', 'flex', 'priority'). */
  serviceTier?: string;
}

/**
 * Ciclo de vida de uma reserva (IMPL-017 / R-07a:REC-2):
 * - `reserved`: chamada em voo (a reserva conta no `committedUsd`);
 * - `noted`: custo medido lancado (a reserva deu lugar ao valor real);
 * - `released`: devolvida — a chamada comprovadamente nao foi cobrada (HTTP de erro);
 * - `pending`: despachada SEM custo medido (abort/timeout/sem usage) e COM id de
 *   geracao — a reserva fica MANTIDA (nem gasto nem devolvida) ate conciliar
 *   via GET /generation (gancho `BudgetLedger.settlePending`, IMPL-074);
 * - `conservative`: idem, mas SEM id recuperavel — a reserva inteira vira gasto
 *   (nunca zero: nao medido nao e o mesmo que "custou zero");
 * - `reconciled`: pendente conciliada com o valor do /generation.
 */
export type ReservationStatus =
  | 'reserved'
  | 'noted'
  | 'released'
  | 'pending'
  | 'conservative'
  | 'reconciled';

/** Por que uma chamada despachada ficou sem custo medido. */
export type PendingReason = 'timeout' | 'aborted' | 'no_usage';

/**
 * Chamada DESPACHADA que terminou sem custo medido e tem id de geracao
 * (IMPL-017). A reserva fica mantida ate `BudgetLedger.settlePending`
 * (IMPL-074 concilia via GET /api/v1/generation?id=…).
 */
export interface PendingCall {
  generationId: string;
  role: CostRole;
  modelId: string;
  /** Valor reservado, mantido no `committedUsd`/`pendingUsd`. */
  usd: number;
  reason: PendingReason;
}

/** Reserva otimista devolvida por `CostSink.reserve`. */
export interface Reservation {
  release(): void;
  /** Estado atual (ausente em reservas nulas de chamadas sem ledger). */
  readonly status?: ReservationStatus;
  /** Valor reservado, em USD (ausente em reservas nulas). */
  readonly usd?: number;
}

/**
 * Resumo do ledger que vai para o resultado da run/sessao (IMPL-017):
 * `spentUsd` = medido + conservador; `pendingUsd` = reservas mantidas a
 * espera de conciliacao; `committedUsd` = spent + pending + em voo (o que a
 * porta dura compara com o teto).
 */
export interface CostLedgerSummary {
  spentUsd: number;
  committedUsd: number;
  pendingUsd: number;
  pendingCalls: number;
  /** Reservas sem id recuperavel lancadas INTEIRAS como gasto (limite superior). */
  conservativeUsd: number;
  conservativeCalls: number;
  /**
   * As pendentes em si (id, papel, modelo, reserva, motivo), presente so
   * quando ha alguma. Persistidas no record para que a conciliacao (IMPL-074,
   * GET /generation) possa rodar DEPOIS que o processo terminou — so as
   * contagens deixavam o `pendingUsd` preso no record para sempre.
   */
  pendingEntries?: PendingCall[];
  /**
   * IMPL-074 — última conciliação pelo GET /generation (contagens). Ausente =
   * nunca conciliado (sem pendentes, ou record anterior).
   */
  reconciliation?: {
    /** Pendentes consultados. */
    attempted: number;
    /** Trocados pelo `total_cost` da fatura. */
    settled: number;
    /** 404 persistente / id fora do formato: viraram gasto conservador. */
    notFound: number;
    /** Falha de rede/HTTP: seguem pendentes (conciliáveis depois). */
    failed: number;
  };
}

/**
 * Contrato minimo que `openrouter.ts` conhece do ledger. Declarado aqui (e nao
 * em budget.ts) para que o cliente HTTP nao dependa do ledger — sem ciclo de
 * import e sem arrastar nada Node-only para o espelho do browser.
 */
export interface CostSink {
  /** Chamado ANTES do fetch. Lanca BudgetExceeded/RunCancelled se nao couber. */
  reserve(
    role: CostRole,
    modelId: string,
    promptTokensGuess: number,
    maxTokens: number,
    /** Estimativa do proprio gateway (preco do catalogo em cache), usada se maior. */
    fallbackUsd?: number,
  ): Reservation;
  /**
   * Variante assincrona de `reserve` usada pelo gateway (IMPL-017): com teto
   * definido e custo IMPOSSIVEL de estimar, admite no maximo 1 chamada em voo
   * por papel — e o que limita o estouro a 1 chamada por papel.
   */
  admit?(
    role: CostRole,
    modelId: string,
    promptTokensGuess: number,
    maxTokens: number,
    fallbackUsd?: number,
    /** Sinal da PROPRIA chamada: abortar solta a espera pela vaga do papel. */
    signal?: AbortSignal,
  ): Promise<Reservation>;
  /**
   * Chamada DESPACHADA que terminou sem custo medido (abort/timeout/sem
   * usage). Nunca devolve a reserva: com `generationId` ela fica pendente
   * (conciliavel), sem ele vira gasto conservador (IMPL-017).
   */
  pending(
    reservation: Reservation,
    entry: {
      role: CostRole;
      modelId: string;
      reason: PendingReason;
      generationId?: string;
      /** Sinais de fim, quando a resposta completou sem `usage` (IMPL-014). */
      finish?: CallFinishSignals;
      /** IMPL-075: provedor que serviu a chamada (mesmo sem custo medido). */
      provider?: CallProviderInfo;
      /** IMPL-078: latência observada até o corte/abort, em ms. */
      latencyMs?: number;
      /** IMPL-075: corpo enviado no modo auditável. */
      auditable?: boolean;
    },
  ): void;
  /** Chamado DEPOIS do fetch, sempre: troca a reserva pelo custo real. */
  note(
    reservation: Reservation,
    entry: {
      role: CostRole;
      modelId: string;
      cost: CallCost;
      tokensIn: number;
      tokensOut: number;
      /**
       * IMPL-078 (R-08:REC-5) — telemetria de uso POR CHAMADA, entregue no
       * MESMO ponto único do custo (role + sink): 100% das chamadas, todos os
       * papéis. Campos opcionais só pela retrocompatibilidade do record.
       */
      /** Tokens de entrada lidos do cache (`prompt_tokens_details.cached_tokens`). */
      cachedTokensIn?: number;
      /** Tokens de raciocínio — SUBCONJUNTO de `tokensOut`, nunca somado. */
      reasoningTokens?: number;
      /** Latência da chamada (ms, despacho até a resposta lida). */
      latencyMs?: number;
      /** Custo ESTIMADO (catálogo) enviado na reserva — real = `cost.usd`. */
      estimatedUsd?: number;
      /** IMPL-075: provedor que efetivamente serviu a chamada. */
      provider?: CallProviderInfo;
      /** IMPL-074: id de geração (`gen-…`) da resposta — a ponte com a fatura. */
      generationId?: string;
      /** IMPL-075: corpo enviado no modo auditável. */
      auditable?: boolean;
      /**
       * Sinais de fim da chamada (IMPL-014) — presentes quando a chamada
       * COMPLETOU (ausentes no 200 com corpo de erro, que lanca). E por aqui
       * que os sinais de TODO papel (juiz, duelo, datagen, reescritor…) chegam
       * ao RunRecord sem cada papel precisar persisti-los.
       */
      finish?: CallFinishSignals;
    },
  ): void;
  /**
   * IMPL-080 (R-08:REC-3) — contagem do cache EXATO de vereditos: cada lookup
   * de veredito (hit ou miss) passa por aqui e sobe para `byRole` (logo para o
   * evento `run.spend`, campo `cacheHits`/`cacheTotal` do `CostEntry`). Um hit
   * NAO e chamada upstream nem gasto — por isso o conto e proprio e nao o
   * `note`. Opcional: sinks antigos simplesmente nao contam.
   */
  noteVerdictCache?(entry: { role: CostRole; hit: boolean }): void;
  /**
   * LGPD (IMPL-042): identidade do escopo do cofre de pseudonimos — a RAIZ do
   * ledger (run avulsa ou sessao de treino). Mesmo escopo = mesmos tokens em
   * todos os papeis; escopos diferentes = chaves diferentes (sem ligacao entre
   * runs). Opcional: sem ele o proprio sink e o escopo.
   */
  piiScope?(): object;
  /**
   * LGPD (IMPL-040): politica do modo "dados sensiveis" da run/sessao, ou
   * `undefined` fora dele. O gateway a le em TODA chamada e injeta
   * `provider { zdr, data_collection:'deny', only, allow_fallbacks:false }` —
   * faltou campo, lanca antes do fetch. Opcional: sink sem ele = modo desligado.
   */
  sensitiveRouting?(): SensitiveRouting | undefined;
  /**
   * IMPL-075 (R-07b:REC-4): papéis que ESTA run/sessão manda no modo
   * AUDITÁVEL (provider travado, sem fallback, `require_parameters`), somados
   * ao preset do gateway. Opcional: sink sem ele = só o preset do gateway.
   */
  auditableRoles?(): readonly CostRole[] | undefined;
}

/**
 * Contexto de execucao que atravessa o pipeline inteiro. O `signal` precisa
 * chegar ao `fetch` como VALOR (dai nao usarmos AsyncLocalStorage, que alem
 * disso nao existe no browser); como ele ja atravessa todos os modulos, o
 * ledger pega carona e a contabilidade sai de graca em assinaturas.
 */
export interface RunCtx {
  signal?: AbortSignal;
  sink?: CostSink;
}

/** Fase do pipeline — usado para dizer ONDE uma run parou. */
export type RunPhase =
  | 'variants'
  | 'datagen'
  | 'gabarito'
  | 'competitors'
  | 'judging'
  | 'finals'
  | 'holdout'
  /** NOVO: o grupo de orçamento G2 em modo agente (a execução DOS agentes). */
  | 'agents';

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength?: number;
  pricing: OpenRouterModelPricing;
  /**
   * Parametros de amostragem que o modelo aceita (campo `supported_parameters`
   * do OpenRouter). Fonte de verdade para enviar `temperature`/`seed` so a quem
   * suporta — reasoning models (gpt-5*, serie o*) NAO listam `temperature` e
   * respondem vazio (HTTP 400) se ela for enviada. Ausente = desconhecido
   * (heuristica por nome). `[]` = o catalogo declara que NAO aceita nenhum —
   * tambem e o valor FAIL-CLOSED quando o campo vem malformado (IMPL-018):
   * nada opcional vai no fio.
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
  /**
   * Multi-prompt (F2/P0.4): o TEXT do fragmento evoluido (sem os irmãos
   * congelados). `systemPrompt` guarda a COMPOSICAO (o que o modelo recebe);
   * este campo e o que o treino reusa como base da proxima rodada — sem ele o
   * coordinate ascent reescreveria o prompt composto inteiro como fragmento.
   */
  promptFragment?: string;
  /** Override de temperatura deste contestant (compare-llms). Default 0. */
  temperature?: number;
  /** Nivel de reasoning deste contestant (compare-llms; identidade = tripla modelo/temp/reasoning). */
  reasoningLevel?: ReasoningLevel;
  /**
   * COMO a resposta deste competidor é colhida.
   * 'chat'  (default, ausente) = uma chamada de chatCompletion — o que existe hoje.
   * 'agent' = uma execução de agente num workspace isolado (Agent Arena).
   *
   * Eixo ORTOGONAL ao `mode`: um compare pode ter 3 modelos como agentes; um
   * training pode evoluir o system prompt DE um agente. Foi por isso que este
   * campo não virou um quarto RunMode — viraria a duplicação dos três.
   */
  runner?: 'chat' | 'agent';
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
   * Nº de FINALISTAS que disputam os duelos depois do julgamento pointwise.
   * Os melhores por judge-score médio (todos os cenários) duelam entre si em
   * cada cenário. 0 = sem duelos. Default 3.
   */
  finalists?: number;
  /** Liga/desliga a fase de finais (duelos). Default: true quando há gabarito. */
  duels?: boolean;
  /**
   * Teto de gasto em USD para a run (ou para a SESSAO inteira, em training).
   * Ausente = sem limite.
   *
   * ⚠️ `variationConfigFrom` (trainer.ts) NAO copia este campo de proposito: se
   * copiasse, cada uma das N iteracoes receberia o orcamento inteiro da sessao
   * e o gasto total seria N vezes o teto. O ledger da sessao e quem controla.
   */
  budgetUsd?: number;
  /**
   * Teto de preco POR REQUISICAO repassado ao OpenRouter (`provider.max_price`).
   * ⚠️ UNIDADE: USD por MILHAO de tokens — o catalogo (`pricing`) e USD por
   * token. A conversao mora so em `toPerMTok`/`toPerToken` (estimate.ts).
   */
  maxPricePerMTok?: { prompt?: number; completion?: number };
  /**
   * Config DA RUN do modo agente. Vive aqui (não por etapa) porque a MESMA
   * tarefa precisa rodar sob o mesmo executor para todos os contestants —
   * senão o experimento compara duas coisas ao mesmo tempo. AUSENTE => run
   * inteiramente de chat (comportamento de hoje, intacto).
   */
  agent?: AgentRunnerConfig;
  /**
   * Contratos NEVER-BREAK do prompt base (F2 do PLANO-PARIDADE, P0.3):
   * invariantes (`neverBreak`), placeholders verbatim e piso de comprimento.
   * O pós-rewriter (`engine/contracts.ts`) valida TODA reescrita e rejeita a
   * que quebrar — evolução com cinto de segurança, validação local sem LLM.
   */
  contracts?: PromptContracts;
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
   * Grupo multi-prompt (F2/P0.4, coordinate ascent): a feature real tem >1
   * prompt (ex.: regras + criticas). A sessao evolui UM fragmento (`promptId`)
   * com os IRMAOS CONGELADOS; o system prompt efetivo dos contestants e a
   * composicao do grupo (`engine/promptGroup.ts`).
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
  /**
   * Paciencia do laco (IMPL-051): iteracoes SEGUIDAS sem promocao antes de
   * convergir. Default 2 (IMPL-013) — paciencia 1 com veredito ruidoso e
   * anti-patrao (sob H0 25,8-35,8% das sessoes param cedo por azar).
   */
  patience?: number;
  /** Reflection estilo GEPA: variantes recebem licoes das falhas do campeao. */
  feedbackDriven?: boolean;
  /**
   * Como as lições da reflexão GEPA são produzidas (F2, §7.5 do plano):
   * - 'deterministic' (default): `buildLessons` — zero custo LLM;
   * - 'llm': um meta-modelo REESCREVE as lições num bloco acionável
   *   (`<licoes_da_iteracao_anterior>` mais denso) — custo extra contado no
   *   ledger, degrada para o determinístico se a chamada falhar;
   * - 'off': sem lições (== feedbackDriven false).
   */
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
   * Validacao do GABARITO (IMPL-055, R-03a:REC-1): verificacao dirigida pela
   * rubrica rodada ANTES do julgamento + 2º gabarito de familia distinta
   * (condicionado) + itens `needs-human-review`. Preenchida por
   * `generateReferences`/`validateGeneratedReferences` (`gabarito.ts`) e
   * persistida junto da spec — a fila agregada vive em
   * `RunRecord.needsHumanReview`. Ausente = etapa sem gabarito gerado (seed/
   * pinada) ou validacao nao rodou.
   */
  referenceValidation?: ReferenceValidation;
  /**
   * Rótulo ESPERADO (ground-truth): quando presente, o veredito da etapa e
   * decidido deterministicamente (`engine/groundTruth.ts`), SEM juiz LLM — o
   * padrao `gabaritoSpec kind:'labels'` do prompt-arena. string = rotulo unico,
   * lista = alternativas aceitaveis, objeto = par campo->valor (resposta JSON).
   */
  expected?: ExpectedSpec;
  /**
   * TODOS os rotulos validos da etapa (IMPL-003 / R-03b:DEC-4). Obrigatorio
   * quando `expected` e rotulo curto (<=5 palavras): sem ele a config e
   * recusada (`labelSetIssue`, exit 3 no CLI). O verificador estrito usa o
   * conjunto para reconhecer resposta que lista/hesita entre varios rotulos.
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
  /**
   * A etapa, quando executada por um agente. AUSENTE => a etapa só serve ao
   * runner 'chat' (comportamento de hoje, intacto).
   *
   * `question` continua sendo A TAREFA e `productContext` continua sendo o
   * contexto/política — para o agente eles viram, respectivamente, o prompt
   * inicial e o system prompt. `rubric` continua sendo a âncora do juiz e
   * `reference` continua sendo o gabarito. É literalmente a mesma etapa
   * servindo aos dois runners; só o transporte muda.
   */
  agentTask?: AgentTaskSpec;
}

/**
 * Desfecho de UMA resposta de competidor (IMPL-010 / R-21:REC-6):
 * - `ok`      — resposta normal;
 * - `blocked` — moderacao/guardrail do gateway ou filtro de conteudo do
 *               provedor (HTTP 403 de moderacao, `finish_reason` de filtro).
 *               Defesa do gateway: o cenario fica SEM veredito para o prompt;
 * - `refused` — o MODELO recusou (`message.refusal`); resposta legitima, julgavel;
 * - `error`   — infraestrutura (rede, 5xx, timeout, key).
 * Regra de origem do veredito (IMPL-004, `engine/verdictIntegrity.ts`):
 * `blocked`/`error` => SEM veredito (nunca 'nao' imputado); `ok` vazio =>
 * 'nao' automatico; `refused` => julgado normalmente.
 */
export type CompetitorStatus = 'ok' | 'error' | 'blocked' | 'refused';

/** Contagens dos desfechos nao-ok dos competidores de uma run (IMPL-010). */
export interface CompetitorOutcomeCounts {
  blocked: number;
  refused: number;
  error: number;
}

/**
 * Sinal de truncamento de UMA chamada (IMPL-014 / R-07b:DEC-2). Os provedores
 * devolvem 200 OK tanto para a resposta completa quanto para a cortada no teto
 * — sem ler estes sinais as duas sao indistinguiveis:
 * - `finish_length`     — `finish_reason` normalizado = `length`;
 * - `native_length`     — `native_finish_reason` cru de teto (`max_tokens`,
 *                          `MAX_TOKENS`, `length`, …) mesmo que o normalizado diga outra coisa;
 * - `reasoning_at_cap`  — `reasoning_tokens` ≈ `max_tokens` (o raciocinio comeu o teto);
 * - `empty_with_tokens` — conteudo vazio com `completion_tokens > 0`.
 */
export type TruncationSignal =
  | 'finish_length'
  | 'native_length'
  | 'reasoning_at_cap'
  | 'empty_with_tokens';

/**
 * Os sinais de fim de UMA chamada (IMPL-014): os 4 sinais do R-07b:REC-2
 * (finish_reason, native_finish_reason, reasoning_tokens vs teto e tamanho do
 * conteudo) + a decisao. O gateway monta um por chamada que completou e o
 * entrega ao ledger (`CostSink.note`), que agrega por papel em
 * `RunRecord.finishSignalsByRole` — e assim que juiz/duelo/datagen tem os
 * sinais no record. Por chamada, persistidos no gabarito
 * (`StageRecord.gabaritoCall`); o competidor guarda os mesmos campos soltos na
 * `CompetitorResponse` (nomes fixados no CONVENTIONS).
 */
export interface CallFinishSignals {
  finishReason?: string;
  nativeFinishReason?: string;
  reasoningTokens?: number;
  /** `completion_tokens` da chamada (inclui raciocinio). */
  tokensOut: number;
  /** Tamanho do conteudo VISIVEL devolvido (chars). */
  contentChars: number;
  /** `max_tokens` enviado nesta chamada (o teto contra o qual o truncamento e medido). */
  maxTokens?: number;
  /** Decisao: a saida desta chamada foi cortada no teto. */
  truncated: boolean;
  /** Sinais observados (inclusive os auxiliares que sozinhos nao decidem). */
  truncationSignals?: TruncationSignal[];
  /** true = a 1a tentativa truncou e estes sinais sao do retry com teto x2. */
  truncationRetried?: boolean;
  /**
   * Sinais da 1a tentativa, a que TRUNCOU e foi repetida com teto x2 — qual
   * sinal disparou e quanto raciocinio ela gastou (calibra o teto, R-07b:REC-1).
   * Presente so quando `truncationRetried`.
   */
  firstAttempt?: CallFinishSignals;
  /**
   * Esforco de raciocinio EFETIVAMENTE enviado nesta chamada (IMPL-015): o
   * degrau ja encaixado na allowlist (`low`…`max`) ou `off`. Ausente = o
   * pedido nao levou `reasoning` (padrao do provedor). E a 2a dimensao da
   * taxa de truncamento por papel x esforco.
   */
  effort?: string;
}

/**
 * Sinais de fim AGREGADOS de um papel numa run (IMPL-014): contados no ponto
 * unico da contabilidade (gateway -> ledger), entao cobrem 100% das chamadas
 * que completaram — inclusive juiz, duelo, datagen e reescritor, que nao
 * guardam sinal por chamada no record. Cada tentativa conta (o retry x2 e uma
 * chamada).
 */
export interface FinishSignalCounts {
  /** Chamadas que completaram (com sinal de fim observado). */
  calls: number;
  /** Quantas sairam truncadas (decisao do gateway). */
  truncated: number;
  /** Histograma de `finish_reason` normalizado (`(none)` = ausente). */
  finishReasons: Record<string, number>;
  /** Histograma de `native_finish_reason` cru (`(none)` = ausente). */
  nativeFinishReasons: Record<string, number>;
  /** Quantas chamadas mostraram cada sinal (inclusive os auxiliares que sozinhos nao decidem). */
  signals: Partial<Record<TruncationSignal, number>>;
  /**
   * Quebra POR ESFORCO enviado (IMPL-015) — so as chamadas que levaram
   * `reasoning`; o resto (`calls - soma`) e o padrao do provedor. Ausente =
   * nenhuma chamada com esforco explicito (ou record anterior ao IMPL-015).
   */
  byEffort?: Record<string, { calls: number; truncated: number }>;
}

/** Motivo de uma saida de juiz CORTADA (IMPL-015) — subconjunto de `VerdictErrorKind`. */
export type JudgeCutKind = 'truncated' | 'timeout';

/** Por que uma etapa ficou `incomplete` (fora do placar e das medias). */
export type StageIncompleteReason = 'budget' | 'cancelled' | 'truncation';

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
  /**
   * A resposta FINAL saiu cortada no teto de tokens (IMPL-014), mesmo depois
   * do retry com teto x2. Etapa com resposta truncada fica `incomplete`
   * (`incompleteReason: 'truncation'`) — fora do placar e das medias. Ausente
   * = chamada que nao completou (erro/403) ou record anterior ao IMPL-014.
   */
  truncated?: boolean;
  /** `completion_tokens_details.reasoning_tokens` da tentativa final. */
  reasoningTokens?: number;
  /** `max_tokens` enviado na tentativa final (dobra quando houve retry por truncamento). */
  maxTokens?: number;
  /** Sinais de truncamento observados na tentativa final (ver `TruncationSignal`). */
  truncationSignals?: TruncationSignal[];
  /**
   * true = a 1a tentativa truncou e esta resposta e a do retry com teto x2.
   * `costUsd` soma as DUAS tentativas (o dinheiro saiu nas duas); tokens e
   * latencia sao da tentativa final.
   */
  truncationRetried?: boolean;
  /** Sinais da 1a tentativa (a truncada), quando houve retry por truncamento. */
  firstAttempt?: CallFinishSignals;
  /**
   * Ponteiro para os artefatos da execução de agente em disco. NUNCA o
   * conteúdo: o RunRecord é resserializado inteiro a cada saveRun (throttled
   * em 800ms) e embutir trajetórias tornaria cada escrita O(tudo que já rodou).
   */
  execution?: ExecutionRef;
}

/**
 * Veredito TERNARIO de uma etapa: a resposta resolve a tarefa, resolve
 * parcialmente, ou nao resolve. Mais robusto que o binario como portao de
 * qualidade (G-Eval / score absoluto como filtro). Ordem implicita: nao < parcial < resolve.
 */
export type Verdict = 'resolve' | 'parcial' | 'nao';

/**
 * Confiança do juiz no PRÓPRIO veredito (IMPL-047, R-03a:REC-7): campo `confianca`
 * do JSON do juiz (pointwise e duelo), pedida para triar revisão humana —
 * veredito 'baixa' é candidato natural a revisão. Mesmos valores (sem acento)
 * da confiança de evidência de `Technique`. Ausente em records antigos e em
 * vereditos de quem não devolveu o campo (o parse não derruba um veredito
 * válido só por isso — a triagem usa o campo quando presente).
 */
export type JudgeConfidence = 'baixa' | 'media' | 'alta';

/**
 * Componentes do contrato do juiz QUE MAIS ENTRAM no hash (IMPL-049,
 * R-03a:REC-9) além dos ids de juiz + prompt pointwise: o prompt do duelo, o
 * prompt listwise, o modelo de referência (quem escreve o gabarito), o think
 * level de julgamento e a política de provedor das chamadas de juiz. Trocar
 * qualquer componente muda a distribuição de veredito ⇒ muda o hash e sugere
 * recalibração. Campos ausentes entram vazios na serialização canônica.
 */
export interface JudgeContractComponents {
  /** Prompt do duelo (head-to-head; com o bloco de hierarquia no modo agente). */
  duelPromptText?: string;
  /** Prompt do juiz listwise (fallback sem gabarito). */
  listwisePromptText?: string;
  /** Modelo que escreve o gabarito (referência). */
  referenceModelId?: string;
  /** Think level efetivo do juiz (`reasoning.judge`; 'default' quando ausente). */
  judgeReasoningLevel?: string;
  /** Política de provedor das chamadas de juiz (ex.: roteamento ZDR forçado). */
  providerPolicy?: string;
}

/**
 * Fonte (papel) de um veredito usado no diagnóstico de verbosidade (IMPL-052):
 * pointwise (juiz contra gabarito), rótulo (ground-truth determinístico),
 * listwise (juiz clássico sem gabarito) e imputado ('auto' — resposta vazia e
 * afins, NUNCA entra na regressão). Papéis com calibrações distintas não
 * partilham regressão.
 */
export type VerdictSampleSource = 'pointwise' | 'rotulo' | 'listwise' | 'imputado';

/**
 * Diagnóstico de verbosidade em CAMADAS (IMPL-053, R-03b:REC-1): regressão
 * ORDINAL do veredito sobre `log(len_cand/len_ref)` + feitos de markdown, com
 * efeito fixo do cenário e do contestant, inferência por PERMUTAÇÃO do veredito
 * dentro do cenário e sondas contrafactuais (truncar/preencher 20% e re-julgar).
 * O Pearson agregado virou legenda descritiva (`VerbosityReport`) — o
 * diagnóstico é este: efeito + incerteza + n.
 */
export interface VerbosityDiag {
  /**
   * Efeito do comprimento relativo no veredito (coeficiente de
   * `log(len_cand/len_ref)` na regressão ordinal, em unidades latentes do
   * logit acumulado). `> 0` = respostas mais longas (vs a referência) pontuam
   * mais, mesmo controlando cenário/contestant/markdown.
   */
  betaLenRel: number;
  /** IC 95% de `betaLenRel` (bootstrap percentil estratificado por cenário). */
  ic95: [number, number];
  /** p do teste de PERMUTAÇÃO do veredito dentro do cenário (bicaudal). */
  pPermutacao: number;
  /** n de amostras válidas por fonte de veredito (papel). */
  nPorFonte: Record<string, number>;
  /**
   * Taxa de INVERSÃO das sondas contrafactuais (0..1): fração de respostas em
   * que truncar/preencher 20% mudou o veredito do juiz. Bom < 10%. `null` =
   * sondas não rodaram (re-julgamento é assíncrono — quem chama passa os pares).
   */
  taxaInversaoSondas: number | null;
  /**
   * Nota LC AUXILIAR por contestant (0..100): judge-score do contestant com o
   * comprimento fixado na mediana (predição do modelo ajustado). O judge-score
   * BRUTO (`judgeScoreByContestant`) permanece o primário — este só mostra
   * quanto da nota é comprimento.
   */
  judgeScoreLC: Record<string, number> | null;
}

// ----------------------------------------------------------------------------
// Veredito AUSENTE (IMPL-004, R-03b:REC-4) — nomes FIXOS do CONVENTIONS.
//
// Falha do juiz NÃO é veredito. Quando não há veredito legítimo (juiz falhou,
// saída inválida após o retry, timeout, bloqueio do gateway, erro de infra do
// competidor), a chave do contestant NÃO aparece em `verdictByContestant` —
// nunca se imputa 'parcial'/'nao'. O motivo vai no mapa paralelo
// `verdictErrorByContestant`; a origem de todo veredito PRESENTE vai em
// `verdictSourceByContestant`. Consumidores (placar, médias, pareamento,
// lições) tratam chave ausente como "sem observação", nunca como 'nao'.
// ----------------------------------------------------------------------------

/**
 * Origem de um veredito PRESENTE. `judge` = juiz LLM com o painel completo;
 * `auto` = regra determinística sem LLM (resposta ok VAZIA => 'nao');
 * `ground-truth` = rótulo esperado/oráculo; `degraded` = juiz LLM com painel
 * REDUZIDO (parte dos juízes falhou) — conta na regra de run inconclusiva.
 */
export type VerdictSource = 'judge' | 'auto' | 'ground-truth' | 'degraded';

export type VerdictErrorKind =
  | 'judge_failed'
  | 'invalid_output'
  | 'timeout'
  | 'truncated'
  | 'blocked'
  | 'competitor_error'
  | 'no_reference';

/** Por que um contestant ficou SEM veredito numa etapa. */
export interface VerdictError {
  kind: VerdictErrorKind;
  message: string;
}

/**
 * Voto de UM juiz para UMA resposta (IMPL-057, R-11a:REC-8): veredito +
 * explicação + confiança + canário persistidos POR JUIZ — antes o resultado
 * agregado descartava os singles e era impossível mostrar "2 de 3 juízes:
 * resolve", destacar o divergente ou calcular κ painel×humano. Juiz que FALHOU
 * entra com `error` e sem `verdict` (falha ≠ veredito).
 */
export interface JudgeVote {
  judgeModelId: string;
  /** Veredito deste juiz; ausente = este juiz falhou (motivo em `error`). */
  verdict?: Verdict;
  /** Explicação curta (1 frase) que este juiz deu para o seu veredito. */
  explanation?: string;
  /** Confiança que este juiz declarou no PRÓPRIO veredito (IMPL-047). */
  confianca?: JudgeConfidence;
  /** Canário devolvido por este juiz nesta chamada (IMPL-006). */
  canary?: string;
  /** Falha deste juiz (IMPL-057): só presente quando `verdict` está ausente. */
  error?: VerdictError;
}

/**
 * Por que um item entrou na fila `needs-human-review` (IMPL-055/IMPL-057).
 * Valores estáveis (dados de record, não decoração).
 */
export type HumanReviewReason =
  /** O gabarito gerado diverge da rubrica do cenário (verificação dirigida). */
  | 'reference_rubric_divergence'
  /** O 2º gabarito (família distinta) discordou do 1º — referência incerta. */
  | 'reference_disagreement'
  /** Amostra humana de auditoria (5–10%) acionada por discordância. */
  | 'reference_audit_sample'
  /** Veredito com confiança 'baixa' — triagem de revisão humana (IMPL-047). */
  | 'low_confidence_verdict';

/**
 * Item da fila `needs-human-review` (IMPL-055, R-03a:REC-1): o que um humano
 * precisa conferir antes de a run virar régua. A referência sintética é o elo
 * mais fraco (qualidade da referência > força do juiz) e erro de gabarito vira
 * veredito contra a resposta certa — a fila existe para NUNCA esconder isso.
 */
export interface HumanReviewItem {
  /** Índice da etapa (0-based, posição em `RunRecord.stages`). */
  stageIndex: number;
  /** Contestant afetado, quando o item é por veredito/resposta. */
  contestantId?: string;
  reason: HumanReviewReason;
  /** Detalhe curto em PT-BR (o que exatamente divergiu). */
  detail?: string;
  /** Custo humano estimado da revisão em USD (default da política: 0.025). */
  estimatedCostUsd?: number;
}

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
  /**
   * Canário do veredito (IMPL-006): código sorteado para a chamada que o juiz
   * devolveu no JSON — prova de que o veredito seguiu o bloco INSTRUÇÕES.
   * Ausente em records antigos.
   */
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
   * Confiança do juiz no veredito (IMPL-047): o campo `confianca` do JSON do
   * juiz, persistido por veredito para triar revisão humana. Com painel, vale o
   * MENOR `confianca` entre os votos legítimos (lado seguro da triagem). Só
   * para vereditos presentes; ausente quando nenhum voto devolveu o campo.
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
  /**
   * Canário de CADA voto legítimo (IMPL-006) — 1 por juiz que votou, na ordem
   * dos juízes. Só para vereditos presentes; ausente em records antigos.
   */
  canaryByContestant?: Record<string, string[]>;
  /**
   * Voto de CADA juiz por (etapa, contestant) (IMPL-057, R-11a:REC-8):
   * veredito + explicação + confiança + canário de cada juiz, ou a falha
   * (`error`) do juiz. Com isto a UI mostra a concordância do painel
   * ("2 de 3: resolve") e destaca o divergente; antes o resultado agregado
   * descartava os singles. Ausente em records antigos e em vereditos
   * determinísticos (ground-truth/auto — não há painel).
   */
  judgeVotesByContestant?: Record<string, JudgeVote[]>;
  judgeModelId: string;
  inconclusive?: boolean;
  /**
   * Veredito DE CADA repeticao, por contestant — contestantId -> vetor de
   * vereditos (1 por rep, na ordem das reps). Presente apenas quando o
   * referenceJudge vem do caminho de AGENTE com `repetitions > 1` (§18.4): cada
   * repeticao e uma observacao independente no denominador do judge-score, e
   * quem quer significancia precisa do vetor plano (cenario x repeticao), nao
   * so da media ordinal. Reps cortadas por limite (timeout/maxTurns/maxCost/
   * maxOutput) ENTRAM como 'nao' (IMPL-032); so reps canceladas (veredito null)
   * ficam fora — contadas em {@link ReferenceJudgeResult.repIncomplete}.
   */
  verdictsByRep?: Record<string, Verdict[]>;
  /**
   * Quantidade de repeticoes sem veredito (null) por contestant, so quando o
   * caminho de agente tem reps. Desde o IMPL-032 isso so acontece por
   * CANCELAMENTO (sinal de controle); corte por limite conta 'nao'.
   */
  repIncomplete?: Record<string, number>;
  /**
   * Repeticoes decididas pelo caminho 'limit-cut' da arvore de veredito, por
   * contestant de agente — ja contadas como 'nao' em `verdictByContestant`/
   * `verdictsByRep`. So alimenta o diagnostico "sucesso ate o limite"
   * ({@link RunRecord.censoredResolveRateByContestant}).
   */
  limitCutByContestant?: Record<string, number>;
  /**
   * IMPL-033 — repeticoes de agente em que o JUIZ falhou mesmo apos as 2
   * retentativas (flag `judgeError`), por contestant. Com oraculo, o veredito
   * da rep e o DO ORACULO (preservado — nunca 'parcial' imputado); sem
   * oraculo, a rep fica SEM veredito (conta tambem em `unscoredRepsByContestant`).
   */
  judgeErrorByContestant?: Record<string, number>;
  /**
   * IMPL-033 — repeticoes de agente SEM veredito por motivo que NAO e controle
   * nem comportamento do agente: rep SEM oraculo cujo juiz falhou (apos as 2
   * retentativas) ou nao foi chamado (sem juiz / dossie vazio). Ficam FORA do
   * denominador (sem observacao) — nunca viram 'nao' nem 'parcial'. Check do
   * oraculo que nao terminou NAO cai aqui: conta como check falho (ou, se nao
   * rodou em NENHUMA execucao da etapa, a etapa inteira vira `error` para todos).
   */
  unscoredRepsByContestant?: Record<string, number>;
}

/** Uma ordem de apresentação de um duelo, nos termos REAIS do par ('a' = 1º do par). */
export interface DuelOrderResult {
  winner: 'a' | 'b' | 'tie';
  explanation: string;
  /** Canário que o juiz devolveu nesta ordem (IMPL-006). Ausente no oráculo e em records antigos. */
  canary?: string;
  /**
   * Confiança do juiz nesta ordem (IMPL-047): o campo `confianca` do JSON do
   * duelo, por ordem (cada ordem é um veredito). Ausente no oráculo, em
   * records antigos e quando o juiz não devolveu o campo.
   */
  confidence?: JudgeConfidence;
}

/** Resultado de UM duelo pairwise (2 ordens; desacordo entre ordens = empate). */
export interface DuelOutcome {
  a: string;
  b: string;
  order1: DuelOrderResult;
  order2: DuelOrderResult;
  /** Resultado combinado das 2 ordens. */
  outcome: 'a' | 'b' | 'tie';
  /**
   * Quem decidiu (IMPL-004): `judge` = juiz LLM nas 2 ordens; `ground-truth` =
   * oráculo determinístico (scores de ground-truth/verify). Ausente em records
   * antigos.
   */
  source?: VerdictSource;
}

/**
 * Duelo SEM resultado legítimo (IMPL-004, R-03b:REC-4): alguma ordem falhou
 * (juiz caiu, timeout após a 2ª chance, saída inválida após o lembrete) ou
 * faltou régua. Antes a ordem que falhava virava EMPATE e o empate entrava no
 * placar — um veredito imputado. Agora o duelo vai para
 * `StageDuels.failedDuels` e NÃO pontua: fora de `duels`, nenhum consumidor
 * (standings, pódio, NDJSON) o conta por engano.
 */
export interface DuelFailure {
  a: string;
  b: string;
  /** Ordens que chegaram a produzir vencedor (só auditoria — não pontuam). */
  order1?: DuelOrderResult;
  order2?: DuelOrderResult;
  error: VerdictError;
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
  /** Estado ao vivo dos competidores nesta etapa (por contestantId); limpo apos stage.judged. */
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
   * Etapa interrompida no meio (orcamento/cancelamento) — NAO entra no placar
   * nem no julgamento. E o que separa "parou cedo, honesto" de "terminou,
   * mentindo": sem esta marca, uma etapa cortada viraria veredito 'parcial'.
   */
  incomplete?: boolean;
  /**
   * Motivo do `incomplete`: orcamento, cancelamento ou TRUNCAMENTO (IMPL-014:
   * uma resposta de competidor saiu cortada no teto mesmo apos o retry x2 —
   * a etapa nao e julgada, porque comparar resposta cortada com resposta
   * inteira mede o nosso teto, nao o prompt). Ausente em records antigos.
   * Nomes fixos em CONVENTIONS §4.
   */
  incompleteReason?: StageIncompleteReason;
  /**
   * Sinais de fim da chamada que gerou o gabarito desta etapa (IMPL-014). Com
   * `repeats > 1` fica so no 1o clone do cenario (o gabarito e 1 chamada).
   * `truncated: true` = o gabarito saiu cortado mesmo apos o retry x2 e foi
   * DESCARTADO (regua cortada nao julga ninguem) — a etapa segue sem `reference`
   * (julgada listwise) e o `stage.generated` leva um `warning` visivel.
   */
  gabaritoCall?: CallFinishSignals;
  startedAt: string;
  finishedAt?: string;
}

/**
 * `inconclusive` (IMPL-004, R-03b:REC-4): a run TERMINOU, mas a evidência não
 * sustenta conclusão — falha + julgamento degradado > 10% dos vereditos de
 * algum papel, ou n efetivo < 5 cenários julgados por contestant (ver
 * `engine/verdictIntegrity.ts`). É TERMINAL: use `isTerminalRunStatus`.
 */
export type RunStatus = 'running' | 'finished' | 'inconclusive' | 'error' | 'aborted';

/** Status em que a run/sessão não muda mais (fecha SSE/EventSource, polling, exit code). */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'finished',
  'inconclusive',
  'error',
  'aborted',
] as const;

/**
 * Helper PURO e ÚNICO para "a run acabou?" — listas soltas de status esqueciam
 * o status novo e o cliente reconectava para sempre. Aceita `string` porque o
 * record pode vir de disco/IndexedDB (status desconhecido => não-terminal).
 */
export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status ?? '');
}

/**
 * Diagnóstico de integridade do veredito da run (IMPL-004): a conta por trás do
 * status `inconclusive`, gravada para quem lê o record auditar a decisão.
 */
export interface VerdictIntegrity {
  /** Vereditos esperados por papel (denominador da taxa de falha). */
  expectedByRole: Partial<Record<CostRole, number>>;
  /** Vereditos DEGRADADOS (painel reduzido) por papel — somam às falhas. */
  degradedByRole: Partial<Record<CostRole, number>>;
  /** Cenários DISTINTOS com veredito legítimo, por contestant (n efetivo). */
  judgedScenariosByContestant: Record<string, number>;
  /** Limiares aplicados (registrados para a regra ser reproduzível). */
  maxFailureRate: number;
  minJudgedScenarios: number;
  /** Motivos em PT-BR quando inconclusiva; vazio = conclusiva. */
  reasons: string[];
}

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
  /**
   * n nominal × efetivo por contestant e pareamento com a régua (IMPL-005).
   * Ausente em runs antigas — `runs show` recalcula a partir das etapas.
   */
  completeness?: RunCompleteness;
  /**
   * Fração de 'resolve' entre os vereditos PLANOS (todas as etapas x todas as
   * repetições) por contestant, em 0..1 com 3 casas. Presente apenas quando ha
   * contestants de runner 'agent' (§18.4): e o numero que separa "resolve
   * sempre" de "resolve as vezes" na vida real — repeticoes 1 tornam esta
   * fracao (e qualquer outra estatistica) uma amostra de tamanho 1.
   * Desde a arvore v2 (IMPL-032) o corte por limite conta como 'nao' aqui.
   */
  resolveRateByContestant?: Record<string, number>;
  /**
   * DIAGNOSTICO "sucesso ate o limite" (metrica censurada): 'resolve' / (reps
   * julgadas − cortes por limite), por contestant de agente. Mostra o quanto o
   * agente acerta quando termina dentro dos tetos. NUNCA alimenta ranking,
   * finais nem gate — a metrica principal e `resolveRateByContestant`. Chave
   * ausente = todas as reps do contestant foram cortadas.
   */
  censoredResolveRateByContestant?: Record<string, number>;
  /** Reps de agente cortadas por limite (contadas como 'nao'), por contestant. */
  limitCutsByContestant?: Record<string, number>;
  /**
   * Versao da arvore de veredito de agente que produziu as notas (ver
   * `AGENT_VERDICT_TREE_VERSION` em `src/agent/verdictTree.ts`). AUSENTE numa
   * run com agente = legado v1 (corte por limite fora do denominador); notas
   * de versoes diferentes nao sao comparaveis.
   */
  agentVerdictTreeVersion?: number;
  /**
   * IMPL-033 (R-14a DEC-3) — quantas repeticoes de agente tiveram falha do
   * JUIZ (flag `judgeError`: excecao/timeout/saida invalida mesmo apos 2
   * retentativas). Presente (0 incluso) em toda run com agente, desde o
   * inicio — vale tambem para run abortada. A nota dessas reps e a do oraculo
   * (ou nenhuma, sem oraculo); nunca 'parcial' imputado.
   */
  agentJudgeErrorCount?: number;
  /** O mesmo, por contestant de agente (so as chaves com falha). */
  agentJudgeErrorsByContestant?: Record<string, number>;
  /**
   * Repeticoes de agente SEM veredito por motivo nao-controle (rep SEM oraculo
   * cujo juiz falhou ou nao foi chamado), por contestant. Fora de judge-score e
   * resolveRate. Na significancia, a etapa em que o contestant ficou SEM
   * nenhum veredito sai dos DOIS lados do par (IMPL-005, `pairedStageScores`).
   */
  agentUnscoredRepsByContestant?: Record<string, number>;
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
   * Fila `needs-human-review` (IMPL-055, R-03a:REC-1): itens cujo gabarito
   * divergiu da rubrica, cujo 2º gabarito (família distinta) discordou, ou a
   * amostra humana de auditoria (5–10%, acionada por discordância). A
   * referência sintética é o elo mais fraco da run — sem esta fila, erro de
   * gabarito vira veredito contra a resposta certa e ninguém fica sabendo.
   * Sai de `humanReviewQueueFromStages` (`engine/groundTruth.ts`) sobre as
   * validações gravadas em `StageRecord.spec.referenceValidation`; o re-read
   * preserva o campo (`normalizeRunRecord` espalha `...raw`).
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
     * Pin do contrato do juiz (IMPL-049 estendeu o hash): cobre juízes, os 3
     * prompts (pointwise/duelo/listwise), o modelo de referência, o think level
     * de julgamento e a política de provedor — trocar QUALQUER um muda o hash
     * e sugere recalibração (`judge.contract.changed`). `components` guarda a
     * entrada canônica usada (auditoria de granularidade).
     */
    contract: {
      hash: string;
      modelIds: string[];
      pinnedAt: string;
      components?: JudgeContractComponents;
    };
    /**
     * Viés de verbosidade (IMPL-052): a regressão deixa de misturar papéis —
     * só amostras VÁLIDAS da fonte-alvo entram; n por fonte e por célula
     * (fonte × contestant) e a conta de excluídos (vazios/truncados/imputados)
     * ficam no relatório.
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
       * auxiliar. Publicado POR `verbosityReport` (a chamada do orquestrador já
       * o carrega); `null`/ausente = n insuficiente para ajustar o modelo.
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
   * Custo TOTAL da run — todos os papeis, nao so os competidores. Antes contava
   * apenas `competitor.ts`, subcontando por um multiplo (juizes, gabarito,
   * datagen, duelos e o otimizador eram invisiveis). `costByContestant` continua
   * sendo a fatia dos competidores: gasto de juiz/duelo nao e atribuivel a um
   * contestant e nao deve ser espalhado neles.
   */
  totalCostUsd: number;
  /** Quebra do gasto por papel do pipeline. */
  costByRole?: Record<CostRole, CostEntry>;
  /** Quantas chamadas tiveram preco exato, estimado ou desconhecido. */
  costAccuracy?: { exact: number; estimated: number; unknown: number };
  /** Ledger: spent/committed/pending (IMPL-017). Ausente em records antigos. */
  costLedger?: CostLedgerSummary;
  /**
   * IMPL-074 — registo POR CHAMADA (id de geração, provedor, custo, estado da
   * conciliação), com teto `CALL_LOG_LIMIT`. Fora do `costLedger` de propósito:
   * não viaja em NDJSON/MCP. Ausente em records antigos.
   */
  callLog?: CallLogEntry[];
  /** Entradas que passaram do teto do `callLog` (não registadas). */
  callLogDropped?: number;
  /** BYOK: cobrado pelo provedor upstream, fora dos creditos do OpenRouter. */
  upstreamCostUsd?: number;
  /**
   * Desfechos nao-ok dos competidores, SEPARADOS (IMPL-010): `blocked` =
   * defesa do gateway (moderacao/guardrail — metrica de seguranca propria,
   * nunca falha do prompt), `refused` = recusa declarada pelo modelo, `error` =
   * infraestrutura. Ausente = record anterior a taxonomia.
   */
  competitorOutcomeCounts?: CompetitorOutcomeCounts;
  /**
   * Fracao (0..1, 4 casas) das chamadas de LLM desta run — TODOS os papeis:
   * competidor, gabarito, juiz, duelo, datagen, reescritor — que sairam
   * TRUNCADAS no teto de tokens (IMPL-014 / R-07b:REC-2), contando cada
   * tentativa (o retry x2 e uma chamada). Acima de `TRUNCATION_ALERT_RATE`
   * (2%) o CLI/UI alertam: o teto de tokens esta baixo para estes modelos.
   * A quebra por papel esta em `finishSignalsByRole`. Ausente = record
   * anterior ao IMPL-014.
   */
  truncationRate?: number;
  /** Numerador/denominador de `truncationRate` (chamadas com sinal de fim observado). */
  truncationCounts?: { calls: number; truncated: number };
  /**
   * Os 4 sinais de fim (finish_reason, native_finish_reason, raciocinio ≈ teto,
   * conteudo vazio com tokens) AGREGADOS por papel (IMPL-014), contados no
   * gateway para 100% das chamadas que completaram. So papeis com chamada.
   */
  finishSignalsByRole?: Partial<Record<CostRole, FinishSignalCounts>>;
  /** Teto de gasto configurado (ausente = sem limite). */
  budgetUsd?: number;
  /** true = a run parou porque o orcamento acabou. */
  budgetExhausted?: boolean;
  /** Fase em que a run parou (so quando parou cedo). */
  stoppedAtPhase?: RunPhase;
  /** Por que parou cedo. Discrimina o status 'aborted'. */
  stoppedReason?: 'budget' | 'cancelled';
  /**
   * Vereditos PERDIDOS por papel (IMPL-004), presente em toda run que terminou
   * o pipeline (0 = papel medido e sem falha): juiz que falhou/saida invalida
   * apos o lembrete/timeout apos a 2a chance/sem regua (judge), duelo sem
   * resultado (duel), erro de infra do competidor (competitor/agent), cenario
   * que pediu gabarito e ficou sem (gabarito). Bloqueio do gateway NAO entra
   * aqui (e defesa, contada a parte pelo `gw`) — mas reduz o n efetivo.
   */
  failureCountByRole?: Partial<Record<CostRole, number>>;
  /** A conta que decidiu `inconclusive` (IMPL-004). */
  verdictIntegrity?: VerdictIntegrity;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /**
   * cli#3 — classe da falha do gateway que derrubou a run (`auth` = key
   * recusada, `no_credit` = sem crédito…) e o status HTTP. Com isto o CLI sai
   * com o código documentado (4/5) em vez de 1; ausente = falha não
   * classificada ou record antigo.
   */
  errorKind?: 'auth' | 'blocked' | 'no_credit' | 'rate_limit' | 'http';
  errorHttpStatus?: number;
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
  /** Gate da iteração com o pareamento honesto (IMPL-005); ausente em sessões antigas. */
  gate?: IterationGate;
}

/** Como um p-valor/IC de troca de sinais foi calculado. */
export type SignificanceMethod = 'exact' | 'monte-carlo';

/**
 * Teste pareado campeão − controle (`pairedSignificance`, src/stats.ts — IMPL-001,
 * R-04:REC-1). Tudo em PONTOS de judge-score. `pValue` é UNILATERAL (H1: campeão >
 * controle, o do gate); o relatório mostra `pValueTwoSided`.
 */
export interface PairedSignificance {
  /** Pares nominais oferecidos ao teste (inclui os excluídos por observação ausente). */
  n: number;
  meanDiffPp: number;
  /** IC95% bilateral por inversão do teste; [-100, 100] = n sem resolução p/ excluir nada. */
  ci95Pp: [number, number];
  /** p unilateral (H1: campeão > controle). */
  pValue: number;
  /** p bilateral — o que o relatório exibe. */
  pValueTwoSided: number;
  /** Pares com observação nos DOIS lados (n − excludedPairs): os que entraram no teste. */
  nEfetivo: number;
  /** n′: pares com diferença ≠ 0 — os únicos que informam o teste. */
  nNonZero: number;
  /** Menor p unilateral atingível (2^−n′): com n′ = 5 nem o bilateral alcança 0,05. */
  pMinUnilateral: number;
  /** Pares excluídos por observação ausente em algum lado (nunca imputados). */
  excludedPairs: number;
  /** nEfetivo / n. */
  completeness: number;
  /** Método do p-valor: enumeração exata ou Monte Carlo semeado (B = 10.000). */
  method: SignificanceMethod;
  /** Método do IC (pode ser Monte Carlo com p exato quando há muitos valores distintos). */
  ciMethod: SignificanceMethod;
  /** Teste do sinal exato (sensibilidade): positivos/negativos entre os não nulos. */
  signTest: { positive: number; negative: number; pValue: number; pValueTwoSided: number };
  /**
   * Sensibilidade pior/melhor caso (IMPL-005) — só quando os pares excluídos
   * passam de 10% de `n`. `inconclusive` = a conclusão muda entre os casos.
   */
  sensitivity?: PairSensitivity<SignificanceConclusion>;
}

// ----------------------------------------------------------------------------
// Pareamento honesto (IMPL-005, R-04:REC-2). Par sem veredito sai DOS DOIS
// lados — nunca é imputado como 0/'nao' — e a diferença entre n nominal e n
// efetivo fica gravada e visível. Fonte única aqui; o web re-exporta.
// ----------------------------------------------------------------------------

/**
 * Cobertura de um pareamento campeão × controle: quantos pares havia, quantos
 * entraram (observação nos DOIS lados) e as médias SÓ sobre os pares completos.
 */
export interface PairCoverage {
  /** Pares nominais (etapas oferecidas ao pareamento, inclusive as sem veredito). */
  n: number;
  /** Pares com observação nos DOIS lados — os únicos que entram em médias e teste. */
  nEfetivo: number;
  /** n − nEfetivo: pares excluídos dos dois lados (nunca imputados). */
  excludedPairs: number;
  /** nEfetivo / n (4 casas); 1 quando n = 0 (nada faltou). */
  completeness: number;
  /** Judge-score médio do controle sobre os pares completos (p.p.); null sem par completo. */
  controlMeanPp: number | null;
  /** Judge-score médio do campeão sobre os pares completos (p.p.); null sem par completo. */
  championMeanPp: number | null;
  /** Δ = campeão − controle sobre os pares completos (p.p.); null sem par completo. */
  meanDiffPp: number | null;
  /**
   * Δ imputando os ausentes no PIOR caso (campeão perde todos: 0; controle ganha
   * todos: 1) — só quando as exclusões passam de 10% de `n`.
   */
  worstMeanDiffPp?: number;
  /** Δ imputando os ausentes no MELHOR caso (o inverso do pior) — idem. */
  bestMeanDiffPp?: number;
}

/** Conclusão do relatório de significância (teste BILATERAL a 5%). */
export type SignificanceConclusion = 'better' | 'worse' | 'no-difference';
/** Conclusão do gate de promoção (Δ ≥ minGain e p ajustado ≤ α — IMPL-002). */
export type GateConclusion = 'promote' | 'hold';

/** Um dos três cenários da análise de sensibilidade. */
export interface SensitivityCase<C extends string = string> {
  /** Δ campeão − controle neste cenário (p.p.). */
  meanDiffPp: number;
  /** p unilateral (H1: campeão > controle), quando a conclusão vem de um teste. */
  pValue?: number;
  /** p bilateral, idem. */
  pValueTwoSided?: number;
  conclusion: C;
}

/**
 * Análise de sensibilidade pior/melhor caso (R-04:REC-2): obrigatória quando as
 * exclusões passam de 10% dos pares. `observed` usa só os pares completos;
 * `worst`/`best` usam TODOS os pares, com os ausentes imputados no extremo.
 * Conclusão que muda entre os cenários → `inconclusive` ("inconclusivo").
 */
export interface PairSensitivity<C extends string = string> {
  /** excludedPairs / n que disparou a análise. */
  excludedFraction: number;
  /** Limiar aplicado (0,1) — gravado para a decisão ser reproduzível. */
  threshold: number;
  observed: SensitivityCase<C>;
  worst: SensitivityCase<C>;
  best: SensitivityCase<C>;
  inconclusive: boolean;
}

/** Correção de multiplicidade do gate da melhor de K (IMPL-002). */
export type MultiplicityMethod = 'max-t' | 'holm';

/** Uma variante no teste da melhor de K (escala p.p.). */
export interface BestOfKEntry {
  /** Δ pareado variante − régua (p.p.) sobre os pares completos. */
  gainPp: number;
  /** Pares completos com a régua. */
  nEfetivo: number;
  /** p unilateral marginal (sem correção). */
  pRaw: number;
  /** p unilateral ajustado (FWER sobre as K). */
  pAdjusted: number;
}

/**
 * Teste da melhor de K de UMA iteração (IMPL-002, R-04:REC-3): max-T por
 * permutação (Westfall-Young step-down, troca de sinais CONJUNTA por cenário)
 * ou Holm (fallback). Tudo UNILATERAL (H1: variante > régua).
 */
export interface BestOfKTest {
  method: MultiplicityMethod;
  /** Distribuição nula por enumeração exata ou Monte Carlo semeado. */
  enumeration: SignificanceMethod;
  /** 2^m vetores de sinais (exato) ou B (Monte Carlo). */
  permutations: number;
  /** Seed do Monte Carlo (ausente no exato). */
  seed?: number;
  /** α do gate (FWER unilateral). */
  alpha: number;
  /** Variantes testadas — a família do FWER (as que têm ≥ 1 par completo). */
  k: number;
  /** Cenários com ≥ 1 par completo. */
  nScenarios: number;
  /** p ajustado do `bestId` — o que o gate compara com `alpha`. */
  pAdjusted: number;
  /** p marginal do `bestId` (sem correção) — referência. */
  pRaw: number;
  /** Por variante (chave = contestantId). */
  byContestant: Record<string, BestOfKEntry>;
}

/** Condição do gate que segurou a promoção (IMPL-002). */
/**
 * `reeval` (IMPL-013): passou no gate da melhor de K, mas a re-avaliação LIMPA no
 * minibatch não confirmou a melhora (ou não chegou a rodar até o fim).
 */
export type GateHoldReason = 'no-pairs' | 'min-gain' | 'significance' | 'reeval';

/**
 * Re-avaliação LIMPA do candidato antes de confirmar a promoção (IMPL-013,
 * aceitação estilo GEPA): candidato e régua rodam de novo — respostas e
 * vereditos NOVOS — num minibatch de max(5, ceil(0,3·n)) cenários de treino.
 */
export interface PromotionReeval {
  /** Run da re-avaliação (ausente se ela nem começou). */
  runId?: string;
  candidateId: string;
  controlId: string;
  /** Cenários do minibatch = max(5, ceil(0,3·n)), limitado a n. */
  size: number;
  /** n: cenários de treino de onde o minibatch foi sorteado. */
  poolSize: number;
  /** Pareamento no minibatch (ausente se a run não terminou). */
  pairing?: PairCoverage;
  /** Δ candidato − régua nos pares completos do minibatch (p.p.). */
  gainPp: number;
  /** Melhora ESTRITA no minibatch → a promoção vale. */
  confirmed: boolean;
  /** Status da run quando ela não terminou (`error`/`aborted`) — não confirma. */
  runStatus?: string;
}

/**
 * Gate de promoção de UMA iteração do treino, com o pareamento honesto
 * best × régua (IMPL-005) e o teste da melhor de K (IMPL-002). Promove só se
 * Δ ≥ minGain E p ajustado ≤ α E a decisão sobrevive à sensibilidade.
 */
export interface IterationGate {
  controlId: string;
  bestId: string;
  /** Margem aplicada (p.p.): a do config, ou o default max(1; 50/nEfetivo). */
  minGain: number;
  /** IMPL-002: `config` = minGain explícito; `default` = max(1; 50/n). Ausente em sessões antigas. */
  minGainSource?: 'config' | 'default';
  /**
   * Δ best − régua (p.p.) só sobre os pares completos (0 sem par completo). É o
   * ganho BRUTO — o máximo entre K, inflado pela seleção (winner's curse).
   */
  gainPp: number;
  /**
   * IMPL-002: ganho CORRIGIDO do winner's curse (p.p.) = bruto − inflação
   * esperada da seleção entre K. Conservador; igual ao bruto com K = 1.
   */
  gainCorrectedPp?: number;
  pairing: PairCoverage;
  /** IMPL-002: o teste da melhor de K (ausente em sessões antigas). */
  test?: BestOfKTest;
  /** IMPL-002: o que segurou a promoção (ausente quando promoveu). */
  heldBy?: GateHoldReason[];
  /** Presente quando exclusões > 10%: a promoção só vale se for robusta. */
  sensitivity?: PairSensitivity<GateConclusion>;
  /** `inconclusive` = a decisão muda no pior/melhor caso → NÃO promove. */
  decision: 'promoted' | 'held' | 'inconclusive';
  /**
   * IMPL-013: re-avaliação limpa do candidato que passou no gate (ausente quando
   * o gate já segurou, e em sessões antigas). Não confirmada → `held` com
   * `heldBy: ['reeval']`.
   */
  reeval?: PromotionReeval;
}

/** Pareamento final da sessão (holdout, ou a última run de treino sem holdout). */
export interface SessionPairing extends PairCoverage {
  source: 'holdout' | 'training';
  controlId: string;
  championId: string;
}

/** Observações de UM contestant numa run (IMPL-005). */
export interface ObservationCoverage {
  /** Etapas nominais da run (todas, inclusive puladas/cortadas). */
  n: number;
  /** Etapas com veredito na régua primária da run. */
  nEfetivo: number;
  /** n − nEfetivo. */
  missing: number;
  /** nEfetivo / n (4 casas). */
  completeness: number;
  /**
   * Por que faltou: o `kind` do `verdictErrorByContestant` do juiz (IMPL-004),
   * `stage_error` (etapa pulada), `stage_incomplete` (cortada), `no_reference`
   * (etapa fora da régua primária) ou `no_verdict` (sem motivo registrado).
   */
  missingByReason?: Record<string, number>;
}

/** Completude da run: n nominal × efetivo por contestant e pares com a régua. */
export interface RunCompleteness {
  /** Etapas nominais da run. */
  n: number;
  /** Régua primária das observações: juiz por referência (pointwise) ou listwise. */
  ruler: 'reference' | 'listwise';
  byContestant: Record<string, ObservationCoverage>;
  /** Régua da run (`holdout-control` > `carry` > `original`), quando existe. */
  controlId?: string;
  /** Pareamento de cada contestant com a régua (chave = contestantId). */
  vsControl?: Record<string, PairCoverage>;
}

/**
 * `PairedSignificance` como fica gravado na sessão: sessões anteriores ao
 * IMPL-001 (bootstrap) só têm os 4 campos de base — os demais são opcionais.
 */
export type StoredSignificance = Pick<PairedSignificance, 'n' | 'meanDiffPp' | 'ci95Pp' | 'pValue'> &
  Partial<Omit<PairedSignificance, 'n' | 'meanDiffPp' | 'ci95Pp' | 'pValue'>>;

/**
 * IMPL-065 (R-05:REC-4): declaração de campeão sob âncora HUMANA. O zero-dataset
 * (tudo sintético) é BOOTSTRAP, não evidência: modelos atingem 84–89% em
 * benchmarks sintéticos e 25–34% em tarefas reais. Item curado = proveniência
 * humana (`origin` !== 'ai') E gabarito acompanhando o item (gabarito gerado
 * por IA não serve de âncora).
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
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /**
   * Gate de holdout: re-score campeao vs controle nos cenarios reservados.
   * Desde o IMPL-005 os scores sao medias SO sobre os pares com veredito nos
   * DOIS lados (`n` segue nominal; `nEfetivo`/`excludedPairs`/`completeness`
   * dizem quantos entraram — ausentes em sessoes antigas).
   */
  holdout?: {
    n: number;
    controlScore: number;
    championScore: number;
    gain: number;
    regressed: boolean;
    nEfetivo?: number;
    excludedPairs?: number;
    completeness?: number;
  };
  /**
   * Significancia estatistica: teste pareado EXATO por troca de sinais + IC por
   * inversao (IMPL-001; antes era bootstrap percentil). null = < 5 pares.
   */
  significance?: StoredSignificance | null;
  /**
   * Pareamento final (IMPL-005): n nominal × efetivo, pares excluidos e
   * completude da comparacao campeao × controle — presente MESMO quando
   * `significance` e null (n efetivo < 5), que e justamente quando importa.
   */
  pairing?: SessionPairing;
  /** Iteracao em que o treino convergiu (ganho < minGain), quando parou antes do fim. */
  convergedAtIteration?: number;
  /**
   * Motivo da convergencia (IMPL-051): 'patience' = N iteracoes seguidas sem
   * promocao (a paciencia configuravel, default 2); 'plateau' = o IC95 do
   * ganho termina abaixo de minGain (nenhum ganho plausivel alcança a margem).
   * Vai junto de `convergedAtIteration` e do evento `session.converged`.
   */
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
  /** Quebra do gasto por papel, somando todas as runs da sessao. */
  costByRole?: Record<CostRole, CostEntry>;
  /** Soma do `failureCountByRole` de todas as runs da sessao (IMPL-004). */
  failureCountByRole?: Partial<Record<CostRole, number>>;
  costAccuracy?: { exact: number; estimated: number; unknown: number };
  /** Ledger da sessao: spent/committed/pending (IMPL-017). */
  costLedger?: CostLedgerSummary;
  upstreamCostUsd?: number;
  budgetUsd?: number;
  budgetExhausted?: boolean;
  stoppedAtPhase?: RunPhase;
  stoppedReason?: 'budget' | 'cancelled';
  /** Iteracao em que o orcamento/cancelamento interrompeu a sessao. */
  stoppedAtIteration?: number;
  /**
   * true = o campeao NAO passou pelo gate de holdout (pulado por orcamento).
   * Sem holdout o campeao esta nao-validado contra sobreajuste — quem le o
   * resultado precisa saber disso.
   */
  holdoutSkipped?: boolean;
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
      /** Sinais de fim da chamada do gabarito desta etapa (IMPL-014). */
      gabaritoCall?: CallFinishSignals;
      /**
       * Aviso visivel (PT-BR) sobre a etapa — hoje: gabarito truncado mesmo apos
       * o retry x2 e DESCARTADO, entao a etapa e julgada sem gabarito.
       */
      warning?: string;
    }
  | { type: 'stage.failed'; runId: string; stageIndex: number; error: string }
  /**
   * Etapa marcada `incomplete` (IMPL-014): fica fora do placar e das medias.
   * Hoje so o truncamento emite (o corte por orcamento sai em `run.budget`).
   * `contestantIds` = quem truncou; NUNCA carrega o texto das respostas.
   */
  | {
      type: 'stage.incomplete';
      runId: string;
      stageIndex: number;
      reason: StageIncompleteReason;
      detail: string;
      contestantIds?: string[];
    }
  | { type: 'competitor.finished'; runId: string; stageIndex: number; response: CompetitorResponse }
  /**
   * Veredito INVALIDADO porque a saida do juiz foi cortada (IMPL-015):
   * `finish_reason: length` (teto de tokens) ou timeout. Nenhum veredito sai
   * de conteudo truncado — o contestant fica SEM veredito (`phase: 'judge'`,
   * pointwise/listwise) ou o duelo fica SEM resultado (`phase: 'duel'`, nunca
   * empate). `contestantIds` = quem ficou sem observacao; sem texto de resposta.
   */
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
   * Contrato do juiz MUDOU em relação ao último pin visto neste processo
   * (IMPL-049, R-03a:REC-9): o hash cobre juízes + prompts (pointwise, duelo,
   * listwise) + modelo de referência + think level + provedor. O aviso sugere
   * RECALIBRAÇÃO antes de comparar notas com runs antigas (calibrar um
   * contrato que mudou é desperdício). Evento agregado, sem `stageIndex` —
   * não entra no reducer de etapas (como `duel.progress`).
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
  /** Gasto acumulado (throttled). Hook do CLI para a linha de orcamento. */
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
  // --------------------------------------------------------------------------
  // Eventos ADITIVOS do modo agente. Vão pelo MESMO barramento (`events.ts`),
  // porque uma run de agente é uma run — quem já assina `subscribe(runId, ...)`
  // continua recebendo `stage.judged`, `run.spend`, etc. Consumidores existentes
  // precisam IGNORAR tipos desconhecidos em silêncio: o reducer da UI e o
  // `emitRunEvent` do CLI têm `switch` com casos enumerados; um evento novo
  // simplesmente não faz nada em runtime (correto).
  //
  // ⚠️ `agent.tool` NUNCA carrega a saída da ferramenta: um agente emite dezenas
  // de tool calls por etapa e a saída inteira estouraria a janela de contexto de
  // quem faz tail no stream. Quem quer a saída abre o arquivo.
  | { type: 'agent.started'; runId: string; stageIndex: number; contestantId: string;
      execId: string; repetition: number }
  | { type: 'agent.turn'; runId: string; stageIndex: number; contestantId: string;
      execId: string; turn: number; costUsd: number }
  | { type: 'agent.tool'; runId: string; stageIndex: number; contestantId: string;
      execId: string; toolName: string; ok: boolean;
      /** Só para bash: o comando, truncado em 200 chars. NUNCA a saída. */
      summary?: string }
  | { type: 'agent.finished'; runId: string; stageIndex: number; contestantId: string;
      execId: string; stopReason: AgentStopReason; turns: number; costUsd: number;
      diffStat?: { files: number; added: number; removed: number } }
  | { type: 'agent.verified'; runId: string; stageIndex: number; contestantId: string;
      execId: string; results: { label: string; ok: boolean; exitCode: number }[];
      /**
       * Tentativa do oráculo (IMPL-033): ausente = 1ª verificação; 2+ =
       * re-verificação cega de check que nem começou (só esses checks). O
       * resultado que vale para um check é o da MAIOR tentativa em que ele aparece.
       */
      attempt?: number };

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
  | { type: 'session.error'; sessionId: string; error: string };
