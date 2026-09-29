// Modo JEV na SPA — o MOTOR RODA NA ABA (D-13): o endpoint de decisões
// da OpenRouter tem CORS aberto (preflight 204 com `Authorization`,
// `HTTP-Referer` e `X-Title` permitidos), então não há proxy — ao contrário do
// jev-simulator, cujo proxy same-origin existia à toa. Tudo passa pelo MESMO
// gateway do Node (shim `../engine/openrouter`): limitador AIMD, reserva,
// `usage.cost` e a contabilidade num ponto só.
//
// O que este arquivo acrescenta ao motor (fonte única em `src/engine/jev/`):
//  • os SEAMS do navegador: key (`requireKey`), pré-voo LGPD/PII
//    (`web/src/lgpd.ts`), persistência IndexedDB (`./store`), barramento em
//    memória para a tela ao vivo;
//  • exclusão entre abas por Web Locks (mesma regra de `engine/runLocks.ts`):
//    a aba que executa segura o lock `prompt-builder:run|session:jev:<id>`; um
//    record `running` com o lock LIVRE é órfão (a aba fechou/recarregou) e
//    vira `aborted` com o parcial preservado — a mesma semântica do Node
//    (`src/jev/store.ts`: dono morto → `aborted`/`cancelled` + erro "órfã");
//  • o portão de custo (acima de US$ 1 na faixa alta, iniciar exige "sim").

import '../engine/openrouter';
import {
  estimateJev,
  estimateJevTrain,
  jevComplianceView,
  lintResolved,
  parseJevConfig,
  resolveJevConfig,
  runJev,
  trainJev,
  JevConfigError,
  type JevConfigFile,
  type JevEstimate,
  type JevEvent,
  type JevLintIssue,
  type JevRunRecord,
  type JevSessionRecord,
  type ResolvedJevConfig,
} from '../engine/jev';
import { getGateway, listModels } from '../engine/openrouter';
import type { OpenRouterModel } from '../../../src/types.js';
import { acquireLock, isHeldHere, locksSupported, withLockIfFree, type LockSubject } from '../engine/runLocks';
import { enforceRunCompliance } from '../lgpd';
import { requestPersistentStorage } from '../storageHealth';
import { COST_CONFIRM_THRESHOLD_USD, requireKey } from '../api';
import { listJevSummaries, loadJevRun, loadJevSession, saveJevRun, saveJevSession, type JevSummary } from './store';
import { parseJevRecordFile } from './transfer';

export type JevRecordKind = 'run' | 'session';
export type JevAnyRecord = JevRunRecord | JevSessionRecord;

/** Id do lock: prefixo próprio (as runs LLM usam o id cru). */
export function jevLockId(id: string): string {
  return `jev:${id}`;
}

// ---------------------------------------------------------------------------
// Estado vivo desta aba + barramento
// ---------------------------------------------------------------------------

const live = new Map<string, JevAnyRecord>();
const listeners = new Map<string, Set<(rec: JevAnyRecord) => void>>();
const eventListeners = new Set<(e: JevEvent) => void>();
const controllers = new Map<string, AbortController>();

function publish(rec: JevAnyRecord): void {
  live.set(rec.id, rec);
  for (const cb of listeners.get(rec.id) ?? []) cb(rec);
}

/** O record vivo (executando/executado nesta aba), se houver. */
export function liveJevRecord(id: string): JevAnyRecord | undefined {
  return live.get(id);
}

/** Assina as gravações de um record (nesta aba). Devolve o cancelamento. */
export function subscribeJevRecord(id: string, cb: (rec: JevAnyRecord) => void): () => void {
  let set = listeners.get(id);
  if (!set) listeners.set(id, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) listeners.delete(id);
  };
}

/** Assina os eventos do motor (enxutos: nunca estado nem rubrica). */
export function subscribeJevEvents(cb: (e: JevEvent) => void): () => void {
  eventListeners.add(cb);
  return () => void eventListeners.delete(cb);
}

function emit(e: JevEvent): void {
  for (const cb of eventListeners) {
    try {
      cb(e);
    } catch (err) {
      console.warn('[jev] ouvinte de evento falhou:', err);
    }
  }
}

/** true = o record roda NESTA aba e ainda pode ser cancelado. */
export function canCancelJev(id: string): boolean {
  return controllers.has(id);
}

