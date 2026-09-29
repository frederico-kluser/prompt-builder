// ----------------------------------------------------------------------------
// `validateAgentTask` (IMPL-097) — as 6 checagens BLOQUEANTES de uma tarefa de
// agente. Roda SÓ em `agents task validate`/`task new`, NUNCA durante uma run.
//
// Porquê: hoje uma tarefa com solução que não passa, testes frágeis ou checks
// que falham já na semente entra na run e vira nota sem qualquer validação (o
// SWE-bench Verified descartou 68,3% das tarefas na revisão; 5,3% das
// "resolvidas" não resolviam a issue). Sem estas barreiras, o placar mede o
// DEFEITO da tarefa, não o desempenho do agente.
//
// As 6 checagens (uma falha ⇒ a tarefa não entra no placar):
//   1. build .......... `setup[]` constrói o ambiente (falha = tarefa inútil);
//   2. fail-before .... execução SEMENTE (Nop) com soma dos pesos = 0 — checks
//                       `critical` bloqueiam sozinhos (passaram sem solução);
//   3. pass-after ..... a `solution` atinge score 1 (checks critical incluídos);
//   4. flakiness ...... 3 reexecuções da solution com veredito IDÊNTICO —
//                       divergência ⇒ status `unstable`, FORA do placar;
//   5. trivialidade ... o agente nulo (diff vazio) NÃO passa;
//   6. oráculo fraco .. a solution MUTADA (corpo comentado / patch invertido)
//                       NÃO passa — um oráculo que o mutante passa é fraco.
//
// Onde roda: workspace git preparado como em execução (workspace.ts), comandos
// pelo `CommandRunner` (host explícito por default — sem Docker aqui; quem pede
// sandbox passa o runner). O score é o MESMO do oráculo de execução
// (`runOracle`): validar com uma régua diferente da run seria teatro.
// ----------------------------------------------------------------------------
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runOracle } from './oracle.js';
import { hostCommandRunner, removeTreeBestEffort, writeFileNoFollow, type CommandRunner } from './sandboxExec.js';
import { createWorkspaceManager, splitCommandLine, type PreparedWorkspace } from './workspace.js';
import type { AgentTaskCheck, AgentTaskSolution, AgentTaskSpec, OracleResult } from './types.js';

/** As 6 checagens, na ordem canônica do relatório. */
export const TASK_VALIDATION_CHECKS = [
  'build',
  'fail-before',
  'pass-after',
  'flakiness',
  'trivialidade',
  'oracle-fraco',
] as const;
export type TaskValidationCheckId = (typeof TASK_VALIDATION_CHECKS)[number];

/**
 * `ok` = passou; `fail` = bloqueou; `skip` = não avaliado (uma checagem
 * anterior bloqueou — build é pré-requisito de tudo).
 */
export type TaskValidationCheckState = 'ok' | 'fail' | 'skip';

export interface TaskValidationCheckResult {
  id: TaskValidationCheckId;
  state: TaskValidationCheckState;
  /** Porquê, em PT-BR — é o que o autor da tarefa lê para corrigir. */
  detail: string;
  /** Scores do oráculo observados nesta checagem (auditoria). */
  scores?: number[];
  /** Repetições executadas (flakiness). */
  runs?: number;
}

/** `unstable` = flakiness divergiu (FORA do placar); `invalid` = qualquer outra falha. */
export type TaskValidationStatus = 'ok' | 'unstable' | 'invalid';

export interface TaskValidationReport {
  format: 'agent-task-validation@1';
  status: TaskValidationStatus;
  checks: TaskValidationCheckResult[];
  /** Só `ok` entra no placar (IMPL-097: `unstable` fica de fora). */
  includedInStandings: boolean;
  /** Erros estruturais (schema, ambiente) — separados das checagens. */
  errors: string[];
}

