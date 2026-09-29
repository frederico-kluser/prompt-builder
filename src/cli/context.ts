// Contexto compartilhado por todos os comandos: flags globais, resolucao da
// key, diretorio de dados e catalogo quente.
//
// Sem parser de argumentos externo: `node:util` `parseArgs` resolve tudo. A
// vantagem estrategica de um CLI sobre um servidor MCP e custar ~0 token de
// contexto E abrir rapido; 40 pacotes transitivos de um parser jogariam metade
// disso fora.

import { parseArgs, type ParseArgsConfig } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setDataDir, getDataDir, writePrivateDataFile } from '../storage.js';
import { ensureCatalog } from '../modelsCache.js';
import { validateKey, type KeyInfo } from '../openrouter.js';
import { Output, CliError, DEFAULT_HINT, EXIT, type OutputFormat } from './output.js';
import type { OpenRouterModel } from '../types.js';
import { closestMatch, unknownKeyIssues as unknownKeyIssuesPure, unknownKeysMessage } from '../configKeys.js';

export const GLOBAL_OPTIONS = {
  json: { type: 'boolean' },
  'output-format': { type: 'string' },
  // IMPL-092: o JSON sai compacto por padrão; --pretty formata (2 espaços).
  pretty: { type: 'boolean' },
  'data-dir': { type: 'string' },
  key: { type: 'string' },
  'refresh-models': { type: 'boolean' },
  quiet: { type: 'boolean' },
  verbose: { type: 'boolean' },
  'no-color': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
} as const satisfies NonNullable<ParseArgsConfig['options']>;

export interface ParsedArgs {
  values: Record<string, unknown>;
  positionals: string[];
}

/** parseArgs com mensagem PT-BR (e dica acionavel) em vez do erro cru do Node. */
export function parse(
  args: string[],
  options: NonNullable<ParseArgsConfig['options']>,
): ParsedArgs {
  const all = { ...GLOBAL_OPTIONS, ...options };
  try {
    const r = parseArgs({
      args,
      options: all,
      allowPositionals: true,
      strict: true,
    });
    return { values: r.values as Record<string, unknown>, positionals: r.positionals };
  } catch (err) {
    throw parseErrorToCliError(err, Object.keys(all));
  }
}

// "Você quis dizer" (Levenshtein + prefixo): fonte única em src/configKeys.ts —
// o mesmo critério para flag, comando, subcomando e chave de config.
export { closestMatch } from '../configKeys.js';

/**
 * Erro do `parseArgs` do Node -> CliError com `error.code` estavel, a flag
 * culpada em `details` e uma dica que resolve (sugestao + flags aceitas).
 */
export function parseErrorToCliError(err: unknown, knownFlags: readonly string[]): CliError {
  const e = (typeof err === 'object' && err !== null ? err : {}) as { code?: unknown; message?: unknown };
  const msg = typeof e.message === 'string' ? e.message : String(err);
  const aceitas = [...knownFlags].sort();

  if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const flag = /Unknown option '([^']+)'/.exec(msg)?.[1] ?? '?';
    const nome = flag.replace(/^-+/, '').split('=')[0];
    const sugestao = flag.startsWith('--') ? closestMatch(nome, aceitas) : undefined;
    return new CliError(
      `Flag desconhecida: ${flag}.`,
      EXIT.USAGE,
      { flag, suggestion: sugestao ? `--${sugestao}` : null, acceptedFlags: aceitas.map((f) => `--${f}`) },
      {
        code: 'usage.unknown_flag',
        hint:
          (sugestao ? `Você quis dizer --${sugestao}? ` : '') +
          'As flags deste comando estão em details.acceptedFlags (sob --json) e as globais em ' +
          "`prompt-builder --help`; um argumento que começa com '-' vai depois de `--`.",
      },
    );
  }

  if (e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    const flag = /Option '(?:-\w, )?(--[\w-]+)/.exec(msg)?.[1] ?? null;
    const faltando = /argument missing|ambiguous/.test(msg);
    const semValor = /does not take an argument/.test(msg);
    return new CliError(
      `Valor inválido para ${flag ?? 'uma flag'}: ${msg}`,
      EXIT.USAGE,
      { flag },
      {
        code: 'usage.invalid_flag_value',
        hint: faltando && flag
          ? `${flag} precisa de um valor: \`${flag} <valor>\` (ou \`${flag}=<valor>\` se o valor começa com '-').`
          : semValor && flag
            ? `${flag} é um liga/desliga: passe só \`${flag}\`, sem valor.`
            : DEFAULT_HINT.usage,
      },
    );
  }

  if (e.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') {
    return new CliError(`Argumento inesperado: ${msg}`, EXIT.USAGE, undefined, {
      code: 'usage.unexpected_argument',
    });
  }

  return new CliError(`Argumento inválido: ${msg}`, EXIT.USAGE, undefined, { code: 'usage.invalid_argument' });
}

