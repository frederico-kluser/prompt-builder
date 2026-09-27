// ----------------------------------------------------------------------------
// Workspace — o ciclo de vida git de UMA execução de agente.
//
// O agente acorda dentro de um repositório git REAL e o artefato é definido
// como o diff entre o `seedCommit` (o que a tarefa trouxe: setup + fixtures) e o
// HEAD depois de o agente rodar. Isso torna "o que o agente fez" um objeto
// calculável — sem heurística, sem comparar árvores na mão, e com um sha para
// citar no record (§10 / §13.1 do plano).
//
// Este módulo SÓ prepara / mede / derruba o workspace. O ORÁCULO NUNCA roda
// aqui: `verify[]` e `forbiddenPaths` são de outro módulo (§10, passo 8). Este
// arquivo não conhece `verify` de propósito.
//
// IMPL-038 (R-15 REC-4) — o git do HOST nunca toca um `.git` que código não
// confiável pôde escrever:
// - `setup[]` roda pelo `CommandRunner` injetado (sandbox em modo container;
//   host EXPLÍCITO, sem isolamento, no modo host).
// - A régua do diff mora num `--git-dir` de AUDITORIA criado pelo produto, fora
//   do workspace e de qualquer mount. seed e resultado são snapshots de CÓPIAS
//   da árvore (`copyTreeBytes`: só bytes, symlink não seguido, sem `.git`),
//   commitados por plumbing (`write-tree`/`commit-tree` — hook nenhum dispara).
// - O agente recebe um `.git` NOVO, clonado do repo de auditoria (HEAD = seed),
//   e pode fazer o que quiser com ele: o `collect()` não o lê nem o executa
//   (caso E3: `pre-commit`/`core.fsmonitor` plantados não rodam no host).
//
// ⚠️ ESPELHO CLIENT-SIDE: NÃO existe. O navegador não tem `child_process`,
// filesystem nem git — o modo agente é impossível na SPA (§7.3 / §10 do plano).
// Não "consertar" essa assimetria.
// ----------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentLimits, AgentTaskSpec } from './types.js';
import {
  copyTreeBytes,
  hostCommandRunner,
  safeGit,
  safeGitOrThrow,
  writeFileNoFollow,
  type CommandRunner,
} from './sandboxExec.js';

// O teto de bytes do diff considerado, quando a tarefa não diz nada (§AgentLimits).
const DEFAULT_MAX_DIFF_BYTES = 512 * 1024;
// Identidade git local dos commits de seed/resultado. Workspace é descartável e
// isolado — configurar aqui evita depender do `user.name`/`user.email` global do
// host (que pode não existir e faria o `git commit` falhar em silêncio).
const GIT_IDENTITY = { name: 'agent-arena', email: 'agent-arena@local' };

/** Saída bruta de um `git` (ou qualquer processo spawnado). */
interface ProcResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/**
 * Workspace preparado e no commit `seed` — o cwd onde o executor vai rodar.
 */
export interface PreparedWorkspace {
  /** Absoluto; é o cwd do agente. */
  workspaceDir: string;
  /** SHA do commit "seed" (a régua do diff: setup + files antes de rodar o agente). */
  seedCommit: string;
  /** Repo cache (bare) do seed; endereçado por hash de (url|path, ref). Usado no dispose. */
  cacheRepoDir: string;
  /**
   * `--git-dir` de AUDITORIA (bare, fora do workspace, nunca montado): guarda o
   * seed e o `agent-result`. É dele — nunca do `.git` do agente — que sai o diff.
   */
  auditGitDir: string;
}

/**
 * Artefato colhido DEPOIS de o agente rodar.
 */
export interface CollectResult {
  /** SHA do commit "agent-result". */
  commitSha: string;
  /** Diff unificado `seed..HEAD`, truncado com marca se exceder `maxDiffBytes`. */
  diff: string;
  diffTruncated: boolean;
  /** Saída crua de `git diff --numstat seed..HEAD`. */
  statText: string;
  /** `git diff --name-status` parseado. Renames viram 'R' com o caminho novo. */
  nameStatus: { path: string; status: 'A' | 'M' | 'D' | 'R' }[];
  /** Derivado do `--numstat`: total de linhas adicionadas. */
  added: number;
  /** Derivado do `--numstat`: total de linhas removidas. */
  removed: number;
  /** Nº de arquivos no diff (linhas do `--numstat`). */
  files: number;
  /**
   * Cópia (só bytes, sem `.git`) do estado FINAL do agente — presente só com
   * `keepSnapshot`. É a base do sandbox verificador; quem pediu apaga.
   */
  snapshotDir?: string;
}

