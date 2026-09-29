// Fechamento terminal da run no motor Node (revisão da onda 1).
//
//  IMPL-074/IMPL-017 × `executeRun`: nas saídas por porta suave de orçamento
//  e por sinal de controle, o `run.finished` era emitido ANTES da conciliação
//  pela fatura e da escrita terminal (que só rodavam no `finally`). O NDJSON
//  do CLI, o SSE e o registro do httpRunControl viam `totalCostUsd`/`pendingUsd`
//  de ANTES da conciliação, e o disco e o `--json` mostravam os números
//  conciliados: dois totais no mesmo stdout. O espelho web já conciliava antes.
//
//  httpRunControl × terminal: o registro solta a entrada no evento terminal; um
//  cancel nessa janela lia o disco ('running') e respondia "não roda neste
//  servidor" para uma run que ESTE servidor acabou de terminar.
//
// Transporte falso, zero rede, zero gasto.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway, type FetchLike, type OpenRouterGateway } from '../src/openrouter.js';
import { getDataDir, loadRun, setDataDir } from '../src/storage.js';
import { runToCompletion } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { subscribeRun as subscribeWeb } from '../web/src/engine/events.js';
import { subscribe } from '../src/events.js';
import { emitRunEvent } from '../src/cli/ndjson.js';
import type { Output } from '../src/cli/output.js';
import { cancelControlled, startControlledRun, type CancelOutcome } from '../src/httpRunControl.js';
import type { RunConfig, RunEvent, RunRecord } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-run-end-close-0000000000';
const gid = (n: number): string => `gen-1758926640-${String(n).padStart(20, 'y')}`;

let dir = '';
let dirAnterior = '';
let silencio: Array<{ mockRestore(): void }> = [];
let gwAnterior: OpenRouterGateway | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-run-end-close-'));
  dirAnterior = getDataDir();
  setDataDir(dir);
  silencio = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
});
afterAll(() => {
  silencio.forEach((s) => s.mockRestore());
  setDataDir(dirAnterior);
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  if (gwAnterior) setDefaultGateway(gwAnterior);
  gwAnterior = undefined;
});

/**
 * Datagen e gabarito respondem SEM bloco usage (cobrados, custo não medido:
 * ficam PENDENTES pelo id de geração); o GET /generation devolve a fatura.
 * Competidores e juiz são caros no catálogo: a porta suave de G2 recusa.
 */
function gatewayComPendentes(): { fatura: Map<string, number>; gets: string[] } {
  const fatura = new Map<string, number>();
  const gets: string[] = [];
  let n = 0;
  const chat = fakeOpenRouter({
    catalog: [
      catalogItem('fake/gen', 1e-7, 1e-7),
      catalogItem('fake/ref', 1e-7, 1e-7),
      catalogItem('fake/judge', 1e-3, 1e-3),
      catalogItem('fake/a', 1e-3, 1e-3),
      catalogItem('fake/b', 1e-3, 1e-3),
    ],
    chat: (req) => {
      const id = gid(n++);
      fatura.set(id, 0.0007);
      if (req.model === 'fake/gen') {
        return {
          id,
          usage: null,
          text: JSON.stringify({
            stages: [
              { question: 'Qual o prazo de troca de um tenis?', productContext: 'Troca em 30 dias com nota.', maxTokens: 200 },
              { question: 'Como pedir reembolso pelo app?', productContext: 'Reembolso pelo app em 7 dias.', maxTokens: 200 },
            ],
          }),
        };
      }
      return { id, usage: null, text: `Gabarito: ${req.user.slice(0, 30)}` };
    },
  });
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/generation')) {
      const id = u.searchParams.get('id') ?? '';
      gets.push(id);
      const total = fatura.get(id);
      return total === undefined
        ? new Response('not found', { status: 404 })
        : new Response(JSON.stringify({ data: { id, total_cost: total } }), { status: 200 });
    }
    return chat.fetch(url, init);
  };
  gwAnterior = setDefaultGateway(createGateway({ fetch, sleep: noSleep, providerLookup: 'off' }));
  return { fatura, gets };
}

const CONFIG = {
  mode: 'compare',
  theme: 'suporte',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  finalists: 0,
  duels: false,
  timeoutMs: 5_000,
  // Paga o datagen+gabarito (baratos) e recusa competidores+juiz (caros).
  budgetUsd: 0.05,
} as unknown as RunConfig;

