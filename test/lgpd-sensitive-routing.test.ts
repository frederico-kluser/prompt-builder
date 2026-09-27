// IMPL-040 (R-16:REC-1) — modo "dados sensíveis" com ENFORCEMENT no gateway.
//
// Antes: o pré-voo (IMPL-041) recusava a run fora da allowlist, mas 0% das
// requisições carregavam campo de privacidade — `allow_fallbacks` ficava no
// default (true) e o OpenRouter podia rotear para endpoint que retém dados.
//
// Contratos provados aqui (transporte FALSO, zero rede, zero gasto):
//   (1) Node + SPA, os 6 papéis (datagen/gabarito/competidor/juiz/duelo/
//       reescritor): 100% das requisições sensíveis saem com
//       provider { zdr:true, data_collection:'deny', only:[allowlist],
//       allow_fallbacks:false } — 0 exceções — e o "snapshot" por papel bate;
//   (2) política sensível sem allowlist (ou com rota malformada) ⇒
//       chatCompletion/chatCompletionStream lançam ANTES do fetch (0 chamadas
//       de rede no mock, 0 reserva pendurada no ledger);
//   + o modo não afrouxa (ledger só liga; forks herdam) e não vaza para fora
//     dele (área "geral"/sem compliance segue sem os campos).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../src/engine/lgpdCore.js';
import {
  applySensitiveRouting,
  hasSensitiveProviderFields,
  sensitiveRoutingFor,
  type SensitiveRouting,
} from '../src/engine/sensitiveRouting.js';
import * as nodeLgpd from '../src/lgpd.js';
import * as webLgpd from '../web/src/lgpd.js';
import * as nodeGw from '../src/openrouter.js';
import * as webGw from '../web/src/engine/openrouter.js';
import { BudgetLedger } from '../src/budget.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { trainToCompletion as trainNode } from '../src/trainer.js';
import { prepareOptsFor } from '../src/prepareRun.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { startTraining as startWebTraining } from '../web/src/engine/trainer.js';
import { getRunRecord, subscribeRun, subscribeSession } from '../web/src/engine/events.js';
import type { CostEntry, CostRole, RunConfig, TrainingConfig } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter, type FakeRequest } from './fakeOpenRouter.js';

// O storage do web é IndexedDB — fora do navegador, um no-op em memória.
vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const BASE: core.LgpdData = { ...nodeLgpd.getLgpdData(), allowlist: null };

// Um modelo por papel (criadores CONHECIDOS): o `only` esperado muda com o
// provedor, então um papel com a rota trocada também reprova o snapshot.
const M = {
  gen: 'mistralai/gen',
  ref: 'mistralai/ref',
  judge: 'anthropic/judge',
  a: 'mistralai/a',
  b: 'anthropic/b',
  opt: 'mistralai/opt',
};
const TAG = (id: string): string => (id.startsWith('mistralai/') ? 'mistral/eu' : 'amazon-bedrock/us');

/** Snapshot sintético fresco: os 6 modelos com endpoint ZDR de provedor mapeado. */
function dadosLiberando(): core.LgpdData {
  const ids = Object.values(M);
  const snap = core.buildAllowlistSnapshot({
    models: { data: ids.map((id) => ({ id, name: id })) },
    zdr: {
      data: ids.map((id) => ({
        model_id: id,
        provider_name: id.startsWith('mistralai/') ? 'Mistral' : 'Amazon Bedrock',
        tag: TAG(id),
      })),
    },
    now: Date.now(),
    fonte: 'teste',
  });
  return { ...BASE, allowlist: snap };
}

const PRIVACIDADE = (id: string) => ({
  zdr: true,
  data_collection: 'deny',
  only: [TAG(id)],
  allow_fallbacks: false,
});

const CENARIOS = [
  {
    question: 'Qual o prazo para remarcar uma consulta?',
    productContext: 'Politica: remarcacao gratuita ate 24h antes.',
    maxTokens: 300,
    rubric: 'Deve citar 24h.',
  },
  {
    question: 'Posso levar acompanhante no exame?',
    productContext: 'Um acompanhante por paciente.',
    maxTokens: 300,
    rubric: 'Deve citar um acompanhante.',
  },
];

