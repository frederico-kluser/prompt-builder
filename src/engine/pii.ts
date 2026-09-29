// ===========================================================================
// Cascata de dado pessoal PT-BR — detecção, pseudonimização e bloqueio
// (IMPL-042 · R-16:REC-5 / DEC-5).
//
// PURO: sem `node:*`, sem `process.env`, sem estado de módulo. Roda igual no
// Node (gateway, CLI, servidor) e no navegador (SPA) — o gateway único
// (`src/openrouter.ts`) chama `PiiGuard.protect` em TODA requisição de chat,
// dos 6 papéis (datagen, gabarito, competidor, juiz, duelo, reescritor).
//
// Camadas (ordem = confiança):
//   1. ESTRUTURADO — regex + dígito verificador mod-11 onde existe (CPF, CNPJ
//      numérico e alfanumérico, CNS); formato + faixa/DDD/contexto onde não
//      existe (RG, CEP, telefone, e-mail, CRM). Recall/precisão MEDIDOS na
//      fixture `test/fixtures/pii-ptbr.json` (piso: recall ≥0,95, precisão ≥0,90).
//   2. CONTEXTUAL — heurística local para nomes (dicionário + gatilhos como
//      "paciente", "Sr.", "meu nome é") e endereços (logradouro + número).
//      Marcada `nao-coberto`: SEM promessa de recall (a literatura mede ~49%
//      para nomes em texto livre com detectores dedicados; R-16 Q7b). Para
//      nomes o default seguro é o modo "só sintético", não a redação.
//   3. APARÊNCIA DE DADO REAL — `assessPii`: identificador forte realista, ou
//      nome junto de outro dado pessoal no mesmo campo ("ficha"), ⇒ BLOQUEIO
//      com aviso nomeando o campo. Nunca correção silenciosa: quem decide é
//      a revisão humana.
//
// O que o gateway faz com isso: pseudonimiza os identificadores ESTRUTURADOS
// realistas com um token estável por run/sessão (`[CPF_1a2b3c4d5e6f]` — mesmo
// valor ⇒ mesmo token, em qualquer formatação; HMAC-SHA-256 com chave secreta
// por escopo, não reversível nem previsível a partir de pares conhecidos pelo
// PROVEDOR), e só CONTA os achados contextuais: reescrever prompt com base numa
// heurística de nome mudaria o benchmark em silêncio (persona "Maria Clara"
// virando token). A volta (R-16 DEC-5) fica AQUI, fora do caminho de envio: o
// cofre guarda token→valor só em memória e o gateway reidrata a resposta antes
// de devolvê-la aos papéis — o que o usuário recebe (prompt campeão, cenário,
// gabarito, resposta) traz o valor original, nunca o token.
//
// ⚠️ Desvio registrado da ação do item: a camada 2 é heurística de dicionário +
// gatilhos, NÃO um NER/LLM local — e por isso nomes nunca são redigidos, só
// contados e (com identificador forte ou ≥2 dados fracos) bloqueados na
// importação/pré-voo. Um NER local pode entrar atrás de `detectContextual` sem
// mudar o contrato (`PiiFinding` com `coverage: 'nao-coberto'`).
// ===========================================================================

export type PiiKind =
  | 'cpf'
  | 'cnpj'
  | 'cns'
  | 'rg'
  | 'cep'
  | 'telefone'
  | 'email'
  | 'crm'
  | 'nome'
  | 'endereco';

export type PiiLayer = 'estruturado' | 'contextual';

/** `nao-coberto` = o detector existe, mas sem piso de recall (nomes/endereços). */
export type PiiCoverage = 'coberto' | 'nao-coberto';

/** De onde vem a confiança no achado. */
export type PiiEvidence = 'checksum' | 'formato' | 'contexto' | 'heuristica';

export const STRUCTURED_PII_KINDS: readonly PiiKind[] = [
  'cpf',
  'cnpj',
  'cns',
  'rg',
  'cep',
  'telefone',
  'email',
  'crm',
];

export const PII_COVERAGE: Record<PiiKind, PiiCoverage> = {
  cpf: 'coberto',
  cnpj: 'coberto',
  cns: 'coberto',
  rg: 'coberto',
  cep: 'coberto',
  telefone: 'coberto',
  email: 'coberto',
  crm: 'coberto',
  nome: 'nao-coberto',
  endereco: 'nao-coberto',
};

export const PII_KIND_LABEL: Record<PiiKind, string> = {
  cpf: 'CPF',
  cnpj: 'CNPJ',
  cns: 'CNS',
  rg: 'RG',
  cep: 'CEP',
  telefone: 'telefone',
  email: 'e-mail',
  crm: 'CRM',
  nome: 'nome',
  endereco: 'endereço',
};

