// IMPL-032 (R-14a REC-1 / DEC-1) — teste de CONTRATO da árvore de veredito de
// agente e dos três consumidores da nota.
//
// A regra: execução cortada por LIMITE (timeout/maxTurns/maxCost/maxOutput) sem
// oráculo 100% conta 'nao' no denominador de judge-score, resolveRate e vetor de
// significância; `incomplete` só existe para os sinais de CONTROLE
// (cancelamento e orçamento da run). Antes o corte virava `verdict: null` e saía
// do placar — o defeito A4 (viés de sobrevivência): um agente que estourava o
// teto nas tarefas difíceis ficava com nota perfeita nas fáceis.
//
// Camadas testadas (da mais pura à ponta a ponta), todas sem rede e sem gasto:
//   1. `decideRepVerdict` — os 9 caminhos + A4/A5 + varredura de `incomplete`;
//   2. `agentRateMetrics` — métrica principal × diagnóstico censurado;
//   3. `runAgentStage` com executor injetado (workspace git e oráculo REAIS);
//   4. `runToCompletion` (Node) com o `pi` trocado por um executor falso — o
//      record final, o vetor que o treino usa na significância e as portas de
//      controle (cancelamento/orçamento).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Executor FALSO no lugar do `pi` (o orquestrador não aceita gateway injetado:
// ele sempre usa o `piExecutor` do módulo). O roteiro de cada teste diz, por
// (modelo, pergunta, repetição), como a execução termina e o que ela escreve
// no workspace — o resto (git, oráculo, dossiê, store, árvore) é o código real.
// ---------------------------------------------------------------------------
type Roteiro = (c: { modelId: string; question: string; rep: number }) => {
  stopReason: string;
  /** Arquivos escritos no workspace antes de "terminar". */
  write?: string[];
  /** Efeito colateral (ex.: abortar a run). */
  before?: () => void;
  /** Falha de infraestrutura: o executor lança em vez de devolver outcome. */
  throws?: string;
};

const fake = vi.hoisted(() => ({
  roteiro: (() => ({ stopReason: 'completed' })) as unknown as Roteiro,
  calls: 0,
}));

vi.mock('../src/agent/pi.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/agent/pi.js')>();
  const { writeFileSync: write } = await import('node:fs');
  const { join } = await import('node:path');
  return {
    ...orig,
    piExecutor: {
      ...orig.piExecutor,
      id: 'pi-fake',
      prepare: async () => ({ bin: 'pi-fake', env: {} }),
      run: async (opts: { workspaceDir: string; workDir: string; env: Record<string, string> }) => {
        fake.calls += 1;
        const rep = Number(opts.workDir.split(/[\\/]/).pop());
        const passo = fake.roteiro({ modelId: opts.env.PI_MODEL_ID, question: opts.env.PI_TASK, rep });
        passo.before?.();
        if (passo.throws) throw new Error(passo.throws);
        for (const f of passo.write ?? []) write(join(opts.workspaceDir, f), 'ok\n', 'utf8');
        return fakeOutcome(passo.stopReason, opts.env.PI_MODEL_ID);
      },
    },
  };
});

function fakeOutcome(stopReason: string, modelId: string) {
  const now = new Date().toISOString();
  const usage = {
    tokensIn: 10,
    tokensOut: 5,
    tokensReasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0.001,
    costSource: 'agent-derived' as const,
  };
  return {
    stopReason,
    turns: 1,
    toolCalls: 0,
    durationMs: 5,
    usage: { tokensIn: 10, tokensOut: 5, costUsd: 0.001 },
    trajectory: {
      format: 'agent-trajectory@1' as const,
      executor: { id: 'pi-fake', version: '0' },
      model: { provider: 'openrouter', id: modelId },
      startedAt: now,
      finishedAt: now,
      durationMs: 5,
      stopReason,
      turns: [{ index: 0, text: 'terminei', steps: [] }],
      usage,
      parseErrors: 0,
      compactions: [],
    },
    parseErrors: 0,
    responseIds: [],
    stderrTail: '',
    exitCode: stopReason === 'completed' ? 0 : null,
    signal: null,
  };
}

