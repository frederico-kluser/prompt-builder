// left#6 — parte web do IMPL-100 (R-16:REC-6): retenção LGPD do histórico
// LOCAL da SPA. Antes a SPA guardava runs/treinos no IndexedDB para sempre
// (o TTL só existia no Node). Contratos, com o IndexedDB falso:
//
//  (1) o prune da abertura (`pruneExpiredLocal`) apaga record + resumo das
//      runs, sessões e runs/sessões JEV com idade > TTL, e o journal de
//      chamadas das runs apagadas — e SÓ isso: dentro do TTL, `running`,
//      importado há pouco e a biblioteca de prompts ficam;
//  (2) idade = max(startedAt, importedAt), a MESMA régua do Node
//      (`retentionReferenceMs`), casada aqui;
//  (3) dry-run não apaga; TTL 0 desliga; falha de um item não derruba a
//      varredura (0 exceções);
//  (4) `startLocalRetention` roda UMA vez por carga e publica o relatório;
//  (5) importar um record JEV do terminal carimba `importedAt` — o arquivo
//      antigo importado hoje NÃO some na abertura seguinte;
//  (6) a tela de Configurações chama o wipe do banco inteiro (hold-to-confirm)
//      e main.tsx liga o prune na carga.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FakeIdb } from './fakeIndexedDb.js';
import { idbGetAll, idbPut, idbWrite, resetIdbConnection, setIdbFactory } from '../web/src/idb.js';
import {
  _resetLocalRetentionForTests,
  lastLocalPrune,
  localRetentionReferenceMs,
  pruneExpiredLocal,
  startLocalRetention,
} from '../web/src/localRetention.js';
import { retentionReferenceMs } from '../src/lgpd.js';

const DAY = 86_400_000;
const AGORA = Date.parse('2026-09-29T12:00:00.000Z');
const diasAtras = (d: number): string => new Date(AGORA - d * DAY).toISOString();
const ROOT = path.resolve(import.meta.dirname, '..');

let disco: FakeIdb;

/** Run LLM: record + resumo na mesma transação (como `engine/storage.ts`). */
async function run(id: string, startedAt: string, extra: Record<string, unknown> = {}) {
  const rec = { id, status: 'finished', startedAt, stages: [], contestants: [], config: {}, ...extra };
  await idbWrite([
    { store: 'runs', put: rec },
    { store: 'runSummaries', put: { id, status: rec.status, startedAt } },
  ]);
}

async function sessao(id: string, startedAt: string, extra: Record<string, unknown> = {}) {
  const rec = { id, status: 'finished', startedAt, runIds: [], bestPromptByIteration: [], config: {}, ...extra };
  await idbWrite([
    { store: 'sessions', put: rec },
    { store: 'sessionSummaries', put: { id, status: rec.status, startedAt } },
  ]);
}

async function jev(kind: 'run' | 'session', id: string, startedAt: string, extra: Record<string, unknown> = {}) {
  const rec = { id, status: 'finished', startedAt, ...extra };
  await idbWrite([
    { store: kind === 'run' ? 'jevRuns' : 'jevSessions', put: rec },
    { store: 'jevSummaries', put: { id, kind, status: rec.status, startedAt } },
  ]);
}

const ids = async (store: Parameters<typeof idbGetAll>[0]): Promise<string[]> =>
  (await idbGetAll<{ id: string }>(store)).map((r) => r.id).sort();

beforeEach(() => {
  disco = new FakeIdb();
  setIdbFactory(disco.factory);
  _resetLocalRetentionForTests();
});

afterEach(() => {
  resetIdbConnection();
  setIdbFactory(undefined);
});

