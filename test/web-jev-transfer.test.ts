// Modo JEV — os DOIS caminhos da UI (chunk 2). O principal é o motor NA ABA
// (CORS aberto em /api/alpha/decisions); o reserva é o terminal: o mesmo
// jev-config@1 roda no CLI e o record volta para a SPA por arquivo. Garante:
//  (i)   `parseJevRecordFile` aceita o record cru do data-dir do CLI e o
//        envelope `jev show <id> --full --json`; recusa, com mensagem que diz o
//        que fazer, o RESUMO do `jev show`, uma CONFIG, record `running`, id
//        inválido, JSON quebrado e record incompleto;
//  (ii)  `importJevRecordFiles` grava record + resumo no IndexedDB v3 (a lista
//        e a tela acham), marca o cliente `node` (run pelo campo; sessão pelo
//        dono que só o Node grava) e não toca a rede;
//  (iii) `networkDiagnosis`: as mensagens com que cada runtime rejeita um fetch
//        sem resposta (CORS, DNS, offline, bloqueador) viram o banner; "total"
//        só quando nada respondeu; célula `skipped` e erro HTTP não contam.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeIdb } from './fakeIndexedDb.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { DECISION_CATALOG, oracleJev } from './fakeDecisions.js';
import { createGateway, getGateway, setDefaultGateway } from '../src/openrouter.js';
import { jevExample, parseJevConfig, resolveJevConfig, runJev, type JevRunRecord, type JevSessionRecord } from '../src/engine/jev/index.js';
import { isNetworkFailureMessage, networkDiagnosis, parseJevRecordFile } from '../web/src/jev/transfer.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const DISCO_MORTO = { open: () => ({}) } as unknown as IDBFactory;

/** Uma run "do terminal": o runner Node de verdade contra o fake (client 'node', com dono). */
async function runDoTerminal(): Promise<JevRunRecord> {
  const cfg = { ...jevExample('triagem', 'eval'), budgetUsd: 0.05 } as Record<string, unknown>;
  const ouro = new Map((cfg.cases as { state: unknown; expected: Record<string, unknown> }[]).map((c) => [JSON.stringify(c.state), c.expected]));
  const fake = fakeOpenRouter({
    decisionCatalog: DECISION_CATALOG,
    catalog: [catalogItem('caro/llm', 0.5, 0.5)],
    decisions: oracleJev({ goldOf: (state, qid) => ouro.get(JSON.stringify(state))?.[qid] }),
  });
  const prev = getGateway();
  setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
  try {
    const p = parseJevConfig(cfg);
    if (!p.ok) throw new Error(p.error);
    const r = resolveJevConfig(p.config);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return await runJev(r.resolved, { apiKey: KEY, client: 'node', owner: { pid: 4242, host: 'outra-maquina', startToken: null } });
  } finally {
    setDefaultGateway(prev);
  }
}

function sessaoDoTerminal(run: JevRunRecord): JevSessionRecord {
  return {
    format: 'jev-session@1',
    id: 'sessao-terminal-1',
    status: 'finished',
    theme: run.theme,
    config: run.config,
    modelId: 'typesafe/jev-1.13',
    originalSpec: run.specs[0],
    championSpec: run.specs[0],
    iterations: [],
    runIds: [run.id],
    policy: {},
    cost: run.cost,
    totalCostUsd: run.totalCostUsd,
    resolvedModels: [],
    warnings: [],
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    owner: { pid: 4242, host: 'outra-maquina', startToken: null },
  };
}

async function abrirAba(disco: FakeIdb) {
  vi.resetModules();
  const idb = await import('../web/src/idb.js');
  idb.setIdbFactory(disco.factory);
  const runLocks = await import('../web/src/engine/runLocks.js');
  runLocks.setLockManager(null);
  const storageHealth = await import('../web/src/storageHealth.js');
  storageHealth.setStorageManager(null);
  const jev = await import('../web/src/jev/api.js');
  const store = await import('../web/src/jev/store.js');
  return { jev, store, fechar: () => idb.setIdbFactory(DISCO_MORTO) };
}

afterEach(() => {
  vi.resetModules();
});

