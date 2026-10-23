#!/usr/bin/env node
// Empacota o app React95 do cenário de visão num IIFE autocontido.
//
// Uso: node scripts/vision-react95-build.mjs <node_modules com react/react-dom/
//      styled-components/react95> [saida]
//
// O bundle NÃO vai para o repositório por este script (ele é versionado em
// src/data/vision/vendor/react95/app.iife.js); este utilitário existe para o
// dia em que o app do cenário mudar. Ver src/vision/build/react95/README.md.
import { build } from 'esbuild';
import path from 'node:path';

const nodeModules = process.argv[2];
if (!nodeModules) {
  console.error('Erro: passe o diretório node_modules com react/react-dom/styled-components/react95.');
  process.exitCode = 2;
} else {
  const root = path.resolve(import.meta.dirname, '..');
  const outfile = process.argv[3] ?? path.join(root, 'app.iife.js');
  await build({
    entryPoints: [path.join(root, 'src', 'vision', 'build', 'react95', 'app.jsx')],
    bundle: true,
    format: 'iife',
    target: ['es2020'],
    jsx: 'automatic',
    minify: true,
    legalComments: 'inline',
    define: { 'process.env.NODE_ENV': '"production"' },
    resolveExtensions: ['.jsx', '.js', '.mjs', '.json'],
    nodePaths: [path.resolve(nodeModules)],
    outfile,
    logLevel: 'warning',
  });
  console.log(`bundle: ${outfile}`);
}
