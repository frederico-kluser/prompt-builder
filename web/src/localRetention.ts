// Retenção LGPD do histórico LOCAL da SPA (left#6 — parte web do IMPL-100).
//
// O TTL do Node (`src/lgpd.ts`: 90 dias por default, `PB_RETENTION_DAYS`) já
// podava `<data-dir>/runs|sessions|jev-*` nas listagens e antes de cada run do
// CLI; a SPA guardava tudo no IndexedDB para sempre. Aqui fica o MESMO corte
// para o navegador, rodado UMA vez na carga da página (`startLocalRetention`,
// chamado por main.tsx):
//
//  • TTL = `retentionDaysFor()` de `web/src/lgpd.ts` (default do pacote,
//    `src/data/lgpd-retention.json`, + override `pb.retentionDays` que a tela
//    de Configurações grava); 0 desliga;
//  • idade = o MAIS RECENTE entre `startedAt` e `importedAt` (a mesma régua do
//    `retentionReferenceMs` do Node — importar um arquivo antigo NÃO o faz
//    sumir na carga seguinte); data ilegível = vencido (não reter por engano);
//  • apaga record + resumo (+ o journal de chamadas `journal:<runId>:…` das
//    runs LLM) numa transação por item — um item preso não derruba a varredura
//    e o prune NUNCA lança (critério (2) do IMPL-100: 0 exceções);
//  • `running` fica: quem decide órfã é a varredura de locks; a órfã vira
//    `aborted` e vence na carga seguinte;
//  • a biblioteca de prompts ('prompts') é curadoria do usuário, não registro
//    de execução — fica fora, igual ao Node (que só poda runs e sessões).
//
// ⚠️ Isto é apagamento LÓGICO (`tx.delete`): os tombstones do LevelDB seguem
// recuperáveis até a compactação (crbug 40418460). O apagamento forte é o
// "Apagar todos os dados locais" das Configurações (`wipeLocalData`, que
// derruba o banco inteiro).

import { idbGet, idbGetAll, idbGetAllKeys, idbWrite, type IdbWriteOp, type Store } from './idb';
import { isOlderThan, retentionCutoffMs, retentionDaysFor } from './lgpd';

/** Tipo de registro local sujeito ao TTL. */
export type LocalRecordKind = 'run' | 'session' | 'jev-run' | 'jev-session';

export interface LocalPruneReport {
  /** TTL aplicado (dias; 0 = desligado, nada é apagado). */
  retentionDays: number;
  /** Resumos varridos. */
  scanned: number;
  /** Vencidos apagados — ou que SERIAM apagados, com `dryRun`. */
  deleted: Array<{ kind: LocalRecordKind; id: string }>;
  /** Entradas de journal de chamadas apagadas junto das runs vencidas. */
  journalEntries: number;
  /** Falhas por item (a varredura segue). */
  errors: Array<{ id: string; error: string }>;
}

export interface LocalPruneOptions {
  now?: number;
  /** Sobrepõe o TTL configurado (testes). */
  retentionDays?: number;
  /** Só relata o que venceria. */
  dryRun?: boolean;
}

/**
 * Referência de idade de um record: o MAIS RECENTE entre `startedAt` e
 * `importedAt` — espelho de `retentionReferenceMs` (`src/lgpd.ts`, Node);
 * `test/web-local-retention.test.ts` casa os dois. `null` = nenhuma data legível.
 */
export function localRetentionReferenceMs(rec: { startedAt?: unknown; importedAt?: unknown }): number | null {
  const datas = [rec.startedAt, rec.importedAt]
    .map((v) => (typeof v === 'string' ? Date.parse(v) : Number.NaN))
    .filter((t) => Number.isFinite(t));
  return datas.length ? Math.max(...datas) : null;
}

