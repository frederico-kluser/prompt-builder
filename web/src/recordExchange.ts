// Export/import de runs e sessões da SPA em `prompt-builder-exchange@1`
// (left#11 — parte web do IMPL-089, R-22:REC-1).
//
// Antes o "JSON" da tela de run baixava o record cru (que o `runs import` do
// CLI recusava: ele só lê exchange@1) e a SPA não importava run nem sessão
// nenhuma. Agora o formato é o MESMO do CLI (`runs export --format exchange`,
// `sessions export`, `runs|sessions import`), montado pelo núcleo único
// `src/engine/exchange.ts` (shim `./engine/exchange`):
//
//  • export = o record VERBATIM (campo desconhecido incluso), sem o carimbo
//    local `importedAt` — ida e volta é identidade entre navegador e terminal;
//  • import aceita o exchange@1 (arquivo único `.json`, o envelope `--json` do
//    CLI, ou os arquivos do diretório: `manifest.json` + `*.jsonl`) E os
//    formatos antigos (record cru do "JSON" antigo e do aviso de "não salvo",
//    `prompt-builder-run@1` do `runs export`);
//  • tudo é validado ANTES de gravar: forma inválida ou CONFLITO (mesmo id,
//    outro conteúdo) recusa o pacote inteiro — `overwrite` substitui (a mesma
//    regra do CLI); id idêntico é pulado (reimportar é idempotente);
//  • `lostFields` do manifesto (perda declarada NA ORIGEM) volta no resultado
//    para a UI mostrar; itens de biblioteca (LibraryItem, só no CLI) são
//    contados e apontados para `prompt-builder library add`;
//  • o gravado leva `importedAt` — o TTL LGPD (`./localRetention`) conta da
//    importação, como no Node.

import {
  EXCHANGE_FORMAT,
  EXCHANGE_MANIFEST_FILE,
  buildExchangeBundle,
  isExchangeManifestOnly,
  isSingleFileBundle,
  parseExchangeBundle,
  toSingleFileBundle,
  type ExchangeKind,
} from './engine/exchange';
import { contentHash } from './engine/hash';
import { isHeldHere } from './engine/runLocks';
import { saveRun, saveSession } from './engine/storage';
import { idbGet, idbGetAll } from './idb';
import type { RunRecord, SessionRecord } from './api';

/** Quem exportou (o CLI grava `prompt-builder-cli@<versão>`). */
export const WEB_EXCHANGE_PRODUCER = 'prompt-builder-web';

/** Formato do `runs export <id>` (sem `--format`): o record vai em `record`. */
const RUN_ARTIFACT_FORMAT = 'prompt-builder-run@1';

/** Mesmo formato de `RECORD_ID_RE` (`src/pathSafety.ts`, só Node): o id vira rota e chave. */
const RECORD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Chaves que NUNCA podem viajar num record: credenciais que um record cru
 * importado pudesse trazer coladas à mão. Não são campos de domínio
 * (`RunConfig`/`RunRecord` não têm `apiKey`/`authorization`) — se aparecerem,
 * não saem na exportação nem ficam na importação. O padrão `x-.*key` cobre o
 * nome do header de key do modo servidor SEM escrever o literal, que
 * `key-handling.test.ts` proíbe em fonte web (a SPA nunca manda key por header).
 */
const RE_SEGREDO = /^(?:api[-_]?key|openrouter[-_]?api[-_]?key|authorization|x-.*key)$/iu;

/** Remove credenciais em qualquer profundidade; devolve o MESMO objeto quando não há nenhuma. */
function semSegredos<T>(v: T): T {
  if (Array.isArray(v)) {
    const arr = v.map(semSegredos);
    return (arr.every((x, i) => x === (v as unknown[])[i]) ? v : (arr as unknown)) as T;
  }
  if (!isObj(v)) return v;
  let out: Obj | null = null;
  for (const [k, val] of Object.entries(v)) {
    if (RE_SEGREDO.test(k)) {
      if (!out) out = { ...v };
      delete out[k];
      continue;
    }
    const novo = semSegredos(val);
    if (novo !== val) {
      if (!out) out = { ...v };
      out[k] = novo;
    }
  }
  return (out ?? v) as T;
}

