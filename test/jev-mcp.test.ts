// Modo JEV — superfícies MCP em processo (zero rede, zero gasto): start_run com
// jev-config@1 vira job `jev` (mesmo executor/guardas), run_status traz o
// progresso, get_result lê run JEV sem estados, estimate_cost e list_models
// {modality:"decisions"}, e as recusas (cases.path, lint, run_benchmark).

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGateway, getGateway, setDefaultGateway } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { HeavyLane } from '../src/jobs.js';
import { JobManager } from '../src/jobManager.js';
import { callTool } from '../src/cli/commands/mcp.js';
import { jevExample } from '../src/engine/jev/index.js';
import { fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { DECISION_CATALOG } from './fakeDecisions.js';

const KEY = 'sk-or-v1-fake-key-para-testes-0000';
let dir = '';
let dataAntes = '';
let gwAntes = getGateway();

beforeAll(() => {
  dataAntes = getDataDir();
  dir = mkdtempSync(path.join(tmpdir(), 'jev-mcp-'));
  setDataDir(dir);
  process.env.PROMPT_BUILDER_DAILY_CAP_USD = 'none';
});
afterAll(() => {
  setDataDir(dataAntes);
  delete process.env.PROMPT_BUILDER_DAILY_CAP_USD;
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  setDefaultGateway(gwAntes);
});

function mundo() {
  const fake = fakeOpenRouter({ decisionCatalog: DECISION_CATALOG, catalog: [] });
  gwAntes = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
  const jobs = new JobManager({ lane: new HeavyLane(1), log: () => undefined });
  const chamar = (nome: string, args: Record<string, unknown>) => callTool(nome, args, async () => KEY, { jobs });
  return { fake, jobs, chamar };
}

const texto = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]?.text ?? '');
const json = (r: unknown): Record<string, unknown> => JSON.parse(texto(r)) as Record<string, unknown>;

describe('MCP × modo JEV', () => {
  it('start_run com jev-config@1 cria um job `jev`, roda e get_result devolve o resumo SEM estados', async () => {
    const { fake, jobs, chamar } = mundo();
    const r = await chamar('start_run', { config: jevExample('guardrail', 'eval'), budgetUsd: 0.05, idempotencyKey: 'jev-1' });
    expect((r as { isError?: boolean }).isError).toBeFalsy();
    const job = json(r) as { jobId: string; kind: string; runId: string; created: boolean };
    expect(job).toMatchObject({ kind: 'jev', created: true });
    const fim = await jobs.wait(job.jobId, 20_000);
    expect(fim?.status).toBe('completed');
    expect(fake.decisionRequests().length).toBe(8);
    const res = json(await chamar('get_result', { id: job.runId }));
    expect(res).toMatchObject({ kind: 'jev-run', mode: 'eval', status: expect.stringMatching(/finished|inconclusive/) });
    expect(JSON.stringify(res)).not.toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    const full = json(await chamar('get_result', { id: job.runId, detail: 'full' })) as { record: { cases: Record<string, unknown>[] } };
    expect(full.record.cases.every((c) => !('state' in c))).toBe(true);
    // retry com a MESMA chave: o mesmo job, nenhuma run nova
    const r2 = json(await chamar('start_run', { config: jevExample('guardrail', 'eval'), budgetUsd: 0.05, idempotencyKey: 'jev-1' }));
    expect(r2).toMatchObject({ jobId: job.jobId, created: false });
    expect(fake.decisionRequests().length).toBe(8);
  });

  it('recusas ANTES de criar o job: cases.path (só CLI), lint com erro; run_benchmark manda para o start_run', async () => {
    const { fake, chamar } = mundo();
    const comPath = { ...(jevExample('guardrail', 'eval') as Record<string, unknown>), cases: { path: '/etc/passwd' } };
    const a = await chamar('start_run', { config: comPath, budgetUsd: 0.05, idempotencyKey: 'jev-2' });
    expect((a as { isError?: boolean }).isError).toBe(true);
    expect(texto(a)).toMatch(/INLINE/);
    const cfg = jevExample('guardrail', 'eval') as Record<string, unknown>;
    const spec = JSON.parse(JSON.stringify(cfg.spec));
    spec.questions.has_injection.criteria = { true: 'só metade' };
    const b = await chamar('start_run', { config: { ...cfg, spec }, budgetUsd: 0.05, idempotencyKey: 'jev-3' });
    expect((b as { isError?: boolean }).isError).toBe(true);
    expect(texto(b)).toMatch(/noul\.criteria_pair/);
    const c = await chamar('run_benchmark', { config: jevExample('guardrail', 'eval'), budgetUsd: 0.05 });
    expect((c as { isError?: boolean }).isError).toBe(true);
    expect(texto(c)).toMatch(/start_run/);
    expect(fake.decisionRequests().length).toBe(0);
  });

  it('estimate_cost com jev-config@1 estima e faz lint sem nenhuma decisão paga', async () => {
    const { fake, chamar } = mundo();
    const r = json(await chamar('estimate_cost', { config: jevExample('triagem', 'compare') }));
    expect(r).toMatchObject({ kind: 'jev', mode: 'compare', cases: 40 });
    expect((r.estimate as { requests: number }).requests).toBe(80);
    expect(fake.decisionRequests().length).toBe(0);
  });

  it('list_models {modality:"decisions"} lista os modelos de decisão', async () => {
    const { chamar } = mundo();
    const r = json(await chamar('list_models', { modality: 'decisions', search: 'jev' }));
    expect(r.modality).toBe('decisions');
    expect((r.models as { id: string }[]).map((m) => m.id).sort()).toEqual(['typesafe/jev-1.13', '~typesafe/jev-latest']);
  });
});
