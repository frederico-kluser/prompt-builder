// CICLO DE VIDA de modelos do OpenRouter (IMPL-019, R-07b:REC-8/DEC-8).
//
// POR QUE existe: o catálogo muda por baixo das runs. Medido no repositório:
// ~19% dos ids de junho sumiram em ~99 dias (185 entraram, 63 saíram) e só
// uma minoria publica `expiration_date` antes (28/459 em 2026-09-25). Quando o
// id some, a run quebra; quando um alias (`~vendor/…-latest`) passa a apontar
// para outro snapshot, a comparação pareada morre EM SILÊNCIO (o id é o mesmo,
// o modelo não). Regra de ouro: NUNCA migrar sozinho — migração silenciosa
// quebra a comparação; o produto avisa, grava e exige decisão declarada.
//
// Este módulo é PURO (sem node:*, sem fetch, sem fs): roda no Node (motor, CLI,
// gate de baseline, job semanal de docs) e no bundle do navegador (motor
// client-side) — os dois orquestradores importam daqui. Tudo que depende do
// relógio recebe `now` explícito (testável e reprodutível).
//
// O que ele entrega:
//   • `parseLifecycleMeta`   — lê canonical_slug/expiration_date/alias_target
//     de um item cru de GET /models (chamado por `parseModelsPayload`);
//   • `snapshotModelLifecycle` — o que a run grava em `RunRecord.modelLifecycle`
//     (100% dos modelos da run, por papel) + alertas 30/14/7 dias;
//   • `suggestSuccessor` / `removalAction` — a POLÍTICA DE REMOÇÃO codificada;
//   • `extractModelIds` / `checkCitedModelIds` — o job semanal que confere ids
//     citados em docs contra o catálogo.

// ----------------------------------------------------------------------------
// Tipos
// ----------------------------------------------------------------------------

/** Papel de um modelo NA RUN (um mesmo id pode ter vários). */
export type ModelUsageRole = 'competitor' | 'judge' | 'reference' | 'datagen' | 'optimizer';

/** Metadados de ciclo de vida que o catálogo publica por modelo. */
export interface ModelLifecycleMeta {
  /** `canonical_slug`: o snapshot datado por trás do id (ex.: "…-20260630"). */
  canonicalSlug?: string;
  /**
   * `expiration_date` normalizada para AAAA-MM-DD. `null` = o catálogo diz
   * explicitamente "sem data"; ausente = o catálogo não trouxe o campo.
   */
  expirationDate?: string | null;
  /** `alias_target.slug`: para quem um alias `~…-latest` aponta HOJE. */
  aliasTarget?: string;
  /** `created` (unix, segundos) — usado só para ordenar sucessores. */
  created?: number;
}

/** O mínimo do catálogo que este módulo consome (`OpenRouterModel` satisfaz). */
export interface CatalogModelLike extends ModelLifecycleMeta {
  id: string;
}

/** Uma linha do snapshot gravado na run. Os três campos do catálogo SEMPRE existem (null = sem valor). */
export interface ModelLifecycleEntry {
  modelId: string;
  roles: ModelUsageRole[];
  /** false = o id não estava no catálogo na hora da run (removido ou nunca existiu). */
  inCatalog: boolean;
  canonicalSlug: string | null;
  expirationDate: string | null;
  aliasTarget: string | null;
}

/** Janelas de alerta antes da expiração (dias). */
export const EXPIRATION_WINDOWS = [30, 14, 7] as const;
export type ExpirationWindow = (typeof EXPIRATION_WINDOWS)[number];

/** De onde veio o sucedâneo sugerido. `heuristic` NÃO conta como sucessor nomeado. */
export type SuccessorSource = 'declared' | 'alias' | 'heuristic';

export interface SuccessorSuggestion {
  id: string;
  source: SuccessorSource;
  /** Alias do catálogo que nomeou o sucessor (quando source === 'alias'). */
  via?: string;
}

