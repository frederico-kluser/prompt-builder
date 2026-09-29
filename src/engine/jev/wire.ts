// Modo JEV — o FIO: montagem do corpo de decisão, projeção do estado, leitura
// dos dois formatos de erro 400 e validação defensiva da resposta. Puro (sem
// rede): o gateway (`decide` em src/openrouter.ts) é quem fala com o endpoint.
//
// Regras verificadas ao vivo (ver agent-docs/jev.md):
//   - `noul.criteria` é opcional, mas quando vem exige AS DUAS chaves
//     (`true` e `false`), não nulas — o simulador local mandava só a preenchida
//     e a API recusava com 400 (bug que NÃO é portado aqui);
//   - rubrica `null` numa opção de `choice` é aceita (autoexplicativa);
//   - níveis de `score` vão em ordem (baixo → alto; índice = nível);
//   - `temperature`/`max_tokens`/`user` nunca vão (o endpoint ignora/recusa).

import type {
  CriterionEntry,
  DecisionsIssue,
  DecisionsRequest,
  JevCase,
  JevExpected,
  JevQuestionSpec,
  JevSpec,
  JevState,
  JevStateView,
  JevWireAnswer,
  JevWireQuestion,
} from './types.js';

/** Id de pergunta: contrato de código e coluna do CSV (a API aceita qualquer um; nós não). */
export const JEV_QUESTION_ID_RE = /^[A-Za-z0-9_.-]{1,96}$/;
/** Limites do fio (API ao vivo + docs). */
export const JEV_LIMITS = {
  CHOICE_MAX_OPTIONS: 255,
  SCORE_MAX_LEVELS: 10,
  SESSION_ID_MAX: 256,
  QUESTIONS_WARN: 64,
} as const;

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Rótulos: chave no fio × rótulo canônico (J3)
// ---------------------------------------------------------------------------

/** Chaves de opção no FIO (ordem de inserção do `criteria`). */
export function wireKeysOf(q: JevQuestionSpec): string[] {
  if (q.type !== 'choice' || !isPlainObject(q.criteria)) return [];
  return Object.keys(q.criteria);
}

/** Chave no fio → rótulo canônico do ouro (`keyMap`; ausente = identidade). */
export function canonicalLabel(q: JevQuestionSpec, wireKey: string): string {
  if (q.type !== 'choice') return wireKey;
  return q.keyMap?.[wireKey] ?? wireKey;
}

/** Rótulo canônico → chave no fio (inverso do `keyMap`). */
export function wireKeyOf(q: JevQuestionSpec, label: string): string | undefined {
  if (q.type !== 'choice') return undefined;
  for (const k of wireKeysOf(q)) if (canonicalLabel(q, k) === label) return k;
  return undefined;
}

/** Rótulos canônicos de uma `choice`, na ordem do fio. */
export function canonicalLabelsOf(q: JevQuestionSpec): string[] {
  return wireKeysOf(q).map((k) => canonicalLabel(q, k));
}

/** Nº de níveis de um `score` (0 fora de score / criteria inválido). */
export function levelCountOf(q: JevQuestionSpec): number {
  return q.type === 'score' && Array.isArray(q.criteria) ? q.criteria.length : 0;
}

/**
 * Espaço de rótulos de uma pergunta como texto estável (contrato never-break
 * do treino): tipo + rótulos canônicos ordenados | nº de níveis.
 */
export function labelSpaceOf(q: JevQuestionSpec): string {
  if (q.type === 'choice') return `choice:${[...canonicalLabelsOf(q)].sort().join('|')}`;
  if (q.type === 'score') return `score:${levelCountOf(q)}`;
  return 'noul';
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

/** Lê `a.b[2].c` de um valor (caminho vazio ou `$` = o valor inteiro). */
export function getPath(value: unknown, path: string): unknown {
  const p = path.trim();
  if (!p || p === '$') return value;
  const partes = p.replace(/^\$\.?/, '').match(/[^.[\]]+|\[\d+\]/g) ?? [];
  let cur: unknown = value;
  for (const parte of partes) {
    if (cur === null || cur === undefined) return undefined;
    if (/^\[\d+\]$/.test(parte)) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(parte.slice(1, -1))];
    } else {
      if (typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[parte];
    }
  }
  return cur;
}

function truncar(v: unknown, maxChars: number | undefined): unknown {
  if (maxChars === undefined || !(maxChars > 0)) return v;
  if (typeof v === 'string') return v.length > maxChars ? `${v.slice(0, maxChars)}…` : v;
  if (v !== null && typeof v === 'object') {
    const texto = JSON.stringify(v);
    return texto.length > maxChars ? `${texto.slice(0, maxChars)}…` : v;
  }
  return v;
}

