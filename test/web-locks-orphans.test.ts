// IMPL-023 (R-10:REC-1) — Web Locks por run/sessão e órfãs detectadas na carga.
//
// Antes: nenhum `navigator.locks` em web/src e nenhum marcador de órfã na SPA —
// run interrompida por reload/fecho de aba ficava 'running' para sempre no
// IndexedDB (sem stoppedReason), e duas abas podiam executar a mesma run.
//
// Cada ABA é uma instância nova dos módulos (`vi.resetModules`), com o mesmo
// "disco" (IndexedDB falso — test/fakeIndexedDb.ts) e o mesmo gerenciador de
// locks da origem (broker falso — test/fakeWebLocks.ts; o `navigator.locks` do
// Node é por thread e não simula abas). Fechar/recarregar a aba = o navegador
// solta os locks dela + ela não grava mais nada. Transporte do OpenRouter falso:
// zero rede, zero gasto. Critérios de aceite:
//   (i)   reload durante a run => reabre aborted(orphan) em ≤ 2 s, sem
//         intervenção (20/20);
//   (ii)  duas abas nunca executam a mesma run (0 execuções duplas em 20);
//   (iii) aba congelada 5 min não gera falso positivo;
//   (iv)  grep: navigator.locks em web/src e nenhum heartbeat por timestamp.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireLock,
  isHeldHere,
  locksSupported,
  lockName,
  setLockManager,
  whenLockReleased,
  withLockIfFree,
  type LockManagerLike,
} from '../web/src/engine/runLocks.js';
import { markRunOrphaned, markSessionOrphaned } from '../web/src/engine/orphans.js';
import type { RunRecord, SessionRecord } from '../web/src/engine/types.js';
import { FakeIdb } from './fakeIndexedDb.js';
import { FakeLockBroker, type FakeLockContext } from './fakeWebLocks.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter } from './fakeOpenRouter.js';
import { expectPipelineDone } from './runOutcome.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CENARIOS = [
  { question: 'Qual o prazo de troca?', productContext: 'Trocas em 30 dias com nota.', maxTokens: 200, rubric: '30 dias' },
  { question: 'Como calcular juros compostos?', productContext: 'M = C (1 + i)^n.', maxTokens: 200, rubric: 'formula' },
];

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
} as const;

const TRAINING = {
  mode: 'training',
  theme: 'suporte ao cliente',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  contestantModelId: 'fake/a',
  basePrompt: 'Voce e um atendente de suporte. Responda com base no contexto do produto.',
  techniqueIds: ['persona'],
  promptOptimization: true,
  optimizerModelId: 'fake/opt',
  iterations: 1,
  holdoutRatio: 0,
  finalists: 2,
  timeoutMs: 60_000,
} as const;

interface PipelineOpts {
  /** Competidores esperam esta promise (aba "travada"/congelada no meio). */
  gate?: Promise<void>;
  /** Chamado quando um competidor começa (a run chegou ao meio). */
  onCompetitor?: () => void;
}

function pipeline(opts: PipelineOpts = {}): FakeOpenRouter {
  return fakeOpenRouter({
    catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b', 'fake/opt'].map((id) =>
      catalogItem(id, 1e-9, 1e-9),
    ),
    chat: async (req) => {
      const usage = { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 };
      if (req.model === 'fake/gen') return { text: JSON.stringify({ stages: CENARIOS }), usage };
      if (req.model === 'fake/opt') {
        return {
          text: 'Voce e um atendente cordial e preciso. Responda com base no contexto do produto, cite prazos e regras exatamente como aparecem e recuse o que estiver fora do escopo.',
          usage,
        };
      }
      if (req.model === 'fake/ref') return { text: `Gabarito: ${req.user.slice(0, 30)}`, usage };
      if (req.stream) {
        opts.onCompetitor?.();
        if (opts.gate) await opts.gate;
        return { text: `Resposta de ${req.model}`, usage };
      }
      if (req.system.includes('DUELO')) return { text: '{"winner":"A","explanation":"A"}', usage };
      return { text: '{"verdict":"resolve","explanation":"ok"}', usage };
    },
  });
}

/** Nunca resolve: a aba "morre" com a chamada em voo. */
const NUNCA = new Promise<void>(() => undefined);

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

