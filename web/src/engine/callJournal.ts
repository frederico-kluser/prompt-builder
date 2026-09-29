// SHIM do journal de chamadas (IMPL-081, R-10:REC-2): o núcleo — chave
// canônica do pedido, ocorrência, replay com a blindagem do juiz re-amarrada e
// a política de retomada — é fonte ÚNICA em `src/engine/callJournal.ts`. Aqui
// mora só o seam do NAVEGADOR: o adaptador IndexedDB (espelho do arquivo
// append-only com fsync de `src/storage.ts`).
//
//  • 1 entrada por chamada CONCLUÍDA, gravada com durability 'strict'
//    (checkpoint): o Chromium confirmaria 'relaxed' e o crash/reload podia
//    perder a chamada já paga;
//  • sem store própria (a store 'journals' pediria bump de versão do db em
//    idb.ts): as entradas moram na store 'runs' sob ids prefixados
//    (`journal:<runId>:call:<id>`), invisíveis para `loadRun`/listagens — ids
//    de record nunca contêm ':' (RECORD_ID_RE), então não há colisão;
//  • falha de gravação NUNCA derruba a run nem vira aviso de "run não salva":
//    ela só faz a retomada pagar de novo aquela chamada. IndexedDB ausente
//    (Node dos testes, modo privado) fica calado — a gravação do record já
//    avisa por `storageHealth`.

import { classifyIdbError, idbGetAll, idbWrite } from '../idb';
import {
  JOURNAL_STORE_UNAVAILABLE,
  journalEntryId,
  parseJournalEntry,
  type JournalEntry,
  type JournalStore,
} from '../../../src/engine/callJournal.js';

export * from '../../../src/engine/callJournal.js';

const prefixoDe = (runId: string): string => `journal:${runId}:`;
const idDe = (runId: string, e: Pick<JournalEntry, 'key' | 'seq'>): string =>
  `${prefixoDe(runId)}call:${journalEntryId(e)}`;

interface IdbJournalRow {
  id: string;
  t: 'call';
  entry: unknown;
}

/** Porta do núcleo para uma run: 1 `put` por resposta, durability 'strict'. */
export function idbCallJournalStore(runId: string): JournalStore {
  return {
    async append(entry: JournalEntry): Promise<true | typeof JOURNAL_STORE_UNAVAILABLE> {
      const row: IdbJournalRow = { id: idDe(runId, entry), t: 'call', entry };
      try {
        await idbWrite([{ store: 'runs', put: row as unknown as { id: string } }], { durability: 'strict' });
        return true;
      } catch (err) {
        // Sem IndexedDB não há o que avisar aqui (o record também não grava e
        // a UI já mostra isso); quota/falha real sobe para o `onError` do núcleo.
        if (classifyIdbError(err) === 'unavailable') return JOURNAL_STORE_UNAVAILABLE;
        throw err;
      }
    },
  };
}

/** Entradas VÁLIDAS do journal da run (o que a retomada pode replayar). */
export async function loadIdbCallJournal(runId: string): Promise<JournalEntry[]> {
  const prefixo = prefixoDe(runId);
  const todos = await idbGetAll<IdbJournalRow>('runs').catch(() => [] as IdbJournalRow[]);
  const out: JournalEntry[] = [];
  for (const r of todos) {
    if (r?.t !== 'call' || typeof r.id !== 'string' || !r.id.startsWith(prefixo)) continue;
    const e = parseJournalEntry(r.entry);
    if (e && r.id === idDe(runId, e)) out.push(e);
  }
  return out;
}

/**
 * Apaga o journal da run (concluída, ou record apagado). Idempotente; nunca
 * rejeita — é limpeza. Com `entryIds` (os do `CallJournal` da run — carregados
 * + gravados) apaga por id, SEM ler a store 'runs' inteira (o histórico de
 * records pode ter centenas de MB); sem eles, varre pelo prefixo.
 */
export async function clearIdbCallJournal(runId: string, entryIds?: readonly string[]): Promise<void> {
  try {
    const prefixo = prefixoDe(runId);
    const apagar = entryIds
      ? entryIds.map((id) => `${prefixo}call:${id}`)
      : (await idbGetAll<{ id: string }>('runs'))
          .filter((r) => typeof r?.id === 'string' && r.id.startsWith(prefixo))
          .map((r) => r.id);
    if (!apagar.length) return;
    await idbWrite(apagar.map((id) => ({ store: 'runs' as const, delete: id })), { durability: 'relaxed' });
  } catch (err) {
    if (classifyIdbError(err) === 'unavailable') return;
    console.warn('[journal] não consegui limpar o journal da run', runId, err);
  }
}
