// ----------------------------------------------------------------------------
// O DOSSIÊ (§16 do plano) — a evidência determinística que o juiz lê.
//
// Este módulo monta, por código, o dossiê a partir de uma entrada JÁ
// normalizada (diff, steps, checks). Nada aqui é ilegível para auditoria:
// a mesma entrada produz o MESMO texto byte a byte (mesmo sha256), qualquer
// corte é sempre marcado com `[... N linhas omitidas ...]`, e em modo cego a
// identidade do candidato é redigida com um contador público de substituições.
//
// Determinismo total (regra 6, §16.4): nenhum Date.now, nenhum Math.random,
// nenhuma iteração de Object.keys sem ordem — toda ordem vem de sort explícito
// sobre arrays. O sha256 do rodapé é um self-hash: é o hash do texto em que a
// linha `sha256` carrega o marcador fixo `{SHA}`, preenchido depois — a mesma
// saída com a mesma entrada sempre, e verificável recomputando sobre o marcador.
//
// DELIMITAÇÃO ANTI-INJEÇÃO (IMPL-034 / R-14a DEC-7, REC-7/REC-8). Todo texto
// que o AGENTE (ou o código dele) produziu — diff, lista de arquivos, comandos e
// saídas dos passos, mensagem final, saída dos checks do verificador, caminhos
// proibidos tocados — entra SÓ dentro de um bloco
//   <<<DADOS-DO-AGENTE secao="…" marca="M">>>
//   │ …cada linha com a calha "│ "…
//   <<<FIM-DADOS-DO-AGENTE marca="M">>>
// com três travas, para o bloco não poder ser fechado por dentro:
//   1. a MARCA é derivada do sha256 de TODO o conteúdo não confiável — o agente
//      não a conhece ao escrever (embuti-la mudaria o hash: ponto fixo);
//   2. toda linha do conteúdo leva a calha "│ ": nenhuma linha do agente começa
//      na coluna 0, então ele não forja marcador, cabeçalho de seção ("### 2.")
//      nem a linha `marca-dos-dados:` do rodapé;
//   3. o token do marcador (e variantes: `dados_do_agente`, travessões Unicode,
//      caracteres invisíveis no meio) é NEUTRALIZADO dentro do conteúdo e
//      contado no rodapé (`neutralizacoes`). CR/U+2028/NEL/VT/FF viram '\n'
//      antes da calha (trava 2 vale para qualquer quebra de linha).
// Fora dos blocos, só texto produzido por CÓDIGO: cabeçalho, veredito dos checks,
// contagens e os FATOS em JSON de campos fechados (extração em 2 estágios:
// parsing determinístico de arquivos/hunks/checks → JSON fechado, `dossierFacts`).
// Evidência: delimitação 89,7% vs 60,7% sem ela; spotlighting (Hines
// 2403.14720) leva o ASR de >50% a <2%; JudgeDeceiver passa de 90% sem defesa.
// ----------------------------------------------------------------------------
import { createHash } from 'node:crypto';

export interface DossierInput {
  header: {
    stageQuestion: string;
    contestantLabel: string;
    promptMode: string;
    limits: { maxTurns: number; maxCostUsd?: number; timeoutMs: number };
    stopReason: string;
    turns: number;
    durationMs: number;
    toolCalls: number;
    costUsd: number;
    truncationNote?: string;
  };
  oracle?: {
    checks: {
      label: string;
      ok: boolean;
      exitCode: number;
      expected: number;
      tail: string;
      /** O check não terminou com exit normal (conta FALHOU) — motivo p/ o juiz. */
      notRun?: 'spawn' | 'timeout' | 'signal';
    }[];
    score: number;
    violations: string[];
  };
  diffStat: { files: number; added: number; removed: number };
  filesChanged: { path: string; status: string }[];
  diff: string;
  steps: {
    turn: number;
    tool: string;
    arg: string;
    ok: boolean;
    exitCode?: number;
    outputTail?: string;
  }[];
  finalMessage?: string;
  parseErrors?: number;
  redactIdentity?: boolean;
  judgeTokens?: number;
  mode?: 'full' | 'compact';
}

