import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeRunRecord } from './normalize.js';
import {
  assertValidRecordId,
  chmodPrivate,
  ensurePrivateSubtree,
  isValidRecordId,
  PRIVATE_DIR_MODE,
  readFileInside,
  resolveInside,
  writePrivateFileAtomic,
} from './pathSafety.js';
import type { RunMode, RunRecord, SessionRecord } from './types.js';

// Raiz de persistencia. MUTAVEL de proposito: o servidor mantem o default
// historico (`./data`), enquanto o CLI aponta para `~/.prompt-builder` — se o
// CLI instalado gravasse em `process.cwd()`, sujaria o repositorio do usuario.
//
// Os diretorios sao lidos por GETTER, nunca capturados numa const de topo: assim
// `setDataDir` funciona independentemente da ordem de import dos modulos ESM.
let baseDir = process.env.PROMPT_BUILDER_HOME
  ? path.resolve(process.env.PROMPT_BUILDER_HOME)
  : path.resolve(process.cwd(), 'data');

/** Troca a raiz de persistencia. Chame ANTES de qualquer save/load. */
export function setDataDir(dir: string): void {
  baseDir = path.resolve(dir);
}

export function getDataDir(): string {
  return baseDir;
}

function runsDir(): string {
  return path.join(baseDir, 'runs');
}

function sessionsDir(): string {
  return path.join(baseDir, 'sessions');
}

// ---------------------------------------------------------------------------
// Permissões (IMPL-024): diretórios 0700, arquivos 0600
// ---------------------------------------------------------------------------
// Runs, sessões, biblioteca, artefatos de agente e cache carregam prompts,
// respostas, diffs e custos; no CLI moram em ~/.prompt-builder, ao lado da key.
// `mkdir({mode})` só vale na criação, então o chmod é EXPLÍCITO (corrige
// instalações antigas, criadas 0755). TODO writer do data dir passa por
// `ensurePrivateDataRoot`/`ensurePrivateDataDir` — não só os de runs/sessões.
//
// A RAIZ recebe chmod quando é NOVA (criada agora) ou quando é uma raiz
// DEDICADA: o default resolvido do CLI (`~/.prompt-builder`,
// `$XDG_STATE_HOME/prompt-builder`) ou `$PROMPT_BUILDER_HOME`. Nunca pelo nome:
// um `--data-dir` apontando para um projeto que por acaso se chama
// `prompt-builder` não pode ter a permissão trocada. Os subdiretórios nossos
// sempre são 0700 — é o que protege o conteúdo quando a raiz é compartilhada
// (`./data` do servidor, `--data-dir /srv/x`).

/** Raízes que são do prompt-builder por definição (comparadas já resolvidas). */
export function dedicatedDataRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raizes = [path.join(os.homedir(), '.prompt-builder')];
  if (env.XDG_STATE_HOME) raizes.push(path.join(env.XDG_STATE_HOME, 'prompt-builder'));
  if (env.PROMPT_BUILDER_HOME) raizes.push(env.PROMPT_BUILDER_HOME);
  return raizes.map((r) => path.resolve(r));
}

function isDedicatedRoot(dir: string): boolean {
  const abs = path.resolve(dir);
  // Trava de sanidade: nunca a raiz do FS, a home ou um ANCESTRAL dela
  // (`PROMPT_BUILDER_HOME=~` não pode virar chmod 0700 na home inteira).
  if (abs === path.parse(abs).root) return false;
  const relHome = path.relative(abs, path.resolve(os.homedir()));
  if (relHome === '' || (!relHome.startsWith('..') && !path.isAbsolute(relHome))) return false;
  return dedicatedDataRoots().includes(abs);
}

/**
 * Garante a raiz do data dir (mkdir 0700) e, se ela for nova ou dedicada,
 * chmod 0700 explícito. Devolve a raiz. Chame antes de gravar QUALQUER coisa
 * no data dir.
 */