/**
 * Política de remoção (R-07b DEC-8), em ordem de preferência:
 *   • `freeze-rescore` (DEFAULT) — congela as respostas já gravadas e as
 *     re-pontua (sem regerar); a comparação continua sobre dados congelados;
 *   • `bridge-run` — expiração ANUNCIADA e sucessor nomeado: rode uma
 *     run-ponte (modelo atual × sucessor nos MESMOS cenários) antes da data e
 *     declare a re-baseline a partir dela;
 *   • `invalidate-baseline` — juiz/gabarito removido SEM sucessor nomeado: não
 *     há ponte possível; a baseline deixa de valer e precisa ser refeita.
 */
export type RemovalAction = 'freeze-rescore' | 'bridge-run' | 'invalidate-baseline';

export type LifecycleAlertKind = 'expiring' | 'expired' | 'missing';

export interface ModelLifecycleAlert {
  modelId: string;
  roles: ModelUsageRole[];
  kind: LifecycleAlertKind;
  expirationDate: string | null;
  /** Dias inteiros até a expiração (<= 0 = já expirou); null quando não há data. */
  daysLeft: number | null;
  /** Menor janela (30/14/7) em que a data caiu; null para expired/missing. */
  window: ExpirationWindow | null;
  successor: SuccessorSuggestion | null;
  action: RemovalAction;
  /** Mensagem PT-BR pronta para log/CLI. */
  message: string;
}

/** O que a run grava em `RunRecord.modelLifecycle`. */
export interface ModelLifecycleSnapshot {
  capturedAt: string;
  /** `unavailable` = o catálogo não carregou; os campos ficam null e nada é afirmado. */
  source: 'catalog' | 'unavailable';
  models: Record<string, ModelLifecycleEntry>;
  alerts: ModelLifecycleAlert[];
}

// ----------------------------------------------------------------------------
// Parse do item cru de /models
// ----------------------------------------------------------------------------

/** AAAA-MM-DD a partir de "2026-10-09" ou ISO completo; undefined se ilegível. */
export function normalizeDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const v = value.trim();
  const direto = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  if (direto && !Number.isNaN(Date.parse(`${direto[1]}T00:00:00Z`))) return direto[1];
  const t = Date.parse(v);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Lê os campos de ciclo de vida de um item cru de GET /models. Só devolve as
 * chaves que o catálogo trouxe — `expirationDate: null` é informação (o
 * catálogo disse "sem data"), ausente é desconhecimento.
 */
export function parseLifecycleMeta(item: Record<string, unknown>): ModelLifecycleMeta {
  const out: ModelLifecycleMeta = {};
  if (typeof item.canonical_slug === 'string' && item.canonical_slug.trim()) {
    out.canonicalSlug = item.canonical_slug.trim();
  }
  if (item.expiration_date === null) {
    out.expirationDate = null;
  } else {
    const d = normalizeDate(item.expiration_date);
    if (d) out.expirationDate = d;
  }
  const alvo = item.alias_target;
  if (alvo && typeof alvo === 'object' && typeof (alvo as { slug?: unknown }).slug === 'string') {
    const slug = ((alvo as { slug: string }).slug).trim();
    if (slug) out.aliasTarget = slug;
  } else if (typeof alvo === 'string' && alvo.trim()) {
    out.aliasTarget = alvo.trim();
  }
  if (typeof item.created === 'number' && Number.isFinite(item.created)) out.created = item.created;
  return out;
}

// ----------------------------------------------------------------------------
// Datas e janelas
// ----------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * Dias inteiros de `now` (meia-noite UTC do dia) até `date` (AAAA-MM-DD, UTC).
 * Amanhã = 1, hoje = 0, ontem = -1. null se a data for ilegível.
 */
export function daysUntil(date: string, now: Date): number | null {
  const d = normalizeDate(date);
  if (!d) return null;
  const alvo = Date.parse(`${d}T00:00:00Z`);
  const hoje = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((alvo - hoje) / DAY_MS);
}

