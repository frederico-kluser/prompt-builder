// http-api#0 / http-api#1 — o fluxo do README pela API HTTP de verdade:
// `POST /runs` → 202 {runId} → `GET /runs/:id` e `GET /runs/:id/events`.
//
//  #0: o 202 saía ANTES de a run existir no disco (a 1ª gravação esperava o
//      catálogo — rede, até 20 s a frio): GET/SSE logo depois davam 404, e o
//      EventSource do navegador desiste de vez num 404. Agora a rota aguarda a
//      1ª gravação (`startRun(...).persisted`) e o record VIVO atende o GET.
//  #1: o snapshot do SSE vinha da cópia THROTTLED do disco e o subscribe só
//      acontecia depois do `await loadRun` — quem conectava no meio da run
//      perdia o que já tinha acontecido até o `run.finished`. Agora snapshot
//      (record vivo) e subscribe são do MESMO tick.
//
// Zero rede real: gateway falso (fakeOpenRouter) com /models LENTO de
// propósito (o catálogo frio que abria a janela do 404).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway, type FetchLike } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { createApp } from '../src/server.js';
import { subscribe } from '../src/events.js';
import type { RunEvent, RunRecord } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { pointwiseReply, questionOf } from './judgeReplies.js';

const KEY = 'sk-or-v1-fake-key-http-live-000000000000';

const CONFIG = {
  mode: 'compare',
  theme: 'suporte',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  finalists: 0,
  duels: false,
  timeoutMs: 10_000,
  customStages: [
    { question: 'CEN-0 Qual o prazo de troca?', productContext: 'Trocas em 30 dias.', maxTokens: 200, reference: 'Trinta dias.' },
    { question: 'CEN-1 Qual o prazo de entrega?', productContext: 'Entrega em 5 dias.', maxTokens: 200, reference: 'Cinco dias.' },
  ],
};

let liberarCen1: () => void = () => undefined;

function gateway(): FetchLike {
  let segura = new Promise<void>((res) => {
    liberarCen1 = res;
  });
  const fake = fakeOpenRouter({
    catalog: ['fake/judge', 'fake/a', 'fake/b', 'fake/ref', 'fake/gen'].map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: async (req) => {
      if (req.stream) return { text: `Resposta de ${req.model}`, finishReason: 'stop' };
      // O juiz do CEN-1 espera o teste: a run fica PARADA no meio (CEN-0 já julgado).
      if (questionOf(req).startsWith('CEN-1')) await segura;
      return { text: pointwiseReply(req, 'resolve'), finishReason: 'stop' };
    },
  });
  return async (url, init) => {
    // Catálogo FRIO: é a janela em que o 202 saía antes do record existir.
    if (new URL(url).pathname.endsWith('/models')) await new Promise((r) => setTimeout(r, 400));
    return fake.fetch(url, init);
  };
}

/** Lê frames `data:` de um SSE até `until` devolver true (ou o stream fechar). */
async function lerSse(
  res: Response,
  until: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>[]> {
  const frames: Record<string, unknown>[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const bloco = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!bloco.startsWith('data: ')) continue;
      const frame = JSON.parse(bloco.slice(6)) as Record<string, unknown>;
      frames.push(frame);
      if (until(frame)) {
        await reader.cancel();
        return frames;
      }
    }
  }
  return frames;
}

describe('http-api#0/#1 — POST /runs → GET /runs/:id → SSE', () => {
  let server: Server;
  let base: string;
  let tmp: string;
  let dirAnterior: string;
  let anterior: ReturnType<typeof setDefaultGateway>;
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-http-live-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    anterior = setDefaultGateway(createGateway({ fetch: gateway(), sleep: noSleep }));
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    server = createApp({ webDist: '' }).listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/benchmark`;
  });

  afterAll(async () => {
    liberarCen1();
    await new Promise<void>((r) => server.close(() => r()));
    silencio.forEach((s) => s.mockRestore());
    setDefaultGateway(anterior);
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('202 só com a run já legível; snapshot do SSE no meio da run traz o que já aconteceu', async () => {
    const post = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openrouter-key': KEY },
      body: JSON.stringify(CONFIG),
    });
    expect(post.status).toBe(202);
    const { runId } = (await post.json()) as { runId: string };

    // Assina o barramento para saber QUANDO o CEN-0 foi julgado (o CEN-1 está preso).
    const cen0Julgado = new Promise<void>((resolve) => {
      const off = subscribe(runId, (e: RunEvent) => {
        if (e.type === 'stage.judged' && e.stageIndex === 0) {
          off();
          resolve();
        }
      });
    });

    // #0: logo depois do 202 (catálogo ainda frio) — nada de 404.
    const get = await fetch(`${base}/runs/${runId}`);
    expect(get.status).toBe(200);
    expect(((await get.json()) as RunRecord).status).toBe('running');
    const lista = (await (await fetch(`${base}/runs`)).json()) as { data: { id: string }[] };
    expect(lista.data.map((r) => r.id)).toContain(runId);

    // #1: conecta NO MEIO da run (CEN-0 julgado, CEN-1 preso): o snapshot já
    // traz o veredito do CEN-0 — do record vivo, não da cópia throttled.
    await cen0Julgado;
    const sse = await fetch(`${base}/runs/${runId}/events`);
    expect(sse.status).toBe(200);
    const pendentes = lerSse(sse, (f) => f.type === 'run.finished' || f.type === 'run.error');
    // Libera o CEN-1 só DEPOIS de conectar: o resto chega pelo stream.
    await new Promise((r) => setTimeout(r, 50));
    liberarCen1();
    const frames = await pendentes;
    const snap = frames[0] as { type: string; record: RunRecord };
    expect(snap.type).toBe('snapshot');
    expect(snap.record.status).toBe('running');
    expect(snap.record.stages[0].referenceJudge?.verdictByContestant).toEqual({
      'fake/a': 'resolve',
      'fake/b': 'resolve',
    });
    expect(snap.record.stages[0].responses).toHaveLength(2);
    // O que aconteceu depois de conectar chegou pelo stream (sem buraco).
    const tipos = frames.map((f) => f.type);
    expect(tipos).toContain('stage.judged');
    expect(tipos[tipos.length - 1]).toBe('run.finished');

    // Depois do fim: GET lê o record FINAL (do disco — o vivo já saiu).
    const fim = (await (await fetch(`${base}/runs/${runId}`)).json()) as RunRecord;
    expect(['finished', 'inconclusive']).toContain(fim.status);
  });
});
