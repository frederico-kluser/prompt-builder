// ----------------------------------------------------------------------------
// Ground-truth determinístico (padrão do prompt-arena `gabaritoSpec kind:'labels'`).
//
// Quando o cenário de teste traz o RÓTULO ESPERADO (`expected`), o veredito da
// resposta não precisa de juiz LLM: a decisão é comparação pura de texto/campo,
// reproduzível e sem custo. Este módulo é fonte única e PURO (sem node:fs, sem
// fetch) — roda igual no CLI, no servidor e no navegador, como `duelCore.ts`.
//
// VERIFICADOR ESTRITO (IMPL-003 / R-03b:REC-5, DEC-4). A medida N1 da pesquisa
// mostrou 7/7 respostas adversariais dando 'resolve' porque o rótulo aparecia
// "standalone" em qualquer ponto do texto ("A resposta NÃO é urgente." casava
// 'urgente'). O padrão dos frameworks (lm-eval strict-match × flexible-extract,
// DeepEval/promptfoo com schema/regex ancorado) é casar por regra
// determinística DOCUMENTADA, nunca "aparece em algum ponto". Ordem:
//
//   1. JSON estrito — o corpo inteiro (ou o único fence que o envolve) é JSON,
//      ou há UM documento `{…}` inequívoco. Chave duplicada, dois objetos com
//      valores diferentes ou lista de rótulos = AMBÍGUO → 'nao'.
//   2. Primeira linha — a 1ª linha não-vazia É o rótulo (tolerando prefixo
//      curto tipo "Sentimento:"), ou o rótulo abre a linha seguido de
//      separador forte ("Negativo. O cliente…").
//   3. Igualdade normalizada da resposta inteira (e tag BCP-47). Numa resposta
//      de UMA linha os passos 2 e 3 coincidem — o código testa a igualdade
//      primeiro só porque ela dispensa as guardas das linhas seguintes.
//   4. Extração FLEXÍVEL (standalone/substring): teto 'parcial', NUNCA
//      'resolve'. Negação ou hesitação sobre o rótulo → 'nao'; resposta que
//      afirma vários rótulos do `labelSet` → 'nao'.
//
// `labelSet` é o conjunto de TODOS os rótulos válidos da etapa. É obrigatório
// quando o `expected` é rótulo curto (≤5 palavras) — `labelSetIssue` é a regra
// única usada pelos schemas de config (erro de config / exit 3 no CLI). Sem ele
// o verificador não enxerga "positivo | negativo | neutro" como lista.
//
// Risco aceito (R-03b): resposta correta escrita só em prosa cai para
// 'parcial' — dito explicitamente na explicação, nunca silenciado.
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

/**
 * `strict` (DEFAULT, o que o pipeline usa) segue a escada documentada acima.
 * `lenient` preserva a escada LEGADA (standalone → 'resolve'): existe só para
 * medir a extração flexível como métrica SEPARADA (R-03b Q6c) e documentar a
 * regressão N1 nos testes — nunca decide veredito de run.
 */
export type LabelMatchMode = 'strict' | 'lenient';

export interface MatchOptions {
  /** Todos os rótulos válidos da etapa (o `expected` deve estar contido nele). */
  labelSet?: readonly string[];
  /** Default 'strict'. */
  mode?: LabelMatchMode;
}

/** Regra que decidiu o veredito — diagnóstico (painel "onde falhou") e testes. */
export type GroundTruthRule =
  | 'empty'
  | 'no-expected'
  | 'json'
  | 'json-ambiguous'
  | 'field-mismatch'
  | 'exact'
  | 'language'
  | 'first-line'
  | 'lead'
  | 'standalone'
  | 'substring'
  | 'negated'
  | 'hedged'
  | 'multi-label'
  | 'none';

