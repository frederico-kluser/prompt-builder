// IMPL-081 (R-10:REC-2) — RETOMADA de ponta a ponta nos DOIS motores (Node e
// SPA) e no CLI (`runs resume`), com o transporte FALSO (zero rede, zero gasto
// real). Critérios:
//   (i)  run parada depois de K chamadas concluídas + retomada => só as N−K
//        que faltavam são pagas (0 chamada paga repetida);
//   (ii) o grupo competidores+julgamento NUNCA é retomado pela metade: a
//        retomada re-executa a etapa inteira (resposta + veredito) — só as
//        chamadas vêm do journal — para K em cada fase (G1 feito; respostas
//        feitas e juízes não; meio do julgamento);
//   dinheiro sem contar em dobro: o gasto da retomada é SÓ o dela (== fatura
//   dela), o das tentativas anteriores fica em `resume.priorSpentUsd`, os
//   replays saem como `replayed` a US$ 0 e o teto é o que sobrou;
//   cancelamento durante a retomada continua sendo CONTROLE.
// (A morte REAL do processo — SIGKILL — está em test/storage-journal.test.ts.)

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { RunCancelled } from '../src/budget.js';
import { planResume, resumeToCompletion, runToCompletion as runNode } from '../src/orchestrator.js';
import { getDataDir, listRuns, loadCallJournal, setDataDir } from '../src/storage.js';
// Imports ESTÁTICOS de propósito: o teste da aba recarregada faz
// `vi.resetModules()` — um `import()` dinâmico depois dele pegaria um gateway
// padrão NOVO (real), fora do fake.
import { cmdRuns } from '../src/cli/commands/misc.js';
import { cmdRun } from '../src/cli/commands/run.js';
import { resetOutputState, toCliError } from '../src/cli/output.js';
import { COST_ROLES, type RunConfig, type RunRecord } from '../src/types.js';
import { noSleep } from './fakeOpenRouter.js';
import {
  JOURNAL_COMPARE,
  JOURNAL_COMPARE_CALLS,
  JOURNAL_KEY as KEY,
  journalPipeline,
  type JournalPipeline,
} from './journalFixture.js';

let anterior: OpenRouterGateway | undefined;
let silencio: Array<{ mockRestore(): void }> = [];
const pendentes: JournalPipeline[] = [];

function usar(fake: JournalPipeline): void {
  const prev = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
  anterior ??= prev;
  pendentes.push(fake);
}

beforeEach(() => {
  silencio = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
});
afterEach(() => {
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
  for (const f of pendentes.splice(0)) f.release();
  silencio.forEach((s) => s.mockRestore());
  vi.unstubAllGlobals();
});

