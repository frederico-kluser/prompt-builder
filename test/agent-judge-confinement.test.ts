// IMPL-033 (R-14a REC-3 / DEC-3) — o juiz de agente confinado à faixa do
// oráculo, e a falha do juiz que NÃO degrada.
//
// As três garantias (e os defeitos que elas matam):
//   A2 — score∈(0,1) + juiz 'resolve' virava 'resolve' (promoção acima do
//        oráculo). Agora o teto é 'parcial': o juiz só confirma ou cai a 'nao'.
//   A3 — falha do juiz virava 'parcial' sem retry e sem flag (resolve→parcial).
//        Agora: 2 retentativas; esgotadas, fica o veredito do ORÁCULO + a flag
//        `judgeError`; sem oráculo, a rep fica sem veredito (Inspect: unscored).
//   —  — verificador inconclusivo = execução inválida (re-verificada e, se
//        persistir, sem veredito), nunca promoção pelo juiz.
// E a contagem de `judgeError` por run (record + resumo NDJSON/CLI).
//
// Camadas (todas sem rede e sem gasto):
//   1. puras — `clampToOracleBand`/`settleRepVerdict` + varredura exaustiva;
//   2. `judgeDossier` com gateway falso (retries, timeout real do gateway,
//      saída inválida, painel reduzido, sinais de controle);
//   3. `runAgentStage` com executor injetado (workspace git e oráculo REAIS);
//   4. `runToCompletion` (Node) com o `pi` trocado por um executor falso.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Executor FALSO no lugar do `pi` para a camada 4 (o orquestrador sempre usa o
// `piExecutor` do módulo). O resto — git, oráculo, dossiê, store, árvore — é real.
// ---------------------------------------------------------------------------
const fake = vi.hoisted(() => ({
  /** Arquivos que a execução escreve, por pergunta. */
  escreve: ((): string[] => ['done.txt']) as (question: string) => string[],
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
      run: async (opts: { workspaceDir: string; env: Record<string, string> }) => {
        fake.calls += 1;
        for (const f of fake.escreve(opts.env.PI_TASK)) write(join(opts.workspaceDir, f), 'ok\n', 'utf8');
        return fakeOutcome('completed', opts.env.PI_MODEL_ID);
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
  clampToOracleBand,
  decideRepVerdict,
  settleRepVerdict,
  tallyReps,
  type JudgeOutcome,
  type TreeInput,
} from '../src/agent/verdictTree.js';
import { AGENT_JUDGE_RETRIES, judgeDossier } from '../src/agent/agentJudge.js';
import { runAgentStage, type AgentGateway, type RunAgentStageParams } from '../src/agent/runAgentStage.js';
import { BudgetLedger, isControlSignal } from '../src/budget.js';
import {
  createGateway,
  setDefaultGateway,
  type FetchLike,
  type OpenRouterGateway,
} from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion } from '../src/orchestrator.js';
import { normalizeRunRecord } from '../src/normalize.js';
import { emitRunEvent } from '../src/cli/ndjson.js';
import type { Output } from '../src/cli/output.js';
import type { RunConfig, RunRecord, StageSpec, Verdict } from '../src/types.js';
import type { AgentTaskSpec } from '../src/agent/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeChatReply, type FakeOpenRouter } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const ORD: Record<Verdict, number> = { nao: 0, parcial: 1, resolve: 2 };
const VEREDITOS: Verdict[] = ['nao', 'parcial', 'resolve'];

// ===========================================================================
// 1. Puras
// ===========================================================================

describe('IMPL-033 — faixa do oráculo (puro)', () => {
  it('clampToOracleBand: nunca abaixo do piso nem acima do teto', () => {
    for (const v of VEREDITOS) {
      for (const floor of VEREDITOS) {
        for (const ceiling of VEREDITOS.filter((c) => ORD[c] >= ORD[floor])) {
          const r = clampToOracleBand(v, floor, ceiling);
          expect(ORD[r]).toBeGreaterThanOrEqual(ORD[floor]);
          expect(ORD[r]).toBeLessThanOrEqual(ORD[ceiling]);
          if (ORD[v] >= ORD[floor] && ORD[v] <= ORD[ceiling]) expect(r).toBe(v);
        }
      }
    }
  });

  for (const score of [0.01, 0.25, 0.5, 0.99]) {
    it(`A2: oráculo score ${score} + juiz 'resolve' ⇒ veredito final 'parcial' (sem promoção)`, () => {
      const d = decideRepVerdict({ stopReason: 'completed', oracle: { score, violations: [] }, diffEmpty: false });
      expect(d).toMatchObject({ kind: 'judge', path: 'oracle-partial', candidate: 'parcial', floor: 'nao', ceiling: 'parcial' });
      const s = settleRepVerdict(d, { status: 'ok', verdict: 'resolve', explanation: 'parece ótimo' });
      expect(s.verdict).toBe('parcial');
      expect(s.judgeUsed).toBe(true);
      expect(s.source).toBe('judge');
      expect(s.judgeVerdictBeforeClamp).toBe('resolve');
      expect(s.explanation).toContain('confinado');
    });
  }

  it("oráculo parcial: juiz confirma 'parcial' ou cai a 'nao' (verbatim, sem flag de confinamento)", () => {
    const d = decideRepVerdict({ stopReason: 'completed', oracle: { score: 0.5, violations: [] }, diffEmpty: false });
    for (const v of ['parcial', 'nao'] as const) {
      const s = settleRepVerdict(d, { status: 'ok', verdict: v, explanation: 'x' });
      expect(s.verdict).toBe(v);
      expect(s.judgeVerdictBeforeClamp).toBeUndefined();
    }
  });

  it("oráculo 100%: juiz só rebaixa a 'parcial' ('nao' vira 'parcial'; 'resolve' fica)", () => {
    const d = decideRepVerdict({ stopReason: 'completed', oracle: { score: 1, violations: [] }, diffEmpty: false });
    expect(settleRepVerdict(d, { status: 'ok', verdict: 'nao', explanation: 'x' })).toMatchObject({
      verdict: 'parcial',
      judgeVerdictBeforeClamp: 'nao',
    });
    expect(settleRepVerdict(d, { status: 'ok', verdict: 'parcial', explanation: 'x' }).verdict).toBe('parcial');
    expect(settleRepVerdict(d, { status: 'ok', verdict: 'resolve', explanation: 'x' }).verdict).toBe('resolve');
  });

  it("A3: juiz falhou ⇒ veredito do ORÁCULO preservado + judgeError (nunca resolve→parcial)", () => {
    const falha: JudgeOutcome = { status: 'failed', error: { kind: 'timeout', message: 'timeout' }, attempts: 3 };
    const pass = decideRepVerdict({ stopReason: 'completed', oracle: { score: 1, violations: [] }, diffEmpty: false });
    expect(settleRepVerdict(pass, falha)).toMatchObject({
      verdict: 'resolve',
      source: 'ground-truth',
      judgeUsed: false,
      judgeError: { kind: 'timeout' },
    });
    const parcial = decideRepVerdict({ stopReason: 'completed', oracle: { score: 0.5, violations: [] }, diffEmpty: false });
    expect(settleRepVerdict(parcial, falha)).toMatchObject({ verdict: 'parcial', source: 'ground-truth', judgeError: { kind: 'timeout' } });
  });

  it('sem oráculo + juiz falhou ⇒ SEM veredito (nunca parcial inventado) + judgeError', () => {
    const d = decideRepVerdict({ stopReason: 'completed', diffEmpty: false });
    const s = settleRepVerdict(d, { status: 'failed', error: { kind: 'judge_failed', message: 'HTTP 400' }, attempts: 3 });
    expect(s.verdict).toBeNull();
    expect(s.source).toBeUndefined();
    expect(s.judgeError).toEqual({ kind: 'judge_failed', message: 'HTTP 400' });
  });

  it('sem juiz configurado: oráculo fica (sem flag); sem oráculo, sem veredito (sem flag)', () => {
    const pass = decideRepVerdict({ stopReason: 'completed', oracle: { score: 1, violations: [] }, diffEmpty: false });
    expect(settleRepVerdict(pass, { status: 'skipped' })).toMatchObject({ verdict: 'resolve', source: 'ground-truth' });
    expect(settleRepVerdict(pass, { status: 'skipped' }).judgeError).toBeUndefined();
    const semOraculo = decideRepVerdict({ stopReason: 'completed', diffEmpty: false });
    expect(settleRepVerdict(semOraculo, { status: 'skipped' })).toMatchObject({ verdict: null, judgeUsed: false });
  });

  it('painel reduzido (parte dos juízes falhou): veredito dos que responderam, origem degraded', () => {
    const d = decideRepVerdict({ stopReason: 'completed', oracle: { score: 1, violations: [] }, diffEmpty: false });
    expect(settleRepVerdict(d, { status: 'ok', verdict: 'resolve', explanation: 'x', degraded: true })).toMatchObject({
      verdict: 'resolve',
      source: 'degraded',
    });
  });

  it('verificador inconclusivo ⇒ execução inválida: sem veredito e o juiz NEM é consultado', () => {
    for (const score of [0, 0.5, 1]) {
      const d = decideRepVerdict({
        stopReason: 'completed',
        oracle: { score, violations: [], inconclusive: true },
        diffEmpty: false,
      });
      expect(d).toMatchObject({ kind: 'unscored', path: 'oracle-inconclusive' });
      // Mesmo que alguém passasse um juiz entusiasmado, a decisão não gradua.
      expect(settleRepVerdict(d, { status: 'ok', verdict: 'resolve', explanation: 'x' })).toMatchObject({
        verdict: null,
        judgeUsed: false,
      });
    }
    // Violação (medida no diff) e corte por limite continuam decidindo 'nao'.
    expect(
      decideRepVerdict({ stopReason: 'completed', oracle: { score: 0.5, violations: ['x'], inconclusive: true }, diffEmpty: false }),
    ).toMatchObject({ kind: 'final', verdict: 'nao', path: 'oracle-violation' });
    expect(
      decideRepVerdict({ stopReason: 'timeout', oracle: { score: 1, violations: [], inconclusive: true }, diffEmpty: false }),
    ).toMatchObject({ kind: 'final', verdict: 'nao', path: 'limit-cut' });
  });

  it('varredura exaustiva: NENHUM caminho produz resolve acima do score do oráculo', () => {
    const motivos = ['completed', 'cancelled', 'error', 'timeout', 'maxTurns', 'maxCost', 'maxOutput', 'desconhecido'];
    const oraculos: Array<TreeInput['oracle']> = [undefined];
    for (const score of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
      for (const violations of [[], ['proibido.txt']]) {
        for (const inconclusive of [false, true]) oraculos.push({ score, violations, inconclusive });
      }
    }
    const juizes: Array<JudgeOutcome | undefined> = [
      undefined,
      { status: 'skipped' },
      { status: 'failed', error: { kind: 'judge_failed', message: 'x' }, attempts: 3 },
      { status: 'failed', error: { kind: 'timeout', message: 'timeout' }, attempts: 3 },
      { status: 'failed', error: { kind: 'invalid_output', message: 'lixo' }, attempts: 3 },
      ...VEREDITOS.flatMap((verdict) => [
        { status: 'ok' as const, verdict, explanation: 'x' },
        { status: 'ok' as const, verdict, explanation: 'x', degraded: true },
      ]),
    ];
    let casos = 0;
    for (const stopReason of motivos) {
      for (const oracle of oraculos) {
        for (const diffEmpty of [true, false]) {
          const d = decideRepVerdict({ stopReason, oracle, diffEmpty });
          for (const j of juizes) {
            const s = settleRepVerdict(d, j);
            casos += 1;
            const ctx = `${stopReason}/${JSON.stringify(oracle)}/${diffEmpty}/${JSON.stringify(j)}`;
            if (oracle) {
              const limpo100 = oracle.score === 1 && oracle.violations.length === 0 && !oracle.inconclusive;
              // (a) 'resolve' só com oráculo 100% limpo e conclusivo.
              if (s.verdict === 'resolve') expect(limpo100, ctx).toBe(true);
              // (b) oráculo em (0,1) nunca passa de 'parcial'.
              if (oracle.score > 0 && oracle.score < 1 && s.verdict !== null) {
                expect(ORD[s.verdict], ctx).toBeLessThanOrEqual(ORD.parcial);
              }
              // (c) oráculo 0 ou violação ⇒ nunca acima de 'nao'.
              if ((oracle.score === 0 || oracle.violations.length > 0) && s.verdict !== null) {
                expect(s.verdict, ctx).toBe('nao');
              }
              // (d) verificador inconclusivo nunca é graduado pelo juiz.
              if (oracle.inconclusive) expect(s.judgeUsed, ctx).toBe(false);
            }
            // (e) falha do juiz nunca inventa veredito: ou o do oráculo, ou nenhum.
            if (j?.status === 'failed' && d.kind === 'judge') {
              expect(s.verdict, ctx).toBe(d.candidate);
              expect(s.judgeError, ctx).toEqual(j.error);
            }
            // (f) todo veredito presente tem origem; ausente não tem.
            expect(s.source === undefined, ctx).toBe(s.verdict === null);
          }
        }
      }
    }
    expect(casos).toBeGreaterThan(3000);
  });

  it('tallyReps separa observação, corte, cancelamento, sem-veredito e judgeError', () => {
    const t = tallyReps([
      { path: 'oracle-pass', verdict: 'resolve', judgeError: { kind: 'timeout', message: 't' } },
      { path: 'limit-cut', verdict: 'nao' },
      { path: 'oracle-inconclusive', verdict: null },
      { path: 'no-oracle-judge', verdict: null, judgeError: { kind: 'judge_failed', message: 'x' } },
      { path: 'cancelled', verdict: null },
    ]);
    expect(t).toEqual({ verdicts: ['resolve', 'nao'], limitCuts: 1, cancelled: 1, unscored: 2, judgeErrors: 2 });
  });
});

// ===========================================================================
// 2. judgeDossier — retentativas e falha estruturada
// ===========================================================================

const STAGE: StageSpec = { question: 'crie done.txt', productContext: 'repo', maxTokens: 500 };
const CATALOGO = ['fake/a', 'fake/b', 'fake/judge', 'fake/judge2', 'fake/gen'].map((id) => catalogItem(id, 1e-6, 1e-6));

function gatewayCom(f: { fetch: FetchLike }): OpenRouterGateway {
  return createGateway({ fetch: f.fetch, sleep: noSleep });
}

async function comJuiz<T>(
  chat: (req: { model: string; user: string }, n: number) => FakeChatReply,
  fn: (f: FakeOpenRouter) => Promise<T>,
): Promise<T> {
  const f = fakeOpenRouter({ catalog: CATALOGO, chat });
  const anterior = setDefaultGateway(gatewayCom(f));
  try {
    return await fn(f);
  } finally {
    setDefaultGateway(anterior);
  }
}

const JSON_OK = (v: Verdict) => ({ text: JSON.stringify({ verdict: v, explanation: `juiz: ${v}` }) });
const HTTP_400 = { status: 400, bodyText: '{"error":{"message":"bad request"}}' };

describe('IMPL-033 — judgeDossier: retry 2× e falha estruturada (nunca parcial)', () => {
  it(`exceção em toda tentativa ⇒ 1+${AGENT_JUDGE_RETRIES} chamadas, verdict null + judgeError`, async () => {
    await comJuiz(() => HTTP_400, async (f) => {
      const r = await judgeDossier({ stage: STAGE, dossierText: 'diff', contestantId: 'a', judgeModelIds: ['fake/judge'], apiKey: KEY });
      expect(f.chatRequests()).toHaveLength(1 + AGENT_JUDGE_RETRIES);
      expect(r.verdict).toBeNull();
      expect(r.judgeError?.kind).toBe('judge_failed');
      expect(r.attempts).toBe(3);
      expect(r.inconclusive).toBe(true);
    });
  });

  it('falha na 1ª, sucesso na 2ª ⇒ veredito válido, sem flag', async () => {
    await comJuiz((_, n) => (n === 0 ? HTTP_400 : JSON_OK('nao')), async (f) => {
      const r = await judgeDossier({ stage: STAGE, dossierText: 'diff', contestantId: 'a', judgeModelIds: ['fake/judge'], apiKey: KEY });
      expect(f.chatRequests()).toHaveLength(2);
      expect(r).toMatchObject({ verdict: 'nao', attempts: 2 });
      expect(r.judgeError).toBeUndefined();
    });
  });

  it("saída sem veredito reconhecível é FALHA re-tentada (com lembrete de formato), nunca 'parcial'", async () => {
    await comJuiz((_, n) => (n < 2 ? { text: 'hmm, difícil dizer' } : JSON_OK('resolve')), async (f) => {
      const r = await judgeDossier({ stage: STAGE, dossierText: 'diff', contestantId: 'a', judgeModelIds: ['fake/judge'], apiKey: KEY });
      expect(r).toMatchObject({ verdict: 'resolve', attempts: 3 });
      const reqs = f.chatRequests();
      expect(reqs[0].user).not.toContain('LEMBRETE');
      expect(reqs[1].user).toContain('LEMBRETE');
    });
    await comJuiz(() => ({ text: '???' }), async () => {
      const r = await judgeDossier({ stage: STAGE, dossierText: 'diff', contestantId: 'a', judgeModelIds: ['fake/judge'], apiKey: KEY });
      expect(r.verdict).toBeNull();
      expect(r.judgeError?.kind).toBe('invalid_output');
    });
  });

  it('TIMEOUT real do gateway (abort por tempo) em toda tentativa ⇒ judgeError kind timeout, 3 tentativas', async () => {
    const f = fakeOpenRouter({ catalog: CATALOGO });
    let chats = 0;
    // Transporte que "pendura" o chat até o gateway abortar pelo timeout.
    const pendura: FetchLike = (url, init) => {
      if (!String(url).endsWith('/chat/completions')) return f.fetch(url, init);
      chats += 1;
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    };
    const anterior = setDefaultGateway(createGateway({ fetch: pendura, sleep: noSleep }));
    try {
      const r = await judgeDossier({
        stage: STAGE,
        dossierText: 'diff',
        contestantId: 'a',
        judgeModelIds: ['fake/judge'],
        apiKey: KEY,
        timeoutMs: 20,
      });
      expect(chats).toBe(1 + AGENT_JUDGE_RETRIES);
      expect(r.verdict).toBeNull();
      expect(r.judgeError?.kind).toBe('timeout');
    } finally {
      setDefaultGateway(anterior);
    }
  });

  it('painel de 2 juízes com 1 falho ⇒ veredito do que respondeu, degraded + failedJudges', async () => {
    await comJuiz((req) => (req.model === 'fake/judge2' ? HTTP_400 : JSON_OK('resolve')), async () => {
      const r = await judgeDossier({
        stage: STAGE,
        dossierText: 'diff',
        contestantId: 'a',
        judgeModelIds: ['fake/judge', 'fake/judge2'],
        apiKey: KEY,
      });
      expect(r).toMatchObject({ verdict: 'resolve', degraded: true });
      expect(r.failedJudges?.map((x) => x.judgeModelId)).toEqual(['fake/judge2']);
      expect(r.judgeError).toBeUndefined();
    });
  });

  it('orçamento estourado é CONTROLE: sobe sem retentativa e sem virar judgeError', async () => {
    await comJuiz(() => JSON_OK('resolve'), async (f) => {
      const sink = new BudgetLedger({ budgetUsd: 0.000001, estimateCall: () => 1 });
      const err = await judgeDossier({
        stage: STAGE,
        dossierText: 'diff',
        contestantId: 'a',
        judgeModelIds: ['fake/judge'],
        apiKey: KEY,
        ctx: { sink },
      }).catch((e: unknown) => e);
      expect(isControlSignal(err)).toBe(true);
      expect(f.chatRequests()).toHaveLength(0);
    });
  });

  it('cancelamento no meio da chamada vira RunCancelled (controle), não falha do juiz', async () => {
    const ac = new AbortController();
    await comJuiz(
      () => {
        ac.abort('Ctrl-C');
        return HTTP_400;
      },
      async (f) => {
        const err = await judgeDossier({
          stage: STAGE,
          dossierText: 'diff',
          contestantId: 'a',
          judgeModelIds: ['fake/judge'],
          apiKey: KEY,
          ctx: { signal: ac.signal },
        }).catch((e: unknown) => e);
        expect(isControlSignal(err)).toBe(true);
        expect(f.chatRequests()).toHaveLength(1);
      },
    );
  });
});

// ===========================================================================
// 3. runAgentStage com executor injetado (workspace git e oráculo REAIS)
// ===========================================================================

let tmp: string;
let dirAnterior: string;
let silencio: Array<{ mockRestore(): void }> = [];

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'pb-impl033-'));
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

