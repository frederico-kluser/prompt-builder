// Trilha de auditoria do handoff (`sessions winner --apply`, IMPL-027).
//
// Cada tentativa de handoff — aplicada OU bloqueada — vira UMA linha JSONL em
// `<data-dir>/handoffs.jsonl`, ao lado das sessões que ela promove. É o que
// torna o override auditável ("o motivo fica registrado") mesmo sem `--commit`,
// e o que torna a métrica do R-22:REC-6 mensurável: handoffs `applied` com
// `holdout.regressed` em `blocks` e `override: null` têm de ser 0.
//
// O registro rico de aprovação (`prompt-approval@1`, IMPL-088 — implementado:
// hashes do prompt/dataset/config, ids de sessão/runs, evidência, aprovador)
// mora em `src/cli/approval.ts`: vai EMBUTIDO em toda linha `applied` deste log
// (`approval` + `approvalFile`, com ou sem flag) e, com `--record`/`--commit`,
// também versionado no repo do destino (`.prompt-approvals/<id>.json`, ou no
// diretório de `--record-dir <dir>`; com os trailers `Approved-by:`/
// `Prompt-Approval:` no commit). O `override` segue o mesmo formato ({reason}).

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { getDataDir } from '../storage.js';
import { isControlSignal } from '../budget.js';
import type { SessionRecord } from '../types.js';
import type { HandoffGuardReport, HandoffIssueCode, HandoffOverride } from '../engine/handoffGuards.js';
import { CliError, EXIT, type Output } from './output.js';

export const HANDOFF_AUDIT_SCHEMA = 'handoff-audit@1';

export interface HandoffAuditEntry {
  schema: typeof HANDOFF_AUDIT_SCHEMA;
  at: string;
  sessionId: string;
  outcome: 'applied' | 'blocked';
  /** Destino absoluto. Em `blocked`, o arquivo NÃO foi tocado. */
  file: string;
  backup: string | null;
  committed: boolean;
  /** sha256 do prompt campeão (o que foi, ou teria sido, gravado). */
  promptSha256: string;
  blocks: HandoffIssueCode[];
  warnings: HandoffIssueCode[];
  override: HandoffOverride | null;
  holdout: SessionRecord['holdout'] | null;
  significance: SessionRecord['significance'] | null;
  judgeDrift: boolean;
}

export function handoffAuditPath(): string {
  return path.join(getDataDir(), 'handoffs.jsonl');
}

export function promptSha256(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf-8').digest('hex');
}

export function buildHandoffAuditEntry(
  record: SessionRecord,
  guards: HandoffGuardReport,
  fields: { outcome: HandoffAuditEntry['outcome']; file: string; backup: string | null; committed: boolean; prompt: string },
): HandoffAuditEntry {
  return {
    schema: HANDOFF_AUDIT_SCHEMA,
    at: new Date().toISOString(),
    sessionId: record.id,
    outcome: fields.outcome,
    file: fields.file,
    backup: fields.backup,
    committed: fields.committed,
    promptSha256: promptSha256(fields.prompt),
    blocks: guards.blocks.map((b) => b.code),
    warnings: guards.warnings.map((w) => w.code),
    override: guards.override,
    holdout: record.holdout ?? null,
    significance: record.significance ?? null,
    judgeDrift: Boolean(record.judgeDrift),
  };
}

/**
 * Pré-condição do override: a trilha TEM de ser gravável ANTES de o destino
 * ser tocado. Override sem registro não passa (fail-closed) — senão o motivo
 * se perderia justamente no caso que mais precisa dele.
 */
export async function ensureHandoffAuditWritable(): Promise<void> {
  const file = handoffAuditPath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, '', 'utf-8');
  } catch (err) {
    if (isControlSignal(err)) throw err;
    // USAGE, como todo erro de caminho/permissão do CLI (`toCliError`): o
    // conserto é apontar um --data-dir gravável, não abrir bug.
    throw new CliError(
      `Override recusado: não consegui gravar a trilha de auditoria em ${file} ` +
        `(${err instanceof Error ? err.message : String(err)}). Nada foi aplicado.`,
      EXIT.USAGE,
      { auditFile: file },
      {
        code: 'handoff.audit_unwritable',
        hint: 'Confira as permissões do diretório de dados (--data-dir / $PROMPT_BUILDER_HOME) e repita.',
      },
    );
  }
}

/**
 * Acrescenta a linha de auditoria (uma escrita O_APPEND por entrada). Falha
 * aqui vira AVISO: no caminho aplicado o prompt já está gravado e o override
 * já passou pela pré-condição acima; no bloqueado nada foi tocado.
 */
export async function appendHandoffAudit(entry: HandoffAuditEntry, out: Output): Promise<string | null> {
  const file = handoffAuditPath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf-8');
    return file;
  } catch (err) {
    if (isControlSignal(err)) throw err;
    out.warn(
      `não consegui gravar a trilha de auditoria em ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Lê a trilha (linhas inválidas são ignoradas). Para auditoria e testes. */
export async function readHandoffAudit(file = handoffAuditPath()): Promise<HandoffAuditEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const entries: HandoffAuditEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as HandoffAuditEntry;
      if (e && e.schema === HANDOFF_AUDIT_SCHEMA) entries.push(e);
    } catch {
      // linha truncada/corrompida: não derruba a leitura das outras
    }
  }
  return entries;
}

/**
 * Métrica do R-22:REC-6: handoffs APLICADOS com holdout regredido e sem
 * override. O contrato é que isto seja sempre 0.
 */
export function unsafeHandoffs(entries: readonly HandoffAuditEntry[]): HandoffAuditEntry[] {
  return entries.filter(
    (e) => e.outcome === 'applied' && e.blocks.includes('holdout.regressed') && !e.override?.reason,
  );
}

/**
 * Trailers git do override (`git interpret-trailers --parse` os lê). Só
 * existem quando houve override: o commit do handoff normal não muda.
 */
export function overrideTrailers(override: HandoffOverride | null): string[] {
  if (!override) return [];
  const trailers = [`Override-Reason: ${override.reason}`];
  if (override.bypassed.length > 0) trailers.push(`Override-Bypassed: ${override.bypassed.join(', ')}`);
  return trailers;
}
