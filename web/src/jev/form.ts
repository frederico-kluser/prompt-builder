// Estado do formulário "Nova run JEV" — PURO (sem React, testável em Node).
//
// A fonte da verdade do formulário é o PRÓPRIO `jev-config@1` (rascunho): o
// que a tela edita é exatamente o que "Exportar JSON" grava e o que o CLI/MCP
// aceitam — import/export idênticos entre UI e CLI (§3.1), sem um segundo
// modelo de estado que pudesse perder campo em silêncio. Os casos vão INLINE
// (no navegador não há `cases.path`).

import {
  DEFAULT_DECISION_MODEL,
  JEV_CONFIG_FORMAT,
  NO_MATCH_KEY_RE,
  canonicalLabel,
  expectedList,
  lintJevSpec,
  parseJevConfig,
  specFromInput,
  splitCounts,
  type JevLintIssue,
  type JevMode,
  type JevPrimitive,
  type JevSpec,
  type ResolvedJevConfig,
} from '../engine/jev';
import type { OpenRouterModel } from '../../../src/types.js';

export interface QuestionInput {
  type: string;
  instructions?: unknown;
  criteria?: unknown;
  keyMap?: Record<string, string>;
  guard?: boolean;
}

export interface LlmInput {
  modelId: string;
  label?: string;
  reasoning?: string;
  temperature?: number;
  batching?: 'per-question' | 'per-case';
  maxTokens?: number;
}

export interface JevDraft {
  format: typeof JEV_CONFIG_FORMAT;
  mode: JevMode;
  theme?: string;
  language?: string;
  spec: { label?: string; questions: Record<string, QuestionInput>; stateView?: unknown; policy?: unknown };
  variants?: { label: string; spec: { questions?: Record<string, QuestionInput>; stateView?: unknown; policy?: unknown } }[];
  /** Inline (vazio enquanto o usuário não importa). */
  cases: unknown[];
  models: { decision?: string[]; llm?: LlmInput[] };
  repeats?: number;
  scoreTolerance?: number;
  split?: { holdoutRatio?: number; calibrationRatio?: number; seed?: number; stratifyBy?: string };
  bands?: Partial<Record<JevPrimitive, { auto: number; hitl: number }>>;
  targetPrecision?: number;
  fit?: boolean;
  compare?: { primary?: 'accuracy' | 'brierScore' };
  train?: Record<string, unknown>;
  budgetUsd?: number;
  compliance?: { area: string; includeRessalvas?: boolean };
  piiMode?: 'redact' | 'synthetic';
  allowPii?: boolean;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Rascunho inicial: uma pergunta sim/não vazia, Jev fixado, sem casos. */
export function emptyDraft(): JevDraft {
  return {
    format: JEV_CONFIG_FORMAT,
    mode: 'eval',
    theme: '',
    spec: {
      label: 'original',
      questions: {
        decisao: {
          type: 'noul',
          instructions: '',
          criteria: { true: '', false: '' },
        },
      },
    },
    cases: [],
    models: { decision: [DEFAULT_DECISION_MODEL] },
    repeats: 1,
  };
}

export type DraftFromJson = { ok: true; draft: JevDraft; notice?: string } | { ok: false; error: string };

/**
 * JSON importado → rascunho. Aceita o `jev-config@1` com casos inline. Com
 * `cases.path` (só vale no CLI) mantém o resto e avisa: os casos são
 * importados no passo "Casos".
 */
export function draftFromJson(json: unknown): DraftFromJson {
  const p = parseJevConfig(json);
  if (!p.ok) return { ok: false, error: `jev-config@1 inválido: ${p.error}` };
  const cfg = clone(p.config) as unknown as JevDraft & { cases: unknown };
  let notice: string | undefined;
  if (!Array.isArray(cfg.cases)) {
    notice = `O arquivo aponta os casos por caminho (cases.path = "${(cfg.cases as { path?: string }).path ?? ''}") — isso só vale no terminal. Importe o arquivo de casos no passo "Casos".`;
    cfg.cases = [];
  }
  cfg.mode = cfg.mode ?? 'eval';
  return { ok: true, draft: cfg as JevDraft, ...(notice ? { notice } : {}) };
}

/** Rascunho → `jev-config@1` limpo (o que "Exportar JSON" grava). */
export function draftToConfig(d: JevDraft): Record<string, unknown> {
  const out: Record<string, unknown> = { format: JEV_CONFIG_FORMAT, mode: d.mode };
  if (d.theme?.trim()) out.theme = d.theme.trim();
  if (d.language) out.language = d.language;
  out.spec = clone(d.spec);
  if (d.variants?.length) out.variants = clone(d.variants);
  out.cases = clone(d.cases);
  const models: Record<string, unknown> = {};
  if (d.models.decision?.length) models.decision = [...d.models.decision];
  if (d.models.llm?.length) models.llm = clone(d.models.llm);
  out.models = models;
  for (const k of ['repeats', 'scoreTolerance', 'split', 'bands', 'targetPrecision', 'fit', 'compare', 'train', 'budgetUsd', 'compliance', 'piiMode', 'allowPii'] as const) {
    const v = d[k];
    if (v !== undefined && v !== null && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)) out[k] = clone(v);
  }
  return out;
}

