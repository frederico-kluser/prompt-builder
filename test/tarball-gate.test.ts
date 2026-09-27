// IMPL-102 (R-18:REC-6) — conteúdo do tarball npm por ALLOWLIST POSITIVA.
//
// O `files` do package.json usava negações ('!dist/server.*') e o npm-packlist
// descarta em silêncio negações que não casam: `dist/agentRoutes.*` (que importa
// express, devDependency — quebra em runtime) escapava para o tarball e 72
// `.d.ts.map` apontavam para `../src/*.ts` ausente. Critérios:
//
//  (1) `npm pack --dry-run --json` NÃO contém `dist/agentRoutes.*` nem
//      `*.d.ts.map` (verificado no repo real e num pacote-fantasma com o MESMO
//      `files` — independente do estado do build);
//  (2) prova negativa: arquivo extra injetado no tarball REPROVA o gate de
//      allowlist (função pura + diff com a allowlist versionada);
//  (3) publint e attw continuam verdes — os gates `gate:publint`/`gate:attw`
//      entram no `prepublishOnly` (o output é verificado na release/CI).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkTarball, diffAllowlist, entryMatches, isAllowedPath } from '../scripts/tarball-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { files: string[] };

function packList(dir: string): string[] {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  const parsed = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  return parsed[0]!.files.map((f) => f.path).sort();
}

/** Caminhos vivos do repo nas áreas que o `files` cobre (independente de build). */
function vivos(): string[] {
  const out: string[] = [];
  for (const nome of readdirSync(ROOT)) {
    if (statSync(path.join(ROOT, nome)).isFile()) out.push(nome);
  }
  for (const dir of ['src', 'dist', 'agent-docs', 'skills']) {
    const base = path.join(ROOT, dir);
    if (!existsSync(base)) continue;
    for (const nome of readdirSync(base, { recursive: true })) {
      const abs = path.join(base, nome);
      if (statSync(abs).isFile()) out.push(`${dir}/${String(nome).split(path.sep).join('/')}`);
    }
  }
  return out;
}

const SOURCES = [
  'src/index.ts',
  'src/lgpd.ts',
  'src/cli/index.ts',
  'src/cli/commands/run.ts',
  'src/server.ts',
  'src/routes.ts',
  'src/agentRoutes.ts',
];
const FILES = [
  'dist/*/**/*.js',
  'dist/*/**/*.d.ts',
  'dist/lgpd.js',
  'dist/lgpd.d.ts',
  'dist/index.js',
  'dist/index.d.ts',
  'src/data/lgpd-retention.json',
  'agent-docs',
  'skills',
];
const CLEAN = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/lgpd.js',
  'dist/lgpd.d.ts',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/cli/index.js',
  'dist/cli/index.d.ts',
  'src/data/lgpd-retention.json',
  'agent-docs/intro.md',
  'skills/prompt-builder/SKILL.md',
];

describe('IMPL-102 (2) gate de allowlist: arquivo extra injetado reprova', () => {
  it('pacote limpo passa; injetar dist/evil.js (sem src/evil.ts) reprova', () => {
    expect(checkTarball({ packed: CLEAN, files: FILES, sources: SOURCES }).errors).toEqual([]);
    const comExtra = checkTarball({ packed: [...CLEAN, 'dist/evil.js'], files: FILES, sources: SOURCES });
    expect(comExtra.errors).toEqual([expect.stringContaining('FORA da allowlist positiva: dist/evil.js')]);
  });

  it('extra injetado também reprova o diff contra a allowlist versionada', () => {
    const { extra, missing } = diffAllowlist([...CLEAN, 'dist/evil.js'], CLEAN);
    expect(extra).toEqual(['dist/evil.js']);
    expect(missing).toEqual([]);
  });

  it('arquivo que sumiu do tarball aparece como "a menos" (prova A/B do diff)', () => {
    const { extra, missing } = diffAllowlist(CLEAN.slice(0, -1), CLEAN);
    expect(extra).toEqual([]);
    expect(missing).toEqual(['skills/prompt-builder/SKILL.md']);
  });
});

