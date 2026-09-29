// left#13 (IMPL-048 / web-code#15) — defesa em profundidade DENTRO dos motores.
//
// O schema do servidor/CLI/MCP e o portão da SPA (api.ts) já barram papéis
// misturados e nº de cenários fora da faixa, mas quem chama o motor direto
// (teste, biblioteca, import de JSON que pula o formulário) passava ileso:
//   • referência = juiz (ou juiz da cascata competindo) rodava a run inteira
//     com erros correlacionados — agora os DOIS orquestradores recusam antes
//     de QUALQUER chamada (nem o catálogo), com a mensagem canônica;
//   • `stages` 0 terminava 'inconclusive' sem nada rodado e 2.5 virava "alvo:
//     2.5" no pedido ao gerador — agora os dois orquestradores e os dois
//     trainers normalizam para inteiro 1–50 (e avisam).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { trainToCompletion } from '../src/trainer.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { cancelTraining, startTraining as startWebTraining } from '../web/src/engine/trainer.js';
import { normalizeStageCount, withStageCountInRange } from '../src/engine/stageCount.js';
import { roleConflictMessage } from '../src/engine/roleSeparation.js';
import type { RunConfig, RunRecord, TrainingConfig } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter } from './fakeOpenRouter.js';

vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => true,
  saveSession: async () => true,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const MODELOS = ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b'];
const COMPARE = {
  mode: 'compare',
  theme: 'guardas do motor',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  finalists: 2,
  timeoutMs: 60_000,
} as const;

let anterior: OpenRouterGateway | undefined;
let dir: string;
let dirAnterior: string;
let silencio: Array<{ mockRestore(): void }> = [];

function fake(): FakeOpenRouter {
  const f = fakeOpenRouter({ catalog: MODELOS.map((id) => catalogItem(id, 1e-3, 1e-3)) });
  anterior ??= setDefaultGateway(createGateway({ fetch: f.fetch, sleep: noSleep }));
  return f;
}

beforeEach(() => {
  dirAnterior = getDataDir();
  dir = mkdtempSync(path.join(tmpdir(), 'pb-guards-'));
  setDataDir(dir);
  silencio = (['log', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
  setDataDir(dirAnterior);
  rmSync(dir, { recursive: true, force: true });
  silencio.forEach((s) => s.mockRestore());
});

const motores = [
  ['Node', (cfg: unknown) => runNode(cfg as RunConfig, KEY, {}) as Promise<RunRecord>],
  ['SPA', (cfg: unknown) => runWeb(cfg as never, KEY, {}) as unknown as Promise<RunRecord>],
] as const;

describe('left#13 — papéis separados nos DOIS orquestradores (antes de qualquer chamada)', () => {
  for (const [nome, run] of motores) {
    it(`${nome}: referência = juiz ⇒ 'error' com a mensagem canônica, 0 requisições`, async () => {
      const f = fake();
      const rec = await run({ ...COMPARE, referenceModelId: 'fake/judge' });
      expect(rec.status).toBe('error');
      expect(rec.error).toBe(roleConflictMessage({ kind: 'reference-is-judge', ref: 'fake/judge' }));
      expect(f.requests, 'nem o catálogo foi pedido').toEqual([]);
    });

    it(`${nome}: juiz da cascata competindo ⇒ recusa; variation sem referência ⇒ recusa`, async () => {
      const f = fake();
      const cascata = await run({ ...COMPARE, judgeCascade: { cheap: ['fake/a', 'fake/judge'], strong: 'fake/judge' } });
      expect(cascata.status).toBe('error');
      expect(cascata.error).toContain('judgeCascade');
      const semRef = await run({
        ...COMPARE,
        mode: 'variation',
        referenceModelId: undefined,
        competitorModelIds: undefined,
        contestantModelId: 'fake/a',
        basePrompt: 'Voce e um atendente.',
      });
      expect(semRef.status).toBe('error');
      expect(semRef.error).toMatch(/referenceModelId é obrigatório/);
      expect(f.requests).toEqual([]);
    });
  }
});

describe('left#13 — nº de cenários na faixa documentada (inteiro 1–50)', () => {
  it('normalizeStageCount / withStageCountInRange', () => {
    expect([0, -3, 0.4, 1, 2.5, 2.49, 50, 51, 1e9, Infinity].map(normalizeStageCount)).toEqual([1, 1, 1, 1, 3, 2, 50, 50, 50, 50]);
    expect(normalizeStageCount(Number.NaN)).toBe(1);
    expect(normalizeStageCount('7')).toBe(1);
    const ok = { stages: 5 };
    expect(withStageCountInRange(ok)).toBe(ok); // mesma referência
    expect(withStageCountInRange({ stages: 2.5 })).toEqual({ stages: 3 });
    const sem = { customStages: [] as unknown[] } as { stages?: number };
    expect(withStageCountInRange(sem)).toBe(sem); // ausente fica ausente
  });

  for (const [nome, run] of motores) {
    it(`${nome}: 0 / 2.5 / 80 viram 1 / 3 / 50 no record e nos slots (antes de gastar)`, async () => {
      for (const [pedido, efetivo] of [
        [0, 1],
        [2.5, 3],
        [80, 50],
      ] as const) {
        const f = fake();
        // Teto minúsculo: a porta G1 para ANTES do datagen — nada é pago, mas
        // os slots das etapas já nasceram com o alvo efetivo.
        const rec = await run({ ...COMPARE, stages: pedido, budgetUsd: 1e-9 });
        expect(rec.config.stages, `stages ${pedido}`).toBe(efetivo);
        expect(rec.stages).toHaveLength(efetivo);
        expect(rec.stoppedReason).toBe('budget');
        expect(f.chatRequests()).toEqual([]);
      }
    });
  }

  it('trainers (Node e SPA): a sessão nasce com stages na faixa', async () => {
    fake();
    const TREINO = {
      ...COMPARE,
      mode: 'training',
      competitorModelIds: undefined,
      contestantModelId: 'fake/a',
      basePrompt: 'Voce e um atendente de suporte.',
      techniqueIds: ['persona'],
      iterations: 1,
      holdoutRatio: 0,
      stages: 2.5,
      budgetUsd: 1e-9,
    } as unknown as TrainingConfig;
    const sessao = await trainToCompletion(TREINO, KEY);
    expect(sessao.config.stages).toBe(3);
    const { sessionId, record } = await startWebTraining(TREINO as never, KEY);
    expect((record as { config: { stages: number } }).config.stages).toBe(3);
    cancelTraining(sessionId);
  });
});
