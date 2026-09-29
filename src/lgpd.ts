import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { PKG_DATA_DIR } from './paths.js';
import { assertValidRecordId, resolveInside } from './pathSafety.js';
import { getDataDir } from './storage.js';
import {
  assertRunCompliance,
  type ComplianceConfigLike,
  type LgpdAllowlistSnapshot,
  type LgpdData,
  type RunComplianceCheck,
} from './engine/lgpdCore.js';
import {
  assertRunPii,
  checkRunPii,
  summarizeRunPii,
  type PiiConfigLike,
  type PiiRunReport,
} from './engine/pii.js';
import { sensitiveRoutingFor, type SensitiveRouting } from './engine/sensitiveRouting.js';

/**
 * Conformidade LGPD — lado NODE (CLI + servidor). A classificação inteira é a
 * de `src/engine/lgpdCore.ts` (fonte única, também usada pelo web e pelo
 * gerador da allowlist — IMPL-041); aqui só mora o CARREGAMENTO dos dados do
 * pacote e o pré-voo da run.
 *
 * Área sensível é FAIL-CLOSED: exige o snapshot de endpoints ZDR
 * (`lgpd-allowlist.generated.json`) fresco; ausente/vencido ⇒ bloqueado.
 * A área "geral" segue consultiva. NÃO é aconselhamento jurídico.
 */

export * from './engine/lgpdCore.js';
// Cascata de dado pessoal PT-BR (IMPL-042): mesma porta de entrada da LGPD.
export * from './engine/pii.js';
// Enforcement do modo sensível no gateway (IMPL-040).
export * from './engine/sensitiveRouting.js';

// Resolvido pela raiz do PACOTE, nao pelo cwd: instalado via npm o cwd e o
// projeto do usuario e a leitura falharia com ENOENT. Ver src/paths.ts.
const JSON_PATH = path.join(PKG_DATA_DIR, 'lgpd-compliance.json');
const ALLOWLIST_PATH = path.join(PKG_DATA_DIR, 'lgpd-allowlist.generated.json');
const RETENTION_PATH = path.join(PKG_DATA_DIR, 'lgpd-retention.json');

let cache: LgpdData | null = null;
let override: LgpdData | null = null;

/** Snapshot versionado da allowlist, ou `null` se faltar/estiver ilegível (⇒ fail-closed). */
export function loadAllowlistSnapshot(file = ALLOWLIST_PATH): LgpdAllowlistSnapshot | null {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as LgpdAllowlistSnapshot;
  } catch {
    return null;
  }
}

/** Base de conhecimento + a allowlist anexada (a mesma forma que o web monta). */
export function getLgpdData(): LgpdData {
  if (override) return override;
  if (!cache) {
    const base = JSON.parse(readFileSync(JSON_PATH, 'utf-8')) as LgpdData;
    cache = { ...base, allowlist: loadAllowlistSnapshot() };
  }
  return cache;
}

/** Espelho assíncrono do `loadLgpdData` do web (mesma assinatura nos dois lados). */
export async function loadLgpdData(): Promise<LgpdData> {
  return getLgpdData();
}

/**
 * Troca os dados de runtime (testes injetam um snapshot sintético). Devolve a
 * função que restaura o anterior — mesmo padrão de `setDefaultGateway`.
 */
export function overrideLgpdData(data: LgpdData | null): () => void {
  const prev = override;
  override = data;
  return () => {
    override = prev;
  };
}

export interface EnforceRunOptions {
  /**
   * Run ANINHADA numa sessão de treino (iteração, triagem, holdout): o
   * pré-voo de dado pessoal já RECUSOU/liberou o config da sessão; aqui só se
   * relata (o record da iteração guarda o mesmo relatório).
   */
  nested?: boolean;
}

export interface RunPreflightResult extends RunComplianceCheck {
  /** Campos com dado pessoal (caminho + tipos, nunca o valor) — vai para `RunRecord.piiReport`. */
  piiReport?: PiiRunReport;
  /**
   * IMPL-040: política do modo sensível (só em área sensível). O chamador a
   * liga no ledger (`ledger.setSensitiveRouting`) e o gateway força
   * `provider { zdr, data_collection:'deny', only, allow_fallbacks:false }`.
   */
  sensitiveRouting?: SensitiveRouting;
}

/**
 * Pré-voo da run (chamado pelo orquestrador ANTES de qualquer LLM): no modo
 * sensível, recusa com `LgpdPolicyError` se algum papel estiver fora da
 * allowlist ou se o snapshot estiver vencido. Dado pessoal (IMPL-042): recusa
 * com `PiiPolicyError` nomeando o campo com dado de aparência real no modo
 * "só sintético", no modo AGENTE (o executor fala com o provedor fora da
 * cascata — fail-closed, sem exceção) e no modo "redigir" sem `allowPii`
 * (revisão explícita; nunca correção silenciosa).
 */
