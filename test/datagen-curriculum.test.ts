// IMPL-064 (R-05:REC-5) — schema datagen v2: metadados de curriculum deixam de
// ser stripados em silêncio pelo object() do zod (bug E2).
//
// O gap: o schema só validava question/productContext/maxTokens/rubric —
// tier, dimensionTags[], persona, difficultyEstimate e invarianceGroup emitidos
// pelo modelo SUMIAM. Em cadeia: sliceScoresOf do treino caía sempre na fatia
// 'geral', o curriculum por fatias Pareto não funcionava para itens do datagen
// e invariancePairs nunca recebia tags inv:* vindas da geração.
//
// Contrato aqui: round-trip do JSON do lote preserva TODOS os campos; 100% dos
// itens gerados sai com tier e dimensionTags preenchidos; o gerador é pedido a
// emitir os campos; a matriz-alvo por tier é editável.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/openrouter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/openrouter.js')>();
  return { ...real, chatCompletion: vi.fn(real.chatCompletion) };
});

import { chatCompletion, createGateway, setDefaultGateway, type ChatMessage } from '../src/openrouter.js';
import * as datagen from '../src/datagen.js';
import type { StageSpec } from '../src/types.js';
import * as datagenWeb from '../web/src/engine/datagen.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const spy = vi.mocked(chatCompletion);

/** Item COMPLETO do contrato v2 — todos os campos do schema. */
const ITEM_COMPLETO: Record<string, unknown> = {
  question: 'Qual o prazo de troca do Fone Aurora com nota fiscal?',
  productContext: 'Fone Aurora: troca em 30 dias com nota fiscal.',
  maxTokens: 400,
  rubric: 'Deve citar os 30 dias e a nota fiscal.',
  tier: 'edge',
  dimensionTags: ['troca', 'prazo', 'pt-BR'],
  persona: 'cliente insatisfeito com o produto',
  difficultyEstimate: 4,
  invarianceGroup: 'inv:prazo-troca',
  origin: 'ai',
  language: 'pt-BR',
};

function fakeGerador(itens: Record<string, unknown>[]): FakeOpenRouter {
  return fakeOpenRouter({
    catalog: [catalogItem('fake/gen', 0.000001, 0.000002)],
    chat: (req) =>
      req.system.includes('gerador de cenarios de benchmark')
        ? { text: JSON.stringify({ stages: itens }) }
        : { text: 'ok' },
  });
}

function mensagensDatagen(): ChatMessage[][] {
  return spy.mock.calls
    .map(([params]) => params)
    .filter((p) => p.role === 'datagen')
    .map((p) => p.messages);
}
const systemDe = (msgs: ChatMessage[]): string => msgs.find((m) => m.role === 'system')?.content ?? '';

let anterior: ReturnType<typeof setDefaultGateway> | undefined;

function instalar(f: FakeOpenRouter): void {
  anterior = setDefaultGateway(createGateway({ fetch: f.fetch, sleep: noSleep }));
}

beforeEach(() => {
  spy.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
});

