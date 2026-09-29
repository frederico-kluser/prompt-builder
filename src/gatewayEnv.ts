// Configuracao do gateway a partir do AMBIENTE — so Node (CLI, servidor, API
// de biblioteca). O gateway (`openrouter.ts`) nao le o processo: e isto que
// traduz as variaveis OPENROUTER_* para `GatewayConfig`, preservando o
// comportamento historico (mesmos defaults quando a variavel falta).
//
// ⚠️ Nao importe este modulo do web: ele toca `process`, que nao existe no
// navegador. O web configura o gateway no shim `web/src/engine/openrouter.ts`.

import { configureGateway, type GatewayConfig, type OpenRouterGateway } from './openrouter.js';

type Env = Record<string, string | undefined>;

/**
 * OPENROUTER_BASE_URL → baseUrl (barra final removida; vazio = default)
 * OPENROUTER_APP_URL → appUrl (header HTTP-Referer)
 * OPENROUTER_APP_TITLE → appTitle (header X-Title)
 * OPENROUTER_MAX_CONCURRENCY → maxConcurrency (nao numerico = default 32)
 * OPENROUTER_DECISIONS_URL → decisionsUrl (modo JEV; vazio = derivada da base)
 */
export function gatewayConfigFromEnv(env: Env): Partial<GatewayConfig> {
  const out: Partial<GatewayConfig> = {};
  const base = env.OPENROUTER_BASE_URL?.trim();
  if (base) out.baseUrl = base;
  if (env.OPENROUTER_APP_URL !== undefined) out.appUrl = env.OPENROUTER_APP_URL;
  if (env.OPENROUTER_APP_TITLE !== undefined) out.appTitle = env.OPENROUTER_APP_TITLE;
  const decisions = env.OPENROUTER_DECISIONS_URL?.trim();
  if (decisions) out.decisionsUrl = decisions;
  const conc = env.OPENROUTER_MAX_CONCURRENCY?.trim();
  if (conc) {
    const n = Number(conc);
    if (Number.isFinite(n)) out.maxConcurrency = n;
  }
  return out;
}

/** Aplica o ambiente do processo na instancia padrao do gateway. */
export function configureGatewayFromEnv(env: Env = process.env): OpenRouterGateway {
  return configureGateway(gatewayConfigFromEnv(env));
}
