// Modo JEV — datasets rotulados (§4.3): JSONL, CSV, `jev-dataset@1` e o
// `evals.json` da jev-agent-skill; normalização do ouro por tipo; ids estáveis;
// splits estratificados e determinísticos. Puro (texto entra, casos saem): o
// CLI lê o arquivo, a SPA importa o texto.
//
// Rótulo sintético é armadilha (D-14): o modo MEDE, então a v1 só aceita ouro
// importado (ou os exemplos embarcados). Geração por IA fica para o chunk 3.

import { contentHash } from '../hash.js';
import { mulberry32 } from '../../stats.js';
import type { JevCase, JevExpected, JevLintIssue, JevQuestionSpec, JevSpec, JevSplit, JevState } from './types.js';
import { canonicalLabel, canonicalLabelsOf, expectedList, isPlainObject, specFromWireQuestions, wireKeysOf } from './wire.js';

export const JEV_DATASET_FORMAT = 'jev-dataset@1';
export type DatasetFormat = 'jsonl' | 'csv' | 'json' | 'auto';
/** Id de caso aceito (vira caminho de chave e coluna). */
export const JEV_CASE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface ParsedDataset {
  cases: JevCase[];
  issues: JevLintIssue[];
  /** Spec extraída do arquivo (evals.json da skill traz as perguntas em cada caso). */
  spec?: Omit<JevSpec, 'id'>;
  format: 'jsonl' | 'csv' | 'jev-dataset' | 'json-array' | 'skill-evals';
}

// ---------------------------------------------------------------------------
// Distância de edição local (NÃO o `closestMatch` de src/cli/context.ts, que
// importa `node:*` e quebraria o grafo do navegador).
// ---------------------------------------------------------------------------

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Candidato mais próximo (≤ 1/3 do tamanho em edições) ou `undefined`. */
export function suggestLabel(input: string, candidates: readonly string[]): string | undefined {
  const x = input.trim().toLowerCase();
  let best: { c: string; d: number } | undefined;
  for (const c of candidates) {
    const d = editDistance(x, c.toLowerCase());
    if (!best || d < best.d) best = { c, d };
  }
  if (!best) return undefined;
  return best.d <= Math.max(1, Math.floor(best.c.length / 3)) ? best.c : undefined;
}

// ---------------------------------------------------------------------------
// Normalização do ouro
// ---------------------------------------------------------------------------

const TRUE_WORDS = new Set(['true', 'sim', 's', 'yes', 'y', '1', 'verdadeiro', 'v']);
const FALSE_WORDS = new Set(['false', 'não', 'nao', 'n', 'no', '0', 'falso', 'f']);

export type NormalizeResult = { ok: true; value: JevExpected } | { ok: false; message: string };

/**
 * Um valor-ouro cru → valor canônico da pergunta:
 *   - noul: true/false/sim/não/yes/no/1/0;
 *   - choice: rótulo canônico (aceita também a CHAVE do fio e resolve pelo `keyMap`);
 *   - score: índice inteiro 0..L−1 OU o texto EXATO do nível.
 */