export interface GroundTruthResult {
  verdict: Verdict;
  /** 1 frase curta em PT-BR explicando o veredito (para o painel "onde falhou"). */
  explanation: string;
  /** Sempre true aqui — marca que o veredito veio de ground-truth, não de juiz LLM. */
  deterministic: true;
  /** Regra da escada que decidiu. */
  rule: GroundTruthRule;
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

/**
 * Máximo de palavras de um RÓTULO CURTO: vale a busca standalone e, na config,
 * torna `labelSet` obrigatório (6+ palavras é frase, não token).
 */
export const SHORT_LABEL_MAX_WORDS = 5;

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

/**
 * Forma de VARREDURA de uma linha: minúscula, sem acentos, apóstrofos
 * unificados e " - " virando travessão (mesmo comprimento: 3 chars) para contar
 * como fronteira de oração. Diferente de `normalizeLabel`, mantém a pontuação
 * interna e as bordas — a negação/hesitação mora justamente nelas.
 */
function foldLine(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/ - /g, ' — ')
    .trim();
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter((w) => w !== '').length;
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
// labelSet — regra de configuração (fonte única para todos os schemas)
// ----------------------------------------------------------------------------

function isShortLabel(s: string): boolean {
  const n = normalizeLabel(s);
  return n !== '' && wordCount(n) <= SHORT_LABEL_MAX_WORDS;
}

/** O `expected` é RÓTULO CURTO (string ou alguma alternativa com ≤5 palavras)? Objeto campo→valor não conta. */
export function isShortLabelExpected(expected: ExpectedSpec | undefined): boolean {
  if (typeof expected === 'string') return isShortLabel(expected);
  if (Array.isArray(expected)) return expected.some(isShortLabel);
  return false;
}

/**
 * Problema de configuração de rótulo de UMA etapa (mensagem PT-BR) ou null.
 * É a regra única de "labelSet obrigatório" (R-03b:DEC-4): rótulo curto sem
 * `labelSet` é erro de config — o CLI sai com exit 3 e `parseRunConfig` reprova.
 * Com `labelSet`, todo rótulo esperado (string/alternativas) precisa estar nele.
 */
export function labelSetIssue(stage: {
  expected?: ExpectedSpec;
  labelSet?: readonly string[];
}): string | null {
  const { expected, labelSet } = stage;
  if (labelSet !== undefined) {
    if (expected === undefined) {
      return 'labelSet só vale junto com expected (o rótulo esperado da etapa)';
    }
    const validos = labelSet.map(normalizeLabel).filter((l) => l !== '');
    if (validos.length === 0) return 'labelSet não pode ser vazio';
    if (typeof expected === 'string' || Array.isArray(expected)) {
      const alts = typeof expected === 'string' ? [expected] : expected;
      const fora = alts.filter((a) => !validos.includes(normalizeLabel(a)));
      if (fora.length > 0) {
        return `rótulo esperado ${fora.map((a) => `'${a}'`).join(', ')} não está em labelSet [${labelSet.join(', ')}]`;
      }
    }
    return null;
  }
  if (isShortLabelExpected(expected)) {
    const alts = typeof expected === 'string' ? [expected] : (expected as string[]);
    const desc = alts.length > 1 ? `[${alts.join('|')}]` : `'${alts[0]}'`;
    return (
      `labelSet obrigatório: o rótulo esperado ${desc} é curto (≤${SHORT_LABEL_MAX_WORDS} palavras) — ` +
      `declare TODOS os rótulos válidos da etapa em "labelSet" (ex.: ["${alts[0]}", "<outro rótulo>"]); ` +
      'sem ele o verificador estrito não reconhece resposta que lista vários rótulos'
    );
  }
  return null;
}

/** `labelSetIssue` aplicado a uma lista de etapas — índice (0-based) + mensagem. */
export function stageLabelIssues(
  stages: readonly { expected?: ExpectedSpec; labelSet?: readonly string[] }[] | undefined,
): { index: number; message: string }[] {
  const out: { index: number; message: string }[] = [];
  (stages ?? []).forEach((s, index) => {
    const message = labelSetIssue(s);
    if (message) out.push({ index, message });
  });
  return out;
}

// ----------------------------------------------------------------------------
// Extração de campo em resposta JSON
// ----------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
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

/**
 * Extrai campo de uma resposta que deveria ser JSON (tolera fences ``` e prosa
 * ao redor; retorna undefined se não achar). Extração FLEXÍVEL (o primeiro
 * candidato com o campo vence) — o veredito estrito usa `jsonDocuments`, que
 * detecta ambiguidade.
 */
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

interface JsonDoc {
  value: unknown;
  /** Texto-fonte do documento (para achar chave duplicada, que o JSON.parse esconde). */
  source: string;
  /** true = a resposta INTEIRA é este JSON (ou o único fence que a envolve). */
  whole: boolean;
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

/** Remove UM fence ``` que envolve a resposta INTEIRA (o payload marcado); senão devolve o texto aparado. */
function unwrapWholeFence(text: string): string {
  const t = text.trim();
  const m = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(t);
  return m ? m[1].trim() : t;
}

/**
 * Documentos JSON da resposta, para o veredito ESTRITO: o corpo inteiro (sem o
 * fence que o envolve) quando ele parseia; senão, cada região `{…}` MAIS
 * EXTERNA que parseia como objeto (prosa/fences em volta são tolerados). Ao
 * contrário de `jsonCandidates`, não desce para objetos aninhados: dois
 * documentos são duas respostas — e a ambiguidade entre elas é detectável.
 */
function jsonDocuments(text: string): JsonDoc[] {
  const body = unwrapWholeFence(text);
  const whole = tryParse(body);
  if (whole.ok) return [{ value: whole.value, source: body, whole: true }];
  const out: JsonDoc[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    const end = balancedEnd(text, i);
    if (end <= i) continue;
    const source = text.slice(i, end + 1);
    const parsed = tryParse(source);
    if (parsed.ok && isRecord(parsed.value)) {
      out.push({ value: parsed.value, source, whole: false });
      i = end; // próxima região começa depois desta (só as mais externas)
    }
  }
  return out;
}

/**
 * Chaves de 1º nível do objeto JSON em `source`, NA ORDEM e COM repetições:
 * `JSON.parse('{"label":"a","label":"b"}')` devolve só o último valor e
 * esconde a duplicata — que é justamente o "JSON duplo" adversarial.
 */
function topLevelKeys(source: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"') {
      let j = i + 1;
      let escaped = false;
      for (; j < source.length; j += 1) {
        const c = source[j];
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') break;
      }
      if (depth === 1) {
        let k = j + 1;
        while (k < source.length && /\s/.test(source[k])) k += 1;
        if (source[k] === ':') {
          const lit = tryParse(source.slice(i, j + 1));
          if (lit.ok && typeof lit.value === 'string') keys.push(lit.value);
        }
      }
      i = j + 1;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    i += 1;
  }
  return keys;
}

function hasDuplicateKey(source: string, key: string): boolean {
  return topLevelKeys(source).filter((k) => k === key).length > 1;
}

/**
 * Chaves que carregam o RÓTULO numa resposta JSON quando o `expected` é
 * string (forma sem acento/minúscula). Objeto de UMA chave escalar também vale.
 * Dois níveis: as ESPECÍFICAS mandam; as GENÉRICAS ("resposta", "output") só
 * valem quando nenhuma específica existe — senão um campo de texto livre
 * ("resposta": "Entendo sua frustração…") viraria um segundo rótulo.
 */
const SPECIFIC_LABEL_KEYS = new Set([
  'label', 'rotulo', 'classificacao', 'classe', 'class', 'categoria', 'category', 'intent',
  'intencao', 'sentimento', 'sentiment', 'decisao', 'decision', 'acao', 'action', 'veredito',
  'verdict', 'prioridade', 'priority', 'urgencia', 'urgency', 'idioma', 'language', 'lang',
]);
const GENERIC_LABEL_KEYS = new Set([
  'answer', 'resposta', 'resultado', 'result', 'output', 'saida', 'tipo', 'type', 'valor', 'value',
]);

type JsonLabel =
  | { kind: 'value'; value: string }
  | { kind: 'ambiguous'; why: string }
  | { kind: 'none' };

/** Rótulo carregado por UM documento JSON (modo `expected` string). */
function jsonLabelOfDoc(doc: JsonDoc): JsonLabel {
  const v = doc.value;
  if (isScalar(v)) return doc.whole ? { kind: 'value', value: String(v) } : { kind: 'none' };
  if (Array.isArray(v)) {
    if (!doc.whole) return { kind: 'none' };
    const scalars = v.filter(isScalar);
    if (v.length === 1 && scalars.length === 1) return { kind: 'value', value: String(scalars[0]) };
    if (scalars.length >= 2) return { kind: 'ambiguous', why: `lista JSON com ${scalars.length} valores` };
    return { kind: 'none' };
  }
  if (!isRecord(v)) return { kind: 'none' };
  const escalares = Object.entries(v).filter(([, x]) => isScalar(x));
  const especificas = escalares.filter(([k]) => SPECIFIC_LABEL_KEYS.has(normalizeLabel(k)));
  const candidatas =
    Object.keys(v).length === 1
      ? escalares
      : especificas.length > 0
        ? especificas
        : escalares.filter(([k]) => GENERIC_LABEL_KEYS.has(normalizeLabel(k)));
  if (candidatas.length === 0) return { kind: 'none' };
  for (const [k] of candidatas) {
    if (hasDuplicateKey(doc.source, k)) return { kind: 'ambiguous', why: `chave '${k}' repetida no JSON` };
  }
  const distintos = new Set(candidatas.map(([, x]) => normalizeLabel(String(x))));
  if (distintos.size > 1) {
    return { kind: 'ambiguous', why: `campos de rótulo divergentes (${candidatas.map(([k, x]) => `${k}=${String(x)}`).join(', ')})` };
  }
  return { kind: 'value', value: String(candidatas[0][1]) };
}

/** Rótulo da resposta por JSON estrito (modo `expected` string): valor inequívoco, ambiguidade, ou nada. */
function strictJsonLabel(text: string): JsonLabel {
  const labels = jsonDocuments(text)
    .map(jsonLabelOfDoc)
    .filter((l) => l.kind !== 'none');
  if (labels.length === 0) return { kind: 'none' };
  const ambigua = labels.find((l) => l.kind === 'ambiguous');
  if (ambigua) return ambigua;
  const valores = labels.map((l) => (l as { value: string }).value);
  const distintos = new Set(valores.map(normalizeLabel));
  if (distintos.size > 1) {
    return { kind: 'ambiguous', why: `${valores.length} objetos JSON com rótulos diferentes (${valores.join(' | ')})` };
  }
  return { kind: 'value', value: valores[0] };
}

// ----------------------------------------------------------------------------
// Negação, hesitação e menções de rótulo (extração flexível)
// ----------------------------------------------------------------------------

/** Janela de palavras ANTES do rótulo (mesma oração) onde uma negação o inverte. */
const WINDOW_BEFORE = 4;
/** Janela de palavras DEPOIS do rótulo (mesma oração) onde uma hesitação conta. */
const WINDOW_AFTER = 3;

/** Negação (forma sem acento). "no" fica de FORA: em PT é "em + o". */
const NEGATION_WORDS = new Set([
  'nao', 'nunca', 'jamais', 'nem', 'sem', 'nenhum', 'nenhuma', 'nada',
  'not', 'never', 'nor', 'none', "isn't", 'isnt', "aren't", 'arent', "wasn't", "doesn't",
  'doesnt', "don't", 'dont', 'cannot', "can't",
]);
const NEGATION_PHRASES = ['longe de', 'em vez de', 'ao inves de', 'em lugar de', 'instead of', 'rather than', 'far from'];
/** Intensificadores que CONTÊM uma negação mas afirmam ("sem dúvida é urgente"). */
const NEGATION_EXCEPTIONS = [
  'sem sombra de duvida', 'nao ha duvida', 'nao resta duvida', 'sem duvida', 'nao so', 'nao apenas',
  'nao somente', 'without a doubt', 'without doubt', 'no doubt', 'not only',
];
/** Negação logo DEPOIS do rótulo ("urgente não, só importante"). */
const POST_NEGATION = new Set(['nao', 'not']);

/** Hesitação (forma sem acento). */
const HEDGE_WORDS = new Set([
  'talvez', 'possivelmente', 'provavelmente', 'aparentemente', 'supostamente', 'acho', 'acredito',
  'creio', 'suponho', 'parece', 'pareca', 'parecer', 'incerto', 'incerta', 'depende', 'duvidoso',
  'maybe', 'perhaps', 'probably', 'possibly', 'likely', 'unlikely', 'apparently', 'seemingly',
  'guess', 'unsure', 'uncertain', 'depends', 'might', 'either',
]);
const HEDGE_PHRASES = [
  'pode ser', 'poderia ser', 'pode estar', 'poderia estar', 'tende a', 'nao tenho certeza',
  'sem certeza', 'nao sei se', 'could be', 'may be', 'might be', 'i think', 'not sure',
];
/** Hesitação FORTE (até 2 palavras antes): vale até em linhas depois de uma resposta firme. */
const STRONG_HEDGE = new Set(['talvez', 'maybe', 'perhaps', 'possivelmente', 'possibly', 'provavelmente', 'probably']);
/** Alternativa colada ao rótulo ("negativo ou neutro") = hesitação entre rótulos. */
const ALTERNATIVE_WORDS = new Set(['ou', 'or']);
/** Incerteza declarada em qualquer ponto: nenhuma regra estrita resolve. */
const GLOBAL_UNCERTAINTY = [
  'nao tenho certeza', 'nao tenho como saber', 'sem certeza', 'dificil dizer', 'dificil saber',
  'impossivel saber', 'impossivel determinar', 'nao da para saber', 'nao e possivel determinar',
  'not sure', 'hard to say', "can't tell", 'cannot tell', 'cannot determine', "can't determine",
];

/** Fronteira de oração dentro da linha (a janela de negação/hesitação não atravessa). */
const CLAUSE_BOUNDARY = /[.;!?:,|/()[\]{}"“”«»—–]/;

/**
 * Fronteira de palavra = nem letra nem dígito. "2" não pode casar dentro de
 * "2024" nem "edit" dentro de "2024edit" — por isso a fronteira é alfanumérica
 * e não só "não-letra".
 */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/** Índices onde `needle` aparece em `haystack` como palavra/sequência standalone. */
function standaloneIndices(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle === '') return out;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    const before = idx > 0 ? haystack[idx - 1] : undefined;
    const afterIdx = idx + needle.length;
    const after = afterIdx < haystack.length ? haystack[afterIdx] : undefined;
    if (!isWordChar(before) && !isWordChar(after)) out.push(idx);
    from = idx + 1;
  }
  return out;
}

