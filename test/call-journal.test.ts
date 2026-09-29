// IMPL-081 (R-10:REC-2) — núcleo do journal de chamadas pagas + o seam no
// gateway + a contabilidade do replay no ledger. Zero rede, zero gasto real.
//
// Contrato verificado aqui:
//   • a chave é o `contentHash` do pedido CANÔNICO: qualquer coisa que muda a
//     resposta muda a chave (nunca replay de OUTRO pedido); os códigos
//     sorteados da blindagem do juiz saem da chave e o texto replayado volta
//     re-amarrado ao canário da chamada ATUAL;
//   • pedidos idênticos têm respostas PRÓPRIAS (ocorrência): a n-ésima
//     ocorrência na retomada recebe a n-ésima resposta gravada, uma vez só; o
//     que foi gravado nesta tentativa não é replayado nela;
//   • replay = US$ 0 nesta tentativa, FORA do gasto (`replayedCalls`/
//     `replayedUsd` à parte; registo `replayed`) — nunca conta em dobro;
//   • abort pendente nunca é replayado (o caminho normal devolve o sinal de
//     controle) e falha ao gravar nunca derruba a chamada paga.

import { describe, expect, it, vi } from 'vitest';
import {
  CALL_JOURNAL_FORMAT,
  CallJournal,
  discountByRole,
  journalEntryId,
  journalRequestKey,
  parseJournalEntry,
  priorSpentUsdOf,
  resumeBudgetUsd,
  resumeInfoFor,
  resumeRefusal,
  type JournalEntry,
  type JournalRequest,
  type JournalStore,
} from '../src/engine/callJournal.js';
import { BudgetLedger, isControlSignal, RunCancelled } from '../src/budget.js';
import { createGateway } from '../src/openrouter.js';
import { closeTag, instructionsBlock, newJudgeGuard, openTag } from '../src/engine/judgeGuard.js';
import { fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

const REQ: JournalRequest = {
  role: 'competitor',
  modelId: 'fake/a',
  messages: [
    { role: 'system', content: 'responda curto' },
    { role: 'user', content: 'pergunta 1' },
  ],
  temperature: 0,
  maxTokens: 300,
};

/** Store em memória que espelha o que foi gravado (e pode falhar). */
function memStore(falhar = false): JournalStore & { entries: JournalEntry[] } {
  const entries: JournalEntry[] = [];
  return {
    entries,
    async append(e) {
      if (falhar) throw new Error('disco cheio');
      entries.push(JSON.parse(JSON.stringify(e)) as JournalEntry);
      return true;
    },
  };
}

const resultado = (text: string, usd = 0.01) => ({
  text,
  tokensIn: 10,
  tokensOut: 5,
  latencyMs: 42,
  cost: { usd, source: 'usage' as const },
});

/** Prompt de juiz com a blindagem REAL (marcador + canário por veredito). */
function pedidoDeJuiz(candidato: string): { req: JournalRequest; canary: string } {
  const g = newJudgeGuard([candidato]);
  const user =
    `${openTag('CANDIDATO', g.nonce)}\n${candidato}\n${closeTag('CANDIDATO', g.nonce)}\n\n` +
    instructionsBlock({ guard: g, candidateLabels: ['CANDIDATO'], rules: [], outputSchema: { type: 'object' } });
  return {
    req: { ...REQ, role: 'judge', modelId: 'fake/judge', messages: [{ role: 'system', content: 'juiz' }, { role: 'user', content: user }] },
    canary: g.canary,
  };
}

describe('núcleo: chave canônica (nunca replay de outro pedido)', () => {
  it('estável para o mesmo pedido; muda com QUALQUER campo que muda a resposta', () => {
    const k = journalRequestKey(REQ).key;
    expect(k).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(journalRequestKey({ ...REQ, messages: REQ.messages.map((m) => ({ ...m })) }).key).toBe(k);
    const variantes: Partial<JournalRequest>[] = [
      { role: 'judge' },
      { modelId: 'fake/b' },
      { temperature: 0.7 },
      { maxTokens: 600 },
      { reasoningLevel: 'high' },
      { responseFormatJson: true },
      { responseSchema: { name: 's', schema: { type: 'object' } } },
      { maxPricePerMTok: { prompt: 1 } },
      { cacheControlAfter: 0 },
      { auditable: true },
      { messages: [...REQ.messages.slice(0, 1), { role: 'user', content: 'pergunta 2' }] },
      { messages: [{ role: 'user', content: 'responda curto' }, REQ.messages[1]] },
    ];
    for (const v of variantes) {
      expect(journalRequestKey({ ...REQ, ...v }).key, JSON.stringify(v)).not.toBe(k);
    }
  });

  it('a blindagem do juiz (marcador/canário sorteados) sai da chave', () => {
    const a = pedidoDeJuiz('Resposta X');
    const b = pedidoDeJuiz('Resposta X');
    expect(a.canary).not.toBe(b.canary);
    expect(journalRequestKey(a.req).key).toBe(journalRequestKey(b.req).key);
    expect(journalRequestKey(a.req).guard.canary).toBe(a.canary);
    // …mas o conteúdo julgado entra.
    expect(journalRequestKey(pedidoDeJuiz('Resposta Y').req).key).not.toBe(journalRequestKey(a.req).key);
  });
});

describe('núcleo: ocorrência, replay e gravação', () => {
  it('replay da n-ésima ocorrência, uma vez só; gravado NESTA tentativa não é replayado nela', async () => {
    const store = memStore();
    const t1 = new CallJournal({ store });
    for (const txt of ['r1', 'r2']) {
      const got = t1.take(REQ);
      expect(got.kind).toBe('live');
      if (got.kind === 'live') await t1.record(got.ticket, resultado(txt));
    }
    expect(store.entries.map((e) => [e.seq, e.result.text])).toEqual([
      [0, 'r1'],
      [1, 'r2'],
    ]);
    // Tentativa 2 (retomada): duas ocorrências replayadas, a 3ª vai ao provedor.
    const t2 = new CallJournal({ store, entries: store.entries });
    const a = t2.take(REQ);
    const b = t2.take(REQ);
    const c = t2.take(REQ);
    expect([a.kind, b.kind, c.kind]).toEqual(['replay', 'replay', 'live']);
    expect([a, b].map((x) => (x.kind === 'replay' ? x.result.text : ''))).toEqual(['r1', 'r2']);
    if (c.kind === 'live') await t2.record(c.ticket, resultado('r3'));
    expect(store.entries.at(-1)).toMatchObject({ seq: 2, result: { text: 'r3' } }); // sem colidir com 0/1
    expect(t2.stats()).toMatchObject({ loadedCalls: 2, replayedCalls: 2, replayedUsd: 0.02, recordedCalls: 1 });
    // Outro pedido nunca pega resposta desta chave.
    expect(new CallJournal({ entries: store.entries }).take({ ...REQ, temperature: 1 }).kind).toBe('live');
  });

  it('replay de juiz volta RE-AMARRADO ao canário da chamada atual', async () => {
    const store = memStore();
    const t1 = new CallJournal({ store });
    const orig = pedidoDeJuiz('Resposta X');
    const got = t1.take(orig.req);
    if (got.kind !== 'live') throw new Error('esperava live');
    await t1.record(got.ticket, resultado(JSON.stringify({ canario: orig.canary, verdict: 'resolve' })));
    const agora = pedidoDeJuiz('Resposta X');
    const t2 = new CallJournal({ entries: store.entries });
    const r = t2.take(agora.req);
    expect(r.kind).toBe('replay');
    if (r.kind === 'replay') {
      expect(JSON.parse(r.result.text)).toEqual({ canario: agora.canary, verdict: 'resolve' });
      expect(r.result.text).not.toContain(orig.canary);
    }
  });

  it('falha ao gravar: nunca lança, avisa UMA vez, conta a falha', async () => {
    const onError = vi.fn();
    const j = new CallJournal({ store: memStore(true), onError });
    for (let i = 0; i < 3; i++) {
      const got = j.take(REQ);
      if (got.kind === 'live') await expect(j.record(got.ticket, resultado('x'))).resolves.toBeUndefined();
    }
    expect(onError).toHaveBeenCalledTimes(1);
    expect(j.stats()).toMatchObject({ appendFailures: 3, recordedCalls: 0 });
    // 'unavailable' (sem armazenamento por natureza): conta, não avisa.
    const quieto = vi.fn();
    const j2 = new CallJournal({ store: { append: async () => 'unavailable' }, onError: quieto });
    const got = j2.take(REQ);
    if (got.kind === 'live') await j2.record(got.ticket, resultado('x'));
    expect(quieto).not.toHaveBeenCalled();
    expect(j2.stats().appendFailures).toBe(1);
  });

  it('entrada fora do formato (versão, chave, custo, texto) é descartada — paga de novo, nunca replay duvidoso', () => {
    const ok: JournalEntry = {
      format: CALL_JOURNAL_FORMAT,
      key: journalRequestKey(REQ).key,
      seq: 0,
      role: 'competitor',
      modelId: 'fake/a',
      at: '2026-09-29T00:00:00.000Z',
      result: resultado('r'),
    };
    expect(parseJournalEntry(ok)).toEqual(ok);
    expect(journalEntryId(ok)).toBe(`${ok.key}#0`);
    for (const ruim of [
      { ...ok, format: 'call-journal@0' },
      { ...ok, key: 'abc' },
      { ...ok, seq: -1 },
      { ...ok, seq: 1.5 },
      { ...ok, result: { ...ok.result, text: 1 } },
      { ...ok, result: { ...ok.result, cost: { usd: 'x', source: 'usage' } } },
      null,
      'linha',
    ]) {
      expect(parseJournalEntry(ruim)).toBeUndefined();
    }
  });
});

describe('núcleo: desconto do journal nas portas suaves', () => {
  it('loadedUsdByRole soma só o custo MEDIDO carregado; discountByRole nunca passa de 0', () => {
    const e = (seq: number, role: 'judge' | 'competitor', usd: number, source: 'usage' | 'unknown' = 'usage'): JournalEntry => ({
      format: CALL_JOURNAL_FORMAT,
      key: journalRequestKey({ ...REQ, role }).key,
      seq,
      role,
      modelId: 'fake/a',
      at: 'x',
      result: { ...resultado('r', usd), cost: { usd, source } },
    });
    const j = new CallJournal({ entries: [e(0, 'judge', 0.1), e(1, 'judge', 0.2), e(0, 'competitor', 0.05), e(2, 'judge', 0.4, 'unknown')] });
    const pago = j.loadedUsdByRole();
    expect(pago.judge).toBeCloseTo(0.3, 12);
    expect(pago.competitor).toBeCloseTo(0.05, 12);
    const est = { judge: 1, competitor: 0.02, duel: 0.5 };
    const d = discountByRole(est, pago);
    expect(d.judge).toBeCloseTo(0.7, 12);
    expect(d).toMatchObject({ competitor: 0, duel: 0.5 });
    expect(est.judge, 'não muta a projeção original').toBe(1);
  });
});

describe('núcleo: política de retomada', () => {
  const base = { id: 'r1', config: { mode: 'compare', budgetUsd: 1 }, totalCostUsd: 0.3, costLedger: { pendingUsd: 0.1 } };

  it('retomável = parou sem terminar (órfã, cancelada, orçamento, erro); o resto recusa com motivo', () => {
    for (const st of [
      { status: 'aborted' },
      { status: 'aborted', stoppedReason: 'cancelled' },
      { status: 'aborted', stoppedReason: 'budget' },
      { status: 'aborted', stoppedReason: 'orphan' },
      { status: 'error' },
    ]) {
      expect(resumeRefusal({ ...base, ...st }), JSON.stringify(st)).toBeNull();
    }
    expect(resumeRefusal({ ...base, status: 'finished' })).toMatch(/terminou/);
    expect(resumeRefusal({ ...base, status: 'inconclusive' })).toMatch(/terminou/);
    expect(resumeRefusal({ ...base, status: 'running' })).toMatch(/execução/);
    expect(resumeRefusal({ ...base, status: 'aborted', sessionId: 's' })).toMatch(/sessão/);
    expect(resumeRefusal({ ...base, status: 'aborted', config: { mode: 'compare', agent: {} } })).toMatch(/agente/);
  });

  it('o teto da continuação é o que SOBROU (gasto + pendente das tentativas anteriores descontados)', () => {
    const prev = { ...base, status: 'aborted' };
    expect(resumeBudgetUsd(prev)).toBeCloseTo(0.6, 12);
    expect(resumeBudgetUsd({ ...prev, totalCostUsd: 2 })).toBe(0);
    expect(resumeBudgetUsd(prev, 5)).toBe(5); // --budget = teto só da continuação
    expect(resumeBudgetUsd({ ...prev, config: { mode: 'compare' } })).toBeUndefined();
    // 2ª retomada acumula o gasto de TODAS as anteriores.
    const info = resumeInfoFor(prev, 7, '2026-09-29T00:00:00.000Z');
    expect(info).toMatchObject({ attempt: 2, priorSpentUsd: 0.3, priorPendingUsd: 0.1, journalCalls: 7, previousStatus: 'aborted' });
    const prev2 = { ...prev, totalCostUsd: 0.2, costLedger: { pendingUsd: 0 }, resume: info };
    expect(priorSpentUsdOf(prev2)).toBeCloseTo(0.5, 12);
    expect(resumeInfoFor(prev2, 9).attempt).toBe(3);
    expect(resumeBudgetUsd(prev2)).toBeCloseTo(0.4, 12);
  });
});

// ---------------------------------------------------------------------------
// Seam no gateway + contabilidade do replay no ledger
// ---------------------------------------------------------------------------

describe('gateway: journal ANTES da reserva/fetch e DEPOIS da resposta', () => {
  const msgs = REQ.messages.map((m) => ({ role: m.role as 'system' | 'user', content: m.content }));

  it('run nova grava; retomada replaya a US$ 0 sem tocar o transporte — fora do gasto, rotulada `replayed`', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: 'resposta paga', usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.004 } }) });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const store = memStore();
    const l1 = new BudgetLedger({ budgetUsd: 1 });
    l1.setCallJournal(new CallJournal({ store }));
    const r1 = await gw.chatCompletion({ apiKey: KEY, modelId: 'fake/a', messages: msgs, maxTokens: 300, sink: l1, role: 'competitor' });
    expect(r1.replayed).toBeUndefined();
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0].result).toMatchObject({ text: 'resposta paga', cost: { usd: 0.004, source: 'usage' } });
    expect(store.entries[0].result.finishSignals).toBeDefined();

    // "Retomada": ledger novo, journal carregado com o que foi gravado.
    const antes = fake.chatRequests().length;
    const l2 = new BudgetLedger({ budgetUsd: 1 });
    l2.setCallJournal(new CallJournal({ entries: store.entries }));
    const deltas: string[] = [];
    const r2 = await gw.chatCompletionStream({
      apiKey: KEY,
      modelId: 'fake/a',
      messages: msgs,
      maxTokens: 300,
      sink: l2,
      role: 'competitor',
      onDelta: (_d, full) => deltas.push(full),
    });
    expect(fake.chatRequests().length, 'nenhuma chamada nova ao provedor').toBe(antes);
    expect(r2).toMatchObject({ text: 'resposta paga', replayed: true, cost: { usd: 0, source: 'usage', replayed: true } });
    expect(deltas).toEqual(['resposta paga']);
    const snap = l2.snapshot();
    expect(snap.spentUsd).toBe(0);
    expect(snap.committedUsd).toBe(0);
    expect(snap.byRole.competitor).toMatchObject({ calls: 0, usd: 0, replayedCalls: 1, replayedUsd: 0.004 });
    expect(snap.finishByRole.competitor?.calls, 'sinais de fim da resposta replayada contam').toBe(1);
    expect(l2.callLog()).toEqual([
      { role: 'competitor', modelId: 'fake/a', usd: 0, source: 'usage', status: 'replayed', replayedFromUsd: 0.004 },
    ]);
  });

  it('pedido diferente (outra temperatura) NÃO replaya: vai ao provedor e é pago', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: 'nova', usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }) });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const store = memStore();
    const l1 = new BudgetLedger();
    l1.setCallJournal(new CallJournal({ store }));
    await gw.chatCompletion({ apiKey: KEY, modelId: 'fake/a', messages: msgs, sink: l1, temperature: 0 });
    const l2 = new BudgetLedger();
    l2.setCallJournal(new CallJournal({ entries: store.entries }));
    const r = await gw.chatCompletion({ apiKey: KEY, modelId: 'fake/a', messages: msgs, sink: l2, temperature: 0.5 });
    expect(r.replayed).toBeUndefined();
    expect(fake.chatRequests()).toHaveLength(2);
    expect(l2.snapshot().spentUsd).toBeCloseTo(0.001, 12);
  });

  it('abort pendente nunca é replayado: sai como sinal de CONTROLE (RunCancelled)', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: 'x' }) });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const store = memStore();
    const l1 = new BudgetLedger();
    l1.setCallJournal(new CallJournal({ store }));
    await gw.chatCompletion({ apiKey: KEY, modelId: 'fake/a', messages: msgs, sink: l1 });
    const ac = new AbortController();
    ac.abort(new RunCancelled('clique'));
    const l2 = new BudgetLedger({ signal: ac.signal });
    l2.setCallJournal(new CallJournal({ entries: store.entries }));
    const err = await gw.chatCompletion({ apiKey: KEY, modelId: 'fake/a', messages: msgs, sink: l2, signal: ac.signal }).catch((e: unknown) => e);
    expect(isControlSignal(err)).toBe(true);
    expect(l2.snapshot().byRole.competitor.replayedCalls).toBeUndefined();
  });

  it('o journal vive no ledger da RUN e vale para os forks abaixo dele', () => {
    const run = new BudgetLedger();
    const j = new CallJournal();
    run.setCallJournal(j);
    expect(run.fork().callJournal()).toBe(j);
    expect(new BudgetLedger().callJournal()).toBeUndefined();
  });
});