/** A definição do rascunho como `JevSpec` (para lint/preview). Nunca lança. */
export function specOfDraft(d: Pick<JevDraft, 'spec'>): JevSpec | null {
  try {
    return specFromInput(d.spec as never);
  } catch {
    return null;
  }
}

/** Lint AO VIVO da definição (sem casos/catálogo: o do Iniciar é completo). */
export function lintDraftSpec(d: JevDraft, decisionModel?: OpenRouterModel): JevLintIssue[] {
  const spec = specOfDraft(d);
  if (!spec) return [{ level: 'error', code: 'questions.empty', message: 'definição ilegível.' }];
  return lintJevSpec(spec, {
    ...(decisionModel ? { model: decisionModel } : {}),
    modelId: d.models.decision?.[0],
    mode: d.mode,
    ...(d.mode === 'train' && Array.isArray(d.train?.targetQuestions) ? { targetQuestions: d.train!.targetQuestions as string[] } : {}),
  });
}

// ---------------------------------------------------------------------------
// Perguntas (mapa ordenado: a ordem de inserção é a ordem do fio)
// ---------------------------------------------------------------------------

type QMap = Record<string, QuestionInput>;

export function defaultCriteria(type: string): unknown {
  if (type === 'noul') return { true: '', false: '' };
  if (type === 'choice') return { opcao_a: '', opcao_b: '', outro: 'Nenhuma das opções acima' };
  return ['Baixo', 'Médio', 'Alto'];
}

/** Um id livre (`pergunta_2`, `pergunta_3`…). */
export function freeQuestionId(qs: QMap, base = 'pergunta'): string {
  let i = Object.keys(qs).length + 1;
  while (`${base}_${i}` in qs) i++;
  return `${base}_${i}`;
}

export function addQuestion(qs: QMap, type: JevPrimitive): QMap {
  return { ...qs, [freeQuestionId(qs)]: { type, instructions: '', criteria: defaultCriteria(type) } };
}

export function removeQuestion(qs: QMap, id: string): QMap {
  const out: QMap = {};
  for (const [k, v] of Object.entries(qs)) if (k !== id) out[k] = v;
  return out;
}

/** Renomeia preservando a ORDEM (mapa reconstruído). Id repetido não renomeia. */
export function renameQuestion(qs: QMap, from: string, to: string): QMap {
  if (from === to || (to in qs && to !== from)) return qs;
  const out: QMap = {};
  for (const [k, v] of Object.entries(qs)) out[k === from ? to : k] = v;
  return out;
}

export function moveQuestion(qs: QMap, id: string, delta: -1 | 1): QMap {
  const ents = Object.entries(qs);
  const i = ents.findIndex(([k]) => k === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ents.length) return qs;
  [ents[i], ents[j]] = [ents[j], ents[i]];
  return Object.fromEntries(ents);
}

export function patchQuestion(qs: QMap, id: string, patch: Partial<QuestionInput>): QMap {
  if (!(id in qs)) return qs;
  const q = { ...qs[id], ...patch };
  for (const k of Object.keys(q) as (keyof QuestionInput)[]) if (q[k] === undefined) delete q[k];
  return { ...qs, [id]: q };
}

/** Troca o tipo: a rubrica recomeça no formato do tipo novo (o espaço de rótulos muda). */
export function setQuestionType(qs: QMap, id: string, type: JevPrimitive): QMap {
  const q = qs[id];
  if (!q || q.type === type) return qs;
  const { keyMap: _k, ...resto } = q;
  return { ...qs, [id]: { ...resto, type, criteria: defaultCriteria(type) } };
}

