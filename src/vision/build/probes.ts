// BENCHMARK DE VISÃO — variantes de APRESENTAÇÃO geradas no build.
//
// Os bancos `resolution`, `grid` e `matrix` mudam a imagem que o modelo vê,
// mas NUNCA a verdade: ela continua sendo o DOM da tela base. As variantes são
// derivadas da imagem canônica e pinadas por sha256 no manifesto.
//
// Além dos overlays clássicos (grade desenhada em cima do print), este build
// gera as variantes "sem cima do print":
//   • `frame-axis`  — o print fica intacto dentro de uma moldura; as réguas
//                     ficam só nas margens;
//   • `frame-mark`  — moldura + letras de coluna e números de linha nas margens;
//   • `sidecar-grid`— uma imagem SEPARADA só com a grade de referência.
// O Chromium já é dependência do build (playwright-core): o canvas dele faz o
// resize, as molduras e os recortes sem trazer `sharp`/`canvas` ao pacote.

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
const FRAME_COLS = 6;
const FRAME_ROWS = 4;
const COLORS = {
  line: 'rgba(15, 23, 42, 0.42)',
  axis: 'rgba(14, 116, 144, 0.55)',
  chip: 'rgba(255, 255, 255, 0.92)',
  ink: '#0f172a',
  frame: '#0b0d10',
  frameInk: '#dbe7f3',
  frameMut: '#8aa0b4',
  cyan: '#67e8f9',
};
const FONT = '600 18px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const FRAME_FONT = '600 15px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

interface CanvasOutput {
  kind: 'resolution' | 'overlay' | 'crop' | 'frame' | 'sidecar';
  id: string;
  dataUrl: string;
  width: number;
  height: number;
  cellId?: string;
  bbox?: VisionBBox;
  source?: VisionBBox;
  resolution?: VisionResolution;
  margins?: { left: number; top: number; right: number; bottom: number };
}

