// IMPL-057 (R-11a:REC-8) — diagnóstico do juiz contestável.
//
// Contratos provados aqui (transporte FALSO, zero rede):
//  (i)   o voto de CADA juiz (veredito + explicação + confiança + canário) é
//        persistido por (etapa, contestant), incluindo a FALHA do juiz — a UI
//        mostra a concordância ("2 de 3: resolve") com o divergente destacado;
//  (ii)  `verdictSource=degraded` nunca é agrupado como falha do candidato;
//  (iii) run 8×4 (fixture N3) com 12 falhas renderiza ≤ 4 grupos
//        (compressão ≥ 3:1) por (cenário, categoria, causa técnica);
//  (iv)  o re-read do RunRecord preserva os vereditos por juiz (whitelists
//        `normalizeRunRecord`/`variationConfigFrom` verificadas);
//  (v)   a auditoria do contrato: "juiz: <modelo> (mesmo contrato desde a
//        última run)" e, ao mudar, o aviso "scores não comparáveis" (hash em
//        12 chars SÓ no detalhe/export).

import { describe, expect, it } from 'vitest';
import { createGateway, setDefaultGateway, type FetchLike } from '../src/openrouter.js';
import {
  failureCategoryOf,
  groupVerdictFailures,
  judgeStageReference,
  panelAgreement,
  verdictFailuresFromStages,
  type VerdictFailureEntry,
} from '../src/refJudge.js';
import { judgeContractAudit, noteJudgeContract, resetJudgeContractMemory } from '../src/engine/judgeCalibration.js';
import { normalizeRunRecord } from '../src/normalize.js';
import { variationConfigFrom } from '../src/trainer.js';
import type {
  CompetitorResponse,
  Contestant,
  ReferenceJudgeResult,
  StageSpec,
  TrainingConfig,
  Verdict,
} from '../src/types.js';
import { fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { canaryOf } from './judgeReplies.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

const STAGE: StageSpec = {
  question: 'Qual o prazo para trocar um produto?',
  productContext: 'Trocas em até 30 dias com nota fiscal.',
  maxTokens: 200,
  reference: 'Trinta dias a partir do recebimento, com nota fiscal.',
};

const resp = (id: string, text: string): CompetitorResponse => ({
  contestantId: id,
  modelId: 'fake/a',
  text,
  latencyMs: 1,
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
  status: 'ok',
});
const cont = (id: string): Contestant => ({ id, label: id, modelId: 'fake/a' });

async function comGateway<T>(fetch: FetchLike, fn: () => Promise<T>): Promise<T> {
  const anterior = setDefaultGateway(createGateway({ fetch, sleep: noSleep }));
  try {
    return await fn();
  } finally {
    setDefaultGateway(anterior);
  }
}

/** Réplica válida do juiz (contrato IMPL-047) com o canário do pedido. */
const reply = (req: { user: string }, verdict: Verdict, explanation = 'confere'): string =>
  JSON.stringify({ canario: canaryOf(req), explanation, verdict, confianca: 'media' });

describe('IMPL-057 — voto de cada juiz persistido + concordância do painel', () => {
  it('painel 2×resolve + 1 falha ⇒ "2 de 3: resolve", badge de falha e fonte degraded', async () => {
    const fake = fakeOpenRouter({
      chat: (req) =>
        req.model === 'fake/j3'
          ? { text: 'não respondo em JSON nem com lembrete.', finishReason: 'stop' }
          : { text: reply(req, 'resolve'), finishReason: 'stop' },
    });
    const out = await comGateway(fake.fetch, () =>
      judgeStageReference({
        stage: STAGE,
        responses: [resp('c1', 'Trinta dias, com nota fiscal.')],
        contestants: [cont('c1')],
        judgeModelIds: ['fake/j1', 'fake/j2', 'fake/j3'],
        apiKey: KEY,
      }),
    );
    // Persistidos os 3 votos — inclusive a FALHA do j3 (falha ≠ veredito).
    const votos = out.judgeVotesByContestant!['c1'];
    expect(votos).toHaveLength(3);
    expect(votos.filter((v) => v.verdict !== undefined)).toHaveLength(2);
    const falha = votos.find((v) => v.verdict === undefined)!;
    expect(falha.judgeModelId).toBe('fake/j3');
    expect(falha.error?.kind).toBe('invalid_output');
    for (const v of votos.filter((v) => v.verdict !== undefined)) {
      expect(v.explanation).toBeTruthy();
      expect(v.confianca).toBe('media');
      expect(v.canary).toBeTruthy();
    }
    // Concordância para a UI ("2 de 3: resolve") + falha destacada.
    const painel = panelAgreement(votos, out.verdictByContestant['c1']);
    expect(painel.label).toBe('2 de 3: resolve');
    expect(painel.verdict).toBe('resolve');
    expect(painel.agreeCount).toBe(2);
    expect(painel.failedJudgeIds).toEqual(['fake/j3']);
    expect(painel.divergentJudgeIds).toEqual([]);
    // Painel REDUZIDO ⇒ veredito existe mas é 'degraded' (conta na run inconclusiva).
    expect(out.verdictSourceByContestant['c1']).toBe('degraded');
  });

  it('painel 2×resolve + 1×nao ⇒ divergente destacado; fonte "judge" com painel completo', async () => {
    const fake = fakeOpenRouter({
      chat: (req) => ({
        text: reply(req, req.model === 'fake/j3' ? 'nao' : 'resolve'),
        finishReason: 'stop',
      }),
    });
    const out = await comGateway(fake.fetch, () =>
      judgeStageReference({
        stage: STAGE,
        responses: [resp('c1', 'Trinta dias, com nota fiscal.')],
        contestants: [cont('c1')],
        judgeModelIds: ['fake/j1', 'fake/j2', 'fake/j3'],
        apiKey: KEY,
      }),
    );
    const votos = out.judgeVotesByContestant!['c1'];
    const painel = panelAgreement(votos, out.verdictByContestant['c1']);
    expect(painel.label).toBe('2 de 3: resolve');
    expect(painel.divergentJudgeIds).toEqual(['fake/j3']);
    expect(painel.failedJudgeIds).toEqual([]);
    expect(out.verdictSourceByContestant['c1']).toBe('judge');
  });

  it('vereditos determinísticos (ground-truth/auto) ficam SEM painel — não há juízes', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: 'x', finishReason: 'stop' }) });
    const comRotulo = {
      ...STAGE,
      expected: 'positivo',
      labelSet: ['positivo', 'negativo'],
      reference: 'positivo — ok.',
    };
    const out = await comGateway(fake.fetch, () =>
      judgeStageReference({
        stage: comRotulo,
        responses: [resp('c1', 'positivo')],
        contestants: [cont('c1')],
        judgeModelIds: ['fake/j1'],
        apiKey: KEY,
      }),
    );
    expect(out.judgeVotesByContestant).toBeUndefined();
    expect(out.verdictSourceByContestant['c1']).toBe('ground-truth');
    expect(fake.chatRequests()).toHaveLength(0);
  });
});