/**
 * Projeção do estado (J8): só os campos listados, renomeados, truncados por
 * `maxChars`. Sem `stateView` (ou com estado texto) o estado vai como está.
 * Campo ausente no caso some da projeção (nunca vira "null" inventado).
 */
export function projectState(state: JevState, view: JevStateView | undefined): JevState {
  if (!view || !Array.isArray(view.fields) || view.fields.length === 0) return state;
  if (typeof state === 'string') {
    const inteiro = view.fields.find((f) => !f.from.trim() || f.from.trim() === '$');
    if (!inteiro) return state;
    return { [inteiro.as]: truncar(state, inteiro.maxChars) };
  }
  const out: Record<string, unknown> = {};
  for (const f of view.fields) {
    const v = getPath(state, f.from);
    if (v === undefined) continue;
    out[f.as] = truncar(v, f.maxChars);
  }
  return out;
}

/** Profundidade de aninhamento (estado muito fundo é recusado: `state.too_deep`). */
export function depthOf(value: unknown, limit = 64): number {
  const visit = (v: unknown, d: number): number => {
    if (d > limit || v === null || typeof v !== 'object') return d;
    let max = d;
    const filhos = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
    for (const x of filhos) max = Math.max(max, visit(x, d + 1));
    return max;
  };
  return visit(value, 0);
}

// ---------------------------------------------------------------------------
// Corpo
// ---------------------------------------------------------------------------

/**
 * Pergunta no formato do fio. `noul` SÓ leva `criteria` com as duas chaves; o
 * lint recusa antes a meia rubrica (a API devolve 400 `invalid_union`).
 */
export function toWireQuestion(q: JevQuestionSpec): JevWireQuestion {
  if (q.type === 'noul') {
    const c = q.criteria;
    if (isPlainObject(c) && c.true !== undefined && c.false !== undefined && c.true !== null && c.false !== null) {
      return { type: 'noul', instructions: q.instructions, criteria: { true: c.true, false: c.false } };
    }
    return { type: 'noul', instructions: q.instructions };
  }
  if (q.type === 'choice') {
    const criteria: Record<string, CriterionEntry> = {};
    if (isPlainObject(q.criteria)) {
      for (const [k, v] of Object.entries(q.criteria)) criteria[k] = v === undefined ? null : (v as CriterionEntry);
    }
    return { type: 'choice', instructions: q.instructions, criteria };
  }
  return {
    type: 'score',
    instructions: q.instructions,
    criteria: Array.isArray(q.criteria) ? [...q.criteria] : [],
  };
}

/** Mapa `questions` do fio para as perguntas pedidas (todas, por default). */
export function wireQuestionsOf(spec: JevSpec, qids?: readonly string[]): Record<string, JevWireQuestion> {
  const alvo = qids ? new Set(qids) : null;
  const out: Record<string, JevWireQuestion> = {};
  for (const q of spec.questions) {
    if (alvo && !alvo.has(q.id)) continue;
    out[q.id] = toWireQuestion(q);
  }
  return out;
}

/** O corpo inteiro (o `jev export --request` e o `jev.mjs ask --file` consomem isto). */
export function buildDecisionsRequest(
  spec: JevSpec,
  state: JevState,
  opts: { model: string; sessionId?: string; qids?: readonly string[] },
): DecisionsRequest {
  const req: DecisionsRequest = {
    model: opts.model,
    state: projectState(state, spec.stateView),
    questions: wireQuestionsOf(spec, opts.qids),
  };
  if (opts.sessionId?.trim()) req.session_id = opts.sessionId.trim().slice(0, JEV_LIMITS.SESSION_ID_MAX);
  return req;
}

/**
 * Spec a partir de um `DecisionsRequest` cru (import de `evals.json` da skill,
 * `jev validate` num corpo de requisição). Perguntas na ordem do mapa.
 */
export function specFromWireQuestions(
  questions: Record<string, unknown>,
  label = 'importada',
): Omit<JevSpec, 'id'> {
  const qs: JevQuestionSpec[] = [];
  for (const [id, raw] of Object.entries(questions)) {
    const q = (isPlainObject(raw) ? raw : {}) as Record<string, unknown>;
    qs.push({ id, type: q.type, instructions: q.instructions, criteria: q.criteria } as unknown as JevQuestionSpec);
  }
  return { label, questions: qs };
}