/** O rótulo aparece em `haystack` como palavra/sequência standalone (bordas não-alfanuméricas)? */
function hasStandalone(haystack: string, needle: string): boolean {
  return standaloneIndices(haystack, needle).length > 0;
}

/** Palavras de um trecho, sem a pontuação das bordas de cada uma (apóstrofo interno fica: "isn't"). */
function wordsOf(s: string): string[] {
  return s
    .split(' ')
    .map((w) => w.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, ''))
    .filter((w) => w !== '');
}

function containsPhrase(words: string[], phrases: readonly string[]): boolean {
  const joined = ` ${words.join(' ')} `;
  return phrases.some((p) => joined.includes(` ${p} `));
}

function hasNegation(words: string[]): boolean {
  let joined = ` ${words.join(' ')} `;
  for (const ex of NEGATION_EXCEPTIONS) joined = joined.split(` ${ex} `).join(' ');
  const limpas = joined.trim().split(' ').filter((w) => w !== '');
  return limpas.some((w) => NEGATION_WORDS.has(w)) || containsPhrase(limpas, NEGATION_PHRASES);
}

function hasHedge(words: string[]): boolean {
  return words.some((w) => HEDGE_WORDS.has(w)) || containsPhrase(words, HEDGE_PHRASES);
}

function hasGlobalUncertainty(foldedText: string): boolean {
  return GLOBAL_UNCERTAINTY.some((p) => foldedText.includes(p));
}

