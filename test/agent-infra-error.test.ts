// IMPL-036 (correção da revisão) — teste de CONTRATO do VEREDITO de uma execução
// de agente que terminou por erro de INFRAESTRUTURA (provedor/rede).
//
// O defeito: o executor passou a rebaixar "pi saiu 0 com a última chamada ao
// modelo em erro" para `stopReason: 'error'` — documentado como "fora do placar,
// nunca nao" —, mas a árvore de veredito lê `error` como "processo morreu"
// (§18.3) e dava `nao`. Com `--network none` como default e sem proxy de
// inferência, TODA execução em container virava `nao`: um placar inteiro
// inventado numa run "concluída". E uma execução cujo oráculo passou 100% (o
// agente fez o trabalho; só a última chamada caiu) perdia o `resolve`.
//
// O contrato agora: `outcome.infraError` → repetição SEM veredito (chave ausente
// em `verdictByContestant`, fora do ranking e das médias), salvo oráculo
// CONCLUSIVO (100% ou violação de forbiddenPaths), que decide como numa
// execução concluída. Processo que morre SEM erro do provedor continua `nao`.
//
// Camadas (todas sem rede e sem gasto):
//   1. `decideInfraError` (pura);
//   2. `runAgentStage` com executor injetado (workspace git e oráculo REAIS);
//   3. `runToCompletion` (Node) com o `pi` trocado por um executor falso — o
//      VEREDITO no record (placar/ranking), não só o `stopReason` do executor.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Executor FALSO no lugar do `pi` para a camada 3 (o orquestrador não aceita
// gateway injetado). O roteiro diz, por modelo, como a execução termina.
// ---------------------------------------------------------------------------
type Passo = {
  stopReason: string;
  /** Marcador de erro de infra do executor (mensagem do provedor). */
  infraError?: string;
  /** Arquivos escritos no workspace antes de "terminar". */
  write?: string[];
};
type Roteiro = (c: { modelId: string; question: string }) => Passo;

const fake = vi.hoisted(() => ({
  roteiro: (() => ({ stopReason: 'completed' })) as unknown as Roteiro,
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
        // Contrato v2 (IMPL-095): modelo/tarefa vêm do `AgentRunOpts`; o env
        // `PI_*` é só tolerância legada (mesma precedência do `pi.ts` real).
        const modelId = opts.modelId ?? opts.env.PI_MODEL_ID;
        const question = opts.instruction ?? opts.env.PI_TASK;
        const passo = fake.roteiro({ modelId, question });
        for (const f of passo.write ?? []) write(join(opts.workspaceDir, f), 'ok\n', 'utf8');
        return fakeOutcome(passo, modelId);
      },
    },
  };
});

function fakeOutcome(passo: Passo, modelId: string) {
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
    stopReason: passo.stopReason,
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
      stopReason: passo.stopReason,
      turns: [{ index: 0, text: 'terminei', steps: [] }],
      usage,
      parseErrors: 0,
      compactions: [],
    },
    ...(passo.infraError ? { infraError: passo.infraError } : {}),
    parseErrors: 0,
    responseIds: [],
    stderrTail: passo.infraError ? `erro do provedor na última chamada do agente: ${passo.infraError}` : '',
    exitCode: 0,
    signal: null,
  };
}

import { decideInfraError, isOracleConclusive } from '../src/agent/infraError.js';
import { agentStageProvenance } from '../src/agent/verdictTree.js';
import { runAgentStage, type AgentGateway, type RunAgentStageParams } from '../src/agent/runAgentStage.js';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion } from '../src/orchestrator.js';
import type { RunConfig, RunRecord, StageSpec } from '../src/types.js';
import type { AgentTaskSpec } from '../src/agent/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const CONN = 'Connection error.';

// ===========================================================================
// 1. decideInfraError — pura
// ===========================================================================

describe('decideInfraError (pura)', () => {
  it('sem marcador de infra: a árvore decide com o stopReason real', () => {
    expect(decideInfraError(undefined)).toEqual({ kind: 'none' });
    expect(decideInfraError(undefined, { score: 0, violations: [] })).toEqual({ kind: 'none' });
    expect(decideInfraError('', { score: 1, violations: [] })).toEqual({ kind: 'none' });
  });

  it('infra sem oráculo, ou com oráculo zerado/parcial: SEM veredito (nunca nao)', () => {
    for (const oracle of [undefined, { score: 0, violations: [] }, { score: 0.5, violations: [] }]) {
      const d = decideInfraError(CONN, oracle);
      expect(d.kind).toBe('no-verdict');
      if (d.kind === 'no-verdict') {
        expect(d.explanation).toContain(CONN);
        expect(d.explanation).toMatch(/fora do placar/);
      }
    }
  });

  it('infra com oráculo CONCLUSIVO (100% ou violação): o oráculo decide', () => {
    expect(decideInfraError(CONN, { score: 1, violations: [] }).kind).toBe('oracle-decides');
    expect(decideInfraError(CONN, { score: 0.5, violations: ['secret.txt'] }).kind).toBe('oracle-decides');
    expect(isOracleConclusive({ score: 0, violations: ['x'] })).toBe(true);
    expect(isOracleConclusive({ score: 0.99, violations: [] })).toBe(false);
    expect(isOracleConclusive(undefined)).toBe(false);
  });
});