export async function ensurePrivateDataRoot(): Promise<string> {
  const root = baseDir;
  // `mkdir` recursivo devolve o 1º diretório que CRIOU (undefined se já existia)
  const criada = await fs.mkdir(root, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (criada !== undefined || isDedicatedRoot(root)) await chmodPrivate(root, PRIVATE_DIR_MODE);
  return root;
}

/**
 * Diretório `dir` (absoluto, ESTRITAMENTE dentro do data dir) pronto para
 * gravar: raiz garantida + cada nível entre a raiz e `dir` em 0700 com chmod
 * explícito. Devolve `dir`.
 */
export async function ensurePrivateDataDir(dir: string): Promise<string> {
  const root = await ensurePrivateDataRoot();
  await ensurePrivateSubtree(root, dir);
  return dir;
}

/**
 * Grava um arquivo DO data dir (key, registro, item da biblioteca…): pais 0700
 * com chmod explícito e o arquivo via tmp 0600 + rename (`writePrivateFileAtomic`
 * — o conteúdo novo nunca passa por um inode antigo 0644). `target` tem de
 * estar dentro do data dir.
 */
export async function writePrivateDataFile(target: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(path.resolve(target));
  if (dir === path.resolve(baseDir)) await ensurePrivateDataRoot();
  else await ensurePrivateDataDir(dir);
  await writePrivateFileAtomic(target, data);
}

async function ensureDir(): Promise<void> {
  await ensurePrivateDataDir(runsDir());
}

/**
 * Arquivo de UMA run. Id validado (regex estrita) + contenção sob runs/:
 * `saveRun` nunca grava fora, e o que `loadRun` recusa nunca foi gravado.
 */
function fileFor(runId: string): string {
  assertValidRecordId(runId, 'id de run');
  return resolveInside(runsDir(), `${runId}.json`);
}

// tmp único (0600 desde a criação) + rename — ver `writePrivateFileAtomic`.
const writeAtomic = writePrivateFileAtomic;

// Serializa as escritas POR run. saveRun e chamado em paralelo (cada
// competidor salva ao terminar); sem fila as gravacoes se atropelam.
const saveQueues = new Map<string, Promise<unknown>>();

export async function saveRun(record: RunRecord): Promise<void> {
  const target = fileFor(record.id); // valida o id ANTES de criar diretório
  await ensureDir();
  // snapshot sincrono: a fila persiste o estado na ordem das chamadas,
  // sem JSON corrompido por mutacao concorrente do record.
  const data = JSON.stringify(record, null, 2);

  const prev = saveQueues.get(record.id) ?? Promise.resolve();
  // segue a fila mesmo que a escrita anterior tenha falhado
  const job = prev.then(
    () => writeAtomic(target, data),
    () => writeAtomic(target, data),
  );
  saveQueues.set(record.id, job);
  try {
    await job;
  } finally {
    if (saveQueues.get(record.id) === job) saveQueues.delete(record.id);
  }
}

export async function loadRun(runId: string): Promise<RunRecord | null> {
  // Id fora do formato nunca foi gravado por `saveRun`: "não existe", sem
  // tocar o disco. Quem expõe a leitura (rota/tool/comando) valida ANTES para
  // responder 400/uso inválido em vez de 404.
  if (!isValidRecordId(runId)) return null;
  try {
    // contenção léxica + realpath (symlink plantado em runs/ não escapa);
    // EISDIR/EACCES propagam — a rota responde 500 sem derrubar o processo.
    const data = await readFileInside(runsDir(), `${runId}.json`);
    return normalizeRunRecord(JSON.parse(data));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export interface RunSummary {
  id: string;
  status: RunRecord['status'];
  mode: RunMode;
  theme: string;
  stages: number;
  /** Numero de contestants (modelos no compare; variantes no variation/training). */
  contestants: number;
  /** Alias retrocompativel de `contestants`. */
  competitors: number;
  totalCostUsd: number;
  startedAt: string;
  finishedAt?: string;
  sessionId?: string;
  iteration?: number;
}

export async function listRuns(): Promise<RunSummary[]> {
  await ensureDir();
  const dir = runsDir();
  const files = await fs.readdir(dir);
  const summaries: RunSummary[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = await fs.readFile(path.join(dir, f), 'utf-8');
      const r = normalizeRunRecord(JSON.parse(data));
      summaries.push({
        id: r.id,
        status: r.status,
        mode: r.mode,
        theme: r.config.theme,
        stages: r.config.stages,
        contestants: r.contestants.length,
        competitors: r.contestants.length,
        totalCostUsd: r.totalCostUsd,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        sessionId: r.sessionId,
        iteration: r.iteration,
      });
    } catch {
      // ignora arquivo corrompido
    }
  }
  summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return summaries;
}

export async function markOrphansAsAborted(): Promise<void> {
  const all = await listRuns();
  for (const s of all) {
    if (s.status === 'running') {
      const r = await loadRun(s.id);
      if (r && r.status === 'running') {
        r.status = 'aborted';
        r.finishedAt = new Date().toISOString();
        await saveRun(r);
      }
    }
  }
  // Sessoes de treino orfas (processo reiniciou no meio): tambem abortadas.
  const sessions = await listSessions();
  for (const s of sessions) {
    if (s.status === 'running') {
      const rec = await loadSession(s.id);
      if (rec && rec.status === 'running') {
        rec.status = 'aborted';
        rec.finishedAt = new Date().toISOString();
        await saveSession(rec);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sessoes de treino (data/sessions/<id>.json)
// ---------------------------------------------------------------------------

async function ensureSessionsDir(): Promise<void> {
  await ensurePrivateDataDir(sessionsDir());
}

function sessionFileFor(id: string): string {
  assertValidRecordId(id, 'id de sessão');
  return resolveInside(sessionsDir(), `${id}.json`);
}

const sessionSaveQueues = new Map<string, Promise<unknown>>();

export async function saveSession(record: SessionRecord): Promise<void> {
  const target = sessionFileFor(record.id);
  await ensureSessionsDir();
  const data = JSON.stringify(record, null, 2);
  const prev = sessionSaveQueues.get(record.id) ?? Promise.resolve();
  const job = prev.then(
    () => writeAtomic(target, data),
    () => writeAtomic(target, data),
  );
  sessionSaveQueues.set(record.id, job);
  try {
    await job;
  } finally {
    if (sessionSaveQueues.get(record.id) === job) sessionSaveQueues.delete(record.id);
  }
}

export async function loadSession(id: string): Promise<SessionRecord | null> {
  if (!isValidRecordId(id)) return null; // ver loadRun
  try {
    const data = await readFileInside(sessionsDir(), `${id}.json`);
    return JSON.parse(data) as SessionRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export interface SessionSummary {
  id: string;
  status: SessionRecord['status'];
  theme: string;
  iterationsPlanned: number;
  iterationsDone: number;
  totalCostUsd: number;
  startedAt: string;
  finishedAt?: string;
}

export async function listSessions(): Promise<SessionSummary[]> {
  await ensureSessionsDir();
  const dir = sessionsDir();
  const files = await fs.readdir(dir);
  const summaries: SessionSummary[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = await fs.readFile(path.join(dir, f), 'utf-8');
      const r = JSON.parse(data) as SessionRecord;
      summaries.push({
        id: r.id,
        status: r.status,
        theme: r.config.theme,
        iterationsPlanned: r.config.iterations,
        iterationsDone: r.bestPromptByIteration?.length ?? 0,
        totalCostUsd: r.totalCostUsd,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      });
    } catch {
      // ignora arquivo corrompido
    }
  }
  summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return summaries;
}
