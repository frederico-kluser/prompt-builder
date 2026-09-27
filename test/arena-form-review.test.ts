// IMPL-045 — correções da revisão independente. Cada bloco prova um defeito:
//   1. prompt.group/promptId inválido chegava à run da SPA (composePrompt
//      descartava a variante: todos os contestants com o MESMO prompt);
//   2. `repeats` multiplicava as etapas do compare, mas a estimativa (e o
//      portão de confirmação de custo) contava só `stages`;
//   3. export de etapas cruas gravava o `stages` velho da tela → o reimport
//      gerava cenários a mais;
//   4. training.reflection 'off' era rotulado "aplicado" e nenhum motor o lia;
//   5. campos que dependem de variation.optimize eram aceitos e sumiam calados.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArenaConfig, type ArenaConfigFile } from '../web/src/engine/configFile';
import { parseArenaConfig as parseArenaConfigNode } from '../src/configFile.js';
import {
  ARENA_FIELD_HANDLING,
  applyArenaConfigToForm,
  defaultArenaFormState,
  exportArenaConfig,
  jsonOnlyRunPatch,
  promptGroupProblem,
  type ArenaFieldWarning,
} from '../web/src/arenaForm';
import { composePrompt } from '../src/engine/promptGroup.js';
import { estimateInputFromConfig, estimateRunCost } from '../src/estimate.js';
import { estimateLaunchCost } from '../src/engine/costConfirmation.js';
import { lessonsEnabled } from '../src/variator.js';
import { createGateway, setDefaultGateway } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { trainToCompletion as trainNode } from '../src/trainer.js';
import { startTraining as startWebTraining } from '../web/src/engine/trainer.js';
import { subscribeSession } from '../web/src/engine/events.js';
import type { RunConfig } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeRequest } from './fakeOpenRouter.js';

// O storage do web é IndexedDB — fora do navegador, um no-op em memória.
vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const NOW = '2026-09-27T00:00:00.000Z';
const hasWarning = (ws: ArenaFieldWarning[], path: string) => ws.some((w) => w.path === path);

function parse(json: unknown): ArenaConfigFile {
  const r = parseArenaConfig(json);
  if (!r.ok) throw new Error(`fixture inválida: ${r.error}`);
  return r.config;
}

const importar = (json: unknown) =>
  applyArenaConfigToForm(defaultArenaFormState(), parse(json), { raw: json, now: NOW });

const VARIATION = {
  format: 'arena-config@1',
  mode: 'variation',
  theme: 'Preparo para exames',
  prompt: { text: 'Você é o assistente da clínica.' },
  models: { datagen: 'gen/a', judges: ['judge/a'], contestant: 'cont/a' },
  variation: { optimize: true, techniques: ['persona', 'cot'] },
};

const GRUPO = [
  { id: 'a', text: 'A' },
  { id: 'b', text: 'B' },
];

// --------------------------------------------------------------------------
// 1. prompt.group/promptId inválido
// --------------------------------------------------------------------------