const OUTPUT_FORMATS: readonly OutputFormat[] = ['text', 'json', 'ndjson'];

export function isOutputFormat(v: unknown): v is OutputFormat {
  return typeof v === 'string' && (OUTPUT_FORMATS as readonly string[]).includes(v);
}

export function resolveFormat(values: Record<string, unknown>): OutputFormat {
  const explicit = values['output-format'];
  if (typeof explicit === 'string') {
    if (!isOutputFormat(explicit)) {
      throw new CliError(
        `--output-format deve ser text, json ou ndjson (recebi "${explicit}").`,
        EXIT.USAGE,
        { flag: '--output-format', value: explicit, accepted: OUTPUT_FORMATS },
        {
          code: 'usage.invalid_output_format',
          hint: 'Use `--output-format text|json|ndjson` (ou só `--json`).',
        },
      );
    }
    return explicit;
  }
  if (values.json === true) return 'json';
  return 'text';
}

/**
 * Formato de saida lido DIRETO do argv, antes do dispatch e de qualquer parse
 * (IMPL-028, Furo 1): sem isso, um erro de parse sob `--json` saia como texto
 * no stderr e o stdout ficava com 0 bytes. Espelha `resolveFormat` sobre o
 * mesmo argv (`--output-format` vence `--json`; ultima ocorrencia vence; tudo
 * depois de `--` e posicional). Valor ausente/invalido em `--output-format` da
 * `json`: quem pediu formato de maquina recebe o erro estruturado mesmo tendo
 * errado o nome do formato.
 */
export function sniffOutputFormat(argv: readonly string[]): OutputFormat {
  let json = false;
  /** undefined = flag ausente; null = presente sem valor utilizavel. */
  let explicit: string | null | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') break;
    if (a === '--json' || a.startsWith('--json=')) {
      json = true;
    } else if (a === '--output-format') {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('-')) {
        explicit = v;
        i += 1;
      } else {
        explicit = null;
      }
    } else if (a.startsWith('--output-format=')) {
      explicit = a.slice('--output-format='.length);
    }
  }
  if (explicit !== undefined) return isOutputFormat(explicit) ? explicit : 'json';
  return json ? 'json' : 'text';
}

/**
 * `--pretty` lido DIRETO do argv (mesma razão do `sniffOutputFormat`: o Output
 * do `main` nasce antes de qualquer parse). Presente = ligado.
 */
export function sniffPretty(argv: readonly string[]): boolean {
  for (const a of argv) {
    if (a === '--') break;
    if (a === '--pretty') return true;
  }
  return false;
}

// --- teto de listas ----------------------------------------------------------

/**
 * Teto DEFAULT de toda lista (IMPL-092, R-12:REC-2). Sem ele, `models list
 * --json` devolvia o catálogo INTEIRO (~594 KB ≈ 150 mil tokens) e saturava o
 * contexto do agente. `--limit <N>` muda o teto; `--all` devolve a lista
 * inteira (decisão explícita); truncar avisa SEMPRE no stderr.
 */
export const DEFAULT_LIST_LIMIT = 50;

export interface ListLimit {
  /** `null` = `--all` (sem teto). */
  limit: number | null;
}

