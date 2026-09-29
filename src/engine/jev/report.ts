// Modo JEV — resumos e relatórios (JSON + Markdown), puros. Responde as
// perguntas do relatório de ciclos LLM: quanto melhorou, quanto a mudança
// mexe no custo de USAR (só tokens de ENTRADA: a saída do Jev é grátis),
// quanto custou otimizar e quando se paga. Não depende de `sessionReport.ts`
// (outro time); só espelha a forma dele.

import type {
  JevCascade,
  JevComparison,
  JevMetrics,
  JevQuestionPolicy,
  JevRunRecord,
  JevSessionRecord,
  JevSpec,
} from './types.js';
import { headlineOf } from './scoring.js';
import { sessionVerdict } from './train.js';
import { isAliasModel } from './lint.js';

export const JEV_RUN_REPORT_FORMAT = 'prompt-builder-jev-run-report@1';
export const JEV_REPORT_FORMAT = 'prompt-builder-jev-report@1';
/** Decisões custam ~1000× menos que chamadas LLM: a projeção usa volume alto. */
export const DEFAULT_REQUESTS_PER_MONTH = 100_000;

// ---------------------------------------------------------------------------
// Formatação PT-BR
// ---------------------------------------------------------------------------

export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v === 0) return 'US$ 0';
  const abs = Math.abs(v);
  const casas = abs < 0.0001 ? 7 : abs < 0.01 ? 5 : abs < 1 ? 4 : 2;
  return `US$ ${v.toFixed(casas).replace('.', ',')}`;
}
export function fmtPct(v: number | null | undefined, casas = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(casas).replace('.', ',')}%`;
}
export function fmtPp(v: number | null | undefined, casas = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = v.toFixed(casas).replace('.', ',');
  return `${v > 0 ? '+' : ''}${s} p.p.`;
}
export function fmtNum(v: number | null | undefined, casas = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(casas).replace('.', ',');
}
export function fmtP(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  return p < 0.001 ? '< 0,001' : p.toFixed(3).replace('.', ',');
}
/** "p=0,003" ou "p < 0,001" (nunca "p=< 0,001"). */
export function fmtPLabel(p: number | null | undefined): string {
  const v = fmtP(p);
  return v.startsWith('<') ? `p ${v}` : `p=${v}`;
}
const ms = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);

// ---------------------------------------------------------------------------
// Resumo compacto (CLI --json, MCP get_result): nunca estado nem rubrica
// ---------------------------------------------------------------------------

export interface JevContestantRow {
  id: string;
  label: string;
  kind: 'decision' | 'llm';
  modelId: string;
  /** `null` (como ece/coverageAtAuto) = nada pontuado — impresso "—", nunca 0. */
  accuracy: number | null;
  macroF1: number | null;
  brierScore: number | null;
  brierWorstCase: number | null;
  ece: number | null;
  coverageAtAuto: number | null;
  precisionAtAuto: number | null;
  wrongAuto: number;
  p50Ms: number | null;
  p95Ms: number | null;
  costPer1kDecisions: number | null;
  costExact: boolean;
  flipRate: number | null;
  nScored: number;
  nNoScore: number;
  calibrated?: { brierScore: number | null; ece: number; coverageAtAuto: number; precisionAtAuto: number | null };
  rejected?: boolean;
}

function rowOf(run: JevRunRecord, id: string): JevContestantRow | null {
  const ct = run.contestants.find((c) => c.id === id);
  const m = run.metrics[id];
  if (!ct || !m) return null;
  const h = headlineOf(m);
  return {
    id,
    label: ct.label,
    kind: ct.kind,
    modelId: ct.modelId,
    accuracy: h.accuracy,
    macroF1: h.macroF1,
    brierScore: h.brierScore,
    brierWorstCase: m.brierWorstCase,
    ece: h.ece,
    coverageAtAuto: h.coverageAtAuto,
    precisionAtAuto: h.precisionAtAuto,
    wrongAuto: h.wrongAuto,
    p50Ms: h.p50Ms,
    p95Ms: h.p95Ms,
    costPer1kDecisions: h.costPer1kDecisions,
    costExact: h.costExact,
    flipRate: h.flipRate,
    nScored: m.nScored,
    nNoScore: m.nNoScore,
    ...(m.calibrated
      ? {
          calibrated: {
            brierScore: m.calibrated.brierScore,
            ece: m.calibrated.ece,
            coverageAtAuto: m.calibrated.coverageAtAuto,
            precisionAtAuto: m.calibrated.precisionAtAuto,
          },
        }
      : {}),
    ...(run.rejected?.[id] ? { rejected: true } : {}),
  };
}

export function summarizeJevRun(run: JevRunRecord): Record<string, unknown> {
  return {
    runId: run.id,
    kind: 'jev-run',
    mode: run.mode,
    status: run.status,
    theme: run.theme,
    stoppedReason: run.stoppedReason ?? null,
    budgetExhausted: Boolean(run.budgetExhausted),
    inconclusive: run.status === 'inconclusive',
    ...(run.inconclusiveReasons?.length ? { inconclusiveReasons: run.inconclusiveReasons } : {}),
    cases: run.cases.length,
    incompleteCases: run.incompleteCaseIds.length,
    questions: run.questionIds,
    resolvedModels: run.resolvedModels,
    contestants: run.contestants.map((c) => rowOf(run, c.id)).filter(Boolean),
    comparisons: (run.comparisons ?? []).map((c) => ({
      id: c.contestantId,
      vs: c.controlId,
      metric: c.metric,
      meanDiffPp: c.meanDiffPp,
      ci95Pp: c.ci95Pp,
      pValue: c.pValue,
      accuracyDiffPp: c.accuracyDiffPp,
      mcnemarP: c.mcnemarP,
    })),
    ...(run.cascade?.length
      ? {
          cascade: run.cascade.map((k) => ({
            decisionId: k.decisionId,
            llmId: k.llmId,
            atDefault: k.atDefault,
            escalationToMatchLlm: k.escalationToMatchLlm,
            decisionOnly: k.decisionOnly,
            llmOnly: k.llmOnly,
          })),
        }
      : {}),
    ...(run.rejected ? { rejected: Object.fromEntries(Object.entries(run.rejected).map(([k, v]) => [k, v.slice(0, 5)])) } : {}),
    warnings: run.warnings.slice(0, 20),
    totalCostUsd: run.totalCostUsd,
    pendingUsd: run.cost.pendingUsd,
    budgetUsd: run.budgetUsd ?? null,
    ...(run.error ? { error: run.error } : {}),
    ...(run.sessionId ? { sessionId: run.sessionId, iteration: run.iteration ?? null } : {}),
  };
}

export function summarizeJevSession(s: JevSessionRecord): Record<string, unknown> {
  const promovidas = s.iterations.filter((i) => i.gate.decision === 'promoted').length;
  return {
    sessionId: s.id,
    kind: 'jev-session',
    status: s.status,
    theme: s.theme,
    modelId: s.modelId,
    verdict: sessionVerdict(s),
    stoppedReason: s.stoppedReason ?? null,
    budgetExhausted: Boolean(s.budgetExhausted),
    iterations: s.iterations.map((i) => ({
      iteration: i.iteration,
      decision: i.gate.decision,
      candidates: i.candidates.map((c) => ({ label: c.label, operator: c.operatorId, status: c.status, ...(c.reason ? { reason: c.reason } : {}) })),
      controlScorePp: i.gate.controlScorePp,
      meanDiffPp: i.gate.meanDiffPp,
      pAdjusted: i.gate.pAdjusted,
      minGainPp: i.gate.minGainPp,
      heldBy: i.gate.heldBy ?? [],
      costUsd: i.costUsd,
    })),
    promotions: promovidas,
    championChanged: s.championSpec.id !== s.originalSpec.id,
    holdout: s.holdout
      ? {
          n: s.holdout.n,
          strength: s.holdout.strength,
          regressed: s.holdout.regressed,
          text: s.holdout.text,
          ...(s.holdout.comparison
            ? { meanDiffPp: s.holdout.comparison.meanDiffPp, ci95Pp: s.holdout.comparison.ci95Pp, pValue: s.holdout.comparison.pValue, accuracyDiffPp: s.holdout.comparison.accuracyDiffPp }
            : {}),
        }
      : null,
    policy: s.policy,
    resolvedModels: s.resolvedModels,
    runIds: s.runIds,
    warnings: s.warnings.slice(0, 20),
    totalCostUsd: s.totalCostUsd,
    pendingUsd: s.cost.pendingUsd,
    budgetUsd: s.budgetUsd ?? null,
    ...(s.error ? { error: s.error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Relatório de RUN (eval/compare)
// ---------------------------------------------------------------------------

export interface JevRunReport {
  format: typeof JEV_RUN_REPORT_FORMAT;
  generatedAt: string;
  run: { id: string; mode: string; status: string; theme: string; cases: number; repeats: number; client: string; startedAt: string; finishedAt?: string };
  contestants: JevContestantRow[];
  byQuestion: {
    question: string;
    contestant: string;
    accuracy: number | null;
    brierScore: number | null;
    ece: number | null;
    coverageAtAuto: number | null;
    precisionAtAuto: number | null;
    nScored: number;
  }[];
  comparisons: JevComparison[];
  cascade: JevCascade[];
  policy: Record<string, Record<string, JevQuestionPolicy>>;
  cost: { totalUsd: number; pendingUsd: number; byKind: { decision: number; llm: number } };
  warnings: string[];
}

export function runWarnings(run: JevRunRecord): string[] {
  const w: string[] = [];
  if (run.status === 'inconclusive') w.push(`run INCONCLUSIVA: ${(run.inconclusiveReasons ?? []).join('; ')}`);
  if (run.incompleteCaseIds.length) w.push(`${run.incompleteCaseIds.length} caso(s) incompleto(s) (orçamento/cancelamento) FORA das métricas e comparações.`);
  if (Object.values(run.metrics).some((m) => !m.costExact)) w.push('custo com chamadas não medidas ou pendentes: o total é limite inferior até conciliar.');
  for (const ct of run.contestants) {
    if (ct.kind === 'decision' && isAliasModel(ct.modelId)) w.push(`${ct.modelId} é alias móvel: fixe a versão para calibrar limiares.`);
    if (ct.kind === 'llm') w.push(`${ct.label}: probabilidade VERBALIZADA (não calibrada) — compare acurácia e custo, e o Brier com cautela.`);
  }
  if (run.config.language && /^pt/i.test(run.config.language)) w.push('pt-BR: o Jev não tem avaliação oficial fora do inglês — estes números SÃO a avaliação.');
  if (run.config.bands.noul.hitl !== 0.5) w.push(`noul com hitl ${fmtNum(run.config.bands.noul.hitl, 2)} (o simulador e a skill usam 0,5, onde uma noul nunca abstém).`);
  return [...w, ...run.warnings];
}

export function buildJevRunReport(run: JevRunRecord, now: Date = new Date()): JevRunReport {
  const byQuestion: JevRunReport['byQuestion'] = [];
  const rotulo = new Map(run.contestants.map((c) => [c.id, c.label]));
  for (const [ct, qs] of Object.entries(run.byQuestion)) {
    for (const [q, m] of Object.entries(qs)) {
      byQuestion.push({
        question: q,
        contestant: rotulo.get(ct) ?? ct,
        accuracy: m.accuracy,
        brierScore: m.brierScore,
        ece: m.ece,
        coverageAtAuto: m.coverageAtAuto,
        precisionAtAuto: m.precisionAtAuto,
        nScored: m.nScored,
      });
    }
  }
  return {
    format: JEV_RUN_REPORT_FORMAT,
    generatedAt: now.toISOString(),
    run: {
      id: run.id,
      mode: run.mode,
      status: run.status,
      theme: run.theme,
      cases: run.cases.length,
      repeats: run.config.repeats,
      client: run.client,
      startedAt: run.startedAt,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    },
    contestants: run.contestants.map((c) => rowOf(run, c.id)).filter((x): x is JevContestantRow => x !== null),
    byQuestion,
    comparisons: run.comparisons ?? [],
    cascade: run.cascade ?? [],
    policy: run.policy ?? {},
    cost: { totalUsd: run.cost.totalUsd, pendingUsd: run.cost.pendingUsd, byKind: { decision: run.cost.byKind.decision, llm: run.cost.byKind.llm } },
    warnings: runWarnings(run),
  };
}

export function renderJevRunReportMarkdown(r: JevRunReport): string {
  const L: string[] = [];
  L.push(`# Relatório JEV — ${r.run.theme}`);
  L.push('');
  L.push(`Run \`${r.run.id}\` · modo **${r.run.mode}** · status **${r.run.status}** · ${r.run.cases} casos × ${r.run.repeats} rep. · cliente ${r.run.client}`);
  L.push('');
  L.push('## Competidores');
  L.push('');
  L.push('| Competidor | Acurácia | Macro-F1 | Brier (p.p.) | ECE | Cobertura auto | Precisão auto | Errado c/ confiança | p50 / p95 | US$ / 1k decisões |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const c of r.contestants) {
    L.push(
      `| ${c.label}${c.rejected ? ' (RECUSADO)' : ''} | ${fmtPct(c.accuracy)} | ${fmtPct(c.macroF1)} | ${fmtNum(c.brierScore, 1)} | ${fmtNum(c.ece, 3)} | ${fmtPct(c.coverageAtAuto)} | ${fmtPct(c.precisionAtAuto)} | ${c.wrongAuto} | ${ms(c.p50Ms)} / ${ms(c.p95Ms)} | ${fmtUsd(c.costPer1kDecisions)}${c.costExact ? '' : ' *'} |`,
    );
  }
  if (r.contestants.some((c) => !c.costExact)) L.push('', '\\* custo não exato (chamada sem `usage.cost` ou pendente de conciliação).');
  if (r.contestants.some((c) => c.calibrated)) {
    L.push('', '### Calibrado (política ajustada no split `calib`, medida FORA dele)', '');
    L.push('| Competidor | Brier (p.p.) | ECE | Cobertura auto | Precisão auto |');
    L.push('|---|---|---|---|---|');
    for (const c of r.contestants) {
      if (!c.calibrated) continue;
      L.push(`| ${c.label} | ${fmtNum(c.calibrated.brierScore, 1)} | ${fmtNum(c.calibrated.ece, 3)} | ${fmtPct(c.calibrated.coverageAtAuto)} | ${fmtPct(c.calibrated.precisionAtAuto)} |`);
    }
  }
  L.push('', '## Por pergunta', '');
  L.push('| Pergunta | Competidor | n | Acurácia | Brier (p.p.) | ECE | Cobertura auto | Precisão auto |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const q of r.byQuestion) {
    L.push(`| ${q.question} | ${q.contestant} | ${q.nScored} | ${fmtPct(q.accuracy)} | ${fmtNum(q.brierScore, 1)} | ${fmtNum(q.ece, 3)} | ${fmtPct(q.coverageAtAuto)} | ${fmtPct(q.precisionAtAuto)} |`);
  }
  if (r.comparisons.length) {
    L.push('', '## Comparação pareada contra o controle', '');
    L.push('| Competidor | Métrica | Δ | IC95% | p (bilateral) | Δ acurácia | McNemar p |');
    L.push('|---|---|---|---|---|---|---|');
    for (const c of r.comparisons) {
      L.push(
        `| ${c.contestantId} | ${c.metric} | ${fmtPp(c.meanDiffPp, 2)} | ${c.ci95Pp ? `[${fmtNum(c.ci95Pp[0], 2)}; ${fmtNum(c.ci95Pp[1], 2)}]` : '—'} | ${fmtP(c.pValue)} | ${fmtPp(c.accuracyDiffPp, 1)} | ${fmtP(c.mcnemarP)} |`,
      );
    }
  }
  if (r.cascade.length) {
    L.push('', '## Cascata (decisão na banda auto, resto escala para o LLM)', '');
    L.push('| Decisão → LLM | Acurácia | % escalado | US$ / 1k | Escala p/ empatar com o LLM |');
    L.push('|---|---|---|---|---|');
    for (const k of r.cascade) {
      L.push(
        `| ${k.decisionId} → ${k.llmId} | ${fmtPct(k.atDefault.accuracy)} | ${fmtPct(k.atDefault.escalatedRate)} | ${fmtUsd(k.atDefault.costPer1kDecisions)} | ${k.escalationToMatchLlm === null ? 'nunca empata' : fmtPct(k.escalationToMatchLlm)} |`,
      );
    }
  }
  L.push('', '## Custo', '');
  L.push(`Total medido: **${fmtUsd(r.cost.totalUsd)}** (decisões ${fmtUsd(r.cost.byKind.decision)}, LLM ${fmtUsd(r.cost.byKind.llm)})${r.cost.pendingUsd > 0 ? ` · pendente de conciliação: ${fmtUsd(r.cost.pendingUsd)}` : ''}.`);
  if (r.warnings.length) {
    L.push('', '## Avisos', '');
    for (const w of r.warnings) L.push(`- ${w}`);
  }
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Relatório de SESSÃO (treino)
// ---------------------------------------------------------------------------

