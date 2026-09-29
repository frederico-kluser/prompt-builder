// IMPL-094 (R-14a REC-2 / DEC-2) — taxonomia TRANSIENT × DEFECT com retentativa
// CEGA 2× e `infraErrorRate` (fim do A5: infra virando nota).
//
// O defeito: o catch de repetição do `runAgentStage` convertia QUALQUER erro
// (429/5xx/rede/sandbox morto, clone/setup que falha) em 'nao' do contestant,
// sem retentativa; setup/clone quebrado virava nota de UM contestant em vez de
// invalidar a célula de todos; e o record não tinha taxa de infra nem limiar
// de run inválida. O contrato agora, por classe:
//
//   1. transient (429 / 5xx / rede / sandbox morto) ⇒ 2 retentativas CEGAS; se
//      persistir, a rep sai SEM veredito (infra_error, fora dos denominadores);
//      a retentativa recupera quando a falha passa (o veredito é o da tentativa
//      que produziu observação) — e as tentativas são contadas;
//   2. defect (setup/clone/fixture, executor que não prepara) ⇒ SEM retentativa;
//      a etapa fica inválida (`stage.error`) para TODOS os contestants;
//   3. infra não-transitória (401/402/403, erro do harness) ⇒ sem veredito e sem
//      retentativa (repetir erro determinístico só gasta);
//   4. NENHUM retry "até passar": tentativa com veredito (inclusive 'nao' e
//      corte por limite) nunca é refeita;
//   5. run com infra_error > 10% sai `inconclusive` com o motivo "INVÁLIDA" e o
//      `agents run` sai exit 6 `run.infra_invalid` (documentado); > 5% = alerta.
//
// Sem rede real, sem LLM pago, sem Docker: executor/juiz falsos, git/sh locais.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Executor FALSO no lugar do `pi` para as camadas de pipeline/CLI (o
// orquestrador não aceita gateway injetado). O roteiro diz, por chamada, como
// a execução termina.
// ---------------------------------------------------------------------------
type Passo = {
  stopReason?: string;
  infraError?: string;
  exitCode?: number | null;
  /** Lança esta exceção em vez de devolver outcome. */
  throws?: unknown;
  write?: string[];
};
type Roteiro = (c: { modelId: string; question: string; n: number }) => Passo;

const fake = vi.hoisted(() => ({
  roteiro: (() => ({ stopReason: 'completed' })) as unknown as Roteiro,
  chamadas: new Map<string, number>(),
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
      run: async (opts: { workspaceDir: string; env: Record<string, string>; modelId?: string; instruction?: string }) => {
        const modelId = opts.modelId ?? opts.env.PI_MODEL_ID;
        const question = opts.instruction ?? opts.env.PI_TASK;
        const chave = `${modelId}|${question}`;
        const n = (fake.chamadas.get(chave) ?? 0) + 1;
        fake.chamadas.set(chave, n);
        const passo = fake.roteiro({ modelId, question, n });
        if (passo.throws !== undefined) throw passo.throws;
        for (const f of passo.write ?? []) write(join(opts.workspaceDir, f), 'ok\n', 'utf8');
        return fakeOutcome(passo, modelId);
      },
    },
  };
});

function fakeOutcome(passo: Passo, modelId: string) {
  const now = new Date().toISOString();
  const stopReason = passo.stopReason ?? (passo.infraError ? 'error' : 'completed');
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
    ...(passo.infraError ? { infraError: passo.infraError } : {}),
    parseErrors: 0,
    responseIds: [],
    stderrTail: passo.infraError ? `erro do provedor: ${passo.infraError}` : '',
    exitCode: passo.exitCode === undefined ? 0 : passo.exitCode,
    signal: null,
  };
}

import {
  assessInfraErrorRate,
  classifyAgentFailure,
  INFRA_INVALID_RATE,
  INFRA_RETRIES,
  INFRA_WARN_RATE,
  infraSummaryFields,
  mergeInfraCounts,
  shouldRetryAttempt,
  stageInfraDefect,
  tallyInfra,
} from '../src/agent/infraError.js';
import { runAgentStage, type AgentGateway, type RunAgentStageParams, type StageRunners } from '../src/agent/runAgentStage.js';
import { hostCommandRunner } from '../src/agent/sandboxExec.js';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion } from '../src/orchestrator.js';
import { cmdAgents } from '../src/cli/commands/agents.js';
import { agentSummary as mcpAgentSummary } from '../src/jobManager.js';
import { EXIT, isCliError, resetOutputState, type CliError } from '../src/cli/output.js';
import type { RunConfig, RunRecord, StageSpec } from '../src/types.js';
import type { AgentTaskSpec } from '../src/agent/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const VERIFY = [{ cmd: 'test -f done.txt', label: 'done' }];

