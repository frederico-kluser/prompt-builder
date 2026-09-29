// IMPL-059 (R-05:REC-2) — TODO papel que lê o caso recebe o MESMO input do
// caso, byte a byte: o competidor, o gabarito (e o verificador do gabarito), o
// juiz pointwise, o listwise e o duelo. Antes o pointwise e o duelo nem viam o
// productContext (o juiz comparava o candidato com uma referência escrita COM o
// contexto — penalidade por informação privilegiada) e o gabarito o recebia
// como SYSTEM.
//
// Os corpos são os REAIS enviados ao gateway (transporte falso). Critérios:
//  1) igualdade byte a byte do caso entre gabarito, refJudge, listwise e duelo
//     (e o verificador), salvo as instruções de papel;
//  2) papéis fora de paridade = 0 (tabela abaixo cobre todos);
//  3) nenhum papel de juízo/referência recebe o system prompt do candidato.

import { afterEach, describe, expect, it } from 'vitest';
import { createGateway, setDefaultGateway } from '../src/openrouter.js';
import { runCompetitor } from '../src/competitor.js';
import { generateReferences, verifyReferenceAgainstRubric, GABARITO_ROLE_PROMPT } from '../src/gabarito.js';
import { judgeStageReference } from '../src/refJudge.js';
import { judgeStage } from '../src/judge.js';
import { runStageDuels } from '../src/duels.js';
import { runStageDuels as runStageDuelsWeb } from '../web/src/engine/duels.js';
import { caseParts, renderCaseInput } from '../src/engine/caseInput.js';
import { readMarkedBlock } from '../src/engine/judgeGuard.js';
import type { CompetitorResponse, Contestant, StageSpec } from '../src/types.js';
import { fakeOpenRouter, noSleep, type FakeRequest } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const VARIANTE = 'SYSTEM-DO-CANDIDATO: responda em tom pirata.';

const STAGE: StageSpec = {
  question: '  Posso trocar um tenis depois de 20 dias?  ',
  productContext: 'Politica de trocas: 30 dias corridos a partir do recebimento, com nota fiscal.',
  maxTokens: 200,
  rubric: 'Deve dizer que sim, dentro de 30 dias, com nota fiscal.',
  reference: 'Sim — o prazo é de 30 dias corridos, com nota fiscal.',
};

const RESPOSTAS: CompetitorResponse[] = ['a', 'b'].map((id) => ({
  contestantId: id,
  modelId: `fake/${id}`,
  text: `Resposta de ${id}`,
  latencyMs: 1,
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
  status: 'ok',
}));
const CONTESTANTS: Contestant[] = [
  { id: 'a', label: 'A', modelId: 'fake/a', systemPrompt: VARIANTE, isOriginal: true },
  { id: 'b', label: 'B', modelId: 'fake/b', systemPrompt: VARIANTE },
];

let anterior: ReturnType<typeof setDefaultGateway> | undefined;
afterEach(() => {
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
});

async function capturar(fn: () => Promise<unknown>): Promise<FakeRequest[]> {
  const fake = fakeOpenRouter({ chat: () => ({ text: '' }) });
  anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
  await fn();
  return fake.chatRequests();
}

/** O caso lido dos blocos marcados de um juiz: contexto + linha em branco + pergunta. */
function casoDoJuiz(user: string): string {
  const ctx = readMarkedBlock(user, 'CONTEXTO');
  const q = readMarkedBlock(user, 'PERGUNTA');
  expect(q, 'bloco PERGUNTA').toBeDefined();
  return ctx ? `${ctx}\n\n${q}` : q!;
}

