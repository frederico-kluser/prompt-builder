// BENCHMARK DE VISÃO — runner NODE (wrapper do core).
//
// O laço de células, o placar e o record vivem em `src/engine/vision/runner.ts`
// (fonte única, também usada pela SPA). Aqui mora só o que é do Node:
//   • leitura da imagem do dataset no disco (data URL);
//   • geração do id do record (`node:crypto`);
//   • criação/fork do ledger (guards do CLI / teto diário).
//
// Contrato de dinheiro e de controle é o do core: role `competitor`, sink =
// ledger, célula cortada por orçamento sai `skipped` e a run fica `aborted`.

import { randomUUID } from 'node:crypto';
import { BudgetLedger } from '../budget.js';
import { getGateway, type OpenRouterGateway } from '../openrouter.js';
import { makeCallEstimator } from '../estimate.js';
import type { OpenRouterModel } from '../types.js';
import type {
  VisionCell,
  VisionDataset,
  VisionImageRef,
  VisionRunConfig,
  VisionRunRecord,
  VisionScene,
} from '../engine/vision/index.js';
import { runVisionCore } from '../engine/vision/runner.js';
import { sceneImageDataUrl } from './dataset.js';

export { planVisionRun, VisionRunError } from '../engine/vision/runner.js';

export interface RunVisionParams {
  dataset: VisionDataset;
  /** Raiz do dataset (para ler as imagens). */
  datasetRoot: string;
  config: VisionRunConfig;
  apiKey: string;
  signal?: AbortSignal;
  gateway?: OpenRouterGateway;
  /** Ledger PAI (teto diário/guards do CLI) — a run faz `fork()` dele. */
  parentLedger?: BudgetLedger;
  /** Catálogo já carregado (estimador da reserva e aviso de modalidade). */
  catalog?: readonly OpenRouterModel[];
  /** Progresso célula a célula (NDJSON do CLI). */
  onCell?: (cell: VisionCell) => void;
  /** Relógio injetável (testes). */
  now?: () => Date;
}

/** Executa o benchmark no Node e devolve o record (o chamador persiste). */
export async function runVision(params: RunVisionParams): Promise<VisionRunRecord> {
  const gateway = params.gateway ?? getGateway();
  if (params.config.provider) {
    gateway.configure({ auditableProviderOrder: [params.config.provider], auditableQuantizations: [] });
  }
  const catalog = params.catalog ?? gateway.peekModelsCache(params.apiKey)?.data ?? [];
  const ledger =
    params.parentLedger?.fork() ??
    new BudgetLedger({
      budgetUsd: params.config.budgetUsd,
      signal: params.signal,
      estimateCall: catalog.length > 0 ? makeCallEstimator(catalog as OpenRouterModel[]) : undefined,
    });
  return runVisionCore({
    dataset: params.dataset,
    config: params.config,
    apiKey: params.apiKey,
    gateway,
    ledger,
    catalog,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.onCell ? { onCell: params.onCell } : {}),
    ...(params.now ? { now: params.now } : {}),
    id: `vision-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    imageFor: (scene: VisionScene, ref?: VisionImageRef) => sceneImageDataUrl(params.datasetRoot, scene, ref),
  });
}
