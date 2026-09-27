// IMPL-017 / R-07a:REC-2 — cancelamento/timeout é cobrado pelo provedor, então
// NÃO pode sair dos livros como US$ 0. Contrato:
//   (i)   abort/timeout/sem usage => reserva MANTIDA (status pending, committed
//         estável); sem id recuperável => a reserva inteira vira gasto
//         conservador (nunca zero); só HTTP de erro/nada despachado devolve;
//   (ii)  invariante spent + pending <= budget depois de cada chamada;
//   (iii) datagen e reescritor mandam max_tokens (assert no corpo);
//   (iv)  gancho de conciliação (IMPL-074): ledger − Σ /generation <= 1% com
//         timeouts injetados (o /generation aqui é simulado);
//   (v)   estouro limitado a <= 1 chamada em voo por papel.
// Tudo com transporte falso: zero rede, zero gasto.

import { buildCaseInput } from '../src/engine/caseInput.js';
import { describe, expect, it, vi } from 'vitest';
import { BudgetLedger, isBudgetSignal, isControlSignal } from '../src/budget.js';
import { runCompetitor } from '../src/competitor.js';
import { renderSpend, Output } from '../src/cli/output.js';
import { emitRunEvent } from '../src/cli/ndjson.js';
import {
  DEFAULT_MAX_TOKENS,
  createGateway,
  setDefaultGateway,
  type FetchLike,
  type OpenRouterGateway,
} from '../src/openrouter.js';
import { generateStage, generateStages } from '../src/datagen.js';
import { generateBasePrompt, generateContestants, llmReflectLessons } from '../src/variator.js';
import { listTechniques } from '../src/techniques.js';
import { normalizeRunRecord } from '../src/normalize.js';
import type { CostRole, CostSink, Reservation, RunRecord, StageSpec } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const msgs = [
  { role: 'system' as const, content: 'Voce e um assistente.' },
  { role: 'user' as const, content: 'Diga oi.' },
];

// Preço de catálogo: 1e-6/token de entrada, 1e-5/token de saída.
const P_IN = 1e-6;
const P_OUT = 1e-5;
const CATALOGO = [catalogItem('m/priced', P_IN, P_OUT)];

/** Reserva que o gateway faz para `msgs` com teto `maxTokens` (chars/4 + teto × preço). */
function reservaDe(maxTokens: number, messages = msgs): number {
  const chars = messages.reduce((s, m) => s + m.content.length, 0);
  return Math.ceil(chars / 4) * P_IN + maxTokens * P_OUT;
}

function sse(frames: unknown[]): string {
  return frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join('');
}

/**
 * Transporte falso com os modos que o fake genérico não tem: travar até o
 * abort (timeout/cancelamento) e stream que corta no meio DEPOIS de mandar o id.
 */
type Modo =
  | { kind: 'ok'; cost: number; id?: string }
  | { kind: 'no-usage'; id?: string }
  | { kind: 'hang' } // nunca responde: só o abort/timeout encerra
  | { kind: 'stream-cut'; id: string } // 1 chunk com id e depois trava até o abort
  | { kind: 'http'; status: number };

function transporte(modo: (n: number, body: Record<string, unknown>) => Modo) {
  const corpos: Record<string, unknown>[] = [];
  let n = 0;
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/models')) return new Response(JSON.stringify({ data: CATALOGO }), { status: 200 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    corpos.push(body);
    const signal = init?.signal;
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    const m = modo(n++, body);
    const stream = body.stream === true;
    if (m.kind === 'http') return new Response('erro', { status: m.status });
    if (m.kind === 'hang') {
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    if (m.kind === 'stream-cut') {
      const enc = new TextEncoder();
      const corpo = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(enc.encode(sse([{ id: m.id, choices: [{ delta: { content: 'meia resp' } }] }])));
          signal?.addEventListener('abort', () => ctrl.error(signal.reason), { once: true });
        },
      });
      return new Response(corpo, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    const usage = m.kind === 'ok' ? { prompt_tokens: 5, completion_tokens: 5, cost: m.cost } : undefined;
    if (stream) {
      const frames: unknown[] = [{ ...(m.id ? { id: m.id } : {}), choices: [{ delta: { content: 'oi' } }] }];
      frames.push({ ...(m.id ? { id: m.id } : {}), choices: [{ delta: {}, finish_reason: 'stop' }] });
      if (usage) frames.push({ ...(m.id ? { id: m.id } : {}), choices: [], usage });
      frames.push('[DONE]');
      return new Response(sse(frames), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        ...(m.id ? { id: m.id } : {}),
        choices: [{ message: { content: 'oi' }, finish_reason: 'stop' }],
        ...(usage ? { usage } : {}),
      }),
      { status: 200 },
    );
  };
  return { fetch, corpos };
}

