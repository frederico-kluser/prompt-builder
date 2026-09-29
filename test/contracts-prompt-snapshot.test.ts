// IMPL-070 (R-20:REC-8/M-120) — prompts embutidos com REGRESSÃO e com HASH.
//
// Os meta-prompts do reescritor, da reflexão e do datagen mudavam sem rastro:
// só o prompt do juiz entrava no hash de contrato da run, então editar um
// meta-prompt mudava o comportamento de TODAS as sessões seguintes sem ninguém
// perceber — duas sessões de treino com meta-prompts diferentes ficavam
// comparáveis por acaso.
//
// O que este arquivo prova (critérios 2 e 4 do item, recorte da fronteira
// `engine/contracts.ts` + `variator.ts`):
//   2) o SNAPSHOT/fingerprint do contrato muda com o texto dos prompts de
//      REESCRITOR, REFLEXÃO e DATAGEN (cada um isoladamente);
//   4) testes de SNAPSHOT das mensagens montadas POR PAPEL — a montagem é
//      ancorada em hash; qualquer mudança de montagem falha o teste até o
//      snapshot ser atualizado de propósito (é o exigido pela R-05:REC-3).
//
// O que NÃO está aqui (fora da fronteira deste lote): o comando
// `pbuilder prompts regression` (120 casos fixos, métricas/limiares, exit ≠ 0
// abaixo dos limiares, custo ≤ US$2 por rodada) e o dobramento destes hashes no
// `pinJudgeContract` (judgeCalibration.ts + JudgeContractComponents em types.ts
// ×3 + orchestrator.ts) — os exports/fingerprint prontos entram lá com UMA
// chamada quando esses arquivos forem tocados por quem os possui.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGateway, setDefaultGateway, type ChatMessage } from '../src/openrouter.js';
import { canonicalJson, sha256Hex } from '../src/engine/hash.js';
import { metaPromptsFingerprint } from '../src/engine/contracts.js';
import { setJudgeRandomSource } from '../src/engine/judgeGuard.js';
import {
  generateContestants,
  llmReflectLessons,
  metaPromptTexts,
  REWRITER_PAYLOAD_VERSION,
  REWRITER_SYSTEM_PROMPT,
  REFLECT_SYSTEM_PROMPT,
  BASE_GENERATION_SYSTEM_PROMPT,
} from '../src/variator.js';
import { buildBatchMessages, generateStage, generateStages } from '../src/datagen.js';
import { generateReferences } from '../src/gabarito.js';
import { judgeStageReference } from '../src/refJudge.js';
import { judgeStage } from '../src/judge.js';
import { runStageDuels } from '../src/duels.js';
import type { CompetitorResponse, Contestant, StageSpec } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeChatReply, type FakeRequest } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const M = 'fake/modelo';

const STAGE: StageSpec = {
  question: 'Qual o prazo de troca?',
  productContext: 'Loja X. Trocas em 30 dias com nota fiscal.',
  maxTokens: 300,
  rubric: 'Diz 30 dias e exige nota.',
  reference: 'O prazo de troca é de 30 dias, com nota fiscal.',
};
const CONTESTANTS: Contestant[] = [
  { id: 'a', label: 'A', modelId: M },
  { id: 'b', label: 'B', modelId: M },
];
const resposta = (id: string, text: string): CompetitorResponse => ({
  contestantId: id,
  modelId: M,
  text,
  latencyMs: 1,
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
  status: 'ok',
});
const RESPOSTAS = [resposta('a', 'São 30 dias com nota.'), resposta('b', 'Não sei.')];

// ---------------------------------------------------------------------------
// Captura das mensagens MONTADAS por papel (o corpo exato que vai ao gateway).
// Cada papel roda no seu próprio transporte falso; o snapshot é o hash canônico
// (JCS + SHA-256) das mensagens — se a montagem mudar, o hash muda e o teste
// falha até alguém atualizar o snapshot de propósito (R-05:REC-3).
// ---------------------------------------------------------------------------

type ChatHandler = (req: FakeRequest, n: number) => FakeChatReply | Response | Promise<FakeChatReply | Response>;

const hashMensagens = (mensagens: unknown): string => sha256Hex(canonicalJson(mensagens));

