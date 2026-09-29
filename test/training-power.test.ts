// web-live#5 — o treino DEFAULT precisa CONSEGUIR promover.
//
// Medido na tela guiada (s17): 5 cenários, 4 técnicas — a melhor variante
// venceu todos os cenários por +50 p.p. e as duas rodadas foram seguradas com
// "p ajustado=0,063 (max-T, exato)". O gate da melhor de K é uma troca de sinais
// EXATA sobre os n cenários de seleção: o menor p possível é 2^-n, e um cenário
// em que régua e as K variantes empatam sai da conta (n efetivo cai). Com 5
// cenários, UM empate total já deixa o p mínimo em 1/16 = 0,0625 > α.
//
// Contrato aqui:
//   1. a aritmética do piso (fonte única em engine/trainingPolicy.ts) bate com o
//      `bestOfKTest` real (n=5 → 1/32; um empate total → 0,0625);
//   2. o diagnóstico `trainingPromotionPower` classifica impossível/frágil/ok e
//      desconta a fatia de holdout;
//   3. os defaults deixam o treino promover: `train` sem --stages e arena-config
//      de treino sem `stages` usam 10 (compare/vary seguem em 5);
//   4. o pré-voo do CLI (real e --dry-run) e o `estimate` AVISAM quando a
//      config não consegue promover.
// Sem rede, sem gasto: gateway falso em processo.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bestOfKTest, GATE_ALPHA } from '../src/engine/bestOfK.js';
import {
  minAchievableGateP,
  minPairsForPromotion,
  minScenariosForPromotion,
  plannedTrainingStages,
  selectionScenariosFor,
  TRAINING_DEFAULT_STAGES,
  TRAINING_MIN_STAGES_RECOMMENDED,
  trainingPromotionPower,
} from '../src/engine/trainingPolicy.js';
import { arenaConfigToRunConfig } from '../src/arenaConfig.js';
import { parseArenaConfig } from '../src/configFile.js';
import { buildFromFlags, cmdRun } from '../src/cli/commands/run.js';
import { cmdEstimate } from '../src/cli/commands/misc.js';
import { EXIT, resetOutputState, toCliError } from '../src/cli/output.js';
import { createGateway, setDefaultGateway } from '../src/openrouter.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import type { RunMode } from '../src/types.js';

describe('web-live#5 (1) — o piso do gate bate com o bestOfKTest real', () => {
  it('α = 0,05 ⇒ o gate precisa de ≥ 5 cenários efetivos (2^-5 = 1/32 ≤ α < 1/16)', () => {
    expect(GATE_ALPHA).toBe(0.05);
    expect(minPairsForPromotion()).toBe(5);
    expect(minAchievableGateP(4)).toBe(0.0625);
    expect(minAchievableGateP(5)).toBe(1 / 32);
    expect(minPairsForPromotion(0.01)).toBe(7); // 2^-7 = 0,0078 ≤ 0,01 < 2^-6
    expect(TRAINING_MIN_STAGES_RECOMMENDED).toBe(8); // mínimo 5 + folga de 3 empates
  });

  it('n = 5 com a melhor vencendo TUDO: p ajustado = 1/32 (promove); um empate total: 0,0625 (segura)', () => {
    const regua = [0.5, 0.5, 0.5, 0.5, 0.5];
    const variantes = [
      [1, 1, 1, 1, 1], // a melhor: vence os 5
      [0.5, 1, 0.5, 1, 0.5],
      [1, 0.5, 0.5, 0.5, 1],
      [0.5, 0.5, 1, 0.5, 0.5],
    ];
    const tudo = bestOfKTest(regua, variantes);
    expect(tudo.pAdjusted[0]).toBeCloseTo(minAchievableGateP(5), 12);
    expect(tudo.pAdjusted[0]).toBeLessThanOrEqual(GATE_ALPHA);
    // O cenário 5 empata em TODOS (régua e as 4 variantes): sai da conta.
    const empate = variantes.map((v) => [...v.slice(0, 4), 0.5]);
    const r = bestOfKTest(regua, empate);
    expect(r.pAdjusted[0]).toBeCloseTo(minAchievableGateP(4), 12);
    expect(r.pAdjusted[0]).toBeGreaterThan(GATE_ALPHA);
  });
});