export async function enforceRunCompliance(
  cfg: ComplianceConfigLike & PiiConfigLike,
  now: Date | number = Date.now(),
  opts: EnforceRunOptions = {},
): Promise<RunPreflightResult> {
  const check: RunComplianceCheck = cfg.compliance
    ? assertRunCompliance(cfg, getLgpdData(), now)
    : { sensivel: false, violations: [] };
  const pii = opts.nested ? checkRunPii(cfg) : assertRunPii(cfg);
  const piiReport = summarizeRunPii(pii);
  const sensitiveRouting = check.sensivel ? sensitiveRoutingFor(cfg, getLgpdData(), now) : undefined;
  return {
    ...check,
    ...(piiReport ? { piiReport } : {}),
    ...(sensitiveRouting ? { sensitiveRouting } : {}),
  };
}

// ---------------------------------------------------------------------------
// Retenção/apagamento (IMPL-100, R-16:REC-6) — lado NODE
// ---------------------------------------------------------------------------
// Antes não havia TTL nem apagamento: runs gravadas ficavam para sempre em
// `<data-dir>` e não havia comando para removê-las. Agora:
//
//  • TTL por default (90 dias, `src/data/lgpd-retention.json`; `PB_RETENTION_DAYS`
//    sobrescreve; 0 desliga) com prune de runs E sessões (`pruneExpiredRuns`/
//    `pruneExpiredSessions`) e a versão limitada a uma varredura por hora
//    (`autoPrune`) — 0 exceções: um item preso não derruba a varredura;
//  • apagamento TOTAL de uma run/sessão (`eraseRuns`/`eraseRunFiles`/
//    `eraseSessionFiles`): record, sobras `.tmp` da escrita atômica, dono,
//    journal de chamadas, job (registro, log, NDJSON, cancel, chave — inclusive
//    o job de `--detach`, cujo id não é o da run), registro de
//    `--idempotency-key`, relatório HTML da sessão e o diretório de
//    artefatos/cache do agente (`agent-runs/<id>/`, com o `repo-cache`).
//
// Quem chama (IMPL-100): `runs delete`/`runs prune`/`sessions delete` do CLI,
// o prune automático das listagens (`runs list`/`sessions list` e GET
// /v1/benchmark/runs|sessions) e o pré-voo de cada run real do CLI.
// Fica de fora DE PROPÓSITO: o ledger diário de gasto (`ledger/`, contabilidade
// do teto da máquina — o rótulo cita o id, mas apagá-lo desarmaria o teto) e a
// trilha de handoff (`handoffs.jsonl`, auditoria). A SPA tem o par em
// `web/src/lgpd.ts` (apagamento do IndexedDB inteiro + `navigator.storage.
// estimate` + instrução de "limpar dados do site"); a tela que o chama é da SPA.

/** TTL de retenção das runs gravadas. `retentionDays: 0` = sem TTL (só apagamento explícito). */
export interface RetentionPolicy {
  retentionDays: number;
}

export const DEFAULT_RETENTION_DAYS = 90;
export const RETENTION_DAYS_ENV = 'PB_RETENTION_DAYS';

/**
 * Política versionada (`src/data/lgpd-retention.json`) com o override por
 * ambiente. Entrada inválida cai no default NUNCA em "sem TTL": preferir
 * apagar cedo a reter dado pessoal por engano.
 */
export function loadRetentionPolicy(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  let days = DEFAULT_RETENTION_DAYS;
  try {
    const raw = JSON.parse(readFileSync(RETENTION_PATH, 'utf-8')) as { retentionDays?: unknown };
    if (typeof raw.retentionDays === 'number' && Number.isInteger(raw.retentionDays) && raw.retentionDays >= 0) {
      days = raw.retentionDays;
    }
  } catch {
    // base ausente/ilegível ⇒ default (fail-safe, nunca "guarda para sempre")
  }
  const override = env[RETENTION_DAYS_ENV];
  if (override !== undefined && /^\d+$/u.test(override.trim())) days = Number(override.trim());
  return { retentionDays: days };
}

const DAY_MS = 86_400_000;

/** Instante (ms) a partir do qual um registo já está vencido. `retentionDays: 0` ⇒ nunca. */
export function retentionCutoffMs(now: number, retentionDays: number): number | null {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) return null;
  return now - retentionDays * DAY_MS;
}

