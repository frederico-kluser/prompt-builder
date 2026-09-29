// Modo JEV — contrato do GATEWAY de decisões (`decide`, catálogo de decisões,
// contabilidade no ponto único, PII, LGPD, erros). Tudo contra o FAKE: nenhuma
// rede, nenhum gasto.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createGateway,
  deriveDecisionsUrl,
  extractDecisionUsage,
  gatewayErrorKind,
  peekCostSamples,
  resetCostSamples,
  DECISION_REQUEST_OVERHEAD_TOKENS,
} from '../src/openrouter.js';
import { gatewayConfigFromEnv } from '../src/gatewayEnv.js';
import { BudgetLedger, isControlSignal } from '../src/budget.js';
import { makeCallEstimator } from '../src/estimate.js';
import { fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { DECISION_CATALOG, edge400, upstream400 } from './fakeDecisions.js';

const KEY = 'sk-or-v1-fake-key-para-testes-0000';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const QUESTIONS = {
  is_bug: { type: 'noul', instructions: 'O cliente relata um defeito?', criteria: { true: 'quebrado', false: 'pedido' } },
  team: { type: 'choice', instructions: 'Qual time?', criteria: { pagamentos: 'cobrança', frontend: 'tela', outro: null } },
};

function gw(fake: ReturnType<typeof fakeOpenRouter>, extra: Record<string, unknown> = {}) {
  return createGateway({ fetch: fake.fetch, sleep: noSleep, ...extra });
}

describe('decide() — fio', () => {
  it('POST no endpoint de decisões com {model, state, questions, session_id} e SEM temperature/max_tokens/user', async () => {
    const fake = fakeOpenRouter({});
    const g = gw(fake);
    const r = await g.decide({ apiKey: KEY, modelId: 'typesafe/jev-1.13', state: 'Checkout quebrado', questions: QUESTIONS, sessionId: 'run-1' });
    const [req] = fake.decisionRequests();
    expect(req.url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(req.method).toBe('POST');
    expect(Object.keys(req.body!).sort()).toEqual(['model', 'questions', 'session_id', 'state']);
    expect(req.body).toMatchObject({ model: 'typesafe/jev-1.13', state: 'Checkout quebrado', session_id: 'run-1' });
    expect(req.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(r.resolvedModel).toBe('typesafe/jev-1.13-20260917');
    expect(r.generationId).toBe('gen-dec-0');
    expect(r.provider).toBe('TypeSafe');
    expect(Object.keys(r.answers).sort()).toEqual(['is_bug', 'team']);
  });

  it('URL derivada da baseUrl (proxy/mock) e explícita por OPENROUTER_DECISIONS_URL', async () => {
    expect(deriveDecisionsUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(deriveDecisionsUrl('http://127.0.0.1:9/api/v1/')).toBe('http://127.0.0.1:9/api/alpha/decisions');
    expect(deriveDecisionsUrl('http://mock')).toBe('http://mock/alpha/decisions');
    expect(gatewayConfigFromEnv({ OPENROUTER_DECISIONS_URL: ' http://x/dec ' }).decisionsUrl).toBe('http://x/dec');
    const fake = fakeOpenRouter({});
    const g = gw(fake, { baseUrl: 'http://mock/api/v1' });
    await g.decide({ apiKey: KEY, modelId: 'm', state: 'x', questions: QUESTIONS });
    expect(fake.decisionRequests()[0].url).toBe('http://mock/api/alpha/decisions');
    g.configure({ decisionsUrl: 'http://outro/alpha/decisions' });
    await g.decide({ apiKey: KEY, modelId: 'm', state: 'y', questions: QUESTIONS });
    expect(fake.decisionRequests()[1].url).toBe('http://outro/alpha/decisions');
  });

  it('extractDecisionUsage lê input_tokens/output_tokens/cost (nunca prompt_tokens)', () => {
    expect(extractDecisionUsage({ input_tokens: 415, output_tokens: 70, cost: 0.00001743 })).toEqual({ tokensIn: 415, tokensOut: 70, cost: 0.00001743 });
    expect(extractDecisionUsage({ prompt_tokens: 9 })).toEqual({ tokensIn: 0, tokensOut: 0, cost: undefined });
    expect(extractDecisionUsage(null)).toEqual({ tokensIn: 0, tokensOut: 0 });
  });
});

describe('decide() — dinheiro no ponto único', () => {
  it('ledger recebe tokensIn = input_tokens, fonte usage, e o total BATE com a fatura do fake; sem amostra de calibração', async () => {
    resetCostSamples();
    const fake = fakeOpenRouter({ decisionCatalog: DECISION_CATALOG });
    const g = gw(fake);
    await g.listDecisionModels(KEY);
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    for (let i = 0; i < 3; i++) {
      await g.decide({ apiKey: KEY, modelId: 'typesafe/jev-1.13', state: `caso ${i}`, questions: QUESTIONS, sink: ledger });
    }
    const snap = ledger.snapshot();
    expect(snap.byRole.competitor.calls).toBe(3);
    expect(snap.accuracy).toMatchObject({ exact: 3, unknown: 0 });
    expect(ledger.spentUsd).toBeCloseTo(fake.billedUsd(), 12);
    expect(snap.byRole.competitor.tokensIn).toBeGreaterThanOrEqual(3 * 270);
    // Decisão nunca vira amostra da calibração de custo do LLM (crítica A1.2).
    expect(peekCostSamples().length).toBe(0);
  });

  it('reserva precificada pelo catálogo de DECISÕES: duas decisões em voo com teto (sem serializar)', async () => {
    let chegaram = 0;
    let soltar!: () => void;
    const barreira = new Promise<void>((r) => (soltar = r));
    const fake = fakeOpenRouter({
      decisionCatalog: DECISION_CATALOG,
      decisions: async () => {
        chegaram += 1;
        if (chegaram === 2) soltar();
        await barreira;
        return {};
      },
    });
    const g = gw(fake);
    await g.listDecisionModels(KEY);
    expect(g.cachedModel(KEY, 'typesafe/jev-1.13')?.pricing.prompt).toBeCloseTo(0.042e-6, 15);
    const decisoes = await g.listDecisionModels(KEY);
    const ledger = new BudgetLedger({ budgetUsd: 0.01, estimateCall: makeCallEstimator(decisoes) });
    const t0 = Date.now();
    await Promise.all([
      g.decide({ apiKey: KEY, modelId: 'typesafe/jev-1.13', state: 'a', questions: QUESTIONS, sink: ledger }),
      g.decide({ apiKey: KEY, modelId: 'typesafe/jev-1.13', state: 'b', questions: QUESTIONS, sink: ledger }),
    ]);
    expect(chegaram).toBe(2);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('reserva de decisão NÃO usa o teto de saída do chat (DEFAULT_MAX_TOKENS): saída 0', async () => {
    const vistos: { prompt: number; max: number }[] = [];
    const fake = fakeOpenRouter({ decisionCatalog: DECISION_CATALOG });
    const g = gw(fake);
    await g.listDecisionModels(KEY);
    const sink = new BudgetLedger({ budgetUsd: 1 });
    const orig = sink.reserve.bind(sink);
    sink.reserve = (role, modelId, prompt, max, fb) => {
      vistos.push({ prompt, max });
      return orig(role, modelId, prompt, max, fb);
    };
    await g.decide({ apiKey: KEY, modelId: 'typesafe/jev-1.13', state: 'x', questions: QUESTIONS, sink });
    expect(vistos[0].max).toBe(0);
    expect(vistos[0].prompt).toBeGreaterThan(DECISION_REQUEST_OVERHEAD_TOKENS);
  });

  it('resposta 200 SEM usage → pendente conciliável pelo x-generation-id (nunca "custou zero")', async () => {
    const fake = fakeOpenRouter({ decisionCatalog: DECISION_CATALOG, decisions: () => ({ usage: null }) });
    const g = gw(fake);
    await g.listDecisionModels(KEY);
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    const r = await g.decide({ apiKey: KEY, modelId: 'typesafe/jev-1.13', state: 'x', questions: QUESTIONS, sink: ledger });
    expect(r.cost.source).toBe('unknown');
    expect(r.cost.pendingUsd).toBeGreaterThan(0);
    expect(ledger.pendingEntries()).toEqual([expect.objectContaining({ generationId: 'gen-dec-0', role: 'competitor', reason: 'no_usage' })]);
  });

  it('429 com Retry-After → re-tenta; 402 → no_credit; 400 do EDGE libera a reserva; 400 UPSTREAM com id fica pendente', async () => {
    let n = 0;
    const fake = fakeOpenRouter({
      decisionCatalog: DECISION_CATALOG,
      decisions: (req) => {
        n += 1;
        const s = String(req.state);
        if (s === 'rate' && n === 1) return { status: 429, bodyText: '{"error":{"message":"rate"}}', headers: { 'retry-after': '0' } };
        if (s === 'credito') return { status: 402, bodyText: '{"error":{"message":"sem credito"}}' };
        if (s === 'edge') return { status: 400, bodyText: edge400([{ path: ['questions', 'q', 'criteria', 'false'], message: 'Invalid input', code: 'invalid_union' }]) };
        if (s === 'upstream') return { status: 400, bodyText: upstream400('Too many choices.'), headers: { 'x-generation-id': 'gen-dec-up' } };
        return {};
      },
    });
    const g = gw(fake);
    await g.listDecisionModels(KEY);
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    await g.decide({ apiKey: KEY, modelId: 'typesafe/jev-1.13', state: 'rate', questions: QUESTIONS, sink: ledger });
    expect(fake.decisionRequests().length).toBe(2);

    const e402 = await g.decide({ apiKey: KEY, modelId: 'typesafe/jev-1.13', state: 'credito', questions: QUESTIONS, sink: ledger }).catch((e: unknown) => e);
    expect(gatewayErrorKind(e402)).toBe('no_credit');

    const antes = ledger.committedUsd;
    const eEdge = (await g.decide({ apiKey: KEY, modelId: 'typesafe/jev-1.13', state: 'edge', questions: QUESTIONS, sink: ledger }).catch((e: unknown) => e)) as Error;
    expect(gatewayErrorKind(eEdge)).toBe('http');
    expect(eEdge.message).toContain('invalid_union');
    expect(ledger.committedUsd).toBeCloseTo(antes, 12); // reserva devolvida
    const reqsAntes = fake.decisionRequests().length;

    const eUp = await g.decide({ apiKey: KEY, modelId: 'typesafe/jev-1.13', state: 'upstream', questions: QUESTIONS, sink: ledger }).catch((e: unknown) => e);
    expect(gatewayErrorKind(eUp)).toBe('http');
    expect(fake.decisionRequests().length).toBe(reqsAntes + 1); // 400 não re-tenta
    expect(ledger.pendingEntries().map((p) => p.generationId)).toContain('gen-dec-up');
  });

  it('abort externo em voo → sinal de CONTROLE e reserva pendente/conservadora (nunca devolvida)', async () => {
    const ac = new AbortController();
    const fake = fakeOpenRouter({
      decisionCatalog: DECISION_CATALOG,
      decisions: async (req) => {
        ac.abort('SIGINT');
        await new Promise((r) => setTimeout(r, 5));
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        void req;
      },
    });
    const g = gw(fake);
    await g.listDecisionModels(KEY);
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    const err = await g.decide({ apiKey: KEY, modelId: 'typesafe/jev-1.13', state: 'x', questions: QUESTIONS, sink: ledger, signal: ac.signal }).catch((e: unknown) => e);
    expect(isControlSignal(err)).toBe(true);
    expect(ledger.spentUsd + ledger.pendingUsd).toBeGreaterThan(0);
    // abort ANTES do envio: nada sai
    const ac2 = new AbortController();
    ac2.abort('x');
    const n = fake.decisionRequests().length;
    const err2 = await g.decide({ apiKey: KEY, modelId: 'typesafe/jev-1.13', state: 'y', questions: QUESTIONS, sink: ledger, signal: ac2.signal }).catch((e: unknown) => e);
    expect(isControlSignal(err2)).toBe(true);
    expect(fake.decisionRequests().length).toBe(n);
  });
});

describe('decide() — LGPD e dado pessoal', () => {
  it('estado e perguntas passam pela cascata (protectDeep): CPF sai pseudonimizado, mesmo fundo, e conta 1 varredura', async () => {
    const fake = fakeOpenRouter({});
    const g = gw(fake);
    let fundo: Record<string, unknown> = { cpf: '529.982.247-25' };
    for (let i = 0; i < 11; i++) fundo = { nivel: fundo };
    await g.decide({
      apiKey: KEY,
      modelId: 'typesafe/jev-1.13',
      state: { clienteId: '529.982.247-25', fundo, email: 'joana.prado@gmail.com' },
      questions: { ...QUESTIONS, cpf_ok: { type: 'noul', instructions: 'O CPF 529.982.247-25 aparece?' } },
    });
    const corpo = JSON.stringify(fake.decisionRequests()[0].body);
    expect(corpo).not.toContain('529.982.247-25');
    expect(corpo).not.toContain('joana.prado@gmail.com');
    expect(corpo).toMatch(/\[CPF_[0-9a-f]{12}\]/);
    // chaves de opção e ids intactos
    expect(corpo).toContain('"pagamentos"');
    expect(corpo).toContain('"clienteId"');
    expect(g.piiStats()).toMatchObject({ scannedCalls: 1, redactedCalls: 1 });
  });

  it('área sensível: modelo fora da allowlist ZDR é recusado ANTES do fetch (fail-closed)', async () => {
    const fake = fakeOpenRouter({ decisionCatalog: DECISION_CATALOG });
    const g = gw(fake);
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    ledger.setSensitiveRouting({
      area: 'saude',
      routeFor: () => ({ ok: false, motivo: 'modelo_desconhecido', message: 'fora da allowlist' }),
    });
    const err = (await g.decide({ apiKey: KEY, modelId: 'typesafe/jev-1.13', state: 'x', questions: QUESTIONS, sink: ledger }).catch((e: unknown) => e)) as { code?: string };
    expect(err.code).toBe('LGPD_POLICY');
    expect(fake.decisionRequests().length).toBe(0);
  });
});

describe('catálogo de decisões', () => {
  it('GET /models?output_modalities=decisions, com cache próprio; cachedModel acha o modelo de decisão', async () => {
    const fake = fakeOpenRouter({ decisionCatalog: DECISION_CATALOG, catalog: [] });
    const g = gw(fake);
    const a = await g.listDecisionModels(KEY);
    const b = await g.listDecisionModels(KEY);
    expect(a).toBe(b);
    const gets = fake.requests.filter((r) => r.method === 'GET');
    expect(gets.length).toBe(1);
    expect(gets[0].url).toContain('output_modalities=decisions');
    // jev-router (saída text) é filtrado; o resto é decisão
    expect(a.map((m) => m.id)).not.toContain('typesafe/jev-router');
    expect(a.map((m) => m.id)).toEqual(expect.arrayContaining(['typesafe/jev-1.13', 'upstage/solar-decide', 'jaredpalmer/kev-4b']));
    expect(a.find((m) => m.id === 'jaredpalmer/kev-4b')?.contextLength).toBe(8192);
    expect(a.find((m) => m.id === 'respan/span-01')?.contextLength).toBeUndefined();
    expect(g.cachedModel(KEY, 'jaredpalmer/kev-4b')?.id).toBe('jaredpalmer/kev-4b');
    expect(g.peekDecisionModelsCache(KEY)?.data.length).toBe(a.length);
  });
});

function arquivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome);
    if (statSync(p).isDirectory()) {
      if (nome === 'node_modules' || nome === 'data' || nome === 'dist') continue;
      out.push(...arquivosTs(p));
    } else if (/\.(ts|tsx)$/.test(nome)) out.push(p);
  }
  return out;
}

describe('decide() × registo por chamada (merge com ciclos: IMPL-074/075)', () => {
  it('a decisão MEDIDA leva o x-generation-id ao callLog (ponte com a fatura), como todo 200 de chat', async () => {
    const fake = fakeOpenRouter({ decisionCatalog: DECISION_CATALOG });
    const g = gw(fake);
    await g.listDecisionModels(KEY);
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    const r = await g.decide({ apiKey: KEY, modelId: 'typesafe/jev-1.13', state: 'x', questions: QUESTIONS, sink: ledger });
    const log = ledger.callLog();
    expect(log).toHaveLength(1);
    expect(r.generationId).toBe('gen-dec-0');
    expect(log[0]).toMatchObject({ role: 'competitor', modelId: 'typesafe/jev-1.13', status: 'measured', generationId: 'gen-dec-0', provider: 'TypeSafe' });
    expect(typeof log[0].latencyMs).toBe('number');
  });

  it('decisão NUNCA se declara auditável: o corpo não leva o pin de provedor, mesmo com o papel na política', async () => {
    const fake = fakeOpenRouter({ decisionCatalog: DECISION_CATALOG });
    const g = gw(fake, { auditableRoles: ['competitor'] });
    await g.listDecisionModels(KEY);
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    ledger.setAuditableRoles(['competitor']);
    await g.decide({ apiKey: KEY, modelId: 'typesafe/jev-1.13', state: 'x', questions: QUESTIONS, sink: ledger });
    expect(fake.decisionRequests()[0].body).not.toHaveProperty('provider');
    expect(ledger.callLog()[0].auditable).toBeUndefined();
    expect(ledger.snapshot().byRole.competitor.auditableCalls).toBeUndefined();
  });

  it('o chat segue marcando auditável pelo MESMO auditableFor que monta o corpo (recorte contábil)', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: 'ok' }) });
    const g = gw(fake, { auditableRoles: ['judge'] });
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    const res = await g.chatCompletion({ apiKey: KEY, modelId: 'm/x', messages: [{ role: 'user', content: 'oi' }], role: 'judge', sink: ledger });
    expect(fake.chatRequests()[0].body?.provider).toMatchObject({ allow_fallbacks: false });
    expect(res.auditable).toBe(true);
    expect(ledger.callLog()[0].auditable).toBe(true);
  });
});