/** Linhas adicionadas/removidas entre dois textos (LCS por linha). */
export function lineDiffCounts(a: string, b: string): { added: number; removed: number } {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const comuns = dp[0][0];
  return { added: m - comuns, removed: n - comuns };
}

export interface JevHeadline {
  accuracy: number | null;
  macroF1: number | null;
  brierScore: number | null;
  ece: number | null;
  coverageAtAuto: number | null;
  precisionAtAuto: number | null;
}

function headline(m: JevMetrics | null | undefined, calibrated: boolean): JevHeadline {
  if (!m) return { accuracy: null, macroF1: null, brierScore: null, ece: null, coverageAtAuto: null, precisionAtAuto: null };
  const c = calibrated ? m.calibrated : undefined;
  return {
    accuracy: m.accuracy,
    macroF1: m.macroF1 ?? null,
    brierScore: c?.brierScore ?? m.brierScore,
    ece: c?.ece ?? m.ece,
    coverageAtAuto: c?.coverageAtAuto ?? m.coverageAtAuto,
    precisionAtAuto: c?.precisionAtAuto ?? m.precisionAtAuto,
  };
}

export interface JevUseCost {
  n: number;
  meanTokensIn: number | null;
  meanCostUsd: number | null;
  p50Ms: number | null;
}