describe('web-live#5 (2) — diagnóstico de poder do treino', () => {
  it('4 cenários: IMPOSSÍVEL promover (o aviso cita o p mínimo e o recomendado)', () => {
    const p = trainingPromotionPower({ stages: 4, techniques: 4 });
    expect(p.level).toBe('impossible');
    expect(p.selectionScenarios).toBe(4);
    expect(p.minPAdjusted).toBe(0.0625);
    expect(p.message).toMatch(/NÃO consegue promover nenhuma variante/);
    expect(p.message).toContain('0,063');
    expect(p.message).toContain(`Use ao menos ${p.recommendedStages} cenários`);
  });

  it('5 cenários (o default antigo da tela): FRÁGIL — um único empate segura', () => {
    const p = trainingPromotionPower({ stages: 5, techniques: 4 });
    expect(p.level).toBe('fragile');
    expect(p.tieAllowance).toBe(0);
    expect(p.message).toContain('TODOS eles');
    expect(p.message).toContain('um único empate já segura');
  });

  it('7 cenários: frágil com folga 2 (3 empates seguram); 8+: ok', () => {
    const p7 = trainingPromotionPower({ stages: 7 });
    expect(p7.level).toBe('fragile');
    expect(p7.message).toContain('3 empates já seguram');
    for (const n of [8, 10, 15]) expect(trainingPromotionPower({ stages: n }).level, String(n)).toBe('ok');
  });

  it('desconta o holdout: 20 cenários com ratio 0,3 ⇒ 10 de seleção (ok); 40 ⇒ 28', () => {
    expect(selectionScenariosFor(20)).toBe(10);
    expect(selectionScenariosFor(19)).toBe(19); // < 20 não forma holdout
    expect(selectionScenariosFor(40, 0.3)).toBe(28);
    expect(selectionScenariosFor(20, 0)).toBe(20);
    expect(trainingPromotionPower({ stages: 20 }).selectionScenarios).toBe(10);
    expect(trainingPromotionPower({ stages: 20 }).level).toBe('ok');
  });

  it('o recomendado leva o holdout em conta e independe de K (a enumeração é exata)', () => {
    expect(minScenariosForPromotion(4)).toBe(8);
    expect(minScenariosForPromotion(6)).toBe(8);
    expect(minScenariosForPromotion(4, { holdoutRatio: 0 })).toBe(8);
    expect(TRAINING_DEFAULT_STAGES).toBeGreaterThanOrEqual(minScenariosForPromotion(6));
  });

  it('cenários PLANEJADOS: customStages fixam; o seed nunca é cortado', () => {
    expect(plannedTrainingStages({ stages: 10 })).toBe(10);
    expect(plannedTrainingStages({ stages: 10, customStages: [1, 2, 3] })).toBe(3);
    expect(plannedTrainingStages({ stages: 5, scenarioSeed: Array.from({ length: 12 }) })).toBe(12);
  });
});

describe('web-live#5 (3) — defaults que conseguem promover', () => {
  it('`train` sem --stages usa 10; `vary`/`compare` seguem em 5', async () => {
    const base = { theme: 'Suporte', judge: ['acme/judge'], reference: 'acme/ref', model: 'acme/alpha', techniques: 'persona,constraints' };
    const train = await buildFromFlags('training', base);
    expect(train.stages).toBe(TRAINING_DEFAULT_STAGES);
    expect(trainingPromotionPower({ stages: train.stages }).level).toBe('ok');
    const vary = await buildFromFlags('variation', base);
    expect(vary.stages).toBe(5);
    const explicito = await buildFromFlags('training', { ...base, stages: '6' });
    expect(explicito.stages).toBe(6);
  });

  it('arena-config de treino sem `stages` usa 10; com `stages` explícito respeita', () => {
    const arquivo = (over: Record<string, unknown> = {}): unknown => ({
      format: 'arena-config@1',
      mode: 'training',
      theme: 'Suporte',
      models: { contestant: 'acme/alpha', judges: ['acme/judge'], datagen: 'acme/gen', reference: 'acme/ref' },
      prompt: { text: 'Voce e um atendente.' },
      variation: { optimize: true, techniques: ['persona', 'constraints'] },
      training: { iterations: 2 },
      ...over,
    });
    const conv = (raw: unknown) => {
      const p = parseArenaConfig(raw);
      if (!p.ok) throw new Error(p.error);
      const c = arenaConfigToRunConfig(p.config);
      if (!c.ok) throw new Error(c.error);
      return c.config;
    };
    expect(conv(arquivo()).stages).toBe(TRAINING_DEFAULT_STAGES);
    expect(conv(arquivo({ stages: 6 })).stages).toBe(6);
    expect(conv(arquivo({ mode: 'variation', training: undefined })).stages).toBe(5);
  });
});

