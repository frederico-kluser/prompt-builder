// Modo JEV — o formato `jev-config@1` (D-5): próprio, irmão do
// `arena-agent-config@1`, FORA do `arena-config`/`RunConfigBase` e dos dois
// whitelists silenciosos (`normalizeRunRecord`, `variationConfigFrom`). Uma
// implementação serve CLI, MCP, SPA e `docs-lint`.
//
// Convenções mantidas do arena-config: `format@versão`; zod `.strict()`
// (chave desconhecida = erro, exit 3); o parse NUNCA lança; `budgetUsd` na
// raiz; `compliance` com o mesmo shape. Semântica das perguntas (rubrica,
// limites do fio) é do LINT (`lintJevSpec`), com códigos estáveis — o schema só
// garante a forma.

import { z } from 'zod';
import { contentHash } from '../hash.js';
import { REASONING_LEVELS } from '../../reasoning.js';
import type { ComplianceConfigLike } from '../lgpdCore.js';
import type { PiiConfigLike } from '../pii.js';
import type {
  JevBandDefaults,
  JevCase,
  JevContestant,
  JevLintIssue,
  JevMode,
  JevOperatorId,
  JevQuestionSpec,
  JevSpec,
  ResolvedJevConfig,
  ResolvedJevConfigSnapshot,
} from './types.js';
import { DEFAULT_BANDS, DEFAULT_SCORE_TOLERANCE, DEFAULT_TARGET_PRECISION } from './scoring.js';
import { assignSplits, datasetHash, parseJevDataset, splitCounts } from './dataset.js';
import { isPlainObject } from './wire.js';

export const JEV_CONFIG_FORMAT = 'jev-config@1';
/** Modelo de decisão default (versão FIXADA: limiares calibrados precisam de snapshot estável — J14). */
export const DEFAULT_DECISION_MODEL = 'typesafe/jev-1.13';
/** Operadores da v1 do treino (crítica C/1c): os demais ficam para depois. */
export const JEV_TRAIN_OPERATORS_V1: readonly JevOperatorId[] = ['add_examples', 'add_not_for', 'describe_option', 'literalize'];
/** Abaixo disto o `calib` vira o próprio `train` (com aviso) — não há casos para separar. */
export const MIN_CASES_FOR_CALIB_SPLIT = 60;

const guidance = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]);

const questionSchema = z.strictObject({
  // tipo/instrução/criteria: o LINT dá o código (`question.type`, `noul.criteria_pair`…).
  type: z.string(),
  instructions: guidance.optional(),
  criteria: z.unknown().optional(),
  keyMap: z.record(z.string(), z.string()).optional(),
  guard: z.boolean().optional(),
});

const policySchema = z.strictObject({
  auto: z.number().min(0).max(1.01).optional(),
  hitl: z.number().min(0).max(1).optional(),
  signal: z.enum(['confidence', 'certainty', 'pTop']).optional(),
  temperature: z.number().positive().max(100).optional(),
});

const stateViewSchema = z.strictObject({
  fields: z
    .array(
      z.strictObject({
        from: z.string(),
        as: z.string().min(1),
        maxChars: z.number().int().positive().optional(),
        untrusted: z.boolean().optional(),
      }),
    )
    .min(1),
});

const specSchema = z.strictObject({
  label: z.string().min(1).max(80).optional(),
  questions: z.record(z.string(), questionSchema),
  stateView: stateViewSchema.optional(),
  policy: z.strictObject({ questions: z.record(z.string(), policySchema) }).optional(),
});

const specPatchSchema = z.strictObject({
  questions: z.record(z.string(), questionSchema).optional(),
  stateView: stateViewSchema.optional(),
  policy: z.strictObject({ questions: z.record(z.string(), policySchema) }).optional(),
});

const bandSchema = z.strictObject({ auto: z.number().min(0).max(1.01), hitl: z.number().min(0).max(1) });

const llmSchema = z.strictObject({
  modelId: z.string().min(1),
  label: z.string().min(1).max(80).optional(),
  reasoning: z.enum(REASONING_LEVELS).optional(),
  temperature: z.number().min(0).max(2).optional(),
  batching: z.enum(['per-question', 'per-case']).optional(),
  maxTokens: z.number().int().positive().max(64_000).optional(),
});

