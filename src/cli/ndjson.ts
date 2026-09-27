// Mapeamento RunEvent/SessionEvent -> linhas NDJSON.
//
// ⚠️ REGRA CRITICA: nunca transmitir o evento verbatim. `run.started` e
// `run.finished` embutem RunRecords INTEIROS e `competitor.finished` carrega o
// TEXTO COMPLETO da resposta — uma unica run de treino estouraria a janela de
// contexto do agente que esta lendo o stream. Cada evento vira um payload
// enxuto; o record completo fica no disco, acessivel por `runs show`.

import type { Output } from './output.js';
import type { CostLedgerSummary, CostRole, RunEvent, SessionEvent, RunRecord } from '../types.js';
import { truncationAlert } from '../engine/truncation.js';

/**
 * Ledger SEM a lista de pendentes: no stream vao so os 6 numeros (um run com
 * centenas de timeouts nao pode inflar uma linha de NDJSON). A lista completa
 * fica no RunRecord e no `--json` (IMPL-017).
 */
function leanLedger(l: CostLedgerSummary): CostLedgerSummary {
  const { pendingEntries: _omit, ...enxuto } = l;
  return enxuto;
}

export interface NdjsonMapperOptions {
  /** Com --verbose, inclui config e systemPrompt (que sao grandes). */
  verbose?: boolean;
  /** Marca as linhas de run com o sessionId, quando dentro de um treino. */
  sessionId?: string;
}

export interface AgentSummary {
  /** Quantas respostas carregam ExecutionRef (execuções de agente). */
  executions: number;
  /** Execuções que morreram em erro de infra/processo (stopReason 'error'). */
  failed: number;
  /** Execuções cortadas por nossos tetos (maxTurns/maxCost/timeout/maxOutput/cancelled). */
  incomplete: number;
  /** Média de turnos por execução (0 quando não há execuções). */
  avgTurns: number;
  /** Média de custo (USD, do response.costUsd) por execução (0 quando não há). */
  avgCostUsd: number;
  /** Razão passed/(passed+failed) do oráculo, agregada (0 quando não há oráculo). */
  oracleRate: number;
}

/**
 * Agrega as execuções de agente de uma run para a linha `run.finished` (e o
 * `result` do CLI). É o resumo que um agente-cliente usa para decidir o próximo
 * passo sem abrir arquivo. Campos sem dados viram 0. `undefined` quando a run
 * não tem NENHUMA resposta com `execution` — aí o resumo não faz sentido no
 * stream (run de chat pura não perde a linha atual).
 */
function buildAgentSummary(record: RunRecord): AgentSummary | undefined {
  const exes = record.stages
    .flatMap((s) => s.responses)
    .filter((r): r is typeof r & { execution: NonNullable<typeof r['execution']> } => Boolean(r.execution));
  if (exes.length === 0) return undefined;

  let failed = 0;
  let incomplete = 0;
  let turnsSum = 0;
  let costSum = 0;
  let oraclePassed = 0;
  let oracleTotal = 0;
  for (const r of exes) {
    turnsSum += r.execution.turns;
    costSum += r.costUsd;
    if (r.execution.stopReason === 'error') {
      failed += 1;
    } else if (r.execution.stopReason !== 'completed') {
      // maxTurns/maxCost/timeout/maxOutput/cancelled: a culpa é do NOSSO teto,
      // não do agente — conta como incompleta, nunca como erro (§15.2 do plano).
      incomplete += 1;
    }
    if (r.execution.oracle) {
      oraclePassed += r.execution.oracle.passed;
      oracleTotal += r.execution.oracle.passed + r.execution.oracle.failed;
    }
  }

  return {
    executions: exes.length,
    failed,
    incomplete,
    avgTurns: turnsSum / exes.length,
    avgCostUsd: costSum / exes.length,
    oracleRate: oracleTotal > 0 ? oraclePassed / oracleTotal : 0,
  };
}

