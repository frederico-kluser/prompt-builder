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
  CallLogEntry,
  CallProviderInfo,
  CostEntry,
  CostLedgerSummary,
  CostRole,
  CostSink,
  FinishSignalCounts,
  PendingCall,
  PendingReason,
  Reservation,
  ReservationStatus,
  RunPhase,
} from './types.js';
import { COST_ROLES } from './types.js';
import { cloneFinishCounts, emptyFinishCounts, tallyFinish } from './engine/truncation.js';
import type { SensitiveRouting } from './engine/sensitiveRouting.js';
import type { VerdictCache } from './engine/verdictCache.js';

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

/** Motivo de abort de um sinal como erro (o que o `fetch` rejeitaria). */
function abortReasonOf(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Chamada abortada antes do envio.');
}

function emptyByRole(): Record<CostRole, CostEntry> {
  const out = {} as Record<CostRole, CostEntry>;
  for (const r of COST_ROLES) out[r] = { calls: 0, usd: 0, tokensIn: 0, tokensOut: 0 };
  return out;
}

/** Pendente conciliavel (IMPL-017) — o tipo mora em types.ts (vai no record). */
export type { PendingCall };

/**
 * IMPL-074 — teto do registo POR CHAMADA (`callLog`) em cada nivel do ledger:
 * uma sessao longa nao cresce sem limite (o excedente so e contado em
 * `callLogDropped`). O ledger enxuto (`summary`) nunca leva o registo.
 */
export const CALL_LOG_LIMIT = 2000;

/**
 * IMPL-074 (R-07a:REC-4) — formato do id de geracao do OpenRouter: `gen-` +
 * >= 20 caracteres alfanumericos/hifen. Cobre as duas formas vistas
 * (`gen-<24 chars>` da documentacao e `gen-<unix>-<20 chars>` das respostas
 * atuais). Fora disso o id NAO e conciliavel (o GET /generation devolveria 404
 * para sempre — o caso do executor `pi`, que sintetiza ids proprios).
 */
export const GENERATION_ID_RE = /^gen-[A-Za-z0-9-]{20,}$/;

/** true = id de geracao no formato do OpenRouter (conciliavel pelo GET /generation). */
export function isGenerationId(id: unknown): id is string {
  return typeof id === 'string' && GENERATION_ID_RE.test(id.trim());
}

/** Detalhes que a conciliacao (GET /generation) grava no registo da chamada. */
export interface SettleDetails {
  provider?: CallProviderInfo;
  cancelled?: boolean;
  generationTimeMs?: number;
  latencyMs?: number;
}

/** Estado interno de uma reserva; a `Reservation` publica e so a alca. */
interface ReservationState {
  status: ReservationStatus;
  usd: number;
  role: CostRole;
  /** IMPL-074: registo desta chamada (compartilhado pela cadeia), quando ja lancado. */
  log?: CallLogEntry;
  /** Ledger onde a reserva nasceu (a cadeia sobe dele ate a raiz). */
  owner: BudgetLedger;
  /** Custo impossivel de estimar com teto definido — conta no limite por papel. */
  unbounded: boolean;
}

/**
 * Reserva -> estado, sem expor campos mutaveis na alca. WeakMap: uma reserva
 * alheia (ex.: a nula do agente) simplesmente nao tem estado.
 */
const RESERVATIONS = new WeakMap<Reservation, ReservationState>();

export interface BudgetSnapshot {
  budgetUsd?: number;
  /** Gasto medido + gasto conservador (reservas sem id lancadas inteiras). */
  spentUsd: number;
  /** spent + pending + em voo. E o que a porta dura compara. */
  committedUsd: number;
  /** Reservas mantidas a espera de conciliacao (IMPL-017). */
  pendingUsd: number;
  pendingCalls: number;
  /** Parte de `spentUsd` que e reserva inteira, sem id para conciliar. */
  conservativeUsd: number;
  conservativeCalls: number;
  remainingUsd?: number;
  /**
   * Chamadas BYOK (`usage.is_byok: true`) e o que o PROVEDOR cobrou nelas
   * direto na key BYOK — FORA de `spentUsd` (créditos do OpenRouter; na BYOK,
   * só a taxa). `byokUpstreamUnknownCalls` = BYOK sem o custo do provedor na
   * resposta (não medido, não é zero). Chamada não-BYOK nunca entra aqui: o
   * `upstream_inference_cost` dela já está dentro de `usd`.
   */
  byokCalls: number;
  byokUpstreamUsd: number;
  byokUpstreamUnknownCalls: number;
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

