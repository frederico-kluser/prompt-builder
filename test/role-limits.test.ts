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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGateway, guessPromptTokens, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { competitorModelHint, runCompetitor } from '../src/competitor.js';
import { estimateInputFromConfig, estimateRunCost } from '../src/estimate.js';
import { runToCompletion } from '../src/orchestrator.js';
import { getDataDir, setDataDir } from '../src/storage.js';
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
  competitorContextRoom,
  competitorMaxTokens,
  competitorReasoningHeadroom,
  ROLE_MAX_TOKENS,
  ROLE_MAX_TOKENS_FLOOR,
  roleMaxTokensViolations,
} from '../src/roleLimits.js';
import * as roleLimitsWeb from '../web/src/engine/roleLimits.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeChatReply, type FakeRequest } from './fakeOpenRouter.js';
import { canaryOf, duelReply, listwiseReply, pointwiseReply } from './judgeReplies.js';
import { buildCaseInput } from '../src/engine/caseInput.js';
import type { CompetitorResponse, Contestant, CostRole, ReasoningLevel, RunConfig, StageSpec } from '../src/types.js';

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
  // Contrato do IMPL-006: todo veredito devolve o canário do pedido.
  if (/duelo/i.test(req.system)) return { text: duelReply(req, 'A', 'A mais completa'), finishReason: 'stop' };
  const rotulos = /ordene TODOS estes rotulos da melhor para a pior[^:]*: (\[[^\]]*\])/.exec(req.user)?.[1];
  if (rotulos) {
    const labels = JSON.parse(rotulos) as string[];
    const verdicts = labels.map((label) => ({ label, justificativa: 'confere', veredito: 'resolve' }));
    return { text: listwiseReply(req, labels, verdicts), finishReason: 'stop' };
  }
  // Juiz de dossiê (agente) não usa canário; o pointwise usa.
  if (!canaryOf(req)) {
    // Contrato do IMPL-033/034: veredito do dossiê vem com a rubrica.
    const rubrica = { resultado: 'cumpre', escopo: 'no_escopo', burla: 'nao_detectada', manipulacao: 'nao_detectada' };
    return { text: JSON.stringify({ rubrica, verdict: 'resolve', explanation: 'confere com a referência' }), finishReason: 'stop' };
  }
  return { text: pointwiseReply(req, 'resolve', 'confere com a referência'), finishReason: 'stop' };
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

// ---------------------------------------------------------------------------
// Revisão IMPL-016 — folga pelo degrau EFETIVO, catálogo e porta de orçamento
// ---------------------------------------------------------------------------

const META_MANDATORY = { mandatory: true, supportedEfforts: ['high', 'medium', 'low'], defaultEffort: 'medium' };