const httpErr = (status: number, msg = `HTTP ${status}`): Error => Object.assign(new Error(msg), { httpStatus: status });
const codeErr = (code: string): Error => Object.assign(new Error(`${code} (socket)`), { code });

// ===========================================================================
// 1. Classificação (pura) — por TIPO, nunca por resultado
// ===========================================================================

describe('classifyAgentFailure (pura) — uma classe por tipo de falha', () => {
  it('transient: 429, 5xx, rede e sandbox morto (executor que lançou)', () => {
    const casos: unknown[] = [
      httpErr(429, 'Too Many Requests'),
      httpErr(500),
      httpErr(503, 'Service Unavailable'),
      new Error('upstream respondeu 502 Bad Gateway'),
      codeErr('ECONNRESET'),
      codeErr('ETIMEDOUT'),
      new Error('fetch failed', { cause: codeErr('EAI_AGAIN') }),
      new Error('Error response from daemon: container 3f2a is not running'),
      new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock'),
    ];
    for (const error of casos) {
      expect(classifyAgentFailure({ phase: 'execute', error })?.class, String(error)).toBe('transient');
    }
  });

  it('defect: falha na preparação do workspace (setup/clone/fixture) e comando ausente', () => {
    expect(classifyAgentFailure({ phase: 'prepare', error: new Error('setup falhou no comando npm ci: exit 1') })?.class).toBe(
      'defect',
    );
    expect(classifyAgentFailure({ phase: 'prepare', error: new Error('git clone do seed falhou (x): timeout') })?.class).toBe(
      'defect',
    );
    expect(classifyAgentFailure({ phase: 'execute', error: codeErr('ENOENT') })?.class).toBe('defect');
    expect(classifyAgentFailure({ phase: 'execute', error: new Error('spawn docker ENOENT') })?.class).toBe('defect');
  });

  it('infra (sem retentativa): erro do harness e erro do provedor que repetir não conserta', () => {
    expect(classifyAgentFailure({ phase: 'harness', error: new Error('ENOSPC no writeExecution') })?.class).toBe('infra');
    expect(classifyAgentFailure({ phase: 'execute', error: new Error('bug qualquer do adaptador') })?.class).toBe('infra');
    expect(classifyAgentFailure({ phase: 'execute', outcome: { stopReason: 'error', infraError: '401 Unauthorized' } })?.class).toBe(
      'infra',
    );
    expect(
      classifyAgentFailure({ phase: 'execute', outcome: { stopReason: 'error', infraError: '402 insufficient credit' } })?.class,
    ).toBe('infra');
  });

  it('outcome: infraError do provedor = transient; container exit 125 = sandbox morto; o resto é do agente', () => {
    expect(classifyAgentFailure({ phase: 'execute', outcome: { stopReason: 'error', infraError: 'Connection error.' } })).toEqual({
      class: 'transient',
      reason: 'Connection error.',
    });
    expect(
      classifyAgentFailure({ phase: 'execute', container: true, outcome: { stopReason: 'error', exitCode: 125 } })?.class,
    ).toBe('transient');
    // Fora do container, exit 125 é só um processo que morreu (§18.3 → nao).
    expect(classifyAgentFailure({ phase: 'execute', outcome: { stopReason: 'error', exitCode: 125 } })).toBeNull();
    expect(classifyAgentFailure({ phase: 'execute', outcome: { stopReason: 'error', exitCode: 1 } })).toBeNull();
    expect(classifyAgentFailure({ phase: 'execute', outcome: { stopReason: 'completed', exitCode: 0 } })).toBeNull();
  });

  it('retentativa: só transient, só até 2 — nunca por resultado', () => {
    expect(INFRA_RETRIES).toBe(2);
    expect(shouldRetryAttempt('transient', 1)).toBe(true);
    expect(shouldRetryAttempt('transient', 2)).toBe(true);
    expect(shouldRetryAttempt('transient', 3)).toBe(false);
    for (const c of ['defect', 'infra', undefined] as const) expect(shouldRetryAttempt(c, 1)).toBe(false);
  });

  it('taxa: > 5% alerta, > 10% inválida; tentativas contadas; etapa inválida fora do denominador', () => {
    expect([INFRA_WARN_RATE, INFRA_INVALID_RATE]).toEqual([0.05, 0.1]);
    const reps = (n: number, infra: number) =>
      Array.from({ length: n }, (_, i) => ({
        path: i < infra ? 'error' : 'oracle-pass',
        verdict: i < infra ? null : 'resolve',
        attempts: i < infra ? 3 : 1,
        ...(i < infra ? { infraClass: 'transient' as const } : {}),
      }));
    const um = tallyInfra(reps(20, 1));
    expect(um).toEqual({ executions: 20, infraErrors: 1, attempts: 22, retries: 2, defectStages: 0 });
    expect(assessInfraErrorRate(um)).toMatchObject({ rate: 0.05, warn: false, invalid: false });
    expect(assessInfraErrorRate(tallyInfra(reps(20, 2)))).toMatchObject({ rate: 0.1, warn: true, invalid: false });
    const tres = assessInfraErrorRate(tallyInfra(reps(20, 3)));
    expect(tres).toMatchObject({ rate: 0.15, warn: true, invalid: true });
    expect(tres?.message).toMatch(/INVÁLIDA/);
    // Etapa inválida: tentativas contam (houve gasto), execuções não.
    const invalida = tallyInfra(reps(4, 4), { stageInvalid: true, defect: true });
    expect(invalida).toEqual({ executions: 0, infraErrors: 0, attempts: 12, retries: 8, defectStages: 1 });
    expect(mergeInfraCounts(um, invalida)).toEqual({ executions: 20, infraErrors: 1, attempts: 34, retries: 10, defectStages: 1 });
    expect(assessInfraErrorRate(undefined)).toBeUndefined();
    expect(stageInfraDefect([{ path: 'error', verdict: null, infraClass: 'defect', infraError: 'setup falhou' }])).toEqual({
      message: 'setup falhou',
    });
  });

  it('os resumos (MCP/NDJSON/result) trazem as tentativas da MESMA fonte', () => {
    const rec = {
      agentInfra: { executions: 6, infraErrors: 3, attempts: 12, retries: 6, defectStages: 1 },
      infraErrorRate: 0.5,
      contestants: [{ runner: 'agent' as const }],
      stages: [{ responses: [{ costUsd: 0.01, execution: { turns: 1, stopReason: 'completed' } }] }],
    };
    const esperado = { attempts: 12, retries: 6, infraErrors: 3, infraErrorRate: 0.5, defectStages: 1 };
    expect(infraSummaryFields(rec)).toEqual(esperado);
    expect(mcpAgentSummary(rec)).toMatchObject(esperado);
    expect(infraSummaryFields({})).toEqual({}); // record legado: nada inventado
  });
});

