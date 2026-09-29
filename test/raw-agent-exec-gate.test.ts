// Modo agente só entra pelos caminhos COM portão de execução (revisão da onda 1).
//
//  • RunConfig CRUA com `agent`/`agentTask` (setup[]/verify[] executam no
//    host) entrava por POST /v1/benchmark/{runs,sessions} (sem token, sem
//    PROMPT_BUILDER_AGENTS, sem o portão de isolamento §21.5), pelo MCP
//    start_run/run_benchmark/train_prompt (sem o pin do IMPL-099) e pelo
//    `--config` de compare/vary/train. Agora as três RECUSAM — nada é
//    iniciado, nenhum processo é criado. Estimar (não executa) continua aceito.
//  • IMPL-098: `agentTask.testsDir` na RunConfig crua não pode ser caminho de
//    host (absoluto/`../`): ele era copiado para o verificador, onde o verify[]
//    do chamador lia `~/.ssh` e afins. O absoluto só existe depois do parse,
//    posto pelo CLI a partir do diretório do arquivo.
//
// Zero rede externa, zero gasto.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { getDataDir, listRuns, listSessions, setDataDir } from '../src/storage.js';
import { agentExecFields, parseRunConfig } from '../src/runConfigSchema.js';
import { resolveTestsDir } from '../src/agent/taskValidate.js';
import { configFromJson, readConfigFile } from '../src/cli/commands/run.js';
import { callTool, type ToolCallResult } from '../src/cli/commands/mcp.js';
import { HeavyLane } from '../src/jobs.js';
import { JobManager, type JobExecutor, type RunJobInput } from '../src/jobManager.js';
import { startServer } from '../src/server.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const MODELOS = ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b'];

/**
 * Marca que o setup[] da config cria SE rodar — antes da correção o
 * run_benchmark do MCP de fato executava o comando no host.
 */
const MARCA = path.join(tmpdir(), `pb-raw-agent-gate-marca-${process.pid}`);

/** A config que a revisão usou: compare cru com agente e setup[] do host. */
const AGENTE = {
  mode: 'compare',
  theme: 'suporte',
  stages: 1,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  competitorModelIds: ['fake/a', 'fake/b'],
  timeoutMs: 5_000,
  agent: { executor: 'pi', executorVersion: '0.84.2', limits: { maxCostUsd: 0.2 } },
  customStages: [
    {
      question: 'Crie done.txt.',
      productContext: 'tarefa',
      maxTokens: 500,
      agentTask: {
        setup: [{ cmd: `touch ${MARCA}` }],
        verify: [{ cmd: 'test -f done.txt', label: 'done' }],
      },
    },
  ],
};

const { agent: _semAgente, customStages: _semEtapas, ...CHAT } = AGENTE;

let tmp: string;
let dirAnterior: string;
let gwAnterior: OpenRouterGateway | undefined;
let chatChamadas = 0;
let silencio: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'pb-raw-agent-gate-'));
  dirAnterior = getDataDir();
  setDataDir(tmp);
  chatChamadas = 0;
  const fake = fakeOpenRouter({
    catalog: MODELOS.map((id) => catalogItem(id, 1e-7, 1e-7)),
    chat: () => {
      chatChamadas += 1;
      return { text: 'nunca deveria rodar' };
    },
  });
  gwAnterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
  silencio = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
  ];
});
afterEach(() => {
  // Nenhum caminho recusado pode ter executado o setup[] do host.
  expect(existsSync(MARCA), 'setup[] da config executou no host').toBe(false);
  rmSync(MARCA, { force: true });
  silencio.forEach((s) => s.mockRestore());
  if (gwAnterior) setDefaultGateway(gwAnterior);
  setDataDir(dirAnterior);
  rmSync(tmp, { recursive: true, force: true });
});

describe('IMPL-098 — testsDir da RunConfig crua nunca é caminho de host', () => {
  const comTestsDir = (testsDir: string) => ({
    ...AGENTE,
    customStages: [{ ...AGENTE.customStages[0], agentTask: { ...AGENTE.customStages[0].agentTask, testsDir } }],
  });

  it('absoluto e `../` são RECUSADOS pelo schema (a entrada de /v1/agents e do MCP); relativo passa', () => {
    for (const ruim of ['/home/fulano/.ssh', '~/../../etc', '../fora', 'C:\\Users\\x\\.ssh']) {
      const r = parseRunConfig(comTestsDir(ruim));
      expect(r.ok, ruim).toBe(false);
      if (!r.ok) expect(r.error).toContain('testsDir');
    }
    expect(parseRunConfig(comTestsDir('suites')).ok).toBe(true);
  });

  it('resolveTestsDir não tem mais o atalho "absoluto passa direto"', () => {
    expect(() => resolveTestsDir('/home/fulano/.ssh', tmp)).toThrow(/relativo/u);
    expect(resolveTestsDir('suites', tmp)).toBe(path.join(tmp, 'suites'));
  });
});