  /** Gasto medido + conservador. NAO inclui o pendente (ainda nao se sabe). */
  spentUsd = 0;
  /** gasto realizado + pendentes + reservas em voo. E o que a porta dura compara. */
  committedUsd = 0;
  /**
   * Reservas de chamadas despachadas sem custo medido e com id de geracao
   * (IMPL-017): nem gasto nem devolvidas. Entram em `committedUsd`.
   */
  pendingUsd = 0;
  /** Parte de `spentUsd` lancada como reserva inteira (sem id para conciliar). */
  conservativeUsd = 0;
  conservativeCalls = 0;
  /** BYOK (ver `BudgetSnapshot`): só chamadas com `is_byok: true`; fora de `spentUsd`. */
  byokCalls = 0;
  byokUpstreamUsd = 0;
  byokUpstreamUnknownCalls = 0;
  byRole: Record<CostRole, CostEntry> = emptyByRole();
  accuracy = { exact: 0, estimated: 0, unknown: 0 };
  /**
   * Sinais de fim por papel (IMPL-014): o gateway os entrega junto com o custo,
   * no MESMO ponto unico — assim juiz, duelo, datagen e reescritor tem
   * finish_reason/native_finish_reason/truncamento contados sem que cada papel
   * precise persisti-los. Sobe a cadeia como o custo (sessao ve o total).
   */
  finishByRole: Partial<Record<CostRole, FinishSignalCounts>> = {};
  /** Pendentes visiveis NESTE nivel (o mesmo objeto sobe a cadeia inteira). */
  private readonly pendingSet = new Set<
    PendingCall & { state: ReservationState; provider?: CallProviderInfo; latencyMs?: number; auditable?: boolean }
  >();
  /**
   * IMPL-074 — registo por chamada deste nivel (os MESMOS objetos sobem a
   * cadeia: a conciliacao atualiza em todos os niveis de uma vez).
   */
  private readonly callLogItems: CallLogEntry[] = [];
  /** Chamadas que passaram de `CALL_LOG_LIMIT` neste nivel. */
  callLogDropped = 0;
  /** IMPL-074 — contagens acumuladas da conciliacao (ver `noteReconciliation`). */
  private reconciliation?: NonNullable<CostLedgerSummary['reconciliation']>;
  /** So na raiz: chamadas sem estimativa em voo por papel + quem espera vaga. */
  private readonly unboundedInFlight: Partial<Record<CostRole, number>> = {};
  private readonly unboundedWaiters: Partial<Record<CostRole, Array<() => void>>> = {};
  /**
   * So na raiz: chamadas SEM preco que terminaram sem custo medido
   * (abort/timeout/sem usage), por papel. A reserva delas vale 0, entao o
   * gasto real (cobrado pelo provedor) nao pesa em lugar nenhum; liberar a
   * vaga e deixar a proxima entrar repetiria isso sem limite. Com teto e
   * contador > 0, nova chamada sem preco daquele papel e RECUSADA
   * (BudgetExceeded) — o que mantem o estouro <= 1 chamada por papel.
   * Conciliar a pendente (`settlePending` com custo) devolve a vaga.
   */
  private readonly unboundedUnmeasured: Partial<Record<CostRole, number>> = {};

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

  // IMPL-075: modo AUDITAVEL por run/sessao (mesmo padrao do modo sensivel:
  // so liga, nunca desliga; vale para a cadeia abaixo). Quem liga:
  // `RunConfig.auditable` (schema, arena-config `judging.auditable`, CLI
  // `--auditable`) nos orquestradores e no trainer; alem do env
  // OPENROUTER_AUDITABLE (preset do gateway).
  private auditable?: CostRole[];

  /** Liga o modo auditavel para `roles` (vazio/`undefined` = no-op). */
  setAuditableRoles(roles: readonly CostRole[] | undefined): void {
    if (roles && roles.length > 0) this.auditable = [...new Set([...(this.auditable ?? []), ...roles])];
  }

