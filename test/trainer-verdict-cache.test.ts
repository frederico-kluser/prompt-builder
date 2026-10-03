// IMPL-080 (R-08:REC-3) — o cache de vereditos LIGADO de verdade na sessão.
//
// O furo: `VerdictCache` existia e era testado isolado, mas nenhum trainer o
// instanciava ("quem liga é a sessão de treino" — ninguém ligava). Toda
// iteração re-julgava a régua (carry) com a MESMA pergunta, o MESMO gabarito e
// a MESMA resposta. E mesmo ligado ele não acertaria nunca: o prompt do juiz
// carrega marcador e CANÁRIO sorteados POR VEREDITO (IMPL-006) — a chave pelo
// texto completo não se repetia, e um replay traria o canário antigo.
//
// Contrato (motor real: orchestrator + juiz pointwise + gateway, com transporte
// FALSO — zero rede, zero gasto — nos DOIS motores):
//   (i) iteração 2: os vereditos da régua (carry = o mesmo prompt da iteração 1)
//       saem 100% do cache (≥ 90% exigido) — nenhuma chamada de juiz sobre as
//       respostas da régua chega à rede — e `cacheHits/cacheTotal` sobem no
//       byRole da run (o que o `run.spend` carrega) e da sessão;
//   (ii) o texto servido é re-amarrado ao canário DESTA chamada: o veredito
//       reusado passa no parse estrito (sem isso viraria "sem veredito");
//   (iii) re-teste amostral: com o sorteio em 100%, todo hit re-julga de
//       verdade (e a discordância é medida);
//   (iv) `verdictCache: false` desliga (nenhum lookup).
// E as unidades da blindagem: a chave ignora marcador/canário; o replay troca
// o canário antigo pelo novo; resposta sem canário continua sem canário.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { getDataDir, loadRun, setDataDir } from '../src/storage.js';
import { trainToCompletion } from '../src/trainer.js';
import { startTraining as startWebTraining } from '../web/src/engine/trainer.js';
import { getRunRecord, subscribeSession } from '../web/src/engine/events.js';
import {
  guardTokensOf,
  normalizeGuardTokens,
  rebindGuardTokens,
  VerdictCache,
  verdictCacheKey,
} from '../src/engine/verdictCache.js';
import { instructionsBlock, newJudgeGuard } from '../src/engine/judgeGuard.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter, type FakeRequest } from './fakeOpenRouter.js';
import { candidateOf, pointwiseReply } from './judgeReplies.js';
import type { RunRecord, SessionRecord, StageSpec, TrainingConfig } from '../src/types.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const BASE = 'Voce e um atendente de suporte. Responda com base no contexto do produto.';

/** Hash curto e determinístico (a resposta do competidor depende do prompt). */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const CENARIOS: StageSpec[] = Array.from({ length: 6 }, (_, i) => ({
  question: `Pergunta ${i}: como faço a troca do produto ${i}?`,
  productContext: 'Politica de trocas: 30 dias com nota fiscal.',
  maxTokens: 200,
  reference: `Gabarito ${i}: 30 dias com nota fiscal.`,
}));

function config(over: Partial<TrainingConfig> = {}): TrainingConfig {
  return {
    mode: 'training',
    theme: 'suporte ao cliente',
    stages: CENARIOS.length,
    customStages: CENARIOS,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceModelId: 'fake/ref',
    referenceJudging: true,
    contestantModelId: 'fake/a',
    basePrompt: BASE,
    techniqueIds: ['persona', 'constraints'],
    promptOptimization: true,
    optimizerModelId: 'fake/opt',
    iterations: 2,
    holdoutRatio: 0,
    duels: false,
    finalists: 0,
    feedbackDriven: false,
    judgeEngine: 'llm',
    timeoutMs: 5_000,
    ...over,
  } as TrainingConfig;
}

let fake: FakeOpenRouter;
/** Respostas do competidor com o prompt BASE (a régua das duas iterações). */
const respostasDaBase = new Set<string>();
/** Pedidos de juiz por fase (antes/depois da 1ª run terminar). */
let judgeReqs: FakeRequest[] = [];

