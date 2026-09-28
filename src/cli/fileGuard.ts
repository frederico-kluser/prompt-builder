// Primitivas de arquivo SINCRONAS para a defesa anti-gasto-N× (IMPL-031,
// R-12:REC-6): criação exclusiva com conteúdo, escrita atômica (temp+rename),
// mutex por lockfile com quebra de lock velho por idade e checagem de PID.
//
// Por que síncrono: a reserva do ledger (`CostSink.reserve`) é síncrona por
// contrato — ela roda dentro do gateway, ANTES do fetch, e precisa decidir na
// hora se a chamada cabe no teto diário da máquina. A seção crítica é um
// read-modify-write de um JSON pequeno (~ms); bloquear o event loop por isso é
// o preço de a checagem ser atômica ENTRE PROCESSOS.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

/** Dorme `ms` sem devolver o event loop (Atomics.wait funciona na thread principal do Node). */
export function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_CELL, 0, 0, Math.max(1, Math.floor(ms)));
}

export function hostName(): string {
  try {
    return os.hostname();
  } catch {
    return 'desconhecido';
  }
}

/**
 * O processo `pid` ainda existe NESTA máquina? `EPERM` = existe, mas é de
 * outro usuário (vivo). Só vale para o mesmo host — de outra máquina (home em
 * rede) quem decide é a idade do heartbeat.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Dono (pid, host) ainda vivo? Outro host: vivo enquanto o heartbeat for recente. */
export function ownerAlive(owner: { pid: number; host: string }, heartbeatAgeMs: number, staleMs: number): boolean {
  if (heartbeatAgeMs > staleMs) return false;
  return owner.host === hostName() ? pidAlive(owner.pid) : true;
}

function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Escrita atômica: temp ÚNICO no mesmo diretório + rename (leitor nunca vê arquivo pela metade). */
export function writeAtomicSync(file: string, data: string): void {
  ensureDirSync(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nada */
    }
    throw err;
  }
}

/**
 * Cria `file` com `data` SÓ se ele não existir — e já com o conteúdo inteiro
 * (temp + `link`, que falha com EEXIST de forma atômica). Um `open('wx')` +
 * `write` deixaria uma janela em que outro processo lê o arquivo VAZIO.
 * Devolve false quando o arquivo já existe.
 */
export function createExclusiveSync(file: string, data: string): boolean {
  ensureDirSync(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, data, { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    // Sistema de arquivos sem hard link: cai para open('wx') (janela mínima).
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS') {
      try {
        const fd = fs.openSync(file, 'wx', 0o600);
        try {
          fs.writeSync(fd, data);
        } finally {
          fs.closeSync(fd);
        }
        return true;
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw e2;
      }
    }
    throw err;
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nada */
    }
  }
}

/** JSON do arquivo, ou `null` se não existe / não parseia. */
export function readJsonSync<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** Idade do arquivo pelo mtime (heartbeat), ou Infinity se não existe. */
export function ageMsSync(file: string, now = Date.now()): number {
  try {
    return now - fs.statSync(file).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function unlinkQuietSync(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* já não existe */
  }
}

export interface MutexOptions {
  /** Lock mais velho que isto é de um dono que morreu na seção crítica: quebra. */
  staleMs?: number;
  /** Desiste depois disto (erro). */
  timeoutMs?: number;
}

/**
 * Um lockfile VISTO num instante: identidade do arquivo (dev, inode, mtime) +
 * o conteúdo (o token único do dono). Dois avistamentos iguais = o MESMO lock;
 * qualquer diferença = outro dono (ou o mesmo arquivo reescrito). Comparar só
 * o nome do arquivo é o que deixava um processo apagar o lock de outro.
 */
interface LockSighting {
  dev: number;
  ino: number;
  mtimeMs: number;
  content: string | null;
}

function sightSync(file: string): LockSighting | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  let content: string | null = null;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    // Sumiu entre o stat e a leitura: o avistamento não vai bater com nada,
    // e divergir é sempre o lado SEGURO (não quebra, tenta de novo).
    content = null;
  }
  return { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, content };
}

function sameSighting(a: LockSighting, b: LockSighting): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.content === b.content;
}

function lockToken(): string {
  return `${process.pid}@${hostName()} ${randomUUID()}`;
}