export interface DossierResult {
  text: string;
  truncatedSections: string[];
  complete: boolean;
  redactions: number;
  tokensApprox: number;
  /** Marca dos blocos DADOS-DO-AGENTE deste dossiê (12 hex, derivada do conteúdo). */
  marker: string;
  /** Tokens estruturais neutralizados dentro do conteúdo do agente (tentativa de forjar bloco/placeholder). */
  neutralized: number;
  /** Os fatos de campos fechados que o dossiê carrega (2º estágio da extração). */
  facts: DossierFacts;
}

/** Marcador de sha no rodapé; é o que permite o self-hash determinístico. */
const SHA_PLACEHOLDER = '{SHA}';
/** Marcador do contador de redações; preenchido APÓS o passe de redação. */
const REDACTIONS_PLACEHOLDER = '{REDACTIONS}';

// ---------------------------------------------------------------------------
// Blocos de dados NÃO confiáveis (IMPL-034) — ver cabeçalho do módulo.
// ---------------------------------------------------------------------------

/** Nome do bloco de conteúdo produzido pelo agente. */
export const AGENT_DATA_TAG = 'DADOS-DO-AGENTE';
/** Calha de toda linha de conteúdo do agente: nada dele começa na coluna 0. */
export const AGENT_DATA_GUTTER = '│ ';
/** Linha do rodapé que carrega a marca (sempre na coluna 0 — só código a escreve). */
const MARKER_LINE_PREFIX = 'marca-dos-dados: ';

/** Token do marcador e variantes (sublinhado, espaço, travessões Unicode), sem caixa. */
const MARKER_TOKEN_RE = /dados[\s_\-‐-―−]*do[\s_\-‐-―−]*agente/gi;

/**
 * Caracteres INVISÍVEIS (formato Cf + default-ignorable: U+200B/U+200D/U+2060/
 * U+FEFF, soft hyphen, seletores de variação…). São removidos do conteúdo do
 * agente ANTES da neutralização: senão `DADOS\u200B-DO-AGENTE` escaparia do
 * `MARKER_TOKEN_RE` e seria lido pelo juiz como o marcador. Não são contados
 * um a um (emoji legítimo usa ZWJ/VS16); o que conta é o token que eles
 * escondiam, que passa a casar e é neutralizado+contado normalmente.
 */
const INVISIBLE_RE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Terminadores de linha que NÃO são '\n' (CR solto, CRLF, U+2028/U+2029, NEL,
 * VT, FF): um modelo os lê como quebra de linha, então viram '\n' antes da
 * calha — senão o texto depois deles "começaria na coluna 0" sem o "│ ".
 */
const LINE_BREAK_RE = /\r\n|[\r\u2028\u2029\u0085\v\f]/g;

/** Abertura de bloco (coluna 0) — o formato é contrato com o prompt do juiz. */
export function agentDataOpen(section: string, marker: string): string {
  return `<<<${AGENT_DATA_TAG} secao="${section}" marca="${marker}">>>`;
}

/** Fechamento de bloco (coluna 0). */
export function agentDataClose(marker: string): string {
  return `<<<FIM-${AGENT_DATA_TAG} marca="${marker}">>>`;
}

/**
 * Neutraliza, DENTRO do conteúdo do agente, o que poderia se passar por
 * estrutura do dossiê: o token do marcador (qualquer variante) e os
 * placeholders internos do self-hash/contador. Determinístico e contado.
 */
function neutralizeAgentText(raw: string): { text: string; count: number } {
  const text = raw.replace(INVISIBLE_RE, '');
  let count = 0;
  const out = text
    .replace(MARKER_TOKEN_RE, () => {
      count++;
      return 'dados-citados';
    })
    .split(SHA_PLACEHOLDER)
    .join('{sha-citado}')
    .split(REDACTIONS_PLACEHOLDER)
    .join('{redactions-citado}');
  count += text.split(SHA_PLACEHOLDER).length - 1 + (text.split(REDACTIONS_PLACEHOLDER).length - 1);
  return { text: out, count };
}

/**
 * Envolve conteúdo do agente num bloco delimitado com calha. Conteúdo vazio
 * ainda gera o bloco (o juiz vê que a seção existe e está vazia).
 */
export function quoteAgentData(content: string, section: string, marker: string): { text: string; neutralized: number } {
  const { text, count } = neutralizeAgentText(content.replace(LINE_BREAK_RE, '\n'));
  const body = text.split('\n').map((l) => AGENT_DATA_GUTTER + l);
  return { text: [agentDataOpen(section, marker), ...body, agentDataClose(marker)].join('\n'), neutralized: count };
}

