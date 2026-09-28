// Testes de CONTRATO de reasoning/fitEffort, variantes compare-llms, orçamento
// (BudgetLedger) e — sobretudo — dos DOIS WHITELISTS silenciosos do projeto:
// `normalizeRunRecord` (spreads) e `variationConfigFrom` (trainer). Um campo
// novo que não sobreviva a eles some SEM erro; estes testes existem para que
// isso quebre o CI em vez de chegar como bug de "sumiu depois do F5".

import { describe, expect, it } from 'vitest';
import { applyReasoning, coerceLevel, effortName, fitEffort, REASONING_LEVELS } from '../src/reasoning.js';
import {
  fairnessWarnings,
  llmVariantId,
  sanitizeLlmVariants,
  variantsToContestants,
} from '../src/llmVariants.js';
import { BudgetExceeded, BudgetLedger, isControlSignal, RunCancelled } from '../src/budget.js';
import { normalizeRunRecord } from '../src/normalize.js';
import { variationConfigFrom } from '../src/trainer.js';
import type { ModelReasoningMeta, TrainingConfig } from '../src/types.js';

describe('reasoning.ts — 7 degraus encaixados na allowlist do modelo', () => {
  const meta = (over: Partial<ModelReasoningMeta>): ModelReasoningMeta => ({
    supportedEfforts: [],
    ...over,
  });

  it('sem allowlist o pedido passa direto', () => {
    expect(fitEffort('high')).toBe('high');
    expect(fitEffort('off')).toBe('none');
  });

  it('com allowlist, encaixa no degrau mais próximo (empate → mais barato)', () => {
    const m = meta({ supportedEfforts: ['xhigh', 'high', 'low'] });
    expect(fitEffort('max', m)).toBe('xhigh'); // mais próximo de max
    expect(fitEffort('minimal', m)).toBe('low'); // empate dist(1,2) entre low e high? low vence (mais barato)
    expect(fitEffort('high', m)).toBe('high'); // presente na allowlist
    expect(fitEffort('medium', m)).toBe('low'); // empate 1×1 → o mais barato
  });

  it('off num modelo mandatory NÃO envia nada (o provedor rejeita none)', () => {
    const body: Record<string, unknown> = {};
    applyReasoning(body, 'off', meta({ mandatory: true, supportedEfforts: ['low'] }));
    expect(body.reasoning).toBeUndefined();
  });

  it('off em modelo normal desliga explicitamente; nunca manda effort+max_tokens juntos', () => {
    const body: Record<string, unknown> = {};
    applyReasoning(body, 'off');
    expect(body.reasoning).toEqual({ enabled: false });
    const body2: Record<string, unknown> = {};
    applyReasoning(body2, 'high', meta({ supportedEfforts: ['high'] }));
    expect(body2.reasoning).toEqual({ effort: 'high' });
  });

  it('escada completa estável e coerceLevel rejeita lixo', () => {
    expect(REASONING_LEVELS).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortName('off')).toBe('none');
    expect(coerceLevel('xhigh')).toBe('xhigh');
    expect(coerceLevel('ALGO', 'low')).toBe('low');
  });
});

describe('llmVariants.ts — identidade da tripla e fairness', () => {
  it('id é determinístico pela tripla {modelo, level, temp}', () => {
    const v = { modelId: 'openai/gpt-4o', reasoningLevel: 'high' as const, temperature: 0.7 };
    expect(llmVariantId(v)).toBe(llmVariantId(v));
    expect(llmVariantId(v)).not.toBe(llmVariantId({ ...v, temperature: 0.2 }));
    // Temperatura é arredondada a 2 casas NO SANITIZE (0.7 e 0.7000001 são a
    // mesma variante — o id não pode depender de ruído de ponto flutuante).
    const a = sanitizeLlmVariants([{ modelId: 'a/x', temperature: 0.7 }, { modelId: 'b/x' }]);
    const b = sanitizeLlmVariants([{ modelId: 'a/x', temperature: 0.7000001 }, { modelId: 'b/x' }]);
    expect(a.variants[0].id).toBe(b.variants[0].id);
  });

  it('sanitize: 2–12, inválido vira warning e sai, tripla duplicada é erro', () => {
    const dup = sanitizeLlmVariants([
      { modelId: 'a/x', temperature: 0 },
      { modelId: 'a/x', temperature: 0 },
    ]);
    expect(dup.error).toMatch(/duplicada/i);
    const ok = sanitizeLlmVariants([
      { modelId: 'a/x' },
      { modelId: 'b/x', reasoningLevel: 'low' },
      { modelId: 'zzz' }, // inválido: sem modelId? não — tem modelId; use temperatura inválida
    ]);
    expect(ok.variants).toHaveLength(3);
    const comLixo = sanitizeLlmVariants([
      { modelId: 'a/x' },
      { modelId: 'b/x', temperature: 9 },
      { modelId: 'c/x' },
    ]);
    expect(comLixo.warnings).toHaveLength(1);
    expect(comLixo.variants).toHaveLength(2);
  });

  it('fairnessWarnings: auto-preferência e mesmo vendor são avisos NÃO-bloqueantes', () => {
    const variants = variantsToContestants([
      { id: 'v1', label: 'A', modelId: 'openai/gpt-4o', reasoningLevel: null, temperature: null },
    ]);
    expect(variants[0].id).toBe('v1');
    const { variants: vs } = sanitizeLlmVariants([
      { modelId: 'openai/gpt-4o' },
      { modelId: 'openai/gpt-4o-mini' },
    ]);
    const avisos = fairnessWarnings(vs, ['openai/gpt-4.1']);
    expect(avisos.some((a) => /vendor/i.test(a))).toBe(true);
    const self = fairnessWarnings(vs, ['openai/gpt-4o']);
    expect(self.some((a) => /auto-prefer/i.test(a))).toBe(true);
  });
});

