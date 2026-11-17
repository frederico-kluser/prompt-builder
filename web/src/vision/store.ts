// Benchmark de visão — persistência do NAVEGADOR (IndexedDB v4:
// `visionRuns`, `visionSummaries`). É o espelho de `src/vision/store.ts` com o
// seam trocado: o motor (`src/engine/vision/`, via shim) nunca sabe onde grava.
//
// Mesmas regras de `web/src/jev/store.ts`: record + resumo na MESMA transação,
// gravar NUNCA rejeita (falha vira aviso em `storageHealth`), leitura degrada
// para vazio.

import { idbDelete, idbGet, idbGetAll, idbWrite } from '../idb';
import { reportWriteFailure, reportWriteSuccess } from '../storageHealth';
import type { VisionRunRecord } from '../engine/vision';

/** Uma linha do histórico de visão (o que a lista lê sem abrir o record). */
export interface VisionSummary {
  id: string;
  status: VisionRunRecord['status'];
  startedAt: string;
  finishedAt?: string;
  datasetVersion: string;
  scenes: number;
  models: string[];
  calls: number;
  errors: number;
  skipped: number;
  costUsd: number;
  bestScore: number;
  bestModel: string | null;
  promptVersion: string;
}

export function visionRunSummary(rec: VisionRunRecord): VisionSummary {
  const melhor = [...rec.contestants].sort(
    (a, b) => b.score - a.score || (b.map?.f1 ?? 0) - (a.map?.f1 ?? 0) || a.modelId.localeCompare(b.modelId),
  )[0];
  return {
    id: rec.id,
    status: rec.status,
    startedAt: rec.startedAt,
    ...(rec.finishedAt ? { finishedAt: rec.finishedAt } : {}),
    datasetVersion: rec.dataset.version,
    scenes: rec.dataset.scenes.length,
    models: rec.contestants.map((c) => c.modelId),
    calls: rec.totals.calls,
    errors: rec.totals.errors,
    skipped: rec.totals.skipped,
    costUsd: rec.totals.costUsd,
    bestScore: melhor?.score ?? 0,
    bestModel: melhor?.modelId ?? null,
    promptVersion: rec.promptVersion,
  };
}

/** Grava record + resumo numa transação só. Nunca rejeita (ver topo). */
export async function saveVisionRun(rec: VisionRunRecord): Promise<boolean> {
  try {
    await idbWrite(
      [
        { store: 'visionRuns', put: rec as unknown as { id: string } },
        { store: 'visionSummaries', put: visionRunSummary(rec) },
      ],
      { durability: 'strict' },
    );
  } catch (err) {
    const { issue, isNew } = reportWriteFailure('run', rec.id, err);
    if (isNew) console.warn(`[visão] run ${rec.id} NÃO foi salva no navegador: ${issue.error}`);
    return false;
  }
  reportWriteSuccess('run', rec.id);
  return true;
}

export async function loadVisionRun(id: string): Promise<VisionRunRecord | null> {
  const rec = await idbGet<VisionRunRecord>('visionRuns', id);
  return rec && rec.format === 'vision-run@1' ? rec : null;
}

/** Histórico de visão, mais recentes primeiro (leitura degrada para vazio). */
export async function listVisionSummaries(): Promise<VisionSummary[]> {
  const rows = await idbGetAll<VisionSummary>('visionSummaries');
  return rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

export async function deleteVisionRun(id: string): Promise<void> {
  await idbDelete('visionRuns', id).catch(() => undefined);
  await idbDelete('visionSummaries', id).catch(() => undefined);
}
