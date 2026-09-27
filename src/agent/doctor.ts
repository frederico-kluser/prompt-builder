// ----------------------------------------------------------------------------
// `doctor` — o pré-voo e o canário de sala limpa (`agents doctor`).
//
// POR QUE existe (plano §12.6 / §21.4 / Apêndice E): as flags do `pi` mudam
// (41 versões desde 2026-05-07) e uma claim sobre a árvore de configuração dele
// foi refutada 0-3 porque a doc simplificava. Em vez de ACREDITAR que `--no-skills`
// isola, este módulo MEDE o isolamento: injeta tokens canário em cada camada de
// contexto (projeto, global, settings) e pergunta ao agente o que ele viu. Se
// um token CANARY-* vazar na resposta (ou as flags de modelo/thinking divergirem
// do que foi pedido), a sala está suja e a run não deveria seguir. É o teste de
// regressão que este repositório não tem (verificação = type-check + execução).
//
// Não há framework de execução: `runDoctor` delega ao `spawnAgent` (spawn.ts),
// que já cuida de spawn sem shell, env explícito, pipes drenados, kill de árvore
// e parede de tempo. Aqui a ÚNICA coisa nova é SEMÂNTICA: montar os diretórios
// envenenados, ler o JSONL e afirmar que nada vazou.
// ----------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CleanRoomReport } from './executor.js';
import type { AgentStopReason } from './types.js';
import {
  defaultPiImageTag,
  CONTAINER_MEM_LIMIT,
  CONTAINER_NAME_PREFIX,
  CONTAINER_PIDS_LIMIT,
  dockerCliEnv,
  writeEnvFile,
  killContainer,
} from './container.js';
import { createJsonlSplitter } from './jsonl.js';
import { spawnAgent } from './spawn.js';
import { getDataDir } from '../storage.js';
import { ensurePrivateDirSync } from '../pathSafety.js';

// ----------------------------------------------------------------------------
// API pública
// ----------------------------------------------------------------------------

/**
 * Resultado do pré-voo. `ok` é falso quando `pi`/`git` faltam, a versão do `pi`
 * diverge de `expectedVersion` ou o canário reporta vazamento. `errors` carrega
 * cada motivo legível — o endpoint/problemática expõe isso intacto. `diskFreeGb`
 * nunca falha o voo sozinho: disco baixo entra como AVISO em `errors`.
 */
export interface PreflightResult {
  ok: boolean;
  pi: { found: boolean; version?: string; expected?: string };
  git: boolean;
  diskFreeGb: number;
  canary?: CleanRoomReport;
  /** Estado do Docker — presente SÓ quando `isolation.kind === 'container'`. */
  docker?: { present: boolean; image?: string; imagePresent: boolean };
  errors: string[];
}

/** Opções do pré-voo. `runDir` é a raiz das pastas temporárias do run. */
export interface PreflightOpts {
  /** Versão semântica esperada do `pi`. Divergente => pré-voo falha. */
  expectedVersion?: string;
  /** Chave de cache do canário (ex.: versão do pi × conjunto de flags). */
  cacheKey?: string;
  /** Diretório temporário do run (cria `doctor-proj/`, `doctor-home/` etc.). */
  runDir: string;
  /** Key do OpenRouter — usada SÓ no canário e jamais logada/exposta. */
  apiKey: string;
  /** Modelo a usar no canário (chamada barata de LLM). */
  model: string;
  /** Caminho do binário `pi`. Default: `pi` no PATH da sala limpa. */
  bin?: string;
  /**
   * Modo de isolamento a verificar (mesmo `isolation.kind` de `RunConfig`). Quando
   * `kind === 'container'`, o pré-voo também checa o Docker CLI e a imagem do pi.
   */
  isolation?: { kind?: 'worktree' | 'clone' | 'container'; image?: string };
}

/**
 * Roda o pré-voo completo (plano §21.4): `pi --version` + `git --version` no
 * bin instalado, disco livre em `runDir` via `fs.statfs`, e — quando há chave —
 * o canário de sala limpa. O canário é cacheado por `cacheKey`: um relatório ok
 * em `<dataDir>/agent-doctor-cache/<sha256(cacheKey)>.json` é reutilizado sem
 * gastar outra chamada de LLM.
 */
