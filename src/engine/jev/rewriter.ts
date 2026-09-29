// Modo JEV — geração de variantes da definição (§11.2): operador determinístico
// (`add_examples`, grátis) e o PROPONENTE (LLM, role `rewriter`, pelo gateway
// único) para `literalize`/`describe_option`/`add_not_for`.
//
// O proponente recebe {pergunta, operador, dossiê do TREINO, regras do Jev} e
// devolve SÓ o JSON da pergunta; o contrato never-break (`checkVariantContract`)
// decide se a variante chega a ser avaliada. Ele nunca vê `calib`/`holdout`
// nem perguntas de guarda.

import { countTextTokens, type OpenRouterGateway } from '../../openrouter.js';
import type { CostSink } from '../../types.js';
import type { CriterionEntry, JevCase, JevOperatorId, JevQuestionSpec, JevSpec } from './types.js';
import type { JevDossier } from './dossier.js';
import { canonicalLabel, expectedList, isPlainObject, projectState, wireKeysOf } from './wire.js';
import { withSpecId } from './config.js';
import { extractJsonObject } from './llmRender.js';

/** Teto de tokens de exemplos por pergunta (cada token de exemplo é pago em TODO request). */
export const EXAMPLES_TOKEN_BUDGET = 600;
/** Tamanho máximo de um exemplo (estado projetado, em caracteres). */
export const EXAMPLE_MAX_CHARS = 240;

function exemploDe(c: JevCase, spec: JevSpec): string {
  const st = projectState(c.state, spec.stateView);
  const t = typeof st === 'string' ? st : JSON.stringify(st);
  return t.length > EXAMPLE_MAX_CHARS ? `${t.slice(0, EXAMPLE_MAX_CHARS)}…` : t;
}

/** Rubrica → objeto {what, …} preservando o que já havia. */
function comoObjeto(r: CriterionEntry | undefined): Record<string, unknown> {
  if (isPlainObject(r)) return { ...r };
  if (typeof r === 'string' && r.trim()) return { what: r };
  if (Array.isArray(r) && r.length) return { what: r };
  return {};
}

function comExemplos(r: CriterionEntry | undefined, exemplos: string[]): Record<string, unknown> {
  const o = comoObjeto(r);
  o.examples = exemplos;
  return o;
}

/** Rótulo-ouro → chave onde o exemplo entra (choice: chave do fio; noul: "true"/"false"; score: índice). */
function slotsDe(q: JevQuestionSpec): string[] {
  if (q.type === 'choice') return wireKeysOf(q);
  if (q.type === 'noul') return ['true', 'false'];
  return Array.from({ length: Array.isArray(q.criteria) ? q.criteria.length : 0 }, (_, i) => String(i));
}

function slotDoOuro(q: JevQuestionSpec, gold: unknown): string | undefined {
  if (q.type === 'choice') return wireKeysOf(q).find((k) => canonicalLabel(q, k) === gold);
  if (q.type === 'noul') return gold === true ? 'true' : gold === false ? 'false' : undefined;
  return typeof gold === 'number' ? String(gold) : undefined;
}

/**
 * `add_examples` (J10): até `perSlot` exemplos por opção/nível, SÓ do split de
 * treino, balanceados, os mais curtos primeiro, dentro de ~600 tokens por
 * pergunta. Devolve a spec nova e os ids de caso usados (saem do gate).
 */