/**
 * Menor janela de alerta em que `daysLeft` cai. `daysLeft <= 0` NÃO tem janela:
 * é expiração consumada (a data é a de deprecação do endpoint — a partir dela
 * os pedidos falham), tratada como `expired` por quem chama.
 */
export function expirationWindow(daysLeft: number): ExpirationWindow | null {
  if (daysLeft <= 0) return null;
  for (const w of [...EXPIRATION_WINDOWS].sort((a, b) => a - b)) {
    if (daysLeft <= w) return w;
  }
  return null;
}

// ----------------------------------------------------------------------------
// Sucessor sugerido
// ----------------------------------------------------------------------------

/** Vendor do id (sem o `~` de alias). */
export function vendorOf(id: string): string {
  return id.replace(/^~/, '').split('/')[0] ?? '';
}

/** Sufixo de variante (`:free`, `:batch`…) ou '' quando não há. */
function variantOf(id: string): string {
  const i = id.indexOf(':');
  return i >= 0 ? id.slice(i) : '';
}

/** Token de versão/tamanho/data: 2.5, v4, 4o, 0731, 20250625, 235b, a22b… */
function isVersionToken(t: string): boolean {
  return /^v?\d+(\.\d+)*[a-z]?$/.test(t) || /^a?\d+(\.\d+)?[bkm]$/.test(t);
}

/**
 * Tokens de FAMÍLIA do nome (sem vendor, sem variante, sem versão):
 * "google/gemini-2.5-flash-lite" → gemini, flash, lite. Dígitos colados ao fim
 * do token saem ("qwen3.6" → "qwen") para famílias numeradas casarem.
 */
export function familyTokens(id: string): string[] {
  const nome = id.replace(/^~/, '').split('/').slice(1).join('/').replace(/:.*$/, '');
  const tokens = nome
    .toLowerCase()
    .split(/[-_/]/)
    .filter(Boolean)
    .filter((t) => !isVersionToken(t) && t !== 'latest')
    .map((t) => t.replace(/[\d.]+$/, ''))
    .filter(Boolean);
  return [...new Set(tokens)];
}

function expiraDepois(cand: CatalogModelLike, original?: CatalogModelLike): boolean {
  if (!cand.expirationDate) return true;
  if (!original?.expirationDate) return false;
  return cand.expirationDate > original.expirationDate;
}

/**
 * Sucedâneo para `modelId`, em ordem de confiança:
 *   1. `declared` — o usuário nomeou (ex.: `successors` do judge-baseline);
 *   2. `alias` — um alias `~vendor/<família>-latest` do MESMO vendor cuja
 *      família está contida na do modelo aponta para outro id vivo (é o
 *      mecanismo de sobrevivência que o próprio OpenRouter recomenda);
 *   3. `heuristic` — o id mais novo do mesmo vendor com a maior família em
 *      comum. É só SUGESTÃO: não conta como "sucessor nomeado" na política.
 * null quando nada plausível existe.
 */