/** Lê `--limit`/`--all` de um comando de lista. `--all` vence `--limit`. */
export function parseListLimit(values: Record<string, unknown>): ListLimit {
  if (values.all === true) return { limit: null };
  const raw = values.limit;
  if (raw === undefined || raw === null || raw === '') return { limit: DEFAULT_LIST_LIMIT };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new CliError(
      `--limit deve ser um inteiro maior que zero (recebi "${String(raw)}").`,
      EXIT.USAGE,
      { flag: '--limit', value: raw },
      {
        code: 'usage.invalid_flag_value',
        hint: 'Use `--limit <N>` (teto de itens) ou `--all` (lista inteira).',
      },
    );
  }
  return { limit: n };
}

/**
 * Aplica o teto e narra o truncamento (stderr — o stdout é payload). O rótulo
 * entra na frase ("modelos", "runs"): "mostrando 50 de 243 runs — use --all…".
 */
export function limitList<T>(rows: T[], cap: ListLimit, out: Output, rotulo: string): T[] {
  if (cap.limit === null || rows.length <= cap.limit) return rows;
  out.warn(
    `mostrando ${cap.limit} de ${rows.length} ${rotulo} — use --all para a lista inteira ` +
      'ou --limit <N> para outro teto.',
  );
  return rows.slice(0, cap.limit);
}

// --- config fail-closed ------------------------------------------------------

/** Comandos com subcomando: o rotulo do envelope vira `runs.show`, `key.check`… */
const FAMILIAS_COM_SUB = new Set(['models', 'key', 'runs', 'sessions', 'library', 'config', 'registry', 'agents', 'limits', 'calib']);

/**
 * Rotulo `command` do envelope de erro, tirado do argv cru (o erro pode nascer
 * antes de qualquer parse). Subcomando so conta se parece um verbo (`show`,
 * `set`) — um id de run no lugar do subcomando nao vira rotulo.
 */
export function commandLabel(argv: readonly string[]): string {
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : undefined;
  if (!cmd) return '?';
  const sub = argv[1];
  if (FAMILIAS_COM_SUB.has(cmd) && sub && /^[a-z]+(?:-[a-z]+)*$/.test(sub)) return `${cmd}.${sub}`;
  return cmd;
}

/** true quando quem chama e um agente/script, nao um humano num terminal. */
export function isAgentContext(): boolean {
  return (
    !process.stdout.isTTY ||
    process.env.CLAUDECODE === '1' ||
    process.env.CI === 'true' ||
    process.env.CI === '1'
  );
}

// --- diretorio de dados ------------------------------------------------------

/**
 * Precedencia: `--data-dir` → `$PROMPT_BUILDER_HOME` → `$XDG_STATE_HOME/...`
 * → `~/.prompt-builder`. Nunca `./data` (que sujaria o repo do usuario).
 */
export function resolveHome(values: Record<string, unknown>): string {
  const flag = values['data-dir'];
  if (typeof flag === 'string' && flag.trim()) return path.resolve(flag.trim());
  if (process.env.PROMPT_BUILDER_HOME) return path.resolve(process.env.PROMPT_BUILDER_HOME);
  if (process.env.XDG_STATE_HOME) return path.join(process.env.XDG_STATE_HOME, 'prompt-builder');
  return path.join(os.homedir(), '.prompt-builder');
}

// --- key ---------------------------------------------------------------------

export function keyFilePath(): string {
  return path.join(getDataDir(), 'key');
}

async function readStoredKey(): Promise<string | null> {
  try {
    const raw = await fs.readFile(keyFilePath(), 'utf-8');
    const k = raw.trim();
    return k.length > 0 ? k : null;
  } catch {
    return null;
  }
}

/**
 * `--key` → `$OPENROUTER_API_KEY` → arquivo salvo por `key set`; `null` quando
 * nao ha key em lugar nenhum. So LE (nada de rede): quem precisa da key para
 * seguir usa `resolveKey`, quem so quer dado publico segue sem ela (IMPL-029).
 */
export async function tryResolveKey(values: Record<string, unknown>): Promise<string | null> {
  const flag = values.key;
  if (typeof flag === 'string' && flag.trim()) return flag.trim();
  if (process.env.OPENROUTER_API_KEY?.trim()) return process.env.OPENROUTER_API_KEY.trim();
  return readStoredKey();
}

