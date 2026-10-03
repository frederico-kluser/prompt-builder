// IMPL-014 (critério i, parte que faltava) + IMPL-117 (artefato por chamada):
// `finishReason`/`nativeFinishReason` persistidos POR VOTO de juiz (pointwise),
// POR ORDEM de duelo e POR PASSAGEM do listwise — antes só o histograma por
// papel (`finishSignalsByRole.judge`) sobrevivia, e não dava para dizer qual
// veredito terminou com qual `finish_reason`. Cada um leva também o id da
// geração e o SHA-256 da resposta devolvida.
//
// Contratos (Node e SPA, transporte falso):
//  (i)   100% dos votos pointwise (inclusive o do juiz que FALHOU cortado),
//        100% das ordens de duelo e 100% das passagens listwise têm finishReason;
//  (ii)  o voto cortado guarda finishReason 'length' + truncated;
//  (iii) responseSha256 = SHA-256 do texto devolvido; generationId = `id` do corpo;
//  (iv)  o re-read (disco + normalizeRunRecord) preserva tudo.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway, type FetchLike } from '../src/openrouter.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { getDataDir, loadRun, setDataDir } from '../src/storage.js';
import { normalizeRunRecord } from '../src/normalize.js';
import { sha256Hex } from '../src/engine/hash.js';
import type { JudgeCallFinish, RunConfig, RunRecord, StageSpec } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeRequest } from './fakeOpenRouter.js';
import { candidateOf, duelReply, listwiseReply, pointwiseReply } from './judgeReplies.js';

vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

const COM_REF: StageSpec[] = Array.from({ length: 4 }, (_, i) => ({
  question: `CEN-${i} Qual o prazo para trocar?`,
  productContext: 'Trocas em até 30 dias com nota fiscal.',
  maxTokens: 200,
  reference: `Trinta dias (item ${i}).`,
}));
// Sem gabarito e o gabarito gerado vem VAZIO ⇒ etapa julgada pelo LISTWISE.
const SEM_REF: StageSpec = { question: 'CEN-L Qual o horário?', productContext: 'Das 8h às 18h.', maxTokens: 200 };

const CONFIG = {
  mode: 'compare',
  theme: 'suporte',
  stages: 5,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/j1', 'fake/j2'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  customStages: [...COM_REF, SEM_REF],
  finalists: 2,
  judgeEngine: 'llm',
  timeoutMs: 5_000,
} as unknown as RunConfig;

/** Textos devolvidos por chamada de juízo (para conferir o SHA-256). */
let devolvidos: Set<string>;

function gateway(): FetchLike {
  devolvidos = new Set();
  let n = 0;
  const fake = fakeOpenRouter({
    catalog: ['fake/j1', 'fake/j2', 'fake/a', 'fake/b', 'fake/ref', 'fake/gen'].map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: (req: FakeRequest) => {
      if (req.stream) return { text: `Resposta de ${req.model}`, finishReason: 'stop' };
      if (req.model === 'fake/ref') return { text: '', finishReason: 'stop' };
      let text: string;
      if (req.system.includes('DUELO')) text = duelReply(req, 'A');
      else if (req.system.includes('juiz imparcial')) {
        const labels = JSON.parse(/rotulos (\[[^\]]*\])/.exec(req.user)![1]) as string[];
        text = listwiseReply(req, labels, labels.map((label) => ({ label, justificativa: 'ok', veredito: 'resolve' })));
      } else {
        // j2 sai CORTADO no teto para o candidato fake/b (voto vira falha 'truncated').
        if (req.model === 'fake/j2' && candidateOf(req) === 'Resposta de fake/b') {
          return { text: '{"canario":', finishReason: 'length', nativeFinishReason: 'max_tokens' };
        }
        text = pointwiseReply(req, 'resolve');
      }
      devolvidos.add(text);
      return { text, finishReason: 'stop', nativeFinishReason: 'end_turn' };
    },
  });
  // O OpenRouter devolve o id da geração no corpo — o fake não; injeta aqui.
  return async (url, init) => {
    const res = await fake.fetch(url, init);
    if (!new URL(url).pathname.endsWith('/chat/completions') || res.headers.get('content-type')?.includes('event-stream')) {
      return res;
    }
    const corpo = await res.text();
    try {
      const json = JSON.parse(corpo) as Record<string, unknown>;
      json.id = `gen-${++n}`;
      return new Response(JSON.stringify(json), { status: res.status });
    } catch {
      return new Response(corpo, { status: res.status });
    }
  };
}

async function comGateway<T>(fetch: FetchLike, fn: () => Promise<T>): Promise<T> {
  const anterior = setDefaultGateway(createGateway({ fetch, sleep: noSleep }));
  try {
    return await fn();
  } finally {
    setDefaultGateway(anterior);
  }
}

function conferirFinish(f: JudgeCallFinish | undefined, onde: string): void {
  expect(f?.finishReason, `${onde}: finishReason`).toBeTruthy();
  expect(f?.responseSha256, `${onde}: responseSha256`).toMatch(/^[0-9a-f]{64}$/);
  expect(f?.generationId, `${onde}: generationId`).toMatch(/^gen-\d+$/);
}

function conferirRecord(rec: RunRecord): void {
  let votos = 0;
  let ordens = 0;
  let passagens = 0;
  for (const st of rec.stages) {
    for (const [cid, vs] of Object.entries(st.referenceJudge?.judgeVotesByContestant ?? {})) {
      for (const v of vs) {
        votos += 1;
        conferirFinish(v, `voto ${v.judgeModelId}/${cid}`);
        if (v.error) {
          expect(v.error.kind).toBe('truncated');
          expect(v).toMatchObject({ finishReason: 'length', nativeFinishReason: 'max_tokens', truncated: true });
        } else {
          expect(v).toMatchObject({ finishReason: 'stop', nativeFinishReason: 'end_turn' });
          expect(v.truncated).toBeUndefined();
          expect([...devolvidos].some((t) => sha256Hex(t) === v.responseSha256)).toBe(true);
        }
      }
    }
    for (const d of st.duels?.duels ?? []) {
      for (const o of [d.order1, d.order2]) {
        ordens += 1;
        conferirFinish(o, `duelo ${d.a}×${d.b}`);
      }
    }
    for (const j of st.judge?.judges ?? []) {
      for (const p of j.passFinish ?? []) {
        passagens += 1;
        conferirFinish(p, `listwise ${j.judgeModelId}`);
      }
      expect(j.passFinish?.length, 'uma passagem por juiz com sinais').toBe(1);
    }
  }
  // 4 cenários × 2 contestants × 2 juízes; duelos das finais; listwise do CEN-L.
  expect(votos).toBe(16);
  expect(ordens).toBeGreaterThan(0);
  expect(passagens).toBe(2);
}

describe('IMPL-014 — sinais de fim POR voto/ordem/passagem (Node e SPA)', () => {
  let dirAnterior: string;
  let tmp: string;
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl014-voto-'));
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

  it('Node: 100% dos votos/ordens/passagens com finishReason + artefato; o re-read preserva', async () => {
    const rec = await comGateway(gateway(), () => runNode(CONFIG, KEY, {}));
    conferirRecord(rec);
    const relido = normalizeRunRecord(JSON.parse(JSON.stringify(await loadRun(rec.id))));
    conferirRecord(relido);
  });

  it('SPA (mirror): o mesmo contrato', async () => {
    const rec = (await comGateway(gateway(), () => runWeb(CONFIG as never, KEY, {}))) as unknown as RunRecord;
    conferirRecord(rec);
  });
});
