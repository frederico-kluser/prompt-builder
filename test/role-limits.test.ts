// IMPL-016 (R-07b:REC-1) — tetos de max_tokens POR PAPEL com sala para o raciocínio.
//
// Tokens de raciocínio contam contra `max_tokens` na maioria dos provedores:
// com os tetos antigos (gabarito 1500, juiz 1024, duelo 512, juiz listwise sem
// teto, competidor = stage.maxTokens) um modelo que pensa gastava o teto inteiro
// e devolvia `content` vazio com `finish_reason: length` — 'nao'/empate
// automático. Este arquivo prova, contra o FIO (corpo que chega ao fake):
//   (i)   nenhum papel de juízo envia teto abaixo do piso (juiz ≥4096, duelo
//         ≥2048, gabarito ≥3072) — pisos LITERAIS aqui, não importados, para
//         que baixar a constante E o piso juntos também reprove;
//   (ii)  `reasoning.effort` e `reasoning.max_tokens` nunca coexistem no corpo
//         de nenhum papel (o teto é o `max_tokens` do TOPO);
//   (iii) fixture de smoke: 10 cenários × 1 modelo `mandatory` (raciocínio que
//         não desliga) com taxa de `finish_reason: length` = 0 em competidor,
//         gabarito, juiz e duelo — e a MESMA fixture com os tetos antigos trunca.
// Nenhuma chamada paga: tudo passa pelo `fakeOpenRouter`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { runCompetitor } from '../src/competitor.js';
import { generateReferences } from '../src/gabarito.js';
import { judgeStageReference } from '../src/refJudge.js';
import { judgeStage } from '../src/judge.js';
import { runStageDuels } from '../src/duels.js';
import { runStageDuels as runStageDuelsWeb } from '../web/src/engine/duels.js';
import { judgeDossier } from '../src/agent/agentJudge.js';
import { BudgetLedger } from '../src/budget.js';
import { truncationStatsByRole } from '../src/engine/truncation.js';
import {
  COMPETITOR_REASONING_HEADROOM,
  competitorMaxTokens,
  competitorReasoningHeadroom,
  ROLE_MAX_TOKENS,
  ROLE_MAX_TOKENS_FLOOR,
  roleMaxTokensViolations,
} from '../src/roleLimits.js';
import * as roleLimitsWeb from '../web/src/engine/roleLimits.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeChatReply, type FakeRequest } from './fakeOpenRouter.js';
import type { CompetitorResponse, Contestant, CostRole, ReasoningLevel, StageSpec } from '../src/types.js';

const KEY = 'sk-or-test';

/** Pisos da pesquisa (R-07b:REC-1), LITERAIS de propósito. */
const PISO = { judge: 4096, duel: 2048, gabarito: 3072 } as const;
/** Os tetos que existiam antes do IMPL-016 — a config que TEM de reprovar. */
const TETOS_ANTIGOS = { judge: 1024, duel: 512, gabarito: 1500 } as const;

const STAGE: StageSpec = {
  question: 'Qual o prazo de troca?',
  productContext: 'Trocas em até 30 dias com nota fiscal.',
  maxTokens: 300,
  reference: 'O prazo de troca é de 30 dias, com nota fiscal.',
};

const CONTESTANTS: Contestant[] = [
  { id: 'v0', label: 'Original (controle)', modelId: 'fake/m', isOriginal: true },
  { id: 'v1', label: 'Variante', modelId: 'fake/m' },
];

function resposta(contestantId: string, text: string): CompetitorResponse {
  return { contestantId, modelId: 'fake/m', text, latencyMs: 1, tokensIn: 1, tokensOut: 1, costUsd: 0, status: 'ok' };
}
const RESPOSTAS = [resposta('v0', 'Você tem 30 dias para trocar.'), resposta('v1', 'Trocas em 30 dias, com nota.')];

/** Resposta plausível por papel — o conteúdo não importa para o teto, só o corpo enviado. */
function replyPorPapel(req: FakeRequest): FakeChatReply {
  if (req.stream) return { text: 'Você tem 30 dias.', finishReason: 'stop' };
  if (!req.body?.response_format) return { text: 'Gabarito: 30 dias com nota fiscal.', finishReason: 'stop' };
  if (/duelo/i.test(req.system)) return { text: '{"winner":"A","explanation":"A mais completa"}', finishReason: 'stop' };
  return { text: '{"verdict":"resolve","explanation":"confere com a referência"}', finishReason: 'stop' };
}