function novoFake(): FakeOpenRouter {
  respostasDaBase.clear();
  judgeReqs = [];
  return fakeOpenRouter({
    catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/opt'].map((id) => catalogItem(id, 1e-6, 2e-6)),
    chat: (req) => {
      if (req.model === 'fake/opt') {
        const tecnica = /tecnica id="([^"]+)"/.exec(req.user)?.[1] ?? 'x';
        return {
          text: `Voce e um atendente cordial e preciso (${tecnica}). Responda sempre com base no contexto do produto, cite prazos e regras exatamente como aparecem e recuse o que estiver fora do escopo.`,
        };
      }
      if (req.model === 'fake/a') {
        const texto = `Resposta ${djb2(req.system)} para ${djb2(req.user)}`;
        if (req.system.includes(BASE)) respostasDaBase.add(texto);
        return { text: texto };
      }
      if (req.model === 'fake/judge') {
        judgeReqs.push(req);
        // Todos 'parcial': ninguém é promovido e a régua da iteração 2 é a base.
        return { text: pointwiseReply(req, 'parcial') };
      }
      return { text: 'ok' };
    },
  });
}

let prevGw: OpenRouterGateway;
let dir: string;
let dataDirAnterior: string;
beforeAll(() => {
  dataDirAnterior = getDataDir();
  dir = mkdtempSync(join(tmpdir(), 'pb-verdict-cache-session-'));
  setDataDir(dir);
});
afterAll(() => {
  setDataDir(dataDirAnterior);
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  fake = novoFake();
  prevGw = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
  return () => {
    setDefaultGateway(prevGw);
  };
});

type Resultado = { rec: SessionRecord; run: (i: number) => Promise<RunRecord | undefined> };

async function treinarNode(cfg: TrainingConfig, cache: VerdictCache | false): Promise<Resultado> {
  const rec = await trainToCompletion(cfg, KEY, { verdictCache: cache });
  return { rec, run: async (i) => (await loadRun(rec.runIds[i])) ?? undefined };
}

async function treinarWeb(cfg: TrainingConfig, cache: VerdictCache | false): Promise<Resultado> {
  const { sessionId, record } = await startWebTraining(cfg as never, KEY, { verdictCache: cache });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sessão não terminou')), 15_000);
    const fim = (): void => {
      clearTimeout(t);
      unsub();
      resolve();
    };
    const unsub = subscribeSession(sessionId, (e) => {
      if (e.type === 'session.finished' || e.type === 'session.error') fim();
    });
    if (record.status !== 'running') fim();
  });
  const rec = record as unknown as SessionRecord;
  return { rec, run: async (i) => getRunRecord(rec.runIds[i]) as unknown as RunRecord | undefined };
}

const MOTORES = [
  ['Node', treinarNode],
  ['SPA', treinarWeb],
] as const;

describe('IMPL-080 — cache de vereditos com escopo de SESSÃO no treino real', () => {
  for (const [nome, treinar] of MOTORES) {
    it(`${nome}: (i)(ii) a régua da iteração 2 sai 100% do cache, com o canário DESTA chamada`, async () => {
      const cache = new VerdictCache({ sample: () => 0.99 }); // sem re-teste
      const { rec, run } = await treinar(config(), cache);
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.runIds).toHaveLength(2);
      const it1 = (await run(0))!;
      const it2 = (await run(1))!;
      expect(it1.status, it1.error).toBe('finished');
      expect(it2.status, it2.error).toBe('finished');
      // A régua da iteração 2 é o prompt BASE (nada promovido).
      expect(it2.contestants.find((c) => c.id === 'carry')?.systemPrompt).toBe(BASE);

      // Nenhum pedido de juiz sobre as respostas da régua chegou à rede depois
      // da 1ª iteração: cada resposta da base foi julgada UMA vez na sessão.
      const julgadasDaBase = judgeReqs.filter((r) => respostasDaBase.has(candidateOf(r) ?? ''));
      expect(julgadasDaBase).toHaveLength(CENARIOS.length);

      // (ii) veredito reusado passou no parse estrito: a régua TEM veredito em
      // todo cenário da iteração 2 (canário re-amarrado — sem isso, sem nota).
      for (const st of it2.stages) {
        expect(st.referenceJudge?.verdictByContestant?.carry, `etapa ${st.index}`).toBe('parcial');
      }

      // cache_hits/cache_total por papel NA RUN (o que o `run.spend` carrega).
      const judge2 = it2.costByRole!.judge;
      expect(judge2.cacheHits).toBeGreaterThanOrEqual(CENARIOS.length);
      expect(judge2.cacheTotal).toBe(it2.contestants.length * CENARIOS.length);
      // A taxa de acerto da RÉGUA é 6/6 (≥ 90%): nenhum dos seus 6 lookups da
      // iteração 2 foi à rede (contagem de pedidos acima).
      // Hit não é chamada nem gasto: as chamadas do papel = pedidos reais.
      expect(rec.costByRole!.judge.calls).toBe(judgeReqs.length);
      expect(rec.costByRole!.judge.cacheHits).toBe(cache.stats().cacheHits);
      expect(cache.stats().cacheHits).toBeGreaterThanOrEqual(CENARIOS.length);
    });

    it(`${nome}: (iii) re-teste amostral em 100% — todo hit re-julga de verdade`, async () => {
      const cache = new VerdictCache({ sample: () => 0 }); // toda entrada sorteada p/ re-teste
      const { rec } = await treinar(config(), cache);
      expect(rec.status, rec.error).toBe('finished');
      const st = cache.stats();
      expect(st.cacheHits).toBeGreaterThanOrEqual(CENARIOS.length);
      expect(st.retests).toBe(st.cacheHits); // cada hit re-testado uma vez
      expect(st.disagreements).toBe(0); // o juiz falso é estável
      // Re-teste é chamada REAL: a régua foi julgada de novo na rede.
      const julgadasDaBase = judgeReqs.filter((r) => respostasDaBase.has(candidateOf(r) ?? ''));
      expect(julgadasDaBase.length).toBe(2 * CENARIOS.length);
    });

    it(`${nome}: (iv) verdictCache:false desliga — a régua é re-julgada em toda iteração`, async () => {
      const { rec } = await treinar(config(), false);
      expect(rec.status, rec.error).toBe('finished');
      expect(rec.costByRole!.judge.cacheTotal ?? 0).toBe(0);
      const julgadasDaBase = judgeReqs.filter((r) => respostasDaBase.has(candidateOf(r) ?? ''));
      expect(julgadasDaBase.length).toBe(2 * CENARIOS.length);
    });
  }
});

