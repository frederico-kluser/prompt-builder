// Modo JEV — a TROCA entre a aba e o terminal (a UI é desenhada para os dois
// caminhos). O caminho principal é o motor NA ABA: o endpoint de decisões
// da OpenRouter tem CORS aberto (preflight 204, `Access-Control-Allow-Origin: *`,
// `X-Generation-Id`/`X-Provider-Name` expostos). Quando a aba NÃO alcança o
// endpoint (rede corporativa, bloqueador, extensão, um CORS que feche no
// futuro), o MESMO `jev-config@1` exportado aqui roda no terminal
// (`prompt-builder jev run -c`) e o record volta para a SPA por arquivo, e as
// mesmas telas o mostram. Por isso não há rota `/v1/jev` no backend: produção
// é SPA estática, e o CLI é o "backend local" do modo.
//
// Tudo aqui é PURO (sem IndexedDB e sem rede): `importJevRecordFiles`
// (`./api`) grava o que estas funções aceitarem.

import type { JevRunRecord, JevSessionRecord } from '../engine/jev';

/** Mesmo formato de `RECORD_ID_RE` (`src/pathSafety.ts`, só Node): o id vira rota e chave. */
const RECORD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type JevRecordFile =
  | { ok: true; kind: 'run'; record: JevRunRecord }
  | { ok: true; kind: 'session'; record: JevSessionRecord }
  | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function faltando(o: Record<string, unknown>, campos: readonly (readonly [string, 'array' | 'object' | 'string'])[]): string | null {
  for (const [k, t] of campos) {
    const v = o[k];
    const ok = t === 'array' ? Array.isArray(v) : t === 'object' ? isObj(v) : typeof v === 'string';
    if (!ok) return k;
  }
  return null;
}

const RUN_FIELDS = [
  ['id', 'string'],
  ['status', 'string'],
  ['mode', 'string'],
  ['startedAt', 'string'],
  ['contestants', 'array'],
  ['cases', 'array'],
  ['cells', 'array'],
  ['questionIds', 'array'],
  ['specs', 'array'],
  ['metrics', 'object'],
  ['config', 'object'],
  ['progress', 'object'],
] as const;

const SESSION_FIELDS = [
  ['id', 'string'],
  ['status', 'string'],
  ['startedAt', 'string'],
  ['iterations', 'array'],
  ['runIds', 'array'],
  ['originalSpec', 'object'],
  ['championSpec', 'object'],
  ['config', 'object'],
] as const;

/**
 * Lê um arquivo vindo do terminal. Aceita:
 *  • o record cru (`~/.prompt-builder/jev-runs/<id>.json` ou `jev-sessions/<id>.json`);
 *  • o envelope `prompt-builder jev show <id> --full --json` (`{ok, data:{kind, record}}`).
 * O resumo (`jev show` sem `--full`) é recusado com a dica, porque não tem células.
 * Record ainda `running` também é recusado: o dono é o processo do terminal, e
 * importar uma foto do meio faria a varredura de órfãs desta aba marcá-la como interrompida.
 */
export function parseJevRecordFile(text: string): JevRecordFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'não é JSON válido.' };
  }
  let raw: unknown = json;
  if (isObj(json) && isObj(json.data) && 'ok' in json) {
    const data = json.data;
    if (isObj(data.record)) raw = data.record;
    else if (data.kind === 'jev-run' || data.kind === 'jev-session' || 'runId' in data || 'sessionId' in data) {
      return { ok: false, error: 'é o RESUMO do `jev show` (sem células). Exporte com `prompt-builder jev show <id> --full --json` ou use o arquivo de `~/.prompt-builder/jev-runs/`.' };
    }
  }
  if (!isObj(raw)) return { ok: false, error: 'não é um record JEV (esperado `jev-run@1` ou `jev-session@1`).' };
  const format = raw.format;
  if (format !== 'jev-run@1' && format !== 'jev-session@1') {
    if (raw.format === 'jev-config@1') return { ok: false, error: 'é uma CONFIGURAÇÃO (`jev-config@1`): abra em "Nova run → JEV → Importar JSON".' };
    return { ok: false, error: `formato ${typeof format === 'string' ? `\`${format}\`` : 'ausente'} — esperado \`jev-run@1\` ou \`jev-session@1\`.` };
  }
  const falta = faltando(raw, format === 'jev-run@1' ? RUN_FIELDS : SESSION_FIELDS);
  if (falta) return { ok: false, error: `record incompleto: falta \`${falta}\`.` };
  if (!RECORD_ID_RE.test(raw.id as string)) return { ok: false, error: `id inválido: \`${String(raw.id).slice(0, 40)}\`.` };
  if (raw.status === 'running') {
    return { ok: false, error: 'o record ainda está `running` no terminal: importe quando a run terminar (`prompt-builder runs wait` / `jev show`).' };
  }
  return format === 'jev-run@1'
    ? { ok: true, kind: 'run', record: raw as unknown as JevRunRecord }
    : { ok: true, kind: 'session', record: raw as unknown as JevSessionRecord };
}

// ---------------------------------------------------------------------------
// Diagnóstico de rede: a aba não alcançou o endpoint de decisões
// ---------------------------------------------------------------------------

/**
 * Mensagens com que cada runtime rejeita um `fetch` que nem chegou a ter
 * resposta (CORS recusado, DNS, offline, bloqueador): Chromium, Firefox,
 * Safari, Node/undici. O navegador NÃO diz qual foi — de propósito — então a
 * tela oferece as causas prováveis e o caminho pelo terminal.
 */
const NETWORK_RE = /failed to fetch|networkerror when attempting to fetch|load failed|network request failed|fetch failed/i;

export function isNetworkFailureMessage(message: string | undefined): boolean {
  return typeof message === 'string' && NETWORK_RE.test(message);
}

export interface JevNetworkDiagnosis {
  /** Células sem resposta por falha de rede (nenhum HTTP voltou). */
  failed: number;
  /** Células que tentaram falar com a API (ok + invalid + error + blocked). */
  attempted: number;
  /** true = nenhuma célula teve resposta: o endpoint ficou inalcançável desta aba. */
  total: boolean;
}

/** `null` = nenhuma falha de rede (o banner não aparece). */
export function networkDiagnosis(run: Pick<JevRunRecord, 'cells'>): JevNetworkDiagnosis | null {
  let failed = 0;
  let attempted = 0;
  let respondidas = 0;
  for (const c of run.cells) {
    if (c.status === 'skipped') continue;
    attempted++;
    if (c.status === 'error' && isNetworkFailureMessage(c.error?.message)) failed++;
    if (c.status === 'ok' || c.status === 'invalid') respondidas++;
  }
  if (failed === 0) return null;
  return { failed, attempted, total: respondidas === 0 };
}
