// Ledger de gasto EM ARQUIVO, somando processos, com teto diário por máquina
// (IMPL-031, R-12:REC-6/DEC-5).
//
// O furo: o `BudgetLedger` (src/budget.ts) vive na memória de UM processo. Dois
// processos com a mesma key — um agente que re-dispara o comando, dois
// terminais, um laço de retentativa — gastam N× o teto sem que nenhum dos dois
// veja o outro. Aqui cada reserva/liquidação passa por um arquivo do DIA (UTC)
// em `<data-dir>/ledger/spend-AAAA-MM-DD.json`, sob mutex entre processos e
// escrita atômica (temp+rename), e o teto diário compara o comprometido de
// TODOS os processos (gasto medido + reservas em voo).
//
// Integração sem tocar o motor: `MachineBudgetLedger` é um `BudgetLedger` cujo
// `fork()` devolve filhos da mesma classe. O CLI passa a raiz como
// `parentLedger` (orquestrador e treino já aceitam), então TODA reserva do
// pipeline — inclusive as das iterações do treino — passa pela porta daqui.
//
// O que esta camada NÃO cobre (R-12): duas máquinas com a mesma key (só o
// limite da key no OpenRouter cobre — o `doctor` recomenda) e `--data-dir`
// diferentes na mesma máquina (cada diretório de dados tem o próprio ledger).

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BudgetExceeded, BudgetLedger, type BudgetLedgerOptions } from '../budget.js';
import type { CostRole, Reservation } from '../types.js';
import { CliError, EXIT } from './output.js';
import { hostName, pidAlive, readJsonSync, withMutexSync, writeAtomicSync } from './fileGuard.js';

// --- teto diário ---------------------------------------------------------------

/**
 * Teto diário default: um agente desgovernado SEM configuração nenhuma é
 * justamente o caso que a camada existe para pegar — opt-in não protegeria
 * ninguém. Generoso para uso humano; ajuste com `limits set --daily`.
 */
export const DEFAULT_DAILY_CAP_USD = 20;
export const DAILY_CAP_ENV = 'PROMPT_BUILDER_DAILY_CAP_USD';

export type DailyCapSource = 'env' | 'file' | 'default';

export interface DailyCapSetting {
  /** `null` = sem teto diário (desligado explicitamente). */
  capUsd: number | null;
  source: DailyCapSource;
}

export function limitsFilePath(dataDir: string): string {
  return path.join(dataDir, 'limits.json');
}

export function ledgerDir(dataDir: string): string {
  return path.join(dataDir, 'ledger');
}