function fakePipeline(): FakeOpenRouter {
  return fakeOpenRouter({
    catalog: Object.values(M).map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: (req, n) => {
      const usage = { prompt_tokens: 50, completion_tokens: 10, cost: 0.0001 * (n + 1) };
      if (req.model === M.gen) return { text: JSON.stringify({ stages: CENARIOS }), usage };
      if (req.model === M.opt) {
        const tecnica = /tecnica id="([^"]+)"/.exec(req.user)?.[1] ?? 'x';
        return {
          text: `Voce e um atendente cordial e preciso (${tecnica}). Responda com base no contexto, cite prazos exatamente e recuse o que estiver fora do escopo.`,
          usage,
        };
      }
      if (req.model === M.ref) return { text: `Gabarito: ${req.user.slice(0, 40)}`, usage };
      if (req.stream) return { text: `Resposta de ${req.model}`, usage };
      if (req.system.includes('DUELO')) return { text: '{"winner":"A","explanation":"A melhor"}', usage };
      return { text: '{"verdict":"resolve","explanation":"confere"}', usage };
    },
  });
}

/** Papel de uma requisição (pelo modelo; juiz × duelo pelo prompt de sistema). */
function papelDe(req: FakeRequest): CostRole {
  if (req.model === M.gen) return 'datagen';
  if (req.model === M.ref) return 'gabarito';
  if (req.model === M.opt) return 'rewriter';
  if (req.model === M.a || req.model === M.b) return 'competitor';
  return req.system.includes('DUELO') ? 'duel' : 'judge';
}

interface Auditoria {
  /** Requisições de chat SEM os 4 campos exatos (tem de ser 0). */
  excecoes: number;
  total: number;
  /** Snapshot por papel: chamadas + os `provider` distintos enviados. */
  porPapel: Partial<Record<CostRole, { calls: number; providers: unknown[] }>>;
}

function auditar(fake: FakeOpenRouter): Auditoria {
  const out: Auditoria = { excecoes: 0, total: 0, porPapel: {} };
  for (const req of fake.chatRequests()) {
    out.total += 1;
    const provider = req.body?.provider;
    const esperado = PRIVACIDADE(req.model);
    if (!hasSensitiveProviderFields(provider) || JSON.stringify(provider) !== JSON.stringify(esperado)) {
      out.excecoes += 1;
    }
    const slot = (out.porPapel[papelDe(req)] ??= { calls: 0, providers: [] });
    slot.calls += 1;
    if (!slot.providers.some((p) => JSON.stringify(p) === JSON.stringify(provider))) slot.providers.push(provider);
  }
  return out;
}

/** O ledger da run viu exatamente as chamadas auditadas, papel a papel. */
function conferirLedger(
  a: Auditoria,
  byRole: Record<CostRole, CostEntry> | undefined,
  papeis: CostRole[],
): void {
  expect(byRole, 'record sem costByRole').toBeDefined();
  for (const r of papeis) {
    expect(a.porPapel[r]?.calls, `papel ${r} sem requisição`).toBeGreaterThan(0);
    expect(byRole![r].calls, `ledger × requisições em ${r}`).toBe(a.porPapel[r]!.calls);
  }
}

const SNAPSHOT_ESPERADO: Record<Exclude<CostRole, 'agent'>, unknown[]> = {
  datagen: [PRIVACIDADE(M.gen)],
  gabarito: [PRIVACIDADE(M.ref)],
  competitor: [PRIVACIDADE(M.a), PRIVACIDADE(M.b)],
  judge: [PRIVACIDADE(M.judge)],
  duel: [PRIVACIDADE(M.judge)],
  rewriter: [PRIVACIDADE(M.opt)],
};

function conferirSnapshot(a: Auditoria, papeis: Array<keyof typeof SNAPSHOT_ESPERADO>): void {
  expect(a.total).toBeGreaterThan(0);
  expect(a.excecoes, '100% das requisições sensíveis com os 4 campos').toBe(0);
  expect(Object.keys(a.porPapel).sort()).toEqual([...papeis].sort());
  for (const r of papeis) {
    const enviados = a.porPapel[r]!.providers.map((p) => JSON.stringify(p)).sort();
    const esperados = SNAPSHOT_ESPERADO[r]
      .filter((p) => r !== 'competitor' || enviados.includes(JSON.stringify(p)))
      .map((p) => JSON.stringify(p))
      .sort();
    expect(enviados, `snapshot do provider em ${r}`).toEqual(esperados);
  }
}

const BASE_CFG = {
  theme: 'agendamento de exames',
  stages: 2,
  datagenModelId: M.gen,
  judgeModelIds: [M.judge],
  referenceModelId: M.ref,
  referenceJudging: true,
  finalists: 2,
  timeoutMs: 5_000,
  compliance: { area: 'saude', includeRessalvas: true },
} as const;

const COMPARE = { ...BASE_CFG, mode: 'compare', competitorModelIds: [M.a, M.b] } as const;

