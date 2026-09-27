// IMPL-103/104/105 (R-18:REC-5/REC-1/REC-2) — gates de empacotamento e release.
//
// (IMPL-103) o `prepublishOnly` só rodava o build: nada de publint/attw, nada
//   de diff do tarball contra allowlist, nada de instalar o tarball num
//   diretório vazio e subir os 3 bins (o caso `npx prompt-builder-cli` já
//   quebrou por homônimo de bin). Contrato: os 5 passos estão no prepublishOnly.
//
// (IMPL-104) publicação manual com token, sem provenance. Contrato: existe UM
//   único workflow que publica (`publish-npm.yml`), com OIDC (`id-token: write`),
//   npm ≥ 11.5.1, verificação de `dist.attestations`, e NENHUMA referência a
//   `NPM_TOKEN`/`NODE_AUTH_TOKEN` nas secrets — o teste negativo (publish fora
//   do workflow registrado falha) está documentado no cabeçalho do workflow.
//
// (IMPL-105) sem changesets: releases sem notas humanas. Contrato: `.changeset/`
//   configurado, PR "Version Packages" gerado pelo changesets/action, notas
//   humanas presentes e `npm publish` SÓ dentro do job disparado por tag.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');
const workflows = new Map<string, string>(
  readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => [f, readFileSync(path.join(WORKFLOWS_DIR, f), 'utf-8')]),
);
const publish = workflows.get('publish-npm.yml') ?? '';

describe('IMPL-103 prepublishOnly: os 5 gates rodam ANTES de qualquer publish', () => {
  it('prepublishOnly = build + npm test + publint + attw + allowlist + smoke, nessa ordem', () => {
    const s = pkg.scripts.prepublishOnly ?? '';
    const ordem = ['npm run build', 'npm test', 'gate:publint', 'gate:attw', 'gate:tarball', 'gate:smoke'];
    let cursor = -1;
    for (const passo of ordem) {
      const i = s.indexOf(passo);
      expect(i, `falta o passo "${passo}" em prepublishOnly`).toBeGreaterThan(cursor);
      cursor = i;
    }
  });

  it('os gates existem como scripts e apontam para código versionado', () => {
    expect(pkg.scripts['gate:publint']).toBe('publint');
    expect(pkg.scripts['gate:attw']).toContain('attw --pack');
    expect(pkg.scripts['gate:tarball']).toBe('node scripts/tarball-gate.mjs');
    expect(pkg.scripts['gate:smoke']).toBe('node scripts/tarball-smoke.mjs');
    expect(existsSync(path.join(ROOT, 'scripts', 'tarball-gate.mjs'))).toBe(true);
    expect(existsSync(path.join(ROOT, 'scripts', 'tarball-smoke.mjs'))).toBe(true);
  });

  it('ferramentas dos gates são devDependencies (reprodutível no CI)', () => {
    expect(pkg.devDependencies.publint).toBeTruthy();
    expect(pkg.devDependencies['@arethetypeswrong/cli']).toBeTruthy();
    expect(pkg.devDependencies['@changesets/cli']).toBeTruthy();
  });

  it('smoke instala o tarball em diretório vazio e sobe os 3 bins (o caso npx)', () => {
    const smoke = readFileSync(path.join(ROOT, 'scripts', 'tarball-smoke.mjs'), 'utf-8');
    expect(smoke).toMatch(/npm install/u);
    expect(smoke).toContain('prompt-builder');
    expect(smoke).toContain('pbuilder');
    expect(smoke).toContain('prompt-builder-cli');
    expect(smoke).toContain('--no-install'); // npx sem rede: o bin TEM de existir no pacote
  });
});