describe('revisão IMPL-016 — folga do competidor pelo degrau que VAI no fio', () => {
  it('mandatory: `off` não é enviado => folga do default_effort; degrau fora da allowlist => folga do encaixado', () => {
    const hint = { reasoning: META_MANDATORY };
    // `off` em mandatory: o modelo raciocina no default (medium) — nunca a folga de `off`.
    expect(competitorReasoningHeadroom('off', hint)).toBe(COMPETITOR_REASONING_HEADROOM.medium);
    // 'minimal' em [high, medium, low] vai como 'low' (fitEffort): folga de 'low'.
    expect(competitorReasoningHeadroom('minimal', hint)).toBe(COMPETITOR_REASONING_HEADROOM.low);
    // 'max' em [high, medium, low] vai como 'high'.
    expect(competitorReasoningHeadroom('max', hint)).toBe(COMPETITOR_REASONING_HEADROOM.high);
    // Nada pedido => default_effort do catálogo.
    expect(competitorReasoningHeadroom(undefined, { reasoning: { ...META_MANDATORY, defaultEffort: 'high' } })).toBe(
      COMPETITOR_REASONING_HEADROOM.high,
    );
    // Não-mandatory: `off` vai como { enabled: false } e fica com a folga mínima.
    expect(competitorReasoningHeadroom('off', { reasoning: { mandatory: false } })).toBe(COMPETITOR_REASONING_HEADROOM.off);
  });

  it('catálogo nega raciocínio => folga 0; contexto limita só a FOLGA (a resposta nunca é cortada)', () => {
    expect(competitorMaxTokens(300, 'max', { deniesReasoning: true })).toBe(300);
    // 8k de contexto, 2k de prompt: cabe 6000 no max_tokens; 'max' pediria 300+16384.
    expect(competitorMaxTokens(300, 'max', { contextLength: 8192, promptTokens: 2192 })).toBe(6000);
    // Sem sala nem para a resposta: fica a resposta (o teto de antes do IMPL-016).
    expect(competitorMaxTokens(300, 'max', { contextLength: 1000, promptTokens: 900 })).toBe(300);
    expect(competitorContextRoom({ contextLength: 8192, promptTokens: 2192 })).toBe(6000);
    expect(competitorContextRoom({})).toBeUndefined();
    // O hint vem do catálogo: `catalogItem` padrão não lista parâmetro de raciocínio.
    expect(competitorModelHint(undefined)).toEqual({});
  });

  it('no fio: modelo que não raciocina manda só a resposta; contexto pequeno limita o teto E o retry x2', async () => {
    let n = 0;
    const fake = fakeOpenRouter({
      catalog: [
        catalogItem('fake/sem-raciocinio', 1e-9, 1e-9),
        catalogItem('fake/8k', 1e-9, 1e-9, {
          context_length: 8192,
          supported_parameters: ['max_tokens', 'reasoning'],
        }),
      ],
      // 1a chamada do 8k trunca (dispara o retry), o resto responde.
      chat: (req) =>
        req.model === 'fake/8k' && n++ === 0
          ? { text: 'Você tem', finishReason: 'length', nativeFinishReason: 'max_tokens' }
          : { text: 'Você tem 30 dias.', finishReason: 'stop' },
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const anterior = setDefaultGateway(gw);
    const silencio = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await gw.listModels(KEY);
      await runCompetitor({ apiKey: KEY, contestantId: 'c', modelId: 'fake/sem-raciocinio', stage: STAGE, reasoningLevel: 'max' });
      const r8k = await runCompetitor({ apiKey: KEY, contestantId: 'c', modelId: 'fake/8k', stage: STAGE, reasoningLevel: 'max' });
      const [semRac, primeira, retry] = fake.chatRequests();
      expect(semRac.body?.max_tokens).toBe(STAGE.maxTokens);
      expect(semRac.body?.reasoning).toBeUndefined();
      // Prompt = o caso montado por buildCaseInput (IMPL-009), como o competidor envia.
      const prompt = guessPromptTokens(buildCaseInput(STAGE));
      expect(primeira.body?.max_tokens).toBe(8192 - prompt);
      expect(r8k.truncationRetried).toBe(true);
      // O retry x2 também não passa do contexto (prompt + max_tokens > contexto = HTTP 400).
      expect(retry.body?.max_tokens).toBe(8192 - prompt);
    } finally {
      silencio.mockRestore();
      setDefaultGateway(anterior);
    }
  });

  it('(iii) mandatory com `off` e `minimal` pedidos: 0 truncamento (o teto segue o degrau efetivo)', async () => {
    const fake = simuladorMandatory();
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const anterior = setDefaultGateway(gw);
    try {
      await gw.listModels(KEY);
      const ledger = new BudgetLedger();
      const ctx = { signal: ledger.signal, sink: ledger };
      for (const reasoningLevel of ['off', 'minimal'] as const) {
        const rs = await Promise.all(
          CENARIOS.map((stage) =>
            runCompetitor({ apiKey: KEY, contestantId: 'c', modelId: MANDATORY, stage, reasoningLevel, ctx }),
          ),
        );
        expect(rs.map((r) => [r.status, r.truncated, r.truncationRetried ?? false])).toEqual(
          CENARIOS.map(() => ['ok', false, false]),
        );
      }
      const c = ledger.snapshot().finishByRole.competitor!;
      expect(c.calls).toBe(20);
      expect(c.truncated).toBe(0);
      expect(fake.chatRequests()).toHaveLength(20);
      // off em mandatory: nada de `reasoning` no corpo (o provedor rejeita 'none').
      expect(fake.chatRequests()[0].body?.reasoning).toBeUndefined();
      expect(fake.chatRequests()[10].body?.reasoning).toEqual({ effort: 'low' });
    } finally {
      setDefaultGateway(anterior);
    }
  });
});

describe('revisão IMPL-016 — porta suave e porta dura usam o MESMO teto do competidor', () => {
  let dirAnterior: string;
  let tmp: string;
  let silencio: Array<{ mockRestore(): void }> = [];
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl016-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio = (['log', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
  });
  afterAll(() => {
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  // 5 cenários: piso de n efetivo do IMPL-004 (abaixo disso a run é 'inconclusive').
  const CEN: StageSpec[] = [0, 1, 2, 3, 4].map((i) => ({
    question: `Pergunta ${i} sobre prazo de troca?`,
    productContext: 'Trocas em 30 dias.',
    maxTokens: 300,
  }));
  const RAC = { supported_parameters: ['max_tokens', 'reasoning', 'response_format'] };

  function fakeDaRun(): ReturnType<typeof fakeOpenRouter> {
    return fakeOpenRouter({
      // Competidor caro (1e-6/token) — o teto dele domina a reserva.
      catalog: ['fake/ref', 'fake/judge', 'fake/a', 'fake/b'].map((id) => catalogItem(id, 1e-6, 1e-6, RAC)),
      chat: (req) => {
        const usage = { prompt_tokens: 100, completion_tokens: 50, cost: 0.00015 };
        if (req.model === 'fake/ref') return { text: 'Gabarito: 30 dias', usage };
        if (req.stream) return { text: 'Resposta', usage };
        return { text: pointwiseReply(req, 'resolve', 'ok'), usage };
      },
    });
  }

  function configCom(budgetUsd?: number): RunConfig {
    return {
      mode: 'compare',
      theme: 'suporte',
      stages: CEN.length,
      customStages: CEN,
      judgeModelIds: ['fake/judge'],
      referenceModelId: 'fake/ref',
      referenceJudging: true,
      competitorModelIds: ['fake/a', 'fake/b'],
      finalists: 0,
      duels: false,
      timeoutMs: 5000,
      maxOutputTokens: 300,
      reasoning: { competitor: 'max' },
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    } as unknown as RunConfig;
  }

  it('estimativa cabe no orçamento => a run termina inteira (nenhuma etapa cortada pela porta dura no meio de G2)', async () => {
    const fake = fakeDaRun();
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const anterior = setDefaultGateway(gw);
    try {
      const models = await gw.listModels(KEY);
      const est = estimateRunCost(estimateInputFromConfig(configCom()), models, { unknownPrice: 'worst-case' });
      // A estimativa precifica o teto que a reserva usa (resposta + folga de 'max').
      const teto = competitorMaxTokens(300, 'max', competitorModelHint(models.find((m) => m.id === 'fake/a')));
      expect(teto).toBe(300 + COMPETITOR_REASONING_HEADROOM.max);
      expect(est.byRole.competitor).toBeCloseTo(CEN.length * 2 * (500 + teto) * 1e-6, 9);

      const rec = await runToCompletion(configCom(est.point), KEY, {});
      expect(rec.stoppedReason).toBeUndefined();
      expect(rec.status).toBe('finished');
      expect(rec.stages.map((s) => s.incomplete ?? false)).toEqual(CEN.map(() => false));
      // O teto enviado é o mesmo que a estimativa precificou.
      const tetos = fake.chatRequests().filter((r) => r.stream).map((r) => r.body?.max_tokens);
      expect(tetos).toEqual(Array.from({ length: CEN.length * 2 }, () => teto));
    } finally {
      setDefaultGateway(anterior);
    }
  });

  it('orçamento abaixo da estimativa => a PORTA SUAVE para antes de G2 (nunca metade das etapas)', async () => {
    const fake = fakeDaRun();
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const anterior = setDefaultGateway(gw);
    try {
      const models = await gw.listModels(KEY);
      const est = estimateRunCost(estimateInputFromConfig(configCom()), models, { unknownPrice: 'worst-case' });
      const rec = await runToCompletion(configCom(est.point * 0.5), KEY, {});
      expect(rec.stoppedReason).toBe('budget');
      expect(rec.stoppedAtPhase).toBe('competitors');
      expect(new Set(rec.stages.map((s) => s.incompleteReason))).toEqual(new Set(['budget']));
      // Nenhum competidor chegou a ser chamado: a porta suave decidiu antes.
      expect(fake.chatRequests().filter((r) => r.stream)).toHaveLength(0);
    } finally {
      setDefaultGateway(anterior);
    }
  });
});
