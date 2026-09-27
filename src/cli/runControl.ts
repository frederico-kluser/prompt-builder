// Parada graciosa do processo do CLI (IMPL-030, R-12:REC-5).
//
// Antes só o Ctrl-C (SIGINT) era tratado; o SIGTERM — o que o host manda
// quando corta o shell do agente, o `kill` padrão, o `docker stop` — matava o
// processo SEM gravar nada e a run ficava 'running' para sempre em disco.
//
// Agora SIGTERM (e o pedido de parada de um job destacado cancelado por
// `runs cancel`) segue o mesmo caminho do cancelamento do MCP (IMPL-025):
//   1. aborta o AbortSignal do motor com `RunCancelled` — o ledger para de
//      reservar (nenhuma chamada paga nova) e as chamadas em voo caem com o
//      próprio sinal de controle, que atravessa os catch que degradam;
//   2. a run fecha normalmente: record 'aborted'/`stoppedReason: 'cancelled'`
//      com o parcial, exit 130 (ou 7 se já tinha parado por orçamento);
//   3. GRAÇA de ~10 s (SHUTDOWN_GRACE_MS): se o fechamento não acontecer nesse
//      prazo (algo ignorou o abort) — ou chegar um SEGUNDO sinal — o processo
//      grava ele mesmo o parcial em disco a partir do que já está lá
//      (`abortOwnedRecords`: status ≠ 'running') e sai com 130.
//
// Desvio consciente da R-12 ("espera as chamadas em voo"): as chamadas em voo
// são ABORTADAS, não drenadas — mesma semântica do IMPL-025. Drenar exigiria
// separar, no orquestrador (mirror), o sinal do ledger do sinal do fetch; e a
// run fecharia antes das chamadas drenadas serem anotadas no ledger.

import { RunCancelled } from '../budget.js';
import { SHUTDOWN_GRACE_MS } from '../jobs.js';
import { setSignalStoppable } from '../procOwner.js';
import { abortOwnedRecords } from '../storage.js';
import { EXIT } from './output.js';

type StopHandler = (reason: string) => void;

const handlers = new Set<StopHandler>();
/** Parada pedida antes de alguém se registrar (ex.: cancel durante o pré-voo). */
let pendingStop: string | null = null;
const forcedExitHooks = new Set<() => Promise<void>>();

/**
 * Pede a parada graciosa de quem estiver rodando neste processo (o filho do
 * `--detach` chama isto quando o job é cancelado). Sem ninguém registrado
 * ainda, o pedido fica pendente e é aplicado assim que a run se registrar.
 */
export function requestStop(reason: string): void {
  if (handlers.size === 0) {
    pendingStop ??= reason;
    return;
  }
  for (const h of [...handlers]) h(reason);
}

/** Quantas runs deste processo estão sob parada graciosa (0 = pré-voo/ocioso). */
export function activeStopHandlers(): number {
  return handlers.size;
}

/**
 * Registra um passo extra da SAÍDA FORÇADA (o filho do `--detach` grava o job
 * como cancelado). Devolve a função que o remove.
 */
export function onForcedExit(hook: () => Promise<void>): () => void {
  forcedExitHooks.add(hook);
  return () => forcedExitHooks.delete(hook);
}

/** Espera `p` por no máximo `ms` (nunca rejeita). */
function comTeto(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
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

/**
 * Saída forçada: grava 'aborted' em toda run/sessão que ESTE processo ainda
 * segura como 'running', roda os ganchos e sai. Cada passo tem teto: um disco
 * travado não pode segurar o processo para sempre.
 */
/**
 * `exit` é obrigatório: no CLI ele é o `failAndExit` do comando (envelope de
 * erro no stdout antes de sair — IMPL-028); só o output.ts chama process.exit.
 */
export async function forceExitNow(code: number, exit: (code: number) => void): Promise<void> {
  await comTeto(abortOwnedRecords(), 3_000);
  for (const hook of [...forcedExitHooks]) await comTeto(hook(), 2_000);
  exit(code);
}

export interface GracefulStopOptions {
  /** Narração (stderr). */
  warn: (msg: string) => void;
  /** Graça antes da saída forçada. Padrão SHUTDOWN_GRACE_MS (10 s). */
  graceMs?: number;
  /**
   * Como sair na saída forçada (graça esgotada / 2º sinal). No CLI: o
   * `failAndExit` do comando, para o NDJSON/JSON terminar no envelope (IMPL-028).
   */
  exit: (code: number) => void;
}

/**
 * Liga SIGTERM (e `requestStop`) ao AbortController da run. Devolve a função
 * que desliga tudo — chame no `finally` do comando.
 */
export function installGracefulStop(ac: AbortController, opts: GracefulStopOptions): () => void {
  const graceMs = opts.graceMs ?? SHUTDOWN_GRACE_MS;
  const exit = opts.exit;
  let pedidos = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let forcando = false;

  const forcar = (motivo: string): void => {
    if (forcando) return;
    forcando = true;
    if (timer) clearTimeout(timer);
    opts.warn(`${motivo}: gravando o parcial em disco e saindo agora.`);
    void forceExitNow(EXIT.SIGINT, exit);
  };

  const parar = (reason: string): void => {
    pedidos += 1;
    if (pedidos > 1) {
      forcar(`${reason} de novo`);
      return;
    }
    opts.warn(
      `${reason}: parando — nenhuma chamada paga nova; o parcial é gravado ` +
        `(graça de ${Math.round(graceMs / 1000)} s; outro sinal sai na hora).`,
    );
    // Sinal de CONTROLE (não string): o fetch em voo rejeita com ele e os
    // catch que degradam o re-lançam (isControlSignal) em vez de virar erro.
    if (!ac.signal.aborted) ac.abort(new RunCancelled(reason));
    // NÃO é unref: se algo ignorou o abort, é este timer que garante o fim.
    timer = setTimeout(() => forcar(`graça de ${Math.round(graceMs / 1000)} s esgotada`), graceMs);
  };

  const onSigterm = (): void => parar('SIGTERM');
  // Pedido PROGRAMÁTICO (job cancelado) é idempotente: o `runs cancel` manda
  // SIGTERM e grava o marcador; a vigia lê o marcador ~500 ms depois — contar
  // isso como "segundo sinal" pularia a graça. Só um 2º SINAL força a saída.
  const handler: StopHandler = (reason) => {
    if (pedidos === 0) parar(reason);
  };
  handlers.add(handler);
  process.on('SIGTERM', onSigterm);
  // O arquivo de dono das runs deste processo passa a dizer "SIGTERM para só
  // esta run" — é o que `runs cancel <runId>` (run sem job) consulta.
  setSignalStoppable(true);
  if (pendingStop !== null) {
    const r = pendingStop;
    pendingStop = null;
    parar(r);
  }
  return () => {
    handlers.delete(handler);
    process.off('SIGTERM', onSigterm);
    if (handlers.size === 0) setSignalStoppable(false);
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/** Só testes: zera o estado do processo. */
export function resetStopStateForTests(): void {
  handlers.clear();
  forcedExitHooks.clear();
  pendingStop = null;
  setSignalStoppable(false);
}
