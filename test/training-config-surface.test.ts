// Superfície de config dos campos do LAÇO de treino e do modo auditável.
//
//   IMPL-060  training.maxLessonTokens / lessonsIncludeReference
//   IMPL-062  training.paretoPool / paretoCoverageSampling
//   IMPL-065  training.minCuratedItems
//   IMPL-075  RunConfig.auditable (arena-config: judging.auditable; CLI --auditable)
//
// O furo: os campos existiam em TrainingConfig e o trainer os lia, mas o zod do
// `runConfigSchema` os STRIPAVA (chave desconhecida) — `train --config`, MCP e
// POST /sessions rodavam sempre o default, e `config validate` recusava o
// arquivo com "Chave(s) desconhecida(s)". Aqui: o schema preserva, o
// `config validate` aceita, o arena-config (Node e SPA) valida e o
// `arenaConfigToRunConfig` entrega os campos ao RunConfig.

import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseRunConfig } from '../src/runConfigSchema.js';
import { parseArenaConfig } from '../src/configFile.js';
import { parseArenaConfig as parseArenaConfigWeb } from '../web/src/engine/configFile.js';
import { arenaConfigToRunConfig } from '../src/arenaConfig.js';
import { cmdConfig } from '../src/cli/commands/misc.js';
import { cmdRun } from '../src/cli/commands/run.js';
import { EXIT, resetOutputState, toCliError } from '../src/cli/output.js';
import { createGateway, setDefaultGateway } from '../src/openrouter.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { startTraining, trainToCompletion } from '../src/trainer.js';
import { startTraining as startWebTraining } from '../web/src/engine/trainer.js';
import type { TrainingConfig } from '../src/types.js';

const TRAINING = {
  mode: 'training',
  theme: 'Suporte',
  stages: 10,
  datagenModelId: 'acme/gen',
  judgeModelIds: ['acme/judge'],
  referenceModelId: 'acme/ref',
  contestantModelId: 'acme/alpha',
  techniqueIds: ['persona', 'constraints'],
  iterations: 2,
};

const LACO = {
  paretoPool: 3,
  paretoCoverageSampling: true,
  maxLessonTokens: 1500,
  lessonsIncludeReference: true,
  minCuratedItems: 12,
};

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'pb-cfg-surface-'));
  dirs.push(d);
  return d;
}

async function quieto<T>(fn: () => Promise<T>): Promise<{ value?: T; stdout: string; exit?: number }> {
  resetOutputState();
  const out: string[] = [];
  const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    out.push(String(c));
    return true;
  });
  const se = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const value = await fn();
    return { value, stdout: out.join('') };
  } catch (e) {
    return { stdout: out.join(''), exit: toCliError(e).code };
  } finally {
    so.mockRestore();
    se.mockRestore();
    resetOutputState();
  }
}

describe('runConfigSchema — os campos do laço e o modo auditável SOBREVIVEM', () => {
  it('parseRunConfig preserva paretoPool/paretoCoverageSampling/maxLessonTokens/lessonsIncludeReference/minCuratedItems/auditable', () => {
    const p = parseRunConfig({ ...TRAINING, ...LACO, auditable: true });
    expect(p.ok, p.ok ? '' : p.error).toBe(true);
    if (!p.ok) return;
    const c = p.config as TrainingConfig;
    expect(c).toMatchObject({ ...LACO, auditable: true });
  });

  it('auditable vale em qualquer modo (é do julgamento, não do laço)', () => {
    const p = parseRunConfig({
      mode: 'compare',
      theme: 'Suporte',
      stages: 5,
      datagenModelId: 'acme/gen',
      judgeModelIds: ['acme/judge'],
      competitorModelIds: ['acme/alpha', 'acme/beta'],
      auditable: true,
    });
    expect(p.ok && p.config.auditable).toBe(true);
  });

  it('faixas: maxLessonTokens 200..4000, paretoPool 0..8, minCuratedItems ≥ 0', () => {
    for (const ruim of [{ maxLessonTokens: 100 }, { maxLessonTokens: 5000 }, { paretoPool: 9 }, { minCuratedItems: -1 }, { paretoCoverageSampling: 'sim' }]) {
      expect(parseRunConfig({ ...TRAINING, ...ruim }).ok, JSON.stringify(ruim)).toBe(false);
    }
    expect(parseRunConfig({ ...TRAINING, minCuratedItems: 0 }).ok).toBe(true);
  });

  it('`config validate` de um RunConfig cru com os campos: exit 0 (antes: exit 3 "chave desconhecida")', async () => {
    const dir = tmp();
    const f = path.join(dir, 'train.json');
    writeFileSync(f, JSON.stringify({ ...TRAINING, ...LACO, auditable: true }));
    const r = await quieto(() => cmdConfig(['validate', f, '--data-dir', dir, '--json']));
    expect(r.exit, r.stdout).toBeUndefined();
    expect(r.value).toBe(EXIT.OK);
    const data = (JSON.parse(r.stdout) as { data: { config: Record<string, unknown> } }).data;
    expect(data.config).toMatchObject({ ...LACO, auditable: true });
  });
});