/** ONDE roda o `setup[]` (IMPL-038). Default: host explícito, sem isolamento. */
export interface PrepareOpts {
  /**
   * Fábrica do runner, chamada com o `workspaceDir` recém-criado (o sandbox
   * monta exatamente esse diretório em `/ws`).
   */
  setupRunner?: (workspaceDir: string) => CommandRunner;
}

/**
 * O ciclo de vida git de UMA execução — ver PLANO-AGENT-ARENA §10 / §13 / C.3.
 */
export interface WorkspaceManager {
  /**
   * Prepara o workspace de UMA execução a partir da tarefa: cria/cacheia o
   * repo-semente (bare, por hash de (url|path, ref)), um worktree efêmero
   * `--detach`, roda `setup[]` e grava `files[]`, e por fim faz o `seedCommit`.
   */
  prepare(
    task: {
      repo?: AgentTaskSpec['repo'];
      setup?: AgentTaskSpec['setup'];
      files?: AgentTaskSpec['files'];
      limits?: AgentLimits;
    },
    opts?: PrepareOpts,
  ): Promise<PreparedWorkspace>;

  /**
   * Depois de o agente rodar: copia a árvore (só bytes, sem `.git`), commita a
   * CÓPIA no repo de auditoria e colhe o artefato. NUNCA roda git no `.git` do
   * workspace nem o oráculo (é de outro módulo).
   */
  collect(
    workspaceDir: string,
    seedCommit: string,
    maxDiffBytes?: number,
    opts?: { keepSnapshot?: boolean },
  ): Promise<CollectResult>;

  /** Derruba o workspace e faz prune do cache. Use num `finally`/`try/finally`. */
  dispose(cacheRepoDir: string, workspaceDir: string): Promise<void>;
}

