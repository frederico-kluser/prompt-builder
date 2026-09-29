// Calibração juiz × humano (IMPL-058, R-03a:REC-4 / DEC-4): o formato
// `calibration-jsonl@1` e a estatística de concordância — PUROS.
//
// POR QUE existe: o produto publica notas de um juiz LLM sem saber quanto ele
// concorda com humanos. Este módulo responde "o juiz serve?" a partir de um
// conjunto rotulado por PESSOAS (`data/calibration/<dominio>.jsonl`):
//
//   1. humano × humano PRIMEIRO (o piloto, `--pilot`): se os anotadores não
//      concordam entre si (α ordinal < 0,667), a rubrica/protocolo está ruim e
//      medir o juiz contra eles é medir ruído — o juiz nem é medido;
//   2. juiz × humano só com α humano ≥ 0,667; "juiz aceitável" = α do juiz
//      ≥ 0,667 E dentro da faixa humano×humano NOS MESMOS ITENS (α do juiz ≥
//      limite inferior do IC95% do α humano);
//   3. sensibilidade/especificidade do juiz (resolve × resto) quando há rótulo
//      OURO adjudicado — a base da correção de viés de R-03a:REC-5.
//
// FÓRMULAS (conferidas em test/calib.test.ts contra os exemplos publicados —
// Krippendorff 2011 e Wikipedia — e contra as implementações de referência
// `krippendorff` 0.8.2 e `irrCAC` para Python):
//   - α de Krippendorff pela MATRIZ DE COINCIDÊNCIAS: o_ck = Σ_u (pares c–k da
//     unidade u)/(m_u − 1); α = 1 − (n − 1)·Σ o_ck δ²_ck / Σ n_c n_k δ²_ck.
//     Métrica ORDINAL: δ²_ck = (Σ_{g=c..k} n_g − (n_c + n_k)/2)² — só a ordem
//     nao < parcial < resolve importa, não a distância numérica.
//   - AC2 de Gwet (Handbook of Inter-Rater Reliability, 4ª ed.) com pesos
//     ORDINAIS w_kl = 1 − C(|k−l|+1, 2)/C(q, 2): p_a = média, nas unidades com
//     ≥ 2 rótulos, de Σ_k r_ik (r*_ik − 1)/(r_i (r_i − 1)); p_e = T_w/(q(q−1)) ·
//     Σ_k π_k (1 − π_k). Reportado JUNTO do α porque sob prevalência
//     desbalanceada o α despenca com concordância quase perfeita (o "paradoxo
//     do κ": caso real α=0,32 × AC2=0,69) — um número só enganaria.
//   - IC95%: bootstrap PERCENTIL por ITEM (reamostra itens com reposição e
//     recalcula; semeado por mulberry32 → reproduzível). Reamostrar o item
//     inteiro preserva a dependência entre os rótulos do mesmo item.
//   - Proporções (sens/espec/acerto): intervalo de Wilson.
//
// Juiz × humano usa UNIDADES REPLICADAS: cada item vira um par (juiz, humano_k)
// por anotador. Assim o α do juiz é um α de 2 codificadores, comparável ao α
// humano × humano do mesmo item (se o juiz fosse um 3º humano, os pares teriam
// a mesma distribuição).
//
// Módulo PURO (sem `node:`/fetch/fs): roda no CLI e pode ir ao bundle do
// navegador por shim sem adaptação. O I/O (ler o JSONL, gate de saída, PII)
// mora em src/cli/commands/calib.ts.

import { mulberry32 } from '../stats.js';
import type { Verdict } from '../types.js';

/** Formato de cada linha do arquivo de calibração. */
export const CALIBRATION_FORMAT = 'calibration-jsonl@1';
/** Formato do relatório (`calib report --json`). */
export const CALIBRATION_REPORT_FORMAT = 'calibration-report@1';

/** Escala ordinal do veredito, do pior ao melhor (o valor é a posição). */
export const VERDICT_SCALE: readonly Verdict[] = ['nao', 'parcial', 'resolve'];
const VERDICT_VALUE: Readonly<Record<Verdict, number>> = { nao: 0, parcial: 1, resolve: 2 };
/** Valores numéricos da escala (0, 1, 2) — as categorias do α e do AC2. */
export const VERDICT_VALUES: readonly number[] = VERDICT_SCALE.map((v) => VERDICT_VALUE[v]);

export function verdictValue(v: Verdict): number {
  return VERDICT_VALUE[v];
}

export function isVerdict(v: unknown): v is Verdict {
  return typeof v === 'string' && (VERDICT_SCALE as readonly string[]).includes(v);
}

// --- limiares (R-03a:DEC-4) ---------------------------------------------------

/** α mínimo para conclusão TENTATIVA (Krippendorff 2004). Abaixo: portão reprova. */
export const ALPHA_MIN = 0.667;
/** α para CONFIAR (Krippendorff 2004). */
export const ALPHA_TRUST = 0.8;
/** Itens completos (≥ 2 rótulos humanos) para a calibração de um domínio. */
export const MIN_ITEMS = 150;
/** Itens por estrato (classe de veredito e tipo de tarefa). */
export const MIN_PER_STRATUM = 30;
/** Tamanho do piloto anotador × anotador. */
export const PILOT_MIN_ITEMS = 30;
export const PILOT_MAX_ITEMS = 50;
/** Largura máxima do IC95% do α (n ≈ 150–200 → largura ≈ 0,18 em p ≈ 0,7). */
export const MAX_CI_WIDTH = 0.2;
export const DEFAULT_RESAMPLES = 2000;
/** Semente default do bootstrap (o número do item do plano). */
export const DEFAULT_SEED = 58;
/**
 * Tipos de tarefa sugeridos (DEC-4: extração, factual, raciocínio, formato,
 * recusa/política, aberta). Outro valor é aceito com AVISO (pega typo).
 */
