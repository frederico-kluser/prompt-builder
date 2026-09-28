// IMPL-048 (R-03a:REC-2) — papéis separados: referência × juiz × competidores.
//
// Contratos provados aqui (zero LLM, zero rede):
//  (i)   referenceModelId IGUAL a um juiz ou a um competidor => ERRO de config
//        (mesmo modelo escreveria o gabarito e emitiria o veredito — erros
//        correlacionados que não se cancelam, DEC-2);
//  (ii)  training/variation SEM referenceModelId reprova na validação (o
//        gabarito não pode sair do 1º juiz);
//  (iii) compare continua aceitando sem referenceModelId (default explícito e
//        documentado: 1º juiz) — e o conflito desse default aparece como AVISO;
//  (iv)  `fairnessWarnings` cobre a REFERÊNCIA (auto-preferência e mesmo
//        vendor/família) — aviso nunca-bloqueante.

import { describe, expect, it } from 'vitest';
import { parseRunConfig } from '../src/runConfigSchema.js';
import { fairnessWarnings, fairnessWarningsForModels } from '../src/llmVariants.js';

const BASE_COMPARE = {
  mode: 'compare',
  theme: 'suporte',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  competitorModelIds: ['fake/a', 'fake/b'],
};

const BASE_VARIATION = {
  mode: 'variation',
  theme: 'suporte',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  contestantModelId: 'fake/a',
  basePrompt: 'prompt base do usuario',
  techniqueIds: ['tecnica-a', 'tecnica-b'],
};

describe('IMPL-048 — referenceModelId não pode ser juiz nem competidor (erro de config)', () => {
  it('compare: referência igual a um juiz reprova, nomeando o campo', () => {
    const r = parseRunConfig({ ...BASE_COMPARE, referenceModelId: 'fake/judge' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/n[ãa]o pode ser tamb[ée]m juiz/);
  });

  it('compare: referência igual a um competidor (competitorModelIds) reprova', () => {
    const r = parseRunConfig({ ...BASE_COMPARE, referenceModelId: 'fake/b' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/n[ãa]o pode ser tamb[ée]m competidor/);
  });

  it('compare-llms: referência igual ao modelo de uma competitorConfig reprova', () => {
    const r = parseRunConfig({
      ...BASE_COMPARE,
      competitorModelIds: undefined,
      competitorConfigs: [
        { modelId: 'fake/a' },
        { modelId: 'fake/b' },
      ],
      referenceModelId: 'fake/a',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/n[ãa]o pode ser tamb[ée]m competidor/);
  });

  it('variation: referência igual ao modelo sob teste reprova', () => {
    const r = parseRunConfig({ ...BASE_VARIATION, referenceModelId: 'fake/a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/n[ãa]o pode ser tamb[ée]m competidor/);
  });

  it('training: referência igual a um juiz reprova (train/vary exigem papéis distintos)', () => {
    const r = parseRunConfig({
      ...BASE_VARIATION,
      mode: 'training',
      iterations: 2,
      referenceModelId: 'fake/judge',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/n[ãa]o pode ser tamb[ée]m juiz/);
  });

  it('referência DISTINTA de juiz e competidores é aceita em todos os modos', () => {
    expect(parseRunConfig({ ...BASE_COMPARE, referenceModelId: 'fake/ref' }).ok).toBe(true);
    expect(
      parseRunConfig({ ...BASE_VARIATION, referenceModelId: 'fake/ref' }).ok,
    ).toBe(true);
    expect(
      parseRunConfig({
        ...BASE_VARIATION,
        mode: 'training',
        iterations: 2,
        referenceModelId: 'fake/ref',
      }).ok,
    ).toBe(true);
  });
});

describe('IMPL-048 — referenceModelId obrigatório em train/vary; default documentado no compare', () => {
  it('variation sem referenceModelId reprova na validação', () => {
    const r = parseRunConfig(BASE_VARIATION);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/referenceModelId [ée] obrigat[óo]rio em training\/variation/);
  });

  it('training sem referenceModelId reprova na validação', () => {
    const r = parseRunConfig({ ...BASE_VARIATION, mode: 'training', iterations: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/referenceModelId [ée] obrigat[óo]rio em training\/variation/);
  });

  it('compare sem referenceModelId ACEITA (default explícito: o 1º juiz escreve o gabarito)', () => {
    expect(parseRunConfig(BASE_COMPARE).ok).toBe(true);
  });
});

describe('IMPL-048 — fairnessWarnings cobre a referência (aviso, nunca bloqueio)', () => {
  it('referência do mesmo vendor que juiz/competidores => aviso de família citando a referência', () => {
    const avisos = fairnessWarningsForModels(
      ['openai/gpt-4o', 'anthropic/claude-x'],
      ['openai/judge-1'],
      'openai/gpt-5-ref',
    );
    const daFamilia = avisos.find((a) => a.includes('A referência') && a.includes('mesmo vendor'));
    expect(daFamilia).toBeTruthy();
    expect(daFamilia).toContain('openai/gpt-5-ref');
    expect(daFamilia).toContain('openai/gpt-4o');
    expect(daFamilia).toContain('openai/judge-1');
  });

  it('referência que também JUZGA => aviso de auto-preferência (o default do compare aparece)', () => {
    const avisos = fairnessWarningsForModels(['fake/a'], ['fake/judge'], 'fake/judge');
    expect(avisos.some((a) => a.includes('A referência') && a.includes('também juiz'))).toBe(true);
  });

  it('referência que também COMPETE => aviso de auto-preferência', () => {
    const avisos = fairnessWarningsForModels(['fake/a'], ['fake/judge'], 'fake/a');
    expect(avisos.some((a) => a.includes('A referência') && a.includes('também compete'))).toBe(true);
  });

  it('papéis distintos e vendors distintos => silêncio (nenhum aviso novo)', () => {
    const avisos = fairnessWarningsForModels(
      ['anthropic/claude-x'],
      ['openai/judge-1'],
      'google/gemini-ref',
    );
    expect(avisos.filter((a) => a.includes('A referência'))).toEqual([]);
  });

  it('sem referenceModelId o comportamento legado fica intacto (compat do contrato)', () => {
    const vs = [
      { id: 'openai/gpt-4o', label: 'gpt-4o', modelId: 'openai/gpt-4o', reasoningLevel: null, temperature: null },
      { id: 'openai/gpt-4.1', label: 'gpt-4.1', modelId: 'openai/gpt-4.1', reasoningLevel: null, temperature: null },
    ];
    const avisos = fairnessWarnings(vs, ['openai/gpt-4.1']);
    expect(avisos).toHaveLength(2); // auto-preferência + mesmo vendor (como antes)
    expect(avisos.every((a) => !a.includes('A referência'))).toBe(true);
  });
});