export function addExamples(
  spec: JevSpec,
  qid: string,
  trainCases: readonly JevCase[],
  perSlot: number,
): { spec: JevSpec; exampleCaseIds: string[] } | null {
  const q = spec.questions.find((x) => x.id === qid);
  if (!q) return null;
  const porSlot = new Map<string, JevCase[]>();
  for (const c of trainCases) {
    if (c.split !== 'train') continue;
    const gold = expectedList(c.expected[qid]);
    if (gold.length !== 1) continue; // alternativas: exemplo ambíguo
    const slot = slotDoOuro(q, gold[0]);
    if (slot === undefined) continue;
    let l = porSlot.get(slot);
    if (!l) porSlot.set(slot, (l = []));
    l.push(c);
  }
  for (const l of porSlot.values()) l.sort((a, b) => exemploDe(a, spec).length - exemploDe(b, spec).length || (a.id < b.id ? -1 : 1));
  const escolhidos = new Map<string, JevCase[]>();
  let tokens = 0;
  // Round-robin por slot: balanceado, sob o teto de tokens.
  for (let i = 0; i < perSlot; i++) {
    for (const slot of slotsDe(q)) {
      const c = porSlot.get(slot)?.[i];
      if (!c) continue;
      const t = countTextTokens(exemploDe(c, spec)) + 2;
      if (tokens + t > EXAMPLES_TOKEN_BUDGET) continue;
      tokens += t;
      let l = escolhidos.get(slot);
      if (!l) escolhidos.set(slot, (l = []));
      l.push(c);
    }
  }
  if (!escolhidos.size) return null;
  const ids: string[] = [];
  let nova: JevQuestionSpec;
  if (q.type === 'choice') {
    const criteria: Record<string, CriterionEntry> = {};
    for (const k of wireKeysOf(q)) {
      const ex = escolhidos.get(k);
      criteria[k] = ex ? (comExemplos(q.criteria[k], ex.map((c) => exemploDe(c, spec))) as CriterionEntry) : q.criteria[k];
      ex?.forEach((c) => ids.push(c.id));
    }
    nova = { ...q, criteria };
  } else if (q.type === 'noul') {
    const base = q.criteria ?? { true: 'yes', false: 'no' };
    const t = escolhidos.get('true');
    const f = escolhidos.get('false');
    t?.forEach((c) => ids.push(c.id));
    f?.forEach((c) => ids.push(c.id));
    nova = {
      ...q,
      criteria: {
        true: t ? comExemplos(base.true, t.map((c) => exemploDe(c, spec))) : base.true,
        false: f ? comExemplos(base.false, f.map((c) => exemploDe(c, spec))) : base.false,
      },
    };
  } else {
    const criteria = q.criteria.map((lv, i) => {
      const ex = escolhidos.get(String(i));
      ex?.forEach((c) => ids.push(c.id));
      return ex ? (comExemplos(lv, ex.map((c) => exemploDe(c, spec))) as CriterionEntry) : lv;
    });
    nova = { ...q, criteria };
  }
  const out = withSpecId({
    ...spec,
    questions: spec.questions.map((x) => (x.id === qid ? nova : x)),
    origin: { kind: 'deterministic', parentId: spec.id, operatorId: 'add_examples', exampleCaseIds: ids },
  });
  return { spec: out, exampleCaseIds: ids };
}

// ---------------------------------------------------------------------------
// Proponente (LLM)
// ---------------------------------------------------------------------------

export const JEV_REWRITER_SYSTEM_PROMPT = `You edit ONE typed decision question for Jev, a NON-generative decision model (it never writes text; it only picks among the given options/levels and returns probabilities).
Apply ONLY the operator requested, surgically. Everything else stays byte-identical.
Hard rules (a violation discards your edit):
- Keep the question type. Keep EVERY option key of a "choice" exactly (same keys, same set). Keep the NUMBER and ORDER of "score" levels.
- The question id never reaches the model: write the full judgment in "instructions".
- Instructions must be literal, positive ("high = yes") and atomic (one judgment). Avoid implicit negation and vague scope ("usually", "generally").
- For noul, "criteria" (if present) must have BOTH "true" and "false".
- A choice rubric may be a string or an object {"what": ..., "not_for": ..., "examples": [...]}. Keep existing "examples" as they are.
- Refer to state fields by path in backticks only if they exist in the examples shown.
- Keep the language of the original question.
Return ONLY a JSON object: {"instructions": ..., "criteria": ...}.`;

