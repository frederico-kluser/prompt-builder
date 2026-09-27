// Núcleo PURO da biblioteca de cenários+gabaritos (F1 do PLANO-PARIDADE,
// item P0.1). Fonte única para os dois motores: o CLI/servidor persiste em
// disco (`src/library.ts`) e a SPA pode persistir em IndexedDB — a LÓGICA
// (shape, normalização, gabarito obrigatório, cobertura) mora aqui.
//
// Por que existe: sem dataset estável e curado não há evolução comparável
// entre sessões — o `minGain` compara contra o controle, mas o próprio dataset
// mudava de run para run. O item da biblioteca é o cenário ENRIQUECIDO do
// prompt-arena (`banks/*.bank.mjs`): tier, persona, critérios de sucesso,
// rationale, dimensões — mais o gabarito por item (`reference` textual OU
// `expected` = rótulo para veredito determinístico).
//
// ⚠️ PURO: sem node:fs, sem fetch. Persistência é problema de quem chama.

import { z } from 'zod';
import type { StageSpec } from '../types.js';
import { labelSetIssue, type ExpectedSpec } from './groundTruth.js';

// ----------------------------------------------------------------------------
// Tipos
// ----------------------------------------------------------------------------

/**
 * Tier curatorial do item (curriculum do prompt-arena):
 * - `mft`         happy path — o caso comum, maioria do banco;
 * - `invariance`  pares de invariância (variações que NÃO podem mudar a saída);
 * - `adversarial` tenta induzir o erro (prompt injection, premissa falsa);
 * - `edge`        fronteira do contrato (input vazio, idioma raro, limite).
 */
export type LibraryTier = 'mft' | 'invariance' | 'adversarial' | 'edge';

export const LIBRARY_TIERS: readonly LibraryTier[] = ['mft', 'invariance', 'adversarial', 'edge'];

/** Proveniência do item — curadoria humana, geração IA ou importação. */
export type LibraryOrigin = 'official' | 'ai' | 'manual' | 'import';

/**
 * Item da biblioteca: um cenário executável ENRIQUECIDO com metadados de
 * curadoria. Os campos de `StageSpec` (question/productContext/maxTokens/
 * rubric/reference) são o contrato com o pipeline; os demais alimentam
 * cobertura, curriculum e o painel "por que este cenário existe".
 */
export interface LibraryItem {
  /** Id estável DENTRO do perfil (ex.: "wf-001"). Chave de dedup do seed. */
  id: string;
  title: string;
  tier: LibraryTier;
  /** Quem pergunta (persona do usuário) — dá realismo ao cenário. */
  persona?: string;
  /** Contexto da situação (além do productContext). */
  context?: string;
  /** O que uma resposta precisa fazer para ser considerada correta. */
  successCriteria?: string[];
  /** Por que este cenário existe no banco (curadoria). */
  rationale?: string;
  /** Dimensões medidas (ex.: "extracao", "recusa", "pt-BR") — base da cobertura. */
  dimensionTags?: string[];
  // --- contrato executável (StageSpec) ---
  question: string;
  productContext: string;
  maxTokens: number;
  rubric?: string;
  /** Gabarito textual (kind 'reference': juiz pointwise + duelos). */
  reference?: string;
  /** Rótulo esperado (kind 'labels': veredito determinístico, sem juiz LLM). */
  expected?: ExpectedSpec;
  /** Todos os rótulos válidos (IMPL-003): obrigatório com `expected` curto. */
  labelSet?: string[];
  origin: LibraryOrigin;
  createdAt: string;
  updatedAt?: string;
  /**
   * Marcador de seed idempotente (ex.: 'prompt-builder:seed@1'). Item semeado
   * que já existe (mesmo id) NÃO é regravado — rodar `seed` 2× não duplica.
   */
  seed?: string;
}

/** Perfil = um banco de cenários (um alvo/prompt por treino). */
export interface LibraryProfile {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt?: string;
  /** Regras de geração IA deste perfil (F1.3) — grounding real do domínio. */
  scenarioRules?: ScenarioRules;
  /** Matriz de cobertura alvo (F1.5) — o datagen ganha alvo de preenchimento. */
  coverageTargets?: CoverageTargets;
}

/** Regras de geração de cenários POR PERFIL/PROMPT, com grounding (F1.3). */
export interface ScenarioRules {
  /** Template do system/user do gerador. Placeholders: {{context}}, {{fewShot}}, {{setupKeys}}, {{count}}, {{theme}}. */
  templates: { system: string; user?: string };
  /** Grounding real injetado nos templates (catálogo, exemplos, chaves de setup). */
  grounding?: { context?: string; fewShot?: string; setupKeys?: string[] };
  /** Cobertura alvo herdada quando o perfil não declara. */
  coverageTargets?: CoverageTargets;
}

