// Modelos LOCAIS de ponta a ponta, com a NUVEM FORA DO AR (2026-10-20): prova que medir local não depende do
// OpenRouter.
//   1. Em processo: um `compare` inteiro — gerador de cenários, gabarito, juiz e dois competidores, todos `local/*`
//      — pelo orquestrador de verdade (Node) sobre o gateway de verdade com o fetch dos modelos locais. Nenhum POST
//      vai à nuvem, o custo é 0 e o endpoint local atende UMA chamada por vez. ATENÇÃO (achado deste teste): o juiz
//      padrão do comparar é o JEV da NUVEM (`typesafe/jev-1.13`, contra o gabarito) — rodada 100% local exige
//      `jevJudge.decisionModelId` local (o Laya) ou `judgeEngine: 'llm'` com um juiz local; as duas formas estão aqui.
//   2. Processo real do CLI (`PB_LOCAL_*`, nuvem numa porta fechada, SEM key): `local list --check` confere os
//      endpoints e `jev run` com o modelo de decisão local termina com custo 0.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, setDefaultGateway, type FetchLike } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion } from '../src/orchestrator.js';
import { createLocalModelsFetch, parseLocalModelsEnv } from '../src/localModels.js';
import { jevExample } from '../src/engine/jev/index.js';
import type { RunConfig } from '../src/types.js';
import { duelReply, pointwiseReply } from './judgeReplies.js';
import { defaultDecisionAnswers, noSleep } from './fakeOpenRouter.js';
import { answerFor } from './fakeDecisions.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const CHAT = 'http://127.0.0.1:18200/v1';
const DECIDE = 'http://127.0.0.1:18201';
const CENARIOS = [{ question: 'Qual o prazo de troca?', productContext: '30 dias com nota fiscal.', maxTokens: 200, rubric: 'Cita 30 dias.' }];

/** O "computador local": um endpoint de chat que responde por modelo; a nuvem lança (fora do ar). */
function offlineWorld() {
  const cloudPosts: string[] = [];
  const byModel = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  let localDecisions = 0;
  const base: FetchLike = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (input === `${DECIDE}/v1/systemone`) {
      localDecisions += 1;
      const b = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      return new Response(JSON.stringify({ answers: defaultDecisionAnswers(b.questions), usage: { input_tokens: 90 } }), { status: 200 });
    }
    if (!input.startsWith(CHAT)) {
      if (method === 'POST') cloudPosts.push(input);
      throw new TypeError('fetch failed: nuvem fora do ar (teste offline)');
    }
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 2));
      const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string; content: unknown }> };
      byModel.set(body.model, (byModel.get(body.model) ?? 0) + 1);
      const of = (role: string) =>
        body.messages
          .filter((m) => m.role === role)
          .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
          .join('\n');
      const req = { model: body.model, system: of('system'), user: of('user'), stream: false } as never as Parameters<typeof pointwiseReply>[0];
      const content =
        body.model === 'local/gen'
          ? JSON.stringify({ stages: CENARIOS })
          : body.model === 'local/ref'
            ? 'Gabarito: 30 dias.'
            : body.model === 'local/judge'
              ? of('system').includes('DUELO')
                ? duelReply(req, 'A', 'A melhor')
                : pointwiseReply(req, 'resolve')
              : `Resposta de ${body.model}: o prazo é de 30 dias.`;
      return new Response(
        JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }),
        { status: 200 },
      );
    } finally {
      inFlight -= 1;
    }
  };
  return { base, cloudPosts, byModel, maxInFlight: () => maxInFlight, localDecisions: () => localDecisions };
}

describe('comparar SÓ com modelos locais e a nuvem fora do ar (orquestrador de verdade)', () => {
  let dirAnterior: string;
  let tmp: string;
  let silencio: Array<{ mockRestore(): void }> = [];
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-local-offline-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
  });
  afterAll(() => {
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  const COMPARE = {
    mode: 'compare',
    theme: 'suporte',
    stages: 1,
    datagenModelId: 'local/gen',
    judgeModelIds: ['local/judge'],
    referenceModelId: 'local/ref',
    referenceJudging: true,
    finalists: 2,
    duels: true,
    timeoutMs: 5_000,
    competitorConfigs: [{ modelId: 'local/a' }, { modelId: 'local/b' }],
  };

  for (const [nome, extra, decide] of [
    ['juiz JEV com o modelo de decisão LOCAL', { jevJudge: { decisionModelId: 'local/laya' } }, true],
    ['juiz só LLM local (judgeEngine llm)', { judgeEngine: 'llm' }, false],
  ] as const) {
    it(`${nome}: termina, custo 0, nenhum POST na nuvem, uma chamada por vez no endpoint de chat`, async () => {
      const world = offlineWorld();
      const reg = parseLocalModelsEnv({
        PB_LOCAL_CHAT: ['gen', 'ref', 'judge', 'a', 'b'].map((m) => `local/${m}=${CHAT}`).join(','),
        PB_LOCAL_MODELS: `local/laya=${DECIDE}`,
      });
      expect(reg.issues).toEqual([]);
      const anterior = setDefaultGateway(createGateway({ fetch: createLocalModelsFetch(world.base, reg), sleep: noSleep }));
      try {
        const rec = await runToCompletion({ ...COMPARE, ...extra } as unknown as RunConfig, KEY, {});
        // Terminou sem erro: com 1 cenário o veredito é `inconclusive` por desenho (vencedor exige ≥ 5 cenários).
        expect(['finished', 'inconclusive']).toContain(rec.status);
        expect((rec.contestants ?? []).map((c) => (c as { modelId?: string }).modelId).sort()).toEqual(['local/a', 'local/b']);
        expect(rec.totalCostUsd).toBe(0);
        expect(world.cloudPosts).toEqual([]);
        for (const m of ['local/gen', 'local/a', 'local/b']) expect(world.byModel.get(m) ?? 0).toBeGreaterThan(0);
        if (decide) expect(world.localDecisions()).toBeGreaterThan(0);
        else expect(world.byModel.get('local/judge') ?? 0).toBeGreaterThan(0);
        expect(world.maxInFlight()).toBe(1);
      } finally {
        setDefaultGateway(anterior);
      }
    });
  }

  it('sem configurar o juiz, o padrão é o JEV da NUVEM: com ela fora do ar, as decisões tentam o OpenRouter', async () => {
    const world = offlineWorld();
    const reg = parseLocalModelsEnv({ PB_LOCAL_CHAT: ['gen', 'ref', 'judge', 'a', 'b'].map((m) => `local/${m}=${CHAT}`).join(',') });
    const anterior = setDefaultGateway(createGateway({ fetch: createLocalModelsFetch(world.base, reg), sleep: noSleep }));
    try {
      await runToCompletion(COMPARE as unknown as RunConfig, KEY, {});
      expect(world.cloudPosts.every((u) => u.endsWith('/alpha/decisions'))).toBe(true);
      expect(world.cloudPosts.length).toBeGreaterThan(0);
    } finally {
      setDefaultGateway(anterior);
    }
  });
});

