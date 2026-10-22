// Contrato do RUNNER de visão — sem rede: o gateway é injetado.
//
// Prova o essencial: uma célula = uma chamada (map: cena; action: tarefa), a
// saída do modelo é parseada e PONTUADA contra a verdade do dataset, a imagem
// viaja como parte da mensagem, erro/parse inválido não viram nota, e o record
// fica com os agregados e o hash do dataset usado.

import { describe, expect, it } from 'vitest';
import {
  loadVisionDataset,
  resetSceneImageCache,
  visionDataDir,
} from '../src/vision/dataset.js';
import { runVision, planVisionRun } from '../src/vision/runner.js';
import type { ChatCompletionParams, ChatCompletionResult, OpenRouterGateway } from '../src/openrouter.js';
import type { VisionRunConfig, VisionScene } from '../src/engine/vision/index.js';
import { VISION_VIEWPORT } from '../src/engine/vision/index.js';

function config(over: Partial<VisionRunConfig> = {}): VisionRunConfig {
  return {
    models: ['fake/vlm'],
    tasks: ['map', 'action'],
    families: ['bootstrap'],
    scenes: ['bootstrap-login'],
    limit: null,
    coordSpace: 'pixels',
    temperature: 0,
    maxTokens: 1024,
    retries: 0,
    ...over,
  };
}

function fakeGateway(scene: VisionScene, opts: { mapText?: string; actionText?: (instruction: string) => string } = {}): {
  gw: OpenRouterGateway;
  calls: ChatCompletionParams[];
} {
  const calls: ChatCompletionParams[] = [];
  const gw = {
    peekModelsCache: () => ({ data: [] }),
    chatCompletion: async (p: ChatCompletionParams): Promise<ChatCompletionResult> => {
      calls.push(p);
      const system = String(p.messages[0]!.content);
      const user = String(p.messages[1]!.content);
      let text: string;
      if (system.includes('TODOS os elementos interativos')) {
        text =
          opts.mapText ??
          JSON.stringify({
            elements: scene.elements.map((el) => ({
              type: el.type,
              label: el.label,
              iconDescription: el.iconDescription,
              x: el.center.x,
              y: el.center.y,
            })),
          });
      } else {
        const pedido = /Pedido: ("(?:[^"\\]|\\.)*")/.exec(user)?.[1];
        const instruction = pedido ? (JSON.parse(pedido) as string) : '';
        text = opts.actionText
          ? opts.actionText(instruction)
          : JSON.stringify(
              (() => {
                const task = scene.tasks.find((t) => t.instruction === instruction)!;
                const alvo = scene.elements.find((e) => e.id === task.expect.targetId)!;
                return {
                  action: task.expect.action,
                  target: alvo.label ?? alvo.iconDescription,
                  x: alvo.center.x,
                  y: alvo.center.y,
                  text: task.expect.text ?? null,
                };
              })(),
            );
      }
      return {
        text,
        tokensIn: 1200,
        tokensOut: 120,
        latencyMs: 42,
        raw: { fake: true },
        cost: { usd: 0.0002, source: 'usage' },
      };
    },
  } as unknown as OpenRouterGateway;
  return { gw, calls };
}

describe('runner do benchmark de visão', () => {
  it('map + action pontuam contra a verdade e o record nasce completo', async () => {
    resetSceneImageCache();
    const loaded = await loadVisionDataset();
    const scene = loaded.dataset.scenes.find((s) => s.id === 'bootstrap-login')!;
    const { gw, calls } = fakeGateway(scene);
    const record = await runVision({
      dataset: loaded.dataset,
      datasetRoot: visionDataDir(),
      config: config(),
      apiKey: 'sk-or-v1-fake',
      gateway: gw,
    });
    expect(calls).toHaveLength(1 + scene.tasks.length);
    // A imagem vai como parte da mensagem do user e o texto vem antes.
    const partes = calls[0]!.messages[1]?.images;
    expect(partes?.[0]?.url.startsWith('data:image/png;base64,')).toBe(true);
    expect(calls[0]!.messages[0]!.role).toBe('system');
    expect(calls[0]!.maxTokens).toBe(1024);
    expect(record.format).toBe('vision-run@1');
    expect(record.status).toBe('finished');
    expect(record.dataset.scenes).toEqual(['bootstrap-login']);
    expect(record.dataset.hash).toMatch(/^sha256:/);
    expect(record.promptVersion).toBe('vision-prompt@1');
    expect(record.totals.calls).toBe(1 + scene.tasks.length);
    const c = record.contestants[0]!;
    // Custo por célula vem do `usage` medido; o total do record vem do LEDGER
    // (no gateway falso não há settle, então o teste confere a célula).
    expect(c.costUsd).toBeGreaterThan(0);
    expect(c.map?.f1).toBe(1);
    expect(c.map?.recall).toBe(1);
    expect(c.action?.passRate).toBe(1);
    expect(c.score).toBe(1);
  });

  it('salvamento inválido do modelo não vira acerto (parseOk false e F1 0)', async () => {
    resetSceneImageCache();
    const loaded = await loadVisionDataset();
    const scene = loaded.dataset.scenes.find((s) => s.id === 'bootstrap-login')!;
    const { gw } = fakeGateway(scene, {
      mapText: 'desculpe, não consigo ver a imagem',
      actionText: () => 'texto solto',
    });
    const record = await runVision({
      dataset: loaded.dataset,
      datasetRoot: visionDataDir(),
      config: config({ tasks: ['map'] }),
      apiKey: 'sk-or-v1-fake',
      gateway: gw,
    });
    expect(record.status).toBe('finished');
    expect(record.contestants[0]?.map?.f1).toBe(0);
    expect(record.contestants[0]?.parseFailures).toBe(1);
    expect(record.cells[0]?.parseOk).toBe(false);
  });

  it('plano conta células por modelo e respeita filtros', async () => {
    const loaded = await loadVisionDataset();
    const plano = planVisionRun(loaded.dataset, config({ tasks: ['map', 'action'], models: ['a/b', 'c/d'] }));
    const cena = loaded.dataset.scenes.find((s) => s.id === 'bootstrap-login')!;
    expect(plano.scenes).toBe(1);
    expect(plano.mapCells).toBe(1);
    expect(plano.actionCells).toBe(cena.tasks.length);
    expect(plano.cells).toBe((1 + cena.tasks.length) * 2);
    expect(plano.scenesIds).toEqual(['bootstrap-login']);
  });

  it('o prompt declara o espaço de coordenadas pedido', async () => {
    resetSceneImageCache();
    const loaded = await loadVisionDataset();
    const scene = loaded.dataset.scenes.find((s) => s.id === 'bootstrap-login')!;
    const { gw, calls } = fakeGateway(scene);
    await runVision({
      dataset: loaded.dataset,
      datasetRoot: visionDataDir(),
      config: config({ tasks: ['map'], coordSpace: 'normalized' }),
      apiKey: 'sk-or-v1-fake',
      gateway: gw,
    });
    const system = String(calls[0]!.messages[0]!.content);
    expect(system).toContain('0–1000');
    expect(system).not.toContain('0–1920');
    expect(scene.viewport).toEqual({ width: VISION_VIEWPORT.width, height: VISION_VIEWPORT.height });
  });
});
