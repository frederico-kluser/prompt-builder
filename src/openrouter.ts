import { applyReasoning } from './reasoning.js';
import { parseLifecycleMeta } from './engine/modelLifecycle.js';
import { isControlSignal, toControlSignal } from './budget.js';
import { classifyPrice, priceTokens, type PriceFieldKind } from './engine/pricing.js';
import { finishSignalsOf, isTruncated, truncationSignals } from './engine/truncation.js';
import { createPiiGuard, type PiiGuardStats } from './engine/pii.js';
import type {
  CallCost,
  CallFinishSignals,
  CostRole,
  CostSink,
  ModelReasoningMeta,
  OpenRouterModel,
  PricingTier,
  ReasoningLevel,
  TruncationSignal,
} from './types.js';

// Preco por faixa: a implementacao mora no modulo puro `engine/pricing.ts`
// (fonte unica com o estimador e a SPA); re-exportado aqui por compatibilidade.
export { tierFor } from './engine/pricing.js';

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
  /**
   * Espera entre re-tentativas (testes injetam uma espera nula). O `signal` é
   * só uma dica para liberar o timer cedo: o gateway já corre a espera contra o
   * abort por fora, então uma espera que o ignore continua cancelável.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    // Abortou: solta o timer já (quem decide o que o abort significa é o
    // `backoff` do gateway, que rejeita com o sinal de controle).
    signal?.addEventListener('abort', done, { once: true });
  });

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

  /**
   * Vaga no limitador. Com `signal` (IMPL-020, Cancelar): sinal já abortado nem
   * entra na fila, e quem estava ESPERANDO sai dela no abort — sem isso a
   * chamada enfileirada ganharia a vaga depois do clique e iria ao transporte.
   */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(toControlSignal(signal.reason));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(toControlSignal(signal?.reason));
      };
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(grant);
    });
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
  // Lista PRESENTE manda, inclusive vazia: `[]` = o catalogo declara que nao
  // aceita nenhum parametro (roteadores) ou o campo veio malformado e o parse
  // fechou em fail-closed (IMPL-018) — em ambos, nada opcional vai no fio.
  if (supported) {
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
  if (!supported) {
    return { temperature: true, reasoning: false, effort: false, mandatory: false };
  }
  // `[]` (declarado vazio ou fail-closed) cai aqui: nenhuma capacidade.
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

// ---------------------------------------------------------------------------
// Taxonomia de desfecho (IMPL-010 / R-21:REC-6). Tres coisas DIFERENTES que
// antes viravam a mesma ("erro" + veredito 'nao' automatico):
//   - BLOQUEIO: moderacao/guardrail do gateway ou filtro de conteudo do
//     provedor (HTTP 403 de moderacao, `finish_reason: content_filter` e
//     equivalentes nativos). E a DEFESA do gateway — nao diz nada sobre a
//     politica do prompt sob teste e NUNCA e problema de key.
//   - RECUSA: o MODELO respondeu recusando (`message.refusal`). E resposta
//     legitima e julgavel.
//   - ERRO: infraestrutura (rede, 5xx, timeout, 401 de key...).
// O 403 do OpenRouter cobre moderacao, guardrail e permissao; so 401 e key.
// Antes 401 e 403 viravam "a key e invalida" — com os 4 competidores padrao da
// SPA sendo rotas moderadas, um cenario adversarial mandava o usuario trocar
// uma key que estava funcionando.
// ---------------------------------------------------------------------------

/** Por que uma chamada foi BLOQUEADA (moderacao/guardrail/filtro de conteudo). */
export interface GatewayBlock {
  /** De onde veio o sinal: erro HTTP, erro in-band (200/SSE) ou `finish_reason`. */
  source: 'http' | 'in_band' | 'finish_reason';
  /** 'moderation' = conteudo sinalizado; 'policy' = 403 de guardrail/permissao sem marca de moderacao. */
  kind: 'moderation' | 'content_filter' | 'policy';
  /** Motivos declarados pelo provedor (ex.: `metadata.reasons`). NUNCA o texto sinalizado. */
  reasons?: string[];
  /** Mensagem PT-BR pronta para record/UI/CLI. Nao menciona key: bloqueio nao e autenticacao. */
  message: string;
}

/**
 * Classe de uma falha do gateway. 'blocked' e a unica que o competidor NAO
 * trata como erro de infraestrutura; 'auth' e a unica que fala de key.
 */
export type GatewayErrorKind = 'auth' | 'blocked' | 'no_credit' | 'rate_limit' | 'http';

/** Marca por propriedade (mesmo motivo de `isControlSignal`: nada de `instanceof` sob ESM). */
const GATEWAY_ERROR = 'gatewayError';

/** Falha classificada do gateway. Reconheca com `gatewayErrorKind`/`isGatewayBlocked`. */
export class GatewayError extends Error {
  readonly gatewayError: GatewayErrorKind;
  readonly httpStatus?: number;
  readonly block?: GatewayBlock;
  constructor(kind: GatewayErrorKind, message: string, opts: { httpStatus?: number; block?: GatewayBlock } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.gatewayError = kind;
    this.httpStatus = opts.httpStatus;
    this.block = opts.block;
  }
}

/** Classe da falha, sem `instanceof` (instancia dupla do modulo daria `false` em silencio). */
export function gatewayErrorKind(err: unknown): GatewayErrorKind | undefined {
  if (typeof err !== 'object' || err === null || !(GATEWAY_ERROR in err)) return undefined;
  return (err as GatewayError).gatewayError;
}

/** true = a chamada foi bloqueada por moderacao/guardrail (nao e erro de infra nem de key). */
export function isGatewayBlocked(err: unknown): err is GatewayError & { block: GatewayBlock } {
  return gatewayErrorKind(err) === 'blocked';
}

interface OpenRouterErrorBody {
  code?: number | string;
  message?: string;
  metadata?: Record<string, unknown>;
}

/** Le `{ error: { code, message, metadata } }` (formato do OpenRouter). Corpo nao-JSON => undefined. */
function parseErrorBody(body: string): OpenRouterErrorBody | undefined {
  try {
    const json = JSON.parse(body) as { error?: unknown };
    const e = json?.error;
    if (e && typeof e === 'object' && !Array.isArray(e)) return e as OpenRouterErrorBody;
    if (typeof e === 'string') return { message: e };
  } catch {
    // corpo nao-JSON (proxy, pagina HTML): sem estrutura para ler
  }
  return undefined;
}

const clip = (s: string, n = 300): string => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** Marca INEQUIVOCA de moderacao (OpenRouter: "... requires moderation ... Your input was flagged for ..."). */
const STRONG_MODERATION_RE = /moderat|flagg/i;
/** Marca fraca: so qualifica um 403 (num erro in-band 400, "safety_settings invalido" nao e bloqueio). */
const MODERATION_RE = /moderat|flagg|content[ _-]?(policy|filter)|safety|prohibited|violat/i;
/** 403 de LIMITE de gasto da key/conta — nao e bloqueio de conteudo. */
const KEY_LIMIT_RE = /key limit|limit exceeded|insufficient (credit|funds|balance)|quota/i;

function moderationReasons(meta: Record<string, unknown> | undefined): string[] | undefined {
  const r = meta?.reasons;
  if (!Array.isArray(r)) return undefined;
  const out = r.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
  return out.length > 0 ? out : undefined;
}

/**
 * Bloqueio a partir de um corpo de erro (HTTP ou in-band). 403 (codigo HTTP ou
 * `error.code`) e bloqueio por definicao do OpenRouter — exceto o 403 de limite
 * de gasto da key, que e falta de credito. Marca de moderacao (`metadata.reasons`,
 * `flagged_input`, texto "flagged/moderation") e bloqueio com qualquer codigo.
 * ⚠️ `metadata.flagged_input` (o texto sinalizado) NUNCA entra na mensagem: vai
 * parar no record, no log e no NDJSON.
 */
function blockFromErrorBody(
  err: OpenRouterErrorBody | undefined,
  httpStatus: number | undefined,
  source: GatewayBlock['source'],
): GatewayBlock | undefined {
  const code = httpStatus ?? (err?.code !== undefined ? Number(err.code) : undefined);
  const texto = typeof err?.message === 'string' ? err.message : '';
  const reasons = moderationReasons(err?.metadata);
  const flagged =
    Boolean(reasons) ||
    (typeof err?.metadata === 'object' && err.metadata !== null && 'flagged_input' in err.metadata);
  const strong = flagged || STRONG_MODERATION_RE.test(texto);
  if (!strong && code !== 403) return undefined;
  const moderation = strong || MODERATION_RE.test(texto);
  if (!moderation && KEY_LIMIT_RE.test(texto)) return undefined; // limite de gasto: no_credit, nao bloqueio
  const provider = typeof err?.metadata?.provider_name === 'string' ? err.metadata.provider_name : undefined;
  const httpTag = code === 403 ? ' (HTTP 403)' : '';
  const detalhe = texto ? ` Detalhe: ${clip(texto)}` : '';
  const message = moderation
    ? `OpenRouter bloqueou a requisicao por moderacao${httpTag}: o conteudo foi sinalizado` +
      `${reasons ? ` (${reasons.join(', ')})` : ''}${provider ? ` pelo provedor ${provider}` : ''}. ` +
      `E a defesa do gateway, nao falha de autenticacao — o cenario fica sem veredito para o prompt.${detalhe}`
    : `OpenRouter bloqueou a requisicao${httpTag} por politica do gateway (guardrail, moderacao ou ` +
      `permissao da conta para este modelo). Nao e falha de autenticacao — o cenario fica sem veredito ` +
      `para o prompt.${detalhe}`;
  return { source, kind: moderation ? 'moderation' : 'policy', ...(reasons ? { reasons } : {}), message };
}

/**
 * Traduz uma resposta de erro da OpenRouter para uma mensagem clara em PT-BR.
 * 401 = key invalida/expirada; 403 = BLOQUEIO (moderacao/guardrail/permissao —
 * nunca "key invalida"), exceto 403 de limite de gasto (= sem credito);
 * 402 = sem credito; 429 = rate limit.
 */
export function describeOpenRouterError(status: number, body: string): string {
  return classifyHttpError(status, body).message;
}

/** Erro HTTP do OpenRouter => `GatewayError` classificado (puro; exportado p/ testes). */
export function classifyHttpError(status: number, body: string): GatewayError {
  const parsed = parseErrorBody(body);
  const snippet = clip(parsed?.message ?? body);
  const detalhe = snippet ? ` Detalhe: ${snippet}` : '';
  if (status === 401) {
    return new GatewayError(
      'auth',
      `OpenRouter recusou a key (HTTP 401): a key e invalida, expirou ou foi revogada. Reconfigure em Configuracoes.${detalhe}`,
      { httpStatus: status },
    );
  }
  if (status === 403) {
    const block = blockFromErrorBody(parsed ?? { message: body }, status, 'http');
    if (block) return new GatewayError('blocked', block.message, { httpStatus: status, block });
    return new GatewayError(
      'no_credit',
      `OpenRouter recusou por limite de gasto (HTTP 403): o limite de credito da key/conta foi atingido.${detalhe}`,
      { httpStatus: status },
    );
  }
  if (status === 402) {
    return new GatewayError('no_credit', `OpenRouter sem credito (HTTP 402): adicione creditos na sua conta.${detalhe}`, {
      httpStatus: status,
    });
  }
  if (status === 429) {
    return new GatewayError('rate_limit', `OpenRouter rate limit (HTTP 429): aguarde e tente novamente.${detalhe}`, {
      httpStatus: status,
    });
  }
  return new GatewayError('http', `OpenRouter falhou (HTTP ${status})${snippet ? `: ${snippet}` : ''}`, {
    httpStatus: status,
  });
}

/** `finish_reason` NORMALIZADO do OpenRouter que significa filtro de conteudo. */
const FILTER_FINISH = new Set(['content_filter']);
/**
 * Equivalentes NATIVOS (`native_finish_reason`, comparados sem caixa) — o
 * provedor pode filtrar sem o OpenRouter normalizar. OpenAI/Azure:
 * content_filter; Gemini: SAFETY/RECITATION/BLOCKLIST/PROHIBITED_CONTENT/SPII/
 * IMAGE_SAFETY; Bedrock: guardrail_intervened/content_filtered; Anthropic:
 * `refusal` = intervencao do CLASSIFICADOR de seguranca que corta a saida (nao
 * e texto escrito pelo modelo — esse chega como `message.refusal`/conteudo).
 */
const FILTER_NATIVE = new Set([
  'content_filter',
  'content_filtered',
  'safety',
  'recitation',
  'blocklist',
  'prohibited_content',
  'spii',
  'image_safety',
  'guardrail_intervened',
  'refusal',
]);

/** Bloqueio a partir dos sinais de fim da resposta (puro; exportado p/ testes). */
export function blockFromFinishReason(
  finishReason: string | undefined,
  nativeFinishReason: string | undefined,
): GatewayBlock | undefined {
  const fr = finishReason?.trim().toLowerCase();
  const nfr = nativeFinishReason?.trim().toLowerCase();
  const hit = (fr && FILTER_FINISH.has(fr)) || (nfr && FILTER_NATIVE.has(nfr));
  if (!hit) return undefined;
  const sinal = [finishReason, nativeFinishReason].filter(Boolean).join(' / ');
  return {
    source: 'finish_reason',
    kind: 'content_filter',
    message:
      `Filtro de conteudo do provedor cortou a resposta (finish_reason: ${sinal}). ` +
      'E a defesa do gateway/provedor, nao falha do prompt — o cenario fica sem veredito para o prompt.',
  };
}

/** Texto de `refusal` (protocolo OpenAI) — so string nao vazia conta. */
function refusalText(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

/**
 * `finish_reason`/`native_finish_reason` so contam como string nao vazia. Os
 * sinais de fim sao calculados ANTES da contabilidade (vao junto no `note`):
 * um valor malformado de provedor (numero, objeto) nao pode lancar ali e fazer
 * uma chamada ja cobrada sumir dos livros.
 */
function finishText(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Faixas de preco por tamanho de prompt (`pricing.overrides`). O campo existe
 * no catalogo mas nao esta documentado; sem ele, o custo de runs de contexto
 * longo sai 3-7x menor que o real. Preco invalido na faixa vira desconhecido
 * (`null`), NUNCA e descartado: descartar faria a faixa cara cair no preco base
 * (subestimando); desconhecido obriga o consumidor a tratar.
 */
function parsePricingTiers(value: unknown, issue: IssueFn, modelId: string): PricingTier[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    issue(modelId, 'pricing.overrides', 'warn', 'nao e uma lista — faixas ignoradas');
    return undefined;
  }
  if (value.length === 0) return undefined;
  const tiers: PricingTier[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    const min = typeof t.min_prompt_tokens === 'number' ? t.min_prompt_tokens : Number(t.min_prompt_tokens);
    if (!Number.isFinite(min)) {
      issue(modelId, 'pricing.overrides', 'warn', 'faixa sem min_prompt_tokens numerico — ignorada');
      continue;
    }
    tiers.push({
      minPromptTokens: min,
      prompt: priceField(t.prompt, issue, modelId, 'pricing.overrides.prompt'),
      completion: priceField(t.completion, issue, modelId, 'pricing.overrides.completion'),
    });
  }
  return tiers.length > 0 ? tiers.sort((a, b) => a.minPromptTokens - b.minPromptTokens) : undefined;
}

/** Le um campo de preco; "-1" (roteador) vira desconhecido SEM alerta, lixo vira desconhecido COM alerta. */
function priceField(value: unknown, issue: IssueFn, modelId: string, field: string): number | null {
  const { price, kind } = classifyPrice(value);
  const motivo: Partial<Record<PriceFieldKind, string>> = {
    missing: 'ausente — tratado como preco desconhecido',
    invalid: `valor invalido (${JSON.stringify(value)}) — tratado como preco desconhecido`,
  };
  if (motivo[kind]) issue(modelId, field, 'warn', motivo[kind]!);
  return price;
}

/**
 * Custo derivado do CATALOGO. E o plano B de `priceUsage` (a fonte primaria e
 * `usage.cost`) e a base do estimador de pre-voo. Respeita `pricing.overrides`.
 * `null` = impossivel precificar: modelo fora do catalogo OU preco desconhecido
 * (ex.: roteador com "-1"). Nunca negativo, nunca "0 por omissao".
 */
export function computeCost(
  tokensIn: number,
  tokensOut: number,
  model: OpenRouterModel | undefined,
): number | null {
  if (!model) return null;
  return priceTokens(model.pricing, tokensIn, tokensOut);
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
  // Catalogo so vale com preco CONHECIDO: um roteador ("-1") sem usage.cost e
  // 'unknown', nunca um custo derivado (antes saia negativo). IMPL-018.
  const doCatalogo = computeCost(u.tokensIn, u.tokensOut, model);
  if (doCatalogo !== null) {
    return { usd: doCatalogo, source: 'catalog' };
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

/**
 * Erro de uma chamada cujo sinal EXTERNO abortou (Cancelar/Ctrl-C) sai como
 * sinal de controle (IMPL-020). Cobre o abort no MEIO do corpo (JSON/stream
 * chegando): o leitor rejeita com o que o runtime quiser, e um erro comum seria
 * degradado pelos papeis em nota inventada ('parcial', competidor 'error').
 */
function controlIfAborted(err: unknown, signal?: AbortSignal): unknown {
  return signal?.aborted && !isControlSignal(err) ? toControlSignal(signal.reason) : err;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function backoffMs(attempt: number): number {
  const base = Math.min(8000, 250 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250); // jitter
}

// ---------------------------------------------------------------------------
// Validacao do catalogo (IMPL-018 / R-07b:REC-7). O /models nao tem changelog
// nem politica de versao; cada campo e classificado:
//   - FAIL-OPEN (alerta `warn`): campos NAO contratuais — preco, faixas,
//     contexto, default_effort, flags informativas. Valor ruim vira
//     desconhecido/ausente e o modelo segue utilizavel.
//   - FAIL-CLOSED (alerta `error`): o que MUDA O FIO — `supported_parameters`,
//     `reasoning.supported_efforts` e `reasoning.mandatory`. Valor ruim NUNCA
//     vira palpite: `supported_parameters` malformado vira `[]` (nada opcional
//     vai no corpo), allowlist de esforco malformada tira a capacidade de
//     raciocinio da UI/CLI e `mandatory` malformado vira `true` ('off' nao e
//     enviado — o provedor rejeitaria 'none').
//   - item sem `id` e descartado (nao da para referencia-lo).
// ---------------------------------------------------------------------------

export type CatalogIssueSeverity = 'warn' | 'error';

export interface CatalogIssue {
  /** Id do modelo (ou `#<indice>` quando o proprio id e invalido). */
  modelId: string;
  /** Campo do /models, em notacao de ponto (ex.: `pricing.prompt`). */
  field: string;
  /** `warn` = fail-open (seguiu com desconhecido); `error` = fail-closed. */
  severity: CatalogIssueSeverity;
  message: string;
}

type IssueFn = (modelId: string, field: string, severity: CatalogIssueSeverity, message: string) => void;

const REASONING_WIRE_PARAMS = new Set(['reasoning', 'reasoning_effort', 'include_reasoning']);

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Le o objeto `reasoning` de um item de /models. E ele que diz QUAIS degraus de
 * esforco o modelo aceita (`supported_efforts`, ordem decrescente; ausente = sem
 * restricao) e se raciocinio pode ser desligado (`mandatory`). Sem ele, so daria
 * para chutar o esforco e levar 400. `stripReasoning` = fail-closed: a
 * allowlist veio malformada, entao a capacidade de raciocinio sai do modelo.
 */
function parseReasoningMeta(
  raw: unknown,
  issue: IssueFn,
  modelId: string,
): { meta: ModelReasoningMeta | undefined; stripReasoning: boolean } {
  if (raw === undefined || raw === null) return { meta: undefined, stripReasoning: false };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issue(modelId, 'reasoning', 'error', 'nao e um objeto — capacidade de raciocinio desligada (fail-closed)');
    return { meta: undefined, stripReasoning: true };
  }
  const r = raw as Record<string, unknown>;
  let stripReasoning = false;

  let supportedEfforts: string[] | undefined;
  if (r.supported_efforts !== undefined && r.supported_efforts !== null) {
    if (isStringArray(r.supported_efforts)) {
      supportedEfforts = [...r.supported_efforts];
    } else {
      issue(
        modelId,
        'reasoning.supported_efforts',
        'error',
        'allowlist de esforco malformada — capacidade de raciocinio desligada (fail-closed)',
      );
      stripReasoning = true;
    }
  }

  let mandatory: boolean | undefined;
  if (r.mandatory !== undefined && r.mandatory !== null) {
    if (typeof r.mandatory === 'boolean') {
      mandatory = r.mandatory;
    } else {
      issue(modelId, 'reasoning.mandatory', 'error', 'nao booleano — tratado como obrigatorio (fail-closed)');
      mandatory = true;
    }
  }

  const optBool = (campo: string, v: unknown): boolean | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'boolean') return v;
    issue(modelId, `reasoning.${campo}`, 'warn', 'nao booleano — ignorado');
    return undefined;
  };
  let defaultEffort: string | undefined;
  if (r.default_effort !== undefined && r.default_effort !== null) {
    if (typeof r.default_effort === 'string') defaultEffort = r.default_effort;
    else issue(modelId, 'reasoning.default_effort', 'warn', 'nao e texto — ignorado');
  }

  // Allowlist malformada: a capacidade INTEIRA sai (meta + parametros de
  // raciocinio em `supported_parameters`) — com isso `catalogDeniesReasoning`
  // impede que qualquer `reasoning` va no fio. Mandar um degrau sem encaixe e
  // exatamente o HTTP 400 que a allowlist existe para evitar.
  if (stripReasoning) return { meta: undefined, stripReasoning };
  return {
    meta: {
      mandatory,
      defaultEnabled: optBool('default_enabled', r.default_enabled),
      supportedEfforts,
      defaultEffort,
      supportsMaxTokens: optBool('supports_max_tokens', r.supports_max_tokens),
    },
    stripReasoning,
  };
}

/**
 * true = o catalogo DECLARA que o modelo nao aceita raciocinio: lista de
 * parametros presente (inclusive `[]`) sem nenhum parametro de raciocinio E sem
 * objeto `reasoning`. E tambem o estado do fail-closed de allowlist malformada.
 * Fora do catalogo / sem lista = desconhecido => false (comportamento de antes).
 */
export function catalogDeniesReasoning(model: OpenRouterModel | undefined): boolean {
  if (!model || !model.supportedParameters || model.reasoning) return false;
  return !model.supportedParameters.some((p) => REASONING_WIRE_PARAMS.has(p));
}

/** `supported_parameters`: contrato do fio. Malformado => `[]` (fail-closed). */
function parseSupportedParameters(raw: unknown, issue: IssueFn, modelId: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined; // ausente = desconhecido (heuristica)
  if (isStringArray(raw)) return [...raw];
  issue(
    modelId,
    'supported_parameters',
    'error',
    'malformado — nenhum parametro opcional sera enviado a este modelo (fail-closed)',
  );
  return [];
}

/**
 * Converte o payload cru de /models no tipo de dominio E devolve o que estava
 * errado nele (puro; exportado p/ testes e para o snapshot de contrato).
 */
export function validateModelsPayload(json: unknown): {
  models: OpenRouterModel[];
  issues: CatalogIssue[];
} {
  const issues: CatalogIssue[] = [];
  const issue: IssueFn = (modelId, field, severity, message) =>
    issues.push({ modelId, field, severity, message });
  const raw = Array.isArray((json as { data?: unknown[] } | null)?.data)
    ? ((json as { data: unknown[] }).data)
    : [];
  const models: OpenRouterModel[] = [];
  raw.forEach((m, i) => {
    if (!m || typeof m !== 'object') {
      issue(`#${i}`, '', 'error', 'item nao e um objeto — descartado');
      return;
    }
    const item = m as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) {
      issue(`#${i}`, 'id', 'error', 'sem id — modelo descartado');
      return;
    }

    let pricing = item.pricing as Record<string, unknown> | undefined;
    if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
      issue(id, 'pricing', 'warn', 'ausente ou malformado — preco desconhecido');
      pricing = {};
    }

    let contextLength: number | undefined;
    if (typeof item.context_length === 'number' && Number.isFinite(item.context_length) && item.context_length > 0) {
      contextLength = item.context_length;
    } else if (item.context_length !== undefined && item.context_length !== null) {
      issue(id, 'context_length', 'warn', 'nao numerico — contexto desconhecido');
    }

    const { meta, stripReasoning } = parseReasoningMeta(item.reasoning, issue, id);
    let supportedParameters = parseSupportedParameters(item.supported_parameters, issue, id);
    if (stripReasoning && supportedParameters) {
      supportedParameters = supportedParameters.filter((p) => !REASONING_WIRE_PARAMS.has(p));
    }

    models.push({
      id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name : id,
      contextLength,
      pricing: {
        prompt: priceField(pricing.prompt, issue, id, 'pricing.prompt'),
        completion: priceField(pricing.completion, issue, id, 'pricing.completion'),
        overrides: parsePricingTiers(pricing.overrides, issue, id),
      },
      supportedParameters,
      reasoning: meta,
      // IMPL-019: canonical_slug/expiration_date/alias_target/created — a run
      // grava o snapshot e o CLI alerta 30/14/7 dias (src/engine/modelLifecycle.ts).
      ...parseLifecycleMeta(item),
      raw: item,
    });
  });
  return { models, issues };
}