/** Matriz de cobertura: quantos itens se quer por tier e por dimensão. */
export interface CoverageTargets {
  byTier?: Partial<Record<LibraryTier, number>>;
  byDimension?: Record<string, number>;
}

/** Relatório de cobertura/curriculum do banco (F1.5). */
export interface CoverageReport {
  total: number;
  byTier: Record<LibraryTier, number>;
  byDimension: Record<string, number>;
  /** Lacunas contra a matriz alvo (só quando há alvo declarado). */
  gaps: { kind: 'tier' | 'dimension'; key: string; have: number; target: number }[];
  /** Itens sem gabarito (nem `reference` nem `expected`) — recusados no evolve. */
  withoutGabarito: string[];
}

// ----------------------------------------------------------------------------
// Validação/normalização (nunca lança — {ok, error} em PT-BR, como o pacote)
// ----------------------------------------------------------------------------

const expectedSchema: z.ZodType<ExpectedSpec> = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
]);

const itemSchema = z.object({
  id: z.string('id obrigatório').min(1, 'id obrigatório'),
  title: z.string('title obrigatório').min(1, 'title obrigatório'),
  tier: z.enum(LIBRARY_TIERS as unknown as [LibraryTier, ...LibraryTier[]], {
    error: `tier deve ser um de: ${LIBRARY_TIERS.join(', ')}`,
  }),
  persona: z.string().optional(),
  context: z.string().optional(),
  successCriteria: z.array(z.string()).optional(),
  rationale: z.string().optional(),
  dimensionTags: z.array(z.string()).optional(),
  question: z.string('question obrigatória').min(1, 'question obrigatória'),
  productContext: z.string('productContext obrigatório').min(1, 'productContext obrigatório'),
  maxTokens: z
    .number('maxTokens deve ser número inteiro')
    .int('maxTokens deve ser número inteiro')
    .positive('maxTokens deve ser maior que zero')
    .max(16000, 'maxTokens não pode passar de 16000'),
  rubric: z.string().optional(),
  reference: z.string().optional(),
  expected: expectedSchema.optional(),
  labelSet: z.array(z.string().min(1, 'rótulo vazio em labelSet')).min(1, 'labelSet não pode ser vazio').optional(),
  origin: z.enum(['official', 'ai', 'manual', 'import'], {
    error: "origin deve ser 'official', 'ai', 'manual' ou 'import'",
  }),
  createdAt: z.string('createdAt obrigatório').min(1, 'createdAt obrigatório'),
  updatedAt: z.string().optional(),
  seed: z.string().optional(),
});

/**
 * Valida e normaliza um item cru (JSON importado/gerado). Nunca lança:
 * problema vira `{ ok: false, error }` em PT-BR citando o campo.
 */
export function normalizeLibraryItem(
  raw: unknown,
): { ok: true; item: LibraryItem } | { ok: false; error: string } {
  const result = itemSchema.safeParse(raw);
  if (!result.success) {
    const partes = result.error.issues
      .slice(0, 3)
      .map((iss) => {
        const caminho = iss.path.map(String).join('.');
        return caminho ? `${caminho}: ${iss.message}` : iss.message;
      })
      .join('; ');
    return { ok: false, error: partes || 'Item inválido.' };
  }
  const item = result.data as LibraryItem;
  // IMPL-003: rótulo curto sem labelSet é recusado já na entrada da biblioteca
  // (itens antigos no disco não passam por aqui — `labelIssue` os aponta no
  // verify e o evolve os recusa).
  const rotulo = labelSetIssue(item);
  if (rotulo) return { ok: false, error: `labelSet: ${rotulo}` };
  // Normalização leve: strings com bordas aparadas; listas sem vazios.
  item.question = item.question.trim();
  item.productContext = item.productContext.trim();
  if (item.reference !== undefined) item.reference = item.reference.trim();
  item.dimensionTags = item.dimensionTags?.map((t) => t.trim()).filter(Boolean);
  item.successCriteria = item.successCriteria?.map((s) => s.trim()).filter(Boolean);
  return { ok: true, item };
}

// ----------------------------------------------------------------------------
// Regras do domínio
// ----------------------------------------------------------------------------**

/**
 * Um item só pode ir a um evolve (treino com julgamento por referência) se tiver
 * gabarito: texto de referência OU rótulo esperado. É a paridade com o 409 do
 * prompt-arena (`/api/evolve` recusa item sem gabarito) — sem isso a etapa cai
 * no juiz listwise e a comparação entre sessões perde o âncora.
 */
export function hasGabarito(item: Pick<LibraryItem, 'reference' | 'expected'>): boolean {
  return Boolean(item.reference?.trim()) || item.expected !== undefined;
}