  /** Papeis auditaveis mais proximos subindo a cadeia (este ledger → raiz). */
  auditableRoles(): readonly CostRole[] | undefined {
    for (let n: BudgetLedger | undefined = this; n; n = n.parent) {
      if (n.auditable) return n.auditable;
    }
    return undefined;
  }

  // IMPL-080 (R-08:REC-3): cache EXATO de vereditos com escopo de SESSAO. O
  // trainer liga um por sessao na raiz dela; as runs das iteracoes (forks)
  // herdam. `null` num nivel DESLIGA dali para baixo (a re-avaliacao limpa e o
  // holdout medem de novo — reusar veredito ali reintroduziria a correlacao
  // com a selecao que eles existem para quebrar).
  private verdictCacheSlot?: VerdictCache | null;

  /** Liga o cache de vereditos neste nivel (`null` = desliga daqui para baixo). */
  setVerdictCache(cache: VerdictCache | null): void {
    this.verdictCacheSlot = cache;
  }

  /** O cache mais proximo subindo a cadeia; `null` num nivel corta a heranca. */
  verdictCache(): VerdictCache | undefined {
    for (let n: BudgetLedger | undefined = this; n; n = n.parent) {
      if (n.verdictCacheSlot === null) return undefined;
      if (n.verdictCacheSlot) return n.verdictCacheSlot;
    }
    return undefined;
  }

  private root(): BudgetLedger {
    let node: BudgetLedger = this;
    while (node.parent) node = node.parent;
    return node;
  }

  /** Do nivel `from` ate a raiz. */
  private static chain(from: BudgetLedger): BudgetLedger[] {
    const out: BudgetLedger[] = [];
    for (let n: BudgetLedger | undefined = from; n; n = n.parent) out.push(n);
    return out;
  }

  /**
   * Quanto ainda cabe: teto - gasto - PENDENTE. O pendente provavelmente foi
   * cobrado (o provedor segue gerando depois do abort); trata-lo como livre
   * deixaria a porta suave autorizar o que a fatura ja consumiu.
   */
  remainingUsd(): number | undefined {
    const root = this.root();
    if (root.budgetUsd === undefined) return undefined;
    return Math.max(0, root.budgetUsd - root.spentUsd - root.pendingUsd);
  }

  /** Cabe gastar `projectedUsd` a mais? Sem teto, sempre cabe. */
  canAfford(projectedUsd: number): boolean {
    const root = this.root();
    if (root.budgetUsd === undefined) return true;
    return root.spentUsd + root.pendingUsd + projectedUsd <= root.budgetUsd;
  }

  /** Lanca RunCancelled se o sinal ja abortou. Usado nas fronteiras de fase. */
  throwIfCancelled(): void {
    const signal = this.root().signal;
    if (signal?.aborted) throw new RunCancelled(signal.reason);
  }

  /**
   * Estimativa da reserva: o maior entre o estimador do ledger e o do gateway
   * (catalogo em cache). `known = false` = nenhum dos dois conseguiu precificar
   * (0 do estimador sem fallback e "fora do catalogo", nao "gratis").
   */
  private estimate(
    modelId: string,
    promptTokens: number,
    maxTokens: number,
    fallbackUsd?: number,
  ): { usd: number; known: boolean } {
    const raw = this.estimateCall?.(modelId, promptTokens, maxTokens);
    const est = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
    const fb = typeof fallbackUsd === 'number' && Number.isFinite(fallbackUsd) && fallbackUsd >= 0 ? fallbackUsd : undefined;
    return { usd: Math.max(est, fb ?? 0), known: est > 0 || fb !== undefined };
  }

  // --- CostSink -------------------------------------------------------------

