// Modo JEV — contrato do CLI em PROCESSO REAL contra um servidor HTTP local
// (127.0.0.1) que imita o catálogo e o endpoint de decisões: nada sai da
// máquina, nada é gasto. Exit codes, envelope, NDJSON enxuto, --dry-run com a
// mesma recusa da execução real, orçamento (7), gate do export (10) e o help.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeOrTsx } from './support/cli.js';
import { jevExample, withSpecId, type JevQuestionSpec, type JevSessionRecord } from '../src/engine/jev/index.js';
import { DECISION_CATALOG, answerFor } from './fakeDecisions.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { cmd: NODE, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));
const KEY = `sk-or-v1-${'c'.repeat(48)}`;

const EX = jevExample('triagem', 'eval') as { cases: { state: { ticket: string }; expected: Record<string, unknown> }[] };
const GOLD = new Map(EX.cases.map((c) => [c.state.ticket, c.expected]));

let server: Server;
let base = '';
let posts = 0;
let dir = '';

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'jev-cli-'));
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: url.searchParams.get('output_modalities') === 'decisions' ? DECISION_CATALOG : [] }));
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/alpha/decisions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        posts += 1;
        const b = JSON.parse(body) as { model: string; state: { ticket: string }; questions: Record<string, { type: string; criteria: unknown }> };
        const gold = GOLD.get(b.state.ticket) ?? {};
        const answers = Object.fromEntries(Object.entries(b.questions).map(([qid, q]) => [qid, answerFor(q, gold[qid], 0.9, 0.8)]));
        res.writeHead(200, { 'content-type': 'application/json', 'x-generation-id': `gen-dec-${posts}`, 'x-provider-name': 'TypeSafe' });
        res.end(JSON.stringify({ model: `${b.model}-20260917`, answers, usage: { input_tokens: 400, output_tokens: 66, cost: 400 * 0.042e-6 }, id: `gen-dec-${posts}`, provider: 'TypeSafe' }));
      });
      return;
    }
    res.writeHead(404);
    res.end('nao');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], opts: { key?: boolean; home?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    OPENROUTER_BASE_URL: base,
    PROMPT_BUILDER_HOME: opts.home ?? path.join(dir, 'home'),
    PROMPT_BUILDER_DAILY_CAP_USD: 'none',
    ...(opts.key === false ? {} : { OPENROUTER_API_KEY: KEY }),
  };
  return new Promise((resolve) => {
    const child = spawn(NODE, [ENTRY, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function escrever(nome: string, obj: unknown): string {
  const p = path.join(dir, nome);
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

describe('jev — validação e pré-voo (nada gasto)', () => {
  it('validate de config inválido sai 3 (jev.lint) sem nenhum POST', async () => {
    const cfg = jevExample('triagem', 'eval') as Record<string, unknown>;
    const spec = JSON.parse(JSON.stringify(cfg.spec));
    spec.questions.is_bug.criteria = { true: 'só a metade' };
    const p = escrever('ruim.json', { ...cfg, spec });
    const antes = posts;
    const r = await run(['jev', 'validate', p, '--json']);
    expect(r.code).toBe(3);
    const env = JSON.parse(r.stdout);
    expect(env).toMatchObject({ ok: false, error: { code: 'jev.lint', kind: 'config' } });
    expect(JSON.stringify(env.error.details)).toContain('noul.criteria_pair');
    expect(posts).toBe(antes);
  });

  it('validate aceita um DecisionsRequest cru e recusa user longo', async () => {
    const p = escrever('req.json', { model: 'typesafe/jev-1.13', state: 'x', user: 'u'.repeat(300), questions: { b: { type: 'noul', instructions: 'É bug?' } } });
    const r = await run(['jev', 'validate', p, '--json']);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('user.len');
  });

  it('run sem --budget fora de TTY sai 2 e ZERO requests; --dry-run devolve o MESMO código', async () => {
    const p = escrever('ok.json', jevExample('triagem', 'eval'));
    const antes = posts;
    const real = await run(['jev', 'run', '-c', p, '--json']);
    expect(real.code).toBe(2);
    expect(JSON.parse(real.stdout).error.code).toBe('usage.budget_required');
    const seco = await run(['jev', 'run', '-c', p, '--dry-run', '--json']);
    expect(seco.code).toBe(2);
    const env = JSON.parse(seco.stdout);
    expect(env.error.code).toBe('usage.budget_required');
    expect(env.error.details.estimate.requests).toBe(40);
    expect(posts).toBe(antes);
  });

  it('--dry-run com orçamento e SEM key: exit 0, estimativa, `requires` a key, zero POST', async () => {
    const p = escrever('ok2.json', jevExample('triagem', 'compare'));
    const antes = posts;
    const r = await run(['jev', 'compare', '-c', p, '--dry-run', '--budget', '0.05', '--json'], { key: false });
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.data).toMatchObject({ dryRun: true, mode: 'compare', wouldRefuse: [] });
    expect(env.data.requires.map((x: { code: string }) => x.code)).toEqual(['auth.key_missing']);
    expect(env.data.estimate.byContestant.length).toBe(2);
    expect(posts).toBe(antes);
  });
});

describe('jev run — execução, NDJSON, orçamento', () => {
  it('NDJSON: termina em `result`, sem estado/rubrica, uma linha por evento; stdout de --json é JSON puro', async () => {
    const p = escrever('nd.json', jevExample('triagem', 'eval'));
    const antes = posts;
    const r = await run(['jev', 'run', '-c', p, '--budget', '0.05', '--output-format', 'ndjson']);
    expect(r.code).toBe(0);
    const linhas = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as { type: string; ok?: boolean; runId?: string });
    expect(linhas[0].type).toBe('jev.started');
    expect(linhas.at(-1)).toMatchObject({ type: 'result', ok: true });
    expect(linhas.some((l) => l.type === 'jev.contestant')).toBe(true);
    expect(r.stdout).not.toContain('"state"');
    expect(r.stdout).not.toContain('Cliquei em Pagar');
    expect(r.stdout).not.toContain('Cobrança, pagamento recusado');
    expect(posts - antes).toBe(40);

    const j = await run(['jev', 'eval', '-c', p, '--budget', '0.05', '--json', '--allow-concurrent']);
    expect(j.code).toBe(0);
    const env = JSON.parse(j.stdout);
    expect(env).toMatchObject({ ok: true, command: 'jev.eval' });
    expect(env.data.contestants[0].accuracy).toBe(1);
    expect(env.data.totalCostUsd).toBeCloseTo(40 * 400 * 0.042e-6, 10);

    // report e list/show leem do data-dir
    const rep = await run(['jev', 'report', env.data.runId, '--json']);
    expect(rep.code).toBe(0);
    expect(JSON.parse(rep.stdout).data.format).toBe('prompt-builder-jev-run-report@1');
    const lst = await run(['jev', 'list', '--json']);
    expect(JSON.parse(lst.stdout).data.items.map((i: { id: string }) => i.id)).toContain(env.data.runId);
  });

  it('orçamento esgotado: exit 7 com ok:true e stoppedReason budget (parcial)', async () => {
    const p = escrever('orc.json', jevExample('triagem', 'eval'));
    const r = await run(['jev', 'run', '-c', p, '--budget', '0.0003', '--json', '--allow-concurrent']);
    expect(r.code).toBe(7);
    const env = JSON.parse(r.stdout);
    expect(env).toMatchObject({ ok: true, data: { stoppedReason: 'budget', budgetExhausted: true } });
    expect(env.data.incompleteCases).toBeGreaterThan(0);
  });
});

describe('jev export — portão do holdout', () => {
  it('holdout regredido BLOQUEIA (exit 10); --override libera com o motivo gravado; --request dá só o corpo', async () => {
    const home = path.join(dir, 'home-export');
    mkdirSync(path.join(home, 'jev-sessions'), { recursive: true });
    const spec = withSpecId({ label: 'x', questions: [{ id: 'b', type: 'noul', instructions: 'É bug?' }] as JevQuestionSpec[] });
    const champ = withSpecId({ label: 'c', questions: [{ id: 'b', type: 'noul', instructions: 'O cliente relata defeito?' }] as JevQuestionSpec[] });
    const s = {
      format: 'jev-session@1',
      id: 'sessao-regrediu',
      status: 'finished',
      theme: 't',
      config: {},
      modelId: 'typesafe/jev-1.13',
      originalSpec: spec,
      championSpec: champ,
      iterations: [],
      runIds: [],
      policy: { b: { auto: 0.9, hitl: 0.6, signal: 'certainty', temperature: 0.8 } },
      holdout: { runId: 'r', n: 12, strength: 'holdout', comparison: null, original: null, champion: null, regressed: true, text: 'regrediu' },
      cost: { totalUsd: 0, pendingUsd: 0, byRole: {}, byContestant: {}, byKind: { decision: 0, llm: 0, rewriter: 0 } },
      totalCostUsd: 0,
      resolvedModels: ['typesafe/jev-1.13-20260917'],
      warnings: [],
      startedAt: new Date().toISOString(),
    } as unknown as JevSessionRecord;
    writeFileSync(path.join(home, 'jev-sessions', 'sessao-regrediu.json'), JSON.stringify(s));
    const bloqueado = await run(['jev', 'export', 'sessao-regrediu', '--json'], { home });
    expect(bloqueado.code).toBe(10);
    expect(JSON.parse(bloqueado.stdout).error.code).toBe('gate.holdout_regressed');
    const ok = await run(['jev', 'export', 'sessao-regrediu', '--override', 'decisão do dono', '--json'], { home });
    expect(ok.code).toBe(0);
    const h = JSON.parse(ok.stdout).data.handoff;
    expect(h).toMatchObject({ format: 'jev-handoff@1', model: 'typesafe/jev-1.13', evidence: { override: 'decisão do dono' } });
    expect(h.request.questions.b.instructions).toBe('O cliente relata defeito?');
    const req = await run(['jev', 'export', 'sessao-regrediu', '--override', 'x', '--request', '--json'], { home });
    expect(Object.keys(JSON.parse(req.stdout).data.handoff).sort()).toEqual(['model', 'questions', 'state']);
  });
});

describe('jev — help e descoberta', () => {
  it('`jev --help` lista os subcomandos e a tabela de exits; alias `decisions` e subcomando desconhecido', async () => {
    const h = await run(['jev', '--help']);
    expect(h.code).toBe(0);
    for (const sub of ['jev validate', 'jev example', 'jev models', 'jev run', 'jev train', 'jev report', 'jev export', 'jev techniques']) {
      expect(h.stdout).toContain(sub);
    }
    expect(h.stdout).toContain('CÓDIGOS DE SAÍDA');
    const t = await run(['decisions', 'techniques', '--json']);
    expect(t.code).toBe(0);
    expect(JSON.parse(t.stdout).data.techniques.length).toBe(19);
    const x = await run(['jev', 'voar', '--json']);
    expect(x.code).toBe(2);
    expect(JSON.parse(x.stdout).error.code).toBe('usage.unknown_command');
  });

  it('`jev models` lê o catálogo PÚBLICO de decisões sem key', async () => {
    const r = await run(['jev', 'models', '--json'], { key: false });
    expect(r.code).toBe(0);
    const ids = JSON.parse(r.stdout).data.models.map((m: { id: string }) => m.id);
    expect(ids).toContain('typesafe/jev-1.13');
    expect(ids).not.toContain('typesafe/jev-router');
  });

  it('`jev example -o` grava um config que o `validate` aceita', async () => {
    const p = path.join(dir, 'ex-train.json');
    const e = await run(['jev', 'example', '--kind', 'triagem', '--mode', 'train', '-o', p, '--json']);
    expect(e.code).toBe(0);
    expect(JSON.parse(readFileSync(p, 'utf8')).format).toBe('jev-config@1');
    const v = await run(['jev', 'validate', p, '--json']);
    expect(v.code).toBe(0);
  });
});
