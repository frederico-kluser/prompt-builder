// ----------------------------------------------------------------------------
// Contrato das correções da revisão de IMPL-038 (R-15 REC-4):
//
// 1. Limpeza à prova de código hostil: um `verify` (ou o próprio agente) que
//    deixa diretório 0555/0000 com arquivo dentro NÃO derruba a etapa — as reps
//    seguintes rodam, o workspace e a cópia do verificador somem, o contestant
//    tem resposta e veredito.
// 2. Snapshots com índice temporário mantêm rastreado o que a referência
//    RASTREIA (arquivo commitado com `add -f` ou pasta que o agente pôs no
//    .gitignore): a alteração aparece como `M` e o `forbiddenPaths` dispara.
// 3. setup[] em sandbox recebe um `.git` próprio (o gitfile do worktree aponta
//    para um caminho do host que não existe no container).
// 4. keepWorkspace registra também o repo de auditoria, sem quebrar o
//    digests.json.
// ----------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { removeTreeBestEffort, type CommandRunner } from '../src/agent/sandboxExec.js';
import { createWorkspaceManager } from '../src/agent/workspace.js';
import { runOracle } from '../src/agent/oracle.js';
import { verifyExecutionDigests } from '../src/agent/store.js';
import {
  runAgentStage,
  type AgentGateway,
  type RunAgentStageParams,
  type StageRunners,
} from '../src/agent/runAgentStage.js';
import { createGateway, setDefaultGateway } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import type { AgentTaskSpec } from '../src/agent/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const tmps: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

let silencio: Array<{ mockRestore(): void }> = [];
beforeAll(() => {
  silencio = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
});
afterAll(() => {
  silencio.forEach((s) => s.mockRestore());
  for (const d of tmps) removeTreeBestEffort(d);
});

// Como root o chmod não barra o rm — o teste 1 passaria sem provar nada.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** Diretório `name` com um arquivo dentro, trancado em `mode`. */
function lockedDir(root: string, name: string, mode: number): void {
  const d = path.join(root, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'f'), 'x');
  chmodSync(d, mode);
}

function fakeOutcome(modelId: string) {
  const now = new Date().toISOString();
  const usage = { tokensIn: 10, tokensOut: 5, tokensReasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.001, costSource: 'agent-derived' as const };
  return {
    stopReason: 'completed' as const,
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
      stopReason: 'completed' as const,
      turns: [{ index: 0, text: 'terminei', steps: [] }],
      usage,
      parseErrors: 0,
      compactions: [],
    },
    parseErrors: 0,
    responseIds: [],
    stderrTail: '',
    exitCode: 0,
    signal: null,
  };
}

async function withJudge<T>(fn: () => Promise<T>): Promise<T> {
  const f = fakeOpenRouter({
    catalog: ['fake/a', 'fake/judge'].map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: () => ({ text: '{"verdict":"resolve","explanation":"confere"}' }),
  });
  const prev = setDefaultGateway(createGateway({ fetch: f.fetch, sleep: noSleep }));
  try {
    return await fn();
  } finally {
    setDefaultGateway(prev);
  }
}

const TASK: AgentTaskSpec = {
  files: [{ path: 'tests/expected.txt', content: 'PRISTINO\n' }],
  verify: [
    { cmd: 'test -f done.txt', label: 'done' },
    { cmd: 'grep -q PRISTINO tests/expected.txt', label: 'fixture' },
  ],
};

let seq = 0;
function stageParams(dataDir: string, gateway: AgentGateway, extra: Partial<RunAgentStageParams> = {}): RunAgentStageParams {
  return {
    runId: `run-038r-${seq}`,
    stageIndex: seq++,
    contestant: { id: 'ag', label: 'ag', modelId: 'fake/a', runner: 'agent' },
    stage: { question: 'crie done.txt', productContext: 'repo vazio', maxTokens: 200, agentTask: TASK },
    agentConfig: { executor: 'pi', executorVersion: '0.0.0-fake', limits: { maxCostUsd: 0.05 }, isolation: { kind: 'container' } },
    apiKey: 'sk-or-v1-fake',
    ctx: {},
    dataDir,
    catalog: [],
    judgeModelIds: ['fake/judge'],
    gateway,
    ...extra,
  };
}

