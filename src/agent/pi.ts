// ----------------------------------------------------------------------------
// `piExecutor` — o adaptador do executor `pi` (Pi Coding Agent).
//
// Este arquivo implementa a interface `AgentExecutor` (executor.ts) para o `pi`.
// O orquestrador conhece SOMENTE a interface: trocar de executor amanhã é um
// arquivo novo (`pi.ts`), não uma refatoração. Nenhum `if (executor === 'pi')`
// no motor — tudo o que o motor precisa saber da execução entra por
// `AgentRunOutcome` e sai por `AgentRunOpts`.
//
// A receita de sala limpa (env EXPLÍCITO, nunca `...process.env`) e o protocolo
// JSONL vêm do SPIKE do `pi` v0.84.2 — ver PLANO-AGENT-ARENA §11.5/§12. O
// isolamento aqui é de CONFIGURAÇÃO (sala limpa), NÃO de CAPACIDADE: o `pi`
// não tem sandbox próprio (docs/security.md). Contenção de recursos (kill-tree,
// tetos de bytes, parede de tempo, shouldStop) é do `spawnAgent` (spawn.ts).
//
// ⚠️ CONTRATO DE FUNDO (diferença entre o SPIKE e a interface mergeada):
// o `AgentRunOpts` de executor.ts ainda é MINIMAL (execId/task/config/
// workspaceDir/workDir/bin/env). Campos que o SPIKE usou de um `run` rico
// (apiKey/modelId/thinking/systemPrompt/sessionDir/piHomeDir/signal/onEvent/
// priceTokens) NÃO existem no contrato atual. Para não romper o contrato, este
// adaptador DERIVA esses valores dos CÓDIGOS que a interface oferece de fato:
//
//   - modelo ............ env `PI_MODEL_ID` (estampado por `prepare()`/runner).
//   - key OpenRouter ..... env `OPENROUTER_API_KEY` (estampado por `prepare()`).
//   - thinking/tools ..... `opts.config.thinking` / `opts.config.tools`.
//   - promptMode ......... `opts.config.promptMode` (replace/append/none).
//   - system prompt ...... env `PI_SYSTEM_PROMPT` OU `<workDir>/system-prompt.txt`.
//   - tarefa (stdin) ..... env `PI_TASK` OU `<workDir>/task.txt` (plano §12.5).
//   - sessionDir ......... `path.join(opts.workDir, 'session')`.
//   - piHomeDir .......... `path.join(<runDir>, 'pi-home')` em `prepare()`.
//   - signal/onEvent ..... NÃO expostos ainda; turn/cost/tool/settled são
//                          expostos internamente via `PiStreamEvent` (a onda que
//                          for ligar `signal` no contrato repara só aqui).
//
// O canário COMPLETO de sala limpa (tokens CANARY-*) vive no `doctor` — este
// `selfTest` v1 é só o pré-cheque de `pi --version` que o pré-voo precisa.
// ----------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentExecutor, AgentRunOutcome, AgentRunOpts, CleanRoomReport, PrepareOpts, SelfTestOpts } from './executor.js';
import { createJsonlSplitter } from './jsonl.js';
import { spawnAgent, type SpawnAgentResult } from './spawn.js';
import type { AgentLimits, AgentStopReason, AgentTrajectory, AgentTurn } from './types.js';
import {
  buildDockerArgv,
  CONTAINER_NAME_PREFIX,
  CONTAINER_PI_HOME_DIR,
  CONTAINER_SESSION_DIR,
  dockerCliEnv,
  dockerRunAuditArgv,
  ENV_FILE_MASK,
  ensurePiImage,
  killContainer,
  writeEnvFile,
} from './container.js';

// ----------------------------------------------------------------------------
// Constantes da receita (SPIKE v0.84.2)
// ----------------------------------------------------------------------------
/** Caminho do node que hospeda o `pi` (receita do SPIKE — bin do node primeiro). */
const NODE_BIN_DIR = '/home/ondokai/.nvm/versions/node/v24.19.0/bin';

/** PATH da sala limpa — o node do `pi` primeiro, depois os `bin` usuais. */
const CLEAN_PATH = `${NODE_BIN_DIR}:/usr/bin:/bin:/usr/local/bin`;

/** Allowlist DEFAULT de ferramentas (receita do SPIKE). */
const DEFAULT_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];

/** Turnos default por execução (plano §AgentLimits). */
const DEFAULT_MAX_TURNS = 30;
/** Parede de tempo default, ms (plano §AgentLimits: 10 min). */
const DEFAULT_TIMEOUT_MS = 600_000;
/** Teto de stdout+stderr default (plano §AgentLimits: 8 MiB). */
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * MAX_ARG_STRLEN do kernel limita cada string de argv a ~127 KB. Um system
 * prompt acima disso quebra o spawn de forma INDETERMINÍSTICA, por isso o
 * fallback grava o texto num arquivo e passa o caminho (o `pi` aceita
 * "text or file contents"). Teto conservador: 120_000 chars.
 */
