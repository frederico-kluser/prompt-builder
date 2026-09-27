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
//      image` sobrescreve a tag. Devolve a imagem PINADA por digest (`PinnedImage`):
//      a tag só serve para achar/buildar — o `docker run` usa SEMPRE o sha256.
//   2. `writeEnvFile(entries)` — o env-file do host (os.tmpdir(), chmod 0600)
//      por onde as `PI_*` chegam ao container. A key do OpenRouter NÃO passa
//      por ele (IMPL-037): ela fica no proxy de inferência do host e o sandbox
//      só recebe um token fictício (no `models.json` do pi, não no env).
//   3. `hardeningProfile()` + `buildSandboxRunArgv(...)` — o PERFIL FIXO de
//      endurecimento (IMPL-036 / R-15 REC-1) e o argv genérico do `docker run`
//      endurecido (o `buildDockerArgv` do pi é um caso dele; o verificador em
//      sandbox reaproveita o mesmo builder).
//   4. `killContainer(name)` — `docker kill` + `docker rm -f`, idempotente.
//   5. A ponte até o proxy de inferência (IMPL-037): o diretório do socket Unix
//      do proxy montado read-only em `/exec/proxy` e o comando embrulhado pelo
//      relay (`inferenceRelayCommand`), que expõe o socket como
//      `127.0.0.1:<porta>` no loopback do container. `--network none` fica: o
//      loopback do container existe sem rede, e o socket atravessa pelo bind.
//
// Fonte da receita: SPIKE-CONTAINER.md (onda 1) — o `docker run` precisa de
// `-i` (sem isso o stdin pipeado não chega ao container e o pi sai exit 0 sem
// nada), os limites `-m 2g --pids-limit 512`, `/ws` + `/exec/{session,pi-home}`
// mountados (os artefatos aparecem no host sem `docker cp`), e o kill = `docker
// kill` + `docker rm -f` (o `--rm` cobre só o exit normal; `docker kill` deixa o
// container "Dead" por ~1 s sem a remoção explícita).
//
// Endurecimento (R-15 DEC-1, medido nesta máquina com Docker 29 + runc 1.5):
// `--cap-drop ALL --security-opt no-new-privileges --read-only` + tmpfs em
// `/tmp` e `/exec`, `--network none`, `--pids-limit/--cpus/--memory`, `--user`
// não-root e imagem por digest. Mapeamento de escrita feito ANTES de ligar o
// `--read-only` (`docker diff` de uma execução real do pi 0.84.2): o pi só
// escreve em `$HOME`/`PI_CODING_AGENT_DIR` (= `/exec/pi-home`: auth.json,
// models-store.json, `.npm/_logs`), na sessão (`/exec/session`) e no workspace
// (`/ws`); as tools (`bash` → git/npm/node) escrevem em `$HOME`, `/tmp` e `/ws`.
// Fora disso, só `/var/tmp` quebraria — e nenhuma tool do pi o usa.
// ----------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  INFERENCE_PROXY_VERSION,
  PROXY_API_PREFIX,
  PROXY_HEALTH_PATH,
  PROXY_SOCKET_NAME,
  RELAY_SCRIPT_NAME,
  relaySha256,
  startInferenceProxy,
} from './inferenceProxy.js';

// ----------------------------------------------------------------------------
// Constantes documentadas (SPIKE-CONTAINER.md §"Para o produtor")
// ----------------------------------------------------------------------------