/**
 * Problema de rótulo do item (IMPL-003) — rótulo curto sem `labelSet`, ou
 * rótulo fora do `labelSet`. Itens gravados antes da regra não passaram pela
 * validação de entrada: o `verify` e o evolve os recusam por aqui.
 */
export function labelIssue(item: Pick<LibraryItem, 'expected' | 'labelSet'>): string | null {
  return labelSetIssue(item);
}

/** Converte o item enriquecido no `StageSpec` executável do pipeline. */
export function toStageSpec(item: LibraryItem): StageSpec & { id: string } {
  return {
    id: item.id,
    // Metadados de curriculo (F4.1): viram a "fatia" da selecao Pareto.
    tier: item.tier,
    dimensionTags: item.dimensionTags,
    question: item.question,
    productContext: item.productContext,
    maxTokens: item.maxTokens,
    rubric: item.rubric ?? '',
    reference: item.reference,
    expected: item.expected,
    ...(item.labelSet !== undefined ? { labelSet: item.labelSet } : {}),
    origin: item.origin === 'ai' ? 'ai' : 'import',
  };
}

/**
 * Invariância de par (tier `invariance`): itens do MESMO grupo devem ter o
 * mesmo `reference`/`expected` — a saída não pode mudar quando só a superfície
 * da pergunta muda. Agrupamento por `dimensionTags[0]` prefixada de `inv:`.
 */
export function invariancePairs(items: LibraryItem[]): { key: string; itemIds: string[] }[] {
  const grupos = new Map<string, string[]>();
  for (const item of items) {
    const key = (item.dimensionTags ?? []).find((t) => t.startsWith('inv:'));
    if (!key) continue;
    const lista = grupos.get(key) ?? [];
    lista.push(item.id);
    grupos.set(key, lista);
  }
  return [...grupos.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .map(([key, itemIds]) => ({ key, itemIds }));
}

/** Relatório de cobertura: contagens por tier/dimensão + lacunas vs alvo + itens sem gabarito. */
export function coverageReport(
  items: LibraryItem[],
  targets?: CoverageTargets,
): CoverageReport {
  const byTier: Record<LibraryTier, number> = { mft: 0, invariance: 0, adversarial: 0, edge: 0 };
  const byDimension: Record<string, number> = {};
  const withoutGabarito: string[] = [];
  for (const item of items) {
    byTier[item.tier] = (byTier[item.tier] ?? 0) + 1;
    for (const tag of item.dimensionTags ?? []) {
      byDimension[tag] = (byDimension[tag] ?? 0) + 1;
    }
    if (!hasGabarito(item)) withoutGabarito.push(item.id);
  }

  const gaps: CoverageReport['gaps'] = [];
  for (const [tier, alvo] of Object.entries(targets?.byTier ?? {})) {
    if (typeof alvo !== 'number') continue;
    const have = byTier[tier as LibraryTier] ?? 0;
    if (have < alvo) gaps.push({ kind: 'tier', key: tier, have, target: alvo });
  }
  for (const [dim, alvo] of Object.entries(targets?.byDimension ?? {})) {
    const have = byDimension[dim] ?? 0;
    if (have < alvo) gaps.push({ kind: 'dimension', key: dim, have, target: alvo });
  }

  return { total: items.length, byTier, byDimension, gaps, withoutGabarito };
}

// ----------------------------------------------------------------------------
// Seed idempotente
// ----------------------------------------------------------------------------

export interface SeedResult {
  added: LibraryItem[];
  /** Ids já existentes no perfil — pulados (seed NÃO duplica nem sobrescreve). */
  skipped: string[];
}

/**
 * Mescla itens semeados num banco existente pela IDENTIDADE (id): o que já
 * existe é pulado — rodar `pb library seed` duas vezes é idempotente. Itens
 * sem id recebem `gen-<hash>` estável derivado da question (mesma pergunta ⇒
 * mesmo id ⇒ idempotência também para geração IA).
 */
export function mergeSeedItems(existing: LibraryItem[], incoming: LibraryItem[]): SeedResult {
  const presentes = new Set(existing.map((i) => i.id));
  const added: LibraryItem[] = [];
  const skipped: string[] = [];
  for (const item of incoming) {
    if (presentes.has(item.id)) {
      skipped.push(item.id);
      continue;
    }
    presentes.add(item.id);
    added.push(item);
  }
  return { added, skipped };
}

/** Id estável derivado do conteúdo (para itens gerados sem id manual). */
export function stableItemId(question: string): string {
  // FNV-1a 32-bit (mesma família de hash do shuffle cego) → hex curto.
  let h = 2166136261;
  for (const ch of question) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return `gen-${(h >>> 0).toString(16).padStart(8, '0')}`;
}
