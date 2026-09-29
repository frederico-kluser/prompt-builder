// ----------------------------------------------------------------------------
// `costProxy.ts` — o proxy de CUSTO do modo agente (IMPL-035 / R-14b REC-2).
//
// POR QUE existe (R-14b DEC-4/DEC-5): antes, o custo de uma execução de agente
// era o que o PRÓPRIO executor dizia (tabela do pi = 'agent-derived') e o teto
// `maxCostUsd` só agia matando o processo DEPOIS do estouro — a chamada em voo já
// tinha sido cobrada, e o orçamento da run só olhava portões de fase. Nenhum
// harness lê o custo COBRADO; o OpenRouter o devolve em `usage.cost` no último
// chunk SSE e um pass-through o preserva. Por isso este módulo, pendurado nos
// ganchos do proxy de inferência (`inferenceProxy.ts`, UM por run), faz quatro
// coisas:
//
//   1. IDENTIFICA a chamada pelo token fictício → (execId, contestant, papel),
//      mapeamento que só o produto conhece (o agente não o forja).
//   2. MEDE: acompanha o stream (sem buffer) e lê o `usage.cost` do ÚLTIMO chunk
//      SSE (ou do corpo JSON), anotando no MESMO ledger de `src/budget.ts`
//      (`CostSink.reserve/note`, papel 'agent') — o ponto único de contabilidade.
//   3. FREIA ANTES da chamada seguinte (modelo do `max_budget_limiter` do
//      LiteLLM): se o gasto comprometido + o custo PROJETADO da chamada não cabe
//      no teto da execução (`maxCostUsd`) ou no saldo da run, responde 429
//      `budget_exhausted` SEM ir ao provedor. É sinal de CONTROLE: o executor o
//      traduz em `stopReason: 'maxCost'` (e a run, no escopo 'run', sobe o
//      `BudgetExceeded` como qualquer outro papel). O kill por custo derivado do
//      executor continua como segunda barreira.
//   4. LIMITA a taxa: um limitador AIMD GLOBAL do processo para as chamadas do
//      agente (o do gateway não as vê — elas saem de dentro do executor).
//
// Projeção (a decisão que faz a 3ª chamada de US$ 0,04 ser recusada num teto de
// US$ 0,10): custo esperado = max(última chamada medida, média medida) — na
// execução, senão na run para o mesmo modelo; sem nenhuma medição, o piso do
// catálogo para o prompt desta requisição (`content-length`/4 tokens × preço de
// entrada). Somada ao que está EM VOO, ela limita o estouro a ≤ 1 chamada média
// por execução em voo (semântica cooperativa do Inspect, R-14b DEC-5). O piso do
// catálogo NÃO entra depois da 1ª medição: com cache de prompt ele superestima
// muito e frearia com orçamento sobrando.
//
// ⚠️ Só Node. Nunca importe do web — o modo agente não existe na SPA.
// ----------------------------------------------------------------------------
import type { IncomingHttpHeaders } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { performance } from 'node:perf_hooks';
import { BudgetExceeded, isBudgetSignal, isControlSignal } from '../budget.js';
import { AimdLimiter, computeCost, extractUsage, getGateway, priceUsage, type UsageInfo } from '../openrouter.js';
import type { CallCost, CostSink, CostSource, OpenRouterModel, Reservation } from '../types.js';
import type { CostBrake, CostBrakeStop, MeasuredCost } from './executor.js';
import type {
  InferenceExchange,
  InferenceExchangeSummary,
  InferenceGateDecision,
  InferenceProxyHooks,
} from './inferenceProxy.js';
import type { AgentTrajectory } from './types.js';

export type { CostBrake, CostBrakeStop, MeasuredCost };

// ----------------------------------------------------------------------------
// Constantes
// ----------------------------------------------------------------------------

/** Versão do proxy de custo (vai na linha `proxy.started` do log). */
export const COST_PROXY_VERSION = 1;
/** Código da recusa por orçamento (`error.type` do corpo 429). */
export const BUDGET_EXHAUSTED_CODE = 'budget_exhausted';
/** Status HTTP da recusa por orçamento (R-14b DEC-5: 429 próprio). */
export const BUDGET_EXHAUSTED_STATUS = 429;
/** Recusa por cancelamento da run (o executor já está sendo morto pelo sinal). */
export const RUN_CANCELLED_CODE = 'run_cancelled';
/** Folga numérica das comparações em USD (soma de floats). */
export const BUDGET_EPSILON_USD = 1e-9;
/** Teto do corpo JSON (não-stream) que o tap acumula para ler o `usage`. */
export const TAP_MAX_JSON_BYTES = 32 * 1024 * 1024;
/** Teto de UMA linha SSE pendente (sem `\n`); acima, descarta e conta ilegível. */
export const TAP_MAX_LINE_BYTES = 4 * 1024 * 1024;
/** Espera máxima pelas trocas em voo de uma execução que acabou (`settled`). */
export const SETTLE_TIMEOUT_MS = 2_000;

/** Rotas de inferência que custam dinheiro (as demais — `GET /models` — passam livres). */
const METERED_METHOD = 'POST';

// ----------------------------------------------------------------------------
// Regras puras
// ----------------------------------------------------------------------------

