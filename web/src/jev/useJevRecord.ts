// Leitura de um record JEV para as telas: memória desta aba (ao vivo, a cada
// gravação do motor) > IndexedDB. Record `running` que NÃO roda aqui é lido do
// disco a cada 800 ms (outra aba grava por throttle) e o lock do dono é
// checado junto — se a aba dona morreu, vira órfão na hora.

import { useEffect, useState } from 'react';
import type { JevRunRecord, JevSessionRecord } from '../engine/jev';
import {
  canCancelJev,
  getJevRun,
  getJevSession,
  liveJevRecord,
  reconcileJev,
  subscribeJevRecord,
  type JevOrphanState,
  type JevRecordKind,
} from './api';

export const JEV_POLL_MS = 800;

type RecordOf<K extends JevRecordKind> = K extends 'session' ? JevSessionRecord : JevRunRecord;

export interface JevRecordState<R> {
  /** undefined = carregando · null = não existe (neste navegador). */
  record: R | null | undefined;
  /** Roda nesta aba (pode cancelar). */
  local: boolean;
  /** Estado de posse quando roda em OUTRA aba (ou sem Web Locks). */
  ownership: JevOrphanState | null;
}

export function useJevRecord<K extends JevRecordKind>(kind: K, id: string | undefined): JevRecordState<RecordOf<K>> {
  const [record, setRecord] = useState<RecordOf<K> | null | undefined>(() =>
    id ? ((liveJevRecord(id) as RecordOf<K> | undefined) ?? undefined) : null,
  );
  const [ownership, setOwnership] = useState<JevOrphanState | null>(null);
  const [local, setLocal] = useState(() => (id ? canCancelJev(id) : false));

  useEffect(() => {
    if (!id) {
      setRecord(null);
      return;
    }
    let ativo = true;
    const carregar = async (): Promise<RecordOf<K> | null> =>
      (kind === 'session' ? await getJevSession(id) : await getJevRun(id)) as RecordOf<K> | null;
    const unsub = subscribeJevRecord(id, (r) => {
      if (!ativo) return;
      setRecord(r as RecordOf<K>);
      setLocal(canCancelJev(id));
    });
    let tick = 0;
    let ultimoStatus: string | undefined;
    const atualizar = async (): Promise<void> => {
      const r = await carregar();
      if (!ativo) return;
      ultimoStatus = r?.status;
      setRecord(r);
      setLocal(canCancelJev(id));
      if (r && r.status === 'running' && !canCancelJev(id)) {
        // Outra aba (ou nenhuma): a cada ~4 s pergunta ao lock se o dono vive.
        if (tick++ % 5 === 0) {
          const st = await reconcileJev(kind, id);
          if (!ativo) return;
          setOwnership(st);
          if (st === 'orphaned') setRecord(await carregar());
        }
      } else {
        setOwnership(null);
      }
    };
    void atualizar();
    const timer = setInterval(() => {
      const atual = liveJevRecord(id);
      if (atual && canCancelJev(id)) return; // ao vivo por evento
      // Terminal (ou inexistente) não muda mais: para de ler o disco.
      if (ultimoStatus !== 'running' && ultimoStatus !== undefined) return;
      void atualizar();
    }, JEV_POLL_MS);
    return () => {
      ativo = false;
      unsub();
      clearInterval(timer);
    };
  }, [kind, id]);

  return { record, local, ownership };
}
