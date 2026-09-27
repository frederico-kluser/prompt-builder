// Testes de CONTRATO do RunConfig (`runConfigSchema.ts`) e do pacote de
// cenários (`scenarioPack.ts`) — a especificação real de uma run, validada
// igual no CLI e no servidor. Travam o preprocess, o XOR do compare e as
// regras anti-viés antes de qualquer refactor.

import { describe, expect, it } from 'vitest';
import { parseRunConfig } from '../src/runConfigSchema.js';
import {
  buildScenarioPack,
  mergeScenarios,
  parseScenarioPack,
  SCENARIO_PACK_FORMAT,
} from '../src/scenarioPack.js';
import type { StageSpec } from '../src/types.js';

const compareBase = {
  mode: 'compare',
  theme: 'tema',
  stages: 3,
  datagenModelId: 'gerador/x',
  judgeModelIds: ['juiz/x'],
  competitorModelIds: ['a/x', 'b/x'],
};

describe('runConfigSchema — compare', () => {
  it('aceita o compare clássico mínimo', () => {
    const r = parseRunConfig(compareBase);
    expect(r.ok).toBe(true);
  });

  it('compat: sem `mode` vira compare; judgeModelId legado vira lista', () => {
    const { mode: _m, judgeModelIds: _j, ...legacy } = compareBase;
    const r = parseRunConfig({ ...legacy, judgeModelId: 'juiz/x' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.mode).toBe('compare');
      expect(r.config.judgeModelIds).toEqual(['juiz/x']);
    }
  });

  it('XOR: competitorConfigs e competitorModelIds nunca juntos, nunca vazios', () => {
    const ambos = parseRunConfig({ ...compareBase, competitorConfigs: [{ modelId: 'c/x' }, { modelId: 'd/x' }] });
    expect(ambos.ok).toBe(false);
    const nenhum = parseRunConfig({
      mode: 'compare',
      theme: 't',
      stages: 3,
      datagenModelId: 'g/x',
      judgeModelIds: ['j/x'],
    });
    expect(nenhum.ok).toBe(false);
  });

  it('anti-viés: juiz e gerador não podem competir', () => {
    const juiz = parseRunConfig({ ...compareBase, competitorModelIds: ['juiz/x', 'b/x'] });
    expect(juiz.ok).toBe(false);
    if (!juiz.ok) expect(juiz.error).toMatch(/juiz/i);
    const gerador = parseRunConfig({ ...compareBase, competitorModelIds: ['gerador/x', 'b/x'] });
    expect(gerador.ok).toBe(false);
    if (!gerador.ok) expect(gerador.error).toMatch(/gerador/i);
  });

  it('competidor repetido é recusado no eixo clássico', () => {
    const r = parseRunConfig({ ...compareBase, competitorModelIds: ['a/x', 'a/x'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/repetido/i);
  });

  it('compare-llms: a MESMA tripla não pode repetir (identidade = modelo/temp/level)', () => {
    const r = parseRunConfig({
      ...compareBase,
      competitorModelIds: undefined,
      competitorConfigs: [
        { modelId: 'a/x', temperature: 0 },
        { modelId: 'a/x', temperature: 0 },
      ],
    });
    expect(r.ok).toBe(false);
    const r2 = parseRunConfig({
      ...compareBase,
      competitorModelIds: undefined,
      competitorConfigs: [
        { modelId: 'a/x', temperature: 0 },
        { modelId: 'a/x', temperature: 0.7 },
      ],
    });
    expect(r2.ok).toBe(true);
  });
});

describe('runConfigSchema — variation/training', () => {
  const variationBase = {
    mode: 'variation',
    theme: 'tema',
    stages: 4,
    datagenModelId: 'gerador/x',
    judgeModelIds: ['juiz/x'],
    contestantModelId: 'modelo/x',
    basePrompt: 'prompt base do usuario',
    techniqueIds: ['tecnica-a', 'tecnica-b'],
  };

  it('aceita variation com base + 2 técnicas', () => {
    expect(parseRunConfig(variationBase).ok).toBe(true);
  });

  it('anti-viés: juiz ≠ modelo sob teste', () => {
    const r = parseRunConfig({ ...variationBase, judgeModelIds: ['modelo/x'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/auto-preferencia/i);
  });

  it('exige ≥2 contestants (técnicas ou variantes manuais + base)', () => {
    // 1 técnica SEM base = 1 contestant → insuficiente.
    const r = parseRunConfig({ ...variationBase, basePrompt: undefined, techniqueIds: ['so-uma'] });
    expect(r.ok).toBe(false);
    // 1 técnica + base = 2 contestants → suficiente (regra "ou 1 técnica + prompt base").
    expect(parseRunConfig({ ...variationBase, techniqueIds: ['so-uma'] }).ok).toBe(true);
    const manual = parseRunConfig({
      ...variationBase,
      promptOptimization: false,
      techniqueIds: undefined,
      basePrompt: undefined,
      manualVariants: [{ label: 'v1', systemPrompt: 'x' }],
    });
    expect(manual.ok).toBe(false);
  });

  it('training exige iterations 2–10 e aceita os toggles de evolução', () => {
    const ok = parseRunConfig({
      ...variationBase,
      mode: 'training',
      iterations: 5,
      minGain: 2,
      holdoutRatio: 0.3,
      feedbackDriven: true,
    });
    expect(ok.ok).toBe(true);
    const curto = parseRunConfig({ ...variationBase, mode: 'training', iterations: 1 });
    expect(curto.ok).toBe(false);
  });

  it('customStages dita a contagem e herda maxTokens de maxOutputTokens', () => {
    const r = parseRunConfig({
      ...variationBase,
      stages: 99,
      maxOutputTokens: 777,
      customStages: [{ question: 'q1', productContext: 'ctx' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.config.mode !== 'compare') {
      expect(r.config.stages).toBe(1);
      expect(r.config.customStages?.[0]?.maxTokens).toBe(777);
    }
  });

  it('modo agente exige maxCostUsd e agentTask em toda etapa', () => {
    const semTeto = parseRunConfig({
      ...variationBase,
      agent: { executor: 'pi', executorVersion: '1.0.0' },
    });
    expect(semTeto.ok).toBe(false);
    const ok = parseRunConfig({
      ...variationBase,
      agent: { executor: 'pi', executorVersion: '1.0.0', limits: { maxCostUsd: 1 } },
      customStages: [
        {
          question: 'q',
          productContext: 'ctx',
          agentTask: { contextFiles: false, verify: [{ cmd: 'true' }] },
        },
      ],
    });
    expect(ok.ok).toBe(true);
    const semTask = parseRunConfig({
      ...variationBase,
      agent: { executor: 'pi', executorVersion: '1.0.0', limits: { maxCostUsd: 1 } },
      customStages: [{ question: 'q', productContext: 'ctx' }],
    });
    expect(semTask.ok).toBe(false);
  });

  it('a mensagem de erro é PT-BR e nomeia o campo', () => {
    const r = parseRunConfig({ mode: 'compare', theme: '', stages: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/theme/i);
  });
});

const spec = (over: Partial<StageSpec> & { question: string }): StageSpec => ({
  productContext: 'ctx',
  maxTokens: 800,
  ...over,
});

describe('scenarioPack — build/parse/merge', () => {
  it('build grava o formato corrente; parse aceita o legado também', () => {
    const pack = buildScenarioPack({
      theme: 'tema',
      prompt: { text: 'p', source: 'base' },
      scenarios: [spec({ question: 'q1' }), spec({ question: 'q2' })],
    });
    expect(pack.format).toBe(SCENARIO_PACK_FORMAT);
    expect(pack.scenarios.map((s) => s.id)).toEqual(['sc-1', 'sc-2']);
    expect(parseScenarioPack(pack).ok).toBe(true);
    expect(parseScenarioPack({ ...pack, format: 'ai-benchmark-pack@1' }).ok).toBe(true);
    expect(parseScenarioPack({ ...pack, format: 'prompt-builder-pack@2' }).ok).toBe(false);
    expect(parseScenarioPack(null).ok).toBe(false);
    expect(parseScenarioPack('lixo').ok).toBe(false);
  });

  it('parse NUNCA lança: campo inválido vira mensagem PT-BR nomeando o cenário', () => {
    const pack = buildScenarioPack({
      theme: 't',
      prompt: { text: 'p', source: 'champion' },
      scenarios: [spec({ question: 'q1' })],
    });
    const broken = { ...pack, scenarios: [{ ...pack.scenarios[0], question: '' }] };
    const r = parseScenarioPack(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cenário 1/);
  });

  it('merge: seed entra inteiro (curadoria) e gerados só sem quase-duplicata', () => {
    const seed = [spec({ question: 'Como configuro o webhook de pagamento?' })];
    const generated = [
      spec({ question: 'Como configuro o webhook de pagamento?' }), // duplicata exata
      spec({ question: 'Explique a diferença entre TCP e UDP.' }),
    ];
    const merged = mergeScenarios(seed, generated);
    expect(merged).toHaveLength(2);
    expect(merged[0].origin).toBe('import');
    expect(merged[1].origin).toBe('ai');
    // O seed NUNCA é descartado por duplicidade.
    expect(merged[0].question).toMatch(/webhook/);
  });

  it('merge preserva reference/rubric do seed (gabarito não se perde no merge)', () => {
    const seed = [spec({ question: 'q-seed', reference: 'gabarito', rubric: 'criterio' })];
    const merged = mergeScenarios(seed, []);
    expect(merged[0].reference).toBe('gabarito');
    expect(merged[0].rubric).toBe('criterio');
  });
});