export function suggestSuccessor(
  modelId: string,
  catalog: readonly CatalogModelLike[],
  declared?: Readonly<Record<string, string>>,
): SuccessorSuggestion | null {
  const nomeado = declared?.[modelId];
  if (nomeado && nomeado !== modelId) return { id: nomeado, source: 'declared' };
  if (!catalog.length) return null;

  const byId = new Map(catalog.map((m) => [m.id, m]));
  const original = byId.get(modelId);
  const vendor = vendorOf(modelId);
  const variante = variantOf(modelId);
  const familia = familyTokens(modelId);
  if (!vendor || !familia.length) return null;

  // 2. alias do mesmo vendor cuja família ⊂ família do modelo (o mais específico ganha).
  let melhorAlias: { alias: CatalogModelLike; alvo: string; peso: number } | null = null;
  for (const m of catalog) {
    if (!m.id.startsWith('~') || vendorOf(m.id) !== vendor || !m.aliasTarget) continue;
    if (m.aliasTarget === modelId) continue;
    // O alvo precisa estar VIVO no catálogo e não expirar antes do original.
    const alvo = byId.get(m.aliasTarget);
    if (!alvo || !expiraDepois(alvo, original)) continue;
    const famAlias = familyTokens(m.id);
    if (!famAlias.length || !famAlias.every((t) => familia.includes(t))) continue;
    if (!melhorAlias || famAlias.length > melhorAlias.peso) {
      melhorAlias = { alias: m, alvo: m.aliasTarget, peso: famAlias.length };
    }
  }
  if (melhorAlias) return { id: melhorAlias.alvo, source: 'alias', via: melhorAlias.alias.id };

  // 3. heurística: mesmo vendor e variante, família-âncora em comum, mais novo.
  let melhor: { m: CatalogModelLike; score: number } | null = null;
  for (const m of catalog) {
    if (m.id === modelId || m.id.startsWith('~')) continue;
    if (vendorOf(m.id) !== vendor || variantOf(m.id) !== variante) continue;
    if (!expiraDepois(m, original)) continue;
    if (original?.created && m.created && m.created < original.created) continue;
    const fam = familyTokens(m.id);
    if (!fam.includes(familia[0])) continue;
    const comuns = fam.filter((t) => familia.includes(t)).length;
    const extras = fam.filter((t) => !familia.includes(t)).length;
    const score = comuns * 10 - extras;
    if (
      !melhor ||
      score > melhor.score ||
      (score === melhor.score && (m.created ?? 0) > (melhor.m.created ?? 0)) ||
      (score === melhor.score && (m.created ?? 0) === (melhor.m.created ?? 0) && m.id < melhor.m.id)
    ) {
      melhor = { m, score };
    }
  }
  return melhor ? { id: melhor.m.id, source: 'heuristic' } : null;
}

/** Sucessor "nomeado" = declarado pelo usuário ou nomeado pelo catálogo (alias). */
export function isNamedSuccessor(s: SuccessorSuggestion | null | undefined): boolean {
  return !!s && s.source !== 'heuristic';
}

// ----------------------------------------------------------------------------
// Política de remoção
// ----------------------------------------------------------------------------

/**
 * Decide a ação da política (R-07b DEC-8) para um modelo em risco:
 *   • expiração ANUNCIADA (ainda no catálogo): sucessor nomeado → `bridge-run`;
 *     sem sucessor → `freeze-rescore` (congele antes da data);
 *   • REMOVIDO/expirado: juiz/gabarito sem sucessor nomeado →
 *     `invalidate-baseline` (a única saída sem ponte); qualquer outro caso →
 *     `freeze-rescore` (default).
 */
export function removalAction(input: {
  phase: 'announced' | 'removed';
  roles: readonly ModelUsageRole[];
  successor: SuccessorSuggestion | null;
}): RemovalAction {
  const nomeado = isNamedSuccessor(input.successor);
  if (input.phase === 'announced') return nomeado ? 'bridge-run' : 'freeze-rescore';
  const avalia = input.roles.includes('judge') || input.roles.includes('reference');
  if (avalia && !nomeado) return 'invalidate-baseline';
  return 'freeze-rescore';
}

const ACTION_TEXT: Record<RemovalAction, string> = {
  'freeze-rescore':
    'congele as respostas já gravadas e re-pontue-as (sem regerar); nunca troque o modelo em silêncio',
  'bridge-run':
    'rode uma run-ponte (modelo atual × sucessor nos mesmos cenários) antes da data e declare a re-baseline a partir dela',
  'invalidate-baseline':
    'sem sucessor nomeado a baseline fica inválida — declare uma nova baseline antes de comparar',
};