interface Mention {
  label: string;
  start: number;
  end: number;
  /** Negação na janela antes (ou logo depois) do rótulo, na mesma oração. */
  negated: boolean;
  /** Hesitação na janela, '?' logo depois, ou alternativa ("ou") colada. */
  hedged: boolean;
  /** Hesitação forte/alternativa/pergunta — vale até fora da primeira linha. */
  strongHedge: boolean;
}

function clauseBounds(line: string, start: number, end: number): [number, number] {
  let a = start;
  while (a > 0 && !CLAUSE_BOUNDARY.test(line[a - 1])) a -= 1;
  let b = end;
  while (b < line.length && !CLAUSE_BOUNDARY.test(line[b])) b += 1;
  return [a, b];
}

/**
 * Menções standalone dos rótulos numa linha já `foldLine`-ada, com negação e
 * hesitação resolvidas na janela da oração. Menção contida numa menção maior
 * ("urgente" dentro de "nao urgente") é descartada: vale o rótulo mais longo.
 * Rótulo que também é partícula de negação ("não" em sim/não) seguido de outro
 * rótulo na mesma oração é OPERADOR ("não é sim"), não menção.
 */
function scanLine(line: string, labels: readonly string[]): Mention[] {
  const brutas: { label: string; start: number; end: number }[] = [];
  for (const label of labels) {
    for (const start of standaloneIndices(line, label)) brutas.push({ label, start, end: start + label.length });
  }
  const mantidas = brutas
    .filter(
      (m) =>
        !brutas.some(
          (o) => o !== m && o.start <= m.start && o.end >= m.end && o.end - o.start > m.end - m.start,
        ),
    )
    .sort((x, y) => x.start - y.start);

  const out: Mention[] = [];
  for (const m of mantidas) {
    const [a, b] = clauseBounds(line, m.start, m.end);
    if (NEGATION_WORDS.has(m.label) && mantidas.some((o) => o !== m && o.start >= m.end && o.start < b)) {
      continue; // operador ("não é sim"), não resposta
    }
    const before = wordsOf(line.slice(a, m.start)).slice(-WINDOW_BEFORE);
    const after = wordsOf(line.slice(m.end, b)).slice(0, WINDOW_AFTER);
    const negated = hasNegation(before) || (after[0] !== undefined && POST_NEGATION.has(after[0]));
    const next = line.slice(m.end).trimStart()[0];
    const alternativa =
      ALTERNATIVE_WORDS.has(before[before.length - 1] ?? '') || ALTERNATIVE_WORDS.has(after[0] ?? '');
    const strongHedge = alternativa || next === '?' || before.slice(-2).some((w) => STRONG_HEDGE.has(w));
    const hedged = strongHedge || hasHedge(before) || hasHedge(after);
    out.push({ ...m, negated, hedged, strongHedge });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Universo de rótulos
// ----------------------------------------------------------------------------

interface LabelUniverse {
  /** Rótulos que RESOLVEM a etapa (as alternativas do expected, normalizadas). */
  acceptable: Set<string>;
  /** Todos os rótulos conhecidos (labelSet ∪ alternativas), normalizados e únicos. */
  all: string[];
}

function buildUniverse(alts: readonly string[], labelSet: readonly string[] | undefined): LabelUniverse {
  const acceptable = new Set(alts);
  const all = new Set(alts);
  for (const l of labelSet ?? []) {
    const n = normalizeLabel(l);
    if (n !== '') all.add(n);
  }
  return { acceptable, all: [...all] };
}

/** Marcador de lista no começo da linha ("- x", "* x", "1. x", "a) x"). */
function stripListMarker(line: string): string {
  return line.replace(/^\s*(?:[-*•]|\d{1,3}[.)]|[a-z][)])\s+/u, '');
}

