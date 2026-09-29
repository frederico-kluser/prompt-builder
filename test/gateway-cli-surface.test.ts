// Superfícies do gateway no CLI/SPA (onda 1, cluster gateway):
//   cli#2   — `models show/list`: modelo que o catálogo declara SEM raciocínio
//             não aceita think level nenhum (o gateway não manda `reasoning`) —
//             antes o mapa dizia "aceita os 7" com um fio falso; o pré-voo avisa
//             o nível que seria ignorado;
//   cli#3   — 402 (sem crédito) / 401 (key) DURANTE a run saem com exit 5 / 4
//             (`credit.insufficient` / `auth.failed`) e a causa fica no record
//             (`errorKind`), em vez de exit 1 `run.failed`;
//   cli#11  — `estimate` de training: "Por papel" diz que é POR ITERAÇÃO e as
//             premissas não imprimem `[object Object]`;
//   cli#14  — `telemetry` está no dispatch/help; o contador de funil é no-op
//             sem opt-in;
//   IMPL-113 — a calibração estimado × real PERSISTE entre processos (CLI:
//             arquivo no data dir; SPA: armazenamento do navegador) e chega à
//             faixa publicada (`assumptions.range` 'empirico');
//   web-code#13 — `concurrency` da run é só registro: a run com concurrency=1
//             ainda dispara chamadas em paralelo (o limitador global decide) e a
//             tela diz isso.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REASONING_IGNORED_FIT,
  effortOptions,
  ignoredReasoningLevels,
  modelCaps,
  thinkLevelsFor,
} from '../src/modelCaps.js';
import { effortOptions as webEffortOptions, modelCaps as webModelCaps } from '../web/src/modelCaps.js';
import {
  createGateway,
  fatalGatewayErrorFromRecord,
  gatewayErrorKindFromMessage,
  recordCostSample,
  resetCostSamples,
  setDefaultGateway,
  type CostCalibrationSample,
  type OpenRouterGateway,
} from '../src/openrouter.js';
import {
  estimateRunCost,
  estimateInputFromConfig,
  formatAssumptions,
  formatRoleBreakdown,
  setCostCalibrationProvider,
} from '../src/estimate.js';
import { COST_SAMPLES_FILE, installCostSamplesPersistence, loadCostSamples } from '../src/costSamplesStore.js';
import { cmdRun } from '../src/cli/commands/run.js';
import { EXIT, resetOutputState, toCliError } from '../src/cli/output.js';
import { COMMANDS, renderCommandHelp } from '../src/cli/help.js';
import { recordTelemetryEvent, TELEMETRY_COUNTERS_FILE } from '../src/cli/commands/telemetry.js';
import { DAILY_CAP_ENV } from '../src/cli/spendLedger.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion } from '../src/orchestrator.js';
import type { OpenRouterModel, RunConfig } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter } from './fakeOpenRouter.js';
import { pointwiseReply } from './judgeReplies.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY = `sk-or-v1-${'b'.repeat(48)}`;
const tmps: string[] = [];
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  tmps.push(d);
  return d;
};
let anterior: OpenRouterGateway | undefined;
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
  setCostCalibrationProvider(undefined);
  resetCostSamples();
});

// ---------------------------------------------------------------------------
// cli#2 — think levels de modelo sem raciocínio
// ---------------------------------------------------------------------------

/** `openai/gpt-4o-mini`: lista de parâmetros SEM raciocínio e sem objeto `reasoning`. */
const SEM_RACIOCINIO: OpenRouterModel = {
  id: 'openai/gpt-4o-mini',
  name: 'gpt-4o-mini',
  pricing: { prompt: 1e-7, completion: 1e-7 },
  supportedParameters: ['temperature', 'max_tokens', 'tools'],
};
const COM_RACIOCINIO: OpenRouterModel = {
  id: 'openai/gpt-5-mini',
  name: 'gpt-5-mini',
  pricing: { prompt: 1e-7, completion: 1e-7 },
  supportedParameters: ['reasoning', 'reasoning_effort', 'max_tokens'],
  reasoning: { supportedEfforts: ['high', 'medium', 'low', 'minimal'] },
};

