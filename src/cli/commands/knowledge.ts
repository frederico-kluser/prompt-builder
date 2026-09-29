// `docs` / `skill` / `init` — o CLI ensinando um agente a usar o CLI.
//
// A documentacao viaja DENTRO do pacote (`agent-docs/`, ver `files` do
// package.json) e e lida do disco local: sempre casada com a versao do binario,
// sem rede e sem custo de token ate ser pedida. E o padrao que o Next.js 16.2
// adotou (docs versionadas em node_modules em vez de uma skill estatica).

import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { PKG_DOCS_DIR, PKG_SKILLS_DIR } from '../../paths.js';
import { CliError, EXIT } from '../output.js';
import { buildContext, parse } from '../context.js';
import { recordTelemetryEvent } from './telemetry.js';

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
// montado a partir do index.json embarcado, e o input nunca entra num
// path.join. CLI e MCP usam a MESMA função.
//
// cli#4/mcp#5: TODO tópico é `agent-docs/<tópico>.md`, sem exceção. `config`
// apontava para um `ARENA-CONFIG.md` na raiz do pacote — apagado do repo e fora
// do tarball — e `docs config`/`read_docs {topic:'config'}` falhavam SEMPRE
// (enquanto `docs --list` e o `--help` mandavam lê-lo). O contrato agora vive
// em `agent-docs/config.md`, que viaja com o resto.

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
    // IMPL-120: funil de descoberta — no-op sem opt-in (nada contado nem gravado).
    recordTelemetryEvent('docs.list', ctx.dataDir);
    return EXIT.OK;
  }

  if (parsed.values.all === true) {
    const partes: string[] = [];
    const lidos: string[] = [];
    const faltando: string[] = [];
    for (const e of index) {
      const lido = await readDocTopic(e.topic);
      if (lido.ok) {
        partes.push(lido.content);
        lidos.push(e.topic);
      } else {
        // cli#4: tópico listado e ilegível NUNCA some em silêncio do `--all`.
        faltando.push(e.topic);
        out.warn(`docs --all: ${lido.message}`);
      }
    }
    const content = `${partes.join('\n\n---\n\n')}\n`;
    // cli#18: sob --json/ndjson o stdout é o envelope (JSON.parse funciona).
    if (out.isText) out.raw(content);
    else out.result(true, 'docs.all', { topics: lidos, missing: faltando, content });
    return EXIT.OK;
  }

  const lido = await readDocTopic(topic);
  if (!lido.ok) {
    throw new CliError(`${lido.message} Veja \`prompt-builder docs --list\`.`, EXIT.USAGE);
  }
  if (out.isText) out.raw(lido.content);
  else out.result(true, 'docs.topic', { topic: lido.topic, content: lido.content });
  return EXIT.OK;
}

/**
 * Arquivos da skill embarcada (`skills/prompt-builder/`): só arquivos REGULARES
 * de primeiro nível, em ordem estável. O SKILL.md aponta para os vizinhos
 * (`models.md`, "ao lado desta skill") — por isso `init` copia a pasta inteira
 * e `skill <arquivo>` imprime qualquer um deles.
 */
async function skillFiles(): Promise<string[]> {
  const dir = path.join(PKG_SKILLS_DIR, SKILL_NAME);
  let entradas: Dirent[];
  try {
    entradas = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    throw new CliError('Pasta da skill não encontrada no pacote.', EXIT.ERROR);
  }
  const nomes = entradas
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
  if (!nomes.includes('SKILL.md')) throw new CliError('SKILL.md não encontrado no pacote.', EXIT.ERROR);
  return nomes;
}

