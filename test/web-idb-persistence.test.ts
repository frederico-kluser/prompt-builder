// IMPL-022 (R-09:REC-6) — o IndexedDB da SPA não perde runs em silêncio.
//
// Antes: idbPut/idbPutMany terminavam em `catch {}` (QuotaExceededError/despejo
// viravam perda muda), saveRun gravava record e resumo em DUAS transações
// independentes (podiam divergir) e não havia navigator.storage.persist().
// Estes testes provam, com um IndexedDB FALSO escrito à mão (test/fakeIndexedDb.ts
// — atômico por transação, cota no commit) e transporte falso do OpenRouter
// (zero rede, zero gasto):
//   (a) persist() na primeira run + estado negado que a UI mostra;
//   (b) cota simulada => evento `storage.quota_exceeded` + aviso, e nenhum
//       catch vazio em idbPut/saveRun;
//   (c) record + resumo na MESMA transação: grava os dois ou nenhum;
//   (d) run com o disco cheio termina, avisa, segue viva e salva ao tentar de novo.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { idbPut, idbWrite, isIdbWriteError, setIdbFactory } from '../web/src/idb.js';
import {
  getStorageHealth,
  refreshPersistState,
  reportWriteFailure,
  requestPersistentStorage,
  resetStorageHealth,
  setStorageManager,
  storageNoticeContent,
  type StorageManagerLike,
} from '../web/src/storageHealth.js';
import { listRuns, loadRun, loadSession, saveRun, saveSession } from '../web/src/engine/storage.js';
import { getRunRecord, subscribeRun, subscribeSession } from '../web/src/engine/events.js';
import { runToCompletion } from '../web/src/engine/orchestrator.js';
import { savePrompt } from '../web/src/engine/promptStore.js';
import { normalizeRunRecord } from '../web/src/engine/normalize.js';
import type { RunEvent, RunRecord, SessionEvent, SessionRecord } from '../web/src/engine/types.js';
import type { RunConfig } from '../src/types.js';
import { FakeIdb } from './fakeIndexedDb.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { expectPipelineDone } from './runOutcome.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let fake: FakeIdb;
let silencio: Array<{ mockRestore(): void }> = [];
let gatewayAnterior: OpenRouterGateway | undefined;

beforeEach(() => {
  fake = new FakeIdb();
  setIdbFactory(fake.factory);
  setStorageManager(null);
  silencio = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
});

afterEach(() => {
  setIdbFactory(undefined);
  setStorageManager(undefined);
  resetStorageHealth();
  if (gatewayAnterior) setDefaultGateway(gatewayAnterior);
  gatewayAnterior = undefined;
  silencio.forEach((s) => s.mockRestore());
  vi.unstubAllGlobals();
});

let seq = 0;
function runRecord(over: Partial<RunRecord> = {}): RunRecord {
  seq += 1;
  return {
    id: `run-${seq}`,
    status: 'running',
    config: { mode: 'compare', theme: 'suporte', stages: 2, competitorModelIds: ['a', 'b'] } as never,
    mode: 'compare',
    contestants: [],
    stages: [],
    scoreboard: {},
    costByContestant: {},
    totalCostUsd: 0,
    startedAt: new Date().toISOString(),
    ...over,
  } as RunRecord;
}

function sessionRecord(over: Partial<SessionRecord> = {}): SessionRecord {
  seq += 1;
  return {
    id: `sess-${seq}`,
    status: 'running',
    config: { mode: 'training', theme: 'suporte', iterations: 2 } as never,
    runIds: [],
    bestPromptByIteration: [],
    totalCostUsd: 0,
    startedAt: new Date().toISOString(),
    ...over,
  } as SessionRecord;
}

function coletarRun(runId: string): { eventos: RunEvent[]; parar: () => void } {
  const eventos: RunEvent[] = [];
  const parar = subscribeRun(runId, (e) => eventos.push(e));
  return { eventos, parar };
}

const storageEvents = <E extends { type: string }>(evs: E[]): E[] =>
  evs.filter((e) => e.type.startsWith('storage.'));

// ---------------------------------------------------------------------------
// (b) erro de gravação vira evento/aviso — nunca catch vazio
// ---------------------------------------------------------------------------