/** Converte o payload cru de /models no tipo de dominio (puro; exportado p/ testes). */
export function parseModelsPayload(json: unknown): OpenRouterModel[] {
  return validateModelsPayload(json).models;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionResult {
  /** Resposta do modelo, já REIDRATADA (tokens de dado pessoal → valor original). */
  text: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  /** Payload do fio como o provedor devolveu (pseudonimizado: com os tokens). */
  raw: unknown;
  /** Custo da chamada. Sempre presente; a honestidade fica em `cost.source`. */
  cost: CallCost;
  cachedTokensIn?: number;
  reasoningTokens?: number;
  /** `choices[0].finish_reason` normalizado pelo OpenRouter (stream: o ultimo nao-nulo). */
  finishReason?: string;
  /** `choices[0].native_finish_reason` — o valor cru do provedor. */
  nativeFinishReason?: string;
  /** Recusa DECLARADA pelo modelo (`message.refusal` / `delta.refusal`). `text` segue so com o conteudo. */
  refusal?: string;
  /**
   * Presente = filtro de conteudo/moderacao cortou a resposta (HTTP 200 com
   * `finish_reason` de filtro, ou erro in-band de moderacao depois de texto
   * parcial). `text` pode ter o trecho gerado antes do corte — so para auditoria.
   */
  blocked?: GatewayBlock;
  /**
   * A saida foi CORTADA no teto de `max_tokens` (IMPL-014 / R-07b:DEC-2) —
   * decidido aqui, no ponto unico, para TODO papel (competidor, gabarito,
   * juiz, duelo, datagen, reescritor): `finish_reason`/`native_finish_reason`
   * de teto, ou os sinais auxiliares (raciocinio ≈ teto, conteudo vazio com
   * `completion_tokens > 0`) — ver `engine/truncation.ts`. Sempre presente
   * numa chamada que completou. O gateway NAO repete: quem decide o retry x2 e
   * o papel (o competidor e o gabarito repetem; o juiz e o IMPL-015).
   */
  truncated?: boolean;
  /** Sinais de truncamento observados (inclusive os auxiliares que sozinhos nao decidem). */
  truncationSignals?: TruncationSignal[];
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

/**
 * Escopo do cofre de pseudonimos: a RAIZ do ledger (run avulsa ou sessao de
 * treino inteira), quando o sink sabe dize-la; senao o proprio sink. Sem sink
 * (chamada avulsa) = cofre da instancia.
 */
function piiScopeOf(sink?: CostSink): object | undefined {
  if (!sink) return undefined;
  return typeof sink.piiScope === 'function' ? sink.piiScope() : sink;
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
  /** Alertas da ultima validacao de /models, por key (ver `validateModelsPayload`). */
  private readonly modelsIssues = new Map<string, CatalogIssue[]>();
  // LGPD (IMPL-042): cascata de dado pessoal — uma por instância (contadores
  // próprios; cofre de pseudônimos com chave HMAC própria POR RUN/SESSÃO),
  // aplicada em `buildBody`, o ponto único dos 6 papéis.
  private readonly piiGuard = createPiiGuard();

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

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    const s = this.cfg.sleep ?? defaultSleep;
    return s(ms, signal);
  }

  /**
   * Espera de backoff SENSÍVEL ao Cancelar (IMPL-020). O backoff chega a ~8 s
   * por tentativa: sem isto, cancelar durante um 429/5xx não mandava chamada
   * nova, mas a run só fechava quando o sono acabava (a UI ficava presa em
   * "Cancelando…"). Abortou antes ou durante => sinal de controle na hora.
   */
  private async backoff(attempt: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return this.sleep(backoffMs(attempt));
    if (signal.aborted) throw toControlSignal(signal.reason);
    let onAbort: () => void = () => undefined;
    const abortou = new Promise<never>((_, reject) => {
      onAbort = () => reject(toControlSignal(signal.reason));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([this.sleep(backoffMs(attempt), signal), abortou]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    // A espera injetada pode resolver no próprio abort: nesse caso, controle.
    if (signal.aborted) throw toControlSignal(signal.reason);
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

    const { models: data, issues } = validateModelsPayload(await res.json());
    this.modelsCache.set(ck, { fetchedAt: Date.now(), data });
    this.modelsIssues.set(ck, issues);
    return data;
  }

  /**
   * Alertas da ultima busca de /models (fail-open `warn` e fail-closed
   * `error`). Vazio = catalogo limpo ou ainda nao buscado nesta instancia.
   * O gateway nao imprime nada (stdout do CLI e payload); quem mostra decide.
   */
  catalogIssues(apiKey: string): CatalogIssue[] {
    return [...(this.modelsIssues.get(cacheKey(apiKey)) ?? [])];
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
      await limiter.acquire(externalSignal);
      // Abortou entre ganhar a vaga e enviar: devolve a vaga SEM tocar o
      // transporte (zero chamadas novas depois do Cancelar — IMPL-020).
      if (externalSignal?.aborted) {
        limiter.release();
        throw toControlSignal(externalSignal.reason);
      }
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
        // Abort EXTERNO (Cancelar/Ctrl-C) sai como SINAL DE CONTROLE, aqui no
        // ponto unico: o que o transporte rejeita varia por runtime, e um erro
        // comum seria degradado pelos papeis em nota inventada (IMPL-020).
        if (externalSignal?.aborted) throw toControlSignal(externalSignal.reason);
        // abort (timeout) nao repete; erro de rede repete com backoff.
        if (controller.signal.aborted || attempt >= MAX_RETRIES) throw err;
        await this.backoff(attempt, externalSignal);
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
          await this.backoff(attempt, externalSignal);
          attempt += 1;
          continue;
        }
        const errText = await res.text().catch(() => '');
        cleanup();
        limiter.release();
        if (externalSignal?.aborted) throw toControlSignal(externalSignal.reason);
        // Classificado: 403 de moderacao sai como 'blocked' (nao "key invalida").
        throw classifyHttpError(status, errText);
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
      messages: this.protectMessages(messages, params.sink),
      ...deterministicSampling(model, modelId, temperature),
    };
    if (stream) body.stream = true;
    if (typeof maxTokens === 'number' && maxTokens > 0) body.max_tokens = maxTokens;
    if (responseFormatJson) body.response_format = { type: 'json_object' };
    // O esforco pedido e ENCAIXADO no que este modelo declara aceitar (ver
    // fitEffort/applyReasoning): allowlist propria por modelo e raciocinio
    // obrigatorio em alguns (onde 'off' nao pode ser enviado).
    // Fail-closed (IMPL-018): o catalogo declara que o modelo nao aceita
    // raciocinio (ou a allowlist veio malformada) => nada de `reasoning` no fio.
    if (params.reasoningLevel && !catalogDeniesReasoning(model)) {
      applyReasoning(body, params.reasoningLevel, model?.reasoning);
    }
    applyMaxPrice(body, params.maxPricePerMTok);
    return body;
  }

  /**
   * LGPD (IMPL-042): NENHUMA mensagem vira corpo de requisicao sem passar pela
   * cascata de dado pessoal (src/engine/pii.ts) — identificadores estruturados
   * realistas (CPF, CNPJ, CNS, RG, CEP, telefone, e-mail, CRM) saem
   * pseudonimizados (HMAC com chave secreta POR RUN/SESSAO: o escopo e a raiz
   * do ledger da chamada); nomes/enderecos so sao contados (camada
   * `nao-coberto`). Obrigatoria: nao ha parametro que desligue.
   */
  private protectMessages(messages: ChatMessage[], sink?: CostSink): ChatMessage[] {
    return this.piiGuard.protect(messages, piiScopeOf(sink));
  }

  /**
   * A VOLTA (R-16 DEC-5, reversao fora do caminho de envio): tokens do cofre do
   * escopo viram de novo o valor original ANTES de a resposta chegar aos papeis.
   * Sem isto o token vazava irreversivel para o que o usuario recebe (variante
   * campea gravada por `sessions winner --apply`, cenario, gabarito) e o
   * contrato `neverBreak` com o valor original rejeitava toda reescrita. O mapa
   * token→valor so existe em memoria, no cofre; o reenvio re-tokeniza igual.
   */
  private restoreText(text: string, sink?: CostSink, count = true): string {
    return this.piiGuard.restore(text, piiScopeOf(sink), count);
  }

  /**
   * Os MESMOS tokens que o envio usaria no escopo de `sink` — utilitario para
   * comparar localmente com o que o modelo viu (diagnostico/teste). Nao conta
   * como chamada.
   */
  pseudonymize<T>(value: T, sink?: CostSink): T {
    return this.piiGuard.vaultFor(piiScopeOf(sink)).redactDeep(value);
  }

  /** Contadores da cascata (o teste prova: chamadas varridas == chamadas enviadas). */
  piiStats(): PiiGuardStats {
    return this.piiGuard.stats();
  }

  /**
   * O PONTO UNICO da contabilidade: precifica e lanca no ledger (role + sink).
   * `finish` (IMPL-014): os sinais de fim da chamada que COMPLETOU vao junto —
   * e assim que TODO papel (juiz e duelo inclusive) tem finish_reason/
   * native_finish_reason/truncamento no RunRecord (`finishSignalsByRole`).
   */
  private account(
    params: ChatCompletionParams,
    reservation: ReturnType<CostSink['reserve']> | undefined,
    usage: UsageInfo,
    finish?: CallFinishSignals,
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
        ...(finish ? { finish } : {}),
      });
    }
    return cost;
  }

  /**
   * Sinais de fim -> decisao de truncamento (IMPL-014), igual para JSON e SSE.
   * `explainedEmpty`: conteudo vazio de bloqueio/recusa ja tem motivo proprio
   * e nao conta como "vazio com tokens".
   */
  private truncationOf(
    maxTokens: number | undefined,
    usage: UsageInfo,
    text: string,
    finishReason: string | undefined,
    nativeFinishReason: string | undefined,
    explainedEmpty: boolean,
  ): Pick<ChatCompletionResult, 'truncated' | 'truncationSignals'> {
    const obs = {
      finishReason,
      nativeFinishReason,
      reasoningTokens: usage.reasoningTokens,
      tokensOut: usage.tokensOut,
      contentChars: text.length,
      maxTokens: typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : undefined,
      explainedEmpty,
    };
    const sinais = truncationSignals(obs);
    return {
      truncated: isTruncated(obs, sinais),
      ...(sinais.length > 0 ? { truncationSignals: sinais } : {}),
    };
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
        choices?: {
          message?: { content?: string | null; refusal?: string | null };
          finish_reason?: string | null;
          native_finish_reason?: string | null;
        }[];
        usage?: unknown;
        error?: OpenRouterErrorBody;
      };

      const usage = extractUsage(json.usage);
      const choice = json.choices?.[0];
      // Reidratada: o papel recebe o valor original, nunca o token (LGPD, IMPL-042).
      const text = this.restoreText(choice?.message?.content ?? '', sink);
      const finishReason = finishText(choice?.finish_reason);
      const nativeFinishReason = finishText(choice?.native_finish_reason);
      const inBandBlock = json.error ? blockFromErrorBody(json.error, undefined, 'in_band') : undefined;
      // OpenRouter as vezes devolve 200 com um corpo de erro (ex.: provider
      // rejeitou um parametro). Sem isto a falha viraria "resposta vazia" muda.
      const inBandFailure = !text && Boolean(json.error);
      const blocked = inBandBlock ?? blockFromFinishReason(finishReason, nativeFinishReason);
      const refusal = refusalText(choice?.message?.refusal);
      const trunc = this.truncationOf(
        maxTokens,
        usage,
        text,
        finishReason,
        nativeFinishReason,
        Boolean(blocked || refusal),
      );
      // Contabiliza ANTES do throw in-band: uma resposta 200 com corpo de erro
      // (provider rejeitou um parametro) JA foi cobrada. Sem isto ela sai de
      // graca nos livros e cara na fatura. Os sinais de fim so vao junto
      // quando a chamada completou (a falha in-band nao tem fim a medir).
      const cost = this.account(
        params,
        reservation,
        usage,
        inBandFailure
          ? undefined
          : finishSignalsOf(
              { text, tokensOut: usage.tokensOut, reasoningTokens: usage.reasoningTokens, finishReason, nativeFinishReason, ...trunc },
              maxTokens,
            ),
      );
      if (inBandFailure && json.error) {
        if (inBandBlock) throw new GatewayError('blocked', inBandBlock.message, { block: inBandBlock });
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
        ...(finishReason ? { finishReason } : {}),
        ...(nativeFinishReason ? { nativeFinishReason } : {}),
        ...(refusal ? { refusal } : {}),
        ...(blocked ? { blocked } : {}),
        ...trunc,
      };
    } catch (err) {
      throw controlIfAborted(err, externalSignal);
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
    let streamError: OpenRouterErrorBody | null = null;
    // Sinais de fim: chegam num chunk proprio perto do fim (antes do frame de
    // usage). Guarda o ULTIMO nao-nulo — chunks intermediarios trazem null.
    let finishReason: string | undefined;
    let nativeFinishReason: string | undefined;
    let refusal = '';

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
              choices?: {
                delta?: { content?: string | null; refusal?: string | null };
                finish_reason?: string | null;
                native_finish_reason?: string | null;
              }[];
              usage?: unknown;
              error?: OpenRouterErrorBody;
            };
            lastRaw = chunk;
            if (chunk.error && !streamError) {
              streamError =
                typeof chunk.error === 'object' ? chunk.error : { message: String(chunk.error) };
            }
            const choice = chunk.choices?.[0];
            const delta = choice?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              fullText += delta;
              // Previa ja reidratada (sem contar: e a mesma resposta a cada pedaco).
              // `delta` e o pedaco cru do provedor — pode trazer token parcial.
              onDelta?.(delta, this.restoreText(fullText, sink, false));
            }
            if (typeof choice?.delta?.refusal === 'string') refusal += choice.delta.refusal;
            finishReason = finishText(choice?.finish_reason) ?? finishReason;
            nativeFinishReason = finishText(choice?.native_finish_reason) ?? nativeFinishReason;
            if (chunk.usage) usageRaw = chunk.usage;
          } catch {
            // chunk JSON invalido, ignora
          }
        }
      }

      const usage = extractUsage(usageRaw);

      // Erro no MEIO do stream chega como chunk `{ error, finish_reason: 'error' }`
      // (o HTTP ja foi 200): moderacao aqui e bloqueio, nao "resposta vazia".
      const inBandBlock = streamError ? blockFromErrorBody(streamError, undefined, 'in_band') : undefined;
      const inBandFailure = !fullText && Boolean(streamError);
      const blocked = inBandBlock ?? blockFromFinishReason(finishReason, nativeFinishReason);
      const refusalFinal = refusalText(refusal);
      // No stream o finish_reason chega no penultimo chunk e o usage (com
      // reasoning_tokens) no ultimo: so aqui, com o fluxo inteiro lido, da
      // para decidir o truncamento.
      const trunc = this.truncationOf(
        maxTokens,
        usage,
        fullText,
        finishReason,
        nativeFinishReason,
        Boolean(blocked || refusalFinal),
      );
      // Contabiliza antes do throw in-band — a chamada ja foi cobrada. Sinais
      // de fim so quando a chamada completou.
      const cost = this.account(
        params,
        reservation,
        usage,
        inBandFailure
          ? undefined
          : finishSignalsOf(
              {
                text: fullText,
                tokensOut: usage.tokensOut,
                reasoningTokens: usage.reasoningTokens,
                finishReason,
                nativeFinishReason,
                ...trunc,
              },
              maxTokens,
            ),
      );
      // Resposta vazia + erro in-band (provider rejeitou parametro etc.): falha alto.
      if (inBandFailure && streamError) {
        if (inBandBlock) throw new GatewayError('blocked', inBandBlock.message, { block: inBandBlock });
        throw new Error(`OpenRouter: ${streamError.message ?? JSON.stringify(streamError)}`);
      }

      const latencyMs = Date.now() - startedAt;
      ok = true;
      return {
        // Texto final acumulado, reidratado (LGPD, IMPL-042).
        text: this.restoreText(fullText, sink),
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        latencyMs,
        raw: lastRaw,
        cost,
        cachedTokensIn: usage.cachedTokensIn,
        reasoningTokens: usage.reasoningTokens,
        ...(finishReason ? { finishReason } : {}),
        ...(nativeFinishReason ? { nativeFinishReason } : {}),
        ...(refusalFinal ? { refusal: refusalFinal } : {}),
        ...(blocked ? { blocked } : {}),
        ...trunc,
      };
    } catch (err) {
      throw controlIfAborted(err, externalSignal);
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

    // Aqui (e SO aqui) 403 ainda e problema de credencial: `GET /key` nao tem
    // conteudo para moderar. Nas chamadas de geracao 403 e BLOQUEIO
    // (`classifyHttpError`) — nao "unifique" os dois caminhos (IMPL-010).
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

/** Pseudonimiza `value` com o cofre do escopo de `sink` na instancia padrao (ver o metodo). */
export function pseudonymize<T>(value: T, sink?: CostSink): T {
  return defaultGateway.pseudonymize(value, sink);
}

export function validateKey(apiKey: string): Promise<ValidateKeyResult> {
  return defaultGateway.validateKey(apiKey);
}
