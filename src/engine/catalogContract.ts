// Contrato do catálogo `/models` (IMPL-018 / R-07b:REC-7, DEC-7).
//
// O `/models` do OpenRouter não tem changelog nem política de versão. O que
// MUDA O FIO — quais parâmetros vão no corpo (`supported_parameters`), quais
// degraus de esforço o modelo aceita (`reasoning.supported_efforts`) e se o
// raciocínio pode ser desligado (`reasoning.mandatory`) — pode mudar sem aviso,
// e a primeira notícia seria um HTTP 400 no meio de uma run paga.
//
// Aqui fica a PROJEÇÃO contratual de um modelo (só os campos que importam, não
// o dump) e o DIFF entre uma baseline versionada e o catálogo atual. A baseline
// (`test/fixtures/catalog-contract.json`) lista os modelos VIGIADOS — os usados
// pelas runs padrão do produto —; o job diário de CI
// (`scripts/catalog-contract.ts`) confere o `/models` ao vivo contra ela e
// reprova quando um campo contratual de modelo vigiado muda. Aceitar a mudança
// grava o DIFF em `test/fixtures/catalog-drift/` (guarda-se o diff, não o dump).
//
// Módulo PURO (sem Node): recebe modelos já parseados por
// `validateModelsPayload` — então um campo malformado já chega aqui no estado
// fail-closed (ex.: allowlist inválida => sem raciocínio) e aparece como drift.

import { isKnownPrice } from './pricing.js';
import type { OpenRouterModel, RunConfig } from '../types.js';

export const CATALOG_CONTRACT_FORMAT = 'prompt-builder-catalog-contract@1' as const;
export const CATALOG_DRIFT_FORMAT = 'prompt-builder-catalog-drift@1' as const;

/**
 * Parâmetros de `supported_parameters` que o gateway consulta para montar o
 * corpo (`deterministicSampling`, `catalogDeniesReasoning`) ou que ele sempre
 * envia (`max_tokens`, `response_format` quando pedido). O resto da lista
 * (`top_k`, `logit_bias`, …) não muda o fio daqui e fica fora do contrato —
 * senão o CI reprovaria por ruído.
 */
export const WIRE_PARAMETERS = [
  'include_reasoning',
  'max_tokens',
  'reasoning',
  'reasoning_effort',
  'response_format',
  'seed',
  'temperature',
] as const;

const WIRE_SET = new Set<string>(WIRE_PARAMETERS);

/** Projeção contratual de UM modelo do catálogo. */
export interface ModelContract {
  /** Subconjunto de `supported_parameters` em `WIRE_PARAMETERS`, ordenado. `null` = lista ausente. */
  wireParameters: string[] | null;
  /** `reasoning.supported_efforts` como CONJUNTO (ordem não é garantida pelo catálogo). `null` = sem allowlist. */
  supportedEfforts: string[] | null;
  /** `reasoning.mandatory`. `null` = ausente (ou sem objeto `reasoning`). */
  mandatory: boolean | null;
  /** Informativo: degrau padrão (não muda o fio — `fitEffort` não o usa). */
  defaultEffort: string | null;
  /** Informativo: preço base conhecido ou desconhecido ("-1"/roteador). */
  price: 'known' | 'unknown';
}

export interface CatalogContract {
  format: typeof CATALOG_CONTRACT_FORMAT;
  /** id → contrato. As CHAVES são a lista de modelos vigiados. */
  models: Record<string, ModelContract>;
}

export type ContractField =
  | 'presence'
  | 'wireParameters'
  | 'supportedEfforts'
  | 'mandatory'
  | 'defaultEffort'
  | 'price';

/** Campos cuja mudança muda o que vai no fio (ou faz o modelo sumir): reprovam. */
const BREAKING_FIELDS: ReadonlySet<ContractField> = new Set([
  'presence',
  'wireParameters',
  'supportedEfforts',
  'mandatory',
]);

export interface ContractChange {
  modelId: string;
  field: ContractField;
  before: unknown;
  after: unknown;
  /** true = muda o fio (ou o modelo sumiu) — reprova o teste de contrato. */
  breaking: boolean;
}

export interface CatalogDrift {
  format: typeof CATALOG_DRIFT_FORMAT;
  changes: ContractChange[];
  /** Há ao menos uma mudança `breaking`. */
  breaking: boolean;
}

