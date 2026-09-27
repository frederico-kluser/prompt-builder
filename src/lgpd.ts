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
//    sobrescreve) com prune automático (`autoPrune` — chamado no boot do
//    CLI/servidor e antes de cada run);
//  • `runs delete` (CLI) chama `eraseRuns` — apagamento TOTAL de uma run:
//    record, sobras `.tmp` da escrita atômica, dono, job (registro, log,
//    NDJSON, cancel, chave de idempotência) e o diretório de artefatos/cache
//    do agente (`agent-runs/<id>/`, que inclui o `repo-cache`). Zero resíduo.
//
// O que fica POR FORA por enquanto: sessões de treino (o critério fala em
// runs) e cifragem em repouso (keyring) — ambos pendentes.
//
// A SPA tem o par em `web/src/lgpd.ts` (apagamento do IndexedDB inteiro +
// `navigator.storage.estimate` + instrução de "limpar dados do site").

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

/** Resíduos por run espalhados pelo data-dir (relativos à raiz). */
export interface RunEraseResult {
  id: string;
  /** Caminhos relativos ao data-dir que existiam e foram removidos. */
  removed: string[];
}

function dataSub(dataDir: string, ...seg: string[]): string {
  return resolveInside(dataDir, ...seg);
}

/** Sobra da escrita atômica (`<alvo>.<uuid>.tmp`) de um alvo, e dono/job do id. */
async function residueOf(dataDir: string, runId: string): Promise<Array<{ abs: string; rel: string }>> {
  const alvos: Array<{ abs: string; rel: string }> = [];
  const add = (rel: string, abs: string): void => {
    alvos.push({ rel, abs });
  };

  add(path.posix.join('runs', `${runId}.json`), dataSub(dataDir, 'runs', `${runId}.json`));
  add(path.posix.join('runs', `${runId}.owner`), dataSub(dataDir, 'runs', `${runId}.owner`));
  add(path.posix.join('jobs', `${runId}.json`), dataSub(dataDir, 'jobs', `${runId}.json`));
  add(path.posix.join('jobs', `${runId}.cancel`), dataSub(dataDir, 'jobs', `${runId}.cancel`));
  add(path.posix.join('jobs', `${runId}.ndjson`), dataSub(dataDir, 'jobs', `${runId}.ndjson`));
  add(path.posix.join('jobs', `${runId}.log`), dataSub(dataDir, 'jobs', `${runId}.log`));
  // Diretório inteiro: artefatos + `repo-cache` (o "cache" da run).
  add(path.posix.join('agent-runs', runId), dataSub(dataDir, 'agent-runs', runId));

  // Sobras `.tmp` de escrita atômica interrompida em runs/ e jobs/.
  for (const dir of ['runs', 'jobs']) {
    let nomes: string[] = [];
    try {
      nomes = await fs.readdir(dataSub(dataDir, dir));
    } catch {
      continue; // diretório inexistente ⇒ sem sobras
    }
    for (const nome of nomes) {
      if (!nome.startsWith(`${runId}.`) || !nome.endsWith('.tmp')) continue;
      add(path.posix.join(dir, nome), dataSub(dataDir, dir, nome));
    }
  }

  // Chave de idempotência (`jobs/keys/<sha256>.json`) que aponte para esta run.
  try {
    const chaves = await fs.readdir(dataSub(dataDir, 'jobs', 'keys'));
    for (const nome of chaves) {
      if (!nome.endsWith('.json')) continue;
      const abs = dataSub(dataDir, 'jobs', 'keys', nome);
      try {
        const txt = await fs.readFile(abs, 'utf-8');
        if (JSON.parse(txt)?.jobId === runId) add(path.posix.join('jobs', 'keys', nome), abs);
      } catch {
        // chave corrompida não é resíduo LOGÍCICO desta run — não tocar
      }
    }
  } catch {
    // sem diretório de chaves ⇒ nada a apagar
  }

  return alvos;
}

