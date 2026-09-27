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
//      ou há UM documento `{…}` inequívoco (um nível de embrulho, tipo
//      `{"resultado": {"label": …}}`, é aceito). Chave duplicada, dois objetos
//      com valores diferentes, outro campo com outro rótulo ou lista de
//      rótulos = AMBÍGUO → 'nao'. JSON EMBUTIDO em prosa só resolve se a
//      prosa em volta não hesitar nem afirmar outro rótulo.
//   2. Primeira linha — a 1ª linha não-vazia (pulando UM cabeçalho sem
//      rótulo: "## Resultado", "Sentimento:") É o rótulo (tolerando prefixo
//      curto tipo "Sentimento:"), ou o rótulo abre a linha seguido de
//      separador ("Negativo. O cliente…") — regra 'lead', com guardas: nega/
//      duvida logo depois ("Urgente: não"), abre alternativa ("(ou neutro)"),
//      se autocorrige ("na verdade neutro") ou soma outro rótulo ("mas também
//      não") → desqualifica. As linhas seguintes não podem hesitar/somar/
//      reafirmar outro rótulo ("mas pode ser neutro", "Também positivo.").
//   3. Igualdade normalizada da resposta inteira (e tag BCP-47). Numa resposta
//      de UMA linha os passos 2 e 3 coincidem — o código testa a igualdade
//      primeiro só porque ela dispensa as guardas das linhas seguintes.
//   4. Extração FLEXÍVEL (standalone/substring): teto 'parcial', NUNCA
//      'resolve'. Negação ou hesitação sobre o rótulo → 'nao'; resposta que
//      afirma vários rótulos do `labelSet` → 'nao'. Pergunta rejeitada
//      ("Neutro? Não, há raiva.") conta como negação, não como afirmação.
//
// Incerteza só conta quando é DO MODELO: trecho entre aspas (citação do
// cliente) não desliga a primeira linha.
//
// `labelSet` é o conjunto de TODOS os rótulos válidos da etapa. É obrigatório
// quando o `expected` é rótulo curto (≤5 palavras) e precisa de ≥2 rótulos
// distintos (exceto rótulo numérico) — `labelSetIssue` é a regra única usada
// pelos schemas de config (erro de config / exit 3 no CLI). Sem ele o
// verificador não enxerga "positivo | negativo | neutro" como lista.
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

/** Rótulo numérico ("42", "3,5"): resposta aberta, sem conjunto fechado de rótulos. */
function isNumericLabel(s: string): boolean {
  return /^[+-]?\d+(?:[.,]\d+)?$/.test(normalizeLabel(s));
}

/**
 * Problema de configuração de rótulo de UMA etapa (mensagem PT-BR) ou null.
 * É a regra única de "labelSet obrigatório" (R-03b:DEC-4): rótulo curto sem
 * `labelSet` é erro de config — o CLI sai com exit 3 e `parseRunConfig` reprova.
 * Com `labelSet`, todo rótulo esperado (string/alternativas) precisa estar nele
 * e o conjunto precisa de ≥2 rótulos distintos: `["negativo"]` sozinho passaria
 * na regra mas DESLIGARIA a detecção de lista ("positivo | negativo | neutro"),
 * que é o motivo de existir o labelSet. Exceção: rótulo numérico ("42"), que é
 * resposta aberta — ali `["42"]` basta.
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
      if (new Set(validos).size < 2 && !alts.every(isNumericLabel)) {
        return (
          `labelSet precisa de pelo menos 2 rótulos distintos (veio [${labelSet.join(', ')}]) — ` +
          'com um só rótulo o verificador não enxerga resposta que lista vários; declare TODOS os rótulos válidos da etapa'
        );
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

interface TopEntry {
  key: string;
  /** Índice (em `source`) do primeiro caractere do valor da chave. */
  valueStart: number;
}

/**
 * Chaves de 1º nível do objeto JSON em `source`, NA ORDEM e COM repetições:
 * `JSON.parse('{"label":"a","label":"b"}')` devolve só o último valor e
 * esconde a duplicata — que é justamente o "JSON duplo" adversarial.
 */
function topLevelEntries(source: string): TopEntry[] {
  const out: TopEntry[] = [];
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
          if (lit.ok && typeof lit.value === 'string') {
            let v = k + 1;
            while (v < source.length && /\s/.test(source[v])) v += 1;
            out.push({ key: lit.value, valueStart: v });
          }
        }
      }
      i = j + 1;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    i += 1;
  }
  return out;
}

function hasDuplicateKey(source: string, key: string): boolean {
  return topLevelEntries(source).filter((e) => e.key === key).length > 1;
}

/** Texto-fonte do objeto que é valor de `key` (a ÚLTIMA ocorrência, como o JSON.parse). */
function objectValueSource(source: string, key: string): string | undefined {
  const entry = topLevelEntries(source)
    .filter((e) => e.key === key)
    .pop();
  if (!entry || source[entry.valueStart] !== '{') return undefined;
  const end = balancedEnd(source, entry.valueStart);
  return end > entry.valueStart ? source.slice(entry.valueStart, end + 1) : undefined;
}

