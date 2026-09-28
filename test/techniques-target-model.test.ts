// IMPL-066 (R-20:REC-2/DEC-2) — reescritor CONSCIENTE do modelo-alvo.
//
// O payload da chamada do reescritor levava tema/técnica/lições/base e NÃO o
// modelo sob teste: a metaInstruction de cot ("Nao acrescente CoT se o modelo
// ja for de raciocinio") era impossível de cumprir e cot/fewshot/selfcritique/
// stepback eram propostas para modelos de raciocínio, onde degradam (efeito
// oposto documentado entre SF e CR) — avaliações caras gerando ruído.
//
// Critérios de aceite provados aqui:
//   1) modelId, FAMÍLIA e think level de produção são enviados no payload;
//   2) com catálogo mockado, cot/fewshot NÃO são propostas quando
//      `reasoning.mandatory` OU think level > off;
//   3) variantes redundantes por classe de modelo = 0 em suíte fixa.
//
// Zero rede, zero gasto: transporte falso (`fakeOpenRouter`) que captura o
// payload exato enviado ao reescritor.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGateway, parseModelsPayload, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { BudgetLedger } from '../src/budget.js';
import { generateContestants, REWRITER_PAYLOAD_VERSION } from '../src/variator.js';
import {
  filterTechniquesForTarget,
  listTechniques,
  MODEL_CLASS_DEPENDENT_TECHNIQUE_IDS,
  targetReasoningActive,
  type TargetModelInfo,
} from '../src/techniques.js';
import { modelFamily } from '../src/llmVariants.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const ALVO = 'openai/gpt-alvo';
const OTIMIZADOR = 'fake/opt';

const BASE = 'Voce e um atendente da loja Aurora. Responda sempre em portugues do Brasil e nunca invente precos.';

/** Reescrita que passa no gate local (preserva placeholders/invariantes e tamanho). */
const REESCRITA = `${BASE} Seja cordial e objetivo, cite prazos quando souber e encaminhe ao humano quando a duvida for operacional.`;

let anterior: OpenRouterGateway | undefined;
let fake: FakeOpenRouter;
let ledger: BudgetLedger;

function usar(): void {
  fake = fakeOpenRouter({
    catalog: [catalogItem(ALVO, 1e-6, 1e-6), catalogItem(OTIMIZADOR, 1e-6, 1e-6)],
    chat: (req) => ({ text: req.model === OTIMIZADOR ? REESCRITA : 'ok' }),
  });
  const prev = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
  anterior ??= prev;
}

beforeEach(() => {
  ledger = new BudgetLedger();
  usar();
});

afterEach(() => {
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
});

/** Chamadas capturadas do reescritor (payloads de user). */
function payloads(): string[] {
  return fake.chatRequests().filter((r) => r.model === OTIMIZADOR).map((r) => r.user);
}

// ---------------------------------------------------------------------------
// Catálogo MOCKADO (formato cru do /models, parseado como em produção)
// ---------------------------------------------------------------------------

/** Item de catálogo com capacidades de RACIOCÍNIO obrigatório. */
const CATALOGO_MANDATORY = [catalogItem(ALVO, 1e-6, 1e-6, {
  supported_parameters: ['reasoning_effort', 'max_tokens'],
  reasoning: { supported_efforts: ['high', 'medium', 'low'], default_effort: 'medium', mandatory: true },
})];

/** Item de catálogo com raciocínio OPCIONAL (aceita desligar). */
const CATALOGO_OPCIONAL = [catalogItem(ALVO, 1e-6, 1e-6, {
  supported_parameters: ['temperature', 'reasoning_effort', 'max_tokens'],
  reasoning: { supported_efforts: ['xhigh', 'high'], default_effort: 'high' },
})];

/** Item de catálogo de modelo SEM raciocínio (chat puro). */
const CATALOGO_CHAT = [catalogItem(ALVO, 1e-6, 1e-6, { supported_parameters: ['temperature', 'max_tokens'] })];

function alvoDe(bruto: Record<string, unknown>[]): TargetModelInfo {
  const [m] = parseModelsPayload({ data: bruto });
  return { supportedParameters: m.supportedParameters, reasoning: m.reasoning };
}

describe('IMPL-066 c1 — payload do reescritor leva modelId, FAMÍLIA e think level de produção', () => {
  it('o bloco <modelo_alvo> traz os três, dentro do payload versionado', async () => {
    await generateContestants({
      apiKey: KEY,
      modelId: ALVO,
      theme: 'suporte a clientes',
      basePrompt: BASE,
      includeOriginal: false,
      techniqueIds: ['format'],
      promptOptimization: true,
      optimizerModelId: OTIMIZADOR,
      contestantReasoningLevel: 'high',
      ctx: { sink: ledger },
    });
    const [payload] = payloads();
    expect(payload).toBeDefined();
    // Contrato do payload VERSIONADO (IMPL-070): o marcador viaja no payload.
    expect(payload).toContain(`<payload_reescritor versao="${REWRITER_PAYLOAD_VERSION}">`);
    expect(payload).toContain('<modelo_alvo>');
    expect(payload).toContain(ALVO); // modelId
    expect(payload).toContain(`familia ${modelFamily(ALVO)}`); // família
    expect(payload).toContain('Nivel de raciocinio em producao: high'); // think level
    // Com o catálogo informado, as capacidades também viajam.
    expect(modelFamily(ALVO)).toBe('openai');
  });

  it('com catálogo, as capacidades (mandatory/degraus) entram no bloco', async () => {
    await generateContestants({
      apiKey: KEY,
      modelId: ALVO,
      theme: 'suporte',
      basePrompt: BASE,
      includeOriginal: false,
      techniqueIds: ['format'],
      promptOptimization: true,
      optimizerModelId: OTIMIZADOR,
      contestantReasoningLevel: 'high',
      targetModel: alvoDe(CATALOGO_MANDATORY),
      ctx: { sink: ledger },
    });
    const [payload] = payloads();
    expect(payload).toContain('raciocinio OBRIGATORIO');
    expect(payload).toContain('degraus de esforco aceitos: high, medium, low');
  });

  it('sem think level explícito, o payload diz que é o default do provedor (nunca mente)', async () => {
    await generateContestants({
      apiKey: KEY,
      modelId: ALVO,
      theme: 'suporte',
      basePrompt: BASE,
      includeOriginal: false,
      techniqueIds: ['format'],
      promptOptimization: true,
      optimizerModelId: OTIMIZADOR,
      ctx: { sink: ledger },
    });
    expect(payloads()[0]).toContain('Nivel de raciocinio em producao: default-do-provedor');
  });
});

