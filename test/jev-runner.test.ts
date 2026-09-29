// Modo JEV — contrato do RUNNER contra o fake (sem rede, sem gasto): compare
// com decisão + LLM, pareamento, orçamento (corte caso-maior, casos incompletos
// FORA), cancelamento, inconclusivo, spec recusada (fail-fast), deriva de
// snapshot, throttle do save e eventos enxutos.

import { afterEach, describe, expect, it } from 'vitest';
import { createGateway, setDefaultGateway, getGateway } from '../src/openrouter.js';
import { BudgetLedger } from '../src/budget.js';
import {
  jevExample,
  parseJevConfig,
  resolveJevConfig,
  runJev,
  isJevConfigError,
  type JevEvent,
  type JevRunRecord,
  type ResolvedJevConfig,
} from '../src/engine/jev/index.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeRequest } from './fakeOpenRouter.js';
import { DECISION_CATALOG, edge400, oracleJev } from './fakeDecisions.js';

const KEY = 'sk-or-v1-fake-key-para-testes-0000';

function resolved(cfg: Record<string, unknown>): ResolvedJevConfig {
  const p = parseJevConfig(cfg);
  if (!p.ok) throw new Error(p.error);
  const r = resolveJevConfig(p.config);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.resolved;
}

const EX = jevExample('triagem', 'compare') as { cases: { state: { ticket: string }; expected: Record<string, unknown> }[] };
const GOLD = new Map(EX.cases.map((c) => [c.state.ticket, c.expected]));
const goldOf = (state: unknown, qid: string): unknown => GOLD.get((state as { ticket: string }).ticket)?.[qid];

/** LLM falso que responde o ouro, no formato pedido pela moldura jev-llm@1. */
function llmChat(req: FakeRequest): { text: string; usage: { prompt_tokens: number; completion_tokens: number; cost: number } } {
  const qTxt = /QUESTIONS:\n([\s\S]*?)\n\nOUTPUT/.exec(req.user)?.[1] ?? '{}';
  const q = JSON.parse(qTxt) as { id: string; type: string; criteria: unknown };
  const stTxt = /STATE:\n([\s\S]*)$/.exec(req.user)?.[1] ?? '{}';
  const gold = goldOf(JSON.parse(stTxt), q.id);
  let out: unknown;
  if (q.type === 'noul') out = { answer: gold === true, p_yes: gold === true ? 0.8 : 0.2 };
  else if (q.type === 'choice') {
    const keys = Object.keys(q.criteria as Record<string, unknown>);
    out = { choice: gold, probabilities: Object.fromEntries(keys.map((k) => [k, k === gold ? 0.7 : 0.3 / (keys.length - 1)])) };
  } else {
    const L = (q.criteria as unknown[]).length;
    out = { level: gold, probabilities: Object.fromEntries(Array.from({ length: L }, (_, i) => [String(i), i === gold ? 0.8 : 0.2 / (L - 1)])) };
  }
  return { text: JSON.stringify(out), usage: { prompt_tokens: 300, completion_tokens: 20, cost: 0.0002 } };
}

let prev = getGateway();
afterEach(() => {
  setDefaultGateway(prev);
});

function setup(opts: Parameters<typeof fakeOpenRouter>[0] = {}) {
  const fake = fakeOpenRouter({
    decisionCatalog: DECISION_CATALOG,
    catalog: [catalogItem('openai/gpt-5-mini', 0.25e-6, 2e-6, { supported_parameters: ['temperature', 'max_tokens', 'response_format', 'structured_outputs'] })],
    decisions: oracleJev({ goldOf, hits: (st, qid) => !(qid === 'team' && /cart|Pix|boleto/i.test(String((st as { ticket: string }).ticket))) }),
    chat: (req) => llmChat(req),
    ...opts,
  });
  const gateway = createGateway({ fetch: fake.fetch, sleep: noSleep });
  prev = setDefaultGateway(gateway);
  return { fake, gateway };
}

