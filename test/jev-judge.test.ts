// JUIZ JEV — contrato do motor de julgamento por decisão tipada
// (`src/jevJudge.ts`) nos modos de benchmark. Tudo contra o FAKE: nenhuma rede,
// nenhum gasto.
//
//   (1) a definição do juiz: `verdict` (choice resolve/parcial/nao) + 1 `noul`
//       por critério de checklist da rubrica; a resposta do candidato vai como
//       conteúdo NÃO CONFIÁVEL; o PREVISTO é sempre o `choice` DECLARADO;
//   (2) bandas auto/hitl/abstain sobre o `confidence` opaco (pTop no lugar
//       quando ausente) decidem quem fica com o Jev e quem ESCALA;
//   (3) escalada: o painel LLM decide a célula (fonte 'judge'); escalada que
//       falha mantém o veredito DECLARADO do Jev com confiança da banda —
//       nunca nota inventada, nunca veredito imputado;
//   (4) LGPD: modelo de decisão fora da allowlist ZDR cai no painel LLM
//       (`jevFallback.reason = 'lgpd'`) SEM nenhuma chamada ao endpoint;
//   (5) regras de origem preservadas: erro/bloqueio sem veredito, vazio =
//       'nao' automático, `expected` = ground-truth determinístico;
//   (6) duelo: choice a_melhor/b_melhor/empate, banda auto decide, resto cai
//       no juiz LLM do par (fallback);
//   (7) superfícies de config: `judging.engine` default `jev` em
//       arena-config@1 → RunConfig, round-trip da vista arena, RunConfig cru e
//       `variationConfigFrom` (whitelist do treino).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetLedger } from '../src/budget.js';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import {
  JEV_JUDGE_BANDS_DEFAULT,
  JEV_JUDGE_CONTRACT_TEXT,
  JEV_JUDGE_MODEL_DEFAULT,
  VERDICT_QID,
  buildJevJudgeSpec,
  jevBlockedByPolicy,
  jevConfidenceOf,
  jevJudgeCellFrom,
  judgeDuelOrderJev,
  judgeStageListwiseJev,
  judgeStageReferenceJev,
  rubricCriteriaOf,
} from '../src/jevJudge.js';
import { wireQuestionsOf } from '../src/engine/jev/index.js';
import { parseArenaConfig } from '../src/configFile.js';
import { arenaConfigToRunConfig } from '../src/arenaConfig.js';
import { runConfigToArenaConfig } from '../src/runArtifact.js';
import { parseRunConfig } from '../src/runConfigSchema.js';
import { variationConfigFrom } from '../src/trainer.js';
import { fakeOpenRouter, noSleep, type FakeDecisionReply, type FakeRequest } from './fakeOpenRouter.js';
import { answerFor } from './fakeDecisions.js';
import { pointwiseReply } from './judgeReplies.js';
import type { CompetitorResponse, Contestant, CostSink, StageSpec, TrainingConfig } from '../src/types.js';

const KEY = 'sk-or-v1-fake-key-para-teste-jev-juiz-00';
const JEV = { decisionModelId: 'typesafe/jev-1.13', autoBand: 0.9, hitlBand: 0.5 };

const STAGE: StageSpec = {
  question: 'Classifique o ticket e diga o time dono do caso.',
  productContext: 'Suporte de um e-commerce (pagamentos, frontend, outros).',
  maxTokens: 300,
  rubric: '- O ticket vai para o time que realmente dono do caso.\n- Nenhum prazo ou valor é inventado.\nProsse pura não vira critério.',
  reference: 'pagamentos — cobrança duplicada.',
};

const resp = (id: string, text: string): CompetitorResponse => ({ contestantId: id, text, status: 'ok' });
const contestant = (id: string): Contestant => ({ id, label: id, modelId: 'fake/a' });

function useFake(opts: Parameters<typeof fakeOpenRouter>[0]): ReturnType<typeof fakeOpenRouter> {
  const fake = fakeOpenRouter(opts);
  setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }) as unknown as OpenRouterGateway);
  return fake;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// (1) A definição de decisão do juiz
