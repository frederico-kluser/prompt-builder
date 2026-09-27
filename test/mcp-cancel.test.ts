// Testes de CONTRATO do cancelamento cooperativo do servidor MCP (IMPL-025,
// R-13:REC-4 / D-64 / M-61).
//
//   (i)   depois de notifications/cancelled, NENHUMA chamada paga nova — o
//         ledger para de reservar e o fetch em voo cai (limiar: < 2 s);
//   (ii)  a run cancelada vira record 'aborted' + stoppedReason 'cancelled',
//         com o parcial legível (get_result), em 100% dos pontos de corte;
//   (iii) SIGTERM durante a run grava o parcial e sai em < 12 s (graça ~10 s);
//   (iv)  ping a cada 500 ms durante um tools/call longo → 100% respondidos
//         em < 200 ms (o laço de leitura não espera ferramenta).
//
// Zero rede e zero gasto: o motor fala com o transporte FALSO do OpenRouter —
// injetado no gateway (em processo) ou servido por um http local para onde o
// processo real aponta via OPENROUTER_BASE_URL.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { getDataDir, listRuns, listSessions, loadRun, loadSession, setDataDir } from '../src/storage.js';
import { isControlSignal, RunCancelled } from '../src/budget.js';
import { HeavyLane, cancellationOf, settleWithin, throwIfAborted } from '../src/jobs.js';
import { McpSession, callTool, type McpTool } from '../src/cli/commands/mcp.js';
import { COST_ROLES, type RunRecord } from '../src/types.js';
import { noSleep, type FakeOpenRouter } from './fakeOpenRouter.js';
import {
  COMPARE,
  KEY,
  TRAINING,
  ate,
  dormir,
  fakeDoPipeline,
  openRouterHttp,
  processoMcp,
  recordsDoDisco,
  transporte,
  type Msg,
  type Papel,
} from './mcpHarness.js';

// ---------------------------------------------------------------------------
// Primitivas de jobs
// ---------------------------------------------------------------------------