describe('runJev — compare (decisão × variante × LLM)', () => {
  it('pontua, pareia por caso, compara com o controle, simula a cascata e bate o custo com a fatura', async () => {
    const { fake, gateway } = setup();
    await gateway.listModels(KEY);
    const r = resolved({ ...jevExample('triagem', 'compare'), models: { decision: ['typesafe/jev-1.13'], llm: [{ modelId: 'openai/gpt-5-mini', reasoning: 'off' }] } });
    const eventos: JevEvent[] = [];
    const rec = await runJev(r, { apiKey: KEY, client: 'node', emit: (e) => eventos.push(e) });
    expect(rec.status).toBe('finished');
    expect(rec.contestants.map((c) => c.id)).toEqual(['d:original@typesafe/jev-1.13', 'd:rubrica-estruturada@typesafe/jev-1.13', 'l:original@openai/gpt-5-mini#off']);
    const ctrl = rec.metrics['d:original@typesafe/jev-1.13'];
    expect(ctrl.nScored).toBe(40 * 3);
    expect(ctrl.accuracy).toBeLessThan(1); // o fake erra "team" em tickets de cartão/Pix/boleto
    expect(rec.metrics['l:original@openai/gpt-5-mini#off'].accuracy).toBe(1);
    expect(rec.byQuestion['d:original@typesafe/jev-1.13'].team.accuracy).toBeLessThan(1);
    expect(rec.byQuestion['d:original@typesafe/jev-1.13'].is_bug.accuracy).toBe(1);
    expect(rec.comparisons?.map((c) => c.contestantId)).toEqual(['d:rubrica-estruturada@typesafe/jev-1.13', 'l:original@openai/gpt-5-mini#off']);
    const vsLlm = rec.comparisons!.find((c) => c.contestantId.startsWith('l:'))!;
    expect(vsLlm.accuracyDiffPp).toBeGreaterThan(0);
    expect(vsLlm.discordant.worse).toBe(0);
    expect(rec.cascade?.length).toBe(2);
    expect(rec.resolvedModels['typesafe/jev-1.13']).toEqual(['typesafe/jev-1.13-20260917']);
    // Dinheiro medido: o ledger da run bate com a fatura do fake (decisões + chat).
    expect(rec.totalCostUsd).toBeCloseTo(fake.billedUsd(), 10);
    expect(rec.cost.byKind.decision + rec.cost.byKind.llm).toBeCloseTo(fake.billedUsd(), 10);
    expect(ctrl.costExact).toBe(true);
    expect(ctrl.costPer1kDecisions).toBeGreaterThan(0);
    // Eventos enxutos: nunca estado nem rubrica.
    const texto = JSON.stringify(eventos);
    expect(texto).not.toContain('ticket');
    expect(texto).not.toContain('Cobrança, pagamento recusado');
    expect(eventos.filter((e) => e.type === 'jev.contestant.done').length).toBe(3);
    expect(eventos.at(-1)).toMatchObject({ type: 'jev.run.finished', status: 'finished' });
    // O corpo de decisão vai com session_id = runId.
    expect(fake.decisionRequests()[0].body?.session_id).toBe(rec.id);
  });

  it('eval com fit: política ajustada no calib e métricas calibradas FORA do calib', async () => {
    setup();
    const r = resolved({ ...jevExample('triagem', 'eval'), fit: true, split: { calibrationRatio: 0.5, seed: 3 } });
    const rec = await runJev(r, { apiKey: KEY, client: 'node' });
    const id = rec.contestants[0].id;
    expect(rec.policy?.[id]?.team?.fittedOn?.split).toBe('calib');
    const calibN = rec.cases.filter((c) => c.split === 'calib').length;
    expect(rec.metrics[id].calibrated?.n).toBe((40 - calibN) * 3);
  });
});

