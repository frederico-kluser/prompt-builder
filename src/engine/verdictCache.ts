// IMPL-080 (R-08:REC-3) — cache EXATO de vereditos, com TTL, carry entre
// iterações e re-teste amostral OBRIGATÓRIO.
//
// O problema: o treino roda a MESMA run de controle a cada iteração,
// re-gerando e re-julgando itens idênticos — custo multiplicado por iteração e
// o não-determinismo do provedor escondido no meio. Este módulo é a política
// PURA do cache (sem rede, sem Node — roda no navegador também):
//
//   • chave = hash de {modelo + esforço + temperatura + max_tokens +
//     hash do contrato do juiz + texto completo do prompt} (padrão DSPy/
//     promptfoo). Credenciais ficam FORA da chave, sempre;
//   • TTL + carry: a entrada vive enquanto a sessão iterar (reuso entre
//     iterações idênticas);
//   • re-teste amostral (~10% dos itens em cache por sessão) re-julga de
//     verdade e compara o veredito: acima do limiar de discordância o cache
//     INTEIRO é invalidado (o não-determinismo do provedor não pode ficar
//     escondido — o re-teste é obrigatório, nunca opcional);
//   • contadores cache_hits/cache_total por sessão (sobem para o ledger/evento
//     pelo gateway).
//
// ⚠️ Cache SEMÂNTICO (similaridade de embeddings) para julgamento continua
// VETADO (R-08:REC-6): só igualdade EXATA de requisição reusa veredito.

import { canonicalJson, sha256Hex } from './hash.js';

/** TTL padrão da entrada (carry entre iterações da mesma sessão). */
export const VERDICT_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
/** Fração de itens em cache re-julgada de verdade por sessão (amostra OBRIGATÓRIA). */
export const VERDICT_CACHE_RETEST_RATE = 0.1;
/** Limiar de discordância no re-teste: acima disto o cache inteiro cai. */
export const VERDICT_CACHE_DISAGREEMENT_LIMIT = 0.1;

export interface VerdictCacheKeyFields {
  modelId: string;
  /** Degrau de esforço pedido (reasoningLevel). Ausente = default do provedor. */
  effort?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  /** Hash do contrato do juiz (mensagens de sistema + response_format/schema). */
  contractHash: string;
  /** Texto COMPLETO do prompt (todas as mensagens, como foram montadas). */
  promptText: string;
}

/**
 * Chave do cache: SHA-256 do JSON canônico dos campos da requisição.
 * `apiKey`/credenciais entram de PROPÓSITO nenhum (R-08:REC-3): a chave
 * identifica a PERGUNTA feita ao modelo, não a conta que pagou. A identidade
 * por conteúdo usa o hash do texto completo (guardado só como hash — o prompt
 * pode conter dado pessoal e não fica em claro em mais lado nenhum).
 */
export function verdictCacheKey(fields: VerdictCacheKeyFields): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      modelId: fields.modelId,
      effort: fields.effort ?? null,
      temperature: fields.temperature ?? null,
      maxTokens: fields.maxTokens ?? null,
      contractHash: fields.contractHash,
      promptHash: sha256Hex(fields.promptText),
    }),
  );
}

/**
 * Hash do contrato do juiz: mensagens de sistema + o formato da saída. É a
 * parte "fixa" do julgamento (rubrica/contrato/schema) — muda o contrato,
 * muda a chave (o veredito antigo não serve mais).
 */
export function judgeContractHash(input: {
  systemTexts: string[];
  responseSchemaName?: string | null;
  responseSchema?: unknown;
  responseFormatJson?: boolean | null;
}): string {
  return sha256Hex(
    canonicalJson({
      system: input.systemTexts,
      schemaName: input.responseSchemaName ?? null,
      schema: input.responseSchema ?? null,
      json: input.responseFormatJson ?? null,
    }),
  );
}

/**
 * Rótulo do veredito para COMPARAR no re-teste: o campo `verdict` do JSON do
 * juiz ("resolve" | "parcial" | "nao"); sem JSON parseável, o texto
 * normalizado (comparação exata — nada de similaridade semântica aqui).
 */
export function verdictLabelOf(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const v = parsed?.verdict;
    if (typeof v === 'string' && v.trim()) return v.trim().toLowerCase();
  } catch {
    /* sem JSON: compara o texto */
  }
  return text.trim().replace(/\s+/g, ' ');
}

export interface VerdictCacheEntry {
  /** Texto da resposta (já reidratada — o mesmo que o papel recebeu). */
  text: string;
  finishReason?: string;
  nativeFinishReason?: string;
  refusal?: string;
  truncated?: boolean;
  /** Quando foi guardada (ms desde epoch). */
  storedAt: number;
  /** Sorteada para o re-teste amostral desta sessão (~10%). */
  retest: boolean;
  /** Já re-testada nesta sessão (não re-testa duas vezes). */
  retested: boolean;
}

