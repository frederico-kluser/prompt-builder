// cli#4 / mcp#5 / skill-install#1 — `docs config` (e `read_docs {topic:'config'}`)
// falhava SEMPRE: o tópico apontava para um ARENA-CONFIG.md apagado do repo e
// fora do tarball, enquanto `docs --list` e o `--help` mandavam lê-lo. Agora
// TODO tópico do index.json é `agent-docs/<tópico>.md` — e este arquivo prova
// que cada um é legível (antes o `docs --all` escondia o buraco em silêncio).
//
// O contrato `agent-docs/config.md` é conferido contra o schema zod REAL: toda
// chave que o `arenaConfigSchema` aceita aparece documentada (os exemplos da
// doc passam no validador real pelo docs-lint).
//
// cli#18 — `docs <tópico> --json`, `docs --all --json` e `skill --json` saíam
// como markdown cru (JSON.parse quebrava no `#`).
//
// cli#21 / skill-install#9 — `init` copiava só o SKILL.md, que aponta para o
// `models.md` "ao lado desta skill": a referência morria em toda instalação.
//
// skill-install#10 — `init --global` escrevia ATRAVÉS do symlink do instalador
// (sobrescrevendo o SKILL.md do checkout) e criava um AGENTS.md solto no HOME.
//
// Zero rede: nenhum destes comandos toca o OpenRouter.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeOrTsx } from './support/cli.js';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EXIT } from '../src/cli/output.js';
import { docTopicFiles, readDocTopic } from '../src/cli/commands/knowledge.js';
import { callTool } from '../src/cli/commands/mcp.js';
import { arenaConfigSchema } from '../src/configFile.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { cmd: NODE, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));
const DEAD_BASE = 'http://127.0.0.1:9/api/v1';
const SKILL_SRC = path.join(ROOT, 'skills', 'prompt-builder');

interface IndexEntry {
  topic: string;
  approxTokens: number;
}
const INDEX = JSON.parse(readFileSync(path.join(ROOT, 'agent-docs', 'index.json'), 'utf-8')) as IndexEntry[];

