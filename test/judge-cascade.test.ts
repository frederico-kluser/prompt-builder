// IMPL-115 (R-08:REC-2) — cascata juiz barato → juiz forte no julgamento:
// 2 juízes baratos em paralelo + escalonamento SÓ por gatilho (discordância,
// veredito 'parcial', anomalia de comprimento de saída), com fração escalonada
// reportada e custo por veredito medido (usage.cost do fake = fatura).
//
// Criterio (iii): logprobs NUNCA como dependência obrigatória — a cascata decide
// por vereditos parseados + comprimento das saídas, e há um teste de contrato
// que reprova qualquer `logprob` em src/judge.ts.

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, setDefaultGateway, type FetchLike } from '../src/openrouter.js';
import {
  LENGTH_ANOMALY_RATIO,
  cascadeEscalatedFraction,
  cascadeEscalationReasons,
  hasLengthAnomaly,
  judgeStageCascade,
} from '../src/judge.js';
import type { CompetitorResponse, StageSpec, Verdict } from '../src/types.js';
import { readMarkedBlock } from '../src/engine/judgeGuard.js';
import { fakeOpenRouter, noSleep, type FakeRequest } from './fakeOpenRouter.js';
import { listwiseReply } from './judgeReplies.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

const STAGE: StageSpec = {
  question: 'Qual o prazo para trocar um produto?',
  productContext: 'Trocas em até 30 dias com nota fiscal.',
  maxTokens: 200,
  reference: 'Trinta dias a partir do recebimento, com nota fiscal.',
};

const resp = (id: string, text: string): CompetitorResponse => ({
  contestantId: id,
  modelId: 'fake/a',
  text,
  latencyMs: 1,
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
  status: 'ok',
});

async function comGateway<T>(fetch: FetchLike, fn: () => Promise<T>): Promise<T> {
  const anterior = setDefaultGateway(createGateway({ fetch, sleep: noSleep }));
  try {
    return await fn();
  } finally {
    setDefaultGateway(anterior);
  }
}

/**
 * Resposta listwise que decide por CONTESTANT: o rótulo (A/B) vem do shuffle,
 * então o bloco marcado de cada rótulo é lido de volta e mapeado pelo texto
 * ('RESP-A'/'RESP-B') para o contestant certo.
 */
function replyDecidindo(
  req: FakeRequest,
  decide: (contestantId: 'a' | 'b') => Verdict,
  ranking: string[] = ['A', 'B'],
): string {
  const verdicts = ranking.map((label) => {
    const bloco = readMarkedBlock(req.user, `RESPOSTA ${label}`) ?? '';
    const cid: 'a' | 'b' = bloco.includes('RESP-B') ? 'b' : 'a';
    return { label, justificativa: 'confere a rubrica', veredito: decide(cid) };
  });
  return listwiseReply(req, ranking, verdicts);
}

/** Chamadas por modelo (conta o retry com lembrete junto). */
const chamadasDe = (fake: { chatRequests(): FakeRequest[] }, modelo: string): number =>
  fake.chatRequests().filter((q) => q.model === modelo).length;

afterEach(() => setDefaultGateway(createGateway({ fetch: undefined, sleep: noSleep })));

