// web-live#7 (CRÍTICO) — a geração de cenários chega ao alvo ou diz, alto, por quê.
//
// Reproduzido numa run PAGA real (sessão 346c0f25, tema estreito "triagem de
// pedidos de reembolso", 12 cenários): só 4 chegaram à run. O dedup + o merge
// seed×gerados por ROUGE-L ≥ 0.7 (que rodava DEPOIS da decisão de reposição,
// contra TODOS os aceitos) descartaram 8 em silêncio, as etapas 4-11 saíram
// "Datagen entregou menos cenarios que o alvo" e a sessão inteira terminou
// inconclusiva (n efetivo < 5). Contratos aqui (transporte falso, zero rede):
//   (1) merge só recusa gerado que repete o PAR do SEED — "jejum p/ glicemia" ×
//       "jejum p/ colesterol" (ROUGE-L alto, perguntas legítimas) ficam os dois;
//   (2) a reposição é um LAÇO LIMITADO (≤ 3 rodadas) com exclusão das
//       perguntas já vistas e instrução EXPLÍCITA de diversidade, até o alvo;
//   (3) o seed é ÂNCORA do dedup ANTES da decisão de reposição (gerado que o
//       repete sai e é reposto), nunca descartado;
//   (4) sem folga no orçamento a reposição para (sem lançar) e o relatório diz;
//   (5) com embedder, tema estreito relaxa o cosseno até o piso de n;
//   (6) o relatório completo (pedido/gerado/descartes/rodadas/final/limiares +
//       aviso) sai por `onReport` e, na run, vai para o record + evento
//       `datagen.report` ANTES dos competidores — nos DOIS motores.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import {
  DATAGEN_MAX_BACKFILL_ROUNDS,
  describeDatagenShortfall,
  generateStages,
  rubricAnswerability,
  type DatagenReport,
} from '../src/datagen.js';
import { mergeScenarios, mergeScenariosReport } from '../src/scenarioPack.js';
import { dedupeSemantic } from '../src/dedup.js';
import { setDataDir, getDataDir } from '../src/storage.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { subscribe as subscribeRun } from '../src/events.js';
import { subscribeRun as subscribeRunWeb } from '../web/src/engine/events.js';
import type { RunConfig, RunEvent, StageSpec } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter, type FakeRequest } from './fakeOpenRouter.js';
import { duelReply, pointwiseReply } from './judgeReplies.js';

vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

/** Cenário distinto por i (pergunta + contexto). */
function cenario(i: number): Record<string, unknown> {
  return {
    question: `Pedido de reembolso número ${i}: o cliente ${['Ana', 'Bia', 'Caio', 'Duda', 'Edu', 'Fabi', 'Gil', 'Hugo', 'Iara', 'Joel', 'Kai', 'Lia'][i % 12]} pagou R$ ${i * 10},00 — o que fazer?`,
    productContext: `Política ${i}: reembolso em até ${i + 5} dias úteis.`,
    maxTokens: 300,
    rubric: `Deve citar ${i + 5} dias úteis.`,
  };
}

/** Fake do gerador: a n-ésima chamada de chat devolve `porChamada(n, req)`. */
function fakeGerador(porChamada: (n: number, req: FakeRequest) => Record<string, unknown>[]): FakeOpenRouter {
  return fakeOpenRouter({
    catalog: [catalogItem('fake/gen', 0.000001, 0.000002)],
    chat: (req, n) => ({ text: JSON.stringify({ stages: porChamada(n, req) }) }),
  });
}

let anterior: OpenRouterGateway | undefined;
let warn: ReturnType<typeof vi.spyOn>;
function instalar(f: FakeOpenRouter): void {
  anterior = setDefaultGateway(createGateway({ fetch: f.fetch, sleep: noSleep }));
}

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
});

