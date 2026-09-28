// IMPL-098 (R-14c:REC-2) — `agent-task@2` + compilador Harbor.
//
// O defeito: o formato era `arena-agent-config@1` — sem `solution` não há
// pass-after validável, sem `regression[]` não há transição esperada
// (PASS_TO_PASS) e os arquivos de teste ficavam no workspace DURANTE a execução
// do agente (o agente entregava o próprio teste adulterado). Aqui:
//
//   1. schema Zod valida os campos novos e REJEITA `solution` ausente em modo
//      validate (e chave desconhecida — fail-closed, IMPL-093);
//   2. compilação agentTask → árvore Harbor (`task.toml`/`instruction.md`/
//      `environment/`/`solution/`/`tests/`) com reward.json: score local ==
//      reward.json em ≥3 fixtures (tolerância 1e-9);
//   3. isolamento: `tests/` ausente do workspace durante a execução do agente;
//   4. perda de campos canônicos na compilação = 0 (round-trip arquivo→arquivo,
//      leitura POR ARQUIVO — sem API Python).
//
// Sem rede, sem LLM e sem Docker: git/sh locais + o MESMO `runOracle` da run.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AGENT_TASK_FORMAT_V2,
  parseAgentTaskSpec,
} from '../src/agent/taskSchema.js';
import {
  compileAgentTaskToHarbor,
  HARBOR_REWARD_FORMAT,
  HARBOR_VERSION,
  readHarborReward,
  readHarborTask,
} from '../src/agent/harbor.js';
import { runOracle } from '../src/agent/oracle.js';
import { combinedChecks, validateAgentTask } from '../src/agent/taskValidate.js';
import type { AgentTaskSpec } from '../src/agent/types.js';

let tmp = '';
beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'pb-impl098-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIGEST = `sha256:${'a'.repeat(64)}`;

/** R1 — TUDO explicitado (incl. vírgulas/aspas em labels e tags). */
function fixtureCheia(): AgentTaskSpec {
  return {
    repo: { kind: 'git', url: 'https://exemplo.pt/repo.git', ref: 'v1.2.3', shallow: true },
    setup: [{ cmd: 'npm ci', timeoutMs: 120_000 }],
    files: [
      { path: 'seed.txt', content: 'base\n' },
      { path: 'docs/nota,com-vírgula.md', content: 'oi "aspas"\n' },
    ],
    verify: [
      { cmd: 'test -f done.txt', label: 'done, com "aspas"', expectExit: 0, timeoutMs: 30_000, weight: 2, kind: 'fail_to_pass', critical: true },
    ],
    regression: [{ cmd: 'test -f seed.txt', label: 'regressão', weight: 0.5 }],
    solution: { kind: 'script', script: 'printf ok > done.txt' },
    testsDir: 'suites',
    env: { digest: DIGEST, path: '/abs/lockfile.json' },
    metadata: { origin: 'minerado --from-commit', commit: 'abc123', difficulty: 'hard', tags: ['pt-br', 'a,b', 'com,aspas,"x"'], canary: true },
    forbiddenPaths: ['tests/**', 'run_tests.sh'],
    rebuild: { cmd: 'npm ci --omit=dev', lockfiles: ['package-lock.json'], protect: ['node_modules/**'], timeoutMs: 90_000 },
    detectors: 'fail',
    contextFiles: true,
    limits: { maxTurns: 40, maxCostUsd: 0.5, timeoutMs: 600_000, maxOutputBytes: 1_000_000, maxDiffBytes: 200_000 },
  };
}

/** R2 — mínima: solution por diff, `contextFiles: false`, `detectors: 'off'`. */
function fixtureDiff(): AgentTaskSpec {
  return {
    verify: [{ cmd: 'test -f x.txt', label: 'x' }],
    solution: {
      kind: 'diff',
      diff: '--- a/x.txt\n+++ b/x.txt\n@@ -0,0 +1 @@\n+criado pela solution\n',
    },
    detectors: 'off',
    contextFiles: false,
  };
}

