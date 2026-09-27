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
  publicErrorMessage,
  readFileInside,
  resolveInside,
  writePrivateFileAtomic,
} from './pathSafety.js';
import { OWNER_HEARTBEAT_MS, OWNER_STALE_AFTER_MS } from './jobs.js';
import { currentOwner, isOwnerAlive, isSignalStoppable, type ProcessOwner } from './procOwner.js';
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
  // snapshot sincrono: a fila persiste o estado na ordem das CHAMADAS, sem
  // JSON corrompido por mutacao concorrente do record. Nada de `await` antes
  // de entrar na fila (IMPL-030): o dono da run é gravado DENTRO da fila — um
  // await fora dela deixaria a escrita terminal passar à frente da 'running'.
  const data = JSON.stringify(record, null, 2);
  const running = record.status === 'running';
  const owner = ownerFileFor('run', record.id);
  const write = async (): Promise<void> => {
    await ensureDir();
    // IMPL-030: quem grava 'running' é o DONO — o arquivo de dono nasce antes
    // do primeiro record 'running' e some depois do terminal.
    if (running) await acquireOwner('run', record.id, owner);
    await writeAtomic(target, data);
    if (!running) await releaseOwner(owner);
  };

  const prev = saveQueues.get(record.id) ?? Promise.resolve();
  // segue a fila mesmo que a escrita anterior tenha falhado
  const job = prev.then(write, write);
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

/**
 * Boot do servidor: runs/sessões órfãs viram 'aborted'. Desde o IMPL-030 a
 * decisão é pelo DONO (PID/host/início): uma run de um `--detach` do CLI viva
 * no mesmo data dir NÃO é mais marcada por engano. Record sem dono (versão
 * antiga) segue a regra histórica do boot: órfão na hora (`locklessAfterMs: 0`).
 */
export async function markOrphansAsAborted(): Promise<OrphanSweepResult> {
  return sweepOrphanRecords({ locklessAfterMs: 0 });
}

// ---------------------------------------------------------------------------
// Dono da run/sessão em andamento (IMPL-030, R-12:REC-5)
// ---------------------------------------------------------------------------
// `runs/<id>.owner` / `sessions/<id>.owner` (0600; sem `.json`, então
// `listRuns`/`listSessions` não os confundem com records): PID, host, token de
// início e batimento do processo que está EXECUTANDO aquele record. Nasce na
// primeira escrita 'running' (dentro da fila de escrita, antes do record) e
// some depois da terminal. Uma run 'running' cujo dono morreu (SIGKILL do
// shell do agente, queda do processo) é órfã — qualquer comando que a leia
// pode marcá-la 'aborted' na hora, sem esperar timeout.

export type OwnedRecordKind = 'run' | 'session';

/** Conteúdo do arquivo de dono. */
export interface RecordOwner extends ProcessOwner {
  kind: OwnedRecordKind;
  id: string;
  acquiredAt: string;
  heartbeatAt: string;
  /**
   * O dono é um comando de run do CLI que, no SIGTERM, para SÓ esta run
   * (graciosamente). Só então `runs cancel` pode sinalizá-lo; servidor/MCP não.
   */
  signalStop?: boolean;
}

interface HeldOwner {
  kind: OwnedRecordKind;
  id: string;
  file: string;
  acquiredAt: string;
}

function ownerFileFor(kind: OwnedRecordKind, id: string): string {
  assertValidRecordId(id, kind === 'run' ? 'id de run' : 'id de sessão');
  return resolveInside(kind === 'run' ? runsDir() : sessionsDir(), `${id}.owner`);
}

/** Donos que ESTE processo segura, pela chave = caminho absoluto do arquivo. */
const heldOwners = new Map<string, HeldOwner>();
/** Operações por arquivo de dono, em série (batimento nunca recria um dono liberado). */
const ownerOps = new Map<string, Promise<void>>();
let ownerHeartbeat: ReturnType<typeof setInterval> | null = null;
let ownerWarned = false;

function serialOwnerOp(file: string, op: () => Promise<void>): Promise<void> {
  const prev = ownerOps.get(file) ?? Promise.resolve();
  const next = prev.then(op, op);
  ownerOps.set(file, next);
  void next.finally(() => {
    if (ownerOps.get(file) === next) ownerOps.delete(file);
  });
  return next;
}

function ownerPayload(h: HeldOwner, heartbeatAt: string): string {
  const eu = currentOwner();
  const rec: RecordOwner = {
    kind: h.kind,
    id: h.id,
    pid: eu.pid,
    host: eu.host,
    startToken: eu.startToken,
    acquiredAt: h.acquiredAt,
    heartbeatAt,
    ...(isSignalStoppable() ? { signalStop: true } : {}),
  };
  return JSON.stringify(rec);
}