/** Cancela NESTA aba: nenhuma chamada nova sai; o parcial fica, `aborted`/`cancelled`. */
export function cancelJev(id: string): boolean {
  const c = controllers.get(id);
  if (!c) return false;
  c.abort();
  return true;
}

// ---------------------------------------------------------------------------
// Catálogos
// ---------------------------------------------------------------------------

/** Catálogo de modelos de DECISÃO (`/models?output_modalities=decisions`, público). */
export async function fetchDecisionModels(apiKey = ''): Promise<OpenRouterModel[]> {
  return getGateway().listDecisionModels(apiKey);
}

/** Catálogo de chat (LLMs como competidores / proponente). */
export async function fetchChatModels(apiKey = ''): Promise<OpenRouterModel[]> {
  return listModels(apiKey);
}

// ---------------------------------------------------------------------------
// Preparo (parse → resolve → lint → estimativa): o MESMO caminho da UI e do Iniciar
// ---------------------------------------------------------------------------

export interface JevPrepared {
  resolved: ResolvedJevConfig;
  issues: JevLintIssue[];
  estimate: JevEstimate;
}

export type JevPrepareResult = { ok: true; value: JevPrepared } | { ok: false; issues: JevLintIssue[] };

/**
 * Config de formulário → config resolvido + lint + estimativa, SEM rede e sem
 * gasto (a tela chama a cada edição, com o catálogo que já tem). Erros de lint
 * vêm junto — `ok: true` com erro em `issues` significa "resolve, mas não roda".
 */
export function prepareJev(
  cfg: unknown,
  catalogs: { decision?: readonly OpenRouterModel[]; chat?: readonly OpenRouterModel[] } = {},
): JevPrepareResult {
  const p = parseJevConfig(cfg);
  if (!p.ok) {
    return {
      ok: false,
      issues: p.issues.map((i) => ({ level: 'error', code: 'config.schema', message: i.path ? `${i.path}: ${i.message}` : i.message, ...(i.path ? { path: i.path } : {}) })),
    };
  }
  const r = resolveJevConfig(p.config);
  if (!r.ok) return { ok: false, issues: r.issues };
  const lint = lintResolved(r.resolved, { decisionCatalog: catalogs.decision ?? [] });
  const est =
    r.resolved.mode === 'train'
      ? estimateJevTrain(r.resolved, { chatCatalog: catalogs.chat ?? [], decisionCatalog: catalogs.decision ?? [] })
      : estimateJev(r.resolved, { chatCatalog: catalogs.chat ?? [], decisionCatalog: catalogs.decision ?? [] });
  return { ok: true, value: { resolved: r.resolved, issues: [...r.issues, ...lint], estimate: est } };
}

/** Recusa de iniciar: a faixa alta passa do limiar e o usuário ainda não disse "sim". */
export class JevCostConfirmationRequired extends Error {
  readonly code = 'jev-cost-confirmation-required' as const;
  constructor(readonly estimate: JevEstimate) {
    super(`Custo estimado de até US$ ${estimate.usdHigh.toFixed(2)}: confirme antes de iniciar.`);
    this.name = 'JevCostConfirmationRequired';
  }
}

/** Reconhece por PROPRIEDADE (instância dupla do módulo daria `instanceof` falso). */
export function isJevCostConfirmationRequired(err: unknown): err is JevCostConfirmationRequired {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'jev-cost-confirmation-required';
}

/** Exige "sim" explícito acima do limiar (mesmo limiar das runs LLM). */
export function jevRequiresConfirmation(est: JevEstimate): boolean {
  return est.usdHigh > COST_CONFIRM_THRESHOLD_USD;
}

export interface StartJevOpts {
  /** O usuário VIU a faixa e confirmou (acima de US$ 1). */
  costConfirmed?: boolean;
}

function erroDeConfig(issues: JevLintIssue[]): JevConfigError {
  const erros = issues.filter((i) => i.level === 'error');
  return new JevConfigError(
    `definição/casos inválidos: ${erros.slice(0, 4).map((i) => `${i.code} — ${i.message}`).join('; ')}`,
    issues,
  );
}

/**
 * Inicia uma run (eval/compare) ou uma sessão de treino NA ABA. Recusa ANTES
 * de gastar: sem key, config inválido, lint com erro, custo sem confirmação,
 * recusa LGPD/PII. Resolve com o id assim que o record existe (a tela abre ao
 * vivo); a execução segue em segundo plano segurando o Web Lock.
 */