export function createWorkspaceManager(opts: {
  /** Raiz do cache do seed — quem chama passa o cacheDir DA RUN (clone é uma vez por run). */
  cacheDir: string;
}): WorkspaceManager {
  const { cacheDir } = opts;
  // workspaceDir → auditGitDir (o `collect`/`dispose` mantêm a assinatura antiga).
  const auditByWorkspace = new Map<string, string>();

  return {
    async prepare(task, prepareOpts) {
      const limits = task.limits;
      const workspaceDir = freshWorkspaceDir();
      let auditGitDir = '';

      // --- 1. repo-semente (cacheado) OU workspace vazio — §13.1 / §13.3.
      // Endereçamento do cache por hash de (url|path, ref): o MESMO repo com
      // refs diferentes é um seed diferente, e dois sources iguais nunca pagam
      // clone duas vezes na mesma run.
      let cacheRepoDir = cacheDir;
      let repoRooted = false; // true quando o workspace é um worktree linkado
      const repo = task.repo;
      if (repo) {
        const source = repo.url ?? repo.path;
        if (!source) {
          throw new Error('tarefa com repo mas sem url nem path (inválida)');
        }
        const hash = hashKey(`${source}:${repo.ref}`);
        cacheRepoDir = path.join(cacheDir, hash);
        // Se a pasta já é um repo bare válido, é reaproveitamento dentro da mesma
        // run — não reclona. (NÃO testar só `exists`: acabamos de mkdir abaixo.)
        const alreadyCached = pathExists(path.join(cacheRepoDir, 'HEAD'));
        mkdirSync(cacheRepoDir, { recursive: true });
        if (!alreadyCached) {
          await seedClone(source, repo.ref, repo.shallow, cacheRepoDir, limits);
        }

        // --- 2. worktree efêmero por execução, SEMPRE --detach — regra 2.
        // Worktrees não compartilham branch: um agente que commita numa branch
        // compartilhada corromperia a execução vizinha. E quando o source é um
        // PATH LOCAL, já clonamos para o cache acima — o agente (com bash) nunca
        // enxerga o repo real do usuário (git checkout / git clean -xdf na raiz).
        await git(
          ['-C', cacheRepoDir, 'worktree', 'add', '--detach', workspaceDir, repo.ref],
          cacheRepoDir,
          limits,
        );
        repoRooted = true;
      } else {
        // Sem repo => workspace vazio (`git init` + commit vazio) — §13.3.
        // A definição de artefato permanece idêntica: diff contra o commit vazio
        // = tudo o que o agente criou.
        // (sem `git init` aqui: o `.git` do agente é o clone do passo 5)
      }

      try {
        // --- 3. setup[] — ANTES do seedCommit (regra 3 / §10.1).
        // Rodar setup antes do commit faz o `node_modules` do npm ci etc. NÃO
        // aparecer no diff do agente — o diff mede O QUE O AGENTE FEZ, não o que
        // o ambiente trouxe. `{ shell: false }`: o prompt vem da config da
        // tarefa e `shell: true` seria injeção de comando (§11.2). ONDE roda é do
        // runner (IMPL-038): "é só npm ci" executa scripts do repo — em modo
        // container isso acontece no sandbox, nunca no host.
        if (task.setup?.length) {
          const runner = prepareOpts?.setupRunner?.(workspaceDir) ?? hostCommandRunner();
          for (const step of task.setup) {
            const argv = splitCommandLine(step.cmd);
            if (argv.length === 0) continue;
            let out = '';
            const r = await runner.exec({
              argv,
              cwd: workspaceDir,
              timeoutMs: step.timeoutMs,
              onOutput: (b) => {
                out = (out + b.toString('utf8')).slice(-4000);
              },
            });
            if (r.code !== 0 || r.spawnFailed) {
              throw new Error(
                `setup falhou no comando ${step.cmd}: exit ${r.code ?? r.signal ?? r.error}` +
                  (out ? `\nsaída: ${out.slice(-2000)}` : '') +
                  (r.error ? `\nerro: ${r.error}` : ''),
              );
            }
          }
        }

        // --- 3b. files[] — fixtures escritos depois do setup.
        // Sem seguir symlink (IMPL-038): o setup, que pode ter rodado no
        // sandbox, não desvia a escrita do host para fora do workspace.
        if (task.files) {
          for (const f of task.files) writeFileNoFollow(workspaceDir, f.path, f.content);
        }

        // --- 4. seedCommit — a régua do diff (§10.1), no repo de AUDITORIA.
        // O setup acima pode ter escrito no `.git` do workspace (hooks, config
        // com filtro): o seed sai de uma CÓPIA da árvore, commitada num
        // `--git-dir` que só o produto escreveu. `add -A` respeita o .gitignore
        // da árvore, como antes.
        auditGitDir = mkdtempSync(path.join(tmpdir(), 'pb-audit-git-'));
        await safeGitOrThrow(['init', '--bare', '-q', '--initial-branch=main', auditGitDir]);
        const seedCommit = await snapshotCommit(auditGitDir, workspaceDir, null, 'seed', limits);
        await safeGitOrThrow(['--git-dir', auditGitDir, 'update-ref', 'refs/heads/main', seedCommit]);

        // --- 5. o `.git` do AGENTE: clone limpo do repo de auditoria (HEAD =
        // seed). Some o gitfile do worktree (que apontava para um caminho do
        // host) e qualquer coisa que o setup tenha plantado no `.git`.
        await giveAgentFreshGit(auditGitDir, workspaceDir);

        auditByWorkspace.set(workspaceDir, auditGitDir);
        return { workspaceDir, seedCommit, cacheRepoDir, auditGitDir };
      } catch (err) {
        // Se a preparação falhou, não deixe worktree (ou init parcial) órfão.
        await teardownWorkspace(cacheRepoDir, workspaceDir, repoRooted).catch(() => {});
        if (auditGitDir) rmSync(auditGitDir, { recursive: true, force: true });
        throw err;
      }
    },

    async collect(workspaceDir, seedCommit, maxDiffBytes, collectOpts) {
      const maxDiff = maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
      const auditGitDir = auditByWorkspace.get(workspaceDir);
      if (!auditGitDir) {
        throw new Error(`collect sem repo de auditoria para ${workspaceDir} (o workspace não veio deste prepare)`);
      }

      // --- 5/10.2 (IMPL-038) — cópia de árvore + git do PRODUTO na cópia.
      // Nunca `git add/commit` no `.git` do agente: ali ele pode ter plantado
      // `pre-commit`, `core.fsmonitor`, pager, filtros (vetor GitSpawn). A cópia
      // só lê bytes e deixa todo `.git` de fora; o commit `agent-result` é
      // plumbing sobre o `--git-dir` de auditoria, com o seed como pai — o diff
      // `seed..result` captura criações, remoções e renomeações sem exceção.
      const snapshotDir = mkdtempSync(path.join(tmpdir(), 'pb-collect-'));
      let keep = false;
      try {
        const safeSeed = /^[0-9a-f]{40}$/i.test(seedCommit)
          ? seedCommit
          : await safeGitOrThrow(['--git-dir', auditGitDir, 'rev-parse', `${seedCommit}^{commit}`]);
        const commitSha = await snapshotCommit(auditGitDir, workspaceDir, safeSeed, 'agent-result', undefined, snapshotDir);
        await safeGitOrThrow(['--git-dir', auditGitDir, 'update-ref', 'refs/heads/agent-result', commitSha]);

        const range = [safeSeed, commitSha];
        const base = ['--git-dir', auditGitDir, 'diff', '--no-color', '--no-ext-diff', '--no-textconv'];
        const [diffOut, numstat, nameStatus] = await Promise.all([
          safeGit([...base, ...range]),
          safeGit([...base, '--numstat', ...range]),
          safeGit([...base, '--name-status', ...range]),
        ]);
        const statText = numstat.stdout;
        const parsed = parseNumstat(statText);
        const nsList = parseNameStatus(nameStatus.stdout);

        // Truncamento por bytes, NUNCA cortando em silêncio (regra 5).
        let diff = diffOut.stdout;
        let diffTruncated = false;
        if (Buffer.byteLength(diff, 'utf8') > maxDiff) {
          const marker = `[... ${Buffer.byteLength(diff, 'utf8') - maxDiff} bytes omitidos ...]`;
          diff = Buffer.from(diff, 'utf8').subarray(0, maxDiff).toString('utf8') + '\n' + marker;
          diffTruncated = true;
        }

        keep = collectOpts?.keepSnapshot === true;
        return {
          commitSha,
          diff,
          diffTruncated,
          statText,
          nameStatus: nsList,
          added: parsed.added,
          removed: parsed.removed,
          files: parsed.files,
          ...(keep ? { snapshotDir } : {}),
        };
      } finally {
        if (!keep) rmSync(snapshotDir, { recursive: true, force: true });
      }
    },

    async dispose(cacheRepoDir, workspaceDir) {
      const audit = auditByWorkspace.get(workspaceDir);
      auditByWorkspace.delete(workspaceDir);
      if (audit) rmSync(audit, { recursive: true, force: true });
      await teardownWorkspace(cacheRepoDir, workspaceDir, true);
    },
  };
}

