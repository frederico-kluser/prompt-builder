// IMPL-077 (R-07a:REC-6) — timeout de INATIVIDADE + teto TOTAL por papel, erro
// de timeout TIPADO (distinto de BudgetExceeded/RunCancelled: controle ≠ erro)
// e listModels/validateKey que não penduram mais o processo para sempre.
// Contratos aqui (transporte falso, zero rede):
//   (i)  chamada que não emite nada acima da inatividade aborta com erro de
//        timeout TIPADO, que NÃO é sinal de controle;
//   (ii) listModels/validateKey abortam em <= 30 s contra servidor mudo;
//   (iii) teto total por papel configurável em 1-600 s, com default por papel
//        (competidor 90/600, juiz 60/120, duelo 60/90, gabarito/datagen/
//        reescritor 90/300) e `timeoutMs` do chamador só ENCURTA;
//   (iv) zero chamadas penduradas acima do teto: um lote inteiro de chamadas
//        mudas resolve dentro do teto de cada papel.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_META_TIMEOUT_MS,
  DEFAULT_ROLE_TIMEOUTS,
  clampRoleTimeoutMs,
  createGateway,
  isGatewayTimeout,
  type FetchLike,
} from '../src/openrouter.js';
import { isControlSignal } from '../src/budget.js';
import { COST_ROLES, type CostRole } from '../src/types.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const msgs = [{ role: 'user' as const, content: 'Diga oi.' }];

/** Servidor MUDO: nunca responde; só o abort/timeout encerra a chamada. */
const mudo: FetchLike = (_url, init) =>
  new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
  });