// ===========================================================================
// 2. runAgentStage com executor injetado — uma classe por caso
// ===========================================================================

let tmp = '';
let dirAnterior = '';
let gwAnterior: OpenRouterGateway;
let silencio: Array<{ mockRestore(): void }> = [];

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'pb-impl094-'));
  dirAnterior = getDataDir();
  setDataDir(tmp);
  const f = fakeOpenRouter({
    catalog: ['fake/a', 'fake/b', 'fake/judge', 'fake/gen'].map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: () => ({ text: '{"verdict":"resolve","explanation":"confere"}' }),
  });
  gwAnterior = setDefaultGateway(createGateway({ fetch: f.fetch, sleep: noSleep }));
  silencio = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
});

afterAll(() => {
  silencio.forEach((s) => s.mockRestore());
  setDefaultGateway(gwAnterior);
  setDataDir(dirAnterior);
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  fake.roteiro = () => ({ stopReason: 'completed' });
  fake.chamadas.clear();
});

/** Executor injetado: `passos[n]` (ou o último) diz como a n-ésima CHAMADA termina. */
function gatewayFalso(...passos: Passo[]): AgentGateway & { calls: () => number } {
  let n = 0;
  return {
    id: 'pi-fake',
    calls: () => n,
    prepare: async () => ({ bin: 'pi-fake', env: {} }),
    run: async (opts) => {
      const passo = passos[Math.min(n++, passos.length - 1)];
      if (passo.throws !== undefined) throw passo.throws;
      for (const f of passo.write ?? []) writeFileSync(path.join(opts.workspaceDir, f), 'ok\n', 'utf8');
      return fakeOutcome(passo, opts.modelId ?? 'fake/a') as never;
    },
  };
}

