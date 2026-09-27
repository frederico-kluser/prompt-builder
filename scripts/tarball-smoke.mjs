#!/usr/bin/env node
// Smoke de instalação do tarball npm (IMPL-103, R-18:REC-5).
//
// Empacota o pacote REAL, instala num diretório VAZIO e sobe os 3 bins do
// pacote instalado — o caso `npx prompt-builder-cli` já quebrou uma vez por
// homônimo de bin ("could not determine executable to run"), então ele entra
// literalmente no smoke:
//
//   prompt-builder --version          exit 0
//   pbuilder --help                   exit 0
//   npx --no-install prompt-builder-cli --help   exit 0
//
// Uso: node scripts/tarball-smoke.mjs      (roda depois do build; ver prepublishOnly)
// Sai 0 com tudo de pé; 1 com o primeiro passo vermelho (a causa vai no stderr).

import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function log(msg) {
  process.stderr.write(`[tarball-smoke] ${msg}\n`);
}

export function smokeInstall({ root = ROOT, keep = false } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pb-smoke-'));
  try {
    // 1) empacota de verdade (npm pack roda o mesmo caminho do publish)
    log('empacotando (npm pack) …');
    const out = execSync(`npm pack --json --pack-destination ${JSON.stringify(tmp)}`, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    });
    const packed = JSON.parse(out);
    const tarball = path.join(tmp, packed[0].filename);

    // 2) instala num diretório VAZIO (o que um usuário faria)
    const alvo = path.join(tmp, 'alvo');
    mkdirSync(alvo, { recursive: true });
    writeFileSync(path.join(alvo, 'package.json'), JSON.stringify({ name: 'pb-smoke-alvo', version: '0.0.0', private: true }));
    log('instalando o tarball em diretório vazio …');
    execSync(`npm install ${JSON.stringify(tarball)} --no-audit --no-fund --prefer-offline`, {
      cwd: alvo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    });

    // 3) sobe os 3 bins — TODOS exit 0
    const passos = [
      ['prompt-builder --version', 'node_modules/.bin/prompt-builder', ['--version']],
      ['pbuilder --help', 'node_modules/.bin/pbuilder', ['--help']],
      ['npx prompt-builder-cli --help', 'npx', ['--no-install', 'prompt-builder-cli', '--help']],
    ];
    for (const [rotulo, cmd, args] of passos) {
      log(`smoke: ${rotulo}`);
      try {
        execFileSync(cmd, args, { cwd: alvo, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
      } catch (err) {
        const detalhe = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
        throw new Error(`bin recusou: ${rotulo} (exit ${err.status ?? '?'})\n${detalhe}`);
      }
    }
    log('ok — 3/3 bins responderam (exit 0)');
    return { tarball, alvo };
  } finally {
    if (!keep) rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  try {
    smokeInstall();
    return 0;
  } catch (err) {
    log(`FALHOU: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