/** Espelho da semântica do web (`web/src/lgpd.ts`): `test/lgpd-retention.test.ts` casa os dois. */
export function isOlderThan(ref: Date | number | string, now: number, retentionDays: number): boolean {
  const cutoff = retentionCutoffMs(now, retentionDays);
  if (cutoff === null) return false;
  const t = ref instanceof Date ? ref.getTime() : typeof ref === 'number' ? ref : Date.parse(ref);
  if (!Number.isFinite(t)) return true; // data ilegível ⇒ vencido (não reter por engano)
  return t < cutoff;
}

/** Tipo de registro apagável (run avulsa ou sessão de treino). */
export type ErasableKind = 'run' | 'session';

/** Resíduos por run/sessão espalhados pelo data-dir (relativos à raiz). */
export interface RunEraseResult {
  id: string;
  /** Caminhos relativos ao data-dir que existiam e foram removidos. */
  removed: string[];
}

function dataSub(dataDir: string, ...seg: string[]): string {
  return resolveInside(dataDir, ...seg);
}

const DIR_DO_TIPO: Record<ErasableKind, 'runs' | 'sessions'> = { run: 'runs', session: 'sessions' };

async function lerJson(abs: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(abs, 'utf-8'));
  } catch {
    return undefined; // ausente/corrompido não é resíduo LÓGICO deste id
  }
}

/** O objeto JSON cita este id em algum dos `campos`? */
function citaId(json: unknown, id: string, campos: readonly string[]): boolean {
  if (!json || typeof json !== 'object') return false;
  const o = json as Record<string, unknown>;
  return campos.some((c) => o[c] === id);
}

/**
 * Tudo o que pertence a `id` no data-dir: record, dono, `.tmp` da escrita
 * atômica, journal de chamadas (run), relatório HTML (sessão), job(s) — o de
 * mesmo id E o de `--detach`, que tem id próprio e aponta a run/sessão —,
 * chaves de job, registro de `--idempotency-key` e `agent-runs/<id>/`.
 */
async function residueOf(
  dataDir: string,
  kind: ErasableKind,
  id: string,
): Promise<Array<{ abs: string; rel: string }>> {
  const alvos: Array<{ abs: string; rel: string }> = [];
  const vistos = new Set<string>();
  const add = (rel: string, abs: string): void => {
    if (vistos.has(rel)) return;
    vistos.add(rel);
    alvos.push({ rel, abs });
  };
  const dir = DIR_DO_TIPO[kind];

  add(path.posix.join(dir, `${id}.json`), dataSub(dataDir, dir, `${id}.json`));
  add(path.posix.join(dir, `${id}.owner`), dataSub(dataDir, dir, `${id}.owner`));
  if (kind === 'run') {
    // Journal de chamadas (IMPL-081): guarda as RESPOSTAS pagas para replay.
    add(path.posix.join('runs', `${id}.journal`), dataSub(dataDir, 'runs', `${id}.journal`));
    // Diretório inteiro: artefatos + `repo-cache` (o "cache" da run).
    add(path.posix.join('agent-runs', id), dataSub(dataDir, 'agent-runs', id));
  } else {
    // `sessions report --annotate` sem --html grava aqui (0700).
    add(path.posix.join('reports', `${id}.html`), dataSub(dataDir, 'reports', `${id}.html`));
  }

  // Jobs: o de mesmo id e os que APONTAM este id (o `--detach` tem jobId próprio).
  const jobIds = new Set<string>([id]);
  let nomesJobs: string[] = [];
  try {
    nomesJobs = await fs.readdir(dataSub(dataDir, 'jobs'));
  } catch {
    // sem jobs/ ⇒ nada a apagar
  }
  for (const nome of nomesJobs) {
    if (!nome.endsWith('.json')) continue;
    const jobId = nome.slice(0, -'.json'.length);
    try {
      assertValidRecordId(jobId, 'id de job');
    } catch {
      continue;
    }
    if (citaId(await lerJson(dataSub(dataDir, 'jobs', nome)), id, ['runId', 'sessionId'])) jobIds.add(jobId);
  }
  for (const jobId of jobIds) {
    for (const ext of ['json', 'cancel', 'ndjson', 'log']) {
      add(path.posix.join('jobs', `${jobId}.${ext}`), dataSub(dataDir, 'jobs', `${jobId}.${ext}`));
    }
  }

  // Sobras `.tmp` de escrita atômica interrompida no diretório do tipo e em jobs/.
  for (const sub of [dir, 'jobs']) {
    let nomes: string[] = [];
    try {
      nomes = await fs.readdir(dataSub(dataDir, sub));
    } catch {
      continue; // diretório inexistente ⇒ sem sobras
    }
    for (const nome of nomes) {
      if (!nome.endsWith('.tmp')) continue;
      if (![...jobIds].some((j) => nome.startsWith(`${j}.`))) continue;
      add(path.posix.join(sub, nome), dataSub(dataDir, sub, nome));
    }
  }

  // Chave de idempotência de job (`jobs/keys/<sha256>.json`) que aponte um dos jobs.
  try {
    const chaves = await fs.readdir(dataSub(dataDir, 'jobs', 'keys'));
    for (const nome of chaves) {
      if (!nome.endsWith('.json')) continue;
      const abs = dataSub(dataDir, 'jobs', 'keys', nome);
      const jobId = ((await lerJson(abs)) as { jobId?: unknown } | undefined)?.jobId;
      if (typeof jobId === 'string' && jobIds.has(jobId)) add(path.posix.join('jobs', 'keys', nome), abs);
    }
  } catch {
    // sem diretório de chaves ⇒ nada a apagar
  }

  // Registro de `--idempotency-key` do CLI (`idempotency/<h>.json`) que aponte o id.
  try {
    const regs = await fs.readdir(dataSub(dataDir, 'idempotency'));
    for (const nome of regs) {
      if (!nome.endsWith('.json')) continue;
      const abs = dataSub(dataDir, 'idempotency', nome);
      if (citaId(await lerJson(abs), id, ['runId', 'sessionId'])) add(path.posix.join('idempotency', nome), abs);
    }
  } catch {
    // sem registros ⇒ nada a apagar
  }

  return alvos;
}

