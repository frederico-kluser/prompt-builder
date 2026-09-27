// IMPL-047 (R-03a:REC-7) — prompt HONESTO do juiz de DUELO + `confianca` por ordem.
//
// Contratos provados aqui (transporte FALSO, zero rede, zero gasto):
//  (i)   a referência é CANDIDATA ("pode estar errada") — nunca "(correta)";
//  (ii)  a rubrica tem PRIORIDADE sobre a referência no duelo também;
//  (iii) "ignore redação/estilo e tamanho" é CONDICIONAL à rubrica;
//  (iv)  `confianca` entra no JSON do duelo e é PERSISTIDA por ordem (cada
//        ordem é um veredito) nos DOIS runtimes (Node e SPA — espelho).
// ⚠️ Snapshots do contrato: mudar o DUEL_HEAD muda o hash do juiz (IMPL-049).

import { describe, expect, it } from 'vitest';
import { createGateway, setDefaultGateway, type FetchLike } from '../src/openrouter.js';
import {
  buildDuelPrompt,
  DUEL_HEAD,
  DUEL_SCHEMA,
  parseDuelVerdict,
} from '../src/engine/duelPrompt.js';
import { runStageDuels as runDuelsNode } from '../src/duels.js';
import { runStageDuels as runDuelsWeb } from '../web/src/engine/duels.js';
import { canaryOf } from './judgeReplies.js';
import { fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import type { CompetitorResponse, Contestant, StageDuels, StageSpec } from '../src/types.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

const STAGE: StageSpec = {
  question: 'Qual o prazo para trocar um produto?',
  productContext: 'Trocas em até 30 dias com nota fiscal.',
  maxTokens: 200,
  reference: 'Trinta dias a partir do recebimento, com nota fiscal.',
};

const STAGE_COM_RUBRICA_DE_FORMA: StageSpec = {
  ...STAGE,
  rubric: 'Resposta em linguagem formal, com estilo conciso.',
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

/** Réplica de duelo com `confianca` (contrato IMPL-047) + canário do pedido. */
const duelReplyComConfianca = (
  req: { user: string },
  winner: 'A' | 'B' | 'tie',
  confianca: string,
  explanation = 'A mais completa',
): string => JSON.stringify({ canario: canaryOf(req), explanation, winner, confianca });

describe('IMPL-047 — contrato do prompt de duelo (snapshot)', () => {
  it('a referência é CANDIDATA e PODE ESTAR ERRADA — nunca "(correta)"', () => {
    expect(DUEL_HEAD).toContain('A RESPOSTA DE REFERÊNCIA é CANDIDATA');
    expect(DUEL_HEAD).toContain('PODE ESTAR ERRADA');
    expect(DUEL_HEAD).not.toContain('(correta)');
    expect(DUEL_HEAD).not.toContain('ignore redação, estilo e tamanho');
  });

  it('a rubrica tem prioridade e o JSON pede "confianca" (baixa/media/alta)', () => {
    expect(DUEL_HEAD).toContain('se a referência contrariar a rubrica, SIGA A RUBRICA');
    expect(DUEL_HEAD).toContain('"confianca": "baixa"|"media"|"alta"');
    const props = DUEL_SCHEMA.properties as Record<string, { enum?: string[] }>;
    expect(props.confianca.enum).toEqual(['baixa', 'media', 'alta']);
    expect(DUEL_SCHEMA.required).toContain('confianca');
  });
});

describe('IMPL-047 — pedido do veredito de duelo', () => {
  it('bloco da referência candidata + rubrica com prioridade + regra de confianca', () => {
    const p = buildDuelPrompt(STAGE, STAGE.reference!, 'Texto A', 'Texto B');
    expect(p.user).toContain('REFERÊNCIA (resposta CANDIDATA de outro modelo — pode estar errada):');
    expect(p.user).toContain('A REFERÊNCIA é candidata e pode estar errada');
    expect(p.user).toContain('se a referência contrariar a rubrica, siga a rubrica');
    expect(p.user).toContain('"confianca"');
    expect(p.user).not.toContain('REFERÊNCIA (resposta correta):');
  });

  it('"ignore redação/estilo" condicionado: vale sem critério de forma; some quando a rubrica exige forma', () => {
    const semForma = buildDuelPrompt(STAGE, STAGE.reference!, 'A', 'B');
    expect(semForma.user).toContain('Ignore redação/estilo');
    const comForma = buildDuelPrompt(STAGE_COM_RUBRICA_DE_FORMA, STAGE.reference!, 'A', 'B');
    expect(comForma.user).not.toContain('Ignore redação/estilo');
    expect(comForma.user).toContain('a forma TAMBÉM conta');
    expect(comForma.user).toContain('critério de corretude — tem prioridade');
  });

  it('parseDuelVerdict devolve a confianca; omissão é aceita e valor fora do enum invalida', () => {
    const ok = parseDuelVerdict(
      JSON.stringify({ canario: 'abc123', explanation: 'x', winner: 'A', confianca: 'alta' }),
      'abc123',
    );
    expect(ok).toMatchObject({ winner: 'A', confianca: 'alta' });

    const semConfianca = parseDuelVerdict(
      JSON.stringify({ canario: 'abc123', explanation: 'x', winner: 'tie' }),
      'abc123',
    );
    expect(semConfianca).toMatchObject({ winner: 'tie' });
    expect(semConfianca?.confianca).toBeUndefined();

    const foraDoEnum = parseDuelVerdict(
      JSON.stringify({ canario: 'abc123', explanation: 'x', winner: 'B', confianca: 'segura' }),
      'abc123',
    );
    expect(foraDoEnum).toBeNull();
  });
});

describe('IMPL-047 — runStageDuels persiste confianca por ordem (Node e SPA)', () => {
  const conferir = (d: StageDuels): void => {
    expect(d.duels).toHaveLength(1);
    const duelo = d.duels[0];
    // Cada ordem persiste a SUA confianca (a ordem de apresentação do par é
    // cega/determinística, então o que se garante é o PAR de valores).
    expect([duelo.order1.confidence, duelo.order2.confidence].sort()).toEqual(['baixa', 'media']);
    expect(duelo.order1.canary).toBeTruthy();
    expect(duelo.order2.canary).toBeTruthy();
    expect(duelo.outcome).toBe('tie'); // o portador de RESPOSTA-A vence a sua ordem => desacordo => sem viés de posição
  };

  it('Node (src/duels.ts)', async () => {
    const fake = fakeOpenRouter({
      chat: (req) =>
        // A vence sempre que é o portador de RESPOSTA-A: na ordem 1 (a primeiro)
        // isso premia 'a'; na ordem 2 (b primeiro) premia 'b' => desacordo => tie.
        req.user.includes('CANDIDATO A') && req.user.indexOf('RESPOSTA-A') < req.user.indexOf('RESPOSTA-B')
          ? { text: duelReplyComConfianca(req, 'A', 'media'), finishReason: 'stop' }
          : { text: duelReplyComConfianca(req, 'A', 'baixa'), finishReason: 'stop' },
    });
    const d = await comGateway(fake.fetch, () =>
      runDuelsNode({
        stage: STAGE,
        responses: [resp('a', 'RESPOSTA-A'), resp('b', 'RESPOSTA-B')],
        contestants: [cont('a'), cont('b')],
        judgeModelId: 'fake/judge',
        topK: 0,
        apiKey: KEY,
        timeoutMs: 2_000,
      }),
    );
    conferir(d);
  });

  it('SPA (web/src/engine/duels.ts) — espelho', async () => {
    const fake = fakeOpenRouter({
      chat: (req) =>
        req.user.includes('CANDIDATO A') && req.user.indexOf('RESPOSTA-A') < req.user.indexOf('RESPOSTA-B')
          ? { text: duelReplyComConfianca(req, 'A', 'media'), finishReason: 'stop' }
          : { text: duelReplyComConfianca(req, 'A', 'baixa'), finishReason: 'stop' },
    });
    const d = await comGateway(fake.fetch, () =>
      runDuelsWeb({
        stage: STAGE,
        responses: [resp('a', 'RESPOSTA-A'), resp('b', 'RESPOSTA-B')],
        contestants: [cont('a'), cont('b')],
        judgeModelId: 'fake/judge',
        topK: 0,
        apiKey: KEY,
        timeoutMs: 2_000,
      }),
    );
    conferir(d);
  });
});