describe('IMPL-045 rev — grupo multi-prompt inválido não chega à run', () => {
  it('o cenário da revisão: promptId inexistente descartaria a variante', () => {
    // A prova do dano: com promptId 'zzz' o composto ignora a variante.
    expect(composePrompt({ prompts: GRUPO }, 'zzz', 'VARIANTE NOVA')).toBe('A\n\nB');
  });

  for (const [nome, prompt] of [
    ['promptId inexistente', { text: 'A', group: GRUPO, promptId: 'zzz' }],
    ['grupo com >1 prompt sem promptId', { text: 'A', group: GRUPO }],
  ] as const) {
    it(`${nome}: o import RECUSA o arquivo (SPA e CLI, mesma regra do runConfigSchema)`, () => {
      const cfg = { ...VARIATION, prompt };
      const web = parseArenaConfig(cfg);
      expect(web.ok).toBe(false);
      if (!web.ok) expect(web.error).toContain('prompt.group');
      const node = parseArenaConfigNode(cfg);
      expect(node.ok).toBe(false);
      // Também no training e até no compare (o CLI levaria o grupo p/ o RunConfig).
      expect(parseArenaConfig({ ...cfg, mode: 'training' }).ok).toBe(false);
    });
  }

  it('grupo válido continua aceito e aplicado', () => {
    const { state, warnings } = importar({ ...VARIATION, prompt: { text: 'A', group: GRUPO, promptId: 'b' } });
    expect(warnings).toEqual([]);
    expect(jsonOnlyRunPatch(state)).toMatchObject({ promptGroup: { prompts: GRUPO }, promptId: 'b' });
    expect(promptGroupProblem(state)).toBeNull();
  });

  it('defesa em profundidade: sem o parse, o import avisa e NÃO aplica o grupo', () => {
    const cru = { ...VARIATION, prompt: { text: 'A', group: GRUPO, promptId: 'zzz' } } as unknown as ArenaConfigFile;
    const { state, warnings } = applyArenaConfigToForm(defaultArenaFormState(), cru, { now: NOW });
    expect(hasWarning(warnings, 'prompt.group')).toBe(true);
    expect(state.promptGroup).toBeUndefined();
    expect(state.promptId).toBeUndefined();
  });

  it('jsonOnlyRunPatch e o problems() do NewRun barram um estado com grupo inválido', () => {
    const estado = {
      ...defaultArenaFormState(),
      mode: 'training' as const,
      promptGroup: { prompts: GRUPO },
      promptId: undefined,
    };
    const patch = jsonOnlyRunPatch(estado);
    expect(patch.promptGroup).toBeUndefined();
    expect(patch.promptId).toBeUndefined();
    expect(promptGroupProblem(estado)).toMatch(/promptId/);
    expect(promptGroupProblem({ ...estado, promptId: 'zzz' })).toMatch(/zzz/);
    expect(promptGroupProblem({ ...estado, promptId: 'a' })).toBeNull();
  });

  it('promptId sem grupo → aviso nomeando prompt.promptId (e não vai para a run)', () => {
    const { state, warnings } = importar({ ...VARIATION, prompt: { text: 'A', promptId: 'a' } });
    expect(hasWarning(warnings, 'prompt.promptId')).toBe(true);
    expect(jsonOnlyRunPatch(state).promptId).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// 2. repeats na estimativa
// --------------------------------------------------------------------------

describe('IMPL-045 rev — a estimativa conta repeats (compare)', () => {
  const catalogo = ['gen/a', 'ref/a', 'judge/a', 'comp/a', 'comp/b'].map((id) => catalogItem(id, 1e-6, 4e-6));
  const base: RunConfig = {
    mode: 'compare',
    theme: 't',
    stages: 5,
    datagenModelId: 'gen/a',
    judgeModelIds: ['judge/a'],
    referenceModelId: 'ref/a',
    competitorModelIds: ['comp/a', 'comp/b'],
    finalists: 2,
  } as RunConfig;

  it('estimate(repeats:3) > estimate(repeats:1): competidor/juiz/finais 3×, gabarito/datagen 1×', () => {
    const r1 = estimateRunCost(estimateInputFromConfig(base), catalogo);
    const r3 = estimateRunCost(estimateInputFromConfig({ ...base, repeats: 3 }), catalogo);
    expect(r3.point).toBeGreaterThan(r1.point);
    expect(r3.byRole.competitor).toBeCloseTo(3 * r1.byRole.competitor, 12);
    expect(r3.byRole.judge).toBeCloseTo(3 * r1.byRole.judge, 12);
    expect(r3.byRole.duel).toBeCloseTo(3 * r1.byRole.duel, 12);
    expect(r3.byRole.gabarito).toBeCloseTo(r1.byRole.gabarito, 12);
    expect(r3.byRole.datagen).toBeCloseTo(r1.byRole.datagen, 12);
    expect(r3.assumptions).toMatchObject({ stages: 5, repeats: 3 });
    expect(r1.assumptions.repeats).toBe(1);
  });

  it('clamp igual ao orchestrator (1..3, arredondado) e ignorado fora do compare', () => {
    const r1 = estimateRunCost(estimateInputFromConfig(base), catalogo);
    const r9 = estimateRunCost({ ...estimateInputFromConfig(base), repeats: 9 }, catalogo);
    expect(r9.assumptions.repeats).toBe(3);
    expect(r9.byRole.competitor).toBeCloseTo(3 * r1.byRole.competitor, 12);
    const variacao = {
      mode: 'variation',
      theme: 't',
      stages: 5,
      datagenModelId: 'gen/a',
      judgeModelIds: ['judge/a'],
      contestantModelId: 'comp/a',
      techniqueIds: ['persona', 'cot'],
    } as RunConfig;
    const v1 = estimateRunCost(estimateInputFromConfig(variacao), catalogo);
    const v3 = estimateRunCost(estimateInputFromConfig({ ...variacao, repeats: 3 }), catalogo);
    expect(v3.point).toBeCloseTo(v1.point, 12);
    expect(v3.assumptions.repeats).toBe(1);
  });

  it('o portão de confirmação de custo vê o custo triplicado (e as chamadas também)', () => {
    // Catálogo calibrado para a run 1× ficar ABAIXO de US$ 1 e a 3× acima.
    const caro = ['gen/a', 'ref/a', 'judge/a', 'comp/a', 'comp/b'].map((id) => catalogItem(id, 1e-5, 2.5e-5));
    const um = estimateLaunchCost(base, caro);
    const tres = estimateLaunchCost({ ...base, repeats: 3 }, caro);
    expect(um.high).toBeLessThan(1);
    expect(um.requiresConfirmation).toBe(false);
    expect(tres.high).toBeGreaterThan(1);
    expect(tres.requiresConfirmation).toBe(true);
    const calls = (e: typeof um, role: string) => e.drivers.find((d) => d.role === role)?.calls;
    expect(calls(tres, 'competitor')).toBe(3 * calls(um, 'competitor')!);
    expect(calls(tres, 'gabarito')).toBe(calls(um, 'gabarito'));
  });
});

// --------------------------------------------------------------------------
// 3. export de etapas cruas
// --------------------------------------------------------------------------

describe('IMPL-045 rev — round-trip partindo de etapas cruas (customStages)', () => {
  it('exporta stages = nº de etapas: o reimport não gera cenário a mais', () => {
    const estado = {
      ...defaultArenaFormState(),
      stages: 5,
      customStages: [
        { question: 'Q1?', productContext: 'ctx', maxTokens: 300, rubric: 'r1' },
        { question: 'Q2?', productContext: 'ctx', maxTokens: 400, rubric: 'r2' },
      ],
    };
    const { config, omitted } = exportArenaConfig(estado);
    expect(omitted).toEqual([]);
    expect(config.stages).toBe(2);
    expect(config.scenarios).toHaveLength(2);
    const { state } = importar(JSON.parse(JSON.stringify(config)));
    expect(state.stages).toBe(2);
    expect(state.pack?.scenarios).toHaveLength(2);
    // seed == alvo → o datagen não é chamado (mesma regra do orchestrator).
    expect(state.pack!.scenarios.length).toBeGreaterThanOrEqual(state.stages);
    // O arquivo reexportado mantém o alvo e os cenários (só ganha ids `import-N`).
    const denovo = exportArenaConfig(state).config;
    expect(denovo.stages).toBe(2);
    expect((denovo.scenarios as { question: string }[]).map((c) => c.question)).toEqual(['Q1?', 'Q2?']);
  });
});

// --------------------------------------------------------------------------
// 4. training.reflection 'off'
// --------------------------------------------------------------------------

describe("IMPL-045 rev — training.reflection 'off' desliga as lições de verdade", () => {
  const TRAINING = {
    ...VARIATION,
    mode: 'training',
    training: { iterations: 3, reflection: 'off' },
  };

  it("lessonsEnabled: 'off' e feedbackDriven:false desligam; o resto liga", () => {
    expect(lessonsEnabled({})).toBe(true);
    expect(lessonsEnabled({ reflection: 'deterministic' })).toBe(true);
    expect(lessonsEnabled({ reflection: 'llm' })).toBe(true);
    expect(lessonsEnabled({ reflection: 'off' })).toBe(false);
    expect(lessonsEnabled({ feedbackDriven: false })).toBe(false);
  });

  it("o import traduz 'off' para o toggle da tela (Lições das falhas desligado)", () => {
    const { state, warnings } = importar(TRAINING);
    expect(warnings).toEqual([]);
    expect(state.feedbackDriven).toBe(false);
    expect(state.reflection).toBeUndefined();
    // Round-trip estável: o arquivo reexportado carrega o mesmo efeito.
    expect(exportArenaConfig(state).config.training).toMatchObject({ feedbackDriven: false });
  });

  it("'off' com feedbackDriven:true explícito → aviso nomeando training.feedbackDriven", () => {
    const { state, warnings } = importar({ ...TRAINING, training: { ...TRAINING.training, feedbackDriven: true } });
    expect(hasWarning(warnings, 'training.feedbackDriven')).toBe(true);
    expect(state.feedbackDriven).toBe(false);
  });

  // Ponta a ponta nos DOIS trainers (transporte falso, zero gasto): o juiz
  // reprova tudo, então há lições; com 'off' a 2ª iteração não as recebe.
  describe('motores (Node e SPA)', () => {
    let tmp: string;
    let dirAnterior: string;
    let silencio: Array<{ mockRestore(): void }> = [];
    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), 'pb-impl045-'));
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

    const CENARIOS = [
      { question: 'Prazo de troca?', productContext: 'Trocas: 30 dias com nota.', maxTokens: 300, rubric: 'Citar 30 dias.' },
      { question: 'Juros compostos?', productContext: 'M = C (1 + i)^n.', maxTokens: 300, rubric: 'Citar a fórmula.' },
    ];

    async function reescritasComLicoes(
      motor: 'node' | 'web',
      extra: Record<string, unknown>,
    ): Promise<{ total: number; comLicoes: number }> {
      const reescritas: FakeRequest[] = [];
      const fake = fakeOpenRouter({
        catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/opt'].map((id) => catalogItem(id, 1e-6, 1e-6)),
        chat: (req, n) => {
          const usage = { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 * (n + 1) };
          if (req.model === 'fake/gen') return { text: JSON.stringify({ stages: CENARIOS }), usage };
          if (req.model === 'fake/opt') {
            reescritas.push(req);
            const tecnica = /tecnica id="([^"]+)"/.exec(req.user)?.[1] ?? 'x';
            return {
              text: `Voce e um atendente cordial e preciso (${tecnica}). Responda sempre com base no contexto do produto, cite prazos e regras exatamente como aparecem e recuse o que estiver fora do escopo.`,
              usage,
            };
          }
          if (req.model === 'fake/ref') return { text: `Gabarito: ${req.user.slice(0, 40)}`, usage };
          if (req.stream) return { text: `Resposta de ${req.model}`, usage };
          if (req.system.includes('DUELO')) return { text: '{"winner":"A","explanation":"A melhor"}', usage };
          return { text: '{"verdict":"nao","explanation":"faltou citar a regra do contexto"}', usage };
        },
      });
      const anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
      try {
        const cfg = {
          mode: 'training',
          theme: 'suporte ao cliente',
          stages: 2,
          datagenModelId: 'fake/gen',
          judgeModelIds: ['fake/judge'],
          referenceModelId: 'fake/ref',
          referenceJudging: true,
          contestantModelId: 'fake/a',
          basePrompt: 'Voce e um atendente de suporte. Responda com base no contexto do produto.',
          techniqueIds: ['persona'],
          promptOptimization: true,
          optimizerModelId: 'fake/opt',
          iterations: 2,
          minGain: 0,
          holdoutRatio: 0,
          finalists: 0,
          timeoutMs: 5_000,
          ...extra,
        };
        if (motor === 'node') {
          const rec = await trainNode(cfg as never, 'sk-or-v1-fake');
          expect(rec.status, rec.error).toBe('finished');
        } else {
          const { sessionId, record } = await startWebTraining(cfg as never, 'sk-or-v1-fake');
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('sessão não terminou')), 10_000);
            const fim = (): void => {
              clearTimeout(t);
              unsub();
              resolve();
            };
            const unsub = subscribeSession(sessionId, (e) => {
              if (e.type === 'session.finished' || e.type === 'session.error') fim();
            });
            if (record.status !== 'running') fim();
          });
          expect(record.status, record.error).toBe('finished');
        }
      } finally {
        setDefaultGateway(anterior);
      }
      return {
        total: reescritas.length,
        comLicoes: reescritas.filter((r) => r.user.includes('<licoes_da_iteracao_anterior>')).length,
      };
    }

    for (const motor of ['node', 'web'] as const) {
      it(`${motor}: controle — sem 'off' a 2ª iteração recebe as lições`, async () => {
        const r = await reescritasComLicoes(motor, {});
        expect(r.total).toBe(2);
        expect(r.comLicoes).toBe(1);
      });

      it(`${motor}: reflection 'off' → nenhuma reescrita recebe lições`, async () => {
        const r = await reescritasComLicoes(motor, { reflection: 'off' });
        expect(r.total).toBe(2);
        expect(r.comLicoes).toBe(0);
      });
    }
  });
});

