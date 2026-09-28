// IMPL-079 (R-08:REC-1 / DEC-1) — esforço de raciocínio POR PAPEL de juízo:
// reasoning.judge / reasoning.duel / reasoning.gab com defaults medium/low/
// high, fallback para o `reasoning.judge` antigo e `fitEffort` por modelo.
//
// Critérios cobertos aqui (zero LLM, zero rede real — transporte falso):
//  (i)   runConfigSchema aceita os 3 papéis, com fallback para o campo único
//        antigo `reasoning.judge` (compat) e testes de contrato por papel;
//  (ii)  o exemplo de config PUBLICADO (README: judge=medium, duel=low,
//        gab=high) existe e valida no schema real;
//  (iii) `fitEffort` continua aplicado por modelo (allowlist de
//        `supported_efforts` do catálogo) — no resolvedor e no fio;
//  +     defaults por papel (pointwise medium, duelo low, gabarito high) e
//        `off` explícito respeitado (nunca vira degrau).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseRunConfig } from '../src/runConfigSchema.js';
import {
  reasoningForRole,
  reasoningLevelForRole,
  REASONING_ROLE_DEFAULT,
} from '../src/modelCaps.js';
import { createGateway } from '../src/openrouter.js';
import { fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-impl079-000000';
const msgs = [{ role: 'user' as const, content: 'x' }];

const BASE_COMPARE = {
  mode: 'compare',
  theme: 'suporte',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  competitorModelIds: ['fake/a', 'fake/b'],
};

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('IMPL-079 (i) — schema aceita judge/duel/gab, com fallback para reasoning.judge', () => {
  it('os 3 papéis são aceitos e preservados no parse', () => {
    const r = parseRunConfig({
      ...BASE_COMPARE,
      reasoning: { judge: 'medium', duel: 'low', gab: 'high' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.reasoning).toMatchObject({ judge: 'medium', duel: 'low', gab: 'high' });
  });

  it('cada papel é independente (contrato por papel): mutar um não muda os outros', () => {
    for (const [papel, nivel] of [
      ['judge', 'xhigh'],
      ['duel', 'minimal'],
      ['gab', 'max'],
    ] as const) {
      const r = parseRunConfig({ ...BASE_COMPARE, reasoning: { [papel]: nivel } });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.config.reasoning?.[papel]).toBe(nivel);
    }
  });

  it('config legada (só reasoning.judge) resolve juiz, duelo e gabarito pelo MESMO degrau', () => {
    const legada = { judge: 'high' } as const;
    expect(reasoningLevelForRole(legada, 'judge')).toBe('high');
    expect(reasoningLevelForRole(legada, 'duel')).toBe('high'); // fallback compat
    expect(reasoningLevelForRole(legada, 'gab')).toBe('high'); // fallback compat
  });

  it('papel com campo PRÓPRIO não herda o judge; sem campo cai no judge e, sem ele, no default', () => {
    const cfg = { judge: 'high', duel: 'low' } as const;
    expect(reasoningLevelForRole(cfg, 'judge')).toBe('high');
    expect(reasoningLevelForRole(cfg, 'duel')).toBe('low'); // próprio vence
    expect(reasoningLevelForRole(cfg, 'gab')).toBe('high'); // fallback judge
    // Sem NADA: defaults do papel (DEC-1: medium/low/high).
    expect(reasoningLevelForRole(undefined, 'judge')).toBe('medium');
    expect(reasoningLevelForRole(undefined, 'duel')).toBe('low');
    expect(reasoningLevelForRole(undefined, 'gab')).toBe('high');
    expect(REASONING_ROLE_DEFAULT).toEqual({ judge: 'medium', duel: 'low', gab: 'high' });
  });

  it("'off' explícito é respeitado (?? só atravessa undefined) e nunca vira degrau", () => {
    const cfg = { judge: 'off', gab: 'off' } as const;
    expect(reasoningLevelForRole(cfg, 'judge')).toBe('off');
    expect(reasoningLevelForRole(cfg, 'gab')).toBe('off');
    expect(reasoningLevelForRole(cfg, 'duel')).toBe('off'); // fallback judge
    // 'off' não passa por fitEffort (é `enabled: false`, não um degrau).
    expect(reasoningForRole(cfg, 'gab', { supportedEfforts: ['low'] }).effort).toBe('none');
  });
});

describe('IMPL-079 (ii) — o exemplo de config publicado usa judge=medium, duel=low, gab=high', () => {
  it('README publica o exemplo E ele valida no schema real', () => {
    const readme = readFileSync(`${ROOT}README.md`, 'utf8');
    expect(readme).toContain('"judge": "medium", "duel": "low", "gab": "high"');
    const r = parseRunConfig({
      ...BASE_COMPARE,
      reasoning: { judge: 'medium', duel: 'low', gab: 'high' },
    });
    expect(r.ok).toBe(true);
  });
});

describe('IMPL-079 (iii) — fitEffort continua aplicado por modelo', () => {
  it('o resolvedor encaixa o degrau do papel na allowlist do modelo', () => {
    const meta = { supportedEfforts: ['xhigh', 'high'] };
    // gabarito pede 'high' (default) e o modelo aceita: passa direto.
    expect(reasoningForRole(undefined, 'gab', meta).effort).toBe('high');
    // judge pede 'medium' (default) e o modelo só tem [xhigh, high] → 'high'.
    expect(reasoningForRole(undefined, 'judge', meta).effort).toBe('high');
    // pedido fora da allowlist encaixa na menor distância ordinal (max → xhigh).
    expect(reasoningForRole({ duel: 'max' }, 'duel', meta).effort).toBe('xhigh');
    // sem allowlist declarada o pedido passa direto.
    expect(reasoningForRole(undefined, 'judge', undefined).effort).toBe('medium');
  });

  it('no FIO: o body leva o effort encaixado na allowlist do catálogo', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: 'ok' }) });
    const g = createGateway({ fetch: fake.fetch, sleep: noSleep });
    // O modelo só aceita o degrau 'high' — o default do gabarito ('high') e o
    // do judge ('medium') têm de ser encaixados ANTES de ir no corpo.
    g.primeModelsCache(KEY, [
      {
        id: 'fake/so-high',
        name: 'fake/so-high',
        pricing: { prompt: 1e-4, completion: 1e-4 },
        supportedParameters: ['temperature', 'max_tokens', 'reasoning_effort'],
        reasoning: { supportedEfforts: ['high'], mandatory: true },
      },
    ]);
    await g.chatCompletion({
      apiKey: KEY,
      modelId: 'fake/so-high',
      messages: msgs,
      role: 'gabarito',
      reasoningLevel: reasoningLevelForRole(undefined, 'gab'),
    });
    await g.chatCompletion({
      apiKey: KEY,
      modelId: 'fake/so-high',
      messages: msgs,
      role: 'judge',
      reasoningLevel: reasoningLevelForRole(undefined, 'judge'),
    });
    const [gab, juiz] = fake.chatRequests();
    expect((gab.body?.reasoning as { effort?: string }).effort).toBe('high');
    expect((juiz.body?.reasoning as { effort?: string }).effort).toBe('high'); // medium → high
  });
});