/** Remove a linha da run no índice de resumos (`runs/_index.jsonl`, cache do listRuns). */
async function dropFromRunsIndex(dataDir: string, runId: string): Promise<string | null> {
  const idx = dataSub(dataDir, 'runs', '_index.jsonl');
  let texto: string;
  try {
    texto = await fs.readFile(idx, 'utf-8');
  } catch {
    return null; // sem índice: nada a limpar
  }
  const linhas = texto.split('\n').filter((linha) => {
    if (!linha.trim()) return false;
    try {
      return (JSON.parse(linha) as { summary?: { id?: string } })?.summary?.id !== runId;
    } catch {
      return true; // linha alheia corrompida não é resíduo desta run
    }
  });
  const novo = `${linhas.join('\n')}\n`;
  if (novo === texto) return null;
  const tmp = `${idx}.${Date.now().toString(36)}.tmp`;
  try {
    await fs.writeFile(tmp, novo, { mode: 0o600 });
    await fs.rename(tmp, idx); // reescrita atômica, igual à do storage
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
  return path.posix.join('runs', '_index.jsonl');
}

/**
 * Apaga UMA run com TODOS os resíduos: record, `.tmp` da escrita atômica,
 * dono, job (registro/log/NDJSON/cancel/chave), `agent-runs/<id>/` (artefatos
 * + cache) e a linha do índice de resumos. Idempotente: o que não existe não é
 * erro. Valida o id ANTES de resolver caminhos (nunca sai de `<data-dir>`).
 */
export async function eraseRunFiles(dataDir: string, runId: string): Promise<RunEraseResult> {
  assertValidRecordId(runId, 'id de run');
  const removed: string[] = [];
  for (const { abs, rel } of await residueOf(dataDir, runId)) {
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
  const idx = await dropFromRunsIndex(dataDir, runId);
  if (idx) removed.push(idx);
  return { id: runId, removed };
}

/** `runs delete` de uma lista de ids (o comando do CLI chama isto). */
export async function eraseRuns(dataDir: string, runIds: readonly string[]): Promise<RunEraseResult[]> {
  const out: RunEraseResult[] = [];
  for (const id of runIds) out.push(await eraseRunFiles(dataDir, id));
  return out;
}

export interface PruneReport {
  /** Registos de run varridos. */
  scanned: number;
  /** Runs vencidas apagadas (ids). */
  deleted: string[];
  /** Runs dentro do TTL mantidas (ids). */
  kept: string[];
  /** Falhas por item — o prune NUNCA lança (critério: 0 exceções). */
  errors: Array<{ id: string; error: string }>;
}

export interface PruneOptions {
  dataDir?: string;
  now?: number;
  /** Sobrepõe a política carregada (testes). */
  retentionDays?: number;
}

/**
 * Prune do TTL: remove as runs cujo início (ou, sem data legível, a idade do
 * arquivo) passou de `retentionDays`. Nunca lança — cada item é isolado e as
 * falhas entram em `errors` (critério (2) de IMPL-100: "0 exceções").
 */
export async function pruneExpiredRuns(opts: PruneOptions = {}): Promise<PruneReport> {
  const report: PruneReport = { scanned: 0, deleted: [], kept: [], errors: [] };
  try {
    // Raiz de persistência = `getDataDir()` (storage.ts), NUNCA process.cwd().
    const dataDir = opts.dataDir ?? getDataDir();
    const now = opts.now ?? Date.now();
    const retentionDays = opts.retentionDays ?? loadRetentionPolicy().retentionDays;
    const cutoff = retentionCutoffMs(now, retentionDays);
    if (cutoff === null) return report; // TTL desligado: nada vence

    const dir = dataSub(dataDir, 'runs');
    let nomes: string[] = [];
    try {
      nomes = await fs.readdir(dir);
    } catch {
      return report; // data-dir ainda sem runs/
    }
    for (const nome of nomes) {
      if (!nome.endsWith('.json')) continue;
      const id = nome.slice(0, -'.json'.length);
      try {
        assertValidRecordId(id, 'id de run');
      } catch {
        continue; // nome estranho em runs/ não é run nossa
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
        await eraseRunFiles(dataDir, id);
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

let autoPruneAt = 0;

/**
 * Prune automático (fire-and-forget): o chamador (boot do CLI/servidor, pré-voo
 * de run) dispara e segue; no máximo uma varredura por `intervalMs` por
 * processo. Devolve o relatório (quem quiser aguarda) e NUNCA rejeita.
 */
export function autoPrune(opts: PruneOptions & { intervalMs?: number; now?: number } = {}): Promise<PruneReport> {
  const now = opts.now ?? Date.now();
  const intervalMs = opts.intervalMs ?? 3_600_000;
  if (now - autoPruneAt < intervalMs) {
    return Promise.resolve({ scanned: 0, deleted: [], kept: [], errors: [] });
  }
  autoPruneAt = now;
  return pruneExpiredRuns(opts);
}