/** O erro de key ausente — o mesmo em todo comando (e no `requires` do dry-run). */
export function keyMissingError(): CliError {
  return new CliError(
    'Key do OpenRouter ausente (procurei em --key, OPENROUTER_API_KEY e no arquivo de `key set`).',
    EXIT.AUTH,
    { searched: ['--key', 'OPENROUTER_API_KEY', keyFilePath()] },
    {
      code: 'auth.key_missing',
      hint:
        'Exporte OPENROUTER_API_KEY ou grave a key uma vez com `prompt-builder key set --stdin` ' +
        '(lida da entrada padrão — nunca como argumento). Chaves em https://openrouter.ai/keys.',
    },
  );
}

/** Como `tryResolveKey`, mas key ausente e erro (`auth.key_missing`, exit 4). */
export async function resolveKey(values: Record<string, unknown>): Promise<string> {
  const key = await tryResolveKey(values);
  if (key) return key;
  throw keyMissingError();
}

/**
 * Le e interpreta um arquivo JSON do usuario com os DOIS erros distintos:
 * caminho errado e uso (2, `usage.file_unreadable`); JSON quebrado e config
 * (3, `config.invalid_json`). Antes um `JSON.parse` cru saia como exit 1.
 */
export async function readJsonFile(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    const errno = (err as { code?: unknown }).code;
    throw new CliError(
      `Não consegui ler o arquivo "${file}".`,
      EXIT.USAGE,
      { path: file, errno: typeof errno === 'string' ? errno : null },
      {
        code: 'usage.file_unreadable',
        hint: 'Confira o caminho (relativo ao diretório atual) e as permissões do arquivo.',
      },
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new CliError(
      `"${file}" não é um JSON válido: ${(err as Error).message}`,
      EXIT.CONFIG,
      { path: file },
      { code: 'config.invalid_json' },
    );
  }
}

// --- config fail-closed (IMPL-093, R-12:REC-2) --------------------------------
//
// A comparação árvore LIDA × árvore PARSEADA (e o "você quis dizer" tirado das
// chaves válidas do MESMO objeto) mora em src/configKeys.ts — a API HTTP usa a
// mesma. Aqui fica só a recusa com o envelope do CLI (exit 3).

export {
  CHAVES_LEGADO_ACEITAS,
  unknownKeyIssues,
  type UnknownKeyIssue,
} from '../configKeys.js';

/**
 * Recusa (exit 3) se o config tem chave que o parser descartaria em silêncio —
 * `config validate` e todo `--config` do CLI passam por aqui (fail-closed).
 */
export function assertNoUnknownConfigKeys(raw: unknown, parsed: unknown): void {
  const issues = unknownKeyIssuesPure(raw, parsed);
  if (issues.length === 0) return;
  throw new CliError(
    unknownKeysMessage(issues),
    EXIT.CONFIG,
    { unknownKeys: issues },
    {
      code: 'config.unknown_key',
      hint:
        'Corrija ou remova as chaves acima — provavelmente um typo; `prompt-builder config example` ' +
        'gera um config válido e `prompt-builder config validate <arq>` re-confere.',
    },
  );
}

export async function writeStoredKey(key: string): Promise<string> {
  const target = keyFilePath();
  // IMPL-024: raiz privada + tmp 0600 e rename — a key NOVA nunca passa por um
  // inode antigo 0644 (writeFile por cima + chmod deixava essa janela).
  await writePrivateDataFile(target, `${key}\n`);
  return target;
}

export async function removeStoredKey(): Promise<void> {
  await fs.rm(keyFilePath(), { force: true });
}

// --- contexto ----------------------------------------------------------------

export interface CliContext {
  out: Output;
  values: Record<string, unknown>;
  positionals: string[];
  verbose: boolean;
  dataDir: string;
}