const ordenado = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/** Projeção contratual de um modelo já parseado. */
export function modelContract(m: OpenRouterModel): ModelContract {
  const r = m.reasoning;
  return {
    wireParameters: m.supportedParameters ? ordenado(m.supportedParameters.filter((p) => WIRE_SET.has(p))) : null,
    supportedEfforts: r?.supportedEfforts ? ordenado(r.supportedEfforts) : null,
    mandatory: typeof r?.mandatory === 'boolean' ? r.mandatory : null,
    defaultEffort: r?.defaultEffort ?? null,
    price: isKnownPrice(m.pricing.prompt) && isKnownPrice(m.pricing.completion) ? 'known' : 'unknown',
  };
}

/**
 * Baseline dos modelos vigiados. `missing` = ids pedidos que não estão no
 * catálogo (não entram na baseline: um id errado não pode virar contrato).
 */
export function buildCatalogContract(
  models: readonly OpenRouterModel[],
  watchIds: Iterable<string>,
): { contract: CatalogContract; missing: string[] } {
  const idx = new Map(models.map((m) => [m.id, m]));
  const entries: [string, ModelContract][] = [];
  const missing: string[] = [];
  for (const id of ordenado([...watchIds].filter(Boolean))) {
    const m = idx.get(id);
    if (m) entries.push([id, modelContract(m)]);
    else missing.push(id);
  }
  return { contract: { format: CATALOG_CONTRACT_FORMAT, models: Object.fromEntries(entries) }, missing };
}

const igual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Diff da baseline contra o catálogo atual — SÓ dos modelos vigiados (chaves
 * da baseline). Modelo vigiado que sumiu = `presence` (breaking).
 */
export function diffCatalogContract(
  baseline: CatalogContract,
  models: readonly OpenRouterModel[],
): CatalogDrift {
  const idx = new Map(models.map((m) => [m.id, m]));
  const changes: ContractChange[] = [];
  for (const id of Object.keys(baseline.models).sort()) {
    const antes = baseline.models[id];
    const m = idx.get(id);
    if (!m) {
      changes.push({ modelId: id, field: 'presence', before: 'present', after: 'missing', breaking: true });
      continue;
    }
    const agora = modelContract(m);
    for (const field of Object.keys(agora) as (keyof ModelContract)[]) {
      if (igual(antes[field], agora[field])) continue;
      changes.push({
        modelId: id,
        field,
        before: antes[field],
        after: agora[field],
        breaking: BREAKING_FIELDS.has(field),
      });
    }
  }
  return { format: CATALOG_DRIFT_FORMAT, changes, breaking: changes.some((c) => c.breaking) };
}

/** Todos os modelos que uma run chama (o que vale vigiar). */
export function runModelIds(config: RunConfig): string[] {
  const ids: (string | undefined)[] = [
    config.datagenModelId,
    config.optimizerModelId,
    config.referenceModelId,
    ...(config.judgeModelIds ?? []),
  ];
  if (config.mode === 'compare') {
    ids.push(...(config.competitorModelIds ?? []), ...(config.competitorConfigs ?? []).map((c) => c.modelId));
  } else {
    ids.push(config.contestantModelId);
  }
  return ordenado(ids.filter((x): x is string => typeof x === 'string' && x.trim() !== ''));
}

/** Lê/valida uma baseline do disco (JSON cru). Lança com mensagem clara se o formato não bate. */
export function parseCatalogContract(json: unknown): CatalogContract {
  const o = json as Partial<CatalogContract> | null;
  if (!o || o.format !== CATALOG_CONTRACT_FORMAT || !o.models || typeof o.models !== 'object') {
    throw new Error(`baseline do catálogo inválida: esperado format "${CATALOG_CONTRACT_FORMAT}" com "models"`);
  }
  for (const [id, c] of Object.entries(o.models)) {
    const ok =
      c &&
      (c.wireParameters === null || Array.isArray(c.wireParameters)) &&
      (c.supportedEfforts === null || Array.isArray(c.supportedEfforts)) &&
      (c.mandatory === null || typeof c.mandatory === 'boolean') &&
      (c.defaultEffort === null || typeof c.defaultEffort === 'string') &&
      (c.price === 'known' || c.price === 'unknown');
    if (!ok) throw new Error(`baseline do catálogo inválida: entrada "${id}" malformada`);
  }
  return o as CatalogContract;
}