import {
  AGENT_VERDICT_TREE_VERSION,
  LIMIT_STOP_REASONS,
  VERDICT_PATHS,
  agentRateMetrics,
  agentVerdictTreeVersionOf,
  classifyStop,
  decideRepVerdict,
  stageObservations,
  type TreeDecision,
  type VerdictPath,
} from '../src/agent/verdictTree.js';
import { runAgentStage, type AgentGateway, type RunAgentStageParams } from '../src/agent/runAgentStage.js';
import { isControlSignal } from '../src/budget.js';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion } from '../src/orchestrator.js';
import { pairedStageScores } from '../src/trainer.js';
import { pairedSignificance } from '../src/stats.js';
import { judgeScoreFromVerdicts } from '../src/rank.js';
import { normalizeRunRecord } from '../src/normalize.js';
import { emitRunEvent } from '../src/cli/ndjson.js';
import type { Output } from '../src/cli/output.js';
import type { RunConfig, RunRecord, StageSpec, Verdict } from '../src/types.js';
import type { AgentTaskSpec } from '../src/agent/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter } from './fakeOpenRouter.js';

const LIMITES = ['timeout', 'maxTurns', 'maxCost', 'maxOutput'] as const;
const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

// ===========================================================================
// 1. Árvore PURA
// ===========================================================================

describe('IMPL-032 — árvore de veredito: os 9 caminhos', () => {
  const casos: Array<{
    nome: string;
    input: Parameters<typeof decideRepVerdict>[0];
    path: VerdictPath;
    esperado: Partial<TreeDecision>;
  }> = [
    {
      nome: '1 cancelled → sem veredito (incomplete, controle)',
      input: { stopReason: 'cancelled', diffEmpty: false },
      path: 'cancelled',
      esperado: { kind: 'incomplete' },
    },
    {
      nome: "2 error → 'nao' (processo morreu — A5 até o IMPL-094)",
      input: { stopReason: 'error', diffEmpty: false },
      path: 'error',
      esperado: { kind: 'final', verdict: 'nao' },
    },
    {
      nome: "3 limit-cut → 'nao' (timeout sem oráculo 100%)",
      input: { stopReason: 'timeout', diffEmpty: false },
      path: 'limit-cut',
      esperado: { kind: 'final', verdict: 'nao' },
    },
    {
      nome: "4 oracle-violation → 'nao' (forbiddenPaths tocados)",
      input: { stopReason: 'completed', oracle: { score: 1, violations: ['tests/a.test.ts'] }, diffEmpty: false },
      path: 'oracle-violation',
      esperado: { kind: 'final', verdict: 'nao' },
    },
    {
      nome: "5 oracle-pass → juiz gradua 'resolve' (piso 'parcial')",
      input: { stopReason: 'completed', oracle: { score: 1, violations: [] }, diffEmpty: false },
      path: 'oracle-pass',
      esperado: { kind: 'judge', candidate: 'resolve', floor: 'parcial' },
    },
    {
      nome: "6 oracle-fail → 'nao' (score 0)",
      input: { stopReason: 'completed', oracle: { score: 0, violations: [] }, diffEmpty: false },
      path: 'oracle-fail',
      esperado: { kind: 'final', verdict: 'nao' },
    },
    {
      nome: "7 oracle-partial → juiz gradua 'parcial' (piso 'nao')",
      input: { stopReason: 'completed', oracle: { score: 0.5, violations: [] }, diffEmpty: false },
      path: 'oracle-partial',
      esperado: { kind: 'judge', candidate: 'parcial', floor: 'nao' },
    },
    {
      nome: "8 no-oracle-empty → 'nao' (completou sem mudar nada)",
      input: { stopReason: 'completed', diffEmpty: true },
      path: 'no-oracle-empty',
      esperado: { kind: 'final', verdict: 'nao' },
    },
    {
      nome: '9 no-oracle-judge → juiz pleno pelo dossiê',
      input: { stopReason: 'completed', diffEmpty: false },
      path: 'no-oracle-judge',
      esperado: { kind: 'judge', candidate: 'parcial', floor: 'nao' },
    },
  ];

  it('a tabela cobre exatamente os 9 caminhos declarados', () => {
    expect(VERDICT_PATHS).toHaveLength(9);
    expect(new Set(casos.map((c) => c.path))).toEqual(new Set(VERDICT_PATHS));
  });

  for (const c of casos) {
    it(c.nome, () => {
      const d = decideRepVerdict(c.input);
      expect(d.path).toBe(c.path);
      expect(d).toMatchObject(c.esperado);
    });
  }
});

