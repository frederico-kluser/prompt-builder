// cli#3 no MODO AGENTE (left#5, onda 3) — key recusada (401) e sem crédito
// (402) no meio de `agents run` saem com o exit DOCUMENTADO (4 / 5), como as
// runs de chat — antes o desfecho do agente virava `run.failed` (exit 1) e, pior,
// o juiz do dossiê DEGRADAVA a falha fatal em `judge_failed` (3 tentativas
// inúteis por veredito) e a run "concluía" com notas só do oráculo.
//
// Sem rede e sem `pi`: executor falso (o agente cria o arquivo pedido) +
// OpenRouter falso cujo /chat/completions (o juiz) responde 401/402.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../src/agent/pi.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/agent/pi.js')>();
  const { writeFileSync: write } = await import('node:fs');
  const { join } = await import('node:path');
  return {
    ...orig,
    piExecutor: {
      ...orig.piExecutor,
      id: 'pi-fake',
      prepare: async () => ({ bin: 'pi-fake', env: {} }),
      run: async (opts: { workspaceDir: string; env: Record<string, string>; modelId?: string }) => {
        write(join(opts.workspaceDir, 'done.txt'), 'ok\n', 'utf8');
        const modelId = opts.modelId ?? opts.env.PI_MODEL_ID;
        const now = new Date().toISOString();
        const usage = { tokensIn: 10, tokensOut: 5, tokensReasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.001, costSource: 'agent-derived' as const };
        return {
          stopReason: 'completed',
          turns: 1,
          toolCalls: 0,
          durationMs: 5,
          usage: { tokensIn: 10, tokensOut: 5, costUsd: 0.001 },
          trajectory: {
            format: 'agent-trajectory@1' as const,
            executor: { id: 'pi-fake', version: '0' },
            model: { provider: 'openrouter', id: modelId },
            startedAt: now,
            finishedAt: now,
            durationMs: 5,
            stopReason: 'completed',
            // Texto no dossiê: sem ele o juiz nem é chamado ("dossiê vazio").
            turns: [{ index: 0, text: 'criei o done.txt com ok', steps: [] }],
            usage,
            parseErrors: 0,
            compactions: [],
          },
          parseErrors: 0,
          responseIds: [],
          stderrTail: '',
          exitCode: 0,
          signal: null,
        };
      },
    },
  };
});

import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { cmdAgents } from '../src/cli/commands/agents.js';
import { EXIT, isCliError, resetOutputState, type CliError } from '../src/cli/output.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeChatReply } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const R401: FakeChatReply = { status: 401, bodyText: '{"error":{"message":"User not found"}}' };
const R402: FakeChatReply = { status: 402, bodyText: '{"error":{"message":"Insufficient credits"}}' };

let tmp = '';
let dirAnterior = '';
let gwAnterior: OpenRouterGateway | undefined;
let chamadasJuiz = 0;
let respostaJuiz: FakeChatReply = R401;
const silencio: { mockRestore(): void }[] = [];

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'pb-agents-fatal-'));
  dirAnterior = getDataDir();
  setDataDir(tmp);
  const f = fakeOpenRouter({
    catalog: ['fake/a', 'fake/b', 'fake/judge', 'fake/gen'].map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: () => {
      chamadasJuiz += 1;
      return respostaJuiz;
    },
  });
  gwAnterior = setDefaultGateway(createGateway({ fetch: f.fetch, sleep: noSleep }));
  silencio.push(
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
  );
});
afterAll(() => {
  silencio.forEach((s) => s.mockRestore());
  setDefaultGateway(gwAnterior);
  setDataDir(dirAnterior);
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
  chamadasJuiz = 0;
});

async function agentsRun(): Promise<CliError | undefined> {
  const dir = mkdtempSync(path.join(tmp, 'cli-'));
  const file = path.join(dir, 'arena.json');
  writeFileSync(
    file,
    JSON.stringify({
      format: 'arena-agent-config@2',
      mode: 'compare',
      theme: 'fatal',
      agent: { executor: 'pi', executorVersion: '0.0.0-fake', install: 'system', limits: { maxCostUsd: 0.05 } },
      models: { datagen: 'fake/gen', judges: ['fake/judge'], competitors: ['fake/a', 'fake/b'] },
      // `judging.reference: false`: nada de gabarito gerado — só o JUIZ do dossiê chama o gateway.
      scenarios: [0, 1].map((i) => ({
        question: `tarefa ${i}: crie done.txt`,
        rubric: 'done.txt existe com ok',
        agentTask: { verify: [{ cmd: 'test -f done.txt', label: 'done', weight: 1 }], limits: { maxCostUsd: 0.05 } },
      })),
      judging: { reference: false },
      duels: false,
    }),
  );
  resetOutputState();
  try {
    await cmdAgents([
      'run', '--config', file, '--budget', '5', '--key', KEY, '--allow-exec-config', '--json', '--quiet', '--data-dir', dir,
    ]);
    return undefined;
  } catch (e) {
    if (!isCliError(e)) throw e;
    return e as CliError;
  } finally {
    setDataDir(tmp);
    resetOutputState();
  }
}

describe('agents run — 401/402 do gateway no meio da run', { timeout: 60_000 }, () => {
  it('401 (key recusada) no juiz ⇒ exit 4 auth.failed, com o resumo da run em details', async () => {
    respostaJuiz = R401;
    const err = await agentsRun();
    expect(err?.code).toBe(EXIT.AUTH);
    expect(err?.errorCode).toBe('auth.failed');
    expect((err?.details as { runId?: string; status?: string }).status).toBe('error');
    expect((err?.details as { runId?: string }).runId).toMatch(/\S/);
    // Fatal NÃO é re-tentado (3 tentativas por veredito eram só custo e ruído).
    expect(chamadasJuiz).toBeLessThanOrEqual(4);
  });

  it('402 (sem crédito) no juiz ⇒ exit 5 credit.insufficient', async () => {
    respostaJuiz = R402;
    const err = await agentsRun();
    expect(err?.code).toBe(EXIT.NO_CREDIT);
    expect(err?.errorCode).toBe('credit.insufficient');
  });
});
