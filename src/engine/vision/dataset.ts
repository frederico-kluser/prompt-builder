// BENCHMARK DE VISÃO — dataset: schema, hash e seleção (puro).
//
// O manifesto é a PROVA: um cenário só existe depois de renderizado e pinado
// aqui (imagem + sha256 + caixas do DOM). Não há "prova criada na hora" — o
// record aponta para a versão e o hash do manifesto, e a imagem conferida por
// sha256. Um cenário novo/ corrigido é uma nova versão do dataset.
//
// O schema é zod ESTRITO: chave desconhecida é erro (nada de campo ignorado em
// silêncio). A validação semântica (ids, caixas, tarefas) vem depois, no
// `validateScene`, porque a mensagem precisa dizer QUAL cenário/quebrou.

import { z } from 'zod';
import { contentHash } from '../hash.js';
import {
  VISION_DATASET_FORMAT,
  VISION_ELEMENT_TYPES,
  VISION_FAMILIES,
  VISION_GRID_VARIANTS,
  VISION_RESOLUTIONS,
  VISION_TASKS,
  VISION_VIEWPORT,
} from './types.js';
import type {
  VisionAction,
  VisionBenchmark,
  VisionDataset,
  VisionFamily,
  VisionGridOverlay,
  VisionGridVariant,
  VisionResolutionRef,
  VisionScene,
  VisionTaskKind,
} from './types.js';
import { VISION_ACTIONS } from './types.js';

const bboxSchema = z.strictObject({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  w: z.number().finite().positive(),
  h: z.number().finite().positive(),
});

const elementSchema = z.strictObject({
  id: z.string().min(1),
  type: z.enum(VISION_ELEMENT_TYPES),
  label: z.string().min(1).nullable(),
  iconDescription: z.string().min(1).nullable(),
  aliases: z.array(z.string().min(1)).optional(),
  bbox: bboxSchema,
  center: z.strictObject({ x: z.number().finite(), y: z.number().finite() }),
  state: z
    .strictObject({
      disabled: z.boolean().optional(),
      checked: z.boolean().optional(),
      focused: z.boolean().optional(),
      expanded: z.boolean().optional(),
    })
    .optional(),
  hint: z.string().optional(),
});

const taskSchema = z.strictObject({
  id: z.string().min(1),
  sceneId: z.string().min(1),
  kind: z.literal('action'),
  instruction: z.string().min(2),
  expect: z.strictObject({
    action: z.enum(VISION_ACTIONS),
    targetId: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
  }),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  tags: z.array(z.string().min(1)).optional(),
});

const imageRefSchema = z.strictObject({
  file: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
});

const resolutionRefSchema = imageRefSchema.extend({
  id: z.enum(VISION_RESOLUTIONS),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const viewportSchema = z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() });

const gridCellSchema = z.strictObject({
  id: z.string().regex(/^[A-Z][0-9]+$/),
  bbox: bboxSchema,
  image: imageRefSchema,
  viewport: viewportSchema,
  source: bboxSchema,
});

const overlaySchema = z.strictObject({
  id: z.enum(VISION_GRID_VARIANTS.filter((v) => v !== 'plain') as ['grid-simple', 'axis-grid', 'mark-grid']),
  image: imageRefSchema,
  viewport: viewportSchema,
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  step: z.number().positive().optional(),
  cells: z.array(gridCellSchema).optional(),
});

const probesSchema = z.strictObject({
  resolutions: z.array(resolutionRefSchema).optional(),
  overlays: z.array(overlaySchema).optional(),
});

const sceneSchema = z.strictObject({
  id: z.string().min(1),
  family: z.enum(VISION_FAMILIES),
  title: z.string().min(1),
  theme: z.enum(['light', 'dark']),
  viewport: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }),
  image: z.strictObject({
    file: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive(),
  }),
  code: z.strictObject({ file: z.string().min(1) }),
  elements: z.array(elementSchema),
  tasks: z.array(taskSchema),
  probes: probesSchema.optional(),
  tags: z.array(z.string().min(1)).optional(),
});

const assetSchema = z.strictObject({
  family: z.enum(VISION_FAMILIES),
  name: z.string().min(1),
  version: z.string().min(1),
  license: z.string().min(1),
  files: z.array(z.string().min(1)),
});

