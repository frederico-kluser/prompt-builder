// ----------------------------------------------------------------------------
// `container.ts` — TODA a interação com o Docker do modo agente.
//
// Este módulo é a ÚNICA ponte entre o motor e o daemon do Docker. Nenhum
// `docker` é chamado fora daqui (regra da onda 2): `pi.ts` pede, este módulo
// executa. A interação é sempre via `spawn` sem shell, com `env` mínimo do host
// (o CLI do docker precisa de PATH/HOME, NUNCA dos segredos do agente).
//
// O que este módulo entrega para UMA execução `isolation.kind==='container'`:
//   1. `ensurePiImage(version)` — a imagem `prompt-builder-pi:<version>`,
//      buildada uma vez e CACHEADA por tag (não recria se existir). `isolation.
//      image` sobrescreve a tag.
//   2. `writeEnvFile(entries)` — o env-file do host (os.tmpdir(), chmod 0600)
//      por onde a key do OpenRouter e as `PI_*` chegam ao container. Nunca em
//      argv/artefato/volume.
//   3. `buildDockerArgv(...)` — monta o argv do `docker run`.
//   4. `killContainer(name)` — `docker kill` + `docker rm -f`, idempotente.
//
// Fonte da receita: SPIKE-CONTAINER.md (onda 1) — o `docker run` precisa de
// `-i` (sem isso o stdin pipeado não chega ao container e o pi sai exit 0 sem
// nada), os limites `-m 2g --pids-limit 512`, `/ws`+`/exec` mountados (os
// artefatos aparecem no host sem `docker cp`), e o kill = `docker kill` +
// `docker rm -f` (o `--rm` cobre só o exit normal; `docker kill` deixa o
// container "Dead" por ~1 s sem a remoção explícita).
// ----------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// ----------------------------------------------------------------------------
// Constantes documentadas (SPIKE-CONTAINER.md §"Para o produtor")
// ----------------------------------------------------------------------------

/** Padrão de tag da imagem do pi: `prompt-builder-pi:<piVersion>`. */
export const PI_IMAGE_PATTERN = /^prompt-builder-pi:[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Tag DEFAULT (sem `isolation.image`). `opts.image` sobrescreve. */
export function defaultPiImageTag(version: string): string {
  return `prompt-builder-pi:${version}`;
}

/** Limite de memória do container (SPIKE: `-m 2g`). */
export const CONTAINER_MEM_LIMIT = '2g';
/** Limite de processos do container (SPIKE: `--pids-limit 512`). */
export const CONTAINER_PIDS_LIMIT = 512;

/** Prefixo do nome do container (único por execução: `pb-agent-<execId>`). */
export const CONTAINER_NAME_PREFIX = 'pb-agent-';
/** Prefixo do arquivo env-file no os.tmpdir(). */
export const ENV_FILE_PREFIX = 'pb-agent-';
/** Caminho do env-file mascarado no `argv.json` de auditoria. */
export const ENV_FILE_MASK = '<env-file-tmp-0600>';

/** Timeout do `docker build` da imagem do pi (minutos de apt-get + npm -g). */
export const BUILD_TIMEOUT_MS = 600_000;
/** Timeout do `docker image inspect` (checagem de existência; rápido). */
export const INSPECT_TIMEOUT_MS = 30_000;
/** Timeout do `docker run --rm <tag> pi --version` (validação da imagem). */
export const VERIFY_TIMEOUT_MS = 60_000;
/** Timeout de cada killer (`docker kill` / `docker rm -f`). Curto — é socorro. */
export const KILL_TIMEOUT_MS = 10_000;

/** Caminho do working dir do pi DENTRO do container (mount `-v <workDir>:/exec`). */
export const CONTAINER_EXEC_DIR = '/exec';
/** Caminho da casa do pi dentro do container (mount em `/exec/pi-home`). */
export const CONTAINER_PI_HOME_DIR = `${CONTAINER_EXEC_DIR}/pi-home`;
/** Caminho do diretório de sessão dentro do container. */
export const CONTAINER_SESSION_DIR = `${CONTAINER_EXEC_DIR}/session`;
/** Caminho do workspace dentro do container (mount `-v <workspaceDir>:/ws`). */
export const CONTAINER_WS_DIR = '/ws';

// ----------------------------------------------------------------------------
// Spawn simples (nunca shell) — estilo `runSimple` de pi.ts
// ----------------------------------------------------------------------------

interface SimpleResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** Spawn único, `shell:false`, pipes drenados, timeout com kill de grupo. */
function runDocker(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; stdin?: string },
): Promise<SimpleResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.stdin.on('error', () => undefined); // EPIPE se o filho já saiu (docker run sem stdin híbrido)
    child.stdin.end(opts.stdin ?? ''); // sempre fecha o stdin (EOF)
    let timedOut = false;
    const timer =
      opts.timeoutMs != null
        ? setTimeout(() => {
            timedOut = true;
            try {
              process.kill(-(child.pid as number), 'SIGKILL');
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
      resolve({ code, signal: timedOut ? 'timeout' : signal, stdout, stderr });
    });
  });
}

