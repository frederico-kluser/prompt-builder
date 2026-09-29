// IMPL-048 (R-03a:REC-2) na SPA — papéis separados valem FORA do servidor.
//
// No Node a regra vivia só no `runConfigSchema` (zod). A SPA (produção = site
// estático) não passa por ele: o formulário não exigia gabarito em teste/treino
// e o motor do navegador caía no `judgeModelIds[0]` — o 1º juiz escrevia a
// régua e julgava contra ela, exatamente o que o IMPL-048 proíbe. Contratos:
//  (i)   a regra é FONTE ÚNICA (src/engine/roleSeparation.ts) e o schema do
//        Node reporta exatamente o que ela diz (mesmas mensagens);
//  (ii)  o portão da SPA (api.createRun/createSession) recusa ANTES do motor e
//        de qualquer fetch: train/vary sem referência, referência = juiz,
//        referência = competidor/modelo sob teste;
//  (iii) config com papéis distintos passa pelo portão (o motor é chamado);
//  (iv)  o formulário mostra a mesma pendência (texto da tela) e o default de
//        gabarito dos modos de prompt é um modelo LIVRE — o default da Nova Run
//        passa no schema do Node.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertRoleSeparation,
  roleConflictMessage,
  roleSeparationIssues,
} from '../src/engine/roleSeparation.js';
import { parseRunConfig } from '../src/runConfigSchema.js';

const { startRun, startTraining } = vi.hoisted(() => ({
  startRun: vi.fn(() => ({ runId: 'run-mock', record: { id: 'run-mock', status: 'running' } })),
  startTraining: vi.fn(async () => ({ sessionId: 'sess-mock', record: { id: 'sess-mock', status: 'running' } })),
}));

// Motor trocado por mocks: nenhum LLM é chamado, nada é gasto.
vi.mock('../web/src/engine/orchestrator', () => ({
  startRun,
  cancelRun: () => false,
  isRunCancellable: () => false,
}));
vi.mock('../web/src/engine/trainer', () => ({
  startTraining,
  cancelTraining: () => false,
  isTrainingCancellable: () => false,
}));

const api = await import('../web/src/api.js');
const rules = await import('../web/src/newRunRules.js');
const arena = await import('../web/src/arenaForm.js');

function memoryLocalStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

const VARIATION = {
  mode: 'variation',
  theme: 'suporte',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  contestantModelId: 'fake/a',
  basePrompt: 'prompt base do usuario',
  techniqueIds: ['tecnica-a', 'tecnica-b'],
};
const TRAINING = { ...VARIATION, mode: 'training', iterations: 2 };
const COMPARE = {
  mode: 'compare',
  theme: 'suporte',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  competitorModelIds: ['fake/a', 'fake/b'],
};

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryLocalStorage());
  api.setStoredKey('sk-or-v1-teste-papeis');
  startRun.mockClear();
  startTraining.mockClear();
});

describe('IMPL-048 (i) — regra única: o schema do Node diz o que a função pura diz', () => {
  const casos: [string, Record<string, unknown>][] = [
    ['variation sem referência', VARIATION],
    ['training sem referência', TRAINING],
    ['variation ref = juiz', { ...VARIATION, referenceModelId: 'fake/judge' }],
    ['variation ref = sob teste', { ...VARIATION, referenceModelId: 'fake/a' }],
    ['compare ref = juiz', { ...COMPARE, referenceModelId: 'fake/judge' }],
    ['compare ref = competidor', { ...COMPARE, referenceModelId: 'fake/b' }],
    [
      'compare-llms ref = config',
      { ...COMPARE, competitorModelIds: undefined, competitorConfigs: [{ modelId: 'fake/a' }, { modelId: 'fake/b' }], referenceModelId: 'fake/a' },
    ],
  ];
  for (const [nome, cfg] of casos) {
    it(`${nome}: cada conflito da função pura sai no schema com a MESMA mensagem`, () => {
      const issues = roleSeparationIssues(cfg);
      expect(issues.length).toBeGreaterThan(0);
      const r = parseRunConfig(cfg);
      expect(r.ok).toBe(false);
      if (!r.ok) for (const c of issues) expect(r.error).toContain(roleConflictMessage(c).slice(0, 60));
    });
  }

  it('papéis distintos: nenhum conflito, schema aceita, portão puro não lança', () => {
    for (const cfg of [
      { ...VARIATION, referenceModelId: 'fake/ref' },
      { ...TRAINING, referenceModelId: 'fake/ref' },
      COMPARE, // compare sem referência = default documentado (1º juiz)
      { ...COMPARE, referenceModelId: 'fake/ref' },
    ]) {
      expect(roleSeparationIssues(cfg)).toEqual([]);
      expect(parseRunConfig(cfg).ok).toBe(true);
      expect(() => assertRoleSeparation(cfg)).not.toThrow();
    }
  });
});

