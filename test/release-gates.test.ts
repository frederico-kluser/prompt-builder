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

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WORKFLOW, isNpmNotFound, releaseTag } from '../scripts/release-tag.mjs';

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
    // O passo de teste pode ser `npm test` (rápido) OU `npm run test:full`
    // (com docker/Monte Carlo completo — superset, o desejável no release).
    const ordem = ['npm run build', 'TESTE', 'gate:publint', 'gate:attw', 'gate:tarball', 'gate:smoke'];
    let cursor = -1;
    for (const passo of ordem) {
      const alvo =
        passo === 'TESTE' ? (s.includes('npm run test:full') ? 'npm run test:full' : 'npm test') : passo;
      const i = s.indexOf(alvo);
      expect(i, `falta o passo "${alvo}" em prepublishOnly`).toBeGreaterThan(cursor);
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

  it('o release-tag cria a tag v<versão> e dispara o workflow nela (≤2 ações manuais) — fonte', () => {
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

// ---------------------------------------------------------------------------
// IMPL-105 — comportamento do release-tag (executor falso: sem git/npm/gh reais)
// ---------------------------------------------------------------------------

interface Chamada {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}
type Resp = { status: number | null; stdout?: string; stderr?: string };

/** Pacote temporário com a versão do teste + executor que grava as chamadas. */
function cenario(respostas: (c: Chamada) => Resp) {
  const root = mkdtempSync(path.join(tmpdir(), 'pb-release-tag-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'prompt-builder-cli', version: '0.2.0' }));
  const chamadas: Chamada[] = [];
  const saida: string[] = [];
  const narracao: string[] = [];
  const run = (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}) => {
    const c = { cmd, args, env: opts.env };
    chamadas.push(c);
    const r = respostas(c);
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const exec = (env: NodeJS.ProcessEnv = { GITHUB_TOKEN: 'gh-actions' }) =>
    releaseTag({ root, env, run, write: (x: string) => void saida.push(x), narrate: (m: string) => void narracao.push(m) });
  return { root, chamadas, saida, narracao, exec, limpa: () => rmSync(root, { recursive: true, force: true }) };
}

const E404 = { status: 1, stderr: 'npm error code E404\nnpm error 404 No match found for version 0.2.0' };

describe('IMPL-105 release-tag: sequência tag → push → dispatch → "New tag:"', () => {
  it('versão nova (404 no registry): tag, push, dispatch NA TAG e a linha da GitHub Release', () => {
    const c = cenario(({ cmd, args }) => {
      if (cmd === 'npm') return E404;
      if (cmd === 'git' && args[0] === 'rev-parse') return { status: 1 };
      return { status: 0 };
    });
    try {
      const r = c.exec({ GITHUB_TOKEN: 'pr-token', GH_TOKEN: 'gh-actions' });
      expect(r).toEqual({ tag: 'v0.2.0', published: false, dispatched: true });
      expect(c.chamadas.map((x) => [x.cmd, ...x.args].join(' '))).toEqual([
        'npm view prompt-builder-cli@0.2.0 version',
        'git rev-parse --verify --quiet refs/tags/v0.2.0',
        'git tag v0.2.0',
        'git push origin v0.2.0',
        `gh workflow run ${WORKFLOW} --ref v0.2.0`,
      ]);
      // o dispatch usa o token do Actions, não o do PR
      expect(c.chamadas.at(-1)!.env!.GH_TOKEN).toBe('gh-actions');
      expect(c.saida).toEqual(['New tag: v0.2.0\n']); // stdout: SÓ a linha que o changesets/action lê
      expect(c.narracao).toEqual(['tag v0.2.0 criada e enviada', `${WORKFLOW} disparado na tag v0.2.0`]);
    } finally {
      c.limpa();
    }
  });

  it('sem GH_TOKEN, o dispatch herda o GITHUB_TOKEN', () => {
    const c = cenario(({ cmd, args }) => (cmd === 'npm' ? E404 : cmd === 'git' && args[0] === 'rev-parse' ? { status: 1 } : { status: 0 }));
    try {
      c.exec({ GITHUB_TOKEN: 'gh-actions' });
      expect(c.chamadas.at(-1)!.env!.GH_TOKEN).toBe('gh-actions');
    } finally {
      c.limpa();
    }
  });

  it('versão JÁ publicada: nada de tag nem dispatch (push no main sem release pendente)', () => {
    const c = cenario(({ cmd }) => (cmd === 'npm' ? { status: 0, stdout: '0.2.0\n' } : { status: 0 }));
    try {
      expect(c.exec()).toEqual({ tag: 'v0.2.0', published: true, dispatched: false });
      expect(c.chamadas.map((x) => x.cmd)).toEqual(['npm']);
      expect(c.narracao.join('\n')).toMatch(/já está no registry/u);
      expect(c.saida).toEqual([]);
    } finally {
      c.limpa();
    }
  });

  it('npm view com exit 0 e saída VAZIA (npm antigo: versão inexistente) conta como não publicada', () => {
    const c = cenario(({ cmd, args }) =>
      cmd === 'npm' ? { status: 0, stdout: '' } : cmd === 'git' && args[0] === 'rev-parse' ? { status: 1 } : { status: 0 },
    );
    try {
      expect(c.exec()).toEqual({ tag: 'v0.2.0', published: false, dispatched: true });
      expect(c.saida).toEqual(['New tag: v0.2.0\n']);
    } finally {
      c.limpa();
    }
  });

  it('tag já existe (re-execução após dispatch que falhou): não recria, só dispara', () => {
    const c = cenario(({ cmd }) => (cmd === 'npm' ? E404 : { status: 0 }));
    try {
      c.exec();
      const linhas = c.chamadas.map((x) => [x.cmd, ...x.args].join(' '));
      expect(linhas).not.toContain('git tag v0.2.0');
      expect(linhas).not.toContain('git push origin v0.2.0');
      expect(linhas.at(-1)).toBe(`gh workflow run ${WORKFLOW} --ref v0.2.0`);
      expect(c.saida).toEqual(['New tag: v0.2.0\n']);
    } finally {
      c.limpa();
    }
  });

  it('registry fora do ar (erro que NÃO é 404): aborta sem criar tag nem disparar', () => {
    const c = cenario(({ cmd }) => (cmd === 'npm' ? { status: 1, stderr: 'npm error code ECONNRESET\nnpm error network' } : { status: 0 }));
    try {
      expect(() => c.exec()).toThrow(/npm view/u);
      expect(c.chamadas.map((x) => x.cmd)).toEqual(['npm']);
      expect(c.saida).toEqual([]);
    } finally {
      c.limpa();
    }
  });

  it('push da tag ou dispatch que falham propagam o erro (o job fica vermelho, sem "New tag:")', () => {
    for (const falha of ['push', 'workflow']) {
      const c = cenario(({ cmd, args }) => {
        if (cmd === 'npm') return E404;
        if (cmd === 'git' && args[0] === 'rev-parse') return { status: 1 };
        if (args[0] === falha) return { status: 1, stderr: `${falha} negado` };
        return { status: 0 };
      });
      try {
        expect(() => c.exec(), falha).toThrow(/negado/u);
        expect(c.saida, falha).toEqual([]);
      } finally {
        c.limpa();
      }
    }
  });

  it('isNpmNotFound: só o 404 conta como "não publicado"', () => {
    expect(isNpmNotFound({ stdout: '', stderr: E404.stderr })).toBe(true);
    expect(isNpmNotFound({ stdout: '', stderr: 'npm error code ETIMEDOUT' })).toBe(false);
    expect(isNpmNotFound({ stdout: '', stderr: 'npm error code E401' })).toBe(false);
  });
});

describe('IMPL-105 o PR "Version Packages" depende de uma permissão do repositório', () => {
  it('o cabeçalho do workflow documenta o erro real, a opção do repo e a alternativa por secret', () => {
    expect(publish).toContain('GitHub Actions is not permitted to create or approve pull requests');
    expect(publish).toContain('Allow GitHub Actions to create and approve pull requests');
    expect(publish).toContain('can_approve_pull_request_reviews=true');
    expect(publish).toContain('RELEASE_PR_TOKEN');
  });

  it('version-pr: PR com o token próprio (se houver), dispatch sempre com o token do Actions', () => {
    const versionJob = publish.slice(publish.indexOf('version-pr:'), publish.indexOf('\n  publish:'));
    expect(versionJob).toContain('GITHUB_TOKEN: ${{ secrets.RELEASE_PR_TOKEN || secrets.GITHUB_TOKEN }}');
    expect(versionJob).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(versionJob).toContain('pull-requests: write');
    expect(versionJob).toContain('actions: write');
  });

  it('o README dos changesets lista os pré-requisitos humanos (trusted publisher + permissão de PR)', () => {
    const readme = readFileSync(path.join(ROOT, '.changeset', 'README.md'), 'utf-8');
    expect(readme).toMatch(/Trusted Publisher/u);
    expect(readme).toContain('Allow GitHub');
  });
});
