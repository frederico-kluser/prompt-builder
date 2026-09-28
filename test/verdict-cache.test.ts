// IMPL-080 (R-08:REC-3) — cache EXATO de vereditos: carry entre iterações,
// TTL e re-teste amostral OBRIGATÓRIO com invalidação por discordância.
//
// Critérios cobertos aqui (transporte falso, zero rede real):
//  (i)   iteração idêntica repetida atinge >= 90% de acerto de cache de
//        veredito — `cache_hits/cache_total` sobem no ledger (o `run.spend`
//        carrega `byRole` pronto, com `cacheHits`/`cacheTotal` por papel);
//  (ii)  o hash da chave MUDA com mutação de qualquer campo da chave
//        (modelo + esforço + temperatura + max_tokens + hash do contrato do
//        juiz + texto completo do prompt) — e credenciais ficam fora dela;
//  (iii) re-teste amostral re-julga ~10% dos itens em cache por sessão (as
//        chamadas reais aparecem no transporte) e invalida TUDO acima do
//        limiar de discordância;
//  +     TTL vencido não serve (carry dentro do TTL); papel que não é veredito
//        (competidor) nunca entra; roteamento sensível (LGPD) é fail-closed.

import { describe, expect, it } from 'vitest';
import { createGateway, type ChatCompletionResult } from '../src/openrouter.js';
import { BudgetLedger } from '../src/budget.js';
import {
  judgeContractHash,
  VerdictCache,
  verdictCacheKey,
  verdictLabelOf,
  VERDICT_CACHE_RETEST_RATE,
} from '../src/engine/verdictCache.js';
import { fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-impl080-000000';
const CONTRATO = 'contrato do juiz: JSON {"verdict": "resolve"|"parcial"|"nao"}';

const veredito = (v: 'resolve' | 'parcial' | 'nao') =>
  JSON.stringify({ verdict: v, explanation: 'ok', canario: 'x' });

function julgar(
  g: ReturnType<typeof createGateway>,
  sink: unknown,
  i: number,
): Promise<ChatCompletionResult> {
  return g.chatCompletion({
    apiKey: KEY,
    modelId: 'fake/judge',
    role: 'judge',
    messages: [
      { role: 'system', content: CONTRATO },
      { role: 'user', content: `item ${i}` },
    ],
    sink: sink as never,
  });
}

describe('IMPL-080 (ii) — a chave muda com mutação de QUALQUER campo (e sem credenciais)', () => {
  const base = {
    modelId: 'fake/judge',
    effort: 'medium',
    temperature: 0,
    maxTokens: 512,
    contractHash: judgeContractHash({ systemTexts: [CONTRATO] }),
    promptText: 'system\u0000contrato\u0000user\u0000pergunta',
  };

  it('cada campo da chave tem peso próprio: mutar UM muda o hash', () => {
    const k = verdictCacheKey(base);
    expect(verdictCacheKey({ ...base, modelId: 'outro/modelo' })).not.toBe(k);
    expect(verdictCacheKey({ ...base, effort: 'high' })).not.toBe(k);
    expect(verdictCacheKey({ ...base, effort: null })).not.toBe(k);
    expect(verdictCacheKey({ ...base, temperature: 0.7 })).not.toBe(k);
    expect(verdictCacheKey({ ...base, maxTokens: 1024 })).not.toBe(k);
    expect(verdictCacheKey({ ...base, contractHash: 'outro-contrato' })).not.toBe(k);
    expect(verdictCacheKey({ ...base, promptText: 'outra pergunta' })).not.toBe(k);
  });

  it('o contrato do juiz cobre system + schema: mudar QUALQUER um muda o hash', () => {
    const c = judgeContractHash({ systemTexts: [CONTRATO], responseSchemaName: 'veredito' });
    expect(judgeContractHash({ systemTexts: [CONTRATO + '!'], responseSchemaName: 'veredito' })).not.toBe(c);
    expect(judgeContractHash({ systemTexts: [CONTRATO], responseSchemaName: 'outro' })).not.toBe(c);
    expect(judgeContractHash({ systemTexts: [CONTRATO], responseSchema: { type: 'object' } })).not.toBe(c);
  });

  it('credenciais ficam FORA da chave: a mesma pergunta com outra key dá a MESMA chave', () => {
    // A função nem recebe apiKey — a identidade é o que foi pedido ao modelo.
    const k1 = verdictCacheKey(base);
    const k2 = verdictCacheKey(base);
    expect(k1).toBe(k2);
    expect(k1).not.toContain(KEY);
  });

  it('rótulo do veredito para comparação: campo `verdict` do JSON; sem JSON, o texto', () => {
    expect(verdictLabelOf(veredito('resolve'))).toBe('resolve');
    expect(verdictLabelOf('{"verdict":"Parcial"}')).toBe('parcial');
    expect(verdictLabelOf('  texto   livre ')).toBe('texto livre');
  });
});

describe('IMPL-080 (i) — iteração idêntica repetida atinge >= 90% de acerto', () => {
  it('carry: a 2.ª iteração sai TOTA do cache e cache_hits/cache_total sobem no byRole', async () => {
    const cache = new VerdictCache({ sample: () => 0.99 }); // sem re-teste neste cenário
    const fake = fakeOpenRouter({ chat: () => ({ text: veredito('resolve') }) });
    const g = createGateway({ fetch: fake.fetch, sleep: noSleep, verdictCache: cache });
    const ledger = new BudgetLedger();

    for (let i = 0; i < 5; i++) await julgar(g, ledger, i); // iteração 1
    const iter2: ChatCompletionResult[] = [];
    for (let i = 0; i < 5; i++) iter2.push(await julgar(g, ledger, i)); // iteração 2, idêntica

    // Nada re-julgado: 5 chamadas reais para 10 julgamentos servidos.
    expect(fake.chatRequests()).toHaveLength(5);
    const acertoIter2 = iter2.filter((r) => r.cacheHit).length / iter2.length;
    expect(acertoIter2).toBeGreaterThanOrEqual(0.9);
    for (const r of iter2) {
      expect(r.text).toBe(veredito('resolve'));
      expect(r.cost.usd).toBe(0); // servido do cache = nada cobrado (medido)
    }

    // cache_hits/cache_total POR PAPEL — o que o evento `run.spend` carrega em
    // `byRole` (o hit não é chamada upstream: `calls` fica só nas reais).
    const snap = ledger.snapshot();
    expect(snap.byRole.judge.cacheHits).toBe(5);
    expect(snap.byRole.judge.cacheTotal).toBe(10);
    expect(snap.byRole.judge.calls).toBe(5);

    const st = cache.stats();
    expect(st).toMatchObject({ cacheHits: 5, cacheTotal: 10, retests: 0, disagreements: 0 });
    expect(st.size).toBe(5); // carry: as 5 entradas vivem para a próxima iteração
  });
});

describe('IMPL-080 (iii) — re-teste amostral ~10% por sessão + invalidação por discordância', () => {
  it('re-julga ~10% dos itens em cache (chamadas REAIS por baixo do replay)', async () => {
    // Sorteio determinístico: 1 em cada 10 itens guardados vira amostra.
    let n = 0;
    const cache = new VerdictCache({ sample: () => (n++ % 10 === 0 ? 0.0 : 0.9) });
    const fake = fakeOpenRouter({ chat: () => ({ text: veredito('resolve') }) });
    const g = createGateway({ fetch: fake.fetch, sleep: noSleep, verdictCache: cache });

    for (let i = 0; i < 20; i++) await julgar(g, undefined, i); // sessão: 20 itens
    expect(fake.chatRequests()).toHaveLength(20);

    // Iteração idêntica: os 20 voltam; os 2 sorteados são RE-JULGADOS de verdade.
    for (let i = 0; i < 20; i++) await julgar(g, undefined, i);
    expect(fake.chatRequests()).toHaveLength(22); // 20 + 2 re-testes

    const st = cache.stats();
    expect(st.retests).toBe(2); // 2/20 = 10% dos itens em cache, por sessão
    expect(st.cacheHits).toBe(20);
    expect(st.disagreements).toBe(0); // vereditos idênticos: sem discordância
    expect(st.invalidations).toBe(0);
  });

  it('discordância ACIMA do limiar invalida o cache inteiro; abaixo, não', () => {
    const cache = new VerdictCache({ retestRate: 1, sample: () => 0 }); // tudo elegível
    for (let i = 0; i < 12; i++) cache.store(`k${i}`, { text: veredito('resolve') });

    // 9 concordâncias + 1 discordância = 10% — NÃO passa do limiar (estrito).
    for (let i = 0; i < 9; i++) {
      expect(cache.noteRetest(`k${i}`, { text: veredito('resolve') })).toMatchObject({
        disagreement: false,
        invalidated: false,
      });
    }
    expect(cache.noteRetest('k9', { text: veredito('nao') })).toMatchObject({
      disagreement: true,
      invalidated: false, // 1/10 = 0.1, ainda no limiar
    });
    expect(cache.stats().invalidations).toBe(0);
    expect(cache.stats().size).toBeGreaterThan(0);

    // Mais discordância: 2/11 ≈ 18% > 10% → TUDO cai.
    const r = cache.noteRetest('k10', { text: veredito('nao') });
    expect(r).toMatchObject({ disagreement: true, invalidated: true });
    expect(cache.stats().invalidations).toBe(1);
    expect(cache.stats().size).toBe(0);
  });

  it('o re-teste substitui a entrada pelo veredito FRESH (e não re-testa de novo)', async () => {
    let n = 0;
    // disagreementLimit 1 isola ESTE comportamento (a invalidação pura é do
    // teste de cima): aqui interessa o que acontece à entrada após o re-teste.
    const cache = new VerdictCache({ sample: () => (n++ === 0 ? 0.0 : 0.9), disagreementLimit: 1 });
    const fake = fakeOpenRouter({
      chat: (_req, k) => ({ text: veredito(k === 0 ? 'resolve' : 'parcial') }),
    });
    const g = createGateway({ fetch: fake.fetch, sleep: noSleep, verdictCache: cache });

    const primeiro = await julgar(g, undefined, 0); // store: sorteada p/ re-teste
    expect(primeiro.text).toBe(veredito('resolve'));
    const replay = await julgar(g, undefined, 0); // hit + re-teste REAL
    expect(fake.chatRequests()).toHaveLength(2);
    expect(replay.cacheHit).toBeUndefined(); // quem serve é a nova medição
    expect(replay.text).toBe(veredito('parcial'));
    expect(cache.stats()).toMatchObject({ retests: 1, disagreements: 1, invalidations: 0 });

    // A entrada agora é a fresh (marcada re-testada): 3.º pedido é replay puro.
    const terceiro = await julgar(g, undefined, 0);
    expect(fake.chatRequests()).toHaveLength(2);
    expect(terceiro.cacheHit).toBe(true);
    expect(terceiro.text).toBe(veredito('parcial'));
  });
});

describe('IMPL-080 — TTL, papéis fora do cache e LGPD fail-closed', () => {
  it('TTL vencido não serve (carry só dentro do TTL)', () => {
    let t = 1_000_000;
    const cache = new VerdictCache({ ttlMs: 1_000, now: () => t, sample: () => 0.99 });
    cache.store('k', { text: veredito('resolve') });
    t += 500;
    expect(cache.lookup('k')?.entry.text).toBe(veredito('resolve'));
    t += 2_000;
    expect(cache.lookup('k')).toBeUndefined(); // vencido: re-julgar
  });

  it('competidor NUNCA entra (amostrar variância é o ponto dos repeats)', async () => {
    const cache = new VerdictCache({ sample: () => 0.99 });
    const fake = fakeOpenRouter({ chat: () => ({ text: 'resposta' }) });
    const g = createGateway({ fetch: fake.fetch, sleep: noSleep, verdictCache: cache });
    for (let i = 0; i < 2; i++) {
      await g.chatCompletion({
        apiKey: KEY,
        modelId: 'fake/comp',
        role: 'competitor',
        messages: [{ role: 'user', content: 'pergunta igual' }],
      });
    }
    expect(fake.chatRequests()).toHaveLength(2);
    expect(cache.stats().cacheTotal).toBe(0);
  });

  it('roteamento sensível (LGPD) é fail-closed: nada de veredito reusado', async () => {
    const cache = new VerdictCache({ sample: () => 0.99 });
    const fake = fakeOpenRouter({ chat: () => ({ text: veredito('resolve') }) });
    const g = createGateway({ fetch: fake.fetch, sleep: noSleep, verdictCache: cache });
    const ledger = new BudgetLedger();
    ledger.setSensitiveRouting({ area: 'saude', routeFor: () => ({ ok: true, only: ['azure/global'], endpoints: [] }) } as never);
    await julgar(g, ledger, 0);
    await julgar(g, ledger, 0); // mesma pergunta…
    expect(fake.chatRequests()).toHaveLength(2); // …mas SEM reuso em modo sensível
    expect(cache.stats().cacheTotal).toBe(0);
  });
});

describe('IMPL-080 — o default é DESLIGADO (quem liga é a sessão)', () => {
  it('gateway sem verdictCache não conta nada nem reusa', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: veredito('resolve') }) });
    const g = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const ledger = new BudgetLedger();
    await julgar(g, ledger, 0);
    await julgar(g, ledger, 0);
    expect(fake.chatRequests()).toHaveLength(2);
    expect(ledger.snapshot().byRole.judge.cacheTotal).toBeUndefined();
    expect(VERDICT_CACHE_RETEST_RATE).toBeCloseTo(0.1);
  });
});