describe('IMPL-032 — A4: corte por limite sem oráculo 100% conta nao', () => {
  // Todo oráculo que NÃO é "passou inteiro e limpo" — inclusive a violação de
  // forbiddenPaths seguida de teto, que antes sumia do placar (A4).
  const oraculosNao100: Array<{ nome: string; oracle?: { score: number; violations: string[] } }> = [
    { nome: 'sem oráculo' },
    { nome: 'oráculo 0%', oracle: { score: 0, violations: [] } },
    { nome: 'oráculo parcial', oracle: { score: 0.5, violations: [] } },
    { nome: 'oráculo 99%', oracle: { score: 0.99, violations: [] } },
    { nome: 'oráculo 100% COM violação', oracle: { score: 1, violations: ['secret.txt'] } },
  ];

  it('os 4 limites são exatamente timeout/maxTurns/maxCost/maxOutput', () => {
    expect([...LIMIT_STOP_REASONS].sort()).toEqual([...LIMITES].sort());
    for (const r of LIMITES) expect(classifyStop(r)).toBe('limit');
  });

  for (const stopReason of LIMITES) {
    for (const o of oraculosNao100) {
      for (const diffEmpty of [true, false]) {
        it(`${stopReason} · ${o.nome} · diff ${diffEmpty ? 'vazio' : 'com mudança'} → 'nao' final, sem juiz`, () => {
          const d = decideRepVerdict({ stopReason, oracle: o.oracle, diffEmpty });
          expect(d.kind).toBe('final');
          expect(d.path).toBe('limit-cut');
          if (d.kind === 'final') expect(d.verdict).toBe('nao');
        });
      }
    }
  }

  it('exceção ÚNICA: corte com oráculo 100% limpo segue para graduação (mundo verificado)', () => {
    for (const stopReason of LIMITES) {
      const d = decideRepVerdict({ stopReason, oracle: { score: 1, violations: [] }, diffEmpty: false });
      expect(d).toMatchObject({ kind: 'judge', path: 'oracle-pass', candidate: 'resolve', floor: 'parcial' });
    }
  });
});

describe("IMPL-032 — 'incomplete' só para cancelamento (varredura exaustiva)", () => {
  const motivos = ['completed', 'cancelled', 'error', ...LIMITES, 'motivo-desconhecido'];
  const oraculos = [
    undefined,
    { score: 0, violations: [] },
    { score: 0.5, violations: [] },
    { score: 1, violations: [] },
    { score: 1, violations: ['x'] },
  ];
  it('kind === incomplete ⇔ stopReason === cancelled', () => {
    for (const stopReason of motivos) {
      for (const oracle of oraculos) {
        for (const diffEmpty of [true, false]) {
          const d = decideRepVerdict({ stopReason, oracle, diffEmpty });
          expect(d.kind === 'incomplete', `${stopReason}/${JSON.stringify(oracle)}/${diffEmpty}`).toBe(
            stopReason === 'cancelled',
          );
        }
      }
    }
  });

  it('A5: error conta nao (no denominador) e motivo desconhecido NUNCA vira cancelled', () => {
    expect(classifyStop('error')).toBe('error');
    expect(classifyStop('algo-novo-do-executor')).toBe('error');
    for (const oracle of oraculos) {
      const d = decideRepVerdict({ stopReason: 'error', oracle, diffEmpty: false });
      expect(d).toMatchObject({ kind: 'final', path: 'error', verdict: 'nao' });
      const u = decideRepVerdict({ stopReason: 'algo-novo-do-executor', oracle, diffEmpty: false });
      expect(u).toMatchObject({ kind: 'final', path: 'error', verdict: 'nao' });
    }
  });
});

// ===========================================================================
// 2. Métricas (consumidores puros)
// ===========================================================================

