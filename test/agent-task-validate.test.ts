// IMPL-097 (R-14c:REC-1) — as 6 checagens BLOQUEANTES de `agents task validate`.
//
// O defeito: uma tarefa com solução que não passa, testes frágeis ou checks que
// falham já na semente entrava na run e virava nota sem qualquer validação (o
// SWE-bench Verified descartou 68,3% das tarefas na revisão; 5,3% das
// "resolvidas" não resolviam a issue). Aqui cada checagem tem UM teste que
// PROVA a detecção (a fixture defeituosa é reprovada por ela) e uma fixture
// válida que passa nas 6 — nunca se afrouxa uma asserção para passar.
//
// As 6 (uma falha ⇒ a tarefa não entra no placar):
//   1. build .......... setup[] constrói o ambiente;
//   2. fail-before .... semente (Nop/diff vazio) com soma dos pesos = 0;
//   3. pass-after ..... a `solution` atinge score 1;
//   4. flakiness ...... 3 reexecuções com veredito IDÊNTICO (divergência ⇒ `unstable`);
//   5. trivialidade ... o agente nulo (diff vazio) NÃO passa;
//   6. oráculo fraco .. a solution MUTADA (corpo comentado) NÃO passa.
//
// Sem rede e sem LLM: git real, `sh` real e o MESMO `runOracle` da run.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  TASK_VALIDATION_CHECKS,
  validateAgentTask,
  type TaskValidationCheckId,
  type TaskValidationReport,
} from '../src/agent/taskValidate.js';
import type { AgentTaskSpec } from '../src/agent/types.js';
import { cmdAgents } from '../src/cli/commands/agents.js';
import { isCliError, resetOutputState, type CliError } from '../src/cli/output.js';

let tmp = '';
beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'pb-impl097-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const check = (r: TaskValidationReport, id: TaskValidationCheckId) => r.checks.find((c) => c.id === id)!;

/** Roda as 6 checagens numa tarefa (workDir próprio, apagado no fim). */
async function roda(task: AgentTaskSpec, opts: { baseDir?: string; repetitions?: number } = {}): Promise<TaskValidationReport> {
  return validateAgentTask(task, { baseDir: opts.baseDir ?? tmp, ...(opts.repetitions !== undefined ? { repetitions: opts.repetitions } : {}) });
}

// ---------------------------------------------------------------------------
// Fixtures — todas locais (sem repo: workspace vazio + files[]).
// ---------------------------------------------------------------------------

/** VÁLIDA: falha na semente, a solution resolve, determinística, mutante morre. */
function tarefaValida(): AgentTaskSpec {
  return {
    files: [{ path: 'seed.txt', content: 'base\n' }],
    verify: [
      { cmd: 'test -f done.txt', label: 'done' },
      { cmd: 'test -f done.txt', label: 'done-de-novo', weight: 2 },
    ],
    regression: [{ cmd: 'test -f seed.txt', label: 'regressão' }],
    solution: { kind: 'script', script: 'printf ok > done.txt' },
  };
}

/** BUILD: o setup[] falha — o ambiente nunca fica pronto. */
function tarefaBuildQuebrado(): AgentTaskSpec {
  return {
    ...tarefaValida(),
    setup: [{ cmd: 'exit 1' }],
  };
}

/** FAIL-BEFORE: check CRÍTICO já passa na semente (foi resolvido pelo diff vazio). */
function tarefaResolvidaNaSemente(): AgentTaskSpec {
  return {
    files: [{ path: 'seed.txt', content: 'base\n' }],
    verify: [{ cmd: 'test -f seed.txt', label: 'sempre-verde', critical: true }],
    solution: { kind: 'script', script: 'printf ok > done.txt' },
  };
}

/** PASS-AFTER: a solution de referência NÃO atinge score 1. */
function tarefaComSolutionRuim(): AgentTaskSpec {
  return {
    ...tarefaValida(),
    solution: { kind: 'script', script: 'true' },
  };
}

/**
 * FLAKINESS: a solution diverge entre execuções — um contador FORA do workspace
 * (o `resetToSeed` limpa untracked, então a alternância vive no tmp) faz a 1ª
 * execução resolver e as seguintes falharem: vereditos `resolve, nao, nao`.
 */
let contadorSeq = 0;
function tarefaFrágil(): { task: AgentTaskSpec; counter: string } {
  contadorSeq += 1;
  const counter = path.join(tmp, `contador-${contadorSeq}.txt`);
  writeFileSync(counter, '0\n', 'utf8');
  const script = [
    `n=$(cat '${counter}')`,
    `echo $((n + 1)) > '${counter}'`,
    'if [ "$n" -eq 0 ]; then printf ok > done.txt; fi',
  ].join('\n');
  return { task: { ...tarefaValida(), solution: { kind: 'script', script } }, counter };
}

/** TRIVIALIDADE: o diff vazio (agente nulo) já atinge score 1. */
function tarefaTrivial(): AgentTaskSpec {
  return {
    files: [{ path: 'seed.txt', content: 'base\n' }],
    verify: [{ cmd: 'test -f seed.txt', label: 'sempre-passa' }],
    solution: { kind: 'script', script: 'printf ok > done.txt' },
  };
}

/** ORÁCULO FRACO: a check passa em qualquer estado — o mutante também "passa". */
function tarefaComOraculoFraco(): AgentTaskSpec {
  return {
    verify: [{ cmd: 'true', label: 'fraco' }],
    solution: { kind: 'script', script: 'printf ok > done.txt' },
  };
}

// ---------------------------------------------------------------------------
// 1-6. Uma checagem por teste (a fixture defeituosa é REPROVADA por ela).
// ---------------------------------------------------------------------------