/**
 * O freio: a chamada CABE? `committedUsd` = medido + em voo + chamadas de custo
 * desconhecido; `projectedUsd` = custo esperado desta chamada. Recusa quando o
 * teto já foi atingido OU quando a chamada o ultrapassaria (antes de ir ao
 * provedor — é a diferença para o "mata depois" do executor).
 */
export function fitsBudget(committedUsd: number, projectedUsd: number, limitUsd: number): boolean {
  if (!(limitUsd >= 0)) return false;
  if (committedUsd >= limitUsd - BUDGET_EPSILON_USD) return false;
  return committedUsd + Math.max(0, projectedUsd) <= limitUsd + BUDGET_EPSILON_USD;
}

/** Estatística de custo MEDIDO de um escopo (execução ou modelo da run). */
export interface CostStats {
  /** Chamadas com custo conhecido (usage/catalog). */
  n: number;
  sumUsd: number;
  lastUsd: number;
}

export function emptyCostStats(): CostStats {
  return { n: 0, sumUsd: 0, lastUsd: 0 };
}

export function addCostSample(stats: CostStats, usd: number): void {
  stats.n += 1;
  stats.sumUsd += usd;
  stats.lastUsd = usd;
}

/**
 * Custo esperado da PRÓXIMA chamada. Ordem: estatística da execução → da run
 * (mesmo modelo) → piso do catálogo para este prompt → 0 (sem como estimar: o
 * estouro fica limitado a 1 chamada). max(última, média) porque o contexto de um
 * agente CRESCE a cada turno — a última chamada prevê melhor que a média.
 */
export function projectCallCost(exec: CostStats | undefined, run: CostStats | undefined, catalogFloorUsd: number): number {
  const pick = (s: CostStats | undefined): number | undefined =>
    s && s.n > 0 ? Math.max(s.lastUsd, s.sumUsd / s.n) : undefined;
  return pick(exec) ?? pick(run) ?? Math.max(0, catalogFloorUsd);
}

/** Tokens de prompt estimados pelo tamanho do corpo (mesma régua de `guessPromptTokens`: chars/4). */
export function promptTokensFromBytes(contentLength: number | undefined): number {
  return contentLength && contentLength > 0 ? Math.ceil(contentLength / 4) : 0;
}

/**
 * `usage` de qualquer formato que o agente use: OpenAI/OpenRouter
 * (`prompt_tokens`/`completion_tokens`/`cost`) e Anthropic/Responses
 * (`input_tokens`/`output_tokens`). `cost` só existe no OpenRouter.
 */
export function usageFromRaw(raw: unknown): UsageInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = extractUsage(raw);
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  if (!u.tokensIn) u.tokensIn = num(r.input_tokens) ?? 0;
  if (!u.tokensOut) u.tokensOut = num(r.output_tokens) ?? 0;
  return u;
}

/** O que o tap leu de UMA resposta. */
export interface TappedResponse {
  format: 'sse' | 'json';
  /** O ÚLTIMO bloco `usage` visto (no SSE do OpenRouter: o chunk antes do `[DONE]`). */
  usage?: UsageInfo;
  /** Id de geração do OpenRouter (`gen-…`) — a ponte com `/generation` e a fatura. */
  generationId?: string;
  /** Modelo que o provedor diz ter servido. */
  model?: string;
  /** Linhas/corpo ilegíveis (não derrubam nada; sem usage ⇒ custo `unknown`). */
  malformed: number;
  /** Por que o tap não leu (corpo comprimido, acima do teto). */
  skipped?: string;
}

export interface UsageTap {
  push(chunk: Buffer): void;
  end(): TappedResponse;
}

function headerValue(h: string | string[] | undefined): string {
  return (Array.isArray(h) ? h[0] : h ?? '').toLowerCase();
}

/**
 * Leitor INCREMENTAL de usage de uma resposta do provedor. Não guarda o stream:
 * no SSE só faz `JSON.parse` das linhas que citam `"usage"` (e da 1ª, para o id
 * de geração) — 1.000 chunks custam 1.000 `includes`, não 1.000 parses. Corpo
 * JSON (requisição sem `stream`) é acumulado até `TAP_MAX_JSON_BYTES`.
 */