export interface TaskValidationOptions {
  /** Runner dos comandos (default: host explícito, sem isolamento). */
  runner?: CommandRunner;
  /** Repetições da solution no teste de flakiness (default 3 — o mínimo). */
  repetitions?: number;
  /** Timeout default dos checks, ms (default 60_000 como o oráculo). */
  defaultTimeoutMs?: number;
  /**
   * Base dos caminhos relativos (`testsDir`) — o diretório da configuração.
   * Default: o cwd.
   */
  baseDir?: string;
  /** Raiz de trabalho (default: mkdtemp) — apagada no fim. */
  workDir?: string;
}

/** Veredito de UMA execução da solution — o que a flakiness compara. */
function verdictOf(oracle: OracleResult): string {
  if (oracle.violations.length > 0) return 'nao';
  if (oracle.score >= 1) return 'resolve';
  if (oracle.score <= 0) return 'nao';
  return 'parcial';
}

/** Aplica a solução de referência no workspace. `ok: false` = não aplicou. */
async function applySolution(
  solution: AgentTaskSolution,
  workspaceDir: string,
  runner: CommandRunner,
): Promise<{ ok: boolean; detail: string }> {
  if (solution.kind === 'script') {
    // O `script` da solução é SHELL por definição (como o solve.sh do Harbor).
    const out = await runner.exec({ argv: ['sh', '-c', solution.script], cwd: workspaceDir, timeoutMs: 60_000 });
    return out.code === 0
      ? { ok: true, detail: 'script da solution aplicado' }
      : { ok: false, detail: `script da solution falhou (exit ${out.code ?? out.signal})` };
  }
  // kind 'diff': patch unificado via `git apply`.
  const patchName = '.pb-task-validate.patch';
  writeFileNoFollow(workspaceDir, patchName, solution.diff);
  try {
    const out = await runner.exec({
      argv: ['git', 'apply', '--whitespace=nowarn', patchName],
      cwd: workspaceDir,
      timeoutMs: 60_000,
    });
    return out.code === 0
      ? { ok: true, detail: 'diff da solution aplicado' }
      : { ok: false, detail: `git apply do diff da solution falhou (exit ${out.code ?? out.signal})` };
  } finally {
    rmSync(path.join(workspaceDir, patchName), { force: true });
  }
}

/**
 * Muta a solução (IMPL-097, checagem 6): o "agente trapaceiro" que copia a
 * solution sem consertar nada. Script ⇒ corpo comentado; diff ⇒ patch invertido.
 * A mutação tem de ser barata e SEMPRE pior que a solution original.
 */
export function mutateSolution(solution: AgentTaskSolution): AgentTaskSolution {
  if (solution.kind === 'script') {
    const commented = solution.script
      .split('\n')
      .map((line) => (line.trim() === '' || line.trim().startsWith('#') ? line : `# ${line}`))
      .join('\n');
    return { kind: 'script', script: commented };
  }
  const inverted = solution.diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('+') && !line.startsWith('+++')) return `-${line.slice(1)}`;
      if (line.startsWith('-') && !line.startsWith('---')) return `+${line.slice(1)}`;
      return line;
    })
    .join('\n');
  return { kind: 'diff', diff: inverted };
}

/** Volta ao estado semente: tracked restaurado + untracked removido (deps ignoradas sobrevivem). */
async function resetToSeed(workspaceDir: string, seedCommit: string, runner: CommandRunner): Promise<void> {
  await runner.exec({ argv: ['git', 'reset', '--hard', seedCommit], cwd: workspaceDir, timeoutMs: 60_000 });
  await runner.exec({ argv: ['git', 'clean', '-fd'], cwd: workspaceDir, timeoutMs: 60_000 });
}

/**
 * IMPL-098 — resolve o `testsDir` de uma tarefa. Relativo = ao diretório da
 * configuração (`baseDir`) e SEM sair dele (`../` recusado: o material de teste
 * vai para o verificador e entra no hash do portão — um `testsDir` que escapa
 * levaria qualquer arquivo da máquina junto). Absoluto só chega aqui já
 * resolvido pelo CLI (o schema do arquivo recusa absoluto).
 */