describe('IMPL-097 — as 6 checagens bloqueantes, uma por teste', () => {
  it('1. build: setup[] que falha reprova `build` e bloqueia o resto (invalid)', async () => {
    const r = await roda(tarefaBuildQuebrado());
    expect(check(r, 'build').state).toBe('fail');
    expect(check(r, 'build').detail).toContain('setup[] falhou');
    // Pré-requisito quebrado: nada dependente roda (skip honesto, não "ok" mudo).
    expect(check(r, 'fail-before').state).toBe('skip');
    expect(r.status).toBe('invalid');
    expect(r.includedInStandings).toBe(false);
  });

  it('2. fail-before: check CRÍTICO que já passa na semente bloqueia a tarefa', async () => {
    const r = await roda(tarefaResolvidaNaSemente());
    expect(check(r, 'fail-before').state).toBe('fail');
    expect(check(r, 'fail-before').detail).toContain('CRÍTICOS');
    expect(r.status).toBe('invalid');
  });

  it('3. pass-after: solution que não atinge score 1 reprova `pass-after`', async () => {
    const r = await roda(tarefaComSolutionRuim());
    expect(check(r, 'pass-after').state).toBe('fail');
    expect(check(r, 'pass-after').detail).toContain('NÃO atinge score 1');
    expect(r.status).toBe('invalid');
  });

  it('4. flakiness: 3 reexecuções com veredito divergente ⇒ `unstable` e FORA do placar', async () => {
    const { task, counter } = tarefaFrágil();
    const r = await roda(task);
    const f = check(r, 'flakiness');
    expect(f.state).toBe('fail');
    expect(f.runs).toBe(3);
    expect(f.detail).toContain('divergentes');
    // O veredito da 1ª execução resolve (é a solution de referência) — quem
    // diverge é a reexecução: a tarefa é instável, não mal-resolvida.
    expect(f.scores).toEqual([1, 0, 0]);
    expect(check(r, 'pass-after').state).toBe('ok');
    expect(r.status).toBe('unstable');
    expect(r.includedInStandings).toBe(false); // exclusão do placar
    rmSync(counter, { force: true });
  });

  it('5. trivialidade: o agente nulo (diff vazio) que passa reprova a tarefa', async () => {
    const r = await roda(tarefaTrivial());
    expect(check(r, 'trivialidade').state).toBe('fail');
    expect(check(r, 'trivialidade').detail).toContain('TRIVIAL');
    expect(r.status).toBe('invalid');
  });

  it('6. oráculo fraco: a solution MUTADA ainda passa ⇒ `oracle-fraco` reprova', async () => {
    const r = await roda(tarefaComOraculoFraco());
    expect(check(r, 'oracle-fraco').state).toBe('fail');
    expect(check(r, 'oracle-fraco').detail).toContain('ORÁCULO FRACO');
    expect(r.status).toBe('invalid');
  });

  it('fixture VÁLIDA passa nas 6 e entra no placar (0 falsos rejeitos)', async () => {
    const r = await roda(tarefaValida());
    expect(r.errors).toEqual([]);
    for (const id of TASK_VALIDATION_CHECKS) expect(check(r, id).state, `checagem ${id}`).toBe('ok');
    expect(r.status).toBe('ok');
    expect(r.includedInStandings).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Contrato do CLI: exit ≠ 0 reprova (fixture trivial / solution que não
//    passa), exit 0 só com status 'ok'; `unstable` sai com o relatório completo.
// ---------------------------------------------------------------------------

async function cliValidate(task: unknown): Promise<{ exit: number; cliErr?: CliError }> {
  resetOutputState();
  const file = path.join(tmp, `cli-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ agentTask: task }), 'utf8');
  try {
    // IMPL-099: a validação EXECUTA a tarefa — aqui o aceite explícito é
    // ortogonal ao que se testa (o portão tem contrato próprio em cli-exec-gate).
    const exit = await cmdAgents(['task', 'validate', file, '--json', '--data-dir', tmp, '--quiet', '--allow-exec-config']);
    return { exit };
  } catch (err) {
    if (!isCliError(err)) throw err;
    return { exit: (err as CliError).code, cliErr: err as CliError };
  }
}

describe('IMPL-097 — `agents task validate`: exit code do contrato', () => {
  it('fixture trivial (diff vazio resolve) ⇒ exit ≠ 0, com o relatório no envelope', async () => {
    const { exit, cliErr } = await cliValidate(tarefaTrivial());
    expect(exit).not.toBe(0);
    expect(exit).toBe(3); // config — a tarefa é que está mal
    const tasks = (cliErr?.details as { tasks: TaskValidationReport[] }).tasks;
    expect(tasks[0].includedInStandings).toBe(false);
  });

  it('fixture com solution que não passa ⇒ exit ≠ 0', async () => {
    const { exit } = await cliValidate(tarefaComSolutionRuim());
    expect(exit).not.toBe(0);
  });

  it('fixture válida ⇒ exit 0 e status ok', async () => {
    const { exit } = await cliValidate(tarefaValida());
    expect(exit).toBe(0);
  });

  it('veredito divergente em 3 reexecuções ⇒ exit ≠ 0 e `unstable` fora do placar', async () => {
    const { task, counter } = tarefaFrágil();
    const { exit, cliErr } = await cliValidate(task);
    rmSync(counter, { force: true });
    expect(exit).not.toBe(0);
    const tasks = (cliErr?.details as { tasks: (TaskValidationReport & { label: string })[] }).tasks;
    expect(tasks[0].status).toBe('unstable');
    expect(tasks[0].includedInStandings).toBe(false);
  });
});