const OPERATORS = [
  'add_examples',
  'add_not_for',
  'describe_option',
  'literalize',
  'structure_rubric',
  'project_state',
  'add_exit',
  'polarity_align',
  'rewrite_levels',
  'rename_key',
  'translate_spec',
] as const;

const trainSchema = z.strictObject({
  iterations: z.number().int().min(1).max(10).optional(),
  variantsPerIteration: z.number().int().min(1).max(8).optional(),
  repeats: z.number().int().min(1).max(5).optional(),
  rewriterModelId: z.string().min(1).optional(),
  targetQuestions: z.array(z.string().min(1)).min(1).optional(),
  metric: z.enum(['brier-cal', 'accuracy']).optional(),
  minGainPp: z.number().min(0).max(100).optional(),
  maxAccuracyDropPp: z.number().min(0).max(100).optional(),
  operators: z.array(z.enum(OPERATORS)).min(1).optional(),
  patience: z.number().int().min(1).max(10).optional(),
  targetPrecision: z.number().min(0.5).max(1).optional(),
  maxCostIncreasePct: z.number().min(0).optional(),
  allowExitOption: z.boolean().optional(),
});

export const jevConfigSchema = z.strictObject({
  format: z.literal(JEV_CONFIG_FORMAT),
  mode: z.enum(['eval', 'compare', 'train']).optional(),
  theme: z.string().max(300).optional(),
  language: z.string().max(20).optional(),
  spec: specSchema,
  variants: z.array(z.strictObject({ label: z.string().min(1).max(80), spec: specPatchSchema })).max(12).optional(),
  /** `{path}` (só no CLI: resolvido relativo ao config) ou a lista inline de casos. */
  cases: z.union([z.strictObject({ path: z.string().min(1) }), z.array(z.unknown()).min(1)]),
  models: z.strictObject({
    decision: z.array(z.string().min(1)).max(8).optional(),
    llm: z.array(llmSchema).max(6).optional(),
  }),
  repeats: z.number().int().min(1).max(5).optional(),
  scoreTolerance: z.number().min(0).max(5).optional(),
  split: z
    .strictObject({
      holdoutRatio: z.number().min(0).max(0.5).optional(),
      calibrationRatio: z.number().min(0).max(0.5).optional(),
      seed: z.number().int().optional(),
      stratifyBy: z.string().min(1).optional(),
    })
    .optional(),
  bands: z.strictObject({ noul: bandSchema.optional(), choice: bandSchema.optional(), score: bandSchema.optional() }).optional(),
  targetPrecision: z.number().min(0.5).max(1).optional(),
  fit: z.boolean().optional(),
  compare: z.strictObject({ primary: z.enum(['accuracy', 'brierScore']).optional() }).optional(),
  train: trainSchema.optional(),
  budgetUsd: z.number().positive().optional(),
  compliance: z.strictObject({ area: z.string().min(1), includeRessalvas: z.boolean().optional() }).optional(),
  piiMode: z.enum(['redact', 'synthetic']).optional(),
  /** O usuário revisou dado de aparência real e confirma seguir (pseudonimizado) — CLI `--allow-pii`. */
  allowPii: z.boolean().optional(),
});

export type JevConfigFile = z.infer<typeof jevConfigSchema>;

export interface JevConfigIssue {
  path: string;
  message: string;
}

export type ParseJevConfigResult =
  | { ok: true; config: JevConfigFile }
  | { ok: false; error: string; issues: JevConfigIssue[] };

/** Um JSON é (ou diz ser) um jev-config? */
export function isJevConfig(json: unknown): boolean {
  return isPlainObject(json) && json.format === JEV_CONFIG_FORMAT;
}

/** Valida a FORMA de um jev-config@1. Nunca lança. */
export function parseJevConfig(json: unknown): ParseJevConfigResult {
  if (!isPlainObject(json)) {
    return { ok: false, error: 'config deve ser um objeto JSON', issues: [{ path: '', message: 'não é um objeto' }] };
  }
  if (json.format !== JEV_CONFIG_FORMAT) {
    const f = typeof json.format === 'string' ? json.format : 'ausente';
    return { ok: false, error: `formato "${f}" não é ${JEV_CONFIG_FORMAT}`, issues: [{ path: 'format', message: `esperado ${JEV_CONFIG_FORMAT}` }] };
  }
  const r = jevConfigSchema.safeParse(json);
  if (r.success) return { ok: true, config: r.data };
  const issues = r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
  const partes = issues.slice(0, 4).map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));
  const resto = issues.length - partes.length;
  return { ok: false, error: `${partes.join('; ')}${resto > 0 ? ` (+${resto} erros)` : ''}`, issues };
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