const okResult = (code: number) => ({ code, signal: null, spawnFailed: false, timedOut: false });

function noopRunner(): CommandRunner {
  return { where: 'sandbox', isolated: true, exec: async () => okResult(0) };
}

function g(cwd: string, args: string[]) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

describe('revisão IMPL-038 — limpeza não lança', () => {
  let dataDir: string;
  let prevDir: string;
  beforeAll(() => {
    dataDir = mkTmp('pb038r-data-');
    prevDir = getDataDir();
    setDataDir(dataDir);
  });
  afterAll(() => setDataDir(prevDir));

  it('removeTreeBestEffort apaga árvore com 0555/0000 e não segue symlink', () => {
    const root = mkTmp('pb038r-rm-');
    const outside = mkTmp('pb038r-fora-');
    writeFileSync(path.join(outside, 'alvo.txt'), 'nao-apague');
    chmodSync(outside, 0o555);
    const t = path.join(root, 't');
    mkdirSync(t);
    lockedDir(t, 'ro', 0o555);
    lockedDir(t, 'zero', 0o000);
    symlinkSync(outside, path.join(t, 'link'));
    chmodSync(t, 0o500);
    expect(removeTreeBestEffort(t)).toBe(true);
    expect(existsSync(t)).toBe(false);
    // O alvo do symlink fica intacto (nem apagado, nem com permissão alterada).
    expect(readFileSync(path.join(outside, 'alvo.txt'), 'utf8')).toBe('nao-apague');
    expect(lstatSync(outside).mode & 0o777).toBe(0o555);
    chmodSync(outside, 0o755);
    expect(removeTreeBestEffort(path.join(root, 'nao-existe'))).toBe(true);
  });

  it.skipIf(isRoot)(
    'verify que deixa diretório 0555/0000 com arquivo e tranca /ws: a etapa NÃO rejeita, as 2 reps rodam e tudo é apagado',
    async () => {
      const wsDirs: string[] = [];
      const verifyDirs = new Set<string>();
      const gateway: AgentGateway = {
        id: 'pi-fake',
        prepare: async () => ({ bin: 'pi-fake', env: {} }),
        run: async (opts) => {
          wsDirs.push(opts.workspaceDir);
          writeFileSync(path.join(opts.workspaceDir, 'done.txt'), 'ok\n');
          // O agente também tranca um diretório no PRÓPRIO workspace.
          lockedDir(opts.workspaceDir, 'trancado', 0o555);
          return fakeOutcome(opts.env.PI_MODEL_ID) as never;
        },
      };
      const verifyRunner = (mountDir: string): CommandRunner => ({
        where: 'sandbox',
        isolated: true,
        exec: async (req) => {
          const ok =
            req.argv[0] === 'test'
              ? existsSync(path.join(mountDir, 'done.txt'))
              : readFileSync(path.join(mountDir, 'tests', 'expected.txt'), 'utf8') === 'PRISTINO\n';
          if (!verifyDirs.has(mountDir)) {
            verifyDirs.add(mountDir);
            // O "check" (teste de permissão benigno ou agente hostil) deixa
            // ro/f com ro 0555, zero/f com zero 0000 e dá chmod 555 em /ws.
            lockedDir(mountDir, 'ro', 0o555);
            lockedDir(mountDir, 'zero', 0o000);
            chmodSync(mountDir, 0o555);
          }
          return okResult(ok ? 0 : 1);
        },
      });
      const runners: StageRunners = {
        mode: 'container',
        isolated: true,
        setup: () => noopRunner(),
        verify: verifyRunner,
        verifierImage: `sha256:${'d'.repeat(64)}`,
      };
      const res = await withJudge(() =>
        runAgentStage(
          stageParams(dataDir, gateway, {
            agentConfig: {
              executor: 'pi',
              executorVersion: '0.0.0-fake',
              limits: { maxCostUsd: 0.05 },
              repetitions: 2,
              isolation: { kind: 'container' },
            },
            runners,
          }),
        ),
      );
      // Antes: THREW EACCES, sem resultado, reps seguintes não rodavam.
      expect(res.incomplete).toBe(false);
      expect(res.response.status).toBe('ok');
      expect(res.repResults).toHaveLength(2);
      for (const r of res.repResults) {
        expect(r.oracle?.score).toBe(1);
        expect(r.verdict).toBe('resolve');
      }
      expect(wsDirs).toHaveLength(2);
      expect(verifyDirs.size).toBe(2);
      for (const d of [...wsDirs, ...verifyDirs]) expect(existsSync(d), `vazou ${d}`).toBe(false);
    },
  );

  it('keepWorkspace: .workspace-kept registra workspace E repo de auditoria; o digests.json segue conferindo', async () => {
    const gateway: AgentGateway = {
      id: 'pi-fake',
      prepare: async () => ({ bin: 'pi-fake', env: {} }),
      run: async (opts) => {
        writeFileSync(path.join(opts.workspaceDir, 'done.txt'), 'ok\n');
        return fakeOutcome(opts.env.PI_MODEL_ID) as never;
      },
    };
    const runners: StageRunners = {
      mode: 'container',
      isolated: true,
      setup: () => noopRunner(),
      verify: () => ({ where: 'sandbox', isolated: true, exec: async () => okResult(0) }),
      verifierImage: `sha256:${'e'.repeat(64)}`,
    };
    const res = await withJudge(() =>
      runAgentStage(
        stageParams(dataDir, gateway, {
          agentConfig: {
            executor: 'pi',
            executorVersion: '0.0.0-fake',
            limits: { maxCostUsd: 0.05 },
            isolation: { kind: 'container', keepWorkspace: true },
          },
          runners,
        }),
      ),
    );
    const abs = path.join(dataDir, res.repResults[0].execution.dir);
    const [ws, audit] = readFileSync(path.join(abs, '.workspace-kept'), 'utf8').trim().split('\n');
    tmps.push(ws, audit);
    expect(existsSync(path.join(ws, 'done.txt'))).toBe(true);
    const branches = g(tmpdir(), ['--git-dir', audit, 'for-each-ref', '--format=%(refname)']);
    expect(branches.stdout).toContain('refs/heads/agent-result');
    expect(await verifyExecutionDigests(abs)).toEqual({ ok: true, mismatched: [], missing: [], unlisted: [] });
  });
});