// ===========================================================================
// 2. runAgentStage com executor injetado (workspace git e oráculo reais)
// ===========================================================================

let tmp: string;
let dirAnterior: string;
let silencio: Array<{ mockRestore(): void }> = [];

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'pb-impl036-infra-'));
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

/** Juiz falso: sempre 'resolve'; conta as chamadas. */
async function comJuiz<T>(fn: (f: FakeOpenRouter) => Promise<T>): Promise<T> {
  const f = fakeOpenRouter({
    catalog: ['fake/a', 'fake/b', 'fake/judge', 'fake/gen'].map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: () => ({ text: '{"verdict":"resolve","explanation":"confere"}' }),
  });
  const anterior: OpenRouterGateway = setDefaultGateway(createGateway({ fetch: f.fetch, sleep: noSleep }));
  try {
    return await fn(f);
  } finally {
    setDefaultGateway(anterior);
  }
}

/** Executor injetado: `passos[rep]` (ou o último) diz como cada repetição termina. */
function gatewayFalso(...passos: Passo[]): AgentGateway {
  let n = 0;
  return {
    id: 'pi-fake',
    prepare: async () => ({ bin: 'pi-fake', env: {} }),
    run: async (opts) => {
      const passo = passos[Math.min(n++, passos.length - 1)];
      for (const f of passo.write ?? []) writeFileSync(path.join(opts.workspaceDir, f), 'ok\n', 'utf8');
      // Contrato v2 (IMPL-095): o modelo vem do `AgentRunOpts` (env `PI_*` é legado).
      return fakeOutcome(passo, opts.modelId ?? opts.env.PI_MODEL_ID) as never;
    },
  };
}

let stageSeq = 0;
function params(task: AgentTaskSpec, gateway: AgentGateway, reps = 1): RunAgentStageParams {
  return {
    runId: 'run-infra',
    stageIndex: stageSeq++,
    contestant: { id: 'ag', label: 'ag', modelId: 'fake/a', runner: 'agent' },
    stage: { question: 'crie done.txt', productContext: 'repo vazio', maxTokens: 500, agentTask: task },
    agentConfig: { executor: 'pi', executorVersion: '0.0.0-fake', limits: { maxCostUsd: 0.05 }, repetitions: reps },
    apiKey: KEY,
    ctx: {},
    dataDir: tmp,
    catalog: [],
    judgeModelIds: ['fake/judge'],
    gateway,
  };
}

const VERIFY = [{ cmd: 'test -f done.txt', label: 'done' }];
const infra = (over: Partial<Passo> = {}): Passo => ({ stopReason: 'error', infraError: CONN, ...over });

describe('runAgentStage — erro de infra fica FORA do placar (nunca nao)', () => {
  it('sem oráculo, workspace intocado: veredito null, incomplete, 0 juiz, status error com a causa', async () => {
    await comJuiz(async (f) => {
      const res = await runAgentStage(params({}, gatewayFalso(infra())));
      expect(res.repResults).toHaveLength(1);
      expect(res.repResults[0].verdict).toBeNull();
      expect(res.repResults[0].stopReason).toBe('error');
      expect(res.repResults[0].explanation).toContain(CONN);
      expect(res.repResults[0].execution.infraError).toBe(CONN);
      // IMPL-032: `incomplete` é só controle (cancelamento); a rep sem veredito
      // por infra fica fora do placar pela AUSÊNCIA de veredito, com o motivo.
      expect(res.incomplete).toBe(false);
      expect(res.repResults[0].infraError).toContain(CONN);
      expect(res.response.status).toBe('error');
      expect(res.response.errorMsg).toContain(CONN);
      expect(f.chatRequests()).toHaveLength(0);
    });
  });

  it('oráculo reprovando o workspace intocado (score 0): null, não nao', async () => {
    await comJuiz(async () => {
      const res = await runAgentStage(params({ verify: VERIFY }, gatewayFalso(infra())));
      expect(res.repResults[0].oracle?.score).toBe(0);
      expect(res.repResults[0].verdict).toBeNull();
      expect(res.incomplete).toBe(false); // IMPL-032: incomplete só por controle
    });
  });

  it('oráculo parcial (o agente começou e a rede caiu): null', async () => {
    await comJuiz(async () => {
      const task: AgentTaskSpec = { verify: [...VERIFY, { cmd: 'test -f extra.txt', label: 'extra' }] };
      const res = await runAgentStage(params(task, gatewayFalso(infra({ write: ['done.txt'] }))));
      expect(res.repResults[0].oracle?.score).toBe(0.5);
      expect(res.repResults[0].verdict).toBeNull();
    });
  });

  it('oráculo 100% (o agente fez o trabalho; só a última chamada caiu): o ORÁCULO MANDA → resolve, status ok', async () => {
    await comJuiz(async () => {
      const res = await runAgentStage(params({ verify: VERIFY }, gatewayFalso(infra({ write: ['done.txt'] }))));
      expect(res.repResults[0].oracle?.score).toBe(1);
      expect(res.repResults[0].verdict).toBe('resolve');
      // O motivo gravado continua o real; só o veredito segue o oráculo.
      expect(res.repResults[0].stopReason).toBe('error');
      expect(res.repResults[0].execution.infraError).toBe(CONN);
      expect(res.incomplete).toBe(false);
      // Resultado verificável: a resposta é `ok` (duela nas finais).
      expect(res.response.status).toBe('ok');
      expect(res.errorMsg).toBeUndefined();
    });
  });

  it('violação de forbiddenPaths antes da queda: dano verificável do agente → nao', async () => {
    await comJuiz(async () => {
      const task: AgentTaskSpec = { verify: VERIFY, forbiddenPaths: ['secret.txt'] };
      const res = await runAgentStage(params(task, gatewayFalso(infra({ write: ['done.txt', 'secret.txt'] }))));
      expect(res.repResults[0].oracle?.violations).toEqual(['secret.txt']);
      expect(res.repResults[0].verdict).toBe('nao');
    });
  });

  it('contraste §18.3: processo que MORRE sem erro do provedor continua nao', async () => {
    await comJuiz(async () => {
      const res = await runAgentStage(params({}, gatewayFalso({ stopReason: 'error' })));
      expect(res.repResults[0].verdict).toBe('nao');
      expect(res.repResults[0].execution.infraError).toBeUndefined();
      expect(res.response.status).toBe('error');
    });
  });

  it('reps=3 com infra PERSISTENTE na rep 1: só ELA sai; as outras são observações normais', async () => {
    await comJuiz(async () => {
      const ok: Passo = { stopReason: 'completed', write: ['done.txt'] };
      // IMPL-094: a rep 1 é refeita às cegas 2× (3 tentativas) antes de sair.
      const res = await runAgentStage(params({ verify: VERIFY }, gatewayFalso(ok, infra(), infra(), infra(), ok), 3));
      expect(res.repResults.map((r) => r.verdict)).toEqual(['resolve', null, 'resolve']);
      expect(res.repResults.map((r) => r.attempts)).toEqual([1, 3, 1]);
      expect(res.incomplete).toBe(false);
    });
  });
});

