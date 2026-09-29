// Relatório de CICLOS de um treino (sessão) — núcleo PURO, fonte única.
//
// Responde às três perguntas de quem treinou um prompt:
//   1. Quanto melhorou? — original × campeão, por ciclo (iteração) e no fim
//      (holdout quando houve; senão a própria run de treino, rotulada como tal).
//   2. Quanto a MUDANÇA mexe no custo de USAR o prompt? — custo, tokens e
//      latência por chamada do original × do campeão, PAREADOS por cenário
//      (mesma pergunta nos dois lados), com projeção por volume.
//   3. Quanto custou otimizar, e quando se paga? — gasto da sessão por papel e
//      por ciclo, e o ponto de retorno quando o campeão é mais barato.
//
// Dinheiro é MEDIDO: o custo por chamada sai de `CompetitorResponse.costUsd`
// (o `usage.cost` cobrado); resposta com custo 0 entra na contagem
// `zeroCostCalls` e é avisada — nunca vira "grátis" em silêncio.
//
// Puro (sem Node nem `process`): o CLI (`sessions report`), o MCP e a web
// (`/training/:id/report`, via shim em web/src/engine/) usam a MESMA função.

import type {
  CostRole,
  RunRecord,
  SessionRecord,
  StageRecord,
  StoredSignificance,
} from '../types.js';
import { pairCoverage, stageScoresByContestant, type PairScore } from '../stats.js';
import { holdoutSkipReasonText } from '../holdout.js';
import { holdoutSkipReasonOf } from './sessionDecision.js';

export const SESSION_REPORT_FORMAT = 'prompt-builder-session-report@1';

/** Volume mensal default da projeção de custo (chamadas/mês). */
export const DEFAULT_CALLS_PER_MONTH = 10_000;

/** Aproximação de tokens por caractere (só para o Δ do texto do prompt). */
const CHARS_PER_TOKEN = 4;

export interface CallCostStats {
  /** Chamadas contadas (respostas `ok` nos cenários pareados). */
  n: number;
  meanCostUsd: number | null;
  meanTokensIn: number | null;
  meanTokensOut: number | null;
  meanReasoningTokens: number | null;
  meanLatencyMs: number | null;
  totalCostUsd: number;
  /** Chamadas com custo 0: preço desconhecido OU modelo gratuito — nunca "de graça" por inferência. */
  zeroCostCalls: number;
  /**
   * Chamadas que truncaram e foram refeitas com teto ×2: o `costUsd` delas soma
   * as DUAS tentativas (em produção não há esse retry) — infla o custo medido.
   */
  retriedCalls: number;
  /** Recusas do modelo (`refused`): contam como chamada paga, sem resposta útil. */
  refusedCalls: number;
}

export type ComparisonSource = 'holdout' | 'training' | 'none';

export interface CostComparison {
  /** De onde vêm os pares: run de holdout (mesma run, cenários intocados) ou runs de treino. */
  source: ComparisonSource;
  /** Frase PT-BR que explica a base da comparação. */
  basis: string;
  /** Cenários pareados (resposta `ok` dos dois lados). */
  pairs: number;
  original: CallCostStats;
  champion: CallCostStats;
  deltaCostPerCallUsd: number | null;
  deltaCostPct: number | null;
  /** Δ de tokens de entrada por chamada ≈ Δ do system prompt (a pergunta é a mesma). */
  deltaTokensIn: number | null;
  deltaTokensOut: number | null;
  deltaReasoningTokens: number | null;
  /** MEDIANA dos Δ pareados de latência (robusta ao ruído de concorrência). */
  deltaLatencyMs: number | null;
  deltaLatencyPct: number | null;
  per1kCalls: { originalUsd: number; championUsd: number; deltaUsd: number } | null;
  projection: {
    callsPerMonth: number;
    originalUsd: number;
    championUsd: number;
    deltaUsd: number;
  } | null;
  /** Chamadas até a economia pagar a otimização (só quando o campeão é mais barato). */
  paybackCalls: number | null;
  /** Custo extra por 1.000 chamadas por p.p. ganho (só quando custa mais E ganhou qualidade). */
  extraUsdPer1kPerPp: number | null;
}

export type CycleDecision = 'promoted' | 'held' | 'inconclusive' | 'baseline' | 'stopped';

export interface CycleRow {
  /** 0-based (como no record); `label` é o texto de exibição ("Ciclo 1"). */
  iteration: number;
  label: string;
  runId: string;
  runStatus: string;
  /** Régua do ciclo: 'original' no 1º, 'carry' (campeão anterior re-testado) nos demais. */
  controlId: string;
  /** Campeão DEPOIS do gate deste ciclo. */
  championId: string;
  championLabel: string;
  /** Técnica da variante campeã (quando é variante). */
  technique?: string;
  /** Variantes testadas contra a régua neste ciclo. */
  variants: number;
  decision: CycleDecision;
  heldBy?: string[];
  /** Judge-score (0–100) da régua e da melhor variante, nos pares completos do gate. */
  controlScorePp: number | null;
  bestScorePp: number | null;
  /** Δ bruto (p.p.) melhor − régua; e o corrigido do winner's curse. */
  gainPp: number | null;
  gainCorrectedPp: number | null;
  pAdjusted: number | null;
  minGainPp: number | null;
  /** Re-avaliação limpa do candidato (quando houve). */
  /** `runStatus` (cli#8): a run da re-avaliação NÃO terminou — sem evidência, Δ/size não valem. */
  reeval?: { gainPp: number; confirmed: boolean; size: number; runStatus?: string };
  /** Custo MEDIDO deste ciclo (run de seleção + re-avaliação, quando carregada). */
  costUsd: number;
  cumulativeCostUsd: number;
  /** Score (0–100) do campeão vigente ao fim do ciclo, na run deste ciclo. */
  championScorePp: number | null;
  /** Mesmo número para o prompt ORIGINAL (só no ciclo em que ele rodou). */
  originalScorePp: number | null;
}

export interface VerdictCounts {
  resolve: number;
  parcial: number;
  nao: number;
  semVeredito: number;
}

