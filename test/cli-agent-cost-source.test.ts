// IMPL-096 (R-14b:REC-5) — fonte HONESTA de custo nas anotações de ledger do
// modo agente. O contrato cobre AS TRÊS fontes:
//   - `usage`        → medido no gateway (ou conciliado com o /generation): a
//                      ÚNICA fonte exata;
//   - `agent-derived` → o EXECUTOR calculou o custo (tabela própria/relatório
//                      dele) — nunca rotulado de 'catalog';
//   - `catalog`      → estimativa por tabela do /models.
// E as duas regras de higiene do mesmo item: NENHUMA reserva de ledger com 0
// tokens (a anotação de gasto já realizado não reserva nada) e o evento
// `agent.turn` carrega o custo REAL do turno quando há uso registrado.
//
// Caminho testado: `runAgentStage` com executor que NÃO passa pelo proxy de
// custo (adaptador sem base URL configurável — exatamente o trecho que antes
// gravava `cost: { source: 'catalog' }` com `reserve(0, 0)`).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BudgetLedger } from '../src/budget.js';
import { createGateway, setDefaultGateway } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runAgentStage, type AgentGateway, type RunAgentStageParams } from '../src/agent/runAgentStage.js';
import { subscribe } from '../src/events.js';
import type { AgentCostSource } from '../src/agent/types.js';
import type { PiRunOutcome } from '../src/agent/pi.js';
import type { CostSink, RunEvent } from '../src/types.js';

const KEY = 'sk-teste-096';

// ---------------------------------------------------------------------------
// Espião de ledger: captura as ANOTAÇÕES (note) e as RESERVAS (reserve) que o
// modo agente faz, sem decorar o contrato de implementação do BudgetLedger.
// ---------------------------------------------------------------------------

interface NotaCapturada {
  role: string;
  modelId: string;
  cost: { usd: number; source: string };
  tokensIn: number;
  tokensOut: number;
}

interface ReservaCapturada {
  promptTokensGuess: number;
  maxTokens: number;
}

function espiaLedger(ledger: BudgetLedger): { sink: CostSink; notas: NotaCapturada[]; reservas: ReservaCapturada[] } {
  const notas: NotaCapturada[] = [];
  const reservas: ReservaCapturada[] = [];
  const sink: CostSink = {
    reserve: (role, modelId, promptTokensGuess, maxTokens, fallbackUsd) => {
      reservas.push({ promptTokensGuess, maxTokens });
      return ledger.reserve(role, modelId, promptTokensGuess, maxTokens, fallbackUsd);
    },
    pending: (reservation, entry) => ledger.pending(reservation, entry),
    note: (reservation, entry) => {
      notas.push({
        role: entry.role,
        modelId: entry.modelId,
        cost: { usd: entry.cost.usd, source: entry.cost.source },
        tokensIn: entry.tokensIn,
        tokensOut: entry.tokensOut,
      });
      ledger.note(reservation, entry);
    },
  };
  return { sink, notas, reservas };
}

// ---------------------------------------------------------------------------
// Executor falso SEM proxy: reporta usage/trajectory com a fonte pedida e emite
// UM turno com custo real (a ponte onEvent → agent.turn).
// ---------------------------------------------------------------------------

function gatewayDerivado(opts: {
  costUsd: number;
  costSource: AgentCostSource;
  turnCostUsd?: number;
}): AgentGateway {
  return {
    id: 'fake-096',
    prepare: async () => ({ bin: 'pi-fake', env: { PATH: '/usr/bin:/bin' } }),
    run: async (o) => {
      if (opts.turnCostUsd !== undefined) {
        o.onEvent?.({ type: 'turn', index: 1, total: 1, costUsd: opts.turnCostUsd });
      }
      return {
        stopReason: 'completed',
        turns: 1,
        toolCalls: 0,
        durationMs: 5,
        usage: { tokensIn: 7, tokensOut: 5, costUsd: opts.costUsd },
        trajectory: {
          format: 'agent-trajectory@1',
          executor: { id: 'fake-096', version: '0' },
          model: { provider: 'openrouter', id: 'openai/gpt-4o-mini' },
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 5,
          stopReason: 'completed',
          turns: [],
          usage: {
            tokensIn: 7,
            tokensOut: 5,
            tokensReasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            costUsd: opts.costUsd,
            costSource: opts.costSource,
          },
          parseErrors: 0,
          compactions: [],
        },
        parseErrors: 0,
        responseIds: [],
        stderrTail: '',
        exitCode: 0,
        signal: null,
      } as PiRunOutcome;
    },
  };
}

function stageParams(over: Partial<RunAgentStageParams> & Pick<RunAgentStageParams, 'runId' | 'gateway' | 'ctx' | 'dataDir'>): RunAgentStageParams {
  return {
    stageIndex: 0,
    contestant: { id: 'ag', label: 'ag', modelId: 'openai/gpt-4o-mini', runner: 'agent' },
    stage: { question: 'q', productContext: 'c', maxTokens: 10, agentTask: {} },
    agentConfig: { executor: 'pi', executorVersion: '0', limits: { maxCostUsd: 1 } },
    apiKey: KEY,
    catalog: [],
    judgeModelIds: [],
    ...over,
  };
}

