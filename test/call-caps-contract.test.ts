// IMPL-017 (revisão) — contrato PORTA SUAVE × PORTA DURA, papel a papel.
//
// O gateway reserva `preço × max_tokens` por chamada (porta dura); a fase só
// começa se `estimateRunCost` (porta suave) couber no orçamento. Se a projeção
// por chamada for MENOR que a reserva por chamada, a porta suave aprova uma
// fase que a porta dura corta no meio — respostas pagas sem nota. Foi o que o
// IMPL-017 introduziu ao subir o teto do reescritor para 8192 com a projeção
// parada em 1200. Este teste roda cada papel contra um transporte falso,
// captura o teto que a chamada REALMENTE reserva/envia e exige:
//   (a) teto do corpo === constante de `engine/callCaps.ts` (a que a projeção usa);
//   (b) projeção por chamada >= reserva por chamada (makeCallEstimator, mesmo teto).
// Zero rede, zero gasto.

import { describe, expect, it } from 'vitest';
import { BudgetLedger, isControlSignal } from '../src/budget.js';
import { createGateway, parseModelsPayload, setDefaultGateway } from '../src/openrouter.js';
import { estimateRunCost, makeCallEstimator, type EstimateInput } from '../src/estimate.js';
import {
  MAX_TOKENS_DATAGEN_BATCH,
  MAX_TOKENS_DATAGEN_STAGE,
  MAX_TOKENS_DUEL,
  MAX_TOKENS_GABARITO,
  MAX_TOKENS_JUDGE_LISTWISE,
  MAX_TOKENS_REF_JUDGE,
  MAX_TOKENS_REWRITER,
} from '../src/engine/callCaps.js';
import { batchCountFor, generateStage, generateStages } from '../src/datagen.js';
import { generateBasePrompt, generateContestants, llmReflectLessons } from '../src/variator.js';
import { judgeStage } from '../src/judge.js';
import { judgeStageReference } from '../src/refJudge.js';
import { runStageDuels } from '../src/duels.js';
import { generateReferences } from '../src/gabarito.js';
import { listTechniques } from '../src/techniques.js';
import type { CompetitorResponse, Contestant, CostRole, CostSink, StageSpec } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
/** O modelo do repro da revisão: $3 entrada / $15 saída por MTok. */
const M = 'p/modelo';
const CATALOGO_BRUTO = [catalogItem(M, 3e-6, 15e-6)];
/** Catálogo PARSEADO (preço numérico) — o que a projeção e a reserva leem. */
const CATALOGO = parseModelsPayload({ data: CATALOGO_BRUTO });
const reservaPorChamada = makeCallEstimator(CATALOGO);

const STAGE: StageSpec = {
  question: 'Qual o prazo de troca?',
  productContext: 'Loja X. Trocas em 30 dias com nota fiscal.',
  maxTokens: 300,
  rubric: 'Diz 30 dias e exige nota.',
  reference: 'O prazo de troca é de 30 dias, com nota fiscal.',
};
const CONTESTANTS: Contestant[] = [
  { id: 'a', label: 'A', modelId: M },
  { id: 'b', label: 'B', modelId: M },
];
const resposta = (id: string, text: string): CompetitorResponse => ({
  contestantId: id,
  modelId: M,
  text,
  latencyMs: 1,
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
  status: 'ok',
});
const RESPOSTAS = [resposta('a', 'São 30 dias com nota.'), resposta('b', 'Não sei.')];

/** Rótulo do papel "fino" (o CostRole não separa listwise de pointwise). */
type Papel =
  | 'datagen-etapa'
  | 'datagen-lote'
  | 'reescritor'
  | 'gabarito'
  | 'juiz-pointwise'
  | 'juiz-listwise'
  | 'duelo';

const TETO: Record<Papel, number> = {
  'datagen-etapa': MAX_TOKENS_DATAGEN_STAGE,
  'datagen-lote': MAX_TOKENS_DATAGEN_BATCH,
  reescritor: MAX_TOKENS_REWRITER,
  gabarito: MAX_TOKENS_GABARITO,
  'juiz-pointwise': MAX_TOKENS_REF_JUDGE,
  'juiz-listwise': MAX_TOKENS_JUDGE_LISTWISE,
  duelo: MAX_TOKENS_DUEL,
};

