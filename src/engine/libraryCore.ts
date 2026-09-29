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
import { contentHash as jcsSha256 } from './hash.js';

// ----------------------------------------------------------------------------
// Tipos
// ----------------------------------------------------------------------------

/**
 * Tier curatorial do item (curriculum do prompt-arena):
 * - `mft`         happy path — o caso comum, maioria do banco;
 * - `invariance`  pares de invariância (variações que NÃO podem mudar a saída);
 * - `adversarial` tenta induzir o erro (prompt injection, premissa falsa);
 * - `edge`        fronteira do contrato (input vazio, idioma raro, limite);
 * - `benign-twin` gêmeo LEGÍTIMO de um ataque (IMPL-068): pedido lícito que o
 *                 assistente DEVE atender — recusá-lo é recusa excessiva.
 */
export type LibraryTier = 'mft' | 'invariance' | 'adversarial' | 'edge' | 'benign-twin';

export const LIBRARY_TIERS: readonly LibraryTier[] = ['mft', 'invariance', 'adversarial', 'edge', 'benign-twin'];

/** Tier válido da biblioteca? (o datagen devolve `string` livre). */
export function isLibraryTier(v: unknown): v is LibraryTier {
  return typeof v === 'string' && (LIBRARY_TIERS as readonly string[]).includes(v);
}

/** Proveniência do item — curadoria humana, geração IA ou importação. */
export type LibraryOrigin = 'official' | 'ai' | 'manual' | 'import';

// ----------------------------------------------------------------------------
// Curadoria por item (IMPL-087, R-22:REC-2/DEC-3)
// ----------------------------------------------------------------------------

/**
 * Estado de curadoria do item — a aprovação é amarrada ao `contentHash`:
 * editar um item `aprovado` o leva de volta a `gerado` (invalidação por hash,
 * não por intenção).
 */
export type LibraryItemState = 'gerado' | 'em_revisao' | 'aprovado' | 'rejeitado' | 'ajustar';

export const LIBRARY_ITEM_STATES: readonly LibraryItemState[] = [
  'gerado',
  'em_revisao',
  'aprovado',
  'rejeitado',
  'ajustar',
];

/**
 * Transições legais do ciclo: `gerado` é o estado inicial/de repente; `ajustar`
 * marca item que precisa de ajuste (inclusive conflito de mescla); `rejeitado`
 * exige `rejectReason`.
 */
export const LIBRARY_STATE_TRANSITIONS: Readonly<Record<LibraryItemState, readonly LibraryItemState[]>> = {
  gerado: ['em_revisao', 'aprovado', 'rejeitado', 'ajustar'],
  em_revisao: ['aprovado', 'rejeitado', 'ajustar', 'gerado'],
  aprovado: ['gerado', 'ajustar', 'rejeitado'],
  rejeitado: ['gerado', 'em_revisao', 'ajustar'],
  ajustar: ['gerado', 'em_revisao', 'aprovado', 'rejeitado'],
};

/** Proveniência POR CAMPO (o `origin` por item mente após a edição). */
export type FieldOrigin = 'ai' | 'humano' | 'editado';

export const FIELD_ORIGINS: readonly FieldOrigin[] = ['ai', 'humano', 'editado'];

export interface FieldProvenance {
  origem: FieldOrigin;
  /** Modelo que gerou o campo (quando `origem: 'ai'`). */
  model?: string;
  /** Prompt/regra que gerou o campo (quando `origem: 'ai'`). */
  prompt?: string;
}

/** Motivo de rejeição — enum + nota livre (a recusa tem que ser legível). */
export type RejectKind = 'fora_de_escopo' | 'duplicado' | 'gabarito_errado' | 'ambiguo' | 'outro';

export const REJECT_KINDS: readonly RejectKind[] = [
  'fora_de_escopo',
  'duplicado',
  'gabarito_errado',
  'ambiguo',
  'outro',
];

export interface RejectReason {
  kind: RejectKind;
  note?: string;
}

