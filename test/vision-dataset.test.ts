// Contrato do DATASET de visão: manifesto estrito, pinagem por sha256, verdade
// coerente (centro/caixa/tarefas) e seleção determinística.
//
// Este arquivo é o guarda do "banco de imagens com coordenadas": se uma imagem
// mudar sem o manifesto, se um `targetId` sumir ou se uma caixa sair da tela,
// o teste falha — não o placar de um modelo.

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  datasetHash,
  parseVisionDataset,
  selectScenes,
  summarizeDataset,
  VISION_VIEWPORT,
  type VisionDataset,
} from '../src/engine/vision/index.js';
import { loadVisionDataset, verifyVisionDataset, visionDataDir } from '../src/vision/dataset.js';

/** Dimensões do PNG pelos bytes do IHDR (sem dependência de imagem). */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function tempDataset(sceneOverride?: (d: VisionDataset) => void): Promise<{ dir: string; dataset: VisionDataset }> {
  const { dataset } = await loadVisionDataset();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vision-dataset-'));
  await fs.mkdir(path.join(dir, 'images'), { recursive: true });
  const cena = dataset.scenes[0]!;
  const bytes = await fs.readFile(path.join(visionDataDir(), cena.image.file));
  const copia = structuredClone(dataset);
  copia.scenes = [structuredClone(cena)];
  copia.assets = [];
  sceneOverride?.(copia);
  await fs.writeFile(path.join(dir, 'images', path.basename(cena.image.file)), bytes);
  await fs.mkdir(path.join(dir, 'scenes', cena.family), { recursive: true });
  await fs.writeFile(path.join(dir, cena.code.file), '<html><body>ok</body></html>', 'utf8');
  await fs.writeFile(path.join(dir, 'dataset@1.json'), JSON.stringify(copia), 'utf8');
  return { dir, dataset: copia };
}

