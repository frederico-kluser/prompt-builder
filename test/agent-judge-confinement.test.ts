// IMPL-033 (R-14a REC-3 / DEC-3) — o juiz de agente confinado à faixa do
// oráculo, e a falha do juiz que NÃO degrada.
//
// As três garantias (e os defeitos que elas matam):
//   A2 — score∈(0,1) + juiz 'resolve' virava 'resolve' (promoção acima do
//        oráculo). Agora o teto é 'parcial': o juiz só confirma ou cai a 'nao'.
//   A3 — falha do juiz virava 'parcial' sem retry e sem flag (resolve→parcial).
//        Agora: 2 retentativas; esgotadas, fica o veredito do ORÁCULO + a flag
//        `judgeError`; sem oráculo, a rep fica sem veredito (Inspect: unscored).
//   —  — verificador que não terminou nunca promove e nunca tira a rep do
//        denominador: timeout/sinal do check = check FALHO (desfecho do código
//        sob teste, sem re-verificação); comando que nem começou = re-verificado
//        às cegas e, persistindo, FALHO — a menos que não rode em NENHUMA
//        execução da etapa (defeito do ambiente: etapa inválida para TODOS).
//        (Revisão: a 1ª versão tirava a rep inconclusiva só de quem pendurava o
//        verificador — quem quebrava a suíte ganhava de quem falhava limpo.)
//   —  — saída livre do juiz (recusa etc.) nunca vira veredito por palavra.
// E a contagem de `judgeError` por run (record + resumo NDJSON/CLI).
//
// Camadas (todas sem rede e sem gasto):
//   1. puras — `clampToOracleBand`/`settleRepVerdict` + varredura exaustiva;
//   2. `judgeDossier` com gateway falso (retries, timeout real do gateway,
//      saída inválida, painel reduzido, sinais de controle);
//   3. `runAgentStage` com executor injetado (workspace git e oráculo REAIS);
//   4. `runToCompletion` (Node) com o `pi` trocado por um executor falso.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Executor FALSO no lugar do `pi` para a camada 4 (o orquestrador sempre usa o
// `piExecutor` do módulo). O resto — git, oráculo, dossiê, store, árvore — é real.
// ---------------------------------------------------------------------------
type Escrita = string | { path: string; content: string };
const fake = vi.hoisted(() => ({
  /** Arquivos que a execução escreve, por pergunta e modelo (string = conteúdo 'ok'). */
  escreve: ((): Escrita[] => ['done.txt']) as (question: string, modelId: string) => Escrita[],
  /** Arquivos que a execução APAGA (ex.: o script do verificador). */
  apaga: ((): string[] => []) as (question: string, modelId: string) => string[],
  calls: 0,
}));

