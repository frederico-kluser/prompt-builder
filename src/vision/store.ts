// BENCHMARK DE VISÃO — persistência NODE dos records em
// `<data-dir>/vision-runs/<id>.json`.
//
// Só records TERMINAIS são gravados (a run de visão é síncrona e curta): um
// processo morto no meio não deixa registro `running` órfão para ninguém
// interpretar como "ainda rodando". O parcial por orçamento/cancelamento É
// gravado pelo runner no `finally` — com `status` terminal — porque aí o
// resultado tem valor (e o gasto já aconteceu).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getDataDir, writePrivateDataFile } from '../storage.js';
import { assertValidRecordId, isValidRecordId, readFileInside } from '../pathSafety.js';
import type { VisionRunRecord } from '../engine/vision/types.js';

export const VISION_RUNS_DIR = 'vision-runs';

export function visionRunsDir(): string {
  return path.join(getDataDir(), VISION_RUNS_DIR);
}

/** Gravação serializada por id (o runner pode salvar o parcial e o final). */
const filas = new Map<string, Promise<void>>();

export async function saveVisionRun(rec: VisionRunRecord): Promise<void> {
  assertValidRecordId(rec.id, 'id de run de visão');
  const alvo = path.join(visionRunsDir(), `${rec.id}.json`);
  const anterior = filas.get(alvo) ?? Promise.resolve();
  const job = anterior
    .catch(() => undefined)
    .then(() => writePrivateDataFile(alvo, JSON.stringify(rec)));
  filas.set(alvo, job);
  try {
    await job;
  } finally {
    if (filas.get(alvo) === job) filas.delete(alvo);
  }
}

export async function loadVisionRun(id: string): Promise<VisionRunRecord | null> {
  if (!isValidRecordId(id)) return null;
  try {
    const texto = await readFileInside(visionRunsDir(), `${id}.json`);
    return JSON.parse(texto) as VisionRunRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Resumo de um record para `vision list` (sem as células). */
export interface VisionRunSummary {
  id: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  datasetVersion: string;
  benchmark?: string;
  provider?: string;
  scenes: number;
  models: string[];
  calls: number;
  costUsd: number;
  /** Melhor nota de manchete da run. */
  bestScore: number;
  bestModel: string | null;
}

export function summarizeVisionRun(rec: VisionRunRecord): VisionRunSummary {
  const ordenados = [...rec.contestants].sort((a, b) => b.score - a.score);
  const melhor = ordenados[0];
  return {
    id: rec.id,
    status: rec.status,
    startedAt: rec.startedAt,
    ...(rec.finishedAt ? { finishedAt: rec.finishedAt } : {}),
    datasetVersion: rec.dataset.version,
    ...(rec.benchmark ? { benchmark: rec.benchmark } : {}),
    ...(rec.config.provider ? { provider: rec.config.provider } : {}),
    scenes: rec.dataset.scenes.length,
    models: rec.contestants.map((c) => c.modelId),
    calls: rec.totals.calls,
    costUsd: rec.totals.costUsd,
    bestScore: melhor?.score ?? 0,
    bestModel: melhor?.modelId ?? null,
  };
}

/** Lista os records do mais novo para o mais antigo (ids inválidos são pulados). */
export async function listVisionRuns(): Promise<VisionRunSummary[]> {
  const dir = visionRunsDir();
  let arquivos: string[];
  try {
    arquivos = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const resumos: VisionRunSummary[] = [];
  for (const nome of arquivos) {
    if (!nome.endsWith('.json')) continue;
    const id = nome.slice(0, -'.json'.length);
    if (!isValidRecordId(id)) continue;
    const rec = await loadVisionRun(id);
    if (!rec || rec.format !== 'vision-run@1') continue;
    resumos.push(summarizeVisionRun(rec));
  }
  return resumos.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}