export function resolveTestsDir(testsDir: string, baseDir: string): string {
  if (path.isAbsolute(testsDir)) return path.resolve(testsDir);
  const base = path.resolve(baseDir);
  const abs = path.resolve(base, testsDir);
  const fora = (from: string, to: string): boolean => {
    const rel = path.relative(from, to);
    return rel.startsWith('..') || path.isAbsolute(rel);
  };
  if (fora(base, abs)) throw new Error(`testsDir "${testsDir}" sai do diretório da configuração`);
  // Contenção também por REALPATH: um symlink `suites` apontando para fora (a
  // pasta de chaves do usuário, por exemplo) passaria na régua lexical e levaria
  // arquivos de fora para o verificador (e para o dossiê).
  let real: string | undefined;
  try {
    real = realpathSync(abs);
  } catch {
    real = undefined; // ainda não existe: quem chama confere a existência
  }
  if (real !== undefined && fora(realpathSync(base), real)) {
    throw new Error(`testsDir "${testsDir}" aponta (symlink) para fora do diretório da configuração`);
  }
  return abs;
}

/**
 * Arquivos REGULARES de um `testsDir` (recursivo, caminhos relativos, ordem
 * estável). Symlink não é seguido nem copiado. É o MESMO walk da cópia
 * (`materializeTestsDir`) e do manifesto do portão de config executável — o que
 * foi aprovado é exatamente o que entra no verificador.
 */
export function listTestsDirFiles(srcDir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(path.join(srcDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel === '' ? e.name : path.join(rel, e.name);
      if (e.isDirectory()) walk(childRel);
      else if (e.isFile()) out.push(childRel);
    }
  };
  walk('');
  return out;
}

/**
 * IMPL-098 — o material de `testsDir` entra no diretório de VERIFICAÇÃO
 * DEPOIS de quem o avalia (aqui a solução/nop; na run, o agente — ver
 * `runAgentStage`), nunca antes: o agente não entrega o próprio teste
 * adulterado. Devolve os caminhos copiados (relativos à raiz de destino).
 */
export function materializeTestsDir(task: AgentTaskSpec, workspaceDir: string, baseDir: string): string[] {
  if (!task.testsDir) return [];
  return copyTestsDirInto(resolveTestsDir(task.testsDir, baseDir), workspaceDir);
}

/**
 * Copia os arquivos regulares de `srcDir` (ABSOLUTO, já resolvido) para a raiz
 * de `destDir`, sem seguir symlink no destino (`writeFileNoFollow`). É o passo
 * comum da validação e da run.
 */
export function copyTestsDirInto(srcDir: string, destDir: string): string[] {
  if (!path.isAbsolute(srcDir)) throw new Error(`testsDir precisa chegar resolvido (absoluto): "${srcDir}"`);
  const copied: string[] = [];
  for (const rel of listTestsDirFiles(srcDir)) {
    writeFileNoFollow(destDir, rel, readFileSync(path.join(srcDir, rel), 'utf8'));
    copied.push(rel);
  }
  return copied;
}

/** As checagens combinadas da tarefa: `verify[]` (F2P) + `regression[]` (P2P). */
export function combinedChecks(task: AgentTaskSpec): AgentTaskCheck[] {
  return [...(task.verify ?? []), ...(task.regression ?? []).map((c) => ({ ...c, kind: 'pass_to_pass' as const }))];
}

/**
 * Roda as 6 checagens bloqueantes numa tarefa. NUNCA lança: falha estrutural
 * vira `status: 'invalid'` com `errors` — quem decide o exit é o CLI.
 */