/** Env MÍNIMO do host para o CLI do docker — NUNCA os segredos/PI_* do agente. */
export function dockerCliEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
    HOME: process.env.HOME ?? tmpdir(), // docker no host: usa o /tmp do user como fallback
  };
  if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST;
  return { ...env, ...extra };
}

// ----------------------------------------------------------------------------
// Dockerfile embutido (template com a versão)
// ----------------------------------------------------------------------------

/**
 * Gera o conteúdo do Dockerfile para a versão pinada do pi. Contexto de build =
 * diretório tmp LIMPO contendo SÓ este arquivo (lição do probe da onda 1 que
 * falhou com contexto sujo). `node:22-bookworm-slim` + git/ca/certificados/bash
 * (o pi precisa do git para o workspace) + `npm install -g` da versão pinada.
 */
export function dockerfileContent(version: string): string {
  return [
    'FROM node:22-bookworm-slim',
    'RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates bash && rm -rf /var/lib/apt/lists/*',
    `RUN npm install -g @earendil-works/pi-coding-agent@${version}`,
    'CMD ["pi", "--version"]',
    '',
  ].join('\n');
}

// ----------------------------------------------------------------------------
// Imagem
// ----------------------------------------------------------------------------

/**
 * Garante que a imagem do pi existe e devolve a TAG a usar.
 *
 * - `opts.image` sobrescreve a tag default (`prompt-builder-pi:<version>`).
 * - `docker image inspect <tag>` silencioso: se a imagem existe, NÃO rebuilda
 *   (imagem CACHEADA por tag — o padrão "não recria se existir").
 * - Builda com Dockerfile embutido num contexto tmp LIMPO, env de build =
 *   `process.env` (o npm precisa de rede), log em `<runDir>/docker-build.log`.
 * - Ao fim valida com `docker run --rm <tag> pi --version` (1ª linha == version).
 */
export async function ensurePiImage(
  version: string,
  opts: { image?: string; runDir?: string } = {},
): Promise<string> {
  const tag = opts.image ?? defaultPiImageTag(version);

  // Existência por `inspect` silencioso (stdout/stderr descartados).
  const inspect = await runDocker(['docker', 'image', 'inspect', tag], {
    env: dockerCliEnv(),
    timeoutMs: INSPECT_TIMEOUT_MS,
  });
  if (inspect.code === 0) {
    return tag; // imagem já em cache — não rebuilda
  }

  // Build com contexto tmp LIMPO (só o Dockerfile) + log persistido.
  const ctxDir = path.join(tmpdir(), `pb-build-${randomUUID()}`);
  mkdirSync(ctxDir, { recursive: true });
  writeFileSync(path.join(ctxDir, 'Dockerfile'), dockerfileContent(version), 'utf8');
  const buildLogPath = opts.runDir ? path.join(opts.runDir, 'docker-build.log') : undefined;
  if (buildLogPath) {
    mkdirSync(path.dirname(buildLogPath), { recursive: true });
  }
  try {
    const buildArgv = ['docker', 'build', '-t', tag, '-f', path.join(ctxDir, 'Dockerfile'), ctxDir];
    // Env de build = process.env (o `npm install -g` precisa de rede/HOME do
    // host). `process.env` é `ProcessEnv` (valores `string | undefined`) — filtra
    // os ausentes para caber em `Record<string,string>`.
    const buildEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) buildEnv[k] = v;
    }
    const build = await runDocker(buildArgv, {
      env: buildEnv,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    if (buildLogPath) {
      writeFileSync(buildLogPath, `> ${buildArgv.join(' ')}\n${build.stdout}${build.stderr}`, 'utf8');
    }
    if (build.code !== 0) {
      throw new Error(
        `docker build da imagem do pi falhou (${tag}): ${build.code ?? build.signal} ${build.stderr.slice(-1500)}`,
      );
    }
  } finally {
    rmSync(ctxDir, { recursive: true, force: true });
  }

  // Valida a imagem recém-buildada: `docker run --rm <tag> pi --version`.
  const verify = await runDocker(
    ['docker', 'run', '--rm', tag, 'pi', '--version'],
    { env: dockerCliEnv(), timeoutMs: VERIFY_TIMEOUT_MS },
  );
  if (verify.code !== 0) {
    throw new Error(
      `imagem ${tag} não respondeu pi --version: ${verify.code ?? verify.signal} ${verify.stderr.slice(-1000)}`,
    );
  }
  const firstLine = verify.stdout.split('\n')[0].trim();
  // A imagem pode responder uma versão com prefixo `v` (ex.: `v0.84.2`); o
  // `pi --version` do núcleo imprime a versão limpa — aceitamos prefixo `v`.
  if (firstLine !== version && firstLine !== `v${version}` && firstLine !== version.replace(/^v/, '')) {
    throw new Error(
      `imagem ${tag} respondeu pi --version "${firstLine}", esperado "${version}" — imagem corrompida/cache obsoleto`,
    );
  }
  return tag;
}