describe('IMPL-104 trusted publishing (OIDC): publish só no workflow registrado', () => {
  it('publish-npm.yml é o ÚNICO workflow que roda `npm publish`', () => {
    const publicadores = [...workflows.entries()].filter(([, yml]) => /npm publish/u.test(yml)).map(([nome]) => nome);
    expect(publicadores).toEqual(['publish-npm.yml']);
  });

  it('o publish job usa OIDC (id-token: write) e npm ≥ 11.5.1', () => {
    expect(publish).toContain('id-token: write');
    expect(publish).toMatch(/npm install -g npm@\^11\.5\.[0-9]+/u);
    expect(publish).toContain('registry-url: https://registry.npmjs.org');
  });

  it('nenhum token npm longevo em qualquer workflow (critério: sem NPM_TOKEN)', () => {
    for (const [nome, yml] of workflows) {
      expect(yml, nome).not.toMatch(/secrets\.(?:NPM_TOKEN|NODE_AUTH_TOKEN)/u);
    }
  });

  it('o publish SÓ acontece em ref de tag (workflow disparado por tag)', () => {
    expect(publish).toContain("tags: ['v*']");
    expect(publish).toContain("if: github.ref_type == 'tag'");
    // e o job de versionamento NÃO publica
    const versionJob = publish.slice(publish.indexOf('version-pr:'), publish.indexOf('publish:'));
    expect(versionJob).not.toMatch(/npm publish/u);
  });

  it('provenance é verificado DEPOIS do publish (dist.attestations)', () => {
    expect(publish).toContain('dist.attestations');
    const iP = publish.indexOf('npm publish');
    const iA = publish.indexOf('dist.attestations');
    expect(iA).toBeGreaterThan(iP); // a verificação vem depois
  });

  it('teste negativo documentado + registo do trusted publisher no cabeçalho', () => {
    expect(publish).toContain('TESTE NEGATIVO');
    expect(publish).toMatch(/Trusted Publisher/iu);
    expect(publish).toContain('publish-npm.yml');
  });
});

describe('IMPL-105 changesets: notas humanas e PR de versionamento', () => {
  it('.changeset/config.json existe e fixa access public + baseBranch main', () => {
    const cfg = JSON.parse(readFileSync(path.join(ROOT, '.changeset', 'config.json'), 'utf-8'));
    expect(cfg.access).toBe('public');
    expect(cfg.baseBranch).toBe('main');
    expect(cfg.commit).toBe(false);
  });

  it('scripts do changesets: `changeset` e `version-packages` (nada que publique)', () => {
    expect(pkg.scripts.changeset).toBe('changeset');
    expect(pkg.scripts['version-packages']).toBe('changeset version');
    for (const [nome, cmd] of Object.entries(pkg.scripts)) {
      expect(cmd, `script "${nome}" não pode publicar npm fora do workflow`).not.toMatch(/npm publish|changeset publish/u);
    }
  });

  it('PR "Version Packages" vem do changesets/action com tag/dispatch no publish', () => {
    expect(publish).toContain('changesets/action@v1');
    expect(publish).toContain('version: npm run version-packages');
    expect(publish).toContain('publish: node scripts/release-tag.mjs');
    expect(existsSync(path.join(ROOT, 'scripts', 'release-tag.mjs'))).toBe(true);
  });

  it('o release-tag cria a tag v<versão> e dispara o workflow nela (≤2 ações manuais)', () => {
    const tag = readFileSync(path.join(ROOT, 'scripts', 'release-tag.mjs'), 'utf-8');
    expect(tag).toContain("['tag', tag]");
    expect(tag).toContain("['push', 'origin', tag]");
    expect(tag).toContain('workflow');
    expect(tag).toContain('run');
    expect(tag).toContain('New tag:'); // convenção do changesets/action p/ GitHub Release
  });

  it('há notas humanas em .changeset/ (1 changeset = 1 PR) e um README do fluxo', () => {
    const arquivos = readdirSync(path.join(ROOT, '.changeset')).filter((f) => f.endsWith('.md'));
    expect(arquivos).toContain('README.md');
    const changesets = arquivos.filter((f) => f !== 'README.md');
    expect(changesets.length).toBeGreaterThanOrEqual(1);
    for (const f of changesets) {
      const txt = readFileSync(path.join(ROOT, '.changeset', f), 'utf-8');
      expect(txt, `changeset ${f} sem bump`).toMatch(/^---\n"prompt-builder-cli": (major|minor|patch)\n---/u);
      expect(txt.split('---').at(-1)!.trim().length, `changeset ${f} sem notas`).toBeGreaterThan(80);
    }
  });
});
