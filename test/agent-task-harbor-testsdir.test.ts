// IMPL-098 (left#12, onda 3) — o compilador Harbor leva o MATERIAL do testsDir.
//
// Antes `compileAgentTaskToHarbor` só declarava `tests_dir` no task.toml (o
// comentário dizia "material de testsDir", mas nada era copiado): um check que
// roda um script do testsDir (`sh check.sh`) pontuava 0 no Harbor e 1 na run
// local — a igualdade de reward valia só para tarefa sem testsDir. Agora, com o
// `baseDir` da configuração, o material vai para `tests/files/` e o
// `tests/test.sh` o materializa na raiz do workspace DEPOIS do agente (a mesma
// semântica de `materializeTestsDir` da run local), substituindo o que o agente
// tenha plantado no mesmo caminho.
//
// Sem rede, sem LLM e sem Docker: sh/git locais + o MESMO `runOracle` da run.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileAgentTaskToHarbor, readHarborReward, readHarborTask } from '../src/agent/harbor.js';
import { runOracle } from '../src/agent/oracle.js';
import { combinedChecks, materializeTestsDir } from '../src/agent/taskValidate.js';
import { cmdAgents } from '../src/cli/commands/agents.js';
import { EXIT, isCliError, resetOutputState, type CliError } from '../src/cli/output.js';
import type { AgentTaskSpec } from '../src/agent/types.js';

let tmp = '';
beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'pb-harbor-testsdir-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Config com `suites/` ao lado: um script de teste e um arquivo de dados em subpasta. */
function baseComSuite(): string {
  const base = mkdtempSync(path.join(tmp, 'base-'));
  mkdirSync(path.join(base, 'suites', 'dados'), { recursive: true });
  writeFileSync(path.join(base, 'suites', 'check.sh'), '#!/bin/sh\ntest "$(cat done.txt)" = "$(cat dados/esperado.txt)"\n');
  writeFileSync(path.join(base, 'suites', 'dados', 'esperado.txt'), 'ok\n');
  return base;
}

const TAREFA = (solution: string): AgentTaskSpec => ({
  testsDir: 'suites',
  verify: [
    { cmd: 'sh check.sh', label: 'suite', weight: 2 },
    { cmd: 'test -f dados/esperado.txt', label: 'material-presente', weight: 1 },
  ],
  solution: { kind: 'script', script: solution },
});

/** Workspace com a "execução do agente" (a solution) — SEM o material. */
function workspaceDepoisDoAgente(solution: string): string {
  const ws = mkdtempSync(path.join(tmp, 'ws-'));
  const r = spawnSync('sh', ['-c', solution], { cwd: ws });
  expect(r.status).toBe(0);
  return ws;
}

async function scoreLocal(task: AgentTaskSpec, base: string, solution: string): Promise<number> {
  const ws = workspaceDepoisDoAgente(solution);
  materializeTestsDir(task, ws, base); // a run local: material DEPOIS do agente
  return (await runOracle({ workspaceDir: ws, verify: combinedChecks(task) })).score;
}

