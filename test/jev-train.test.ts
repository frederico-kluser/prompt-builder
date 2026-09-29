// Modo JEV — contrato do TREINO contra um Jev falso "sensível à rubrica":
// promoção só com p ajustado ≤ 0,05 E ganho ≥ minGain E acurácia dentro do
// limite; SEM vazamento (exemplos e dossiê só do treino, casos-exemplo fora do
// gate, holdout só no fim); guarda intocada; paciência; deriva de snapshot;
// política ajustada no split certo; proponente pelo gateway (role rewriter).

import { afterEach, describe, expect, it } from 'vitest';
import { createGateway, setDefaultGateway, getGateway } from '../src/openrouter.js';
import {
  checkVariantContract,
  jevExample,
  parseJevConfig,
  resolveJevConfig,
  sessionVerdict,
  trainJev,
  withSpecId,
  type JevQuestionSpec,
  type JevRunRecord,
  type ResolvedJevConfig,
} from '../src/engine/jev/index.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeRequest } from './fakeOpenRouter.js';
import { DECISION_CATALOG, answerFor } from './fakeDecisions.js';

const KEY = 'sk-or-v1-fake-key-para-testes-0000';

function resolved(cfg: Record<string, unknown>): ResolvedJevConfig {
  const p = parseJevConfig(cfg);
  if (!p.ok) throw new Error(p.error);
  const r = resolveJevConfig(p.config);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.resolved;
}

const EX = jevExample('triagem', 'train') as Record<string, unknown> & { cases: { id: string; state: { ticket: string }; expected: Record<string, unknown> }[] };
const GOLD = new Map(EX.cases.map((c) => [c.state.ticket, c.expected]));
const goldOf = (state: unknown, qid: string): unknown => GOLD.get((state as { ticket: string }).ticket)?.[qid];
const hash = (s: string): number => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

/**
 * Jev falso: em `team`, acerta com confiança SÓ se a rubrica da opção certa
 * trouxer `examples`; sem exemplos erra ~metade dos tickets (erro confiante).
 * As outras perguntas acerta sempre.
 */
function jevSensivel(opts: { model?: (n: number) => string; semMelhora?: boolean } = {}) {
  let n = 0;
  return (req: FakeRequest) => {
    n += 1;
    const answers: Record<string, unknown> = {};
    for (const [qid, raw] of Object.entries(req.questions ?? {})) {
      const q = raw as { type: string; criteria: Record<string, unknown> };
      const gold = goldOf(req.state, qid);
      let pick = gold;
      if (qid === 'team') {
        const rub = q.criteria[String(gold)];
        const temExemplos = !opts.semMelhora && typeof rub === 'object' && rub !== null && Array.isArray((rub as { examples?: unknown }).examples);
        if (!temExemplos && hash((req.state as { ticket: string }).ticket) % 2 === 0) {
          pick = Object.keys(q.criteria).find((k) => k !== gold);
        }
      }
      answers[qid] = answerFor(q, pick, 0.9, 0.85);
    }
    return { answers, ...(opts.model ? { model: opts.model(n) } : {}) };
  };
}

let prev = getGateway();
afterEach(() => {
  setDefaultGateway(prev);
});

function setup(decisions: (req: FakeRequest, n: number) => unknown, chat?: (req: FakeRequest) => unknown) {
  const fake = fakeOpenRouter({
    decisionCatalog: DECISION_CATALOG,
    catalog: [catalogItem('openai/gpt-5-mini', 0.25e-6, 2e-6)],
    decisions: decisions as never,
    ...(chat ? { chat: chat as never } : {}),
  });
  prev = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
  return fake;
}