describe('IMPL-102 (1) invariantes: sem agentRoutes, sem .d.ts.map, sem negação', () => {
  it('dist/agentRoutes.* reprova (o bug real: importava express, devDependency)', () => {
    for (const p of ['dist/agentRoutes.js', 'dist/agentRoutes.d.ts']) {
      const r = checkTarball({ packed: [...CLEAN, p], files: FILES, sources: SOURCES });
      expect(r.errors.join('\n')).toContain(p);
    }
  });

  it('*.d.ts.map / *.js.map / *.tsbuildinfo reprovam (apontavam para ../src ausente)', () => {
    for (const p of ['dist/lgpd.d.ts.map', 'dist/cli/index.d.ts.map', 'dist/index.js.map', 'dist/x.tsbuildinfo']) {
      const r = checkTarball({ packed: [...CLEAN, p], files: FILES, sources: SOURCES });
      expect(r.errors.join('\n'), p).toContain(p);
    }
  });

  it('dist/server.* e dist/routes.* (só dev/self-host) também reprova', () => {
    for (const p of ['dist/server.js', 'dist/routes.js']) {
      const r = checkTarball({ packed: [...CLEAN, p], files: FILES, sources: SOURCES });
      expect(r.errors.join('\n'), p).toContain(p);
    }
  });

  it('entrada de NEGAÇÃO no files reprova (nunca dependa de negação)', () => {
    const r = checkTarball({ packed: CLEAN, files: [...FILES, '!dist/agentRoutes.*'], sources: SOURCES });
    expect(r.errors.join('\n')).toContain('negação');
  });

  it('entrada MORTA no files reprova (regressão ARENA-CONFIG.md)', () => {
    const r = checkTarball({ packed: CLEAN, files: [...FILES, 'ARENA-CONFIG.md'], sources: SOURCES, existing: CLEAN });
    expect(r.errors.join('\n')).toContain('entrada morta');
  });

  it('módulo compilado mas fora do files vira aviso de completude', () => {
    const r = checkTarball({
      packed: CLEAN,
      files: FILES,
      sources: SOURCES,
      built: ['dist/lgpd.js', 'dist/lgpd.d.ts', 'dist/novo.js', 'dist/novo.d.ts'],
    });
    expect(r.warnings.join('\n')).toContain('dist/novo.js');
    expect(r.warnings.join('\n')).toContain('dist/novo.d.ts');
    expect(r.errors).toEqual([]);
  });

  it('regras positivas: o que embarca e o que não embarca', () => {
    expect(isAllowedPath('dist/cli/commands/run.js', SOURCES)).toBe(true);
    expect(isAllowedPath('dist/index.js', SOURCES)).toBe(true);
    expect(isAllowedPath('src/data/lgpd-retention.json', SOURCES)).toBe(true);
    expect(isAllowedPath('skills/prompt-builder/SKILL.md', SOURCES)).toBe(true);
    expect(isAllowedPath('dist/lgpd.d.ts', SOURCES)).toBe(true);
    expect(isAllowedPath('scratchpad/x.md', SOURCES)).toBe(false);
    expect(isAllowedPath('test/x.test.ts', SOURCES)).toBe(false);
    expect(isAllowedPath('dist/lgpd.d.ts.map', SOURCES)).toBe(false);
    expect(isAllowedPath('dist/fantasma.js', SOURCES)).toBe(false); // sem src/fantasma.ts
  });

  it('glob das entradas do files: cobre subdirs e NÃO cobre o topo fora da lista', () => {
    expect(entryMatches('dist/*/**/*.js', ['dist/cli/index.js'])).toBe(true);
    expect(entryMatches('dist/*/**/*.js', ['dist/cli/commands/run.js'])).toBe(true);
    expect(entryMatches('dist/*/**/*.js', ['dist/x.js'])).toBe(false); // topo: só por enumeração
    expect(entryMatches('dist/*/**/*.js', ['dist/x.d.ts.map'])).toBe(false);
    expect(entryMatches('dist/lgpd.js', ['dist/lgpd.js'])).toBe(true);
    expect(entryMatches('agent-docs', ['agent-docs/a/b.md'])).toBe(true); // entrada de diretório
  });
});

