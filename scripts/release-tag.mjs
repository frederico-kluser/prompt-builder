#!/usr/bin/env node
// Tag de release + disparo do publish (IMPL-105, R-18:REC-2).
//
// Este script é o `publish` do changesets/action: roda a cada push no main sem
// changeset pendente — em particular quando o PR "Version Packages" é MERGED
// (a versão no package.json ainda não existe no npm). Ele
//  1. confere no registry se `<pacote>@<versão>` já saiu (idempotente: sim ⇒
//     nada a fazer). Só um 404 conta como "não publicado": falha de rede/registry
//     ABORTA — sem isso, um registry fora do ar viraria tag + disparo às cegas;
//  2. cria e faz push da tag `v<versão>` (o registro durável do que saiu);
//  3. dispara o `publish-npm.yml` NESSA TAG via `gh workflow run` — porque o
//     push da tag feito com GITHUB_TOKEN não dispara workflows (guarda de
//     recursão do GitHub), enquanto `workflow_dispatch` é isento dela;
//  4. imprime `New tag: vX.Y.Z` (o changesets/action lê isto para criar a
//     GitHub Release associada à tag).
//
// O `npm publish` em si acontece SÓ no job `publish` do `publish-npm.yml`,
// cuja referência é a tag (trusted publishing OIDC, sem token npm).
//
// `releaseTag({ run, write, narrate })` recebe o executor de comandos e as
// saídas (stdout = só a linha "New tag:", stderr = narração): o teste de
// contrato (test/release-gates.test.ts) prova a sequência sem git/npm/gh reais.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKFLOW = 'publish-npm.yml';

function log(msg) {
  process.stderr.write(`[release-tag] ${msg}\n`);
}

/** Executor real: nunca lança por exit ≠ 0 (quem decide é o chamador). */
export function spawnRun(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, ...opts });
  if (r.error) return { status: null, stdout: '', stderr: String(r.error.message ?? r.error) };
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A saída do `npm view` é o 404 de "versão/pacote inexistente" (e não rede/auth)? */
export function isNpmNotFound(r) {
  return /\bE404\b|\b404\b/u.test(`${r.stderr}\n${r.stdout}`);
}

function must(r, oque) {
  if (r.status !== 0) {
    throw new Error(`${oque} falhou (exit ${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
  }
  return r;
}

export function releaseTag({
  root = ROOT,
  env = process.env,
  run = spawnRun,
  write = (s) => process.stdout.write(s),
  narrate = log,
} = {}) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
  const version = pkg.version;
  const tag = `v${version}`;

  // 1. Idempotente: versão já publicada ⇒ nada a fazer (re-execução do job,
  //    push no main sem release pendente).
  const view = run('npm', ['view', `${pkg.name}@${version}`, 'version'], { cwd: root, timeout: 60_000 });
  if (view.status === 0 && view.stdout.trim()) {
    narrate(`${pkg.name}@${version} já está no registry — nada a publicar`);
    return { tag, published: true, dispatched: false };
  }
  if (view.status !== 0 && !isNpmNotFound(view)) {
    // Rede/registry/auth: não dá para saber se saiu. Abortar é o seguro — o
    // próximo push no main (ou re-run do job) tenta de novo.
    must(view, `npm view ${pkg.name}@${version}`);
  }

  // 2. Tag (idempotente: re-execução depois de um dispatch que falhou).
  const temTag = run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { cwd: root }).status === 0;
  if (temTag) {
    narrate(`tag ${tag} já existe — pulando o tag`);
  } else {
    must(run('git', ['tag', tag], { cwd: root }), `git tag ${tag}`);
    must(run('git', ['push', 'origin', tag], { cwd: root }), `git push origin ${tag}`);
    narrate(`tag ${tag} criada e enviada`);
  }

  // 3. Dispara o workflow NA TAG (a referência do run vira refs/tags/<tag>).
  //    GH_TOKEN = o token do Actions (permissão `actions: write` do job), mesmo
  //    quando o PR "Version Packages" usa um token próprio em GITHUB_TOKEN.
  must(
    run('gh', ['workflow', 'run', WORKFLOW, '--ref', tag], {
      cwd: root,
      env: { ...env, GH_TOKEN: env.GH_TOKEN ?? env.GITHUB_TOKEN },
      timeout: 60_000,
    }),
    `gh workflow run ${WORKFLOW} --ref ${tag}`,
  );
  narrate(`${WORKFLOW} disparado na tag ${tag}`);

  // 4. Convenção do changesets/action: linhas "New tag:" geram a GitHub Release.
  write(`New tag: ${tag}\n`);
  return { tag, published: false, dispatched: true };
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
