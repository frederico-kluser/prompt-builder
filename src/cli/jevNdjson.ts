// Modo JEV — mapeamento enxuto JevEvent → linhas NDJSON (mesma regra do
// `ndjson.ts`: NUNCA o evento verbatim). Nunca sai estado de caso, texto de
// rubrica nem record inteiro; o NDJSON termina SEMPRE em `result` (quem emite
// é o comando). Sem `--emit-cells`, as células ficam fora (uma run de 1.000
// casos seriam 1.000 linhas).

import type { Output } from './output.js';
import type { JevEvent } from '../engine/jev/types.js';

export interface JevNdjsonOptions {
  /** `--emit-cells`: uma linha por célula (caso × competidor × rep). */
  cells?: boolean;
}

export function emitJevEventNdjson(out: Output, e: JevEvent, opts: JevNdjsonOptions = {}): void {
  switch (e.type) {
    case 'jev.run.started':
      out.event('jev.started', {
        runId: e.runId,
        mode: e.mode,
        cases: e.cases,
        contestants: e.contestants,
        requestsPlanned: e.requestsPlanned,
      });
      return;
    case 'jev.progress':
      out.event('jev.progress', { runId: e.runId, done: e.done, total: e.total, spentUsd: e.spentUsd, pendingUsd: e.pendingUsd });
      return;
    case 'jev.cell.done':
      if (!opts.cells) return;
      out.event('jev.cell', {
        runId: e.runId,
        caseId: e.caseId,
        contestantId: e.contestantId,
        rep: e.rep,
        status: e.status,
        correct: e.correct,
        ...(e.latencyMs !== undefined ? { latencyMs: e.latencyMs } : {}),
        ...(e.costUsd !== undefined ? { costUsd: e.costUsd } : {}),
      });
      return;
    case 'jev.contestant.done':
      out.event('jev.contestant', { runId: e.runId, contestantId: e.contestantId, ...e.metrics });
      return;
    case 'jev.run.finished':
      out.event('jev.finished', { runId: e.runId, status: e.status, stoppedReason: e.stoppedReason ?? null });
      return;
    case 'jev.iteration.gated':
      out.event('jev.iteration', {
        sessionId: e.sessionId,
        iteration: e.iteration,
        decision: e.decision,
        gainPp: e.gainPp,
        pAdjusted: e.pAdjusted,
        costUsd: e.costUsd,
      });
      return;
    case 'jev.session.finished':
      out.event('jev.session', { sessionId: e.sessionId, status: e.status, verdict: e.verdict });
      return;
    case 'jev.budget.exhausted':
      out.event('jev.budget', { spentUsd: e.spentUsd, budgetUsd: e.budgetUsd });
      return;
  }
}

/** Narração em TEXTO (stderr), throttled no progresso. */
export function narrateJevEvent(out: Output, e: JevEvent, state: { lastProgress: number }): void {
  if (!out.isText) return;
  if (e.type === 'jev.run.started') {
    out.info(`jev ${e.mode} ${e.runId}: ${e.cases} casos × ${e.contestants.length} competidor(es) — ${e.requestsPlanned} requests planejadas`);
  } else if (e.type === 'jev.progress') {
    const agora = Date.now();
    if (agora - state.lastProgress < 2000 && e.done !== e.total) return;
    state.lastProgress = agora;
    out.info(`  ${e.done}/${e.total} células · gasto US$ ${e.spentUsd.toFixed(6)}${e.pendingUsd > 0 ? ` (+ ${e.pendingUsd.toFixed(6)} pendente)` : ''}`);
  } else if (e.type === 'jev.iteration.gated') {
    out.info(`  ciclo ${e.iteration}: ${e.decision}${e.gainPp !== null ? ` (ganho ${e.gainPp.toFixed(2)} p.p., p aj. ${e.pAdjusted?.toFixed(3) ?? '—'})` : ''}`);
  } else if (e.type === 'jev.budget.exhausted') {
    out.warn(`orçamento esgotado: US$ ${e.spentUsd.toFixed(6)} de US$ ${e.budgetUsd.toFixed(6)} — resultado parcial.`);
  }
}