/**
 * Marca derivada do conteúdo NÃO confiável (12 hex). Determinística (a mesma
 * entrada ⇒ o mesmo dossiê byte a byte) e imprevisível para quem escreve o
 * conteúdo: embutir a marca no próprio texto mudaria o hash.
 */
export function agentDataMarker(untrusted: unknown): string {
  return createHash('sha256').update('dossie-marca@1\0').update(JSON.stringify(untrusted)).digest('hex').slice(0, 12);
}

/**
 * Marca de um dossiê já montado: a ÚLTIMA linha `marca-dos-dados: <12 hex>` que
 * começa na coluna 0 (o rodapé). Conteúdo do agente nunca começa na coluna 0,
 * então não forja esta linha. `null` = texto sem selo (não veio de `buildDossier`).
 */
export function dossierMarker(text: string): string | null {
  const re = /^marca-dos-dados: ([0-9a-f]{12})$/gm;
  let last: string | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m[1];
  return last;
}

// ---------------------------------------------------------------------------
// FATOS de campos fechados (extração em 2 estágios, R-14a DEC-7).
// Estágio 1 — parsing determinístico do patch (arquivos/hunks) e dos checks;
// estágio 2 — um JSON só com números, enums e rótulos da TAREFA (nunca texto do
// agente: caminhos de arquivo são escolha do agente e ficam nos blocos).
// ---------------------------------------------------------------------------
export interface DossierFacts {
  encerramento: string;
  turnos: number;
  ferramentas: number;
  errosDeFerramenta: number;
  oraculo: null | {
    score: number;
    checks: {
      rotulo: string;
      status: 'PASSOU' | 'FALHOU';
      exit: number;
      esperado: number;
      naoTerminou?: 'spawn' | 'timeout' | 'signal';
    }[];
    violacoes: number;
  };
  mudancas: {
    arquivos: number;
    adicionadas: number;
    removidas: number;
    hunks: number;
    porTipo: { codigo: number; config: number; teste: number; doc: number };
    ruidoOuBinario: number;
    testesAlterados: boolean;
  };
}

