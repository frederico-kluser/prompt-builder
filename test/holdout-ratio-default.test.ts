// web-code#17 — o default do holdoutRatio é UM só (0,3 — IMPL-050) em todo
// lugar que o fixa: formulário da SPA, tradução do arena-config (CLI) e a
// estimativa de custo. Antes os três cravavam 0,2 e mandavam o valor explícito,
// então o fallback do trainer (`?? HOLDOUT_RATIO_DEFAULT`) nunca valia: a SPA
// reservava menos holdout que o CLI e a documentação, e a estimativa divergia
// do split real quando o campo faltava.

import { describe, expect, it } from 'vitest';
import { HOLDOUT_RATIO_DEFAULT, holdoutSplitSize, splitHoldout } from '../src/holdout.js';
import { plannedHoldoutStages } from '../src/engine/costConfirmation.js';
import { parseArenaConfig } from '../src/configFile.js';
import { arenaConfigToRunConfig } from '../src/arenaConfig.js';
import { defaultArenaFormState } from '../web/src/arenaForm.js';
import type { RunConfig } from '../src/types.js';

describe('web-code#17 — holdoutRatio default canônico', () => {
  it('o default é 0,3 (IMPL-050)', () => {
    expect(HOLDOUT_RATIO_DEFAULT).toBe(0.3);
  });

  it('formulário da SPA (Nova run) nasce com o default do motor', () => {
    expect(defaultArenaFormState().holdoutRatio).toBe(HOLDOUT_RATIO_DEFAULT);
  });

  it('arena-config sem training.holdoutRatio ⇒ o default do motor (não 0,2)', () => {
    const parsed = parseArenaConfig({
      format: 'arena-config@1',
      mode: 'training',
      theme: 'suporte',
      stages: 40,
      prompt: { text: 'Você é um assistente de suporte.' },
      models: {
        datagen: 'openai/gpt-5-mini',
        judges: ['anthropic/claude-sonnet-5'],
        contestant: 'openai/gpt-5-mini',
        reference: 'openai/gpt-5-nano',
      },
      variation: { optimize: true, techniques: ['persona', 'constraints'] },
      training: { iterations: 3 },
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const conv = arenaConfigToRunConfig(parsed.config);
    if (!conv.ok || conv.config.mode !== 'training') throw new Error('esperava training');
    expect(conv.config.holdoutRatio).toBe(HOLDOUT_RATIO_DEFAULT);
  });

  it('estimativa de custo: sem o campo, reserva o MESMO holdout que o trainer', () => {
    // 40 cenários: 0,3 → 12 reservados; com o 0,2 antigo seriam 10 (o piso).
    const cfg = { mode: 'training', stages: 40 } as unknown as RunConfig;
    const esperado = splitHoldout(Array.from({ length: 40 }, (_, i) => i), HOLDOUT_RATIO_DEFAULT).holdout.length;
    expect(esperado).toBe(12);
    expect(holdoutSplitSize(40, 0.2)).toBe(10);
    expect(plannedHoldoutStages(cfg)).toBe(esperado);
    expect(plannedHoldoutStages({ ...cfg, holdoutRatio: 0 } as RunConfig)).toBe(0);
  });
});
