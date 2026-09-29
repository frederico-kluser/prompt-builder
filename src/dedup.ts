// Deduplicacao de cenarios — fonte única (o web re-exporta por shim).
//
// Camadas (R-05:REC-7 / IMPL-063):
// 1. Passe EXATA pelo PAR normalizado (pergunta + productContext) — O(n) com Map.
//    Antes a chave era só a pergunta: cenários com a MESMA pergunta e contextos
//    diferentes (respostas diferentes!) colapsavam.
// 2. Camada SEMÂNTICA por embeddings + cosseno sobre o PAR (pergunta+contexto),
//    threshold default 0.9 (calibrável via `DedupeOptions.cosineThreshold`).
//    O embedder é injetado (`EmbedFn`): /v1/embeddings do OpenRouter no Node,
//    transformers.js no navegador — o módulo continua SEM rede e roda igual nos
//    dois motores. Sem embedder a camada fica desligada (só a exata age).
// 3. Checagem auxiliar SÓ-PERGUNTA para ECO DE TEMPLATE: pares cuja pergunta é
//    quase idêntica mas que NÃO podem ser fundidos são relatados (nunca
//    descartados) — é a assinatura do gerador reaproveitando o mesmo template
//    com outra entidade.
//
// Por que a antiga camada ROUGE-L ≥ 0.7 sobre a pergunta foi REMOVIDA: a sonda
// N1 mediu os dois erros dela — paráfrases reais passavam (similaridade 0.00 e
// 0.12) e pares que diferem só por entidade colapsavam (0.88 e 0.91 → viravam
// "duplicata" e eram descartados). `rougeL` continua exportado (checagem de eco
// de template), mas ele NÃO decide mais fusão — nem no merge seed × gerados do
// pacote de cenários (web-live#7), que descartava calado DEPOIS da reposição.
//
// VETO de entidade: duas perguntas que divergem em entidades salientes
// (números, códigos, nomes próprios) NUNCA fundem, mesmo com cosseno alto —
// o par (pergunta+contexto) responde diferente quando muda a entidade. Isto é
// o que garante 0 falso-positivo em pares "que diferem só por entidade".
//
// Sem MinHash/LSH: abaixo de ~500 itens a passe O(n²) por pares é mais barata
// que a indexação LSH e não tem os falsos positivos dela; acima disso a rota é
// aumentar o threshold/amostrar — LSH fica para uma medida futura.

/** Normaliza um prompt para comparacao: lowercase, troca tudo que nao e
 * letra/numero/espaco por espaco, colapsa espacos, trim. */
export function normPrompt(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normPrompt(s).split(' ').filter(Boolean);
}

/** Comprimento da maior subsequencia comum (LCS) entre dois arrays de tokens —
 * programacao dinamica otimizada em espaco (duas linhas de DP). */