describe('IMPL-022 (b) gravação no IndexedDB nunca falha em silêncio', () => {
  it('idbPut REJEITA com IdbWriteError classificado quando a cota estoura (antes: catch vazio)', async () => {
    fake.quotaBytes = 10;
    const err = await idbPut('prompts', { id: 'p1', text: 'x'.repeat(200) } as never).catch((e: unknown) => e);
    expect(isIdbWriteError(err)).toBe(true);
    expect(err).toMatchObject({ code: 'idb-write-failed', kind: 'quota', stores: ['prompts'] });
    expect((err as Error).message).toMatch(/Sem espaço/);
    expect(fake.get('prompts', 'p1')).toBeUndefined();
  });

  it('IndexedDB ausente ou que não abre => kind "unavailable"; falha ao abrir não fica em cache', async () => {
    setIdbFactory(null);
    await expect(idbPut('prompts', { id: 'p1' })).rejects.toMatchObject({ kind: 'unavailable' });

    setIdbFactory(fake.factory);
    fake.openFailure = 'InvalidStateError'; // ex.: Firefox em janela privada
    await expect(idbPut('prompts', { id: 'p1' })).rejects.toMatchObject({ kind: 'unavailable' });
    fake.openFailure = undefined;
    await expect(idbPut('prompts', { id: 'p1' })).resolves.toBeUndefined();
    expect(fake.get('prompts', 'p1')).toEqual({ id: 'p1' });
  });

  it('conexão fechada pelo navegador (despejo) reabre na próxima escrita', async () => {
    await idbPut('prompts', { id: 'p1' });
    const abertas = fake.opens;
    fake.evict();
    await idbPut('prompts', { id: 'p2' });
    expect(fake.opens).toBe(abertas + 1);
    expect(fake.get('prompts', 'p2')).toEqual({ id: 'p2' });
  });

  it('saveRun sob cota: evento storage.quota_exceeded UMA vez por episódio + aviso visível; recupera ao liberar espaço', async () => {
    const rec = runRecord({ theme: 'x'.repeat(500) } as never);
    const { eventos, parar } = coletarRun(rec.id);
    fake.quotaBytes = 50;

    expect(await saveRun(rec)).toBe(false); // não rejeita: a run não vira `error` por disco cheio
    expect(await saveRun(rec, { durability: 'relaxed' })).toBe(false); // batida seguinte, mesma falha

    const ev = storageEvents(eventos);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'storage.quota_exceeded', runId: rec.id, kind: 'quota' });
    expect(getStorageHealth().unsaved[`run:${rec.id}`]).toMatchObject({ kind: 'quota', failures: 2 });
    const aviso = storageNoticeContent(getStorageHealth(), [{ subject: 'run', id: rec.id }]);
    expect(aviso).toMatchObject({ kind: 'unsaved', tone: 'error' });
    expect(aviso!.title).toMatch(/Não foi possível salvar esta run.*espaço/);
    expect(fake.get('runs', rec.id)).toBeUndefined();
    expect(fake.get('runSummaries', rec.id)).toBeUndefined();

    fake.quotaBytes = Number.POSITIVE_INFINITY;
    expect(await saveRun(rec)).toBe(true);
    expect(getStorageHealth().unsaved).toEqual({});
    expect(storageNoticeContent(getStorageHealth(), [{ subject: 'run', id: rec.id }])).toBeNull();
    expect(await loadRun(rec.id)).toEqual(normalizeRunRecord(structuredClone(rec)));
    parar();
  });

  it('falha que não é de cota vira storage.write_failed (kind failed/unavailable)', async () => {
    const rec = runRecord();
    const { eventos, parar } = coletarRun(rec.id);
    fake.failNextCommit('UnknownError');
    expect(await saveRun(rec)).toBe(false);
    setIdbFactory(null);
    expect(await saveRun(rec)).toBe(false); // mudou o tipo => novo evento
    expect(storageEvents(eventos)).toMatchObject([
      { type: 'storage.write_failed', kind: 'failed' },
      { type: 'storage.write_failed', kind: 'unavailable' },
    ]);
    parar();
  });

  it('saveSession sob cota: evento no barramento da SESSÃO + aviso para o treino', async () => {
    const s = sessionRecord();
    const eventos: SessionEvent[] = [];
    const parar = subscribeSession(s.id, (e) => eventos.push(e));
    fake.failNextCommit('QuotaExceededError');
    expect(await saveSession(s)).toBe(false);
    expect(storageEvents(eventos)).toMatchObject([
      { type: 'storage.quota_exceeded', sessionId: s.id, kind: 'quota' },
    ]);
    const aviso = storageNoticeContent(getStorageHealth(), [{ subject: 'session', id: s.id }]);
    expect(aviso!.title).toMatch(/este treino/);
    expect(await saveSession(s)).toBe(true);
    expect(getStorageHealth().unsaved).toEqual({});
    expect(await loadSession(s.id)).toEqual(s);
    parar();
  });

  it('biblioteca de prompts: savePrompt REJEITA sob cota (a tela avisa em vez de fingir que salvou)', async () => {
    fake.quotaBytes = 20;
    const err = await savePrompt({ name: 'p', text: 'um prompt comprido o bastante' }).catch((e: unknown) => e);
    expect(isIdbWriteError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('quota');
  });

  it('nenhum catch vazio na camada de gravação e nenhum save com .catch(() => undefined)', () => {
    const ler = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
    // Sem comentários (mesma regra de test/engine-sync.test.ts): um catch cujo
    // corpo era SÓ comentário — o antigo `catch { /* ignore */ }` — vira `{}`.
    const semComentarios = (t: string): string =>
      t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const CATCH_VAZIO = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/;
    for (const arq of ['web/src/idb.ts', 'web/src/engine/storage.ts', 'web/src/storageHealth.ts']) {
      expect(CATCH_VAZIO.test(semComentarios(ler(arq))), `${arq} tem catch vazio`).toBe(false);
    }
    const SAVE_ENGOLIDO =
      /\b(?:saveRun|saveSession|idbPut|idbPutMany|idbWrite|idbDelete|cacheRun|cacheSession)\([^;]*?\)\s*\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(?:undefined|\{\s*\}|null)\s*\)/;
    for (const arq of [
      'web/src/engine/orchestrator.ts',
      'web/src/engine/trainer.ts',
      'web/src/engine/storage.ts',
      'web/src/engine/promptStore.ts',
      'web/src/api.ts',
      'web/src/pages/RunView.tsx',
      'web/src/pages/TrainingView.tsx',
      'web/src/pages/PromptsPage.tsx',
    ]) {
      expect(SAVE_ENGOLIDO.test(ler(arq)), `${arq} engole falha de gravação`).toBe(false);
    }
    // Sanidade das regex: pegam exatamente o padrão antigo.
    expect(CATCH_VAZIO.test(semComentarios('try { x() } catch {\n  /* ignore */\n}'))).toBe(true);
    expect(CATCH_VAZIO.test(semComentarios('} catch (err) {\n  // idb indisponível\n}'))).toBe(true);
    expect(CATCH_VAZIO.test(semComentarios('} catch (err) {\n  warnRead(store, err);\n}'))).toBe(false);
    expect(SAVE_ENGOLIDO.test('await saveRun(record).catch(() => undefined);')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (c) record + resumo na MESMA transação, com rollback
// ---------------------------------------------------------------------------

describe('IMPL-022 (c) record + resumo gravam juntos ou nenhum', () => {
  it('saveRun abre UMA transação readwrite cobrindo runs + runSummaries', async () => {
    const rec = runRecord();
    await saveRun(rec);
    const escritas = fake.transactions.filter((t) => t.mode === 'readwrite');
    expect(escritas).toHaveLength(1);
    expect(escritas[0]).toMatchObject({
      stores: ['runs', 'runSummaries'],
      durability: 'strict',
      outcome: 'complete',
      ops: [
        { store: 'runs', kind: 'put', id: rec.id },
        { store: 'runSummaries', kind: 'put', id: rec.id },
      ],
    });
    expect(fake.get('runSummaries', rec.id)).toMatchObject({ id: rec.id, status: 'running', theme: 'suporte' });
    expect(await listRuns()).toHaveLength(1);
  });

  it('falha ao gravar o RESUMO desfaz o record (nenhum dos dois fica)', async () => {
    const rec = runRecord();
    fake.failNextPut('runSummaries');
    expect(await saveRun(rec)).toBe(false);
    expect(fake.get('runs', rec.id)).toBeUndefined();
    expect(fake.get('runSummaries', rec.id)).toBeUndefined();
    expect(fake.transactions.at(-1)).toMatchObject({ outcome: 'abort', error: 'ConstraintError' });
  });

  it('regravação que falha preserva o PAR anterior (record v1 + resumo v1, nunca v2 + v1)', async () => {
    const rec = runRecord();
    await saveRun(rec);
    const v1 = structuredClone(rec);
    rec.status = 'finished';
    rec.totalCostUsd = 1.23;
    rec.finishedAt = new Date().toISOString();

    fake.failNextPut('runSummaries');
    expect(await saveRun(rec)).toBe(false);
    expect(fake.get('runs', rec.id)).toEqual(v1);
    expect(fake.get('runSummaries', rec.id)).toMatchObject({ status: 'running', totalCostUsd: 0 });

    fake.failNextCommit('QuotaExceededError');
    expect(await saveRun(rec)).toBe(false);
    expect(fake.get('runs', rec.id)).toEqual(v1);
    expect(fake.get('runSummaries', rec.id)).toMatchObject({ status: 'running' });

    expect(await saveRun(rec)).toBe(true);
    expect(fake.get('runs', rec.id)).toMatchObject({ status: 'finished', totalCostUsd: 1.23 });
    expect(fake.get('runSummaries', rec.id)).toMatchObject({ status: 'finished', totalCostUsd: 1.23 });
  });

  it('controle: DUAS transações independentes (o código antigo) divergem sob a mesma falha', async () => {
    // Prova que o fake discrimina: o que (c) acima rejeita é exatamente isto.
    const rec = runRecord();
    await saveRun(rec);
    rec.status = 'finished';
    fake.failNextPut('runSummaries');
    const r = await Promise.allSettled([
      idbPut('runs', rec as never),
      idbPut('runSummaries', { id: rec.id, status: 'finished' }),
    ]);
    expect(r.map((x) => x.status)).toEqual(['fulfilled', 'rejected']);
    expect(fake.get('runs', rec.id)).toMatchObject({ status: 'finished' });
    expect(fake.get('runSummaries', rec.id)).toMatchObject({ status: 'running' }); // divergiu
  });

  it('DataCloneError síncrono (valor não clonável) aborta o lote inteiro', async () => {
    const rec = runRecord({ contestants: [{ id: 'c', fn: () => 1 }] as never });
    const { eventos, parar } = coletarRun(rec.id);
    expect(await saveRun(rec)).toBe(false);
    expect(fake.get('runs', rec.id)).toBeUndefined();
    expect(fake.get('runSummaries', rec.id)).toBeUndefined();
    expect(storageEvents(eventos)).toMatchObject([{ type: 'storage.write_failed', kind: 'failed' }]);
    parar();
  });

  it('saveSession: sessions + sessionSummaries na mesma transação, com rollback', async () => {
    const s = sessionRecord();
    fake.failNextPut('sessions');
    expect(await saveSession(s)).toBe(false);
    expect(fake.get('sessions', s.id)).toBeUndefined();
    expect(fake.get('sessionSummaries', s.id)).toBeUndefined();
    expect(await saveSession(s)).toBe(true);
    expect(fake.transactions.filter((t) => t.mode === 'readwrite').at(-1)).toMatchObject({
      stores: ['sessions', 'sessionSummaries'],
      durability: 'strict',
      outcome: 'complete',
    });
  });

  it('idbWrite: lote em várias stores é uma transação só; delete no mesmo lote também desfaz', async () => {
    await idbPut('prompts', { id: 'velho' });
    fake.failNextPut('runs');
    await expect(
      idbWrite([
        { store: 'prompts', delete: 'velho' },
        { store: 'runs', put: { id: 'r' } },
      ]),
    ).rejects.toMatchObject({ kind: 'failed', stores: ['prompts', 'runs'] });
    expect(fake.get('prompts', 'velho')).toEqual({ id: 'velho' });
  });
});

// ---------------------------------------------------------------------------
// Durabilidade 'strict' nos checkpoints
// ---------------------------------------------------------------------------

describe("IMPL-022 durabilidade 'strict' nos checkpoints", () => {
  it("saveRun/idbPut pedem 'strict' por default; a batida periódica pede 'relaxed'", async () => {
    await saveRun(runRecord());
    await saveRun(runRecord(), { durability: 'relaxed' });
    await idbPut('prompts', { id: 'p' });
    expect(fake.transactions.filter((t) => t.mode === 'readwrite').map((t) => t.durability)).toEqual([
      'strict',
      'relaxed',
      'strict',
    ]);
  });
});

// ---------------------------------------------------------------------------
// (d) run do motor web com o disco cheio: zero perda silenciosa
// ---------------------------------------------------------------------------

const CENARIOS = [
  { question: 'Qual o prazo de troca?', productContext: 'Trocas em 30 dias com nota.', maxTokens: 200, rubric: '30 dias' },
  { question: 'Como calcular juros compostos?', productContext: 'M = C (1 + i)^n.', maxTokens: 200, rubric: 'formula' },
];

function usarPipelineFalso(opts: { atrasoCompetidorMs?: number } = {}): void {
  const f = fakeOpenRouter({
    catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b'].map((id) => catalogItem(id, 1e-9, 1e-9)),
    chat: async (req) => {
      const usage = { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 };
      if (req.model === 'fake/gen') return { text: JSON.stringify({ stages: CENARIOS }), usage };
      if (req.model === 'fake/ref') return { text: `Gabarito: ${req.user.slice(0, 30)}`, usage };
      if (req.stream) {
        if (opts.atrasoCompetidorMs) await new Promise((r) => setTimeout(r, opts.atrasoCompetidorMs));
        return { text: `Resposta de ${req.model}`, usage };
      }
      if (req.system.includes('DUELO')) return { text: '{"winner":"A","explanation":"A"}', usage };
      return { text: '{"verdict":"resolve","explanation":"ok"}', usage };
    },
  });
  const prev = setDefaultGateway(createGateway({ fetch: f.fetch, sleep: noSleep }));
  gatewayAnterior ??= prev;
}

const COMPARE = {
  mode: 'compare',
  theme: 'suporte ao cliente',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  finalists: 2,
  timeoutMs: 60_000,
} as unknown as RunConfig;

describe('IMPL-022 (d) run com o armazenamento cheio não se perde em silêncio', () => {
  it('termina, avisa UMA vez, fica viva na memória e salva ao tentar de novo', async () => {
    usarPipelineFalso();
    fake.quotaBytes = 200; // cabe nada de útil
    const runId = 'run-disco-cheio';
    const { eventos, parar } = coletarRun(runId);

    const rec = await runToCompletion(COMPARE as never, 'sk-or-v1-fake', { runId });

    expectPipelineDone(rec); // disco cheio NÃO derruba a run paga
    expect(rec.stages.filter((s) => s.judge || s.referenceJudge)).toHaveLength(2);
    const ev = storageEvents(eventos);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'storage.quota_exceeded', runId, kind: 'quota' });
    expect(eventos.at(-1)?.type).toBe('run.finished');
    // Não salvou — e isso está REGISTRADO (aviso na tela + guarda de fechar a aba).
    expect(fake.get('runs', runId)).toBeUndefined();
    expect(getStorageHealth().unsaved[`run:${runId}`]).toMatchObject({ kind: 'quota' });
    const noHistorico = storageNoticeContent(getStorageHealth(), 'all');
    expect(noHistorico).toMatchObject({ kind: 'unsaved', tone: 'error' });
    expect(noHistorico!.title).toMatch(/salvar a run run-disc no navegador/);
    expect(noHistorico!.body).toMatch(/^Ela continua aberta nesta aba/);
    // A run segue viva nesta aba (é o que o "Baixar JSON" do aviso exporta).
    expect(getRunRecord(runId)).toBe(rec);

    // Usuário libera espaço e clica "Tentar salvar de novo" (api.retrySave).
    fake.quotaBytes = Number.POSITIVE_INFINITY;
    expect(await saveRun(getRunRecord(runId)!)).toBe(true);
    expect(getStorageHealth().unsaved).toEqual({});
    const relida = await loadRun(runId);
    expect(relida).toEqual(normalizeRunRecord(structuredClone(rec)));
    // Status terminal da run (IMPL-004: 2 cenários => 'inconclusive' pelo piso de n efetivo).
    expect(await listRuns()).toEqual([expect.objectContaining({ id: runId, status: rec.status })]);
    parar();
  });

  it('cota que volta no meio da run: o checkpoint final grava o record COMPLETO e o aviso some', async () => {
    usarPipelineFalso();
    fake.failNextCommit('QuotaExceededError'); // só o 1º checkpoint (início) falha
    const runId = 'run-cota-volta';
    const { eventos, parar } = coletarRun(runId);

    const rec = await runToCompletion(COMPARE as never, 'sk-or-v1-fake', { runId });

    expectPipelineDone(rec);
    expect(storageEvents(eventos)).toHaveLength(1);
    expect(getStorageHealth().unsaved).toEqual({});
    const salvo = fake.get('runs', runId) as RunRecord;
    expectPipelineDone(salvo);
    expect(salvo.stages).toHaveLength(2);
    expect(fake.get('runSummaries', runId)).toMatchObject({ status: salvo.status });
    parar();
  });

  it("checkpoints do motor (início, marcos, fechamento) são 'strict'; só a batida do throttle é 'relaxed'", async () => {
    // Competidores lentos (> 800 ms) => a batida periódica chega a disparar.
    usarPipelineFalso({ atrasoCompetidorMs: 900 });
    const runId = 'run-durabilidade';
    await runToCompletion(COMPARE as never, 'sk-or-v1-fake', { runId });
    const daRun = fake.transactions.filter((t) => t.mode === 'readwrite' && t.ops.some((o) => o.id === runId));
    expect(daRun.length).toBeGreaterThanOrEqual(3);
    expect(daRun[0].durability).toBe('strict'); // início
    expect(daRun.at(-1)!.durability).toBe('strict'); // fechamento
    expect(daRun.some((t) => t.durability === 'relaxed')).toBe(true); // batida
    expect(daRun.every((t) => t.durability === 'strict' || t.durability === 'relaxed')).toBe(true);
    expect(daRun.every((t) => t.outcome === 'complete')).toBe(true);
    expectPipelineDone(fake.get('runs', runId) as RunRecord);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// (a) navigator.storage.persist() na primeira run, estado negado visível
// ---------------------------------------------------------------------------

function memoryLocalStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

function fakeStorageManager(resposta: boolean | Error, persisted = false): StorageManagerLike & {
  persist: ReturnType<typeof vi.fn>;
  persisted: ReturnType<typeof vi.fn>;
} {
  return {
    persist: vi.fn(async () => {
      if (resposta instanceof Error) throw resposta;
      return resposta;
    }),
    persisted: vi.fn(async () => persisted),
    estimate: async () => ({ usage: 1024, quota: 1024 * 1024 }),
  };
}

describe('IMPL-022 (a) persist() na primeira run, estado negado visível', () => {
  it('negado: pede UMA vez por página e a UI recebe o aviso de armazenamento não persistente', async () => {
    const sm = fakeStorageManager(false);
    setStorageManager(sm);
    vi.stubGlobal('localStorage', memoryLocalStorage());

    expect(storageNoticeContent(getStorageHealth(), [])).toBeNull(); // antes do pedido: nada
    const [a, b] = await Promise.all([requestPersistentStorage(), requestPersistentStorage()]);
    expect([a, b]).toEqual(['denied', 'denied']);
    await requestPersistentStorage();
    expect(sm.persist).toHaveBeenCalledTimes(1);

    const h = getStorageHealth();
    expect(h).toMatchObject({ persist: 'denied', persistRequested: true });
    const aviso = storageNoticeContent(h, [{ subject: 'run', id: 'qualquer' }]);
    expect(aviso).toMatchObject({ kind: 'persist-denied', tone: 'neutral', title: 'Armazenamento não persistente.' });
    // Aviso de gravação falhada tem prioridade sobre o de persistência.
    reportWriteFailure('run', 'qualquer', new DOMException('cheio', 'QuotaExceededError'));
    expect(storageNoticeContent(getStorageHealth(), [{ subject: 'run', id: 'qualquer' }])).toMatchObject({
      kind: 'unsaved',
    });
  });

  it('"negado" sobrevive ao recarregar a página (persisted() + memória), SEM pedir de novo', async () => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    setStorageManager(fakeStorageManager(false));
    await requestPersistentStorage();

    const sm2 = fakeStorageManager(false); // "recarregou": estado do módulo zerado
    setStorageManager(sm2);
    expect(getStorageHealth().persist).toBe('unknown');
    expect(await refreshPersistState()).toBe('denied');
    expect(sm2.persist).not.toHaveBeenCalled();
    expect(storageNoticeContent(getStorageHealth(), [])).toMatchObject({ kind: 'persist-denied' });
  });

  it('concedido: sem aviso; pedido explícito (Configurações) pede de novo', async () => {
    const sm = fakeStorageManager(true);
    setStorageManager(sm);
    expect(await requestPersistentStorage()).toBe('granted');
    expect(storageNoticeContent(getStorageHealth(), [])).toBeNull();
    await requestPersistentStorage({ again: true });
    expect(sm.persist).toHaveBeenCalledTimes(2);
  });

  it('sem a API ou com persist() lançando: nunca lança (unsupported / denied)', async () => {
    setStorageManager(null);
    expect(await requestPersistentStorage()).toBe('unsupported');
    setStorageManager(fakeStorageManager(new DOMException('iframe', 'SecurityError') as unknown as Error));
    expect(await requestPersistentStorage()).toBe('denied');
  });
});