/**
 * Snapshot de uma árvore no repo de AUDITORIA: copia `srcDir` (só bytes, sem
 * `.git`, symlink recriado sem seguir) para `intoDir` (ou um tmp descartável),
 * monta um índice próprio com `add -A` e fecha o commit por PLUMBING
 * (`write-tree` + `commit-tree`) — nenhum hook existe nem dispara. O `.git` de
 * `srcDir` nunca é lido.
 */
async function snapshotCommit(
  auditGitDir: string,
  srcDir: string,
  parent: string | null,
  message: string,
  limits?: AgentLimits,
  intoDir?: string,
): Promise<string> {
  const copyDir = intoDir ?? mkdtempSync(path.join(tmpdir(), 'pb-snap-'));
  const indexFile = path.join(mkdtempSync(path.join(tmpdir(), 'pb-snap-idx-')), 'index');
  try {
    copyTreeBytes(srcDir, copyDir, { symlinks: 'recreate', excludeGit: true });
    const env = { GIT_INDEX_FILE: indexFile };
    const t = limits?.timeoutMs;
    await safeGitOrThrow(['--git-dir', auditGitDir, '--work-tree', copyDir, 'add', '-A'], { env, timeoutMs: t });
    const tree = await safeGitOrThrow(['--git-dir', auditGitDir, 'write-tree'], { env, timeoutMs: t });
    return await safeGitOrThrow(
      ['--git-dir', auditGitDir, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message],
      { env, timeoutMs: t },
    );
  } finally {
    rmSync(path.dirname(indexFile), { recursive: true, force: true });
    if (!intoDir) rmSync(copyDir, { recursive: true, force: true });
  }
}

