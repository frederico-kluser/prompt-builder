// Ciclo de vida dos REGISTROS no data-dir — o lado do CLI de dois itens:
//
//  • IMPL-100 (R-16:REC-6, LGPD): `runs delete <id…>`, `sessions delete <id…>`
//    e `runs prune` apagam de verdade (record + TODOS os resíduos, ver
//    src/lgpd.ts); o TTL (90 dias por default, `PB_RETENTION_DAYS`) roda
//    sozinho nas listagens e no pré-voo de cada run real (`retentionSweep`).
//  • IMPL-089 (R-22:REC-1): `runs export --format exchange`, `sessions export`
//    e `runs|sessions import` falam `prompt-builder-exchange@1` — o record vai
//    VERBATIM (campo desconhecido incluso) e a ida e volta é identidade.
//
// Tudo aqui é disco local: sem key, sem rede.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getDataDir, loadRun, loadSession, ownerStateOf, saveRun, saveSession } from '../storage.js';
import { isValidRecordId, readFileInside } from '../pathSafety.js';
import {
  autoPrune,
  eraseRunFiles,
  eraseSessionFiles,
  loadRetentionPolicy,
  pruneExpiredRuns,
  pruneExpiredSessions,
  RETENTION_DAYS_ENV,
  type PruneReport,
  type RunEraseResult,
} from '../lgpd.js';
import {
  buildExchangeBundle,
  EXCHANGE_FORMAT,
  isExchangeManifestOnly,
  isSingleFileBundle,
  parseExchangeBundle,
  toSingleFileBundle,
  type ExchangeBundle,
  type ExchangeKind,
} from '../engine/exchange.js';
import { contentHash } from '../engine/hash.js';
import { isExchangeReadError, readExchangeDir, writeExchangeDir } from '../library.js';
import { pkgVersion } from '../paths.js';
import { sessionRunIds } from './approval.js';
import { findJevRecord } from '../jev/store.js';
import { readJsonFile } from './context.js';
import { CliError, EXIT, type Output } from './output.js';
import type { SessionRecord } from '../types.js';

type RecordKind = 'run' | 'session';

const DIR_DO_TIPO: Record<RecordKind, 'runs' | 'sessions'> = { run: 'runs', session: 'sessions' };
const NOME: Record<RecordKind, string> = { run: 'run', session: 'sessão' };

// --- retenção (IMPL-100) -----------------------------------------------------

/**
 * TTL ligado por default: varre runs E sessões vencidas (no máximo uma vez por
 * hora por processo — `autoPrune`) e narra no stderr o que saiu. Nunca lança:
 * falha de um item vira aviso, o comando segue.
 */
export async function retentionSweep(out: Output): Promise<PruneReport> {
  const r = await autoPrune();
  const runs = r.deleted.length;
  const sessoes = r.sessions?.deleted.length ?? 0;
  if (runs + sessoes > 0) {
    const dias = loadRetentionPolicy().retentionDays;
    out.info(
      `retenção LGPD (${dias} dias): apagados ${runs} run(s) e ${sessoes} sessão(ões) vencida(s) — ` +
        `${RETENTION_DAYS_ENV}=0 desliga o TTL.`,
    );
  }
  const erros = [...r.errors, ...(r.sessions?.errors ?? [])];
  if (erros.length > 0) out.warn(`retenção: ${erros.length} item(ns) não puderam ser apagados (${erros[0].error}).`);
  return r;
}

/** `--older-than`: `30d`, `2w` ou só o número de dias. `undefined` = política. */
export function parseOlderThanDays(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const m = typeof raw === 'string' ? /^\s*(\d+)\s*([dw]?)\s*$/iu.exec(raw) : null;
  if (!m) {
    throw new CliError(
      `--older-than deve ser um número de dias, "30d" ou "2w" (recebi "${String(raw)}").`,
      EXIT.USAGE,
      { flag: '--older-than', value: raw },
      { code: 'usage.invalid_flag_value', hint: 'Ex.: `runs prune --older-than 30d` (ou `--older-than 0`, que não apaga nada por idade).' },
    );
  }
  return Number(m[1]) * (m[2].toLowerCase() === 'w' ? 7 : 1);
}