/** Texto PT-BR da ação da política (para mensagens e docs). */
export function describeRemovalAction(action: RemovalAction): string {
  return ACTION_TEXT[action];
}

function rolesText(roles: readonly ModelUsageRole[]): string {
  return roles.length ? ` (${roles.join('/')})` : '';
}

/**
 * O que fazer, em texto. Sem papel = CITAÇÃO em doc/exemplo (job semanal): a
 * política de runs não se aplica — o que resolve é atualizar a citação.
 */
function actionText(action: RemovalAction, roles: readonly ModelUsageRole[], kind: LifecycleAlertKind): string {
  if (roles.length) return describeRemovalAction(action);
  return kind === 'expiring'
    ? 'atualize a citação antes da data (o exemplo quebra quando o id sair do catálogo)'
    : 'atualize a citação — o exemplo não roda';
}

/** Texto PT-BR do sucedâneo (declarado / nomeado pelo catálogo / heurístico). */
export function describeSuccessor(s: SuccessorSuggestion | null): string {
  return successorText(s);
}

function successorText(s: SuccessorSuggestion | null): string {
  if (!s) return 'sem sucedâneo no catálogo';
  if (s.source === 'declared') return `sucessor declarado: ${s.id}`;
  if (s.source === 'alias') return `sucessor nomeado pelo catálogo: ${s.id} (via ${s.via})`;
  return `sucedâneo sugerido: ${s.id} (heurística — confirme antes de usar)`;
}

/**
 * Alerta de ciclo de vida para UM modelo (ou null quando não há o que avisar:
 * no catálogo sem data, ou com data a mais de 30 dias — data futura não falha).
 * `entry` ausente = o id não está no catálogo (`missing`).
 */
export function lifecycleAlertFor(
  modelId: string,
  roles: readonly ModelUsageRole[],
  entry: CatalogModelLike | undefined,
  catalog: readonly CatalogModelLike[],
  now: Date,
  declared?: Readonly<Record<string, string>>,
): ModelLifecycleAlert | null {
  const papeis = [...roles];
  if (!entry) {
    const successor = suggestSuccessor(modelId, catalog, declared);
    const action = removalAction({ phase: 'removed', roles: papeis, successor });
    return {
      modelId,
      roles: papeis,
      kind: 'missing',
      expirationDate: null,
      daysLeft: null,
      window: null,
      successor,
      action,
      message:
        `${modelId}${rolesText(papeis)} não está no catálogo (removido ou inexistente) — ` +
        `${successorText(successor)}; ${actionText(action, papeis, 'missing')}.`,
    };
  }
  const data = entry.expirationDate ?? null;
  if (!data) return null;
  const daysLeft = daysUntil(data, now);
  if (daysLeft === null) return null;
  const successor = suggestSuccessor(modelId, catalog, declared);
  if (daysLeft <= 0) {
    const action = removalAction({ phase: 'removed', roles: papeis, successor });
    return {
      modelId,
      roles: papeis,
      kind: 'expired',
      expirationDate: data,
      daysLeft,
      window: null,
      successor,
      action,
      message:
        `${modelId}${rolesText(papeis)} expirou em ${data} — ${successorText(successor)}; ` +
        `${actionText(action, papeis, 'expired')}.`,
    };
  }
  const window = expirationWindow(daysLeft);
  if (window === null) return null; // data futura além de 30 dias: não avisa, não falha
  const action = removalAction({ phase: 'announced', roles: papeis, successor });
  // Juiz/gabarito sem sucessor NOMEADO: congelar vale até a data; depois dela a
  // política invalida a baseline — o aviso diz isso agora, não no dia.
  const avalia = papeis.includes('judge') || papeis.includes('reference');
  const semPonte =
    avalia && !isNamedSuccessor(successor)
      ? ' Nomeie um sucessor (ex.: `successors` do judge-baseline) ou a baseline será invalidada na data.'
      : '';
  return {
    modelId,
    roles: papeis,
    kind: 'expiring',
    expirationDate: data,
    daysLeft,
    window,
    successor,
    action,
    message:
      `${modelId}${rolesText(papeis)} expira em ${data} (${daysLeft} dia${daysLeft === 1 ? '' : 's'}; ` +
      `janela de ${window} dias) — ${successorText(successor)}; ${actionText(action, papeis, 'expiring')}.${semPonte}`,
  };
}