/** Quem gerou o item (trocar o modelo = conteúdo novo = re-aprovação). */
export interface ItemGenerator {
  modelId: string;
  temperature?: number;
  seed?: number;
  generatedAt: string;
}

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
  // --- metadados do datagen v2 (IMPL-064/056/068) — antes o zod os stripava ---
  /** Estimativa de dificuldade 1-5 do gerador: SINAL de curadoria, nunca rótulo. */
  difficultyEstimate?: number;
  /** Grupo de invariância (itens cuja saída esperada não pode mudar entre si). */
  invarianceGroup?: string;
  /** Idioma do cenário (IMPL-056): ausente = pt-BR (produto monolíngue). */
  language?: string;
  /** Categoria adversarial (uma das 6 mínimas do IMPL-068). */
  adversarialCategory?: string;
  /** Rótulo de turno ('single-turn' = ASR@1, limite inferior do ataque real). */
  turnLabel?: string;
  /** SHA-256 do system prompt-base que condicionou a geração adversarial. */
  basePromptHash?: string;
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
  // --- curadoria (IMPL-087, R-22:REC-2) — opcional p/ records antigos ---
  /** Estado de curadoria (ausente = nunca passou pelo fluxo novo = não aprovado). */
  state?: LibraryItemState;
  /** Quem revisou (última revisão válida para o `contentHash` atual). */
  reviewer?: string;
  /** Quando foi revisado (ISO-8601). */
  reviewedAt?: string;
  /** Motivo quando `state: 'rejeitado'` (enum + nota). */
  rejectReason?: RejectReason;
  /** Proveniência POR CAMPO: campo → {origem: ai|humano|editado, model?, prompt?}. */
  provenance?: Record<string, FieldProvenance>;
  /** Identidade do conteúdo: `sha256:<hex>` do JCS (RFC 8785) — a aprovação amarra-se a ele. */
  contentHash?: string;
  /** `contentHash` da versão anterior (nova versão = nó novo com parentHash). */
  parentHash?: string;
  /** Quem gerou o item (modelo/temperatura/seed/data). */
  generator?: ItemGenerator;
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
  // Sinal de curadoria (nunca rótulo): fora de 1..5 é CLAMPADO na normalização,
  // não derruba o item — mesma política do datagen (`normalizeDatagenStage`).
  difficultyEstimate: z.number('difficultyEstimate deve ser número').optional(),
  invarianceGroup: z.string().optional(),
  language: z.string().optional(),
  adversarialCategory: z.string().optional(),
  turnLabel: z.string().optional(),
  basePromptHash: z.string().optional(),
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
  // --- curadoria (IMPL-087): aceita e PRESERVA os campos novos ---
  state: z.enum(LIBRARY_ITEM_STATES as unknown as [LibraryItemState, ...LibraryItemState[]]).optional(),
  reviewer: z.string().optional(),
  reviewedAt: z.string().optional(),
  rejectReason: z
    .object({
      kind: z.enum(REJECT_KINDS as unknown as [RejectKind, ...RejectKind[]], {
        error: `rejectReason.kind deve ser um de: ${REJECT_KINDS.join(', ')}`,
      }),
      note: z.string().optional(),
    })
    .optional(),
  provenance: z
    .record(
      z.string(),
      z.object({
        origem: z.enum(FIELD_ORIGINS as unknown as [FieldOrigin, ...FieldOrigin[]], {
          error: `provenance.origem deve ser um de: ${FIELD_ORIGINS.join(', ')}`,
        }),
        model: z.string().optional(),
        prompt: z.string().optional(),
      }),
    )
    .optional(),
  contentHash: z.string().optional(),
  parentHash: z.string().optional(),
  generator: z
    .object({
      modelId: z.string('generator.modelId obrigatório'),
      temperature: z.number().optional(),
      seed: z.number().optional(),
      generatedAt: z.string('generator.generatedAt obrigatório'),
    })
    .optional(),
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
  // Só quando presentes: chave com valor `undefined` sujaria o round-trip
  // (IMPL-089 compara o item relido com o original por igualdade estrita).
  if (item.dimensionTags !== undefined) item.dimensionTags = item.dimensionTags.map((t) => t.trim()).filter(Boolean);
  if (item.successCriteria !== undefined) {
    item.successCriteria = item.successCriteria.map((s) => s.trim()).filter(Boolean);
  }
  if (item.difficultyEstimate !== undefined) {
    item.difficultyEstimate = Math.min(5, Math.max(1, Math.round(item.difficultyEstimate)));
  }
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

