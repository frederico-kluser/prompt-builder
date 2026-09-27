// Ledger de gasto e sinais de controle do pipeline.
//
// Dois problemas resolvidos aqui:
//
// 1. CONTABILIDADE. Antes so `competitor.ts` contava dinheiro; juizes, gabarito,
//    datagen, duelos e o otimizador jogavam `tokensIn/tokensOut` fora. O ledger
//    e alimentado de dentro de `chatCompletion`/`chatCompletionStream` — um
//    unico ponto — e o papel (`CostRole`) vai junto no proprio call site.
//
// 2. ORCAMENTO SEM CORROMPER RESULTADO. O pipeline engole excecoes por design
//    (`refJudge` degrada falha de juiz para veredito 'parcial', `duels` para
//    'tie', `competitor` para status 'error'). Se o estouro de orcamento fosse
//    um erro comum, a run sairia PLAUSIVEL E ERRADA. Por isso BudgetExceeded e
//    RunCancelled sao SINAIS DE CONTROLE: todo catch que degrada precisa
//    re-lancar via `isControlSignal` antes de tratar.

import type {
  CallCost,
  CallFinishSignals,
  CostEntry,
  CostRole,
  CostSink,
  FinishSignalCounts,
  Reservation,
  RunPhase,
} from './types.js';
import { COST_ROLES } from './types.js';
import { cloneFinishCounts, emptyFinishCounts, tallyFinish } from './engine/truncation.js';
import type { SensitiveRouting } from './engine/sensitiveRouting.js';

// ---------------------------------------------------------------------------
// Sinais de controle
// ---------------------------------------------------------------------------

/** Marca que identifica um sinal de controle sem depender de identidade de classe. */
const CONTROL = 'benchControl';

export class BudgetExceeded extends Error {
  readonly benchControl = 'budget' as const;
  constructor(
    readonly spentUsd: number,
    readonly budgetUsd: number,
    readonly role?: CostRole,
  ) {
    super(
      `Orcamento esgotado: $${spentUsd.toFixed(4)} de $${budgetUsd.toFixed(4)}` +
        (role ? ` (bloqueado em: ${role})` : ''),
    );
    this.name = 'BudgetExceeded';
  }
}

export class RunCancelled extends Error {
  readonly benchControl = 'cancel' as const;
  constructor(reason?: unknown) {
    super(typeof reason === 'string' ? `Run cancelada: ${reason}` : 'Run cancelada.');
    this.name = 'RunCancelled';
  }
}

/**
 * Reconhece um sinal de controle SEM `instanceof`.
 *
 * Sob ESM, rodar via `tsx` (src/) e via `node dist/` pode carregar duas
 * instancias do mesmo modulo; `instanceof` daria `false` em silencio e o sinal
 * voltaria a ser engolido como erro comum — o mesmo bug de corrupcao, agora
 * intermitente. A checagem de propriedade propria e imune a isso.
 */
export function isControlSignal(e: unknown): e is BudgetExceeded | RunCancelled {
  return typeof e === 'object' && e !== null && CONTROL in e;
}

export function isBudgetSignal(e: unknown): e is BudgetExceeded {
  return isControlSignal(e) && (e as BudgetExceeded).benchControl === 'budget';
}

/**
 * Converte o MOTIVO de um abort em sinal de controle (IMPL-020). O que o
 * transporte devolve ao abortar varia (o `reason` do sinal, um `AbortError`
 * genérico, conforme o navegador/runtime); um erro comum seria DEGRADADO pelos
 * papéis (veredito 'parcial', competidor 'error') e viraria nota inventada.
 * Motivo que já é sinal de controle passa intacto.
 */
