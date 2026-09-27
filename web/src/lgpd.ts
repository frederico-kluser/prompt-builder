// Conformidade LGPD no cliente — SHIM do núcleo único `src/engine/lgpdCore.ts`
// (IMPL-041: a classificação tinha 3 cópias; agora é uma só, a mesma do CLI e
// do gerador da allowlist). NÃO reescreva regra aqui: lógica nova vai no núcleo.
//
// Este arquivo só acrescenta o que é do navegador: o CARREGAMENTO da base e do
// snapshot de endpoints ZDR a partir do bundle (os MESMOS JSON de `src/data/`,
// sem cópia em web/) e o pré-voo da run do motor client-side.
//
// Área sensível é FAIL-CLOSED (desconhecido ⇒ bloqueado; snapshot vencido ⇒
// bloqueado). A área "geral" segue consultiva. NÃO é aconselhamento jurídico.

import {
  allowlistHealth,
  assertRunCompliance,
  isSensitiveArea,
  type AllowlistHealth,
  type ComplianceConfigLike,
  type LgpdAllowlistSnapshot,
  type LgpdData,
  type RunComplianceCheck,
} from '../../src/engine/lgpdCore.js';

export * from '../../src/engine/lgpdCore.js';

let cache: Promise<LgpdData> | null = null;
let override: LgpdData | null = null;

/**
 * Base + allowlist (import dinâmico: o snapshot vira um chunk próprio e não
 * pesa no carregamento da tela inicial). Falha do chunk do snapshot ⇒
 * `allowlist: null` ⇒ área sensível bloqueada (fail-closed), nunca liberada.
 */
export function loadLgpdData(): Promise<LgpdData> {
  if (override) return Promise.resolve(override);
  cache ??= Promise.all([
    import('../../src/data/lgpd-compliance.json'),
    import('../../src/data/lgpd-allowlist.generated.json').catch(() => null),
  ])
    .then(([base, snap]) => ({
      ...(base.default as unknown as LgpdData),
      allowlist: (snap?.default as unknown as LgpdAllowlistSnapshot | undefined) ?? null,
    }))
    .catch((err: unknown) => {
      cache = null; // próxima chamada tenta de novo
      throw err;
    });
  return cache;
}

/** Troca os dados de runtime (testes). Devolve a função que restaura o anterior. */
export function overrideLgpdData(data: LgpdData | null): () => void {
  const prev = override;
  override = data;
  return () => {
    override = prev;
  };
}

/** Pré-voo da run do motor client-side (espelho de `enforceRunCompliance` do Node). */
export async function enforceRunCompliance(
  cfg: ComplianceConfigLike,
  now: Date | number = Date.now(),
): Promise<RunComplianceCheck> {
  if (!cfg.compliance) return { sensivel: false, violations: [] };
  return assertRunCompliance(cfg, await loadLgpdData(), now);
}

/**
 * Aviso para a Nova Run: em área sensível com snapshot inutilizável (ou fora
 * do alvo de 30 dias), explica POR QUE o seletor esvaziou/vai esvaziar em vez
 * de sumir com os modelos em silêncio.
 */
export function allowlistNotice(
  data: LgpdData | null,
  area: string,
  now: Date | number = Date.now(),
): { tone: 'warn' | 'error'; text: string } | null {
  if (!data || !isSensitiveArea(area, data)) return null;
  const h: AllowlistHealth = allowlistHealth(data.allowlist, now);
  if (h.state === 'ok') return null;
  return { tone: h.usable ? 'warn' : 'error', text: h.message };
}
