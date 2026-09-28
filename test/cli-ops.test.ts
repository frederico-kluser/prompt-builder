// Testes de CONTRATO dos recursos de OPERAÇÃO (§8.8 do PLANO-PARIDADE):
// `runs reproduce` (config reconstruído + comando exato) e `runs export`
// (artefato auto-contido). A lógica vive em funções PURAS de
// `src/runArtifact.ts`, então tudo aqui roda sem disco — a fixture é um
// RunRecord montado à mão.

import { describe, expect, it } from 'vitest';
import { parseRunConfig } from '../src/runConfigSchema.js';
import { parseArenaConfig } from '../src/configFile.js';
import { arenaConfigToRunConfig } from '../src/arenaConfig.js';
import {
  RUN_ARTIFACT_FORMAT,
  buildReproduceArtifact,
  buildRunArtifact,
  commandForMode,
  suggestedReproduceCommand,
  type RunArtifact,
} from '../src/runArtifact.js';
import type {
  JudgeResult,
  RunRecord,
  StageSpec,
  VariationConfig,
} from '../src/types.js';

// --- fixture -----------------------------------------------------------------

const specReembolso: StageSpec = {
  question: 'O cliente pede reembolso fora da política de 7 dias. Responda.',
  productContext: 'Política: reembolso integral em até 7 dias; depois disso, crédito proporcional.',
  maxTokens: 600,
  rubric: 'Deve recusar com empatia e oferecer a alternativa prevista em política.',
  reference: 'Recusa o reembolso integral com empatia e oferece crédito proporcional.',
};

const specFatura: StageSpec = {
  question: 'Explique a fatura do mês para o cliente.',
  productContext: 'Faturas mensais com detalhamento por item e data de vencimento.',
  maxTokens: 600,
  reference: 'Lista itens, subtotal, impostos e data de vencimento, sem inventar valores.',
};

const config: VariationConfig = {
  mode: 'variation',
  theme: 'Suporte técnico de um SaaS de faturamento',
  stages: 2,
  datagenModelId: 'openai/gpt-5-mini',
  judgeModelIds: ['anthropic/claude-sonnet-5', 'google/gemini-2.5-pro'],
  // IMPL-048: papéis separados — a referência (gabarito) não pode ser juiz nem
  // o modelo sob teste; em training/variation o campo é OBRIGATÓRIO.
  referenceModelId: 'google/gemini-2.5-flash',
  contestantModelId: 'openai/gpt-5-mini',
  basePrompt: 'Você é um assistente de suporte. Responda com base na política do produto.',
  promptOptimization: true,
  techniqueIds: ['persona', 'constraints'],
  reasoning: { competitor: 'low', judge: 'high', datagen: 'low' },
  referenceJudging: true,
  judgePasses: 2,
  finalists: 3,
  duels: true,
  maxOutputTokens: 600,
  customStages: [specReembolso, specFatura],
};

function judge(verdicts: Record<string, 'resolve' | 'parcial' | 'nao'>): JudgeResult {
  return {
    rankedContestantIds: Object.keys(verdicts),
    acceptableByContestant: Object.fromEntries(
      Object.entries(verdicts).map(([id, v]) => [id, v !== 'nao']),
    ),
    verdictByContestant: verdicts,
    judges: [],
    blindMap: {},
    rawJudgeText: '',
  };
}

function fixtureRun(): RunRecord {
  return {
    id: 'r1',
    status: 'finished',
    mode: 'variation',
    config,
    contestants: [
      {
        id: 'original',
        label: 'Original (controle)',
        modelId: 'openai/gpt-5-mini',
        systemPrompt: 'Você é um assistente de suporte. Responda com base na política do produto.',
        isOriginal: true,
      },
      {
        id: 'v0',
        label: 'Persona',
        modelId: 'openai/gpt-5-mini',
        systemPrompt: 'Você é um especialista em suporte técnico de faturamento.',
        techniqueId: 'persona',
      },
      {
        id: 'v1',
        label: 'Restrições',
        modelId: 'openai/gpt-5-mini',
        systemPrompt: 'Responda somente com base na política do produto.',
        techniqueId: 'constraints',
      },
    ],
    stages: [
      {
        index: 0,
        spec: specReembolso,
        responses: [],
        judge: judge({ v0: 'resolve', v1: 'parcial', original: 'nao' }),
        referenceJudge: {
          verdictByContestant: { v0: 'resolve', v1: 'parcial', original: 'nao' },
          explanationByContestant: {
            v0: 'Segue a política e oferece a alternativa.',
            v1: 'Cobre a política sem oferecer alternativa.',
            original: 'Promete reembolso fora da política.',
          },
          judgeModelId: 'anthropic/claude-sonnet-5',
        },
        startedAt: '2026-09-25T00:00:00.000Z',
        finishedAt: '2026-09-25T00:05:00.000Z',
      },
      {
        index: 1,
        spec: specFatura,
        responses: [],
        judge: judge({ v0: 'resolve', v1: 'resolve', original: 'parcial' }),
        referenceJudge: {
          verdictByContestant: { v0: 'resolve', v1: 'resolve', original: 'parcial' },
          explanationByContestant: {
            v0: 'Detalha tudo que a fatura traz.',
            v1: 'Detalha tudo que a fatura traz.',
            original: 'Inventa valores que não estão na fatura.',
          },
          judgeModelId: 'anthropic/claude-sonnet-5',
        },
        startedAt: '2026-09-25T00:00:00.000Z',
        finishedAt: '2026-09-25T00:05:00.000Z',
      },
    ],
    scoreboard: { v0: 4, v1: 2, original: 0 },
    judgeScoreByContestant: { v0: 100, v1: 75, original: 25 },
    finalists: ['v0', 'v1', 'original'],
    totalCostUsd: 0.42,
    startedAt: '2026-09-25T00:00:00.000Z',
    finishedAt: '2026-09-25T00:10:00.000Z',
  };
}

