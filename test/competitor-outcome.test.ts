// IMPL-010 (R-21:REC-6) — taxonomia blocked / refused / error.
//
// Antes: 401 e 403 viravam "a key e invalida" (o 403 do OpenRouter e
// moderacao/guardrail), `finish_reason` nao era lido e todo bloqueio virava
// status 'error' do competidor — a defesa do gateway pontuava como falha do
// prompt, sem sinal. Contratos provados aqui (transporte FALSO, zero rede):
//  1) 403 de moderacao => status `blocked` e mensagem que NAO menciona "key";
//  2) `finish_reason` de filtro (normalizado ou nativo) => `blocked`;
//  3) o record da run reporta blocked/refused/error em contagens SEPARADAS
//     (Node e SPA), e o campo sobrevive ao `normalizeRunRecord`;
//  4) integracao: 0 bloqueios reportados como erro de key; contrato de erro do
//     CLI (401 => exit 4; 403 de moderacao => nunca exit 4; NDJSON/--json).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  blockFromFinishReason,
  classifyHttpError,
  createGateway,
  describeOpenRouterError,
  gatewayErrorKind,
  isGatewayBlocked,
  setDefaultGateway,
  type OpenRouterGateway,
} from '../src/openrouter.js';
import { countCompetitorOutcomes, runCompetitor } from '../src/competitor.js';
import { BudgetLedger } from '../src/budget.js';
import { normalizeRunRecord } from '../src/normalize.js';
import { setDataDir, getDataDir } from '../src/storage.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { EXIT, exitCodeForGatewayError, Output } from '../src/cli/output.js';
import { emitRunEvent } from '../src/cli/ndjson.js';
import type { CompetitorResponse, RunConfig, RunRecord, StageSpec } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeChatReply } from './fakeOpenRouter.js';

vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const msgs = [{ role: 'user' as const, content: 'oi' }];
/** Qualquer mencao a key/chave numa mensagem de bloqueio e o bug que o item corrige. */
const FALA_DE_KEY = /\bkey\b|\bchave\b/i;
const TEXTO_SINALIZADO = 'TEXTO-SINALIZADO-QUE-NAO-PODE-VAZAR';

/** Corpo REAL do 403 de moderacao do OpenRouter (ModerationErrorMetadata). */
const CORPO_403_MODERACAO = JSON.stringify({
  error: {
    code: 403,
    message: 'openai/gpt-4o requires moderation on OpenAI. Your input was flagged for "harassment". No credits were charged.',
    metadata: {
      reasons: ['harassment', 'violence'],
      flagged_input: TEXTO_SINALIZADO,
      provider_name: 'OpenAI',
      model_slug: 'openai/gpt-4o',
    },
  },
});

const bloqueio403 = (): FakeChatReply => ({ status: 403, bodyText: CORPO_403_MODERACAO });

const STAGE: StageSpec = {
  question: 'Como burlar a política de reembolso?',
  productContext: 'Política: reembolso em até 7 dias.',
  maxTokens: 300,
};