describe('budget.ts — teto honesto e sinais de controle', () => {
  const call = (usd: number) => ({ usd, source: 'usage' as const, upstreamUsd: 0 });

  it('contabilidade é por papel e o snapshot soma todos os papéis', () => {
    const ledger = new BudgetLedger({ budgetUsd: 10 });
    const r = ledger.reserve('judge', 'm', 100, 100);
    ledger.note(r, { role: 'judge', modelId: 'm', cost: call(0.5), tokensIn: 100, tokensOut: 10 });
    ledger.note(ledger.reserve('datagen', 'm', 1, 1), {
      role: 'datagen',
      modelId: 'm',
      cost: call(0.25),
      tokensIn: 1,
      tokensOut: 1,
    });
    const snap = ledger.snapshot();
    expect(snap.spentUsd).toBeCloseTo(0.75, 10);
    expect(snap.byRole.judge.usd).toBeCloseTo(0.5, 10);
    expect(snap.byRole.datagen.calls).toBe(1);
  });

  it('BudgetExceeded é CONTROLE (isControlSignal) e nunca vira resultado plausível', () => {
    const err = new BudgetExceeded(1, 2, 'competitor');
    expect(isControlSignal(err)).toBe(true);
    expect(isControlSignal(new RunCancelled())).toBe(true);
    expect(isControlSignal(new Error('x'))).toBe(false);
  });

  it('reserva otimista estoura ANTES da chamada quando a estimativa não cabe', () => {
    const ledger = new BudgetLedger({
      budgetUsd: 1,
      estimateCall: () => 5,
    });
    expect(() => ledger.reserve('competitor', 'm', 100, 100)).toThrow(BudgetExceeded);
  });

  it('ledger filho repassa o gasto ao pai; o teto vive só na raiz', () => {
    const raiz = new BudgetLedger({ budgetUsd: 2, estimateCall: () => 0 });
    const filho = raiz.fork();
    filho.note(filho.reserve('competitor', 'm', 1, 1), {
      role: 'competitor',
      modelId: 'm',
      cost: call(1.5),
      tokensIn: 1,
      tokensOut: 1,
    });
    expect(raiz.snapshot().spentUsd).toBeCloseTo(1.5, 10);
    expect(raiz.canAfford(1)).toBe(false);
    expect(raiz.canAfford(0.4)).toBe(true);
    expect(filho.canAfford(10)).toBe(false); // enxega o teto da raiz
  });

  it('abort derruba na reserva e nas fronteiras de fase (RunCancelled)', () => {
    const ctrl = new AbortController();
    const ledger = new BudgetLedger({ signal: ctrl.signal, estimateCall: () => 0 });
    ctrl.abort();
    expect(() => ledger.reserve('competitor', 'm', 1, 1)).toThrow(RunCancelled);
    expect(() => ledger.throwIfCancelled()).toThrow(RunCancelled);
  });
});