/**
 * Chaves que carregam o RÓTULO numa resposta JSON quando o `expected` é
 * string (forma sem acento/minúscula). Objeto de UMA chave escalar também
 * vale — mas só quando ele é a resposta INTEIRA (`{"x": "negativo"}`);
 * embutido na prosa, `{"confidence": 0.9}` não pode virar um segundo rótulo.
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

/**
 * Junta os rótulos de várias fontes (documentos, ou objetos embrulhados num
 * documento): nenhum → none; algum ambíguo ou valores divergentes → ambíguo.
 */
function combineLabels(labels: readonly JsonLabel[], what: string): JsonLabel {
  const uteis = labels.filter((l) => l.kind !== 'none');
  if (uteis.length === 0) return { kind: 'none' };
  const ambigua = uteis.find((l) => l.kind === 'ambiguous');
  if (ambigua) return ambigua;
  const valores = uteis.map((l) => (l as { value: string }).value);
  const distintos = new Set(valores.map(normalizeLabel));
  if (distintos.size > 1) {
    return { kind: 'ambiguous', why: `${valores.length} ${what} com rótulos diferentes (${valores.join(' | ')})` };
  }
  return { kind: 'value', value: valores[0] };
}

/**
 * Rótulo carregado por UM documento JSON (modo `expected` string). Sem chave
 * de rótulo no topo, desce UM nível: `{"resultado": {"label": "negativo"}}`
 * é o rótulo embrulhado (e no nível de baixo a chave precisa ser de rótulo).
 */
function jsonLabelOfDoc(doc: JsonDoc, nested = false): JsonLabel {
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
  const umaChaveInteira = doc.whole && !nested && Object.keys(v).length === 1;
  const candidatas = umaChaveInteira
    ? escalares
    : especificas.length > 0
      ? especificas
      : escalares.filter(([k]) => GENERIC_LABEL_KEYS.has(normalizeLabel(k)));
  if (candidatas.length === 0) return nested ? { kind: 'none' } : wrappedLabel(doc, v);
  for (const [k] of candidatas) {
    if (hasDuplicateKey(doc.source, k)) return { kind: 'ambiguous', why: `chave '${k}' repetida no JSON` };
  }
  const distintos = new Set(candidatas.map(([, x]) => normalizeLabel(String(x))));
  if (distintos.size > 1) {
    return { kind: 'ambiguous', why: `campos de rótulo divergentes (${candidatas.map(([k, x]) => `${k}=${String(x)}`).join(', ')})` };
  }
  return { kind: 'value', value: String(candidatas[0][1]) };
}

/** Um nível abaixo do topo: cada objeto-valor é lido como documento embutido (exige chave de rótulo). */
function wrappedLabel(doc: JsonDoc, v: Record<string, unknown>): JsonLabel {
  const labels: JsonLabel[] = [];
  for (const [k, x] of Object.entries(v)) {
    if (!isRecord(x)) continue;
    const source = objectValueSource(doc.source, k) ?? JSON.stringify(x);
    const label = jsonLabelOfDoc({ value: x, source, whole: false }, true);
    if (label.kind === 'none') continue;
    if (hasDuplicateKey(doc.source, k)) return { kind: 'ambiguous', why: `chave '${k}' repetida no JSON` };
    labels.push(label);
  }
  return combineLabels(labels, 'objetos aninhados');
}