/**
 * Prefixo curto "chave: " da primeira linha ("Sentimento: negativo"). Só é
 * removido se tiver ≤3 palavras, sem negação/hesitação/alternativa e se não
 * for ele mesmo um rótulo ("Negativo: o cliente…" é rótulo + explicação).
 */
function stripKeyPrefix(normLine: string, universe: LabelUniverse): string {
  const m = /^([^:]{1,40}):\s*(.+)$/.exec(normLine);
  if (!m) return normLine;
  const prefixo = m[1].trim();
  const palavras = prefixo.split(' ').filter((w) => w !== '');
  if (palavras.length === 0 || palavras.length > 3) return normLine;
  if (palavras.some((w) => NEGATION_WORDS.has(w) || HEDGE_WORDS.has(w) || ALTERNATIVE_WORDS.has(w))) return normLine;
  if (universe.all.includes(normalizeLabel(prefixo))) return normLine;
  return normalizeLabel(m[2]);
}

/** Separador FORTE depois do rótulo que abre a linha. Vírgula conta; '?' não (pergunta é hesitação). */
const LEAD_SEPARATOR = /[.!;,(:]| [—–-] /;
/** Divisores de segmentos do resto da linha (para achar outro rótulo "solto" = lista). */
const SEGMENT_SPLIT = /[.!;,|/?()]| [—–-] | ou | or /;

/**
 * O rótulo ABRE a linha seguido de separador forte ("Negativo. O cliente…",
 * "Não, o prazo expirou."). Guardas do resto da linha: hesitação ou outro
 * rótulo como segmento solto ("Positivo. Negativo. Neutro.") desqualificam.
 */
function leadLabel(answer: string, universe: LabelUniverse): string | null {
  const sep = LEAD_SEPARATOR.exec(answer);
  if (!sep || sep.index === 0) return null;
  const head = normalizeLabel(answer.slice(0, sep.index));
  if (!universe.acceptable.has(head)) return null;
  const resto = answer.slice(sep.index);
  const palavras = wordsOf(resto);
  if (hasHedge(palavras) || hasGlobalUncertainty(resto)) return null;
  const segmentos = resto.split(SEGMENT_SPLIT).map((s) => normalizeLabel(stripListMarker(s)));
  if (segmentos.some((s) => s !== '' && s !== head && universe.all.includes(s) && !universe.acceptable.has(s))) {
    return null;
  }
  return head;
}

/**
 * Linhas DEPOIS de uma resposta firme na primeira linha que a contradizem:
 * outro rótulo sozinho na linha (lista de rótulos) ou outro rótulo sob
 * hesitação forte/alternativa/pergunta ("ou talvez positivo"). Explicação que
 * cita outro rótulo sem hesitar ("não é positivo porque…") NÃO conflita.
 */
function laterLinesConflict(foldedLines: readonly string[], universe: LabelUniverse): boolean {
  for (const line of foldedLines) {
    const solto = normalizeLabel(stripListMarker(line));
    if (universe.all.includes(solto) && !universe.acceptable.has(solto)) return true;
    const mencoes = scanLine(line, universe.all);
    if (mencoes.some((m) => !universe.acceptable.has(m.label) && !m.negated && m.strongHedge)) return true;
  }
  return false;
}

/** A primeira linha termina em pergunta ("Urgente?") — a normalização apagaria o '?'. */
function endsWithQuestion(line: string): boolean {
  return /\?[\s*_"'`»”)\]]*$/u.test(line.trim());
}

// ----------------------------------------------------------------------------
// Veredito — modo ESTRITO
// ----------------------------------------------------------------------------

interface Alt {
  raw: string;
  norm: string;
}

function gt(verdict: Verdict, rule: GroundTruthRule, explanation: string): GroundTruthResult {
  return { verdict, explanation, deterministic: true, rule };
}

function altsList(rawAlts: readonly string[]): string {
  return rawAlts.join('|');
}

/** Extração FLEXÍVEL: teto 'parcial'; negação, hesitação e multi-rótulo → 'nao'. */
function flexibleVerdict(
  foldedLines: readonly string[],
  normText: string,
  alts: readonly Alt[],
  rawAlts: readonly string[],
  universe: LabelUniverse,
  uncertain: boolean,
): GroundTruthResult {
  const mencoes = foldedLines.flatMap((l) => scanLine(l, universe.all));
  const esperadas = mencoes.filter((m) => universe.acceptable.has(m.label));
  const afirmados = new Set(mencoes.filter((m) => !m.negated).map((m) => m.label));
  const outros = [...afirmados].filter((l) => !universe.acceptable.has(l));
  const multi = rawAlts.length > 1;

  if (esperadas.length === 0) {
    if (outros.length > 0) {
      return gt(
        'nao',
        'none',
        multi
          ? `esperado [${altsList(rawAlts)}]; resposta afirma outro rótulo ('${outros.join("', '")}')`
          : `esperado '${rawAlts[0]}'; resposta afirma outro rótulo ('${outros.join("', '")}')`,
      );
    }
    const sub = alts.find((a) => normText.includes(a.norm));
    if (sub) {
      return gt(
        'parcial',
        'substring',
        multi
          ? `esperado [${altsList(rawAlts)}]; '${sub.raw}' aparece apenas dentro de outra palavra/frase`
          : `rótulo esperado '${sub.raw}' aparece apenas dentro de outra palavra/frase`,
      );
    }
    return gt(
      'nao',
      'none',
      multi
        ? `esperado [${altsList(rawAlts)}]; resposta não contém nenhum`
        : `esperado '${rawAlts[0]}'; resposta não contém o rótulo`,
    );
  }

  const rotulo = alts.find((a) => a.norm === esperadas[0].label)?.raw ?? esperadas[0].label;
  const afirmadas = esperadas.filter((m) => !m.negated);
  if (afirmadas.length === 0) {
    return gt('nao', 'negated', `rótulo esperado '${rotulo}' aparece NEGADO na resposta (ex.: "não é ${rotulo}")`);
  }
  if (outros.length > 0) {
    return gt(
      'nao',
      'multi-label',
      `resposta afirma vários rótulos ('${[rotulo, ...outros].join("', '")}') — lista/hesitação entre rótulos não resolve`,
    );
  }
  if (uncertain || afirmadas.every((m) => m.hedged)) {
    return gt('nao', 'hedged', `rótulo esperado '${rotulo}' aparece com hesitação ("talvez", "?", "ou…") — não é resposta firme`);
  }
  return gt(
    'parcial',
    'standalone',
    `rótulo esperado '${rotulo}' encontrado standalone no meio da prosa — no modo estrito só JSON, a primeira linha ou a resposta exata dão resolve`,
  );
}

/**
 * Escada textual estrita: igualdade/idioma (resposta inteira) → primeira
 * linha → rótulo abrindo a primeira linha → flexível (teto 'parcial').
 * Pergunta ("Urgente?") nunca resolve: a normalização apagaria o '?'.
 */
function strictTextLadder(
  text: string,
  alts: readonly Alt[],
  rawAlts: readonly string[],
  universe: LabelUniverse,
): GroundTruthResult {
  const linhas = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const folded = linhas.map(foldLine);
  const normText = normalizeLabel(text);
  const uncertain = hasGlobalUncertainty(folded.join(' '));
  const pergunta = endsWithQuestion(linhas[0] ?? '');
  const sufixo = rawAlts.length > 1 ? ` (alternativas [${altsList(rawAlts)}])` : '';

  if (!pergunta) {
    const exata = alts.find((a) => a.norm === normText);
    if (exata) return gt('resolve', 'exact', `resposta é exatamente o rótulo esperado '${exata.raw}'${sufixo}`);
  }
  if (!pergunta && LANG_TAG.test(normText)) {
    const idioma = alts.find((a) => LANG_TAG.test(a.norm) && languageMatches(normText, a.norm));
    if (idioma) {
      return gt('resolve', 'language', `tag de idioma '${normText}' da resposta casa com o rótulo esperado '${idioma.raw}'${sufixo}`);
    }
  }

  if (!uncertain && linhas.length > 0) {
    const resposta = stripKeyPrefix(normalizeLabel(linhas[0]), universe);
    const conflito = laterLinesConflict(folded.slice(1), universe);
    if (!conflito) {
      const primeira = pergunta ? undefined : alts.find((a) => a.norm === resposta);
      if (primeira) {
        return gt('resolve', 'first-line', `primeira linha da resposta casa com o rótulo esperado '${primeira.raw}'${sufixo}`);
      }
      const head = leadLabel(resposta, universe);
      if (head) {
        const raw = alts.find((a) => a.norm === head)?.raw ?? head;
        return gt('resolve', 'lead', `primeira linha abre com o rótulo esperado '${raw}' seguido de separador${sufixo}`);
      }
    }
  }

  return flexibleVerdict(folded, normText, alts, rawAlts, universe, uncertain);
}

function matchLabelStrict(text: string, rawAlts: string[], alts: Alt[], labelSet?: readonly string[]): GroundTruthResult {
  const universe = buildUniverse(
    alts.map((a) => a.norm),
    labelSet,
  );

  // 1. JSON estrito.
  const json = strictJsonLabel(text);
  if (json.kind === 'ambiguous') {
    return gt('nao', 'json-ambiguous', `resposta JSON ambígua: ${json.why} — não há UM rótulo inequívoco`);
  }
  if (json.kind === 'value') {
    const v = normalizeLabel(json.value);
    const hit = alts.find((a) => a.norm === v);
    if (hit) return gt('resolve', 'json', `JSON da resposta traz o rótulo esperado '${hit.raw}'`);
    if (universe.all.includes(v)) {
      return gt('nao', 'field-mismatch', `JSON da resposta traz o rótulo '${json.value}', esperado ${rawAlts.length > 1 ? `[${altsList(rawAlts)}]` : `'${rawAlts[0]}'`}`);
    }
    // Valor em prosa dentro do JSON ({"resposta": "o sentimento é negativo"}):
    // a mesma escada textual decide, com o mesmo teto.
    return strictTextLadder(json.value, alts, rawAlts, universe);
  }

  // 2-4. Primeira linha → igualdade → flexível.
  return strictTextLadder(text, alts, rawAlts, universe);
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

/** Campo JSON no modo ESTRITO: documento inequívoco manda; sem campo, o valor na prosa vale no máximo 'parcial'. */
function matchFieldStrict(
  text: string,
  docs: readonly JsonDoc[],
  field: string,
  value: string | number | boolean,
  labelSet: readonly string[] | undefined,
): GroundTruthResult {
  const comCampo = docs.filter((d) => isRecord(d.value) && field in d.value);
  if (comCampo.some((d) => hasDuplicateKey(d.source, field))) {
    return gt('nao', 'json-ambiguous', `campo '${field}' repetido no JSON (chave duplicada) — resposta ambígua`);
  }
  if (comCampo.length > 0) {
    const valores = comCampo.map((d) => (d.value as Record<string, unknown>)[field]);
    const distintos = [...new Set(valores.map((v) => normalizeLabel(toComparableString(v))))];
    if (distintos.length > 1) {
      return gt(
        'nao',
        'json-ambiguous',
        `JSON traz valores conflitantes para '${field}' (${valores.map(display).join(' | ')}) — resposta ambígua`,
      );
    }
    const extracted = valores[0];
    if (scalarMatches(extracted, value)) {
      return gt('resolve', 'json', `campo '${field}' do JSON confere com o esperado ('${display(value)}')`);
    }
    return gt('nao', 'field-mismatch', `campo '${field}' do JSON diverge: veio '${display(extracted)}', esperado '${display(value)}'`);
  }

  // Sem o campo num JSON utilizável: o valor esperado na prosa ainda mostra
  // que o modelo sabe a resposta (formato errado) — parcial, nunca resolve,
  // e só se não vier negado/hesitante/misturado com outro rótulo.
  const normValue = normalizeLabel(toComparableString(value));
  if (normValue !== '' && wordCount(normValue) <= SHORT_LABEL_MAX_WORDS) {
    const universe = buildUniverse([normValue], labelSet);
    const linhas = text.split(/\r?\n/).filter((l) => l.trim() !== '').map(foldLine);
    const r = flexibleVerdict(linhas, normalizeLabel(text), [{ raw: display(value), norm: normValue }], [display(value)], universe, hasGlobalUncertainty(linhas.join(' ')));
    if (r.rule === 'standalone') {
      return gt('parcial', 'standalone', `sem o campo '${field}' no JSON, mas o valor esperado '${display(value)}' aparece standalone`);
    }
    if (r.rule === 'negated' || r.rule === 'hedged' || r.rule === 'multi-label') {
      return gt('nao', r.rule, `sem o campo '${field}' no JSON; ${r.explanation}`);
    }
  }
  return gt('nao', 'none', `resposta não traz o campo '${field}' nem o valor esperado '${display(value)}'`);
}

function worstOf(results: readonly GroundTruthResult[]): GroundTruthResult {
  // Múltiplos campos: o veredito é o PIOR campo — todos precisam conferir.
  const verdict = results.reduce<Verdict>(
    (acc, r) => (VERDICT_ORDER[r.verdict] < VERDICT_ORDER[acc] ? r.verdict : acc),
    'resolve',
  );
  return results.find((r) => r.verdict === verdict) ?? results[0];
}

function matchObjectStrict(
  text: string,
  spec: Record<string, string | number | boolean>,
  labelSet: readonly string[] | undefined,
): GroundTruthResult {
  const fields = Object.entries(spec);
  const docs = jsonDocuments(text);
  // O labelSet descreve UM campo; com vários campos ele não se aplica ao fallback.
  const set = fields.length === 1 ? labelSet : undefined;
  return worstOf(fields.map(([field, value]) => matchFieldStrict(text, docs, field, value, set)));
}

// ----------------------------------------------------------------------------
// Veredito — modo LEGADO (lenient): só medição separada, nunca o pipeline
// ----------------------------------------------------------------------------

/** Qualidade do casamento de UMA alternativa contra o texto normalizado (escada legada). */
type LenientLevel = 'exact' | 'firstLine' | 'language' | 'standalone' | 'substring' | 'none';

/** Primeira linha não-vazia do texto bruto (a normalização da linha decide o caso "Resposta: edit"). */
function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() !== '') return line;
  }
  return '';
}

