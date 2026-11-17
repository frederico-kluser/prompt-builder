#!/usr/bin/env node
// Sincroniza o DATASET DE VISÃO para dentro da SPA.
//
// A SPA é estática (Vercel sem backend) e o dataset mora em `src/data/vision/`
// (fora do root do Vite). Em vez de importar PNG/JSON através do root — que
// complica tsc/Vite e pode acabar duplicando bytes no bundle — o build copia o
// MANIFESTO e as IMAGENS para `web/public/vision/`, servidos em `/vision/…`.
//
// Copia só o necessário para RODAR e DESENHAR: manifesto + PNGs. O HTML dos
// cenários e os assets dos frameworks continuam no pacote (build do dataset),
// não no bundle da SPA.
//
// Uso: `npm run web:build` / `npm run web:dev` chamam este script (prebuild/
// predev). Rodar sozinho também vale.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'data', 'vision');
const DST = path.join(ROOT, 'web', 'public', 'vision');

async function main() {
  const manifestoPath = path.join(SRC, 'dataset@1.json');
  let texto;
  try {
    texto = await fs.readFile(manifestoPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      console.error(`[vision-web] dataset ausente em ${manifestoPath} — rode \`npm run vision:build\` no repositório.`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  const dataset = JSON.parse(texto);
  if (dataset?.format !== 'vision-dataset@1' || !Array.isArray(dataset.scenes)) {
    console.error('[vision-web] manifesto não é vision-dataset@1 — nada foi copiado.');
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(path.join(DST, 'images'), { recursive: true });
  // Remove imagens órfãs de uma versão anterior do dataset (cenário removido).
  const atuais = new Set(dataset.scenes.map((s) => path.basename(s.image.file)));
  for (const nome of await fs.readdir(path.join(DST, 'images')).catch(() => [])) {
    if (!atuais.has(nome)) await fs.rm(path.join(DST, 'images', nome), { force: true });
  }
  for (const scene of dataset.scenes) {
    const origem = path.join(SRC, scene.image.file);
    const destino = path.join(DST, 'images', path.basename(scene.image.file));
    await fs.copyFile(origem, destino);
  }
  await fs.writeFile(path.join(DST, 'dataset@1.json'), texto, 'utf8');
  const bytes = dataset.scenes.reduce((a, s) => a + s.image.bytes, 0);
  console.log(
    `[vision-web] ${dataset.scenes.length} cenário(s) · ${(bytes / 1024).toFixed(0)} KiB de imagem → web/public/vision/`,
  );
}

await main();