describe('L6: na SPA o Retry-After não é legível (CORS) — o AIMD é a proteção', () => {
  it('429 sem Retry-After (o que o JavaScript do navegador enxerga): recua, corta a janela AIMD e repete', async () => {
    // O preflight de /alpha/decisions expõe só X-Generation-Id, X-Provider-Name,
    // request-id e cf-ray: o 429 chega à aba SEM header de espera legível.
    const fake = fakeOpenRouter({
      decisionCatalog: DECISION_CATALOG,
      decisions: (_req, n) => (n === 0 ? { status: 429, bodyText: JSON.stringify({ error: { message: 'rate limited', code: 429 } }) } : {}),
    });
    const esperas: number[] = [];
    const g = createGateway({ fetch: fake.fetch, sleep: async (ms) => void esperas.push(ms) });
    const antes = g.currentConcurrency(KEY, 'typesafe/jev-1.13').limit;
    const r = await g.decide({ apiKey: KEY, modelId: 'typesafe/jev-1.13', state: 'x', questions: QUESTIONS });
    expect(Object.keys(r.answers).sort()).toEqual(['is_bug', 'team']);
    expect(fake.decisionRequests()).toHaveLength(2);
    expect(esperas).toHaveLength(1);
    expect(esperas[0]).toBeGreaterThan(0);
    expect(g.currentConcurrency(KEY, 'typesafe/jev-1.13').limit).toBeLessThan(antes);
  });

  it('a doc da SPA não promete backoff pelo Retry-After', () => {
    const fonte = readFileSync(join(ROOT, 'web', 'src', 'jev', 'api.ts'), 'utf8');
    expect(fonte).toMatch(/Retry-After[\s\S]{0,200}NÃO os lê/);
  });
});

