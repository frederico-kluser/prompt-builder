// Paridade MCP × CLI (auditoria mcp#0..#6, cli#12, IMPL-086, IMPL-093): o
// servidor MCP é a entrada principal dos agentes e não pode aceitar o que o
// CLI recusa, nem esconder o que o CLI mostra.
//
//   • mcp#0 — `scenarios: {from:'library'}` usa a biblioteca curada (mesmo
//     caminho do `--config`); perfil inexistente é RECUSADO;
//   • mcp#1/IMPL-093 — chave desconhecida é erro (fail-closed), inclusive em
//     arena-agent-config (+ files[] contido ao workspace);
//   • mcp#3 — `config` como string JSON vale em toda tool que o anuncia;
//   • mcp#4 — list_models/estimate_cost sem key (catálogo público) e validação
//     de argumento ANTES da key;
//   • mcp#6 — list_models pagina (offset/nextOffset) e o teto nunca estoura;
//   • cli#12/mcp#2 — get_result traz o DESFECHO (placar/vencedor; campeão,
//     holdout, significância);
//   • IMPL-086 — recusa sai como isError, nunca sucesso com placeholder.
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
  lazyKeyResolver,
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
// mcp#0 — biblioteca curada
// ---------------------------------------------------------------------------

const ITENS: LibraryItem[] = [1, 2, 3, 4].map((i) => ({
  id: `item-${i}`,
  title: `Item ${i}`,
  tier: 'mft',
  maxTokens: 300,
  question: `Pergunta curada numero ${i} sobre reembolso do pedido ${i * 7}?`,
  productContext: 'Politica: reembolso em 7 dias.',
  reference: `Resposta de referencia ${i}: reembolso em 7 dias.`,
  origin: 'manual',
  createdAt: '2026-01-01T00:00:00.000Z',
})) as LibraryItem[];

const ARENA_BASE = {
  format: 'arena-config@1',
  mode: 'compare',
  theme: 'suporte',
  prompt: { text: 'Voce e um assistente de suporte.' },
  limits: { maxOutputTokens: 300 },
  models: { datagen: 'fake/gen', judges: ['fake/judge'], reference: 'fake/ref', competitors: ['fake/a', 'fake/b'] },
};
const LIB_CFG = { ...ARENA_BASE, scenarios: { from: 'library', profile: 'curado' } };

async function semearBiblioteca(): Promise<void> {
  await saveProfile({ id: 'curado', name: 'curado' });
  await saveItems('curado', ITENS);
}

describe('mcp#0 — scenarios {from:"library"} pelo MESMO caminho do CLI', () => {
  it('estimate_cost: N etapas = N itens e ZERO de datagen (antes: 5 etapas geradas e datagen cobrado)', async () => {
    instalarCatalogo();
    await semearBiblioteca();
    const r = await chamar('estimate_cost', { config: LIB_CFG });
    expect(r.isError).toBeUndefined();
    const est = json(r) as { assumptions: { stages: number }; byRole: Record<string, number> };
    expect(est.assumptions.stages).toBe(ITENS.length);
    expect(est.byRole.datagen).toBe(0);
  });

  it('perfil inexistente é RECUSADO (isError) em estimate_cost e start_run — nenhum job criado', async () => {
    instalarCatalogo();
    const cfg = { ...ARENA_BASE, scenarios: { from: 'library', profile: 'nao-existe' } };
    const est = await chamar('estimate_cost', { config: cfg });
    expect(est.isError).toBe(true);
    expect(texto(est)).toMatch(/Biblioteca \\?"nao-existe\\?" sem itens/u);

    const { executor, inputs } = executorEspiao();
    const jobs = new JobManager({ lane: new HeavyLane(1), executor });
    const st = await chamar('start_run', { config: cfg, budgetUsd: 1, idempotencyKey: 'lib-x' }, { jobs });
    expect(st.isError).toBe(true);
    expect(inputs).toHaveLength(0);
    const dirJobs = path.join(tmp, 'jobs');
    expect(existsSync(dirJobs) ? readdirSync(dirJobs).filter((f) => f.endsWith('.json')) : []).toHaveLength(0);
  });

  it('start_run: o job recebe os itens CURADOS como customStages (nunca cenários gerados)', async () => {
    await semearBiblioteca();
    const { executor, inputs } = executorEspiao();
    const jobs = new JobManager({ lane: new HeavyLane(1), executor });
    const st = await chamar('start_run', { config: LIB_CFG, budgetUsd: 1, idempotencyKey: 'lib-1' }, { jobs });
    expect(st.isError).toBeUndefined();
    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    const cfg = inputs[0].config as RunConfig & { customStages?: { question: string; reference?: string }[] };
    expect(cfg.stages).toBe(ITENS.length);
    expect(cfg.customStages?.map((s) => s.question)).toEqual(ITENS.map((i) => i.question));
    expect(cfg.customStages?.every((s) => typeof s.reference === 'string' && s.reference.length > 0)).toBe(true);
    await jobs.wait(json(st).jobId as string, 2_000);
  });
});