// ── processo real do CLI ─────────────────────────────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const ENTRY = path.join(ROOT, 'src', 'cli', 'index.ts');
const EX = jevExample('triagem', 'eval') as { cases: { state: { ticket: string }; expected: Record<string, unknown> }[] } & Record<string, unknown>;
const GOLD = new Map(EX.cases.map((c) => [c.state.ticket, c.expected]));

describe('CLI em processo real com modelos locais, a nuvem numa porta fechada e SEM key', () => {
  let server: Server;
  let local = '';
  let dir = '';
  let decisions = 0;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pb-local-cli-'));
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(url.pathname === '/health' ? { status: 'ok' } : { data: [{ id: 'k2' }] }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/systemone') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          decisions += 1;
          const b = JSON.parse(body) as { state: { ticket: string }; questions: Record<string, { type: string; criteria: unknown }> };
          const gold = GOLD.get(b.state.ticket) ?? {};
          const answers = Object.fromEntries(Object.entries(b.questions).map(([qid, q]) => [qid, answerFor(q, gold[qid], 0.9, 0.8)]));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ answers, usage: { input_tokens: 120 } }));
        });
        return;
      }
      res.writeHead(404);
      res.end('nao');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      // A nuvem numa porta fechada: qualquer chamada a ela falharia.
      OPENROUTER_BASE_URL: 'http://127.0.0.1:9/api/v1',
      PROMPT_BUILDER_HOME: path.join(dir, 'home'),
      PROMPT_BUILDER_DAILY_CAP_USD: 'none',
      PB_LOCAL_MODELS: `local/laya=${local}`,
      PB_LOCAL_CHAT: `local/k2=${local}/v1`,
    };
    return new Promise((resolve) => {
      const child = spawn(TSX, [ENTRY, ...args], { env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }

  it('local list --check: os dois endpoints respondem', async () => {
    const r = await run(['local', 'list', '--check', '--json']);
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout) as { ok: boolean; data: { checks: Array<{ id: string; ok: boolean }> } };
    expect(env.ok).toBe(true);
    expect(env.data.checks.map((c) => [c.id, c.ok]).sort()).toEqual([
      ['local/k2', true],
      ['local/laya', true],
    ]);
  }, 60_000);

  it('jev run --dry-run só com o local e sem key: nada a exigir (requires vazio)', async () => {
    const p = path.join(dir, 'jev-local-dry.json');
    writeFileSync(p, JSON.stringify({ ...EX, models: { decision: ['local/laya'] } }));
    const r = await run(['jev', 'run', '-c', p, '--budget', '0.01', '--dry-run', '--json']);
    expect(r.code, r.stderr.slice(-800)).toBe(0);
    const env = JSON.parse(r.stdout) as { data: { requires: unknown[] } };
    expect(env.data.requires).toEqual([]);
  }, 60_000);

  it('jev run só com o modelo de decisão local, sem key: termina com custo 0 e todas as decisões no local', async () => {
    const cfg = { ...EX, models: { decision: ['local/laya'] } };
    const p = path.join(dir, 'jev-local.json');
    writeFileSync(p, JSON.stringify(cfg));
    const antes = decisions;
    const r = await run(['jev', 'run', '-c', p, '--budget', '0.01', '--json']);
    expect(r.code, r.stderr.slice(-800)).toBe(0);
    const env = JSON.parse(r.stdout) as { ok: boolean; data: Record<string, unknown> };
    expect(env.ok).toBe(true);
    expect(JSON.stringify(env.data)).toMatch(/"(cost|spent|totalCost)[A-Za-z]*":0[,}]/);
    expect(decisions - antes).toBeGreaterThan(0);
  }, 120_000);
});