/** Roda cada papel UMA vez contra o fake e devolve os pedidos de chat por papel. */
async function pedidosPorPapel(
  reasoningLevel?: ReasoningLevel,
): Promise<Record<'competitor' | 'gabarito' | 'refJudge' | 'listwise' | 'duel' | 'duelWeb' | 'agentJudge', FakeRequest[]>> {
  const fake = fakeOpenRouter({ chat: (req) => replyPorPapel(req) });
  const anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
  const desde = (): (() => FakeRequest[]) => {
    const n = fake.chatRequests().length;
    return () => fake.chatRequests().slice(n);
  };
  try {
    let fim = desde();
    await runCompetitor({ apiKey: KEY, contestantId: 'v0', modelId: 'fake/m', stage: STAGE, reasoningLevel });
    const competitor = fim();

    fim = desde();
    await generateReferences({ stages: [{ ...STAGE, reference: undefined }], apiKey: KEY, modelId: 'fake/ref', reasoningLevel });
    const gabarito = fim();

    fim = desde();
    await judgeStageReference({
      stage: STAGE,
      responses: RESPOSTAS,
      contestants: CONTESTANTS,
      judgeModelIds: ['fake/judge'],
      apiKey: KEY,
      reasoningLevel,
    });
    const refJudge = fim();

    fim = desde();
    await judgeStage({ apiKey: KEY, stage: STAGE, responses: RESPOSTAS, judgeModelIds: ['fake/judge'], reasoningLevel });
    const listwise = fim();

    const duelOpts = {
      stage: STAGE,
      responses: RESPOSTAS,
      contestants: CONTESTANTS,
      judgeModelId: 'fake/judge',
      topK: 0,
      duelists: ['v0', 'v1'],
      apiKey: KEY,
      reasoningLevel,
    };
    fim = desde();
    await runStageDuels(duelOpts);
    const duel = fim();

    fim = desde();
    await runStageDuelsWeb(duelOpts);
    const duelWeb = fim();

    fim = desde();
    await judgeDossier({
      stage: STAGE,
      dossierText: '# Dossiê\nO agente respondeu: 30 dias.',
      contestantId: 'v0',
      judgeModelIds: ['fake/judge'],
      apiKey: KEY,
      reasoningLevel,
    });
    const agentJudge = fim();

    return { competitor, gabarito, refJudge, listwise, duel, duelWeb, agentJudge };
  } finally {
    setDefaultGateway(anterior);
  }
}

