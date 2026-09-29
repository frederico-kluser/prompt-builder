#!/usr/bin/env node
// Gate de empacotamento do tarball npm (IMPL-102/IMPL-103, R-18:REC-10/REC-5).
//
// Regra de ouro: o `files` do package.json é ALLOWLIST POSITIVA. O npm-packlist
// DESCARTA em silêncio negações que não casam nada — "excluir por negação" é
// dívida que estoura em silêncio (foi assim que `dist/agentRoutes.*` escapou
// para o tarball por meses). Aqui nada é excluído por negação: o que sai é
// decidido por lista positiva e este gate reprova o que estiver fora.
//
// Uso:
//   node scripts/tarball-gate.mjs             invariantes + diff (aviso local)
//   node scripts/tarball-gate.mjs --strict    diff também REPROVA (CI/prepublish)
//   node scripts/tarball-gate.mjs --update    regenera a allowlist versionada
//
// O que é checado SEMPRE (mesmo local):
//   (a) nenhum `*.d.ts.map`/`*.js.map`/`*.tsbuildinfo` (mapas apontam para fora
//       do tarball — 72 `.d.ts.map` apontavam para ../src/*.ts ausente);
//   (b) nenhum `dist/server.*`, `dist/routes.*`, `dist/agentRoutes.*` (o modo
//       agente importa express, que é devDependency: quebrava em runtime);
//   (c) `files` sem negação (`!`) e sem entrada morta (aponta para nada);
//   (d) todo arquivo embarcado casa a regra positiva derivada de `src/`
//       (arquivo EXTRA injetado reprova — é a prova negativa do critério);
//   (e) completude: todo módulo de `src/` já compilado em `dist/` tem de estar
//       no tarball — ERRO (um módulo fora do `files` quebra o CLI instalado ao
//       ser importado: foi o `dist/costSamplesStore`); `dist/` órfão (sem a
//       fonte em `src/`, build velho) fica como aviso.
//
// O diff contra `scripts/tarball-allowlist.json` (allowlist VERSIONADA) trava
// só em `--strict`/CI para não entupir o fluxo local: arquivo a mais ⇒ "rode
// node scripts/tarball-gate.mjs --update"; arquivo a menos ⇒ sumiu do pacote.
// O `npm test` (test/tarball-gate.test.ts) roda ESTE mesmo `gate({strict})` e
// ainda confere a allowlist contra `src/` sem depender de build
// (`allowlistContract`) — o drift reprova antes de chegar ao job de release.
//
// `--update` recusa regravar a allowlist com `dist/` ausente ou incompleto
// (sem build o `npm pack` sairia sem o código e a allowlist "encolheria").

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ALLOWLIST_FILE = path.join(ROOT, 'scripts', 'tarball-allowlist.json');

/** Fontes que NÃO viram pacote (servidor/express — só dev/self-host). */
export const NOT_SHIPPED = ['src/server.ts', 'src/routes.ts', 'src/agentRoutes.ts', 'src/httpRunControl.ts'];
/** Nomes compilados proibidos em dist/ (derivados de NOT_SHIPPED). */
export const FORBIDDEN_DIST_STEMS = ['server', 'routes', 'agentRoutes', 'httpRunControl'];

// ---------------------------------------------------------------------------
// Regras positivas (puras — testadas em test/tarball-gate.test.ts)
// ---------------------------------------------------------------------------

const ROOT_META = /^(?:package\.json|readme(?:\..*)?|licen[cs]e(?:\..*)?|changelog(?:\..*)?)$/iu;

/** Um caminho do tarball é permitido? `sources` = lista de `src/<rel>.ts`. */
export function isAllowedPath(p, sources) {
  const src = new Set(sources);
  if (!p.includes('/') && ROOT_META.test(p)) return true;
  // Instalador global da skill de agente (bash, zero dependências) — embarca para
  // instalar por symlink a partir do checkout OU de node_modules/prompt-builder-cli.
  if (p === 'scripts/install-agent-skill.sh') return true;
  // Setup completo para agentes (lançadores do CLI + skill + Plannotator do
  // relatório de ciclos) — o `npm run agent-setup`, também rodável do pacote.
  if (p === 'scripts/agent-setup.sh') return true;
  if (p.startsWith('agent-docs/') || p.startsWith('skills/')) return true;
  if (/^src\/data\/[^/]+\.json$/u.test(p)) return true;
  const m = /^dist\/(.+)\.(js|d\.ts)$/u.exec(p);
  if (!m) return false;
  const rel = m[1];
  if (FORBIDDEN_DIST_STEMS.includes(rel)) return false;
  return src.has(`src/${rel}.ts`);
}