// ---------------------------------------------------------------------------
// Erros do fio
// ---------------------------------------------------------------------------

function pathText(p: unknown): string {
  if (Array.isArray(p)) return p.map((x) => String(x)).join('.');
  return typeof p === 'string' ? p : '';
}

/**
 * Lê os DOIS formatos de 400 do endpoint (verificados ao vivo):
 *   - edge (validação do gateway, ~50 ms): `error.message` é um ARRAY de
 *     problemas serializado em string (TODOS os problemas, com `path`);
 *   - upstream (provedor, ~250 ms): `error.message = "HTTP 400: {\"detail\":…}"`
 *     — só o PRIMEIRO problema, sem caminho.
 * Qualquer outra coisa vira um problema `local` com o texto (recortado).
 */
export function parseDecisionsError(status: number, bodyText: string): DecisionsIssue[] {
  let msg = '';
  try {
    const json = JSON.parse(bodyText) as { error?: { message?: unknown } | string; detail?: unknown };
    const e = json?.error;
    if (typeof e === 'string') msg = e;
    else if (e && typeof e === 'object' && typeof e.message === 'string') msg = e.message;
    else if (typeof json?.detail === 'string') msg = json.detail;
  } catch {
    msg = bodyText;
  }
  const texto = msg.trim();
  if (texto.startsWith('[')) {
    try {
      const issues = JSON.parse(texto) as unknown;
      if (Array.isArray(issues)) {
        return issues.map((it) => {
          const o = (isPlainObject(it) ? it : {}) as Record<string, unknown>;
          return {
            layer: 'edge' as const,
            path: pathText(o.path),
            ...(typeof o.code === 'string' ? { code: o.code } : {}),
            message: typeof o.message === 'string' ? o.message : JSON.stringify(o).slice(0, 300),
          };
        });
      }
    } catch {
      // cai no genérico abaixo
    }
  }
  const up = /^HTTP\s+(\d{3}):\s*(\{[\s\S]*\})\s*$/.exec(texto);
  if (up) {
    let detail = up[2];
    try {
      const d = JSON.parse(up[2]) as { detail?: unknown };
      if (typeof d.detail === 'string') detail = d.detail;
      else if (d.detail !== undefined) detail = JSON.stringify(d.detail);
    } catch {
      // mantém o texto cru
    }
    return [{ layer: 'upstream', path: '', code: `http_${up[1]}`, message: detail.slice(0, 500) }];
  }
  return [
    {
      layer: 'local',
      path: '',
      code: `http_${status}`,
      message: (texto || bodyText || `HTTP ${status}`).replace(/\s+/g, ' ').slice(0, 500),
    },
  ];
}

/**
 * O 400 é uma recusa de ESQUEMA DAS PERGUNTAS pelo edge? Só isso autoriza o
 * fail-fast "spec recusada" do runner (A3.4): 400 upstream genérico, 400 de
 * `provider` (roteamento sensível) ou de estado NÃO param o competidor.
 */
export function isSpecRejection(issues: readonly DecisionsIssue[]): boolean {
  return issues.length > 0 && issues.every((i) => i.layer === 'edge' && /^questions(\.|$)/.test(i.path));
}

/** Extrai o corpo de erro que o gateway pôs na mensagem (`OpenRouter falhou (HTTP 400): …`). */
export function errorBodyFromMessage(message: string): string {
  const i = message.indexOf(': ');
  return i >= 0 ? message.slice(i + 2) : message;
}

// ---------------------------------------------------------------------------
// Validação da resposta (port defensivo de validate.mjs da jev-agent-skill)
// ---------------------------------------------------------------------------

