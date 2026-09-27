// Detecção de runs/sessões ÓRFÃS na SPA (IMPL-023, R-10:REC-1 / DEC-2).
//
// Órfã = record 'running' no IndexedDB cujo lock (runLocks.ts) está LIVRE: a
// aba que a executava foi fechada, recarregada ou travou — o navegador soltou o
// lock junto com o contexto. Ela vira `aborted` + `stoppedReason: 'orphan'`,
// com o parcial que foi salvo, em vez de ficar 'running' para sempre (antes:
// run zumbi no histórico, sem motivo nenhum).
//
// Regras:
//  • a decisão é SEMPRE tomada segurando o lock e RELENDO o record dentro dele —
//    quem terminou entre a listagem e a checagem aparece 'settled', nunca órfã;
//  • nenhum timestamp entra na decisão: aba congelada mantém o lock (viva);
//  • sem Web Locks não se marca nada sozinho ('unsupported'): a UI oferece a
//    marcação manual (`markRunInterrupted`/`markSessionInterrupted`).

import { getRunRecord, getSessionRecord } from './events';
import { isHeldHere, locksSupported, whenLockReleased, withLockIfFree, type LockSubject } from './runLocks';
import { listRuns, listSessions, loadRun, loadSession, saveRun, saveSession } from './storage';
import type { RunRecord, SessionRecord } from './types';

export type OrphanCheck<R> =
  /** Estava 'running' sem dono: acabou de ser marcada aborted/orphan (e gravada). */
  | { state: 'orphaned'; record: R }
  /** Tem dono vivo (outra aba ou esta): segue 'running'. */
  | { state: 'alive'; record: R }
  /** Já não estava 'running' (terminou antes da checagem). */
  | { state: 'settled'; record: R }
  /** Sem Web Locks: não dá para saber se roda em outra aba — nada é marcado. */
  | { state: 'unsupported'; record: R }
  | { state: 'missing' };

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Marca a run como órfã (muta e devolve o record). Etapa em voo — com spec, sem
 * julgamento, sem erro — fica `incomplete`: FORA do placar e das médias, mesma
 * regra do fechamento por controle do orquestrador. Nenhuma nota é inventada.
 * `incompleteReason` fica ausente: o motivo é o da run (CONVENTIONS §4 fixa
 * 'budget' | 'cancelled' | 'truncation').
 */
export function markRunOrphaned(record: RunRecord, now: string = nowIso()): RunRecord {
  record.status = 'aborted';
  record.stoppedReason = 'orphan';
  for (const st of record.stages ?? []) {
    if (st && st.spec && !st.error && !st.judge && !st.incomplete) {
      st.incomplete = true;
      st.finishedAt ??= now;
    }
  }
  record.finishedAt ??= now;
  return record;
}

/** Marca a sessão de treino como órfã (muta e devolve o record). */
export function markSessionOrphaned(record: SessionRecord, now: string = nowIso()): SessionRecord {
  record.status = 'aborted';
  record.stoppedReason = 'orphan';
  record.finishedAt ??= now;
  return record;
}

interface Subject<R extends { id: string; status: string }> {
  subject: LockSubject;
  load(id: string): Promise<R | null>;
  save(record: R): Promise<boolean>;
  live(id: string): R | undefined;
  mark(record: R): R;
}

const RUN: Subject<RunRecord> = {
  subject: 'run',
  load: loadRun,
  save: (r) => saveRun(r),
  live: getRunRecord,
  mark: (r) => markRunOrphaned(r),
};

const SESSION: Subject<SessionRecord> = {
  subject: 'session',
  load: loadSession,
  save: (r) => saveSession(r),
  live: getSessionRecord,
  mark: (r) => markSessionOrphaned(r),
};

/** Releitura SEGURANDO o lock livre: aqui a resposta não tem corrida. */
async function decideWithLock<R extends { id: string; status: string }>(
  s: Subject<R>,
  id: string,
): Promise<OrphanCheck<R>> {
  const live = s.live(id);
  // Defensivo: viva na memória desta aba => nunca é órfã (a dona é esta aba).
  if (live?.status === 'running') return { state: 'alive', record: live };
  if (live) {
    // Esta aba executou e terminou, mas o disco ainda diz 'running' (a
    // gravação final falhou): o record da memória é a verdade — regrava.
    const rec = await s.load(id);
    if (rec?.status === 'running') await s.save(live);
    return { state: 'settled', record: live };
  }
  const rec = await s.load(id);
  if (!rec) return { state: 'missing' };
  if (rec.status !== 'running') return { state: 'settled', record: rec };
  s.mark(rec);
  await s.save(rec);
  return { state: 'orphaned', record: rec };
}

// Checagens concorrentes do MESMO id nesta aba (fetchRun + openRunStream + a
// varredura do boot) compartilham a mesma promise: sem isto a segunda veria o
// lock "ocupado" pela primeira e diria 'alive' por engano.
const inFlight = new Map<string, Promise<OrphanCheck<unknown>>>();

function track<R>(key: string, p: Promise<OrphanCheck<R>>): Promise<OrphanCheck<R>> {
  inFlight.set(key, p as Promise<OrphanCheck<unknown>>);
  const limpar = (): void => {
    if (inFlight.get(key) === p) inFlight.delete(key);
  };
  p.then(limpar, limpar);
  return p;
}

