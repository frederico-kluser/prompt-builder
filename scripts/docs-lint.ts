#!/usr/bin/env tsx
// IMPL-119 (R-19:REC-1) — lint da documentação embarcada (agent-docs/), que viaja
// no tarball e é lida por agentes: os exemplos de configuração passam pelo
// VALIDADOR REAL (`prompt-builder config validate` / parser de arena-agent-config),
// os comandos dos blocos bash são conferidos contra a tabela COMMANDS + help, e o
// snapshot de `--help` por subcomando é regenerado e comparado ("gerado ≠
// commitado" reprova). Antes nenhum exemplo de doc passava por validador nenhum
// — os agent-docs podiam ensinar configurações que o CLI recusa.
//
// MARCAÇÕES EXPLÍCITAS (na info da cerca ou em comentário HTML imediatamente
// antes dela — `<!-- docs-lint: … -->`):
//   - `expect-invalid` : exemplo NEGATIVO — o validador tem de RECUSAR (exemplo
//     negativo que valida também reprova; sem a marcação, um exemplo inválido
//     reprova igual);
//   - `snippet`        : fragmento parcial (uma chave solta do config) — não é
//     executado no validador, só documenta.
//
// Uso: `npx tsx scripts/docs-lint.ts [--update-help] [--json]`
//   --update-help : regrava scripts/docs-lint.help.json (o snapshot commitado).
//   exit 0 = doc limpa · exit 1 = achados (detalhe no stderr, ou --json).
//
// O que NÃO é coberto aqui (degrau seguinte `docs:gen`): referência de
// arena-config@1 gerada do schema zod único, lista de env vars extraída do
// código e tabela de comandos/exit codes.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMMANDS, renderCommandHelp } from '../src/cli/help.js';
import { cmdConfig } from '../src/cli/commands/misc.js';
import { parseArenaAgentConfig } from '../src/configFile.js';
import { assertNoUnknownConfigKeys } from '../src/cli/context.js';
import { EXIT } from '../src/cli/output.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = join(ROOT, 'agent-docs');
/** Snapshot commitado do `--help` por subcomando ("gerado ≠ commitado" reprova). */
export const HELP_SNAPSHOT_PATH = join(ROOT, 'scripts', 'docs-lint.help.json');

/** Formatos de configuração que a doc pode exemplificar. */
const ARENA_FORMAT = 'arena-config@1';
const ARENA_AGENT_FORMAT = 'arena-agent-config@1';

// ---------------------------------------------------------------------------
// Extração dos blocos da doc
// ---------------------------------------------------------------------------

/** Um bloco cercado por ``` da doc, com a linha onde começa a cerca. */
export interface DocBlock {
  file: string;
  /** Linha (1-based) da abertura da cerca. */
  line: number;
  /** Info da cerca (`json`, `jsonc`, `bash`, …) sem os marcadores. */
  lang: string;
  /** Tokens de marcação (`expect-invalid`, `snippet`). */
  marks: DocMarks;
  body: string;
}

export interface DocMarks {
  expectInvalid: boolean;
  snippet: boolean;
}

const MARK_TOKENS = ['expect-invalid', 'snippet'] as const;

function marksFrom(info: string, before: string): { lang: string; marks: DocMarks } {
  const tokens = info.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const comment = /<!--\s*docs-lint:\s*([a-z0-9 ,_-]+)\s*-->/i.exec(before ?? '')?.[1] ?? '';
  const all = [...tokens, ...comment.toLowerCase().split(/[\s,]+/)];
  const lang = tokens.find((t) => !MARK_TOKENS.includes(t as (typeof MARK_TOKENS)[number])) ?? '';
  return {
    lang,
    marks: {
      expectInvalid: all.includes('expect-invalid'),
      snippet: all.includes('snippet'),
    },
  };
}

/** Separa os blocos ``` de um markdown, com linha e marcações. */
export function collectDocBlocks(markdown: string, file: string): DocBlock[] {
  const out: DocBlock[] = [];
  const linhas = markdown.split('\n');
  let i = 0;
  while (i < linhas.length) {
    const m = /^```(.*)$/.exec(linhas[i]);
    if (!m) {
      i += 1;
      continue;
    }
    const openLine = i + 1;
    // Linha anterior útil (para o comentário de marcação `<!-- docs-lint: … -->`).
    let before = '';
    for (let b = i - 1; b >= 0 && b >= i - 3; b -= 1) {
      const t = linhas[b].trim();
      if (t) {
        before = t;
        break;
      }
    }
    const body: string[] = [];
    i += 1;
    while (i < linhas.length && !/^```\s*$/.test(linhas[i])) {
      body.push(linhas[i]);
      i += 1;
    }
    i += 1; // fecha a cerca
    const { lang, marks } = marksFrom(m[1] ?? '', before);
    out.push({ file, line: openLine, lang, marks, body: body.join('\n') });
  }
  return out;
}

