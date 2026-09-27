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
import type { ExpectedSpec } from './engine/groundTruth.js';
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
 * cache, tokens de raciocinio e faixas de preco). `catalog` = derivado dos
 * precos do /models. `unknown` = modelo fora do catalogo, NAO conseguimos
 * precificar — nunca confundir com "custou zero".
 */
export type CostSource = 'usage' | 'catalog' | 'unknown';

export interface CallCost {
  usd: number;
  source: CostSource;
  /** BYOK: cobrado direto pelo provedor upstream, fora dos creditos. */
  upstreamUsd?: number;
}

export interface CostEntry {
  calls: number;
  usd: number;
  tokensIn: number;
  tokensOut: number;
}

/** Reserva otimista devolvida por `CostSink.reserve`. */
export interface Reservation {
  release(): void;
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
  ): Reservation;
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
       * Sinais de fim da chamada (IMPL-014) — presentes quando a chamada
       * COMPLETOU (ausentes no 200 com corpo de erro, que lanca). E por aqui
       * que os sinais de TODO papel (juiz, duelo, datagen, reescritor…) chegam
       * ao RunRecord sem cada papel precisar persisti-los.
       */
      finish?: CallFinishSignals;
    },
  ): void;
  /**
   * LGPD (IMPL-042): identidade do escopo do cofre de pseudonimos — a RAIZ do
   * ledger (run avulsa ou sessao de treino). Mesmo escopo = mesmos tokens em
   * todos os papeis; escopos diferentes = chaves diferentes (sem ligacao entre
   * runs). Opcional: sem ele o proprio sink e o escopo.
   */
  piiScope?(): object;
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
   * Perfil de conformidade LGPD escolhido no assistente (passo Tema). CONSULTIVO:
   * gravado para transparencia/rastreabilidade do run; NAO forca roteamento de
   * providers no OpenRouter. Ausente = "livre" (sem filtro de conformidade).
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
  /** Fracao de cenarios reservada p/ holdout (clamp [0, 0.5]). Default 0.2. */
  holdoutRatio?: number;
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
   */
  paretoPool?: number;
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
   */
  tier?: string;
  dimensionTags?: string[];
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
}

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
   * LGPD (IMPL-042): campos do config com dado pessoal que o pre-voo achou
   * (caminho + tipos + veredito, NUNCA o valor) e se o usuario os liberou com
   * `allowPii`. E o registro de que os identificadores foram pseudonimizados
   * no envio — nao uma correcao silenciosa.
   */
  piiReport?: PiiRunReport;
  /** Diagnostico do juiz (F4.2): pin do contrato (hash) + vies de verbosidade medido. */
  judgeDiagnostics?: {
    contract: { hash: string; modelIds: string[]; pinnedAt: string };
    verbosity: { n: number; r: number; biased: boolean; warning: string };
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
export type GateHoldReason = 'no-pairs' | 'min-gain' | 'significance';

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
  /** Pool Pareto final (F4.1): prompts não-dominados por fatia que sobreviveram. */
  pool?: { id: string; label: string; bySlice: Record<string, number> }[];
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
  | { type: 'session.converged'; sessionId: string; iteration: number }
  | { type: 'session.finished'; sessionId: string; record: SessionRecord }
  | { type: 'session.error'; sessionId: string; error: string };
