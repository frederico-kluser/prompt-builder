// Modo JEV — persistência do NAVEGADOR (IndexedDB v3: `jevRuns`, `jevSessions`,
// `jevSummaries`). É o `src/jev/store.ts` do Node trocado de seam: o motor
// (`src/engine/jev/`, via shim) recebe estas funções como `save`/`saveRun`/
// `saveSession` e nunca sabe onde grava.
//
// Mesmas regras de `web/src/engine/storage.ts` (IMPL-022):
//  • record + resumo na MESMA transação (a lista nunca aponta para um record
//    que não existe, nem o contrário);
//  • gravar NUNCA rejeita: falha vira registro em `storageHealth` (aviso na UI
//    e guarda de fechar a aba) e `false` — rejeitar derrubaria como `error` uma
//    run paga e correta só porque o disco encheu; engolir a perderia calada;
//  • batida periódica (status `running`) grava 'relaxed'; o fechamento, 'strict'.

import { idbGet, idbGetAll, idbWrite } from '../idb';
import { reportWriteFailure, reportWriteSuccess } from '../storageHealth';
import type { JevRunRecord, JevSessionRecord, JevMode } from '../engine/jev';

/** Uma linha do histórico JEV (o que a lista lê sem abrir o record inteiro). */
export interface JevSummary {
  id: string;
  kind: 'run' | 'session';
  status: JevRunRecord['status'];
  mode: JevMode;
  theme: string;
  startedAt: string;
  finishedAt?: string;
  totalCostUsd: number;
  client: 'node' | 'browser';
  /** Run de um ciclo de treino (fica fora da lista plana; abre pela sessão). */
  sessionId?: string;
  iteration?: number;
  /** run: casos avaliados · sessão: casos do dataset. */
  cases: number;
  /** run: competidores · sessão: 1 (a definição que evolui). */
  contestants: number;
  /** Sessão: ciclos feitos/planejados. */
  iterationsDone?: number;
  iterationsPlanned?: number;
  /** Acurácia do controle (run concluída) — só para a lista. */
  accuracy?: number | null;
}

export function jevRunSummary(r: JevRunRecord): JevSummary {
  const controle = r.contestants.find((c) => c.isControl) ?? r.contestants[0];
  const m = controle ? r.metrics[controle.id] : undefined;
  return {
    id: r.id,
    kind: 'run',
    status: r.status,
    mode: r.mode,
    theme: r.theme,
    startedAt: r.startedAt,
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    totalCostUsd: r.totalCostUsd ?? 0,
    client: r.client,
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    ...(r.iteration !== undefined ? { iteration: r.iteration } : {}),
    cases: r.cases.length,
    contestants: r.contestants.length,
    accuracy: m ? m.accuracy : null,
  };
}

export function jevSessionSummary(s: JevSessionRecord, cases = 0): JevSummary {
  return {
    id: s.id,
    kind: 'session',
    status: s.status,
    mode: 'train',
    theme: s.theme,
    startedAt: s.startedAt,
    ...(s.finishedAt ? { finishedAt: s.finishedAt } : {}),
    totalCostUsd: s.totalCostUsd ?? 0,
    client: 'browser',
    cases,
    contestants: 1,
    iterationsDone: s.iterations.filter((i) => i.iteration > 0).length,
    iterationsPlanned: s.config.train?.iterations ?? 0,
  };
}

function warn(subject: string, id: string, message: string): void {
  console.warn(`[jev] ${subject} ${id} NÃO foi salva no navegador: ${message}`);
}

/** Grava record + resumo da run numa transação só. Nunca rejeita (ver topo). */
export async function saveJevRun(rec: JevRunRecord): Promise<boolean> {
  try {
    await idbWrite(
      [
        { store: 'jevRuns', put: rec as unknown as { id: string } },
        { store: 'jevSummaries', put: jevRunSummary(rec) },
      ],
      { durability: rec.status === 'running' ? 'relaxed' : 'strict' },
    );
  } catch (err) {
    const { issue, isNew } = reportWriteFailure('run', rec.id, err);
    if (isNew) warn('run JEV', rec.id, issue.error);
    return false;
  }
  reportWriteSuccess('run', rec.id);
  return true;
}

/** Grava record + resumo da sessão de treino numa transação só. Nunca rejeita. */
export async function saveJevSession(s: JevSessionRecord, cases?: number): Promise<boolean> {
  const resumo = jevSessionSummary(s, cases ?? 0);
  try {
    await idbWrite(
      [
        { store: 'jevSessions', put: s as unknown as { id: string } },
        { store: 'jevSummaries', put: resumo },
      ],
      { durability: s.status === 'running' ? 'relaxed' : 'strict' },
    );
  } catch (err) {
    const { issue, isNew } = reportWriteFailure('session', s.id, err);
    if (isNew) warn('sessão JEV', s.id, issue.error);
    return false;
  }
  reportWriteSuccess('session', s.id);
  return true;
}

export async function loadJevRun(id: string): Promise<JevRunRecord | null> {
  const r = await idbGet<JevRunRecord>('jevRuns', id);
  return r && r.format === 'jev-run@1' ? r : null;
}

export async function loadJevSession(id: string): Promise<JevSessionRecord | null> {
  const s = await idbGet<JevSessionRecord>('jevSessions', id);
  return s && s.format === 'jev-session@1' ? s : null;
}

/** Histórico JEV, mais recentes primeiro. Leitura degrada para vazio (ler não perde dado). */
export async function listJevSummaries(): Promise<JevSummary[]> {
  const all = await idbGetAll<JevSummary>('jevSummaries');
  return all
    .filter((s) => s && typeof s.id === 'string' && (s.kind === 'run' || s.kind === 'session'))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}
