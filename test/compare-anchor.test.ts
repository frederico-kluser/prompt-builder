// web-code#16 — no comparar POR MODELOS, ajustar esforço/temperatura de um
// competidor não pode transformar o 1º modelo em "base/controlo".
//
// Com qualquer chip ajustado, a Nova Run promove o eixo de modelos para
// `competitorConfigs` (só essa forma carrega ajuste por competidor). Os dois
// motores marcavam então `contestants[0].isOriginal = true` — regra do eixo
// compare-llms (configs do MESMO modelo) — e o heatmap passava a mostrar
// "base", a narrativa "controlo". Contrato:
//  (i)   `competitorAnchor: false` = ninguém é controle, nos DOIS motores;
//        ausente = ancorado (compare-llms de sempre, retrocompatível);
//  (ii)  o schema do Node preserva o campo (sem ele o zod o descartava);
//  (iii) a Nova Run manda `competitorAnchor: false` só no eixo de modelos
//        promovido; o agente (lista de modelos) também.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { parseRunConfig } from '../src/runConfigSchema.js';
import type { RunConfig } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { duelReply, pointwiseReply } from './judgeReplies.js';

vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const CENARIOS = [
  { question: 'Qual o prazo de troca?', productContext: '30 dias com nota fiscal.', maxTokens: 200, rubric: 'Cita 30 dias.' },
];

function fake() {
  return fakeOpenRouter({
    catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b'].map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: (req, n) => {
      const usage = { prompt_tokens: 10, completion_tokens: 5, cost: 0.00001 * (n + 1) };
      if (req.model === 'fake/gen') return { text: JSON.stringify({ stages: CENARIOS }), usage };
      if (req.model === 'fake/ref') return { text: 'Gabarito: 30 dias.', usage };
      if (req.stream) return { text: `Resposta de ${req.model}`, usage };
      if (req.system.includes('DUELO')) return { text: duelReply(req, 'A', 'A melhor'), usage };
      return { text: pointwiseReply(req, 'resolve'), usage };
    },
  });
}

/** O que a Nova Run manda quando um chip do eixo de modelos tem ajuste. */
const PROMOVIDO = {
  mode: 'compare',
  theme: 'suporte',
  stages: 1,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  finalists: 0,
  duels: false,
  timeoutMs: 5_000,
  competitorAnchor: false,
  competitorConfigs: [{ modelId: 'fake/a', reasoningLevel: 'low' }, { modelId: 'fake/b' }],
} as const;

const { competitorAnchor: _semAncora, ...COMPARE_LLMS } = PROMOVIDO;

let dirAnterior: string;
let tmp: string;
let silencio: Array<{ mockRestore(): void }> = [];

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pb-anchor-'));
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

async function contestantsDe(
  run: (c: RunConfig) => Promise<{ contestants?: { id: string; isOriginal?: boolean }[] }>,
  cfg: object,
) {
  const f = fake();
  const anterior = setDefaultGateway(createGateway({ fetch: f.fetch, sleep: noSleep }));
  try {
    const rec = await run(cfg as unknown as RunConfig);
    return rec.contestants ?? [];
  } finally {
    setDefaultGateway(anterior);
  }
}

describe('web-code#16 (i) — competitorAnchor nos DOIS motores', () => {
  for (const [nome, run] of [
    ['Node', (c: RunConfig) => runNode(c, KEY, {})],
    ['SPA', (c: RunConfig) => runWeb(c as never, KEY, {}) as never],
  ] as const) {
    it(`${nome}: lista de MODELOS promovida (anchor false) → ninguém é controle`, async () => {
      const cs = await contestantsDe(run, PROMOVIDO);
      expect(cs).toHaveLength(2);
      expect(cs.some((c) => c.isOriginal), 'nenhum "base" num comparar de modelos').toBe(false);
    });

    it(`${nome}: compare-llms (sem o campo) continua ancorado no 1º`, async () => {
      const cs = await contestantsDe(run, COMPARE_LLMS);
      expect(cs[0]?.isOriginal).toBe(true);
      expect(cs.filter((c) => c.isOriginal)).toHaveLength(1);
    });
  }
});

describe('web-code#16 (ii)+(iii) — schema e emissores', () => {
  it('o schema do Node preserva competitorAnchor (o zod descartaria chave desconhecida)', () => {
    const r = parseRunConfig(PROMOVIDO);
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) expect((r.config as { competitorAnchor?: boolean }).competitorAnchor).toBe(false);
    const semCampo = parseRunConfig(COMPARE_LLMS);
    expect(semCampo.ok).toBe(true);
    if (semCampo.ok) expect((semCampo.config as { competitorAnchor?: boolean }).competitorAnchor).toBeUndefined();
    expect(parseRunConfig({ ...PROMOVIDO, competitorAnchor: 'nao' }).ok).toBe(false);
  });

  it('a Nova Run manda anchor false SÓ no eixo de modelos promovido; o agente também', () => {
    const newRun = readFileSync(join(process.cwd(), 'web', 'src', 'pages', 'NewRun.tsx'), 'utf8');
    const promovido = newRun.slice(newRun.indexOf('competitors.some((id) => effortOf(id)'));
    expect(promovido.slice(0, 900)).toMatch(/competitorAnchor: false,\s*competitorConfigs: competitors\.map/);
    // O eixo configs (compare-llms de verdade) NÃO desliga a âncora.
    const eixoConfigs = newRun.slice(newRun.indexOf("if (compareAxis === 'configs') {\n        // Eixo configs"));
    expect(eixoConfigs.slice(0, 600)).not.toContain('competitorAnchor');
    const agente = readFileSync(join(process.cwd(), 'src', 'arenaConfig.ts'), 'utf8');
    expect(agente).toMatch(/competitorConfigs: file\.models\.competitors\.map\(\(id\) => \(\{ modelId: id \}\)\),\s*\/\/[^\n]*\n\s*competitorAnchor: false/);
  });
});
