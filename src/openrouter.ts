import { applyReasoning } from './reasoning.js';
import type {
  CallCost,
  CostRole,
  CostSink,
  ModelReasoningMeta,
  OpenRouterModel,
  OpenRouterModelPricing,
  PricingTier,
  ReasoningLevel,
} from './types.js';

// ===========================================================================
// GATEWAY UNICO de LLM — o MESMO codigo roda no Node (CLI, servidor, API de
// biblioteca) e no navegador (SPA; `web/src/engine/openrouter.ts` e shim deste
// arquivo). IMPL-021 / R-09:REC-2.
//
// Regra: este modulo NAO le ambiente e NAO importa nada de `node:*`. Tudo que
// antes vinha do processo (base URL, headers de atribuicao, teto do limitador)
// e CONFIGURACAO INJETADA:
//   - Node: `src/gatewayEnv.ts` le as variaveis OPENROUTER_* e chama
//     `configureGateway` nos pontos de entrada (CLI, servidor, src/index.ts);
//   - navegador: o shim do web chama `configureGateway` com a origem da pagina.
//
// O estado mutavel (limitador AIMD, cache de catalogo) vive numa INSTANCIA de
// `OpenRouterGateway`, nunca solto no modulo. O processo/aba usa UMA instancia
// padrao (`getGateway()`), compartilhada por todas as chamadas — e isso que faz
// datagen, competidores, juizes, duelos e reescritor dividirem o mesmo
// semaforo. Testes criam instancias proprias (`createGateway({ fetch })`) ou
// trocam a padrao (`setDefaultGateway`) sem tocar em rede real.
// ===========================================================================

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_APP_URL = 'http://localhost:3000';
const DEFAULT_APP_TITLE = 'Prompt Builder';
const DEFAULT_MAX_CONCURRENCY = 32;
const INITIAL_CONCURRENCY = 8;
const MIN_CONCURRENCY = 1;
/** Re-tentativas de transientes (429/5xx/rede). 1 + 6 = no maximo 7 tentativas. */
export const MAX_RETRIES = 6;
const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Transporte HTTP. Assinatura minima do `fetch` padrao (Node 18+ e navegador). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GatewayConfig {
  /** Base da API compativel com a OpenRouter (proxy corporativo, mock). Sem barra final. */
  baseUrl: string;
  /** Header `HTTP-Referer` de atribuicao. */
  appUrl: string;
  /** Header `X-Title` de atribuicao. */
  appTitle: string;
  /** Teto do limitador adaptativo (>= 1). */
  maxConcurrency: number;
  /** TTL do cache de catalogo em memoria. */
  modelsCacheTtlMs: number;
  /**
   * Transporte. AUSENTE = `globalThis.fetch` resolvido NA HORA de cada chamada
   * (assim `vi.stubGlobal('fetch', …)` continua funcionando). ⚠️ Nunca chame
   * como metodo de outro objeto (`cfg.fetch(url)`): no navegador isso vira
   * "Illegal invocation". Aqui ele e sempre copiado para uma variavel local.
   */
  fetch?: FetchLike;
  /** Espera entre re-tentativas (testes injetam uma espera nula). */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_CONFIG: GatewayConfig = {
  baseUrl: DEFAULT_OPENROUTER_BASE_URL,
  appUrl: DEFAULT_APP_URL,
  appTitle: DEFAULT_APP_TITLE,
  maxConcurrency: DEFAULT_MAX_CONCURRENCY,
  modelsCacheTtlMs: MODELS_CACHE_TTL_MS,
};

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Mescla um patch sobre a config. Campos obrigatorios `undefined` sao
 * IGNORADOS (um `baseUrl: undefined` nao pode apagar a base); `fetch`/`sleep`
 * presentes como `undefined` voltam ao default. Concorrencia invalida (NaN,
 * < 1) e ignorada — antes um OPENROUTER_MAX_CONCURRENCY nao numerico virava
 * NaN e travava o semaforo para sempre.
 */
function mergeConfig(base: GatewayConfig, patch: Partial<GatewayConfig>): GatewayConfig {
  const out: GatewayConfig = { ...base };
  if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) {
    out.baseUrl = normalizeBaseUrl(patch.baseUrl);
  }
  if (typeof patch.appUrl === 'string') out.appUrl = patch.appUrl;
  if (typeof patch.appTitle === 'string') out.appTitle = patch.appTitle;
  if (typeof patch.maxConcurrency === 'number' && Number.isFinite(patch.maxConcurrency)) {
    out.maxConcurrency = Math.max(MIN_CONCURRENCY, Math.floor(patch.maxConcurrency));
  }
  if (typeof patch.modelsCacheTtlMs === 'number' && Number.isFinite(patch.modelsCacheTtlMs)) {
    out.modelsCacheTtlMs = Math.max(0, patch.modelsCacheTtlMs);
  }
  if ('fetch' in patch) out.fetch = patch.fetch;
  if ('sleep' in patch) out.sleep = patch.sleep;
  return out;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Limitador de concorrencia ADAPTATIVO (AIMD), por instancia de gateway.
// O limite CRESCE no sucesso (so quando ha pressao: saturado ou com fila) e
// RECUA pela metade quando o provedor devolve 429 — converge para o maximo que
// o provedor aguenta, "brigando" para rodar no teto sem derrubar com 429.
// ---------------------------------------------------------------------------

export interface LimiterSnapshot {
  limit: number;
  active: number;
  queued: number;
}

export class AimdLimiter {
  private limit: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private max: number) {
    this.limit = Math.min(INITIAL_CONCURRENCY, max);
  }

  /** Novo teto. O limite corrente nunca passa dele (mesma regra do valor inicial). */
  setMax(max: number): void {
    this.max = max;
    this.limit = Math.min(this.limit, max);
  }

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    this.active -= 1;
    while (this.waiters.length > 0 && this.active < this.limit) {
      const next = this.waiters.shift()!;
      this.active += 1;
      next();
    }
  }

  /** Aumento aditivo: +1, so quando ha pressao, ate o teto. */
  noteSuccess(): void {
    if (this.limit < this.max && (this.active >= this.limit || this.waiters.length > 0)) {
      this.limit += 1;
    }
  }

  /** Recuo multiplicativo: metade, com piso 1. */
  noteRateLimit(): void {
    this.limit = Math.max(MIN_CONCURRENCY, Math.floor(this.limit / 2));
  }

  snapshot(): LimiterSnapshot {
    return { limit: this.limit, active: this.active, queued: this.waiters.length };
  }
}