// ----------------------------------------------------------------------------
// Snapshot gravado na run
// ----------------------------------------------------------------------------

/** O mínimo da config que define quais modelos uma run usa (RunConfig satisfaz). */
export interface RunModelsLike {
  mode?: string;
  datagenModelId?: string;
  judgeModelIds?: readonly string[];
  referenceModelId?: string;
  optimizerModelId?: string;
  promptOptimization?: boolean;
  /** IMPL-115: juízes do modo econômico (baratos + forte). */
  judgeCascade?: { cheap?: readonly string[]; strong?: string };
}

/**
 * Todo modelo que a run usa, com os papéis. O gabarito é `referenceModelId`
 * ou, na falta, o 1º juiz (mesmo default do orquestrador); o otimizador é
 * `optimizerModelId` ou, em variation/training com otimização ligada, o datagen.
 */
export function modelRolesForRun(
  config: RunModelsLike,
  contestants: readonly { modelId: string }[],
): Record<string, ModelUsageRole[]> {
  const out: Record<string, ModelUsageRole[]> = {};
  const add = (id: string | undefined, role: ModelUsageRole): void => {
    if (typeof id !== 'string' || !id.trim()) return;
    const lista = (out[id] ??= []);
    if (!lista.includes(role)) lista.push(role);
  };
  for (const c of contestants) add(c.modelId, 'competitor');
  for (const j of config.judgeModelIds ?? []) add(j, 'judge');
  for (const j of config.judgeCascade?.cheap ?? []) add(j, 'judge');
  add(config.judgeCascade?.strong, 'judge');
  add(config.referenceModelId ?? config.judgeModelIds?.[0], 'reference');
  add(config.datagenModelId, 'datagen');
  const otimiza = config.mode === 'variation' || config.mode === 'training';
  if (config.optimizerModelId) add(config.optimizerModelId, 'optimizer');
  else if (otimiza && config.promptOptimization !== false) add(config.datagenModelId, 'optimizer');
  return out;
}

/**
 * Snapshot de ciclo de vida da run: UMA entrada por modelo usado (100% dos
 * modelos, com canonicalSlug/expirationDate/aliasTarget sempre presentes — null
 * quando o catálogo não tem valor) e os alertas 30/14/7 dias / expirado /
 * ausente. Catálogo vazio/indisponível ⇒ `source: 'unavailable'`, campos null e
 * NENHUM alerta: sem catálogo nada se afirma (um "ausente" ali seria mentira).
 */
export function snapshotModelLifecycle(
  roles: Readonly<Record<string, readonly ModelUsageRole[]>>,
  catalog: readonly CatalogModelLike[] | null | undefined,
  now: Date,
  declared?: Readonly<Record<string, string>>,
): ModelLifecycleSnapshot {
  const lista = catalog ?? [];
  const disponivel = lista.length > 0;
  const byId = new Map(lista.map((m) => [m.id, m]));
  const models: Record<string, ModelLifecycleEntry> = {};
  const alerts: ModelLifecycleAlert[] = [];
  for (const [modelId, papeis] of Object.entries(roles)) {
    const m = byId.get(modelId);
    models[modelId] = {
      modelId,
      roles: [...papeis],
      inCatalog: !!m,
      canonicalSlug: m?.canonicalSlug ?? null,
      expirationDate: m?.expirationDate ?? null,
      aliasTarget: m?.aliasTarget ?? null,
    };
    if (!disponivel) continue;
    const alerta = lifecycleAlertFor(modelId, papeis, m, lista, now, declared);
    if (alerta) alerts.push(alerta);
  }
  return {
    capturedAt: now.toISOString(),
    source: disponivel ? 'catalog' : 'unavailable',
    models,
    alerts,
  };
}