interface ResolutionSpec {
  id: VisionResolution;
  width: number;
  height: number;
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
      ({ canon, cols, rows, colors, font, frameFont, resolutions, cells }) => {
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
        const niceStep = (size: number): number => {
          if (size >= 1600) return 240;
          if (size >= 1200) return 160;
          if (size >= 900) return 120;
          return 80;
        };
        const frameMargin = (w: number, h: number) => ({
          left: Math.round(Math.max(58, w * 0.07)),
          top: Math.round(Math.max(48, h * 0.075)),
          right: 16,
          bottom: 16,
        });
        const drawTick = (
          ctx: CanvasRenderingContext2D,
          x1: number,
          y1: number,
          x2: number,
          y2: number,
          text: string,
          tx: number,
          ty: number,
          color: string,
        ): void => {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.fillStyle = colors.frameInk;
          ctx.font = frameFont;
          ctx.fillText(text, tx, ty);
        };

        // 1) resoluções: downscale da MESMA tela (sem reflow).
        const scaled: Array<{ r: typeof resolutions[number]; dataUrl: string; w: number; h: number; canvas: HTMLCanvasElement }> = [];
        for (const r of resolutions) {
          const [c, ctx] = canvas(r.width, r.height);
          ctx.drawImage(img, 0, 0, r.width, r.height);
          const dataUrl = c.toDataURL('image/png');
          outputs.push({ kind: 'resolution', id: r.id, dataUrl, width: r.width, height: r.height });
          scaled.push({ r, dataUrl, w: r.width, h: r.height, canvas: c });
        }

        // 2) grades clássicas em cima do print (mantidas para comparação).
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

        // 3) SEM CIMA DO PRINT — por resolução.
        for (const s of scaled) {
          const m = frameMargin(s.w, s.h);
          const fw = s.w + m.left + m.right;
          const fh = s.h + m.top + m.bottom;
          const stepX = niceStep(s.w);
          const stepY = niceStep(s.h);

          // moldura + réguas (frame-axis)
          {
            const [c, ctx] = canvas(fw, fh);
            ctx.fillStyle = colors.frame;
            ctx.fillRect(0, 0, fw, fh);
            ctx.drawImage(s.canvas, m.left, m.top, s.w, s.h);
            ctx.strokeStyle = 'rgba(255,255,255,0.22)';
            ctx.lineWidth = 1;
            ctx.strokeRect(m.left + 0.5, m.top + 0.5, s.w - 1, s.h - 1);
            for (let x = 0; x <= s.w; x += stepX) {
              const label = `x=${x}`;
              ctx.font = frameFont;
              const labelW = ctx.measureText(label).width;
              const tx = Math.min(m.left + x + 3, fw - labelW - 4);
              drawTick(ctx, m.left + x, m.top - 8, m.left + x, m.top - 1, label, tx, m.top - 12, colors.cyan);
            }
            for (let y = 0; y <= s.h; y += stepY) {
              drawTick(ctx, m.left - 8, m.top + y, m.left - 1, m.top + y, `y=${y}`, 3, m.top + y + 5, colors.cyan);
            }
            ctx.fillStyle = colors.frameMut;
            ctx.font = frameFont;
            ctx.fillText('captura sem grade; réguas nas margens', m.left, 18);
            outputs.push({
              kind: 'frame',
              id: 'frame-axis',
              resolution: s.r.id,
              dataUrl: c.toDataURL('image/png'),
              width: fw,
              height: fh,
              margins: m,
            });
          }

          // moldura + letras/números de célula (frame-mark)
          {
            const [c, ctx] = canvas(fw, fh);
            ctx.fillStyle = colors.frame;
            ctx.fillRect(0, 0, fw, fh);
            ctx.drawImage(s.canvas, m.left, m.top, s.w, s.h);
            ctx.strokeStyle = 'rgba(255,255,255,0.22)';
            ctx.lineWidth = 1;
            ctx.strokeRect(m.left + 0.5, m.top + 0.5, s.w - 1, s.h - 1);
            ctx.font = '700 16px ui-sans-serif, system-ui, sans-serif';
            ctx.textAlign = 'center';
            const cw = s.w / cols;
            const ch = s.h / rows;
            for (let col = 0; col < cols; col++) {
              const cx = m.left + cw * (col + 0.5);
              ctx.fillStyle = colors.cyan;
              ctx.fillText(String.fromCharCode(65 + col), cx, m.top - 16);
              ctx.strokeStyle = colors.cyan;
              ctx.beginPath();
              ctx.moveTo(m.left + cw * col, m.top - 7);
              ctx.lineTo(m.left + cw * col, m.top - 1);
              ctx.stroke();
            }
            for (let row = 0; row < rows; row++) {
              const cy = m.top + ch * (row + 0.5);
              ctx.fillStyle = colors.cyan;
              ctx.fillText(String(row + 1), m.left - 24, cy + 6);
            }
            ctx.textAlign = 'left';
            ctx.fillStyle = colors.frameMut;
            ctx.font = frameFont;
            ctx.fillText('captura sem grade; colunas A–F / linhas 1–4 nas margens', m.left, 18);
            outputs.push({
              kind: 'frame',
              id: 'frame-mark',
              resolution: s.r.id,
              dataUrl: c.toDataURL('image/png'),
              width: fw,
              height: fh,
              margins: m,
            });
          }

          // grade separada (sidecar-grid), mesma dimensão do print
          {
            const [c, ctx] = canvas(s.w, s.h);
            ctx.fillStyle = colors.frame;
            ctx.fillRect(0, 0, s.w, s.h);
            ctx.strokeStyle = 'rgba(103,232,249,0.55)';
            ctx.lineWidth = 1;
            const cw = s.w / cols;
            const ch = s.h / rows;
            for (let col = 0; col <= cols; col++) {
              ctx.beginPath();
              ctx.moveTo(Math.round(col * cw), 0);
              ctx.lineTo(Math.round(col * cw), s.h);
              ctx.stroke();
            }
            for (let row = 0; row <= rows; row++) {
              ctx.beginPath();
              ctx.moveTo(0, Math.round(row * ch));
              ctx.lineTo(s.w, Math.round(row * ch));
              ctx.stroke();
            }
            ctx.font = frameFont;
            ctx.fillStyle = colors.cyan;
            for (let row = 0; row < rows; row++) {
              for (let col = 0; col < cols; col++) {
                ctx.fillText(`${String.fromCharCode(65 + col)}${row + 1}`, col * cw + 6, row * ch + 20);
              }
            }
            ctx.fillStyle = colors.frameMut;
            ctx.fillText('grade de referência — use com a captura limpa', 8, s.h - 10);
            outputs.push({
              kind: 'sidecar',
              id: 'sidecar-grid',
              resolution: s.r.id,
              dataUrl: c.toDataURL('image/png'),
              width: s.w,
              height: s.h,
            });
          }
        }
        return outputs;
      },
      {
        canon: CANON,
        cols: FRAME_COLS,
        rows: FRAME_ROWS,
        colors: COLORS,
        font: FONT,
        frameFont: FRAME_FONT,
        resolutions: [
          { id: '1920x1080' as VisionResolution, width: 1920, height: 1080 },
          { id: '1280x720' as VisionResolution, width: 1280, height: 720 },
          { id: '960x540' as VisionResolution, width: 960, height: 540 },
          { id: '640x360' as VisionResolution, width: 640, height: 360 },
        ],
        cells: gridCells(FRAME_COLS, FRAME_ROWS),
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
 * Gera e grava as variantes de um cenário. A resolução NATIVA é a própria
 * imagem base (mesmo sha), para não duplicar bytes. Molduras e sidecars são
 * gerados POR resolução, porque as margens não podem ser reduzidas junto com
 * o print sem ficarem ilegíveis.
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
      // 1080p é a própria imagem base (mesmo sha); não duplica bytes.
      if (o.id === '1920x1080') continue;
      const ref = await writePng(root, `resolutions/${sceneId}-${o.id}.png`, o.dataUrl);
      resolutions.push({ id: o.id as VisionResolution, width: o.width, height: o.height, ...ref });
      continue;
    }
    if (o.kind === 'overlay') {
      const ref = await writePng(root, `overlays/${sceneId}-${o.id}.png`, o.dataUrl);
      const overlay: VisionGridOverlay = {
        id: o.id as VisionGridOverlay['id'],
        kind: 'overlay',
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
    if (o.kind === 'frame' || o.kind === 'sidecar') {
      const sub = o.kind === 'frame' ? 'frames' : 'sidecars';
      const ref = await writePng(root, `${sub}/${sceneId}-${o.resolution}-${o.id}.png`, o.dataUrl);
      overlays.push({
        id: o.id as VisionGridOverlay['id'],
        kind: o.kind,
        resolution: o.resolution,
        image: ref,
        viewport: { width: o.width, height: o.height },
        cols: FRAME_COLS,
        rows: FRAME_ROWS,
        ...(o.margins ? { margins: o.margins } : {}),
      });
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
  const ordenadas = resolutions.sort((a, b) => Number(b.width) - Number(a.width));
  return { resolutions: ordenadas, overlays };
}