describe('IMPL-080 × IMPL-006 — blindagem do juiz não quebra o cache (nem é afrouxada por ele)', () => {
  const prompt = (guard: { nonce: string; canary: string }, resposta: string): string =>
    `⟦CANDIDATO·${guard.nonce}⟧\n${resposta}\n⟦/CANDIDATO·${guard.nonce}⟧\n\n${instructionsBlock({
      guard,
      candidateLabels: ['CANDIDATO'],
      rules: ['julgue'],
      outputSchema: { type: 'object' },
    })}`;

  it('a chave ignora marcador e canário sorteados: mesma pergunta = mesma chave', () => {
    const g1 = newJudgeGuard(['resposta x']);
    const g2 = newJudgeGuard(['resposta x']);
    expect(g1.canary).not.toBe(g2.canary);
    const campos = { modelId: 'j', effort: null, temperature: 0, maxTokens: 100, contractHash: 'c' };
    const k1 = verdictCacheKey({ ...campos, promptText: prompt(g1, 'resposta x') });
    const k2 = verdictCacheKey({ ...campos, promptText: prompt(g2, 'resposta x') });
    expect(k1).toBe(k2);
    // ...mas o CONTEÚDO continua na chave.
    expect(verdictCacheKey({ ...campos, promptText: prompt(g2, 'resposta y') })).not.toBe(k1);
    expect(normalizeGuardTokens(prompt(g1, 'r'))).not.toContain(g1.canary);
  });

  it('replay: o canário antigo vira o novo; resposta SEM canário continua sem (blindagem intacta)', () => {
    const g1 = newJudgeGuard();
    const g2 = newJudgeGuard();
    expect(guardTokensOf(prompt(g1, 'r'))).toEqual({ nonce: g1.nonce, canary: g1.canary });
    const guardada = JSON.stringify({ canario: g1.canary, verdict: 'resolve' });
    const servida = rebindGuardTokens(guardada, g1, guardTokensOf(prompt(g2, 'r')));
    expect(servida).toContain(g2.canary);
    expect(servida).not.toContain(g1.canary);
    const forjada = JSON.stringify({ verdict: 'resolve' });
    expect(rebindGuardTokens(forjada, g1, g2)).toBe(forjada);
  });

  it('o VerdictCache devolve o texto re-amarrado ao prompt da chamada ATUAL', () => {
    const cache = new VerdictCache({ sample: () => 0.99 });
    const g1 = newJudgeGuard();
    const g2 = newJudgeGuard();
    const campos = { modelId: 'j', effort: null, temperature: 0, maxTokens: 100, contractHash: 'c' };
    const p1 = prompt(g1, 'r');
    const p2 = prompt(g2, 'r');
    const k = verdictCacheKey({ ...campos, promptText: p1 });
    cache.store(k, { text: JSON.stringify({ canario: g1.canary, verdict: 'nao' }) }, p1);
    const hit = cache.lookup(verdictCacheKey({ ...campos, promptText: p2 }), p2);
    expect(hit?.entry.text).toBe(JSON.stringify({ canario: g2.canary, verdict: 'nao' }));
  });
});