/**
 * Campos de truncamento do resultado da run (IMPL-014 / R-07b:REC-2): a taxa
 * (TODAS as chamadas de LLM da run), o numerador/denominador, a quebra POR
 * PAPEL (`truncationByRole` — so `calls`/`truncated`; os histogramas de
 * finish_reason ficam no record, `runs show`) e o ALERTA (texto) quando passa
 * de 2%. Usado no `run.finished` do NDJSON e no `result` do `--json` — o mesmo
 * formato nos dois. Record anterior ao IMPL-014 (sem `truncationRate`) nao
 * ganha campo nenhum.
 */
export function truncationFields(record: RunRecord): {
  truncationRate?: number;
  truncationCounts?: { calls: number; truncated: number };
  truncationByRole?: Partial<Record<CostRole, { calls: number; truncated: number }>>;
  truncationAlert?: string;
} {
  if (typeof record.truncationRate !== 'number') return {};
  const counts = record.truncationCounts ?? { calls: 0, truncated: 0 };
  const porPapel = Object.fromEntries(
    Object.entries(record.finishSignalsByRole ?? {})
      .filter(([, c]) => c && c.calls > 0)
      .map(([role, c]) => [role, { calls: c!.calls, truncated: c!.truncated }]),
  ) as Partial<Record<CostRole, { calls: number; truncated: number }>>;
  const alerta = truncationAlert({ ...counts, rate: record.truncationRate }, porPapel);
  return {
    truncationRate: record.truncationRate,
    truncationCounts: counts,
    ...(Object.keys(porPapel).length ? { truncationByRole: porPapel } : {}),
    ...(alerta ? { truncationAlert: alerta } : {}),
  };
}

