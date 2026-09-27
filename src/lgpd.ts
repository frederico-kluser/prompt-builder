import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PKG_DATA_DIR } from './paths.js';
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

// Resolvido pela raiz do PACOTE, nao pelo cwd: instalado via npm o cwd e o
// projeto do usuario e a leitura falharia com ENOENT. Ver src/paths.ts.
const JSON_PATH = path.join(PKG_DATA_DIR, 'lgpd-compliance.json');
const ALLOWLIST_PATH = path.join(PKG_DATA_DIR, 'lgpd-allowlist.generated.json');

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
  return piiReport ? { ...check, piiReport } : check;
}