describe('parseJevRecordFile — o que o terminal entrega', () => {
  it('(i) aceita o record cru e o envelope `jev show --full --json`; recusa o resto com a dica certa', async () => {
    const run = await runDoTerminal();
    expect(run.status).toBe('finished');

    const cru = parseJevRecordFile(JSON.stringify(run));
    expect(cru).toMatchObject({ ok: true, kind: 'run' });
    const envelope = parseJevRecordFile(JSON.stringify({ ok: true, command: 'jev.show', data: { kind: 'jev-run', record: run } }));
    expect(envelope.ok && envelope.record.id).toBe(run.id);
    const sessao = parseJevRecordFile(JSON.stringify({ ok: true, command: 'jev.show', data: { kind: 'jev-session', record: sessaoDoTerminal(run) } }));
    expect(sessao).toMatchObject({ ok: true, kind: 'session' });

    const erro = (text: string) => {
      const r = parseJevRecordFile(text);
      expect(r.ok).toBe(false);
      return r.ok ? '' : r.error;
    };
    // O RESUMO do `jev show` (sem --full) não tem células: a dica aponta o --full.
    expect(erro(JSON.stringify({ ok: true, command: 'jev.show', data: { runId: run.id, kind: 'jev-run', contestants: [] } }))).toMatch(/--full --json/);
    // Uma CONFIG é outra coisa: vai para o Importar JSON da Nova run.
    expect(erro(JSON.stringify(jevExample('triagem', 'eval')))).toMatch(/CONFIGURA/);
    // Ainda rodando no terminal: a varredura de órfãs desta aba a mataria.
    expect(erro(JSON.stringify({ ...run, status: 'running' }))).toMatch(/running/);
    expect(erro(JSON.stringify({ ...run, id: '../../etc' }))).toMatch(/id inválido/);
    expect(erro('{ quebrado')).toMatch(/JSON/);
    const { cells: _cells, ...semCelulas } = run;
    expect(erro(JSON.stringify(semCelulas))).toMatch(/`cells`/);
    expect(erro(JSON.stringify({ format: 'arena-run@1' }))).toMatch(/arena-run@1/);
  });

  it('L7: record à mão/antigo sem o que as telas desreferenciam é recusado no import (não quebra ao abrir)', async () => {
    const run = await runDoTerminal();
    const erro = (rec: unknown): string => {
      const r = parseJevRecordFile(JSON.stringify(rec));
      return r.ok ? '' : r.error;
    };
    for (const campo of ['confusion', 'byQuestion', 'byType', 'cost', 'incompleteCaseIds', 'warnings', 'resolvedModels'] as const) {
      const { [campo]: _fora, ...sem } = run;
      expect(erro(sem)).toContain(`\`${campo}\``);
    }
    expect(erro({ ...run, cost: { totalUsd: 0 } })).toContain('`cost.byKind`');
    expect(erro({ ...run, incompleteCaseIds: {} })).toContain('`incompleteCaseIds`');
    const s = sessaoDoTerminal(run);
    const { cost: _c, ...sessaoSemCusto } = s;
    expect(erro(sessaoSemCusto)).toContain('`cost`');
    expect(erro({ ...s, resolvedModels: {} })).toContain('`resolvedModels`');
    // o record íntegro segue aceito
    expect(parseJevRecordFile(JSON.stringify(run)).ok).toBe(true);
    expect(parseJevRecordFile(JSON.stringify(s)).ok).toBe(true);
  });
});

describe('importJevRecordFiles — a SPA mostra o que rodou no terminal', () => {
  it('(ii) grava record + resumo no IndexedDB, cliente `node`, runs antes da sessão, sem rede', async () => {
    const run = await runDoTerminal();
    const sess = sessaoDoTerminal(run);
    const cicloRun = { ...run, id: 'run-do-ciclo-1', sessionId: sess.id, iteration: 0 };
    const disco = new FakeIdb();
    const fetchSpy = vi.fn(() => {
      throw new Error('importar NÃO pode tocar a rede');
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const aba = await abrirAba(disco);
      const res = await aba.jev.importJevRecordFiles([
        // a sessão vem PRIMEIRO no arquivo; a importação grava as runs antes
        { name: 'sessao.json', text: JSON.stringify(sess) },
        { name: 'run.json', text: JSON.stringify(run) },
        { name: 'ciclo.json', text: JSON.stringify({ ok: true, command: 'jev.show', data: { kind: 'jev-run', record: cicloRun } }) },
        { name: 'config.json', text: JSON.stringify(jevExample('triagem', 'eval')) },
      ]);
      expect(res.map((r) => [r.name, r.ok, r.kind ?? null])).toEqual([
        ['sessao.json', true, 'session'],
        ['run.json', true, 'run'],
        ['ciclo.json', true, 'run'],
        ['config.json', false, null],
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();

      // A tela acha (loadJevRun) e a lista acha (resumo na mesma transação).
      expect((await aba.jev.getJevRun(run.id))?.cells.length).toBe(run.cells.length);
      expect((await aba.jev.getJevSession(sess.id))?.runIds).toEqual([run.id]);
      const lista = await aba.jev.listJevHistory();
      const porId = new Map(lista.map((s) => [s.id, s]));
      expect(porId.get(run.id)).toMatchObject({ kind: 'run', client: 'node', status: 'finished', accuracy: 1 });
      expect(porId.get(sess.id)).toMatchObject({ kind: 'session', client: 'node', cases: run.cases.length });
      // Run de ciclo com sessionId: fica fora da lista plana (abre pela sessão) — igual às da aba.
      expect(porId.get('run-do-ciclo-1')?.sessionId).toBe(sess.id);
      // Nada `running` importado: a varredura de órfãs não tem o que marcar.
      expect(lista.every((s) => s.status !== 'running')).toBe(true);
      aba.fechar();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('networkDiagnosis — a aba não alcançou o endpoint', () => {
  const cel = (status: string, message?: string) => ({ caseId: 'c', contestantId: 'd', rep: 0, status, ...(message ? { error: { kind: 'error', message } } : {}) });

  it('(iii) mensagens de fetch sem resposta de cada runtime; total só quando nada respondeu', () => {
    for (const m of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed', 'TypeError: fetch failed', 'Network request failed']) {
      expect(isNetworkFailureMessage(m)).toBe(true);
    }
    for (const m of ['HTTP 400: {"detail":"x"}', 'Sem créditos na conta.', 'timeout de 30000 ms', undefined]) {
      expect(isNetworkFailureMessage(m)).toBe(false);
    }
    const tudo = { cells: [cel('error', 'Failed to fetch'), cel('error', 'Failed to fetch'), cel('skipped')] } as unknown as JevRunRecord;
    expect(networkDiagnosis(tudo)).toEqual({ failed: 2, attempted: 2, total: true });
    const parte = { cells: [cel('ok'), cel('invalid'), cel('error', 'Load failed'), cel('error', 'HTTP 500')] } as unknown as JevRunRecord;
    expect(networkDiagnosis(parte)).toEqual({ failed: 1, attempted: 4, total: false });
    const limpa = { cells: [cel('ok'), cel('error', 'HTTP 400: {"detail":"x"}'), cel('skipped')] } as unknown as JevRunRecord;
    expect(networkDiagnosis(limpa)).toBeNull();
  });
});