export function createUsageTap(headers: IncomingHttpHeaders): UsageTap {
  const ctype = headerValue(headers['content-type']);
  const encoding = headerValue(headers['content-encoding']);
  const format: TappedResponse['format'] = ctype.includes('application/json') ? 'json' : 'sse';
  const out: TappedResponse = { format, malformed: 0 };
  // `accept-encoding: identity` vai ao upstream (inferenceProxy); se mesmo assim
  // vier comprimido, o custo fica `unknown` — honesto, nunca "zero".
  if (encoding && encoding !== 'identity') {
    out.skipped = `content-encoding ${encoding}`;
    return { push: () => undefined, end: () => out };
  }

  const take = (obj: unknown): void => {
    if (!obj || typeof obj !== 'object') return;
    const o = obj as Record<string, unknown>;
    if (!out.generationId && typeof o.id === 'string' && o.id) out.generationId = o.id;
    if (!out.model && typeof o.model === 'string' && o.model) out.model = o.model;
    // Anthropic/Responses aninham o `usage` em `message`/`response`.
    const nested = (o.message ?? o.response) as Record<string, unknown> | undefined;
    const rawUsage = o.usage ?? (nested && typeof nested === 'object' ? nested.usage : undefined);
    const u = usageFromRaw(rawUsage);
    if (u) out.usage = u;
  };

  if (format === 'json') {
    const parts: Buffer[] = [];
    let bytes = 0;
    return {
      push(chunk) {
        if (out.skipped) return;
        bytes += chunk.length;
        if (bytes > TAP_MAX_JSON_BYTES) {
          out.skipped = `corpo JSON acima de ${TAP_MAX_JSON_BYTES} bytes`;
          parts.length = 0;
          return;
        }
        parts.push(chunk);
      },
      end() {
        if (!out.skipped && parts.length > 0) {
          try {
            take(JSON.parse(Buffer.concat(parts).toString('utf8')));
          } catch {
            out.malformed++;
          }
        }
        return out;
      },
    };
  }

  const decoder = new StringDecoder('utf8');
  let pending = '';
  let sawFirst = false;
  const line = (raw: string): void => {
    const l = raw.trim();
    if (!l.startsWith('data:')) return; // comentário SSE (`: OPENROUTER PROCESSING`), event:, id:
    const payload = l.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    const first = !sawFirst;
    sawFirst = true;
    if (!first && !payload.includes('"usage"')) return;
    try {
      take(JSON.parse(payload));
    } catch {
      out.malformed++;
    }
  };
  return {
    push(chunk) {
      pending += decoder.write(chunk);
      let idx: number;
      while ((idx = pending.indexOf('\n')) >= 0) {
        line(pending.slice(0, idx));
        pending = pending.slice(idx + 1);
      }
      if (pending.length > TAP_MAX_LINE_BYTES) {
        pending = '';
        out.malformed++;
      }
    },
    end() {
      pending += decoder.end();
      if (pending) line(pending);
      pending = '';
      return out;
    },
  };
}

/** Anota o custo MEDIDO na trajetória (o do executor fica como auditoria). */
export function applyMeasuredCost(trajectory: AgentTrajectory, measured: MeasuredCost): AgentTrajectory {
  if (measured.calls === 0) return trajectory;
  return {
    ...trajectory,
    usage: {
      ...trajectory.usage,
      costUsd: measured.usd,
      costSource: measured.exact === measured.calls ? 'usage' : 'catalog',
      agentDerivedCostUsd: trajectory.usage.agentDerivedCostUsd ?? trajectory.usage.costUsd,
    },
  };
}

