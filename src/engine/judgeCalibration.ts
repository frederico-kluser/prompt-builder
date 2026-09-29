// Calibração do juiz: mede e ANCORA (pin) o contrato de quem julga.
//
// POR QUE existe: juiz LLM tem três vícios que distorcem o placar direto:
//   (a) viés de VERBOSIDADE — respostas mais longas pontuam mais mesmo em
//       qualidade igual; `verbosityReport` mede a correlação score×comprimento
//       e manda reportar na metodologia quando ela é relevante;
//   (b) calibration drift — a MESMA rúbrica pontua com distribuição diferente
//       quando o modelo do juiz é atualizado; `pinJudgeContract` grava o hash do
//       contrato (juízes + rúbrica) na run para a mudança de distribuição ser
//       atribuível à troca de juiz e não a "o prompt piorou";
//   (c) amostra pequena não sustenta conclusão — n<10 por variante é sinal,
//       não prova (`sampleSizeWarning`), e médias só ganham intervalo com n>=5
//       (`meanCi95`).
//
// Módulo PURO (sem `node:`/fetch/fs): roda no servidor, no CLI e no bundle do
// navegador (modo client-side) sem adaptação — os dois motores importam daqui.
//
// ---------------------------------------------------------------------------
// DECISÃO NEGATIVA DOCUMENTADA (R-08:REC-6, IMPL-116) — VETO DE CACHE SEMÂNTICO
// DE VEREDITOS.
//
// NENHUM caminho de avaliação pode REUSAR vereditos por similaridade semântica
// (embeddings/vetores/cosseno/limiar de parecença). Motivo medido: 3–7% de
// falsos positivos nos limiares úteis ("sort an array" vs "sort an array in
// descending order" ficam a 0,94 de similaridade) = veredito reusado errado — a
// MESMA gravidade de um estouro de orçamento: nota inventada com cara de medida.
// O reuso só existe por IGUALDADE EXATA de conteúdo (hash do pedido/contrato —
// item R-08:REC-3), nunca por parecença. O arch test que reprova qualquer
// tentativa é `test/estimate-cache-veto.test.ts`.
// ---------------------------------------------------------------------------

import type {
  JudgeContractComponents,
  JudgeVote,
  Verdict,
  VerdictError,
  VerdictErrorKind,
  VerdictSampleSource,
  VerdictSource,
  VerbosityDiag,
} from '../types.js';
import { isControlSignal } from '../budget.js';
import { JUDGE_TEMPERATURE } from './judgeRetry.js';

/** Par observado (uma resposta julgada): score do juiz × tamanho da resposta. */
export interface CalibrationSample {
  score: number;   // score normalizado 0–1 (ex.: judge-score ÷100)
  /**
   * Tamanho da resposta REGREDIDO (IMPL-052): razão de tokens
   * candidato/referência quando há medição; caracteres só como fallback (sem
   * tokenizer no bundle). Só a ordem importa para a correlação.
   */
  length: number;
  /** Fonte (papel) do veredito (IMPL-052) — papéis de calibração distinta nunca partilham regressão. */
  source?: VerdictSampleSource;
  /** Contestant da amostra (IMPL-052) — a célula do diagnóstico é fonte × contestant. */
  contestantId?: string;
  /**
   * `suspeito_de_truncamento` (IMPL-052): a resposta atingiu ≥95% do teto de
   * tokens ou saiu cortada — o comprimento dela é ARTEFATO do corte, não do
   * estilo do candidato. Marcada aqui e FORA da regressão.
   */
  suspectTruncation?: boolean;
  /**
   * Cenário da amostra (IMPL-053) — o efeito fixo do cenário controla o
   * confundidor de dificuldade. Ausente = amostra legada (grupo único).
   */
  scenarioId?: string;
  /**
   * `log(len_cand/len_ref)` já calculado (IMPL-053): o preditor de comprimento
   * RELATIVO da regressão ordinal. Ausente = sem referência medível (a amostra
   * não entra na regressão — tamanho bruto não é razão).
   */
  logLenRel?: number;
  /** Feitos de markdown do texto do candidato (IMPL-053) — os `markdown_feats`. */
  mdFeats?: MarkdownFeatCounts;
}

/** Feitos de markdown contados no texto do candidato (IMPL-053). */
export interface MarkdownFeatCounts {
  /** Títulos (`#`…`######`). */
  heading: number;
  /** Itens de lista (`-`/`*`/`1.`). */
  list: number;
  /** Ênfase (`**negrito**`, `*itálico*`, `_…_`). */
  emphasis: number;
  /** Trechos/cercas de código. */
  code: number;
  /** Links `[texto](url)`. */
  link: number;
}

/**
 * Linha de entrada do diagnóstico de verbosidade (IMPL-052): uma resposta
 * julgada com tudo o que a higiene precisa — fonte do veredito, tokens medidos
 * (candidato e referência), teto de saída e sinais de corte. Os dois
 * orquestradores montam estas linhas a partir do `StageRecord`.
 */
export interface VerbositySampleRow {
  contestantId: string;
  /** Fonte (papel) do veredito: pointwise/rótulo/listwise/imputado. */
  source: VerdictSampleSource;
  /** Score 0–1 do veredito (resolve 1, parcial 0.5, nao 0). */
  score: number;
  /** Texto da resposta do candidato. */
  text: string;
  /** `completion_tokens` medidos do candidato (0/ausente = sem medição). */
  candidateTokens?: number;
  /** Texto da referência (gabarito) da etapa — fallback em caracteres. */
  referenceText?: string;
  /** `completion_tokens` medidos da referência (chamada do gabarito). */
  referenceTokens?: number;
  /** Teto de `max_tokens` do candidato (contra o qual o corte é medido). */
  maxTokens?: number;
  /** A resposta saiu cortada no teto (IMPL-014/IMPL-015). */
  truncated?: boolean;
  /**
   * Cenário (etapa) da resposta (IMPL-053): alimenta o efeito fixo do cenário
   * da regressão ordinal e a permutação "dentro do cenário". Ausente = amostra
   * legada (tratada como um único grupo).
   */
  scenarioId?: string;
}

/** Fração do teto de tokens a partir da qual a resposta é SUSPEITA de truncamento. */
export const TRUNCATION_SUSPECT_RATE = 0.95;

/**
 * Mapeia respostas julgadas em amostras de calibração, MARCANDO a higiene
 * (IMPL-052) em vez de misturar tudo: comprimento em tokens (razão
 * candidato/referência; caracteres só como fallback), `suspectTruncation` em
 * quem atingiu ≥95% do teto de tokens ou saiu cortado. A EXCLUSÃO da regressão
 * acontece em `verbosityReport`, que publica n por fonte/célula e a conta de
 * excluídos por motivo.
 */
