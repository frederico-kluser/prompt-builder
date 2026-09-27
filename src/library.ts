// Persistência da biblioteca de cenários+gabaritos (F1 do PLANO-PARIDADE).
//
// Local-first e coerente com o resto do projeto: vive em `<dataDir>/library/`,
// onde `dataDir` é o MESMO das runs (`storage.ts` — `./data` no servidor,
// `~/.prompt-builder` no CLI, `PROMPT_BUILDER_HOME`/`--data-dir` sobrescrevem).
// Um arquivo por item (`items/<id>.json`): diffável em git, seed idempotente por
// id, escrita atômica (tmp + rename) como `storage.ts`.
//
// A LÓGICA (shape, validação, gabarito obrigatório, cobertura) mora em
// `src/engine/libraryCore.ts` (fonte única dos dois motores); aqui é só disco.

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getDataDir } from './storage.js';
import {
  coverageReport,
  hasGabarito,
  mergeSeedItems,
  normalizeLibraryItem,
  toStageSpec,
  type CoverageReport,
  type CoverageTargets,
  type LibraryItem,
  type LibraryProfile,
  type ScenarioRules,
  type SeedResult,
} from './engine/libraryCore.js';
import { SCENARIO_PACK_FORMAT } from './scenarioPack.js';
import { checkImportPii } from './engine/pii.js';
import type { ScenarioPack, StageSpec } from './types.js';

function libraryDir(): string {
  return path.join(getDataDir(), 'library');
}

function profileDir(profileId: string): string {
  return path.join(libraryDir(), profileId);
}

function itemsDir(profileId: string): string {
  return path.join(profileDir(profileId), 'items');
}

function profileFile(profileId: string): string {
  return path.join(profileDir(profileId), 'profile.json');
}

function itemFile(profileId: string, itemId: string): string {
  return path.join(itemsDir(profileId), `${itemId}.json`);
}

