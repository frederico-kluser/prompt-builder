// Derivações PURAS para as telas de resultado JEV (testáveis em Node). O record
// guarda as CÉLULAS (respostas cruas) e as métricas agregadas; o que a tela
// precisa por caso (acerto, p, banda) sai do MESMO `scoreRun` que o runner usou
// — nunca de uma segunda conta paralela.

import {
  canonicalLabelsOf,
  levelCountOf,
  scoreRun,
  type JevBin,
  type JevContestant,
  type JevQuestionSpec,
  type JevRunRecord,
  type JevScoredAnswer,
  type ScoredRun,
} from '../engine/jev';
import { statePreview } from './form';

/** Reaplica a pontuação do runner sobre o record (mesmas bandas, tolerância e política). */
export function rescoreRun(run: JevRunRecord): ScoredRun {
  return scoreRun({
    specs: run.specs,
    contestants: run.contestants,
    cases: run.cases,
    cells: run.cells,
    questionIds: run.questionIds,
    bands: run.config.bands,
    tolerance: run.config.scoreTolerance,
    repeats: run.config.repeats,
    incompleteCaseIds: new Set(run.incompleteCaseIds),
    ...(run.policy ? { fitted: run.policy } : {}),
  });
}

/** A pergunta (da definição do CONTROLE) pelo id. */
export function questionOf(run: JevRunRecord, qid: string): JevQuestionSpec | undefined {
  const ctrl = run.contestants.find((c) => c.isControl) ?? run.contestants[0];
  const spec = run.specs.find((s) => s.id === ctrl?.specId) ?? run.specs[0];
  return spec?.questions.find((q) => q.id === qid);
}

/**
 * Série categórica de um competidor: ORDEM FIXA pela posição na run (nunca
 * pelo ranking). A ordem dos tokens do tema foi escolhida pelo validador de
 * paleta (skill dataviz): chart-2 (ciano) e chart-3 (turquesa) lado a lado
 * falham a separação (ΔE 8,3); intercalados passam no tema claro. No escuro a
 * separação CVD fica abaixo do piso — por isso TODA série leva também um
 * MARCADOR distinto (círculo, quadrado, triângulo, losango), rótulo na legenda
 * e a tabela ao lado: a cor nunca é o único canal. Acima de 4 séries, o
 * gráfico mostra as 4 primeiras e a tabela carrega o resto.
 */
export const SERIES_COLORS = ['var(--chart-1)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-2)'] as const;
export const SERIES_SHAPES = ['circle', 'square', 'triangle', 'diamond'] as const;
export type SeriesShape = (typeof SERIES_SHAPES)[number];

export function contestantColor(i: number): string | null {
  return i < SERIES_COLORS.length ? SERIES_COLORS[i] : null;
}

export function contestantShape(i: number): SeriesShape {
  return SERIES_SHAPES[i % SERIES_SHAPES.length];
}

// ---------------------------------------------------------------------------
// Grade caso × competidor
// ---------------------------------------------------------------------------

export type GridCellState = 'hit' | 'miss' | 'invalid' | 'noscore' | 'incomplete' | 'nogold';

export interface GridCell {
  contestantId: string;
  state: GridCellState;
  predicted: string | null;
  pTop: number | null;
  band: JevScoredAnswer['band'] | null;
  /** Errado dentro da banda auto ("errado com confiança"). */
  wrongConfident: boolean;
}

export interface GridRow {
  caseId: string;
  preview: string;
  gold: string;
  split?: string;
  cells: GridCell[];
}

function fmtLabel(v: unknown): string {
  if (v === true) return 'sim';
  if (v === false) return 'não';
  if (v === null || v === undefined) return '∅';
  return String(v);
}