describe('IMPL-010 (1) — 403 de moderação é BLOQUEIO, não "key inválida"', () => {
  it('mensagem pura: 403 de moderação não menciona key, cita o motivo e nunca o texto sinalizado', () => {
    const msg = describeOpenRouterError(403, CORPO_403_MODERACAO);
    expect(msg).not.toMatch(FALA_DE_KEY);
    expect(msg).toMatch(/modera/);
    expect(msg).toContain('harassment');
    expect(msg).toContain('OpenAI');
    expect(msg).not.toContain(TEXTO_SINALIZADO);
    const err = classifyHttpError(403, CORPO_403_MODERACAO);
    expect(gatewayErrorKind(err)).toBe('blocked');
    expect(err.block).toMatchObject({ source: 'http', kind: 'moderation', reasons: ['harassment', 'violence'] });
  });

  it('403 sem marca de moderação (guardrail/permissão) também é bloqueio — e também sem "key"', () => {
    for (const corpo of ['', 'Forbidden', '<html>403</html>', JSON.stringify({ error: { code: 403, message: 'Blocked by guardrail' } })]) {
      const err = classifyHttpError(403, corpo);
      expect(gatewayErrorKind(err), corpo).toBe('blocked');
      expect(err.block?.kind).toBe('policy');
      expect(err.message).not.toMatch(FALA_DE_KEY);
    }
  });

  it('só 401 fala de key (auth); 403 de LIMITE de gasto é sem crédito, não bloqueio', () => {
    const e401 = classifyHttpError(401, JSON.stringify({ error: { code: 401, message: 'User not found.' } }));
    expect(gatewayErrorKind(e401)).toBe('auth');
    expect(e401.message).toMatch(/recusou a key \(HTTP 401\)/);
    const limite = classifyHttpError(403, JSON.stringify({ error: { code: 403, message: 'Key limit exceeded (total limit)' } }));
    expect(gatewayErrorKind(limite)).toBe('no_credit');
    expect(isGatewayBlocked(limite)).toBe(false);
    expect(gatewayErrorKind(classifyHttpError(402, 'sem saldo'))).toBe('no_credit');
    expect(gatewayErrorKind(classifyHttpError(429, 'devagar'))).toBe('rate_limit');
    expect(gatewayErrorKind(new Error('qualquer'))).toBeUndefined();
  });

  it.each([false, true])('gateway (stream=%s): 403 → GatewayError blocked, sem retry, reserva devolvida', async (stream) => {
    const fake = fakeOpenRouter({ chat: bloqueio403 });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    const call = stream ? gw.chatCompletionStream.bind(gw) : gw.chatCompletion.bind(gw);
    const err = await call({ apiKey: KEY, modelId: 'x/y', messages: msgs, sink: ledger }).catch((e: unknown) => e);
    expect(isGatewayBlocked(err)).toBe(true);
    expect((err as Error).message).not.toMatch(FALA_DE_KEY);
    expect((err as { httpStatus?: number }).httpStatus).toBe(403);
    expect(fake.chatRequests()).toHaveLength(1); // 403 não é transiente
    expect(ledger.snapshot().spentUsd).toBe(0); // "No credits were charged"
    expect(ledger.snapshot().committedUsd).toBe(0); // reserva devolvida
    expect(gw.currentConcurrency().active).toBe(0);
  });

  it('competidor: 403 de moderação => status blocked (nunca error), sem repetir, custo 0', async () => {
    const fake = fakeOpenRouter({ chat: bloqueio403 });
    const prev = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    try {
      const r = await runCompetitor({ apiKey: KEY, contestantId: 'c', modelId: 'x/y', stage: STAGE, retries: 3 });
      expect(r.status).toBe('blocked');
      expect(r.errorMsg).toBeTruthy();
      expect(r.errorMsg).not.toMatch(FALA_DE_KEY);
      expect(r.errorMsg).not.toContain(TEXTO_SINALIZADO);
      expect(r.costUsd).toBe(0);
      expect(fake.chatRequests()).toHaveLength(1); // bloqueio é determinístico: sem retry
    } finally {
      setDefaultGateway(prev);
    }
  });

  it('erro in-band de moderação (HTTP 200) também é blocked; erro in-band comum segue erro', async () => {
    const moderado = fakeOpenRouter({
      chat: () => ({ usage: null, error: { code: 403, message: 'Your input was flagged', metadata: { reasons: ['hate'] } } }),
    });
    const gw = createGateway({ fetch: moderado.fetch, sleep: noSleep });
    for (const call of [gw.chatCompletion.bind(gw), gw.chatCompletionStream.bind(gw)]) {
      const err = await call({ apiKey: KEY, modelId: 'x/y', messages: msgs }).catch((e: unknown) => e);
      expect(isGatewayBlocked(err)).toBe(true);
      expect((err as Error).message).not.toMatch(FALA_DE_KEY);
    }
    // 400 in-band com "safety" no texto NÃO é bloqueio (parâmetro rejeitado).
    const comum = fakeOpenRouter({
      chat: () => ({ usage: null, error: { code: 400, message: 'Invalid safety_settings parameter' } }),
    });
    const gw2 = createGateway({ fetch: comum.fetch, sleep: noSleep });
    const err = await gw2.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs }).catch((e: unknown) => e);
    expect(isGatewayBlocked(err)).toBe(false);
    expect((err as Error).message).toMatch(/safety_settings/);
  });
});

