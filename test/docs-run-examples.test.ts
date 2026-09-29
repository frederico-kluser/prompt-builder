// cli#5 · skill-install#0 · skill-install#5 — todo exemplo DOCUMENTADO de
// `compare`/`vary`/`train` passa no PRÉ-VOO real, com o orçamento que a doc
// escreve.
//
// O furo medido: o docs-lint já roda os exemplos por flags no parser +
// `buildFromFlags` (regras do schema, exit 3), mas não no pré-voo de ORÇAMENTO.
// Resultado: o "caminho feliz" (`config example --mode train` → `train --config
// arena.json --budget 3`) saía exit 2 `usage.budget_below_estimate` — o exemplo
// gerado custava $5,94–$7,94 — em quickstart.md, train.md, ndjson.md e no
// README, e os exemplos por flags de vary/train também saíam 2.
//
// Aqui cada invocação de run dos blocos bash de agent-docs/, skills/, README.md
// e GUIA.md roda como `--dry-run --json` pelo binário COMPILADO, sem key, num
// data-dir descartável com o catálogo semeado (recorte REAL de 2026-09-29 em
// test/fixtures/catalog-docs-examples.json) e o OpenRouter apontado para uma
// porta morta — nada sai da máquina, nada é gasto. `--config <arq>` usa o que
// `config example --mode <verbo>` gera (é o caminho que a doc ensina).
// Exit 0 = quem copiar o exemplo passa no pré-voo; o que falta (key, saldo)
// vem em `data.requires`, nunca como recusa.
//
// Preço muda com o tempo: o fixture congela o catálogo para o teste ser
// determinístico; o orçamento da doc deve ter folga sobre `estimate.high`.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collectDocBlocks,
  commandInvocations,
  readDocSources,
  tokenizeCommand,
  unquoteToken,
  type DocSource,
} from '../scripts/docs-lint.js';
import { nodeOrTsx } from './support/cli.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { cmd: NODE, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));
const DEAD_BASE = 'http://127.0.0.1:9/api/v1';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'catalog-docs-examples.json');
const BINS = new Set(['prompt-builder-cli', 'prompt-builder', 'pbuilder']);
const RUN_VERBS = new Set(['compare', 'vary', 'train']);

/** Onde a doc HUMANA também ensina comandos (fora do tarball, fora do docs-lint). */
const EXTRA_DOCS = ['README.md', 'GUIA.md'];

interface Example {
  where: string;
  invocation: string;
  verb: string;
  args: string[];
}

function sources(): DocSource[] {
  const out = readDocSources(ROOT);
  for (const f of EXTRA_DOCS) out.push({ file: f, markdown: readFileSync(path.join(ROOT, f), 'utf-8') });
  return out;
}

/** Invocações de run executáveis (sem placeholder `<…>`), com a origem `arquivo:linha`. */
function runExamples(docs: DocSource[]): Example[] {
  const out: Example[] = [];
  for (const { file, markdown } of docs) {
    for (const block of collectDocBlocks(markdown, file)) {
      if (!['bash', 'sh', 'shell', 'console', ''].includes(block.lang.toLowerCase())) continue;
      for (const invocation of commandInvocations(block.body)) {
        let t = tokenizeCommand(invocation);
        while (t.length && !BINS.has(t[0])) t = t.slice(1);
        const verb = t[1];
        if (!verb || !RUN_VERBS.has(verb)) continue;
        if (t.some((x) => x.includes('<') || x.includes('…'))) continue;
        out.push({ where: `${file}:${block.line}`, invocation: invocation.replace(/\s+/gu, ' '), verb, args: t.slice(2).map(unquoteToken) });
      }
    }
  }
  return out;
}

let home = '';
let work = '';

function cli(args: string[], cwd: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: home, OPENROUTER_BASE_URL: DEAD_BASE };
  delete env.OPENROUTER_API_KEY;
  delete env.OPENROUTER_KEY;
  return spawnSync(NODE, [ENTRY, ...args], { cwd, env, encoding: 'utf-8', input: '', timeout: 60_000 });
}

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'pb-docs-examples-'));
  work = mkdtempSync(path.join(tmpdir(), 'pb-docs-examples-cwd-'));
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as { data: unknown[] };
  mkdirSync(path.join(home, 'cache'), { recursive: true });
  writeFileSync(
    path.join(home, 'cache', 'models-public.json'),
    JSON.stringify({ v: 2, fetchedAt: Date.now(), base: DEAD_BASE, count: fixture.data.length, data: fixture.data }),
  );
});

afterAll(() => {
  for (const d of [home, work]) if (d) rmSync(d, { force: true, recursive: true });
});

const EXAMPLES = runExamples(sources());

describe('exemplos de run documentados passam no pré-voo (--dry-run, sem key, catálogo congelado)', () => {
  it('a extração acha os exemplos (não passa por vazio)', () => {
    // quickstart ×2, train ×3, vary, compare, ndjson ×2, SKILL.md ×2, README ×2 — no mínimo.
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(EXAMPLES.map((e) => e.verb))).toEqual(new Set(['compare', 'vary', 'train']));
  });

  it.each(EXAMPLES.map((e) => [e.where, e] as const))('%s', (_where, ex) => {
    const cwd = mkdtempSync(path.join(work, 'ex-'));
    writeFileSync(path.join(cwd, 'prompt.md'), 'Você é um assistente de suporte. Responda de forma curta e correta.\n');
    const args: string[] = [];
    for (let i = 0; i < ex.args.length; i += 1) {
      const a = ex.args[i];
      if (a === '--output-format') {
        i += 1;
        continue;
      }
      if (a === '--json' || a === '--dry-run' || a.startsWith('--output-format=')) continue;
      args.push(a);
    }
    const ci = args.indexOf('--config');
    if (ci >= 0) {
      const gen = cli(['config', 'example', '--mode', ex.verb, '-o', args[ci + 1]], cwd);
      expect(gen.status, `config example --mode ${ex.verb}: ${gen.stderr}`).toBe(0);
    }
    const r = cli([ex.verb, ...args, '--dry-run', '--json'], cwd);
    let out: { ok?: boolean; error?: { code?: string; message?: string; details?: { estimate?: { low?: number; high?: number } } } } = {};
    try {
      out = JSON.parse(r.stdout);
    } catch {
      /* diagnóstico abaixo */
    }
    const est = out.error?.details?.estimate;
    const diag =
      `${ex.where} — \`${ex.invocation}\` saiu ${r.status} [${out.error?.code ?? 'sem envelope'}] ` +
      `${out.error?.message ?? r.stderr.slice(0, 400)}` +
      (est ? ` (estimativa $${est.low?.toFixed(2)}–$${est.high?.toFixed(2)}: a doc precisa de --budget ≥ o teto)` : '');
    expect(r.status, diag).toBe(0);
    expect(out.ok, diag).toBe(true);
  });
});