async function acquireOwner(kind: OwnedRecordKind, id: string, file: string): Promise<void> {
  if (heldOwners.has(file)) return;
  await serialOwnerOp(file, async () => {
    if (heldOwners.has(file)) return;
    const h: HeldOwner = { kind, id, file, acquiredAt: new Date().toISOString() };
    try {
      await writePrivateFileAtomic(file, ownerPayload(h, h.acquiredAt));
      heldOwners.set(file, h);
      ensureOwnerHeartbeat();
    } catch (err) {
      // A run NÃO morre por causa do dono: sem ele, a órfã só é reconhecida
      // pela idade da última escrita (LOCKLESS_ORPHAN_AFTER_MS).
      if (!ownerWarned) {
        ownerWarned = true;
        process.stderr.write(`[storage] não consegui gravar o dono de ${kind} ${id}: ${publicErrorMessage(err)}\n`);
      }
    }
  });
}

/** Remove o arquivo de dono (deste processo ou de um dono morto já finalizado). */
async function releaseOwner(file: string): Promise<void> {
  heldOwners.delete(file); // síncrono: o próximo batimento já não o vê
  if (heldOwners.size === 0) stopOwnerHeartbeat();
  await serialOwnerOp(file, () => fs.rm(file, { force: true }));
}

function ensureOwnerHeartbeat(): void {
  if (ownerHeartbeat) return;
  ownerHeartbeat = setInterval(() => {
    const agora = new Date().toISOString();
    for (const h of [...heldOwners.values()]) {
      void serialOwnerOp(h.file, async () => {
        if (heldOwners.get(h.file) !== h) return; // liberado nesse meio-tempo
        await writePrivateFileAtomic(h.file, ownerPayload(h, agora)).catch(() => undefined);
      });
    }
  }, OWNER_HEARTBEAT_MS);
  // Não segura o processo: quem o mantém vivo é a run.
  ownerHeartbeat.unref?.();
}

function stopOwnerHeartbeat(): void {
  if (ownerHeartbeat) {
    clearInterval(ownerHeartbeat);
    ownerHeartbeat = null;
  }
}

/** Lê o dono gravado de uma run/sessão (null = sem dono ou arquivo ilegível). */
export async function readRecordOwner(kind: OwnedRecordKind, id: string): Promise<RecordOwner | null> {
  if (!isValidRecordId(id)) return null;
  try {
    const raw = JSON.parse(await fs.readFile(ownerFileFor(kind, id), 'utf-8')) as Partial<RecordOwner>;
    if (typeof raw.pid !== 'number' || typeof raw.host !== 'string') return null;
    return {
      kind,
      id,
      pid: raw.pid,
      host: raw.host,
      startToken: typeof raw.startToken === 'string' ? raw.startToken : null,
      acquiredAt: typeof raw.acquiredAt === 'string' ? raw.acquiredAt : '',
      heartbeatAt: typeof raw.heartbeatAt === 'string' ? raw.heartbeatAt : '',
      ...(raw.signalStop === true ? { signalStop: true } : {}),
    };
  } catch {
    return null;
  }
}

/** Runs/sessões cujo dono é ESTE processo (o que o encerramento forçado finaliza). */
export function ownedRecords(): { kind: OwnedRecordKind; id: string }[] {
  return [...heldOwners.values()].map((h) => ({ kind: h.kind, id: h.id }));
}

export type OwnerState = 'alive' | 'dead' | 'unknown';

/**
 * Estado do dono de um record 'running': `alive`/`dead` pelo arquivo de dono;
 * `unknown` quando não há arquivo (versão antiga ou escrita do dono falhou) —
 * aí quem decide é a idade da última escrita do record.
 */
export async function ownerStateOf(
  kind: OwnedRecordKind,
  id: string,
  nowMs = Date.now(),
): Promise<{ state: OwnerState; owner: RecordOwner | null }> {
  const owner = await readRecordOwner(kind, id);
  if (!owner) return { state: 'unknown', owner: null };
  return { state: isOwnerAlive(owner, OWNER_STALE_AFTER_MS, nowMs) ? 'alive' : 'dead', owner };
}

export interface OrphanSweepOptions {
  /**
   * Record 'running' SEM dono vira órfão quando o arquivo não muda há isto
   * (ms). Padrão: nunca (só donos mortos contam).
   */
  locklessAfterMs?: number;
  /** Só este alvo (o `runs status/wait` de um id não varre o disco inteiro). */
  only?: { kind: OwnedRecordKind; id: string };
  nowMs?: number;
}