async function mensagensDoPapel(
  papel: string,
  rodar: () => Promise<unknown>,
  chat: ChatHandler = () => ({ text: 'ok' }),
): Promise<ChatMessage[][]> {
  const fake = fakeOpenRouter({ catalog: [catalogItem(M, 1e-6, 1e-6)], chat });
  const prev = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
  try {
    await rodar().catch(() => undefined); // resposta inválida não interessa: o snapshot é do PEDIDO
  } finally {
    if (prev) setDefaultGateway(prev);
  }
  const mensagens = fake.requests
    .filter((r) => r.path.endsWith('/chat/completions'))
    .map((r) => ((r.body?.messages ?? []) as ChatMessage[]));
  expect(mensagens.length, `papel ${papel}: pelo menos uma chamada`).toBeGreaterThan(0);
  return mensagens;
}

beforeEach(() => {
  // Marcador/canário do juiz determinístico (senão o snapshot varia por run).
  // ⚠️ Fonte SEQUENCIAL, nunca constante: o `while (canary === nonce)` do
  // judgeGuard não termina com uma fonte que devolve sempre o mesmo número.
  setJudgeRandomSource(mulberry32(1337));
});

afterEach(() => {
  setJudgeRandomSource(undefined);
});

/** PRNG semeado (mesma família do mulberry32 do duelCore): determinístico e variado. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('IMPL-070 c4 — snapshot das mensagens montadas por papel (R-05:REC-3)', () => {
  it('reescritor — 1ª tentativa: payload versionado com modelo-alvo, técnica e base', async () => {
    const [msgs] = await mensagensDoPapel('reescritor/1a', () =>
      generateContestants({
        apiKey: KEY,
        modelId: M,
        theme: 'suporte a clientes',
        basePrompt: 'Voce e um atendente da loja Aurora. Responda sempre em portugues.',
        includeOriginal: false,
        techniqueIds: ['persona'],
        promptOptimization: true,
        optimizerModelId: M,
        contestantReasoningLevel: 'medium',
      }),
    );
    // Âncoras estruturais do contrato do payload (falham junto do hash se a
    // montagem mudar de propósito).
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    expect(msgs[0].content).toBe(REWRITER_SYSTEM_PROMPT);
    expect(msgs[1].content).toContain(`<payload_reescritor versao="${REWRITER_PAYLOAD_VERSION}">`);
    expect(msgs[1].content).toContain('<modelo_alvo>');
    expect(msgs[1].content).toContain('<tecnica id="persona"');
    expect(msgs[1].content).toContain('<prompt_base>');
    // Snapshot: hash canônico das mensagens do papel.
    expect(hashMensagens(msgs)).toMatchInlineSnapshot(`"272398d49e50bd8b6dab76a3321bc0946d4de1bd7dd34c9ea14c1dad672b7b1d"`);
  });

  it('reescritor — correção (2ª chamada): a reescrita reprovada volta como assistant', async () => {
    // 1ª resposta viola a invariante (sai a frase inteira) → 1 correção; a 2ª
    // devolve o base intacto e passa.
    const INV = 'Responda sempre em portugues';
    const BASE = `Voce e um atendente da loja Aurora. ${INV}. Nunca invente precos e cite prazos quando souber deles.`;
    const REESCRITA_BOA = `${BASE} Seja cordial e objetivo em cada resposta.`;
    const msgs = await mensagensDoPapel(
      'reescritor/correcao',
      () =>
        generateContestants({
          apiKey: KEY,
          modelId: M,
          theme: 'suporte',
          basePrompt: BASE,
          includeOriginal: false,
          techniqueIds: ['persona'],
          promptOptimization: true,
          optimizerModelId: M,
          contracts: { neverBreak: [INV], judgeDiff: false },
        }),
      (req, n) => ({ text: n === 0 ? 'Voce e um atendente cordial e objetivo da loja Aurora em tudo.' : REESCRITA_BOA }),
    );
    expect(msgs).toHaveLength(2);
    const [correcao] = [msgs[1]];
    expect(correcao.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(correcao[3].content).toContain('violou o contrato');
    expect(hashMensagens(correcao)).toMatchInlineSnapshot(`"a56048cf8106db15a7e1d26ea5a958893f8fbde51787d2d86e0c01a3a476af64"`);
  });

  it('reflexão (GEPA por LLM): sistema fixo + dossiê de fraquezas no user', async () => {
    const [msgs] = await mensagensDoPapel('reflexao', () =>
      llmReflectLessons({ apiKey: KEY, modelId: M, baseLessons: '- errou prazos em 2 casos', theme: 'suporte' }),
    );
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    expect(msgs[0].content).toBe(REFLECT_SYSTEM_PROMPT);
    expect(msgs[1].content).toContain('FRAQUEZAS OBSERVADAS');
    expect(hashMensagens(msgs)).toMatchInlineSnapshot(`"3136f8d2023c5c47efd442820a0102d198e9996d9cf4c81d2afca3e1f7e709cd"`);
  });

  it('datagen — etapa unitária e lote: montagem única (buildBatchMessages)', async () => {
    const etapa = await mensagensDoPapel('datagen-etapa', () =>
      generateStage({ apiKey: KEY, theme: 'suporte', stageIndex: 0, totalStages: 1, modelId: M }),
    );
    const lote = await mensagensDoPapel('datagen-lote', () =>
      generateStages({ apiKey: KEY, theme: 'suporte', count: 1, modelId: M }),
    );
    // Snapshots: hash canônico por papel. (Uma assert por LINHA — o snapshot
    // inline é localizado pela linha de origem; dois no mesmo laço colidem.)
    expect(hashMensagens(etapa), 'datagen-etapa').toMatchInlineSnapshot(`"b00016e7a81736b455077a0af73effef10d11b5841a416dfd92664b2c7a6d983"`);
    expect(hashMensagens(lote), 'datagen-lote').toMatchInlineSnapshot(`"6d74e3bf5a15a70ce06bb0443748662834155012974f75d624bbe0465fe38fdc"`);
    for (const [nome, msgs] of [
      ['datagen-etapa', etapa],
      ['datagen-lote', lote],
    ] as const) {
      expect(msgs[0].map((m) => m.role), nome).toContain('system');
    }
    // A montagem do lote é a MESMA função exportada (IMPL-008): se o papel
    // enviar algo diferente, o snapshot do papel cai em relação a esta aqui.
    const montada = buildBatchMessages({
      theme: 'suporte',
      count: 1,
      excludePrompts: [],
      languages: ['pt-BR'],
    });
    expect(montada[0].role).toBe('system');
  });

  it('gabarito (referência) e juízes: pointwise, listwise e duelo', async () => {
    const semRef: StageSpec = { ...STAGE, reference: undefined };
    const gabarito = await mensagensDoPapel('gabarito', () =>
      generateReferences({ stages: [semRef], apiKey: KEY, modelId: M }),
    );
    const pointwise = await mensagensDoPapel('juiz-pointwise', () =>
      judgeStageReference({ stage: STAGE, responses: RESPOSTAS, contestants: CONTESTANTS, judgeModelIds: [M], apiKey: KEY }),
    );
    const listwise = await mensagensDoPapel('juiz-listwise', () =>
      judgeStage({ apiKey: KEY, stage: STAGE, responses: RESPOSTAS, judgeModelIds: [M] }),
    );
    const duelo = await mensagensDoPapel('duelo', () =>
      runStageDuels({
        stage: STAGE,
        responses: RESPOSTAS,
        contestants: CONTESTANTS,
        judgeModelId: M,
        topK: 0,
        apiKey: KEY,
      }),
    );
    // Snapshots por papel (uma assert por LINHA — ver nota acima).
    expect(hashMensagens(gabarito), 'gabarito').toMatchInlineSnapshot(`"5bdd39db8a98bae7f0bbdcfd118c99441cedef13969e7efb16abfed12e89d75d"`);
    expect(hashMensagens(pointwise), 'juiz-pointwise').toMatchInlineSnapshot(`"d49cc50ef3c5168653259b249eaef28e175c4f18db883348f18fff1eef8e0b58"`);
    expect(hashMensagens(listwise), 'juiz-listwise').toMatchInlineSnapshot(`"cacd6b29807d68a8251c4b313df8787f2938c91308f2a44e6e600012267a0807"`);
    expect(hashMensagens(duelo), 'duelo').toMatchInlineSnapshot(`"4a4a00ad14344e0cef1053b8e3c9fb23a7f67d56a9f82a36dbf7b0014d562066"`);
    for (const [nome, msgs] of [
      ['gabarito', gabarito],
      ['juiz-pointwise', pointwise],
      ['juiz-listwise', listwise],
      ['duelo', duelo],
    ] as const) {
      expect(msgs.length, nome).toBeGreaterThan(0);
    }
  });

  it('a montagem é DETERMINÍSTICA (mesmo papel, mesma entrada ⇒ mesmo hash)', async () => {
    const rodar = (): Promise<unknown> =>
      llmReflectLessons({ apiKey: KEY, modelId: M, baseLessons: '- errou prazos', theme: 'suporte' });
    const a = await mensagensDoPapel('reflexao', rodar);
    const b = await mensagensDoPapel('reflexao', rodar);
    expect(hashMensagens(a)).toBe(hashMensagens(b));
  });
});

// ---------------------------------------------------------------------------
// Critério 2 — o fingerprint do contrato muda com o TEXTO dos meta-prompts
// ---------------------------------------------------------------------------

describe('IMPL-070 c2 — snapshot/fingerprint prova sensibilidade ao texto (reescritor, reflexão, datagen)', () => {
  const DATAGEN_TEXT = buildBatchMessages({ theme: 'suporte', count: 1, excludePrompts: [] })[0].content;

  const contrato = (sobrescrever: Partial<Record<'rewriter' | 'reflection' | 'datagen', string>> = {}) =>
    metaPromptsFingerprint({
      'rewriter/system': sobrescrever.rewriter ?? REWRITER_SYSTEM_PROMPT,
      'reflection/system': sobrescrever.reflection ?? REFLECT_SYSTEM_PROMPT,
      'datagen/system': sobrescrever.datagen ?? DATAGEN_TEXT,
    });

  it('o fingerprint é estável, determinístico e em SHA-256 (64 hex)', () => {
    expect(contrato()).toBe(contrato());
    expect(contrato()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mudar o TEXTO do prompt de reescritor, reflexão ou datagen muda o hash', () => {
    const base = contrato();
    // Cada prompt isoladamente: trocar o texto tem de mudar o contrato.
    for (const papel of ['rewriter', 'reflection', 'datagen'] as const) {
      const alterado = contrato({ [papel]: `texto novo do prompt ${papel}` });
      expect(alterado, `prompt do ${papel} tem de entrar no hash`).not.toBe(base);
    }
  });

  it('a ordem das chaves não muda o hash (o mapa é canônico)', () => {
    const a = metaPromptsFingerprint({ z: 'b', a: 'c' });
    const b = metaPromptsFingerprint({ a: 'c', z: 'b' });
    expect(a).toBe(b);
  });

  it('metaPromptTexts() cobre reescritor, geração de base, reflexão e técnicas', () => {
    const textos = metaPromptTexts();
    expect(textos['rewriter/system']).toBe(REWRITER_SYSTEM_PROMPT);
    expect(textos['rewriter/generate-base']).toBe(BASE_GENERATION_SYSTEM_PROMPT);
    expect(textos['reflection/system']).toBe(REFLECT_SYSTEM_PROMPT);
    expect(textos['techniques/meta-instructions']).toContain('cot');
    // Fingerprint do otimizador inteiro: estável e sensível a QUALQUER texto.
    const fp = metaPromptsFingerprint(textos);
    expect(fp).toBe(metaPromptsFingerprint(textos));
    expect(metaPromptsFingerprint({ ...textos, 'rewriter/system': `${REWRITER_SYSTEM_PROMPT}!` })).not.toBe(fp);
    expect(metaPromptsFingerprint({ ...textos, 'reflection/system': `${REFLECT_SYSTEM_PROMPT}!` })).not.toBe(fp);
    expect(
      metaPromptsFingerprint({ ...textos, 'techniques/meta-instructions': `${textos['techniques/meta-instructions']}!` }),
    ).not.toBe(fp);
  });
});