vi.mock('../src/agent/pi.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/agent/pi.js')>();
  const { writeFileSync: write, rmSync: rm } = await import('node:fs');
  const { join } = await import('node:path');
  return {
    ...orig,
    piExecutor: {
      ...orig.piExecutor,
      id: 'pi-fake',
      prepare: async () => ({ bin: 'pi-fake', env: {} }),
      run: async (opts: { workspaceDir: string; env: Record<string, string> }) => {
        fake.calls += 1;
        const { PI_TASK: q, PI_MODEL_ID: m } = opts.env;
        for (const f of fake.escreve(q, m)) {
          const e = typeof f === 'string' ? { path: f, content: 'ok\n' } : f;
          write(join(opts.workspaceDir, e.path), e.content, 'utf8');
        }
        for (const f of fake.apaga(q, m)) rm(join(opts.workspaceDir, f), { force: true });
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
  agentStageProvenance,
  classifyStop,
  clampToOracleBand,
  decideRepVerdict,
  mergeOracleRecheck,
  oracleCellDefect,
  recheckIndices,
  settleRepVerdict,
  shouldRecheckOracle,
  tallyReps,
  type JudgeOutcome,
  type TreeInput,
} from '../src/agent/verdictTree.js';
import { subscribe } from '../src/events.js';
import { AGENT_JUDGE_RETRIES, judgeDossier } from '../src/agent/agentJudge.js';
import { runAgentStage, type AgentGateway, type RunAgentStageParams } from '../src/agent/runAgentStage.js';
import { readArtifact } from '../src/agent/store.js';
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
import { pairedStageScores } from '../src/trainer.js';
import { emitRunEvent } from '../src/cli/ndjson.js';
import type { Output } from '../src/cli/output.js';
import type { RunConfig, RunEvent, RunRecord, StageSpec, Verdict } from '../src/types.js';
import type { AgentTaskSpec, OracleNotRun, OracleResult } from '../src/agent/types.js';
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

  it('sem juiz chamado (skipped com motivo): oráculo fica; sem oráculo, sem veredito e SEM judgeError', () => {
    const semOraculo = decideRepVerdict({ stopReason: 'completed', diffEmpty: false });
    const s = settleRepVerdict(semOraculo, { status: 'skipped', reason: 'dossiê vazio (nada para o juiz ler)' });
    expect(s).toMatchObject({ verdict: null, judgeUsed: false });
    expect(s.judgeError).toBeUndefined();
    expect(s.explanation).toContain('dossiê vazio');
  });

  it('varredura exaustiva: NENHUM caminho produz resolve acima do score do oráculo', () => {
    const motivos = ['completed', 'cancelled', 'error', 'timeout', 'maxTurns', 'maxCost', 'maxOutput', 'desconhecido'];
    const oraculos: Array<TreeInput['oracle']> = [undefined];
    for (const score of [0, 0.001, 0.1, 0.25, 0.33, 0.5, 0.66, 0.75, 0.9, 0.999, 1]) {
      for (const violations of [[], ['proibido.txt'], ['a', 'b']]) oraculos.push({ score, violations });
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
              const limpo100 = oracle.score === 1 && oracle.violations.length === 0;
              // (a) 'resolve' só com oráculo 100% limpo.
              if (s.verdict === 'resolve') expect(limpo100, ctx).toBe(true);
              // (b) oráculo em (0,1) nunca passa de 'parcial'.
              if (oracle.score > 0 && oracle.score < 1 && s.verdict !== null) {
                expect(ORD[s.verdict], ctx).toBeLessThanOrEqual(ORD.parcial);
              }
              // (c) oráculo 0 ou violação ⇒ nunca acima de 'nao'.
              if ((oracle.score === 0 || oracle.violations.length > 0) && s.verdict !== null) {
                expect(s.verdict, ctx).toBe('nao');
              }
              // (d) COM oráculo, fora do cancelamento, a rep SEMPRE tem veredito —
              //     nada no comportamento do agente (nem a falha do juiz) a tira
              //     do denominador: é o que fecha o viés de sobrevivência.
              if (classifyStop(stopReason) !== 'cancelled') expect(s.verdict, ctx).not.toBeNull();
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
      { path: 'no-oracle-judge', verdict: null },
      { path: 'no-oracle-judge', verdict: null, judgeError: { kind: 'judge_failed', message: 'x' } },
      { path: 'cancelled', verdict: null },
    ]);
    expect(t).toEqual({ verdicts: ['resolve', 'nao'], limitCuts: 1, cancelled: 1, unscored: 2, judgeErrors: 2 });
  });
});

/** Check de oráculo mínimo para os testes puros. */
function chk(label: string, ok: boolean, notRun?: OracleNotRun, weight = 1): OracleResult['checks'][number] {
  return {
    label,
    cmd: label,
    exitCode: notRun ? -1 : ok ? 0 : 1,
    expected: 0,
    ok,
    weight,
    durationMs: 1,
    tail: '',
    ...(notRun ? { notRun } : {}),
  };
}
function oraculo(checks: OracleResult['checks'], violations: string[] = []): OracleResult {
  const w = checks.reduce((a, c) => a + c.weight, 0);
  return {
    checks,
    score: w > 0 ? checks.reduce((a, c) => a + (c.ok ? c.weight : 0), 0) / w : 0,
    violations,
    inconclusive: checks.some((c) => c.notRun !== undefined),
  };
}