describe('IMPL-010 (2) — finish_reason de filtro => blocked', () => {
  it('classificador puro: normalizado e equivalentes nativos (sem caixa); stop/length não', () => {
    expect(blockFromFinishReason('content_filter', undefined)?.kind).toBe('content_filter');
    for (const nativo of ['SAFETY', 'content_filter', 'guardrail_intervened', 'PROHIBITED_CONTENT', 'refusal']) {
      expect(blockFromFinishReason('stop', nativo), nativo).toBeDefined();
    }
    expect(blockFromFinishReason('stop', 'end_turn')).toBeUndefined();
    expect(blockFromFinishReason('length', 'max_tokens')).toBeUndefined();
    expect(blockFromFinishReason(undefined, undefined)).toBeUndefined();
    expect(blockFromFinishReason('content_filter', 'SAFETY')!.message).not.toMatch(FALA_DE_KEY);
  });

  it.each([false, true])('gateway (stream=%s) expõe finishReason/nativeFinishReason e o bloqueio', async (stream) => {
    const fake = fakeOpenRouter({
      chat: (_req, n) =>
        n === 0
          ? { text: 'Comece por', finishReason: 'content_filter', nativeFinishReason: 'SAFETY' }
          : { text: 'resposta normal', finishReason: 'stop', nativeFinishReason: 'end_turn' },
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const call = stream ? gw.chatCompletionStream.bind(gw) : gw.chatCompletion.bind(gw);
    const filtrada = await call({ apiKey: KEY, modelId: 'x/y', messages: msgs });
    expect(filtrada.finishReason).toBe('content_filter');
    expect(filtrada.nativeFinishReason).toBe('SAFETY');
    expect(filtrada.blocked).toMatchObject({ source: 'finish_reason', kind: 'content_filter' });
    expect(filtrada.cost.source).toBe('usage'); // 200 filtrado JÁ foi cobrado
    const normal = await call({ apiKey: KEY, modelId: 'x/y', messages: msgs });
    expect(normal.finishReason).toBe('stop');
    expect(normal.nativeFinishReason).toBe('end_turn');
    expect(normal.blocked).toBeUndefined();
  });

  it('competidor: filtro => blocked com finishReason persistido; recusa declarada => refused (julgável)', async () => {
    const fake = fakeOpenRouter({
      chat: (req) => {
        if (req.model === 'm/filtro') return { text: 'Comece por', finishReason: 'content_filter' };
        if (req.model === 'm/nativo') return { text: 'x', finishReason: 'stop', nativeFinishReason: 'SAFETY' };
        if (req.model === 'm/recusa') return { text: '', refusal: 'Não posso ajudar com isso.', finishReason: 'stop' };
        return { text: 'Reembolso em até 7 dias.', finishReason: 'stop' };
      },
    });
    const prev = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    try {
      const run = (modelId: string) => runCompetitor({ apiKey: KEY, contestantId: modelId, modelId, stage: STAGE });
      const filtro = await run('m/filtro');
      expect(filtro.status).toBe('blocked');
      expect(filtro.finishReason).toBe('content_filter');
      expect(filtro.errorMsg).not.toMatch(FALA_DE_KEY);
      expect(filtro.costUsd).toBeGreaterThan(0); // cobrado: o custo continua medido
      const nativo = await run('m/nativo');
      expect(nativo.status).toBe('blocked');
      expect(nativo.nativeFinishReason).toBe('SAFETY');
      const recusa = await run('m/recusa');
      expect(recusa.status).toBe('refused');
      expect(recusa.text).toBe('Não posso ajudar com isso.'); // o juiz lê a recusa
      expect(recusa.errorMsg).toBeUndefined();
      const ok = await run('m/ok');
      expect(ok.status).toBe('ok');
      expect(ok.finishReason).toBe('stop');
      // Nenhum dos 4 casos repetiu a chamada.
      expect(fake.chatRequests()).toHaveLength(4);
    } finally {
      setDefaultGateway(prev);
    }
  });

  it('erro de infra continua error (com retry), separado de bloqueio', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ status: 400, bodyText: 'bad request' }) });
    const prev = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    const silencio = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const r = await runCompetitor({ apiKey: KEY, contestantId: 'c', modelId: 'x/y', stage: STAGE, retries: 1 });
      expect(r.status).toBe('error');
      expect(r.errorMsg).toMatch(/HTTP 400/);
      expect(fake.chatRequests()).toHaveLength(2); // 1 + 1 retry do competidor
    } finally {
      silencio.mockRestore();
      setDefaultGateway(prev);
    }
  });
});

