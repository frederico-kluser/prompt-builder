// IMPL-055 (R-03a:REC-1) — validar o gabarito ANTES do julgamento.
//
// Contratos provados aqui (transporte FALSO, zero rede, zero gasto):
//  (i)   fixture de cenário cujo gabarito DIVERGE da rubrica dispara a
//        verificação dirigida pela rubrica e o 2º gabarito de família distinta;
//  (ii)  o veredito 'parcial' da verificação (rubrica em prosa) também dispara;
//  (iii) gabarito aderente NÃO dispara nada — dry-run de 10 cenários: o 2º
//        gabarito sai SÓ dos sinalizados (é isso que segura o custo extra);
//  (iv)  2º gabarito DISCORDANTE ⇒ flag `reference_disagreement`; concordante
//        não cria flag de discordância;
//  (v)   falha da verificação = INCONCLUSIVO (nenhum flag fabricado) e nunca
//        derruba a run;
//  (vi)  amostra humana de auditoria 5–10% (determinística) + acionada por
//        discordância de sinais;
//  (vii) itens divergentes flagados no record e PRESERVADOS no re-read.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, setDefaultGateway, type FetchLike } from '../src/openrouter.js';
import { validateGeneratedReferences } from '../src/gabarito.js';
import {
  DEFAULT_AUDIT_SAMPLE_RATE,
  humanReviewQueueFromStages,
  selectAuditSample,
} from '../src/engine/groundTruth.js';
import { normalizeRunRecord } from '../src/normalize.js';
import type { HumanReviewReason, StageSpec } from '../src/types.js';
import { fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { canaryOf } from './judgeReplies.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

/** Fixture: o gabarito CONTRARIA a rubrica (rubrica exige "positivo"). */
const STAGE_DIVERGENTE: StageSpec = {
  question: 'Qual o sentimento do cliente nesta mensagem?',
  productContext: 'Classificador de sentimento do suporte.',
  maxTokens: 120,
  rubric: 'A resposta DEVE classificar o sentimento como "positivo".',
  expected: 'positivo',
  labelSet: ['positivo', 'negativo'],
  reference: 'negativo — o cliente reclamou do atendimento.',
};

/** Fixture: o gabarito satisfaz a rubrica. */
const STAGE_OK: StageSpec = {
  ...STAGE_DIVERGENTE,
  reference: 'positivo — o cliente elogiou o atendimento.',
};

/** Réplica do verificador LLM (contrato `RUBRIC_CHECK_SCHEMA`) + canário. */
const replyVerificacao = (req: { user: string }, verdict: 'resolve' | 'parcial' | 'nao'): string =>
  JSON.stringify({ canario: canaryOf(req), explanation: `verificação: ${verdict}`, verdict });

async function comGateway<T>(fetch: FetchLike, fn: () => Promise<T>): Promise<T> {
  const anterior = setDefaultGateway(createGateway({ fetch, sleep: noSleep }));
  try {
    return await fn();
  } finally {
    setDefaultGateway(anterior);
  }
}

const motivos = (s: StageSpec | undefined): HumanReviewReason[] =>
  s?.referenceValidation?.reviewReasons ?? [];

describe('IMPL-055 — verificação dirigida pela rubrica + 2º gabarito CONDICIONADO', () => {
  beforeAll(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('fixture cujo gabarito diverge da rubrica dispara a verificação e o 2º gabarito', async () => {
    const fake = fakeOpenRouter({
      chat: (req) => ({ text: 'positivo — outra redação do gabarito ideal.', finishReason: 'stop' }),
    });
    const out = await comGateway(fake.fetch, () =>
      validateGeneratedReferences({
        stages: [STAGE_DIVERGENTE, STAGE_OK],
        apiKey: KEY,
        secondModelId: 'fake/ref2',
        stageNumbers: [1, 2],
      }),
    );
    // A divergência foi DETECTADA e o 2º gabarito (família distinta) DISPAROU…
    expect(out[0].referenceValidation!.rubric.divergent).toBe(true);
    expect(out[0].referenceValidation!.secondReference?.modelId).toBe('fake/ref2');
    expect(motivos(out[0])).toContain('reference_rubric_divergence');
    // …exatamente UMA chamada de 2º gabarito (só a etapa sinalizada).
    expect(fake.chatRequests().filter((r) => r.model === 'fake/ref2')).toHaveLength(1);
    // Etapa aderente: verificação resolve, sem 2º gabarito e sem divergência.
    expect(out[1].referenceValidation!.rubric.verdict).toBe('resolve');
    expect(motivos(out[1])).not.toContain('reference_rubric_divergence');
  });

  it("veredito 'parcial' da verificação LLM (rubrica em prosa) também dispara o 2º gabarito", async () => {
    const stageProsa: StageSpec = {
      question: 'Resuma a política de trocas.',
      productContext: 'Trocas em até 30 dias com nota fiscal.',
      maxTokens: 200,
      rubric: 'Informar o prazo de 30 dias e a exigência de nota fiscal.',
      reference: 'Trocas em até 30 dias.',
    };
    const fake = fakeOpenRouter({
      chat: (req) =>
        req.model === 'fake/verifier'
          ? { text: replyVerificacao(req, 'parcial'), finishReason: 'stop' }
          : { text: 'Trinta dias, com nota fiscal, a partir do recebimento.', finishReason: 'stop' },
    });
    const out = await comGateway(fake.fetch, () =>
      validateGeneratedReferences({
        stages: [stageProsa],
        apiKey: KEY,
        verifyModelId: 'fake/verifier',
        secondModelId: 'fake/ref2',
      }),
    );
    const v = out[0].referenceValidation!;
    expect(v.rubric.method).toBe('llm');
    expect(v.rubric.verdict).toBe('parcial'); // dispara ('parcial' OU divergência)
    expect(v.secondReference).toBeDefined();
    expect(motivos(out[0])).toContain('reference_rubric_divergence');
    expect(fake.chatRequests().map((r) => r.model).sort()).toEqual(['fake/ref2', 'fake/verifier']);
  });

  it('dry-run do cenário padrão (10 cenários): 2º gabarito SÓ nos sinalizados — custo extra condicionado', async () => {
    // 8 gabaritos aderentes + 2 divergentes. Com `expected`, a checagem é
    // determinística: ZERO chamadas de verificação. O custo extra do protocolo
    // (R-03a:REC-1: ~+8% com 2º gabarito universal, teto ~16%) fica contido
    // porque a chamada extra só sai dos sinalizados — aqui, 2 de 10.
    const stages: StageSpec[] = [
      ...Array.from({ length: 8 }, (_, i) => ({ ...STAGE_OK, question: `OK ${i}` })),
      ...Array.from({ length: 2 }, (_, i) => ({ ...STAGE_DIVERGENTE, question: `Divergente ${i}` })),
    ];
    const fake = fakeOpenRouter({
      chat: () => ({ text: 'positivo — gabarito de segunda opinião.', finishReason: 'stop' }),
    });
    const out = await comGateway(fake.fetch, () =>
      validateGeneratedReferences({ stages, apiKey: KEY, secondModelId: 'fake/ref2' }),
    );
    expect(fake.chatRequests().filter((r) => r.model === 'fake/ref2')).toHaveLength(2);
    expect(fake.chatRequests()).toHaveLength(2); // nenhuma chamada além dos sinalizados
    expect(out.filter((s) => motivos(s).includes('reference_rubric_divergence'))).toHaveLength(2);
  });

  it('2º gabarito DISCORDANTE ⇒ reference_disagreement; concordante não cria flag', async () => {
    const fake = fakeOpenRouter({
      chat: () => ({ text: 'O produto chegou quebrado e o pedido foi cancelado.', finishReason: 'stop' }),
    });
    const out = await comGateway(fake.fetch, () =>
      validateGeneratedReferences({
        stages: [STAGE_DIVERGENTE],
        apiKey: KEY,
        secondModelId: 'fake/ref2',
        auditSampleRate: 0.05,
      }),
    );
    const v = out[0].referenceValidation!;
    expect(v.secondReference?.agree).toBe(false);
    expect(motivos(out[0])).toContain('reference_disagreement');

    const fake2 = fakeOpenRouter({
      chat: () => ({ text: 'negativo — o cliente reclamou do atendimento.', finishReason: 'stop' }),
    });
    const out2 = await comGateway(fake2.fetch, () =>
      validateGeneratedReferences({ stages: [STAGE_DIVERGENTE], apiKey: KEY, secondModelId: 'fake/ref2' }),
    );
    expect(out2[0].referenceValidation!.secondReference?.agree).toBe(true);
    expect(motivos(out2[0])).not.toContain('reference_disagreement');
  });

  it('falha da verificação = INCONCLUSIVO (sem flags fabricados) e nunca derruba a run', async () => {
    const fake = fakeOpenRouter({
      chat: () => ({ status: 500, bodyText: 'boom' }),
    });
    const stageProsa: StageSpec = {
      question: 'Resuma a política.',
      productContext: 'Ctx.',
      maxTokens: 100,
      rubric: 'Deve citar o prazo.',
      reference: 'Prazo de 30 dias.',
    };
    const out = await comGateway(fake.fetch, () =>
      validateGeneratedReferences({
        stages: [stageProsa],
        apiKey: KEY,
        verifyModelId: 'fake/verifier',
        secondModelId: 'fake/ref2',
      }),
    );
    const v = out[0].referenceValidation!;
    expect(v.rubric.method).toBe('none'); // incerteza ≠ aderência ≠ divergência
    expect(v.rubric.verdict).toBeNull();
    expect(v.secondReference).toBeUndefined(); // nada disparou — nada foi inventado
    const flags = motivos(out[0]).filter((r) => r !== 'reference_audit_sample');
    expect(flags).toEqual([]);
  });

  it('etapas sem gabarito ou já validadas mantêm IDENTIDADE (só o que se valida é cópia)', async () => {
    const semGabarito: StageSpec = { ...STAGE_OK, reference: undefined };
    const jaValidada: StageSpec = {
      ...STAGE_OK,
      question: 'Já validada',
      referenceValidation: {
        rubric: { verdict: 'resolve', divergent: false, method: 'expected', detail: 'ok' },
        reviewReasons: [],
      },
    };
    const fake = fakeOpenRouter({ chat: () => ({ text: 'x', finishReason: 'stop' }) });
    const out = await comGateway(fake.fetch, () =>
      validateGeneratedReferences({
        stages: [semGabarito, jaValidada],
        apiKey: KEY,
        secondModelId: 'fake/ref2',
      }),
    );
    expect(out[0]).toBe(semGabarito);
    expect(out[1]).toBe(jaValidada);
    expect(fake.chatRequests()).toHaveLength(0);
  });
});

describe('IMPL-055 — amostra humana de auditoria (5–10%, determinística)', () => {
  it('a cota fica presa na banda 5–10% e é reprodutível pela seed', () => {
    const s1 = selectAuditSample(100, 0.08, 1337);
    expect(s1.size).toBe(8); // 8% de 100
    expect(selectAuditSample(100, 0.08, 1337)).toEqual(s1); // mesma seed ⇒ mesma amostra
    expect(selectAuditSample(100, 5, 1337).size).toBe(10); // clamp no teto (10%)
    expect(selectAuditSample(100, 0.001, 1337).size).toBe(5); // clamp no piso (5%)
    expect(selectAuditSample(0, 0.08, 1).size).toBe(0);
  });

  it("o item entra na fila com `reference_audit_sample`; discordância de sinais aciona SEMPRE", async () => {
    // 20 etapas aderentes ⇒ cota 8% = 2 itens sorteados (fora os discordantes).
    const stages: StageSpec[] = Array.from({ length: 20 }, (_, i) => ({
      ...STAGE_OK,
      question: `Item ${i}`,
    }));
    const fake = fakeOpenRouter({ chat: () => ({ text: 'x', finishReason: 'stop' }) });
    const out = await comGateway(fake.fetch, () =>
      validateGeneratedReferences({ stages, apiKey: KEY, secondModelId: 'fake/ref2' }),
    );
    const auditadas = out.filter((s) => s.referenceValidation!.auditSample);
    expect(auditadas).toHaveLength(2);
    for (const s of auditadas) expect(motivos(s)).toContain('reference_audit_sample');

    // Discordância de sinais: rubrica diz divergir, 2º gabarito CONCORDA ⇒
    // auditoria acionada mesmo FORA da cota sorteada. Põe a etapa divergente
    // num índice que a cota NÃO sorteou (a amostra é determinística).
    const amostra = selectAuditSample(20, DEFAULT_AUDIT_SAMPLE_RATE, 1337);
    const idxFora = Array.from({ length: 20 }, (_, i) => i).find((i) => !amostra.has(i))!;
    const stages2 = stages.map((s, i) => (i === idxFora ? { ...STAGE_DIVERGENTE, question: `Divergente ${i}` } : s));
    // O 2º gabarito repete o 1º ⇒ concordam (sinais em conflito).
    const fake2 = fakeOpenRouter({
      chat: () => ({ text: 'negativo — o cliente reclamou do atendimento.', finishReason: 'stop' }),
    });
    const out2 = await comGateway(fake2.fetch, () =>
      validateGeneratedReferences({ stages: stages2, apiKey: KEY, secondModelId: 'fake/ref2' }),
    );
    expect(out2[idxFora].referenceValidation!.secondReference?.agree).toBe(true);
    expect(out2[idxFora].referenceValidation!.auditSample).toBe(true);
    expect(motivos(out2[idxFora])).toContain('reference_audit_sample');
    // 2 da cota + 1 acionado pela discordância — nada mais.
    expect(out2.filter((s) => s.referenceValidation!.auditSample)).toHaveLength(3);
  });
});

describe('IMPL-055 — fila needs-human-review: flagada no record e PRESERVADA no re-read', () => {
  it('a fila sai das validações com stageIndex/motivo/custo, e o re-read não perde nada', async () => {
    const fake = fakeOpenRouter({
      chat: () => ({ text: 'positivo — outra redação do gabarito ideal.', finishReason: 'stop' }),
    });
    const validadas = await comGateway(fake.fetch, () =>
      validateGeneratedReferences({
        stages: [STAGE_DIVERGENTE, STAGE_OK],
        apiKey: KEY,
        secondModelId: 'fake/ref2',
      }),
    );
    const fila = humanReviewQueueFromStages(validadas.map((spec) => ({ spec })));
    expect(fila.some((i) => i.stageIndex === 0 && i.reason === 'reference_rubric_divergence')).toBe(true);
    expect(fila.every((i) => typeof i.detail === 'string' && i.detail.length > 0)).toBe(true);
    expect(fila.every((i) => i.estimatedCostUsd === 0.025)).toBe(true);

    const raw = {
      id: 'run-impl055',
      status: 'finished',
      config: { mode: 'compare', competitorModelIds: ['fake/a'], judgeModelIds: ['fake/judge'] },
      contestants: [{ id: 'fake/a', label: 'fake/a', modelId: 'fake/a' }],
      stages: validadas.map((spec, index) => ({
        index,
        spec,
        responses: [],
        startedAt: '2026-01-01T00:00:00.000Z',
      })),
      scoreboard: {},
      totalCostUsd: 0,
      needsHumanReview: fila,
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    const relido = normalizeRunRecord(raw as never);
    // Preservado no re-read (whitelist de normalizeRunRecord verificada).
    expect(relido.needsHumanReview).toEqual(fila);
    expect(relido.stages[0].spec?.referenceValidation).toEqual(validadas[0].referenceValidation);
    // E a fila rederivada das etapas é a MESMA do record.
    expect(humanReviewQueueFromStages(relido.stages)).toEqual(fila);
    // Custo humano estimado por item: a política (~US$ 0,025/gabarito).
    expect(fila[0].estimatedCostUsd).toBeCloseTo(0.025);
    expect(DEFAULT_AUDIT_SAMPLE_RATE).toBeGreaterThanOrEqual(0.05);
    expect(DEFAULT_AUDIT_SAMPLE_RATE).toBeLessThanOrEqual(0.1);
  });
});