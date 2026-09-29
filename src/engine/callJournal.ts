// IMPL-081 (R-10:REC-2) — journal de chamadas PAGAS: retomada sem pagar de novo.
//
// O problema: `saveRun` guarda só o snapshot (throttled) do record. Depois de
// um crash/kill do processo (ou de a aba ser recarregada no meio da run), a
// única saída era rodar tudo de novo — e toda chamada já paga era paga outra
// vez. O padrão dos motores duráveis (Temporal/Step Functions/Restate) é
// "journal de resultados persistidos antes de avançar; recuperação = REPLAY do
// journal, não re-execução".
//
// Este módulo é o NÚCLEO PURO (sem Node, sem rede — roda no navegador também):
//
//   • CHAVE = `contentHash` do pedido CANÔNICO: papel + modelo + mensagens +
//     temperatura + max_tokens efetivo + esforço + formato/schema da saída +
//     teto de preço + quebra de cache de prompt + modo auditável. Credenciais
//     NUNCA entram. Os códigos sorteados da blindagem do juiz (marcador e
//     canário por veredito — judgeGuard) saem da chave e o texto replayado é
//     RE-AMARRADO aos códigos da chamada atual (a mesma técnica do cache de
//     vereditos, IMPL-080): sem isso nenhum juiz/duelo/gabarito seria
//     replayável e, pior, o replay traria o canário antigo (saída inválida).
//   • OCORRÊNCIA: pedidos IDÊNTICOS são legítimos (repeats do compare, retry
//     do mesmo pedido) — cada um tem a sua resposta. A n-ésima ocorrência de
//     uma chave na retomada recebe a n-ésima resposta gravada, uma vez só
//     (fila por chave). O que foi gravado NESTA tentativa nunca é replayado
//     nela mesma: é outra amostra, não um cache.
//   • Replay NÃO paga nada e NÃO é gasto desta tentativa: o gateway devolve
//     `cost.usd = 0` (+ `replayed: true`) e o ledger registra `replayedCalls`/
//     `replayedUsd` à parte (nunca em `usd`/`spentUsd`) — o dinheiro foi
//     pago UMA vez, na tentativa que gravou a entrada.
//   • Só entra no journal a chamada que DEVOLVEU resposta (o gateway grava
//     depois de a resposta chegar). Falha/abort não tem resposta para replay.
//   • ATOMICIDADE do grupo competidores+julgamento: a retomada re-executa o
//     pipeline INTEIRO (toda etapa é reconstruída do zero, nunca "meia etapa"
//     carregada do disco); só as chamadas é que vêm do journal. Como a chave é
//     o conteúdo, a dependência se resolve sozinha: resposta de competidor
//     replayada => o pedido do juiz é idêntico => juiz replayado; competidor
//     que não chegou ao journal é pago de novo => o texto muda => o juiz dele
//     também é chamado de novo. Nunca "resposta de uma tentativa com nota de
//     outra".
//
// Persistência = porta injetada (`JournalStore`): no Node é o arquivo
// append-only com fsync por entrada (`src/storage.ts`); no navegador, o
// IndexedDB com durability 'strict' (`web/src/engine/callJournal.ts`). Falha
// ao gravar NUNCA derruba a chamada (ela já foi paga e o resultado é bom): a
// retomada só paga de novo o que não foi gravado.

import type { CallCost, CallFinishSignals, CallProviderInfo, CostRole, RunStatus } from '../types.js';
import { contentHash } from './hash.js';
import { guardTokensOf, normalizeGuardTokens, rebindGuardTokens, type GuardTokens } from './verdictCache.js';

/** Formato da entrada gravada (muda = entradas antigas deixam de ser replayáveis). */
export const CALL_JOURNAL_FORMAT = 'call-journal@1';

