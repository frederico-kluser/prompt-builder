// IMPL-047 (R-03a:REC-7) — prompt HONESTO do juiz pointwise + campo `confianca`.
//
// Contratos provados aqui (transporte FALSO, zero rede, zero gasto):
//  (i)   a referência é CANDIDATA ("pode estar errada") — nunca "(correta)";
//  (ii)  a rubrica tem PRIORIDADE: se a referência contrariar a rubrica, siga a
//        rubrica (cláusula no contrato fixo, não só no pedido);
//  (iii) "ignore redação/estilo" é CONDICIONAL — só quando a rubrica NÃO traz
//        critério de forma (heurística `rubricHasStyleCriterion`);
//  (iv)  o JSON do juiz pede `confianca` (baixa/media/alta), o parse a devolve e
//        o resultado a PERSISTE por veredito (menor entre os votos do painel —
//        triagem de revisão humana pende para o lado inseguro).
// ⚠️ Estes snapshots TRAVAM o contrato do juiz: mudar o prompt muda o hash
// (IMPL-049) e exige recalibração — mudança aqui é decisão deliberada.

import { describe, expect, it } from 'vitest';
import { createGateway, setDefaultGateway, type FetchLike } from '../src/openrouter.js';
import {
  buildReferenceJudgePrompt,
  JUDGE_CONTRACT_TEXT,
  judgeStageReference,
  parseJudgeReply,
  REFERENCE_JUDGE_SCHEMA,
} from '../src/refJudge.js';
import { rubricHasStyleCriterion } from '../src/engine/judgeGuard.js';
import { canaryOf, candidateOf } from './judgeReplies.js';
import { fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import type { CompetitorResponse, Contestant, StageSpec, Verdict } from '../src/types.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

const STAGE: StageSpec = {
  question: 'Qual o prazo para trocar um produto?',
  productContext: 'Trocas em até 30 dias com nota fiscal.',
  maxTokens: 200,
  reference: 'Trinta dias a partir do recebimento, com nota fiscal.',
};

const STAGE_COM_RUBRICA_DE_FORMA: StageSpec = {
  ...STAGE,
  rubric: 'Resposta em linguagem formal, com estilo conciso e sem gírias.',
};

const STAGE_COM_RUBRICA_DE_CONTEUDO: StageSpec = {
  ...STAGE,
  rubric: 'Informar o prazo de 30 dias e a exigência de nota fiscal.',
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

/** Réplica do juiz com `confianca` (o contrato IMPL-047) + canário do pedido. */
const replyComConfianca = (
  req: { user: string },
  verdict: Verdict,
  confianca: string,
  explanation = 'confere',
): string => JSON.stringify({ canario: canaryOf(req), explanation, verdict, confianca });

describe('IMPL-047 — contrato do prompt pointwise (snapshot)', () => {
  it('a referência é CANDIDATA e PODE ESTAR ERRADA — nunca "(correta)"', () => {
    expect(JUDGE_CONTRACT_TEXT).toContain('A RESPOSTA DE REFERÊNCIA é CANDIDATA');
    expect(JUDGE_CONTRACT_TEXT).toContain('PODE ESTAR ERRADA');
    expect(JUDGE_CONTRACT_TEXT).not.toContain('(correta)');
  });

  it('a rubrica tem PRIORIDADE: se a referência contrariar a rubrica, siga a rubrica', () => {
    expect(JUDGE_CONTRACT_TEXT).toContain('se a referência contrariar a rubrica, SIGA A RUBRICA');
  });

  it('o JSON pedido inclui "confianca" (baixa/media/alta) e o schema a exige', () => {
    expect(JUDGE_CONTRACT_TEXT).toContain('"confianca": "baixa"|"media"|"alta"');
    const props = REFERENCE_JUDGE_SCHEMA.properties as Record<string, { enum?: string[] }>;
    expect(props.confianca.enum).toEqual(['baixa', 'media', 'alta']);
    expect(REFERENCE_JUDGE_SCHEMA.required).toContain('confianca');
  });

  it('"ignore redação/estilo" saiu do contrato fixo — virou regra condicionada à rubrica', () => {
    expect(JUDGE_CONTRACT_TEXT).not.toContain('Ignore redação/estilo');
  });
});

describe('IMPL-047 — pedido do veredito pointwise', () => {
  it('o bloco da referência diz que ela é candidata; a rubrica entra com prioridade', () => {
    const p = buildReferenceJudgePrompt(STAGE_COM_RUBRICA_DE_CONTEUDO, STAGE.reference!, 'Resposta candidata.');
    expect(p.user).toContain('REFERÊNCIA (resposta CANDIDATA de outro modelo — pode estar errada):');
    expect(p.user).toContain('CRITÉRIO DE CORRETUDE DESTA ETAPA (tem prioridade):');
    expect(p.user).toContain('se a referência contrariar a rubrica, siga a rubrica');
    expect(p.user).toContain('"confianca"');
    expect(p.user).not.toContain('REFERÊNCIA (resposta correta):');
  });

  it('sem critério de forma na rubrica (ou sem rubrica) => "ignore redação/estilo" vale', () => {
    const semRubrica = buildReferenceJudgePrompt(STAGE, STAGE.reference!, 'Candidato.');
    const rubricaConteudo = buildReferenceJudgePrompt(
      STAGE_COM_RUBRICA_DE_CONTEUDO,
      STAGE.reference!,
      'Candidato.',
    );
    expect(semRubrica.user).toContain('Ignore redação/estilo');
    expect(rubricaConteudo.user).toContain('Ignore redação/estilo');
  });

  it('com critério de forma na rubrica => a instrução ampla SUME e a forma conta', () => {
    const p = buildReferenceJudgePrompt(STAGE_COM_RUBRICA_DE_FORMA, STAGE.reference!, 'Candidato.');
    expect(p.user).not.toContain('Ignore redação/estilo');
    expect(p.user).toContain('a forma TAMBÉM conta');
  });

  it('rubricHasStyleCriterion: heurística de critério de forma (pt-BR)', () => {
    expect(rubricHasStyleCriterion(undefined)).toBe(false);
    expect(rubricHasStyleCriterion('Prazo de 30 dias com nota fiscal.')).toBe(false);
    expect(rubricHasStyleCriterion('Redação formal e clara.')).toBe(true);
    expect(rubricHasStyleCriterion('Formato de lista com palavras-chave.')).toBe(true);
    expect(rubricHasStyleCriterion('Resposta concisa, no máximo 50 palavras.')).toBe(true);
  });
});

describe('IMPL-047 — parse e persistência da confianca', () => {
  it('parse devolve a confianca declarada; omissão é aceita (defensivo) e valor fora do enum invalida', () => {
    const ok = parseJudgeReply(
      JSON.stringify({ canario: 'abc123', explanation: 'ok', verdict: 'resolve', confianca: 'baixa' }),
      'abc123',
    );
    expect(ok).toMatchObject({ verdict: 'resolve', confianca: 'baixa' });

    const semConfianca = parseJudgeReply(
      JSON.stringify({ canario: 'abc123', explanation: 'ok', verdict: 'parcial' }),
      'abc123',
    );
    expect(semConfianca).toMatchObject({ verdict: 'parcial' });
    expect(semConfianca?.confianca).toBeUndefined();

    const foraDoEnum = parseJudgeReply(
      JSON.stringify({ canario: 'abc123', explanation: 'ok', verdict: 'resolve', confianca: 'muita' }),
      'abc123',
    );
    expect(foraDoEnum).toBeNull();
  });

  it('judgeStageReference persiste a confianca por veredito (menor entre os votos)', async () => {
    const fake = fakeOpenRouter({
      chat: (req) =>
        req.model === 'fake/j1'
          ? { text: replyComConfianca(req, 'resolve', 'alta'), finishReason: 'stop' }
          : { text: replyComConfianca(req, 'resolve', 'baixa'), finishReason: 'stop' },
    });
    const r = await comGateway(fake.fetch, () =>
      judgeStageReference({
        stage: STAGE,
        responses: [resp('a', 'Trinta dias, com nota.')],
        contestants: [cont('a')],
        judgeModelIds: ['fake/j1', 'fake/j2'],
        apiKey: KEY,
        timeoutMs: 2_000,
      }),
    );
    expect(r.verdictByContestant.a).toBe('resolve');
    // Painel: 'alta' e 'baixa' => a triagem herda o MENOR (lado inseguro).
    expect(r.confidenceByContestant?.a).toBe('baixa');
  });

  it('voto único: a confianca declarada vai para o record; sem campo => sem chave', async () => {
    const fake = fakeOpenRouter({
      chat: (req) => ({ text: replyComConfianca(req, 'parcial', 'media', 'faltou parte'), finishReason: 'stop' }),
    });
    const r = await comGateway(fake.fetch, () =>
      judgeStageReference({
        stage: STAGE,
        responses: [resp('a', 'Resposta parcial.'), resp('b', 'Outra parcial.')],
        contestants: [cont('a'), cont('b')],
        judgeModelIds: ['fake/judge'],
        apiKey: KEY,
        timeoutMs: 2_000,
      }),
    );
    expect(r.confidenceByContestant?.a).toBe('media');
    // Garantia de propagação: o candidato B responde SEM confianca (defensivo)
    // e o record não inventa o campo.
    const fake2 = fakeOpenRouter({
      chat: (req) =>
        candidateOf(req) === 'Resposta A.'
          ? { text: replyComConfianca(req, 'resolve', 'alta'), finishReason: 'stop' }
          : { text: JSON.stringify({ canario: canaryOf(req), explanation: 'ok', verdict: 'nao' }), finishReason: 'stop' },
    });
    const r2 = await comGateway(fake2.fetch, () =>
      judgeStageReference({
        stage: STAGE,
        responses: [resp('a', 'Resposta A.'), resp('b', 'Resposta B.')],
        contestants: [cont('a'), cont('b')],
        judgeModelIds: ['fake/judge'],
        apiKey: KEY,
        timeoutMs: 2_000,
      }),
    );
    expect(r2.confidenceByContestant?.a).toBe('alta');
    expect(r2.confidenceByContestant?.b).toBeUndefined();
  });
});
