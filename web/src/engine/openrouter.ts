// SHIM do gateway único (IMPL-021): a fonte é `src/openrouter.ts`, o MESMO
// código que roda no Node — limitador AIMD, retry, `usage.cost` como custo
// medido (catálogo só como fallback) e contabilidade por papel (role + sink).
// Aqui só mora a configuração com as particularidades do NAVEGADOR:
//   - atribuição pela origem da página (no Node vem de OPENROUTER_APP_URL) —
//     suprimível pela preferência `pb.noAttribution` (IMPL-120: os headers
//     `HTTP-Referer`/`X-Title` são DADO enviado ao OpenRouter);
//   - base fixa na API pública (a SPA não tem ambiente; CORS liberado);
//   - streaming em TODOS os papéis (IMPL-072: em abort o provedor para de
//     gerar — no JSON ele conclui e cobra a resposta inteira);
//   - calibração da estimativa (IMPL-113) persistida no navegador: as
//     amostras estimado × real sobrevivem ao recarregar a página;
//   - `fetch` global resolvido na hora pelo próprio gateway (nunca guardado
//     como método de outro objeto — "Illegal invocation" no navegador).
// A configuração roda no import: qualquer módulo que chegue ao gateway por
// este shim (api.ts, orchestrator, trainer, duels) o encontra configurado.

import {
  configureGateway,
  DEFAULT_OPENROUTER_BASE_URL,
  subscribeCostSamples,
  type CostCalibrationSample,
  type GatewayConfig,
} from '../../../src/openrouter.js';
import { CostCalibration, isCostCalibrationSample, setCostCalibrationProvider } from '../../../src/estimate.js';

export * from '../../../src/openrouter.js';

/** Chave da preferência "não enviar headers de atribuição" (IMPL-120). */
export const NO_ATTRIBUTION_STORAGE_KEY = 'pb.noAttribution';
/** Chave das amostras de calibração da estimativa (IMPL-113). */
export const COST_SAMPLES_STORAGE_KEY = 'pb.costSamples';
/** Teto de amostras guardadas no navegador (as últimas bastam para quantis). */
export const COST_SAMPLES_STORAGE_LIMIT = 1000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** `localStorage` quando existe e funciona (modo privado/sandbox pode lançar). */
function storage(): StorageLike | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

/** A SPA suprime a atribuição? (preferência salva; default: não). */
export function isAttributionDisabled(store: StorageLike | undefined = storage()): boolean {
  try {
    return store?.getItem(NO_ATTRIBUTION_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Config do gateway para a SPA (puro — testável fora do navegador). */
export function browserGatewayConfig(store: StorageLike | undefined = storage()): Partial<GatewayConfig> {
  return {
    baseUrl: DEFAULT_OPENROUTER_BASE_URL,
    appUrl: typeof window !== 'undefined' ? window.location.origin : 'https://prompt-builder',
    appTitle: 'Prompt Builder',
    // IMPL-072: streaming em todos os papéis NO NAVEGADOR. Fora dele (testes
    // do motor do web no Node, que importam este shim DEPOIS de trocar a
    // instância padrão por um transporte falso) o shim não muda o transporte
    // de quem o configurou.
    ...(typeof window !== 'undefined' ? { streamTransport: true } : {}),
    ...(isAttributionDisabled(store) ? { attribution: false } : {}),
  };
}

/**
 * Liga/desliga os headers de atribuição na SPA (IMPL-120) e salva a escolha.
 * Vale na hora: o gateway é reconfigurado em lugar (cache/limitador preservados).
 */
export function setAttributionEnabled(enabled: boolean, store: StorageLike | undefined = storage()): void {
  try {
    if (enabled) store?.removeItem(NO_ATTRIBUTION_STORAGE_KEY);
    else store?.setItem(NO_ATTRIBUTION_STORAGE_KEY, '1');
  } catch {
    // armazenamento indisponível: vale só nesta aba
  }
  configureGateway({ attribution: enabled });
}

/**
 * Amostras salvas (lixo/ausente = nenhuma — nunca derruba a página). Cada item
 * passa pela MESMA régua do leitor do Node (`isCostCalibrationSample`): entrada
 * velha/corrompida (estimado 0, modelo ausente) não vira razão Infinity/NaN.
 */
export function loadStoredCostSamples(store: StorageLike | undefined = storage()): CostCalibrationSample[] {
  try {
    const raw = store?.getItem(COST_SAMPLES_STORAGE_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter(isCostCalibrationSample) : [];
  } catch {
    return [];
  }
}

/**
 * IMPL-113 — persistência da calibração no navegador: carrega as amostras
 * salvas, assina as novas (uma por chamada MEDIDA) e registra o provedor que
 * `estimateRunCost` usa quando o chamador não passa `calibration`. Gravação
 * adiada (1 escrita por rajada), com teto de `COST_SAMPLES_STORAGE_LIMIT`.
 */
export function installBrowserCostCalibration(store: StorageLike | undefined = storage()): () => void {
  let amostras = loadStoredCostSamples(store).slice(-COST_SAMPLES_STORAGE_LIMIT);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gravar = (): void => {
    timer = undefined;
    try {
      store?.setItem(COST_SAMPLES_STORAGE_KEY, JSON.stringify(amostras));
    } catch {
      // cota estourada/sem armazenamento: a calibração segue em memória
    }
  };
  const cancelar = subscribeCostSamples((s) => {
    amostras = [...amostras, s].slice(-COST_SAMPLES_STORAGE_LIMIT);
    if (timer === undefined) timer = setTimeout(gravar, 1000);
  });
  setCostCalibrationProvider(() => (amostras.length > 0 ? CostCalibration.fromJSON(amostras) : undefined));
  return () => {
    cancelar();
    if (timer !== undefined) {
      clearTimeout(timer);
      gravar();
    }
    setCostCalibrationProvider(undefined);
  };
}

configureGateway(browserGatewayConfig());
// Só no NAVEGADOR de verdade: no Node (testes que importam o motor do web) o
// provedor global de calibração mudaria a faixa das estimativas dos outros
// testes do mesmo processo. Os testes chamam `installBrowserCostCalibration`
// com um armazenamento falso.
if (typeof window !== 'undefined' && storage()) installBrowserCostCalibration();