/**
 * IMPL-065 — a spec carrega aprovação HUMANA vigente? (item da biblioteca
 * `aprovado` com o `contentHash` do conteúdo atual — ver `toStageSpec`). É a
 * régua única de "gente verificou pergunta + gabarito" que a âncora do treino
 * (`trainingPolicy`) e as demos reais (`techniques`) aceitam mesmo quando o
 * item nasceu de IA (`origin: 'ai'`).
 */
export function stageHasHumanApproval(spec: Pick<StageSpec, 'humanApproval'> | undefined): boolean {
  const a = spec?.humanApproval;
  return Boolean(a && typeof a.contentHash === 'string' && a.contentHash.trim());
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
    // IMPL-065: a curadoria chega à run. Só a aprovação VIGENTE (estado
    // `aprovado` + hash do conteúdo atual — `isApproved`): antes o estado era
    // descartado aqui e um item de IA aprovado por gente nunca contava como
    // âncora humana. Aprovação velha (conteúdo editado depois) não viaja.
    // Mesma régua do `curationStatus` (k de n curados = âncoras aprovadas).
    // QUEM aprovou fica no item (o hash liga os dois): nome/e-mail do revisor
    // em config/record da run cairia no pré-voo LGPD e vazaria para exports.
    ...(isApproved(item)
      ? {
          humanApproval: {
            ...(item.reviewedAt !== undefined ? { reviewedAt: item.reviewedAt } : {}),
            contentHash: item.contentHash!,
          },
        }
      : {}),
    // Metadados do datagen v2 (IMPL-064/056/068): chegam à run para o relatório
    // de idioma (`languageWarnings`) e de cobertura adversarial do record.
    ...(item.persona !== undefined ? { persona: item.persona } : {}),
    ...(item.difficultyEstimate !== undefined ? { difficultyEstimate: item.difficultyEstimate } : {}),
    ...(item.invarianceGroup !== undefined ? { invarianceGroup: item.invarianceGroup } : {}),
    ...(item.language !== undefined ? { language: item.language } : {}),
    ...(item.adversarialCategory !== undefined ? { adversarialCategory: item.adversarialCategory } : {}),
    ...(item.turnLabel !== undefined ? { turnLabel: item.turnLabel } : {}),
    ...(item.basePromptHash !== undefined ? { basePromptHash: item.basePromptHash } : {}),
  };
}

/**
 * Converte um cenário do datagen v2 (+ gabarito) no item CRU da biblioteca (IMPL-064):
 * TODO metadado que `normalizeDatagenStage` preservou chega ao item — antes o
 * `library seed --generate` carimbava `tier: 'mft'` e descartava dimensionTags/
 * persona/difficultyEstimate/invarianceGroup, e o banco gerado não era
 * representativo do fluxo da run. Tier fora de `LIBRARY_TIERS` cai em 'mft'
 * (a matriz do banco é fechada); o resto passa verbatim.
 *
 * Devolve o objeto CRU: quem chama valida com `normalizeLibraryItem` (a
 * validação única do item) — nenhum item sai daqui sem passar pelo schema.
 */
