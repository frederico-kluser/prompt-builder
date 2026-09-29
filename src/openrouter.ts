import { applyReasoning } from './reasoning.js';
import { parseLifecycleMeta } from './engine/modelLifecycle.js';
import { isControlSignal, isGenerationId, toControlSignal, type SettleDetails } from './budget.js';
import { classifyPrice, priceTokens, type PriceFieldKind } from './engine/pricing.js';
import { effortLabelOf, finishSignalsOf, isTruncated, truncationSignals } from './engine/truncation.js';
import { createPiiGuard, type PiiGuardStats } from './engine/pii.js';
import { applySensitiveRouting } from './engine/sensitiveRouting.js';
import {
  judgeContractHash,
  VerdictCache,
  verdictCacheKey,
  type VerdictCacheEntry,
} from './engine/verdictCache.js';
import type {
  CallCost,
  CallFinishSignals,
  CallProviderInfo,
  CostLedgerSummary,
  CostRole,
  CostSink,
  ModelReasoningMeta,
  PendingCall,
  PendingReason,
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
/**
 * Re-tentativas de transientes (429/5xx/rede ANTES do envio). IMPL-073
 * (R-07a:REC-3): 1 + 4 = no maximo 5 tentativas HTTP por RESPOSTA — o teto
 * de mercado (2-4 re-tentativas) somando os dois niveis: o laco do competidor
 * NAO repete o que o gateway ja re-tentou (`isCallerRetryable`). Antes eram
 * 7 por chamada e 14 por resposta do competidor. `Retry-After` e piso.
 */
export const MAX_RETRIES = 4;
/**
 * Teto de saida quando o chamador nao passa `maxTokens` (IMPL-017): o corpo
 * SEMPRE leva `max_tokens` e a reserva usa o MESMO numero. Antes a reserva
 * assumia 1024 enquanto a saida seguia ilimitada — sem limite de estouro.
 * Os papeis do pipeline passam o proprio teto; isto so cobre chamada avulsa.
 */
export const DEFAULT_MAX_TOKENS = 4096;

/** IMPL-077 — teto de `listModels`/`validateKey`/`/generation` (ms): servidor mudo não pendura o processo. */
export const DEFAULT_META_TIMEOUT_MS = 20_000;

/** O teto que vai no corpo E na reserva — um numero so. */
export function effectiveMaxTokens(maxTokens: number | undefined): number {
  return typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS;
}

/**
 * Id da geracao (`gen-…`) no corpo/chunk — chave da conciliacao via GET
 * /generation. Devolve o id CRU (qualquer texto nao vazio): quem decide se ele
 * e conciliavel e `isGenerationId` (formato do OpenRouter) — o registo guarda
 * os dois (id + validade), a conciliacao so consulta os validos.
 */
function generationIdOf(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const id = (payload as { id?: unknown }).id;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

/**
 * IMPL-075 (R-07b:REC-4) — provedor da chamada a partir do PAYLOAD (o campo
 * `provider` que o OpenRouter devolve em JSON e em todo chunk SSE). Ausente =
 * undefined (quem chama decide se busca no GET /generation).
 */
export function extractProviderInfo(payload: unknown): CallProviderInfo | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const name = str(p.provider_name) ?? str(p.provider);
  const upstreamId = str(p.upstream_id) ?? str(p.upstreamId);
  const serviceTier = str(p.service_tier) ?? str(p.serviceTier);
  if (!name && !upstreamId && !serviceTier) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(upstreamId ? { upstreamId } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

/** Junta duas fontes de provedor (payload + /generation); a SEGUNDA vence campo a campo. */
function mergeProviderInfo(base: CallProviderInfo | undefined, extra: CallProviderInfo | undefined): CallProviderInfo | undefined {
  if (!base && !extra) return undefined;
  const name = extra?.name ?? base?.name;
  const upstreamId = extra?.upstreamId ?? base?.upstreamId;
  const serviceTier = extra?.serviceTier ?? base?.serviceTier;
  return {
    ...(name ? { name } : {}),
    ...(upstreamId ? { upstreamId } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}
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
  /**
   * IMPL-120 (R-01b:REC-9) — headers de ATRIBUICAO (`HTTP-Referer`/`X-Title`)
   * sao DADO enviado ao OpenRouter (terceiro): `false` = nenhum dos dois vai no
   * fio. Ausente/true = enviados (comportamento historico). No Node quem liga a
   * supressao e `PROMPT_BUILDER_NO_ATTRIBUTION` (src/gatewayEnv.ts); na SPA, a
   * preferencia salva no navegador (shim web/src/engine/openrouter.ts).
   */
  attribution?: boolean;
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
  /**
   * IMPL-072 (R-07a:REC-1) — transporte STREAMING (`stream: true` + SSE)
   * também para `chatCompletion` (juiz, duelo, gabarito, datagen, reescritor):
   * em abort/timeout o provedor PARA de gerar (e cobra só o gerado) — no
   * não-streaming ele continua e cobra a resposta inteira (~98,7% do gasto
   * ficava exposto a abort cobrado). LIGADO em todo ponto de entrada de
   * runtime (Node: `gatewayConfigFromEnv`, com a válvula de escape
   * `OPENROUTER_STREAM_TRANSPORT=0`; SPA: `browserGatewayConfig`); a instância
   * crua de `createGateway()` fica no caminho JSON histórico. O parser aceita
   * um corpo JSON mesmo pedindo stream (proxy/mock que ignora `stream: true`).
   */
  streamTransport?: boolean;
  /**
   * IMPL-077 — timeouts por papel (inatividade/total). Parcial: o que faltar
   * cai em `DEFAULT_ROLE_TIMEOUTS`; valores recortados para 1-600 s.
   */
  roleTimeouts?: Partial<Record<CostRole, Partial<RoleTimeouts>>>;
  /** IMPL-077 — teto de `listModels`/`validateKey` (ms). Default 20 s. */
  metaTimeoutMs?: number;
  /**
   * IMPL-073 — janela (ms) da guarda anti-reenvio: falha DEPOIS dos headers
   * com desfecho desconhecido bloqueia reenvio do MESMO corpo até a
   * conciliação (ou o fim da janela). 0 = desliga.
   */
  resendGuardTtlMs?: number;
  /**
   * IMPL-075 — preenchimento de `provider_name`/`upstream_id`/`service_tier`
   * via GET /api/v1/generation. 'off' = só o payload; 'missing' = busca quando
   * o payload nao trouxer o provedor (DEFAULT: cobertura de registro = 1,0 —
   * critério (iii) do item — e zero GET extra quando o payload ja nomeia o
   * provedor, que e o caso normal do OpenRouter); 'always' = sempre (modo
   * auditável).
   */
  providerLookup?: 'off' | 'missing' | 'always';
  /**
   * IMPL-075 — modo auditável: papéis que recebem `provider { order,
   * quantizations, allow_fallbacks:false, require_parameters:true }`. Preset do
   * item: `AUDITABLE_ROLES` (juiz + gabarito). Vazio = desligado.
   */
  auditableRoles?: CostRole[];
  /** Ordem fixa de provedores do modo auditável (`provider.order`). Vazio = omitido. */
  auditableProviderOrder?: string[];
  /** Quantizações aceitas no modo auditável (`provider.quantizations`). */
  auditableQuantizations?: string[];
  /**
   * IMPL-076 — teto DIARIO de chamadas a modelos `:free` por key (o por minuto
   * e fixo: 20). O provedor muda o teto diario com creditos (50/dia sem,
   * 1.000/dia com) — default conservador `FREE_DAILY_LIMIT_DEFAULT` (50);
   * conta com creditos levanta para 1.000.
   */
  freeDailyLimit?: number;
  /**
   * IMPL-080 (R-08:REC-3) — cache EXATO de vereditos (papéis judge/duel/
   * gabarito): reusa vereditos de requisições idênticas entre iterações do
   * treino (carry), com TTL e re-teste amostral obrigatório (o não-determinismo
   * do provedor não fica escondido). Instância de `VerdictCache`; AUSENTE ou
   * `false` = desligado (default) — quem liga é a sessão de treino.
   */
  verdictCache?: VerdictCache | false;
}

/** Preset do modo auditável (IMPL-075): juiz e gabarito — os papéis de REFERÊNCIA. */
export const AUDITABLE_ROLES: readonly CostRole[] = ['judge', 'gabarito'];
/** Quantizações de precisão cheia do modo auditável (auditável = sem quantização lossy). */
export const DEFAULT_AUDITABLE_QUANTIZATIONS: readonly string[] = ['bf16', 'fp16', 'fp32'];

const DEFAULT_CONFIG: GatewayConfig = {
  baseUrl: DEFAULT_OPENROUTER_BASE_URL,
  appUrl: DEFAULT_APP_URL,
  appTitle: DEFAULT_APP_TITLE,
  maxConcurrency: DEFAULT_MAX_CONCURRENCY,
  modelsCacheTtlMs: MODELS_CACHE_TTL_MS,
  attribution: true,
  // IMPL-072: a instância CRUA (`createGateway()` sem config — testes com
  // transporte falso) fica no caminho JSON; TODO ponto de entrada de runtime
  // liga o streaming: Node por `gatewayConfigFromEnv` (CLI, servidor, MCP,
  // biblioteca — src/index.ts) e a SPA por `browserGatewayConfig`. Contrato
  // em test/gateway-transport.test.ts ("default de RUNTIME").
  streamTransport: false,
  metaTimeoutMs: DEFAULT_META_TIMEOUT_MS,
  resendGuardTtlMs: 120_000,
  // IMPL-075 (iii): 'missing' por omissao — toda chamada com id de geracao
  // fica com providerName registrado (payload ou GET /generation), cobertura 1,0.
  providerLookup: 'missing',
  auditableRoles: [],
  auditableProviderOrder: [],
  auditableQuantizations: [...DEFAULT_AUDITABLE_QUANTIZATIONS],
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
  if (typeof patch.attribution === 'boolean') out.attribution = patch.attribution;
  if (typeof patch.maxConcurrency === 'number' && Number.isFinite(patch.maxConcurrency)) {
    out.maxConcurrency = Math.max(MIN_CONCURRENCY, Math.floor(patch.maxConcurrency));
  }
  if (typeof patch.modelsCacheTtlMs === 'number' && Number.isFinite(patch.modelsCacheTtlMs)) {
    out.modelsCacheTtlMs = Math.max(0, patch.modelsCacheTtlMs);
  }
  if (typeof patch.streamTransport === 'boolean') out.streamTransport = patch.streamTransport;
  // Timeouts por papel: mescla por papel, recortando para 1-600 s (IMPL-077).
  if (patch.roleTimeouts && typeof patch.roleTimeouts === 'object') {
    const merged: Partial<Record<CostRole, Partial<RoleTimeouts>>> = { ...(base.roleTimeouts ?? {}) };
    for (const [role, t] of Object.entries(patch.roleTimeouts) as [CostRole, Partial<RoleTimeouts>][]) {
      if (!t || typeof t !== 'object') continue;
      const prev = merged[role] ?? {};
      merged[role] = {
        ...(typeof prev.idleMs === 'number' ? { idleMs: prev.idleMs } : {}),
        ...(typeof prev.totalMs === 'number' ? { totalMs: prev.totalMs } : {}),
        ...(typeof t.idleMs === 'number' ? { idleMs: clampRoleTimeoutMs(t.idleMs) } : {}),
        ...(typeof t.totalMs === 'number' ? { totalMs: clampRoleTimeoutMs(t.totalMs) } : {}),
      };
    }
    out.roleTimeouts = merged;
  }
  if (typeof patch.metaTimeoutMs === 'number' && Number.isFinite(patch.metaTimeoutMs)) {
    out.metaTimeoutMs = Math.max(1_000, Math.floor(patch.metaTimeoutMs));
  }
  if (typeof patch.resendGuardTtlMs === 'number' && Number.isFinite(patch.resendGuardTtlMs)) {
    out.resendGuardTtlMs = Math.max(0, Math.floor(patch.resendGuardTtlMs));
  }
  if (patch.providerLookup === 'off' || patch.providerLookup === 'missing' || patch.providerLookup === 'always') {
    out.providerLookup = patch.providerLookup;
  }
  if (Array.isArray(patch.auditableRoles)) {
    out.auditableRoles = patch.auditableRoles.filter((r): r is CostRole => typeof r === 'string');
  }
  if (Array.isArray(patch.auditableProviderOrder)) {
    out.auditableProviderOrder = patch.auditableProviderOrder.filter((p) => typeof p === 'string' && p.trim());
  }
  if (Array.isArray(patch.auditableQuantizations)) {
    out.auditableQuantizations = patch.auditableQuantizations.filter((q) => typeof q === 'string' && q.trim());
  }
  // IMPL-076: teto diario :free (>= 1; nao-numerico e ignorado).
  if (typeof patch.freeDailyLimit === 'number' && Number.isFinite(patch.freeDailyLimit) && patch.freeDailyLimit >= 1) {
    out.freeDailyLimit = Math.floor(patch.freeDailyLimit);
  }
  // IMPL-080: cache de vereditos — instancia explicita; `false` desliga.
  if (patch.verdictCache !== undefined) out.verdictCache = patch.verdictCache === false ? undefined : patch.verdictCache;
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
// Limitador de concorrencia ADAPTATIVO (AIMD), por ESCOPO (key, modelo) com
// refinamento por provedor (IMPL-076, R-07a:REC-5).
// O limite CRESCE no sucesso (so quando ha pressao: saturado ou com fila) e
// RECUA pela metade quando o provedor devolve 429 — converge para o maximo que
// o provedor aguenta, "brigando" para rodar no teto sem derrubar com 429.
// O recuo e LIMITADO: no maximo 1 decremento por janela (>= 1 s) — o provedor
// castiga em rajada e antes cada 429 da rajada contava um recuo (5 seguidos
// derrubavam 32 -> 1, com ~31 sucessos sob pressao para voltar).
// ---------------------------------------------------------------------------

export interface LimiterSnapshot {
  limit: number;
  active: number;
  queued: number;
}

/**
 * IMPL-076 — janela de decremento do AIMD (ms): uma rajada de 429 corta o
 * limite NO MAXIMO uma vez por janela. O piso e 1 s — o chamador pode pedir
 * janela maior, nunca menor.
 */
export const AIMD_DECREASE_WINDOW_MS = 1000;

export interface AimdLimiterOptions {
  /** Janela de decremento em ms. Piso: `AIMD_DECREASE_WINDOW_MS` (1 s). */
  decreaseWindowMs?: number;
  /** Relogio injetavel (testes com fake timers). Default `Date.now`. */
  now?: () => number;
}

export class AimdLimiter {
  private limit: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly decreaseWindowMs: number;
  private readonly now: () => number;
  /** Instante do ultimo decremento — -infinito = ainda nao recuou nesta janela. */
  private lastDecreaseAt = Number.NEGATIVE_INFINITY;

  constructor(private max: number, opts?: AimdLimiterOptions) {
    this.limit = Math.min(INITIAL_CONCURRENCY, max);
    this.decreaseWindowMs = Math.max(AIMD_DECREASE_WINDOW_MS, opts?.decreaseWindowMs ?? AIMD_DECREASE_WINDOW_MS);
    this.now = opts?.now ?? Date.now;
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

  /**
   * Recuo multiplicativo: metade, com piso 1. IMPL-076: no maximo 1 recuo por
   * janela (>= 1 s) — uma rajada de 429 do provedor e UM castigo, nao N.
   */
  noteRateLimit(): void {
    const agora = this.now();
    if (agora - this.lastDecreaseAt < this.decreaseWindowMs) return;
    this.lastDecreaseAt = agora;
    this.limit = Math.max(MIN_CONCURRENCY, Math.floor(this.limit / 2));
  }

  snapshot(): LimiterSnapshot {
    return { limit: this.limit, active: this.active, queued: this.waiters.length };
  }
}

// ---------------------------------------------------------------------------
// IMPL-076 — ESCOPOS do limitador: um limitador por (key, modelo) com
// refinamento por provedor, e um teto estatico por INSTANCIA por cima.
//
// ANTES havia UM estado AIMD para todas as keys: no servidor multiusuario um
// 429 de um usuario derrubava o limite de TODOS (anti-padrao). Agora:
//   • escopo base = (key, modelo) — 429 sem provedor identificado recua aqui;
//   • refinamento = (key, modelo, provedor) — quando o 429 traz
//     `error.metadata.provider_code` a pressao e DO PROVEDOR: em chamada
//     fixada nele so o refino recua (os demais provedores seguem livres); em
//     chamada livre recuam o base (a rota pode devolver o mesmo) e o refino;
//   • o teto por instancia (`OPENROUTER_MAX_CONCURRENCY`, divisao estatica
//     entre processos) continua valendo por cima de todos os escopos.
// ---------------------------------------------------------------------------

/** Escopo de um limitador: key (sufixo identificador) + modelo [+ provedor fixado]. */
export interface LimiterScope {
  keyId: string;
  modelId: string;
  /** Provedor fixado no corpo (order/only com 1 entrada) — refina o escopo. */
  provider?: string;
}

function scopeKeyOf(keyId: string, modelId: string, provider?: string): string {
  return provider ? `${keyId}\u0000${modelId}\u0000${provider}` : `${keyId}\u0000${modelId}`;
}

/**
 * Teto estatico por instancia (a "divisao estatica" entre processos via
 * OPENROUTER_MAX_CONCURRENCY): fila FIFO com abort (IMPL-020). Nao e adaptativo
 * de proposito — o AIMD mora nos escopos; aqui e so o teto de processamento.
 */
class CapacityGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private capacity: number) {}

  setCapacity(capacity: number): void {
    this.capacity = Math.max(MIN_CONCURRENCY, Math.floor(capacity));
    while (this.waiters.length > 0 && this.active < this.capacity) {
      const next = this.waiters.shift()!;
      this.active += 1;
      next();
    }
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(toControlSignal(signal.reason));
    if (this.active < this.capacity) {
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
    while (this.waiters.length > 0 && this.active < this.capacity) {
      const next = this.waiters.shift()!;
      this.active += 1;
      next();
    }
  }

  get queued(): number {
    return this.waiters.length;
  }
}

/**
 * Vaga segurada numa chamada: o `release` devolve na ordem inversa da aquisicao
 * (porta -> refino -> base) e o `note*` mexe SÓ nos limitadores adquiridos.
 */
export interface LimiterSlot {
  noteSuccess(): void;
  /** Recuo AIMD do 429. `providerCode` = upstream que devolveu o erro. */
  noteRateLimit(providerCode?: string): void;
  release(): void;
}

class ScopedAimdLimiters {
  private readonly map = new Map<string, AimdLimiter>();
  private readonly gate: CapacityGate;

  constructor(private max: number) {
    this.gate = new CapacityGate(max);
  }

  setMax(max: number): void {
    this.max = Math.max(MIN_CONCURRENCY, Math.floor(max));
    for (const l of this.map.values()) l.setMax(this.max);
    this.gate.setCapacity(this.max);
  }

  private for(keyId: string, modelId: string, provider?: string): AimdLimiter {
    const k = scopeKeyOf(keyId, modelId, provider);
    let l = this.map.get(k);
    if (!l) {
      l = new AimdLimiter(this.max);
      this.map.set(k, l);
    }
    return l;
  }

  /**
   * Aquisicao em cadeia (base -> refino -> teto global): o espera mais comum e
   * a do escopo proprio, que nao segura vaga dos outros usuarios.
   */
  async acquire(scope: LimiterScope, signal?: AbortSignal): Promise<LimiterSlot> {
    const base = this.for(scope.keyId, scope.modelId);
    await base.acquire(signal);
    let refinement: AimdLimiter | undefined;
    if (scope.provider) {
      refinement = this.for(scope.keyId, scope.modelId, scope.provider);
      try {
        await refinement.acquire(signal);
      } catch (err) {
        base.release();
        throw err;
      }
    }
    try {
      await this.gate.acquire(signal);
    } catch (err) {
      refinement?.release();
      base.release();
      throw err;
    }
    return {
      noteSuccess: () => {
        base.noteSuccess();
        refinement?.noteSuccess();
      },
      noteRateLimit: (providerCode?: string) => {
        if (refinement) {
          // Chamada FIXADA num provedor: a pressao e dele — so o refino recua.
          refinement.noteRateLimit();
          return;
        }
        // Chamada livre: recua o base (a rota pode devolver o mesmo upstream)
        // e o refino do provedor nomeado, para quem o fixar depois respeitar.
        base.noteRateLimit();
        if (providerCode) this.for(scope.keyId, scope.modelId, providerCode).noteRateLimit();
      },
      release: () => {
        this.gate.release();
        refinement?.release();
        base.release();
      },
    };
  }

  /** Instantaneo de um escopo (ou AGREGADO sem escopo: teto mais apertado, somas). */
  snapshot(scope?: LimiterScope): LimiterSnapshot {
    if (scope) return this.for(scope.keyId, scope.modelId, scope.provider).snapshot();
    if (this.map.size === 0) {
      // Sem escopos ainda: o valor inicial que a telemetria sempre mostrou.
      return { limit: Math.min(INITIAL_CONCURRENCY, this.max), active: 0, queued: 0 };
    }
    let limit = Infinity;
    let active = 0;
    let queued = this.gate.queued;
    for (const l of this.map.values()) {
      const s = l.snapshot();
      limit = Math.min(limit, s.limit);
      active += s.active;
      queued += s.queued;
    }
    return { limit, active, queued };
  }
}

// ---------------------------------------------------------------------------
// IMPL-076 — tetos de taxa dos modelos :free por key (token bucket). Os
// tetos do provedor sao por MINUTO e por DIA e a conta muda com creditos
// (50/dia sem, 1.000/dia com): o diario e configuravel (`freeDailyLimit`) e o
// default conservador e o menor — nao chutar o teto alheio evita 429 bobo.
// O minuto AGUENTA reabastecimento (a chamada espera a ficha); o dia ESTOURADO
// e recusado com erro claro (esperar um dia nao e backoff, e prejuizo).
// ---------------------------------------------------------------------------

/** Tetos :free por key: 20 req/min (fixo do provedor) e o diario configuravel. */
export const FREE_PER_MINUTE = 20;
export const FREE_DAILY_LIMIT_DEFAULT = 50;

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  private refill(): void {
    const t = this.now();
    const gained = Math.floor((t - this.lastRefill) * this.refillPerMs);
    if (gained > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + gained);
      this.lastRefill += Math.floor(gained / this.refillPerMs);
    }
  }

  /** true = ha ficha AGORA (consumida). false = vazio. */
  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milissegundos ate a proxima ficha (para a chamada esperar). */
  msUntilNext(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerMs));
  }

  get remaining(): number {
    this.refill();
    return this.tokens;
  }
}

/** Buckets :free por key: [por minuto, por dia]. */
class FreeTierBuckets {
  private readonly perKey = new Map<string, { min: TokenBucket; day: TokenBucket }>();

  constructor(
    private dailyLimit: number,
    private readonly now: () => number = Date.now,
  ) {}

  setDailyLimit(n: number): void {
    this.dailyLimit = Math.max(1, Math.floor(n));
  }

  private for(keyId: string): { min: TokenBucket; day: TokenBucket } {
    let b = this.perKey.get(keyId);
    if (!b) {
      b = {
        min: new TokenBucket(FREE_PER_MINUTE, FREE_PER_MINUTE / 60_000, this.now),
        day: new TokenBucket(this.dailyLimit, this.dailyLimit / 86_400_000, this.now),
      };
      this.perKey.set(keyId, b);
    }
    return b;
  }

  /**
   * Consome uma ficha de CADA janela. `wait(ms, signal)` (injetavel) cobre a
   * espera do minuto; o dia estourado lanca `GatewayError` rate_limit.
   */
  async take(
    keyId: string,
    wait: (ms: number, signal?: AbortSignal) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const b = this.for(keyId);
    if (!b.day.tryTake()) {
      throw new GatewayError(
        'rate_limit',
        `Teto diario de chamadas a modelos :free atingido (${this.dailyLimit}/dia nesta key). Aguarde o reabastecimento ou use um modelo pago.`,
        { httpStatus: 429 },
      );
    }
    for (let i = 0; i < 120 && !b.min.tryTake(); i++) {
      if (signal?.aborted) throw toControlSignal(signal.reason);
      await wait(b.min.msUntilNext(), signal);
    }
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
 * `response_format` do pedido (IMPL-006). Saida estruturada por schema SO
 * quando o catalogo declara `structured_outputs` para o modelo (capacidade vem
 * do catalogo, nunca de tabela por modelo); sem isso — ou sem o modelo em
 * cache — cai em `json_object`, que o OpenRouter aceita amplamente.
 */
export function responseFormatFor(
  model: { supportedParameters?: string[] } | undefined,
  params: { responseFormatJson?: boolean; responseSchema?: { name: string; schema: Record<string, unknown> } },
): Record<string, unknown> | undefined {
  const { responseSchema } = params;
  if (responseSchema && model?.supportedParameters?.includes('structured_outputs')) {
    return {
      type: 'json_schema',
      json_schema: { name: responseSchema.name, strict: true, schema: responseSchema.schema },
    };
  }
  if (params.responseFormatJson || responseSchema) return { type: 'json_object' };
  return undefined;
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

/**
 * cli#3 — campos ESTRUTURADOS de uma falha classificada, para o record da
 * run: sem eles o record guardava so a mensagem e o CLI saia com exit 1
 * (`internal`) em vez do 4/5 documentado.
 */
export function gatewayErrorFields(err: unknown): { errorKind?: GatewayErrorKind; errorHttpStatus?: number } {
  const kind = gatewayErrorKind(err);
  if (!kind) return {};
  const status = (err as { httpStatus?: unknown }).httpStatus;
  return { errorKind: kind, ...(typeof status === 'number' ? { errorHttpStatus: status } : {}) };
}

/**
 * Classe FATAL (auth/sem credito) reconhecida numa MENSAGEM — para records
 * que so guardaram o texto (sessao de treino, records antigos). Casa pelo
 * inicio canonico das mensagens de `classifyHttpError`, em qualquer posicao
 * (o treino pode prefixar a mensagem da run).
 */
export function gatewayErrorKindFromMessage(message: string | undefined): 'auth' | 'no_credit' | undefined {
  if (!message) return undefined;
  if (message.includes(FATAL_MESSAGE_PREFIX.auth)) return 'auth';
  if (message.includes(FATAL_MESSAGE_PREFIX.noCredit402) || message.includes(FATAL_MESSAGE_PREFIX.noCredit403)) {
    return 'no_credit';
  }
  return undefined;
}

/**
 * Reconstrói a falha FATAL do gateway a partir de um record (`errorKind` ou a
 * mensagem canonica) — o CLI a passa pelo MESMO classificador de exit
 * (auth = 4, sem credito = 5). Outras classes/sem falha = `undefined`.
 */
export function fatalGatewayErrorFromRecord(rec: {
  error?: string;
  errorKind?: string;
  errorHttpStatus?: number;
}): GatewayError | undefined {
  const kind =
    rec.errorKind === 'auth' || rec.errorKind === 'no_credit' ? rec.errorKind : gatewayErrorKindFromMessage(rec.error);
  if (!kind) return undefined;
  const status = typeof rec.errorHttpStatus === 'number' ? rec.errorHttpStatus : kind === 'auth' ? 401 : 402;
  return new GatewayError(kind, rec.error ?? (kind === 'auth' ? FATAL_MESSAGE_PREFIX.auth : FATAL_MESSAGE_PREFIX.noCredit402), {
    httpStatus: status,
  });
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

/**
 * Inicio CANONICO das mensagens das falhas FATAIS (cli#3): o mesmo texto monta
 * o erro e o reconhece num record que so guardou a mensagem (ver
 * `gatewayErrorKindFromMessage`) — mudar um sem o outro quebra o contrato.
 */
const FATAL_MESSAGE_PREFIX = {
  auth: 'OpenRouter recusou a key (HTTP 401)',
  noCredit402: 'OpenRouter sem credito (HTTP 402)',
  noCredit403: 'OpenRouter recusou por limite de gasto (HTTP 403)',
} as const;

/** Erro HTTP do OpenRouter => `GatewayError` classificado (puro; exportado p/ testes). */
export function classifyHttpError(status: number, body: string): GatewayError {
  const parsed = parseErrorBody(body);
  const snippet = clip(parsed?.message ?? body);
  const detalhe = snippet ? ` Detalhe: ${snippet}` : '';
  if (status === 401) {
    return new GatewayError(
      'auth',
      `${FATAL_MESSAGE_PREFIX.auth}: a key e invalida, expirou ou foi revogada. Reconfigure em Configuracoes.${detalhe}`,
      { httpStatus: status },
    );
  }
  if (status === 403) {
    const block = blockFromErrorBody(parsed ?? { message: body }, status, 'http');
    if (block) return new GatewayError('blocked', block.message, { httpStatus: status, block });
    return new GatewayError(
      'no_credit',
      `${FATAL_MESSAGE_PREFIX.noCredit403}: o limite de credito da key/conta foi atingido.${detalhe}`,
      { httpStatus: status },
    );
  }
  if (status === 402) {
    return new GatewayError('no_credit', `${FATAL_MESSAGE_PREFIX.noCredit402}: adicione creditos na sua conta.${detalhe}`, {
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
  /**
   * `usage.is_byok`, quando booleano. `true` = a chamada rodou numa key do
   * PROVEDOR cadastrada na conta OpenRouter (BYOK): `cost` e so a taxa do
   * OpenRouter e a inferencia e cobrada pelo provedor direto nessa key.
   * Ausente = a resposta nao disse — nunca inferir BYOK.
   */
  isByok?: boolean;
  /**
   * `cost_details.upstream_inference_cost` SO de chamada BYOK (`is_byok === true`):
   * o que o provedor cobrou direto na key BYOK, FORA dos creditos e FORA de
   * `cost`. ⚠️ O OpenRouter devolve o MESMO campo em TODA chamada: na nao-BYOK
   * (`is_byok: false`) ele e o custo do provedor JA CONTIDO em `cost` (medido
   * numa run paga: upstream == cost) — soma-lo dobraria o gasto. Por isso ele
   * so e lido com `is_byok === true`; sem isso fica de fora.
   */
  byokUpstreamCost?: number;
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
  const isByok = typeof usage.is_byok === 'boolean' ? usage.is_byok : undefined;
  // `upstream_inference_cost` vem em TODA resposta; so e gasto FORA de `cost`
  // quando o proprio OpenRouter diz que a chamada foi BYOK (ver `UsageInfo`).
  const byokUpstreamCost = isByok === true ? num(costDetails.upstream_inference_cost) : undefined;
  return {
    tokensIn: num(usage.prompt_tokens) ?? 0,
    tokensOut: num(usage.completion_tokens) ?? 0,
    cost: num(usage.cost),
    ...(isByok !== undefined ? { isByok } : {}),
    ...(byokUpstreamCost !== undefined ? { byokUpstreamCost } : {}),
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
    // BYOK so com `is_byok === true` na resposta: `usd` segue sendo o que saiu
    // dos creditos (a taxa); o provedor cobrou `byokUpstreamUsd` a parte.
    return {
      usd: u.cost,
      source: 'usage',
      ...(u.isByok === true ? { byok: true } : {}),
      ...(u.isByok === true && typeof u.byokUpstreamCost === 'number' ? { byokUpstreamUsd: u.byokUpstreamCost } : {}),
    };
  }
  // Catalogo so vale com preco CONHECIDO: um roteador ("-1") sem usage.cost e
  // 'unknown', nunca um custo derivado (antes saia negativo). IMPL-018.
  const doCatalogo = computeCost(u.tokensIn, u.tokensOut, model);
  if (doCatalogo !== null) {
    return { usd: doCatalogo, source: 'catalog' };
  }
  return { usd: 0, source: 'unknown' };
}

/**
 * Dinheiro REAL de uma chamada medida, comparável ao preço do catálogo — a
 * matéria-prima da calibração estimado × real (IMPL-113). Não-BYOK: `usd`
 * (o `upstream_inference_cost` da resposta já está dentro dele). BYOK: `usd` é
 * só a taxa do OpenRouter, então o real é taxa + o que o provedor cobrou na key
 * BYOK; sem esse valor na resposta o real NÃO foi medido (`null` — nunca a taxa
 * sozinha, que ensinaria à calibração um preço ~20× menor que o do catálogo).
 */
export function measuredCallUsd(cost: CallCost): number | null {
  if (!cost.byok) return cost.usd;
  return typeof cost.byokUpstreamUsd === 'number' ? cost.usd + cost.byokUpstreamUsd : null;
}

/** A resposta trouxe bloco `usage`? Sem ele o custo NAO foi medido (IMPL-017). */
function hasUsage(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null;
}

/**
 * Estimativa de tokens de TEXTO por classe de caractere (IMPL-113, R-08:REC-8).
 *
 * A régua antiga (`chars/4`) acertava só em prosa inglesa e errava bem fora
 * dela — medido no R-08: código/JSON ≈ 3 chars/token (chars/4 subestimava ~25%)
 * e CJK ≈ 1,5 chars/token (subestimava ~60%). Os pesos por classe replicam
 * essas medidas; NÃO é um BPE real (o vocabulário não pode virar dependência do
 * bundle), e a reserva ainda leva margem por cima (`RESERVE_TOKEN_MARGIN`).
 */
const TOKENS_PER_CHAR = {
  /** Ideogramas/kana/hangul/fullwidth: ≈ 1,5 chars/token. */
  cjk: 0.67,
  /** Dígitos: tokenizam caro (≈ 2 chars/token). */
  digit: 0.5,
  /** Pontuação/símbolo ASCII: ≈ 2 chars/token (código/JSON pesam aqui). */
  punct: 0.5,
  /** Letras ASCII e espaço em branco: ≈ 4 chars/token (prosa inglesa). */
  ascii: 0.25,
  /** Resto (acentos latinos, símbolos não-ASCII). */
  other: 0.4,
} as const;

function isCjkCodePoint(c: number): boolean {
  return (
    (c >= 0x3000 && c <= 0x30ff) || // pontuação/kana CJK
    (c >= 0x3400 && c <= 0x4dbf) || // ideogramas extensão A
    (c >= 0x4e00 && c <= 0x9fff) || // ideogramas unificados
    (c >= 0xac00 && c <= 0xd7af) || // hangul
    (c >= 0xf900 && c <= 0xfaff) || // ideogramas de compatibilidade
    (c >= 0xff00 && c <= 0xff60) // fullwidth
  );
}

/** Tokens de um texto pela régua por classe (ver `TOKENS_PER_CHAR`). */
export function countTextTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (isCjkCodePoint(c)) tokens += TOKENS_PER_CHAR.cjk;
    else if (ch >= '0' && ch <= '9') tokens += TOKENS_PER_CHAR.digit;
    else if (
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      ch === ' ' ||
      ch === '\n' ||
      ch === '\t' ||
      ch === '\r'
    ) {
      tokens += TOKENS_PER_CHAR.ascii;
    } else if (c < 0x80) tokens += TOKENS_PER_CHAR.punct;
    else tokens += TOKENS_PER_CHAR.other;
  }
  return Math.ceil(tokens);
}

/**
 * Estimativa de tokens de prompt (a MESMA régua da reserva do gateway e do teto
 * de contexto do competidor, IMPL-016/IMPL-113) — SEM margem: a margem de ~20%
 * vive só na reserva dura (`reserveFor`), para não inflar a comparação
 * estimado × real da calibração.
 */
export function guessPromptTokens(messages: ChatMessage[]): number {
  return countTextTokens(messages.map((m) => m.content).join('\n'));
}

/**
 * Margem do tokenizer na RESERVA DURA (IMPL-113): a porta dura reserva o
 * token estimado + ~20% — subestimar tokens aqui afrouxa a porta (uma chamada
 * reserva de menos e o estouro passa); reservar de mais só limita quantas
 * chamadas cabem em voo.
 */
export const RESERVE_TOKEN_MARGIN = 1.2;

// ---------------------------------------------------------------------------
// IMPL-113 (R-08:REC-8) — registo estimado × real (costAccuracy) POR CHAMADA.
//
// Toda chamada MEDIDA (`usage.cost` — a única fonte exata) regista o par
// (estimado do catálogo, real cobrado) com esforço/família/tokens de raciocínio:
// é a matéria-prima dos quantis empíricos por papel e da predição conformal da
// faixa (`CostCalibration` em `src/estimate.ts`, que consome este buffer).
// Estimado ≤ 0 ou real não medido NÃO viram amostra — razão não existe e preço
// "-1" (IMPL-018) nunca entra como número negativo.
// ---------------------------------------------------------------------------

/** Amostra estimado × real de UMA chamada medida. */
export interface CostCalibrationSample {
  role: CostRole;
  modelId: string;
  /** Família do modelo (prefixo estável do slug — ver `modelFamilyOf`). */
  family: string;
  /** USD estimado (catálogo, teto de tokens) — o MESMO que vai na reserva. */
  estimatedUsd: number;
  /** USD real cobrado (`usage.cost`). */
  actualUsd: number;
  /** Degrau efetivo no fio (`effort` dos sinais de fim; 'default' = padrão do provedor). */
  effort?: string;
  /** `reasoning_tokens` medidos (subconjunto de tokens de saída). */
  reasoningTokens?: number;
  /** Teto de saída enviado (`max_tokens`) — ancora a fatia de resposta/raciocínio. */
  capTokens?: number;
}

/**
 * Família do modelo para a previsão por esforço × família: prefixo estável do
 * slug (`anthropic/claude-3.5-sonnet` → `anthropic/claude`, `openai/gpt-5-mini`
 * → `openai/gpt`). Chave grossa de propósito: célula fina não tem amostras.
 */
export function modelFamilyOf(modelId: string): string {
  const [prov = '', resto = ''] = modelId.trim().toLowerCase().split('/');
  const nome = resto.split(':')[0] ?? '';
  const familia = nome.split(/[-_.\d]/)[0] ?? '';
  return `${prov}/${familia}`;
}

/** Amostras recentes (anel: as últimas bastam para quantis; ver `takeCostSamples`). */
const COST_SAMPLE_LIMIT = 5000;
const costSamples: CostCalibrationSample[] = [];

/**
 * Ouvintes de amostra (IMPL-113): quem PERSISTE a calibração entre processos
 * (CLI: arquivo no diretório de dados; SPA: armazenamento do navegador) —
 * antes o anel só vivia em memória e cada CLI nascia sem nada para calibrar.
 */
const costSampleListeners = new Set<(sample: CostCalibrationSample) => void>();

/** Assina as amostras novas; devolve a função que cancela a assinatura. */
export function subscribeCostSamples(listener: (sample: CostCalibrationSample) => void): () => void {
  costSampleListeners.add(listener);
  return () => costSampleListeners.delete(listener);
}

/** Regista uma amostra estimado × real (IMPL-113). Só o chamador medido chega aqui. */
export function recordCostSample(sample: CostCalibrationSample): void {
  costSamples.push(sample);
  if (costSamples.length > COST_SAMPLE_LIMIT) {
    costSamples.splice(0, costSamples.length - COST_SAMPLE_LIMIT);
  }
  for (const l of costSampleListeners) {
    try {
      l(sample);
    } catch {
      // persistência é best-effort: nunca derruba a chamada já cobrada
    }
  }
}

/** Espia o buffer sem consumir (diagnóstico/teste). */
export function peekCostSamples(): readonly CostCalibrationSample[] {
  return costSamples;
}

/** Consome (drena) o buffer — quem calibra a faixa (`CostCalibration.live`). */
export function takeCostSamples(): CostCalibrationSample[] {
  return costSamples.splice(0, costSamples.length);
}

/** Limpa o buffer (fronteira de processo/teste). */
export function resetCostSamples(): void {
  costSamples.length = 0;
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
 * IMPL-114 (R-08:REC-4) — posiciona `cache_control: { type: 'ephemeral' }` na
 * mensagem de índice `afterIndex` (o FIM do prefixo estável do layout v1 — ver
 * `ChatCompletionParams.cacheControlAfter`). As mensagens DEPOIS da quebra mudam
 * a cada chamada (candidatos) e ficam fora do prefixo cacheado. Índice fora do
 * alcance = corpo intacto (fail-closed: sem cache, nunca cache no lugar errado).
 */
function applyCacheControl(body: Record<string, unknown>, afterIndex: number): void {
  const msgs = body.messages;
  if (!Array.isArray(msgs)) return;
  if (!Number.isInteger(afterIndex) || afterIndex < 0 || afterIndex >= msgs.length) return;
  const alvo = msgs[afterIndex];
  if (!alvo || typeof alvo !== 'object') return;
  // Forma DOCUMENTADA pelo OpenRouter para Anthropic: o `cache_control` vai
  // numa PARTE de conteúdo (`{ type: 'text', text, cache_control }`), não na
  // mensagem — no nível da mensagem o provedor ignora a marca em silêncio.
  const marca = { type: 'ephemeral' };
  const content = (alvo as Record<string, unknown>).content;
  let parts: unknown[] | undefined;
  if (typeof content === 'string') {
    parts = [{ type: 'text', text: content, cache_control: marca }];
  } else if (Array.isArray(content) && content.length > 0) {
    const ultima = content[content.length - 1];
    if (ultima && typeof ultima === 'object') {
      parts = [...content.slice(0, -1), { ...(ultima as Record<string, unknown>), cache_control: marca }];
    }
  }
  if (!parts) return;
  msgs[afterIndex] = { ...(alvo as Record<string, unknown>), content: parts };
}

/**
 * IMPL-114 — o modelo aceita a quebra EXPLÍCITA de cache de prompt
 * (`cache_control`)? Só a família Anthropic via OpenRouter: nos provedores de
 * cache automático (OpenAI, DeepSeek…) a marca não muda nada, e marcar um
 * prefixo que ninguém reusa custa a ESCRITA do cache (1,25× a entrada na
 * Anthropic) — por isso o juiz só pede o `cache_control` quando isto é true.
 */
export function supportsPromptCacheControl(modelId: string): boolean {
  return /^anthropic\//i.test(modelId.trim());
}

/**
 * IMPL-075 (R-07b:REC-4) — modo AUDITÁVEL: restringe o roteamento para que a
 * chamada seja reproduzível e atribuível a um provedor só. Envia
 * `provider { order, quantizations, allow_fallbacks:false, require_parameters:true }`:
 * sem fallback o provedor que respondeu é o que vai registrado; `require_parameters`
 * impede de cair em endpoint que ignora parâmetros (temperature/seed/response_format).
 * ⚠️ Mescla SEMPRE sobre o `provider` já montado (max_price, ZDR): nunca apaga.
 */
function applyAuditable(
  body: Record<string, unknown>,
  opts: { order?: string[]; quantizations?: string[] },
): void {
  const provider = (body.provider ?? {}) as Record<string, unknown>;
  const order = opts.order ?? [];
  const quantizations = opts.quantizations ?? [];
  body.provider = {
    ...provider,
    ...(order.length > 0 ? { order: [...order] } : {}),
    ...(quantizations.length > 0 ? { quantizations: [...quantizations] } : {}),
    allow_fallbacks: false,
    require_parameters: true,
  };
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

/**
 * IMPL-076 — transientes que valem retry: 429/5xx. O 402 (sem credito) NUNCA
 * entra aqui: backoff nao repoe credito, repetir e so queimar tentativas —
 * sai logo classificado como `no_credit` (idem 400/401/403).
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** Janela de backoff exponencial com jitter. `retryAfterMs` (do header) e PISO. */
function backoffMs(attempt: number, retryAfterMs?: number): number {
  const base = Math.min(8000, 250 * 2 ** attempt);
  const wait = base + Math.floor(Math.random() * 250); // jitter
  return retryAfterMs !== undefined && retryAfterMs > wait ? retryAfterMs : wait;
}

/**
 * IMPL-073 (R-07a:REC-3) — `Retry-After`/`retry-after-ms` do provedor como
 * PISO do backoff. `retry-after-ms` (milissegundos, aceita fracao) vence;
 * `Retry-After` e delta-segundos OU data HTTP. Ausente/malformado => undefined
 * (backoff comum). Cabe aqui (puro, sem cabecalhos reais) para os dois lados.
 */
export function parseRetryAfterMs(
  headers: { get(name: string): string | null | undefined } | Record<string, string | undefined> | undefined,
): number | undefined {
  if (!headers) return undefined;
  const get = (name: string): string | undefined =>
    typeof (headers as { get?: unknown }).get === 'function'
      ? (headers as { get(n: string): string | null | undefined }).get(name) ?? undefined
      : Object.entries(headers as Record<string, string | undefined>).find(
          ([k]) => k.toLowerCase() === name.toLowerCase(),
        )?.[1];
  const rawMs = get('retry-after-ms')?.trim();
  if (rawMs) {
    const n = Number(rawMs);
    if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  }
  const raw = get('retry-after')?.trim();
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? Math.ceil(delta) : 0;
  }
  return undefined;
}

/**
 * IMPL-073 — erro de rede ANTES do envio (conexao recusada/DNS/inalcancavel):
 * o pedido nunca chegou ao provedor, nada foi gerado nem cobrado — pode
 * repetir. Tudo o mais depois do despacho tem desfecho DESCONHECIDO (o
 * provedor pode ter processado e cobrado) e NAO repete sem verificacao.
 */
const PRE_SEND_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EADDRNOTAVAIL',
  'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function preSendError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; cause?: unknown; name?: unknown };
  const code = typeof e.code === 'string' ? e.code : undefined;
  if (code && PRE_SEND_CODES.has(code)) return true;
  const cause = e.cause as { code?: unknown } | undefined;
  const causeCode = typeof cause?.code === 'string' ? cause.code : undefined;
  return Boolean(causeCode && PRE_SEND_CODES.has(causeCode));
}

/** Marca INEQUIVOCA de "já despachada" (mesmo motivo de `isControlSignal`: nada de instanceof). */
const UPSTREAM_SENT = 'upstreamSent';

/**
 * IMPL-073 / R-07a:REC-2 — falha DEPOIS de o pedido sair (corpo de erro lido,
 * stream cortado, abort/timeout em voo): a geração pode ter concluído e sido
 * COBRADA. O erro sai marcado para que nenhum laço de retry reenvie sem antes
 * verificar pelo `generationId` (GET /generation). Nunca `instanceof`.
 */
export function isUpstreamSent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && UPSTREAM_SENT in err && (err as Record<string, unknown>)[UPSTREAM_SENT] === true;
}

function markUpstreamSent<T>(err: T): T {
  if (typeof err === 'object' && err !== null && !isUpstreamSent(err)) {
    try {
      Object.defineProperty(err, UPSTREAM_SENT, { value: true, enumerable: false, configurable: true });
    } catch {
      // erro congelado estranho: segue sem a marca, nunca derruba a chamada
    }
  }
  return err;
}

/** Marca do timeout tipado (propriedade, nunca instanceof — ESM duplo). */
const GATEWAY_TIMEOUT = 'gatewayTimeout';

/**
 * IMPL-077 (R-07a:REC-6) — timeout TIPADO do gateway, distinto de
 * `BudgetExceeded`/`RunCancelled`: timeout é ERRO (a chamada falhou), controle
 * é CONTROLE (`isControlSignal`). `name = 'TimeoutError'` casa com o runtime e
 * com o classificador de timeout do agente; a mensagem leva "timeout" para os
 * contratos que casam por texto.
 */
export class GatewayTimeoutError extends Error {
  readonly gatewayTimeout = true;
  /** 'idle' = sem bytes por X ms; 'total' = teto da tentativa inteira. */
  readonly timeoutKind: 'idle' | 'total';
  readonly role?: CostRole;
  readonly timeoutMs: number;
  constructor(kind: 'idle' | 'total', timeoutMs: number, role?: CostRole) {
    const papel = role ? `, papel ${role}` : '';
    super(
      kind === 'idle'
        ? `timeout de inatividade (${timeoutMs}ms${papel}): o provedor parou de emitir dados — a geração pode ter sido cobrada e a chamada fica pendente de conciliação.`
        : `timeout total (${timeoutMs}ms${papel}): a chamada excedeu o teto — a geração pode ter sido cobrada e a chamada fica pendente de conciliação.`,
    );
    this.name = 'TimeoutError';
    this.timeoutKind = kind;
    this.role = role;
    this.timeoutMs = timeoutMs;
  }
}

/** true = falha por timeout do gateway (ERRO, não controle). */
export function isGatewayTimeout(err: unknown): err is GatewayTimeoutError {
  return typeof err === 'object' && err !== null && GATEWAY_TIMEOUT in err && (err as Record<string, unknown>)[GATEWAY_TIMEOUT] === true;
}

/**
 * IMPL-073 (R-07a:REC-3) — um laço de retry do CHAMADOR (ex.: competidor) pode
 * repetir esta falha? NÃO quando:
 *   - é sinal de controle (orçamento/cancelamento);
 *   - é HTTP classificado (`GatewayError`): 429/5xx o gateway JÁ re-tentou até
 *     `MAX_RETRIES` — repetir por cima multiplicava as tentativas (2×7 = 14) —
 *     e 400/401/402/403 não mudam repetindo;
 *   - o desfecho é desconhecido depois do despacho (`isUpstreamSent`): pode
 *     ter sido COBRADO; sem verificação no /generation, reenviar é cobrança dupla;
 *   - é erro de rede ANTES do envio que o gateway já esgotou.
 * Sobra o que o gateway não repete e é seguro repetir: timeout (em stream o
 * provedor para de gerar no abort) e falha in-band (200 com corpo de erro, já
 * contabilizada).
 */
export function isCallerRetryable(err: unknown): boolean {
  if (isControlSignal(err)) return false;
  if (gatewayErrorKind(err) !== undefined) return false;
  if (isUpstreamSent(err)) return false;
  if (preSendError(err)) return false;
  return true;
}

/**
 * cli#3 — falha que NENHUM retry nem outro modelo conserta: key recusada (401)
 * ou sem crédito (402 / 403 de limite de gasto). Quem degrada exceção
 * (datagen, juiz, competidor) deve PROPAGAR estas — degradar deixaria a run
 * seguir e morrer depois com uma mensagem genérica, sem o código de saída
 * documentado (4 = auth, 5 = sem crédito).
 */
export function isFatalGatewayError(err: unknown): boolean {
  const k = gatewayErrorKind(err);
  return k === 'auth' || k === 'no_credit';
}

/**
 * IMPL-077 — timeouts POR PAPEL: inatividade (sem bytes no stream) + teto
 * total da tentativa. Valores iniciais a calibrar (R-07a:REC-6): competidor
 * 90s/600s, juiz 60s/120s, duelo 60s/90s, gabarito/datagen/reescritor
 * 90s/300s. Configuráveis via `roleTimeouts` (1-600 s); `agent` segue juiz
 * estendido. O `timeoutMs` do chamador continua valendo (pode só ENCURTAR).
 *
 * ⚠️ Undici (Node): `headersTimeout` padrao e 300 s — um provedor mudo que
 * nem mande headers dentro de 300 s derruba a chamada com
 * `UND_ERR_HEADERS_TIMEOUT` ANTES do teto total de 600 s do competidor (no
 * caminho JSON, onde nao ha watchdog de inatividade). O erro segue sendo
 * tratado como pos-despacho (sem reenvio, pendente de conciliacao); quem
 * quiser o timeout TIPADO do proprio gateway nesse caso deve configurar
 * `roleTimeouts.competitor.totalMs` abaixo de 300 s. Em stream o watchdog de
 * inatividade (90 s) dispara primeiro.
 */
export interface RoleTimeouts {
  /** Inatividade máxima entre bytes do stream (ms). */
  idleMs: number;
  /** Teto total da tentativa, do despacho à resposta lida (ms). */
  totalMs: number;
}

export const DEFAULT_ROLE_TIMEOUTS: Record<CostRole, RoleTimeouts> = {
  competitor: { idleMs: 90_000, totalMs: 600_000 },
  judge: { idleMs: 60_000, totalMs: 120_000 },
  duel: { idleMs: 60_000, totalMs: 90_000 },
  gabarito: { idleMs: 90_000, totalMs: 300_000 },
  datagen: { idleMs: 90_000, totalMs: 300_000 },
  rewriter: { idleMs: 90_000, totalMs: 300_000 },
  agent: { idleMs: 60_000, totalMs: 300_000 },
};

/** Configuração de papel é 1-600 s (critério IMPL-077 (iii)); fora disso recorta. */
export function clampRoleTimeoutMs(ms: number): number {
  if (!Number.isFinite(ms)) return 60_000;
  return Math.min(600_000, Math.max(1_000, Math.round(ms)));
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
export function catalogDeniesReasoning(
  model: Pick<OpenRouterModel, 'supportedParameters' | 'reasoning'> | undefined,
): boolean {
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
  /**
   * IMPL-080 — servido do cache EXATO de vereditos: nenhuma chamada upstream
   * foi feita e `cost.usd` é 0 porque NADA foi cobrado (medido, não inferido).
   */
  cacheHit?: boolean;
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
  /**
   * IMPL-075 — provedor que efetivamente serviu esta chamada (payload +
   * GET /generation quando habilitado). Ausente = nada recuperável.
   */
  provider?: CallProviderInfo;
  /** true = corpo enviado no modo auditável (IMPL-075) — visível no artefato de replay. */
  auditable?: boolean;
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
  /**
   * Schema da saida (IMPL-006): vai como `response_format: json_schema` (strict)
   * quando o catalogo declara `structured_outputs` para o modelo; senao cai em
   * `json_object`. Quem pede valida a saida do mesmo jeito (zod estrito).
   */
  responseSchema?: { name: string; schema: Record<string, unknown> };
  // Nivel de raciocinio (reasoning effort). Ausente = nao envia `reasoning`
  // (comportamento anterior, identico). 'off' desliga explicitamente.
  reasoningLevel?: ReasoningLevel;
  /** Papel desta chamada no pipeline — granularidade do ledger de gasto. */
  role?: CostRole;
  /** Ledger. Ausente = nao contabiliza (compatibilidade com chamadas avulsas). */
  sink?: CostSink;
  /** Teto por requisicao (USD por MILHAO de tokens). Ver applyMaxPrice. */
  maxPricePerMTok?: { prompt?: number; completion?: number };
  /**
   * Chamado quando o custo desta chamada e LANCADO no ledger — inclusive
   * quando ela termina em erro depois de despachada (timeout, corpo de erro
   * in-band). Sem isto o chamador so via o custo no retorno, e um competidor
   * que estourava o timeout ficava com `costUsd` 0 enquanto o ledger ja tinha
   * lancado o gasto conservador (IMPL-017, revisao). Nao e chamado quando a
   * reserva volta inteira (HTTP de erro/nada despachado: nao houve custo).
   */
  onCost?: (cost: CallCost) => void;
  /**
   * IMPL-072 — força o transporte STREAMING (SSE) para ESTA chamada mesmo em
   * `chatCompletion` (juiz/duelo/gabarito/datagen/reescritor passam a poder
   * abortar sem levar a cobrança da resposta inteira). Ausente = decide o
   * `streamTransport` do gateway (default: caminho JSON histórico).
   */
  streamTransport?: boolean;
  /** IMPL-077 — inatividade desta chamada (ms). Ausente = default do papel. */
  idleTimeoutMs?: number;
  /** IMPL-075 — override do `providerLookup` do gateway para esta chamada. */
  providerLookup?: 'off' | 'missing' | 'always';
  /** IMPL-075 — modo auditável desta chamada (além do preset por papel). */
  auditable?: boolean;
  /**
   * IMPL-114 (R-08:REC-4) — quebra de cache de PROMPT do provedor: marca
   * `cache_control: { type: 'ephemeral' }` na mensagem de índice
   * `cacheControlAfter` — o FIM do prefixo estável. Tudo o que vem DEPOIS muda
   * a cada chamada (o candidato do julgamento) e fica fora do prefixo cacheado.
   *
   * LAYOUT DE MENSAGENS DO JULGAMENTO — v1 (versionado; mudar = novo layout e
   * cache invalidado nas primeiras chamadas). É o que `refJudge.judgeOne` envia
   * a juiz com cache explícito (`supportsPromptCacheControl` — Anthropic):
   *   [0] system — contrato do juiz (fixo)
   *   [1] user   — REFERENCIA → PERGUNTA → RUBRICA (CRITÉRIO)
   *       ← prefixo ESTÁVEL (cacheável): leva o `cache_control` (`cacheControlAfter: 1`),
   *       com o marcador de bloco COMPARTILHADO pela etapa (byte a byte igual
   *       entre candidatos)
   *   [2] user   — CANDIDATO + INSTRUÇÕES (canário novo por veredito) ← fora do prefixo
   * O `cache_control` vai numa PARTE de conteúdo (`{type:'text', text,
   * cache_control}`), a forma documentada pelo OpenRouter para Anthropic.
   * No DUELO o prefixo útil vai só até a RÚBRICA: o cache ajuda ENTRE PARES
   * (mesma rúbrica), não entre as duas ordens do mesmo par (o candidato entra
   * antes da 2ª ordem). AQUECIMENTO: o gateway segura as chamadas de um mesmo
   * prefixo até a 1ª terminar (`withCacheWarmup`) — uma por cenário × juiz
   * antes do resto do `Promise.all`, sem teto de concorrência.
   *
   * ⚠️ NENHUM ganho é prometido sem isto: só há efeito em provedor com cache de
   * prompt (Anthropic via OpenRouter) E prefixo idêntico no mesmo provedor
   * (e acima do mínimo cacheável do provedor). A medição é
   * `usage.prompt_tokens_details.cached_tokens` (já extraído como
   * `cachedTokensIn`, somado por papel no ledger); índice fora do alcance =
   * nada muda (sem cache, nunca cache errado).
   */
  cacheControlAfter?: number;
}

export interface ChatStreamParams extends ChatCompletionParams {
  onDelta?: (delta: string, fullText: string) => void;
}

/**
 * IMPL-063 — chamada paga NÃO-chat com lista de textos (`meteredInputCall`):
 * o `path` é relativo à base (ex.: o ponto de representação usado pelo dedup
 * do datagen, em `src/embeddings.ts`). Mesmo ledger/limitador do chat.
 */
export interface MeteredInputParams {
  apiKey: string;
  modelId: string;
  /** Caminho relativo à base da API (sem barra inicial). */
  path: string;
  /** Textos do pedido — passam pela cascata de dado pessoal como mensagens. */
  input: string[];
  /** Papel no ledger (obrigatório: o default 'competitor' do chat seria errado aqui). */
  role: CostRole;
  sink?: CostSink;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface MeteredInputResult {
  /** JSON cru da resposta 200. */
  raw: unknown;
  cost: CallCost;
  latencyMs: number;
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
  /**
   * Janela do limite da key (`daily`/`weekly`/`monthly`; null = sem reset, o
   * limite e vitalicio). E o TIPO de janela, nao um timestamp; o reset diario
   * e 00:00 UTC. O `doctor` recomenda limite + reset diario (IMPL-031).
   */
  limitReset?: string | null;
  /** Gasto da key no dia corrente (UTC), em USD. */
  usageDailyUsd?: number;
}

export type ValidateKeyResult =
  | ({ ok: true } & KeyInfo)
  /** `network` = nem chegou ao OpenRouter (a key pode estar boa). */
  | { ok: false; error: string; network?: boolean };

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
  /** Se a leitura do corpo foi abortada: por timeout ou por abort externo (IMPL-017). */
  abortReason: () => PendingReason | undefined;
  /** IMPL-077 — zera o watchdog de inatividade (chamado a cada chunk do stream). */
  touch: () => void;
}

/**
 * Preenchido por `guardedFetch` quando a ULTIMA tentativa foi abortada DEPOIS
 * de despachada (IMPL-017): o provedor pode estar gerando (e cobrando) — a
 * reserva nao pode ser devolvida.
 */
interface DispatchTrack {
  abortedInFlight?: PendingReason;
}

/**
 * O que uma resposta 200 trouxe — lido do corpo JSON ou acumulado do SSE (os
 * MESMOS campos, fechados por `finalizeReply`). `text` e o texto CRU do fio
 * (pseudonimizado): a reidratacao acontece so no resultado.
 */
interface CollectedReply {
  text: string;
  usageRaw: unknown;
  finishReason?: string;
  nativeFinishReason?: string;
  refusal: string;
  error: OpenRouterErrorBody | null;
  generationId?: string;
  provider?: CallProviderInfo;
  /** Payload do fio: o corpo JSON inteiro ou o ultimo chunk SSE. */
  raw: unknown;
}

/** Campos de uma resposta JSON (`chat.completion`) no formato comum. */
function collectJsonReply(json: unknown): CollectedReply {
  const j = (json && typeof json === 'object' ? json : {}) as {
    choices?: {
      message?: { content?: unknown; refusal?: unknown };
      finish_reason?: unknown;
      native_finish_reason?: unknown;
    }[];
    usage?: unknown;
    error?: unknown;
  };
  const choice = Array.isArray(j.choices) ? j.choices[0] : undefined;
  const content = choice?.message?.content;
  const err = j.error;
  return {
    text: typeof content === 'string' ? content : '',
    usageRaw: j.usage,
    finishReason: finishText(choice?.finish_reason),
    nativeFinishReason: finishText(choice?.native_finish_reason),
    refusal: typeof choice?.message?.refusal === 'string' ? choice.message.refusal : '',
    error: err ? (typeof err === 'object' ? (err as OpenRouterErrorBody) : { message: String(err) }) : null,
    generationId: generationIdOf(json),
    provider: extractProviderInfo(json),
    raw: json,
  };
}

/** JSON tolerante: corpo ilegível vira `{}` (os leitores tratam campo ausente). */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

/** Ficha de UMA geração no GET /api/v1/generation (IMPL-074/IMPL-075). */
export interface GenerationInfo {
  generationId: string;
  provider?: CallProviderInfo;
  /** `total_cost` — o valor da FATURA desta geração. */
  totalCostUsd?: number;
  /**
   * `is_byok === true` na ficha: `total_cost` é só a taxa do OpenRouter e o
   * provedor cobrou `byokUpstreamUsd` direto na key BYOK. Ausente = não-BYOK
   * ou não informado (nunca inferir).
   */
  byok?: boolean;
  /** `upstream_inference_cost` SÓ de geração BYOK (na não-BYOK ele já está em `total_cost`). */
  byokUpstreamUsd?: number;
  cancelled?: boolean;
  /** `generation_time` (ms) no provedor. */
  generationTimeMs?: number;
  /** `latency` (ms) medida pelo OpenRouter. */
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
}

/** `{ data: {...} }` do GET /generation => ficha (puro; exportado p/ testes). */
export function parseGenerationInfo(id: string, json: unknown): GenerationInfo | undefined {
  const d = (json as { data?: unknown } | null)?.data;
  if (!d || typeof d !== 'object') return undefined;
  const r = d as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const provider = extractProviderInfo(r);
  const totalCostUsd = num(r.total_cost) ?? num(r.cost);
  const tokensIn = num(r.tokens_prompt) ?? num(r.native_tokens_prompt);
  const tokensOut = num(r.tokens_completion) ?? num(r.native_tokens_completion);
  // Mesma regra do `extractUsage`: o upstream só é gasto à parte com `is_byok`.
  const byok = r.is_byok === true;
  const byokUpstreamUsd = byok ? num(r.upstream_inference_cost) : undefined;
  return {
    generationId: id,
    ...(provider ? { provider } : {}),
    ...(typeof totalCostUsd === 'number' ? { totalCostUsd } : {}),
    ...(byok ? { byok: true } : {}),
    ...(byokUpstreamUsd !== undefined ? { byokUpstreamUsd } : {}),
    ...(typeof r.cancelled === 'boolean' ? { cancelled: r.cancelled } : {}),
    ...(num(r.generation_time) !== undefined ? { generationTimeMs: num(r.generation_time) } : {}),
    ...(num(r.latency) !== undefined ? { latencyMs: num(r.latency) } : {}),
    ...(tokensIn !== undefined ? { tokensIn } : {}),
    ...(tokensOut !== undefined ? { tokensOut } : {}),
  };
}

/**
 * O que a conciliação precisa do ledger (IMPL-074) — `BudgetLedger` cumpre.
 * Declarado aqui para o gateway não importar a classe (só o contrato).
 */
export interface ReconcilableLedger {
  pendingEntries(): PendingCall[];
  settlePending(
    generationId: string,
    cost: CallCost | null,
    tokens?: { tokensIn?: number; tokensOut?: number },
    details?: SettleDetails,
  ): boolean;
  noteReconciliation?(r: NonNullable<CostLedgerSummary['reconciliation']>): void;
}

/** Espera `p` OU o abort de `signal` (que sai como sinal de controle — IMPL-020). */
async function waitOrAbort(p: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await p;
    return;
  }
  if (signal.aborted) throw toControlSignal(signal.reason);
  let onAbort: () => void = () => undefined;
  const abortou = new Promise<never>((_, reject) => {
    onAbort = () => reject(toControlSignal(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([p, abortou]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
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

// --- IMPL-076: escopo do limitador por chamada --------------------------------

/** Modeles :free do provedor — sufixo `:free` no id. Tetos de taxa por key. */
function isFreeModel(modelId: string): boolean {
  return modelId.trim().toLowerCase().endsWith(':free');
}

/**
 * Provedor FIXADO no corpo da chamada (`provider.order`/`only` com exatamente
 * uma entrada). Multi-entrada/ausente = livre: a rota escolhe, e o escopo e o
 * base (key, modelo).
 */
function pinnedProviderOf(body: Record<string, unknown>): string | undefined {
  const p = body.provider as { order?: unknown; only?: unknown } | undefined;
  const list = Array.isArray(p?.order) ? p.order : Array.isArray(p?.only) ? p.only : undefined;
  const first = list?.[0];
  return list?.length === 1 && typeof first === 'string' && first.trim() ? first.trim() : undefined;
}

/**
 * IMPL-076 — upstream que devolveu o erro, quando o corpo identifica
 * (`error.metadata.provider_code`). Ausente = undefined (recuo no escopo base).
 */
function providerCodeFromError(bodyText: string): string | undefined {
  const meta = parseErrorBody(bodyText)?.metadata;
  const code = meta?.provider_code;
  return typeof code === 'string' && code.trim() ? code.trim() : undefined;
}

/** Escopo do limitador da chamada (IMPL-076): (key, modelo) + provedor fixado. */
function limiterScopeOf(apiKey: string, modelId: string, body: Record<string, unknown>): LimiterScope {
  const provider = pinnedProviderOf(body);
  return { keyId: cacheKey(apiKey), modelId, ...(provider ? { provider } : {}) };
}

/**
 * Uma instancia do gateway: config + limitador AIMD + cache de catalogo.
 * Toda chamada de geracao passa por `chatCompletion`/`chatCompletionStream`
 * daqui, e e DENTRO delas que a contabilidade acontece (role + sink): um ponto
 * so, igual para Node e navegador.
 */
/**
 * Anexa aos sinais de fim o esforco EFETIVO do corpo enviado (IMPL-015): e a
 * 2a dimensao da taxa de truncamento por papel x esforco no ledger. So nos
 * sinais que vao ao ledger — o `ChatCompletionResult` nao muda.
 */
function withEffort(fim: CallFinishSignals, body: Record<string, unknown>): CallFinishSignals {
  const effort = effortLabelOf(body);
  return effort ? { ...fim, effort } : fim;
}

export class OpenRouterGateway {
  private cfg: GatewayConfig;
  /**
   * IMPL-076 — limitadores AIMD por (key, modelo) + refino por provedor, com o
   * teto estatico da instancia por cima. Antes era UM estado para todas as
   * keys: no servidor multiusuario um 429 de um usuario derrubava o limite de
   * todos. `currentConcurrency` continua o espelho de telemetria.
   */
  private readonly limiters: ScopedAimdLimiters;
  /** IMPL-076 — tetos :free por key (20/min + diario configuravel). */
  private readonly freeBuckets: FreeTierBuckets;
  private readonly modelsCache = new Map<string, { fetchedAt: number; data: OpenRouterModel[] }>();
  /** Alertas da ultima validacao de /models, por key (ver `validateModelsPayload`). */
  private readonly modelsIssues = new Map<string, CatalogIssue[]>();
  // LGPD (IMPL-042): cascata de dado pessoal — uma por instância (contadores
  // próprios; cofre de pseudônimos com chave HMAC própria POR RUN/SESSÃO),
  // aplicada em `buildBody`, o ponto único dos 6 papéis.
  private readonly piiGuard = createPiiGuard();
  /**
   * IMPL-073 / R-07a:REC-2 — guarda anti-reenvio: falha DEPOIS dos headers com
   * desfecho desconhecido (stream cortado, abort/timeout em voo, corpo ilegível)
   * pode ter sido COBRADA. O hash do corpo fica bloqueado para reenvio até a
   * conciliação (ou a janela expirar): um laço de retry do chamador reencontrar
   * o MESMO pedido é recusado sem tocar a rede, com o erro original.
   */
  private readonly resendGuard = new Map<string, { until: number; err: unknown }>();

  constructor(config: Partial<GatewayConfig> = {}) {
    this.cfg = mergeConfig(DEFAULT_CONFIG, config);
    this.limiters = new ScopedAimdLimiters(this.cfg.maxConcurrency);
    this.freeBuckets = new FreeTierBuckets(this.cfg.freeDailyLimit ?? FREE_DAILY_LIMIT_DEFAULT);
  }

  /**
   * IMPL-077 — timeouts efetivos: default do papel, config do gateway e o
   * `timeoutMs` do chamador (que só ENCURTA; o teto de 1-600 s é o do papel).
   * `idleMs: 0` = sem watchdog de inatividade (caminho JSON, onde o provedor
   * fica em silêncio enquanto gera e o teto total é que vale).
   */
  private timeoutsFor(params: ChatCompletionParams, streaming: boolean): { totalMs: number; idleMs: number } {
    const role = params.role ?? 'competitor';
    const dflt = DEFAULT_ROLE_TIMEOUTS[role] ?? DEFAULT_ROLE_TIMEOUTS.competitor;
    const cfgT = this.cfg.roleTimeouts?.[role] ?? {};
    const totalCap = clampRoleTimeoutMs(cfgT.totalMs ?? dflt.totalMs);
    const idleDefault = clampRoleTimeoutMs(cfgT.idleMs ?? dflt.idleMs);
    const totalMs =
      typeof params.timeoutMs === 'number' && params.timeoutMs > 0
        ? Math.min(params.timeoutMs, totalCap)
        : totalCap;
    const idleParam =
      typeof params.idleTimeoutMs === 'number' && params.idleTimeoutMs > 0 ? params.idleTimeoutMs : undefined;
    const idleMs = Math.min(idleParam ?? idleDefault, totalMs);
    return { totalMs, idleMs: streaming ? idleMs : 0 };
  }

  /**
   * Chave da guarda anti-reenvio: hash FNV-1a do corpo enviado (sem
   * `node:crypto` — este módulo roda no navegador). O corpo já inclui modelo,
   * mensagens, teto e amostragem: pedido idêntico = chave idêntica.
   */
  private guardKey(body: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < body.length; i++) {
      h ^= body.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `${body.length.toString(36)}-${h.toString(36)}`;
  }

  /** IMPL-073 — reenvio bloqueado? Devolve o erro original (sem nova chamada HTTP). */
  private resendBlocked(key: string): unknown | undefined {
    const ttl = this.cfg.resendGuardTtlMs ?? 0;
    if (ttl <= 0) return undefined;
    const hit = this.resendGuard.get(key);
    if (!hit) return undefined;
    if (hit.until <= Date.now()) {
      this.resendGuard.delete(key);
      return undefined;
    }
    return hit.err;
  }

  /** IMPL-073 — arma a guarda: este corpo pode ter sido cobrado; sem verificação, não reenvia. */
  private armResendGuard(key: string, err: unknown): void {
    const ttl = this.cfg.resendGuardTtlMs ?? 0;
    if (ttl <= 0) return;
    this.resendGuard.set(key, { until: Date.now() + ttl, err });
    // Higiene: nunca crescer sem teto numa sessão longa (SPA aberta por horas).
    if (this.resendGuard.size > 512) {
      const now = Date.now();
      for (const [k, v] of this.resendGuard) if (v.until <= now) this.resendGuard.delete(k);
      while (this.resendGuard.size > 512) {
        const first = this.resendGuard.keys().next();
        if (first.done) break;
        this.resendGuard.delete(first.value);
      }
    }
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
    this.limiters.setMax(this.cfg.maxConcurrency);
    this.freeBuckets.setDailyLimit(this.cfg.freeDailyLimit ?? FREE_DAILY_LIMIT_DEFAULT);
    return this;
  }

  /**
   * Headers do fio. Os de ATRIBUIÇÃO (`HTTP-Referer`/`X-Title`) são dado
   * partilhado com o OpenRouter e saem com `attribution: false` (IMPL-120 —
   * `PROMPT_BUILDER_NO_ATTRIBUTION`); valor vazio também não vai no fio.
   */
  private headers(apiKey: string): Record<string, string> {
    const out: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.cfg.attribution !== false) {
      if (this.cfg.appUrl) out['HTTP-Referer'] = this.cfg.appUrl;
      if (this.cfg.appTitle) out['X-Title'] = this.cfg.appTitle;
    }
    return out;
  }

  /** Chama o transporte SEM `this` do objeto de config (ver GatewayConfig.fetch). */
  private transport(url: string, init: RequestInit): Promise<Response> {
    const f: FetchLike = this.cfg.fetch ?? ((input, i) => globalThis.fetch(input, i));
    return f(url, init);
  }

  /**
   * IMPL-077 — transporte de METADADOS (/models, /key, /generation) com teto
   * (default 20 s, dentro dos 15-30 s pedidos): um servidor mudo não pode mais
   * pendurar o processo para sempre. Timeout sai como `GatewayTimeoutError`.
   *
   * O teto cobre a requisição INTEIRA — headers E corpo: o corpo é lido aqui
   * dentro, sob o mesmo relógio. Antes o timer caía assim que os headers
   * chegavam e um servidor que mandava `200` e travava o corpo pendurava o
   * `listModels` para sempre.
   */
  private async metaRequest(
    url: string,
    init: RequestInit,
  ): Promise<{ ok: boolean; status: number; statusText: string; text: string }> {
    const controller = new AbortController();
    const ms = this.cfg.metaTimeoutMs ?? DEFAULT_META_TIMEOUT_MS;
    let timedOut = false;
    const handle = setTimeout(() => {
      timedOut = true;
      controller.abort(new GatewayTimeoutError('total', ms));
    }, ms);
    try {
      const res = await this.transport(url, { ...init, signal: controller.signal });
      // O corpo sob o MESMO teto; um leitor que ignore o abort ainda perde a
      // corrida para o timer (nada fica pendurado).
      let onAbort: () => void = () => undefined;
      const abortou = new Promise<never>((_, reject) => {
        onAbort = () => reject(new GatewayTimeoutError('total', ms));
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      const corpo = res.text();
      corpo.catch(() => undefined); // perdeu a corrida: a rejeição tardia não vaza
      try {
        const text = await Promise.race([corpo, abortou]);
        return { ok: res.ok, status: res.status, statusText: res.statusText, text };
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
        abortou.catch(() => undefined);
      }
    } catch (err) {
      if (timedOut) throw new GatewayTimeoutError('total', ms);
      throw err;
    } finally {
      clearTimeout(handle);
    }
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
  private async backoff(attempt: number, signal?: AbortSignal, retryAfterMs?: number): Promise<void> {
    if (!signal) return this.sleep(backoffMs(attempt, retryAfterMs));
    if (signal.aborted) throw toControlSignal(signal.reason);
    let onAbort: () => void = () => undefined;
    const abortou = new Promise<never>((_, reject) => {
      onAbort = () => reject(toControlSignal(signal.reason));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([this.sleep(backoffMs(attempt, retryAfterMs), signal), abortou]);
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

    const res = await this.metaRequest(`${this.cfg.baseUrl}/models`, {
      method: 'GET',
      headers: this.headers(apiKey),
    });

    if (!res.ok) {
      throw new Error(`OpenRouter /models falhou: ${res.status} ${res.statusText} ${res.text.slice(0, 200)}`);
    }

    const { models: data, issues } = validateModelsPayload(JSON.parse(res.text) as unknown);
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

  /**
   * Limite atual de concorrencia (para logs/telemetria). Com `apiKey`+`modelId`
   * (e provedor opcional) mostra o ESCOPO daquele par (IMPL-076); sem
   * argumentos, o agregado de todos os escopos (teto mais apertado + somas).
   */
  currentConcurrency(apiKey?: string, modelId?: string, provider?: string): LimiterSnapshot {
    if (apiKey !== undefined && modelId !== undefined) {
      return this.limiters.snapshot({ keyId: cacheKey(apiKey), modelId, ...(provider ? { provider } : {}) });
    }
    return this.limiters.snapshot();
  }

  /**
   * fetch sob o limitador da instancia, com timeout/abort por tentativa e retry
   * com backoff em 429/5xx/rede. Em 429 reduz o limite (AIMD) — no maximo uma
   * vez por janela, e no escopo certo ((key, modelo) ou o refino do provedor).
   * Retorna a Response OK SEGURANDO o slot — o chamador DEVE chamar finish()
   * apos ler o corpo.
   */
  private async guardedFetch(
    url: string,
    init: RequestInit,
    timeouts: { totalMs: number; idleMs: number },
    role: CostRole,
    scope: LimiterScope,
    externalSignal?: AbortSignal,
    track?: DispatchTrack,
  ): Promise<GuardedResponse> {
    let attempt = 0;
    for (;;) {
      // IMPL-076: tetos :free por key ANTES de segurar vaga — a espera do
      // reabastecimento nao deve entupir o semaforo de quem nao e :free.
      if (isFreeModel(scope.modelId)) {
        await this.freeBuckets.take(scope.keyId, (ms, sig) => this.sleep(ms, sig), externalSignal);
      }
      const slot = await this.limiters.acquire(scope, externalSignal);
      // Abortou entre ganhar a vaga e enviar: devolve a vaga SEM tocar o
      // transporte (zero chamadas novas depois do Cancelar — IMPL-020).
      if (externalSignal?.aborted) {
        slot.release();
        throw toControlSignal(externalSignal.reason);
      }
      const controller = new AbortController();
      // IMPL-077: watchdog TOTAL + de INATIVIDADE (o de inatividade só vale em
      // stream — no JSON o provedor fica em silêncio enquanto gera). O erro de
      // timeout é TIPADO (GatewayTimeoutError) e nunca vira sinal de controle.
      let timedOut: 'idle' | 'total' | null = null;
      const totalHandle = setTimeout(() => {
        timedOut = 'total';
        controller.abort(new GatewayTimeoutError('total', timeouts.totalMs, role));
      }, timeouts.totalMs);
      let idleHandle: ReturnType<typeof setTimeout> | undefined;
      const resetIdle = (): void => {
        if (timeouts.idleMs <= 0) return;
        if (idleHandle !== undefined) clearTimeout(idleHandle);
        idleHandle = setTimeout(() => {
          timedOut = 'idle';
          controller.abort(new GatewayTimeoutError('idle', timeouts.idleMs, role));
        }, timeouts.idleMs);
      };
      resetIdle();
      const onExternalAbort = () => controller.abort(externalSignal?.reason);
      if (externalSignal) {
        if (externalSignal.aborted) controller.abort(externalSignal.reason);
        else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
      const cleanup = () => {
        clearTimeout(totalHandle);
        if (idleHandle !== undefined) clearTimeout(idleHandle);
        if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      };

      const startedAt = Date.now();
      // Sinal ja abortado ANTES do envio = nada saiu (o fetch rejeita sem rede).
      const dispatched = !controller.signal.aborted;
      let res: Response;
      try {
        res = await this.transport(url, { ...init, signal: controller.signal });
      } catch (err) {
        cleanup();
        slot.release();
        // Abortada DEPOIS de despachada: o provedor pode seguir gerando e
        // cobrando — quem chamou mantem a reserva (IMPL-017). Erro de rede sem
        // abort (conexao recusada/DNS) nao chegou a gerar: segue devolvendo.
        // Marcado ANTES do sinal de controle abaixo: Cancelar também é abort
        // em voo (a reserva fica pendente, não some).
        if (controller.signal.aborted && dispatched && track) {
          track.abortedInFlight = timedOut ? 'timeout' : 'aborted';
        }
        // Abort EXTERNO (Cancelar/Ctrl-C) sai como SINAL DE CONTROLE, aqui no
        // ponto unico: o que o transporte rejeita varia por runtime, e um erro
        // comum seria degradado pelos papeis em nota inventada (IMPL-020).
        if (externalSignal?.aborted) throw toControlSignal(externalSignal.reason);
        // IMPL-077: timeout sai TIPADO (erro, distinto de controle), sem retry.
        if (timedOut) throw new GatewayTimeoutError(timedOut, timedOut === 'idle' ? timeouts.idleMs : timeouts.totalMs, role);
        if (controller.signal.aborted) throw err;
        // IMPL-073: retry SO em erro ANTES do envio (conexao recusada/DNS) —
        // depois do despacho o desfecho é desconhecido (pode ter gerado e sido
        // cobrado): SEM reenvio; o erro sai marcado para o chamador não repetir.
        if (!preSendError(err) || attempt >= MAX_RETRIES) throw markUpstreamSent(err);
        await this.backoff(attempt, externalSignal);
        attempt += 1;
        continue;
      }

      if (!res.ok) {
        const status = res.status;
        // IMPL-073: Retry-After/retry-after-ms do provedor é PISO do backoff.
        const retryAfterMs = parseRetryAfterMs(res.headers as { get(n: string): string | null | undefined });
        if (isRetryableStatus(status) && attempt < MAX_RETRIES && !externalSignal?.aborted) {
          if (status === 429) {
            // IMPL-076: o corpo do 429 pode identificar o upstream
            // (`error.metadata.provider_code`) e a triagem do recuo depende
            // dele — le o corpo (pequeno) antes de descartar.
            const errText = await res.text().catch(() => '');
            slot.noteRateLimit(providerCodeFromError(errText));
          } else {
            await res.body?.cancel().catch(() => undefined);
          }
          cleanup();
          slot.release();
          await this.backoff(attempt, externalSignal, retryAfterMs);
          attempt += 1;
          continue;
        }
        const errText = await res.text().catch(() => '');
        cleanup();
        slot.release();
        if (externalSignal?.aborted) throw toControlSignal(externalSignal.reason);
        // Classificado: 403 de moderacao sai como 'blocked' (nao "key invalida").
        throw classifyHttpError(status, errText);
      }

      // OK: segura o slot ate o chamador terminar de ler o corpo.
      return {
        res,
        startedAt,
        finish: (ok: boolean) => {
          if (ok) slot.noteSuccess();
          cleanup();
          slot.release();
        },
        abortReason: () => (controller.signal.aborted ? (timedOut ? 'timeout' : 'aborted') : undefined),
        touch: resetIdle,
      };
    }
  }

  // --- geracao ------------------------------------------------------------------

  /** Corpo comum de chat/stream: amostragem determinista, esforco encaixado, teto de preco. */
  private buildBody(params: ChatCompletionParams, stream: boolean): Record<string, unknown> {
    const { apiKey, modelId, messages, temperature = 0 } = params;
    const model = this.cachedModel(apiKey, modelId);
    const body: Record<string, unknown> = {
      model: modelId,
      messages: this.protectMessages(messages, params.sink),
      ...deterministicSampling(model, modelId, temperature),
    };
    if (stream) body.stream = true;
    // SEMPRE com teto (IMPL-017): sem ele a reserva nao limita o estouro.
    body.max_tokens = effectiveMaxTokens(params.maxTokens);
    // IMPL-114: cache_control no FIM do prefixo estável (layout v1 — ver o
    // campo `cacheControlAfter`). Vai DEPOIS do `protectMessages`: o prefixo
    // cacheado tem de ser byte a byte o que sobe no fio.
    if (typeof params.cacheControlAfter === 'number') {
      applyCacheControl(body, params.cacheControlAfter);
    }
    // json_schema estrito quando o catalogo declara structured_outputs (IMPL-006).
    const responseFormat = responseFormatFor(model, params);
    if (responseFormat) body.response_format = responseFormat;
    // O esforco pedido e ENCAIXADO no que este modelo declara aceitar (ver
    // fitEffort/applyReasoning): allowlist propria por modelo e raciocinio
    // obrigatorio em alguns (onde 'off' nao pode ser enviado).
    // Fail-closed (IMPL-018): o catalogo declara que o modelo nao aceita
    // raciocinio (ou a allowlist veio malformada) => nada de `reasoning` no fio.
    if (params.reasoningLevel && !catalogDeniesReasoning(model)) {
      applyReasoning(body, params.reasoningLevel, model?.reasoning);
    }
    applyMaxPrice(body, params.maxPricePerMTok);
    // IMPL-075: modo auditável (preset por papel — juiz/gabarito — ou explícito
    // por chamada). Mescla SEMPRE sobre o provider já montado (max_price/ZDR).
    if (this.auditableFor(params)) {
      applyAuditable(body, {
        order: this.cfg.auditableProviderOrder,
        quantizations: this.cfg.auditableQuantizations,
      });
    }
    // LGPD (IMPL-040): modo "dados sensiveis" FAIL-CLOSED — por ULTIMO, para
    // nada montado acima afrouxar os 4 campos de privacidade; faltou algum,
    // lanca aqui (antes da reserva e do fetch). Politica vem do ledger da run.
    applySensitiveRouting(body, params.sink?.sensitiveRouting?.(), modelId, params.role ?? 'competitor');
    return body;
  }

  /**
   * IMPL-075 — esta chamada vai no modo auditável? Flag da chamada, preset do
   * gateway (`auditableRoles`, env `OPENROUTER_AUDITABLE`) ou a política no
   * ledger (`sink.auditableRoles`). ⚠️ Hoje só o ENV liga o modo em produção:
   * o gancho do ledger (`BudgetLedger.setAuditableRoles`) existe e é testado,
   * mas nenhum campo de RunConfig/sessão o alimenta ainda (IMPL-075 pendente).
   */
  private auditableFor(params: ChatCompletionParams): boolean {
    if (params.auditable === true) return true;
    const role = params.role ?? 'competitor';
    if ((this.cfg.auditableRoles ?? []).includes(role)) return true;
    return (params.sink?.auditableRoles?.() ?? []).includes(role);
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
   * `extra` (IMPL-078/IMPL-075): telemetria de uso por chamada — cached/
   * reasoning tokens, latência, estimado x real e o provedor que serviu.
   */
  private account(
    params: ChatCompletionParams,
    reservation: ReturnType<CostSink['reserve']> | undefined,
    usage: UsageInfo,
    finish?: CallFinishSignals,
    extra?: { latencyMs?: number; provider?: CallProviderInfo; generationId?: string },
  ): CallCost {
    const role = params.role ?? 'competitor';
    const cost = priceUsage(usage, this.cachedModel(params.apiKey, params.modelId));
    // Estimado x real por chamada (IMPL-113): só o custo MEDIDO vira amostra —
    // `catalog`/`unknown` não têm "real" e jamais entram (nem como zero).
    const estimado = this.estimatedUsdFor(params);
    const real = measuredCallUsd(cost);
    if (cost.source === 'usage' && estimado !== null && estimado > 0 && real !== null && real >= 0) {
      recordCostSample({
        role,
        modelId: params.modelId,
        family: modelFamilyOf(params.modelId),
        estimatedUsd: estimado,
        actualUsd: real,
        ...(typeof finish?.effort === 'string' ? { effort: finish.effort } : {}),
        ...(typeof usage.reasoningTokens === 'number' ? { reasoningTokens: usage.reasoningTokens } : {}),
        capTokens: effectiveMaxTokens(params.maxTokens),
      });
    }
    if (reservation) {
      params.sink?.note(reservation, {
        role,
        modelId: params.modelId,
        cost,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        ...(typeof usage.cachedTokensIn === 'number' ? { cachedTokensIn: usage.cachedTokensIn } : {}),
        ...(typeof usage.reasoningTokens === 'number' ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(typeof extra?.latencyMs === 'number' ? { latencyMs: extra.latencyMs } : {}),
        ...(extra?.provider ? { provider: extra.provider } : {}),
        // IMPL-074: o id de geração de TODA chamada 200 vai ao registo (a ponte
        // com a fatura — conferência de cobrança dupla por id).
        ...(extra?.generationId ? { generationId: extra.generationId } : {}),
        ...(this.auditableFor(params) ? { auditable: true } : {}),
        // Estimado x real (IMPL-078): a MESMA conta da reserva (catálogo), contra `cost.usd`.
        ...(estimado !== null ? { estimatedUsd: estimado } : {}),
        ...(finish ? { finish } : {}),
      });
    }
    params.onCost?.(cost);
    return cost;
  }

  /** Estimativa de catálogo desta chamada (a mesma que vai na reserva). `null` = não precificável. */
  private estimatedUsdFor(params: ChatCompletionParams): number | null {
    return computeCost(
      guessPromptTokens(params.messages),
      effectiveMaxTokens(params.maxTokens),
      this.cachedModel(params.apiKey, params.modelId),
    );
  }

  /**
   * Reserva ANTES do slot do limitador: se o orcamento ja estourou, nem
   * enfileira. Lanca BudgetExceeded/RunCancelled (sinais de controle). O teto
   * reservado e o MESMO que vai no corpo (`effectiveMaxTokens`); o gateway
   * manda junto a sua propria estimativa pelo catalogo em cache (fallback do
   * ledger) e usa `admit` — o limite de 1 chamada sem preco em voo por papel.
   *
   * IMPL-113: a RESERVA DURA leva o tokenizer + `RESERVE_TOKEN_MARGIN` (~20%) —
   * subestimar tokens de entrada aqui afrouxa a porta dura; a estimativa que vai
   * ao registo estimado × real (`estimatedUsdFor`) fica SEM margem, para a
   * calibração comparar estimativa honesta com o real.
   */
  private async reserveFor(
    params: ChatCompletionParams,
    role: CostRole,
  ): Promise<ReturnType<CostSink['reserve']> | undefined> {
    const sink = params.sink;
    if (!sink) return undefined;
    const cap = effectiveMaxTokens(params.maxTokens);
    const promptGuess = Math.ceil(guessPromptTokens(params.messages) * RESERVE_TOKEN_MARGIN);
    const fallback = computeCost(promptGuess, cap, this.cachedModel(params.apiKey, params.modelId));
    const fb = fallback === null ? undefined : fallback;
    return sink.admit
      ? sink.admit(role, params.modelId, promptGuess, cap, fb, params.signal)
      : sink.reserve(role, params.modelId, promptGuess, cap, fb);
  }

  /**
   * Chamada DESPACHADA sem custo medido (IMPL-017 / R-07a:REC-2): abort,
   * timeout, corpo ilegivel ou resposta sem bloco `usage`. A reserva e mantida
   * (pendente, conciliavel pelo `generationId`) ou lancada inteira como gasto
   * conservador — nunca devolvida, nunca zero. O custo devolvido ao chamador
   * segue a MESMA regra do ledger (IMPL-017, revisao): conservador => `usd` =
   * reserva (ja esta no gasto); pendente => `usd: 0` + `pendingUsd` = reserva
   * (fora do gasto ate conciliar). Antes o pendente voltava como `usd` cheio e
   * `soma(costByContestant)` passava de `totalCostUsd`.
   */
  private accountUnmeasured(
    params: ChatCompletionParams,
    reservation: ReturnType<CostSink['reserve']> | undefined,
    reason: PendingReason,
    generationId: string | undefined,
    finish?: CallFinishSignals,
    extra?: { provider?: CallProviderInfo; latencyMs?: number },
  ): CallCost {
    if (reservation) {
      params.sink?.pending(reservation, {
        role: params.role ?? 'competitor',
        modelId: params.modelId,
        reason,
        ...(generationId ? { generationId } : {}),
        ...(extra?.provider ? { provider: extra.provider } : {}),
        ...(typeof extra?.latencyMs === 'number' ? { latencyMs: extra.latencyMs } : {}),
        ...(this.auditableFor(params) ? { auditable: true } : {}),
        ...(finish ? { finish } : {}),
      });
    }
    const usd = reservation?.usd ?? 0;
    const cost: CallCost =
      reservation?.status === 'pending' ? { usd: 0, source: 'unknown', pendingUsd: usd } : { usd, source: 'unknown' };
    params.onCost?.(cost);
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
    // IMPL-080: cache EXATO de vereditos ANTES de qualquer reserva/fetch.
    // IMPL-114: aquecimento do prefixo cacheável DEPOIS dele (hit não aquece).
    return this.withVerdictCache(params, () => this.withCacheWarmup(params, () => this.chatCompletionDirect(params)));
  }

  async chatCompletionStream(params: ChatStreamParams): Promise<ChatCompletionResult> {
    return this.withVerdictCache(params, () => this.withCacheWarmup(params, () => this.chatCompletionStreamDirect(params)));
  }

  /**
   * IMPL-063 — chamada PAGA não-chat com lista de textos (`input`), pelo MESMO
   * caminho do chat: cascata de dado pessoal nos textos (IMPL-042), roteamento
   * sensível fail-closed, reserva no ledger ANTES do slot (role + sink), o
   * limitador AIMD/retry/watchdog de `guardedFetch` e o custo MEDIDO por
   * `usage.cost` (`account`) — sem `usage`, pendente/conservador
   * (`accountUnmeasured`), nunca zero. Quem usa: `src/embeddings.ts` (dedup de
   * cenários do datagen). Devolve o JSON cru da resposta 200.
   */
  async meteredInputCall(params: MeteredInputParams): Promise<MeteredInputResult> {
    const { apiKey, modelId, sink, signal: externalSignal } = params;
    const role = params.role;
    // A MESMA forma de pedido que a reserva/cascata conhecem: cada texto é uma
    // mensagem `user`; teto de saída 1 token (estes pontos não geram texto).
    const comoChat: ChatCompletionParams = {
      apiKey,
      modelId,
      messages: params.input.map((content) => ({ role: 'user' as const, content })),
      maxTokens: 1,
      role,
      ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
      ...(sink ? { sink } : {}),
      ...(externalSignal ? { signal: externalSignal } : {}),
    };
    const protegidas = this.protectMessages(comoChat.messages, sink).map((m) => m.content);
    const corpo: Record<string, unknown> = { model: modelId, input: protegidas };
    applySensitiveRouting(corpo, sink?.sensitiveRouting?.(), modelId, role);
    const timeouts = this.timeoutsFor(comoChat, false);
    const reservation = await this.reserveFor(comoChat, role);
    const track: DispatchTrack = {};
    let guarded: GuardedResponse;
    try {
      guarded = await this.guardedFetch(
        `${this.cfg.baseUrl}/${params.path.replace(/^\/+/, '')}`,
        { method: 'POST', headers: this.headers(apiKey), body: JSON.stringify(corpo) },
        timeouts,
        role,
        limiterScopeOf(apiKey, modelId, corpo),
        externalSignal,
        track,
      );
    } catch (err) {
      if (track.abortedInFlight) this.accountUnmeasured(comoChat, reservation, track.abortedInFlight, undefined);
      else reservation?.release();
      throw err;
    }
    const { res, startedAt, finish } = guarded;
    let contabilizado = false;
    let ok = false;
    let generationId: string | undefined;
    try {
      const json = (await res.json()) as { id?: unknown; usage?: unknown; error?: unknown };
      generationId = typeof json?.id === 'string' && json.id ? json.id : undefined;
      const latencyMs = Date.now() - startedAt;
      const cost = hasUsage(json?.usage)
        ? this.account(comoChat, reservation, extractUsage(json.usage), undefined, {
            latencyMs,
            ...(generationId ? { generationId } : {}),
          })
        : this.accountUnmeasured(comoChat, reservation, 'no_usage', generationId, undefined, { latencyMs });
      contabilizado = true;
      // 200 com corpo de erro (provedor recusou): falha, já contabilizada.
      if (json?.error) {
        const e = json.error as { message?: unknown };
        throw new Error(`OpenRouter: ${typeof e?.message === 'string' ? e.message : JSON.stringify(json.error)}`);
      }
      ok = true;
      return { raw: json, cost, latencyMs };
    } catch (err) {
      throw controlIfAborted(err, externalSignal);
    } finally {
      if (!contabilizado) {
        this.accountUnmeasured(comoChat, reservation, guarded.abortReason() ?? 'no_usage', generationId, undefined, {
          latencyMs: Date.now() - startedAt,
        });
      }
      finish(ok);
    }
  }

  /**
   * Cache de vereditos desta chamada (IMPL-080), quando o reuso é LEGÍTIMO:
   * papel de juízo (judge/duel/gabarito — é o veredito que se reusa; respostas
   * de competidor amostram variância e nunca entram), cache ligado, SEM
   * roteamento sensível (LGPD fail-closed: a resposta cacheada pode ter vindo
   * de provedor fora da allowlist ZDR) e sem abort pendente (abort é CONTROLE
   * e o caminho normal o classifica).
   */
  private verdictCacheFor(params: ChatCompletionParams): VerdictCache | undefined {
    // IMPL-080: o cache da SESSÃO de treino viaja no ledger (`sink.verdictCache`,
    // escopo da cadeia de forks) — o do gateway é o interruptor global legado.
    const cache = this.cfg.verdictCache || params.sink?.verdictCache?.();
    if (!cache) return undefined;
    const role = params.role;
    if (role !== 'judge' && role !== 'duel' && role !== 'gabarito') return undefined;
    if (params.sink?.sensitiveRouting?.()) return undefined;
    if (params.signal?.aborted) return undefined;
    return cache;
  }

  /**
   * IMPL-080 (R-08:REC-3) — lookup/store do veredito com a chave EXATA
   * {modelo + esforço + temperatura + max_tokens + hash do contrato do juiz +
   * texto completo do prompt} (sem credenciais). Carry entre iterações +
   * re-teste amostral (~10% dos itens): o item sorteado é RE-JULGADO de
   * verdade, o veredito é comparado e, acima do limiar de discordância, o
   * cache inteiro cai (`noteRetest`). Os lookups sobem ao ledger
   * (`noteVerdictCache` → `cacheHits`/`cacheTotal` por papel no `run.spend`).
   */
  private async withVerdictCache(
    params: ChatStreamParams,
    run: () => Promise<ChatCompletionResult>,
  ): Promise<ChatCompletionResult> {
    const cache = this.verdictCacheFor(params);
    if (!cache) return run();
    const promptText = params.messages.map((m) => `${m.role}\u0000${m.content}`).join('\u0000');
    const key = verdictCacheKey({
      modelId: params.modelId,
      effort: params.reasoningLevel ?? null,
      temperature: params.temperature ?? null,
      maxTokens: effectiveMaxTokens(params.maxTokens),
      contractHash: judgeContractHash({
        systemTexts: params.messages.filter((m) => m.role === 'system').map((m) => m.content),
        responseSchemaName: params.responseSchema?.name ?? null,
        responseSchema: params.responseSchema?.schema ?? null,
        responseFormatJson: params.responseFormatJson ?? null,
      }),
      promptText,
    });
    const role = params.role ?? 'competitor';
    // IMPL-080: o texto servido do cache é re-amarrado ao marcador/canário
    // DESTA chamada (a blindagem do juiz sorteia os dois por veredito).
    const hit = cache.lookup(key, promptText);
    if (hit) {
      params.sink?.noteVerdictCache?.({ role, hit: true });
      if (!hit.retest) return this.cachedVerdictResult(params, hit.entry);
      // Re-teste amostral OBRIGATÓRIO: re-julga de verdade por baixo, compara o
      // veredito (discordância acima do limiar invalida o cache) e devolve o
      // resultado REAL — quem serve é a nova medição, não o replay.
      const fresh = await run();
      cache.noteRetest(key, this.storableOf(fresh), promptText);
      return fresh;
    }
    params.sink?.noteVerdictCache?.({ role, hit: false });
    const result = await run();
    // Só guarda o que completou SEM bloqueio do guardrail (corte de moderação
    // não é veredito — re-julgar é sempre o caminho).
    if (!result.blocked) cache.store(key, this.storableOf(result), promptText);
    return result;
  }

  /** O que o cache guarda de uma resposta (texto reidratado + sinais de fim). */
  private storableOf(result: ChatCompletionResult): Pick<VerdictCacheEntry, 'text' | 'finishReason' | 'nativeFinishReason' | 'refusal' | 'truncated'> {
    return {
      text: result.text,
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      ...(result.nativeFinishReason ? { nativeFinishReason: result.nativeFinishReason } : {}),
      ...(result.refusal ? { refusal: result.refusal } : {}),
      ...(result.truncated ? { truncated: result.truncated } : {}),
    };
  }

  /** Resposta servida do cache: zero chamada upstream, zero cobrança. */
  private cachedVerdictResult(params: ChatStreamParams, entry: VerdictCacheEntry): ChatCompletionResult {
    params.onDelta?.(entry.text, entry.text);
    return {
      text: entry.text,
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
      raw: { cached: true },
      cost: { usd: 0, source: 'usage' },
      ...(entry.finishReason ? { finishReason: entry.finishReason } : {}),
      ...(entry.nativeFinishReason ? { nativeFinishReason: entry.nativeFinishReason } : {}),
      ...(entry.refusal ? { refusal: entry.refusal } : {}),
      ...(entry.truncated ? { truncated: entry.truncated } : {}),
      cacheHit: true,
    };
  }

  /**
   * IMPL-114 (R-08:REC-4) — AQUECIMENTO do prefixo cacheável: a PRIMEIRA
   * chamada com um dado prefixo (modelo + mensagens até `cacheControlAfter`)
   * vai sozinha; as outras com o MESMO prefixo esperam ela terminar e só então
   * saem — em paralelo, já achando o cache escrito. Sem isto o `Promise.all`
   * do julgamento dispara N chamadas idênticas no mesmo instante e todas
   * ESCREVEM o cache (nenhuma lê). Só vale quando o chamador pediu a quebra
   * (`cacheControlAfter`); não é teto de concorrência — cada prefixo espera
   * UMA chamada, uma vez, e prefixos diferentes nunca se esperam.
   */
  private readonly warmups = new Map<string, Promise<void> | true>();

  private async withCacheWarmup<T>(params: ChatCompletionParams, run: () => Promise<T>): Promise<T> {
    const k = params.cacheControlAfter;
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 0 || k >= params.messages.length) return run();
    const key = this.guardKey(
      [cacheKey(params.apiKey), params.modelId, ...params.messages.slice(0, k + 1).map((m) => `${m.role}\u0000${m.content}`)].join('\u0000'),
    );
    const estado = this.warmups.get(key);
    if (estado === true) return run();
    if (estado) {
      await waitOrAbort(estado, params.signal);
      return run();
    }
    let aquecido: () => void = () => undefined;
    this.warmups.set(key, new Promise<void>((resolve) => (aquecido = resolve)));
    try {
      return await run();
    } finally {
      // Falhou ou não, quem espera segue: o aquecimento é otimização, nunca porta.
      this.warmups.set(key, true);
      aquecido();
      if (this.warmups.size > 1024) {
        for (const [chave, v] of this.warmups) {
          if (this.warmups.size <= 768) break;
          if (v === true) this.warmups.delete(chave);
        }
      }
    }
  }

  /**
   * Fecha uma resposta 200 (JSON ou SSE, os MESMOS campos): bloqueio/recusa,
   * truncamento, sinais de fim, proveniência, CONTABILIDADE e o resultado.
   * Contabiliza ANTES de lançar a falha in-band — uma resposta 200 com corpo
   * de erro JÁ foi cobrada (sem isto ela saía de graça nos livros e cara na
   * fatura). `st.accounted` avisa o chamador de que o custo já foi lançado.
   */
  private async finalizeReply(
    params: ChatCompletionParams,
    reservation: ReturnType<CostSink['reserve']> | undefined,
    body: Record<string, unknown>,
    maxTokens: number,
    startedAt: number,
    reply: CollectedReply,
    st: { accounted: boolean },
  ): Promise<ChatCompletionResult> {
    const usage = extractUsage(reply.usageRaw);
    // Erro no MEIO do stream chega como chunk `{ error, finish_reason: 'error' }`
    // (o HTTP ja foi 200); no JSON, como `{ error }` no corpo 200. Moderacao
    // aqui e bloqueio, nao "resposta vazia".
    const inBandBlock = reply.error ? blockFromErrorBody(reply.error, undefined, 'in_band') : undefined;
    // OpenRouter as vezes devolve 200 com um corpo de erro (ex.: provider
    // rejeitou um parametro). Sem isto a falha viraria "resposta vazia" muda.
    const inBandFailure = !reply.text && Boolean(reply.error);
    const blocked = inBandBlock ?? blockFromFinishReason(reply.finishReason, reply.nativeFinishReason);
    const refusal = refusalText(reply.refusal);
    // O finish_reason (penultimo chunk no SSE) e o usage (com reasoning_tokens,
    // ultimo chunk) so estao completos aqui: e aqui que se decide o truncamento.
    const trunc = this.truncationOf(
      maxTokens,
      usage,
      reply.text,
      reply.finishReason,
      reply.nativeFinishReason,
      Boolean(blocked || refusal),
    );
    // Sinais de fim so quando a chamada completou (a falha in-band nao tem fim a medir).
    const fim = inBandFailure
      ? undefined
      : withEffort(
          finishSignalsOf(
            {
              text: reply.text,
              tokensOut: usage.tokensOut,
              reasoningTokens: usage.reasoningTokens,
              finishReason: reply.finishReason,
              nativeFinishReason: reply.nativeFinishReason,
              ...trunc,
            },
            maxTokens,
          ),
          body,
        );
    // IMPL-075: completa provider_name/upstream_id/service_tier via
    // GET /generation quando o modo pedir (best-effort, nunca derruba a chamada).
    const provider = mergeProviderInfo(reply.provider, await this.lookupProvider(params, reply.generationId, reply.provider));
    const latencyMs = Date.now() - startedAt;
    // Sem bloco `usage` nao ha custo medido: pendente pelo id (IMPL-017).
    const cost = hasUsage(reply.usageRaw)
      ? this.account(params, reservation, usage, fim, { latencyMs, provider, generationId: reply.generationId })
      : this.accountUnmeasured(params, reservation, 'no_usage', reply.generationId, fim, { latencyMs, provider });
    st.accounted = true;
    if (inBandFailure && reply.error) {
      if (inBandBlock) throw new GatewayError('blocked', inBandBlock.message, { block: inBandBlock });
      throw new Error(`OpenRouter: ${reply.error.message ?? JSON.stringify(reply.error)}`);
    }
    return {
      // Reidratado: o papel recebe o valor original, nunca o token (LGPD, IMPL-042).
      text: this.restoreText(reply.text, params.sink),
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      latencyMs,
      raw: reply.raw,
      cost,
      cachedTokensIn: usage.cachedTokensIn,
      reasoningTokens: usage.reasoningTokens,
      ...(reply.finishReason ? { finishReason: reply.finishReason } : {}),
      ...(reply.nativeFinishReason ? { nativeFinishReason: reply.nativeFinishReason } : {}),
      ...(refusal ? { refusal } : {}),
      ...(blocked ? { blocked } : {}),
      ...(provider ? { provider } : {}),
      ...(this.auditableFor(params) ? { auditable: true } : {}),
      ...trunc,
    };
  }

  private async chatCompletionDirect(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    // IMPL-072: transporte STREAMING (default de runtime — ver `streamTransport`)
    // — o parser é ÚNICO (o de `chatCompletionStream`) e em abort/timeout o
    // provedor PARA de gerar em vez de concluir e cobrar a resposta inteira.
    if (params.streamTransport ?? this.cfg.streamTransport) return this.chatCompletionStreamDirect(params);
    const { signal: externalSignal } = params;
    const maxTokens = effectiveMaxTokens(params.maxTokens);
    const role = params.role ?? 'competitor';
    const timeouts = this.timeoutsFor(params, false);
    const body = this.buildBody(params, false);
    const bodyJson = JSON.stringify(body);
    // IMPL-073: reenvio SEM verificação de uma chamada que pode ter sido cobrada
    // (falha depois dos headers) é recusado aqui, antes de reservar/gerar.
    const guardKey = this.guardKey(bodyJson);
    const bloqueado = this.resendBlocked(guardKey);
    if (bloqueado !== undefined) throw bloqueado;

    const reservation = await this.reserveFor(params, role);

    const track: DispatchTrack = {};
    let guarded: GuardedResponse;
    // Nota: `JSON.stringify(body)` sai repetido de propósito — o contrato
    // estático do ponto único (test/lgpd-pii.test.ts) exige o corpo SAIR de
    // `buildBody` no próprio POST.
    try {
      guarded = await this.guardedFetch(
        `${this.cfg.baseUrl}/chat/completions`,
        { method: 'POST', headers: this.headers(params.apiKey), body: JSON.stringify(body) },
        timeouts,
        role,
        limiterScopeOf(params.apiKey, params.modelId, body),
        externalSignal,
        track,
      );
    } catch (err) {
      // Abortada depois de despachada => pendente/conservador; HTTP de erro e
      // falha de rede sem resposta => nada gerado, a reserva volta (IMPL-017).
      if (track.abortedInFlight) this.accountUnmeasured(params, reservation, track.abortedInFlight, undefined);
      else reservation?.release();
      throw err;
    }
    const { res, startedAt, finish } = guarded;

    // A partir daqui o provedor ja respondeu 200: qualquer saida sem custo
    // lancado e "despachada sem usage" — nunca devolucao da reserva.
    const st = { accounted: false };
    let ok = false;
    let lido: CollectedReply | undefined;
    try {
      lido = collectJsonReply(await res.json());
      const result = await this.finalizeReply(params, reservation, body, maxTokens, startedAt, lido, st);
      ok = true;
      return result;
    } catch (err) {
      // IMPL-073: falha DEPOIS do 200 (corpo ilegível/cortado) tem desfecho
      // desconhecido e PODE ter sido cobrada: marca o erro e guarda o corpo
      // contra reenvio sem verificação.
      if (!st.accounted && !isControlSignal(err)) this.armResendGuard(guardKey, markUpstreamSent(err));
      throw controlIfAborted(err, externalSignal);
    } finally {
      // Corpo abortado/ilegivel depois do 200: o provedor gerou (e cobra) —
      // no nao-streaming ele segue gerando apos o abort (IMPL-017).
      if (!st.accounted) {
        this.accountUnmeasured(params, reservation, guarded.abortReason() ?? 'no_usage', lido?.generationId, undefined, {
          provider: lido?.provider,
          latencyMs: Date.now() - startedAt,
        });
      }
      finish(ok);
    }
  }

  private async chatCompletionStreamDirect(params: ChatStreamParams): Promise<ChatCompletionResult> {
    const { signal: externalSignal, sink, onDelta } = params;
    const maxTokens = effectiveMaxTokens(params.maxTokens);
    const role = params.role ?? 'competitor';
    // IMPL-077: inatividade + teto total por papel (o watchdog de inatividade é
    // o que faz sentido em stream — cada chunk zera o relógio via `touch`).
    const timeouts = this.timeoutsFor(params, true);
    const body = this.buildBody(params, true);
    const bodyJson = JSON.stringify(body);
    // IMPL-073: sem verificação (GET /generation), não reenvia o mesmo corpo.
    const guardKey = this.guardKey(bodyJson);
    const bloqueado = this.resendBlocked(guardKey);
    if (bloqueado !== undefined) throw bloqueado;

    const reservation = await this.reserveFor(params, role);

    const track: DispatchTrack = {};
    let guarded: GuardedResponse;
    // Mesma nota do chatCompletion: o POST precisa mostrar `JSON.stringify(body)`.
    try {
      guarded = await this.guardedFetch(
        `${this.cfg.baseUrl}/chat/completions`,
        { method: 'POST', headers: this.headers(params.apiKey), body: JSON.stringify(body) },
        timeouts,
        role,
        limiterScopeOf(params.apiKey, params.modelId, body),
        externalSignal,
        track,
      );
    } catch (err) {
      if (track.abortedInFlight) this.accountUnmeasured(params, reservation, track.abortedInFlight, undefined);
      else reservation?.release();
      throw err;
    }
    const { res, startedAt, finish, touch } = guarded;

    const st = { accounted: false };
    let ok = false;
    // Acumulado do stream. O id da geracao vem em TODO chunk — e o que permite
    // conciliar um stream cortado no meio pelo GET /generation (IMPL-017).
    // `usageRaw` e guardado SEPARADO do `raw`: hoje o ultimo chunk *por acaso*
    // e o de usage (porque `[DONE]` e ignorado), mas basta um provedor emitir
    // um keep-alive depois do frame de usage para o custo sumir em silencio.
    const acc: CollectedReply = { text: '', usageRaw: null, refusal: '', error: null, raw: null };

    try {
      if (!res.body) throw new Error('OpenRouter retornou stream sem corpo de resposta.');
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      // IMPL-072: pedir `stream: true` nao garante SSE — proxy/mock/provedor
      // pode devolver o JSON inteiro. O 1o caractere util decide: `{` = corpo
      // JSON (lido inteiro, mesmos campos); qualquer outro = SSE.
      let modo: 'sse' | 'json' | undefined;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // IMPL-077: qualquer byte recebido zera o watchdog de inatividade.
        touch();
        buffer += decoder.decode(value, { stream: true });
        if (!modo) {
          const inicio = buffer.trimStart();
          if (!inicio) continue;
          modo = inicio.startsWith('{') ? 'json' : 'sse';
        }
        if (modo === 'json') continue; // acumula o corpo inteiro

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
              id?: unknown;
            };
            acc.raw = chunk;
            acc.generationId ??= generationIdOf(chunk);
            // IMPL-075: o provedor vem em todo chunk (campo `provider`).
            acc.provider ??= extractProviderInfo(chunk);
            if (chunk.error && !acc.error) {
              acc.error = typeof chunk.error === 'object' ? chunk.error : { message: String(chunk.error) };
            }
            const choice = chunk.choices?.[0];
            const delta = choice?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              acc.text += delta;
              // Previa ja reidratada (sem contar: e a mesma resposta a cada pedaco).
              // `delta` e o pedaco cru do provedor — pode trazer token parcial.
              onDelta?.(delta, this.restoreText(acc.text, sink, false));
            }
            if (typeof choice?.delta?.refusal === 'string') acc.refusal += choice.delta.refusal;
            // Sinais de fim: chegam num chunk proprio perto do fim (antes do
            // frame de usage). Guarda o ULTIMO nao-nulo.
            acc.finishReason = finishText(choice?.finish_reason) ?? acc.finishReason;
            acc.nativeFinishReason = finishText(choice?.native_finish_reason) ?? acc.nativeFinishReason;
            if (chunk.usage) acc.usageRaw = chunk.usage;
          } catch {
            // chunk JSON invalido, ignora
          }
        }
      }

      if (modo === 'json') {
        buffer += decoder.decode();
        Object.assign(acc, collectJsonReply(JSON.parse(buffer)));
        if (acc.text) onDelta?.(acc.text, this.restoreText(acc.text, sink, false));
      }

      const result = await this.finalizeReply(params, reservation, body, maxTokens, startedAt, acc, st);
      ok = true;
      return result;
    } catch (err) {
      // IMPL-073: stream cortado/abortado DEPOIS do 200 = desfecho desconhecido
      // (o provedor pode ter concluído e cobrado): marca o erro e guarda o corpo
      // contra reenvio sem verificação.
      if (!st.accounted && !isControlSignal(err)) this.armResendGuard(guardKey, markUpstreamSent(err));
      throw controlIfAborted(err, externalSignal);
    } finally {
      // Stream cortado no meio (abort/timeout/rede): tokens ja gerados foram
      // cobrados — pendente pelo id dos chunks, conservador sem ele (IMPL-017).
      if (!st.accounted) {
        this.accountUnmeasured(params, reservation, guarded.abortReason() ?? 'no_usage', acc.generationId, undefined, {
          provider: acc.provider,
          latencyMs: Date.now() - startedAt,
        });
      }
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

    let res: Awaited<ReturnType<OpenRouterGateway['metaRequest']>>;
    try {
      res = await this.metaRequest(`${this.cfg.baseUrl}/key`, {
        method: 'GET',
        headers: this.headers(key),
      });
    } catch (err) {
      return { ok: false, network: true, error: `Falha de rede ao validar a key: ${(err as Error).message}` };
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
      return { ok: false, error: describeOpenRouterError(res.status, res.text) };
    }

    const json = safeJson(res.text) as { data?: Record<string, unknown> };
    const d = json.data ?? {};
    return {
      ok: true,
      label: typeof d.label === 'string' ? d.label : undefined,
      usageUsd: typeof d.usage === 'number' ? d.usage : undefined,
      limitUsd: asNumberOrNull(d.limit),
      limitRemainingUsd: asNumberOrNull(d.limit_remaining),
      isFreeTier: typeof d.is_free_tier === 'boolean' ? d.is_free_tier : undefined,
      limitReset: typeof d.limit_reset === 'string' ? d.limit_reset : d.limit_reset === null ? null : undefined,
      usageDailyUsd: typeof d.usage_daily === 'number' ? d.usage_daily : undefined,
    };
  }

  // --- geracao (conciliacao/proveniencia) ---------------------------------------

  /**
   * IMPL-075 / IMPL-074 (R-07a:REC-4) — `GET /api/v1/generation?id=…`: o
   * provedor que efetivamente serviu a chamada (`provider_name`, `upstream_id`,
   * `service_tier`), o custo cobrado (`total_cost`) e se a geração foi
   * cancelada. É o MESMO endpoint da conciliação de pendentes
   * (`reconcilePending` → `BudgetLedger.settlePending`); aqui fica acessível a
   * qualquer papel. Best-effort, UMA tentativa: id vazio, 404 ou falha de rede
   * => `undefined` (quem precisa de retry usa `fetchGenerationDetail`).
   */
  async fetchGenerationInfo(apiKey: string, generationId: string): Promise<GenerationInfo | undefined> {
    const r = await this.fetchGenerationDetail(apiKey, generationId, { attempts: 1 });
    return r.status === 'ok' ? r.info : undefined;
  }

  /**
   * IMPL-074 — GET /generation com RETRY: o 404 logo depois da chamada é
   * TRANSITÓRIO (a fatura ainda não propagou — R-07a DEC-4), assim como
   * 429/5xx; backoff exponencial (1 s, 2 s, 4 s… — `sleep` injetável) até
   * `attempts`. 404 persistente => `not_found` (o id não existe na conta).
   */
  async fetchGenerationDetail(
    apiKey: string,
    generationId: string,
    opts: { attempts?: number; baseDelayMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ status: 'ok' | 'not_found' | 'error'; info?: GenerationInfo; error?: string }> {
    const id = (generationId ?? '').trim();
    if (!id) return { status: 'error', error: 'id vazio' };
    const attempts = Math.max(1, Math.floor(opts.attempts ?? 4));
    const base = Math.max(0, opts.baseDelayMs ?? 1000);
    let last: { status: 'not_found' | 'error'; error: string } = { status: 'error', error: 'sem tentativa' };
    for (let i = 0; i < attempts; i++) {
      if (i > 0) {
        if (opts.signal?.aborted) break;
        await this.sleep(base * 2 ** (i - 1), opts.signal);
        if (opts.signal?.aborted) break;
      }
      let res: Awaited<ReturnType<OpenRouterGateway['metaRequest']>>;
      try {
        res = await this.metaRequest(`${this.cfg.baseUrl}/generation?id=${encodeURIComponent(id)}`, {
          method: 'GET',
          headers: this.headers(apiKey),
        });
      } catch (err) {
        last = { status: 'error', error: (err as Error).message };
        continue;
      }
      if (res.ok) {
        const info = parseGenerationInfo(id, safeJson(res.text));
        if (info) return { status: 'ok', info };
        last = { status: 'error', error: 'resposta sem data' };
        continue;
      }
      last = res.status === 404 ? { status: 'not_found', error: 'HTTP 404' } : { status: 'error', error: `HTTP ${res.status}` };
      // 401/403/400: repetir não muda nada.
      if (res.status !== 404 && res.status !== 429 && res.status < 500) break;
    }
    return last;
  }

  /**
   * IMPL-074 / IMPL-017 (iv) — CONCILIA as pendentes do ledger pela fatura:
   * para cada chamada despachada sem custo medido (abort/timeout/sem usage)
   * com id de geração, busca o `total_cost` no GET /generation e troca a
   * reserva mantida pelo valor COBRADO (`settlePending`, source `usage`),
   * gravando provedor/cancelled/generation_time/latency no registo da
   * chamada. 404 persistente (ou id fora do formato `gen-…`, que o
   * /generation nunca acharia) => a reserva vira gasto CONSERVADOR — não
   * medido não é "custou zero". Falha de rede => segue pendente (a conciliação
   * pode rodar de novo depois). Concorrência pequena de propósito: o endpoint
   * tem rate limit próprio. Não é chamada de LLM: não passa pelo ledger.
   *
   * `notFoundAsPending` (o FIM DE RUN usa): o 404 de um id `gen-…` NÃO é
   * definitivo — as últimas chamadas da run (finais, juiz) têm segundos de
   * idade e o /generation costuma dar 404 até indexar a geração. Converter em
   * conservador ali trocaria a fatura real pela reserva PARA SEMPRE (sai do
   * conjunto de pendentes); com a opção a chamada segue pendente no record
   * (`costLedger.pendingEntries`), conciliável depois, e conta em `failed`.
   */
  async reconcilePending(
    ledger: ReconcilableLedger,
    apiKey: string,
    opts: {
      attempts?: number;
      baseDelayMs?: number;
      concurrency?: number;
      signal?: AbortSignal;
      notFoundAsPending?: boolean;
    } = {},
  ): Promise<NonNullable<CostLedgerSummary['reconciliation']>> {
    const pendentes = ledger.pendingEntries();
    const out = { attempted: pendentes.length, settled: 0, notFound: 0, failed: 0 };
    if (pendentes.length === 0) return out;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < pendentes.length) {
        const p = pendentes[next++];
        if (opts.signal?.aborted) {
          out.failed += 1;
          continue;
        }
        if (!isGenerationId(p.generationId)) {
          // Id sintetizado/malformado: o /generation devolveria 404 para sempre.
          ledger.settlePending(p.generationId, null);
          out.notFound += 1;
          continue;
        }
        const r = await this.fetchGenerationDetail(apiKey, p.generationId, opts).catch(
          (err: unknown) => ({ status: 'error' as const, error: (err as Error).message, info: undefined }),
        );
        if (r.status === 'ok' && r.info && typeof r.info.totalCostUsd === 'number') {
          const details: SettleDetails = {
            ...(r.info.provider ? { provider: r.info.provider } : {}),
            ...(typeof r.info.cancelled === 'boolean' ? { cancelled: r.info.cancelled } : {}),
            ...(typeof r.info.generationTimeMs === 'number' ? { generationTimeMs: r.info.generationTimeMs } : {}),
            ...(typeof r.info.latencyMs === 'number' ? { latencyMs: r.info.latencyMs } : {}),
          };
          const cost: CallCost = {
            usd: r.info.totalCostUsd,
            source: 'usage',
            ...(r.info.byok ? { byok: true } : {}),
            ...(r.info.byok && typeof r.info.byokUpstreamUsd === 'number' ? { byokUpstreamUsd: r.info.byokUpstreamUsd } : {}),
          };
          ledger.settlePending(
            p.generationId,
            cost,
            { tokensIn: r.info.tokensIn, tokensOut: r.info.tokensOut },
            details,
          );
          out.settled += 1;
        } else if (r.status === 'not_found' && !opts.notFoundAsPending) {
          ledger.settlePending(p.generationId, null);
          out.notFound += 1;
        } else {
          // Rede/erro — ou 404 recente no fim da run: segue PENDENTE.
          out.failed += 1;
        }
      }
    };
    const width = Math.max(1, Math.min(opts.concurrency ?? 4, pendentes.length));
    await Promise.all(Array.from({ length: width }, worker));
    ledger.noteReconciliation?.(out);
    return out;
  }

  /**
   * IMPL-075 — completa a proveniência do provedor pelo GET /generation quando
   * o modo `providerLookup` pedir ('missing' = só sem nome no payload;
   * 'always' = sempre). Nunca derruba a chamada: sem recuperação, fica o que o
   * payload trouxe.
   */
  private async lookupProvider(
    params: ChatCompletionParams,
    generationId: string | undefined,
    fromPayload: CallProviderInfo | undefined,
  ): Promise<CallProviderInfo | undefined> {
    const mode = params.providerLookup ?? this.cfg.providerLookup ?? 'off';
    if (mode === 'off') return undefined;
    if (!generationId) return undefined;
    if (mode === 'missing' && fromPayload?.name) return undefined;
    const info = await this.fetchGenerationInfo(params.apiKey, generationId).catch(() => undefined);
    return info?.provider;
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

/** Agregado dos escopos, ou o escopo de um par (key, modelo) [provedor]. */
export function currentConcurrency(apiKey?: string, modelId?: string, provider?: string): LimiterSnapshot {
  return defaultGateway.currentConcurrency(apiKey, modelId, provider);
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

/** IMPL-063 — chamada paga não-chat pelo gateway padrão (ver `OpenRouterGateway.meteredInputCall`). */
export function meteredInputCall(params: MeteredInputParams): Promise<MeteredInputResult> {
  return defaultGateway.meteredInputCall(params);
}

/** Pseudonimiza `value` com o cofre do escopo de `sink` na instancia padrao (ver o metodo). */
export function pseudonymize<T>(value: T, sink?: CostSink): T {
  return defaultGateway.pseudonymize(value, sink);
}

export function validateKey(apiKey: string): Promise<ValidateKeyResult> {
  return defaultGateway.validateKey(apiKey);
}

/**
 * IMPL-074 / IMPL-017 (iv) — concilia as pendentes do ledger pela fatura (GET
 * /generation) na instância padrão. Os orquestradores chamam isto no fim da
 * run, antes da escrita terminal (ver `OpenRouterGateway.reconcilePending`).
 */
export function reconcilePendingGenerations(
  ledger: ReconcilableLedger,
  apiKey: string,
  opts?: Parameters<OpenRouterGateway['reconcilePending']>[2],
): Promise<NonNullable<CostLedgerSummary['reconciliation']>> {
  return defaultGateway.reconcilePending(ledger, apiKey, opts);
}

/**
 * Conciliação do FIM DE RUN (os dois orquestradores): poucas tentativas
 * curtas; o que seguir sem resposta — falha de rede OU 404 (a geração pode
 * ainda não estar indexada: as últimas chamadas têm segundos de idade) — fica
 * PENDENTE no record (`costLedger.pendingEntries`, conciliável depois), nunca
 * vira a reserva conservadora em definitivo. Nunca lança: falha aqui não pode
 * transformar uma run concluída em erro.
 */
export const RUN_END_RECONCILE = { attempts: 3, baseDelayMs: 500, concurrency: 4, notFoundAsPending: true } as const;

export async function reconcileAtRunEnd(ledger: ReconcilableLedger, apiKey: string): Promise<void> {
  if (ledger.pendingEntries().length === 0) return;
  await reconcilePendingGenerations(ledger, apiKey, RUN_END_RECONCILE).catch(() => undefined);
}