export interface OrphanSweepResult {
  /** Runs marcadas 'aborted' agora. */
  runs: string[];
  /** Sessões marcadas 'aborted' agora. */
  sessions: string[];
}

async function isOrphanRecord(
  kind: OwnedRecordKind,
  id: string,
  nowMs: number,
  locklessAfterMs: number | undefined,
): Promise<boolean> {
  const { state } = await ownerStateOf(kind, id, nowMs);
  if (state === 'alive') return false;
  if (state === 'dead') return true;
  if (locklessAfterMs === undefined) return false;
  if (locklessAfterMs <= 0) return true;
  const st = await fs
    .stat(kind === 'run' ? fileFor(id) : sessionFileFor(id))
    .catch(() => null);
  return st !== null && nowMs - st.mtimeMs >= locklessAfterMs;
}

/**
 * Marca 'aborted' as runs/sessões 'running' cujo processo dono morreu. O
 * record é RELIDO depois da decisão: o dono grava o terminal ANTES de apagar o
 * arquivo de dono, então "sem dono" + record já terminal nunca é sobrescrito.
 * 'aborted' sem `stoppedReason` = o processo morreu sem gravar o fim (órfã); o
 * parcial fica legível.
 */
export async function sweepOrphanRecords(opts: OrphanSweepOptions = {}): Promise<OrphanSweepResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const out: OrphanSweepResult = { runs: [], sessions: [] };
  const alvos: { kind: OwnedRecordKind; id: string }[] = [];
  if (opts.only) {
    alvos.push(opts.only);
  } else {
    for (const r of await listRuns()) if (r.status === 'running') alvos.push({ kind: 'run', id: r.id });
    for (const s of await listSessions()) if (s.status === 'running') alvos.push({ kind: 'session', id: s.id });
  }
  for (const alvo of alvos) {
    if (!isValidRecordId(alvo.id)) continue;
    if (!(await isOrphanRecord(alvo.kind, alvo.id, nowMs, opts.locklessAfterMs))) continue;
    if (alvo.kind === 'run') {
      const r = await loadRun(alvo.id).catch(() => null);
      if (!r || r.status !== 'running') continue;
      r.status = 'aborted';
      r.finishedAt = new Date().toISOString();
      await saveRun(r); // terminal: apaga o arquivo do dono morto
      out.runs.push(alvo.id);
    } else {
      const s = await loadSession(alvo.id).catch(() => null);
      if (!s || s.status !== 'running') continue;
      s.status = 'aborted';
      s.finishedAt = new Date().toISOString();
      await saveSession(s);
      out.sessions.push(alvo.id);
    }
  }
  return out;
}

/**
 * Encerramento FORÇADO deste processo (graça do SIGTERM esgotada, segundo
 * sinal): toda run/sessão que ele ainda segura como 'running' é gravada
 * 'aborted'/`stoppedReason: 'cancelled'` a partir do que já está em disco.
 * Quem chama sai do processo logo depois — nenhuma escrita 'running' em voo
 * chega a passar por cima.
 */
export async function abortOwnedRecords(): Promise<OrphanSweepResult> {
  const out: OrphanSweepResult = { runs: [], sessions: [] };
  for (const { kind, id } of ownedRecords()) {
    try {
      if (kind === 'run') {
        const r = await loadRun(id);
        if (r && r.status === 'running') {
          r.status = 'aborted';
          r.stoppedReason = 'cancelled';
          r.finishedAt = new Date().toISOString();
          await saveRun(r);
          out.runs.push(id);
        }
      } else {
        const s = await loadSession(id);
        if (s && s.status === 'running') {
          s.status = 'aborted';
          s.stoppedReason = 'cancelled';
          s.finishedAt = new Date().toISOString();
          await saveSession(s);
          out.sessions.push(id);
        }
      }
    } catch (err) {
      process.stderr.write(`[storage] não consegui finalizar ${kind} ${id}: ${publicErrorMessage(err)}\n`);
    }
  }
  return out;
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
  // snapshot e ordem de chamada preservados — ver saveRun (IMPL-030)
  const data = JSON.stringify(record, null, 2);
  const running = record.status === 'running';
  const owner = ownerFileFor('session', record.id);
  const write = async (): Promise<void> => {
    await ensureSessionsDir();
    if (running) await acquireOwner('session', record.id, owner);
    await writeAtomic(target, data);
    if (!running) await releaseOwner(owner);
  };
  const prev = sessionSaveQueues.get(record.id) ?? Promise.resolve();
  const job = prev.then(write, write);
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
