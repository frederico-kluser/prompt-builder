// Benchmark de visão na SPA — o MOTOR RODA NA ABA.
//
// O laço de células e o placar são os MESMOS do CLI (`src/engine/vision/`,
// fonte única): aqui só entram os seams do navegador — key, fetch da imagem
// como data URL, ledger local e IndexedDB. O gateway é o mesmo shim do Node
// (limitador AIMD, reserva, `usage.cost`); a run exige teto de gasto (regra da
// SPA com LLM) e a célula cortada por orçamento vira `skipped`.

import { getStoredKey, isKnownPrice, type OpenRouterModel } from '../api';
import { BudgetLedger } from '../engine/budget';
import { makeCallEstimator } from '../engine/estimate';
import { getGateway } from '../engine/openrouter';
import {
  planCells,
  runVisionCore,
  selectScenes,
  type VisionCell,
  type VisionDataset,
  type VisionRunConfig,
  type VisionRunRecord,
  type VisionScene,
  type VisionTaskKind,
} from '../engine/vision';
import { sceneImageDataUrl } from './dataset';
import { saveVisionRun } from './store';

export class VisionNoKeyError extends Error {
  readonly code = 'vision-no-key';
  constructor() {
    super('Conecte sua chave da OpenRouter para rodar o benchmark de visão.');
    this.name = 'VisionNoKeyError';
  }
}

function novoId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `vision-${Date.now().toString(36)}-${rand}`;
}

export interface RunVisionBrowserParams {
  dataset: VisionDataset;
  config: VisionRunConfig;
  /** Catálogo (preços + modalidade); vai como `catalog` para o aviso de visão. */
  models: readonly OpenRouterModel[];
  signal?: AbortSignal;
  onCell?: (cell: VisionCell) => void;
}

export interface RunVisionBrowserResult {
  record: VisionRunRecord;
  saved: boolean;
}

/** Roda o benchmark na aba e grava no IndexedDB. O teto é OBRIGATÓRIO. */
export async function runVisionInBrowser(params: RunVisionBrowserParams): Promise<RunVisionBrowserResult> {
  const key = getStoredKey();
  if (!key) throw new VisionNoKeyError();
  if (!(params.config.budgetUsd && params.config.budgetUsd > 0)) {
    throw new Error('defina um teto de gasto (US$) antes de rodar.');
  }
  const catalog = params.models as unknown as Parameters<typeof makeCallEstimator>[0];
  const ledger = new BudgetLedger({
    budgetUsd: params.config.budgetUsd,
    signal: params.signal,
    estimateCall: makeCallEstimator(catalog),
  });
  const record = await runVisionCore({
    dataset: params.dataset,
    config: params.config,
    apiKey: key,
    gateway: getGateway(),
    ledger,
    catalog: params.models as never,
    id: novoId(),
    imageFor: (scene: VisionScene) => sceneImageDataUrl(scene),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.onCell ? { onCell: params.onCell } : {}),
  });
  const saved = await saveVisionRun(record);
  return { record, saved };
}

export interface VisionEstimate {
  scenes: number;
  mapScenes: number;
  actionTasks: number;
  calls: number;
  usd: number;
  /** Modelos sem preço no catálogo: a estimativa os conta como zero. */
  unpriced: string[];
}

/** Estimativa pelo TETO (imagem ~1.800 tokens + `maxTokens` de saída). */
export function estimateVisionRun(
  dataset: VisionDataset,
  config: Pick<VisionRunConfig, 'families' | 'scenes' | 'limit' | 'tasks' | 'models' | 'maxTokens'>,
  models: readonly OpenRouterModel[],
): VisionEstimate {
  const selecao = selectScenes(dataset, {
    families: config.families,
    scenes: config.scenes,
    limit: config.limit,
  });
  const planos = planCells(selecao.scenes, config.tasks);
  const mapScenes = planos.filter((p) => p.kind === 'map').length;
  const actionTasks = planos.filter((p) => p.kind === 'action').length;
  const porModelo = planos.length;
  const estimador = makeCallEstimator(models as never);
  const promptTokens = 900 + 1800;
  let usd = 0;
  for (const modelId of config.models) {
    usd += estimador(modelId, promptTokens, config.maxTokens) * porModelo;
  }
  const porId = new Map(models.map((m) => [m.id, m]));
  const unpriced = config.models.filter((id) => {
    const m = porId.get(id);
    if (!m) return true;
    return !isKnownPrice(m.pricing.prompt) || !isKnownPrice(m.pricing.completion);
  });
  return {
    scenes: selecao.scenes.length,
    mapScenes,
    actionTasks,
    calls: porModelo * config.models.length,
    usd,
    unpriced,
  };
}

/** Quantas tarefas de ação a seleção tem (para o texto do formulário). */
export function selectionCounts(
  dataset: VisionDataset,
  families: VisionRunConfig['families'],
  limit: number | null,
  tasks: readonly VisionTaskKind[],
): { scenes: number; actionTasks: number } {
  const selecao = selectScenes(dataset, { families, limit });
  const planos = planCells(selecao.scenes, tasks);
  return {
    scenes: selecao.scenes.length,
    actionTasks: planos.filter((p) => p.kind === 'action').length,
  };
}