export function toControlSignal(reason: unknown): BudgetExceeded | RunCancelled {
  if (isControlSignal(reason)) return reason;
  const texto =
    typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : undefined;
  return new RunCancelled(texto);
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const NOOP_RESERVATION: Reservation = { release: () => undefined };

function emptyByRole(): Record<CostRole, CostEntry> {
  const out = {} as Record<CostRole, CostEntry>;
  for (const r of COST_ROLES) out[r] = { calls: 0, usd: 0, tokensIn: 0, tokensOut: 0 };
  return out;
}

export interface BudgetSnapshot {
  budgetUsd?: number;
  spentUsd: number;
  committedUsd: number;
  remainingUsd?: number;
  upstreamUsd: number;
  byRole: Record<CostRole, CostEntry>;
  accuracy: { exact: number; estimated: number; unknown: number };
  /**
   * Sinais de fim agregados por papel (IMPL-014) — so papeis com ao menos uma
   * chamada que completou. Copia: pode ir direto para o RunRecord.
   */
  finishByRole: Partial<Record<CostRole, FinishSignalCounts>>;
}

export interface BudgetLedgerOptions {
  /** Teto em USD. `undefined` = sem limite. */
  budgetUsd?: number;
  signal?: AbortSignal;
  /** Ledger pai — o gasto sobe para ele (usado por sessao de treino -> runs). */
  parent?: BudgetLedger;
  /**
   * Estimativa de custo de UMA chamada, em USD, usada apenas na reserva
   * otimista da porta dura. Sem ela a reserva vale 0 e o estouro volta a ser
   * limitado pela concorrencia, nao pelo erro de estimativa.
   */
  estimateCall?: (modelId: string, promptTokens: number, maxTokens: number) => number;
}

export class BudgetLedger implements CostSink {
  readonly budgetUsd?: number;
  readonly signal?: AbortSignal;
  private readonly parent?: BudgetLedger;
  private readonly estimateCall?: BudgetLedgerOptions['estimateCall'];

  spentUsd = 0;
  /** gasto realizado + reservas em voo. E o que a porta dura compara. */
  committedUsd = 0;
  upstreamUsd = 0;
  byRole: Record<CostRole, CostEntry> = emptyByRole();
  accuracy = { exact: 0, estimated: 0, unknown: 0 };
  /**
   * Sinais de fim por papel (IMPL-014): o gateway os entrega junto com o custo,
   * no MESMO ponto unico — assim juiz, duelo, datagen e reescritor tem
   * finish_reason/native_finish_reason/truncamento contados sem que cada papel
   * precise persisti-los. Sobe a cadeia como o custo (sessao ve o total).
   */
  finishByRole: Partial<Record<CostRole, FinishSignalCounts>> = {};

  constructor(opts: BudgetLedgerOptions = {}) {
    this.budgetUsd = opts.budgetUsd;
    this.signal = opts.signal ?? opts.parent?.signal;
    this.parent = opts.parent;
    this.estimateCall = opts.estimateCall ?? opts.parent?.estimateCall;
  }

  /**
   * Ledger filho: reporta o proprio total (para o RunRecord da iteracao) e
   * escreve tambem no pai. O TETO vive so na raiz — `root()` sobe a cadeia.
   */
  fork(): BudgetLedger {
    return new BudgetLedger({ parent: this });
  }

  /** Escopo do cofre de pseudonimos (LGPD, IMPL-042): a raiz — a run avulsa ou a sessao. */
  piiScope(): object {
    return this.root();
  }

  // LGPD (IMPL-040): politica do modo "dados sensiveis". So LIGA, nunca
  // desliga (fail-closed: um `undefined` posterior nao afrouxa a run), e vale
  // para a cadeia inteira abaixo — as runs de uma sessao sensivel herdam.
  private sensitive?: SensitiveRouting;

  /** Liga o modo sensivel neste ledger (e nos filhos). `undefined` = no-op. */
  setSensitiveRouting(routing: SensitiveRouting | undefined): void {
    if (routing) this.sensitive = routing;
  }

  /** A politica mais proxima subindo a cadeia (este ledger → raiz). */
  sensitiveRouting(): SensitiveRouting | undefined {
    for (let n: BudgetLedger | undefined = this; n; n = n.parent) {
      if (n.sensitive) return n.sensitive;
    }
    return undefined;
  }

  private root(): BudgetLedger {
    let node: BudgetLedger = this;
    while (node.parent) node = node.parent;
    return node;
  }

  remainingUsd(): number | undefined {
    const root = this.root();
    if (root.budgetUsd === undefined) return undefined;
    return Math.max(0, root.budgetUsd - root.spentUsd);
  }

  /** Cabe gastar `projectedUsd` a mais? Sem teto, sempre cabe. */
  canAfford(projectedUsd: number): boolean {
    const root = this.root();
    if (root.budgetUsd === undefined) return true;
    return root.spentUsd + projectedUsd <= root.budgetUsd;
  }

  /** Lanca RunCancelled se o sinal ja abortou. Usado nas fronteiras de fase. */
  throwIfCancelled(): void {
    const signal = this.root().signal;
    if (signal?.aborted) throw new RunCancelled(signal.reason);
  }

  // --- CostSink -------------------------------------------------------------

  reserve(
    role: CostRole,
    modelId: string,
    promptTokensGuess: number,
    maxTokens: number,
  ): Reservation {
    const root = this.root();
    if (root.signal?.aborted) throw new RunCancelled(root.signal.reason);
    if (root.budgetUsd === undefined) return NOOP_RESERVATION;

    const est = this.estimateCall?.(modelId, promptTokensGuess, maxTokens) ?? 0;
    if (root.committedUsd + est > root.budgetUsd) {
      throw new BudgetExceeded(root.spentUsd, root.budgetUsd, role);
    }

    // Reserva sobe a cadeia inteira: o teto e da raiz, mas cada nivel precisa
    // enxergar o que esta em voo abaixo dele.
    for (let n: BudgetLedger | undefined = this; n; n = n.parent) n.committedUsd += est;

    let liberado = false;
    return {
      release: () => {
        if (liberado) return;
        liberado = true;
        for (let n: BudgetLedger | undefined = this; n; n = n.parent) {
          n.committedUsd = Math.max(0, n.committedUsd - est);
        }
      },
    };
  }

  note(
    reservation: Reservation,
    entry: {
      role: CostRole;
      modelId: string;
      cost: CallCost;
      tokensIn: number;
      tokensOut: number;
      finish?: CallFinishSignals;
    },
  ): void {
    reservation.release();
    for (let n: BudgetLedger | undefined = this; n; n = n.parent) {
      const slot = n.byRole[entry.role];
      slot.calls += 1;
      slot.usd += entry.cost.usd;
      slot.tokensIn += entry.tokensIn;
      slot.tokensOut += entry.tokensOut;
      n.spentUsd += entry.cost.usd;
      n.committedUsd += entry.cost.usd;
      n.upstreamUsd += entry.cost.upstreamUsd ?? 0;
      if (entry.cost.source === 'usage') n.accuracy.exact += 1;
      else if (entry.cost.source === 'catalog') n.accuracy.estimated += 1;
      else n.accuracy.unknown += 1;
      if (entry.finish) {
        tallyFinish((n.finishByRole[entry.role] ??= emptyFinishCounts()), entry.finish);
      }
    }
  }

  // --- Leitura --------------------------------------------------------------

  snapshot(): BudgetSnapshot {
    return {
      budgetUsd: this.root().budgetUsd,
      spentUsd: this.spentUsd,
      committedUsd: this.committedUsd,
      remainingUsd: this.remainingUsd(),
      upstreamUsd: this.upstreamUsd,
      byRole: this.byRole,
      accuracy: { ...this.accuracy },
      finishByRole: Object.fromEntries(
        Object.entries(this.finishByRole).map(([role, c]) => [role, cloneFinishCounts(c!)]),
      ) as Partial<Record<CostRole, FinishSignalCounts>>,
    };
  }
}

/** Rotulo PT-BR de cada papel, para o relatorio final. */
export const ROLE_LABEL: Record<CostRole, string> = {
  datagen: 'datagen',
  gabarito: 'gabarito',
  competitor: 'competidor',
  judge: 'juiz',
  duel: 'duelo',
  rewriter: 'reescritor',
  /** Gasto de LLM feito DENTRO de uma execução de agente. */
  agent: 'agente de execução',
};

export const PHASE_LABEL: Record<RunPhase, string> = {
  variants: 'geracao de variantes',
  datagen: 'geracao de cenarios',
  gabarito: 'gabaritos',
  competitors: 'respostas dos competidores',
  judging: 'julgamento',
  finals: 'finais',
  holdout: 'holdout',
  /** O grupo de orçamento G2 em modo agente: rodar os agentes de fato. */
  agents: 'execução de agentes',
};
