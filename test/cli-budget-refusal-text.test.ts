// cli#17 — a recusa "orçamento abaixo do piso" leva a um 2º tropeço com
// mensagem FALSA: `train --budget 0.5` (piso $4) dizia "passe --force"; com
// `--force` fora de um terminal vinha `usage.confirmation_required` dizendo
// que $0.50 estava "DENTRO da faixa estimada ($4.10 – $5.46)". O portão fica
// (a run abaixo do piso fora de TTY exige --force E --yes); o TEXTO passa a
// dizer a verdade e a 1ª dica já nomeia as duas flags.

import { describe, expect, it } from 'vitest';
import { runPreflight } from '../src/cli/preflight.js';
import { createGateway, type FetchLike } from '../src/openrouter.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import type { RunConfig } from '../src/types.js';

const KEY = `sk-or-v1-${'a'.repeat(48)}`;

async function modelos() {
  const fake = fakeOpenRouter({
    catalog: [catalogItem('acme/alpha', 1e-6, 2e-6), catalogItem('acme/beta', 2e-6, 4e-6), catalogItem('acme/judge', 3e-6, 1.5e-5)],
    keyData: { label: 'fake', usage: 0, limit: null, limit_remaining: null },
    chat: () => ({ status: 500, bodyText: 'sem chat aqui' }),
  });
  const fetch: FetchLike = (url, init) => fake.fetch(url, init);
  return createGateway({ fetch, sleep: noSleep }).listModels('', true);
}

const CONFIG = {
  mode: 'compare',
  theme: 't',
  stages: 4,
  datagenModelId: 'acme/judge',
  judgeModelIds: ['acme/judge'],
  competitorModelIds: ['acme/alpha', 'acme/beta'],
  budgetUsd: 1e-9,
} as RunConfig;

async function recusa(flags: { force: boolean; yes: boolean; agentContext: boolean }) {
  const models = await modelos();
  const deps = {
    loadCatalog: async () => ({ models, catalogSource: 'disk' as const, catalogScope: 'key' as const, fetchedAt: Date.now() }),
    checkKey: async () => ({ limitRemainingUsd: 1_000 }),
    info: () => undefined,
    warn: () => undefined,
  };
  const input = { config: CONFIG, budget: { kind: 'usd' as const, usd: 1e-9 }, apiKey: KEY, ...flags };
  try {
    await runPreflight(input, deps, 'real');
  } catch (e) {
    return e as { errorCode: string; message: string; hint?: string; details: Record<string, unknown> };
  }
  return null;
}

describe('cli#17 — --force abaixo do piso, fora de um terminal', () => {
  it('1ª recusa (sem --force) já nomeia `--force --yes` quando não há TTY', async () => {
    const e = await recusa({ force: false, yes: false, agentContext: true });
    expect(e?.errorCode).toBe('usage.budget_below_estimate');
    expect(e?.hint).toContain('--force --yes');
    expect(e?.message).toContain('--force --yes');
    expect(e?.details.requiredFlags).toEqual(['--force', '--yes']);
  });

  it('com --force sem --yes a 2ª recusa diz ABAIXO do piso (não "dentro da faixa") e pede `--force --yes`', async () => {
    const e = await recusa({ force: true, yes: false, agentContext: true });
    expect(e?.errorCode).toBe('usage.confirmation_required');
    expect(e?.message).toMatch(/ABAIXO do piso/);
    expect(e?.message).not.toMatch(/dentro da faixa/);
    expect(e?.hint).toContain('--force --yes');
    expect(e?.details.belowFloor).toBe(true);
  });

  it('com --force --yes passa (o portão continua o mesmo)', async () => {
    expect(await recusa({ force: true, yes: true, agentContext: true })).toBeNull();
  });

  it('num terminal (humano confirma no prompt) a dica fala só de --force', async () => {
    const e = await recusa({ force: false, yes: false, agentContext: false });
    expect(e?.errorCode).toBe('usage.budget_below_estimate');
    expect(e?.hint).toContain('--force');
    expect(e?.hint).not.toContain('--yes');
  });

  it('dentro da faixa (sem --yes) a mensagem de sempre continua: "dentro da faixa"', async () => {
    const models = await modelos();
    const deps = {
      loadCatalog: async () => ({ models, catalogSource: 'disk' as const, catalogScope: 'key' as const, fetchedAt: Date.now() }),
      checkKey: async () => ({ limitRemainingUsd: 1_000 }),
      info: () => undefined,
      warn: () => undefined,
    };
    const dry = await runPreflight(
      { config: CONFIG, budget: { kind: 'usd' as const, usd: 1e-9 }, apiKey: KEY, force: false, yes: false, agentContext: true },
      deps,
      'dry-run',
    );
    const meio = (dry.estimate.low + dry.estimate.high) / 2;
    const cfg = { ...CONFIG, budgetUsd: meio } as RunConfig;
    const r = await runPreflight(
      { config: cfg, budget: { kind: 'usd' as const, usd: meio }, apiKey: KEY, force: false, yes: false, agentContext: true },
      deps,
      'dry-run',
    );
    const c = r.wouldRefuse.find((x) => x.code === 'usage.confirmation_required');
    expect(c?.message).toMatch(/dentro da faixa/);
  });
});
