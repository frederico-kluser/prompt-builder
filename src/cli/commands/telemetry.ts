// IMPL-120 (R-01b:REC-8) — telemetria OPT-IN com contadores locais estilo Go,
// allowlist de eventos versionada e publicada, e upload SEM id persistente.
//
// Princípios (do contrato do item):
//   - default DESLIGADO: sem `PROMPT_BUILDER_TELEMETRY=on` não existe contagem
//     exportada e ZERO requisições saem — proxy/strace vê silêncio;
//   - nunca ativo em CI/agente (`CI`/`CLAUDECODE`) salvo opt-in EXPLÍCITO — o
//     próprio `PROMPT_BUILDER_TELEMETRY=on` é esse opt-in; não há ativação por
//     config herdado, e qualquer caminho futuro de ativação tem de continuar a
//     respeitar esta guarda;
//   - SEM id persistente: o payload não carrega identificador de utilizador,
//     máquina, instalação nem sessão — só contagens agregadas por evento;
//   - schema PÚBLICO (`TELEMETRY_PAYLOAD_SCHEMA`): o payload é 1:1 com ele
//     (teste snapshot em test/telemetry-optin.test.ts); a publicação do lado do
//     servidor obedece a `TELEMETRY_PUBLICATION_POLICY` (retenção 90 dias,
//     células só com k >= 20) — política do receptor, versionada aqui;
//   - allowlist versionada: evento fora de `TELEMETRY_ALLOWLIST` NUNCA entra no
//     payload (nem é engolido em silêncio — fica em `droppedUnknown`, auditável).
//
// Em paralelo (R-01b:REC-9): a flag `PROMPT_BUILDER_NO_ATTRIBUTION` suprime os
// headers de atribuição HTTP-Referer / X-Title — DADO partilhado com o
// OpenRouter (terceiro). A flag vale NO FIO: `src/gatewayEnv.ts` a traduz em
// `GatewayConfig.attribution: false` e o gateway (`src/openrouter.ts`
// `headers()`) deixa de enviar os dois; na SPA a mesma supressão é a
// preferência `pb.noAttribution` do shim `web/src/engine/openrouter.ts`. A
// fonte única da leitura da variável é `isAttributionSuppressedEnv`
// (gatewayEnv); este módulo re-exporta. Documentada em `--help` (AMBIENTE),
// `telemetry --help` e `docs troubleshooting`.
//
// Funis que os contadores medem (os que a auditoria achou invisíveis), cada um
// com UM gancho no CLI:
//   - `docs.list`           → `cmdDocs` (knowledge.ts), `docs --list`/`docs`;
//   - `runs.export`         → `cmdRuns export` (misc.ts);
//   - `run.first_completed` → run/sessão recém-terminada NESTE processo
//     (`recordRunCompletedTelemetry`, run.ts) — uma vez por data dir, só se
//     nenhuma OUTRA run concluída existe ali;
//   - `budget.exhausted`    → saída 7 do processo (`recordExitTelemetry`,
//     index.ts), fora das releituras (`runs wait`/`sessions …` relatam a run
//     de outro processo — contar ali duplicaria o `--detach`).
// Todos são NO-OP sem o opt-in (nada contado, nada lido nem gravado, zero
// requisições). `TELEMETRY_FUNNEL_HOOKS_WIRED` diz se há gancho ligado — o
// teste confere a flag contra o código.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, EXIT } from '../output.js';
import { buildContext, parse } from '../context.js';
import { isAttributionSuppressedEnv } from '../../gatewayEnv.js';
import { listRuns } from '../../storage.js';

// ---------------------------------------------------------------------------
// Allowlist versionada e publicada (o schema sobe de versão junto)
// ---------------------------------------------------------------------------

/** Identidade do schema do payload (sobe junto com `TELEMETRY_SCHEMA_VERSION`). */
export const TELEMETRY_SCHEMA_ID = 'prompt-builder-telemetry@1';
export const TELEMETRY_SCHEMA_VERSION = 1;

/** Eventos contáveis — SÓ estes entram no payload (allowlist versionada). */
export const TELEMETRY_EVENT_NAMES = [
  'docs.list',
  'run.first_completed',
  'budget.exhausted',
  'runs.export',
] as const;
export type TelemetryEvent = (typeof TELEMETRY_EVENT_NAMES)[number];

export interface TelemetryEventDef {
  name: TelemetryEvent;
  /** O que o evento significa — o mesmo texto publica a allowlist. */
  description: string;
}

