// IMPL-067 (restante) — contaminação dados→prompt LIGADA nos 2 pontos.
//
// As primitivas existiam (contaminationCheck/assertNoContamination), mas
// nenhum caminho de produção as chamava: `sessions winner --apply` aplicava um
// campeão que colou cenário no prompt, e o pickWinner promovia sem medir.
// Contratos aqui:
//   (1) o que o prompt de BASE já trazia não conta (política do usuário ≠
//       dado colado pelo otimizador); paráfrase legítima não bloqueia;
//   (2) pickWinner com `contamination`: span exato ≥ 8 tokens segura a
//       promoção (`heldBy: ['contamination']`) e o containment vai no gate;
//       `contaminationInputFromRun` monta o corpus da run (cenários, gabaritos,
//       explicações do juiz) e os dois trainers o passam;
//   (3) handoff: `evaluateHandoffGuards` BLOQUEIA o campeão contaminado
//       (recomputado sobre os cenários pinados, ou marcado pelo treino) —
//       override justificado sobrepõe, como no holdout;
//   (4) PROCESSO REAL: `sessions winner --apply` sai com exit 10
//       (`handoff.contamination_blocked`) e o destino fica intocado.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contaminationCheck, contaminationCorpus } from '../src/engine/contracts.js';
import { contaminationInputFromRun, pickWinner, type RankEntry } from '../src/rank.js';
import { evaluateHandoffGuards, type HandoffGuardInput } from '../src/engine/handoffGuards.js';
import { EXIT } from '../src/cli/output.js';
import { applyFewShotDemos } from '../src/techniques.js';
import { nodeOrTsx } from './support/cli.js';

const CENARIO = {
  question: 'Comprei um liquidificador que chegou com a jarra rachada e quero saber como faço a troca',
  productContext: 'Política de trocas: produtos com defeito podem ser trocados em até 30 dias corridos do recebimento, com nota fiscal.',
  reference: 'A troca por defeito vale por 30 dias corridos a partir do recebimento, apresentando a nota fiscal.',
  rubric: 'Deve citar 30 dias corridos e a nota fiscal.',
};
const BASE = 'Você é o atendente de uma loja on-line. Responda com cordialidade e objetividade.';
// Span de 8+ tokens COLADO da pergunta do cenário.
const CONTAMINADO = `${BASE} Exemplo: quando o cliente disser que comprei um liquidificador que chegou com a jarra rachada e quero saber, oriente a troca.`;
// Paráfrase legítima: a mesma ideia, sem copiar o cenário.
const PARAFRASE = `${BASE} Quando um item chegar danificado, explique o passo a passo da troca conforme a política informada no contexto.`;