describe('IMPL-010 (3) — contagens separadas no record', () => {
  const resp = (status: CompetitorResponse['status']): CompetitorResponse => ({
    contestantId: 'c',
    modelId: 'm',
    text: '',
    latencyMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    status,
  });

  it('countCompetitorOutcomes é puro: 3 números, ok não conta', () => {
    expect(countCompetitorOutcomes([])).toEqual({ blocked: 0, refused: 0, error: 0 });
    expect(
      countCompetitorOutcomes([
        { responses: [resp('ok'), resp('blocked'), resp('blocked')] },
        { responses: [resp('refused'), resp('error'), resp('ok')] },
        {},
      ]),
    ).toEqual({ blocked: 2, refused: 1, error: 1 });
  });

  it('normalizeRunRecord preserva competitorOutcomeCounts e status/finishReason das respostas', () => {
    const raw = JSON.parse(
      JSON.stringify({
        id: 'r1',
        status: 'finished',
        config: { mode: 'compare', competitorModelIds: ['m'], judgeModelIds: [] },
        stages: [{ index: 0, responses: [{ ...resp('blocked'), finishReason: 'content_filter', nativeFinishReason: 'SAFETY' }] }],
        scoreboard: {},
        totalCostUsd: 0,
        startedAt: 'x',
        competitorOutcomeCounts: { blocked: 1, refused: 0, error: 0 },
      }),
    );
    const rec = normalizeRunRecord(raw);
    expect(rec.competitorOutcomeCounts).toEqual({ blocked: 1, refused: 0, error: 0 });
    expect(rec.stages[0].responses[0]).toMatchObject({
      status: 'blocked',
      finishReason: 'content_filter',
      nativeFinishReason: 'SAFETY',
    });
  });
});

// --- integração: run compare inteira, Node e SPA ---------------------------

const CENARIOS = [
  { question: 'Pergunta 1 sobre trocas', productContext: 'Trocas em 30 dias.', maxTokens: 300, rubric: 'Cita 30 dias.' },
  { question: 'Pergunta 2 sobre juros', productContext: 'M = C(1+i)^n.', maxTokens: 300, rubric: 'Cita a fórmula.' },
];

