// Modo JEV no NAVEGADOR (chunk 2, D-13): o motor roda NA ABA, sem proxy, pelo
// mesmo gateway do Node. Aqui cada "aba" é uma instância nova dos módulos
// (`vi.resetModules`) sobre o MESMO IndexedDB falso e o MESMO broker de Web
// Locks — a receita de test/web-locks-orphans.test.ts. Transporte falso: zero
// rede, zero gasto.
//
// Garante:
//  (i)    run de exemplo roda na aba e fecha `finished`, record + resumo no
//         IndexedDB (v3), custo = fatura do fake, lock solto no fim;
//  (ii)   recusas ANTES de gastar: sem key, lint com erro, área LGPD sensível
//         (o Jev não é ZDR), custo acima do limiar sem "sim" — 0 decisões;
//  (iii)  cancelar: nenhuma decisão nova sai; record `aborted`/`cancelled`;
//  (iv)   aba fechada no meio: a próxima aba acha a órfã e a marca `aborted`
//         (com o parcial) — sem timestamp, só pelo lock;
//  (v)    treino na aba: sessão + runs de ciclo gravadas (runs com `sessionId`
//         saem da lista plana);
//  (vi)   duas abas nunca executam o mesmo id (o lock é exclusivo).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeIdb } from './fakeIndexedDb.js';
import { FakeLockBroker, type FakeLockContext } from './fakeWebLocks.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter } from './fakeOpenRouter.js';
import { DECISION_CATALOG, oracleJev } from './fakeDecisions.js';
import { jevExample, type JevRunRecord, type JevSessionRecord } from '../src/engine/jev/index.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const DISCO_MORTO = { open: () => ({}) } as unknown as IDBFactory;

/** Ouro dos casos do exemplo (o fake "sabe" a resposta pelo estado). */
function ouroDe(cfg: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>();
  for (const c of cfg.cases as { state: unknown; expected: Record<string, unknown> }[]) m.set(JSON.stringify(c.state), c.expected);
  return m;
}

function jevFake(cfg: Record<string, unknown>, extra: { gate?: Promise<void>; onDecision?: () => void } = {}): FakeOpenRouter {
  const ouro = ouroDe(cfg);
  const oraculo = oracleJev({ goldOf: (state, qid) => ouro.get(JSON.stringify(state))?.[qid] });
  return fakeOpenRouter({
    decisionCatalog: DECISION_CATALOG,
    catalog: [catalogItem('caro/llm', 0.5, 0.5)],
    decisions: async (req) => {
      extra.onDecision?.();
      if (extra.gate) await extra.gate;
      return oraculo(req);
    },
  });
}

async function abrirAba(disco: FakeIdb, locks: FakeLockContext | null, fake?: FakeOpenRouter) {
  vi.resetModules();
  const idb = await import('../web/src/idb.js');
  idb.setIdbFactory(disco.factory);
  const runLocks = await import('../web/src/engine/runLocks.js');
  runLocks.setLockManager(locks);
  const storageHealth = await import('../web/src/storageHealth.js');
  storageHealth.setStorageManager(null);
  const gw = await import('../src/openrouter.js');
  if (fake) gw.setDefaultGateway(gw.createGateway({ fetch: fake.fetch, sleep: noSleep }));
  const api = await import('../web/src/api.js');
  const jev = await import('../web/src/jev/api.js');
  const store = await import('../web/src/jev/store.js');
  return {
    idb,
    runLocks,
    api,
    jev,
    store,
    fechar(): void {
      locks?.destroy();
      idb.setIdbFactory(DISCO_MORTO);
    },
  };
}

