// ----------------------------------------------------------------------------
// IMPL-038 (R-15 REC-4) — setup[]/verify[]/collect() fora do host.
//
// Critérios de aceite provados aqui:
//   E3  hook `pre-commit` / `core.fsmonitor` plantados pelo agente NÃO executam
//       no host (o `collect()` não roda git no `.git` do workspace).
//   E2  um check que imprime o env do host não mostra o segredo (host: env
//       mínimo; container: env da imagem).
//   ·   `collect()` não faz commit no `.git` do workspace (bytes do `.git`
//       idênticos antes/depois).
//   ·   execuções de código do agente/tarefa no host = 0 em modo container
//       (contador do runner de host).
//   ·   `digests.json` confere com os artefatos após a coleta (inclusive os crus
//       gravados pelo executor e a sessão do copy-out).
// A camada Docker real (`dockerReady`) prova o sandbox verificador de verdade;
// `PB_SKIP_DOCKER_TESTS=1` a desliga. Nenhuma chamada paga: juiz = fetch falso.
// ----------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  copyTreeBytes,
  hostCommandExecutions,
  hostCommandRunner,
  hostMinimalEnv,
  writeFileNoFollow,
  type CommandRunner,
} from '../src/agent/sandboxExec.js';
import { createWorkspaceManager } from '../src/agent/workspace.js';
import { runOracle } from '../src/agent/oracle.js';
import { verifyExecutionDigests } from '../src/agent/store.js';
import {
  dockerRunDidNotStart,
  resolveImageDigest,
  sandboxCommandRunner,
  sandboxProfile,
  UNSAFE_NETWORK_ENV,
} from '../src/agent/container.js';
import {
  resolveStageRunners,
  runAgentStage,
  type AgentGateway,
  type RunAgentStageParams,
  type StageRunners,
} from '../src/agent/runAgentStage.js';
import { createGateway, setDefaultGateway } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import type { AgentTaskSpec, ExecutionRecord } from '../src/agent/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const SECRET = 'sk-or-v1-SEGREDO-DO-OPERADOR-impl038-000000000000';
const OTHER_SECRET = 'segredo-de-token-impl038';

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
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

/** sha256 de TODA a árvore (caminho + tipo + bytes/alvo), sem seguir symlink. */
function treeHash(dir: string): string {
  const h = createHash('sha256');
  const walk = (rel: string): void => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const r = path.join(rel, name);
      const st = lstatSync(path.join(dir, r));
      if (st.isDirectory()) {
        h.update(`d:${r}\n`);
        walk(r);
      } else if (st.isSymbolicLink()) {
        h.update(`l:${r}->${readlinkSync(path.join(dir, r))}\n`);
      } else {
        h.update(`f:${r}:${st.mode & 0o777}\n`);
        h.update(readFileSync(path.join(dir, r)));
      }
    }
  };
  walk('');
  return h.digest('hex');
}