describe('web-live#7 (1) — merge seed × gerados não descarta mais por ROUGE-L', () => {
  const spec = (question: string, productContext = 'ctx'): StageSpec => ({ question, productContext, maxTokens: 200 });

  it('perguntas legítimas do mesmo tema (ROUGE-L alto) ficam as duas — era o bug', () => {
    const glicemia = spec('Quanto tempo de jejum eu preciso para o exame de glicemia?');
    const colesterol = spec('Quanto tempo de jejum eu preciso para o exame de colesterol?');
    expect(mergeScenarios([], [glicemia, colesterol])).toHaveLength(2);
  });

  it('só o PAR exato do seed é recusado (e contado); o seed nunca sai', () => {
    const seed = [spec('Como peço reembolso?', 'Política A')];
    const r = mergeScenariosReport(seed, [
      spec('Como peço reembolso?', 'Política A'), // repete o seed
      spec('Como peço reembolso?', 'Política B'), // outro contexto = outra resposta
      spec('Qual o prazo do reembolso?', 'Política A'),
    ]);
    expect(r.droppedVsSeed).toBe(1);
    expect(r.specs.map((s) => s.origin)).toEqual(['import', 'ai', 'ai']);
  });
});

describe('web-live#7 (2) — reposição em laço limitado até o alvo', () => {
  it('gerador repetitivo: rodadas de reposição com exclusão + instrução de diversidade até 6/6', async () => {
    // Lotes iniciais (2 × 3) devolvem o MESMO par de cenários; a 1ª reposição
    // repete de novo; só a 2ª traz variedade — antes havia UMA reposição e a
    // run seguia com 2 de 6 cenários.
    const fake = fakeGerador((n) => {
      if (n < 3) return [cenario(1), cenario(2)];
      return [cenario(3), cenario(4), cenario(5), cenario(6), cenario(7), cenario(8)];
    });
    instalar(fake);
    const relatorios: DatagenReport[] = [];
    const out = await generateStages({
      apiKey: KEY,
      theme: 'triagem de pedidos de reembolso',
      count: 6,
      modelId: 'fake/gen',
      onReport: (r) => relatorios.push(r),
    });
    expect(out).toHaveLength(6);
    const chats = fake.chatRequests();
    // 2 lotes + 2 rodadas de reposição.
    expect(chats).toHaveLength(4);
    for (const r of chats.slice(2)) {
      expect(r.user).toMatch(/REPOSICAO DE DIVERSIDADE/);
      expect(r.user).toMatch(/persona/);
      // As perguntas já vistas vão na exclusão.
      expect(r.user).toContain(String(cenario(1).question));
    }
    const r = relatorios[0];
    expect(relatorios).toHaveLength(1);
    expect(r).toMatchObject({
      requested: 6,
      batches: 2,
      backfillRounds: 2,
      maxBackfillRounds: DATAGEN_MAX_BACKFILL_ROUNDS,
      final: 6,
      shortfall: 0,
      stoppedBy: 'target',
      semantic: false,
    });
    expect(r.generated).toBe(2 + 2 + 2 + 6);
    expect(r.dedupedExact).toBe(r.generated - 8); // 8 distintos no total
    expect(r.warning).toBeUndefined();
  });

  it('gerador que só repete: para no teto de rodadas, relata a falta e avisa', async () => {
    const fake = fakeGerador(() => [cenario(1), cenario(2)]);
    instalar(fake);
    let rel: DatagenReport | undefined;
    const out = await generateStages({
      apiKey: KEY,
      theme: 'reembolso',
      count: 6,
      modelId: 'fake/gen',
      onReport: (r) => (rel = r),
    });
    expect(out).toHaveLength(2);
    expect(fake.chatRequests()).toHaveLength(2 + DATAGEN_MAX_BACKFILL_ROUNDS);
    expect(rel).toMatchObject({ final: 2, shortfall: 4, stoppedBy: 'rounds', backfillRounds: 3 });
    expect(rel!.warning).toMatch(/Datagen entregou 2 de 6 cenários/);
    expect(rel!.warning).toMatch(/3\/3 rodada\(s\) de reposição/);
    expect(rel!.warning).toMatch(/inconclusiva/);
  });

  it('sem `onReport` (library seed) a falta vai para o stderr', async () => {
    instalar(fakeGerador(() => [cenario(1)]));
    await generateStages({ apiKey: KEY, theme: 't', count: 3, modelId: 'fake/gen', maxBackfillRounds: 1 });
    const linhas = warn.mock.calls.map((c) => String(c[0]));
    expect(linhas.some((l) => l.includes('Datagen entregou 1 de 3 cenários'))).toBe(true);
  });
});