// ---- opções de choice (mapa ordenado) ----

type Crit = Record<string, unknown>;

export function renameOption(c: Crit, from: string, to: string): Crit {
  if (from === to) return c;
  const out: Crit = {};
  for (const [k, v] of Object.entries(c)) out[k === from ? to : k] = v;
  return out;
}

export function addOption(c: Crit): Crit {
  let i = Object.keys(c).length + 1;
  while (`opcao_${i}` in c) i++;
  return { ...c, [`opcao_${i}`]: '' };
}

export function removeOption(c: Crit, key: string): Crit {
  const out: Crit = {};
  for (const [k, v] of Object.entries(c)) if (k !== key) out[k] = v;
  return out;
}

export function moveOption(c: Crit, key: string, delta: -1 | 1): Crit {
  const ents = Object.entries(c);
  const i = ents.findIndex(([k]) => k === key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ents.length) return c;
  [ents[i], ents[j]] = [ents[j], ents[i]];
  return Object.fromEntries(ents);
}

/** Rubrica estruturada `{what, not_for, examples}` (J4) ou texto. */
export interface StructuredRubric {
  what: string;
  not_for: string;
  examples: string[];
}

export function isStructuredRubric(v: unknown): v is Partial<StructuredRubric> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && ('what' in v || 'not_for' in v || 'examples' in v);
}

/** Converte texto ↔ estruturada sem perder o texto. */
export function toggleStructured(v: unknown): unknown {
  if (isStructuredRubric(v)) {
    const partes = [v.what ?? '', v.not_for ? `Não é: ${v.not_for}` : ''].filter(Boolean);
    return partes.join('. ');
  }
  return { what: typeof v === 'string' ? v : '', not_for: '', examples: [] };
}

/** Opção de "saída" (J5)? */
export function isExitKey(key: string): boolean {
  return NO_MATCH_KEY_RE.test(key.trim());
}

// ---- níveis de score (lista ordenada baixo → alto) ----

