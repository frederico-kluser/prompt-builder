// Treino real (orchestrator + papéis + gateway) com transporte FALSO nos DOIS
// motores — zero rede, zero gasto.
//
//   IMPL-075  modo AUDITÁVEL por sessão/run: `config.auditable` (schema,
//             arena-config `judging.auditable`, CLI `--auditable`) chega a
//             TODA iteração (whitelist `variationConfigFrom`) e o gateway manda
//             juiz e gabarito com `allow_fallbacks:false` +
//             `require_parameters:true` — visível no artefato
//             (`costByRole.judge.auditableCalls`, `callLog[].auditable`). O
//             competidor NÃO trava provedor (é a variância que se mede). E o
//             provedor que serviu cada resposta fica no record
//             (`CompetitorResponse.provider`).
//   IMPL-074  chamada PENDENTE lançada direto no ledger da SESSÃO (o
//             reescritor roda fora de qualquer run) é conciliada pela fatura
//             (GET /generation) antes da escrita terminal — antes só as
//             pendentes das runs eram.

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

import { createGateway, setDefaultGateway, type FetchLike, type OpenRouterGateway } from '../src/openrouter.js';
import { getDataDir, loadRun, setDataDir } from '../src/storage.js';
import { trainToCompletion } from '../src/trainer.js';
import { startTraining as startWebTraining } from '../web/src/engine/trainer.js';
import { getRunRecord, subscribeSession } from '../web/src/engine/events.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter, type FakeRequest } from './fakeOpenRouter.js';
import { duelReply, pointwiseReply } from './judgeReplies.js';
import type { RunRecord, SessionRecord, StageSpec, TrainingConfig } from '../src/types.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const BASE = 'Voce e um atendente de suporte. Responda com base no contexto do produto.';
const gid = (n: number): string => `gen-1759100000-${String(n).padStart(20, 'r')}`;

const CENARIOS: StageSpec[] = Array.from({ length: 5 }, (_, i) => ({
  question: `Pergunta ${i}: como troco o produto ${i}?`,
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
    iterations: 1,
    holdoutRatio: 0,
    duels: false,
    finalists: 0,
    feedbackDriven: false,
    timeoutMs: 5_000,
    ...over,
  } as TrainingConfig;
}

let fake: FakeOpenRouter;
let generationGets: string[] = [];
/** Custo que a fatura (GET /generation) devolve para cada reescrita pendente. */
const FATURA_REESCRITOR = 0.0123;

function transporte(): FetchLike {
  let reescritas = 0;
  fake = fakeOpenRouter({
    catalog: ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/opt'].map((id) => catalogItem(id, 1e-6, 2e-6)),
    chat: (req) => {
      if (req.model === 'fake/opt') {
        // Reescritor SEM usage (timeout/stream cortado): custo não medido, mas
        // com id de geração — a chamada fica PENDENTE no ledger da sessão.
        const tecnica = /tecnica id="([^"]+)"/.exec(req.user)?.[1] ?? 'x';
        return {
          text: `Voce e um atendente cordial e preciso (${tecnica}). Responda sempre com base no contexto do produto, cite prazos e regras exatamente como aparecem e recuse o que estiver fora do escopo.`,
          usage: null,
          id: gid(++reescritas),
          provider: 'OptCloud',
        };
      }
      if (req.model === 'fake/a') return { text: `Resposta para ${req.user.slice(0, 30)}`, provider: 'AcmeCloud' };
      if (req.model === 'fake/judge') {
        if (req.system.includes('DUELO')) return { text: duelReply(req, 'A', 'A melhor'), provider: 'JudgeCloud' };
        return { text: pointwiseReply(req, 'parcial'), provider: 'JudgeCloud' };
      }
      return { text: 'ok' };
    },
  });
  generationGets = [];
  return async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/generation')) {
      const id = u.searchParams.get('id') ?? '';
      generationGets.push(id);
      if (!id.startsWith('gen-1759100000-')) return new Response('not found', { status: 404 });
      return new Response(
        JSON.stringify({ data: { id, total_cost: FATURA_REESCRITOR, provider_name: 'OptCloud', cancelled: false } }),
        { status: 200 },
      );
    }
    return fake.fetch(url, init);
  };
}

let prevGw: OpenRouterGateway;
let dir: string;
let dataDirAnterior: string;
beforeAll(() => {
  dataDirAnterior = getDataDir();
  dir = mkdtempSync(join(tmpdir(), 'pb-auditable-reconcile-'));
  setDataDir(dir);
});
afterAll(() => {
  setDataDir(dataDirAnterior);
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  prevGw = setDefaultGateway(createGateway({ fetch: transporte(), sleep: noSleep }));
  return () => {
    setDefaultGateway(prevGw);
  };
});

type Resultado = { rec: SessionRecord; run: RunRecord };