type QuestionInput = z.infer<typeof questionSchema>;

function questionFrom(id: string, raw: QuestionInput): JevQuestionSpec {
  const q = { id, type: raw.type, instructions: raw.instructions, criteria: raw.criteria } as Record<string, unknown>;
  if (raw.keyMap) q.keyMap = raw.keyMap;
  if (raw.guard) q.guard = true;
  if (q.criteria === undefined) delete q.criteria;
  return q as unknown as JevQuestionSpec;
}

/** Identidade de uma definição: o que o MODELO vê (perguntas + projeção). */
export function specIdOf(spec: Pick<JevSpec, 'questions' | 'stateView'>): string {
  const qs = spec.questions.map((q) => ({ ...q }));
  return contentHash({ questions: qs, stateView: spec.stateView ?? null }).slice(0, 'sha256:'.length + 16);
}

/** Recalcula o id (depois de mutar perguntas/projeção). */
export function withSpecId(spec: Omit<JevSpec, 'id'> & { id?: string }): JevSpec {
  return { ...spec, id: specIdOf(spec) } as JevSpec;
}

export function specFromInput(input: JevConfigFile['spec'], label?: string): JevSpec {
  const questions = Object.entries(input.questions).map(([id, q]) => questionFrom(id, q));
  return withSpecId({
    label: label ?? input.label ?? 'original',
    questions,
    ...(input.stateView ? { stateView: input.stateView } : {}),
    ...(input.policy ? { policy: input.policy as JevSpec['policy'] } : {}),
    origin: { kind: 'user' },
  });
}

/** Variante = base + perguntas SUBSTITUÍDAS por id (e/ou projeção/política). */
export function applySpecPatch(base: JevSpec, patch: z.infer<typeof specPatchSchema>, label: string): JevSpec {
  const repl = new Map(Object.entries(patch.questions ?? {}).map(([id, q]) => [id, questionFrom(id, q)]));
  const questions = base.questions.map((q) => repl.get(q.id) ?? q);
  for (const [id, q] of repl) if (!base.questions.some((b) => b.id === id)) questions.push(q);
  return withSpecId({
    label,
    questions,
    ...(patch.stateView ? { stateView: patch.stateView } : base.stateView ? { stateView: base.stateView } : {}),
    ...(patch.policy ? { policy: patch.policy as JevSpec['policy'] } : base.policy ? { policy: base.policy } : {}),
    origin: { kind: 'variant', parentId: base.id },
  });
}

// ---------------------------------------------------------------------------
// Competidores
// ---------------------------------------------------------------------------

/** Rótulo curto de um modelo (`typesafe/jev-1.13` → `jev-1.13`). */
export function shortModel(id: string): string {
  const s = id.replace(/^~/, '');
  return s.includes('/') ? s.slice(s.indexOf('/') + 1) : s;
}

/**
 * Competidores = (spec + variantes) × modelos de decisão, mais spec base ×
 * LLMs. Ids determinísticos; o 1º é o CONTROLE.
 */