interface Alvo {
  kind: LocalRecordKind;
  id: string;
  status?: unknown;
  startedAt?: unknown;
  recordStore: Store;
  summaryStore: Store;
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Prune do TTL no IndexedDB. Candidatos saem dos RESUMOS (baratos); só quem
 * já venceu pelo `startedAt` tem o record lido para conferir o `importedAt`
 * (que só pode ser mais recente). Nunca rejeita.
 */
export async function pruneExpiredLocal(opts: LocalPruneOptions = {}): Promise<LocalPruneReport> {
  const now = opts.now ?? Date.now();
  let retentionDays = 0;
  const report: LocalPruneReport = { retentionDays, scanned: 0, deleted: [], journalEntries: 0, errors: [] };
  try {
    retentionDays = opts.retentionDays ?? retentionDaysFor();
    report.retentionDays = retentionDays;
    if (retentionCutoffMs(now, retentionDays) === null) return report; // TTL desligado

    const [runs, sessions, jev] = await Promise.all([
      idbGetAll<{ id?: unknown; status?: unknown; startedAt?: unknown }>('runSummaries'),
      idbGetAll<{ id?: unknown; status?: unknown; startedAt?: unknown }>('sessionSummaries'),
      idbGetAll<{ id?: unknown; kind?: unknown; status?: unknown; startedAt?: unknown }>('jevSummaries'),
    ]);
    const alvo = (
      kind: LocalRecordKind,
      row: { id?: unknown; status?: unknown; startedAt?: unknown } | null | undefined,
      recordStore: Store,
      summaryStore: Store,
    ): Alvo | null =>
      typeof row?.id === 'string' && row.id !== ''
        ? { kind, id: row.id, status: row.status, startedAt: row.startedAt, recordStore, summaryStore }
        : null;
    const alvos = [
      ...runs.map((r) => alvo('run', r, 'runs', 'runSummaries')),
      ...sessions.map((s) => alvo('session', s, 'sessions', 'sessionSummaries')),
      ...jev.map((j) =>
        j?.kind === 'session' ? alvo('jev-session', j, 'jevSessions', 'jevSummaries') : alvo('jev-run', j, 'jevRuns', 'jevSummaries'),
      ),
    ].filter((a): a is Alvo => a !== null);

    let chavesDeRuns: string[] | null = null;
    for (const alvo of alvos) {
      report.scanned += 1;
      try {
        if (alvo.status === 'running') continue;
        // Pelo resumo: dentro do TTL ⇒ fica (o `importedAt` só pode ser MAIS recente).
        if (typeof alvo.startedAt === 'string' && !isOlderThan(alvo.startedAt, now, retentionDays)) continue;
        const rec = await idbGet<{ status?: unknown; startedAt?: unknown; importedAt?: unknown }>(alvo.recordStore, alvo.id);
        if (rec?.status === 'running') continue;
        const ref = rec ? (localRetentionReferenceMs(rec) ?? String(rec.startedAt ?? '')) : String(alvo.startedAt ?? '');
        if (!isOlderThan(ref, now, retentionDays)) continue;

        const ops: IdbWriteOp[] = [
          { store: alvo.recordStore, delete: alvo.id },
          { store: alvo.summaryStore, delete: alvo.id },
        ];
        if (alvo.kind === 'run') {
          // Journal de chamadas da run (IMPL-081): ids `journal:<runId>:…` na store 'runs'.
          chavesDeRuns ??= await idbGetAllKeys('runs');
          const prefixo = `journal:${alvo.id}:`;
          const journal = chavesDeRuns.filter((k) => k.startsWith(prefixo));
          for (const k of journal) ops.push({ store: 'runs', delete: k });
          report.journalEntries += journal.length;
        }
        if (!opts.dryRun) await idbWrite(ops, { durability: 'relaxed' });
        report.deleted.push({ kind: alvo.kind, id: alvo.id });
      } catch (err) {
        report.errors.push({ id: alvo.id, error: errMsg(err) });
      }
    }
  } catch (err) {
    report.errors.push({ id: '*', error: errMsg(err) });
  }
  return report;
}

// ---------------------------------------------------------------------------
// Uma vez por carga de página (main.tsx)
// ---------------------------------------------------------------------------

let startup: Promise<LocalPruneReport> | null = null;
let lastReport: LocalPruneReport | null = null;
const listeners = new Set<() => void>();

/** O relatório do prune desta carga de página (null = ainda não rodou). */
export function lastLocalPrune(): LocalPruneReport | null {
  return lastReport;
}

/** Assinatura para a tela de Configurações (useSyncExternalStore). */
export function subscribeLocalPrune(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function publicar(r: LocalPruneReport): void {
  lastReport = r;
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch (err) {
      console.warn('[retenção] listener falhou:', err);
    }
  }
}

/**
 * Roda o prune do TTL UMA vez por carga de página, fora do caminho crítico da
 * primeira pintura. Idempotente; nunca rejeita.
 */
export function startLocalRetention(opts: LocalPruneOptions = {}): Promise<LocalPruneReport> {
  startup ??= new Promise<void>((resolve) => setTimeout(resolve, 0))
    .then(() => pruneExpiredLocal(opts))
    .then((r) => {
      if (r.deleted.length > 0) {
        console.info(`[retenção] ${r.deleted.length} registro(s) local(is) com mais de ${r.retentionDays} dias apagado(s) (TTL LGPD).`);
      }
      if (r.errors.length > 0) console.warn('[retenção] itens que o prune não apagou:', r.errors);
      publicar(r);
      return r;
    });
  return startup;
}

/** Só para testes: esquece o prune desta "carga de página". */
export function _resetLocalRetentionForTests(): void {
  startup = null;
  lastReport = null;
}
