// cli#3 (restante) — 401 (key recusada) e 402 (sem crédito) são FATAIS em TODO
// papel, nos DOIS motores.
//
// O datagen já propagava (wave 1), mas uma run com cenários PRÓPRIOS (seed
// cobre o alvo, sem datagen) degradava a falha em cada papel: gabarito →
// etapa sem régua, competidor → status 'error', juiz pointwise/listwise →
// veredito ausente, duelo → empate. A run "concluía" com etapas vazias e o CLI
// saía com exit 1 (ou 0) em vez do 4/5 documentado. Contrato aqui (transporte
// falso, zero rede): a falha fatal em QUALQUER papel termina a run em
// `status: 'error'` com `errorKind`/`errorHttpStatus` no record — o insumo do
// mapeamento de exit do CLI (`fatalGatewayOutcome`).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { callJudgeWithRetry } from '../src/engine/judgeRetry.js';
import { GatewayError } from '../src/openrouter.js';
import { setDataDir, getDataDir } from '../src/storage.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import type { RunConfig, RunRecord } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeChatReply, type FakeRequest } from './fakeOpenRouter.js';
import { duelReply, listwiseReply, pointwiseReply } from './judgeReplies.js';

vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const CATALOGO = ['fake/ref', 'fake/judge', 'fake/a', 'fake/b'].map((id) => catalogItem(id, 1e-6, 1e-6));

const R402: FakeChatReply = { status: 402, bodyText: '{"error":{"message":"Insufficient credits"}}' };
const R401: FakeChatReply = { status: 401, bodyText: '{"error":{"message":"User not found"}}' };

/** Resposta saudável de cada papel (o que NÃO está sob teste). */
function saudavel(req: FakeRequest): FakeChatReply {
  if (req.model === 'fake/ref') return { text: `Gabarito: ${req.user.slice(0, 30)}` };
  if (req.model === 'fake/judge') {
    if (req.system.includes('DUELO')) return { text: duelReply(req, 'A', 'A melhor') };
    if (/ranking/i.test(req.system) && !/veredito pointwise/i.test(req.system)) {
      return { text: listwiseReply(req, ['A', 'B'], []) };
    }
    return { text: pointwiseReply(req, 'resolve') };
  }
  return { text: `Resposta de ${req.model} para o caso` };
}

const CENARIOS = [
  { question: 'Como troco um produto com defeito?', productContext: 'Trocas em 30 dias.', maxTokens: 200 },
  { question: 'Qual o prazo de entrega para Manaus?', productContext: 'Entrega em 10 dias úteis.', maxTokens: 200 },
];

function config(extra: Record<string, unknown> = {}): RunConfig {
  return {
    mode: 'compare',
    theme: 'suporte ao cliente',
    stages: 2,
    datagenModelId: 'fake/ref',
    judgeModelIds: ['fake/judge'],
    referenceModelId: 'fake/ref',
    referenceJudging: true,
    competitorModelIds: ['fake/a', 'fake/b'],
    customStages: CENARIOS,
    finalists: 2,
    timeoutMs: 5_000,
    ...extra,
  } as unknown as RunConfig;
}

let anterior: OpenRouterGateway | undefined;
afterEach(() => {
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
});

let dirAnterior: string;
let tmp: string;
let mudos: Array<{ mockRestore(): void }> = [];
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pb-cli3-roles-'));
  dirAnterior = getDataDir();
  setDataDir(tmp);
  mudos = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
});
afterAll(() => {
  mudos.forEach((m) => m.mockRestore());
  setDataDir(dirAnterior);
  rmSync(tmp, { recursive: true, force: true });
});

type Caso = {
  nome: string;
  /** Qual pedido recebe a falha fatal. */
  falha: (req: FakeRequest) => boolean;
  resposta: FakeChatReply;
  kind: 'auth' | 'no_credit';
  status: number;
  extra?: Record<string, unknown>;
};

const CASOS: Caso[] = [
  { nome: 'gabarito 402', falha: (r) => r.model === 'fake/ref', resposta: R402, kind: 'no_credit', status: 402 },
  { nome: 'competidor 401', falha: (r) => r.model === 'fake/a', resposta: R401, kind: 'auth', status: 401 },
  {
    nome: 'juiz pointwise 402',
    falha: (r) => r.model === 'fake/judge' && !r.system.includes('DUELO'),
    resposta: R402,
    kind: 'no_credit',
    status: 402,
  },
  {
    nome: 'duelo das finais 402',
    falha: (r) => r.model === 'fake/judge' && r.system.includes('DUELO'),
    resposta: R402,
    kind: 'no_credit',
    status: 402,
  },
  {
    nome: 'juiz listwise 401 (sem referência)',
    falha: (r) => r.model === 'fake/judge',
    resposta: R401,
    kind: 'auth',
    status: 401,
    extra: { referenceJudging: false },
  },
];