export function normalizeExpected(q: JevQuestionSpec, raw: unknown): NormalizeResult {
  if (q.type === 'noul') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    if (typeof raw === 'number' && (raw === 0 || raw === 1)) return { ok: true, value: raw === 1 };
    if (typeof raw === 'string') {
      const t = raw.trim().toLowerCase();
      if (TRUE_WORDS.has(t)) return { ok: true, value: true };
      if (FALSE_WORDS.has(t)) return { ok: true, value: false };
    }
    return { ok: false, message: `noul espera true/false (ou sim/não, 1/0), veio ${JSON.stringify(raw)}` };
  }
  if (q.type === 'choice') {
    if (typeof raw !== 'string' && typeof raw !== 'number') {
      return { ok: false, message: `choice espera o rótulo da opção, veio ${JSON.stringify(raw)}` };
    }
    const v = String(raw).trim();
    const labels = canonicalLabelsOf(q);
    if (labels.includes(v)) return { ok: true, value: v };
    // Chave do fio (antes do keyMap) é aceita e traduzida.
    if (wireKeysOf(q).includes(v)) return { ok: true, value: canonicalLabel(q, v) };
    const ci = labels.find((l) => l.toLowerCase() === v.toLowerCase());
    if (ci) return { ok: true, value: ci };
    const sug = suggestLabel(v, labels);
    return {
      ok: false,
      message: `rótulo "${v}" não é opção de "${q.id}" (${labels.slice(0, 12).join(', ')})${sug ? ` — você quis dizer "${sug}"?` : ''}`,
    };
  }
  const levels = Array.isArray(q.criteria) ? q.criteria : [];
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < levels.length) return { ok: true, value: raw };
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (/^\d+$/.test(t) && Number(t) < levels.length) return { ok: true, value: Number(t) };
    const idx = levels.findIndex((lv) => typeof lv === 'string' && lv.trim() === t);
    if (idx >= 0) return { ok: true, value: idx };
  }
  return { ok: false, message: `score de "${q.id}" espera um nível inteiro 0..${levels.length - 1} (ou o texto exato do nível), veio ${JSON.stringify(raw)}` };
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Id estável de um caso sem id: hash do estado (o mesmo estado = o mesmo id). */
export function caseIdFor(state: JevState): string {
  return `c-${contentHash({ state }).slice('sha256:'.length, 'sha256:'.length + 16)}`;
}

/** Hash do dataset (casos + ouro + splits): a identidade do experimento. */
export function datasetHash(cases: readonly JevCase[]): string {
  return contentHash(cases.map((c) => ({ id: c.id, state: c.state, expected: c.expected, split: c.split ?? null })));
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

interface RawCase {
  id?: unknown;
  name?: unknown;
  state?: unknown;
  expected?: unknown;
  split?: unknown;
  tags?: unknown;
  language?: unknown;
  questions?: unknown;
}

const SPLITS = new Set(['train', 'calib', 'holdout']);

function csvRows(text: string): { rows: string[][]; lines: number[] } {
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) {
        rows.push(row);
        lines.push(rowLine);
      }
      row = [];
      line++;
      rowLine = line;
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    if (row.some((c) => c.trim() !== '')) {
      rows.push(row);
      lines.push(rowLine);
    }
  }
  return { rows, lines };
}

function setDeep(obj: Record<string, unknown>, path: string, value: unknown): void {
  const partes = path.split('.');
  let cur = obj;
  for (let i = 0; i < partes.length - 1; i++) {
    const p = partes[i];
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[partes[partes.length - 1]] = value;
}

function detectFormat(text: string): 'jsonl' | 'csv' | 'json' {
  const t = text.trimStart();
  if (t.startsWith('[')) return 'json';
  if (t.startsWith('{')) {
    const linhas = t.split('\n').filter((l) => l.trim());
    // JSONL: mais de uma linha e a PRIMEIRA já é um objeto completo (linhas
    // quebradas depois viram erro com número de linha, não "JSON inválido").
    if (linhas.length > 1) {
      try {
        const v = JSON.parse(linhas[0]) as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v)) return 'jsonl';
      } catch {
        return 'json';
      }
    }
    return 'json';
  }
  return 'csv';
}

/**
 * Texto → casos. Nunca lança: problemas saem em `issues` com linha/coluna.
 * `spec` é necessária para normalizar o ouro (sem ela o ouro fica como veio
 * e o `lintJevCases` reclama depois); o `evals.json` da skill traz a própria.
 */