/** Padrão de tag da imagem do pi: `prompt-builder-pi:<piVersion>`. */
export const PI_IMAGE_PATTERN = /^prompt-builder-pi:[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Tag DEFAULT (sem `isolation.image`). `opts.image` sobrescreve. */
export function defaultPiImageTag(version: string): string {
  return `prompt-builder-pi:${version}`;
}

/** Limite de memória do container (SPIKE: `-m 2g`). Swap = o mesmo valor (sem swap extra). */
export const CONTAINER_MEM_LIMIT = '2g';
/** Limite de processos do container (SPIKE: `--pids-limit 512`). */
export const CONTAINER_PIDS_LIMIT = 512;
/**
 * Teto de CPUs por container (`--cpus`). Encaixado no `NCPU` do DAEMON
 * (`dockerDaemonCpus`/`sandboxProfile`), não no do processo cliente: o daemon
 * RECUSA `--cpus` acima das CPUs DELE ("range of CPUs is from 0.01 to N") — e com
 * `DOCKER_HOST` remoto ou a VM do Docker Desktop (1 vCPU num Mac de 8 núcleos) o
 * cliente vê mais CPUs do que o daemon tem. `availableParallelism()` só é o
 * fallback quando o daemon não responde (aí o `docker run` falharia de todo jeito).
 */
export const CONTAINER_CPUS = 2;
/**
 * Opções do tmpfs de `/tmp`. `exec` DE PROPÓSITO: o `/ws` (bind gravável) já é
 * exec, então `noexec` aqui não fecha vetor nenhum — só quebraria tools que
 * extraem e rodam binários em `os.tmpdir()`. O tamanho é debitado do cgroup de
 * memória do container (tmpfs conta como memória), então não soma aos 2 GB.
 */
export const CONTAINER_TMP_TMPFS_OPTS = 'rw,nosuid,nodev,exec,size=512m';
/**
 * Opções do tmpfs de `/exec`. Nele só moram os PONTOS DE MONTAGEM de
 * `/exec/session` e `/exec/pi-home` (binds do host): o resto do dir de execução
 * do HOST (argv.json, task.txt, events.raw.jsonl, stderr.raw.log, exec.json,
 * digests.json) deixou de ser visível/gravável pelo agente — antes o execDir
 * inteiro ia montado em `/exec` e o agente podia adulterar a própria auditoria.
 */
export const CONTAINER_EXEC_TMPFS_OPTS = 'rw,nosuid,nodev,noexec,size=16m';
/** Rede DEFAULT do sandbox: nenhuma (R-15 DEC-2 — o LLM chega por proxy local). */
export const CONTAINER_DEFAULT_NETWORK = 'none';
/**
 * Válvula de escape do OPERADOR (nunca do arquivo de config — um config de
 * terceiros não pode rebaixar o isolamento): `=bridge` devolve a rede padrão do
 * Docker ao container. Desde o proxy de inferência (IMPL-037) o modelo NÃO
 * depende dela — a inferência vai pelo socket Unix com `--network none`; ela só
 * serve a tarefas cujas tools precisam de rede (ex.: `npm install` pelo agente).
 * A key continua fora do sandbox, mas o agente ganha egress (pode exfiltrar o
 * workspace). Todo uso fica em `hardening.unsafe` do `argv.json` e no stderr.
 */
export const UNSAFE_NETWORK_ENV = 'PROMPT_BUILDER_UNSAFE_CONTAINER_NETWORK';
/**
 * `uid:gid` quando o host não tem `getuid` (Windows): o usuário `node` (1000)
 * da imagem base — o Docker Desktop traduz a owneria dos binds sozinho.
 */
export const CONTAINER_FALLBACK_USER = '1000:1000';
/**
 * Versão do perfil de endurecimento. Entra na chave de cache do canário do
 * `doctor` (um "ok" medido num sandbox MAIS FRACO não vale para este) e no
 * `argv.json`. Suba ao mudar qualquer flag de `hardeningFlags`.
 */
export const HARDENING_PROFILE_VERSION = 1;

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
/** Timeout do `pi --version` endurecido pelo digest (validação da imagem). */
export const VERIFY_TIMEOUT_MS = 60_000;
/** Timeout de cada killer (`docker kill` / `docker rm -f`). Curto — é socorro. */
export const KILL_TIMEOUT_MS = 10_000;

/**
 * Raiz de execução do pi DENTRO do container: um tmpfs (perfil endurecido) que só
 * contém os binds `session/` e `pi-home/` — o execDir do host NÃO é montado.
 */
export const CONTAINER_EXEC_DIR = '/exec';
/** Caminho da casa do pi dentro do container (mount em `/exec/pi-home`). */
export const CONTAINER_PI_HOME_DIR = `${CONTAINER_EXEC_DIR}/pi-home`;
/** Caminho do diretório de sessão dentro do container. */
export const CONTAINER_SESSION_DIR = `${CONTAINER_EXEC_DIR}/session`;
/** Caminho do workspace dentro do container (bind de `<workspaceDir>`, gravável). */
export const CONTAINER_WS_DIR = '/ws';
/**
 * Onde o diretório do proxy de inferência do host (socket Unix + relay) aparece
 * no container — bind READ-ONLY sob o tmpfs `/exec` (conectar num socket não
 * exige mount gravável; o relay só é lido pelo `node`, então o `noexec` não pesa).
 */
export const CONTAINER_PROXY_DIR = `${CONTAINER_EXEC_DIR}/proxy`;
/**
 * Porta do relay no loopback do PRÓPRIO container (namespace de rede isolado —
 * não colide com nada do host). Incomum de propósito: as tools do agente podem
 * subir servidores em 3000/8080 sem trombar com a rota do modelo.
 */
export const CONTAINER_PROXY_PORT = 47100;
/** Base URL que o agente enxerga dentro do sandbox (HTTP local; HTTPS só na perna externa). */
export const CONTAINER_INFERENCE_BASE_URL = `http://127.0.0.1:${CONTAINER_PROXY_PORT}${PROXY_API_PREFIX}`;

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

/** `sha256:<64 hex>` — ID de conteúdo da imagem. */
const IMAGE_ID_RE = /^sha256:[a-f0-9]{64}$/;
/** `repo[:tag]@sha256:<64 hex>` — referência de registry pinada por digest. */
const REPO_DIGEST_RE = /^[^\s@]+@sha256:[a-f0-9]{64}$/;

/**
 * A referência é IMUTÁVEL (digest sha256), e não uma tag? Tag é mutável: um
 * `docker build`/`pull` posterior troca o conteúdo por baixo do mesmo nome — a
 * execução deixaria de ser reprodutível e a cadeia de suprimentos ficaria sem
 * pin (R-15 REC-1). O `docker run` do sandbox só aceita referências que passem aqui.
 */
export function isDigestRef(ref: string): boolean {
  return IMAGE_ID_RE.test(ref) || REPO_DIGEST_RE.test(ref);
}

/** Imagem resolvida para o conteúdo exato que vai rodar. */
export interface PinnedImage {
  /** Referência PEDIDA (tag ou digest) — só para humanos/auditoria; nunca vai ao argv. */
  ref: string;
  /**
   * ID de conteúdo da imagem no daemon (`sha256:<64 hex>`) — é o que vai ao
   * `docker run`. Com o image store do containerd é o digest do manifesto/índice
   * (o mesmo de `RepoDigests`); no store clássico é o digest da config. Nos dois
   * casos é imutável e `docker run sha256:<id>` resolve local, sem registry.
   */
  digest: string;
  /** `RepoDigests` do daemon (`repo@sha256:…`), quando houver (imagem de registry). */
  repoDigests: string[];
}

/**
 * Interpreta o stdout de `docker image inspect <ref>` (array JSON). Pura — é o
 * ponto testável da resolução por digest. `null` = saída ilegível/sem `Id` válido.
 */
export function parseImageInspect(stdout: string, ref: string): PinnedImage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const first = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown> | undefined) : undefined;
  const id = first?.Id;
  if (typeof id !== 'string' || !IMAGE_ID_RE.test(id)) return null;
  const repoDigests = Array.isArray(first?.RepoDigests)
    ? (first.RepoDigests as unknown[]).filter((d): d is string => typeof d === 'string' && REPO_DIGEST_RE.test(d))
    : [];
  return { ref, digest: id, repoDigests };
}

