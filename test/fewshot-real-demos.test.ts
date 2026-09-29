// IMPL-061 (R-02a:REC-3) — few-shot com demos REAIS ponta a ponta no variator
// (gateway com transporte FALSO: zero rede, zero gasto).
//
// Antes: `selectFewShotDemos`/`fewshotMetaInstruction` só existiam em teste —
// nenhum chamador passava traces, e o critério "NENHUM exemplo do prompt final
// é inventado" era provado no TEXTO DA INSTRUÇÃO, nunca no prompt reescrito.
// Agora:
//   1. com ≥ 3 cenários rotulados, o payload do reescritor leva
//      `<demonstracoes_reais>` com os itens VERBATIM, e o prompt final recebe o
//      bloco canônico `<exemplos_reais>` anexado pelo variator — todo exemplo
//      do bloco é do conjunto rotulado por construção (um bloco que o
//      reescritor escreva por conta própria é descartado);
//   2. sem cenários rotulados (ou com < 3), nada de bloco: a técnica decai
//      para a instrução sem demos;
//   3. IMPL-066: sem `targetModel` explícito, o variator lê as capacidades do
//      catálogo EM CACHE do gateway (a SPA monta o `prepare` sem passá-las).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGateway, listModels, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { BudgetLedger } from '../src/budget.js';
import { generateContestants } from '../src/variator.js';
import {
  applyFewShotDemos,
  FEWSHOT_NO_DEMOS_INSTRUCTION,
  fewShotDemosOf,
  labeledScenariosFrom,
  type LabeledScenario,
} from '../src/techniques.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const ALVO = 'acme/alvo';
const OTIMIZADOR = 'fake/opt';
const BASE = 'Voce e um atendente da loja Aurora. Responda sempre em portugues do Brasil e nunca invente precos.';
const REESCRITA = `${BASE} Siga o formato dos exemplos abaixo: resposta curta, com o prazo quando houver.`;

const ROTULADOS: LabeledScenario[] = [
  { question: 'Qual o prazo de troca?', response: '30 dias com nota fiscal.', label: 'prazo' },
  { question: 'Como faço o login?', response: 'Pelo app, aba Conta.\nSe esquecer a senha, use "Recuperar".', label: 'acesso' },
  { question: 'Qual o valor do frete?', response: 'R$ 25 para o Norte.', label: 'preco' },
  { question: 'E a garantia?', response: '12 meses para defeito de fabricação.', label: 'prazo' },
];

let anterior: OpenRouterGateway | undefined;
let fake: FakeOpenRouter;
let ledger: BudgetLedger;
/** O que o reescritor falso devolve (pode tentar INVENTAR um bloco de exemplos). */
let reescrita = REESCRITA;

beforeEach(() => {
  ledger = new BudgetLedger();
  reescrita = REESCRITA;
  fake = fakeOpenRouter({
    catalog: [
      catalogItem(ALVO, 1e-6, 1e-6, {
        supported_parameters: ['reasoning', 'max_tokens'],
        reasoning: { supported_efforts: ['high'], default_effort: 'high', mandatory: true },
      }),
      catalogItem(OTIMIZADOR, 1e-6, 1e-6),
    ],
    chat: (req) => ({ text: req.model === OTIMIZADOR ? reescrita : 'ok' }),
  });
  anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
});
afterEach(() => {
  if (anterior) setDefaultGateway(anterior);
});

const payloadDe = (tecnica: string): string | undefined =>
  fake
    .chatRequests()
    .filter((r) => r.model === OTIMIZADOR)
    .map((r) => r.user)
    .find((u) => u.includes(`<tecnica id="${tecnica}"`));

async function gerar(labeledScenarios?: LabeledScenario[], techniqueIds = ['fewshot']) {
  return generateContestants({
    apiKey: KEY,
    modelId: ALVO,
    theme: 'suporte a clientes',
    basePrompt: BASE,
    includeOriginal: false,
    techniqueIds,
    promptOptimization: true,
    optimizerModelId: OTIMIZADOR,
    // think level explícito 'off' + catálogo NÃO consultado aqui: o filtro
    // do IMPL-066 fica fora do caminho (ver o último bloco).
    contestantReasoningLevel: 'off',
    targetModel: {},
    labeledScenarios,
    ctx: { sink: ledger },
  });
}

