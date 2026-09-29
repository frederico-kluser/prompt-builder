// `runs resume <id>` (IMPL-081, R-10:REC-2) — retoma uma run que parou sem
// terminar (processo morto/SIGKILL, Ctrl-C, orçamento, erro de key/crédito/
// rede) SEM pagar de novo o que já foi pago: o pipeline roda outra vez, com o
// MESMO id e a MESMA config, e as chamadas já concluídas voltam do journal da
// run (`<data-dir>/runs/<id>.journal`) a US$ 0.
//
// O dinheiro, sem contar em dobro:
//   • o gasto desta tentativa é o `totalCostUsd` do record; o das anteriores
//     fica em `resume.priorSpentUsd` (nunca somado de novo);
//   • o teto desta tentativa é o que SOBROU do original (teto − gasto − pendente
//     das anteriores) — `--budget <usd>|none` troca por um teto só da
//     continuação; sem teto nenhum e fora de TTY, recusa (a regra das runs);
//   • o ledger da máquina (teto diário) e o lock da config valem como numa run.

import os from 'node:os';
import { planResume, resumeToCompletion } from '../../orchestrator.js';
import { prepareOptsFor } from '../../prepareRun.js';
import { subscribe } from '../../events.js';
import { makeCallEstimator } from '../../estimate.js';
import { LOCKLESS_ORPHAN_AFTER_MS } from '../../jobs.js';
import { isValidRecordId } from '../../pathSafety.js';
import { sweepOrphanRecords } from '../../storage.js';
import { priorPendingUsdOf, priorSpentUsdOf, resumeBudgetUsd } from '../../engine/callJournal.js';
import { CliError, EXIT, failAndExit, fmtUsd } from '../output.js';
import { isAgentContext, loadCatalog, resolveKey, type CliContext } from '../context.js';
import { budgetRequiredError } from '../preflight.js';
import { acquireRunLock, configHash, type RunLock } from '../runLock.js';
import { openMachineLedger, resolveDailyCap } from '../spendLedger.js';
import { pruneSpendState } from '../spendGuards.js';
import { emitRunEvent } from '../ndjson.js';
import { forceExitNow, installGracefulStop } from '../runControl.js';
import { relatorioFinal, runOutcome } from './run.js';

/** `--budget` da retomada: número > 0 (teto só da continuação) ou `none`. */
function budgetFlag(v: unknown): { kind: 'usd'; usd: number } | { kind: 'none' } | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  if (v.trim().toLowerCase() === 'none') return { kind: 'none' };
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError('--budget deve ser um valor em USD maior que zero, ou "none".', EXIT.USAGE, { value: v }, {
      code: 'usage.invalid_budget',
      hint: 'Na retomada, `--budget <usd>` é o teto SÓ da continuação; sem a flag vale o que sobrou do teto original.',
    });
  }
  return { kind: 'usd', usd: n };
}

