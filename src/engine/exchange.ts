// Formato de troca `prompt-builder-exchange@1` (IMPL-089, R-22:REC-1/REC-9).
//
// Por que existe: os formatos antigos perdiam 8 campos do `LibraryItem` na ida
// e volta (`toStageSpec` descartava title/persona/context/…) e o próprio
// export não era reimportável. A régua é a do N1: **100% preservado OU
// declarado perdido** — nunca descarte mudo.
//
// Desenho (R-22:DEC-2): um manifesto + UM JSONL por entidade (runs, sessões,
// itens), com discriminador `{format, kind, exportedAt, producer, manifest}` na
// primeira linha de cada arquivo; campo desconhecido é PRESERVADO (ida e volta
// = identidade); qualquer descarte deliberado é listado em `lostFields` do
// manifesto. Identidade por `contentHash` (JCS/RFC 8785, `hash.ts`) +
// `parentHash` — a mescla é fast-forward ou conflito EXPLÍCITO (nunca "último
// a escrever vence"): ver `mergeItemVersion` em `libraryCore.ts`.
//
// ⚠️ PURO: sem node:fs, sem fetch. Quem lê/escreve os arquivos é o chamador
// (CLI `library export/add`, SPA export/import). Fonte única — o web
// re-exporta este módulo por shim.

export const EXCHANGE_FORMAT = 'prompt-builder-exchange@1';

export type ExchangeKind = 'run' | 'session' | 'library';

export const EXCHANGE_KINDS: readonly ExchangeKind[] = ['run', 'session', 'library'];

/** Nome do JSONL por entidade (o manifesto referencia por nome de arquivo). */
export const EXCHANGE_FILES: Readonly<Record<ExchangeKind, string>> = {
  run: 'runs.jsonl',
  session: 'sessions.jsonl',
  library: 'library.jsonl',
};

/** Nome do manifesto (um objeto JSON, não JSONL). */
export const EXCHANGE_MANIFEST_FILE = 'manifest.json';

/**
 * `kind` do protocolo (singular, R-22) → campo do input/resultado (plural).
 * Só nomes mudam: o conteúdo do JSONL é a entidade verbatim.
 */
const CAMPO_POR_KIND: Readonly<Record<ExchangeKind, 'runs' | 'sessions' | 'library'>> = {
  run: 'runs',
  session: 'sessions',
  library: 'library',
};

/** Entrada do manifesto por entidade. */
export interface ExchangeManifestEntry {
  kind: ExchangeKind;
  file: string;
  count: number;
  /** Descarte DELIBERADO declarado (régua: preservado ou declarado perdido). */
  lostFields?: string[];
}

/** Discriminador do pacote — o mesmo objeto serve de header de cada JSONL. */
export interface ExchangeHeader {
  format: typeof EXCHANGE_FORMAT;
  kind: ExchangeKind;
  exportedAt: string;
  producer: string;
  manifest: ExchangeManifestEntry[];
}

export interface ExchangeManifestFile {
  format: typeof EXCHANGE_FORMAT;
  exportedAt: string;
  producer: string;
  manifest: ExchangeManifestEntry[];
}

/** Pacote pronto para gravar: `files` = nome do arquivo → conteúdo textual. */
export interface ExchangeBundle {
  manifest: ExchangeManifestFile;
  files: Record<string, string>;
}

export interface ExchangeInput {
  /** Quem exportou (ex.: 'prompt-builder-cli@0.1.1'). */
  producer: string;
  exportedAt?: string;
  runs?: unknown[];
  sessions?: unknown[];
  library?: unknown[];
  /** Descarte deliberado POR entidade — o resto é preservado verbatim. */
  lostFields?: Partial<Record<ExchangeKind, string[]>>;
}

export type ExchangeParseResult =
  | {
      ok: true;
      exportedAt: string;
      producer: string;
      runs: unknown[];
      sessions: unknown[];
      library: unknown[];
      lostFields: Partial<Record<ExchangeKind, string[]>>;
    }
  | { ok: false; error: string };

/** Linhas não-vazias de um JSONL. */
function linhas(texto: string): string[] {
  return texto.split('\n').filter((l) => l.trim() !== '');
}

/**
 * Monta o pacote. Entidades são serializadas VERBATIM (uma por linha, JSON
 * compacto): campo desconhecido sobrevive por construção.
 */