export interface ResponseValidation {
  /** Pergunta → código do erro de contrato (a resposta dela conta ERRADA). */
  invalid: Record<string, string>;
  /** Respostas normalizadas (só as válidas). */
  answers: Record<string, JevWireAnswer>;
  warnings: { questionId: string; code: string; message: string }[];
  notes: { questionId: string; code: string; message: string }[];
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function probsOf(v: unknown): Record<string, number> | undefined {
  if (!isPlainObject(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v)) {
    const n = num(x);
    if (n === undefined || n < -1e-9 || n > 1 + 1e-9) return undefined;
    out[k] = Math.min(1, Math.max(0, n));
  }
  return out;
}

/**
 * Valida cada resposta contra a pergunta ENVIADA. Erros de contrato
 * (`answer.missing`, `answer.type_mismatch`, `noul.range`,
 * `choice.not_in_criteria`, `score.missing`, …) marcam a pergunta como
 * inválida — ela conta ERRADA, nunca "sem nota". Probabilidades ausentes ou
 * malformadas NÃO invalidam (o schema as declara opcionais): viram aviso e a
 * pontuação cai no one-hot.
 */
export function validateDecisionsResponse(
  questions: Record<string, JevWireQuestion>,
  answers: Record<string, unknown>,
): ResponseValidation {
  const out: ResponseValidation = { invalid: {}, answers: {}, warnings: [], notes: [] };
  for (const [qid, q] of Object.entries(questions)) {
    const a = answers[qid];
    if (!isPlainObject(a)) {
      out.invalid[qid] = 'answer.missing';
      continue;
    }
    if (a.type !== q.type) {
      out.invalid[qid] = 'answer.type_mismatch';
      continue;
    }
    if (q.type === 'noul') {
      const p = num(a.noul);
      if (p === undefined || p < 0 || p > 1) {
        out.invalid[qid] = 'noul.range';
        continue;
      }
      if (p > 0.4 && p < 0.6) out.notes.push({ questionId: qid, code: 'noul.ambiguous', message: `noul=${p} ≈ 50/50` });
      out.answers[qid] = { type: 'noul', noul: p };
      continue;
    }
    const conf = num(a.confidence);
    if (a.confidence !== undefined && (conf === undefined || conf < 0 || conf > 1)) {
      out.invalid[qid] = `${q.type}.confidence_range`;
      continue;
    }
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      if (typeof a.choice !== 'string' || !a.choice) {
        out.invalid[qid] = 'choice.missing';
        continue;
      }
      if (!keys.includes(a.choice)) {
        out.invalid[qid] = 'choice.not_in_criteria';
        continue;
      }
      const probs = probsOf(a.probabilities);
      if (a.probabilities !== undefined && !probs) {
        out.warnings.push({ questionId: qid, code: 'probabilities.range', message: 'probabilidade fora de [0,1] — ignorada' });
      }
      if (probs) {
        const soma = Object.values(probs).reduce((s, x) => s + x, 0);
        if (Math.abs(soma - 1) > 0.02) {
          out.warnings.push({ questionId: qid, code: 'probabilities.sum', message: `distribuição soma ${soma.toFixed(3)}` });
        }
        const faltam = keys.filter((k) => !(k in probs));
        if (faltam.length) {
          out.warnings.push({ questionId: qid, code: 'probabilities.coverage', message: `opções sem probabilidade: ${faltam.slice(0, 5).join(', ')}` });
        }
      } else if (a.probabilities === undefined) {
        out.warnings.push({ questionId: qid, code: 'choice.no_probabilities', message: 'sem probabilities — one-hot' });
      }
      out.answers[qid] = {
        type: 'choice',
        choice: a.choice,
        ...(probs ? { probabilities: probs } : {}),
        ...(conf !== undefined ? { confidence: conf } : {}),
      };
      continue;
    }
    // score
    const levels = Array.isArray(q.criteria) ? q.criteria.length : 0;
    const s = num(a.score);
    if (s === undefined) {
      out.invalid[qid] = 'score.missing';
      continue;
    }
    if (s < -1e-9 || s > Math.max(0, levels - 1) + 1e-9) {
      out.invalid[qid] = 'score.out_of_scale';
      continue;
    }
    const probs = probsOf(a.probabilities);
    if (probs) {
      const fora = Object.keys(probs).filter((k) => !/^\d+$/.test(k) || Number(k) >= levels);
      if (fora.length) out.warnings.push({ questionId: qid, code: 'score.legend_key', message: `níveis inexistentes: ${fora.join(', ')}` });
    } else if (a.probabilities === undefined) {
      out.warnings.push({ questionId: qid, code: 'score.no_probabilities', message: 'sem probabilities — one-hot' });
    }
    out.answers[qid] = {
      type: 'score',
      score: s,
      ...(probs ? { probabilities: probs } : {}),
      ...(conf !== undefined ? { confidence: conf } : {}),
    };
  }
  for (const qid of Object.keys(answers)) {
    if (!(qid in questions)) out.notes.push({ questionId: qid, code: 'answer.extra', message: 'resposta não pedida (ignorada)' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ouro
// ---------------------------------------------------------------------------

/** Alternativas aceitas de um rótulo-ouro (lista ou valor único). */
export function expectedList(v: JevExpected | JevExpected[] | undefined): JevExpected[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** O caso tem ouro para a pergunta? */
export function hasGold(c: JevCase, qid: string): boolean {
  return expectedList(c.expected[qid]).length > 0;
}
