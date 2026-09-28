#!/usr/bin/env node
// Tag de release + disparo do publish (IMPL-105, R-18:REC-2).
//
// Este script é o `publish` do changesets/action: roda quando o PR "Version
// Packages" é MERGED (a versão no package.json ainda não existe no npm). Ele
//  1. cria e faz push da tag `v<versão>` (o registro durável do que saiu);
//  2. dispara o `publish-npm.yml` NESSA TAG via `gh workflow run` — porque o
//     push da tag feito com GITHUB_TOKEN não dispara workflows (guarda de
//     recursão do GitHub), enquanto `workflow_dispatch` é isento dela;
//  3. imprime `New tag: vX.Y.Z` (o changesets/action lê isto para criar a
//     GitHub Release associada à tag).
//
// O `npm publish` em si acontece SÓ no job `publish` do `publish-npm.yml`,
// cuja referência é a tag (trusted publishing OIDC, sem token npm).

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = 'publish-npm.yml';

function log(msg) {
  process.stderr.write(`[release-tag] ${msg}\n`);
}

export function releaseTag({ root = ROOT, env = process.env } = {}) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
  const version = pkg.version;
  const tag = `v${version}`;

  // Idempotente: versão já publicada ⇒ nada a fazer (re-execução do job).
  try {
    const published = execSync(`npm view ${JSON.stringify(`${pkg.name}@${version}`)} version`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    }).trim();
    if (published) {
      log(`${pkg.name}@${version} já está no registry — nada a publicar`);
      return { tag, published: true };
    }
  } catch {
    // 404 = ainda não publicada (o caso normal)
  }

  try {
    execFileSync('git', ['rev-parse', tag], { cwd: root, stdio: 'ignore' });
    log(`tag ${tag} já existe — pulando o tag`);
  } catch {
    execFileSync('git', ['tag', tag], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', tag], { cwd: root, stdio: 'pipe' });
    log(`tag ${tag} criada e enviada`);
  }

  // Dispara o workflow NA TAG (a referência do run vira refs/tags/<tag>).
  execFileSync('gh', ['workflow', 'run', WORKFLOW, '--ref', tag], {
    cwd: root,
    stdio: 'pipe',
    env: { ...env, GH_TOKEN: env.GH_TOKEN ?? env.GITHUB_TOKEN },
    timeout: 60_000,
  });
  log(`${WORKFLOW} disparado na tag ${tag}`);

  // Convenção do changesets/action: linhas "New tag:" geram a GitHub Release.
  process.stdout.write(`New tag: ${tag}\n`);
  return { tag, published: false };
}

function main() {
  try {
    releaseTag();
    return 0;
  } catch (err) {
    log(`FALHOU: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