async function writeAtomic(target: string, data: string): Promise<void> {
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(tmp, data, 'utf-8');
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

// ----------------------------------------------------------------------------
// Perfis
// ----------------------------------------------------------------------------

export async function listProfiles(): Promise<LibraryProfile[]> {
  let entradas: string[] = [];
  try {
    entradas = await fs.readdir(libraryDir());
  } catch {
    return []; // biblioteca ainda não existe = vazia, não erro
  }
  const perfis: LibraryProfile[] = [];
  for (const nome of entradas.sort()) {
    const p = await readJson<LibraryProfile>(profileFile(nome));
    if (p?.id) perfis.push(p);
  }
  return perfis;
}

export async function getProfile(profileId: string): Promise<LibraryProfile | undefined> {
  return readJson<LibraryProfile>(profileFile(profileId));
}

/** Cria (ou atualiza os metadados de) um perfil. `scenarioRules`/`coverageTargets` são opcionais. */
export async function saveProfile(input: {
  id: string;
  name: string;
  description?: string;
  scenarioRules?: ScenarioRules;
  coverageTargets?: CoverageTargets;
}): Promise<LibraryProfile> {
  const existente = await getProfile(input.id);
  const perfil: LibraryProfile = {
    id: input.id,
    name: input.name || input.id,
    description: input.description ?? existente?.description,
    createdAt: existente?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    scenarioRules: input.scenarioRules ?? existente?.scenarioRules,
    coverageTargets: input.coverageTargets ?? existente?.coverageTargets,
  };
  await writeAtomic(profileFile(input.id), JSON.stringify(perfil, null, 2));
  return perfil;
}

export async function deleteProfile(profileId: string): Promise<boolean> {
  try {
    await fs.rm(profileDir(profileId), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// Itens
// ----------------------------------------------------------------------------

export async function listItems(profileId: string): Promise<LibraryItem[]> {
  let arquivos: string[] = [];
  try {
    arquivos = await fs.readdir(itemsDir(profileId));
  } catch {
    return [];
  }
  const itens: LibraryItem[] = [];
  for (const arq of arquivos.filter((f) => f.endsWith('.json')).sort()) {
    const item = await readJson<LibraryItem>(path.join(itemsDir(profileId), arq));
    if (item?.id) itens.push(item);
  }
  return itens;
}

export async function getItem(profileId: string, itemId: string): Promise<LibraryItem | undefined> {
  return readJson<LibraryItem>(itemFile(profileId, itemId));
}

/** Grava itens validados (um arquivo por item). Retorna contagens. */
export async function saveItems(
  profileId: string,
  items: LibraryItem[],
): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;
  for (const item of items) {
    const jaExiste = await getItem(profileId, item.id);
    if (jaExiste) updated++;
    else added++;
    await writeAtomic(itemFile(profileId, item.id), JSON.stringify(item, null, 2));
  }
  return { added, updated };
}

export async function deleteItem(profileId: string, itemId: string): Promise<boolean> {
  try {
    await fs.rm(itemFile(profileId, itemId), { force: true });
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// Importação/seed/exportação
// ----------------------------------------------------------------------------

/**
 * Importa itens CRUS (JSON de arquivo — lista solta, {items:[...]} ou pacote de
 * cenários) para um perfil. Valida item a item: inválidos viram erros na lista
 * (PT-BR) e NÃO derrubam a importação. `origin` default = 'import'.
 *
 * LGPD (IMPL-042): item com dado pessoal de aparência real é RECUSADO com aviso
 * nomeando o campo (nunca corrigido em silêncio). `allowPii` = revisão humana
 * confirmou que é sintético.
 */
export async function importItems(
  profileId: string,
  raw: unknown,
  opts: { origin?: LibraryItem['origin']; seed?: string; allowPii?: boolean } = {},
): Promise<{ added: number; updated: number; errors: string[] }> {
  const lista: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown[] }).items)
      ? (raw as { items: unknown[] }).items
      : raw && typeof raw === 'object' && Array.isArray((raw as { scenarios?: unknown[] }).scenarios)
        ? (raw as { scenarios: unknown[] }).scenarios
        : [];
  const errors: string[] = [];
  const validos: LibraryItem[] = [];
  lista.forEach((cru, i) => {
    const r = normalizeLibraryItem({
      origin: opts.origin ?? 'import',
      createdAt: nowIso(),
      ...((cru ?? {}) as Record<string, unknown>),
    });
    if (!r.ok) {
      errors.push(`item ${i + 1}: ${r.error}`);
      return;
    }
    const pii = opts.allowPii ? null : checkImportPii(r.item);
    if (pii && !pii.ok) errors.push(`item ${i + 1}: ${pii.message}`);
    else validos.push(r.item);
  });
  const { added, updated } = await saveItems(profileId, validos.map((it) => ({ ...it, seed: it.seed ?? opts.seed })));
  return { added, updated, errors };
}

/**
 * Seed IDEMPOTENTE: mescla por id — o que já existe é pulado (não sobrescreve
 * curadoria humana). `mergeSeedItems` decide; aqui só se materializa em disco.
 */
export async function seedItems(profileId: string, incoming: LibraryItem[]): Promise<SeedResult> {
  const existentes = await listItems(profileId);
  const resultado = mergeSeedItems(existentes, incoming);
  if (resultado.added.length) await saveItems(profileId, resultado.added);
  return resultado;
}

/**
 * Exporta o perfil como `ScenarioPack` (`prompt-builder-pack@1`) — interop com
 * o formato já existente de pacote (importável como seed numa run).
 */
export async function exportProfilePack(
  profileId: string,
  prompt: ScenarioPack['prompt'] = { text: '', source: 'base' },
): Promise<ScenarioPack> {
  const [perfil, itens] = await Promise.all([getProfile(profileId), listItems(profileId)]);
  return {
    format: SCENARIO_PACK_FORMAT,
    theme: perfil?.name ?? profileId,
    exportedAt: nowIso(),
    prompt,
    scenarios: itens.map((it) => toStageSpec(it) as StageSpec & { id: string }),
  };
}

/** Relatório de cobertura do perfil (usa a matriz alvo declarada no perfil). */
export async function profileCoverage(profileId: string): Promise<CoverageReport> {
  const [perfil, itens] = await Promise.all([getProfile(profileId), listItems(profileId)]);
  return coverageReport(itens, perfil?.coverageTargets);
}

/** Itens sem gabarito (nem reference nem expected) — recusados no evolve (paridade com o 409 do Arena). */
export async function itemsWithoutGabarito(profileId: string): Promise<LibraryItem[]> {
  const itens = await listItems(profileId);
  return itens.filter((i) => !hasGabarito(i));
}
