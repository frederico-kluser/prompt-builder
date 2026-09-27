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
// ⚠️ ESPELHO CLIENT-SIDE: NÃO existe. O navegador não tem `child_process`,
// filesystem nem git — o modo agente é impossível na SPA (§7.3 / §10 do plano).
// Não "consertar" essa assimetria.
// ----------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentLimits, AgentTaskSpec } from './types.js';

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
  /**
   * `git diff --name-status` parseado. Renames viram 'R' com o caminho novo e a
   * ORIGEM em `oldPath` (IMPL-039: renomear o arquivo protegido é tocá-lo).
   */
  nameStatus: { path: string; status: 'A' | 'M' | 'D' | 'R'; oldPath?: string }[];
  /** Derivado do `--numstat`: total de linhas adicionadas. */
  added: number;
  /** Derivado do `--numstat`: total de linhas removidas. */
  removed: number;
  /** Nº de arquivos no diff (linhas do `--numstat`). */
  files: number;
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
  prepare(task: {
    repo?: AgentTaskSpec['repo'];
    setup?: AgentTaskSpec['setup'];
    files?: AgentTaskSpec['files'];
    limits?: AgentLimits;
  }): Promise<PreparedWorkspace>;

  /**
   * Depois de o agente rodar: commita o resultado e colhe o artefato.
   * NUNCA roda o oráculo (é de outro módulo).
   */
  collect(
    workspaceDir: string,
    seedCommit: string,
    maxDiffBytes?: number,
  ): Promise<CollectResult>;

  /** Derruba o workspace e faz prune do cache. Use num `finally`/`try/finally`. */
  dispose(cacheRepoDir: string, workspaceDir: string): Promise<void>;
}

