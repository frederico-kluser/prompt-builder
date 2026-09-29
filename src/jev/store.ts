// Modo JEV — persistência NODE (CLI/MCP) de runs e sessões em
// `<data-dir>/jev-runs/<id>.json` e `<data-dir>/jev-sessions/<id>.json`.
// Fora do motor (usa fs) e fora de `storage.ts` (mirror de outro time): só usa
// as primitivas dele — raiz do data-dir, diretórios 0700, arquivos 0600 por
// escrita atômica — e a validação/contenção de ids de `pathSafety.ts`.
//
// Órfãs (crítica A3.3): o record leva o DONO (pid/host/token de início). Um
// CLI morto deixaria a run `running` para sempre; ao carregar, record `running`
// de dono MORTO nesta máquina vira `aborted` (com o parcial que já estava lá).

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDataDir, writePrivateDataFile } from '../storage.js';
import { assertValidRecordId, isValidRecordId, readFileInside } from '../pathSafety.js';
import { currentOwner, isOwnerAlive } from '../procOwner.js';
import type { JevOwner, JevRunRecord, JevSessionRecord } from '../engine/jev/types.js';

export const JEV_RUNS_DIR = 'jev-runs';
export const JEV_SESSIONS_DIR = 'jev-sessions';

export function jevRunsDir(): string {
  return path.join(getDataDir(), JEV_RUNS_DIR);
}

export function jevSessionsDir(): string {
  return path.join(getDataDir(), JEV_SESSIONS_DIR);
}

/** O dono "este processo" no formato do record. */
export function jevOwner(): JevOwner {
  const o = currentOwner();
  return { pid: o.pid, host: o.host, startToken: o.startToken };
}

/** Dono morto NESTA máquina? (outro host: sem como saber — não mexe). */
function donoMorto(owner: JevOwner | undefined): boolean {
  if (!owner || owner.host !== os.hostname()) return false;
  if (owner.pid === process.pid) return false;
  return !isOwnerAlive(owner, Number.POSITIVE_INFINITY);
}

// Escritas serializadas por id: o save com throttle do runner e o save final
// não podem chegar fora de ordem ao disco.
const filas = new Map<string, Promise<void>>();

async function gravar(dir: string, id: string, data: unknown): Promise<void> {
  assertValidRecordId(id, 'id de run JEV');
  const alvo = path.join(dir, `${id}.json`);
  const anterior = filas.get(alvo) ?? Promise.resolve();
  const job = anterior.catch(() => undefined).then(() => writePrivateDataFile(alvo, JSON.stringify(data)));
  filas.set(alvo, job);
  try {
    await job;
  } finally {
    if (filas.get(alvo) === job) filas.delete(alvo);
  }
}

async function ler<T>(dir: string, id: string): Promise<T | null> {
  if (!isValidRecordId(id)) return null;
  try {
    return JSON.parse(await readFileInside(dir, `${id}.json`)) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveJevRun(rec: JevRunRecord): Promise<void> {
  await gravar(jevRunsDir(), rec.id, rec);
}

export async function saveJevSession(rec: JevSessionRecord): Promise<void> {
  await gravar(jevSessionsDir(), rec.id, rec);
}

/** Carrega a run; `running` de dono morto vira `aborted` (e é regravada). */
export async function loadJevRun(id: string): Promise<JevRunRecord | null> {
  const rec = await ler<JevRunRecord>(jevRunsDir(), id);
  if (rec && rec.format === 'jev-run@1' && rec.status === 'running' && donoMorto(rec.owner)) {
    rec.status = 'aborted';
    rec.stoppedReason = 'cancelled';
    rec.error = 'processo dono morreu com a run em andamento (órfã): parcial preservado.';
    rec.finishedAt = rec.finishedAt ?? new Date().toISOString();
    await saveJevRun(rec).catch(() => undefined);
  }
  return rec && rec.format === 'jev-run@1' ? rec : null;
}

export async function loadJevSession(id: string): Promise<JevSessionRecord | null> {
  const rec = await ler<JevSessionRecord>(jevSessionsDir(), id);
  if (rec && rec.format === 'jev-session@1' && rec.status === 'running' && donoMorto(rec.owner)) {
    rec.status = 'aborted';
    rec.stoppedReason = 'cancelled';
    rec.error = 'processo dono morreu com a sessão em andamento (órfã).';
    rec.finishedAt = rec.finishedAt ?? new Date().toISOString();
    await saveJevSession(rec).catch(() => undefined);
  }
  return rec && rec.format === 'jev-session@1' ? rec : null;
}

export interface JevListItem {
  kind: 'run' | 'session';
  id: string;
  status: string;
  mode: string;
  theme: string;
  startedAt: string;
  totalCostUsd: number;
  sessionId?: string;
}

async function listar(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter(isValidRecordId);
  } catch {
    return [];
  }
}

/** Runs e/ou sessões, mais recentes primeiro (resumo: sem células nem estados). */
export async function listJevRecords(kind: 'run' | 'session' | 'all' = 'all'): Promise<JevListItem[]> {
  const out: JevListItem[] = [];
  if (kind !== 'session') {
    for (const id of await listar(jevRunsDir())) {
      const r = await loadJevRun(id).catch(() => null);
      if (!r) continue;
      out.push({
        kind: 'run',
        id: r.id,
        status: r.status,
        mode: r.mode,
        theme: r.theme,
        startedAt: r.startedAt,
        totalCostUsd: r.totalCostUsd,
        ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      });
    }
  }
  if (kind !== 'run') {
    for (const id of await listar(jevSessionsDir())) {
      const s = await loadJevSession(id).catch(() => null);
      if (!s) continue;
      out.push({ kind: 'session', id: s.id, status: s.status, mode: 'train', theme: s.theme, startedAt: s.startedAt, totalCostUsd: s.totalCostUsd });
    }
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

/** Run OU sessão pelo id. */
export async function findJevRecord(id: string): Promise<{ kind: 'run'; rec: JevRunRecord } | { kind: 'session'; rec: JevSessionRecord } | null> {
  const r = await loadJevRun(id);
  if (r) return { kind: 'run', rec: r };
  const s = await loadJevSession(id);
  return s ? { kind: 'session', rec: s } : null;
}

/** As runs de uma sessão (para o relatório de ciclos). */
export async function loadJevSessionRuns(s: JevSessionRecord): Promise<JevRunRecord[]> {
  const out: JevRunRecord[] = [];
  for (const id of s.runIds) {
    const r = await loadJevRun(id).catch(() => null);
    if (r) out.push(r);
  }
  return out;
}
