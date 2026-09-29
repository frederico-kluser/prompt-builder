// IMPL-115 (restante) — modo ECONÔMICO do compare: a cascata juiz barato →
// juiz forte no caminho DEFAULT (pointwise por referência), ligada à run.
//
// A cascata pura (listwise) já existia (test/judge-cascade.test.ts) mas nada a
// chamava: não havia modo econômico no RunConfig, flag no CLI nem caminho no
// orquestrador — e ela só envolvia o listwise. Contratos (transporte falso):
//   (1) pointwise: 2 baratos concordando = 2 chamadas por veredito e ZERO
//       chamada ao forte; discordância/'parcial' levam SÓ aquele veredito ao
//       forte (que decide); anomalia de comprimento escala só os extremos;
//       forte que falha = consenso barato marcado 'degraded';
//   (2) a RUN (Node e SPA) com `judgeCascade` grava a fração escalonada e o
//       histograma em `record.judgeCascade`, e o contrato do juiz inclui os 3;
//   (3) listwise sem gabarito também passa pela cascata na run;
//   (4) `--judge-cascade b1,b2:forte` vira `judgeCascade` (uso errado = exit 2)
//       e o schema recusa baratos repetidos/forte igual a barato;
//   (5) nenhum sinal por token no código da cascata pointwise (critério iii).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { judgeStageReferenceCascade } from '../src/refJudge.js';
import { summarizeJudgeCascade } from '../src/judge.js';
import { parseRunConfig } from '../src/runConfigSchema.js';
import { setDataDir, getDataDir } from '../src/storage.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { cmdRun } from '../src/cli/commands/run.js';
import { EXIT, resetOutputState, toCliError } from '../src/cli/output.js';
import type { CompetitorResponse, Contestant, RunConfig, RunRecord, StageSpec, Verdict } from '../src/types.js';
import { readMarkedBlock } from '../src/engine/judgeGuard.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeChatReply, type FakeRequest } from './fakeOpenRouter.js';
import { listwiseReply, pointwiseReply } from './judgeReplies.js';

vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const CASCATA = { cheap: ['fake/barato1', 'fake/barato2'], strong: 'fake/forte' };
const CATALOGO = ['fake/gen', 'fake/judge', 'fake/a', 'fake/b', ...CASCATA.cheap, CASCATA.strong].map((id) =>
  catalogItem(id, 1e-6, 1e-6),
);

const STAGE: StageSpec = {
  question: 'Qual o prazo para trocar um produto?',
  productContext: 'Trocas em até 30 dias com nota fiscal.',
  maxTokens: 200,
  reference: 'Trinta dias a partir do recebimento, com nota fiscal.',
};

const resp = (id: string, text: string): CompetitorResponse => ({
  contestantId: id,
  modelId: `fake/${id}`,
  text,
  latencyMs: 1,
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
  status: 'ok',
});
const cont = (id: string): Contestant => ({ id, label: id.toUpperCase(), modelId: `fake/${id}` });

/** Texto do candidato no pedido pointwise (bloco marcado). */
const candidato = (req: FakeRequest): string => readMarkedBlock(req.user, 'CANDIDATO') ?? '';

let anterior: OpenRouterGateway | undefined;
function instalar(chat: (req: FakeRequest) => FakeChatReply) {
  const fake = fakeOpenRouter({ catalog: CATALOGO, chat });
  anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
  return fake;
}
afterEach(() => {
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
});

/** Juiz pointwise falso: `votos[modelo](textoDoCandidato)` decide o veredito. */
function juizes(votos: Record<string, (texto: string) => Verdict | 'falha'>) {
  return (req: FakeRequest): FakeChatReply => {
    const decide = votos[req.model];
    if (!decide) return { text: `Resposta de ${req.model}` };
    const v = decide(candidato(req));
    return v === 'falha' ? { status: 500, bodyText: 'x' } : { text: pointwiseReply(req, v) };
  };
}

const chamadasDe = (fake: ReturnType<typeof instalar>, modelo: string) =>
  fake.chatRequests().filter((r) => r.model === modelo).length;