describe('web-live#7 (3) — o seed é âncora do dedup antes da reposição', () => {
  it('gerado que repete o seed sai, conta em droppedVsSeed e é REPOSTO', async () => {
    const seedSpec = cenario(1) as unknown as StageSpec;
    const fake = fakeGerador((n) => (n === 0 ? [cenario(1), cenario(2)] : [cenario(3), cenario(4)]));
    instalar(fake);
    let rel: DatagenReport | undefined;
    const out = await generateStages({
      apiKey: KEY,
      theme: 'reembolso',
      count: 2,
      modelId: 'fake/gen',
      seed: [seedSpec],
      onReport: (r) => (rel = r),
    });
    expect(out.map((s) => s.question)).not.toContain(seedSpec.question);
    expect(out).toHaveLength(2);
    expect(rel).toMatchObject({ seed: 1, droppedVsSeed: 1, backfillRounds: 1, shortfall: 0 });
    // A pergunta do seed entrou na exclusão do lote inicial.
    expect(fake.chatRequests()[0].user).toContain(seedSpec.question);
  });
});

describe('web-live#7 (4) — porta suave de orçamento na reposição', () => {
  it('canAffordBatch=false: nenhuma rodada, relatório com stoppedBy budget', async () => {
    const fake = fakeGerador(() => [cenario(1)]);
    instalar(fake);
    let rel: DatagenReport | undefined;
    await generateStages({
      apiKey: KEY,
      theme: 't',
      count: 4,
      modelId: 'fake/gen',
      canAffordBatch: () => false,
      onReport: (r) => (rel = r),
    });
    expect(fake.chatRequests()).toHaveLength(1);
    expect(rel).toMatchObject({ backfillRounds: 0, stoppedBy: 'budget', shortfall: 3 });
    expect(rel!.warning).toMatch(/reposição parada pelo orçamento/);
  });
});

describe('web-live#7 (5) — limiar semântico adaptativo em tema estreito', () => {
  it('com embedder que junta tudo, relaxa o cosseno até manter o piso (min(pedido, 5))', async () => {
    // Vetores QUASE iguais (cosseno > 0.9): no limiar default tudo vira um
    // cluster só. Sem entidade saliente que vete (mesmo template, sem
    // números/nomes) — o caso do tema estreito.
    const semEntidade = (i: number) => ({
      question: `como faço o pedido de reembolso numero ${'abcdefgh'[i]} do produto`,
      productContext: `politica ${'abcdefgh'[i]}`,
      maxTokens: 200,
    });
    const fake = fakeGerador(() => [0, 1, 2, 3, 4].map(semEntidade));
    instalar(fake);
    let rel: DatagenReport | undefined;
    const out = await generateStages({
      apiKey: KEY,
      theme: 'reembolso',
      count: 5,
      modelId: 'fake/gen',
      dedup: {
        embed: async (texts) =>
          texts.map((t) => {
            const k = 'abcdefgh'.indexOf(/numero ([a-h])/.exec(t)?.[1] ?? 'a');
            return [1, 0.2 * Math.sin(k), 0.2 * Math.cos(k)];
          }),
      },
      maxBackfillRounds: 0,
      onReport: (r) => (rel = r),
    });
    expect(rel!.semantic).toBe(true);
    expect(rel!.effectiveCosineThreshold).toBeGreaterThan(rel!.cosineThreshold);
    expect(out.length).toBeGreaterThan(1);
  });

  // Revisão w2: com limiar configurado ≥ o último degrau nenhum relaxamento se
  // aplica — o stderr dizia "relaxado de 0.99 para 0.99" mesmo assim.
  it('limiar já no teto (0.99): nenhum degrau se aplica e NADA é narrado como relaxado', async () => {
    const semEntidade = (i: number) => ({
      question: `como faço o pedido de reembolso numero ${'abcdefgh'[i]} do produto`,
      productContext: `politica ${'abcdefgh'[i]}`,
      maxTokens: 200,
    });
    const fake = fakeGerador(() => [0, 1, 2, 3, 4].map(semEntidade));
    instalar(fake);
    let rel: DatagenReport | undefined;
    await generateStages({
      apiKey: KEY,
      theme: 'reembolso',
      count: 5,
      modelId: 'fake/gen',
      dedup: { embed: async (texts) => texts.map(() => [1, 0, 0]), cosineThreshold: 0.99 },
      maxBackfillRounds: 0,
      onReport: (r) => (rel = r),
    });
    expect(rel!.dedupedSemantic).toBeGreaterThan(0);
    expect(rel!.effectiveCosineThreshold).toBe(0.99);
    const narrado = warn.mock.calls.map((c) => String(c[0]));
    expect(narrado.some((m) => m.includes('tema estreito'))).toBe(false);
  });

  it('âncoras no dedup semântico: item colado no seed sai; seed nunca conta', async () => {
    const vetor = async (texts: string[]) => texts.map(() => [1, 0, 0]);
    const res = await dedupeSemantic([{ question: 'pergunta nova sobre prazo' }], {
      embed: vetor,
      anchors: [{ question: 'pergunta antiga sobre prazo' }],
    });
    expect(res.kept).toHaveLength(0);
    expect(res.report).toMatchObject({ total: 1, dropped: 1, semanticDropped: 1, anchorDropped: 1 });
  });
});