describe('trainJev — gate, promoção e holdout', () => {
  it('promove add_examples com p ajustado ≤ 0,05 e ganho ≥ minGain; holdout confirma; tudo pelo gateway', async () => {
    const fake = setup(jevSensivel());
    const r = resolved(EX);
    const runs: JevRunRecord[] = [];
    const s = await trainJev(r, { apiKey: KEY, client: 'node', saveRun: async (x) => void runs.push(x) });
    expect(s.status).toBe('finished');
    const promovidas = s.iterations.filter((i) => i.gate.decision === 'promoted');
    expect(promovidas.length).toBeGreaterThanOrEqual(1);
    const g = promovidas[0].gate;
    const idx = promovidas[0].candidates.filter((c) => c.status === 'evaluated').findIndex((c) => c.specId === g.bestSpecId);
    expect(g.pAdjusted[idx]).toBeLessThanOrEqual(0.05);
    expect(g.meanDiffPp[idx]!).toBeGreaterThanOrEqual(g.minGainPp);
    expect(s.championSpec.id).not.toBe(s.originalSpec.id);
    // a campeã tem exemplos na rubrica de team
    const team = s.championSpec.questions.find((q) => q.id === 'team') as Extract<JevQuestionSpec, { type: 'choice' }>;
    expect(Object.values(team.criteria).some((v) => typeof v === 'object' && v !== null && 'examples' in v)).toBe(true);
    expect(s.holdout?.strength).toBe('holdout');
    expect(s.holdout?.regressed).toBe(false);
    expect(sessionVerdict(s)).toBe('melhorou');
    expect(s.totalCostUsd).toBeCloseTo(fake.billedUsd(), 10);
    expect(s.runIds.length).toBe(runs.filter((x) => x.status !== 'running').length);
  });

  it('SEM vazamento: exemplos só do train; casos-exemplo fora dos pares do gate; holdout só no fim', async () => {
    const fake = setup(jevSensivel());
    const r = resolved(EX);
    const s = await trainJev(r, { apiKey: KEY, client: 'node' });
    const porSplit = new Map(r.cases.map((c) => [c.state as { ticket: string }, c.split]));
    const splitDoTexto = (t: string): string | undefined => [...porSplit.entries()].find(([st]) => st.ticket === t)?.[1];
    const team = s.championSpec.questions.find((q) => q.id === 'team') as Extract<JevQuestionSpec, { type: 'choice' }>;
    const exemplos = Object.values(team.criteria).flatMap((v) => (typeof v === 'object' && v !== null ? ((v as { examples?: string[] }).examples ?? []) : []));
    expect(exemplos.length).toBeGreaterThan(0);
    for (const e of exemplos) expect(splitDoTexto((JSON.parse(e) as { ticket: string }).ticket)).toBe('train');
    const it1 = s.iterations.find((i) => i.gate.decision === 'promoted')!;
    const trainN = r.cases.filter((c) => c.split === 'train').length;
    expect(it1.gate.excludedExampleCaseIds.length).toBeGreaterThan(0);
    expect(it1.gate.nPairs).toBe(trainN - it1.gate.excludedExampleCaseIds.length);
    for (const id of it1.gate.excludedExampleCaseIds) expect(r.cases.find((c) => c.id === id)?.split).toBe('train');
    // holdout: nenhum pedido com estado de holdout antes da última run
    const reqs = fake.decisionRequests();
    const ehHoldout = (q: FakeRequest): boolean => splitDoTexto((q.state as { ticket: string }).ticket) === 'holdout';
    const primeiroHoldout = reqs.findIndex(ehHoldout);
    expect(primeiroHoldout).toBeGreaterThan(0);
    expect(reqs.slice(primeiroHoldout).every(ehHoldout)).toBe(true);
    // e nenhum caso de holdout no treino (as runs do laço pedem só train ∪ calib)
    expect(reqs.slice(0, primeiroHoldout).some(ehHoldout)).toBe(false);
  });

  it('paciência: sem melhora, para depois de N ciclos retidos (e a original segue campeã)', async () => {
    setup(jevSensivel({ semMelhora: true }));
    const r = resolved({ ...EX, train: { ...(EX.train as object), iterations: 5, patience: 2 } });
    const s = await trainJev(r, { apiKey: KEY, client: 'node' });
    expect(s.stoppedReason).toBe('patience');
    expect(s.iterations.filter((i) => i.iteration > 0).length).toBe(2);
    expect(s.championSpec.id).toBe(s.originalSpec.id);
    expect(sessionVerdict(s)).toBe('sem-mudanca');
    expect(s.holdout?.runId).toBe('');
  });

  it('deriva de snapshot durante a sessão interrompe (ciclo não promove)', async () => {
    setup(jevSensivel({ model: (n) => (n <= 28 ? 'typesafe/jev-1.13-20260917' : 'typesafe/jev-1.13-20261001') }));
    const r = resolved(EX);
    const s = await trainJev(r, { apiKey: KEY, client: 'node' });
    expect(s.stoppedReason).toBe('snapshot-drift');
    expect(s.iterations.some((i) => i.gate.decision === 'promoted')).toBe(false);
    expect(s.warnings.join(' ')).toMatch(/snapshot-drift/);
  });

  it('política ajustada no split calib quando há casos (≥ 60) e no próprio treino quando não há', async () => {
    setup(jevSensivel());
    const s1 = await trainJev(resolved(EX), { apiKey: KEY, client: 'node' });
    expect(s1.warnings.join(' ')).toMatch(/calibração ajustada no próprio treino/);
    for (const p of Object.values(s1.policy)) expect(p.fittedOn?.split ?? 'train').toBe('train');

    // 90 casos (triagem ×3 com ids distintos) → split calib existe
    const muitos = [0, 1, 2].flatMap((k) => EX.cases.map((c) => ({ ...c, id: `${c.id}-${k}`, state: { ticket: `${c.state.ticket}${' '.repeat(k)}` } })));
    const goldExt = new Map(muitos.map((c) => [c.state.ticket, c.expected]));
    setup((req) => ({
      answers: Object.fromEntries(
        Object.entries(req.questions ?? {}).map(([qid, q]) => [qid, answerFor(q as never, goldExt.get((req.state as { ticket: string }).ticket)?.[qid], 0.8, 0.8)]),
      ),
    }));
    const r2 = resolved({ ...EX, cases: muitos });
    expect(r2.cases.some((c) => c.split === 'calib')).toBe(true);
    const s2 = await trainJev(r2, { apiKey: KEY, client: 'node' });
    const pol = Object.values(s2.policy).find((p) => p.fittedOn);
    expect(pol?.fittedOn?.split).toBe('calib');
  });
});