describe('IMPL-057 — falhas agrupadas por (cenário, categoria, causa técnica)', () => {
  const erro = (kind: VerdictFailureEntry['kind'], msg = 'falha'): ReferenceJudgeResult['verdictErrorByContestant'][string] => ({
    kind,
    message: msg,
  });

  it('verdictSource=degraded nunca é agrupado como falha do candidato', () => {
    const stage = {
      spec: { question: 'Etapa com painel reduzido' },
      referenceJudge: {
        verdictByContestant: { c1: 'resolve' as Verdict },
        explanationByContestant: { c1: 'ok' },
        // Guarda extra: mesmo com erro adversarial para o MESMO contestant,
        // fonte 'degraded' é veredito PRESENTE — nunca falha do candidato.
        verdictErrorByContestant: { c1: erro('judge_failed'), c2: erro('timeout') },
        verdictSourceByContestant: { c1: 'degraded' as const },
        judgeModelId: 'j',
      },
    };
    const falhas = verdictFailuresFromStages([stage]);
    expect(falhas.map((f) => f.contestantId)).toEqual(['c2']);
    const grupos = groupVerdictFailures(falhas);
    expect(grupos.flatMap((g) => g.items.map((i) => i.contestantId))).toEqual(['c2']);
  });

  it('fixture N3: run 8×4 com 12 falhas renderiza ≤ 4 grupos (compressão ≥ 3:1)', () => {
    // 8 cenários × 4 contestants; as 12 falhas concentram-se em 4 células de
    // (cenário, categoria, causa técnica) — o que o ErrorAtlas comprime.
    const cenarios = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const falhasPorCenario: Record<string, Array<[string, VerdictFailureEntry['kind']]>> = {
      A: [['c1', 'timeout'], ['c2', 'timeout'], ['c3', 'timeout'], ['c4', 'timeout']],
      B: [['c1', 'invalid_output'], ['c2', 'invalid_output'], ['c3', 'invalid_output']],
      C: [['c2', 'judge_failed'], ['c3', 'judge_failed'], ['c4', 'judge_failed']],
      D: [['c1', 'blocked'], ['c2', 'blocked']],
      E: [],
      F: [],
      G: [],
      H: [],
    };
    const stages = cenarios.map((nome) => ({
      spec: { question: `Cenário ${nome}` },
      referenceJudge: {
        verdictByContestant: {} as Record<string, Verdict>,
        explanationByContestant: {},
        verdictErrorByContestant: Object.fromEntries(
          falhasPorCenario[nome].map(([cid, kind]) => [cid, erro(kind)]),
        ),
        judgeModelId: 'j',
      },
    }));
    const falhas = verdictFailuresFromStages(stages);
    expect(falhas).toHaveLength(12);
    const grupos = groupVerdictFailures(falhas);
    expect(grupos.length).toBeLessThanOrEqual(4); // critério IMPL-057
    expect(12 / grupos.length).toBeGreaterThanOrEqual(3); // compressão ≥ 3:1
    // Facetas do ErrorAtlas: categoria derivada da causa técnica.
    const chaves = grupos.map((g) => `${g.scenario}|${g.category}|${g.cause}`).sort();
    expect(chaves).toEqual([
      'Cenário A|infrastructure|timeout',
      'Cenário B|judge|invalid_output',
      'Cenário C|judge|judge_failed',
      'Cenário D|gateway|blocked',
    ]);
    expect(grupos.map((g) => g.count).sort()).toEqual([2, 3, 3, 4]);
    // Rollup de cenários (facet alternativa) mantém a compressão.
    const rollup = groupVerdictFailures(falhas, { rollupScenarios: true });
    expect(rollup.length).toBeLessThanOrEqual(4);
    expect(failureCategoryOf('no_reference')).toBe('reference');
    expect(failureCategoryOf('competitor_error')).toBe('competitor');
    expect(failureCategoryOf('truncated')).toBe('judge');
  });
});

