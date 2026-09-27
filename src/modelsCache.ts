// Cache do catalogo de modelos EM DISCO.
//
// O cache de `openrouter.ts` e um Map de processo (TTL 24h). Num servidor isso
// basta; num CLI cada invocacao e um processo NOVO, entao o cache nasce sempre
// frio — e cache frio tem tres consequencias silenciosas:
//   - `deterministicSampling` cai na heuristica por nome do modelo;
//   - `applyReasoning` perde a allowlist de esforco → HTTP 400 nos 83 modelos
//     que declaram `supported_efforts`;
//   - `computeCost` devolve 0, o que faria uma porta de orcamento concluir que
//     tudo e de graca.
//
// Este modulo persiste o catalogo e o injeta de volta via `primeModelsCache`.

import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { getGateway, listModels, primeModelsCache } from './openrouter.js';
import { isKnownPrice } from './engine/pricing.js';
import { getDataDir } from './storage.js';
import type { OpenRouterModel, OpenRouterModelPricing } from './types.js';

/**
 * v2 (IMPL-018): preco desconhecido e `null`. Um arquivo v1 ainda e LIDO (o
 * modo offline depende dele), mas passa por `sanitizePricing`: no v1 o "-1"
 * dos roteadores foi gravado como -1 numerico.
 */
const CACHE_VERSION = 2;
const READABLE_VERSIONS = new Set([1, CACHE_VERSION]);

/** Preco negativo/nao finito vindo do disco vira desconhecido (nunca -1). */
function sanitizePricing(p: OpenRouterModelPricing | undefined): OpenRouterModelPricing {
  const fix = (v: unknown): number | null => (isKnownPrice(v as number | null) ? (v as number) : null);
  return {
    prompt: fix(p?.prompt),
    completion: fix(p?.completion),
    ...(p?.overrides
      ? {
          overrides: p.overrides.map((t) => ({
            minPromptTokens: t.minPromptTokens,
            prompt: fix(t.prompt),
            completion: fix(t.completion),
          })),
        }
      : {}),
  };
}
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface CatalogFile {
  v: number;
  fetchedAt: number;
  /** Base URL em vigor — um proxy diferente nao pode servir catalogo errado. */
  base: string;
  count: number;
  data: OpenRouterModel[];
}

/** Base em vigor NO GATEWAY (configurado pelo ponto de entrada a partir do ambiente). */
function baseUrl(): string {
  return getGateway().config.baseUrl;
}

/**
 * Nome do arquivo por HASH da key. Nao use `apiKey.slice(-12)` (a chave do cache
 * em memoria): isso poria 12 caracteres de um segredo vivo num caminho que
 * qualquer `ls` — ou qualquer processo da maquina — consegue ler.
 */
export function catalogPath(apiKey: string): string {
  const h = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  return path.join(getDataDir(), 'cache', `models-${h}.json`);
}

async function readCatalog(apiKey: string): Promise<CatalogFile | null> {
  try {
    const raw = await fs.readFile(catalogPath(apiKey), 'utf-8');
    const parsed = JSON.parse(raw) as CatalogFile;
    if (!READABLE_VERSIONS.has(parsed.v)) return null;
    if (parsed.base !== baseUrl()) return null;
    if (!Array.isArray(parsed.data) || parsed.data.length === 0) return null;
    return { ...parsed, data: parsed.data.map((m) => ({ ...m, pricing: sanitizePricing(m.pricing) })) };
  } catch {
    return null;
  }
}

async function writeCatalog(apiKey: string, data: OpenRouterModel[]): Promise<void> {
  const target = catalogPath(apiKey);
  const dir = path.dirname(target);
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // `raw` e o payload cru do OpenRouter e nada em src/ o le — manter
    // persistiria megabytes por invocacao.
    const enxuto = data.map(({ raw: _raw, ...rest }) => rest);
    const file: CatalogFile = {
      v: CACHE_VERSION,
      fetchedAt: Date.now(),
      base: baseUrl(),
      count: enxuto.length,
      data: enxuto,
    };
    const tmp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(file), { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmp, target);
  } catch {
    // cache e otimizacao: falha de escrita nunca derruba o comando
  }
}

export interface EnsureCatalogResult {
  models: OpenRouterModel[];
  fetchedAt: number;
  source: 'disk' | 'network' | 'stale';
}

/**
 * Garante um catalogo quente (memoria + disco). Com a rede fora e um cache
 * vencido em disco, usa o vencido e avisa: um agente nao deve travar por um
 * solucco do OpenRouter, e isso faz `models list` funcionar offline.
 */
export async function ensureCatalog(
  apiKey: string,
  opts: { force?: boolean; ttlMs?: number; onWarn?: (msg: string) => void } = {},
): Promise<EnsureCatalogResult> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const disk = await readCatalog(apiKey);
  const fresco = disk && Date.now() - disk.fetchedAt < ttl;

  if (!opts.force && disk && fresco) {
    primeModelsCache(apiKey, disk.data, disk.fetchedAt);
    return { models: disk.data, fetchedAt: disk.fetchedAt, source: 'disk' };
  }

  try {
    const data = await listModels(apiKey, true);
    await writeCatalog(apiKey, data);
    // Validacao do /models (IMPL-018): so os fail-closed viram alerta — o "-1"
    // dos roteadores e esperado e nao gera ruido.
    const graves = getGateway()
      .catalogIssues(apiKey)
      .filter((i) => i.severity === 'error');
    if (graves.length > 0) {
      const amostra = graves
        .slice(0, 3)
        .map((i) => `${i.modelId} ${i.field}`)
        .join('; ');
      opts.onWarn?.(
        `catálogo: ${graves.length} campo(s) contratual(is) malformado(s) — tratados em fail-closed (${amostra}${graves.length > 3 ? '; …' : ''}).`,
      );
    }
    return { models: data, fetchedAt: Date.now(), source: 'network' };
  } catch (err) {
    if (disk) {
      primeModelsCache(apiKey, disk.data, disk.fetchedAt);
      const horas = Math.round((Date.now() - disk.fetchedAt) / 3_600_000);
      opts.onWarn?.(
        `catálogo offline (${(err as Error).message}); usando cache de ${horas}h atrás.`,
      );
      return { models: disk.data, fetchedAt: disk.fetchedAt, source: 'stale' };
    }
    throw err;
  }
}

export async function clearCatalog(apiKey: string): Promise<void> {
  await fs.rm(catalogPath(apiKey), { force: true }).catch(() => undefined);
}