export function buildExchangeBundle(input: ExchangeInput): ExchangeBundle {
  const exportedAt = input.exportedAt ?? new Date().toISOString();
  const entries: ExchangeManifestEntry[] = [];
  const files: Record<string, string> = {};

  for (const kind of EXCHANGE_KINDS) {
    const entidades = input[CAMPO_POR_KIND[kind]] ?? [];
    const perdidos = input.lostFields?.[kind];
    if (entidades.length === 0 && (!perdidos || perdidos.length === 0)) continue;
    entries.push({
      kind,
      file: EXCHANGE_FILES[kind],
      count: entidades.length,
      ...(perdidos && perdidos.length > 0 ? { lostFields: [...perdidos] } : {}),
    });
  }

  const manifest: ExchangeManifestFile = {
    format: EXCHANGE_FORMAT,
    exportedAt,
    producer: input.producer,
    manifest: entries,
  };

  // Agora que o manifesto está fechado, cada JSONL ganha o header real.
  for (const entry of entries) {
    const entidades = input[CAMPO_POR_KIND[entry.kind]] ?? [];
    const header: ExchangeHeader = {
      format: EXCHANGE_FORMAT,
      kind: entry.kind,
      exportedAt,
      producer: input.producer,
      manifest: entries,
    };
    const corpo = entidades.map((e) => JSON.stringify(e));
    files[entry.file] = [JSON.stringify(header), ...corpo].join('\n') + '\n';
  }

  files[EXCHANGE_MANIFEST_FILE] = `${JSON.stringify(manifest)}\n`;
  return { manifest, files };
}

/**
 * Lê o pacote de volta (ida e volta = identidade). Valida o discriminador de
 * cada JSONL e a contagem declarada no manifesto — arquivo que não bate com o
 * manifesto é CORRUPÇÃO, não silêncio.
 */
export function parseExchangeBundle(files: Record<string, string>): ExchangeParseResult {
  const manifestoTexto = files[EXCHANGE_MANIFEST_FILE];
  if (manifestoTexto === undefined) return { ok: false, error: `falta ${EXCHANGE_MANIFEST_FILE}` };
  let manifesto: ExchangeManifestFile;
  try {
    manifesto = JSON.parse(manifestoTexto) as ExchangeManifestFile;
  } catch {
    return { ok: false, error: `${EXCHANGE_MANIFEST_FILE} não é JSON válido` };
  }
  if (manifesto?.format !== EXCHANGE_FORMAT) {
    return { ok: false, error: `formato não suportado (esperado ${EXCHANGE_FORMAT})` };
  }
  if (!Array.isArray(manifesto.manifest)) {
    return { ok: false, error: 'manifesto sem a lista de entidades' };
  }

  const saida: Extract<ExchangeParseResult, { ok: true }> = {
    ok: true,
    exportedAt: manifesto.exportedAt,
    producer: manifesto.producer,
    runs: [],
    sessions: [],
    library: [],
    lostFields: {},
  };

  for (const entry of manifesto.manifest) {
    if (!entry || !EXCHANGE_KINDS.includes(entry.kind)) {
      return { ok: false, error: 'entrada de manifesto com kind desconhecido' };
    }
    const texto = files[entry.file];
    if (texto === undefined) return { ok: false, error: `falta o arquivo ${entry.file}` };
    const linhasDoArquivo = linhas(texto);
    const primeira = linhasDoArquivo[0];
    let header: ExchangeHeader;
    try {
      header = JSON.parse(primeira ?? '') as ExchangeHeader;
    } catch {
      return { ok: false, error: `${entry.file} sem header JSON` };
    }
    if (header?.format !== EXCHANGE_FORMAT || header?.kind !== entry.kind) {
      return { ok: false, error: `${entry.file}: header não casa com o manifesto` };
    }
    const entidades: unknown[] = [];
    for (const linha of linhasDoArquivo.slice(1)) {
      try {
        entidades.push(JSON.parse(linha));
      } catch {
        return { ok: false, error: `${entry.file}: linha não é JSON válido` };
      }
    }
    if (entidades.length !== entry.count) {
      return {
        ok: false,
        error: `${entry.file}: manifesto declara ${entry.count} registro(s), arquivo tem ${entidades.length}`,
      };
    }
    saida[CAMPO_POR_KIND[entry.kind]] = entidades;
    if (entry.lostFields && entry.lostFields.length > 0) {
      saida.lostFields[entry.kind] = [...entry.lostFields];
    }
  }
  return saida;
}

/**
 * Campos presentes na origem e ausentes no resultado de um MAPEAMENTO sem
 * estarem declarados em `lostFields`. É o teste que fica VERMELHO quando uma
 * camada (zod, conversão, filtro) descarta campo em silêncio.
 */
export function undeclaredLoss(
  source: readonly unknown[],
  mapped: readonly unknown[],
  lostFields: readonly string[] = [],
): string[] {
  const declarados = new Set(lostFields);
  const faltando = new Set<string>();
  for (let i = 0; i < source.length; i++) {
    const antes = (source[i] ?? {}) as Record<string, unknown>;
    const depois = (mapped[i] ?? {}) as Record<string, unknown>;
    if (typeof antes !== 'object' || antes === null) continue;
    if (typeof depois !== 'object' || depois === null) {
      for (const chave of Object.keys(antes)) if (!declarados.has(chave)) faltando.add(chave);
      continue;
    }
    for (const chave of Object.keys(antes)) {
      if (!(chave in depois) && !declarados.has(chave)) faltando.add(chave);
    }
  }
  return [...faltando].sort();
}