/** O mapeamento NDJSON do CLI, ligado ao evento no instante em que sai. */
function capturarNdjson(runId: string): { linhas: { type: string; payload: Record<string, unknown> }[]; off: () => void } {
  const linhas: { type: string; payload: Record<string, unknown> }[] = [];
  const out = {
    isNdjson: true,
    event: (type: string, payload: Record<string, unknown> = {}) => {
      // Cópia NO INSTANTE da emissão (o record segue mutável depois).
      linhas.push({ type, payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown> });
    },
  } as unknown as Output;
  const off = subscribe(runId, (e: RunEvent) => emitRunEvent(out, e));
  return { linhas, off };
}

describe('executeRun (Node): conciliação e escrita terminal ANTES do run.finished', () => {
  it('porta suave de orçamento com pendentes: o NDJSON run.finished traz os MESMOS totais do record final', async () => {
    const { fatura, gets } = gatewayComPendentes();
    const runId = '00000000-0000-4000-8000-00000000c105';
    const { linhas, off } = capturarNdjson(runId);
    let rec: RunRecord;
    try {
      rec = await runToCompletion(CONFIG, KEY, { runId });
    } finally {
      off();
    }
    // Parou na porta suave (não por exceção): o parcial por orçamento.
    expect(rec.status).toBe('aborted');
    expect(rec.stoppedReason).toBe('budget');
    expect(rec.stoppedAtPhase).toBe('competitors');
    // Houve pendentes de verdade e a conciliação rodou UMA vez por id.
    expect(gets.length).toBeGreaterThan(0);
    expect(new Set(gets).size).toBe(gets.length);
    expect(rec.costLedger?.pendingUsd).toBe(0);
    const totalFatura = [...fatura.values()].reduce((s, v) => s + v, 0);
    expect(rec.totalCostUsd).toBeCloseTo(totalFatura, 10);

    const fim = linhas.filter((l) => l.type === 'run.finished');
    expect(fim).toHaveLength(1);
    const ev = fim[0].payload as { status: string; totalCostUsd: number; costLedger?: { pendingUsd: number; spentUsd: number } };
    expect(ev.status).toBe('aborted');
    expect(ev.totalCostUsd).toBe(rec.totalCostUsd);
    expect(ev.costLedger?.pendingUsd).toBe(0);
    expect(ev.costLedger?.spentUsd).toBe(rec.costLedger?.spentUsd);
    // E o disco (o que o `--json` do CLI relê) diz o mesmo.
    const disco = await loadRun(rec.id);
    expect(disco?.totalCostUsd).toBe(ev.totalCostUsd);
    expect(disco?.costLedger?.pendingUsd).toBe(0);
  });

  it('SPA (espelho): a MESMA saída por orçamento concilia antes do evento (nada de pular a fatura no budget)', async () => {
    const { fatura } = gatewayComPendentes();
    const runId = '00000000-0000-4000-8000-00000000c106';
    let noEvento: { total: number; pending?: number } | undefined;
    const off = subscribeWeb(runId, (e) => {
      if (e.type === 'run.finished') noEvento = { total: e.record.totalCostUsd, pending: e.record.costLedger?.pendingUsd };
    });
    let rec: RunRecord;
    try {
      rec = (await runWeb(CONFIG as never, KEY, { runId })) as unknown as RunRecord;
    } finally {
      off();
    }
    expect(rec.stoppedReason).toBe('budget');
    expect(rec.costLedger?.pendingUsd).toBe(0);
    expect(rec.totalCostUsd).toBeCloseTo([...fatura.values()].reduce((a, v) => a + v, 0), 10);
    expect(noEvento).toEqual({ total: rec.totalCostUsd, pending: 0 });
  });

  it('cancel HTTP na janela do terminal: 409 "já terminou" — nunca "não roda neste servidor"', async () => {
    gatewayComPendentes();
    const { runId } = startControlledRun(CONFIG, KEY);
    let pedido: Promise<CancelOutcome> | undefined;
    let statusNoDisco: string | undefined;
    const terminou = new Promise<void>((resolve) => {
      // Assinado DEPOIS do registro do httpRunControl: quando este listener
      // roda, a entrada do registro já foi solta (a janela do bug).
      const off = subscribe(runId, (e) => {
        if (e.type !== 'run.finished' && e.type !== 'run.error') return;
        off();
        pedido = cancelControlled('run', runId);
        void loadRun(runId).then((r) => {
          statusNoDisco = r?.status;
          resolve();
        });
      });
    });
    await terminou;
    const r = await pedido!;
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toMatch(/já terminou/u);
    expect((r.body as { error: string }).error).not.toMatch(/não roda neste servidor/u);
    // A escrita terminal saiu ANTES do evento: o disco já não diz 'running'.
    expect(statusNoDisco).toBe('aborted');
  });
});