function emptyMeasured(): MeasuredCost {
  return { usd: 0, calls: 0, exact: 0, estimated: 0, unknown: 0, refused: 0, tokensIn: 0, tokensOut: 0, generationIds: [] };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function fmtUsd(n: number): string {
  return `US$ ${n.toFixed(4)}`;
}

// ----------------------------------------------------------------------------
// Limitador GLOBAL das chamadas do agente
// ----------------------------------------------------------------------------

let globalAgentLimiter: AimdLimiter | undefined;

/**
 * O limitador AIMD das chamadas de AGENTE, um por processo (R-14b REC-2 item 4).
 * Mesma política do gateway (cresce sob pressão, recua pela metade no 429 do
 * provedor), instância SEPARADA: as chamadas do agente não passam pelo
 * `chatCompletion`. Teto = `OPENROUTER_MAX_CONCURRENCY` do gateway do processo.
 */
export function agentCallLimiter(): AimdLimiter {
  const max = getGateway().config.maxConcurrency;
  if (!globalAgentLimiter) globalAgentLimiter = new AimdLimiter(max);
  else globalAgentLimiter.setMax(max);
  return globalAgentLimiter;
}

// ----------------------------------------------------------------------------
// O medidor de custo da RUN
// ----------------------------------------------------------------------------

/**
 * O saldo do ledger. O contrato `CostSink` só reserva/anota; o freio por
 * PROJEÇÃO precisa do saldo, que o `BudgetLedger` expõe. Checagem por FORMA,
 * nunca `instanceof` (ESM com instância dupla do módulo daria `false` em silêncio
 * — o mesmo motivo de `isControlSignal`).
 */
interface BudgetView {
  remainingUsd(): number | undefined;
  snapshot(): { budgetUsd?: number; spentUsd: number; committedUsd: number };
}

/**
 * Saldo que o AGENTE ainda pode comprometer: o saldo do ledger (teto − gasto)
 * menos as reservas EM VOO dos outros papéis (um juiz de outra etapa, um
 * gabarito) — é o que a porta dura de `budget.ts` compara (`committedUsd`).
 * Sem isso o agente contaria com dinheiro já prometido a outra chamada. As
 * reservas do próprio agente valem 0 no ledger (ver `beforeForward`), então
 * `committed − spent` aqui é só dos outros papéis.
 */
export function agentHeadroomUsd(view: BudgetView | undefined): number | undefined {
  const remaining = view?.remainingUsd();
  if (remaining === undefined || !view) return undefined;
  const snap = view.snapshot();
  const othersInFlight = Math.max(0, snap.committedUsd - snap.spentUsd);
  return Math.max(0, remaining - othersInFlight);
}

function budgetViewOf(sink: CostSink | undefined): BudgetView | undefined {
  const s = sink as Partial<BudgetView> | undefined;
  return s && typeof s.remainingUsd === 'function' && typeof s.snapshot === 'function' ? (s as BudgetView) : undefined;
}

export interface RunCostMeterOptions {
  /** Ledger da run (`ctx.sink`) — o ponto ÚNICO de `src/budget.ts`. Ausente = só o teto por execução. */
  sink?: CostSink;
  /** Cancelamento da run: chamada nova depois do abort é recusada. */
  signal?: AbortSignal;
  /** Catálogo: preço de fallback (usage sem `cost`) e piso da 1ª projeção. */
  catalog?: OpenRouterModel[];
  /** Limitador das chamadas (default: `agentCallLimiter()`; `null` desliga). */
  limiter?: AimdLimiter | null;
}

export interface OpenExecutionOpts {
  execId: string;
  /** Modelo pedido pela execução (o provedor pode devolver um slug mais específico). */
  modelId: string;
  /** Teto desta execução (`limits.maxCostUsd`). Ausente = só o orçamento da run. */
  maxCostUsd?: number;
}

/** O medidor de UMA execução: é o `CostBrake` entregue ao executor. */
export interface ExecutionCostMeter extends CostBrake {
  readonly execId: string;
  /** Espera as trocas em voo desta execução encerrarem (ou o timeout). */
  settled(timeoutMs?: number): Promise<void>;
  /** O `BudgetExceeded` do ledger quando o escopo da recusa foi a RUN (sinal de controle). */
  budgetSignal(): BudgetExceeded | undefined;
  /** Tira do mapa (chamadas em voo seguem sendo anotadas). Idempotente. */
  close(): void;
}

export interface RunCostTotals extends MeasuredCost {
  /** Trocas encaminhadas ainda em voo. */
  inflight: number;
}

export interface RunCostMeter {
  /** Os ganchos a pendurar no proxy de inferência da run. */
  readonly hooks: InferenceProxyHooks;
  openExecution(opts: OpenExecutionOpts): ExecutionCostMeter;
  totals(): RunCostTotals;
}

class ExecutionMeterImpl implements ExecutionCostMeter {
  readonly execId: string;
  readonly modelId: string;
  readonly maxCostUsd?: number;
  readonly stats = emptyCostStats();
  readonly m = emptyMeasured();
  /** Projeções das chamadas de custo desconhecido (abortadas): o freio as conta. */
  shadowUsd = 0;
  inflightUsd = 0;
  inflight = 0;
  private stop: CostBrakeStop | null = null;
  private signal?: BudgetExceeded;
  private readonly listeners = new Set<(s: CostBrakeStop) => void>();
  private idleWaiters: Array<() => void> = [];

  constructor(
    opts: OpenExecutionOpts,
    private readonly onClose: (m: ExecutionMeterImpl) => void,
  ) {
    this.execId = opts.execId;
    this.modelId = opts.modelId;
    this.maxCostUsd = opts.maxCostUsd;
  }

  committedUsd(): number {
    return this.m.usd + this.shadowUsd + this.inflightUsd;
  }

  stopped(): CostBrakeStop | null {
    return this.stop;
  }

  onStop(cb: (s: CostBrakeStop) => void): () => void {
    if (this.stop) {
      try {
        cb(this.stop);
      } catch {
        /* ouvinte nunca derruba o freio */
      }
      return () => undefined;
    }
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  measured(): MeasuredCost {
    return { ...this.m, usd: round6(this.m.usd), generationIds: [...this.m.generationIds] };
  }

  budgetSignal(): BudgetExceeded | undefined {
    return this.signal;
  }

  /** 1ª recusa por orçamento: pegajosa, avisa os ouvintes (o executor mata o agente). */
  markStopped(stop: CostBrakeStop, signal?: BudgetExceeded): void {
    this.m.refused += 1;
    if (this.stop) return;
    this.stop = stop;
    if (signal) this.signal = signal;
    for (const cb of [...this.listeners]) {
      try {
        cb(stop);
      } catch {
        /* idem */
      }
    }
    this.listeners.clear();
  }

  exchangeStarted(projectedUsd: number): void {
    this.inflight += 1;
    this.inflightUsd += projectedUsd;
  }

  exchangeEnded(projectedUsd: number): void {
    this.inflight = Math.max(0, this.inflight - 1);
    this.inflightUsd = Math.max(0, this.inflightUsd - projectedUsd);
    if (this.inflight === 0) {
      const w = this.idleWaiters;
      this.idleWaiters = [];
      for (const r of w) r();
    }
  }

  settled(timeoutMs: number = SETTLE_TIMEOUT_MS): Promise<void> {
    if (this.inflight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
      this.idleWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close(): void {
    this.onClose(this);
  }
}

/** Estado de UMA troca autorizada pelo gate (chave = id da troca no proxy). */
interface ExchangeState {
  exec?: ExecutionMeterImpl;
  modelId: string;
  projectedUsd: number;
  reservation?: Reservation;
  limiterHeld: boolean;
  limiterWaitMs?: number;
  status?: number;
  tap?: UsageTap;
}

/**
 * Cria o medidor de custo de UMA run. Os `hooks` vão no proxy de inferência da
 * run; cada execução se registra com `openExecution` ANTES de receber o token.
 */
export function createRunCostMeter(opts: RunCostMeterOptions = {}): RunCostMeter {
  const { sink, signal } = opts;
  const view = budgetViewOf(sink);
  const limiter = opts.limiter === null ? undefined : (opts.limiter ?? agentCallLimiter());
  const catalog = new Map<string, OpenRouterModel>((opts.catalog ?? []).map((m) => [m.id, m]));
  const executions = new Map<string, ExecutionMeterImpl>();
  const exchanges = new Map<number, ExchangeState>();
  /** Decisões de recusa por troca (anotadas na linha do log e depois esquecidas). */
  const refusals = new Map<number, Record<string, unknown>>();
  const byModel = new Map<string, CostStats>();
  const totals = emptyMeasured();
  let runInflightUsd = 0;
  let runShadowUsd = 0;
  let inflight = 0;

  const statsFor = (modelId: string): CostStats => {
    let s = byModel.get(modelId);
    if (!s) {
      s = emptyCostStats();
      byModel.set(modelId, s);
    }
    return s;
  };

  const refuse = (
    ex: InferenceExchange,
    exec: ExecutionMeterImpl | undefined,
    stop: CostBrakeStop,
    budgetSignal?: BudgetExceeded,
  ): InferenceGateDecision => {
    exec?.markStopped(stop, budgetSignal);
    totals.refused += 1;
    const metadata = {
      scope: stop.scope,
      committedUsd: round6(stop.committedUsd),
      projectedUsd: round6(stop.projectedUsd),
      limitUsd: round6(stop.limitUsd),
    };
    refusals.set(ex.id, { budget: metadata });
    const escopo = stop.scope === 'execution' ? 'da EXECUÇÃO (maxCostUsd)' : 'da RUN';
    return {
      allow: false,
      status: BUDGET_EXHAUSTED_STATUS,
      code: BUDGET_EXHAUSTED_CODE,
      message:
        `proxy de custo: orçamento ${escopo} esgotado — ${fmtUsd(stop.committedUsd)} comprometidos + ` +
        `${fmtUsd(stop.projectedUsd)} projetados para esta chamada > ${fmtUsd(stop.limitUsd)}. ` +
        'A chamada NÃO foi ao provedor; encerre a tarefa.',
      metadata,
    };
  };

  const beforeForward = async (ex: InferenceExchange): Promise<InferenceGateDecision> => {
    // `GET /models` (público no OpenRouter) não custa nada: passa livre.
    if (ex.method !== METERED_METHOD) return { allow: true };
    if (signal?.aborted) {
      refusals.set(ex.id, { cancelled: true });
      return { allow: false, status: 503, code: RUN_CANCELLED_CODE, message: 'proxy de custo: run cancelada.' };
    }
    const exec = ex.label.execId ? executions.get(ex.label.execId) : undefined;
    const modelId = exec?.modelId ?? 'desconhecido';
    const nowIso = new Date().toISOString();

    // Execução já freada: toda chamada seguinte é recusada (pegajoso).
    const prior = exec?.stopped();
    if (exec && prior) return refuse(ex, exec, prior);

    const promptTokens = promptTokensFromBytes(ex.contentLength);
    // Preço desconhecido/modelo fora do catálogo (IMPL-018: `null`, nunca 0 "grátis")
    // não dá piso: a projeção fica com o que já se mediu (ou 0 na 1ª chamada).
    const floor = computeCost(promptTokens, 0, catalog.get(modelId)) ?? 0;
    const projectedUsd = projectCallCost(exec?.stats, byModel.get(modelId), floor);

    // 1) Teto da EXECUÇÃO — antes de ir ao provedor.
    if (exec && exec.maxCostUsd !== undefined) {
      const committed = exec.committedUsd();
      if (!fitsBudget(committed, projectedUsd, exec.maxCostUsd)) {
        return refuse(ex, exec, { scope: 'execution', committedUsd: committed, projectedUsd, limitUsd: exec.maxCostUsd, at: nowIso });
      }
    }

    // 2) Saldo da RUN (ledger). O saldo já desconta o gasto anotado e as reservas
    //    em voo dos outros papéis; em voo e as chamadas sem custo conhecido
    //    DESTE medidor entram por cima.
    const remaining = agentHeadroomUsd(view);
    if (remaining !== undefined) {
      const committed = runInflightUsd + runShadowUsd;
      if (!fitsBudget(committed, projectedUsd, remaining)) {
        const budget = view?.snapshot().budgetUsd ?? remaining;
        const spent = Math.max(0, budget - (view?.remainingUsd() ?? remaining));
        const sig = new BudgetExceeded(spent, budget, 'agent');
        return refuse(ex, exec, { scope: 'run', committedUsd: committed, projectedUsd, limitUsd: remaining, at: nowIso }, sig);
      }
    }

    // 3) Reserva no ledger (porta dura de `budget.ts`, que também vê as reservas
    //    dos OUTROS papéis). Prompt/maxTokens 0 de propósito: a estimativa por
    //    catálogo de um contexto de agente (cacheado) superestima — a projeção
    //    MEDIDA acima já decidiu; aqui vale "o ledger ainda tem folga?".
    let reservation: Reservation | undefined;
    if (sink) {
      try {
        reservation = sink.reserve('agent', modelId, 0, 0);
      } catch (err) {
        if (isBudgetSignal(err)) {
          const committed = runInflightUsd + runShadowUsd;
          return refuse(ex, exec, { scope: 'run', committedUsd: committed, projectedUsd, limitUsd: remaining ?? 0, at: nowIso }, err);
        }
        if (isControlSignal(err)) {
          refusals.set(ex.id, { cancelled: true });
          return { allow: false, status: 503, code: RUN_CANCELLED_CODE, message: 'proxy de custo: run cancelada.' };
        }
        throw err; // bug do ledger: o proxy responde 500 (fail-closed), nada ao provedor
      }
    }

    // Registra EM VOO antes de qualquer `await`: gates concorrentes enxergam esta
    // chamada (é o que limita o estouro com execuções em paralelo).
    const state: ExchangeState = { exec, modelId, projectedUsd, reservation, limiterHeld: false };
    exchanges.set(ex.id, state);
    exec?.exchangeStarted(projectedUsd);
    runInflightUsd += projectedUsd;
    inflight += 1;

    // 4) Limitador global das chamadas do agente (fila, não recusa: o agente só espera).
    if (limiter) {
      const t0 = performance.now();
      await limiter.acquire();
      state.limiterHeld = true;
      const waited = performance.now() - t0;
      if (waited >= 1) state.limiterWaitMs = Math.round(waited);
    }
    return { allow: true };
  };

  const onResponseStart = (ex: InferenceExchange, status: number, headers: IncomingHttpHeaders): void => {
    const state = exchanges.get(ex.id);
    if (!state) return;
    state.status = status;
    if (status >= 200 && status < 300) state.tap = createUsageTap(headers);
  };

  const onResponseChunk = (ex: InferenceExchange, chunk: Buffer): void => {
    exchanges.get(ex.id)?.tap?.push(chunk);
  };

  const onExchangeEnd = (ex: InferenceExchange, summary: InferenceExchangeSummary): Record<string, unknown> | void => {
    const refused = refusals.get(ex.id);
    if (refused) {
      refusals.delete(ex.id);
      return refused;
    }
    const state = exchanges.get(ex.id);
    if (!state) return undefined; // não-medida (GET /models) ou recusada antes do registro
    exchanges.delete(ex.id);

    if (state.limiterHeld && limiter) {
      limiter.release();
      if (summary.status === 429) limiter.noteRateLimit();
      else if (summary.status >= 200 && summary.status < 300 && !summary.aborted) limiter.noteSuccess();
    }
    state.exec?.exchangeEnded(state.projectedUsd);
    runInflightUsd = Math.max(0, runInflightUsd - state.projectedUsd);
    inflight = Math.max(0, inflight - 1);
    const wait = state.limiterWaitMs ? { limiterWaitMs: state.limiterWaitMs } : {};

    const ok2xx = state.status !== undefined && state.status >= 200 && state.status < 300;
    if (!ok2xx) {
      // Nunca chegou resposta de sucesso (erro do provedor, rede, cliente desistiu
      // antes): o OpenRouter não cobra — a reserva volta ao ledger.
      state.reservation?.release();
      return { cost: { billed: false, projectedUsd: round6(state.projectedUsd) }, ...wait };
    }

    const tapped = state.tap?.end();
    const complete = !summary.aborted && !summary.error;
    const responseModel = tapped?.model;
    const model = (responseModel && catalog.get(responseModel)) || catalog.get(state.modelId);
    let cost: CallCost;
    let tokensIn = 0;
    let tokensOut = 0;
    if (tapped?.usage && (complete || typeof tapped.usage.cost === 'number')) {
      cost = priceUsage(tapped.usage, model);
      tokensIn = tapped.usage.tokensIn;
      tokensOut = tapped.usage.tokensOut;
    } else {
      // Stream cortado/ilegível: o provedor PODE ter cobrado — custo desconhecido
      // (NUNCA "zero"). O freio conta a projeção desta chamada como sombra.
      cost = { usd: 0, source: 'unknown' };
    }
    if (cost.source === 'unknown') {
      runShadowUsd += state.projectedUsd;
      if (state.exec) state.exec.shadowUsd += state.projectedUsd;
    } else {
      addCostSample(statsFor(state.modelId), cost.usd);
      if (state.exec) addCostSample(state.exec.stats, cost.usd);
    }

    // Ponto ÚNICO de contabilidade: o mesmo ledger de todos os papéis.
    if (sink && state.reservation) {
      sink.note(state.reservation, { role: 'agent', modelId: responseModel ?? state.modelId, cost, tokensIn, tokensOut });
    }
    const bump = (m: MeasuredCost): void => {
      m.calls += 1;
      m.usd += cost.usd;
      m.tokensIn += tokensIn;
      m.tokensOut += tokensOut;
      if (cost.source === 'usage') m.exact += 1;
      else if (cost.source === 'catalog') m.estimated += 1;
      else m.unknown += 1;
      if (tapped?.generationId) m.generationIds.push(tapped.generationId);
    };
    bump(totals);
    if (state.exec) bump(state.exec.m);

    return {
      cost: {
        usd: round6(cost.usd),
        source: cost.source satisfies CostSource,
        // BYOK só com `is_byok: true` (o upstream de chamada não-BYOK já está em `usd`).
        ...(cost.byok ? { byok: true } : {}),
        ...(cost.byokUpstreamUsd !== undefined ? { byokUpstreamUsd: cost.byokUpstreamUsd } : {}),
        model: responseModel ?? state.modelId,
        ...(tapped?.generationId ? { generationId: tapped.generationId } : {}),
        tokensIn,
        tokensOut,
        projectedUsd: round6(state.projectedUsd),
        ...(tapped?.skipped ? { tapSkipped: tapped.skipped } : {}),
        ...(tapped?.malformed ? { tapMalformed: tapped.malformed } : {}),
        ...(complete ? {} : { incomplete: true }),
      },
      ...wait,
    };
  };

  return {
    hooks: { beforeForward, onResponseStart, onResponseChunk, onExchangeEnd },
    openExecution(o: OpenExecutionOpts): ExecutionCostMeter {
      const meter = new ExecutionMeterImpl(o, (m) => {
        if (executions.get(m.execId) === m) executions.delete(m.execId);
      });
      executions.set(o.execId, meter);
      return meter;
    },
    totals(): RunCostTotals {
      return { ...totals, usd: round6(totals.usd), generationIds: [...totals.generationIds], inflight };
    },
  };
}

// ----------------------------------------------------------------------------
// UM medidor por run (contagem de referências — par do proxy da run)
// ----------------------------------------------------------------------------

interface MeterEntry {
  meter: RunCostMeter;
  refs: number;
}
const meterRegistry = new Map<string, MeterEntry>();

export interface RunCostMeterLease {
  meter: RunCostMeter;
  release(): void;
}

/**
 * O medidor da RUN (`runId`): as etapas paralelas compartilham o mesmo (um
 * saldo, uma estatística por modelo), como compartilham o proxy. As opções do
 * 1º empréstimo valem (a mesma run tem o mesmo ledger).
 */
export function acquireRunCostMeter(runId: string, opts: RunCostMeterOptions): RunCostMeterLease {
  let entry = meterRegistry.get(runId);
  if (!entry) {
    entry = { meter: createRunCostMeter(opts), refs: 0 };
    meterRegistry.set(runId, entry);
  }
  entry.refs++;
  const current = entry;
  let released = false;
  return {
    meter: current.meter,
    release(): void {
      if (released) return;
      released = true;
      current.refs--;
      if (current.refs <= 0 && meterRegistry.get(runId) === current) meterRegistry.delete(runId);
    },
  };
}

/** Quantos medidores de run estão abertos (teste/diagnóstico). */
export function openRunCostMeters(): number {
  return meterRegistry.size;
}

// ----------------------------------------------------------------------------
// Auditoria: o log do proxy × a fatura (`agents reconcile`)
// ----------------------------------------------------------------------------

export interface ProxyCostLogSummary extends MeasuredCost {
  /** Por execução (`label.execId`). */
  byExec: Record<string, MeasuredCost>;
  /** Custo medido por id de geração — o que se compara, id a id, com `/generation`. */
  costByGenerationId: Record<string, number>;
  /** Linhas ilegíveis do log. */
  badLines: number;
}

/**
 * Soma o custo MEDIDO a partir do log JSONL do proxy
 * (`<dataDir>/agent-runs/<runId>/inference-proxy.jsonl`): uma linha `exchange`
 * por chamada, com `cost.{usd,source,generationId}` — a trilha que se confere
 * contra a fatura do OpenRouter. Pura.
 */
export function summarizeProxyCostLog(text: string): ProxyCostLogSummary {
  const total: ProxyCostLogSummary = { ...emptyMeasured(), byExec: {}, costByGenerationId: {}, badLines: 0 };
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      total.badLines++;
      continue;
    }
    if (e.event !== 'exchange') continue;
    const label = (e.label ?? {}) as { execId?: string };
    const execId = typeof label.execId === 'string' ? label.execId : '(sem execução)';
    const slot = (total.byExec[execId] ??= emptyMeasured());
    if (e.rejected === BUDGET_EXHAUSTED_CODE) {
      total.refused++;
      slot.refused++;
      continue;
    }
    const c = e.cost as Record<string, unknown> | undefined;
    if (!c || typeof c.source !== 'string') continue;
    for (const m of [total as MeasuredCost, slot]) {
      m.calls++;
      m.usd += typeof c.usd === 'number' ? c.usd : 0;
      m.tokensIn += typeof c.tokensIn === 'number' ? c.tokensIn : 0;
      m.tokensOut += typeof c.tokensOut === 'number' ? c.tokensOut : 0;
      if (c.source === 'usage') m.exact++;
      else if (c.source === 'catalog') m.estimated++;
      else m.unknown++;
      if (typeof c.generationId === 'string') m.generationIds.push(c.generationId);
    }
    if (typeof c.generationId === 'string' && typeof c.usd === 'number') {
      total.costByGenerationId[c.generationId] = (total.costByGenerationId[c.generationId] ?? 0) + c.usd;
    }
  }
  total.usd = round6(total.usd);
  for (const m of Object.values(total.byExec)) m.usd = round6(m.usd);
  return total;
}

/** Tolerância da fidelidade medido × fatura por run (R-14b REC-2: ≤ 2%). */
export const COST_FIDELITY_TOLERANCE = 0.02;

export interface CostFidelity {
  measuredUsd: number;
  billedUsd: number;
  diffUsd: number;
  /** |medido − cobrado| / cobrado (0 quando ambos são 0). */
  relative: number;
  withinTolerance: boolean;
}

export function costFidelity(measuredUsd: number, billedUsd: number, tolerance = COST_FIDELITY_TOLERANCE): CostFidelity {
  const diffUsd = round6(Math.abs(measuredUsd - billedUsd));
  const relative = billedUsd > 0 ? diffUsd / billedUsd : diffUsd === 0 ? 0 : Number.POSITIVE_INFINITY;
  return { measuredUsd: round6(measuredUsd), billedUsd: round6(billedUsd), diffUsd, relative, withinTolerance: relative <= tolerance };
}

export interface GenerationCost {
  id: string;
  status: 'ok' | 'not_found' | 'error';
  /** `data.total_cost` do OpenRouter — o valor da fatura desta geração. */
  totalCostUsd?: number;
  error?: string;
}

export interface FetchGenerationOpts {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Tentativas nos 404/429/5xx transitórios (R-07a DEC-4). Default 4. */
  attempts?: number;
}

/**
 * `GET /generation?id=` — leitura de AUDITORIA (não é chamada de LLM, não custa):
 * o `total_cost` que o OpenRouter lançou para a geração. 404 logo após a
 * chamada é transitório (R-07a DEC-4) — retry com backoff.
 */
export async function fetchGenerationCost(id: string, opts: FetchGenerationOpts): Promise<GenerationCost> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, opts.attempts ?? 4);
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/generation?id=${encodeURIComponent(id)}`;
  let last: GenerationCost = { id, status: 'error', error: 'sem tentativa' };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(500 * 2 ** (i - 1));
    try {
      const res = await doFetch(url, { headers: { authorization: `Bearer ${opts.apiKey}` } });
      if (res.ok) {
        const json = (await res.json()) as { data?: { total_cost?: unknown } };
        const total = json?.data?.total_cost;
        if (typeof total === 'number' && Number.isFinite(total)) return { id, status: 'ok', totalCostUsd: total };
        return { id, status: 'error', error: 'resposta sem data.total_cost' };
      }
      last = res.status === 404 ? { id, status: 'not_found', error: 'HTTP 404' } : { id, status: 'error', error: `HTTP ${res.status}` };
      if (res.status !== 404 && res.status !== 429 && res.status < 500) return last;
    } catch (err) {
      last = { id, status: 'error', error: (err as Error).message };
    }
  }
  return last;
}

/** Medido (log do proxy) × cobrado (`/generation`) de UMA run. */
export interface GenerationReconciliation {
  /** Σ `total_cost` das gerações encontradas (a fatura). */
  billedUsd: number;
  /** Σ custo MEDIDO das MESMAS gerações (comparação id a id). */
  matchedMeasuredUsd: number;
  found: number;
  notFound: number;
  errors: number;
  /** Todas as gerações do log foram encontradas (nenhum 404/erro). */
  complete: boolean;
  fidelity: CostFidelity;
  /** Gerações sem lançamento conferível (id + motivo), para investigar. */
  missing: Array<{ id: string; status: 'not_found' | 'error'; error?: string }>;
}

/**
 * Confere o custo MEDIDO de cada geração do log do proxy contra o `total_cost`
 * que o OpenRouter lançou (`GET /generation`, leitura de auditoria que não
 * gasta). A fidelidade compara só gerações ENCONTRADAS (id a id), para um 404
 * transitório não virar "divergência"; `complete` diz se faltou alguma.
 * Concorrência pequena: o endpoint tem rate limit próprio (R-07a DEC-4).
 */
export async function reconcileGenerations(
  summary: Pick<ProxyCostLogSummary, 'generationIds' | 'costByGenerationId'>,
  opts: FetchGenerationOpts & { concurrency?: number; tolerance?: number },
): Promise<GenerationReconciliation> {
  const ids = [...new Set(summary.generationIds)];
  const results: GenerationCost[] = new Array(ids.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const i = next++;
      results[i] = await fetchGenerationCost(ids[i], opts);
    }
  };
  const width = Math.max(1, Math.min(opts.concurrency ?? 4, ids.length));
  await Promise.all(Array.from({ length: width }, worker));

  let billedUsd = 0;
  let matchedMeasuredUsd = 0;
  let found = 0;
  const missing: GenerationReconciliation['missing'] = [];
  for (const g of results) {
    if (g.status === 'ok' && g.totalCostUsd !== undefined) {
      found += 1;
      billedUsd += g.totalCostUsd;
      matchedMeasuredUsd += summary.costByGenerationId[g.id] ?? 0;
    } else {
      missing.push({ id: g.id, status: g.status === 'not_found' ? 'not_found' : 'error', ...(g.error ? { error: g.error } : {}) });
    }
  }
  const notFound = missing.filter((m) => m.status === 'not_found').length;
  return {
    billedUsd: round6(billedUsd),
    matchedMeasuredUsd: round6(matchedMeasuredUsd),
    found,
    notFound,
    errors: missing.length - notFound,
    complete: missing.length === 0 && ids.length > 0,
    fidelity: costFidelity(matchedMeasuredUsd, billedUsd, opts.tolerance),
    missing,
  };
}