describe('IMPL-066 c2 — cot/fewshot NÃO são propostas quando reasoning.mandatory ou think level > off', () => {
  const SUITE = ['cot', 'fewshot', 'persona', 'format'];

  it('catálogo mockado com reasoning.mandatory => cot/fewshot descartadas', () => {
    const r = filterTechniquesForTarget(SUITE, {
      modelId: ALVO,
      thinkLevel: 'off', // nem precisa de think level: o obrigatório já decide
      catalogModel: alvoDe(CATALOGO_MANDATORY),
    });
    expect(targetReasoningActive({ modelId: ALVO, catalogModel: alvoDe(CATALOGO_MANDATORY) })).toBe(true);
    expect(r.kept).toEqual(['persona', 'format']);
    expect(r.dropped.map((d) => d.id).sort()).toEqual(['cot', 'fewshot']);
  });

  it('think level > off (raciocínio ligado) => cot/fewshot descartadas', () => {
    const r = filterTechniquesForTarget(SUITE, {
      modelId: ALVO,
      thinkLevel: 'high',
      catalogModel: alvoDe(CATALOGO_OPCIONAL),
    });
    expect(r.kept).toEqual(['persona', 'format']);
    expect(r.dropped.map((d) => d.id).sort()).toEqual(['cot', 'fewshot']);
  });

  it('think level off + raciocínio opcional => cot/fewshot SEGUEM (modelo não pensa)', () => {
    const r = filterTechniquesForTarget(SUITE, {
      modelId: ALVO,
      thinkLevel: 'off',
      catalogModel: alvoDe(CATALOGO_OPCIONAL),
    });
    expect(r.kept).toEqual(SUITE);
    expect(r.dropped).toEqual([]);
  });

  it('integração: generateContestants não gera variante nem gasta reescrita para as descartadas', async () => {
    const out = await generateContestants({
      apiKey: KEY,
      modelId: ALVO,
      theme: 'suporte',
      basePrompt: BASE,
      includeOriginal: true,
      originalPrompt: BASE,
      techniqueIds: ['cot', 'fewshot', 'format'],
      promptOptimization: true,
      optimizerModelId: OTIMIZADOR,
      contestantReasoningLevel: 'high',
      targetModel: alvoDe(CATALOGO_MANDATORY),
      ctx: { sink: ledger },
    });
    // Só o controle + a variante 'format' — cot/fewshot nem chegaram ao LLM.
    expect(out.map((c) => c.techniqueId).filter(Boolean)).toEqual(['format']);
    expect(payloads()).toHaveLength(1);
    expect(payloads()[0]).toContain('<tecnica id="format"');
  });
});

describe('IMPL-066 c3 — variantes redundantes por classe de modelo = 0 em suíte fixa', () => {
  // Suíte FIXA = biblioteca curada inteira (19 técnicas).
  const SUITE_FIXA = listTechniques().map((t) => t.id);

  it('a suíte fixa tem as 19 técnicas e nenhuma duplicada', () => {
    expect(SUITE_FIXA).toHaveLength(19);
    expect(new Set(SUITE_FIXA).size).toBe(SUITE_FIXA.length);
    for (const id of MODEL_CLASS_DEPENDENT_TECHNIQUE_IDS) expect(SUITE_FIXA).toContain(id);
  });

  it('modelo de raciocínio: 0 propostas classe-dependentes e 0 duplicadas', () => {
    for (const target of [
      { modelId: ALVO, thinkLevel: 'max' as const, catalogModel: alvoDe(CATALOGO_OPCIONAL) },
      { modelId: ALVO, catalogModel: alvoDe(CATALOGO_MANDATORY) },
      { modelId: ALVO, thinkLevel: 'low' as const, catalogModel: alvoDe(CATALOGO_CHAT) },
    ]) {
      const { kept, dropped } = filterTechniquesForTarget(SUITE_FIXA, target);
      // Redundância por classe = 0: nada de cot/fewshot/selfcritique/stepback.
      expect(kept.filter((id) => (MODEL_CLASS_DEPENDENT_TECHNIQUE_IDS as readonly string[]).includes(id))).toEqual([]);
      expect(dropped.map((d) => d.id).sort()).toEqual([...MODEL_CLASS_DEPENDENT_TECHNIQUE_IDS].sort());
      expect(new Set(kept).size).toBe(kept.length);
    }
  });

  it('modelo SEM raciocínio: suíte inteira proposta, sem duplicatas', () => {
    const { kept, dropped } = filterTechniquesForTarget(SUITE_FIXA, {
      modelId: ALVO,
      thinkLevel: 'off',
      catalogModel: alvoDe(CATALOGO_CHAT),
    });
    expect(kept).toEqual(SUITE_FIXA);
    expect(dropped).toEqual([]);
    expect(new Set(kept).size).toBe(kept.length);
  });
});