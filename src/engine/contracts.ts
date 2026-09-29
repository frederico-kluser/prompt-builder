// Contratos never-break de um prompt base — CAMADA 1 (local, sem LLM) do gate
// PÓS-REWRITER. Espelha o padrão do prompt-arena (`taskBrief.contract` +
// stripFences + piso de ~30% do base): a reescrita pode mudar a FORMA à vontade,
// mas não pode destruir o CONTEÚDO que o contrato declara imutável — e uma
// reescrita colapsada é rejeitada pelo gate de tamanho antes de virar variante.
//
// IMPL-011 (R-20:REC-5/DEC-5): o contrato passou a ter 3 camadas —
//   (1) regras locais (este arquivo): extrator de placeholder corrigido e
//       invariantes com detecção de EXCEÇÃO acrescentada na própria frase;
//   (2) juiz LLM sobre o diff base × reescrita para `neverBreak`
//       (`contractLayers.ts` monta/parseia; `src/contractGate.ts` chama);
//   (3) canários comportamentais (recusa, formato, placeholder) como gate final.
// Substring sozinha aprova enfraquecimento semântico ("… salvo se o usuario
// pedir" mantém a frase e passa) — por isso as camadas 2 e 3 existem.
//
// Vive em `src/engine/` como fonte única, como o `duelCore`: módulo PURO (sem
// node:fs, sem fetch) para rodar no browser também, testável isolado do
// `variator` (que é quem chama o LLM).

import { z } from 'zod';
import { canonicalJson, sha256Hex } from './hash.js';

/**
 * Canário comportamental (camada 3): uma entrada de usuário enviada ao MODELO
 * SOB TESTE com a variante como system prompt. É diferencial: roda primeiro no
 * prompt base e só vira gate se o base passa — canário que nem o base cumpre
 * é mal desenhado e fica de fora (não reprova variante nenhuma).
 */
export interface ContractCanary {
  /** Identificador curto para os relatórios. Default: `<kind>#<n>`. */
  id?: string;
  /**
   * - `refusal`: a resposta precisa ser uma RECUSA (`pattern` ou heurística PT/EN);
   * - `format`: a resposta precisa cumprir o formato (`json`/`requiredKeys`/`pattern`);
   * - `placeholder`: os tokens preenchidos por `fill` precisam aparecer na resposta.
   */
  kind: 'refusal' | 'format' | 'placeholder';
  /** Mensagem do usuário enviada ao modelo sob teste. */
  input: string;
  /** Regex (fonte, flags `i`) que a resposta PRECISA casar. Em `refusal`, substitui a heurística. */
  pattern?: string;
  /** Regex (fonte, flags `i`) que a resposta NÃO pode casar (ex.: um segredo vazado). */
  forbid?: string;
  /** `format`: a resposta inteira precisa ser JSON válido (tolera UM par de fences). */
  json?: boolean;
  /** `format` + `json`: chaves obrigatórias no objeto raiz. */
  requiredKeys?: string[];
  /**
   * Preenchimento dos tokens no system prompt (`{"{nome}": "Zulmira"}`). Em
   * `placeholder`, cada valor preenchido precisa aparecer na resposta.
   */
  fill?: Record<string, string>;
  /** Teto de tokens da resposta do canário. Default 400. */
  maxTokens?: number;
}

/** Contratos never-break de um prompt base (validação pós-rewriter). */
export interface PromptContracts {
  /** Invariantes: cada string precisa continuar presente na reescrita, com a mesma força. */
  neverBreak?: string[];
  /**
   * Whitelist EXPLÍCITA de tokens que precisam sobreviver VERBATIM (ex.:
   * "{os}", "{{count}}", "$API_KEY"). Presente, substitui a detecção
   * automática; `[]` desliga a checagem de placeholders.
   */
  placeholders?: string[];
  /** Comprimento mínimo da reescrita como fração do base. Default 0.3. */
  minLengthRatio?: number;
  /**
   * Camada 2 — juiz LLM sobre o diff base × reescrita para `neverBreak`.
   * Default: ligado sempre que há `neverBreak`. `false` desliga (só camada 1).
   */
  judgeDiff?: boolean;
  /** Camada 3 — canários comportamentais (gate final). Ausente = sem canário. */
  canaries?: ContractCanary[];
}

export type ContractViolationKind =
  // camada 1 (local)
  | 'empty'
  | 'length'
  | 'placeholder'
  | 'neverBreak'
  | 'exception'
  // camada 2 (juiz do diff)
  | 'semantic'
  | 'judgeError'
  // camada 3 (canários)
  | 'canary'
  | 'canaryError';

export type ContractLayer = 'local' | 'judge' | 'canary';

export interface ContractViolation {
  kind: ContractViolationKind;
  /** Mensagem curta em PT-BR citando o que quebrou. */
  detail: string;
}

export interface VerifyRewriteResult {
  ok: boolean;
  violations: ContractViolation[];
}

/**
 * Camada de cada tipo de violação. `judgeError`/`canaryError` são falhas de
 * INFRA da verificação (não do texto): o gate reprova assim mesmo (variante
 * não verificável não entra), mas o log separa uma coisa da outra.
 */
export function layerOf(kind: ContractViolationKind): ContractLayer {
  if (kind === 'semantic' || kind === 'judgeError') return 'judge';
  if (kind === 'canary' || kind === 'canaryError') return 'canary';
  return 'local';
}

/**
 * Falha de INFRA da verificação (juiz/canário não rodou ou não respondeu no
 * formato): pedir outra reescrita não resolve — o variator rejeita direto,
 * sem gastar a correção.
 */
export function isInfraViolation(kind: ContractViolationKind): boolean {
  return kind === 'judgeError' || kind === 'canaryError';
}

/** Piso absoluto de tamanho: um prompt de sistema nunca deve ter menos que isto. */
const MIN_ABSOLUTE_LENGTH = 40;
/** Fração default do base que a reescrita precisa preservar (padrão prompt-arena: 30%). */
const DEFAULT_MIN_LENGTH_RATIO = 0.3;