let base = '';
beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'pb-docs-init-'));
});
afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], opts: { cwd?: string; home?: string } = {}): CliRun {
  const home = opts.home ?? path.join(base, 'home-default');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PROMPT_BUILDER_HOME: path.join(home, '.prompt-builder'),
    OPENROUTER_BASE_URL: DEAD_BASE,
    NO_COLOR: '1',
    CLAUDECODE: '',
    CI: '',
  };
  delete env.OPENROUTER_API_KEY;
  delete env.PROMPT_BUILDER_TELEMETRY;
  const r = spawnSync(NODE, [ENTRY, ...args], { env, cwd: opts.cwd ?? base, encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Última linha do stdout como JSON (o envelope do `--json`). */
function envelope(r: CliRun): { ok: boolean; command: string; data: Record<string, unknown> } {
  const linhas = r.stdout.trim().split('\n');
  return JSON.parse(linhas.at(-1)!) as { ok: boolean; command: string; data: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// cli#4 / mcp#5 / skill-install#1 — todo tópico listado é legível
// ---------------------------------------------------------------------------

describe('cli#4 — todo tópico do agent-docs/index.json resolve (nenhum some em silêncio)', () => {
  it.each(INDEX.map((e) => e.topic))('readDocTopic(%j) → ok', async (topic) => {
    const lido = await readDocTopic(topic);
    expect(lido.ok, lido.ok ? '' : lido.message).toBe(true);
  });

  it('todo tópico mora em agent-docs/ (sem exceção como o antigo ARENA-CONFIG.md na raiz)', async () => {
    const mapa = await docTopicFiles();
    expect([...mapa.keys()].sort()).toEqual(INDEX.map((e) => e.topic).sort());
    for (const [topic, file] of mapa) {
      expect(path.dirname(file), topic).toBe(path.join(ROOT, 'agent-docs'));
      expect(path.basename(file), topic).toBe(`${topic}.md`);
    }
  });

  it('approxTokens do index acompanha o tamanho real (fator ≤ 2 de bytes/4)', () => {
    for (const e of INDEX) {
      const medido = statSync(path.join(ROOT, 'agent-docs', `${e.topic}.md`)).size / 4;
      expect(e.approxTokens, e.topic).toBeGreaterThanOrEqual(medido / 2);
      expect(e.approxTokens, e.topic).toBeLessThanOrEqual(medido * 2);
    }
  });

  it('MCP read_docs {topic:"config"} devolve o contrato (antes: isError "indisponível")', async () => {
    const r = await callTool('read_docs', { topic: 'config' });
    expect(r?.isError).toBeUndefined();
    const corpo = JSON.parse(r!.content[0].text) as { topic: string; content: string };
    expect(corpo.topic).toBe('config');
    expect(corpo.content).toContain('arena-config@1');
  });

  it('CLI `docs config` sai 0 com o contrato no stdout (antes: exit 2)', () => {
    const r = cli(['docs', 'config']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(r.stdout).toMatch(/^# O contrato `arena-config@1`/u);
  });
});

// ---------------------------------------------------------------------------
// agent-docs/config.md × schema zod real
// ---------------------------------------------------------------------------

/** Toda chave de propriedade do JSON Schema gerado do zod (recursivo). */
function schemaKeys(node: unknown, acc = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) schemaKeys(n, acc);
    return acc;
  }
  const o = node as Record<string, unknown>;
  if (o.properties && typeof o.properties === 'object') {
    for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) {
      acc.add(k);
      schemaKeys(v, acc);
    }
  }
  for (const k of ['items', 'anyOf', 'oneOf', 'allOf', 'additionalProperties']) schemaKeys(o[k], acc);
  for (const k of ['$defs', 'definitions']) {
    if (o[k] && typeof o[k] === 'object') for (const v of Object.values(o[k] as object)) schemaKeys(v, acc);
  }
  return acc;
}

describe('agent-docs/config.md documenta o arena-config@1 REAL', () => {
  const doc = readFileSync(path.join(ROOT, 'agent-docs', 'config.md'), 'utf-8');

  it('toda chave aceita pelo arenaConfigSchema aparece no doc', () => {
    const js = z.toJSONSchema(arenaConfigSchema, { io: 'input', unrepresentable: 'any' });
    const chaves = [...schemaKeys(js)];
    expect(chaves.length).toBeGreaterThan(40);
    // `\`chave\``, `"chave":` (exemplo JSON) ou `chave?` / `chave:` (forma inline de objeto)
    const faltando = chaves.filter(
      (k) => !doc.includes(`\`${k}\``) && !doc.includes(`"${k}"`) && !new RegExp(`[{ ,]${k}\\??[:,} ]`, 'u').test(doc),
    );
    expect(faltando).toEqual([]);
  });

  it('não ensina chave que o schema recusa como se valesse (duelTopK só aparece como inexistente)', () => {
    expect(doc).not.toMatch(/"duelTopK"\s*:/u);
    expect(doc).not.toMatch(/"halving"\s*:/u);
    expect(doc).toMatch(/`duelTopK` não existe/u);
  });

  it('aponta o contrato do modo agente (arena-agent-config) e o tópico dele', () => {
    expect(doc).toContain('arena-agent-config@1');
    expect(doc).toContain('docs agent-task');
  });

  it('cabe no teto por agent-doc do tarball (20 KB) — tópico longo, mas não o de 9000 tokens', () => {
    expect(Buffer.byteLength(doc, 'utf-8')).toBeLessThanOrEqual(20_480);
  });
});

// ---------------------------------------------------------------------------
// cli#18 — saída de máquina do docs/skill é JSON de verdade
// ---------------------------------------------------------------------------

describe('cli#18 — `docs`/`skill` sob --json/ndjson emitem envelope, não markdown', () => {
  it('`docs quickstart --json` → envelope docs.topic com o conteúdo', () => {
    const r = cli(['docs', 'quickstart', '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const env = envelope(r);
    expect(env).toMatchObject({ ok: true, command: 'docs.topic' });
    expect(env.data.topic).toBe('quickstart');
    expect(String(env.data.content)).toMatch(/^# /u);
  });

  it('`docs quickstart --output-format ndjson` → toda linha é JSON e a última é `result`', () => {
    const r = cli(['docs', 'quickstart', '--output-format', 'ndjson']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const linhas = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as { type?: string });
    expect(linhas.at(-1)?.type).toBe('result');
  });

  it('`docs --all --json` → um envelope com TODOS os tópicos e `missing` vazio', () => {
    const r = cli(['docs', '--all', '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const env = envelope(r);
    expect(env.command).toBe('docs.all');
    expect(env.data.topics).toEqual(INDEX.map((e) => e.topic));
    expect(env.data.missing).toEqual([]);
    expect(String(env.data.content)).toContain('arena-config@1');
  });

  it('`docs --all` (texto) segue imprimindo o markdown e não avisa de tópico faltando', () => {
    const r = cli(['docs', '--all']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(r.stdout).toContain('# O contrato `arena-config@1`');
    expect(r.stderr).not.toMatch(/indisponível/u);
  });

  it('`skill --json` → envelope com o SKILL.md e a lista de arquivos da skill', () => {
    const r = cli(['skill', '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const env = envelope(r);
    expect(env).toMatchObject({ ok: true, command: 'skill' });
    expect(env.data.file).toBe('SKILL.md');
    expect(env.data.files).toEqual(expect.arrayContaining(['SKILL.md', 'models.md']));
    expect(env.data.content).toBe(readFileSync(path.join(SKILL_SRC, 'SKILL.md'), 'utf-8'));
  });

  it('`skill models` imprime o models.md vizinho; arquivo desconhecido = exit 2', () => {
    const ok = cli(['skill', 'models']);
    expect(ok.status, ok.stderr).toBe(EXIT.OK);
    expect(ok.stdout).toBe(readFileSync(path.join(SKILL_SRC, 'models.md'), 'utf-8'));
    const ruim = cli(['skill', '../../package.json', '--json']);
    expect(ruim.status).toBe(EXIT.USAGE);
    expect(ruim.stdout).not.toContain('"dependencies"');
  });
});

// ---------------------------------------------------------------------------
// cli#21 / skill-install#9 / skill-install#10 — `init`
// ---------------------------------------------------------------------------

/** Arquivos regulares de primeiro nível da skill embarcada. */
const SKILL_FILES = readdirSync(SKILL_SRC, { withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => e.name)
  .sort();

function novoProjeto(nome: string): string {
  const dir = path.join(base, nome);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('cli#21 / skill-install#9 — `init` copia a PASTA da skill', () => {
  it('o SKILL.md cita o models.md relativo à skill (nunca `skills/prompt-builder/…`)', () => {
    const skill = readFileSync(path.join(SKILL_SRC, 'SKILL.md'), 'utf-8');
    expect(skill).toContain('`models.md`');
    expect(skill).not.toContain('skills/prompt-builder/models.md');
    expect(SKILL_FILES).toEqual(expect.arrayContaining(['SKILL.md', 'models.md']));
  });

  it('`init --agent claude` grava SKILL.md + models.md idênticos aos do pacote', () => {
    const proj = novoProjeto('proj-claude');
    const r = cli(['init', '--agent', 'claude', '--json'], { cwd: proj });
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const destino = path.join(proj, '.claude', 'skills', 'prompt-builder');
    expect(readdirSync(destino).sort()).toEqual(SKILL_FILES);
    for (const f of SKILL_FILES) {
      expect(readFileSync(path.join(destino, f), 'utf-8'), f).toBe(readFileSync(path.join(SKILL_SRC, f), 'utf-8'));
    }
    const env = envelope(r);
    expect(env.data.files).toEqual(SKILL_FILES);
    expect(env.data.skills).toEqual(SKILL_FILES.map((f) => path.join(destino, f)));
    // por projeto, o bloco do AGENTS.md continua sendo acrescentado
    expect(readFileSync(path.join(proj, 'AGENTS.md'), 'utf-8')).toContain('<!-- prompt-builder:start -->');
  });

  it('`.claude/skills` → symlink de `.agents/skills`: a mesma pasta REAL é escrita uma vez', () => {
    const proj = novoProjeto('proj-link');
    mkdirSync(path.join(proj, '.agents', 'skills'), { recursive: true });
    mkdirSync(path.join(proj, '.claude'), { recursive: true });
    symlinkSync(path.join('..', '.agents', 'skills'), path.join(proj, '.claude', 'skills'));
    const r = cli(['init', '--json'], { cwd: proj });
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const env = envelope(r);
    expect((env.data.skills as string[]).length).toBe(SKILL_FILES.length);
    expect(readdirSync(path.join(proj, '.agents', 'skills', 'prompt-builder')).sort()).toEqual(SKILL_FILES);
  });

  it('--dry-run não grava nada', () => {
    const proj = novoProjeto('proj-dry');
    const r = cli(['init', '--agent', 'claude', '--dry-run', '--json'], { cwd: proj });
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(existsSync(path.join(proj, '.claude'))).toBe(false);
    expect(existsSync(path.join(proj, 'AGENTS.md'))).toBe(false);
    expect(envelope(r).data.dryRun).toBe(true);
  });
});

describe('skill-install#10 — `init` nunca escreve ATRAVÉS de symlink; --global não cria AGENTS.md no HOME', () => {
  it('HOME com a skill ligada por symlink (install-agent-skill.sh): o checkout fica intacto', () => {
    const home = path.join(base, 'home-link');
    const checkout = path.join(base, 'fake-checkout', 'skills', 'prompt-builder');
    mkdirSync(checkout, { recursive: true });
    writeFileSync(path.join(checkout, 'SKILL.md'), 'OLD CHECKOUT CONTENT\n');
    mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    const link = path.join(home, '.claude', 'skills', 'prompt-builder');
    symlinkSync(checkout, link);

    const r = cli(['init', '--global', '--agent', 'claude', '--json'], { home, cwd: base });
    expect(r.status, r.stderr).toBe(EXIT.OK);
    // o alvo do link NÃO foi sobrescrito e nada novo nasceu dentro dele
    expect(readFileSync(path.join(checkout, 'SKILL.md'), 'utf-8')).toBe('OLD CHECKOUT CONTENT\n');
    expect(readdirSync(checkout)).toEqual(['SKILL.md']);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // e nenhum AGENTS.md solto no HOME
    expect(existsSync(path.join(home, 'AGENTS.md'))).toBe(false);
    const env = envelope(r);
    expect(env.data.skills).toEqual([]);
    expect(env.data.kept).toEqual([{ path: link, reason: 'symlink' }]);
    expect(env.data.agentsMd).toEqual({});
    expect(env.data.agentsMdSkipped).toBe('global');
    expect(r.stderr).toMatch(/symlink/u);
  });

  it('--global sem link: copia a pasta para o HOME e NÃO toca AGENTS.md/CLAUDE.md do HOME', () => {
    const home = path.join(base, 'home-copia');
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, 'CLAUDE.md'), 'minhas instruções\n');
    const r = cli(['init', '--global', '--agent', 'claude', '--json'], { home, cwd: base });
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(readdirSync(path.join(home, '.claude', 'skills', 'prompt-builder')).sort()).toEqual(SKILL_FILES);
    expect(existsSync(path.join(home, 'AGENTS.md'))).toBe(false);
    expect(readFileSync(path.join(home, 'CLAUDE.md'), 'utf-8')).toBe('minhas instruções\n');
  });

  it('arquivo da skill que é symlink dentro de pasta real: mantido, alvo intacto', () => {
    const proj = novoProjeto('proj-file-link');
    const alvo = path.join(base, 'alvo-externo.md');
    writeFileSync(alvo, 'NÃO SOBRESCREVA\n');
    const destino = path.join(proj, '.claude', 'skills', 'prompt-builder');
    mkdirSync(destino, { recursive: true });
    symlinkSync(alvo, path.join(destino, 'SKILL.md'));
    const r = cli(['init', '--agent', 'claude', '--json'], { cwd: proj });
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(readFileSync(alvo, 'utf-8')).toBe('NÃO SOBRESCREVA\n');
    const env = envelope(r);
    expect(env.data.kept).toEqual([{ path: path.join(destino, 'SKILL.md'), reason: 'symlink' }]);
    // os vizinhos reais seguem sendo copiados
    expect(readFileSync(path.join(destino, 'models.md'), 'utf-8')).toBe(
      readFileSync(path.join(SKILL_SRC, 'models.md'), 'utf-8'),
    );
  });
});