/** Glob simples das entradas do `files` (suficiente para os padrões usados aqui). */
function globToRegExp(entry) {
  // Passe única: substituições sucessivas mutilariam o texto já inserido
  // (o `*` de '(?:.*/)?' era re-escapado pela regra seguinte).
  let pat = '';
  for (let i = 0; i < entry.length; i++) {
    const c = entry[i];
    if (c === '*' && entry[i + 1] === '*') {
      if (entry[i + 2] === '/') {
        pat += '(?:[^/]+/)*'; // '**/' = zero ou mais diretórios
        i += 2;
      } else {
        pat += '.*'; // '**' = o resto
        i += 1;
      }
    } else if (c === '*') {
      pat += '[^/]*';
    } else if (c === '?') {
      pat += '[^/]';
    } else if (/[.+^${}()|[\]\\]/u.test(c)) {
      pat += `\\${c}`;
    } else {
      pat += c;
    }
  }
  // entrada de diretório ('agent-docs') cobre tudo dentro dela
  const dir = /[*?]/u.test(entry) ? '' : '(?:/.*)?';
  return new RegExp(`^${pat}${dir}$`, 'u');
}

/** A entrada `files` casa algum caminho (embarcado ou existente em disco)? */
export function entryMatches(entry, paths) {
  const re = globToRegExp(entry);
  return paths.some((p) => re.test(p));
}

/**
 * Checagem do conteúdo do tarball. `sources` = fontes .ts de src/ (relativas);
 * `built` = o que existe em dist/ (completude; vazio = pulado); `existing` =
 * caminhos vivos do repositório (detecta entrada morta no `files`).
 */
export function checkTarball({ packed, files, sources, built = [], existing = packed }) {
  const errors = [];
  const warnings = [];

  for (const p of packed) {
    if (/\.(?:d\.ts|js)\.map$/u.test(p) || p.endsWith('.tsbuildinfo')) {
      errors.push(`mapa de declaração/origem no tarball (aponta para fora): ${p}`);
      continue;
    }
    if (/^dist\/(?:server|routes|agentRoutes)\./u.test(p)) {
      errors.push(`módulo de servidor no tarball (importa express, devDependency): ${p}`);
      continue;
    }
    if (!isAllowedPath(p, sources)) {
      errors.push(`arquivo FORA da allowlist positiva: ${p}`);
    }
  }

  for (const entry of files ?? []) {
    if (entry.startsWith('!')) {
      errors.push(`entrada de negação no files (nunca dependa de negação): ${entry}`);
      continue;
    }
    if (!entryMatches(entry, [...packed, ...existing])) {
      errors.push(`entrada morta no files (não casa nada): ${entry}`);
    }
  }

  // Completude: o que já está compilado tem de ir no tarball (só faz sentido
  // com dist/ preenchido — local pode estar velho; CI/prepublish roda no build).
  const fontes = new Set(sources);
  for (const b of built) {
    const m = /^dist\/(.+)\.js$/u.exec(b);
    if (!m || FORBIDDEN_DIST_STEMS.includes(m[1])) continue;
    const rel = m[1];
    if (NOT_SHIPPED.includes(`src/${rel}.ts`)) continue;
    const temFonte = fontes.has(`src/${rel}.ts`);
    for (const out of [`dist/${rel}.js`, `dist/${rel}.d.ts`]) {
      if (built.includes(out) && !packed.includes(out)) {
        if (temFonte) {
          errors.push(`módulo de src/ compilado mas NÃO embarcado (files incompleto — o CLI instalado quebra ao importá-lo): ${out}`);
        } else {
          warnings.push(`compilado mas NÃO embarcado (dist/ velho? não existe src/${rel}.ts): ${out}`);
        }
      }
    }
  }

  return { errors, warnings };
}

/** Diff contra a allowlist versionada. */
export function diffAllowlist(packed, allowlist) {
  const set = new Set(allowlist);
  const have = new Set(packed);
  return {
    extra: packed.filter((p) => !set.has(p)).sort(),
    missing: allowlist.filter((p) => !have.has(p)).sort(),
  };
}

/**
 * O `dist/` que o tarball TEM de levar, derivado só das fontes (sem build):
 * cada `src/<rel>.ts` (menos declarações `.d.ts` e o que é só servidor) vira
 * `dist/<rel>.js` + `dist/<rel>.d.ts`.
 */
export function expectedDist(sources) {
  const out = [];
  for (const s of sources) {
    if (!s.endsWith('.ts') || s.endsWith('.d.ts') || NOT_SHIPPED.includes(s)) continue;
    const rel = s.replace(/^src\//u, '').replace(/\.ts$/u, '');
    out.push(`dist/${rel}.js`, `dist/${rel}.d.ts`);
  }
  return out.sort();
}

/**
 * Contrato da allowlist versionada que NÃO depende de build (roda no `npm test`
 * mesmo com `dist/` velho): a parte `dist/` tem de ser exatamente
 * {@link expectedDist} e o resto (docs, skills, scripts, dados) exatamente o
 * que o `npm pack` embarca fora de `dist/`. Módulo novo em `src/` sem
 * `--update` (ou fora do `files`) e doc nova sem `--update` reprovam aqui.
 */
export function allowlistContract({ allowlist, sources, packed }) {
  const esperado = [...expectedDist(sources), ...packed.filter((p) => !p.startsWith('dist/'))];
  return diffAllowlist(esperado, allowlist);
}

/** Lê a allowlist versionada (`null` = ausente/ilegível). */
export function readAllowlist(file = ALLOWLIST_FILE) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf-8'));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Lista REAL do que o npm embarcaria (sem ciclo de vida: nada de build aqui). */
export function packList(root = ROOT) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  const parsed = JSON.parse(out);
  return parsed[0].files.map((f) => f.path).sort();
}

