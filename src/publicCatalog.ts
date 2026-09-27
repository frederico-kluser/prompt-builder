// Catálogo PÚBLICO do OpenRouter (GET /models, sem key) com cache em disco de
// 24 h — só Node (IMPL-019).
//
// Por que não reusar `modelsCache.ensureCatalog`: aquele é por KEY (o cache é
// nomeado pelo hash dela) e o CLI o aquece junto com a validação da key. Os
// dois consumidores daqui rodam em CI, SEM key nenhuma — e não devem ter uma:
//   • `prompt-builder baseline check` (gate de re-baseline do juiz/gabarito);
//   • `scripts/check-model-ids.ts` (job semanal que confere ids citados nas docs).
// `/models` é público e gratuito (AGENTS.md), então o gate não custa crédito.
//
// `--catalog <arquivo>` (um snapshot salvo de /models) substitui a rede: deixa
// o gate reprodutível/offline e é o que os testes usam.

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_OPENROUTER_BASE_URL, parseModelsPayload, type FetchLike } from './openrouter.js';
import type { OpenRouterModel } from './types.js';

const CACHE_VERSION = 1;
export const PUBLIC_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

interface CacheFile {
  v: number;
  fetchedAt: number;
  base: string;
  data: OpenRouterModel[];
}

export interface PublicCatalogOptions {
  /** Arquivo de cache (ausente = sem cache em disco). */
  cachePath?: string;
  ttlMs?: number;
  /** Ignora o cache fresco e busca de novo. */
  force?: boolean;
  baseUrl?: string;
  fetch?: FetchLike;
  now?: () => number;
  onWarn?: (msg: string) => void;
}

export interface PublicCatalogResult {
  models: OpenRouterModel[];
  fetchedAt: number;
  source: 'file' | 'disk' | 'network' | 'stale';
}

function sanitize(data: OpenRouterModel[]): OpenRouterModel[] {
  // `raw` é o payload cru inteiro — persistir multiplicaria o cache por ~10×.
  return data.map(({ raw: _raw, ...rest }) => rest);
}

/**
 * Lê um snapshot de catálogo salvo em arquivo: o payload cru de GET /models
 * (`{ "data": [...] }`, ex.: `curl https://openrouter.ai/api/v1/models`).
 * Lança Error PT-BR se o arquivo não servir.
 */
export async function loadCatalogFile(file: string): Promise<OpenRouterModel[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch {
    throw new Error(`não consegui ler o catálogo "${file}".`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`"${file}" não é um JSON válido: ${(err as Error).message}`);
  }
  const models = parseModelsPayload(json);
  if (!models.length) {
    throw new Error(`"${file}" não tem modelos: esperado o payload de GET /models ({ "data": [...] }).`);
  }
  return sanitize(models);
}

async function readCache(file: string, base: string): Promise<CacheFile | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as CacheFile;
    if (parsed.v !== CACHE_VERSION || parsed.base !== base) return null;
    if (!Array.isArray(parsed.data) || !parsed.data.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(target: string, content: CacheFile): Promise<void> {
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(content), 'utf-8');
    await fs.rename(tmp, target);
  } catch {
    // cache é otimização: falha de escrita nunca derruba o gate
  }
}

/**
 * Catálogo público com cache de 24 h. Rede fora + cache vencido ⇒ usa o
 * vencido e avisa (`stale`); rede fora sem cache ⇒ lança (quem chama decide o
 * exit code — o gate é fail-closed).
 */
export async function loadPublicCatalog(opts: PublicCatalogOptions = {}): Promise<PublicCatalogResult> {
  const base = (opts.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, '');
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? PUBLIC_CATALOG_TTL_MS;
  const cache = opts.cachePath ? await readCache(opts.cachePath, base) : null;
  if (!opts.force && cache && now() - cache.fetchedAt < ttl) {
    return { models: cache.data, fetchedAt: cache.fetchedAt, source: 'disk' };
  }
  try {
    // Copiado para variável local: nunca chamar `opts.fetch(...)` como método.
    const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const res = await doFetch(`${base}/models`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GET /models respondeu ${res.status}`);
    const models = sanitize(parseModelsPayload(await res.json()));
    if (!models.length) throw new Error('GET /models veio vazio');
    const fetchedAt = now();
    if (opts.cachePath) await writeCache(opts.cachePath, { v: CACHE_VERSION, fetchedAt, base, data: models });
    return { models, fetchedAt, source: 'network' };
  } catch (err) {
    if (cache) {
      const horas = Math.round((now() - cache.fetchedAt) / 3_600_000);
      opts.onWarn?.(`catálogo offline (${(err as Error).message}); usando cache de ${horas}h atrás.`);
      return { models: cache.data, fetchedAt: cache.fetchedAt, source: 'stale' };
    }
    throw err;
  }
}