/**
 * Resolve `ref` (tag ou digest) para o digest da imagem presente no daemon.
 * `null` = imagem ausente (ou daemon indisponível). Nunca puxa do registry.
 */
export async function resolveImageDigest(ref: string): Promise<PinnedImage | null> {
  let res: SimpleResult;
  try {
    res = await runDocker(['docker', 'image', 'inspect', ref], {
      env: dockerCliEnv(),
      timeoutMs: INSPECT_TIMEOUT_MS,
    });
  } catch {
    return null; // docker CLI ausente
  }
  if (res.code !== 0) return null;
  return parseImageInspect(res.stdout, ref);
}

/**
 * Nomes de runtime OCI registrados no daemon (`docker info` → `.Runtimes`). Pura.
 * Usado para validar `isolation.runtime` (ex.: `runsc` do gVisor) ANTES da run.
 */
export function parseDockerRuntimes(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
  } catch {
    return [];
  }
}

/** Nome de runtime aceito em `--runtime` (mesma forma que o daemon registra). */
export const RUNTIME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Falha CEDO (na preparação, antes de gastar) se o runtime pedido não existe no
 * daemon. gVisor (`runsc`) é opção de ALTO RISCO, fora do default (R-15 DEC-1):
 * ~2× mais lento em syscalls e muito pior em I/O de arquivos pequenos (`npm ci`).
 */
export async function assertDockerRuntime(runtime: string): Promise<void> {
  if (!RUNTIME_NAME_RE.test(runtime)) {
    throw new Error(`isolation.runtime inválido: "${runtime}"`);
  }
  const res = await runDocker(['docker', 'info', '--format', '{{json .Runtimes}}'], {
    env: dockerCliEnv(),
    timeoutMs: INSPECT_TIMEOUT_MS,
  });
  const available = res.code === 0 ? parseDockerRuntimes(res.stdout) : [];
  if (!available.includes(runtime)) {
    throw new Error(
      `runtime Docker "${runtime}" não está registrado no daemon (disponíveis: ${available.join(', ') || 'nenhum/daemon indisponível'}). ` +
        `Para gVisor, instale o runsc e registre-o em /etc/docker/daemon.json.`,
    );
  }
}

/**
 * Garante que a imagem do pi existe e devolve-a PINADA por digest.
 *
 * - `opts.image` sobrescreve a tag default (`prompt-builder-pi:<version>`); pode
 *   ser também uma referência por digest (`repo@sha256:…` ou `sha256:…`).
 * - `docker image inspect <ref>` silencioso: se a imagem existe, NÃO rebuilda
 *   (imagem CACHEADA por tag — o padrão "não recria se existir") e devolve o
 *   digest do conteúdo que está lá AGORA — é ele, não a tag, que vai ao argv.
 * - Uma referência por digest ausente NÃO é buildada (não dá para buildar "um
 *   conteúdo") nem puxada em silêncio: erro acionável pedindo o `docker pull`.
 * - Builda com Dockerfile embutido num contexto tmp LIMPO, env de build =
 *   `process.env` (o npm precisa de rede), log em `<runDir>/docker-build.log`.
 * - Ao fim valida com `pi --version` rodando JÁ no perfil endurecido e no
 *   runtime da run (`opts.runtime`) — prova que o pi sobe com rootfs read-only,
 *   sem capabilities e sem rede NO sandbox que a run vai usar.
 */