describe('IMPL-032 — métricas: principal nunca exclui; censurada só diagnóstico', () => {
  // Agente X: resolve nas fáceis, cortado por limite nas difíceis.
  // Agente Y: termina tudo, resolve metade.
  const etapas = [
    { verdictByContestant: { x: 'resolve' as Verdict, y: 'resolve' as Verdict } },
    { verdictByContestant: { x: 'nao' as Verdict, y: 'nao' as Verdict }, limitCutByContestant: { x: 1 } },
    { verdictByContestant: { x: 'resolve' as Verdict, y: 'resolve' as Verdict } },
    { verdictByContestant: { x: 'nao' as Verdict, y: 'nao' as Verdict }, limitCutByContestant: { x: 1 } },
  ];

  it('resolveRate principal conta o corte como nao; viés de sobrevivência = 0', () => {
    const m = agentRateMetrics(etapas, ['x', 'y']);
    expect(m.resolveRateByContestant).toEqual({ x: 0.5, y: 0.5 });
    // Viés de sobrevivência da métrica PRINCIPAL: diferença contra a taxa com
    // TODAS as execuções no denominador — alvo 0 (R-14a REC-1, limiar ≤ 0).
    const completa = (id: 'x' | 'y') =>
      etapas.filter((s) => s.verdictByContestant[id] === 'resolve').length / etapas.length;
    expect(m.resolveRateByContestant.x - completa('x')).toBe(0);
    expect(m.resolveRateByContestant.y - completa('y')).toBe(0);
    // A censurada (sem os cortes) existe, mas só como diagnóstico: é ela que
    // mostraria X "perfeito" — e por isso nunca alimenta o placar.
    expect(m.censoredResolveRateByContestant).toEqual({ x: 1, y: 0.5 });
    expect(m.limitCutsByContestant).toEqual({ x: 2, y: 0 });
    expect(m.resolveRateByContestant.x).toBeLessThanOrEqual(m.censoredResolveRateByContestant.x);
  });

  it('todas as observações cortadas: principal 0, censurada ausente (sem denominador)', () => {
    const m = agentRateMetrics([{ verdictByContestant: { z: 'nao' }, limitCutByContestant: { z: 1 } }], ['z']);
    expect(m.resolveRateByContestant.z).toBe(0);
    expect(m.censoredResolveRateByContestant.z).toBeUndefined();
  });

  it('stageObservations: vetor por rep quando existe; chat (sem rep) cai no agregado; ausente = nenhuma', () => {
    const s = {
      verdictByContestant: { ag: 'parcial' as Verdict, chat: 'resolve' as Verdict },
      verdictsByRep: { ag: ['nao', 'resolve'] as Verdict[] },
    };
    expect(stageObservations(s, 'ag')).toEqual(['nao', 'resolve']);
    expect(stageObservations(s, 'chat')).toEqual(['resolve']);
    expect(stageObservations(s, 'sumido')).toEqual([]);
  });

  it('versão: gravada vence; run com agente sem o campo = legado v1; run de chat = undefined', () => {
    expect(AGENT_VERDICT_TREE_VERSION).toBe(2);
    expect(agentVerdictTreeVersionOf({ agentVerdictTreeVersion: 2, contestants: [{ runner: 'agent' }] })).toBe(2);
    expect(agentVerdictTreeVersionOf({ contestants: [{ runner: 'agent' }] })).toBe(1);
    expect(agentVerdictTreeVersionOf({ contestants: [{ runner: 'chat' }, {}] })).toBeUndefined();
  });

  it('whitelist normalizeRunRecord: campos novos do RunRecord sobrevivem à releitura', () => {
    const raw = {
      id: 'r',
      status: 'finished',
      mode: 'compare',
      config: { mode: 'compare', competitorModelIds: ['a'], judgeModelIds: ['j'] },
      contestants: [{ id: 'a', label: 'a', modelId: 'a', runner: 'agent' }],
      stages: [
        {
          index: 0,
          responses: [],
          startedAt: 'x',
          referenceJudge: {
            verdictByContestant: { a: 'nao' },
            explanationByContestant: {},
            judgeModelId: 'j',
            limitCutByContestant: { a: 1 },
          },
        },
      ],
      scoreboard: {},
      totalCostUsd: 0,
      startedAt: 'x',
      resolveRateByContestant: { a: 0 },
      censoredResolveRateByContestant: {},
      limitCutsByContestant: { a: 1 },
      agentVerdictTreeVersion: 2,
    };
    const rec = normalizeRunRecord(JSON.parse(JSON.stringify(raw)));
    expect(rec.agentVerdictTreeVersion).toBe(2);
    expect(rec.limitCutsByContestant).toEqual({ a: 1 });
    expect(rec.censoredResolveRateByContestant).toEqual({});
    expect(rec.stages[0].referenceJudge?.limitCutByContestant).toEqual({ a: 1 });
  });
});

// ===========================================================================
// 3. runAgentStage com executor injetado (workspace git e oráculo reais)
// ===========================================================================

let tmp: string;
let dirAnterior: string;
let silencio: Array<{ mockRestore(): void }> = [];

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'pb-impl032-'));
  dirAnterior = getDataDir();
  setDataDir(tmp);
  silencio = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
});

afterAll(() => {
  silencio.forEach((s) => s.mockRestore());
  setDataDir(dirAnterior);
  rmSync(tmp, { recursive: true, force: true });
});