describe('revisão IMPL-038 — rastreado segue rastreado nos snapshots', () => {
  function seedRepoWithIgnoredTracked(): string {
    const repo = mkTmp('pb038r-seed-');
    g(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(path.join(repo, '.gitignore'), 'config/*.json\nbuild/\n');
    mkdirSync(path.join(repo, 'config'));
    writeFileSync(path.join(repo, 'config', 'tracked.json'), '{"a":1}\n');
    writeFileSync(path.join(repo, 'config', 'local.json'), '{"nao":"rastreado"}\n');
    mkdirSync(path.join(repo, 'build'));
    writeFileSync(path.join(repo, 'build', 'out.txt'), 'gerado\n');
    mkdirSync(path.join(repo, 'src'));
    writeFileSync(path.join(repo, 'src', 'a.txt'), 'v1\n');
    g(repo, ['add', '-A']);
    g(repo, ['add', '-f', 'config/tracked.json', 'build/out.txt']);
    const c = g(repo, ['commit', '-q', '-m', 'init']);
    expect(c.status).toBe(0);
    return repo;
  }

  it('arquivo rastreado com add -f e pasta que o agente pôs no .gitignore: alteração vira M (não some nem vira D) e forbiddenPaths dispara', async () => {
    const seedRepo = seedRepoWithIgnoredTracked();
    const mgr = createWorkspaceManager({ cacheDir: mkTmp('pb038r-cache-') });
    const ws = await mgr.prepare({ repo: { kind: 'git', path: seedRepo, ref: 'main' } });
    try {
      // O HEAD do .git do agente tem os rastreados-ignorados (antes: sumiam).
      const head = g(ws.workspaceDir, ['ls-tree', '-r', '--name-only', 'HEAD']).stdout.split('\n');
      expect(head).toEqual(expect.arrayContaining(['config/tracked.json', 'build/out.txt', 'src/a.txt']));
      expect(head).not.toContain('config/local.json'); // nunca rastreado: ignorado como antes

      writeFileSync(path.join(ws.workspaceDir, 'config', 'tracked.json'), '{"a":2}\n');
      writeFileSync(path.join(ws.workspaceDir, '.gitignore'), 'config/*.json\nbuild/\nsrc/\n');
      writeFileSync(path.join(ws.workspaceDir, 'src', 'a.txt'), 'v2\n');
      writeFileSync(path.join(ws.workspaceDir, 'src', 'novo.txt'), 'ignorado\n');
      // build/ vira symlink para fora: o rastreado some (D), nada é seguido.
      rmSync(path.join(ws.workspaceDir, 'build'), { recursive: true, force: true });
      symlinkSync('/etc', path.join(ws.workspaceDir, 'build'));

      const c = await mgr.collect(ws.workspaceDir, ws.seedCommit);
      const byPath = Object.fromEntries(c.nameStatus.map((f) => [f.path, f.status]));
      expect(byPath).toMatchObject({
        'config/tracked.json': 'M',
        'src/a.txt': 'M',
        '.gitignore': 'M',
        'build/out.txt': 'D',
        build: 'A',
      });
      expect(byPath['config/local.json']).toBeUndefined();
      expect(byPath['src/novo.txt']).toBeUndefined(); // novo E ignorado: fora, como antes
      expect(c.diff).toContain('+{"a":2}');

      const oracle = await runOracle({
        workspaceDir: mkTmp('pb038r-or-'),
        verify: [],
        forbiddenPaths: ['config/'],
        diffFiles: c.nameStatus,
      });
      expect(oracle.violations).toEqual(['config/tracked.json']);
    } finally {
      await mgr.dispose(ws.cacheRepoDir, ws.workspaceDir);
    }
  });

  it('setup em sandbox com repo-semente: o gitfile do host vira um .git próprio (git funciona em /ws, sem alternates); o seed segue certo', async () => {
    const seedRepo = seedRepoWithIgnoredTracked();
    const mgr = createWorkspaceManager({ cacheDir: mkTmp('pb038r-cache2-') });
    const seen: { gitIsDir: boolean; head: number | null; files: string[]; alternates: boolean }[] = [];
    const setupRunner = (mountDir: string): CommandRunner => ({
      where: 'sandbox',
      isolated: true,
      exec: async () => {
        // "git dentro do container": só enxerga o que está no diretório montado.
        const env = { GIT_CEILING_DIRECTORIES: path.dirname(mountDir) };
        const head = spawnSync('git', ['-C', mountDir, 'rev-parse', '--verify', 'HEAD'], { env: { ...process.env, ...env } });
        const files = spawnSync('git', ['-C', mountDir, 'ls-files'], { encoding: 'utf8', env: { ...process.env, ...env } });
        seen.push({
          gitIsDir: lstatSync(path.join(mountDir, '.git')).isDirectory(),
          head: head.status,
          files: files.stdout.split('\n').filter(Boolean),
          alternates: existsSync(path.join(mountDir, '.git', 'objects', 'info', 'alternates')),
        });
        writeFileSync(path.join(mountDir, 'setup-ran.txt'), '1\n');
        // O setup (código da tarefa) planta um hook no .git: some no seed.
        mkdirSync(path.join(mountDir, '.git', 'hooks'), { recursive: true });
        writeFileSync(path.join(mountDir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        return okResult(0);
      },
    });
    const ws = await mgr.prepare(
      { repo: { kind: 'git', path: seedRepo, ref: 'main' }, setup: [{ cmd: 'npm ci' }] },
      { setupRunner },
    );
    try {
      expect(seen).toEqual([
        {
          gitIsDir: true,
          head: 0,
          files: expect.arrayContaining(['config/tracked.json', 'build/out.txt', 'src/a.txt', '.gitignore']),
          alternates: false,
        },
      ]);
      // O agente recebe um .git NOVO (HEAD = seed, com o que o setup gerou).
      expect(existsSync(path.join(ws.workspaceDir, '.git', 'hooks', 'pre-commit'))).toBe(false);
      const head = g(ws.workspaceDir, ['rev-parse', 'HEAD']).stdout.trim();
      expect(head).toBe(ws.seedCommit);
      const c = await mgr.collect(ws.workspaceDir, ws.seedCommit);
      expect(c.nameStatus).toEqual([]);
    } finally {
      await mgr.dispose(ws.cacheRepoDir, ws.workspaceDir);
    }
    expect(existsSync(ws.workspaceDir)).toBe(false);
    expect(existsSync(ws.auditGitDir)).toBe(false);
  });
});
