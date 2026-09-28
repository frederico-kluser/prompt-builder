// SHIM do gateway único (IMPL-021): a fonte é `src/openrouter.ts`, o MESMO
// código que roda no Node — limitador AIMD, retry, `usage.cost` como custo
// medido (catálogo só como fallback) e contabilidade por papel (role + sink).
// Aqui só mora a configuração com as particularidades do NAVEGADOR:
//   - atribuição pela origem da página (no Node vem de OPENROUTER_APP_URL);
//   - base fixa na API pública (a SPA não tem ambiente; CORS liberado);
//   - `fetch` global resolvido na hora pelo próprio gateway (nunca guardado
//     como método de outro objeto — "Illegal invocation" no navegador).
// A configuração roda no import: qualquer módulo que chegue ao gateway por
// este shim (api.ts, orchestrator, trainer, duels) o encontra configurado.

import {
  configureGateway,
  DEFAULT_OPENROUTER_BASE_URL,
  type GatewayConfig,
} from '../../../src/openrouter.js';

export * from '../../../src/openrouter.js';

/** Config do gateway para a SPA (puro — testável fora do navegador). */
export function browserGatewayConfig(): Partial<GatewayConfig> {
  return {
    baseUrl: DEFAULT_OPENROUTER_BASE_URL,
    appUrl: typeof window !== 'undefined' ? window.location.origin : 'https://prompt-builder',
    appTitle: 'Prompt Builder',
  };
}

configureGateway(browserGatewayConfig());