describe('prova ESTÁTICA do ponto único de decisões', () => {
  it('só src/openrouter.ts fala com o endpoint de decisões (Node e SPA)', () => {
    const quem = [...arquivosTs(join(ROOT, 'src')), ...arquivosTs(join(ROOT, 'web', 'src'))]
      .filter((f) => readFileSync(f, 'utf8').includes('/alpha/decisions'))
      .map((f) => f.slice(ROOT.length));
    expect(quem).toEqual(['src/openrouter.ts']);
  });

  it('o corpo da decisão sai de buildDecisionBody, que passa por protectDeep e applySensitiveRouting', () => {
    const fonte = readFileSync(join(ROOT, 'src', 'openrouter.ts'), 'utf8');
    expect(fonte.match(/const body = this\.buildDecisionBody\(/g)?.length).toBe(1);
    const corpo = /private buildDecisionBody\([\s\S]*?\n {2}\}\n/.exec(fonte)?.[0] ?? '';
    expect(corpo).toContain('this.piiGuard.protectDeep(');
    expect(corpo).toContain('applySensitiveRouting(body');
    expect(corpo).not.toMatch(/temperature|max_tokens|reasoning|\buser\b/);
    const post = /this\.decisionsUrlOf\(\),\s*\{[^}]*\}/.exec(fonte)?.[0] ?? '';
    expect(post).toContain('body: JSON.stringify(body)');
  });
});