// ---------------------------------------------------------------------------
// Determinismo POR MODELO. Reasoning models (gpt-5*, serie o*) REJEITAM
// temperature != 1 (HTTP 400 -> resposta vazia, foi o bug do gpt-5-nano).
// Decidimos quais parametros de amostragem enviar pelo `supported_parameters`
// do OpenRouter (fonte de verdade, ja em cache via listModels); sem isso,
// caimos numa heuristica por nome. So enviamos temperature/seed a quem
// suporta — buscando o MAXIMO de determinismo que cada modelo permite.
// ---------------------------------------------------------------------------
const DETERMINISTIC_SEED = 1234;

function looksLikeReasoning(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (id.includes('gpt-5-chat')) return false; // a variante chat aceita temperature
  // OpenAI serie o (o1..o4) e GPT-5 reasoning rejeitam temperature != 1.
  return /(^|\/)(o[1-4]([.\-]|$)|gpt-5|gpt-oss)/.test(id);
}

/**
 * Monta os parametros de amostragem com determinismo na medida que cada modelo
 * permite. So inclui temperature/seed quando o modelo os suporta — senao
 * reasoning models respondem vazio. `desiredTemperature` (default 0) e usado
 * apenas onde temperature e aceita.
 */
function deterministicSampling(
  model: OpenRouterModel | undefined,
  modelId: string,
  desiredTemperature: number,
): { temperature?: number; seed?: number } {
  const supported = model?.supportedParameters;
  if (supported && supported.length > 0) {
    const out: { temperature?: number; seed?: number } = {};
    if (supported.includes('temperature')) out.temperature = desiredTemperature;
    if (supported.includes('seed')) out.seed = DETERMINISTIC_SEED;
    return out;
  }
  // sem metadados de suporte: omite temperature em reasoning (seed desconhecido).
  return looksLikeReasoning(modelId) ? {} : { temperature: desiredTemperature };
}

/**
 * Capacidades de ajuste declaradas pelo modelo (`supported_parameters`).
 * `reasoning` = aceita `reasoning` OU `reasoning_effort`; `effort` = aceita os
 * degraus discretos de `reasoning_effort` (formato nativo, ver applyReasoning).
 * Sem metadados: assume temperature (a heuristica looksLikeReasoning ainda
 * decide se ela vai no body) e nenhum controle de raciocinio.
 */
