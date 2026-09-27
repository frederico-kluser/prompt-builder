// Snapshot DIÁRIO do contrato do `/models` (IMPL-018 / R-07b:REC-7).
//
// Confere o catálogo AO VIVO (GET /models — público e gratuito, sem key)
// contra a baseline versionada `test/fixtures/catalog-contract.json` e reprova
// (exit 1) quando muda um campo que muda o fio (`supported_parameters` do
// subconjunto do gateway, `reasoning.supported_efforts`, `reasoning.mandatory`)
// de um modelo VIGIADO, ou quando um vigiado some. Guarda-se o DIFF, nunca o
// dump do catálogo.
//
//   npx tsx scripts/catalog-contract.ts                       # confere (CI diário)
//   npx tsx scripts/catalog-contract.ts --out drift.json      # + grava o diff (se houver)
//   npx tsx scripts/catalog-contract.ts --accept              # aceita, após revisão humana:
//        reescreve a baseline e VERSIONA o diff em test/fixtures/catalog-drift/<data>.json
//   npx tsx scripts/catalog-contract.ts --accept --watch a/b,c/d   # passa a vigiar mais ids
//   npx tsx scripts/catalog-contract.ts --catalog models.json # usa um payload local (offline)
//   (--baseline/--drift-dir trocam os caminhos padrão — usados pelos testes)
//
// stdout = o diff (JSON); stderr = narração. Exit: 0 ok · 1 drift que quebra ·
// 2 uso · 3 catálogo indisponível/inválido.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateModelsPayload } from '../src/openrouter.js';
import {
  buildCatalogContract,
  diffCatalogContract,
  parseCatalogContract,
  type CatalogContract,
} from '../src/engine/catalogContract.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_BASELINE = join(ROOT, 'test', 'fixtures', 'catalog-contract.json');
const DRIFT_DIR = join(ROOT, 'test', 'fixtures', 'catalog-drift');

const log = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

async function main(): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      options: {
        baseline: { type: 'string' },
        out: { type: 'string' },
        accept: { type: 'boolean' },
        watch: { type: 'string' },
        catalog: { type: 'string' },
        'base-url': { type: 'string' },
        'drift-dir': { type: 'string' },
      },
      strict: true,
    }));
  } catch (err) {
    log(`uso inválido: ${(err as Error).message}`);
    return 2;
  }
  const baselinePath = resolve(ROOT, (values.baseline as string | undefined) ?? DEFAULT_BASELINE);
  const driftDir = resolve(ROOT, (values['drift-dir'] as string | undefined) ?? DRIFT_DIR);
  const extra = String(values.watch ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.length > 0 && values.accept !== true) {
    log('--watch só vale junto com --accept (mudar a lista de vigiados é uma decisão revisada).');
    return 2;
  }

  // Catálogo: payload local (offline) ou GET /models ao vivo.
  let payload: unknown;
  try {
    if (typeof values.catalog === 'string') {
      payload = JSON.parse(readFileSync(resolve(ROOT, values.catalog), 'utf-8'));
    } else {
      const base = String(values['base-url'] ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
      const res = await fetch(`${base}/models`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      payload = await res.json();
    }
  } catch (err) {
    log(`catálogo indisponível: ${(err as Error).message}`);
    return 3;
  }
  const { models, issues } = validateModelsPayload(payload);
  if (models.length === 0) {
    log('catálogo vazio ou fora do formato — nada a comparar.');
    return 3;
  }

  const baseline: CatalogContract | null = existsSync(baselinePath)
    ? parseCatalogContract(JSON.parse(readFileSync(baselinePath, 'utf-8')))
    : null;
  if (!baseline && values.accept !== true) {
    log(`baseline ausente em ${baselinePath}. Crie com --accept --watch <ids>.`);
    return 2;
  }

  const vigiados = new Set([...Object.keys(baseline?.models ?? {}), ...extra]);
  const graves = issues.filter((i) => i.severity === 'error' && vigiados.has(i.modelId));
  for (const i of graves) log(`fail-closed em modelo vigiado: ${i.modelId} ${i.field} — ${i.message}`);

  const drift = diffCatalogContract(baseline ?? { format: 'prompt-builder-catalog-contract@1', models: {} }, models);
  process.stdout.write(`${JSON.stringify(drift, null, 2)}\n`);
  for (const c of drift.changes) {
    log(
      `${c.breaking ? 'QUEBRA' : 'info  '} ${c.modelId} ${c.field}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`,
    );
  }
  if (typeof values.out === 'string' && drift.changes.length > 0) {
    writeFileSync(resolve(ROOT, values.out), `${JSON.stringify(drift, null, 2)}\n`);
  }

  if (values.accept === true) {
    const { contract, missing } = buildCatalogContract(models, vigiados);
    if (missing.length > 0) log(`fora do catálogo (não vigiados): ${missing.join(', ')}`);
    const novos = extra.filter((id) => !baseline?.models[id] && contract.models[id]);
    if (drift.changes.length > 0 || novos.length > 0) {
      mkdirSync(driftDir, { recursive: true });
      const dia = new Date().toISOString().slice(0, 10);
      // Dois aceites no mesmo dia não se sobrescrevem: o histórico é o ponto.
      let alvo = join(driftDir, `${dia}.json`);
      for (let n = 2; existsSync(alvo); n++) alvo = join(driftDir, `${dia}-${n}.json`);
      writeFileSync(alvo, `${JSON.stringify({ ...drift, acceptedAt: new Date().toISOString(), added: novos }, null, 2)}\n`);
      log(`diff versionado em ${alvo}`);
    }
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(contract, null, 2)}\n`);
    log(`baseline atualizada: ${Object.keys(contract.models).length} modelo(s) vigiado(s).`);
    return 0;
  }

  if (drift.breaking) {
    log('contrato do catálogo QUEBROU para modelo vigiado. Revise o diff e rode com --accept se estiver correto.');
    return 1;
  }
  log(drift.changes.length ? 'mudanças só informativas — contrato mantido.' : 'contrato do catálogo mantido.');
  return 0;
}

// exitCode (não process.exit): deixa o stdout (o diff) terminar de escoar num pipe.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    log(`falha: ${(err as Error).stack ?? String(err)}`);
    process.exitCode = 3;
  },
);