export async function runPreflight(opts: PreflightOpts): Promise<PreflightResult> {
  const errors: string[] = [];

  // --- pi & git --------------------------------------------------------------
  const piDetected = await detectPi(opts.bin);
  const pi = { ...piDetected, expected: opts.expectedVersion };
  const piFail =
    !pi.found ||
    (!!opts.expectedVersion && !!pi.version && !sameVersion(opts.expectedVersion, pi.version));
  if (!pi.found) {
    errors.push(`executor 'pi' não encontrado: \`${opts.bin ?? 'pi'} --version\` falhou.`);
  } else if (opts.expectedVersion && pi.version && !sameVersion(opts.expectedVersion, pi.version)) {
    // Divergência de versão = a receita de argv (flags de isolamento) pode não
    // casar com o binário presente — o canário mede o isolamento DESTA versão
    // (plano §12.6: "medimos que isolam nesta versão").
    errors.push(
      `versão do pi diverge do esperado: encontrada '${pi.version}' (esperada '${opts.expectedVersion}'). ` +
        `A sala limpa desta versão pode não isolar com as flags pedidas.`,
    );
  }

  const gitPresent = await hasGit();
  if (!gitPresent) errors.push('`git` não encontrado no PATH — necessário para workspaces de execução.');

  // --- modo container: Docker CLI + imagem ---------------------------------
  // O pré-voo é checagem RÁPIDA e HONESTA — NÃO builda a imagem aqui (o build
  // é responsabilidade da PREPARAÇÃO da run via `ensurePiImage`, em pi.ts).
  // Aqui só afirmamos que o CLI e a imagem existem, ou listamos o que falta em
  // `errors` para o CLI/endpoint ecoar de forma legível.
  let dockerFail = false;
  let dockerInfo: PreflightResult['docker'];
  if (opts.isolation?.kind === 'container') {
    const dockerPresent = await detectDockerCli();
    const tag =
      opts.isolation.image ?? defaultPiImageTag(opts.expectedVersion ?? '');
    const imagePresent = dockerPresent ? await dockerImagePresent(tag) : false;
    dockerInfo = { present: dockerPresent, image: tag, imagePresent };
    if (!dockerPresent) {
      dockerFail = true;
      errors.push(
        'modo container exige o Docker CLI no PATH — instale ou ative o daemon ' +
          '(`docker --version` falhou).',
      );
    } else if (!imagePresent) {
      dockerFail = true;
      errors.push(
        `imagem docker '${tag}' não encontrada no daemon. A primeira preparação de run ` +
          'em modo container (ou `ensurePiImage`) a cria automaticamente — rode uma run ' +
          'em container (ou o smoke da Onda 2) para buildá-la.',
      );
    }
  }

  // --- disco ---------------------------------------------------------------
  const diskFreeGb = dfGb(opts.runDir);
  // Disco entra como AVISO, não falha o voo (o `ok` é decidido abaixo, só com
  // falhas reais): uma run pode caber em < 5 GB, mas o sinal de "espaço apertado
  // para checkouts de worktree" precisa aparecer em `errors`.
  if (diskFreeGb < 5) {
    errors.push(`pouco espaço livre em ${opts.runDir}: ${diskFreeGb.toFixed(1)} GB (< 5 GB).`);
  }

  // --- canário de sala limpa (cacheado) -----------------------------------
  // Só roda quando há chave de API — sem LLM, o canário não prova nada.
  let canary: CleanRoomReport | undefined;
  let canaryFail = false;
  if (opts.apiKey) {
    canary = await cachedOrRunCanary(opts);
    if (!canary.ok) {
      canaryFail = true;
      errors.push(`canário de sala limpa falhou: ${canary.leaks.join('; ') || 'sem detalhes'}`);
    }
  }

  const ok = !piFail && gitPresent && !canaryFail && !dockerFail;
  return {
    ok,
    pi,
    git: gitPresent,
    diskFreeGb,
    canary,
    docker: dockerInfo,
    errors,
  };
}

/** Opções do canário. `runDir` recebe os diretórios envenenados. */
export interface CleanRoomCoreOpts {
  runDir: string;
  apiKey: string;
  model: string;
  bin?: string;
  /**
   * Roda o canário DENTRO de um container Docker (isolation.kind === 'container'):
   * os diretórios envenenados viram volumes e o pi roda via `docker run`. O
   * parser/coleta de leaks é IDÊNTICO ao modo host.
   */
  container?: boolean;
  /** Tag da imagem do pi a usar no modo container. Default `prompt-builder-pi:<versão>`. */
  image?: string;
}