async function gatewayCom(modo: Parameters<typeof transporte>[0]) {
  const t = transporte(modo);
  const gw = createGateway({ fetch: t.fetch, sleep: noSleep });
  await gw.listModels(KEY); // catálogo quente: a reserva tem preço
  return { gw, ...t };
}

/** Reserva capturada pelo sink (para ler o status depois da chamada). */
function espiao(ledger: BudgetLedger): { sink: CostSink; reservas: Reservation[] } {
  const reservas: Reservation[] = [];
  const sink: CostSink = {
    reserve: (...a) => {
      const r = ledger.reserve(...a);
      reservas.push(r);
      return r;
    },
    note: (r, e) => ledger.note(r, e),
    pending: (r, e) => ledger.pending(r, e),
  };
  return { sink, reservas };
}

// ---------------------------------------------------------------------------
// (i) abort/timeout/sem usage: reserva mantida, nunca zero
// ---------------------------------------------------------------------------

describe('IMPL-017 (i) — chamada abortada não sai dos livros como US$ 0', () => {
  it('ledger: pending mantém committedUsd estável (nem gasto, nem devolvida) até conciliar', () => {
    const ledger = new BudgetLedger({ budgetUsd: 1, estimateCall: () => 0.1 });
    const r = ledger.reserve('competitor', 'm', 10, 100);
    expect(r.status).toBe('reserved');
    expect(ledger.committedUsd).toBeCloseTo(0.1, 12);
    ledger.pending(r, { role: 'competitor', modelId: 'm', reason: 'aborted', generationId: 'gen-1' });
    expect(r.status).toBe('pending');
    expect(ledger.committedUsd).toBeCloseTo(0.1, 12); // NÃO zerou
    expect(ledger.pendingUsd).toBeCloseTo(0.1, 12);
    expect(ledger.spentUsd).toBe(0);
    // release tardio (ex.: finally antigo) não devolve uma pendente
    r.release();
    expect(ledger.committedUsd).toBeCloseTo(0.1, 12);
    expect(ledger.summary()).toMatchObject({ pendingUsd: 0.1, pendingCalls: 1, spentUsd: 0 });
    expect(ledger.pendingEntries()).toEqual([
      { generationId: 'gen-1', role: 'competitor', modelId: 'm', usd: 0.1, reason: 'aborted' },
    ]);
  });

  it('ledger: sem id recuperável a reserva INTEIRA vira gasto conservador (source unknown)', () => {
    const ledger = new BudgetLedger({ budgetUsd: 1, estimateCall: () => 0.2 });
    const r = ledger.reserve('datagen', 'm', 10, 100);
    ledger.pending(r, { role: 'datagen', modelId: 'm', reason: 'timeout' });
    expect(r.status).toBe('conservative');
    expect(ledger.spentUsd).toBeCloseTo(0.2, 12);
    expect(ledger.committedUsd).toBeCloseTo(0.2, 12);
    expect(ledger.pendingUsd).toBe(0);
    expect(ledger.byRole.datagen).toMatchObject({ calls: 1, usd: 0.2 });
    expect(ledger.accuracy.unknown).toBe(1);
    expect(ledger.summary()).toMatchObject({ conservativeUsd: 0.2, conservativeCalls: 1 });
  });

  it('gateway (stream): corte no meio com id => pending com o id dos chunks; committed estável', async () => {
    const { gw } = await gatewayCom(() => ({ kind: 'stream-cut', id: 'gen-stream-1' }));
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    const { sink, reservas } = espiao(ledger);
    const ac = new AbortController();
    const p = gw.chatCompletionStream({
      apiKey: KEY,
      modelId: 'm/priced',
      messages: msgs,
      maxTokens: 1000,
      sink,
      signal: ac.signal,
      onDelta: () => ac.abort(new Error('cancelado pelo usuario')),
    });
    await expect(p).rejects.toThrow(/cancelado/);
    const est = reservaDe(1000);
    expect(reservas[0].status).toBe('pending');
    expect(ledger.committedUsd).toBeCloseTo(est, 12);
    expect(ledger.pendingUsd).toBeCloseTo(est, 12);
    expect(ledger.spentUsd).toBe(0);
    expect(ledger.pendingEntries()).toMatchObject([
      { generationId: 'gen-stream-1', role: 'competitor', reason: 'aborted' },
    ]);
  });

  it('gateway (não-streaming): timeout sem id => gasto conservador = reserva inteira', async () => {
    const { gw } = await gatewayCom(() => ({ kind: 'hang' }));
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    const { sink, reservas } = espiao(ledger);
    await expect(
      gw.chatCompletion({ apiKey: KEY, modelId: 'm/priced', messages: msgs, maxTokens: 500, timeoutMs: 15, sink, role: 'judge' }),
    ).rejects.toThrow(/timeout/);
    const est = reservaDe(500);
    expect(est).toBeGreaterThan(0);
    expect(reservas[0].status).toBe('conservative');
    expect(ledger.spentUsd).toBeCloseTo(est, 12); // nunca zero
    expect(ledger.committedUsd).toBeCloseTo(est, 12);
    expect(ledger.byRole.judge.calls).toBe(1);
    expect(ledger.accuracy).toEqual({ exact: 0, estimated: 0, unknown: 1 });
    expect(gw.currentConcurrency().active).toBe(0);
  });

  it('gateway: 200 sem bloco usage => pending pelo id; custo devolvido marca o pendente (não é "custou 0")', async () => {
    const { gw } = await gatewayCom(() => ({ kind: 'no-usage', id: 'gen-nu-1' }));
    const ledger = new BudgetLedger();
    const r = await gw.chatCompletion({ apiKey: KEY, modelId: 'm/priced', messages: msgs, maxTokens: 200, sink: ledger });
    expect(r.text).toBe('oi');
    // Mesma regra do ledger (revisão): o pendente fica FORA do gasto — `usd` 0
    // — mas vai marcado com a reserva inteira em `pendingUsd`. Antes o `usd`
    // voltava cheio e soma(costByContestant) passava de totalCostUsd.
    expect(r.cost).toEqual({ usd: 0, source: 'unknown', pendingUsd: reservaDe(200) });
    expect(ledger.spentUsd).toBe(0);
    // sem teto também: a reserva existe e fica pendente (antes era uma reserva nula)
    expect(ledger.pendingUsd).toBeCloseTo(reservaDe(200), 12);
    expect(ledger.pendingEntries()[0]).toMatchObject({ generationId: 'gen-nu-1', reason: 'no_usage' });
    // os sinais de fim continuam contados (IMPL-014) mesmo sem usage
    expect(ledger.finishByRole.competitor?.calls).toBe(1);
  });

  it('só devolve quando NADA foi gerado: HTTP de erro e sinal já abortado antes do envio', async () => {
    const { gw } = await gatewayCom(() => ({ kind: 'http', status: 400 }));
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    const { sink, reservas } = espiao(ledger);
    await expect(gw.chatCompletion({ apiKey: KEY, modelId: 'm/priced', messages: msgs, maxTokens: 100, sink })).rejects.toThrow(
      /HTTP 400/,
    );
    expect(reservas[0].status).toBe('released');

    const ac = new AbortController();
    ac.abort(new Error('cancelado antes'));
    const ledger2 = new BudgetLedger();
    const esp2 = espiao(ledger2);
    await expect(
      gw.chatCompletion({ apiKey: KEY, modelId: 'm/priced', messages: msgs, maxTokens: 100, sink: esp2.sink, signal: ac.signal }),
    ).rejects.toThrow(/cancelado antes/);
    expect(esp2.reservas[0].status).toBe('released');
    for (const l of [ledger, ledger2]) {
      expect(l.committedUsd).toBe(0);
      expect(l.spentUsd).toBe(0);
      expect(l.pendingUsd).toBe(0);
    }
  });

  it('pendente sobe a cadeia (run -> sessão) e a porta suave desconta o pendente', () => {
    const raiz = new BudgetLedger({ budgetUsd: 1, estimateCall: () => 0.3 });
    const filho = raiz.fork();
    filho.pending(filho.reserve('competitor', 'm', 1, 1), {
      role: 'competitor',
      modelId: 'm',
      reason: 'timeout',
      generationId: 'gen-x',
    });
    expect(raiz.pendingUsd).toBeCloseTo(0.3, 12);
    expect(raiz.committedUsd).toBeCloseTo(0.3, 12);
    expect(raiz.remainingUsd()).toBeCloseTo(0.7, 12);
    expect(raiz.canAfford(0.75)).toBe(false); // antes: spent 0 => "cabe"
    // conciliação pela raiz fecha nos dois níveis
    expect(raiz.settlePending('gen-x', { usd: 0.12, source: 'usage' })).toBe(true);
    for (const l of [raiz, filho]) {
      expect(l.pendingUsd).toBe(0);
      expect(l.spentUsd).toBeCloseTo(0.12, 12);
      expect(l.committedUsd).toBeCloseTo(0.12, 12);
      expect(l.pendingEntries()).toEqual([]);
    }
    expect(raiz.settlePending('gen-x', { usd: 1, source: 'usage' })).toBe(false); // idempotente
  });

  it('id não achado no /generation (settle null) => vira conservador', () => {
    const ledger = new BudgetLedger({ estimateCall: () => 0.05 });
    ledger.pending(ledger.reserve('duel', 'm', 1, 1), { role: 'duel', modelId: 'm', reason: 'aborted', generationId: 'g' });
    expect(ledger.settlePending('g', null)).toBe(true);
    expect(ledger.summary()).toMatchObject({ spentUsd: 0.05, pendingUsd: 0, conservativeUsd: 0.05, conservativeCalls: 1 });
  });
});

