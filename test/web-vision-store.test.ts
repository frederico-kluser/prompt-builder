// Contrato da persistência da visão no navegador (IndexedDB v4):
// record + resumo na MESMA transação, leitura degrada para vazio, gravar nunca
// rejeita (falha de cota vira aviso) e apagar remove os dois.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeIdb } from './fakeIndexedDb.js';
import type { VisionRunRecord } from '../src/engine/vision/index.js';
import { VISION_RUN_FORMAT } from '../src/engine/vision/index.js';

function record(id = 'vision-1', score = 0.5): VisionRunRecord {
  return {
    format: VISION_RUN_FORMAT,
    id,
    status: 'finished',
    dataset: { version: '0.1.0', hash: 'sha256:' + 'a'.repeat(64), scenes: ['s1', 's2'], images: {} },
    promptVersion: 'vision-prompt@1',
    config: { models: ['m1'], tasks: ['map'], families: null, scenes: null, limit: null, coordSpace: 'pixels', temperature: 0, maxTokens: 100, retries: 0, budgetUsd: 1 },
    contestants: [
      {
        contestantId: 'm1',
        modelId: 'm1',
        score,
        calls: 2,
        errors: 0,
        skipped: 0,
        parseFailures: 0,
        costUsd: 0.01,
        tokensIn: 100,
        tokensOut: 10,
        meanLatencyMs: 5,
      },
    ],
    cells: [],
    totals: { calls: 2, errors: 0, skipped: 0, costUsd: 0.01, tokensIn: 100, tokensOut: 10 },
    startedAt: '2026-10-21T10:00:00.000Z',
    finishedAt: '2026-10-21T10:01:00.000Z',
    warnings: [],
  };
}

async function modulos(disco: FakeIdb) {
  vi.resetModules();
  const idb = await import('../web/src/idb.js');
  idb.setIdbFactory(disco.factory);
  const storageHealth = await import('../web/src/storageHealth.js');
  storageHealth.setStorageManager(null);
  const store = await import('../web/src/vision/store.js');
  return { idb, storageHealth, store };
}

afterEach(() => {
  vi.resetModules();
});

describe('vision/store (IndexedDB v4)', () => {
  it('grava record + resumo na MESMA transação e lê de volta', async () => {
    const disco = new FakeIdb();
    const { store } = await modulos(disco);
    expect(await store.saveVisionRun(record())).toBe(true);
    const tx = disco.transactions.find((t) => t.stores.includes('visionRuns'));
    expect(tx?.stores).toEqual(expect.arrayContaining(['visionRuns', 'visionSummaries']));
    const rec = await store.loadVisionRun('vision-1');
    expect(rec?.id).toBe('vision-1');
    const resumos = await store.listVisionSummaries();
    expect(resumos).toHaveLength(1);
    expect(resumos[0]).toMatchObject({
      id: 'vision-1',
      scenes: 2,
      models: ['m1'],
      bestModel: 'm1',
      bestScore: 0.5,
      promptVersion: 'vision-prompt@1',
    });
  });

  it('lista mais recentes primeiro e ignora record de outro formato', async () => {
    const disco = new FakeIdb();
    const { store } = await modulos(disco);
    const antigo = record('vision-1', 0.2);
    const novo = record('vision-2', 0.9);
    novo.startedAt = '2026-10-22T10:00:00.000Z';
    await store.saveVisionRun(antigo);
    await store.saveVisionRun(novo);
    const resumos = await store.listVisionSummaries();
    expect(resumos.map((r) => r.id)).toEqual(['vision-2', 'vision-1']);
    // Record estranho na store não vira "run de visão".
    await new Promise<void>((ok) => {
      const req = disco.factory.open('prompt-builder') as unknown as IDBOpenDBRequest;
      req.onsuccess = () => {
        const tx = req.result.transaction(['visionRuns'], 'readwrite');
        tx.objectStore('visionRuns').put({ id: 'x', format: 'outro' });
        tx.oncomplete = () => {
          req.result.close();
          ok();
        };
      };
    });
    expect(await store.loadVisionRun('x')).toBeNull();
  });

  it('falha de cota NÃO rejeita: devolve false e não grava o resumo', async () => {
    const disco = new FakeIdb();
    const { store, storageHealth } = await modulos(disco);
    disco.failNextCommit('QuotaExceededError');
    expect(await store.saveVisionRun(record())).toBe(false);
    expect(disco.get('visionRuns', 'vision-1')).toBeUndefined();
    expect(disco.get('visionSummaries', 'vision-1')).toBeUndefined();
    expect(storageHealth.getStorageHealth().unsaved).toBeTruthy();
  });

  it('apagar remove record e resumo', async () => {
    const disco = new FakeIdb();
    const { store } = await modulos(disco);
    await store.saveVisionRun(record());
    await store.deleteVisionRun('vision-1');
    expect(await store.loadVisionRun('vision-1')).toBeNull();
    expect(await store.listVisionSummaries()).toEqual([]);
  });
});