/** `runs prune [--older-than 30d] [--dry-run]`: o TTL agora, sem o limite de 1×/hora. */
export async function runsPrune(out: Output, values: Record<string, unknown>): Promise<number> {
  const olderThan = parseOlderThanDays(values['older-than']);
  const retentionDays = olderThan ?? loadRetentionPolicy().retentionDays;
  const dryRun = values['dry-run'] === true;
  const opts = { retentionDays, dryRun };
  const runs = await pruneExpiredRuns(opts);
  const sessions = await pruneExpiredSessions(opts);
  if (retentionDays === 0) out.info('TTL desligado (0 dias): nada vence por idade.');
  const verbo = dryRun ? 'apagaria' : 'apagou';
  if (out.isText) {
    out.line(`${verbo} ${runs.deleted.length} run(s) e ${sessions.deleted.length} sessão(ões) com mais de ${retentionDays} dias`);
    for (const id of runs.deleted) out.line(`  run     ${id}`);
    for (const id of sessions.deleted) out.line(`  sessão  ${id}`);
  }
  for (const e of [...runs.errors, ...sessions.errors]) out.warn(`não consegui apagar ${e.id}: ${e.error}`);
  out.result(true, 'runs.prune', { retentionDays, dryRun, runs, sessions });
  return EXIT.OK;
}

// --- apagamento explícito (IMPL-100) -----------------------------------------

/**
 * Modo JEV (merge sobre a onda 2): `runs delete` também alcança um record de
 * `jev-runs/`/`jev-sessions/` e `sessions delete` uma sessão JEV (com as runs
 * dela). O apagamento em si é o MESMO (`eraseRunFiles`/`eraseSessionFiles`,
 * src/lgpd.ts, já leva os arquivos jev-*); sem isto a única saída LGPD de um
 * record JEV seria o TTL. `running` aqui já passou pela checagem de órfã do
 * store (dono morto vira `aborted` ao carregar) — ou seja, dono vivo.
 */
async function jevApagavel(
  kind: RecordKind,
  id: string,
): Promise<{ status: string; sessionId?: string; runIds: string[] } | null> {
  const jev = await findJevRecord(id).catch(() => null);
  if (!jev || (kind === 'session' && jev.kind !== 'session')) return null;
  if (jev.kind === 'session') {
    return { status: jev.rec.status, runIds: (jev.rec.runIds ?? []).filter((x) => isValidRecordId(x)) };
  }
  return { status: jev.rec.status, ...(jev.rec.sessionId ? { sessionId: jev.rec.sessionId } : {}), runIds: [] };
}

async function exigirApagavel(kind: RecordKind, id: string): Promise<{ status: string; sessionId?: string; runIds: string[] }> {
  if (!isValidRecordId(id)) {
    throw new CliError(`Id de ${NOME[kind]} inválido: use o id listado em \`prompt-builder ${DIR_DO_TIPO[kind]} list\`.`, EXIT.USAGE);
  }
  const record = kind === 'run' ? await loadRun(id) : await loadSession(id);
  if (!record) {
    const jev = await jevApagavel(kind, id);
    if (jev) {
      if (jev.status === 'running') {
        throw new CliError(
          `A ${NOME[kind]} JEV "${id}" ainda está rodando — nada foi apagado.`,
          EXIT.USAGE,
          { id, status: jev.status },
          { code: `${DIR_DO_TIPO[kind]}.delete_running`, hint: 'Pare o processo dono (Ctrl-C/SIGTERM) e repita o delete.' },
        );
      }
      return jev;
    }
    throw new CliError(
      `${kind === 'run' ? 'Run' : 'Sessão'} "${id}" não encontrada no diretório de dados — nada foi apagado.`,
      EXIT.USAGE,
      { id },
      { code: `${DIR_DO_TIPO[kind]}.not_found`, hint: `Confira \`prompt-builder ${DIR_DO_TIPO[kind]} list\` e --data-dir.` },
    );
  }
  if (record.status === 'running' && (await ownerStateOf(kind, id)).state === 'alive') {
    // Apagar sob um dono vivo não apaga nada: o próximo save dele recria o record.
    throw new CliError(
      `A ${NOME[kind]} "${id}" ainda está rodando — nada foi apagado.`,
      EXIT.USAGE,
      { id, status: record.status },
      {
        code: `${DIR_DO_TIPO[kind]}.delete_running`,
        hint: `Pare antes com \`prompt-builder runs cancel ${id}\` e repita o delete.`,
      },
    );
  }
  const sessao = kind === 'session' ? (record as SessionRecord) : null;
  const runIds = sessao ? runIdsOfSession(sessao) : [];
  return {
    status: record.status,
    ...(kind === 'run' && (record as { sessionId?: string }).sessionId
      ? { sessionId: (record as { sessionId?: string }).sessionId }
      : {}),
    runIds,
  };
}

