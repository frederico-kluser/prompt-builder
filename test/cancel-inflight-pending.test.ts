// left#14 — Cancelar durante a geração de cenários mostrava a RESERVA como gasto.
//
// Reprodução (antes da correção, nos DOIS motores, com o transporte falso):
// uma única chamada de datagen em voo, cancelada antes de qualquer resposta,
// fechava a run com `totalCostUsd` = US$ 0,066576 — o PIOR caso reservado
// (max_tokens × preço) lançado como gasto "conservador" —, enquanto a fatura
// do fake era US$ 0 (smoke da onda 2 na SPA: "CUSTO $0.0622" para 1 chamada).
// A mesma chamada, cancelada um instante DEPOIS do 1º chunk (com id de
// geração), ficava PENDENTE e fora do gasto: o desfecho mudava por um detalhe.
//
// Contrato agora: chamada interrompida pelo CANCELAR sem custo medido fica
// PENDENTE — limite superior FORA do gasto (`pendingUsd`), com ou sem id — e
// nunca vira "custou zero": segue no `committedUsd`/porta/teto diário; uma
// conciliação posterior a lança como conservadora (sem id não há /generation).
// Timeout sem id (a run segue) continua conservador, como antes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGateway, setDefaultGateway, type FetchLike, type OpenRouterGateway } from '../src/openrouter.js';
import { BudgetLedger, RunCancelled } from '../src/budget.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion as runWeb, cancelRun } from '../web/src/engine/orchestrator.js';
import type { RunConfig, RunRecord } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => true,
  saveSession: async () => true,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const CFG = {
  mode: 'compare',
  theme: 'cancelar no datagen',
  stages: 4,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  finalists: 2,
  timeoutMs: 60_000,
} as const;

/** Toda chamada de chat fica em voo até o abort (que rejeita como o navegador). */
function transporteEmVoo() {
  const base = fakeOpenRouter({
    catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b'].map((id) => catalogItem(id, 2e-6, 8e-6)),
    chat: () => ({ text: '{"stages":[]}', usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0002 } }),
  });
  const st = { emVoo: 0 };
  const fetch: FetchLike = async (url, init) => {
    if (new URL(url).pathname.endsWith('/chat/completions')) {
      st.emVoo += 1;
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    return base.fetch(url, init);
  };
  return { fetch, st, base };
}

async function esperar(cond: () => boolean): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > 5_000) throw new Error('condição não chegou a tempo');
    await new Promise((r) => setTimeout(r, 2));
  }
}

let anterior: OpenRouterGateway | undefined;
let dir: string;
let dirAnterior: string;
let silencio: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  dirAnterior = getDataDir();
  dir = mkdtempSync(path.join(tmpdir(), 'pb-left14-'));
  setDataDir(dir);
  silencio = (['log', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
  setDataDir(dirAnterior);
  rmSync(dir, { recursive: true, force: true });
  silencio.forEach((s) => s.mockRestore());
});

function conferirCancelado(rec: RunRecord, billed: number): void {
  expect(rec.status).toBe('aborted');
  expect(rec.stoppedReason).toBe('cancelled');
  // o gasto é o MEDIDO (a fatura) — a reserva não entra nele
  expect(rec.totalCostUsd).toBe(0);
  expect(rec.totalCostUsd).toBeCloseTo(billed, 12);
  expect(rec.costByRole?.datagen).toMatchObject({ calls: 0, usd: 0 });
  // …mas também não "custou zero": pendente, com o limite superior visível
  const lg = rec.costLedger!;
  expect(lg.conservativeCalls).toBe(0);
  expect(lg.conservativeUsd).toBe(0);
  expect(lg.pendingCalls).toBe(1);
  expect(lg.pendingUsd).toBeGreaterThan(0.01); // a reserva do lote (max_tokens × preço)
  expect(lg.committedUsd).toBeCloseTo(lg.pendingUsd, 12);
  expect(lg.pendingEntries).toEqual([
    { generationId: '', role: 'datagen', modelId: 'fake/gen', usd: lg.pendingUsd, reason: 'aborted' },
  ]);
  expect(rec.callLog).toEqual([
    expect.objectContaining({ role: 'datagen', status: 'pending', source: 'unknown', usd: lg.pendingUsd }),
  ]);
  expect(rec.callLog?.[0]).not.toHaveProperty('generationId');
  expect(rec.costAccuracy).toEqual({ exact: 0, estimated: 0, unknown: 0 });
}

describe('left#14 — cancelar no datagen: reserva PENDENTE, nunca gasto medido', () => {
  it('motor Node', async () => {
    const t = transporteEmVoo();
    anterior = setDefaultGateway(createGateway({ fetch: t.fetch, sleep: noSleep }));
    const ac = new AbortController();
    const fim = runNode(CFG as unknown as RunConfig, KEY, { runId: 'left14-node', ctx: { signal: ac.signal } });
    await esperar(() => t.st.emVoo === 1);
    ac.abort(new RunCancelled('clique'));
    conferirCancelado((await fim) as RunRecord, t.base.billedUsd());
  });

  it('motor da SPA', async () => {
    const t = transporteEmVoo();
    anterior = setDefaultGateway(createGateway({ fetch: t.fetch, sleep: noSleep }));
    const fim = runWeb(CFG as never, KEY, { runId: 'left14-web' });
    await esperar(() => t.st.emVoo === 1);
    expect(cancelRun('left14-web')).toBe(true);
    conferirCancelado((await fim) as unknown as RunRecord, t.base.billedUsd());
  });
});

describe('left#14 — o pendente SEM id: seguro para o teto e conciliado como conservador', () => {
  it('conta na porta/teto (committed) e a conciliação o lança conservador SEM consultar o /generation', async () => {
    const ledger = new BudgetLedger({ budgetUsd: 1, estimateCall: () => 0.3 });
    const r = ledger.reserve('datagen', 'fake/gen', 100, 1000);
    ledger.pending(r, { role: 'datagen', modelId: 'fake/gen', reason: 'aborted' });
    expect(r.status).toBe('pending');
    expect(ledger.spentUsd).toBe(0);
    expect(ledger.pendingUsd).toBeCloseTo(0.3, 12);
    expect(ledger.remainingUsd()).toBeCloseTo(0.7, 12);
    expect(ledger.canAfford(0.75)).toBe(false);

    const gets: string[] = [];
    const gw = createGateway({
      fetch: async (url) => {
        gets.push(url);
        return new Response('{}', { status: 404 });
      },
      sleep: noSleep,
    });
    const out = await gw.reconcilePending(ledger, KEY);
    expect(out).toEqual({ attempted: 1, settled: 0, notFound: 1, failed: 0 });
    expect(gets, 'id vazio não vai ao /generation').toEqual([]);
    expect(ledger.summary()).toMatchObject({ spentUsd: 0.3, pendingUsd: 0, pendingCalls: 0, conservativeUsd: 0.3, conservativeCalls: 1 });
    expect(ledger.callLog()[0]).toMatchObject({ status: 'conservative', usd: 0.3, source: 'unknown' });
  });

  it('timeout sem id (a run segue) continua CONSERVADOR na hora — só o Cancelar mudou', () => {
    const ledger = new BudgetLedger({ budgetUsd: 1, estimateCall: () => 0.2 });
    const r = ledger.reserve('judge', 'm', 10, 100);
    ledger.pending(r, { role: 'judge', modelId: 'm', reason: 'timeout' });
    expect(r.status).toBe('conservative');
    expect(ledger.spentUsd).toBeCloseTo(0.2, 12);
    expect(ledger.pendingUsd).toBe(0);
  });
});
