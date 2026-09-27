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
 * Exclusão mútua ENTRE PROCESSOS por lockfile (`open('wx')`). A seção crítica
 * dura milissegundos; um lock com mais de `staleMs` só pode ser de um processo
 * que morreu dentro dela, e é quebrado. (Limite conhecido: dois processos que
 * vejam o MESMO lock velho no mesmo instante podem ambos quebrá-lo — exige um
 * dono morto E uma corrida de microssegundos; aceito.)
 */
export function withMutexSync<T>(lockFile: string, fn: () => T, opts: MutexOptions = {}): T {
  const staleMs = opts.staleMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const inicio = Date.now();
  ensureDirSync(path.dirname(lockFile));
  for (let tentativa = 0; ; tentativa++) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      try {
        fs.writeSync(fd, `${process.pid}@${hostName()}`);
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (ageMsSync(lockFile) > staleMs) {
        unlinkQuietSync(lockFile);
        continue;
      }
      if (Date.now() - inicio > timeoutMs) {
        throw new Error(`Não consegui o lock de ${lockFile} em ${timeoutMs} ms.`);
      }
      sleepSync(Math.min(2 + tentativa, 25));
    }
  }
  try {
    return fn();
  } finally {
    unlinkQuietSync(lockFile);
  }
}