// ----------------------------------------------------------------------------
// env-file do host (NUNCA dentro de volume/container/argv)
// ----------------------------------------------------------------------------

/** Regex de nome de variável válido (POSIX env): `^[A-Za-z_][A-Za-z0-9_]*$`. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Grava o env-file do container em `os.tmpdir()` (fora dos volumes), chmod 0600,
 * formato `KEY=VALUE\n`. Valida chaves (`^[A-Za-z_][A-Za-z0-9_]*$`) e rejeita
 * valores com `\n` (quebraria o formato). A REMOÇÃO fica no `finally` do `run`.
 * Devolve o caminho absoluto do arquivo.
 */
export function writeEnvFile(entries: Record<string, string>): string {
  const file = path.join(tmpdir(), `${ENV_FILE_PREFIX}${randomUUID()}.env`);
  const lines: string[] = [];
  for (const [k, v] of Object.entries(entries)) {
    if (!ENV_KEY_RE.test(k)) throw new Error(`env-file: chave Docker inválida "${k}"`);
    if (v.includes('\n')) throw new Error(`env-file: valor da chave "${k}" contém quebra de linha`);
    lines.push(`${k}=${v}`);
  }
  writeFileSync(file, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  chmodSync(file, 0o600); // garante 0600 mesmo se o umask interferir
  return file;
}

/**
 * Lê o env-file de volta (para o `argv.json` de auditoria e para o smoke provar
 * a presença da key SEM imprimi-la). Nunca inclui a key em logs — o chamador
 * decide como usar (redação).
 */
export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

// ----------------------------------------------------------------------------
// argv do `docker run`
// ----------------------------------------------------------------------------

export interface DockerRunSpec {
  image: string;
  containerName: string;
  envFile: string;
  workspaceDir: string;
  workDir: string;
  /** uid:gid do usuário do HOST — o container roda como ele (owneria). */
  uid: number;
  gid: number;
  /** argv do `pi` DENTRO do container (já com `--session-dir /exec/session`). */
  piArgv: string[];
}

/**
 * Monta o argv do `docker run` PARA O `spawnAgent` — args APÓS o binário
 * `docker` (o primeiro elemento é `run`, pois `spawnAgent` recebe `bin='docker'`
 * e o prepende). Regras da receita:
 * - `-i` OBRIGATÓRIO — sem ele o stdin pipeado (a tarefa) não chega e o pi sai
 *   exit 0 sem fazer nada (SPIKE: correção crítica).
 * - `--rm` cobre o exit normal; o kill explícito (`killContainer`) cobre o resto.
 * - `--name` único por execução (matar por nome).
 * - `--env-file` = o tmp 0600 do host (a key NUNCA em argv/artefato/volume).
 * - `-v <workspaceDir>:/ws` + `-v <workDir>:/exec` + `-w /ws` — os artefatos
 *   aparecem no host sem `docker cp`.
 * - `-m 2g --pids-limit 512` — limites de contenção.
 * - `--user <uid>:<gid>` — roda como o usuário do host (owneria).
 */
export function buildDockerArgv(spec: DockerRunSpec): string[] {
  return [
    'run',
    '-i', '--rm',
    '--name', spec.containerName,
    '--env-file', spec.envFile,
    '-v', `${spec.workspaceDir}:${CONTAINER_WS_DIR}`,
    '-v', `${spec.workDir}:${CONTAINER_EXEC_DIR}`,
    '-w', CONTAINER_WS_DIR,
    '-m', CONTAINER_MEM_LIMIT,
    '--pids-limit', String(CONTAINER_PIDS_LIMIT),
    '--user', `${spec.uid}:${spec.gid}`,
    spec.image,
    'pi',
    ...spec.piArgv,
  ];
}

/** Forma DOCUMENTADA/auditável do comando: `['docker', ...buildDockerArgv]`. */
export function dockerRunAuditArgv(spec: DockerRunSpec): string[] {
  return ['docker', ...buildDockerArgv(spec)];
}

// ----------------------------------------------------------------------------
// Kill por nome (idempotente, fire-and-forget friendly)
// ----------------------------------------------------------------------------

/**
 * Mata e remove um container pelo nome: `docker kill <name>` + `docker rm -f
 * <name>`, cada um via spawn simples com timeout curto, erros IGNORADOS
 * (idempotente — já morto não é erro). `--rm` cobre o exit normal; este é o
 * cinto-e-suspensório para o kill por timeout/cancelamento (o `docker kill`
 * deixa o container "Dead" por ~1 s — o `rm -f` em seguida fecha a conta sem
 * janela). Retorna imediatamente (fire-and-forget friendly); NÃO acumula
 * espera de timeout quando o daemon não responde.
 */
export async function killContainer(name: string): Promise<void> {
  for (const sub of ['kill', 'rm']) {
    try {
      await runDocker(sub === 'kill' ? ['docker', 'kill', name] : ['docker', 'rm', '-f', name], {
        env: dockerCliEnv(),
        timeoutMs: KILL_TIMEOUT_MS,
      });
    } catch {
      /* idempotente — já removido / daemon indisponível */
    }
  }
}