/**
 * Arquivos sob `dir` (caminhos com `/`, prefixados por `prefix`). NÃO segue
 * symlink de diretório e poda `node_modules` e pastas ocultas (`.git`,
 * `.claude/worktrees` com outros checkouts…): o `readdirSync({recursive})`
 * seguia links — num worktree com `node_modules` linkado, um link que aponta
 * para si mesmo dava ELOOP e derrubava o gate, e na raiz ele varria centenas
 * de milhares de arquivos que nunca embarcam.
 */
export function walk(dir, prefix) {
  const out = [];
  const visitar = (abs, rel) => {
    let entradas;
    try {
      entradas = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entradas) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        visitar(path.join(abs, e.name), r);
      } else if (e.isFile() || (e.isSymbolicLink() && ehArquivo(path.join(abs, e.name)))) {
        out.push(prefix ? `${prefix}/${r}` : r);
      }
    }
  };
  if (existsSync(dir)) visitar(dir, '');
  return out;
}

function ehArquivo(abs) {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** Fontes `.ts` de `src/` (relativas à raiz, ordenadas). */
export function listSources(root = ROOT) {
  return walk(path.join(root, 'src'), 'src').filter((p) => p.endsWith('.ts')).sort();
}

/**
 * O gate inteiro — o MESMO caminho do `prepublishOnly`/CI e do teste de
 * contrato. `packed` pode vir pronto (o teste reaproveita um `npm pack`).
 * Devolve os achados; quem imprime/decide o exit é o `main`.
 */
export function gate({ root = ROOT, strict = false, packed = packList(root), allowlistFile = ALLOWLIST_FILE } = {}) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
  const sources = listSources(root);
  const built = walk(path.join(root, 'dist'), 'dist').sort();
  const existing = [
    ...packed,
    ...walk(root),
    ...built,
    ...sources,
    'agent-docs', 'skills', 'README.md', 'LICENSE', 'package.json',
  ];

  const { errors, warnings } = checkTarball({ packed, files: pkg.files ?? [], sources, built, existing });

  const allowlist = readAllowlist(allowlistFile);
  const diffProblems = [];
  if (allowlist === null) {
    diffProblems.push('allowlist versionada ausente/ilegível — rode: npm run build && node scripts/tarball-gate.mjs --update');
  } else {
    const { extra, missing } = diffAllowlist(packed, allowlist);
    for (const p of extra) diffProblems.push(`a MAIS no tarball (allowlist desatualizada? rode --update): ${p}`);
    for (const p of missing) diffProblems.push(`a MENOS no tarball (sumiu? build velho?): ${p}`);
  }

  // Sem build o tarball sai sem o código: o que falta de dist/ é dito como tal.
  const semBuild = expectedDist(sources).filter((p) => !packed.includes(p));

  const failed = errors.length > 0 || (strict && diffProblems.length > 0);
  return { packed, sources, errors, warnings, diffProblems, semBuild, strict, failed };
}

function main(argv) {
  const strict = argv.includes('--strict') || process.env.CI === 'true';
  const update = argv.includes('--update');
  const r = gate({ strict });

  if (update) {
    for (const e of r.errors) process.stderr.write(`[tarball-gate] ERRO: ${e}\n`);
    if (r.semBuild.length > 0) {
      process.stderr.write(
        `[tarball-gate] --update RECUSADO: ${r.semBuild.length} arquivo(s) de dist/ esperados fora do tarball ` +
          `(ex.: ${r.semBuild[0]}) — rode \`npm run build\` (e confira o files do package.json) antes.\n`,
      );
      return 1;
    }
    writeFileSync(ALLOWLIST_FILE, `${JSON.stringify(r.packed, null, 2)}\n`, 'utf-8');
    process.stderr.write(
      `[tarball-gate] allowlist atualizada: ${r.packed.length} arquivos em scripts/tarball-allowlist.json\n`,
    );
    return r.errors.length ? 1 : 0;
  }

  for (const w of r.warnings) process.stderr.write(`[tarball-gate] aviso: ${w}\n`);
  if (r.diffProblems.length && !strict) {
    for (const d of r.diffProblems) process.stderr.write(`[tarball-gate] aviso (diff): ${d}\n`);
    process.stderr.write('[tarball-gate] diff só reprova em --strict/CI (nada travado localmente)\n');
  }
  for (const e of r.errors) process.stderr.write(`[tarball-gate] ERRO: ${e}\n`);
  if (strict) for (const d of r.diffProblems) process.stderr.write(`[tarball-gate] ERRO (diff): ${d}\n`);

  process.stderr.write(`[tarball-gate] ${r.packed.length} arquivos no tarball — ${r.failed ? 'REPROVADO' : 'ok'}\n`);
  return r.failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