export interface JevSessionReport {
  format: typeof JEV_REPORT_FORMAT;
  generatedAt: string;
  session: {
    id: string;
    status: string;
    theme: string;
    modelId: string;
    resolvedModels: string[];
    startedAt: string;
    finishedAt?: string;
    iterationsPlanned: number;
    cyclesRun: number;
    promotions: number;
    stoppedReason: string | null;
    budgetUsd: number | null;
    rewriterModelId: string | null;
    targetQuestions: string[];
    nCases: { train: number; calib: number; holdout: number };
  };
  spec: {
    changed: boolean;
    changedQuestions: string[];
    promotedAtIteration: number | null;
    diff: Record<string, { operators: string[]; linesAdded: number; linesRemoved: number }>;
    original: JevSpec;
    champion: JevSpec;
  };
  quality: {
    source: 'holdout' | 'none';
    basis: string;
    original: JevHeadline;
    champion: JevHeadline;
    deltaPp: { accuracy: number | null; brierScore: number | null; coverageAtAuto: number | null };
    n: number;
    ci95Pp: [number, number] | null;
    pValue: number | null;
    regressed: boolean;
  };
  cycles: {
    iteration: number;
    decision: string;
    operators: string[];
    evaluated: number;
    rejectedLocal: number;
    controlScorePp: number | null;
    bestGainPp: number | null;
    gainCorrectedPp: number | null;
    pAdjusted: number | null;
    minGainPp: number;
    accuracyDeltaPp: number | null;
    excludedExamples: number;
    costUsd: number;
    cumulativeCostUsd: number;
    heldBy: string[];
  }[];
  cost: {
    basis: string;
    original: JevUseCost;
    champion: JevUseCost;
    deltaTokensIn: number | null;
    deltaCostPct: number | null;
    per1kRequests: { originalUsd: number; championUsd: number; deltaUsd: number } | null;
    projection: { requestsPerMonth: number; originalUsd: number; championUsd: number; deltaUsd: number } | null;
    /** Só se a campeã for MAIS BARATA: requests até pagar a otimização. */
    paybackRequests: number | null;
    /** Só se custar MAIS e ganhar qualidade: US$ extra por 1k requests por p.p. ganho. */
    extraUsdPer1kPerPp: number | null;
  };
  policy: Record<string, JevQuestionPolicy>;
  optimization: {
    totalUsd: number;
    pendingUsd: number;
    byKind: { decision: number; rewriter: number };
    budgetUsd: number | null;
    budgetUsedPct: number | null;
    perCycleMeanUsd: number | null;
  };
  verdict: ReturnType<typeof sessionVerdict>;
  headline: string;
  warnings: string[];
}