describe('agentExecFields — o que executa no host', () => {
  it('acha `agent` e todo `agentTask` de etapa; config de chat = nada', () => {
    expect(agentExecFields(AGENTE)).toEqual(['agent', 'customStages[0].agentTask']);
    expect(agentExecFields({ ...CHAT, scenarioSeed: [{ question: 'q', agentTask: {} }] })).toEqual([
      'scenarioSeed[0].agentTask',
    ]);
    expect(agentExecFields(CHAT)).toEqual([]);
    expect(agentExecFields(null)).toEqual([]);
  });
});

describe('POST /v1/benchmark/{runs,sessions} recusa modo agente (sem o portão de /v1/agents)', () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = await startServer({ port: 0, webDist: null });
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const post = async (rota: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${rota}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openrouter-key': KEY },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as { error?: string; code?: string; fields?: string[] } };
  };

  it('runs: 400 config.agent_requires_agents_run — nada iniciado, zero chamada paga', async () => {
    const r = await post('/v1/benchmark/runs', AGENTE);
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('config.agent_requires_agents_run');
    expect(r.json.fields).toEqual(['agent', 'customStages[0].agentTask']);
    expect(r.json.error).toContain('/v1/agents/runs');
    expect(await listRuns()).toEqual([]);
    expect(chatChamadas).toBe(0);
  });

  it('runs: só `agentTask` (sem `agent`) também é recusado', async () => {
    const { agent: _a, ...soTarefa } = AGENTE;
    const r = await post('/v1/benchmark/runs', soTarefa);
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('config.agent_requires_agents_run');
    expect(await listRuns()).toEqual([]);
  });

  it('sessions: treino com agente também é recusado', async () => {
    const r = await post('/v1/benchmark/sessions', {
      ...AGENTE,
      mode: 'training',
      referenceModelId: 'fake/ref',
      contestantModelId: 'fake/a',
      basePrompt: 'Voce e um agente.',
      iterations: 1,
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('config.agent_requires_agents_run');
    expect(await listSessions()).toEqual([]);
    expect(chatChamadas).toBe(0);
  });
});

describe('MCP e `--config` do CLI recusam a RunConfig crua de modo agente', () => {
  const chamar = (name: string, args: Record<string, unknown>, opts: Parameters<typeof callTool>[3] = {}) =>
    callTool(name, args, async () => KEY, opts) as Promise<ToolCallResult>;
  const payload = (r: ToolCallResult) => JSON.parse(r.content[0]?.text ?? '{}') as { code?: string };

  function jobsEspiao(): { jobs: JobManager; inputs: RunJobInput[] } {
    const inputs: RunJobInput[] = [];
    const executor: JobExecutor = async (input) => {
      inputs.push(input);
      return { summary: { runId: 'x', status: 'finished', totalCostUsd: 0 }, cancelled: false, runId: 'x' };
    };
    return { jobs: new JobManager({ lane: new HeavyLane(1), executor }), inputs };
  }

  it('start_run (config crua com agent) → isError, nenhum job criado', async () => {
    const { jobs, inputs } = jobsEspiao();
    const r = await chamar('start_run', { config: AGENTE, budgetUsd: 1, idempotencyKey: 'agente-cru-1' }, { jobs });
    expect(r.isError).toBe(true);
    expect(payload(r).code).toBe('config.agent_requires_agents_run');
    expect(inputs).toHaveLength(0);
  });

  it('run_benchmark (config crua com agent, também como string) → isError; nada roda', async () => {
    const r = await chamar('run_benchmark', { config: JSON.stringify(AGENTE), budgetUsd: 1 });
    expect(r.isError).toBe(true);
    expect(payload(r).code).toBe('config.agent_requires_agents_run');
    expect(await listRuns()).toEqual([]);
    expect(chatChamadas).toBe(0);
  });

  it('estimate_cost (não executa nada) continua aceitando', async () => {
    const r = await chamar('estimate_cost', { config: AGENTE });
    expect(r.isError, r.content[0]?.text).toBeFalsy();
  });

  it('`--config` de compare/vary/train: exit 3 config.agent_requires_agents_run; o estimate aceita', async () => {
    const arq = path.join(tmp, 'agente-cru.json');
    writeFileSync(arq, JSON.stringify(AGENTE));
    const erro = await readConfigFile(arq).then(
      () => undefined,
      (e: unknown) => e as { code?: number; errorCode?: string },
    );
    expect(erro?.code).toBe(3);
    expect(erro?.errorCode).toBe('config.agent_requires_agents_run');
    await expect(readConfigFile(arq, {}, { inspectOnly: true })).resolves.toMatchObject({ mode: 'compare' });
    // Config de chat segue passando pelo mesmo caminho.
    await expect(configFromJson(CHAT)).resolves.toMatchObject({ mode: 'compare' });
  });
});