export function modelTuningCaps(m?: {
  supportedParameters?: string[];
  reasoning?: ModelReasoningMeta;
}): {
  temperature: boolean;
  reasoning: boolean;
  effort: boolean;
  /** Degraus que ESTE modelo aceita (ausente = sem restricao). */
  supportedEfforts?: string[];
  defaultEffort?: string;
  /** true = raciocinio nao pode ser desligado. */
  mandatory: boolean;
} {
  const supported = m?.supportedParameters;
  if (!supported || supported.length === 0) {
    return { temperature: true, reasoning: false, effort: false, mandatory: false };
  }
  const effort = supported.includes('reasoning_effort');
  return {
    temperature: supported.includes('temperature'),
    reasoning: effort || supported.includes('reasoning'),
    effort,
    supportedEfforts: m?.reasoning?.supportedEfforts,
    defaultEffort: m?.reasoning?.defaultEffort,
    mandatory: m?.reasoning?.mandatory ?? false,
  };
}

/**
 * Traduz uma resposta de erro da OpenRouter para uma mensagem clara em PT-BR.
 * 401/403 = key invalida/expirada/sem permissao; 402 = sem credito; 429 = rate limit.
 */
function describeOpenRouterError(status: number, body: string): string {
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (status === 401 || status === 403) {
    return `OpenRouter recusou a key (HTTP ${status}): a key e invalida, expirou ou nao tem permissao. Reconfigure em Configuracoes.${snippet ? ` Detalhe: ${snippet}` : ''}`;
  }
  if (status === 402) {
    return `OpenRouter sem credito (HTTP 402): adicione creditos na sua conta.${snippet ? ` Detalhe: ${snippet}` : ''}`;
  }
  if (status === 429) {
    return `OpenRouter rate limit (HTTP 429): aguarde e tente novamente.${snippet ? ` Detalhe: ${snippet}` : ''}`;
  }
  return `OpenRouter falhou (HTTP ${status})${snippet ? `: ${snippet}` : ''}`;
}