// --- runs reproduce ----------------------------------------------------------

describe('runs reproduce — config reconstruído', () => {
  const art = buildReproduceArtifact(fixtureRun());

  it('o config reconstruído passa em parseRunConfig', () => {
    expect(parseRunConfig(art.config)).toMatchObject({ ok: true });
  });

  it('preserva os campos críticos (judgeModelIds, finalists)', () => {
    expect(art.config.judgeModelIds).toEqual(['anthropic/claude-sonnet-5', 'google/gemini-2.5-pro']);
    expect(art.config.finalists).toBe(3);
    expect(art.config.mode).toBe('variation');
    expect(art.config.theme).toBe('Suporte técnico de um SaaS de faturamento');
    expect(art.config.maxOutputTokens).toBe(600);
    expect(art.config.reasoning).toEqual({ competitor: 'low', judge: 'high', datagen: 'low' });
    expect(art.config.duels).toBe(true);
  });

  it('budgetUsd ausente => ausente (nada é inventado)', () => {
    expect('budgetUsd' in art.config).toBe(false);
    // e sobrevive ao serializar (o que um consumidor grava em arquivo):
    const volta = JSON.parse(JSON.stringify(art.config)) as Record<string, unknown>;
    expect('budgetUsd' in volta).toBe(false);
  });

  it('budgetUsd presente => preservado, e o comando sugerido o repassa', () => {
    const comOrcamento: RunRecord = {
      ...fixtureRun(),
      config: { ...config, budgetUsd: 5 },
    };
    const a = buildReproduceArtifact(comOrcamento);
    expect(a.config.budgetUsd).toBe(5);
    expect(a.suggestedCommand).toContain('--budget 5');
  });

  it('suggestedCommand é o comando EXATO (modo certo, arquivo, budget)', () => {
    expect(art.runId).toBe('r1');
    expect(art.suggestedCommand).toBe('prompt-builder vary --config run-r1.config.json --budget none');
    expect(commandForMode('compare')).toBe('compare');
    expect(commandForMode('training')).toBe('train');
    expect(suggestedReproduceCommand('training', 'x.json', 2)).toBe(
      'prompt-builder train --config x.json --budget 2',
    );
  });

  it('a vista arena-config@1 é válida e converte de volta para um RunConfig válido', () => {
    const parsed = parseArenaConfig(art.arenaConfig);
    expect(parsed.ok ? 'ok' : parsed.error).toBe('ok');
    if (!parsed.ok) return;
    expect(parsed.config.models.judges).toEqual(config.judgeModelIds);
    expect(parsed.config.models.contestant).toBe('openai/gpt-5-mini');
    expect(parsed.config.finalists).toBe(3);

    const conv = arenaConfigToRunConfig(parsed.config);
    expect(conv.ok ? 'ok' : conv.error).toBe('ok');
    if (!conv.ok) return;
    expect(parseRunConfig(conv.config)).toMatchObject({ ok: true });
    expect(conv.config.judgeModelIds).toEqual(config.judgeModelIds);
    expect(conv.config.finalists).toBe(3);
  });
});

// --- runs export -------------------------------------------------------------

describe('runs export — artefato auto-contido', () => {
  const exportedAt = '2026-09-25T00:10:01.000Z';
  const artifact = buildRunArtifact(fixtureRun(), exportedAt);

  it('round-trip JSON: build → parse de volta → campos presentes', () => {
    const volta = JSON.parse(JSON.stringify(artifact)) as RunArtifact;
    expect(volta.format).toBe(RUN_ARTIFACT_FORMAT);
    expect(volta.format).toBe('prompt-builder-run@1');
    expect(volta.exportedAt).toBe(exportedAt);
    expect(volta.record.id).toBe('r1');
    expect(volta.record.config.judgeModelIds).toEqual(config.judgeModelIds);
  });

  it('stages com gabaritos (reference) para auditar sem o disco', () => {
    expect(artifact.stages).toHaveLength(2);
    expect(artifact.stages.map((s) => s.question)).toEqual([
      specReembolso.question,
      specFatura.question,
    ]);
    expect(artifact.stages[0].reference).toBe(specReembolso.reference);
    expect(artifact.stages[1].reference).toBe(specFatura.reference);
    expect(artifact.stages[0].rubric).toBe(specReembolso.rubric);
  });

  it('contestants com os system prompts que competiram', () => {
    expect(artifact.contestants).toHaveLength(3);
    const v0 = artifact.contestants.find((c) => c.id === 'v0');
    expect(v0?.systemPrompt).toBe('Você é um especialista em suporte técnico de faturamento.');
    expect(v0?.techniqueId).toBe('persona');
    expect(artifact.contestants.find((c) => c.id === 'original')?.isOriginal).toBe(true);
  });

  it('judge: judgeModelIds + vereditos por etapa (pointwise vs gabarito)', () => {
    expect(artifact.judge.judgeModelIds).toEqual(config.judgeModelIds);
    expect(artifact.judge.verdictsPorEtapa).toHaveLength(2);
    expect(artifact.judge.verdictsPorEtapa[0]).toMatchObject({
      stageIndex: 0,
      verdictByContestant: { v0: 'resolve', v1: 'parcial', original: 'nao' },
      rankedContestantIds: ['v0', 'v1', 'original'],
    });
    expect(artifact.judge.verdictsPorEtapa[1].verdictByContestant).toEqual({
      v0: 'resolve',
      v1: 'resolve',
      original: 'parcial',
    });
  });
});
