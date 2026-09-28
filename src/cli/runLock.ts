// Lock de run ATIVA por hash de config + registro de --idempotency-key
// (IMPL-031, R-12:REC-6/DEC-5).
//
// O furo: um agente que re-dispara o mesmo comando (timeout do harness,
// retentativa, dois terminais) criava uma run NOVA a cada vez — N× o gasto,
// sem aviso. Agora:
//   • LOCK: `<data-dir>/locks/run-<hash>.lock` com PID/host/run e heartbeat
//     (mtime renovado a cada 15 s). Segundo processo com a MESMA config é
//     recusado com `error.code: 'run.locked'`. Lock velho — PID morto nesta
//     máquina, ou heartbeat parado há mais de 2 min (PID reciclado, processo
//     congelado, outro host) — é quebrado.
//   • IDEMPOTÊNCIA: `<data-dir>/idempotency/<sha256(key)>.json` liga a key à
//     run. Repetir a key com a mesma config ANEXA à run existente (espera ela
//     terminar, ou devolve o resultado dela) e não gasta nada; com config
//     diferente é erro de uso (`usage.idempotency_conflict`), nunca um reuso
//     silencioso de outro experimento.
//
// O hash ignora `budgetUsd`: o teto é quanto se aceita gastar, não QUAL
// experimento é — repetir a mesma config com outro teto continua sendo a mesma
// run em dobro.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { RunConfig } from '../types.js';
import { CliError, EXIT } from './output.js';
import {
  ageMsSync,
  createExclusiveSync,
  hostName,
  ownerAlive,
  readJsonSync,
  unlinkQuietSync,
  withMutexSync,
  writeAtomicSync,
} from './fileGuard.js';

/** Heartbeat parado há mais que isto = dono morto (ou congelado). */
export const LOCK_STALE_MS = 120_000;
export const HEARTBEAT_MS = 15_000;

// --- hash de config ------------------------------------------------------------

/** JSON com chaves ordenadas (e sem `undefined`): a mesma config dá o mesmo texto. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  const partes = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`);
  return `{${partes.join(',')}}`;
}

/** Identidade do EXPERIMENTO (sha256 hex) — sem o teto de gasto. */
export function configHash(config: RunConfig): string {
  const { budgetUsd: _teto, ...resto } = config as RunConfig & { budgetUsd?: number };
  return createHash('sha256').update(canonicalJson(resto)).digest('hex');
}

// --- dono (lock e idempotência) ---------------------------------------------------

export interface RunOwner {
  pid: number;
  host: string;
  token: string;
  command: string;
  configHash: string;
  runId: string | null;
  sessionId: string | null;
  startedAt: string;
  idempotencyKey: string | null;
}

export function locksDir(dataDir: string): string {
  return path.join(dataDir, 'locks');
}

export function lockFileFor(dataDir: string, hash: string): string {
  return path.join(locksDir(dataDir), `run-${hash.slice(0, 24)}.lock`);
}

export interface LockInspection {
  file: string;
  /** `null` = arquivo ilegível (editado à mão). */
  holder: RunOwner | null;
  heartbeatAgeMs: number;
  stale: boolean;
}

function inspectFile(file: string): LockInspection | null {
  if (!fs.existsSync(file)) return null;
  const holder = readJsonSync<RunOwner>(file);
  const heartbeatAgeMs = ageMsSync(file);
  if (!Number.isFinite(heartbeatAgeMs)) return null; // sumiu entre o exists e o stat
  const stale = holder
    ? !ownerAlive({ pid: holder.pid, host: holder.host }, heartbeatAgeMs, LOCK_STALE_MS)
    : heartbeatAgeMs > LOCK_STALE_MS;
  return { file, holder, heartbeatAgeMs, stale };
}

export function inspectRunLock(dataDir: string, hash: string): LockInspection | null {
  return inspectFile(lockFileFor(dataDir, hash));
}

/** Todos os locks do data-dir (doctor / `limits show`). */
export function listRunLocks(dataDir: string): LockInspection[] {
  let nomes: string[] = [];
  try {
    nomes = fs.readdirSync(locksDir(dataDir)).filter((n) => n.startsWith('run-') && n.endsWith('.lock'));
  } catch {
    return [];
  }
  return nomes
    .map((n) => inspectFile(path.join(locksDir(dataDir), n)))
    .filter((x): x is LockInspection => x !== null);
}