export const SUGGESTED_TASK_TYPES: readonly string[] = [
  'extracao',
  'factual',
  'raciocinio',
  'formato',
  'recusa',
  'aberta',
];

// --- formato calibration-jsonl@1 ----------------------------------------------

export interface HumanLabel {
  /** Id ESTÁVEL do anotador (pseudônimo; nunca nome/e-mail). */
  annotator: string;
  verdict: Verdict;
  /** Justificativa livre do anotador (opcional). */
  note?: string;
}

export interface CalibrationItem {
  id: string;
  /** Domínio (a calibração é POR domínio: um arquivo, um domínio). */
  domain: string;
  /** Tipo de tarefa (estrato): ver {@link SUGGESTED_TASK_TYPES}. */
  taskType: string;
  /** O pedido do usuário que o candidato respondeu. */
  question: string;
  /** A resposta julgada (por humanos e pelo juiz). */
  candidate: string;
  /** Gabarito/referência mostrado ao juiz, quando houver. */
  reference?: string;
  /** ≥ 2 rótulos de anotadores DISTINTOS (item com menos fica fora do α). */
  humanLabels: HumanLabel[];
  /** Veredito do juiz em calibração (o setup inteiro: juízes + contrato). */
  judgeVerdict?: Verdict;
  /** Qual juiz produziu `judgeVerdict` (id do modelo/painel ou hash do contrato). */
  judgeModel?: string;
  /** Rótulo OURO adjudicado (base de sensibilidade/especificidade). */
  gold?: Verdict;
  /** Item SINTÉTICO (exemplo/teste): não é rótulo humano real. */
  synthetic?: boolean;
  /** Metadados livres da ferramenta de anotação (não interpretados). */
  meta?: Record<string, unknown>;
}

export interface CalibrationIssue {
  /** Linha (1-based) do arquivo. */
  line: number;
  id: string | null;
  message: string;
}

export interface ParsedCalibration {
  items: CalibrationItem[];
  /** Erros (arquivo recusado, exit 3). */
  errors: CalibrationIssue[];
  /** Avisos (o arquivo vale, mas algo merece atenção). */
  warnings: CalibrationIssue[];
}

const ITEM_KEYS: readonly string[] = [
  'id',
  'domain',
  'taskType',
  'question',
  'candidate',
  'reference',
  'humanLabels',
  'judgeVerdict',
  'judgeModel',
  'gold',
  'synthetic',
  'meta',
];
const LABEL_KEYS: readonly string[] = ['annotator', 'verdict', 'note'];

/** Chave aceita e ignorada: começa com `_` (anotação livre de quem montou o arquivo). */
const isFreeKey = (k: string): boolean => k.startsWith('_');

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

const VERDICT_HINT = `use "resolve", "parcial" ou "nao" (sem til)`;

/**
 * Valida UM item. Fail-closed: chave desconhecida é ERRO (um typo como
 * "judgeVerdit" sumiria com o rótulo do juiz em silêncio) — metadado livre vai
 * em `meta` ou numa chave começando com `_`.
 */