// --------------------------------------------------------------------------
// 5. campos que dependem de variation.optimize — métrica 0 silenciosos
// --------------------------------------------------------------------------

describe('IMPL-045 rev — campo que depende de variation.optimize avisa quando não entra', () => {
  const MANUAIS = [
    { label: 'Curta', systemPrompt: 'Responda curto.' },
    { label: 'Longa', systemPrompt: 'Responda com detalhes.' },
  ];
  // Amostra de valor por BLOCO de campo (o arquivo precisa continuar válido).
  const AMOSTRA: Record<string, (cfg: Record<string, unknown>) => void> = {
    'variation.techniques': (c) => ((c.variation as Record<string, unknown>).techniques = ['persona']),
    'variation.manualVariants': (c) => ((c.variation as Record<string, unknown>).manualVariants = MANUAIS),
    'models.rewriter': (c) => ((c.models as Record<string, unknown>).rewriter = 'rew/a'),
    'effort.rewriter': (c) => (c.effort = { rewriter: 'low' }),
    'prompt.contracts.neverBreak': (c) => ((c.prompt as Record<string, unknown>).contracts = { neverBreak: ['x'] }),
    'prompt.contracts.placeholders': (c) =>
      ((c.prompt as Record<string, unknown>).contracts = { placeholders: ['{{nome}}'] }),
    'prompt.contracts.minLengthRatio': (c) =>
      ((c.prompt as Record<string, unknown>).contracts = { minLengthRatio: 0.5 }),
  };

  const comOptimize = Object.entries(ARENA_FIELD_HANDLING).filter(
    ([, h]) => (h as { whenOptimize?: boolean }).whenOptimize !== undefined,
  );

  it('os campos da revisão estão marcados na tabela', () => {
    const marcados = new Map(comOptimize.map(([p, h]) => [p, (h as { whenOptimize?: boolean }).whenOptimize]));
    expect(marcados.get('variation.manualVariants[].systemPrompt')).toBe(false);
    expect(marcados.get('variation.techniques')).toBe(true);
    expect(marcados.get('models.rewriter')).toBe(true);
    expect(marcados.get('effort.rewriter')).toBe(true);
  });

  for (const [path, h] of comOptimize) {
    const quer = (h as { whenOptimize?: boolean }).whenOptimize!;
    const topo = path.replace(/\[\]\..*$/, '');
    for (const modo of ['variation', 'training'] as const) {
      it(`métrica 0 silencioso: ${path} com optimize ${quer ? 'desligado' : 'ligado'} (${modo}) → aviso`, () => {
        const cfg = JSON.parse(JSON.stringify(VARIATION)) as Record<string, unknown>;
        cfg.mode = modo;
        // O optimize OPOSTO ao que o campo exige (válido pelo schema).
        cfg.variation = quer ? { optimize: false, manualVariants: MANUAIS } : { optimize: true, techniques: ['cot'] };
        const amostra = AMOSTRA[topo] ?? AMOSTRA[path];
        expect(amostra, `sem amostra para ${path}`).toBeDefined();
        amostra(cfg);
        const { warnings } = importar(cfg);
        expect(warnings.some((w) => w.path === topo || w.path === path), JSON.stringify(warnings)).toBe(true);
      });
    }
  }

  it('com o optimize certo, nenhum aviso (e o export não leva o que não se aplica)', () => {
    const ligado = { ...VARIATION, models: { ...VARIATION.models, rewriter: 'rew/a' }, effort: { rewriter: 'low' } };
    expect(importar(ligado).warnings).toEqual([]);
    const desligado = { ...VARIATION, variation: { optimize: false, manualVariants: MANUAIS } };
    const { state, warnings } = importar(desligado);
    expect(warnings).toEqual([]);
    // Tela com reescritor + optimize desligado: o arquivo exportado não o carrega.
    const { config } = exportArenaConfig({ ...state, rewriterModel: ['rew/a'], tuning: { 'rew/a': { effort: 'low' } } });
    expect(config.models.rewriter).toBeUndefined();
    expect(config.effort?.rewriter).toBeUndefined();
  });
});
