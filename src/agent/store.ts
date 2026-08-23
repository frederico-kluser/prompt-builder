// ----------------------------------------------------------------------------
// Store em disco do modo agente — o "onze de verdade" (§14 do
// PLANO-AGENT-ARENA). Layout:
//
//   <dataDir>/agent-runs/<runId>/stages/<stageIndex>/<contestantId>/<repetition>/
//     exec.json   # ExecutionRecord (manifesto)
//     task.txt argv.json events.jsonl session/*.jsonl stdout.log stderr.log
//     workspace.diff workspace.stat files.json oracle.json
//     trajectory.json dossier.md
//     digests.json  # sha256 de CADA arquivo acima — escrito POR ÚLTIMO
//
// Regras que este módulo impõe:
// - Escrita atômica (tmp único `${target}.${randomUUID()}.tmp` + rename),
//   mesmo padrão de `storage.ts` — duas escritas concorrentes brigando pelo
//   mesmo `.tmp` já derrubaram uma run neste repo.
// - `digests.json` é escrito por último e cobre todos os outros arquivos; se ele
//   não existe, a execução foi interrompida durante a coleta.
// - Redação de segredos NA ESCRITA (§14.2): argv/json nunca guardam a key.
// - Caminhos RELATIVOS dentro do ExecutionRecord (o record viaja entre
//   máquinas / `--data-dir` diferentes); o absoluto é montado com getDataDir()
//   + validação de prefixo sob agentRunsRoot() (path traversal — §21.6).
// - `readArtifact` aceita SÓ uma allowlist fechada de nomes — nunca um caminho
//   vindo do cliente.
// ----------------------------------------------------------------------------
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { getDataDir } from '../storage.js';
import type { ExecutionRecord, ExecutionRef } from './types.js';

/** Raiz dos artefatos de agente. *Absoluta* — montada a partir de getDataDir(). */
export function agentRunsRoot(): string {
  return path.join(getDataDir(), 'agent-runs');
}

/**
 * Diretório de UMA execução, RELATIVO a getDataDir() (o ExecutionRecord guarda
 * exatamente este valor em `dir`): `<dataDir>/agent-runs/<runId>/stages/...`.
 */
export function execDir(runId: string, stageIndex: number, contestantId: string, repetition: number): string {
  return path.join('agent-runs', runId, 'stages', String(stageIndex), contestantId, String(repetition));
}

