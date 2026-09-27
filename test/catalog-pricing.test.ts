// IMPL-018 (R-07b:REC-7 / DEC-7) — preço "-1" do catálogo e contrato do /models.
//
// Contratos:
//  (i)   preço "-1" (ou ausente/inválido/negativo/não finito) vira DESCONHECIDO
//        (`null`): nunca produz valor negativo em computeCost/priceUsage/
//        estimateRunCost/makeCallEstimator, nunca vira "grátis" e a reserva da
//        porta dura cobre o pior caso dos endpoints elegíveis;
//  (ii)  `models --json` exporta 'unknown' (formato @2) e a UI/CLI mostram
//        "variável" — nunca "-1";
//  (iii) mudança em supported_efforts/mandatory de modelo usado em run reprova
//        o teste de contrato do snapshot (baseline versionada + diff).
// Mais: validação fail-open (warn) para campos não contratuais e fail-closed
// (error) para o que muda o fio — e o gateway respeita o fail-closed no corpo.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  catalogDeniesReasoning,
  computeCost,
  createGateway,
  parseModelsPayload,
  priceUsage,
  setDefaultGateway,
  validateModelsPayload,
} from '../src/openrouter.js';
import {
  classifyPrice,
  formatPricePerMTok,
  formatPricingLabel,
  isFreePricing,
  isKnownPrice,
  parsePrice,
  priceTokens,
  priceTokensOrWorst,
  withinMaxPricePerMTok,
  worstCasePricing,
} from '../src/engine/pricing.js';
import { estimateRunCost, makeCallEstimator, priceCall, type EstimateInput } from '../src/estimate.js';
import { MODELS_EXPORT_FORMAT, modelCaps, toExportRow } from '../src/modelCaps.js';
import { BudgetLedger, isControlSignal } from '../src/budget.js';
import { catalogPath, ensureCatalog } from '../src/modelsCache.js';
import { setDataDir, getDataDir } from '../src/storage.js';
import { cmdModels } from '../src/cli/commands/models.js';
import {
  buildCatalogContract,
  CATALOG_CONTRACT_FORMAT,
  diffCatalogContract,
  parseCatalogContract,
  runModelIds,
  type CatalogContract,
} from '../src/engine/catalogContract.js';
import type { OpenRouterModel, RunConfig } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-impl018-000000';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Item cru de roteador, como o /models real manda (medido em 2026-09-27). */
function routerItem(id = 'openrouter/auto', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    context_length: 2_000_000,
    pricing: { prompt: '-1', completion: '-1' },
    supported_parameters: ['temperature', 'seed', 'max_tokens', 'reasoning', 'reasoning_effort'],
    ...extra,
  };
}

/** Modelo de raciocínio com allowlist (formato do /models). */
function reasoningItem(
  id: string,
  prompt: number,
  completion: number,
  reasoning: Record<string, unknown>,
  supported = ['max_tokens', 'reasoning', 'reasoning_effort', 'include_reasoning', 'response_format'],
): Record<string, unknown> {
  return catalogItem(id, prompt, completion, { supported_parameters: supported, reasoning });
}

const CATALOGO_CRU = [
  catalogItem('a/barato', 1e-7, 4e-7),
  catalogItem('a/caro', 5e-6, 2e-5),
  reasoningItem('o/raciocina', 2.5e-7, 2e-6, {
    mandatory: true,
    supported_efforts: ['high', 'medium', 'low', 'minimal'],
    default_effort: 'medium',
  }),
  routerItem(),
  routerItem('openrouter/fusion', { supported_parameters: [] }),
];

const catalogo = (): OpenRouterModel[] => parseModelsPayload({ data: CATALOGO_CRU });

function inputCom(ids: Partial<EstimateInput>): EstimateInput {
  return {
    mode: 'compare',
    plannedStages: 4,
    iterations: 1,
    contestantModelIds: ['a/barato'],
    judgeModelIds: ['a/barato'],
    referenceJudging: true,
    duels: true,
    finalists: 3,
    maxOutputTokens: 800,
    judgePasses: 1,
    ...ids,
  };
}

