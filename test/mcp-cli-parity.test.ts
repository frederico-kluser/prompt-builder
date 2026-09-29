// Paridade MCP × CLI (auditoria cli#12, mcp#2, mcp#6): o servidor MCP é a
// entrada principal dos agentes e não pode esconder o que o CLI mostra.
//
//   • mcp#6 — list_models pagina (offset/nextOffset) e o teto nunca estoura;
//   • cli#12/mcp#2 — get_result traz o DESFECHO (placar/vencedor; campeão,
//     holdout, significância).
//
// Zero rede e zero gasto: gateway FALSO e executor de job FALSO.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { getDataDir, saveRun, saveSession, setDataDir } from '../src/storage.js';
import { saveItems, saveProfile } from '../src/library.js';
import { HeavyLane } from '../src/jobs.js';
import { JobManager, type JobExecutor, type RunJobInput } from '../src/jobManager.js';
import {
  CHAMPION_PROMPT_SUMMARY_CHARS,
  HARD_RESULT_TOKENS,
  LIST_MODELS_MAX_LIMIT,
  SOFT_RESULT_TOKENS,
  callTool,
  estimateTokens,
  type ToolCallResult,
} from '../src/cli/commands/mcp.js';
import type { LibraryItem } from '../src/engine/libraryCore.js';
import type { RunConfig, RunRecord, SessionRecord } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { CATALOGO, COMPARE, KEY, TRAINING } from './mcpHarness.js';
import { fixture } from './support/sessionReportFixture.js';

const ABS_PATH_RE = /(?:\/home\/|\/Users\/|\/tmp\/|[A-Z]:\\)/u;

let tmp: string;
let anterior: string;
let gwAnterior: OpenRouterGateway | undefined;
let silencio: Array<{ mockRestore(): void }> = [];