/**
 * Identidade do JULGAMENTO de uma run: hash do contrato do juiz + o snapshot
 * (canonicalSlug/aliasTarget) de cada juiz e do gabarito. Muda quando o prompt
 * do juiz muda E quando um id passa a apontar para outro snapshot (alias
 * movido) — o caso em que o hash sozinho ficaria igual e o treino compararia
 * iterações julgadas por modelos diferentes sem avisar.
 */
export interface JudgeIdentity {
  hash: string;
  /** modelId → "canonicalSlug>aliasTarget"; só modelos que o catálogo informou. */
  snapshots: Record<string, string>;
}

/** undefined sem hash de contrato (run que não chegou ao julgamento). */
export function judgeIdentity(record: {
  judgeDiagnostics?: { contract: { hash: string } };
  modelLifecycle?: ModelLifecycleSnapshot;
}): JudgeIdentity | undefined {
  const hash = record.judgeDiagnostics?.contract.hash;
  if (!hash) return undefined;
  const snapshots: Record<string, string> = {};
  const snap = record.modelLifecycle;
  if (snap?.source === 'catalog') {
    for (const e of Object.values(snap.models)) {
      if (!e.inCatalog || !(e.roles.includes('judge') || e.roles.includes('reference'))) continue;
      snapshots[e.modelId] = `${e.canonicalSlug ?? ''}>${e.aliasTarget ?? ''}`;
    }
  }
  return { hash, snapshots };
}

/**
 * Mudou o julgamento? Hash diferente, OU um modelo que as DUAS identidades
 * conhecem aponta para outro snapshot. Modelo sem dado de catálogo de um dos
 * lados não conta: catálogo fora do ar numa iteração não é deriva de juiz.
 */
export function judgeIdentityChanged(a: JudgeIdentity, b: JudgeIdentity): boolean {
  if (a.hash !== b.hash) return true;
  for (const [id, v] of Object.entries(a.snapshots)) {
    if (id in b.snapshots && b.snapshots[id] !== v) return true;
  }
  return false;
}

/** Completa a identidade de referência com snapshots que ela ainda não tinha (a base vence). */
export function mergeJudgeIdentity(base: JudgeIdentity, extra: JudgeIdentity): JudgeIdentity {
  return { hash: base.hash, snapshots: { ...extra.snapshots, ...base.snapshots } };
}

// ----------------------------------------------------------------------------
// Job semanal: ids citados em docs × catálogo
// ----------------------------------------------------------------------------

/**
 * Vendors reconhecidos mesmo quando o catálogo não tem mais nenhum modelo
 * deles (um vendor inteiro que sai do catálogo também quebra exemplos). A lista
 * efetiva é esta ∪ os vendors do catálogo do dia.
 */
export const KNOWN_VENDORS: readonly string[] = [
  'ai21', 'amazon', 'anthropic', 'baidu', 'bytedance', 'cohere', 'deepseek', 'google',
  'meta-llama', 'microsoft', 'minimax', 'mistralai', 'moonshotai', 'nvidia', 'openai',
  'openrouter', 'perplexity', 'qwen', 'tencent', 'x-ai', 'z-ai',
];

/** Vendors conhecidos: estáticos ∪ presentes no catálogo. */
export function knownVendorsFrom(catalog: readonly CatalogModelLike[]): Set<string> {
  const set = new Set(KNOWN_VENDORS);
  for (const m of catalog) set.add(vendorOf(m.id));
  return set;
}

/** Marcador de linha para citar um id de propósito (ex.: documentar um id removido). */
export const MODEL_IDS_IGNORE_MARKER = 'model-ids:ignore';