async function esperar(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const t0 = performance.now();
  while (!(await cond())) {
    if (performance.now() - t0 > timeoutMs) throw new Error('timeout esperando condição');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const runNoDisco = (disco: FakeIdb, id: string) => disco.get('jevRuns', id) as JevRunRecord | undefined;
const sessaoNoDisco = (disco: FakeIdb, id: string) => disco.get('jevSessions', id) as JevSessionRecord | undefined;

afterEach(() => {
  vi.resetModules();
});

describe('JEV no navegador — run de exemplo na aba', () => {
  it('(i) eval do exemplo: finished, record + resumo no IndexedDB v3, custo = fatura, lock solto', async () => {
    const disco = new FakeIdb();
    const broker = new FakeLockBroker();
    const cfg = { ...jevExample('triagem', 'eval'), budgetUsd: 0.05 };
    const fake = jevFake(cfg);
    const aba = await abrirAba(disco, broker.context('A'), fake);
    aba.api.setStoredKey(KEY);

    const { id, kind } = await aba.jev.startJev(cfg as never);
    expect(kind).toBe('run');
    await esperar(() => runNoDisco(disco, id)?.status === 'finished');

    const rec = runNoDisco(disco, id)!;
    expect(rec.client).toBe('browser');
    expect(rec.cases.length).toBe(40);
    const ct = rec.contestants[0].id;
    expect(rec.metrics[ct].accuracy).toBe(1);
    // Dinheiro MEDIDO: o que o record diz = o que o fake "cobrou".
    expect(rec.totalCostUsd).toBeCloseTo(fake.billedUsd(), 12);
    expect(fake.decisionRequests().length).toBe(40);
    // As decisões saíram pelo endpoint de decisões, com o Bearer da key (CORS aberto: sem proxy).
    const r0 = fake.decisionRequests()[0];
    expect(r0.url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(r0.headers.Authorization ?? r0.headers.authorization).toBe(`Bearer ${KEY}`);
    // Resumo na MESMA transação que o record.
    const resumo = disco.get('jevSummaries', id) as { kind: string; status: string; accuracy: number };
    expect(resumo).toMatchObject({ kind: 'run', status: 'finished', accuracy: 1 });
    const tx = disco.transactions.find((t) => t.stores.includes('jevRuns') && t.outcome === 'complete');
    expect(tx?.stores).toEqual(expect.arrayContaining(['jevRuns', 'jevSummaries']));
    // Lock solto depois da última gravação.
    await esperar(() => broker.holder(`prompt-builder:run:jev:${id}`) === undefined);
    expect(aba.jev.canCancelJev(id)).toBe(false);
  });

  it('(ii) recusas antes de gastar: sem key, lint com erro, área sensível, custo sem confirmação', async () => {
    const disco = new FakeIdb();
    const broker = new FakeLockBroker();
    const base = { ...jevExample('triagem', 'eval'), budgetUsd: 0.05 };
    const fake = jevFake(base);
    const aba = await abrirAba(disco, broker.context('A'), fake);

    // Sem key: re-prompt (KeyMissingError), nenhuma chamada.
    aba.api.setStoredKey('');
    await expect(aba.jev.startJev(base as never)).rejects.toMatchObject({ code: 'key-missing' });
    aba.api.setStoredKey(KEY);

    // Lint com erro (noul sem a chave false): JevConfigError, nada gasto.
    const quebrado = structuredClone(base) as Record<string, any>;
    quebrado.spec.questions.is_bug.criteria = { true: 'quebrado' };
    await expect(aba.jev.startJev(quebrado as never)).rejects.toMatchObject({ code: 'JEV_CONFIG' });

    // Área LGPD sensível: o Jev não é ZDR → recusa no pré-voo (fail-closed).
    const sensivel = { ...base, compliance: { area: 'saude' } };
    const recusa = await aba.jev.startJev(sensivel as never).catch((e: unknown) => e as Error);
    expect(recusa).toBeInstanceOf(Error);
    expect(String((recusa as Error).message)).toMatch(/typesafe\/jev-1\.13/);
    expect(String((recusa as Error).message)).toMatch(/saude|sensível|LGPD/i);

    // Custo acima do limiar sem "sim": recusa com a estimativa.
    const caro = { ...base, mode: 'compare', models: { decision: ['typesafe/jev-1.13'], llm: [{ modelId: 'caro/llm' }] } };
    const err = await aba.jev.startJev(caro as never).catch((e: unknown) => e);
    expect(aba.jev.isJevCostConfirmationRequired(err)).toBe(true);
    expect((err as { estimate: { usdHigh: number } }).estimate.usdHigh).toBeGreaterThan(1);

    expect(fake.decisionRequests()).toHaveLength(0);
    expect(fake.chatRequests()).toHaveLength(0);
    expect(disco.data.get('jevRuns')?.size ?? 0).toBe(0);
  });

  it('(iii) cancelar: nenhuma decisão nova sai; record aborted/cancelled com o parcial', async () => {
    const disco = new FakeIdb();
    const broker = new FakeLockBroker();
    const cfg = { ...jevExample('triagem', 'eval'), budgetUsd: 0.05 };
    let soltar: () => void = () => undefined;
    const gate = new Promise<void>((r) => (soltar = r));
    let vistas = 0;
    const fake = jevFake(cfg, { gate, onDecision: () => void vistas++ });
    const aba = await abrirAba(disco, broker.context('A'), fake);
    aba.api.setStoredKey(KEY);

    const { id } = await aba.jev.startJev(cfg as never);
    await esperar(() => vistas > 0);
    const antes = fake.decisionRequests().length;
    expect(aba.jev.cancelJev(id)).toBe(true);
    soltar();
    await esperar(() => runNoDisco(disco, id)?.status === 'aborted');
    const rec = runNoDisco(disco, id)!;
    expect(rec.stoppedReason).toBe('cancelled');
    // Nenhum POST depois do abort (as que estavam em voo podem ter saído antes).
    expect(fake.decisionRequests().length).toBe(antes);
    expect(rec.cells.some((c) => c.status === 'skipped')).toBe(true);
  });
});

describe('JEV no navegador — Web Locks e órfãs', () => {
  it('(iv) aba fechada no meio da run: a próxima aba marca a órfã (aborted + parcial) em ≤ 2 s', async () => {
    const disco = new FakeIdb();
    const broker = new FakeLockBroker();
    const cfg = { ...jevExample('triagem', 'eval'), budgetUsd: 0.05 };
    let vistas = 0;
    const fake = jevFake(cfg, { gate: new Promise<void>(() => undefined), onDecision: () => void vistas++ });
    const a = await abrirAba(disco, broker.context('A'), fake);
    a.api.setStoredKey(KEY);
    const { id } = await a.jev.startJev(cfg as never);
    await esperar(() => vistas > 0 && runNoDisco(disco, id)?.status === 'running');
    expect(broker.holder(`prompt-builder:run:jev:${id}`)).toBe('A');

    // Uma segunda aba vê a run VIVA (lock com dono): não marca nada.
    const b = await abrirAba(disco, broker.context('B'));
    expect(await b.jev.reconcileJev('run', id)).toBe('alive');
    expect(runNoDisco(disco, id)?.status).toBe('running');

    // A aba A fecha: o navegador solta o lock; B na carga acha a órfã.
    a.fechar();
    const t0 = performance.now();
    const c = await abrirAba(disco, broker.context('C'));
    const r = await c.jev.startJevOrphanWatch();
    expect(r.orphaned).toEqual([id]);
    expect(performance.now() - t0).toBeLessThan(2000);
    const rec = runNoDisco(disco, id)!;
    expect(rec.status).toBe('aborted');
    expect(rec.stoppedReason).toBe('cancelled');
    expect(rec.error).toMatch(/órfã/);
    expect((disco.get('jevSummaries', id) as { status: string }).status).toBe('aborted');
  });

  it('sem Web Locks: nada é marcado sozinho; a marcação manual funciona', async () => {
    const disco = new FakeIdb();
    const broker = new FakeLockBroker();
    const cfg = { ...jevExample('triagem', 'eval'), budgetUsd: 0.05 };
    const fake = jevFake(cfg, { gate: new Promise<void>(() => undefined) });
    const a = await abrirAba(disco, broker.context('A'), fake);
    a.api.setStoredKey(KEY);
    const { id } = await a.jev.startJev(cfg as never);
    await esperar(() => runNoDisco(disco, id)?.status === 'running');
    a.fechar();

    const semLocks = await abrirAba(disco, null);
    expect((await semLocks.jev.sweepJevOrphans()).orphaned).toEqual([]);
    expect(await semLocks.jev.reconcileJev('run', id)).toBe('unsupported');
    expect(runNoDisco(disco, id)?.status).toBe('running');
    expect(await semLocks.jev.markJevInterrupted('run', id)).toBe('orphaned');
    expect(runNoDisco(disco, id)?.status).toBe('aborted');
  });
});

describe('JEV no navegador — treino na aba', () => {
  it('(v) sessão de treino: record da sessão + runs de ciclo (com sessionId) no IndexedDB', async () => {
    const disco = new FakeIdb();
    const broker = new FakeLockBroker();
    const cfg = { ...jevExample('triagem', 'train'), budgetUsd: 0.2 };
    const fake = jevFake(cfg);
    const aba = await abrirAba(disco, broker.context('A'), fake);
    aba.api.setStoredKey(KEY);

    const { id, kind } = await aba.jev.startJev(cfg as never);
    expect(kind).toBe('session');
    await esperar(() => {
      const s = sessaoNoDisco(disco, id);
      return Boolean(s && s.status !== 'running');
    }, 15_000);
    const s = sessaoNoDisco(disco, id)!;
    expect(['finished', 'inconclusive']).toContain(s.status);
    expect(s.runIds.length).toBeGreaterThan(0);
    for (const rid of s.runIds) expect(runNoDisco(disco, rid)?.sessionId).toBe(id);
    const lista = await aba.store.listJevSummaries();
    expect(lista.find((x) => x.id === id)).toMatchObject({ kind: 'session', mode: 'train' });
    expect(lista.filter((x) => x.kind === 'run').every((x) => x.sessionId === id)).toBe(true);
    // Sessão com o lock do tipo 'session'; runs de ciclo são "vivas" pelo lock da sessão.
    await esperar(() => broker.holder(`prompt-builder:session:jev:${id}`) === undefined);
    expect(s.totalCostUsd).toBeCloseTo(fake.billedUsd(), 12);
  }, 30_000);
});