describe('runJev — orçamento, cancelamento e falhas', () => {
  it('orçamento: para, corta os ÚLTIMOS casos de todos os competidores, casos incompletos fora; gasto ≤ teto + 1 célula', async () => {
    const { fake, gateway } = setup();
    await gateway.listDecisionModels(KEY);
    const r = resolved({ ...jevExample('triagem', 'compare'), budgetUsd: 0.0006 });
    const rec = await runJev(r, { apiKey: KEY, client: 'node' });
    expect(rec.stoppedReason).toBe('budget');
    expect(rec.budgetExhausted).toBe(true);
    expect(rec.incompleteCaseIds.length).toBeGreaterThan(0);
    // corte caso-maior: os incompletos são o FIM da lista de casos
    const ordem = rec.cases.map((c) => c.id);
    const primeiroIncompleto = Math.min(...rec.incompleteCaseIds.map((id) => ordem.indexOf(id)));
    expect(rec.incompleteCaseIds.sort()).toEqual(ordem.slice(primeiroIncompleto).sort());
    // métricas só com casos completos
    const n = rec.cases.length - rec.incompleteCaseIds.length;
    expect(rec.metrics[rec.contestants[0].id].n).toBe(n * 3);
    const umaCelula = fake.billedUsd() / fake.decisionRequests().length;
    expect(rec.totalCostUsd).toBeLessThanOrEqual(0.0006 + umaCelula);
    expect(rec.comparisons?.[0].nEfetivo).toBeLessThanOrEqual(n);
  });

  it('cancelar: nenhum POST depois do abort, status aborted com o parcial', async () => {
    const ac = new AbortController();
    let n = 0;
    let depois = 0;
    const { fake } = setup({
      decisions: async (req) => {
        n += 1;
        if (ac.signal.aborted) depois += 1;
        if (n === 6) ac.abort('SIGINT');
        return oracleJev({ goldOf })(req);
      },
    });
    const r = resolved(jevExample('triagem', 'eval'));
    const rec = await runJev(r, { apiKey: KEY, client: 'node', signal: ac.signal });
    expect(rec.status).toBe('aborted');
    expect(rec.stoppedReason).toBe('cancelled');
    expect(depois).toBe(0);
    expect(fake.decisionRequests().length).toBeLessThan(40);
    expect(rec.cells.some((c) => c.skippedBy === 'cancelled')).toBe(true);
  });

  it('inconclusivo: mais de 10% das células sem nota (erro de infraestrutura)', async () => {
    setup({
      // 6 de 40 tickets (15%) falham SEMPRE (503 esgota as re-tentativas).
      decisions: (req) => (/Pix|boleto|cart/i.test(String((req.state as { ticket: string }).ticket)) ? { status: 503, bodyText: 'down' } : oracleJev({ goldOf })(req)),
    });
    const r = resolved(jevExample('triagem', 'eval'));
    const rec = await runJev(r, { apiKey: KEY, client: 'node' });
    expect(rec.status).toBe('inconclusive');
    expect(rec.inconclusiveReasons?.join(' ')).toMatch(/sem nota/);
  });

  it('spec recusada (400 do edge nas perguntas): fail-fast SÓ daquele competidor; controle recusado derruba a run', async () => {
    const variante = 'rubrica-estruturada';
    let postsVariante = 0;
    setup({
      decisions: (req) => {
        const crit = (req.questions?.team as { criteria?: Record<string, unknown> })?.criteria ?? {};
        const ehVariante = typeof crit.pagamentos === 'object' && crit.pagamentos !== null;
        if (ehVariante) {
          postsVariante += 1;
          return { status: 400, bodyText: edge400([{ path: ['questions', 'team', 'criteria', 'pagamentos'], message: 'Invalid input', code: 'invalid_union' }]) };
        }
        return oracleJev({ goldOf })(req);
      },
    });
    const r = resolved(jevExample('triagem', 'compare'));
    const rec = await runJev(r, { apiKey: KEY, client: 'node' });
    expect(rec.inconclusiveReasons ?? []).toEqual([]);
    expect(rec.status).toBe('finished');
    expect(Object.keys(rec.rejected ?? {})).toEqual([`d:${variante}@typesafe/jev-1.13`]);
    // Os pedidos já em voo quando a recusa chegou podem ter saído; nenhum depois.
    expect(postsVariante).toBeLessThan(40);
    expect(rec.cells.filter((c) => c.skippedBy === 'spec-rejected').length).toBeGreaterThan(0);
    expect(rec.comparisons ?? []).toEqual([]);
    expect(rec.incompleteCaseIds).toEqual([]);

    // Controle recusado: a run inteira é spec-rejected.
    setup({ decisions: () => ({ status: 400, bodyText: edge400([{ path: ['questions', 'team', 'type'], message: 'bad' }]) }) });
    const rec2 = await runJev(resolved(jevExample('triagem', 'eval')), { apiKey: KEY, client: 'node' });
    expect(rec2.status).toBe('error');
    expect(rec2.stoppedReason).toBe('spec-rejected');
    expect(rec2.error).toMatch(/recusada/);
  });

  it('401 derruba a run inteira (erro de conta), gravando o record', async () => {
    setup({ decisions: () => ({ status: 401, bodyText: '{"error":{"message":"No auth"}}' }) });
    const salvos: JevRunRecord[] = [];
    const err = await runJev(resolved(jevExample('triagem', 'eval')), { apiKey: KEY, client: 'node', save: async (r) => void salvos.push(r) }).catch((e: unknown) => e);
    expect((err as { gatewayError?: string }).gatewayError).toBe('auth');
    expect(salvos.at(-1)?.status).toBe('error');
  });

  it('deriva de snapshot vira aviso na run', async () => {
    setup({ decisions: (req, i) => ({ ...oracleJev({ goldOf })(req), model: i % 2 ? 'typesafe/jev-1.13-20260917' : 'typesafe/jev-1.13-20261001' }) });
    const rec = await runJev(resolved(jevExample('triagem', 'eval')), { apiKey: KEY, client: 'node' });
    expect(rec.resolvedModels['typesafe/jev-1.13'].length).toBe(2);
    expect(rec.warnings.join(' ')).toMatch(/snapshot-drift/);
  });

  it('lint com erro recusa ANTES de gastar (JevConfigError, zero POST)', async () => {
    const { fake } = setup();
    const cfg = jevExample('triagem', 'eval') as Record<string, unknown>;
    const spec = JSON.parse(JSON.stringify(cfg.spec));
    spec.questions.is_bug.criteria = { true: 'sim' };
    const err = await runJev(resolved({ ...cfg, spec }), { apiKey: KEY, client: 'node' }).catch((e: unknown) => e);
    expect(isJevConfigError(err)).toBe(true);
    expect(fake.decisionRequests().length).toBe(0);
  });

  it('save com throttle (≥ intervalo) + gravação final; parentLedger recebe o gasto', async () => {
    const { fake } = setup();
    const saves: string[] = [];
    const pai = new BudgetLedger({ budgetUsd: 1 });
    const rec = await runJev(resolved(jevExample('triagem', 'eval')), {
      apiKey: KEY,
      client: 'node',
      parentLedger: pai,
      saveThrottleMs: 60_000,
      save: async (r) => void saves.push(r.status),
    });
    expect(saves.length).toBeLessThanOrEqual(3);
    expect(saves.at(-1)).toBe(rec.status);
    expect(pai.spentUsd).toBeCloseTo(fake.billedUsd(), 10);
  });
});