describe('IMPL-064 — round-trip do schema preserva TODOS os campos emitidos', () => {
  it('parseStage: nada do que o modelo emitiu some (o bug E2 stripava 5 campos)', () => {
    const out = datagen.parseStage(ITEM_COMPLETO);
    expect(out).not.toBeNull();
    expect(out).toEqual({
      question: ITEM_COMPLETO.question,
      productContext: ITEM_COMPLETO.productContext,
      maxTokens: 400,
      rubric: ITEM_COMPLETO.rubric,
      tier: 'edge',
      dimensionTags: ['troca', 'prazo', 'pt-BR'],
      persona: 'cliente insatisfeito com o produto',
      difficultyEstimate: 4,
      invarianceGroup: 'inv:prazo-troca',
      origin: 'ai',
      language: 'pt-BR',
    });
    // Campo a campo, para o diagnóstico apontar o sumido.
    for (const campo of [
      'tier',
      'dimensionTags',
      'persona',
      'difficultyEstimate',
      'invarianceGroup',
      'origin',
      'language',
    ] as const) {
      expect(out).toHaveProperty(campo, ITEM_COMPLETO[campo]);
    }
  });

  it('parseStageList faz o mesmo round-trip por lote', () => {
    const out = datagen.parseStageList([ITEM_COMPLETO, { ...ITEM_COMPLETO, question: 'Outra pergunta?', tier: 'mft' }]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(datagen.parseStage(ITEM_COMPLETO));
    expect(out[1].tier).toBe('mft');
    expect(out[1].dimensionTags).toEqual(['troca', 'prazo', 'pt-BR']);
  });

  it('difficultyEstimate é sinal de curadoria: clampado em [1,5], nunca derruba o item', () => {
    const alto = datagen.parseStage({ ...ITEM_COMPLETO, difficultyEstimate: 9 });
    expect(alto?.difficultyEstimate).toBe(5);
    const baixo = datagen.parseStage({ ...ITEM_COMPLETO, difficultyEstimate: 0 });
    expect(baixo?.difficultyEstimate).toBe(1);
  });
});

describe('IMPL-064 — 100% dos itens gerados com tier e dimensionTags preenchidos', () => {
  it('modelo que emite tudo: sai com tier e tags do modelo', () => {
    const out = datagen.parseStage(ITEM_COMPLETO);
    expect(out?.tier).toBe('edge');
    expect(out?.dimensionTags?.length).toBeGreaterThan(0);
  });

  it('modelo que NÃO emite tier/tags (ou manda lista vazia): default defensivo preenche — item não some', () => {
    const semMeta = datagen.parseStage({
      question: 'Pergunta qualquer?',
      productContext: 'Contexto qualquer.',
      maxTokens: 300,
    });
    expect(semMeta).not.toBeNull();
    expect(semMeta?.tier).toBe('mft');
    expect(semMeta?.dimensionTags).toEqual(['geral']);

    const listaVazia = datagen.parseStage({ ...ITEM_COMPLETO, dimensionTags: [] });
    expect(listaVazia?.dimensionTags).toEqual(['geral']);
  });

  it('generateStages entrega os metadados de curriculum ao pipeline (fim do strip em silêncio)', async () => {
    instalar(fakeGerador([ITEM_COMPLETO, { ...ITEM_COMPLETO, question: 'Segunda pergunta distinta?' }]));
    const out = await datagen.generateStages({ apiKey: KEY, theme: 'trocas', count: 2, modelId: 'fake/gen' });
    expect(out).toHaveLength(2);
    for (const st of out as StageSpec[]) {
      expect(st.tier).toBeTruthy();
      expect(st.dimensionTags?.length).toBeGreaterThan(0);
    }
    expect(out[0].persona).toBe('cliente insatisfeito com o produto');
    expect(out[0].difficultyEstimate).toBe(4);
    expect(out[0].invarianceGroup).toBe('inv:prazo-troca');
  });
});

describe('IMPL-064 — o gerador é pedido a emitir os campos; matriz-alvo editável', () => {
  it('o system do lote pede tier, dimensionTags e os opcionais de curriculo', () => {
    const msgs = datagen.buildBatchMessages({ theme: 'trocas', count: 2, excludePrompts: [] });
    const system = systemDe(msgs);
    expect(system).toContain('"tier"');
    expect(system).toContain('"dimensionTags"');
    expect(system).toContain('"persona"');
    expect(system).toContain('"difficultyEstimate"');
    expect(system).toContain('"invarianceGroup"');
    // dificuldade é ESTIMATIVA de curadoria, nunca rótulo.
    expect(system).toContain('sinal de curadoria, nunca rotulo');
  });

  it('proporção-alvo por tier é matriz editável (default documentada, sem validade empírica fixa)', () => {
    expect(datagen.DEFAULT_TIER_MIX.mft).toBeGreaterThan(0);
    const systemDefault = systemDe(datagen.buildBatchMessages({ theme: 't', count: 1, excludePrompts: [] }));
    expect(systemDefault).toContain('DISTRIBUICAO-ALVO POR TIER (matriz editavel, sem validade empirica fixa)');
    expect(systemDefault).toContain('mft 60%');

    const custom = systemDe(
      datagen.buildBatchMessages({
        theme: 't',
        count: 1,
        excludePrompts: [],
        tierTargets: { mft: 1 },
      }),
    );
    expect(custom).toContain('mft 100%');
    expect(custom).not.toContain('invariance 15%');
  });

  it('paridade Node × SPA: o shim do web é o mesmo módulo (engine-sync)', () => {
    expect(datagenWeb.parseStage).toBe(datagen.parseStage);
    expect(datagenWeb.generateStages).toBe(datagen.generateStages);
    expect(datagenWeb.buildBatchMessages).toBe(datagen.buildBatchMessages);
  });
});