/** Projeção da porta suave para UMA chamada do papel (entrada mínima que gera 1 chamada). */
function projecaoPorChamada(papel: Papel): number {
  const base: EstimateInput = {
    mode: 'compare',
    plannedStages: 1,
    iterations: 1,
    contestantModelIds: [M],
    judgeModelIds: [M],
    referenceJudging: true,
    duels: false,
    finalists: 0,
    maxOutputTokens: 1000,
    judgePasses: 1,
  };
  const est = (i: EstimateInput) => estimateRunCost(i, CATALOGO, { unknownPrice: 'worst-case' }).byRole;
  switch (papel) {
    case 'datagen-etapa':
    case 'datagen-lote':
      // A porta suave projeta datagen SÓ em lote; a chamada unitária precisa caber nela.
      return est({ ...base, datagenModelId: M }).datagen / batchCountFor(1);
    case 'reescritor':
      return est({ ...base, mode: 'variation', variantsPerIteration: 1, optimizerModelId: M }).rewriter;
    case 'gabarito':
      return est(base).gabarito;
    case 'juiz-pointwise':
      return est(base).judge;
    case 'juiz-listwise':
      return est({ ...base, referenceJudging: false, contestantModelIds: [M, M] }).judge;
    case 'duelo':
      return est({ ...base, duels: true, finalists: 2, contestantModelIds: [M, M] }).duel / 2; // 1 par × 2 ordens
  }
}

