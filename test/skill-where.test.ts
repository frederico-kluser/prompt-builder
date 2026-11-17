// Contrato da skill global `prompt-builder` como ponteiro INTELIGENTE para o
// projeto (pedido do dono, 2026-10-10):
//
//  - `skills/prompt-builder/where.sh` — chamado pelo SYMLINK de qualquer agente,
//    segue o link até a pasta real e diz a raiz, o comando do CLI (o do PATH só
//    se ele leva a ESTA raiz), build, key (só a presença), dados, worktree
//    efêmero e o comando que corrige o que faltar. Só lê.
//  - os instaladores (`install-agent-skill.sh`, `agent-setup.sh`) rodados de um
//    worktree LIGADO se re-executam da cópia principal: foi um link global para
//    `.worktrees/jev` que quebrou a skill em todos os agentes em 2026-10.
//  - o SKILL.md: passo 1 = where.sh por `${CLAUDE_SKILL_DIR}` em TEXTO (sem
//    injeção `!`…`` — medido: com ela a skill não carrega quando o modelo a
//    invoca em modo de permissão padrão), opções recomendadas e a pergunta
//    obrigatória sobre outro modelo.
//
// Tudo roda com HOME e PATH falsos (ambiente montado do zero): nada toca o home real.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SKILL_SRC = path.join(ROOT, 'skills', 'prompt-builder');
const WHERE = path.join(SKILL_SRC, 'where.sh');
const CLI_JS = path.join(ROOT, 'dist', 'cli', 'index.js');
const BIN_MARK = '# managed-by: prompt-builder agent-setup';