describe('IMPL-059 — checagem de respondibilidade da rubrica (mesmo bloco do caso)', () => {
  it('rubrica que exige fato ausente do caso é sinalizada; presente, não', () => {
    expect(
      rubricAnswerability({ question: 'Qual o prazo?', productContext: 'Trocas em 30 dias.', rubric: 'Deve citar 30 dias.' }),
    ).toEqual({ answerable: true, missing: [] });
    const r = rubricAnswerability({
      question: 'Qual o prazo?',
      productContext: 'Trocas em 30 dias.',
      rubric: 'Deve citar 45 dias e o protocolo PX-900.',
    });
    expect(r.answerable).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(['45', 'px-900']));
    // Rubrica sem entidade saliente é respondível por definição.
    expect(rubricAnswerability({ question: 'q', productContext: '', rubric: 'deve recusar com cordialidade' }).answerable).toBe(true);
  });

  it('a geração conta as rubricas não-respondíveis no relatório (sinal, nunca descarte)', async () => {
    instalar(
      fakeGerador(() => [
        { question: 'Qual o prazo de troca?', productContext: 'Trocas em 30 dias.', maxTokens: 200, rubric: 'Deve citar 90 dias.' },
      ]),
    );
    let rel: DatagenReport | undefined;
    const out = await generateStages({ apiKey: KEY, theme: 't', count: 1, modelId: 'fake/gen', onReport: (r) => (rel = r) });
    expect(out).toHaveLength(1);
    expect(rel!.rubricUnanswerable).toBe(1);
    expect(rel!.rubricIssues?.[0].missing).toEqual(['90']);
  });
});

describe('describeDatagenShortfall', () => {
  it('diz quantos vieram, por quê e o piso de inconclusão', () => {
    const msg = describeDatagenShortfall(
      {
        requested: 12,
        seed: 0,
        batches: 3,
        failedCalls: 0,
        generated: 30,
        backfillRounds: 3,
        maxBackfillRounds: 3,
        backfilled: 18,
        dedupedExact: 20,
        dedupedSemantic: 6,
        droppedVsSeed: 0,
        templateEcho: 4,
        final: 4,
        shortfall: 8,
        rate: 26 / 30,
        alert: true,
        semantic: true,
        cosineThreshold: 0.9,
        effectiveCosineThreshold: 0.99,
        echoThreshold: 0.85,
        stoppedBy: 'rounds',
        rubricUnanswerable: 0,
      },
      12,
    );
    expect(msg).toMatch(/^Datagen entregou 4 de 12 cenários/);
    expect(msg).toMatch(/26 quase-duplicata\(s\) descartada\(s\) \(20 exata\(s\), 6 semântica\(s\)\)/);
    expect(msg).toMatch(/inconclusiva/);
  });
});

