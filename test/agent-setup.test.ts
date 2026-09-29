// Contrato dos instaladores de agente (bash, embarcados no tarball):
//
//  - `scripts/install-agent-skill.sh` — liga a skill `prompt-builder` por symlink
//    nos diretórios de skills dos agentes (descoberta = fonte única, `dirs`);
//  - `scripts/agent-setup.sh` — o `npm run agent-setup`: lançadores do CLI em
//    ~/.local/bin + a skill + as skills do relatório de ciclos (Plannotator).
//
// Tudo roda contra um HOME FALSO (diretório temporário): nada toca o home real.
// O ambiente do processo filho é montado do zero (HOME, PATH, CLAUDE_CONFIG_DIR,
// XDG_CONFIG_HOME) para nenhuma variável do agente que roda o teste vazar.
// O Plannotator é um stub no PATH e as skills de relatório são pré-semeadas no
// ~/.agents/skills: o setup nunca vai à rede (PB_PLANNOTATOR_INSTALL=0, sem clone).
//
// skill-install#11 — o `doctor` usa o MESMO critério do `install`: cópia
//   desatualizada/alheia e link de outra origem são PROBLEMA (exit 1), não "ok".
// skill-install#12 — só é "desta skill" o link para esta origem ou para uma
//   skill com o marcador do prompt-builder-cli; outra skill homónima (mesmo
//   terminando em `.../skills/prompt-builder`) nunca é re-apontada nem removida.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(ROOT, 'scripts', 'install-agent-skill.sh');
const SETUP = path.join(ROOT, 'scripts', 'agent-setup.sh');
const SKILL_SRC = realpathSync(path.join(ROOT, 'skills', 'prompt-builder'));
const SKILL_MD = readFileSync(path.join(SKILL_SRC, 'SKILL.md'), 'utf8');
const CLI_JS = path.join(ROOT, 'dist', 'cli', 'index.js');
const VERSION = (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const BIN_MARK = '# managed-by: prompt-builder agent-setup';
const BINS = ['prompt-builder', 'pbuilder', 'prompt-builder-cli'];

const temps: string[] = [];
afterAll(() => {
  // rmSync recursivo NÃO segue symlinks: os links para skills/prompt-builder
  // somem sem tocar a skill do repositório.
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  out: string;
}

function sh(script: string, args: string[], env: NodeJS.ProcessEnv): Run {
  const r = spawnSync('bash', [script, ...args], { env, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}\n${r.stderr}` };
}

function write(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

/** Ambiente do filho montado do zero: só o que o teste decide. */
function envFor(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const stub = path.join(home, 'stub-bin');
  return {
    HOME: home,
    PATH: [stub, path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    LANG: 'C.UTF-8',
    ...extra,
  };
}

/** HOME falso mínimo (só o diretório; cada cenário semeia o que precisa). */
function bareHome(prefix = 'pb-agent-home-'): string {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  temps.push(home);
  return home;
}

/** Skill homónima de TERCEIROS (sem o marcador do prompt-builder-cli). */
function thirdPartySkill(base: string): string {
  const dir = path.join(base, 'thirdparty', 'skills', 'prompt-builder');
  write(path.join(dir, 'SKILL.md'), '---\nname: prompt-builder\ndescription: OUTRA skill de terceiros\n---\ncorpo\n');
  return dir;
}

/** Outro checkout/versão DESTE projeto (package.json do prompt-builder-cli). */
function otherCheckout(base: string, skillMd = `${SKILL_MD}\nversão antiga\n`): string {
  const raiz = path.join(base, 'checkout-antigo');
  write(path.join(raiz, 'package.json'), JSON.stringify({ name: 'prompt-builder-cli', version: '0.0.1' }, null, 2));
  write(path.join(raiz, 'skills', 'prompt-builder', 'SKILL.md'), skillMd);
  return path.join(raiz, 'skills', 'prompt-builder');
}

/** Estado observável de uma árvore (caminho → alvo do link | 'dir' | conteúdo). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const nome of readdirSync(d).sort()) {
      const p = path.join(d, nome);
      const st = lstatSync(p);
      const rel = path.relative(dir, p);
      if (st.isSymbolicLink()) out[rel] = `-> ${readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[rel] = 'dir';
        walk(p);
      } else out[rel] = `${readFileSync(p, 'utf8')}|${(st.mode & 0o777).toString(8)}`;
    }
  };
  walk(dir);
  return out;
}

function isLinkTo(p: string, alvo: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink() && realpathSync(p) === realpathSync(alvo);
  } catch {
    return false;
  }
}

