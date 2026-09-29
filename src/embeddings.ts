// Embedder de produção do dedup semântico de cenários (IMPL-063, R-05:DEC-4).
//
// Antes o dedup (src/dedup.ts) tinha a camada semântica — cosseno sobre o PAR
// (pergunta + contexto) com veto de entidade — mas NENHUM `EmbedFn` real: o
// único caminho de produção nunca passava `dedup.embed`, então a recuperação de
// paráfrase em run real era 0 (os ≥0,9 só valiam com os vetores falsos do
// teste). Aqui mora o transporte: POST /embeddings do OpenRouter pelo MESMO
// gateway do chat (`meteredInputCall`) — cascata de dado pessoal, limitador
// AIMD, reserva/cobrança no ledger com role + sink e custo MEDIDO por
// `usage.cost` (sem usage = pendente/conservador, nunca zero). Nada de fetch
// por fora (AGENTS.md).
//
// ⚠️ Escopo: DEDUP DE CENÁRIOS do datagen. O veto do IMPL-116 (R-08:REC-6)
// proíbe REUSAR VEREDITO por parecença — este módulo nunca entra no caminho de
// avaliação (juízes/duelos/orquestrador); o datagen é quem o importa.
//
// Módulo sem Node (entra no bundle do navegador via datagen): nada de `node:*`
// nem `process.env`.

import { meteredInputCall } from './openrouter.js';
import type { EmbedFn } from './dedup.js';
import type { CostRole, RunCtx } from './types.js';

/** Modelo default de representação (barato; 1536 dims). Troque por config. */
export const DEFAULT_DEDUP_EMBED_MODEL = 'openai/text-embedding-3-small';

/** Textos por pedido: lotes grandes estouram o limite de entrada do provedor. */
export const EMBED_BATCH_SIZE = 64;

/** Caminho do ponto de representação na API do OpenRouter (relativo à base). */
export const EMBEDDINGS_PATH = 'embeddings';

export interface OpenRouterEmbedderOptions {
  apiKey: string;
  /** Modelo de representação (default `DEFAULT_DEDUP_EMBED_MODEL`). */
  modelId?: string;
  /** Sinal de abort + ledger da run: o custo entra no papel `role`. */
  ctx?: RunCtx;
  /** Papel no ledger (default 'datagen': o dedup é parte da geração). */
  role?: CostRole;
  timeoutMs?: number;
  /** Tamanho do lote por pedido (default `EMBED_BATCH_SIZE`). */
  batchSize?: number;
}

/** Lê `data[].embedding` na ordem de `index` (o provedor pode reordenar). */
export function parseEmbeddingsPayload(raw: unknown, expected: number): number[][] {
  const data = (raw as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error('Resposta de embeddings sem `data`.');
  const out: number[][] = new Array(expected);
  data.forEach((item, pos) => {
    const it = item as { index?: unknown; embedding?: unknown };
    const i = typeof it?.index === 'number' && Number.isInteger(it.index) ? it.index : pos;
    const vec = it?.embedding;
    if (!Array.isArray(vec) || vec.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error(`Embedding inválido na posição ${i}.`);
    }
    if (i >= 0 && i < expected) out[i] = vec as number[];
  });
  for (let i = 0; i < expected; i += 1) {
    if (!out[i]) throw new Error(`Resposta de embeddings incompleta: faltou o item ${i} de ${expected}.`);
  }
  return out;
}

/**
 * `EmbedFn` do OpenRouter para `dedupeSemantic`. Lotes em série dentro de uma
 * chamada do embedder (o limitador global gateia a concorrência entre runs).
 * Falha (HTTP/rede/resposta malformada) LANÇA — quem chama (`generateStages`)
 * degrada para a passe exata com aviso e registro no relatório; orçamento/
 * cancelamento e 401/402 sobem.
 */
export function createOpenRouterEmbedder(opts: OpenRouterEmbedderOptions): EmbedFn {
  const modelId = opts.modelId?.trim() || DEFAULT_DEDUP_EMBED_MODEL;
  const role: CostRole = opts.role ?? 'datagen';
  const tamanho = Math.max(1, Math.floor(opts.batchSize ?? EMBED_BATCH_SIZE));
  return async (texts: string[]): Promise<number[][]> => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += tamanho) {
      const lote = texts.slice(i, i + tamanho);
      const res = await meteredInputCall({
        apiKey: opts.apiKey,
        modelId,
        path: EMBEDDINGS_PATH,
        input: lote,
        role,
        ...(opts.ctx?.sink ? { sink: opts.ctx.sink } : {}),
        ...(opts.ctx?.signal ? { signal: opts.ctx.signal } : {}),
        ...(typeof opts.timeoutMs === 'number' ? { timeoutMs: opts.timeoutMs } : {}),
      });
      out.push(...parseEmbeddingsPayload(res.raw, lote.length));
    }
    return out;
  };
}