export interface QualitySummary {
  source: ComparisonSource;
  basis: string;
  originalScorePp: number | null;
  championScorePp: number | null;
  gainPp: number | null;
  /** Ganho relativo ao original (%). */
  relativeGainPct: number | null;
  n: number;
  nEfetivo: number;
  ci95Pp: [number, number] | null;
  pValue: number | null;
  /** 'holdout' = confirmação; 'selecao' = mesmo dado que escolheu (anti-conservador). */
  pOrigin: 'holdout' | 'selecao' | null;
  significant: boolean | null;
  regressed: boolean;
  verdicts: { original: VerdictCounts; champion: VerdictCounts } | null;
}

export interface RoleCost {
  role: CostRole | string;
  usd: number;
  calls: number;
  pct: number;
}

export type ReportVerdict = 'melhorou' | 'piorou' | 'sem-diferenca' | 'inconclusivo' | 'sem-mudanca';

export interface SessionReport {
  format: typeof SESSION_REPORT_FORMAT;
  generatedAt: string;
  session: {
    id: string;
    status: string;
    theme: string;
    modelId: string;
    startedAt: string;
    finishedAt?: string;
    durationMs: number | null;
    iterationsPlanned: number;
    cyclesRun: number;
    promotions: number;
    convergedAtIteration?: number;
    convergenceReason?: string;
    stoppedReason?: string;
    stoppedAtPhase?: string;
    budgetUsd?: number;
    judgeModelIds: string[];
    datagenModelId: string;
    optimizerModelId?: string;
  };
  prompts: {
    original: string;
    champion: string;
    changed: boolean;
    championLabel: string;
    /** Ciclo (0-based) em que o campeão final foi promovido; null = o original segurou. */
    promotedAtIteration: number | null;
    diff: {
      linesAdded: number;
      linesRemoved: number;
      charsOriginal: number;
      charsChampion: number;
      charsDelta: number;
      approxTokensDelta: number;
    };
  };
  quality: QualitySummary;
  cycles: CycleRow[];
  cost: CostComparison;
  optimization: {
    totalUsd: number;
    /** Chamadas sem custo apurado (timeout/abort): o gasto real pode ir até total + pendente. */
    pendingUsd: number;
    /**
     * Gasto de nível de sessão que não pertence a nenhuma run (reescritor,
     * reflexão, contract gate) = total − Σ runs carregadas. null se faltou run.
     */
    sessionOverheadUsd: number | null;
    byRole: RoleCost[];
    budgetUsd?: number;
    budgetUsedPct: number | null;
    accuracy?: { exact: number; estimated: number; unknown: number };
    perCycleMeanUsd: number | null;
  };
  verdict: ReportVerdict;
  /** Uma frase PT-BR com a conclusão (quanto melhorou + quanto muda o custo). */
  headline: string;
  /** Ressalvas que mudam a leitura (drift de juiz, holdout pulado, custo desconhecido…). */
  warnings: string[];
}

export interface SessionReportOptions {
  /** Instante de geração (ISO). Default: `session.finishedAt ?? session.startedAt` (determinístico). */
  generatedAt?: string;
  /** Volume da projeção mensal. Default {@link DEFAULT_CALLS_PER_MONTH}. */
  callsPerMonth?: number;
}

// ---------------------------------------------------------------------------
// utilidades numéricas
// ---------------------------------------------------------------------------

const round = (x: number, d: number): number => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};

function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function sub(a: number | null, b: number | null): number | null {
  return a == null || b == null ? null : a - b;
}

function pct(delta: number | null, base: number | null): number | null {
  if (delta == null || base == null || base === 0) return null;
  return round((delta / base) * 100, 2);
}

// ---------------------------------------------------------------------------
// custo por chamada, pareado por cenário
// ---------------------------------------------------------------------------

interface CallSample {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  reasoningTokens: number | null;
  latencyMs: number;
  retried: boolean;
  refused: boolean;
}

/**
 * Chamada do contestant na etapa que representa USO REAL: `ok` ou `refused`
 * (a recusa também é paga). `error`/`blocked` ficam fora (sem resposta, tokens
 * zerados). O custo de etapas cortadas (`incomplete`) é real — elas entram aqui
 * mesmo fora do placar de qualidade.
 */