export async function startJev(cfg: JevConfigFile, opts: StartJevOpts = {}): Promise<{ id: string; kind: JevRecordKind }> {
  // persist() na ativação do clique (antes de qualquer await): mesma regra das runs LLM.
  void requestPersistentStorage();
  const apiKey = requireKey();
  const decision = await fetchDecisionModels(apiKey).catch(() => [] as OpenRouterModel[]);
  const precisaChat = (cfg.models.llm?.length ?? 0) > 0 || Boolean(cfg.train?.rewriterModelId);
  const chat = precisaChat ? await fetchChatModels(apiKey).catch(() => [] as OpenRouterModel[]) : [];
  const prep = prepareJev(cfg, { decision, chat });
  if (!prep.ok) throw erroDeConfig(prep.issues);
  const { resolved, issues, estimate } = prep.value;
  if (issues.some((i) => i.level === 'error')) throw erroDeConfig(issues);
  if (jevRequiresConfirmation(estimate) && !opts.costConfirmed) throw new JevCostConfirmationRequired(estimate);

  // Pré-voo LGPD/PII UMA vez, antes do lock e de qualquer chamada paga. Em
  // área sensível o Jev (sem ZDR) é recusado aqui — fail-closed.
  const pre = await enforceRunCompliance(jevComplianceView(resolved));
  const compliance = {
    ...(pre.sensitiveRouting ? { sensitiveRouting: pre.sensitiveRouting } : {}),
    ...(pre.piiReport ? { piiReport: pre.piiReport } : {}),
  };

  const kind: JevRecordKind = resolved.mode === 'train' ? 'session' : 'run';
  const id = globalThis.crypto.randomUUID();
  const lock = await acquireLock(kind, jevLockId(id));
  if (!lock) throw new Error('outra aba já executa este id (não deveria acontecer com um id novo).');
  const ctrl = new AbortController();
  controllers.set(id, ctrl);

  let criado = false;
  const aviso: { resolve: () => void } = { resolve: () => undefined };
  const pronto = new Promise<void>((resolve) => {
    aviso.resolve = resolve;
  });
  const marcarCriado = (): void => {
    if (criado) return;
    criado = true;
    aviso.resolve();
  };
  const nCasos = resolved.cases.length;
  const saveRun = async (r: JevRunRecord): Promise<void> => {
    publish(r);
    if (r.id === id) marcarCriado();
    await saveJevRun(r);
  };
  const saveSession = async (s: JevSessionRecord): Promise<void> => {
    publish(s);
    marcarCriado();
    await saveJevSession(s, nCasos);
  };
  const log = (m: string): void => console.warn(`[jev] ${m}`);

  const execucao: Promise<unknown> =
    kind === 'session'
      ? trainJev(resolved, { apiKey, sessionId: id, signal: ctrl.signal, client: 'browser', compliance: () => compliance, emit, saveRun, saveSession, log })
      : runJev(resolved, { apiKey, runId: id, signal: ctrl.signal, client: 'browser', compliance: () => compliance, emit, save: saveRun, log });

  const falhaAntes = execucao.then(
    () => null,
    (err: unknown) => err,
  );
  void falhaAntes.finally(() => {
    controllers.delete(id);
    lock.release();
  });
  const primeiro = await Promise.race([pronto.then(() => ({ criado: true as const })), falhaAntes.then((err) => ({ criado: false as const, err }))]);
  if (!primeiro.criado && !criado) {
    // Falhou ANTES do record existir (lint de contexto por modelo, catálogo…): nada foi gasto.
    throw primeiro.err ?? new Error('a execução terminou sem gravar o record');
  }
  void falhaAntes.then((err) => {
    if (err) console.warn(`[jev] ${kind} ${id} terminou com erro:`, err);
  });
  return { id, kind };
}

// ---------------------------------------------------------------------------
// Leitura (memória desta aba > IndexedDB) e órfãs
// ---------------------------------------------------------------------------

export async function getJevRun(id: string): Promise<JevRunRecord | null> {
  const l = live.get(id);
  if (l && l.format === 'jev-run@1') return l;
  return loadJevRun(id);
}

export async function getJevSession(id: string): Promise<JevSessionRecord | null> {
  const l = live.get(id);
  if (l && l.format === 'jev-session@1') return l;
  return loadJevSession(id);
}