// ---------------------------------------------------------------------------
// mcp#1 / IMPL-093 — fail-closed de chave desconhecida
// ---------------------------------------------------------------------------

function agentConfig(files: { path: string; content: string }[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'arena-agent-config@1',
    mode: 'compare',
    theme: 'Correção de bugs',
    agent: { executor: 'pi', executorVersion: '0.84.2', limits: { maxCostUsd: 0.2 } },
    models: { datagen: 'acme/judge', judges: ['acme/judge'], competitors: ['acme/alpha', 'acme/beta'] },
    scenarios: [{ question: 'Conserte o parser.', agentTask: { files } }],
    ...extra,
  };
}

describe('mcp#1/IMPL-093 — chave desconhecida nunca é descartada em silêncio', () => {
  it('estimate_cost com typo no RunConfig cru → isError config.unknown_key com "você quis dizer"', async () => {
    instalarCatalogo();
    const r = await chamar('estimate_cost', { config: { ...COMPARE, stagess: 50 } });
    expect(r.isError).toBe(true);
    const erro = json(r);
    expect(erro).toMatchObject({ ok: false, code: 'config.unknown_key' });
    expect(String(erro.error)).toContain('"stagess" (você quis dizer "stages"?)');
    expect(String(erro.hint)).toMatch(/config validate/u);
  });

  it('start_run com typo ANINHADO no arena-config (limits.maxPricePerMtok) → isError, nenhum job', async () => {
    const { executor, inputs } = executorEspiao();
    const jobs = new JobManager({ lane: new HeavyLane(1), executor });
    const cfg = { ...ARENA_BASE, stages: 2, limits: { maxOutputTokens: 300, maxPricePerMtok: 0.1 } };
    const r = await chamar('start_run', { config: cfg, budgetUsd: 1, idempotencyKey: 'typo-1' }, { jobs });
    expect(r.isError).toBe(true);
    expect(json(r).code).toBe('config.unknown_key');
    expect(String(json(r).error)).toContain('limits.maxPricePerMtok');
    expect(inputs).toHaveLength(0);
  });

  it('run_benchmark/train_prompt também recusam o typo (mesmo caminho)', async () => {
    const rb = await chamar('run_benchmark', { config: { ...COMPARE, finalistz: 2 }, budgetUsd: 1 });
    expect(rb.isError).toBe(true);
    expect(json(rb).code).toBe('config.unknown_key');
    const tp = await chamar('train_prompt', { config: { ...TRAINING, iteratons: 3 }, budgetUsd: 1 });
    expect(tp.isError).toBe(true);
    expect(String(json(tp).error)).toContain('"iteratons"');
  });

  it('arena-agent-config: typo e files[] fora do workspace são recusados ANTES do portão (sem pin gravado)', async () => {
    const typo = await chamar('run_agent_benchmark', {
      config: JSON.stringify(agentConfig([{ path: 'a.ts', content: 'x' }], { theem: 'x' })),
      budgetUsd: 1,
      allowExecConfig: true,
    });
    expect(typo.isError).toBe(true);
    expect(json(typo).code).toBe('config.unknown_key');

    const fuga = await chamar('start_run', {
      config: agentConfig([{ path: '../fora.txt', content: 'x' }]),
      budgetUsd: 1,
      idempotencyKey: 'fuga-1',
      allowExecConfig: true,
    });
    expect(fuga.isError).toBe(true);
    expect(json(fuga).code).toBe('config.files_path_escapes_workspace');
    // validação vem ANTES do portão: nada foi aprovado/pinado
    expect(existsSync(path.join(tmp, 'exec-config-approvals.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mcp#3 — config como string JSON
// ---------------------------------------------------------------------------

describe('mcp#3 — config como string JSON em toda tool que o anuncia', () => {
  it('estimate_cost com string == com objeto (inclusive arena-config@1 em string)', async () => {
    instalarCatalogo();
    const obj = await chamar('estimate_cost', { config: COMPARE });
    const txt = await chamar('estimate_cost', { config: JSON.stringify(COMPARE) });
    expect(txt.isError).toBeUndefined();
    expect(json(txt).point).toBe(json(obj).point);
    const arena = await chamar('estimate_cost', { config: JSON.stringify({ ...ARENA_BASE, stages: 3 }) });
    expect(arena.isError).toBeUndefined();
    expect((json(arena).assumptions as { stages: number }).stages).toBe(3);
  });

  it('run_benchmark/train_prompt parseiam a string (a recusa é a do MODO, não "expected object")', async () => {
    const rb = await chamar('run_benchmark', { config: JSON.stringify(TRAINING), budgetUsd: 1 });
    expect(rb.isError).toBe(true);
    expect(texto(rb)).toMatch(/Use train_prompt/u);
    const tp = await chamar('train_prompt', { config: JSON.stringify(COMPARE), budgetUsd: 1 });
    expect(tp.isError).toBe(true);
    expect(texto(tp)).toMatch(/precisa ser "training"/u);
  });

  it('string malformada → "config não é um JSON válido." (em todas)', async () => {
    for (const [tool, extra] of [
      ['estimate_cost', {}],
      ['run_benchmark', { budgetUsd: 1 }],
      ['train_prompt', { budgetUsd: 1 }],
      ['start_run', { budgetUsd: 1, idempotencyKey: 'k' }],
    ] as const) {
      const r = await chamar(tool, { config: '{nope', ...extra });
      expect(r.isError, tool).toBe(true);
      expect(texto(r), tool).toMatch(/config não é um JSON válido/u);
      expect(texto(r), tool).not.toMatch(/expected object/iu);
    }
  });
});

// ---------------------------------------------------------------------------
// mcp#4 — key opcional (catálogo público) e validação antes da key
// ---------------------------------------------------------------------------

describe('mcp#4 — list_models/estimate_cost sem key; argumento validado antes da key', () => {
  beforeEach(() => {
    // Sem key em lugar nenhum: env vazio e data dir novo (o arquivo de `key set` mora nele).
    vi.stubEnv('OPENROUTER_API_KEY', '');
  });

  it('sem key: list_models e estimate_cost funcionam (catálogo PÚBLICO, como o CLI)', async () => {
    instalarCatalogo();
    const getKey = lazyKeyResolver({});
    const lm = await chamar('list_models', {}, {}, getKey);
    expect(lm.isError).toBeUndefined();
    expect((json(lm).models as unknown[]).length).toBeGreaterThan(0);
    const est = await chamar('estimate_cost', { config: COMPARE }, {}, getKey);
    expect(est.isError).toBeUndefined();
    expect(typeof json(est).point).toBe('number');
  });

  it('sem key: tool que GASTA continua exigindo key (auth.key_missing com dica)', async () => {
    const { executor, inputs } = executorEspiao();
    const jobs = new JobManager({ lane: new HeavyLane(1), executor });
    const r = await chamar('start_run', { config: COMPARE, budgetUsd: 1, idempotencyKey: 'k' }, { jobs }, lazyKeyResolver({}));
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ ok: false, code: 'auth.key_missing' });
    expect(String(json(r).hint)).toMatch(/OPENROUTER_API_KEY/u);
    expect(inputs).toHaveLength(0);
  });

  it('argumento inválido sem key → o erro do ARGUMENTO (antes: "Key do OpenRouter ausente")', async () => {
    const r = await chamar('start_run', { config: COMPARE, idempotencyKey: 'k' }, {}, lazyKeyResolver({}));
    expect(r.isError).toBe(true);
    expect(texto(r)).toMatch(/budgetUsd/u);
    expect(texto(r)).not.toMatch(/Key do OpenRouter ausente/u);
  });

  it('com key presente, a tool de key opcional usa a key (escopo do catálogo da conta)', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', KEY);
    let recebida: string | undefined;
    const espia = {
      name: 'espia',
      description: 'devolve a key recebida',
      inputSchema: { type: 'object' },
      optionalKey: true,
      run: async (_a: Record<string, unknown>, k: string) => {
        recebida = k;
        return {};
      },
    };
    await callTool('espia', {}, lazyKeyResolver({}), { tools: [espia] });
    expect(recebida).toBe(KEY);
  });
});

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
    expect(out.winner).toEqual({
      contestantId: 'b',
      label: 'Modelo B',
      ruler: 'duels',
      tie: false,
      tiedIds: ['b'],
      tieBreak: 'none',
      unresolved: false,
    });
    expect(out.verdictIntegrity).toEqual({ conclusive: true, reasons: [] });
    expect(estimateTokens(texto(r))).toBeLessThanOrEqual(SOFT_RESULT_TOKENS);
  });

  it('empate nas finais gravado na ordem de cadastro: MCP e `runs winner` desempatam IGUAL (judge-score)', async () => {
    // Record antigo: winRate empatado e o controle 'a' em 1º por ordem de
    // cadastro. A régua única (winnerFromStandings) re-ordena — o MCP não pode
    // devolver 'a' enquanto o CLI devolve 'b'.
    const id = randomUUID();
    const empatado = {
      ...runComPlacar(id),
      standings: [
        { id: 'a', label: 'Modelo A', isControl: true, wins: 2, ties: 0, losses: 2, winRate: 0.5 },
        { id: 'b', label: 'Modelo B', isControl: false, wins: 2, ties: 0, losses: 2, winRate: 0.5 },
      ],
    };
    await saveRun(empatado as unknown as RunRecord);
    const out = json(await chamar('get_result', { id }));
    const { winnerFromStandings } = await import('../src/engine/duelCore.js');
    const cli = winnerFromStandings(empatado as unknown as RunRecord);
    expect(cli.contestantId).toBe('b');
    expect(out.winner).toMatchObject({
      contestantId: cli.contestantId,
      ruler: 'duels+judge-score',
      tie: true,
      tiedIds: cli.tiedIds,
      tieBreak: 'judge-score',
      unresolved: false,
    });
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

// ---------------------------------------------------------------------------
// IMPL-086 — recusa é isError, nunca sucesso com placeholder
// ---------------------------------------------------------------------------

describe('IMPL-086 — recusa sai como isError acionável', () => {
  it('não encontrado (get_result/get_session_report/get_agent_dossier) é isError com code not_found', async () => {
    const id = randomUUID();
    for (const [tool, args] of [
      ['get_result', { id }],
      ['get_result', { id, kind: 'session' }],
      ['get_session_report', { sessionId: id }],
      ['get_agent_dossier', { runId: id, stageIndex: 0, contestantId: 'x' }],
    ] as const) {
      const r = await chamar(tool, args as Record<string, unknown>);
      expect(r.isError, tool).toBe(true);
      expect(r.structuredContent, tool).toBeUndefined();
      expect(json(r), tool).toMatchObject({ ok: false, code: 'not_found' });
      expect(texto(r), tool).not.toMatch(ABS_PATH_RE);
    }
  });

  it('run_agent_benchmark/start_run sem aceite do config executável → isError com code e dica do portão', async () => {
    const cfg = agentConfig([{ path: 'a.ts', content: 'x' }]);
    for (const [tool, extra] of [
      ['run_agent_benchmark', { config: JSON.stringify(cfg) }],
      ['start_run', { config: cfg, idempotencyKey: 'gate-1' }],
    ] as const) {
      const r = await chamar(tool, { ...extra, budgetUsd: 1 });
      expect(r.isError, tool).toBe(true);
      const out = json(r);
      expect(out.ok, tool).toBe(false);
      expect(out.code, tool).toBe('config.exec_not_approved');
      expect(String(out.hint), tool).toContain('allowExecConfig');
    }
  });

  it('job que FALHA numa tool longa vira isError com o jobId (antes: {ok:false} como sucesso)', async () => {
    const executor: JobExecutor = async () => {
      throw new Error('executor quebrou');
    };
    const jobs = new JobManager({ lane: new HeavyLane(1), executor });
    const r = await chamar('run_benchmark', { config: COMPARE, budgetUsd: 1 }, { jobs, blockingWaitMs: 3_000 });
    expect(r.isError).toBe(true);
    const out = json(r);
    expect(out).toMatchObject({ ok: false, status: 'failed' });
    expect(typeof out.jobId).toBe('string');
  });
});