export function verbositySamples(rows: VerbositySampleRow[]): CalibrationSample[] {
  return rows.map((row) => {
    const tokensCand = row.candidateTokens ?? 0;
    const tokensRef = row.referenceTokens ?? 0;
    const maxTokens = row.maxTokens ?? 0;
    const suspectTruncation =
      row.truncated === true ||
      (tokensCand > 0 && maxTokens > 0 && tokensCand >= TRUNCATION_SUSPECT_RATE * maxTokens);
    // Comprimento em TOKENS com razão candidato/referência (a referência
    // "desincha" candidatos prolixos numa etapa de gabarito curto); sem
    // medição em qualquer dos lados cai para a razão em CARACTERES — e sem
    // referência, o tamanho bruto. Só a ordem importa para o Pearson.
    // Resposta VAZIA (só espaços incluído) fica com length 0 — o `verbosityReport`
    // a exclui como `vazios` antes de qualquer conta.
    const textoVazio = !row.text?.trim();
    // A razão candidato/referência SÓ existe quando há referência medível; sem
    // ela o `length` é tamanho bruto e não serve de preditor relativo (IMPL-053
    // regrediu log(len_cand/len_ref) — ver `logLenRel` abaixo).
    const temReferencia = tokensCand > 0 && tokensRef > 0 ? true : Boolean(row.referenceText?.trim());
    const length = textoVazio
      ? 0
      : tokensCand > 0 && tokensRef > 0
        ? tokensCand / tokensRef
        : row.referenceText?.trim()
          ? row.text.length / Math.max(1, row.referenceText.trim().length)
          : row.text.length;
    return {
      score: row.score,
      length,
      source: row.source,
      contestantId: row.contestantId,
      suspectTruncation,
      scenarioId: row.scenarioId,
      logLenRel: !textoVazio && temReferencia && length > 0 ? Math.log(length) : undefined,
      mdFeats: markdownFeatCounts(row.text),
    };
  });
}

/**
 * Conta feitos de markdown do texto do candidato (IMPL-053): são os
 * `markdown_feats` da regressão ordinal — o juiz tende a pontuar melhor texto
 * "bonito" (títulos, listas, negrito) mesmo em qualidade igual, e sem
 * controlar por eles o efeito do comprimento ficava inflado pelo enfeite.
 */