function useCost(run: JevRunRecord | undefined, ctId: string | undefined): JevUseCost {
  if (!run || !ctId) return { n: 0, meanTokensIn: null, meanCostUsd: null, p50Ms: null };
  const cs = run.cells.filter((c) => c.contestantId === ctId && c.status !== 'skipped' && typeof c.tokensIn === 'number');
  const tok = cs.map((c) => c.tokensIn as number);
  const usd = cs.filter((c) => c.cost?.source === 'usage').map((c) => c.cost!.usd);
  const m = (xs: number[]): number | null => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  return { n: cs.length, meanTokensIn: m(tok), meanCostUsd: m(usd), p50Ms: run.metrics[ctId]?.latencyP50 ?? null };
}

export function buildJevSessionReport(
  s: JevSessionRecord,
  runs: readonly JevRunRecord[],
  opts: { requestsPerMonth?: number; now?: Date } = {},
): JevSessionReport {
  const porId = new Map(runs.map((r) => [r.id, r]));
  const t = s.config.train;
  const ciclos = s.iterations.filter((i) => i.iteration > 0);
  const promovidas = ciclos.filter((i) => i.gate.decision === 'promoted');
  const changed = s.championSpec.id !== s.originalSpec.id;
  const diff: JevSessionReport['spec']['diff'] = {};
  const changedQuestions: string[] = [];
  for (const q of s.originalSpec.questions) {
    const c = s.championSpec.questions.find((x) => x.id === q.id);
    const a = JSON.stringify(q, null, 2);
    const b = JSON.stringify(c ?? null, null, 2);
    if (a === b) continue;
    changedQuestions.push(q.id);
    const d = lineDiffCounts(a, b);
    const ops = promovidas
      .map((i) => i.candidates.find((k) => k.specId === i.gate.bestSpecId)?.operatorId)
      .filter((x): x is NonNullable<typeof x> => Boolean(x));
    diff[q.id] = { operators: [...new Set(ops)], linesAdded: d.added, linesRemoved: d.removed };
  }
  const h = s.holdout;
  const hRun = h?.runId ? porId.get(h.runId) : undefined;
  const cmp = h?.comparison;
  const orig = headline(h?.original, true);
  const camp = headline(h?.champion, true);
  const quality: JevSessionReport['quality'] = {
    source: cmp ? 'holdout' : 'none',
    basis: h?.text ?? 'sem holdout',
    original: orig,
    champion: camp,
    deltaPp: {
      accuracy: orig.accuracy !== null && camp.accuracy !== null ? 100 * (camp.accuracy - orig.accuracy) : null,
      brierScore: orig.brierScore !== null && camp.brierScore !== null ? camp.brierScore - orig.brierScore : null,
      coverageAtAuto: orig.coverageAtAuto !== null && camp.coverageAtAuto !== null ? 100 * (camp.coverageAtAuto - orig.coverageAtAuto) : null,
    },
    n: h?.n ?? 0,
    ci95Pp: cmp?.ci95Pp ?? null,
    pValue: cmp?.pValue ?? null,
    regressed: Boolean(h?.regressed),
  };

  // Custo de USAR: pareado no holdout; sem ele, o último ciclo (controle × campeã).
  let costBasis = 'holdout (mesmos casos, pareado)';
  let oc = useCost(hRun, cmp?.controlId);
  let cc = useCost(hRun, cmp?.contestantId);
  if (!hRun) {
    const ultimo = [...promovidas].pop();
    const r = ultimo?.runId ? porId.get(ultimo.runId) : undefined;
    const ctCamp = r?.contestants.find((c) => c.specId === ultimo?.gate.bestSpecId)?.id;
    const ctCtrl = r?.contestants.find((c) => c.isControl)?.id;
    oc = useCost(r, ctCtrl);
    cc = useCost(r, ctCamp);
    costBasis = r ? `ciclo ${ultimo!.iteration} (treino, controle × campeã)` : 'sem dados';
  }
  const precoToken = ((): number | null => {
    const todas = runs.flatMap((r) => r.cells).filter((c) => c.cost?.source === 'usage' && (c.tokensIn ?? 0) > 0);
    const usd = todas.reduce((s2, c) => s2 + (c.cost?.usd ?? 0), 0);
    const tok = todas.reduce((s2, c) => s2 + (c.tokensIn ?? 0), 0);
    return tok > 0 ? usd / tok : null;
  })();
  const deltaTok = oc.meanTokensIn !== null && cc.meanTokensIn !== null ? cc.meanTokensIn - oc.meanTokensIn : null;
  const per1k =
    precoToken !== null && oc.meanTokensIn !== null && cc.meanTokensIn !== null
      ? { originalUsd: 1000 * oc.meanTokensIn * precoToken, championUsd: 1000 * cc.meanTokensIn * precoToken, deltaUsd: 1000 * (cc.meanTokensIn - oc.meanTokensIn) * precoToken }
      : null;
  const rpm = opts.requestsPerMonth ?? DEFAULT_REQUESTS_PER_MONTH;
  const projection = per1k ? { requestsPerMonth: rpm, originalUsd: (per1k.originalUsd * rpm) / 1000, championUsd: (per1k.championUsd * rpm) / 1000, deltaUsd: (per1k.deltaUsd * rpm) / 1000 } : null;
  const ganhoPp = quality.deltaPp.brierScore;
  const payback = per1k && per1k.deltaUsd < 0 ? Math.ceil(s.totalCostUsd / (-per1k.deltaUsd / 1000)) : null;
  const extraPorPp = per1k && per1k.deltaUsd > 0 && ganhoPp !== null && ganhoPp > 0 ? per1k.deltaUsd / ganhoPp : null;

  let acumulado = s.iterations.find((i) => i.iteration === 0)?.costUsd ?? 0;
  const cycles = ciclos.map((i) => {
    acumulado += i.costUsd;
    const idx = i.gate.bestSpecId ? i.candidates.filter((c) => c.status === 'evaluated').findIndex((c) => c.specId === i.gate.bestSpecId) : -1;
    const ganho = idx >= 0 ? i.gate.meanDiffPp[idx] ?? null : null;
    return {
      iteration: i.iteration,
      decision: i.gate.decision,
      operators: i.candidates.map((c) => c.operatorId),
      evaluated: i.candidates.filter((c) => c.status === 'evaluated').length,
      rejectedLocal: i.candidates.filter((c) => c.status !== 'evaluated').length,
      controlScorePp: i.gate.controlScorePp,
      bestGainPp: ganho,
      gainCorrectedPp: ganho !== null ? ganho - i.gate.winnersCurseInflationPp : null,
      pAdjusted: idx >= 0 ? i.gate.pAdjusted[idx] ?? null : null,
      minGainPp: i.gate.minGainPp,
      accuracyDeltaPp: i.gate.accuracyDeltaPp ?? null,
      excludedExamples: i.gate.excludedExampleCaseIds.length,
      costUsd: i.costUsd,
      cumulativeCostUsd: acumulado,
      heldBy: i.gate.heldBy ?? [],
    };
  });

  const verdict = sessionVerdict(s);
  const warnings: string[] = [...s.warnings];
  if (s.resolvedModels.length > 1) warnings.push(`snapshot-drift: ${s.resolvedModels.join(', ')}`);
  if (isAliasModel(s.modelId)) warnings.push(`${s.modelId} é alias: a política ajustada vale só para o snapshot ${s.resolvedModels[0] ?? '?'}.`);
  if (h && h.strength !== 'holdout') warnings.push(h.text);
  if (s.cost.pendingUsd > 0) warnings.push(`custo pendente de conciliação: ${fmtUsd(s.cost.pendingUsd)}.`);
  if (s.config.language && /^pt/i.test(s.config.language)) warnings.push('pt-BR: sem avaliação oficial do Jev — estes números SÃO a avaliação.');
  const headlineText = ((): string => {
    if (verdict === 'sem-mudanca') return `Nenhuma variante passou no gate em ${ciclos.length} ciclo(s): a definição original segue campeã (custo da tentativa: ${fmtUsd(s.totalCostUsd)}).`;
    const acc = camp.accuracy !== null ? fmtPct(camp.accuracy) : '—';
    const d = quality.deltaPp.accuracy;
    const custo = per1k ? ` e custa ${per1k.deltaUsd >= 0 ? '+' : ''}${fmtNum(per1k.originalUsd > 0 ? (100 * per1k.deltaUsd) / per1k.originalUsd : 0, 1)}% por request (${fmtUsd((per1k.deltaUsd * rpm) / 1000)} por ${rpm.toLocaleString('pt-BR')} decisões)` : '';
    const base = `A definição campeã acertou ${acc} (${fmtPp(d, 1)} de acurácia, Brier ${fmtPp(quality.deltaPp.brierScore, 1)}, ${fmtPLabel(quality.pValue)} no holdout)${custo}.`;
    if (verdict === 'piorou') return `REGREDIU no holdout — não promova. ${base}`;
    if (verdict === 'inconclusivo') return `Inconclusivo (${h?.text ?? 'sem holdout'}). ${base}`;
    return base;
  })();
  return {
    format: JEV_REPORT_FORMAT,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    session: {
      id: s.id,
      status: s.status,
      theme: s.theme,
      modelId: s.modelId,
      resolvedModels: s.resolvedModels,
      startedAt: s.startedAt,
      ...(s.finishedAt ? { finishedAt: s.finishedAt } : {}),
      iterationsPlanned: t?.iterations ?? 0,
      cyclesRun: ciclos.length,
      promotions: promovidas.length,
      stoppedReason: s.stoppedReason ?? null,
      budgetUsd: s.budgetUsd ?? null,
      rewriterModelId: t?.rewriterModelId ?? null,
      targetQuestions: t?.targetQuestions ?? [],
      nCases: countSplits(runs, s),
    },
    spec: {
      changed,
      changedQuestions,
      promotedAtIteration: promovidas.length ? promovidas[promovidas.length - 1].iteration : null,
      diff,
      original: s.originalSpec,
      champion: s.championSpec,
    },
    quality,
    cycles,
    cost: {
      basis: costBasis,
      original: oc,
      champion: cc,
      deltaTokensIn: deltaTok,
      deltaCostPct: per1k && per1k.originalUsd > 0 ? (100 * per1k.deltaUsd) / per1k.originalUsd : null,
      per1kRequests: per1k,
      projection,
      paybackRequests: payback,
      extraUsdPer1kPerPp: extraPorPp,
    },
    policy: s.policy,
    optimization: {
      totalUsd: s.totalCostUsd,
      pendingUsd: s.cost.pendingUsd,
      byKind: { decision: s.cost.byKind.decision, rewriter: s.cost.byKind.rewriter },
      budgetUsd: s.budgetUsd ?? null,
      budgetUsedPct: s.budgetUsd ? (100 * s.totalCostUsd) / s.budgetUsd : null,
      perCycleMeanUsd: ciclos.length ? ciclos.reduce((a, i) => a + i.costUsd, 0) / ciclos.length : null,
    },
    verdict,
    headline: headlineText,
    warnings,
  };
}