function validateItem(
  raw: unknown,
  line: number,
  errors: CalibrationIssue[],
  warnings: CalibrationIssue[],
): CalibrationItem | null {
  if (!isPlainObject(raw)) {
    errors.push({ line, id: null, message: 'cada linha deve ser um objeto JSON (um item)' });
    return null;
  }
  const id = nonEmptyString(raw.id) ? raw.id.trim() : null;
  const err = (message: string): void => {
    errors.push({ line, id, message });
  };
  const antes = errors.length;
  if (!id) err('"id" ausente ou vazio');

  const desconhecidas = Object.keys(raw).filter((k) => !ITEM_KEYS.includes(k) && !isFreeKey(k));
  if (desconhecidas.length) {
    err(
      `chave(s) desconhecida(s): ${desconhecidas.map((k) => `"${k}"`).join(', ')} — aceitas: ` +
        `${ITEM_KEYS.join(', ')} (metadado livre vai em "meta" ou numa chave "_…")`,
    );
  }
  for (const campo of ['domain', 'taskType', 'question', 'candidate'] as const) {
    if (!nonEmptyString(raw[campo])) err(`"${campo}" ausente ou vazio (texto obrigatório)`);
  }
  if (raw.reference !== undefined && raw.reference !== null && typeof raw.reference !== 'string') {
    err('"reference" deve ser texto');
  }
  if (raw.judgeModel !== undefined && raw.judgeModel !== null && typeof raw.judgeModel !== 'string') {
    err('"judgeModel" deve ser texto');
  }
  for (const campo of ['judgeVerdict', 'gold'] as const) {
    const v = raw[campo];
    if (v !== undefined && v !== null && !isVerdict(v)) err(`"${campo}" inválido (${JSON.stringify(v)}): ${VERDICT_HINT}`);
  }
  if (raw.synthetic !== undefined && typeof raw.synthetic !== 'boolean') err('"synthetic" deve ser true/false');
  if (raw.meta !== undefined && !isPlainObject(raw.meta)) err('"meta" deve ser um objeto');

  const labels: HumanLabel[] = [];
  if (!Array.isArray(raw.humanLabels)) {
    err('"humanLabels" ausente: lista de {annotator, verdict}');
  } else {
    const vistos = new Set<string>();
    raw.humanLabels.forEach((l, i) => {
      if (!isPlainObject(l)) {
        err(`humanLabels[${i}] deve ser um objeto {annotator, verdict}`);
        return;
      }
      const extras = Object.keys(l).filter((k) => !LABEL_KEYS.includes(k) && !isFreeKey(k));
      if (extras.length) {
        err(`humanLabels[${i}]: chave(s) desconhecida(s) ${extras.map((k) => `"${k}"`).join(', ')} — aceitas: ${LABEL_KEYS.join(', ')}`);
      }
      if (!nonEmptyString(l.annotator)) {
        err(`humanLabels[${i}].annotator ausente ou vazio`);
        return;
      }
      const annotator = l.annotator.trim();
      if (!isVerdict(l.verdict)) {
        err(`humanLabels[${i}].verdict inválido (${JSON.stringify(l.verdict)}): ${VERDICT_HINT}`);
        return;
      }
      if (l.note !== undefined && typeof l.note !== 'string') err(`humanLabels[${i}].note deve ser texto`);
      if (vistos.has(annotator)) {
        // Rotular 2× o mesmo item infla a concordância (o anotador concorda consigo).
        err(`anotador "${annotator}" rotulou o item mais de uma vez (um rótulo por anotador por item)`);
        return;
      }
      vistos.add(annotator);
      labels.push({ annotator, verdict: l.verdict, ...(typeof l.note === 'string' ? { note: l.note } : {}) });
    });
  }
  if (errors.length > antes) return null;

  const taskType = (raw.taskType as string).trim();
  if (!SUGGESTED_TASK_TYPES.includes(taskType)) {
    warnings.push({
      line,
      id,
      message: `taskType "${taskType}" fora da lista sugerida (${SUGGESTED_TASK_TYPES.join(', ')}) — typo? vira um estrato próprio`,
    });
  }
  if (labels.length < 2) {
    warnings.push({
      line,
      id,
      message: `${labels.length} rótulo(s) humano(s): o item fica FORA do α (exige ≥ 2 anotadores distintos)`,
    });
  }
  return {
    id: id!,
    domain: (raw.domain as string).trim(),
    taskType,
    question: raw.question as string,
    candidate: raw.candidate as string,
    ...(typeof raw.reference === 'string' ? { reference: raw.reference } : {}),
    humanLabels: labels,
    ...(isVerdict(raw.judgeVerdict) ? { judgeVerdict: raw.judgeVerdict } : {}),
    ...(typeof raw.judgeModel === 'string' && raw.judgeModel.trim() ? { judgeModel: raw.judgeModel.trim() } : {}),
    ...(isVerdict(raw.gold) ? { gold: raw.gold } : {}),
    ...(raw.synthetic === true ? { synthetic: true } : {}),
    ...(isPlainObject(raw.meta) ? { meta: raw.meta } : {}),
  };
}

/**
 * Lê um arquivo `calibration-jsonl@1`: um item JSON por linha; linhas vazias e
 * linhas começando com `#` são comentário. Nunca lança: o que está errado vira
 * `errors` (com a linha) e o que merece atenção vira `warnings`.
 */
export function parseCalibrationJsonl(text: string): ParsedCalibration {
  const items: CalibrationItem[] = [];
  const errors: CalibrationIssue[] = [];
  const warnings: CalibrationIssue[] = [];
  const ids = new Map<string, number>();
  const linhas = text.replace(/^﻿/, '').split(/\r?\n/);
  linhas.forEach((bruta, i) => {
    const line = i + 1;
    const t = bruta.trim();
    if (!t || t.startsWith('#')) return;
    let raw: unknown;
    try {
      raw = JSON.parse(t);
    } catch (e) {
      errors.push({ line, id: null, message: `JSON inválido: ${(e as Error).message}` });
      return;
    }
    const item = validateItem(raw, line, errors, warnings);
    if (!item) return;
    const anterior = ids.get(item.id);
    if (anterior !== undefined) {
      errors.push({ line, id: item.id, message: `id duplicado (já usado na linha ${anterior})` });
      return;
    }
    ids.set(item.id, line);
    items.push(item);
  });
  return { items, errors, warnings };
}

// --- α de Krippendorff ----------------------------------------------------------

export type AlphaMetric = 'nominal' | 'ordinal' | 'interval' | 'ratio';

/** Unidade de confiabilidade: os valores dados por codificadores DISTINTOS a um item. */
export type Unit = readonly number[];

export interface AlphaResult {
  /** `null` = indefinido (menos de 2 valores pareáveis ou nenhuma variação: D_e = 0). */
  alpha: number | null;
  /** n: valores pareáveis (de unidades com ≥ 2 valores). */
  pairable: number;
  /** Unidades com ≥ 2 valores. */
  units: number;
  /** Discordância observada D_o. */
  observed: number;
  /** Discordância esperada D_e. */
  expected: number;
}

/** δ² entre as categorias presentes (ordenadas), pela métrica pedida. */
function deltaSquared(values: readonly number[], nc: readonly number[], metric: AlphaMetric): number[][] {
  const V = values.length;
  const d = Array.from({ length: V }, () => new Array<number>(V).fill(0));
  for (let c = 0; c < V; c++) {
    for (let k = c + 1; k < V; k++) {
      let v: number;
      if (metric === 'nominal') {
        v = 1;
      } else if (metric === 'ordinal') {
        let soma = 0;
        for (let g = c; g <= k; g++) soma += nc[g];
        v = (soma - (nc[c] + nc[k]) / 2) ** 2;
      } else if (metric === 'interval') {
        v = (values[c] - values[k]) ** 2;
      } else {
        const s = values[c] + values[k];
        v = s === 0 ? 0 : ((values[c] - values[k]) / s) ** 2;
      }
      d[c][k] = v;
      d[k][c] = v;
    }
  }
  return d;
}