/** Rótulo da resposta por JSON estrito (modo `expected` string), com os documentos lidos. */
function strictJsonLabel(text: string): { label: JsonLabel; docs: JsonDoc[] } {
  const docs = jsonDocuments(text);
  return { label: combineLabels(docs.map((d) => jsonLabelOfDoc(d)), 'objetos JSON'), docs };
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

/** Hesitação (forma sem acento). "diria" fica de FORA: "eu diria negativo" é prosa firme (vale 'parcial'). */
const HEDGE_WORDS = new Set([
  'talvez', 'possivelmente', 'provavelmente', 'aparentemente', 'supostamente', 'acho', 'acredito',
  'creio', 'suponho', 'parece', 'pareca', 'parecer', 'incerto', 'incerta', 'depende', 'duvidoso',
  'possivel', 'provavel', 'palpite', 'chute', 'chuto', 'chutaria', 'chutando', 'palpitaria',
  'maybe', 'perhaps', 'probably', 'possibly', 'likely', 'unlikely', 'apparently', 'seemingly',
  'guess', 'guessing', 'unsure', 'uncertain', 'depends', 'might', 'either', 'possible', 'probable',
]);
const HEDGE_PHRASES = [
  'pode ser', 'poderia ser', 'pode estar', 'poderia estar', 'tende a', 'nao tenho certeza',
  'sem certeza', 'nao sei se', 'could be', 'may be', 'might be', 'i think', 'not sure',
];
/** Hesitação FORTE (até 2 palavras antes): vale até em linhas depois de uma resposta firme. */
const STRONG_HEDGE = new Set(['talvez', 'maybe', 'perhaps', 'possivelmente', 'possibly', 'provavelmente', 'probably']);
/** Alternativa colada ao rótulo ("negativo ou neutro") = hesitação entre rótulos. "ou seja" é explicação. */
const ALTERNATIVE_WORDS = new Set(['ou', 'or']);
/** Incerteza declarada pelo modelo (fora de citação): nenhuma regra estrita resolve. */
const GLOBAL_UNCERTAINTY = [
  'nao tenho certeza', 'nao tenho como saber', 'sem certeza', 'dificil dizer', 'dificil saber',
  'impossivel saber', 'impossivel determinar', 'nao da para saber', 'nao e possivel determinar',
  'not sure', 'hard to say', "can't tell", 'cannot tell', 'cannot determine', "can't determine",
];
/** Autocorreção: o que vem depois substitui o que veio antes ("negativo; na verdade neutro"). */
const CORRECTION_PHRASES = [
  'na verdade', 'ou melhor', 'quer dizer', 'melhor dizendo', 'pensando bem', 'alias', 'digo', 'correcao',
  'actually', 'or rather', 'i mean', 'on second thought', 'correction',
];
/** Adição de rótulo: "também positivo", "neutro também". */
const ADDITION_WORDS = new Set(['tambem', 'also', 'too']);
/** Condicional: "poderia ser neutro se…" é contrafactual (explicação), não hesitação sobre a resposta. */
const CONDITIONAL_WORDS = new Set(['se', 'caso', 'if', 'unless']);
/** Rejeição logo depois de uma pergunta ("Neutro? Não, há raiva."): o rótulo perguntado fica NEGADO. */
const REJECTION_WORDS = new Set(['nao', 'not', 'nope', 'nunca', 'jamais', 'nem', 'never', 'no']);
/** "Não sei", "not sure": depois de '?' isso é dúvida, não rejeição. */
const DOUBT_AFTER_NEGATION = new Set(['sei', 'sabemos', 'tenho', 'da', 'sure', 'know', 'certain', 'idea', 'ideia']);
/**
 * Palavras que acompanham uma negação/hesitação SEM trazer conteúdo: uma
 * oração feita só delas ("Não.", "Ou não.", "Não sei.", "Not really.",
 * "Nem um pouco.", "Não se aplica.") é só dúvida/negação.
 */
const DOUBT_FILLER = new Set([
  'sei', 'sabemos', 'tenho', 'certeza', 'ideia', 'sure', 'know', 'certain', 'idea', 'really', 'mesmo', 'de', 'jeito',
  'modo', 'way', 'at', 'all', 'um', 'pouco', 'bem', 'tanto', 'exatamente', 'necessariamente', 'ou', 'or', 'e', 'eh',
  'and', 'mas', 'but', 'i', 'eu', 'se', 'aplica', 'caso', 'isso', 'is', 'it', 'this', 'exactly', 'necessarily',
  'quite', 'so', 'applicable', 'nope', 'nah', 'no',
]);
/**
 * Palavras que NÃO formam sujeito: conectivos, cópulas, artigos/pronomes,
 * intensificadores e os nomes da própria resposta ("a resposta é", "o
 * sentimento é"). Uma menção de OUTRO rótulo cuja oração só tem delas antes
 * ("mas pode ser neutro", "também positivo", "o sentimento é positivo") é
 * sobre A RESPOSTA; com sujeito ("o início é positivo") é explicação.
 */
const NEUTRAL_WORDS = new Set([
  'e', 'mas', 'porem', 'contudo', 'entretanto', 'todavia', 'no', 'entanto', 'ou', 'so', 'que', 'entao', 'logo',
  'portanto', 'ainda', 'assim', 'tambem', 'alias', 'digo', 'na', 'verdade', 'melhor', 'quer', 'dizer',
  'but', 'and', 'or', 'then', 'also', 'too', 'still', 'yet', 'however', 'actually', 'rather', 'mean',
  'eh', 'ser', 'seja', 'sera', 'seria', 'era', 'foi', 'esta', 'estar', 'estaria', 'fica', 'ficaria', 'soa',
  'is', 'be', 'was', 'would', 'could', 'should', "it's", 'its', 'it',
  'eu', 'isso', 'isto', 'o', 'a', 'os', 'as', 'um', 'uma', 'i', 'this', 'that', 'the', 'an',
  'resposta', 'rotulo', 'classificacao', 'classe', 'categoria', 'sentimento', 'label', 'answer', 'class',
  'category', 'sentiment', 'correta', 'correto', 'certa', 'certo', 'final', 'correct', 'right',
  'mais', 'bem', 'muito', 'bastante', 'totalmente', 'claramente', 'definitivamente', 'very', 'quite',
  'clearly', 'definitely',
  ...HEDGE_WORDS,
  ...HEDGE_PHRASES.flatMap((p) => p.split(' ')),
]);

/** Fronteira de oração dentro da linha (a janela de negação/hesitação não atravessa). */
const CLAUSE_BOUNDARY = /[.;!?:,|/()[\]{}"“”«»—–…]/;
/** Fronteira de FRASE (a autocorreção e a "afirmação solta" olham a frase inteira). */
const SENTENCE_BOUNDARY = /[.;!?…]/;
/** Separador fraco logo depois do rótulo, que a negação/dúvida seguinte atravessa ("urgente, não"). */
const WEAK_SEPARATOR = /^\s*[,:—–]\s*/;

/** Trechos entre aspas (citação do cliente): a incerteza DELES não é do modelo. */
const QUOTED = /"[^"\n]*"|“[^”\n]*”|«[^»\n]*»/g;

function stripQuoted(s: string): string {
  return s.replace(QUOTED, ' ');
}

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
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, ''))
    .filter((w) => w !== '');
}