function lcsLen(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

/** ROUGE-L F1 em [0,1] entre dois textos (normalizados e tokenizados por espaco).
 * Strings vazias (apos normalizacao) → 0. NAO decide mais fusão (ver header) —
 * usado só pela checagem de eco de template. */
export function rougeL(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const l = lcsLen(ta, tb);
  const prec = l / tb.length;
  const rec = l / ta.length;
  return prec + rec === 0 ? 0 : (2 * prec * rec) / (prec + rec);
}

/** Cosseno entre dois vetores de igual dimensao. Vetores vazios/desalinhados → 0. */
export function cosine(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ----------------------------------------------------------------------------
// Embeddings injetados (o módulo não faz rede)
// ----------------------------------------------------------------------------

/** Embedder de textos → vetores. Lote: uma chamada por bloco de textos.
 * Rotas confirmadas: `/v1/embeddings` do OpenRouter (Node) ou transformers.js
 * (navegador). Sem embedder a camada semântica fica desligada. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/** Limiar DEFAULT da fusão semântica (cosseno sobre o PAR pergunta+contexto).
 * ~0.9: paráfrases verdadeiras passam; pares que divergem por entidade caem
 * abaixo (e ainda assim o veto de entidade os protege). Calibrável por config
 * (`DedupeOptions.cosineThreshold` → `GenerateStagesParams.dedup`). */
export const DEFAULT_COSINE_THRESHOLD = 0.9;

/** Limiar da checagem auxiliar SÓ-PERGUNTA (eco de template): acima dele duas
 * perguntas são "a mesma pergunta" na superfície (a sonda N1 mediu 0.88–0.91
 * nos pares que só diferem por entidade — daí o default 0.85). Só RELATA —
 * nunca descarta. */
export const DEFAULT_ECHO_THRESHOLD = 0.85;

/** Fração de descartes que dispara o alerta da run (R-05:REC-7: > 20%). */
export const DEDUP_ALERT_RATE = 0.2;

export interface DedupeOptions {
  /** Cosseno mínimo (sobre o par) para fundir. Default `DEFAULT_COSINE_THRESHOLD`. */
  cosineThreshold?: number;
  /** Similaridade só-pergunta para detectar eco de template. Default `DEFAULT_ECHO_THRESHOLD`. */
  echoThreshold?: number;
  /** Embedder (sem ele: só a passe exata + relatório de eco). */
  embed?: EmbedFn;
  /**
   * ÂNCORAS (web-live#7): itens JÁ aceitos — o seed/pacote importado, que é
   * curadoria do usuário. Nunca são descartados nem entram nas contagens do
   * relatório; servem só de referência: um item da lista que colide com uma
   * âncora (par exato, ou cosseno sem conflito de entidade) sai e é contado em
   * `anchorDropped`. É o que deixa o dedup contra o seed acontecer ANTES da
   * decisão de reposição do datagen — antes o merge seed×gerados descartava
   * DEPOIS dela, sem repor e sem contar.
   */
  anchors?: { question: string; productContext?: string }[];
}

/**
 * Config de RUN do dedup de cenários (IMPL-063) — `RunConfigBase.scenarioDedup`.
 * `semantic: true` liga a camada de embeddings com o embedder de produção
 * (`src/embeddings.ts`: /embeddings do OpenRouter pelo MESMO gateway/ledger do
 * chat, custo no papel `datagen`). Ausente/false = só a passe exata do par (o
 * comportamento de antes). Limiares calibráveis por domínio (R-05:DEC-4).
 */
export interface ScenarioDedupConfig {
  semantic?: boolean;
  /** Modelo de representação (default `DEFAULT_DEDUP_EMBED_MODEL`). */
  embedModelId?: string;
  /** Cosseno mínimo para fundir (default `DEFAULT_COSINE_THRESHOLD`). */
  cosineThreshold?: number;
  /** Limiar só-pergunta do eco de template (default `DEFAULT_ECHO_THRESHOLD`). */
  echoThreshold?: number;
}

/** Relatório de duplicatas removidas por run (R-05:REC-7): taxa + alerta > 20%. */
export interface DedupeReport {
  /** Itens considerados. */
  total: number;
  kept: number;
  dropped: number;
  /** Descartes exatos (par idêntico). */
  exactDropped: number;
  /** Descartes da camada semântica (cosseno sobre o par). */
  semanticDropped: number;
  /**
   * Dos descartes acima (exatos + semânticos), quantos colidiram com uma
   * ÂNCORA (seed importado) e não com outro item gerado. Subconjunto — nunca
   * somado de novo a `dropped`.
   */
  anchorDropped: number;
  /** Pares de ECO DE TEMPLATE detectados (pergunta quase idêntica, par distinto) —
   * relatados, nunca descartados. */
  templateEcho: number;
  /** dropped / total (0 quando total = 0). */
  rate: number;
  /** Limiar do alerta (`DEDUP_ALERT_RATE`). */
  alertRate: number;
  /** rate > alertRate. */
  alert: boolean;
}

export interface DedupeResult<T> {
  kept: T[];
  dropped: T[];
  /** 'none' = nada dropado; 'exact' = só a passe exata; 'semantic' = camada semântica. */
  method: 'none' | 'exact' | 'semantic';
  report: DedupeReport;
}

export function emptyDedupeReport(): DedupeReport {
  return {
    total: 0,
    kept: 0,
    dropped: 0,
    exactDropped: 0,
    semanticDropped: 0,
    anchorDropped: 0,
    templateEcho: 0,
    rate: 0,
    alertRate: DEDUP_ALERT_RATE,
    alert: false,
  };
}

/** Soma relatórios (lotes + backfill) num relatório único da run. */
export function combineDedupeReports(...reports: DedupeReport[]): DedupeReport {
  const out = emptyDedupeReport();
  for (const r of reports) {
    out.total += r.total;
    out.kept += r.kept;
    out.dropped += r.dropped;
    out.exactDropped += r.exactDropped;
    out.semanticDropped += r.semanticDropped;
    out.anchorDropped += r.anchorDropped ?? 0;
    out.templateEcho += r.templateEcho;
    out.alertRate = r.alertRate;
  }
  out.rate = out.total > 0 ? out.dropped / out.total : 0;
  out.alert = out.rate > out.alertRate;
  return out;
}

// ----------------------------------------------------------------------------
// Entidades salientes + veto (checagem auxiliar só-pergunta)
// ----------------------------------------------------------------------------

/**
 * Entidades salientes de uma pergunta: números/códigos (contêm dígito) e
 * palavras capitalizadas FORA de início de frase. Heurística determinística,
 * sem NLP — só precisa separar "mesmo template, outra entidade".
 */
export function salientTokens(text: string): string[] {
  const out = new Set<string>();
  const frases = String(text ?? '').split(/(?<=[.!?])\s+/);
  for (const frase of frases) {
    const encontradas = frase.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
    encontradas.forEach((tok, i) => {
      const temDigito = /\d/.test(tok);
      const capitalizada = /^[A-ZÁÂÃÉÊÍÓÔÕÚÜÇ]/.test(tok);
      if (temDigito || (capitalizada && i > 0)) out.add(tok.toLowerCase());
    });
  }
  return [...out].sort();
}

/**
 * Conflito de entidade entre duas perguntas: as duas têm entidades salientes e
 * nenhuma das listas contém a outra ("Fone Aurora" vs "TV Prism" = conflito;
 * "Fone Aurora" vs "Aurora" = só um modificador extra, sem conflito). É o que
 * impede o colapso de pares que diferem só por entidade (sonda N1).
 */
export function entityConflict(a: string, b: string): boolean {
  const sa = salientTokens(a);
  const sb = salientTokens(b);
  if (!sa.length || !sb.length) return false;
  const setB = new Set(sb);
  const setA = new Set(sa);
  const aContemB = sb.every((t) => setA.has(t));
  const bContemA = sa.every((t) => setB.has(t));
  return !aContemB && !bContemA;
}

/** Contexto do cenário (productContext); ausente/não-texto → ''. */
function contextOf(item: { question: string }): string {
  const ctx = (item as { productContext?: unknown }).productContext;
  return typeof ctx === 'string' ? ctx : '';
}

/** Par de texto comparado pela camada semântica: PERGUNTA + CONTEXTO. */
export function pairText(item: { question: string }): string {
  const contexto = contextOf(item);
  return contexto.trim() ? `${item.question}\n${contexto}` : item.question;
}

// ----------------------------------------------------------------------------
// Deduplicação
// ----------------------------------------------------------------------------

function rubricOf(item: { question: string }): string {
  const r = (item as { rubric?: unknown }).rubric;
  return typeof r === 'string' ? r : '';
}

/** Regra de keep do cluster: prefere quem tem rubric nao-vazia (sinal de treino
 * mais rico); desempata pela question mais longa. */
function isBetterKeep<T extends { question: string }>(candidate: T, current: T): boolean {
  const candRubric = rubricOf(candidate).trim().length > 0;
  const curRubric = rubricOf(current).trim().length > 0;
  if (candRubric !== curRubric) return candRubric;
  return candidate.question.length > current.question.length;
}

/** Chave da passe exata: PAR normalizado (pergunta + contexto). */
export function exactPairKey(item: { question: string }): string {
  return `${normPrompt(item.question)}\u0000${normPrompt(contextOf(item))}`;
}

/** Passe exata: chave = PAR normalizado (pergunta + contexto). O(n). Colisão
 * com uma âncora também descarta (e conta em `anchorHits`). */
function exactPass<T extends { question: string }>(
  items: T[],
  anchors: { question: string }[] = [],
): { unique: T[]; dropped: T[]; anchorHits: number } {
  const ancoras = new Set(anchors.map(exactPairKey));
  const seen = new Set<string>();
  const unique: T[] = [];
  const dropped: T[] = [];
  let anchorHits = 0;
  for (const item of items) {
    const key = exactPairKey(item);
    if (ancoras.has(key)) {
      anchorHits += 1;
      dropped.push(item);
      continue;
    }
    if (seen.has(key)) {
      dropped.push(item);
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return { unique, dropped, anchorHits };
}

/**
 * Clustering guloso SEMÂNTICO: cada item entra no primeiro cluster cujo
 * representante passa no cosseno sobre o par E não tem conflito de entidade.
 * Com embedder ausente a camada não age (só a exata).
 */
async function semanticPass<T extends { question: string }>(
  unique: T[],
  opts: {
    cosineThreshold: number;
    echoThreshold: number;
    embed?: EmbedFn;
    anchors?: { question: string; productContext?: string }[];
  },
): Promise<{ kept: T[]; dropped: T[]; templateEcho: number; anchorHits: number }> {
  const { cosineThreshold, echoThreshold, embed } = opts;
  const anchors = opts.anchors ?? [];
  if (!embed || unique.length === 0 || (unique.length === 1 && anchors.length === 0)) {
    return { kept: unique, dropped: [], templateEcho: 0, anchorHits: 0 };
  }

  // Âncoras e itens num lote só de embeddings (uma chamada).
  const vetores = await embed([...anchors.map(pairText), ...unique.map(pairText)]);
  type Cluster = { rep: { question: string }; vec: number[]; members: T[]; fixed: boolean };
  // Âncoras abrem clusters FIXOS: o representante nunca é trocado e o item que
  // cair nele sai (colidiu com a curadoria do usuário).
  const clusters: Cluster[] = anchors.map((a, i) => ({ rep: a, vec: vetores[i] ?? [], members: [], fixed: true }));
  const base = anchors.length;
  let anchorHits = 0;
  for (let i = 0; i < unique.length; i += 1) {
    const item = unique[i];
    const vec = vetores[base + i] ?? [];
    let placed: Cluster | undefined;
    for (const c of clusters) {
      if (entityConflict(item.question, c.rep.question)) continue;
      if (cosine(vec, c.vec) >= cosineThreshold) {
        placed = c;
        break;
      }
    }
    if (placed) {
      placed.members.push(item);
      if (placed.fixed) anchorHits += 1;
      else if (isBetterKeep(item, placed.rep as T)) {
        placed.rep = item;
        placed.vec = vec;
      }
    } else {
      clusters.push({ rep: item, vec, members: [item], fixed: false });
    }
  }

  const kept = clusters.filter((c) => !c.fixed).map((c) => c.rep as T);
  const keepSet = new Set<T>(kept);
  const dropped = unique.filter((item) => !keepSet.has(item));

  // Eco de template entre os MANTIDOS: pergunta quase idêntica (só-pergunta)
  // com o par distinto — assinatura de template reaproveitado com outra
  // entidade. Relatado, nunca descartado (é o que a sonda N1 pedia).
  let templateEcho = 0;
  for (let i = 0; i < kept.length; i += 1) {
    for (let j = i + 1; j < kept.length; j += 1) {
      if (rougeL(kept[i].question, kept[j].question) >= echoThreshold) templateEcho += 1;
    }
  }
  return { kept, dropped, templateEcho, anchorHits };
}

/**
 * Dedup SEMÂNTICA de cenários ({ question, productContext? }): passe exata pelo
 * par → embeddings + cosseno (threshold calibrável, default 0.9) com veto de
 * entidade → relatório de duplicatas removidas (taxa + alerta > 20%) e de eco
 * de template. `embed` ausente = camada semântica desligada.
 */
export async function dedupeSemantic<T extends { question: string }>(
  list: T[],
  opts?: DedupeOptions,
): Promise<DedupeResult<T>> {
  const cosineThreshold = opts?.cosineThreshold ?? DEFAULT_COSINE_THRESHOLD;
  const echoThreshold = opts?.echoThreshold ?? DEFAULT_ECHO_THRESHOLD;
  const embed = opts?.embed;
  const anchors = (opts?.anchors ?? []).filter(Boolean);
  const items = list.filter(Boolean);
  const report = emptyDedupeReport();
  report.total = items.length;
  if (items.length === 0 || (items.length === 1 && anchors.length === 0)) {
    report.kept = items.length;
    return { kept: items, dropped: [], method: 'none', report };
  }

  const exata = exactPass(items, anchors);
  const sem = await semanticPass(exata.unique, { cosineThreshold, echoThreshold, embed, anchors });

  const kept = sem.kept;
  const dropped = [...exata.dropped, ...sem.dropped];
  report.kept = kept.length;
  report.dropped = dropped.length;
  report.exactDropped = exata.dropped.length;
  report.semanticDropped = sem.dropped.length;
  report.anchorDropped = exata.anchorHits + sem.anchorHits;
  report.templateEcho = sem.templateEcho;
  report.rate = report.total > 0 ? report.dropped / report.total : 0;
  report.alert = report.rate > report.alertRate;
  const method = sem.dropped.length > 0 ? 'semantic' : exata.dropped.length > 0 ? 'exact' : 'none';
  return { kept, dropped, method, report };
}

/**
 * Versão SÍNCRONA (sem embeddings): passe exata pelo par + relatório de eco de
 * template pela pergunta. Compatível com o uso legado de `dedupeAdvanced`; a
 * camada semântica é `dedupeSemantic` (R-05:REC-7).
 */
export function dedupeAdvanced<T extends { question: string }>(
  list: T[],
  opts?: DedupeOptions,
): DedupeResult<T> {
  const echoThreshold = opts?.echoThreshold ?? DEFAULT_ECHO_THRESHOLD;
  const anchors = (opts?.anchors ?? []).filter(Boolean);
  const items = list.filter(Boolean);
  const report = emptyDedupeReport();
  report.total = items.length;
  if (items.length === 0 || (items.length === 1 && anchors.length === 0)) {
    report.kept = items.length;
    return { kept: items, dropped: [], method: 'none', report };
  }

  const exata = exactPass(items, anchors);
  let templateEcho = 0;
  for (let i = 0; i < exata.unique.length; i += 1) {
    for (let j = i + 1; j < exata.unique.length; j += 1) {
      if (rougeL(exata.unique[i].question, exata.unique[j].question) >= echoThreshold) templateEcho += 1;
    }
  }
  report.kept = exata.unique.length;
  report.dropped = exata.dropped.length;
  report.exactDropped = exata.dropped.length;
  report.anchorDropped = exata.anchorHits;
  report.templateEcho = templateEcho;
  report.rate = report.total > 0 ? report.dropped / report.total : 0;
  report.alert = report.rate > report.alertRate;
  return {
    kept: exata.unique,
    dropped: exata.dropped,
    method: exata.dropped.length > 0 ? 'exact' : 'none',
    report,
  };
}