describe('IMPL-033 (revisão) — verificador que não terminou: falha, re-verificação cega e célula (puro)', () => {
  it('recheckIndices: SÓ o check que nem começou (spawn); timeout e sinal nunca', () => {
    const o = oraculo([chk('a', true), chk('b', false, 'spawn'), chk('c', false, 'timeout'), chk('d', false, 'signal'), chk('e', false, 'spawn')]);
    expect(recheckIndices(o)).toEqual([1, 4]);
  });

  it('shouldRecheckOracle: só quando o oráculo ainda muda a nota (completed/limit, sem violação)', () => {
    const spawn = oraculo([chk('a', false, 'spawn')]);
    expect(shouldRecheckOracle('completed', spawn)).toBe(true);
    for (const lim of ['timeout', 'maxTurns', 'maxCost', 'maxOutput']) expect(shouldRecheckOracle(lim, spawn)).toBe(true);
    // Desfecho já fixado: 'error' conta 'nao', violação decide 'nao', cancelamento sai.
    for (const fixo of ['error', 'cancelled', 'desconhecido']) expect(shouldRecheckOracle(fixo, spawn)).toBe(false);
    expect(shouldRecheckOracle('completed', oraculo([chk('a', false, 'spawn')], ['proibido.txt']))).toBe(false);
    // Nada a re-verificar: check que pendurou/morreu é desfecho do código sob teste.
    expect(shouldRecheckOracle('completed', oraculo([chk('a', false, 'timeout'), chk('b', false, 'signal')]))).toBe(false);
  });

  it('mergeOracleRecheck: troca só os checks re-verificados; o resto não ganha outra chance', () => {
    const antes = oraculo([chk('a', false), chk('b', false, 'spawn', 2), chk('c', false, 'timeout')]);
    expect(antes.score).toBe(0);
    const recheck = oraculo([chk('b', true)]);
    const depois = mergeOracleRecheck(antes, [1], recheck);
    expect(depois.checks.map((c) => [c.label, c.ok, c.notRun ?? null])).toEqual([
      ['a', false, null],
      ['b', true, null],
      ['c', false, 'timeout'],
    ]);
    // Peso do check re-verificado preservado (2 de 4) e fórmula do oráculo.
    expect(depois.checks[1].weight).toBe(2);
    expect(depois.score).toBe(0.5);
    expect(depois.inconclusive).toBe(true); // o timeout continua lá
    expect(antes.checks[1].ok).toBe(false); // sem mutar o anterior
    // Persistiu: continua falho e marcado.
    const persistiu = mergeOracleRecheck(antes, [1], oraculo([chk('b', false, 'spawn')]));
    expect(persistiu.score).toBe(0);
    expect(persistiu.checks[1].notRun).toBe('spawn');
  });

  it('oracleCellDefect: comando que não rodou em NENHUMA execução ⇒ defeito do ambiente (todos)', () => {
    const quebrado = (): { oracle: OracleResult } => ({ oracle: oraculo([chk('done', true), chk('suite', false, 'spawn')]) });
    expect(oracleCellDefect([quebrado(), quebrado(), quebrado()])).toEqual({ labels: ['suite'], executions: 3 });
    // Execução sem oráculo (processo morreu antes) não conta nem a favor nem contra.
    expect(oracleCellDefect([quebrado(), {}, quebrado()])).toEqual({ labels: ['suite'], executions: 2 });
  });

  it('oracleCellDefect: rodou em ALGUMA execução ⇒ o ambiente serve (a falha é de quem não rodou)', () => {
    const naoRodou = { oracle: oraculo([chk('suite', false, 'spawn')]) };
    const rodouEFalhou = { oracle: oraculo([chk('suite', false)]) };
    const rodouEPassou = { oracle: oraculo([chk('suite', true)]) };
    expect(oracleCellDefect([naoRodou, rodouEFalhou])).toBeNull();
    expect(oracleCellDefect([naoRodou, naoRodou, rodouEPassou])).toBeNull();
  });

  it('oracleCellDefect: timeout/sinal em TODAS as execuções NÃO é defeito (é desfecho do código)', () => {
    const pendurou = { oracle: oraculo([chk('suite', false, 'timeout')]) };
    const morreu = { oracle: oraculo([chk('suite', false, 'signal')]) };
    expect(oracleCellDefect([pendurou, pendurou])).toBeNull();
    expect(oracleCellDefect([pendurou, morreu])).toBeNull();
    // Sem nenhuma execução com oráculo: nada a decidir.
    expect(oracleCellDefect([])).toBeNull();
    expect(oracleCellDefect([{}, {}])).toBeNull();
  });

  it('agentStageProvenance: origem mais frágil entre as reps; sem veredito ⇒ motivo; cancelado ⇒ nada', () => {
    const base = { explanation: 'x' };
    expect(
      agentStageProvenance([
        { ...base, path: 'oracle-pass', verdict: 'resolve', source: 'ground-truth' },
        { ...base, path: 'oracle-pass', verdict: 'resolve', source: 'judge' },
      ]),
    ).toEqual({ source: 'judge' });
    expect(
      agentStageProvenance([
        { ...base, path: 'oracle-pass', verdict: 'resolve', source: 'degraded' },
        { ...base, path: 'error', verdict: 'nao', source: 'auto' },
      ]),
    ).toEqual({ source: 'degraded' });
    expect(agentStageProvenance([{ ...base, path: 'oracle-fail', verdict: 'nao', source: 'ground-truth' }])).toEqual({
      source: 'ground-truth',
    });
    expect(
      agentStageProvenance([
        { ...base, path: 'no-oracle-judge', verdict: null, judgeError: { kind: 'timeout', message: 't' } },
      ]),
    ).toEqual({ error: { kind: 'timeout', message: 't' } });
    // Sem oráculo e juiz não chamado: não é falha do juiz — é falta de régua.
    expect(
      agentStageProvenance([{ path: 'no-oracle-judge', verdict: null, explanation: 'sem oráculo e sem juiz configurado' }]),
    ).toEqual({ error: { kind: 'no_reference', message: 'sem oráculo e sem juiz configurado' } });
    expect(agentStageProvenance([{ ...base, path: 'cancelled', verdict: null }])).toEqual({});
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

// IMPL-034: a saída do juiz é JSON ESTRITO com rubrica de processo coerente
// com o veredito (antes bastava {verdict, explanation}).
const RUBRICA: Record<Verdict, Record<string, string>> = {
  resolve: { resultado: 'cumpre', escopo: 'no_escopo', burla: 'nao_detectada', manipulacao: 'nao_detectada' },
  parcial: { resultado: 'parcial', escopo: 'no_escopo', burla: 'nao_detectada', manipulacao: 'nao_detectada' },
  nao: { resultado: 'nao_cumpre', escopo: 'no_escopo', burla: 'nao_detectada', manipulacao: 'nao_detectada' },
};
const JSON_OK = (v: Verdict) => ({
  text: JSON.stringify({ rubrica: RUBRICA[v], verdict: v, explanation: `juiz: ${v}` }),
});
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

  it("recusa/texto livre com 'não' NÃO vira o veredito 'nao' (sem fallback por palavra): invalid_output", async () => {
    const recusas = [
      'Desculpe, não consigo avaliar este dossiê.',
      'O agente NÃO resolve a tarefa.',
      'veredito: parcial',
      '```\nresolve\n```',
    ];
    for (const texto of recusas) {
      await comJuiz(() => ({ text: texto }), async (f) => {
        const r = await judgeDossier({ stage: STAGE, dossierText: 'diff', contestantId: 'a', judgeModelIds: ['fake/judge'], apiKey: KEY });
        expect(r.verdict, texto).toBeNull();
        expect(r.judgeError?.kind, texto).toBe('invalid_output');
        expect(f.chatRequests(), texto).toHaveLength(1 + AGENT_JUDGE_RETRIES);
      });
    }
    // IMPL-034 (schema estrito): só JSON puro ou UMA cerca envolvendo a resposta
    // INTEIRA. Antes, prosa + cerca ("Segue: ```json…```") era recortada e aceita
    // — o mesmo recorte tolerante que deixava passar JSON "sugerido" por injeção.
    const puro = JSON.stringify({ rubrica: RUBRICA.nao, verdict: 'nao', explanation: 'x' });
    await comJuiz(() => ({ text: '```json\n' + puro + '\n```' }), async () => {
      const r = await judgeDossier({ stage: STAGE, dossierText: 'diff', contestantId: 'a', judgeModelIds: ['fake/judge'], apiKey: KEY });
      expect(r).toMatchObject({ verdict: 'nao', attempts: 1 });
    });
    await comJuiz(() => ({ text: 'Segue:\n```json\n' + puro + '\n```' }), async () => {
      const r = await judgeDossier({ stage: STAGE, dossierText: 'diff', contestantId: 'a', judgeModelIds: ['fake/judge'], apiKey: KEY });
      expect(r.verdict).toBeNull();
      expect(r.judgeError?.kind).toBe('invalid_output');
    });
  });

  it('dossiê vazio / sem juiz ⇒ skipped (0 chamadas), SEM judgeError — não infla a contagem de falhas', async () => {
    await comJuiz(() => JSON_OK('resolve'), async (f) => {
      const vazio = await judgeDossier({ stage: STAGE, dossierText: '   ', contestantId: 'a', judgeModelIds: ['fake/judge'], apiKey: KEY });
      expect(vazio).toMatchObject({ verdict: null, skipped: true, attempts: 0 });
      expect(vazio.judgeError).toBeUndefined();
      const semJuiz = await judgeDossier({ stage: STAGE, dossierText: 'diff', contestantId: 'a', judgeModelIds: [], apiKey: KEY });
      expect(semJuiz).toMatchObject({ verdict: null, skipped: true });
      expect(semJuiz.judgeError).toBeUndefined();
      expect(f.chatRequests()).toHaveLength(0);
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

  it('comando ausente persistente ⇒ re-verificado às cegas 2× e o check fica FALHO: nao no denominador, 0 juiz', async () => {
    await comJuiz(() => JSON_OK('resolve'), async (f) => {
      const res = await runAgentStage(
        params({ verify: [{ cmd: 'comando-que-nao-existe-impl033', label: 'fantasma' }] }, executorFalso(['done.txt'])),
      );
      // Antes (1ª versão): verdict null, fora do denominador. Agora: check falho.
      expect(res.repResults[0]).toMatchObject({ verdict: 'nao', path: 'oracle-fail', judgeUsed: false, oracleAttempts: 3 });
      expect(res.repResults[0].oracle?.checks[0]).toMatchObject({ ok: false, notRun: 'spawn', exitCode: -1 });
      expect(res.incomplete).toBe(false);
      expect(f.chatRequests()).toHaveLength(0);
    });
  });

  it('check que PENDURA (timeout) ⇒ check falho SEM re-verificação: o código sob teste não ganha outra chance', async () => {
    await comJuiz(() => JSON_OK('resolve'), async (f) => {
      // 1ª execução: marca e dorme além do timeout. Se houvesse re-verificação,
      // a 2ª passaria (a marca existe) — exatamente o retry dependente de
      // resultado que a revisão proibiu.
      const instavel = {
        cmd: 'sh -c "if [ -f .reverificado ]; then exit 0; fi; touch .reverificado; sleep 5"',
        label: 'instável',
        timeoutMs: 300,
      };
      const t0 = Date.now();
      const res = await runAgentStage(params({ verify: [PASSA, instavel] }, executorFalso(['done.txt'])));
      expect(Date.now() - t0).toBeLessThan(4_000);
      expect(res.repResults[0]).toMatchObject({ verdict: 'parcial', path: 'oracle-partial', oracleAttempts: 1 });
      expect(res.repResults[0].oracle?.score).toBe(0.5);
      expect(res.repResults[0].oracle?.checks[1]).toMatchObject({ ok: false, notRun: 'timeout' });
      // Juiz chamado dentro da faixa: 'resolve' confinado a 'parcial'.
      expect(res.repResults[0].judgeVerdictBeforeClamp).toBe('resolve');
      expect(f.chatRequests()).toHaveLength(1);
    });
  });

  it('check que nem começou UMA vez ⇒ só ele é re-verificado (evento marca a tentativa) e decide', async () => {
    const eventos: RunEvent[] = [];
    const off = subscribe('run-impl033', (e) => eventos.push(e));
    try {
      await comJuiz(() => JSON_OK('resolve'), async () => {
        // O check 1 não existe na 1ª passada; o check 2 o cria (e conta quantas
        // vezes rodou). Só o 1 volta: o 2 roda UMA vez só.
        const tarde = { cmd: './tarde.sh', label: 'tarde' };
        const cria = {
          cmd: 'sh -c "printf \'#!/bin/sh\\nexit 0\\n\' > tarde.sh && chmod +x tarde.sh && echo x >> cria.count"',
          label: 'cria',
        };
        const task = { verify: [tarde, cria] };
        const res = await runAgentStage(params(task, executorFalso(['done.txt'])));
        const r = res.repResults[0];
        expect(r).toMatchObject({ verdict: 'resolve', path: 'oracle-pass', oracleAttempts: 2 });
        expect(r.oracle?.checks.map((c) => [c.label, c.ok, c.notRun ?? null])).toEqual([
          ['tarde', true, null],
          ['cria', true, null],
        ]);
        expect(r.oracle?.inconclusive).toBe(false);
        const verif = eventos.filter(
          (e): e is Extract<RunEvent, { type: 'agent.verified' }> => e.type === 'agent.verified' && e.execId === r.execution.execId,
        );
        expect(verif.map((e) => [e.results[0].label, e.results[0].ok, e.attempt ?? 1])).toEqual([
          ['tarde', false, 1],
          ['cria', true, 1],
          ['tarde', true, 2],
        ]);
      });
    } finally {
      off();
    }
  });

  it('desfecho já fixado (error / violação) ⇒ NÃO re-verifica (não gasta 2× o timeout à toa)', async () => {
    await comJuiz(() => JSON_OK('resolve'), async () => {
      const fantasma = { cmd: 'comando-que-nao-existe-impl033', label: 'fantasma' };
      const erro: AgentGateway = {
        ...executorFalso(['done.txt']),
        run: async (opts) => {
          writeFileSync(path.join(opts.workspaceDir, 'done.txt'), 'ok\n', 'utf8');
          return fakeOutcome('error', opts.env.PI_MODEL_ID) as never;
        },
      };
      const a = await runAgentStage(params({ verify: [fantasma] }, erro));
      expect(a.repResults[0]).toMatchObject({ verdict: 'nao', path: 'error', oracleAttempts: 1 });
      const b = await runAgentStage(
        params({ verify: [fantasma], forbiddenPaths: ['done.txt'] }, executorFalso(['done.txt'])),
      );
      expect(b.repResults[0]).toMatchObject({ verdict: 'nao', path: 'oracle-violation', oracleAttempts: 1 });
    });
  });

  it("recusa do juiz ('não consigo avaliar') com oráculo 100% ⇒ 'resolve' preservado + judgeError invalid_output", async () => {
    await comJuiz(() => ({ text: 'Desculpe, não consigo avaliar este dossiê.' }), async () => {
      const res = await runAgentStage(params({ verify: [PASSA] }, executorFalso(['done.txt'])));
      expect(res.repResults[0]).toMatchObject({
        verdict: 'resolve',
        path: 'oracle-pass',
        source: 'ground-truth',
        judgeError: { kind: 'invalid_output' },
      });
    });
  });

  it('verdict.json por rep: veredito, origem, caminho, judgeError, veredito cru confinado e tentativas do oráculo', async () => {
    await comJuiz(() => JSON_OK('resolve'), async () => {
      const res = await runAgentStage(params({ verify: [PASSA, FALHA] }, executorFalso(['done.txt'])));
      const r = res.repResults[0];
      const arq = path.join(tmp, r.execution.dir, 'verdict.json');
      expect(existsSync(arq)).toBe(true);
      const v = JSON.parse(readFileSync(arq, 'utf8'));
      expect(v).toMatchObject({
        format: 'agent-verdict@1',
        verdictTreeVersion: AGENT_VERDICT_TREE_VERSION,
        execId: r.execution.execId,
        path: 'oracle-partial',
        verdict: 'parcial',
        source: 'judge',
        judgeUsed: true,
        judgeVerdictBeforeClamp: 'resolve',
        oracle: { score: 0.5, attempts: 1, notRun: [] },
      });
      // Legível pela mesma API de artefatos da CLI/UI (allowlist do store).
      expect(await readArtifact(r.execution, 'verdict.json')).toContain('agent-verdict@1');
    });
    await comJuiz(() => HTTP_400, async () => {
      const res = await runAgentStage(params({ verify: [PASSA] }, executorFalso(['done.txt'])));
      const v = JSON.parse(readFileSync(path.join(tmp, res.repResults[0].execution.dir, 'verdict.json'), 'utf8'));
      expect(v).toMatchObject({ verdict: 'resolve', source: 'ground-truth', judgeError: { kind: 'judge_failed' } });
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
    fake.apaga = () => [];
  });

  it('juiz sempre falha: notas = oráculo (judge-score 100, não 50), agentJudgeErrorCount = execuções', async () => {
    await comJuiz(() => HTTP_400, async (f) => {
      const rec = await runToCompletion(configAgente([{ verify: [PASSA] }, { verify: [PASSA] }, { verify: [PASSA] }]), KEY, {});
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.agentVerdictTreeVersion).toBe(AGENT_VERDICT_TREE_VERSION);
      for (const s of rec.stages) {
        expect(s.referenceJudge!.verdictByContestant).toEqual({ 'fake/a': 'resolve', 'fake/b': 'resolve' });
        expect(s.referenceJudge!.judgeErrorByContestant).toEqual({ 'fake/a': 1, 'fake/b': 1 });
        // Nomes do CONVENTIONS §2: a nota veio do oráculo (o juiz caiu).
        expect(s.referenceJudge!.verdictSourceByContestant).toEqual({ 'fake/a': 'ground-truth', 'fake/b': 'ground-truth' });
        expect(s.referenceJudge!.verdictErrorByContestant).toBeUndefined();
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
        // Motivo da ausência nos nomes do CONVENTIONS §2 (consumidores do IMPL-004).
        expect(s.referenceJudge!.verdictErrorByContestant).toMatchObject({
          'fake/a': { kind: 'judge_failed' },
          'fake/b': { kind: 'judge_failed' },
        });
        expect(s.judge!.rankedContestantIds).toEqual([]);
      }
      expect(rec.agentJudgeErrorCount).toBe(4);
      expect(rec.agentUnscoredRepsByContestant).toEqual({ 'fake/a': 2, 'fake/b': 2 });
      expect(resumoNdjson(rec)).toMatchObject({ judgeErrors: 4, unscoredReps: 4 });
    });
  });

  // ---- Revisão: verificador que não terminou NÃO pode inverter o ranking ----

  it('agente cujo código PENDURA o check × agente que falha limpo: mesma nota (sem inversão; nada sai do denominador)', async () => {
    // Reprodução da revisão: antes, fake/a (pendura) ficava com judge-score 100
    // e resolveRate 1.0 e fake/b (falha limpo) com 75 e 0.5.
    fake.escreve = (q, m) =>
      m === 'fake/a' && q.startsWith('tarefa 0') ? ['done.txt', { path: 'hang.sh', content: 'sleep 5\n' }] : ['done.txt'];
    await comJuiz(() => JSON_OK('resolve'), async () => {
      const suite = { cmd: 'sh hang.sh', label: 'suite', timeoutMs: 300 };
      const rec = await runToCompletion(configAgente([{ verify: [PASSA, suite] }, { verify: [PASSA] }]), KEY, {});
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.stages.every((s) => !s.error && !s.incomplete)).toBe(true);
      expect(rec.stages[0].referenceJudge!.verdictByContestant).toEqual({ 'fake/a': 'parcial', 'fake/b': 'parcial' });
      expect(rec.stages[1].referenceJudge!.verdictByContestant).toEqual({ 'fake/a': 'resolve', 'fake/b': 'resolve' });
      expect(rec.judgeScoreByContestant).toEqual({ 'fake/a': 75, 'fake/b': 75 });
      expect(rec.resolveRateByContestant).toEqual({ 'fake/a': 0.5, 'fake/b': 0.5 });
      expect(rec.agentUnscoredRepsByContestant).toEqual({});
      // Vetor da significância: idêntico dos dois lados (nenhuma etapa some de um só).
      const par = pairedStageScores(rec, 'fake/a', 'fake/b');
      expect(par.controlScores).toEqual(par.championScores);
      expect(rec.stages[0].referenceJudge!.verdictSourceByContestant).toEqual({ 'fake/a': 'judge', 'fake/b': 'judge' });
    });
  });

  it('comando do verificador ausente em TODAS as execuções ⇒ etapa inválida para TODOS (error), fora do placar de todos', async () => {
    await comJuiz(() => JSON_OK('resolve'), async () => {
      const fantasma = { cmd: 'comando-que-nao-existe-impl033', label: 'suite' };
      const rec = await runToCompletion(configAgente([{ verify: [PASSA, fantasma] }, { verify: [PASSA] }]), KEY, {});
      expect(rec.status, rec.error).toBe('finished');
      const inval = rec.stages[0];
      expect(inval.error).toMatch(/inválida para TODOS/);
      expect(inval.error).toContain('suite');
      expect(inval.referenceJudge).toBeUndefined();
      expect(inval.judge).toBeUndefined();
      expect(inval.incomplete).toBeFalsy();
      // Só a etapa válida conta — igual para os dois.
      expect(rec.stages[1].referenceJudge!.verdictByContestant).toEqual({ 'fake/a': 'resolve', 'fake/b': 'resolve' });
      expect(rec.judgeScoreByContestant).toEqual({ 'fake/a': 100, 'fake/b': 100 });
      expect(rec.resolveRateByContestant).toEqual({ 'fake/a': 1, 'fake/b': 1 });
      // A etapa inválida não soma contagem de rep (ela não vale para ninguém).
      expect(rec.agentUnscoredRepsByContestant).toEqual({});
      expect(rec.agentJudgeErrorCount).toBe(0);
      const par = pairedStageScores(rec, 'fake/a', 'fake/b');
      expect(par.controlScores).toEqual(par.championScores);
    });
  });

  it('agente APAGA o script do verificador (os outros o rodam) ⇒ culpa do agente: check falho, nao; etapa válida', async () => {
    const fixture = path.join(tmp, 'run_tests.fixture.sh');
    writeFileSync(fixture, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(fixture, 0o755);
    fake.apaga = (_q, m) => (m === 'fake/a' ? ['run_tests.sh'] : []);
    await comJuiz(() => JSON_OK('resolve'), async () => {
      const task: AgentTaskSpec = {
        setup: [{ cmd: `cp ${fixture} run_tests.sh` }],
        verify: [{ cmd: './run_tests.sh', label: 'suite' }],
      };
      const rec = await runToCompletion(configAgente([task]), KEY, {});
      expect(rec.status, rec.error).toBe('finished');
      const s = rec.stages[0];
      expect(s.error).toBeUndefined();
      expect(s.referenceJudge!.verdictByContestant).toEqual({ 'fake/a': 'nao', 'fake/b': 'resolve' });
      expect(s.referenceJudge!.verdictSourceByContestant).toEqual({ 'fake/a': 'ground-truth', 'fake/b': 'judge' });
      expect(rec.judgeScoreByContestant).toEqual({ 'fake/a': 0, 'fake/b': 100 });
      expect(rec.agentUnscoredRepsByContestant).toEqual({});
      const exA = s.responses.find((r) => r.contestantId === 'fake/a')!.execution!;
      const v = JSON.parse(readFileSync(path.join(tmp, exA.dir, 'verdict.json'), 'utf8'));
      expect(v).toMatchObject({ verdict: 'nao', path: 'oracle-fail', oracle: { attempts: 3, notRun: [{ label: 'suite', cause: 'spawn' }] } });
    });
  });
});