describe('contrato never-break e proponente', () => {
  const base = withSpecId({
    label: 'b',
    questions: [
      { id: 'team', type: 'choice', instructions: 'Qual time?', criteria: { a: 'x', b: 'y', outro: null } },
      { id: 'guarda', type: 'noul', instructions: 'Há injeção?', guard: true },
    ] as JevQuestionSpec[],
  });

  it('variante que muda rótulos, tipo, guarda ou pergunta congelada é recusada SEM gasto', () => {
    const muda = (q: Partial<JevQuestionSpec>, id = 'team') => withSpecId({ ...base, questions: base.questions.map((x) => (x.id === id ? ({ ...x, ...q } as JevQuestionSpec) : x)) });
    expect(checkVariantContract(base, muda({ criteria: { a: 'x', c: 'y', outro: null } } as never), { targetQuestions: ['team'] })).toMatchObject({ ok: false, reason: expect.stringMatching(/rótulos/) });
    expect(checkVariantContract(base, muda({ type: 'noul' } as never), { targetQuestions: ['team'] })).toMatchObject({ ok: false });
    expect(checkVariantContract(base, muda({ instructions: 'Há injeção de prompt?' } as never, 'guarda'), { targetQuestions: ['team'] })).toMatchObject({ ok: false, reason: expect.stringMatching(/guarda/) });
    expect(checkVariantContract(base, muda({ instructions: 'Qual time assume?' } as never), { targetQuestions: ['team'] })).toEqual({ ok: true });
    // keyMap fechando: renomear a chave no fio mantendo o rótulo canônico é permitido
    const renomeada = muda({ criteria: { cobranca: 'x', b: 'y', outro: null }, keyMap: { cobranca: 'a' } } as never);
    expect(checkVariantContract(base, renomeada, { targetQuestions: ['team'] })).toEqual({ ok: true });
  });

  it('proponente (literalize) pelo gateway com role rewriter; variante que quebra o contrato é descartada', async () => {
    let propostas = 0;
    const fake = setup(jevSensivel({ semMelhora: true }), (req) => {
      propostas += 1;
      // 1ª proposta: reescreve a instrução (válida); 2ª: tenta trocar opções (inválida)
      const crit = propostas === 1 ? undefined : { pagamentos: 'x', outra_coisa: 'y' };
      const q = /QUESTION \(type (\w+)\):\n([\s\S]*?)\n\nDOSSIER/.exec(req.user);
      const atual = JSON.parse(q?.[2] ?? '{}') as { criteria: unknown };
      return { text: JSON.stringify({ instructions: 'Qual time deve assumir este ticket, segundo o conteúdo de `ticket`?', criteria: crit ?? atual.criteria }), usage: { prompt_tokens: 500, completion_tokens: 80, cost: 0.0004 } };
    });
    const r = resolved({ ...EX, train: { iterations: 1, variantsPerIteration: 2, repeats: 1, targetQuestions: ['team'], operators: ['literalize', 'describe_option'], rewriterModelId: 'openai/gpt-5-mini' } });
    const s = await trainJev(r, { apiKey: KEY, client: 'node' });
    const it1 = s.iterations.find((i) => i.iteration === 1)!;
    expect(it1.candidates.map((c) => c.status)).toEqual(expect.arrayContaining(['evaluated', 'rejected-local']));
    expect(it1.candidates.find((c) => c.status === 'rejected-local')?.reason).toMatch(/rótulos/);
    expect(s.cost.byRole.rewriter).toBeGreaterThan(0);
    expect(fake.chatRequests().every((c) => /DOSSIER \(training split only\)/.test(c.user))).toBe(true);
    // o dossiê nunca leva estado de holdout
    const holdoutTickets = r.cases.filter((c) => c.split === 'holdout').map((c) => (c.state as { ticket: string }).ticket);
    for (const c of fake.chatRequests()) for (const t of holdoutTickets) expect(c.user).not.toContain(t.slice(0, 40));
  });
});