export type NewVerdictCacheEntry = Pick<
  VerdictCacheEntry,
  'text' | 'finishReason' | 'nativeFinishReason' | 'refusal' | 'truncated'
>;

export interface VerdictCacheOptions {
  /** TTL da entrada, em ms. Default {@link VERDICT_CACHE_TTL_MS}. */
  ttlMs?: number;
  /** Fração de itens re-testada por sessão. Default {@link VERDICT_CACHE_RETEST_RATE}. */
  retestRate?: number;
  /** Limiar de discordância que invalida tudo. Default {@link VERDICT_CACHE_DISAGREEMENT_LIMIT}. */
  disagreementLimit?: number;
  /** Relógio injetável (testes). */
  now?: () => number;
  /** Sorteio injetável em [0, 1) (testes). */
  sample?: () => number;
}

export interface VerdictCacheStats {
  /** Lookups servidos do cache. */
  cacheHits: number;
  /** Lookups TOTAIS (hits + misses). */
  cacheTotal: number;
  /** Re-testes amostrais já executados. */
  retests: number;
  /** Re-testes cujo veredito divergiu do cache. */
  disagreements: number;
  /** Invalidações totais (acima do limiar de discordância). */
  invalidations: number;
  /** Entradas vivas. */
  size: number;
}

/** Resultado de um lookup: entrada + se ela pede re-teste amostral. */
export interface VerdictCacheLookup {
  entry: VerdictCacheEntry;
  /** true = serve o cache MAS re-julga de verdade por baixo (amostra). */
  retest: boolean;
}

export class VerdictCache {
  private readonly entries = new Map<string, VerdictCacheEntry>();
  private readonly ttlMs: number;
  private readonly retestRate: number;
  private readonly disagreementLimit: number;
  private readonly now: () => number;
  private readonly sample: () => number;
  private cacheHits = 0;
  private cacheTotal = 0;
  private retests = 0;
  private disagreements = 0;
  private invalidations = 0;

  constructor(opts: VerdictCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? VERDICT_CACHE_TTL_MS;
    this.retestRate = opts.retestRate ?? VERDICT_CACHE_RETEST_RATE;
    this.disagreementLimit = opts.disagreementLimit ?? VERDICT_CACHE_DISAGREEMENT_LIMIT;
    this.now = opts.now ?? Date.now;
    this.sample = opts.sample ?? Math.random;
  }

  /** Lookups totais/hits desta sessão. */
  stats(): VerdictCacheStats {
    return {
      cacheHits: this.cacheHits,
      cacheTotal: this.cacheTotal,
      retests: this.retests,
      disagreements: this.disagreements,
      invalidations: this.invalidations,
      size: this.entries.size,
    };
  }

  /**
   * Lookup EXATO. Conta `cache_total`/`cache_hits` e pede re-teste amostral na
   * primeira vez que um item sorteado volta a ser usado.
   */
  lookup(key: string): VerdictCacheLookup | undefined {
    this.cacheTotal += 1;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(key); // TTL vencido: não serve (carry só dentro do TTL).
      return undefined;
    }
    this.cacheHits += 1;
    const retest = entry.retest && !entry.retested;
    return { entry, retest };
  }

  /**
   * Guarda a resposta (carry entre iterações). A entrada nasce com o sorteio
   * do re-teste amostral da sessão (~{@link retestRate} dos itens).
   */
  store(key: string, entry: NewVerdictCacheEntry): VerdictCacheEntry {
    const full: VerdictCacheEntry = {
      ...entry,
      storedAt: this.now(),
      retest: this.sample() < this.retestRate,
      retested: false,
    };
    this.entries.set(key, full);
    return full;
  }

  /**
   * Re-teste amostral: o veredito REAL desta chamada contra o do cache.
   * Discordância conta; acima do limiar da sessão o cache INTEIRO é invalidado
   * (não-determinismo do provedor não fica escondido). O valor fresco substitui
   * a entrada (renova TTL) e já fica marcado como re-testado.
   */
  noteRetest(
    key: string,
    fresh: NewVerdictCacheEntry,
  ): { disagreement: boolean; invalidated: boolean } {
    this.retests += 1;
    const anterior = this.entries.get(key);
    const disagreement = anterior ? verdictLabelOf(anterior.text) !== verdictLabelOf(fresh.text) : false;
    if (disagreement) this.disagreements += 1;
    this.entries.set(key, {
      ...fresh,
      storedAt: this.now(),
      retest: false,
      retested: true,
    });
    const invalidated = this.disagreements / Math.max(1, this.retests) > this.disagreementLimit;
    if (invalidated) this.invalidateAll();
    return { disagreement, invalidated };
  }

  /** Invalidação total (o veredito do provedor não é estável o suficiente). */
  invalidateAll(): void {
    this.entries.clear();
    this.invalidations += 1;
  }

  /** Limpeza sem contagem (fim de sessão). */
  clear(): void {
    this.entries.clear();
  }
}