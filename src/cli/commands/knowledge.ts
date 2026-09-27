// `docs` / `skill` / `init` — o CLI ensinando um agente a usar o CLI.
//
// A documentacao viaja DENTRO do pacote (`agent-docs/`, ver `files` do
// package.json) e e lida do disco local: sempre casada com a versao do binario,
// sem rede e sem custo de token ate ser pedida. E o padrao que o Next.js 16.2
// adotou (docs versionadas em node_modules em vez de uma skill estatica).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PKG_DOCS_DIR, PKG_ROOT, PKG_SKILLS_DIR } from '../../paths.js';
import { CliError, EXIT } from '../output.js';
import { buildContext, parse } from '../context.js';

const SKILL_NAME = 'prompt-builder';

/** Diretorio de skills de cada agente. */
const AGENT_DIRS: Record<string, string> = {
  claude: '.claude/skills',
  cursor: '.agents/skills',
  codex: '.codex/skills',
  opencode: '.opencode/skills',
  copilot: '.github/skills',
  goose: '.goose/skills',
  generic: '.agents/skills',
};

/**
 * `all` grava apenas DUAS pastas: `.agents/skills` (Cursor, Codex, opencode e
 * genericos leem dela) e `.claude/skills` (o Claude Code e o que nao le).
 * Sete copias quase identicas e o tipo de lixo que faz o usuario desinstalar.
 */
const ALL_DIRS = ['.agents/skills', '.claude/skills'];

interface DocIndexEntry {
  topic: string;
  title: string;
  summary: string;
  approxTokens: number;
}