async function esperar(cond: () => boolean | Promise<boolean>, ms = 10_000, oque = 'condição'): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`${oque} não chegou a tempo`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const soma = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** O que TODA retomada tem de garantir (os dois motores). */
function conferirRetomada(rec: RunRecord, o: { N: number; K: number; pagasAgora: JournalPipeline; anterior: RunRecord }): void {
  // (i) só o que faltava foi pago
  expect(o.pagasAgora.chatRequests().length, 'chamadas pagas na retomada').toBe(o.N - o.K);
  // (ii) etapa inteira: toda etapa com respostas E veredito, nada cortado
  expect(rec.status, rec.error).toBe('finished');
  expect(rec.stages).toHaveLength(JOURNAL_COMPARE.stages);
  for (const st of rec.stages) {
    expect(st.incomplete).toBeFalsy();
    expect(st.responses).toHaveLength(2);
    expect(st.referenceJudge, `etapa ${st.index} sem veredito`).toBeDefined();
  }
  expect(rec.judgeScoreByContestant).toBeDefined();
  // dinheiro: o gasto da retomada é o DELA (== fatura dela) — o anterior à parte
  expect(rec.totalCostUsd).toBeCloseTo(o.pagasAgora.billedUsd(), 10);
  const byRole = rec.costByRole!;
  expect(soma(COST_ROLES.map((r) => byRole[r].calls))).toBe(o.N - o.K);
  expect(soma(COST_ROLES.map((r) => byRole[r].replayedCalls ?? 0))).toBe(o.K);
  const replays = (rec.callLog ?? []).filter((c) => c.status === 'replayed');
  expect(replays).toHaveLength(o.K);
  expect(replays.every((c) => c.usd === 0 && (c.replayedFromUsd ?? 0) > 0)).toBe(true);
  expect(soma(Object.values(rec.costByContestant ?? {}))).toBeLessThanOrEqual(rec.totalCostUsd + 1e-12);
  expect(rec.resume).toMatchObject({
    attempt: 2,
    journalCalls: o.K,
    replayedCalls: o.K,
    previousStatus: 'aborted',
    previousStoppedReason: 'cancelled',
  });
  expect(rec.resume!.priorSpentUsd).toBeCloseTo(o.anterior.totalCostUsd, 10);
  expect(rec.resume!.replayedUsd).toBeCloseTo(soma(replays.map((c) => c.replayedFromUsd ?? 0)), 10);
  // o teto desta tentativa é o que SOBROU do original
  const prior = o.anterior.totalCostUsd + (o.anterior.costLedger?.pendingUsd ?? 0);
  expect(rec.budgetUsd).toBeCloseTo(JOURNAL_CFG.budgetUsd - prior, 10);
}

const JOURNAL_CFG = { ...JOURNAL_COMPARE, budgetUsd: 1 };

/**
 * Pontos de corte (K chamadas concluídas) em cada fase do pipeline da fixture
 * (5 cenários: 2 lotes de datagen, 5 gabaritos, 10 respostas, 10 vereditos,
 * 10 duelos). O teste confere que o journal tem EXATAMENTE estes papéis.
 */
const FASES = [
  [7, 'G1 feito: cenários + gabaritos', { datagen: 2, gabarito: 5 }],
  [17, 'respostas feitas, nenhum veredito', { datagen: 2, gabarito: 5, competitor: 10 }],
  [22, 'meio do julgamento', { datagen: 2, gabarito: 5, competitor: 10, judge: 5 }],
] as const;

// ===========================================================================
// Motor Node
// ===========================================================================

