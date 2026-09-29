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
import path from 'node:path';
import { getDataDir, writePrivateDataFile } from './storage.js';
import { isSafePathSegment, resolveInside, UnsafePathError } from './pathSafety.js';
import {
  coverageReport,
  hasGabarito,
  mergeSeedItems,
  normalizeLibraryItemPreserving,
  toStageSpec,
  type CoverageReport,
  type CoverageTargets,
  type LibraryItem,
  type LibraryProfile,
  type ScenarioRules,
  type SeedResult,
} from './engine/libraryCore.js';
import {
  EXCHANGE_FORMAT,
  EXCHANGE_MANIFEST_FILE,
  alteredOrLostFields,
  buildExchangeBundle,
  isSingleFileBundle,
  parseExchangeBundle,
  type ExchangeBundle,
  type ExchangeManifestFile,
  type ExchangeSingleFile,
} from './engine/exchange.js';
import { SCENARIO_PACK_FORMAT, SCENARIO_PACK_FORMAT_LEGACY } from './scenarioPack.js';
import { checkImportPii } from './engine/pii.js';
import type { ScenarioPack, StageSpec } from './types.js';

function libraryDir(): string {
  return path.join(getDataDir(), 'library');
}

// IMPL-024: perfil e item viram SEGMENTO de caminho — validados e contidos.
// Sem isto, `library drop --profile ../..` virava `rm -rf` do diretório PAI do
// data dir, e um item importado com id `../../x` era gravado fora da biblioteca.
function segmento(valor: string, oque: 'perfil' | 'item'): string {
  if (!isSafePathSegment(valor)) {
    throw new UnsafePathError(`Id de ${oque} inválido: sem "/", "\\", ":", ".." nem espaço nas pontas.`);
  }
  return valor;
}

function profileDir(profileId: string): string {
  return resolveInside(libraryDir(), segmento(profileId, 'perfil'));
}

function itemsDir(profileId: string): string {
  return path.join(profileDir(profileId), 'items');
}

function profileFile(profileId: string): string {
  return path.join(profileDir(profileId), 'profile.json');
}

function itemFile(profileId: string, itemId: string): string {
  return resolveInside(itemsDir(profileId), `${segmento(itemId, 'item')}.json`);
}