describe('IMPL-025 — primitivas de jobs (fila de runs pesadas)', () => {
  it('HeavyLane: 1 por vez, FIFO; quem é abortado NA FILA nunca começa', async () => {
    const lane = new HeavyLane(1);
    const log: string[] = [];
    let soltarA!: () => void;
    const a = lane.run(async () => {
      log.push('A:início');
      await new Promise<void>((r) => (soltarA = r));
      log.push('A:fim');
      return 'a';
    });
    const acB = new AbortController();
    const b = lane.run(async () => {
      log.push('B');
      return 'b';
    }, acB.signal);
    const c = lane.run(async () => {
      log.push('C');
      return 'c';
    });
    await dormir(5);
    expect(lane.snapshot()).toEqual({ active: 1, queued: 2 });
    expect(lane.busy).toBe(true);

    acB.abort(new RunCancelled('desisti'));
    await expect(b).rejects.toSatisfy(isControlSignal);
    expect(lane.snapshot()).toEqual({ active: 1, queued: 1 });

    soltarA();
    await expect(a).resolves.toBe('a');
    await expect(c).resolves.toBe('c');
    expect(log).toEqual(['A:início', 'A:fim', 'C']);
    expect(lane.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it('HeavyLane: sinal já abortado rejeita sem ocupar vaga; erro de fn libera a vaga', async () => {
    const lane = new HeavyLane(1);
    const ac = new AbortController();
    ac.abort('SIGINT');
    let rodou = false;
    await expect(
      lane.run(async () => {
        rodou = true;
      }, ac.signal),
    ).rejects.toSatisfy(isControlSignal);
    expect(rodou).toBe(false);
    await expect(lane.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(lane.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it('cancellationOf reaproveita o sinal de controle; motivo comum vira RunCancelled', () => {
    const rc = new RunCancelled('x');
    const a = new AbortController();
    a.abort(rc);
    expect(cancellationOf(a.signal)).toBe(rc);
    const b = new AbortController();
    b.abort('SIGTERM');
    const e = cancellationOf(b.signal);
    expect(isControlSignal(e)).toBe(true);
    expect(e.message).toMatch(/SIGTERM/u);
    expect(() => throwIfAborted(b.signal)).toThrow(/cancelada/u);
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });

  it('settleWithin: true quando tudo assenta; false quando a graça esgota', async () => {
    expect(await settleWithin([dormir(5), Promise.reject(new Error('x'))], 500)).toBe(true);
    const t0 = Date.now();
    expect(await settleWithin([new Promise(() => undefined)], 40)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(400);
  });
});

// ---------------------------------------------------------------------------
// Sessão JSON-RPC com ferramentas falsas (semântica do protocolo)
// ---------------------------------------------------------------------------

interface Controle {
  inicios: string[];
  sinais: Map<string, AbortSignal>;
  soltar: Map<string, () => void>;
}

/** `pesada` entra na fila do processo e espera `soltar` (ou o abort); `leve` responde já. */
function ferramentasFalsas(ctl: Controle, opts: { ignoraAbort?: boolean } = {}): McpTool[] {
  return [
    {
      name: 'pesada',
      description: 'teste',
      inputSchema: { type: 'object' },
      noKey: true,
      run: async (args, _key, ctx) =>
        ctx.exclusive(async () => {
          const tag = String(args.tag);
          ctl.inicios.push(tag);
          ctl.sinais.set(tag, ctx.signal);
          await new Promise<void>((resolve) => {
            ctl.soltar.set(tag, resolve);
            if (!opts.ignoraAbort) ctx.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { tag, abortada: ctx.signal.aborted };
        }),
    },
    {
      name: 'leve',
      description: 'teste',
      inputSchema: { type: 'object' },
      noKey: true,
      run: async () => ({ ok: true }),
    },
  ];
}

function novaSessao(tools: McpTool[], graceMs = 2_000) {
  const out: Msg[] = [];
  const logs: string[] = [];
  const session = new McpSession({
    write: (m) => out.push(m as Msg),
    log: (m) => logs.push(m),
    lane: new HeavyLane(1),
    graceMs,
    tools,
  });
  const enviar = (m: Record<string, unknown>): void => session.handleLine(JSON.stringify({ jsonrpc: '2.0', ...m }));
  const resposta = (id: unknown): Msg | undefined => out.find((m) => m.id === id);
  return { session, out, logs, enviar, resposta };
}

describe('IMPL-025 — sessão MCP: laço livre, cancelamento e encerramento', () => {
  it('ping, tools/list e chamada leve respondem NA HORA enquanto um tools/call pesado está em voo', async () => {
    const ctl: Controle = { inicios: [], sinais: new Map(), soltar: new Map() };
    const { session, enviar, resposta } = novaSessao(ferramentasFalsas(ctl));
    enviar({ id: 1, method: 'tools/call', params: { name: 'pesada', arguments: { tag: 'a' } } });
    await ate(() => ctl.inicios.includes('a'), 1000, 'pesada começar');

    enviar({ id: 2, method: 'ping' });
    expect(resposta(2)?.result).toEqual({}); // síncrono: nem um tick de espera
    enviar({ id: 3, method: 'tools/list' });
    expect((resposta(3)?.result as { tools: unknown[] }).tools).toHaveLength(2);
    enviar({ id: 4, method: 'tools/call', params: { name: 'leve', arguments: {} } });
    await ate(() => resposta(4) !== undefined, 1000, 'leve responder');
    expect(resposta(1)).toBeUndefined();

    ctl.soltar.get('a')!();
    await ate(() => resposta(1) !== undefined, 1000, 'pesada responder');
    expect(session.pendingCalls).toBe(0);
  });

  it('notifications/cancelled: aborta o sinal com RunCancelled e NÃO responde a requisição cancelada', async () => {
    const ctl: Controle = { inicios: [], sinais: new Map(), soltar: new Map() };
    const { session, out, logs, enviar, resposta } = novaSessao(ferramentasFalsas(ctl));
    enviar({ id: 'x-1', method: 'tools/call', params: { name: 'pesada', arguments: { tag: 'a' } } });
    await ate(() => ctl.inicios.includes('a'), 1000, 'pesada começar');

    // requestId com tipo diferente (1 ≠ "x-1") e desconhecido: ignorados
    enviar({ method: 'notifications/cancelled', params: { requestId: 'nao-existe' } });
    enviar({ method: 'notifications/cancelled', params: { requestId: 0 } });
    expect(ctl.sinais.get('a')!.aborted).toBe(false);

    enviar({ method: 'notifications/cancelled', params: { requestId: 'x-1', reason: 'Request timed out' } });
    const sinal = ctl.sinais.get('a')!;
    expect(sinal.aborted).toBe(true);
    expect(isControlSignal(sinal.reason)).toBe(true);
    await ate(() => session.pendingCalls === 0, 1000, 'chamada assentar');
    expect(resposta('x-1')).toBeUndefined();
    expect(out).toEqual([]); // notificações não recebem resposta
    expect(logs.join('\n')).toMatch(/notifications\/cancelled.*Request timed out/u);
    expect(logs.join('\n')).toMatch(/resposta suprimida/u);

    // cancel que cruza com a resposta (chamada já concluída): ignorado sem efeito
    enviar({ id: 9, method: 'tools/call', params: { name: 'leve', arguments: {} } });
    await ate(() => resposta(9) !== undefined, 1000, 'leve responder');
    enviar({ method: 'notifications/cancelled', params: { requestId: 9 } });
    expect(out.filter((m) => m.id === 9)).toHaveLength(1);
  });

  it('fila: 1 run pesada por processo; cancelar a da fila não a deixa começar e a primeira segue', async () => {
    const ctl: Controle = { inicios: [], sinais: new Map(), soltar: new Map() };
    const { session, logs, enviar, resposta } = novaSessao(ferramentasFalsas(ctl));
    enviar({ id: 1, method: 'tools/call', params: { name: 'pesada', arguments: { tag: 'a' } } });
    enviar({ id: 2, method: 'tools/call', params: { name: 'pesada', arguments: { tag: 'b' } } });
    enviar({ id: 3, method: 'tools/call', params: { name: 'pesada', arguments: { tag: 'c' } } });
    await ate(() => ctl.inicios.includes('a'), 1000, 'a começar');
    await dormir(10);
    expect(ctl.inicios).toEqual(['a']); // b e c esperam a vez
    expect(logs.some((l) => /aguardando a vez/u.test(l))).toBe(true);

    enviar({ method: 'notifications/cancelled', params: { requestId: 2 } });
    await ate(() => session.pendingCalls === 2, 1000, 'b sair da fila');
    ctl.soltar.get('a')!();
    await ate(() => ctl.inicios.includes('c'), 1000, 'c começar');
    ctl.soltar.get('c')!();
    await ate(() => session.pendingCalls === 0, 1000, 'tudo assentar');
    expect(ctl.inicios).toEqual(['a', 'c']); // b nunca começou (nada gasto)
    expect(resposta(1)).toBeDefined();
    expect(resposta(2)).toBeUndefined();
    expect(resposta(3)).toBeDefined();
  });

  it('protocolo: id repetido em voo → -32600; tools/call sem id é ignorado; cancel de initialize é ignorado', async () => {
    const ctl: Controle = { inicios: [], sinais: new Map(), soltar: new Map() };
    const { session, out, enviar, resposta } = novaSessao(ferramentasFalsas(ctl));
    enviar({ id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect((resposta(0)?.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');
    enviar({ method: 'notifications/cancelled', params: { requestId: 0 } });

    enviar({ id: 5, method: 'tools/call', params: { name: 'pesada', arguments: { tag: 'a' } } });
    await ate(() => ctl.inicios.includes('a'), 1000, 'a começar');
    enviar({ id: 5, method: 'tools/call', params: { name: 'leve', arguments: {} } });
    expect(resposta(5)?.error?.code).toBe(-32600);

    const antes = out.length;
    enviar({ method: 'tools/call', params: { name: 'leve', arguments: {} } }); // notificação
    enviar({ method: 'metodo/inexistente' }); // notificação desconhecida
    await dormir(10);
    expect(out.length).toBe(antes);
    enviar({ id: 6, method: 'tools/call', params: { name: 'nao-existe' } });
    await ate(() => resposta(6) !== undefined, 1000, 'erro de ferramenta');
    expect(resposta(6)?.error?.code).toBe(-32602);

    ctl.soltar.get('a')!();
    await ate(() => session.pendingCalls === 0, 1000, 'assentar');
    expect(out.filter((m) => m.id === 5)).toHaveLength(2); // o erro do repetido + a resposta da original
  });

  it('encerramento (EOF/SIGTERM): aborta as chamadas em voo, RESPONDE a elas e recusa novas', async () => {
    const ctl: Controle = { inicios: [], sinais: new Map(), soltar: new Map() };
    const { session, enviar, resposta } = novaSessao(ferramentasFalsas(ctl));
    enviar({ id: 1, method: 'tools/call', params: { name: 'pesada', arguments: { tag: 'a' } } });
    enviar({ id: 2, method: 'tools/call', params: { name: 'pesada', arguments: { tag: 'b' } } }); // na fila
    await ate(() => ctl.inicios.includes('a'), 1000, 'a começar');

    const r = await session.shutdown('eof');
    expect(r).toEqual({ forced: false, pending: 0 });
    expect(ctl.sinais.get('a')!.aborted).toBe(true);
    expect(JSON.parse((resposta(1)?.result as { content: { text: string }[] }).content[0].text)).toEqual({
      tag: 'a',
      abortada: true,
    });
    // a da fila nunca começou e sai como erro de ferramenta (o cliente não a cancelou)
    expect(ctl.inicios).toEqual(['a']);
    expect((resposta(2)?.result as { isError?: boolean }).isError).toBe(true);

    enviar({ id: 3, method: 'tools/call', params: { name: 'leve', arguments: {} } });
    expect(resposta(3)?.error?.code).toBe(-32000);
    enviar({ id: 4, method: 'ping' });
    expect(resposta(4)?.result).toEqual({});
    expect(session.shutdown('SIGTERM')).toBeInstanceOf(Promise); // idempotente
  });

  it('encerramento: ferramenta que ignora o abort não segura o processo além da graça', async () => {
    const ctl: Controle = { inicios: [], sinais: new Map(), soltar: new Map() };
    const { session, logs, enviar } = novaSessao(ferramentasFalsas(ctl, { ignoraAbort: true }), 60);
    enviar({ id: 1, method: 'tools/call', params: { name: 'pesada', arguments: { tag: 'a' } } });
    await ate(() => ctl.inicios.includes('a'), 1000, 'a começar');
    const t0 = Date.now();
    const r = await session.shutdown('SIGTERM');
    expect(r).toEqual({ forced: true, pending: 1 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(logs.join('\n')).toMatch(/graça esgotada/u);
    ctl.soltar.get('a')!();
  });
});

// ---------------------------------------------------------------------------
// Motor de verdade (run_benchmark/train_prompt) com transporte falso, em processo
// ---------------------------------------------------------------------------

describe('IMPL-025 — run_benchmark/train_prompt reais: cancelamento de ponta a ponta', () => {
  let tmp: string;
  let dirAnterior: string;
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pb-impl025-'));
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

  async function comTransporte<T>(
    pendura: Papel,
    fn: (t: ReturnType<typeof transporte>, fake: FakeOpenRouter) => Promise<T>,
  ): Promise<T> {
    const fake = fakeDoPipeline();
    const t = transporte(fake, pendura);
    const anterior: OpenRouterGateway = setDefaultGateway(createGateway({ fetch: t.fetch, sleep: noSleep }));
    try {
      return await fn(t, fake);
    } finally {
      setDefaultGateway(anterior);
    }
  }

  async function runsNovas(antes: Set<string>): Promise<RunRecord[]> {
    const todas = await listRuns();
    const novas = todas.filter((r) => !antes.has(r.id));
    return (await Promise.all(novas.map((r) => loadRun(r.id)))).filter((r): r is RunRecord => r !== null);
  }

  // (i) + (ii) em TODOS os pontos de corte do pipeline: 100% dos cancels.
  it.each<Papel>(['datagen', 'gabarito', 'competitor', 'judge', 'duel'])(
    'cancel durante %s: 0 chamada paga nova, run aborted/cancelled gravada e legível, sem resposta',
    async (papel) => {
      await comTransporte(papel, async (t, fake) => {
        const antes = new Set((await listRuns()).map((r) => r.id));
        // sessão com as ferramentas REAIS (tabela de produção)
        const out: Msg[] = [];
        const real = new McpSession({
          write: (m) => out.push(m as Msg),
          getKey: async () => KEY,
          lane: new HeavyLane(1),
        });
        real.handleLine(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 42,
            method: 'tools/call',
            params: { name: 'run_benchmark', arguments: { config: COMPARE, budgetUsd: 5 } },
          }),
        );
        await Promise.race([
          t.alvoChegou,
          dormir(8_000).then(() => Promise.reject(new Error(`${papel} nunca foi chamado`))),
        ]);
        const pagasAntes = fake.billedCalls();

        t.marcarCancel();
        const t0 = performance.now();
        real.handleLine(
          JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42, reason: 'teste' } }),
        );
        // durante o encerramento da run o laço segue respondendo
        real.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'p', method: 'ping' }));
        expect(out.find((m) => m.id === 'p')?.result).toEqual({});
        await ate(() => real.pendingCalls === 0, 2_000, 'run assentar após o cancel');
        const assentouEm = performance.now() - t0;
        expect(assentouEm).toBeLessThan(2_000);
        await dormir(50);

        // (i) nenhum pedido saiu para o "provedor" depois do cancel, nada novo foi cobrado
        expect(t.pagasDepoisDoCancel()).toBe(0);
        expect(fake.billedCalls()).toBe(pagasAntes);
        // nenhuma resposta para a requisição cancelada
        expect(out.find((m) => m.id === 42)).toBeUndefined();

        // (ii) record final aborted + cancelled, com o parcial legível
        const [rec] = await runsNovas(antes);
        expect(rec, 'nenhuma run gravada').toBeDefined();
        expect(rec.status).toBe('aborted');
        expect(rec.stoppedReason).toBe('cancelled');
        expect(rec.finishedAt).toBeDefined();
        // dinheiro medido: o record fecha com a fatura mesmo cortado no meio
        const byRole = rec.costByRole!;
        expect(COST_ROLES.reduce((s, r) => s + byRole[r].calls, 0)).toBe(fake.billedCalls());
        expect(rec.totalCostUsd).toBeCloseTo(fake.billedUsd(), 10);
        expect(rec.stages).toHaveLength(2); // os slots das etapas existem em todo corte
        if (papel === 'competitor' || papel === 'judge' || papel === 'duel') {
          // cenários (com gabarito) já materializados sobrevivem ao corte; as
          // etapas cortadas antes do julgamento ficam marcadas `incomplete`
          expect(rec.stages.filter((s) => s.spec?.reference)).toHaveLength(2);
        }
        if (papel === 'competitor') expect(rec.stages.every((s) => s.incomplete)).toBe(true);
        const lido = await callTool('get_result', { id: rec.id });
        expect(lido?.isError).toBeUndefined();
        const parcial = JSON.parse(lido!.content[0].text) as RunRecord;
        expect(parcial.status).toBe('aborted');
        expect(parcial.stoppedReason).toBe('cancelled');
      });
    },
    15_000,
  );

  it('EOF durante run_benchmark: aborta, grava o parcial e RESPONDE com status aborted', async () => {
    await comTransporte('competitor', async (t) => {
      const out: Msg[] = [];
      const s = new McpSession({ write: (m) => out.push(m as Msg), getKey: async () => KEY, lane: new HeavyLane(1) });
      s.handleLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'run_benchmark', arguments: { config: COMPARE, budgetUsd: 5 } },
        }),
      );
      await t.alvoChegou;
      t.marcarCancel();
      const r = await s.shutdown('eof');
      expect(r.forced).toBe(false);
      expect(t.pagasDepoisDoCancel()).toBe(0);
      const resp = out.find((m) => m.id === 7)?.result as { content: { text: string }[]; isError?: boolean };
      expect(resp?.isError).toBeUndefined();
      const resumo = JSON.parse(resp.content[0].text) as { runId: string; status: string; stoppedReason: string };
      expect(resumo.status).toBe('aborted');
      expect(resumo.stoppedReason).toBe('cancelled');
      const rec = await loadRun(resumo.runId);
      expect(rec?.status).toBe('aborted');
    });
  }, 15_000);

  it('train_prompt cancelado: sessão e run filha aborted/cancelled, sem resposta, 0 chamada paga nova', async () => {
    await comTransporte('competitor', async (t, fake) => {
      const antesSessoes = new Set((await listSessions()).map((x) => x.id));
      const out: Msg[] = [];
      const s = new McpSession({ write: (m) => out.push(m as Msg), getKey: async () => KEY, lane: new HeavyLane(1) });
      s.handleLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'treino',
          method: 'tools/call',
          params: { name: 'train_prompt', arguments: { config: TRAINING, budgetUsd: 5 } },
        }),
      );
      await Promise.race([t.alvoChegou, dormir(8_000).then(() => Promise.reject(new Error('sem competidor')))]);
      const pagasAntes = fake.billedCalls();
      t.marcarCancel();
      s.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'treino' } }));
      await ate(() => s.pendingCalls === 0, 2_000, 'treino assentar');
      expect(t.pagasDepoisDoCancel()).toBe(0);
      expect(fake.billedCalls()).toBe(pagasAntes);
      expect(out.find((m) => m.id === 'treino')).toBeUndefined();

      const nova = (await listSessions()).find((x) => !antesSessoes.has(x.id));
      const sessao = await loadSession(nova!.id);
      expect(sessao?.status).toBe('aborted');
      expect(sessao?.stoppedReason).toBe('cancelled');
      const filha = await loadRun(sessao!.runIds[0]);
      expect(filha?.status).toBe('aborted');
      expect(filha?.stoppedReason).toBe('cancelled');
      // o parcial da sessão também fecha com a fatura (reescritor + run filha)
      expect(sessao!.totalCostUsd).toBeCloseTo(fake.billedUsd(), 10);
      expect(filha!.totalCostUsd).toBeGreaterThan(0);
    });
  }, 15_000);
});