function parsePrice(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Faixas de preco por tamanho de prompt (`pricing.overrides`). O campo existe
 * no catalogo mas nao esta documentado; sem ele, o custo de runs de contexto
 * longo sai 3-7x menor que o real.
 */
function parsePricingTiers(value: unknown): PricingTier[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const tiers: PricingTier[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    const min = typeof t.min_prompt_tokens === 'number' ? t.min_prompt_tokens : Number(t.min_prompt_tokens);
    if (!Number.isFinite(min)) continue;
    tiers.push({
      minPromptTokens: min,
      prompt: parsePrice(t.prompt),
      completion: parsePrice(t.completion),
    });
  }
  return tiers.length > 0 ? tiers.sort((a, b) => a.minPromptTokens - b.minPromptTokens) : undefined;
}

/** Preco efetivo do modelo para um prompt deste tamanho (respeita as faixas). */
export function tierFor(
  pricing: OpenRouterModelPricing,
  promptTokens: number,
): { prompt: number; completion: number } {
  let melhor = { prompt: pricing.prompt, completion: pricing.completion };
  let melhorMin = -1;
  for (const t of pricing.overrides ?? []) {
    if (promptTokens >= t.minPromptTokens && t.minPromptTokens > melhorMin) {
      melhor = { prompt: t.prompt, completion: t.completion };
      melhorMin = t.minPromptTokens;
    }
  }
  return melhor;
}

/**
 * Custo derivado do CATALOGO. E o plano B de `priceUsage` (a fonte primaria e
 * `usage.cost`) e a base do estimador de pre-voo. Respeita `pricing.overrides`.
 */
export function computeCost(
  tokensIn: number,
  tokensOut: number,
  model: OpenRouterModel | undefined,
): number {
  if (!model) return 0;
  const preco = tierFor(model.pricing, tokensIn);
  return tokensIn * preco.prompt + tokensOut * preco.completion;
}

// ---------------------------------------------------------------------------
// Extracao de uso/custo da resposta
// ---------------------------------------------------------------------------

export interface UsageInfo {
  tokensIn: number;
  tokensOut: number;
  /** Creditos EFETIVAMENTE cobrados. Fonte primaria de custo. */
  cost?: number;
  upstreamCost?: number;
  cachedTokensIn?: number;
  reasoningTokens?: number;
}

/**
 * Le o bloco `usage` da resposta. O OpenRouter SEMPRE o devolve hoje
 * (`usage:{include:true}` virou no-op deprecado — por isso nao e enviado) e
 * `usage.cost` e o valor exato cobrado — ja inclui leitura/escrita de cache,
 * tokens de raciocinio e as faixas de `pricing.overrides`. Derivar do
 * catalogo e so o plano B.
 */
export function extractUsage(u: unknown): UsageInfo {
  if (!u || typeof u !== 'object') return { tokensIn: 0, tokensOut: 0 };
  const usage = u as Record<string, unknown>;
  const promptDetails = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completionDetails = (usage.completion_tokens_details ?? {}) as Record<string, unknown>;
  const costDetails = (usage.cost_details ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  return {
    tokensIn: num(usage.prompt_tokens) ?? 0,
    tokensOut: num(usage.completion_tokens) ?? 0,
    cost: num(usage.cost),
    upstreamCost: num(costDetails.upstream_inference_cost),
    cachedTokensIn: num(promptDetails.cached_tokens),
    reasoningTokens: num(completionDetails.reasoning_tokens),
  };
}

/**
 * Precifica uma chamada. Ordem: valor cobrado (`usage.cost`) > catalogo >
 * desconhecido. `unknown` NUNCA e o mesmo que "custou zero" — e o que permite
 * avisar o usuario de que o orcamento esta operando as cegas.
 */
export function priceUsage(u: UsageInfo, model: OpenRouterModel | undefined): CallCost {
  if (typeof u.cost === 'number' && Number.isFinite(u.cost)) {
    return { usd: u.cost, source: 'usage', upstreamUsd: u.upstreamCost };
  }
  if (model) {
    return { usd: computeCost(u.tokensIn, u.tokensOut, model), source: 'catalog' };
  }
  return { usd: 0, source: 'unknown' };
}

/** Estimativa grosseira de tokens de prompt — so dimensiona a reserva otimista. */
function guessPromptTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += m.content.length;
  return Math.ceil(chars / 4);
}

/**
 * Aplica o teto de preco POR REQUISICAO. ⚠️ `provider.max_price` e USD por
 * MILHAO de tokens; o catalogo e USD por token. O valor entra aqui VERBATIM,
 * ja na unidade certa — nenhuma conversao acontece neste arquivo.
 */
function applyMaxPrice(
  body: Record<string, unknown>,
  maxPrice: { prompt?: number; completion?: number } | undefined,
): void {
  if (!maxPrice || (maxPrice.prompt === undefined && maxPrice.completion === undefined)) return;
  const provider = (body.provider ?? {}) as Record<string, unknown>;
  const cap: Record<string, number> = {};
  if (maxPrice.prompt !== undefined) cap.prompt = maxPrice.prompt;
  if (maxPrice.completion !== undefined) cap.completion = maxPrice.completion;
  body.provider = { ...provider, max_price: cap };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function backoffMs(attempt: number): number {
  const base = Math.min(8000, 250 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250); // jitter
}

/**
 * Le o objeto `reasoning` de um item de /models. E ele que diz QUAIS degraus de
 * esforco o modelo aceita (`supported_efforts`, ordem decrescente; ausente = sem
 * restricao) e se raciocinio pode ser desligado (`mandatory`). Sem ele, so daria
 * para chutar o esforco e levar 400.
 */
function parseReasoningMeta(raw: unknown): ModelReasoningMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const efforts = Array.isArray(r.supported_efforts)
    ? (r.supported_efforts as unknown[]).map((e) => String(e))
    : undefined;
  return {
    mandatory: typeof r.mandatory === 'boolean' ? r.mandatory : undefined,
    defaultEnabled: typeof r.default_enabled === 'boolean' ? r.default_enabled : undefined,
    supportedEfforts: efforts,
    defaultEffort: typeof r.default_effort === 'string' ? r.default_effort : undefined,
    supportsMaxTokens: typeof r.supports_max_tokens === 'boolean' ? r.supports_max_tokens : undefined,
  };
}

/** Converte o payload cru de /models no tipo de dominio (puro; exportado p/ testes). */
export function parseModelsPayload(json: unknown): OpenRouterModel[] {
  const raw = Array.isArray((json as { data?: unknown[] } | null)?.data)
    ? ((json as { data: unknown[] }).data)
    : [];
  return raw.map((m) => {
    const item = m as Record<string, unknown>;
    const pricing = (item.pricing ?? {}) as Record<string, unknown>;
    return {
      id: String(item.id ?? ''),
      name: String(item.name ?? item.id ?? ''),
      contextLength:
        typeof item.context_length === 'number' ? (item.context_length as number) : undefined,
      pricing: {
        prompt: parsePrice(pricing.prompt),
        completion: parsePrice(pricing.completion),
        overrides: parsePricingTiers(pricing.overrides),
      },
      supportedParameters: Array.isArray(item.supported_parameters)
        ? (item.supported_parameters as unknown[]).map((p) => String(p))
        : undefined,
      reasoning: parseReasoningMeta(item.reasoning),
      raw: item,
    };
  });
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  raw: unknown;
  /** Custo da chamada. Sempre presente; a honestidade fica em `cost.source`. */
  cost: CallCost;
  cachedTokensIn?: number;
  reasoningTokens?: number;
}

export interface ChatCompletionParams {
  apiKey: string;
  modelId: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  responseFormatJson?: boolean;
  // Nivel de raciocinio (reasoning effort). Ausente = nao envia `reasoning`
  // (comportamento anterior, identico). 'off' desliga explicitamente.
  reasoningLevel?: ReasoningLevel;
  /** Papel desta chamada no pipeline — granularidade do ledger de gasto. */
  role?: CostRole;
  /** Ledger. Ausente = nao contabiliza (compatibilidade com chamadas avulsas). */
  sink?: CostSink;
  /** Teto por requisicao (USD por MILHAO de tokens). Ver applyMaxPrice. */
  maxPricePerMTok?: { prompt?: number; completion?: number };
}

export interface ChatStreamParams extends ChatCompletionParams {
  onDelta?: (delta: string, fullText: string) => void;
}

export interface KeyInfo {
  /** Rotulo/nome da key configurado no OpenRouter. */
  label?: string;
  /** Gasto acumulado da key, em USD. */
  usageUsd?: number;
  /** Limite de credito da key (null = sem limite/ilimitado). */
  limitUsd?: number | null;
  /** Credito restante (null = sem limite). */
  limitRemainingUsd?: number | null;
  /** Se a key esta no tier gratuito. */
  isFreeTier?: boolean;
}

export type ValidateKeyResult = ({ ok: true } & KeyInfo) | { ok: false; error: string };

function asNumberOrNull(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

interface GuardedResponse {
  res: Response;
  startedAt: number;
  /** Libera o slot do limitador; passe ok=true se a leitura do corpo concluiu. */
  finish: (ok: boolean) => void;
}

// cache por key (sufixo curto) pra nao misturar contas
function cacheKey(apiKey: string): string {
  return apiKey.slice(-12);
}

/**
 * Uma instancia do gateway: config + limitador AIMD + cache de catalogo.
 * Toda chamada de geracao passa por `chatCompletion`/`chatCompletionStream`
 * daqui, e e DENTRO delas que a contabilidade acontece (role + sink): um ponto
 * so, igual para Node e navegador.
 */
export class OpenRouterGateway {
  private cfg: GatewayConfig;
  readonly limiter: AimdLimiter;
  private readonly modelsCache = new Map<string, { fetchedAt: number; data: OpenRouterModel[] }>();

  constructor(config: Partial<GatewayConfig> = {}) {
    this.cfg = mergeConfig(DEFAULT_CONFIG, config);
    this.limiter = new AimdLimiter(this.cfg.maxConcurrency);
  }

  /** Config em vigor (copia; mude via `configure`). */
  get config(): Readonly<GatewayConfig> {
    return { ...this.cfg };
  }

  /**
   * Reconfigura EM LUGAR: cache e estado do limitador sobrevivem (idempotente;
   * pode ser chamado de novo sem perder o catalogo quente).
   */
  configure(patch: Partial<GatewayConfig>): this {
    this.cfg = mergeConfig(this.cfg, patch);
    this.limiter.setMax(this.cfg.maxConcurrency);
    return this;
  }

  private headers(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': this.cfg.appUrl,
      'X-Title': this.cfg.appTitle,
    };
  }

  /** Chama o transporte SEM `this` do objeto de config (ver GatewayConfig.fetch). */
  private transport(url: string, init: RequestInit): Promise<Response> {
    const f: FetchLike = this.cfg.fetch ?? ((input, i) => globalThis.fetch(input, i));
    return f(url, init);
  }

  private sleep(ms: number): Promise<void> {
    const s = this.cfg.sleep ?? defaultSleep;
    return s(ms);
  }

  // --- catalogo ---------------------------------------------------------------

  /**
   * Semeia o cache de catalogo sem ir a rede. Existe porque o CLI e um processo
   * NOVO a cada invocacao: sem isto o cache nasce frio e `deterministicSampling`
   * cai na heuristica por nome, `applyReasoning` perde a allowlist de esforco
   * (HTTP 400 nos 83 modelos que declaram `supported_efforts`) e o fallback de
   * custo por catalogo devolve 0. Quem persiste em disco e o CLI
   * (src/modelsCache.ts); aqui so ha memoria.
   */
  primeModelsCache(apiKey: string, data: OpenRouterModel[], fetchedAt: number = Date.now()): void {
    this.modelsCache.set(cacheKey(apiKey), { fetchedAt, data });
  }

  /** Espia o cache em memoria (sem rede). `undefined` = frio. */
  peekModelsCache(apiKey: string): { fetchedAt: number; data: OpenRouterModel[] } | undefined {
    return this.modelsCache.get(cacheKey(apiKey));
  }

  /** Modelo do catalogo EM CACHE (sem rede). */
  cachedModel(apiKey: string, modelId: string): OpenRouterModel | undefined {
    return this.modelsCache.get(cacheKey(apiKey))?.data.find((m) => m.id === modelId);
  }

  async listModels(apiKey: string, force = false): Promise<OpenRouterModel[]> {
    const ck = cacheKey(apiKey);
    const cached = this.modelsCache.get(ck);
    if (!force && cached && Date.now() - cached.fetchedAt < this.cfg.modelsCacheTtlMs) {
      return cached.data;
    }

    const res = await this.transport(`${this.cfg.baseUrl}/models`, {
      method: 'GET',
      headers: this.headers(apiKey),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenRouter /models falhou: ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
    }

    const data = parseModelsPayload(await res.json());
    this.modelsCache.set(ck, { fetchedAt: Date.now(), data });
    return data;
  }

  async getModel(apiKey: string, id: string): Promise<OpenRouterModel | undefined> {
    const all = await this.listModels(apiKey);
    return all.find((m) => m.id === id);
  }

  // --- limitador ----------------------------------------------------------------

  /** Limite atual de concorrencia (para logs/telemetria). */
  currentConcurrency(): LimiterSnapshot {
    return this.limiter.snapshot();
  }

  /**
   * fetch sob o limitador da instancia, com timeout/abort por tentativa e retry
   * com backoff em 429/5xx/rede. Em 429 reduz o limite (AIMD). Retorna a
   * Response OK SEGURANDO o slot — o chamador DEVE chamar finish() apos ler o corpo.
   */
  private async guardedFetch(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<GuardedResponse> {
    const limiter = this.limiter;
    let attempt = 0;
    for (;;) {
      await limiter.acquire();
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      const onExternalAbort = () => controller.abort(externalSignal?.reason);
      if (externalSignal) {
        if (externalSignal.aborted) controller.abort(externalSignal.reason);
        else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
      const cleanup = () => {
        clearTimeout(timeoutHandle);
        if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      };

      const startedAt = Date.now();
      let res: Response;
      try {
        res = await this.transport(url, { ...init, signal: controller.signal });
      } catch (err) {
        cleanup();
        limiter.release();
        // abort (timeout/externo) nao repete; erro de rede repete com backoff.
        if (controller.signal.aborted || attempt >= MAX_RETRIES) throw err;
        await this.sleep(backoffMs(attempt));
        attempt += 1;
        continue;
      }

      if (!res.ok) {
        const status = res.status;
        if (isRetryableStatus(status) && attempt < MAX_RETRIES && !externalSignal?.aborted) {
          if (status === 429) limiter.noteRateLimit();
          await res.body?.cancel().catch(() => undefined);
          cleanup();
          limiter.release();
          await this.sleep(backoffMs(attempt));
          attempt += 1;
          continue;
        }
        const errText = await res.text().catch(() => '');
        cleanup();
        limiter.release();
        throw new Error(describeOpenRouterError(status, errText));
      }

      // OK: segura o slot ate o chamador terminar de ler o corpo.
      return {
        res,
        startedAt,
        finish: (ok: boolean) => {
          if (ok) limiter.noteSuccess();
          cleanup();
          limiter.release();
        },
      };
    }
  }

  // --- geracao ------------------------------------------------------------------

  /** Corpo comum de chat/stream: amostragem determinista, esforco encaixado, teto de preco. */
  private buildBody(params: ChatCompletionParams, stream: boolean): Record<string, unknown> {
    const { apiKey, modelId, messages, temperature = 0, maxTokens, responseFormatJson } = params;
    const model = this.cachedModel(apiKey, modelId);
    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      ...deterministicSampling(model, modelId, temperature),
    };
    if (stream) body.stream = true;
    if (typeof maxTokens === 'number' && maxTokens > 0) body.max_tokens = maxTokens;
    if (responseFormatJson) body.response_format = { type: 'json_object' };
    // O esforco pedido e ENCAIXADO no que este modelo declara aceitar (ver
    // fitEffort/applyReasoning): allowlist propria por modelo e raciocinio
    // obrigatorio em alguns (onde 'off' nao pode ser enviado).
    if (params.reasoningLevel) applyReasoning(body, params.reasoningLevel, model?.reasoning);
    applyMaxPrice(body, params.maxPricePerMTok);
    return body;
  }

  /** O PONTO UNICO da contabilidade: precifica e lanca no ledger (role + sink). */
  private account(
    params: ChatCompletionParams,
    reservation: ReturnType<CostSink['reserve']> | undefined,
    usage: UsageInfo,
  ): CallCost {
    const role = params.role ?? 'competitor';
    const cost = priceUsage(usage, this.cachedModel(params.apiKey, params.modelId));
    if (reservation) {
      params.sink?.note(reservation, {
        role,
        modelId: params.modelId,
        cost,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
      });
    }
    return cost;
  }

  async chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    const { messages, maxTokens, timeoutMs = 60_000, signal: externalSignal, sink } = params;
    const role = params.role ?? 'competitor';
    const body = this.buildBody(params, false);

    // Reserva ANTES do slot do limitador: se o orcamento ja estourou, nem
    // enfileira. Lanca BudgetExceeded/RunCancelled (sinais de controle).
    const reservation = sink?.reserve(role, params.modelId, guessPromptTokens(messages), maxTokens ?? 1024);

    let guarded: GuardedResponse;
    try {
      guarded = await this.guardedFetch(
        `${this.cfg.baseUrl}/chat/completions`,
        { method: 'POST', headers: this.headers(params.apiKey), body: JSON.stringify(body) },
        timeoutMs,
        externalSignal,
      );
    } catch (err) {
      reservation?.release();
      throw err;
    }
    const { res, startedAt, finish } = guarded;

    let ok = false;
    try {
      const latencyMs = Date.now() - startedAt;
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: unknown;
        error?: { message?: string; code?: string | number };
      };

      const usage = extractUsage(json.usage);
      // Contabiliza ANTES do throw in-band: uma resposta 200 com corpo de erro
      // (provider rejeitou um parametro) JA foi cobrada. Sem isto ela sai de
      // graca nos livros e cara na fatura.
      const cost = this.account(params, reservation, usage);

      const text = json.choices?.[0]?.message?.content ?? '';
      // OpenRouter as vezes devolve 200 com um corpo de erro (ex.: provider
      // rejeitou um parametro). Sem isto a falha viraria "resposta vazia" muda.
      if (!text && json.error) {
        throw new Error(`OpenRouter: ${json.error.message ?? JSON.stringify(json.error)}`);
      }

      ok = true;
      return {
        text,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        latencyMs,
        raw: json,
        cost,
        cachedTokensIn: usage.cachedTokensIn,
        reasoningTokens: usage.reasoningTokens,
      };
    } finally {
      if (!ok) reservation?.release();
      finish(ok);
    }
  }

  async chatCompletionStream(params: ChatStreamParams): Promise<ChatCompletionResult> {
    const { messages, maxTokens, timeoutMs = 60_000, signal: externalSignal, sink, onDelta } = params;
    const role = params.role ?? 'competitor';
    const body = this.buildBody(params, true);

    const reservation = sink?.reserve(role, params.modelId, guessPromptTokens(messages), maxTokens ?? 1024);

    let guarded: GuardedResponse;
    try {
      guarded = await this.guardedFetch(
        `${this.cfg.baseUrl}/chat/completions`,
        { method: 'POST', headers: this.headers(params.apiKey), body: JSON.stringify(body) },
        timeoutMs,
        externalSignal,
      );
    } catch (err) {
      reservation?.release();
      throw err;
    }
    const { res, startedAt, finish } = guarded;

    let ok = false;
    let fullText = '';
    let lastRaw: unknown = null;
    // Guardado SEPARADO de `lastRaw`: hoje o ultimo chunk *por acaso* e o de
    // usage (porque `[DONE]` e ignorado), mas basta um provedor emitir um
    // keep-alive depois do frame de usage para o custo sumir em silencio.
    let usageRaw: unknown = null;
    let streamError: string | null = null;

    try {
      if (!res.body) throw new Error('OpenRouter retornou stream sem corpo de resposta.');
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE lines separadas por \n. OpenRouter usa data: <json>\n\n
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const chunk = JSON.parse(payload) as {
              choices?: { delta?: { content?: string } }[];
              usage?: unknown;
              error?: { message?: string };
            };
            lastRaw = chunk;
            if (chunk.error && !streamError) {
              streamError = chunk.error.message ?? JSON.stringify(chunk.error);
            }
            const delta = chunk.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              fullText += delta;
              onDelta?.(delta, fullText);
            }
            if (chunk.usage) usageRaw = chunk.usage;
          } catch {
            // chunk JSON invalido, ignora
          }
        }
      }

      const usage = extractUsage(usageRaw);
      // Contabiliza antes do throw in-band — a chamada ja foi cobrada.
      const cost = this.account(params, reservation, usage);

      // Resposta vazia + erro in-band (provider rejeitou parametro etc.): falha alto.
      if (!fullText && streamError) throw new Error(`OpenRouter: ${streamError}`);

      const latencyMs = Date.now() - startedAt;
      ok = true;
      return {
        text: fullText,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        latencyMs,
        raw: lastRaw,
        cost,
        cachedTokensIn: usage.cachedTokensIn,
        reasoningTokens: usage.reasoningTokens,
      };
    } finally {
      if (!ok) reservation?.release();
      finish(ok);
    }
  }

  // --- key ----------------------------------------------------------------------

  /**
   * Valida a key contra o endpoint AUTENTICADO `GET /api/v1/key`.
   *
   * IMPORTANTE: `/models` e publico (responde 200 sem qualquer Authorization),
   * entao validar por la marcava QUALQUER key como valida — inclusive uma
   * invalida — e a run so falhava (401) la na frente, no datagen. `/key` exige
   * o header de autenticacao e retorna metadados da propria key.
   */
  async validateKey(apiKey: string): Promise<ValidateKeyResult> {
    const key = (apiKey ?? '').trim();
    if (key.length < 20) {
      return { ok: false, error: 'Key vazia ou muito curta. Cole a key completa do OpenRouter.' };
    }

    let res: Response;
    try {
      res = await this.transport(`${this.cfg.baseUrl}/key`, {
        method: 'GET',
        headers: this.headers(key),
      });
    } catch (err) {
      return { ok: false, error: `Falha de rede ao validar a key: ${(err as Error).message}` };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error:
          'OpenRouter recusou a key. Verifique se copiou a key inteira (sk-or-...) e se ela esta ativa e com credito.',
      };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: describeOpenRouterError(res.status, body) };
    }

    const json = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown> };
    const d = json.data ?? {};
    return {
      ok: true,
      label: typeof d.label === 'string' ? d.label : undefined,
      usageUsd: typeof d.usage === 'number' ? d.usage : undefined,
      limitUsd: asNumberOrNull(d.limit),
      limitRemainingUsd: asNumberOrNull(d.limit_remaining),
      isFreeTier: typeof d.is_free_tier === 'boolean' ? d.is_free_tier : undefined,
    };
  }
}