// ---------------------------------------------------------------------------
// Ponta a ponta nos DOIS motores: record + evento ANTES dos competidores.
// ---------------------------------------------------------------------------

function fakeDaRun(geracoes: (n: number) => Record<string, unknown>[]): FakeOpenRouter {
  let nGen = 0;
  return fakeOpenRouter({
    catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b'].map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: (req) => {
      if (req.model === 'fake/gen') return { text: JSON.stringify({ stages: geracoes(nGen++) }) };
      if (req.model === 'fake/ref') return { text: `Gabarito: ${req.user.slice(0, 40)}` };
      if (req.stream) return { text: `Resposta de ${req.model}` };
      if (req.system.includes('DUELO')) return { text: duelReply(req, 'A', 'A melhor') };
      return { text: pointwiseReply(req, 'resolve') };
    },
  });
}

const CONFIG = {
  mode: 'compare',
  theme: 'triagem de pedidos de reembolso',
  stages: 6,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  finalists: 0,
  duels: false,
  timeoutMs: 5_000,
} as const;

describe('web-live#7 (6) — a run grava o relatório e emite `datagen.report` antes dos competidores', () => {
  let dirAnterior: string;
  let tmp: string;
  let silencio: Array<{ mockRestore(): void }> = [];
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-weblive7-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
  });
  afterAll(() => {
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  const motores = [
    ['Node', runNode, subscribeRun],
    ['SPA', runWeb, subscribeRunWeb],
  ] as const;

  for (const [nome, run, subscribe] of motores) {
    it(`${nome}: gerador repetitivo chega a 6/6 pela reposição; relatório no record + evento antes do 1º competidor`, async () => {
      // Lotes iniciais repetem 2 cenários; a reposição traz os que faltam.
      const fake = fakeDaRun((n) => (n < 2 ? [cenario(1), cenario(2)] : [3, 4, 5, 6, 7].map(cenario)));
      instalar(fake);
      const rec = await run(CONFIG as unknown as RunConfig as never, KEY, { runId: `weblive7-${nome}-ok` } as never);
      expect(rec.status, rec.error).not.toBe('error');
      const report = (rec as { datagenReport?: DatagenReport }).datagenReport;
      expect(report).toMatchObject({ requested: 6, final: 6, shortfall: 0, stoppedBy: 'target' });
      expect(report!.backfillRounds).toBeGreaterThanOrEqual(1);
      expect(rec.stages.every((s) => s.spec && !s.error)).toBe(true);
    });

    it(`${nome}: faltou cenário → aviso no record, no evento e na etapa descartada`, async () => {
      const fake = fakeDaRun(() => [cenario(1), cenario(2), cenario(3)]);
      instalar(fake);
      const eventos: RunEvent[] = [];
      const runId = `weblive7-${nome}-falta`;
      const unsub = (subscribe as (id: string, fn: (e: RunEvent) => void) => () => void)(runId, (e) => eventos.push(e));
      let rec;
      try {
        rec = await run(CONFIG as unknown as RunConfig as never, KEY, { runId } as never);
      } finally {
        unsub();
      }
      const report = (rec as { datagenReport?: DatagenReport }).datagenReport!;
      expect(report).toMatchObject({ requested: 6, final: 3, shortfall: 3, stoppedBy: 'rounds' });
      expect(report.warning).toMatch(/Datagen entregou 3 de 6 cenários/);
      // Evento emitido UMA vez e ANTES de qualquer resposta de competidor.
      const iReport = eventos.findIndex((e) => e.type === 'datagen.report');
      const iCompetidor = eventos.findIndex((e) => e.type === 'competitor.finished');
      expect(iReport).toBeGreaterThanOrEqual(0);
      expect(eventos.filter((e) => e.type === 'datagen.report')).toHaveLength(1);
      expect(iCompetidor === -1 || iReport < iCompetidor).toBe(true);
      // A etapa descartada diz quantos vieram e por quê.
      const descartadas = rec!.stages.filter((s) => s.error);
      expect(descartadas).toHaveLength(3);
      expect(descartadas[0].error).toMatch(/Datagen entregou 3 de 6 cenários/);
    });
  }
});