export function runLockedError(insp: LockInspection): CliError {
  const h = insp.holder;
  const id = h?.runId ?? h?.sessionId ?? null;
  return new CliError(
    `Já existe uma execução ATIVA com a mesma config neste data-dir` +
      (h ? ` (pid ${h.pid}@${h.host}, \`${h.command}\`${id ? `, ${h.runId ? 'run' : 'sessão'} ${id}` : ''})` : '') +
      '. Rodar de novo agora gastaria o mesmo experimento em dobro.',
    EXIT.USAGE,
    {
      lockFile: insp.file,
      configHash: h?.configHash ?? null,
      holder: h
        ? {
            pid: h.pid,
            host: h.host,
            command: h.command,
            runId: h.runId,
            sessionId: h.sessionId,
            startedAt: h.startedAt,
            idempotencyKey: h.idempotencyKey,
          }
        : null,
      heartbeatAgeMs: Math.round(insp.heartbeatAgeMs),
      staleAfterMs: LOCK_STALE_MS,
    },
    {
      code: 'run.locked',
      hint:
        (id
          ? `Aguarde a outra terminar (\`prompt-builder ${h?.runId ? 'runs' : 'sessions'} show ${id} --json\`). `
          : 'Aguarde a outra terminar. ') +
        'Para retentar com segurança, use SEMPRE a mesma `--idempotency-key <k>`: a repetição se anexa à run ' +
        'em vez de gastar de novo. Réplica intencional em paralelo: `--allow-concurrent`.',
    },
  );
}