export function markdownFeatCounts(text: string): MarkdownFeatCounts {
  const t = text ?? '';
  return {
    heading: (t.match(/^#{1,6}\s+\S/gm) ?? []).length,
    list: (t.match(/^(?:[-*+]\s+\S|\d+[.)]\s+\S)/gm) ?? []).length,
    emphasis: (t.match(/\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_/g) ?? []).length,
    code: (t.match(/```[\s\S]*?```|`[^`\n]+`/g) ?? []).length,
    link: (t.match(/\[[^\]\n]+\]\([^)\n]+\)/g) ?? []).length,
  };
}

/**
 * Relatório de viés de verbosidade (IMPL-052 estendeu: higiene das amostras +
 * segregação por papel). Só amostras VÁLIDAS da fonte-alvo entram em `n`/`r`.
 */
export interface VerbosityReport {
  /** n de amostras VÁLIDAS da fonte-alvo (as únicas na regressão). */
  n: number;
  /** Correlação de Pearson entre score e comprimento da fonte-alvo (−1..1). */
  r: number;
  /**
   * true quando |r| ≥ 0.3 com n ≥ 10. ⚠️ DESCRITIVO desde o IMPL-053 (R-03b:REC-1):
   * o Pearson agregado é legenda, não diagnóstico — sem efeito fixo de cenário,
   * sem inferência e sem sondas. O diagnóstico de viés vive em `verbosityDiag`
   * (efeito + incerteza + n); `biased` só decide se a legenda aparece.
   */
  biased: boolean;
  /** Aviso curto em PT-BR (vazio quando sem evidência). */
  warning: string;
  /** Fonte (papel) ALVO da regressão — nenhum outro papel entra no cálculo. */
  alvo?: VerdictSampleSource;
  /** n de amostras VÁLIDAS por fonte de veredito. */
  nPorFonte?: Record<string, number>;
  /** n de amostras VÁLIDAS por célula (fonte × contestant). */
  nPorCelula?: Record<string, number>;
  /**
   * Amostras EXCLUÍDAS da regressão por motivo (IMPL-052): vazios (tamanho 0),
   * truncados (`suspeito_de_truncamento`: ≥95% do teto ou corte declarado) e
   * imputados (veredito 'auto' fabricado pela regra, não pelo juiz).
   */
  excluidos?: { vazios: number; truncados: number; imputados: number };
  /**
   * Diagnóstico em CAMADAS (IMPL-053): regressão ordinal + permutação dentro
   * do cenário + sondas contrafactuais + nota LC auxiliar. Publicado junto do
   * relatório (a chamada do orquestrador já o carrega para o record); ausente
   * quando o n não sustenta o ajuste.
   */
  verbosityDiag?: VerbosityDiag;
}

/** |r| mínimo para considerar o viés relevante (correlação moderada já desloca o placar). */
const BIAS_THRESHOLD = 0.3;

/** n mínimo por variante/grupo para afirmar qualquer coisa sobre o juiz. */
const MIN_SAMPLES = 10;

/**
 * Piso de amostra para estimar intervalo. Mesmo piso de `pairedSignificance` e
 * `MIN_HOLDOUT_SCENARIOS`: abaixo disso o intervalo é fantasia.
 */
const MIN_CI_SAMPLES = 5;

/** Resamples do bootstrap — mesmo número do bootstrap pareado de `stats.ts`. */
const BOOTSTRAP_ITERATIONS = 2000;

/**
 * Correlação de Pearson score×comprimento. n<2 ou variância zero → r=0.
 *
 * Variância zero em QUALQUER eixo deixa a correlação indefinida (0/0);
 * devolvemos 0 em vez de NaN porque 0 significa "sem evidência de viés" e um
 * NaN contaminaria o report, a UI e qualquer comparação downstream.
 */
export function pearsonCorrelation(samples: CalibrationSample[]): number {
  const n = samples.length;
  if (n < 2) return 0;
  let sumLength = 0;
  let sumScore = 0;
  for (const s of samples) {
    sumLength += s.length;
    sumScore += s.score;
  }
  const meanLength = sumLength / n;
  const meanScore = sumScore / n;
  let cov = 0;
  let varLength = 0;
  let varScore = 0;
  for (const s of samples) {
    const dLength = s.length - meanLength;
    const dScore = s.score - meanScore;
    cov += dLength * dScore;
    varLength += dLength * dLength;
    varScore += dScore * dScore;
  }
  if (varLength === 0 || varScore === 0) return 0;
  const r = cov / Math.sqrt(varLength * varScore);
  // Clamp: em série perfeitamente linear o erro de ponto flutuante devolve
  // algo como 1.0000000000000002, que violaria a garantia r ∈ [−1, 1].
  return Math.min(1, Math.max(-1, r));
}

/**
 * Relatório de verbosidade: higiene + regressão POR PAPEL (IMPL-052).
 *
 * Antes o cálculo misturava pointwise, listwise e rótulo na mesma regressão,
 * contava vereditos imputados ('auto' de resposta vazia — comprimento 0) e
 * respostas cortadas sem marcar: tudo viesando o r. Agora:
 *   1) exclui vazios (length ≤ 0), imputados (fonte 'imputado') e suspeitos de
 *      truncamento (`suspectTruncation`), contando cada motivo em `excluidos`;
 *   2) segrega por fonte e regrediu SÓ a fonte-alvo (prioridade pointwise >
 *      listwise > rótulo — o papel dominante da run; amostras sem `source`
 *      contam como pointwise, o caminho legado);
 *   3) publica n por fonte e por célula (fonte × contestant).
 *
 * O aviso existe só quando `biased` acende (|r| alto com n suficiente) e, desde
 * o IMPL-053, é LEGENDA DESCRITIVA: o Pearson agregado não tem efeito fixo de
 * cenário, não tem inferência nem sondas — acusar "viés detectado" a partir
 * dele era o anti-padrão que a auditoria (R-03b:REC-1) derrubou. O diagnóstico
 * é `verbosityDiag` (efeito + incerteza + n), publicado junto.
 */
export function verbosityReport(
  samples: CalibrationSample[],
  opts?: VerbosityDiagOptions,
): VerbosityReport {
  // ---------------------------------------------------------------- higiene
  const excluidos = { vazios: 0, truncados: 0, imputados: 0 };
  const validas: CalibrationSample[] = [];
  for (const s of samples) {
    // Precedência do motivo: vazio antes de imputado antes de truncado.
    if (!Number.isFinite(s.length) || s.length <= 0) {
      excluidos.vazios += 1;
      continue;
    }
    if (s.source === 'imputado') {
      excluidos.imputados += 1;
      continue;
    }
    if (s.suspectTruncation) {
      excluidos.truncados += 1;
      continue;
    }
    validas.push(s);
  }

  // -------------------------------------------------- segregação por papel
  const fonteDe = (s: CalibrationSample): VerdictSampleSource => s.source ?? 'pointwise';
  const porFonte = new Map<VerdictSampleSource, CalibrationSample[]>();
  for (const s of validas) {
    const f = fonteDe(s);
    const lista = porFonte.get(f);
    if (lista) lista.push(s);
    else porFonte.set(f, [s]);
  }
  // Fonte-alvo por prioridade. NENHUM papel de calibração distinta entra na
  // regressão de outro (um juiz pointwise e um listwise não são o mesmo
  // instrumento — somá-los é medir dois vícios com uma régua só).
  const alvo = (['pointwise', 'listwise', 'rotulo'] as const).find((f) => porFonte.has(f));
  const alvoSamples = alvo ? porFonte.get(alvo)! : [];
  const n = alvoSamples.length;
  const r = pearsonCorrelation(alvoSamples);
  // |r| >= 0.3 já desloca ranking/placar; exigir n >= 10 evita acusar viés em
  // ruído de amostra pequena (item (c) da abertura deste arquivo).
  const biased = n >= MIN_SAMPLES && Math.abs(r) >= BIAS_THRESHOLD;

  const nPorFonte: Record<string, number> = {};
  for (const [f, lista] of porFonte) nPorFonte[f] = lista.length;
  const nPorCelula: Record<string, number> = {};
  for (const s of validas) {
    if (!s.contestantId) continue;
    const celula = `${fonteDe(s)}×${s.contestantId}`;
    nPorCelula[celula] = (nPorCelula[celula] ?? 0) + 1;
  }

  // Diagnóstico em camadas (IMPL-053): sai junto do relatório para o record
  // publicar efeito + incerteza + n sem uma segunda montagem no orquestrador.
  const diag = verbosityDiag(samples, opts);
  return {
    n,
    r,
    biased,
    // LEGENDA descritiva (IMPL-053): o Pearson deixou de aparecer como
    // "viés detectado" — sem efeito fixo de cenário ele não diagnostica nada.
    warning: biased
      ? `verbosidade — legenda descritiva (Pearson agregado, sem efeito fixo de cenário): r=${r.toFixed(2)}, n=${n}, papel=${alvo ?? 'pointwise'}; correlação score×comprimento NÃO é diagnóstico de viés — quem diagnostica é o verbosityDiag (efeito + incerteza + n por permutação).`
      : '',
    alvo,
    nPorFonte,
    nPorCelula,
    excluidos,
    ...(diag ? { verbosityDiag: diag } : {}),
  };
}

// ----------------------------------------------------------------------------
// IMPL-053 (R-03b:REC-1) — diagnóstico de verbosidade em CAMADAS.
//
// O Pearson agregado (acima) virou LEGENDA: nenhuma ferramenta ou paper de
// referência usa Pearson agregado como diagnóstico — sem efeito fixo de
// cenário (confundidor de dificuldade), sem inferência para n pequeno e sem
// sondas contrafactuais, o resultado era um warning único no lugar de
// efeito + incerteza + n. O diagnóstico aqui tem 4 camadas:
//   1) REGRESSÃO ORDINAL (logit de probabilidades acumuladas, proporcional):
//      veredito ~ log(len_cand/len_ref) + markdown_feats + FE(cenário) +
//      FE(contestant) — o efeito de comprimento controlado por tudo isso;
//   2) INFERÊNCIA POR PERMUTAÇÃO do veredito DENTRO do cenário (n pequeno não
//      sustenta assintótica) + IC 95% por bootstrap estratificado por cenário;
//   3) SONDAS contrafactuais (truncar/preencher 20% e re-julgar) medindo a
//      taxa de INVERSÃO de veredito — bom < 10%;
//   4) `judgeScoreLC`: nota AUXILIAR por contestant com o comprimento fixado
//      na mediana (o judge-score bruto permanece primário).
// A regressão é um logit ORDINAL de verdade (verossimilhança multinomial de
// McCullagh, slopes comuns = odds proporcionais), ajustada por gradiente
// projetado determinístico — a permutação recalibra o p mesmo que o ajuste não
// atinja o ótimo exato.
// ----------------------------------------------------------------------------

/** Opções do diagnóstico de verbosidade (IMPL-053). */
export interface VerbosityDiagOptions {
  /** Pares (original, sonda) já re-julgados — a taxa de inversão sai daqui. */
  probes?: CounterfactualProbePair[];
  /** Rondas de permutação (default 100 ⇒ p mínimo 1/101). */
  permutations?: number;
  /** Resamples do bootstrap do IC (default 100). */
  bootstrap?: number;
  /** Seed do PRNG (default 1337 — mesma família do resto do módulo). */
  seed?: number;
}

/** n mínimo de amostras de regressão para afirmar qualquer efeito. */
const MIN_DIAG_SAMPLES = 10;
/** Rondas de permutação por default (p mínimo 1/(B+1)). */
const DEFAULT_PERMUTATIONS = 100;
/** Resamples do bootstrap por default. */
const DEFAULT_BOOTSTRAP = 100;

/** Colunas contínuas do desenho da regressão, nesta ordem (a 0 é o alvo). */
const CONTINUOUS_COLS = ['logLenRel', 'md.heading', 'md.list', 'md.emphasis', 'md.code', 'md.link'] as const;

/** Veredito ordinal a partir do score 0–1 (resolve 1, parcial 0.5, nao 0). */
function ordinalOfScore(score: number): 0 | 1 | 2 {
  return score >= 2 / 3 ? 2 : score >= 1 / 3 ? 1 : 0;
}

/** Veredito (rótulo) a partir do score 0–1 — para as sondas compararem. */
export function verdictOfScore(score: number): Verdict {
  return ordinalOfScore(score) === 2 ? 'resolve' : ordinalOfScore(score) === 1 ? 'parcial' : 'nao';
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/** Amostras VÁLIDAS + contagem por fonte (higiene comum do relatório e do diag). */
function hygiene(samples: CalibrationSample[]): {
  validas: CalibrationSample[];
  nPorFonte: Record<string, number>;
} {
  const validas: CalibrationSample[] = [];
  const nPorFonte: Record<string, number> = {};
  for (const s of samples) {
    if (!Number.isFinite(s.length) || s.length <= 0) continue;
    if (s.source === 'imputado') continue;
    if (s.suspectTruncation) continue;
    validas.push(s);
    const f = s.source ?? 'pointwise';
    nPorFonte[f] = (nPorFonte[f] ?? 0) + 1;
  }
  return { validas, nPorFonte };
}

/** Ajuste do logit ordinal (proporcional) por gradiente projetado determinístico. */
interface OrdinalFit {
  /** Coeficientes nas colunas PADRONIZADAS. */
  betaStd: number[];
  /** Cortes θ1 < θ2 do logit acumulado. */
  theta: [number, number];
}

function fitOrdinalLogit(
  X: number[][],
  y: number[],
  start?: OrdinalFit,
  ridge = 1e-3,
): OrdinalFit | null {
  const n = y.length;
  const d = X[0]?.length ?? 0;
  if (n === 0 || d === 0) return null;
  const logit = (p: number): number => Math.log(p / (1 - p));
  const c0 = Math.min(0.99, Math.max(0.01, y.filter((v) => v <= 0).length / n));
  const c1 = Math.min(0.99, Math.max(0.01, y.filter((v) => v <= 1).length / n));
  let beta: number[] = start && start.betaStd.length === d ? [...start.betaStd] : new Array(d).fill(0);
  let theta: [number, number] =
    start && start.betaStd.length === d
      ? [start.theta[0], start.theta[1]]
      : [logit(c0), Math.max(logit(c0) + 1e-3, logit(c1))];
  const project = (t: [number, number]): [number, number] =>
    t[1] >= t[0] + 1e-4 ? t : [t[0], t[0] + 1e-4];
  theta = project(theta);

  const evaluate = (
    b: number[],
    t: [number, number],
  ): { ll: number; gB: number[]; gT: [number, number] } => {
    const gB = new Array(d).fill(0);
    let gT1 = 0;
    let gT2 = 0;
    let ll = 0;
    for (let i = 0; i < n; i += 1) {
      const xi = X[i];
      let eta = 0;
      for (let j = 0; j < d; j += 1) eta += b[j] * xi[j];
      const s1 = sigmoid(t[0] - eta);
      const s2 = sigmoid(t[1] - eta);
      const yi = y[i];
      let p: number;
      let dEta: number;
      let dT1: number;
      let dT2: number;
      if (yi <= 0) {
        p = Math.max(s1, 1e-12);
        dEta = -(1 - s1);
        dT1 = 1 - s1;
        dT2 = 0;
      } else if (yi === 1) {
        const gap = Math.max(s2 - s1, 1e-12);
        p = gap;
        dEta = (s1 * (1 - s1) - s2 * (1 - s2)) / gap;
        dT1 = (-s1 * (1 - s1)) / gap;
        dT2 = (s2 * (1 - s2)) / gap;
      } else {
        p = Math.max(1 - s2, 1e-12);
        dEta = s2;
        dT1 = 0;
        dT2 = -s2;
      }
      ll += Math.log(p);
      for (let j = 0; j < d; j += 1) gB[j] += dEta * xi[j];
      gT1 += dT1;
      gT2 += dT2;
    }
    // Ridge pequeno SÓ nos slopes (separação/perfeição não pode estourar beta).
    for (let j = 0; j < d; j += 1) {
      ll -= ridge * b[j] * b[j];
      gB[j] -= 2 * ridge * b[j];
    }
    return { ll, gB, gT: [gT1, gT2] as [number, number] };
  };

  let cur = evaluate(beta, theta);
  let step = 1 / Math.max(1, n);
  for (let iter = 0; iter < 400; iter += 1) {
    let gmax = 0;
    for (const g of cur.gB) gmax = Math.max(gmax, Math.abs(g));
    gmax = Math.max(gmax, Math.abs(cur.gT[0]), Math.abs(cur.gT[1]));
    if (gmax < 1e-7) break;
    let melhorou = false;
    for (let tentativa = 0; tentativa < 26; tentativa += 1) {
      const b2 = beta.map((v, j) => v + step * cur.gB[j]);
      const t2 = project([theta[0] + step * cur.gT[0], theta[1] + step * cur.gT[1]]);
      const nxt = evaluate(b2, t2);
      if (nxt.ll > cur.ll) {
        beta = b2;
        theta = t2;
        cur = nxt;
        step *= 1.3;
        melhorou = true;
        break;
      }
      step *= 0.5;
    }
    if (!melhorou) break;
  }
  return { betaStd: beta, theta };
}

/** P(y = 0/1/2) do logit ordinal para um x padronizado. */
function ordinalProbs(fit: OrdinalFit, xStd: number[]): [number, number, number] {
  let eta = 0;
  for (let j = 0; j < xStd.length; j += 1) eta += fit.betaStd[j] * xStd[j];
  const s1 = sigmoid(fit.theta[0] - eta);
  const s2 = sigmoid(fit.theta[1] - eta);
  return [s1, Math.max(0, s2 - s1), 1 - s2];
}

/**
 * Diagnóstico de verbosidade em camadas (IMPL-053). Devolve `null` quando o n
 * não sustenta a regressão (< 10 amostras válidas com referência medível, sem
 * variação de veredito ou de comprimento) — efeito sem amostra seria inventado.
 */
export function verbosityDiag(
  samples: CalibrationSample[],
  opts: VerbosityDiagOptions = {},
): VerbosityDiag | null {
  const { validas, nPorFonte } = hygiene(samples);
  const taxaInversaoSondas = probeInversionRate(opts.probes ?? []);
  // Sem amostra não há diagnóstico: abaixo devolvemos `null` — nunca números
  // fabricados para preencher os campos.

  // Conjunto de regressão: fonte-alvo (mesma política do relatório) + preditor
  // de comprimento RELATIVO medível (sem referência não há log(len_cand/len_ref)).
  const fonteDe = (s: CalibrationSample): VerdictSampleSource => s.source ?? 'pointwise';
  const alvo = (['pointwise', 'listwise', 'rotulo'] as const).find((f) =>
    validas.some((s) => fonteDe(s) === f),
  );
  const reg = validas.filter(
    (s) =>
      fonteDe(s) === (alvo ?? 'pointwise') &&
      s.logLenRel !== undefined &&
      Number.isFinite(s.logLenRel) &&
      Number.isFinite(s.score),
  );
  const niveis = new Set(reg.map((s) => ordinalOfScore(s.score)));
  if (reg.length < MIN_DIAG_SAMPLES || niveis.size < 2) return null;

  // ---- desenho: logLenRel + markdown_feats + FE(cenário) + FE(contestant)
  const cont: number[][] = reg.map((s) => [
    s.logLenRel!,
    s.mdFeats?.heading ?? 0,
    s.mdFeats?.list ?? 0,
    s.mdFeats?.emphasis ?? 0,
    s.mdFeats?.code ?? 0,
    s.mdFeats?.link ?? 0,
  ]);
  const scenKeys = [...new Set(reg.map((s) => s.scenarioId ?? ''))].sort();
  const contKeys = [...new Set(reg.map((s) => s.contestantId ?? ''))].sort();
  const dummies: Array<{ key: string; values: number[] }> = [];
  for (const k of scenKeys.slice(1)) dummies.push({ key: `scn:${k}`, values: reg.map((s) => (s.scenarioId ?? '') === k ? 1 : 0) });
  for (const k of contKeys.slice(1)) dummies.push({ key: `cst:${k}`, values: reg.map((s) => (s.contestantId ?? '') === k ? 1 : 0) });

  const cols: Array<{ nome: string; values: number[] }> = [
    ...CONTINUOUS_COLS.map((nome, j) => ({ nome, values: cont.map((row) => row[j]) })),
    ...dummies.map((dm) => ({ nome: dm.key, values: dm.values })),
  ];
  // Descarta colunas degeneradas (sem variação não há coeficiente).
  const kept = cols.filter((c) => c.values.some((v) => v !== c.values[0]));
  const lenCol = kept.findIndex((c) => c.nome === 'logLenRel');
  if (lenCol < 0) return null; // comprimento constante ⇒ sem efeito medível
  const mean = kept.map((c) => c.values.reduce((a, b) => a + b, 0) / c.values.length);
  const sd = kept.map((c, j) => {
    const v = c.values.reduce((a, b) => a + (b - mean[j]) ** 2, 0) / c.values.length;
    return Math.sqrt(v) || 1;
  });
  const X = reg.map((_, i) => kept.map((c, j) => (c.values[i] - mean[j]) / sd[j]));
  const y = reg.map((s) => ordinalOfScore(s.score));

  const fit = fitOrdinalLogit(X, y);
  if (!fit) return null;
  // beta em escala ORIGINAL: x_padronizado = (x − média)/sd ⇒ slope bruto = b/sd.
  const betaLenRel = fit.betaStd[lenCol] / sd[lenCol];

  // ---- grupos de cenário (bootstrap estratificado + permutação DENTRO do cenário)
  const grupos = new Map<string, number[]>();
  reg.forEach((s, i) => {
    const k = s.scenarioId ?? '';
    const lista = grupos.get(k);
    if (lista) lista.push(i);
    else grupos.set(k, [i]);
  });
  const gruposIdx = [...grupos.values()];

  const seed = opts.seed ?? 1337;
  const BBoot = Math.max(0, opts.bootstrap ?? DEFAULT_BOOTSTRAP);
  const boot: number[] = [];
  const rngB = mulberry32(seed + 1);
  for (let b = 0; b < BBoot; b += 1) {
    const idx: number[] = [];
    for (const g of gruposIdx) {
      for (let k = 0; k < g.length; k += 1) idx.push(g[Math.floor(rngB() * g.length)]);
    }
    const fb = fitOrdinalLogit(idx.map((i) => X[i]), idx.map((i) => y[i]), fit);
    if (fb) boot.push(fb.betaStd[lenCol] / sd[lenCol]);
  }
  boot.sort((a, b) => a - b);
  const quantil = (p: number): number =>
    boot.length > 0 ? boot[Math.min(boot.length - 1, Math.max(0, Math.floor(p * boot.length)))] : betaLenRel;
  const ic95: [number, number] = boot.length >= 20 ? [quantil(0.025), quantil(0.975)] : [betaLenRel, betaLenRel];

  const BPerm = Math.max(1, opts.permutations ?? DEFAULT_PERMUTATIONS);
  const rngP = mulberry32(seed + 2);
  const yPerm = [...y];
  let extremos = 0;
  for (let b = 0; b < BPerm; b += 1) {
    // Permuta os VEREDITOS dentro de cada cenário: a dificuldade do cenário
    // fica, o elo comprimento→veredito é que é quebrado (hipótese nula).
    for (const g of gruposIdx) {
      const vals = g.map((i) => yPerm[i]);
      for (let k = vals.length - 1; k > 0; k -= 1) {
        const j = Math.floor(rngP() * (k + 1));
        [vals[k], vals[j]] = [vals[j], vals[k]];
      }
      g.forEach((i, k) => {
        yPerm[i] = vals[k];
      });
    }
    const fp = fitOrdinalLogit(X, yPerm, fit);
    if (fp && Math.abs(fp.betaStd[lenCol] / sd[lenCol]) >= Math.abs(betaLenRel)) extremos += 1;
  }
  const pPermutacao = (1 + extremos) / (BPerm + 1);

  // ---- judgeScoreLC AUXILIAR: score predito com o comprimento fixado na MEDIANA
  const medianas = reg.map((s) => s.logLenRel!).sort((a, b) => a - b);
  const mediana = medianas[Math.floor(medianas.length / 2)];
  const xLenMediana = (mediana - mean[lenCol]) / sd[lenCol];
  const somaLC = new Map<string, { soma: number; n: number }>();
  reg.forEach((s, i) => {
    const xStd = [...X[i]];
    xStd[lenCol] = xLenMediana;
    const [p0, p1, p2] = ordinalProbs(fit, xStd);
    const scoreLC = 0.5 * p1 + p2; // E[score 0/0.5/1]
    const chave = s.contestantId ?? '';
    const acc = somaLC.get(chave);
    if (acc) {
      acc.soma += scoreLC;
      acc.n += 1;
    } else somaLC.set(chave, { soma: scoreLC, n: 1 });
  });
  const judgeScoreLC: Record<string, number> = {};
  for (const [chave, acc] of somaLC) judgeScoreLC[chave] = Number(((acc.soma / acc.n) * 100).toFixed(2));

  return {
    betaLenRel: Number(betaLenRel.toFixed(6)),
    ic95: [Number(ic95[0].toFixed(6)), Number(ic95[1].toFixed(6))],
    pPermutacao: Number(pPermutacao.toFixed(4)),
    nPorFonte,
    taxaInversaoSondas,
    judgeScoreLC: Object.keys(judgeScoreLC).length > 0 ? judgeScoreLC : null,
  };
}

// ----------------------------------------------------------------------------
// Sondas contrafactuais (IMPL-053): truncar/preencher 20% das respostas e
// RE-JULGAR. A taxa de inversão é o sinal causal de verbosidade — se uma
// manipulação SÓ de comprimento muda o veredito, o juiz está lendo tamanho.
// O re-julgamento é assíncrono (chamada de LLM): o juiz é INJETADO (`rejudge`)
// para este módulo continuar puro e testável sem gateway.
// ----------------------------------------------------------------------------

/** Manipulação de comprimento da sonda: cortar ou preencher 20%. */
export type ProbeMode = 'truncar' | 'preencher';

/** Par (original, sonda) re-julgado — a taxa de inversão sai daqui. */
export interface CounterfactualProbePair {
  contestantId: string;
  scenarioId?: string;
  mode: ProbeMode;
  /** Veredito original (já julgado antes da manipulação). */
  originalVerdict: Verdict;
  /** Veredito da versão manipulada; `null` = re-julgamento falhou (fora da taxa). */
  probeVerdict: Verdict | null;
}

/**
 * Texto manipulado da sonda: `truncar` corta a CAUDA até restarem 80% dos
 * caracteres; `preencher` cresce 20% com preenchimento NEUTRO (reticências) —
 * nenhum dos dois acrescenta nem tira conteúdo semântico novo de propósito.
 */
export function buildCounterfactualText(text: string, mode: ProbeMode, rate = 0.2): string {
  const t = text ?? '';
  if (!t) return t;
  if (mode === 'truncar') {
    return t.slice(0, Math.max(1, Math.floor(t.length * (1 - rate)))).trimEnd();
  }
  const alvo = Math.max(1, Math.round(t.length * rate));
  return `${t}${'\n'}${'…'.repeat(alvo)}`;
}

/**
 * Seleciona as sondas: `rate` (default 20%) das respostas julgáveis, com o
 * modo alternando deterministicamente entre `preencher` e `truncar`. Escolha
 * embaralhada com seed fixa ⇒ o mesmo run reproduz as mesmas sondas.
 */
export function selectCounterfactualProbes(
  rows: VerbositySampleRow[],
  rate = 0.2,
  seed = 1337,
): Array<{ row: VerbositySampleRow; mode: ProbeMode }> {
  const elegiveis = rows.filter((r) => r.text?.trim() && r.source !== 'imputado');
  const n = Math.max(1, Math.round(elegiveis.length * rate));
  const ordem = elegiveis.map((_, i) => i);
  const rng = mulberry32(seed);
  for (let k = ordem.length - 1; k > 0; k -= 1) {
    const j = Math.floor(rng() * (k + 1));
    [ordem[k], ordem[j]] = [ordem[j], ordem[k]];
  }
  return ordem.slice(0, n).map((idx, k) => ({
    row: elegiveis[idx],
    mode: k % 2 === 0 ? 'preencher' : 'truncar',
  }));
}

/**
 * Roda as sondas contrafactuais com o juiz INJETADO. `null` do `rejudge` =
 * falha do re-julgamento (conta como não-inversão, mas sai do denominador).
 * `BudgetExceeded`/`RunCancelled` sobem (controle, não erro).
 */
export async function runCounterfactualProbes(params: {
  rows: VerbositySampleRow[];
  rejudge: (probeText: string, row: VerbositySampleRow) => Promise<Verdict | null>;
  rate?: number;
  seed?: number;
}): Promise<CounterfactualProbePair[]> {
  const alvos = selectCounterfactualProbes(params.rows, params.rate, params.seed);
  const pares: CounterfactualProbePair[] = [];
  for (const { row, mode } of alvos) {
    const probeText = buildCounterfactualText(row.text, mode, params.rate ?? 0.2);
    let verdict: Verdict | null = null;
    try {
      verdict = await params.rejudge(probeText, row);
    } catch (err) {
      // Orçamento/cancelamento são CONTROLE (AGENTS.md): engolir aqui viraria
      // sonda "falhou" e a run seguiria gastando depois do teto.
      if (isControlSignal(err)) throw err;
      verdict = null;
    }
    pares.push({
      contestantId: row.contestantId,
      scenarioId: row.scenarioId,
      mode,
      originalVerdict: verdictOfScore(row.score),
      probeVerdict: verdict,
    });
  }
  return pares;
}

/**
 * Taxa de INVERSÃO das sondas: fração de sondas em que a manipulação só de
 * comprimento mudou o veredito (original ≠ sonda). Limiar bom < 10%. `null` =
 * nenhuma sonda re-julgada. Pares com `probeVerdict: null` (falha do
 * re-julgamento) saem do denominador — falha não é inversão.
 */
export function probeInversionRate(pairs: CounterfactualProbePair[]): number | null {
  const avaliadas = pairs.filter((p) => p.probeVerdict !== null && p.probeVerdict !== undefined);
  if (avaliadas.length === 0) return null;
  const inversoes = avaliadas.filter((p) => p.probeVerdict !== p.originalVerdict).length;
  return Number((inversoes / avaliadas.length).toFixed(4));
}

/**
 * Pin do contrato do juiz: hash estável do (modelo + texto do prompt/rúbrica).
 */
export interface JudgeContractPin {
  /** Hex 32 chars (FNV-1a 128-bit improvisado: 4 rondas de FNV-1a 32-bit com seeds distintas). */
  hash: string;
  modelIds: string[];
  pinnedAt: string; // ISO
  /**
   * Componentes usados na serialização canônica (IMPL-049): auditoria de
   * granularidade — mostra, meses depois, o QUE entrou no hash além dos ids.
   */
  components?: JudgeContractComponentsExt;
}

/**
 * Componentes do contrato MAIS a temperatura de amostragem do juízo (IMPL-117,
 * R-07b:REC-5). O contrato cobre tudo o que muda a distribuição de veredito:
 * prompts pointwise + duelo + listwise, esforço, TEMPERATURA, modelo de
 * referência e política de provedor — o que faltava era a temperatura (os
 * prompts de duelo/listwise, esforço, referência e provedor entraram no
 * IMPL-049). A extensão mora aqui (e não nos 3 espelhos de tipos) de propósito:
 * `JudgeContractComponents` continua o contrato clássico e quem chama pode
 * passar só ele — campo ausente entra vazio na serialização canônica.
 */
export interface JudgeContractComponentsExt extends JudgeContractComponents {
  /** Temperatura de amostragem efetiva das chamadas de juízo (0 no pipeline). */
  judgeTemperature?: number | string;
}

/**
 * Componentes do contrato do PIPELINE — fonte ÚNICA para o pin da run (Node e
 * SPA) e para o `baseline check` do CLI (cli#0): antes cada lado montava os
 * seus e o CLI deixava de fora o think level efetivo (o default do papel,
 * IMPL-079) — o check recalculava um hash que NENHUMA run produz e o gate de CI
 * ficava vermelho logo depois do `baseline pin` da mesma run. A temperatura
 * (IMPL-117) é a constante que os juízes realmente enviam.
 */
export function pipelineContractComponents(input: {
  duelPromptText: string;
  listwisePromptText: string;
  referenceModelId: string;
  /** Degrau EFETIVO do juiz (`reasoningLevelForRole(config.reasoning, 'judge')` — default incluso). */
  judgeReasoningLevel: string;
  providerPolicy?: string;
}): JudgeContractComponentsExt {
  return {
    duelPromptText: input.duelPromptText,
    listwisePromptText: input.listwisePromptText,
    referenceModelId: input.referenceModelId,
    judgeReasoningLevel: input.judgeReasoningLevel,
    ...(input.providerPolicy ? { providerPolicy: input.providerPolicy } : {}),
    judgeTemperature: JUDGE_TEMPERATURE,
  };
}

/**
 * Serialização canônica do contrato. Os ids são um CONJUNTO (a ordem de
 * cadastro não muda a rúbrica), então entram ordenados — dois pins do mesmo
 * contrato com juízes listados em outra ordem são o MESMO pin. O framing por
 * comprimento evita colisão ingênua entre ["ab","c"] e ["a","bc"].
 *
 * IMPL-049 (R-03a:REC-9): o contrato cobre MAIS que (juízes + prompt
 * pointwise) — também o prompt do duelo, o prompt listwise, o modelo de
 * referência, o think level de julgamento e a política de provedor. Trocar
 * qualquer componente muda a distribuição de veredito ⇒ muda o hash.
 * IMPL-117 (R-07b:REC-5): + a temperatura de amostragem do juízo. ⚠️ Isto muda
 * o hash de TODO contrato em comparação com pins gravados por versões antigas
 * (uma vez, de propósito: a mudança de julgamento que passava despercebida
 * passa a denunciar-se — custo de um falso "contrato mudou" é uma recalibração
 * a mais, o de um falso "contrato igual" é comparar instrumentos diferentes).
 * GRANULARIDADE (decisão consciente): o hash é byte a byte — mudança
 * COSMÉTICA de prompt também muda o hash e sugere recalibração. Campos
 * ausentes de `components` entram como string vazia (formado canônico único).
 */
function canonicalContract(
  modelIds: string[],
  judgePromptText: string,
  components?: JudgeContractComponentsExt,
): string {
  const ids = [...modelIds].sort();
  const partes = [
    ids.map((id) => `${id.length}:${id}`).join('\u0001'),
    judgePromptText,
    components?.duelPromptText ?? '',
    components?.listwisePromptText ?? '',
    components?.referenceModelId ?? '',
    components?.judgeReasoningLevel ?? '',
    components?.providerPolicy ?? '',
    components?.judgeTemperature === undefined ? '' : String(components.judgeTemperature),
  ];
  return partes.map((p) => `${p.length}:${p}`).join('\u0000');
}

/**
 * Hash estável do contrato do juiz (hex 32 chars): 4 rondas de FNV-1a 32-bit
 * com seeds distintas sobre a serialização canônica de (modelIds, prompt,
 * componentes).
 *
 * NÃO é criptográfico e não precisa ser: o pin só detecta MUDANÇA de contrato
 * (calibration drift), nunca autentica ninguém. Mesma entrada ⇒ mesmo hash;
 * qualquer modelo, prompt ou componente diferente ⇒ hash diferente.
 */
export function judgeContractHash(
  modelIds: string[],
  judgePromptText: string,
  components?: JudgeContractComponentsExt,
): string {
  const canonical = canonicalContract(modelIds, judgePromptText, components);
  return FNV_SEEDS.map((seed) => hex32(fnv1a32(canonical, seed))).join('');
}

/**
 * Monta o pin para gravar no record da run (transparência de calibration drift):
 * ao reler uma run antiga dá para conferir se o juiz de hoje é o de lá.
 * `now` fica no 3º lugar por compatibilidade histórica; `components` (IMPL-049
 * + IMPL-117) é o que estende o hash além de (juízes + prompt pointwise).
 */
export function pinJudgeContract(
  modelIds: string[],
  judgePromptText: string,
  now?: Date,
  components?: JudgeContractComponentsExt,
): JudgeContractPin {
  return {
    hash: judgeContractHash(modelIds, judgePromptText, components),
    modelIds: [...modelIds],
    pinnedAt: (now ?? new Date()).toISOString(),
    ...(components ? { components } : {}),
  };
}

// ----------------------------------------------------------------------------
// Drift do contrato ENTRE runs (IMPL-049) — memória do processo.
//
// O hash por run denuncia mudança ao ser comparado, mas alguém tem de COMPARAR.
// A âncora é o último pin visto neste processo (o servidor e a sessão de treino
// rodam várias runs no mesmo processo; o CLI de run única não tem anterior — aí
// quem compara é o `baseline check`/`runs show`). Quando o hash muda, o evento
// `judge.contract.changed` sugere RECALIBRAÇÃO: calibrar um contrato que vai
// mudar é desperdício (R-03a:REC-9).
// ----------------------------------------------------------------------------

let ultimoContractHash: string | undefined;

/**
 * Registra o hash do contrato desta run e devolve o aviso de drift quando ele
 * difere do último visto no processo. `changed: false` na primeira run (não há
 * anterior) e quando o contrato é o mesmo.
 */
export function noteJudgeContract(hash: string): {
  changed: boolean;
  previousHash?: string;
  message: string;
} {
  const previousHash = ultimoContractHash;
  ultimoContractHash = hash;
  if (previousHash === undefined || previousHash === hash) return { changed: false, message: '' };
  return {
    changed: true,
    previousHash,
    message:
      `o contrato do juiz mudou (${previousHash.slice(0, 12)} → ${hash.slice(0, 12)}) — ` +
      'scores não comparáveis com runs antigas: recalibre antes de comparar notas ' +
      '(trocar juiz/prompt/referência/think level/provedor muda a distribuição de veredito).',
  };
}

/**
 * Linha de AUDITORIA do contrato do juiz (IMPL-057, R-11a:REC-8): o que a tela
 * de auditoria mostra em modo curto — "juiz: &lt;modelo&gt; (mesmo contrato desde a
 * última run)" — e o `detail` (detalhe/export) que é o ÚNICO lugar onde o hash
 * aparece, em 12 chars. Quando o contrato mudou, o aviso curto diz logo que os
 * "scores não comparáveis" (o racional completo fica em `noteJudgeContract`).
 */
export function judgeContractAudit(params: {
  modelIds: string[];
  hash: string;
  /** Hash da run anterior, quando conhecido (memória do processo/CLI). */
  previousHash?: string;
}): { line: string; detail: string } {
  const juizes = params.modelIds.length > 0 ? params.modelIds.join('+') : '(sem juiz)';
  const mudou = params.previousHash !== undefined && params.previousHash !== params.hash;
  const semAnterior = params.previousHash === undefined;
  const line = mudou
    ? `juiz: ${juizes} (contrato mudou — scores não comparáveis com a última run)`
    : semAnterior
      ? `juiz: ${juizes} (primeira run — sem contrato anterior para comparar)`
      : `juiz: ${juizes} (mesmo contrato desde a última run)`;
  // 12 chars do hash SÓ no detalhe/export (o resumo não polui a tela).
  const detail = `${line} · contrato ${params.hash.slice(0, 12)}${
    params.previousHash ? ` (anterior ${params.previousHash.slice(0, 12)})` : ''
  }`;
  return { line, detail };
}

/** Limpa a memória de contrato (testes e fronteira de processo). */
export function resetJudgeContractMemory(): void {
  ultimoContractHash = undefined;
}

/**
 * Seeds das 4 rondas de FNV-1a: constantes ímpares clássicas (offset basis do
 * FNV-1a + as três constantes já usadas no repo). Cada ronda produz 32 bits e a
 * concatenação dos hexes dá os 128 bits "improvisados".
 */
const FNV_SEEDS = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35] as const;

/** FNV-1a 32-bit sobre UTF-16 code units (mesma técnica de `duelCore.seedFromId`). */
function fnv1a32(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 32 bits em hex minúsculo com 8 chars (sempre o mesmo comprimento). */
function hex32(x: number): string {
  return (x >>> 0).toString(16).padStart(8, '0');
}

/**
 * PRNG determinístico (mulberry32). Duplicado de `stats.ts`/`duelCore.ts` DE
 * PROPÓSITO, como no original: cada módulo semeia o seu (aqui a seed fixa o
 * bootstrap da média), e um helper compartilhado acoplaria fontes de
 * aleatoriedade que devem evoluir independentes.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Orientação de amostra: aviso quando n < 10 por variante (o plano exige avisar
 * n<10). n pequeno demais para ranking/promoção — abaixo de 10 observações a
 * diferença mede ruído, não qualidade.
 */
export function sampleSizeWarning(n: number, label?: string): string {
  if (n >= MIN_SAMPLES) return '';
  const alvo = label ? ` para "${label}"` : '';
  return `amostra pequena (n=${n})${alvo}: n<${MIN_SAMPLES} não sustenta conclusão — trate como sinal, não como prova.`;
}

/**
 * Intervalo de confiança 95% da MÉDIA por bootstrap percentil simples
 * (determinístico, mulberry32 seed 1337 — mesma família de stats.ts).
 *
 * Escolha do bootstrap em vez da fórmula normal: os scores de juiz são
 * discretos e assimétricos (vereditos 0/0.5/1) e n é pequeno; a normal assume
 * distribuição da média e mente justamente na cauda que interessa. 2000
 * resamples com seed fixa ⇒ recomputar um resultado salvo reproduz o MESMO
 * intervalo. Retorna null com n < 5 (mesmo piso do resto do projeto).
 * Unidade: mesma dos scores de entrada (sem ×100 — quem quer pontos converte
 * na chamada). Os valores saem arredondados a 6 casas (como `stats.ts` arredonda
 * os seus): mata o ruído de ponto flutuante do bootstrap sem tocar na precisão
 * real dos scores (granularidade de veredito = 0.005), e o arredondamento é
 * monotônico, então `ci95[0] <= mean <= ci95[1]` continua valendo.
 */
export function meanCi95(
  scores: number[],
): { mean: number; ci95: [number, number]; n: number } | null {
  const n = scores.length;
  if (n < MIN_CI_SAMPLES) return null;
  const mean = round6(scores.reduce((s, x) => s + x, 0) / n);
  const rng = mulberry32(1337);
  const means: number[] = new Array(BOOTSTRAP_ITERATIONS);
  for (let it = 0; it < BOOTSTRAP_ITERATIONS; it += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += scores[Math.floor(rng() * n)];
    means[it] = sum / n;
  }
  means.sort((a, b) => a - b);
  const q = (p: number) =>
    means[Math.min(BOOTSTRAP_ITERATIONS - 1, Math.max(0, Math.floor(p * BOOTSTRAP_ITERATIONS)))];
  return { mean, ci95: [round6(q(0.025)), round6(q(0.975))], n };
}

/** Arredonda a 6 casas (mata ruído de float do bootstrap; ver `meanCi95`). */
function round6(x: number): number {
  return Number(x.toFixed(6));
}
