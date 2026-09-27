// IMPL-004 (R-03b:REC-4) — FALHA DE JUIZ ≠ VEREDITO.
//
// Contrato verificado aqui, com transporte FALSO (zero rede, zero gasto):
//   • falha de chamada / JSON inválido / timeout do juiz NUNCA viram 'parcial':
//     a chave some de `verdictByContestant` e o motivo vai em
//     `verdictErrorByContestant` — nos 3 prompts de juiz (pointwise, listwise,
//     duelos, estes nos DOIS motores);
//   • re-tentativa seletiva: timeout 1×; saída inválida => 1 pedido com
//     lembrete de formato; o resto não repete;
//   • a média (judge-score) e as lições do reescritor ignoram o ausente;
//   • a run termina `inconclusive` (terminal, exit 6) quando falha+degradado
//     > 10% num papel ou n efetivo < 5 — nos dois motores;
//   • `failureCountByRole` sobrevive ao disco/normalizeRunRecord e ao caminho
//     do treino (variationConfigFrom → runs → soma na sessão).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway, type FetchLike } from '../src/openrouter.js';
import { judgeStageReference } from '../src/refJudge.js';
import { judgeStage } from '../src/judge.js';
import { runStageDuels as runDuelsNode } from '../src/duels.js';
import { runStageDuels as runDuelsWeb } from '../web/src/engine/duels.js';
import { judgeScoreFromVerdicts } from '../src/rank.js';
import { buildLessons as lessonsNode, trainToCompletion } from '../src/trainer.js';
import { buildLessons as lessonsWeb } from '../web/src/engine/trainer.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { normalizeRunRecord } from '../src/normalize.js';
import { getDataDir, loadRun, setDataDir } from '../src/storage.js';
import {
  assessVerdictIntegrity,
  failureRoleOf,
  mergeFailureCounts,
  MAX_FAILURE_RATE,
  MIN_JUDGED_SCENARIOS,
} from '../src/engine/verdictIntegrity.js';
import { callJudgeWithRetry, isTimeoutError, MAX_JUDGE_CALLS } from '../src/engine/judgeRetry.js';
import { readMarkedBlock } from '../src/engine/judgeGuard.js';
import { BudgetLedger, isControlSignal } from '../src/budget.js';
import { EXIT } from '../src/cli/output.js';
import { exitFor } from '../src/cli/commands/run.js';
import {
  isTerminalRunStatus,
  TERMINAL_RUN_STATUSES,
  type CompetitorResponse,
  type CompetitorStatus,
  type Contestant,
  type RunConfig,
  type RunRecord,
  type StageRecord,
  type StageSpec,
  type TrainingConfig,
  type Verdict,
  type VerdictError,
  type VerdictSource,
} from '../src/types.js';
import { isTerminalRunStatus as isTerminalWeb } from '../web/src/engine/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter, type FakeRequest } from './fakeOpenRouter.js';
import { candidateOf, duelReply, listwiseReply, pointwiseReply, questionOf } from './judgeReplies.js';

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

const STAGE: StageSpec = {
  question: 'Qual o prazo para trocar um produto?',
  productContext: 'Trocas em até 30 dias com nota fiscal.',
  maxTokens: 200,
  reference: 'Trinta dias a partir do recebimento, com nota fiscal.',
};

const resp = (id: string, text: string, status: CompetitorStatus = 'ok'): CompetitorResponse => ({
  contestantId: id,
  modelId: 'fake/a',
  text,
  latencyMs: 1,
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
  status,
  ...(status === 'error' ? { errorMsg: 'HTTP 502 upstream' } : {}),
  ...(status === 'blocked' ? { errorMsg: 'moderação' } : {}),
});
const cont = (id: string): Contestant => ({ id, label: id, modelId: 'fake/a' });

/** Veredito pointwise válido — com o canário do pedido (IMPL-006). */
const OK_JSON = (req: FakeRequest, verdict: Verdict, explanation = 'confere'): string =>
  pointwiseReply(req, verdict, explanation);

async function comGateway<T>(fetch: FetchLike, fn: () => Promise<T>): Promise<T> {
  const anterior = setDefaultGateway(createGateway({ fetch, sleep: noSleep }));
  try {
    return await fn();
  } finally {
    setDefaultGateway(anterior);
  }
}

/** Pedidos de juiz pointwise para o candidato com `texto`. */
const pedidosDo = (fake: FakeOpenRouter, texto: string): FakeRequest[] =>
  fake.chatRequests().filter((r) => candidateOf(r) === texto);

/**
 * fetch que TRAVA (até o abort do timeout do gateway) os pedidos escolhidos —
 * o timeout real do gateway (`abort(new Error('timeout'))`), não um erro fake.
 */
function comTravamento(fake: FakeOpenRouter, trava: (body: string) => boolean): {
  fetch: FetchLike;
  travadas: () => number;
} {
  let n = 0;
  const fetch: FetchLike = (url, init) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    if ((init?.method ?? 'GET').toUpperCase() === 'POST' && trava(body)) {
      n += 1;
      return new Promise<Response>((_, reject) => {
        const sig = init?.signal;
        if (!sig) return;
        if (sig.aborted) reject(sig.reason);
        else sig.addEventListener('abort', () => reject(sig.reason), { once: true });
      });
    }
    return fake.fetch(url, init);
  };
  return { fetch, travadas: () => n };
}

