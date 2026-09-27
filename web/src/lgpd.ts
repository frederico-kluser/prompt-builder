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
import {
  assertRunPii,
  checkRunPii,
  summarizeRunPii,
  type PiiConfigLike,
  type PiiRunReport,
} from '../../src/engine/pii.js';
import { sensitiveRoutingFor, type SensitiveRouting } from '../../src/engine/sensitiveRouting.js';
import retentionBase from '../../src/data/lgpd-retention.json';
import { resetIdbConnection } from './idb.js';
import type { StorageManagerLike } from './storageHealth.js';

export * from '../../src/engine/lgpdCore.js';
// Cascata de dado pessoal PT-BR (IMPL-042) — shim do núcleo puro, igual ao Node.
export * from '../../src/engine/pii.js';
// Enforcement do modo sensível no gateway (IMPL-040) — o MESMO módulo do Node.
export * from '../../src/engine/sensitiveRouting.js';

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

/**
 * Pré-voo da run do motor client-side (espelho de `enforceRunCompliance` do
 * Node): allowlist LGPD na área sensível + dado pessoal (IMPL-042: recusa no
 * "só sintético", no modo agente e no "redigir" sem `allowPii`). `nested` =
 * run de iteração/triagem/holdout de uma sessão (o config da sessão já passou
 * pelo pré-voo; aqui só se relata).
 */
export async function enforceRunCompliance(
  cfg: ComplianceConfigLike & PiiConfigLike,
  now: Date | number = Date.now(),
  opts: { nested?: boolean } = {},
): Promise<RunComplianceCheck & { piiReport?: PiiRunReport; sensitiveRouting?: SensitiveRouting }> {
  const check: RunComplianceCheck = cfg.compliance
    ? assertRunCompliance(cfg, await loadLgpdData(), now)
    : { sensivel: false, violations: [] };
  const pii = opts.nested ? checkRunPii(cfg) : assertRunPii(cfg);
  const piiReport = summarizeRunPii(pii);
  // IMPL-040: política do modo sensível — o chamador a liga no ledger.
  const sensitiveRouting = check.sensivel ? sensitiveRoutingFor(cfg, await loadLgpdData(), now) : undefined;
  return {
    ...check,
    ...(piiReport ? { piiReport } : {}),
    ...(sensitiveRouting ? { sensitiveRouting } : {}),
  };
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

// ---------------------------------------------------------------------------
// Retenção/apagamento (IMPL-100, R-16:REC-6) — lado NAVEGADOR
// ---------------------------------------------------------------------------
// O apagamento lógico (`idbDelete`) NÃO serve para LGPD: os tombstones do
// LevelDB continuam recuperáveis (crbug 40418460). O "apagar tudo" da SPA
// derruba o banco INTEIRO (`indexedDB.deleteDatabase`) e reporta antes/depois
// via `navigator.storage.estimate()`. O que o navegador guarda fora do
// IndexedDB (localStorage, Cache Storage) só some em "limpar dados do site" —
// por isso `siteWipeInstructions()` entrega o passo a passo.
//
// O TTL/prune do lado servidor é `src/lgpd.ts` (`pruneExpiredRuns`); aqui fica
// a MESMA semântica de corte para o histórico local (`isOlderThan`), casada
// por `test/lgpd-retention.test.ts` (os dois lados calculam igual).

/** Nome do banco: espelha `DB_NAME` de `web/src/idb.ts` (o contrato é testado: apagar tem de apagar o MESMO banco que o idb abre). */
const DB_NAME = 'prompt-builder';

/** Override do TTL no navegador (dias); fora do padrão ⇒ o default do JSON. */
export const RETENTION_DAYS_KEY = 'pb.retentionDays';

const DEFAULT_RETENTION_DAYS: number = retentionBase.retentionDays ?? 90;

const DAY_MS = 86_400_000;

/** TTL efetivo: default do pacote (`src/data/lgpd-retention.json`) + override em localStorage. */
export function retentionDaysFor(storage?: Pick<Storage, 'getItem'>): number {
  const raw = storage ? storage.getItem(RETENTION_DAYS_KEY) : (globalThis.localStorage?.getItem(RETENTION_DAYS_KEY) ?? null);
  if (raw !== null && /^\d+$/u.test(raw.trim())) return Number(raw.trim());
  return DEFAULT_RETENTION_DAYS;
}

/** Instante (ms) a partir do qual o registo já está vencido; `retentionDays: 0` ⇒ nunca (espelho de `src/lgpd.ts`). */
export function retentionCutoffMs(now: number, retentionDays: number): number | null {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) return null;
  return now - retentionDays * DAY_MS;
}