describe('IMPL-115 (1) — cascata pointwise: o forte só nos vereditos em dúvida', () => {
  const base = {
    stage: STAGE,
    contestants: [cont('a'), cont('b')],
    apiKey: KEY,
    cheapJudgeIds: CASCATA.cheap,
    strongJudgeId: CASCATA.strong,
  };

  it('baratos concordam: 2 chamadas por veredito, ZERO ao forte, sem escalar', async () => {
    const fake = instalar(juizes({ 'fake/barato1': () => 'resolve', 'fake/barato2': () => 'resolve', 'fake/forte': () => 'nao' }));
    const r = await judgeStageReferenceCascade({ ...base, responses: [resp('a', 'RESP-A trinta dias'), resp('b', 'RESP-B trinta dias')] });
    expect(chamadasDe(fake, 'fake/barato1')).toBe(2);
    expect(chamadasDe(fake, 'fake/barato2')).toBe(2);
    expect(chamadasDe(fake, 'fake/forte')).toBe(0);
    expect(r.verdictByContestant).toEqual({ a: 'resolve', b: 'resolve' });
    expect(r.cascade).toMatchObject({ escalated: false, reasons: [], verdicts: 2, escalatedContestantIds: [] });
  });

  it('discordância em UM veredito: só ele vai ao forte, que decide', async () => {
    const fake = instalar(
      juizes({
        'fake/barato1': () => 'resolve',
        'fake/barato2': (t) => (t.includes('RESP-A') ? 'nao' : 'resolve'),
        'fake/forte': () => 'nao',
      }),
    );
    const r = await judgeStageReferenceCascade({ ...base, responses: [resp('a', 'RESP-A trinta dias'), resp('b', 'RESP-B trinta dias')] });
    expect(chamadasDe(fake, 'fake/forte')).toBe(1);
    expect(r.verdictByContestant).toEqual({ a: 'nao', b: 'resolve' });
    expect(r.verdictSourceByContestant?.a).toBe('judge');
    expect(r.cascade).toMatchObject({ escalated: true, reasons: ['disagreement'], escalatedContestantIds: ['a'], strongDecided: true });
    // Os 3 votos ficam registrados (auditável: quem decidiu o quê).
    expect(r.judgeVotesByContestant?.a.map((v) => v.judgeModelId)).toEqual([...CASCATA.cheap, CASCATA.strong]);
  });

  it("'parcial' escala; anomalia de comprimento escala só os EXTREMOS", async () => {
    const fake = instalar(
      juizes({
        'fake/barato1': (t) => (t.includes('RESP-B') ? 'parcial' : 'resolve'),
        'fake/barato2': (t) => (t.includes('RESP-B') ? 'parcial' : 'resolve'),
        'fake/forte': () => 'resolve',
      }),
    );
    const r = await judgeStageReferenceCascade({ ...base, responses: [resp('a', 'RESP-A trinta dias'), resp('b', 'RESP-B trinta dias')] });
    expect(r.cascade).toMatchObject({ reasons: ['parcial'], escalatedContestantIds: ['b'] });
    expect(chamadasDe(fake, 'fake/forte')).toBe(1);

    const fake2 = instalar(juizes({ 'fake/barato1': () => 'resolve', 'fake/barato2': () => 'resolve', 'fake/forte': () => 'resolve' }));
    const longa = `RESP-C ${'trinta dias com nota fiscal. '.repeat(20)}`;
    const r2 = await judgeStageReferenceCascade({
      ...base,
      contestants: [cont('a'), cont('b'), cont('c')],
      responses: [resp('a', 'RESP-A trinta dias'), resp('b', 'RESP-B trinta dias ok'), resp('c', longa)],
    });
    expect(r2.cascade?.reasons).toEqual(['length-anomaly']);
    // Extremos: a menor (a) e a maior (c) — b fica com o consenso barato.
    expect(r2.cascade?.escalatedContestantIds?.sort()).toEqual(['a', 'c']);
    expect(chamadasDe(fake2, 'fake/forte')).toBe(2);
  });

  it("forte falha: vale o consenso barato, marcado 'degraded'", async () => {
    instalar(
      juizes({
        'fake/barato1': () => 'parcial',
        'fake/barato2': () => 'parcial',
        'fake/forte': () => 'falha',
      }),
    );
    const r = await judgeStageReferenceCascade({ ...base, responses: [resp('a', 'RESP-A trinta dias')], contestants: [cont('a')] });
    expect(r.verdictByContestant.a).toBe('parcial');
    expect(r.verdictSourceByContestant?.a).toBe('degraded');
    expect(r.cascade).toMatchObject({ escalated: true, strongDecided: false });
  });

  it('resumo da run: fração escalonada POR VEREDITO + histograma', () => {
    const s = summarizeJudgeCascade(CASCATA, [
      { escalated: false, reasons: [], cheapJudgeIds: CASCATA.cheap, strongJudgeId: CASCATA.strong, cheapVerdictByContestant: {}, strongDecided: false, verdicts: 4, escalatedContestantIds: [] },
      { escalated: true, reasons: ['disagreement', 'parcial'], cheapJudgeIds: CASCATA.cheap, strongJudgeId: CASCATA.strong, cheapVerdictByContestant: {}, strongDecided: true, verdicts: 4, escalatedContestantIds: ['a'] },
    ]);
    expect(s).toMatchObject({ stages: 2, escalatedStages: 1, verdicts: 8, escalatedVerdicts: 1, escalatedFraction: 1 / 8 });
    expect(s.reasons).toEqual({ disagreement: 1, parcial: 1, 'length-anomaly': 0 });
  });
});