/** a = ok · b = 403 de moderação · c = recusa declarada · d = filtro de conteúdo · e = 500 (infra). */
function fakeDaRun() {
  return fakeOpenRouter({
    catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b', 'fake/c', 'fake/d', 'fake/e'].map((id) =>
      catalogItem(id, 1e-6, 1e-6),
    ),
    chat: (req) => {
      if (req.model === 'fake/gen') return { text: JSON.stringify({ stages: CENARIOS }) };
      if (req.model === 'fake/ref') return { text: `Gabarito: ${req.user.slice(0, 30)}` };
      if (req.model === 'fake/b') return bloqueio403();
      if (req.model === 'fake/c') return { text: '', refusal: 'Não posso ajudar com isso.', finishReason: 'stop' };
      if (req.model === 'fake/d') return { text: 'Parcial', finishReason: 'content_filter', nativeFinishReason: 'SAFETY' };
      if (req.model === 'fake/e') return { status: 500, bodyText: 'upstream caiu' };
      if (req.stream) return { text: `Resposta de ${req.model}`, finishReason: 'stop' };
      if (req.system.includes('DUELO')) return { text: '{"winner":"A","explanation":"A melhor"}' };
      return { text: '{"verdict":"resolve","explanation":"confere"}' };
    },
  });
}

const CONFIG = {
  mode: 'compare',
  theme: 'suporte',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b', 'fake/c', 'fake/d', 'fake/e'],
  finalists: 2,
  timeoutMs: 5_000,
} as const;

function conferirTaxonomia(rec: RunRecord): void {
  expect(rec.status, rec.error).toBe('finished');
  // 2 cenários × (b bloqueado + d filtrado) · 2 × c · 2 × e
  expect(rec.competitorOutcomeCounts).toEqual({ blocked: 4, refused: 2, error: 2 });
  const porModelo = (m: string) => rec.stages.flatMap((s) => s.responses).filter((r) => r.modelId === m);
  expect(porModelo('fake/a').map((r) => r.status)).toEqual(['ok', 'ok']);
  expect(porModelo('fake/b').map((r) => r.status)).toEqual(['blocked', 'blocked']);
  expect(porModelo('fake/c').map((r) => r.status)).toEqual(['refused', 'refused']);
  expect(porModelo('fake/d').map((r) => r.status)).toEqual(['blocked', 'blocked']);
  expect(porModelo('fake/e').map((r) => r.status)).toEqual(['error', 'error']);
  expect(porModelo('fake/d').every((r) => r.finishReason === 'content_filter' && r.nativeFinishReason === 'SAFETY')).toBe(true);
  expect(porModelo('fake/a').every((r) => r.finishReason === 'stop')).toBe(true);
  // Critério 4: ZERO bloqueios reportados como erro de key — nem na resposta,
  // nem em lugar nenhum do record (erro da run, vereditos, motivos).
  for (const r of [...porModelo('fake/b'), ...porModelo('fake/d')]) {
    expect(r.errorMsg).toBeTruthy();
    expect(r.errorMsg).not.toMatch(FALA_DE_KEY);
  }
  const tudo = JSON.stringify(rec);
  expect(tudo).not.toMatch(/recusou a key|key e invalida|key inv[aá]lida/i);
  expect(tudo).not.toContain(TEXTO_SINALIZADO); // o texto sinalizado nunca vaza
  // Sobrevive a um F5 (IndexedDB/disco) — whitelist silencioso.
  expect(normalizeRunRecord(JSON.parse(tudo)).competitorOutcomeCounts).toEqual(rec.competitorOutcomeCounts);
}