describe('left#6 (1) prune do TTL na SPA: apaga o vencido e SÓ o vencido', () => {
  it('runs, sessões e JEV vencidos saem (record + resumo + journal); o resto fica', async () => {
    await run('run-velha', diasAtras(120));
    await run('run-nova', diasAtras(10));
    // Arquivo de 200 dias importado há 5: conta da importação (fica).
    await run('run-importada', diasAtras(200), { importedAt: diasAtras(5) });
    // Rodando: quem decide órfã é a varredura de locks (fica).
    await idbWrite([
      { store: 'runs', put: { id: 'run-rodando', status: 'running', startedAt: diasAtras(300) } },
      { store: 'runSummaries', put: { id: 'run-rodando', status: 'running', startedAt: diasAtras(300) } },
    ]);
    // Journal de chamadas (IMPL-081) mora na store 'runs' com prefixo.
    await idbPut('runs', { id: 'journal:run-velha:abc', t: 'call' } as { id: string });
    await idbPut('runs', { id: 'journal:run-velha:commit:g1', t: 'commit' } as { id: string });
    await idbPut('runs', { id: 'journal:run-nova:abc', t: 'call' } as { id: string });
    await sessao('sessao-velha', diasAtras(95));
    await sessao('sessao-nova', diasAtras(1));
    await jev('run', 'jev-run-velha', diasAtras(91));
    await jev('session', 'jev-sessao-velha', diasAtras(400));
    await jev('run', 'jev-run-nova', diasAtras(3));
    // Biblioteca de prompts: curadoria, não expira.
    await idbPut('prompts', { id: 'prompt-antigo', createdAt: diasAtras(500) } as { id: string });

    const rel = await pruneExpiredLocal({ now: AGORA, retentionDays: 90 });

    expect(rel.errors).toEqual([]);
    expect(rel.retentionDays).toBe(90);
    expect(rel.deleted.map((d) => `${d.kind}:${d.id}`).sort()).toEqual([
      'jev-run:jev-run-velha',
      'jev-session:jev-sessao-velha',
      'run:run-velha',
      'session:sessao-velha',
    ]);
    expect(rel.journalEntries).toBe(2);
    expect(await ids('runs')).toEqual(['journal:run-nova:abc', 'run-importada', 'run-nova', 'run-rodando']);
    expect(await ids('runSummaries')).toEqual(['run-importada', 'run-nova', 'run-rodando']);
    expect(await ids('sessions')).toEqual(['sessao-nova']);
    expect(await ids('sessionSummaries')).toEqual(['sessao-nova']);
    expect(await ids('jevRuns')).toEqual(['jev-run-nova']);
    expect(await ids('jevSessions')).toEqual([]);
    expect(await ids('jevSummaries')).toEqual(['jev-run-nova']);
    expect(await ids('prompts')).toEqual(['prompt-antigo']);
  });

  it('limite exato: idade == TTL fica; 1 ms além sai; data ilegível = vencido (não reter por engano)', async () => {
    await run('no-limite', new Date(AGORA - 90 * DAY).toISOString());
    await run('um-ms-alem', new Date(AGORA - 90 * DAY - 1).toISOString());
    await run('sem-data', 'ontem, acho');
    const rel = await pruneExpiredLocal({ now: AGORA, retentionDays: 90 });
    expect(rel.deleted.map((d) => d.id).sort()).toEqual(['sem-data', 'um-ms-alem']);
    expect(await ids('runs')).toEqual(['no-limite']);
  });

  it('resumo órfão (record já sumiu) também sai', async () => {
    await idbPut('runSummaries', { id: 'fantasma', status: 'finished', startedAt: diasAtras(200) } as { id: string });
    const rel = await pruneExpiredLocal({ now: AGORA, retentionDays: 90 });
    expect(rel.deleted).toEqual([{ kind: 'run', id: 'fantasma' }]);
    expect(await ids('runSummaries')).toEqual([]);
  });
});

describe('left#6 (2) idade = max(startedAt, importedAt): a MESMA régua do Node', () => {
  it('localRetentionReferenceMs ≡ retentionReferenceMs (src/lgpd.ts)', () => {
    const casos = [
      { startedAt: diasAtras(200) },
      { startedAt: diasAtras(200), importedAt: diasAtras(3) },
      { startedAt: diasAtras(3), importedAt: diasAtras(200) },
      { startedAt: 'lixo', importedAt: diasAtras(7) },
      { startedAt: 'lixo' },
      {},
      { startedAt: 42 as unknown as string },
    ];
    for (const c of casos) expect(localRetentionReferenceMs(c), JSON.stringify(c)).toBe(retentionReferenceMs(c));
  });
});