const ARG_MAX_SAFE_LEN = 120_000;

/** Buffer circular de stderr: guardamos os últimos ~16 KiB. */
const STDERR_RING_BYTES = 16 * 1024;
/** Tail de stderr no retorno — últimas ~40 linhas. */
const STDERR_TAIL_LINES = 40;

/** Timeout do `npm install` do prefixo isolado. */
const NPM_INSTALL_TIMEOUT_MS = 600_000;

// ----------------------------------------------------------------------------
// Tipos locais
// ----------------------------------------------------------------------------

/** Evento enxuto do stream pi — o que o adaptador emite ao chamador. */
export type PiStreamEvent =
  | { type: 'turn'; index: number; total: number }
  | { type: 'cost'; costUsd: number; tokensIn: number; tokensOut: number; responseId?: string }
  | { type: 'tool'; name: string; ok: boolean; total: number }
  | { type: 'settled'; sessionFile?: string };

/** Opções internas do run — canal de extensão FUTURO (ainda não no contrato). */
export interface PiRunOptions {
  /** Sobrepõe `workDir/session`. */
  sessionDir?: string;
  /** Cancelamento — quando a interface expuser `signal`. */
  signal?: AbortSignal;
  /** Observador do stream enxuto. */
  onEvent?: (e: PiStreamEvent) => void;
  /** Fallback de preço por token quando o `pi` reporta cost 0 (catálogo). */
  priceTokensIn?: (t: number) => number;
  priceTokensOut?: (t: number) => number;
}

/** Resultado intermediário do parser — o que `run()` consome para montar o outcome. */
interface ParsedRun {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  parseErrors: number;
  responseIds: string[];
  settled: boolean;
  /** Turnos individualizados p/ a trajetória mínima (normalização completa é do `trajectory.ts`). */
  turnList: AgentTurn[];
}

/** Resultado de `runSimple` (spawn único, drena os dois pipes). */
interface SimpleResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** Buffer circular de stderr (últimos ~16 KiB). */
class RingBuffer {
  private buf = '';
  private max: number;
  constructor(max: number) {
    this.max = max;
  }
  push(s: string): void {
    this.buf += s;
    if (this.buf.length > this.max) this.buf = this.buf.slice(this.buf.length - this.max);
  }
  /** Pequeno preâmbulo informativo + as últimas `lines` linhas. */
  tail(lines: number, header: string): string {
    const trimmed = this.buf;
    const all = header + '\n' + trimmed;
    const split = all.split('\n').filter((l) => l.length > 0);
    return (header ? `${header}\n` : '') + split.slice(-lines).join('\n');
  }
}