export function caseGrid(run: JevRunRecord, scored: ScoredRun, qid: string): GridRow[] {
  const idx = new Map<string, JevScoredAnswer>();
  for (const [ct, items] of Object.entries(scored.items)) for (const it of items) if (it.qid === qid) idx.set(`${it.caseId}\u0000${ct}`, it);
  const incompletos = new Set(run.incompleteCaseIds);
  return run.cases.map((c) => {
    const ouro = c.expected[qid];
    const temOuro = ouro !== undefined && !(Array.isArray(ouro) && ouro.length === 0);
    const cells: GridCell[] = run.contestants.map((ct) => {
      const base = { contestantId: ct.id, predicted: null, pTop: null, band: null, wrongConfident: false };
      if (!temOuro) return { ...base, state: 'nogold' as const };
      if (incompletos.has(c.id)) return { ...base, state: 'incomplete' as const };
      const it = idx.get(`${c.id}\u0000${ct.id}`);
      if (!it) return { ...base, state: 'noscore' as const };
      return {
        contestantId: ct.id,
        state: it.invalid ? 'invalid' : it.correct ? 'hit' : 'miss',
        predicted: it.predicted === null ? null : fmtLabel(it.predicted),
        pTop: it.pTop,
        band: it.band,
        wrongConfident: !it.correct && it.band === 'auto',
      };
    });
    return {
      caseId: c.id,
      preview: statePreview(c.state, 90),
      gold: Array.isArray(ouro) ? ouro.map(fmtLabel).join(' | ') : fmtLabel(ouro),
      ...(c.split ? { split: c.split } : {}),
      cells,
    };
  });
}

// ---------------------------------------------------------------------------
// Matriz de confusão
// ---------------------------------------------------------------------------

export interface ConfusionTable {
  gold: string[];
  predicted: string[];
  counts: number[][];
  rowTotals: number[];
  max: number;
  n: number;
}

/** "ouro→previsto" → tabela, com os rótulos na ordem da definição (e ∅ = saída/abstenção). */
export function confusionTable(run: JevRunRecord, contestantId: string, qid: string): ConfusionTable {
  const tab = run.confusion[contestantId]?.[qid] ?? {};
  const q = questionOf(run, qid);
  const ordem: string[] =
    q?.type === 'noul'
      ? ['true', 'false']
      : q?.type === 'score'
        ? Array.from({ length: levelCountOf(q) }, (_, i) => String(i))
        : q
          ? canonicalLabelsOf(q)
          : [];
  const vistos = new Set<string>(ordem);
  const golds = new Set<string>();
  const preds = new Set<string>();
  for (const k of Object.keys(tab)) {
    const [g, p] = k.split('→');
    golds.add(g);
    preds.add(p);
  }
  const extras = (s: Set<string>) => [...s].filter((x) => !vistos.has(x)).sort();
  const gold = [...ordem.filter((x) => golds.has(x)), ...extras(golds)];
  const predicted = [...ordem, ...extras(preds)];
  const counts = gold.map((g) => predicted.map((p) => tab[`${g}→${p}`] ?? 0));
  const rowTotals = counts.map((r) => r.reduce((s, x) => s + x, 0));
  const max = Math.max(0, ...counts.flat());
  return { gold, predicted, counts, rowTotals, max, n: rowTotals.reduce((s, x) => s + x, 0) };
}

/** Rótulo legível de uma chave da matriz (true/false → sim/não; nível com o texto curto). */
export function confusionLabel(run: JevRunRecord, qid: string, key: string): string {
  if (key === '∅') return 'saída';
  const q = questionOf(run, qid);
  if (q?.type === 'noul') return key === 'true' ? 'sim' : key === 'false' ? 'não' : key;
  if (q?.type === 'score' && Array.isArray(q.criteria)) {
    const t = q.criteria[Number(key)];
    return typeof t === 'string' ? `${key} · ${t.length > 24 ? `${t.slice(0, 23)}…` : t}` : key;
  }
  return key;
}

// ---------------------------------------------------------------------------
// Confiabilidade
// ---------------------------------------------------------------------------

export interface ReliabilitySeries {
  contestant: JevContestant;
  index: number;
  bins: JevBin[];
  ece: number;
  n: number;
}

export function reliabilitySeries(run: JevRunRecord, qid: string | null): ReliabilitySeries[] {
  const out: ReliabilitySeries[] = [];
  run.contestants.forEach((ct, index) => {
    const m = qid ? run.byQuestion[ct.id]?.[qid] : run.metrics[ct.id];
    if (!m || m.nScored === 0 || m.ece === null) return;
    out.push({ contestant: ct, index, bins: m.bins.filter((b) => b.n > 0), ece: m.ece, n: m.nScored });
  });
  return out;
}

/** Decisão do gate por ciclo, em PT-BR (treino e relatório de ciclos usam a mesma). */
export const CYCLE_DECISION_LABEL: Record<string, string> = {
  baseline: 'linha de base',
  promoted: 'promovida',
  held: 'mantida',
  inconclusive: 'inconclusivo',
  stopped: 'parou',
};