const hasBash = process.platform !== 'win32' && spawnSync('bash', ['-c', 'true']).status === 0;

// ---------------------------------------------------------------------------
// install-agent-skill.sh — critério único de "desta skill" (#11/#12)
// ---------------------------------------------------------------------------

describe.runIf(hasBash)('install-agent-skill.sh: dono do link e doctor coerente com o install', () => {
  it('o SKILL.md embarcado carrega o marcador que o instalador usa para se reconhecer', () => {
    expect(SKILL_MD).toMatch(/^name: prompt-builder$/mu);
    expect(SKILL_MD).toContain('npmjs.com/package/prompt-builder-cli');
  });

  it('#12: link de OUTRA skill homónima (…/skills/prompt-builder) não é re-apontado nem removido', () => {
    const home = bareHome();
    const alvo = path.join(home, 'agente', 'skills');
    const dest = path.join(alvo, 'prompt-builder');
    const alheia = thirdPartySkill(home);
    mkdirSync(alvo, { recursive: true });
    symlinkSync(alheia, dest);
    const env = envFor(home);

    const doctor = sh(INSTALLER, ['doctor', '--target', alvo], env);
    expect(doctor.status).toBe(1);
    expect(doctor.stdout).toMatch(/OUTRA skill/u);

    const install = sh(INSTALLER, ['install', '--target', alvo], env);
    expect(install.status).toBe(1);
    expect(install.stderr).toMatch(/outra origem/u);
    expect(install.stdout).not.toMatch(/\[re-apont\.\]/u);
    expect(readlinkSync(dest)).toBe(alheia);

    const uninstall = sh(INSTALLER, ['uninstall', '--target', alvo], env);
    expect(uninstall.status).toBe(0);
    expect(uninstall.stdout).toMatch(/\[mantido\]/u);
    expect(readlinkSync(dest)).toBe(alheia);
    expect(readFileSync(path.join(alheia, 'SKILL.md'), 'utf8')).toContain('OUTRA skill');
  });

  it('#12: link para outro checkout/versão DESTE projeto é desatualizado (doctor) e re-apontado (install)', () => {
    const home = bareHome();
    const alvo = path.join(home, 'agente', 'skills');
    const dest = path.join(alvo, 'prompt-builder');
    const antiga = otherCheckout(home);
    mkdirSync(alvo, { recursive: true });
    symlinkSync(antiga, dest);
    const env = envFor(home);

    const antes = sh(INSTALLER, ['doctor', '--target', alvo], env);
    expect(antes.status).toBe(1);
    expect(antes.stdout).toMatch(/\[DESATUALIZADO\]/u);

    const install = sh(INSTALLER, ['install', '--target', alvo], env);
    expect(install.status).toBe(0);
    expect(install.stdout).toMatch(/\[re-apont\.\]/u);
    expect(isLinkTo(dest, SKILL_SRC)).toBe(true);

    const depois = sh(INSTALLER, ['doctor', '--target', alvo], env);
    expect(depois.status).toBe(0);
    expect(depois.stdout).toMatch(/\[ok\]/u);
  });

  it('#12: o marcador do SKILL.md basta (skill do projeto fora de uma pasta skills/)', () => {
    const home = bareHome();
    const alvo = path.join(home, 'agente', 'skills');
    const copia = path.join(home, 'solto', 'pb');
    write(path.join(copia, 'SKILL.md'), `${SKILL_MD}\nlinha a mais\n`);
    mkdirSync(alvo, { recursive: true });
    symlinkSync(copia, path.join(alvo, 'prompt-builder'));
    const r = sh(INSTALLER, ['uninstall', '--target', alvo], envFor(home));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[removido\]/u);
    expect(existsSync(path.join(alvo, 'prompt-builder'))).toBe(false);
    expect(existsSync(path.join(copia, 'SKILL.md'))).toBe(true); // só o link some
  });

  it('#12: link QUEBRADO que terminava em …/skills/prompt-builder é re-apontado (repo mudou de lugar)', () => {
    const home = bareHome();
    const alvo = path.join(home, 'agente', 'skills');
    const dest = path.join(alvo, 'prompt-builder');
    mkdirSync(alvo, { recursive: true });
    symlinkSync(path.join(home, 'sumiu', 'skills', 'prompt-builder'), dest);
    const env = envFor(home);
    const doctor = sh(INSTALLER, ['doctor', '--target', alvo], env);
    expect(doctor.status).toBe(1);
    expect(doctor.stdout).toMatch(/LINK QUEBRADO/u);
    const install = sh(INSTALLER, ['install', '--target', alvo], env);
    expect(install.status).toBe(0);
    expect(isLinkTo(dest, SKILL_SRC)).toBe(true);
  });

  it('#11: cópia local desatualizada ou alheia é PROBLEMA no doctor — e o install também recusa', () => {
    for (const [conteudo, rotulo] of [
      ['x', /OUTRA skill/u], // o caso do achado: SKILL.md = "x"
      [`${SKILL_MD}\nversão antiga\n`, /\[DESATUALIZADA\]/u], // cópia do projeto, mas diferente
    ] as const) {
      const home = bareHome();
      const alvo = path.join(home, 'agente', 'skills');
      write(path.join(alvo, 'prompt-builder', 'SKILL.md'), conteudo);
      const env = envFor(home);
      const doctor = sh(INSTALLER, ['doctor', '--target', alvo], env);
      expect(doctor.status, doctor.out).toBe(1);
      expect(doctor.stdout).toMatch(rotulo);
      expect(doctor.stdout).not.toMatch(/\[cópia\]/u);
      const install = sh(INSTALLER, ['install', '--target', alvo], env);
      expect(install.status, install.out).toBe(1);
      // nada tocado
      expect(readFileSync(path.join(alvo, 'prompt-builder', 'SKILL.md'), 'utf8')).toBe(conteudo);
    }
  });

  it('#11: cópia IDÊNTICA à origem é íntegra nos dois (doctor 0, install "cópia ok" sem tocar)', () => {
    const home = bareHome();
    const alvo = path.join(home, 'agente', 'skills');
    write(path.join(alvo, 'prompt-builder', 'SKILL.md'), SKILL_MD);
    const env = envFor(home);
    const doctor = sh(INSTALLER, ['doctor', '--target', alvo], env);
    expect(doctor.status, doctor.out).toBe(0);
    expect(doctor.stdout).toMatch(/\[cópia\]/u);
    const install = sh(INSTALLER, ['install', '--target', alvo], env);
    expect(install.status, install.out).toBe(0);
    expect(install.stdout).toMatch(/\[cópia ok\]/u);
    expect(lstatSync(path.join(alvo, 'prompt-builder')).isDirectory()).toBe(true);
    const uninstall = sh(INSTALLER, ['uninstall', '--target', alvo], env);
    expect(uninstall.status).toBe(0);
    expect(existsSync(path.join(alvo, 'prompt-builder', 'SKILL.md'))).toBe(true); // cópia nunca é removida
  });
});

