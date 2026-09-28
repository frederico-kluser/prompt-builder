// JOB SEMANAL: ids de modelo citados nas docs × catálogo (IMPL-019,
// R-07b:REC-8 Q12c, M-110 "docs executáveis"). Só Node.
//
// Exemplos embarcados envelhecem: o catálogo do OpenRouter perdeu ~19% dos ids
// de junho em ~99 dias, e as docs que viajam no pacote npm chegaram a citar ids
// que nunca existiram (`agent-docs/compare.md`). Este módulo varre
// `agent-docs/`, `skills/` e `README.md`, extrai os ids citados
// (`extractModelIds`, puro) e confere contra o catálogo do dia:
//   • id AUSENTE ou já EXPIRADO → reprova (exit != 0 no script);
//   • id com `expiration_date` em até 30 dias → aviso com sucedâneo;
//   • data futura além disso (ou sem data) → passa.
//
// Quem roda: `scripts/check-model-ids.ts` (workflow agendado
// `.github/workflows/model-ids-weekly.yml`). A raiz é SEMPRE explícita — nada de
// `process.cwd()` implícito (AGENTS.md).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  checkCitedModelIds,
  extractModelIds,
  knownVendorsFrom,
  type CatalogModelLike,
  type CitedModelId,
  type ModelIdsReport,
} from './engine/modelLifecycle.js';

/** O que o job confere por padrão (relativo à raiz do repositório). */
export const DEFAULT_DOC_TARGETS = ['agent-docs', 'skills', 'README.md'] as const;

/** Extensões de texto que podem citar ids (docs, exemplos de config, snippets). */
const TEXT_EXT = new Set(['.md', '.mdx', '.json', '.yml', '.yaml', '.sh', '.txt', '.toml']);

async function walk(target: string, out: string[]): Promise<void> {
  let st;
  try {
    st = await fs.stat(target);
  } catch {
    return; // alvo ausente: nada a conferir (não é erro — ex.: repo sem skills/)
  }
  if (st.isFile()) {
    if (TEXT_EXT.has(path.extname(target).toLowerCase())) out.push(target);
    return;
  }
  if (!st.isDirectory()) return;
  const entries = await fs.readdir(target, { withFileTypes: true });
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    await walk(path.join(target, e.name), out);
  }
}

/** Arquivos de texto sob os alvos (relativos a `root`), em ordem estável. */
export async function collectDocFiles(
  root: string,
  targets: readonly string[] = DEFAULT_DOC_TARGETS,
): Promise<string[]> {
  const out: string[] = [];
  for (const t of targets) await walk(path.resolve(root, t), out);
  return out;
}

/** Citações de ids nos arquivos (caminho no relatório é relativo a `root`). */
export async function citedModelIdsIn(
  root: string,
  files: readonly string[],
  catalog: readonly CatalogModelLike[],
): Promise<CitedModelId[]> {
  const vendors = knownVendorsFrom(catalog);
  const out: CitedModelId[] = [];
  for (const f of files) {
    const texto = await fs.readFile(f, 'utf-8');
    const rel = path.relative(root, f) || f;
    for (const c of extractModelIds(texto, vendors)) out.push({ id: c.id, file: rel, line: c.line });
  }
  return out;
}

export interface ModelIdsCheckResult extends ModelIdsReport {
  files: number;
}

/** Roda a conferência inteira: coleta, extrai e classifica contra o catálogo. */
export async function runModelIdsCheck(opts: {
  root: string;
  targets?: readonly string[];
  catalog: readonly CatalogModelLike[];
  now: Date;
}): Promise<ModelIdsCheckResult> {
  const files = await collectDocFiles(opts.root, opts.targets);
  const cited = await citedModelIdsIn(opts.root, files, opts.catalog);
  return { ...checkCitedModelIds(cited, opts.catalog, opts.now), files: files.length };
}

/** Relatório legível (uma linha por achado; PT-BR). */
export function formatModelIdsReport(r: ModelIdsCheckResult): string[] {
  const linhas: string[] = [
    `ids de modelo citados: ${r.checked} (${r.distinct} distintos) em ${r.files} arquivos — ` +
      `${r.failures.length} reprovado(s), ${r.warnings.length} aviso(s)`,
  ];
  for (const f of r.failures) linhas.push(`ERRO  ${f.file}:${f.line}  ${f.alert.message}`);
  for (const w of r.warnings) linhas.push(`AVISO ${w.file}:${w.line}  ${w.alert.message}`);
  linhas.push(r.ok ? 'ok: todo id citado existe no catálogo.' : 'REPROVADO: corrija os ids acima (ou marque a linha com `model-ids:ignore` se citar o id de propósito).');
  return linhas;
}
