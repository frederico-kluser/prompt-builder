// Modo JEV — o DOSSIÊ de uma pergunta para o proponente (matéria-prima das
// lições, como as lições GEPA do treino LLM): matriz de confusão, pares mais
// confundidos, erros com confiança alta, acertos inseguros, abstenções e flips.
// Usa SÓ o split de treino: o proponente nunca vê `calib` nem `holdout`.

import type { JevCase, JevQuestionSpec, JevRunRecord, JevSpec } from './types.js';
import { projectState, expectedList } from './wire.js';
import { aggregateReps, cellIndex, policyFor, scoreDist } from './scoring.js';

export interface JevDossierCase {
  caseId: string;
  state: string;
  gold: string;
  predicted: string;
  pTop: number;
}

export interface JevDossier {
  questionId: string;
  type: JevQuestionSpec['type'];
  n: number;
  accuracy: number;
  /** "ouro→previsto" → n (só erros). */
  confusion: Record<string, number>;
  /** Pares (ouro, previsto) mais confundidos, desc. */
  topConfusions: { gold: string; predicted: string; n: number }[];
  wrongConfident: JevDossierCase[];
  rightUnsure: JevDossierCase[];
  flipped: string[];
  /** Ids dos casos que APARECEM no dossiê (auditoria de vazamento). */
  caseIds: string[];
}

function clip(state: unknown, max: number): string {
  const t = typeof state === 'string' ? state : JSON.stringify(state);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function buildJevDossier(
  run: Pick<JevRunRecord, 'cells' | 'config'>,
  spec: JevSpec,
  contestantId: string,
  qid: string,
  trainCases: readonly JevCase[],
  opts: { maxCases?: number; maxStateChars?: number } = {},
): JevDossier | null {
  const q = spec.questions.find((x) => x.id === qid);
  if (!q) return null;
  const max = opts.maxCases ?? 12;
  const maxChars = opts.maxStateChars ?? 600;
  const idx = cellIndex(run.cells);
  const itens: { c: JevCase; it: ReturnType<typeof scoreDist> }[] = [];
  for (const c of trainCases) {
    if (c.split !== 'train') continue;
    const gold = expectedList(c.expected[qid]);
    if (!gold.length) continue;
    const oc = aggregateReps(q, idx.get(`${c.id}\u0000${contestantId}`) ?? []);
    if (!oc.dist) continue;
    const it = scoreDist(q, c.id, oc.dist, c.expected[qid], policyFor(spec, q, run.config.bands), {
      tolerance: run.config.scoreTolerance,
      invalid: oc.invalid,
      flipped: oc.flipped,
    });
    itens.push({ c, it });
  }
  const confusion: Record<string, number> = {};
  for (const { c, it } of itens) {
    if (it.correct) continue;
    const g = String(expectedList(c.expected[qid])[0]);
    const p = it.predicted === null ? '∅' : String(it.predicted);
    confusion[`${g}→${p}`] = (confusion[`${g}→${p}`] ?? 0) + 1;
  }
  const topConfusions = Object.entries(confusion)
    .map(([k, n]) => {
      const [gold, predicted] = k.split('→');
      return { gold, predicted, n };
    })
    .sort((a, b) => b.n - a.n || a.gold.localeCompare(b.gold));
  const caso = ({ c, it }: (typeof itens)[number]): JevDossierCase => ({
    caseId: c.id,
    state: clip(projectState(c.state, spec.stateView), maxChars),
    gold: String(expectedList(c.expected[qid])[0]),
    predicted: it.predicted === null ? '∅' : String(it.predicted),
    pTop: Number(it.pTop.toFixed(3)),
  });
  const wrongConfident = itens
    .filter((x) => !x.it.correct)
    .sort((a, b) => b.it.pTop - a.it.pTop)
    .slice(0, max)
    .map(caso);
  const rightUnsure = itens
    .filter((x) => x.it.correct)
    .sort((a, b) => a.it.pTop - b.it.pTop)
    .slice(0, Math.max(0, max - wrongConfident.length))
    .map(caso);
  const flipped = itens.filter((x) => x.it.flipped).map((x) => x.c.id);
  const caseIds = [...new Set([...wrongConfident, ...rightUnsure].map((x) => x.caseId))];
  return {
    questionId: qid,
    type: q.type,
    n: itens.length,
    accuracy: itens.length ? itens.filter((x) => x.it.correct).length / itens.length : 0,
    confusion,
    topConfusions,
    wrongConfident,
    rightUnsure,
    flipped,
    caseIds,
  };
}
