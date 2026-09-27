// Camadas anti-gasto-N× para QUALQUER superfície que dispara uma run (IMPL-031,
// revisão). O `cmdRun` (compare/vary/train) monta as dele com o pré-voo e a
// --idempotency-key; as outras portas de gasto — tools MCP `run_benchmark`,
// `train_prompt`, `run_agent_benchmark` e `agents run` — chamavam o motor SEM
// `parentLedger`: o gasto delas não entrava em `<data-dir>/ledger`, o teto
// diário não as barrava e o lock por config não valia. O MCP é justamente a
// superfície do "agente desgovernado" que a camada existe para conter.
//
// `withSpendGuards` fecha o furo num ponto só: recusa ANTES de gastar (teto
// diário esgotado → `control.daily_cap_reached`; mesma config viva em outro
// processo → `run.locked`), abre a raiz `MachineBudgetLedger` (vai como
// `parentLedger` para `runToCompletion`/`trainToCompletion`) e solta tudo no fim.

import type { OpenRouterModel, RunConfig } from '../types.js';
import { makeCallEstimator } from '../estimate.js';
import type { CliError } from './output.js';
import { dailyCapError } from './preflight.js';
import { acquireRunLock, configHash, inspectRunLock, pruneIdempotency, runLockedError, type RunLock } from './runLock.js';
import {
  openMachineLedger,
  pruneLedgerDays,
  readDailySnapshot,
  resolveDailyCap,
  type FileSpendLedger,
  type MachineBudgetLedger,
} from './spendLedger.js';

export interface SpendGuardOptions {
  dataDir: string;
  /** A config que vai rodar, JÁ com `budgetUsd` (o teto da run fica na raiz). */
  config: RunConfig;
  /** Rótulo no lock e no ledger (ex.: `mcp run_benchmark`, `agents run`). */
  command: string;
  /** Catálogo para a reserva otimista por chamada (sem ele a reserva vale 0). */
  models?: OpenRouterModel[];
  signal?: AbortSignal;
  /** Lock da config (`run.locked`). Padrão: ligado. */
  lock?: boolean;
  warn?: (msg: string) => void;
}

export interface SpendGuards {
  /** Raiz do ledger: passe como `parentLedger`. */
  parentLedger: MachineBudgetLedger;
  machine: FileSpendLedger;
  lock: RunLock | null;
  close(): void;
}

/**
 * Recusas das camadas, SÓ LEITURA e na ordem em que `openSpendGuards` as
 * lançaria (lock da mesma config, depois teto diário esgotado — a mesma ordem
 * relativa do pré-voo do cmdRun). É o que um `--dry-run` reporta: paridade por
 * construção com a execução real. Teto inválido lança (config, exit 3) nos dois.
 */
export function spendGuardRefusals(opts: Pick<SpendGuardOptions, 'dataDir' | 'config' | 'lock'>): CliError[] {
  const recusas: CliError[] = [];
  if (opts.lock !== false) {
    const insp = inspectRunLock(opts.dataDir, configHash(opts.config));
    if (insp && !insp.stale) recusas.push(runLockedError(insp));
  }
  const cap = resolveDailyCap(opts.dataDir);
  const dia = readDailySnapshot(opts.dataDir, cap);
  if (dia.remainingUsd !== null && dia.remainingUsd <= 0) recusas.push(dailyCapError(dia, null));
  return recusas;
}

/**
 * GC do estado anti-gasto no disco: dias antigos do ledger e registros de
 * --idempotency-key vencidos. Barato (um readdir cada) e roda a cada abertura
 * do ledger — sem ele os dois diretórios cresciam para sempre. Nunca lança.
 */
export function pruneSpendState(dataDir: string, now: number = Date.now()): { ledgerDays: number; idempotency: number } {
  return { ledgerDays: pruneLedgerDays(dataDir, undefined, now), idempotency: pruneIdempotency(dataDir, undefined, now) };
}

/**
 * Abre as camadas (recusando antes de gastar). O chamador DEVE chamar
 * `close()` — prefira `withSpendGuards`, que garante isso.
 */
export function openSpendGuards(opts: SpendGuardOptions): SpendGuards {
  const [primeira] = spendGuardRefusals(opts);
  if (primeira) throw primeira;
  // Teto inválido (env/limits.json) já lançou acima (config, exit 3).
  const cap = resolveDailyCap(opts.dataDir);
  // A tomada é atômica: quem chegar entre a checagem e aqui sai com o MESMO run.locked.
  const lock =
    opts.lock === false ? null : acquireRunLock(opts.dataDir, { command: opts.command, configHash: configHash(opts.config) });
  try {
    pruneSpendState(opts.dataDir);
    const { root, machine } = openMachineLedger({
      dataDir: opts.dataDir,
      label: opts.command,
      budgetUsd: opts.config.budgetUsd,
      signal: opts.signal,
      // Preço variável reserva pelo pior caso limitado pelo teto da run (IMPL-018).
      estimateCall: makeCallEstimator(opts.models ?? [], { maxPricePerMTok: opts.config.maxPricePerMTok }),
      warn: opts.warn,
      cap,
    });
    let fechado = false;
    return {
      parentLedger: root,
      machine,
      lock,
      close: () => {
        if (fechado) return;
        fechado = true;
        lock?.release();
        machine.close();
      },
    };
  } catch (err) {
    lock?.release();
    throw err;
  }
}

/** `openSpendGuards` + `fn` + `close()` garantido. */
export async function withSpendGuards<T>(opts: SpendGuardOptions, fn: (g: SpendGuards) => Promise<T>): Promise<T> {
  const g = openSpendGuards(opts);
  try {
    return await fn(g);
  } finally {
    g.close();
  }
}
