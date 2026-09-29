// IndexedDB v3 do modo JEV (chunk 2): upgrade de v2 → v3 mantém as stores
// antigas (runs/sessões/biblioteca) e cria as 3 novas; record + resumo JEV vão
// na MESMA transação; gravar nunca rejeita (a falha vira aviso de
// armazenamento, como nas runs LLM — IMPL-022).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeIdb } from './fakeIndexedDb.js';
import type { JevRunRecord, JevSessionRecord } from '../src/engine/jev/index.js';

async function modulos(disco: FakeIdb) {
  vi.resetModules();
  const idb = await import('../web/src/idb.js');
  idb.setIdbFactory(disco.factory);
  const storageHealth = await import('../web/src/storageHealth.js');
  storageHealth.setStorageManager(null);
  const store = await import('../web/src/jev/store.js');
  return { idb, storageHealth, store };
}

/** Abre o banco "como a v2 abria" e grava dados de usuário antigos. */
async function bancoV2(disco: FakeIdb): Promise<void> {
  await new Promise<void>((ok, fail) => {
    const req = disco.factory.open('prompt-builder', 2) as unknown as IDBOpenDBRequest;
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ['runs', 'sessions', 'runSummaries', 'sessionSummaries', 'prompts']) db.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      req.result.close();
      ok();
    };
    req.onerror = () => fail(req.error);
  });
  disco.data.get('runs')!.set('r-antiga', { id: 'r-antiga', status: 'finished' });
  disco.data.get('prompts')!.set('p-1', { id: 'p-1', text: 'meu prompt' });
}

function runJevMinima(id: string, status: JevRunRecord['status'] = 'finished'): JevRunRecord {
  return {
    format: 'jev-run@1',
    id,
    mode: 'eval',
    status,
    theme: 'Triagem',
    client: 'browser',
    config: {} as JevRunRecord['config'],
    specs: [],
    contestants: [{ id: 'd:original@typesafe/jev-1.13', label: 'jev-1.13 · original', kind: 'decision', modelId: 'typesafe/jev-1.13', specId: 's', probabilitySource: 'native', isControl: true }],
    cases: [{ id: 'c1', state: 'x', expected: { q: true } }],
    questionIds: ['q'],
    cells: [],
    progress: { requestsPlanned: 1, requestsDone: 1, cellsPlanned: 1, cellsDone: 1, spentUsd: 0.00002 },
    metrics: {},
    byQuestion: {},
    byType: {},
    confusion: {},
    incompleteCaseIds: [],
    warnings: [],
    resolvedModels: {},
    cost: { totalUsd: 0.00002, pendingUsd: 0, byRole: {}, byContestant: {}, byKind: { decision: 0.00002, llm: 0, rewriter: 0 } },
    totalCostUsd: 0.00002,
    datasetHash: 'h',
    startedAt: '2026-09-29T00:00:00.000Z',
  };
}

afterEach(() => vi.resetModules());

describe('IndexedDB v3 (modo JEV)', () => {
  it('DB_VERSION = 3 e as 3 stores novas estão na lista', async () => {
    const { idb } = await modulos(new FakeIdb());
    expect(idb.DB_VERSION).toBe(3);
    for (const s of ['jevRuns', 'jevSessions', 'jevSummaries']) expect(idb.STORES).toContain(s);
    // As antigas continuam (a biblioteca e o histórico LLM não podem sumir).
    for (const s of ['runs', 'sessions', 'runSummaries', 'sessionSummaries', 'prompts']) expect(idb.STORES).toContain(s);
  });

  it('upgrade v2 → v3 mantém os dados antigos e cria as stores JEV', async () => {
    const disco = new FakeIdb();
    await bancoV2(disco);
    const { store, idb } = await modulos(disco);
    expect(await store.saveJevRun(runJevMinima('j-1'))).toBe(true);
    for (const s of ['jevRuns', 'jevSessions', 'jevSummaries']) expect(disco.data.has(s)).toBe(true);
    expect(disco.get('runs', 'r-antiga')).toMatchObject({ status: 'finished' });
    expect(disco.get('prompts', 'p-1')).toMatchObject({ text: 'meu prompt' });
    expect(await idb.idbGet('runs', 'r-antiga')).toMatchObject({ id: 'r-antiga' });
    expect(await store.loadJevRun('j-1')).toMatchObject({ format: 'jev-run@1', id: 'j-1' });
  });

  it('record + resumo na MESMA transação; batida `running` é relaxed, fechamento é strict', async () => {
    const disco = new FakeIdb();
    const { store } = await modulos(disco);
    await store.saveJevRun(runJevMinima('j-2', 'running'));
    await store.saveJevRun(runJevMinima('j-2', 'finished'));
    const txs = disco.transactions.filter((t) => t.mode === 'readwrite' && t.stores.includes('jevRuns'));
    expect(txs).toHaveLength(2);
    for (const t of txs) expect([...t.stores].sort()).toEqual(['jevRuns', 'jevSummaries']);
    expect(txs[0].durability).toBe('relaxed');
    expect(txs[1].durability).toBe('strict');
    const lista = await store.listJevSummaries();
    expect(lista).toEqual([expect.objectContaining({ id: 'j-2', kind: 'run', status: 'finished', cases: 1, contestants: 1 })]);
  });

  it('falha de gravação (cota) NÃO rejeita: devolve false e vira aviso de armazenamento', async () => {
    const disco = new FakeIdb();
    const { store, storageHealth } = await modulos(disco);
    disco.failNextCommit('QuotaExceededError');
    const ok = await store.saveJevRun(runJevMinima('j-3'));
    expect(ok).toBe(false);
    const issue = storageHealth.unsavedIssue('run', 'j-3');
    expect(issue?.kind).toBe('quota');
    // Nada meio-gravado: nem record nem resumo.
    expect(disco.get('jevRuns', 'j-3')).toBeUndefined();
    expect(disco.get('jevSummaries', 'j-3')).toBeUndefined();
    // A próxima gravação que dá certo limpa o aviso.
    expect(await store.saveJevRun(runJevMinima('j-3'))).toBe(true);
    expect(storageHealth.unsavedIssue('run', 'j-3')).toBeUndefined();
  });

  it('sessão: resumo com ciclos feitos/planejados e nº de casos', async () => {
    const disco = new FakeIdb();
    const { store } = await modulos(disco);
    const s = {
      format: 'jev-session@1',
      id: 's-1',
      status: 'finished',
      theme: 'Triagem',
      config: { train: { iterations: 3 } },
      iterations: [{ iteration: 0 }, { iteration: 1 }, { iteration: 2 }],
      runIds: [],
      totalCostUsd: 0.001,
      startedAt: '2026-09-29T00:00:00.000Z',
    } as unknown as JevSessionRecord;
    expect(await store.saveJevSession(s, 40)).toBe(true);
    expect(disco.get('jevSummaries', 's-1')).toMatchObject({ kind: 'session', mode: 'train', iterationsDone: 2, iterationsPlanned: 3, cases: 40 });
    expect(await store.loadJevSession('s-1')).toMatchObject({ id: 's-1' });
    // Record de outro formato na store não é devolvido como JEV.
    expect(await store.loadJevRun('s-1')).toBeNull();
  });
});