async function treinarNode(cfg: TrainingConfig): Promise<Resultado> {
  const rec = await trainToCompletion(cfg, KEY);
  return { rec, run: (await loadRun(rec.runIds[0]))! };
}
async function treinarWeb(cfg: TrainingConfig): Promise<Resultado> {
  const { sessionId, record } = await startWebTraining(cfg as never, KEY);
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
  return { rec, run: getRunRecord(rec.runIds[0]) as unknown as RunRecord };
}
const MOTORES = [
  ['Node', treinarNode],
  ['SPA', treinarWeb],
] as const;

const doModelo = (m: string): FakeRequest[] => fake.chatRequests().filter((r) => r.model === m);

describe('IMPL-075 — modo auditável da sessão chega à run e trava o provedor do juiz', () => {
  for (const [nome, treinar] of MOTORES) {
    it(`${nome}: auditable:true ⇒ juiz com allow_fallbacks:false + require_parameters:true; competidor livre; visível no artefato`, async () => {
      const { rec, run } = await treinar(config({ auditable: true }));
      expect(rec.status, rec.error).toBe('finished');
      expect(run.config.auditable, 'variationConfigFrom engoliu o campo').toBe(true);
      const juiz = doModelo('fake/judge');
      expect(juiz.length).toBeGreaterThan(0);
      for (const r of juiz) {
        expect(r.body?.provider).toMatchObject({ allow_fallbacks: false, require_parameters: true });
      }
      for (const r of doModelo('fake/a')) {
        expect((r.body?.provider as Record<string, unknown> | undefined)?.allow_fallbacks).not.toBe(false);
      }
      expect(run.costByRole!.judge.auditableCalls).toBe(juiz.length);
      expect(run.callLog!.filter((c) => c.role === 'judge').every((c) => c.auditable === true)).toBe(true);
      expect(rec.costByRole!.judge.auditableCalls).toBe(juiz.length);
    });

    // Revisão w2: as finais DECIDEM o vencedor (finais primeiro, depois
    // judge-score) — o duelo que coroa o campeão também trava o provedor.
    it(`${nome}: auditable:true com FINAIS ⇒ todo pedido de duelo sai travado e conta em costByRole.duel`, async () => {
      const { rec, run } = await treinar(config({ auditable: true, duels: true, finalists: 2 }));
      expect(rec.status, rec.error).toBe('finished');
      const duelos = doModelo('fake/judge').filter((r) => r.system.includes('DUELO'));
      expect(duelos.length, 'a run não chegou às finais').toBeGreaterThan(0);
      for (const r of duelos) {
        expect(r.body?.provider).toMatchObject({ allow_fallbacks: false, require_parameters: true });
      }
      expect(run.costByRole!.duel.auditableCalls).toBe(duelos.length);
      expect(run.callLog!.filter((c) => c.role === 'duel').every((c) => c.auditable === true)).toBe(true);
    });

    it(`${nome}: sem auditable, nada travado (o default não muda)`, async () => {
      const { rec, run } = await treinar(config());
      expect(rec.status, rec.error).toBe('finished');
      expect(run.config.auditable).toBeUndefined();
      for (const r of doModelo('fake/judge')) {
        expect((r.body?.provider as Record<string, unknown> | undefined)?.allow_fallbacks).not.toBe(false);
      }
      expect(run.costByRole!.judge.auditableCalls ?? 0).toBe(0);
    });

    it(`${nome}: o provedor que serviu cada resposta do competidor fica no record`, async () => {
      const { run } = await treinar(config());
      const respostas = run.stages.flatMap((s) => s.responses);
      expect(respostas.length).toBeGreaterThan(0);
      for (const r of respostas) expect(r.provider?.name, r.contestantId).toBe('AcmeCloud');
    });
  }
});

describe('IMPL-074 — pendentes do ledger da SESSÃO conciliadas no fim', () => {
  for (const [nome, treinar] of MOTORES) {
    it(`${nome}: reescritas sem usage (pendentes na sessão) viram o custo da FATURA antes da escrita terminal`, async () => {
      const { rec } = await treinar(config());
      expect(rec.status, rec.error).toBe('finished');
      const reescritas = doModelo('fake/opt').length;
      expect(reescritas).toBe(2);
      // A fatura foi consultada para cada reescrita pendente...
      for (let n = 1; n <= reescritas; n++) expect(generationGets).toContain(gid(n));
      // ...e o record fecha sem pendente, com o valor COBRADO (não a reserva).
      expect(rec.costLedger?.pendingCalls ?? 0).toBe(0);
      expect(rec.costLedger?.reconciliation?.settled).toBeGreaterThanOrEqual(reescritas);
      expect(rec.costByRole!.rewriter.usd).toBeCloseTo(reescritas * FATURA_REESCRITOR, 10);
      expect(rec.costByRole!.rewriter.calls).toBe(reescritas);
    });
  }
});