describe('IMPL-010 (3)+(4) — run inteira: contagens separadas e 0 bloqueio como erro de key', () => {
  let anterior: OpenRouterGateway | undefined;
  let dirAnterior: string;
  let tmp: string;
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl010-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
  });

  afterEach(() => {
    if (anterior) setDefaultGateway(anterior);
    anterior = undefined;
  });

  afterAll(() => {
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('Node (src/orchestrator)', async () => {
    anterior = setDefaultGateway(createGateway({ fetch: fakeDaRun().fetch, sleep: noSleep }));
    const rec = await runNode(CONFIG as unknown as RunConfig, KEY, {});
    conferirTaxonomia(rec);
  });

  it('SPA (web/src/engine/orchestrator) — mirror com a mesma contagem', async () => {
    anterior = setDefaultGateway(createGateway({ fetch: fakeDaRun().fetch, sleep: noSleep }));
    const rec = await runWeb(CONFIG as never, KEY, {});
    conferirTaxonomia(rec as unknown as RunRecord);
  });

  it('run nova já nasce com as 3 contagens zeradas (0 bloqueios é informação)', async () => {
    const fake = fakeOpenRouter({
      catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a'].map((id) => catalogItem(id, 1e-6, 1e-6)),
      chat: (req) => {
        if (req.model === 'fake/gen') return { text: JSON.stringify({ stages: CENARIOS }) };
        if (req.stream) return { text: 'ok', finishReason: 'stop' };
        return { text: '{"verdict":"resolve","explanation":"ok"}' };
      },
    });
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    const rec = await runNode({ ...CONFIG, competitorModelIds: ['fake/a'], finalists: 0 } as unknown as RunConfig, KEY, {});
    expect(rec.status, rec.error).toBe('finished');
    expect(rec.competitorOutcomeCounts).toEqual({ blocked: 0, refused: 0, error: 0 });
  });
});

describe('IMPL-010 (4) — contrato de erro do CLI', () => {
  it('exit code: 401 => 4 (auth); 403 de moderação/guardrail => NUNCA 4; limite => 5', () => {
    expect(exitCodeForGatewayError(classifyHttpError(401, ''))).toBe(EXIT.AUTH);
    expect(exitCodeForGatewayError(classifyHttpError(403, CORPO_403_MODERACAO))).toBe(EXIT.ERROR);
    expect(exitCodeForGatewayError(classifyHttpError(403, 'Forbidden'))).not.toBe(EXIT.AUTH);
    expect(exitCodeForGatewayError(classifyHttpError(403, '{"error":{"code":403,"message":"Key limit exceeded"}}'))).toBe(
      EXIT.NO_CREDIT,
    );
    expect(exitCodeForGatewayError(classifyHttpError(402, ''))).toBe(EXIT.NO_CREDIT);
    expect(exitCodeForGatewayError(classifyHttpError(429, ''))).toBe(EXIT.NETWORK);
    expect(exitCodeForGatewayError(classifyHttpError(503, ''))).toBe(EXIT.NETWORK);
    expect(exitCodeForGatewayError(classifyHttpError(400, ''))).toBe(EXIT.ERROR);
    expect(exitCodeForGatewayError(new Error('outra coisa'))).toBeUndefined();
  });

  it('NDJSON: competitor.finished leva status blocked (sem key) e run.finished leva as 3 contagens', () => {
    const linhas: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => (linhas.push(String(c)), true));
    try {
      const out = new Output({ format: 'ndjson' });
      const bloqueada: CompetitorResponse = {
        contestantId: 'fake/b',
        modelId: 'fake/b',
        text: '',
        latencyMs: 1,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        status: 'blocked',
        errorMsg: describeOpenRouterError(403, CORPO_403_MODERACAO),
      };
      emitRunEvent(out, { type: 'competitor.finished', runId: 'r', stageIndex: 0, response: bloqueada });
      const record = {
        id: 'r',
        status: 'finished',
        config: { stages: 1 },
        mode: 'compare',
        contestants: [],
        stages: [],
        scoreboard: {},
        totalCostUsd: 0,
        startedAt: 'x',
        competitorOutcomeCounts: { blocked: 1, refused: 0, error: 0 },
      } as unknown as RunRecord;
      emitRunEvent(out, { type: 'run.finished', runId: 'r', record });
    } finally {
      spy.mockRestore();
    }
    const eventos = linhas.map((l) => JSON.parse(l) as Record<string, unknown>);
    const comp = eventos.find((e) => e.type === 'competitor.finished')!;
    expect(comp.status).toBe('blocked');
    expect(String(comp.errorMsg)).not.toMatch(FALA_DE_KEY);
    const fim = eventos.find((e) => e.type === 'run.finished')!;
    expect(fim.competitorOutcomeCounts).toEqual({ blocked: 1, refused: 0, error: 0 });
  });
});
