import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizeRunRecord } from './normalize.js';
import {
  assertValidRecordId,
  chmodPrivate,
  ensurePrivateDir,
  isValidRecordId,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  readFileInside,
  resolveInside,
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
// Runs e sessões carregam prompts, respostas e custos; no CLI moram em
// ~/.prompt-builder, ao lado da key. `mkdir({mode})` só vale na criação, então
// o chmod é EXPLÍCITO (corrige instalações antigas, criadas 0755).
//
// A RAIZ só recebe chmod quando tem o nome dedicado do default do CLI
// (`~/.prompt-builder` ou `$XDG_STATE_HOME/prompt-builder`) — um `--data-dir .`
// não pode mudar a permissão do projeto do usuário. Raiz nova nasce 0700 de
// qualquer forma (mkdir com mode); os subdiretórios nossos sempre são 0700.

function isDedicatedRoot(dir: string): boolean {
  const nome = path.basename(dir);
  return nome === '.prompt-builder' || nome === 'prompt-builder';
}

async function ensurePrivateRoot(): Promise<void> {
  await fs.mkdir(baseDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (isDedicatedRoot(baseDir)) await chmodPrivate(baseDir, PRIVATE_DIR_MODE);
}

async function ensureDir(): Promise<void> {
  await ensurePrivateRoot();
  await ensurePrivateDir(runsDir());
}

/**
 * Arquivo de UMA run. Id validado (regex estrita) + contenção sob runs/:
 * `saveRun` nunca grava fora, e o que `loadRun` recusa nunca foi gravado.
 */
function fileFor(runId: string): string {
  assertValidRecordId(runId, 'id de run');
  return resolveInside(runsDir(), `${runId}.json`);
}

async function writeAtomic(target: string, data: string): Promise<void> {
  // tmp UNICO por escrita: duas escritas concorrentes nao podem mais
  // brigar pelo mesmo "<id>.json.tmp" (era a causa do ENOENT no rename,
  // que derrubava a run inteira quando varios competidores terminavam juntos).
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    // tmp é SEMPRE novo (UUID), então o mode vale; o rename leva o 0600 para o
    // alvo — um record antigo 0644 é corrigido na próxima gravação.
    await fs.writeFile(tmp, data, { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

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
  await ensurePrivateRoot();
  await ensurePrivateDir(sessionsDir());
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