/** R3 — sem `verify` (só regression), repo por caminho local, metadata/env parciais. */
function fixtureSoRegressao(): AgentTaskSpec {
  return {
    repo: { kind: 'git', path: '/abs/repo-local', ref: 'main' },
    setup: [{ cmd: 'make deps' }],
    regression: [{ cmd: 'test -f seed.txt', label: 'seed-vivo' }],
    solution: { kind: 'script', script: 'true' },
    env: { digest: DIGEST },
    metadata: { origin: 'manual' },
    limits: { maxTurns: 5 },
  };
}

/**
 * Fixtures de IGUALDADE DE REWARD: o `tests/test.sh` gerado tem de pontuar
 * exatamente como o oráculo local (`scoreChecks`) — score parcial nomeado.
 *   A) F2P ponderado parcial (só o peso 2 passa) → 2/3;
 *   B) F2P parcial + P2P verde → 1/2;
 *   C) P2P QUEBRADO ⇒ 0 (a "solução" que conserta e quebra o resto).
 */
const REWARD_FIXTURES: { nome: string; task: AgentTaskSpec; esperado: number }[] = [
  {
    nome: 'A) F2P ponderado parcial (2 de 3 pesos)',
    esperado: 2 / 3,
    task: {
      verify: [
        { cmd: 'test -f a.txt', label: 'a', weight: 2 },
        { cmd: 'test -f b.txt', label: 'b', weight: 1 },
      ],
      solution: { kind: 'script', script: 'printf ok > a.txt' },
    },
  },
  {
    nome: 'B) F2P parcial + P2P verde',
    esperado: 1 / 2,
    task: {
      files: [{ path: 'seed.txt', content: 'x\n' }],
      verify: [
        { cmd: 'test -f a.txt', label: 'a' },
        { cmd: 'test -f b.txt', label: 'b' },
      ],
      regression: [{ cmd: 'test -f seed.txt', label: 'seed-vivo' }],
      solution: { kind: 'script', script: 'printf ok > a.txt' },
    },
  },
  {
    nome: 'C) P2P quebrado zera a nota',
    esperado: 0,
    task: {
      files: [{ path: 'seed.txt', content: 'x\n' }],
      verify: [{ cmd: 'test -f a.txt', label: 'a' }],
      regression: [{ cmd: 'test -f seed.txt', label: 'seed-vivo' }],
      solution: { kind: 'script', script: 'printf ok > a.txt\nrm -f seed.txt' },
    },
  },
];

// ---------------------------------------------------------------------------
// 1. Schema Zod (agent-task@2, mantendo leitura do @1)
// ---------------------------------------------------------------------------