describe('cascadeEscalationReasons — decisão PURA da cascata', () => {
  it('sem gatilho: baratos concordam, sem parcial, sem anomalia', () => {
    expect(
      cascadeEscalationReasons(
        [
          { judgeModelId: 'c1', verdictByContestant: { a: 'resolve', b: 'nao' } },
          { judgeModelId: 'c2', verdictByContestant: { a: 'resolve', b: 'nao' } },
        ],
        { responseLengths: [10, 12] },
      ),
    ).toEqual([]);
  });

  it('discordância em QUALQUER contestant dispara "disagreement"', () => {
    const reasons = cascadeEscalationReasons([
      { judgeModelId: 'c1', verdictByContestant: { a: 'resolve', b: 'nao' } },
      { judgeModelId: 'c2', verdictByContestant: { a: 'nao', b: 'nao' } },
    ]);
    expect(reasons).toContain('disagreement');
    expect(reasons).not.toContain('parcial');
  });

  it('juiz barato sem voto válido conta como ausência de consenso', () => {
    expect(
      cascadeEscalationReasons([
        { judgeModelId: 'c1', verdictByContestant: { a: 'resolve' } },
        { judgeModelId: 'c2', verdictByContestant: {}, failed: true },
      ]),
    ).toContain('disagreement');
  });

  it('veredito "parcial" (intermediário) dispara "parcial" — mesmo em consenso', () => {
    expect(
      cascadeEscalationReasons([
        { judgeModelId: 'c1', verdictByContestant: { a: 'parcial' } },
        { judgeModelId: 'c2', verdictByContestant: { a: 'parcial' } },
      ]),
    ).toEqual(['parcial']);
  });

  it('anomalia de comprimento de saída dispara "length-anomaly"', () => {
    expect(
      cascadeEscalationReasons(
        [
          { judgeModelId: 'c1', verdictByContestant: { a: 'resolve', b: 'nao' } },
          { judgeModelId: 'c2', verdictByContestant: { a: 'resolve', b: 'nao' } },
        ],
        { responseLengths: [10, 400] },
      ),
    ).toEqual(['length-anomaly']);
  });

  it('ordem estável dos gatilhos e a razão de anomalia', () => {
    expect(
      cascadeEscalationReasons(
        [
          { judgeModelId: 'c1', verdictByContestant: { a: 'parcial' } },
          { judgeModelId: 'c2', verdictByContestant: { a: 'nao' } },
        ],
        { responseLengths: [10, 400] },
      ),
    ).toEqual(['disagreement', 'parcial', 'length-anomaly']);
    expect(LENGTH_ANOMALY_RATIO).toBeGreaterThan(1);
    expect(hasLengthAnomaly([100, 100, 101])).toBe(false);
    expect(hasLengthAnomaly([100, 100, 301])).toBe(true);
    expect(hasLengthAnomaly([10])).toBe(false); // 1 comprimento não é anomalia
    expect(hasLengthAnomaly([])).toBe(false);
  });
});