export function libraryItemFromStage(
  st: StageSpec,
  opts: { now: string; seed?: string; id?: string; titleMax?: number },
): Record<string, unknown> {
  return {
    id: opts.id ?? stableItemId(st.question),
    title: st.question.slice(0, opts.titleMax ?? 80),
    tier: isLibraryTier(st.tier) ? st.tier : 'mft',
    ...(st.dimensionTags?.length ? { dimensionTags: [...st.dimensionTags] } : {}),
    ...(st.persona !== undefined ? { persona: st.persona } : {}),
    ...(st.difficultyEstimate !== undefined ? { difficultyEstimate: st.difficultyEstimate } : {}),
    ...(st.invarianceGroup !== undefined ? { invarianceGroup: st.invarianceGroup } : {}),
    ...(st.language !== undefined ? { language: st.language } : {}),
    ...(st.adversarialCategory !== undefined ? { adversarialCategory: st.adversarialCategory } : {}),
    ...(st.turnLabel !== undefined ? { turnLabel: st.turnLabel } : {}),
    ...(st.basePromptHash !== undefined ? { basePromptHash: st.basePromptHash } : {}),
    question: st.question,
    productContext: st.productContext,
    maxTokens: st.maxTokens,
    ...(st.rubric !== undefined ? { rubric: st.rubric } : {}),
    ...(st.reference !== undefined ? { reference: st.reference } : {}),
    origin: 'ai',
    createdAt: opts.now,
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
  };
}

/**
 * Invariância de par (tier `invariance`): itens do MESMO grupo devem ter o
 * mesmo `reference`/`expected` — a saída não pode mudar quando só a superfície
 * da pergunta muda. Agrupamento pelo `invarianceGroup` do item (datagen v2,
 * IMPL-064 — normalizado para o prefixo `inv:`) ou, na falta dele, pela
 * primeira `dimensionTags` prefixada de `inv:` (curadoria manual).
 */
export function invariancePairs(items: LibraryItem[]): { key: string; itemIds: string[] }[] {
  const grupos = new Map<string, string[]>();
  for (const item of items) {
    const grupo = item.invarianceGroup?.trim();
    const key = grupo
      ? grupo.startsWith('inv:')
        ? grupo
        : `inv:${grupo}`
      : (item.dimensionTags ?? []).find((t) => t.startsWith('inv:'));
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
  const byTier: Record<LibraryTier, number> = { mft: 0, invariance: 0, adversarial: 0, edge: 0, 'benign-twin': 0 };
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
// Curadoria: hash de conteúdo, edição e revisão (IMPL-087, R-22:REC-2)
// ----------------------------------------------------------------------------

/**
 * Campos de CONTEÚDO do item — os únicos que entram no `contentHash`. Os
 * metadados de curadoria (state/reviewer/provenance/hash/generator) ficam DE
 * FORA por definição: senão revisar o item mudaria o hash que a revisão amarra.
 */
export const ITEM_CONTENT_FIELDS = [
  'title',
  'tier',
  'persona',
  'context',
  'successCriteria',
  'rationale',
  'dimensionTags',
  'question',
  'productContext',
  'maxTokens',
  'rubric',
  'reference',
  'expected',
  'labelSet',
  // Datagen v2 (IMPL-064/056/068): definem O QUE o item testa — mudar a
  // categoria, o idioma ou o prompt-base condicionador é conteúdo novo.
  // `difficultyEstimate` fica DE FORA: é sinal de curadoria, não conteúdo.
  'invarianceGroup',
  'language',
  'adversarialCategory',
  'turnLabel',
  'basePromptHash',
] as const;

/** O subconjunto de CONTEÚDO do item (o que o hash identifica). */
export function itemContent(item: LibraryItem): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const campo of ITEM_CONTENT_FIELDS) {
    const v = (item as unknown as Record<string, unknown>)[campo];
    if (v !== undefined) out[campo] = v;
  }
  return out;
}

/**
 * Identidade do conteúdo: `sha256:<hex>` do JSON canônico (JCS, RFC 8785) —
 * mesma fórmula Node × navegador (a implementação é fonte única em `hash.ts`).
 */
export function computeContentHash(item: LibraryItem): string {
  return jcsSha256(itemContent(item));
}

/** Campos de conteúdo cujo valor mudou entre `before` e `after`. */
export function changedContentFields(
  before: Partial<LibraryItem>,
  after: Partial<LibraryItem>,
): string[] {
  const antes = before as unknown as Record<string, unknown>;
  const depois = after as unknown as Record<string, unknown>;
  return ITEM_CONTENT_FIELDS.filter(
    (c) => depois[c] !== undefined && depois[c] !== antes[c],
  ) as string[];
}

