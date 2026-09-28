// IMPL-056 (R-03a:REC-6) — idioma FIXADO em pt-BR no datagen; variedade de
// idioma só via opt-in `languages` (--languages na CLI).
//
// O gap: os prompts pediam "varie tipos de tarefa, dificuldade e idioma" e
// "idiomas ainda sub-representados" — os lotes misturavam idiomas de propósito
// num produto monolíngue, e avaliadores dão notas diferentes a pares
// semanticamente idênticos em idiomas diferentes (confundidor no veredito).
//
// Contrato aqui: com n>4 e SEM a flag, nenhuma mensagem pede variação de
// idioma; 100% dos cenários sai com `language: 'pt-BR'`; cenário estrangeiro
// (ex.: seed importada) é reportado em warning; com `languages` opt-in a
// variedade passa a ser pedida e os idiomas emitidos são preservados.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/openrouter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/openrouter.js')>();
  return { ...real, chatCompletion: vi.fn(real.chatCompletion) };
});

import { chatCompletion, createGateway, setDefaultGateway, type ChatMessage } from '../src/openrouter.js';
import * as datagen from '../src/datagen.js';
import type { StageSpec } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const spy = vi.mocked(chatCompletion);

/** Cenário cru do modelo — SEM language: o default tem de ser pt-BR. */
function cenario(i: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    question: `Pergunta distinta número ${i} sobre ${['troca', 'garantia', 'frete', 'nota', 'prazo', 'defeito'][i % 6]} do produto ${i * 37}?`,
    productContext: `Política ${i}: trocas em até 30 dias.`,
    maxTokens: 300,
    rubric: `Deve citar o prazo da política ${i}.`,
    ...extra,
  };
}