describe('IMPL-098 — schema agent-task@2: campos novos validados, @1 legível', () => {
  it('marca o formato @2 e aceita solution/regression/testsDir/env.digest/metadata', () => {
    expect(AGENT_TASK_FORMAT_V2).toBe('arena-agent-config@2');
    const r = parseAgentTaskSpec(fixtureCheia(), { mode: 'validate' });
    expect(r.ok, r.ok ? '' : JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.task.solution).toEqual({ kind: 'script', script: 'printf ok > done.txt' });
    expect(r.task.regression).toHaveLength(1);
    expect(r.task.testsDir).toBe('suites');
    expect(r.task.env?.digest).toBe(DIGEST);
    expect(r.task.metadata?.difficulty).toBe('hard');
  });

  it('modo validate REJEITA `solution` ausente; modo run aceita (compat @1)', () => {
    const v1: AgentTaskSpec = {
      verify: [{ cmd: 'test -f done.txt', label: 'done' }],
    };
    const validate = parseAgentTaskSpec(v1, { mode: 'validate' });
    expect(validate.ok).toBe(false);
    if (validate.ok) return;
    expect(validate.errors.join(' ')).toContain('solution');
    // @1 continua legível em modo run (uma run pode testar sem golden).
    const run = parseAgentTaskSpec(v1, { mode: 'run' });
    expect(run.ok).toBe(true);
  });

  it('env: digest malformado é rejeitado; `sha256:<hex>` e `<ref>@sha256:<hex>` aceites; path relativo rejeitado', () => {
    const base = { verify: [{ cmd: 'true' }], solution: { kind: 'script' as const, script: 'true' } };
    const digestsOk = [DIGEST, `node:22@${DIGEST}`];
    for (const digest of digestsOk) {
      const r = parseAgentTaskSpec({ ...base, env: { digest } }, { mode: 'validate' });
      expect(r.ok, `digest ${digest} devia passar`).toBe(true);
    }
    for (const digest of ['sha256:curto', 'md5:abc', '']) {
      const r = parseAgentTaskSpec({ ...base, env: { digest } }, { mode: 'validate' });
      expect(r.ok, `digest ${digest} devia falhar`).toBe(false);
    }
    const relativo = parseAgentTaskSpec({ ...base, env: { digest: DIGEST, path: 'locks/pkg.json' } }, { mode: 'validate' });
    expect(relativo.ok).toBe(false); // path relativo muda de significado com o cwd
    const absoluto = parseAgentTaskSpec({ ...base, env: { digest: DIGEST, path: '/abs/locks/pkg.json' } }, { mode: 'validate' });
    expect(absoluto.ok).toBe(true);
  });

  it('testsDir absoluto é rejeitado; relativo à configuração é aceite', () => {
    const base = { verify: [{ cmd: 'true' }], solution: { kind: 'script' as const, script: 'true' } };
    expect(parseAgentTaskSpec({ ...base, testsDir: '/abs/suites' }, { mode: 'validate' }).ok).toBe(false);
    expect(parseAgentTaskSpec({ ...base, testsDir: 'suites' }, { mode: 'validate' }).ok).toBe(true);
  });

  it('chave desconhecida é ERRO (fail-closed) — typo não é engolido em silêncio', () => {
    const comTypo = {
      verify: [{ cmd: 'true', critcal: true }], // typo no check
      soluction: { kind: 'script', script: 'true' }, // typo na solution
    };
    const r = parseAgentTaskSpec(comTypo, { mode: 'run' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('critcal');
  });

  it('100% das fixtures válidas passam, 0 falsos rejeitos (as 3 canônicas)', () => {
    for (const task of [fixtureCheia(), fixtureDiff(), fixtureSoRegressao()]) {
      const r = parseAgentTaskSpec(task, { mode: 'validate' });
      expect(r.ok, r.ok ? '' : JSON.stringify(r)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Compilador Harbor: árvore pinada, perda canônica 0, reward igual ao local
// ---------------------------------------------------------------------------

const INSTRUCTION = 'Crie done.txt com o conteúdo ok.';

function compila(task: AgentTaskSpec, nome = 'tarefa'): string {
  const outDir = mkdtempSync(path.join(tmp, 'harbor-'));
  const res = compileAgentTaskToHarbor(task, { outDir, instruction: INSTRUCTION, name: nome });
  expect(res.files).toContain('task.toml');
  expect(res.files).toContain('instruction.md');
  expect(res.files).toContain('environment/Dockerfile');
  expect(res.files).toContain('solution/solve.sh');
  expect(res.files).toContain('tests/test.sh');
  return outDir;
}

describe('IMPL-098 — compilador agentTask → layout Harbor (perda canônica 0)', () => {
  it('a versão do Harbor está PINADA e escrita no task.toml', () => {
    const outDir = compila(fixtureCheia());
    expect(HARBOR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const toml = readFileSync(path.join(outDir, 'task.toml'), 'utf8');
    expect(toml).toContain(`harbor_version = ${JSON.stringify(HARBOR_VERSION)}`);
  });

  it('round-trip compile→readHarborTask preserva TUDO o que o task declara (3 fixtures, perda 0)', () => {
    for (const task of [fixtureCheia(), fixtureDiff(), fixtureSoRegressao()]) {
      const outDir = compila(task);
      const volta = readHarborTask(outDir);
      expect(volta.task, 'task reconstruído').toEqual(task);
      expect(volta.instruction).toBe(INSTRUCTION);
    }
  });

  it('leitura de artefatos POR ARQUIVO (sem API Python): reward.json com formato errado é rejeitado', () => {
    const dir = mkdtempSync(path.join(tmp, 'reward-'));
    writeFileSync(path.join(dir, 'reward.json'), JSON.stringify({ format: 'outro', score: 1 }), 'utf8');
    expect(() => readHarborReward(dir)).toThrow(/formato inesperado/);
    writeFileSync(
      path.join(dir, 'reward.json'),
      JSON.stringify({ format: HARBOR_REWARD_FORMAT, score: 1, checks: {}, f2p: { passed: 0, total: 0 }, p2p: { passed: 0, total: 0, broken: false } }),
      'utf8',
    );
    expect(readHarborReward(dir).format).toBe(HARBOR_REWARD_FORMAT);
  });

  it('igualdade de reward: score local == reward.json do tests/test.sh (≥3 fixtures, tolerância 1e-9)', async () => {
    for (const { nome, task, esperado } of REWARD_FIXTURES) {
      // Workspace com a solution APLICADA — o estado que o `tests/test.sh` do
      // Harbor enxerga depois do agente (tests/ materializado DEPOIS dele).
      const ws = mkdtempSync(path.join(tmp, 'ws-'));
      for (const f of task.files ?? []) {
        mkdirSync(path.dirname(path.join(ws, f.path)), { recursive: true });
        writeFileSync(path.join(ws, f.path), f.content, 'utf8');
      }
      const sol = spawnSync('sh', ['-c', task.solution!.kind === 'script' ? task.solution!.script : 'true'], { cwd: ws });
      expect(sol.status, `solution aplicada (${nome})`).toBe(0);

      // (a) score LOCAL — o MESMO runOracle da run.
      const local = await runOracle({ workspaceDir: ws, verify: combinedChecks(task) });
      expect(local.score, `score local (${nome})`).toBeCloseTo(esperado, 12);

      // (b) o `tests/test.sh` gerado, na mesma árvore, com tests/ DEPOIS.
      const outDir = compila(task, nome);
      cpSync(path.join(outDir, 'tests'), path.join(ws, 'tests'), { recursive: true });
      const run = spawnSync('sh', ['tests/test.sh'], { cwd: ws, encoding: 'utf8' });
      expect(run.status, `tests/test.sh rodou (${nome}): ${run.stderr}`).toBe(0);

      // (c) reward.json lido POR ARQUIVO == score local (tolerância 1e-9).
      const reward = readHarborReward(ws);
      expect(reward.format).toBe(HARBOR_REWARD_FORMAT);
      expect(Math.abs(reward.score - local.score), `reward × local (${nome})`).toBeLessThan(1e-9);
      // Score parcial nomeado: cada check com o mesmo 1.0/0.0 do oráculo.
      const localChecks = Object.fromEntries(local.checks.map((c) => [c.label ?? c.cmd, c.ok ? 1 : 0]));
      expect(reward.checks, `checks nomeados (${nome})`).toEqual(localChecks);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Isolamento: `tests/` só chega DEPOIS do agente (padrão Harbor/SWE-bench)
// ---------------------------------------------------------------------------

describe('IMPL-098 — isolamento do testsDir', () => {
  it('tests/ ausente do workspace durante a execução do agente (solution reprovasse visse o teste)', async () => {
    const base = mkdtempSync(path.join(tmp, 'isol-'));
    mkdirSync(path.join(base, 'suites'), { recursive: true });
    writeFileSync(path.join(base, 'suites', 'segredo.sh'), '#!/bin/sh\ntest -f done.txt\n', 'utf8');
    const task: AgentTaskSpec = {
      testsDir: 'suites',
      verify: [{ cmd: 'sh segredo.sh', label: 'suite' }],
      // O "agente" (solution) FALHA se enxergar o material de teste — se o
      // testsDir chegasse antes dele, o pass-after reprovaria e este teste
      // ficaria vermelho. Depois dele, o oráculo o materializa e o check roda.
      solution: {
        kind: 'script',
        script: 'if [ -e segredo.sh ]; then echo "teste visível durante o agente" >&2; exit 1; fi\nprintf ok > done.txt',
      },
    };
    const r = await validateAgentTask(task, { baseDir: base });
    expect(r.errors).toEqual([]);
    expect(r.status).toBe('ok');
    expect(r.checks.find((c) => c.id === 'pass-after')?.state).toBe('ok');
    expect(r.includedInStandings).toBe(true);
  });
});