// ---------------------------------------------------------------------------
// (ii) invariante spent + pending <= budget depois de CADA chamada
// ---------------------------------------------------------------------------

describe('IMPL-017 (ii) — spent + pending <= budget após cada chamada', () => {
  it('mistura de ok / sem usage / timeout / corte de stream, em paralelo, até o teto', async () => {
    // Custo real <= reserva (o provedor honra max_tokens): metade do teto.
    const { gw } = await gatewayCom((n, body) => {
      const cap = Number(body.max_tokens);
      const custo = 0.5 * reservaDe(cap);
      switch (n % 5) {
        case 0:
          return { kind: 'ok', cost: custo, id: `gen-${n}` };
        case 1:
          return { kind: 'no-usage', id: `gen-${n}` };
        case 2:
          return { kind: 'no-usage' };
        case 3:
          return { kind: 'hang' };
        default:
          return body.stream ? { kind: 'stream-cut', id: `gen-${n}` } : { kind: 'hang' };
      }
    });
    const budget = 0.2;
    const ledger = new BudgetLedger({ budgetUsd: budget });
    let checadas = 0;
    let estouros = 0;
    const checar = () => {
      checadas += 1;
      expect(ledger.spentUsd + ledger.pendingUsd).toBeLessThanOrEqual(budget + 1e-12);
      expect(ledger.spentUsd + ledger.pendingUsd).toBeLessThanOrEqual(ledger.committedUsd + 1e-12);
    };
    const roles: CostRole[] = ['competitor', 'judge', 'datagen', 'rewriter'];
    for (let lote = 0; lote < 6; lote++) {
      await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => {
          const role = roles[i % roles.length];
          const params = {
            apiKey: KEY,
            modelId: 'm/priced',
            messages: msgs,
            maxTokens: 1000 + 100 * i,
            timeoutMs: 10,
            sink: ledger,
            role,
          };
          const call = i % 2 === 0 ? gw.chatCompletionStream(params) : gw.chatCompletion(params);
          return call
            .catch((e: unknown) => {
              if (isBudgetSignal(e)) estouros += 1;
            })
            .finally(checar);
        }),
      );
    }
    expect(checadas).toBe(48);
    expect(estouros).toBeGreaterThan(0); // o teto foi de fato alcançado
    expect(ledger.pendingUsd).toBeGreaterThan(0);
    expect(ledger.conservativeUsd).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (iii) max_tokens em TODOS os papéis — datagen e reescritor no corpo
// ---------------------------------------------------------------------------

describe('IMPL-017 (iii) — datagen e reescritor enviam max_tokens', () => {
  it('generateStage, generateStages, reescrita, prompt base e reflexão: corpo com max_tokens > 0', async () => {
    const fake = fakeOpenRouter({
      chat: (req) => {
        if (req.system.includes('SYSTEM PROMPT completo')) {
          return { text: JSON.stringify({ systemPrompt: 'Voce e um atendente cordial que responde com base no contexto.' }) };
        }
        if (/QUANTIDADE|ETAPA/.test(req.user)) {
          const st = { question: 'Qual o prazo de troca?', productContext: 'Trocas em 30 dias.', maxTokens: 300 };
          return { text: JSON.stringify({ ...st, stages: [st, { ...st, question: 'Posso trocar sem nota?' }] }) };
        }
        return {
          text: 'Voce e um atendente cordial e preciso. Responda sempre com base no contexto do produto, cite prazos e regras exatamente como aparecem e recuse o que estiver fora do escopo.',
        };
      },
    });
    const prev: OpenRouterGateway = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    try {
      await generateStage({ apiKey: KEY, theme: 'suporte', stageIndex: 0, totalStages: 1, modelId: 'g/gen' }).catch(
        () => undefined,
      );
      await generateStages({ apiKey: KEY, theme: 'suporte', count: 2, modelId: 'g/gen' }).catch(() => undefined);
      const tecnica = listTechniques()[0].id;
      await generateContestants({
        apiKey: KEY,
        modelId: 'm/x',
        theme: 'suporte',
        basePrompt: 'Voce e um atendente. Responda com base no contexto do produto e cite prazos.',
        includeOriginal: false,
        techniqueIds: [tecnica],
        promptOptimization: true,
        optimizerModelId: 'o/opt',
      } as Parameters<typeof generateContestants>[0]).catch(() => undefined);
      await generateBasePrompt({ apiKey: KEY, modelId: 'o/opt', taskDescription: 'atender clientes' }).catch(
        () => undefined,
      );
      await llmReflectLessons({ apiKey: KEY, modelId: 'o/opt', baseLessons: '- errou prazos' }).catch(() => undefined);
    } finally {
      setDefaultGateway(prev);
    }
    const chats = fake.chatRequests();
    const porModelo = (m: string) => chats.filter((c) => c.model === m);
    expect(porModelo('g/gen').length).toBeGreaterThanOrEqual(2); // datagen: unitário + lote
    expect(porModelo('o/opt').length).toBeGreaterThanOrEqual(3); // reescrita + base + reflexão
    for (const c of chats) {
      expect(typeof c.body?.max_tokens, `${c.model} sem max_tokens`).toBe('number');
      expect(c.body!.max_tokens as number).toBeGreaterThan(0);
    }
  });

  it('chamada avulsa sem maxTokens: o corpo leva o teto default e a reserva usa o MESMO número', async () => {
    const fake = fakeOpenRouter();
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const tetos: number[] = [];
    const ledger = new BudgetLedger();
    const sink: CostSink = {
      reserve: (role, model, prompt, max, fb) => {
        tetos.push(max);
        return ledger.reserve(role, model, prompt, max, fb);
      },
      note: (r, e) => ledger.note(r, e),
      pending: (r, e) => ledger.pending(r, e),
    };
    await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs, sink });
    expect(fake.chatRequests()[0].body?.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(tetos).toEqual([DEFAULT_MAX_TOKENS]); // antes: reserva 1024 com saída ilimitada
  });
});

// ---------------------------------------------------------------------------
// (iv) conciliação — gancho do IMPL-074 com /generation SIMULADO
// ---------------------------------------------------------------------------

describe('IMPL-017 (iv) — ledger conciliado bate com Σ /generation (±1%) com timeouts injetados', () => {
  it('pendentes conciliados pelo id => |ledger − fatura| <= 1%', async () => {
    // "Fatura" do provedor por geração: o que o /generation devolveria.
    const fatura = new Map<string, number>();
    const { gw } = await gatewayCom((n) => {
      const id = `gen-${n}`;
      const custo = 0.001 + 0.0001 * n;
      fatura.set(id, custo); // cobrado mesmo quando o cliente abortou
      // 30% de timeouts injetados (stream cortado depois do id) + 10% sem usage
      if (n % 10 < 3) return { kind: 'stream-cut', id };
      if (n % 10 === 3) return { kind: 'no-usage', id };
      return { kind: 'ok', cost: custo, id };
    });
    const ledger = new BudgetLedger({ budgetUsd: 10 });
    await Promise.allSettled(
      Array.from({ length: 40 }, () =>
        gw.chatCompletionStream({ apiKey: KEY, modelId: 'm/priced', messages: msgs, maxTokens: 800, timeoutMs: 10, sink: ledger }),
      ),
    );
    const pendentes = ledger.pendingEntries();
    expect(pendentes.length).toBe(16); // 12 timeouts + 4 sem usage, todos com id
    // Antes da conciliação o ledger SUPERestima (reserva inteira) — nunca subestima.
    const totalFatura = [...fatura.values()].reduce((s, v) => s + v, 0);
    expect(ledger.spentUsd + ledger.pendingUsd).toBeGreaterThanOrEqual(totalFatura);
    // IMPL-074 fará isto com GET /api/v1/generation?id=…; aqui o valor é simulado.
    for (const p of pendentes) ledger.settlePending(p.generationId, { usd: fatura.get(p.generationId)!, source: 'usage' });
    expect(ledger.pendingUsd).toBe(0);
    expect(Math.abs(ledger.spentUsd - totalFatura) / totalFatura).toBeLessThanOrEqual(0.01);
  });
});

// ---------------------------------------------------------------------------
// (v) estouro limitado a <= 1 chamada em voo por papel
// ---------------------------------------------------------------------------

describe('IMPL-017 (v) — estouro <= 1 chamada em voo por papel', () => {
  it('preço impossível de estimar (fora do catálogo): 1 em voo por papel e estouro <= 1 chamada/papel', async () => {
    const CUSTO = 0.4;
    const emVoo: Record<string, number> = {};
    const pico: Record<string, number> = {};
    const liberar: Array<() => void> = [];
    const fake = fakeOpenRouter({
      chat: async (req) => {
        const role = req.system;
        emVoo[role] = (emVoo[role] ?? 0) + 1;
        pico[role] = Math.max(pico[role] ?? 0, emVoo[role]);
        await new Promise<void>((r) => liberar.push(r));
        emVoo[role] -= 1;
        return { text: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1, cost: CUSTO } };
      },
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep }); // sem catálogo: preço desconhecido
    const budget = 1;
    const ledger = new BudgetLedger({ budgetUsd: budget });
    const roles: CostRole[] = ['competitor', 'judge'];
    const chamadas = roles.flatMap((role) =>
      Array.from({ length: 12 }, () =>
        gw
          .chatCompletion({
            apiKey: KEY,
            modelId: 'fora/do-catalogo',
            messages: [{ role: 'system', content: role }, msgs[1]],
            maxTokens: 100,
            sink: ledger,
            role,
          })
          .then(
            () => 'ok',
            (e: unknown) => (isControlSignal(e) ? 'budget' : 'erro'),
          ),
      ),
    );
    // Solta as respostas uma a uma até todas terminarem.
    let fim = false;
    const todas = Promise.all(chamadas).then((r) => {
      fim = true;
      return r;
    });
    while (!fim) {
      await new Promise((r) => setTimeout(r, 1));
      liberar.splice(0).forEach((f) => f());
    }
    const res = await todas;
    expect(res.filter((r) => r === 'erro')).toEqual([]);
    expect(res.filter((r) => r === 'budget').length).toBeGreaterThan(0);
    for (const role of roles) expect(pico[role]).toBe(1); // antes: 12 em voo por papel
    // estouro máximo = 1 chamada em voo por papel
    expect(ledger.spentUsd - budget).toBeLessThanOrEqual(roles.length * CUSTO + 1e-12);
  });

  it('com preço conhecido NÃO serializa (sem cap local de concorrência)', async () => {
    let emVoo = 0;
    let pico = 0;
    const liberar: Array<() => void> = [];
    const fake = fakeOpenRouter({
      catalog: [catalogItem('m/priced', P_IN, P_OUT)],
      chat: async () => {
        emVoo += 1;
        pico = Math.max(pico, emVoo);
        await new Promise<void>((r) => liberar.push(r));
        emVoo -= 1;
        return { text: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.0001 } };
      },
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    await gw.listModels(KEY);
    const ledger = new BudgetLedger({ budgetUsd: 10 });
    const todas = Promise.all(
      Array.from({ length: 4 }, () =>
        gw.chatCompletion({ apiKey: KEY, modelId: 'm/priced', messages: msgs, maxTokens: 100, sink: ledger }),
      ),
    );
    while (liberar.length < 4) await new Promise((r) => setTimeout(r, 1));
    expect(pico).toBe(4);
    liberar.splice(0).forEach((f) => f());
    await todas;
  });
});

// ---------------------------------------------------------------------------
// Resultado da run: spent/committed/pending sobrevive à releitura
// ---------------------------------------------------------------------------

describe('IMPL-017 — costLedger no RunRecord', () => {
  it('normalizeRunRecord preserva costLedger (whitelist silencioso)', () => {
    const costLedger = {
      spentUsd: 1,
      committedUsd: 1.5,
      pendingUsd: 0.5,
      pendingCalls: 2,
      conservativeUsd: 0.1,
      conservativeCalls: 1,
    };
    const rec = normalizeRunRecord({ id: 'r', status: 'finished', stages: [], costLedger } as never);
    expect((rec as { costLedger?: unknown }).costLedger).toEqual(costLedger);
  });
});

// ---------------------------------------------------------------------------
// Revisão independente do IMPL-017
// ---------------------------------------------------------------------------

const ETAPA: StageSpec = { question: 'Diga oi.', productContext: 'Voce e um assistente.', maxTokens: 200 };
/** Reserva do competidor para ETAPA — o caso montado por buildCaseInput (IMPL-009), como vai no fio. */
const reservaEtapa = () => reservaDe(200, buildCaseInput(ETAPA));

describe('IMPL-017 (revisão) — costUsd do competidor segue a regra do ledger', () => {
  it('timeout (conservador) + retry ok: costUsd soma as DUAS tentativas e bate com o ledger', async () => {
    const { gw } = await gatewayCom((n) => (n === 0 ? { kind: 'hang' } : { kind: 'ok', cost: 0.002, id: `gen-${n}` }));
    const prev = setDefaultGateway(gw);
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    try {
      const r = await runCompetitor({
        apiKey: KEY,
        contestantId: 'c',
        modelId: 'm/priced',
        stage: ETAPA,
        timeoutMs: 15,
        retries: 1,
        ctx: { sink: ledger },
      });
      expect(r.status).toBe('ok');
      // antes: 0.002 — o timeout lançado como gasto conservador sumia do contestant
      expect(r.costUsd).toBeCloseTo(0.002 + reservaEtapa(), 12);
      expect(r.costUsd).toBeCloseTo(ledger.spentUsd, 12); // soma(costByContestant) == totalCostUsd
    } finally {
      setDefaultGateway(prev);
    }
  });

  it('todas as tentativas em timeout: status error com costUsd = gasto conservador (não 0)', async () => {
    const { gw } = await gatewayCom(() => ({ kind: 'hang' }));
    const prev = setDefaultGateway(gw);
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    try {
      const r = await runCompetitor({
        apiKey: KEY,
        contestantId: 'c',
        modelId: 'm/priced',
        stage: ETAPA,
        timeoutMs: 15,
        retries: 1,
        ctx: { sink: ledger },
      });
      expect(r.status).toBe('error');
      expect(r.costUsd).toBeCloseTo(2 * reservaEtapa(), 12);
      expect(r.costUsd).toBeCloseTo(ledger.spentUsd, 12);
    } finally {
      setDefaultGateway(prev);
    }
  });

  it('200 sem usage (pendente): costUsd 0 como o totalCostUsd — a reserva fica no pendente, não no contestant', async () => {
    const { gw } = await gatewayCom(() => ({ kind: 'no-usage', id: 'gen-p' }));
    const prev = setDefaultGateway(gw);
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    try {
      const r = await runCompetitor({ apiKey: KEY, contestantId: 'c', modelId: 'm/priced', stage: ETAPA, ctx: { sink: ledger } });
      expect(r.status).toBe('ok');
      expect(r.costUsd).toBe(0);
      expect(ledger.spentUsd).toBe(0); // antes: costUsd = reserva > totalCostUsd = 0
      expect(ledger.pendingUsd).toBeCloseTo(reservaEtapa(), 12);
    } finally {
      setDefaultGateway(prev);
    }
  });
});

describe('IMPL-017 (revisão) — chamada SEM preço perdida sem custo medido não libera a vaga do papel', () => {
  /** Gateway sem catálogo quente e ledger sem estimador: preço impossível de estimar. */
  async function semPreco(modo: Parameters<typeof transporte>[0]) {
    const t = transporte(modo);
    return { gw: createGateway({ fetch: t.fetch, sleep: noSleep }), ...t };
  }
  const chamar = (gw: OpenRouterGateway, ledger: BudgetLedger, role: CostRole, extra: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
    gw.chatCompletion({ apiKey: KEY, modelId: 'fora/do-catalogo', messages: msgs, maxTokens: 100, sink: ledger, role, ...extra });

  it('timeout sem preço => a próxima sem preço do MESMO papel é recusada (BudgetExceeded); outro papel segue', async () => {
    const { gw, corpos } = await semPreco((n) => (n === 0 ? { kind: 'hang' } : { kind: 'ok', cost: 0.01 }));
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    await expect(chamar(gw, ledger, 'competitor', { timeoutMs: 15 })).rejects.toThrow(/timeout/);
    expect(ledger.spentUsd).toBe(0); // reserva 0: o gasto real não pesa em lugar nenhum…
    // …então liberar a vaga repetiria isso sem limite. Antes: entrava e pagava de novo.
    const bloqueada = await chamar(gw, ledger, 'competitor').catch((e: unknown) => e);
    expect(isBudgetSignal(bloqueada)).toBe(true);
    expect(corpos).toHaveLength(1); // nada foi despachado
    // outro papel continua com a sua vaga
    await expect(chamar(gw, ledger, 'judge')).resolves.toMatchObject({ text: 'oi' });
  });

  it('pendente sem preço conciliado (settlePending com custo) devolve a vaga do papel', async () => {
    const { gw } = await semPreco((n) => (n === 0 ? { kind: 'no-usage', id: 'gen-u' } : { kind: 'ok', cost: 0.01 }));
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    await chamar(gw, ledger, 'competitor');
    expect(ledger.pendingEntries()).toHaveLength(1);
    expect(isBudgetSignal(await chamar(gw, ledger, 'competitor').catch((e: unknown) => e))).toBe(true);
    ledger.settlePending('gen-u', { usd: 0.02, source: 'usage' });
    await expect(chamar(gw, ledger, 'competitor')).resolves.toMatchObject({ text: 'oi' });
    expect(ledger.spentUsd).toBeCloseTo(0.03, 12);
  });

  it('a espera pela vaga observa o sinal da PRÓPRIA chamada (não só o da run)', async () => {
    const { gw, corpos } = await semPreco(() => ({ kind: 'hang' }));
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    const primeira = chamar(gw, ledger, 'competitor', { timeoutMs: 200 }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5));
    const ctl = new AbortController();
    const segunda = chamar(gw, ledger, 'competitor', { signal: ctl.signal }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5));
    ctl.abort(new Error('cancelada pelo chamador'));
    const t0 = Date.now();
    const erro = await segunda;
    expect(Date.now() - t0).toBeLessThan(100); // antes: presa até a 1ª terminar
    expect(String((erro as Error).message)).toMatch(/cancelada pelo chamador/);
    expect(corpos).toHaveLength(1); // a 2ª nunca saiu
    await primeira;
  });
});