// ===========================================================================
// Instancia PADRAO (uma por processo no Node, uma por aba no navegador) e a
// API de modulo historica, que delega para ela — os ~16 importadores seguem
// chamando `chatCompletion(...)` sem saber de instancia.
// ===========================================================================

let defaultGateway = new OpenRouterGateway();

/** Nova instancia isolada (limitador e cache proprios). Uso tipico: testes. */
export function createGateway(config: Partial<GatewayConfig> = {}): OpenRouterGateway {
  return new OpenRouterGateway(config);
}

/** A instancia padrao em uso. */
export function getGateway(): OpenRouterGateway {
  return defaultGateway;
}

/**
 * Configura a instancia padrao EM LUGAR (cache/limitador preservados). Os
 * pontos de entrada chamam isto uma vez, antes da primeira chamada de rede.
 */
export function configureGateway(patch: Partial<GatewayConfig>): OpenRouterGateway {
  return defaultGateway.configure(patch);
}

/** Troca a instancia padrao e devolve a anterior (testes restauram no afterEach). */
export function setDefaultGateway(gateway: OpenRouterGateway): OpenRouterGateway {
  const prev = defaultGateway;
  defaultGateway = gateway;
  return prev;
}

export function primeModelsCache(
  apiKey: string,
  data: OpenRouterModel[],
  fetchedAt: number = Date.now(),
): void {
  defaultGateway.primeModelsCache(apiKey, data, fetchedAt);
}

export function peekModelsCache(
  apiKey: string,
): { fetchedAt: number; data: OpenRouterModel[] } | undefined {
  return defaultGateway.peekModelsCache(apiKey);
}

export function currentConcurrency(): LimiterSnapshot {
  return defaultGateway.currentConcurrency();
}

export function listModels(apiKey: string, force = false): Promise<OpenRouterModel[]> {
  return defaultGateway.listModels(apiKey, force);
}

export function getModel(apiKey: string, id: string): Promise<OpenRouterModel | undefined> {
  return defaultGateway.getModel(apiKey, id);
}

export function chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
  return defaultGateway.chatCompletion(params);
}

export function chatCompletionStream(params: ChatStreamParams): Promise<ChatCompletionResult> {
  return defaultGateway.chatCompletionStream(params);
}

export function validateKey(apiKey: string): Promise<ValidateKeyResult> {
  return defaultGateway.validateKey(apiKey);
}