// ---------------------------------------------------------------------------
// agent-setup.sh — install / doctor / uninstall de ponta a ponta
// ---------------------------------------------------------------------------

/**
 * HOME falso "de verdade": Claude Code + um perfil real (~/.claude-work com
 * settings.json) + um backup que NÃO é perfil (~/.claude-backup) + um
 * CLAUDE_CONFIG_DIR fora do padrão + ~/.agents/skills com as skills de
 * relatório pré-semeadas (uma alheia/reusada, outra marcada como nossa).
 */
function agentHome(): { home: string; env: NodeJS.ProcessEnv; perfil: string } {
  const home = bareHome('pb-agent-setup-');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  write(path.join(home, '.claude', 'skills', 'outra-skill', 'SKILL.md'), '---\nname: outra-skill\n---\n');
  write(path.join(home, '.claude-work', 'settings.json'), '{}\n');
  write(path.join(home, '.claude-backup', 'notas.txt'), 'backup antigo\n');
  const perfil = path.join(home, 'perfis', 'conta-b');
  mkdirSync(perfil, { recursive: true });
  // Reusada (já existia na máquina, sem marca): o setup só liga, nunca remove.
  write(
    path.join(home, '.agents', 'skills', 'plannotator-visual-explainer', 'SKILL.md'),
    '---\nname: plannotator-visual-explainer\ndescription: render\n---\n',
  );
  // Marcada como instalada por este setup: o uninstall a remove.
  write(path.join(home, '.agents', 'skills', 'visual-explainer', 'SKILL.md'), '---\nname: visual-explainer\n---\n');
  write(path.join(home, '.agents', 'skills', 'visual-explainer', '.installed-by-prompt-builder'), 'prompt-builder agent-setup\n');
  // Stub do Plannotator: `annotate` sem arquivo imprime o uso; `--version` a versão.
  const stub = path.join(home, 'stub-bin', 'plannotator');
  write(
    stub,
    '#!/usr/bin/env bash\ncase "$1" in\n  --version) echo "plannotator 0.27.1" ;;\n  annotate) echo "uso: plannotator annotate <arquivo>" >&2; exit 1 ;;\n  *) exit 2 ;;\nesac\n',
  );
  chmodSync(stub, 0o755);
  const env = envFor(home, { CLAUDE_CONFIG_DIR: perfil, PB_PLANNOTATOR_INSTALL: '0' });
  return { home, env, perfil };
}

