#!/usr/bin/env node
// Gera src/data/lgpd-allowlist.generated.json — a allowlist LGPD POR ENDPOINT
// (provedor + região/variante), derivada de GET /models + GET /endpoints/zdr.
// Os dois endpoints são PÚBLICOS e gratuitos: não precisa de API key.
//
// ⚠️ Este script NÃO classifica nada (IMPL-041): antes ele era a 3ª cópia da
// regra de classificação. Agora só BUSCA e GRAVA; derivação e classificação
// são as de `src/engine/lgpdCore.ts`, a MESMA usada em runtime pelo CLI, pelo
// servidor e pela SPA (`test/lgpd-allowlist.test.ts` falha se divergir).
//
// Uso:  npm run lgpd:allowlist                 (= tsx scripts/gen-lgpd-allowlist.mjs)
//       npm run lgpd:allowlist -- --dry-run    (não grava; só o relatório)
//       OPENROUTER_BASE_URL=... npm run lgpd:allowlist
//
// Regenerar ANTES de 90 dias (alvo 30): passado isso o runtime bloqueia toda
// área sensível (fail-closed). A CI regenera sozinha (.github/workflows).

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  allowlistReport,
  buildAllowlistSnapshot,
  serializeAllowlistSnapshot,
} from '../src/engine/lgpdCore.ts';

// Raiz pelo próprio arquivo, nunca por process.cwd() (ver src/paths.ts).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMPLIANCE_FILE = path.join(ROOT, 'src', 'data', 'lgpd-compliance.json');
export const SNAPSHOT_FILE = path.join(ROOT, 'src', 'data', 'lgpd-allowlist.generated.json');

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';

/**
 * Busca os dois catálogos públicos e deriva o snapshot pelo núcleo único.
 * `fetchImpl` é injetável (testes usam transporte falso: zero rede).
 */
export async function generateAllowlist({ baseUrl = DEFAULT_BASE, fetchImpl = fetch, now = new Date() } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const getJson = async (url) => {
    // Chamada como FUNÇÃO (não método): `fetchImpl` pode ser o fetch global.
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.json();
  };
  const [models, zdr] = await Promise.all([getJson(`${base}/models`), getJson(`${base}/endpoints/zdr`)]);
  return buildAllowlistSnapshot({
    models,
    zdr,
    now,
    fonte: `${base}/models + ${base}/endpoints/zdr (públicos)`,
  });
}

/** Linhas do relatório (idade, contagens, por área) — o mesmo de `models allowlist --check`. */
export function reportLines(snapshot, compliance, now = new Date()) {
  const r = allowlistReport({ ...compliance, allowlist: snapshot }, now);
  const out = [
    `${r.health.message}`,
    `  catálogo: ${snapshot.total_modelos_catalogo} modelos · ${r.health.modelosComZdr} com endpoint ZDR · ` +
      `${r.health.endpoints} endpoints ZDR (${snapshot.endpoints_zdr_fora_do_catalogo} fora do catálogo)`,
    `  modelos com endpoint elegível na UE: ${r.modelosComEndpointUe}`,
  ];
  if (r.provedoresForaDoMapa.length) {
    out.push(
      `  provedores FORA do mapa (excluídos até a base classificá-los): ${r.provedoresForaDoMapa.join(', ')}`,
    );
  }
  for (const [area, a] of Object.entries(r.porArea)) {
    out.push(
      `  ${area.padEnd(22)} ${a.sensivel ? 'sensível ' : 'consultiva'}  permitidos=${a.permitidos}  ` +
        `ressalvas=${a.com_ressalvas}  bloqueados=${a.bloqueados}  desconhecidos_liberados=${a.desconhecidos_liberados}`,
    );
  }
  return out;
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const baseUrl = process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE;
  process.stderr.write(`[gen-lgpd] buscando catálogo público em ${baseUrl} …\n`);
  const snapshot = await generateAllowlist({ baseUrl });
  const compliance = JSON.parse(readFileSync(COMPLIANCE_FILE, 'utf-8'));
  if (!dryRun) writeFileSync(SNAPSHOT_FILE, serializeAllowlistSnapshot(snapshot), 'utf-8');
  process.stderr.write(
    `[gen-lgpd] ${dryRun ? '(dry-run, nada gravado)' : `gravado em ${path.relative(ROOT, SNAPSHOT_FILE)}`}\n`,
  );
  for (const l of reportLines(snapshot, compliance)) process.stderr.write(`${l}\n`);
}

// Executado direto (não importado por teste).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`[gen-lgpd] falhou: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
