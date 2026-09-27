// Contratos never-break de um prompt base — gate de validação PÓS-REWRITER,
// 100% local (sem LLM). Espelha o padrão do prompt-arena (`taskBrief.contract` +
// stripFences + piso de ~30% do base): a reescrita pode mudar a FORMA à vontade,
// mas não pode destruir o CONTEÚDO que o contrato declara imutável — e uma
// reescrita colapsada é rejeitada pelo gate de tamanho antes de virar variante.
//
// Vive em `src/engine/` como fonte única, como o `duelCore`: módulo PURO (sem
// node:fs, sem fetch) para rodar no browser também, testável isolado do
// `variator` (que é quem chama o LLM).

/** Contratos never-break de um prompt base (validação pós-rewriter, sem LLM). */
export interface PromptContracts {
  /** Invariantes: cada string precisa continuar presente na reescrita (comparação normalizada). */
  neverBreak?: string[];
  /** Tokens que precisam sobreviver VERBATIM (ex.: "{os}", "{lang}", "{{count}}"). */
  placeholders?: string[];
  /** Comprimento mínimo da reescrita como fração do base. Default 0.3. */
  minLengthRatio?: number;
}

export type ContractViolationKind = 'empty' | 'length' | 'placeholder' | 'neverBreak';

export interface ContractViolation {
  kind: ContractViolationKind;
  /** Mensagem curta em PT-BR citando o que quebrou. */
  detail: string;
}

export interface VerifyRewriteResult {
  ok: boolean;
  violations: ContractViolation[];
}

/** Piso absoluto de tamanho: um prompt de sistema nunca deve ter menos que isto. */
const MIN_ABSOLUTE_LENGTH = 40;
/** Fração default do base que a reescrita precisa preservar (padrão prompt-arena: 30%). */
const DEFAULT_MIN_LENGTH_RATIO = 0.3;

/**
 * Padrões de placeholder, na ordem de alternância importa: `{{…}}` vem ANTES de
 * `{…}` para o token duplo não ser fatiado no meio (`{{count}}` é um token só,
 * não `{count}` com chaves extras). `<…>` exige token sem espaços (`<image>`
 * vale; "a < b" não é placeholder) e `$VAR` só maiúsculas/sublinhado, como no
 * exemplo do contrato.
 */
const PLACEHOLDER_RE =
  /\{\{[^{}]*\}\}|\{[^{}]*\}|<[A-Za-z0-9_][A-Za-z0-9_\-./:]*>|\$[A-Z_][A-Z0-9_]*|%s/g;

/** Normaliza para comparação tolerante: colapsa espaços/quebras de linha e minúsculas. */
function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Entrada pode vir de fora (JS puro): nunca deixe um `null` derrubar o gate. */
function asText(value: string): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Detecta placeholders do prompt base: {…}, {{…}}, <…>, $VAR, %s — usados como
 * contrato implícito quando o chamador não informa `placeholders`.
 * Devolve tokens únicos na ordem de primeira aparição (repetição não gera
 * violação duplicada no gate).
 */
export function extractPlaceholders(text: string): string[] {
  const src = asText(text);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of src.matchAll(PLACEHOLDER_RE)) {
    const token = match[0];
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/**
 * Valida uma reescrita contra o base + contratos.
 * Regras:
 *  - reescrita vazia/whitespace → violation 'empty';
 *  - comprimento: `rewritten.length >= max(40, base.length * (minLengthRatio ?? 0.3))`
 *    (quando base tem conteúdo; sem base, o piso é só 40 chars) — violation 'length';
 *  - placeholders: quando `contracts.placeholders` vier, usa a lista; senão usa
 *    `extractPlaceholders(base)`. Cada token precisa aparecer VERBATIM (substring
 *    exato) na reescrita — violation 'placeholder' por token ausente;
 *  - neverBreak: cada invariant precisa aparecer na reescrita após normalização de
 *    espaços + minúsculas (tolera quebra de linha/reformulação de espaços, NÃO
 *    tolera remoção) — violation 'neverBreak' por invariante ausente.
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
  const placeholders =
    contracts?.placeholders !== undefined ? contracts.placeholders : extractPlaceholders(baseText);
  for (const token of placeholders) {
    if (typeof token !== 'string' || token.length === 0) continue;
    if (!out.includes(token)) {
      violations.push({
        kind: 'placeholder',
        detail: `Placeholder "${token}" sumiu da reescrita (precisa sobreviver verbatim).`,
      });
    }
  }

  // neverBreak: comparação normalizada nos dois lados — quebra de linha ou
  // caixa mudam a forma, não o conteúdo; remover a regra reprova.
  const normalizedOut = normalizeForCompare(out);
  for (const invariant of contracts?.neverBreak ?? []) {
    if (typeof invariant !== 'string' || invariant.trim().length === 0) continue;
    if (!normalizedOut.includes(normalizeForCompare(invariant))) {
      violations.push({
        kind: 'neverBreak',
        detail: `Invariante ausente na reescrita: "${invariant}".`,
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