/** Espelho da semântica do Node (`src/lgpd.ts`): `test/lgpd-retention.test.ts` casa os dois. */
export function isOlderThan(ref: Date | number | string, now: number, retentionDays: number): boolean {
  const cutoff = retentionCutoffMs(now, retentionDays);
  if (cutoff === null) return false;
  const t = ref instanceof Date ? ref.getTime() : typeof ref === 'number' ? ref : Date.parse(ref);
  if (!Number.isFinite(t)) return true; // data ilegível ⇒ vencido (não reter por engano)
  return t < cutoff;
}

export interface SiteEstimate {
  usage: number;
  quota: number | null;
}

/** `navigator.storage.estimate()` (injetável em teste). Falha ⇒ `{ usage: 0, quota: null }`. */
export async function estimateSiteStorage(manager?: StorageManagerLike): Promise<SiteEstimate> {
  const m = manager ?? globalThis.navigator?.storage;
  if (!m?.estimate) return { usage: 0, quota: null };
  try {
    const e = await m.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? null };
  } catch {
    return { usage: 0, quota: null };
  }
}

export interface SiteWipeResult {
  estimateBefore: SiteEstimate;
  estimateAfter: SiteEstimate;
  /** `deleteDatabase` concluiu (banco inteiro apagado). */
  deleted: boolean;
  /** Ficou bloqueado: outra aba segura conexão aberta no banco. */
  blocked: boolean;
}

export interface WipeLocalOptions {
  /** Fábrica do IndexedDB (testes); default `globalThis.indexedDB`. */
  indexedDB?: IDBFactory | null;
  /** `navigator.storage` (testes). */
  storage?: StorageManagerLike;
  /** Fecha as conexões em cache do `idb.ts` (default: `resetIdbConnection`). */
  closeConnections?: () => void;
  /** Quanto espera pelo fecho de outras abas antes de reportar `blocked` (default 3000 ms). */
  blockedWaitMs?: number;
}

/**
 * "Apagar banco": fecha as conexões desta aba, derruba o IndexedDB INTEIRO
 * (`deleteDatabase` — remove até os tombstones que o `delete` lógico deixa) e
 * devolve `navigator.storage.estimate()` antes/depois (o critério é ≈ 0).
 * `blocked: true` = outra aba ainda segura conexão; o navegador completa o
 * apagamento quando ela fechar.
 */
export function wipeLocalData(opts: WipeLocalOptions = {}): Promise<SiteWipeResult> {
  const factory = opts.indexedDB === undefined ? globalThis.indexedDB : opts.indexedDB;
  const close = opts.closeConnections ?? resetIdbConnection;
  const blockedWaitMs = opts.blockedWaitMs ?? 3_000;
  return (async (): Promise<SiteWipeResult> => {
    const estimateBefore = await estimateSiteStorage(opts.storage);
    close();
    if (!factory) {
      // Sem IndexedDB não há banco a derrubar: o "antes" já é o "depois".
      return { estimateBefore, estimateAfter: estimateBefore, deleted: true, blocked: false };
    }
    const { deleted, blocked } = await new Promise<{ deleted: boolean; blocked: boolean }>((resolve) => {
      let done = false;
      let sawBlocked = false;
      const finish = (deletedFlag: boolean): void => {
        if (done) return;
        done = true;
        resolve({ deleted: deletedFlag, blocked: sawBlocked });
      };
      try {
        const req = factory.deleteDatabase(DB_NAME);
        req.onsuccess = () => finish(true);
        req.onerror = () => finish(false);
        req.onblocked = () => {
          sawBlocked = true;
          // Outra aba segura a conexão: espera o fecho; sem fecho, reporta.
          setTimeout(() => finish(false), blockedWaitMs);
        };
      } catch {
        finish(false);
      }
    });
    const estimateAfter = await estimateSiteStorage(opts.storage);
    return { estimateBefore, estimateAfter, deleted, blocked };
  })();
}

/**
 * Instrução de "limpar dados do site" (o que o navegador guarda FORA do
 * IndexedDB — localStorage com a key, Cache Storage, service workers). Texto
 * puro: a tela de Configurações só o apresenta.
 */
export function siteWipeInstructions(): string[] {
  return [
    'O apagamento acima remove o banco local do app (runs, sessões e biblioteca).',
    'Para apagar TUDO que este site guardou no navegador (inclusive a chave da OpenRouter e caches) use "limpar dados do site":',
    '• Chrome/Edge: Configurações → Privacidade e segurança → Dados de sites → ver todos os sites e dados → procure por este site → Excluir.',
    '• Firefox: Configurações → Privacidade e segurança → Cookies e dados de sites → Dados guardados → Gerir dados → procure por este site → Remover.',
    '• Safari: Safari → Definições → Privacidade → Gerir dados de sites → procure por este site → Remover.',
    'Depois, recarregue a página.',
  ];
}
