// web-code#12 — a regra "quais etapas formam o judge-score" é FONTE ÚNICA
// (`stageCountsInJudgeScore`/`judgeScoreTally` em src/engine/verdictAggregate.ts).
//
// A tela somava também os vereditos LISTWISE das etapas cujo gabarito falhou
// (ou foi descartado por truncamento) e a nota/ordem do heatmap divergia do
// `judgeScoreByContestant` oficial (finalistas, pódio, campeão). Aqui: numa
// run com uma etapa listwise (gabarito vazio), a contagem da regra única
// reproduz EXATAMENTE a nota oficial nos dois motores — e a contagem ingênua
// (todas as etapas) não.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway, type FetchLike } from '../src/openrouter.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { judgeScoreTally, stageCountsInJudgeScore } from '../src/engine/verdictAggregate.js';
import { GABARITO_ROLE_PROMPT } from '../src/gabarito.js';
import type { RunConfig, RunRecord, StageSpec } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { candidateOf, listwiseReply, pointwiseReply } from './judgeReplies.js';

vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const ETAPAS: StageSpec[] = [
  { question: 'CEN-0 Prazo?', productContext: 'c', maxTokens: 200, reference: 'R0' },
  { question: 'CEN-1 Prazo?', productContext: 'c', maxTokens: 200, reference: 'R1' },
  // Sem gabarito e o gabarito gerado vem VAZIO ⇒ etapa julgada LISTWISE.
  { question: 'CEN-L Horário?', productContext: 'c', maxTokens: 200 },
];
const CFG = {
  mode: 'compare',
  theme: 'suporte',
  stages: 3,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  customStages: ETAPAS,
  finalists: 0,
  duels: false,
  timeoutMs: 5_000,
} as unknown as RunConfig;

function gateway(): FetchLike {
  return fakeOpenRouter({
    catalog: ['fake/judge', 'fake/a', 'fake/b', 'fake/ref', 'fake/gen'].map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: (req) => {
      if (req.stream) return { text: `Resposta de ${req.model}` };
      if (req.system === GABARITO_ROLE_PROMPT) return { text: '' };
      if (req.system.includes('juiz imparcial')) {
        const labels = JSON.parse(/rotulos (\[[^\]]*\])/.exec(req.user)![1]) as string[];
        // No listwise o fake/a é 'resolve' (na referência ele é 'nao').
        return { text: listwiseReply(req, labels, labels.map((label) => ({ label, justificativa: 'x', veredito: 'resolve' }))) };
      }
      return { text: pointwiseReply(req, candidateOf(req) === 'Resposta de fake/a' ? 'nao' : 'resolve') };
    },
  }).fetch;
}

describe('web-code#12 — contagem do judge-score = regra única', () => {
  let tmp: string;
  let dirAnterior: string;
  let silencio: Array<{ mockRestore(): void }> = [];
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-wc12-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
  });
  afterAll(() => {
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  for (const [nome, rodar] of [
    ['Node', (cfg: RunConfig) => runNode(cfg, KEY, {})],
    ['SPA', (cfg: RunConfig) => runWeb(cfg as never, KEY, {}) as unknown as Promise<RunRecord>],
  ] as const) {
    it(`${nome}: a etapa listwise fica FORA; a contagem da regra reproduz a nota oficial`, async () => {
      const anterior = setDefaultGateway(createGateway({ fetch: gateway(), sleep: noSleep }));
      let rec: RunRecord;
      try {
        rec = await rodar(CFG);
      } finally {
        setDefaultGateway(anterior);
      }
      expect(rec.stages[2].referenceJudge).toBeUndefined(); // julgada listwise
      expect(rec.stages.map(stageCountsInJudgeScore)).toEqual([true, true, false]);
      for (const c of rec.contestants) {
        const t = judgeScoreTally(rec.stages, c.id);
        const nota = t.judged ? ((t.resolve + 0.5 * t.parcial) / t.judged) * 100 : null;
        expect(nota, c.id).toBe(rec.judgeScoreByContestant?.[c.id]);
      }
      // A contagem ingênua (que a tela fazia) daria outro número para o fake/a.
      expect(rec.judgeScoreByContestant?.['fake/a']).toBe(0);
    });
  }
});
