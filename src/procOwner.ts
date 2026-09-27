// Dono de um trabalho por PROCESSO (IMPL-030, R-12:REC-5) — lado Node.
//
// Uma run gravada em disco como 'running' só é verdade enquanto o processo que
// a executa estiver vivo. Agentes de programação matam o shell em 2–10 min
// (Claude Code 2/10 min, Cursor ~10 min, Gemini 5 min de inatividade) e o
// SIGKILL não deixa ninguém gravar o fim: sem um dono identificável, a run
// fica 'running' para sempre e um `runs wait` esperaria à toa.
//
// O dono é identificado por PID + host + um TOKEN DE INÍCIO do processo:
//   • mesmo host: vivo = o PID existe E (se o SO expõe) começou no MESMO
//     instante — o PID sozinho seria reaproveitado pelo kernel e uma run morta
//     pareceria viva para sempre;
//   • outro host (data dir compartilhado): pelo batimento (`heartbeatAt`).
//
// Laptop que dormiu acorda dono e leitor juntos — por isso, no mesmo host, o
// batimento velho NÃO é prova de morte (mesma regra de `jobManager.isOrphanJob`).

import { readFileSync } from 'node:fs';
import os from 'node:os';

/** Identidade de quem executa um trabalho (gravada em disco). */
export interface ProcessOwner {
  pid: number;
  host: string;
  /** Token de início do processo (Linux: boot_id + starttime). `null` = SO sem /proc. */
  startToken: string | null;
}

/** O processo existe? EPERM = existe, mas é de outro usuário. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

let bootId: string | null | undefined;

function readBootId(): string | null {
  if (bootId !== undefined) return bootId;
  try {
    bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim() || null;
  } catch {
    bootId = null;
  }
  return bootId;
}

/**
 * Token de início do processo `pid`: no Linux, `boot_id:starttime` (campo 22
 * de /proc/<pid>/stat, em ticks desde o boot). Dois processos com o mesmo PID
 * nunca têm o mesmo token. Fora do Linux (ou sem /proc): `null` — a checagem
 * cai para "PID vivo".
 */
export function processStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // o nome do executável (campo 2) pode ter espaço e parêntese: corta no ÚLTIMO ')'
    const resto = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const starttime = resto[19]; // campo 22 (os campos após ')' começam no 3)
    if (!starttime || !/^\d+$/.test(starttime)) return null;
    return `${readBootId() ?? 'boot?'}:${starttime}`;
  } catch {
    return null;
  }
}

let selfOwner: ProcessOwner | null = null;

/** O dono "este processo" (memoizado: o token não muda durante a vida dele). */
export function currentOwner(): ProcessOwner {
  selfOwner ??= { pid: process.pid, host: os.hostname(), startToken: processStartToken(process.pid) };
  return selfOwner;
}

let signalStoppable = false;

/**
 * Este processo PARA SÓ A PRÓPRIA RUN ao receber SIGTERM (comando de run do
 * CLI com `installGracefulStop`) — e não é um servidor com várias runs. É o que
 * autoriza `runs cancel <runId>` a mandar SIGTERM para o dono de uma run sem
 * job. Gravado no arquivo de dono.
 */
export function setSignalStoppable(on: boolean): void {
  signalStoppable = on;
}

export function isSignalStoppable(): boolean {
  return signalStoppable;
}

/** O dono é este processo? */
export function isCurrentProcess(owner: Pick<ProcessOwner, 'pid' | 'host'>): boolean {
  return owner.pid === process.pid && owner.host === os.hostname();
}

/**
 * O processo dono ainda está vivo? Mesmo host: PID + token de início. Outro
 * host: batimento com menos de `staleAfterMs`.
 */
export function isOwnerAlive(
  owner: { pid: number; host: string; startToken?: string | null; heartbeatAt?: string },
  staleAfterMs: number,
  nowMs = Date.now(),
): boolean {
  if (owner.host === os.hostname()) {
    if (!pidAlive(owner.pid)) return false;
    if (!owner.startToken) return true; // registro antigo/SO sem /proc: só o PID
    const atual = processStartToken(owner.pid);
    // PID vivo mas com OUTRO início = o kernel reaproveitou o número
    return atual === null || atual === owner.startToken;
  }
  const batimento = owner.heartbeatAt ? Date.parse(owner.heartbeatAt) : Number.NaN;
  return Number.isFinite(batimento) && nowMs - batimento <= staleAfterMs;
}