/** Stream que emite UM chunk e depois fica mudo (inatividade real). */
const streamMudo: FetchLike = (_url, init) => {
  const signal = init?.signal;
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  const enc = new TextEncoder();
  const corpo = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'oi' } }] })}\n\n`));
      signal?.addEventListener('abort', () => ctrl.error(signal.reason), { once: true });
    },
  });
  return Promise.resolve(new Response(corpo, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
};

describe('IMPL-077 (i) — inatividade aborta com timeout TIPADO (controle ≠ erro)', () => {
  it('stream mudo acima do idleTimeoutMs => GatewayTimeoutError kind idle, não-controle', async () => {
    const gw = createGateway({ fetch: streamMudo, sleep: undefined, streamTransport: true });
    const err = await gw
      .chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs, role: 'judge', idleTimeoutMs: 30, timeoutMs: 5_000 })
      .catch((e: unknown) => e);
    expect(isGatewayTimeout(err)).toBe(true);
    expect((err as { timeoutKind?: string }).timeoutKind).toBe('idle');
    expect(isControlSignal(err)).toBe(false); // timeout é ERRO, BudgetExceeded/RunCancelled é controle
    expect(String((err as Error).message)).toMatch(/timeout/i); // contratos antigos casam por texto
    expect((err as Error).name).toBe('TimeoutError'); // classificador do agente/runtime
  });

  it('sem nada recebido acima do teto total => timeout kind total (mesmo no caminho JSON)', async () => {
    const gw = createGateway({ fetch: mudo });
    const err = await gw
      .chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs, role: 'duel', timeoutMs: 30 })
      .catch((e: unknown) => e);
    expect(isGatewayTimeout(err)).toBe(true);
    expect((err as { timeoutKind?: string }).timeoutKind).toBe('total');
    expect(isControlSignal(err)).toBe(false);
  });
});

describe('IMPL-077 (ii) — listModels/validateKey não penduram contra servidor mudo', () => {
  it('abortam dentro do teto de metadados (<= 30 s) e validateKey responde network', async () => {
    expect(DEFAULT_META_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
    expect(DEFAULT_META_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    const gw = createGateway({ fetch: mudo, metaTimeoutMs: 50 });

    const t0 = Date.now();
    await expect(gw.listModels(KEY, true)).rejects.toSatisfy((e: unknown) => isGatewayTimeout(e));
    expect(Date.now() - t0).toBeLessThan(2_000);

    const t1 = Date.now();
    const r = await gw.validateKey(KEY);
    expect(Date.now() - t1).toBeLessThan(2_000);
    expect(r.ok).toBe(false);
    expect((r as { network?: boolean }).network).toBe(true);
    expect((r as { error: string }).error).toMatch(/timeout/i);
  });
});

describe('IMPL-077 (iii) — teto total por papel: defaults, clamp 1-600 s e chamador só encurta', () => {
  it('defaults por papel exatamente como calibrados (R-07a:REC-6)', () => {
    expect(DEFAULT_ROLE_TIMEOUTS.competitor).toEqual({ idleMs: 90_000, totalMs: 600_000 });
    expect(DEFAULT_ROLE_TIMEOUTS.judge).toEqual({ idleMs: 60_000, totalMs: 120_000 });
    expect(DEFAULT_ROLE_TIMEOUTS.duel).toEqual({ idleMs: 60_000, totalMs: 90_000 });
    expect(DEFAULT_ROLE_TIMEOUTS.gabarito).toEqual({ idleMs: 90_000, totalMs: 300_000 });
    expect(DEFAULT_ROLE_TIMEOUTS.datagen).toEqual({ idleMs: 90_000, totalMs: 300_000 });
    expect(DEFAULT_ROLE_TIMEOUTS.rewriter).toEqual({ idleMs: 90_000, totalMs: 300_000 });
    // Todo papel do ledger tem teto definido (nenhum fica sem).
    for (const role of COST_ROLES) expect(DEFAULT_ROLE_TIMEOUTS[role]).toBeDefined();
  });

  it('configuração recorta para 1-600 s (clampRoleTimeoutMs)', () => {
    expect(clampRoleTimeoutMs(10)).toBe(1_000);
    expect(clampRoleTimeoutMs(1_500)).toBe(1_500);
    expect(clampRoleTimeoutMs(600_001)).toBe(600_000);
    expect(clampRoleTimeoutMs(Number.NaN)).toBe(60_000);
  });

  it('teto do papel vale mesmo com timeoutMs maior do chamador; menor sempre vence', async () => {
    const gw = createGateway({ fetch: mudo, roleTimeouts: { judge: { totalMs: 1_000 } } });
    const t0 = Date.now();
    const err = await gw
      .chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs, role: 'judge', timeoutMs: 500_000 })
      .catch((e: unknown) => e);
    const decorrido = Date.now() - t0;
    expect(isGatewayTimeout(err)).toBe(true);
    expect(decorrido).toBeGreaterThanOrEqual(800); // respeitou ~1 s do papel…
    expect(decorrido).toBeLessThan(3_000); // …e não os 500 s pedidos pelo chamador

    // timeoutMs menor encurta (comportamento histórico preservado).
    const t1 = Date.now();
    await gw
      .chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs, role: 'judge', timeoutMs: 30 })
      .catch(() => undefined);
    expect(Date.now() - t1).toBeLessThan(900);
  });
});

describe('IMPL-077 (iv) — zero chamadas penduradas acima do teto', () => {
  it('lote de chamadas mudas em TODOS os papéis resolve dentro do teto', async () => {
    const roleTimeouts: Partial<Record<CostRole, { totalMs: number; idleMs: number }>> = {};
    for (const role of COST_ROLES) roleTimeouts[role] = { totalMs: 1_000, idleMs: 1_000 };
    const gw = createGateway({ fetch: mudo, roleTimeouts });
    const t0 = Date.now();
    const resultados = await Promise.allSettled(
      COST_ROLES.map((role) =>
        gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msgs, role, timeoutMs: 60_000 }),
      ),
    );
    const decorrido = Date.now() - t0;
    expect(decorrido).toBeLessThan(4_000); // nada pendurado acima do teto do papel
    for (const r of resultados) {
      expect(r.status).toBe('rejected');
      expect(isGatewayTimeout((r as PromiseRejectedResult).reason)).toBe(true);
    }
  });
});