/** `none`/`off` → null; número ≥ 0 → ele; qualquer outra coisa → undefined (inválido). */
export function parseCapValue(raw: unknown): number | null | undefined {
  if (raw === null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'none' || v === 'off') return null;
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Precedência: `$PROMPT_BUILDER_DAILY_CAP_USD` → `<data-dir>/limits.json` → default. */
export function resolveDailyCap(dataDir: string, env: NodeJS.ProcessEnv = process.env): DailyCapSetting {
  const doEnv = env[DAILY_CAP_ENV];
  if (typeof doEnv === 'string' && doEnv.trim()) {
    const v = parseCapValue(doEnv);
    if (v === undefined) {
      throw new CliError(
        `${DAILY_CAP_ENV}="${doEnv}" inválido: use um valor em USD (ex.: 20) ou "none".`,
        EXIT.CONFIG,
        { env: DAILY_CAP_ENV, value: doEnv },
        { code: 'config.invalid_daily_cap', hint: `Corrija ou remova ${DAILY_CAP_ENV}.` },
      );
    }
    return { capUsd: v, source: 'env' };
  }
  const arquivo = limitsFilePath(dataDir);
  if (fs.existsSync(arquivo)) {
    const json = readJsonSync<{ dailyCapUsd?: unknown }>(arquivo);
    const v = json && 'dailyCapUsd' in json ? parseCapValue(json.dailyCapUsd) : undefined;
    if (v === undefined) {
      throw new CliError(
        `${arquivo} inválido: esperado {"dailyCapUsd": <usd> | null}.`,
        EXIT.CONFIG,
        { path: arquivo },
        { code: 'config.invalid_daily_cap', hint: 'Regrave com `prompt-builder limits set --daily <usd|none>`.' },
      );
    }
    return { capUsd: v, source: 'file' };
  }
  return { capUsd: DEFAULT_DAILY_CAP_USD, source: 'default' };
}

export function writeDailyCap(dataDir: string, capUsd: number | null): string {
  const arquivo = limitsFilePath(dataDir);
  writeAtomicSync(arquivo, `${JSON.stringify({ dailyCapUsd: capUsd }, null, 2)}\n`);
  return arquivo;
}

/** Dia UTC — o mesmo relógio do `limit_reset: daily` do OpenRouter (reset às 00:00 UTC). */
export function utcDay(ms: number = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function nextUtcMidnight(ms: number = Date.now()): string {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

// --- o arquivo do dia ------------------------------------------------------------

export interface SpendEntry {
  pid: number;
  host: string;
  label: string;
  startedAt: string;
  updatedAt: string;
  /** Gasto MEDIDO (usage.cost liquidado). */
  spentUsd: number;
  /** Reservas em voo de um processo vivo. */
  pendingUsd: number;
  /**
   * Reservas de um processo que MORREU com chamadas em voo: a requisição pode
   * ter sido cobrada, então conta como gasto (falha fechada) — mas separada do
   * medido, porque dinheiro é medido, nunca inferido.
   */
  presumedUsd: number;
  calls: number;
}

interface SpendDayFile {
  version: 1;
  day: string;
  entries: Record<string, SpendEntry>;
}

export interface DailySnapshot {
  day: string;
  capUsd: number | null;
  capSource: DailyCapSource;
  /** Medido + presumido (processos mortos com reserva em voo). */
  spentUsd: number;
  presumedUsd: number;
  pendingUsd: number;
  /** `null` = sem teto. */
  remainingUsd: number | null;
  /** 00:00 UTC do dia seguinte. */
  resetsAt: string;
  /** Processos com lançamento hoje (vivos ou não). */
  processes: number;
  entries: (SpendEntry & { id: string; alive: boolean })[];
}

const EPS = 1e-12;

function emptyDay(day: string): SpendDayFile {
  return { version: 1, day, entries: {} };
}

function entryAlive(e: SpendEntry): boolean {
  // Outro host (data-dir em rede): sem como checar o PID — vivo por padrão.
  return e.host !== hostName() || pidAlive(e.pid);
}

/** Reserva de reservas de processos mortos vira gasto presumido (reconciliação). */
function reconcile(d: SpendDayFile, selfId: string): void {
  for (const [id, e] of Object.entries(d.entries)) {
    if (id === selfId || e.pendingUsd <= 0) continue;
    if (!entryAlive(e)) {
      e.presumedUsd += e.pendingUsd;
      e.pendingUsd = 0;
    }
  }
}

function committedOf(d: SpendDayFile): number {
  let s = 0;
  for (const e of Object.values(d.entries)) s += e.spentUsd + e.presumedUsd + e.pendingUsd;
  return s;
}

export interface SpendHandle {
  readonly day: string;
  readonly estUsd: number;
  /** Liquidada ou liberada: nada mais a fazer no arquivo. */
  done: boolean;
  /** `note` em curso: a liberação da reserva local não mexe no arquivo. */
  settling: boolean;
}

/**
 * Reserva da máquina recusada. É um `BudgetExceeded` (sinal de CONTROLE,
 * reconhecido por propriedade — `isControlSignal`), então o pipeline para a
 * run como "orçamento esgotado" em vez de degradar a chamada para veredito.
 */
export class DailyCapExceeded extends BudgetExceeded {
  readonly scope = 'daily' as const;
  constructor(
    spentUsd: number,
    capUsd: number,
    role?: CostRole,
    readonly reason: 'cap' | 'ledger_unavailable' = 'cap',
    detail?: string,
  ) {
    super(spentUsd, capUsd, role);
    this.name = 'DailyCapExceeded';
    this.message =
      reason === 'cap'
        ? `Teto diário da máquina esgotado: $${spentUsd.toFixed(4)} de $${capUsd.toFixed(4)} hoje (UTC), somando todos os processos` +
          (role ? ` (bloqueado em: ${role})` : '')
        : `Ledger de gasto da máquina indisponível (${detail ?? 'erro de E/S'}): com teto diário ligado, a chamada é recusada (falha fechada).`;
  }
}

/** `DailyCapExceeded` por forma (sem `instanceof` — mesma razão do `isControlSignal`). */
export function isDailyCapSignal(e: unknown): e is DailyCapExceeded {
  return typeof e === 'object' && e !== null && (e as { scope?: unknown }).scope === 'daily' && 'benchControl' in e;
}

export interface FileSpendLedgerOptions {
  dataDir: string;
  cap: DailyCapSetting;
  /** Rótulo do lançamento (comando + run), para `limits show`/`doctor`. */
  label: string;
  now?: () => number;
  /** Aviso (stderr) quando o ledger falha sem teto ligado. */
  warn?: (msg: string) => void;
}

export class FileSpendLedger {
  readonly id: string;
  readonly cap: DailyCapSetting;
  /** O teto diário (não o da run) negou alguma reserva/porta nesta execução. */
  capHit = false;
  private label: string;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly warnFn?: (msg: string) => void;
  private broken: string | null = null;
  private avisou = false;
  private readonly startedAt: string;

  constructor(opts: FileSpendLedgerOptions) {
    this.dir = ledgerDir(opts.dataDir);
    this.cap = opts.cap;
    this.label = opts.label;
    this.now = opts.now ?? Date.now;
    this.warnFn = opts.warn;
    this.id = `${hostName()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.startedAt = new Date(this.now()).toISOString();
  }

  setLabel(label: string): void {
    this.label = label;
  }

  fileFor(day: string): string {
    return path.join(this.dir, `spend-${day}.json`);
  }

  private read(day: string): SpendDayFile {
    const d = readJsonSync<SpendDayFile>(this.fileFor(day));
    return d && d.version === 1 && d.entries && typeof d.entries === 'object' ? d : emptyDay(day);
  }

  /** Read-modify-write sob mutex entre processos + escrita atômica. */
  private mutate<T>(day: string, fn: (d: SpendDayFile, me: SpendEntry) => T): T {
    const file = this.fileFor(day);
    return withMutexSync(`${file}.lock`, () => {
      const d = this.read(day);
      reconcile(d, this.id);
      const agora = new Date(this.now()).toISOString();
      const me =
        d.entries[this.id] ??
        (d.entries[this.id] = {
          pid: process.pid,
          host: hostName(),
          label: this.label,
          startedAt: this.startedAt,
          updatedAt: agora,
          spentUsd: 0,
          pendingUsd: 0,
          presumedUsd: 0,
          calls: 0,
        });
      const r = fn(d, me);
      me.label = this.label;
      me.updatedAt = agora;
      writeAtomicSync(file, JSON.stringify(d));
      return r;
    });
  }

  private markBroken(err: unknown): void {
    this.broken = (err as Error)?.message ?? String(err);
    if (!this.avisou) {
      this.avisou = true;
      this.warnFn?.(`ledger de gasto da máquina indisponível: ${this.broken}`);
    }
  }

  /** Só leitura (sem mutex: a escrita é atômica, o leitor nunca vê meio arquivo). */
  snapshot(): DailySnapshot {
    const ms = this.now();
    const day = utcDay(ms);
    const d = this.read(day);
    let spent = 0;
    let presumed = 0;
    let pending = 0;
    const entries: DailySnapshot['entries'] = [];
    for (const [id, e] of Object.entries(d.entries)) {
      const alive = id === this.id || entryAlive(e);
      const pend = alive ? e.pendingUsd : 0;
      const pres = e.presumedUsd + (alive ? 0 : e.pendingUsd);
      spent += e.spentUsd + pres;
      presumed += pres;
      pending += pend;
      entries.push({ ...e, pendingUsd: pend, presumedUsd: pres, id, alive });
    }
    const cap = this.cap.capUsd;
    return {
      day,
      capUsd: cap,
      capSource: this.cap.source,
      spentUsd: spent,
      presumedUsd: presumed,
      pendingUsd: pending,
      remainingUsd: cap === null ? null : Math.max(0, cap - spent - pending),
      resetsAt: nextUtcMidnight(ms),
      processes: entries.length,
      entries,
    };
  }

  remainingUsd(): number | undefined {
    if (this.cap.capUsd === null) return undefined;
    try {
      return this.snapshot().remainingUsd ?? undefined;
    } catch (err) {
      this.markBroken(err);
      return 0;
    }
  }

  /** Porta suave: cabe `projectedUsd` a mais no teto diário? */
  canAfford(projectedUsd: number): boolean {
    const r = this.remainingUsd();
    if (r === undefined) return true;
    const ok = projectedUsd <= r + EPS;
    if (!ok) this.capHit = true;
    return ok;
  }

  /**
   * Porta dura: reserva `estUsd` no arquivo do dia, ou lança `DailyCapExceeded`
   * se o comprometido de TODOS os processos + a reserva passaria do teto.
   */
  reserve(estUsd: number, role?: CostRole): SpendHandle {
    const cap = this.cap.capUsd;
    const day = utcDay(this.now());
    const est = Math.max(0, Number.isFinite(estUsd) ? estUsd : 0);
    if (this.broken && cap !== null) throw new DailyCapExceeded(0, cap, role, 'ledger_unavailable', this.broken);
    try {
      this.mutate(day, (d, me) => {
        const committed = committedOf(d);
        if (cap !== null && committed + est > cap + EPS) {
          this.capHit = true;
          throw new DailyCapExceeded(committed, cap, role);
        }
        me.pendingUsd += est;
      });
    } catch (err) {
      if (isDailyCapSignal(err)) throw err;
      this.markBroken(err);
      if (cap !== null) throw new DailyCapExceeded(0, cap, role, 'ledger_unavailable', this.broken ?? undefined);
      return { day, estUsd: 0, done: true, settling: false };
    }
    return { day, estUsd: est, done: false, settling: false };
  }

  /** Troca a reserva pelo custo MEDIDO (usage.cost). */
  settle(h: SpendHandle, actualUsd: number): void {
    if (h.done) return;
    h.done = true;
    const usd = Number.isFinite(actualUsd) ? Math.max(0, actualUsd) : 0;
    try {
      this.mutate(h.day, (_d, me) => {
        me.pendingUsd = Math.max(0, me.pendingUsd - h.estUsd);
        me.spentUsd += usd;
        me.calls += 1;
      });
    } catch (err) {
      this.markBroken(err);
    }
  }

  /** Chamada que não chegou a ser cobrada (falha antes da resposta): devolve a reserva. */
  release(h: SpendHandle): void {
    if (h.done) return;
    h.done = true;
    if (h.estUsd <= 0) return;
    try {
      this.mutate(h.day, (_d, me) => {
        me.pendingUsd = Math.max(0, me.pendingUsd - h.estUsd);
      });
    } catch (err) {
      this.markBroken(err);
    }
  }

  /** Fim do processo: zera o que ainda estiver pendente em nome dele hoje. */
  close(): void {
    try {
      const day = utcDay(this.now());
      if (!this.read(day).entries[this.id]) return;
      this.mutate(day, (_d, me) => {
        me.pendingUsd = 0;
      });
    } catch {
      /* fim de processo: nada a fazer */
    }
  }
}

// --- o BudgetLedger que passa pela máquina --------------------------------------

type EstimateFn = NonNullable<BudgetLedgerOptions['estimateCall']>;

export interface MachineBudgetLedgerOptions extends BudgetLedgerOptions {
  machine: FileSpendLedger;
}

/**
 * `BudgetLedger` cuja porta dura consulta TAMBÉM o ledger da máquina. O teto
 * da RUN segue na raiz (semântica de sempre); o teto DIÁRIO vale para todos os
 * processos. `fork()` devolve a mesma classe: o orquestrador (via
 * `parentLedger`) e o treino criam filhos que continuam passando por aqui.
 */
export class MachineBudgetLedger extends BudgetLedger {
  readonly machine: FileSpendLedger;
  private readonly machineEstimate?: EstimateFn;
  private readonly machineHandles = new WeakMap<Reservation, SpendHandle>();

  constructor(opts: MachineBudgetLedgerOptions) {
    super(opts);
    this.machine = opts.machine;
    this.machineEstimate = opts.estimateCall;
  }

  override fork(): BudgetLedger {
    return new MachineBudgetLedger({ parent: this, machine: this.machine, estimateCall: this.machineEstimate });
  }

  override reserve(role: CostRole, modelId: string, promptTokensGuess: number, maxTokens: number): Reservation {
    // Teto da run + cancelamento primeiro (sem tocar o disco se já não cabe).
    const local = super.reserve(role, modelId, promptTokensGuess, maxTokens);
    const est = this.machineEstimate?.(modelId, promptTokensGuess, maxTokens) ?? 0;
    let h: SpendHandle;
    try {
      h = this.machine.reserve(est, role);
    } catch (err) {
      local.release();
      throw err;
    }
    const reservation: Reservation = {
      release: () => {
        local.release();
        if (!h.done && !h.settling) this.machine.release(h);
      },
    };
    this.machineHandles.set(reservation, h);
    return reservation;
  }

  override note(reservation: Reservation, entry: Parameters<BudgetLedger['note']>[1]): void {
    const h = this.machineHandles.get(reservation);
    if (h) h.settling = true;
    // O ledger da run é a fonte de verdade da run: contabiliza primeiro.
    super.note(reservation, entry);
    if (h) this.machine.settle(h, entry.cost.usd);
  }

  override canAfford(projectedUsd: number): boolean {
    return super.canAfford(projectedUsd) && this.machine.canAfford(projectedUsd);
  }

  override remainingUsd(): number | undefined {
    const run = super.remainingUsd();
    const dia = this.machine.remainingUsd();
    if (run === undefined) return dia;
    if (dia === undefined) return run;
    return Math.min(run, dia);
  }
}

export interface OpenMachineLedgerOptions {
  dataDir: string;
  label: string;
  budgetUsd?: number;
  signal?: AbortSignal;
  estimateCall?: EstimateFn;
  warn?: (msg: string) => void;
  cap?: DailyCapSetting;
}

/** Raiz pronta para `parentLedger` (orquestrador/treino) + o ledger da máquina. */
export function openMachineLedger(opts: OpenMachineLedgerOptions): {
  root: MachineBudgetLedger;
  machine: FileSpendLedger;
} {
  const machine = new FileSpendLedger({
    dataDir: opts.dataDir,
    cap: opts.cap ?? resolveDailyCap(opts.dataDir),
    label: opts.label,
    warn: opts.warn,
  });
  const root = new MachineBudgetLedger({
    budgetUsd: opts.budgetUsd,
    signal: opts.signal,
    estimateCall: opts.estimateCall,
    machine,
  });
  return { root, machine };
}

/**
 * Dias de ledger mantidos no disco (IMPL-031, revisão). O teto só lê o dia
 * CORRENTE; os anteriores ficam só como histórico para `limits show`/auditoria
 * — sem GC, `<data-dir>/ledger` crescia um arquivo (+ lock) por dia para sempre.
 */
export const LEDGER_KEEP_DAYS = 30;

/**
 * GC de `<data-dir>/ledger`: apaga `spend-AAAA-MM-DD.json` (e o `.lock` do dia)
 * de dias UTC mais antigos que `keepDays`. O dia é lido do NOME, nunca do mtime
 * — um arquivo de hoje nunca sai, mesmo parado. Devolve quantos saíram; nunca lança.
 */
export function pruneLedgerDays(dataDir: string, keepDays: number = LEDGER_KEEP_DAYS, now: number = Date.now()): number {
  let nomes: string[];
  try {
    nomes = fs.readdirSync(ledgerDir(dataDir));
  } catch {
    return 0;
  }
  const corte = utcDay(now - keepDays * 86_400_000);
  let removidos = 0;
  for (const nome of nomes) {
    const m = /^spend-(\d{4}-\d{2}-\d{2})\.json(\.lock)?$/.exec(nome);
    // Comparação lexicográfica de AAAA-MM-DD == cronológica.
    if (!m || m[1] >= corte) continue;
    try {
      fs.unlinkSync(path.join(ledgerDir(dataDir), nome));
      removidos += 1;
    } catch {
      /* outro processo já apagou */
    }
  }
  return removidos;
}

/** Situação do dia sem criar lançamento (preflight, doctor, `limits show`). */
export function readDailySnapshot(dataDir: string, cap?: DailyCapSetting): DailySnapshot {
  return new FileSpendLedger({ dataDir, cap: cap ?? resolveDailyCap(dataDir), label: 'leitura' }).snapshot();
}