const VARIATION = {
  ...BASE_CFG,
  mode: 'variation',
  contestantModelId: M.a,
  basePrompt: 'Voce e um atendente de suporte. Responda com base no contexto do produto.',
  techniqueIds: ['persona', 'constraints'],
  promptOptimization: true,
  optimizerModelId: M.opt,
} as const;

const TREINO = {
  ...VARIATION,
  mode: 'training',
  iterations: 1,
  holdoutRatio: 0,
} as const;

const SEIS: Array<keyof typeof SNAPSHOT_ESPERADO> = ['datagen', 'gabarito', 'competitor', 'judge', 'duel', 'rewriter'];
const CINCO = SEIS.filter((r) => r !== 'rewriter');

async function esperarRunWeb(runId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('run não terminou')), 10_000);
    const fim = (): void => {
      clearTimeout(t);
      unsub();
      resolve();
    };
    const unsub = subscribeRun(runId, (e) => {
      if (e.type === 'run.finished' || e.type === 'run.error') fim();
    });
    if (getRunRecord(runId)?.status !== 'running') fim();
  });
}

async function esperarSessaoWeb(sessionId: string, record: { status: string }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sessão não terminou')), 10_000);
    const fim = (): void => {
      clearTimeout(t);
      unsub();
      resolve();
    };
    const unsub = subscribeSession(sessionId, (e) => {
      if (e.type === 'session.finished' || e.type === 'session.error') fim();
    });
    if (record.status !== 'running') fim();
  });
}

// ---------------------------------------------------------------------------
// (1) Node + SPA, 6 papéis: 100% das requisições com os 4 campos
// ---------------------------------------------------------------------------

describe('IMPL-040 (1) — toda requisição do modo sensível carrega os 4 campos (Node + SPA, 6 papéis)', () => {
  let tmp: string;
  let dirAnterior: string;
  let silencio: Array<{ mockRestore(): void }> = [];
  const restaurar: Array<() => void> = [];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl040-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
  });
  afterEach(() => {
    while (restaurar.length) restaurar.pop()!();
    vi.unstubAllGlobals();
  });
  afterAll(() => {
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Dados LGPD nos DOIS loaders + gateway padrão com transporte falso. */
  function comFake(data: core.LgpdData = dadosLiberando()): FakeOpenRouter {
    restaurar.push(nodeLgpd.overrideLgpdData(data), webLgpd.overrideLgpdData(data));
    const fake = fakePipeline();
    const anterior = nodeGw.setDefaultGateway(nodeGw.createGateway({ fetch: fake.fetch, sleep: noSleep }));
    restaurar.push(() => nodeGw.setDefaultGateway(anterior));
    return fake;
  }

  it('Node — compare: datagen, gabarito, competidor (stream), juiz e duelo com provider ZDR forçado', async () => {
    const fake = comFake();
    const rec = await runNode(COMPARE as unknown as RunConfig, KEY, {});
    expect(rec.status, rec.error).toBe('finished');
    const a = auditar(fake);
    conferirSnapshot(a, CINCO);
    conferirLedger(a, rec.costByRole, CINCO);
  });

  it('Node — variation (prepareOptsFor, como CLI/servidor/MCP): os 6 papéis, reescritor incluso', async () => {
    const fake = comFake();
    const cfg = VARIATION as unknown as RunConfig;
    const rec = await runNode(cfg, KEY, prepareOptsFor(cfg, KEY));
    expect(rec.status, rec.error).toBe('finished');
    const a = auditar(fake);
    conferirSnapshot(a, SEIS);
    conferirLedger(a, rec.costByRole, SEIS);
  });

  it('Node — treino: reescritor da sessão + runs aninhadas (forks do ledger) herdam o modo', async () => {
    const fake = comFake();
    const rec = await trainNode(TREINO as unknown as TrainingConfig, KEY);
    expect(rec.status, rec.error).toBe('finished');
    const a = auditar(fake);
    conferirSnapshot(a, SEIS);
    conferirLedger(a, rec.costByRole, SEIS);
  });

  it('SPA — compare (web/src/engine/orchestrator): mesmo gateway, mesmos 4 campos', async () => {
    const fake = comFake();
    const rec = await runWeb(COMPARE as never, KEY, {});
    expect(rec.status, rec.error).toBe('finished');
    const a = auditar(fake);
    conferirSnapshot(a, CINCO);
    conferirLedger(a, rec.costByRole, CINCO);
  });

  it('SPA — variation pelo api.ts (createRun): os 6 papéis', async () => {
    vi.stubGlobal('localStorage', { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined });
    const fake = comFake();
    const { createRun } = await import('../web/src/api.js');
    const runId = await createRun(VARIATION as never);
    await esperarRunWeb(runId);
    const rec = getRunRecord(runId)!;
    expect(rec.status, rec.error).toBe('finished');
    const a = auditar(fake);
    conferirSnapshot(a, SEIS);
    conferirLedger(a, rec.costByRole, SEIS);
  });

  it('SPA — treino (web/src/engine/trainer): sessão e runs aninhadas com os 4 campos', async () => {
    const fake = comFake();
    const { sessionId, record } = await startWebTraining(TREINO as never, KEY);
    await esperarSessaoWeb(sessionId, record);
    expect(record.status, record.error).toBe('finished');
    const a = auditar(fake);
    conferirSnapshot(a, SEIS);
    conferirLedger(a, record.costByRole, SEIS);
  });

  it('fora do modo (área "geral" consultiva / sem compliance) nenhum campo de privacidade é injetado', async () => {
    for (const compliance of [{ area: 'geral', includeRessalvas: true }, undefined]) {
      const fake = comFake();
      const rec = await runNode({ ...COMPARE, compliance } as unknown as RunConfig, KEY, {});
      expect(rec.status, rec.error).toBe('finished');
      const chats = fake.chatRequests();
      expect(chats.length).toBeGreaterThan(0);
      for (const r of chats) expect(r.body?.provider).toBeUndefined();
      while (restaurar.length) restaurar.pop()!();
    }
  });
});