/** Juiz falso: conta as chamadas e sempre responde 'resolve'. */
function fakeJuiz(): FakeOpenRouter {
  return fakeOpenRouter({
    catalog: ['fake/a', 'fake/b', 'fake/judge', 'fake/gen'].map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: () => ({ text: '{"verdict":"resolve","explanation":"confere"}' }),
  });
}

async function comGateway<T>(fn: (f: FakeOpenRouter) => Promise<T>): Promise<T> {
  const f = fakeJuiz();
  const anterior: OpenRouterGateway = setDefaultGateway(createGateway({ fetch: f.fetch, sleep: noSleep }));
  try {
    return await fn(f);
  } finally {
    setDefaultGateway(anterior);
  }
}

function gatewayFalso(passo: ReturnType<Roteiro>, prepareFalha = false): AgentGateway {
  return {
    id: 'pi-fake',
    prepare: async () => {
      if (prepareFalha) throw new Error('npm install do executor falhou');
      return { bin: 'pi-fake', env: {} };
    },
    run: async (opts) => {
      if (passo.throws) throw new Error(passo.throws);
      for (const f of passo.write ?? []) writeFileSync(path.join(opts.workspaceDir, f), 'ok\n', 'utf8');
      return fakeOutcome(passo.stopReason, opts.env.PI_MODEL_ID) as never;
    },
  };
}

let stageSeq = 0;
function params(task: AgentTaskSpec | undefined, gateway: AgentGateway, extra: Partial<RunAgentStageParams> = {}): RunAgentStageParams {
  return {
    runId: 'run-arvore',
    stageIndex: stageSeq++,
    contestant: { id: 'ag', label: 'ag', modelId: 'fake/a', runner: 'agent' },
    stage: { question: 'crie done.txt', productContext: 'repo vazio', maxTokens: 500, ...(task ? { agentTask: task } : {}) },
    agentConfig: { executor: 'pi', executorVersion: '0.0.0-fake', limits: { maxCostUsd: 0.05 } },
    apiKey: KEY,
    ctx: {},
    dataDir: tmp,
    catalog: [],
    judgeModelIds: ['fake/judge'],
    gateway,
    ...extra,
  };
}

const VERIFY = [{ cmd: 'test -f done.txt', label: 'done' }];