export const TELEMETRY_ALLOWLIST: readonly TelemetryEventDef[] = [
  { name: 'docs.list', description: 'comando `docs --list` executado (descoberta da doc embarcada)' },
  { name: 'run.first_completed', description: 'primeira run concluída desta instalação (funil de ativação)' },
  { name: 'budget.exhausted', description: 'saída 7 — parcial por orçamento esgotado' },
  { name: 'runs.export', description: 'comando `runs export` executado (artefato auto-contido)' },
];

/**
 * Política de PUBLICAÇÃO do lado do servidor (retenção e corte de células).
 * Versionada aqui para o consumidor saber o que o agregado promete.
 */
export const TELEMETRY_PUBLICATION_POLICY = {
  /** Dias de retenção do agregado publicado. */
  retentionDays: 90,
  /** Célula só é publicada com k >= 20 respostas (nunca rastro individual). */
  minCellCount: 20,
} as const;

/** Schema PÚBLICO do payload de upload (1:1 com {@link TelemetryPayload}). */
export const TELEMETRY_PAYLOAD_SCHEMA = {
  $id: `urn:prompt-builder:schema:${TELEMETRY_SCHEMA_ID}`,
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'schemaVersion', 'sentAt', 'appVersion', 'counters'],
  properties: {
    schema: { const: TELEMETRY_SCHEMA_ID },
    schemaVersion: { type: 'integer', const: TELEMETRY_SCHEMA_VERSION },
    sentAt: { type: 'string', format: 'date-time' },
    appVersion: { type: 'string' },
    counters: {
      type: 'object',
      additionalProperties: false,
      description: `contagem por evento da allowlist (${TELEMETRY_EVENT_NAMES.join(', ')})`,
    },
  },
  'x-no-persistent-id': true,
  'x-publication': { ...TELEMETRY_PUBLICATION_POLICY },
} as const;

// ---------------------------------------------------------------------------
// Contadores locais (estilo Go: agregado em memória, sem identificador)
// ---------------------------------------------------------------------------

/** Contadores locais por evento. Nada aqui identifica utilizador/máquina/sessão. */
export class TelemetryCounters {
  private readonly counts = new Map<TelemetryEvent, number>();
  /** Evento fora da allowlist: contado À PARTE (auditável), nunca engolido nem enviado. */
  private readonly unknown = new Map<string, number>();

  /** Soma 1 ao evento. `false` = evento fora da allowlist (registado em `droppedUnknown`). */
  record(event: string, delta = 1): boolean {
    if (!(TELEMETRY_EVENT_NAMES as readonly string[]).includes(event)) {
      this.unknown.set(event, (this.unknown.get(event) ?? 0) + delta);
      return false;
    }
    const e = event as TelemetryEvent;
    this.counts.set(e, (this.counts.get(e) ?? 0) + delta);
    return true;
  }

  /** Só o que a allowlist aceita — a forma exata que vai no payload. */
  snapshot(): Record<TelemetryEvent, number> {
    const out = Object.fromEntries(TELEMETRY_EVENT_NAMES.map((n) => [n, 0])) as Record<TelemetryEvent, number>;
    for (const [k, v] of this.counts) out[k] = v;
    return out;
  }

  /** Contagens recusadas por não estarem na allowlist (auditoria de "campo novo"). */
  get droppedUnknown(): Record<string, number> {
    return Object.fromEntries(this.unknown);
  }

  reset(): void {
    this.counts.clear();
    this.unknown.clear();
  }

  /** Persistência local (JSON por caminho injetado — nunca process.cwd()). */
  save(file: string): void {
    writeFileSync(file, `${JSON.stringify({ counters: this.snapshot(), droppedUnknown: this.droppedUnknown }, null, 2)}\n`, 'utf-8');
  }

  load(file: string): void {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as {
        counters?: Record<string, number>;
        droppedUnknown?: Record<string, number>;
      };
      for (const [k, v] of Object.entries(raw.counters ?? {})) if (typeof v === 'number') this.record(k, v);
      for (const [k, v] of Object.entries(raw.droppedUnknown ?? {})) if (typeof v === 'number') this.record(k, v);
    } catch {
      // Arquivo ausente/corrompido: contadores começam do zero (nunca derruba o CLI).
    }
  }
}

/** Instância de processo — os comandos do CLI registam aqui. */
export const telemetryCounters = new TelemetryCounters();

// ---------------------------------------------------------------------------
// Opt-in / guarda de CI / transporte
// ---------------------------------------------------------------------------