async function esperar(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > timeoutMs) throw new Error('timeout esperando condição');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Espera o disco ficar `ms` sem nenhuma transação nova. */
async function quieto(disco: FakeIdb, ms: number): Promise<void> {
  let n = disco.transactions.length;
  let desde = performance.now();
  while (performance.now() - desde < ms) {
    await new Promise((r) => setTimeout(r, 20));
    if (disco.transactions.length !== n) {
      n = disco.transactions.length;
      desde = performance.now();
    }
  }
}

const runNoDisco = (disco: FakeIdb, id: string) => disco.get('runs', id) as RunRecord | undefined;
const sessaoNoDisco = (disco: FakeIdb, id: string) => disco.get('sessions', id) as SessionRecord | undefined;

// ---------------------------------------------------------------------------
// "Abas": instâncias isoladas dos módulos sobre o mesmo disco e o mesmo broker
// ---------------------------------------------------------------------------

/** Aba morta: a conexão nunca abre — o que a aba zumbi tentar gravar não chega ao disco. */
const DISCO_MORTO = { open: () => ({}) } as unknown as IDBFactory;

async function abrirAba(disco: FakeIdb, locks: FakeLockContext | null, fake?: FakeOpenRouter) {
  vi.resetModules();
  const idb = await import('../web/src/idb.js');
  idb.setIdbFactory(disco.factory);
  const runLocks = await import('../web/src/engine/runLocks.js');
  runLocks.setLockManager(locks); // null = navegador sem Web Locks
  const storageHealth = await import('../web/src/storageHealth.js');
  storageHealth.setStorageManager(null);
  const gw = await import('../src/openrouter.js');
  if (fake) gw.setDefaultGateway(gw.createGateway({ fetch: fake.fetch, sleep: noSleep }));
  const orchestrator = await import('../web/src/engine/orchestrator.js');
  const trainer = await import('../web/src/engine/trainer.js');
  const orphans = await import('../web/src/engine/orphans.js');
  const events = await import('../web/src/engine/events.js');
  const storage = await import('../web/src/engine/storage.js');
  const api = await import('../web/src/api.js');
  return {
    idb,
    runLocks,
    orchestrator,
    trainer,
    orphans,
    events,
    storage,
    api,
    /** Fecha/recarrega/trava a aba: o navegador solta os locks; ela não grava mais. */
    fechar(): void {
      locks?.destroy();
      idb.setIdbFactory(DISCO_MORTO);
    },
  };
}

type Aba = Awaited<ReturnType<typeof abrirAba>>;

function coletar(aba: Aba, runId: string): { eventos: any[]; parar: () => void } {
  const eventos: any[] = [];
  const parar = aba.api.openRunStream(runId, (e) => eventos.push(e));
  return { eventos, parar };
}

let silencio: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryLocalStorage());
  silencio = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
});