export function moveLevel(levels: unknown[], i: number, delta: -1 | 1): unknown[] {
  const j = i + delta;
  if (j < 0 || j >= levels.length) return levels;
  const out = [...levels];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

// ---------------------------------------------------------------------------
// Objetivo (modo) → preset dos participantes
// ---------------------------------------------------------------------------

/**
 * Escolher o objetivo aplica o preset que o modo exige (sem apagar a definição
 * nem os casos): eval = 1 competidor; train = 1 modelo de decisão, sem LLM nem
 * variantes, com o bloco `train` (só o operador determinístico por default —
 * nenhum proponente pago); compare mantém tudo.
 */
export function applyMode(d: JevDraft, mode: JevMode): JevDraft {
  const out: JevDraft = { ...d, mode };
  const decisao = d.models.decision?.length ? d.models.decision : [DEFAULT_DECISION_MODEL];
  if (mode === 'eval') {
    out.models = { decision: [decisao[0]] };
    delete out.variants;
    delete out.train;
  } else if (mode === 'train') {
    out.models = { decision: [decisao[0]] };
    delete out.variants;
    const alvo = Object.entries(d.spec.questions)
      .filter(([, q]) => !q.guard)
      .map(([id]) => id);
    out.train = {
      iterations: 2,
      variantsPerIteration: 2,
      repeats: 1,
      targetQuestions: alvo.slice(0, 1),
      operators: ['add_examples'],
      metric: 'brier-cal',
      ...(d.train ?? {}),
    };
    out.split = { holdoutRatio: 0.3, seed: 1, ...(d.split ?? {}) };
  } else {
    delete out.train;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Casos: distribuição e splits (prévia)
// ---------------------------------------------------------------------------

export interface LabelBar {
  label: string;
  n: number;
}

/** Distribuição do ouro por pergunta (rótulo canônico → n). */
export function labelDistribution(r: Pick<ResolvedJevConfig, 'cases' | 'specs'>): Record<string, LabelBar[]> {
  const spec = r.specs[0];
  const out: Record<string, LabelBar[]> = {};
  for (const q of spec?.questions ?? []) {
    const conta = new Map<string, number>();
    for (const c of r.cases) {
      for (const v of expectedList(c.expected[q.id])) {
        let k: string;
        if (q.type === 'noul') k = v === true ? 'sim' : 'não';
        else if (q.type === 'score') {
          const lv = Array.isArray(q.criteria) ? q.criteria[Number(v)] : undefined;
          k = `${String(v)}${typeof lv === 'string' ? ` · ${lv.slice(0, 28)}` : ''}`;
        } else k = canonicalLabel(q, String(v));
        conta.set(k, (conta.get(k) ?? 0) + 1);
      }
    }
    out[q.id] = [...conta.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  }
  return out;
}

export function splitPreview(r: Pick<ResolvedJevConfig, 'cases'>): Record<'train' | 'calib' | 'holdout', number> {
  return splitCounts(r.cases);
}

/** Prévia curta do estado de um caso (a tabela mostra 20 linhas). */
export function statePreview(state: unknown, max = 120): string {
  const t = typeof state === 'string' ? state : JSON.stringify(state);
  const s = (t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------------------
// Pendências (rodapé + passo de revisão)
// ---------------------------------------------------------------------------

export type JevStep = 'objetivo' | 'decisao' | 'casos' | 'participantes' | 'limites';

export interface JevProblem {
  step: JevStep;
  text: string;
  code?: string;
}

const STEP_OF_CODE: [RegExp, JevStep][] = [
  [/^question\.no_gold/, 'casos'],
  [/^(question|questions|noul|choice|score|keymap|path|language)/, 'decisao'],
  [/^(state|expected|labels|cases?|dataset|split|import|jev\.dataset_too_small)/, 'casos'],
  [/^(mode|variant|model|budget\.context|budget\.total)/, 'participantes'],
  [/^(train|bands|budget)/, 'limites'],
];

export function stepOfIssue(i: Pick<JevLintIssue, 'code'>): JevStep {
  for (const [re, step] of STEP_OF_CODE) if (re.test(i.code)) return step;
  return 'decisao';
}

/** Pendências que BLOQUEIAM o Iniciar, na ordem dos passos. */
export function draftProblems(d: JevDraft, issues: readonly JevLintIssue[], opts: { hasKey: boolean }): JevProblem[] {
  const out: JevProblem[] = [];
  if (Object.keys(d.spec.questions).length === 0) out.push({ step: 'decisao', text: 'Adicione ao menos uma pergunta à definição.' });
  if (d.cases.length === 0) out.push({ step: 'casos', text: 'Importe ou cole os casos rotulados (o modo JEV mede contra o rótulo-ouro).' });
  const vistos = new Set<string>();
  for (const i of issues) {
    if (i.level !== 'error') continue;
    const k = `${i.code}|${i.message}`;
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push({ step: stepOfIssue(i), text: `${i.questionId ? `${i.questionId}: ` : ''}${i.message}`, code: i.code });
  }
  if (!opts.hasKey) out.push({ step: 'limites', text: 'Conecte a sua chave da OpenRouter em Configurações.' });
  const ordem: JevStep[] = ['objetivo', 'decisao', 'casos', 'participantes', 'limites'];
  return out.sort((a, b) => ordem.indexOf(a.step) - ordem.indexOf(b.step));
}

/** "Modo JEV" é a escolha lembrada? (`?tipo=` > handoffs LLM > `pb.benchKind`). */
export type BenchKind = 'llm' | 'jev';

export const BENCH_KIND_KEY = 'pb.benchKind';

/**
 * Qual lado do seletor abre. Precedência (crítica A4.1): `?tipo=` explícito;
 * depois os handoffs que IMPLICAM LLM (`?objetivo=` vindo do /welcome e o
 * rascunho da biblioteca `arena:prompt-draft`) — senão o usuário cairia no JEV
 * e perderia o que escolheu; por fim a escolha lembrada; default LLM.
 */
export function initialBenchKind(search: string, storage: Pick<Storage, 'getItem'> | null): BenchKind {
  const q = new URLSearchParams(search);
  const tipo = q.get('tipo');
  if (tipo === 'jev' || tipo === 'llm') return tipo;
  if (q.get('objetivo')) return 'llm';
  try {
    if (storage?.getItem('arena:prompt-draft')) return 'llm';
    const lembrado = storage?.getItem(BENCH_KIND_KEY);
    if (lembrado === 'jev' || lembrado === 'llm') return lembrado;
  } catch {
    // localStorage indisponível (privado/bloqueado): segue o default.
  }
  return 'llm';
}