export interface PiiFinding {
  kind: PiiKind;
  layer: PiiLayer;
  /** Posição no texto original: `text.slice(start, end)`. */
  start: number;
  end: number;
  text: string;
  evidence: PiiEvidence;
  /**
   * Aparência de dado REAL: dígito verificador válido (ou formato plausível) e
   * NÃO é exemplo conhecido, placeholder (99999-9999, 12345-678…) nem número de
   * serviço (0800/4004). Só achado realista é redigido no envio.
   */
  realistic: boolean;
  coverage: PiiCoverage;
  /**
   * telefone: 'celular' | 'fixo'; e-mail: 'pessoal' | 'funcional'; nome: 'persona' (papel do modelo);
   * rg: 'sem-contexto' (formato de RG sem rótulo de identidade — não é identificador forte).
   */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Dígitos verificadores
// ---------------------------------------------------------------------------

const onlyDigits = (s: string): string => s.replace(/\D/g, '');

/** CPF: 11 dígitos, dois DV mod-11 (pesos 10..2 e 11..2); repetidos são inválidos. */
export function isValidCpf(value: string): boolean {
  const d = onlyDigits(value);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (len: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

const CNPJ_W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * CNPJ numérico E alfanumérico (Receita, a partir de jul/2026): 12 posições
 * [0-9A-Z] + 2 DV numéricos; cada caractere vale `código ASCII − 48` e o DV é
 * o mod-11 de sempre — o numérico é o caso particular só com dígitos.
 */
export function isValidCnpj(value: string): boolean {
  const s = value.toUpperCase().replace(/[.\/\-\s]/g, '');
  if (!/^[A-Z0-9]{12}\d{2}$/.test(s) || /^(.)\1{13}$/.test(s)) return false;
  const dv = (w: number[]): number => {
    let sum = 0;
    for (let i = 0; i < w.length; i++) sum += (s.charCodeAt(i) - 48) * w[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(CNPJ_W1) === Number(s[12]) && dv(CNPJ_W2) === Number(s[13]);
}

/**
 * CNS (Cartão Nacional de Saúde): 15 dígitos, Σ dígito×(15−i) ≡ 0 (mod 11).
 * Definitivo (1/2) nasce do PIS e tem "000"/"001" nas posições 12–14;
 * provisório começa com 7, 8 ou 9.
 */
export function isValidCns(value: string): boolean {
  const d = onlyDigits(value);
  if (d.length !== 15 || !/^[12789]/.test(d)) return false;
  if ((d[0] === '1' || d[0] === '2') && !/^\d{11}00[01]\d$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) sum += Number(d[i]) * (15 - i);
  return sum % 11 === 0;
}

/** DDDs em uso no Brasil (Anatel). DDD fora da lista ⇒ não é telefone. */
const DDDS = new Set(
  (
    '11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 ' +
    '51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 ' +
    '91 92 93 94 95 96 97 98 99'
  ).split(' '),
);

export function isValidDdd(ddd: string): boolean {
  return DDDS.has(ddd);
}

// Exemplos que circulam em documentação/validadores: dígito verificador válido,
// mas ninguém real por trás no uso do produto. Não bloqueiam nem são redigidos.
const KNOWN_EXAMPLES = new Set(['12345678909', '11144477735', '11222333000181']);

// ---------------------------------------------------------------------------
// Camada 1 — estruturados
// ---------------------------------------------------------------------------

type Candidate = PiiFinding & { rank: number };

const EVIDENCE_RANK: Record<PiiEvidence, number> = { checksum: 4, formato: 3, contexto: 2, heuristica: 1 };

/** O trecho ANTES de `index` (janela curta) contém a palavra-gatilho? */
function contextBefore(text: string, index: number, re: RegExp, window = 32): boolean {
  return re.test(text.slice(Math.max(0, index - window), index));
}

// Fronteiras: não pode estar colado em letra/dígito, nem continuar como parte
// de um número maior (1.234.567-89.0, 12345-678/9 etc.). EXCEÇÃO: `.`, `-` ou
// `/` logo depois de uma palavra-gatilho inteira ("CPF-529.982.247-25",
// "cpf/52998224725", "CNS.898…") é separador, não parte de número — sem ela o
// documento seguia cru justamente quando o rótulo está colado nele.
const TRIGGER = String.raw`(?:[Cc][Pp][Ff]|[Cc][Nn][Pp][Jj]|[Cc][Nn][Ss]|[Rr][Gg]|[Cc][Ee][Pp])`;
const L = String.raw`(?:(?<![\p{L}\p{N}.\-\/])|(?<=(?<![\p{L}\p{N}])${TRIGGER}[.\-\/]))`;
const R = String.raw`(?![\p{L}\p{N}]|[.\-\/]\p{N})`;

const CTX_CNPJ = /\bcnpj\b/iu;
const CTX_CNS = /\b(cns|sus|cart[ãa]o\s+(nacional\s+de\s+sa[úu]de|do\s+sus|sus))\b/iu;
// "pix"/"chave": celular corrido como chave PIX ("Chave pix: 21988473312") é
// padrão BR comum — sem o gatilho ele seguia cru para o LLM.
const CTX_TEL = /(tel\b|telefone|fone|celular|cel\b|whats|zap\b|ligue|ligar|liga\b|contato|ramal|fixo|pix\b|chave\b)/iu;
// RG formatado só é identificador FORTE com rótulo de identidade por perto.
const CTX_RG = /(\br\.?g(?![a-z])|identidade|c[ée]dula|registro\s+geral|\bssp\b|\bdocumento\b)/iu;
const CTX_RG_AFTER = /^\s*[(\-–—,]?\s*(ssp|sesp|detran|ifp|pc)\b/iu;
// Rótulo de OUTRA coisa logo antes ("Versão 1.234.567-8", "Lote 12.345.678-9",
// "R$ 1.234.567-8"): nem é RG — não conta nem é redigido.
const NOT_RG_BEFORE =
  /(r\$|us\$|€|\bvers[ãa]o|\bv\.?|\blote|\bbuild|\brelease|\bpedido|\bprotocolo|\bnf-?e?|\bnota(?:\s+fiscal)?|\bc[óo]digo|\bsku|\bref\.?|\bserial|\bs[ée]rie)\s*(?:n[º°o]\.?|:|#)?\s*$/iu;

function isDummySubscriber(sub: string): boolean {
  const core = sub.length === 9 ? sub.slice(1) : sub;
  if (/^(\d)\1+$/.test(core) || /^(\d)\1+$/.test(sub)) return true;
  // Sequências de placeholder: 12345678, 23456789, 87654321, 98765432, 0000…
  const asc = '0123456789';
  const desc = '9876543210';
  return asc.includes(core) || desc.includes(core) || /^0+$/.test(core.slice(1));
}

/** Números de serviço (capitais 3003/4004…) — de empresa, não de pessoa. */
const SERVICE_PREFIX = /^(300\d|400\d|4020|4062|4090)/;

function phoneFinding(
  raw: string,
  start: number,
  ddd: string | undefined,
  subscriber: string,
  evidence: PiiEvidence,
): Candidate | null {
  if (ddd !== undefined && !isValidDdd(ddd)) return null;
  subscriber = subscriber.replace(/\s/g, '');
  const celular = subscriber.length === 9 && subscriber[0] === '9';
  if (!celular && !(subscriber.length === 8 && /^[2-5]/.test(subscriber))) return null;
  // Número de serviço (4004/3003…) é de EMPRESA: não é dado pessoal.
  if (!celular && SERVICE_PREFIX.test(subscriber)) return null;
  return {
    kind: 'telefone',
    layer: 'estruturado',
    start,
    end: start + raw.length,
    text: raw,
    evidence,
    realistic: !isDummySubscriber(subscriber),
    coverage: 'coberto',
    detail: celular ? 'celular' : 'fixo',
    rank: EVIDENCE_RANK[evidence],
  };
}

const ROLE_LOCALPART =
  /^(contato|contact|suporte|support|sac|atendimento|vendas|comercial|financeiro|faturamento|cobranca|rh|recrutamento|noreply|no-reply|naoresponda|nao-responda|nao_responda|info|informacoes|ouvidoria|faleconosco|fale-conosco|adm|admin|administracao|secretaria|agendamento|marketing|imprensa|juridico|compras|ti|dpo|privacidade|lgpd|parcerias|loja|pedidos|help|ajuda)([._-].*)?$/i;
const EXAMPLE_DOMAIN =
  /(^|\.)(example\.(com|org|net)|exemplo\.(com|com\.br|org)|teste\.(com|com\.br)|test\.com|email\.com|dominio\.(com|com\.br)|seudominio\.(com|com\.br)|empresa\.(com|com\.br)|sample\.com)$/i;

const FILE_TLD = /\.(pdf|png|jpe?g|gif|webp|docx?|xlsx?|pptx?|txt|csv|zip|json|html?|js|ts|md|xml)$/i;

interface StructuredRule {
  re: RegExp;
  build: (m: RegExpExecArray, text: string) => Candidate | null;
}

function cand(
  kind: PiiKind,
  m: RegExpExecArray,
  group: number,
  evidence: PiiEvidence,
  realistic: boolean,
  detail?: string,
): Candidate {
  const raw = m[group];
  const start = m.index + m[0].indexOf(raw);
  return {
    kind,
    layer: 'estruturado',
    start,
    end: start + raw.length,
    text: raw,
    evidence,
    realistic,
    coverage: PII_COVERAGE[kind],
    detail,
    rank: EVIDENCE_RANK[evidence],
  };
}

const STRUCTURED_RULES: StructuredRule[] = [
  // CPF — formatado (000.000.000-00, 000000000-00) ou corrido (11 dígitos).
  {
    re: new RegExp(`${L}(\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}|\\d{3} \\d{3} \\d{3}[ -]\\d{2}|\\d{9}-\\d{2}|\\d{11})${R}`, 'gu'),
    build: (m) => {
      if (!isValidCpf(m[1])) return null;
      return cand('cpf', m, 1, 'checksum', !KNOWN_EXAMPLES.has(onlyDigits(m[1])));
    },
  },
  // CNPJ numérico — formatado ou corrido (14 dígitos).
  {
    re: new RegExp(`${L}(\\d{2}\\.\\d{3}\\.\\d{3}\\/\\d{4}-\\d{2}|\\d{14})${R}`, 'gu'),
    build: (m) => {
      if (!isValidCnpj(m[1])) return null;
      return cand('cnpj', m, 1, 'checksum', !KNOWN_EXAMPLES.has(onlyDigits(m[1])));
    },
  },
  // CNPJ alfanumérico — formatado aceita pelo DV; corrido só com "CNPJ" antes
  // (tokens de 14 caracteres alfanuméricos são comuns em códigos/hashes).
  {
    re: new RegExp(
      `${L}([A-Z0-9]{2}\\.[A-Z0-9]{3}\\.[A-Z0-9]{3}\\/[A-Z0-9]{4}-\\d{2}|[A-Z0-9]{12}\\d{2})${R}`,
      'gu',
    ),
    build: (m, text) => {
      const raw = m[1];
      if (!/[A-Z]/.test(raw) || !isValidCnpj(raw)) return null;
      const formatado = raw.includes('/');
      if (!formatado && !contextBefore(text, m.index, CTX_CNPJ)) return null;
      return cand('cnpj', m, 1, 'checksum', true);
    },
  },
  // CNS — "000 0000 0000 0000" ou corrido; provisório (7/8/9) corrido exige contexto.
  {
    re: new RegExp(`${L}(\\d{3}[ .]\\d{4}[ .]\\d{4}[ .]\\d{4}|\\d{15})${R}`, 'gu'),
    build: (m, text) => {
      const raw = m[1];
      if (!isValidCns(raw)) return null;
      const corrido = /^\d{15}$/.test(raw);
      if (corrido && /^[789]/.test(raw) && !contextBefore(text, m.index, CTX_CNS, 40)) return null;
      return cand('cns', m, 1, 'checksum', true);
    },
  },
  // RG formatado (00.000.000-0 / 0.000.000-X): o formato com DV é específico,
  // mas SEM rótulo de identidade é ambíguo (versão, lote, valor): aí é
  // `sem-contexto` — ainda redigido no envio (reversível), porém NÃO é
  // identificador forte (aviso, não bloqueio). Rótulo de outra coisa antes
  // ("Versão", "Lote", "R$") ⇒ não é RG.
  {
    re: new RegExp(`${L}(\\d{1,2}\\.\\d{3}\\.\\d{3}-[\\dXx])${R}`, 'gu'),
    build: (m, text) => {
      const start = m.index + m[0].indexOf(m[1]);
      const antes = text.slice(Math.max(0, start - 40), start);
      if (NOT_RG_BEFORE.test(antes)) return null;
      const rotulado = CTX_RG.test(antes) || CTX_RG_AFTER.test(text.slice(start + m[1].length, start + m[1].length + 16));
      return cand('rg', m, 1, 'formato', !/^(\d)\1*$/.test(onlyDigits(m[1])), rotulado ? undefined : 'sem-contexto');
    },
  },
  // RG por contexto (sem DV nacional): "RG 1234567", "identidade: MG-12.345.678".
  {
    re: /\b(?:[Rr][Gg]|R\.G\.|[Ii]dentidade|[Cc][ée]dula de identidade|[Cc]arteira de identidade)\s*(?:n[º°o]\.?|:|-)?\s*((?:[A-Z]{2}[-\s]?)?\d{1,2}\.?\d{3}\.?\d{3}(?:-?[\dXx])?)(?![\p{L}\p{N}])/gu,
    build: (m) => cand('rg', m, 1, 'contexto', !/^(\d)\1*$/.test(onlyDigits(m[1]))),
  },
  // CEP formatado (00000-000 / 00.000-000), faixa 01000-000..99999-999.
  {
    re: new RegExp(`${L}(\\d{2}\\.?\\d{3}-\\d{3})${R}`, 'gu'),
    build: (m) => {
      const d = onlyDigits(m[1]);
      if (Number(d.slice(0, 5)) < 1000) return null;
      return cand('cep', m, 1, 'formato', !/^(\d)\1{7}$/.test(d) && d !== '12345678');
    },
  },
  // CEP corrido/espaçado só com "CEP" antes.
  {
    re: /\bCEP\s*(?:n[º°o]\.?|:|-)?\s*(\d{8}|\d{5}\s\d{3})(?![\p{L}\p{N}])/giu,
    build: (m) => {
      const d = onlyDigits(m[1]);
      if (Number(d.slice(0, 5)) < 1000) return null;
      return cand('cep', m, 1, 'contexto', !/^(\d)\1{7}$/.test(d) && d !== '12345678');
    },
  },
  // Telefone com +55.
  {
    re: /(?<![\p{N}+])(\+\s?55[\s.-]?\(?(\d{2})\)?[\s.-]?(9\s?\d{4}|[2-5]\d{3})[\s.-]?(\d{4}))(?![\p{N}])/gu,
    build: (m) => phoneFinding(m[1], m.index + m[0].indexOf(m[1]), m[2], m[3] + m[4], 'formato'),
  },
  // Telefone com DDD entre parênteses: (11) 91234-5678, (011) 3456-7890.
  {
    re: /(?<![\p{N}])(\(\s?0?(\d{2})\s?\)[\s.-]?(9\s?\d{4}|[2-5]\d{3})[\s.-]?(\d{4}))(?![\p{N}])/gu,
    build: (m) => phoneFinding(m[1], m.index + m[0].indexOf(m[1]), m[2], m[3] + m[4], 'formato'),
  },
  // Telefone com DDD separado: 11 91234-5678, 11-3456-7890, 11 3456 7890.
  {
    re: /(?<![\p{N}\/.,\-])((\d{2})[\s.-](9\s?\d{4}|[2-5]\d{3})[\s.-]?(\d{4}))(?![\p{N}]|[.,]\p{N})/gu,
    build: (m) => phoneFinding(m[1], m.index + m[0].indexOf(m[1]), m[2], m[3] + m[4], 'formato'),
  },
  // Celular sem DDD, com hífen: 91234-5678.
  {
    re: /(?<![\p{N}\-\/.])((9\d{4})-(\d{4}))(?![\p{N}]|[.\-\/]\p{N})/gu,
    build: (m) => phoneFinding(m[1], m.index + m[0].indexOf(m[1]), undefined, m[2] + m[3], 'formato'),
  },
  // Fixo sem DDD: só com palavra de telefone antes (senão "2019-2023" vira telefone).
  {
    re: /(?<![\p{N}\-\/.])(([2-5]\d{3})-(\d{4}))(?![\p{N}]|[.\-\/]\p{N})/gu,
    build: (m, text) =>
      contextBefore(text, m.index, CTX_TEL, 28)
        ? phoneFinding(m[1], m.index, undefined, m[2] + m[3], 'contexto')
        : null,
  },
  // Corrido (10–11 dígitos): só com +55/55 ou palavra de telefone antes.
  {
    re: /(?<![\p{N}])((?:\+?55)?(\d{2})(9\d{8}|[2-5]\d{7}))(?![\p{N}])/gu,
    build: (m, text) => {
      const comPais = /^\+?55/.test(m[1]) && m[1].length > 11;
      if (!comPais && !contextBefore(text, m.index, CTX_TEL, 28)) return null;
      return phoneFinding(m[1], m.index, m[2], m[3], comPais ? 'formato' : 'contexto');
    },
  },
  // E-mail.
  {
    re: /(?<![\p{L}\p{N}._%+\-])([A-Za-z0-9](?:[A-Za-z0-9._%+\-]*[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,})(?![\p{L}\p{N}\-]|\.[\p{L}\p{N}])/gu,
    build: (m) => {
      const [local, domain] = m[1].split('@');
      // "relatorio@2024.pdf" é nome de arquivo, não e-mail.
      if (FILE_TLD.test(domain) || !/[A-Za-z]/.test(domain.split('.')[0])) return null;
      const exemplo = EXAMPLE_DOMAIN.test(domain);
      const funcional = ROLE_LOCALPART.test(local);
      return cand('email', m, 1, 'formato', !exemplo, funcional ? 'funcional' : 'pessoal');
    },
  },
  // CRM: "CRM/SP 123456", "CRM-RJ 52.123.456", "CRM 12345/MG", "CRM: 123456".
  {
    re: /\bCRM\s*[-\/]?\s*(?:[A-Z]{2})?\s*(?:n[º°o]\.?|:|-)?\s*(\d{1,3}(?:\.\d{3})+|\d{4,7})(?:\s*[-\/]\s*[A-Z]{2}\b)?/gu,
    build: (m) => cand('crm', m, 1, 'contexto', true),
  },
];

function detectStructured(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const rule of STRUCTURED_RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      const r = rule.build(m, text);
      if (r) out.push(r);
      if (m[0].length === 0) rule.re.lastIndex += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Camada 2 — contextual (heurística local; `nao-coberto`)
// ---------------------------------------------------------------------------

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// Prenomes e sobrenomes frequentes no Brasil (IBGE Censo 2010/2022, recorte
// curto). É heurística: um dicionário maior sobe recall E falso positivo —
// por isso a camada é "não coberta", sem promessa de recall.
const FIRST_NAMES = new Set(
  (
    'ana maria joao jose antonio francisco carlos paulo pedro lucas luiz luis marcos gabriel rafael daniel ' +
    'marcelo bruno eduardo felipe raimundo rodrigo manoel manuel mateus matheus andre fernando fabio leonardo ' +
    'gustavo guilherme leandro tiago thiago anderson ricardo marcio jorge sebastiao alexandre roberto edson ' +
    'diego vitor victor sergio claudio cesar julio joaquim vinicius henrique miguel arthur artur heitor ' +
    'bernardo davi david theo enzo lorenzo samuel benjamin nicolas murilo caio igor renato renan otavio ' +
    'wagner wellington adriano alan alessandro alberto augusto benedito cicero elias emerson everton ' +
    'fabricio flavio geraldo gilberto hugo ivan jair jefferson jonas juliano kleber lauro luciano mario ' +
    'mauricio mauro nelson osvaldo raul reinaldo ronaldo rogerio rubens silvio valter walter william ' +
    'juliana fernanda patricia aline adriana sandra camila amanda bruna jessica leticia julia luciana ' +
    'vanessa mariana gabriela vera vitoria larissa claudia beatriz luana rita sonia renata eliane josefa ' +
    'simone natalia francisca carla paula lucia raquel tatiana priscila daniela cristina helena alice ' +
    'laura manuela valentina sophia sofia isabela isabella heloisa luiza luisa lorena livia giovanna ' +
    'giovana cecilia lara clara marina yasmin isadora rafaela carolina bianca debora elaine fabiana ' +
    'flavia gisele ingrid jaqueline joana karina lais lilian marcia marta michele monica nathalia ' +
    'pamela regina roberta rosana sabrina silvia tereza teresa viviane denise cintia sueli solange ' +
    'marlene aparecida conceicao fatima joice thais cristiane andreia andrea alessandra samara sara ' +
    'agatha esther olivia pietra rebeca emanuele emanuelly otilia ester'
  ).split(/\s+/),
);

const SURNAMES = new Set(
  (
    'silva santos oliveira souza sousa rodrigues ferreira alves pereira lima gomes costa ribeiro martins ' +
    'carvalho almeida lopes soares fernandes vieira barbosa rocha dias nascimento andrade moreira nunes ' +
    'marques machado mendes freitas cardoso ramos goncalves santana teixeira araujo azevedo batista borges ' +
    'campos castro correia cunha duarte farias fonseca guimaraes jesus leite melo mello miranda monteiro ' +
    'moraes morais moura neves pinheiro pinto prado queiroz reis sales sampaio siqueira tavares ' +
    'vasconcelos xavier cavalcanti cavalcante bezerra brito cruz lacerda macedo medeiros nogueira paiva ' +
    'peixoto rezende resende torres viana coelho franco matos mattos aguiar amaral antunes assis barros ' +
    'bastos bueno camargo cordeiro esteves figueiredo galvao garcia godoy lemos lourenco magalhaes maia ' +
    'mota motta pacheco pimentel rangel simoes toledo valente veloso junior neto filho sobrinho'
  ).split(/\s+/),
);

// Palavras capitalizadas que encerram a sequência de nome mesmo depois de um
// prenome ("Vitória da Conquista", "Ana Paula Verão 2026"): só as frequentes.
const NOT_NAME = new Set(
  (
    'sao santa santo rua avenida av hospital clinica banco brasil janeiro fevereiro marco abril maio ' +
    'junho julho agosto setembro outubro novembro dezembro segunda terca quarta quinta sexta sabado ' +
    'domingo unidade loja centro norte sul leste oeste conquista shopping plano premium gold verao ' +
    'inverno outono primavera colecao linha edicao'
  ).split(/\s+/),
);

const NAME_WORD = String.raw`\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)?`;
const PARTICLE = String.raw`(?:d[aeo]s?|e)`;
const NAME_SEQ = String.raw`${NAME_WORD}(?:\s+(?:${PARTICLE}\s+)?${NAME_WORD}){0,4}`;

const TITLE_CUE = new RegExp(
  String.raw`(?<![\p{L}])(?:Sr|Sra|Srta|Dr|Dra|Prof|Profa)\.?\s+(${NAME_SEQ})`,
  'gu',
);
const WORD_CUE = new RegExp(
  String.raw`(?<![\p{L}])(?:[Pp]aciente|[Cc]liente|[Tt]itular|[Bb]enefici[aá]ri[oa]|[Rr]espons[aá]vel|[Mm]e chamo|[Mm]eu nome [ée]|[Nn]ome(?:\s+completo)?\s*:|[Cc]hamad[oa]|[Ss]enhora?|[Dd]ona|[Mm][ãa]e|[Pp]ai|[Ff]ilh[oa])\s+(${NAME_SEQ})`,
  'gu',
);
const NAME_RUN = new RegExp(String.raw`(?<![\p{L}])(${NAME_WORD})((?:\s+(?:${PARTICLE}\s+)?${NAME_WORD}){1,4})`, 'gu');

const STREET = new RegExp(
  String.raw`(?<![\p{L}])((?:Rua|R\.|Avenida|Av\.?|Alameda|Al\.|Travessa|Tv\.|Pra[çc]a|P[çc]a\.|Rodovia|Rod\.|Estrada|Estr\.|Largo|Viela)\s+(?:(?:\p{Lu}[\p{L}'.]*|\d{1,2}|d[aeo]s?|de)\s+){0,6}(?:\p{Lu}[\p{L}'.]*|\d{1,2})(?:\s*,\s*|\s+)(?:n[º°o]\.?\s*)?\d{1,5})(?![\p{N}])`,
  'gu',
);

function words(seq: string): string[] {
  return seq.split(/\s+/).filter((w) => !/^(d[aeo]s?|e)$/.test(w));
}

// Nome de PERSONA do prompt ("Você é a Ana Paula, atendente…", "Atenda como a
// atendente virtual Bia", "Você é o Dr. Carlos Mendes") é papel do modelo, não
// titular de dado: conta como nome (aviso), mas não forma "ficha" com o
// endereço/telefone comercial da persona. Gatilho olhado só ANTES do nome.
const PERSONA_CUE =
  /(?:voc[eê]\s+(?:[eé]|ser[aá]|vai\s+ser|atua\s+como|interpreta)|seu\s+nome\s+(?:[eé]|ser[aá])|atenda\s+como|aja\s+como|responda\s+como|assistente(?:\s+virtual)?|atendente(?:\s+virtual)?|persona(?:gem)?|chatbot|rob[oô])(?:\s+(?:o|a|um|uma|chamad[oa]|de\s+nome))?\s*(?:(?:Sr|Sra|Srta|Dr|Dra|Prof|Profa)\.?\s*)?[,:\-–—]?\s*$/iu;

function isPersonaName(text: string, start: number): boolean {
  return PERSONA_CUE.test(text.slice(Math.max(0, start - 48), start));
}

function contextualCand(
  kind: PiiKind,
  raw: string,
  start: number,
  evidence: PiiEvidence,
  detail?: string,
): Candidate {
  return {
    kind,
    layer: 'contextual',
    start,
    end: start + raw.length,
    text: raw,
    evidence,
    realistic: true,
    coverage: PII_COVERAGE[kind],
    ...(detail ? { detail } : {}),
    rank: EVIDENCE_RANK[evidence],
  };
}

function nameCand(text: string, raw: string, start: number, evidence: PiiEvidence): Candidate {
  return contextualCand('nome', raw, start, evidence, isPersonaName(text, start) ? 'persona' : undefined);
}

/** Corta a sequência no primeiro termo que não é nome (NOT_NAME). */
function trimNameSeq(seq: string): string {
  const parts = seq.split(/(\s+)/);
  let out = '';
  for (let i = 0; i < parts.length; i += 2) {
    const w = parts[i];
    if (NOT_NAME.has(fold(w))) break;
    out += (i > 0 ? parts[i - 1] : '') + w;
  }
  return out.replace(/\s+(d[aeo]s?|e)$/u, '');
}

function detectContextual(text: string): Candidate[] {
  const out: Candidate[] = [];
  let m: RegExpExecArray | null;

  TITLE_CUE.lastIndex = 0;
  while ((m = TITLE_CUE.exec(text)) !== null) {
    const seq = trimNameSeq(m[1]);
    if (!seq) continue;
    out.push(nameCand(text, seq, m.index + m[0].indexOf(m[1]), 'contexto'));
  }

  WORD_CUE.lastIndex = 0;
  while ((m = WORD_CUE.exec(text)) !== null) {
    const seq = trimNameSeq(m[1]);
    const ws = words(seq).map(fold);
    // "Cliente Premium" não; "paciente Maria", "cliente Souza" sim.
    if (!seq || !ws.some((w) => FIRST_NAMES.has(w) || SURNAMES.has(w))) continue;
    out.push(nameCand(text, seq, m.index + m[0].indexOf(m[1]), 'contexto'));
  }

  NAME_RUN.lastIndex = 0;
  while ((m = NAME_RUN.exec(text)) !== null) {
    const first = fold(m[1]);
    if (!FIRST_NAMES.has(first)) {
      // Deixa o regex tentar a partir da próxima palavra ("Olá Maria Souza").
      NAME_RUN.lastIndex = m.index + m[1].length;
      continue;
    }
    const seq = trimNameSeq(m[1] + m[2]);
    const ws = words(seq);
    if (ws.length < 2) continue;
    const second = fold(ws[1]);
    if (NOT_NAME.has(second)) continue;
    out.push(nameCand(text, seq, m.index, 'heuristica'));
  }

  STREET.lastIndex = 0;
  while ((m = STREET.exec(text)) !== null) {
    out.push(contextualCand('endereco', m[1], m.index + m[0].indexOf(m[1]), 'heuristica'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cascata
// ---------------------------------------------------------------------------

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Escolhe achados sem sobreposição: maior evidência primeiro, depois o mais longo. */
function resolve(cands: Candidate[]): PiiFinding[] {
  const sorted = cands
    .slice()
    .sort((a, b) => b.rank - a.rank || b.end - b.start - (a.end - a.start) || a.start - b.start);
  const picked: Candidate[] = [];
  for (const c of sorted) if (!picked.some((p) => overlaps(p, c))) picked.push(c);
  return picked
    .sort((a, b) => a.start - b.start)
    .map(({ rank: _rank, ...f }) => f);
}

export interface PiiScan {
  findings: PiiFinding[];
  structured: PiiFinding[];
  contextual: PiiFinding[];
}

/**
 * A cascata inteira sobre UM texto: estruturados (regex + DV) primeiro; a
 * camada contextual só fica com o que não colide com um estruturado.
 */
export function scanPii(text: string): PiiScan {
  if (!text) return { findings: [], structured: [], contextual: [] };
  const structured = resolve(detectStructured(text));
  const contextual = resolve(detectContextual(text)).filter(
    (c) => !structured.some((s) => overlaps(s, c)),
  );
  const findings = [...structured, ...contextual].sort((a, b) => a.start - b.start);
  return { findings, structured, contextual };
}

// ---------------------------------------------------------------------------
// Camada 3 — aparência de dado real
// ---------------------------------------------------------------------------

export type PiiVerdict = 'limpo' | 'aviso' | 'bloqueio';

/** Identificador que, sozinho e realista, aponta uma PESSOA. */
function isStrong(f: PiiFinding): boolean {
  if (!f.realistic || f.layer !== 'estruturado') return false;
  if (f.kind === 'cpf' || f.kind === 'cns' || f.kind === 'crm') return true;
  // "00.000.000-0" sem rótulo de identidade pode ser versão/lote: só aviso.
  if (f.kind === 'rg') return f.detail !== 'sem-contexto';
  if (f.kind === 'telefone') return f.detail === 'celular';
  if (f.kind === 'email') return f.detail === 'pessoal';
  return false;
}

export interface PiiAssessment {
  verdict: PiiVerdict;
  /** Tipos que motivaram o veredito (ordem de aparição, sem repetição). */
  kinds: PiiKind[];
  reason?: 'identificador' | 'ficha';
}

/** Dado pessoal FRACO: sozinho é típico de empresa (endereço, CEP, telefone fixo). */
function isWeakPersonal(f: PiiFinding): boolean {
  if (!f.realistic) return false;
  if (f.kind === 'endereco' || f.kind === 'cep') return true;
  return f.kind === 'telefone' && f.detail === 'fixo';
}

/**
 * Heurística de "aparência de dado real" de UM campo. BLOQUEIA quando há:
 *  - identificador forte realista (CPF, CNS, RG, CRM, celular, e-mail pessoal)
 *    — com nome junto, o motivo vira "ficha" (o nome não é redigido);
 *  - "ficha fraca": nome de TITULAR (não de persona do prompt) com ≥2 tipos
 *    fracos distintos (endereço + CEP, endereço + telefone fixo…) — o
 *    cadastro de quem "mora na Rua X, CEP Y".
 * Nome + UM dado fraco, nome de persona ("Você é a Ana Paula, atendente…,
 * Rua Augusta, 1500"), CNPJ, e-mail funcional e endereço/CEP/fixo sozinhos
 * (dado típico de EMPRESA num prompt de produto) viram só AVISO.
 */
export function assessPii(findings: PiiFinding[]): PiiAssessment {
  const reais = findings.filter((f) => f.realistic);
  const kinds = [...new Set(reais.map((f) => f.kind))];
  const titulares = reais.filter((f) => f.kind === 'nome' && f.detail !== 'persona');
  if (reais.some(isStrong)) {
    return { verdict: 'bloqueio', kinds, reason: titulares.length ? 'ficha' : 'identificador' };
  }
  const fracos = new Set(reais.filter(isWeakPersonal).map((f) => f.kind));
  if (titulares.length && fracos.size >= 2) return { verdict: 'bloqueio', kinds, reason: 'ficha' };
  return { verdict: reais.length ? 'aviso' : 'limpo', kinds };
}

// ---------------------------------------------------------------------------
// Varredura de objetos (importação e pré-voo)
// ---------------------------------------------------------------------------

export interface PiiFieldReport {
  /** Caminho legível do campo: `customStages[2].question`. */
  path: string;
  findings: PiiFinding[];
  assessment: PiiAssessment;
}

export interface ScanObjectOptions {
  /** Pula a chave (ids de modelo, enums…). Default: `isNonContentKey`. */
  skipKey?: (key: string) => boolean;
  /** Pula o nó inteiro (ex.: cenário gerado por LLM, `origin: 'ai'`). */
  skipNode?: (node: Record<string, unknown>) => boolean;
}

// Chaves que nunca carregam conteúdo digitado (ids de modelo, enums, formato).
const NON_CONTENT_KEY =
  /^(mode|format|origin|source|runner|piiMode|compliance|reasoning|reasoningLevel|techniqueIds|maxPricePerMTok|limits|agent|models|id|.*ModelIds?|.*Id|.*Ids|.*At)$/;

export function isNonContentKey(key: string): boolean {
  return NON_CONTENT_KEY.test(key);
}

function joinPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

/** Varre toda string de um objeto (JSON importado, RunConfig) e relata por campo. */
export function scanObjectPii(value: unknown, root = '', opts: ScanObjectOptions = {}): PiiFieldReport[] {
  const skipKey = opts.skipKey ?? isNonContentKey;
  const out: PiiFieldReport[] = [];
  const visit = (v: unknown, path: string, depth: number): void => {
    if (depth > 12 || v === null || v === undefined) return;
    if (typeof v === 'string') {
      const { findings } = scanPii(v);
      if (findings.length) out.push({ path: path || '(texto)', findings, assessment: assessPii(findings) });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, joinPath(path, i), depth + 1));
      return;
    }
    if (typeof v === 'object') {
      const node = v as Record<string, unknown>;
      if (opts.skipNode?.(node)) return;
      for (const [k, child] of Object.entries(node)) {
        if (skipKey(k)) continue;
        visit(child, joinPath(path, k), depth + 1);
      }
    }
  };
  visit(value, root, 0);
  return out;
}

function describeField(r: PiiFieldReport): string {
  const kinds = r.assessment.kinds.map((k) => PII_KIND_LABEL[k]);
  const extra = r.assessment.kinds.includes('nome') ? ' — nomes: não coberto' : '';
  return `${r.path} (${kinds.join(' + ')}${extra})`;
}

const MAX_FIELDS_IN_MESSAGE = 6;

function listFields(reports: PiiFieldReport[]): string {
  const shown = reports.slice(0, MAX_FIELDS_IN_MESSAGE).map(describeField).join('; ');
  const rest = reports.length - MAX_FIELDS_IN_MESSAGE;
  return rest > 0 ? `${shown}; +${rest} campo(s)` : shown;
}

export interface PiiImportCheck {
  ok: boolean;
  /** Campos com aparência de dado real (motivo do bloqueio). */
  blocked: PiiFieldReport[];
  /** Campos com achado fraco (CNPJ/CEP/fixo/endereço/nome sozinhos): só aviso. */
  warnings: PiiFieldReport[];
  /** Mensagem PT-BR que NOMEIA os campos (presente quando `ok === false`). */
  message?: string;
}

/**
 * Varredura da IMPORTAÇÃO (cenários, pacote, config JSON, biblioteca): dado
 * pessoal de aparência real ⇒ bloqueio com aviso nomeando o campo. Nunca
 * corrige em silêncio — quem revisa decide (e pode reimportar com
 * `allowPii`, caso em que os identificadores seguem pseudonimizados no envio).
 */
export function checkImportPii(value: unknown, root = '', opts: ScanObjectOptions = {}): PiiImportCheck {
  const reports = scanObjectPii(value, root, opts);
  const blocked = reports.filter((r) => r.assessment.verdict === 'bloqueio');
  const warnings = reports.filter((r) => r.assessment.verdict === 'aviso');
  if (!blocked.length) return { ok: true, blocked, warnings };
  return {
    ok: false,
    blocked,
    warnings,
    message:
      `Importação bloqueada (LGPD): dado pessoal com aparência de dado real em ${blocked.length} campo(s) — ` +
      `${listFields(blocked)}. Revise o arquivo e use dados sintéticos (documento com dígito verificador ` +
      `inválido ou mascarado, ex.: ***.***.***-**). Nada foi corrigido automaticamente. Se revisou e pode ` +
      `seguir, reimporte com \`allowPii\` (CLI: \`--allow-pii\`): os identificadores saem pseudonimizados ` +
      `no envio; nomes em texto livre não são cobertos.`,
  };
}

// ---------------------------------------------------------------------------
// Modo da run: "redigir" (default) × "só sintético" — e o modo agente
// ---------------------------------------------------------------------------

/**
 * - `redact` (default): identificadores estruturados são pseudonimizados no
 *   gateway antes de TODA chamada; nomes em texto livre NÃO são cobertos. Dado
 *   de aparência real num campo do config RECUSA a run até o usuário confirmar
 *   que revisou (`allowPii: true`) — pseudonimizar sem avisar seria correção
 *   silenciosa, e o nome junto do documento nem é redigido.
 * - `synthetic` ("só sintético"): a run é RECUSADA no pré-voo se qualquer
 *   campo fornecido pelo usuário tiver aparência de dado real — sem exceção
 *   manual (`allowPii` é ignorado). É o default recomendado pela R-16 para
 *   quem tem nomes.
 * - Modo AGENTE (`config.agent`): o executor (`pi`) recebe a tarefa e o prompt
 *   e fala com o provedor POR CONTA PRÓPRIA, fora do gateway — a cascata não o
 *   alcança. Por isso é tratado como "só sintético" (fail-closed), qualquer que
 *   seja o `piiMode`/`allowPii` declarado.
 */
export type PiiMode = 'redact' | 'synthetic';

export const PII_MODES: readonly PiiMode[] = ['redact', 'synthetic'];

export interface PiiConfigLike {
  piiMode?: PiiMode;
  /** O usuário revisou o dado de aparência real e confirmou que pode seguir (pseudonimizado). */
  allowPii?: boolean;
  /** Presente = modo agente (executor fora da cascata). */
  agent?: unknown;
}

export interface RunPiiCheck {
  mode: PiiMode;
  /** Modo agente: tratado como "só sintético" (a cascata não alcança o executor). */
  agent: boolean;
  allowPii: boolean;
  blocked: PiiFieldReport[];
  warnings: PiiFieldReport[];
}

/**
 * Varre os campos que o USUÁRIO fornece num RunConfig de topo (tema, brief,
 * prompts, cenários, contratos…). Tudo o que o config carrega conta — inclusive
 * cenário marcado `origin: 'ai'`, porque esse campo é editável no JSON
 * importado. O que o NOSSO LLM gera durante a sessão (cenários/gabaritos das
 * iterações) não passa por aqui: o pré-voo das runs aninhadas pula esta parte.
 */
export function checkRunPii(cfg: PiiConfigLike & object): RunPiiCheck {
  const mode: PiiMode = cfg.piiMode === 'synthetic' ? 'synthetic' : 'redact';
  const reports = scanObjectPii(cfg);
  return {
    mode,
    agent: cfg.agent !== undefined && cfg.agent !== null,
    allowPii: cfg.allowPii === true,
    blocked: reports.filter((r) => r.assessment.verdict === 'bloqueio'),
    warnings: reports.filter((r) => r.assessment.verdict === 'aviso'),
  };
}

/** Erro de POLÍTICA (não de rede): a run não pode começar com esse dado. */
export class PiiPolicyError extends Error {
  readonly code = 'PII_POLICY';
  readonly fields: PiiFieldReport[];
  // Sem "parameter property": mantém o arquivo compatível com strip de tipos.
  constructor(message: string, fields: PiiFieldReport[]) {
    super(message);
    this.name = 'PiiPolicyError';
    this.fields = fields;
  }
}

/** Reconhece o erro sem `instanceof` (ESM com instância dupla do módulo). */
export function isPiiPolicyError(err: unknown): err is PiiPolicyError {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'PII_POLICY');
}

/** Por que a run seria recusada (ou `null` se pode seguir). */
export type RunPiiRefusal = 'synthetic' | 'agent' | 'unreviewed';

export function runPiiRefusal(check: RunPiiCheck): RunPiiRefusal | null {
  if (!check.blocked.length) return null;
  if (check.mode === 'synthetic') return 'synthetic';
  if (check.agent) return 'agent';
  return check.allowPii ? null : 'unreviewed';
}

/** Mensagem PT-BR da recusa — sempre NOMEIA os campos. */
export function runPiiMessage(check: RunPiiCheck): string {
  const campos = `${check.blocked.length} campo(s) — ${listFields(check.blocked)}`;
  switch (runPiiRefusal(check)) {
    case 'agent':
      return (
        `Modo agente recusou a run: dado pessoal com aparência de dado real em ${campos}. ` +
        `O executor do agente fala com o provedor por conta própria, FORA da cascata de dado ` +
        `pessoal — por isso o modo agente é "só sintético", sem exceção manual. Troque por dados sintéticos.`
      );
    case 'unreviewed':
      return (
        `Dado pessoal com aparência de dado real em ${campos}. Nada foi enviado. Se você revisou e ` +
        `pode seguir, confirme com \`allowPii: true\` no config (CLI: \`--allow-pii\`; Nova Run: ` +
        `"Revisei — iniciar mesmo assim"): CPF, telefone, e-mail e demais identificadores saem ` +
        `pseudonimizados no envio (e voltam ao valor original nas respostas, só aqui), mas nomes ` +
        `em texto livre NÃO são cobertos e seguem como estão. ` +
        `Ou troque por dados sintéticos (documento com dígito verificador inválido ou mascarado).`
      );
    default:
      return (
        `Modo "só sintético" recusou a run: dado pessoal com aparência de dado real em ${campos}. ` +
        `Troque por dados sintéticos ou use o modo "redigir" (identificadores pseudonimizados no ` +
        `envio; nomes não cobertos).`
      );
  }
}

/**
 * Pré-voo (antes de qualquer LLM), MESMA regra do schema de importação:
 * lança `PiiPolicyError` nomeando os campos quando a run não pode seguir
 * ("só sintético", modo agente, ou "redigir" sem revisão). Senão devolve o
 * relatório (o orquestrador o grava no record: campos + tipos, nunca valores).
 */
export function assertRunPii(cfg: PiiConfigLike & object): RunPiiCheck {
  const check = checkRunPii(cfg);
  if (runPiiRefusal(check)) throw new PiiPolicyError(runPiiMessage(check), check.blocked);
  return check;
}

/** Resumo gravável no RunRecord: caminho + tipos + veredito — NUNCA o valor. */
export interface PiiRunReport {
  mode: PiiMode;
  /** O usuário confirmou (`allowPii`) o dado de aparência real listado em `fields`. */
  allowPii: boolean;
  fields: { path: string; kinds: PiiKind[]; verdict: 'aviso' | 'bloqueio' }[];
}

export function summarizeRunPii(check: RunPiiCheck): PiiRunReport | undefined {
  const fields = [...check.blocked, ...check.warnings].map((r) => ({
    path: r.path,
    kinds: r.assessment.kinds,
    verdict: r.assessment.verdict as 'aviso' | 'bloqueio',
  }));
  if (!fields.length) return undefined;
  return { mode: check.mode, allowPii: check.allowPii, fields };
}

/**
 * Uma linha PT-BR para o CLI/UI: o que será pseudonimizado e o que não é
 * coberto. No modo AGENTE ela diz a verdade sobre o executor: o que passou no
 * pré-voo (só "aviso" — CNPJ, fixo, CEP, e-mail funcional, nome) segue CRU
 * para o provedor do executor, que fala com ele fora do gateway.
 */
export function describeRunPii(check: RunPiiCheck): string | null {
  const todos = [...check.blocked, ...check.warnings];
  if (!todos.length) return null;
  if (check.agent) {
    return (
      `Modo agente: dado de contato/empresa em ${todos.length} campo(s) — ${listFields(todos)}. ` +
      `O executor fala com o provedor FORA da cascata: nele esses valores seguem CRUS (só dado de ` +
      `aparência real é recusado); nos demais papéis saem pseudonimizados. Se não podem sair, ` +
      `troque por dado sintético.`
    );
  }
  return (
    `Dado pessoal em ${todos.length} campo(s) — ${listFields(todos)}: identificadores saem ` +
    `pseudonimizados antes de cada envio ao modelo e voltam ao valor original nas respostas (só ` +
    `localmente); nomes/endereços em texto livre não são cobertos.`
  );
}

/**
 * O relatório GRAVADO no record (`RunRecord.piiReport`) em uma linha PT-BR —
 * é o que a tela da run mostra: dado de empresa (CNPJ, fixo, CEP, e-mail
 * funcional) só gera "aviso" e não pede revisão, então sem esta linha a
 * pseudonimização dele seria invisível na SPA. Nunca traz o valor.
 */
export function describePiiReport(
  report: PiiRunReport | undefined,
  opts: { agent?: boolean } = {},
): string | null {
  if (!report?.fields.length) return null;
  const shown = report.fields
    .slice(0, MAX_FIELDS_IN_MESSAGE)
    .map((f) => `${f.path} (${f.kinds.map((k) => PII_KIND_LABEL[k]).join(' + ')})`)
    .join('; ');
  const rest = report.fields.length - MAX_FIELDS_IN_MESSAGE;
  const campos = rest > 0 ? `${shown}; +${rest} campo(s)` : shown;
  if (opts.agent) {
    return (
      `Modo agente: dado de contato/empresa em ${report.fields.length} campo(s) — ${campos}. O ` +
      `executor fala com o provedor FORA da cascata: nele esses valores seguiram CRUS; nos demais ` +
      `papéis saíram pseudonimizados.`
    );
  }
  const revisado = report.allowPii ? ' Dado de aparência real liberado por revisão ("Revisei").' : '';
  return (
    `Dado pessoal em ${report.fields.length} campo(s) — ${campos}. Identificadores saíram ` +
    `pseudonimizados em cada envio ao modelo e voltaram ao valor original nas respostas (só ` +
    `localmente); nomes/endereços em texto livre não são cobertos.${revisado}`
  );
}

// ---------------------------------------------------------------------------
// Pseudonimização (o que o gateway aplica em toda requisição)
// ---------------------------------------------------------------------------

const TOKEN_LABEL: Record<PiiKind, string> = {
  cpf: 'CPF',
  cnpj: 'CNPJ',
  cns: 'CNS',
  rg: 'RG',
  cep: 'CEP',
  telefone: 'TELEFONE',
  email: 'EMAIL',
  crm: 'CRM',
  nome: 'NOME',
  endereco: 'ENDERECO',
};

/** Forma canônica: o mesmo documento em qualquer formatação vira o mesmo token. */
function canonical(f: Pick<PiiFinding, 'kind' | 'text'>): string {
  switch (f.kind) {
    case 'email':
      return f.text.toLowerCase();
    case 'cnpj':
    case 'rg':
      return f.text.toUpperCase().replace(/[^0-9A-Z]/g, '');
    case 'telefone': {
      const d = onlyDigits(f.text);
      return d.length > 11 && d.startsWith('55') ? d.slice(2) : d.replace(/^0(?=\d{10,11}$)/, '');
    }
    // Não viram token (camada contextual), mas entram na chave da revisão humana.
    case 'nome':
    case 'endereco':
      return fold(f.text).replace(/\s+/g, ' ').trim();
    default:
      return onlyDigits(f.text);
  }
}

// --- HMAC-SHA-256 (puro, síncrono: o gateway monta o corpo sem `await`) -----
//
// O token de um identificador é uma PRF com chave: HMAC-SHA-256(chave, tipo|valor),
// truncado. NÃO pode ser um hash não-criptográfico com sal (a 1ª versão usava
// FNV-1a): FNV é inversível passo a passo, então UM par conhecido valor→token
// (o CPF que o próprio provedor gerou no datagen volta pseudonimizado nas
// chamadas seguintes) revelava o estado pós-sal e permitia calcular o token de
// qualquer CPF — e reverter tudo por enumeração (10^9 bases). Com HMAC, conhecer
// pares não ajuda a prever outro token sem a chave (256 bits, CSPRNG).

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** SHA-256 (FIPS 180-4). Exportado só para o teste cruzar com `node:crypto`. */
export function sha256(msg: Uint8Array): Uint8Array {
  const len = msg.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  const bits = len * 8;
  dv.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(padded.length - 4, bits >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]);
  return out;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** HMAC-SHA-256 (RFC 2104). Exportado só para o teste cruzar com `node:crypto`. */
export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const k = key.length > 64 ? sha256(key) : key;
  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    const b = i < k.length ? k[i] : 0;
    inner[i] = b ^ 0x36;
    outer[i] = b ^ 0x5c;
  }
  inner.set(msg, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Chave de 256 bits do CSPRNG (Node ≥20 e navegadores têm `crypto.getRandomValues`). */
function randomKey(): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: <T extends ArrayBufferView>(a: T) => T } }).crypto;
  const buf = new Uint8Array(32);
  if (c?.getRandomValues) return c.getRandomValues(buf);
  // Sem CSPRNG (ambiente fora do `engines`): melhor que nada, e o teste de
  // pseudonimização roda com o CSPRNG de verdade.
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

/** Hex do token: 48 bits — colisão desprezível no escopo de uma run/sessão. */
export const PII_TOKEN_HEX = 12;

/**
 * Teto do mapa reversível de UM cofre. O cofre de uma run/sessão morre com
 * ela; o da instância (chamadas sem escopo) vive o processo/aba inteiro — o
 * teto impede que ele cresça sem fim (o mais antigo sai; token que perdeu o
 * par volta como token, visível, nunca como outro valor).
 */
export const PII_VAULT_MAX_ENTRIES = 5000;

/**
 * Forma de superfície curta demais para ser procurada literalmente de novo
 * (CRM de 4 dígitos viraria token em todo "2024" do texto).
 */
const MIN_SURFACE_LEN = 6;

export interface PiiRedaction {
  kind: PiiKind;
  token: string;
  start: number;
  end: number;
}

export interface RedactResult {
  text: string;
  redactions: PiiRedaction[];
  /** Achados contextuais (nomes/endereços) vistos e NÃO reescritos. */
  contextualSeen: number;
}

export interface RehydrateResult {
  text: string;
  /** Tokens deste cofre trocados de volta pelo valor original. */
  restored: number;
}

export interface PiiVaultOptions {
  /**
   * Chave do HMAC. Default: 256 bits aleatórios por cofre (e há um cofre por
   * run/sessão no gateway). Fixar a chave é só para teste.
   */
  key?: string;
}

interface VaultEntry {
  kind: PiiKind;
  /** Valor original (1ª forma vista; espaços colapsados — cabe em string JSON). */
  value: string;
  /** Formas de superfície já vistas que apontam para este token. */
  surfaces: string[];
}

const TOKEN_IN_TEXT = new RegExp(
  String.raw`(\[)?(?<![A-Za-z0-9_])(${Object.values(TOKEN_LABEL).join('|')})_([0-9a-f]{${PII_TOKEN_HEX}})(?![0-9A-Za-z_])(\])?`,
  'gi',
);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');

/**
 * Cofre de pseudônimos de UM escopo (run/sessão). Duas metades:
 *
 * - IDA (o que sai para o provedor): token ESTÁVEL no escopo — mesmo valor ⇒
 *   mesmo token em todos os papéis, em qualquer formatação. É HMAC-SHA-256 com
 *   chave secreta: um par conhecido valor→token não prevê nenhum outro.
 * - VOLTA (R-16 DEC-5: "reversão fora do caminho de envio"): o mapa
 *   token→valor original fica SÓ em memória, em campo `#privado` (nem
 *   `JSON.stringify` nem spread o alcançam), nunca persistido nem enviado. O
 *   gateway reidrata a resposta do modelo com ele ANTES de devolvê-la aos
 *   papéis: sem isso o token vazava irreversível para o prompt campeão, o
 *   cenário gerado, o gabarito — e o contrato `neverBreak` com o valor original
 *   rejeitava toda reescrita em silêncio.
 *
 * O reenvio re-tokeniza igual: além da varredura, toda forma de superfície já
 * vista no escopo é procurada literalmente — o valor que só foi achado COM
 * contexto ("telefone 3071-4455") volta ao token mesmo se o modelo o repetir
 * sem contexto. A reversão não abre caminho cru na chamada seguinte.
 */
export class PiiVault {
  private readonly key: Uint8Array;
  readonly #entries = new Map<string, VaultEntry>();
  readonly #surfaces = new Map<string, string>();
  #surfaceRe: RegExp | null = null;
  #surfaceReDirty = false;

  constructor(opts: PiiVaultOptions = {}) {
    this.key = opts.key !== undefined ? utf8(opts.key) : randomKey();
  }

  tokenFor(f: Pick<PiiFinding, 'kind' | 'text'>): string {
    const mac = hmacSha256(this.key, utf8(`${f.kind}|${canonical(f)}`));
    return `[${TOKEN_LABEL[f.kind]}_${toHex(mac).slice(0, PII_TOKEN_HEX)}]`;
  }

  /** Quantos tokens este cofre sabe reverter (diagnóstico/teste; nunca os valores). */
  get size(): number {
    return this.#entries.size;
  }

  /** Guarda o par token→original (só memória) e a forma de superfície vista. */
  #remember(kind: PiiKind, surface: string, token: string): void {
    const normal = surface.replace(/\s+/g, ' ');
    let entry = this.#entries.get(token);
    if (entry) {
      // LRU: quem voltou a aparecer vai para o fim da fila de despejo.
      this.#entries.delete(token);
    } else {
      entry = { kind, value: normal, surfaces: [] };
    }
    this.#entries.set(token, entry);
    for (const s of new Set([surface, normal])) {
      if (s.length < MIN_SURFACE_LEN || this.#surfaces.has(s)) continue;
      this.#surfaces.set(s, token);
      entry.surfaces.push(s);
      this.#surfaceReDirty = true;
    }
    while (this.#entries.size > PII_VAULT_MAX_ENTRIES) {
      const [oldest, old] = this.#entries.entries().next().value as [string, VaultEntry];
      this.#entries.delete(oldest);
      for (const s of old.surfaces) this.#surfaces.delete(s);
      this.#surfaceReDirty = true;
    }
  }

  /** Regex das formas já vistas (a mais longa primeiro), com fronteira de palavra. */
  #knownSurfaces(): RegExp | null {
    if (this.#surfaceReDirty) {
      const alts = [...this.#surfaces.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
      this.#surfaceRe = alts.length
        ? new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${alts.join('|')})(?![\p{L}\p{N}])`, 'gu')
        : null;
      this.#surfaceReDirty = false;
    }
    return this.#surfaceRe;
  }

  /** Redige os identificadores ESTRUTURADOS realistas de um texto (e o já visto no escopo). */
  redact(text: string): RedactResult {
    const { structured, contextual } = scanPii(text);
    type Hit = { kind: PiiKind; start: number; end: number; token: string };
    const hits: Hit[] = [];
    for (const f of structured) {
      if (!f.realistic) continue;
      const token = this.tokenFor(f);
      this.#remember(f.kind, f.text, token);
      hits.push({ kind: f.kind, start: f.start, end: f.end, token });
    }
    const known = this.#knownSurfaces();
    if (known) {
      known.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = known.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (hits.some((h) => h.start < end && start < h.end)) continue;
        const token = this.#surfaces.get(m[0]);
        const entry = token ? this.#entries.get(token) : undefined;
        if (!token || !entry) continue;
        hits.push({ kind: entry.kind, start, end, token });
      }
    }
    if (!hits.length) return { text, redactions: [], contextualSeen: contextual.length };
    hits.sort((a, b) => a.start - b.start);
    let out = '';
    let cursor = 0;
    for (const h of hits) {
      out += text.slice(cursor, h.start) + h.token;
      cursor = h.end;
    }
    out += text.slice(cursor);
    return { text: out, redactions: hits, contextualSeen: contextual.length };
  }

  /**
   * VOLTA: troca cada token DESTE cofre pelo valor original (a 1ª forma vista).
   * Tolera o que o modelo costuma fazer com o token (sem colchetes, caixa
   * trocada). Token desconhecido (inventado, de outro escopo, já despejado)
   * fica como está — visível, nunca trocado por outro valor.
   */
  rehydrate(text: string): RehydrateResult {
    if (!text || !this.#entries.size) return { text, restored: 0 };
    let restored = 0;
    TOKEN_IN_TEXT.lastIndex = 0;
    const out = text.replace(TOKEN_IN_TEXT, (match, _open, label: string, hex: string) => {
      const entry = this.#entries.get(`[${label.toUpperCase()}_${hex.toLowerCase()}]`);
      if (!entry) return match;
      restored += 1;
      return entry.value;
    });
    return { text: out, restored };
  }

  /**
   * Pseudonimiza toda string de um valor (string, lista, objeto plano) com os
   * MESMOS tokens do envio — utilitário para comparar localmente com o que o
   * modelo viu (diagnóstico/teste; os papéis recebem a resposta já reidratada).
   */
  redactDeep<T>(value: T): T {
    const visit = (v: unknown, depth: number): unknown => {
      if (typeof v === 'string') return this.redact(v).text;
      if (depth > 8 || v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map((x) => visit(x, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = visit(x, depth + 1);
      return out;
    };
    return visit(value, 0) as T;
  }
}

/**
 * Teto de aninhamento de `PiiGuard.protectDeep` (modo JEV). Bem acima do que um
 * estado real usa (o lint `state.too_deep` recusa antes, em 32): existe só para
 * a recursão nunca estourar a pilha — acima dele a chamada LANÇA (fail-closed).
 */
export const PII_PROTECT_MAX_DEPTH = 256;

export interface PiiGuardStats {
  /** Requisições que passaram pela cascata (== requisições de chat enviadas). */
  scannedCalls: number;
  scannedMessages: number;
  /** Requisições com ≥1 identificador pseudonimizado. */
  redactedCalls: number;
  redactionsByKind: Partial<Record<PiiKind, number>>;
  /** Nomes/endereços vistos e enviados como estão (`nao-coberto`). */
  contextualSeen: number;
  /** Tokens trocados de volta pelo valor original nas respostas (reidratação). */
  restoredTokens: number;
}

/**
 * O guarda do gateway: TODA lista de mensagens passa por `protect` antes de
 * virar corpo de requisição, e TODA resposta passa por `restore` antes de
 * voltar aos papéis. Contadores por instância (1 por processo ou aba) — é o
 * que o teste usa para provar que nenhuma chamada escapa.
 *
 * Cofre por ESCOPO: o gateway passa a raiz do ledger da chamada (a run avulsa,
 * ou a sessão de treino inteira), então cada run/sessão tem chave própria — o
 * mesmo CPF vira tokens diferentes em runs de usuários diferentes no servidor
 * (sem ligação entre elas), mas o MESMO token em todos os papéis e iterações da
 * sessão. Chamada sem escopo (utilitários avulsos) usa o cofre da instância.
 */
export class PiiGuard {
  readonly vault: PiiVault;
  private readonly opts: PiiVaultOptions;
  private readonly scoped = new WeakMap<object, PiiVault>();
  private readonly counters: PiiGuardStats = {
    scannedCalls: 0,
    scannedMessages: 0,
    redactedCalls: 0,
    redactionsByKind: {},
    contextualSeen: 0,
    restoredTokens: 0,
  };

  constructor(opts: PiiVaultOptions = {}) {
    this.opts = opts;
    this.vault = new PiiVault(opts);
  }

  /** O cofre do escopo (criado na 1ª chamada; some com o escopo — WeakMap). */
  vaultFor(scope?: object): PiiVault {
    if (!scope) return this.vault;
    let v = this.scoped.get(scope);
    if (!v) {
      // Chave fixa (só teste) ⇒ todos os escopos a usam; senão, chave nova por escopo.
      v = new PiiVault(this.opts.key !== undefined ? this.opts : {});
      this.scoped.set(scope, v);
    }
    return v;
  }

  protect<M extends { content: string }>(messages: readonly M[], scope?: object): M[] {
    this.counters.scannedCalls += 1;
    const vault = this.vaultFor(scope);
    let redigiu = false;
    const out = messages.map((msg) => {
      this.counters.scannedMessages += 1;
      if (typeof msg.content !== 'string' || !msg.content) return msg;
      const r = vault.redact(msg.content);
      this.counters.contextualSeen += r.contextualSeen;
      if (!r.redactions.length) return msg;
      redigiu = true;
      for (const x of r.redactions) {
        this.counters.redactionsByKind[x.kind] = (this.counters.redactionsByKind[x.kind] ?? 0) + 1;
      }
      return { ...msg, content: r.text };
    });
    if (redigiu) this.counters.redactedCalls += 1;
    return out;
  }

  /**
   * Modo JEV (decisões tipadas): a cascata para um valor ESTRUTURADO inteiro
   * (estado + perguntas), no mesmo papel de `protect` para mensagens de chat —
   * conta UMA requisição varrida. Diferente de `PiiVault.redactDeep` (que para
   * na profundidade 8 e não conta), aqui NENHUMA string escapa por estar
   * funda: o pré-voo varre até 12 níveis e um estado de 9+ níveis sairia cru
   * depois de liberado. Acima de `PII_PROTECT_MAX_DEPTH` níveis (ou ciclo)
   * LANÇA — fail-closed, nunca envia sem varrer. Só VALORES são redigidos:
   * chaves (ids de pergunta, opções de `choice`, campos do estado) ficam.
   */
  protectDeep<T>(value: T, scope?: object): T {
    this.counters.scannedCalls += 1;
    this.counters.scannedMessages += 1;
    const vault = this.vaultFor(scope);
    let redigiu = false;
    const emCurso = new Set<object>();
    const visit = (v: unknown, depth: number): unknown => {
      if (typeof v === 'string') {
        if (!v) return v;
        const r = vault.redact(v);
        this.counters.contextualSeen += r.contextualSeen;
        if (!r.redactions.length) return v;
        redigiu = true;
        for (const x of r.redactions) {
          this.counters.redactionsByKind[x.kind] = (this.counters.redactionsByKind[x.kind] ?? 0) + 1;
        }
        return r.text;
      }
      if (v === null || typeof v !== 'object') return v;
      if (depth > PII_PROTECT_MAX_DEPTH) {
        throw new Error(
          `valor com mais de ${PII_PROTECT_MAX_DEPTH} níveis de aninhamento: a cascata de dado pessoal não o ` +
            'envia sem varrer (fail-closed). Achate o estado.',
        );
      }
      if (emCurso.has(v)) throw new Error('valor circular não pode ir ao modelo (a cascata não o varre).');
      emCurso.add(v);
      try {
        if (Array.isArray(v)) return v.map((x) => visit(x, depth + 1));
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = visit(x, depth + 1);
        return out;
      } finally {
        emCurso.delete(v);
      }
    };
    const out = visit(value, 0) as T;
    if (redigiu) this.counters.redactedCalls += 1;
    return out;
  }

  /**
   * A volta: tokens do cofre do escopo viram de novo o valor original. `count`
   * falso para prévias parciais do stream (a mesma resposta seria contada a
   * cada pedaço).
   */
  restore(text: string, scope?: object, count = true): string {
    if (!text) return text;
    const r = this.vaultFor(scope).rehydrate(text);
    if (count) this.counters.restoredTokens += r.restored;
    return r.text;
  }

  stats(): PiiGuardStats {
    return { ...this.counters, redactionsByKind: { ...this.counters.redactionsByKind } };
  }
}

export function createPiiGuard(opts: PiiVaultOptions = {}): PiiGuard {
  return new PiiGuard(opts);
}

// ---------------------------------------------------------------------------
// Revisão humana: o "Revisei" vale para o dado REVISADO, não para o futuro
// ---------------------------------------------------------------------------

/**
 * Chaves do dado que motivou bloqueio nos campos `blocked`: uma por achado
 * realista (tipo + valor canônico), como hash SHA-256 truncado — a UI guarda a
 * chave, não o valor. A confirmação "Revisei" cobre exatamente estas chaves.
 */
export function piiReviewKeys(blocked: readonly PiiFieldReport[]): string[] {
  const hash = (s: string): string => toHex(sha256(utf8(s))).slice(0, 16);
  const keys = new Set<string>();
  for (const r of blocked) {
    let achou = false;
    for (const f of r.findings) {
      if (!f.realistic) continue;
      achou = true;
      keys.add(hash(`${f.kind}|${canonical(f)}`));
    }
    // Fail-closed: campo bloqueado sem achado realista (não acontece hoje) não
    // pode virar "nada a revisar" — a chave cai para caminho + tipos.
    if (!achou) keys.add(hash(`campo|${r.path}|${r.assessment.kinds.join('+')}`));
  }
  return [...keys];
}

/**
 * Campos bloqueados que trazem dado AINDA NÃO revisado (chave fora de
 * `reviewed`). Vazio = tudo o que bloqueia já foi confirmado pelo usuário.
 * Trocar o CPF revisado por outro, ou pôr um celular novo em qualquer campo,
 * devolve o campo aqui — a revisão não é um salvo-conduto para o futuro.
 */
export function unreviewedPii(
  blocked: readonly PiiFieldReport[],
  reviewed: ReadonlySet<string>,
): PiiFieldReport[] {
  return blocked.filter((r) => piiReviewKeys([r]).some((k) => !reviewed.has(k)));
}