export interface ItemEditOptions {
  /** Origem dos campos alterados (padrão `editado` — alguém mexeu na mão). */
  origem?: FieldOrigin;
  model?: string;
  prompt?: string;
  /** Data da edição (ISO-8601) — injetável nos testes. */
  now?: string;
}

/**
 * Edição de item (IMPL-087): transiciona `aprovado` → `gerado` por INVALIDAÇÃO
 * DE `contentHash` (editou o conteúdo, a aprovação antiga não cobre mais) e
 * registra a nova versão como nó com `parentHash` + proveniência por campo.
 */
export function applyItemEdit(
  item: LibraryItem,
  patch: Partial<LibraryItem>,
  opts: ItemEditOptions = {},
): LibraryItem {
  const antes = computeContentHash(item);
  const proximo: LibraryItem = { ...item, ...patch };
  const agora = computeContentHash(proximo);
  proximo.updatedAt = opts.now ?? new Date().toISOString();

  const alterados = changedContentFields(item, patch);
  if (alterados.length > 0) {
    const prov: Record<string, FieldProvenance> = { ...(proximo.provenance ?? {}) };
    for (const campo of alterados) {
      prov[campo] = {
        origem: opts.origem ?? 'editado',
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
      };
    }
    proximo.provenance = prov;
  }

  if (agora !== antes) {
    // Conteúdo mudou: nova versão = nó novo com parentHash; a revisão do
    // conteúdo antigo (aprovação OU rejeição) fica sem efeito.
    proximo.parentHash = antes;
    proximo.contentHash = agora;
    if (item.state === 'aprovado' || item.state === 'rejeitado' || item.state === 'em_revisao') {
      proximo.state = 'gerado';
      delete proximo.reviewer;
      delete proximo.reviewedAt;
      delete proximo.rejectReason;
    }
  } else {
    proximo.contentHash = item.contentHash ?? antes;
  }
  return proximo;
}

/** Marca a proveniência dos campos de conteúdo indicados (e não mexe no resto). */
export function stampProvenance(
  item: LibraryItem,
  fields: readonly string[],
  p: FieldProvenance,
): LibraryItem {
  const prov: Record<string, FieldProvenance> = { ...(item.provenance ?? {}) };
  for (const campo of fields) {
    if ((item as unknown as Record<string, unknown>)[campo] === undefined) continue;
    prov[campo] = { ...p };
  }
  return { ...item, provenance: prov };
}

/**
 * Item acabou de ser GERADO por um modelo: proveniência `ai` em todo campo de
 * conteúdo sem proveniência explícita + registro de `generator` (trocar o
 * modelo depois = conteúdo novo = re-aprovação).
 */
export function stampGeneration(
  item: LibraryItem,
  generator: ItemGenerator,
  opts: { now?: string } = {},
): LibraryItem {
  const prov: Record<string, FieldProvenance> = { ...(item.provenance ?? {}) };
  for (const campo of ITEM_CONTENT_FIELDS) {
    if ((item as unknown as Record<string, unknown>)[campo] === undefined) continue;
    if (prov[campo]) continue; // proveniência explícita vence
    prov[campo] = { origem: 'ai', model: generator.modelId };
  }
  return {
    ...item,
    generator,
    provenance: prov,
    state: item.state ?? 'gerado',
    contentHash: item.contentHash ?? computeContentHash(item),
  };
}

/** Transição de estado legal? (null = ok; senão, o problema em PT-BR). */
export function transitionIssue(
  from: LibraryItemState | undefined,
  to: LibraryItemState,
): string | null {
  if (!LIBRARY_ITEM_STATES.includes(to)) return `estado desconhecido: ${to}`;
  if (from === undefined || from === to) return null;
  const legais = LIBRARY_STATE_TRANSITIONS[from] ?? [];
  if (!legais.includes(to)) return `transição inválida: ${from} → ${to}`;
  return null;
}