describe('left#6 (3) dry-run, TTL desligado e falha isolada', () => {
  it('dry-run relata e não apaga; TTL 0 não apaga nada', async () => {
    await run('run-velha', diasAtras(120));
    const seco = await pruneExpiredLocal({ now: AGORA, retentionDays: 90, dryRun: true });
    expect(seco.deleted).toEqual([{ kind: 'run', id: 'run-velha' }]);
    expect(await ids('runs')).toEqual(['run-velha']);
    const desligado = await pruneExpiredLocal({ now: AGORA, retentionDays: 0 });
    expect(desligado).toMatchObject({ retentionDays: 0, scanned: 0, deleted: [] });
    expect(await ids('runs')).toEqual(['run-velha']);
  });

  it('um item que falha ao apagar vira erro relatado; a varredura segue e NÃO lança', async () => {
    await run('run-a', diasAtras(120));
    await run('run-b', diasAtras(130));
    disco.failNextCommit('UnknownError', 1);
    const rel = await pruneExpiredLocal({ now: AGORA, retentionDays: 90 });
    expect(rel.errors).toHaveLength(1);
    expect(rel.deleted).toHaveLength(1);
    // O que falhou continua lá (a próxima abertura tenta de novo).
    expect(await ids('runs')).toHaveLength(1);
  });

  it('sem IndexedDB: nada a podar, nenhuma exceção', async () => {
    setIdbFactory(null);
    const rel = await pruneExpiredLocal({ now: AGORA, retentionDays: 90 });
    expect(rel.deleted).toEqual([]);
  });
});

describe('left#6 (4) uma vez por carga de página', () => {
  it('startLocalRetention é idempotente e publica o relatório', async () => {
    await run('run-velha', diasAtras(120));
    const a = startLocalRetention({ now: AGORA, retentionDays: 90 });
    const b = startLocalRetention({ now: AGORA, retentionDays: 1 });
    expect(a).toBe(b);
    const rel = await a;
    expect(rel.deleted).toEqual([{ kind: 'run', id: 'run-velha' }]);
    expect(lastLocalPrune()).toBe(rel);
  });
});

describe('left#6 (5) importar do terminal conta da IMPORTAÇÃO', () => {
  it('record JEV antigo importado hoje ganha importedAt e sobrevive ao prune', async () => {
    vi.resetModules();
    const idb = await import('../web/src/idb.js');
    idb.setIdbFactory(disco.factory);
    const runLocks = await import('../web/src/engine/runLocks.js');
    runLocks.setLockManager(null);
    const saude = await import('../web/src/storageHealth.js');
    saude.setStorageManager(null);
    const api = await import('../web/src/jev/api.js');
    const retencao = await import('../web/src/localRetention.js');
    const antigo = {
      format: 'jev-run@1',
      id: 'jev-arquivo-2025',
      status: 'finished',
      mode: 'eval',
      theme: 'arquivo',
      client: 'node',
      startedAt: '2025-01-10T10:00:00.000Z',
      finishedAt: '2025-01-10T10:05:00.000Z',
      cases: [],
      contestants: [],
      cells: [],
      questionIds: [],
      specs: [],
      metrics: {},
      byQuestion: {},
      byType: {},
      confusion: {},
      config: {},
      progress: {},
      cost: { byKind: {} },
      incompleteCaseIds: [],
      warnings: [],
      resolvedModels: {},
      totalCostUsd: 0,
    };
    const antes = Date.now();
    const [res] = await api.importJevRecordFiles([{ name: 'a.json', text: JSON.stringify(antigo) }]);
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    const gravado = await idb.idbGet<{ importedAt?: string; startedAt: string }>('jevRuns', antigo.id);
    expect(gravado?.startedAt).toBe(antigo.startedAt); // o original fica intacto
    expect(Date.parse(gravado?.importedAt ?? '')).toBeGreaterThanOrEqual(antes - 1000);
    const rel = await retencao.pruneExpiredLocal({ retentionDays: 90 });
    expect(rel.deleted).toEqual([]);
    expect((await idb.idbGetAll<{ id: string }>('jevRuns')).map((r) => r.id)).toEqual([antigo.id]);
    vi.resetModules();
  });
});

describe('left#6 (6) a tela e a carga ligam as peças', () => {
  it('Configurações: "Apagar todos os dados locais" chama wipeLocalData num hold-to-confirm; TTL editável', () => {
    const tela = readFileSync(path.join(ROOT, 'web', 'src', 'pages', 'Settings.tsx'), 'utf-8');
    expect(tela).toMatch(/Apagar todos os dados locais/);
    expect(tela).toMatch(/<HoldToConfirmButton[\s\S]*?onConfirm=\{\(\) => void wipe\(\)\}/);
    expect(tela).toMatch(/await wipeLocalData\(\)/);
    expect(tela).toMatch(/siteWipeInstructions\(\)/);
    expect(tela).toMatch(/RETENTION_DAYS_KEY/);
    expect(tela).toMatch(/dryRun: true/);
  });

  it('main.tsx liga o prune na carga da página', () => {
    const main = readFileSync(path.join(ROOT, 'web', 'src', 'main.tsx'), 'utf-8');
    expect(main).toMatch(/startLocalRetention\(\)/);
  });
});