export function emitRunEvent(out: Output, e: RunEvent, opts: NdjsonMapperOptions = {}): void {
  if (!out.isNdjson) return;
  // Durante um treino, eventos de sessao e de cada iteracao se intercalam: sem
  // `scope` + os dois ids o stream fica ambiguo e nao da para reconstruir.
  const base = { scope: 'run' as const, runId: e.runId, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) };

  switch (e.type) {
    case 'run.started':
      out.event('run.started', {
        ...base,
        mode: e.record.mode,
        stages: e.record.config.stages,
        contestants: e.record.contestants.map((c) => ({ id: c.id, label: c.label })),
        ...(opts.verbose ? { config: e.record.config } : {}),
      });
      break;
    case 'variants.generating':
      out.event('variants.generating', base);
      break;
    case 'variants.generated':
      out.event('variants.generated', {
        ...base,
        contestants: e.contestants.map((c) => ({
          id: c.id,
          label: c.label,
          ...(c.parentContestantId ? { parentId: c.parentContestantId } : {}),
          ...(opts.verbose ? { systemPrompt: c.systemPrompt } : {}),
        })),
      });
      break;
    case 'stage.generating':
      out.event('stage.generating', { ...base, stageIndex: e.stageIndex });
      break;
    case 'stage.generated':
      out.event('stage.generated', {
        ...base,
        stageIndex: e.stageIndex,
        question: e.spec.question,
        hasRubric: Boolean(e.spec.rubric?.trim()),
        hasReference: Boolean(e.spec.reference?.trim()),
        // IMPL-014: gabarito truncado mesmo apos o retry x2 e descartado — a
        // etapa e julgada sem regua. Aviso curto (sem o texto do gabarito).
        ...(e.gabaritoCall?.truncated ? { referenceTruncated: true } : {}),
        ...(e.warning ? { warning: e.warning } : {}),
      });
      break;
    case 'stage.failed':
      out.event('stage.failed', { ...base, stageIndex: e.stageIndex, error: e.error });
      break;
    case 'stage.incomplete':
      // IMPL-014: etapa fora do placar e das medias. So ids e o motivo — o
      // texto das respostas truncadas fica no record (`runs show`).
      out.event('stage.incomplete', {
        ...base,
        stageIndex: e.stageIndex,
        reason: e.reason,
        detail: e.detail,
        ...(e.contestantIds?.length ? { contestantIds: e.contestantIds } : {}),
      });
      break;
    case 'competitor.finished':
      out.event('competitor.finished', {
        ...base,
        stageIndex: e.stageIndex,
        contestantId: e.response.contestantId,
        modelId: e.response.modelId,
        status: e.response.status,
        latencyMs: e.response.latencyMs,
        tokensIn: e.response.tokensIn,
        tokensOut: e.response.tokensOut,
        costUsd: e.response.costUsd,
        chars: e.response.text.length,
        ...(e.response.errorMsg ? { errorMsg: e.response.errorMsg } : {}),
        // IMPL-014: cortada no teto (mesmo apos o retry x2) / precisou do retry.
        ...(e.response.truncated ? { truncated: true } : {}),
        ...(e.response.truncationRetried ? { truncationRetried: true } : {}),
      });
      break;
    case 'stage.judging':
      out.event('stage.judging', { ...base, stageIndex: e.stageIndex });
      break;
    case 'stage.judged':
      out.event('stage.judged', {
        ...base,
        stageIndex: e.stageIndex,
        verdicts: e.judge.verdictByContestant ?? {},
        ranked: e.judge.rankedContestantIds,
        scoreboard: e.scoreboard,
        totalCostUsd: e.totalCostUsd,
      });
      break;
    case 'stage.gabarito':
      // O sentinela `stageIndex: -1` significa "progresso agregado do lote",
      // nao uma etapa. Normalizado aqui para nao confundir quem consome.
      out.event('progress', { ...base, phase: 'gabarito', done: e.done, total: e.total });
      break;
    case 'finals.started':
      out.event('finals.started', { ...base, finalists: e.finalists });
      break;
    case 'stage.dueled':
      out.event('stage.dueled', {
        ...base,
        stageIndex: e.stageIndex,
        pairs: e.duels.duels.map((d) => ({ a: d.a, b: d.b, winner: d.outcome })),
      });
      break;
    case 'duel.progress':
      out.event('progress', { ...base, phase: 'duels', done: e.done, total: e.total });
      break;
    case 'run.spend':
      out.event('budget', {
        ...base,
        spentUsd: e.spentUsd,
        ...(e.budgetUsd !== undefined ? { budgetUsd: e.budgetUsd } : {}),
        byRole: e.byRole,
      });
      break;
    case 'run.budget':
      out.event('budget.gate', {
        ...base,
        phase: e.phase,
        projectedUsd: e.projectedUsd,
        remainingUsd: e.remainingUsd,
        decision: e.decision,
      });
      break;
    case 'run.finished': {
      const agentSummary = buildAgentSummary(e.record);
      out.event('run.finished', {
        ...base,
        status: e.record.status,
        totalCostUsd: e.record.totalCostUsd,
        // IMPL-017: spent/committed/pending (6 números, cabem no stream).
        ...(e.record.costLedger ? { costLedger: leanLedger(e.record.costLedger) } : {}),
        stages: e.record.stages.length,
        ...(agentSummary ? { agentSummary } : {}),
        ...(e.record.budgetExhausted ? { budgetExhausted: true } : {}),
        ...(e.record.stoppedAtPhase ? { stoppedAtPhase: e.record.stoppedAtPhase } : {}),
        ...(e.record.standings ? { standings: e.record.standings } : {}),
        ...(e.record.judgeScoreByContestant
          ? { judgeScoreByContestant: e.record.judgeScoreByContestant }
          : {}),
        // IMPL-010: bloqueio ≠ recusa ≠ erro (3 números pequenos, cabem no stream).
        ...(e.record.competitorOutcomeCounts
          ? { competitorOutcomeCounts: e.record.competitorOutcomeCounts }
          : {}),
        // IMPL-014: taxa de truncamento + alerta acima de 2%.
        ...truncationFields(e.record),
      });
      break;
    }
    // ----------------------------------------------------------------------
    // Eventos ADITIVOS do modo agente (§6.4/§23 do plano). Todos enxutos: a
    // trajetória, o texto dos turnos e a saída das ferramentas ficam em disco
    // (ExecutionRef/dossier) e NUNCA cruzam o stream — um agente emite dezenas
    // de tool calls por etapa e o conteúdo quebraria a janela de quem faz tail.
    case 'agent.started':
      out.event('agent.started', {
        ...base,
        stageIndex: e.stageIndex,
        contestantId: e.contestantId,
        execId: e.execId,
        repetition: e.repetition,
      });
      break;
    case 'agent.turn':
      out.event('agent.turn', {
        ...base,
        stageIndex: e.stageIndex,
        contestantId: e.contestantId,
        execId: e.execId,
        turn: e.turn,
        costUsd: e.costUsd,
      });
      break;
    case 'agent.tool':
      out.event('agent.tool', {
        ...base,
        stageIndex: e.stageIndex,
        contestantId: e.contestantId,
        execId: e.execId,
        toolName: e.toolName,
        ok: e.ok,
        // Só com --verbose (summary já vem truncado no evento). NUNCA a saída.
        ...(opts.verbose && e.summary ? { summary: e.summary } : {}),
      });
      break;
    case 'agent.finished':
      out.event('agent.finished', {
        ...base,
        stageIndex: e.stageIndex,
        contestantId: e.contestantId,
        execId: e.execId,
        stopReason: e.stopReason,
        turns: e.turns,
        costUsd: e.costUsd,
        ...(e.diffStat ? { diffStat: e.diffStat } : {}),
      });
      break;
    case 'agent.verified':
      out.event('agent.verified', {
        ...base,
        stageIndex: e.stageIndex,
        contestantId: e.contestantId,
        execId: e.execId,
        results: e.results,
      });
      break;
    case 'run.error':
      out.event('run.error', { ...base, error: e.error });
      break;
  }
}