export function dossierFacts(input: DossierInput): DossierFacts {
  const porTipo = { codigo: 0, config: 0, teste: 0, doc: 0 };
  const nomes: Record<RelevanceRank, keyof typeof porTipo> = { 0: 'codigo', 1: 'config', 2: 'teste', 3: 'doc' };
  for (const f of input.filesChanged) porTipo[nomes[relevanceRank(f.path)]] += 1;
  const chunks = splitDiff(input.diff);
  const hunks = chunks.reduce((n, c) => n + (c.content.match(/^@@ /gm)?.length ?? 0), 0);
  const ruidoOuBinario = chunks.filter((c) => isNoisePath(c.path) || isBinaryPatch(c.content)).length;
  const o = input.oracle;
  return {
    encerramento: input.header.stopReason || '-',
    turnos: input.header.turns,
    ferramentas: input.header.toolCalls,
    errosDeFerramenta: input.steps.filter((s) => !s.ok).length,
    oraculo: o
      ? {
          score: Number(o.score.toFixed(4)),
          checks: o.checks.map((c) => ({
            rotulo: c.label,
            status: c.ok ? ('PASSOU' as const) : ('FALHOU' as const),
            exit: c.exitCode,
            esperado: c.expected,
            ...(c.notRun ? { naoTerminou: c.notRun } : {}),
          })),
          violacoes: o.violations.length,
        }
      : null,
    mudancas: {
      arquivos: input.diffStat.files,
      adicionadas: input.diffStat.added,
      removidas: input.diffStat.removed,
      hunks,
      porTipo,
      ruidoOuBinario,
      testesAlterados: porTipo.teste > 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Estimativa de tokens (regra 1, §16.4): caracteres/4. Coerente com o plano.
// ---------------------------------------------------------------------------
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Formato de duração determinístico estilo Apêndice D ("3 min 12 s"). */
function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  const sec = s % 60;
  const h = Math.floor(min / 60);
  if (h > 0) {
    const m = min % 60;
    return `${h} h ${m} min`;
  }
  return `${min} min ${sec} s`;
}

/** Formata US$ em PT-BR (vírgula decimal), com até 4 casas — Apêndice D. */
function formatUsd(value: number): string {
  if (!Number.isFinite(value)) value = 0;
  const sign = value < 0 ? '-' : '';
  const s = Math.abs(value).toFixed(4).replace(/\.?0+$/, '');
  return `${sign}US\$ ${s.replace('.', ',')}`;
}

// ---------------------------------------------------------------------------
// Truncamento (regras 2 e 4, §16.4). TRUNCAR É SEMPRE VISÍVEL.
// `truncateMid` corta NO MEIO (o começo traz contexto, o fim traz o resultado);
// `truncateEnd` corta no fim (usado só na MENSAGEM FINAL, §16.3).
// ---------------------------------------------------------------------------
interface Truncated {
  text: string;
  truncated: boolean;
}

function omitMarkMid(omitted: number): string {
  return `[... ${omitted} linhas omitidas ...]`;
}

function truncateMid(text: string, budgetChars: number, mk: (n: number) => string): Truncated {
  // Preserva a marcação de truncamento MESMO com orçamento <= 0.
  if (budgetChars <= 0) {
    if (text.length === 0) return { text: '', truncated: false };
    return { text: mk(countLines(text)), truncated: true };
  }
  if (text.length <= budgetChars) return { text, truncated: false };
  const lines = text.split('\n');
  // Divide o orçamento ao MEIO: início (contexto) e fim (resultado) têm mais sinal.
  const headBudget = Math.floor(budgetChars / 2);
  const tailBudget = budgetChars - headBudget;
  let headChars = 0;
  let headLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].length + 1; // +1 pelo '\n'
    if (headChars + l > headBudget) break;
    headChars += l;
    headLines++;
  }
  let tailChars = 0;
  let tailLines = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].length + 1;
    if (tailChars + l > tailBudget) break;
    tailChars += l;
    tailLines++;
  }
  const omitted = lines.length - headLines - tailLines;
  if (omitted <= 0) {
    // Orçamento por demais apertado para os dois pedaços: corta só no começo.
    const kept = text.slice(0, budgetChars);
    return { text: kept + '\n' + mk(countLines(text)), truncated: true };
  }
  const headPart = lines.slice(0, headLines).join('\n');
  const tailPart = lines.slice(lines.length - tailLines).join('\n');
  return {
    text: headPart + '\n' + mk(omitted) + '\n' + tailPart,
    truncated: true,
  };
}

function truncateEnd(text: string, budgetChars: number): Truncated {
  if (budgetChars <= 0) {
    if (text.length === 0) return { text: '', truncated: false };
    return { text: omitMarkMid(countLines(text)), truncated: true };
  }
  if (text.length <= budgetChars) return { text, truncated: false };
  return { text: text.slice(0, budgetChars) + '\n' + omitMarkMid(countLines(text)), truncated: true };
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

// ---------------------------------------------------------------------------
// Filtro de RUÍDO no diff (regra 7, §16.4) — só no patch. O `--stat` e o
// `filesChanged` permanecem; o juiz vê que os arquivos existiram.
// ---------------------------------------------------------------------------
const NOISE_PATTERNS: RegExp[] = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)build(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /\.lock$/, // inclui yark/pnpm-lock, mas PODE casar package-lock.json? não — acaba em .json
  /(^|\/)package-lock\.json$/, // explicito: a spec lista package-lock.json além de *.lock
  /\.min\.js$/,
  /\.map$/,
];

function isNoisePath(path: string): boolean {
  return NOISE_PATTERNS.some((r) => r.test(path));
}

/** Binário: contém byte NUL ou é patch binário do git. */
function isBinaryPatch(content: string): boolean {
  return (
    content.includes('\0') ||
    /^GIT binary patch$/m.test(content) ||
    /^Binary files .* differ$/m.test(content)
  );
}

// ---------------------------------------------------------------------------
// Ordenação dos arquivos do diff por RELEVÂNCIA (regra da §16.3):
// código > config > teste > doc — o que decide o veredito vem antes do que
// provavelmente será cortado. Desempate por caminho, p/ determinismo.
// ---------------------------------------------------------------------------
type RelevanceRank = 0 | 1 | 2 | 3; // código | config | teste | doc