/** O que define a IDENTIDADE de uma chamada de chat (tudo que muda a resposta). */
export interface JournalRequest {
  role: CostRole;
  modelId: string;
  messages: ReadonlyArray<{ role: string; content: string }>;
  /** Temperatura EFETIVA (o gateway usa 0 quando ausente). */
  temperature: number;
  /** `max_tokens` EFETIVO (o mesmo que vai no corpo). */
  maxTokens: number;
  reasoningLevel?: string | null;
  responseFormatJson?: boolean | null;
  responseSchema?: { name: string; schema: unknown } | null;
  maxPricePerMTok?: { prompt?: number; completion?: number } | null;
  cacheControlAfter?: number | null;
  /** Modo auditável RESOLVIDO (muda o roteamento de provedor). */
  auditable?: boolean;
}

/** Texto do prompt como a chave o vê (papel + conteúdo, separados por NUL). */
export function journalPromptText(messages: JournalRequest['messages']): string {
  return messages.map((m) => `${m.role}\u0000${m.content}`).join('\u0000');
}

/**
 * Chave da chamada + os códigos da blindagem do juiz presentes no prompt
 * (para re-amarrar o texto replayado). Puro e determinístico nos dois motores.
 */
export function journalRequestKey(req: JournalRequest): { key: string; guard: GuardTokens } {
  const prompt = journalPromptText(req.messages);
  const key = contentHash({
    f: CALL_JOURNAL_FORMAT,
    role: req.role,
    modelId: req.modelId,
    temperature: req.temperature,
    maxTokens: req.maxTokens,
    effort: req.reasoningLevel ?? null,
    json: req.responseFormatJson ?? null,
    schema: req.responseSchema ?? null,
    maxPrice: req.maxPricePerMTok ?? null,
    cacheControlAfter: req.cacheControlAfter ?? null,
    auditable: req.auditable === true,
    // Só o HASH do prompt entra na chave; o prompt em si não é gravado (pode
    // ter dado pessoal — a resposta já vive no record, o pedido não precisa).
    prompt: contentHash(normalizeGuardTokens(prompt)),
  });
  return { key, guard: guardTokensOf(prompt) };
}

/**
 * O que o journal guarda de uma resposta — o suficiente para o papel não
 * distinguir o replay da chamada original (texto REIDRATADO, tokens, sinais
 * de fim, provedor). O payload cru do fio (`raw`) não entra.
 */
export interface JournaledResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  /** Custo MEDIDO na tentativa que gravou (informativo no replay — já foi pago). */
  cost: CallCost;
  cachedTokensIn?: number;
  reasoningTokens?: number;
  finishReason?: string;
  nativeFinishReason?: string;
  refusal?: string;
  /** `GatewayBlock` (o núcleo não conhece o tipo do gateway). */
  blocked?: unknown;
  truncated?: boolean;
  truncationSignals?: unknown[];
  provider?: CallProviderInfo;
  auditable?: boolean;
  /** Sinais de fim da chamada (IMPL-014) — o replay os conta no ledger. */
  finishSignals?: CallFinishSignals;
}

/** Uma entrada do journal (1 por chamada CONCLUÍDA). */
export interface JournalEntry {
  format: typeof CALL_JOURNAL_FORMAT;
  /** `journalRequestKey(...).key`. */
  key: string;
  /** Ocorrência desta chave (0 = 1ª) — pedidos idênticos têm respostas próprias. */
  seq: number;
  role: CostRole;
  modelId: string;
  /** ISO do momento em que a resposta chegou. */
  at: string;
  /** Códigos da blindagem do juiz na chamada que GEROU a resposta. */
  guard?: GuardTokens;
  result: JournaledResult;
}