function instalarCatalogo(catalog: Record<string, unknown>[] = CATALOGO): void {
  const fake = fakeOpenRouter({ catalog, chat: () => ({ text: 'nunca chamado' }) });
  const g = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
  gwAnterior ??= g;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'pb-mcp-parity-'));
  anterior = getDataDir();
  setDataDir(tmp);
  silencio = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
  ];
});
afterEach(() => {
  silencio.forEach((s) => s.mockRestore());
  if (gwAnterior) setDefaultGateway(gwAnterior);
  setDataDir(anterior);
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const chamar = (
  name: string,
  args: Record<string, unknown>,
  opts: Parameters<typeof callTool>[3] = {},
  getKey: Parameters<typeof callTool>[2] = async () => KEY,
): Promise<ToolCallResult> => callTool(name, args, getKey, opts) as Promise<ToolCallResult>;

const texto = (r: ToolCallResult): string => r.content[0]?.text ?? '';
function json(r: ToolCallResult): Record<string, unknown> {
  return JSON.parse(texto(r)) as Record<string, unknown>;
}

/** Executor FALSO: guarda o input do job e termina na hora (nada é gasto). */
function executorEspiao(): { executor: JobExecutor; inputs: RunJobInput[] } {
  const inputs: RunJobInput[] = [];
  const executor: JobExecutor = async (input, _key, hooks) => {
    inputs.push(input);
    const id = hooks.runId ?? randomUUID();
    if (input.kind === 'training') hooks.onSessionId(id);
    return {
      summary: { runId: id, status: 'finished', totalCostUsd: 0 },
      cancelled: false,
      ...(input.kind === 'training' ? { sessionId: id } : { runId: id }),
    };
  };
  return { executor, inputs };
}

// ---------------------------------------------------------------------------
// mcp#6 — list_models pagina e o teto nunca estoura
// ---------------------------------------------------------------------------

describe('mcp#6 — list_models: offset/nextOffset e teto que nunca estoura', () => {
  /** Linha "gorda" como as do catálogo real (nome longo, parâmetros, raciocínio). */
  function catalogoGordo(n: number): Record<string, unknown>[] {
    return Array.from({ length: n }, (_, i) =>
      catalogItem(`vendor-${i % 7}/modelo-com-nome-bem-comprido-${i}`, 1e-6, 4e-6, {
        name: `Vendor ${i % 7}: Modelo Com Nome Bem Comprido ${i} (preview, contexto estendido)`,
        canonical_slug: `vendor-${i % 7}/modelo-com-nome-bem-comprido-${i}-20260901`,
        supported_parameters: [
          'include_reasoning', 'max_tokens', 'reasoning', 'response_format', 'seed', 'stop',
          'structured_outputs', 'temperature', 'tool_choice', 'tools', 'top_k', 'top_p',
        ],
        reasoning: { supported_efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'], default_effort: 'medium', mandatory: false },
      }),
    );
  }

  it('limit 200 é limitado ao teto (sem isError) e as páginas cobrem o catálogo sem buraco', async () => {
    instalarCatalogo(catalogoGordo(150));
    const p1 = await chamar('list_models', { limit: 200 });
    expect(p1.isError).toBeUndefined();
    const j1 = json(p1) as { count: number; models: { id: string }[]; nextOffset: number | null; offset: number };
    expect(j1.count).toBe(150);
    expect(j1.models).toHaveLength(LIST_MODELS_MAX_LIMIT);
    expect(j1.offset).toBe(0);
    expect(j1.nextOffset).toBe(LIST_MODELS_MAX_LIMIT);
    expect(estimateTokens(texto(p1))).toBeLessThanOrEqual(HARD_RESULT_TOKENS);

    const vistos = new Set(j1.models.map((m) => m.id));
    let proximo: number | null = j1.nextOffset;
    while (proximo !== null) {
      const p = json(await chamar('list_models', { limit: 200, offset: proximo })) as typeof j1;
      expect(p.offset).toBe(proximo);
      for (const m of p.models) vistos.add(m.id);
      proximo = p.nextOffset;
    }
    expect(vistos.size).toBe(150);
  });

  it('padrão fica sob o teto PADRÃO de 5 mil tokens; offset além do fim devolve página vazia', async () => {
    instalarCatalogo(catalogoGordo(150));
    const padrao = await chamar('list_models', {});
    expect(estimateTokens(texto(padrao))).toBeLessThanOrEqual(SOFT_RESULT_TOKENS);
    const fim = json(await chamar('list_models', { offset: 1000 }));
    expect(fim).toMatchObject({ count: 150, nextOffset: null });
    expect(fim.models).toEqual([]);
  });

  it('resposta grande demais dá a dica da PRÓPRIA tool (não o cursor do get_result)', async () => {
    const gorda = {
      name: 'list_models_falsa',
      description: 'estoura',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', additionalProperties: true },
      oversizeHint: 'use um limit menor ou offset',
      run: async () => ({ blob: 'z'.repeat(HARD_RESULT_TOKENS * 4) }),
    };
    const r = (await callTool('list_models_falsa', {}, undefined, { tools: [gorda] })) as ToolCallResult;
    expect(r.isError).toBe(true);
    expect(texto(r)).toContain('Use um limit menor ou offset.');
    expect(texto(r)).not.toMatch(/get_result/u);
  });
});

// ---------------------------------------------------------------------------
// cli#12 / mcp#2 — get_result traz o desfecho
// ---------------------------------------------------------------------------

function runComPlacar(id: string): RunRecord {
  return {
    id,
    status: 'finished',
    mode: 'compare',
    config: { mode: 'compare', theme: 'tema', stages: 2, budgetUsd: 5 } as unknown as RunConfig,
    contestants: [
      { id: 'a', label: 'Modelo A', modelId: 'fake/a' },
      { id: 'b', label: 'Modelo B', modelId: 'fake/b' },
      { id: 'c', label: 'Modelo C', modelId: 'fake/c' },
    ],
    stages: Array.from({ length: 2 }, (_, index) => ({
      index,
      spec: { question: `pergunta ${index}`, productContext: 'ctx', maxTokens: 100, rubric: '' },
      responses: [{ contestantId: 'a', text: 'x'.repeat(40_000), status: 'ok' }],
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
    })),
    scoreboard: {},
    standings: [
      { id: 'b', label: 'Modelo B', isControl: false, wins: 3, ties: 0, losses: 1, winRate: 0.75 },
      { id: 'a', label: 'Modelo A', isControl: true, wins: 1, ties: 0, losses: 3, winRate: 0.25 },
    ],
    judgeScoreByContestant: { a: 50, b: 87.5, c: 12.5 },
    finalists: ['b', 'a'],
    verdictIntegrity: {
      expectedByRole: {},
      degradedByRole: {},
      judgedScenariosByContestant: {},
      maxFailureRate: 0.1,
      minJudgedScenarios: 1,
      reasons: [],
    },
    totalCostUsd: 0.02,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:02:00.000Z',
  } as unknown as RunRecord;
}

describe('cli#12/mcp#2 — get_result traz o desfecho (quem venceu, quanto melhorou)', () => {
  it('run: standings, judge-score, finalistas e o vencedor pela régua do `runs winner`', async () => {
    const id = randomUUID();
    await saveRun(runComPlacar(id));
    const r = await chamar('get_result', { id });
    expect(r.isError).toBeUndefined();
    const out = json(r);
    expect(out.detail).toBe('summary');
    expect(out.standings).toEqual(runComPlacar(id).standings);
    expect(out.judgeScoreByContestant).toEqual({ a: 50, b: 87.5, c: 12.5 });
    expect(out.finalists).toEqual(['b', 'a']);
    expect(out.winner).toEqual({ contestantId: 'b', label: 'Modelo B', ruler: 'duels', tie: false });
    expect(out.verdictIntegrity).toEqual({ conclusive: true, reasons: [] });
    expect(estimateTokens(texto(r))).toBeLessThanOrEqual(SOFT_RESULT_TOKENS);
  });

  it('run sem finais: vencedor pelo judge-score; empate na régua é DITO (tie)', async () => {
    const id = randomUUID();
    const semFinais = { ...runComPlacar(id), standings: undefined, judgeScoreByContestant: { a: 80, b: 80, c: 10 } };
    await saveRun(semFinais as unknown as RunRecord);
    const out = json(await chamar('get_result', { id }));
    expect(out.winner).toMatchObject({ ruler: 'judge-score', tie: true });
  });

  it('detail:"full" de record GRANDE (resumo truncado) também traz o desfecho', async () => {
    const id = randomUUID();
    const grande = runComPlacar(id);
    grande.stages = Array.from({ length: 12 }, (_, index) => ({ ...grande.stages[0], index }));
    await saveRun(grande);
    const out = json(await chamar('get_result', { id, detail: 'full' }));
    expect(out.truncated).toBe(true);
    expect(out.winner).toMatchObject({ contestantId: 'b' });
    expect(out.standings).toBeDefined();
  });

  it('sessão: campeão, holdout, significância e pareamento; prompt campeão aparado no resumo', async () => {
    const { session } = fixture({ champion: 'P'.repeat(CHAMPION_PROMPT_SUMMARY_CHARS + 500) });
    const id = randomUUID();
    await saveSession({ ...session, id } as SessionRecord);
    const r = await chamar('get_result', { id, kind: 'session' });
    expect(r.isError).toBeUndefined();
    const out = json(r);
    expect(out.kind).toBe('session');
    expect(out.holdout).toEqual(session.holdout);
    expect(out.significance).toEqual(session.significance);
    expect(out.pairing).toEqual(session.pairing);
    expect(out.holdoutSkipped).toBe(false);
    expect(out.champion).toEqual({ iteration: 1, runId: 'r1', contestantId: 'carry' });
    expect(String(out.championPrompt)).toHaveLength(CHAMPION_PROMPT_SUMMARY_CHARS);
    expect(out.championPromptTruncated).toBe(true);
    expect(out.championPromptChars).toBe(CHAMPION_PROMPT_SUMMARY_CHARS + 500);
    expect(estimateTokens(texto(r))).toBeLessThanOrEqual(SOFT_RESULT_TOKENS);

    // prompt curto: inteiro e sem marca de corte
    const curto = fixture();
    const id2 = randomUUID();
    await saveSession({ ...curto.session, id: id2 } as SessionRecord);
    const out2 = json(await chamar('get_result', { id: id2 }));
    expect(out2.championPrompt).toBe(curto.session.bestPromptByIteration.at(-1)?.systemPrompt);
    expect(out2.championPromptTruncated).toBeUndefined();
  });
});