// IMPL-024: a biblioteca mora no data dir (ao lado da key) e guarda cenários e
// gabaritos — diretórios 0700 (raiz, library/, perfil, items/) e arquivos
// 0600, com chmod explícito que corrige uma biblioteca antiga 0755/0644.
async function writeAtomic(target: string, data: string): Promise<void> {
  await writePrivateDataFile(target, data);
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
    if (!isSafePathSegment(nome)) continue; // entrada estranha no disco não derruba a listagem
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
  const dir = profileDir(profileId); // FORA do try: id inválido lança, não vira "false"
  try {
    await fs.rm(dir, { recursive: true, force: true });
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
  const file = itemFile(profileId, itemId);
  try {
    await fs.rm(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// Importação/seed/exportação
// ----------------------------------------------------------------------------

/** De onde vieram os itens importados (o CLI reporta). */
export type ImportFormat = 'exchange' | 'pack' | 'list';

export interface PreparedImport {
  items: LibraryItem[];
  errors: string[];
  /**
   * Campos declarados PERDIDOS (IMPL-089): os do manifesto de um pacote
   * `prompt-builder-exchange@1` + o que a normalização não conseguiu
   * representar. A régua: 100% preservado OU declarado aqui — nunca calado.
   */
  lostFields: string[];
  format: ImportFormat;
}

function isScenarioPack(raw: unknown): raw is { scenarios: unknown[] } {
  const f = raw && typeof raw === 'object' ? (raw as { format?: unknown }).format : undefined;
  return (
    (f === SCENARIO_PACK_FORMAT || f === SCENARIO_PACK_FORMAT_LEGACY) &&
    Array.isArray((raw as { scenarios?: unknown }).scenarios)
  );
}

/**
 * Lista crua (JSON de arquivo — lista solta, {items:[...]}, pacote de
 * cenários `prompt-builder-pack@1` ou pacote de troca
 * `prompt-builder-exchange@1` em arquivo único) → itens válidos + erros PT-BR,
 * item a item. É o funil ÚNICO de entrada de arquivo na biblioteca (`library
 * add` e `library seed --file`): formato E LGPD.
 *
 * IMPL-089: a validação PRESERVA campo desconhecido (`normalizeLibraryItemPreserving`)
 * — antes o zod o removia em silêncio — e o que se perde é devolvido em
 * `lostFields`. Pacote `pack@1` (sem título/metadados de curadoria) ganha
 * `title` derivado da pergunta e `tier: 'mft'` quando faltam: é o formato
 * lossy do próprio `library export --format pack`, reimportável.
 *
 * LGPD (IMPL-042): item com dado pessoal de aparência real é RECUSADO com aviso
 * nomeando o campo (nunca corrigido em silêncio). `allowPii` = revisão humana
 * confirmou que pode seguir.
 */
export function prepareImportItems(
  raw: unknown,
  opts: { origin?: LibraryItem['origin']; allowPii?: boolean } = {},
): PreparedImport {
  const errors: string[] = [];
  const items: LibraryItem[] = [];
  const perdidos = new Set<string>();
  let format: ImportFormat = 'list';
  let lista: unknown[];
  let defaults: (cru: Record<string, unknown>) => Record<string, unknown> = () => ({});

  if (isSingleFileBundle(raw)) {
    format = 'exchange';
    const lido = parseExchangeBundle(raw.files);
    if (!lido.ok) {
      return { items, errors: [`pacote ${EXCHANGE_FORMAT} inválido: ${lido.error}`], lostFields: [], format };
    }
    lista = lido.library;
    for (const campo of lido.lostFields.library ?? []) perdidos.add(campo);
  } else if (isScenarioPack(raw)) {
    format = 'pack';
    lista = raw.scenarios;
    defaults = (cru) => ({
      tier: 'mft',
      ...(typeof cru.question === 'string' ? { title: cru.question.trim().slice(0, 80) } : {}),
    });
  } else {
    lista = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown[] }).items)
        ? (raw as { items: unknown[] }).items
        : raw && typeof raw === 'object' && Array.isArray((raw as { scenarios?: unknown[] }).scenarios)
          ? (raw as { scenarios: unknown[] }).scenarios
          : [];
  }

  lista.forEach((cru, i) => {
    const objeto = (cru ?? {}) as Record<string, unknown>;
    const r = normalizeLibraryItemPreserving({
      origin: opts.origin ?? 'import',
      createdAt: nowIso(),
      ...defaults(objeto),
      ...objeto,
    });
    if (!r.ok) {
      errors.push(`item ${i + 1}: ${r.error}`);
      return;
    }
    for (const campo of r.lostFields) perdidos.add(campo);
    // IMPL-024: o id vira nome de arquivo — nada de separador nem `..`.
    if (!isSafePathSegment(r.item.id)) {
      errors.push(`item ${i + 1}: id inválido (sem "/", "\\", ":" ou "..")`);
      return;
    }
    const pii = opts.allowPii ? null : checkImportPii(r.item);
    if (pii && !pii.ok) errors.push(`item ${i + 1}: ${pii.message}`);
    else items.push(r.item);
  });
  return { items, errors, lostFields: [...perdidos].sort(), format };
}

/**
 * Importa itens CRUS para um perfil (ver `prepareImportItems`): inválidos e
 * recusados por LGPD viram erros na lista e NÃO derrubam a importação.
 * `origin` default = 'import'.
 */
export async function importItems(
  profileId: string,
  raw: unknown,
  opts: { origin?: LibraryItem['origin']; seed?: string; allowPii?: boolean } = {},
): Promise<{ added: number; updated: number; errors: string[]; lostFields: string[]; format: ImportFormat }> {
  const { items: validos, errors, lostFields, format } = prepareImportItems(raw, opts);
  const { added, updated } = await saveItems(
    profileId,
    validos.map((it) => (it.seed === undefined && opts.seed !== undefined ? { ...it, seed: opts.seed } : it)),
  );
  return { added, updated, errors, lostFields, format };
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
 * o formato já existente de pacote (importável como seed numa run). LOSSY:
 * use `exportProfileExchangePack` para declarar o que se perde.
 */
export async function exportProfilePack(
  profileId: string,
  prompt: ScenarioPack['prompt'] = { text: '', source: 'base' },
): Promise<ScenarioPack> {
  return (await exportProfilePackDeclared(profileId, prompt)).pack;
}

/**
 * `pack@1` + a perda DECLARADA (IMPL-089): cada campo do item que o pacote
 * descarta ou reescreve (`title`, curadoria, `origin: 'manual'`→'import', …).
 */
export async function exportProfilePackDeclared(
  profileId: string,
  prompt: ScenarioPack['prompt'] = { text: '', source: 'base' },
): Promise<{ pack: ScenarioPack; lostFields: string[] }> {
  const [perfil, itens] = await Promise.all([getProfile(profileId), listItems(profileId)]);
  // A aprovação (IMPL-065) é fato da CURADORIA do banco, não do pacote de seed:
  // `state`/`reviewer`/`contentHash` já saem como perda declarada — o carimbo
  // derivado deles também fica de fora (o formato pack@1 não muda).
  const scenarios = itens.map((it) => {
    const { humanApproval: _aprovacao, ...spec } = toStageSpec(it);
    void _aprovacao;
    return spec as StageSpec & { id: string };
  });
  return {
    pack: {
      format: SCENARIO_PACK_FORMAT,
      theme: perfil?.name ?? profileId,
      exportedAt: nowIso(),
      prompt,
      scenarios,
    },
    lostFields: alteredOrLostFields(itens, scenarios),
  };
}

/**
 * Exporta o perfil em `prompt-builder-exchange@1` (IMPL-089): os itens vão
 * VERBATIM como estão no disco (campo desconhecido incluso) — ida e volta pelo
 * `library add` é identidade, sem `lostFields`.
 */
export async function exportProfileExchange(
  profileId: string,
  producer: string,
): Promise<{ bundle: ExchangeBundle; count: number }> {
  const itens = await listItems(profileId);
  return { bundle: buildExchangeBundle({ producer, library: itens }), count: itens.length };
}

/** Grava o pacote como DIRETÓRIO (manifest.json + um JSONL por entidade). */
export async function writeExchangeDir(dir: string, bundle: ExchangeBundle): Promise<string[]> {
  await fs.mkdir(dir, { recursive: true });
  const escritos: string[] = [];
  for (const [nome, conteudo] of Object.entries(bundle.files)) {
    const alvo = resolveInside(dir, segmento(nome, 'item'));
    await fs.writeFile(alvo, conteudo, 'utf-8');
    escritos.push(alvo);
  }
  return escritos;
}

const EXCHANGE_READ = 'EXCHANGE_READ';

/** Erro de leitura do diretório de troca — o CLI o traduz em exit 3. */
export class ExchangeReadError extends Error {
  readonly code = EXCHANGE_READ;
}

/** Por `code`, nunca `instanceof` (instância dupla de módulo ESM daria false). */
export function isExchangeReadError(err: unknown): err is ExchangeReadError {
  return (err as { code?: unknown } | null)?.code === EXCHANGE_READ;
}

/**
 * Lê um pacote de troca gravado como DIRETÓRIO e o devolve no formato de
 * arquivo único (mesma validação a jusante). Os nomes de arquivo do manifesto
 * são DADO de terceiro: só segmento seguro, contido no diretório.
 */
export async function readExchangeDir(dir: string): Promise<ExchangeSingleFile> {
  let manifestoTexto: string;
  try {
    manifestoTexto = await fs.readFile(path.join(dir, EXCHANGE_MANIFEST_FILE), 'utf-8');
  } catch {
    throw new ExchangeReadError(`"${dir}" não é um pacote ${EXCHANGE_FORMAT}: falta ${EXCHANGE_MANIFEST_FILE}.`);
  }
  let manifesto: ExchangeManifestFile;
  try {
    manifesto = JSON.parse(manifestoTexto) as ExchangeManifestFile;
  } catch {
    throw new ExchangeReadError(`${EXCHANGE_MANIFEST_FILE} em "${dir}" não é JSON válido.`);
  }
  if (manifesto?.format !== EXCHANGE_FORMAT || !Array.isArray(manifesto.manifest)) {
    throw new ExchangeReadError(`${EXCHANGE_MANIFEST_FILE} em "${dir}" não é de ${EXCHANGE_FORMAT}.`);
  }
  const files: Record<string, string> = { [EXCHANGE_MANIFEST_FILE]: manifestoTexto };
  for (const entrada of manifesto.manifest) {
    const nome = entrada?.file;
    if (!isSafePathSegment(nome)) {
      throw new ExchangeReadError(`manifesto aponta arquivo com nome inválido: ${JSON.stringify(nome)}.`);
    }
    try {
      files[nome] = await fs.readFile(resolveInside(dir, nome), 'utf-8');
    } catch {
      throw new ExchangeReadError(`falta o arquivo ${nome} declarado no manifesto de "${dir}".`);
    }
  }
  return { ...manifesto, files };
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
