// BENCHMARK DE VISÃO — variantes de APRESENTAÇÃO geradas no build.
//
// Os bancos `resolution` e `grid` mudam UMA coisa na imagem que o modelo vê:
// a escala (downscale da mesma tela) ou um overlay de grade. A verdade continua
// sendo o DOM da tela base — por isso as variantes são derivadas da imagem
// canônica e pinadas por sha256 no manifesto, nunca desenhadas na hora da run.
//
// O Chromium já é dependência do build (playwright-core): o canvas dele faz o
// resize e os overlays sem trazer `sharp`/`canvas` para o pacote.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Browser } from 'playwright-core';
import {
  VISION_VIEWPORT,
  type VisionBBox,
  type VisionGridCellSpec,
  type VisionGridOverlay,
  type VisionImageRef,
  type VisionResolution,
  type VisionResolutionRef,
} from '../../engine/vision/index.js';

const CANON = VISION_VIEWPORT;
const COLORS = {
  line: 'rgba(15, 23, 42, 0.42)',
  axis: 'rgba(14, 116, 144, 0.55)',
  chip: 'rgba(255, 255, 255, 0.92)',
  ink: '#0f172a',
};
const FONT = '600 18px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

interface CanvasOutput {
  kind: 'resolution' | 'overlay' | 'crop';
  id: string;
  dataUrl: string;
  width: number;
  height: number;
  cellId?: string;
  bbox?: VisionBBox;
  source?: VisionBBox;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writePng(root: string, rel: string, dataUrl: string): Promise<VisionImageRef> {
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const destino = path.join(root, rel);
  await fs.mkdir(path.dirname(destino), { recursive: true });
  await fs.writeFile(destino, bytes);
  return { file: rel, sha256: sha256(bytes), bytes: bytes.byteLength };
}

function gridCells(cols: number, rows: number): Array<{ id: string; bbox: VisionBBox }> {
  const cells: Array<{ id: string; bbox: VisionBBox }> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        id: `${String.fromCharCode(65 + c)}${r + 1}`,
        bbox: {
          x: Math.round((c * CANON.width) / cols),
          y: Math.round((r * CANON.height) / rows),
          w: Math.round(CANON.width / cols),
          h: Math.round(CANON.height / rows),
        },
      });
    }
  }
  return cells;
}

/** Desenha tudo dentro da página (canvas) e devolve os PNGs em memória. */
async function drawVariants(browser: Browser, imageDataUrl: string): Promise<CanvasOutput[]> {
  const page = await browser.newPage({ viewport: { width: CANON.width, height: CANON.height }, deviceScaleFactor: 1 });
  try {
    await page.addInitScript({
      content:
        'globalThis.__name = globalThis.__name || ((f, n) => { try { Object.defineProperty(f, "name", { value: n, configurable: true }); } catch {} return f; });',
    });
    await page.setContent(`<img id="vision-src" alt="" src="${imageDataUrl}">`, { waitUntil: 'load' });
    await page.evaluate(async () => {
      const img = document.getElementById('vision-src') as HTMLImageElement;
      if (!img.complete) await new Promise((r) => (img.onload = () => r(null)));
    });
    return (await page.evaluate(
      ({ canon, colors, font, resolutions, cells }) => {
        // tsx/esbuild injeta `__name(...)` em funções nomeadas serializadas;
        // a página não tem o helper do bundle, então ele nasce aqui.
        (globalThis as unknown as { __name?: (f: unknown, n: string) => unknown }).__name ??= (f) => f;
        const img = document.getElementById('vision-src') as HTMLImageElement;
        const outputs: CanvasOutput[] = [];
        const canvas = (w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] => {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const ctx = c.getContext('2d')!;
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          return [c, ctx];
        };
        const chip = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void => {
          ctx.font = font;
          const w = ctx.measureText(text).width + 12;
          ctx.fillStyle = colors.chip;
          ctx.fillRect(x, y, w, 24);
          ctx.fillStyle = colors.ink;
          ctx.fillText(text, x + 6, y + 18);
        };

        // 1) resoluções: downscale da MESMA tela (sem reflow).
        for (const r of resolutions) {
          const [c, ctx] = canvas(r.width, r.height);
          ctx.drawImage(img, 0, 0, r.width, r.height);
          outputs.push({ kind: 'resolution', id: r.id, dataUrl: c.toDataURL('image/png'), width: r.width, height: r.height });
        }

        // 2) grade simples 9×9 — controle NEGATIVO (sem rótulos).
        {
          const [c, ctx] = canvas(canon.width, canon.height);
          ctx.drawImage(img, 0, 0, canon.width, canon.height);
          ctx.strokeStyle = colors.line;
          ctx.lineWidth = 1;
          for (let i = 1; i < 9; i++) {
            const x = Math.round((canon.width * i) / 9);
            const y = Math.round((canon.height * i) / 9);
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, canon.height);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(canon.width, y);
            ctx.stroke();
          }
          outputs.push({ kind: 'overlay', id: 'grid-simple', dataUrl: c.toDataURL('image/png'), width: canon.width, height: canon.height });
        }

        // 3) eixos rotulados (régua) — uma chamada, sem recorte.
        {
          const [c, ctx] = canvas(canon.width, canon.height);
          ctx.drawImage(img, 0, 0, canon.width, canon.height);
          ctx.strokeStyle = colors.axis;
          ctx.lineWidth = 1;
          for (let x = 240; x < canon.width; x += 240) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, canon.height);
            ctx.stroke();
          }
          for (let y = 270; y < canon.height; y += 270) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(canon.width, y);
            ctx.stroke();
          }
          for (let x = 0; x <= canon.width; x += 240) chip(ctx, `x=${x}`, Math.min(x + 2, canon.width - 70), 2);
          for (let y = 0; y <= canon.height; y += 270) chip(ctx, `y=${y}`, 2, Math.min(y + 2, canon.height - 26));
          outputs.push({ kind: 'overlay', id: 'axis-grid', dataUrl: c.toDataURL('image/png'), width: canon.width, height: canon.height });
        }

        // 4) Mark-Grid 6×4: células rotuladas + recorte ampliado de cada uma.
        {
          const [c, ctx] = canvas(canon.width, canon.height);
          ctx.drawImage(img, 0, 0, canon.width, canon.height);
          ctx.strokeStyle = colors.line;
          ctx.lineWidth = 2;
          for (const cell of cells) {
            const { x, y, w, h } = cell.bbox;
            ctx.strokeRect(x, y, w, h);
            chip(ctx, cell.id, x + 4, y + 4);
          }
          outputs.push({ kind: 'overlay', id: 'mark-grid', dataUrl: c.toDataURL('image/png'), width: canon.width, height: canon.height });

          for (const cell of cells) {
            const { x, y, w, h } = cell.bbox;
            const padX = Math.round(w * 0.08);
            const padY = Math.round(h * 0.08);
            const sx = Math.max(0, x - padX);
            const sy = Math.max(0, y - padY);
            const sw = Math.min(canon.width - sx, w + padX * 2);
            const sh = Math.min(canon.height - sy, h + padY * 2);
            const [cc, cctx] = canvas(640, 540);
            cctx.drawImage(img, sx, sy, sw, sh, 0, 0, 640, 540);
            outputs.push({
              kind: 'crop',
              id: cell.id,
              cellId: cell.id,
              bbox: cell.bbox,
              source: { x: sx, y: sy, w: sw, h: sh },
              dataUrl: cc.toDataURL('image/png'),
              width: 640,
              height: 540,
            });
          }
        }
        return outputs;
      },
      {
        canon: CANON,
        colors: COLORS,
        font: FONT,
        resolutions: [
          { id: '1280x720' as VisionResolution, width: 1280, height: 720 },
          { id: '960x540' as VisionResolution, width: 960, height: 540 },
          { id: '640x360' as VisionResolution, width: 640, height: 360 },
        ],
        cells: gridCells(6, 4),
      },
    )) as CanvasOutput[];
  } finally {
    await page.close();
  }
}