describe('IMPL-025 — processo real `prompt-builder mcp` (stdio)', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pb-impl025-proc-'));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('ping a cada 500 ms durante run_benchmark → 100% em < 200 ms; cancel → 0 chamada paga em 2 s, parcial aborted e SEM resposta', async () => {
    const or = await openRouterHttp();
    const dir = mkdtempSync(path.join(tmp, 'a-'));
    const mcp = processoMcp(dir, or.baseUrl);
    try {
      mcp.enviar({ id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
      await mcp.aguardar(0);
      mcp.enviar({
        id: 'run-1',
        method: 'tools/call',
        params: { name: 'run_benchmark', arguments: { config: COMPARE, budgetUsd: 5 } },
      });
      await Promise.race([
        or.competidorChegou,
        dormir(10_000).then(() => Promise.reject(new Error(`competidor nunca chamado\n${mcp.stderr()}`))),
      ]);

      // (iv) teste de ruído: ping a cada 500 ms com o tools/call longo em voo
      const latencias: number[] = [];
      for (let k = 0; k < 5; k++) {
        const inicio = performance.now();
        const t = mcp.enviar({ id: `ping-${k}`, method: 'ping' });
        const r = await mcp.aguardar(`ping-${k}`, 2_000);
        latencias.push(r.t - t);
        if (k === 2) {
          const tl = mcp.enviar({ id: 'lista', method: 'tools/list' });
          latencias.push((await mcp.aguardar('lista', 2_000)).t - tl);
        }
        await dormir(Math.max(0, 500 - (performance.now() - inicio)));
      }
      expect(latencias).toHaveLength(6);
      expect(Math.max(...latencias)).toBeLessThan(200);
      expect(mcp.resposta('run-1')).toBeUndefined(); // a run ainda está em voo

      // (i) cancel: nenhuma chamada paga nova
      const cancelAt = Date.now();
      mcp.enviar({ method: 'notifications/cancelled', params: { requestId: 'run-1', reason: 'McpError: -32001 Request timed out' } });
      await ate(
        () => recordsDoDisco(dir).some((r) => r.status !== 'running'),
        2_000,
        'record terminal em < 2 s',
      );
      await dormir(300);
      const depois = or.chegadas.filter((c) => c.t > cancelAt + 250);
      expect(depois, 'chamada de LLM depois do cancel').toEqual([]);
      // as chamadas penduradas foram ABORTADAS (conexão fechada), nunca servidas
      const competidores = or.chegadas.filter((c) => c.papel === 'competitor');
      expect(competidores.length).toBeGreaterThan(0);
      expect(competidores.every((c) => c.abortada && !c.servida)).toBe(true);

      // (ii) parcial aborted/cancelled, legível por get_result; nenhuma resposta ao cancelado
      const [rec] = recordsDoDisco(dir);
      expect(rec.status).toBe('aborted');
      expect(rec.stoppedReason).toBe('cancelled');
      expect(rec.stages.filter((s) => s.spec)).toHaveLength(2);
      expect(rec.totalCostUsd).toBeCloseTo(or.fake.billedUsd(), 10);
      mcp.enviar({ id: 'g', method: 'tools/call', params: { name: 'get_result', arguments: { id: rec.id } } });
      const g = (await mcp.aguardar('g')).msg.result as { content: { text: string }[] };
      expect((JSON.parse(g.content[0].text) as RunRecord).status).toBe('aborted');
      expect(mcp.resposta('run-1')).toBeUndefined();
      expect(mcp.stderr()).toMatch(/notifications\/cancelled/u);
      // "log do ledger" do cancelamento: onde ficou, como terminou, quanto foi medido
      expect(mcp.stderr()).toContain(
        `cancelada — resposta suprimida; run ${rec.id} aborted/cancelled, gasto medido US$ ${rec.totalCostUsd.toFixed(6)}`,
      );

      // EOF sem nada em voo: sai limpo
      mcp.child.stdin.end();
      const fim = await mcp.saiu;
      expect(fim.code).toBe(0);
    } finally {
      mcp.child.kill('SIGKILL');
      await or.close();
    }
  }, 30_000);

  it('SIGTERM durante run_benchmark: grava o parcial (aborted/cancelled), responde e sai em < 12 s', async () => {
    const or = await openRouterHttp();
    const dir = mkdtempSync(path.join(tmp, 'b-'));
    const mcp = processoMcp(dir, or.baseUrl);
    try {
      mcp.enviar({
        id: 5,
        method: 'tools/call',
        params: { name: 'run_benchmark', arguments: { config: COMPARE, budgetUsd: 5 } },
      });
      await Promise.race([
        or.competidorChegou,
        dormir(10_000).then(() => Promise.reject(new Error(`competidor nunca chamado\n${mcp.stderr()}`))),
      ]);
      const t0 = performance.now();
      const sigtermAt = Date.now();
      mcp.child.kill('SIGTERM');
      const fim = await mcp.saiu;
      expect(fim.t - t0).toBeLessThan(12_000);
      expect(fim.code).toBe(143);

      const [rec] = recordsDoDisco(dir);
      expect(rec.status).toBe('aborted');
      expect(rec.stoppedReason).toBe('cancelled');
      expect(rec.stages.filter((s) => s.spec)).toHaveLength(2);
      expect(or.chegadas.filter((c) => c.t > sigtermAt + 250)).toEqual([]);
      // encerramento não é cancelamento do cliente: a resposta sai com o parcial
      const r = mcp.resposta(5)?.msg.result as { content: { text: string }[] };
      const resumo = JSON.parse(r.content[0].text) as { runId: string; status: string; stoppedReason: string };
      expect(resumo).toMatchObject({ runId: rec.id, status: 'aborted', stoppedReason: 'cancelled' });
      expect(mcp.stderr()).toMatch(/encerrando \(SIGTERM\)/u);
    } finally {
      mcp.child.kill('SIGKILL');
      await or.close();
    }
  }, 30_000);
});