export function buildContestants(cfg: JevConfigFile, specs: readonly JevSpec[]): JevContestant[] {
  const out: JevContestant[] = [];
  const decisao = cfg.models.decision?.length ? cfg.models.decision : cfg.models.llm?.length ? [] : [DEFAULT_DECISION_MODEL];
  for (const s of specs) {
    for (const m of decisao) {
      out.push({
        id: `d:${s.label}@${m}`,
        label: `${shortModel(m)} · ${s.label}`,
        kind: 'decision',
        modelId: m,
        specId: s.id,
        probabilitySource: 'native',
      });
    }
  }
  const base = specs[0];
  for (const l of cfg.models.llm ?? []) {
    const esforco = l.reasoning ?? 'default';
    out.push({
      id: `l:${base.label}@${l.modelId}#${esforco}`,
      label: l.label ?? `${shortModel(l.modelId)}${l.reasoning ? ` (${l.reasoning})` : ''} · ${base.label}`,
      kind: 'llm',
      modelId: l.modelId,
      specId: base.id,
      ...(l.reasoning ? { reasoning: l.reasoning } : {}),
      temperature: l.temperature ?? 0,
      batching: l.batching ?? 'per-question',
      ...(l.maxTokens ? { maxTokens: l.maxTokens } : {}),
      probabilitySource: 'verbalized',
    });
  }
  if (out.length) out[0] = { ...out[0], isControl: true };
  return out;
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  /** O verbo do CLI (`jev eval|compare|train`) sobrescreve `mode`. */
  mode?: JevMode;
  repeats?: number;
  /** Casos JÁ carregados (CLI leu `cases.path`); ausente = casos inline do config. */
  cases?: JevCase[];
  allowPii?: boolean;
}

export type ResolveResult =
  | { ok: true; resolved: ResolvedJevConfig; issues: JevLintIssue[] }
  | { ok: false; issues: JevLintIssue[] };

/**
 * Config válido na forma → config RESOLVIDO: specs com id, competidores,
 * casos normalizados (ouro por tipo) com ids e splits, hashes. Regras de modo:
 *   - eval: exatamente 1 competidor (1 spec × 1 modelo de decisão, sem LLM);
 *   - compare: ≥ 2 competidores (o 1º é o controle);
 *   - train: `train` presente, 1 modelo de decisão, sem LLM nem variantes.
 */