/**
 * Troca o `.git` do workspace por um clone LIMPO do repo de auditoria (HEAD =
 * seed, índice = seed, sem remote apontando para o host). O agente segue
 * acordando "dentro de um repositório git REAL" — e o que ele fizer com ele
 * não volta ao host: o `collect()` não o lê.
 */
async function giveAgentFreshGit(auditGitDir: string, workspaceDir: string): Promise<void> {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pb-wsgit-'));
  try {
    const clone = path.join(tmp, 'r');
    await safeGitOrThrow(['clone', '-q', '--no-checkout', '--no-hardlinks', auditGitDir, clone]);
    const gitDir = path.join(workspaceDir, '.git');
    rmSync(gitDir, { recursive: true, force: true });
    cpSync(path.join(clone, '.git'), gitDir, { recursive: true });
    await safeGitOrThrow(['--git-dir', gitDir, 'remote', 'remove', 'origin']);
    await safeGitOrThrow(['--git-dir', gitDir, '--work-tree', workspaceDir, 'read-tree', 'HEAD']);
    await safeGitOrThrow(['--git-dir', gitDir, 'config', 'user.name', GIT_IDENTITY.name]);
    await safeGitOrThrow(['--git-dir', gitDir, 'config', 'user.email', GIT_IDENTITY.email]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Derruba o workspace (melhor esforço) — regra 6.
 * `git -C <cache> worktree remove --force <ws>` + `git worktree prune`, e NÃO
 * `git worktree prune` na raiz de UM repo principal (fronteira proibida). O
 * `repoRooted` false cobre o workspace `git init` (não é worktree linkado; só
 * remove o diretório).
 */
async function teardownWorkspace(
  cacheRepoDir: string,
  workspaceDir: string,
  repoRooted: boolean,
): Promise<void> {
  // O `.git` do workspace foi trocado por um clone limpo (IMPL-038) e pode ter
  // sido reescrito pelo agente: NENHUM git roda nele. Apaga o diretório primeiro
  // e só então faz `worktree prune` NO CACHE (repo do produto) — o registro do
  // worktree some porque o caminho deixou de existir.
  rmSync(workspaceDir, { recursive: true, force: true });
  // Só num cache BARE de verdade: `git -C <dir>` num diretório que não é repo
  // subiria até um repo que o contenha (o `./data` dentro de um checkout).
  if (repoRooted && cacheRepoDir && pathExists(path.join(cacheRepoDir, 'HEAD'))) {
    try {
      await git(['-C', cacheRepoDir, 'worktree', 'prune'], cacheRepoDir);
    } catch {
      // cache pode não existir/repo corrompido — melhor esforço.
    }
  }
}

// ----------------------------------------------------------------------------
// Helpers de processo / git
// ----------------------------------------------------------------------------

/**
 * Sobe um processo com argv (nunca `shell: true`), drena os DOIS pipes desde o
 * primeiro byte (§11.3 — ignorar o stderr enche o buffer e trava o filho) e
 * dispõe da árvore inteira no timeout (§11.4 — matar o pid não mata os filhos).
 */
function runProcess(
  argv: string[],
  opts: { cwd: string; timeoutMs?: number },
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      shell: false,
      detached: true, // grupo próprio => dá para matar a árvore inteira
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    let timedOut = false;
    const timer =
      opts.timeoutMs != null
        ? setTimeout(() => {
            timedOut = true;
            try {
              process.kill(-(child.pid as number), 'SIGTERM'); // matar o GRUPO
            } catch {
              /* já morreu */
            }
          }, opts.timeoutMs)
        : undefined;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        try {
          process.kill(-(child.pid as number), 'SIGKILL'); // graça esgotada
        } catch {
          /* ok */
        }
      }
      resolve({ code, signal: timedOut ? 'timeout' : signal, stdout, stderr });
    });
  });
}

/** Roda `git <args>` no cwd dado. Nunca lança; devolve a saída bruta. */
async function git(args: string[], cwd: string, limits?: AgentLimits): Promise<ProcResult> {
  return runProcess(['git', ...args], { cwd, timeoutMs: limits?.timeoutMs });
}

/**
 * Clona o seed para o cache, uma vez por run — regra 1 / C.3.
 * Sempre `--bare --no-tags` (objeto-store compartilhado; N worktrees = N
 * checkouts, não N clones, §13.1). Quando `shallow` e a ref é branch/tag,
 * `--depth 1 --branch <ref>` (barato e suficiente). Shallow com sha exige o
 * objeto presente — cai para o clone completo (o sha de um clone full sempre
 * existe), sem perder correção.
 */