describe('IMPL-016 (i) — pisos de max_tokens por papel', () => {
  it('os tetos de juízo ficam no piso da pesquisa ou acima (números literais)', () => {
    expect(ROLE_MAX_TOKENS_FLOOR).toEqual(PISO);
    for (const role of ['judge', 'duel', 'gabarito'] as const) {
      expect(ROLE_MAX_TOKENS[role], role).toBeGreaterThanOrEqual(PISO[role]);
    }
    expect(roleMaxTokensViolations(ROLE_MAX_TOKENS, PISO)).toEqual([]);
    expect(roleMaxTokensViolations(ROLE_MAX_TOKENS)).toEqual([]);
  });

  it('reprova QUALQUER config de papel abaixo do piso — inclusive os tetos antigos', () => {
    expect(roleMaxTokensViolations(TETOS_ANTIGOS, PISO)).toEqual([
      'judge: teto 1024 abaixo do piso 4096',
      'duel: teto 512 abaixo do piso 2048',
      'gabarito: teto 1500 abaixo do piso 3072',
    ]);
    expect(roleMaxTokensViolations({ ...ROLE_MAX_TOKENS, judge: PISO.judge - 1 }, PISO)).toHaveLength(1);
    expect(roleMaxTokensViolations({ ...ROLE_MAX_TOKENS, duel: PISO.duel - 1 }, PISO)).toHaveLength(1);
    expect(roleMaxTokensViolations({ ...ROLE_MAX_TOKENS, gabarito: PISO.gabarito - 1 }, PISO)).toHaveLength(1);
    // Sem teto também é violação (o listwise ia sem `max_tokens` nenhum).
    expect(roleMaxTokensViolations({ duel: 4096, gabarito: 4096 }, PISO)).toEqual(['judge: teto ausente (piso 4096)']);
    expect(roleMaxTokensViolations({ judge: Number.NaN, duel: 4096, gabarito: 4096 }, PISO)).toHaveLength(1);
  });

  it('competidor = resposta + folga de raciocínio por degrau (nunca só a resposta)', () => {
    for (const level of [undefined, 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const teto = competitorMaxTokens(STAGE.maxTokens, level);
      expect(teto - STAGE.maxTokens, String(level)).toBe(competitorReasoningHeadroom(level));
      // Mesmo `off` tem folga: num modelo mandatory o `off` não é enviado e ele pensa igual.
      expect(teto - STAGE.maxTokens, String(level)).toBeGreaterThanOrEqual(1024);
    }
    // A escada é monotônica: degrau mais alto nunca tem menos sala.
    const escada = (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map(
      (l) => COMPETITOR_REASONING_HEADROOM[l],
    );
    expect([...escada].sort((a, b) => a - b)).toEqual(escada);
    // Degrau ausente = padrão do modelo (medium); resposta inválida não zera a folga.
    expect(competitorReasoningHeadroom(undefined)).toBe(COMPETITOR_REASONING_HEADROOM.medium);
    expect(competitorMaxTokens(Number.NaN)).toBe(competitorReasoningHeadroom());
  });

  it('o web lê os MESMOS tetos (shim, fonte única)', () => {
    expect(roleLimitsWeb.ROLE_MAX_TOKENS).toBe(ROLE_MAX_TOKENS);
    expect(roleLimitsWeb.competitorMaxTokens).toBe(competitorMaxTokens);
  });
});

describe('IMPL-016 (i)+(ii) — o que cada papel ENVIA no fio', () => {
  let silencio: Array<{ mockRestore(): void }> = [];
  beforeEach(() => {
    silencio = (['log', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
  });
  afterEach(() => silencio.forEach((s) => s.mockRestore()));

  it('juízes (pointwise, listwise, dossiê), duelo (Node e SPA) e gabarito ≥ piso; competidor com folga', async () => {
    const p = await pedidosPorPapel();
    const tetos = (reqs: FakeRequest[]): unknown[] => reqs.map((r) => r.body?.max_tokens);

    expect(p.gabarito).toHaveLength(1);
    expect(p.refJudge).toHaveLength(2);
    expect(p.listwise.length).toBeGreaterThanOrEqual(1);
    expect(p.duel).toHaveLength(2);
    expect(p.duelWeb).toHaveLength(2);
    expect(p.agentJudge).toHaveLength(1);

    for (const [nome, reqs, piso] of [
      ['gabarito', p.gabarito, PISO.gabarito],
      ['juiz pointwise', p.refJudge, PISO.judge],
      ['juiz listwise', p.listwise, PISO.judge],
      ['juiz do dossiê (agente)', p.agentJudge, PISO.judge],
      ['duelo (Node)', p.duel, PISO.duel],
      ['duelo (SPA)', p.duelWeb, PISO.duel],
    ] as const) {
      for (const teto of tetos(reqs)) {
        expect(typeof teto, `${nome}: max_tokens presente no corpo`).toBe('number');
        expect(teto as number, nome).toBeGreaterThanOrEqual(piso);
      }
    }
    // Node e SPA enviam o MESMO teto de duelo (mirror em par).
    expect(tetos(p.duelWeb)).toEqual(tetos(p.duel));

    // Competidor: resposta da etapa + folga do degrau padrão — nunca só `stage.maxTokens`.
    expect(tetos(p.competitor)).toEqual([competitorMaxTokens(STAGE.maxTokens)]);
    expect(p.competitor[0].body?.max_tokens as number).toBeGreaterThan(STAGE.maxTokens);
  });

  it('competidor: folga segue o degrau pedido e `maxOutputTokens` limita só a RESPOSTA', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: 'ok', finishReason: 'stop' }) });
    const anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    try {
      for (const level of ['off', 'low', 'high', 'max'] as const) {
        await runCompetitor({ apiKey: KEY, contestantId: 'c', modelId: 'fake/m', stage: STAGE, reasoningLevel: level });
      }
      await runCompetitor({ apiKey: KEY, contestantId: 'c', modelId: 'fake/m', stage: STAGE, maxOutputTokens: 120 });
      expect(fake.chatRequests().map((r) => r.body?.max_tokens)).toEqual([
        300 + COMPETITOR_REASONING_HEADROOM.off,
        300 + COMPETITOR_REASONING_HEADROOM.low,
        300 + COMPETITOR_REASONING_HEADROOM.high,
        300 + COMPETITOR_REASONING_HEADROOM.max,
        120 + competitorReasoningHeadroom(undefined),
      ]);
    } finally {
      setDefaultGateway(anterior);
    }
  });

  it('(ii) com esforço pedido, NENHUM papel manda reasoning.effort junto de reasoning.max_tokens', async () => {
    const p = await pedidosPorPapel('high');
    const todos = Object.values(p).flat();
    expect(todos.length).toBeGreaterThanOrEqual(10);
    for (const req of todos) {
      const reasoning = req.body?.reasoning as Record<string, unknown> | undefined;
      expect(reasoning, 'esforço vai como reasoning: { effort }').toEqual({ effort: 'high' });
      expect(reasoning && 'max_tokens' in reasoning).toBe(false);
      // O teto de raciocínio+resposta é o `max_tokens` do TOPO.
      expect(typeof req.body?.max_tokens).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// (iii) Fixture de smoke — 10 cenários × 1 modelo mandatory
// ---------------------------------------------------------------------------

const MANDATORY = 'fake/mandatory';
/**
 * Raciocínio que o modelo simulado gasta ANTES de responder no esforço padrão
 * (nada enviado => `default_effort: medium`). Como nos provedores reais, conta
 * contra `max_tokens`: se não sobra sala para a resposta, sai `length` com
 * `content` vazio e `completion_tokens` todos de raciocínio (o modo de falha
 * medido em glm-5.2).
 */
const RACIOCINIO_PADRAO = 1800;

/** ~4 chars/token: o tamanho da resposta visível no simulador. */
const tokensDe = (texto: string): number => Math.ceil(texto.length / 4);

function simuladorMandatory(): ReturnType<typeof fakeOpenRouter> {
  return fakeOpenRouter({
    catalog: [
      catalogItem(MANDATORY, 1e-9, 1e-9, {
        supported_parameters: ['max_tokens', 'reasoning', 'include_reasoning', 'response_format'],
        reasoning: { mandatory: true, supported_efforts: ['high', 'medium', 'low'], default_effort: 'medium' },
      }),
    ],
    chat: (req) => {
      const texto = replyPorPapel(req).text ?? '';
      const teto = typeof req.body?.max_tokens === 'number' ? (req.body.max_tokens as number) : Number.POSITIVE_INFINITY;
      const precisa = RACIOCINIO_PADRAO + tokensDe(texto);
      if (precisa > teto) {
        return {
          text: '',
          finishReason: 'length',
          nativeFinishReason: 'max_tokens',
          usage: {
            prompt_tokens: 80,
            completion_tokens: teto,
            cost: 1e-6,
            completion_tokens_details: { reasoning_tokens: Math.min(RACIOCINIO_PADRAO, teto) },
          },
        };
      }
      return {
        text: texto,
        finishReason: 'stop',
        nativeFinishReason: 'end_turn',
        usage: {
          prompt_tokens: 80,
          completion_tokens: precisa,
          cost: 1e-6,
          completion_tokens_details: { reasoning_tokens: RACIOCINIO_PADRAO },
        },
      };
    },
  });
}

const CENARIOS: StageSpec[] = Array.from({ length: 10 }, (_, i) => ({
  question: `Cenário ${i + 1}: qual o prazo de troca do item ${i + 1}?`,
  productContext: 'Trocas em até 30 dias com nota fiscal.',
  maxTokens: 300,
}));

const CONTESTANTS_MANDATORY: Contestant[] = [
  { id: 'v0', label: 'Original (controle)', modelId: MANDATORY, isOriginal: true },
  { id: 'v1', label: 'Variante', modelId: MANDATORY },
];

describe('IMPL-016 (iii) — smoke 10 cenários × 1 modelo mandatory: finish_reason length = 0', () => {
  let anterior: OpenRouterGateway | undefined;
  let silencio: Array<{ mockRestore(): void }> = [];
  beforeEach(() => {
    silencio = (['log', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
  });
  afterEach(() => {
    if (anterior) setDefaultGateway(anterior);
    anterior = undefined;
    silencio.forEach((s) => s.mockRestore());
  });

  it('competidor, gabarito, juiz e duelo: 0 chamadas truncadas, nenhum finish_reason length', async () => {
    const fake = simuladorMandatory();
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    anterior = setDefaultGateway(gw);
    await gw.listModels(KEY); // catálogo em cache: o gateway sabe que o modelo é mandatory
    const ledger = new BudgetLedger();
    const ctx = { signal: ledger.signal, sink: ledger };

    // Gabarito (1 por cenário) — mesmo modelo como referência.
    const refs = await generateReferences({ stages: CENARIOS, apiKey: KEY, modelId: MANDATORY, ctx });
    const stages = CENARIOS.map((s, i) => ({ ...s, reference: refs[i]?.reference }));
    expect(stages.every((s) => s.reference), 'todo cenário ganhou gabarito').toBe(true);

    for (const stage of stages) {
      const responses = await Promise.all(
        CONTESTANTS_MANDATORY.map((c) =>
          runCompetitor({ apiKey: KEY, contestantId: c.id, modelId: MANDATORY, stage, ctx }),
        ),
      );
      expect(responses.map((r) => [r.status, r.truncated, r.truncationRetried])).toEqual([
        ['ok', false, undefined],
        ['ok', false, undefined],
      ]);
      const ref = await judgeStageReference({
        stage,
        responses,
        contestants: CONTESTANTS_MANDATORY,
        judgeModelIds: [MANDATORY],
        apiKey: KEY,
        ctx,
      });
      expect(ref.verdictByContestant).toEqual({ v0: 'resolve', v1: 'resolve' });
      const duels = await runStageDuels({
        stage,
        responses,
        contestants: CONTESTANTS_MANDATORY,
        judgeModelId: MANDATORY,
        topK: 0,
        duelists: ['v0', 'v1'],
        apiKey: KEY,
        ctx,
      });
      expect(duels.duels.length).toBeGreaterThan(0);
    }

    // A métrica de produção: histograma de finish_reason por papel no ledger.
    const porPapel = ledger.snapshot().finishByRole;
    const esperado: Array<[CostRole, number]> = [
      ['gabarito', 10],
      ['competitor', 20],
      ['judge', 20],
      ['duel', 20],
    ];
    for (const [papel, chamadas] of esperado) {
      const c = porPapel[papel]!;
      expect(c.calls, papel).toBe(chamadas);
      expect(c.truncated, papel).toBe(0);
      expect(c.finishReasons.length ?? 0, `${papel}: finish_reason length`).toBe(0);
      expect(c.finishReasons.stop, papel).toBe(chamadas);
    }
    expect(truncationStatsByRole(porPapel)).toEqual({ calls: 70, truncated: 0, rate: 0 });
    // Sem retry por truncamento: exatamente 70 chamadas de chat.
    expect(fake.chatRequests()).toHaveLength(70);
  });

  it('a MESMA fixture com os tetos antigos trunca em todo papel (a fixture discrimina)', async () => {
    const fake = simuladorMandatory();
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    await gw.listModels(KEY);
    const msgs = [
      { role: 'system' as const, content: 'ctx' },
      { role: 'user' as const, content: 'pergunta' },
    ];
    const chamar = (maxTokens: number, extra: { responseFormatJson?: boolean; system?: string } = {}) =>
      gw.chatCompletion({
        apiKey: KEY,
        modelId: MANDATORY,
        messages: extra.system ? [{ role: 'system', content: extra.system }, msgs[1]] : msgs,
        maxTokens,
        responseFormatJson: extra.responseFormatJson,
      });
    // Antes: juiz 1024, duelo 512, gabarito 1500, competidor = stage.maxTokens (300).
    const antes = [
      await chamar(TETOS_ANTIGOS.judge, { responseFormatJson: true }),
      await chamar(TETOS_ANTIGOS.duel, { responseFormatJson: true, system: 'DUELO' }),
      await chamar(TETOS_ANTIGOS.gabarito),
      await chamar(STAGE.maxTokens),
    ];
    expect(antes.map((r) => [r.truncated, r.finishReason, r.text])).toEqual(
      Array.from({ length: 4 }, () => [true, 'length', '']),
    );
    // Depois: os tetos do roleLimits cabem raciocínio + resposta.
    const depois = [
      await chamar(ROLE_MAX_TOKENS.judge, { responseFormatJson: true }),
      await chamar(ROLE_MAX_TOKENS.duel, { responseFormatJson: true, system: 'DUELO' }),
      await chamar(ROLE_MAX_TOKENS.gabarito),
      await chamar(competitorMaxTokens(STAGE.maxTokens)),
    ];
    expect(depois.map((r) => [r.truncated, r.finishReason])).toEqual(
      Array.from({ length: 4 }, () => [false, 'stop']),
    );
  });
});