let stageSeq = 0;
function params(task: AgentTaskSpec, gateway: AgentGateway, extra: Partial<RunAgentStageParams> = {}): RunAgentStageParams {
  return {
    runId: 'run-impl094',
    stageIndex: stageSeq++,
    contestant: { id: 'ag', label: 'ag', modelId: 'fake/a', runner: 'agent' },
    stage: { question: 'crie done.txt', productContext: 'repo vazio', maxTokens: 500, agentTask: task },
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

const OK: Passo = { stopReason: 'completed', write: ['done.txt'] };

describe('runAgentStage — transient ⇒ 2 retentativas CEGAS, depois infra_error', () => {
  const persistentes: Array<[string, Passo]> = [
    ['429 (executor lançou)', { throws: httpErr(429, 'Too Many Requests') }],
    ['5xx (provedor no outcome)', { infraError: '503 Service Unavailable' }],
    ['rede (ECONNRESET)', { throws: codeErr('ECONNRESET') }],
  ];
  for (const [nome, passo] of persistentes) {
    it(`${nome}: 3 tentativas e SEM veredito (nunca nao), fora do placar`, async () => {
      const gw = gatewayFalso(passo);
      const res = await runAgentStage(params({ verify: VERIFY }, gw));
      expect(gw.calls()).toBe(1 + INFRA_RETRIES);
      const rep = res.repResults[0];
      expect(rep).toMatchObject({ verdict: null, infraClass: 'transient', attempts: 3 });
      expect(rep.discardedAttempts?.map((d) => d.attempt)).toEqual([1, 2]);
      expect(rep.explanation).toMatch(/após 3 tentativas/);
      expect(res.response.status).toBe('error');
      expect(res.incomplete).toBe(false);
    });
  }

  it('sandbox morto (container, docker run exit 125): também é refeito às cegas', async () => {
    const runners: StageRunners = {
      mode: 'container',
      isolated: true,
      setup: () => hostCommandRunner(),
      verify: () => hostCommandRunner(),
    };
    const gw = gatewayFalso({ stopReason: 'error', exitCode: 125 });
    const res = await runAgentStage(params({ verify: VERIFY }, gw, { runners }));
    expect(gw.calls()).toBe(3);
    expect(res.repResults[0]).toMatchObject({ verdict: null, infraClass: 'transient', attempts: 3 });
    expect(res.repResults[0].infraError).toMatch(/sandbox morto/);
  });

  it('a falha passa: o veredito é o da tentativa que OBSERVOU; descartada arquivada e paga', async () => {
    const gw = gatewayFalso({ throws: httpErr(502) }, OK);
    const res = await runAgentStage(params({ verify: VERIFY }, gw));
    const rep = res.repResults[0];
    expect(gw.calls()).toBe(2);
    expect(rep).toMatchObject({ verdict: 'resolve', attempts: 2 });
    expect(rep.infraClass).toBeUndefined();
    const [d] = rep.discardedAttempts ?? [];
    expect(d).toMatchObject({ attempt: 1 });
    expect(d.reason).toContain('502');
    // Auditoria: a tentativa descartada fica arquivada ao lado da rep canônica.
    expect(d.dir && existsSync(path.join(tmp, d.dir, 'verdict.json'))).toBe(true);
    const canonico = JSON.parse(readFileSync(path.join(tmp, path.dirname(d.dir!), '0', 'verdict.json'), 'utf8')) as {
      attempts: number;
      verdict: string;
    };
    expect(canonico).toMatchObject({ attempts: 2, verdict: 'resolve' });
  });

  it('o custo das tentativas descartadas (outcome medido) soma na rep e na resposta', async () => {
    const gw = gatewayFalso({ infraError: '500 Internal Server Error' }, OK);
    const res = await runAgentStage(params({ verify: VERIFY }, gw));
    expect(res.repResults[0].attempts).toBe(2);
    expect(res.repResults[0].costUsd).toBeCloseTo(0.002, 9);
    expect(res.response.costUsd).toBeCloseTo(0.002, 9);
  });
});

describe('runAgentStage — nenhum retry "até passar"', () => {
  it("agente que falha o oráculo ('nao'), corte por limite e processo que morre: 1 tentativa", async () => {
    for (const passo of [
      { stopReason: 'completed' },
      { stopReason: 'timeout' },
      { stopReason: 'maxTurns' },
      { stopReason: 'error', exitCode: 1 },
    ] satisfies Passo[]) {
      const gw = gatewayFalso(passo);
      const res = await runAgentStage(params({ verify: VERIFY }, gw));
      expect(gw.calls(), JSON.stringify(passo)).toBe(1);
      expect(res.repResults[0]).toMatchObject({ verdict: 'nao', attempts: 1 });
    }
  });

  it('infra com oráculo CONCLUSIVO (o agente fez o trabalho): observação — não é refeita', async () => {
    const gw = gatewayFalso({ infraError: 'Connection error.', write: ['done.txt'] });
    const res = await runAgentStage(params({ verify: VERIFY }, gw));
    expect(gw.calls()).toBe(1);
    expect(res.repResults[0]).toMatchObject({ verdict: 'resolve', attempts: 1 });
  });

  it('infra NÃO transitória (401 do provedor): sem veredito e sem retentativa', async () => {
    const gw = gatewayFalso({ infraError: '401 Unauthorized' });
    const res = await runAgentStage(params({ verify: VERIFY }, gw));
    expect(gw.calls()).toBe(1);
    expect(res.repResults[0]).toMatchObject({ verdict: null, infraClass: 'infra', attempts: 1 });
  });
});

describe('runAgentStage — defect (setup/clone) ⇒ sem retentativa, célula inválida', () => {
  it('setup[] que falha: defeito, 1 tentativa, e as reps seguintes nem rodam', async () => {
    const gw = gatewayFalso(OK);
    const res = await runAgentStage(
      params({ setup: [{ cmd: 'false' }], verify: VERIFY }, gw, {
        agentConfig: { executor: 'pi', executorVersion: '0.0.0-fake', limits: { maxCostUsd: 0.05 }, repetitions: 3 },
      }),
    );
    expect(gw.calls()).toBe(0); // o agente nunca acordou
    expect(res.repResults).toHaveLength(1);
    expect(res.repResults[0]).toMatchObject({ verdict: null, infraClass: 'defect', attempts: 1 });
    expect(stageInfraDefect(res.repResults)?.message).toMatch(/setup falhou/);
  });

  it('clone do repo-semente que falha: defeito', async () => {
    const gw = gatewayFalso(OK);
    const res = await runAgentStage(
      params({ repo: { kind: 'git', path: path.join(tmp, 'nao-existe'), ref: 'main' }, verify: VERIFY }, gw),
    );
    expect(gw.calls()).toBe(0);
    expect(res.repResults[0]).toMatchObject({ verdict: null, infraClass: 'defect' });
  });
});

// ===========================================================================
// 3. Pipeline Node — célula inválida para TODOS e run INVÁLIDA > 10%
// ===========================================================================

function etapa(i: number, over: Partial<AgentTaskSpec> = {}): StageSpec {
  return {
    question: `tarefa ${i}: crie done.txt`,
    productContext: 'workspace vazio',
    maxTokens: 500,
    reference: 'done.txt existe',
    origin: 'import',
    agentTask: { verify: VERIFY, limits: { maxCostUsd: 0.05 }, ...over },
  };
}

function configAgente(stages: StageSpec[]): RunConfig {
  return {
    mode: 'compare',
    theme: 'agentes',
    stages: stages.length,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceJudging: false,
    competitorModelIds: ['fake/a', 'fake/b'],
    duels: false,
    timeoutMs: 5_000,
    customStages: stages,
    agent: {
      executor: 'pi',
      executorVersion: '0.0.0-fake',
      install: 'system',
      limits: { maxCostUsd: 0.05, maxTurns: 5, timeoutMs: 10_000 },
      maxParallel: 2,
    },
  } as RunConfig;
}

describe('pipeline Node — defeito invalida a etapa para TODOS; infra > 10% = run INVÁLIDA', { timeout: 60_000 }, () => {
  it('setup[] quebrado na etapa 0: stage.error para os DOIS contestants, sem nota de ninguém', async () => {
    fake.roteiro = () => OK;
    const rec: RunRecord = await runToCompletion(
      configAgente([etapa(0, { setup: [{ cmd: 'false' }] }), etapa(1), etapa(2)]),
      KEY,
      {},
    );
    const s0 = rec.stages[0];
    expect(s0.error).toMatch(/inválida para TODOS/);
    expect(s0.error).toMatch(/setup falhou/);
    expect(s0.referenceJudge).toBeUndefined();
    // As outras etapas seguem normais.
    for (const s of rec.stages.slice(1)) {
      expect(s.referenceJudge?.verdictByContestant).toEqual({ 'fake/a': 'resolve', 'fake/b': 'resolve' });
    }
    expect(rec.agentInfra).toMatchObject({ defectStages: 1, infraErrors: 0, executions: 4 });
    expect(rec.infraErrorRate).toBe(0);
  });

  it("fake/b com 503 PERSISTENTE: retentativas contadas, infra_error 50% > 10% ⇒ status inconclusive 'INVÁLIDA'", async () => {
    fake.roteiro = ({ modelId }) => (modelId === 'fake/b' ? { infraError: '503 Service Unavailable' } : OK);
    const rec: RunRecord = await runToCompletion(configAgente([etapa(0), etapa(1), etapa(2)]), KEY, {});
    expect(rec.agentInfra).toMatchObject({ executions: 6, infraErrors: 3, retries: 6, attempts: 12 });
    expect(rec.infraErrorRate).toBe(0.5);
    expect(rec.status).toBe('inconclusive');
    expect(rec.verdictIntegrity?.reasons.some((r) => /INVÁLIDA/.test(r))).toBe(true);
    for (const s of rec.stages) {
      expect('fake/b' in (s.referenceJudge?.verdictByContestant ?? {})).toBe(false); // nunca 'nao'
    }
  });

  it('a falha transitória que PASSA não deixa rastro na nota: retentativa recupera e a run fica íntegra', async () => {
    // 1ª chamada de cada (modelo, etapa) cai com 429; a 2ª funciona.
    fake.roteiro = ({ n }) => (n === 1 ? { throws: httpErr(429) } : OK);
    const rec: RunRecord = await runToCompletion(configAgente([etapa(0), etapa(1), etapa(2)]), KEY, {});
    expect(rec.agentInfra).toMatchObject({ executions: 6, infraErrors: 0, retries: 6 });
    expect(rec.infraErrorRate).toBe(0);
    expect(rec.verdictIntegrity?.reasons.some((r) => /INVÁLIDA/.test(r))).toBe(false);
    for (const s of rec.stages) {
      expect(s.referenceJudge?.verdictByContestant).toEqual({ 'fake/a': 'resolve', 'fake/b': 'resolve' });
    }
  });
});

// ===========================================================================
// 4. CLI — `agents run` sai 6 `run.infra_invalid` (documentado)
// ===========================================================================

describe('CLI — run inválida por infra sai exit 6 run.infra_invalid', { timeout: 60_000 }, () => {
  it('agents run com infra_error > 10%: envelope de erro com o código próprio e o resumo', async () => {
    fake.roteiro = ({ modelId }) => (modelId === 'fake/b' ? { infraError: 'Connection error.' } : OK);
    const dir = mkdtempSync(path.join(tmp, 'cli-'));
    const file = path.join(dir, 'arena.json');
    writeFileSync(
      file,
      JSON.stringify({
        format: 'arena-agent-config@2',
        mode: 'compare',
        theme: 'infra',
        agent: { executor: 'pi', executorVersion: '0.0.0-fake', install: 'system', limits: { maxCostUsd: 0.05 } },
        models: { datagen: 'fake/gen', judges: ['fake/judge'], competitors: ['fake/a', 'fake/b'] },
        scenarios: [0, 1, 2].map((i) => ({ question: `tarefa ${i}: crie done.txt`, agentTask: { verify: VERIFY } })),
        duels: false,
      }),
    );
    resetOutputState();
    let err: CliError | undefined;
    try {
      await cmdAgents([
        'run', '--config', file, '--budget', '5', '--key', KEY, '--allow-exec-config',
        '--json', '--quiet', '--data-dir', dir,
      ]);
    } catch (e) {
      if (!isCliError(e)) throw e;
      err = e as CliError;
    } finally {
      setDataDir(tmp);
    }
    expect(err?.code).toBe(EXIT.INCONCLUSIVE);
    expect(err?.errorCode).toBe('run.infra_invalid');
    expect(err?.message).toMatch(/INVÁLIDA/);
    const resumo = err?.details as { agentSummary: { retries: number; infraErrors: number; infraErrorRate: number } };
    expect(resumo.agentSummary).toMatchObject({ retries: 6, infraErrors: 3, infraErrorRate: 0.5 });
  });
});