/** Env vars públicas da telemetria e da atribuição (documentadas no help). */
export const TELEMETRY_ENV = {
  /** `on` = opt-in explícito de telemetria. Default: DESLIGADO. */
  optIn: 'PROMPT_BUILDER_TELEMETRY',
  /** Endpoint de upload (sem endpoint não há upload, mesmo com opt-in). */
  url: 'PROMPT_BUILDER_TELEMETRY_URL',
  /** `on` = suprime HTTP-Referer / X-Title / X-OpenRouter-Categories (R-01b:REC-9). */
  noAttribution: 'PROMPT_BUILDER_NO_ATTRIBUTION',
} as const;

type Env = Record<string, string | undefined>;

function flagAtiva(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true' || v === 'yes';
}

/** Ambiente de CI/agente — onde a telemetria nunca liga sem opt-in explícito. */
export function isAgentOrCiEnv(env: Env = process.env): boolean {
  return flagAtiva(env.CI) || flagAtiva(env.CLAUDECODE);
}

/** Opt-in explícito (`PROMPT_BUILDER_TELEMETRY=on`). Default: DESLIGADO. */
export function isTelemetryOptIn(env: Env = process.env): boolean {
  return flagAtiva(env[TELEMETRY_ENV.optIn]);
}

/**
 * Telemetria ligada? Só com opt-in explícito — em CI/agente inclusive: sem a
 * variável (ou com outro valor) não há contagem exportada nem requisição.
 */
export function isTelemetryEnabled(env: Env = process.env): boolean {
  return isTelemetryOptIn(env);
}

/** Endpoint de upload (`PROMPT_BUILDER_TELEMETRY_URL`); ausente = sem upload. */
export function telemetryEndpoint(env: Env = process.env): string | null {
  const url = (env[TELEMETRY_ENV.url] ?? '').trim();
  return url ? url : null;
}

/** Upload permitido = opt-in + endpoint declarado. Sem endpoint, nada sai. */
export function isTelemetryUploadEnabled(env: Env = process.env): boolean {
  return isTelemetryEnabled(env) && telemetryEndpoint(env) !== null;
}

/** Payload de upload: SEM id persistente (nem utilizador, nem máquina, nem sessão). */
export interface TelemetryPayload {
  schema: typeof TELEMETRY_SCHEMA_ID;
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  sentAt: string;
  appVersion: string;
  counters: Record<TelemetryEvent, number>;
}

/** Monta o payload 1:1 com {@link TELEMETRY_PAYLOAD_SCHEMA} (só eventos da allowlist). */
export function buildTelemetryPayload(
  counters: TelemetryCounters | Record<TelemetryEvent, number>,
  opts: { appVersion: string; now?: Date },
): TelemetryPayload {
  const snapshot = counters instanceof TelemetryCounters ? counters.snapshot() : counters;
  const limpo: Record<TelemetryEvent, number> = Object.fromEntries(
    TELEMETRY_EVENT_NAMES.filter((n) => typeof snapshot[n] === 'number').map((n) => [n, snapshot[n]]),
  ) as Record<TelemetryEvent, number>;
  return {
    schema: TELEMETRY_SCHEMA_ID,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    sentAt: (opts.now ?? new Date()).toISOString(),
    appVersion: opts.appVersion,
    counters: limpo,
  };
}

export type TelemetryFetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TelemetryUploadResult {
  sent: boolean;
  /** Por que não enviou (nunca some em silêncio). */
  reason?: 'disabled' | 'no-endpoint' | 'http-error';
  status?: number;
}

/**
 * POST do payload para o endpoint opt-in. Com telemetria desligada (default) NÃO
 * CHAMA fetch nenhum (0 requisições — o critério do proxy/strace). `fetch` é
 * injetável para os testes provarem o contrato sem rede.
 */
export async function uploadTelemetry(
  payload: TelemetryPayload,
  opts: { env?: Env; fetch?: TelemetryFetchLike } = {},
): Promise<TelemetryUploadResult> {
  const env = opts.env ?? process.env;
  if (!isTelemetryEnabled(env)) return { sent: false, reason: 'disabled' };
  const url = telemetryEndpoint(env);
  if (!url) return { sent: false, reason: 'no-endpoint' };
  const doFetch: TelemetryFetchLike = opts.fetch ?? ((u, init) => fetch(u, init));
  const r = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.ok ? { sent: true, status: r.status } : { sent: false, reason: 'http-error', status: r.status };
}

// ---------------------------------------------------------------------------
// Atribuição (R-01b:REC-9): dado partilhado com o OpenRouter + flag de supressão
// ---------------------------------------------------------------------------

/**
 * Headers de atribuição que vão no FIO para o OpenRouter (terceiro): são DADO
 * partilhado — não metadados inocentes. `X-OpenRouter-Categories` é o único que
 * não viaja hoje; a lista fecha o contrato da flag para quem o ligar.
 */