const ARENA = {
  format: 'arena-config@1',
  mode: 'training',
  theme: 'Suporte',
  stages: 10,
  models: { contestant: 'acme/alpha', judges: ['acme/judge'], datagen: 'acme/gen', reference: 'acme/ref' },
  prompt: { text: 'Voce e um atendente.' },
  variation: { optimize: true, techniques: ['persona', 'constraints'] },
  judging: { auditable: true },
  training: { iterations: 2, ...LACO },
};

describe('arena-config@1 — Node e SPA aceitam; o RunConfig recebe', () => {
  it('os DOIS schemas (mirror) validam training.* novos e judging.auditable', () => {
    for (const [nome, parse] of [
      ['Node', parseArenaConfig],
      ['SPA', parseArenaConfigWeb],
    ] as const) {
      const p = parse(JSON.parse(JSON.stringify(ARENA)));
      expect(p.ok, `${nome}: ${p.ok ? '' : p.error}`).toBe(true);
      if (!p.ok) continue;
      expect(p.config.training, nome).toMatchObject(LACO);
      expect(p.config.judging?.auditable, nome).toBe(true);
    }
  });

  it('arenaConfigToRunConfig entrega os campos (antes: validados e rodando o default em silêncio)', () => {
    const p = parseArenaConfig(JSON.parse(JSON.stringify(ARENA)));
    if (!p.ok) throw new Error(p.error);
    const c = arenaConfigToRunConfig(p.config);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.config).toMatchObject({ ...LACO, auditable: true });
    // ...e o RunConfig resultante passa no schema sem perder nada.
    const r = parseRunConfig(c.config);
    expect(r.ok && r.config).toMatchObject({ ...LACO, auditable: true });
  });

  it('`config validate` do arena-config com os campos: exit 0 e config completo', async () => {
    const dir = tmp();
    const f = path.join(dir, 'arena.json');
    writeFileSync(f, JSON.stringify(ARENA));
    const r = await quieto(() => cmdConfig(['validate', f, '--data-dir', dir, '--json']));
    expect(r.exit, r.stdout).toBeUndefined();
    const data = (JSON.parse(r.stdout) as { data: { config: Record<string, unknown> } }).data;
    expect(data.config).toMatchObject({ ...LACO, auditable: true });
  });
});

describe('CLI --auditable (IMPL-075)', () => {
  const VALID_KEY = `sk-or-v1-${'a'.repeat(48)}`;
  it('`train --auditable --dry-run`: o config que rodaria leva auditable:true (também sobre --config)', async () => {
    const fake = fakeOpenRouter({
      catalog: ['acme/alpha', 'acme/judge', 'acme/ref', 'acme/gen'].map((id) => catalogItem(id, 1e-6, 2e-6)),
      chat: () => ({ status: 500, bodyText: 'chat proibido' }),
    });
    const prev = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    const ci = process.env.CI;
    process.env.CI = '1';
    try {
      const dir = tmp();
      const flags = ['--theme', 'Suporte', '--judge', 'acme/judge', '--reference', 'acme/ref', '--model', 'acme/alpha', '--techniques', 'persona,constraints'];
      const comum = ['--budget', 'none', '--key', VALID_KEY, '--dry-run', '--data-dir', dir, '--json'];
      const r1 = await quieto(() => cmdRun('training', [...flags, '--auditable', ...comum]));
      expect(r1.exit, r1.stdout).toBeUndefined();
      expect((JSON.parse(r1.stdout) as { data: { config: { auditable?: boolean } } }).data.config.auditable).toBe(true);
      const sem = await quieto(() => cmdRun('training', [...flags, ...comum]));
      expect((JSON.parse(sem.stdout) as { data: { config: { auditable?: boolean } } }).data.config.auditable).toBeUndefined();
      const f = path.join(dir, 'train.json');
      writeFileSync(f, JSON.stringify(TRAINING));
      const r2 = await quieto(() => cmdRun('training', ['--config', f, '--auditable', ...comum]));
      expect((JSON.parse(r2.stdout) as { data: { config: { auditable?: boolean } } }).data.config.auditable).toBe(true);
      expect(fake.chatRequests()).toHaveLength(0);
    } finally {
      if (ci === undefined) delete process.env.CI;
      else process.env.CI = ci;
      setDefaultGateway(prev);
    }
  });
});

describe('IMPL-048 — o próprio motor de treino recusa papéis misturados (defesa em profundidade)', () => {
  const CFG = { ...TRAINING, techniqueIds: ['persona'] } as unknown as TrainingConfig;
  it('Node e SPA: referência = juiz / 2º gabarito = modelo sob teste / sem referência ⇒ rejeita ANTES de gravar ou chamar', async () => {
    const ruins = [
      { ...CFG, referenceModelId: 'acme/judge' },
      { ...CFG, secondReferenceModelId: 'acme/alpha' },
      { ...CFG, referenceModelId: undefined },
    ] as TrainingConfig[];
    const msg = /referência|2º gabarito|referenceModelId/;
    for (const c of ruins) {
      await expect(trainToCompletion(c, 'sk-x')).rejects.toThrow(msg);
      await expect(startTraining(c, 'sk-x')).rejects.toThrow(msg);
      await expect(startWebTraining(c as never, 'sk-x')).rejects.toThrow(msg);
    }
  });
});