describe('IMPL-032 — runAgentStage: corte por limite vira nao sem juiz; incomplete só por controle', () => {
  for (const stopReason of LIMITES) {
    it(`${stopReason} sem oráculo → 'nao' (limit-cut), incomplete=false, 0 chamadas de juiz`, async () => {
      await comGateway(async (f) => {
        const res = await runAgentStage(params({}, gatewayFalso({ stopReason, write: ['meio.txt'] })));
        expect(res.incomplete).toBe(false);
        expect(res.repResults).toHaveLength(1);
        expect(res.repResults[0]).toMatchObject({ verdict: 'nao', path: 'limit-cut', judgeUsed: false, stopReason });
        expect(f.chatRequests()).toHaveLength(0);
      });
    });
  }

  it('A4: violação de forbiddenPaths seguida de teto (maxTurns) não some — conta nao', async () => {
    await comGateway(async () => {
      const task: AgentTaskSpec = { verify: VERIFY, forbiddenPaths: ['secret.txt'] };
      const res = await runAgentStage(params(task, gatewayFalso({ stopReason: 'maxTurns', write: ['done.txt', 'secret.txt'] })));
      expect(res.incomplete).toBe(false);
      expect(res.repResults[0]).toMatchObject({ verdict: 'nao', path: 'limit-cut' });
      expect(res.repResults[0].oracle?.violations).toEqual(['secret.txt']);
    });
  });

  it("oráculo parcial + timeout → 'nao' (não 'parcial'): o corte decide antes do crédito parcial", async () => {
    await comGateway(async () => {
      const task: AgentTaskSpec = { verify: [...VERIFY, { cmd: 'test -f extra.txt', label: 'extra' }] };
      const res = await runAgentStage(params(task, gatewayFalso({ stopReason: 'timeout', write: ['done.txt'] })));
      expect(res.repResults[0].oracle?.score).toBe(0.5);
      expect(res.repResults[0]).toMatchObject({ verdict: 'nao', path: 'limit-cut' });
    });
  });

  it('exceção: oráculo 100% + maxCost → oracle-pass (resolve candidato; sem juiz, o do oráculo fica)', async () => {
    await comGateway(async (f) => {
      const res = await runAgentStage(
        params({ verify: VERIFY }, gatewayFalso({ stopReason: 'maxCost', write: ['done.txt'] }), { judgeModelIds: [] }),
      );
      expect(res.repResults[0]).toMatchObject({ verdict: 'resolve', path: 'oracle-pass', judgeUsed: false });
      expect(f.chatRequests()).toHaveLength(0);
    });
  });

  it('A5: executor lança (infra) → nao pelo caminho error, no denominador (taxonomia = IMPL-094)', async () => {
    await comGateway(async () => {
      const res = await runAgentStage(params({}, gatewayFalso({ stopReason: 'completed', throws: 'ECONNRESET do provedor' })));
      expect(res.incomplete).toBe(false);
      expect(res.repResults[0]).toMatchObject({ verdict: 'nao', path: 'error', stopReason: 'error' });
      expect(res.response.status).toBe('error');
    });
  });

  it('falha de preparação do executor → nao em TODAS as reps (antes: incomplete e fora do denominador)', async () => {
    await comGateway(async () => {
      const res = await runAgentStage(
        params({}, gatewayFalso({ stopReason: 'completed' }, true), {
          agentConfig: { executor: 'pi', executorVersion: '0.0.0-fake', limits: { maxCostUsd: 0.05 }, repetitions: 3 },
        }),
      );
      expect(res.incomplete).toBe(false);
      expect(res.repResults.map((r) => [r.verdict, r.path])).toEqual([
        ['nao', 'error'],
        ['nao', 'error'],
        ['nao', 'error'],
      ]);
    });
  });

  it('etapa sem agentTask → nao (caminho error), nunca incomplete', async () => {
    await comGateway(async () => {
      const res = await runAgentStage(params(undefined, gatewayFalso({ stopReason: 'completed' })));
      expect(res.incomplete).toBe(false);
      expect(res.repResults[0]).toMatchObject({ verdict: 'nao', path: 'error' });
    });
  });

  it('cancelled → sobe como sinal de CONTROLE (a etapa inteira vira incomplete no orquestrador)', async () => {
    await comGateway(async () => {
      const err = await runAgentStage(params({}, gatewayFalso({ stopReason: 'cancelled' }))).catch((e: unknown) => e);
      expect(isControlSignal(err)).toBe(true);
    });
  });
});

// ===========================================================================
// 4. Ponta a ponta (Node) — os TRÊS consumidores + portas de controle
// ===========================================================================

function etapa(i: number): StageSpec {
  return {
    question: `tarefa ${i}: crie done.txt`,
    productContext: 'workspace vazio',
    maxTokens: 500,
    // Gabarito pronto: a etapa segue o caminho pointwise sem chamada de gabarito.
    reference: 'done.txt existe',
    origin: 'import',
    agentTask: { verify: VERIFY, limits: { maxCostUsd: 0.05 } },
  };
}

function configAgente(stages: number, extra: Partial<RunConfig> = {}): RunConfig {
  return {
    mode: 'compare',
    theme: 'agentes',
    stages,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceJudging: false,
    competitorModelIds: ['fake/a', 'fake/b'],
    duels: false,
    timeoutMs: 5_000,
    customStages: Array.from({ length: stages }, (_, i) => etapa(i)),
    agent: {
      executor: 'pi',
      executorVersion: '0.0.0-fake',
      install: 'system',
      limits: { maxCostUsd: 0.05, maxTurns: 5, timeoutMs: 10_000 },
      maxParallel: 2,
    },
    ...extra,
  } as RunConfig;
}

const ordem = (q: string): number => Number(/tarefa (\d+)/.exec(q)?.[1] ?? -1);

/** `agentSummary` da linha NDJSON `run.finished` de um record. */
function resumoNdjson(record: RunRecord): Record<string, unknown> | undefined {
  const linhas: Array<[string, Record<string, unknown>]> = [];
  const out = { isNdjson: true, event: (t: string, p: Record<string, unknown>) => linhas.push([t, p]) };
  emitRunEvent(out as unknown as Output, { type: 'run.finished', runId: record.id, record });
  return linhas.find(([t]) => t === 'run.finished')?.[1].agentSummary as Record<string, unknown> | undefined;
}

