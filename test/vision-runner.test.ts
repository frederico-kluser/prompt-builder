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

// ---------------------------------------------------------------------------
// Bancos de probe: resolução e grade
// ---------------------------------------------------------------------------

/** Gateway que responde na escala/viewport que o system prompt declara. */
function fakeProbeGateway(
  scene: VisionScene,
  opts: { round2?: (correto: string) => string } = {},
): {
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
      const pedido = /Pedido: ("(?:[^"\\]|\\.)*")/.exec(user)?.[1];
      const instruction = pedido ? (JSON.parse(pedido) as string) : '';
      const task = scene.tasks.find((t) => t.instruction === instruction);
      const alvo = task?.expect.targetId ? scene.elements.find((e) => e.id === task.expect.targetId) : undefined;
      let text: string;
      if (system.includes('TODOS os elementos interativos')) {
        const dim = /A imagem tem (\d+)×(\d+) pixels/.exec(system);
        const w = dim ? Number(dim[1]) : 1920;
        const h = dim ? Number(dim[2]) : 1080;
        const sx = w / scene.viewport.width;
        const sy = h / scene.viewport.height;
        text = JSON.stringify({
          elements: scene.elements.map((el) => ({
            type: el.type,
            label: el.label,
            iconDescription: el.iconDescription,
            x: Math.round(el.center.x * sx),
            y: Math.round(el.center.y * sy),
          })),
        });
      } else if (system.includes('RECORTE AMPLIADO')) {
        const cell = /célula ([A-F][0-9])/.exec(system)?.[1] ?? 'A1';
        const source = /x=(\d+)\.\.(\d+), y=(\d+)\.\.(\d+)/.exec(system);
        const viewport = /recorte tem (\d+)×(\d+) pixels/.exec(system);
        const vw = viewport ? Number(viewport[1]) : 640;
        const vh = viewport ? Number(viewport[2]) : 540;
        const cw = 1920 / 6;
        const ch = 1080 / 4;
        const col = cell.charCodeAt(0) - 65;
        const row = Number(cell[1]) - 1;
        const padX = Math.round(cw * 0.08);
        const padY = Math.round(ch * 0.08);
        const sx = Math.max(0, Math.round(col * cw) - padX);
        const sy = Math.max(0, Math.round(row * ch) - padY);
        const sw = Math.min(1920 - sx, Math.round(cw) + padX * 2);
        const sh = Math.min(1080 - sy, Math.round(ch) + padY * 2);
        // O source declarado no prompt confere com o derivado da grade.
        expect(source).not.toBeNull();
        expect(task).toBeDefined();
        expect(alvo).toBeDefined();
        text = JSON.stringify({
          action: task!.expect.action,
          target: alvo!.label ?? alvo!.iconDescription,
          x: Math.round(((alvo!.center.x - sx) / sw) * vw),
          y: Math.round(((alvo!.center.y - sy) / sh) * vh),
          text: task!.expect.text ?? null,
        });
        if (opts.round2) text = opts.round2(text);
      } else if (system.includes('grade GROSSA')) {
        expect(task).toBeDefined();
        expect(alvo).toBeDefined();
        const col = Math.min(5, Math.floor(alvo!.center.x / (1920 / 6)));
        const row = Math.min(3, Math.floor(alvo!.center.y / (1080 / 4)));
        text = JSON.stringify({
          cell: `${String.fromCharCode(65 + col)}${row + 1}`,
          action: task!.expect.action,
          target: alvo!.label ?? alvo!.iconDescription,
          x: alvo!.center.x,
          y: alvo!.center.y,
          text: task!.expect.text ?? null,
        });
      } else {
        expect(task).toBeDefined();
        expect(alvo).toBeDefined();
        text = JSON.stringify({
          action: task!.expect.action,
          target: alvo!.label ?? alvo!.iconDescription,
          x: alvo!.center.x,
          y: alvo!.center.y,
          text: task!.expect.text ?? null,
        });
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

describe('bancos de probe do benchmark de visão', () => {
  it('resolução envia a imagem reduzida e converte as coordenadas de volta para 1080p', async () => {
    resetSceneImageCache();
    const loaded = await loadVisionDataset();
    const scene = loaded.dataset.scenes.find((s) => s.id === 'bootstrap-login')!;
    const { gw, calls } = fakeProbeGateway(scene);
    const record = await runVision({
      dataset: loaded.dataset,
      datasetRoot: visionDataDir(),
      config: config({
        benchmark: 'resolution',
        tasks: ['map'],
        resolutions: ['1920x1080', '960x540'],
      }),
      apiKey: 'sk-or-v1-fake',
      gateway: gw,
    });
    expect(calls).toHaveLength(2);
    expect(record.benchmark).toBe('resolution');
    expect(record.contestants[0]?.map?.f1).toBe(1);
    expect(record.contestants[0]?.score).toBe(1);
    const variants = record.contestants[0]?.variants ?? [];
    expect(variants.map((v) => v.variant)).toEqual(['1920x1080', '960x540']);
    expect(variants.every((v) => v.map?.f1 === 1)).toBe(true);
    const reduzida = record.cells.find((c) => c.kind === 'map' && c.variant === '960x540')!;
    expect(reduzida.kind).toBe('map');
    if (reduzida.kind === 'map') {
      expect(reduzida.imageViewport).toEqual({ width: 960, height: 540 });
      expect(reduzida.predictions[0]?.x).toBe(scene.elements[0]!.center.x);
      expect(reduzida.cellId).toBe(`map:${scene.id}@960x540`);
    }
    expect(String(calls[1]!.messages[0]!.content)).toContain('reduzida');
  });

  it('grade compara plain × mark-grid e o mark-grid faz 2 rodadas sobre o recorte', async () => {
    resetSceneImageCache();
    const loaded = await loadVisionDataset();
    const scene = loaded.dataset.scenes.find((s) => s.id === 'bootstrap-login')!;
    const { gw, calls } = fakeProbeGateway(scene);
    const record = await runVision({
      dataset: loaded.dataset,
      datasetRoot: visionDataDir(),
      config: config({
        benchmark: 'grid',
        tasks: ['action'],
        gridVariants: ['plain', 'mark-grid'],
      }),
      apiKey: 'sk-or-v1-fake',
      gateway: gw,
    });
    // 4 tarefas × 2 variantes; mark-grid gasta 2 chamadas por tarefa.
    expect(calls).toHaveLength(4 * 2 + 4);
    expect(record.totals.calls).toBe(12);
    expect(record.benchmark).toBe('grid');
    expect(record.promptVersion).toBe('vision-grid-prompt@1');
    expect(record.contestants[0]?.action?.passRate).toBe(1);
    const variants = record.contestants[0]?.variants ?? [];
    expect(variants.find((v) => v.variant === 'plain')?.action?.passRate).toBe(1);
    const mark = variants.find((v) => v.variant === 'mark-grid')!;
    expect(mark.action?.passRate).toBe(1);
    expect(mark.calls).toBe(8);
    const markCells = record.cells.filter((c) => c.kind === 'action' && c.variant === 'mark-grid');
    expect(markCells).toHaveLength(4);
    for (const cell of markCells) {
      if (cell.kind !== 'action') continue;
      expect(cell.rounds).toBe(2);
      expect(cell.trace).toHaveLength(2);
      expect(cell.trace?.[0]?.cell).toMatch(/^[A-F][1-4]$/);
      expect(cell.trace?.[1]?.crop).toBeDefined();
      expect(cell.score?.pass).toBe(true);
    }
  });
});


describe('mark-grid — refino de posição não reescreve a ação', () => {
  it('mantém ação/alvo/texto da rodada 1 e usa só o ponto da rodada 2', async () => {
    resetSceneImageCache();
    const loaded = await loadVisionDataset();
    const scene = loaded.dataset.scenes.find((s) => s.id === 'bootstrap-login')!;
    // A rodada 2 "erra" a ação de propósito; o placar deve preservar a rodada 1.
    const { gw } = fakeProbeGateway(scene, {
      round2: (correto) => {
        const p = JSON.parse(correto) as { x: number; y: number };
        return JSON.stringify({ action: 'click', target: 'outra coisa', x: p.x, y: p.y, text: 'texto errado' });
      },
    });
    const record = await runVision({
      dataset: loaded.dataset,
      datasetRoot: visionDataDir(),
      config: config({
        benchmark: 'grid',
        tasks: ['action'],
        gridVariants: ['mark-grid'],
        scenes: ['bootstrap-login'],
      }),
      apiKey: 'sk-or-v1-fake',
      gateway: gw,
    });
    expect(record.contestants[0]?.action?.passRate).toBe(1);
    const typeCell = record.cells.find(
      (c) => c.kind === 'action' && c.taskId === 'bootstrap-login-a1',
    );
    expect(typeCell?.kind).toBe('action');
    if (typeCell?.kind === 'action') {
      expect(typeCell.rounds).toBe(2);
      expect(typeCell.trace?.[1]?.prediction?.action).toBe('click');
      expect(typeCell.prediction?.action).toBe('type');
      expect(typeCell.prediction?.text).toBe('aluna@exemplo.com');
      expect(typeCell.score?.pass).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Matriz resolução × grade sem overlay
// ---------------------------------------------------------------------------

function fakeMatrixGateway(scene: VisionScene): {
  gw: OpenRouterGateway;
  calls: ChatCompletionParams[];
} {
  const calls: ChatCompletionParams[] = [];
  const gw = {
    peekModelsCache: () => ({ data: [] }),
    chatCompletion: async (p: ChatCompletionParams): Promise<ChatCompletionResult> => {
      calls.push(p);
      const user = String(p.messages[1]!.content);
      const pedido = /Pedido: ("(?:[^"\\]|\\.)*")/.exec(user)?.[1];
      const instruction = pedido ? (JSON.parse(pedido) as string) : '';
      const task = scene.tasks.find((t) => t.instruction === instruction)!;
      const alvo = scene.elements.find((e) => e.id === task.expect.targetId)!;
      const dim = /nesta tela \((\d+)×(\d+)\)/.exec(user);
      const w = dim ? Number(dim[1]) : scene.viewport.width;
      const h = dim ? Number(dim[2]) : scene.viewport.height;
      const x = Math.round((alvo.center.x / scene.viewport.width) * w);
      const y = Math.round((alvo.center.y / scene.viewport.height) * h);
      return {
        text: JSON.stringify({
          action: task.expect.action,
          target: alvo.label ?? alvo.iconDescription,
          x,
          y,
          text: task.expect.text ?? null,
        }),
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

describe('matriz resolução × grade sem overlay', () => {
  it('cruza resoluções e grades, remapeia o ponto e manda o sidecar como 2ª imagem', async () => {
    resetSceneImageCache();
    const loaded = await loadVisionDataset();
    const scene = loaded.dataset.scenes.find((s) => s.id === 'bootstrap-login')!;
    const { gw, calls } = fakeMatrixGateway(scene);
    const record = await runVision({
      dataset: loaded.dataset,
      datasetRoot: visionDataDir(),
      config: config({
        benchmark: 'matrix',
        tasks: ['action'],
        resolutions: ['1920x1080', '640x360'],
        matrixGrids: ['plain', 'frame-axis', 'sidecar-grid'],
        scenes: ['bootstrap-login'],
      }),
      apiKey: 'sk-or-v1-fake',
      gateway: gw,
    });
    expect(calls).toHaveLength(4 * 2 * 3);
    expect(record.benchmark).toBe('matrix');
    expect(record.promptVersion).toBe('vision-matrix-prompt@1');
    expect(record.contestants[0]?.action?.passRate).toBe(1);
    expect(record.contestants[0]?.variants).toHaveLength(6);
    const frame = record.cells.find(
      (c) => c.kind === 'action' && c.variant === '640x360+frame-axis',
    );
    expect(frame?.kind).toBe('action');
    if (frame?.kind === 'action') {
      expect(frame.margins?.left).toBeGreaterThan(0);
      expect(frame.grid).toBe('frame-axis');
      expect(frame.score?.pass).toBe(true);
    }
    const sidecarCall = calls.find((c) => String(c.messages[0]!.content).includes('SEGUNDA é uma grade'));
    expect(sidecarCall?.messages[1]?.images).toHaveLength(2);
  });
});