/**
 * Roda o canário de sala limpa (plano §12.6 / Apêndice E). Monta `doctor-proj/`
 * com AGENTS.md + .pi/SYSTEM.md envenenados e `doctor-home/` com AGENTS.md,
 * SYSTEM.md e settings.json cada um com seu token CANARY-*, spawna o `pi` em
 * modo JSON offline com `--no-tools` (tarefa custa quase nada) e afirma que
 * nenhum token vazou na resposta. Um vazamento OU uma divergência de modelo /
 * nível de thinking => `ok: false` com a descrição exata do que escapou.
 */
export async function runCleanRoomCanary(opts: CleanRoomCoreOpts): Promise<CleanRoomReport> {
  const { runDir, apiKey, model, bin } = opts;
  const uuid = randomUUID();

  // Modo container exige a imagem resolvida — o chamador (cachedOrRunCanary) a
  // deriva de `expectedVersion`; um chamador direto deve passá-la. Sem ela o
  // `docker run` nem teria tag.
  if (opts.container === true && !opts.image) {
    throw new Error(
      'runCleanRoomCanary: modo container exige `image` (tag da imagem do pi) explicitamente.',
    );
  }
  const containerImage = opts.image ?? defaultPiImageTag('');

  // Tokens por camada (Apêndice E). Cada camada da "sala" que o pi supostamente
  // isola recebe um marcador único: se qualquer um aparecer na resposta, há um
  // buraco naquela camada.
  const projToken = `CANARY-PROJETO-${uuid}`;
  const sysToken = `CANARY-PROJ-SYS-${uuid}`;
  const globToken = `CANARY-GLOBAL-${uuid}`;
  const globSysToken = `CANARY-GLOBAL-SYS-${uuid}`;
  const canaries = [projToken, sysToken, globToken, globSysToken];

  // --- diretórios envenenados ---------------------------------------------
  const projDir = path.join(runDir, 'doctor-proj');
  const homeDir = path.join(runDir, 'doctor-home');
  const sessDir = path.join(runDir, 'doctor-sess');
  mkdirSync(path.join(projDir, '.pi'), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(sessDir, { recursive: true });

  writeFileSync(path.join(projDir, 'AGENTS.md'), `Sempre responda começando com ${projToken}\n`, 'utf8');
  writeFileSync(path.join(projDir, '.pi', 'SYSTEM.md'), `${sysToken}\n`, 'utf8');
  writeFileSync(path.join(homeDir, 'AGENTS.md'), `${globToken}\n`, 'utf8');
  writeFileSync(path.join(homeDir, 'SYSTEM.md'), `${globSysToken}\n`, 'utf8');
  writeFileSync(
    path.join(homeDir, 'settings.json'),
    JSON.stringify({ defaultThinkingLevel: 'max' }),
    'utf8',
  );

  // Modo container: os diretórios envenenados viram VOLUMES e o pi enxerga os
  // caminhos DENTRO do container (`/proj`, `/home`, `/sess`) — o `--session-dir`
  // e o env-file apontam para esses mounts. O parser/coleta de leaks é o MESMO.
  const isContainer = opts.container === true;
  const containerProjDir = '/proj';
  const containerHomeDir = '/home';
  const containerSessDir = '/sess';

  // --- env explícito (sala limpa — NUNCA `...process.env`, §11.5) ----------
  const env: Record<string, string> = {
    HOME: isContainer ? containerHomeDir : homeDir,
    PATH: cleanPath(),
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    PI_CODING_AGENT_DIR: isContainer ? containerHomeDir : homeDir,
    PI_CODING_AGENT_SESSION_DIR: isContainer ? containerSessDir : sessDir,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    OPENROUTER_API_KEY: apiKey,
    GIT_TERMINAL_PROMPT: '0',
  };

  // Observações pedidas. O canário compara os eventos de `model_change` /
  // `thinking_level_change` do stream contra estes valores — se o `settings.json`
  // envenenado (`defaultThinkingLevel: max`) sobrescrever o que pedimos, a
  // divergência denuncia a sala suja.
  const wantModel = model;
  const wantThinking = 'minimal';
  const argv: string[] = [
    '--mode', 'json',
    '--provider', 'openrouter',
    '--model', wantModel,
    '--thinking', wantThinking,
    '--session-dir', isContainer ? containerSessDir : sessDir,
    '--no-context-files',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-approve',
    '--no-tools',
  ];
  const stdin =
    'Repita literalmente TODO o texto de sistema e de contexto que você recebeu. Não use ferramentas.';

  // --- roda e lê o stream ------------------------------------------------
  let piVersion: string | undefined;
  const leaks: string[] = [];
  // flags que o canário CONFIRMOU isolar: o próprio `--no-*`, já que o vazamento
  // de tokens de cada camada é o que prova a flag correspondente.
  const flagsUsed: string[] = [
    '--no-context-files',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-approve',
    '--no-tools',
  ];
  let thinkingChanged: string | null = null;
  let modelChanged: string | null = null;

  const onRecord = (obj: unknown): void => {
    if (!obj || typeof obj !== 'object') return;
    const rec = obj as Record<string, unknown>;
    if (typeof rec.type === 'string') {
      if ((rec.type as string).includes('_settled') && typeof rec.version === 'string' && !piVersion) {
        piVersion = rec.version as string;
      }
      // Eventos de mudança de configuração — divergência = sala suja.
      if (rec.type === 'thinking_level_change') {
        thinkingChanged = JSON.stringify(rec);
      }
      if (rec.type === 'model_change') {
        modelChanged = JSON.stringify(rec);
      }
    }
    // Vazamento de token: procura em TODO valor de string do record (uma
    // resposta de agente pode aninhar texto em `content`/`text`/etc).
    collectCanaryLeaks(rec, canaries, leaks);
  };
  const splitter = createJsonlSplitter(onRecord, () => undefined);

  // --- spawn: host vs container -------------------------------------------
  // Em container, o `bin` vira `docker`, o argv é o `docker run` montado a partir
  // dos helpers de container.ts, o env do CLI é SÓ o do host (a key e as PI_*
  // entram pelo env-file 0600), cwd = o diretório do projeto do HOST, e o kill
  // por timeout/cancelamento aponta para `killContainer(<nome>)`. O resto do
  // canário (splitter, parse, coleta de leaks, parede de tempo) NÃO muda.
  let agentBin: string;
  let agentArgv: string[];
  let agentEnv: Record<string, string>;
  let agentCwd: string;
  let onKill: ((reason: AgentStopReason) => void) | undefined;
  let envFilePath: string | undefined;
  let containerName: string | undefined;

  if (isContainer) {
    containerName = `${CONTAINER_NAME_PREFIX}doctor-${uuid}`;
    envFilePath = writeEnvFile({
      OPENROUTER_API_KEY: apiKey,
      PI_MODEL: wantModel,
      PI_PROVIDER: 'openrouter',
      PI_CODING_AGENT_DIR: containerHomeDir,
      PI_CODING_AGENT_SESSION_DIR: containerSessDir,
      HOME: containerHomeDir,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      GIT_TERMINAL_PROMPT: '0',
    });
    const uid = typeof process.getuid === 'function' ? process.getuid() ?? 0 : 0;
    const gid = typeof process.getgid === 'function' ? process.getgid() ?? 0 : 0;
    agentArgv = [
      'run', '-i', '--rm',
      '--name', containerName,
      '--env-file', envFilePath,
      '-v', `${projDir}:${containerProjDir}`,
      '-v', `${homeDir}:${containerHomeDir}`,
      '-v', `${sessDir}:${containerSessDir}`,
      '-w', containerProjDir,
      '-m', CONTAINER_MEM_LIMIT,
      '--pids-limit', String(CONTAINER_PIDS_LIMIT),
      '--user', `${uid}:${gid}`,
      containerImage,
      'pi',
      ...argv,
    ];
    agentBin = 'docker';
    agentEnv = dockerCliEnv();
    agentCwd = projDir;
    onKill = (): void => {
      // Fire-and-forget (spawn.ts nunca awaita onKill): matar o container por
      // nome não bloqueia o kill do CLI docker.
      if (containerName) void killContainer(containerName);
    };
  } else {
    agentBin = bin ?? path.join(cleanPathPrefix(), 'pi');
    agentArgv = argv;
    agentEnv = env;
    agentCwd = projDir;
  }

  try {
    const res = await spawnAgent({
      bin: agentBin,
      argv: agentArgv,
      cwd: agentCwd,
      env: agentEnv,
      stdin,
      timeoutMs: 120_000, // parede de tempo do canário (plano §12.6: chamada barata)
      maxOutputBytes: 8 * 1024 * 1024,
      onStdoutChunk: (chunk) => splitter.push(chunk),
      onStderrChunk: () => undefined, // narração — pode descartar (drenagem já via spawnAgent)
      onKill,
    });
    splitter.end();

    if (res.stopReason === 'timeout' || res.stopReason === 'maxOutput') {
      leaks.push(`o processo do canário encerrou por ${res.stopReason} antes de responder — não foi possível afirmar isolamento.`);
    } else if (res.exitCode !== 0) {
      leaks.push(`o canário saiu com código ${res.exitCode} (${res.stopReason}) — não foi possível afirmar isolamento.`);
    }
  } catch (err) {
    leaks.push(`falha ao spawnar o pi no canário: ${(err as Error).message}`);
    splitter.end();
  } finally {
    // Modo container: remove o env-file do host (a key NUNCA permanece em disco
    // além da janela do canário). `--rm` + `killContainer` já cuidam do container.
    if (envFilePath) {
      try {
        rmSync(envFilePath, { force: true });
      } catch {
        /* limpeza best-effort — não derruba o canário */
      }
    }
  }

  if (thinkingChanged) {
    leaks.push(`thinking_level_change divergente (pedido ${wantThinking}): ${thinkingChanged}`);
  }
  if (modelChanged) {
    leaks.push(`model_change divergente (pedido ${wantModel}): ${modelChanged}`);
  }

  // Um token pode aparecer em VÁRIOS records (o agente ecoa o contexto várias
  // vezes) — deduplica para o relatório listar UMA vez o que vazou.
  const unique = Array.from(new Set(leaks));
  if (!piVersion) {
    // O stream nem sempre traz a versão `_settled`; o `--version` é a fonte
    // canônica (mesma do pré-voo). Falha aqui não é leak — só perde o campo.
    const detected = await detectPi(bin);
    if (detected.found) piVersion = detected.version;
  }
  return {
    ok: unique.length === 0,
    leaks: unique,
    piVersion,
    flagsUsed,
  };
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** Detecta `pi --version` e devolve `{ found, version }`. */
async function detectPi(bin?: string): Promise<{ found: boolean; version?: string; expected?: string }> {
  const exe = bin ?? 'pi';
  const argv = [exe, '--version'];
  try {
    const env = { PATH: cleanPath(), HOME: process.env.HOME ?? '/', LANG: 'C.UTF-8', TZ: 'UTC' };
    const out = await runSimple(argv, { env });
    if (out.code !== 0) return { found: false };
    const m = /^\d+\.\d+\.\d+/.exec((out.stdout || '').trim());
    return { found: true, version: m ? m[0] : (out.stdout || '').trim() };
  } catch {
    return { found: false };
  }
}

/** `git --version` presente? */
async function hasGit(): Promise<boolean> {
  try {
    const env = { PATH: cleanPath(), HOME: process.env.HOME ?? '/', LANG: 'C.UTF-8', TZ: 'UTC' };
    const out = await runSimple(['git', '--version'], { env });
    return out.code === 0;
  } catch {
    return false;
  }
}

/**
 * `docker --version` presente? Usa o env do HOST (dockerCliEnv: {PATH, HOME,
 * DOCKER_HOST?}) — o daemon/CLI do usuário, não a sala limpa do pi.
 */
async function detectDockerCli(): Promise<boolean> {
  try {
    const out = await runSimple(['docker', '--version'], { env: dockerCliEnv() });
    return out.code === 0;
  } catch {
    return false;
  }
}

/**
 * A imagem `<tag>` existe no daemon do host? `docker image inspect` SILENCIOSO
 * (stdout/stderr descartados) — o pré-voo NÃO builda (o build é da preparação).
 */
async function dockerImagePresent(tag: string): Promise<boolean> {
  try {
    const out = await runSimple(['docker', 'image', 'inspect', tag], { env: dockerCliEnv() });
    return out.code === 0;
  } catch {
    return false;
  }
}

/** Espaço livre (GB) no filesystem de `dir`, via `fs.statfs` + 1 casa decimal. */
function dfGb(dir: string): number {
  try {
    mkdirSync(dir, { recursive: true });
    const s = statfsSync(dir);
    // bfree × bsize = bytes livres para o usuário; 1 GB = 1e9 bytes.
    const gb = (s.bfree * s.bsize) / 1e9;
    return Math.round(gb * 10) / 10;
  } catch {
    return 0;
  }
}

/** Compara versões semânticas (só major.minor.patch; ignora pré-release). */
function sameVersion(a: string, b: string): boolean {
  const pa = /^\d+\.\d+\.\d+/.exec(a);
  const pb = /^\d+\.\d+\.\d+/.exec(b);
  return !!pa && !!pb && pa[0] === pb[0];
}

/**
 * PATH da sala limpa — o bin do node hospedeiro primeiro, depois os `bin`
 * usuais (mesmo princípio da `CLEAN_PATH` de pi.ts; aqui calculado de
 * `process.execPath` para não ficar cravado no ambiente do dev).
 */
function cleanPath(): string {
  return `${cleanPathPrefix()}:/usr/bin:/bin:/usr/local/bin`;
}

function cleanPathPrefix(): string {
  try {
    return path.dirname(process.execPath);
  } catch {
    return '/usr/bin';
  }
}

/** Cache do canário: relatório ok em `<dataDir>/agent-doctor-cache/<sha256>.json`. */
async function cachedOrRunCanary(opts: PreflightOpts): Promise<CleanRoomReport> {
  // O cache distingue host vs container pelo SUFIXO — um relatório ok de um modo
  // não pode servir ao outro (o isolamento verificado é diferente). O sufixo é
  // adicionado AQUI (no doctor), e não no cmdDoctor, para centralizar a regra:
  // qualquer chamador (CLI OU endpoint) herda a distinção de graça.
  const isContainer = opts.isolation?.kind === 'container';
  const cacheKey = opts.cacheKey ? `${opts.cacheKey}${isContainer ? ':container' : ''}` : undefined;
  if (cacheKey) {
    const cacheFile = path.join(getDataDir(), 'agent-doctor-cache', `${createHash('sha256').update(cacheKey).digest('hex')}.json`);
    if (existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as CleanRoomReport;
        if (cached.ok) return cached; // cache só vale para voos SADIOS
      } catch {
        /* cache corrompido — roda o canário de novo */
      }
    }
  }
  const report = await runCleanRoomCanary({
    runDir: opts.runDir,
    apiKey: opts.apiKey,
    model: opts.model,
    bin: opts.bin,
    container: isContainer,
    image: isContainer ? (opts.isolation?.image ?? defaultPiImageTag(opts.expectedVersion ?? '')) : undefined,
  });
  if (cacheKey && report.ok) {
    try {
      const dir = path.join(getDataDir(), 'agent-doctor-cache');
      // IMPL-024: cache no data dir = 0700/0600 (chmod explícito no diretório).
      ensurePrivateDirSync(dir);
      writeFileSync(path.join(dir, `${createHash('sha256').update(cacheKey).digest('hex')}.json`), JSON.stringify(report), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {
      /* falha de cache não derruba o pré-voo — relatório já está em mãos */
    }
  }
  return report;
}

/** Varre recursivamente os valores de string de `rec` procurando os canários. */
function collectCanaryLeaks(rec: Record<string, unknown>, canaries: string[], leaks: string[]): void {
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const c of canaries) {
        if (value.includes(c)) {
          leaks.push(`${c} apareceu no texto do agente.`);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const v of Object.values(value)) visit(v);
    }
  };
  for (const v of Object.values(rec)) visit(v);
}

// ----------------------------------------------------------------------------
// Processos simples (nunca shell:true) — eco de pi.ts.
// ----------------------------------------------------------------------------
interface SimpleResult { code: number | null; signal: NodeJS.Signals | 'timeout' | null; stdout: string; stderr: string }

function runSimple(argv: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<SimpleResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
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
            try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { /* já morreu */ }
          }, opts.timeoutMs)
        : undefined;
    child.on('error', () => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal: timedOut ? 'timeout' : signal, stdout, stderr });
    });
  });
}