export async function runsResume(ctx: CliContext): Promise<number> {
  const { out, values, dataDir } = ctx;
  const id = ctx.positionals[0];
  if (!id) throw new CliError('Uso: prompt-builder runs resume <runId> [--budget <usd>|none]', EXIT.USAGE);
  if (!isValidRecordId(id)) {
    throw new CliError('Id de run inválido: use o id listado em `prompt-builder runs list`.', EXIT.USAGE);
  }
  // Dono morto (SIGKILL/queda) => 'aborted' agora, sem esperar timeout.
  await sweepOrphanRecords({ only: { kind: 'run', id }, locklessAfterMs: LOCKLESS_ORPHAN_AFTER_MS });
  const plano = await planResume(id);
  if (!plano.ok) {
    throw new CliError(`Retomada recusada: ${plano.reason}`, EXIT.USAGE, { runId: id, status: plano.record?.status ?? null }, {
      code: plano.record ? 'run.not_resumable' : 'run.not_found',
      hint: plano.record
        ? `Veja o record com \`prompt-builder runs show ${id} --json\`.`
        : 'Confira `prompt-builder runs list` e --data-dir.',
    });
  }
  const { previous, entries } = plano.plan;

  const flag = budgetFlag(values.budget);
  const budgetUsd = flag?.kind === 'none' ? undefined : resumeBudgetUsd(previous, flag?.kind === 'usd' ? flag.usd : undefined);
  const teveTeto = typeof previous.config.budgetUsd === 'number';
  if (!flag && budgetUsd === undefined && !teveTeto && isAgentContext()) throw budgetRequiredError();
  if (budgetUsd !== undefined && budgetUsd <= 0) {
    throw new CliError(
      `O teto original (${fmtUsd(previous.config.budgetUsd ?? 0)}) já foi gasto pelas tentativas anteriores ` +
        `(${fmtUsd(priorSpentUsdOf(previous))} gravados + ${fmtUsd(priorPendingUsdOf(previous))} pendentes) — nada foi gasto agora.`,
      EXIT.USAGE,
      { runId: id, priorSpentUsd: priorSpentUsdOf(previous), priorPendingUsd: priorPendingUsdOf(previous) },
      { code: 'usage.budget_exhausted', hint: 'Passe `--budget <usd>` com o teto da CONTINUAÇÃO (ou `--budget none`).' },
    );
  }
  if (budgetUsd === undefined) out.warn('Retomada SEM teto de gasto.');

  const apiKey = await resolveKey(values);
  const cat = await loadCatalog(ctx, apiKey);

  // Mesma trava de uma run: dois `runs resume` (ou a config rodando de novo)
  // em paralelo pagariam em dobro o que não está no journal.
  let lock: RunLock | null = acquireRunLock(dataDir, {
    command: 'resume',
    configHash: configHash(previous.config),
    runId: id,
    idempotencyKey: null,
  });

  const ac = new AbortController();
  const sairInterrompido = (code: number): void =>
    failAndExit(
      out,
      'runs.resume',
      new CliError('Interrompido: saída imediata, sem esperar a run fechar.', code, undefined, { code: 'control.interrupted' }),
    );
  let interrupts = 0;
  const onSigint = (): void => {
    interrupts += 1;
    if (interrupts === 1) {
      out.warn('interrompendo… (Ctrl-C de novo para sair na hora)');
      ac.abort('SIGINT');
      return;
    }
    void forceExitNow(EXIT.SIGINT, sairInterrompido);
  };
  process.on('SIGINT', onSigint);
  const stopGraceful = installGracefulStop(ac, { warn: (m) => out.warn(m), exit: sairInterrompido });

  pruneSpendState(dataDir);
  const { root, machine } = openMachineLedger({
    dataDir,
    label: `resume run ${id}`,
    budgetUsd,
    signal: ac.signal,
    estimateCall: makeCallEstimator(cat.models, { maxPricePerMTok: previous.config.maxPricePerMTok }),
    warn: (m) => out.warn(m),
    cap: resolveDailyCap(dataDir),
  });

  const unsub = subscribe(id, (e) => emitRunEvent(out, e, { verbose: ctx.verbose }));
  out.event('start', { command: 'runs.resume', runId: id, journalCalls: entries.length });
  out.info(
    `retomando run ${id} (${previous.status}${previous.stoppedReason ? `/${previous.stoppedReason}` : ''}) — ` +
      `${entries.length} chamada(s) no journal voltam a US$ 0; teto desta tentativa: ` +
      `${budgetUsd === undefined ? 'nenhum' : fmtUsd(budgetUsd)} (host ${os.hostname()})`,
  );
  try {
    const record = await resumeToCompletion(plano.plan, apiKey, {
      ...prepareOptsFor(previous.config, apiKey, { runId: id, ctx: { signal: ac.signal } }),
      parentLedger: root,
    });
    relatorioFinal(out, record);
    if (out.isText && record.resume) {
      const r = record.resume;
      out.line(
        `Retomada   tentativa ${r.attempt} · ${r.replayedCalls} chamada(s) do journal (US$ 0 agora; ` +
          `${fmtUsd(r.replayedUsd)} pagos antes) · gasto das tentativas anteriores ${fmtUsd(r.priorSpentUsd)}`,
      );
    }
    return runOutcome(out, record, { dailyCapReached: machine.capHit });
  } finally {
    unsub();
    process.off('SIGINT', onSigint);
    stopGraceful();
    lock?.release();
    lock = null;
    machine.close();
  }
}
