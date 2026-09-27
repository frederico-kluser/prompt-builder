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
import { getDataDir } from './storage.js';
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

/** Cache do catalogo PUBLICO (sem key — IMPL-029). */
const PUBLIC_FILE = 'models-public.json';

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
  // Sem key (IMPL-029): o catalogo PUBLICO (`GET /models` responde sem
  // Authorization) mora num arquivo proprio, legivel por nome.
  if (!apiKey) return path.join(getDataDir(), 'cache', PUBLIC_FILE);
  const h = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  return path.join(getDataDir(), 'cache', `models-${h}.json`);
}

async function readCatalogFile(file: string): Promise<CatalogFile | null> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as CatalogFile;
    if (parsed.v !== CACHE_VERSION) return null;
    if (parsed.base !== baseUrl()) return null;
    if (!Array.isArray(parsed.data) || parsed.data.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readCatalog(apiKey: string): Promise<CatalogFile | null> {
  return readCatalogFile(catalogPath(apiKey));
}

/**
 * Sem key: o catalogo em disco MAIS RECENTE de qualquer escopo (o publico ou o
 * de uma key usada antes). O `/models` nao depende da conta, entao o arquivo
 * de outra key serve para listar/estimar — e evita rede quando ha cache fresco
 * ("catalogo do cache em disco", R-12:REC-4). Com key, cada key segue no seu.
 */
async function readFreshestCatalog(): Promise<CatalogFile | null> {
  const dir = path.join(getDataDir(), 'cache');
  let nomes: string[];
  try {
    nomes = await fs.readdir(dir);
  } catch {
    return null;
  }
  let melhor: CatalogFile | null = null;
  for (const n of nomes) {
    if (!/^models-[\w-]+\.json$/.test(n)) continue;
    const c = await readCatalogFile(path.join(dir, n));
    if (c && (!melhor || c.fetchedAt > melhor.fetchedAt)) melhor = c;
  }
  return melhor;
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
  /** `key` = catalogo da key informada; `public` = sem key (GET /models publico). */
  scope: 'key' | 'public';
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
  // Key vazia = catalogo PUBLICO (IMPL-029): `models`/`estimate`/`--dry-run`
  // nao exigem key. O `GET /models` e publico e gratuito, entao sem cache em
  // disco ele e buscado sem credencial.
  const scope: EnsureCatalogResult['scope'] = apiKey ? 'key' : 'public';
  const disk = apiKey ? await readCatalog(apiKey) : await readFreshestCatalog();
  const fresco = disk && Date.now() - disk.fetchedAt < ttl;

  if (!opts.force && disk && fresco) {
    primeModelsCache(apiKey, disk.data, disk.fetchedAt);
    return { models: disk.data, fetchedAt: disk.fetchedAt, source: 'disk', scope };
  }

  try {
    const data = await listModels(apiKey, true);
    await writeCatalog(apiKey, data);
    return { models: data, fetchedAt: Date.now(), source: 'network', scope };
  } catch (err) {
    if (disk) {
      primeModelsCache(apiKey, disk.data, disk.fetchedAt);
      const horas = Math.round((Date.now() - disk.fetchedAt) / 3_600_000);
      opts.onWarn?.(
        `catálogo offline (${(err as Error).message}); usando cache de ${horas}h atrás.`,
      );
      return { models: disk.data, fetchedAt: disk.fetchedAt, source: 'stale', scope };
    }
    throw err;
  }
}

export async function clearCatalog(apiKey: string): Promise<void> {
  await fs.rm(catalogPath(apiKey), { force: true }).catch(() => undefined);
}