function sampleOf(stage: StageRecord | null | undefined, contestantId: string): CallSample | null {
  if (!stage) return null;
  const r = (stage.responses ?? []).find((x) => x && x.contestantId === contestantId);
  if (!r || (r.status !== 'ok' && r.status !== 'refused')) return null;
  if (!Number.isFinite(r.costUsd)) return null;
  return {
    costUsd: r.costUsd,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    reasoningTokens: typeof r.reasoningTokens === 'number' ? r.reasoningTokens : null,
    latencyMs: r.latencyMs,
    retried: r.truncationRetried === true,
    refused: r.status === 'refused',
  };
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function statsOf(samples: readonly CallSample[]): CallCostStats {
  const reasoning = samples.map((s) => s.reasoningTokens).filter((x): x is number => x != null);
  const total = samples.reduce((a, s) => a + s.costUsd, 0);
  const m = (f: (s: CallSample) => number): number | null => mean(samples.map(f));
  return {
    n: samples.length,
    meanCostUsd: m((s) => s.costUsd),
    meanTokensIn: m((s) => s.tokensIn),
    meanTokensOut: m((s) => s.tokensOut),
    meanReasoningTokens: mean(reasoning),
    meanLatencyMs: m((s) => s.latencyMs),
    totalCostUsd: round(total, 6),
    zeroCostCalls: samples.filter((s) => s.costUsd === 0).length,
    retriedCalls: samples.filter((s) => s.retried).length,
    refusedCalls: samples.filter((s) => s.refused).length,
  };
}

const stageKey = (s: StageRecord): string | null => s.spec?.question?.trim() || null;

/** Pares (original, campeão) por PERGUNTA entre duas runs (ou a mesma run). */
function pairedSamples(
  runA: RunRecord,
  idA: string,
  runB: RunRecord,
  idB: string,
): { a: CallSample[]; b: CallSample[] } {
  const a: CallSample[] = [];
  const b: CallSample[] = [];
  if (runA === runB) {
    for (const st of runA.stages ?? []) {
      const x = sampleOf(st, idA);
      const y = sampleOf(st, idB);
      if (x && y) {
        a.push(x);
        b.push(y);
      }
    }
    return { a, b };
  }
  const byKey = new Map<string, StageRecord>();
  for (const st of runB.stages ?? []) {
    if (!st) continue;
    const k = stageKey(st);
    if (k && !byKey.has(k)) byKey.set(k, st);
  }
  for (const st of runA.stages ?? []) {
    if (!st) continue;
    const k = stageKey(st);
    const other = k ? byKey.get(k) : undefined;
    if (!other) continue;
    const x = sampleOf(st, idA);
    const y = sampleOf(other, idB);
    if (x && y) {
      a.push(x);
      b.push(y);
    }
  }
  return { a, b };
}

function emptyStats(): CallCostStats {
  return statsOf([]);
}

// ---------------------------------------------------------------------------
// vereditos
// ---------------------------------------------------------------------------

function verdictCounts(scores: readonly PairScore[]): VerdictCounts {
  const c: VerdictCounts = { resolve: 0, parcial: 0, nao: 0, semVeredito: 0 };
  for (const s of scores) {
    if (s == null) c.semVeredito += 1;
    else if (s >= 1) c.resolve += 1;
    else if (s > 0) c.parcial += 1;
    else c.nao += 1;
  }
  return c;
}

function scorePp(scores: readonly PairScore[] | undefined): number | null {
  if (!scores) return null;
  const obs = scores.filter((s): s is number => typeof s === 'number');
  const m = mean(obs);
  return m == null ? null : round(m * 100, 2);
}

// ---------------------------------------------------------------------------
// diff de linhas (LCS em O(n·m) — prompts são pequenos; teto defensivo)
// ---------------------------------------------------------------------------

function lineDiffCounts(a: string, b: string): { added: number; removed: number } {
  const la = a.split('\n');
  const lb = b.split('\n');
  if (la.length * lb.length > 4_000_000) {
    // Prompt gigante: conta por conjunto (aproximação honesta, sem travar).
    const sa = new Set(la);
    const sb = new Set(lb);
    return { added: lb.filter((l) => !sa.has(l)).length, removed: la.filter((l) => !sb.has(l)).length };
  }
  const n = la.length;
  const m = lb.length;
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      cur[j] = la[i - 1] === lb[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  const lcs = prev[m];
  return { added: m - lcs, removed: n - lcs };
}

// ---------------------------------------------------------------------------
// o relatório
// ---------------------------------------------------------------------------

const ROLE_LABEL_ORDER: string[] = ['competitor', 'judge', 'datagen', 'gabarito', 'rewriter', 'duel', 'agent'];

/**
 * Monta o relatório de ciclos de uma sessão de treino. `runs` pode trazer as
 * runs da sessão em qualquer ordem, inclusive as de re-avaliação (os ids
 * delas vivem em `gate.reeval.runId`); run ausente vira ciclo com custo da
 * sessão desconhecido e um aviso — nunca quebra.
 */
export function buildSessionReport(
  session: SessionRecord,
  runs: readonly RunRecord[],
  opts: SessionReportOptions = {},
): SessionReport {
  const cfg = session.config;
  const byId = new Map(runs.map((r) => [r.id, r]));
  const warnings: string[] = [];
  const callsPerMonth =
    opts.callsPerMonth && opts.callsPerMonth > 0 ? Math.round(opts.callsPerMonth) : DEFAULT_CALLS_PER_MONTH;

  const original = cfg.basePrompt ?? '';
  const lineage = [...(session.bestPromptByIteration ?? [])].sort((a, b) => a.iteration - b.iteration);
  const last = lineage[lineage.length - 1];
  const champion = last?.systemPrompt ?? original;
  const changed = champion.trim() !== original.trim();

  // Runs de treino (iterações) e holdout, pela ordem do record.
  const sessionRuns = session.runIds.map((id) => byId.get(id)).filter((r): r is RunRecord => Boolean(r));
  const missingRuns = session.runIds.filter((id) => !byId.has(id));
  if (missingRuns.length > 0) {
    warnings.push(
      `${missingRuns.length} run(s) da sessão não foram encontradas (${missingRuns.slice(0, 3).join(', ')}${
        missingRuns.length > 3 ? '…' : ''
      }) — ciclos e custos dessas runs ficam de fora.`,
    );
  }
  const holdoutRun = sessionRuns.find((r) => r.contestants.some((c) => c.id === 'holdout-control'));
  const iterationRuns = sessionRuns.filter((r) => r !== holdoutRun);

  // ---- ciclos ------------------------------------------------------------
  let promotedAtIteration: number | null = null;
  let cumulative = 0;
  let promotions = 0;
  const cycles: CycleRow[] = lineage.map((it) => {
    const run = byId.get(it.runId);
    const gate = it.gate;
    const controlId = it.iteration === 0 ? 'original' : 'carry';
    const reevalRun = gate?.reeval?.runId ? byId.get(gate.reeval.runId) : undefined;
    const costUsd = round((run?.totalCostUsd ?? 0) + (reevalRun?.totalCostUsd ?? 0), 6);
    cumulative = round(cumulative + costUsd, 6);
    const promoted = gate ? gate.decision === 'promoted' : it.winnerContestantId !== controlId;
    if (promoted) {
      promotions += 1;
      promotedAtIteration = it.iteration;
    }
    const decision: CycleDecision = !gate
      ? promoted
        ? 'promoted'
        : 'baseline'
      : gate.decision === 'promoted'
        ? 'promoted'
        : gate.decision === 'inconclusive'
          ? 'inconclusive'
          : 'held';
    const winner = run?.contestants.find((c) => c.id === it.winnerContestantId);
    const scores = run
      ? stageScoresByContestant(
          run.stages,
          run.contestants.map((c) => c.id),
        )
      : undefined;
    const test = gate?.test;
    return {
      iteration: it.iteration,
      label: `Ciclo ${it.iteration + 1}`,
      runId: it.runId,
      runStatus: run?.status ?? 'ausente',
      controlId,
      championId: it.winnerContestantId,
      championLabel: winner?.label ?? it.winnerContestantId,
      ...(winner?.techniqueId ? { technique: winner.techniqueId } : {}),
      variants: run ? run.contestants.filter((c) => c.id !== controlId).length : 0,
      decision,
      ...(gate?.heldBy?.length ? { heldBy: [...gate.heldBy] } : {}),
      controlScorePp: gate?.pairing?.controlMeanPp ?? scorePp(scores?.[controlId]),
      bestScorePp: gate?.pairing?.championMeanPp ?? null,
      gainPp: gate ? round(gate.gainPp, 2) : null,
      gainCorrectedPp: gate?.gainCorrectedPp != null ? round(gate.gainCorrectedPp, 2) : null,
      pAdjusted: test?.pAdjusted ?? null,
      minGainPp: gate?.minGain ?? null,
      ...(gate?.reeval
        ? {
            reeval: {
              gainPp: round(gate.reeval.gainPp, 2),
              confirmed: gate.reeval.confirmed,
              size: gate.reeval.size,
              ...(gate.reeval.runStatus ? { runStatus: gate.reeval.runStatus } : {}),
            },
          }
        : {}),
      costUsd,
      cumulativeCostUsd: cumulative,
      championScorePp: scorePp(scores?.[it.winnerContestantId]),
      originalScorePp: scorePp(scores?.original),
    };
  });
  // Ciclo com run mas sem linhagem (sessão interrompida no meio do ciclo).
  for (const r of iterationRuns) {
    if (cycles.some((c) => c.runId === r.id)) continue;
    const iteration = r.iteration ?? cycles.length;
    cumulative = round(cumulative + (r.totalCostUsd ?? 0), 6);
    cycles.push({
      iteration,
      label: `Ciclo ${iteration + 1}`,
      runId: r.id,
      runStatus: r.status,
      controlId: iteration === 0 ? 'original' : 'carry',
      championId: '—',
      championLabel: '—',
      variants: r.contestants.length - 1,
      decision: 'stopped',
      controlScorePp: null,
      bestScorePp: null,
      gainPp: null,
      gainCorrectedPp: null,
      pAdjusted: null,
      minGainPp: null,
      costUsd: round(r.totalCostUsd ?? 0, 6),
      cumulativeCostUsd: cumulative,
      championScorePp: null,
      originalScorePp: null,
    });
  }
  cycles.sort((a, b) => a.iteration - b.iteration);

  // O campeão final veio de uma promoção? (a linhagem repete o campeão vigente)
  if (!changed) promotedAtIteration = null;
  const championLabel = (() => {
    if (!changed) return 'Original (nenhuma variante superou a régua)';
    if (promotedAtIteration == null) return last?.winnerContestantId ?? 'campeão';
    const c = cycles.find((x) => x.iteration === promotedAtIteration);
    return c?.championLabel ?? 'campeão';
  })();

  // ---- qualidade ----------------------------------------------------------
  const quality = qualityOf(session, holdoutRun, iterationRuns, lineage, changed);
  if (quality.source === 'training') {
    warnings.push(
      'Sem holdout válido: a comparação final usa os cenários de TREINO (os mesmos que escolheram o campeão) — o ganho tende a ser otimista.',
    );
  }
  if (session.holdoutSkipped) {
    // web-code#8: o MOTIVO gravado (piso de cenários ≠ orçamento ≠ cancelamento).
    const motivo = holdoutSkipReasonOf(session);
    warnings.push(
      `Holdout pulado (${motivo ? holdoutSkipReasonText(motivo) : 'motivo não registrado'}): o campeão NÃO foi validado contra sobreajuste.`,
    );
  }
  if (session.holdout?.regressed) {
    warnings.push('O campeão REGREDIU no holdout — não aplique sem revisar (o handoff bloqueia sem --override).');
  }
  if (session.judgeDrift) {
    warnings.push('Drift de juiz: as runs usaram contratos de juiz diferentes — parte do Δ entre ciclos pode ser do juiz, não do prompt.');
  }
  if (session.championDeclaration && !session.championDeclaration.declared) {
    warnings.push(session.championDeclaration.message);
  }

  // ---- custo por chamada --------------------------------------------------
  const optimizationUsd = round(session.totalCostUsd ?? 0, 6);
  const cost = costComparisonOf({
    holdoutRun,
    iterationRuns,
    lineage,
    changed,
    callsPerMonth,
    optimizationUsd,
    gainPp: quality.gainPp,
  });
  if (cost.original.zeroCostCalls + cost.champion.zeroCostCalls > 0) {
    warnings.push(
      `${cost.original.zeroCostCalls + cost.champion.zeroCostCalls} chamada(s) com custo 0 na comparação (preço desconhecido ou modelo gratuito) — o Δ de custo pode estar subestimado.`,
    );
  }
  if (cost.original.retriedCalls + cost.champion.retriedCalls > 0) {
    warnings.push(
      `${cost.original.retriedCalls + cost.champion.retriedCalls} chamada(s) da comparação truncaram e foram refeitas com teto ×2 — o custo medido delas soma as duas tentativas (em produção não há esse retry).`,
    );
  }
  if ((session.costLedger?.pendingUsd ?? 0) > 0) {
    warnings.push(
      `US$ ${(session.costLedger?.pendingUsd ?? 0).toFixed(4)} em chamadas pendentes (sem custo apurado): o gasto real da otimização pode chegar a total + pendente.`,
    );
  }
  if (runs.some((r) => r.contestants?.some((c) => c.runner === 'agent'))) {
    warnings.push(
      'Modo agente: o custo por "chamada" é o custo de uma execução inteira do agente (derivado), não de uma chamada de LLM — compare com cautela.',
    );
  }
  if (session.costAccuracy && session.costAccuracy.unknown > 0) {
    // `unknown` = sem `usage.cost`: ou a reserva inteira foi lançada como gasto
    // (timeout/abort sem id — limite SUPERIOR, já dentro do total) ou o modelo
    // não tinha preço. Nenhum dos dois é "custou zero".
    warnings.push(
      `${session.costAccuracy.unknown} chamada(s) sem custo medido pelo provedor (timeout/abort lançado pela reserva inteira — limite superior — ou modelo sem preço): o total é uma aproximação nessas chamadas.`,
    );
  }

  // ---- custo da otimização -----------------------------------------------
  const byRole: RoleCost[] = Object.entries(session.costByRole ?? {})
    .map(([role, e]) => ({
      role,
      usd: round(e?.usd ?? 0, 6),
      calls: e?.calls ?? 0,
      pct: optimizationUsd > 0 ? round(((e?.usd ?? 0) / optimizationUsd) * 100, 1) : 0,
    }))
    .filter((r) => r.usd > 0 || r.calls > 0)
    .sort((a, b) => {
      const d = b.usd - a.usd;
      return d !== 0 ? d : ROLE_LABEL_ORDER.indexOf(a.role) - ROLE_LABEL_ORDER.indexOf(b.role);
    });

  // ---- diff do prompt -----------------------------------------------------
  const ld = lineDiffCounts(original, champion);
  const charsDelta = champion.length - original.length;

  const started = Date.parse(session.startedAt);
  const finished = session.finishedAt ? Date.parse(session.finishedAt) : NaN;

  const verdict = verdictOf(quality, changed);
  const report: SessionReport = {
    format: SESSION_REPORT_FORMAT,
    generatedAt: opts.generatedAt ?? session.finishedAt ?? session.startedAt,
    session: {
      id: session.id,
      status: session.status,
      theme: cfg.theme,
      modelId: cfg.contestantModelId,
      startedAt: session.startedAt,
      ...(session.finishedAt ? { finishedAt: session.finishedAt } : {}),
      durationMs: Number.isFinite(started) && Number.isFinite(finished) ? finished - started : null,
      iterationsPlanned: cfg.iterations,
      cyclesRun: lineage.length,
      promotions,
      ...(session.convergedAtIteration != null ? { convergedAtIteration: session.convergedAtIteration } : {}),
      ...(session.convergenceReason ? { convergenceReason: session.convergenceReason } : {}),
      ...(session.stoppedReason ? { stoppedReason: session.stoppedReason } : {}),
      ...(session.stoppedAtPhase ? { stoppedAtPhase: session.stoppedAtPhase } : {}),
      ...(session.budgetUsd != null ? { budgetUsd: session.budgetUsd } : {}),
      judgeModelIds: [...(cfg.judgeModelIds ?? [])],
      datagenModelId: cfg.datagenModelId,
      ...(cfg.optimizerModelId ? { optimizerModelId: cfg.optimizerModelId } : {}),
    },
    prompts: {
      original,
      champion,
      changed,
      championLabel,
      promotedAtIteration,
      diff: {
        linesAdded: ld.added,
        linesRemoved: ld.removed,
        charsOriginal: original.length,
        charsChampion: champion.length,
        charsDelta,
        approxTokensDelta: Math.round(charsDelta / CHARS_PER_TOKEN),
      },
    },
    quality,
    cycles,
    cost,
    optimization: {
      totalUsd: optimizationUsd,
      pendingUsd: round(session.costLedger?.pendingUsd ?? 0, 6),
      sessionOverheadUsd:
        missingRuns.length > 0
          ? null
          : round(Math.max(0, optimizationUsd - runs.reduce((a, r) => a + (r.totalCostUsd ?? 0), 0)), 6),
      byRole,
      ...(session.budgetUsd != null ? { budgetUsd: session.budgetUsd } : {}),
      budgetUsedPct:
        session.budgetUsd && session.budgetUsd > 0 ? round((optimizationUsd / session.budgetUsd) * 100, 1) : null,
      ...(session.costAccuracy ? { accuracy: { ...session.costAccuracy } } : {}),
      perCycleMeanUsd: cycles.length > 0 ? round(cycles.reduce((a, c) => a + c.costUsd, 0) / cycles.length, 6) : null,
    },
    verdict,
    headline: '',
    warnings,
  };
  report.headline = headlineOf(report);
  return report;
}

function qualityOf(
  session: SessionRecord,
  holdoutRun: RunRecord | undefined,
  iterationRuns: readonly RunRecord[],
  lineage: SessionRecord['bestPromptByIteration'],
  changed: boolean,
): QualitySummary {
  const sig: (StoredSignificance & { pOrigin?: string }) | null | undefined = session.significance as
    | (StoredSignificance & { pOrigin?: string })
    | null
    | undefined;
  const pOrigin: 'holdout' | 'selecao' | null =
    sig?.pOrigin === 'holdout' || sig?.pOrigin === 'selecao'
      ? sig.pOrigin
      : session.pairing?.source === 'holdout'
        ? 'holdout'
        : session.pairing?.source === 'training'
          ? 'selecao'
          : null;
  const base = {
    ci95Pp: sig?.ci95Pp ?? null,
    pValue: sig?.pValue ?? null,
    pOrigin: sig ? pOrigin : null,
  };

  if (holdoutRun && session.holdout) {
    const { controlScores, championScores } = pairedScores(holdoutRun, 'holdout-control', 'holdout-champion');
    const cov = pairCoverage(controlScores, championScores);
    const o = session.holdout.controlScore;
    const c = session.holdout.championScore;
    return {
      source: 'holdout',
      basis: `Holdout: ${session.holdout.n} cenário(s) reservados, nunca vistos pela seleção — original × campeão na MESMA run.`,
      originalScorePp: round(o, 2),
      championScorePp: round(c, 2),
      gainPp: round(session.holdout.gain, 2),
      relativeGainPct: pct(session.holdout.gain, o),
      n: session.holdout.n,
      nEfetivo: session.holdout.nEfetivo ?? cov.nEfetivo,
      ...base,
      significant: sig ? isSignificant(sig) : null,
      regressed: session.holdout.regressed,
      verdicts: { original: verdictCounts(controlScores), champion: verdictCounts(championScores) },
    };
  }

  // Sem holdout: o pareamento final da sessão (quando houve) ou nada.
  const pairing = session.pairing;
  if (pairing && pairing.source === 'training') {
    const run = [...iterationRuns].reverse().find(
      (r) => r.contestants.some((c) => c.id === pairing.controlId) && r.contestants.some((c) => c.id === pairing.championId),
    );
    const scores = run ? pairedScores(run, pairing.controlId, pairing.championId) : null;
    return {
      source: 'training',
      basis: `Run de treino (${pairing.controlId === 'original' ? 'original' : 'régua do ciclo'} × campeão nos cenários de treino) — sem confirmação independente.`,
      originalScorePp: pairing.controlMeanPp ?? null,
      championScorePp: pairing.championMeanPp ?? null,
      gainPp: pairing.meanDiffPp ?? null,
      relativeGainPct: pct(pairing.meanDiffPp ?? null, pairing.controlMeanPp ?? null),
      n: pairing.n,
      nEfetivo: pairing.nEfetivo,
      ...base,
      significant: sig ? isSignificant(sig) : null,
      regressed: (pairing.meanDiffPp ?? 0) < 0,
      verdicts: scores
        ? { original: verdictCounts(scores.controlScores), champion: verdictCounts(scores.championScores) }
        : null,
    };
  }

  // Nada para parear: o original segurou (campeão == original) ou a sessão parou cedo.
  const first = iterationRuns.find((r) => (r.iteration ?? 0) === 0) ?? iterationRuns[0];
  const originalScores = first ? stageScoresByContestant(first.stages, ['original']).original : undefined;
  const o = scorePp(originalScores);
  return {
    source: 'none',
    basis: changed
      ? 'Sem comparação pareada disponível (sessão interrompida antes do fim).'
      : 'Nenhuma variante superou a régua: o campeão É o original (sem mudança para medir).',
    originalScorePp: o,
    championScorePp: changed ? scorePp(championScoresOf(iterationRuns, lineage)) : o,
    gainPp: changed ? null : 0,
    relativeGainPct: changed ? null : 0,
    n: originalScores?.length ?? 0,
    nEfetivo: originalScores?.filter((s) => typeof s === 'number').length ?? 0,
    ci95Pp: null,
    pValue: null,
    pOrigin: null,
    significant: null,
    regressed: false,
    verdicts: null,
  };
}

function championScoresOf(
  iterationRuns: readonly RunRecord[],
  lineage: SessionRecord['bestPromptByIteration'],
): PairScore[] | undefined {
  const last = lineage[lineage.length - 1];
  if (!last) return undefined;
  const run = iterationRuns.find((r) => r.id === last.runId);
  return run ? stageScoresByContestant(run.stages, [last.winnerContestantId])[last.winnerContestantId] : undefined;
}

function pairedScores(
  run: RunRecord,
  controlId: string,
  championId: string,
): { controlScores: PairScore[]; championScores: PairScore[] } {
  const m = stageScoresByContestant(run.stages, [controlId, championId]);
  return { controlScores: m[controlId], championScores: m[championId] };
}

function isSignificant(sig: StoredSignificance): boolean {
  if (typeof sig.pValue !== 'number') return false;
  const lo = Array.isArray(sig.ci95Pp) ? sig.ci95Pp[0] : null;
  return sig.pValue <= 0.05 && sig.meanDiffPp > 0 && (lo == null || lo > 0);
}

function costComparisonOf(args: {
  holdoutRun: RunRecord | undefined;
  iterationRuns: readonly RunRecord[];
  lineage: SessionRecord['bestPromptByIteration'];
  changed: boolean;
  callsPerMonth: number;
  optimizationUsd: number;
  gainPp: number | null;
}): CostComparison {
  const { holdoutRun, iterationRuns, lineage, changed, callsPerMonth, optimizationUsd, gainPp } = args;
  let source: ComparisonSource = 'none';
  let basis = 'Sem pares original × campeão com resposta válida nos dois lados.';
  let pair: { a: CallSample[]; b: CallSample[] } = { a: [], b: [] };

  if (holdoutRun) {
    pair = pairedSamples(holdoutRun, 'holdout-control', holdoutRun, 'holdout-champion');
    if (pair.a.length > 0) {
      source = 'holdout';
      basis = 'Run de holdout: original e campeão responderam às MESMAS perguntas, na mesma run.';
    }
  }
  if (source === 'none') {
    // Original: onde ele rodou com esse id (ciclo 1). Campeão: a run em que a
    // variante vencedora rodou com o id dela (a promoção), senão como 'carry'.
    const origRun = iterationRuns.find((r) => r.contestants.some((c) => c.id === 'original'));
    const lastPromoted = [...lineage].reverse().find((it) => it.gate?.decision === 'promoted') ??
      [...lineage].reverse().find((it) => it.winnerContestantId !== (it.iteration === 0 ? 'original' : 'carry'));
    const champRun = lastPromoted ? iterationRuns.find((r) => r.id === lastPromoted.runId) : undefined;
    if (!changed && origRun) {
      pair = pairedSamples(origRun, 'original', origRun, 'original');
      if (pair.a.length > 0) {
        source = 'training';
        basis = 'O campeão é o próprio original: custo por chamada idêntico por construção.';
      }
    } else if (origRun && champRun && lastPromoted) {
      pair = pairedSamples(origRun, 'original', champRun, lastPromoted.winnerContestantId);
      if (pair.a.length > 0) {
        source = 'training';
        basis =
          origRun === champRun
            ? 'Run de treino do ciclo em que o campeão venceu: mesmas perguntas, mesma run.'
            : 'Runs de treino: original (ciclo 1) × campeão (ciclo da promoção), pareados pela MESMA pergunta.';
      }
    }
  }

  const o = statsOf(pair.a);
  const c = statsOf(pair.b);
  const dCost = sub(c.meanCostUsd, o.meanCostUsd);
  const latDelta = median(pair.a.map((x, i) => pair.b[i].latencyMs - x.latencyMs));
  const per1k =
    o.meanCostUsd != null && c.meanCostUsd != null
      ? {
          originalUsd: round(o.meanCostUsd * 1000, 4),
          championUsd: round(c.meanCostUsd * 1000, 4),
          deltaUsd: round((c.meanCostUsd - o.meanCostUsd) * 1000, 4),
        }
      : null;
  const projection =
    o.meanCostUsd != null && c.meanCostUsd != null
      ? {
          callsPerMonth,
          originalUsd: round(o.meanCostUsd * callsPerMonth, 2),
          championUsd: round(c.meanCostUsd * callsPerMonth, 2),
          deltaUsd: round((c.meanCostUsd - o.meanCostUsd) * callsPerMonth, 2),
        }
      : null;
  // Tolerância no teto: 0,32 / 0,0002 dá 1600,0000000002 em ponto flutuante —
  // sem o epsilon o relatório diria 1601 chamadas.
  const paybackCalls =
    dCost != null && dCost < 0 && optimizationUsd > 0 ? Math.ceil(optimizationUsd / -dCost - 1e-9) : null;
  const extraUsdPer1kPerPp =
    dCost != null && dCost > 0 && gainPp != null && gainPp > 0 ? round((dCost * 1000) / gainPp, 4) : null;

  return {
    source,
    basis,
    pairs: pair.a.length,
    original: pair.a.length ? o : emptyStats(),
    champion: pair.b.length ? c : emptyStats(),
    deltaCostPerCallUsd: dCost == null ? null : round(dCost, 8),
    deltaCostPct: pct(dCost, o.meanCostUsd),
    deltaTokensIn: sub(c.meanTokensIn, o.meanTokensIn) == null ? null : round(sub(c.meanTokensIn, o.meanTokensIn)!, 1),
    deltaTokensOut: sub(c.meanTokensOut, o.meanTokensOut) == null ? null : round(sub(c.meanTokensOut, o.meanTokensOut)!, 1),
    deltaReasoningTokens:
      sub(c.meanReasoningTokens, o.meanReasoningTokens) == null
        ? null
        : round(sub(c.meanReasoningTokens, o.meanReasoningTokens)!, 1),
    deltaLatencyMs: latDelta == null ? null : Math.round(latDelta),
    deltaLatencyPct: pct(latDelta, median(pair.a.map((x) => x.latencyMs))),
    per1kCalls: per1k,
    projection,
    paybackCalls,
    extraUsdPer1kPerPp,
  };
}

function verdictOf(q: QualitySummary, changed: boolean): ReportVerdict {
  if (!changed) return 'sem-mudanca';
  if (q.gainPp == null) return 'inconclusivo';
  if (q.regressed && q.gainPp < 0) return 'piorou';
  if (q.significant === true) return 'melhorou';
  if (q.significant === false || q.significant === null) {
    // Sem significância, o sinal do Δ é uma pista, não uma conclusão.
    return q.gainPp > 0 ? 'inconclusivo' : q.gainPp < 0 ? 'piorou' : 'sem-diferenca';
  }
  return 'inconclusivo';
}

// ---------------------------------------------------------------------------
// formatação (compartilhada por CLI, HTML e web)
// ---------------------------------------------------------------------------

export function fmtUsd(x: number | null | undefined, digits?: number): string {
  if (x == null || !Number.isFinite(x)) return '—';
  const abs = Math.abs(x);
  const d = digits ?? (abs === 0 ? 2 : abs < 0.01 ? 5 : abs < 1 ? 4 : 2);
  const s = abs.toFixed(d).replace('.', ',');
  return `${x < 0 ? '−' : ''}US$ ${s}`;
}

export function fmtSignedUsd(x: number | null | undefined, digits?: number): string {
  if (x == null || !Number.isFinite(x)) return '—';
  if (x === 0) return fmtUsd(0, digits);
  return x > 0 ? `+${fmtUsd(x, digits)}` : fmtUsd(x, digits);
}

export function fmtPp(x: number | null | undefined, signed = true): string {
  if (x == null || !Number.isFinite(x)) return '—';
  const s = Math.abs(x).toFixed(1).replace('.', ',');
  if (!signed) return `${x < 0 ? '−' : ''}${s}`;
  return `${x > 0 ? '+' : x < 0 ? '−' : '±'}${s} p.p.`;
}

export function fmtPct(x: number | null | undefined, signed = true): string {
  if (x == null || !Number.isFinite(x)) return '—';
  const s = Math.abs(x).toFixed(1).replace('.', ',');
  if (!signed) return `${s}%`;
  return `${x > 0 ? '+' : x < 0 ? '−' : '±'}${s}%`;
}

export function fmtInt(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return '—';
  return Math.round(x).toLocaleString('pt-BR');
}

export function fmtSignedNumber(x: number | null | undefined, digits = 0): string {
  if (x == null || !Number.isFinite(x)) return '—';
  const s = Math.abs(x).toFixed(digits).replace('.', ',');
  return `${x > 0 ? '+' : x < 0 ? '−' : '±'}${s}`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}min`;
}

export const VERDICT_LABEL: Record<ReportVerdict, string> = {
  melhorou: 'Melhorou (com significância)',
  piorou: 'Piorou',
  'sem-diferenca': 'Sem diferença detectável',
  inconclusivo: 'Inconclusivo',
  'sem-mudanca': 'Sem mudança (o original segurou)',
};

export const DECISION_LABEL: Record<CycleDecision, string> = {
  promoted: 'promovida',
  held: 'segurada',
  inconclusive: 'inconclusiva',
  baseline: 'régua manteve',
  stopped: 'interrompido',
};

export const ROLE_LABEL: Record<string, string> = {
  competitor: 'Respostas (competidores)',
  judge: 'Juízes',
  datagen: 'Geração de cenários',
  gabarito: 'Gabaritos',
  rewriter: 'Reescritor (variantes)',
  duel: 'Duelos',
  agent: 'Agente (LLM interno)',
};

function headlineOf(r: SessionReport): string {
  const q = r.quality;
  const c = r.cost;
  if (!r.prompts.changed) {
    return `Em ${r.session.cyclesRun} ciclo(s), nenhuma variante superou o prompt original com margem — o original segue campeão (custo por chamada inalterado). Otimizar custou ${fmtUsd(r.optimization.totalUsd)}.`;
  }
  const ganho =
    q.gainPp == null
      ? 'sem comparação pareada de qualidade'
      : `${fmtPp(q.gainPp)} de qualidade${q.originalScorePp != null && q.championScorePp != null ? ` (${fmtPp(q.originalScorePp, false)} → ${fmtPp(q.championScorePp, false)})` : ''}${
          q.source === 'holdout' ? ' no holdout' : q.source === 'training' ? ' nos cenários de treino' : ''
        }${q.significant === true ? ', estatisticamente significativo' : q.significant === false ? ', sem significância' : ''}`;
  const custo =
    c.deltaCostPct == null
      ? 'impacto no custo por chamada não medido'
      : c.deltaCostPct === 0
        ? 'o mesmo custo por chamada'
        : `custo por chamada ${c.deltaCostPct > 0 ? 'MAIOR' : 'MENOR'} em ${fmtPct(Math.abs(c.deltaCostPct), false)} (${fmtSignedUsd(c.per1kCalls?.deltaUsd)} por mil chamadas)`;
  return `O campeão entrega ${ganho}, com ${custo}. Otimizar custou ${fmtUsd(r.optimization.totalUsd)} em ${r.session.cyclesRun} ciclo(s).`;
}

// ---------------------------------------------------------------------------
// texto (terminal / brief para a skill plannotator-visual-explainer)
// ---------------------------------------------------------------------------

/** Relatório em Markdown — é o BRIEF que a skill plannotator-visual-explainer recebe. */
export function renderSessionReportMarkdown(r: SessionReport): string {
  const L: string[] = [];
  const q = r.quality;
  const c = r.cost;
  L.push(`# Relatório de ciclos — ${r.session.theme || r.session.id}`);
  L.push('');
  L.push(`> ${r.headline}`);
  L.push('');
  L.push(`**Veredito:** ${VERDICT_LABEL[r.verdict]} · sessão \`${r.session.id}\` · modelo \`${r.session.modelId}\` · ${r.session.cyclesRun}/${r.session.iterationsPlanned} ciclo(s) · ${r.session.promotions} promoção(ões) · duração ${fmtDuration(r.session.durationMs)}`);
  L.push('');
  L.push('## Quanto melhorou');
  L.push('');
  L.push(`- Base: ${q.basis}`);
  L.push(`- Original: ${fmtPp(q.originalScorePp, false)} · Campeão: ${fmtPp(q.championScorePp, false)} · Δ ${fmtPp(q.gainPp)} (${fmtPct(q.relativeGainPct)} relativo)`);
  L.push(`- n = ${q.n} (efetivo ${q.nEfetivo}) · IC95 ${q.ci95Pp ? `[${fmtPp(q.ci95Pp[0])}; ${fmtPp(q.ci95Pp[1])}]` : '—'} · p ${q.pValue == null ? '—' : q.pValue.toFixed(4).replace('.', ',')}${q.pOrigin ? ` (${q.pOrigin === 'holdout' ? 'confirmação no holdout' : 'da própria seleção — anti-conservador'})` : ''}`);
  if (q.verdicts) {
    const v = q.verdicts;
    L.push(`- Vereditos original: ${v.original.resolve} resolve · ${v.original.parcial} parcial · ${v.original.nao} não — campeão: ${v.champion.resolve} · ${v.champion.parcial} · ${v.champion.nao}`);
  }
  L.push('');
  L.push('## Ciclos');
  L.push('');
  L.push('| Ciclo | Régua | Melhor variante | Δ bruto | Δ corrigido | p aj. | Decisão | Custo | Acumulado |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const cy of r.cycles) {
    L.push(
      `| ${cy.label} | ${fmtPp(cy.controlScorePp, false)} | ${fmtPp(cy.bestScorePp, false)} | ${fmtPp(cy.gainPp)} | ${fmtPp(cy.gainCorrectedPp)} | ${cy.pAdjusted == null ? '—' : cy.pAdjusted.toFixed(3).replace('.', ',')} | ${DECISION_LABEL[cy.decision]}${cy.heldBy?.length ? ` (${cy.heldBy.join(', ')})` : ''} | ${fmtUsd(cy.costUsd)} | ${fmtUsd(cy.cumulativeCostUsd)} |`,
    );
  }
  L.push('');
  L.push('## Quanto a mudança mexe no custo de uso');
  L.push('');
  L.push(`- Base: ${c.basis} (${c.pairs} par(es))`);
  L.push(`- Custo por chamada: ${fmtUsd(c.original.meanCostUsd)} → ${fmtUsd(c.champion.meanCostUsd)} (${fmtSignedUsd(c.deltaCostPerCallUsd)}; ${fmtPct(c.deltaCostPct)})`);
  L.push(`- Tokens de entrada: ${fmtInt(c.original.meanTokensIn)} → ${fmtInt(c.champion.meanTokensIn)} (${fmtSignedNumber(c.deltaTokensIn)}) · saída: ${fmtInt(c.original.meanTokensOut)} → ${fmtInt(c.champion.meanTokensOut)} (${fmtSignedNumber(c.deltaTokensOut)})`);
  L.push(`- Latência média: ${fmtInt(c.original.meanLatencyMs)} ms → ${fmtInt(c.champion.meanLatencyMs)} ms (${fmtPct(c.deltaLatencyPct)})`);
  if (c.per1kCalls) L.push(`- Por 1.000 chamadas: ${fmtUsd(c.per1kCalls.originalUsd)} → ${fmtUsd(c.per1kCalls.championUsd)} (${fmtSignedUsd(c.per1kCalls.deltaUsd)})`);
  if (c.projection) L.push(`- Projeção a ${fmtInt(c.projection.callsPerMonth)} chamadas/mês: ${fmtUsd(c.projection.originalUsd)} → ${fmtUsd(c.projection.championUsd)} (${fmtSignedUsd(c.projection.deltaUsd)}/mês)`);
  if (c.paybackCalls != null) L.push(`- A otimização se paga em ${fmtInt(c.paybackCalls)} chamada(s).`);
  if (c.extraUsdPer1kPerPp != null) L.push(`- Cada p.p. de qualidade custa ${fmtUsd(c.extraUsdPer1kPerPp)} a mais por 1.000 chamadas.`);
  L.push('');
  L.push('## Custo da otimização');
  L.push('');
  L.push(`- Total: ${fmtUsd(r.optimization.totalUsd)}${r.optimization.budgetUsd != null ? ` de ${fmtUsd(r.optimization.budgetUsd)} (${fmtPct(r.optimization.budgetUsedPct, false)})` : ''}`);
  if (r.optimization.pendingUsd > 0) L.push(`- Pendente (sem custo apurado): ${fmtUsd(r.optimization.pendingUsd)}`);
  if (r.optimization.sessionOverheadUsd != null && r.optimization.sessionOverheadUsd > 0) {
    L.push(`- Fora das runs (reescritor/reflexão): ${fmtUsd(r.optimization.sessionOverheadUsd)}`);
  }
  for (const role of r.optimization.byRole) {
    L.push(`- ${ROLE_LABEL[role.role] ?? role.role}: ${fmtUsd(role.usd)} (${fmtPct(role.pct, false)}, ${fmtInt(role.calls)} chamada(s))`);
  }
  L.push('');
  L.push('## O que mudou no prompt');
  L.push('');
  const d = r.prompts.diff;
  L.push(`- ${r.prompts.changed ? `Campeão: ${r.prompts.championLabel}${r.prompts.promotedAtIteration != null ? ` (promovido no ciclo ${r.prompts.promotedAtIteration + 1})` : ''}` : 'Sem mudança'} · +${d.linesAdded}/−${d.linesRemoved} linha(s) · ${fmtSignedNumber(d.charsDelta)} caractere(s) (≈ ${fmtSignedNumber(d.approxTokensDelta)} tokens)`);
  L.push('');
  L.push('### Prompt original');
  L.push('');
  L.push('```text');
  L.push(r.prompts.original || '(vazio)');
  L.push('```');
  L.push('');
  L.push('### Prompt campeão');
  L.push('');
  L.push('```text');
  L.push(r.prompts.champion || '(vazio)');
  L.push('```');
  if (r.warnings.length) {
    L.push('');
    L.push('## Ressalvas');
    L.push('');
    for (const w of r.warnings) L.push(`- ${w}`);
  }
  L.push('');
  return L.join('\n');
}
