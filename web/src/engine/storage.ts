// Versão BROWSER da persistência (substitui o filesystem do Node por IndexedDB).
// O orchestrator/trainer chamam saveRun/saveSession; a UI lê via load/list.
// Mesma assinatura do storage do backend (mirror de src/storage.ts), então o
// engine portado roda sem mudança.
//
// IMPL-022 (R-09:REC-6) — diferenças de seam em relação ao Node, de propósito:
//  • record + resumo vão na MESMA transação (o Node não tem store de resumo: a
//    lista lê os próprios arquivos). Grava os dois ou nenhum — antes eram dois
//    `idbPut` independentes e um podia ficar sem o outro.
//  • `saveRun`/`saveSession` NUNCA rejeitam por falha de gravação: a falha vira
//    EVENTO no barramento da run/sessão (`storage.quota_exceeded` /
//    `storage.write_failed`) + registro em `storageHealth` (aviso na UI, guarda
//    de fechar a aba). Rejeitar derrubaria como `error` uma run paga e correta
//    só porque o disco encheu; engolir (o comportamento antigo) a perdia calada.
//    Devolvem `true` quando gravaram.
//  • `durability: 'strict'` por default (checkpoint). A batida periódica do
//    throttle passa 'relaxed' — a próxima a sobrescreve (R-10:DEC-2).

import { idbGet, idbGetAll, idbWrite, type IdbDurability } from '../idb';
import { reportWriteFailure, reportWriteSuccess } from '../storageHealth';
import { emitEvent, emitSessionEvent } from './events';
import { normalizeRunRecord } from './normalize';
import type { RunRecord, SessionRecord } from './types';

export interface SaveOpts {
  /** 'strict' (default) = checkpoint; 'relaxed' = batida periódica do throttle. */
  durability?: IdbDurability;
}

export function runSummary(r: RunRecord) {
  const cfg = r.config as { theme?: string; stages?: number; competitorModelIds?: string[]; mode?: string };
  const n = r.contestants?.length ?? cfg?.competitorModelIds?.length ?? 0;
  return {
    id: r.id,
    status: r.status,
    mode: r.mode ?? cfg?.mode ?? 'compare',
    theme: cfg?.theme ?? '',
    stages: cfg?.stages ?? r.stages?.length ?? 0,
    contestants: n,
    competitors: n,
    totalCostUsd: r.totalCostUsd ?? 0,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    sessionId: r.sessionId,
    iteration: r.iteration,
  };
}

export function sessionSummary(s: SessionRecord) {
  return {
    id: s.id,
    status: s.status,
    theme: s.config?.theme ?? '',
    iterationsPlanned: s.config?.iterations ?? 0,
    iterationsDone: s.bestPromptByIteration?.length ?? 0,
    totalCostUsd: s.totalCostUsd ?? 0,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
  };
}

function warn(subject: string, id: string, message: string): void {
  console.warn(`[storage] ${subject} ${id} NÃO foi salva no navegador: ${message}`);
}

/** Grava record + resumo da run numa transação só. Nunca rejeita (ver topo). */
export async function saveRun(record: RunRecord, opts: SaveOpts = {}): Promise<boolean> {
  try {
    await idbWrite(
      [
        { store: 'runs', put: record as unknown as { id: string } },
        { store: 'runSummaries', put: runSummary(record) },
      ],
      { durability: opts.durability ?? 'strict' },
    );
  } catch (err) {
    const { issue, isNew } = reportWriteFailure('run', record.id, err);
    if (isNew) {
      warn('run', record.id, issue.error);
      emitEvent(
        issue.kind === 'quota'
          ? { type: 'storage.quota_exceeded', runId: record.id, kind: 'quota', error: issue.error }
          : { type: 'storage.write_failed', runId: record.id, kind: issue.kind, error: issue.error },
      );
    }
    return false;
  }
  reportWriteSuccess('run', record.id);
  return true;
}

/** Grava record + resumo da sessão numa transação só. Nunca rejeita (ver topo). */
export async function saveSession(record: SessionRecord, opts: SaveOpts = {}): Promise<boolean> {
  try {
    await idbWrite(
      [
        { store: 'sessions', put: record as unknown as { id: string } },
        { store: 'sessionSummaries', put: sessionSummary(record) },
      ],
      { durability: opts.durability ?? 'strict' },
    );
  } catch (err) {
    const { issue, isNew } = reportWriteFailure('session', record.id, err);
    if (isNew) {
      warn('sessão', record.id, issue.error);
      emitSessionEvent(
        issue.kind === 'quota'
          ? { type: 'storage.quota_exceeded', sessionId: record.id, kind: 'quota', error: issue.error }
          : { type: 'storage.write_failed', sessionId: record.id, kind: issue.kind, error: issue.error },
      );
    }
    return false;
  }
  reportWriteSuccess('session', record.id);
  return true;
}

export async function loadRun(id: string): Promise<RunRecord | null> {
  const raw = await idbGet<RunRecord>('runs', id);
  // As entradas do journal de chamadas (IMPL-081, `./callJournal`) moram na
  // mesma store sob `journal:<runId>:…` — nunca são um record.
  if (!raw || (raw as { t?: unknown }).t === 'call') return null;
  return normalizeRunRecord(raw);
}

export async function loadSession(id: string): Promise<SessionRecord | null> {
  return (await idbGet<SessionRecord>('sessions', id)) ?? null;
}

export async function listRuns<T = unknown>(): Promise<T[]> {
  return idbGetAll<T>('runSummaries');
}

export async function listSessions<T = unknown>(): Promise<T[]> {
  return idbGetAll<T>('sessionSummaries');
}

// Journal de chamadas (IMPL-081): o adaptador IndexedDB mora em
// `./callJournal` (junto do núcleo re-exportado de src/engine/callJournal.ts).