function relevanceRank(path: string): RelevanceRank {
  const lower = path.toLowerCase();
  const base = path.split('/').pop() ?? '';
  if (
    /\b(__tests__|tests|spec|specs)\b/.test(lower) ||
    /(^|\/)(test|__tests__)(\/|$)/.test(lower) ||
    /\.(test|spec)\./.test(base)
  ) {
    return 2;
  }
  if (
    /\.(md|mdx|rst|adoc|txt)$/.test(lower) ||
    /readme|^docs\//.test(lower) ||
    /(^|\/)license$/i.test(base)
  ) {
    return 3;
  }
  if (
    /\.(json|ya?ml|toml|cson)$/.test(lower) ||
    /config\./i.test(lower) ||
    /^package(-lock)?\.json$/.test(base) ||
    /^tsconfig.*\.json$/i.test(base) ||
    /^dockerfile$/i.test(base) ||
    /^\.gitignore$/.test(base) ||
    /^vercel\.json$/.test(base) ||
    /\.env/i.test(lower)
  ) {
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Split do patch unificado em arquivos (diff a/b por `diff --git`).
// ---------------------------------------------------------------------------
interface DiffFile {
  path: string;
  content: string;
}

function splitDiff(diff: string): DiffFile[] {
  const lines = diff.split('\n');
  const chunks: string[][] = [];
  let cur: string[] = [];
  for (const ln of lines) {
    if (ln.startsWith('diff --git ')) {
      if (cur.length > 0) chunks.push(cur);
      cur = [ln];
    } else {
      cur.push(ln);
    }
  }
  if (cur.length > 0) chunks.push(cur);

  const out: DiffFile[] = [];
  for (const chunk of chunks) {
    const content = chunk.join('\n');
    const path = pathOfChunk(content);
    if (path) out.push({ path, content });
  }
  return out;
}

function pathOfChunk(content: string): string | null {
  const header = content.match(/^diff --git (.+)$/m);
  if (!header) return null;
  const tokens = header[1].trim().split(/\s+/);
  let aPath: string | null = null;
  let bPath: string | null = null;
  for (const t of tokens) {
    if (t.startsWith('b/')) bPath = t.slice(2);
    else if (t.startsWith('a/')) aPath = t.slice(2);
  }
  if (bPath && bPath !== '/dev/null') return bPath;
  if (aPath && aPath !== '/dev/null') return aPath;
  const plus = content.match(/^\+\+\+ b\/(.+)$/m);
  if (plus) return plus[1].trim();
  const minus = content.match(/^--- a\/(.+)$/m);
  return minus ? minus[1].trim() : null;
}

const FILE_OMIT = (...omitted: number[]): string => `[... ${omitted[0]} linhas omitidas neste arquivo ...]`;

// ---------------------------------------------------------------------------
// REDAÇÃO de identidade (regra 5, §16.4) — modo cego. Qualquer modelo conhecido,
// provider/model/responseId, timestamp ISO e eventos de troca de modelo saem.
// Conta cada substituição; zero em modo cego é bug (o chamador valida).
// ---------------------------------------------------------------------------
const REDAS_PLACEHOLDER = '<redigido>';

/** Padrões de identidade, apenas os que não poderiam ser texto legítimo de tarefa. */
function identityPatterns(): RegExp[] {
  return [
    // provider:/model: com valor
    /\bprovider:\s*[A-Za-z0-9_./:+@-]+/g,
    /\bmodel:\s*[A-Za-z0-9_./:+@-]+/g,
    // responseId (JSON key ou dois-pontos)
    /"responseId"\s*:\s*"[^"]*"/g,
    /\bresponseId\s*:\s*[A-Za-z0-9_-]+/g,
    // timestamps ISO 8601
    /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{1,2}:?\d{2})?\b/g,
    // eventos de troca de modelo/conjunto de pensée
    /\bmodel_change\b/g,
    /\bthinking_level_change\b/g,
    // QUALQUER modelo de LLM conhecido no texto (mesmo sem `model:` na frente)
    /\b(google\/gemini|anthropic\/claude|openai\/(?:gpt|o[0-9]-)|openrouter\/|meta-llama\/|mistralai\/|deepseek\/|qwen\/|groq\/|together\/|cohere\/|x-ai\/|ai21\/|nvidia\/|amazon\/)[A-Za-z0-9.-]*/g,
  ];
}

/**
 * Aplica o passe de redação sobre o texto já integralmente montado, contando
 * cada substituição. Determinístico: a lista de padrões é fixa e em ordem.
 */