export interface ItemReviewInput {
  /** Estado resultante da revisão (ex.: 'aprovado' | 'rejeitado' | 'ajustar'). */
  state: LibraryItemState;
  reviewer: string;
  /** Obrigatório para 'rejeitado' — a recusa tem que ser legível. */
  rejectReason?: RejectReason;
  /** Data da revisão (ISO-8601) — injetável nos testes. */
  now?: string;
}

/**
 * Registra uma revisão. Aprovação/rejeição amarram-se ao CONTEÚDO atual
 * (`contentHash` gravado = hash do conteúdo na hora da revisão). Lança em uso
 * inválido (transição ilegal, `rejeitado` sem `rejectReason`) — o chamador
 * (CLI/MCP) traduz em recusa, nunca em registro mudo.
 */
export function markItemReviewed(item: LibraryItem, review: ItemReviewInput): LibraryItem {
  const problema = transitionIssue(item.state, review.state);
  if (problema) throw new Error(problema);
  if (review.state === 'rejeitado' && !review.rejectReason) {
    throw new Error('rejectReason é obrigatório para rejeitar um item (kind enum + note).');
  }
  return {
    ...item,
    state: review.state,
    reviewer: review.reviewer,
    reviewedAt: review.now ?? new Date().toISOString(),
    contentHash: computeContentHash(item),
    ...(review.rejectReason ? { rejectReason: review.rejectReason } : {}),
  };
}

/** Um pedido de revisão em lote: os ids e o estado que eles passam a ter. */
export interface ItemReviewRequest {
  ids: readonly string[];
  state: LibraryItemState;
  /** Obrigatório com `state: 'rejeitado'`. */
  rejectReason?: RejectReason;
}

/**
 * Problema de um pedido de revisão. `kind` separa USO (id que não existe, id
 * pedido duas vezes, transição ilegal — exit 2 no CLI) de CONTEÚDO (aprovar
 * item sem gabarito ou com rótulo sem labelSet — exit 3, a mesma régua do
 * `library verify`).
 */
export interface ItemReviewIssue {
  id: string;
  kind: 'not_found' | 'duplicate' | 'transition' | 'no_gabarito' | 'label_set';
  error: string;
}

export interface ItemReviewPlan {
  /** As versões revisadas (só dos ids pedidos), na ordem do pedido. */
  items: LibraryItem[];
  changes: { id: string; from: LibraryItemState | 'sem_estado'; to: LibraryItemState; contentHash: string }[];
  issues: ItemReviewIssue[];
}

/**
 * `library review` (IMPL-090/IMPL-087, left#7) — planeja uma revisão em lote
 * SEM gravar nada: quem chama só persiste quando `issues` vem vazio (tudo ou
 * nada). Aprovar certifica pergunta + GABARITO, então item sem gabarito (ou
 * com rótulo curto sem labelSet) não pode ser aprovado; rejeitar exige motivo;
 * a transição segue `LIBRARY_STATE_TRANSITIONS`.
 */