/** Script executável que, SE rodar, cria `marker` no host. */
function markerScript(dir: string, name: string, marker: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho pwned > '${marker}'\nexit 0\n`, { mode: 0o755 });
  return file;
}

/**
 * O que um agente hostil deixa no `.git` do workspace: `pre-commit`/`post-commit`
 * e `fsmonitor` apontando para scripts que criam marcadores no host, mais um
 * `.git` ANINHADO (submódulo falso) com o mesmo truque.
 */
function plantGitTraps(ws: string, markerDir: string): string[] {
  const markers = ['pre-commit', 'post-commit', 'fsmonitor', 'nested-fsmonitor', 'hookspath'].map((n) =>
    path.join(markerDir, `${n}.pwned`),
  );
  const hooks = path.join(ws, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  markerScript(hooks, 'pre-commit', markers[0]);
  markerScript(hooks, 'post-commit', markers[1]);
  const fsmon = markerScript(markerDir, 'fsmon.sh', markers[2]);
  const altHooks = path.join(markerDir, 'alt-hooks');
  mkdirSync(altHooks, { recursive: true });
  markerScript(altHooks, 'pre-commit', markers[4]);
  writeFileSync(
    path.join(ws, '.git', 'config'),
    readFileSync(path.join(ws, '.git', 'config'), 'utf8') + `[core]\n\tfsmonitor = ${fsmon}\n\thooksPath = ${altHooks}\n`,
  );
  const nested = path.join(ws, 'vendor', 'lib', '.git');
  mkdirSync(nested, { recursive: true });
  const nestedMon = markerScript(markerDir, 'nested.sh', markers[3]);
  writeFileSync(path.join(nested, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(path.join(nested, 'config'), `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = ${nestedMon}\n`);
  mkdirSync(path.join(nested, 'objects'), { recursive: true });
  mkdirSync(path.join(nested, 'refs'), { recursive: true });
  writeFileSync(path.join(ws, 'vendor', 'lib', 'x.js'), 'module.exports = 1;\n');
  return markers;
}

// ===========================================================================
// 1. Helpers do host que só leem bytes
// ===========================================================================

describe('copyTreeBytes — só bytes, symlink nunca seguido, sem .git', () => {
  it('copia regulares (bit x preservado), recria symlink SEM ler o alvo, pula .git em qualquer nível e FIFO', () => {
    const src = mkTmp('pb038-src-');
    const dst = path.join(mkTmp('pb038-dst-'), 'out');
    writeFileSync(path.join(src, 'a.txt'), 'a');
    writeFileSync(path.join(src, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    mkdirSync(path.join(src, '.git', 'hooks'), { recursive: true });
    writeFileSync(path.join(src, '.git', 'hooks', 'pre-commit'), 'x');
    mkdirSync(path.join(src, 'sub', '.git'), { recursive: true });
    writeFileSync(path.join(src, 'sub', '.git', 'config'), 'x');
    writeFileSync(path.join(src, 'sub', 'b.txt'), 'b');
    symlinkSync('/etc/passwd', path.join(src, 'passwd-link'));
    spawnSync('mkfifo', [path.join(src, 'fifo')]);

    const r = copyTreeBytes(src, dst);
    expect(readFileSync(path.join(dst, 'a.txt'), 'utf8')).toBe('a');
    expect(lstatSync(path.join(dst, 'run.sh')).mode & 0o111).not.toBe(0);
    expect(readFileSync(path.join(dst, 'sub', 'b.txt'), 'utf8')).toBe('b');
    expect(existsSync(path.join(dst, '.git'))).toBe(false);
    expect(existsSync(path.join(dst, 'sub', '.git'))).toBe(false);
    expect(lstatSync(path.join(dst, 'passwd-link')).isSymbolicLink()).toBe(true);
    expect(r.bytes).toBeLessThan(100); // o conteúdo de /etc/passwd nunca foi lido
    expect(existsSync(path.join(dst, 'fifo'))).toBe(false);
    expect(r.skipped).toEqual(expect.arrayContaining(['.git', path.join('sub', '.git')]));

    const skipLinks = path.join(mkTmp('pb038-dst2-'), 'out');
    copyTreeBytes(src, skipLinks, { symlinks: 'skip', maxBytes: 1 });
    expect(existsSync(path.join(skipLinks, 'passwd-link'))).toBe(false);
    expect(existsSync(path.join(skipLinks, 'a.txt'))).toBe(true); // 1 byte cabe
    expect(existsSync(path.join(skipLinks, 'run.sh'))).toBe(false); // estourou o teto
  });

  it('writeFileNoFollow: symlink plantado no caminho do fixture é trocado por diretório real (a escrita não sai da cópia)', () => {
    const root = mkTmp('pb038-nofollow-');
    const outside = mkTmp('pb038-outside-');
    symlinkSync(outside, path.join(root, 'tests'));
    symlinkSync(path.join(outside, 'alvo.txt'), path.join(root, 'fixture.txt'));
    writeFileNoFollow(root, 'tests/caso.txt', 'PRISTINO');
    writeFileNoFollow(root, 'fixture.txt', 'PRISTINO2');
    expect(lstatSync(path.join(root, 'tests')).isDirectory()).toBe(true);
    expect(readFileSync(path.join(root, 'tests', 'caso.txt'), 'utf8')).toBe('PRISTINO');
    expect(lstatSync(path.join(root, 'fixture.txt')).isFile()).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
    expect(() => writeFileNoFollow(root, '../fora.txt', 'x')).toThrow(/fora do workspace/);
  });

  it('hostMinimalEnv é allowlist: nenhum KEY/TOKEN/SECRET do host passa', () => {
    const env = hostMinimalEnv({
      PATH: '/bin',
      HOME: '/home/x',
      OPENROUTER_API_KEY: SECRET,
      GITHUB_TOKEN: OTHER_SECRET,
      AWS_SECRET_ACCESS_KEY: OTHER_SECRET,
      FOO_CREDENTIALS: OTHER_SECRET,
    });
    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBe('/home/x');
    expect(JSON.stringify(env)).not.toContain(SECRET);
    expect(JSON.stringify(env)).not.toContain(OTHER_SECRET);
  });

  it('dockerRunDidNotStart: 125 e OCI 126/127 são "o check não rodou"; exit 127 do próprio script não', () => {
    expect(dockerRunDidNotStart(125, '')).toBe(true);
    expect(dockerRunDidNotStart(127, 'docker: Error response from daemon: failed to create task: exec: "nope": executable file not found in $PATH')).toBe(true);
    expect(dockerRunDidNotStart(127, 'sh: 1: foo: not found')).toBe(false);
    expect(dockerRunDidNotStart(1, 'OCI runtime')).toBe(false);
  });
});

// ===========================================================================
// 2. collect() por cópia de árvore — E3
// ===========================================================================

describe('collect() — nunca git no .git do agente (E3)', () => {
  it('hooks/fsmonitor/hooksPath/.git aninhado plantados NÃO executam; o .git do workspace fica byte a byte intocado; o diff sai certo', async () => {
    const cache = mkTmp('pb038-cache-');
    const markerDir = mkTmp('pb038-markers-');
    const mgr = createWorkspaceManager({ cacheDir: cache });
    const ws = await mgr.prepare({
      files: [
        { path: 'keep.txt', content: 'fica\n' },
        { path: 'edit.txt', content: 'antes\n' },
        { path: 'drop.txt', content: 'some\n' },
      ],
    });
    try {
      // O agente ganhou um repo git de verdade, com HEAD = seed.
      expect(lstatSync(path.join(ws.workspaceDir, '.git')).isDirectory()).toBe(true);
      expect(readFileSync(path.join(ws.workspaceDir, '.git', 'HEAD'), 'utf8')).toMatch(/refs\/heads\/main/);
      expect(ws.seedCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(path.relative(ws.workspaceDir, ws.auditGitDir).startsWith('..')).toBe(true);

      // "Trabalho" do agente + armadilhas.
      writeFileSync(path.join(ws.workspaceDir, 'edit.txt'), 'depois\n');
      writeFileSync(path.join(ws.workspaceDir, 'novo.txt'), 'criado\n');
      rmSync(path.join(ws.workspaceDir, 'drop.txt'));
      const markers = plantGitTraps(ws.workspaceDir, markerDir);
      const gitBefore = treeHash(path.join(ws.workspaceDir, '.git'));

      const c = await mgr.collect(ws.workspaceDir, ws.seedCommit);

      for (const m of markers) expect(existsSync(m), `${path.basename(m)} executou no host`).toBe(false);
      // collect() não fez `add`/`commit` no .git do workspace: nada mudou lá.
      expect(treeHash(path.join(ws.workspaceDir, '.git'))).toBe(gitBefore);
      const byPath = Object.fromEntries(c.nameStatus.map((f) => [f.path, f.status]));
      expect(byPath).toMatchObject({ 'edit.txt': 'M', 'novo.txt': 'A', 'drop.txt': 'D', 'vendor/lib/x.js': 'A' });
      expect(byPath['keep.txt']).toBeUndefined();
      // O .git aninhado nunca vira submódulo/gitlink no artefato.
      expect(Object.keys(byPath).some((p) => p.includes('.git'))).toBe(false);
      expect(c.diff).toContain('+depois');
      expect(c.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(c.snapshotDir).toBeUndefined();
    } finally {
      await mgr.dispose(ws.cacheRepoDir, ws.workspaceDir);
    }
    expect(existsSync(ws.workspaceDir)).toBe(false);
    expect(existsSync(ws.auditGitDir)).toBe(false);
  });

  it('repo-semente (worktree de caminho local): o agente recebe um .git próprio, o setup hostil no .git não roda e o dispose limpa o worktree', async () => {
    const seedRepo = mkTmp('pb038-seedrepo-');
    const g = (args: string[]) =>
      spawnSync('git', args, {
        cwd: seedRepo,
        encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
      });
    g(['init', '-q', '-b', 'main']);
    writeFileSync(path.join(seedRepo, 'src.txt'), 'v1\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'init']);

    const cache = mkTmp('pb038-cache2-');
    const markerDir = mkTmp('pb038-markers2-');
    const mgr = createWorkspaceManager({ cacheDir: cache });
    const ws = await mgr.prepare({ repo: { kind: 'git', path: seedRepo, ref: 'main' } });
    writeFileSync(path.join(ws.workspaceDir, 'src.txt'), 'v2\n');
    const markers = plantGitTraps(ws.workspaceDir, markerDir);
    const c = await mgr.collect(ws.workspaceDir, ws.seedCommit);
    for (const m of markers) expect(existsSync(m)).toBe(false);
    expect(c.nameStatus.find((f) => f.path === 'src.txt')?.status).toBe('M');
    await mgr.dispose(ws.cacheRepoDir, ws.workspaceDir);
    const wt = spawnSync('git', ['--git-dir', ws.cacheRepoDir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    expect(wt.stdout).not.toContain(ws.workspaceDir);
  });
});

// ===========================================================================
// 3. verify[] — E2 (env do host fora da saída)
// ===========================================================================

describe('oráculo — E2: check que imprime o env não vê segredo', () => {
  it('modo host explícito: env mínimo (a key do operador no process.env NÃO chega ao check)', async () => {
    const dir = mkTmp('pb038-e2-host-');
    const saved = { k: process.env.OPENROUTER_API_KEY, t: process.env.PB_TEST_SECRET_TOKEN };
    process.env.OPENROUTER_API_KEY = SECRET;
    process.env.PB_TEST_SECRET_TOKEN = OTHER_SECRET;
    try {
      const before = hostCommandExecutions();
      const r = await runOracle({
        workspaceDir: dir,
        verify: [{ cmd: `node -e "process.stdout.write(JSON.stringify(process.env))"`, label: 'env' }],
      });
      expect(hostCommandExecutions() - before).toBe(1);
      expect(r.checks[0].ok).toBe(true);
      expect(r.checks[0].tail).toContain('PATH');
      expect(r.checks[0].tail).not.toContain(SECRET);
      expect(r.checks[0].tail).not.toContain(OTHER_SECRET);
    } finally {
      if (saved.k === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved.k;
      if (saved.t === undefined) delete process.env.PB_TEST_SECRET_TOKEN;
      else process.env.PB_TEST_SECRET_TOKEN = saved.t;
    }
  });

  it('runner injetado: o oráculo só decide pelo exit code do runner (spawnFailed/timeout = inconclusivo)', async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      where: 'sandbox',
      isolated: true,
      exec: async (req) => {
        calls.push(req.argv);
        req.onOutput?.(Buffer.from(`saida de ${req.argv[0]}\n`));
        if (req.argv[0] === 'sumiu') return { code: null, signal: null, spawnFailed: true, timedOut: false };
        return { code: req.argv[0] === 'passa' ? 0 : 1, signal: null, spawnFailed: false, timedOut: false };
      },
    };
    const r = await runOracle({
      workspaceDir: mkTmp('pb038-runner-'),
      runner,
      verify: [{ cmd: 'passa "a b"' }, { cmd: 'falha' }, { cmd: 'sumiu' }],
    });
    expect(calls).toEqual([['passa', 'a b'], ['falha'], ['sumiu']]);
    expect(r.checks.map((c) => c.ok)).toEqual([true, false, false]);
    expect(r.inconclusive).toBe(true);
    expect(r.checks[0].tail).toContain('saida de passa');
  });
});

// ===========================================================================
// 4. runAgentStage — 0 execução no host em modo container + digests
// ===========================================================================

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

/**
 * Executor falso = agente HOSTIL: resolve a tarefa (`done.txt`), ADULTERA o
 * fixture de teste, planta armadilhas no `.git` e deixa os arquivos crus que o
 * pi real grava no dir de execução (events.raw.jsonl, stderr.raw.log, sessão).
 */
function hostileAgent(markerDir: string, markers: string[][], prepareEnv: Record<string, string> = {}): AgentGateway {
  return {
    id: 'pi-fake',
    prepare: async () => ({ bin: 'pi-fake', env: prepareEnv }),
    run: async (opts) => {
      writeFileSync(path.join(opts.workspaceDir, 'done.txt'), 'ok\n');
      writeFileSync(path.join(opts.workspaceDir, 'tests', 'expected.txt'), 'ADULTERADO\n');
      markers.push(plantGitTraps(opts.workspaceDir, markerDir));
      writeFileSync(path.join(opts.workDir, 'events.raw.jsonl'), '{"type":"agent_settled"}\n');
      writeFileSync(path.join(opts.workDir, 'stderr.raw.log'), '');
      mkdirSync(path.join(opts.workDir, 'session'), { recursive: true });
      writeFileSync(path.join(opts.workDir, 'session', '2026-09-27_x.jsonl'), '{"type":"session"}\n');
      return fakeOutcome(opts.env.PI_MODEL_ID) as never;
    },
  };
}

const TASK: AgentTaskSpec = {
  setup: [{ cmd: 'node -e "require(\'fs\').writeFileSync(\'setup-ran.txt\', \'1\')"' }],
  files: [{ path: 'tests/expected.txt', content: 'PRISTINO\n' }],
  verify: [
    { cmd: 'test -f done.txt', label: 'done' },
    { cmd: 'grep -q PRISTINO tests/expected.txt', label: 'fixture prístino' },
  ],
};

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

let seq = 0;
function stageParams(dataDir: string, gateway: AgentGateway, extra: Partial<RunAgentStageParams> = {}): RunAgentStageParams {
  return {
    runId: `run-038-${seq}`,
    stageIndex: seq++,
    contestant: { id: 'ag', label: 'ag', modelId: 'fake/a', runner: 'agent' },
    stage: { question: 'crie done.txt', productContext: 'repo vazio', maxTokens: 200, agentTask: TASK },
    agentConfig: { executor: 'pi', executorVersion: '0.0.0-fake', limits: { maxCostUsd: 0.05 } },
    apiKey: SECRET,
    ctx: {},
    dataDir,
    catalog: [],
    judgeModelIds: ['fake/judge'],
    gateway,
    ...extra,
  };
}

function readExec(dataDir: string, dir: string): ExecutionRecord {
  return JSON.parse(readFileSync(path.join(dataDir, dir, 'exec.json'), 'utf8')) as ExecutionRecord;
}

describe('runAgentStage — ONDE roda o código não confiável', () => {
  let dataDir: string;
  let prevDir: string;
  beforeAll(() => {
    dataDir = mkTmp('pb038-data-');
    prevDir = getDataDir();
    setDataDir(dataDir);
  });
  afterAll(() => setDataDir(prevDir));

  it('modo container: 0 execução no host; setup no workspace e verify numa CÓPIA nova com o fixture PRÍSTINO; armadilhas do .git não rodam', async () => {
    const markerDir = mkTmp('pb038-stage-markers-');
    const markers: string[][] = [];
    const seen: { phase: string; argv: string[]; cwd: string; fixture?: string; hasGit?: boolean }[] = [];
    let wsDir = '';
    const fakeSandbox = (phase: 'setup' | 'verify', mountDir: string): CommandRunner => ({
      where: 'sandbox',
      isolated: true,
      exec: async (req) => {
        // "Sandbox" de mentira: registra e AVALIA o estado do diretório montado
        // sem executar processo nenhum (o Docker real está na seção 5).
        if (phase === 'setup') wsDir = mountDir;
        const fixture = existsSync(path.join(mountDir, 'tests', 'expected.txt'))
          ? readFileSync(path.join(mountDir, 'tests', 'expected.txt'), 'utf8')
          : undefined;
        seen.push({ phase, argv: req.argv, cwd: req.cwd, fixture, hasGit: existsSync(path.join(mountDir, '.git')) });
        if (phase === 'setup') writeFileSync(path.join(mountDir, 'setup-ran.txt'), '1');
        const ok =
          phase === 'setup' ||
          (req.argv[0] === 'test' && existsSync(path.join(mountDir, 'done.txt'))) ||
          (req.argv[0] === 'grep' && fixture === 'PRISTINO\n');
        return { code: ok ? 0 : 1, signal: null, spawnFailed: false, timedOut: false };
      },
    });
    const runners: StageRunners = {
      mode: 'container',
      isolated: true,
      setup: (dir) => fakeSandbox('setup', dir),
      verify: (dir) => fakeSandbox('verify', dir),
      setupNetwork: 'bridge',
      verifierImage: `sha256:${'c'.repeat(64)}`,
    };
    const before = hostCommandExecutions();
    const res = await withJudge(() =>
      runAgentStage(
        stageParams(dataDir, hostileAgent(markerDir, markers), {
          agentConfig: {
            executor: 'pi',
            executorVersion: '0.0.0-fake',
            limits: { maxCostUsd: 0.05 },
            isolation: { kind: 'container' },
          },
          runners,
        }),
      ),
    );
    // Execuções de código de tarefa/agente no host = 0.
    expect(hostCommandExecutions() - before).toBe(0);
    for (const m of markers.flat()) expect(existsSync(m), path.basename(m)).toBe(false);

    const setup = seen.filter((s) => s.phase === 'setup');
    const verify = seen.filter((s) => s.phase === 'verify');
    expect(setup).toHaveLength(1);
    expect(setup[0].cwd).toBe(wsDir);
    expect(verify).toHaveLength(2);
    for (const v of verify) {
      // Verificador NOVO: cópia fora do workspace, sem o .git do agente, com o
      // fixture PRÍSTINO reescrito depois do agente — e apagada no fim.
      expect(v.cwd).not.toBe(wsDir);
      expect(v.hasGit).toBe(false);
      expect(v.fixture).toBe('PRISTINO\n');
      expect(existsSync(v.cwd)).toBe(false);
    }
    const r0 = res.repResults[0];
    expect(r0.oracle?.score).toBe(1);
    expect(r0.verdict).toBe('resolve');
    const rec = readExec(dataDir, r0.execution.dir);
    expect(rec.sandbox).toMatchObject({ mode: 'container', isolated: true, setup: 'sandbox', verify: 'sandbox', collect: 'tree-copy' });
    // O agente adulterou o fixture: o DIFF mostra (o verificador não o viu).
    expect(rec.workspace.files.map((f) => f.path)).toContain('tests/expected.txt');
  });

  it('modo host EXPLÍCITO: marcado sem isolamento no exec.json; setup/verify contam no runner de host', async () => {
    const markerDir = mkTmp('pb038-stage-markers-h-');
    const markers: string[][] = [];
    const before = hostCommandExecutions();
    const res = await withJudge(() => runAgentStage(stageParams(dataDir, hostileAgent(markerDir, markers))));
    expect(hostCommandExecutions() - before).toBe(3); // 1 setup + 2 verify
    for (const m of markers.flat()) expect(existsSync(m), path.basename(m)).toBe(false);
    const r0 = res.repResults[0];
    expect(r0.oracle?.checks.map((c) => c.ok)).toEqual([true, true]); // fixture prístino também no host
    const rec = readExec(dataDir, r0.execution.dir);
    expect(rec.sandbox).toMatchObject({ mode: 'host', isolated: false, setup: 'host', verify: 'host' });
    expect(rec.sandbox?.note).toMatch(/sem isolamento/);
  });

  it('digests.json confere com os artefatos após a coleta — inclusive crus do executor e a sessão; adulteração é detectada', async () => {
    const markers: string[][] = [];
    const res = await withJudge(() => runAgentStage(stageParams(dataDir, hostileAgent(mkTmp('pb038-dg-'), markers))));
    const abs = path.join(dataDir, res.repResults[0].execution.dir);
    const check = await verifyExecutionDigests(abs);
    expect(check).toEqual({ ok: true, mismatched: [], missing: [], unlisted: [] });
    const digests = JSON.parse(readFileSync(path.join(abs, 'digests.json'), 'utf8')) as Record<string, string>;
    expect(Object.keys(digests)).toEqual(
      expect.arrayContaining([
        'exec.json',
        'oracle.json',
        'workspace.diff',
        'events.raw.jsonl',
        'stderr.raw.log',
        'task.txt',
        'session/2026-09-27_x.jsonl',
      ]),
    );
    writeFileSync(path.join(abs, 'events.raw.jsonl'), '{"type":"forjado"}\n');
    rmSync(path.join(abs, 'oracle.json'));
    symlinkSync('/etc/hostname', path.join(abs, 'oracle.json'));
    writeFileSync(path.join(abs, 'intruso.txt'), 'x');
    const bad = await verifyExecutionDigests(abs);
    expect(bad.ok).toBe(false);
    expect(bad.mismatched).toContain('events.raw.jsonl');
    expect(bad.missing).toContain('oracle.json');
    expect(bad.unlisted).toContain('intruso.txt');
  });

  it('modo container sem imagem pinada por digest: recusa (sem fallback silencioso para o host)', async () => {
    await expect(resolveStageRunners({ executor: 'pi', executorVersion: 'x', isolation: { kind: 'container' } }, {})).rejects.toThrow(
      /pinada por digest/,
    );
    const host = await resolveStageRunners({ executor: 'pi', executorVersion: 'x' }, {});
    expect(host).toMatchObject({ mode: 'host', isolated: false });
  });
});

// ===========================================================================
// 5. Docker REAL: o sandbox verificador de verdade
// ===========================================================================

const PI_IMAGE = 'prompt-builder-pi:0.84.2';
const dockerReady =
  process.env.PB_SKIP_DOCKER_TESTS !== '1' &&
  spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 15_000 }).status === 0;
const imageReady =
  dockerReady && spawnSync('docker', ['image', 'inspect', PI_IMAGE], { encoding: 'utf8', timeout: 15_000 }).status === 0;

describe.skipIf(!imageReady)('sandbox verificador REAL (Docker)', () => {
  it(
    'E2 no container: `env` não mostra o segredo do host; escrita num caminho do host não sai do sandbox; binário ausente = inconclusivo',
    async () => {
      const saved = { k: process.env.OPENROUTER_API_KEY, net: process.env[UNSAFE_NETWORK_ENV] };
      process.env.OPENROUTER_API_KEY = SECRET;
      delete process.env[UNSAFE_NETWORK_ENV];
      try {
        const pinned = await resolveImageDigest(PI_IMAGE);
        expect(pinned).not.toBeNull();
        const dir = mkTmp('pb038-docker-');
        chmodSync(dir, 0o755);
        writeFileSync(path.join(dir, 'done.txt'), 'ok\n');
        const hostMarker = path.join(mkTmp('pb038-docker-mk-'), 'fugiu.txt');
        const runner = sandboxCommandRunner({ image: pinned!.digest, profile: await sandboxProfile(), mountDir: dir });
        const before = hostCommandExecutions();
        const r = await runOracle({
          workspaceDir: dir,
          runner,
          verify: [
            { cmd: 'env', label: 'env' },
            { cmd: 'test -f done.txt', label: 'done' },
            { cmd: `node -e "require('fs').writeFileSync('${hostMarker}', 'x')"`, label: 'fuga' },
            { cmd: 'binario-que-nao-existe-038', label: 'ausente' },
          ],
        });
        expect(hostCommandExecutions() - before).toBe(0);
        expect(r.checks[0].ok).toBe(true);
        expect(r.checks[0].tail).toContain('HOME=/tmp');
        expect(r.checks[0].tail).not.toContain(SECRET);
        expect(r.checks[0].tail).not.toContain('OPENROUTER_API_KEY');
        expect(r.checks[1].ok).toBe(true);
        expect(r.checks[2].ok).toBe(false);
        expect(existsSync(hostMarker)).toBe(false);
        expect(r.checks[3].ok).toBe(false);
        expect(r.inconclusive).toBe(true);
      } finally {
        if (saved.k === undefined) delete process.env.OPENROUTER_API_KEY;
        else process.env.OPENROUTER_API_KEY = saved.k;
        if (saved.net !== undefined) process.env[UNSAFE_NETWORK_ENV] = saved.net;
      }
    },
    120_000,
  );

  it(
    'runAgentStage em container com runners REAIS: setup e verify no sandbox, 0 no host, fixture prístino, armadilhas mortas',
    async () => {
      const saved = process.env[UNSAFE_NETWORK_ENV];
      delete process.env[UNSAFE_NETWORK_ENV];
      const dataDir = mkTmp('pb038-docker-data-');
      const prevDir = getDataDir();
      setDataDir(dataDir);
      try {
        const pinned = await resolveImageDigest(PI_IMAGE);
        const markerDir = mkTmp('pb038-docker-markers-');
        const markers: string[][] = [];
        const setupMarker = path.join(markerDir, 'setup-fugiu.txt');
        const task: AgentTaskSpec = {
          ...TASK,
          setup: [
            { cmd: `node -e "require('fs').writeFileSync('setup-ran.txt','1'); try { require('fs').writeFileSync('${setupMarker}','x') } catch {}"` },
          ],
          verify: [...(TASK.verify ?? []), { cmd: 'test -f setup-ran.txt', label: 'setup rodou no sandbox' }],
        };
        const before = hostCommandExecutions();
        const res = await withJudge(() =>
          runAgentStage(
            stageParams(dataDir, hostileAgent(markerDir, markers, { PI_CONTAINER_IMAGE: pinned!.digest }), {
              stage: { question: 'crie done.txt', productContext: 'repo vazio', maxTokens: 200, agentTask: task },
              agentConfig: {
                executor: 'pi',
                executorVersion: '0.0.0-fake',
                limits: { maxCostUsd: 0.05 },
                isolation: { kind: 'container' },
              },
            }),
          ),
        );
        expect(hostCommandExecutions() - before).toBe(0);
        expect(existsSync(setupMarker)).toBe(false);
        for (const m of markers.flat()) expect(existsSync(m), path.basename(m)).toBe(false);
        const r0 = res.repResults[0];
        expect(r0.oracle?.checks.map((c) => [c.label, c.ok])).toEqual([
          ['done', true],
          ['fixture prístino', true],
          ['setup rodou no sandbox', true],
        ]);
        const rec = readExec(dataDir, r0.execution.dir);
        expect(rec.sandbox).toMatchObject({ mode: 'container', isolated: true, verifierImage: pinned!.digest });
        expect((await verifyExecutionDigests(path.join(dataDir, r0.execution.dir))).ok).toBe(true);
      } finally {
        setDataDir(prevDir);
        if (saved !== undefined) process.env[UNSAFE_NETWORK_ENV] = saved;
      }
    },
    180_000,
  );
});

// Referência cruzada: o runner de host segue disponível e marcado sem isolamento.
describe('hostCommandRunner', () => {
  it('é o modo host explícito: where=host, isolated=false', () => {
    const r = hostCommandRunner();
    expect(r.where).toBe('host');
    expect(r.isolated).toBe(false);
  });
});