describe('IMPL-081 — retomada no motor Node', () => {
  let dir: string;
  let dirAnterior: string;
  let N = 0;

  beforeAll(async () => {
    dirAnterior = getDataDir();
    dir = mkdtempSync(path.join(tmpdir(), 'pb-resume-node-'));
    setDataDir(dir);
    // N = chamadas pagas de uma run COMPLETA desta config (a referência).
    const cheio = journalPipeline();
    const prev = setDefaultGateway(createGateway({ fetch: cheio.fetch, sleep: noSleep }));
    const silencia = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const rec = await runNode(JOURNAL_CFG as unknown as RunConfig, KEY, { runId: 'resume-node-cheia' });
      expect(rec.status, rec.error).toBe('finished');
      N = cheio.chatRequests().length;
      // run CONCLUÍDA não guarda journal (não há o que retomar)
      expect(existsSync(path.join(dir, 'runs', 'resume-node-cheia.journal'))).toBe(false);
    } finally {
      silencia.mockRestore();
      setDefaultGateway(prev);
    }
    // 2 lotes de datagen + 5 gabaritos + 10 respostas + 10 vereditos + 10 duelos
    expect(cheio.byRole()).toEqual({ datagen: 2, gabarito: 5, competitor: 10, judge: 10, duel: 10 });
    expect(N).toBe(JOURNAL_COMPARE_CALLS);
  });
  afterAll(() => {
    setDataDir(dirAnterior);
    rmSync(dir, { recursive: true, force: true });
  });

  /** Tentativa 1: K chamadas concluem, o resto fica em voo, e o usuário cancela. */
  async function tentativaCortada(runId: string, K: number): Promise<RunRecord> {
    const f1 = journalPipeline({ hangAfter: K });
    usar(f1);
    const ac = new AbortController();
    const fim = runNode(JOURNAL_CFG as unknown as RunConfig, KEY, { runId, ctx: { signal: ac.signal } });
    await esperar(async () => (await loadCallJournal(runId)).length === K, 10_000, `journal com ${K}`);
    ac.abort(new RunCancelled('clique'));
    const rec = (await fim) as RunRecord;
    expect(rec.status).toBe('aborted');
    expect(rec.stoppedReason).toBe('cancelled');
    expect((await loadCallJournal(runId)).length, 'o journal da run abortada fica para a retomada').toBe(K);
    return rec;
  }

  for (const [K, fase, papeis] of FASES) {
    it(`K=${K} (${fase}): retomada paga só N−K e reconstrói as etapas inteiras`, async () => {
      const runId = `resume-node-k${K}`;
      const anteriorRec = await tentativaCortada(runId, K);
      const plano = await planResume(runId);
      expect(plano.ok).toBe(true);
      if (!plano.ok) return;
      expect(plano.plan.entries).toHaveLength(K);
      // a fase é a que o nome diz: o journal tem exatamente estes papéis
      const noJournal: Record<string, number> = {};
      for (const e of plano.plan.entries) noJournal[e.role] = (noJournal[e.role] ?? 0) + 1;
      expect(noJournal).toEqual(papeis);
      const f2 = journalPipeline();
      usar(f2);
      const rec = (await resumeToCompletion(plano.plan, KEY)) as RunRecord;
      conferirRetomada(rec, { N, K, pagasAgora: f2, anterior: anteriorRec });
      expect(rec.id).toBe(runId);
      expect(rec.startedAt).toBe(anteriorRec.startedAt);
      // concluída: o journal some
      expect(await loadCallJournal(runId)).toEqual([]);
    });
  }

  it('cancelar DURANTE a retomada segue sendo controle — e a 2ª retomada ainda não repaga nada', async () => {
    const runId = 'resume-node-cancel-2x';
    const primeira = await tentativaCortada(runId, 17);
    const p1 = await planResume(runId);
    if (!p1.ok) throw new Error(p1.reason);
    // Retomada 1: os 17 replays saem na hora; a 1ª chamada NOVA fica em voo e o usuário cancela.
    const f2 = journalPipeline({ hangAfter: 0 });
    usar(f2);
    const ac = new AbortController();
    const fim = resumeToCompletion(p1.plan, KEY, { ctx: { signal: ac.signal } });
    await esperar(() => f2.chatRequests().length > 0, 10_000, '1ª chamada nova');
    ac.abort(new RunCancelled('clique na retomada'));
    const rec2 = (await fim) as RunRecord;
    expect(rec2.status).toBe('aborted');
    expect(rec2.stoppedReason).toBe('cancelled');
    expect(rec2.resume?.replayedCalls).toBe(17);
    expect(rec2.totalCostUsd, 'nada medido nesta tentativa').toBe(0);
    // Retomada 2: tudo o que foi pago (as 17) continua vindo do journal.
    const p2 = await planResume(runId);
    if (!p2.ok) throw new Error(p2.reason);
    const f3 = journalPipeline();
    usar(f3);
    const rec3 = (await resumeToCompletion(p2.plan, KEY)) as RunRecord;
    expect(rec3.status, rec3.error).toBe('finished');
    expect(f3.chatRequests().length).toBe(N - 17);
    expect(rec3.resume).toMatchObject({ attempt: 3, replayedCalls: 17 });
    // gasto das tentativas anteriores ACUMULA (1ª + 2ª), nunca é somado ao desta
    expect(rec3.resume!.priorSpentUsd).toBeCloseTo(primeira.totalCostUsd + rec2.totalCostUsd, 10);
    expect(rec3.totalCostUsd).toBeCloseTo(f3.billedUsd(), 10);
  });

  it('porta suave da retomada desconta o que o journal cobre: o teto que SOBROU não recusa G2 já pago', async () => {
    // G2 inteiro (respostas + vereditos) no journal; na retomada ele volta a
    // US$ 0 — projetá-lo de novo recusaria o grupo com o teto da continuação.
    const K = 27; // 2 datagen + 5 gabaritos + 10 respostas + 10 vereditos
    const runId = 'resume-node-porta';
    const f1 = journalPipeline({ hangAfter: K, price: 1e-5 });
    usar(f1);
    const ac = new AbortController();
    const fim = runNode({ ...JOURNAL_CFG, budgetUsd: 100 } as unknown as RunConfig, KEY, { runId, ctx: { signal: ac.signal } });
    await esperar(async () => (await loadCallJournal(runId)).length === K, 10_000, 'journal com G2');
    ac.abort(new RunCancelled('clique'));
    await fim;
    const plano = await planResume(runId);
    if (!plano.ok) throw new Error(plano.reason);
    const papeis = plano.plan.entries.map((e) => e.role);
    expect(papeis.filter((r) => r === 'judge')).toHaveLength(10);
    // Projeção de G2 sem desconto × o que o journal já pagou nele.
    const { estimateInputFromConfig, estimateRunCost } = await import('../src/estimate.js');
    const { parseModelsPayload } = await import('../src/openrouter.js');
    const catalogo = parseModelsPayload(await (await f1.fetch('https://x/api/v1/models')).json());
    const est = estimateRunCost(
      estimateInputFromConfig(JOURNAL_CFG as never, { contestantIds: ['fake/a', 'fake/b'] }),
      catalogo,
      { unknownPrice: 'worst-case' },
    );
    const g2 = est.byRole.competitor + est.byRole.judge;
    const pagoG2 = plano.plan.entries
      .filter((e) => e.role === 'competitor' || e.role === 'judge')
      .reduce((a, e) => a + e.result.cost.usd, 0);
    const teto = Math.max(0, g2 - pagoG2) + pagoG2 / 2; // cabe com desconto, não sem
    expect(g2, 'pré-condição: sem desconto a porta G2 recusaria').toBeGreaterThan(teto);
    const f2 = journalPipeline({ price: 1e-5 });
    usar(f2);
    const rec = (await resumeToCompletion(plano.plan, KEY, { budgetUsd: teto })) as RunRecord;
    expect(rec.budgetUsd).toBeCloseTo(teto, 12);
    expect(rec.stoppedAtPhase, 'G2 não foi recusado').not.toBe('competitors');
    for (const st of rec.stages) expect(st.referenceJudge).toBeDefined();
    expect(f2.byRole().competitor ?? 0).toBe(0);
    expect(f2.byRole().judge ?? 0).toBe(0);
  });

  it('run concluída / inexistente: planResume recusa sem gastar nada', async () => {
    const r1 = await planResume('resume-node-cheia');
    expect(r1).toMatchObject({ ok: false });
    expect(!r1.ok && r1.reason).toMatch(/terminou/);
    expect(await planResume('nao-existe-0000')).toMatchObject({ ok: false, record: null });
  });
});