describe('dataset versionado', () => {
  it('carrega, valida e verifica as imagens reais (sha256 + 1080p)', async () => {
    const loaded = await loadVisionDataset();
    expect(loaded.dataset.format).toBe('vision-dataset@1');
    expect(loaded.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const v = await verifyVisionDataset();
    expect(v.issues).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.checked).toBeGreaterThanOrEqual(loaded.dataset.scenes.length * 2);
    const familias = new Set(loaded.dataset.scenes.map((s) => s.family));
    expect(familias.size).toBeGreaterThanOrEqual(2);
    for (const scene of loaded.dataset.scenes) {
      const bytes = await fs.readFile(path.join(visionDataDir(), scene.image.file));
      const { width, height } = pngSize(bytes);
      expect({ id: scene.id, width, height }).toEqual({
        id: scene.id,
        width: VISION_VIEWPORT.width,
        height: VISION_VIEWPORT.height,
      });
      expect(scene.elements.length).toBeGreaterThanOrEqual(5);
      for (const el of scene.elements) {
        expect(el.center.x).toBeGreaterThanOrEqual(0);
        expect(el.center.x).toBeLessThanOrEqual(VISION_VIEWPORT.width);
        expect(el.center.y).toBeGreaterThanOrEqual(0);
        expect(el.center.y).toBeLessThanOrEqual(VISION_VIEWPORT.height);
        expect(el.label === null && el.iconDescription === null).toBe(false);
        expect(el.type).not.toBe('other');
      }
      for (const task of scene.tasks) {
        if (task.expect.action !== 'scroll' && task.expect.action !== 'key') {
          expect(scene.elements.some((e) => e.id === task.expect.targetId)).toBe(true);
        }
      }
    }
  });

  it('todo cenário tem 4 resoluções e 3 overlays pinados; mark-grid tem 24 crops', async () => {
    const loaded = await loadVisionDataset();
    for (const scene of loaded.dataset.scenes) {
      expect(scene.probes?.resolutions?.map((r) => r.id)).toEqual([
        '1920x1080',
        '1280x720',
        '960x540',
        '640x360',
      ]);
      const native = scene.probes!.resolutions!.find((r) => r.id === '1920x1080')!;
      expect(native.file).toBe(scene.image.file);
      expect(native.sha256).toBe(scene.image.sha256);
      expect(scene.probes?.overlays?.map((o) => o.id).sort()).toEqual([
        'axis-grid',
        'grid-simple',
        'mark-grid',
      ]);
      const mark = scene.probes!.overlays!.find((o) => o.id === 'mark-grid')!;
      expect(mark.cells).toHaveLength(24);
      expect(new Set(mark.cells!.map((c) => c.id)).size).toBe(24);
      for (const cell of mark.cells!) {
        expect(cell.viewport).toEqual({ width: 640, height: 540 });
        expect(cell.bbox.x + cell.bbox.w).toBeLessThanOrEqual(VISION_VIEWPORT.width);
        expect(cell.bbox.y + cell.bbox.h).toBeLessThanOrEqual(VISION_VIEWPORT.height);
        const bytes = await fs.readFile(path.join(visionDataDir(), cell.image.file));
        expect(pngSize(bytes)).toEqual({ width: 640, height: 540 });
      }
      for (const r of scene.probes!.resolutions!.filter((x) => x.id !== '1920x1080')) {
        const bytes = await fs.readFile(path.join(visionDataDir(), r.file));
        expect(pngSize(bytes)).toEqual({ width: r.width, height: r.height });
      }
    }
  });

  it('resumo bate com o manifesto (cenários/elementos/tarefas)', async () => {
    const loaded = await loadVisionDataset();
    const s = summarizeDataset(loaded.dataset);
    expect(s.scenes).toBe(loaded.dataset.scenes.length);
    expect(s.elements).toBe(loaded.dataset.scenes.reduce((a, c) => a + c.elements.length, 0));
    expect(s.actionTasks).toBe(loaded.dataset.scenes.reduce((a, c) => a + c.tasks.length, 0));
    expect(s.families.reduce((a, f) => a + f.scenes, 0)).toBe(s.scenes);
  });

  it('schema é ESTRITO: chave desconhecida é erro, não é ignorada', async () => {
    const loaded = await loadVisionDataset();
    const cru = JSON.parse(JSON.stringify(loaded.dataset)) as Record<string, unknown>;
    (cru.scenes as Array<Record<string, unknown>>)[0]!.extra = 'campo novo';
    const r = parseVisionDataset(cru);
    expect(r.dataset).toBeNull();
    expect(r.issues.join(' ')).toContain('extra');
  });

  it('seleção é determinística e reporta ids/famílias desconhecidos', async () => {
    const { dataset } = await loadVisionDataset();
    const a = selectScenes(dataset, { families: ['bootstrap'], limit: 2 });
    const b = selectScenes(dataset, { families: ['bootstrap'], limit: 2 });
    expect(a.scenes.map((s) => s.id)).toEqual(b.scenes.map((s) => s.id));
    expect(a.scenes.length).toBe(2);
    const c = selectScenes(dataset, { scenes: ['nao-existe', dataset.scenes[0]!.id] });
    expect(c.unknownSceneIds).toEqual(['nao-existe']);
    expect(c.scenes.map((s) => s.id)).toEqual([dataset.scenes[0]!.id]);
    const d = selectScenes(dataset, { families: ['macos' as never] });
    expect(d.scenes.every((s) => s.family === 'macos')).toBe(true);
    expect(d.unknownFamilies).toEqual([]);
  });

  it('hash muda quando QUALQUER campo do manifesto muda', async () => {
    const { dataset } = await loadVisionDataset();
    const h1 = datasetHash(dataset);
    const copia = structuredClone(dataset);
    copia.scenes[0]!.title += ' (editado)';
    expect(datasetHash(copia)).not.toBe(h1);
  });

  it('verify acusa imagem adulterada (sha256 diverge)', async () => {
    const { dir } = await tempDataset((d) => {
      d.scenes[0]!.image.sha256 = 'b'.repeat(64);
    });
    const v = await verifyVisionDataset(dir);
    expect(v.ok).toBe(false);
    expect(v.issues.join(' ')).toContain('sha256 da imagem diverge');
  });

  it('verify acusa targetId que não existe no cenário', async () => {
    const { dir } = await tempDataset((d) => {
      d.scenes[0]!.tasks[0]!.expect.targetId = 'fantasma';
    });
    const v = await verifyVisionDataset(dir);
    expect(v.ok).toBe(false);
    expect(v.issues.join(' ')).toContain('não existe no cenário');
  });
});