describe('IMPL-067 (1) — o que a base já trazia não é contaminação', () => {
  it('span colado bloqueia; paráfrase não; política que já estava na base não', () => {
    const corpus = contaminationCorpus([CENARIO]);
    expect(corpus).toHaveLength(4);
    expect(contaminationCheck(CONTAMINADO, corpus, { allowedTexts: [BASE] }).blocked).toBe(true);
    expect(contaminationCheck(PARAFRASE, corpus, { allowedTexts: [BASE] }).blocked).toBe(false);
    // A base do usuário cita a política do contexto; a variante a mantém: NÃO é contaminação.
    const baseComPolitica = `${BASE} ${CENARIO.productContext}`;
    const variante = `Atue com empatia e clareza. ${CENARIO.productContext}`;
    expect(contaminationCheck(variante, corpus).blocked).toBe(true);
    expect(contaminationCheck(variante, corpus, { allowedTexts: [baseComPolitica] }).blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (2) pickWinner
// ---------------------------------------------------------------------------

const entry = (id: string, judgeScore: number, isControl = false): RankEntry => ({
  id,
  label: id,
  isControl,
  judgeScore,
  errored: 0,
  promptLen: 100,
});

describe('IMPL-067 (2) — métrica/barreira no pickWinner', () => {
  const entries = [entry('original', 50, true), entry('v1', 90)];
  const contamination = (prompt: string) => ({
    promptById: { original: BASE, v1: prompt },
    protectedTexts: contaminationCorpus([CENARIO]),
    allowedTexts: [BASE],
  });

  it('campeã contaminada NÃO é promovida, mesmo com ganho grande', () => {
    const limpo = pickWinner(entries, { minGain: 1, contamination: contamination(PARAFRASE) });
    expect(limpo.isWinner).toBe(true);
    expect(limpo.contamination).toMatchObject({ blocked: false });
    expect(typeof limpo.contamination?.containment).toBe('number');

    const sujo = pickWinner(entries, { minGain: 1, contamination: contamination(CONTAMINADO) });
    expect(sujo.isWinner).toBe(false);
    expect(sujo.contamination).toMatchObject({ blocked: true });
  });

  it('com o gate da melhor de K: heldBy contamination e o containment no gate', () => {
    const scores = { original: [0, 0, 0, 0, 0, 0, 0, 0], v1: [1, 1, 1, 1, 1, 1, 1, 1] };
    const ok = pickWinner(entries, { scoresById: scores, contamination: contamination(PARAFRASE) });
    expect(ok.isWinner).toBe(true);
    expect(ok.gate?.contamination).toMatchObject({ blocked: false });
    const sujo = pickWinner(entries, { scoresById: scores, contamination: contamination(CONTAMINADO) });
    expect(sujo.isWinner).toBe(false);
    expect(sujo.gate).toMatchObject({ decision: 'held', heldBy: expect.arrayContaining(['contamination']) });
    expect(sujo.gate?.contamination?.blocked).toBe(true);
  });

  it('contaminationInputFromRun: corpus = cenários + explicações; régua/original permitidos', () => {
    const input = contaminationInputFromRun(
      {
        stages: [
          {
            spec: CENARIO,
            referenceJudge: { explanationByContestant: { v1: 'A resposta cita corretamente os trinta dias corridos e a nota.' } },
            judge: { judges: [{ verdicts: [{ motivo: 'Justificativa listwise do juiz para a etapa um.' }] }] },
          },
        ],
        contestants: [
          { id: 'original', systemPrompt: BASE, isOriginal: true },
          { id: 'v1', systemPrompt: 'COMPOSTO', promptFragment: PARAFRASE },
        ],
      },
      'original',
    );
    expect(input.promptById.v1).toBe(PARAFRASE);
    expect(input.protectedTexts).toEqual(
      expect.arrayContaining([CENARIO.question, CENARIO.reference, 'Justificativa listwise do juiz para a etapa um.']),
    );
    expect(input.allowedTexts).toContain(BASE);
  });

  it('os DOIS trainers passam o corpus da run de seleção ao pickWinner', () => {
    const ROOT = fileURLToPath(new URL('..', import.meta.url));
    for (const rel of ['src/trainer.ts', 'web/src/engine/trainer.ts']) {
      const fonte = readFileSync(path.join(ROOT, rel), 'utf8');
      expect(fonte, rel).toMatch(/contamination:\s*contaminationInputFromRun\(selRun, controlId\)/);
    }
  });
});

// ---------------------------------------------------------------------------
// (3) handoff (puro)
// ---------------------------------------------------------------------------

function sessaoInput(campeao: string, extra: Partial<HandoffGuardInput> = {}): HandoffGuardInput {
  return {
    status: 'finished',
    holdout: { n: 6, controlScore: 60, championScore: 72, gain: 12, regressed: false },
    significance: { n: 6, meanDiffPp: 12, ci95Pp: [4, 20], pValue: 0.01 },
    bestPromptByIteration: [{ systemPrompt: campeao }],
    pinnedStages: [CENARIO],
    config: { basePrompt: BASE },
    ...extra,
  };
}

describe('IMPL-067 (3) — barreira do handoff', () => {
  it('campeão com span colado BLOQUEIA; paráfrase passa com o containment reportado', () => {
    const sujo = evaluateHandoffGuards(sessaoInput(CONTAMINADO));
    expect(sujo.blocked).toBe(true);
    expect(sujo.blocks.map((b) => b.code)).toEqual(['contamination.blocked']);
    expect(sujo.contamination).toMatchObject({ blocked: true, source: 'recomputed' });

    const limpo = evaluateHandoffGuards(sessaoInput(PARAFRASE));
    expect(limpo.blocked).toBe(false);
    expect(limpo.contamination?.blocked).toBe(false);
    expect(limpo.contamination?.containment).toBeLessThan(0.3);
  });

  it('o veredito do TREINO (gate da iteração) também bloqueia; override justificado sobrepõe', () => {
    const r = evaluateHandoffGuards(
      sessaoInput(PARAFRASE, {
        bestPromptByIteration: [{ systemPrompt: PARAFRASE, gate: { contamination: { blocked: true, containment: 0.4, detail: 'explicação do juiz colada' } } }],
      }),
    );
    expect(r.blocked).toBe(true);
    expect(r.contamination).toMatchObject({ source: 'training', detail: 'explicação do juiz colada' });
    const com = evaluateHandoffGuards(sessaoInput(CONTAMINADO), { overrideReason: 'revisado pelo time' });
    expect(com.blocked).toBe(false);
    expect(com.override?.bypassed).toEqual(['contamination.blocked']);
  });

  // Integração w2 (IMPL-061 × IMPL-067): a campeã few-shot carrega demos REAIS
  // do conjunto rotulado (bloco canônico `<exemplos_reais>`), e o treino tira
  // esses cenários da seleção e do holdout (leave-demos-out). O handoff aplica
  // a mesma regra: o cenário-demo sai do corpus; os demais seguem protegidos.
  const DEMOS = [
    {
      question: 'O fone de ouvido parou de funcionar depois de duas semanas de uso, ainda consigo trocar?',
      productContext: 'Garantia legal de 90 dias para produtos duráveis.',
      reference: 'Sim: produto durável tem garantia legal de 90 dias; abra a solicitação com a nota fiscal em mãos.',
    },
    {
      question: 'Recebi a cafeteira na cor errada e ela ainda está lacrada na caixa original, posso devolver?',
      productContext: 'Arrependimento: 7 dias do recebimento, produto sem uso.',
      reference: 'Pode: em até 7 dias do recebimento, sem uso e na embalagem original, a devolução é gratuita.',
    },
    {
      question: 'O pedido chegou faltando o cabo de energia da impressora que aparece na foto do anúncio',
      productContext: 'Itens faltantes: reenvio sem custo mediante abertura de chamado.',
      reference: 'Abra um chamado de item faltante: o cabo é reenviado sem custo, sem devolver a impressora.',
    },
  ];
  const comDemos = (texto: string) =>
    applyFewShotDemos(
      texto,
      DEMOS.map((d) => ({ question: d.question, response: d.reference })),
    );

  it('campeã few-shot com demos reais do treino NÃO é barrada pelo próprio exemplo (leave-demos-out)', () => {
    const campea = comDemos(PARAFRASE);
    expect(campea).toContain('<exemplos_reais>');
    const r = evaluateHandoffGuards(sessaoInput(campea, { pinnedStages: [CENARIO, ...DEMOS] }));
    expect(r.blocks.map((b) => b.code)).not.toContain('contamination.blocked');
    expect(r.contamination?.blocked).toBe(false);
  });

  it('…mas a campeã few-shot que TAMBÉM cola um cenário que não é demo continua barrada', () => {
    const r = evaluateHandoffGuards(sessaoInput(comDemos(CONTAMINADO), { pinnedStages: [CENARIO, ...DEMOS] }));
    expect(r.blocked).toBe(true);
    expect(r.blocks.map((b) => b.code)).toContain('contamination.blocked');
  });

  it('sessão sem cenários pinados nem veredito do treino: nada a medir (não bloqueia)', () => {
    const r = evaluateHandoffGuards(sessaoInput(CONTAMINADO, { pinnedStages: undefined }));
    expect(r.contamination).toBeNull();
    expect(r.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (4) processo real
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { cmd: BIN, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));
let home = '';

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'pb-impl067-'));
  mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const sessao = (id: string, campeao: string) =>
    writeFileSync(
      path.join(home, 'sessions', `${id}.json`),
      JSON.stringify({
        id,
        status: 'finished',
        config: { theme: 'trocas', iterations: 2, basePrompt: BASE },
        runIds: ['r0', 'r1'],
        pinnedStages: [{ ...CENARIO, maxTokens: 200 }],
        bestPromptByIteration: [{ iteration: 1, runId: 'r1', winnerContestantId: 'v1', systemPrompt: campeao, score: 3 }],
        holdout: { n: 6, controlScore: 60, championScore: 72, gain: 12, regressed: false },
        significance: { n: 6, meanDiffPp: 12, ci95Pp: [4, 20], pValue: 0.01 },
        totalCostUsd: 0.01,
        startedAt: '2026-09-27T00:00:00.000Z',
        finishedAt: '2026-09-27T00:10:00.000Z',
      }),
    );
  sessao('s-contaminada', CONTAMINADO);
  sessao('s-limpa', PARAFRASE);
});
afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

function cli(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: home, OPENROUTER_BASE_URL: 'http://127.0.0.1:9/api/v1' };
  delete env.OPENROUTER_API_KEY;
  return spawnSync(BIN, [ENTRY, ...args], { env, encoding: 'utf-8', timeout: 60_000 });
}

describe('IMPL-067 (4) — `sessions winner --apply` no processo real', { timeout: 120_000 }, () => {
  it('campeão contaminado: exit 10 handoff.contamination_blocked e o destino INTOCADO', () => {
    const file = path.join(home, 'prompt-sujo.md');
    writeFileSync(file, 'ORIGINAL\n');
    const r = cli(['sessions', 'winner', 's-contaminada', '--apply', file, '--json']);
    expect(r.status, r.stderr).toBe(EXIT.GATE_BLOCKED);
    const env = JSON.parse(r.stdout) as { error: { code: string; details: { blocks: { code: string }[] } } };
    expect(env.error.code).toBe('handoff.contamination_blocked');
    expect(env.error.details.blocks.map((b) => b.code)).toEqual(['contamination.blocked']);
    expect(readFileSync(file, 'utf-8')).toBe('ORIGINAL\n');
  });

  it('paráfrase legítima: aplica (exit 0)', () => {
    const file = path.join(home, 'prompt-limpo.md');
    writeFileSync(file, 'ORIGINAL\n');
    const r = cli(['sessions', 'winner', 's-limpa', '--apply', file, '--json']);
    expect(r.status, r.stdout + r.stderr).toBe(EXIT.OK);
    expect(readFileSync(file, 'utf-8')).toBe(`${PARAFRASE}\n`);
  });
});