/** Mantém o mtime fresco (heartbeat) enquanto o processo vive. Devolve o `stop`. */
export function startHeartbeat(files: () => string[]): () => void {
  const timer = setInterval(() => {
    const agora = new Date();
    for (const f of files()) {
      try {
        fs.utimesSync(f, agora, agora);
      } catch {
        /* arquivo removido: nada a renovar */
      }
    }
  }, HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export interface RunLockMeta {
  command: string;
  configHash: string;
  runId?: string | null;
  sessionId?: string | null;
  idempotencyKey?: string | null;
}

export class RunLock {
  private stopHeartbeat: () => void;
  private released = false;
  private readonly onExit = (): void => this.release();

  constructor(
    readonly file: string,
    readonly owner: RunOwner,
  ) {
    this.stopHeartbeat = startHeartbeat(() => [this.file]);
    // 2º Ctrl-C (`process.exit`) não roda `finally`: o lock sai mesmo assim.
    process.on('exit', this.onExit);
  }

  /** Registra o id da run/sessão (aparece no `run.locked` de quem chegar depois). */
  update(patch: Partial<Pick<RunOwner, 'runId' | 'sessionId'>>): void {
    if (this.released) return;
    Object.assign(this.owner, patch);
    const atual = readJsonSync<RunOwner>(this.file);
    if (atual?.token === this.owner.token) writeAtomicSync(this.file, JSON.stringify(this.owner, null, 2));
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.stopHeartbeat();
    process.off('exit', this.onExit);
    const atual = readJsonSync<RunOwner>(this.file);
    if (atual?.token === this.owner.token) unlinkQuietSync(this.file);
  }
}

/**
 * Tenta o lock da config. Livre (ou velho) → `RunLock`; ocupado por dono vivo
 * → lança `run.locked`. A criação é atômica (link), então de dois processos
 * simultâneos exatamente um vence.
 */
export function acquireRunLock(dataDir: string, meta: RunLockMeta): RunLock {
  const file = lockFileFor(dataDir, meta.configHash);
  const owner: RunOwner = {
    pid: process.pid,
    host: hostName(),
    token: randomUUID(),
    command: meta.command,
    configHash: meta.configHash,
    runId: meta.runId ?? null,
    sessionId: meta.sessionId ?? null,
    startedAt: new Date().toISOString(),
    idempotencyKey: meta.idempotencyKey ?? null,
  };
  const conteudo = JSON.stringify(owner, null, 2);
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    if (createExclusiveSync(file, conteudo)) return new RunLock(file, owner);
    const insp = inspectFile(file);
    if (!insp) continue; // liberado entre a tentativa e a leitura
    if (!insp.stale) throw runLockedError(insp);
    // Velho: quebra sob mutex, re-conferindo que é o MESMO lock velho (nunca
    // apaga o lock recém-criado por quem quebrou antes).
    withMutexSync(`${file}.guard`, () => {
      const again = inspectFile(file);
      if (again?.stale && again.holder?.token === insp.holder?.token) unlinkQuietSync(file);
    });
  }
  const insp = inspectFile(file);
  if (insp) throw runLockedError(insp);
  throw new CliError(`Não consegui o lock de run em ${file}.`, EXIT.ERROR, { lockFile: file }, { code: 'run.lock_failed' });
}

// --- idempotency-key --------------------------------------------------------------

export interface IdempotencyRecord {
  version: 1;
  key: string;
  configHash: string;
  command: string;
  runId: string | null;
  sessionId: string | null;
  pid: number;
  host: string;
  token: string;
  createdAt: string;
}

const KEY_RE = /^[\x21-\x7e]{1,200}$/;

/** Key utilizável (ASCII visível, ≤ 200) — senão erro de uso. */
export function validateIdempotencyKey(raw: unknown): string {
  const k = typeof raw === 'string' ? raw.trim() : '';
  if (!KEY_RE.test(k)) {
    throw new CliError(
      '--idempotency-key deve ter de 1 a 200 caracteres ASCII visíveis (sem espaço).',
      EXIT.USAGE,
      { flag: '--idempotency-key', value: raw ?? null },
      {
        code: 'usage.invalid_idempotency_key',
        hint: 'Use um id estável por tarefa, ex.: `--idempotency-key tarefa-123-compare`.',
      },
    );
  }
  return k;
}

export function idempotencyFile(dataDir: string, key: string): string {
  const h = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return path.join(dataDir, 'idempotency', `${h}.json`);
}

export function readIdempotency(dataDir: string, key: string): IdempotencyRecord | null {
  const r = readJsonSync<IdempotencyRecord>(idempotencyFile(dataDir, key));
  return r && r.version === 1 && r.key === key ? r : null;
}

/** Cria o registro SÓ se a key ainda não existe (atômico). false = outro processo chegou antes. */
export function claimIdempotency(
  dataDir: string,
  rec: Omit<IdempotencyRecord, 'version' | 'pid' | 'host' | 'token' | 'createdAt'>,
): IdempotencyRecord | null {
  const full: IdempotencyRecord = {
    version: 1,
    ...rec,
    pid: process.pid,
    host: hostName(),
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  return createExclusiveSync(idempotencyFile(dataDir, rec.key), JSON.stringify(full, null, 2)) ? full : null;
}

export function updateIdempotency(dataDir: string, rec: IdempotencyRecord): void {
  const atual = readIdempotency(dataDir, rec.key);
  if (atual?.token === rec.token) writeAtomicSync(idempotencyFile(dataDir, rec.key), JSON.stringify(rec, null, 2));
}

/** Desfaz o registro (a run nem começou — ex.: lock recusado). Só o dono apaga. */
export function dropIdempotency(dataDir: string, rec: IdempotencyRecord): void {
  const atual = readIdempotency(dataDir, rec.key);
  if (atual?.token === rec.token) unlinkQuietSync(idempotencyFile(dataDir, rec.key));
}

/**
 * Validade de um registro de --idempotency-key. Depois dela o registro é
 * coletado e a mesma key RODA DE NOVO (com gasto) — é o contrato de toda API
 * idempotente (a key protege retentativas, não um histórico eterno). Sem isso
 * `<data-dir>/idempotency` crescia para sempre.
 */
export const IDEMPOTENCY_TTL_MS = 30 * 24 * 3_600_000;

/** Sobra de escrita interrompida (`*.tmp`) mais velha que isto é lixo. */
const TMP_LEFTOVER_MS = 24 * 3_600_000;

/**
 * GC de `<data-dir>/idempotency`: remove registros com mais de `ttlMs` (pelo
 * mtime) e temporários órfãos. Seguro com runs em voo: o heartbeat mantém o
 * mtime do registro de um dono vivo fresco (15 s), e ainda assim o dono é
 * checado antes de apagar. Devolve quantos arquivos saíram. Nunca lança.
 */
export function pruneIdempotency(dataDir: string, ttlMs: number = IDEMPOTENCY_TTL_MS, now: number = Date.now()): number {
  const dir = path.join(dataDir, 'idempotency');
  let nomes: string[];
  try {
    nomes = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removidos = 0;
  for (const nome of nomes) {
    const file = path.join(dir, nome);
    const idade = ageMsSync(file, now);
    if (!Number.isFinite(idade)) continue;
    if (nome.endsWith('.tmp')) {
      if (idade > TMP_LEFTOVER_MS) {
        unlinkQuietSync(file);
        removidos += 1;
      }
      continue;
    }
    if (!nome.endsWith('.json') || idade <= ttlMs) continue;
    const rec = readJsonSync<IdempotencyRecord>(file);
    if (rec && ownerAlive({ pid: rec.pid, host: rec.host }, idade, LOCK_STALE_MS)) continue;
    unlinkQuietSync(file);
    removidos += 1;
  }
  return removidos;
}

/** O dono do registro ainda está vivo? (PID nesta máquina; heartbeat de outra.) */
export function idempotencyOwnerAlive(dataDir: string, rec: IdempotencyRecord): boolean {
  return ownerAlive({ pid: rec.pid, host: rec.host }, ageMsSync(idempotencyFile(dataDir, rec.key)), LOCK_STALE_MS);
}

export function idempotencyConflictError(key: string, existing: IdempotencyRecord, hash: string): CliError {
  const id = existing.runId ?? existing.sessionId;
  return new CliError(
    `A --idempotency-key "${key}" já foi usada com OUTRA config (\`${existing.command}\`${id ? `, ${id}` : ''}). ` +
      'Reusar a key para outro experimento devolveria o resultado errado.',
    EXIT.USAGE,
    {
      idempotencyKey: key,
      existing: {
        command: existing.command,
        runId: existing.runId,
        sessionId: existing.sessionId,
        configHash: existing.configHash,
        createdAt: existing.createdAt,
      },
      configHash: hash,
    },
    {
      code: 'usage.idempotency_conflict',
      hint: 'Use uma key nova para esta config (a key identifica UM experimento), ou repita a config original.',
    },
  );
}