/** O record sem dados locais: o carimbo `importedAt` e credenciais (export e comparação de conteúdo). */
function semDadosLocais<T>(r: T): T {
  if (!isObj(r)) return semSegredos(r);
  const { importedAt: _local, ...resto } = r;
  return semSegredos(resto as T);
}

function asJson(bundle: ReturnType<typeof buildExchangeBundle>): string {
  return `${JSON.stringify(toSingleFileBundle(bundle), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Uma run em exchange@1 (arquivo único) — o botão "JSON" da tela de run. */
export function runExchangeJson(record: RunRecord): string {
  return asJson(buildExchangeBundle({ producer: WEB_EXCHANGE_PRODUCER, runs: [semDadosLocais(record)] }));
}

/** Runs de uma sessão: iterações + re-avaliações limpas (ids no gate) — a lista do `sessions export`. */
export function sessionRunIds(s: Pick<SessionRecord, 'runIds' | 'bestPromptByIteration'>): string[] {
  const ids = new Set<string>(s.runIds ?? []);
  for (const it of s.bestPromptByIteration ?? []) {
    const rid = it.gate?.reeval?.runId;
    if (rid) ids.add(rid);
  }
  for (const rid of (s as { reevalRunIds?: string[] }).reevalRunIds ?? []) ids.add(rid);
  return [...ids].filter((id) => RECORD_ID_RE.test(id));
}

/**
 * Uma sessão + TODAS as runs dela em exchange@1 — sem as runs o relatório de
 * ciclos não se refaz do outro lado. `missingRunIds` = runs que a sessão cita
 * e não estão aqui (apagadas/nunca gravadas).
 */
export function sessionExchangeJson(
  session: SessionRecord,
  runs: readonly RunRecord[],
): { json: string; runs: number; missingRunIds: string[] } {
  const porId = new Map(runs.map((r) => [r.id, r]));
  const ids = sessionRunIds(session);
  const incluidas = ids.map((id) => porId.get(id)).filter((r): r is RunRecord => Boolean(r));
  const json = asJson(
    buildExchangeBundle({
      producer: WEB_EXCHANGE_PRODUCER,
      sessions: [semDadosLocais(session)],
      runs: incluidas.map((r) => semDadosLocais(r)),
    }),
  );
  return { json, runs: incluidas.length, missingRunIds: ids.filter((id) => !porId.has(id)) };
}

/**
 * O histórico LLM inteiro DESTE navegador (runs + sessões do IndexedDB,
 * verbatim) — o backup antes de apagar ou de o TTL podar.
 */
export async function historyExchangeJson(): Promise<{ json: string; runs: number; sessions: number }> {
  const [runs, sessions] = await Promise.all([idbGetAll<Obj>('runs'), idbGetAll<Obj>('sessions')]);
  // A store 'runs' também guarda o journal de chamadas (`journal:<runId>:…`).
  const records = runs.filter((r) => typeof r?.id === 'string' && RECORD_ID_RE.test(r.id));
  const sess = sessions.filter((s) => typeof s?.id === 'string' && RECORD_ID_RE.test(s.id));
  const json = asJson(
    buildExchangeBundle({
      producer: WEB_EXCHANGE_PRODUCER,
      runs: records.map((r) => semDadosLocais(r)),
      sessions: sess.map((s) => semDadosLocais(s)),
    }),
  );
  return { json, runs: records.length, sessions: sess.length };
}

// ---------------------------------------------------------------------------
// Import — leitura (pura)
// ---------------------------------------------------------------------------

export type RecordKind = 'run' | 'session';

export interface RecordPackage {
  /** De onde veio: exchange@1, artefato `prompt-builder-run@1` ou record cru (formato antigo). */
  format: 'exchange' | 'run-artifact' | 'record';
  runs: unknown[];
  sessions: unknown[];
  library: unknown[];
  lostFields: Partial<Record<ExchangeKind, string[]>>;
}

export type RecordPackageRead = ({ ok: true } & RecordPackage) | { ok: false; error: string };

const baseName = (name: string): string => name.split(/[\\/]/).pop() ?? name;

/** Um JSON avulso → pacote (exchange@1 único, envelope do CLI, artefato de run ou record cru). */
function lerJson(raw: unknown): RecordPackageRead {
  // `runs export --format exchange --json` (sem -o) põe o pacote no envelope.
  if (isObj(raw) && raw.ok === true && isObj(raw.data) && isSingleFileBundle(raw.data.bundle)) raw = raw.data.bundle;
  if (isSingleFileBundle(raw)) {
    const p = parseExchangeBundle(raw.files);
    return p.ok
      ? { ok: true, format: 'exchange', runs: p.runs, sessions: p.sessions, library: p.library, lostFields: p.lostFields }
      : { ok: false, error: `pacote ${EXCHANGE_FORMAT} inválido: ${p.error}` };
  }
  if (isExchangeManifestOnly(raw)) {
    return {
      ok: false,
      error: `é só o ${EXCHANGE_MANIFEST_FILE}: selecione junto os arquivos .jsonl do mesmo diretório (ou exporte num .json único: \`-o arquivo.json\`).`,
    };
  }
  if (!isObj(raw)) return { ok: false, error: 'não é um objeto JSON de run, sessão ou pacote.' };
  const format = raw.format;
  if (format === RUN_ARTIFACT_FORMAT && isObj(raw.record)) {
    return { ok: true, format: 'run-artifact', runs: [raw.record], sessions: [], library: [], lostFields: {} };
  }
  if (format === 'jev-run@1' || format === 'jev-session@1') {
    return { ok: false, error: 'é um record JEV: abra em Histórico → JEV → «Importar do terminal».' };
  }
  if (typeof format === 'string' && /^(arena-config|prompt-builder-pack|ai-benchmark-pack|jev-config)@/u.test(format)) {
    return { ok: false, error: `é uma configuração/pacote de cenários (\`${format}\`): abra em Nova run → «Importar JSON».` };
  }
  if (Array.isArray(raw.stages) && Array.isArray(raw.contestants)) {
    return { ok: true, format: 'record', runs: [raw], sessions: [], library: [], lostFields: {} };
  }
  if (Array.isArray(raw.runIds) && Array.isArray(raw.bestPromptByIteration)) {
    return { ok: true, format: 'record', runs: [], sessions: [raw], library: [], lostFields: {} };
  }
  return {
    ok: false,
    error: `formato ${typeof format === 'string' ? `\`${format}\`` : 'não reconhecido'} — esperado ${EXCHANGE_FORMAT} (ou o JSON de uma run/sessão).`,
  };
}

/**
 * Lê os arquivos escolhidos. Com `manifest.json` (ou `.jsonl`) entre eles é o
 * DIRETÓRIO de um pacote exchange@1; senão cada arquivo é um JSON avulso e os
 * pacotes se somam. Um arquivo inválido recusa tudo (nada é gravado pela metade).
 */
export function readRecordPackage(files: readonly { name: string; text: string }[]): RecordPackageRead {
  if (files.length === 0) return { ok: false, error: 'nenhum arquivo.' };
  const ehDiretorio = files.some((f) => baseName(f.name) === EXCHANGE_MANIFEST_FILE || /\.jsonl$/iu.test(f.name));
  if (ehDiretorio) {
    const mapa: Record<string, string> = {};
    for (const f of files) mapa[baseName(f.name)] = f.text;
    const p = parseExchangeBundle(mapa);
    return p.ok
      ? { ok: true, format: 'exchange', runs: p.runs, sessions: p.sessions, library: p.library, lostFields: p.lostFields }
      : { ok: false, error: `pacote ${EXCHANGE_FORMAT} inválido: ${p.error}` };
  }
  const total: RecordPackage = { format: 'record', runs: [], sessions: [], library: [], lostFields: {} };
  const formatos = new Set<RecordPackage['format']>();
  for (const f of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(f.text);
    } catch {
      return { ok: false, error: `${baseName(f.name)}: não é JSON válido.` };
    }
    const r = lerJson(raw);
    if (!r.ok) return { ok: false, error: `${baseName(f.name)}: ${r.error}` };
    formatos.add(r.format);
    total.runs.push(...r.runs);
    total.sessions.push(...r.sessions);
    total.library.push(...r.library);
    for (const [k, campos] of Object.entries(r.lostFields) as [ExchangeKind, string[]][]) {
      total.lostFields[k] = [...new Set([...(total.lostFields[k] ?? []), ...campos])];
    }
  }
  total.format = formatos.has('exchange') ? 'exchange' : formatos.has('run-artifact') ? 'run-artifact' : 'record';
  return { ok: true, ...total };
}

/**
 * Forma mínima de um record importável (o resto vai verbatim). `null` = ok.
 * As MESMAS regras do `problemaDeForma` do CLI (`src/cli/records.ts`):
 * reimportar no terminal o que a SPA aceitou não pode falhar.
 */
export function recordShapeProblem(kind: RecordKind, r: unknown): string | null {
  if (!isObj(r)) return 'não é um objeto';
  if (typeof r.id !== 'string' || !RECORD_ID_RE.test(r.id)) return 'id ausente ou fora do formato';
  if (typeof r.status !== 'string') return 'status ausente';
  if (typeof r.startedAt !== 'string') return 'startedAt ausente';
  if (!isObj(r.config)) return 'config ausente';
  if (kind === 'run' && (!Array.isArray(r.stages) || !Array.isArray(r.contestants))) return 'stages/contestants ausentes';
  if (kind === 'session' && (!Array.isArray(r.runIds) || !Array.isArray(r.bestPromptByIteration))) {
    return 'runIds/bestPromptByIteration ausentes';
  }
  // Record 'running' importado viraria órfão na próxima varredura desta aba.
  if (r.status === 'running') return "status 'running' (exporte depois de a execução terminar)";
  return null;
}

// ---------------------------------------------------------------------------
// Import — gravação
// ---------------------------------------------------------------------------

export interface RecordImportResult {
  format: RecordPackage['format'];
  imported: { runs: string[]; sessions: string[] };
  /** Mesmo id, mesmo conteúdo: nada a fazer. */
  skipped: string[];
  /** Conflitos substituídos (só com `overwrite`). */
  overwritten: string[];
  /** O navegador não gravou (cota/bloqueio) — o resto entrou. */
  failed: string[];
  /** Perda DECLARADA na origem (manifesto do pacote). */
  lostFields: Partial<Record<ExchangeKind, string[]>>;
  /** Itens de biblioteca (LibraryItem) — a SPA não tem essa biblioteca. */
  libraryItemsIgnored: number;
}

/** Recusa do import (nada foi gravado). Reconheça por `isRecordImportError`, nunca `instanceof`. */
export class RecordImportError extends Error {
  readonly code = 'records.import' as const;
  constructor(
    message: string,
    readonly problems: string[] = [],
    /** Mesmo id com OUTRO conteúdo: repetir com `overwrite` substitui. */
    readonly conflicts: Array<{ kind: RecordKind; id: string }> = [],
  ) {
    super(message);
    this.name = 'RecordImportError';
  }
}

export function isRecordImportError(err: unknown): err is RecordImportError {
  return isObj(err) && (err as { code?: unknown }).code === 'records.import';
}

/**
 * Importa runs/sessões para o IndexedDB desta aba. Valida TUDO antes de
 * gravar; conflito sem `overwrite` recusa com a lista (a UI pergunta e
 * repete). Grava o record como veio (sem `importedAt` antigo nem credenciais)
 * + `importedAt` novo.
 */
export async function importRecordFiles(
  files: readonly { name: string; text: string }[],
  opts: { overwrite?: boolean; now?: () => string } = {},
): Promise<RecordImportResult> {
  const pacote = readRecordPackage(files);
  if (!pacote.ok) throw new RecordImportError(pacote.error);

  const brutos: Array<{ kind: RecordKind; record: Obj }> = [
    ...pacote.runs.map((r) => ({ kind: 'run' as const, record: r as Obj })),
    ...pacote.sessions.map((r) => ({ kind: 'session' as const, record: r as Obj })),
  ];
  if (brutos.length === 0 && pacote.library.length === 0) throw new RecordImportError('o pacote não tem run nem sessão.');
  // Um id só pode aparecer UMA vez por pacote: duas versões com conteúdo
  // diferente são ambíguas (qual delas?), e o 2º sobrescreveria o 1º em
  // silêncio; duplicado IDÊNTICO é o mesmo registro duas vezes — fica a 1ª.
  const hashPorId = new Map<string, string>();
  const entradas: typeof brutos = [];
  const ambiguidades: string[] = [];
  for (const e of brutos) {
    const chave = typeof e.record?.id === 'string' ? `${e.kind}:${e.record.id}` : '';
    const h = chave ? contentHash(semDadosLocais(e.record)) : '';
    const h0 = chave ? hashPorId.get(chave) : undefined;
    if (h0 !== undefined) {
      if (h0 !== h) {
        ambiguidades.push(
          `${e.kind === 'run' ? 'run' : 'sessão'} (${String(e.record.id)}): aparece DUAS vezes no pacote com conteúdo diferente`,
        );
      }
      continue;
    }
    if (chave) hashPorId.set(chave, h);
    entradas.push(e);
  }
  const problemas: string[] = [...ambiguidades];
  entradas.forEach((e, i) => {
    const p = recordShapeProblem(e.kind, e.record);
    const rotulo = `${e.kind === 'run' ? 'run' : 'sessão'} #${i + 1}${typeof e.record?.id === 'string' ? ` (${e.record.id})` : ''}`;
    if (p) problemas.push(`${rotulo}: ${p}`);
    else if (isHeldHere(e.kind, e.record.id as string)) problemas.push(`${rotulo}: está executando nesta aba`);
  });
  if (problemas.length > 0) {
    throw new RecordImportError(
      `Pacote recusado — nada foi gravado: ${problemas.slice(0, 3).join('; ')}${problemas.length > 3 ? ` (+${problemas.length - 3})` : ''}.`,
      problemas,
    );
  }

  const plano: Array<{ kind: RecordKind; record: Obj; acao: 'novo' | 'identico' | 'conflito' }> = [];
  for (const e of entradas) {
    const atual = await idbGet<Obj>(e.kind === 'run' ? 'runs' : 'sessions', e.record.id as string);
    const acao = !atual
      ? 'novo'
      : contentHash(semDadosLocais(atual)) === contentHash(semDadosLocais(e.record))
        ? 'identico'
        : 'conflito';
    plano.push({ ...e, acao });
  }
  const conflitos = plano.filter((p) => p.acao === 'conflito');
  if (conflitos.length > 0 && !opts.overwrite) {
    throw new RecordImportError(
      `${conflitos.length} registro(s) do pacote já existem neste navegador com OUTRO conteúdo — nada foi gravado.`,
      [],
      conflitos.map((c) => ({ kind: c.kind, id: c.record.id as string })),
    );
  }

  const res: RecordImportResult = {
    format: pacote.format,
    imported: { runs: [], sessions: [] },
    skipped: [],
    overwritten: [],
    failed: [],
    lostFields: pacote.lostFields,
    libraryItemsIgnored: pacote.library.length,
  };
  const agora = (opts.now ?? (() => new Date().toISOString()))();
  for (const p of plano) {
    const id = p.record.id as string;
    if (p.acao === 'identico') {
      res.skipped.push(id);
      continue;
    }
    // Sem dados locais + `importedAt` (o TTL conta da importação). Object.assign:
    // o campo desconhecido do pacote sobrevive (só `importedAt` e credenciais
    // são removidos) — nada de reconstruir o record.
    const gravado = Object.assign({}, semDadosLocais(p.record), { importedAt: agora });
    const ok = p.kind === 'run' ? await saveRun(gravado as never) : await saveSession(gravado as never);
    if (!ok) {
      res.failed.push(id);
      continue;
    }
    res.imported[p.kind === 'run' ? 'runs' : 'sessions'].push(id);
    if (p.acao === 'conflito') res.overwritten.push(id);
  }
  return res;
}