export function parseJevDataset(text: string, fmt: DatasetFormat = 'auto', spec?: Omit<JevSpec, 'id'>): ParsedDataset {
  const issues: JevLintIssue[] = [];
  const kind = fmt === 'auto' ? detectFormat(text) : fmt;
  let raws: { raw: RawCase; line?: number }[] = [];
  let format: ParsedDataset['format'] = 'json-array';
  let specOut: Omit<JevSpec, 'id'> | undefined;

  if (kind === 'jsonl') {
    format = 'jsonl';
    text.split('\n').forEach((l, i) => {
      if (!l.trim()) return;
      try {
        const v = JSON.parse(l) as unknown;
        if (!isPlainObject(v)) throw new Error('linha não é um objeto');
        raws.push({ raw: v as RawCase, line: i + 1 });
      } catch (err) {
        issues.push({ level: 'error', code: 'dataset.invalid_json', line: i + 1, column: 1, message: `linha ${i + 1}: JSON inválido (${(err as Error).message}).` });
      }
    });
  } else if (kind === 'csv') {
    format = 'csv';
    const { rows, lines } = csvRows(text.replace(/^﻿/, ''));
    if (rows.length === 0) {
      issues.push({ level: 'error', code: 'dataset.empty', message: 'CSV vazio.' });
    } else {
      const header = rows[0].map((h) => h.trim());
      const temEstado = header.some((h) => h === 'state' || h.startsWith('state.'));
      if (!temEstado) {
        issues.push({ level: 'error', code: 'dataset.csv_header', line: lines[0], column: 1, message: 'CSV sem coluna `state` (ou `state.<campo>`).' });
      }
      for (let r = 1; r < rows.length; r++) {
        const obj: RawCase = {};
        const expected: Record<string, unknown> = {};
        let state: unknown;
        const stateObj: Record<string, unknown> = {};
        header.forEach((h, c) => {
          const cell = rows[r][c] ?? '';
          if (h === 'id') obj.id = cell.trim() || undefined;
          else if (h === 'state') state = cell;
          else if (h.startsWith('state.')) {
            if (cell !== '') setDeep(stateObj, h.slice('state.'.length), cell);
          } else if (h.startsWith('expected.')) {
            const v = cell.trim();
            if (v !== '') expected[h.slice('expected.'.length)] = v.includes('|') ? v.split('|').map((x) => x.trim()) : v;
          } else if (h === 'split') obj.split = cell.trim() || undefined;
          else if (h === 'tags') obj.tags = cell.split(';').map((x) => x.trim()).filter(Boolean);
          else if (h === 'language') obj.language = cell.trim() || undefined;
          else if (h) {
            issues.push({ level: 'warning', code: 'dataset.csv_column', line: lines[0], column: c + 1, message: `coluna desconhecida "${h}" ignorada.` });
          }
        });
        obj.state = state !== undefined ? state : Object.keys(stateObj).length ? stateObj : undefined;
        obj.expected = expected;
        raws.push({ raw: obj, line: lines[r] });
      }
      // avisos de coluna desconhecida só uma vez por coluna
      const vistos = new Set<string>();
      for (let i = issues.length - 1; i >= 0; i--) {
        const it = issues[i];
        if (it.code !== 'dataset.csv_column') continue;
        const k = `${it.column}`;
        if (vistos.has(k)) issues.splice(i, 1);
        vistos.add(k);
      }
    }
  } else {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch (err) {
      issues.push({ level: 'error', code: 'dataset.invalid_json', line: 1, column: 1, message: `JSON inválido: ${(err as Error).message}` });
      return { cases: [], issues, format: 'json-array' };
    }
    let arr: unknown[] = [];
    if (isPlainObject(v) && v.format === JEV_DATASET_FORMAT && Array.isArray(v.cases)) {
      format = 'jev-dataset';
      arr = v.cases;
    } else if (Array.isArray(v)) {
      arr = v;
      const skill = arr.length > 0 && arr.every((x) => isPlainObject(x) && isPlainObject(x.questions) && 'state' in x);
      format = skill ? 'skill-evals' : 'json-array';
    } else if (isPlainObject(v) && Array.isArray(v.cases)) {
      format = 'jev-dataset';
      arr = v.cases;
    } else {
      issues.push({ level: 'error', code: 'dataset.shape', message: `esperado uma lista de casos ou {format:"${JEV_DATASET_FORMAT}", cases:[…]}.` });
    }
    raws = arr.map((x, i) => ({ raw: (isPlainObject(x) ? x : {}) as RawCase, line: undefined, idx: i })) as { raw: RawCase; line?: number }[];
    if (format === 'skill-evals') {
      // As perguntas vêm DENTRO de cada caso: precisam ser idênticas por id.
      const porId = new Map<string, string>();
      const perguntas: Record<string, unknown> = {};
      raws.forEach(({ raw }, i) => {
        for (const [qid, q] of Object.entries(raw.questions as Record<string, unknown>)) {
          const assinatura = JSON.stringify(q);
          const antes = porId.get(qid);
          if (antes !== undefined && antes !== assinatura) {
            issues.push({
              level: 'error',
              code: 'import.questions_divergent',
              path: `[${i}].questions.${qid}`,
              message: `a pergunta "${qid}" difere entre casos do evals.json — cada id precisa da MESMA definição.`,
            });
          }
          if (antes === undefined) {
            porId.set(qid, assinatura);
            perguntas[qid] = q;
          }
        }
      });
      specOut = specFromWireQuestions(perguntas, 'importada (evals.json)');
    }
  }

  const specUsada = spec ?? specOut;
  const qById = new Map((specUsada?.questions ?? []).map((q) => [q.id, q]));
  const cases: JevCase[] = [];
  const idsVistos = new Set<string>();
  raws.forEach(({ raw, line }, i) => {
    const onde = line !== undefined ? `linha ${line}` : `caso ${i + 1}`;
    const st = raw.state;
    let state: JevState;
    if (typeof st === 'string' || isPlainObject(st) || Array.isArray(st)) state = st as JevState;
    else {
      issues.push({ level: 'error', code: 'state.empty', line, column: 1, message: `${onde}: sem \`state\` (texto, objeto ou lista).` });
      return;
    }
    if ((typeof state === 'string' && !state.trim()) || (isPlainObject(state) && Object.keys(state).length === 0)) {
      issues.push({ level: 'error', code: 'state.empty', line, column: 1, message: `${onde}: estado vazio (a API aceita E cobra).` });
      return;
    }
    const idRaw = raw.id ?? raw.name;
    let id = typeof idRaw === 'string' || typeof idRaw === 'number' ? String(idRaw).trim() : '';
    if (id && !JEV_CASE_ID_RE.test(id)) {
      issues.push({ level: 'warning', code: 'case.id', line, column: 1, message: `${onde}: id "${id}" fora de ^[A-Za-z0-9_.:-]{1,128}$ — trocado pelo hash do estado.` });
      id = '';
    }
    if (!id) id = caseIdFor(state);
    if (idsVistos.has(id)) {
      issues.push({ level: 'warning', code: 'case.duplicate', line, column: 1, message: `${onde}: caso "${id}" duplicado — mantido o primeiro.` });
      return;
    }
    idsVistos.add(id);
    const expected: Record<string, JevExpected | JevExpected[]> = {};
    if (raw.expected !== undefined && !isPlainObject(raw.expected)) {
      issues.push({ level: 'error', code: 'expected.invalid', line, column: 1, message: `${onde}: \`expected\` deve ser { pergunta: valor }.` });
    }
    for (const [qid, v] of Object.entries(isPlainObject(raw.expected) ? raw.expected : {})) {
      const q = qById.get(qid);
      if (!q) {
        if (specUsada) {
          issues.push({ level: 'error', code: 'expected.unknown_question', line, column: 1, message: `${onde}: ouro para a pergunta inexistente "${qid}".` });
        } else {
          expected[qid] = v as JevExpected;
        }
        continue;
      }
      const lista = Array.isArray(v) ? v : [v];
      const norm: JevExpected[] = [];
      for (const alt of lista) {
        const r = normalizeExpected(q, alt);
        if (r.ok) norm.push(r.value);
        else issues.push({ level: 'error', code: q.type === 'choice' ? 'labels.uncovered' : 'expected.invalid', questionId: qid, line, column: 1, message: `${onde}: ${r.message}.` });
      }
      if (norm.length === 1) expected[qid] = norm[0];
      else if (norm.length > 1) expected[qid] = norm;
    }
    const c: JevCase = { id, state, expected, provenance: { origin: 'import' } };
    if (typeof raw.split === 'string') {
      if (SPLITS.has(raw.split)) c.split = raw.split as JevSplit;
      else issues.push({ level: 'warning', code: 'case.split', line, column: 1, message: `${onde}: split "${raw.split}" desconhecido (train|calib|holdout) — ignorado.` });
    }
    if (Array.isArray(raw.tags)) c.tags = raw.tags.filter((t): t is string => typeof t === 'string');
    if (typeof raw.language === 'string' && raw.language.trim()) c.language = raw.language.trim();
    cases.push(c);
  });
  return { cases, issues, format, ...(specOut ? { spec: specOut } : {}) };
}