function dedupe<R>(key: string, run: () => Promise<OrphanCheck<R>>): Promise<OrphanCheck<R>> {
  const cur = inFlight.get(key) as Promise<OrphanCheck<R>> | undefined;
  return cur ?? track(key, run());
}

async function reconcile<R extends { id: string; status: string }>(
  s: Subject<R>,
  id: string,
): Promise<OrphanCheck<R>> {
  return dedupe(`${s.subject}:${id}`, async () => {
    const probe = await withLockIfFree(s.subject, id, () => decideWithLock(s, id));
    if (probe.state === 'free') return probe.value;
    const rec = s.live(id) ?? (await s.load(id));
    if (!rec) return { state: 'missing' };
    if (rec.status !== 'running') return { state: 'settled', record: rec };
    return { state: probe.state === 'held' ? 'alive' : 'unsupported', record: rec };
  });
}

/** Checa UMA run 'running': órfã vira aborted(orphan) e é gravada. */
export function reconcileRun(id: string): Promise<OrphanCheck<RunRecord>> {
  return reconcile(RUN, id);
}

/** Checa UMA sessão de treino 'running': órfã vira aborted(orphan) e é gravada. */
export function reconcileSession(id: string): Promise<OrphanCheck<SessionRecord>> {
  return reconcile(SESSION, id);
}

export interface SweepResult {
  supported: boolean;
  /** Ids marcados como órfãos agora. */
  orphanedRuns: string[];
  orphanedSessions: string[];
  /** Ids 'running' com dono vivo (outra aba ou esta). */
  aliveRuns: string[];
  aliveSessions: string[];
}

/**
 * Varre o histórico: toda run/sessão 'running' sem dono vira órfã. Roda na
 * carga da página (sem intervenção) e antes de listar o histórico. Sem Web
 * Locks não marca nada (`supported: false`).
 */
export async function sweepOrphans(): Promise<SweepResult> {
  const out: SweepResult = {
    supported: locksSupported(),
    orphanedRuns: [],
    orphanedSessions: [],
    aliveRuns: [],
    aliveSessions: [],
  };
  if (!out.supported) return out;
  const [runs, sessions] = await Promise.all([
    listRuns<{ id: string; status: string }>().catch(() => []),
    listSessions<{ id: string; status: string }>().catch(() => []),
  ]);
  await Promise.all([
    ...runs
      .filter((r) => r.status === 'running')
      .map(async (r) => {
        const c = await reconcileRun(r.id);
        if (c.state === 'orphaned') out.orphanedRuns.push(r.id);
        else if (c.state === 'alive') out.aliveRuns.push(r.id);
      }),
    ...sessions
      .filter((s) => s.status === 'running')
      .map(async (s) => {
        const c = await reconcileSession(s.id);
        if (c.state === 'orphaned') out.orphanedSessions.push(s.id);
        else if (c.state === 'alive') out.aliveSessions.push(s.id);
      }),
  ]);
  return out;
}

/**
 * Espera o dono de uma run/sessão 'running' soltar o lock (terminou ou a aba
 * morreu) e devolve o record final — órfã marcada, se for o caso. É o que faz
 * a tela aberta em OUTRA aba se atualizar sozinha, sem polling nem heartbeat.
 * Devolve null se a espera foi cancelada (`signal`) ou não há Web Locks.
 */
async function watch<R extends { id: string; status: string }>(
  s: Subject<R>,
  id: string,
  signal?: AbortSignal,
): Promise<OrphanCheck<R> | null> {
  if (isHeldHere(s.subject, id)) return null; // esta aba é a dona: os eventos vêm do motor
  // Com o lock nas mãos a decisão é direta (sem reaproveitar uma checagem em
  // voo, que pode ter visto o dono anterior); checagens NOVAS pegam carona.
  const r = await whenLockReleased(
    s.subject,
    id,
    () => track(`${s.subject}:${id}`, decideWithLock(s, id)),
    signal,
  );
  return r.state === 'released' ? r.value : null;
}

export function watchRun(id: string, signal?: AbortSignal): Promise<OrphanCheck<RunRecord> | null> {
  return watch(RUN, id, signal);
}

export function watchSession(id: string, signal?: AbortSignal): Promise<OrphanCheck<SessionRecord> | null> {
  return watch(SESSION, id, signal);
}

/**
 * Marcação MANUAL (só faz sentido sem Web Locks, quando a detecção automática
 * não existe): o usuário afirma que a aba que executava já foi fechada. Com Web
 * Locks, só marca se o lock estiver livre — nunca derruba uma run viva.
 */
async function markManually<R extends { id: string; status: string }>(
  s: Subject<R>,
  id: string,
): Promise<OrphanCheck<R>> {
  if (locksSupported()) return reconcile(s, id);
  if (isHeldHere(s.subject, id)) {
    const rec = s.live(id);
    return rec ? { state: 'alive', record: rec } : { state: 'missing' };
  }
  const rec = await s.load(id);
  if (!rec) return { state: 'missing' };
  if (rec.status !== 'running') return { state: 'settled', record: rec };
  s.mark(rec);
  await s.save(rec);
  return { state: 'orphaned', record: rec };
}

export function markRunInterrupted(id: string): Promise<OrphanCheck<RunRecord>> {
  return markManually(RUN, id);
}

export function markSessionInterrupted(id: string): Promise<OrphanCheck<SessionRecord>> {
  return markManually(SESSION, id);
}