// ---------------------------------------------------------------------------
// (2)/(3) — na RUN, nos dois motores.
// ---------------------------------------------------------------------------

describe('IMPL-115 (2)/(3) — a run com judgeCascade grava a fração escalonada (Node e SPA)', () => {
  let tmp: string;
  let dirAnterior: string;
  let mudos: Array<{ mockRestore(): void }> = [];
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl115-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    mudos = (['log', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
  });
  afterAll(() => {
    mudos.forEach((m) => m.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  const CENARIOS = [
    { ...STAGE },
    { question: 'Qual o prazo de entrega para Manaus?', productContext: 'Entrega em 10 dias úteis.', maxTokens: 200, reference: 'Dez dias úteis.' },
  ];
  const config = (extra: Record<string, unknown> = {}) =>
    ({
      mode: 'compare',
      theme: 'suporte',
      stages: 2,
      datagenModelId: 'fake/gen',
      judgeModelIds: ['fake/judge'],
      referenceJudging: true,
      competitorModelIds: ['fake/a', 'fake/b'],
      customStages: CENARIOS,
      finalists: 0,
      timeoutMs: 5_000,
      judgeCascade: CASCATA,
      ...extra,
    }) as unknown as RunConfig;

  for (const [motor, run] of [
    ['Node', runNode],
    ['SPA', runWeb],
  ] as const) {
    it(`${motor}: pointwise — 4 vereditos, 1 escalonado; o juiz do painel normal não julga etapa`, async () => {
      const fake = instalar((req) => {
        if (req.model === 'fake/barato1') return { text: pointwiseReply(req, 'resolve') };
        // Discorda SÓ na resposta de fake/a no 1º cenário.
        if (req.model === 'fake/barato2') {
          const t = candidato(req);
          const v: Verdict = t.includes('fake/a') && req.user.includes('trocar') ? 'nao' : 'resolve';
          return { text: pointwiseReply(req, v) };
        }
        if (req.model === 'fake/forte') return { text: pointwiseReply(req, 'parcial') };
        if (req.model === 'fake/judge') return { text: pointwiseReply(req, 'resolve') };
        return { text: `Resposta de ${req.model} — trinta dias` };
      });
      const rec = (await run(config() as never, KEY, { runId: `impl115-${motor}` } as never)) as RunRecord;
      expect(rec.status, rec.error).not.toBe('error');
      expect(rec.judgeCascade).toMatchObject({
        cheapJudgeIds: CASCATA.cheap,
        strongJudgeId: CASCATA.strong,
        stages: 2,
        verdicts: 4,
        escalatedVerdicts: 1,
        escalatedFraction: 0.25,
      });
      expect(rec.judgeCascade!.reasons.disagreement).toBe(1);
      expect(chamadasDe(fake, 'fake/forte')).toBe(1);
      // Revisão w2: o aviso de imparcialidade olha o painel EFETIVO (baratos +
      // forte), não só `judgeModelIds` — o forte "fake/forte" é da família dos
      // competidores "fake/*".
      for (const juiz of [...CASCATA.cheap, CASCATA.strong]) {
        expect(rec.fairnessWarnings?.some((w) => w.includes(`O juiz "${juiz}"`)), juiz).toBe(true);
      }
      // O juiz do painel normal NÃO julgou nenhuma etapa (só a cascata).
      expect(fake.chatRequests().filter((r) => r.model === 'fake/judge' && r.user.includes('CANDIDATO'))).toHaveLength(0);
      // Etapa escalonada: o veredito do forte decide.
      expect(rec.stages[0].referenceJudge?.verdictByContestant['fake/a']).toBe('parcial');
    });

    it(`${motor}: listwise (sem gabarito) também passa pela cascata`, async () => {
      instalar((req) => {
        if (CASCATA.cheap.includes(req.model) || req.model === CASCATA.strong) {
          return {
            text: listwiseReply(req, ['A', 'B'], [
              { label: 'A', justificativa: 'ok', veredito: 'resolve' },
              { label: 'B', justificativa: 'ok', veredito: 'resolve' },
            ]),
          };
        }
        return { text: `Resposta de ${req.model} — trinta dias` };
      });
      const semGabarito = CENARIOS.map(({ reference: _r, ...s }) => s);
      const rec = (await run(
        config({ customStages: semGabarito, referenceJudging: false }) as never,
        KEY,
        { runId: `impl115-lw-${motor}` } as never,
      )) as RunRecord;
      expect(rec.judgeCascade?.stages).toBe(2);
      expect(rec.stages[0].judge?.cascade?.cheapJudgeIds).toEqual(CASCATA.cheap);
    });
  }
});

// ---------------------------------------------------------------------------
// (4) — flag do CLI e schema.
// ---------------------------------------------------------------------------

describe('IMPL-115 (4) — --judge-cascade e o schema', () => {
  it('schema aceita 2 baratos + forte distintos e recusa o resto', () => {
    const base = {
      mode: 'compare',
      theme: 't',
      stages: 1,
      datagenModelId: 'g/x',
      judgeModelIds: ['j/x'],
      competitorModelIds: ['a/x', 'b/x'],
    };
    expect(parseRunConfig({ ...base, judgeCascade: CASCATA }).ok).toBe(true);
    expect(parseRunConfig({ ...base, judgeCascade: { cheap: ['x/1'], strong: 'x/2' } }).ok).toBe(false);
    expect(parseRunConfig({ ...base, judgeCascade: { cheap: ['x/1', 'x/2'], strong: 'x/1' } }).ok).toBe(false);
    // Revisão w2 (IMPL-048 × IMPL-115): referência = juiz da cascata e juiz da
    // cascata = competidor são recusados (antes passavam em silêncio).
    const refBarato = parseRunConfig({ ...base, referenceModelId: CASCATA.cheap[0], judgeCascade: CASCATA });
    expect(refBarato.ok).toBe(false);
    if (!refBarato.ok) expect(refBarato.error).toMatch(/não pode ser também juiz/);
    const forteCompete = parseRunConfig({ ...base, judgeCascade: { ...CASCATA, strong: 'a/x' } });
    expect(forteCompete.ok).toBe(false);
    if (!forteCompete.ok) expect(forteCompete.error).toMatch(/juiz da cascata "a\/x"/);
  });

  async function dryRun(extra: string[]): Promise<{ exit: number; payload?: Record<string, unknown>; errorCode?: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'pb-impl115-cli-'));
    const fake = fakeOpenRouter({ catalog: CATALOGO });
    const prev = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    resetOutputState();
    let saida = '';
    const mudos = [
      vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
        saida += String(c);
        return true;
      }),
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
    ];
    try {
      const exit = await cmdRun('compare', [
        '--theme', 'suporte', '--models', 'fake/a,fake/b', '--judge', 'fake/judge', '--datagen', 'fake/gen',
        '--budget', '1', '--dry-run', '--json', '--key', KEY, '--data-dir', dir, ...extra,
      ]);
      return { exit, payload: JSON.parse(saida.trim().split('\n').pop() ?? '{}') as Record<string, unknown> };
    } catch (e) {
      const err = toCliError(e);
      return { exit: err.code, errorCode: err.errorCode };
    } finally {
      mudos.forEach((m) => m.mockRestore());
      resetOutputState();
      setDefaultGateway(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('`--judge-cascade b1,b2:forte` vira judgeCascade no config; uso errado = exit 2', async () => {
    const ok = await dryRun(['--judge-cascade', `${CASCATA.cheap.join(',')}:${CASCATA.strong}`, '--semantic-dedup']);
    expect(ok.exit, JSON.stringify(ok)).toBe(EXIT.OK);
    const config = (ok.payload?.data as { config?: Record<string, unknown> } | undefined)?.config;
    expect(config?.judgeCascade).toEqual(CASCATA);
    expect(config?.scenarioDedup).toEqual({ semantic: true });
    const ruim = await dryRun(['--judge-cascade', 'so-um:forte']);
    expect(ruim.exit).toBe(EXIT.USAGE);
    expect(ruim.errorCode).toBe('usage.invalid_flag_value');
  });
});

describe('IMPL-115 (5) — critério iii: nenhum sinal por token na cascata pointwise', () => {
  it('src/refJudge.ts não menciona logprobs', () => {
    expect(/logprob/i.test(readFileSync(join(ROOT, 'src', 'refJudge.ts'), 'utf8'))).toBe(false);
  });
});