let home = '';
let anteriorDataDir = '';
let gatewayAnterior: ReturnType<typeof createGateway>;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'pb-cost-source-'));
  anteriorDataDir = getDataDir();
  setDataDir(home);
  // Gateway default só para o runAgentStage não reclamar; nenhuma chamada sai
  // (o gateway da execução é o fake injetado).
  gatewayAnterior = setDefaultGateway(createGateway({ baseUrl: 'http://127.0.0.1:9/api/v1' }));
});

afterAll(() => {
  setDefaultGateway(gatewayAnterior);
  setDataDir(anteriorDataDir);
  if (home) rmSync(home, { force: true, recursive: true });
});

describe('IMPL-096 — costSource honesto em toda anotação de ledger do modo agente', () => {
  it("valor reportado pelo executor vira 'agent-derived' (NUNCA 'catalog'), com tokens reais", async () => {
    const ledger = new BudgetLedger();
    const { sink, notas, reservas } = espiaLedger(ledger);
    const res = await runAgentStage(
      stageParams({
        runId: 'run-096-derived',
        gateway: gatewayDerivado({ costUsd: 0.42, costSource: 'agent-derived' }),
        ctx: { sink },
        dataDir: home,
      }),
    );
    expect(res.repResults[0].costUsd).toBeCloseTo(0.42, 12);
    // UMA anotação, papel agent, fonte honesta e tokens reais (nunca 0/0).
    expect(notas).toHaveLength(1);
    expect(notas[0]).toMatchObject({
      role: 'agent',
      modelId: 'openai/gpt-4o-mini',
      cost: { usd: 0.42, source: 'agent-derived' },
      tokensIn: 7,
      tokensOut: 5,
    });
    // Gasto já realizado NÃO reserva: nada de reserve(…, 0, 0) poluindo o ledger.
    expect(reservas).toHaveLength(0);
  });

  it("estimativa por tabela do executor chega ao ledger como 'catalog'", async () => {
    const ledger = new BudgetLedger();
    const { sink, notas } = espiaLedger(ledger);
    await runAgentStage(
      stageParams({
        runId: 'run-096-catalog',
        gateway: gatewayDerivado({ costUsd: 0.11, costSource: 'catalog' }),
        ctx: { sink },
        dataDir: home,
      }),
    );
    expect(notas).toHaveLength(1);
    expect(notas[0].cost).toEqual({ usd: 0.11, source: 'catalog' });
  });

  it("medido no gateway ('usage') e conciliado ('reconciled') chegam ao ledger como 'usage' — a única fonte exata", async () => {
    const ledger = new BudgetLedger();
    const { sink, notas } = espiaLedger(ledger);
    await runAgentStage(
      stageParams({
        runId: 'run-096-usage',
        gateway: gatewayDerivado({ costUsd: 0.2, costSource: 'usage' }),
        ctx: { sink },
        dataDir: home,
      }),
    );
    await runAgentStage(
      stageParams({
        runId: 'run-096-reconciled',
        gateway: gatewayDerivado({ costUsd: 0.3, costSource: 'reconciled' }),
        ctx: { sink },
        dataDir: home,
      }),
    );
    expect(notas.map((n) => n.cost.source)).toEqual(['usage', 'usage']);
    // 'usage' é a única que conta como EXATA no relatório de precisão.
    expect(ledger.accuracy.exact).toBe(2);
    expect(ledger.accuracy.unknown).toBe(0);
  });

  it("nenhuma anotação de modo agente sai 'unknown' quando o valor é conhecido", async () => {
    const ledger = new BudgetLedger();
    const { sink, notas } = espiaLedger(ledger);
    for (const [i, costSource] of (['agent-derived', 'catalog', 'usage', 'reconciled'] as AgentCostSource[]).entries()) {
      await runAgentStage(
        stageParams({
          runId: `run-096-fontes-${i}`,
          gateway: gatewayDerivado({ costUsd: 0.05, costSource }),
          ctx: { sink },
          dataDir: home,
        }),
      );
    }
    expect(notas).toHaveLength(4);
    for (const n of notas) expect(n.cost.source).not.toBe('unknown');
  });

  it('agent.turn carrega o custo REAL do turno quando há uso registrado (nunca 0)', async () => {
    const eventos: RunEvent[] = [];
    const cancelar = subscribe('run-096-turn', (e) => eventos.push(e));
    try {
      const ledger = new BudgetLedger();
      const { sink } = espiaLedger(ledger);
      await runAgentStage(
        stageParams({
          runId: 'run-096-turn',
          gateway: gatewayDerivado({ costUsd: 0.42, costSource: 'agent-derived', turnCostUsd: 0.17 }),
          ctx: { sink },
          dataDir: home,
        }),
      );
    } finally {
      cancelar();
    }
    const turnos = eventos.filter((e) => e.type === 'agent.turn');
    expect(turnos.length).toBeGreaterThan(0);
    for (const t of turnos) {
      if (t.type === 'agent.turn') expect(t.costUsd).toBeCloseTo(0.17, 12);
    }
  });
});
