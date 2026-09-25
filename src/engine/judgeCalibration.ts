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

/** Par observado (uma resposta julgada): score do juiz × tamanho da resposta. */
export interface CalibrationSample {
  score: number;   // score normalizado 0–1 (ex.: judge-score ÷100)
  length: number;  // chars da resposta (ou tokens — só a ordem importa)
}

/** Relatório de viés de verbosidade. */
export interface VerbosityReport {
  n: number;
  /** Correlação de Pearson entre score e comprimento (−1..1). */
  r: number;
  /** true quando |r| ≥ 0.3 com n ≥ 10 — viés relevante, reporte na metodologia. */
  biased: boolean;
  /** Aviso curto em PT-BR (vazio quando sem evidência). */
  warning: string;
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
 * Relatório de verbosidade: r + decisão + aviso PT-BR.
 *
 * O aviso existe só quando o viés é DECLARADO (biased): n<10 com r alto não é
 * acusação, é falta de amostra — para isso existe `sampleSizeWarning`. Misturar
 * os dois deixaria o chamador sem saber se o aviso pede correção ou mais dados.
 */
export function verbosityReport(samples: CalibrationSample[]): VerbosityReport {
  const n = samples.length;
  const r = pearsonCorrelation(samples);
  // |r| >= 0.3 já desloca ranking/placar; exigir n >= 10 evita acusar viés em
  // ruído de amostra pequena (item (c) da abertura deste arquivo).
  const biased = n >= MIN_SAMPLES && Math.abs(r) >= BIAS_THRESHOLD;
  return {
    n,
    r,
    biased,
    warning: biased
      ? `viés de verbosidade detectado (r=${r.toFixed(2)}, n=${n}): respostas mais longas pontuam mais — reporte na metodologia e não compare respostas de tamanhos diferentes sem normalizar.`
      : '',
  };
}

/**
 * Pin do contrato do juiz: hash estável do (modelo + texto do prompt/rúbrica).
 */
export interface JudgeContractPin {
  /** Hex 32 chars (FNV-1a 128-bit improvisado: 4 rondas de FNV-1a 32-bit com seeds distintas). */
  hash: string;
  modelIds: string[];
  pinnedAt: string; // ISO
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
 * Serialização canônica do contrato. Os ids são um CONJUNTO (a ordem de
 * cadastro não muda a rúbrica), então entram ordenados — dois pins do mesmo
 * contrato com juízes listados em outra ordem são o MESMO pin. O framing por
 * comprimento evita colisão ingênua entre ["ab","c"] e ["a","bc"].
 */
function canonicalContract(modelIds: string[], judgePromptText: string): string {
  const ids = [...modelIds].sort();
  return `${ids.map((id) => `${id.length}:${id}`).join('\u0001')}\u0000${judgePromptText}`;
}

/**
 * Hash estável do contrato do juiz (hex 32 chars): 4 rondas de FNV-1a 32-bit
 * com seeds distintas sobre a serialização canônica de (modelIds, rúbrica).
 *
 * NÃO é criptográfico e não precisa ser: o pin só detecta MUDANÇA de contrato
 * (calibration drift), nunca autentica ninguém. Mesma entrada ⇒ mesmo hash;
 * qualquer modelo ou caractere da rúbrica diferente ⇒ hash diferente.
 */
export function judgeContractHash(modelIds: string[], judgePromptText: string): string {
  const canonical = canonicalContract(modelIds, judgePromptText);
  return FNV_SEEDS.map((seed) => hex32(fnv1a32(canonical, seed))).join('');
}

/**
 * Monta o pin para gravar no record da run (transparência de calibration drift):
 * ao reler uma run antiga dá para conferir se o juiz de hoje é o de lá.
 */
export function pinJudgeContract(
  modelIds: string[],
  judgePromptText: string,
  now?: Date,
): JudgeContractPin {
  return {
    hash: judgeContractHash(modelIds, judgePromptText),
    modelIds: [...modelIds],
    pinnedAt: (now ?? new Date()).toISOString(),
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