describe('IMPL-102 (1) npm pack real: sem agentRoutes.* e sem *.d.ts.map', () => {
  it('o MESMO files do package.json num pacote-fantasma seleciona o que deve', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pb-pack-ghost-'));
    try {
      for (const f of [
        'dist/lgpd.js', 'dist/lgpd.d.ts', 'dist/lgpd.d.ts.map', // mapa: NÃO embarca
        'dist/index.js', 'dist/index.d.ts', // topo enumerado: embarca
        'dist/agentRoutes.js', 'dist/agentRoutes.d.ts', // servidor: NÃO embarca
        'dist/server.js', 'dist/routes.js', // idem
        'dist/cli/index.js', 'dist/cli/index.d.ts', // subdir: embarca
        'dist/engine/a.js', 'dist/engine/a.d.ts',
        'src/data/lgpd-compliance.json',
        'agent-docs/intro.md', 'skills/prompt-builder/SKILL.md',
      ]) {
        mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        writeFileSync(path.join(dir, f), 'x');
      }
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pb-pack-ghost', version: '0.0.0', files: pkg.files }));
      const packed = packList(dir);
      expect(packed).toContain('dist/lgpd.js');
      expect(packed).toContain('dist/lgpd.d.ts');
      expect(packed).toContain('dist/index.js'); // topo enumerado explicitamente
      expect(packed).toContain('dist/cli/index.js');
      expect(packed).toContain('dist/engine/a.d.ts');
      expect(packed).toContain('src/data/lgpd-compliance.json');
      expect(packed).toContain('skills/prompt-builder/SKILL.md');
      // CRITÉRIO (1): nada disto vai
      expect(packed.filter((p) => p.startsWith('dist/agentRoutes.'))).toEqual([]);
      expect(packed.filter((p) => p.endsWith('.d.ts.map'))).toEqual([]);
      expect(packed.filter((p) => /^dist\/(?:server|routes)\./u.test(p))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('o tarball REAL do repo passa no gate (erros = []) e não leva mapas/agentRoutes', () => {
    const packed = packList(ROOT);
    expect(packed.filter((p) => p.startsWith('dist/agentRoutes.'))).toEqual([]);
    expect(packed.filter((p) => /\.(?:d\.ts|js)\.map$/u.test(p))).toEqual([]);
    expect(packed).toContain('dist/cli/index.js'); // bin do pacote
    expect(packed).toContain('src/data/lgpd-retention.json'); // TTL LGPD viaja no tarball
    const sources = (readdirSync(path.join(ROOT, 'src'), { recursive: true }) as string[])
      .map((n) => `src/${n.split(path.sep).join('/')}`)
      .filter((p) => p.endsWith('.ts'));
    const r = checkTarball({ packed, files: pkg.files, sources, existing: vivos() });
    expect(r.errors).toEqual([]);
  });

  it('o files do package.json é POSITIVO, sem mortas e cobre os módulos de src/', () => {
    const files = pkg.files;
    expect(files.filter((e) => e.startsWith('!'))).toEqual([]);
    expect(files).not.toContain('ARENA-CONFIG.md');
    expect(files).not.toContain('dist'); // não "dist inteiro" + negações
    for (const e of files) {
      if (/[*?]/u.test(e)) continue; // glob: validado pelo gate acima
      if (e.startsWith('dist/')) {
        // entrada de build: tem de derivar de um módulo de src/ (senão é morta)
        const rel = e.replace(/^dist\//u, '').replace(/\.(?:js|d\.ts)$/u, '');
        const fonte = existsSync(path.join(ROOT, 'src', `${rel}.ts`)) || existsSync(path.join(ROOT, e));
        expect(fonte, `entrada morta no files: ${e}`).toBe(true);
      } else {
        expect(existsSync(path.join(ROOT, e)), `entrada morta no files: ${e}`).toBe(true);
      }
    }
  });
});
