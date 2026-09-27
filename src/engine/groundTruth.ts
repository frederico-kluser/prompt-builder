// ----------------------------------------------------------------------------
// Ground-truth determinístico (padrão do prompt-arena `gabaritoSpec kind:'labels'`).
//
// Quando o cenário de teste traz o RÓTULO ESPERADO (`expected`), o veredito da
// resposta não precisa de juiz LLM: a decisão é comparação pura de texto/campo,
// reproduzível e sem custo. Este módulo é fonte única e PURO (sem node:fs, sem
// fetch) — roda igual no CLI, no servidor e no navegador, como `duelCore.ts`.
//
// Import type de `../types.js` é seguro para o bundle do navegador: só tipos,
// zero runtime.
// ----------------------------------------------------------------------------
import type { Verdict } from '../types.js';

// ----------------------------------------------------------------------------
// Tipos
// ----------------------------------------------------------------------------

/** Rótulo esperado: string única, lista de alternativas aceitáveis, ou par campo→valor (resposta JSON). */
export type ExpectedSpec = string | string[] | Record<string, string | number | boolean>;

export interface GroundTruthResult {
  verdict: Verdict;
  /** 1 frase curta em PT-BR explicando o veredito (para o painel "onde falhou"). */
  explanation: string;
  /** Sempre true aqui — marca que o veredito veio de ground-truth, não de juiz LLM. */
  deterministic: true;
}

// ----------------------------------------------------------------------------
// Normalização
// ----------------------------------------------------------------------------

/**
 * Prefixos que modelos escrevem antes do rótulo ("Resposta: edit", "label: sim").
 * Casam sobre a forma já minúscula/sem acentos — por isso "classificacao" e não
 * "classificação". `classificacao` vem antes de `class` na alternância para o
 * regex não parar no prefixo errado.
 */
const LABEL_PREFIX =
  /^(?:resposta(?:\s+(?:esperada|correta))?|label|rotulo|classificacao|classe|class|categoria|answer)\s*:\s*/;

/** Pontuação/aspas só nas BORDAS ("«edit!»" → "edit"). A interna fica: "pt-br" não pode virar "pt br". */
const EDGE_JUNK = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** Tag BCP-47 plausível sobre a forma normalizada (já minúscula): "pt", "pt-br", "zh-hans-cn". */
const LANG_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/;

/** Máximo de palavras de um rótulo para valer a busca standalone (rótulo longo = frase, não token). */
const MAX_STANDALONE_WORDS = 5;

/** Ordem implicita dos vereditos: nao < parcial < resolve. */
const VERDICT_ORDER: Record<Verdict, number> = { nao: 0, parcial: 1, resolve: 2 };

/** Normalização canônica de rótulo: minúsculas, sem acentos, espaços colapsados, sem pontuação/aspas nas bordas, sem prefixos tipo "resposta:"/"label:"/"classificação:". */
export function normalizeLabel(s: string): string {
  // Minúsculas + sem acentos (NFD e marcas combinantes removidas): "Edição" → "edicao".
  let out = s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  out = out.replace(EDGE_JUNK, '');
  // Prefixos de rótulo, até 3x p/ tolerar "resposta: resposta: x"; a pontuação
  // das bordas é refeita depois porque o prefixo pode revelar aspas novas.
  for (let i = 0; i < 3; i += 1) {
    const stripped = out.replace(LABEL_PREFIX, '');
    if (stripped === out) break;
    out = stripped.replace(EDGE_JUNK, '');
  }
  // Quebras de linha viram espaço junto: o texto vira uma sequência de palavras.
  return out.replace(/\s+/g, ' ').trim();
}

// ----------------------------------------------------------------------------
// Idioma BCP-47
// ----------------------------------------------------------------------------

/** Subtag primária de uma tag BCP-47 ("pt-BR" → "pt"); '' quando não há. */
function primarySubtag(tag: string): string {
  const first = tag.trim().split(/[-_]/)[0] ?? '';
  return first.toLowerCase();
}

/** Compara idiomas BCP-47: 'pt-BR' e 'pt' casam no nível de idioma primário; 'en-US' vs 'pt-BR' não casam. */
export function languageMatches(a: string, b: string): boolean {
  const pa = primarySubtag(a);
  const pb = primarySubtag(b);
  return pa !== '' && pa === pb;
}

// ----------------------------------------------------------------------------
// Extração de campo em resposta JSON
// ----------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Fim da região balanceada que começa em `start` ('{' ou '['), respeitando
 * strings e escapes. -1 quando a resposta traz JSON truncado/incompleto.
 */
function balancedEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Candidatos a JSON, do mais externo ao mais interno: o texto inteiro, o
 * conteúdo de cada fence ``` e cada região balanceada a partir de cada '{'/'['.
 * Ordem importa: um campo no objeto externo vence o mesmo campo num objeto
 * aninhado (que também vira candidato ao varrer as chaves).
 */
function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  const trimmed = text.trim();
  if (trimmed !== '') out.push(trimmed);

  const fence = /```(?:json|JSON)?[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const inner = m[1]?.trim();
    if (inner) out.push(inner);
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    const end = balancedEnd(text, i);
    if (end > i) out.push(text.slice(i, end + 1));
  }
  return out;
}

/** Extrai campo de uma resposta que deveria ser JSON (tolera fences ``` e prosa ao redor; retorna undefined se não achar). */
export function extractJsonField(text: string, field: string): unknown {
  if (text.trim() === '' || field === '') return undefined;
  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue; // não era JSON (prosa, fence incompleto, chave truncada)
    }
    if (isRecord(parsed) && field in parsed) return parsed[field];
  }
  return undefined;
}

// ----------------------------------------------------------------------------
// Veredito determinístico
// ----------------------------------------------------------------------------

/** Qualidade do casamento de UMA alternativa contra o texto normalizado. */
type MatchLevel = 'exact' | 'firstLine' | 'language' | 'standalone' | 'substring' | 'none';

function wordCount(s: string): number {
  return s.split(/\s+/).filter((w) => w !== '').length;
}

/**
 * Fronteira de palavra = nem letra nem dígito. "2" não pode casar dentro de
 * "2024" nem "edit" dentro de "2024edit" — por isso a fronteira é alfanumérica
 * e não só "não-letra".
 */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/** O rótulo aparece em `haystack` como palavra/sequência standalone (bordas não-alfanuméricas)? */
function hasStandalone(haystack: string, needle: string): boolean {
  if (needle === '') return false;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const before = idx > 0 ? haystack[idx - 1] : undefined;
    const afterIdx = idx + needle.length;
    const after = afterIdx < haystack.length ? haystack[afterIdx] : undefined;
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = idx + 1;
  }
  return false;
}

/** Primeira linha não-vazia do texto bruto (a normalização da linha decide o caso "Resposta: edit"). */
function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() !== '') return line;
  }
  return '';
}

/** Regras de casamento, NA ORDEM da especificação: exato → primeira linha → idioma → standalone → substring. */
function matchLevel(normText: string, firstLineNorm: string, normAlt: string): MatchLevel {
  if (normText === normAlt) return 'exact';
  if (firstLineNorm !== '' && firstLineNorm === normAlt) return 'firstLine';
  if (LANG_TAG.test(normText) && LANG_TAG.test(normAlt) && languageMatches(normText, normAlt)) {
    return 'language';
  }
  // Rótulos longos demais não casam standalone: 6+ palavras é frase, não token.
  if (wordCount(normAlt) <= MAX_STANDALONE_WORDS && hasStandalone(normText, normAlt)) return 'standalone';
  if (normText.includes(normAlt)) return 'substring';
  return 'none';
}

/** Valor legível na explanation ('42', 'true', 'edit'). */
function display(v: unknown): string {
  return toComparableString(v);
}

function toComparableString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null) return 'null';
  if (v === undefined) return '';
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return String(v);
  }
}

/**
 * Valor extraído × valor esperado: strings comparam normalizadas; números e
 * booleanos comparam por igualdade — tolerando a forma textual equivalente
 * ("42" ≈ 42), que modelos escrevem quando escapam do schema.
 */
function scalarMatches(extracted: unknown, expected: string | number | boolean): boolean {
  if (typeof expected === 'string') {
    return normalizeLabel(toComparableString(extracted)) === normalizeLabel(expected);
  }
  if (typeof expected === 'number') {
    if (typeof extracted === 'number') return extracted === expected;
    if (typeof extracted === 'string') {
      const t = extracted.trim();
      return t !== '' && Number.isFinite(Number(t)) && Number(t) === expected;
    }
    return false;
  }
  if (typeof extracted === 'boolean') return extracted === expected;
  if (typeof extracted === 'string') return extracted.trim().toLowerCase() === String(expected);
  return false;
}

function resolveExplanation(level: MatchLevel, raw: string, rawAlts: string[], normText: string): string {
  let base: string;
  switch (level) {
    case 'exact':
      base = `resposta é exatamente o rótulo esperado '${raw}'`;
      break;
    case 'firstLine':
      base = `primeira linha da resposta casa com o rótulo esperado '${raw}'`;
      break;
    case 'language':
      base = `tag de idioma '${normText}' da resposta casa com o rótulo esperado '${raw}'`;
      break;
    default:
      base = `rótulo esperado '${raw}' encontrado standalone`;
  }
  return rawAlts.length > 1 ? `${base} (alternativas [${rawAlts.join('|')}])` : base;
}