/** dist/ em dia com src/ (o doctor acusa dist velho — legítimo fora do `npm test`). */
function distFresh(): boolean {
  if (!existsSync(CLI_JS)) return false;
  const limite = statSync(CLI_JS).mtimeMs;
  const stack = [path.join(ROOT, 'src')];
  while (stack.length) {
    const d = stack.pop()!;
    for (const nome of readdirSync(d)) {
      const p = path.join(d, nome);
      const st = statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (p.endsWith('.ts') && st.mtimeMs > limite) return false;
    }
  }
  return true;
}

// O setup usa o dist/ compilado (--no-build): o `npm test` compila antes (pretest).
describe.runIf(hasBash && existsSync(CLI_JS))('agent-setup.sh (HOME falso, sem rede)', () => {
  it('install → lançadores, skill e skills de relatório nos diretórios descobertos; idempotente; doctor; uninstall só o nosso', () => {
    const { home, env, perfil } = agentHome();
    const esperados = [
      path.join(home, '.claude', 'skills'),
      path.join(perfil, 'skills'),
      path.join(home, '.claude-work', 'skills'),
      path.join(home, '.agents', 'skills'),
    ];

    // --- descoberta: fonte única (o agent-setup lê daqui) ---
    const dirs = sh(INSTALLER, ['dirs'], env);
    expect(dirs.status, dirs.out).toBe(0);
    const listados = dirs.stdout.split('\n').filter(Boolean);
    expect([...listados].sort()).toEqual([...esperados].sort());
    expect(listados).not.toContain(path.join(home, '.claude-backup', 'skills')); // backup não é perfil
    expect(listados).not.toContain(path.join(home, '.codex', 'skills')); // agente ausente

    // --- install ---
    const install = sh(SETUP, ['install', '--no-build'], env);
    expect(install.status, install.out).toBe(0);
    expect(install.stdout).toMatch(/Pronto\./u);

    const binDir = path.join(home, '.local', 'bin');
    for (const nome of BINS) {
      const bin = path.join(binDir, nome);
      expect(existsSync(bin), bin).toBe(true);
      expect(statSync(bin).mode & 0o111, `${nome} sem bit de execução`).not.toBe(0);
      expect(readFileSync(bin, 'utf8')).toContain(BIN_MARK);
      const v = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 30_000 });
      expect(v.status, `${nome} --version: ${v.stderr}`).toBe(0);
      expect(v.stdout).toContain(VERSION);
    }
    for (const d of esperados) {
      expect(isLinkTo(path.join(d, 'prompt-builder'), SKILL_SRC), d).toBe(true);
    }
    const canon = path.join(home, '.agents', 'skills');
    for (const d of esperados.filter((x) => x !== canon)) {
      for (const skill of ['plannotator-visual-explainer', 'visual-explainer']) {
        expect(isLinkTo(path.join(d, skill), path.join(canon, skill)), `${d}/${skill}`).toBe(true);
      }
    }
    expect(existsSync(path.join(home, '.claude-backup', 'skills'))).toBe(false);
    expect(existsSync(path.join(home, '.codex'))).toBe(false);

    // --- idempotência: segunda rodada não escreve nem liga nada ---
    const antes = snapshot(home);
    const again = sh(SETUP, ['install', '--no-build'], env);
    expect(again.status, again.out).toBe(0);
    expect(again.stdout).not.toMatch(/\[(?:escrito|ligado|re-apont\.|criado)\]/u);
    expect(again.stdout).toMatch(/\[já ok\]/u);
    expect(snapshot(home)).toEqual(antes);

    // --- doctor ---
    const doctor = sh(SETUP, ['doctor'], env);
    for (const nome of BINS) expect(doctor.stdout).toContain(`[ok]        ${path.join(binDir, nome)}`);
    expect(doctor.stdout).toMatch(/plannotator: /u);
    expect(doctor.stdout).not.toMatch(/\[PROBLEMA\]\s+(?!dist\/)/u);
    if (distFresh()) {
      expect(doctor.status, doctor.out).toBe(0);
      expect(doctor.stdout).toMatch(/tudo pronto/u);
    }

    // --- uninstall: remove só o que é nosso ---
    const un = sh(SETUP, ['uninstall'], env);
    expect(un.status, un.out).toBe(0);
    for (const nome of BINS) expect(existsSync(path.join(binDir, nome)), nome).toBe(false);
    for (const d of esperados) expect(existsSync(path.join(d, 'prompt-builder')), d).toBe(false);
    // a skill do repo NÃO foi apagada através do link
    expect(readFileSync(path.join(SKILL_SRC, 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    // marcada como nossa: pasta e links somem
    expect(existsSync(path.join(canon, 'visual-explainer'))).toBe(false);
    for (const d of esperados) {
      expect(lstatSync(d).isDirectory()).toBe(true);
      expect(existsSync(path.join(d, 'visual-explainer')) || isLinkTo(path.join(d, 'visual-explainer'), canon)).toBe(false);
    }
    // reusada (não é nossa): a cópia fica intacta
    expect(readFileSync(path.join(canon, 'plannotator-visual-explainer', 'SKILL.md'), 'utf8')).toContain('render');
    // alheios ficam
    expect(existsSync(path.join(home, '.claude', 'skills', 'outra-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(home, 'stub-bin', 'plannotator'))).toBe(true);
    expect(un.stdout).toMatch(/NÃO foi tocado/u); // o binário do Plannotator nunca é removido
  }, 120_000);

  it('lançador ALHEIO no destino não é sobrescrito nem removido', () => {
    const { home, env } = agentHome();
    const alheio = path.join(home, '.local', 'bin', 'pbuilder');
    write(alheio, '#!/bin/sh\necho outro pbuilder\n');
    chmodSync(alheio, 0o755);
    const install = sh(SETUP, ['install', '--no-build', '--no-plannotator'], env);
    expect(install.status, install.out).toBe(0);
    expect(install.stderr).toMatch(/não foi escrito por este setup/u);
    expect(readFileSync(alheio, 'utf8')).toBe('#!/bin/sh\necho outro pbuilder\n');
    expect(readFileSync(path.join(home, '.local', 'bin', 'prompt-builder'), 'utf8')).toContain(BIN_MARK);
    const un = sh(SETUP, ['uninstall'], env);
    expect(un.status, un.out).toBe(0);
    expect(readFileSync(alheio, 'utf8')).toBe('#!/bin/sh\necho outro pbuilder\n');
    expect(existsSync(path.join(home, '.local', 'bin', 'prompt-builder'))).toBe(false);
  }, 60_000);

  it('uso inválido sai 2 sem tocar nada', () => {
    const { home, env } = agentHome();
    const antes = snapshot(home);
    expect(sh(SETUP, ['frobnicate'], env).status).toBe(2);
    expect(sh(SETUP, ['install', '--nope'], env).status).toBe(2);
    expect(sh(INSTALLER, ['frobnicate'], env).status).toBe(2);
    expect(snapshot(home)).toEqual(antes);
  });
});
