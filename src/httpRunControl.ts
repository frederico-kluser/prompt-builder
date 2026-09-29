// Cancelamento das runs/sessões iniciadas por ESTE servidor HTTP (http-api#2).
//
// Antes, POST /v1/benchmark/runs e /sessions chamavam o motor SEM sinal de
// abort e não havia rota de cancelamento: o único jeito de parar uma run era
// matar o servidor (que deixava o record 'running' até a varredura de órfãs).
// E o `runs cancel` do CLI mandava o usuário para um DELETE que nunca existiu.
//
// Aqui mora o registro (id → AbortController) que as duas rotas (/v1/benchmark
// e /v1/agents) compartilham:
//   * `startControlledRun`/`startControlledTraining` são o `startRun`/
//     `startTraining` do motor com um AbortController registrado — mesma
//     assinatura e mesmo retorno;
//   * `cancelControlled` aborta com `RunCancelled` (sinal de CONTROLE: a run
//     fecha 'aborted'/`stoppedReason: 'cancelled'` com o parcial, nunca como
//     erro) e responde o que a rota devolve;
//   * `shutdownControlled` é o SIGTERM do servidor: aborta tudo e espera as
//     escritas terminais (com teto), para nada ficar 'running' em disco.
// O registro solta a entrada no evento terminal — sem listener órfão.

import { RunCancelled } from './budget.js';
import { subscribe, subscribeSession } from './events.js';
import { getLiveRun, startRun } from './orchestrator.js';
import type { StartRunOpts, StartRunResult } from './orchestrator.js';
import { abortOwnedRecords, loadRun, loadSession, ownedRecords } from './storage.js';
import { startTraining } from './trainer.js';
import type { StartTrainingOpts, StartTrainingResult } from './trainer.js';
import { isTerminalRunStatus } from './types.js';
import type { RunConfig } from './types.js';

export type ControlledKind = 'run' | 'session';

interface Entry {
  controller: AbortController;
  /** Resolve no evento terminal (run.finished/run.error, session.finished/error). */
  done: Promise<void>;
}

const registry: Record<ControlledKind, Map<string, Entry>> = {
  run: new Map(),
  session: new Map(),
};

/** Sinal que aborta pelo controller do registro OU pelo que o chamador já tinha. */
function withAbort(signal: AbortSignal | undefined, controller: AbortController): AbortSignal {
  return signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
}

function track(kind: ControlledKind, id: string, controller: AbortController): void {
  let settle!: () => void;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const entry: Entry = { controller, done };
  registry[kind].set(id, entry);
  const release = (): void => {
    off();
    if (registry[kind].get(id) === entry) registry[kind].delete(id);
    settle();
  };
  // Assinado de forma SÍNCRONA logo após o start: o terminal é emitido depois
  // de pelo menos um `await` do motor, então nunca escapa.
  const off =
    kind === 'run'
      ? subscribe(id, (e) => {
          if (e.type === 'run.finished' || e.type === 'run.error') release();
        })
      : subscribeSession(id, (e) => {
          if (e.type === 'session.finished' || e.type === 'session.error') release();
        });
}

/** `startRun` do motor com o AbortController registrado (cancelável por id). */
export function startControlledRun(config: RunConfig, apiKey: string, opts: StartRunOpts = {}): StartRunResult {
  const controller = new AbortController();
  const started = startRun(config, apiKey, {
    ...opts,
    signal: withAbort(opts.signal, controller),
    // `ctx` pronto tem precedência sobre `signal` no orquestrador.
    ...(opts.ctx ? { ctx: { ...opts.ctx, signal: withAbort(opts.ctx.signal, controller) } } : {}),
  });
  track('run', started.runId, controller);
  return started;
}

/** `startTraining` do motor com o AbortController registrado (cancelável por id). */
export function startControlledTraining(
  config: Parameters<typeof startTraining>[0],
  apiKey: string,
  opts: StartTrainingOpts = {},
): Promise<StartTrainingResult> {
  const controller = new AbortController();
  return startTraining(config, apiKey, {
    ...opts,
    signal: withAbort(opts.signal, controller),
    // `onSession` roda ANTES do laço: registrar aqui não perde o terminal.
    onSession: (sessionId, record) => {
      track('session', sessionId, controller);
      opts.onSession?.(sessionId, record);
    },
  });
}

/** Este processo controla (e pode abortar) esta run/sessão agora? */
export function isControlled(kind: ControlledKind, id: string): boolean {
  return registry[kind].has(id);
}

export type CancelOutcome =
  | { status: 202; body: { runId: string; aborted: true } | { sessionId: string; aborted: true } }
  | { status: 404 | 409; body: { error: string } };