export async function cmdSkill(argv: string[]): Promise<number> {
  const parsed = parse(argv, {});
  const ctx = buildContext(parsed);
  const { out } = ctx;
  const nomes = await skillFiles();
  // `skill` = SKILL.md; `skill models` / `skill models.md` = o vizinho. O nome
  // pedido é só uma CHAVE contra a listagem da pasta (nunca entra num path.join).
  const pedido = parsed.positionals[0];
  const nome = pedido === undefined ? 'SKILL.md' : nomes.find((n) => n === pedido || n === `${pedido}.md`);
  if (!nome) {
    throw new CliError(
      `Arquivo da skill desconhecido. Disponíveis: ${nomes.join(', ')}.`,
      EXIT.USAGE,
      { files: nomes },
      { code: 'usage.unknown_skill_file', hint: 'Use `prompt-builder skill` (SKILL.md) ou `prompt-builder skill models`.' },
    );
  }
  const content = await fs.readFile(path.join(PKG_SKILLS_DIR, SKILL_NAME, nome), 'utf-8');
  // cli#18: sob --json/ndjson o stdout é o envelope, não markdown cru.
  if (out.isText) out.raw(content);
  else out.result(true, 'skill', { name: SKILL_NAME, file: nome, files: nomes, content });
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

  const global = parsed.values.global === true;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  const raiz = global ? home : process.cwd();

  // cli#21/skill-install#9: a skill é a PASTA inteira — o SKILL.md aponta para
  // os vizinhos (`models.md`, "ao lado desta skill"); copiar só o SKILL.md
  // deixava a referência morta em toda instalação por cópia.
  const nomes = await skillFiles();
  const srcDir = path.join(PKG_SKILLS_DIR, SKILL_NAME);
  const conteudos = new Map<string, string>();
  for (const nome of nomes) conteudos.set(nome, await fs.readFile(path.join(srcDir, nome), 'utf-8'));

  const escritos: string[] = [];
  const mantidos: { path: string; reason: 'symlink' }[] = [];
  const pastasReais = new Set<string>();
  for (const rel of dirs) {
    const destDir = path.join(raiz, rel, SKILL_NAME);
    // skill-install#10: pasta da skill que é SYMLINK = instalação por link
    // (scripts/install-agent-skill.sh aponta para o checkout/pacote). Escrever
    // "dentro" dela sobrescrevia o SKILL.md do REPO alvo — nunca atravesse.
    const alvoDoLink = await symlinkTarget(destDir);
    if (alvoDoLink !== null) {
      mantidos.push({ path: destDir, reason: 'symlink' });
      out.info(
        `${destDir}: já instalada por symlink (→ ${alvoDoLink}) — mantida. ` +
          'Remova o link se quiser uma cópia desta versão.',
      );
      continue;
    }
    // `.claude/skills` pode ser symlink de `.agents/skills` (como neste repo):
    // a mesma pasta REAL só é escrita uma vez.
    const real = await realPathOf(destDir);
    if (pastasReais.has(real)) {
      out.info(`${destDir}: mesma pasta real de um destino anterior (${real}) — já coberta.`);
      continue;
    }
    pastasReais.add(real);
    if (!dryRun) await fs.mkdir(destDir, { recursive: true });
    for (const nome of nomes) {
      const dest = path.join(destDir, nome);
      if ((await symlinkTarget(dest)) !== null) {
        mantidos.push({ path: dest, reason: 'symlink' });
        out.info(`${dest}: é symlink — mantido (nunca escrevo através de um link).`);
        continue;
      }
      if (!dryRun) await fs.writeFile(dest, conteudos.get(nome)!, 'utf-8');
      escritos.push(dest);
    }
    out.info(`${dryRun ? '[dry-run] ' : ''}skill → ${destDir} (${nomes.join(', ')})`);
  }

  // AGENTS.md/CLAUDE.md: ACRESCENTA um bloco delimitado, nunca sobrescreve.
  // Neste repo CLAUDE.md e symlink de AGENTS.md — resolvemos o caminho real
  // para nao escrever o mesmo bloco duas vezes.
  // skill-install#10: com --global a raiz é o HOME, e um AGENTS.md na raiz do
  // HOME não é a instrução global de agente nenhum (cada um tem a sua, dentro da
  // própria pasta) — o bloco só criaria um arquivo solto. Fica de fora.
  const notas: Record<string, string> = {};
  if (global) {
    out.info(
      '--global não mexe em AGENTS.md/CLAUDE.md: na raiz do HOME eles não são a instrução global dos ' +
        'agentes (cada um tem a sua, ex.: .claude/CLAUDE.md, .codex/AGENTS.md) — a skill instalada basta.',
    );
  } else {
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
  }

  out.result(true, 'init', {
    skills: escritos,
    files: nomes,
    kept: mantidos,
    agentsMd: notas,
    ...(global ? { agentsMdSkipped: 'global' } : {}),
    dryRun,
  });
  return EXIT.OK;
}

/** Alvo do link se `p` é symlink; `null` se não é (ou não existe). */
async function symlinkTarget(p: string): Promise<string | null> {
  try {
    const st = await fs.lstat(p);
    if (!st.isSymbolicLink()) return null;
    return await fs.readlink(p);
  } catch {
    return null;
  }
}

/**
 * Caminho REAL de `p` mesmo que ele ainda não exista: resolve o ancestral
 * existente mais próximo (symlinks inclusos) e reanexa o resto.
 */
async function realPathOf(p: string): Promise<string> {
  const resto: string[] = [];
  let atual = path.resolve(p);
  for (;;) {
    try {
      return path.join(await fs.realpath(atual), ...resto);
    } catch {
      const pai = path.dirname(atual);
      if (pai === atual) return path.resolve(p);
      resto.unshift(path.basename(atual));
      atual = pai;
    }
  }
}