/**
 * Remove comentários `//` de um jsonc SEM tocar em strings (URLs dentro de
 * strings sobrevivem). Bloco cercado por ```jsonc da doc usa este formato.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let emString = false;
  let escapou = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (emString) {
      out += ch;
      if (escapou) escapou = false;
      else if (ch === '\\') escapou = true;
      else if (ch === '"') emString = false;
      continue;
    }
    if (ch === '"') {
      emString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validação REAL dos exemplos de configuração
// ---------------------------------------------------------------------------

/** Desfecho de um exemplo executado no validador real. */
export interface ConfigValidation {
  ok: boolean;
  /** Exit code do `config validate` (ou equivalente do parser agente). */
  code: number;
  error?: string;
}

/** Executa `f` com stdout/stderr MUDOS (o validador narra; aqui atrapalha). */
async function muted<T>(f: () => Promise<T>): Promise<T> {
  const so = process.stdout.write;
  const se = process.stderr.write;
  const mudo = () => true;
  process.stdout.write = mudo as typeof process.stdout.write;
  process.stderr.write = mudo as typeof process.stderr.write;
  try {
    return await f();
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

/**
 * Roda o EXEMPLO no validador real: `config validate` (arena-config@1, o
 * caminho completo do CLI — parse + chaves desconhecidas + tradução + library)
 * ou `parseArenaAgentConfig` + `assertNoUnknownConfigKeys` (arena-agent-config@1,
 * o validador do `agents run --config`). Nunca lança: vira `ConfigValidation`.
 */
export async function validateConfigExample(json: unknown, format: string): Promise<ConfigValidation> {
  if (format === ARENA_AGENT_FORMAT) {
    try {
      const p = parseArenaAgentConfig(json);
      if (!p.ok) return { ok: false, code: EXIT.CONFIG, error: p.error };
      assertNoUnknownConfigKeys(json, p.config);
      return { ok: true, code: EXIT.OK };
    } catch (err) {
      const e = err as { code?: number; message?: string };
      return { ok: false, code: typeof e.code === 'number' ? e.code : EXIT.CONFIG, error: e.message ?? 'recusado' };
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'docs-lint-'));
  const file = join(dir, 'exemplo.json');
  try {
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
    const code = await muted(() => cmdConfig(['validate', file]));
    return code === EXIT.OK ? { ok: true, code } : { ok: false, code, error: `config validate saiu com exit ${code}` };
  } catch (err) {
    const e = err as { code?: number; message?: string };
    return { ok: false, code: typeof e.code === 'number' ? e.code : EXIT.CONFIG, error: e.message ?? 'recusado' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Comandos dos blocos bash
// ---------------------------------------------------------------------------

const BIN_RE = /(?:^|[\s|;&])(?:(?:npx|npm exec)\s+)?(?:prompt-builder-cli|prompt-builder|pbuilder)(?=\s|$)/;

/** Tokenizer simples com aspas (só para separar comando/posicionais/valores). */
export function tokenizeCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let aspas: string | null = null;
  for (const ch of cmd) {
    if (aspas) {
      cur += ch;
      if (ch === aspas) aspas = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      aspas = ch;
      cur += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Invocações `prompt-builder …` de um bloco bash: continuações `\` juntadas,
 * comentários e pipes/redirecionamentos cortados. Só o trecho que é comando do
 * CLI (o `| jq …` do exemplo é do consumidor, não do CLI).
 */
export function commandInvocations(body: string): string[] {
  const joined = body.replace(/\\\n/g, ' ');
  const out: string[] = [];
  for (const raw of joined.split('\n')) {
    const semComentario = raw.replace(/\s+#.*$/, '');
    const m = BIN_RE.exec(semComentario);
    if (!m) continue;
    const comando = semComentario.slice(m.index).replace(/^[\s|;&]+/, '');
    // Corta em pipe/redirecionamento/&&/; do EXEMPLO (fora de aspas).
    let fim = comando.length;
    let aspas: string | null = null;
    for (let i = 0; i < comando.length; i += 1) {
      const ch = comando[i];
      if (aspas) {
        if (ch === aspas) aspas = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        aspas = ch;
        continue;
      }
      if ((ch === '|' || ch === '>' || ch === ';') && (i === 0 || /\s/.test(comando[i - 1]))) {
        fim = i;
        break;
      }
      if (ch === '&' && comando[i + 1] === '&') {
        fim = i;
        break;
      }
    }
    const limpo = comando.slice(0, fim).trim();
    if (limpo) out.push(limpo);
  }
  return out;
}

/** Um achado do lint (reprova o CI quando a lista não é vazia). */
export interface LintFinding {
  file: string;
  line: number;
  kind:
    | 'config-invalid'
    | 'config-negative-passed'
    | 'config-unparseable'
    | 'config-unknown-format'
    | 'command-unknown'
    | 'subcommand-unknown'
    | 'help-missing'
    | 'help-extra'
    | 'help-changed';
  message: string;
  /** Hash JCS-ish do corpo do bloco — âncora do drift conhecido (mudou o bloco, caiu a isenção). */
  blockHash?: string;
}

/** Hash estável do corpo de um bloco (o exemplo, sem a cerca). */
export function blockHash(body: string): string {
  return createHash('sha256').update(body.trim(), 'utf-8').digest('hex').slice(0, 16);
}

/**
 * Drift CONHECIDO da doc: o lint achou, a correção é do dono do arquivo e está
 * PENDENTE (fora da fronteira do lote que escreveu este lint). Cada entrada é
 * auditável — file + kind + hash do corpo exato — e some sozinha assim que o
 * bloco for tocado (hash muda ⇒ a isenção deixa de valer e o CI reprova de
 * novo). Nunca é atalho para silenciar achado novo: é o registo do que falta
 * corrigir na doc.
 */
export interface KnownDrift {
  file: string;
  kind: LintFinding['kind'];
  blockHash: string;
  /** O que está errado (obrigatório: isenção sem motivo não entra). */
  reason: string;
  /** A correção esperada (obrigatória). */
  fix: string;
}

export const KNOWN_DOC_DRIFT: KnownDrift[] = [
  {
    file: 'agent-docs/compare.md',
    kind: 'config-invalid',
    // Exemplo `competitorConfigs` com datagen igual ao modelo dos concorrentes.
    blockHash: blockHash(`{
  "format": "arena-config@1",
  "mode": "compare",
  "theme": "…",
  "models": {
    "datagen": "openai/gpt-5-mini",
    "judges": ["anthropic/claude-sonnet-5"],
    "competitorConfigs": [
      { "model": "openai/gpt-5-mini", "reasoning": "low" },
      { "model": "openai/gpt-5-mini", "reasoning": "high" }
    ]
  }
}`),
    reason:
      'O exemplo ensina `competitorConfigs` com o MESMO modelo do datagen, que o validador real recusa ' +
      '(runConfigSchema: "O gerador de cenarios nao pode ser tambem um competidor") — a doc contradiz a ' +
      'própria regra que lista 3 linhas acima. Drift já existente quando o lint nasceu.',
    fix:
      'Corrigir agent-docs/compare.md: usar um `models.datagen` DISTINTO dos modelos dos competitorConfigs ' +
      '(ex.: datagen "openai/gpt-5.1-nano"), mantendo o mesmo modelo concorrendo consigo mesmo. ' +
      'Pendente: arquivo fora da fronteira do lote O-p2-resto.',
  },
];

/**
 * Confere uma invocação do CLI: o comando tem de existir em COMMANDS (a fonte
 * única do dispatch) e o subcomando literal tem de aparecer no help daquele
 * comando. Placeholders (`<id>`) e valores de flag não são conferidos.
 */
export function checkCommandInvocation(invocation: string, file: string, line: number): LintFinding[] {
  const achados: LintFinding[] = [];
  let tokens = tokenizeCommand(invocation);
  // Corta o runner (`npx`) e o nome do binário.
  while (tokens.length && tokens[0] !== 'prompt-builder-cli' && tokens[0] !== 'prompt-builder' && tokens[0] !== 'pbuilder') {
    tokens = tokens.slice(1);
  }
  tokens = tokens.slice(1);
  const cmd = tokens[0];
  if (!cmd) return achados;
  if (!(COMMANDS as readonly string[]).includes(cmd)) {
    achados.push({
      file,
      line,
      kind: 'command-unknown',
      message: `comando "${cmd}" não existe em COMMANDS (comando: ${invocation})`,
    });
    return achados;
  }
  // Primeiro posicional literal depois do comando = subcomando.
  let anteriorFlag = false;
  for (const t of tokens.slice(1)) {
    const literal = t.replace(/[\]"']+$/, '');
    if (literal.startsWith('-')) {
      anteriorFlag = true;
      continue;
    }
    if (anteriorFlag) {
      anteriorFlag = false;
      continue; // valor de flag
    }
    if (!literal || literal.startsWith('<') || literal.startsWith('[') || literal.includes('<')) continue;
    const help = renderCommandHelp(cmd);
    if (!new RegExp(`\\b${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(help)) {
      achados.push({
        file,
        line,
        kind: 'subcommand-unknown',
        message: `subcomando "${literal}" não aparece no help de \`${cmd}\` (comando: ${invocation})`,
      });
    }
    break; // só o primeiro posicional (o slot de subcomando)
  }
  return achados;
}

// ---------------------------------------------------------------------------
// Lint dos fontes da doc
// ---------------------------------------------------------------------------

/** Um arquivo markdown da doc embarcada. */
export interface DocSource {
  file: string;
  markdown: string;
}

export interface LintReport {
  /** Achados que REPROVAM o CI. */
  findings: LintFinding[];
  /** Achados cobertos por {@link KNOWN_DOC_DRIFT} (drift conhecido, correção pendente). */
  waived: LintFinding[];
  checked: {
    files: number;
    configExamples: number;
    commandInvocations: number;
    snippets: number;
  };
}

/** Todos os `agent-docs/*.md` embarcados, em ordem estável. */
export function readDocSources(docsDir: string = DOCS_DIR): DocSource[] {
  return readdirSync(docsDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({ file: `agent-docs/${f}`, markdown: readFileSync(join(docsDir, f), 'utf-8') }));
}

/**
 * O lint em si: exemplos de configuração executados no validador REAL (os
 * negativos marcados têm de ser recusados) e comandos conferidos contra a
 * tabela COMMANDS + help. `snippet` documenta um fragmento e não roda.
 */
export async function lintDocs(sources: DocSource[] = readDocSources()): Promise<LintReport> {
  const findings: LintFinding[] = [];
  const checked = { files: sources.length, configExamples: 0, commandInvocations: 0, snippets: 0 };

  for (const { file, markdown } of sources) {
    for (const block of collectDocBlocks(markdown, file)) {
      const lang = block.lang.toLowerCase();
      const hash = blockHash(block.body);
      const ancla = (f: Omit<LintFinding, 'blockHash'>): LintFinding => ({ ...f, blockHash: hash });
      if (lang === 'json' || lang === 'jsonc') {
        if (block.marks.snippet) {
          checked.snippets += 1;
          continue;
        }
        const texto = stripJsonComments(block.body);
        const declaraFormat = /"format"\s*:/.test(texto);
        let json: unknown;
        let parseError: string | null = null;
        try {
          json = JSON.parse(texto);
        } catch (err) {
          parseError = (err as Error).message;
        }
        if (!declaraFormat) {
          // Payload/exemplo de SAÍDA: não é configuração — só precisa ser JSON
          // completo quando é um valor completo (fragmentos de payload existem).
          continue;
        }
        checked.configExamples += 1;
        if (parseError !== null) {
          findings.push(
            ancla({
              file,
              line: block.line,
              kind: 'config-unparseable',
              message: `exemplo de configuração com JSON inválido: ${parseError}`,
            }),
          );
          continue;
        }
        const format = (json as Record<string, unknown>)?.format;
        const esperadoInvalido = block.marks.expectInvalid;
        if (typeof format !== 'string' || (format !== ARENA_FORMAT && format !== ARENA_AGENT_FORMAT)) {
          if (esperadoInvalido) {
            // Exemplo negativo por "format" desconhecido/ausente: o validador real
            // recusa — está de acordo com a marcação.
            continue;
          }
          findings.push(
            ancla({
              file,
              line: block.line,
              kind: 'config-unknown-format',
              message: `formato "${String(format)}" não é ${ARENA_FORMAT} nem ${ARENA_AGENT_FORMAT}`,
            }),
          );
          continue;
        }
        const r = await validateConfigExample(json, format);
        if (esperadoInvalido) {
          if (r.ok) {
            findings.push(
              ancla({
                file,
                line: block.line,
                kind: 'config-negative-passed',
                message:
                  'exemplo NEGATIVO marcado mas o validador real aceitou — ou a marcação sobra, ou o validador mudou',
              }),
            );
          }
          continue;
        }
        if (!r.ok) {
          findings.push(
            ancla({
              file,
              line: block.line,
              kind: 'config-invalid',
              message: `exemplo da doc recusado pelo validador real (exit ${r.code}): ${r.error ?? ''}`,
            }),
          );
        }
        continue;
      }
      if (lang === 'bash' || lang === 'sh' || lang === 'shell' || lang === 'console') {
        if (block.marks.snippet) {
          checked.snippets += 1;
          continue;
        }
        for (const inv of commandInvocations(block.body)) {
          checked.commandInvocations += 1;
          findings.push(...checkCommandInvocation(inv, block.file, block.line).map(ancla));
        }
      }
    }
  }
  // Ordena estável por arquivo/linha e separa o drift CONHECIDO (isenção
  // auditável, keyed por hash do bloco) do que reprova o CI.
  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  const isentos = (f: LintFinding): boolean =>
    KNOWN_DOC_DRIFT.some((d) => d.file === f.file && d.kind === f.kind && d.blockHash === f.blockHash);
  return {
    findings: findings.filter((f) => !isentos(f)),
    waived: findings.filter(isentos),
    checked,
  };
}

// ---------------------------------------------------------------------------
// Snapshot de --help por subcomando (gerado ≠ commitado reprova)
// ---------------------------------------------------------------------------

/**
 * O `--help` de TODO subcomando da tabela COMMANDS — 100% de cobertura por
 * construção (quem entra em COMMANDS e não tem snapshot reprova, e vice-versa).
 */
export function helpSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cmd of COMMANDS) out[cmd] = renderCommandHelp(cmd);
  return out;
}

/** Compara o snapshot commitado com o gerado: cobertura 100% + texto igual. */
export function helpSnapshotFindings(snapshot: Record<string, string>, file = 'scripts/docs-lint.help.json'): LintFinding[] {
  const achados: LintFinding[] = [];
  const gerado = helpSnapshot();
  for (const cmd of COMMANDS) {
    if (!(cmd in snapshot)) {
      achados.push({ file, line: 1, kind: 'help-missing', message: `subcomando "${cmd}" sem snapshot de --help (rode --update-help)` });
    } else if (snapshot[cmd] !== gerado[cmd]) {
      achados.push({ file, line: 1, kind: 'help-changed', message: `--help de "${cmd}" mudou mas o snapshot não (gerado ≠ commitado)` });
    }
  }
  for (const cmd of Object.keys(snapshot)) {
    if (!(COMMANDS as readonly string[]).includes(cmd)) {
      achados.push({ file, line: 1, kind: 'help-extra', message: `snapshot de "${cmd}" mas o comando não está em COMMANDS` });
    }
  }
  return achados;
}

/** Lê o snapshot commitado (arquivo ausente = tudo faltando). */
export function readHelpSnapshot(path: string = HELP_SNAPSHOT_PATH): Record<string, string> {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Regrava o snapshot commitado (chamado por `--update-help`). */
export function writeHelpSnapshot(path: string = HELP_SNAPSHOT_PATH): void {
  writeFileSync(path, `${JSON.stringify(helpSnapshot(), null, 2)}\n`, 'utf-8');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const updateHelp = argv.includes('--update-help');
  const comoJson = argv.includes('--json');
  if (updateHelp) writeHelpSnapshot();

  const report = await lintDocs();
  const helpFindings = helpSnapshotFindings(readHelpSnapshot());
  const findings = [...report.findings, ...helpFindings];

  if (comoJson) {
    process.stdout.write(
      `${JSON.stringify({ ok: findings.length === 0, checked: report.checked, findings, waived: report.waived }, null, 2)}\n`,
    );
  } else {
    for (const f of findings) {
      process.stderr.write(`${f.file}:${f.line} [${f.kind}] ${f.message}\n`);
    }
    for (const f of report.waived) {
      const drift = KNOWN_DOC_DRIFT.find((d) => d.file === f.file && d.kind === f.kind && d.blockHash === f.blockHash);
      process.stderr.write(
        `${f.file}:${f.line} [${f.kind}] DRIFT CONHECIDO (pendente): ${f.message}\n  motivo: ${drift?.reason ?? ''}\n  correção: ${drift?.fix ?? ''}\n`,
      );
    }
    process.stderr.write(
      findings.length === 0
        ? `docs-lint OK — ${report.checked.files} arquivos, ${report.checked.configExamples} exemplos de config no validador real, ${report.checked.commandInvocations} comandos, snapshot --help de ${COMMANDS.length} subcomandos` +
            `${report.waived.length ? ` (+${report.waived.length} drift(s) conhecido(s) e pendente(s))` : ''}.\n`
        : `docs-lint: ${findings.length} achado(s) — corrija a doc ou rode --update-help para o snapshot de --help.\n`,
    );
  }
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`docs-lint explodiu: ${(err as Error).message}\n`);
      process.exitCode = 1;
    });
}