// ---------------------------------------------------------------------------

describe('buildJevJudgeSpec — o "prompt" JEV do juiz', () => {
  it('`verdict` choice resolve/parcial/nao + 1 noul por critério de checklist; resposta = não confiável', () => {
    const { spec, state, questions, criteriaQids } = buildJevJudgeSpec({
      stage: STAGE,
      reference: STAGE.reference,
      candidate: 'pagamentos',
    });
    const verdict = spec.questions[0];
    expect(verdict).toMatchObject({ id: VERDICT_QID, type: 'choice' });
    expect(Object.keys((verdict as { criteria: Record<string, unknown> }).criteria)).toEqual([
      'resolve',
      'parcial',
      'nao',
    ]);
    // 2 bullets úteis na rubrica (a "prosa" não decompõe).
    expect(criteriaQids).toEqual(['criterio_1', 'criterio_2']);
    for (const qid of criteriaQids) expect(questions[qid]).toMatchObject({ type: 'noul' });
    expect(state).toMatchObject({
      tarefa: STAGE.question,
      resposta_candidato: 'pagamentos',
      referencia: STAGE.reference,
      rubrica: STAGE.rubric,
    });
    const campo = spec.stateView?.fields.find((f) => f.as === 'resposta_candidato');
    expect(campo?.untrusted).toBe(true);
    expect(spec.id).toMatch(/^sha256:/);
    // A escala fixa do juiz é o contrato (vai hasheado no record).
    expect(JEV_JUDGE_CONTRACT_TEXT).toMatch(/resolve =/);
  });

  it('rubrica em prosa não decompõe; rubricQuestions:false desliga a decomposição', () => {
    const prosa: StageSpec = { ...STAGE, rubric: 'A resposta deve ser correta e completa, sem inventar nada.' };
    expect(buildJevJudgeSpec({ stage: prosa, candidate: 'x' }).criteriaQids).toEqual([]);
    expect(buildJevJudgeSpec({ stage: STAGE, candidate: 'x', jevJudge: { rubricQuestions: false } }).criteriaQids).toEqual([]);
  });

  it('rubricCriteriaOf: só linhas de checklist, mínimo 8 chars, teto de 6', () => {
    const rubric = [
      ...Array.from({ length: 8 }, (_, i) => `- Critério número ${i + 1} bem descrito.`),
      'prosa qualquer',
      '- curto',
    ].join('\n');
    expect(rubricCriteriaOf(rubric)).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// (2) Resposta → célula (o PREVISTO é o DECLARADO; bandas decidem)
// ---------------------------------------------------------------------------

describe('jevJudgeCellFrom — declared > argmax, bandas, motivo determinístico', () => {
  const specParts = buildJevJudgeSpec({ stage: STAGE, candidate: 'x' });
  const questions = specParts.questions;
  const bands = { auto: JEV_JUDGE_BANDS_DEFAULT.auto, hitl: JEV_JUDGE_BANDS_DEFAULT.hitl };

  const answerVerdict = (choice: string, probabilities: Record<string, number>, confidence?: number) => ({
    [VERDICT_QID]: {
      type: 'choice',
      choice,
      probabilities,
      ...(confidence !== undefined ? { confidence } : {}),
    },
  });

  it('o veredito é o choice DECLARADO, nunca o argmax das probabilidades', () => {
    const cell = jevJudgeCellFrom(
      answerVerdict('resolve', { resolve: 0.3, parcial: 0.6, nao: 0.1 }, 0.95),
      questions,
      bands,
    );
    expect(cell.verdict).toBe('resolve'); // declarado — p(parcial) era maior
    expect(cell.probabilities).toEqual({ resolve: 0.3, parcial: 0.6, nao: 0.1 });
    expect(cell.band).toBe('auto');
    expect(cell.source).toBe('jev');
    expect(cell.motivo).toContain('p(resolve)=0,30');
  });

  it('bandas vêm do `confidence` opaco: auto/hitl/abstain; sem confidence cai em max(p)', () => {
    expect(jevJudgeCellFrom(answerVerdict('nao', { resolve: 0.05, parcial: 0.05, nao: 0.9 }, 0.92), questions, bands).band).toBe('auto');
    expect(jevJudgeCellFrom(answerVerdict('nao', { resolve: 0.2, parcial: 0.3, nao: 0.5 }, 0.7), questions, bands).band).toBe('hitl');
    expect(jevJudgeCellFrom(answerVerdict('nao', { resolve: 0.2, parcial: 0.3, nao: 0.5 }, 0.4), questions, bands).band).toBe('abstain');
    // sem confidence: pTop 0,50 → hitl (>= 0,50); pTop 0,45 → abstain.
    expect(jevJudgeCellFrom(answerVerdict('nao', { resolve: 0.1, parcial: 0.5, nao: 0.4 }), questions, bands).band).toBe('hitl');
    expect(jevJudgeCellFrom(answerVerdict('nao', { resolve: 0.45, parcial: 0.45, nao: 0.1 }), questions, bands).band).toBe('abstain');
  });

  it('resposta fora do contrato = banda `failed`, SEM veredito (falha não é veredito)', () => {
    const cell = jevJudgeCellFrom({}, questions, bands);
    expect(cell.band).toBe('failed');
    expect(cell.verdict).toBeUndefined();
    const errado = jevJudgeCellFrom({ [VERDICT_QID]: { type: 'choice', choice: 'resolve_total' } }, questions, bands);
    expect(errado.band).toBe('failed');
  });

  it('critérios decompostos entram no diagnóstico e no motivo', () => {
    const cell = jevJudgeCellFrom(
      {
        ...answerVerdict('resolve', { resolve: 0.95, parcial: 0.04, nao: 0.01 }, 0.95),
        criterio_1: { type: 'noul', noul: 0.85 },
        criterio_2: { type: 'noul', noul: 0.2 },
      },
      questions,
      bands,
    );
    expect(cell.criteria).toEqual({ criterio_1: true, criterio_2: false });
    expect(cell.motivo).toContain('critérios 1/2');
  });

  it('confiança declarada pela banda (triagem humana): auto=alta, hitl=média, abstain/failed=baixa', () => {
    expect(jevConfidenceOf('auto')).toBe('alta');
    expect(jevConfidenceOf('hitl')).toBe('media');
    expect(jevConfidenceOf('abstain')).toBe('baixa');
    expect(jevConfidenceOf('failed')).toBe('baixa');
  });
});

// ---------------------------------------------------------------------------
// (3)+(5) pointwise vs gabarito: cascata + regras de origem
// ---------------------------------------------------------------------------

describe('judgeStageReferenceJev — cascata Jev → painel LLM', () => {
  const RESPONDED = [resp('boa', 'O dono é o time de pagamentos.'), resp('duvida', 'Talvez pagamentos?'), resp('quebrada', 'QUEBRADA sem contrato')];

  /** O Jev decide pelo texto do candidato: boa=auto, duvida=hitl, quebrada=fora do contrato. */
  function decisionsFake(req: FakeRequest): FakeDecisionReply {
    const state = req.body!.state as Record<string, string>;
    const cand = state.resposta_candidato ?? '';
    const answers: Record<string, unknown> = {};
    for (const [qid, raw] of Object.entries((req.body!.questions ?? {}) as Record<string, unknown>)) {
      const q = raw as { type?: unknown; criteria?: unknown };
      if (qid === VERDICT_QID) {
        if (cand.includes('QUEBRADA')) continue; // sem resposta → answer.missing
        const conf = cand.includes('Talvez') ? 0.7 : 0.95;
        answers[qid] = answerFor(q, 'resolve', 0.9, conf);
      } else {
        answers[qid] = answerFor(q, true, 0.9, 0.95);
      }
    }
    return { answers };
  }

  it('banda auto fica com o Jev; hitl/falha escalam ao painel; vazio = auto; nada de nota inventada', async () => {
    const fake = useFake({
      decisions: (req) => decisionsFake(req),
      // O painel LLM de escalada sempre diz 'parcial' (com canário válido).
      chat: (req) => ({ text: pointwiseReply(req, 'parcial') }),
    });
    const r = await judgeStageReferenceJev({
      stage: STAGE,
      responses: [...RESPONDED, resp('vazia', '   ')],
      contestants: ['boa', 'duvida', 'quebrada', 'vazia'].map(contestant),
      judgeModelIds: ['fake/judge'],
      apiKey: KEY,
      jevJudge: JEV,
    });

    // Banda auto: veredito declarado do Jev (não o argmax), fonte 'jev'.
    expect(r.verdictByContestant.boa).toBe('resolve');
    expect(r.verdictSourceByContestant.boa).toBe('jev');
    expect(r.jevByContestant?.boa).toMatchObject({ band: 'auto', verdict: 'resolve' });
    expect(r.confidenceByContestant?.boa).toBe('alta');
    expect(r.judgeVotesByContestant?.boa?.[0]).toMatchObject({ judgeModelId: JEV.decisionModelId, verdict: 'resolve' });

    // hitl escalou: o painel decidiu ('parcial', fonte 'judge').
    expect(r.verdictByContestant.duvida).toBe('parcial');
    expect(r.verdictSourceByContestant.duvida).toBe('judge');
    expect(r.jevByContestant?.duvida).toMatchObject({ band: 'hitl', escalated: 'hitl', source: 'judge' });

    // Resposta fora do contrato escalou como erro e o painel decidiu.
    expect(r.verdictByContestant.quebrada).toBe('parcial');
    expect(r.jevByContestant?.quebrada).toMatchObject({ band: 'failed', escalated: 'error' });

    // Resposta vazia: 'nao' AUTOMÁTICO, sem gastar juiz nenhum.
    expect(r.verdictByContestant.vazia).toBe('nao');
    expect(r.verdictSourceByContestant.vazia).toBe('auto');

    // Contabilidade de chamadas: 1 decisão por resposta julgável; o painel só
    // nas 2 células escaladas.
    expect(fake.decisionRequests()).toHaveLength(3);
    expect(fake.chatRequests()).toHaveLength(2);
    expect(r.jevFallback).toBeUndefined();
    expect(r.judgeModelId).toContain(JEV.decisionModelId);
  });

  it('escalada que FALHA mantém o veredito declarado do Jev com confiança baixa (nunca nota inventada)', async () => {
    useFake({
      decisions: (req) => decisionsFake(req),
      chat: () => ({ status: 500, bodyText: 'boom' }),
    });
    const r = await judgeStageReferenceJev({
      stage: STAGE,
      responses: [resp('duvida', 'Talvez pagamentos?')],
      contestants: [contestant('duvida')],
      judgeModelIds: ['fake/judge'],
      apiKey: KEY,
      jevJudge: JEV,
    });
    // O Jev tinha veredito DECLARADO (resolve); a escalada falhou ⇒ fica ele,
    // com a confiança da banda (media) e a fonte 'jev' — sem veredito imputado.
    expect(r.verdictByContestant.duvida).toBe('resolve');
    expect(r.verdictSourceByContestant.duvida).toBe('jev');
    expect(r.confidenceByContestant?.duvida).toBe('media');
    expect(r.jevByContestant?.duvida?.escalated).toBe('hitl');
  });

  it('`expected` = ground-truth determinístico ANTES de qualquer juiz (nenhuma decisão pedida)', async () => {
    const fake = useFake({ decisions: (req) => decisionsFake(req), chat: (req) => ({ text: pointwiseReply(req, 'resolve') }) });
    const r = await judgeStageReferenceJev({
      stage: { ...STAGE, expected: 'pagamentos', labelSet: ['pagamentos', 'frontend', 'outro'] },
      responses: [resp('boa', 'pagamentos')],
      contestants: [contestant('boa')],
      judgeModelIds: ['fake/judge'],
      apiKey: KEY,
      jevJudge: JEV,
    });
    expect(r.judgeModelId).toBe('ground-truth');
    expect(r.verdictSourceByContestant.boa).toBe('ground-truth');
    expect(fake.decisionRequests()).toHaveLength(0);
    expect(fake.chatRequests()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (4) LGPD fail-closed → fallback ao painel
// ---------------------------------------------------------------------------

describe('LGPD — Jev fora da allowlist ZDR cai no painel (fail-closed respeitado)', () => {
  it('jevFallback "lgpd", ZERO chamadas ao endpoint de decisões, painel decide tudo', async () => {
    const fake = useFake({ chat: (req) => ({ text: pointwiseReply(req, 'resolve') }) });
    // Realista: o Jev (TypeSafe) não tem endpoint ZDR (`sem_endpoint_zdr`); o
    // juiz LLM do painel tem rota ZDR e segue — o fail-closed só recusa o que
    // não é ZDR. O ledger REAL é o CostSink (reserve/note/admit).
    const ledger = new BudgetLedger({ budgetUsd: 10, estimateCall: () => 0.01 });
    ledger.setSensitiveRouting({
      area: 'saúde',
      routeFor: (modelId: string) =>
        modelId.startsWith('typesafe/')
          ? { ok: false, motivo: 'sem_endpoint_zdr' }
          : { ok: true, only: ['zdr/fake'] },
    });
    const r = await judgeStageReferenceJev({
      stage: STAGE,
      responses: [resp('a', 'resposta a'), resp('b', 'resposta b')],
      contestants: [contestant('a'), contestant('b')],
      judgeModelIds: ['fake/judge'],
      apiKey: KEY,
      jevJudge: JEV,
      ctx: { sink: ledger },
    });
    expect(r.jevFallback).toMatchObject({ reason: 'lgpd' });
    expect(r.jevFallback?.message).toMatch(/ZDR/);
    expect(fake.decisionRequests()).toHaveLength(0);
    expect(fake.chatRequests()).toHaveLength(2);
    expect(r.verdictSourceByContestant.a).toBe('judge');
  });

  it('jevBlockedByPolicy: sem política não há bloqueio; com política e rota ok, segue', () => {
    expect(jevBlockedByPolicy(undefined, JEV.decisionModelId)).toBeUndefined();
    const livre = { sensitiveRouting: () => undefined } as unknown as CostSink;
    expect(jevBlockedByPolicy({ sink: livre }, JEV.decisionModelId)).toBeUndefined();
    const ok = {
      sensitiveRouting: () => ({ area: 'geral', routeFor: () => ({ ok: true, only: ['zdr/x'] }) }),
    } as unknown as CostSink;
    expect(jevBlockedByPolicy({ sink: ok }, JEV.decisionModelId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (6) Duelo: choice por ordem, banda auto decide, resto escala
// ---------------------------------------------------------------------------

describe('judgeDuelOrderJev — ordem de duelo tipada', () => {
  const duelStatePick = (req: FakeRequest): FakeDecisionReply => {
    const state = req.body!.state as Record<string, string>;
    const conf = state.resposta_a.includes('MELHOR') ? 0.95 : 0.4;
    return {
      answers: {
        vencedor: answerFor({ type: 'choice', criteria: { a_melhor: '', b_melhor: '', empate: '' } }, 'a_melhor', 0.8, conf),
      },
    };
  };

  it('banda auto: o choice declarado decide e o fallback LLM NÃO é chamado', async () => {
    const fake = useFake({ decisions: (req) => duelStatePick(req) });
    const fallback = vi.fn(async () => ({ ok: false as const, calls: 0, error: { kind: 'judge_failed' as const, message: 'x' } }));
    const r = await judgeDuelOrderJev({
      apiKey: KEY,
      stage: STAGE,
      reference: STAGE.reference ?? '',
      textA: 'MELHOR: pagamentos',
      textB: 'fraca',
      jevJudge: JEV,
      fallback,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.winner).toBe('A');
      expect(r.value.confianca).toBe('alta');
    }
    expect(fallback).not.toHaveBeenCalled();
    expect(fake.decisionRequests()).toHaveLength(1);
  });

  it('banda hitl escala para o juiz LLM do par (fallback)', async () => {
    useFake({ decisions: (req) => duelStatePick(req) });
    const fallback = vi.fn(async () => ({
      ok: true as const,
      calls: 1,
      value: { winner: 'tie' as const, explanation: 'llm', canary: 'c1', confianca: 'media' as const },
    }));
    const r = await judgeDuelOrderJev({
      apiKey: KEY,
      stage: STAGE,
      reference: STAGE.reference ?? '',
      textA: 'duvidosa',
      textB: 'outra',
      jevJudge: JEV,
      fallback,
    });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.winner).toBe('tie');
  });

  it('decisão que FALHA também escala (controle sobe: BudgetExceeded/RunCancelled)', async () => {
    useFake({ decisions: () => ({ status: 500, bodyText: 'boom' }) });
    const fallback = vi.fn(async () => ({
      ok: true as const,
      calls: 1,
      value: { winner: 'B' as const, explanation: 'llm', canary: 'c2' },
    }));
    const r = await judgeDuelOrderJev({
      apiKey: KEY,
      stage: STAGE,
      reference: '',
      textA: 'a',
      textB: 'b',
      jevJudge: JEV,
      fallback,
    });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.winner).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// (2b) listwise sem gabarito: score suave ordena, veredito primeiro
// ---------------------------------------------------------------------------

describe('judgeStageListwiseJev — sem gabarito, ranking por veredito + score suave', () => {
  it('declara vereditos do Jev, ranqueia por veredito (desempate suave) e traz o painel do Jev', async () => {
    useFake({
      decisions: (req) => {
        const state = req.body!.state as Record<string, string>;
        const conf = 0.95;
        const pick = state.resposta_candidato.includes('certa') ? 'resolve' : 'nao';
        return {
          answers: Object.fromEntries(
            Object.entries((req.body!.questions ?? {}) as Record<string, unknown>).map(([qid, raw]) => [
              qid,
              qid === VERDICT_QID
                ? answerFor(raw as { type?: unknown; criteria?: unknown }, pick, 0.9, conf)
                : answerFor(raw as { type?: unknown; criteria?: unknown }, true, 0.9, conf),
            ]),
          ),
        };
      },
    });
    const r = await judgeStageListwiseJev({
      stage: { ...STAGE, reference: undefined },
      responses: [resp('certa', 'resposta certa'), resp('errada', 'resposta errada')],
      contestants: [contestant('certa'), contestant('errada')],
      judgeModelIds: ['fake/judge'],
      apiKey: KEY,
      jevJudge: JEV,
    });
    expect(r.verdictByContestant).toEqual({ certa: 'resolve', errada: 'nao' });
    expect(r.rankedContestantIds).toEqual(['certa', 'errada']);
    expect(r.acceptableByContestant).toEqual({ certa: true, errada: false });
    expect(r.judges[0].judgeModelId).toBe(JEV.decisionModelId);
    expect(r.jevByContestant?.certa?.band).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// (7) Superfícies de config: default `jev`, mapeamento e round-trip
// ---------------------------------------------------------------------------

describe('config — judgeEngine default `jev` + jevJudge em todas as superfícies', () => {
  const ARENA = {
    format: 'arena-config@1',
    mode: 'compare',
    theme: 'Classificação de chamados',
    stages: 4,
    models: { datagen: 'acme/gen', judges: ['acme/judge-forte'], competitors: ['acme/alpha', 'acme/beta'] },
  };

  it('arena-config sem `judging.engine` ⇒ RunConfig COM judgeEngine "jev" (default sempre)', () => {
    const r = parseArenaConfig(ARENA as never);
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    const conv = arenaConfigToRunConfig(r.config);
    expect(conv.ok, conv.ok ? '' : conv.error).toBe(true);
    if (!conv.ok) return;
    expect(conv.config.judgeEngine).toBe('jev');
    expect(conv.config.jevJudge).toBeUndefined();
  });

  it('`judging.engine: llm` escala para o RunConfig; `judging.jev` vira jevJudge', () => {
    const r = parseArenaConfig({
      ...ARENA,
      judging: { engine: 'llm' },
    } as never);
    if (!r.ok) throw new Error(r.error);
    const conv = arenaConfigToRunConfig(r.config);
    if (!conv.ok) throw new Error(conv.error);
    expect(conv.config.judgeEngine).toBe('llm');

    const r2 = parseArenaConfig({
      ...ARENA,
      judging: { engine: 'jev', jev: { model: 'upstage/solar-decide', autoBand: 0.8, hitlBand: 0.4, rubricQuestions: false } },
    } as never);
    if (!r2.ok) throw new Error(r2.error);
    const conv2 = arenaConfigToRunConfig(r2.config);
    if (!conv2.ok) throw new Error(conv2.error);
    expect(conv2.config.jevJudge).toEqual({
      decisionModelId: 'upstage/solar-decide',
      autoBand: 0.8,
      hitlBand: 0.4,
      rubricQuestions: false,
    });
  });

  it('vista arena do `runs reproduce` faz round-trip do motor/config do juiz JEV', () => {
    const r = parseArenaConfig({
      ...ARENA,
      judging: { engine: 'jev', jev: { model: 'typesafe/jev-1.13', autoBand: 0.85 } },
    } as never);
    if (!r.ok) throw new Error(r.error);
    const conv = arenaConfigToRunConfig(r.config);
    if (!conv.ok) throw new Error(conv.error);
    const vista = runConfigToArenaConfig(conv.config);
    expect(vista.judging?.engine).toBe('jev');
    expect(vista.judging?.jev).toEqual({ model: 'typesafe/jev-1.13', autoBand: 0.85 });
    const volta = arenaConfigToRunConfig(vista);
    expect(volta.ok && volta.config.jevJudge).toEqual({ decisionModelId: 'typesafe/jev-1.13', autoBand: 0.85 });
  });

  it('RunConfig cru aceita judgeEngine/jevJudge e recusa motor desconhecido', () => {
    const base = {
      mode: 'compare',
      theme: 'x',
      stages: 2,
      datagenModelId: 'acme/gen',
      judgeModelIds: ['acme/judge'],
      contestantModelId: 'acme/a',
      competitorModelIds: ['acme/a', 'acme/b'],
    };
    const ok = parseRunConfig({
      ...base,
      judgeEngine: 'llm',
      jevJudge: { decisionModelId: 'typesafe/jev-1.13', hitlBand: 0.4 },
    });
    expect(ok.ok, ok.ok ? '' : ok.error).toBe(true);
    const ruim = parseRunConfig({ ...base, judgeEngine: 'humano' });
    expect(ruim.ok).toBe(false);
  });

  it('variationConfigFrom (whitelist do treino) carrega judgeEngine/jevJudge — nada é descartado em silêncio', () => {
    const cfg = {
      mode: 'training',
      theme: 'x',
      stages: 5,
      datagenModelId: 'acme/gen',
      judgeModelIds: ['acme/judge'],
      contestantModelId: 'acme/a',
      basePrompt: 'p',
      judgeEngine: 'llm' as const,
      jevJudge: { decisionModelId: 'typesafe/jev-1.13', autoBand: 0.8 },
    } as unknown as TrainingConfig;
    const v = variationConfigFrom(cfg);
    expect(v.judgeEngine).toBe('llm');
    expect(v.jevJudge).toEqual({ decisionModelId: 'typesafe/jev-1.13', autoBand: 0.8 });
  });

  it('defaults do juiz JEV: modelo fixado (nunca alias) e bandas 0,90/0,50', () => {
    expect(JEV_JUDGE_MODEL_DEFAULT).toBe('typesafe/jev-1.13');
    expect(JEV_JUDGE_BANDS_DEFAULT).toEqual({ auto: 0.9, hitl: 0.5 });
    // buildJevJudgeSpec sem config usa os defaults.
    const { spec } = buildJevJudgeSpec({ stage: STAGE, candidate: 'x' });
    expect(spec.policy?.questions[VERDICT_QID]).toMatchObject({ auto: 0.9, hitl: 0.5, signal: 'confidence' });
  });
});