async function readIndex(): Promise<DocIndexEntry[]> {
  try {
    const raw = await fs.readFile(path.join(PKG_DOCS_DIR, 'index.json'), 'utf-8');
    return JSON.parse(raw) as DocIndexEntry[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tópicos por ALLOWLIST (IMPL-024, R-09:REC-10)
// ---------------------------------------------------------------------------
// Antes: `path.join(PKG_DOCS_DIR, `${topic}.md`)` com o tópico do usuário/agente
// — `docs ../../etc/passwd` (CLI) e `read_docs {topic:'../README'}` (MCP) liam
// fora de agent-docs/. Agora o tópico é só uma CHAVE: o caminho sai de um mapa
// montado a partir do index.json embarcado (+ `config`), e o input nunca entra
// num path.join. CLI e MCP usam a MESMA função.

/** Formato de tópico: slug minúsculo. Serve também para decidir se é seguro ecoar. */
export const DOC_TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Mapa tópico → arquivo, só com o que o pacote embarca. */
export async function docTopicFiles(): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  for (const e of await readIndex()) {
    // o index.json é do pacote, mas passa pela mesma régua (defesa em profundidade)
    if (typeof e?.topic === 'string' && DOC_TOPIC_RE.test(e.topic)) {
      mapa.set(e.topic, path.join(PKG_DOCS_DIR, `${e.topic}.md`));
    }
  }
  // `docs config` lê o ARENA-CONFIG.md da raiz do pacote — uma cópia a menos
  // para derivar do contrato real.
  mapa.set('config', path.join(PKG_ROOT, 'ARENA-CONFIG.md'));
  return mapa;
}

export type DocTopicRead =
  | { ok: true; topic: string; content: string }
  | { ok: false; reason: 'invalid' | 'unknown' | 'unavailable'; message: string };

/**
 * Lê um tópico da documentação embarcada. As mensagens de erro NÃO carregam
 * caminho: tópico malformado não é ecoado (poderia ser `/etc/passwd`); tópico
 * bem-formado desconhecido é (é só um slug).
 */
export async function readDocTopic(topic: unknown): Promise<DocTopicRead> {
  if (typeof topic !== 'string' || !DOC_TOPIC_RE.test(topic)) {
    return { ok: false, reason: 'invalid', message: 'Tópico inválido: use um dos tópicos listados (ex.: "quickstart").' };
  }
  const mapa = await docTopicFiles();
  const file = mapa.get(topic);
  if (!file) {
    return {
      ok: false,
      reason: 'unknown',
      message: `Tópico "${topic}" não existe. Tópicos: ${[...mapa.keys()].join(', ')}.`,
    };
  }
  try {
    return { ok: true, topic, content: await fs.readFile(file, 'utf-8') };
  } catch {
    return { ok: false, reason: 'unavailable', message: `Tópico "${topic}" indisponível nesta instalação.` };
  }
}

export async function cmdDocs(argv: string[]): Promise<number> {
  const parsed = parse(argv, { list: { type: 'boolean' }, all: { type: 'boolean' } });
  const ctx = buildContext(parsed);
  const { out } = ctx;
  const topic = parsed.positionals[0];
  const index = await readIndex();

  if (parsed.values.list === true || (!topic && parsed.values.all !== true)) {
    if (out.isText) {
      out.line('Tópicos disponíveis (prompt-builder docs <tópico>):');
      out.line();
      for (const e of index) {
        out.line(`  ${e.topic.padEnd(16)} ${e.summary}  (~${e.approxTokens} tokens)`);
      }
      out.line();
      out.line('Comece por: prompt-builder docs quickstart');
    }
    out.result(true, 'docs.list', { topics: index });
    return EXIT.OK;
  }

  if (parsed.values.all === true) {
    const partes: string[] = [];
    for (const e of index) {
      const lido = await readDocTopic(e.topic);
      if (lido.ok) partes.push(lido.content);
    }
    out.raw(`${partes.join('\n\n---\n\n')}\n`);
    return EXIT.OK;
  }

  const lido = await readDocTopic(topic);
  if (!lido.ok) {
    throw new CliError(`${lido.message} Veja \`prompt-builder docs --list\`.`, EXIT.USAGE);
  }
  out.raw(lido.content);
  return EXIT.OK;
}

export async function cmdSkill(argv: string[]): Promise<number> {
  const parsed = parse(argv, {});
  const ctx = buildContext(parsed);
  const file = path.join(PKG_SKILLS_DIR, SKILL_NAME, 'SKILL.md');
  try {
    ctx.out.raw(await fs.readFile(file, 'utf-8'));
  } catch {
    throw new CliError('SKILL.md não encontrado no pacote.', EXIT.ERROR);
  }
  return EXIT.OK;
}

const MARKER_START = '<!-- prompt-builder:start -->';
const MARKER_END = '<!-- prompt-builder:end -->';

const AGENTS_BLOCK = `${MARKER_START}
## prompt-builder

Benchmark de LLMs e evolução de system prompts pelo terminal.
Comece por \`npx prompt-builder-cli docs quickstart\`.

Nunca chute um nível de raciocínio (think level): \`npx prompt-builder-cli models show <id> --json\`
diz exatamente quais níveis aquele modelo aceita e o que vai no fio para cada um.
Sempre rode \`--dry-run\` antes de uma run cara, e sempre passe \`--budget\`.
${MARKER_END}`;

async function upsertAgentsBlock(file: string, force: boolean, dryRun: boolean): Promise<string> {
  let atual = '';
  try {
    atual = await fs.readFile(file, 'utf-8');
  } catch {
    // arquivo novo
  }
  const jaTem = atual.includes(MARKER_START);
  if (jaTem && !force) return 'inalterado (já tem o bloco)';

  let novo: string;
  if (jaTem) {
    const inicio = atual.indexOf(MARKER_START);
    const fim = atual.indexOf(MARKER_END) + MARKER_END.length;
    novo = atual.slice(0, inicio) + AGENTS_BLOCK + atual.slice(fim);
  } else {
    novo = atual.trimEnd() + (atual.trim() ? '\n\n' : '') + AGENTS_BLOCK + '\n';
  }
  if (dryRun) return jaTem ? 'substituiria o bloco' : 'acrescentaria o bloco';
  await fs.writeFile(file, novo, 'utf-8');
  return jaTem ? 'bloco substituído' : 'bloco acrescentado';
}

export async function cmdInit(argv: string[]): Promise<number> {
  const parsed = parse(argv, {
    agent: { type: 'string' },
    global: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    force: { type: 'boolean' },
  });
  const ctx = buildContext(parsed);
  const { out } = ctx;
  const agent = typeof parsed.values.agent === 'string' ? parsed.values.agent : 'all';
  const dryRun = parsed.values['dry-run'] === true;
  const force = parsed.values.force === true;

  let dirs: string[];
  if (agent === 'all') {
    dirs = ALL_DIRS;
  } else {
    const d = AGENT_DIRS[agent];
    if (!d) {
      throw new CliError(
        `--agent deve ser um de: ${Object.keys(AGENT_DIRS).join(', ')}, all.`,
        EXIT.USAGE,
      );
    }
    dirs = [d];
  }

  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  const raiz = parsed.values.global === true ? home : process.cwd();

  const skillSrc = path.join(PKG_SKILLS_DIR, SKILL_NAME, 'SKILL.md');
  let skillBody: string;
  try {
    skillBody = await fs.readFile(skillSrc, 'utf-8');
  } catch {
    throw new CliError('SKILL.md não encontrado no pacote.', EXIT.ERROR);
  }

  const escritos: string[] = [];
  for (const rel of dirs) {
    const destDir = path.join(raiz, rel, SKILL_NAME);
    const dest = path.join(destDir, 'SKILL.md');
    if (!dryRun) {
      await fs.mkdir(destDir, { recursive: true });
      await fs.writeFile(dest, skillBody, 'utf-8');
    }
    escritos.push(dest);
    out.info(`${dryRun ? '[dry-run] ' : ''}skill → ${dest}`);
  }

  // AGENTS.md/CLAUDE.md: ACRESCENTA um bloco delimitado, nunca sobrescreve.
  // Neste repo CLAUDE.md e symlink de AGENTS.md — resolvemos o caminho real
  // para nao escrever o mesmo bloco duas vezes.
  const notas: Record<string, string> = {};
  const candidatos = ['AGENTS.md', 'CLAUDE.md'];
  const vistos = new Set<string>();
  for (const nome of candidatos) {
    const p = path.join(raiz, nome);
    let real = p;
    try {
      real = await fs.realpath(p);
    } catch {
      // nao existe ainda: so cria AGENTS.md
      if (nome !== 'AGENTS.md') continue;
    }
    if (vistos.has(real)) continue;
    vistos.add(real);
    notas[nome] = await upsertAgentsBlock(real, force, dryRun);
    out.info(`${dryRun ? '[dry-run] ' : ''}${nome}: ${notas[nome]}`);
  }

  out.result(true, 'init', { skills: escritos, agentsMd: notas, dryRun });
  return EXIT.OK;
}