/** Runs de uma sessão (iterações + re-avaliações), só ids válidos — a MESMA lista do registro de aprovação. */
function runIdsOfSession(s: SessionRecord): string[] {
  return sessionRunIds(s).filter((x) => isValidRecordId(x));
}

/** `runs delete <id…>`: valida TODOS antes de apagar qualquer um (tudo ou nada no uso). */
export async function runsDelete(out: Output, ids: string[]): Promise<number> {
  if (ids.length === 0) throw new CliError('Uso: prompt-builder runs delete <id> [<id> …]', EXIT.USAGE);
  const alvos: Array<{ id: string; sessionId?: string }> = [];
  for (const id of ids) alvos.push({ id, ...(await exigirApagavel('run', id)) });
  const dataDir = getDataDir();
  const deleted: RunEraseResult[] = [];
  for (const a of alvos) deleted.push(await eraseRunFiles(dataDir, a.id));
  for (const a of alvos) {
    if (a.sessionId) {
      out.warn(`a run ${a.id} era da sessão ${a.sessionId}, que ainda a cita — \`sessions delete ${a.sessionId}\` apaga a sessão inteira.`);
    }
  }
  if (out.isText) for (const d of deleted) out.line(`apagada ${d.id} (${d.removed.length} arquivo(s))`);
  out.result(true, 'runs.delete', { deleted, count: deleted.length });
  return EXIT.OK;
}

/** `sessions delete <id…> [--keep-runs]`: a sessão E as runs dela (iterações + re-avaliações). */
export async function sessionsDelete(out: Output, ids: string[], opts: { keepRuns: boolean }): Promise<number> {
  if (ids.length === 0) throw new CliError('Uso: prompt-builder sessions delete <id> [<id> …] [--keep-runs]', EXIT.USAGE);
  const alvos: Array<{ id: string; runIds: string[] }> = [];
  for (const id of ids) alvos.push({ id, ...(await exigirApagavel('session', id)) });
  const dataDir = getDataDir();
  const deleted: Array<RunEraseResult & { runs: RunEraseResult[] }> = [];
  for (const a of alvos) {
    const runs: RunEraseResult[] = [];
    if (!opts.keepRuns) for (const rid of a.runIds) runs.push(await eraseRunFiles(dataDir, rid));
    deleted.push({ ...(await eraseSessionFiles(dataDir, a.id)), runs });
  }
  if (out.isText) {
    for (const d of deleted) out.line(`apagada sessão ${d.id} (${d.removed.length} arquivo(s)) + ${d.runs.length} run(s)`);
  }
  out.result(true, 'sessions.delete', { deleted, count: deleted.length, keepRuns: opts.keepRuns });
  return EXIT.OK;
}

// --- troca prompt-builder-exchange@1 (IMPL-089) -------------------------------