export function createWorkspaceManager(opts: {
  /** Raiz do cache do seed — quem chama passa o cacheDir DA RUN (clone é uma vez por run). */
  cacheDir: string;
}): WorkspaceManager {
  const { cacheDir } = opts;

  return {
    async prepare(task) {
      const limits = task.limits;
      const workspaceDir = freshWorkspaceDir();

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
        await git(['init'], workspaceDir, limits);
      }

      try {
        await setUpIdentity(workspaceDir);

        // --- 3. setup[] — ANTES do seedCommit (regra 3 / §10.1).
        // Rodar setup antes do commit faz o `node_modules` do npm ci etc. NÃO
        // aparecer no diff do agente — o diff mede O QUE O AGENTE FEZ, não o que
        // o ambiente trouxe. `{ shell: false }`: o prompt vem da config da
        // tarefa e `shell: true` seria injeção de comando (§11.2).
        if (task.setup) {
          for (const step of task.setup) {
            const argv = splitCommandLine(step.cmd);
            if (argv.length === 0) continue;
            const r = await runProcess(argv, {
              cwd: workspaceDir,
              timeoutMs: step.timeoutMs,
            });
            if (r.code !== 0) {
              throw new Error(
                `setup falhou no comando ${step.cmd}: exit ${r.code ?? r.signal}` +
                  (r.stderr ? `\nstderr: ${r.stderr.slice(-2000)}` : ''),
              );
            }
          }
        }

        // --- 3b. files[] — fixtures escritos depois do setup.
        if (task.files) {
          for (const f of task.files) {
            const abs = path.resolve(workspaceDir, f.path);
            mkdirSync(path.dirname(abs), { recursive: true });
            writeFileSync(abs, f.content, 'utf8');
          }
        }

        // --- 4. seedCommit — a régua do diff (§10.1).
        // `git add -A` respeita o .gitignore, mas o commit pós-setup resolve as
        // tarefas sem .gitignore decente sem depender da higiene do repo-semente.
        await git(['add', '-A'], workspaceDir, limits);
        await git(['commit', '--allow-empty', '-q', '-m', 'seed'], workspaceDir, limits);

        const seedCommit = await gitOrThrow(['rev-parse', 'HEAD'], workspaceDir, limits);
        return { workspaceDir, seedCommit, cacheRepoDir };
      } catch (err) {
        // Se a preparação falhou, não deixe worktree (ou init parcial) órfão.
        await teardownWorkspace(cacheRepoDir, workspaceDir, repoRooted).catch(() => {});
        throw err;
      }
    },

    async collect(workspaceDir, seedCommit, maxDiffBytes) {
      const maxDiff = maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
      await setUpIdentity(workspaceDir);

      // --- 5/10.2 — commitar o resultado é de graça e resolve arquivos novos.
      // `git add -A -N` + `git diff` tem casos-limite com renomeação/submódulo.
      // Como o workspace é descartável, `add -A && commit` é mais simples e faz
      // `diff seed..HEAD` capturar criações, remoções e renomeações sem exceção.
      await git(['add', '-A'], workspaceDir);
      await git(['commit', '--allow-empty', '-q', '-m', 'agent-result'], workspaceDir);
      const commitSha = await gitOrThrow(['rev-parse', 'HEAD'], workspaceDir);

      // regexp determinístico; seedCommit vem de `rev-parse` (hex) e não do usuário.
      const safeSeed = /^[0-9a-f]{40}$/i.test(seedCommit) ? seedCommit : await resolveRef(workspaceDir, seedCommit);

      const range = `${safeSeed}..HEAD`;
      const [diffOut, numstat, nameStatus] = await Promise.all([
        git(['diff', '--no-color', range], workspaceDir),
        git(['diff', '--no-color', '--numstat', range], workspaceDir),
        git(['diff', '--no-color', '--name-status', range], workspaceDir),
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

      return {
        commitSha,
        diff,
        diffTruncated,
        statText,
        nameStatus: nsList,
        added: parsed.added,
        removed: parsed.removed,
        files: parsed.files,
      };
    },

    async dispose(cacheRepoDir, workspaceDir) {
      await teardownWorkspace(cacheRepoDir, workspaceDir, true);
    },
  };
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
  if (repoRooted && cacheRepoDir && pathExists(cacheRepoDir)) {
    try {
      await git(['-C', cacheRepoDir, 'worktree', 'remove', '--force', workspaceDir], cacheRepoDir);
    } catch {
      // Já removido, ou não é worktree deste cache.
    }
    try {
      await git(['-C', cacheRepoDir, 'worktree', 'prune'], cacheRepoDir);
    } catch {
      // cache pode não existir/repo corrompido — melhor esforço.
    }
  }
  // Garante a remoção quando o workspace não era um worktree linkado.
  rmSync(workspaceDir, { recursive: true, force: true });
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

/** Variante que lança se o git falhar; devolve o stdout trimado. */
async function gitOrThrow(args: string[], cwd: string, limits?: AgentLimits): Promise<string> {
  const r = await git(args, cwd, limits);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(' ')} falhou: exit ${r.code ?? r.signal} ${r.stderr}`);
  }
  return r.stdout.trim();
}

/** Resolve ref -> sha (para o caso de um seedCommit passado como nome de tag). */
async function resolveRef(workspaceDir: string, ref: string): Promise<string> {
  return gitOrThrow(['rev-parse', `${ref}^{commit}`], workspaceDir);
}

/** Configura identidade git local no workspace (idempotente). */
async function setUpIdentity(dir: string): Promise<void> {
  await git(['config', 'user.name', GIT_IDENTITY.name], dir);
  await git(['config', 'user.email', GIT_IDENTITY.email], dir);
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

/** Parse do `--name-status` em {path, status, oldPath?}. Renames viram 'R' com o path novo e a origem em `oldPath`. */
export function parseNameStatus(output: string): { path: string; status: 'A' | 'M' | 'D' | 'R'; oldPath?: string }[] {
  const out: { path: string; status: 'A' | 'M' | 'D' | 'R'; oldPath?: string }[] = [];
  for (const line of output.split('\n')) {
    if (line.trim().length === 0) continue;
    const parts = line.split('\t');
    const code = parts[0];
    if (code.length === 0) continue;
    if (code.startsWith('R') && parts.length >= 3) {
      out.push({ path: parts[2], status: 'R', oldPath: parts[1] });
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