const MOTORES = [
  ['Node', runNode],
  ['SPA', runWeb],
] as const;

describe('cli#3 — 401/402 derrubam a run em qualquer papel (Node e SPA)', { timeout: 30_000 }, () => {
  for (const [motor, run] of MOTORES) {
    for (const caso of CASOS) {
      it(`${motor}: ${caso.nome} → status error com errorKind ${caso.kind}`, async () => {
        const fake = fakeOpenRouter({
          catalog: CATALOGO,
          chat: (req) => (caso.falha(req) ? caso.resposta : saudavel(req)),
        });
        anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
        const runId = `cli3-${motor}-${caso.nome.replace(/\W+/g, '-')}`;
        const rec = (await run(config(caso.extra) as never, KEY, { runId } as never)) as RunRecord;
        // Antes: 'finished'/'inconclusive' com etapas degradadas (exit 0/1).
        expect(rec.status, JSON.stringify({ status: rec.status, error: rec.error })).toBe('error');
        expect(rec.errorKind).toBe(caso.kind);
        expect(rec.errorHttpStatus).toBe(caso.status);
        expect(rec.error).toMatch(new RegExp(`HTTP ${caso.status}`));
        // O pedido fatal foi mesmo feito (o caso exercitou o papel).
        expect(fake.chatRequests().some(caso.falha)).toBe(true);
      });
    }
  }

  it('controle: falha NÃO fatal (500 esgotado) no juiz continua degradando para veredito ausente', async () => {
    const fake = fakeOpenRouter({
      catalog: CATALOGO,
      chat: (req) =>
        req.model === 'fake/judge' && !req.system.includes('DUELO')
          ? { status: 500, bodyText: 'upstream' }
          : saudavel(req),
    });
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    const rec = (await runNode(config({ finalists: 0 }) as never, KEY, { runId: 'cli3-controle-500' } as never)) as RunRecord;
    expect(rec.status).not.toBe('error');
    expect(rec.errorKind).toBeUndefined();
  });
});

describe('cli#3 — callJudgeWithRetry sobe 401/402 (fonte única dos 3 juízes)', () => {
  it('401/402 sobem; 500 vira veredito ausente (judge_failed)', async () => {
    for (const [kind, status] of [
      ['auth', 401],
      ['no_credit', 402],
    ] as const) {
      await expect(
        callJudgeWithRetry({
          call: async () => {
            throw new GatewayError(kind, `HTTP ${status}`, { httpStatus: status });
          },
          parse: () => null,
          formatReminder: 'r',
        }),
      ).rejects.toMatchObject({ gatewayError: kind, httpStatus: status });
    }
    const degradado = await callJudgeWithRetry({
      call: async () => {
        throw new GatewayError('http', 'HTTP 500', { httpStatus: 500 });
      },
      parse: () => null,
      formatReminder: 'r',
    });
    expect(degradado).toMatchObject({ ok: false, error: { kind: 'judge_failed' } });
  });
});

describe('cli#3 — reescritor (variator) sobe 401/402 em vez de devolver menos variantes', () => {
  it('generateContestants rejeita com a falha fatal; 500 segue degradando (variante a menos)', async () => {
    const { generateContestants } = await import('../src/variator.js');
    const params = {
      apiKey: KEY,
      modelId: 'fake/a',
      theme: 'suporte',
      basePrompt: 'Voce e um atendente cordial.',
      includeOriginal: true,
      techniqueIds: ['persona'],
      promptOptimization: true,
      optimizerModelId: 'fake/ref',
    };
    const fatal = fakeOpenRouter({ catalog: CATALOGO, chat: () => R402 });
    anterior = setDefaultGateway(createGateway({ fetch: fatal.fetch, sleep: noSleep }));
    await expect(generateContestants(params as never)).rejects.toMatchObject({ gatewayError: 'no_credit' });

    const transitorio = fakeOpenRouter({ catalog: CATALOGO, chat: () => ({ status: 500, bodyText: 'x' }) });
    setDefaultGateway(createGateway({ fetch: transitorio.fetch, sleep: noSleep }));
    const lista = await generateContestants(params as never);
    // Só o controle original sobra (a técnica falhou e foi degradada).
    expect(lista.map((c) => Boolean(c.isOriginal))).toEqual([true]);
  });
});