function executorFalso(escreve: string[]): AgentGateway {
  return {
    id: 'pi-fake',
    prepare: async () => ({ bin: 'pi-fake', env: {} }),
    run: async (opts) => {
      for (const f of escreve) writeFileSync(path.join(opts.workspaceDir, f), 'ok\n', 'utf8');
      return fakeOutcome('completed', opts.env.PI_MODEL_ID) as never;
    },
  };
}

let stageSeq = 0;
function params(task: AgentTaskSpec, gateway: AgentGateway, extra: Partial<RunAgentStageParams> = {}): RunAgentStageParams {
  return {
    runId: 'run-impl033',
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

const PASSA = { cmd: 'test -f done.txt', label: 'done' };
const FALHA = { cmd: 'test -f extra.txt', label: 'extra' };

describe('IMPL-033 — runAgentStage: juiz confinado e falha preservando o oráculo', () => {
  it("oráculo 50% + juiz 'resolve' ⇒ rep 'parcial' (confinada), juiz usado", async () => {
    await comJuiz(() => JSON_OK('resolve'), async (f) => {
      const res = await runAgentStage(params({ verify: [PASSA, FALHA] }, executorFalso(['done.txt'])));
      expect(res.repResults[0].oracle?.score).toBe(0.5);
      expect(res.repResults[0]).toMatchObject({
        verdict: 'parcial',
        path: 'oracle-partial',
        judgeUsed: true,
        source: 'judge',
        judgeVerdictBeforeClamp: 'resolve',
      });
      expect(res.repResults[0].judgeError).toBeUndefined();
      expect(f.chatRequests()).toHaveLength(1);
    });
  });

  it("oráculo 100% + juiz lança em toda tentativa ⇒ 'resolve' do oráculo preservado + judgeError", async () => {
    await comJuiz(() => HTTP_400, async (f) => {
      const res = await runAgentStage(params({ verify: [PASSA] }, executorFalso(['done.txt'])));
      expect(res.repResults[0]).toMatchObject({
        verdict: 'resolve',
        path: 'oracle-pass',
        judgeUsed: false,
        source: 'ground-truth',
        judgeError: { kind: 'judge_failed' },
      });
      expect(res.repResults[0].explanation).toContain('veredito do oráculo preservado');
      expect(f.chatRequests()).toHaveLength(1 + AGENT_JUDGE_RETRIES);
      expect(res.incomplete).toBe(false);
    });
  });

  it("oráculo 100% + juiz com timeout (erro de transporte TimeoutError) ⇒ 'resolve' + judgeError timeout", async () => {
    const f = fakeOpenRouter({ catalog: CATALOGO });
    const timeout: FetchLike = (url, init) => {
      if (!String(url).endsWith('/chat/completions')) return f.fetch(url, init);
      return Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    };
    const anterior = setDefaultGateway(createGateway({ fetch: timeout, sleep: noSleep }));
    try {
      const res = await runAgentStage(params({ verify: [PASSA] }, executorFalso(['done.txt'])));
      expect(res.repResults[0]).toMatchObject({ verdict: 'resolve', judgeError: { kind: 'timeout' } });
    } finally {
      setDefaultGateway(anterior);
    }
  });

  it("oráculo 50% + juiz falho ⇒ 'parcial' do oráculo + judgeError (não inventa nem promove)", async () => {
    await comJuiz(() => HTTP_400, async () => {
      const res = await runAgentStage(params({ verify: [PASSA, FALHA] }, executorFalso(['done.txt'])));
      expect(res.repResults[0]).toMatchObject({ verdict: 'parcial', path: 'oracle-partial', judgeError: { kind: 'judge_failed' } });
    });
  });

  it('sem oráculo + juiz falho ⇒ rep SEM veredito (fora do denominador) + judgeError; não é incomplete', async () => {
    await comJuiz(() => HTTP_400, async () => {
      const res = await runAgentStage(params({}, executorFalso(['feito.txt'])));
      expect(res.repResults[0]).toMatchObject({ verdict: null, path: 'no-oracle-judge', judgeError: { kind: 'judge_failed' } });
      expect(res.repResults[0].source).toBeUndefined();
      expect(res.incomplete).toBe(false);
    });
  });

  it('verificador inconclusivo persistente (comando ausente) ⇒ re-verificado 3×, sem veredito, 0 chamadas de juiz', async () => {
    await comJuiz(() => JSON_OK('resolve'), async (f) => {
      const res = await runAgentStage(
        params({ verify: [{ cmd: 'comando-que-nao-existe-impl033', label: 'fantasma' }] }, executorFalso(['done.txt'])),
      );
      expect(res.repResults[0]).toMatchObject({ verdict: null, path: 'oracle-inconclusive', judgeUsed: false, oracleAttempts: 3 });
      expect(res.repResults[0].oracle?.inconclusive).toBe(true);
      expect(res.incomplete).toBe(false);
      expect(f.chatRequests()).toHaveLength(0);
    });
  });

  it('verificador inconclusivo UMA vez (timeout do check) ⇒ re-verificação decide e o caminho segue normal', async () => {
    await comJuiz(() => JSON_OK('resolve'), async () => {
      // 1ª execução do check: marca e dorme além do timeout (inconclusivo);
      // 2ª: a marca existe e o check passa — o soluço do verificador não vira nota.
      const instavel = {
        cmd: 'sh -c "if [ -f .reverificado ]; then exit 0; fi; touch .reverificado; sleep 5"',
        label: 'instável',
        timeoutMs: 400,
      };
      const res = await runAgentStage(params({ verify: [instavel] }, executorFalso(['done.txt'])));
      expect(res.repResults[0]).toMatchObject({ verdict: 'resolve', path: 'oracle-pass', oracleAttempts: 2 });
      expect(res.repResults[0].oracle?.inconclusive).toBe(false);
    });
  });
});

// ===========================================================================
// 4. Ponta a ponta (Node): contagem de judgeError por run
// ===========================================================================

function etapa(i: number, task: AgentTaskSpec): StageSpec {
  return {
    question: `tarefa ${i}: crie done.txt`,
    productContext: 'workspace vazio',
    maxTokens: 500,
    reference: 'done.txt existe',
    origin: 'import',
    agentTask: { limits: { maxCostUsd: 0.05 }, ...task },
  };
}

function configAgente(tasks: AgentTaskSpec[], extra: Partial<RunConfig> = {}): RunConfig {
  return {
    mode: 'compare',
    theme: 'agentes',
    stages: tasks.length,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceJudging: false,
    competitorModelIds: ['fake/a', 'fake/b'],
    duels: false,
    timeoutMs: 5_000,
    customStages: tasks.map((t, i) => etapa(i, t)),
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

function resumoNdjson(record: RunRecord): Record<string, unknown> | undefined {
  const linhas: Array<[string, Record<string, unknown>]> = [];
  const out = { isNdjson: true, event: (t: string, p: Record<string, unknown>) => linhas.push([t, p]) };
  emitRunEvent(out as unknown as Output, { type: 'run.finished', runId: record.id, record });
  return linhas.find(([t]) => t === 'run.finished')?.[1].agentSummary as Record<string, unknown> | undefined;
}

describe('IMPL-033 — pipeline Node: nota do oráculo preservada e judgeError contado por run', () => {
  afterEach(() => {
    fake.calls = 0;
    fake.escreve = () => ['done.txt'];
  });

  it('juiz sempre falha: notas = oráculo (judge-score 100, não 50), agentJudgeErrorCount = execuções', async () => {
    await comJuiz(() => HTTP_400, async (f) => {
      const rec = await runToCompletion(configAgente([{ verify: [PASSA] }, { verify: [PASSA] }, { verify: [PASSA] }]), KEY, {});
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.agentVerdictTreeVersion).toBe(AGENT_VERDICT_TREE_VERSION);
      for (const s of rec.stages) {
        expect(s.referenceJudge!.verdictByContestant).toEqual({ 'fake/a': 'resolve', 'fake/b': 'resolve' });
        expect(s.referenceJudge!.judgeErrorByContestant).toEqual({ 'fake/a': 1, 'fake/b': 1 });
      }
      // Antes (A3): falha ⇒ 'parcial' ⇒ judge-score 50 para quem o oráculo aprovou.
      expect(rec.judgeScoreByContestant).toEqual({ 'fake/a': 100, 'fake/b': 100 });
      expect(rec.agentJudgeErrorCount).toBe(6);
      expect(rec.agentJudgeErrorsByContestant).toEqual({ 'fake/a': 3, 'fake/b': 3 });
      expect(rec.agentUnscoredRepsByContestant).toEqual({});
      // 6 execuções × (1 + 2 retentativas).
      expect(f.chatRequests()).toHaveLength(6 * (1 + AGENT_JUDGE_RETRIES));
      expect(resumoNdjson(rec)).toMatchObject({ executions: 6, judgeErrors: 6, unscoredReps: 0 });

      // Whitelist normalizeRunRecord: os campos novos sobrevivem à releitura.
      const relido = normalizeRunRecord(JSON.parse(JSON.stringify(rec)));
      expect(relido.agentJudgeErrorCount).toBe(6);
      expect(relido.agentJudgeErrorsByContestant).toEqual({ 'fake/a': 3, 'fake/b': 3 });
      expect(relido.agentUnscoredRepsByContestant).toEqual({});
      expect(relido.stages[0].referenceJudge?.judgeErrorByContestant).toEqual({ 'fake/a': 1, 'fake/b': 1 });
    });
  });

  it('juiz saudável: contagem presente e zerada (disponível em toda run com agente)', async () => {
    await comJuiz(() => JSON_OK('resolve'), async () => {
      const rec = await runToCompletion(configAgente([{ verify: [PASSA] }]), KEY, {});
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.agentJudgeErrorCount).toBe(0);
      expect(rec.agentJudgeErrorsByContestant).toEqual({});
      expect(rec.stages[0].referenceJudge!.judgeErrorByContestant).toBeUndefined();
      expect(resumoNdjson(rec)).toMatchObject({ judgeErrors: 0 });
    });
  });

  it("oráculo parcial + juiz 'resolve' em run inteira: nenhuma nota passa de 'parcial'", async () => {
    await comJuiz(() => JSON_OK('resolve'), async () => {
      const rec = await runToCompletion(configAgente([{ verify: [PASSA, FALHA] }, { verify: [PASSA, FALHA] }]), KEY, {});
      expect(rec.status, rec.error).toBe('finished');
      for (const s of rec.stages) {
        expect(s.referenceJudge!.verdictByContestant).toEqual({ 'fake/a': 'parcial', 'fake/b': 'parcial' });
      }
      expect(rec.judgeScoreByContestant).toEqual({ 'fake/a': 50, 'fake/b': 50 });
      expect(rec.resolveRateByContestant).toEqual({ 'fake/a': 0, 'fake/b': 0 });
    });
  });

  it('sem oráculo + juiz falho: contestant sem veredito na etapa (fora do placar), contado como unscored', async () => {
    fake.escreve = () => ['feito.txt'];
    await comJuiz(() => HTTP_400, async () => {
      const rec = await runToCompletion(configAgente([{}, {}]), KEY, {});
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.stages.some((s) => s.incomplete)).toBe(false);
      for (const s of rec.stages) {
        // Chave AUSENTE — nunca 'parcial'/'nao' imputado.
        expect(s.referenceJudge!.verdictByContestant).toEqual({});
        expect(s.referenceJudge!.unscoredRepsByContestant).toEqual({ 'fake/a': 1, 'fake/b': 1 });
        expect(s.judge!.rankedContestantIds).toEqual([]);
      }
      expect(rec.agentJudgeErrorCount).toBe(4);
      expect(rec.agentUnscoredRepsByContestant).toEqual({ 'fake/a': 2, 'fake/b': 2 });
      expect(resumoNdjson(rec)).toMatchObject({ judgeErrors: 4, unscoredReps: 4 });
    });
  });
});