const todosOsNumeros = (v: unknown): number[] => {
  const out: number[] = [];
  const walk = (x: unknown): void => {
    if (typeof x === 'number') out.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  walk(v);
  return out;
};

// ---------------------------------------------------------------------------

describe('IMPL-018 — parse de preço: "-1" e lixo viram desconhecido, nunca número negativo', () => {
  it('"-1" é o sentinela de preço variável (sem alerta); lixo é inválido (com alerta)', () => {
    expect(classifyPrice('-1')).toEqual({ price: null, kind: 'variable' });
    expect(classifyPrice(-1)).toEqual({ price: null, kind: 'variable' });
    for (const lixo of ['-0.5', '-2', 'abc', 'NaN', 'Infinity', '-Infinity', {}, [], true]) {
      expect(classifyPrice(lixo), JSON.stringify(lixo)).toMatchObject({ price: null, kind: 'invalid' });
    }
    for (const ausente of [undefined, null, '', '   ']) {
      expect(classifyPrice(ausente)).toEqual({ price: null, kind: 'missing' });
    }
    expect(parsePrice('0')).toBe(0);
    expect(Object.is(parsePrice('-0'), 0)).toBe(true); // -0 normalizado
    expect(parsePrice('0.0000025')).toBeCloseTo(2.5e-6, 12);
  });

  it('roteador do catálogo: preço base e faixas "-1" viram null (a faixa NÃO é descartada)', () => {
    const [m] = parseModelsPayload({
      data: [
        routerItem('x/roteado', {
          pricing: {
            prompt: '-1',
            completion: '-1',
            overrides: [{ min_prompt_tokens: 200_000, prompt: '-1', completion: '0.00001' }],
          },
        }),
      ],
    });
    expect(m.pricing.prompt).toBeNull();
    expect(m.pricing.completion).toBeNull();
    expect(m.pricing.overrides).toEqual([{ minPromptTokens: 200_000, prompt: null, completion: 1e-5 }]);
  });

  it('isKnownPrice blinda também records/caches antigos que guardaram -1 numérico', () => {
    expect(isKnownPrice(-1)).toBe(false);
    expect(isKnownPrice(Number.NaN)).toBe(false);
    expect(isKnownPrice(null)).toBe(false);
    expect(isKnownPrice(undefined)).toBe(false);
    expect(isKnownPrice(0)).toBe(true);
  });
});

describe('IMPL-018 (i) — "-1" nunca produz valor negativo em computeCost/estimateRunCost', () => {
  const models = catalogo();
  const router = models.find((m) => m.id === 'openrouter/auto')!;

  it('computeCost/priceCall: roteador => null (impossível precificar), nunca negativo', () => {
    // Zero token dos dois lados não depende de preço nenhum: 0, não null.
    expect(computeCost(0, 0, router)).toBe(0);
    for (const [tin, tout] of [
      [0, 1],
      [1, 0],
      [1, 1],
      [500, 800],
      [1_000_000, 50_000],
    ]) {
      expect(computeCost(tin, tout, router)).toBeNull();
      expect(priceCall(router, tin, tout)).toBeNull();
    }
    // Antes: 500 * -1 + 800 * -1 = -1300.
    expect(computeCost(500, 800, models.find((m) => m.id === 'a/barato'))).toBeCloseTo(500 * 1e-7 + 800 * 4e-7, 12);
    expect(computeCost(10, 10, undefined)).toBeNull();
  });

  it('priceUsage: usage.cost medido prevalece; sem ele, roteador é "unknown" (não catalog negativo)', () => {
    expect(priceUsage({ tokensIn: 500, tokensOut: 800, cost: 0.0123 }, router)).toEqual({
      usd: 0.0123,
      source: 'usage',
      upstreamUsd: undefined,
    });
    expect(priceUsage({ tokensIn: 500, tokensOut: 800 }, router)).toEqual({ usd: 0, source: 'unknown' });
  });

  it('priceTokens: lado com 0 token não depende do preço daquele lado; lado desconhecido com tokens => null', () => {
    const meio = { prompt: 1e-6, completion: null };
    expect(priceTokens(meio, 100, 0)).toBeCloseTo(1e-4, 12);
    expect(priceTokens(meio, 100, 1)).toBeNull();
    expect(priceTokens({ prompt: 1e-6, completion: 1e-6 }, -5, -5)).toBe(0); // tokens negativos não geram crédito
  });

  it('estimateRunCost (exclude, default): roteador fica FORA da soma, listado, e nada sai negativo', () => {
    const base = estimateRunCost(inputCom({}), models);
    const comRoteador = estimateRunCost(
      inputCom({
        contestantModelIds: ['a/barato', 'openrouter/auto'],
        judgeModelIds: ['a/barato', 'openrouter/auto'],
        datagenModelId: 'openrouter/auto',
        referenceModelId: 'openrouter/auto',
        optimizerModelId: 'openrouter/auto',
        variantsPerIteration: 2,
      }),
      models,
    );
    expect(comRoteador.unknownPriceModelIds).toEqual(['openrouter/auto']);
    expect(comRoteador.unpricedModelIds).toEqual([]);
    expect(comRoteador.assumptions.unknownPrice).toBe('exclude');
    for (const n of todosOsNumeros(comRoteador)) expect(Number.isFinite(n) && n >= 0, String(n)).toBe(true);
    // A parte precificável continua lá (não zera tudo), e o roteador não "barateia" nada.
    expect(comRoteador.point).toBeGreaterThan(0);
    expect(comRoteador.byRole.competitor).toBeCloseTo(base.byRole.competitor, 12);
    expect(comRoteador.byRole.datagen).toBe(0);
    expect(comRoteador.byRole.gabarito).toBe(0);
  });

  it('estimateRunCost (worst-case): roteador entra pelo pior caso do catálogo, limitado pelo teto da run', () => {
    const input = inputCom({ contestantModelIds: ['openrouter/auto'], judgeModelIds: ['a/barato'] });
    const exclude = estimateRunCost(input, models);
    const pior = estimateRunCost(input, models, { unknownPrice: 'worst-case' });
    expect(pior.assumptions.unknownPrice).toBe('worst-case');
    expect(pior.unknownPriceModelIds).toEqual(['openrouter/auto']);
    // 4 cenários × (500 in × 5e-6 + 800 out × 2e-5) — o modelo mais caro do catálogo.
    expect(pior.byRole.competitor).toBeCloseTo(4 * (500 * 5e-6 + 800 * 2e-5), 12);
    expect(exclude.byRole.competitor).toBe(0);
    expect(pior.point).toBeGreaterThan(exclude.point);

    const capped = estimateRunCost(
      { ...input, maxPricePerMTok: { prompt: 1, completion: 2 } },
      models,
      { unknownPrice: 'worst-case' },
    );
    expect(capped.byRole.competitor).toBeCloseTo(4 * (500 * 1e-6 + 800 * 2e-6), 12);
    for (const n of todosOsNumeros(capped)) expect(n >= 0).toBe(true);
  });

  it('makeCallEstimator: reserva do roteador = pior caso (>0), nunca a reserva NEGATIVA de antes', () => {
    const est = makeCallEstimator(models);
    expect(est('openrouter/auto', 500, 1000)).toBeCloseTo(500 * 5e-6 + 1000 * 2e-5, 12);
    expect(est('a/barato', 500, 1000)).toBeCloseTo(500 * 1e-7 + 1000 * 4e-7, 12);
    expect(est('fora/do-catalogo', 500, 1000)).toBe(0);
    const comTeto = makeCallEstimator(models, { maxPricePerMTok: { prompt: 0.5, completion: 1 } });
    expect(comTeto('openrouter/auto', 1_000_000, 1_000_000)).toBeCloseTo(0.5 + 1, 9);
  });

  it('porta dura: com roteador a reserva APERTA o orçamento (antes afrouxava a cada chamada)', () => {
    const ledger = new BudgetLedger({ budgetUsd: 0.05, estimateCall: makeCallEstimator(models) });
    // Pior caso de 1000 in + 2000 out = 0.005 + 0.04 = 0.045 <= 0.05: cabe UMA.
    const r1 = ledger.reserve('competitor', 'openrouter/auto', 1000, 2000);
    let erro: unknown;
    try {
      ledger.reserve('competitor', 'openrouter/auto', 1000, 2000);
    } catch (e) {
      erro = e;
    }
    expect(isControlSignal(erro)).toBe(true);
    r1.release();
    expect(() => ledger.reserve('competitor', 'openrouter/auto', 1000, 2000).release()).not.toThrow();
  });

  it('worstCasePricing/priceTokensOrWorst: lado conhecido usa o próprio preço; sem nada para limitar => null', () => {
    expect(worstCasePricing(models)).toEqual({ prompt: 5e-6, completion: 2e-5 });
    expect(worstCasePricing([], { prompt: 3 })).toBeNull();
    expect(worstCasePricing([], { prompt: 3, completion: 6 })).toEqual({ prompt: 3e-6, completion: 6e-6 });
    const meio = { prompt: 1e-6, completion: null };
    expect(priceTokensOrWorst(meio, 100, 100, { prompt: 9, completion: 2e-5 })).toBeCloseTo(100 * 1e-6 + 100 * 2e-5, 12);
    expect(priceTokensOrWorst(meio, 100, 100, null)).toBeNull();
  });

  it('fuzz: nenhum valor cru de preço produz custo/estimativa/reserva negativos ou não finitos', () => {
    const crus: unknown[] = ['-1', -1, '-0.000001', 'abc', '', null, undefined, 'Infinity', '1e-6', '0', 7e-7];
    for (const p of crus) {
      for (const c of crus) {
        const [m] = parseModelsPayload({
          data: [{ id: 'f/uzz', name: 'f', pricing: { prompt: p, completion: c }, supported_parameters: [] }],
        });
        const custo = computeCost(321, 654, m);
        expect(custo === null || (Number.isFinite(custo) && custo >= 0)).toBe(true);
        const e = estimateRunCost(inputCom({ contestantModelIds: ['f/uzz'], judgeModelIds: ['f/uzz'] }), [m]);
        for (const n of todosOsNumeros(e)) expect(Number.isFinite(n) && n >= 0).toBe(true);
        const r = makeCallEstimator([m])('f/uzz', 500, 800);
        expect(Number.isFinite(r) && r >= 0).toBe(true);
      }
    }
  });
});

describe('IMPL-018 (ii) — export e UI mostram "unknown"/"variável", nunca "-1"', () => {
  const models = catalogo();
  const router = models.find((m) => m.id === 'openrouter/auto')!;

  it('toExportRow: preço desconhecido sai como "unknown" (formato @2)', () => {
    expect(MODELS_EXPORT_FORMAT).toBe('prompt-builder-models@2');
    const row = toExportRow(router);
    expect(row.pricing).toEqual({ prompt: 'unknown', completion: 'unknown', unit: 'usd-per-token' });
    expect(row.pricePerMTok).toEqual({ prompt: 'unknown', completion: 'unknown' });
    const barato = toExportRow(models.find((m) => m.id === 'a/barato')!);
    expect(barato.pricePerMTok.prompt).toBeCloseTo(0.1, 9);
  });

  it('rótulos da UI/CLI: "preço variável" / "variável" — sem "-1" nem valor negativo', () => {
    expect(formatPricingLabel(router.pricing)).toBe('preço variável');
    expect(formatPricePerMTok(null)).toBe('variável');
    expect(formatPricePerMTok(-1 as unknown as number)).toBe('variável'); // cache antigo
    expect(formatPricingLabel({ prompt: 1e-6, completion: null })).toBe('in $1.00 / out variável /1M');
    expect(formatPricingLabel(models.find((m) => m.id === 'a/caro')!.pricing)).toBe('in $5.00 / out $20.00 /1M');
  });

  it('filtros: desconhecido não passa em teto de preço nem conta como grátis', () => {
    expect(withinMaxPricePerMTok(router.pricing.prompt, 1_000_000)).toBe(false);
    expect(withinMaxPricePerMTok(1e-7, 0.1)).toBe(true);
    expect(isFreePricing(router.pricing)).toBe(false);
    expect(isFreePricing({ prompt: 0, completion: 0 })).toBe(true);
  });

  describe('`models list --json` de ponta a ponta (gateway falso, sem rede)', () => {
    let dir: string;
    let prevDataDir: string;
    let restore: ReturnType<typeof setDefaultGateway> | undefined;
    const capturar = (): { out: string[]; spies: Array<{ mockRestore(): void }> } => {
      const out: string[] = [];
      const s1 = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        out.push(String(chunk));
        return true;
      });
      const s2 = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      return { out, spies: [s1, s2] };
    };

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'pb-impl018-'));
      prevDataDir = getDataDir();
      const fake = fakeOpenRouter({ catalog: CATALOGO_CRU });
      restore = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    });
    afterEach(() => {
      if (restore) setDefaultGateway(restore);
      setDataDir(prevDataDir);
      rmSync(dir, { recursive: true, force: true });
    });

    it('snapshot do export: roteadores com "unknown", nenhum "-1" nem número negativo', async () => {
      const { out, spies } = capturar();
      try {
        const code = await cmdModels(['list', '--json', '--key', KEY, '--data-dir', dir, '--refresh-models']);
        expect(code).toBe(0);
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
      const texto = out.join('');
      const payload = JSON.parse(texto) as { format: string; data: Array<Record<string, unknown>> };
      expect(payload.format).toBe('prompt-builder-models@2');
      const auto = payload.data.find((r) => r.id === 'openrouter/auto')!;
      expect(auto.pricing).toEqual({ prompt: 'unknown', completion: 'unknown', unit: 'usd-per-token' });
      expect(auto.pricePerMTok).toEqual({ prompt: 'unknown', completion: 'unknown' });
      expect(texto).not.toMatch(/-1\b/);
      for (const n of todosOsNumeros(payload.data.map((r) => [r.pricing, r.pricePerMTok]))) {
        expect(n).toBeGreaterThanOrEqual(0);
      }
    });

    it('--max-prompt-price e --free excluem o roteador (antes o -1 passava em qualquer teto)', async () => {
      const ids = async (extra: string[]): Promise<string[]> => {
        const { out, spies } = capturar();
        try {
          await cmdModels(['list', '--format', 'ids', '--key', KEY, '--data-dir', dir, ...extra]);
        } finally {
          spies.forEach((s) => s.mockRestore());
        }
        return out.join('').trim().split('\n').filter(Boolean);
      };
      const comTeto = await ids(['--max-prompt-price', '1000000']);
      expect(comTeto).toContain('a/caro');
      expect(comTeto).not.toContain('openrouter/auto');
      expect(await ids(['--free'])).toEqual([]);
    });

    it('tabela de texto mostra "variável" no lugar do preço do roteador', async () => {
      const { out, spies } = capturar();
      try {
        await cmdModels(['show', 'openrouter/auto', '--key', KEY, '--data-dir', dir]);
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
      const texto = out.join('');
      expect(texto).toContain('in variável / out variável por 1M tokens');
      expect(texto).not.toContain('-1');
    });

    it('cache v1 em disco com -1 numérico é saneado na leitura (modo offline não ressuscita o -1)', async () => {
      setDataDir(dir);
      const alvo = catalogPath(KEY);
      mkdirSync(dirname(alvo), { recursive: true });
      const legado = catalogo().map(({ raw: _raw, ...m }) =>
        m.id === 'openrouter/auto'
          ? { ...m, pricing: { prompt: -1, completion: -1, overrides: [{ minPromptTokens: 1, prompt: -1, completion: 2e-6 }] } }
          : m,
      );
      writeFileSync(
        alvo,
        JSON.stringify({ v: 1, fetchedAt: Date.now(), base: 'https://openrouter.ai/api/v1', count: legado.length, data: legado }),
      );
      const cat = await ensureCatalog(KEY);
      expect(cat.source).toBe('disk');
      const auto = cat.models.find((m) => m.id === 'openrouter/auto')!;
      expect(auto.pricing).toEqual({
        prompt: null,
        completion: null,
        overrides: [{ minPromptTokens: 1, prompt: null, completion: 2e-6 }],
      });
    });
  });
});