/** Remove a linha do id no índice de resumos (`<dir>/_index.jsonl`, cache das listagens). */
async function dropFromIndex(dataDir: string, kind: ErasableKind, id: string): Promise<string | null> {
  const dir = DIR_DO_TIPO[kind];
  const idx = dataSub(dataDir, dir, '_index.jsonl');
  let texto: string;
  try {
    texto = await fs.readFile(idx, 'utf-8');
  } catch {
    return null; // sem índice: nada a limpar
  }
  const linhas = texto.split('\n').filter((linha) => {
    if (!linha.trim()) return false;
    try {
      return (JSON.parse(linha) as { summary?: { id?: string } })?.summary?.id !== id;
    } catch {
      return true; // linha alheia corrompida não é resíduo deste id
    }
  });
  const novo = linhas.length ? `${linhas.join('\n')}\n` : '';
  if (novo === texto) return null;
  const tmp = `${idx}.${Date.now().toString(36)}.tmp`;
  try {
    await fs.writeFile(tmp, novo, { mode: 0o600 });
    await fs.rename(tmp, idx); // reescrita atômica, igual à do storage
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
  return path.posix.join(dir, '_index.jsonl');
}

async function eraseFiles(dataDir: string, kind: ErasableKind, id: string): Promise<RunEraseResult> {
  assertValidRecordId(id, kind === 'run' ? 'id de run' : 'id de sessão');
  const removed: string[] = [];
  for (const { abs, rel } of await residueOf(dataDir, kind, id)) {
    try {
      await fs.lstat(abs); // idempotente: o que não existia não entra em `removed`
    } catch {
      continue;
    }
    try {
      await fs.rm(abs, { recursive: true, force: true });
      removed.push(rel);
    } catch {
      // 0 exceções: um arquivo preso não impede o resto do apagamento
    }
  }
  const idx = await dropFromIndex(dataDir, kind, id);
  if (idx) removed.push(idx);
  return { id, removed };
}

/**
 * Apaga UMA run com TODOS os resíduos (ver `residueOf`) e a linha do índice de
 * resumos. Idempotente: o que não existe não é erro. Valida o id ANTES de
 * resolver caminhos (nunca sai de `<data-dir>`).
 */
export async function eraseRunFiles(dataDir: string, runId: string): Promise<RunEraseResult> {
  return eraseFiles(dataDir, 'run', runId);
}

/** Como `eraseRunFiles`, para uma SESSÃO (as runs dela saem por `eraseRuns`). */
export async function eraseSessionFiles(dataDir: string, sessionId: string): Promise<RunEraseResult> {
  return eraseFiles(dataDir, 'session', sessionId);
}

/** `runs delete` de uma lista de ids (o comando do CLI chama isto). */
export async function eraseRuns(dataDir: string, runIds: readonly string[]): Promise<RunEraseResult[]> {
  const out: RunEraseResult[] = [];
  for (const id of runIds) out.push(await eraseRunFiles(dataDir, id));
  return out;
}

export interface PruneReport {
  /** Registros varridos. */
  scanned: number;
  /** Vencidos apagados (ids) — ou que SERIAM apagados, com `dryRun`. */
  deleted: string[];
  /** Dentro do TTL mantidos (ids). */
  kept: string[];
  /** Falhas por item — o prune NUNCA lança (critério: 0 exceções). */
  errors: Array<{ id: string; error: string }>;
  /** Só do `autoPrune`: o prune das SESSÕES, feito junto do das runs. */
  sessions?: PruneReport;
}

export interface PruneOptions {
  dataDir?: string;
  now?: number;
  /** Sobrepõe a política carregada (testes e `runs prune --older-than`). */
  retentionDays?: number;
  /** Só relata o que venceria — nada é apagado (`runs prune --dry-run`). */
  dryRun?: boolean;
}

const relatorioVazio = (): PruneReport => ({ scanned: 0, deleted: [], kept: [], errors: [] });

async function pruneExpired(kind: ErasableKind, opts: PruneOptions): Promise<PruneReport> {
  const report = relatorioVazio();
  try {
    // Raiz de persistência = `getDataDir()` (storage.ts), NUNCA process.cwd().
    const dataDir = opts.dataDir ?? getDataDir();
    const now = opts.now ?? Date.now();
    const retentionDays = opts.retentionDays ?? loadRetentionPolicy().retentionDays;
    const cutoff = retentionCutoffMs(now, retentionDays);
    if (cutoff === null) return report; // TTL desligado: nada vence

    const dir = dataSub(dataDir, DIR_DO_TIPO[kind]);
    let nomes: string[] = [];
    try {
      nomes = await fs.readdir(dir);
    } catch {
      return report; // data-dir ainda sem o diretório
    }
    for (const nome of nomes) {
      if (!nome.endsWith('.json')) continue;
      const id = nome.slice(0, -'.json'.length);
      try {
        assertValidRecordId(id, kind === 'run' ? 'id de run' : 'id de sessão');
      } catch {
        continue; // nome estranho no diretório não é registro nosso
      }
      report.scanned += 1;
      try {
        let ref: number | string = (await fs.stat(path.join(dir, nome))).mtimeMs;
        try {
          const rec = JSON.parse(await fs.readFile(path.join(dir, nome), 'utf-8')) as { startedAt?: string };
          if (rec.startedAt) ref = rec.startedAt;
        } catch {
          // record corrompido ⇒ idade pelo mtime (nunca trava o prune)
        }
        if (!isOlderThan(ref, now, retentionDays)) {
          report.kept.push(id);
          continue;
        }
        if (!opts.dryRun) await eraseFiles(dataDir, kind, id);
        report.deleted.push(id);
      } catch (err) {
        report.errors.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    report.errors.push({ id: '*', error: err instanceof Error ? err.message : String(err) });
  }
  return report;
}

/**
 * Prune do TTL: remove as runs cujo início (ou, sem data legível, a idade do
 * arquivo) passou de `retentionDays`. Nunca lança — cada item é isolado e as
 * falhas entram em `errors` (critério (2) de IMPL-100: "0 exceções").
 */
export async function pruneExpiredRuns(opts: PruneOptions = {}): Promise<PruneReport> {
  return pruneExpired('run', opts);
}

/**
 * O mesmo TTL para as SESSÕES de treino. Uma sessão começa antes das runs
 * dela: quando a sessão vence, as runs dela também já venceram — o prune das
 * duas mantém o conjunto coerente.
 */
export async function pruneExpiredSessions(opts: PruneOptions = {}): Promise<PruneReport> {
  return pruneExpired('session', opts);
}

let autoPruneAt = 0;

/**
 * Prune automático (runs + sessões): o chamador (listagens do CLI/servidor,
 * pré-voo de run do CLI) aguarda; no máximo uma varredura por `intervalMs` por
 * processo. Devolve o relatório das runs com o das sessões em `sessions` e
 * NUNCA rejeita.
 */
export async function autoPrune(opts: PruneOptions & { intervalMs?: number } = {}): Promise<PruneReport> {
  const now = opts.now ?? Date.now();
  const intervalMs = opts.intervalMs ?? 3_600_000;
  if (now - autoPruneAt < intervalMs) return relatorioVazio();
  autoPruneAt = now;
  const runs = await pruneExpiredRuns({ ...opts, now });
  const sessions = await pruneExpiredSessions({ ...opts, now });
  return { ...runs, sessions };
}

/** Só para testes: esquece a última varredura do `autoPrune`. */
export function resetAutoPruneThrottle(): void {
  autoPruneAt = 0;
}
