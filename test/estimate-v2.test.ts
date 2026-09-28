// IMPL-113 (R-08:REC-8) — estimativa v2: quantis empíricos POR PAPEL, predição
// CONFORMAL da faixa, previsão de `reasoning_tokens` por esforço × família,
// precificação da variante `:batch` (0,5x), tokenizer por classe na reserva e
// registo estimado × real (costAccuracy).
//
// Contratos provados aqui:
//  (i)   em ≥20 runs de calibração a faixa [low, high] cobre ≥ 90% do real e
//        `point` fica com mediana de |real-point|/real ≤ 25% e p90 ≤ 60%
//        (SIMULAÇÃO determinística com modelo de ruído documentado — sem runs
//        reais no CI, o que se prova é a maquinaria: quantis + conformal);
//  (ii)  preço "-1"/desconhecido NUNCA entra como valor negativo (nem como
//        amostra de calibração);
//  (iii) o teste REPROVA a volta de fator fixo hardcoded (o antigo `LOW_FACTOR`)
//        na faixa publicada: a faixa é por papel, anda com os dados e declara a
//        própria fonte em `assumptions.range`;
//  (iv)  `:batch` resolve contra o catálogo vivo a 0,5x do modelo base;
//  (v)   tokenizer por classe (≈4 chars/token inglês, ≈3 código, ≈1,5 CJK) e a
//        reserva dura leva margem ~20% (`RESERVE_TOKEN_MARGIN`);
//  (vi)  a previsão de raciocínio segue esforço × família com fallback no
//        budget declarado e nas referências effort↔budget 1.024/8.192/16.384.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BATCH_PRICE_FACTOR,
  CALIBRATION_TARGET_COVERAGE,
  CostCalibration,
  MIN_CELL_SAMPLES,
  REASONING_BUDGET_BY_EFFORT,
  REASONING_BUDGET_REF,
  conformalMargin,
  estimateRunCost,
  makeCallEstimator,
  quantile,
  reasoningBudgetRef,
  resolveModel,
  type EstimateInput,
} from '../src/estimate.js';
import { BudgetLedger } from '../src/budget.js';
import {
  RESERVE_TOKEN_MARGIN,
  computeCost,
  countTextTokens,
  createGateway,
  guessPromptTokens,
  modelFamilyOf,
  parseModelsPayload,
  peekCostSamples,
  resetCostSamples,
  setDefaultGateway,
  takeCostSamples,
  type ChatMessage,
  type CostCalibrationSample,
} from '../src/openrouter.js';
import type { CostSink, OpenRouterModel } from '../src/types.js';
import { fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-impl113-0000000000000000';
const raiz = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Infra: catálogo falso + RNG determinístico (simulação reproduzível)
// ---------------------------------------------------------------------------

const itemCatalogo = (id: string, prompt: number, completion: number): unknown => ({
  id,
  name: id,
  context_length: 128_000,
  pricing: { prompt, completion },
});

const CATALOGO: OpenRouterModel[] = parseModelsPayload({
  data: [itemCatalogo('fake/comp', 1e-6, 2e-6), itemCatalogo('fake/juiz', 3e-6, 6e-6)],
});

const entradaBase: EstimateInput = {
  mode: 'compare',
  plannedStages: 2,
  iterations: 1,
  contestantModelIds: ['fake/comp', 'fake/comp'],
  judgeModelIds: ['fake/juiz'],
  referenceJudging: true,
  duels: false,
  finalists: 0,
  maxOutputTokens: 1000,
  judgePasses: 1,
};

/** mulberry32 — RNG determinístico para a simulação (sem flakiness). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function amostra(parcial: Partial<CostCalibrationSample> & { role: CostCalibrationSample['role']; estimatedUsd: number; actualUsd: number }): CostCalibrationSample {
  return { modelId: 'fake/comp', family: 'fake/comp', ...parcial };
}

// ---------------------------------------------------------------------------
// (iii) Guarda: o fator fixo (LOW_FACTOR) não volta para a faixa publicada
// ---------------------------------------------------------------------------

describe('IMPL-113 (iii) — a faixa publicada não volta a ser `point × fator fixo`', () => {
  const fonte = readFileSync(join(raiz, 'src', 'estimate.ts'), 'utf-8');
  /** Código sem comentários — o texto em prosa cita o antigo LOW_FACTOR de propósito. */
  const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('não existe LOW_FACTOR nem `point * <literal>` na construção da faixa', () => {
    expect(codigo).not.toMatch(/LOW_FACTOR/);
    // Padrões da regressão condenada: fator fixo multiplicando o ponto/total.
    expect(codigo).not.toMatch(/low:\s*point\s*\*/);
    expect(codigo).not.toMatch(/point\s*\*\s*\d?\.?\d+\s*,/);
  });

  it('sem dados a faixa vem do PRIOR rotulado; com dados, dos quantis — e anda com eles', () => {
    const frio = estimateRunCost(entradaBase, CATALOGO);
    // Sem amostras: fonte declarada (nunca "empírico" sem dados) e low < high.
    expect(frio.assumptions.range.n).toBe(0);
    for (const r of Object.values(frio.assumptions.range.perRole)) {
      expect(r?.source).toBe('prior');
      expect(r?.low).toBeGreaterThan(0);
      expect(r?.low).toBeLessThan(1);
    }
    expect(frio.low).toBeGreaterThan(0);
    expect(frio.low).toBeLessThan(frio.high);

    // Com amostras: a faixa DEIXA de ser o prior e passa a andar com os dados.
    const altas = new CostCalibration(
      Array.from({ length: 20 }, () => amostra({ role: 'competitor', estimatedUsd: 0.01, actualUsd: 0.02 })),
    );
    const baixas = new CostCalibration(
      Array.from({ length: 20 }, () => amostra({ role: 'competitor', estimatedUsd: 0.02, actualUsd: 0.01 })),
    );
    const comAltas = estimateRunCost(entradaBase, CATALOGO, { calibration: altas });
    const comBaixas = estimateRunCost(entradaBase, CATALOGO, { calibration: baixas });
    expect(comAltas.point).toBeGreaterThan(frio.point * 1.2);
    expect(comBaixas.point).toBeLessThan(frio.point * 0.8);
    expect(comAltas.point).not.toBe(comBaixas.point);
    expect(comAltas.assumptions.range.perRole.competitor?.source).toBe('empirico');
  });
});