describe('IMPL-018 — validação do /models: fail-open (warn) × fail-closed (error)', () => {
  it('campos não contratuais ruins seguem com alerta warn; o modelo continua utilizável', () => {
    const { models, issues } = validateModelsPayload({
      data: [
        { id: 'w/preco', name: 'w', pricing: { prompt: 'abc', completion: '' }, context_length: 'muito' },
        { id: 'w/sem-preco', name: 'w' },
        routerItem(),
      ],
    });
    expect(models.map((m) => m.id)).toEqual(['w/preco', 'w/sem-preco', 'openrouter/auto']);
    expect(models[0].pricing).toMatchObject({ prompt: null, completion: null });
    expect(models[0].contextLength).toBeUndefined();
    expect(issues.every((i) => i.severity === 'warn')).toBe(true);
    const campos = issues.map((i) => `${i.modelId} ${i.field}`);
    expect(campos).toEqual(
      expect.arrayContaining([
        'w/preco pricing.prompt',
        'w/preco pricing.completion',
        'w/preco context_length',
        'w/sem-preco pricing',
      ]),
    );
    // "-1" é o sentinela documentado do roteador: sem ruído.
    expect(issues.some((i) => i.modelId === 'openrouter/auto')).toBe(false);
  });

  it('supported_parameters malformado => [] (nada opcional no fio) com alerta error', () => {
    const { models, issues } = validateModelsPayload({
      data: [
        catalogItem('c/string', 1e-6, 1e-6, { supported_parameters: 'temperature' }),
        catalogItem('c/misto', 1e-6, 1e-6, { supported_parameters: ['temperature', 42] }),
        catalogItem('c/ausente', 1e-6, 1e-6, { supported_parameters: undefined }),
      ],
    });
    expect(models[0].supportedParameters).toEqual([]);
    expect(models[1].supportedParameters).toEqual([]);
    expect(models[2].supportedParameters).toBeUndefined(); // ausente = desconhecido (heurística), não fail-closed
    expect(issues.filter((i) => i.severity === 'error').map((i) => i.modelId)).toEqual(['c/string', 'c/misto']);
    expect(modelCaps(models[0])).toMatchObject({ temperature: false, reasoning: false, effort: false });
  });

  it('allowlist de esforço malformada => capacidade de raciocínio removida (error); mandatory não booleano => true', () => {
    const { models, issues } = validateModelsPayload({
      data: [
        reasoningItem('r/allow-ruim', 1e-6, 1e-6, { mandatory: false, supported_efforts: 'high' }),
        reasoningItem('r/mandatory-ruim', 1e-6, 1e-6, { mandatory: 'sim', supported_efforts: ['high', 'low'] }),
        reasoningItem('r/objeto-ruim', 1e-6, 1e-6, ['nao', 'e', 'objeto'] as unknown as Record<string, unknown>),
      ],
    });
    const [allow, mand, obj] = models;
    expect(allow.reasoning).toBeUndefined();
    expect(allow.supportedParameters).toEqual(['max_tokens', 'response_format']);
    expect(catalogDeniesReasoning(allow)).toBe(true);
    expect(modelCaps(allow)).toMatchObject({ reasoning: false, effort: false });
    expect(mand.reasoning).toMatchObject({ mandatory: true, supportedEfforts: ['high', 'low'] });
    expect(obj.reasoning).toBeUndefined();
    expect(catalogDeniesReasoning(obj)).toBe(true);
    expect(issues.filter((i) => i.severity === 'error').map((i) => `${i.modelId} ${i.field}`)).toEqual([
      'r/allow-ruim reasoning.supported_efforts',
      'r/mandatory-ruim reasoning.mandatory',
      'r/objeto-ruim reasoning',
    ]);
  });

  it('item sem id é descartado (error); gateway expõe os alertas da última busca', async () => {
    const fake = fakeOpenRouter({
      catalog: [{ name: 'sem id' }, catalogItem('ok/1', 1e-6, 1e-6, { supported_parameters: 'x' }), routerItem()],
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    expect(gw.catalogIssues(KEY)).toEqual([]);
    const models = await gw.listModels(KEY);
    expect(models.map((m) => m.id)).toEqual(['ok/1', 'openrouter/auto']);
    expect(gw.catalogIssues(KEY).map((i) => `${i.severity} ${i.modelId} ${i.field}`)).toEqual([
      'error #0 id',
      'error ok/1 supported_parameters',
    ]);
  });

  it('gateway: fail-closed chega ao FIO (sem temperature/seed/reasoning onde o catálogo nega)', async () => {
    const fake = fakeOpenRouter({
      catalog: [
        reasoningItem('r/ok', 1e-6, 1e-6, { mandatory: true, supported_efforts: ['high', 'low'] }, [
          'max_tokens',
          'reasoning',
          'reasoning_effort',
          'temperature',
        ]),
        reasoningItem('r/allow-ruim', 1e-6, 1e-6, { mandatory: false, supported_efforts: 'high' }, [
          'max_tokens',
          'reasoning',
          'reasoning_effort',
          'temperature',
          'seed',
        ]),
        catalogItem('c/params-ruins', 1e-6, 1e-6, { supported_parameters: 'temperature' }),
        routerItem('openrouter/fusion', { supported_parameters: [] }),
        catalogItem('c/sem-lista', 1e-6, 1e-6, { supported_parameters: undefined }),
      ],
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    await gw.listModels(KEY);
    const corpo = async (modelId: string): Promise<Record<string, unknown>> => {
      await gw.chatCompletion({
        apiKey: KEY,
        modelId,
        messages: [{ role: 'user', content: 'oi' }],
        maxTokens: 50,
        reasoningLevel: 'max',
      });
      return fake.chatRequests().at(-1)!.body!;
    };
    expect((await corpo('r/ok')).reasoning).toEqual({ effort: 'high' }); // encaixado na allowlist
    const ruim = await corpo('r/allow-ruim');
    expect(ruim.reasoning).toBeUndefined();
    expect(ruim.temperature).toBe(0);
    const params = await corpo('c/params-ruins');
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('seed');
    expect(params).not.toHaveProperty('reasoning');
    const fusion = await corpo('openrouter/fusion');
    expect(fusion).not.toHaveProperty('temperature');
    expect(fusion).not.toHaveProperty('reasoning');
    // Sem lista no catálogo = desconhecido: comportamento anterior (heurística + reasoning enviado).
    const semLista = await corpo('c/sem-lista');
    expect(semLista.temperature).toBe(0);
    expect(semLista.reasoning).toEqual({ effort: 'max' });
  });

  it('chamada paga a roteador: custo vem de usage.cost; sem usage.cost é "unknown", nunca negativo', async () => {
    let n = 0;
    const fake = fakeOpenRouter({
      catalog: [routerItem()],
      chat: () => (n++ === 0 ? { text: 'a', usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.002 } } : { text: 'b', usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    await gw.listModels(KEY);
    const ledger = new BudgetLedger({});
    const params = { apiKey: KEY, modelId: 'openrouter/auto', messages: [{ role: 'user' as const, content: 'x' }], sink: ledger };
    const r1 = await gw.chatCompletion(params);
    const r2 = await gw.chatCompletion(params);
    expect(r1.cost).toMatchObject({ usd: 0.002, source: 'usage' });
    expect(r2.cost).toMatchObject({ usd: 0, source: 'unknown' });
    const snap = ledger.snapshot();
    expect(snap.spentUsd).toBeCloseTo(0.002, 12);
    expect(snap.accuracy).toMatchObject({ exact: 1, unknown: 1 });
  });
});

// ---------------------------------------------------------------------------
// (iii) Contrato do snapshot do /models.
// ---------------------------------------------------------------------------

const BASELINE_PATH = join(ROOT, 'test', 'fixtures', 'catalog-contract.json');

/** Catálogo cru COERENTE com uma baseline (o inverso de `modelContract`), para testes offline. */
function catalogoDaBaseline(b: CatalogContract): Record<string, unknown>[] {
  return Object.entries(b.models).map(([id, c]) => ({
    id,
    name: id,
    pricing: c.price === 'known' ? { prompt: '0.000001', completion: '0.000002' } : { prompt: '-1', completion: '-1' },
    ...(c.wireParameters ? { supported_parameters: [...c.wireParameters, 'top_k'] } : {}),
    ...(c.mandatory !== null || c.supportedEfforts !== null || c.defaultEffort !== null
      ? {
          reasoning: {
            ...(c.mandatory !== null ? { mandatory: c.mandatory } : {}),
            ...(c.supportedEfforts ? { supported_efforts: [...c.supportedEfforts].reverse() } : {}),
            ...(c.defaultEffort ? { default_effort: c.defaultEffort } : {}),
          },
        }
      : {}),
  }));
}

function mutar(
  cru: Record<string, unknown>[],
  id: string,
  f: (item: Record<string, unknown>) => void,
): Record<string, unknown>[] {
  const copia = JSON.parse(JSON.stringify(cru)) as Record<string, unknown>[];
  f(copia.find((m) => m.id === id)!);
  return copia;
}

describe('IMPL-018 (iii) — contrato do snapshot: drift em modelo usado em run reprova', () => {
  const config = {
    mode: 'compare',
    theme: 't',
    stages: 2,
    datagenModelId: 'a/barato',
    judgeModelIds: ['o/raciocina'],
    competitorModelIds: ['a/caro', 'openrouter/auto'],
  } as unknown as RunConfig;

  it('runModelIds junta todos os papéis (sem duplicar, ordenado)', () => {
    expect(runModelIds(config)).toEqual(['a/barato', 'a/caro', 'o/raciocina', 'openrouter/auto']);
    const variation = {
      mode: 'variation',
      datagenModelId: 'd/1',
      judgeModelIds: ['j/1'],
      contestantModelId: 'c/1',
      optimizerModelId: 'op/1',
      referenceModelId: 'j/1',
    } as unknown as RunConfig;
    expect(runModelIds(variation)).toEqual(['c/1', 'd/1', 'j/1', 'op/1']);
  });

  const baselineDaRun = (): CatalogContract => {
    const { contract, missing } = buildCatalogContract(catalogo(), runModelIds(config));
    expect(missing).toEqual([]);
    return contract;
  };

  it('catálogo igual (ou só reordenado / com ruído fora do fio) => sem drift', () => {
    const b = baselineDaRun();
    expect(diffCatalogContract(b, catalogo())).toMatchObject({ changes: [], breaking: false });
    const reordenado = mutar(CATALOGO_CRU, 'o/raciocina', (m) => {
      (m.reasoning as { supported_efforts: string[] }).supported_efforts.reverse();
      (m.supported_parameters as string[]).push('top_k', 'logit_bias');
    });
    expect(diffCatalogContract(b, parseModelsPayload({ data: reordenado })).changes).toEqual([]);
  });

  it('mudança em supported_efforts de modelo usado em run => QUEBRA', () => {
    const d = diffCatalogContract(
      baselineDaRun(),
      parseModelsPayload({
        data: mutar(CATALOGO_CRU, 'o/raciocina', (m) => {
          (m.reasoning as Record<string, unknown>).supported_efforts = ['high', 'medium', 'low'];
        }),
      }),
    );
    expect(d.breaking).toBe(true);
    expect(d.changes).toEqual([
      {
        modelId: 'o/raciocina',
        field: 'supportedEfforts',
        before: ['high', 'low', 'medium', 'minimal'],
        after: ['high', 'low', 'medium'],
        breaking: true,
      },
    ]);
  });

  it('mudança em mandatory de modelo usado em run => QUEBRA', () => {
    const d = diffCatalogContract(
      baselineDaRun(),
      parseModelsPayload({
        data: mutar(CATALOGO_CRU, 'o/raciocina', (m) => {
          (m.reasoning as Record<string, unknown>).mandatory = false;
        }),
      }),
    );
    expect(d.breaking).toBe(true);
    expect(d.changes).toEqual([
      { modelId: 'o/raciocina', field: 'mandatory', before: true, after: false, breaking: true },
    ]);
  });

  it('parâmetro do fio que some (temperature) ou modelo vigiado que some => QUEBRA', () => {
    const b = baselineDaRun();
    const semTemp = diffCatalogContract(
      b,
      parseModelsPayload({
        data: mutar(CATALOGO_CRU, 'a/caro', (m) => {
          m.supported_parameters = ['seed', 'max_tokens', 'response_format'];
        }),
      }),
    );
    expect(semTemp.changes).toMatchObject([{ modelId: 'a/caro', field: 'wireParameters', breaking: true }]);
    const sumiu = diffCatalogContract(b, catalogo().filter((m) => m.id !== 'a/barato'));
    expect(sumiu.changes).toEqual([
      { modelId: 'a/barato', field: 'presence', before: 'present', after: 'missing', breaking: true },
    ]);
  });

  it('allowlist malformada (fail-closed no parse) aparece como drift que QUEBRA', () => {
    const d = diffCatalogContract(
      baselineDaRun(),
      parseModelsPayload({
        data: mutar(CATALOGO_CRU, 'o/raciocina', (m) => {
          (m.reasoning as Record<string, unknown>).supported_efforts = 'high';
        }),
      }),
    );
    expect(d.breaking).toBe(true);
    expect(d.changes.map((c) => c.field).sort()).toEqual(['defaultEffort', 'mandatory', 'supportedEfforts', 'wireParameters']);
  });

  it('só informativo (default_effort, preço vira "-1") não quebra; modelo NÃO usado é ignorado', () => {
    const b = baselineDaRun();
    const info = diffCatalogContract(
      b,
      parseModelsPayload({
        data: mutar(
          mutar(CATALOGO_CRU, 'o/raciocina', (m) => {
            (m.reasoning as Record<string, unknown>).default_effort = 'low';
          }),
          'a/caro',
          (m) => {
            m.pricing = { prompt: '-1', completion: '-1' };
          },
        ),
      }),
    );
    expect(info.breaking).toBe(false);
    expect(info.changes.map((c) => `${c.modelId} ${c.field}`)).toEqual(['a/caro price', 'o/raciocina defaultEffort']);
    // Um modelo fora da run muda à vontade: não é contrato de ninguém.
    const alheio = diffCatalogContract(
      b,
      parseModelsPayload({
        data: [
          ...CATALOGO_CRU,
          reasoningItem('x/alheio', 1e-6, 1e-6, { mandatory: true, supported_efforts: ['high'] }),
        ],
      }),
    );
    expect(alheio.changes).toEqual([]);
  });

  it('baseline VERSIONADA (test/fixtures/catalog-contract.json) é válida, enxuta e vigia os modelos padrão', () => {
    const b = parseCatalogContract(JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')));
    expect(b.format).toBe(CATALOG_CONTRACT_FORMAT);
    // Modelos das runs padrão: SPA (NewRun), `init` do CLI e canário do agente.
    expect(Object.keys(b.models)).toEqual(
      expect.arrayContaining([
        'openai/gpt-5-mini',
        'openai/gpt-5-nano',
        'deepseek/deepseek-v4-pro',
        'moonshotai/kimi-k2.6',
        'anthropic/claude-sonnet-5',
        'google/gemini-2.5-flash',
        'openrouter/auto',
      ]),
    );
    expect(b.models['openrouter/auto'].price).toBe('unknown');
    // Guarda-se a projeção, não o dump: nenhum campo além do contrato.
    for (const c of Object.values(b.models)) {
      expect(Object.keys(c).sort()).toEqual(['defaultEffort', 'mandatory', 'price', 'supportedEfforts', 'wireParameters']);
    }
  });

  it('contra a baseline VERSIONADA: flip de mandatory/supported_efforts em qualquer vigiado reprova', () => {
    const b = parseCatalogContract(JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')));
    const cru = catalogoDaBaseline(b);
    expect(diffCatalogContract(b, parseModelsPayload({ data: cru })).changes).toEqual([]);
    const comReasoning = Object.entries(b.models).filter(([, c]) => c.mandatory !== null);
    expect(comReasoning.length).toBeGreaterThan(0);
    for (const [id, c] of comReasoning) {
      const flip = mutar(cru, id, (m) => {
        (m.reasoning as Record<string, unknown>).mandatory = !c.mandatory;
      });
      expect(diffCatalogContract(b, parseModelsPayload({ data: flip })).breaking, id).toBe(true);
      if (c.supportedEfforts && c.supportedEfforts.length > 1) {
        const menos = mutar(cru, id, (m) => {
          (m.reasoning as Record<string, unknown>).supported_efforts = c.supportedEfforts!.slice(1);
        });
        expect(diffCatalogContract(b, parseModelsPayload({ data: menos })).breaking, id).toBe(true);
      }
    }
  });

  it('script do CI: drift que quebra => exit 1 + diff no stdout; --accept versiona o diff e atualiza a baseline', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pb-catalog-contract-'));
    try {
      const b = parseCatalogContract(JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')));
      const baseline = join(tmp, 'baseline.json');
      writeFileSync(baseline, JSON.stringify(b));
      const cru = catalogoDaBaseline(b);
      const alvo = Object.entries(b.models).find(([, c]) => c.mandatory !== null)![0];
      const mudado = join(tmp, 'models.json');
      writeFileSync(
        mudado,
        JSON.stringify({
          data: mutar(cru, alvo, (m) => {
            const r = m.reasoning as Record<string, unknown>;
            r.mandatory = !r.mandatory;
          }),
        }),
      );
      const run = (args: string[]) =>
        spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts', 'catalog-contract.ts'), ...args], {
          cwd: ROOT, // o `--import tsx` resolve a partir daqui; todos os caminhos são absolutos
          encoding: 'utf-8',
        });
      const intacto = join(tmp, 'intacto.json');
      writeFileSync(intacto, JSON.stringify({ data: cru }));
      const ok = run(['--baseline', baseline, '--catalog', intacto]);
      expect(ok.status, ok.stderr).toBe(0);

      const quebra = run(['--baseline', baseline, '--catalog', mudado, '--out', join(tmp, 'drift.json')]);
      expect(quebra.status, quebra.stderr).toBe(1);
      const diff = JSON.parse(quebra.stdout) as { breaking: boolean; changes: Array<{ modelId: string; field: string }> };
      expect(diff.breaking).toBe(true);
      expect(diff.changes).toEqual([expect.objectContaining({ modelId: alvo, field: 'mandatory' })]);
      expect(JSON.parse(readFileSync(join(tmp, 'drift.json'), 'utf-8'))).toEqual(diff);

      // Aceite (humano, após revisão): baseline nova + diff VERSIONADO (não o dump).
      const driftDir = join(tmp, 'drift');
      const aceite = run(['--baseline', baseline, '--catalog', mudado, '--accept', '--drift-dir', driftDir]);
      expect(aceite.status, aceite.stderr).toBe(0);
      const versionados = readdirSync(driftDir);
      expect(versionados).toHaveLength(1);
      const registro = JSON.parse(readFileSync(join(driftDir, versionados[0]), 'utf-8')) as Record<string, unknown>;
      expect(registro).toMatchObject({ format: 'prompt-builder-catalog-drift@1', breaking: true });
      expect(registro).not.toHaveProperty('data'); // nada do catálogo cru
      expect(run(['--baseline', baseline, '--catalog', mudado]).status).toBe(0); // aceito => contrato novo vale
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

// Verificação AO VIVO (GET /models é público e gratuito). Fora do `npm test`
// padrão para não depender de rede; o job diário de CI roda o script equivalente.
describe.runIf(process.env.PB_CATALOG_LIVE === '1')('IMPL-018 (iii) — contrato contra o /models AO VIVO', () => {
  it('a baseline versionada ainda vale no catálogo real', async () => {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    expect(res.ok).toBe(true);
    const b = parseCatalogContract(JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')));
    const drift = diffCatalogContract(b, parseModelsPayload(await res.json()));
    expect(drift.changes.filter((c) => c.breaking)).toEqual([]);
  }, 30_000);
});