describe('cli#2 — think levels só do que o gateway REALMENTE envia', () => {
  it('modelo sem raciocínio: accepted=[], nenhum nível no fio, effortOptions vazio', () => {
    const t = thinkLevelsFor(SEM_RACIOCINIO);
    expect(t.accepted).toEqual([]);
    expect(t.canDisable).toBe(false);
    for (const v of Object.values(t.fit)) expect(v).toBe(REASONING_IGNORED_FIT);
    expect(modelCaps(SEM_RACIOCINIO)).toMatchObject({ reasoning: false, reasoningDenied: true });
    expect(effortOptions(modelCaps(SEM_RACIOCINIO))).toEqual([]);
    // Fail-closed do catálogo (`supported_parameters` malformado => []) idem.
    expect(thinkLevelsFor({ ...SEM_RACIOCINIO, supportedParameters: [] }).accepted).toEqual([]);
  });

  it('sem `supported_parameters` (fora do catálogo) NÃO é negado: o gateway ainda envia `reasoning`', () => {
    const t = thinkLevelsFor({ id: 'x/desconhecido' });
    expect(t.accepted).toHaveLength(7);
    expect(modelCaps({ id: 'x/desconhecido' }).reasoningDenied).toBeUndefined();
  });

  it('modelo COM raciocínio segue igual (allowlist + off)', () => {
    expect(thinkLevelsFor(COM_RACIOCINIO).accepted).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
  });

  it('pré-voo: nível pedido a modelo sem raciocínio vira AVISO (nada vai no fio)', () => {
    const avisos = ignoredReasoningLevels(
      {
        competitorModelIds: [SEM_RACIOCINIO.id, COM_RACIOCINIO.id],
        judgeModelIds: [SEM_RACIOCINIO.id],
        datagenModelId: COM_RACIOCINIO.id,
        reasoning: { competitor: 'xhigh', judge: 'off', duel: 'low' },
      },
      [SEM_RACIOCINIO, COM_RACIOCINIO],
    );
    expect(avisos).toEqual([
      { modelId: SEM_RACIOCINIO.id, role: 'competitor', level: 'xhigh' },
      { modelId: SEM_RACIOCINIO.id, role: 'duel', level: 'low' },
    ]);
  });

  it('SPA (web/src/modelCaps.ts): só "Padrão" para modelo sem raciocínio; lista completa sem modelo', () => {
    expect(webEffortOptions(webModelCaps(SEM_RACIOCINIO)).map((o) => o.value)).toEqual(['']);
    expect(webEffortOptions(webModelCaps(undefined)).map((o) => o.value)).toHaveLength(8);
    expect(webEffortOptions(webModelCaps(COM_RACIOCINIO)).map((o) => o.value)).toEqual([
      '',
      'off',
      'minimal',
      'low',
      'medium',
      'high',
    ]);
  });
});

// ---------------------------------------------------------------------------
// cli#3 — 402/401 durante a run => exit 5/4 com a causa no record
// ---------------------------------------------------------------------------

const CATALOGO = ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b'].map((id) => catalogItem(id, 1e-6, 1e-6));
const CONFIG_COMPARE = {
  mode: 'compare',
  theme: 'suporte ao cliente',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  finalists: 2,
  timeoutMs: 30_000,
};