/** O record CRU do disco (sem normalização): campo desconhecido incluso. */
async function lerCru(kind: RecordKind, id: string): Promise<Record<string, unknown> | null> {
  if (!isValidRecordId(id)) return null;
  try {
    const texto = await readFileInside(path.join(getDataDir(), DIR_DO_TIPO[kind]), `${id}.json`);
    return JSON.parse(texto) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Grava o pacote como o `library export` (dir, `.json` único ou stdout). */
async function entregarPacote(
  out: Output,
  command: string,
  bundle: ExchangeBundle,
  destino: string | undefined,
  resumo: Record<string, unknown>,
): Promise<void> {
  const unico = `${JSON.stringify(toSingleFileBundle(bundle), null, 2)}\n`;
  if (destino && destino.toLowerCase().endsWith('.json')) {
    await fs.writeFile(destino, unico, 'utf-8');
    out.info(`pacote ${EXCHANGE_FORMAT} gravado em ${destino} (arquivo único)`);
  } else if (destino) {
    await writeExchangeDir(destino, bundle);
    out.info(`pacote ${EXCHANGE_FORMAT} gravado em ${destino}/ (${Object.keys(bundle.files).join(', ')})`);
  } else if (out.isText) {
    out.raw(unico);
  }
  out.result(true, command, {
    format: EXCHANGE_FORMAT,
    ...resumo,
    ...(destino ? { [destino.toLowerCase().endsWith('.json') ? 'file' : 'dir']: destino } : {}),
    lostFields: [],
    // Sem -o, o pacote vai NO resultado (um único JSON no stdout).
    ...(destino ? {} : { bundle: toSingleFileBundle(bundle) }),
  });
}

const produtor = (): string => `prompt-builder-cli@${pkgVersion()}`;

/** `runs export <id> --format exchange [-o <dir|arq.json>]`: a run VERBATIM. */
export async function runsExportExchange(out: Output, id: string, destino: string | undefined): Promise<number> {
  const cru = await lerCru('run', id);
  if (!cru) throw new CliError(`Run "${id}" não encontrada no diretório de dados.`, EXIT.USAGE);
  if (cru.status === 'running') out.warn(`a run ${id} ainda está rodando: o pacote leva o parcial gravado até agora.`);
  // `importedAt` é metadado local (TTL deste data-dir): o pacote leva o record
  // como a ORIGEM o gravou — ida e volta segue identidade entre data-dirs.
  const bundle = buildExchangeBundle({ producer: produtor(), runs: [semImportedAt(cru)] });
  await entregarPacote(out, 'runs.export', bundle, destino, { runId: id, runs: 1 });
  return EXIT.OK;
}

/**
 * `sessions export <id> [-o …]`: a sessão + TODAS as runs dela (iterações e
 * re-avaliações) — sem elas o relatório de ciclos não se refaz do outro lado.
 */
export async function sessionsExportExchange(out: Output, id: string, destino: string | undefined): Promise<number> {
  const cru = await lerCru('session', id);
  if (!cru) throw new CliError(`Sessão "${id}" não encontrada.`, EXIT.USAGE);
  if (cru.status === 'running') out.warn(`a sessão ${id} ainda está rodando: o pacote leva o parcial gravado até agora.`);
  const runs: Record<string, unknown>[] = [];
  const faltando: string[] = [];
  for (const rid of runIdsOfSession(cru as unknown as SessionRecord)) {
    const r = await lerCru('run', rid);
    if (r) runs.push(semImportedAt(r));
    else faltando.push(rid);
  }
  if (faltando.length > 0) {
    out.warn(`${faltando.length} run(s) da sessão não estão no disco (apagadas/nunca gravadas): ${faltando.join(', ')}.`);
  }
  const bundle = buildExchangeBundle({ producer: produtor(), sessions: [semImportedAt(cru)], runs });
  await entregarPacote(out, 'sessions.export', bundle, destino, {
    sessionId: id,
    sessions: 1,
    runs: runs.length,
    missingRunIds: faltando,
  });
  return EXIT.OK;
}

/** Lê a fonte do import: diretório do pacote, o `manifest.json` dele ou o arquivo único. */
async function lerPacote(file: string): Promise<ReturnType<typeof parseExchangeBundle>> {
  const eDiretorio = await fs
    .stat(file)
    .then((st) => st.isDirectory())
    .catch(() => false);
  let unico: unknown;
  try {
    if (eDiretorio) unico = await readExchangeDir(file);
    else {
      const cru = await readJsonFile(file);
      unico = isExchangeManifestOnly(cru) ? await readExchangeDir(path.dirname(file)) : cru;
    }
  } catch (err) {
    if (isExchangeReadError(err)) throw invalido(file, err.message);
    throw err;
  }
  if (!isSingleFileBundle(unico)) {
    throw invalido(file, `não é um pacote ${EXCHANGE_FORMAT} (esperado o diretório ou o .json de \`runs export --format exchange\`/\`sessions export\`).`);
  }
  return parseExchangeBundle(unico.files);
}

function invalido(file: string, motivo: string): CliError {
  return new CliError(`"${file}": ${motivo}`, EXIT.CONFIG, { path: file }, {
    code: 'records.exchange_invalid',
    hint: 'Aponte o diretório gerado por `runs export --format exchange -o <dir>` / `sessions export -o <dir>` (ou o .json único).',
  });
}

/** O record sem o carimbo local de importação (comparação de conteúdo). */
function semImportedAt(r: Record<string, unknown>): Record<string, unknown> {
  if (!('importedAt' in r)) return r;
  const { importedAt: _local, ...resto } = r;
  return resto;
}

/** Forma mínima de um record importável (o resto vai verbatim). `null` = ok. */
function problemaDeForma(kind: RecordKind, r: unknown): string | null {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'não é um objeto';
  const o = r as Record<string, unknown>;
  if (!isValidRecordId(o.id)) return 'id ausente ou fora do formato';
  if (typeof o.status !== 'string') return 'status ausente';
  if (typeof o.startedAt !== 'string') return 'startedAt ausente';
  if (!o.config || typeof o.config !== 'object') return 'config ausente';
  if (kind === 'run' && (!Array.isArray(o.stages) || !Array.isArray(o.contestants))) return 'stages/contestants ausentes';
  if (kind === 'session' && (!Array.isArray(o.runIds) || !Array.isArray(o.bestPromptByIteration))) {
    return 'runIds/bestPromptByIteration ausentes';
  }
  // Record 'running' importado viraria órfão (sem processo dono) no próximo list.
  if (o.status === 'running') return "status 'running' (exporte depois de a execução terminar)";
  return null;
}

/**
 * `runs import <arq|dir>` / `sessions import <arq|dir>`: o MESMO importador —
 * grava runs E sessões do pacote, verbatim. Tudo validado antes de gravar
 * qualquer coisa: forma inválida ou CONFLITO (mesmo id, conteúdo diferente)
 * recusa o pacote inteiro (exit 3) — `--overwrite` substitui os conflitantes.
 * Id igual com conteúdo idêntico é pulado (reimportar é idempotente).
 */
export async function importRecords(
  out: Output,
  command: string,
  file: string | undefined,
  opts: { overwrite: boolean },
): Promise<number> {
  if (!file) throw new CliError(`Uso: prompt-builder ${command.replace('.', ' ')} <diretório|arquivo.json> [--overwrite]`, EXIT.USAGE);
  const pacote = await lerPacote(file);
  if (!pacote.ok) throw invalido(file, pacote.error);

  const entradas: Array<{ kind: RecordKind; record: Record<string, unknown> }> = [
    ...pacote.runs.map((r) => ({ kind: 'run' as const, record: r as Record<string, unknown> })),
    ...pacote.sessions.map((r) => ({ kind: 'session' as const, record: r as Record<string, unknown> })),
  ];
  const problemas: string[] = [];
  entradas.forEach((e, i) => {
    const p = problemaDeForma(e.kind, e.record);
    if (p) problemas.push(`${e.kind} #${i + 1}${isValidRecordId(e.record?.id) ? ` (${String(e.record.id)})` : ''}: ${p}`);
  });
  if (problemas.length > 0) {
    throw new CliError(`Pacote recusado — nada foi gravado: ${problemas.slice(0, 5).join('; ')}${problemas.length > 5 ? ` (+${problemas.length - 5})` : ''}.`, EXIT.CONFIG, { problems: problemas }, {
      code: 'records.import_invalid',
      hint: 'Corrija o pacote de origem (ou exporte de novo) e repita.',
    });
  }

  const plano: Array<{ kind: RecordKind; record: Record<string, unknown>; acao: 'novo' | 'identico' | 'conflito' }> = [];
  for (const e of entradas) {
    const id = String(e.record.id);
    const atual = await lerCru(e.kind, id);
    // `importedAt` é metadado DESTE data-dir (carimbado abaixo): fica fora da
    // comparação — reimportar o mesmo pacote segue idempotente.
    const acao = !atual ? 'novo' : contentHash(semImportedAt(atual)) === contentHash(semImportedAt(e.record)) ? 'identico' : 'conflito';
    plano.push({ ...e, acao });
  }
  const conflitos = plano.filter((p) => p.acao === 'conflito');
  if (conflitos.length > 0 && !opts.overwrite) {
    throw new CliError(
      `${conflitos.length} registro(s) do pacote já existem com OUTRO conteúdo — nada foi gravado: ${conflitos
        .slice(0, 5)
        .map((c) => `${c.kind} ${String(c.record.id)}`)
        .join(', ')}.`,
      EXIT.CONFIG,
      { conflicts: conflitos.map((c) => ({ kind: c.kind, id: c.record.id })) },
      {
        code: 'records.import_conflict',
        hint: 'Nada é sobrescrito em silêncio: repita com `--overwrite` para substituir os conflitantes (ou apague-os antes).',
      },
    );
  }

  const imported: Record<'runs' | 'sessions', string[]> = { runs: [], sessions: [] };
  const skipped: string[] = [];
  const overwritten: string[] = [];
  const agora = new Date().toISOString();
  for (const p of plano) {
    const id = String(p.record.id);
    if (p.acao === 'identico') {
      skipped.push(id);
      continue;
    }
    // Verbatim: o save grava o objeto como veio (campo desconhecido incluso),
    // mais `importedAt` — revisão w2: o TTL (IMPL-100) conta da IMPORTAÇÃO.
    // Sem o carimbo, o `startedAt` original de um arquivo com > retentionDays
    // fazia o próximo `runs list` apagar o que acabou de ser importado.
    const gravado = { ...p.record, importedAt: agora };
    if (p.kind === 'run') await saveRun(gravado as never);
    else await saveSession(gravado as never);
    imported[DIR_DO_TIPO[p.kind]].push(id);
    if (p.acao === 'conflito') overwritten.push(id);
  }

  const lost = pacote.lostFields as Partial<Record<ExchangeKind, string[]>>;
  for (const [kind, campos] of Object.entries(lost)) {
    if (campos?.length) out.warn(`o pacote declara campos PERDIDOS na origem (${kind}): ${campos.join(', ')}.`);
  }
  if (pacote.library.length > 0) {
    out.warn(`${pacote.library.length} item(ns) de biblioteca no pacote NÃO foram importados aqui — use \`prompt-builder library add <arq>\`.`);
  }
  if (out.isText) {
    out.line(
      `importados: ${imported.runs.length} run(s), ${imported.sessions.length} sessão(ões)` +
        (skipped.length ? ` · ${skipped.length} idêntico(s) pulado(s)` : '') +
        (overwritten.length ? ` · ${overwritten.length} sobrescrito(s)` : ''),
    );
  }
  out.result(true, command, {
    format: EXCHANGE_FORMAT,
    imported,
    skipped,
    overwritten,
    lostFields: lost,
    libraryItemsIgnored: pacote.library.length,
  });
  return EXIT.OK;
}