// ===========================================================================
// Motor da SPA (IndexedDB falso) + api.ts
// ===========================================================================

describe('IMPL-081 — retomada no motor da SPA (journal no IndexedDB)', () => {
  let N = 0;
  let idb: import('./fakeIndexedDb.js').FakeIdb;

  beforeEach(async () => {
    const { FakeIdb } = await import('./fakeIndexedDb.js');
    const { setIdbFactory } = await import('../web/src/idb.js');
    idb = new FakeIdb();
    setIdbFactory(idb.factory);
    const { resetStorageHealth } = await import('../web/src/storageHealth.js');
    resetStorageHealth();
  });
  afterEach(async () => {
    const { setIdbFactory } = await import('../web/src/idb.js');
    setIdbFactory(undefined);
  });

  async function web() {
    const orch = await import('../web/src/engine/orchestrator.js');
    const cj = await import('../web/src/engine/callJournal.js');
    const storage = await import('../web/src/engine/storage.js');
    return { orch, cj, storage };
  }

  async function referencia(): Promise<number> {
    return N || JOURNAL_COMPARE_CALLS;
  }

  async function tentativaCortadaWeb(runId: string, K: number): Promise<RunRecord> {
    const { orch, cj } = await web();
    const f1 = journalPipeline({ hangAfter: K });
    usar(f1);
    const fim = orch.runToCompletion(JOURNAL_CFG as never, KEY, { runId });
    await esperar(async () => (await cj.loadIdbCallJournal(runId)).length === K, 10_000, `journal web com ${K}`);
    expect(orch.cancelRun(runId)).toBe(true);
    const rec = (await fim) as RunRecord;
    expect(rec.status).toBe('aborted');
    expect(rec.stoppedReason).toBe('cancelled');
    return rec;
  }

  it('run concluída na SPA não deixa journal no IndexedDB (e a abortada deixa)', async () => {
    const { orch, cj } = await web();
    const cheio = journalPipeline();
    usar(cheio);
    const rec = (await orch.runToCompletion(JOURNAL_CFG as never, KEY, { runId: 'resume-web-concluida' })) as RunRecord;
    expect(rec.status, rec.error).toBe('finished');
    N = cheio.chatRequests().length;
    expect(N, 'mesmo nº de chamadas no motor da SPA').toBe(JOURNAL_COMPARE_CALLS);
    expect(await cj.loadIdbCallJournal('resume-web-concluida')).toEqual([]);
    const ops = idb.transactions.filter((t) => t.ops.some((o) => o.id.startsWith('journal:resume-web-concluida:')));
    expect(ops.length, 'gravou durante a run').toBeGreaterThan(0);
    for (const t of ops.filter((t) => t.ops.some((o) => o.store === 'runs' && o.kind !== 'delete'))) {
      expect(t.durability, 'append do journal = checkpoint strict').toBe('strict');
    }
    await tentativaCortadaWeb('resume-web-abortada', 7);
    expect(await cj.loadIdbCallJournal('resume-web-abortada')).toHaveLength(7);
  });

  it('K=22 (meio do julgamento): resumeRun paga só N−K, etapas inteiras, gasto sem dobrar', async () => {
    const n = await referencia();
    const runId = 'resume-web-k22';
    const anteriorRec = await tentativaCortadaWeb(runId, 22);
    const { orch, cj } = await web();
    const f2 = journalPipeline();
    usar(f2);
    const { record } = await orch.resumeRun(runId, KEY);
    await esperar(() => record.status !== 'running', 10_000, 'fim da retomada');
    // a limpeza do journal é o último passo do fechamento (depois do checkpoint final)
    await esperar(async () => (await cj.loadIdbCallJournal(runId)).length === 0, 10_000, 'journal limpo');
    conferirRetomada(record as RunRecord, { N: n, K: 22, pagasAgora: f2, anterior: anteriorRec });
    expect(await cj.loadIdbCallJournal(runId), 'concluída: journal limpo').toEqual([]);
  });

  it('api.ts resumeRun: órfã (aba recarregada — record "running" sem dono) é marcada e retomada; concluída recusa', async () => {
    vi.stubGlobal('localStorage', { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined });
    const n = await referencia();
    const runId = 'resume-web-orfa';
    const anteriorRec = await tentativaCortadaWeb(runId, 7);
    const { storage } = await web();
    // A aba MORREU no meio: o disco ficou com 'running' e ninguém segura o lock…
    await storage.saveRun({ ...anteriorRec, status: 'running', stoppedReason: undefined, finishedAt: undefined } as never);
    // …e a aba nova começa do zero (módulos novos, sem o record em memória).
    vi.resetModules();
    const { setIdbFactory } = await import('../web/src/idb.js');
    setIdbFactory(idb.factory);
    const gwNovo = await import('../src/openrouter.js');
    const f2 = journalPipeline();
    pendentes.push(f2);
    const gwAntes = gwNovo.setDefaultGateway(gwNovo.createGateway({ fetch: f2.fetch, sleep: noSleep }));
    const api = await import('../web/src/api.js');
    const id = await api.resumeRun(runId).finally(() => undefined);
    expect(id).toBe(runId);
    await esperar(() => api.getLiveRun(runId)?.status !== 'running', 10_000, 'fim da retomada (api)');
    const rec = api.getLiveRun(runId) as unknown as RunRecord;
    expect(rec.status, rec.error).toBe('finished');
    expect(f2.chatRequests().length).toBe(n - 7);
    expect(rec.resume).toMatchObject({ attempt: 2, replayedCalls: 7, previousStoppedReason: 'orphan' });
    expect(api.runResumeRefusal(rec)).toMatch(/terminou/);
    await expect(api.resumeRun(runId)).rejects.toThrow(/não pode ser retomada/);
    gwNovo.setDefaultGateway(gwAntes);
  });
});