/** `open('wx')` + token. false = já existe (outro dono). */
function tryCreateLockSync(file: string, token: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeSync(fd, token);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** Solta o lock SÓ se ele ainda for nosso (o token confere). */
function releaseLockSync(file: string, token: string): void {
  let atual: string;
  try {
    atual = fs.readFileSync(file, 'utf-8');
  } catch {
    return; // já não existe
  }
  if (atual === token) unlinkQuietSync(file);
}

/**
 * Remove `file` SÓ se ele ainda for o lock avistado em `visto`. O `rename`
 * para um nome único é atômico: depois dele, o que está no nome de lado é
 * exatamente o que saiu do caminho — e dá para conferir com calma. Se o
 * avistamento não bate (o lock trocou de dono entre a olhada e o rename), o
 * arquivo volta ao lugar por `link` (que falha, sem sobrescrever, se alguém já
 * criou outro). true = o lock velho saiu.
 */
function removeIfSameSync(file: string, visto: LockSighting): boolean {
  const aside = `${file}.${process.pid}.${randomUUID()}.stale`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return false; // já não existe (outro quebrou/soltou)
  }
  const movido = sightSync(aside);
  if (movido && sameSighting(movido, visto)) {
    unlinkQuietSync(aside);
    return true;
  }
  try {
    fs.linkSync(aside, file);
  } catch {
    /* alguém já criou outro lock no lugar: nada a devolver */
  }
  unlinkQuietSync(aside);
  return false;
}

/**
 * Quebra um lock VELHO (dono morto na seção crítica) sem nunca apagar um lock
 * fresco. Só um processo quebra por vez (guarda `<lock>.break`); com a guarda,
 * reconfere que o lock ainda é o MESMO avistado como velho e o remove por
 * `removeIfSameSync`. Como dono morto não solta nada e a quebra é serializada,
 * entre a reconferência e o rename o lock só mudaria se o dono "velho" estivesse
 * vivo — e aí o próprio rename o detecta e devolve o arquivo.
 * true = pode tentar de novo já; false = outro processo está quebrando.
 */
function breakStaleLockSync(lockFile: string, visto: LockSighting, staleMs: number): boolean {
  const guard = `${lockFile}.break`;
  const meu = lockToken();
  if (!tryCreateLockSync(guard, meu)) {
    // Guarda velha = quem quebrava morreu no meio (janela de microssegundos).
    const g = sightSync(guard);
    if (g && Date.now() - g.mtimeMs > staleMs) removeIfSameSync(guard, g);
    return false;
  }
  try {
    const agora = sightSync(lockFile);
    if (agora && sameSighting(agora, visto)) removeIfSameSync(lockFile, visto);
    return true;
  } finally {
    releaseLockSync(guard, meu);
  }
}

/**
 * Exclusão mútua ENTRE PROCESSOS por lockfile (`open('wx')` com token único).
 * A seção crítica dura milissegundos; um lock com mais de `staleMs` só pode ser
 * de um processo que morreu dentro dela, e é quebrado — com segurança:
 *   • lock que SUMIU entre o `open` e o `stat` (o dono acabou de soltar) é
 *     "tente de novo já", nunca "velho" — o bug da revisão era tratar a idade
 *     de um arquivo inexistente como infinita e apagar o lock NOVO de outro
 *     processo, perdendo atualizações sob contenção normal, sem dono morto;
 *   • a quebra confere identidade (inode + mtime + token) antes de remover e é
 *     serializada por uma guarda (`breakStaleLockSync`);
 *   • o release só apaga o lock se o token ainda for o nosso.
 * Limite residual: um dono VIVO parado mais que `staleMs` dentro da seção
 * crítica (processo congelado) perde a exclusão — é o preço de todo lock com
 * validade, e a seção crítica aqui é um read-modify-write de ~ms.
 */
export function withMutexSync<T>(lockFile: string, fn: () => T, opts: MutexOptions = {}): T {
  const staleMs = opts.staleMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const inicio = Date.now();
  const token = lockToken();
  ensureDirSync(path.dirname(lockFile));
  for (let tentativa = 0; ; tentativa++) {
    if (tryCreateLockSync(lockFile, token)) break;
    const visto = sightSync(lockFile);
    // Sumiu entre o open e o stat: o dono acabou de soltar — tenta de novo já.
    if (!visto) continue;
    if (Date.now() - visto.mtimeMs > staleMs && breakStaleLockSync(lockFile, visto, staleMs)) continue;
    if (Date.now() - inicio > timeoutMs) {
      throw new Error(`Não consegui o lock de ${lockFile} em ${timeoutMs} ms.`);
    }
    sleepSync(Math.min(2 + tentativa, 25));
  }
  try {
    return fn();
  } finally {
    releaseLockSync(lockFile, token);
  }
}