describe('IMPL-017 (revisão) — tetos por papel: porta suave >= porta dura', () => {
  it('cada papel envia a constante de callCaps e a projeção por chamada cobre a reserva por chamada', async () => {
    const fake = fakeOpenRouter({
      catalog: CATALOGO_BRUTO,
      chat: (req) => {
        if (req.system.includes('SYSTEM PROMPT completo')) return { text: JSON.stringify({ systemPrompt: 'Voce e um atendente.' }) };
        if (/QUANTIDADE|ETAPA/.test(req.user)) {
          const st = { question: 'Qual o prazo?', productContext: 'Trocas em 30 dias.', maxTokens: 300 };
          return { text: JSON.stringify({ ...st, stages: [st] }) };
        }
        return { text: 'Voce e um atendente cordial e preciso. Responda com base no contexto e cite prazos.' };
      },
    });
    const prev = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    const ledger = new BudgetLedger({ estimateCall: reservaPorChamada });
    let papel: Papel = 'datagen-etapa';
    const capturas: Array<{ papel: Papel; role: CostRole; prompt: number; teto: number }> = [];
    const sink: CostSink = {
      reserve: (role, model, prompt, teto, fb) => {
        capturas.push({ papel, role, prompt, teto });
        return ledger.reserve(role, model, prompt, teto, fb);
      },
      note: (r, e) => ledger.note(r, e),
      pending: (r, e) => ledger.pending(r, e),
    };
    const ctx = { sink };
    const engolir = (e: unknown) => {
      if (isControlSignal(e)) throw e;
    };
    try {
      papel = 'datagen-etapa';
      await generateStage({ apiKey: KEY, theme: 'suporte', stageIndex: 0, totalStages: 1, modelId: M, ctx }).catch(engolir);
      papel = 'datagen-lote';
      await generateStages({ apiKey: KEY, theme: 'suporte', count: 1, modelId: M, ctx }).catch(engolir);
      papel = 'reescritor';
      await generateContestants({
        apiKey: KEY,
        modelId: M,
        theme: 'suporte',
        basePrompt: 'Voce e um atendente. Responda com base no contexto do produto e cite prazos.',
        includeOriginal: false,
        techniqueIds: [listTechniques()[0].id],
        promptOptimization: true,
        optimizerModelId: M,
        ctx,
      }).catch(engolir);
      await generateBasePrompt({ apiKey: KEY, modelId: M, taskDescription: 'atender clientes', ctx }).catch(engolir);
      await llmReflectLessons({ apiKey: KEY, modelId: M, baseLessons: '- errou prazos', ctx }).catch(engolir);
      papel = 'gabarito';
      await generateReferences({ stages: [{ ...STAGE, reference: undefined }], apiKey: KEY, modelId: M, ctx }).catch(engolir);
      papel = 'juiz-pointwise';
      await judgeStageReference({
        stage: STAGE,
        responses: RESPOSTAS,
        contestants: CONTESTANTS,
        judgeModelIds: [M],
        apiKey: KEY,
        ctx,
      }).catch(engolir);
      papel = 'juiz-listwise';
      await judgeStage({ apiKey: KEY, stage: STAGE, responses: RESPOSTAS, judgeModelIds: [M], ctx }).catch(engolir);
      papel = 'duelo';
      await runStageDuels({
        stage: STAGE,
        responses: RESPOSTAS,
        contestants: CONTESTANTS,
        judgeModelId: M,
        topK: 0,
        apiKey: KEY,
        ctx,
      }).catch(engolir);
    } finally {
      setDefaultGateway(prev);
    }

    // Todo papel foi exercitado (senão o contrato passaria no vazio).
    const vistos = new Set(capturas.map((c) => c.papel));
    expect([...vistos].sort()).toEqual((Object.keys(TETO) as Papel[]).sort());
    // (a) o corpo leva o MESMO teto que a reserva — e é a constante que a projeção usa.
    const corpos = fake.chatRequests().map((c) => c.body?.max_tokens);
    expect(corpos).toEqual(capturas.map((c) => c.teto));
    for (const c of capturas) {
      expect(c.teto, `${c.papel}: teto do corpo ≠ constante de callCaps`).toBe(TETO[c.papel]);
      // (b) porta suave >= porta dura, por chamada.
      const reserva = reservaPorChamada(M, c.prompt, c.teto);
      const projecao = projecaoPorChamada(c.papel);
      expect(reserva, `${c.papel}: reserva sem preço — o contrato passaria no vazio`).toBeGreaterThan(0);
      expect(projecao, `${c.papel}: projeção ${projecao} < reserva ${reserva}`).toBeGreaterThanOrEqual(reserva);
    }
  });

  it('repro da revisão: variation com 4 técnicas, orçamento = 2× projeção do reescritor => a fase termina', async () => {
    const tecnicas = listTechniques()
      .slice(0, 4)
      .map((t) => t.id);
    expect(tecnicas).toHaveLength(4);
    const est = estimateRunCost(
      {
        mode: 'variation',
        plannedStages: 1,
        iterations: 1,
        contestantModelIds: [M, M, M, M],
        judgeModelIds: [M],
        referenceJudging: true,
        duels: false,
        finalists: 0,
        maxOutputTokens: 1000,
        judgePasses: 1,
        optimizerModelId: M,
        variantsPerIteration: 4,
      },
      CATALOGO,
      { unknownPrice: 'worst-case' },
    );
    const ledger = new BudgetLedger({ budgetUsd: 2 * est.byRole.rewriter, estimateCall: reservaPorChamada });
    // Porta suave (o `gate('variants', est.byRole.rewriter)` do orquestrador).
    expect(ledger.canAfford(est.byRole.rewriter)).toBe(true);

    const fake = fakeOpenRouter({
      catalog: CATALOGO_BRUTO,
      chat: () => ({
        text: 'Voce e um atendente cordial e preciso. Responda sempre com base no contexto do produto, cite prazos e regras exatamente como aparecem e recuse o que estiver fora do escopo.',
        usage: { prompt_tokens: 500, completion_tokens: 400, cost: 0.0075 },
      }),
    });
    const prev = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    try {
      // Antes da correção: BudgetExceeded depois de 1 requisição (reserva de
      // 8192 tokens contra uma projeção de 1200).
      const contestants = await generateContestants({
        apiKey: KEY,
        modelId: M,
        theme: 'suporte',
        basePrompt: 'Voce e um atendente. Responda com base no contexto do produto e cite prazos.',
        includeOriginal: false,
        techniqueIds: tecnicas,
        promptOptimization: true,
        optimizerModelId: M,
        ctx: { sink: ledger },
      });
      expect(contestants.length).toBeGreaterThanOrEqual(4);
    } finally {
      setDefaultGateway(prev);
    }
    expect(fake.chatRequests()).toHaveLength(4);
    expect(ledger.byRole.rewriter.calls).toBe(4);
    expect(ledger.spentUsd).toBeLessThanOrEqual(ledger.budgetUsd!);
  });
});