describe('judgeStageCascade — 2 baratos + escalonamento por gatilho', () => {
  const base = {
    apiKey: KEY,
    stage: STAGE,
    timeoutMs: 2_000,
    cheapJudgeIds: ['fake/cheap-1', 'fake/cheap-2'],
    strongJudgeId: 'fake/strong',
    responses: [resp('a', 'RESP-A'), resp('b', 'RESP-B')],
  };

  it('sem gatilho: 2 chamadas baratas, o juiz forte NUNCA roda, consenso decide', async () => {
    const fake = fakeOpenRouter({
      chat: (req) => ({ text: replyDecidindo(req, (cid) => (cid === 'a' ? 'resolve' : 'nao')) }),
    });
    const r = await comGateway(fake.fetch, () => judgeStageCascade(base));
    expect(chamadasDe(fake, 'fake/cheap-1')).toBe(1);
    expect(chamadasDe(fake, 'fake/cheap-2')).toBe(1);
    expect(chamadasDe(fake, 'fake/strong')).toBe(0); // custo poupado: o forte não é chamado
    expect(r.cascade.escalated).toBe(false);
    expect(r.cascade.reasons).toEqual([]);
    expect(r.cascade.strongDecided).toBe(false);
    expect(r.verdictByContestant).toEqual({ a: 'resolve', b: 'nao' });
    expect(r.rawJudgeText).toContain('[cascata] sem gatilho');
  });

  it('discordância escalona: o juiz forte decide e os votos baratos ficam no relatório', async () => {
    const fake = fakeOpenRouter({
      chat: (req) => {
        if (req.model === 'fake/cheap-1') return { text: replyDecidindo(req, () => 'resolve') };
        if (req.model === 'fake/cheap-2') return { text: replyDecidindo(req, () => 'nao') };
        return { text: replyDecidindo(req, () => 'parcial') };
      },
    });
    const r = await comGateway(fake.fetch, () => judgeStageCascade(base));
    expect(chamadasDe(fake, 'fake/strong')).toBe(1);
    expect(r.cascade.escalated).toBe(true);
    expect(r.cascade.reasons).toEqual(['disagreement']);
    expect(r.cascade.strongDecided).toBe(true);
    // O FORTE decide (veredito dele, não o dos baratos)…
    expect(r.verdictByContestant).toEqual({ a: 'parcial', b: 'parcial' });
    // …e o consenso barato fica auditável no relatório.
    expect(r.cascade.cheapVerdictByContestant.a).toBeDefined();
    expect(r.cascade.cheapVerdictByContestant.b).toBeDefined();
    expect(r.judges.map((j) => j.judgeModelId)).toEqual(['fake/strong']);
  });

  it('veredito "parcial" em consenso barato escalona (intermediário = dúvida)', async () => {
    const fake = fakeOpenRouter({
      chat: (req) =>
        req.model === 'fake/strong'
          ? { text: replyDecidindo(req, (cid) => (cid === 'a' ? 'resolve' : 'nao')) }
          : { text: replyDecidindo(req, () => 'parcial') },
    });
    const r = await comGateway(fake.fetch, () => judgeStageCascade(base));
    expect(r.cascade.reasons).toEqual(['parcial']);
    expect(r.cascade.escalated).toBe(true);
    expect(r.verdictByContestant).toEqual({ a: 'resolve', b: 'nao' });
  });

  it('anomalia de comprimento de saída escalona mesmo com os baratos concordando', async () => {
    const fake = fakeOpenRouter({
      chat: (req) =>
        req.model === 'fake/strong'
          ? { text: replyDecidindo(req, () => 'resolve') }
          : { text: replyDecidindo(req, (cid) => (cid === 'a' ? 'resolve' : 'nao')) },
    });
    const r = await comGateway(fake.fetch, () =>
      judgeStageCascade({
        ...base,
        responses: [resp('a', 'RESP-A'), resp('b', `RESP-B ${'x'.repeat(400)}`)],
      }),
    );
    expect(r.cascade.reasons).toEqual(['length-anomaly']);
    expect(r.cascade.escalated).toBe(true);
  });

  it('juiz forte falha: escalonou mas vale o consenso barato (nunca fica sem veredito)', async () => {
    const fake = fakeOpenRouter({
      chat: (req) => {
        if (req.model === 'fake/strong') return { text: 'não é JSON nenhum' };
        if (req.model === 'fake/cheap-1') return { text: replyDecidindo(req, () => 'resolve') };
        return { text: replyDecidindo(req, () => 'nao') };
      },
    });
    const r = await comGateway(fake.fetch, () => judgeStageCascade(base));
    expect(r.cascade.escalated).toBe(true);
    expect(r.cascade.strongDecided).toBe(false);
    // Fallback = painel barato (degradado), com veredito agregado presente.
    expect(r.judges).toHaveLength(2);
    expect(r.verdictByContestant.a).toBeDefined();
    expect(r.rawJudgeText).toContain('valeu o consenso barato');
  });

  it('custo por veredito cai no modo econômico (usage.cost medido, papel juiz)', async () => {
    // Tabela de preços sintética: barato US$ 0,001/call, forte US$ 0,02/call.
    const preco = (req: FakeRequest): number => (req.model === 'fake/strong' ? 0.02 : 0.001);
    const chat = (req: FakeRequest) => ({
      text: replyDecidindo(req, (cid) => (cid === 'a' ? 'resolve' : 'nao')),
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: preco(req) },
    });
    const economico = fakeOpenRouter({ chat });
    await comGateway(economico.fetch, () => judgeStageCascade(base));
    // Linha de base do pipeline atual: o juiz forte julga sempre (1 chamada).
    const referencia = fakeOpenRouter({ chat });
    await comGateway(referencia.fetch, () =>
      judgeStageCascade({ ...base, cheapJudgeIds: ['fake/strong'], strongJudgeId: 'fake/strong' }),
    );
    const porVereditoEconomico = economico.billedUsd() / 2;
    const porVereditoReferencia = referencia.billedUsd() / 2;
    expect(economico.billedUsd()).toBeLessThan(referencia.billedUsd());
    // Queda >= 40% no custo por veredito (o mecanismo; a âncora de >= 50
    // vereditos humanos da concordância é medição da R-08:REC-9, fora do lote).
    expect(1 - porVereditoEconomico / porVereditoReferencia).toBeGreaterThanOrEqual(0.4);
  });

  it('fração escalonada é reportada (e vazia = 0)', () => {
    expect(cascadeEscalatedFraction([])).toBe(0);
    expect(
      cascadeEscalatedFraction([
        { escalated: false },
        { escalated: false },
        { escalated: true },
      ]),
    ).toBeCloseTo(1 / 3, 5);
  });

  it('contrato: logprobs NUNCA são dependência da cascata (criterio iii)', async () => {
    // 1) Nenhuma menção a logprobs no código do juiz…
    const fonte = readFileSync(join(ROOT, 'src', 'judge.ts'), 'utf8');
    expect(/logprob/i.test(fonte)).toBe(false);
    // 2) …e a cascata decide 100% com respostas SEM logprobs (as réplicas do
    //    fake nunca carregam o campo).
    const fake = fakeOpenRouter({
      chat: (req) => ({ text: replyDecidindo(req, () => 'resolve') }),
    });
    const r = await comGateway(fake.fetch, () => judgeStageCascade(base));
    expect(r.cascade.reasons).toEqual([]);
  });
});