/** As runs de uma sessão (relatório de ciclos), na ordem dos ciclos. */
export async function getJevSessionRuns(s: JevSessionRecord): Promise<JevRunRecord[]> {
  const out: JevRunRecord[] = [];
  for (const rid of s.runIds) {
    const r = await getJevRun(rid);
    if (r) out.push(r);
  }
  return out;
}

export function listJevHistory(): Promise<JevSummary[]> {
  return listJevSummaries();
}

// ---------------------------------------------------------------------------
// Importar do terminal (a UI serve os dois caminhos — ver `./transfer.ts`)
// ---------------------------------------------------------------------------

export interface JevImportResult {
  name: string;
  ok: boolean;
  kind?: JevRecordKind;
  id?: string;
  theme?: string;
  error?: string;
}

/**
 * Grava no IndexedDB desta aba os records vindos do terminal (arquivos de
 * `~/.prompt-builder/jev-runs|jev-sessions/` ou `jev show --full --json`). Runs
 * antes das sessões, para o relatório de ciclos já achar as runs de ciclo.
 * Nunca sobrescreve o que roda NESTA aba. Nada vai para a rede.
 */
export async function importJevRecordFiles(files: readonly { name: string; text: string }[]): Promise<JevImportResult[]> {
  const lidos = files.map((f) => ({ name: f.name, r: parseJevRecordFile(f.text) }));
  const casosDaSessao = new Map<string, Set<string>>();
  for (const { r } of lidos) {
    if (r.ok && r.kind === 'run' && r.record.sessionId) {
      const set = casosDaSessao.get(r.record.sessionId) ?? new Set<string>();
      for (const c of r.record.cases) set.add(c.id);
      casosDaSessao.set(r.record.sessionId, set);
    }
  }
  const ordem = [...lidos.filter((l) => l.r.ok && l.r.kind === 'run'), ...lidos.filter((l) => !(l.r.ok && l.r.kind === 'run'))];
  const porNome = new Map<(typeof lidos)[number], JevImportResult>();
  for (const l of ordem) {
    const { name, r } = l;
    if (!r.ok) {
      porNome.set(l, { name, ok: false, error: r.error });
      continue;
    }
    const id = r.record.id;
    if (controllers.has(id)) {
      porNome.set(l, { name, ok: false, kind: r.kind, id, error: 'este id está executando nesta aba.' });
      continue;
    }
    const gravou = r.kind === 'run' ? await saveJevRun(r.record) : await saveJevSession(r.record, casosDaSessao.get(id)?.size ?? 0);
    // A cópia viva (se houver) ficaria na frente do IndexedDB nas leituras.
    live.delete(id);
    porNome.set(
      l,
      gravou
        ? { name, ok: true, kind: r.kind, id, theme: r.record.theme }
        : { name, ok: false, kind: r.kind, id, error: 'o navegador não conseguiu gravar (armazenamento cheio ou bloqueado).' },
    );
  }
  return lidos.map((l) => porNome.get(l)!);
}

export const ORPHAN_MESSAGE = 'a aba que executava fechou, recarregou ou travou com o trabalho em andamento (órfã): parcial preservado.';

/** Marca órfão (muta e devolve). Mesma semântica do Node: `aborted` + `cancelled` + erro explicativo. */
export function markJevOrphaned<R extends JevAnyRecord>(rec: R, now = new Date().toISOString()): R {
  rec.status = 'aborted';
  rec.stoppedReason = 'cancelled';
  rec.error = rec.error ?? ORPHAN_MESSAGE;
  rec.finishedAt = rec.finishedAt ?? now;
  return rec;
}

export type JevOrphanState = 'orphaned' | 'alive' | 'settled' | 'unsupported' | 'missing';

/** Quem segura o lock de um record: a própria run, ou a SESSÃO dona (ciclos de treino). */
function lockOf(kind: JevRecordKind, rec: JevAnyRecord): { subject: LockSubject; id: string } {
  if (kind === 'run' && (rec as JevRunRecord).sessionId) return { subject: 'session', id: (rec as JevRunRecord).sessionId! };
  return { subject: kind, id: rec.id };
}

async function carregar(kind: JevRecordKind, id: string): Promise<JevAnyRecord | null> {
  return kind === 'session' ? loadJevSession(id) : loadJevRun(id);
}

async function gravar(kind: JevRecordKind, rec: JevAnyRecord): Promise<void> {
  if (kind === 'session') await saveJevSession(rec as JevSessionRecord);
  else await saveJevRun(rec as JevRunRecord);
}