export function resolveJevConfig(cfg: JevConfigFile, opts: ResolveOptions = {}): ResolveResult {
  const issues: JevLintIssue[] = [];
  const err = (code: string, message: string, path?: string): void => {
    issues.push({ level: 'error', code, message, ...(path ? { path } : {}) });
  };
  const warn = (code: string, message: string): void => {
    issues.push({ level: 'warning', code, message });
  };
  const mode: JevMode = opts.mode ?? cfg.mode ?? ((cfg.models.decision?.length ?? 1) + (cfg.models.llm?.length ?? 0) + (cfg.variants?.length ?? 0) > 1 ? 'compare' : 'eval');

  const base = specFromInput(cfg.spec);
  const specs: JevSpec[] = [base];
  for (const v of cfg.variants ?? []) {
    const s = applySpecPatch(base, v.spec, v.label);
    if (specs.some((x) => x.label === s.label)) err('variant.label', `rótulo de variante repetido "${s.label}"`, 'variants');
    if (s.id === base.id) warn('variant.identical', `a variante "${v.label}" é idêntica à definição original (mesmo id).`);
    const qBase = new Set(base.questions.map((q) => q.id));
    const extra = s.questions.filter((q) => !qBase.has(q.id)).map((q) => q.id);
    if (extra.length) err('variant.questions', `a variante "${v.label}" cria perguntas novas (${extra.join(', ')}) — variantes só REESCREVEM perguntas existentes.`, 'variants');
    specs.push(s);
  }
  const contestants = buildContestants(cfg, specs);

  if (mode === 'eval' && contestants.length !== 1) {
    err('mode.eval', `modo eval exige exatamente 1 competidor (1 definição × 1 modelo de decisão); há ${contestants.length} — use compare.`);
  }
  if (mode === 'compare' && contestants.length < 2) {
    err('mode.compare', 'modo compare exige ao menos 2 competidores (variantes, modelos de decisão ou LLMs).');
  }
  if (mode === 'train') {
    if (!cfg.train) err('mode.train', 'modo train exige o bloco `train`.', 'train');
    if ((cfg.models.decision?.length ?? 0) > 1) err('mode.train', 'modo train evolui a definição para UM modelo de decisão.', 'models.decision');
    if (cfg.models.llm?.length) err('mode.train', 'modo train não aceita LLMs como competidores (compare-os depois, com a campeã).', 'models.llm');
    if (cfg.variants?.length) err('mode.train', 'modo train gera as próprias variantes: remova `variants`.', 'variants');
    const ops = cfg.train?.operators ?? JEV_TRAIN_OPERATORS_V1;
    const fora = ops.filter((o) => !JEV_TRAIN_OPERATORS_V1.includes(o));
    if (fora.length) err('train.operators', `operadores ainda não disponíveis nesta versão: ${fora.join(', ')} (v1: ${JEV_TRAIN_OPERATORS_V1.join(', ')}).`, 'train.operators');
    const needsRewriter = ops.some((o) => o !== 'add_examples');
    if (needsRewriter && !cfg.train?.rewriterModelId) {
      err('train.rewriter', 'operadores com proponente (add_not_for/describe_option/literalize) exigem `train.rewriterModelId`.', 'train.rewriterModelId');
    }
  } else if (cfg.train) {
    warn('train.ignored', `bloco \`train\` ignorado no modo ${mode}.`);
  }
  const qIds = new Set(base.questions.map((q) => q.id));
  for (const t of cfg.train?.targetQuestions ?? []) {
    if (!qIds.has(t)) err('train.target', `pergunta-alvo "${t}" não existe na definição.`, 'train.targetQuestions');
    else if (base.questions.find((q) => q.id === t)?.guard) err('train.target', `"${t}" é pergunta de guarda (invisível ao otimizador).`, 'train.targetQuestions');
  }

  // Casos: carregados pelo chamador ou inline.
  let cases: JevCase[] = [];
  if (opts.cases) cases = opts.cases;
  else if (Array.isArray(cfg.cases)) {
    const parsed = parseJevDataset(JSON.stringify(cfg.cases), 'json', base);
    issues.push(...parsed.issues);
    cases = parsed.cases;
  } else {
    err('cases.path_unresolved', `cases.path ("${cfg.cases.path}") precisa ser lido pelo CLI — aqui só casos inline.`, 'cases');
  }

  const fit = cfg.fit ?? mode === 'eval';
  const splitCfg = cfg.split ?? {};
  const seed = splitCfg.seed ?? 1;
  let holdoutRatio = splitCfg.holdoutRatio ?? (mode === 'train' ? 0.3 : 0);
  let calibrationRatio = splitCfg.calibrationRatio ?? (mode === 'train' ? 0.2 : fit ? 0.3 : 0);
  if (mode !== 'train') holdoutRatio = splitCfg.holdoutRatio ?? 0;
  if (mode === 'train' && cases.length < MIN_CASES_FOR_CALIB_SPLIT && splitCfg.calibrationRatio === undefined) {
    calibrationRatio = 0;
    warn('split.calib_on_train', `${cases.length} casos (< ${MIN_CASES_FOR_CALIB_SPLIT}): a calibração é ajustada no próprio treino — o relatório avisa.`);
  }
  const semSplit = cases.every((c) => !c.split);
  cases = assignSplits(cases, { holdoutRatio, calibrationRatio, seed, stratifyBy: splitCfg.stratifyBy, spec: base });
  if (semSplit && mode !== 'train' && holdoutRatio === 0 && calibrationRatio === 0) {
    cases = cases.map((c) => ({ ...c, split: 'train' as const }));
  }
  if (mode === 'train') {
    const n = splitCounts(cases);
    if (n.holdout < 10) warn('split.holdout_weak', `holdout com ${n.holdout} caso(s) (< 10): a confirmação final sai "fraca".`);
  }

  const bands: JevBandDefaults = {
    noul: cfg.bands?.noul ?? DEFAULT_BANDS.noul,
    choice: cfg.bands?.choice ?? DEFAULT_BANDS.choice,
    score: cfg.bands?.score ?? DEFAULT_BANDS.score,
  };
  if (bands.noul.hitl <= 0.5) {
    warn('bands.noul_hitl', 'hitl de noul ≤ 0,5: a certeza max(p,1−p) nunca fica abaixo disso — a noul NUNCA abstém.');
  }
  const targetPrecision = cfg.train?.targetPrecision ?? cfg.targetPrecision ?? DEFAULT_TARGET_PRECISION;
  const alvo = cfg.train?.targetQuestions ?? base.questions.filter((q) => !q.guard).map((q) => q.id);
  if (issues.some((i) => i.level === 'error')) return { ok: false, issues };

  const resolved: ResolvedJevConfig = {
    format: JEV_CONFIG_FORMAT,
    mode,
    theme: cfg.theme?.trim() || 'Decisões tipadas',
    ...(cfg.language ? { language: cfg.language } : {}),
    specs,
    contestants,
    cases,
    repeats: opts.repeats ?? (mode === 'train' ? (cfg.train?.repeats ?? 2) : (cfg.repeats ?? 1)),
    scoreTolerance: cfg.scoreTolerance ?? DEFAULT_SCORE_TOLERANCE,
    bands,
    targetPrecision,
    fit,
    primary: cfg.compare?.primary ?? (contestants.some((c) => c.kind === 'llm') ? 'accuracy' : 'brierScore'),
    split: { holdoutRatio, calibrationRatio, seed, ...(splitCfg.stratifyBy ? { stratifyBy: splitCfg.stratifyBy } : {}) },
    ...(mode === 'train'
      ? {
          train: {
            iterations: cfg.train?.iterations ?? 3,
            variantsPerIteration: cfg.train?.variantsPerIteration ?? 3,
            repeats: cfg.train?.repeats ?? 2,
            ...(cfg.train?.rewriterModelId ? { rewriterModelId: cfg.train.rewriterModelId } : {}),
            targetQuestions: alvo,
            metric: cfg.train?.metric ?? 'brier-cal',
            minGainPp: cfg.train?.minGainPp ?? 1,
            maxAccuracyDropPp: cfg.train?.maxAccuracyDropPp ?? 2,
            operators: [...(cfg.train?.operators ?? JEV_TRAIN_OPERATORS_V1)],
            patience: cfg.train?.patience ?? 2,
            targetPrecision,
            ...(cfg.train?.maxCostIncreasePct !== undefined ? { maxCostIncreasePct: cfg.train.maxCostIncreasePct } : {}),
          },
        }
      : {}),
    ...(cfg.budgetUsd !== undefined ? { budgetUsd: cfg.budgetUsd } : {}),
    ...(cfg.compliance ? { compliance: { area: cfg.compliance.area, includeRessalvas: cfg.compliance.includeRessalvas ?? false } } : {}),
    ...(cfg.piiMode ? { piiMode: cfg.piiMode } : {}),
    ...(opts.allowPii || cfg.allowPii ? { allowPii: true } : {}),
    specHash: contentHash(specs.map((s) => s.id)),
    datasetHash: datasetHash(cases),
  };
  return { ok: true, resolved, issues };
}