function lenientLevel(normText: string, firstLineNorm: string, normAlt: string): LenientLevel {
  if (normText === normAlt) return 'exact';
  if (firstLineNorm !== '' && firstLineNorm === normAlt) return 'firstLine';
  if (LANG_TAG.test(normText) && LANG_TAG.test(normAlt) && languageMatches(normText, normAlt)) return 'language';
  if (wordCount(normAlt) <= SHORT_LABEL_MAX_WORDS && hasStandalone(normText, normAlt)) return 'standalone';
  if (normText.includes(normAlt)) return 'substring';
  return 'none';
}

const LENIENT_RULE: Record<Exclude<LenientLevel, 'none' | 'substring'>, GroundTruthRule> = {
  exact: 'exact',
  firstLine: 'first-line',
  language: 'language',
  standalone: 'standalone',
};

function matchLabelLenient(text: string, rawAlts: string[], alts: Alt[]): GroundTruthResult {
  const normText = normalizeLabel(text);
  const firstLineNorm = normalizeLabel(firstNonEmptyLine(text));
  let parcialHit: string | null = null;
  for (const alt of alts) {
    const level = lenientLevel(normText, firstLineNorm, alt.norm);
    if (level === 'none') continue;
    if (level === 'substring') {
      if (parcialHit === null) parcialHit = alt.raw;
      continue;
    }
    return gt('resolve', LENIENT_RULE[level], `[flexível] rótulo esperado '${alt.raw}' casou (${level})`);
  }
  if (parcialHit !== null) {
    return gt('parcial', 'substring', `[flexível] rótulo esperado '${parcialHit}' aparece apenas dentro de outra palavra/frase`);
  }
  return gt('nao', 'none', `[flexível] esperado [${altsList(rawAlts)}]; resposta não contém o rótulo`);
}