/** Primitiva de escrita atômica — mesmo padrão de storage.ts (suporta Buffer). */
async function writeAtomic(target: string, data: string | Buffer): Promise<void> {
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Redação de segredos (§14.2) — NA ESCRITA, nunca na leitura: um arquivo em
// disco vaza por backup/scp/anexo. Redigir na leitura protege a UI e deixa o
// disco pelado.
// ---------------------------------------------------------------------------

const SECRET_KEY_NAME = /(KEY|TOKEN|SECRET|PASSWORD)/i;
// Valores que parecem chave de API (OpenRouter/Anthropic/OpenAI), com/sem `sk-`.
// SEM flag `g`: um regex global compartilhado tem `.test()` stateful (lastIndex
// avança entre chamadas) e redigiria só às vezes — o bug clássico.
const SECRET_VALUE = /\b(sk-or-|sk-ant-|sk-proj-|sk-[A-Za-z0-9]{16,})[A-Za-z0-9._-]*/;
const REDACTED = '<redigido>';

/**
 * Redige o VALOR de chaves cujo nome casa `/(KEY|TOKEN|SECRET|PASSWORD)/i` e
 * qualquer valor que casa `sk-or-*`/`sk-ant-*` (e afins). Devolve um objeto novo
 * (o input não é mutado). Use ao montar o `env` do `argv.json`.
 */
export function redactEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_KEY_NAME.test(k) || SECRET_VALUE.test(v)) {
      out[k] = REDACTED;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Backstop: redige qualquer texto que contenha um valor de chave (para string artifacts). */
function redactAnyText(text: string): string {
  // regex global FRESCO por chamada — sem estado entre invocações
  return text.replace(new RegExp(SECRET_VALUE.source, 'g'), REDACTED);
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

/** sha256 hex de uma string ou Buffer. */
export function sha256Of(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Allowlist de nomes de artefato legíveis por `readArtifact` — NUNCA um caminho
// vindo do cliente inteiro. `session/*` é o único subdiretório permitido.
// ---------------------------------------------------------------------------

const ALLOWED_ARTIFACT_NAMES = new Set([
  'events.jsonl',
  'workspace.diff',
  'workspace.stat',
  'files.json',
  'oracle.json',
  'trajectory.json',
  'dossier.md',
  'task.txt',
  'argv.json',
  'stderr.log',
  'stdout.log',
  'digests.json',
]);

/** Valida que `name` é seguro e devolve o caminho relativo ao dir de execução. */
function allowedArtifactRelPath(name: string): string {
  const norm = name.replaceAll('\\', '/');
  if (norm.includes('/')) {
    // Único subdiretório permitido: `session/`. Nada de `..` nem sub-`/` extra.
    if (!norm.startsWith('session/')) {
      throw new Error(`artefato não permitido: ${name}`);
    }
    const parts = norm.split('/');
    if (parts.some((p) => p === '..' || p === '' || p === '.')) {
      throw new Error(`caminho de artefato inválido: ${name}`);
    }
    return norm;
  }
  if (!ALLOWED_ARTIFACT_NAMES.has(norm)) {
    throw new Error(`artefato não permitido: ${name}`);
  }
  return norm;
}

// ---------------------------------------------------------------------------
// Escrita da execução
// ---------------------------------------------------------------------------

export interface WriteExecutionOpts {
  execId: string;
  runId: string;
  stageIndex: number;
  contestantId: string;
  repetition: number;
  /** O exec.json final — SEM digests (o store preenche os dos artefatos). */
  record: ExecutionRecord;
  /** nome de arquivo → conteúdo (events.jsonl, session/*.jsonl, trajectory.json…) */
  artifacts: Record<string, string | Buffer>;
}

/**
 * Grava UMA execução completa. `digests.json` é escrito POR ÚLTIMO e cobre todos
 * os outros arquivos; se ele não existe ao reler, a coleta foi interrompida.
 * Devolve o dir relativo (para o ExecutionRecord) e o mapa de digests.
 */
export async function writeExecution(
  opts: WriteExecutionOpts,
): Promise<{ dir: string; digests: Record<string, string> }> {
  const dir = execDir(opts.runId, opts.stageIndex, opts.contestantId, opts.repetition);
  const abs = path.join(getDataDir(), dir);
  await fs.mkdir(abs, { recursive: true });

  const digests: Record<string, string> = {};
  const execTarget = path.join(abs, 'exec.json');

  // 1) artefatos crus (atômicos). `argv.json` é redigido na escrita — sobre o que
  //    o chamador já mandar redigido, é idempotente (o valor já é '<redigido>').
  for (const [name, content] of Object.entries(opts.artifacts)) {
    const rel = allowedArtifactRelPath(name);
    const target = path.join(abs, rel);
    let bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
    if (rel === 'argv.json') {
      // garante que NENHUMA key chega ao disco, mesmo se o chamador esquecer
      bytes = Buffer.from(redactAnyText(bytes.toString('utf-8')), 'utf-8');
    }
    // artefatos podem morar em subdir (`session/*.jsonl`) — garante o pai
    await fs.mkdir(path.dirname(target), { recursive: true });
    await writeAtomic(target, bytes);
    digests[rel] = sha256Of(bytes);
  }

  // 2) exec.json com os digests dos artefatos no próprio record (sem se incluir).
  const record: ExecutionRecord = { ...opts.record, ...{ digests: { ...digests } } };
  const execData = JSON.stringify(record, null, 2);
  await writeAtomic(execTarget, execData);
  digests['exec.json'] = sha256Of(execData);

  // 3) digests.json cobre TUDO — último, provando que a coleta terminou.
  const digestsData = JSON.stringify(digests, null, 2);
  await writeAtomic(path.join(abs, 'digests.json'), digestsData);

  return { dir, digests };
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

/**
 * Resolve o dir de uma ref relativo a getDataDir() e VALIDA que fica sob
 * agentRunsRoot() (path traversal — §21.6). Lança quando o caminho escapa.
 */
function resolveExecDirUnderRoot(refDir: string): string {
  const root = path.resolve(agentRunsRoot());
  const abs = path.resolve(getDataDir(), refDir);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`ExecutionRef.dir escapa de agent-runs: ${refDir}`);
  }
  return abs;
}

/** Lê o `exec.json` de uma ref. NULL se a execução não existe. */
export async function readExecutionRef(ref: ExecutionRef): Promise<ExecutionRecord | null> {
  const abs = resolveExecDirUnderRoot(ref.dir);
  const target = path.join(abs, 'exec.json');
  try {
    const data = await fs.readFile(target, 'utf-8');
    return JSON.parse(data) as ExecutionRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Lê um artefato de uma execução. `name` é validado contra uma allowlist fechada
 * (com `prefixo/session/` como único subdir). NULL se o arquivo não existe.
 */
export async function readArtifact(ref: ExecutionRef, name: string): Promise<string | null> {
  const abs = resolveExecDirUnderRoot(ref.dir);
  const rel = allowedArtifactRelPath(name);
  const target = path.join(abs, rel);
  try {
    return await fs.readFile(target, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Token compartilhado de agentes (Fase 3 — HTTP). Gerado na primeira subida em
// <dataDir>/agents-token (0600); usado no header `x-agents-token`.
// ---------------------------------------------------------------------------

/**
 * Garante o token compartilhado de agentes: cria `<dataDir>/agents-token` com um
 * uuid se ausente, chmod 0600, e devolve o CAMINHO. O token NÃO fica em
 * memória de processo (só no disco 0600); o HTTP lê do arquivo por chamada.
 */
export async function ensureAgentsTokenFile(): Promise<string> {
  const file = path.join(getDataDir(), 'agents-token');
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, randomUUID() + '\n', { encoding: 'utf-8', mode: 0o600 });
  }
  // idempotente: garante o mode mesmo que o arquivo já exista
  await fs.chmod(file, 0o600);
  return file;
}