/**
 * Candidato a id: `vendor/modelo` (com `~` de alias e `:variante`), sem ser
 * pedaço de URL/caminho/escopo npm (lookbehind: nada de `/`, `.`, `@`… colado
 * antes) nem de caminho mais longo (`a/b/c`), e sem ser placeholder
 * (`anthropic/claude-…`, `openai/gpt-*`, `google/gemini-...` — lookahead).
 */
const MODEL_ID_RE =
  /(?<![\w./@~:-])(~?[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._:-]*[a-z0-9])(?![\w.:-]*(?:[…*/]|\.\.\.))/g;

/**
 * Extrai ids de modelo citados num texto (Markdown, JSON, shell). Só conta o
 * candidato cujo vendor é conhecido — `src/cli`, `agent-docs/x.md` e afins não
 * são modelos. Linhas com `model-ids:ignore` são puladas.
 */
export function extractModelIds(
  text: string,
  vendors: ReadonlySet<string>,
): { id: string; line: number }[] {
  const out: { id: string; line: number }[] = [];
  const linhas = text.split('\n');
  linhas.forEach((linha, i) => {
    if (linha.includes(MODEL_IDS_IGNORE_MARKER)) return;
    for (const m of linha.matchAll(MODEL_ID_RE)) {
      const id = m[1];
      if (!vendors.has(vendorOf(id))) continue;
      out.push({ id, line: i + 1 });
    }
  });
  return out;
}

export interface CitedModelId {
  id: string;
  file: string;
  line: number;
}

export interface CitedModelIdFinding extends CitedModelId {
  alert: ModelLifecycleAlert;
}

export interface ModelIdsReport {
  /** Citações conferidas (com repetição). */
  checked: number;
  /** Ids distintos conferidos. */
  distinct: number;
  /** Ausentes do catálogo ou já expirados — reprovam o job. */
  failures: CitedModelIdFinding[];
  /** Expiram em <= 30 dias — avisam com sucedâneo, NÃO reprovam. */
  warnings: CitedModelIdFinding[];
  ok: boolean;
}

/**
 * Confere citações contra o catálogo: id ausente ou expirado REPROVA; id com
 * `expiration_date` em até 30 dias gera AVISO com sucedâneo; data futura além
 * disso (ou sem data) passa. Um `canonical_slug` citado vale pelo modelo dono.
 */
export function checkCitedModelIds(
  cited: readonly CitedModelId[],
  catalog: readonly CatalogModelLike[],
  now: Date,
): ModelIdsReport {
  const byId = new Map(catalog.map((m) => [m.id, m]));
  // Um `canonical_slug` citado (ex.: no JSON de exemplo do export) é referência
  // legítima ao snapshot de um modelo VIVO — confere pelo dono do slug.
  const donoDoSlug = new Map<string, CatalogModelLike>();
  for (const m of catalog) {
    if (m.canonicalSlug && !byId.has(m.canonicalSlug) && !donoDoSlug.has(m.canonicalSlug)) {
      donoDoSlug.set(m.canonicalSlug, m);
    }
  }
  const failures: CitedModelIdFinding[] = [];
  const warnings: CitedModelIdFinding[] = [];
  const cache = new Map<string, ModelLifecycleAlert | null>();
  for (const c of cited) {
    if (!cache.has(c.id)) {
      const dono = donoDoSlug.get(c.id);
      cache.set(
        c.id,
        dono
          ? lifecycleAlertFor(dono.id, [], dono, catalog, now)
          : lifecycleAlertFor(c.id, [], byId.get(c.id), catalog, now),
      );
    }
    const alert = cache.get(c.id);
    if (!alert) continue;
    if (alert.kind === 'expiring') warnings.push({ ...c, alert });
    else failures.push({ ...c, alert });
  }
  return {
    checked: cited.length,
    distinct: cache.size,
    failures,
    warnings,
    ok: failures.length === 0,
  };
}