afterEach(() => {
  setLockManager(undefined);
  silencio.forEach((s) => s.mockRestore());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// runLocks: o idiom da promise pendente
// ---------------------------------------------------------------------------

describe('IMPL-023 runLocks: lock exclusivo por run (idiom da promise pendente)', () => {
  it('dono segura até release(); outra aba recebe null (há dono) em vez de esperar', async () => {
    const broker = new FakeLockBroker();
    const a = broker.context('A');
    const b = broker.context('B');
    const lock = await acquireLock('run', 'r1', a);
    expect(lock).toMatchObject({ name: lockName('run', 'r1'), supported: true });
    expect(broker.holder('prompt-builder:run:r1')).toBe('A');
    expect(isHeldHere('run', 'r1')).toBe(true);
    expect(await acquireLock('run', 'r1', b)).toBeNull();
    expect(await withLockIfFree('run', 'r1', async () => 'x', b)).toEqual({ state: 'held' });
    lock!.release();
    lock!.release(); // idempotente
    await esperar(() => broker.holder('prompt-builder:run:r1') === undefined);
    expect(isHeldHere('run', 'r1')).toBe(false);
    expect(await withLockIfFree('run', 'r1', async () => 'livre', b)).toEqual({ state: 'free', value: 'livre' });
  });

  it('fechar a aba (contexto destruído) solta o lock sem ninguém chamar release()', async () => {
    const broker = new FakeLockBroker();
    const a = broker.context('A');
    const b = broker.context('B');
    const lock = await acquireLock('run', 'r2', a);
    expect(lock).not.toBeNull();
    const esperando = whenLockReleased('run', 'r2', async () => broker.holder('prompt-builder:run:r2'), undefined, b);
    await esperar(() => broker.queued('prompt-builder:run:r2') === 1);
    a.destroy(); // a aba morreu com a run no meio: o NAVEGADOR solta
    expect(await esperando).toEqual({ state: 'released', value: 'B' });
  });

  it('espera cancelada (signal) sai da fila e devolve aborted', async () => {
    const broker = new FakeLockBroker();
    await acquireLock('run', 'r3', broker.context('A'));
    const ctrl = new AbortController();
    const p = whenLockReleased('run', 'r3', async () => 'nunca', ctrl.signal, broker.context('B'));
    await esperar(() => broker.queued('prompt-builder:run:r3') === 1);
    ctrl.abort();
    expect(await p).toEqual({ state: 'aborted' });
    expect(broker.queued('prompt-builder:run:r3')).toBe(0);
  });

  it('bfcache: a espera sai da fila no pagehide (não trava o lock numa página congelada) e volta no pageshow', async () => {
    // Medido no Chrome 153 (E2E com CDP): página que vai para o bfcache com
    // pedido PENDENTE recebe o lock quando o dono solta e o segura congelada —
    // as outras abas passavam a ver a run "viva" para sempre.
    const pagina = new EventTarget();
    vi.stubGlobal('window', pagina);
    const broker = new FakeLockBroker();
    const dona = await acquireLock('run', 'bf', broker.context('dona'));
    const b = broker.context('B');
    let chamou = 0;
    const espera = whenLockReleased('run', 'bf', async () => ++chamou, undefined, b);
    await esperar(() => broker.queued('prompt-builder:run:bf') === 1);

    pagina.dispatchEvent(new Event('pagehide')); // navegou para outra página (bfcache)
    await esperar(() => broker.queued('prompt-builder:run:bf') === 0);
    dona!.release();
    await esperar(() => broker.holder('prompt-builder:run:bf') === undefined);
    // Outra aba enxerga o lock LIVRE (antes: preso na página congelada).
    expect(await withLockIfFree('run', 'bf', async () => 'livre', broker.context('C'))).toEqual({
      state: 'free',
      value: 'livre',
    });
    expect(chamou).toBe(0);

    pagina.dispatchEvent(new Event('pageshow')); // voltou do bfcache: entra na fila de novo
    expect(await espera).toEqual({ state: 'released', value: 1 });
  });

  it('o mesmo idiom contra o navigator.locks REAL do Node 24 (mesma thread = mesma origem)', async () => {
    setLockManager(undefined); // detecção automática
    expect(locksSupported()).toBe(true);
    const id = `nativo-${Math.random()}`;
    const dono = await acquireLock('run', id);
    expect(dono?.supported).toBe(true);
    expect(await acquireLock('run', id)).toBeNull();
    expect(await withLockIfFree('run', id, async () => 1)).toEqual({ state: 'held' });
    const espera = whenLockReleased('run', id, async () => 'depois do dono');
    dono!.release();
    expect(await espera).toEqual({ state: 'released', value: 'depois do dono' });
    expect(await withLockIfFree('run', id, async () => 2)).toEqual({ state: 'free', value: 2 });
  });

  it('feature detection: sem navigator.locks degrada (handle sem exclusão), sem lançar', async () => {
    setLockManager(undefined);
    vi.stubGlobal('navigator', {});
    expect(locksSupported()).toBe(false);
    const h = await acquireLock('run', 'sem-api');
    expect(h).toMatchObject({ supported: false });
    expect(isHeldHere('run', 'sem-api')).toBe(true); // "esta aba executa" continua sabido
    h!.release();
    expect(isHeldHere('run', 'sem-api')).toBe(false);
    expect(await withLockIfFree('run', 'sem-api', async () => 1)).toEqual({ state: 'unsupported' });
    expect(await whenLockReleased('run', 'sem-api', async () => 1)).toEqual({ state: 'unsupported' });
  });

  it('API presente mas recusando o contexto (SecurityError) também degrada', async () => {
    const recusa: LockManagerLike = {
      request: () => Promise.reject(new DOMException('opaque origin', 'SecurityError')),
    };
    expect(await acquireLock('run', 'sec', recusa)).toMatchObject({ supported: false });
    expect(await withLockIfFree('run', 'sec', async () => 1, recusa)).toEqual({ state: 'unsupported' });
  });

  it('erro do callback sobe (não é confundido com recusa do navegador)', async () => {
    const broker = new FakeLockBroker();
    await expect(
      withLockIfFree('run', 'boom', async () => {
        throw new Error('falhou lendo o disco');
      }, broker.context('A')),
    ).rejects.toThrow('falhou lendo o disco');
    expect(broker.holder('prompt-builder:run:boom')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Marcação de órfã (pura)
// ---------------------------------------------------------------------------

describe('IMPL-023 marcação de órfã', () => {
  it('run: aborted + orphan; etapa em voo fica incomplete (fora do placar), julgada/erro intactas', () => {
    const rec = {
      id: 'r',
      status: 'running',
      stages: [
        { index: 0, spec: { question: 'q0' }, responses: [], judge: { ranking: [] }, startedAt: 't' },
        { index: 1, spec: { question: 'q1' }, responses: [{ contestantId: 'a' }], startedAt: 't' },
        { index: 2, spec: { question: 'q2' }, responses: [], error: 'falhou', startedAt: 't' },
        { index: 3, responses: [], startedAt: 't' }, // ainda gerando cenário: sem spec
      ],
      totalCostUsd: 0.0123,
    } as unknown as RunRecord;
    markRunOrphaned(rec, '2026-09-27T00:00:00.000Z');
    expect(rec).toMatchObject({ status: 'aborted', stoppedReason: 'orphan', finishedAt: '2026-09-27T00:00:00.000Z' });
    expect(rec.stages.map((s) => Boolean(s.incomplete))).toEqual([false, true, false, false]);
    expect(rec.stages[1].incompleteReason).toBeUndefined(); // CONVENTIONS §4: motivo é o da run
    expect(rec.stages[1].judge).toBeUndefined(); // nenhuma nota inventada
    expect(rec.totalCostUsd).toBe(0.0123); // o gasto salvo não é zerado
  });

  it('sessão: aborted + orphan, preserva finishedAt existente', () => {
    const s = { id: 's', status: 'running', finishedAt: undefined } as unknown as SessionRecord;
    markSessionOrphaned(s, 'agora');
    expect(s).toMatchObject({ status: 'aborted', stoppedReason: 'orphan', finishedAt: 'agora' });
  });
});

// ---------------------------------------------------------------------------
// (i) reload durante a run
// ---------------------------------------------------------------------------

async function runNoMeio(disco: FakeIdb, broker: FakeLockBroker, label: string): Promise<{ aba: Aba; runId: string }> {
  let competidor = false;
  const fake = pipeline({ gate: NUNCA, onCompetitor: () => (competidor = true) });
  const aba = await abrirAba(disco, broker.context(label), fake);
  const runId = await aba.api.createRun(COMPARE as never, { costConfirmed: true });
  await esperar(() => competidor && runNoDisco(disco, runId)?.status === 'running' && Boolean(runNoDisco(disco, runId)?.stages.length));
  expect(broker.holder(lockName('run', runId))).toBe(label);
  return { aba, runId };
}

describe('IMPL-023 (i) reload durante a run => aborted(orphan) em ≤ 2 s, sem intervenção', () => {
  it('20/20: a tela da run (fetchRun + openRunStream) reabre aborted(orphan)', async () => {
    const tempos: number[] = [];
    for (let k = 0; k < 20; k++) {
      const disco = new FakeIdb();
      const broker = new FakeLockBroker();
      const { aba: antes, runId } = await runNoMeio(disco, broker, `antes-${k}`);
      antes.fechar(); // F5: o contexto antigo morre e o navegador solta o lock

      const depois = await abrirAba(disco, broker.context(`depois-${k}`));
      const t0 = performance.now();
      const [rec, stream] = await Promise.all([
        depois.api.fetchRun(runId),
        (async () => {
          const c = coletar(depois, runId);
          await esperar(() => c.eventos.some((e) => e.type === 'run.finished'));
          c.parar();
          return c.eventos;
        })(),
      ]);
      tempos.push(performance.now() - t0);

      expect(rec, `tentativa ${k}`).toMatchObject({ status: 'aborted', stoppedReason: 'orphan' });
      expect(rec.stages.some((s) => s.incomplete)).toBe(true);
      // A tela recebe o record final e NENHUM aviso de "roda em outra aba".
      expect(stream.map((e) => e.type)).toEqual(['snapshot', 'run.finished']);
      expect(stream[0].record).toMatchObject({ status: 'aborted', stoppedReason: 'orphan' });
      // Gravado (record + resumo na mesma transação): a próxima carga já lê aborted.
      expect(runNoDisco(disco, runId)).toMatchObject({ status: 'aborted', stoppedReason: 'orphan' });
      expect(disco.get('runSummaries', runId)).toMatchObject({ status: 'aborted' });
    }
    expect(tempos).toHaveLength(20);
    expect(Math.max(...tempos)).toBeLessThan(2000);
  });

  it('sem abrir a run: a varredura da carga da página (startOrphanWatch) marca sozinha', async () => {
    const disco = new FakeIdb();
    const broker = new FakeLockBroker();
    const { aba: antes, runId } = await runNoMeio(disco, broker, 'antes');
    antes.fechar();
    const depois = await abrirAba(disco, broker.context('depois'));
    const t0 = performance.now();
    depois.api.startOrphanWatch(); // o que main.tsx faz na carga
    await esperar(() => runNoDisco(disco, runId)?.status === 'aborted', 2000);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(runNoDisco(disco, runId)?.stoppedReason).toBe('orphan');
    // E o histórico já lista aborted (fetchRuns varre antes de listar).
    expect(await depois.api.fetchRuns()).toEqual([expect.objectContaining({ id: runId, status: 'aborted' })]);
  });

  it('aba da run FECHADA com o histórico aberto em outra: a outra marca a órfã na hora (fila do lock)', async () => {
    const disco = new FakeIdb();
    const broker = new FakeLockBroker();
    const { aba: dona, runId } = await runNoMeio(disco, broker, 'dona');
    const outra = await abrirAba(disco, broker.context('outra'));
    const c = coletar(outra, runId);
    await esperar(() => c.eventos.some((e) => e.type === 'ownership'));
    expect(c.eventos[1]).toEqual({ type: 'ownership', state: 'elsewhere' });
    const t0 = performance.now();
    dona.fechar();
    await esperar(() => c.eventos.some((e) => e.type === 'run.finished'), 2000);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(c.eventos.at(-1).record).toMatchObject({ status: 'aborted', stoppedReason: 'orphan' });
    expect(runNoDisco(disco, runId)).toMatchObject({ status: 'aborted', stoppedReason: 'orphan' });
    c.parar();
  });

  it('treino: sessão E run da rodada viram órfãs depois do reload', async () => {
    const disco = new FakeIdb();
    const broker = new FakeLockBroker();
    let competidor = false;
    const fake = pipeline({ gate: NUNCA, onCompetitor: () => (competidor = true) });
    const antes = await abrirAba(disco, broker.context('antes'), fake);
    const sessionId = await antes.api.createSession(TRAINING as never, { costConfirmed: true });
    await esperar(() => competidor && (sessaoNoDisco(disco, sessionId)?.runIds.length ?? 0) > 0);
    const iterRunId = sessaoNoDisco(disco, sessionId)!.runIds[0];
    await esperar(() => runNoDisco(disco, iterRunId)?.status === 'running');
    expect(broker.holder(lockName('session', sessionId))).toBe('antes');
    expect(broker.holder(lockName('run', iterRunId))).toBe('antes');
    antes.fechar();

    const depois = await abrirAba(disco, broker.context('depois'));
    const t0 = performance.now();
    const s = await depois.api.fetchSession(sessionId);
    expect(s).toMatchObject({ status: 'aborted', stoppedReason: 'orphan' });
    depois.api.startOrphanWatch();
    await esperar(() => runNoDisco(disco, iterRunId)?.status === 'aborted', 2000);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(runNoDisco(disco, iterRunId)?.stoppedReason).toBe('orphan');
    expect(sessaoNoDisco(disco, sessionId)).toMatchObject({ status: 'aborted', stoppedReason: 'orphan' });
    expect(disco.get('sessionSummaries', sessionId)).toMatchObject({ status: 'aborted' });
  });

  it('a própria aba: run terminou na memória mas a gravação final não chegou — regrava, não marca órfã', async () => {
    const disco = new FakeIdb();
    const broker = new FakeLockBroker();
    const aba = await abrirAba(disco, broker.context('A'));
    const velho = { id: 'r-fim', status: 'running', stages: [], contestants: [], config: {}, totalCostUsd: 0, startedAt: 'x' };
    await aba.storage.saveRun(velho as never);
    aba.events.cacheRunRecord({ ...velho, status: 'finished', finishedAt: 'y' } as never);
    const chk = await aba.orphans.reconcileRun('r-fim');
    expect(chk).toMatchObject({ state: 'settled', record: { status: 'finished' } });
    expect(runNoDisco(disco, 'r-fim')).toMatchObject({ status: 'finished' });
    expect(runNoDisco(disco, 'r-fim')?.stoppedReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (ii) duas abas, a mesma run
// ---------------------------------------------------------------------------

describe('IMPL-023 (ii) duas abas nunca executam a mesma run', () => {
  it('0 execuções duplas em 20 tentativas simultâneas (quem pega o lock executa; a outra recusa sem gravar)', async () => {
    const disco = new FakeIdb();
    const broker = new FakeLockBroker();
    const fake = pipeline();
    const a = await abrirAba(disco, broker.context('A'), fake);
    const b = await abrirAba(disco, broker.context('B'), fake);
    const datagen = (): number => fake.chatRequests().filter((r) => r.model === 'fake/gen').length;
    let duplas = 0;
    const vencedoras = { A: 0, B: 0 };
    for (let k = 0; k < 20; k++) {
      const runId = `mesma-run-${k}`;
      const [p, s] = k % 2 === 0 ? [a, b] : [b, a];
      const antes = datagen();
      const [r1, r2] = await Promise.all([
        p.orchestrator.runToCompletion(COMPARE as never, KEY, { runId }),
        s.orchestrator.runToCompletion(COMPARE as never, KEY, { runId }),
      ]);
      const executadas = [r1, r2].filter((r) => r.status !== 'error');
      if (executadas.length > 1 || datagen() - antes > 1) duplas++;
      expect(executadas, `tentativa ${k}`).toHaveLength(1);
      expectPipelineDone(executadas[0]);
      const recusada = r1.status === 'error' ? r1 : r2;
      expect(recusada.error).toBe(a.orchestrator.RUN_LOCKED_ELSEWHERE);
      expect(recusada.stages).toEqual([]); // não executou nada
      vencedoras[r1.status !== 'error' ? (k % 2 === 0 ? 'A' : 'B') : k % 2 === 0 ? 'B' : 'A']++;
      // O disco tem a run que EXECUTOU — a recusa não gravou por cima.
      expect(runNoDisco(disco, runId)).toMatchObject({ status: executadas[0].status });
      await esperar(() => broker.holder(lockName('run', runId)) === undefined); // lock solto no fim
    }
    expect(duplas).toBe(0);
    expect(datagen()).toBe(20); // exatamente um pipeline pago por run
    expect(vencedoras).toEqual({ A: 10, B: 10 });
  });

  it('segunda aba tentando no MEIO da run é recusada; a dona termina normalmente', async () => {
    const disco = new FakeIdb();
    const broker = new FakeLockBroker();
    let soltar!: () => void;
    let competidor = false;
    const fake = pipeline({ gate: new Promise<void>((r) => (soltar = r)), onCompetitor: () => (competidor = true) });
    const a = await abrirAba(disco, broker.context('A'), fake);
    const b = await abrirAba(disco, broker.context('B'), fake);
    const pa = a.orchestrator.runToCompletion(COMPARE as never, KEY, { runId: 'no-meio' });
    await esperar(() => competidor);
    const chamadasAntes = fake.chatRequests().length;
    const rb = await b.orchestrator.runToCompletion(COMPARE as never, KEY, { runId: 'no-meio' });
    expect(rb).toMatchObject({ status: 'error', error: b.orchestrator.RUN_LOCKED_ELSEWHERE });
    expect(fake.chatRequests().length).toBe(chamadasAntes); // B não chamou nada
    expect(runNoDisco(disco, 'no-meio')).toMatchObject({ status: 'running' }); // nem gravou
    soltar();
    const ra = await pa;
    expectPipelineDone(ra);
    expect(runNoDisco(disco, 'no-meio')).toMatchObject({ status: ra.status });
  });

  it('a sessão de treino segura o próprio lock até a última gravação', async () => {
    const disco = new FakeIdb();
    const broker = new FakeLockBroker();
    const a = await abrirAba(disco, broker.context('A'), pipeline());
    const fins: string[] = [];
    const { sessionId } = await a.trainer.startTraining(TRAINING as never, KEY);
    expect(broker.holder(lockName('session', sessionId))).toBe('A');
    a.events.subscribeSession(sessionId, (e) => fins.push(e.type));
    await esperar(() => sessaoNoDisco(disco, sessionId)?.status === 'finished', 10_000);
    await esperar(() => broker.holder(lockName('session', sessionId)) === undefined);
    expect(fins).toContain('session.finished');
  });
});

// ---------------------------------------------------------------------------
// (iii) aba congelada
// ---------------------------------------------------------------------------

describe('IMPL-023 (iii) aba congelada não é órfã', () => {
  it('5 min sem rodar nada: segue viva para as outras abas; ao descongelar termina finished', async () => {
    const disco = new FakeIdb();
    const broker = new FakeLockBroker();
    let soltar!: () => void;
    let competidor = false;
    const fake = pipeline({ gate: new Promise<void>((r) => (soltar = r)), onCompetitor: () => (competidor = true) });
    const a = await abrirAba(disco, broker.context('A'), fake);
    const runId = await a.api.createRun(COMPARE as never, { costConfirmed: true });
    // Todos os 4 competidores (2 cenários × 2 modelos) parados e a batida de
    // gravação (800 ms) já assentada: daqui em diante a aba A não escreve nada.
    await esperar(() => competidor && fake.chatRequests().filter((r) => r.stream).length === 4);
    await quieto(disco, 1000);
    const gravadoAntes = structuredClone(runNoDisco(disco, runId));
    expect(gravadoAntes?.status).toBe('running');

    // Congela a aba A: nenhum código dela roda, e o relógio de parede anda 5 min.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1_000);

    const b = await abrirAba(disco, broker.context('B'));
    expect(await b.api.fetchRun(runId)).toMatchObject({ status: 'running' });
    const varredura = await b.orphans.sweepOrphans();
    expect(varredura).toMatchObject({ supported: true, orphanedRuns: [], aliveRuns: [runId] });
    b.api.startOrphanWatch();
    const c = coletar(b, runId);
    await esperar(() => c.eventos.some((e) => e.type === 'ownership'));
    expect(c.eventos.map((e) => e.type)).toEqual(['snapshot', 'ownership']);
    expect(c.eventos[1]).toEqual({ type: 'ownership', state: 'elsewhere' });
    // Outra aba reabrindo a cópia velha NÃO regrava 'running' por cima da dona.
    const tx = disco.transactions.length;
    await b.api.cacheRun(c.eventos[0].record);
    expect(disco.transactions.length).toBe(tx);
    expect(runNoDisco(disco, runId)).toEqual(gravadoAntes); // nada foi tocado

    // Descongela: a run termina normalmente e a aba B vê o fim — não 'orphan'.
    soltar();
    await esperar(() => c.eventos.some((e) => e.type === 'run.finished'), 5000);
    const fim = c.eventos.at(-1).record as RunRecord;
    expectPipelineDone(fim);
    expect(fim.stoppedReason).toBeUndefined();
    expect(runNoDisco(disco, runId)).toMatchObject({ status: fim.status });
    expect(runNoDisco(disco, runId)?.stoppedReason).toBeUndefined();
    // Cópia velha 'running' regravada DEPOIS do fim também é recusada.
    await b.api.cacheRun(gravadoAntes as never);
    expect(runNoDisco(disco, runId)).toMatchObject({ status: fim.status });
    c.parar();
  });
});

// ---------------------------------------------------------------------------
// Navegador sem Web Locks
// ---------------------------------------------------------------------------

describe('IMPL-023 feature detection: navegador sem Web Locks', () => {
  it('run executa (sem exclusão); nada vira órfão sozinho; a tela avisa e oferece marcar manualmente', async () => {
    const disco = new FakeIdb();
    let competidor = false;
    const fake = pipeline({ gate: NUNCA, onCompetitor: () => (competidor = true) });
    const antes = await abrirAba(disco, null, fake);
    expect(antes.runLocks.locksSupported()).toBe(false);
    const runId = await antes.api.createRun(COMPARE as never, { costConfirmed: true });
    await esperar(() => competidor && runNoDisco(disco, runId)?.status === 'running');
    antes.fechar();

    const depois = await abrirAba(disco, null);
    expect(await depois.api.fetchRun(runId)).toMatchObject({ status: 'running' });
    expect(await depois.orphans.sweepOrphans()).toMatchObject({ supported: false, orphanedRuns: [] });
    const c = coletar(depois, runId);
    await esperar(() => c.eventos.some((e) => e.type === 'ownership'));
    expect(c.eventos[1]).toEqual({ type: 'ownership', state: 'unsupported' });
    expect(runNoDisco(disco, runId)?.status).toBe('running'); // sem API, sem palpite
    c.parar();

    const marcado = await depois.api.markRunInterrupted(runId);
    expect(marcado).toMatchObject({ status: 'aborted', stoppedReason: 'orphan' });
    expect(runNoDisco(disco, runId)).toMatchObject({ status: 'aborted', stoppedReason: 'orphan' });
  });

  it('sem Web Locks a run completa normalmente', async () => {
    const disco = new FakeIdb();
    const aba = await abrirAba(disco, null, pipeline());
    const rec = await aba.orchestrator.runToCompletion(COMPARE as never, KEY, { runId: 'sem-locks-ok' });
    expectPipelineDone(rec);
    expect(runNoDisco(disco, 'sem-locks-ok')).toMatchObject({ status: rec.status });
  });

  it('com Web Locks, a marcação manual NUNCA derruba uma run viva', async () => {
    const disco = new FakeIdb();
    const broker = new FakeLockBroker();
    const { runId } = await runNoMeio(disco, broker, 'dona');
    const outra = await abrirAba(disco, broker.context('outra'));
    expect(await outra.api.markRunInterrupted(runId)).toMatchObject({ status: 'running' });
    expect(runNoDisco(disco, runId)?.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// (iv) grep
// ---------------------------------------------------------------------------

function arquivosDe(dir: string): string[] {
  const out: string[] = [];
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome);
    if (statSync(p).isDirectory()) out.push(...arquivosDe(p));
    else if (/\.(ts|tsx)$/.test(nome)) out.push(p);
  }
  return out;
}

/** Tira comentários (// e /* *\/) — o critério é sobre CÓDIGO, não sobre a explicação. */
function semComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('IMPL-023 (iv) grep em web/src', () => {
  const WEB_SRC = join(ROOT, 'web', 'src');
  const arquivos = arquivosDe(WEB_SRC).map((f) => ({
    rel: relative(WEB_SRC, f).split('\\').join('/'),
    code: semComentarios(readFileSync(f, 'utf8')),
  }));

  it('navigator.locks está no código (feature detection) e o motor usa o lock por run/sessão', () => {
    const comLocks = arquivos.filter((f) => f.code.includes('navigator.locks')).map((f) => f.rel);
    expect(comLocks).toEqual(['engine/runLocks.ts']);
    const code = (rel: string) => arquivos.find((f) => f.rel === rel)!.code;
    expect(code('engine/orchestrator.ts')).toMatch(/acquireLock\('run', record\.id\)/);
    expect(code('engine/trainer.ts')).toMatch(/acquireLock\('session', sessionId\)/);
    expect(code('main.tsx')).toMatch(/startOrphanWatch\(\)/);
  });

  it('nenhum heartbeat por timestamp: o detector de órfã não lê relógio nem agenda batidas', () => {
    for (const rel of ['engine/runLocks.ts', 'engine/orphans.ts']) {
      const code = arquivos.find((f) => f.rel === rel)!.code;
      expect(code, rel).not.toMatch(/Date\.now|getTime\(|performance\.now|setInterval|setTimeout|Date\.parse/);
      expect(code, rel).not.toMatch(/heartbeat|lastSeen|aliveAt|lastBeat|staleAfter|\bttl\b/i);
    }
    // E ninguém em web/src grava/compara um campo de batimento.
    const suspeitos = arquivos.filter((f) => /heartbeat|lastSeen|aliveAt|lastBeat/i.test(f.code)).map((f) => f.rel);
    expect(suspeitos).toEqual([]);
  });
});