export interface GeneratedProbes {
  resolutions: VisionResolutionRef[];
  overlays: VisionGridOverlay[];
}

/**
 * Gera e grava as variantes de um cenário. A resolução NATIVA não é duplicada
 * em disco: ela referencia a imagem base (mesmo sha), para o manifesto poder
 * listar as quatro escalas sem inchar o pacote.
 */
export async function buildSceneProbes(
  browser: Browser,
  basePngPath: string,
  root: string,
  sceneId: string,
  native: VisionImageRef,
): Promise<GeneratedProbes> {
  const dataUrl = `data:image/png;base64,${(await fs.readFile(basePngPath)).toString('base64')}`;
  const outputs = await drawVariants(browser, dataUrl);
  const resolutions: VisionResolutionRef[] = [
    { id: '1920x1080', width: CANON.width, height: CANON.height, ...native },
  ];
  const overlays: VisionGridOverlay[] = [];
  const overlayByI = new Map<string, VisionGridOverlay>();
  const cellsByOverlay = new Map<string, VisionGridCellSpec[]>();

  for (const o of outputs) {
    if (o.kind === 'resolution') {
      const ref = await writePng(root, `resolutions/${sceneId}-${o.id}.png`, o.dataUrl);
      resolutions.push({ id: o.id as VisionResolution, width: o.width, height: o.height, ...ref });
      continue;
    }
    if (o.kind === 'overlay') {
      const ref = await writePng(root, `overlays/${sceneId}-${o.id}.png`, o.dataUrl);
      const overlay: VisionGridOverlay = {
        id: o.id as VisionGridOverlay['id'],
        image: ref,
        viewport: { width: o.width, height: o.height },
        ...(o.id === 'grid-simple' ? { cols: 9, rows: 9 } : {}),
        ...(o.id === 'axis-grid' ? { step: 240 } : {}),
        ...(o.id === 'mark-grid' ? { cols: 6, rows: 4 } : {}),
      };
      overlays.push(overlay);
      overlayByI.set(o.id, overlay);
      if (o.id === 'mark-grid') cellsByOverlay.set(o.id, []);
      continue;
    }
    const list = cellsByOverlay.get('mark-grid');
    if (!list || !o.cellId || !o.bbox || !o.source) continue;
    const ref = await writePng(root, `crops/${sceneId}-${o.cellId}.png`, o.dataUrl);
    list.push({
      id: o.cellId,
      bbox: o.bbox,
      image: ref,
      viewport: { width: o.width, height: o.height },
      source: o.source,
    });
  }
  const mark = overlayByI.get('mark-grid');
  if (mark) {
    const cells = (cellsByOverlay.get('mark-grid') ?? []).sort((a, b) => a.id.localeCompare(b.id));
    if (cells.length === 0) throw new Error(`mark-grid sem crops para ${sceneId}`);
    overlays[overlays.indexOf(mark)] = { ...mark, cells };
  }
  const ordenadas = resolutions.sort(
    (a, b) => Number(b.width) - Number(a.width),
  );
  return { resolutions: ordenadas, overlays };
}
