import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contentHash } from './engine/hash.js';
import { journalEntryId, parseJournalEntry, type JournalEntry, type JournalStore } from './engine/callJournal.js';
import { normalizeRunRecord } from './normalize.js';
import {
  assertValidRecordId,
  chmodPrivate,
  ensurePrivateSubtree,
  isValidRecordId,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
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

// ---------------------------------------------------------------------------
// Escrita atômica DURÁVEL (IMPL-091, R-09:REC-5): tmp + fsync + rename + fsync
// ---------------------------------------------------------------------------
// O `writePrivateFileAtomic` (tmp 0600 + rename) protege o CONTEÚDO novo, mas
// não a DURABILIDADE: sem fsync, sob queda de energia o rename pode não ter
// chegado ao disco e o arquivo fica vazio/corrompido — o "snapshot anterior
// íntegro" que a run depende. A sequência durável é:
//   1. escreve o tmp (0600 desde a criação) e dá `sync()` nele (fsync do ARQUIVO);
//   2. rename tmp → alvo (o alvo nunca é reescrito no lugar);
//   3. `sync()` no DIRETÓRIO pai — sem isto o próprio rename pode se perder.
// Windows e FS sem fsync de diretório (EPERM/EISDIR/EINVAL) não derrubam a
// escrita: o passo 3 vira aviso único (o risco lá é do SO/FS, não do nosso
// protocolo).
let dirFsyncWarned = false;

async function fsyncDir(dir: string): Promise<void> {
  let dh: fs.FileHandle | null = null;
  try {
    dh = await fs.open(dir, 'r');
    await dh.sync();
  } catch (err) {
    if (!dirFsyncWarned) {
      dirFsyncWarned = true;
      process.stderr.write(
        `[storage] aviso: fsync do diretório não suportado aqui (${publicErrorMessage(err)}); ` +
          'o rename pode não sobreviver a queda de energia neste FS.\n',
      );
    }
  } finally {
    await dh?.close().catch(() => undefined);
  }
}

/**
 * Grava `data` em `target` de forma atômica E durável (protocolo acima). O
 * diretório pai já tem de existir (quem chama decide). Em erro não-crash o tmp
 * é removido; o tmp deixado por kill -9 é descartado por `discardOrphanTemps`.
 */
async function writeDurableAtomic(target: string, data: string | Buffer): Promise<void> {
  const abs = path.resolve(target);
  const dir = path.dirname(abs);
  // tmp ÚNICO por escrita (mesmo sufixo do writePrivateFileAtomic) — duas
  // escritas concorrentes no mesmo alvo não brigam pelo mesmo nome.
  const tmp = `${abs}.${randomUUID()}.tmp`;
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(tmp, 'w', PRIVATE_FILE_MODE);
    await fh.writeFile(data);
    await fh.sync(); // (1) fsync do ARQUIVO antes do rename
    await fh.close();
    fh = null;
    await fs.rename(tmp, abs); // (2) o alvo antigo só some com o rename confirmado
  } catch (err) {
    if (fh) await fh.close().catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  await fsyncDir(dir); // (3) fsync do DIRETÓRIO: o rename sobrevive à queda
}

// Records e checkpoints usam SEMPRE a escrita durável. Onde a batida é
// best-effort (o `.owner` de 800 ms) continua valendo o `writePrivateFileAtomic`
// sem fsync — sincronizar o disco a cada batida trocaria durabilidade por I/O
// sem ganho: o dono é só indício de vida.
const writeAtomic = writeDurableAtomic;

// ---------------------------------------------------------------------------
// Descarte de temporários órfãos (IMPL-091): kill -9 no meio de uma escrita
// deixa `<alvo>.<uuid>.tmp` para trás (o cleanup do catch não roda). Qualquer
// tmp com mais de `ORPHAN_TMP_AFTER_MS` é órfão por definição — escrita viva
// dura milissegundos — e some na varredura de listagem/boot.
// ---------------------------------------------------------------------------

/** Idade a partir da qual um `*.tmp` é considerado órfão (escritas vivas duram ms). */
export const ORPHAN_TMP_AFTER_MS = 60_000;

async function discardTempsIn(dir: string, names: string[], olderThanMs: number, now: number): Promise<string[]> {
  const discarded: string[] = [];
  for (const n of names) {
    if (!n.endsWith('.tmp')) continue;
    const alvo = path.join(dir, n);
    const st = await fs.stat(alvo).catch(() => null);
    if (!st || !st.isFile()) continue;
    if (now - st.mtimeMs < olderThanMs) continue; // pode ser escrita viva de outro processo
    await fs.rm(alvo, { force: true }).catch(() => undefined);
    discarded.push(n);
  }
  return discarded;
}

/**
 * Remove `*.tmp` órfãos de runs/ e sessões/ (temporários de escrita interrompida).
 * `olderThanMs: 0` descarta qualquer tmp — só use quando não há escrita em voo.
 * Devolve os nomes descartados.
 */
export async function discardOrphanTemps(opts: { olderThanMs?: number } = {}): Promise<string[]> {
  const olderThanMs = opts.olderThanMs ?? ORPHAN_TMP_AFTER_MS;
  const now = Date.now();
  const out: string[] = [];
  for (const dir of [runsDir(), sessionsDir()]) {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    out.push(...(await discardTempsIn(dir, names, olderThanMs, now)));
  }
  return out;
}

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
  // IMPL-091: o resumo do índice vem do MESMO snapshot (e não do record vivo).
  const summary = runSummary(record);
  const running = record.status === 'running';
  const owner = ownerFileFor('run', record.id);
  const write = async (): Promise<void> => {
    await ensureDir();
    // IMPL-030: quem grava 'running' é o DONO — o arquivo de dono nasce antes
    // do primeiro record 'running' e some depois do terminal.
    if (running) await acquireOwner('run', record.id, owner);
    await writeAtomic(target, data);
    await indexSavedRecord(runsDir(), target, summary); // cache do listRuns
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

/**
 * Resumo da run para listagem — MESMO cálculo do `runSummary` do espelho web
 * (web/src/engine/storage.ts), com os mesmos fallbacks de record antigo
 * (contestants derivados de `competitorModelIds`, modo da config…).
 */
export function runSummary(r: RunRecord): RunSummary {
  const cfg = (r.config ?? {}) as { theme?: string; stages?: number; competitorModelIds?: string[]; mode?: RunMode };
  const n = r.contestants?.length ?? cfg.competitorModelIds?.length ?? 0;
  return {
    id: r.id,
    status: r.status,
    mode: r.mode ?? cfg.mode ?? 'compare',
    theme: cfg.theme ?? '',
    stages: cfg.stages ?? r.stages?.length ?? 0,
    contestants: n,
    competitors: n,
    totalCostUsd: r.totalCostUsd ?? 0,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    sessionId: r.sessionId,
    iteration: r.iteration,
  };
}

// ---------------------------------------------------------------------------
// Índice de resumos JSONL (IMPL-091, R-09:REC-5): listRuns/listSessions sem
// reler N arquivos JSON
// ---------------------------------------------------------------------------
// `listRuns` relia e fazia parse de TODOS os `<id>.json` (medido: ~500 ms com
// 10 mil runs — o alvo é < 200 ms). Agora cada diretório tem `_index.jsonl`:
// 1 linha por record, com o resumo + `(mtimeMs, size)` do arquivo na hora da
// escrita. A listagem faz `readdir` + `stat` (medido: ~55 ms com 10 mil) e só
// RELÊ os arquivos cujo par `(mtimeMs, size)` mudou — o caso normal é zero.
//
// O índice é CACHE, nunca fonte de verdade: entrada que não bate com o disco é
// refeita; id sem entrada (escrita de outro processo, crash entre o record e o
// índice) é lido do arquivo; entrada sem arquivo cai fora. Uma reescrita do
// índice por dois processos em paralelo pode perder a linha do outro — a
// validação da listagem seguinte detecta e recompõe (auto-curável).
//
// Escrita do índice = reescrita COMPLETA e atômica + durável (tmp no mesmo
// diretório + fsync do arquivo + rename + fsync do diretório): depois de um
// crash o arquivo está íntegro ou é o de antes, nunca meio-termo. Medido com
// 10 mil linhas (~1,7 MB): ~4 ms com fsync.
const INDEX_FILE = '_index.jsonl';

interface IndexEntry<T> {
  /** mtime do arquivo do record quando o resumo foi gravado (detecção de mudança). */
  mtimeMs: number;
  /** tamanho ideem do record (idem). */
  size: number;
  summary: T;
}

function indexFileFor(dir: string): string {
  return path.join(dir, INDEX_FILE);
}

async function readSummaryIndex<T>(dir: string): Promise<Map<string, IndexEntry<T>>> {
  const out = new Map<string, IndexEntry<T>>();
  let texto: string;
  try {
    texto = await fs.readFile(indexFileFor(dir), 'utf-8');
  } catch {
    return out; // sem índice: a primeira listagem recompõe
  }
  for (const linha of texto.split('\n')) {
    if (!linha.trim()) continue;
    try {
      const e = JSON.parse(linha) as IndexEntry<T> & { summary: { id?: string } };
      if (typeof e?.mtimeMs !== 'number' || typeof e?.size !== 'number' || typeof e?.summary?.id !== 'string') continue;
      out.set(e.summary.id, e); // linha repetida (reescrita interrompida): a última vale
    } catch {
      // linha corrompida descartada — o arquivo nunca é escrito pela metade, então
      // isto só aparece por corrupção externa; o record no disco continua valendo.
    }
  }
  return out;
}

// Escritas do índice serializadas por diretório (read-modify-write em paralelo
// se atropelaria); a fila segue mesmo com falha da escrita anterior.
const indexQueues = new Map<string, Promise<unknown>>();

/** Enfileira `task` atrás da última operação do índice deste diretório. */
function withIndexQueue(dir: string, task: () => Promise<void>): Promise<void> {
  const prev = indexQueues.get(dir) ?? Promise.resolve();
  const job = prev.then(task, task);
  // a cauda da fila nunca rejeita (índice é cache: falha de escrita não derruba
  // save nem listagem) e some da memória quando esvazia.
  const tail = job.then(
    () => undefined,
    () => undefined,
  );
  indexQueues.set(dir, tail);
  void tail.then(() => {
    if (indexQueues.get(dir) === tail) indexQueues.delete(dir);
  });
  return job;
}

/** Reescrita COMPLETA do índice (tmp + fsync arquivo + rename + fsync dir). */
async function writeSummaryIndex<T>(dir: string, map: Map<string, IndexEntry<T>>): Promise<void> {
  const texto = [...map.values()].map((e) => JSON.stringify(e)).join('\n') + (map.size ? '\n' : '');
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await writeDurableAtomic(indexFileFor(dir), texto);
}

/**
 * Registra/atualiza o resumo de um record recém-gravado no índice (chamado
 * DENTRO da fila de escrita do record, logo após o rename — o par de validação
 * é o stat do arquivo já no lugar). Nunca rejeita: o índice é cache.
 */
async function indexSavedRecord<T extends SomeSummary>(dir: string, file: string, summary: T): Promise<void> {
  await withIndexQueue(dir, async () => {
    const st = await fs.stat(file).catch(() => null);
    if (!st) return;
    const map = await readSummaryIndex<T>(dir);
    map.set(summary.id, { mtimeMs: st.mtimeMs, size: st.size, summary });
    await writeSummaryIndex(dir, map);
  }).catch(() => undefined);
}

type SomeSummary = { id: string; startedAt: string };

/**
 * Listagem por índice: `readdir` + `stat` + re-leitura SÓ do que mudou.
 * `derive` transforma o record parseado em resumo (devolve null = ignora).
 */
async function listSummaries<T extends SomeSummary>(
  dir: string,
  derive: (raw: unknown) => T | null,
): Promise<T[]> {
  const names = await fs.readdir(dir);
  await discardTempsIn(dir, names, ORPHAN_TMP_AFTER_MS, Date.now());
  const records = names.filter((f) => f.endsWith('.json'));
  const index = await readSummaryIndex<T>(dir);
  // Stats em PARALELO: medido com 10 mil arquivos, ~55 ms em lote contra ~190 ms
  // na sequência (era o que comia o orçamento dos 200 ms). A re-leitura dos
  // records que MUDARAM continua sequencial e costuma ser de zero arquivos.
  const stats = await Promise.all(records.map((f) => fs.stat(path.join(dir, f)).catch(() => null)));
  const next = new Map<string, IndexEntry<T>>();
  const out = new Map<string, T>();
  let dirty = false;
  for (let i = 0; i < records.length; i++) {
    const f = records[i];
    const st = stats[i];
    const file = path.join(dir, f);
    const id = f.slice(0, -'.json'.length);
    if (!st || !st.isFile()) {
      dirty = true;
      continue;
    }
    const entry = index.get(id);
    if (entry && entry.mtimeMs === st.mtimeMs && entry.size === st.size) {
      next.set(id, entry);
      out.set(id, entry.summary);
      continue;
    }
    dirty = true; // sem entrada ou arquivo mudou: relê do disco
    try {
      const summary = derive(JSON.parse(await fs.readFile(file, 'utf-8')));
      if (!summary) continue;
      next.set(id, { mtimeMs: st.mtimeMs, size: st.size, summary });
      out.set(id, summary);
    } catch {
      // ignora arquivo corrompido (mesmo contrato de antes)
    }
  }
  if (index.size !== next.size) dirty = true; // entradas órfãs do índice caem aqui
  if (dirty) await withIndexQueue(dir, () => writeSummaryIndex(dir, next)).catch(() => undefined);
  return [...out.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function listRuns(): Promise<RunSummary[]> {
  await ensureDir();
  return listSummaries(runsDir(), (raw) => {
    const r = raw as Partial<RunRecord> & { id?: string; startedAt?: string };
    if (!r?.id || !r.startedAt || !r.status) return null;
    return runSummary(r as RunRecord);
  });
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
  const summary = sessionSummary(record); // IMPL-091: mesmo snapshot do record
  const running = record.status === 'running';
  const owner = ownerFileFor('session', record.id);
  const write = async (): Promise<void> => {
    await ensureSessionsDir();
    if (running) await acquireOwner('session', record.id, owner);
    await writeAtomic(target, data);
    await indexSavedRecord(sessionsDir(), target, summary); // cache do listSessions
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

/**
 * Resumo da sessão para listagem — MESMO cálculo do `sessionSummary` do
 * espelho web (web/src/engine/storage.ts).
 */
export function sessionSummary(s: SessionRecord): SessionSummary {
  return {
    id: s.id,
    status: s.status,
    theme: s.config?.theme ?? '',
    iterationsPlanned: s.config?.iterations ?? 0,
    iterationsDone: s.bestPromptByIteration?.length ?? 0,
    totalCostUsd: s.totalCostUsd ?? 0,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
  };
}

export async function listSessions(): Promise<SessionSummary[]> {
  await ensureSessionsDir();
  return listSummaries(sessionsDir(), (raw) => {
    const s = raw as Partial<SessionRecord> & { id?: string; startedAt?: string };
    if (!s?.id || !s.startedAt || !s.status) return null;
    return sessionSummary(s as SessionRecord);
  });
}

// ---------------------------------------------------------------------------
// Journal de chamadas (IMPL-081, R-10:REC-2) — retomada sem repetir chamadas
// pagas. Este é o ADAPTADOR Node (arquivo); o núcleo — chave canônica,
// ocorrência, replay e política de retomada — é fonte única em
// `src/engine/callJournal.ts` (o gateway o consulta ANTES de cada chamada e
// grava DEPOIS de cada resposta, via `sink.callJournal`).
// ---------------------------------------------------------------------------
// `saveRun` guarda só o snapshot do record: depois de um crash/kill no meio da
// run, o usuário reexecutava TUDO — as chamadas já pagas eram repetidas.
// `runs/<id>.journal` é append-only com 1 linha por chamada CONCLUÍDA; na
// retomada (`runs resume <id>`) as respostas gravadas voltam a US$ 0 — replay,
// não re-execução.
//
// ATOMICIDADE (grupo competidores + julgamento): a retomada re-executa o
// pipeline INTEIRO — nenhuma etapa é carregada pela metade do disco — e só as
// CHAMADAS vêm do journal. A chave é o conteúdo do pedido, então a
// dependência se resolve sozinha (competidor refeito => texto novo => o pedido
// do juiz muda => o juiz é chamado de novo). Por isso não há "commit de grupo":
// travar o replay até o grupo fechar faria o kill no meio do julgamento pagar
// de novo TODAS as respostas do grupo — o contrário do critério (i).
//
// Durabilidade: o append é escrita de CHECKPOINT — tmp não serve
// (append-only), então a entrada é escrita com fsync na hora (`'strict'`); as
// batidas periódicas do record (800 ms) seguem sem fsync. Espelho web:
// web/src/engine/callJournal.ts (IndexedDB, durability 'strict').
export interface CallJournalEntry {
  /** Id da entrada (`<chave canônica>#<ocorrência>` — ver `journalEntryId`). */
  key: string;
  /** Rótulo livre (o papel da chamada) — só para inspeção. */
  group: string;
  /** ISO do momento em que a chamada CONCLUIU (resultado já na mão). */
  at: string;
  /** A entrada do núcleo (`JournalEntry`), serializável. */
  result: unknown;
}

type CallJournalLine = { t: 'call' } & CallJournalEntry;

/**
 * Hash canônico (JCS) de `model + messages + params` — identidade de conteúdo
 * genérica, mesma função no espelho web (fonte única em src/engine/hash.ts).
 * O motor usa a chave COMPLETA de `journalRequestKey` (papel, esforço,
 * formato da saída, blindagem do juiz normalizada…).
 */
export function callJournalKey(model: string, messages: unknown, params?: unknown): string {
  return contentHash({ model, messages, params: params ?? null });
}

function journalFileFor(runId: string): string {
  assertValidRecordId(runId, 'id de run');
  return resolveInside(runsDir(), `${runId}.journal`);
}

// Appends serializados por run (append + fsync na ordem das chamadas).
const journalQueues = new Map<string, Promise<unknown>>();

function withJournalQueue(runId: string, task: () => Promise<void>): Promise<void> {
  const prev = journalQueues.get(runId) ?? Promise.resolve();
  const job = prev.then(task, task);
  const tail = job.then(
    () => undefined,
    () => undefined,
  );
  journalQueues.set(runId, tail);
  void tail.then(() => {
    if (journalQueues.get(runId) === tail) journalQueues.delete(runId);
  });
  return job;
}

/**
 * Append DURÁVEL de um lote de linhas do journal (fsync antes de devolver =
 * checkpoint 'strict'). Quem gravou só segue depois do fsync.
 */
async function appendJournalLine(runId: string, texto: string): Promise<void> {
  await ensureDir();
  const file = journalFileFor(runId);
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(file, 'a', PRIVATE_FILE_MODE);
    await fh.writeFile(texto);
    await fh.sync(); // sem isto o journal perderia a chamada já paga sob crash
    await fh.close();
    fh = null;
  } catch (err) {
    if (fh) await fh.close().catch(() => undefined);
    throw err;
  }
}

/**
 * COMMIT EM GRUPO: as entradas que chegam enquanto o lote anterior está no
 * fsync entram no PRÓXIMO lote — 1 escrita + 1 fsync por lote, não por
 * chamada. Sem isto as etapas paralelas enfileiravam um fsync por resposta
 * (a vazão do journal viraria 1/latência do fsync).
 */
const openJournalBatches = new Map<string, { lines: string[]; done: Promise<void> }>();

/**
 * Grava 1 entrada por chamada CONCLUÍDA (o resultado fica para replay). Chame
 * depois de a resposta chegar — nunca antes: entrada sem resultado não é
 * replayable de qualquer jeito. Resolve só depois do fsync do lote dela.
 */
export function appendCallJournal(runId: string, entry: CallJournalEntry): Promise<void> {
  const linha: CallJournalLine = { t: 'call', key: entry.key, group: entry.group, at: entry.at, result: entry.result };
  const texto = `${JSON.stringify(linha)}\n`;
  let lote = openJournalBatches.get(runId);
  if (!lote) {
    const novo = { lines: [] as string[], done: Promise.resolve() };
    novo.done = withJournalQueue(runId, async () => {
      // O lote FECHA quando começa a ser gravado: quem chega agora vai no próximo.
      if (openJournalBatches.get(runId) === novo) openJournalBatches.delete(runId);
      await appendJournalLine(runId, novo.lines.join(''));
    });
    openJournalBatches.set(runId, novo);
    lote = novo;
  }
  lote.lines.push(texto);
  return lote.done;
}

/**
 * Entradas do journal (ordem de escrita; id repetido = vale a 1ª). Linha rasgada
 * por kill no meio do append é descartada — as anteriores (com fsync) valem.
 * Linhas `commit` de journals antigos são ignoradas.
 */
export async function readCallJournal(runId: string): Promise<CallJournalEntry[]> {
  const calls = new Map<string, CallJournalEntry>();
  let texto: string;
  try {
    texto = await fs.readFile(journalFileFor(runId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  for (const linha of texto.split('\n')) {
    if (!linha.trim()) continue;
    try {
      const l = JSON.parse(linha) as Partial<CallJournalLine>;
      if (l?.t === 'call' && typeof l.key === 'string' && typeof l.group === 'string' && !calls.has(l.key)) {
        calls.set(l.key, { key: l.key, group: l.group, at: String(l.at ?? ''), result: l.result });
      }
    } catch {
      // linha rasgada por kill no meio do append: descartada
    }
  }
  return [...calls.values()];
}

/** Porta de persistência do núcleo (`CallJournal`) para uma run — o arquivo com fsync. */
export function callJournalStore(runId: string): JournalStore {
  return {
    append: (e: JournalEntry) =>
      appendCallJournal(runId, { key: journalEntryId(e), group: e.role, at: e.at, result: e }),
  };
}

/** Entradas VÁLIDAS do journal da run (o que a retomada pode replayar). */
export async function loadCallJournal(runId: string): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for (const e of await readCallJournal(runId)) {
    const parsed = parseJournalEntry(e.result);
    if (parsed && journalEntryId(parsed) === e.key) out.push(parsed);
  }
  return out;
}

/**
 * Apaga o journal da run (a run CONCLUIU — ou o record foi deletado e o
 * cache de idempotência não tem mais razão de existir). Idempotente.
 */
export async function clearCallJournal(runId: string): Promise<void> {
  if (!isValidRecordId(runId)) return;
  await withJournalQueue(runId, () => fs.rm(journalFileFor(runId), { force: true }));
}