export const ATTRIBUTION_HEADER_NAMES = ['HTTP-Referer', 'X-Title', 'X-OpenRouter-Categories'] as const;

/** `PROMPT_BUILDER_NO_ATTRIBUTION=on` suprime TODOS os headers de atribuição (fonte: gatewayEnv). */
export function isAttributionSuppressed(env: Env = process.env): boolean {
  return isAttributionSuppressedEnv(env);
}

/**
 * Forma canónica dos headers de atribuição: suprimidos = objeto VAZIO (nenhum
 * header é enviado). O gateway aplica a MESMA regra no fio pela config
 * (`attribution: false` — ver `gatewayConfigFromEnv`); esta função é o
 * contrato de referência que o teste confere contra o gateway.
 */
export function attributionHeadersFor(
  opts: { appUrl?: string; appTitle?: string; categories?: string },
  env: Env = process.env,
): Record<string, string> {
  if (isAttributionSuppressed(env)) return {};
  const out: Record<string, string> = {};
  if (opts.appUrl) out['HTTP-Referer'] = opts.appUrl;
  if (opts.appTitle) out['X-Title'] = opts.appTitle;
  if (opts.categories) out['X-OpenRouter-Categories'] = opts.categories;
  return out;
}

/** Arquivo dos contadores locais (só existe com opt-in). */
export const TELEMETRY_COUNTERS_FILE = 'telemetry-counters.json';

/**
 * Os comandos do CLI já chamam os ganchos dos funis da allowlist? SIM (IMPL-120):
 * docs --list, runs export, 1ª run concluída e saída 7. Com opt-in os contadores
 * medem; sem ele nada é contado. `test/telemetry-optin.test.ts` confere a flag
 * contra o código.
 */
export const TELEMETRY_FUNNEL_HOOKS_WIRED = true;

/**
 * Conta UM evento de funil — NO-OP sem opt-in explícito (default): nada é
 * contado, nada é gravado, nenhuma requisição sai. Com opt-in, soma no
 * contador de processo e persiste em `<dataDir>/telemetry-counters.json`.
 * Nunca derruba o comando (falha de disco = contador perdido).
 */
export function recordTelemetryEvent(event: TelemetryEvent, dataDir: string, env: Env = process.env): boolean {
  if (!isTelemetryEnabled(env)) return false;
  const file = join(dataDir, TELEMETRY_COUNTERS_FILE);
  try {
    // O data dir pode ainda não existir (1º comando da instalação é `docs`):
    // sem o mkdir o contador se perderia calado no ENOENT.
    mkdirSync(dataDir, { recursive: true });
    const persistido = new TelemetryCounters();
    persistido.load(file);
    persistido.record(event);
    persistido.save(file);
  } catch {
    // contador é best-effort
  }
  return telemetryCounters.record(event);
}

/**
 * Comandos que só RELEEM o desfecho de uma run de outro processo (`runs wait`
 * de um `--detach`, `sessions show`…): a saída 7 deles não é um orçamento
 * esgotado novo — contar ali duplicaria o evento do processo que gastou.
 */
const READBACK_COMMANDS: ReadonlySet<string> = new Set(['runs', 'sessions']);

/** Evento de funil de uma saída do processo (`null` = saída sem funil). */
export function telemetryEventForExit(command: string | undefined, code: unknown): TelemetryEvent | null {
  if (code !== EXIT.BUDGET) return null;
  if (command !== undefined && READBACK_COMMANDS.has(command)) return null;
  return 'budget.exhausted';
}

/**
 * Gancho ÚNICO da saída do processo (index.ts, depois do dispatch): saída 7 =
 * `budget.exhausted`, venha do `runOutcome`, da sessão, do modo agente ou do
 * teto diário. NO-OP sem opt-in; nunca lança.
 */
export function recordExitTelemetry(
  command: string | undefined,
  code: unknown,
  dataDir: string,
  env: Env = process.env,
): boolean {
  const evento = telemetryEventForExit(command, code);
  return evento ? recordTelemetryEvent(evento, dataDir, env) : false;
}

/** Status em que a run chegou ao FIM do pipeline (o funil de ativação conta estes). */
const CONCLUDED_STATUSES: ReadonlySet<string> = new Set(['finished', 'inconclusive']);

/** O mínimo de um resumo de run que o funil lê (o `RunSummary` do storage serve). */
export interface TelemetryRunLike {
  id: string;
  status: string;
  sessionId?: string;
}