describe('IMPL-017 (revisão) — pendentes persistidos e visíveis', () => {
  it('summary() leva as pendentes (id/papel/modelo/reserva/motivo) — conciliáveis depois do processo', async () => {
    const { gw } = await gatewayCom(() => ({ kind: 'stream-cut', id: 'gen-cut' }));
    const ledger = new BudgetLedger({ budgetUsd: 1 });
    await expect(
      gw.chatCompletionStream({ apiKey: KEY, modelId: 'm/priced', messages: msgs, maxTokens: 300, timeoutMs: 15, sink: ledger, role: 'judge' }),
    ).rejects.toThrow();
    const s = ledger.summary();
    expect(s.pendingCalls).toBe(1);
    expect(s.pendingEntries).toEqual([
      { generationId: 'gen-cut', role: 'judge', modelId: 'm/priced', usd: reservaDe(300), reason: 'timeout' },
    ]);
    // Sobrevive à releitura do record (JSON) e à normalização.
    const rec = normalizeRunRecord(JSON.parse(JSON.stringify({ id: 'r', status: 'cancelled', stages: [], costLedger: s })) as never);
    expect((rec as { costLedger?: typeof s }).costLedger?.pendingEntries?.[0].generationId).toBe('gen-cut');
    // Sem pendentes, o campo nem aparece (records enxutos).
    expect('pendingEntries' in new BudgetLedger().summary()).toBe(false);
  });

  it('NDJSON: run.finished leva os números do ledger SEM a lista de pendentes', () => {
    const costLedger = {
      spentUsd: 1,
      committedUsd: 1.5,
      pendingUsd: 0.5,
      pendingCalls: 1,
      conservativeUsd: 0,
      conservativeCalls: 0,
      pendingEntries: [{ generationId: 'g', role: 'competitor' as const, modelId: 'm', usd: 0.5, reason: 'timeout' as const }],
    };
    const linhas: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => (linhas.push(String(c)), true));
    try {
      const out = new Output({ format: 'ndjson' });
      const record = { id: 'r', status: 'cancelled', config: { stages: 1 }, mode: 'compare', contestants: [], stages: [], scoreboard: {}, totalCostUsd: 1, startedAt: 'x', costLedger } as unknown as RunRecord;
      emitRunEvent(out, { type: 'run.finished', runId: 'r', record });
    } finally {
      spy.mockRestore();
    }
    const fim = linhas.map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e.type === 'run.finished')!;
    const { pendingEntries: _omit, ...enxuto } = costLedger;
    expect(fim.costLedger).toEqual(enxuto);
  });

  it('narração TTY (renderSpend) mostra pendente, conservador e conta PENDENTES na precisão', () => {
    const linhas = renderSpend(undefined, 0.1, 1, { exact: 3, estimated: 0, unknown: 1 }, {
      spentUsd: 0.1,
      committedUsd: 0.35,
      pendingUsd: 0.25,
      pendingCalls: 2,
      conservativeUsd: 0.05,
      conservativeCalls: 1,
    });
    const txt = linhas.join('\n');
    expect(txt).toMatch(/Pendente .*2 chamada\(s\) sem custo medido/);
    expect(txt).toMatch(/pode chegar a \$0\.35/);
    expect(txt).toMatch(/Conservador .*1 chamada\(s\) sem id/);
    expect(txt).toMatch(/1 SEM PREÇO · 2 PENDENTES/);
    // Sem ledger (records antigos), nada muda.
    expect(renderSpend(undefined, 0.1, 1).join('\n')).not.toMatch(/Pendente|Conservador/);
  });
});