/**
 * α de Krippendorff pela matriz de coincidências (Krippendorff 2011, "Computing
 * Krippendorff's Alpha-Reliability"). Aceita qualquer número de codificadores e
 * dado faltante: cada unidade traz só os valores que existem; unidade com < 2
 * valores não é pareável e não entra.
 */
export function krippendorffAlpha(units: readonly Unit[], metric: AlphaMetric = 'ordinal'): AlphaResult {
  const pareaveis = units.filter((u) => u.length >= 2);
  const values = [...new Set(pareaveis.flat())].sort((a, b) => a - b);
  const pos = new Map(values.map((v, i) => [v, i]));
  const V = values.length;
  const o = Array.from({ length: V }, () => new Array<number>(V).fill(0));
  for (const u of pareaveis) {
    const m = u.length;
    const cont = new Array<number>(V).fill(0);
    for (const v of u) cont[pos.get(v)!] += 1;
    for (let c = 0; c < V; c++) {
      if (!cont[c]) continue;
      for (let k = 0; k < V; k++) {
        if (!cont[k]) continue;
        const pares = c === k ? cont[c] * (cont[c] - 1) : cont[c] * cont[k];
        o[c][k] += pares / (m - 1);
      }
    }
  }
  const nc = o.map((linha) => linha.reduce((s, x) => s + x, 0));
  const n = nc.reduce((s, x) => s + x, 0);
  const d2 = deltaSquared(values, nc, metric);
  let somaO = 0;
  let somaE = 0;
  for (let c = 0; c < V; c++) {
    for (let k = 0; k < V; k++) {
      somaO += o[c][k] * d2[c][k];
      somaE += nc[c] * nc[k] * d2[c][k];
    }
  }
  const observed = n > 0 ? somaO / n : 0;
  const expected = n > 1 ? somaE / (n * (n - 1)) : 0;
  const alpha = n > 1 && somaE > 0 ? 1 - ((n - 1) * somaO) / somaE : null;
  return { alpha, pairable: n, units: pareaveis.length, observed, expected };
}

// --- AC2 de Gwet ---------------------------------------------------------------

export type WeightScheme = 'identity' | 'ordinal' | 'linear' | 'quadratic';

/**
 * Pesos de concordância parcial (Gwet 2014; mesmos do `irrCAC`). `identity` dá
 * o AC1 (sem crédito parcial). Ordinais usam só a POSIÇÃO: w = 1 − C(|k−l|+1,
 * 2)/C(q, 2) — na escala do veredito (q = 3), vizinhos valem 2/3 e os extremos 0.
 */
export function agreementWeights(categories: readonly number[], scheme: WeightScheme): number[][] {
  const q = categories.length;
  const w: number[][] = Array.from({ length: q }, (_, k) =>
    Array.from({ length: q }, (_, l): number => (k === l ? 1 : 0)),
  );
  if (q < 2 || scheme === 'identity') return w;
  const lo = Math.min(...categories);
  const hi = Math.max(...categories);
  const faixa = hi - lo;
  const maxM = (q * (q - 1)) / 2;
  for (let k = 0; k < q; k++) {
    for (let l = 0; l < q; l++) {
      if (k === l) continue;
      if (scheme === 'ordinal') {
        const nkl = Math.abs(k - l) + 1;
        w[k][l] = 1 - (nkl * (nkl - 1)) / 2 / maxM;
      } else if (scheme === 'linear') {
        w[k][l] = faixa === 0 ? 0 : 1 - Math.abs(categories[k] - categories[l]) / faixa;
      } else {
        w[k][l] = faixa === 0 ? 0 : 1 - (categories[k] - categories[l]) ** 2 / faixa ** 2;
      }
    }
  }
  return w;
}

export interface Ac2Result {
  /** `null` = indefinido (nenhuma unidade com ≥ 2 rótulos, ou p_e = 1). */
  ac2: number | null;
  /** Concordância observada (ponderada). */
  pa: number | null;
  /** Concordância ao acaso (Gwet). */
  pe: number | null;
  /** Unidades com ≥ 1 rótulo (entram em π). */
  units: number;
  scheme: WeightScheme;
}

/**
 * AC1/AC2 de Gwet para vários avaliadores com dado faltante. `categories` é a
 * ESCALA inteira, em ordem (q entra no p_e — categoria nunca usada ainda conta).
 */
export function gwetAc2(
  units: readonly Unit[],
  categories: readonly number[],
  scheme: WeightScheme = 'ordinal',
): Ac2Result {
  const q = categories.length;
  const pos = new Map(categories.map((v, i) => [v, i]));
  const avaliadas = units.filter((u) => u.length >= 1);
  const n = avaliadas.length;
  const vazio: Ac2Result = { ac2: null, pa: null, pe: null, units: n, scheme };
  if (q < 2 || n === 0) return vazio;
  const w = agreementWeights(categories, scheme);
  const pi = new Array<number>(q).fill(0);
  let somaPa = 0;
  let n2 = 0;
  for (const u of avaliadas) {
    const r = new Array<number>(q).fill(0);
    for (const v of u) {
      const k = pos.get(v);
      if (k === undefined) throw new Error(`valor ${v} fora da escala [${categories.join(', ')}]`);
      r[k] += 1;
    }
    const ri = u.length;
    for (let k = 0; k < q; k++) pi[k] += r[k] / ri;
    if (ri >= 2) {
      let s = 0;
      for (let k = 0; k < q; k++) {
        if (!r[k]) continue;
        let rEstrela = 0;
        for (let l = 0; l < q; l++) rEstrela += w[k][l] * r[l];
        s += r[k] * (rEstrela - 1);
      }
      somaPa += s / (ri * (ri - 1));
      n2 += 1;
    }
  }
  if (n2 === 0) return vazio;
  const pa = somaPa / n2;
  let tw = 0;
  for (const linha of w) for (const x of linha) tw += x;
  let somaPi = 0;
  for (let k = 0; k < q; k++) {
    const p = pi[k] / n;
    somaPi += p * (1 - p);
  }
  const pe = (tw / (q * (q - 1))) * somaPi;
  return { ac2: pe < 1 ? (pa - pe) / (1 - pe) : null, pa, pe, units: n, scheme };
}