/** Id estável de armazenamento de uma entrada (chave + ocorrência). */
export function journalEntryId(e: Pick<JournalEntry, 'key' | 'seq'>): string {
  return `${e.key}#${e.seq}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Valida uma entrada lida do armazenamento. Qualquer coisa fora do formato
 * (versão antiga, linha adulterada/rasgada) é DESCARTADA: a chamada é paga de
 * novo, nunca replayada com conteúdo duvidoso.
 */
export function parseJournalEntry(raw: unknown): JournalEntry | undefined {
  if (!isObj(raw) || raw.format !== CALL_JOURNAL_FORMAT) return undefined;
  const { key, seq, role, modelId, at, result } = raw;
  if (typeof key !== 'string' || !key.startsWith('sha256:')) return undefined;
  if (!isNum(seq) || seq < 0 || !Number.isInteger(seq)) return undefined;
  if (typeof role !== 'string' || typeof modelId !== 'string' || typeof at !== 'string') return undefined;
  if (!isObj(result) || typeof result.text !== 'string') return undefined;
  if (!isNum(result.tokensIn) || !isNum(result.tokensOut) || !isNum(result.latencyMs)) return undefined;
  if (!isObj(result.cost) || !isNum(result.cost.usd) || typeof result.cost.source !== 'string') return undefined;
  const guard = isObj(raw.guard) ? (raw.guard as GuardTokens) : undefined;
  return {
    format: CALL_JOURNAL_FORMAT,
    key,
    seq,
    role: role as CostRole,
    modelId,
    at,
    ...(guard ? { guard } : {}),
    result: result as unknown as JournaledResult,
  };
}

/**
 * Porta de persistência: grava UMA entrada de forma durável. Lançar/`false` =
 * não gravou (o núcleo avisa uma vez); `'unavailable'` = armazenamento
 * ausente por natureza (ex.: navegador sem IndexedDB) — não gravou, sem aviso.
 */
export interface JournalStore {
  append(entry: JournalEntry): Promise<unknown>;
}

/** Valor de `JournalStore.append` para "armazenamento ausente" (não grava, não avisa). */
export const JOURNAL_STORE_UNAVAILABLE = 'unavailable';

/** Bilhete de uma chamada que vai ao provedor de verdade (grava a resposta depois). */
export interface JournalTicket {
  readonly key: string;
  readonly role: CostRole;
  readonly modelId: string;
  readonly guard: GuardTokens;
}

export type JournalTake =
  | {
      kind: 'replay';
      entry: JournalEntry;
      /** Resposta gravada com o texto re-amarrado aos códigos da chamada ATUAL. */
      result: JournaledResult;
    }
  | { kind: 'live'; ticket: JournalTicket };

export interface CallJournalStats {
  /** Entradas válidas disponíveis para replay no início desta tentativa. */
  loadedCalls: number;
  /** Chamadas desta tentativa servidas do journal (US$ 0 agora). */
  replayedCalls: number;
  /** Custo ORIGINAL (medido, `source: 'usage'`) das chamadas replayadas. */
  replayedUsd: number;
  /** Respostas gravadas nesta tentativa. */
  recordedCalls: number;
  /** Gravações que falharam (essas chamadas seriam pagas de novo numa retomada). */
  appendFailures: number;
}

export interface CallJournalOptions {
  /** Onde gravar. Ausente = só replay (nada novo é persistido). */
  store?: JournalStore;
  /** Entradas das tentativas anteriores (retomada). Ausente = run nova. */
  entries?: readonly JournalEntry[];
  /** Relógio (testes). */
  now?: () => string;
  /** Falha de gravação (chamado uma vez por tentativa — a run segue). */
  onError?: (err: unknown) => void;
}

/** Cópia JSON-segura do resultado (sem `raw`, sem referências vivas). */
function journaledResultOf(r: JournaledResult): JournaledResult {
  const pick: JournaledResult = {
    text: r.text,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    latencyMs: r.latencyMs,
    cost: r.cost,
    ...(isNum(r.cachedTokensIn) ? { cachedTokensIn: r.cachedTokensIn } : {}),
    ...(isNum(r.reasoningTokens) ? { reasoningTokens: r.reasoningTokens } : {}),
    ...(r.finishReason ? { finishReason: r.finishReason } : {}),
    ...(r.nativeFinishReason ? { nativeFinishReason: r.nativeFinishReason } : {}),
    ...(r.refusal ? { refusal: r.refusal } : {}),
    ...(r.blocked ? { blocked: r.blocked } : {}),
    ...(typeof r.truncated === 'boolean' ? { truncated: r.truncated } : {}),
    ...(r.truncationSignals?.length ? { truncationSignals: r.truncationSignals } : {}),
    ...(r.provider ? { provider: r.provider } : {}),
    ...(r.auditable ? { auditable: true } : {}),
    ...(r.finishSignals ? { finishSignals: r.finishSignals } : {}),
  };
  return JSON.parse(JSON.stringify(pick)) as JournaledResult;
}

/**
 * O journal de UMA tentativa de uma run: consulta (replay) ANTES de cada
 * chamada e grava DEPOIS de cada resposta. Síncrono na consulta — a ocorrência
 * é atribuída no mesmo tick, então pedidos idênticos concorrentes (o
 * `Promise.all` das etapas) nunca pegam a mesma resposta gravada.
 */
export class CallJournal {
  private readonly store?: JournalStore;
  private readonly now: () => string;
  private readonly onError?: (err: unknown) => void;
  /** Respostas das tentativas anteriores ainda NÃO consumidas, por chave (ordem de ocorrência). */
  private readonly pending = new Map<string, JournalEntry[]>();
  /** Próxima ocorrência livre por chave (não colide com as já gravadas). */
  private readonly nextSeq = new Map<string, number>();
  private readonly counters: CallJournalStats = {
    loadedCalls: 0,
    replayedCalls: 0,
    replayedUsd: 0,
    recordedCalls: 0,
    appendFailures: 0,
  };
  private errorReported = false;
  /** Custo medido das respostas carregadas, por papel (ver `loadedUsdByRole`). */
  private readonly loadedPaid: Partial<Record<CostRole, number>> = {};
  /** Ids (`journalEntryId`) carregados + gravados — a limpeza apaga só estes. */
  private readonly ids = new Set<string>();

  constructor(opts: CallJournalOptions = {}) {
    this.store = opts.store;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.onError = opts.onError;
    const vistas = new Set<string>();
    const ordenadas = [...(opts.entries ?? [])].sort((a, b) => a.seq - b.seq);
    for (const e of ordenadas) {
      const id = journalEntryId(e);
      if (vistas.has(id)) continue; // mesma ocorrência gravada 2x: vale a 1ª
      vistas.add(id);
      this.ids.add(id);
      const fila = this.pending.get(e.key) ?? [];
      fila.push(e);
      this.pending.set(e.key, fila);
      this.nextSeq.set(e.key, Math.max(this.nextSeq.get(e.key) ?? 0, e.seq + 1));
      this.counters.loadedCalls += 1;
      const c = e.result.cost;
      if (c.source === 'usage' && isNum(c.usd) && c.usd > 0) {
        this.loadedPaid[e.role] = (this.loadedPaid[e.role] ?? 0) + c.usd;
      }
    }
  }

  /**
   * Consulta ANTES da chamada: a resposta gravada desta ocorrência (replay) ou
   * um bilhete para gravar a resposta nova. Nunca devolve resposta de OUTRO
   * pedido: a fila é da chave (hash do pedido canônico) e o papel/modelo da
   * entrada são conferidos de novo.
   */
  take(req: JournalRequest): JournalTake {
    const { key, guard } = journalRequestKey(req);
    const fila = this.pending.get(key);
    while (fila && fila.length > 0) {
      const entry = fila.shift()!;
      if (entry.role !== req.role || entry.modelId !== req.modelId) continue; // defensivo
      this.counters.replayedCalls += 1;
      if (entry.result.cost.source === 'usage' && isNum(entry.result.cost.usd)) {
        this.counters.replayedUsd += entry.result.cost.usd;
      }
      const result: JournaledResult = {
        ...entry.result,
        text: rebindGuardTokens(entry.result.text, entry.guard, guard),
      };
      return { kind: 'replay', entry, result };
    }
    return { kind: 'live', ticket: { key, role: req.role, modelId: req.modelId, guard } };
  }

  /**
   * Grava a resposta de uma chamada que foi ao provedor. NUNCA lança: falhar
   * aqui só significa que a retomada pagará esta chamada de novo.
   */
  async record(ticket: JournalTicket, result: JournaledResult): Promise<void> {
    if (!this.store) return;
    const seq = this.nextSeq.get(ticket.key) ?? 0;
    this.nextSeq.set(ticket.key, seq + 1);
    let entry: JournalEntry;
    try {
      entry = {
        format: CALL_JOURNAL_FORMAT,
        key: ticket.key,
        seq,
        role: ticket.role,
        modelId: ticket.modelId,
        at: this.now(),
        ...(ticket.guard.nonce || ticket.guard.canary ? { guard: { ...ticket.guard } } : {}),
        result: journaledResultOf(result),
      };
    } catch (err) {
      this.fail(err);
      return;
    }
    try {
      const ok = await this.store.append(entry);
      if (ok === JOURNAL_STORE_UNAVAILABLE) {
        this.counters.appendFailures += 1;
        return;
      }
      if (ok === false) {
        this.fail(new Error('o armazenamento recusou a entrada do journal'));
        return;
      }
      this.counters.recordedCalls += 1;
      this.ids.add(journalEntryId(entry));
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Ids de TODAS as entradas conhecidas desta run (carregadas das tentativas
   * anteriores + gravadas nesta). A retomada carrega o journal inteiro, então
   * no fim da run isto cobre o journal todo — a limpeza apaga por id, sem
   * varrer o armazenamento.
   */
  entryIds(): string[] {
    return [...this.ids];
  }

  private fail(err: unknown): void {
    this.counters.appendFailures += 1;
    if (this.errorReported) return;
    this.errorReported = true;
    try {
      this.onError?.(err);
    } catch {
      /* aviso é best-effort */
    }
  }

  stats(): CallJournalStats {
    return { ...this.counters };
  }

  /**
   * Custo MEDIDO (`source: 'usage'`) das respostas carregadas, por papel — o
   * que a retomada NÃO vai pagar de novo. As portas suaves descontam isto da
   * projeção (ver {@link discountByRole}).
   */
  loadedUsdByRole(): Partial<Record<CostRole, number>> {
    return { ...this.loadedPaid };
  }
}

/**
 * Projeção por papel MENOS o que o journal já cobre (nunca abaixo de 0). Sem
 * isto a porta suave de uma retomada projetaria de novo o custo das chamadas
 * que vão voltar a US$ 0 — e, com o teto que SOBROU, recusaria o grupo
 * competidores+julgamento que na verdade cabe. O desconto usa o custo MEDIDO
 * original (≤ a estimativa de pior caso, na prática): erra para o lado
 * conservador; a porta dura do ledger segue valendo por baixo.
 */
export function discountByRole<T extends Record<string, number>>(byRole: T, paid: Partial<Record<string, number>>): T {
  const out = { ...byRole };
  for (const [role, usd] of Object.entries(paid)) {
    if (!isNum(usd) || usd <= 0 || !isNum(out[role])) continue;
    (out as Record<string, number>)[role] = Math.max(0, out[role] - usd);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Política de retomada (fonte única dos dois motores, do CLI e da SPA)
// ---------------------------------------------------------------------------

/** Recorte do RunRecord que a política lê (Node e web). */
export interface ResumableRunLike {
  id: string;
  status: RunStatus | string;
  stoppedReason?: string;
  sessionId?: string;
  totalCostUsd?: number;
  costLedger?: { pendingUsd?: number };
  budgetUsd?: number;
  config: { mode?: string; budgetUsd?: number; agent?: unknown };
  resume?: RunResumeInfoLike;
}

/** O que a retomada carimba no record (espelha `RunResumeInfo` de types.ts). */
export interface RunResumeInfoLike {
  attempt: number;
  resumedAt: string;
  priorSpentUsd: number;
  priorPendingUsd: number;
  journalCalls: number;
  replayedCalls: number;
  replayedUsd: number;
  previousStatus: string;
  previousStoppedReason?: string;
}

/**
 * Esta run grava journal? Só a run AVULSA de chat: a rodada de treino tem
 * id novo a cada iteração e a sessão não é retomável; o modo agente roda
 * processos com efeito no sandbox (repetir as chamadas de LLM de um agente
 * sem repetir o agente não reproduz a execução).
 */
export function journalEnabledFor(rec: Pick<ResumableRunLike, 'sessionId' | 'config'>): boolean {
  return !rec.sessionId && !rec.config.agent;
}

/**
 * Por que a run NÃO pode ser retomada (`null` = pode). Retomável = parou sem
 * terminar: órfã (processo/aba morreu), cancelada, cortada por orçamento ou
 * com erro (ex.: 402 sem crédito, rede). Concluída/inconclusiva já tem o
 * resultado; 'running' ainda tem dono (a varredura de órfãs decide antes).
 */
export function resumeRefusal(rec: ResumableRunLike): string | null {
  if (rec.sessionId) {
    return 'é uma rodada de uma sessão de treino — sessões não são retomáveis (rode o treino de novo).';
  }
  if (rec.config.agent) {
    return 'o modo agente não é retomável (as execuções de agente têm efeito no sandbox e seriam repetidas).';
  }
  if (rec.config.mode === 'training') return 'treinos não são retomáveis.';
  if (rec.status === 'running') return 'a run ainda está em execução (ou o dono dela não foi dado como órfão ainda).';
  if (rec.status === 'finished' || rec.status === 'inconclusive') {
    return `a run já terminou (${rec.status}) — não há o que retomar.`;
  }
  if (rec.status !== 'aborted' && rec.status !== 'error') return `status "${rec.status}" não é retomável.`;
  return null;
}

/** Gasto GRAVADO das tentativas anteriores (limite inferior: o último snapshot de cada uma). */
export function priorSpentUsdOf(rec: ResumableRunLike): number {
  const agora = isNum(rec.totalCostUsd) ? rec.totalCostUsd : 0;
  return agora + (rec.resume && isNum(rec.resume.priorSpentUsd) ? rec.resume.priorSpentUsd : 0);
}

/** Pendente (sem custo medido) das tentativas anteriores — pode ter sido cobrado. */
export function priorPendingUsdOf(rec: ResumableRunLike): number {
  const agora = isNum(rec.costLedger?.pendingUsd) ? rec.costLedger!.pendingUsd! : 0;
  return agora + (rec.resume && isNum(rec.resume.priorPendingUsd) ? rec.resume.priorPendingUsd : 0);
}

/**
 * Teto da CONTINUAÇÃO: o teto original menos o que as tentativas anteriores
 * gastaram (e o pendente, que pode ter sido cobrado). Sem isto a retomada
 * ganharia o teto INTEIRO de novo — o total da run passaria do teto
 * configurado. `override` (ex.: `--budget` do `runs resume`) é o teto só da
 * continuação. `undefined` = sem teto (a run original não tinha).
 */
export function resumeBudgetUsd(rec: ResumableRunLike, override?: number): number | undefined {
  if (isNum(override) && override >= 0) return override;
  const teto = rec.config.budgetUsd;
  if (!isNum(teto)) return undefined;
  return Math.max(0, teto - priorSpentUsdOf(rec) - priorPendingUsdOf(rec));
}

/** Carimbo inicial da retomada (os contadores de replay são atualizados no fim). */
export function resumeInfoFor(
  prev: ResumableRunLike,
  journalCalls: number,
  now: string = new Date().toISOString(),
): RunResumeInfoLike {
  return {
    attempt: (prev.resume && isNum(prev.resume.attempt) ? prev.resume.attempt : 1) + 1,
    resumedAt: now,
    priorSpentUsd: priorSpentUsdOf(prev),
    priorPendingUsd: priorPendingUsdOf(prev),
    journalCalls,
    replayedCalls: 0,
    replayedUsd: 0,
    previousStatus: String(prev.status),
    ...(prev.stoppedReason ? { previousStoppedReason: prev.stoppedReason } : {}),
  };
}