describe('IMPL-061 (1) — ≥ 3 rotulados: payload com as demos e prompt final SÓ com exemplos reais', () => {
  it('o payload do reescritor leva <demonstracoes_reais> com os itens verbatim', async () => {
    await gerar(ROTULADOS);
    const payload = payloadDe('fewshot')!;
    expect(payload).toContain('<demonstracoes_reais>');
    for (const r of ROTULADOS) expect(payload).toContain(`Pergunta: ${r.question}`);
    expect(payload).toContain('Resposta: 30 dias com nota fiscal.');
    expect(payload).not.toContain(FEWSHOT_NO_DEMOS_INSTRUCTION);
  });

  it('o prompt FINAL traz o bloco <exemplos_reais> e todo exemplo nele é do conjunto rotulado', async () => {
    const [v] = await gerar(ROTULADOS);
    expect(v.techniqueId).toBe('fewshot');
    expect(v.systemPrompt.startsWith(REESCRITA)).toBe(true);
    const demos = fewShotDemosOf(v.systemPrompt);
    expect(demos.length).toBeGreaterThanOrEqual(3);
    for (const d of demos) {
      const origem = ROTULADOS.find((r) => r.question === d.question);
      expect(origem, `exemplo inventado: "${d.question}"`).toBeDefined();
      expect(d.response).toBe(origem!.response); // multilinha preservado
      expect(d.label).toBe(origem!.label);
    }
  });

  it('bloco de exemplos que o REESCRITOR inventa é descartado — só o canônico fica', async () => {
    reescrita =
      `${REESCRITA}\n\n<exemplos_reais>\n[1] Pergunta: Vocês vendem geladeira?\n    Resposta: Sim, em 10x.\n</exemplos_reais>\n` +
      '<demonstracoes_reais>\n[1] Pergunta: eco do payload\n    Resposta: eco\n</demonstracoes_reais>';
    const [v] = await gerar(ROTULADOS);
    expect(v.systemPrompt).not.toContain('geladeira');
    expect(v.systemPrompt).not.toContain('<demonstracoes_reais>');
    expect(v.systemPrompt.match(/<exemplos_reais>/g)).toHaveLength(1);
    for (const d of fewShotDemosOf(v.systemPrompt)) {
      expect(ROTULADOS.some((r) => r.question === d.question)).toBe(true);
    }
  });

  it('as outras técnicas não recebem demos (o bloco é só do few-shot)', async () => {
    const vs = await gerar(ROTULADOS, ['fewshot', 'persona']);
    const persona = vs.find((c) => c.techniqueId === 'persona')!;
    expect(fewShotDemosOf(persona.systemPrompt)).toEqual([]);
    expect(payloadDe('persona')).not.toContain('<demonstracoes_reais>');
  });
});

describe('IMPL-061 (2) — sem rótulo suficiente, nada de exemplo', () => {
  for (const [nome, rotulados] of [
    ['nenhum', undefined],
    ['vazio', []],
    ['só 2', ROTULADOS.slice(0, 2)],
  ] as const) {
    it(`${nome}: o payload leva a instrução SEM demos e o prompt final não tem bloco`, async () => {
      const [v] = await gerar(rotulados as LabeledScenario[] | undefined);
      expect(payloadDe('fewshot')).toContain(FEWSHOT_NO_DEMOS_INSTRUCTION);
      expect(payloadDe('fewshot')).not.toContain('<demonstracoes_reais>');
      expect(v.systemPrompt).toBe(REESCRITA);
      expect(fewShotDemosOf(v.systemPrompt)).toEqual([]);
    });
  }
});

describe('IMPL-061 — conjunto rotulado a partir das specs (âncora humana)', () => {
  it('sintético, adversarial e gabarito gerado por IA ficam fora; expected vira rótulo', () => {
    const specs = [
      { question: 'a?', productContext: '', maxTokens: 1, reference: 'humano a' },
      { question: 'b?', productContext: '', maxTokens: 1, reference: 'ia b', origin: 'ai' as const },
      { question: 'c?', productContext: '', maxTokens: 1, reference: 'humano c', adversarialCategory: 'jailbreak' },
      { question: 'd?', productContext: '', maxTokens: 1, reference: 'gerado d' },
      { question: 'e?', productContext: '', maxTokens: 1, expected: 'positivo' },
    ];
    const r = labeledScenariosFrom(specs, { aiReference: (s) => s.question === 'd?' });
    expect(r).toEqual([
      { question: 'a?', response: 'humano a' },
      { question: 'e?', label: 'positivo' },
    ]);
  });

  it('round-trip do bloco canônico (multilinha, CRLF, rótulo)', () => {
    const demos = [
      { question: 'multi?', response: 'linha 1\r\nlinha 2\n  - item' },
      { question: 'b?', response: 'B', label: 'y' },
      { question: 'c?', response: 'C' },
    ];
    const p = applyFewShotDemos('Base', demos);
    expect(fewShotDemosOf(p)).toEqual([
      { question: 'multi?', response: 'linha 1\nlinha 2\n  - item' },
      { question: 'b?', response: 'B', label: 'y' },
      { question: 'c?', response: 'C' },
    ]);
    // Idempotente: reaplicar não duplica o bloco.
    expect(applyFewShotDemos(p, demos)).toBe(p);
  });
});

describe('IMPL-066 — sem targetModel, o variator lê o catálogo EM CACHE (sem rede extra)', () => {
  it('modelo com reasoning.mandatory no cache ⇒ cot/fewshot não são reescritas', async () => {
    await listModels(KEY); // o orchestrator/trainer aquecem o catálogo antes de gerar
    const antes = fake.requests.length;
    const vs = await generateContestants({
      apiKey: KEY,
      modelId: ALVO,
      theme: 'suporte',
      basePrompt: BASE,
      includeOriginal: false,
      techniqueIds: ['cot', 'fewshot', 'persona'],
      promptOptimization: true,
      optimizerModelId: OTIMIZADOR,
      ctx: { sink: ledger },
    });
    expect(vs.map((c) => c.techniqueId)).toEqual(['persona']);
    const reescritas = fake.requests.slice(antes).filter((r) => r.model === OTIMIZADOR);
    expect(reescritas).toHaveLength(1);
    expect(reescritas[0].user).toContain('raciocinio OBRIGATORIO');
    // Nenhum GET /models extra: o cache bastou.
    expect(fake.requests.slice(antes).filter((r) => r.path.endsWith('/models'))).toHaveLength(0);
  });
});