describe('IMPL-059 — o caso é byte a byte o mesmo em todos os papéis', () => {
  it('paridade por papel (competidor = referência do byte a byte)', async () => {
    const [competidor] = await capturar(() =>
      runCompetitor({ apiKey: KEY, contestantId: 'a', modelId: 'fake/a', systemPrompt: VARIANTE, stage: STAGE }),
    );
    const casoDoCompetidor = competidor.user;
    expect(casoDoCompetidor).toBe(renderCaseInput(STAGE));

    const [gabarito] = await capturar(() =>
      generateReferences({ stages: [{ ...STAGE, reference: undefined }], apiKey: KEY, modelId: 'fake/ref' }),
    );
    const pointwise = await capturar(() =>
      judgeStageReference({ stage: STAGE, responses: RESPOSTAS, contestants: CONTESTANTS, judgeModelIds: ['fake/j'], apiKey: KEY }),
    );
    const listwise = await capturar(() =>
      judgeStage({ apiKey: KEY, stage: STAGE, responses: RESPOSTAS, judgeModelIds: ['fake/j'] }),
    );
    const duelo = await capturar(() =>
      runStageDuels({ stage: STAGE, responses: RESPOSTAS, contestants: CONTESTANTS, judgeModelId: 'fake/j', topK: 0, apiKey: KEY }),
    );
    const dueloWeb = await capturar(() =>
      runStageDuelsWeb({ stage: STAGE, responses: RESPOSTAS, contestants: CONTESTANTS, judgeModelId: 'fake/j', topK: 0, apiKey: KEY }),
    );
    const [verificador] = await capturar(() =>
      verifyReferenceAgainstRubric({ apiKey: KEY, modelId: 'fake/v', stage: STAGE }),
    );

    // O caso do gabarito é o PREFIXO exato do user (as instruções de papel vêm depois).
    expect(gabarito.user.startsWith(`${casoDoCompetidor}\n\n`)).toBe(true);
    // O system do gabarito é SÓ a instrução de papel — o contexto não mora mais lá.
    expect(gabarito.system).toBe(GABARITO_ROLE_PROMPT);
    expect(gabarito.system).not.toContain(STAGE.productContext);

    const papeisDeJuizo: Array<[string, FakeRequest[]]> = [
      ['juiz-pointwise', pointwise],
      ['juiz-listwise', listwise],
      ['duelo', duelo],
      ['duelo (SPA)', dueloWeb],
      ['verificador-do-gabarito', [verificador]],
    ];
    const foraDeParidade: string[] = [];
    for (const [papel, reqs] of papeisDeJuizo) {
      expect(reqs.length, papel).toBeGreaterThan(0);
      for (const r of reqs) {
        if (casoDoJuiz(r.user) !== casoDoCompetidor) foraDeParidade.push(papel);
      }
    }
    if (!gabarito.user.startsWith(casoDoCompetidor)) foraDeParidade.push('gabarito');
    // Critério 2: nº de papéis fora de paridade = 0.
    expect([...new Set(foraDeParidade)]).toEqual([]);

    // Critério 3: nenhum papel de juízo/referência recebe o system do candidato.
    for (const r of [gabarito, verificador, ...pointwise, ...listwise, ...duelo, ...dueloWeb]) {
      expect(r.system + r.user).not.toContain(VARIANTE);
    }
  });

  it('sem productContext: nenhum papel ganha bloco de contexto vazio (como no competidor)', async () => {
    const semCtx: StageSpec = { ...STAGE, productContext: '' };
    expect(caseParts(semCtx).context).toBe('');
    const pointwise = await capturar(() =>
      judgeStageReference({ stage: semCtx, responses: RESPOSTAS, contestants: CONTESTANTS, judgeModelIds: ['fake/j'], apiKey: KEY }),
    );
    const listwise = await capturar(() =>
      judgeStage({ apiKey: KEY, stage: semCtx, responses: RESPOSTAS, judgeModelIds: ['fake/j'] }),
    );
    for (const r of [...pointwise, ...listwise]) {
      expect(readMarkedBlock(r.user, 'CONTEXTO')).toBeUndefined();
      expect(casoDoJuiz(r.user)).toBe(renderCaseInput(semCtx));
    }
  });
});