describe('IMPL-032 — versionamento: run legada (sem o campo) é v1 no resumo', () => {
  it('record de agente sem agentVerdictTreeVersion → verdictTreeVersion 1; cortes contados à parte', () => {
    const exec = (stopReason: string) => ({
      execId: 'e',
      repetition: 0,
      dir: 'x',
      turns: 3,
      toolCalls: 1,
      durationMs: 1,
      stopReason,
    });
    const legado = {
      id: 'legado',
      status: 'finished',
      mode: 'compare',
      config: { mode: 'compare' },
      contestants: [{ id: 'a', label: 'a', modelId: 'a', runner: 'agent' }],
      stages: [
        { index: 0, startedAt: 'x', responses: [{ contestantId: 'a', costUsd: 0, execution: exec('timeout') }] },
        { index: 1, startedAt: 'x', responses: [{ contestantId: 'a', costUsd: 0, execution: exec('cancelled') }] },
        { index: 2, startedAt: 'x', responses: [{ contestantId: 'a', costUsd: 0, execution: exec('error') }] },
      ],
    } as unknown as RunRecord;
    expect(resumoNdjson(legado)).toMatchObject({
      executions: 3,
      limitCut: 1,
      incomplete: 1,
      failed: 1,
      verdictTreeVersion: 1,
    });
  });
});