export function emitSessionEventNdjson(out: Output, e: SessionEvent): void {
  if (!out.isNdjson) return;
  const base = { scope: 'session' as const, sessionId: e.sessionId };
  switch (e.type) {
    case 'session.started':
      out.event('session.started', {
        ...base,
        iterations: e.record.config.iterations,
        theme: e.record.config.theme,
      });
      break;
    case 'iteration.started':
      out.event('iteration.started', { ...base, iteration: e.iteration, runId: e.runId });
      break;
    case 'iteration.finished':
      out.event('iteration.finished', {
        ...base,
        iteration: e.iteration,
        runId: e.runId,
        winnerContestantId: e.winnerContestantId,
      });
      break;
    case 'iteration.promoted':
      out.event('iteration.promoted', {
        ...base,
        iteration: e.iteration,
        championId: e.championId,
        gain: e.gain,
      });
      break;
    case 'session.holdout':
      out.event('session.holdout', { ...base, ...e.holdout });
      break;
    case 'session.converged':
      out.event('session.converged', { ...base, iteration: e.iteration });
      break;
    case 'session.finished':
      out.event('session.finished', {
        ...base,
        status: e.record.status,
        totalCostUsd: e.record.totalCostUsd,
        ...(e.record.costLedger ? { costLedger: leanLedger(e.record.costLedger) } : {}), // IMPL-017
        iterationsDone: e.record.bestPromptByIteration.length,
        ...(e.record.significance ? { significance: e.record.significance } : {}),
        ...(e.record.holdoutSkipped ? { holdoutSkipped: true } : {}),
        ...(e.record.budgetExhausted ? { budgetExhausted: true } : {}),
      });
      break;
    case 'session.error':
      out.event('session.error', { ...base, error: e.error });
      break;
  }
}