function fakeGerador(porChamada: (n: number) => Record<string, unknown>[]): FakeOpenRouter {
  let nDatagen = 0;
  return fakeOpenRouter({
    catalog: [catalogItem('fake/gen', 0.000001, 0.000002)],
    chat: (req) =>
      req.system.includes('gerador de cenarios de benchmark')
        ? { text: JSON.stringify({ stages: porChamada(nDatagen++) }) }
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
const userDe = (msgs: ChatMessage[]): string => msgs.find((m) => m.role === 'user')?.content ?? '';
const todoTexto = (msgs: ChatMessage[]): string => msgs.map((m) => m.content).join('\n');

let anterior: ReturnType<typeof setDefaultGateway> | undefined;
let warn: ReturnType<typeof vi.spyOn>;

function instalar(f: FakeOpenRouter): void {
  anterior = setDefaultGateway(createGateway({ fetch: f.fetch, sleep: noSleep }));
}

beforeEach(() => {
  spy.mockClear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
});

describe('IMPL-056 — sem a flag, o datagen NÃO pede variação de idioma', () => {
  it('com n>4 (lotes paralelos + backfill) nenhuma mensagem pede mistura de idioma', async () => {
    // Todo lote devolve os MESMOS 4 cenários: o dedup força o backfill — o
    // caminho que antes pedia "idiomas ainda sub-representados".
    instalar(fakeGerador(() => [cenario(1), cenario(2), cenario(3), cenario(4)]));
    await datagen.generateStages({ apiKey: KEY, theme: 'trocas', count: 8, modelId: 'fake/gen' });

    const chamadas = mensagensDatagen();
    expect(chamadas.length).toBe(3); // 2 lotes + 1 backfill
    for (const msgs of chamadas) {
      const texto = todoTexto(msgs);
      expect(texto).not.toMatch(/idiomas? (ainda )?sub-representados/i);
      expect(texto).not.toContain('dificuldade e idioma');
      expect(texto).not.toMatch(/varie[^\n]{0,60}entre[^\n]{0,40}idiomas/i);
    }
    // O backfill cobre variedade de tarefa/dificuldade, sem tocar em idioma.
    const backfills = chamadas.filter((m) => userDe(m).includes('LACUNAS DE VARIEDADE'));
    expect(backfills).toHaveLength(1);
    expect(userDe(backfills[0])).toContain('tipos de tarefa e dificuldades ainda sub-representados');
    expect(userDe(backfills[0])).not.toMatch(/idioma/i);
    // E o system FIXA o idioma do produto.
    expect(systemDe(chamadas[0])).toContain('Idioma: EXCLUSIVAMENTE pt-BR');
    expect(systemDe(chamadas[0])).toContain('o campo "language" deve ser "pt-BR"');
  });

  it('run PT-BR: 100% dos cenários gerados sai com language: pt-BR', async () => {
    instalar(fakeGerador((n) => [cenario(10 * n + 1), cenario(10 * n + 2), cenario(10 * n + 3)]));
    const out = await datagen.generateStages({ apiKey: KEY, theme: 'trocas', count: 6, modelId: 'fake/gen' });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((s) => s.language === 'pt-BR')).toBe(true);
  });
});

describe('IMPL-056 — cenário estrangeiro é reportado em warning', () => {
  it('modelo que desobedece e emite idioma estrangeiro: warning no stderr (console.warn)', async () => {
    instalar(
      fakeGerador((n) =>
        n === 0
          ? [cenario(1), cenario(2, { question: 'How do I return this item?', language: 'en' })]
          : [cenario(3)],
      ),
    );
    const out = await datagen.generateStages({ apiKey: KEY, theme: 'trocas', count: 2, modelId: 'fake/gen' });
    // O dado NÃO é mascarado: o cenário mantém o idioma real…
    const estrangeiro = out.find((s) => s.language === 'en');
    expect(estrangeiro).toBeDefined();
    // …e a run pt-BR o reporta em warning.
    const avisos = warn.mock.calls.map((c) => String(c[0]));
    expect(avisos.some((a) => a.includes("idioma 'en'") && a.includes('fora da politica da run'))).toBe(true);
    expect(avisos.some((a) => a.includes('How do I return'))).toBe(true);
  });

  it('languageWarnings: helper puro cobre seeds/importações (o caminho de run inteira)', () => {
    const stages: Pick<StageSpec, 'question' | 'language'>[] = [
      { question: 'Qual o prazo de troca?', language: 'pt-BR' },
      { question: "What's the return window?", language: 'en' },
      { question: 'Sem idioma declarado' },
    ];
    const avisos = datagen.languageWarnings(stages);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain("idioma 'en'");
    // Com opt-in, os idiomas permitidos não alertam.
    expect(datagen.languageWarnings(stages, { languages: ['pt-BR', 'en'] })).toHaveLength(0);
    expect(datagen.languageWarnings(stages, { languages: ['pt-BR'] })).toHaveLength(1);
  });
});

describe('IMPL-056 — variedade de idioma só via opt-in `languages`', () => {
  it('com languages a variedade passa a ser pedida e os idiomas emitidos são preservados', async () => {
    instalar(
      fakeGerador((n) =>
        n === 0
          ? [cenario(1, { language: 'pt-BR' }), cenario(2, { question: 'How do I return this item?', language: 'en' })]
          : [cenario(3, { language: 'pt-BR' }), cenario(4, { language: 'en' })],
      ),
    );
    const out = await datagen.generateStages({
      apiKey: KEY,
      theme: 'trocas',
      count: 4,
      modelId: 'fake/gen',
      languages: ['pt-BR', 'en'],
    });

    const chamadas = mensagensDatagen();
    expect(systemDe(chamadas[0])).toContain('Idiomas permitidos: pt-BR, en');
    expect(systemDe(chamadas[0])).toMatch(/varie os cenarios ENTRE estes idiomas/i);
    expect(out.some((s) => s.language === 'en')).toBe(true);
    expect(out.some((s) => s.language === 'pt-BR')).toBe(true);
    // Nada de warning: a variedade foi EXPLICITAMENTE pedida.
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('fora da politica da run');
  });

  it('o system de UM cenário (generateStage) também fixa o idioma por default', async () => {
    // generateStage espera UM objeto de cenário (não o envelope {stages: [...]}).
    instalar(
      fakeOpenRouter({
        catalog: [catalogItem('fake/gen', 0.000001, 0.000002)],
        chat: () => ({ text: JSON.stringify(cenario(1)) }),
      }),
    );
    await datagen.generateStage({
      apiKey: KEY,
      theme: 'trocas',
      stageIndex: 0,
      totalStages: 1,
      modelId: 'fake/gen',
    });
    const [msgs] = mensagensDatagen();
    expect(systemDe(msgs)).toContain('Idioma: EXCLUSIVAMENTE pt-BR');
  });
});