function redactIfBlind(text: string, enabled: boolean): { text: string; count: number } {
  if (!enabled) return { text, count: 0 };
  const patterns = identityPatterns();
  let result = text;
  let count = 0;
  for (const re of patterns) {
    result = result.replace(re, () => {
      count++;
      return REDAS_PLACEHOLDER;
    });
  }
  return { text: result, count };
}

// ---------------------------------------------------------------------------
// Montagem das 7 seções, na ordem fixa da §16.3.
// ---------------------------------------------------------------------------

function buildHeader(input: DossierInput, complete: boolean): string {
  const h = input.header;
  const lines: string[] = [];
  lines.push('### 1. CABEÇALHO');
  lines.push(`Tarefa .............. ${h.stageQuestion || '(sem enunciado)'}`);
  const labelLine = h.contestantLabel || '?';
  lines.push(
    input.redactIdentity
      ? `Candidato ........... ${labelLine} (identidade redigida: ${REDACTIONS_PLACEHOLDER} substituições)`
      : `Candidato ........... ${labelLine}`,
  );
  lines.push(`Modo de prompt ...... ${h.promptMode || '-'}`);
  const cost = h.limits.maxCostUsd === undefined ? '—' : formatUsd(h.limits.maxCostUsd);
  lines.push(`Limites ............. ${h.limits.maxTurns} turnos · ${cost} · ${formatDuration(h.limits.timeoutMs)}`);
  lines.push(`Encerramento ........ ${h.stopReason || '-'}`);
  lines.push(
    `Turnos .............. ${h.turns}        Ferramentas: ${h.toolCalls}        Duração: ${formatDuration(h.durationMs)}`,
  );
  lines.push(`Custo ............... ${formatUsd(h.costUsd)} (derivado do executor)`);
  lines.push(`Dossiê .............. ${complete ? 'COMPLETO' : 'TRUNCADO (config incorreta)'}`);
  if (h.truncationNote) lines.push(`Aviso de truncamento . ${h.truncationNote}`);
  return lines.join('\n');
}

/** Envolve conteúdo do agente num bloco (a marca e o contador vêm do montador). */
type Quote = (content: string, section: string) => string;

function buildVerify(input: DossierInput, q: Quote): string {
  const oracle = input.oracle;
  const lines: string[] = ['### 2. VERIFICAÇÃO AUTOMÁTICA'];
  if (!oracle || oracle.checks.length === 0) {
    lines.push('(sem oráculo automático)');
    return lines.join('\n');
  }
  const naoTerminou: Record<'spawn' | 'timeout' | 'signal', string> = {
    spawn: 'o comando nem começou (ausente ou sem permissão)',
    timeout: 'passou do tempo limite do check',
    signal: 'o processo foi morto por sinal',
  };
  for (const check of oracle.checks) {
    const status = check.ok ? 'PASSOU' : 'FALHOU';
    lines.push(
      `[${status}]  ${check.label}       exit ${check.exitCode} (esperado ${check.expected})` +
        (check.notRun ? ` — não terminou: ${naoTerminou[check.notRun]}` : ''),
    );
    // A saída do check é produzida pelo CÓDIGO SOB TESTE (o agente o escreveu):
    // pode imprimir "todos os testes passaram" à vontade — é dado, nunca veredito.
    if (!check.ok && check.tail) {
      lines.push('    últimas linhas (saída do código sob teste):');
      lines.push(q(String(check.tail), '2-saida-do-check'));
    }
  }
  if (oracle.violations.length > 0) {
    // Os caminhos são nomes escolhidos pelo agente: a contagem é fato, a lista é dado.
    lines.push(`Caminhos proibidos ... ${oracle.violations.length} tocado(s):`);
    lines.push(q(oracle.violations.join('\n'), '2-caminhos-proibidos'));
  } else {
    lines.push('Caminhos proibidos ... nenhum');
  }
  lines.push(`Score do oráculo ..... ${(oracle.score * 100).toFixed(1).replace('.', ',')}%`);
  return lines.join('\n');
}