export async function validateAgentTask(task: AgentTaskSpec, opts: TaskValidationOptions = {}): Promise<TaskValidationReport> {
  const runner = opts.runner ?? hostCommandRunner();
  const repetitions = Math.max(3, opts.repetitions ?? 3);
  const baseDir = opts.baseDir ?? process.cwd();
  const checks = combinedChecks(task);
  const results = new Map<TaskValidationCheckId, TaskValidationCheckResult>();
  const errors: string[] = [];

  const set = (r: TaskValidationCheckResult): void => {
    results.set(r.id, r);
  };
  const skipRest = (from: TaskValidationCheckId, why: string): void => {
    let seen = false;
    for (const id of TASK_VALIDATION_CHECKS) {
      if (id === from) seen = true;
      if (seen && !results.has(id)) set({ id, state: 'skip', detail: why });
    }
  };

  if (checks.length === 0) {
    errors.push('tarefa sem checks (verify/regression) — nada para validar');
  }
  if (!task.solution) {
    errors.push('tarefa sem solution (obrigatória para validação)');
  }
  if (errors.length > 0) {
    for (const id of TASK_VALIDATION_CHECKS) if (!results.has(id)) set({ id, state: 'skip', detail: 'tarefa estruturalmente inválida' });
    return report('invalid', results, errors);
  }

  const workDir = opts.workDir ?? mkdtempSync(path.join(tmpdir(), 'pb-task-validate-'));
  const ownDir = opts.workDir === undefined;
  const cacheDir = path.join(workDir, 'repo-cache');
  mkdirSync(cacheDir, { recursive: true });
  const mgr = createWorkspaceManager({ cacheDir });

  let ws: PreparedWorkspace | undefined;
  try {
    // ---- 1. build (setup[]) -------------------------------------------------
    try {
      ws = await mgr.prepare(
        { repo: task.repo, setup: task.setup, files: task.files, limits: task.limits },
        { setupRunner: () => runner },
      );
      set({
        id: 'build',
        state: 'ok',
        detail: task.setup?.length ? `setup[] construiu o ambiente (${task.setup.length} comando(s))` : 'sem setup[] — ambiente trivial pronto',
      });
    } catch (err) {
      set({ id: 'build', state: 'fail', detail: `setup[] falhou: ${(err as Error).message}` });
      skipRest('fail-before', 'build falhou — checagens dependentes não rodaram');
      return report('invalid', results, errors);
    }

    const workspaceDir = ws.workspaceDir;
    const runOracleOnce = async (): Promise<OracleResult> => {
      materializeTestsDir(task, workspaceDir, baseDir);
      return runOracle({
        workspaceDir,
        verify: checks.map((c) => ({ ...c })),
        defaultTimeoutMs: opts.defaultTimeoutMs,
        runner,
      });
    };

    // ---- 2/5. semente (Nop / agente nulo) -----------------------------------
    await resetToSeed(workspaceDir, ws.seedCommit, runner);
    const seed = await runOracleOnce();
    // Checks `critical` por ÍNDICE (o oráculo mantém a ordem do verify[]).
    const criticalSeedOk = (task.verify ?? []).map((c, i) => !c.critical || seed.checks[i]?.ok === true);
    const criticalAtSeed = (task.verify ?? []).filter((c, i) => c.critical && criticalSeedOk[i]);
    const seedScores = [seed.score];

    set({
      id: 'fail-before',
      state: seed.score === 0 && criticalAtSeed.length === 0 ? 'ok' : 'fail',
      detail:
        seed.score === 0 && criticalAtSeed.length === 0
          ? 'a semente falha todos os checks (soma dos pesos = 0)'
          : criticalAtSeed.length > 0
            ? `checks CRÍTICOS passam sem solução: ${criticalAtSeed.map((c) => labelOf(c)).join(', ')}`
            : `a semente já pontua ${seed.score} (esperado 0)`,
      scores: seedScores,
    });
    set({
      id: 'trivialidade',
      state: seed.score < 1 ? 'ok' : 'fail',
      detail:
        seed.score < 1
          ? 'o agente nulo (diff vazio) NÃO passa'
          : 'tarefa TRIVIAL: o diff vazio já atinge score 1',
      scores: seedScores,
    });

    // ---- 3/4. solution × repetitions (pass-after + flakiness) ---------------
    const runScores: number[] = [];
    const runVerdicts: string[] = [];
    const oracleRuns: (OracleResult | undefined)[] = [];
    let applyError: string | undefined;
    for (let i = 0; i < repetitions; i++) {
      await resetToSeed(workspaceDir, ws.seedCommit, runner);
      const applied = await applySolution(task.solution!, workspaceDir, runner);
      if (!applied.ok) {
        applyError = applied.detail;
        break;
      }
      const oracle = await runOracleOnce();
      oracleRuns.push(oracle);
      runScores.push(oracle.score);
      runVerdicts.push(verdictOf(oracle));
    }

    if (applyError !== undefined) {
      set({ id: 'pass-after', state: 'fail', detail: `a solution não aplica: ${applyError}`, scores: runScores });
      set({ id: 'flakiness', state: 'skip', detail: 'solution não aplica — flakiness sem execuções' });
    } else {
      const firstOracle = oracleRuns[0];
      const first = runScores[0] ?? 0;
      // Checks `critical` têm de passar TODOS na solution (bloqueiam sozinhos).
      const criticalFailing = (task.verify ?? [])
        .map((c, i) => ({ c, ok: firstOracle?.checks[i]?.ok === true }))
        .filter((x) => x.c.critical && !x.ok);
      set({
        id: 'pass-after',
        state: first >= 1 && criticalFailing.length === 0 ? 'ok' : 'fail',
        detail:
          criticalFailing.length > 0
            ? `checks CRÍTICOS falham com a solution: ${criticalFailing.map((x) => labelOf(x.c)).join(', ')}`
            : first >= 1
              ? `a solution atinge score ${first}`
              : `a solution NÃO atinge score 1 (score ${first})`,
        scores: runScores.slice(0, 1),
      });
      const divergentes = new Set(runVerdicts);
      set({
        id: 'flakiness',
        state: divergentes.size <= 1 ? 'ok' : 'fail',
        detail:
          divergentes.size <= 1
            ? `${repetitions} reexecuções com veredito idêntico (${runVerdicts[0] ?? '—'})`
            : `vereditos divergentes nas ${repetitions} reexecuções: ${runVerdicts.join(', ')} ⇒ tarefa "unstable", fora do placar`,
        scores: runScores,
        runs: runVerdicts.length,
      });
    }

    // ---- 6. oráculo fraco (solution mutada não pode passar) ----------------
    await resetToSeed(workspaceDir, ws.seedCommit, runner);
    const mutated = await applySolution(mutateSolution(task.solution!), workspaceDir, runner);
    if (!mutated.ok) {
      set({
        id: 'oracle-fraco',
        state: 'ok',
        detail: 'a solution mutada nem aplica — o oráculo rejeita o mutante',
      });
    } else {
      const oracle = await runOracleOnce();
      set({
        id: 'oracle-fraco',
        state: oracle.score < 1 ? 'ok' : 'fail',
        detail:
          oracle.score < 1
            ? 'a solution mutada NÃO passa (oráculo não é fraco)'
            : `ORÁCULO FRACO: a solution mutada atinge score ${oracle.score}`,
        scores: [oracle.score],
      });
    }

    // ---- estatuto final ----------------------------------------------------
    const ordem = TASK_VALIDATION_CHECKS.map((id) => results.get(id)!);
    const flakiness = results.get('flakiness');
    const bloqueou = ordem.some((r) => r.state === 'fail');
    const status: TaskValidationStatus = !bloqueou
      ? 'ok'
      : flakiness?.state === 'fail' && ordem.filter((r) => r.state === 'fail').every((r) => r.id === 'flakiness')
        ? 'unstable'
        : 'invalid';
    return report(status, results, errors);
  } catch (err) {
    errors.push(`falha inesperada na validação: ${(err as Error).message}`);
    for (const id of TASK_VALIDATION_CHECKS) if (!results.has(id)) set({ id, state: 'skip', detail: 'validação interrompida' });
    return report('invalid', results, errors);
  } finally {
    if (ws) await mgr.dispose(ws.cacheRepoDir, ws.workspaceDir).catch(() => undefined);
    if (ownDir) removeTreeBestEffort(workDir);
  }
}

function labelOf(check: AgentTaskCheck): string {
  return check.label ?? check.cmd;
}

function report(
  status: TaskValidationStatus,
  results: Map<TaskValidationCheckId, TaskValidationCheckResult>,
  errors: string[],
): TaskValidationReport {
  return {
    format: 'agent-task-validation@1',
    status,
    checks: TASK_VALIDATION_CHECKS.map((id) => results.get(id) ?? { id, state: 'skip', detail: 'não avaliado' }),
    includedInStandings: status === 'ok',
    errors,
  };
}