  reserve(
    role: CostRole,
    modelId: string,
    promptTokensGuess: number,
    maxTokens: number,
    fallbackUsd?: number,
  ): Reservation {
    const root = this.root();
    if (root.signal?.aborted) throw new RunCancelled(root.signal.reason);

    const { usd: est, known } = this.estimate(modelId, promptTokensGuess, maxTokens, fallbackUsd);
    if (root.budgetUsd !== undefined && root.committedUsd + est > root.budgetUsd) {
      throw new BudgetExceeded(root.spentUsd, root.budgetUsd, role);
    }
    // Sem preco e com uma chamada sem preco deste papel ja perdida sem custo
    // medido: o teto nao e mais garantivel — recusa em vez de gastar as cegas.
    if (root.budgetUsd !== undefined && !known && (root.unboundedUnmeasured[role] ?? 0) > 0) {
      throw new BudgetExceeded(root.spentUsd, root.budgetUsd, role);
    }

    // Reserva sobe a cadeia inteira: o teto e da raiz, mas cada nivel precisa
    // enxergar o que esta em voo abaixo dele. Sem teto a reserva existe do
    // mesmo jeito (IMPL-017): e ela que vira pendente/conservador no abort.
    for (const n of BudgetLedger.chain(this)) n.committedUsd += est;
    const unbounded = root.budgetUsd !== undefined && !known;
    if (unbounded) root.unboundedInFlight[role] = (root.unboundedInFlight[role] ?? 0) + 1;

    const state: ReservationState = { status: 'reserved', usd: est, role, owner: this, unbounded };
    const reservation: Reservation = {
      release: () => {
        if (!this.close(state, 'released')) return;
        for (const n of BudgetLedger.chain(this)) n.committedUsd = Math.max(0, n.committedUsd - est);
      },
      get status() {
        return state.status;
      },
      usd: est,
    };
    RESERVATIONS.set(reservation, state);
    return reservation;
  }

  /**
   * `reserve` que respeita o limite de estouro (IMPL-017, criterio v): com teto
   * definido e custo IMPOSSIVEL de estimar (fora do catalogo), a reserva vale 0
   * e nao segura nada — entao o ledger admite no maximo UMA chamada dessas em
   * voo por papel; as outras esperam ela fechar e sao reavaliadas contra o
   * gasto ja medido. O estouro fica limitado a 1 chamada em voo por papel.
   * Chamada com preco conhecido nao espera nunca (sem cap local de concorrencia:
   * quem limita vazao continua sendo o limitador do gateway).
   */
  async admit(
    role: CostRole,
    modelId: string,
    promptTokensGuess: number,
    maxTokens: number,
    fallbackUsd?: number,
    signal?: AbortSignal,
  ): Promise<Reservation> {
    const root = this.root();
    for (;;) {
      const unbounded =
        root.budgetUsd !== undefined &&
        !this.estimate(modelId, promptTokensGuess, maxTokens, fallbackUsd).known;
      if (!unbounded || !root.unboundedInFlight[role]) {
        return this.reserve(role, modelId, promptTokensGuess, maxTokens, fallbackUsd);
      }
      await root.waitUnboundedSlot(role, signal);
    }
  }

  /**
   * Espera a vaga sem preco do papel. Solta com o sinal da RUN (RunCancelled)
   * ou com o da PROPRIA chamada (rejeita com o motivo do abort, como o fetch
   * faria) — antes so o sinal da raiz era observado e uma chamada abortada
   * individualmente ficava presa na fila (IMPL-017, revisao).
   */
  private waitUnboundedSlot(role: CostRole, callSignal?: AbortSignal): Promise<void> {
    const runSignal = this.signal;
    return new Promise<void>((resolve, reject) => {
      if (runSignal?.aborted) {
        reject(new RunCancelled(runSignal.reason));
        return;
      }
      if (callSignal?.aborted) {
        reject(abortReasonOf(callSignal));
        return;
      }
      const cleanup = () => {
        runSignal?.removeEventListener('abort', onRunAbort);
        callSignal?.removeEventListener('abort', onCallAbort);
        const fila = this.unboundedWaiters[role];
        const i = fila ? fila.indexOf(wake) : -1;
        if (i >= 0) fila!.splice(i, 1);
      };
      const onRunAbort = () => {
        cleanup();
        reject(new RunCancelled(runSignal?.reason));
      };
      const onCallAbort = () => {
        cleanup();
        reject(abortReasonOf(callSignal!));
      };
      const wake = () => {
        cleanup();
        resolve();
      };
      runSignal?.addEventListener('abort', onRunAbort, { once: true });
      callSignal?.addEventListener('abort', onCallAbort, { once: true });
      (this.unboundedWaiters[role] ??= []).push(wake);
    });
  }