function matchObjectLenient(text: string, spec: Record<string, string | number | boolean>): GroundTruthResult {
  const normText = normalizeLabel(text);
  const results = Object.entries(spec).map(([field, value]): GroundTruthResult => {
    const extracted = extractJsonField(text, field);
    if (extracted !== undefined) {
      return scalarMatches(extracted, value)
        ? gt('resolve', 'json', `[flexível] campo '${field}' confere`)
        : gt('nao', 'field-mismatch', `[flexível] campo '${field}' diverge`);
    }
    const normValue = normalizeLabel(toComparableString(value));
    if (normValue !== '' && wordCount(normValue) <= SHORT_LABEL_MAX_WORDS && hasStandalone(normText, normValue)) {
      return gt('parcial', 'standalone', `[flexível] valor de '${field}' aparece standalone`);
    }
    return gt('nao', 'none', `[flexível] sem o campo '${field}'`);
  });
  return worstOf(results);
}

// ----------------------------------------------------------------------------
// Entrada pública
// ----------------------------------------------------------------------------

/**
 * Veredito determinístico da resposta contra o rótulo esperado. Default
 * ESTRITO: só JSON inequívoco, primeira linha ou igualdade resolvem; o resto
 * vale no máximo 'parcial', e negação/hesitação/multi-rótulo dão 'nao'.
 */
export function matchExpected(
  text: string,
  expected: ExpectedSpec,
  opts: MatchOptions = {},
): GroundTruthResult {
  const mode = opts.mode ?? 'strict';
  if (text.trim() === '') {
    return gt('nao', 'empty', 'resposta vazia: nada para comparar com o rótulo esperado');
  }

  if (typeof expected === 'object' && !Array.isArray(expected)) {
    if (Object.keys(expected).length === 0) {
      return gt('nao', 'no-expected', 'sem rótulo esperado (objeto campo→valor vazio)');
    }
    return mode === 'lenient' ? matchObjectLenient(text, expected) : matchObjectStrict(text, expected, opts.labelSet);
  }

  const rawAlts = typeof expected === 'string' ? [expected] : expected;
  const alts = rawAlts.map((raw) => ({ raw, norm: normalizeLabel(raw) })).filter((a) => a.norm !== '');
  if (alts.length === 0) {
    return gt('nao', 'no-expected', 'sem rótulo esperado utilizável (alternativas vazias)');
  }
  return mode === 'lenient'
    ? matchLabelLenient(text, rawAlts, alts)
    : matchLabelStrict(text, rawAlts, alts, opts.labelSet);
}