export const visionDatasetSchema = z.strictObject({
  format: z.literal(VISION_DATASET_FORMAT),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  generator: z.string().min(1),
  createdAt: z.string().min(1),
  viewport: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }),
  scenes: z.array(sceneSchema).min(1),
  assets: z.array(assetSchema),
});

export class VisionDatasetError extends Error {
  readonly code = 'VISION_DATASET';
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'VisionDatasetError';
    this.issues = issues;
  }
}

/** Parse ESTRITO do manifesto; nunca lança para o chamador: devolve issues. */
export function parseVisionDataset(raw: unknown): { dataset: VisionDataset | null; issues: string[] } {
  const parsed = visionDatasetSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`);
    return { dataset: null, issues };
  }
  const dataset = parsed.data as VisionDataset;
  const issues = validateDatasetSemantics(dataset);
  return { dataset, issues };
}

/** Checagens semânticas que o schema não expressa (ids, caixas, tarefas). */
export function validateDatasetSemantics(dataset: VisionDataset): string[] {
  const issues: string[] = [];
  const viewport = dataset.viewport;
  if (viewport.width !== VISION_VIEWPORT.width || viewport.height !== VISION_VIEWPORT.height) {
    issues.push(`viewport: esperado ${VISION_VIEWPORT.width}×${VISION_VIEWPORT.height}, veio ${viewport.width}×${viewport.height}`);
  }
  const sceneIds = new Set<string>();
  const taskIds = new Set<string>();
  for (const scene of dataset.scenes) {
    const onde = `cenário "${scene.id}"`;
    if (sceneIds.has(scene.id)) issues.push(`${onde}: id duplicado`);
    sceneIds.add(scene.id);
    if (scene.viewport.width !== viewport.width || scene.viewport.height !== viewport.height) {
      issues.push(`${onde}: viewport próprio (${scene.viewport.width}×${scene.viewport.height}) ≠ dataset`);
    }
    if (scene.elements.length === 0) issues.push(`${onde}: sem elementos interativos (cenário vazio)`);
    const elIds = new Set<string>();
    for (const el of scene.elements) {
      const ondeEl = `${onde} → elemento "${el.id}"`;
      if (elIds.has(el.id)) issues.push(`${ondeEl}: id duplicado`);
      elIds.add(el.id);
      if (el.label === null && el.iconDescription === null) {
        issues.push(`${ondeEl}: label e iconDescription nulos ao mesmo tempo`);
      }
      if (el.type === 'other') issues.push(`${ondeEl}: tipo "other" não deveria estar na verdade do dataset`);
      if (el.bbox.x + el.bbox.w > viewport.width + 1 || el.bbox.y + el.bbox.h > viewport.height + 1) {
        issues.push(`${ondeEl}: caixa fora da imagem`);
      }
      const cx = el.bbox.x + el.bbox.w / 2;
      const cy = el.bbox.y + el.bbox.h / 2;
      if (Math.abs(cx - el.center.x) > 1 || Math.abs(cy - el.center.y) > 1) {
        issues.push(`${ondeEl}: center (${el.center.x},${el.center.y}) ≠ centro da caixa (${cx.toFixed(1)},${cy.toFixed(1)})`);
      }
    }
    if (scene.probes) {
      const ondeProbe = `${onde} → probes`;
      const resIds = new Set<string>();
      for (const r of scene.probes.resolutions ?? []) {
        if (resIds.has(r.id)) issues.push(`${ondeProbe}: resolução "${r.id}" duplicada`);
        resIds.add(r.id);
        if (r.width !== Number(r.id.split('x')[0]) || r.height !== Number(r.id.split('x')[1])) {
          issues.push(`${ondeProbe}: resolução "${r.id}" não casa com ${r.width}×${r.height}`);
        }
      }
      const overlayIds = new Set<string>();
      for (const ov of scene.probes.overlays ?? []) {
        if (overlayIds.has(ov.id)) issues.push(`${ondeProbe}: overlay "${ov.id}" duplicado`);
        overlayIds.add(ov.id);
        if (ov.viewport.width !== viewport.width || ov.viewport.height !== viewport.height) {
          issues.push(`${ondeProbe}: overlay "${ov.id}" tem viewport ${ov.viewport.width}×${ov.viewport.height} ≠ dataset`);
        }
        if (ov.id === 'mark-grid' && (!ov.cells || ov.cells.length === 0)) {
          issues.push(`${ondeProbe}: "mark-grid" sem células/crops`);
        }
        const celIds = new Set<string>();
        for (const c of ov.cells ?? []) {
          if (celIds.has(c.id)) issues.push(`${ondeProbe}: célula "${c.id}" duplicada no mark-grid`);
          celIds.add(c.id);
          if (c.bbox.x + c.bbox.w > viewport.width + 1 || c.bbox.y + c.bbox.h > viewport.height + 1) {
            issues.push(`${ondeProbe}: célula "${c.id}" fora da imagem`);
          }
          if (c.source.x + c.source.w > viewport.width + 1 || c.source.y + c.source.h > viewport.height + 1) {
            issues.push(`${ondeProbe}: recorte de "${c.id}" fora da imagem`);
          }
        }
      }
    }
    for (const task of scene.tasks) {
      const ondeTask = `${onde} → tarefa "${task.id}"`;
      if (taskIds.has(task.id)) issues.push(`${ondeTask}: id duplicado (global)`);
      taskIds.add(task.id);
      if (task.sceneId !== scene.id) issues.push(`${ondeTask}: sceneId "${task.sceneId}" ≠ cenário`);
      if (task.expect.targetId && !elIds.has(task.expect.targetId)) {
        issues.push(`${ondeTask}: targetId "${task.expect.targetId}" não existe no cenário`);
      }
      const semAlvo = task.expect.action === 'scroll' || task.expect.action === 'key';
      if (!semAlvo && !task.expect.targetId) {
        issues.push(`${ondeTask}: ação "${task.expect.action}" exige targetId`);
      }
      if (semAlvo && task.expect.targetId) {
        issues.push(`${ondeTask}: ação "${task.expect.action}" não tem alvo na tela`);
      }
    }
  }
  return issues;
}

/** Hash do manifesto (JCS/SHA-256): muda quando QUALQUER byte do dataset muda. */
export function datasetHash(dataset: VisionDataset): string {
  return contentHash(dataset);
}

export interface DatasetFilters {
  families?: readonly VisionFamily[] | null;
  scenes?: readonly string[] | null;
  limit?: number | null;
}

/**
 * Seleção determinística: a ordem é a do manifesto (nunca a do sistema de
 * arquivos), filtros opcionais e `limit` corta no fim. Ids desconhecidos são
 * reportados para o CLI recusar com exit 3 em vez de rodar outro dataset.
 */
export function selectScenes(
  dataset: VisionDataset,
  filters: DatasetFilters = {},
): { scenes: VisionScene[]; unknownSceneIds: string[]; unknownFamilies: string[] } {
  const familias = filters.families ? new Set(filters.families) : null;
  const ids = filters.scenes ? new Set(filters.scenes) : null;
  const existentes = new Set(dataset.scenes.map((s) => s.id));
  const familiasExistentes = new Set(dataset.scenes.map((s) => s.family));
  const unknownSceneIds = filters.scenes ? filters.scenes.filter((id) => !existentes.has(id)) : [];
  const unknownFamilies = filters.families
    ? filters.families.filter((f) => !familiasExistentes.has(f))
    : [];
  let scenes = dataset.scenes.filter((s) => (!familias || familias.has(s.family)) && (!ids || ids.has(s.id)));
  if (typeof filters.limit === 'number' && filters.limit > 0) scenes = scenes.slice(0, filters.limit);
  return { scenes, unknownSceneIds, unknownFamilies };
}

/** Uma célula planejada do run (o que vai virar uma chamada). */
export interface VisionPlannedCell {
  cellId: string;
  kind: VisionTaskKind;
  scene: VisionScene;
  task?: VisionScene['tasks'][number];
  /** Banco de probe desta célula (ausente = F0). */
  benchmark?: VisionBenchmark;
  /** Escala (`resolution`) ou variante (`grid`). */
  variant?: string;
  resolution?: VisionResolutionRef;
  overlay?: VisionGridOverlay;
}

/** Opções do planejamento dos bancos de probe. */
export interface VisionPlanOptions {
  benchmark?: VisionBenchmark;
  resolutions?: readonly string[];
  gridVariants?: readonly VisionGridVariant[];
}

/**
 * Planejamento determinístico de todas as células do run.
 *
 * O F0 (`grounding`) não muda: 1 mapa por cena + 1 ação por tarefa. Os bancos
 * de probe trocam a APRESENTAÇÃO e mantêm a mesma verdade:
 *   • `resolution`: 1 mapa por (cena × escala) — só o modo mapa faz sentido;
 *   • `grid`: 1 ação por (tarefa × variante) — só o modo ação faz sentido.
 * Variante ausente do manifesto é simplesmente omitida; o CLI recusa o run
 * vazio antes de gastar.
 */
export function planCells(
  scenes: readonly VisionScene[],
  tasks: readonly VisionTaskKind[],
  opts: VisionPlanOptions = {},
): VisionPlannedCell[] {
  const benchmark = opts.benchmark ?? 'grounding';
  const plan: VisionPlannedCell[] = [];
  if (benchmark === 'resolution') {
    if (!tasks.includes('map')) return plan;
    for (const scene of scenes) {
      const disponiveis = scene.probes?.resolutions ?? [];
      const wanted = opts.resolutions ? new Set(opts.resolutions) : null;
      for (const r of disponiveis) {
        if (wanted && !wanted.has(r.id)) continue;
        plan.push({
          cellId: `map:${scene.id}@${r.id}`,
          kind: 'map',
          scene,
          benchmark,
          variant: r.id,
          resolution: r,
        });
      }
    }
    return plan;
  }
  if (benchmark === 'grid') {
    if (!tasks.includes('action')) return plan;
    const wanted = new Set(opts.gridVariants ?? VISION_GRID_VARIANTS);
    for (const scene of scenes) {
      for (const task of scene.tasks) {
        for (const variant of VISION_GRID_VARIANTS) {
          if (!wanted.has(variant)) continue;
          const overlay =
            variant === 'plain' ? undefined : scene.probes?.overlays?.find((o) => o.id === variant);
          // Sem o overlay pinado a variante não existe naquele cenário.
          if (variant !== 'plain' && !overlay) continue;
          plan.push({
            cellId: `action:${task.id}@${variant}`,
            kind: 'action',
            scene,
            task,
            benchmark,
            variant,
            ...(overlay ? { overlay } : {}),
          });
        }
      }
    }
    return plan;
  }
  if (tasks.includes('map')) {
    for (const scene of scenes) plan.push({ cellId: `map:${scene.id}`, kind: 'map', scene });
  }
  if (tasks.includes('action')) {
    for (const scene of scenes) {
      for (const task of scene.tasks) plan.push({ cellId: `action:${task.id}`, kind: 'action', scene, task });
    }
  }
  return plan;
}

/** Resumo do dataset (para `vision dataset list` e o relatório). */
export interface VisionDatasetSummary {
  version: string;
  generator: string;
  createdAt: string;
  scenes: number;
  elements: number;
  actionTasks: number;
  bytes: number;
  families: Array<{ family: VisionFamily; scenes: number; elements: number; tasks: number }>;
}

export function summarizeDataset(dataset: VisionDataset): VisionDatasetSummary {
  const porFamilia = new Map<VisionFamily, { scenes: number; elements: number; tasks: number }>();
  let elements = 0;
  let tasks = 0;
  let bytes = 0;
  for (const scene of dataset.scenes) {
    elements += scene.elements.length;
    tasks += scene.tasks.length;
    bytes += scene.image.bytes;
    const f = porFamilia.get(scene.family) ?? { scenes: 0, elements: 0, tasks: 0 };
    f.scenes += 1;
    f.elements += scene.elements.length;
    f.tasks += scene.tasks.length;
    porFamilia.set(scene.family, f);
  }
  return {
    version: dataset.version,
    generator: dataset.generator,
    createdAt: dataset.createdAt,
    scenes: dataset.scenes.length,
    elements,
    actionTasks: tasks,
    bytes,
    families: [...porFamilia.entries()].map(([family, v]) => ({ family, ...v })),
  };
}

/** Ação esperada como texto legível (relatório). */
export function describeAction(action: VisionAction): string {
  return action;
}