  /** Fecha a reserva (idempotente). Devolve false se ja estava fechada. */
  private close(state: ReservationState, status: ReservationStatus): boolean {
    if (state.status !== 'reserved') return false;
    state.status = status;
    if (state.unbounded) {
      const root = state.owner.root();
      // Sem preco E sem custo medido: marca o papel ANTES de acordar a fila,
      // para a proxima da fila ser recusada em vez de entrar (ver reserve).
      if (status === 'pending' || status === 'conservative') {
        root.unboundedUnmeasured[state.role] = (root.unboundedUnmeasured[state.role] ?? 0) + 1;
      }
      root.unboundedInFlight[state.role] = Math.max(0, (root.unboundedInFlight[state.role] ?? 1) - 1);
      const waiters = root.unboundedWaiters[state.role] ?? [];
      root.unboundedWaiters[state.role] = [];
      for (const wake of waiters) wake();
    }
    return true;
  }

  /** Lanca um custo na cadeia `from` -> raiz (sem mexer em reserva). */
  private static book(
    from: BudgetLedger,
    entry: {
      role: CostRole;
      cost: CallCost;
      tokensIn: number;
      tokensOut: number;
      finish?: CallFinishSignals;
      /** IMPL-078: telemetria de uso por chamada (somada por papel). */
      cachedTokensIn?: number;
      reasoningTokens?: number;
      latencyMs?: number;
      estimatedUsd?: number;
      /** IMPL-075: provedor que serviu e modo auditavel. */
      provider?: CallProviderInfo;
      auditable?: boolean;
    },
  ): void {
    const add = (v: number | undefined, prev: number | undefined): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? (prev ?? 0) + v : prev;
    const providerName = entry.provider?.name?.trim();
    for (const n of BudgetLedger.chain(from)) {
      const slot = n.byRole[entry.role];
      slot.calls += 1;
      slot.usd += entry.cost.usd;
      slot.tokensIn += entry.tokensIn;
      slot.tokensOut += entry.tokensOut;
      // IMPL-078 (R-08:REC-5): antes o ledger real descartava estes campos —
      // so um sink de teste os via. Somados aqui, no ponto unico.
      const cached = add(entry.cachedTokensIn, slot.cachedTokensIn);
      if (cached !== undefined) slot.cachedTokensIn = cached;
      const reasoning = add(entry.reasoningTokens, slot.reasoningTokens);
      if (reasoning !== undefined) slot.reasoningTokens = reasoning;
      const latency = add(entry.latencyMs, slot.latencyTotalMs);
      if (latency !== undefined) slot.latencyTotalMs = latency;
      const estimated = add(entry.estimatedUsd, slot.estimatedUsd);
      if (estimated !== undefined) slot.estimatedUsd = estimated;
      if (providerName) {
        slot.providers = { ...(slot.providers ?? {}) };
        slot.providers[providerName] = (slot.providers[providerName] ?? 0) + 1;
      }
      if (entry.auditable) slot.auditableCalls = (slot.auditableCalls ?? 0) + 1;
      n.spentUsd += entry.cost.usd;
      n.committedUsd += entry.cost.usd;
      // BYOK só quando o OpenRouter disse `is_byok: true` (`cost.byok`): o
      // `upstream_inference_cost` de uma chamada NÃO-BYOK já está em `usd` e
      // somá-lo aqui dobraria o gasto (medido numa run paga: upstream == total).
      if (entry.cost.byok === true) {
        n.byokCalls += 1;
        const up = entry.cost.byokUpstreamUsd;
        if (typeof up === 'number' && Number.isFinite(up)) n.byokUpstreamUsd += up;
        else n.byokUpstreamUnknownCalls += 1;
      }
      // `usage` continua a ÚNICA fonte exata (IMPL-096). `agent-derived` (o que
      // o executor calculou) e `catalog` (tabela do /models) são PRECIFICADOS
      // mas não medidos no gateway: contam como estimados.
      if (entry.cost.source === 'usage') n.accuracy.exact += 1;
      else if (entry.cost.source === 'catalog' || entry.cost.source === 'agent-derived') n.accuracy.estimated += 1;
      else n.accuracy.unknown += 1;
      if (entry.finish) {
        tallyFinish((n.finishByRole[entry.role] ??= emptyFinishCounts()), entry.finish);
      }
    }
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
      cachedTokensIn?: number;
      reasoningTokens?: number;
      latencyMs?: number;
      estimatedUsd?: number;
      provider?: CallProviderInfo;
      generationId?: string;
      auditable?: boolean;
    },
  ): void {
    const state = RESERVATIONS.get(reservation);
    if (state) {
      if (!this.close(state, 'noted')) return; // ja fechada: nunca lancar duas vezes
      for (const n of BudgetLedger.chain(state.owner)) n.committedUsd = Math.max(0, n.committedUsd - state.usd);
    } else {
      reservation.release();
    }
    BudgetLedger.book(this, entry);
    BudgetLedger.log(this, {
      role: entry.role,
      modelId: entry.modelId,
      ...generationIdFields(entry.generationId),
      usd: entry.cost.usd,
      source: entry.cost.source,
      status: 'measured',
      ...byokLogFields(entry.cost),
      ...(entry.provider?.name ? { provider: entry.provider.name } : {}),
      ...(typeof entry.latencyMs === 'number' ? { latencyMs: entry.latencyMs } : {}),
      ...(entry.auditable ? { auditable: true } : {}),
    });
  }

  /** IMPL-074 — anexa uma chamada ao registo de cada nivel da cadeia (com teto). */
  private static log(from: BudgetLedger, entry: CallLogEntry): CallLogEntry {
    for (const n of BudgetLedger.chain(from)) {
      if (n.callLogItems.length < CALL_LOG_LIMIT) n.callLogItems.push(entry);
      else n.callLogDropped += 1;
    }
    return entry;
  }

  /** IMPL-074 — registo por chamada deste nivel (copia; vai no `RunRecord.callLog`). */
  callLog(): CallLogEntry[] {
    return this.callLogItems.map((e) => ({ ...e }));
  }

  /**
   * IMPL-080 (R-08:REC-3) — contagem do cache EXATO de vereditos por papel.
   * Cada lookup (hit ou miss) sobe para `byRole[role].cacheTotal`/`cacheHits`,
   * que o evento `run.spend` carrega pronto (`CostEntry`). Um hit NÃO é
   * chamada upstream nem gasto: não toca `calls`/`usd` — ele só prova que o
   * veredito foi REUSADO (o re-teste amostral é quem re-julga de verdade).
   */
  noteVerdictCache(entry: { role: CostRole; hit: boolean }): void {
    for (const n of BudgetLedger.chain(this)) {
      const slot = n.byRole[entry.role];
      slot.cacheTotal = (slot.cacheTotal ?? 0) + 1;
      if (entry.hit) slot.cacheHits = (slot.cacheHits ?? 0) + 1;
    }
  }

  /**
   * Chamada despachada sem custo medido (abort/timeout/sem usage). A reserva
   * NUNCA e devolvida: o provedor pode ter cobrado a resposta inteira (no
   * nao-streaming ele segue gerando depois do abort).
   * - com `generationId`: fica PENDENTE (committed estavel; nem gasto nem
   *   devolvida) ate `settlePending` conciliar pelo GET /generation;
   * - sem id: vira gasto CONSERVADOR — a reserva inteira, `source: 'unknown'`
   *   (nao medido nao e "custou zero").
   */
  pending(
    reservation: Reservation,
    entry: {
      role: CostRole;
      modelId: string;
      reason: PendingReason;
      generationId?: string;
      finish?: CallFinishSignals;
      provider?: CallProviderInfo;
      latencyMs?: number;
      auditable?: boolean;
    },
  ): void {
    const state = RESERVATIONS.get(reservation);
    if (state && state.status !== 'reserved') return;
    const usd = state?.usd ?? 0;
    const owner = state?.owner ?? this;
    if (entry.finish) {
      for (const n of BudgetLedger.chain(owner)) {
        tallyFinish((n.finishByRole[entry.role] ??= emptyFinishCounts()), entry.finish);
      }
    }
    const generationId = entry.generationId?.trim();
    const logBase = {
      role: entry.role,
      modelId: entry.modelId,
      ...generationIdFields(generationId),
      usd,
      source: 'unknown' as const,
      ...(entry.provider?.name ? { provider: entry.provider.name } : {}),
      ...(typeof entry.latencyMs === 'number' ? { latencyMs: entry.latencyMs } : {}),
      ...(entry.auditable ? { auditable: true } : {}),
    };
    if (state && generationId) {
      this.close(state, 'pending');
      state.log = BudgetLedger.log(owner, { ...logBase, status: 'pending' });
      const item = {
        generationId,
        role: entry.role,
        modelId: entry.modelId,
        usd,
        reason: entry.reason,
        state,
        ...(entry.provider ? { provider: entry.provider } : {}),
        ...(typeof entry.latencyMs === 'number' ? { latencyMs: entry.latencyMs } : {}),
        ...(entry.auditable ? { auditable: true } : {}),
      };
      for (const n of BudgetLedger.chain(owner)) {
        n.pendingUsd += usd;
        n.pendingSet.add(item);
      }
      return;
    }
    if (state) {
      this.close(state, 'conservative');
      // A reserva ja estava no committed: sai de "em voo" e entra como gasto.
      for (const n of BudgetLedger.chain(owner)) n.committedUsd = Math.max(0, n.committedUsd - usd);
    } else {
      reservation.release();
    }
    BudgetLedger.book(owner, {
      role: entry.role,
      cost: { usd, source: 'unknown' },
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: entry.latencyMs,
      provider: entry.provider,
      auditable: entry.auditable,
    });
    BudgetLedger.log(owner, { ...logBase, status: 'conservative' });
    for (const n of BudgetLedger.chain(owner)) {
      n.conservativeUsd += usd;
      n.conservativeCalls += 1;
    }
  }

  /** Pendentes ainda nao conciliados (o que o IMPL-074 consulta no /generation). */
  pendingEntries(): PendingCall[] {
    return [...this.pendingSet].map((p) => ({
      generationId: p.generationId,
      role: p.role,
      modelId: p.modelId,
      usd: p.usd,
      reason: p.reason,
    }));
  }

  /**
   * GANCHO DE CONCILIACAO (IMPL-074 / R-07a:REC-4): troca a reserva pendente
   * pelo custo que o GET /api/v1/generation devolveu. `cost = null` = o id nao
   * foi achado (404 persistente): a reserva vira gasto conservador. Devolve
   * false se o id nao esta pendente neste ledger.
   */
  settlePending(
    generationId: string,
    cost: CallCost | null,
    tokens: { tokensIn?: number; tokensOut?: number } = {},
    details: SettleDetails = {},
  ): boolean {
    const item = [...this.pendingSet].find((p) => p.generationId === generationId);
    if (!item) return false;
    const owner = item.state.owner;
    for (const n of BudgetLedger.chain(owner)) {
      n.pendingSet.delete(item);
      n.pendingUsd = Math.max(0, n.pendingUsd - item.usd);
      n.committedUsd = Math.max(0, n.committedUsd - item.usd);
    }
    // O /generation completa a proveniencia (IMPL-075): o provedor que a fatura
    // diz ter servido vence o do payload.
    const provider = details.provider?.name ? details.provider : item.provider;
    const latencyMs = typeof details.latencyMs === 'number' ? details.latencyMs : item.latencyMs;
    if (cost) {
      item.state.status = 'reconciled';
      // Custo agora conhecido: a vaga sem preco do papel volta a valer.
      if (item.state.unbounded) {
        const root = owner.root();
        root.unboundedUnmeasured[item.role] = Math.max(0, (root.unboundedUnmeasured[item.role] ?? 1) - 1);
      }
      BudgetLedger.book(owner, {
        role: item.role,
        cost,
        tokensIn: tokens.tokensIn ?? 0,
        tokensOut: tokens.tokensOut ?? 0,
        latencyMs,
        provider,
        auditable: item.auditable,
      });
    } else {
      item.state.status = 'conservative';
      BudgetLedger.book(owner, {
        role: item.role,
        cost: { usd: item.usd, source: 'unknown' },
        tokensIn: 0,
        tokensOut: 0,
        latencyMs,
        provider,
        auditable: item.auditable,
      });
      for (const n of BudgetLedger.chain(owner)) {
        n.conservativeUsd += item.usd;
        n.conservativeCalls += 1;
      }
    }
    // Registo da chamada (mesmo objeto em toda a cadeia): estado final + fatura.
    const log = item.state.log;
    if (log) {
      log.status = cost ? 'reconciled' : 'conservative';
      log.usd = cost ? cost.usd : item.usd;
      log.source = cost ? cost.source : 'unknown';
      if (cost) Object.assign(log, byokLogFields(cost));
      if (provider?.name) log.provider = provider.name;
      if (details.provider?.upstreamId) log.upstreamId = details.provider.upstreamId;
      if (typeof details.cancelled === 'boolean') log.cancelled = details.cancelled;
      if (typeof details.generationTimeMs === 'number') log.generationTimeMs = details.generationTimeMs;
      if (typeof latencyMs === 'number') log.latencyMs = latencyMs;
    }
    return true;
  }

  /**
   * IMPL-074 — grava as contagens de uma rodada de conciliacao (GET
   * /generation) neste nivel e acima: vai no `summary().reconciliation`.
   */
  noteReconciliation(r: NonNullable<CostLedgerSummary['reconciliation']>): void {
    for (const n of BudgetLedger.chain(this)) {
      const prev = n.reconciliation ?? { attempted: 0, settled: 0, notFound: 0, failed: 0 };
      n.reconciliation = {
        attempted: prev.attempted + r.attempted,
        settled: prev.settled + r.settled,
        notFound: prev.notFound + r.notFound,
        failed: prev.failed + r.failed,
      };
    }
  }

  // --- Leitura --------------------------------------------------------------

  /**
   * O que vai para o resultado da run/sessao (IMPL-017). Com pendentes, leva
   * as entradas (id/papel/modelo/reserva/motivo): o record sobrevive ao
   * processo e e ele que a conciliacao posterior (IMPL-074) le.
   */
  summary(): CostLedgerSummary {
    const pendentes = this.pendingEntries();
    return {
      spentUsd: this.spentUsd,
      committedUsd: this.committedUsd,
      pendingUsd: this.pendingUsd,
      pendingCalls: pendentes.length,
      conservativeUsd: this.conservativeUsd,
      conservativeCalls: this.conservativeCalls,
      ...(pendentes.length > 0 ? { pendingEntries: pendentes } : {}),
      ...(this.byokCalls > 0
        ? {
            byok: {
              calls: this.byokCalls,
              upstreamUsd: this.byokUpstreamUsd,
              upstreamUnknownCalls: this.byokUpstreamUnknownCalls,
            },
          }
        : {}),
      ...(this.reconciliation ? { reconciliation: { ...this.reconciliation } } : {}),
    };
  }

  snapshot(): BudgetSnapshot {
    return {
      budgetUsd: this.root().budgetUsd,
      spentUsd: this.spentUsd,
      committedUsd: this.committedUsd,
      pendingUsd: this.pendingUsd,
      pendingCalls: this.pendingSet.size,
      conservativeUsd: this.conservativeUsd,
      conservativeCalls: this.conservativeCalls,
      remainingUsd: this.remainingUsd(),
      byokCalls: this.byokCalls,
      byokUpstreamUsd: this.byokUpstreamUsd,
      byokUpstreamUnknownCalls: this.byokUpstreamUnknownCalls,
      byRole: this.byRole,
      accuracy: { ...this.accuracy },
      finishByRole: Object.fromEntries(
        Object.entries(this.finishByRole).map(([role, c]) => [role, cloneFinishCounts(c!)]),
      ) as Partial<Record<CostRole, FinishSignalCounts>>,
    };
  }
}

/** Campos do id de geracao no registo: o id e se ele tem o formato conciliavel. */
function generationIdFields(id: string | undefined): Pick<CallLogEntry, 'generationId' | 'generationIdValid'> {
  const g = id?.trim();
  if (!g) return {};
  return { generationId: g, generationIdValid: isGenerationId(g) };
}

/** BYOK no registo por chamada: só com `cost.byok` (o OpenRouter disse `is_byok: true`). */
function byokLogFields(cost: CallCost): Pick<CallLogEntry, 'byok' | 'byokUpstreamUsd'> {
  if (cost.byok !== true) return {};
  return { byok: true, ...(typeof cost.byokUpstreamUsd === 'number' ? { byokUpstreamUsd: cost.byokUpstreamUsd } : {}) };
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
