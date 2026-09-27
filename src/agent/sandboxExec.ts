// ----------------------------------------------------------------------------
// `sandboxExec.ts` — ONDE e COMO rodam os comandos que não são do produto
// (IMPL-038 / R-15 REC-4).
//
// Três peças, todas sem shell e sem ler segredo do host:
//
// 1. `CommandRunner` — a interface por onde passam `setup[]` e `verify[]`. Há
//    duas implementações: `hostCommandRunner()` (modo host EXPLÍCITO, marcado
//    `isolated: false` — sem Docker não há sandbox, e o record diz isso) e o
//    `sandboxCommandRunner()` de `container.ts` (um `docker run` endurecido NOVO
//    por comando). Quem escolhe é o `runAgentStage`, pela `isolation.kind`.
//    O host roda com env MÍNIMO (allowlist): um check que imprime o env não vê
//    `OPENROUTER_API_KEY` nem token nenhum do operador (caso E2).
//
// 2. `copyTreeBytes()` — o helper do host que SÓ LÊ BYTES: `lstat` em cada
//    entrada, arquivo regular copiado, symlink NUNCA seguido, dispositivo/FIFO/
//    socket ignorado e todo `.git` (em qualquer profundidade) fora. É assim que
//    o `collect()` e o verificador leem o estado final do agente sem executar
//    nada do que ele plantou (hooks, `core.fsmonitor`, pager — o vetor GitSpawn).
//
// 3. `safeGit()` — git do PRODUTO sobre um `--git-dir` que o agente nunca viu,
//    com config de sistema/global desligadas e hooks/fsmonitor anulados. É o
//    "fallback git --git-dir sobre cópia sem .git" do item: o diff sai de dois
//    snapshots (seed e resultado) da mesma árvore copiada.
//
// ⚠️ ESPELHO CLIENT-SIDE: NÃO existe (modo agente é impossível na SPA).
// ----------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ----------------------------------------------------------------------------
// Runner de comandos (setup[] / verify[])
// ----------------------------------------------------------------------------

/** Um comando de tarefa: argv já tokenizado, cwd no HOST (dentro do dir montado, no sandbox). */
export interface CommandExecRequest {
  argv: string[];
  /** Caminho no HOST. No sandbox, precisa estar sob o diretório montado. */
  cwd: string;
  timeoutMs?: number;
  /** Cada pedaço de stdout/stderr, na ordem em que chega (o oráculo guarda o rabo). */
  onOutput?: (chunk: Buffer) => void;
}

/** Saída crua — quem interpreta (oráculo/setup) decide o que é sucesso. */
export interface CommandExecResult {
  /** `null` = sem exit normal (morto por sinal/timeout). */
  code: number | null;
  signal: string | null;
  /** O comando nem subiu (binário ausente, falha do daemon). */
  spawnFailed: boolean;
  timedOut: boolean;
  /** Mensagem do erro de spawn, quando houve. */
  error?: string;
}

export interface CommandRunner {
  /** Onde o código roda. `host` = mesma máquina/uid do operador. */
  readonly where: 'host' | 'sandbox';
  /** `false` = nenhuma barreira entre o comando e o host (modo host explícito). */
  readonly isolated: boolean;
  exec(req: CommandExecRequest): Promise<CommandExecResult>;
}

/** Variáveis do host que um comando de tarefa pode ver no modo host. NUNCA segredos. */
const HOST_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TERM'];

/**
 * Env mínimo dos comandos de tarefa no modo host: allowlist, não denylist — um
 * nome de segredo novo (`FOO_CREDENTIALS`) não vaza por esquecimento.
 */
export function hostMinimalEnv(src: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of HOST_ENV_ALLOWLIST) {
    const v = src[k];
    if (typeof v === 'string') env[k] = v;
  }
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  env.GIT_TERMINAL_PROMPT = '0';
  env.CI = '1';
  return env;
}

// Contador de execuções de comando de tarefa NO HOST (processo inteiro). É a
// régua do critério "execuções de código do agente no host = 0" no modo
// container: todo `setup[]`/`verify[]` no host passa por `hostCommandRunner`.
let hostExecutions = 0;

/** Quantos comandos de tarefa rodaram no host desde o início do processo. */
export function hostCommandExecutions(): number {
  return hostExecutions;
}