// ===========================================================================
// CLI: `runs resume <id>` (em processo)
// ===========================================================================

describe('IMPL-081 — CLI `runs resume <id>`', () => {
  let dir: string;
  const envSalvo: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ['CI', 'OPENROUTER_API_KEY', 'PROMPT_BUILDER_HOME', 'PB_DAILY_CAP_USD']) envSalvo[k] = process.env[k];
    process.env.CI = '1';
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.PROMPT_BUILDER_HOME;
    dir = mkdtempSync(path.join(tmpdir(), 'pb-resume-cli-'));
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(envSalvo)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function cli(argv: string[]): Promise<{ exit: number; json?: Record<string, unknown>; errorCode?: string; details?: unknown }> {
    resetOutputState();
    const out: string[] = [];
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      out.push(String(c));
      return true;
    });
    const se = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const exit =
        argv[0] === 'runs'
          ? await cmdRuns([...argv.slice(1), '--data-dir', dir, '--json'])
          : await cmdRun('compare', [...argv, '--data-dir', dir, '--json']);
      return { exit, json: JSON.parse(out.join('')) as Record<string, unknown> };
    } catch (e) {
      const err = toCliError(e);
      return { exit: err.code, errorCode: err.errorCode, details: err.details };
    } finally {
      so.mockRestore();
      se.mockRestore();
    }
  }

  it('compare cortado por falta de crédito (exit 5) e retomado: exit 0, só N−K pagas, `resume` no payload; 2ª vez recusa', async () => {
    const cfgFile = path.join(dir, 'compare.json');
    writeFileSync(cfgFile, JSON.stringify(JOURNAL_COMPARE));
    const N = JOURNAL_COMPARE_CALLS;

    // Tentativa 1: K=17 e a conta fica sem crédito (402 — exit 5, run 'error').
    const K = 17;
    const f1 = journalPipeline({ failAfter: K });
    usar(f1);
    const r1 = await cli(['--config', cfgFile, '--budget', '5', '--yes', '--key', KEY]);
    expect(r1.exit, JSON.stringify(r1)).toBe(5);
    const runId = (await listRuns()).find((r) => r.status === 'error')?.id ?? '';
    expect(runId).not.toBe('');

    const f2 = journalPipeline();
    usar(f2);
    const r2 = await cli(['runs', 'resume', runId, '--key', KEY]);
    expect(r2.exit, JSON.stringify(r2)).toBe(0);
    expect(f2.chatRequests().length).toBe(N - K);
    const data = r2.json?.data as { runId: string; status: string; totalCostUsd: number; resume?: Record<string, unknown> };
    expect(data).toMatchObject({ runId, status: 'finished' });
    expect(data.totalCostUsd).toBeCloseTo(f2.billedUsd(), 10);
    expect(data.resume).toMatchObject({ attempt: 2, replayedCalls: K, previousStatus: 'error' });

    const r3 = await cli(['runs', 'resume', runId, '--key', KEY]);
    expect(r3).toMatchObject({ exit: 2, errorCode: 'run.not_resumable' });
  });
});
