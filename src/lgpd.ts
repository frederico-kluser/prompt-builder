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

/**
 * Pré-voo da run (chamado pelo orquestrador ANTES de qualquer LLM): no modo
 * sensível, recusa com `LgpdPolicyError` se algum papel estiver fora da
 * allowlist ou se o snapshot estiver vencido.
 */
export async function enforceRunCompliance(
  cfg: ComplianceConfigLike,
  now: Date | number = Date.now(),
): Promise<RunComplianceCheck> {
  if (!cfg.compliance) return { sensivel: false, violations: [] };
  return assertRunCompliance(cfg, getLgpdData(), now);
}