/** O config resolvido SEM casos/specs/competidores (vai no record). */
export function snapshotOf(r: ResolvedJevConfig): ResolvedJevConfigSnapshot {
  const { cases: _c, specs: _s, contestants: _k, ...resto } = r;
  return resto;
}

/**
 * A visão de COMPLIANCE (LGPD + PII) de uma run JEV — o que o pré-voo
 * (`enforceRunCompliance`) varre (crítica A1.7/A1.8):
 *   - todos os modelos que VEEM o dado: competidores (decisão e LLM) e o
 *     proponente do treino como `optimizerModelId` (papel `rewriter`);
 *   - o CONTEÚDO: instruções/rubricas e os ESTADOS dos casos serializados em
 *     texto (assim uma chave como `clienteId` não esconde um CPF do scanner,
 *     que pula chaves `*Id`);
 *   - `piiMode`/`allowPii` como o resto do produto.
 */
export function jevComplianceView(r: ResolvedJevConfig): ComplianceConfigLike & PiiConfigLike & Record<string, unknown> {
  return {
    ...(r.compliance ? { compliance: r.compliance } : {}),
    competitorModelIds: [...new Set(r.contestants.map((c) => c.modelId))],
    ...(r.train?.rewriterModelId ? { optimizerModelId: r.train.rewriterModelId } : {}),
    ...(r.piiMode ? { piiMode: r.piiMode } : {}),
    ...(r.allowPii ? { allowPii: true } : {}),
    theme: r.theme,
    definicoes: r.specs.map((s) => ({
      rotulo: s.label,
      perguntas: s.questions.map((q) => ({ instrucao: q.instructions, rubrica: (q as { criteria?: unknown }).criteria ?? null })),
    })),
    casos: r.cases.map((c) => ({ estado: typeof c.state === 'string' ? c.state : JSON.stringify(c.state) })),
  };
}