function containsPhrase(words: readonly string[], phrases: readonly string[]): boolean {
  const joined = ` ${words.join(' ')} `;
  return phrases.some((p) => joined.includes(` ${p} `));
}

function hasNegation(words: string[]): boolean {
  let joined = ` ${words.join(' ')} `;
  for (const ex of NEGATION_EXCEPTIONS) joined = joined.split(` ${ex} `).join(' ');
  const limpas = joined.trim().split(' ').filter((w) => w !== '');
  return limpas.some((w) => NEGATION_WORDS.has(w)) || containsPhrase(limpas, NEGATION_PHRASES);
}

function hasHedge(words: readonly string[]): boolean {
  return words.some((w) => HEDGE_WORDS.has(w)) || containsPhrase(words, HEDGE_PHRASES);
}

/** Incerteza declarada PELO MODELO: frases entre aspas (citação) não contam. */
function hasGlobalUncertainty(foldedText: string): boolean {
  const semAspas = stripQuoted(foldedText);
  return GLOBAL_UNCERTAINTY.some((p) => semAspas.includes(p));
}

/** A oração começa com negação ("não…", "em vez de…"), fora os intensificadores ("sem dúvida", "não só"). */
function startsWithNegation(words: readonly string[]): boolean {
  if (words.length === 0) return false;
  const joined = words.join(' ');
  if (NEGATION_EXCEPTIONS.some((ex) => joined === ex || joined.startsWith(`${ex} `))) return false;
  return NEGATION_WORDS.has(words[0]) || NEGATION_PHRASES.some((p) => joined === p || joined.startsWith(`${p} `));
}

/** A oração é SÓ negação/hesitação ("Não.", "Ou não.", "Talvez.", "Não sei.", "Not really."). */
function onlyDoubt(words: readonly string[]): boolean {
  if (words.length === 0) return false;
  let marcador = false;
  for (const w of words) {
    if (NEGATION_WORDS.has(w) || HEDGE_WORDS.has(w) || w === 'no' || w === 'nope' || w === 'nah') marcador = true;
    else if (!DOUBT_FILLER.has(w)) return false;
  }
  return marcador;
}

