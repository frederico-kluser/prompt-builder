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
import { contentHash } from './hash';
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
  return raw ? normalizeRunRecord(raw) : null;
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

// ---------------------------------------------------------------------------
// Journal de chamadas (IMPL-081, R-10:REC-2) — retomada sem repetir chamadas
// pagas. Mirror de src/storage.ts (mesmo contrato; seam IndexedDB):
//  • 1 entrada por chamada CONCLUÍDA, chaveada por `callJournalKey`
//    (hash canônico de model+messages+params) — na retomada, `replayCall`
//    devolve o resultado gravado ANTES de a chamada ser refeita (replay, não
//    re-execução);
//  • grupo ATÔMICO (competidores + julgamento entra inteiro ou é refeito):
//    entrada só é replayable com o registro `commit` do grupo — kill em
//    qualquer fase e o grupo inteiro é refeito, nunca etapa com resposta e
//    sem nota;
//  • durability 'strict' em todo append (checkpoint): o Chromium confirmaria
//    'relaxed' e o crash podia perder a chamada já paga.
//
// Sem store própria no IndexedDB (a store 'journals' pediria bump de versão do
// db em idb.ts, fora do alcance aqui): as entradas moram na store 'runs' sob
// ids prefixados (`journal:<runId>:…`), invisíveis para `loadRun`/listagens —
// ids de record nunca contêm ':' (RECORD_ID_RE), então não há colisão.
export interface CallJournalEntry {
  /** Chave de idempotência: `contentHash` de model+messages+params. */
  key: string;
  /** Grupo atômico (ex.: `stage:2:competitors+judge`) — entra inteiro ou é refeito. */
  group: string;
  /** ISO do momento em que a chamada CONCLUIU (resultado já na mão). */
  at: string;
  /** Resultado serializável para replay (a resposta da chamada). */
  result: unknown;
}

/**
 * Chave de idempotência de uma chamada: hash canônico (JCS) de
 * `model + messages + params`. Espelha `callJournalKey` de src/storage.ts —
 * fonte única do hash em src/engine/hash.ts, mesmo valor nos dois runtimes.
 */
export function callJournalKey(model: string, messages: unknown, params?: unknown): string {
  return contentHash({ model, messages, params: params ?? null });
}

type CallJournalRecord =
  | ({ id: string; t: 'call' } & CallJournalEntry)
  | { id: string; t: 'commit'; group: string; at: string };

const callEntryId = (runId: string, key: string): string => `journal:${runId}:call:${key}`;
const commitEntryId = (runId: string, group: string): string => `journal:${runId}:commit:${group}`;
const journalPrefix = (runId: string): string => `journal:${runId}:`;

/**
 * Grava 1 entrada por chamada CONCLUÍDA (checkpoint 'strict'). Devolve `false`
 * se o navegador recusou (quota/indisponível) — a falha vira aviso em
 * `storageHealth`, como a do record: um journal incompleto custa re-execução
 * na retomada, nunca resultado errado.
 */
export async function appendCallJournal(runId: string, entry: CallJournalEntry): Promise<boolean> {
  const rec: CallJournalRecord = {
    id: callEntryId(runId, entry.key),
    t: 'call',
    key: entry.key,
    group: entry.group,
    at: entry.at,
    result: entry.result,
  };
  try {
    await idbWrite([{ store: 'runs', put: rec as unknown as { id: string } }], { durability: 'strict' });
  } catch (err) {
    const { issue, isNew } = reportWriteFailure('run', runId, err);
    if (isNew) {
      warn('run', runId, `journal de chamadas: ${issue.error}`);
      emitEvent(
        issue.kind === 'quota'
          ? { type: 'storage.quota_exceeded', runId, kind: 'quota', error: issue.error }
          : { type: 'storage.write_failed', runId, kind: issue.kind, error: issue.error },
      );
    }
    return false;
  }
  return true;
}

/**
 * Fecha o grupo atômico: a partir daqui as chamadas dele são replayable. Sem
 * este registro o grupo inteiro é refeito na retomada.
 */
export async function commitCallGroup(runId: string, group: string): Promise<boolean> {
  const rec: CallJournalRecord = {
    id: commitEntryId(runId, group),
    t: 'commit',
    group,
    at: new Date().toISOString(),
  };
  try {
    await idbWrite([{ store: 'runs', put: rec as unknown as { id: string } }], { durability: 'strict' });
  } catch (err) {
    const { issue, isNew } = reportWriteFailure('run', runId, err);
    if (isNew) {
      warn('run', runId, `commit do grupo ${group}: ${issue.error}`);
      emitEvent(
        issue.kind === 'quota'
          ? { type: 'storage.quota_exceeded', runId, kind: 'quota', error: issue.error }
          : { type: 'storage.write_failed', runId, kind: issue.kind, error: issue.error },
      );
    }
    return false;
  }
  return true;
}

/**
 * Replay de UMA chamada: devolve o resultado gravado se a chamada está no
 * journal E o grupo dela foi commitado; `undefined` = não há replay (chame de
 * verdade). Falha de leitura degrada para `undefined` (re-executar é caro, mas
 * nunca errado).
 */
export async function replayCall<T = unknown>(runId: string, key: string): Promise<T | undefined> {
  const entry = await idbGet<CallJournalRecord & { t: 'call' }>('runs', callEntryId(runId, key));
  if (!entry || entry.t !== 'call') return undefined;
  const commit = await idbGet<CallJournalRecord & { t: 'commit' }>('runs', commitEntryId(runId, entry.group));
  if (!commit || commit.t !== 'commit') return undefined;
  return entry.result as T;
}

/** Entradas de chamada do journal (ordem de escrita). Para inspeção/testes. */
export async function readCallJournal(runId: string): Promise<CallJournalEntry[]> {
  const todos = await idbGetAll<CallJournalRecord>('runs');
  const prefixo = journalPrefix(runId);
  return todos
    .filter((r): r is { id: string; t: 'call' } & CallJournalEntry => r?.t === 'call' && r.id.startsWith(prefixo))
    .map(({ key, group, at, result }) => ({ key, group, at, result }));
}

/**
 * Apaga o journal da run (retomada terminada ou record deletado). Idempotente;
 * nunca rejeita — é limpeza.
 */
export async function clearCallJournal(runId: string): Promise<void> {
  try {
    const todos = await idbGetAll<{ id: string }>('runs');
    const prefixo = journalPrefix(runId);
    const apagar = todos.filter((r) => r?.id?.startsWith(prefixo)).map((r) => r.id);
    if (!apagar.length) return;
    await idbWrite(apagar.map((id) => ({ store: 'runs' as const, delete: id })), { durability: 'relaxed' });
  } catch (err) {
    console.warn('[storage] não consegui limpar o journal da run', runId, err);
  }
}