/**
 * Modo host EXPLÍCITO — sem Docker, SEM ISOLAMENTO (`isolated: false`). O código
 * da tarefa/agente roda com o uid do operador; a única defesa aqui é o env
 * mínimo. O `runAgentStage` registra isso no `exec.json` (`sandbox.isolated`).
 */
export function hostCommandRunner(opts: { env?: Record<string, string> } = {}): CommandRunner {
  const env = opts.env ?? hostMinimalEnv();
  return {
    where: 'host',
    isolated: false,
    exec: (req) => {
      hostExecutions += 1;
      return spawnCollect(req.argv, { cwd: req.cwd, env, timeoutMs: req.timeoutMs, onOutput: req.onOutput });
    },
  };
}

/**
 * Spawn sem shell, grupo próprio (kill da árvore no timeout), os DOIS pipes
 * drenados desde o 1º byte. Nunca rejeita: falha de spawn vira `spawnFailed`.
 */
export function spawnCollect(
  argv: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs?: number;
    onOutput?: (chunk: Buffer) => void;
    /** Gancho extra no timeout (ex.: matar o container por nome). */
    onTimeout?: () => void;
  },
): Promise<CommandExecResult> {
  return new Promise((resolve) => {
    if (argv.length === 0 || !argv[0]) {
      resolve({ code: null, signal: null, spawnFailed: true, timedOut: false, error: 'comando vazio' });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env,
        shell: false, // NUNCA true: o cmd vem de config da tarefa
        detached: true, // grupo próprio => kill(-pid) derruba a árvore
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: null, signal: null, spawnFailed: true, timedOut: false, error: (err as Error).message });
      return;
    }
    let spawnError: string | undefined;
    let timedOut = false;
    child.stdout?.on('data', (b: Buffer) => opts.onOutput?.(b));
    child.stderr?.on('data', (b: Buffer) => opts.onOutput?.(b));
    const timer =
      opts.timeoutMs != null
        ? setTimeout(() => {
            timedOut = true;
            try {
              opts.onTimeout?.();
            } catch {
              /* melhor esforço */
            }
            try {
              process.kill(-(child.pid as number), 'SIGTERM');
            } catch {
              /* o grupo já morreu */
            }
          }, opts.timeoutMs)
        : undefined;
    child.on('error', (err) => {
      spawnError = err.message;
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
      resolve({
        code,
        signal: timedOut ? 'timeout' : signal,
        spawnFailed: spawnError !== undefined,
        timedOut,
        ...(spawnError !== undefined ? { error: spawnError } : {}),
      });
    });
  });
}

// ----------------------------------------------------------------------------
// Cópia de árvore que só lê bytes
// ----------------------------------------------------------------------------

export interface CopyTreeResult {
  files: number;
  bytes: number;
  symlinks: number;
  /** Caminhos relativos ignorados (dispositivo, FIFO, socket, symlink em modo 'skip', `.git`). */
  skipped: string[];
}

/**
 * Copia `src` → `dst` lendo SÓ bytes: `lstat` por entrada; arquivo regular vira
 * cópia (reflink quando o FS deixa) com os bits rwx e SEM setuid/setgid;
 * symlink é recriado como symlink (`'recreate'`) ou descartado (`'skip'`) —
 * NUNCA seguido, então um link para `~/.ssh` não traz um byte de lá. Diretório
 * `.git` (ou arquivo `.git` de worktree) é excluído em QUALQUER profundidade: o
 * `.git` do agente é código dele (hooks, fsmonitor, filtros) e um `.git`
 * aninhado viraria submódulo que o git do host inspecionaria.
 */
