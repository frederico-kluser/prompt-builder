#!/usr/bin/env -S npx tsx
// Job SEMANAL (IMPL-019): confere os ids de modelo citados em agent-docs/,
// skills/ e README.md contra o catálogo PÚBLICO do OpenRouter (GET /models —
// sem key, sem custo; cache de 24 h em disco).
//
//   id ausente ou expirado          → ERRO  (exit 1)
//   expiration_date em ≤ 30 dias    → AVISO com sucedâneo (não reprova)
//   data futura além disso / sem data → ok
//
// Uso:
//   npx tsx scripts/check-model-ids.ts                      # catálogo ao vivo (cache 24 h)
//   npx tsx scripts/check-model-ids.ts --catalog models.json   # snapshot salvo (offline/reprodutível)
//   npx tsx scripts/check-model-ids.ts --refresh --json
// Opções: --root <dir> (default: raiz do repo, resolvida por este arquivo)
//         --cache <arq> (default: $XDG_CACHE_HOME|~/.cache/prompt-builder/public-catalog.json)
//         --target <caminho> (repetível; default agent-docs skills README.md)
//         --now <ISO> (data de referência — reprodutibilidade)
// Exit: 0 ok · 1 reprovado · 2 uso · 8 catálogo indisponível (fail-closed).
//
// Roda no workflow `.github/workflows/model-ids-weekly.yml`.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadCatalogFile, loadPublicCatalog } from '../src/publicCatalog.js';
import { DEFAULT_DOC_TARGETS, formatModelIdsReport, runModelIdsCheck } from '../src/modelIdsCheck.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function defaultCachePath(): string {
  const base = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache');
  return path.join(base, 'prompt-builder', 'public-catalog.json');
}

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        root: { type: 'string' },
        catalog: { type: 'string' },
        cache: { type: 'string' },
        target: { type: 'string', multiple: true },
        refresh: { type: 'boolean' },
        json: { type: 'boolean' },
        now: { type: 'string' },
      },
      strict: true,
    }));
  } catch (err) {
    process.stderr.write(`uso inválido: ${(err as Error).message}\n`);
    return 2;
  }
  const root = values.root ? path.resolve(values.root) : REPO_ROOT;
  const now = values.now ? new Date(values.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    process.stderr.write(`--now inválido: "${values.now}"\n`);
    return 2;
  }

  let catalog;
  let origem: string;
  try {
    if (values.catalog) {
      catalog = await loadCatalogFile(path.resolve(values.catalog));
      origem = `arquivo ${values.catalog}`;
    } else {
      const r = await loadPublicCatalog({
        cachePath: values.cache ? path.resolve(values.cache) : defaultCachePath(),
        force: values.refresh === true,
        baseUrl: process.env.OPENROUTER_BASE_URL?.trim() || undefined,
        onWarn: (m) => process.stderr.write(`! ${m}\n`),
      });
      catalog = r.models;
      origem = `${r.source === 'network' ? 'rede' : r.source === 'disk' ? 'cache' : 'cache vencido'} (${new Date(r.fetchedAt).toISOString()})`;
    }
  } catch (err) {
    process.stderr.write(`catálogo indisponível: ${(err as Error).message}\n`);
    return 8;
  }

  const report = await runModelIdsCheck({
    root,
    targets: values.target?.length ? values.target : DEFAULT_DOC_TARGETS,
    catalog,
    now,
  });
  process.stderr.write(`catálogo: ${catalog.length} modelos — ${origem}\n`);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const l of formatModelIdsReport(report)) process.stdout.write(`${l}\n`);
  }
  return report.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`falha inesperada: ${(err as Error)?.stack ?? String(err)}\n`);
    process.exit(1);
  },
);