// --- IC: bootstrap e Wilson ------------------------------------------------------

export interface BootstrapCi {
  low: number;
  high: number;
  level: 0.95;
  method: 'bootstrap-percentil-por-item';
  resamples: number;
  /** Reamostras em que a estatística é definida (as outras ficam de fora). */
  valid: number;
  seed: number;
}

/** Quantil com interpolação linear (tipo 7, o default do R) sobre um vetor ordenado. */
function quantileSorted(sorted: readonly number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * IC95% por bootstrap percentil reamostrando ITENS com reposição. Semeado: a
 * mesma semente sobre a mesma lista dá o mesmo intervalo (e listas de mesmo
 * tamanho recebem os MESMOS índices — números aleatórios comuns, o que torna a
 * diferença pareada juiz − humano estável). `null` com < 2 itens ou nenhuma
 * reamostra definida.
 */
export function bootstrapCi<T>(
  items: readonly T[],
  stat: (sample: readonly T[]) => number | null,
  opts: { resamples?: number; seed?: number } = {},
): BootstrapCi | null {
  const B = opts.resamples ?? DEFAULT_RESAMPLES;
  const seed = opts.seed ?? DEFAULT_SEED;
  const n = items.length;
  if (n < 2 || B < 1) return null;
  const rnd = mulberry32(seed);
  const amostra = new Array<T>(n);
  const vals: number[] = [];
  for (let b = 0; b < B; b++) {
    for (let i = 0; i < n; i++) amostra[i] = items[Math.floor(rnd() * n)];
    const v = stat(amostra);
    if (v !== null && Number.isFinite(v)) vals.push(v);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return {
    low: quantileSorted(vals, 0.025),
    high: quantileSorted(vals, 0.975),
    level: 0.95,
    method: 'bootstrap-percentil-por-item',
    resamples: B,
    valid: vals.length,
    seed,
  };
}

export interface Proportion {
  /** `null` quando n = 0. */
  value: number | null;
  successes: number;
  n: number;
  /** Intervalo de Wilson 95% (não degenera em 0/1 com n pequeno). */
  ci95: { low: number; high: number } | null;
}

const Z95 = 1.959963984540054;

export function wilson(successes: number, n: number): Proportion {
  if (n <= 0) return { value: null, successes, n, ci95: null };
  const p = successes / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const centro = (p + z2 / (2 * n)) / denom;
  const meia = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { value: p, successes, n, ci95: { low: Math.max(0, centro - meia), high: Math.min(1, centro + meia) } };
}

// --- unidades a partir dos itens -------------------------------------------------

/** Item com ≥ 2 rótulos humanos (entra no α). */
export function isComplete(item: CalibrationItem): boolean {
  return item.humanLabels.length >= 2;
}

/** Unidade humano × humano de um item: os vereditos dos anotadores. */
export function humanUnit(item: CalibrationItem): Unit {
  return item.humanLabels.map((l) => verdictValue(l.verdict));
}

/** Unidades juiz × humano REPLICADAS: um par (juiz, humano_k) por anotador. */
export function judgeUnits(item: CalibrationItem): Unit[] {
  if (!item.judgeVerdict) return [];
  const j = verdictValue(item.judgeVerdict);
  return item.humanLabels.map((l) => [j, verdictValue(l.verdict)]);
}

// --- relatório -------------------------------------------------------------------

export interface AgreementStats {
  /** Itens usados. */
  items: number;
  /** Codificadores distintos (anotadores; +1 quando o juiz entra). */
  coders: number;
  /** n do α (valores pareáveis). */
  pairableValues: number;
  /** α ordinal de Krippendorff (null = indefinido). */
  alpha: number | null;
  alphaCi95: BootstrapCi | null;
  /** AC2 de Gwet com pesos ordinais. */
  ac2: number | null;
  ac2Ci95: BootstrapCi | null;
  /** Concordância exata bruta entre pares (sem correção de acaso). */
  rawAgreement: number | null;
}

export interface AnnotatorPair {
  a: string;
  b: string;
  /** Itens rotulados pelos dois. */
  items: number;
  alpha: number | null;
  rawAgreement: number | null;
}

export interface GoldDiagnostics {
  /** Itens com ouro E veredito do juiz. */
  items: number;
  /** Colapso binário (R-03a:REC-5): positivo = resolve; negativo = parcial ou nao. */
  positive: 'resolve';
  /** Linhas = ouro, colunas = juiz. */
  confusion: Record<Verdict, Record<Verdict, number>>;
  /** P(juiz = resolve | ouro = resolve). */
  sensitivity: Proportion;
  /** P(juiz ≠ resolve | ouro ≠ resolve). */
  specificity: Proportion;
  /** Juiz = ouro nas 3 classes. */
  exactAgreement: Proportion;
  /** Fração de ouro = resolve. */
  goldPrevalence: number;
  /** Fração de juiz = resolve (o que o juiz publica). */
  judgePositiveRate: number;
}

export type JudgeSkipReason = 'pilot' | 'human_alpha_below_min' | 'no_judge_labels';

export type JudgeSection =
  | { status: 'skipped'; reason: JudgeSkipReason; message: string }
  | {
      status: 'measured';
      /** `judgeModel` distintos no arquivo (misturar juízes invalida a leitura). */
      judgeModels: string[];
      agreement: AgreementStats;
      /** α humano × humano recalculado NOS MESMOS itens que o juiz rotulou. */
      humanSameItems: AgreementStats;
      /** α_juiz − α_humano nos mesmos itens (bootstrap pareado). */
      deltaVsHuman: { value: number | null; ci95: BootstrapCi | null };
      /** α do juiz ≥ limite inferior do IC95% do α humano (null = não dá para afirmar). */
      withinHumanBand: boolean | null;
      /** α do juiz ≥ 0,667 E dentro da faixa humana. */
      acceptable: boolean;
      gold: GoldDiagnostics | null;
    };

export type CalibrationGateCode =
  | 'gate.calibration_human_alpha_low'
  | 'gate.calibration_judge_alpha_low'
  | 'gate.calibration_judge_outside_human_band'
  /** Só com `strict`: o CONJUNTO não cumpre o protocolo (tamanho, estratos, IC, sintético…). */
  | 'gate.calibration_not_ready';

export interface CalibrationGate {
  passed: boolean;
  /** O PRIMEIRO motivo que reprovou (error.code do CLI). */
  code: CalibrationGateCode | null;
  /** Todos os motivos, em ordem. */
  reasons: string[];
}

export interface CalibrationReport {
  format: typeof CALIBRATION_REPORT_FORMAT;
  mode: 'pilot' | 'full';
  thresholds: {
    alphaMin: number;
    alphaTrust: number;
    minItems: number;
    minPerStratum: number;
    pilotItems: [number, number];
    maxCiWidth: number;
  };
  items: {
    total: number;
    /** ≥ 2 rótulos humanos (entram no α). */
    complete: number;
    incomplete: number;
    synthetic: number;
    withJudge: number;
    withGold: number;
  };
  domains: string[];
  annotators: string[];
  strata: {
    /** Classe de cada item completo: ouro quando há; senão a maioria humana; empate fica em `empate`. */
    byClass: Record<Verdict | 'empate', number>;
    classSource: 'gold' | 'humanos' | 'misto';
    byTaskType: Record<string, number>;
  };
  human: AgreementStats & { pairs: AnnotatorPair[] };
  judge: JudgeSection;
  readiness: { ready: boolean; issues: string[] };
  gate: CalibrationGate;
}

export interface CalibrationReportOptions {
  /** Piloto: só anotador × anotador (o juiz nem é lido). */
  pilot?: boolean;
  /**
   * Prontidão também reprova o portão (`gate.calibration_not_ready`). Sem ele o
   * portão olha só o α — o default do contrato ("exit ≠ 0 se α < 0,667"); com
   * ele um CI exige o PROTOCOLO inteiro (≥ 150 itens, estratos, IC ≤ 0,2, nada
   * sintético) antes de aceitar a calibração.
   */
  strict?: boolean;
  seed?: number;
  resamples?: number;
}

function agreement(
  items: readonly CalibrationItem[],
  toUnits: (item: CalibrationItem) => Unit[],
  coders: number,
  opts: { seed: number; resamples: number },
): AgreementStats {
  const unitsOf = (s: readonly CalibrationItem[]): Unit[] => s.flatMap(toUnits);
  const units = unitsOf(items);
  const a = krippendorffAlpha(units, 'ordinal');
  const g = gwetAc2(units, VERDICT_VALUES, 'ordinal');
  const bruta = gwetAc2(units, VERDICT_VALUES, 'identity');
  return {
    items: items.length,
    coders,
    pairableValues: a.pairable,
    alpha: a.alpha,
    alphaCi95: bootstrapCi(items, (s) => krippendorffAlpha(unitsOf(s), 'ordinal').alpha, opts),
    ac2: g.ac2,
    ac2Ci95: bootstrapCi(items, (s) => gwetAc2(unitsOf(s), VERDICT_VALUES, 'ordinal').ac2, opts),
    rawAgreement: bruta.pa,
  };
}

function annotatorPairs(items: readonly CalibrationItem[]): AnnotatorPair[] {
  const porPar = new Map<string, { a: string; b: string; units: Unit[] }>();
  for (const item of items) {
    const ls = [...item.humanLabels].sort((x, y) => (x.annotator < y.annotator ? -1 : 1));
    for (let i = 0; i < ls.length; i++) {
      for (let j = i + 1; j < ls.length; j++) {
        const chave = `${ls[i].annotator}\u0000${ls[j].annotator}`;
        const par = porPar.get(chave) ?? { a: ls[i].annotator, b: ls[j].annotator, units: [] };
        par.units.push([verdictValue(ls[i].verdict), verdictValue(ls[j].verdict)]);
        porPar.set(chave, par);
      }
    }
  }
  return [...porPar.values()]
    .map(({ a, b, units }) => ({
      a,
      b,
      items: units.length,
      alpha: krippendorffAlpha(units, 'ordinal').alpha,
      rawAgreement: gwetAc2(units, VERDICT_VALUES, 'identity').pa,
    }))
    .sort((x, y) => y.items - x.items || (x.a + x.b < y.a + y.b ? -1 : 1));
}

/** Classe de estrato de um item: ouro; senão a maioria humana; senão empate. */
function itemClass(item: CalibrationItem): Verdict | 'empate' {
  if (item.gold) return item.gold;
  const cont = new Map<Verdict, number>();
  for (const l of item.humanLabels) cont.set(l.verdict, (cont.get(l.verdict) ?? 0) + 1);
  const ordenado = [...cont.entries()].sort((a, b) => b[1] - a[1]);
  if (!ordenado.length || (ordenado[1] && ordenado[1][1] === ordenado[0][1])) return 'empate';
  return ordenado[0][0];
}

export function goldDiagnostics(items: readonly CalibrationItem[]): GoldDiagnostics | null {
  const com = items.filter((i) => i.gold && i.judgeVerdict);
  if (!com.length) return null;
  const confusion = Object.fromEntries(
    VERDICT_SCALE.map((g) => [g, Object.fromEntries(VERDICT_SCALE.map((j) => [j, 0]))]),
  ) as Record<Verdict, Record<Verdict, number>>;
  let tp = 0;
  let pos = 0;
  let tn = 0;
  let neg = 0;
  let iguais = 0;
  let juizPos = 0;
  for (const i of com) {
    const g = i.gold!;
    const j = i.judgeVerdict!;
    confusion[g][j] += 1;
    if (g === j) iguais += 1;
    if (j === 'resolve') juizPos += 1;
    if (g === 'resolve') {
      pos += 1;
      if (j === 'resolve') tp += 1;
    } else {
      neg += 1;
      if (j !== 'resolve') tn += 1;
    }
  }
  return {
    items: com.length,
    positive: 'resolve',
    confusion,
    sensitivity: wilson(tp, pos),
    specificity: wilson(tn, neg),
    exactAgreement: wilson(iguais, com.length),
    goldPrevalence: pos / com.length,
    judgePositiveRate: juizPos / com.length,
  };
}

const fmt = (x: number | null): string => (x === null ? 'indefinido' : x.toFixed(3));
const largura = (ci: BootstrapCi | null): number | null => (ci ? ci.high - ci.low : null);

/**
 * O relatório inteiro, na ORDEM OBRIGATÓRIA: humano × humano primeiro; o juiz
 * só entra fora do piloto e com α humano ≥ {@link ALPHA_MIN}. O portão reprova
 * (fail-closed) com α indefinido — "não deu para medir" não é "concorda".
 */
export function calibrationReport(
  items: readonly CalibrationItem[],
  options: CalibrationReportOptions = {},
): CalibrationReport {
  const pilot = options.pilot === true;
  const opts = { seed: options.seed ?? DEFAULT_SEED, resamples: options.resamples ?? DEFAULT_RESAMPLES };
  const completos = items.filter(isComplete);
  const annotators = [...new Set(completos.flatMap((i) => i.humanLabels.map((l) => l.annotator)))].sort();
  const domains = [...new Set(items.map((i) => i.domain))].sort();
  const synthetic = items.filter((i) => i.synthetic).length;

  // Estratos (sobre os itens completos — são os que medem).
  const byClass: Record<Verdict | 'empate', number> = { resolve: 0, parcial: 0, nao: 0, empate: 0 };
  const byTaskType: Record<string, number> = {};
  let comOuro = 0;
  for (const i of completos) {
    byClass[itemClass(i)] += 1;
    byTaskType[i.taskType] = (byTaskType[i.taskType] ?? 0) + 1;
    if (i.gold) comOuro += 1;
  }
  const classSource = comOuro === completos.length ? 'gold' : comOuro === 0 ? 'humanos' : 'misto';

  const human = {
    ...agreement(completos, (i) => [humanUnit(i)], annotators.length, opts),
    pairs: annotatorPairs(completos),
  };

  const gate: CalibrationGate = { passed: true, code: null, reasons: [] };
  const reprova = (c: CalibrationGateCode, motivo: string): void => {
    gate.passed = false;
    gate.code ??= c;
    gate.reasons.push(motivo);
  };
  const humanoOk = human.alpha !== null && human.alpha >= ALPHA_MIN;
  if (!humanoOk) {
    reprova(
      'gate.calibration_human_alpha_low',
      human.alpha === null
        ? `α humano × humano indefinido (${completos.length} item(ns) completo(s); sem variação ou sem pares) — a concordância não foi demonstrada`
        : `α humano × humano ${fmt(human.alpha)} < ${ALPHA_MIN}: os anotadores não concordam o bastante — revise a rubrica/protocolo antes de medir o juiz`,
    );
  }

  let judge: JudgeSection;
  const julgados = completos.filter((i) => i.judgeVerdict);
  if (pilot) {
    judge = { status: 'skipped', reason: 'pilot', message: 'piloto: só anotador × anotador (o juiz não é lido)' };
  } else if (!humanoOk) {
    judge = {
      status: 'skipped',
      reason: 'human_alpha_below_min',
      message: `juiz × humano NÃO medido: exige α humano ≥ ${ALPHA_MIN} (medir o juiz contra humanos que discordam é medir ruído)`,
    };
  } else if (!julgados.length) {
    judge = {
      status: 'skipped',
      reason: 'no_judge_labels',
      message: 'nenhum item completo tem "judgeVerdict": o juiz não foi medido',
    };
  } else {
    const anotadoresJulgados = new Set(julgados.flatMap((i) => i.humanLabels.map((l) => l.annotator))).size;
    const agreementJ = agreement(julgados, judgeUnits, anotadoresJulgados + 1, opts);
    const humanSame = agreement(julgados, (i) => [humanUnit(i)], anotadoresJulgados, opts);
    const alphaDe = (s: readonly CalibrationItem[], f: (i: CalibrationItem) => Unit[]): number | null =>
      krippendorffAlpha(s.flatMap(f), 'ordinal').alpha;
    const delta = (s: readonly CalibrationItem[]): number | null => {
      const j = alphaDe(s, judgeUnits);
      const h = alphaDe(s, (i) => [humanUnit(i)]);
      return j === null || h === null ? null : j - h;
    };
    const faixa = humanSame.alphaCi95?.low ?? null;
    const withinHumanBand = agreementJ.alpha === null || faixa === null ? null : agreementJ.alpha >= faixa;
    const alphaJOk = agreementJ.alpha !== null && agreementJ.alpha >= ALPHA_MIN;
    if (!alphaJOk) {
      reprova(
        'gate.calibration_judge_alpha_low',
        `α juiz × humano ${fmt(agreementJ.alpha)} < ${ALPHA_MIN}: o juiz não concorda com os humanos o bastante`,
      );
    }
    if (withinHumanBand !== true) {
      reprova(
        'gate.calibration_judge_outside_human_band',
        withinHumanBand === null
          ? 'não dá para afirmar que o juiz está dentro da faixa humano × humano (IC do α humano indefinido)'
          : `α do juiz ${fmt(agreementJ.alpha)} abaixo da faixa humano × humano nos mesmos itens (IC95% inferior ${fmt(faixa)})`,
      );
    }
    judge = {
      status: 'measured',
      judgeModels: [...new Set(julgados.map((i) => i.judgeModel).filter((m): m is string => !!m))].sort(),
      agreement: agreementJ,
      humanSameItems: humanSame,
      deltaVsHuman: { value: delta(julgados), ci95: bootstrapCi(julgados, delta, opts) },
      withinHumanBand,
      acceptable: alphaJOk && withinHumanBand === true,
      gold: goldDiagnostics(julgados),
    };
  }

  // Prontidão do CONJUNTO: diz se a medida vale como calibração. Só reprova o
  // portão com `strict` (o contrato default é "exit ≠ 0 se α < 0,667").
  const issues: string[] = [];
  if (synthetic) issues.push(`${synthetic} item(ns) SINTÉTICO(S): não são rótulos humanos reais — não vale como calibração`);
  if (domains.length > 1) issues.push(`a calibração é POR domínio, e o arquivo mistura ${domains.length}: ${domains.join(', ')}`);
  if (pilot) {
    if (completos.length < PILOT_MIN_ITEMS) {
      issues.push(`piloto com ${completos.length} item(ns) completo(s) (recomendado ${PILOT_MIN_ITEMS}–${PILOT_MAX_ITEMS})`);
    }
  } else {
    if (completos.length < MIN_ITEMS) {
      issues.push(`${completos.length} item(ns) completo(s) (mínimo ${MIN_ITEMS} com ≥ 2 rótulos humanos)`);
    }
    for (const v of VERDICT_SCALE) {
      if (byClass[v] < MIN_PER_STRATUM) issues.push(`classe "${v}": ${byClass[v]} item(ns) (mínimo ${MIN_PER_STRATUM})`);
    }
    if (byClass.empate) issues.push(`${byClass.empate} item(ns) sem classe (empate entre anotadores e sem "gold") — adjudique`);
    for (const [t, c] of Object.entries(byTaskType).sort()) {
      if (c < MIN_PER_STRATUM) issues.push(`tipo de tarefa "${t}": ${c} item(ns) (mínimo ${MIN_PER_STRATUM})`);
    }
    const wH = largura(human.alphaCi95);
    if (wH === null || wH > MAX_CI_WIDTH) {
      issues.push(`IC95% do α humano ${wH === null ? 'indefinido' : `com largura ${wH.toFixed(3)}`} (máximo ${MAX_CI_WIDTH})`);
    }
    if (judge.status === 'measured') {
      const wJ = largura(judge.agreement.alphaCi95);
      if (wJ === null || wJ > MAX_CI_WIDTH) {
        issues.push(`IC95% do α do juiz ${wJ === null ? 'indefinido' : `com largura ${wJ.toFixed(3)}`} (máximo ${MAX_CI_WIDTH})`);
      }
      if (judge.judgeModels.length > 1) {
        issues.push(`vereditos de ${judge.judgeModels.length} juízes misturados (${judge.judgeModels.join(', ')}) — calibre um setup por vez`);
      }
    } else if (judge.reason === 'no_judge_labels') {
      issues.push('sem "judgeVerdict": o juiz não foi medido');
    }
  }
  if (options.strict === true && issues.length) {
    reprova(
      'gate.calibration_not_ready',
      `o conjunto não cumpre o protocolo (--strict): ${issues.length} pendência(s) de prontidão`,
    );
  }

  return {
    format: CALIBRATION_REPORT_FORMAT,
    mode: pilot ? 'pilot' : 'full',
    thresholds: {
      alphaMin: ALPHA_MIN,
      alphaTrust: ALPHA_TRUST,
      minItems: MIN_ITEMS,
      minPerStratum: MIN_PER_STRATUM,
      pilotItems: [PILOT_MIN_ITEMS, PILOT_MAX_ITEMS],
      maxCiWidth: MAX_CI_WIDTH,
    },
    items: {
      total: items.length,
      complete: completos.length,
      incomplete: items.length - completos.length,
      synthetic,
      withJudge: items.filter((i) => i.judgeVerdict).length,
      withGold: items.filter((i) => i.gold).length,
    },
    domains,
    annotators,
    strata: { byClass, classSource, byTaskType },
    human,
    judge,
    readiness: { ready: issues.length === 0, issues },
    gate,
  };
}