function rewardHarbor(task: AgentTaskSpec, base: string, solution: string): { score: number; checks: Record<string, number> } {
  const outDir = mkdtempSync(path.join(tmp, 'harbor-'));
  compileAgentTaskToHarbor(task, { outDir, instruction: 'Crie done.txt com ok.', baseDir: base });
  const ws = workspaceDepoisDoAgente(solution);
  cpSync(path.join(outDir, 'tests'), path.join(ws, 'tests'), { recursive: true });
  const r = spawnSync('sh', ['tests/test.sh'], { cwd: ws, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return readHarborReward(ws);
}

describe('left#12 — material do testsDir na árvore Harbor', () => {
  it('copia o material para tests/files/ (bytes exatos) e o relata em testsMaterial/files', () => {
    const base = baseComSuite();
    const outDir = mkdtempSync(path.join(tmp, 'harbor-'));
    const res = compileAgentTaskToHarbor(TAREFA('printf ok > done.txt'), { outDir, instruction: 'x', baseDir: base });
    expect(res.testsMaterial?.map((p) => p.split(path.sep).join('/')).sort()).toEqual(['check.sh', 'dados/esperado.txt']);
    expect(res.files).toEqual(expect.arrayContaining(['tests/files/check.sh', 'tests/files/dados/esperado.txt']));
    expect(readFileSync(path.join(outDir, 'tests', 'files', 'dados', 'esperado.txt'), 'utf8')).toBe('ok\n');
    // O task.toml segue declarando o testsDir: round-trip canônico intacto.
    expect(readHarborTask(outDir).task.testsDir).toBe('suites');
  });

  it('igualdade de reward COM testsDir: score local == reward.json (1e-9), por check nomeado', async () => {
    for (const [solution, esperado] of [
      ['printf "ok\\n" > done.txt', 1],
      ['printf "errado\\n" > done.txt', 1 / 3],
    ] as const) {
      const base = baseComSuite();
      const task = TAREFA(solution);
      const local = await scoreLocal(task, base, solution);
      expect(local).toBeCloseTo(esperado, 12);
      const harbor = rewardHarbor(task, base, solution);
      expect(Math.abs(harbor.score - local)).toBeLessThan(1e-9);
      expect(harbor.checks).toEqual({ suite: esperado === 1 ? 1 : 0, 'material-presente': 1 });
    }
  });

  it('o agente que PLANTA um check.sh falso no mesmo caminho não passa: o material o substitui', async () => {
    const trapaca = 'printf "errado\\n" > done.txt; printf "exit 0\\n" > check.sh';
    const base = baseComSuite();
    const task = TAREFA(trapaca);
    const local = await scoreLocal(task, base, trapaca);
    const harbor = rewardHarbor(task, base, trapaca);
    expect(local).toBeCloseTo(1 / 3, 12);
    expect(harbor.score).toBeCloseTo(local, 9);
  });

  it('sem baseDir: só o layout (testsMaterial null, tests_dir declarado); tarefa sem testsDir não muda', () => {
    const outDir = mkdtempSync(path.join(tmp, 'harbor-'));
    const res = compileAgentTaskToHarbor(TAREFA('true'), { outDir, instruction: 'x' });
    expect(res.testsMaterial).toBeNull();
    expect(existsSync(path.join(outDir, 'tests', 'files'))).toBe(false);
    const semTestsDir = compileAgentTaskToHarbor(
      { verify: [{ cmd: 'true', label: 'ok' }], solution: { kind: 'script', script: 'true' } },
      { outDir: mkdtempSync(path.join(tmp, 'harbor-')), instruction: 'x', baseDir: tmp },
    );
    expect(semTestsDir.testsMaterial).toBeNull();
  });

  it('testsDir inexistente ou que ESCAPA da configuração é erro (nada de test.sh apontando o vazio)', () => {
    const base = baseComSuite();
    const outDir = mkdtempSync(path.join(tmp, 'harbor-'));
    expect(() =>
      compileAgentTaskToHarbor({ ...TAREFA('true'), testsDir: 'nao-existe' }, { outDir, instruction: 'x', baseDir: base }),
    ).toThrow(/não encontrado/);
    expect(() =>
      compileAgentTaskToHarbor({ ...TAREFA('true'), testsDir: '../fora' }, { outDir, instruction: 'x', baseDir: base }),
    ).toThrow(/sai do diretório/);
  });
});

describe('left#12 — `agents task compile` leva o material (baseDir = dir do arquivo)', () => {
  async function compile(file: string, outDir: string): Promise<{ data?: Record<string, unknown>; err?: CliError }> {
    resetOutputState();
    const saida: string[] = [];
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      saida.push(String(c));
      return true;
    });
    const se = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await cmdAgents(['task', 'compile', file, '--out-dir', outDir, '--instruction', 'Crie done.txt com ok.', '--json']);
      return { data: (JSON.parse(saida.join('').trim().split('\n').pop()!) as { data: Record<string, unknown> }).data };
    } catch (e) {
      if (!isCliError(e)) throw e;
      return { err: e as CliError };
    } finally {
      so.mockRestore();
      se.mockRestore();
      resetOutputState();
    }
  }

  it('material copiado e relatado; testsDir ausente = exit 3 config.tests_dir_invalid', async () => {
    const base = baseComSuite();
    const file = path.join(base, 'tarefa.json');
    writeFileSync(file, JSON.stringify(TAREFA('printf ok > done.txt')));
    const outDir = path.join(base, 'saida');
    const ok = await compile(file, outDir);
    expect(ok.err, ok.err?.message).toBeUndefined();
    expect((ok.data?.testsMaterial as string[]).length).toBe(2);
    expect(existsSync(path.join(outDir, 'tests', 'files', 'check.sh'))).toBe(true);

    writeFileSync(file, JSON.stringify({ ...TAREFA('true'), testsDir: 'sumiu' }));
    const ruim = await compile(file, path.join(base, 'saida2'));
    expect(ruim.err?.code).toBe(EXIT.CONFIG);
    expect(ruim.err?.errorCode).toBe('config.tests_dir_invalid');
  });
});