function matchField(
  text: string,
  normText: string,
  field: string,
  value: string | number | boolean,
): { verdict: Verdict; explanation: string } {
  const extracted = extractJsonField(text, field);
  if (extracted !== undefined) {
    if (scalarMatches(extracted, value)) {
      return {
        verdict: 'resolve',
        explanation: `campo '${field}' do JSON confere com o esperado ('${display(value)}')`,
      };
    }
    return {
      verdict: 'nao',
      explanation: `campo '${field}' do JSON diverge: veio '${display(extracted)}', esperado '${display(value)}'`,
    };
  }
  // Sem JSON utilizável: o valor esperado standalone no texto ainda mostra que
  // o modelo sabe a resposta (formato errado) — parcial, nunca resolve.
  const normValue = normalizeLabel(toComparableString(value));
  if (normValue !== '' && wordCount(normValue) <= MAX_STANDALONE_WORDS && hasStandalone(normText, normValue)) {
    return {
      verdict: 'parcial',
      explanation: `sem o campo '${field}' no JSON, mas o valor esperado '${display(value)}' aparece standalone`,
    };
  }
  return {
    verdict: 'nao',
    explanation: `resposta não traz o campo '${field}' nem o valor esperado '${display(value)}'`,
  };
}

function matchObject(text: string, spec: Record<string, string | number | boolean>): GroundTruthResult {
  const fields = Object.entries(spec);
  if (fields.length === 0) {
    return {
      verdict: 'nao',
      explanation: 'sem rótulo esperado (objeto campo→valor vazio)',
      deterministic: true,
    };
  }
  const normText = normalizeLabel(text);
  const results = fields.map(([field, value]) => matchField(text, normText, field, value));
  // Múltiplos campos: o veredito é o PIOR campo — todos precisam conferir.
  const verdict = results.reduce<Verdict>(
    (acc, r) => (VERDICT_ORDER[r.verdict] < VERDICT_ORDER[acc] ? r.verdict : acc),
    'resolve',
  );
  const worst = results.find((r) => r.verdict === verdict) ?? results[0];
  return { verdict, explanation: worst.explanation, deterministic: true };
}

/** Veredito determinístico da resposta contra o rótulo esperado. */
export function matchExpected(text: string, expected: ExpectedSpec): GroundTruthResult {
  if (text.trim() === '') {
    return {
      verdict: 'nao',
      explanation: 'resposta vazia: nada para comparar com o rótulo esperado',
      deterministic: true,
    };
  }

  if (typeof expected === 'object' && !Array.isArray(expected)) {
    return matchObject(text, expected);
  }

  const rawAlts = typeof expected === 'string' ? [expected] : expected;
  const alts = rawAlts.map((raw) => ({ raw, norm: normalizeLabel(raw) })).filter((a) => a.norm !== '');
  if (alts.length === 0) {
    return {
      verdict: 'nao',
      explanation: 'sem rótulo esperado utilizável (alternativas vazias)',
      deterministic: true,
    };
  }

  const normText = normalizeLabel(text);
  const firstLineNorm = normalizeLabel(firstNonEmptyLine(text));
  const list = rawAlts.join('|');

  let parcialHit: string | null = null;
  for (const alt of alts) {
    const level = matchLevel(normText, firstLineNorm, alt.norm);
    if (level === 'none') continue;
    if (level === 'substring') {
      if (parcialHit === null) parcialHit = alt.raw;
      continue; // parcial é o teto desta alternativa; outra ainda pode resolver
    }
    return {
      verdict: 'resolve',
      explanation: resolveExplanation(level, alt.raw, rawAlts, normText),
      deterministic: true,
    };
  }

  if (parcialHit !== null) {
    return {
      verdict: 'parcial',
      explanation:
        rawAlts.length > 1
          ? `esperado [${list}]; '${parcialHit}' aparece apenas dentro de outra palavra/frase`
          : `rótulo esperado '${parcialHit}' aparece apenas dentro de outra palavra/frase`,
      deterministic: true,
    };
  }

  return {
    verdict: 'nao',
    explanation:
      rawAlts.length > 1
        ? `esperado [${list}]; resposta não contém nenhum`
        : `esperado '${rawAlts[0]}'; resposta não contém o rótulo`,
    deterministic: true,
  };
}