const OPERATOR_TASK: Partial<Record<JevOperatorId, string>> = {
  literalize:
    'OPERATOR literalize: rewrite ONLY "instructions" as a literal, positive, single judgment. Copy "criteria" unchanged.',
  describe_option:
    'OPERATOR describe_option: give every option whose rubric is empty, null or a single word a one-sentence description of the concrete situations it covers. Do not touch "instructions".',
  add_not_for:
    'OPERATOR add_not_for: for the MOST CONFUSED pair listed in the dossier (gold A predicted as B), turn the rubrics of A and B into objects and add a "not_for" to each that states the boundary against the other. Do not touch "instructions" nor other options.',
};

export interface ProposeContext {
  apiKey: string;
  gateway: OpenRouterGateway;
  sink?: CostSink;
  signal?: AbortSignal;
}

export type ProposeResult = { ok: true; question: JevQuestionSpec } | { ok: false; reason: string };

function resumoDossie(d: JevDossier | null): unknown {
  if (!d) return null;
  return {
    accuracy: Number(d.accuracy.toFixed(3)),
    n: d.n,
    most_confused_pairs: d.topConfusions.slice(0, 5),
    wrong_with_high_confidence: d.wrongConfident.slice(0, 6).map((c) => ({ state: c.state, gold: c.gold, predicted: c.predicted, p: c.pTop })),
    right_but_unsure: d.rightUnsure.slice(0, 4).map((c) => ({ state: c.state, gold: c.gold, p: c.pTop })),
  };
}

/**
 * Pede ao proponente UMA pergunta reescrita. O resultado mantém id, tipo,
 * `keyMap` e `guard` da original (só `instructions`/`criteria` vêm do LLM).
 * Sinal de controle atravessa; o resto vira `{ok:false}` (candidato descartado).
 */
export async function proposeQuestionVariant(input: {
  question: JevQuestionSpec;
  operator: JevOperatorId;
  dossier: JevDossier | null;
  rewriterModelId: string;
  ctx: ProposeContext;
}): Promise<ProposeResult> {
  const tarefa = OPERATOR_TASK[input.operator];
  if (!tarefa) return { ok: false, reason: `operador ${input.operator} não tem proponente` };
  const q = input.question;
  const user =
    `${tarefa}\n\nQUESTION (type ${q.type}):\n${JSON.stringify({ instructions: q.instructions, criteria: (q as { criteria?: unknown }).criteria ?? null }, null, 2)}\n\n` +
    `DOSSIER (training split only):\n${JSON.stringify(resumoDossie(input.dossier), null, 2)}\n\nReturn ONLY the JSON object.`;
  const r = await input.ctx.gateway.chatCompletion({
    apiKey: input.ctx.apiKey,
    modelId: input.rewriterModelId,
    messages: [
      { role: 'system', content: JEV_REWRITER_SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
    temperature: 0.4,
    maxTokens: 2048,
    responseFormatJson: true,
    role: 'rewriter',
    sink: input.ctx.sink,
    signal: input.ctx.signal,
  });
  const obj = extractJsonObject(r.text);
  if (!isPlainObject(obj)) return { ok: false, reason: 'proponente não devolveu JSON' };
  const instructions = obj.instructions ?? q.instructions;
  const criteria = 'criteria' in obj ? obj.criteria : (q as { criteria?: unknown }).criteria;
  const nova = { ...q, instructions, criteria } as JevQuestionSpec;
  if (q.type === 'noul' && (criteria === null || criteria === undefined)) delete (nova as { criteria?: unknown }).criteria;
  return { ok: true, question: nova };
}

/** Spec com UMA pergunta trocada (origem registrada). */
export function withQuestion(spec: JevSpec, q: JevQuestionSpec, origin: JevSpec['origin']): JevSpec {
  return withSpecId({ ...spec, questions: spec.questions.map((x) => (x.id === q.id ? q : x)), origin });
}