describe('IMPL-048 (ii)+(iii) — portão da SPA: recusa antes do motor e de qualquer fetch', () => {
  it('createSession (training) sem referência recusa com a mensagem do schema', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const err = await api.createSession(TRAINING as never, { costConfirmed: true }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/referenceModelId [ée] obrigat[óo]rio em training\/variation/);
    expect(startTraining).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('createRun (variation) sem referência, ref = juiz ou ref = modelo sob teste: recusa', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const [cfg, re] of [
      [VARIATION, /obrigat[óo]rio em training\/variation/],
      [{ ...VARIATION, referenceModelId: 'fake/judge' }, /n[ãa]o pode ser tamb[ée]m juiz/],
      [{ ...VARIATION, referenceModelId: 'fake/a' }, /n[ãa]o pode ser tamb[ée]m competidor/],
      [{ ...COMPARE, referenceModelId: 'fake/b' }, /n[ãa]o pode ser tamb[ée]m competidor/],
    ] as const) {
      const err = await api.createRun(cfg as never, { costConfirmed: true }).catch((e: unknown) => e);
      expect(err, JSON.stringify(cfg)).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(re);
    }
    expect(startRun).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('papéis distintos passam pelo portão e chegam ao motor', async () => {
    expect(await api.createRun({ ...VARIATION, referenceModelId: 'fake/ref' } as never, { costConfirmed: true })).toBe(
      'run-mock',
    );
    expect(await api.createRun(COMPARE as never, { costConfirmed: true })).toBe('run-mock');
    expect(
      await api.createSession({ ...TRAINING, referenceModelId: 'fake/ref' } as never, { costConfirmed: true }),
    ).toBe('sess-mock');
    expect(startRun).toHaveBeenCalledTimes(2);
    expect(startTraining).toHaveBeenCalledTimes(1);
  });

  it('sem key a resposta continua sendo o RE-PROMPT (IMPL-082), antes da regra de papéis', async () => {
    api.setStoredKey('');
    const err = await api.createSession(TRAINING as never, { costConfirmed: true }).catch((e: unknown) => e);
    expect(api.isKeyMissing(err)).toBe(true);
  });
});

describe('IMPL-048 (iv) — o formulário: pendência na tela e default de gabarito livre', () => {
  it('referenceProblemTexts: mesma regra, texto da tela, nomeando o modelo', () => {
    const base = { judges: ['j/1', 'j/2'], competitors: ['c/1', 'c/2'], contestant: 'c/1' };
    expect(rules.referenceProblemTexts({ ...base, mode: 'variation' })[0]).toMatch(/Escolha o modelo do gabarito/);
    expect(rules.referenceProblemTexts({ ...base, mode: 'training', reference: 'j/2' })[0]).toMatch(
      /O gabarito \(j\/2\) não pode ser também juiz/,
    );
    expect(rules.referenceProblemTexts({ ...base, mode: 'variation', reference: 'c/1' })[0]).toMatch(
      /não pode ser também o modelo sob teste/,
    );
    expect(rules.referenceProblemTexts({ ...base, mode: 'compare', reference: 'c/2' })[0]).toMatch(
      /não pode ser também competidor/,
    );
    // compare sem gabarito = default documentado; papéis distintos = silêncio
    expect(rules.referenceProblemTexts({ ...base, mode: 'compare' })).toEqual([]);
    expect(rules.referenceProblemTexts({ ...base, mode: 'training', reference: 'r/1' })).toEqual([]);
  });

  it('default de gabarito: 1º preferido LIVRE — e o default da Nova Run passa no schema do Node', () => {
    const ref = rules.defaultReferenceFor(arena.DEFAULT_JUDGES, [arena.DEFAULT_CONTESTANT]);
    expect(ref).toBeTruthy();
    expect(arena.PREFERRED_JUDGES).toContain(ref);
    expect(arena.DEFAULT_JUDGES).not.toContain(ref);
    expect(ref).not.toBe(arena.DEFAULT_CONTESTANT);
    for (const mode of ['variation', 'training'] as const) {
      const cfg = {
        mode,
        theme: arena.DEFAULT_THEME,
        stages: 5,
        datagenModelId: arena.DEFAULT_DATAGEN,
        judgeModelIds: arena.DEFAULT_JUDGES,
        contestantModelId: arena.DEFAULT_CONTESTANT,
        techniqueIds: arena.DEFAULT_TECHNIQUES,
        referenceModelId: ref,
        ...(mode === 'training' ? { iterations: 3 } : {}),
      };
      const r = parseRunConfig(cfg);
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
    }
    // Sem candidato livre: nada de default inventado (vira pendência na tela).
    expect(rules.defaultReferenceFor(arena.PREFERRED_JUDGES, [])).toBeUndefined();
  });
});