/**
 * Pede o cancelamento. 202 = abortada (a run fecha 'aborted' logo em seguida;
 * idempotente até lá). 404 = não existe. 409 = já terminou, ou não roda neste
 * processo (CLI/MCP/outro servidor — não fingimos que abortou).
 */
export async function cancelControlled(
  kind: ControlledKind,
  id: string,
  reason = 'cancelada pela API HTTP',
): Promise<CancelOutcome> {
  // A memória vem ANTES do disco: a run que acabou de nascer pode ainda não
  // ter a primeira escrita (e o disco pode estar atrasado pelo throttle).
  const entry = registry[kind].get(id);
  if (entry) {
    if (!entry.controller.signal.aborted) entry.controller.abort(new RunCancelled(reason));
    return {
      status: 202,
      body: kind === 'run' ? { runId: id, aborted: true } : { sessionId: id, aborted: true },
    };
  }

  // O registro solta a entrada NO evento terminal; o record VIVO (memória do
  // orquestrador, solto só depois da escrita terminal) diz a verdade nessa
  // janela — sem ele, um cancel que chegasse entre o evento e o disco lia
  // 'running' e respondia "não roda neste servidor" para uma run que este
  // servidor acabou de terminar.
  const live = kind === 'run' ? getLiveRun(id) : undefined;
  if (live && isTerminalRunStatus(live.status)) {
    return {
      status: 409,
      body: { error: `A run já terminou (status "${live.status}") — nada a cancelar.` },
    };
  }

  const record = kind === 'run' ? await loadRun(id) : await loadSession(id);
  if (!record) {
    return { status: 404, body: { error: kind === 'run' ? 'Run nao encontrada' : 'Sessao nao encontrada' } };
  }
  if (isTerminalRunStatus(record.status)) {
    return {
      status: 409,
      body: {
        error: `${kind === 'run' ? 'A run' : 'A sessão'} já terminou (status "${record.status}") — nada a cancelar.`,
      },
    };
  }
  const sessionId = kind === 'run' ? (record as { sessionId?: string }).sessionId : undefined;
  if (sessionId && registry.session.has(sessionId)) {
    return {
      status: 409,
      body: {
        error:
          `Esta run é uma iteração da sessão de treino ${sessionId}: cancele a sessão ` +
          `(POST /v1/benchmark/sessions/${sessionId}/cancel).`,
      },
    };
  }
  return {
    status: 409,
    body: {
      error:
        `${kind === 'run' ? 'Esta run' : 'Esta sessão'} não roda neste servidor (foi iniciada pelo CLI, ` +
        'pelo MCP ou por outro processo) — cancele por lá: `prompt-builder runs cancel ' +
        `${id}\` ou \`cancel_run\` no MCP.`,
    },
  };
}

/** Espera `p` por no máximo `ms` (nunca rejeita). */
function withCeiling(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
    p.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      () => {
        clearTimeout(t);
        resolve();
      },
    );
  });
}

/** Resolve quando este processo não segura mais nenhum record 'running' em disco. */
async function ownedRecordsDrained(stop: { stopped: boolean }, pollMs = 50): Promise<void> {
  while (!stop.stopped && ownedRecords().length > 0) {
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export interface ShutdownResult {
  /** Quantas runs/sessões vivas foram abortadas. */
  aborted: number;
  /** Ids gravados 'aborted' à força (a graça acabou antes da escrita terminal). */
  forced: { runs: string[]; sessions: string[] };
}

/**
 * SIGTERM/SIGINT do servidor: aborta TODA run/sessão controlada aqui, espera o
 * fechamento normal (record 'aborted' + escrita terminal) por até `graceMs` e,
 * se algo ignorou o abort, grava o parcial à força (`abortOwnedRecords`).
 */
export async function shutdownControlled(graceMs = 5_000, reason = 'servidor encerrando'): Promise<ShutdownResult> {
  const entries = [...registry.run.values(), ...registry.session.values()];
  for (const e of entries) {
    if (!e.controller.signal.aborted) e.controller.abort(new RunCancelled(reason));
  }
  // O terminal é emitido ANTES da última escrita da run (o `saver.flush` vem
  // no finally do orquestrador): quem diz "gravado" é o registro de donos.
  const stop = { stopped: false };
  await withCeiling(
    Promise.all(entries.map((e) => e.done)).then(() => ownedRecordsDrained(stop)),
    graceMs,
  );
  stop.stopped = true;
  let forced: ShutdownResult['forced'] = { runs: [], sessions: [] };
  if (ownedRecords().length > 0) {
    // Cada passo com teto: um disco travado não segura o processo para sempre.
    await withCeiling(
      abortOwnedRecords().then((r) => {
        forced = r;
      }),
      3_000,
    );
  }
  return { aborted: entries.length, forced };
}