/** Nenhum veredito imputado: toda chave de erro está AUSENTE do mapa de vereditos. */
function semImputacao(r: {
  verdictByContestant?: Record<string, Verdict>;
  verdictSourceByContestant?: Record<string, VerdictSource>;
  verdictErrorByContestant?: Record<string, VerdictError>;
}): void {
  for (const id of Object.keys(r.verdictErrorByContestant ?? {})) {
    expect(r.verdictByContestant?.[id], `veredito imputado para ${id}`).toBeUndefined();
  }
  for (const [id, v] of Object.entries(r.verdictByContestant ?? {})) {
    const src = r.verdictSourceByContestant?.[id];
    expect(src, `veredito de ${id} sem origem`).toBeDefined();
    // 'parcial' só pode vir de quem JULGOU (juiz LLM/painel reduzido/rótulo).
    if (v === 'parcial') expect(['judge', 'degraded', 'ground-truth']).toContain(src);
    // A regra automática só produz 'nao' (resposta vazia).
    if (src === 'auto') expect(v).toBe('nao');
  }
}

// ---------------------------------------------------------------------------
// Núcleo da re-tentativa seletiva
// ---------------------------------------------------------------------------

describe('judgeRetry — re-tentativa SELETIVA (timeout 1×, lembrete 1×)', () => {
  it('saída inválida: 1 novo pedido COM lembrete; persistindo => invalid_output (nunca veredito)', async () => {
    const lembretes: (string | undefined)[] = [];
    const r = await callJudgeWithRetry({
      call: async (reminder) => {
        lembretes.push(reminder);
        return 'o candidato parcialmente resolve';
      },
      parse: () => null,
      formatReminder: 'LEMBRETE',
    });
    expect(r.ok).toBe(false);
    expect(r.calls).toBe(2);
    expect(lembretes).toEqual([undefined, 'LEMBRETE']);
    if (!r.ok) expect(r.error.kind).toBe('invalid_output');
  });

  it('timeout re-tenta UMA vez; dois timeouts => kind timeout', async () => {
    let n = 0;
    const r = await callJudgeWithRetry({
      call: async () => {
        n += 1;
        throw new Error('timeout');
      },
      parse: () => 'x',
      formatReminder: 'L',
    });
    expect(n).toBe(2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('timeout');
  });

  it('erro comum não repete; sinal de controle SOBE; teto de chamadas = 3', async () => {
    let n = 0;
    const r = await callJudgeWithRetry({
      call: async () => {
        n += 1;
        throw new Error('OpenRouter falhou (HTTP 400): bad');
      },
      parse: () => 'x',
      formatReminder: 'L',
    });
    expect(n).toBe(1);
    if (!r.ok) expect(r.error.kind).toBe('judge_failed');
    const ledger = new BudgetLedger({ budgetUsd: 1, estimateCall: () => 5 });
    await expect(
      callJudgeWithRetry({
        call: async () => {
          ledger.reserve('judge', 'm', 1, 1);
          return '';
        },
        parse: () => 'x',
        formatReminder: 'L',
      }),
    ).rejects.toSatisfy(isControlSignal);
    expect(MAX_JUDGE_CALLS).toBe(3);
    expect(isTimeoutError(new Error('timeout'))).toBe(true);
    expect(isTimeoutError(new Error('HTTP 400'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Juiz POINTWISE (refJudge)
// ---------------------------------------------------------------------------

describe('refJudge — falha do juiz vira veredito AUSENTE, nunca parcial', () => {
  const base = {
    stage: STAGE,
    judgeModelIds: ['fake/judge'],
    apiKey: KEY,
    timeoutMs: 2_000,
  };

  it('falha de chamada (HTTP 400): sem chave, motivo judge_failed; média e irmãos intactos', async () => {
    const fake = fakeOpenRouter({
      chat: (req) =>
        candidateOf(req) === 'RESP-A' ? { status: 400, bodyText: 'FALHA-DO-JUIZ' } : { text: OK_JSON(req, 'resolve') },
    });
    const r = await comGateway(fake.fetch, () =>
      judgeStageReference({
        ...base,
        responses: [resp('a', 'RESP-A'), resp('b', 'RESP-B')],
        contestants: [cont('a'), cont('b')],
      }),
    );
    expect('a' in r.verdictByContestant).toBe(false);
    expect(r.explanationByContestant.a).toBeUndefined();
    expect(r.verdictErrorByContestant?.a?.kind).toBe('judge_failed');
    expect(r.verdictErrorByContestant?.a?.message).toContain('FALHA-DO-JUIZ');
    expect(r.verdictByContestant.b).toBe('resolve');
    expect(r.verdictSourceByContestant?.b).toBe('judge');
    expect(pedidosDo(fake, 'RESP-A')).toHaveLength(1); // erro comum não repete
    semImputacao(r);
    // A média IGNORA o ausente: 'a' não entra nem como 'parcial' nem como 'nao'.
    expect(judgeScoreFromVerdicts([r.verdictByContestant.a, r.verdictByContestant.b])).toBe(100);
  });

  it('JSON inválido: 1 novo pedido com lembrete; persistindo => invalid_output (o regex antigo daria parcial)', async () => {
    const fake = fakeOpenRouter({
      chat: (req) =>
        candidateOf(req) === 'RESP-A'
          ? { text: 'o candidato resolve parcialmente a questão' }
          : { text: OK_JSON(req, 'nao') },
    });
    const r = await comGateway(fake.fetch, () =>
      judgeStageReference({
        ...base,
        responses: [resp('a', 'RESP-A'), resp('b', 'RESP-B')],
        contestants: [cont('a'), cont('b')],
      }),
    );
    expect(r.verdictByContestant.a).toBeUndefined();
    expect(r.verdictErrorByContestant?.a?.kind).toBe('invalid_output');
    const pedidos = pedidosDo(fake, 'RESP-A');
    expect(pedidos).toHaveLength(2);
    expect(pedidos[0].user).not.toContain('LEMBRETE DE FORMATO');
    expect(pedidos[1].user).toContain('LEMBRETE DE FORMATO');
    expect(r.verdictByContestant.b).toBe('nao');
    semImputacao(r);
  });

  it('JSON inválido e depois válido: o lembrete recupera um veredito LEGÍTIMO', async () => {
    const fake = fakeOpenRouter({
      chat: (req) =>
        req.user.includes('LEMBRETE DE FORMATO') ? { text: OK_JSON(req, 'parcial') } : { text: 'lixo sem json' },
    });
    const r = await comGateway(fake.fetch, () =>
      judgeStageReference({ ...base, responses: [resp('a', 'RESP-A')], contestants: [cont('a')] }),
    );
    expect(r.verdictByContestant.a).toBe('parcial');
    expect(r.verdictSourceByContestant?.a).toBe('judge');
    expect(pedidosDo(fake, 'RESP-A')).toHaveLength(2);
    semImputacao(r);
  });

  it('timeout re-tenta 1× (recupera); dois timeouts => kind timeout, sem 3ª chamada', async () => {
    const fake = fakeOpenRouter({ chat: (req) => ({ text: OK_JSON(req, 'resolve') }) });
    let primeiro = true;
    const umaVez = comTravamento(fake, (body) => {
      if (!body.includes('RESP-A') || !primeiro) return false;
      primeiro = false;
      return true;
    });
    const r1 = await comGateway(umaVez.fetch, () =>
      judgeStageReference({ ...base, timeoutMs: 30, responses: [resp('a', 'RESP-A')], contestants: [cont('a')] }),
    );
    expect(umaVez.travadas()).toBe(1);
    expect(r1.verdictByContestant.a).toBe('resolve');

    const sempre = comTravamento(fake, (body) => body.includes('RESP-A'));
    const r2 = await comGateway(sempre.fetch, () =>
      judgeStageReference({ ...base, timeoutMs: 30, responses: [resp('a', 'RESP-A')], contestants: [cont('a')] }),
    );
    expect(sempre.travadas()).toBe(2);
    expect(r2.verdictByContestant.a).toBeUndefined();
    expect(r2.verdictErrorByContestant?.a?.kind).toBe('timeout');
    semImputacao(r2);
  });

  it('regra de origem: error/sem resposta => competitor_error, blocked => blocked, refused é julgado, vazia => nao automático', async () => {
    const fake = fakeOpenRouter({ chat: (req) => ({ text: OK_JSON(req, 'nao', 'recusou') }) });
    const r = await comGateway(fake.fetch, () =>
      judgeStageReference({
        ...base,
        responses: [
          resp('ok', 'RESP-OK'),
          resp('err', '', 'error'),
          resp('blk', '', 'blocked'),
          resp('ref', 'Não posso ajudar com isso.', 'refused'),
          resp('vazia', '   '),
        ],
        contestants: ['ok', 'err', 'blk', 'ref', 'vazia', 'sumiu'].map(cont),
      }),
    );
    expect(r.verdictErrorByContestant?.err?.kind).toBe('competitor_error');
    expect(r.verdictErrorByContestant?.sumiu?.kind).toBe('competitor_error');
    expect(r.verdictErrorByContestant?.blk?.kind).toBe('blocked');
    expect(r.verdictByContestant.ref).toBe('nao');
    expect(r.verdictSourceByContestant?.ref).toBe('judge');
    expect(r.verdictByContestant.vazia).toBe('nao');
    expect(r.verdictSourceByContestant?.vazia).toBe('auto');
    // Só 'ok' e 'refused' gastam juiz.
    expect(fake.chatRequests()).toHaveLength(2);
    semImputacao(r);
  });

  it('multi-juiz com um juiz caído => veredito do painel reduzido, fonte degraded', async () => {
    const fake = fakeOpenRouter({
      chat: (req) => (req.model === 'fake/j2' ? { status: 400, bodyText: 'caiu' } : { text: OK_JSON(req, 'resolve') }),
    });
    const r = await comGateway(fake.fetch, () =>
      judgeStageReference({
        ...base,
        judgeModelIds: ['fake/j1', 'fake/j2'],
        responses: [resp('a', 'RESP-A')],
        contestants: [cont('a')],
      }),
    );
    expect(r.verdictByContestant.a).toBe('resolve');
    expect(r.verdictSourceByContestant?.a).toBe('degraded');
  });

  it('sem gabarito: nenhum veredito (no_reference), zero chamadas, etapa inconclusiva', async () => {
    const fake = fakeOpenRouter({ chat: (req) => ({ text: OK_JSON(req, 'resolve') }) });
    const r = await comGateway(fake.fetch, () =>
      judgeStageReference({
        ...base,
        stage: { ...STAGE, reference: '' },
        responses: [resp('a', 'RESP-A')],
        contestants: [cont('a')],
      }),
    );
    expect(r.verdictByContestant).toEqual({});
    expect(r.verdictErrorByContestant?.a?.kind).toBe('no_reference');
    expect(r.inconclusive).toBe(true);
    expect(fake.chatRequests()).toHaveLength(0);
  });

  it('orçamento e cancelamento SOBEM como controle (não viram judge_failed)', async () => {
    const fake = fakeOpenRouter({ chat: (req) => ({ text: OK_JSON(req, 'resolve') }) });
    await comGateway(fake.fetch, async () => {
      const sink = new BudgetLedger({ budgetUsd: 1, estimateCall: () => 5 });
      await expect(
        judgeStageReference({ ...base, responses: [resp('a', 'RESP-A')], contestants: [cont('a')], ctx: { sink } }),
      ).rejects.toSatisfy(isControlSignal);
    });
    const travado = comTravamento(fake, () => true);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort('SIGINT'), 10);
    await comGateway(travado.fetch, async () => {
      await expect(
        judgeStageReference({
          ...base,
          timeoutMs: 5_000,
          responses: [resp('a', 'RESP-A')],
          contestants: [cont('a')],
          ctx: { signal: ctrl.signal },
        }),
      ).rejects.toSatisfy(isControlSignal);
    });
  });
});

// ---------------------------------------------------------------------------
// Juiz LISTWISE (judge.ts)
// ---------------------------------------------------------------------------

describe('judge (listwise) — saída estrita, nenhum parcial por omissão', () => {
  const base = { apiKey: KEY, stage: STAGE, judgeModelIds: ['fake/judge'], timeoutMs: 2_000 };
  const completo = (req: FakeRequest): string =>
    listwiseReply(req, ['A', 'B'], [
      { label: 'A', justificativa: 'ok', veredito: 'resolve' },
      { label: 'B', justificativa: 'ok', veredito: 'resolve' },
    ]);

  it('saída inválida 2× => todos SEM veredito (invalid_output), sem aceitável, etapa inconclusiva', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: 'A é melhor, B parcial' }) });
    const r = await comGateway(fake.fetch, () =>
      judgeStage({ ...base, responses: [resp('a', 'RESP-A'), resp('b', 'RESP-B')] }),
    );
    expect(r.verdictByContestant).toEqual({});
    expect(r.acceptableByContestant).toEqual({});
    expect(r.verdictErrorByContestant?.a?.kind).toBe('invalid_output');
    expect(r.verdictErrorByContestant?.b?.kind).toBe('invalid_output');
    expect(r.inconclusive).toBe(true);
    expect(fake.chatRequests()).toHaveLength(2);
    expect(fake.chatRequests()[1].user).toContain('LEMBRETE DE FORMATO');
  });

  it('ranking incompleto ou veredito ambíguo => lembrete; a 2ª saída completa vale', async () => {
    const incompleta = (req: FakeRequest): string =>
      listwiseReply(req, ['A'], [{ label: 'A', justificativa: 'x', veredito: 'talvez' }]);
    const fake = fakeOpenRouter({
      chat: (req) => ({ text: req.user.includes('LEMBRETE DE FORMATO') ? completo(req) : incompleta(req) }),
    });
    const r = await comGateway(fake.fetch, () =>
      judgeStage({ ...base, responses: [resp('a', 'RESP-A'), resp('b', 'RESP-B')] }),
    );
    expect(r.verdictByContestant).toEqual({ a: 'resolve', b: 'resolve' });
    expect(r.verdictSourceByContestant).toEqual({ a: 'judge', b: 'judge' });
    expect(fake.chatRequests()).toHaveLength(2);
    semImputacao(r);
  });

  it('um de dois juízes falha => fonte degraded; erro/bloqueio sem veredito; vazia => nao automático', async () => {
    const fake = fakeOpenRouter({
      chat: (req) => (req.model === 'fake/j2' ? { status: 400, bodyText: 'caiu' } : { text: completo(req) }),
    });
    const r = await comGateway(fake.fetch, () =>
      judgeStage({
        ...base,
        judgeModelIds: ['fake/j1', 'fake/j2'],
        responses: [resp('a', 'RESP-A'), resp('b', 'RESP-B'), resp('err', '', 'error'), resp('blk', '', 'blocked'), resp('v', '')],
      }),
    );
    expect(r.verdictSourceByContestant?.a).toBe('degraded');
    expect(r.verdictSourceByContestant?.b).toBe('degraded');
    expect(r.verdictErrorByContestant?.err?.kind).toBe('competitor_error');
    expect(r.verdictErrorByContestant?.blk?.kind).toBe('blocked');
    expect(r.acceptableByContestant.err).toBeUndefined();
    expect(r.verdictByContestant.v).toBe('nao');
    expect(r.verdictSourceByContestant?.v).toBe('auto');
    expect(r.rawJudgeText).toContain('fake/j2');
    semImputacao(r);
  });
});

// ---------------------------------------------------------------------------
// Duelos (src + espelho web)
// ---------------------------------------------------------------------------

describe.each([
  ['src/duels', runDuelsNode],
  ['web/src/engine/duels', runDuelsWeb],
] as const)('%s — duelo sem resultado não vira empate', (_nome, runStageDuels) => {
  const base = {
    stage: STAGE,
    judgeModelId: 'fake/judge',
    apiKey: KEY,
    topK: 0,
    timeoutMs: 2_000,
  };
  /** Vence quem tem o texto TXT-C; a/b nunca decidem entre si. */
  const juizC = (req: FakeRequest) => {
    const cEmA = readMarkedBlock(req.user, 'CANDIDATO A') === 'TXT-C';
    return { text: duelReply(req, cEmA ? 'A' : 'B', 'c melhor') };
  };

  it('ordem que falha => failedDuels (fora do placar); a e b NÃO ganham 0,5 de um empate imputado', async () => {
    const fake = fakeOpenRouter({
      chat: (req) =>
        req.user.includes('TXT-A') && req.user.includes('TXT-B')
          ? { status: 400, bodyText: 'juiz caiu' }
          : juizC(req),
    });
    const d = await comGateway(fake.fetch, () =>
      runStageDuels({
        ...base,
        responses: [resp('a', 'TXT-A'), resp('b', 'TXT-B'), resp('c', 'TXT-C')],
        contestants: ['a', 'b', 'c'].map(cont),
        duelists: ['a', 'b', 'c'],
      }),
    );
    expect(d.duels).toHaveLength(2);
    expect(d.duels.every((x) => x.source === 'judge')).toBe(true);
    expect(d.failedDuels).toHaveLength(1);
    expect([d.failedDuels![0].a, d.failedDuels![0].b].sort()).toEqual(['a', 'b']);
    expect(d.failedDuels![0].error.kind).toBe('judge_failed');
    expect(d.points).toEqual({ a: 0, b: 0, c: 2 });
  });

  it('saída inválida => 1 pedido com lembrete; persistindo => invalid_output (o regex antigo daria "A")', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: 'A venceu com folga' }) });
    const d = await comGateway(fake.fetch, () =>
      runStageDuels({
        ...base,
        responses: [resp('a', 'TXT-A'), resp('b', 'TXT-B')],
        contestants: ['a', 'b'].map(cont),
        duelists: ['a', 'b'],
      }),
    );
    expect(d.duels).toEqual([]);
    expect(d.failedDuels?.[0].error.kind).toBe('invalid_output');
    expect(fake.chatRequests()).toHaveLength(4); // 2 ordens × (original + lembrete)
    expect(fake.chatRequests().filter((r) => r.user.includes('LEMBRETE DE FORMATO'))).toHaveLength(2);
    expect(d.points).toEqual({ a: 0, b: 0 });
  });

  it('sem gabarito: oráculo empatado = empate legítimo; faltar o score de um lado = sem resultado', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: '{}' }) });
    const d = await comGateway(fake.fetch, () =>
      runStageDuels({
        ...base,
        stage: { ...STAGE, reference: '' },
        responses: [resp('a', 'TXT-A'), resp('b', 'TXT-B'), resp('c', 'TXT-C')],
        contestants: ['a', 'b', 'c'].map(cont),
        duelists: ['a', 'b', 'c'],
        oracleScoresByContestant: { a: 1, b: 1 },
      }),
    );
    expect(fake.chatRequests()).toHaveLength(0);
    expect(d.duels).toHaveLength(1);
    expect(d.duels[0]).toMatchObject({ outcome: 'tie', source: 'ground-truth' });
    expect(d.failedDuels).toHaveLength(2);
    expect(d.failedDuels!.every((f) => f.error.kind === 'no_reference')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lições do reescritor
// ---------------------------------------------------------------------------

describe.each([
  ['src/trainer', lessonsNode],
  ['web/src/engine/trainer', lessonsWeb],
] as const)('%s — buildLessons ignora veredito ausente', (_nome, buildLessons) => {
  it('a lição tem a falha REAL do campeão e nunca o veredito ausente (nem o motivo dele)', () => {
    const etapa = (i: number, q: string, extra: Partial<StageRecord['referenceJudge']>): StageRecord => ({
      index: i,
      startedAt: 'x',
      spec: { question: q, productContext: 'ctx', maxTokens: 100, reference: 'ref' },
      responses: [],
      referenceJudge: {
        verdictByContestant: {},
        explanationByContestant: {},
        judgeModelId: 'fake/judge',
        ...extra,
      },
    });
    const run = {
      stages: [
        etapa(0, 'CEN-NAO', {
          verdictByContestant: { champ: 'nao' },
          explanationByContestant: { champ: 'EXPLICACAO-REAL' },
          verdictSourceByContestant: { champ: 'judge' },
        }),
        etapa(1, 'CEN-FALHA', {
          // Record antigo/defensivo: até COM explicação no mapa, ausente não vira lição.
          explanationByContestant: { champ: 'Juiz de referência falhou: FALHA-DO-JUIZ' },
          verdictErrorByContestant: { champ: { kind: 'judge_failed', message: 'FALHA-DO-JUIZ' } },
        }),
        etapa(2, 'CEN-OK', { verdictByContestant: { champ: 'resolve' } }),
      ],
    } as unknown as RunRecord;
    const licoes = buildLessons(run as never, 'champ');
    expect(licoes).toContain('EXPLICACAO-REAL');
    expect(licoes).toContain('veredito=nao');
    expect(licoes).not.toContain('FALHA-DO-JUIZ');
    expect(licoes).not.toContain('CEN-FALHA');
    expect(licoes).not.toContain('veredito=?');
  });
});

// ---------------------------------------------------------------------------
// Regra de run inconclusiva (núcleo puro)
// ---------------------------------------------------------------------------

describe('assessVerdictIntegrity — >10% por papel ou n efetivo < 5 => inconclusiva', () => {
  type Linha = Record<string, Verdict | VerdictError | 'degraded-resolve'>;
  /** Uma etapa pointwise: valor = veredito, `{kind}` = ausente, 'degraded-resolve' = painel reduzido. */
  function etapa(i: number, linha: Linha, over: Partial<StageRecord> = {}, q = `Q${i}`): StageRecord {
    const v: Record<string, Verdict> = {};
    const src: Record<string, VerdictSource> = {};
    const err: Record<string, VerdictError> = {};
    for (const [id, x] of Object.entries(linha)) {
      if (x === 'degraded-resolve') {
        v[id] = 'resolve';
        src[id] = 'degraded';
      } else if (typeof x === 'string') {
        v[id] = x;
        src[id] = 'judge';
      } else err[id] = x;
    }
    return {
      index: i,
      startedAt: 'x',
      spec: { question: q, productContext: 'ctx', maxTokens: 100, reference: 'ref' },
      responses: Object.keys(linha).map((id) => resp(id, 'r')),
      referenceJudge: {
        verdictByContestant: v,
        explanationByContestant: {},
        verdictSourceByContestant: src,
        verdictErrorByContestant: err,
        judgeModelId: 'fake/judge',
      },
      ...over,
    };
  }
  const JF: VerdictError = { kind: 'judge_failed', message: 'x' };
  const dois = [cont('a'), cont('b')];
  const avaliar = (stages: StageRecord[], contestants = dois, referenceJudging = false) =>
    assessVerdictIntegrity({ stages, contestants, referenceJudging });

  it('limiares de projeto gravados: 10% e 5', () => {
    expect(MAX_FAILURE_RATE).toBe(0.1);
    expect(MIN_JUDGED_SCENARIOS).toBe(5);
    const r = avaliar(Array.from({ length: 5 }, (_, i) => etapa(i, { a: 'resolve', b: 'nao' })));
    expect(r.inconclusive).toBe(false);
    expect(r.integrity).toMatchObject({ maxFailureRate: 0.1, minJudgedScenarios: 5, reasons: [] });
    expect(r.failureCountByRole).toMatchObject({ judge: 0, competitor: 0 });
  });

  it('falha do juiz: 10% exatos passa; > 10% => inconclusiva por papel', () => {
    const com = (falhas: number) =>
      avaliar(Array.from({ length: 10 }, (_, i) => etapa(i, { a: 'resolve', b: i < falhas ? JF : 'parcial' })));
    const dez = com(2); // 2 de 20 = 10%
    expect(dez.inconclusive).toBe(false);
    expect(dez.failureCountByRole.judge).toBe(2);
    const quinze = com(3); // 3 de 20 = 15%
    expect(quinze.inconclusive).toBe(true);
    expect(quinze.integrity.reasons[0]).toMatch(/^papel judge: 3 de 20/);
  });

  it('julgamento degradado soma à falha na regra', () => {
    const r = avaliar(
      Array.from({ length: 10 }, (_, i) => etapa(i, { a: 'resolve', b: i < 3 ? 'degraded-resolve' : 'resolve' })),
    );
    expect(r.failureCountByRole.judge).toBe(0);
    expect(r.integrity.degradedByRole.judge).toBe(3);
    expect(r.inconclusive).toBe(true);
  });

  it('n efetivo < 5 cenários julgados por contestant => inconclusiva; repeats não contam 2×', () => {
    const quatro = avaliar(Array.from({ length: 4 }, (_, i) => etapa(i, { a: 'resolve', b: 'resolve' })));
    expect(quatro.inconclusive).toBe(true);
    expect(quatro.integrity.reasons).toEqual(['n efetivo < 5 cenários julgados: a (4), b (4)']);
    // 3 cenários × 2 repeats = 6 etapas, mas só 3 cenários distintos.
    const repeats = avaliar(Array.from({ length: 6 }, (_, i) => etapa(i, { a: 'resolve', b: 'resolve' }, {}, `Q${i % 3}`)));
    expect(repeats.integrity.judgedScenariosByContestant).toEqual({ a: 3, b: 3 });
    expect(repeats.inconclusive).toBe(true);
  });

  it('bloqueio do gateway não é falha do pipeline, mas tira observação (n efetivo)', () => {
    const r = avaliar(
      Array.from({ length: 10 }, (_, i) =>
        etapa(i, { a: 'resolve', b: i < 6 ? { kind: 'blocked', message: 'moderação' } : 'resolve' }),
      ),
    );
    expect(r.failureCountByRole.competitor).toBe(0);
    expect(r.integrity.judgedScenariosByContestant.b).toBe(4);
    expect(r.inconclusive).toBe(true);
    expect(failureRoleOf('blocked')).toBeUndefined();
    expect(failureRoleOf('competitor_error', 'agent')).toBe('agent');
  });

  it('erro de infra do competidor conta no papel competitor (agente no papel agent)', () => {
    const agente: Contestant = { ...cont('b'), runner: 'agent' };
    const ce: VerdictError = { kind: 'competitor_error', message: 'infra' };
    const r = avaliar(
      Array.from({ length: 10 }, (_, i) => etapa(i, { a: i < 2 ? ce : 'resolve', b: i < 2 ? ce : 'resolve' })),
      [cont('a'), agente],
    );
    expect(r.failureCountByRole.competitor).toBe(2);
    expect(r.failureCountByRole.agent).toBe(2);
    expect(r.inconclusive).toBe(true); // 2 de 10 = 20% em cada papel
  });

  it('etapas incomplete/puladas ficam fora (já estão fora do placar)', () => {
    const boas = Array.from({ length: 6 }, (_, i) => etapa(i, { a: 'resolve', b: 'resolve' }));
    const cortadas = Array.from({ length: 4 }, (_, i) => ({
      ...etapa(10 + i, { a: JF, b: JF }),
      incomplete: true,
    }));
    const r = avaliar([...boas, ...cortadas]);
    expect(r.inconclusive).toBe(false);
    expect(r.failureCountByRole.judge).toBe(0);
  });

  it('duelo sem resultado conta no papel duel', () => {
    const duels = (falhou: boolean): StageRecord['duels'] => ({
      placementByContestant: {},
      order: [],
      points: {},
      topK: 2,
      duels: [
        {
          a: 'a',
          b: 'b',
          order1: { winner: 'a', explanation: '' },
          order2: { winner: 'a', explanation: '' },
          outcome: 'a',
          source: 'judge',
        },
      ],
      ...(falhou ? { failedDuels: [{ a: 'a', b: 'c', error: JF }] } : {}),
    });
    const r = avaliar(
      Array.from({ length: 5 }, (_, i) => etapa(i, { a: 'resolve', b: 'resolve' }, { duels: duels(i === 0) })),
    );
    expect(r.failureCountByRole.duel).toBe(1);
    expect(r.integrity.expectedByRole.duel).toBe(6);
    expect(r.inconclusive).toBe(true); // 1 de 6 = 16,7%
    expect(r.integrity.reasons[0]).toMatch(/^papel duel/);
  });

  it('gabarito que faltou conta no papel gabarito e a etapa sai da régua primária', () => {
    const comRef = Array.from({ length: 8 }, (_, i) => etapa(i, { a: 'resolve', b: 'resolve' }));
    const semRef: StageRecord[] = [8, 9].map((i) => ({
      index: i,
      startedAt: 'x',
      spec: { question: `Q${i}`, productContext: 'ctx', maxTokens: 100 },
      responses: [resp('a', 'r'), resp('b', 'r')],
      judge: {
        rankedContestantIds: ['a', 'b'],
        acceptableByContestant: { a: true, b: true },
        verdictByContestant: { a: 'resolve', b: 'resolve' },
        verdictSourceByContestant: { a: 'judge', b: 'judge' },
        judges: [],
        blindMap: {},
        rawJudgeText: '',
      },
    }));
    const r = avaliar([...comRef, ...semRef], dois, true);
    expect(r.failureCountByRole.gabarito).toBe(2);
    expect(r.integrity.judgedScenariosByContestant).toEqual({ a: 8, b: 8 });
    expect(r.inconclusive).toBe(true); // 2 de 10 gabaritos = 20%
  });

  it('mergeFailureCounts soma por papel (sessão = soma das runs)', () => {
    expect(mergeFailureCounts(undefined, undefined)).toBeUndefined();
    expect(mergeFailureCounts({ judge: 1, duel: 0 }, { judge: 2, competitor: 1 })).toEqual({
      judge: 3,
      duel: 0,
      competitor: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Status terminal + exit code
// ---------------------------------------------------------------------------

describe('status inconclusive é TERMINAL (SSE, web, CLI)', () => {
  it('isTerminalRunStatus inclui inconclusive e é o MESMO helper no web', () => {
    expect(TERMINAL_RUN_STATUSES).toEqual(['finished', 'inconclusive', 'error', 'aborted']);
    expect(isTerminalRunStatus('inconclusive')).toBe(true);
    expect(isTerminalRunStatus('running')).toBe(false);
    expect(isTerminalRunStatus(undefined)).toBe(false);
    expect(isTerminalRunStatus('qualquer')).toBe(false);
    expect(isTerminalWeb).toBe(isTerminalRunStatus);
  });

  it('CLI: run inconclusiva sai com INCONCLUSIVE=6; orçamento/Ctrl-C têm precedência', () => {
    expect(EXIT.INCONCLUSIVE).toBe(6);
    expect(exitFor(undefined, false, 'inconclusive')).toBe(6);
    expect(exitFor(undefined, false, 'finished')).toBe(EXIT.OK);
    expect(exitFor('budget', true, 'aborted')).toBe(EXIT.BUDGET);
    expect(exitFor('cancelled', false, 'aborted')).toBe(EXIT.SIGINT);
  });
});

// ---------------------------------------------------------------------------
// Pipeline completo, nos DOIS motores (transporte falso)
// ---------------------------------------------------------------------------

const SETE: StageSpec[] = Array.from({ length: 7 }, (_, i) => ({
  question: `CEN-${i} Qual o prazo de troca do item ${i}?`,
  productContext: 'Trocas em até 30 dias com nota fiscal.',
  maxTokens: 200,
  reference: `Trinta dias (item ${i}).`,
}));

function fakePipeline(falhaDoB: (question: string) => boolean): FakeOpenRouter {
  return fakeOpenRouter({
    catalog: ['fake/judge', 'fake/a', 'fake/b', 'fake/ref', 'fake/gen'].map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: (req) => {
      if (req.stream) return { text: `Resposta de ${req.model}` };
      if (req.system.includes('DUELO')) return { text: duelReply(req, 'A') };
      if (req.model === 'fake/ref') return { text: 'gabarito' };
      const question = questionOf(req);
      if (candidateOf(req) === 'Resposta de fake/b' && falhaDoB(question)) {
        return { status: 400, bodyText: 'FALHA-DO-JUIZ' };
      }
      return { text: OK_JSON(req, 'resolve') };
    },
  });
}

const COMPARE = {
  mode: 'compare',
  theme: 'suporte',
  stages: 7,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  customStages: SETE,
  finalists: 2,
  timeoutMs: 5_000,
} as const;

function semImputacaoNoRecord(rec: RunRecord): void {
  for (const s of rec.stages) {
    if (s.referenceJudge) semImputacao(s.referenceJudge);
    if (s.judge) semImputacao(s.judge);
  }
}

describe('pipeline — juiz que falha em > 10% termina inconclusive (Node e SPA)', () => {
  let dirAnterior: string;
  let tmp: string;
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl004-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
  });

  afterAll(() => {
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  const motores = [
    ['Node', (cfg: RunConfig) => runNode(cfg, KEY, {})],
    ['SPA', (cfg: RunConfig) => runWeb(cfg as never, KEY, {}) as unknown as Promise<RunRecord>],
  ] as const;

  for (const [nome, rodar] of motores) {
    it(`${nome}: 2 de 14 vereditos perdidos (14,3%) => inconclusive; média e placar ignoram o ausente`, async () => {
      const fake = fakePipeline((q) => q.startsWith('CEN-0') || q.startsWith('CEN-1'));
      const rec = await comGateway(fake.fetch, () => rodar(COMPARE as unknown as RunConfig));
      expect(rec.status, rec.error).toBe('inconclusive');
      expect(rec.failureCountByRole?.judge).toBe(2);
      expect(rec.verdictIntegrity?.reasons).toEqual([expect.stringMatching(/^papel judge: 2 de 14 vereditos perdidos = 14.3% > 10%$/)]);
      // Média: 'fake/b' tem 5 'resolve' julgados => 100 (imputar 'parcial' daria 85,7; 'nao', 71,4).
      expect(rec.judgeScoreByContestant).toEqual({ 'fake/a': 100, 'fake/b': 100 });
      const s0 = rec.stages[0];
      expect(s0.referenceJudge?.verdictByContestant['fake/b']).toBeUndefined();
      expect(s0.referenceJudge?.verdictErrorByContestant?.['fake/b']?.kind).toBe('judge_failed');
      // Placar sintetizado: o ausente não recebe posição (nem último lugar).
      expect(s0.judge?.rankedContestantIds).toEqual(['fake/a']);
      expect(s0.judge?.acceptableByContestant['fake/b']).toBeUndefined();
      semImputacaoNoRecord(rec);
    });

    it(`${nome}: run íntegra com 7 cenários => finished, failureCountByRole zerado por papel`, async () => {
      const fake = fakePipeline(() => false);
      const rec = await comGateway(fake.fetch, () => rodar(COMPARE as unknown as RunConfig));
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.failureCountByRole).toEqual({ competitor: 0, judge: 0, duel: 0, gabarito: 0 });
      expect(rec.verdictIntegrity?.reasons).toEqual([]);
      semImputacaoNoRecord(rec);
    });
  }

  it('failureCountByRole/verdictIntegrity sobrevivem ao disco + normalizeRunRecord (whitelist silencioso)', async () => {
    const fake = fakePipeline((q) => q.startsWith('CEN-0') || q.startsWith('CEN-1'));
    const rec = await comGateway(fake.fetch, () => runNode(COMPARE as unknown as RunConfig, KEY, {}));
    const relido = await loadRun(rec.id);
    expect(relido?.status).toBe('inconclusive');
    expect(relido?.failureCountByRole).toEqual(rec.failureCountByRole);
    expect(relido?.verdictIntegrity).toEqual(rec.verdictIntegrity);
    expect(relido?.stages[0].referenceJudge?.verdictErrorByContestant).toEqual(
      rec.stages[0].referenceJudge?.verdictErrorByContestant,
    );
    // E o caminho do IndexedDB (JSON → normalize) também.
    const idb = normalizeRunRecord(JSON.parse(JSON.stringify(rec)));
    expect(idb.failureCountByRole).toEqual(rec.failureCountByRole);
    expect(idb.verdictIntegrity?.reasons).toEqual(rec.verdictIntegrity?.reasons);
  });

  it('treino: variationConfigFrom → runs → sessão soma failureCountByRole; lição sem o ausente', async () => {
    const BASE = 'Voce e um atendente de suporte. Responda com base no contexto do produto.';
    const fake = fakeOpenRouter({
      catalog: ['fake/judge', 'fake/a', 'fake/opt', 'fake/ref', 'fake/gen'].map((id) => catalogItem(id, 1e-6, 1e-6)),
      chat: (req) => {
        if (req.model === 'fake/opt') {
          const tecnica = /tecnica id="([^"]+)"/.exec(req.user)?.[1] ?? 'x';
          return {
            text: `Voce e um atendente cordial e preciso (${tecnica}). Responda sempre com base no contexto do produto, cite prazos e regras exatamente como aparecem e recuse o que estiver fora do escopo.`,
          };
        }
        if (req.stream) return { text: req.system.includes('(persona)') ? 'Resposta boa' : 'Resposta ruim' };
        if (req.system.includes('DUELO')) return { text: duelReply(req, 'A') };
        if (req.model === 'fake/ref') return { text: 'gabarito' };
        const question = questionOf(req);
        if (candidateOf(req) === 'Resposta boa') {
          if (question.startsWith('CEN-0')) return { status: 400, bodyText: 'FALHA-DO-JUIZ-X' };
          if (question.startsWith('CEN-1')) return { text: OK_JSON(req, 'nao', 'EXPLICACAO-Y') };
          return { text: OK_JSON(req, 'resolve') };
        }
        return { text: OK_JSON(req, 'nao', 'ruim') };
      },
    });
    const cfg: TrainingConfig = {
      mode: 'training',
      theme: 'suporte',
      stages: 7,
      datagenModelId: 'fake/gen',
      judgeModelIds: ['fake/judge'],
      referenceModelId: 'fake/ref',
      referenceJudging: true,
      contestantModelId: 'fake/a',
      basePrompt: BASE,
      techniqueIds: ['persona', 'constraints'],
      promptOptimization: true,
      optimizerModelId: 'fake/opt',
      iterations: 2,
      holdoutRatio: 0,
      finalists: 2,
      timeoutMs: 5_000,
      customStages: SETE,
    };
    const sessao = await comGateway(fake.fetch, () => trainToCompletion(cfg, KEY));
    expect(sessao.status, sessao.error).toBe('finished');
    expect(sessao.runIds.length).toBeGreaterThanOrEqual(2);
    const runs = await Promise.all(sessao.runIds.map((id) => loadRun(id)));
    let soma: Record<string, number> | undefined;
    for (const r of runs) soma = mergeFailureCounts(soma, r?.failureCountByRole) as Record<string, number>;
    expect(runs[0]?.failureCountByRole?.judge).toBe(1); // o campeão perdeu o veredito em CEN-0
    expect(sessao.failureCountByRole).toEqual(soma);
    expect(sessao.failureCountByRole?.judge).toBeGreaterThanOrEqual(2);
    // A lição da iteração 1 chegou ao reescritor com a falha REAL (CEN-1) e sem
    // o veredito ausente (CEN-0) — nem a mensagem de erro do juiz.
    const reescritas = fake.chatRequests().filter((r) => r.model === 'fake/opt');
    const comLicao = reescritas.filter((r) => r.user.includes('<licoes_da_iteracao_anterior>'));
    expect(comLicao.length).toBeGreaterThan(0);
    expect(comLicao.some((r) => r.user.includes('EXPLICACAO-Y'))).toBe(true);
    expect(reescritas.some((r) => r.user.includes('FALHA-DO-JUIZ'))).toBe(false);
    expect(comLicao.some((r) => r.user.includes('CEN-0'))).toBe(false);
  });
});