// ---------------------------------------------------------------------------
// (2) fail-closed: sem os 4 campos, nenhuma requisição sai
// ---------------------------------------------------------------------------

describe('IMPL-040 (2) — política sensível sem allowlist ⇒ lança ANTES do fetch (Node e navegador)', () => {
  const MSGS = [{ role: 'user' as const, content: 'Paciente com exame agendado; qual o preparo?' }];
  const SAUDE = { compliance: { area: 'saude', includeRessalvas: true } };

  // O gateway do navegador é o MESMO módulo (shim); os dois caminhos de import
  // são exercitados para travar isso.
  const GATEWAYS = [
    ['Node (src/openrouter)', nodeGw.createGateway],
    ['navegador (web/src/engine/openrouter)', webGw.createGateway],
  ] as const;

  function ledgerCom(routing: SensitiveRouting | undefined): BudgetLedger {
    const l = new BudgetLedger({ budgetUsd: 10, estimateCall: () => 0.01 });
    l.setSensitiveRouting(routing);
    return l;
  }

  for (const [nome, criar] of GATEWAYS) {
    it(`${nome}: config sensível com allowlist AUSENTE ⇒ chat e stream lançam, 0 chamadas de rede`, async () => {
      const routing = sensitiveRoutingFor(SAUDE, BASE); // BASE.allowlist === null
      expect(routing, 'área sensível liga o modo mesmo sem allowlist').toBeDefined();
      const fake = fakeOpenRouter();
      const gw = criar({ fetch: fake.fetch, sleep: noSleep });
      const sink = ledgerCom(routing);
      const params = { apiKey: KEY, modelId: M.judge, messages: MSGS, role: 'judge' as const, sink };
      for (const chamar of [() => gw.chatCompletion(params), () => gw.chatCompletionStream(params)]) {
        const err = await chamar().then(
          () => null,
          (e: unknown) => e,
        );
        expect(core.isLgpdPolicyError(err), String(err)).toBe(true);
        expect((err as Error).message).toMatch(/Modo sensível LGPD.*ANTES do envio.*allowlist de endpoints ausente/);
        expect((err as core.LgpdPolicyError).violations[0]).toMatchObject({
          role: 'judge',
          modelId: M.judge,
          motivo: 'allowlist_ausente',
        });
      }
      expect(fake.requests, 'nenhuma chamada de rede (nem /models)').toEqual([]);
      // Lançou antes da reserva: nada pendurado no ledger.
      expect(sink.committedUsd).toBe(0);
      expect(sink.snapshot().byRole.judge.calls).toBe(0);
    });

    it(`${nome}: rota malformada (only vazio/inválido) nunca vira requisição sem os 4 campos`, async () => {
      for (const only of [[], ['  '], [42 as unknown as string]]) {
        const quebrada: SensitiveRouting = {
          area: 'saude',
          routeFor: () => ({ ok: true, only, endpoints: [] }),
        };
        const fake = fakeOpenRouter();
        const gw = criar({ fetch: fake.fetch, sleep: noSleep });
        const err = await gw
          .chatCompletion({ apiKey: KEY, modelId: M.a, messages: MSGS, sink: ledgerCom(quebrada) })
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(core.isLgpdPolicyError(err), String(err)).toBe(true);
        expect((err as core.LgpdPolicyError).violations[0].motivo).toBe('roteamento_incompleto');
        expect(fake.requests).toEqual([]);
      }
    });

    it(`${nome}: modelo fora da allowlist (snapshot presente) ⇒ recusa antes do fetch`, async () => {
      const routing = sensitiveRoutingFor(SAUDE, dadosLiberando())!;
      const fake = fakeOpenRouter();
      const gw = criar({ fetch: fake.fetch, sleep: noSleep });
      const err = await gw
        .chatCompletionStream({
          apiKey: KEY,
          modelId: 'mistralai/fora-da-allowlist',
          messages: MSGS,
          role: 'duel',
          sink: ledgerCom(routing),
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(core.isLgpdPolicyError(err), String(err)).toBe(true);
      expect((err as core.LgpdPolicyError).violations[0]).toMatchObject({ role: 'judge', motivo: 'modelo_desconhecido' });
      expect(fake.requests).toEqual([]);
    });

    it(`${nome}: com rota válida a requisição sai com os 4 campos e preserva max_price`, async () => {
      const fake = fakeOpenRouter();
      const gw = criar({ fetch: fake.fetch, sleep: noSleep });
      await gw.chatCompletion({
        apiKey: KEY,
        modelId: M.b,
        messages: MSGS,
        maxPricePerMTok: { prompt: 3, completion: 15 },
        sink: ledgerCom(sensitiveRoutingFor(SAUDE, dadosLiberando())),
      });
      expect(fake.chatRequests()).toHaveLength(1);
      expect(fake.chatRequests()[0].body?.provider).toEqual({
        max_price: { prompt: 3, completion: 15 },
        ...PRIVACIDADE(M.b),
      });
    });
  }

  it('o ledger só LIGA o modo (undefined posterior não afrouxa) e os forks herdam', () => {
    const routing = sensitiveRoutingFor(SAUDE, dadosLiberando());
    const raiz = new BudgetLedger();
    expect(raiz.sensitiveRouting()).toBeUndefined();
    raiz.setSensitiveRouting(routing);
    raiz.setSensitiveRouting(undefined);
    expect(raiz.sensitiveRouting()).toBe(routing);
    const neto = raiz.fork().fork();
    expect(neto.sensitiveRouting()).toBe(routing);
  });

  it('applySensitiveRouting sobrescreve campos afrouxados e hasSensitiveProviderFields exige os 4', () => {
    const routing = sensitiveRoutingFor(SAUDE, dadosLiberando())!;
    const body: Record<string, unknown> = {
      provider: { zdr: false, data_collection: 'allow', allow_fallbacks: true, only: ['qualquer'], sort: 'price' },
    };
    applySensitiveRouting(body, routing, M.a, 'competitor');
    expect(body.provider).toEqual({ sort: 'price', ...PRIVACIDADE(M.a) });

    const ok = PRIVACIDADE(M.a);
    expect(hasSensitiveProviderFields(ok)).toBe(true);
    for (const campo of ['zdr', 'data_collection', 'only', 'allow_fallbacks'] as const) {
      const sem: Record<string, unknown> = { ...ok };
      delete sem[campo];
      expect(hasSensitiveProviderFields(sem), `sem ${campo}`).toBe(false);
    }
    expect(hasSensitiveProviderFields({ ...ok, allow_fallbacks: undefined })).toBe(false);
    expect(hasSensitiveProviderFields(undefined)).toBe(false);
  });

  it('o pré-voo devolve a política só em área sensível (Node e SPA)', async () => {
    const restaurar = [nodeLgpd.overrideLgpdData(dadosLiberando()), webLgpd.overrideLgpdData(dadosLiberando())];
    try {
      const cfg = { ...SAUDE, datagenModelId: M.gen, competitorModelIds: [M.a] };
      for (const enforce of [nodeLgpd.enforceRunCompliance, webLgpd.enforceRunCompliance]) {
        const pf = await enforce(cfg);
        expect(pf.sensitiveRouting?.routeFor(M.a)).toMatchObject({ ok: true, only: ['mistral/eu'] });
        expect((await enforce({ ...cfg, compliance: { area: 'geral', includeRessalvas: true } })).sensitiveRouting).toBeUndefined();
        expect((await enforce({ datagenModelId: M.gen })).sensitiveRouting).toBeUndefined();
      }
    } finally {
      restaurar.forEach((r) => r());
    }
  });
});