/** Leitura tolerante de `a.b.c` num record JSON (shape varia entre versões do pi). */
function dig(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

// ----------------------------------------------------------------------------
// Helpers de processo (nunca shell:true)
// ----------------------------------------------------------------------------

/** Spawn único, shell SEMPRE desligado, ambos os pipes drenados desde o
 *  primeiro byte (standard do modo agente — §11.3). Usado por `version()` e
 *  pelo `npm install` do `prepare()`/`prepare`. */
function runSimple(argv: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<SimpleResult> {
  return new Promise((resolve, reject) => {
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

// ----------------------------------------------------------------------------
// Receita de sala limpa
// ----------------------------------------------------------------------------

/** `PI_CODING_AGENT_DIR` — a casa vazia do pi (mata toda a camada global). */
function piHomeDir(runDir: string): string {
  return path.join(runDir, 'pi-home');
}

/** Env-base da sala limpa — o mesmo kernel que o SPIKE validou. */
function baseExecutorEnv(runDir: string): Record<string, string> {
  const home = piHomeDir(runDir);
  return {
    HOME: home,
    PATH: CLEAN_PATH,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    PI_CODING_AGENT_DIR: home,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'agent',
    GIT_AUTHOR_EMAIL: 'agent@local',
    GIT_COMMITTER_NAME: 'agent',
    GIT_COMMITTER_EMAIL: 'agent@local',
    // `PI_CODING_AGENT_SESSION_DIR` é preenchido por `run()` — é por EXECUÇÃO,
    // e `prepare()` roda UMA vez por RUN.
  };
}

/** `--thinking` não é passado quando ausente; graça para o canário/compare de modelos. */
function thinkingArg(thinking?: string): string[] {
  return thinking ? ['--thinking', thinking] : [];
}

/**
 * Monta o fragmento argv do system prompt respeitando o ARG_MAX. Quando o texto
 * estoura `ARG_MAX_SAFE_LEN`, grava em `<sessionDir>/<name>` e passa o CAMINHO
 * (o pi aceita "text or file contents"). Retorna argv vazio em promptMode 'none'.
 */
function systemPromptArg(mode: 'replace' | 'append' | 'none', prompt: string, sessionDir: string): string[] {
  if (mode === 'none' || !prompt) return [];
  const flag = mode === 'replace' ? '--system-prompt' : '--append-system-prompt';
  if (prompt.length <= ARG_MAX_SAFE_LEN) return [flag, prompt];
  const file = path.join(sessionDir, mode === 'replace' ? 'system.md' : 'append-system.md');
  writeFileSync(file, prompt, 'utf8');
  return [flag, file];
}

/**
 * Em MODO CONTAINER, reescreve um valor de argv que aponte para um arquivo sob o
 * `sessionDir` do HOST para o caminho equivalente DENTRO do container
 * (`/exec/session/<nome>`). O `systemPromptArg` grava o arquivo no host (que é
 * o bind-mount `/exec/session`) e devolve o CAMINHO DO HOST; o pi roda no
 * container e só enxerga `/exec/session/<nome>`. Valores que não são caminhos
 * de arquivo sob o sessionDir passam intactos (ex.: o próprio texto do prompt).
 */
function toContainerSessionPath(value: string, sessionDir: string): string {
  const prefix = sessionDir.endsWith(path.sep) ? sessionDir : sessionDir + path.sep;
  if (value.startsWith(prefix)) {
    return `${CONTAINER_SESSION_DIR}/${path.basename(value)}`;
  }
  return value;
}

// ----------------------------------------------------------------------------
// Executor
// ----------------------------------------------------------------------------

/**
 * Extração de limits com precedência task > config > defaults. `maxCostUsd`
 * NÃO tem default: em modo agente é obrigatório ser declarado (plano §AgentLimits),
 * e aqui ele é tratado como opcional so o dossiê/runner possa avisar quando faltar.
 */
function resolveLimits(opts: AgentRunOpts): AgentLimits {
  const def = { maxTurns: DEFAULT_MAX_TURNS, timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES };
  return { ...def, ...(opts.config.limits ?? {}), ...(opts.task.limits ?? {}) };
}

/** Lê o texto da tarefa que vai por stdin: env `PI_TASK` OU `<workDir>/task.txt`. */
function readTaskInput(opts: AgentRunOpts, env: Record<string, string>): string {
  if (env.PI_TASK) return env.PI_TASK;
  const f = path.join(opts.workDir, 'task.txt');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

/** Lê o system prompt sob teste: env `PI_SYSTEM_PROMPT` OU `<workDir>/system-prompt.txt`. */
function readSystemPrompt(opts: AgentRunOpts, env: Record<string, string>): string {
  if (env.PI_SYSTEM_PROMPT) return env.PI_SYSTEM_PROMPT;
  const f = path.join(opts.workDir, 'system-prompt.txt');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

/**
 * O parser incremental do stream pi. Alimentado por `createJsonlSplitter`; grava
 * no `ParsedRun` o que `run()` precisa e emite `PiStreamEvent`.
 */
function createPiParser(parsed: ParsedRun, baseOpts: PiRunOptions): (rec: unknown) => void {
  const { onEvent, priceTokensIn, priceTokensOut } = baseOpts;
  let lastResponseId: string | undefined;
  let lastPushedResponseId: string | undefined;

  return (rec: unknown): void => {
    const r = (rec ?? {}) as Record<string, unknown>;
    const type = toStr(r.type);

    switch (type) {
      // Next Turn — novas iterações do mesmo "turno" original (turn_start).
      case 'turn_start': {
        parsed.turns++;
        onEvent?.({ type: 'turn', index: parsed.turns, total: parsed.turns });
        break;
      }
      case 'message_end':
      case 'turn_end': {
        const msg = (r.message ?? r) as Record<string, unknown>;
        const usage = msg.usage;
        const cost = toNum(dig(usage, 'cost.total'));
        const inp = toNum(dig(usage, 'input'));
        const out = toNum(dig(usage, 'output'));
        const rea = toNum(dig(usage, 'reasoning'));
        const cr = toNum(dig(usage, 'cacheRead'));
        const cw = toNum(dig(usage, 'cacheWrite'));

        // `message_end` traz o custo/tokens DA MENSAGEM; `turn_end` traz o
        // AGREGADO do turno (que já inclui as message_end dele). Somar os dois
        // disputaria a contagem (é a hora em que o teto de custo acaba matando
        // mais cedo do que deveria, e os tokens duplicam no dossiê). Por isso:
        // message_end SOMA (incremental); turn_end reajusta pelo ALTO
        // (high-water / monotônico), nunca somando.
        if (type === 'turn_end') {
          parsed.tokensIn = Math.max(parsed.tokensIn, inp);
          parsed.tokensOut = Math.max(parsed.tokensOut, out);
          parsed.tokensReasoning = Math.max(parsed.tokensReasoning, rea);
          parsed.cacheRead = Math.max(parsed.cacheRead, cr);
          parsed.cacheWrite = Math.max(parsed.cacheWrite, cw);
        } else {
          parsed.tokensIn += inp;
          parsed.tokensOut += out;
          parsed.tokensReasoning += rea;
          parsed.cacheRead += cr;
          parsed.cacheWrite += cw;
        }

        // Custo AO VIVO. O pi reporta cost nativo => message_end soma o delta,
        // turn_end é o teto acumulado do turno (high-water). Com cost nativo 0
        // e tokens > 0, o provedor não embutiu preço => estima-se por catálogo,
        // ADITIVO nos dois tipos (não há total nativo para deduplicar). O custo
        // do pi é DERIVADO ('agent-derived') até a reconciliação pelo responseId.
        if (cost > 0) {
          if (type === 'turn_end') {
            parsed.costUsd = Math.max(parsed.costUsd, cost);
          } else {
            parsed.costUsd += cost;
          }
        } else if (inp + out > 0) {
          parsed.costUsd += (priceTokensIn?.(inp) ?? 0) + (priceTokensOut?.(out) ?? 0);
        }
        const rid = toStr(dig(msg, 'responseId'));
        if (rid) {
          lastResponseId = rid;
          // `responseIds`: o ÚLTIMO responseId de cada turno. message_end e
          // turn_end do mesmo turno trazem o mesmo id — dedup de consecutivos.
          if (rid !== lastPushedResponseId) {
            parsed.responseIds.push(rid);
            lastPushedResponseId = rid;
          }
        }
        onEvent?.({
          type: 'cost',
          costUsd: parsed.costUsd,
          tokensIn: parsed.tokensIn,
          tokensOut: parsed.tokensOut,
          responseId: rid || lastResponseId,
        });

        // Turno mínimo p/ a trajetória (o texto/blocos completos, com redação e
        // truncamento, é de responsabilidade do `trajectory.ts` da mesma onda).
        if (type === 'turn_end') {
          parsed.turnList.push({
            index: parsed.turnList.length,
            steps: [],
            usage: { tokensIn: inp, tokensOut: out, costUsd: cost },
            stopReason: toStr(dig(msg, 'rawStopReason') || dig(msg, 'stopReason')) || undefined,
          });
        }
        break;
      }
      case 'tool_execution_start': {
        parsed.toolCalls++;
        onEvent?.({ type: 'tool', name: toStr(r.name), ok: true, total: parsed.toolCalls });
        break;
      }
      case 'tool_execution_end': {
        const err = toNum(dig(r, 'isError')) === 1;
        if (err) parsed.toolErrors++;
        onEvent?.({ type: 'tool', name: toStr(r.name), ok: !err, total: parsed.toolCalls });
        break;
      }
      case 'agent_settled': {
        parsed.settled = true;
        onEvent?.({ type: 'settled' });
        break;
      }
      default:
        break; // session/agent_start/message_start/message_update/agent_end — ignorados
    }
  };
}

export const piExecutor: AgentExecutor = {
  id: 'pi',

  /**
   * Detecta a versão instalada (`pi --version`, 1ª linha). Não roda a sala
   * limpa — é só a detecção que o pré-voo usa para casar com `executorVersion`.
   */
  async version(): Promise<string> {
    let result: SimpleResult;
    try {
      result = await runSimple(['pi', '--version'], { env: { ...process.env, PATH: CLEAN_PATH } });
    } catch (err) {
      throw new Error(`pi --version falhou ao spawnar: ${(err as Error).message}`);
    }
    if (result.code !== 0) {
      throw new Error(`pi --version saiu com ${result.code ?? result.signal}: ${result.stderr.trim().slice(-1000)}`);
    }
    return result.stdout.split('\n')[0].trim();
  },

  /**
   * Prepara o binário + env da sala limpa. Roda UMA vez por RUN (não por
   * execução). 'isolated' instala a versão pinada num prefixo do run;
   * 'system' usa o `pi` do PATH. Devolve `{ bin, env }` com o env-base —
   * sessão, modelo e prompt são preenchidos por `run()`.
   */
  async prepare(opts: PrepareOpts): Promise<{ bin: string; env: Record<string, string> }> {
    const env = baseExecutorEnv(opts.runDir);
    mkdirSync(piHomeDir(opts.runDir), { recursive: true });

    // A key NUNCA vai para log/arquivo/commit — só para o env (redigida na
    // escrita na onda do store). Se ausente, seguimos vazia: o run real exige
    // OPENROUTER_API_KEY, mas o canário/fake (sem custo) não.
    if (process.env.OPENROUTER_API_KEY) env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    // O runner pode fixar o modelo na preparação (via env) — senão o `run`
    // exige `PI_MODEL_ID` (documentado no JSDoc do módulo).
    if (process.env.PI_MODEL_ID) env.PI_MODEL_ID = process.env.PI_MODEL_ID;

    // --- modo CONTAINER (isolation.kind === 'container') ----------------------
    // Cada execução roda num container Docker EFÊMERO. Aqui garantimos a imagem
    // (`prompt-builder-pi:<version>`, CACHEADA por tag — não recria se existir),
    // trocamos o binário para `docker` e estampamos a tag no env (`run`/`selfTest`
    // a consomem). NÃO roda `npm install` isolado em modo container. Os modos
    // 'worktree'/'clone' (install isolated/system) seguem INTOCADOS abaixo.
    const isContainer = opts.isolation?.kind === 'container';
    if (isContainer) {
      const tag = await ensurePiImage(opts.executorVersion, {
        image: opts.isolation?.image,
        runDir: opts.runDir,
      });
      env.PI_CONTAINER_IMAGE = tag;
      return { bin: 'docker', env };
    }

    let bin: string;
    if (opts.install === 'isolated') {
      const prefix = path.join(opts.runDir, 'pi-bin');
      mkdirSync(prefix, { recursive: true });
      const npmEnv = {
        ...process.env,
        HOME: homedir(),
        HUSKY: '0', // nunca caia no hook do pacote
        npm_config_prefix: prefix,
      };
      const install = await runSimple(
        ['npm', 'install', '--prefix', prefix, `@earendil-works/pi-coding-agent@${opts.executorVersion}`],
        { env: npmEnv, timeoutMs: NPM_INSTALL_TIMEOUT_MS },
      ).catch((err) => ({ code: 1, signal: null, stdout: '', stderr: (err as Error).message }));
      if (install.code !== 0) {
        throw new Error(
          `npm install do pi no prefixo do run falhou (${opts.executorVersion}): ` +
            `${install.code ?? install.signal} ${install.stderr.slice(-2000)}`,
        );
      }
      bin = path.join(prefix, 'node_modules', '.bin', 'pi');
    } else {
      bin = 'pi'; // sistema: resolvido por PATH
    }

    return { bin, env };
  },

  /**
   * Executa UMA tarefa no pi. Spawna via `spawnAgent` (kill-tree, tetos,
   * shouldStop) com argv/env da receita, alimenta o parser JSONL a partir do
   * stdout e devolve o `AgentRunOutcome` (trajetória mínima — a normalização
   * completa, redação/truncamento/blocos thinking, é do `trajectory.ts` da
   * mesma onda).
   */
  async run(opts: AgentRunOpts, base?: PiRunOptions): Promise<AgentRunOutcome> {
    const startedAt = Date.now();
    const baseOpts: PiRunOptions = base ?? {};

    // --- diretórios por execução -------------------------------------------
    const sessionDir = baseOpts.sessionDir ?? path.join(opts.workDir, 'session');
    mkdirSync(sessionDir, { recursive: true });

    // Streams CRUS de auditoria (§14): o stdout JSONL íntegro e o stderr INTEIRO
    // do processo, gravados sob `<workDir>/` (que é o execDir — ver
    // `execDir`/`runAgentStage`). São fontes de auditoria; degradam em silêncio
    // se `workDir` não existir / a criação falhar (os logs seguem funcionando).
    let rawOut: WriteStream | undefined;
    let rawErr: WriteStream | undefined;
    try {
      if (existsSync(opts.workDir)) {
        rawOut = createWriteStream(path.join(opts.workDir, 'events.raw.jsonl'), { flags: 'a' });
        rawErr = createWriteStream(path.join(opts.workDir, 'stderr.raw.log'), { flags: 'a' });
      }
    } catch {
      // degrade silencioso — auditoria é melhor-esforço
    }

    // --- env da execução: base preparada + sessão ----------------------------
    const env: Record<string, string> = { ...opts.env, PI_CODING_AGENT_SESSION_DIR: sessionDir };

    // --- modelo: env PI_MODEL_ID (em falta => erro claro de pré-voo) ---------
    const model = env.PI_MODEL_ID;
    if (!model) {
      throw new Error(
        `piExecutor.run: modelo ausente. O runner deve definir PI_MODEL_ID no env ` +
          `preparado (a interface AgentRunOpts ainda não carrega modelId).`,
      );
    }
    const provider = opts.config.provider ?? 'openrouter';
    const thinking = opts.config.thinking;
    const tools = opts.config.tools ?? DEFAULT_TOOLS;
    const promptMode = opts.config.promptMode ?? 'append';
    const limits = resolveLimits(opts);

    const systemPrompt = readSystemPrompt(opts, env);
    const taskInput = readTaskInput(opts, env);

    const isContainer = opts.config.isolation?.kind === 'container';
    const containerTag = env.PI_CONTAINER_IMAGE; // em modo container, `prepare()` estampa a tag

    // --- argv do pi (args posicionais após o binário `pi`) --------------------
    // Compartilhado host/container; diverge só em `--session-dir` e no caminho
    // do system-prompt (que, em container, precisa do caminho DENTRO do
    // container — ver `toContainerSessionPath`).
    const piArgv: string[] = [
      '--mode', 'json',
      '--provider', provider,
      '--model', model,
      ...thinkingArg(thinking),
      '--session-dir', isContainer ? CONTAINER_SESSION_DIR : sessionDir,
      '--no-context-files',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-approve',
      // A flag-teste desativada é registrada por EXTENSÃO (pi-lens) e NÃO existe
      // no núcleo do pi. Como a sala limpa passa `--no-extensions`, o pi
      // responderia `Unknown option: ...` e a execução falharia (verificado
      // numa run real). Mantemos apenas as flags do help do núcleo.
      '--tools', tools.join(','),
      ...(isContainer
        ? systemPromptArg(promptMode, systemPrompt, sessionDir).map((v) => toContainerSessionPath(v, sessionDir))
        : systemPromptArg(promptMode, systemPrompt, sessionDir)),
    ];

    // --- parâmetros de LAUNCH (host vs container) -----------------------------
    // Toda a diferença da execução em container fica AQUI: bin/argv/env do
    // spawnAgent, o gancho de kill do processos externo (Docker) e o env-file
    // temp. O parser/splitter/shouldStop e a montagem do outcome são IDÊNTICOS.
    let agentBin: string;
    let agentArgv: string[];
    let agentEnv: Record<string, string>;
    let agentCwd: string;
    let onKill: ((reason: AgentStopReason) => void) | undefined;
    let containerName: string | undefined;
    let envFile: string | undefined;
    let auditArgv: string[];

    if (isContainer) {
      // A key do OpenRouter NUNCA vai a argv/artefato/volume — entra SÓ pelo
      // env-file (tmp 0600 do host). Run REAL exige a key: sem ela o container
      // não tem como cobrar o modelo.
      if (!env.OPENROUTER_API_KEY) {
        throw new Error(
          `piExecutor.run: modo container exige OPENROUTER_API_KEY no env preparado ` +
            `(o canário/fake sem custo não roda em container).`,
        );
      }
      // Garante os pontos de mount existirem ANTES do `docker run` — um bind de
      // dir AUSENTE cria o diretório como root:root no host, e aí o usuário do
      // host não conseguiria ler/apagar (owneria). `pi-home`/`session` sob
      // workDir são criados como o usuário do host.
      mkdirSync(path.join(opts.workDir, 'pi-home'), { recursive: true });
      mkdirSync(path.join(opts.workDir, 'session'), { recursive: true });

      containerName = `${CONTAINER_NAME_PREFIX}${opts.execId}`;
      envFile = writeEnvFile({
        OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
        PI_MODEL: model,
        PI_PROVIDER: provider,
        PI_CODING_AGENT_DIR: CONTAINER_PI_HOME_DIR,
        PI_CODING_AGENT_SESSION_DIR: CONTAINER_SESSION_DIR,
        HOME: CONTAINER_PI_HOME_DIR,
        PI_OFFLINE: '1',
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
        GIT_TERMINAL_PROMPT: '0',
        // Identidade git do container (o agente commita no workspace; sem ela o
        // `git commit` dentro do container falha) — espelha `baseExecutorEnv`.
        GIT_AUTHOR_NAME: 'agent',
        GIT_AUTHOR_EMAIL: 'agent@local',
        GIT_COMMITTER_NAME: 'agent',
        GIT_COMMITTER_EMAIL: 'agent@local',
      });
      agentArgv = buildDockerArgv({
        image: containerTag,
        containerName,
        envFile,
        workspaceDir: opts.workspaceDir,
        workDir: opts.workDir,
        uid: typeof process.getuid === 'function' ? process.getuid() ?? 0 : 0,
        gid: typeof process.getgid === 'function' ? process.getgid() ?? 0 : 0,
        piArgv,
      });
      // Env do CLI docker = APENAS o mínimo do host — NUNCA a OPENROUTER_API_KEY
      // nem as PI_* (o env do agente entra SÓ pelo env-file).
      agentEnv = dockerCliEnv();
      agentBin = 'docker';
      agentCwd = opts.workspaceDir;
      // Auditoria crua: forma DOCUMENTADA do comando (`docker run ...`) com o
      // caminho do env-file MASCARADO.
      auditArgv = dockerRunAuditArgv({
        image: containerTag,
        containerName,
        envFile,
        workspaceDir: opts.workspaceDir,
        workDir: opts.workDir,
        uid: typeof process.getuid === 'function' ? process.getuid() ?? 0 : 0,
        gid: typeof process.getgid === 'function' ? process.getgid() ?? 0 : 0,
        piArgv,
      }).map((a) => (a === envFile ? ENV_FILE_MASK : a));
      writeFileSync(
        path.join(opts.workDir, 'argv.json'),
        JSON.stringify({ mode: 'container', image: containerTag, argv: auditArgv }, null, 2),
        'utf8',
      );
      onKill = (): void => {
        // Fire-and-forget (spawn.ts nunca awaita onKill): matar o container por
        // nome não bloqueia o kill do CLI docker.
        void killContainer(containerName as string);
      };
    } else {
      agentBin = opts.bin;
      agentArgv = piArgv;
      agentEnv = env;
      agentCwd = opts.workspaceDir;
      auditArgv = piArgv;
    }

    // --- estado do parser ----------------------------------------------------
    const parsed: ParsedRun = {
      turns: 0,
      toolCalls: 0,
      toolErrors: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensReasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
      parseErrors: 0,
      responseIds: [],
      settled: false,
      turnList: [],
    };
    const stderrRing = new RingBuffer(STDERR_RING_BYTES);

    const onRecord = createPiParser(parsed, baseOpts);
    const splitter = createJsonlSplitter(onRecord, () => {
      parsed.parseErrors++;
    });

    let shouldStopReason: AgentStopReason | null = null;
    const shouldStop = (): AgentStopReason | null => {
      if (limits.maxCostUsd != null && parsed.costUsd > limits.maxCostUsd) return 'maxCost';
      if (limits.maxTurns != null && parsed.turns >= limits.maxTurns) return 'maxTurns';
      return null;
    };

    let spawnResult: SpawnAgentResult;
    try {
      spawnResult = await spawnAgent({
        bin: agentBin,
        argv: agentArgv,
        cwd: agentCwd,
        env: agentEnv,
        stdin: taskInput,
        timeoutMs: limits.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: limits.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        onStdoutChunk: (chunk) => {
          splitter.push(chunk);
          // Auditoria (§14): espelha o chunk íntegro no stream cru (a)
          // além do splitter; a falha do stream é degradada em silêncio.
          rawOut?.write(chunk);
          // Deixa o shouldStop ser consultado a cada chunk também (fora do
          // spawnAgent), para o máximo de capacidade de resposta do custo.
          const s = shouldStop();
          if (s) shouldStopReason = s;
        },
        onStderrChunk: (chunk) => {
          stderrRing.push(chunk.toString('utf8'));
          // Auditoria (§14): persiste TODO o stderr, não só o tail.
          rawErr?.write(chunk);
        },
        signal: baseOpts.signal,
        shouldStop,
        // Em container: gancho de kill do container por nome (o CLI docker ser
        // morto NÃO mata o container). Fire-and-forget — spawn.ts nunca awaita.
        onKill,
      });
    } catch (err) {
      // Erro de spawn (binário ausente, permissão) → 'error'. CONTROLE: aborto
      // NÃO é engolido aqui — o spawnAgent resolve (não lança) em 'cancelled'
      // quando há `signal`; e sem `signal` isto é erro real de processo.
      const durationMs = Date.now() - startedAt;
      closeRawStreams(rawOut, rawErr);
      return makeOutcome(opts, parsed, { exitCode: null, signal: null, stopReason: 'error' }, durationMs, `Falha ao spawnar o pi: ${(err as Error).message}`, findSessionFile(sessionDir));
    } finally {
      // Cinto-e-suspensório (modo container): o `--rm` cobre o exit normal, mas
      // um kill por timeout/cancelamento precisa do killContainer explícito.
      // Feito também no erro de spawn acima. + Apaga o env-file tmp 0600.
      if (isContainer) {
        if (containerName) await killContainer(containerName).catch(() => undefined);
        if (envFile) rmSync(envFile, { force: true });
      }
    }
    splitter.end();
    // Auditoria (§14): fecha os streams crus ANTES de montar o outcome.
    closeRawStreams(rawOut, rawErr);

    // `shouldStop` pôde ter corrido por último (custo/turnos). Se o spawnAgent
    // não matou sozinho (por exemplo o teto foi atingido no último chunk, antes
    // de o stdout terminar), o spawn devolve 'completed' — preferimos a razão
    // real do gatilho. Nunca clobber um kill do spawn (cancelled/timeout/etc.).
    let stopReason: AgentStopReason = spawnResult.stopReason;
    if (shouldStopReason && (stopReason === 'completed' || stopReason === 'error' || stopReason === 'maxOutput')) {
      stopReason = shouldStopReason;
    }
    // processou 'completed' normal: o terminal confiável é o agent_settled, mas
    // um processo que sai com exit 0 e SEM o settled ainda é 'completed' honesto.
    if (stopReason === 'completed' && spawnResult.exitCode !== 0) {
      stopReason = 'error';
    }

    const durationMs = Date.now() - startedAt;
    const stderrTail = stderrRing.tail(STDERR_TAIL_LINES, `stderr (${spawnResult.stderrBytes} bytes)`);

    // `sessionFile`: nome do arquivo do transcript deixado em sessionDir, se houver.
    const sessionFile = findSessionFile(sessionDir);

    return makeOutcome(opts, parsed, { ...spawnResult, stopReason }, durationMs, stderrTail, sessionFile);
  },

  /**
   * v1 — pré-cheque de sala limpa via `pi --version` no binário preparado. O
   * canário COMPLETO (tokens CANARY-* via execução real barata) vive no
   * `doctor` (onda 3.3) — este método é o gate barato do pré-voo.
   *
   * Em MODO CONTAINER (`bin === 'docker'`), a verificação é a REAL: `docker run
   * --rm <env.PI_CONTAINER_IMAGE> pi --version` — prova que a imagem existe e
   * responde a versão. Aditiva e segura (não altera o caminho host).
   */
  async selfTest(opts: SelfTestOpts): Promise<CleanRoomReport> {
    try {
      if (opts.bin === 'docker' && opts.env.PI_CONTAINER_IMAGE) {
        // Verificação REAL da imagem via container efêmero (`--rm` cobre o exit).
        const r = await runSimple(
          ['docker', 'run', '--rm', opts.env.PI_CONTAINER_IMAGE, 'pi', '--version'],
          { env: dockerCliEnv() },
        );
        if (r.code !== 0) {
          return {
            ok: false,
            leaks: [`docker run <imagem> pi --version falhou: ${r.code ?? r.signal} ${r.stderr.slice(-500)}`],
            flagsUsed: [],
          };
        }
        return { ok: true, leaks: [], piVersion: r.stdout.split('\n')[0].trim(), flagsUsed: [] };
      }
      const r = await runSimple([opts.bin, '--version'], { env: opts.env });
      if (r.code !== 0) {
        return {
          ok: false,
          leaks: [`pi --version no binário preparado falhou: ${r.code ?? r.signal} ${r.stderr.slice(-500)}`],
          flagsUsed: [],
        };
      }
      return { ok: true, leaks: [], piVersion: r.stdout.split('\n')[0].trim(), flagsUsed: [] };
    } catch (err) {
      return { ok: false, leaks: [`pi --version no binário preparado falhou: ${(err as Error).message}`], flagsUsed: [] };
    }
  },
};

// ----------------------------------------------------------------------------
// Montagem do outcome
// ----------------------------------------------------------------------------

/** Fecha os streams crus de auditoria (§14) — no-op se ausentes (degrade). */
function closeRawStreams(...streams: (WriteStream | undefined)[]): void {
  for (const s of streams) s?.end();
}

function findSessionFile(sessionDir: string): string | undefined {
  // Transcript do pi: <sessionDir>/<ts>_<uuid>.jsonl (plano §12.2 / 9.3).
  try {
    const file = readdirSync(sessionDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .pop();
    return file;
  } catch {
    return undefined;
  }
}

/**
 * `AgentRunOutcome` ampliado com os fatos que o contrato ainda não expõe mas que
 * o store da execução precisa (responseIds, parseErrors, sessionFile, stderrTail).
 * São campos ADITIVOS e opcionais: quem consumir só o contrato os ignora; a onda
 * do store (e o doctor, para o canário BYOK) pode LÊ-los sem tocar o executor.
 */
export type PiRunOutcome = AgentRunOutcome & {
  parseErrors?: number;
  responseIds?: string[];
  sessionFile?: string;
  stderrTail?: string;
  exitCode?: number | null;
  signal?: string | null;
};

/** Monta o `PiRunOutcome` — trajetória mínima a partir do parser. */
function makeOutcome(
  opts: AgentRunOpts,
  parsed: ParsedRun,
  proc: { exitCode: number | null; signal: NodeJS.Signals | null; stopReason: AgentStopReason },
  durationMs: number,
  stderrTail: string,
  sessionFile?: string,
): PiRunOutcome {
  const usage = {
    tokensIn: parsed.tokensIn,
    tokensOut: parsed.tokensOut,
    tokensReasoning: parsed.tokensReasoning,
    cacheRead: parsed.cacheRead,
    cacheWrite: parsed.cacheWrite,
    costUsd: parsed.costUsd,
    costSource: 'agent-derived' as const,
  };

  const trajectory: AgentTrajectory = {
    format: 'agent-trajectory@1',
    executor: { id: piExecutor.id, version: 'unknown' },
    model: { provider: opts.config.provider ?? 'openrouter', id: opts.env.PI_MODEL_ID ?? '' },
    startedAt: new Date(Date.now() - durationMs).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs,
    stopReason: proc.stopReason,
    turns: parsed.turnList,
    usage,
    parseErrors: parsed.parseErrors,
    compactions: [],
  };

  return {
    stopReason: proc.stopReason,
    turns: parsed.turns,
    toolCalls: parsed.toolCalls,
    durationMs,
    usage: { tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, costUsd: parsed.costUsd },
    trajectory,
    // Fatos aditivos p/ o store/O doctor (fora do contrato `AgentRunOutcome`).
    parseErrors: parsed.parseErrors,
    responseIds: parsed.responseIds,
    sessionFile,
    stderrTail,
    exitCode: proc.exitCode,
    signal: proc.signal,
  };
}