describe('IMPL-032 — pipeline Node: judge-score, resolveRate e significância contam o corte', () => {
  afterEach(() => {
    fake.calls = 0;
  });

  // fake/a: completa e passa o oráculo em TODA tarefa.
  // fake/b: cortado por cada um dos 4 limites nas tarefas 0..3 (sem tocar em
  //         nada) e completa as tarefas 4..5 — o agente que "entra em laço nas
  //         difíceis". Com a árvore v1 ele sairia com 100 (viés de sobrevivência).
  const roteiroReps1: Roteiro = ({ modelId, question }) => {
    const i = ordem(question);
    if (modelId === 'fake/b' && i < 4) return { stopReason: LIMITES[i] };
    return { stopReason: 'completed', write: ['done.txt'] };
  };

  it('record: nao explícito no mapa, nas três métricas e no ranking; nenhuma etapa incomplete', async () => {
    fake.roteiro = roteiroReps1;
    await comGateway(async () => {
      const rec: RunRecord = await runToCompletion(configAgente(6), KEY, {});
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.agentVerdictTreeVersion).toBe(AGENT_VERDICT_TREE_VERSION);
      expect(rec.stages.some((s) => s.incomplete)).toBe(false);

      const porOrdem = [...rec.stages].sort((a, b) => ordem(a.spec!.question) - ordem(b.spec!.question));
      for (const [i, s] of porOrdem.entries()) {
        const vb = s.referenceJudge!.verdictByContestant['fake/b'];
        // Chave PRESENTE com 'nao' — não ausente. Ausente seria "sem
        // observação" para os consumidores (excluída dos dois lados do par).
        expect(vb, `etapa ${i}`).toBe(i < 4 ? 'nao' : 'resolve');
        expect(s.referenceJudge!.verdictByContestant['fake/a']).toBe('resolve');
        // Cortado continua RANQUEADO (antes era filtrado do ranking da etapa).
        expect(s.judge!.rankedContestantIds).toContain('fake/b');
        if (i < 4) expect(s.referenceJudge!.limitCutByContestant).toEqual({ 'fake/b': 1 });
      }

      // (1) judge-score: 4 'nao' + 2 'resolve' → 33,3 (v1 daria 100).
      expect(rec.judgeScoreByContestant!['fake/a']).toBe(100);
      expect(rec.judgeScoreByContestant!['fake/b']).toBeCloseTo(judgeScoreFromVerdicts(['nao', 'nao', 'nao', 'nao', 'resolve', 'resolve']), 6);
      expect(rec.judgeScoreByContestant!['fake/b']).toBeCloseTo(33.333, 2);

      // (2) resolveRate principal conta o corte; a censurada é só diagnóstico.
      expect(rec.resolveRateByContestant).toEqual({ 'fake/a': 1, 'fake/b': 0.333 });
      expect(rec.censoredResolveRateByContestant).toEqual({ 'fake/a': 1, 'fake/b': 1 });
      expect(rec.limitCutsByContestant).toEqual({ 'fake/a': 0, 'fake/b': 4 });

      // (3) vetor de significância (o que o treino pareia): 'nao' = 0 nas
      // posições cortadas, NENHUM par excluído.
      const { controlScores, championScores } = pairedStageScores(rec, 'fake/a', 'fake/b');
      const bPorOrdem = rec.stages.map((s) => (ordem(s.spec!.question) < 4 ? 0 : 1));
      expect(championScores).toEqual(bPorOrdem);
      expect(controlScores).toEqual([1, 1, 1, 1, 1, 1]);
      const sig = pairedSignificance(controlScores, championScores);
      expect(sig?.n).toBe(6);
      expect(sig?.meanDiffPp).toBeCloseTo(-66.67, 1);

      // Resumo do stream (NDJSON run.finished): corte ≠ incompleta, com versão.
      expect(resumoNdjson(rec)).toMatchObject({
        executions: 12,
        failed: 0,
        limitCut: 4,
        incomplete: 0,
        verdictTreeVersion: AGENT_VERDICT_TREE_VERSION,
      });
    });
  });

  it('reps=2: corte na rep 0 entra no vetor POR REP como nao (observação, não perda)', async () => {
    fake.roteiro = ({ modelId, rep }) =>
      modelId === 'fake/b' && rep === 0
        ? { stopReason: 'timeout' }
        : { stopReason: 'completed', write: ['done.txt'] };
    await comGateway(async () => {
      const cfg = configAgente(3);
      cfg.agent = { ...cfg.agent!, repetitions: 2 };
      const rec = await runToCompletion(cfg, KEY, {});
      expect(rec.status, rec.error).toBe('finished');
      for (const s of rec.stages) {
        expect(s.referenceJudge!.verdictsByRep!['fake/b']).toEqual(['nao', 'resolve']);
        expect(s.referenceJudge!.verdictsByRep!['fake/a']).toEqual(['resolve', 'resolve']);
        expect(s.referenceJudge!.repIncomplete).toBeUndefined();
        expect(s.referenceJudge!.limitCutByContestant).toEqual({ 'fake/b': 1 });
      }
      // vetor plano 3 etapas × 2 reps: 3 'nao' + 3 'resolve'.
      expect(rec.judgeScoreByContestant!['fake/b']).toBe(50);
      expect(rec.resolveRateByContestant!['fake/b']).toBe(0.5);
      expect(rec.censoredResolveRateByContestant!['fake/b']).toBe(1);
      expect(rec.limitCutsByContestant!['fake/b']).toBe(3);
    });
  });

  it("'incomplete' aparece com CANCELAMENTO (stoppedReason cancelled)", async () => {
    const ac = new AbortController();
    fake.roteiro = ({ modelId, question }) => {
      if (modelId === 'fake/b' && ordem(question) === 0) {
        return { stopReason: 'cancelled', before: () => ac.abort('teste: Ctrl-C') };
      }
      return { stopReason: 'completed', write: ['done.txt'] };
    };
    await comGateway(async () => {
      const cfg = configAgente(2);
      cfg.agent = { ...cfg.agent!, maxParallel: 1 };
      const rec = await runToCompletion(cfg, KEY, { signal: ac.signal });
      expect(rec.status).toBe('aborted');
      expect(rec.stoppedReason).toBe('cancelled');
      expect(rec.stages.some((s) => s.incomplete)).toBe(true);
    });
  });

  it("'incomplete' aparece com ORÇAMENTO (stoppedReason budget) — e nenhuma execução acontece", async () => {
    fake.roteiro = () => ({ stopReason: 'completed', write: ['done.txt'] });
    await comGateway(async () => {
      const rec = await runToCompletion(configAgente(2, { budgetUsd: 0.001 }), KEY, {});
      expect(rec.stoppedReason).toBe('budget');
      expect(rec.stages.length).toBeGreaterThan(0);
      expect(rec.stages.every((s) => s.incomplete)).toBe(true);
      expect(fake.calls).toBe(0);
    });
  });

  it('corte por limite em TODA execução não produz incomplete (só controle produz)', async () => {
    fake.roteiro = ({ question }) => ({ stopReason: LIMITES[ordem(question) % 4] });
    await comGateway(async () => {
      const rec = await runToCompletion(configAgente(4), KEY, {});
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.stoppedReason).toBeUndefined();
      expect(rec.stages.some((s) => s.incomplete)).toBe(false);
      expect(rec.judgeScoreByContestant).toEqual({ 'fake/a': 0, 'fake/b': 0 });
      expect(rec.resolveRateByContestant).toEqual({ 'fake/a': 0, 'fake/b': 0 });
      // Todas cortadas: a censurada não tem denominador (chave ausente).
      expect(rec.censoredResolveRateByContestant).toEqual({});
      expect(rec.limitCutsByContestant).toEqual({ 'fake/a': 4, 'fake/b': 4 });
    });
  });
});