// ---------------------------------------------------------------------------
// Quantis por papel + faixa conformal
// ---------------------------------------------------------------------------

describe('IMPL-113 — quantis empíricos POR PAPEL (p10/p50/p90) na faixa', () => {
  it('cada papel tem a SUA distribuição: a faixa soma (teto × banda do papel)', () => {
    // competitor razão 0,5, juiz 0,9, gabarito 0,6 — 12 amostras cada.
    const cal = new CostCalibration([
      ...Array.from({ length: 12 }, () => amostra({ role: 'competitor', estimatedUsd: 0.02, actualUsd: 0.01 })),
      ...Array.from({ length: 12 }, () =>
        amostra({ role: 'judge', modelId: 'fake/juiz', family: 'fake/juiz', estimatedUsd: 0.02, actualUsd: 0.018 }),
      ),
      ...Array.from({ length: 12 }, () =>
        amostra({ role: 'gabarito', modelId: 'fake/juiz', family: 'fake/juiz', estimatedUsd: 0.02, actualUsd: 0.012 }),
      ),
    ]);
    const est = estimateRunCost(entradaBase, CATALOGO, { calibration: cal });
    const bandComp = cal.bandFor('competitor', { family: 'fake/comp' });
    const bandJuiz = cal.bandFor('judge', { family: 'fake/juiz' });
    const bandGab = cal.bandFor('gabarito', { family: 'fake/juiz' });
    expect(bandComp.point).toBeCloseTo(0.5, 10);
    expect(bandJuiz.point).toBeCloseTo(0.9, 10);
    expect(bandGab.point).toBeCloseTo(0.6, 10);
    // Razões constantes: os quantis colapsam e a margem conformal é zero.
    expect(bandComp.conformal).toBe(0);
    // O teto SEM calibração é a base: point calibrado = Σ teto_papel × razão_papel.
    const teto = estimateRunCost(entradaBase, CATALOGO);
    expect(est.point).toBeCloseTo(
      teto.byRole.competitor * 0.5 + teto.byRole.judge * 0.9 + teto.byRole.gabarito * 0.6,
      10,
    );
    expect(est.assumptions.range.perRole.gabarito?.source).toBe('empirico');
    expect(est.high).toBeGreaterThanOrEqual(est.point);
    expect(est.low).toBeLessThanOrEqual(est.point);
  });

  it('papéis com poucas amostras caem para o pool; sem amostras, prior', () => {
    // 3 amostras de competitor (abaixo de MIN_CELL_SAMPLES) + 20 de judge.
    const cal = new CostCalibration([
      ...Array.from({ length: 3 }, () => amostra({ role: 'competitor', estimatedUsd: 0.01, actualUsd: 0.03 })),
      ...Array.from({ length: 20 }, () =>
        amostra({ role: 'judge', modelId: 'fake/juiz', family: 'fake/juiz', estimatedUsd: 0.01, actualUsd: 0.005 }),
      ),
    ]);
    expect(3).toBeLessThan(MIN_CELL_SAMPLES);
    const qComp = cal.quantilesFor('competitor');
    expect(qComp.source).toBe('pool');
    expect(qComp.n).toBe(23);
    // Pool ainda cobre o papel sem amostras próprias…
    const qDatagen = cal.quantilesFor('datagen');
    expect(qDatagen.source).toBe('pool');
    expect(qDatagen.n).toBe(23);
    // …mas sem NENHUMA amostra na calibração é prior.
    const vazia = new CostCalibration();
    expect(vazia.quantilesFor('datagen', { family: 'x/y' }).source).toBe('prior');
  });

  it('predição conformal: a margem cobre as caudas do intervalo-base (correção finita)', () => {
    const rs = Array.from({ length: 21 }, (_, i) => 0.5 + i * 0.05); // 0.5..1.5
    const p10 = quantile(rs, 0.1);
    const p90 = quantile(rs, 0.9);
    const margem = conformalMargin(rs, p10, p90, CALIBRATION_TARGET_COVERAGE);
    expect(margem).toBeGreaterThan(0);
    // Cobertura alvo na própria calibração: pelo menos 90% dos valores dentro.
    const dentro = rs.filter((r) => r >= p10 - margem && r <= p90 + margem).length;
    expect(dentro / rs.length).toBeGreaterThanOrEqual(CALIBRATION_TARGET_COVERAGE);
    // Bandas conformalizadas envolvem o intervalo-base.
    const band = new CostCalibration(
      rs.map((r) => amostra({ role: 'judge', modelId: 'fake/juiz', estimatedUsd: 1, actualUsd: r })),
    ).bandFor('judge');
    expect(band.low).toBeCloseTo(Math.max(0, p10 - margem), 10);
    expect(band.high).toBeCloseTo(p90 + margem, 10);
  });
});

