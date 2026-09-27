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
import { Output, CliError, EXIT, type OutputFormat } from './output.js';
import type { OpenRouterModel } from '../types.js';

export const GLOBAL_OPTIONS = {
  json: { type: 'boolean' },
  'output-format': { type: 'string' },
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

/** parseArgs com mensagem PT-BR em vez do erro cru do Node. */
export function parse(
  args: string[],
  options: NonNullable<ParseArgsConfig['options']>,
): ParsedArgs {
  try {
    const r = parseArgs({
      args,
      options: { ...GLOBAL_OPTIONS, ...options },
      allowPositionals: true,
      strict: true,
    });
    return { values: r.values as Record<string, unknown>, positionals: r.positionals };
  } catch (err) {
    throw new CliError(`Argumento inválido: ${(err as Error).message}`, EXIT.USAGE);
  }
}

export function resolveFormat(values: Record<string, unknown>): OutputFormat {
  const explicit = values['output-format'];
  if (typeof explicit === 'string') {
    if (explicit !== 'text' && explicit !== 'json' && explicit !== 'ndjson') {
      throw new CliError(
        `--output-format deve ser text, json ou ndjson (recebi "${explicit}").`,
        EXIT.USAGE,
      );
    }
    return explicit;
  }
  if (values.json === true) return 'json';
  return 'text';
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

/** `--key` → `$OPENROUTER_API_KEY` → arquivo salvo por `key set`. */
export async function resolveKey(values: Record<string, unknown>): Promise<string> {
  const flag = values.key;
  if (typeof flag === 'string' && flag.trim()) return flag.trim();
  if (process.env.OPENROUTER_API_KEY?.trim()) return process.env.OPENROUTER_API_KEY.trim();
  const stored = await readStoredKey();
  if (stored) return stored;
  throw new CliError(
    'Key do OpenRouter ausente. Use `prompt-builder key set --stdin`, ' +
      'a variável OPENROUTER_API_KEY, ou a flag --key.',
    EXIT.AUTH,
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
  });
  return {
    out,
    values: parsed.values,
    positionals: parsed.positionals,
    verbose: parsed.values.verbose === true,
    dataDir,
  };
}

export interface NetworkContext extends CliContext {
  apiKey: string;
  models: OpenRouterModel[];
  catalogSource: 'disk' | 'network' | 'stale';
}

/**
 * Contexto com key resolvida e CATALOGO QUENTE. O aquecimento e obrigatorio:
 * sem ele o preco de toda chamada sai 0 e o esforco de raciocinio vai sem
 * encaixe na allowlist do modelo.
 */
export async function buildNetworkContext(parsed: ParsedArgs): Promise<NetworkContext> {
  const ctx = buildContext(parsed);
  const apiKey = await resolveKey(parsed.values);
  const cat = await ensureCatalog(apiKey, {
    force: parsed.values['refresh-models'] === true,
    onWarn: (msg) => ctx.out.warn(msg),
  }).catch((err: unknown) => {
    throw new CliError(
      `Não consegui carregar o catálogo de modelos: ${(err as Error).message}`,
      EXIT.NETWORK,
    );
  });
  return { ...ctx, apiKey, models: cat.models, catalogSource: cat.source };
}

/** Valida a key e devolve saldo/limite (usado no pre-voo das runs). */
export async function checkKey(apiKey: string): Promise<KeyInfo> {
  const res = await validateKey(apiKey);
  if (!res.ok) throw new CliError(`Key do OpenRouter inválida: ${res.error}`, EXIT.AUTH);
  return res;
}