export async function ensurePiImage(
  version: string,
  opts: {
    image?: string;
    runDir?: string;
    /**
     * Runtime OCI da run (`isolation.runtime`, ex.: `runsc`). A validação da
     * imagem recém-buildada roda NELE: provar que o pi sobe em runc não prova
     * que sobe no gVisor — sem isto só o 1º `docker run` real descobriria.
     */
    runtime?: string;
  } = {},
): Promise<PinnedImage> {
  const tag = opts.image ?? defaultPiImageTag(version);

  const cached = await resolveImageDigest(tag);
  if (cached) {
    return cached; // imagem já em cache — não rebuilda
  }
  if (isDigestRef(tag) || tag.includes('@')) {
    throw new Error(
      `imagem ${tag} (referência por digest) não está no daemon — rode \`docker pull ${tag}\` antes da run ` +
        `(o prompt-builder não puxa imagens de registry em silêncio).`,
    );
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

  const pinned = await resolveImageDigest(tag);
  if (!pinned) {
    throw new Error(`docker build de ${tag} terminou mas a imagem não aparece no daemon (inspect sem Id sha256).`);
  }

  // Valida a imagem recém-buildada: `pi --version` no perfil ENDURECIDO, pelo
  // digest, no MESMO runtime e com o `--cpus` que o daemon aceita (o da run).
  const profile = await sandboxProfile({ runtime: opts.runtime });
  const verify = await runDocker(
    ['docker', ...buildSandboxRunArgv({ image: pinned.digest, profile, command: ['pi', '--version'] })],
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
  return pinned;
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
 * a AUSÊNCIA da key — desde o IMPL-037 ela não entra no env-file). O chamador
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
// Perfil FIXO de endurecimento (IMPL-036 / R-15 REC-1)
// ----------------------------------------------------------------------------

export type ContainerNetwork = 'none' | 'bridge';

/**
 * O perfil efetivo de UM `docker run` do sandbox — é também o que o `argv.json`
 * registra (`hardening`) para a auditoria conferir contra o `docker inspect`.
 * Os campos fixos (`capDrop`, `securityOpt`, `readOnlyRootfs`, `pull`) não têm
 * knob: o tipo só admite o valor endurecido.
 */
export interface HardeningProfile {
  version: number;
  capDrop: ['ALL'];
  securityOpt: ['no-new-privileges'];
  readOnlyRootfs: true;
  /** ponto de montagem → opções do tmpfs. */
  tmpfs: Record<string, string>;
  network: ContainerNetwork;
  pidsLimit: number;
  cpus: number;
  memory: string;
  memorySwap: string;
  /** `uid:gid` NÃO-root. */
  user: string;
  /** Runtime OCI alternativo (ex.: `runsc` = gVisor). Ausente = runc do daemon. */
  runtime?: string;
  /** `--pull never`: nunca buscar imagem no registry durante a execução. */
  pull: 'never';
  /** Desvios do perfil pedidos pelo OPERADOR (vazio = perfil íntegro). */
  unsafe: string[];
}

export interface HardeningOpts {
  /** uid/gid do host (default `process.getuid/getgid`). `null` = sem getuid (Windows). */
  uid?: number | null;
  gid?: number | null;
  /** Runtime OCI opt-in (`isolation.runtime`). */
  runtime?: string;
  /** Env de onde ler a válvula `UNSAFE_NETWORK_ENV` (default `process.env`). */
  env?: Record<string, string | undefined>;
  /**
   * CPUs do DAEMON Docker (teto do `--cpus`). Default `availableParallelism()`
   * do processo — só serve quando cliente e daemon são a mesma máquina; para um
   * `docker run` real use `sandboxProfile()`, que pergunta ao daemon.
   */
  hostCpus?: number;
}

/**
 * `--user` do container: SEMPRE não-root. Com o uid do host (owneria dos binds);
 * sem `getuid` (Windows), o `node` (1000) da imagem. Host ROOT é RECUSADO: rodar
 * o agente como root no container anula metade do perfil (e usar outro uid
 * deixaria o workspace root-only ilegível p/ ele e o git do host "dubious
 * ownership") — degradação honesta: rode como usuário comum ou Docker rootless.
 */
export function containerUser(uid?: number | null, gid?: number | null): string {
  if (uid == null) return CONTAINER_FALLBACK_USER;
  if (uid === 0) {
    throw new Error(
      'modo container endurecido não roda o agente como root: execute o prompt-builder com um usuário comum ' +
        '(ou use Docker rootless) — o container herda o uid do host para a owneria do workspace.',
    );
  }
  return `${uid}:${gid ?? uid}`;
}

/** Rede do sandbox: `none`, salvo a válvula explícita do operador (auditada em `unsafe`). */
export function resolveContainerNetwork(
  env: Record<string, string | undefined> = process.env,
): { network: ContainerNetwork; unsafe: string[] } {
  const raw = env[UNSAFE_NETWORK_ENV]?.trim();
  if (!raw || raw === CONTAINER_DEFAULT_NETWORK) return { network: 'none', unsafe: [] };
  if (raw === 'bridge') {
    return {
      network: 'bridge',
      unsafe: [
        `network=bridge via ${UNSAFE_NETWORK_ENV}: o container tem rede plena — a key do OpenRouter segue só no ` +
          'proxy de inferência, mas um agente hostil pode exfiltrar o workspace e o que mais ler',
      ],
    };
  }
  throw new Error(`${UNSAFE_NETWORK_ENV}="${raw}" inválido — aceita só "bridge" (ou ausente = rede "none").`);
}

/** Monta o perfil fixo. Lança se o host é root ou a válvula de rede é inválida. */
export function hardeningProfile(opts: HardeningOpts = {}): HardeningProfile {
  const uid = opts.uid !== undefined ? opts.uid : typeof process.getuid === 'function' ? process.getuid() : null;
  const gid = opts.gid !== undefined ? opts.gid : typeof process.getgid === 'function' ? process.getgid() : null;
  const { network, unsafe } = resolveContainerNetwork(opts.env);
  const hostCpus = Math.max(1, Math.floor(opts.hostCpus ?? availableParallelism()));
  if (opts.runtime !== undefined && !RUNTIME_NAME_RE.test(opts.runtime)) {
    throw new Error(`isolation.runtime inválido: "${opts.runtime}"`);
  }
  return {
    version: HARDENING_PROFILE_VERSION,
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges'],
    readOnlyRootfs: true,
    tmpfs: {
      '/tmp': CONTAINER_TMP_TMPFS_OPTS,
      [CONTAINER_EXEC_DIR]: CONTAINER_EXEC_TMPFS_OPTS,
    },
    network,
    pidsLimit: CONTAINER_PIDS_LIMIT,
    cpus: Math.min(CONTAINER_CPUS, hostCpus),
    memory: CONTAINER_MEM_LIMIT,
    memorySwap: CONTAINER_MEM_LIMIT,
    user: containerUser(uid, gid),
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
    pull: 'never',
    unsafe,
  };
}

/** Interpreta `docker info --format '{{.NCPU}}'`. Pura. `undefined` = saída inválida. */
export function parseDockerNcpu(stdout: string): number | undefined {
  const t = stdout.trim();
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n > 0 ? n : undefined;
}

/** NCPU por daemon (chave = `DOCKER_HOST`). Só sucesso é memorizado. */
const daemonCpusCache = new Map<string, number>();

/**
 * Quantas CPUs o DAEMON Docker tem (`docker info` → `.NCPU`) — o teto real do
 * `--cpus`. Memorizado por `DOCKER_HOST` (1 `docker info` por processo);
 * `undefined` quando o daemon não responde (o chamador cai no fallback local).
 */
export async function dockerDaemonCpus(): Promise<number | undefined> {
  const key = process.env.DOCKER_HOST ?? '';
  const hit = daemonCpusCache.get(key);
  if (hit !== undefined) return hit;
  let res: SimpleResult;
  try {
    res = await runDocker(['docker', 'info', '--format', '{{.NCPU}}'], {
      env: dockerCliEnv(),
      timeoutMs: INSPECT_TIMEOUT_MS,
    });
  } catch {
    return undefined; // docker CLI ausente
  }
  const n = res.code === 0 ? parseDockerNcpu(res.stdout) : undefined;
  if (n !== undefined) daemonCpusCache.set(key, n);
  return n;
}

/**
 * O perfil de um `docker run` REAL do sandbox: `hardeningProfile` com o `--cpus`
 * encaixado nas CPUs do DAEMON (não do processo cliente). É o que todo `docker
 * run` do modo agente usa — execução do pi, `selfTest`, validação da imagem e
 * canário do doctor. `opts.hostCpus` explícito dispensa a pergunta ao daemon.
 */
export async function sandboxProfile(opts: HardeningOpts = {}): Promise<HardeningProfile> {
  const hostCpus = opts.hostCpus ?? (await dockerDaemonCpus());
  return hardeningProfile({ ...opts, ...(hostCpus !== undefined ? { hostCpus } : {}) });
}

/** As flags do `docker run` que materializam o perfil (ordem estável — o teste fixa). */
export function hardeningFlags(p: HardeningProfile): string[] {
  const flags = [
    '--cap-drop', p.capDrop[0],
    '--security-opt', p.securityOpt[0],
    '--read-only',
  ];
  for (const [dir, opts] of Object.entries(p.tmpfs)) flags.push('--tmpfs', `${dir}:${opts}`);
  flags.push(
    '--network', p.network,
    '--pids-limit', String(p.pidsLimit),
    '--cpus', String(p.cpus),
    '--memory', p.memory,
    '--memory-swap', p.memorySwap,
    '--user', p.user,
    '--pull', p.pull,
  );
  if (p.runtime) flags.push('--runtime', p.runtime);
  return flags;
}

// ----------------------------------------------------------------------------
// argv do `docker run`
// ----------------------------------------------------------------------------

/** Um bind do host para dentro do sandbox. */
export interface SandboxMount {
  /** Caminho ABSOLUTO no host (precisa existir: `--mount` não o cria como root). */
  host: string;
  /** Caminho absoluto dentro do container. */
  container: string;
  readOnly?: boolean;
}

/** Campo do `--mount` (sintaxe CSV do Docker): aspas quando há `,` ou `"`. */
function mountField(key: string, value: string): string {
  if (/[\n\r]/.test(value)) throw new Error(`caminho de mount com quebra de linha: ${JSON.stringify(value)}`);
  const field = `${key}=${value}`;
  return /[",]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

/** `--mount type=bind,...` (e não `-v`): falha se a origem não existir em vez de criá-la como root. */
function mountArg(m: SandboxMount): string {
  if (!path.isAbsolute(m.host)) throw new Error(`mount do sandbox exige caminho absoluto no host: ${m.host}`);
  if (!m.container.startsWith('/')) throw new Error(`mount do sandbox exige destino absoluto: ${m.container}`);
  return ['type=bind', mountField('source', m.host), mountField('target', m.container), ...(m.readOnly ? ['readonly'] : [])].join(',');
}

/** Especificação genérica de um `docker run` endurecido (pi, canário, verificador…). */
export interface SandboxRunSpec {
  /** Referência por DIGEST (`sha256:…` ou `repo@sha256:…`) — tag é recusada. */
  image: string;
  /** Nome único (matar por nome). Opcional p/ execuções curtas (`pi --version`). */
  containerName?: string;
  /** Perfil de `hardeningProfile()` — não há `docker run` do sandbox sem ele. */
  profile: HardeningProfile;
  /** Comando DENTRO do container. */
  command: string[];
  /** `-i`: stdin pipeado chega ao processo (a tarefa do pi vai por stdin). */
  interactive?: boolean;
  /** env-file 0600 do host. */
  envFile?: string;
  mounts?: SandboxMount[];
  /** `-w` dentro do container. */
  workdir?: string;
}

/**
 * Argv do `docker run` endurecido — args APÓS o binário `docker` (o primeiro
 * elemento é `run`). `--rm` sempre (o kill explícito cobre timeout/cancelamento).
 */
export function buildSandboxRunArgv(spec: SandboxRunSpec): string[] {
  if (!isDigestRef(spec.image)) {
    throw new Error(
      `o sandbox só roda imagem referenciada por digest sha256 (recebido "${spec.image}") — ` +
        'resolva a tag com ensurePiImage/resolveImageDigest antes.',
    );
  }
  return [
    'run',
    ...(spec.interactive ? ['-i'] : []),
    '--rm',
    ...(spec.containerName ? ['--name', spec.containerName] : []),
    ...hardeningFlags(spec.profile),
    ...(spec.envFile ? ['--env-file', spec.envFile] : []),
    ...(spec.mounts ?? []).flatMap((m) => ['--mount', mountArg(m)]),
    ...(spec.workdir ? ['-w', spec.workdir] : []),
    spec.image,
    ...spec.command,
  ];
}

/**
 * O bind do diretório do proxy de inferência (socket Unix + relay) — READ-ONLY:
 * o agente conecta no socket, mas não troca o relay nem planta arquivo ali.
 */
export function inferenceProxyMount(socketDir: string): SandboxMount {
  return { host: socketDir, container: CONTAINER_PROXY_DIR, readOnly: true };
}

/**
 * Embrulha o comando do agente no relay (PID 1 do container): `node relay.cjs
 * <porta> <socket> -- <comando...>`. O relay abre `127.0.0.1:<porta>` →
 * socket Unix do proxy e executa o comando com stdio herdado.
 */
export function inferenceRelayCommand(command: string[]): string[] {
  return [
    'node',
    `${CONTAINER_PROXY_DIR}/${RELAY_SCRIPT_NAME}`,
    String(CONTAINER_PROXY_PORT),
    `${CONTAINER_PROXY_DIR}/${PROXY_SOCKET_NAME}`,
    '--',
    ...command,
  ];
}

export interface DockerRunSpec {
  /** Digest da imagem do pi (`PinnedImage.digest`) — NUNCA a tag. */
  image: string;
  containerName: string;
  envFile: string;
  /**
   * Diretório do HOST do proxy de inferência (`InferenceRoute.socketDir`). Presente
   * = bind read-only em `/exec/proxy` + comando embrulhado pelo relay (IMPL-037).
   */
  inferenceSocketDir?: string;
  workspaceDir: string;
  /** Dir de execução do HOST. Só `session/` e `pi-home/` dele entram no container. */
  workDir: string;
  /** Sessão do pi no host (default `<workDir>/session`) → `/exec/session`. */
  sessionDir?: string;
  /** Perfil endurecido (`hardeningProfile()`). */
  profile: HardeningProfile;
  /** argv do `pi` DENTRO do container (já com `--session-dir /exec/session`). */
  piArgv: string[];
}

/**
 * Monta o argv do `docker run` do PI para o `spawnAgent` — args APÓS o binário
 * `docker` (o primeiro elemento é `run`, pois `spawnAgent` recebe `bin='docker'`
 * e o prepende). Regras da receita:
 * - `-i` OBRIGATÓRIO — sem ele o stdin pipeado (a tarefa) não chega e o pi sai
 *   exit 0 sem fazer nada (SPIKE: correção crítica).
 * - `--rm` cobre o exit normal; o kill explícito (`killContainer`) cobre o resto.
 * - `--name` único por execução (matar por nome).
 * - `--env-file` = o tmp 0600 do host, só com as `PI_*` (a key do OpenRouter NÃO:
 *   fica no proxy de inferência — IMPL-037).
 * - binds: `<workspaceDir>` → `/ws` (cwd), `<sessionDir>` → `/exec/session`,
 *   `<workDir>/pi-home` → `/exec/pi-home` e, com proxy, `<socketDir>` →
 *   `/exec/proxy` (read-only); o resto de `/exec` é tmpfs.
 * - com proxy, o PID 1 é o relay (`inferenceRelayCommand`) e o pi é filho dele.
 * - perfil endurecido completo (`hardeningFlags`) e imagem por digest.
 */
export function buildDockerArgv(spec: DockerRunSpec): string[] {
  const pi = ['pi', ...spec.piArgv];
  return buildSandboxRunArgv({
    image: spec.image,
    containerName: spec.containerName,
    profile: spec.profile,
    interactive: true,
    envFile: spec.envFile,
    mounts: [
      { host: spec.workspaceDir, container: CONTAINER_WS_DIR },
      { host: spec.sessionDir ?? path.join(spec.workDir, 'session'), container: CONTAINER_SESSION_DIR },
      { host: path.join(spec.workDir, 'pi-home'), container: CONTAINER_PI_HOME_DIR },
      ...(spec.inferenceSocketDir ? [inferenceProxyMount(spec.inferenceSocketDir)] : []),
    ],
    workdir: CONTAINER_WS_DIR,
    command: spec.inferenceSocketDir ? inferenceRelayCommand(pi) : pi,
  });
}

/** Forma DOCUMENTADA/auditável do comando: `['docker', ...buildDockerArgv]`. */
export function dockerRunAuditArgv(spec: DockerRunSpec): string[] {
  return ['docker', ...buildDockerArgv(spec)];
}

/**
 * Conteúdo do `argv.json` de uma execução em container. `image` é o DIGEST
 * sha256 que de fato rodou (o mesmo que aparece no `argv`); `imageRef` é só a
 * referência pedida (tag), para humanos. `hardening` é o perfil efetivo — a
 * auditoria confere contra o `docker inspect` (CapDrop/ReadonlyRootfs/
 * SecurityOpt/NetworkMode/PidsLimit/User). O env-file sai mascarado.
 */
export interface ContainerAudit {
  mode: 'container';
  image: string;
  imageRef: string;
  hardening: HardeningProfile;
  argv: string[];
  /**
   * Rota de inferência (IMPL-037): a key ficou no proxy do host; o sandbox viu só
   * `containerBaseUrl` + token fictício. `relaySha256` prova QUAL relay foi o PID 1.
   * `envKeys` = nomes (nunca valores) do env-file — a auditoria confere que
   * `OPENROUTER_API_KEY` não está lá.
   */
  inference?: {
    route: 'unix-socket-relay';
    proxyVersion: number;
    containerBaseUrl: string;
    relaySha256: string;
    envKeys: string[];
  };
}

/** Monta o `ContainerAudit` (pura). Recusa imagem que não seja digest. */
export function containerAuditRecord(opts: {
  imageDigest: string;
  imageRef?: string;
  profile: HardeningProfile;
  /** argv COMPLETO (`['docker', 'run', ...]`). */
  argv: string[];
  envFile?: string;
  /** Nomes das variáveis do env-file (com proxy de inferência). */
  inferenceEnvKeys?: string[];
}): ContainerAudit {
  if (!isDigestRef(opts.imageDigest)) {
    throw new Error(`argv.json exige a imagem por digest sha256 (recebido "${opts.imageDigest}")`);
  }
  return {
    mode: 'container',
    image: opts.imageDigest,
    imageRef: opts.imageRef ?? opts.imageDigest,
    hardening: opts.profile,
    argv: opts.envFile ? opts.argv.map((a) => (a === opts.envFile ? ENV_FILE_MASK : a)) : [...opts.argv],
    ...(opts.inferenceEnvKeys
      ? {
          inference: {
            route: 'unix-socket-relay' as const,
            proxyVersion: INFERENCE_PROXY_VERSION,
            containerBaseUrl: CONTAINER_INFERENCE_BASE_URL,
            relaySha256: relaySha256(),
            envKeys: [...opts.inferenceEnvKeys].sort(),
          },
        }
      : {}),
  };
}

/**
 * Dica acionável quando o agente NÃO recebeu resposta do modelo dentro do
 * sandbox. Desde o IMPL-037 a ÚNICA rota do agente até o provedor é o proxy de
 * inferência do host (socket Unix montado em `/exec/proxy` + relay no loopback
 * do container) — com `--network none` ou com a válvula `bridge`. Um erro do
 * provedor aqui é, portanto, do proxy ou do upstream: o log redigido do proxy
 * diz qual. Vira erro de INFRA (`infraError`: sem veredito, fora do placar —
 * nunca `nao`; ver `infraError.ts`).
 */
export function inferenceRouteHint(logFile?: string): string {
  return (
    `o agente só alcança o provedor pelo proxy de inferência local (socket Unix montado em ${CONTAINER_PROXY_DIR}; ` +
    `a rede do sandbox não leva a lugar nenhum) — veja o log redigido do proxy` +
    (logFile ? ` (${logFile})` : ' (inference-proxy.jsonl da run)') +
    `: status 401/403 = token/rota recusados pelo proxy; 502 = upstream inalcançável a partir do HOST. ` +
    `Em Docker Desktop (macOS/Windows) e em gVisor sem --host-uds=open o socket Unix do host não atravessa ` +
    `para o sandbox — rode \`agents doctor --container\`.`
  );
}

// ----------------------------------------------------------------------------
// Sonda da rota de inferência (pré-voo do doctor, sem gastar)
// ----------------------------------------------------------------------------

/** Timeout da sonda (um `docker run` curto + 2 testes de rede). */
export const ROUTE_PROBE_TIMEOUT_MS = 60_000;

/**
 * O que a sonda mediu DENTRO do sandbox — os critérios do IMPL-037 como checagem
 * de runtime: o relay alcança o proxy (`relayStatus` 200 na saúde LOCAL, que
 * nunca vai ao upstream), a key não está no ambiente, e sem rede nada sai
 * (DNS e TCP direto por IP falham).
 */
export interface InferenceRouteProbe {
  ok: boolean;
  /** HTTP da saúde do proxy via relay, ou o código do erro (`ECONNREFUSED`…). */
  relayStatus: number | string;
  /** `OPENROUTER_API_KEY` presente no ambiente do sandbox? (tem de ser `false`). */
  keyInSandbox: boolean;
  /** Egress (DNS + TCP por IP) bloqueado? `null` = não medido (rede `bridge`). */
  egressBlocked: boolean | null;
  network: ContainerNetwork;
  errors: string[];
}

/**
 * Script da sonda (roda no `node` da imagem, filho do relay). Imprime UMA linha
 * JSON no stdout. Recebe a porta e o token por argv — o token é de um proxy
 * efêmero da própria sonda, sem key real e revogado ao fim.
 */
const ROUTE_PROBE_SCRIPT = `
const [port, token, checkEgress] = process.argv.slice(1);
const out = { keyInSandbox: typeof process.env.OPENROUTER_API_KEY === 'string' && process.env.OPENROUTER_API_KEY !== '' };
(async () => {
  try {
    const r = await fetch('http://127.0.0.1:' + port + '${PROXY_HEALTH_PATH}', { headers: { authorization: 'Bearer ' + token } });
    out.relayStatus = r.status;
  } catch (e) { out.relayStatus = String((e.cause && e.cause.code) || e.message); }
  if (checkEgress === '1') {
    const dns = await require('node:dns').promises.lookup('openrouter.ai').then(() => 'resolveu', (e) => e.code || 'erro');
    const tcp = await new Promise((resolve) => {
      const s = require('node:net').connect(443, '1.1.1.1');
      const t = setTimeout(() => { s.destroy(); resolve('timeout'); }, 3000);
      s.on('connect', () => { clearTimeout(t); s.destroy(); resolve('conectou'); });
      s.on('error', (e) => { clearTimeout(t); resolve(e.code || 'erro'); });
    });
    out.egress = { dns, tcp };
  }
  process.stdout.write(JSON.stringify(out));
})();
`;

/** Interpreta a saída da sonda (pura — o ponto testável). */
export function parseRouteProbe(stdout: string, network: ContainerNetwork): InferenceRouteProbe {
  const errors: string[] = [];
  let parsed: Record<string, unknown> | undefined;
  try {
    const line = stdout.trim().split('\n').pop() ?? '';
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    errors.push(`sonda da rota de inferência sem saída legível: ${JSON.stringify(stdout.slice(-300))}`);
  }
  const relayStatus = (parsed?.relayStatus as number | string | undefined) ?? 'sem-resposta';
  const keyInSandbox = parsed?.keyInSandbox === true;
  let egressBlocked: boolean | null = null;
  if (network === 'none') {
    const eg = (parsed?.egress ?? {}) as { dns?: string; tcp?: string };
    egressBlocked = eg.dns !== undefined && eg.dns !== 'resolveu' && eg.tcp !== undefined && eg.tcp !== 'conectou';
    if (!egressBlocked) errors.push(`sandbox com --network none alcançou a rede externa (dns=${eg.dns}, tcp=${eg.tcp})`);
  }
  if (parsed && relayStatus !== 200) {
    errors.push(
      `o sandbox não alcança o proxy de inferência pelo relay (saúde = ${relayStatus}) — ` +
        'socket Unix do host não atravessou o bind (Docker Desktop/gVisor/SELinux?)',
    );
  }
  if (keyInSandbox) errors.push('OPENROUTER_API_KEY apareceu no ambiente do sandbox');
  return { ok: errors.length === 0, relayStatus, keyInSandbox, egressBlocked, network, errors };
}

/**
 * Sobe um proxy EFÊMERO (sem key real — a saúde é local) e roda a sonda no
 * sandbox endurecido da run, com o mesmo bind + relay de uma execução do pi.
 * Nada é cobrado: nenhuma requisição vai ao upstream.
 */
export async function probeSandboxInferenceRoute(opts: {
  imageDigest: string;
  profile: HardeningProfile;
}): Promise<InferenceRouteProbe> {
  const proxy = await startInferenceProxy({
    apiKey: '',
    upstreamBaseUrl: 'http://127.0.0.1:9/api/v1', // nunca usado: a sonda só chama a saúde local
    listen: { unix: true },
  });
  const cred = proxy.issueCredential({ role: 'doctor-probe' });
  try {
    const argv = buildSandboxRunArgv({
      image: opts.imageDigest,
      containerName: `${CONTAINER_NAME_PREFIX}probe-${randomUUID()}`,
      profile: opts.profile,
      mounts: [inferenceProxyMount(proxy.socketDir as string)],
      command: inferenceRelayCommand([
        'node',
        '-e',
        ROUTE_PROBE_SCRIPT,
        String(CONTAINER_PROXY_PORT),
        cred.token,
        opts.profile.network === 'none' ? '1' : '0',
      ]),
    });
    let res: SimpleResult;
    try {
      res = await runDocker(['docker', ...argv], { env: dockerCliEnv(), timeoutMs: ROUTE_PROBE_TIMEOUT_MS });
    } catch (err) {
      return {
        ok: false,
        relayStatus: 'docker-ausente',
        keyInSandbox: false,
        egressBlocked: null,
        network: opts.profile.network,
        errors: [`sonda da rota de inferência não rodou: ${(err as Error).message}`],
      };
    }
    const probe = parseRouteProbe(res.stdout, opts.profile.network);
    if (res.code !== 0) {
      probe.ok = false;
      probe.errors.push(`sonda saiu com ${res.code ?? res.signal}: ${res.stderr.slice(-500)}`);
    }
    return probe;
  } finally {
    cred.revoke();
    await proxy.close();
  }
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