/**
 * Funil de ativação: `run.first_completed` conta UMA vez por instalação (data
 * dir), quando a run/sessão que acabou de terminar NESTE processo é a
 * primeira concluída dali — nenhuma OUTRA run concluída existe no data dir
 * (as iterações da própria sessão não contam como "outra"). Quem já tinha
 * runs antes do opt-in nunca conta: não foi medido, e o contador não inventa.
 *
 * NO-OP sem opt-in: nem o disco é lido. Nunca lança (best-effort).
 */
export async function recordRunCompletedTelemetry(
  current: { runId?: string; sessionId?: string; status: string },
  dataDir: string,
  env: Env = process.env,
  listPrior: () => Promise<TelemetryRunLike[]> = listRuns,
): Promise<boolean> {
  if (!isTelemetryEnabled(env)) return false;
  if (!CONCLUDED_STATUSES.has(current.status)) return false;
  try {
    const persistido = new TelemetryCounters();
    persistido.load(join(dataDir, TELEMETRY_COUNTERS_FILE));
    if (persistido.snapshot()['run.first_completed'] > 0) return false;
    const outra = (await listPrior()).some(
      (r) =>
        CONCLUDED_STATUSES.has(r.status) &&
        r.id !== current.runId &&
        !(current.sessionId !== undefined && r.sessionId === current.sessionId),
    );
    if (outra) return false;
  } catch {
    return false;
  }
  return recordTelemetryEvent('run.first_completed', dataDir, env);
}

// ---------------------------------------------------------------------------
// Comando `telemetry`
// ---------------------------------------------------------------------------

/**
 * `prompt-builder telemetry [status|schema|counters]` — o estado do opt-in, o
 * schema PUBLICADO e os contadores locais. stdout = payload, stderr = narração
 * (contrato de saída da casa).
 */
export async function cmdTelemetry(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'status';
  const parsed = parse(sub === argv[0] ? argv.slice(1) : argv, {});
  const ctx = buildContext(parsed);
  const { out } = ctx;
  const env = process.env;

  if (sub === 'schema') {
    out.result(true, 'telemetry.schema', {
      schema: TELEMETRY_PAYLOAD_SCHEMA,
      allowlist: TELEMETRY_ALLOWLIST,
      env: TELEMETRY_ENV,
    });
    return EXIT.OK;
  }
  if (sub === 'counters') {
    // Os contadores persistidos (só existem com opt-in) — o de processo nasce vazio.
    const persistido = new TelemetryCounters();
    persistido.load(join(ctx.dataDir, TELEMETRY_COUNTERS_FILE));
    if (!TELEMETRY_FUNNEL_HOOKS_WIRED) {
      out.info('ganchos de funil ainda não ligados: nenhum comando conta eventos hoje (zeros não são medida).');
    } else if (!isTelemetryEnabled(env)) {
      out.info(
        `telemetria desligada: nada é contado (zeros não são medida). ${TELEMETRY_ENV.optIn}=on liga a contagem local.`,
      );
    }
    out.result(true, 'telemetry.counters', {
      enabled: isTelemetryEnabled(env),
      // Honestidade: com `false`, zero é "não medido", não "não aconteceu".
      hooksWired: TELEMETRY_FUNNEL_HOOKS_WIRED,
      counters: persistido.snapshot(),
      droppedUnknown: persistido.droppedUnknown,
    });
    return EXIT.OK;
  }
  if (sub !== 'status') {
    throw new CliError(
      `Subcomando desconhecido: "${sub}". Uso: prompt-builder telemetry <status|schema|counters>.`,
      EXIT.USAGE,
    );
  }
  out.info(
    `Telemetria ${isTelemetryEnabled(env) ? 'LIGADA (opt-in explícito)' : 'DESLIGADA (default)'}. ` +
      `Atribuição (HTTP-Referer/X-Title/X-OpenRouter-Categories — dado enviado ao OpenRouter): ` +
      `${isAttributionSuppressed(env) ? 'SUPRIMIDA por PROMPT_BUILDER_NO_ATTRIBUTION' : 'ativa'}.`,
  );
  out.result(true, 'telemetry.status', {
    enabled: isTelemetryEnabled(env),
    optInEnv: TELEMETRY_ENV.optIn,
    uploadEnabled: isTelemetryUploadEnabled(env),
    endpoint: telemetryEndpoint(env),
    agentOrCi: isAgentOrCiEnv(env),
    attributionSuppressed: isAttributionSuppressed(env),
    attributionHeaders: ATTRIBUTION_HEADER_NAMES,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    publication: TELEMETRY_PUBLICATION_POLICY,
  });
  return EXIT.OK;
}