async function invocarCompare(fake: FakeOpenRouter, dir: string): Promise<{ exit: number; errorCode?: string; details?: Record<string, unknown> }> {
  const cfg = join(dir, 'cmp.json');
  writeFileSync(cfg, JSON.stringify(CONFIG_COMPARE));
  const prev = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
  resetOutputState();
  const env = { CI: process.env.CI, cap: process.env[DAILY_CAP_ENV] };
  delete process.env[DAILY_CAP_ENV];
  const mudos = [
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
  try {
    const exit = await cmdRun('compare', ['--config', cfg, '--budget', '2', '--yes', '--key', KEY, '--data-dir', dir, '--json']);
    return { exit };
  } catch (e) {
    const err = toCliError(e);
    return { exit: err.code, errorCode: err.errorCode, details: err.details as Record<string, unknown> };
  } finally {
    mudos.forEach((m) => m.mockRestore());
    resetOutputState();
    setDefaultGateway(prev);
    if (env.cap !== undefined) process.env[DAILY_CAP_ENV] = env.cap;
  }
}

describe('cli#3 — key recusada / sem crédito NO MEIO da run saem com o código documentado', { timeout: 60_000 }, () => {
  it('402 no chat (a /key passou no pré-voo): exit 5 credit.insufficient, record com errorKind', async () => {
    const dir = tmp('pb-cli3-402-');
    const fake = fakeOpenRouter({
      catalog: CATALOGO,
      chat: () => ({ status: 402, bodyText: '{"error":{"message":"Insufficient credits"}}' }),
    });
    const r = await invocarCompare(fake, dir);
    expect(r.exit, JSON.stringify(r)).toBe(EXIT.NO_CREDIT);
    expect(r.errorCode).toBe('credit.insufficient');
    expect(r.details).toMatchObject({ gatewayError: 'no_credit', httpStatus: 402 });
    // O record guarda a causa ESTRUTURADA (não só a mensagem).
    const runId = String(r.details?.runId);
    const rec = JSON.parse(readFileSync(join(dir, 'runs', `${runId}.json`), 'utf-8')) as { errorKind?: string; errorHttpStatus?: number; error?: string };
    expect(rec).toMatchObject({ errorKind: 'no_credit', errorHttpStatus: 402 });
    expect(rec.error).toMatch(/HTTP 402/);
    // Nenhum outro lote tentou de novo depois do 402 (o datagen PROPAGA).
    expect(fake.chatRequests().length).toBeLessThanOrEqual(3);
  });

  it('401 no chat: exit 4 auth.failed', async () => {
    const dir = tmp('pb-cli3-401-');
    const fake = fakeOpenRouter({ catalog: CATALOGO, chat: () => ({ status: 401, bodyText: 'unauthorized' }) });
    const r = await invocarCompare(fake, dir);
    expect(r.exit, JSON.stringify(r)).toBe(EXIT.AUTH);
    expect(r.errorCode).toBe('auth.failed');
  });

  it('record só com a mensagem (sessão/record antigo): reconhece pela mensagem canônica', () => {
    expect(gatewayErrorKindFromMessage('Iteração 2: OpenRouter sem credito (HTTP 402): adicione creditos')).toBe('no_credit');
    expect(gatewayErrorKindFromMessage('OpenRouter recusou a key (HTTP 401): a key e invalida')).toBe('auth');
    expect(gatewayErrorKindFromMessage('OpenRouter rate limit (HTTP 429)')).toBeUndefined();
    expect(fatalGatewayErrorFromRecord({ error: 'Datagen nao entregou nenhum cenario' })).toBeUndefined();
    expect(fatalGatewayErrorFromRecord({ errorKind: 'rate_limit', error: 'x' })).toBeUndefined();
    expect(fatalGatewayErrorFromRecord({ errorKind: 'no_credit', error: 'x', errorHttpStatus: 403 })?.httpStatus).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// cli#11 — estimate de training legível
// ---------------------------------------------------------------------------

describe('cli#11 — `estimate` de training: por iteração e sem [object Object]', () => {
  const fmt = (v: number): string => `$${v.toFixed(4)}`;
  const config = {
    mode: 'training',
    theme: 'suporte',
    stages: 3,
    iterations: 3,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceModelId: 'fake/ref',
    contestantModelId: 'fake/a',
    basePrompt: 'Voce e um atendente.',
    techniqueIds: ['persona'],
  } as unknown as RunConfig;
  const modelos = CATALOGO.map((c) => ({
    id: String(c.id),
    name: String(c.id),
    pricing: { prompt: 1e-6, completion: 1e-6 },
    supportedParameters: ['temperature'],
  })) as OpenRouterModel[];

  it('rótulo diz POR ITERAÇÃO, cada linha mostra × iterações, e a linha "por iteração" = perIteration', () => {
    const est = estimateRunCost(estimateInputFromConfig(config), modelos);
    const linhas = formatRoleBreakdown(est, 'training', fmt);
    expect(linhas[0]).toBe(`Por papel (teto por iteração; × ${est.assumptions.iterations} iterações):`);
    expect(linhas.at(-1)).toBe(`  ${'por iteração'.padEnd(12)} ${fmt(est.perIteration)}`);
    expect(linhas.slice(1, -1).every((l) => l.includes(`(× ${est.assumptions.iterations} = `))).toBe(true);
    // compare/vary: rótulo de sempre, sem multiplicador.
    expect(formatRoleBreakdown(est, 'compare', fmt)[0]).toBe('Por papel (no teto):');
  });

  it('premissas: `range` resumido (cobertura, n, fonte por papel) — nunca [object Object]', () => {
    const est = estimateRunCost(estimateInputFromConfig(config), modelos);
    const linhas = formatAssumptions(est.assumptions);
    expect(linhas.join('\n')).not.toContain('[object Object]');
    const faixa = linhas.find((l) => l.trimStart().startsWith('faixa'));
    expect(faixa).toMatch(/cobertura 90% · n=0/);
    expect(faixa).toMatch(/judge:prior/);
  });
});

// ---------------------------------------------------------------------------
// cli#14 — telemetry alcançável; contador no-op sem opt-in
// ---------------------------------------------------------------------------

describe('cli#14 — `telemetry` no dispatch e no help; contador só com opt-in', () => {
  it('COMMANDS e o help do comando citam os headers de atribuição e a flag', () => {
    expect(COMMANDS).toContain('telemetry');
    const h = renderCommandHelp('telemetry');
    expect(h).toContain('PROMPT_BUILDER_NO_ATTRIBUTION');
    expect(h).toContain('HTTP-Referer');
    expect(h).toContain('PROMPT_BUILDER_TELEMETRY');
    const index = readFileSync(join(ROOT, 'src', 'cli', 'index.ts'), 'utf-8');
    expect(index).toMatch(/case 'telemetry':\s*return cmdTelemetry\(argv\);/);
  });

  it('recordTelemetryEvent: sem opt-in nada é contado nem gravado; com opt-in persiste', () => {
    const dir = tmp('pb-telemetry-');
    expect(recordTelemetryEvent('docs.list', dir, {})).toBe(false);
    expect(existsSync(join(dir, TELEMETRY_COUNTERS_FILE))).toBe(false);
    expect(recordTelemetryEvent('docs.list', dir, { PROMPT_BUILDER_TELEMETRY: 'on' })).toBe(true);
    const salvo = JSON.parse(readFileSync(join(dir, TELEMETRY_COUNTERS_FILE), 'utf-8')) as { counters: Record<string, number> };
    expect(salvo.counters['docs.list']).toBe(1);
  });

  it('docs para agentes mencionam os headers de atribuição como dado enviado ao OpenRouter', () => {
    const doc = readFileSync(join(ROOT, 'agent-docs', 'troubleshooting.md'), 'utf-8');
    expect(doc).toContain('PROMPT_BUILDER_NO_ATTRIBUTION');
    expect(doc).toMatch(/HTTP-Referer/);
    expect(doc).toMatch(/X-Title/);
  });
});

// ---------------------------------------------------------------------------
// IMPL-113 — calibração persistida chega à faixa publicada
// ---------------------------------------------------------------------------

const amostra = (i: number): CostCalibrationSample => ({
  role: 'judge',
  modelId: 'fake/judge',
  family: 'fake/judge',
  estimatedUsd: 0.01,
  actualUsd: 0.004 + 0.0001 * i,
  capTokens: 3072,
});

describe('IMPL-113 — estimado × real persiste entre processos e calibra a faixa', () => {
  const config = {
    mode: 'compare',
    theme: 'suporte',
    stages: 3,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceModelId: 'fake/ref',
    referenceJudging: true,
    competitorModelIds: ['fake/a', 'fake/b'],
  } as unknown as RunConfig;
  const modelos = CATALOGO.map((c) => ({ id: String(c.id), name: String(c.id), pricing: { prompt: 1e-6, completion: 1e-6 } })) as OpenRouterModel[];

  it('sem amostras: prior (comportamento de antes)', () => {
    const est = estimateRunCost(estimateInputFromConfig(config), modelos);
    expect(est.assumptions.range.perRole.judge?.source).toBe('prior');
  });

  it('processo 1 registra e grava; processo 2 (nova instalação) lê do disco: judge vira empirico', () => {
    const dir = tmp('pb-calib-');
    const p1 = installCostSamplesPersistence(dir, { exitHook: false });
    for (let i = 0; i < 8; i++) recordCostSample(amostra(i));
    // No MESMO processo a faixa já é empírica (sem ninguém passar `calibration`).
    expect(estimateRunCost(estimateInputFromConfig(config), modelos).assumptions.range.perRole.judge?.source).toBe('empirico');
    p1.dispose(); // flush + desliga o provedor
    expect(loadCostSamples(join(dir, COST_SAMPLES_FILE))).toHaveLength(8);
    expect(estimateRunCost(estimateInputFromConfig(config), modelos).assumptions.range.perRole.judge?.source).toBe('prior');

    // "Novo processo": nenhuma amostra em memória, só o arquivo.
    resetCostSamples();
    const p2 = installCostSamplesPersistence(() => dir, { exitHook: false });
    try {
      const est = estimateRunCost(estimateInputFromConfig(config), modelos);
      expect(est.assumptions.range.perRole.judge).toMatchObject({ source: 'empirico', n: 8 });
      expect(est.assumptions.range.n).toBe(8);
      // As portas continuam no TETO: calibração só muda a faixa reportada.
      const semCal = estimateRunCost(estimateInputFromConfig(config), modelos, { calibration: undefined });
      expect(est.byRole).toEqual(semCal.byRole);
    } finally {
      p2.dispose();
    }
  });

  it('linha corrompida no arquivo é ignorada (só ela); amostra inválida não entra', () => {
    const dir = tmp('pb-calib-lixo-');
    writeFileSync(
      join(dir, COST_SAMPLES_FILE),
      `${JSON.stringify(amostra(1))}\n{quebrado\n${JSON.stringify({ role: 'nada', modelId: 'x', estimatedUsd: 1, actualUsd: 1 })}\n`,
    );
    expect(loadCostSamples(join(dir, COST_SAMPLES_FILE))).toHaveLength(1);
  });

  it('SPA: amostras sobrevivem ao recarregar (armazenamento do navegador)', async () => {
    const web = await import('../web/src/engine/openrouter.js');
    const mem = new Map<string, string>();
    const store = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
    const desliga = web.installBrowserCostCalibration(store);
    for (let i = 0; i < 6; i++) recordCostSample(amostra(i));
    desliga(); // grava o pendente
    expect(web.loadStoredCostSamples(store)).toHaveLength(6);
    resetCostSamples();
    const desliga2 = web.installBrowserCostCalibration(store); // "recarregou a página"
    try {
      const est = estimateRunCost(estimateInputFromConfig(config), modelos);
      expect(est.assumptions.range.perRole.judge?.source).toBe('empirico');
    } finally {
      desliga2();
    }
  });
});

// ---------------------------------------------------------------------------
// web-code#13 — `concurrency` da run é só registro (decisão documentada)
// ---------------------------------------------------------------------------

describe('web-code#13 — `concurrency` NÃO limita a run; o limitador global decide (e a tela diz isso)', () => {
  it('run com concurrency=1 ainda dispara os competidores em paralelo', async () => {
    const dir = tmp('pb-conc-');
    const dirAnterior = getDataDir();
    setDataDir(dir);
    const silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    let emVoo = 0;
    let pico = 0;
    const fake = fakeOpenRouter({
      catalog: CATALOGO,
      chat: async (req) => {
        if (req.model === 'fake/gen') {
          return {
            text: JSON.stringify({
              stages: [
                { question: 'Qual o prazo de troca de um tenis?', productContext: 'Troca em 30 dias.', maxTokens: 200 },
                { question: 'Como calcular juros compostos mensais?', productContext: 'M = C (1 + i)^n.', maxTokens: 200 },
              ],
            }),
          };
        }
        if (req.model === 'fake/ref') return { text: 'Gabarito.' };
        if (req.model === 'fake/judge') return { text: pointwiseReply(req, 'resolve') };
        emVoo += 1;
        pico = Math.max(pico, emVoo);
        await new Promise((r) => setTimeout(r, 20));
        emVoo -= 1;
        return { text: `Resposta de ${req.model}` };
      },
    });
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    try {
      const rec = await runToCompletion({ ...CONFIG_COMPARE, finalists: 0, concurrency: 1 } as unknown as RunConfig, KEY);
      expect(rec.config.concurrency).toBe(1); // registrado…
      expect(pico).toBeGreaterThan(1); // …mas não é cap local (AGENTS.md: confie no limitador global)
    } finally {
      silencio.forEach((s) => s.mockRestore());
      setDataDir(dirAnterior);
    }
  });

  it('a tela e a tabela de paridade dizem que é só registro (cópia honesta)', () => {
    const tela = readFileSync(join(ROOT, 'web', 'src', 'pages', 'NewRun.tsx'), 'utf-8');
    const bloco = /label="Concorrência"\s*sub="([^"]+)"/.exec(tela)?.[1] ?? '';
    expect(bloco).toMatch(/limitador global/);
    expect(bloco).not.toMatch(/Mais é mais rápido/);
    const form = readFileSync(join(ROOT, 'web', 'src', 'arenaForm.ts'), 'utf-8');
    expect(form).toMatch(/'limits\.concurrency': \{ kind: 'ui', control: '[^']*limitador global/);
  });
});
