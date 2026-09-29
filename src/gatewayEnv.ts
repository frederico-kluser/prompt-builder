// Configuracao do gateway a partir do AMBIENTE — so Node (CLI, servidor, API
// de biblioteca). O gateway (`openrouter.ts`) nao le o processo: e isto que
// traduz as variaveis OPENROUTER_* para `GatewayConfig`, preservando o
// comportamento historico (mesmos defaults quando a variavel falta).
//
// ⚠️ Nao importe este modulo do web: ele toca `process`, que nao existe no
// navegador. O web configura o gateway no shim `web/src/engine/openrouter.ts`.

import {
  AUDITABLE_ROLES,
  configureGateway,
  type GatewayConfig,
  type OpenRouterGateway,
  type RoleTimeouts,
} from './openrouter.js';
import { COST_ROLES, type CostRole } from './types.js';

type Env = Record<string, string | undefined>;

/** Valor "ligado" de uma flag de ambiente (`1`/`on`/`true`/`yes`, sem caixa). */
export function envFlagOn(value: string | undefined): boolean {
  return /^(1|on|true|yes)$/i.test((value ?? '').trim());
}

/** Valor "desligado" explicito (`0`/`off`/`false`/`no`, sem caixa). */
function envFlagOff(value: string | undefined): boolean {
  return /^(0|off|false|no)$/i.test((value ?? '').trim());
}

/**
 * IMPL-120 (R-01b:REC-9) — `PROMPT_BUILDER_NO_ATTRIBUTION=on` suprime os
 * headers de ATRIBUICAO (`HTTP-Referer`/`X-Title`) — dado enviado ao
 * OpenRouter. Fonte unica da flag (o comando `telemetry` re-exporta).
 */
export function isAttributionSuppressedEnv(env: Env): boolean {
  return envFlagOn(env.PROMPT_BUILDER_NO_ATTRIBUTION);
}

/**
 * `OPENROUTER_ROLE_TIMEOUTS` (IMPL-077): `papel=inatividade/total` em
 * SEGUNDOS, separados por virgula — ex.: `judge=60/120,competitor=90/600`.
 * So um numero (`duel=90`) = teto total. Papel desconhecido/valor lixo e
 * ignorado (o gateway recorta para 1-600 s).
 */
export function parseRoleTimeouts(raw: string | undefined): Partial<Record<CostRole, Partial<RoleTimeouts>>> | undefined {
  const txt = (raw ?? '').trim();
  if (!txt) return undefined;
  const out: Partial<Record<CostRole, Partial<RoleTimeouts>>> = {};
  for (const item of txt.split(',')) {
    const [role, valor] = item.split('=').map((s) => s.trim());
    if (!role || !valor || !(COST_ROLES as readonly string[]).includes(role)) continue;
    const partes = valor.split('/').map((s) => Number(s.trim()));
    const t: Partial<RoleTimeouts> = {};
    if (partes.length >= 2) {
      if (Number.isFinite(partes[0]) && partes[0] > 0) t.idleMs = partes[0] * 1000;
      if (Number.isFinite(partes[1]) && partes[1] > 0) t.totalMs = partes[1] * 1000;
    } else if (Number.isFinite(partes[0]) && partes[0] > 0) {
      t.totalMs = partes[0] * 1000;
    }
    if (t.idleMs !== undefined || t.totalMs !== undefined) out[role as CostRole] = t;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * `OPENROUTER_AUDITABLE` (IMPL-075): `on` = preset (juiz + duelo + gabarito,
 * os papeis de REFERENCIA); ou a lista de papeis (`judge,gabarito,duel`).
 */
function parseAuditableRoles(raw: string | undefined): CostRole[] | undefined {
  const txt = (raw ?? '').trim();
  if (!txt || envFlagOff(txt)) return undefined;
  if (envFlagOn(txt)) return [...AUDITABLE_ROLES];
  const roles = txt
    .split(',')
    .map((s) => s.trim())
    .filter((r): r is CostRole => (COST_ROLES as readonly string[]).includes(r));
  return roles.length > 0 ? roles : undefined;
}

/**
 * OPENROUTER_BASE_URL → baseUrl (barra final removida; vazio = default)
 * OPENROUTER_APP_URL → appUrl (header HTTP-Referer)
 * OPENROUTER_APP_TITLE → appTitle (header X-Title)
 * PROMPT_BUILDER_NO_ATTRIBUTION=on → attribution:false (nenhum dos dois headers)
 * OPENROUTER_MAX_CONCURRENCY → maxConcurrency (nao numerico = default 32)
 * OPENROUTER_STREAM_TRANSPORT=0 → streamTransport:false (IMPL-072: por
 *   omissao TODO papel vai em streaming — em abort o provedor para de gerar)
 * OPENROUTER_ROLE_TIMEOUTS → roleTimeouts (IMPL-077; ver `parseRoleTimeouts`)
 * OPENROUTER_META_TIMEOUT_MS → metaTimeoutMs (/models, /key, /generation)
 * OPENROUTER_AUDITABLE → auditableRoles (IMPL-075; `on` = juiz + duelo + gabarito)
 * OPENROUTER_AUDITABLE_PROVIDERS → auditableProviderOrder (lista por virgula)
 */
export function gatewayConfigFromEnv(env: Env): Partial<GatewayConfig> {
  const out: Partial<GatewayConfig> = {};
  const base = env.OPENROUTER_BASE_URL?.trim();
  if (base) out.baseUrl = base;
  if (env.OPENROUTER_APP_URL !== undefined) out.appUrl = env.OPENROUTER_APP_URL;
  if (env.OPENROUTER_APP_TITLE !== undefined) out.appTitle = env.OPENROUTER_APP_TITLE;
  if (isAttributionSuppressedEnv(env)) out.attribution = false;
  const conc = env.OPENROUTER_MAX_CONCURRENCY?.trim();
  if (conc) {
    const n = Number(conc);
    if (Number.isFinite(n)) out.maxConcurrency = n;
  }
  // IMPL-072: streaming e o DEFAULT de runtime; so o "desligado" explicito volta ao JSON.
  out.streamTransport = !envFlagOff(env.OPENROUTER_STREAM_TRANSPORT);
  const roleTimeouts = parseRoleTimeouts(env.OPENROUTER_ROLE_TIMEOUTS);
  if (roleTimeouts) out.roleTimeouts = roleTimeouts;
  const meta = Number(env.OPENROUTER_META_TIMEOUT_MS?.trim() || NaN);
  if (Number.isFinite(meta) && meta > 0) out.metaTimeoutMs = meta;
  const auditable = parseAuditableRoles(env.OPENROUTER_AUDITABLE);
  if (auditable) out.auditableRoles = auditable;
  const ordem = (env.OPENROUTER_AUDITABLE_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ordem.length > 0) out.auditableProviderOrder = ordem;
  return out;
}

/** Aplica o ambiente do processo na instancia padrao do gateway. */
export function configureGatewayFromEnv(env: Env = process.env): OpenRouterGateway {
  return configureGateway(gatewayConfigFromEnv(env));
}