export function copyTreeBytes(
  src: string,
  dst: string,
  opts: {
    symlinks?: 'recreate' | 'skip';
    excludeGit?: boolean;
    /** Teto de bytes copiados; o que passar vira `skipped` (copy-out de sessão). */
    maxBytes?: number;
  } = {},
): CopyTreeResult {
  const symlinks = opts.symlinks ?? 'recreate';
  const maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY;
  const excludeGit = opts.excludeGit ?? true;
  const out: CopyTreeResult = { files: 0, bytes: 0, symlinks: 0, skipped: [] };
  mkdirSync(dst, { recursive: true });

  const walk = (rel: string): void => {
    const from = rel ? path.join(src, rel) : src;
    let names: string[];
    try {
      names = readdirSync(from);
    } catch {
      out.skipped.push(rel || '.');
      return;
    }
    for (const name of names.sort()) {
      const childRel = rel ? path.join(rel, name) : name;
      if (excludeGit && name === '.git') {
        out.skipped.push(childRel);
        continue;
      }
      const s = path.join(src, childRel);
      const d = path.join(dst, childRel);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(s);
      } catch {
        out.skipped.push(childRel);
        continue;
      }
      if (st.isDirectory()) {
        mkdirSync(d, { recursive: true, mode: 0o755 });
        walk(childRel);
        chmodSync(d, (st.mode & 0o777) | 0o700); // dono sempre consegue apagar
      } else if (st.isFile()) {
        if (out.bytes + st.size > maxBytes) {
          out.skipped.push(childRel);
          continue;
        }
        copyFileSync(s, d, fsConstants.COPYFILE_FICLONE);
        chmodSync(d, (st.mode & 0o777) | 0o600);
        out.files += 1;
        out.bytes += st.size;
      } else if (st.isSymbolicLink()) {
        if (symlinks === 'skip') {
          out.skipped.push(childRel);
          continue;
        }
        symlinkSync(readlinkSync(s), d);
        out.symlinks += 1;
      } else {
        out.skipped.push(childRel); // FIFO, socket, dispositivo
      }
    }
  };
  walk('');
  return out;
}

// ----------------------------------------------------------------------------
// git do produto sobre um --git-dir confiável
// ----------------------------------------------------------------------------

/** Identidade dos commits de auditoria (não depende do `user.*` do host). */
export const AUDIT_GIT_IDENTITY = { name: 'agent-arena', email: 'agent-arena@local' };

/**
 * Env do git de AUDITORIA: sem config de sistema/global (`GIT_CONFIG_NOSYSTEM`,
 * `GIT_CONFIG_GLOBAL=/dev/null`) — só a config do `--git-dir` que o produto
 * criou vale. Sem prompt de terminal, sem pager.
 */
export function safeGitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_AUTHOR_NAME: AUDIT_GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: AUDIT_GIT_IDENTITY.email,
    GIT_COMMITTER_NAME: AUDIT_GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: AUDIT_GIT_IDENTITY.email,
    ...extra,
  };
}

/** `-c` que anulam o que ainda pudesse executar código a partir de config. */
const SAFE_GIT_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '--no-pager'];

export interface SafeGitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * `git <SAFE_GIT_FLAGS> <args>` com `safeGitEnv`. O cwd é neutro (tmp do
 * sistema) por padrão: o git nunca descobre repositório pelo cwd — quem chama
 * passa `--git-dir` (e `--work-tree` numa CÓPIA) explicitamente.
 */
export function safeGit(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<SafeGitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...SAFE_GIT_FLAGS, ...args], {
      cwd: opts.cwd ?? tmpdir(),
      env: safeGitEnv(opts.env),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    const timer = opts.timeoutMs != null ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : undefined;
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

/** Variante que lança se o git falhar; devolve o stdout trimado. */
export async function safeGitOrThrow(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<string> {
  const r = await safeGit(args, opts);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(' ')} falhou: exit ${r.code} ${r.stderr.slice(-2000)}`);
  }
  return r.stdout.trim();
}

/**
 * Escreve `content` em `root/rel` SEM seguir symlink em nenhum componente: um
 * link (ou arquivo) plantado pelo agente no caminho é removido e trocado por
 * diretório/arquivo reais. É assim que os fixtures PRÍSTINOS da tarefa entram
 * na cópia do verificador sem que `tests -> /home/<user>` desvie a escrita para
 * fora dela. Lança se `rel` escapar de `root`.
 */
export function writeFileNoFollow(root: string, rel: string, content: string): void {
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  const relNorm = path.relative(base, target);
  if (!relNorm || relNorm.startsWith('..') || path.isAbsolute(relNorm)) {
    throw new Error(`caminho de fixture fora do workspace: ${rel}`);
  }
  const parts = relNorm.split(path.sep);
  let cur = base;
  for (const part of parts.slice(0, -1)) {
    cur = path.join(cur, part);
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(cur);
    } catch {
      st = undefined;
    }
    if (st && !st.isDirectory()) rmSync(cur, { force: true, recursive: true });
    if (!st || !st.isDirectory()) mkdirSync(cur, { mode: 0o755 });
  }
  try {
    const st = lstatSync(target);
    if (!st.isFile()) rmSync(target, { force: true, recursive: true });
  } catch {
    /* não existe */
  }
  // O que não era arquivo regular já foi removido; arquivo regular é sobrescrito.
  writeFileSync(target, content, 'utf8');
}