// --- (4) pré-voo e estimate avisam ------------------------------------------

const VALID_KEY = `sk-or-v1-${'a'.repeat(48)}`;
const dirs: string[] = [];
const envSalvo: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ['CI', 'OPENROUTER_API_KEY', 'PROMPT_BUILDER_HOME']) envSalvo[k] = process.env[k];
  process.env.CI = '1';
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.PROMPT_BUILDER_HOME;
});
afterAll(() => {
  for (const [k, v] of Object.entries(envSalvo)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'pb-power-'));
  dirs.push(d);
  return d;
}

async function emProcesso(fn: () => Promise<number>): Promise<{ exit: number; stdout: string; stderr: string }> {
  const fake = fakeOpenRouter({
    catalog: ['acme/alpha', 'acme/judge', 'acme/ref', 'acme/gen'].map((id) => catalogItem(id, 1e-6, 2e-6)),
    keyData: { label: 'fake', usage: 0, limit: null, limit_remaining: null },
    chat: () => ({ status: 500, bodyText: 'chat proibido neste teste' }),
  });
  const prev = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
  resetOutputState();
  const out: string[] = [];
  const err: string[] = [];
  const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    out.push(String(c));
    return true;
  });
  const se = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    err.push(String(c));
    return true;
  });
  try {
    const exit = await fn();
    return { exit, stdout: out.join(''), stderr: err.join('') };
  } catch (e) {
    return { exit: toCliError(e).code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    so.mockRestore();
    se.mockRestore();
    resetOutputState();
    setDefaultGateway(prev);
    expect(fake.chatRequests()).toHaveLength(0);
  }
}

const TRAIN = ['--theme', 'Suporte', '--judge', 'acme/judge', '--reference', 'acme/ref', '--model', 'acme/alpha', '--techniques', 'persona,constraints'];

describe('web-live#5 (4) — o pré-voo e o estimate avisam alto', () => {
  const dry = (mode: RunMode, extra: string[]) =>
    emProcesso(() =>
      cmdRun(mode, [...TRAIN, ...extra, '--budget', 'none', '--key', VALID_KEY, '--dry-run', '--data-dir', tmp(), '--json']),
    );

  it('train --stages 4 --dry-run: warning "NÃO consegue promover" no JSON e no stderr', async () => {
    const r = await dry('training', ['--stages', '4']);
    expect(r.exit, r.stdout + r.stderr).toBe(EXIT.OK);
    const data = (JSON.parse(r.stdout) as { data: { warnings: string[] } }).data;
    expect(data.warnings.some((w) => /poder do gate: .*NÃO consegue promover/.test(w))).toBe(true);
    expect(r.stderr).toContain('poder do gate');
  });

  it('train com o default (10 cenários): sem aviso de poder', async () => {
    const r = await dry('training', []);
    expect(r.exit, r.stdout + r.stderr).toBe(EXIT.OK);
    const data = (JSON.parse(r.stdout) as { data: { config: { stages: number }; warnings: string[] } }).data;
    expect(data.config.stages).toBe(10);
    expect(data.warnings.filter((w) => w.includes('poder do gate'))).toEqual([]);
  });

  it('compare/vary não recebem o aviso (o gate de promoção é do treino)', async () => {
    const r = await dry('variation', ['--stages', '4']);
    expect(r.exit, r.stdout + r.stderr).toBe(EXIT.OK);
    const data = (JSON.parse(r.stdout) as { data: { warnings: string[] } }).data;
    expect(data.warnings.filter((w) => w.includes('poder do gate'))).toEqual([]);
  });

  it('estimate de um treino com 5 cenários: `trainingPower` frágil no JSON', async () => {
    const dir = tmp();
    const f = path.join(dir, 'train.json');
    writeFileSync(
      f,
      JSON.stringify({
        mode: 'training',
        theme: 'Suporte',
        stages: 5,
        datagenModelId: 'acme/gen',
        judgeModelIds: ['acme/judge'],
        referenceModelId: 'acme/ref',
        contestantModelId: 'acme/alpha',
        techniqueIds: ['persona', 'constraints'],
        iterations: 2,
      }),
    );
    const r = await emProcesso(() => cmdEstimate(['-c', f, '--data-dir', dir, '--json']));
    expect(r.exit, r.stdout + r.stderr).toBe(EXIT.OK);
    const data = (JSON.parse(r.stdout) as { data: { trainingPower?: { level: string; selectionScenarios: number } } })
      .data;
    expect(data.trainingPower).toMatchObject({ level: 'fragile', selectionScenarios: 5 });
  });
});