export function planItemReviews(
  existing: readonly LibraryItem[],
  requests: readonly ItemReviewRequest[],
  review: { reviewer: string; now?: string },
): ItemReviewPlan {
  const porId = new Map(existing.map((i) => [i.id, i]));
  const vistos = new Set<string>();
  const items: LibraryItem[] = [];
  const changes: ItemReviewPlan['changes'] = [];
  const issues: ItemReviewIssue[] = [];
  for (const req of requests) {
    for (const id of req.ids) {
      if (vistos.has(id)) {
        issues.push({ id, kind: 'duplicate', error: `item "${id}" pedido em mais de uma ação` });
        continue;
      }
      vistos.add(id);
      const item = porId.get(id);
      if (!item) {
        issues.push({ id, kind: 'not_found', error: `item "${id}" não existe no perfil` });
        continue;
      }
      if (req.state === 'aprovado') {
        if (!hasGabarito(item)) {
          issues.push({ id, kind: 'no_gabarito', error: 'sem gabarito (reference ou expected): nada a aprovar' });
          continue;
        }
        const rotulo = labelIssue(item);
        if (rotulo) {
          issues.push({ id, kind: 'label_set', error: rotulo });
          continue;
        }
      }
      try {
        const revisado = markItemReviewed(item, {
          state: req.state,
          reviewer: review.reviewer,
          ...(req.rejectReason ? { rejectReason: req.rejectReason } : {}),
          ...(review.now !== undefined ? { now: review.now } : {}),
        });
        // Motivo de rejeição de uma revisão ANTERIOR não sobrevive a outro estado.
        if (req.state !== 'rejeitado') delete revisado.rejectReason;
        items.push(revisado);
        changes.push({ id, from: item.state ?? 'sem_estado', to: req.state, contentHash: revisado.contentHash! });
      } catch (err) {
        issues.push({ id, kind: 'transition', error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { items, changes, issues };
}

/**
 * Motivo de um item NÃO contar como curado (fila de revisão): sem estado,
 * estado ≠ aprovado, ou aprovação velha (conteúdo mudou depois). `null` =
 * aprovado de verdade.
 */
export function curationIssue(item: LibraryItem): string | null {
  if (item.state === undefined) return 'sem estado (nunca revisado)';
  if (item.state !== 'aprovado') return `estado ${item.state}`;
  return contentHashIssue(item);
}

/**
 * O `contentHash` gravado ainda é o do conteúdo? Fora do fluxo (edição direta
 * no JSON) o hash não mente: a aprovação fica velha na hora.
 */
export function contentHashIssue(item: LibraryItem): string | null {
  if (item.contentHash === undefined) return 'sem contentHash (item anterior ao fluxo de curadoria)';
  if (item.contentHash !== computeContentHash(item)) {
    return 'contentHash não bate com o conteúdo atual (editado depois do registro)';
  }
  return null;
}

/** Aprovado de verdade = estado `aprovado` E hash do conteúdo ainda é o aprovado. */
export function isApproved(item: LibraryItem): boolean {
  return item.state === 'aprovado' && contentHashIssue(item) === null;
}

export type ItemMerge =
  | { kind: 'novo' | 'fast-forward'; item: LibraryItem }
  | { kind: 'identico'; item: LibraryItem }
  | { kind: 'conflito'; local: LibraryItem; incoming: LibraryItem; item: LibraryItem };

/**
 * Mescla por IDENTIDADE de conteúdo (R-22:DEC-2): `incoming.parentHash` igual ao
 * `contentHash` local é fast-forward; dois ramos a partir do mesmo pai são
 * CONFLITO explícito — mantém as duas versões e marca `ajustar`. Nunca
 * "último a escrever vence" (isso apagaria aprovação humana em silêncio).
 */
export function mergeItemVersion(
  local: LibraryItem | undefined,
  incoming: LibraryItem,
): ItemMerge {
  if (!local) return { kind: 'novo', item: incoming };
  const localHash = local.contentHash ?? computeContentHash(local);
  const incomingHash = incoming.contentHash ?? computeContentHash(incoming);
  if (incomingHash === localHash) return { kind: 'identico', item: local };
  if (incoming.parentHash === localHash) return { kind: 'fast-forward', item: incoming };
  if (local.parentHash === incomingHash) return { kind: 'fast-forward', item: local };
  return {
    kind: 'conflito',
    local,
    incoming,
    item: { ...incoming, state: 'ajustar', contentHash: incomingHash, parentHash: localHash },
  };
}

/**
 * Normalização que PRESERVA campo desconhecido (IMPL-089): o zod do item
 * remove chaves fora do schema em silêncio — aqui elas voltam para o item (ida
 * e volta = identidade) e o que efetivamente se perdeu é declarado em
 * `lostFields` (régua: 100% preservado OU declarado perdido).
 */
export function normalizeLibraryItemPreserving(
  raw: unknown,
):
  | { ok: true; item: LibraryItem & Record<string, unknown>; lostFields: string[] }
  | { ok: false; error: string } {
  const r = normalizeLibraryItem(raw);
  if (!r.ok) return r;
  const lostFields: string[] = [];
  const item = restaurarDesconhecidos(raw, r.item, '', lostFields) as LibraryItem & Record<string, unknown>;
  return { ok: true, item, lostFields };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Devolve ao objeto normalizado TODA chave que o zod stripou — inclusive em
 * objetos aninhados (`rejectReason`, `generator`, cada entrada de
 * `provenance`): o object() do zod descarta chave desconhecida em qualquer
 * nível, e a régua do IMPL-089 vale para todos. Só `undefined` (que o JSON não
 * representa) vira perda declarada, pelo caminho pontuado (`generator.x`).
 */
function restaurarDesconhecidos(raw: unknown, parsed: unknown, prefixo: string, perdidos: string[]): unknown {
  if (!isPlainObject(raw) || !isPlainObject(parsed)) return parsed;
  const out: Record<string, unknown> = { ...parsed };
  for (const [chave, valor] of Object.entries(raw)) {
    const caminho = prefixo ? `${prefixo}.${chave}` : chave;
    if (!(chave in out)) {
      if (valor === undefined) perdidos.push(caminho);
      else out[chave] = valor;
      continue;
    }
    if (isPlainObject(valor) && isPlainObject(out[chave])) {
      out[chave] = restaurarDesconhecidos(valor, out[chave], caminho, perdidos);
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Política de itens não aprovados (IMPL-090, R-22:REC-7)
// ----------------------------------------------------------------------------

export interface CurationStatus {
  total: number;
  /** Itens aprovados com `contentHash` válido — o "k" de "k de n curados". */
  curated: number;
  unapproved: { id: string; state: LibraryItemState | 'sem_estado' }[];
}

/** k de n curados: o dado que a run tem que reportar (nunca fingir curadoria). */
export function curationStatus(items: LibraryItem[]): CurationStatus {
  const unapproved: CurationStatus['unapproved'] = [];
  let curated = 0;
  for (const item of items) {
    if (isApproved(item)) curated += 1;
    else unapproved.push({ id: item.id, state: item.state ?? 'sem_estado' });
  }
  return { total: items.length, curated, unapproved };
}

/** Texto `"k de n itens curados"` para o resultado da run. */
export function curatedKofN(items: LibraryItem[]): string {
  const s = curationStatus(items);
  return `${s.curated} de ${s.total} itens curados`;
}

/**
 * `run.warning` AGREGADO (uma entrada para todos os itens, não uma por item —
 * o evento é agregado e não entra no reducer de etapas).
 */
export function curationWarnings(items: LibraryItem[]): string[] {
  const s = curationStatus(items);
  if (s.unapproved.length === 0) return [];
  const porEstado = new Map<string, string[]>();
  for (const u of s.unapproved) {
    const lista = porEstado.get(u.state) ?? [];
    lista.push(u.id);
    porEstado.set(u.state, lista);
  }
  const detalhe = [...porEstado.entries()]
    .map(([estado, ids]) => {
      const amostra = ids.slice(0, 5).join(', ');
      return `${estado}: ${amostra}${ids.length > 5 ? ` (+${ids.length - 5})` : ''}`;
    })
    .join('; ');
  return [`itens não aprovados em uso (${curatedKofN(items)}) — ${detalhe}`];
}

/**
 * Bloqueio de `--require-approved`, holdout e finais (100% aprovados): mensagem
 * legível ou `null`. Sem isto NADA bloqueia por default — e bloqueio total
 * significaria curadoria nunca acontecer com mantenedor solo (R-22 §8).
 */
export function requireApprovedIssue(items: LibraryItem[]): string | null {
  const s = curationStatus(items);
  if (s.unapproved.length === 0) return null;
  const amostra = s.unapproved
    .slice(0, 10)
    .map((u) => `${u.id}=${u.state}`)
    .join(', ');
  return (
    `há ${s.unapproved.length} item(ns) não aprovado(s) de ${s.total} ` +
    `(${s.curated} curado(s)): ${amostra}${s.unapproved.length > 10 ? ', …' : ''}`
  );
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
