// Revisão w2 (cli#19) — consumidor que some NO MEIO de uma run paga.
//
// O cli#19 trocou o EPIPE do stdout de "Falha de rede" (exit 8) para
// `process.exit(0)` em TODO comando. Para leitura (`docs --all | head -1`)
// está certo; para `compare|vary|train|agents run --output-format ndjson | head`
// não: o processo saía 0 na hora, as chamadas pagas em voo caíam sem conta, o
// RunRecord ficava 'running' para sempre e um `set -o pipefail` via SUCESSO
// numa run morta que já tinha gastado. Contratos:
//   (1) `stdoutClosedAction`: leitura = exit-ok; run (ou comando de run no
//       pré-voo) = stop-run; `mcp` = ignore (encerra pelo próprio caminho);
//   (2) processo REAL contra OpenRouter falso em 127.0.0.1: o consumidor fecha
//       o pipe depois do 1º evento NDJSON ⇒ exit 130 (não 0) e o record fica
//       'aborted' (nunca 'running').
//
// Zero rede externa, zero gasto: servidor HTTP falso local.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXIT } from '../src/cli/output.js';
import { stdoutClosedAction } from '../src/cli/context.js';
import type { FetchLike } from '../src/openrouter.js';
import { catalogItem, fakeOpenRouter, type FakeRequest } from './fakeOpenRouter.js';
import { duelReply, pointwiseReply } from './judgeReplies.js';
import { nodeOrTsx, ROOT } from './support/cli.js';

const { cmd: NODE, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));
const KEY = `sk-or-v1-${'e'.repeat(48)}`;

describe('stdoutClosedAction — quem sai 0 e quem para a run', () => {
  it('leitura sai 0; run (em curso ou no pré-voo) para com graça; mcp é dono do próprio stdout', () => {
    expect(stdoutClosedAction('docs', 0)).toBe('exit-ok');
    expect(stdoutClosedAction('runs', 0)).toBe('exit-ok');
    expect(stdoutClosedAction(undefined, 0)).toBe('exit-ok');
    for (const cmd of ['compare', 'vary', 'train', 'agents']) expect(stdoutClosedAction(cmd, 0)).toBe('stop-run');
    // Qualquer comando com run registrada (installGracefulStop) para com graça.
    expect(stdoutClosedAction('runs', 1)).toBe('stop-run');
    expect(stdoutClosedAction('mcp', 0)).toBe('ignore');
    expect(stdoutClosedAction('mcp', 2)).toBe('ignore');
  });
});

/** Servidor HTTP em 127.0.0.1 a partir de um transporte falso (FetchLike). */
async function servir(fetchFn: FetchLike): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      void fetchFn(`http://127.0.0.1${req.url ?? '/'}`, { method: req.method, headers, body: body || undefined })
        .then(async (r) => {
          res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
          res.end(Buffer.from(await r.arrayBuffer()));
        })
        .catch((e: unknown) => {
          res.writeHead(500);
          res.end(String(e));
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  return {
    base,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

const CENARIOS = [
  { question: 'Qual o prazo de troca?', productContext: 'Trocas em até 30 dias.', maxTokens: 200, rubric: 'Citar 30 dias.' },
  { question: 'Tem frete grátis?', productContext: 'Frete grátis acima de R$ 200.', maxTokens: 200, rubric: 'Citar R$ 200.' },
  { question: 'Qual o horário?', productContext: 'Atendimento das 8h às 18h.', maxTokens: 200, rubric: 'Citar 8h–18h.' },
];

function rota(req: FakeRequest, n: number) {
  const usage = { prompt_tokens: 100, completion_tokens: 20, cost: Number((0.0001 * (n + 1)).toFixed(6)) };
  if (req.model === 'fake/gen') return { text: JSON.stringify({ stages: CENARIOS }), usage };
  if (req.model === 'fake/ref') return { text: `Gabarito: ${req.user.slice(0, 30)}`, usage };
  if (req.model === 'fake/judge') {
    if (req.system.includes('DUELO')) return { text: duelReply(req, 'A', 'A melhor'), usage };
    return { text: pointwiseReply(req, 'resolve', 'confere'), usage };
  }
  return { text: `Resposta de ${req.model}`, usage };
}

describe('revisão w2 — EPIPE no meio de `compare --output-format ndjson`', { timeout: 120_000 }, () => {
  let srv: { base: string; close: () => Promise<void> };
  let home: string;
  /** Enquanto `true`, toda chamada de chat espera: a run está VIVA quando o pipe fecha. */
  let segurar = true;

  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'pb-w2-epipe-'));
    const fake = fakeOpenRouter({
      catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b'].map((id) => catalogItem(id, 1e-6, 1e-6)),
      chat: async (req, n) => {
        const fim = Date.now() + 60_000;
        while (segurar && Date.now() < fim) await new Promise((r) => setTimeout(r, 20));
        // Um respiro por chamada: a run segue emitindo eventos depois do fechamento.
        await new Promise((r) => setTimeout(r, 30));
        return rota(req, n);
      },
    });
    srv = await servir(fake.fetch);
  });
  afterAll(async () => {
    segurar = false;
    await srv?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('o consumidor fecha o pipe: exit 130 (não 0), record `aborted` (nunca `running`)', async () => {
    const cfg = path.join(home, 'config.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        mode: 'compare',
        theme: 'suporte ao cliente',
        stages: 3,
        datagenModelId: 'fake/gen',
        judgeModelIds: ['fake/judge'],
        referenceModelId: 'fake/ref',
        referenceJudging: true,
        competitorModelIds: ['fake/a', 'fake/b'],
        finalists: 0,
        timeoutMs: 30_000,
      }),
    );
    const env: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: home, OPENROUTER_BASE_URL: srv.base, CI: '1' };
    delete env.OPENROUTER_API_KEY;
    const child = spawn(
      NODE,
      [ENTRY, 'compare', '--config', cfg, '--budget', '5', '--yes', '--key', KEY, '--output-format', 'ndjson'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (c: string) => (stderr += c));
    // Como o `| head -n 1`: lê o 1º evento, fecha a ponta de leitura e SÓ ENTÃO
    // libera o OpenRouter falso — a run está em voo quando o pipe morre.
    child.stdout.once('data', () => {
      child.stdout.destroy();
      segurar = false;
    });
    // Rede de segurança: se nada sair no stdout antes do chat, libera assim mesmo.
    const t = setTimeout(() => (segurar = false), 20_000);
    const status = await new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    clearTimeout(t);

    expect(status, stderr).toBe(EXIT.SIGINT);
    expect(stderr).toMatch(/EPIPE/);
    expect(stderr).not.toMatch(/Falha de rede/);
    const dir = path.join(home, 'runs');
    expect(existsSync(dir)).toBe(true);
    const runs = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(runs.length).toBeGreaterThan(0);
    for (const f of runs) {
      const rec = JSON.parse(readFileSync(path.join(dir, f), 'utf-8')) as { status: string; stoppedReason?: string };
      expect(rec.status, f).not.toBe('running');
      expect(rec.status).toBe('aborted');
    }
  });
});