// ---------------------------------------------------------------------------
// (i) Critério de acabamento: ≥20 runs de calibração → cobertura ≥ 90%,
//     mediana de |real-point|/real ≤ 25%, p90 ≤ 60%
// ---------------------------------------------------------------------------

describe('IMPL-113 (i) — calibração com ≥20 runs: cobertura ≥ 90% e erro de point contido', () => {
  /**
   * SIMULAÇÃO determinística (modelo de ruído DOCUMENTADO — sem runs reais no
   * CI, o que se prova é a maquinaria de quantis + conformal):
   *   - cada chamada tem razão real/estimado lognormal (σ_chamada = 0,20);
   *   - cada run tem um viés próprio (σ_run = 0,15) que puxa todas as suas
   *     chamadas (é o que a calibração por papel tem de absorver);
   *   - 20 runs de calibração × 30 chamadas (2 papéis) treinam a faixa;
   *   - 60 runs de avaliação × 30 chamadas medem cobertura e erro.
   */
  const simular = (): {
    calibracao: CostCalibration;
    avaliacao: Array<{ role: 'competitor' | 'judge'; estimatedUsd: number; actualUsd: number }[]>;
  } => {
    const r = rng(113_2026);
    const gauss = (): number => {
      const u = Math.max(1e-9, r());
      const v = r();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const corridas = (n: number): Array<Array<{ role: 'competitor' | 'judge'; estimatedUsd: number; actualUsd: number }>> =>
      Array.from({ length: n }, () => {
        const viesRun = Math.exp(0.15 * gauss() - 0.15 * 0.15 * 0.5);
        return Array.from({ length: 30 }, (_, k) => {
          const role = k % 3 === 0 ? 'judge' : 'competitor';
          const estimatedUsd = 0.002 + 0.004 * r();
          const viesChamada = Math.exp(0.2 * gauss() - 0.2 * 0.2 * 0.5);
          return { role, estimatedUsd, actualUsd: estimatedUsd * viesRun * viesChamada };
        });
      });
    const calibracao = new CostCalibration(
      corridas(20).flatMap((chamadas) =>
        chamadas.map((c) => amostra({ ...c, family: c.role === 'judge' ? 'fake/juiz' : 'fake/comp' })),
      ),
    );
    return { calibracao, avaliacao: corridas(60) };
  };

  it('cobertura de [low, high] ≥ 90% dos runs, mediana ≤ 25% e p90 ≤ 60%', () => {
    const { calibracao, avaliacao } = simular();
    expect(calibracao.size).toBeGreaterThanOrEqual(20 * 30);

    const erros: number[] = [];
    let cobertos = 0;
    for (const chamadas of avaliacao) {
      let low = 0;
      let point = 0;
      let high = 0;
      let real = 0;
      for (const c of chamadas) {
        const band = calibracao.bandFor(c.role, {
          family: c.role === 'judge' ? 'fake/juiz' : 'fake/comp',
        });
        low += c.estimatedUsd * band.low;
        point += c.estimatedUsd * band.point;
        high += c.estimatedUsd * band.high;
        real += c.actualUsd;
      }
      if (real >= low && real <= high) cobertos += 1;
      erros.push(Math.abs(real - point) / real);
    }
    const cobertura = cobertos / avaliacao.length;
    const mediana = quantile(erros, 0.5);
    const p90 = quantile(erros, 0.9);
    expect(cobertura).toBeGreaterThanOrEqual(0.9);
    expect(mediana).toBeLessThanOrEqual(0.25);
    expect(p90).toBeLessThanOrEqual(0.6);
  });
});

// ---------------------------------------------------------------------------
// (ii) Preço "-1"/desconhecido nunca negativo
// ---------------------------------------------------------------------------

describe('IMPL-113 (ii) — preço desconhecido nunca vira valor negativo', () => {
  const roteador: OpenRouterModel[] = parseModelsPayload({
    data: [{ id: 'openrouter/auto', name: 'auto', context_length: 128_000, pricing: { prompt: -1, completion: -1 } }],
  });

  it('estimateRunCost: nada sai negativo e o roteador fica listado (nunca "grátis")', () => {
    for (const politica of ['exclude', 'worst-case'] as const) {
      const est = estimateRunCost(
        { ...entradaBase, contestantModelIds: ['openrouter/auto'], judgeModelIds: ['openrouter/auto'] },
        roteador,
        { unknownPrice: politica },
      );
      expect(est.point).toBeGreaterThanOrEqual(0);
      expect(est.low).toBeGreaterThanOrEqual(0);
      expect(est.high).toBeGreaterThanOrEqual(0);
      for (const v of Object.values(est.byRole)) expect(v).toBeGreaterThanOrEqual(0);
      expect(est.unknownPriceModelIds).toContain('openrouter/auto');
    }
  });

  it('a calibração NÃO aceita estimado ≤ 0 nem real negativo como amostra', () => {
    const cal = new CostCalibration();
    cal.add(amostra({ role: 'judge', estimatedUsd: -1, actualUsd: 0.01 }));
    cal.add(amostra({ role: 'judge', estimatedUsd: 0, actualUsd: 0.01 }));
    cal.add(amostra({ role: 'judge', estimatedUsd: 0.01, actualUsd: -0.5 }));
    expect(cal.size).toBe(0);
    cal.add(amostra({ role: 'judge', estimatedUsd: 0.01, actualUsd: 0.02 }));
    expect(cal.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (iv) Variante ':batch' — 0,5x do modelo base, resolvida no catálogo vivo
// ---------------------------------------------------------------------------

describe('IMPL-113 (iv) — `:batch` precifica a 0,5x do modelo base', () => {
  const idx = new Map(CATALOGO.map((m) => [m.id, m]));

  it('resolveModel: slug `:batch` resolve pelo id base com preços pela metade', () => {
    const base = resolveModel(idx, 'fake/comp')!;
    const lote = resolveModel(idx, 'fake/comp:batch')!;
    expect(lote.id).toBe('fake/comp:batch');
    expect(lote.pricing.prompt).toBeCloseTo(base.pricing.prompt! * BATCH_PRICE_FACTOR, 12);
    expect(lote.pricing.completion).toBeCloseTo(base.pricing.completion! * BATCH_PRICE_FACTOR, 12);
    expect(BATCH_PRICE_FACTOR).toBe(0.5);
    // Slug sem base continua imprecificável (nunca 0 silencioso).
    expect(resolveModel(idx, 'sumiu/x:batch')).toBeUndefined();
  });

  it('estimateRunCost e makeCallEstimator precificam o `:batch` pela metade', () => {
    const estBase = estimateRunCost(
      { ...entradaBase, contestantModelIds: ['fake/comp', 'fake/comp'] },
      CATALOGO,
    );
    const estLote = estimateRunCost(
      { ...entradaBase, contestantModelIds: ['fake/comp:batch', 'fake/comp:batch'] },
      CATALOGO,
    );
    expect(estLote.byRole.competitor).toBeCloseTo(estBase.byRole.competitor * BATCH_PRICE_FACTOR, 12);
    expect(estLote.unpricedModelIds).toEqual([]);

    const estimateCall = makeCallEstimator(CATALOGO);
    expect(estimateCall('fake/comp:batch', 1000, 500)).toBeCloseTo(
      estimateCall('fake/comp', 1000, 500) * BATCH_PRICE_FACTOR,
      12,
    );
  });
});

// ---------------------------------------------------------------------------
// (v) Tokenizer por classe + margem ~20% na reserva dura
// ---------------------------------------------------------------------------

describe('IMPL-113 (v) — tokenizer por classe e margem da reserva dura', () => {
  const ingles =
    'The quick brown fox jumps over the lazy dog and then runs away into the forest where nobody can find it again.';
  const codigo = JSON.stringify({ nome: 'pedido', itens: [{ sku: 'A-1', qtd: 2 }, { sku: 'B-2', qtd: 5 }], total: 7 });
  const cjk = '这是一个测试句子用来估算中文文本的令牌数量非常感谢您的耐心等待我们马上开始处理您的请求';

  it('≈4 chars/token em inglês, ≈3 em código/JSON e ≈1,5 em CJK (chars/4 puro errava)', () => {
    const tIngl = countTextTokens(ingles);
    const tCod = countTextTokens(codigo);
    const tCjk = countTextTokens(cjk);
    expect(ingles.length / tIngl).toBeGreaterThan(3.4);
    expect(ingles.length / tIngl).toBeLessThan(4.6);
    expect(codigo.length / tCod).toBeGreaterThan(2.3);
    expect(codigo.length / tCod).toBeLessThan(3.8);
    expect(cjk.length / tCjk).toBeGreaterThan(1.3);
    expect(cjk.length / tCjk).toBeLessThan(1.7);
    // O CJK SEM tokenizer (chars/4) subestimava ~60% — a nova régua enxerga.
    expect(tCjk).toBeGreaterThan(Math.ceil(cjk.length / 4) * 1.5);
  });

  it('guessPromptTokens = tokenizer sem margem; a reserva dura leva +20%', async () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'Você é um avaliador.' },
      { role: 'user', content: codigo },
    ];
    expect(guessPromptTokens(msgs)).toBe(countTextTokens(msgs.map((m) => m.content).join('\n')));
    expect(RESERVE_TOKEN_MARGIN).toBeGreaterThan(1.15);
    expect(RESERVE_TOKEN_MARGIN).toBeLessThanOrEqual(1.3);

    // Comportamental: o que a PORTA DURA reserva é o tokenizer × margem.
    const fake = fakeOpenRouter({
      catalog: [itemCatalogo('fake/comp', 1e-6, 2e-6)],
      chat: () => ({ text: 'ok', usage: { prompt_tokens: 10, completion_tokens: 5, cost: 1e-5 } }),
    });
    const anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    const ledger = new BudgetLedger();
    const reservas: number[] = [];
    const sink: CostSink = {
      reserve: (role, model, promptTokens, maxTokens, fallback) => {
        reservas.push(promptTokens);
        return ledger.reserve(role, model, promptTokens, maxTokens, fallback);
      },
      note: (r, e) => ledger.note(r, e),
      pending: (r, e) => ledger.pending(r, e),
    };
    try {
      const { chatCompletion } = await import('../src/openrouter.js');
      await chatCompletion({
        apiKey: KEY,
        modelId: 'fake/comp',
        messages: msgs,
        maxTokens: 100,
        role: 'competitor',
        sink,
      });
    } finally {
      setDefaultGateway(anterior);
    }
    expect(reservas).toEqual([Math.ceil(guessPromptTokens(msgs) * RESERVE_TOKEN_MARGIN)]);
    expect(reservas[0]).toBeGreaterThan(guessPromptTokens(msgs));
  });
});

// ---------------------------------------------------------------------------
// Registo estimado × real (costAccuracy) e previsão de raciocínio (vi)
// ---------------------------------------------------------------------------

describe('IMPL-113 — registo estimado × real por chamada e previsão de raciocínio', () => {
  beforeEach(() => resetCostSamples());
  afterEach(() => resetCostSamples());

  it('chamada medida regista o par (estimado, real) com esforço/família/tokens; a não medida não regista', async () => {
    const fake = fakeOpenRouter({
      catalog: [itemCatalogo('fake/juiz', 3e-6, 6e-6)],
      chat: (req, n) =>
        n === 0
          ? {
              text: 'resolve',
              usage: {
                prompt_tokens: 100,
                completion_tokens: 40,
                cost: 0.002,
                completion_tokens_details: { reasoning_tokens: 12 },
              },
            }
          : { text: 'sem usage', usage: null },
    });
    const anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    try {
      const gw = await import('../src/openrouter.js');
      await gw.getGateway().listModels(KEY); // catálogo em cache: o "estimado" vem dele
      await gw.chatCompletion({
        apiKey: KEY,
        modelId: 'fake/juiz',
        messages: [{ role: 'user', content: 'julgue' }],
        maxTokens: 512,
        reasoningLevel: 'high',
        role: 'judge',
      });
      await gw.chatCompletion({
        apiKey: KEY,
        modelId: 'fake/juiz',
        messages: [{ role: 'user', content: 'julgue de novo' }],
        maxTokens: 512,
        role: 'judge',
      });
    } finally {
      setDefaultGateway(anterior);
    }
    const amostras = takeCostSamples();
    expect(amostras).toHaveLength(1); // só a chamada com `usage.cost` medido
    const a = amostras[0];
    expect(a.role).toBe('judge');
    expect(a.actualUsd).toBe(0.002);
    // Estimado = a MESMA conta da reserva (catálogo), SEM margem (honesto).
    const estimado = computeCost(guessPromptTokens([{ role: 'user', content: 'julgue' }]), 512, {
      id: 'fake/juiz',
      name: 'fake/juiz',
      pricing: { prompt: 3e-6, completion: 6e-6 },
    } as OpenRouterModel);
    expect(a.estimatedUsd).toBeCloseTo(estimado!, 12);
    expect(a.family).toBe('fake/juiz');
    expect(a.reasoningTokens).toBe(12);
    expect(a.capTokens).toBe(512);
    expect(peekCostSamples()).toHaveLength(0); // drenado por `takeCostSamples`
  });

  it('previsão de raciocínio: esforço × família > budget declarado > referências 1.024/8.192/16.384', () => {
    // Referências effort↔budget (âncoras do R-08:REC-8).
    expect(REASONING_BUDGET_REF).toEqual({ low: 1024, medium: 8192, high: 16384 });
    expect(reasoningBudgetRef('low')).toBe(1024);
    expect(reasoningBudgetRef('medium')).toBe(8192);
    expect(reasoningBudgetRef('high')).toBe(16384);
    expect(REASONING_BUDGET_BY_EFFORT.low).toBe(REASONING_BUDGET_REF.low);
    expect(REASONING_BUDGET_BY_EFFORT.medium).toBe(REASONING_BUDGET_REF.medium);
    expect(REASONING_BUDGET_BY_EFFORT.high).toBe(REASONING_BUDGET_REF.high);

    const cal = new CostCalibration();
    // Sem dados: referência por degrau…
    expect(cal.reasoningTokensFor('low', 'anthropic/claude')).toMatchObject({ tokens: 1024, source: 'referencia' });
    // …com budget declarado do provedor: o declarado manda…
    expect(cal.reasoningTokensFor('low', 'anthropic/claude', 2048)).toMatchObject({
      tokens: 2048,
      source: 'declarado',
    });
    // …e com amostras da célula (esforço × família): a mediana empírica vence TUDO.
    for (let i = 0; i < 4; i++) {
      cal.add(
        amostra({
          role: 'judge',
          modelId: 'anthropic/claude-3.5-sonnet',
          family: modelFamilyOf('anthropic/claude-3.5-sonnet'),
          effort: 'low',
          estimatedUsd: 0.01,
          actualUsd: 0.01,
          reasoningTokens: 5000 + i * 10,
        }),
      );
    }
    expect(cal.reasoningTokensFor('low', 'anthropic/claude', 2048)).toMatchObject({
      tokens: 5015,
      source: 'empirico',
      n: 4,
    });
    // Família NÃO vaza: mesma esforço, família diferente cai no fallback (sem
    // mediana alheia — budget de raciocínio é do provedor).
    expect(cal.reasoningTokensFor('low', 'openai/gpt')).toMatchObject({ tokens: 1024, source: 'referencia' });
    expect(cal.reasoningTokensFor('low', 'openai/gpt', 2048)).toMatchObject({ tokens: 2048, source: 'declarado' });
  });
});