/** Runs de ciclo ainda `running` de uma sessão órfã também viram órfãs. */
async function orfanarFilhas(s: JevSessionRecord): Promise<void> {
  for (const rid of s.runIds) {
    const r = await loadJevRun(rid);
    if (r && r.status === 'running') await saveJevRun(markJevOrphaned(r));
  }
  const soltas = (await listJevSummaries()).filter((x) => x.kind === 'run' && x.sessionId === s.id && x.status === 'running');
  for (const x of soltas) {
    const r = await loadJevRun(x.id);
    if (r && r.status === 'running') await saveJevRun(markJevOrphaned(r));
  }
}

/**
 * Checa UM record `running`: com o lock do dono LIVRE (ninguém executa), relê
 * DENTRO do lock e marca órfão. Nenhum timestamp entra na decisão (aba
 * congelada mantém o lock). Sem Web Locks: `unsupported` (a UI oferece a
 * marcação manual).
 */
export async function reconcileJev(kind: JevRecordKind, id: string): Promise<JevOrphanState> {
  if (controllers.has(id)) return 'alive';
  const rec = live.get(id) ?? (await carregar(kind, id));
  if (!rec) return 'missing';
  if (rec.status !== 'running') return 'settled';
  const dono = lockOf(kind, rec);
  if (isHeldHere(dono.subject, jevLockId(dono.id))) return 'alive';
  const probe = await withLockIfFree(dono.subject, jevLockId(dono.id), async (): Promise<JevOrphanState> => {
    const atual = await carregar(kind, id);
    if (!atual) return 'missing';
    if (atual.status !== 'running') return 'settled';
    markJevOrphaned(atual);
    await gravar(kind, atual);
    if (kind === 'session') await orfanarFilhas(atual as JevSessionRecord);
    live.delete(id);
    return 'orphaned';
  });
  if (probe.state === 'free') return probe.value;
  return probe.state === 'held' ? 'alive' : 'unsupported';
}

/**
 * Marcação MANUAL (sem Web Locks não há detecção automática): o usuário
 * afirma que a aba que executava já fechou. Com Web Locks, só marca se o lock
 * estiver livre — nunca derruba um trabalho vivo.
 */
export async function markJevInterrupted(kind: JevRecordKind, id: string): Promise<JevOrphanState> {
  if (locksSupported()) return reconcileJev(kind, id);
  if (controllers.has(id)) return 'alive';
  const rec = await carregar(kind, id);
  if (!rec) return 'missing';
  if (rec.status !== 'running') return 'settled';
  markJevOrphaned(rec);
  await gravar(kind, rec);
  if (kind === 'session') await orfanarFilhas(rec as JevSessionRecord);
  return 'orphaned';
}

let watchStarted = false;

/**
 * Chamado UMA vez na carga da página (main.tsx, ao lado de `startOrphanWatch`):
 * varre o histórico JEV e marca como órfão todo `running` sem dono. Sem Web
 * Locks não marca nada.
 */
export function startJevOrphanWatch(): Promise<{ orphaned: string[]; alive: string[] }> {
  const out = { orphaned: [] as string[], alive: [] as string[] };
  if (watchStarted || !locksSupported()) return Promise.resolve(out);
  watchStarted = true;
  return sweepJevOrphans();
}

/** A varredura em si (exportada para os testes e para a lista do histórico). */
export async function sweepJevOrphans(): Promise<{ orphaned: string[]; alive: string[] }> {
  const out = { orphaned: [] as string[], alive: [] as string[] };
  if (!locksSupported()) return out;
  const rows = await listJevSummaries().catch(() => [] as JevSummary[]);
  // Sessões primeiro: marcá-las já leva as runs de ciclo junto.
  const ordenadas = [...rows.filter((r) => r.kind === 'session'), ...rows.filter((r) => r.kind === 'run')];
  for (const r of ordenadas) {
    if (r.status !== 'running') continue;
    try {
      const st = await reconcileJev(r.kind, r.id);
      if (st === 'orphaned') out.orphaned.push(r.id);
      else if (st === 'alive') out.alive.push(r.id);
    } catch (err) {
      console.warn(`[jev] checagem de órfã de ${r.id} falhou:`, err);
    }
  }
  return out;
}

/** Só para testes: esquece o estado vivo desta "aba". */
export function _resetJevLiveForTests(): void {
  live.clear();
  listeners.clear();
  eventListeners.clear();
  controllers.clear();
  watchStarted = false;
}