async function seedClone(
  source: string,
  ref: string,
  shallow: boolean | undefined,
  dest: string,
  limits?: AgentLimits,
): Promise<void> {
  const base: string[] = ['clone', '--bare', '--no-tags'];
  if (shallow && !isSha(ref)) {
    base.push('--depth', '1', '--branch', ref);
  }
  const r = await git([...base, source, dest], dest, limits);
  if (r.code !== 0) {
    throw new Error(`git clone do seed falhou (${source}): ${r.stderr}`);
  }
}

// ----------------------------------------------------------------------------
// Helpers de string / parse
// ----------------------------------------------------------------------------

/** Hash determinístico do endereço do seed. */
function hashKey(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** Nome absolutamente novo para o workspace, sob o tmp do sistema. */
function freshWorkspaceDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'agent-ws-'));
}

function pathExists(p: string): boolean {
  return existsSync(p);
}

// ----------------------------------------------------------------------------
// Fronteira: NÃO importamos `node:fs` no topo a não ser o que usamos. Abaixo só
// parse de texto determinístico.
// ----------------------------------------------------------------------------

/**
 * Quebra um comando em argv sem `shell: true` — regra 3 / §11.2. Suporta aspas
 * simples/duplas e escapes; usa a MESMA regra de argv do executor. Lança em
 * aspas não fechadas (um comando de config malformado deve falhar cedo, não
 * virar jogo de adivinhar).
 */
export function splitCommandLine(s: string): string[] {
  const argv: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) {
      cur += c;
      inToken = true;
      escaped = false;
      continue;
    }
    if (c === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
      inToken = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inToken = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      if (inToken) {
        argv.push(cur);
        cur = '';
        inToken = false;
      }
      continue;
    }
    cur += c;
    inToken = true;
  }
  if (escaped) cur += '\\';
  if (quote) throw new Error(`aspas não fechadas no comando: ${s}`);
  if (inToken) argv.push(cur);
  return argv;
}

/** true se `ref` parece um sha completo (40 hex). */
function isSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

/** Soma de added/removed e contagem de files a partir do `--numstat`. */
function parseNumstat(stat: string): { added: number; removed: number; files: number } {
  let added = 0;
  let removed = 0;
  let files = 0;
  for (const line of stat.split('\n')) {
    if (line.trim().length === 0) continue;
    const parts = line.split('\t');
    // numstat: `<added>\t<removed>\t<path>`; em rename o path é `old => new`.
    if (parts.length < 2) continue;
    const a = Number.parseInt(parts[0], 10);
    const r = Number.parseInt(parts[1], 10);
    if (Number.isFinite(a)) added += a;
    if (Number.isFinite(r)) removed += r;
    files++;
  }
  return { added, removed, files };
}

/** Parse do `--name-status` em {path, status}. Renames viram 'R' com o path novo. */
function parseNameStatus(output: string): { path: string; status: 'A' | 'M' | 'D' | 'R' }[] {
  const out: { path: string; status: 'A' | 'M' | 'D' | 'R' }[] = [];
  for (const line of output.split('\n')) {
    if (line.trim().length === 0) continue;
    const parts = line.split('\t');
    const code = parts[0];
    if (code.length === 0) continue;
    if (code.startsWith('R') && parts.length >= 3) {
      out.push({ path: parts[2], status: 'R' });
      continue;
    }
    if (code.startsWith('C') && parts.length >= 3) {
      // copy = arquivo novo; o contrato não tem 'C', vira 'A'.
      out.push({ path: parts[2], status: 'A' });
      continue;
    }
    const status = mapStatus(code[0]);
    const p = parts.length >= 2 ? parts[parts.length - 1] : '';
    out.push({ path: p, status });
  }
  return out;
}

function mapStatus(c: string): 'A' | 'M' | 'D' | 'R' {
  switch (c) {
    case 'A':
      return 'A';
    case 'M':
      return 'M';
    case 'D':
      return 'D';
    case 'R':
      return 'R';
    default:
      // codes fora do contrato (T typechange, U unmerged, X/B…) — trata como
      // modificação conservadora; a lista continua honesta em count/files.
      return 'M';
  }
}