interface Mention {
  label: string;
  start: number;
  end: number;
  /** Negação na janela antes (ou logo depois) do rótulo, ou rejeição ("Neutro? Não"). */
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

function sentenceBounds(line: string, start: number, end: number): [number, number] {
  let a = start;
  while (a > 0 && !SENTENCE_BOUNDARY.test(line[a - 1])) a -= 1;
  let b = end;
  while (b < line.length && !SENTENCE_BOUNDARY.test(line[b])) b += 1;
  return [a, b];
}

/** Algum rótulo do conjunto aparece standalone nestas palavras? */
function mentionsAnyLabel(words: readonly string[], labels: readonly string[]): boolean {
  const joined = words.join(' ');
  return labels.some((l) => hasStandalone(joined, l));
}

/**
 * A oração logo depois de um '?' REJEITA a pergunta ("Neutro? Não, há raiva
 * explícita."; "Negative? No."). "Não sei" é dúvida, e "Não?" é outra pergunta.
 */
function rejectsQuestion(line: string, questionIdx: number): boolean {
  const resto = line.slice(questionIdx + 1).trimStart();
  const fim = resto.search(CLAUSE_BOUNDARY);
  const clausula = fim === -1 ? resto : resto.slice(0, fim);
  if (fim !== -1 && resto[fim] === '?') return false;
  const w = wordsOf(clausula);
  if (w.length === 0 || !REJECTION_WORDS.has(w[0])) return false;
  if (w[0] === 'no' && w.length > 1) return false; // PT "no início…" = "em + o"
  return !(w[1] !== undefined && DOUBT_AFTER_NEGATION.has(w[1]));
}

/**
 * Oração SEGUINTE ao rótulo, depois de vírgula/dois-pontos/travessão, quando
 * ela é só negação/dúvida ("urgente, não"; "Urgente: não"; "Yes, not really";
 * "Negativo, talvez"). "Normal, não urgente" é contraste (tem outro rótulo) e
 * "Negativo: não gostou do atendimento" tem conteúdo — nenhum dos dois conta.
 */
function doubtAcross(line: string, end: number, labels: readonly string[]): { negated: boolean; hedged: boolean } {
  const nada = { negated: false, hedged: false };
  const sep = WEAK_SEPARATOR.exec(line.slice(end));
  if (!sep) return nada;
  const inicio = end + sep[0].length;
  const [, fim] = clauseBounds(line, inicio, inicio);
  const w = wordsOf(line.slice(inicio, fim));
  if (!onlyDoubt(w) || mentionsAnyLabel(w, labels)) return nada;
  return startsWithNegation(w) ? { negated: true, hedged: false } : { negated: false, hedged: hasHedge(w) };
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
    const rotuloNegacao = NEGATION_WORDS.has(m.label) || POST_NEGATION.has(m.label);
    if (NEGATION_WORDS.has(m.label) && mantidas.some((o) => o !== m && o.start >= m.end && o.start < b)) {
      continue; // operador ("não é sim"), não resposta
    }
    const before = wordsOf(line.slice(a, m.start)).slice(-WINDOW_BEFORE);
    const after = wordsOf(line.slice(m.end, b)).slice(0, WINDOW_AFTER);
    // "Talvez: negativo" / "Palpite: negativo" — a chave antes do ':' também hesita.
    const chave =
      before.length === 0 && a > 0 && line[a - 1] === ':'
        ? wordsOf(line.slice(clauseBounds(line, a - 1, a - 1)[0], a - 1))
        : [];
    const proximo = line.slice(m.end).trimStart()[0];
    const rejeitado = proximo === '?' && rejectsQuestion(line, line.indexOf('?', m.end));
    const atravessa = rotuloNegacao ? { negated: false, hedged: false } : doubtAcross(line, m.end, labels);
    const negated =
      rejeitado ||
      atravessa.negated ||
      hasNegation(before) ||
      (!rotuloNegacao && after[0] !== undefined && POST_NEGATION.has(after[0]));
    const alternativa =
      ALTERNATIVE_WORDS.has(before[before.length - 1] ?? '') ||
      (ALTERNATIVE_WORDS.has(after[0] ?? '') && after[1] !== 'seja');
    const strongHedge =
      !rejeitado &&
      (alternativa ||
        proximo === '?' ||
        before.slice(-2).some((w) => STRONG_HEDGE.has(w)) ||
        chave.some((w) => STRONG_HEDGE.has(w)));
    const hedged = strongHedge || (!rejeitado && (hasHedge(before) || hasHedge(after) || hasHedge(chave) || atravessa.hedged));
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
  /** Palavras que compõem algum rótulo (neutras na checagem de "afirmação solta"). */
  words: Set<string>;
}

function buildUniverse(alts: readonly string[], labelSet: readonly string[] | undefined): LabelUniverse {
  const acceptable = new Set(alts);
  const all = new Set(alts);
  for (const l of labelSet ?? []) {
    const n = normalizeLabel(l);
    if (n !== '') all.add(n);
  }
  const words = new Set([...all].flatMap((l) => wordsOf(foldLine(l))));
  return { acceptable, all: [...all], words };
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
  // hasNegation já ignora os intensificadores: "Sem dúvida: negativo" é prefixo firme.
  if (hasNegation(palavras) || hasHedge(palavras) || palavras.some((w) => ALTERNATIVE_WORDS.has(w))) return normLine;
  if (universe.all.includes(normalizeLabel(prefixo))) return normLine;
  return normalizeLabel(m[2]);
}

/**
 * Linha de CABEÇALHO sem o rótulo ("## Resultado", "Sentimento:",
 * "**Classificação:**"): o rótulo vem na linha seguinte, que passa a ser a
 * "primeira linha". Precisa ser curta (≤4 palavras), sem negação/hesitação e
 * não ser ela mesma um rótulo ("## Negativo" já é a resposta).
 */
function isHeaderLine(raw: string, universe: LabelUniverse): boolean {
  const t = raw.trim();
  if (!/^#{1,6}\s/.test(t) && !/:[\s*_`]*$/.test(t)) return false;
  const norm = normalizeLabel(t);
  const palavras = norm.split(' ').filter((w) => w !== '');
  if (palavras.length > 4) return false;
  if (palavras.some((w) => NEGATION_WORDS.has(w) || HEDGE_WORDS.has(w) || ALTERNATIVE_WORDS.has(w))) return false;
  return !universe.all.includes(norm);
}

/**
 * Uma menção de OUTRO rótulo (não negada) contradiz a resposta firme? Motivo
 * em PT-BR ou null. Contradiz quando: hesita/alterna/pergunta ("ou talvez
 * positivo", "positivo?"); vem depois de autocorreção na mesma frase ("na
 * verdade é positivo"); está numa oração SEM sujeito próprio e hesita ou se
 * soma ("mas pode ser neutro", "também positivo", "neutro também é
 * possível"); ou forma uma frase solta com rótulos ("É positivo.", "Positivo,
 * neutro."). Explicação com sujeito ("o início é positivo", "alguns diriam
 * neutro") ou citação entre parênteses dentro de uma frase NÃO contradiz.
 */
function otherLabelConflict(line: string, m: Mention, universe: LabelUniverse): string | null {
  if (m.strongHedge) return `hesita entre rótulos ('${m.label}' com "ou"/"talvez"/"?")`;
  const [fa, fb] = sentenceBounds(line, m.start, m.end);
  if (containsPhrase(wordsOf(line.slice(fa, m.start)), CORRECTION_PHRASES)) {
    return `se corrige para outro rótulo ('${m.label}')`;
  }
  const [a, b] = clauseBounds(line, m.start, m.end);
  const before = wordsOf(line.slice(a, m.start));
  const after = wordsOf(line.slice(m.end, b));
  if (!before.every((w) => NEUTRAL_WORDS.has(w))) return null; // tem sujeito: explicação
  // Contrafactual ("poderia ser neutro SE não houvesse a ameaça") explica, não hesita.
  const condicional = CONDITIONAL_WORDS.has(after[0] ?? '') || wordsOf(line.slice(fa, m.start)).some((w) => CONDITIONAL_WORDS.has(w));
  if (m.hedged && !condicional) return `hesita com outro rótulo ('${m.label}')`;
  if ([...before, ...after].some((w) => ADDITION_WORDS.has(w))) return `acrescenta outro rótulo ('${m.label}')`;
  const conteudo = (w: readonly string[]) => w.filter((x) => !NEUTRAL_WORDS.has(x) && !universe.words.has(x));
  if (conteudo(wordsOf(line.slice(fa, m.start))).length === 0 && conteudo(wordsOf(line.slice(m.end, fb))).length === 0) {
    return `afirma outro rótulo ('${m.label}')`;
  }
  return null;
}

/**
 * O resto da resposta (linhas seguintes, o resto da 1ª linha depois do
 * rótulo, ou a prosa em volta de um JSON) contradiz a resposta firme? Motivo
 * em PT-BR ou null.
 */
function tailConflict(foldedLines: readonly string[], universe: LabelUniverse): string | null {
  for (const line of foldedLines) {
    const solto = normalizeLabel(stripListMarker(line));
    if (universe.all.includes(solto) && !universe.acceptable.has(solto)) return `traz outro rótulo sozinho ('${solto}')`;
    // Frase que começa com alternativa ("ou talvez não") ou que é só dúvida ("Talvez.", "Não sei.").
    for (const frase of line.split(SENTENCE_BOUNDARY)) {
      const w = wordsOf(frase);
      if (w.length === 0 || universe.acceptable.has(normalizeLabel(frase))) continue;
      if (ALTERNATIVE_WORDS.has(w[0]) && w[1] !== 'seja') return 'abre alternativa ("ou…")';
      if (onlyDoubt(w)) return `hesita ou nega ("${frase.trim()}")`;
    }
    for (const m of scanLine(line, universe.all)) {
      if (universe.acceptable.has(m.label)) {
        // O próprio rótulo esperado sob dúvida/rejeição mais adiante ("Negativo? Não.").
        if (m.strongHedge) return `volta a hesitar sobre '${m.label}'`;
        if (m.negated && !NEGATION_WORDS.has(m.label)) return `nega '${m.label}' mais adiante`;
        continue;
      }
      if (m.negated) continue; // "não é positivo porque…" = contraste
      const motivo = otherLabelConflict(line, m, universe);
      if (motivo) return motivo;
    }
  }
  return null;
}

/** Separador FORTE depois do rótulo que abre a linha. Vírgula conta; '?' não (pergunta é hesitação). */
const LEAD_SEPARATOR = /[.!;,(:…]| [—–-] /;
/** Sequência de separadores logo depois do rótulo ("Negativo. ", "Negativo... ", "Urgente: "). */
const LEAD_RUN = /^[\s.!;,(:…—–-]+/;

/**
 * O rótulo ABRE a linha seguido de separador ("Negativo. O cliente…",
 * "Não, o prazo expirou."). O resto da linha desqualifica quando: hesita; nega
 * ou duvida logo depois ("Urgente: não", "urgente, não", "Negativo. Não.");
 * abre alternativa ("Negativo (ou neutro)", "Negativo... ou não"); se
 * autocorrige ("Negativo; na verdade neutro"); emenda outro rótulo em lista
 * ("Negativo, positivo e neutro são as opções"); ou afirma/soma outro rótulo
 * ("Sim, mas também não", "Negativo. Positivo."). Desqualificado, quem decide
 * é a extração flexível (teto 'parcial').
 */
function leadLabel(answer: string, universe: LabelUniverse): string | null {
  const sep = LEAD_SEPARATOR.exec(answer);
  if (!sep || sep.index === 0) return null;
  const head = normalizeLabel(answer.slice(0, sep.index));
  if (!universe.acceptable.has(head)) return null;
  const resto = foldLine(answer.slice(sep.index));
  const semAspas = stripQuoted(resto);
  if (hasHedge(wordsOf(semAspas)) || hasGlobalUncertainty(semAspas)) return null;

  const run = LEAD_RUN.exec(resto)?.[0] ?? '';
  const forte = /^[\s.!]+$/.test(run) && !/\.\./.test(run);
  const depois = resto.slice(run.length);
  const fimOracao = depois.search(CLAUSE_BOUNDARY);
  const oracao = wordsOf(fimOracao === -1 ? depois : depois.slice(0, fimOracao));
  const fimFrase = depois.search(SENTENCE_BOUNDARY);
  const frase = wordsOf(fimFrase === -1 ? depois : depois.slice(0, fimFrase));
  const outros = universe.all.filter((l) => l !== head);
  const rotuloNegacao = NEGATION_WORDS.has(head) || POST_NEGATION.has(head);

  if (!rotuloNegacao) {
    if (forte ? onlyDoubt(frase) : onlyDoubt(oracao)) return null;
    // Separador fraco + negação: "urgente, não…" nega o rótulo; "normal, não urgente" é contraste.
    if (!forte && startsWithNegation(oracao) && !mentionsAnyLabel(oracao.slice(1), outros)) return null;
  }
  // Lista emendada: "Negativo, positivo e neutro são as opções".
  if (!forte && oracao.length > 0 && mentionsAnyLabel(oracao.slice(0, 1), outros)) return null;
  // Alternativa: algum trecho começa com "ou"/"or" ("Negativo (ou neutro)", "Negativo... ou não").
  for (const trecho of resto.split(CLAUSE_BOUNDARY)) {
    const w = wordsOf(trecho);
    if (w.length > 0 && ALTERNATIVE_WORDS.has(w[0]) && w[1] !== 'seja') return null;
  }
  // Autocorreção seguida de negação, hesitação ou outro rótulo ("Negativo; na verdade neutro").
  const palavras = wordsOf(resto);
  for (const p of CORRECTION_PHRASES) {
    const idx = ` ${palavras.join(' ')} `.indexOf(` ${p} `);
    if (idx === -1) continue;
    const seguintes = wordsOf(` ${palavras.join(' ')} `.slice(idx + p.length + 1));
    if (seguintes.some((w) => NEGATION_WORDS.has(w)) || hasHedge(seguintes) || mentionsAnyLabel(seguintes, outros)) {
      return null;
    }
  }
  if (tailConflict([resto], universe)) return null;
  return head;
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
  // Rejeitado ("Neutro? Não, há raiva.") conta como negado: não é afirmação.
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
 * linha (pulando UM cabeçalho sem rótulo, "## Resultado"/"Sentimento:") →
 * rótulo abrindo a primeira linha → flexível (teto 'parcial'). Pergunta
 * ("Urgente?") nunca resolve: a normalização apagaria o '?'.
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
  const uncertain = hasGlobalUncertainty(folded.join('\n'));
  const corpo = linhas.length > 1 && isHeaderLine(linhas[0], universe) ? linhas.slice(1) : linhas;
  const pergunta = endsWithQuestion(corpo[0] ?? '');
  const sufixo = rawAlts.length > 1 ? ` (alternativas [${altsList(rawAlts)}])` : '';

  if (!pergunta && !endsWithQuestion(linhas[0] ?? '')) {
    const exata = alts.find((a) => a.norm === normText);
    if (exata) return gt('resolve', 'exact', `resposta é exatamente o rótulo esperado '${exata.raw}'${sufixo}`);
  }
  if (!pergunta && LANG_TAG.test(normText)) {
    const idioma = alts.find((a) => LANG_TAG.test(a.norm) && languageMatches(normText, a.norm));
    if (idioma) {
      return gt('resolve', 'language', `tag de idioma '${normText}' da resposta casa com o rótulo esperado '${idioma.raw}'${sufixo}`);
    }
  }

  let conflito: { raw: string; motivo: string } | null = null;
  if (!uncertain && corpo.length > 0) {
    const resposta = stripKeyPrefix(normalizeLabel(stripListMarker(corpo[0])), universe);
    const primeira = pergunta ? undefined : alts.find((a) => a.norm === resposta);
    const head = primeira ? null : leadLabel(resposta, universe);
    const casou = primeira ?? (head ? { raw: alts.find((a) => a.norm === head)?.raw ?? head, norm: head } : null);
    if (casou) {
      const motivo = tailConflict(corpo.slice(1).map(foldLine), universe);
      if (!motivo) {
        return primeira
          ? gt('resolve', 'first-line', `primeira linha da resposta casa com o rótulo esperado '${casou.raw}'${sufixo}`)
          : gt('resolve', 'lead', `primeira linha abre com o rótulo esperado '${casou.raw}' seguido de separador${sufixo}`);
      }
      conflito = { raw: casou.raw, motivo };
    }
  }

  const flex = flexibleVerdict(folded, normText, alts, rawAlts, universe, uncertain);
  if (conflito && flex.rule === 'standalone') {
    return gt(
      'parcial',
      'standalone',
      `primeira linha casa com '${conflito.raw}', mas o resto da resposta ${conflito.motivo} — no modo estrito isso não resolve`,
    );
  }
  return flex;
}

/** Prosa FORA dos documentos JSON (sem as linhas de fence): o que vem antes do 1º documento e todas as linhas. */
function proseAround(text: string, docs: readonly JsonDoc[]): { before: string; lines: string[] } {
  if (docs.length === 0 || docs.some((d) => d.whole)) return { before: '', lines: [] };
  const inicio = text.indexOf(docs[0].source);
  const before = inicio > 0 ? text.slice(0, inicio).replace(/```[^\n]*/g, ' ') : '';
  let resto = text;
  for (const d of docs) resto = resto.replace(d.source, '\n');
  const lines = resto
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !/^\s*```/.test(l))
    .map(foldLine);
  return { before, lines };
}

/**
 * JSON EMBUTIDO em prosa: a prosa em volta pode desmentir o JSON ("Na verdade
 * é positivo.", "Ou talvez positivo.", "Acho que: {…}"). Motivo + regra, ou
 * null quando a prosa é neutra (ou o JSON é a resposta inteira).
 */
function proseContradiction(
  text: string,
  docs: readonly JsonDoc[],
  universe: LabelUniverse,
): { rule: GroundTruthRule; why: string } | null {
  const { before, lines } = proseAround(text, docs);
  if (lines.length === 0) return null;
  if (hasHedge(wordsOf(stripQuoted(foldLine(before))))) return { rule: 'hedged', why: 'o texto antes do JSON hesita' };
  if (hasGlobalUncertainty(lines.join('\n'))) return { rule: 'hedged', why: 'o texto em volta declara incerteza' };
  const motivo = tailConflict(lines, universe);
  return motivo ? { rule: 'multi-label', why: `o texto em volta ${motivo}` } : null;
}

/**
 * Outro campo do JSON que desmente o rótulo: valor que é EXATAMENTE outro
 * rótulo do conjunto (no topo, ou em chave de rótulo de um objeto aninhado:
 * `{"a": {"label": "positivo"}, "label": "negativo"}`), ou valor que é só
 * hesitação (`"confianca": "talvez"`). Negação seca ("nenhum") não conta.
 */
function contradictingField(
  docs: readonly JsonDoc[],
  universe: LabelUniverse,
): { rule: GroundTruthRule; why: string } | null {
  const outroRotulo = (x: unknown): boolean => {
    if (typeof x !== 'string') return false;
    const n = normalizeLabel(x);
    return universe.all.includes(n) && !universe.acceptable.has(n);
  };
  for (const d of docs) {
    if (!isRecord(d.value)) continue;
    for (const [key, x] of Object.entries(d.value)) {
      if (outroRotulo(x)) return { rule: 'json-ambiguous', why: `traz também '${String(x)}' (campo '${key}')` };
      if (typeof x === 'string') {
        const folded = foldLine(x);
        const w = wordsOf(folded);
        if ((onlyDoubt(w) && hasHedge(w)) || hasGlobalUncertainty(folded)) {
          return { rule: 'hedged', why: `declara dúvida no campo '${key}' ('${x}')` };
        }
      }
      if (!isRecord(x)) continue;
      for (const [k2, y] of Object.entries(x)) {
        const chave = normalizeLabel(k2);
        if ((SPECIFIC_LABEL_KEYS.has(chave) || GENERIC_LABEL_KEYS.has(chave)) && outroRotulo(y)) {
          return { rule: 'json-ambiguous', why: `traz também '${String(y)}' (campo '${key}.${k2}')` };
        }
      }
    }
  }
  return null;
}

function matchLabelStrict(text: string, rawAlts: string[], alts: Alt[], labelSet?: readonly string[]): GroundTruthResult {
  const universe = buildUniverse(
    alts.map((a) => a.norm),
    labelSet,
  );

  // 1. JSON estrito.
  const { label: json, docs } = strictJsonLabel(text);
  if (json.kind === 'ambiguous') {
    return gt('nao', 'json-ambiguous', `resposta JSON ambígua: ${json.why} — não há UM rótulo inequívoco`);
  }
  if (json.kind === 'value') {
    const v = normalizeLabel(json.value);
    const hit = alts.find((a) => a.norm === v);
    if (hit) {
      // Outro campo do mesmo JSON desmente o rótulo ({"resposta":"negativo","outro":"positivo"}).
      const campo = contradictingField(docs, universe);
      if (campo) {
        return gt('nao', campo.rule, `resposta JSON traz o rótulo esperado '${hit.raw}', mas ${campo.why} — não há UM rótulo inequívoco`);
      }
      const contra = proseContradiction(text, docs, universe);
      if (contra) {
        return gt('nao', contra.rule, `JSON traz o rótulo esperado '${hit.raw}', mas ${contra.why} — resposta não é inequívoca`);
      }
      return gt('resolve', 'json', `JSON da resposta traz o rótulo esperado '${hit.raw}'`);
    }
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
      // JSON embutido: a prosa em volta não pode desmentir o campo.
      const normValue = normalizeLabel(toComparableString(value));
      const contra = proseContradiction(text, docs, buildUniverse([normValue], labelSet));
      if (contra) {
        return gt('nao', contra.rule, `campo '${field}' do JSON confere ('${display(value)}'), mas ${contra.why} — resposta não é inequívoca`);
      }
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