// ---------------------------------------------------------------------------
// Extrator de placeholders
// ---------------------------------------------------------------------------

/** Identificador de template: `nome`, `user_id`, `user.name` (Jinja/Handlebars). */
const IDENT = '[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*';

/** Conteúdo de tag de template: qualquer coisa sem chave, com ao menos 1 caractere visível. */
const TEMPLATE_BODY = '[^{}]*[^{}\\s][^{}]*';

/**
 * Placeholders de texto. A ordem da alternância importa: `{{{…}}}` e `{{…}}`
 * vêm ANTES de `{…}` para o token duplo não ser fatiado no meio, e `${…}`
 * antes de `$VAR`.
 *  - Chave SIMPLES só conta com IDENTIFICADOR dentro — o extrator antigo
 *    aceitava `{…}` qualquer, e um literal JSON como `{"status": "ok"}` virava
 *    "placeholder" que precisava sobreviver verbatim (o caso medido do
 *    repositório na R-20: reprovava reescritas legítimas).
 *  - Chave DUPLA/TRIPLA (`{{…}}`, `{{{…}}}`) e tags Jinja (`{%…%}`, `{#…#}`)
 *    aceitam QUALQUER conteúdo sem chave: `{{` nunca abre JSON válido, e
 *    restringir a identificador deixava passar reescrita que apaga
 *    `{{#if premium}}…{{/if}}` ou `{{ produto | upper }}` (falso negativo).
 *  - `$VAR` só maiúsculas (como no contrato) e `%s` (printf) seguem como antes.
 */
const PLACEHOLDER_RE = new RegExp(
  [
    `\\{\\{\\{${TEMPLATE_BODY}\\}\\}\\}`,
    `\\{\\{${TEMPLATE_BODY}\\}\\}`,
    `\\{%${TEMPLATE_BODY}%\\}`,
    `\\{#${TEMPLATE_BODY}#\\}`,
    `\\$\\{${IDENT}\\}`,
    `\\{${IDENT}\\}`,
    '\\$[A-Z_][A-Z0-9_]*',
    '%s',
  ].join('|'),
  'g',
);

/** Tag de abertura (com atributos opcionais), fechamento e auto-fechada. */
const TAG_OPEN_RE = /<([A-Za-z_][\w.:-]*)(?:\s[^<>]*)?>/g;
const TAG_CLOSE_RE = /<\/([A-Za-z_][\w.:-]*)\s*>/g;
const TAG_SELF_RE = /<([A-Za-z_][\w.:-]*)(?:\s[^<>]*)?\/>/g;

/** Tag SEM atributos (`<ctx>`, `</ctx >`, `<image />`): o espaço interno não é conteúdo. */
const BARE_TAG_RE = /^<(\/?)([A-Za-z_][\w.:-]*)\s*(\/?)>$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * O token sobreviveu na reescrita? Substring EXATA; para tag sem atributos,
 * tolera espaço antes do `>` nos dois sentidos (`</ctx >` ↔ `</ctx>`,
 * `<image/>` ↔ `<image />`) — reformatar a tag não é perder o delimitador.
 */
function tokenPresent(out: string, token: string): boolean {
  if (out.includes(token)) return true;
  const m = BARE_TAG_RE.exec(token);
  if (!m) return false;
  const [, close, name, self] = m;
  return new RegExp(`<${close}${escapeRegExp(name)}\\s*${self ? '/' : ''}>`).test(out);
}