export function buildContext(parsed: ParsedArgs): CliContext {
  const dataDir = resolveHome(parsed.values);
  setDataDir(dataDir);
  const out = new Output({
    format: resolveFormat(parsed.values),
    quiet: parsed.values.quiet === true,
    color: parsed.values['no-color'] !== true && !process.env.NO_COLOR,
    pretty: parsed.values.pretty === true,
  });
  return {
    out,
    values: parsed.values,
    positionals: parsed.positionals,
    verbose: parsed.values.verbose === true,
    dataDir,
  };
}

export type CatalogSource = 'disk' | 'network' | 'stale';

export interface LoadedCatalog {
  models: OpenRouterModel[];
  catalogSource: CatalogSource;
  /** `key` = catalogo da key; `public` = sem key (GET /models e publico). */
  catalogScope: 'key' | 'public';
  fetchedAt: number;
}

/**
 * Aquece o catalogo (memoria + disco) — com a key quando ha, SEM ela quando nao
 * ha (IMPL-029): o `GET /models` do OpenRouter e publico e gratuito, entao
 * `models`, `estimate` e `--dry-run` nao travam no humano por falta de key.
 * Falha vira `network.catalog_unavailable` (exit 8).
 */
export async function loadCatalog(ctx: CliContext, apiKey: string | null): Promise<LoadedCatalog> {
  const cat = await ensureCatalog(apiKey ?? '', {
    force: ctx.values['refresh-models'] === true,
    onWarn: (msg) => ctx.out.warn(msg),
  }).catch((err: unknown) => {
    throw new CliError(
      `Não consegui carregar o catálogo de modelos: ${(err as Error).message}`,
      EXIT.NETWORK,
      undefined,
      {
        code: 'network.catalog_unavailable',
        hint:
          'O catálogo (GET /models do OpenRouter) é público: confira a conexão e tente de novo — ' +
          'depois do primeiro sucesso ele fica em cache em disco por 24h.',
      },
    );
  });
  return { models: cat.models, catalogSource: cat.source, catalogScope: cat.scope, fetchedAt: cat.fetchedAt };
}

/** Contexto com catalogo quente e key OPCIONAL (dado publico: models/estimate). */
export interface CatalogContext extends CliContext, LoadedCatalog {
  apiKey: string | null;
}

export async function buildCatalogContext(parsed: ParsedArgs): Promise<CatalogContext> {
  const ctx = buildContext(parsed);
  const apiKey = await tryResolveKey(parsed.values);
  return { ...ctx, apiKey, ...(await loadCatalog(ctx, apiKey)) };
}

export interface NetworkContext extends CliContext {
  apiKey: string;
  models: OpenRouterModel[];
  catalogSource: CatalogSource;
}

/**
 * Contexto com key OBRIGATORIA e CATALOGO QUENTE. O aquecimento e obrigatorio:
 * sem ele o preco de toda chamada sai 0 e o esforco de raciocinio vai sem
 * encaixe na allowlist do modelo.
 */
export async function buildNetworkContext(parsed: ParsedArgs): Promise<NetworkContext> {
  const ctx = buildContext(parsed);
  const apiKey = await resolveKey(parsed.values);
  const cat = await loadCatalog(ctx, apiKey);
  return { ...ctx, apiKey, models: cat.models, catalogSource: cat.catalogSource };
}

/** Valida a key e devolve saldo/limite (usado no pre-voo das runs). */
export async function checkKey(apiKey: string): Promise<KeyInfo> {
  const res = await validateKey(apiKey);
  if (!res.ok && res.network) {
    // Nem chegou ao OpenRouter: a key pode estar boa — rede (8), nao auth (4).
    throw new CliError(res.error, EXIT.NETWORK, undefined, {
      code: 'network.key_check_failed',
      hint: 'Confira a conexão com openrouter.ai e repita; `prompt-builder key check` valida sem gastar.',
    });
  }
  if (!res.ok) {
    throw new CliError(`Key do OpenRouter inválida: ${res.error}`, EXIT.AUTH, undefined, {
      code: 'auth.key_invalid',
      hint:
        'Confira/gere a key em https://openrouter.ai/keys e grave de novo com ' +
        '`prompt-builder key set --stdin`; `prompt-builder key check` valida sem gastar.',
    });
  }
  return res;
}