function countSplits(runs: readonly JevRunRecord[], s: JevSessionRecord): { train: number; calib: number; holdout: number } {
  const casos = new Map<string, string>();
  for (const r of runs) {
    if (r.sessionId !== s.id) continue;
    for (const c of r.cases) casos.set(c.id, c.split ?? 'train');
  }
  const out = { train: 0, calib: 0, holdout: 0 };
  for (const sp of casos.values()) out[sp as keyof typeof out] = (out[sp as keyof typeof out] ?? 0) + 1;
  return out;
}

export function renderJevSessionReportMarkdown(r: JevSessionReport): string {
  const L: string[] = [];
  L.push(`# Relatório de ciclos JEV — ${r.session.theme}`);
  L.push('');
  L.push(`**Veredito: ${r.verdict}.** ${r.headline}`);
  L.push('');
  L.push(
    `Sessão \`${r.session.id}\` · modelo ${r.session.modelId}${r.session.resolvedModels.length ? ` (${r.session.resolvedModels.join(', ')})` : ''} · ${r.session.cyclesRun}/${r.session.iterationsPlanned} ciclos · ${r.session.promotions} promoção(ões)${r.session.stoppedReason ? ` · parou por ${r.session.stoppedReason}` : ''}`,
  );
  L.push(`Perguntas-alvo: ${r.session.targetQuestions.join(', ') || '—'} · casos: treino ${r.session.nCases.train}, calib ${r.session.nCases.calib}, holdout ${r.session.nCases.holdout}`);
  L.push('', '## Qualidade (holdout, política ajustada)', '');
  L.push('| | Acurácia | Brier (p.p.) | ECE | Cobertura auto | Precisão auto |');
  L.push('|---|---|---|---|---|---|');
  const linha = (nome: string, h: JevHeadline): string =>
    `| ${nome} | ${fmtPct(h.accuracy)} | ${fmtNum(h.brierScore, 1)} | ${fmtNum(h.ece, 3)} | ${fmtPct(h.coverageAtAuto)} | ${fmtPct(h.precisionAtAuto)} |`;
  L.push(linha('Original', r.quality.original));
  L.push(linha('Campeã', r.quality.champion));
  L.push('');
  L.push(`Δ acurácia ${fmtPp(r.quality.deltaPp.accuracy)} · Δ Brier ${fmtPp(r.quality.deltaPp.brierScore)} · IC95% ${r.quality.ci95Pp ? `[${fmtNum(r.quality.ci95Pp[0], 2)}; ${fmtNum(r.quality.ci95Pp[1], 2)}]` : '—'} · ${fmtPLabel(r.quality.pValue)} · ${r.quality.basis}`);
  L.push('', '## Ciclos', '');
  L.push('| Ciclo | Decisão | Operadores | Avaliadas | Ganho | Ganho corrigido | p ajustado | minGain | Δ acurácia | Exemplos fora do gate | Custo | Acumulado |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of r.cycles) {
    L.push(
      `| ${c.iteration} | ${c.decision} | ${c.operators.join(', ') || '—'} | ${c.evaluated} | ${fmtPp(c.bestGainPp, 2)} | ${fmtPp(c.gainCorrectedPp, 2)} | ${fmtP(c.pAdjusted)} | ${fmtNum(c.minGainPp, 2)} | ${fmtPp(c.accuracyDeltaPp, 1)} | ${c.excludedExamples} | ${fmtUsd(c.costUsd)} | ${fmtUsd(c.cumulativeCostUsd)} |`,
    );
  }
  const retidos = r.cycles.filter((c) => c.heldBy.length);
  if (retidos.length) {
    L.push('');
    for (const c of retidos) L.push(`- Ciclo ${c.iteration} retido: ${c.heldBy.join('; ')}`);
  }
  L.push('', '## Custo de USAR a definição (só tokens de entrada: a saída é grátis)', '');
  L.push(`Base: ${r.cost.basis}.`);
  L.push('');
  L.push('| | Tokens de entrada / request | US$ / request (medido) | p50 |');
  L.push('|---|---|---|---|');
  L.push(`| Original | ${fmtNum(r.cost.original.meanTokensIn, 0)} | ${fmtUsd(r.cost.original.meanCostUsd)} | ${ms(r.cost.original.p50Ms)} |`);
  L.push(`| Campeã | ${fmtNum(r.cost.champion.meanTokensIn, 0)} | ${fmtUsd(r.cost.champion.meanCostUsd)} | ${ms(r.cost.champion.p50Ms)} |`);
  if (r.cost.projection) {
    L.push('');
    L.push(
      `Em ${r.cost.projection.requestsPerMonth.toLocaleString('pt-BR')} decisões/mês: original ${fmtUsd(r.cost.projection.originalUsd)} → campeã ${fmtUsd(r.cost.projection.championUsd)} (${r.cost.projection.deltaUsd >= 0 ? '+' : ''}${fmtUsd(r.cost.projection.deltaUsd)}).`,
    );
  }
  if (r.cost.paybackRequests !== null) L.push(`A otimização se paga em ${r.cost.paybackRequests.toLocaleString('pt-BR')} requests.`);
  if (r.cost.extraUsdPer1kPerPp !== null) L.push(`Custo extra: ${fmtUsd(r.cost.extraUsdPer1kPerPp)} por 1k requests para cada p.p. de Brier ganho.`);
  if (Object.keys(r.policy).length) {
    L.push('', '## Política ajustada (T + limiares, por pergunta)', '');
    L.push('| Pergunta | T | auto | hitl | sinal | ajustada em |');
    L.push('|---|---|---|---|---|---|');
    for (const [q, p] of Object.entries(r.policy)) {
      L.push(`| ${q} | ${fmtNum(p.temperature ?? 1, 2)} | ${p.auto > 1 ? 'desligada' : fmtNum(p.auto, 2)} | ${fmtNum(p.hitl, 2)} | ${p.signal} | ${p.fittedOn ? `${p.fittedOn.split} (n=${p.fittedOn.n})` : '—'} |`);
    }
  }
  L.push('', '## Quanto custou otimizar', '');
  L.push(
    `Total: **${fmtUsd(r.optimization.totalUsd)}** (decisões ${fmtUsd(r.optimization.byKind.decision)}, proponente ${fmtUsd(r.optimization.byKind.rewriter)})${r.optimization.budgetUsd ? ` de ${fmtUsd(r.optimization.budgetUsd)} (${fmtNum(r.optimization.budgetUsedPct, 0)}%)` : ''}${r.optimization.pendingUsd > 0 ? ` · pendente ${fmtUsd(r.optimization.pendingUsd)}` : ''}.`,
  );
  if (r.spec.changedQuestions.length) {
    L.push('', '## O que mudou na definição', '');
    for (const q of r.spec.changedQuestions) {
      const d = r.spec.diff[q];
      L.push(`- \`${q}\`: +${d.linesAdded}/−${d.linesRemoved} linhas (${d.operators.join(', ') || '—'})`);
    }
  }
  if (r.warnings.length) {
    L.push('', '## Avisos', '');
    for (const w of r.warnings) L.push(`- ${w}`);
  }
  L.push('');
  return L.join('\n');
}