describe('IMPL-057 — re-read preserva os vereditos por juiz (whitelists)', () => {
  const resultado: ReferenceJudgeResult = {
    verdictByContestant: { c1: 'resolve' },
    explanationByContestant: { c1: 'confere' },
    verdictSourceByContestant: { c1: 'judge' },
    verdictErrorByContestant: {},
    judgeVotesByContestant: {
      c1: [
        { judgeModelId: 'fake/j1', verdict: 'resolve', explanation: 'confere', confianca: 'media', canary: 'abc' },
        { judgeModelId: 'fake/j2', verdict: 'nao', explanation: 'falta nota', confianca: 'baixa', canary: 'def' },
      ],
    },
    judgeModelId: 'fake/j1+fake/j2',
  };

  it('normalizeRunRecord preserva judgeVotesByContestant no re-read', () => {
    const raw = {
      id: 'run-impl057',
      status: 'finished',
      config: { mode: 'compare', competitorModelIds: ['c1'], judgeModelIds: ['fake/j1'] },
      contestants: [{ id: 'c1', label: 'c1', modelId: 'm1' }],
      stages: [
        {
          index: 0,
          spec: STAGE,
          responses: [],
          referenceJudge: resultado,
          startedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      scoreboard: {},
      totalCostUsd: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    const relido = normalizeRunRecord(raw as never);
    expect(relido.stages[0].referenceJudge?.judgeVotesByContestant).toEqual(resultado.judgeVotesByContestant);
    expect(relido.stages[0].referenceJudge?.judgeVotesByContestant!['c1'][1].verdict).toBe('nao');
  });

  it('variationConfigFrom leva a validação do gabarito das customStages (whitelist)', () => {
    const validation = {
      rubric: { verdict: 'parcial' as const, divergent: true, method: 'expected' as const, detail: 'falta elemento' },
      secondReference: { modelId: 'fake/ref2', text: 'segundo gabarito', agree: false },
      auditSample: true,
      reviewReasons: ['reference_rubric_divergence' as const, 'reference_disagreement' as const],
    };
    const cfg = {
      mode: 'training',
      theme: 'x',
      stages: 1,
      judgeModelIds: ['fake/judge'],
      customStages: [{ ...STAGE, referenceValidation: validation }],
    } as unknown as TrainingConfig;
    const iter = variationConfigFrom(cfg);
    expect(iter.customStages?.[0].referenceValidation).toEqual(validation);
  });
});

describe('IMPL-057 — hash do contrato em auditoria', () => {
  it('"juiz: <modelo> (mesmo contrato desde a última run)"; ao mudar, "scores não comparáveis" com hash 12 chars só no detalhe', () => {
    const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const igual = judgeContractAudit({ modelIds: ['anthropic/claude-x'], hash, previousHash: hash });
    expect(igual.line).toBe('juiz: anthropic/claude-x (mesmo contrato desde a última run)');
    expect(igual.line).not.toContain(hash.slice(0, 12)); // hash SÓ no detalhe
    expect(igual.detail).toContain(hash.slice(0, 12));

    const mudou = judgeContractAudit({
      modelIds: ['anthropic/claude-x', 'openai/gpt-y'],
      hash,
      previousHash: 'ffffffffffffffffffffffffffffffff',
    });
    expect(mudou.line).toContain('scores não comparáveis');
    expect(mudou.line).toContain('anthropic/claude-x+openai/gpt-y');
    expect(mudou.detail).toContain(hash.slice(0, 12));
    expect(mudou.detail).toContain('ffffffffffff');
    // Sem histórico: primeira run não acusa mudança nem promete comparação.
    const primeira = judgeContractAudit({ modelIds: ['m'], hash });
    expect(primeira.line).toContain('sem contrato anterior');
  });

  it('a mensagem de drift do contrato cita "scores não comparáveis" (e o teste antigo continua verde)', () => {
    resetJudgeContractMemory();
    noteJudgeContract('11111111111111111111111111111111');
    const drift = noteJudgeContract('22222222222222222222222222222222');
    expect(drift.changed).toBe(true);
    expect(drift.message).toContain('contrato do juiz mudou');
    expect(drift.message).toContain('recalibre');
    expect(drift.message).toContain('scores não comparáveis');
    resetJudgeContractMemory();
  });
});