// ===========================================================================
// 3. Pipeline Node — o veredito no RECORD (placar/ranking), não só o executor
// ===========================================================================

function etapa(i: number): StageSpec {
  return {
    question: `tarefa ${i}: crie done.txt`,
    productContext: 'workspace vazio',
    maxTokens: 500,
    reference: 'done.txt existe',
    origin: 'import',
    agentTask: { verify: VERIFY, limits: { maxCostUsd: 0.05 } },
  };
}

function configAgente(stages: number): RunConfig {
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
  } as RunConfig;
}

describe('pipeline Node — container sem rota até o provedor não inventa nao', () => {
  afterEach(() => {
    fake.roteiro = () => ({ stopReason: 'completed' });
  });

  it("fake/b com erro de infra em TODA execução: nenhum 'nao' no record — chave ausente, fora do ranking", async () => {
    // fake/a trabalha e passa o oráculo; fake/b nunca alcança o modelo (o caso
    // `--network none` sem proxy: "Connection error." com exit 0).
    fake.roteiro = ({ modelId }) =>
      modelId === 'fake/b' ? infra() : { stopReason: 'completed', write: ['done.txt'] };
    await comJuiz(async () => {
      const rec: RunRecord = await runToCompletion(configAgente(3), KEY, {});
      expect(rec.status, rec.error).not.toBe('error');
      const julgadas = rec.stages.filter((s) => s.referenceJudge && !s.incomplete);
      expect(julgadas).toHaveLength(3);
      for (const s of julgadas) {
        const mapa = s.referenceJudge!.verdictByContestant;
        expect(mapa['fake/a']).toBe('resolve');
        // Sem veredito = chave AUSENTE (sem observação) — nunca 'nao'.
        expect('fake/b' in mapa).toBe(false);
        expect(Object.values(mapa)).not.toContain('nao');
        expect(s.judge!.rankedContestantIds).not.toContain('fake/b');
        const rb = s.responses.find((r) => r.contestantId === 'fake/b')!;
        expect(rb.status).toBe('error');
        expect(rb.execution?.infraError).toBe(CONN);
      }
    });
  });
});

describe('integração IMPL-036 × IMPL-004/033 — procedência da rep sem veredito por infra', () => {
  it('rep sem veredito por erro de infra => competitor_error (papel do executor), não falha do juiz', () => {
    const p = agentStageProvenance([
      { path: 'error', verdict: null, explanation: 'x', infraError: `erro de infraestrutura (${CONN})` },
    ]);
    expect(p).toEqual({ error: { kind: 'competitor_error', message: `erro de infraestrutura (${CONN})` } });
    // Juiz que falhou continua sendo do juiz.
    const j = agentStageProvenance([
      { path: 'no-oracle-judge', verdict: null, explanation: 'x', judgeError: { kind: 'judge_failed', message: 'HTTP 400' } },
    ]);
    expect(j.error?.kind).toBe('judge_failed');
  });
});