function buildSummary(input: DossierInput, facts: DossierFacts, q: Quote): string {
  const stat = input.diffStat;
  const lines: string[] = ['### 3. RESUMO DAS MUDANÇAS'];
  lines.push(`${stat.files} arquivo${stat.files === 1 ? '' : 's'}, +${stat.added} −${stat.removed}`);
  // 2º estágio da extração: campos FECHADOS (números, enums, rótulos da tarefa).
  lines.push(`Fatos (JSON de campos fechados, medidos por código): ${JSON.stringify(facts)}`);
  const statuses = input.filesChanged
    .map((f) => `[${f.status.toUpperCase().slice(0, 1)}] ${f.path}`)
    .sort(); // determinismo
  if (statuses.length > 0) {
    lines.push('Arquivos alterados (nomes escolhidos pelo agente):');
    lines.push(q(statuses.join('\n'), '3-arquivos'));
  }
  return lines.join('\n');
}

function buildDiff(input: DossierInput, budgetChars: number, q: Quote): { text: string; truncated: boolean } {
  const lines: string[] = ['### 4. DIFF'];
  const files = splitDiff(input.diff)
    .filter((f) => !isNoisePath(f.path) && !isBinaryPatch(f.content))
    .sort((a, b) => {
      const r = relevanceRank(a.path) - relevanceRank(b.path);
      return r !== 0 ? r : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
  if (files.length === 0) {
    lines.push('(sem alterações relevantes no patch)');
    return { text: lines.join('\n'), truncated: false };
  }
  // Orçamento dividido IGUALMENTE entre os arquivos retidos: os primeiros
  // (mais relevantes, já ordenados) preservam mais sinal.
  const perFile = Math.max(4, Math.floor(budgetChars / files.length));
  let truncatedAny = false;
  const body: string[] = [];
  for (const f of files) {
    const t = truncateMid(f.content, perFile, FILE_OMIT);
    if (t.truncated) truncatedAny = true;
    body.push(t.text);
    body.push('');
  }
  // O patch INTEIRO é conteúdo do agente (inclusive comentários com "instruções").
  lines.push(q(body.join('\n').replace(/\n+$/, ''), '4-diff'));
  return { text: lines.join('\n'), truncated: truncatedAny };
}

function buildSteps(input: DossierInput, budgetChars: number, q: Quote): { text: string; truncated: boolean } {
  const lines: string[] = ['### 5. O QUE O AGENTE FEZ'];
  if (input.steps.length === 0) {
    lines.push('(nenhum passo registrado)');
    return { text: lines.join('\n'), truncated: false };
  }
  const body: string[] = [];
  for (const s of input.steps) {
    const status = s.ok ? 'ok' : 'ERRO';
    const exitPart = s.exitCode === undefined ? '' : ` (exit ${s.exitCode})`;
    const line = ` ${s.turn}. t${s.turn} · ${s.tool}  ${s.arg}`;
    const pad = Math.max(1, 60 - line.length);
    body.push(line + ' '.repeat(pad) + status + exitPart);
    if (!s.ok && s.outputTail) {
      for (const tl of String(s.outputTail).split('\n')) body.push(`    ${tl}`);
    }
  }
  // Comandos e saídas vêm do agente: truncados (visível) e DENTRO do bloco.
  const t = truncateMid(body.join('\n'), budgetChars, omitMarkMid);
  lines.push(q(t.text, '5-passos'));
  return { text: lines.join('\n'), truncated: t.truncated };
}

function buildFinalMessage(input: DossierInput, budgetChars: number, q: Quote): { text: string; truncated: boolean } {
  const msg = (input.finalMessage ?? '').trim();
  const head = '### 6. MENSAGEM FINAL DO AGENTE';
  if (!msg) return { text: head + '\n(sem mensagem final)', truncated: false };
  // Alegações da despedida ("todos os testes passaram") são dado, não evidência.
  const t = truncateEnd(msg, budgetChars);
  return { text: head + '\n' + q(t.text, '6-mensagem-final'), truncated: t.truncated };
}

function buildFooter(input: DossierInput, truncatedSections: string[], complete: boolean, marker: string, neutralized: number): string {
  const sec = truncatedSections.length > 0 ? `[${truncatedSections.join(',')}]` : '[]';
  const parseErrors = input.parseErrors ?? 0;
  return [
    '### 7. RODAPÉ DE INTEGRIDADE',
    `dossierComplete: ${complete} · seções truncadas: ${sec} · parseErrors: ${parseErrors} · redactions: ${REDACTIONS_PLACEHOLDER} · neutralizacoes: ${neutralized}`,
    `${MARKER_LINE_PREFIX}${marker}`,
    `sha256: ${SHA_PLACEHOLDER}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Montador público. As seções 1/2/3/7 NUNCA são truncadas: se não couberem no
// orçamento é erro de CONFIG (complete:false), nunca corte (regra 3, §16.4).
// ---------------------------------------------------------------------------
export function buildDossier(input: DossierInput): DossierResult {
  const mode = input.mode ?? 'full';
  const budgetTokens = Math.max(1, input.judgeTokens ?? 12_000);
  const budgetChars = budgetTokens * 4;

  // Porcentagens do orçamento por seção. Em `compact` (duelos) o orçamento é
  // metade e as seções 4/5 ficam mais agressivamente cortadas (seção 6 fora).
  const compact = mode === 'compact';
  const effBudget = compact ? Math.floor(budgetChars / 2) : budgetChars;
  const cap4 = compact ? Math.floor(effBudget * 0.5) : Math.floor(effBudget * 0.55);
  const cap5 = compact ? Math.floor(effBudget * 0.2) : Math.floor(effBudget * 0.25);
  const cap6 = compact ? 0 : 2000; // ~500 tokens, "metade" cheia (full)

  // Marca dos blocos: derivada de TODO o conteúdo não confiável (ver cabeçalho).
  const marker = agentDataMarker([
    input.diff,
    input.filesChanged,
    input.steps,
    input.finalMessage ?? '',
    input.oracle?.checks.map((c) => c.tail) ?? [],
    input.oracle?.violations ?? [],
  ]);
  let neutralized = 0;
  const q: Quote = (content, section) => {
    const r = quoteAgentData(content, section, marker);
    neutralized += r.neutralized;
    return r.text;
  };
  const facts = dossierFacts(input);

  // Seções 1/2/3/7 (nunca truncadas): monta e mede.
  const s2 = buildVerify(input, q);
  const s3 = buildSummary(input, facts, q);
  const mandatedTokens = estimateTokens(
    [buildHeader(input, true), s2, s3, buildFooter(input, [], true, marker, 0)].join('\n'),
  );

  // Se o que não pode ser cortado já estourar o teto, é config incorreta.
  const truncatedSections: string[] = [];
  let complete = true;
  if (mandatedTokens > budgetTokens) {
    complete = false;
    truncatedSections.push('1,2,3,7', 'budget-abaixo-do-minimo');
  }

  // Seções 4/5/6. A 4 só entra quando as seções mandatórias cabem no orçamento.
  let s4 = '';
  if (mandatedTokens <= budgetTokens) {
    const diffRes = buildDiff(input, cap4, q);
    s4 = diffRes.text;
    if (diffRes.truncated) truncatedSections.push('4');
  }

  const stepRes = buildSteps(input, cap5, q);
  if (stepRes.truncated) truncatedSections.push('5');

  let s6 = '';
  if (!compact) {
    const finalRes = buildFinalMessage(input, cap6, q);
    s6 = finalRes.text;
    // Pelo flag do truncamento — nunca por busca de texto (o agente pode
    // escrever "linhas omitidas" na despedida e fingir um corte).
    if (finalRes.truncated) truncatedSections.push('6');
  }

  // Cabeçalho e rodapé com o estado REAL (antes saíam sempre "COMPLETO"/"[]",
  // mesmo com seção truncada — e o juiz é instruído a considerar o truncamento).
  const secoes = [...new Set(truncatedSections)]; // dedupe, mantém ordem
  const s1 = buildHeader(input, complete);
  const s7 = buildFooter(input, secoes, complete, marker, neutralized);

  // Montagem da folha: seções na ordem fixa (§16.3).
  const sectionOrder = compact ? [s1, s2, s3, s4, stepRes.text, s7] : [s1, s2, s3, s4, stepRes.text, s6, s7];
  const draft = sectionOrder.filter((s) => s.length > 0).join('\n\n');

  // Redação em modo cego sobre o documento INTEIRO.
  const { text: redacted, count } = redactIfBlind(draft, !!input.redactIdentity);

  // Preenche o contador de redações (corpo e rodapé), então calcula o self-hash.
  const withCounts = redacted.split(REDACTIONS_PLACEHOLDER).join(String(count));
  const digest = createHash('sha256').update(withCounts).digest('hex');
  const text = withCounts.split(SHA_PLACEHOLDER).join(digest);

  return {
    text,
    truncatedSections: secoes,
    complete,
    redactions: count,
    tokensApprox: estimateTokens(text),
    marker,
    neutralized,
    facts,
  };
}