const temps: string[] = [];
afterAll(() => {
  // rmSync recursivo NÃO segue symlinks: os links para a skill somem sem tocá-la.
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  temps.push(d);
  return d;
}

function write(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

/** Ambiente do filho montado do zero (sem a key nem o PATH de quem roda o teste). */
function envFor(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HOME: home,
    PATH: [path.join(home, 'stub-bin'), path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}

function sh(script: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  const r = spawnSync('bash', [script, ...args], { env, cwd, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}\n${r.stderr}` };
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): void {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
}

/** Lançador como o do agent-setup, apontando para `cliJs`. */
function launcher(home: string, cliJs: string): void {
  const bin = path.join(home, 'stub-bin', 'prompt-builder');
  write(bin, `#!/usr/bin/env bash\n${BIN_MARK}\n# origem: teste\nexec node "${cliJs}" "$@"\n`);
  chmodSync(bin, 0o755);
}

/** Aspas só quando o caminho precisa (mesma regra do `cita` do where.sh). */
const cita = (p: string): string => (/^[A-Za-z0-9_./:@%+=-]+$/u.test(p) ? p : `'${p.replace(/'/gu, `'\\''`)}'`);

const hasBash = process.platform !== 'win32' && spawnSync('bash', ['-c', 'true']).status === 0;
const hasGit = spawnSync('git', ['--version']).status === 0;

// ---------------------------------------------------------------------------
// where.sh
// ---------------------------------------------------------------------------

describe.runIf(hasBash)('where.sh — a skill chamada por symlink aponta o local REAL', () => {
  it('pelo symlink de um diretório de agente, de outro cwd: mostra link → pasta real e a raiz do checkout', () => {
    const home = tempDir('pb-where-home-');
    const link = path.join(home, '.claude', 'skills', 'prompt-builder');
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(SKILL_SRC, link);
    const r = sh(path.join(link, 'where.sh'), [], envFor(home), tmpdir());
    expect(r.stdout).toContain(`skill    ${link} -> ${SKILL_SRC}`);
    expect(r.stdout).toContain(`raiz     ${ROOT}  [checkout do repositório`);
    expect(r.stdout).toMatch(/versão {3}prompt-builder-cli \d+\.\d+\.\d+/u);
    expect(r.stdout).toContain(`dados    ${path.join(home, '.prompt-builder')}`);
    // sem `prompt-builder` no PATH, o comando é o node no dist DESTA raiz
    expect(r.stdout).toContain(`CLI      node ${cita(CLI_JS)}`);
    expect(r.stdout).toContain(`agent-setup.sh`);
    // só lê: o HOME falso continua só com o que o teste criou
    expect(readdirSync(home).sort()).toEqual(['.claude']);
  });

  it('--cli: o comando numa linha — node no dist sem lançador; `prompt-builder` quando o do PATH leva a esta raiz', () => {
    const home = tempDir('pb-where-cli-');
    const sem = sh(WHERE, ['--cli'], envFor(home));
    expect(sem.stdout).toBe(`node ${cita(CLI_JS)}\n`);

    launcher(home, CLI_JS);
    const com = sh(WHERE, ['--cli'], envFor(home));
    expect(com.stdout).toBe('prompt-builder\n');
    expect(sh(WHERE, [], envFor(home)).stdout).toContain('(leva a esta raiz)');
  });

  it('lançador de OUTRA instalação no PATH: não é usado (o comando segue sendo o node desta raiz)', () => {
    const home = tempDir('pb-where-outro-');
    const outra = path.join(home, 'outra', 'dist', 'cli', 'index.js');
    write(path.join(home, 'outra', 'package.json'), JSON.stringify({ name: 'prompt-builder-cli', version: '0.0.1' }));
    write(outra, '');
    launcher(home, outra);
    const r = sh(WHERE, [], envFor(home));
    expect(r.stdout).toContain(`CLI      node ${cita(CLI_JS)}`);
    expect(r.stdout).toContain('é OUTRA instalação');
  });

  it('cópia da skill (init) sem raiz e sem PATH: cai no npx da versão publicada', () => {
    const home = tempDir('pb-where-copia-');
    const copia = path.join(home, 'proj', '.claude', 'skills', 'prompt-builder');
    mkdirSync(copia, { recursive: true });
    for (const f of readdirSync(SKILL_SRC)) copyFileSync(path.join(SKILL_SRC, f), path.join(copia, f));
    const r = sh(path.join(copia, 'where.sh'), [], envFor(home));
    expect(r.stdout).toContain('esta skill é uma CÓPIA');
    expect(r.stdout).toContain('CLI      npx prompt-builder-cli');
    expect(sh(path.join(copia, 'where.sh'), ['--cli'], envFor(home)).stdout).toBe('npx prompt-builder-cli\n');
  });

  it('key: diz a ORIGEM (ambiente / arquivo do data-dir / ausente) e nunca imprime o valor', () => {
    const home = tempDir('pb-where-key-');
    const segredo = 'valor-da-key-que-nunca-pode-aparecer-42';
    const env = sh(WHERE, [], envFor(home, { OPENROUTER_API_KEY: segredo }));
    expect(env.stdout).toContain('key      OPENROUTER_API_KEY no ambiente');
    expect(env.out).not.toContain(segredo);

    const dados = path.join(home, 'dados');
    write(path.join(dados, 'key'), `${segredo}\n`);
    const arq = sh(WHERE, [], envFor(home, { PROMPT_BUILDER_HOME: dados }));
    expect(arq.stdout).toContain(`key      arquivo ${path.join(dados, 'key')}`);
    expect(arq.stdout).toContain(`dados    ${dados}`);
    expect(arq.out).not.toContain(segredo);

    const sem = sh(WHERE, [], envFor(home));
    expect(sem.stdout).toContain('key      AUSENTE');
    expect(sem.stdout).toContain('key set --stdin');
  });

  it('opção desconhecida = exit 2, sem relatório', () => {
    const r = sh(WHERE, ['--xyz'], envFor(tempDir('pb-where-uso-')));
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/opção desconhecida/u);
  });
});

// ---------------------------------------------------------------------------
// Worktree ligado: where.sh avisa; os instaladores usam a cópia principal
// ---------------------------------------------------------------------------

/** Repo mínimo do prompt-builder-cli (cópia principal) + um worktree ligado dele. */
function repoComWorktree(): { base: string; main: string; wt: string; env: NodeJS.ProcessEnv } {
  const base = tempDir('pb-worktree-');
  const home = path.join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env = envFor(home);
  const main = path.join(base, 'main');
  write(path.join(main, 'package.json'), `${JSON.stringify({ name: 'prompt-builder-cli', version: '9.9.9' }, null, 2)}\n`);
  write(path.join(main, 'tsconfig.json'), '{}\n');
  write(path.join(main, 'src', 'a.ts'), 'export {};\n');
  for (const f of ['SKILL.md', 'where.sh']) {
    write(path.join(main, 'skills', 'prompt-builder', f), readFileSync(path.join(SKILL_SRC, f), 'utf8'));
  }
  for (const f of ['install-agent-skill.sh', 'agent-setup.sh']) {
    write(path.join(main, 'scripts', f), readFileSync(path.join(ROOT, 'scripts', f), 'utf8'));
  }
  git(main, ['init', '-q'], env);
  git(main, ['add', '-A'], env);
  git(main, ['commit', '-qm', 'init'], env);
  const wt = path.join(base, 'wt');
  git(main, ['worktree', 'add', '-q', wt], env);
  return { base, main, wt, env };
}

describe.runIf(hasBash && hasGit)('worktree ligado (efêmero) — nunca vira o alvo da instalação global', () => {
  it('where.sh num worktree: marca WORKTREE e manda instalar a partir da cópia principal', () => {
    const { main, wt, env } = repoComWorktree();
    const r = sh(path.join(wt, 'skills', 'prompt-builder', 'where.sh'), [], env);
    expect(r.stdout).toContain('WORKTREE ligado (efêmero)');
    expect(r.stdout).toContain(`bash ${cita(path.join(main, 'scripts', 'agent-setup.sh'))} install`);
    expect(r.stdout).not.toContain(`bash ${cita(path.join(wt, 'scripts', 'agent-setup.sh'))}`);
  });

  it('install-agent-skill.sh de um worktree liga a skill da cópia PRINCIPAL; PB_ALLOW_WORKTREE=1 liga o worktree', () => {
    const { base, main, wt, env } = repoComWorktree();
    const alvo = path.join(base, 'agente', 'skills');
    const dest = path.join(alvo, 'prompt-builder');
    const instalador = path.join(wt, 'scripts', 'install-agent-skill.sh');

    const r = sh(instalador, ['install', '--target', alvo], env);
    expect(r.status, r.out).toBe(0);
    expect(r.stderr).toContain('worktree ligado');
    expect(realpathSync(dest)).toBe(path.join(main, 'skills', 'prompt-builder'));

    // `dirs` é lido por máquina (agent-setup): o aviso vai para o stderr, o stdout fica limpo
    const dirs = sh(instalador, ['dirs', '--target', alvo], env);
    expect(dirs.stdout).toBe(`${alvo}\n`);

    rmSync(dest);
    const forcado = sh(instalador, ['install', '--target', alvo], { ...env, PB_ALLOW_WORKTREE: '1' });
    expect(forcado.status, forcado.out).toBe(0);
    expect(forcado.stderr).not.toContain('worktree ligado');
    expect(realpathSync(dest)).toBe(path.join(wt, 'skills', 'prompt-builder'));
  });

  it('agent-setup.sh de um worktree se re-executa da cópia principal (o doctor fala da principal)', () => {
    const { main, wt, env } = repoComWorktree();
    const r = sh(path.join(wt, 'scripts', 'agent-setup.sh'), ['doctor'], env);
    expect(r.stderr).toContain('worktree ligado');
    expect(r.stdout).toContain(`doctor (${main})`);
  });

  it('checkout normal (cópia principal): nada muda — sem aviso, link para ela mesma', () => {
    const { base, main, env } = repoComWorktree();
    const alvo = path.join(base, 'agente2', 'skills');
    const r = sh(path.join(main, 'scripts', 'install-agent-skill.sh'), ['install', '--target', alvo], env);
    expect(r.status, r.out).toBe(0);
    expect(r.stderr).not.toContain('worktree');
    expect(realpathSync(path.join(alvo, 'prompt-builder'))).toBe(path.join(main, 'skills', 'prompt-builder'));
  });
});

// ---------------------------------------------------------------------------
// SKILL.md e terminal.md: os comportamentos pedidos não somem em silêncio
// ---------------------------------------------------------------------------

describe('SKILL.md — onde está, opções recomendadas e a pergunta obrigatória', () => {
  const skill = readFileSync(path.join(SKILL_SRC, 'SKILL.md'), 'utf8');
  const corpo = skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '');
  const guia = readFileSync(path.join(SKILL_SRC, 'terminal.md'), 'utf8');

  it('passo 1 = where.sh via ${CLAUDE_SKILL_DIR} em TEXTO, com a forma para outros agentes', () => {
    expect(corpo).toContain('bash "${CLAUDE_SKILL_DIR}/where.sh"');
    expect(corpo).toContain('bash <pasta desta skill>/where.sh');
  });

  it('sem injeção `!`…`` (a skill não carregaria quando o modelo a invoca em modo padrão)', () => {
    expect(skill).not.toMatch(/!`/u);
  });

  it('opções recomendadas + pergunta SEMPRE por outro modelo antes de gastar (e o guia detalha)', () => {
    expect(corpo).toMatch(/Opções recomendadas/u);
    expect(corpo).toMatch(/pergunte SEMPRE/u);
    expect(corpo).toMatch(/outro modelo/u);
    expect(corpo).toContain('terminal.md');
    expect(guia).toMatch(/## 3\. A pergunta obrigatória: outro modelo/u);
    expect(guia).toMatch(/AskUserQuestion/u);
    expect(guia).toMatch(/\*\*PARE\*\*/u);
  });

  it('description ≤ 1024 caracteres (limite da especificação Agent Skills) e cita o local no disco', () => {
    const desc = /^description: (.*)$/mu.exec(skill)?.[1] ?? '';
    expect([...desc].length).toBeLessThanOrEqual(1024);
    expect(desc).toMatch(/no disco/u);
    expect(desc).toMatch(/outro modelo/u);
  });
});