describe('whitelists silenciosos — os campos NÃO podem sumir', () => {
  it('normalizeRunRecord espalha ...raw: campo novo sobrevive à releitura', () => {
    const raw = {
      id: 'r1',
      status: 'finished',
      mode: 'variation',
      config: { mode: 'variation', theme: 't', stages: 1, datagenModelId: 'g', judgeModelIds: ['j'], contestantModelId: 'c' },
      contestants: [],
      stages: [],
      scoreboard: {},
      totalCostUsd: 1,
      startedAt: 'now',
      // Campos que já sumiram uma vez no passado…
      judgeScoreByContestant: { a: 50 },
      standings: [{ id: 'a', label: 'A', isControl: false, points: 1, wins: 1, ties: 0, losses: 0, winRate: 1 }],
      finalists: ['a'],
      // …e um campo hipotético do FUTURO: precisa sobreviver igual.
      campoDoFuturo: { ok: true },
    };
    const rec = normalizeRunRecord(raw) as unknown as Record<string, unknown>;
    expect(rec.judgeScoreByContestant).toEqual({ a: 50 });
    expect(rec.finalists).toEqual(['a']);
    expect(rec.campoDoFuturo).toEqual({ ok: true });
  });

  it('normalizeStage preserva campos novos de StageRecord/CompetitorResponse', () => {
    const rec = normalizeRunRecord({
      id: 'r',
      status: 'finished',
      config: { mode: 'compare' },
      stages: [
        {
          index: 0,
          startedAt: 'now',
          responses: [{ modelId: 'm', text: 't', futuro: 1 }],
          campoNovoDaEtapa: 'fica',
        },
      ],
      startedAt: 'now',
    });
    const stage = rec.stages[0] as unknown as Record<string, unknown>;
    expect(stage.campoNovoDaEtapa).toBe('fica');
    expect((stage.responses[0] as unknown as Record<string, unknown>).futuro).toBe(1);
  });

  it('variationConfigFrom repassa todo campo novo de RunConfigBase (ou o exclui COMENTADO)', () => {
    const cfg: TrainingConfig = {
      mode: 'training',
      theme: 'tema',
      stages: 3,
      datagenModelId: 'g/x',
      judgeModelIds: ['j/x'],
      contestantModelId: 'c/x',
      iterations: 2,
      reflection: 'llm', // proposital: consumido pelo trainer, NÃO copiado p/ a run
      paretoPool: 3,
      // Campos "esquecíveis" — os que já sumiram uma vez:
      compliance: { area: 'saude', includeRessalvas: true },
      piiMode: 'synthetic', // IMPL-042
      allowPii: true, // IMPL-042 (revisão do usuário vale para a sessão inteira)
      reasoning: { competitor: 'low', judge: 'high', rewriter: 'medium', datagen: 'off' },
      referenceModelId: 'r/x',
      referenceJudging: true,
      scenarioBrief: 'brief',
      duels: false,
      finalists: 4,
      temperature: 0.3,
      maxPricePerMTok: { prompt: 1, completion: 2 },
      judgePasses: 2,
      concurrency: 2,
      timeoutMs: 5000,
      maxOutputTokens: 400,
      promptOptimization: false,
      optimizerModelId: 'o/x',
      scenarioSeed: [{ question: 'q', productContext: 'p', maxTokens: 100 }],
      customStages: [{ question: 'q2', productContext: 'p2', maxTokens: 200 }],
      contracts: { neverBreak: ['NUNCA invente'], placeholders: ['{os}'], minLengthRatio: 0.4 },
      promptGroup: { prompts: [{ id: 'regras', text: 'REGRAS' }, { id: 'criticas', text: 'CRITICAS' }] },
      promptId: 'regras',
      agent: undefined,
      budgetUsd: 42, // proposital: NÃO pode ser copiado (teto é da sessão)
    };
    const v = variationConfigFrom(cfg) as unknown as Record<string, unknown>;
    // Exclusões DOCUMENTADAS: campos que pertencem ao loop do treino (não à
    // run de cada iteração) ou cuja cópia seria um bug (budgetUsd). Todo campo
    // novo de TrainingConfig precisa aparecer aqui ou ser copiado — este teste
    // falha se você adicionar ao tipo e esquecer de decidir.
    const exclusoes = new Set([
      'mode',
      'iterations',
      'minGain',
      'holdoutRatio',
      'feedbackDriven',
      'reflection', // consumido pelo trainingLoop (reflexão GEPA), não pela run
      'paretoPool', // idem (pool Pareto do loop)
      'budgetUsd',
    ]);
    for (const [key, value] of Object.entries(cfg)) {
      if (exclusoes.has(key)) continue;
      expect(v[key], `campo "${key}" foi engolido por variationConfigFrom`).toEqual(value);
    }
    expect(v.budgetUsd, 'budgetUsd copiado = N iterações gastam N× o teto').toBeUndefined();
  });
});
