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
import { ensurePrivateDataDir, getDataDir } from './storage.js';
import type { OpenRouterModel } from './types.js';

const CACHE_VERSION = 1;
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
    if (parsed.v !== CACHE_VERSION) return null;
    if (parsed.base !== baseUrl()) return null;
    if (!Array.isArray(parsed.data) || parsed.data.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCatalog(apiKey: string, data: OpenRouterModel[]): Promise<void> {
  const target = catalogPath(apiKey);
  const dir = path.dirname(target);
  try {
    // IMPL-024: raiz + cache/ em 0700 com chmod explícito (mkdir({mode}) só vale
    // na criação — um cache/ antigo 0755 seguiria aberto).
    await ensurePrivateDataDir(dir);
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