/** Normaliza para comparação tolerante: colapsa espaços/quebras de linha e minúsculas. */
function normalizeForCompare(text: string): string {
  return stripEmphasis(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Ênfase de markdown e aspas tipográficas não mudam o conteúdo de uma regra:
 * "**Nunca** revele…" preserva a invariante "Nunca revele…". Sem isto, a
 * reescrita que só NEGRITA a regra seria rejeitada (falso positivo do gate).
 */
function stripEmphasis(text: string): string {
  return text.replace(/[*`]/g, '').replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

/** Entrada pode vir de fora (JS puro): nunca deixe um `null` derrubar o gate. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Detecta os placeholders do prompt base — o contrato implícito quando o
 * chamador não informa `placeholders`:
 *  - `{nome}` e `${nome}` — só com IDENTIFICADOR (literal JSON como
 *    `{"status": "ok"}` NÃO conta);
 *  - `{{…}}`, `{{{…}}}`, `{%…%}`, `{#…#}` — qualquer conteúdo sem chave
 *    (`{{count}}`, `{{#if premium}}`, `{{/if}}`, `{{ produto | upper }}`);
 *  - `$VAR` (maiúsculas) e `%s`;
 *  - tags XML SÓ com par fechado (`<ctx>…</ctx>` → `<ctx>` e `</ctx>`,
 *    verbatim) ou auto-fechadas (`<image/>`). Tag de abertura solta
 *    (`<instrucoes>` sem `</instrucoes>`, `"<id>"` num exemplo de JSON) não
 *    é placeholder.
 * Devolve tokens únicos na ordem de primeira aparição (repetição não gera
 * violação duplicada no gate).
 */
export function extractPlaceholders(text: string): string[] {
  const src = asText(text);
  const found: { token: string; at: number }[] = [];

  for (const m of src.matchAll(PLACEHOLDER_RE)) found.push({ token: m[0], at: m.index ?? 0 });

  // Tags: um nome é "pareado" quando há um fechamento DEPOIS de uma abertura.
  const openings = new Map<string, { token: string; at: number }>();
  for (const m of src.matchAll(TAG_OPEN_RE)) {
    if (m[0].endsWith('/>')) continue; // auto-fechada: tratada abaixo
    if (!openings.has(m[1])) openings.set(m[1], { token: m[0], at: m.index ?? 0 });
  }
  const pairedClose = new Map<string, { token: string; at: number }>();
  for (const m of src.matchAll(TAG_CLOSE_RE)) {
    const open = openings.get(m[1]);
    const at = m.index ?? 0;
    if (open && open.at < at && !pairedClose.has(m[1])) {
      // Token VERBATIM (`</ctx >` fica `</ctx >`): normalizado, ele não
      // existiria no base e o gate reprovaria até a reescrita idêntica.
      pairedClose.set(m[1], { token: m[0], at });
    }
  }
  for (const [name, close] of pairedClose) {
    found.push(openings.get(name)!, close);
  }
  for (const m of src.matchAll(TAG_SELF_RE)) found.push({ token: m[0], at: m.index ?? 0 });

  found.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { token } of found) {
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exceção acrescentada a uma invariante (camada 1, barata)
// ---------------------------------------------------------------------------

/**
 * Forma NEGADA do substantivo "exceção"/"exception" é REFORÇO, não exceção:
 * "sem exceção", "(sem exceções)", "sem nenhuma exceção", "nenhuma exceção",
 * "não abra exceções", "jamais faça exceção", "with no exceptions", "without
 * exception", "make no exceptions", "not even in exceptional cases". Testado
 * no texto IMEDIATAMENTE antes do marcador (negação + verbo opcional + até 3
 * determinantes). Antes, o marcador casava na forma negada e a camada 1
 * reprovava justamente quem REFORÇAVA a invariante — o viés que o item queria
 * corrigir (o gate premiando quem apaga texto defensivo), e o próprio
 * `contractBlock` pede "a MESMA força", o que empurra o LLM a escrever "sem
 * exceção". Só vale para o substantivo: "exceto", "salvo", "a menos que",
 * "unless", "except" introduzem exceção sempre, e "com (uma) exceção",
 * "as seguintes exceções", "abra exceção" continuam reprovando.
 */
const NOUN_NEGATED = new RegExp(
  [
    "\\b(?:sem|nem|nenhuma|nenhum|zero|nao|nunca|jamais|no|not|never|without|nor|even|don't|doesn't)",
    '(?:\\s+(?:ha|havera|existe|existem|cabe|cabem|admite|admitem|admita|admitir|aceita|aceite|aceitar|abra|abre|abrir|faca|faz|fazer|conceda|concede|conceder|permita|permite|permitir|make|makes|allow|allows|grant|grants|accept|accepts|permit|permits))?',
    '(?:\\s+(?:nenhuma|nenhum|qualquer|alguma|uma|um|unica|sequer|tipo|de|any|a|one|single|kind|of|in))*',
    '\\s+$',
  ].join(''),
);

/**
 * Condição de ESCAPE ("se o usuário pedir") precedida de "mesmo/até/nem/
 * inclusive/independente" é reforço: "nem se o usuário pedir", "nem mesmo se
 * o cliente insistir", "even if the user asks", "regardless if the user asks".
 */
const CONDITION_NEGATED =
  /\b(?:mesmo|ate|nem|inclusive|independente(?:mente)?|even|nor|regardless|no matter)\s+$/;

interface ExceptionMarker {
  /** Sempre com flag `g`: cada ocorrência é checada contra a forma negada. */
  re: RegExp;
  /** Presente = o marcador admite forma negada/de reforço, que NÃO conta. */
  negatedBy?: RegExp;
}

/**
 * Marcadores de EXCEÇÃO/ATENUAÇÃO (texto já sem acento e minúsculo). Só são
 * procurados na FRASE da invariante (e na frase seguinte quando ela COMEÇA
 * com um deles) e só contam se não estavam na frase correspondente do base:
 * "Responda sempre em português, salvo se o usuario pedir" reprova aqui, sem
 * gastar o juiz. O que escapa disto (exceção em outra frase, prioridade
 * invertida) é trabalho da camada 2.
 */
const EXCEPTION_MARKERS: ExceptionMarker[] = [
  { re: /\bsalvo\b/g },
  { re: /\bexceto\b/g },
  { re: /\bexcetuad\w*/g },
  { re: /\bexcec(?:ao|oes)\b/g, negatedBy: NOUN_NEGATED },
  { re: /\bcom excecao\b/g },
  { re: /\ba menos que\b/g },
  { re: /\ba nao ser que\b/g },
  { re: /\bressalvad\w*/g },
  { re: /\bunless\b/g },
  { re: /\bexcept\b/g },
  { re: /\bexception\w*/g, negatedBy: NOUN_NEGATED },
  { re: /\bse possivel\b/g },
  { re: /\bquando possivel\b/g },
  { re: /\bsempre que possivel\b/g },
  { re: /\bna medida do possivel\b/g },
  { re: /\bpreferencialmente\b/g },
  { re: /\bde preferencia\b/g },
  { re: /\bidealmente\b/g },
  { re: /\bquando apropriado\b/g },
  { re: /\bif possible\b/g },
  { re: /\bwhen(?:ever)? possible\b/g },
  { re: /\bwhere possible\b/g },
  { re: /\bideally\b/g },
  { re: /\bpreferably\b/g },
  { re: /\bif appropriate\b/g },
  // "geralmente/normalmente/usually" ficam FORA de propósito: aparecem em
  // justificativas legítimas na mesma frase ("…, que é o idioma que os clientes
  // normalmente usam") — falso positivo aqui; a camada 2 julga o sentido.
  // "se o usuário pedir" é exceção; "MESMO/NEM se o usuário pedir" é reforço.
  {
    re: /\bse o (?:usuario|cliente) (?:pedir|solicitar|insistir|quiser|preferir|autorizar)\b/g,
    negatedBy: CONDITION_NEGATED,
  },
  {
    re: /\bcaso o (?:usuario|cliente) (?:peca|solicite|insista|queira|prefira|autorize)\b/g,
    negatedBy: CONDITION_NEGATED,
  },
  { re: /\bif the user (?:asks|requests|insists|wants|prefers)\b/g, negatedBy: CONDITION_NEGATED },
];

/** Frase que COMEÇA com exceção ("Exceto se…") ainda qualifica a anterior. */
const STARTS_WITH_EXCEPTION = /^\s*(?:salvo|exceto|a menos que|a nao ser que|com excecao|unless|except)\b/;

function foldAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

interface SegmentedText {
  /** Texto normalizado (espaço colapsado, minúsculo, sem ênfase). */
  text: string;
  /** `brk[i]`: a posição i encerra uma frase (.!?; ou quebra de linha). */
  brk: boolean[];
}

/**
 * Mesma normalização de `normalizeForCompare`, mas lembrando ONDE havia fim
 * de frase — assim a invariante é achada mesmo quebrada em duas linhas e a
 * janela da frase ainda respeita as quebras reais do texto.
 */
function segment(raw: string): SegmentedText {
  const chars: string[] = [];
  const brk: boolean[] = [];
  for (const c of stripEmphasis(raw)) {
    if (/\s/.test(c)) {
      if (chars.length === 0) continue;
      if (chars[chars.length - 1] === ' ') {
        if (c === '\n') brk[brk.length - 1] = true;
        continue;
      }
      chars.push(' ');
      brk.push(c === '\n');
      continue;
    }
    for (const lower of c.toLowerCase()) {
      chars.push(lower);
      brk.push(/[.!?;]/.test(lower));
    }
  }
  while (chars.length && chars[chars.length - 1] === ' ') {
    chars.pop();
    brk.pop();
  }
  return { text: chars.join(''), brk };
}

/** Janelas (frase da ocorrência [+ frase seguinte que começa com exceção]). */
function invariantWindows(seg: SegmentedText, needle: string): string[] {
  const windows: string[] = [];
  if (!needle) return windows;
  const len = seg.text.length;
  /** Índice do 1º fim de frase em [i, len); len-1 se não houver. */
  const nextBreak = (i: number): number => {
    let k = i;
    while (k < len && !seg.brk[k]) k++;
    return Math.min(k, len - 1);
  };
  let from = 0;
  for (;;) {
    const at = seg.text.indexOf(needle, from);
    if (at < 0) break;
    const end = at + needle.length;
    // Início da frase: volta até logo depois do fim de frase anterior.
    let start = at;
    while (start > 0 && !seg.brk[start - 1]) start--;
    // Fim da frase: o 1º fim de frase a partir do ÚLTIMO caractere da
    // invariante (as quebras DENTRO dela não contam — pode vir em 2 linhas).
    const stop = nextBreak(end - 1) + 1;
    let window = seg.text.slice(start, stop);
    // Frase seguinte entra só se COMEÇAR com marcador de exceção.
    if (stop < len) {
      const next = seg.text.slice(stop, nextBreak(stop) + 1);
      if (STARTS_WITH_EXCEPTION.test(foldAccents(next))) window += next;
    }
    windows.push(foldAccents(window));
    from = at + 1;
  }
  return windows;
}

/** Janela de texto antes do marcador em que se procura a negação. */
const NEGATION_LOOKBACK = 60;

function markersIn(windows: string[]): Set<string> {
  const out = new Set<string>();
  for (const w of windows) {
    for (const { re, negatedBy } of EXCEPTION_MARKERS) {
      for (const m of w.matchAll(re)) {
        const at = m.index ?? 0;
        // Forma negada ("sem exceção", "nem se o usuário pedir") é reforço.
        if (negatedBy?.test(w.slice(Math.max(0, at - NEGATION_LOOKBACK), at))) continue;
        out.add(m[0]);
        break;
      }
    }
  }
  return out;
}

/**
 * Marcadores de exceção/atenuação que a reescrita ACRESCENTOU à frase da
 * invariante (os que já estavam no base não contam). Vazio = sem exceção nova.
 */
export function addedExceptionMarkers(base: string, rewritten: string, invariant: string): string[] {
  const needle = normalizeForCompare(asText(invariant));
  if (!needle) return [];
  const antes = markersIn(invariantWindows(segment(asText(base)), needle));
  const depois = markersIn(invariantWindows(segment(asText(rewritten)), needle));
  // A invariante pode trazer o próprio marcador ("… exceto X"): não é acréscimo.
  const daInvariante = markersIn([foldAccents(needle)]);
  return [...depois].filter((m) => !antes.has(m) && !daInvariante.has(m));
}

// ---------------------------------------------------------------------------
// Gate da camada 1
// ---------------------------------------------------------------------------

/**
 * Valida uma reescrita contra o base + contratos — CAMADA 1 (local, sem LLM).
 * Regras:
 *  - reescrita vazia/whitespace → violation 'empty';
 *  - comprimento: `rewritten.length >= max(40, base.length * (minLengthRatio ?? 0.3))`
 *    (quando base tem conteúdo; sem base, o piso é só 40 chars) — violation 'length';
 *  - placeholders: quando `contracts.placeholders` vier, usa a lista (whitelist
 *    explícita); senão usa `extractPlaceholders(base)`. Cada token precisa
 *    aparecer VERBATIM (substring exato; tag sem atributos tolera espaço antes
 *    do `>`) — violation 'placeholder' por token ausente;
 *  - neverBreak: cada invariante precisa aparecer na reescrita após
 *    normalização de espaços + minúsculas + ênfase de markdown (tolera quebra
 *    de linha/negrito, NÃO tolera remoção) — violation 'neverBreak';
 *  - presente mas com EXCEÇÃO/ATENUAÇÃO nova na mesma frase ("salvo se o
 *    usuario pedir", "sempre que possível") — violation 'exception'. Forma
 *    negada é reforço e não conta ("sem exceção", "nem se o usuário pedir",
 *    "with no exceptions").
 * Nunca lança exceção.
 */
export function verifyRewrite(
  base: string,
  rewritten: string,
  contracts?: PromptContracts,
): VerifyRewriteResult {
  const baseText = asText(base);
  const out = asText(rewritten);

  // Reescrita vazia é falha TERMINAL: não há o que validar nos demais contratos,
  // então o gate devolve só 'empty' em vez de empilhar violações derivadas.
  if (out.trim().length === 0) {
    return {
      ok: false,
      violations: [{ kind: 'empty', detail: 'Reescrita vazia (apenas espaços) — nada para validar.' }],
    };
  }

  const violations: ContractViolation[] = [];

  // Comprimento: piso absoluto de 40 chars, elevado pela fração do base quando
  // o base tem conteúdo. NaN/negativo em minLengthRatio cai no default (0.3) —
  // nunca vira comparação com NaN, que reprovaria tudo em silêncio.
  const rawRatio = contracts?.minLengthRatio;
  const ratio =
    typeof rawRatio === 'number' && Number.isFinite(rawRatio) && rawRatio >= 0
      ? rawRatio
      : DEFAULT_MIN_LENGTH_RATIO;
  const floor =
    baseText.trim().length > 0
      ? Math.max(MIN_ABSOLUTE_LENGTH, baseText.length * ratio)
      : MIN_ABSOLUTE_LENGTH;
  if (out.length < floor) {
    violations.push({
      kind: 'length',
      detail: `Reescrita curta demais: ${out.length} caracteres (mínimo ${Math.ceil(floor)}).`,
    });
  }

  // Placeholders: a lista explícita tem prioridade; lista vazia = contrato sem
  // placeholders (o chamador sabe o que faz). Token precisa ser substring EXATA.
  const placeholders = Array.isArray(contracts?.placeholders)
    ? contracts.placeholders
    : extractPlaceholders(baseText);
  for (const token of placeholders) {
    if (typeof token !== 'string' || token.length === 0) continue;
    if (!tokenPresent(out, token)) {
      violations.push({
        kind: 'placeholder',
        detail: `Placeholder "${token}" sumiu da reescrita (precisa sobreviver verbatim).`,
      });
    }
  }

  // neverBreak: comparação normalizada nos dois lados — quebra de linha, caixa
  // ou negrito mudam a forma, não o conteúdo; remover a regra reprova, e
  // mantê-la com exceção nova na mesma frase também.
  const normalizedOut = normalizeForCompare(out);
  for (const invariant of Array.isArray(contracts?.neverBreak) ? contracts.neverBreak : []) {
    if (typeof invariant !== 'string' || invariant.trim().length === 0) continue;
    if (!normalizedOut.includes(normalizeForCompare(invariant))) {
      violations.push({
        kind: 'neverBreak',
        detail: `Invariante ausente na reescrita: "${invariant}".`,
      });
      continue;
    }
    const acrescidos = addedExceptionMarkers(baseText, out, invariant);
    if (acrescidos.length > 0) {
      violations.push({
        kind: 'exception',
        detail: `Invariante "${invariant}" ganhou exceção/atenuação que não existia no base (${acrescidos
          .map((m) => `"${m}"`)
          .join(', ')}).`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Remove UM par de fences ``` envolvendo a saida inteira (fences internos ficam).
 * Espelha o stripFences do variator — fica aqui para o gate ser testável isolado.
 */
export function stripFences(text: string): string {
  const trimmed = asText(text).trim();
  const match = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

// ---------------------------------------------------------------------------
// Schema (fonte única para arena-config — src e web — e API /v1)
// ---------------------------------------------------------------------------

/** Regex vinda de config: precisa compilar, senão o canário quebraria em runtime. */
const regexSource = (campo: string) =>
  z
    .string(`${campo} deve ser texto (regex)`)
    .min(1, `${campo} vazio`)
    .max(500, `${campo}: máximo 500 caracteres`)
    .refine((s) => {
      try {
        new RegExp(s, 'i');
        return true;
      } catch {
        return false;
      }
    }, `${campo} não é uma regex válida`);

export const contractCanarySchema = z
  .object(
    {
      id: z.string().min(1).max(60).optional(),
      kind: z.enum(['refusal', 'format', 'placeholder'], "kind deve ser 'refusal' | 'format' | 'placeholder'"),
      input: z.string('input obrigatório').min(1, 'input obrigatório').max(4000, 'input: máximo 4000 caracteres'),
      pattern: regexSource('pattern').optional(),
      forbid: regexSource('forbid').optional(),
      json: z.boolean().optional(),
      requiredKeys: z.array(z.string().min(1)).max(50).optional(),
      fill: z.record(z.string().min(1), z.string()).optional(),
      maxTokens: z.number().int().min(16).max(4000).optional(),
    },
    'canário deve ser { kind, input, pattern?, forbid?, json?, requiredKeys?, fill?, maxTokens? }',
  )
  .superRefine((c, ctx) => {
    if (c.kind === 'format' && !c.json && !c.pattern) {
      ctx.addIssue({ code: 'custom', message: "canário 'format' precisa de json: true ou pattern" });
    }
    if (c.kind === 'placeholder' && Object.keys(c.fill ?? {}).length === 0) {
      ctx.addIssue({ code: 'custom', message: "canário 'placeholder' precisa de fill { token: valor }" });
    }
  });

/** Schema de `contracts` — o MESMO nos três pontos de entrada (sem whitelist divergente). */
export const promptContractsSchema = z.object(
  {
    neverBreak: z.array(z.string()).optional(),
    placeholders: z.array(z.string()).optional(),
    minLengthRatio: z
      .number('minLengthRatio deve ser número')
      .min(0, 'mínimo 0')
      .max(1, 'máximo 1')
      .optional(),
    judgeDiff: z.boolean('judgeDiff deve ser booleano').optional(),
    canaries: z.array(contractCanarySchema).max(20, 'no máximo 20 canários').optional(),
  },
  'contracts deve ser um objeto { neverBreak?, placeholders?, minLengthRatio?, judgeDiff?, canaries? }',
);

// ---------------------------------------------------------------------------
// CONTAMINAÇÃO dados→prompt (IMPL-067, R-20:REC-9/DEC-8) e VAZAMENTO de
// conjunto de guarda (IMPL-069, R-21:REC-2/REC-3).
//
// O prompt campeão não pode memorizar o benchmark: cenário/gabarito/explicação
// do juiz colados no prompt inflam a nota na seleção e somem em produção (49%
// das runs ficam abaixo do zero-shot na literatura — super-ajuste). Duas
// leituras da sobreposição, com limiares DIFERENTES porque pegam coisas
// diferentes:
//
//   • CONTAINMENT (alerta ≥ 0,3): fração dos 8-gramas do prompt que existem no
//     corpus protegido, comparada em minúsculas/sem acento/espaço colapsado —
//     pega cópia com caixa e acentos trocados, paráfrase rasa e recolagem.
//     Só ALERTA: é ruído a relatar, não prova de cópia literal.
//   • SPAN EXATO ≥ 8 TOKENS (BLOQUEIO): trecho idêntico token a token (só
//     espaço é tolerado) presente nos DOIS lados — cópia literal de frase do
//     cenário para dentro do prompt. O YAML/REC-9 fixa 8 tokens (o corpo da
//     pesquisa sugeria 12; calibrar com dados reais quando houver sessões).
//   • STRING-CANÁRIO migrada (BLOQUEIO): canário plantado no cenário que aparece
//     no prompt — migração de dado para instrução, sem ambiguidade.
//
// Aplicação (os 2 pontos do DEC-8): métrica no `pickWinner` (pré-promoção,
// `PickWinnerOpts.contamination` em src/rank.ts — o treino passa o corpus da
// run de seleção) e barreira final antes do handoff (`evaluateHandoffGuards`,
// src/engine/handoffGuards.ts, sobre os cenários pinados da sessão). O que o
// prompt de BASE já continha fica fora (`allowedTexts`): contaminação é o que
// o otimizador COLOU, não a política que o usuário escreveu. Tudo LOCAL e
// determinístico — custo ~zero, zero chamada de LLM.
// ---------------------------------------------------------------------------

/** Tokens por n-grama/span da sobreposição (REC-9: ≥ 8 tokens nos dois lados). */
export const CONTAMINATION_NGRAM = 8;
/** Span exato mínimo (tokens) que BLOQUEIA (prompt = cópia literal do corpus). */
export const CONTAMINATION_SPAN_TOKENS = 8;
/** Containment de 8-gramas que DISPARA O ALERTA (0,3 = 30% do prompt é corpus). */
export const CONTAINMENT_ALERT_RATIO = 0.3;

/** Token + posição no texto original (para redigir sem tocar o resto). */
interface RawToken {
  t: string;
  start: number;
  end: number;
}

function rawTokens(text: string): RawToken[] {
  const out: RawToken[] = [];
  for (const m of asText(text).matchAll(/\S+/g)) {
    const start = m.index ?? 0;
    out.push({ t: m[0], start, end: start + m[0].length });
  }
  return out;
}

/** Chave de n-grama: tokens unidos por separador que nunca aparece em token. */
const NGRAM_SEP = '\u0001';

function ngramKeys(tokens: readonly string[], n: number): Set<string> {
  const keys = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i += 1) {
    keys.add(tokens.slice(i, i + n).join(NGRAM_SEP));
  }
  return keys;
}

/**
 * Runs MÁXIMOS de janelas consecutivas que casam no corpus. Só janelas
 * consecutivas formam span exato maior (janelas 0 e 2 com a 1 a falhar são DOIS
 * spans de 8 tokens que se sobrepõem, nunca um span de 10). Devolve pares
 * [índice do 1º token, índice do último token] do trecho compartilhado.
 */
function exactSpanRanges(
  tokenCount: number,
  n: number,
  isHit: (from: number) => boolean,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let runStart = -1;
  let runEnd = -1;
  let prevHit = -2;
  for (let i = 0; i + n <= tokenCount; i += 1) {
    if (!isHit(i)) continue;
    if (i === prevHit + 1 && runStart >= 0) {
      runEnd = i + n - 1;
    } else {
      if (runStart >= 0) ranges.push([runStart, runEnd]);
      runStart = i;
      runEnd = i + n - 1;
    }
    prevHit = i;
  }
  if (runStart >= 0) ranges.push([runStart, runEnd]);
  return ranges;
}

/** Máximos trechos exatos (≥ `minTokens`) compartilhados entre prompt e corpus. */
function sharedExactSpans(
  prompt: string,
  protectedTexts: readonly string[],
  minTokens: number,
  allowedTexts: readonly string[] = [],
): string[] {
  const toks = rawTokens(prompt);
  if (toks.length < minTokens) return [];
  const corpus = new Set<string>();
  for (const src of protectedTexts ?? []) {
    for (const key of ngramKeys(rawTokens(src).map((k) => k.t), minTokens)) corpus.add(key);
  }
  // O que o prompt de BASE já trazia não é contaminação (a política do usuário).
  for (const src of allowedTexts ?? []) {
    for (const key of ngramKeys(rawTokens(src).map((k) => k.t), minTokens)) corpus.delete(key);
  }
  const ranges = exactSpanRanges(toks.length, minTokens, (i) =>
    corpus.has(toks.slice(i, i + minTokens).map((k) => k.t).join(NGRAM_SEP)),
  );
  return [...new Set(ranges.map(([a, b]) => prompt.slice(toks[a].start, toks[b].end)))];
}

/**
 * Containment de 8-gramas: fração das janelas do prompt cujo 8-grama existe no
 * corpus protegido (comparação NORMALIZADA — minúsculas, sem acento, espaço
 * colapsado). 0 quando o prompt não tem 8-grama completo.
 */
export function ngramContainment(
  prompt: string,
  protectedTexts: readonly string[],
  allowedTexts: readonly string[] = [],
): number {
  const toks = rawTokens(prompt).map((k) => foldAccents(k.t.toLowerCase()));
  if (toks.length < CONTAMINATION_NGRAM) return 0;
  const corpus = new Set<string>();
  for (const src of protectedTexts ?? []) {
    for (const key of ngramKeys(rawTokens(src).map((k) => foldAccents(k.t.toLowerCase())), CONTAMINATION_NGRAM)) {
      corpus.add(key);
    }
  }
  for (const src of allowedTexts ?? []) {
    for (const key of ngramKeys(rawTokens(src).map((k) => foldAccents(k.t.toLowerCase())), CONTAMINATION_NGRAM)) {
      corpus.delete(key);
    }
  }
  let total = 0;
  let hits = 0;
  for (let i = 0; i + CONTAMINATION_NGRAM <= toks.length; i += 1) {
    total += 1;
    if (corpus.has(toks.slice(i, i + CONTAMINATION_NGRAM).join(NGRAM_SEP))) hits += 1;
  }
  return total === 0 ? 0 : hits / total;
}

/** Strings-canário que migraram para o texto (comparação normalizada, exata). */
function canaryHitsIn(text: string, canaries: readonly string[] | undefined): string[] {
  const alvo = foldAccents(asText(text).toLowerCase());
  const hits: string[] = [];
  for (const canary of canaries ?? []) {
    const needle = foldAccents(asText(canary).trim().toLowerCase());
    if (needle && alvo.includes(needle)) hits.push(canary);
  }
  return hits;
}

/** Veredito de contaminação do prompt campeão contra o corpus protegido. */
export interface ContaminationCheck {
  /** Fração dos 8-gramas do prompt presentes no corpus (0..1). */
  containment: number;
  /** `containment` ≥ {@link CONTAINMENT_ALERT_RATIO} (alerta, não bloqueio). */
  alert: boolean;
  /** Spans exatos de ≥ 8 tokens migrados do corpus para o prompt. */
  exactSpans: string[];
  /** Strings-canário do cenário migradas para o prompt. */
  canaryHits: string[];
  /** BLOQUEIO (barreira): span exato ≥ 8 tokens OU canário migrado. */
  blocked: boolean;
  /** Mensagem PT-BR curta (vazia quando o prompt está limpo). */
  detail: string;
}

/**
 * Mede a contaminação dados→prompt do `prompt` contra `protectedTexts`
 * (cenários ∪ gabaritos ∪ explicações do juiz) + canários plantados. Local,
 * determinístico e barato — roda em toda campeã (métrica no `pickWinner`) e
 * como barreira final do handoff (`assertNoContamination`).
 */
export function contaminationCheck(
  prompt: string,
  protectedTexts: readonly string[],
  opts?: {
    canaries?: readonly string[];
    /**
     * Textos cujos n-gramas NÃO contam (o prompt de base/controle): a
     * política que o usuário escreveu e que também aparece nos cenários não é
     * dado do benchmark colado pelo otimizador.
     */
    allowedTexts?: readonly string[];
  },
): ContaminationCheck {
  const text = asText(prompt);
  const allowed = (opts?.allowedTexts ?? []).filter((t): t is string => typeof t === 'string' && t.length > 0);
  const containment = ngramContainment(text, protectedTexts ?? [], allowed);
  const exactSpans = sharedExactSpans(text, protectedTexts ?? [], CONTAMINATION_SPAN_TOKENS, allowed);
  const canaryHits = canaryHitsIn(text, opts?.canaries);
  const alert = containment >= CONTAINMENT_ALERT_RATIO;
  const blocked = exactSpans.length > 0 || canaryHits.length > 0;
  const motivos: string[] = [];
  if (exactSpans.length > 0) {
    motivos.push(
      `span exato de ≥ ${CONTAMINATION_SPAN_TOKENS} tokens do corpus protegido colado no prompt (${exactSpans.length}: "${exactSpans[0].slice(0, 80)}…")`,
    );
  }
  if (canaryHits.length > 0) {
    motivos.push(`string-canário migrada do cenário (${canaryHits.join(', ')})`);
  }
  if (alert) {
    motivos.push(`containment de 8-gramas ${(containment * 100).toFixed(0)}% ≥ ${CONTAINMENT_ALERT_RATIO * 100}%`);
  }
  return {
    containment,
    alert,
    exactSpans,
    canaryHits,
    blocked,
    detail: motivos.join('; '),
  };
}

/**
 * BARRERA FINAL de contaminação (handoff `sessions winner --apply` e pré-promoção):
 * lança erro PT-BR quando o prompt campeão carrega dado do benchmark. Devolve
 * o veredito quando limpo (para o chamador reportar o containment).
 */
export function assertNoContamination(
  prompt: string,
  protectedTexts: readonly string[],
  opts?: { canaries?: readonly string[]; allowedTexts?: readonly string[] },
): ContaminationCheck {
  const check = contaminationCheck(prompt, protectedTexts, opts);
  if (check.blocked) {
    throw new Error(
      `prompt campeão BLOQUEADO por contaminação dados→prompt (super-ajuste ao benchmark): ${check.detail}. ` +
        'Reveja o diff antes de aplicar — o ganho medido é inseparável da memorização de cenários.',
    );
  }
  return check;
}

/** Fatia de um cenário que entra no corpus protegido (estrutural: StageSpec serve). */
export interface ContaminationStage {
  question?: string;
  productContext?: string;
  reference?: string;
  rubric?: string;
}

/**
 * Corpus protegido de um conjunto de cenários (IMPL-067): pergunta, contexto,
 * gabarito e rubrica de cada um + textos extras (explicações do juiz). Vazios
 * saem; a ordem não importa (vira conjunto de n-gramas).
 */
export function contaminationCorpus(
  stages: readonly (ContaminationStage | null | undefined)[],
  extra: readonly (string | null | undefined)[] = [],
): string[] {
  const out: string[] = [];
  for (const st of stages ?? []) {
    if (!st) continue;
    for (const t of [st.question, st.productContext, st.reference, st.rubric]) {
      if (typeof t === 'string' && t.trim()) out.push(t);
    }
  }
  for (const t of extra ?? []) if (typeof t === 'string' && t.trim()) out.push(t);
  return out;
}

/**
 * Canário determinístico por cenário (IMPL-069): string exótica e estável,
 * plantada no `productContext`/rubrica do cenário. Se ela aparecer num prompt
 * (contaminação) ou numa resposta (vazamento de system prompt), a migração é
 * prova — sem depender de n-grama nem de juiz.
 */
export function scenarioCanary(seed: string): string {
  return `CANARIA-${sha256Hex(`canario-de-cenario:${asText(seed)}`).slice(0, 12).toUpperCase()}`;
}

/** Estados da métrica de segurança (IMPL-069) — separados do judge-score. */
export type SecurityState = 'violation' | 'refusal' | 'response';

/** Veredito de vazamento (canário exato + similaridade de n-gramas). */
export interface LeakCheck {
  /** true = dado do benchmark/canário vazou para a saída. */
  leak: boolean;
  /** O que denunciou: canário migrado, span exato do corpus ou nada. */
  via: 'canary' | 'span' | 'none';
  canaryHits: string[];
  exactSpans: string[];
  /** Mesmo containment de 8-gramas do prompt (similaridade com o corpus). */
  containment: number;
  /**
   * Sobreposição alta SEM span exato (cópia recortada/recolada): suspeito —
   * o classificador/juiz de segurança decide (fora deste módulo puro).
   */
  suspect: boolean;
  /** Mensagem PT-BR curta (vazia quando limpo). */
  detail: string;
}

/**
 * Vazamento de dado na RESPOSTA do modelo sob teste (canário exato + similaridade
 * de n-gramas/limiar — IMPL-069). `canaries` são as strings plantadas nos
 * cenários; `protectedTexts` é o corpus (cenários ∪ gabaritos ∪ explicações).
 * Repetir a POLÍTICA do app não é vazamento: sem canário e sem span exato do
 * corpus, `leak` é false mesmo com texto defensivo parecido.
 */
export function checkLeak(
  response: string,
  opts?: { canaries?: readonly string[]; protectedTexts?: readonly string[] },
): LeakCheck {
  const text = asText(response);
  const protectedTexts = opts?.protectedTexts ?? [];
  const canaryHits = canaryHitsIn(text, opts?.canaries);
  const exactSpans = sharedExactSpans(text, protectedTexts, CONTAMINATION_SPAN_TOKENS);
  const containment = ngramContainment(text, protectedTexts);
  const via: LeakCheck['via'] = canaryHits.length > 0 ? 'canary' : exactSpans.length > 0 ? 'span' : 'none';
  const leak = via !== 'none';
  const suspect = !leak && containment >= CONTAINMENT_ALERT_RATIO;
  const detail = leak
    ? `vazamento (${via === 'canary' ? 'canário migrado' : 'span exato do corpus'}): ${
        canaryHits.length > 0 ? canaryHits.join(', ') : exactSpans[0].slice(0, 80)
      }`
    : suspect
      ? `sobreposição alta com o corpus sem span exato (containment ${(containment * 100).toFixed(0)}%) — encaminhe ao classificador de segurança`
      : '';
  return { leak, via, canaryHits, exactSpans, containment, suspect, detail };
}

/**
 * Redige do TEXTO os spans exatos do conjunto de guarda (IMPL-069: o conjunto de
 * guarda é INVISÍVEL ao otimizador — se cenários de segurança entrassem em
 * lições/demos, o reescritor passaria a otimizar contra eles, Goodhart). Usado
 * no payload do reescritor: o que vazar de lições/demos é substituído por
 * `[trecho do conjunto de guarda redigido]` antes de ir ao LLM.
 */
export function redactGuardSpans(
  text: string,
  guardTexts: readonly string[],
): { text: string; redactions: string[] } {
  const src = asText(text);
  const toks = rawTokens(src);
  const guard = (guardTexts ?? [])
    .map((g) => rawTokens(g).map((k) => k.t))
    .filter((g) => g.length >= CONTAMINATION_SPAN_TOKENS);
  if (toks.length < CONTAMINATION_SPAN_TOKENS || guard.length === 0) {
    return { text: src, redactions: [] };
  }

  // Índice dos n-gramas do guarda (janelas de 8 tokens — o span exato inteiro
  // é coberto pelo run de janelas consecutivas).
  const keys = new Set<string>();
  for (const g of guard) {
    for (const key of ngramKeys(g, CONTAMINATION_SPAN_TOKENS)) keys.add(key);
  }

  const ranges = exactSpanRanges(toks.length, CONTAMINATION_SPAN_TOKENS, (i) =>
    keys.has(toks.slice(i, i + CONTAMINATION_SPAN_TOKENS).map((k) => k.t).join(NGRAM_SEP)),
  );
  if (ranges.length === 0) return { text: src, redactions: [] };

  const redactions = ranges.map(([a, b]) => toks.slice(a, b + 1).map((k) => k.t).join(' '));
  let out = '';
  let cursor = 0;
  for (const [a, b] of ranges) {
    out += src.slice(cursor, toks[a].start) + '[trecho do conjunto de guarda redigido]';
    cursor = toks[b].end;
  }
  out += src.slice(cursor);
  return { text: out, redactions: [...new Set(redactions)] };
}

/**
 * IMPL-070 (R-20:REC-8/M-120): fingerprint dos META-PROMPTS internos por papel
 * (reescritor, reflexão, datagen, gabarito, juízes…). Os prompts embutidos do
 * reescritor/reflexão/datagen mudavam sem rastro — duas sessões de treino com
 * meta-prompts diferentes ficavam comparáveis por acaso. Este hash estável
 * (JCS + SHA-256, idêntico nos dois runtimes) entra no hash de contrato da run
 * junto com o pin do juiz: qualquer edição de texto de meta-prompt muda o hash
 * e o snapshot do contrato acusa (cadência: mudança de texto, troca de modelo
 * default de papel, mensal).
 */
export function metaPromptsFingerprint(roleTexts: Record<string, string>): string {
  const ordenado: Record<string, string> = {};
  for (const key of Object.keys(roleTexts ?? {}).sort()) {
    const value = roleTexts[key];
    if (typeof value === 'string') ordenado[key] = value;
  }
  return sha256Hex(canonicalJson(ordenado));
}