// ---------------------------------------------------------------------------
// Splits
// ---------------------------------------------------------------------------

export interface SplitOptions {
  holdoutRatio: number;
  calibrationRatio: number;
  seed: number;
  /** Pergunta cujo ouro estratifica (default: a 1ª não-guard com ouro). */
  stratifyBy?: string;
  spec?: JevSpec;
}

/**
 * Splits train/calib/holdout ESTRATIFICADOS pelo rótulo de `stratifyBy` e
 * DETERMINÍSTICOS (`mulberry32(seed)`). O split pinado pelo usuário vence.
 */
export function assignSplits(cases: readonly JevCase[], opts: SplitOptions): JevCase[] {
  const h = Math.min(0.5, Math.max(0, opts.holdoutRatio));
  const cal = Math.min(0.5, Math.max(0, opts.calibrationRatio));
  const qid =
    opts.stratifyBy ??
    opts.spec?.questions.find((q) => !q.guard && cases.some((c) => expectedList(c.expected[q.id]).length > 0))?.id;
  const estratos = new Map<string, JevCase[]>();
  const out = cases.map((c) => ({ ...c }));
  for (const c of out) {
    if (c.split) continue;
    const alvo = qid ? expectedList(c.expected[qid])[0] : undefined;
    const k = alvo === undefined ? '∅' : String(alvo);
    let lst = estratos.get(k);
    if (!lst) estratos.set(k, (lst = []));
    lst.push(c);
  }
  const rand = mulberry32(opts.seed >>> 0);
  for (const k of [...estratos.keys()].sort()) {
    const lst = estratos.get(k)!.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let i = lst.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [lst[i], lst[j]] = [lst[j], lst[i]];
    }
    const nh = Math.round(lst.length * h);
    const nc = Math.round(lst.length * cal);
    lst.forEach((c, i) => {
      c.split = i < nh ? 'holdout' : i < nh + nc ? 'calib' : 'train';
    });
  }
  return out;
}

/** Contagem por split. */
export function splitCounts(cases: readonly JevCase[]): Record<JevSplit, number> {
  const out: Record<JevSplit, number> = { train: 0, calib: 0, holdout: 0 };
  for (const c of cases) out[c.split ?? 'train'] += 1;
  return out;
}

/** Serializa casos em JSONL (o `jev import -o casos.jsonl`). */
export function toJsonl(cases: readonly JevCase[]): string {
  return cases.map((c) => JSON.stringify({ id: c.id, state: c.state, expected: c.expected, ...(c.split ? { split: c.split } : {}), ...(c.tags?.length ? { tags: c.tags } : {}), ...(c.language ? { language: c.language } : {}) })).join('\n') + (cases.length ? '\n' : '');
}
