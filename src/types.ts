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

/**
 * Preco em USD por token. `null` = DESCONHECIDO (IMPL-018 / R-07b:REC-7): o
 * catalogo trouxe "-1" (roteadores como `openrouter/auto` — preco variavel),
 * valor ausente, nao numerico, nao finito ou negativo. Nunca vira 0 ("gratis")
 * nem numero negativo: antes o "-1" entrava como -1 e produzia estimativa e
 * reserva de orcamento NEGATIVAS em silencio. Quem precisa do numero trata o
 * `null` explicitamente (a tipagem obriga).
 */
export type TokenPrice = number | null;

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
    },
  ): void;
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
  /** Override do system message; ausente => usa stage.productContext (compare). */
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
  /** Margem minima de ganho (pp) sobre o campeao para promover; sem ganho = convergiu. Default 1.0. */
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
  /**
   * Sequential halving (F4.3, §8.5): com muitas variantes, uma passada de
   * TRIAGEM num subconjunto de cenários corta as piores antes da rodada
   * completa (o controle nunca é eliminado). Reduz custo sem afetar o ranking
   * final. Ausente/false = comportamento atual.
   */
  halving?: boolean;
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

export type CompetitorStatus = 'ok' | 'error';

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
  errorMsg?: string;
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
   * ternario (resolve|parcial => aceitavel). Respostas com erro/vazias = false.
   */
  acceptableByContestant: Record<string, boolean>;
  /** Veredito TERNARIO agregado por contestant (consenso entre juizes). Ausente em records antigos. */
  verdictByContestant?: Record<string, Verdict>;
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
  /** Veredito ternario por contestant (consenso entre juizes, quando ha mais de um). */
  verdictByContestant: Record<string, Verdict>;
  /** Explicacao curta (1 frase) por contestant. */
  explanationByContestant: Record<string, string>;
  judgeModelId: string;
  inconclusive?: boolean;
  /**
   * Veredito DE CADA repeticao, por contestant — contestantId -> vetor de
   * vereditos (1 por rep, na ordem das reps). Presente apenas quando o
   * referenceJudge vem do caminho de AGENTE com `repetitions > 1` (§18.4): cada
   * repeticao e uma observacao independente no denominador do judge-score, e
   * quem quer significancia precisa do vetor plano (cenario x repeticao), nao
   * so da media ordinal. Reps `incomplete` (veredito null, §18.3) NAO entram no
   * vetor — sao contadas em {@link ReferenceJudgeResult.repIncomplete}.
   */
  verdictsByRep?: Record<string, Verdict[]>;
  /**
   * Quantidade de repeticoes `incomplete` (veredito null, §18.3) por contestant,
   * so quando o caminho de agente tem reps. Uma rep incompleta nao pontua nem
   * conta como 'nao' — a culpa foi do nosso teto, nao do agente; registrar a
   * contagem permite ao leitor saber quantas observacoes foram perdidas.
   */
  repIncomplete?: Record<string, number>;
}

/** Resultado de UM duelo pairwise (2 ordens; desacordo entre ordens = empate). */
export interface DuelOutcome {
  a: string;
  b: string;
  order1: { winner: 'a' | 'b' | 'tie'; explanation: string };
  order2: { winner: 'a' | 'b' | 'tie'; explanation: string };
  /** Resultado combinado das 2 ordens. */
  outcome: 'a' | 'b' | 'tie';
}

/**
 * Duelos round-robin da etapa (bracket top-K): placar Copeland (vitoria 1,
 * empate 0.5) com placements fracionarios quando ha empate de pontos.
 */
export interface StageDuels {
  /** Placement final por contestant (1 = melhor; fracionario em empate). */
  placementByContestant: Record<string, number>;
  /** ContestantIds ordenados do melhor ao pior placement. */
  order: string[];
  /** Pontos Copeland por contestant. */
  points: Record<string, number>;
  duels: DuelOutcome[];
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
  /** Duelos pairwise (Copeland) da etapa (quando duelos ligados). */
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
  startedAt: string;
  finishedAt?: string;
}

export type RunStatus = 'running' | 'finished' | 'error' | 'aborted';

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
   * Fração de 'resolve' entre os vereditos PLANOS (todas as etapas x todas as
   * repetições) por contestant, em 0..1 com 3 casas. Presente apenas quando ha
   * contestants de runner 'agent' (§18.4): e o numero que separa "resolve
   * sempre" de "resolve as vezes" na vida real — repeticoes 1 tornam esta
   * fracao (e qualquer outra estatistica) uma amostra de tamanho 1.
   */
  resolveRateByContestant?: Record<string, number>;
  /** Classificacao final agregada (Copeland dos duelos / pontos do placar). */
  standings?: {
    id: string;
    label: string;
    isControl: boolean;
    points: number;
    wins: number;
    ties: number;
    losses: number;
    winRate: number;
  }[];
  /** Ids dos finalistas (top-N por judge-score) que disputaram os duelos. */
  finalists?: string[];
  /** Avisos de imparcialidade (F3.6): juiz da familia do competidor, etc. NAO-bloqueantes. */
  fairnessWarnings?: string[];
  /** Diagnostico do juiz (F4.2): pin do contrato (hash) + vies de verbosidade medido. */
  judgeDiagnostics?: {
    contract: { hash: string; modelIds: string[]; pinnedAt: string };
    verbosity: { n: number; r: number; biased: boolean; warning: string };
  };

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
  /** Teto de gasto configurado (ausente = sem limite). */
  budgetUsd?: number;
  /** true = a run parou porque o orcamento acabou. */
  budgetExhausted?: boolean;
  /** Fase em que a run parou (so quando parou cedo). */
  stoppedAtPhase?: RunPhase;
  /** Por que parou cedo. Discrimina o status 'aborted'. */
  stoppedReason?: 'budget' | 'cancelled';
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
  /** Gate de holdout: re-score campeao vs controle nos cenarios reservados. */
  holdout?: {
    n: number;
    controlScore: number;
    championScore: number;
    gain: number;
    regressed: boolean;
  };
  /** Significancia estatistica (bootstrap pareado). null = amostra insuficiente. */
  significance?: {
    n: number;
    meanDiffPp: number;
    ci95Pp: [number, number];
    pValue: number;
  } | null;
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
  | { type: 'stage.generated'; runId: string; stageIndex: number; spec: StageSpec }
  | { type: 'stage.failed'; runId: string; stageIndex: number; error: string }
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
      execId: string; results: { label: string; ok: boolean; exitCode: number }[] };

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
  | { type: 'iteration.promoted'; sessionId: string; iteration: number; championId: string; gain: number }
  | { type: 'session.holdout'; sessionId: string; holdout: SessionRecord['holdout'] }
  | { type: 'session.converged'; sessionId: string; iteration: number }
  | { type: 'session.finished'; sessionId: string; record: SessionRecord }
  | { type: 'session.error'; sessionId: string; error: string };
