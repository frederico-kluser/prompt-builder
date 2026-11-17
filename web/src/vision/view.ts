// Benchmark de visão — VISÃO da UI (puro): recorta o record por cenário×modelo
// e monta os dados do overlay (previsões, elementos perdidos, ações). Nada de
// React aqui — é o que os componentes desenham e o que os testes cobrem.
//
// A regra de leitura é a MESMA do placar (`src/engine/vision/score.ts`): o que
// casou é o que está em `score.matches`; previsão sem elemento é erro do modelo
// (ponto vermelho), elemento sem previsão é perda (caixa vermelha).

import type {
  VisionActionCell,
  VisionBBox,
  VisionElement,
  VisionMapCell,
  VisionRunRecord,
  VisionScene,
} from '../engine/vision';

export interface SceneModelView {
  sceneId: string;
  modelId: string;
  map: VisionMapCell | null;
  actions: VisionActionCell[];
  /** Métricas do modo mapa (null = modo não rodado nesta célula). */
  mapF1: number | null;
  mapPrecision: number | null;
  mapRecall: number | null;
  mapMatched: number;
  mapLabeled: number;
  mapElements: number;
  /** Taxa de acerto do modo ação (null = sem tarefas). */
  actionPass: number | null;
  actionTasks: number;
  /** Nota combinada do cenário×modelo (média das notas disponíveis). */
  combined: number | null;
  /** Células contadas (erro conta como resposta errada; pulada fica fora). */
  counted: number;
  skipped: number;
}

/** Recorta as células de UM cenário×modelo e calcula as notas daquele recorte. */
export function sceneModelView(
  record: VisionRunRecord,
  sceneId: string,
  modelId: string,
): SceneModelView {
  const cells = record.cells.filter((c) => c.sceneId === sceneId && c.modelId === modelId);
  const mapCell = cells.find((c): c is VisionMapCell => c.kind === 'map' && c.status !== 'skipped') ?? null;
  const actionCells = cells.filter((c): c is VisionActionCell => c.kind === 'action' && c.status !== 'skipped');
  const map = mapCell?.score ?? null;
  const pass = actionCells.filter((c) => c.score?.pass).length;
  const actionPass = actionCells.length > 0 ? pass / actionCells.length : null;
  const partes: number[] = [];
  if (map) partes.push(map.f1);
  if (actionPass !== null) partes.push(actionPass);
  return {
    sceneId,
    modelId,
    map: mapCell,
    actions: actionCells,
    mapF1: map?.f1 ?? null,
    mapPrecision: map?.precision ?? null,
    mapRecall: map?.recall ?? null,
    mapMatched: map?.matched ?? 0,
    mapLabeled: map?.labeled ?? 0,
    mapElements: map?.elements ?? 0,
    actionPass,
    actionTasks: actionCells.length,
    combined: partes.length > 0 ? partes.reduce((a, b) => a + b, 0) / partes.length : null,
    counted: cells.filter((c) => c.status !== 'skipped').length,
    skipped: cells.filter((c) => c.status === 'skipped').length,
  };
}

/** Matriz cenário × modelo (linhas na ordem do record; colunas na do placar). */
export function sceneModelMatrix(
  record: VisionRunRecord,
  sceneIds: readonly string[],
  modelIds: readonly string[],
): SceneModelView[][] {
  return sceneIds.map((sceneId) => modelIds.map((modelId) => sceneModelView(record, sceneId, modelId)));
}

export interface OverlayPrediction {
  x: number;
  y: number;
  hit: boolean;
  labeled: boolean;
  label: string | null;
  type: string;
}

export interface OverlayMiss {
  id: string;
  label: string | null;
  type: string;
  bbox: VisionBBox;
}

export interface OverlayAction {
  taskId: string;
  instruction: string;
  expectedAction: string;
  predictedAction: string | null;
  pass: boolean;
  actionOk: boolean;
  targetHit: boolean | null;
  textOk: boolean | null;
  point: { x: number; y: number } | null;
  target: { label: string | null; bbox: VisionBBox } | null;
  status: 'ok' | 'error' | 'skipped';
  error?: string;
}

export interface Overlay {
  predictions: OverlayPrediction[];
  missed: OverlayMiss[];
  actions: OverlayAction[];
}

/** Dados do overlay de um cenário para um modelo (mapa + ações). */
export function buildOverlay(scene: VisionScene, view: Pick<SceneModelView, 'map' | 'actions'>): Overlay {
  const elementos = new Map(scene.elements.map((e) => [e.id, e]));
  const preds: OverlayPrediction[] = [];
  const missed: OverlayMiss[] = [];
  const map = view.map;
  if (map) {
    type Match = NonNullable<VisionMapCell['score']>['matches'][number];
    const porPred = new Map<number, Match>();
    for (const m of map.score?.matches ?? []) if (m.predIndex >= 0) porPred.set(m.predIndex, m);
    map.predictions.forEach((p, i) => {
      const m = porPred.get(i);
      preds.push({
        x: p.x,
        y: p.y,
        hit: Boolean(m?.hit),
        labeled: Boolean(m?.labeled),
        label: p.label ?? p.iconDescription,
        type: p.type,
      });
    });
    for (const m of map.score?.matches ?? []) {
      if (m.hit) continue;
      const el = elementos.get(m.elementId);
      if (el) missed.push({ id: el.id, label: el.label ?? el.iconDescription, type: el.type, bbox: el.bbox });
    }
  }
  const actions: OverlayAction[] = view.actions.map((cell) => {
    const task = scene.tasks.find((t) => t.id === cell.taskId);
    const alvo = task?.expect.targetId ? elementos.get(task.expect.targetId) : undefined;
    const pred = cell.prediction;
    return {
      taskId: cell.taskId,
      instruction: cell.instruction,
      expectedAction: task?.expect.action ?? '—',
      predictedAction: pred?.action ?? null,
      pass: Boolean(cell.score?.pass),
      actionOk: Boolean(cell.score?.actionOk),
      targetHit: cell.score?.targetHit ?? null,
      textOk: cell.score?.textOk ?? null,
      point: pred?.x != null && pred?.y != null ? { x: pred.x, y: pred.y } : null,
      target: alvo ? { label: alvo.label ?? alvo.iconDescription, bbox: alvo.bbox } : null,
      status: cell.status,
      ...(cell.error ? { error: cell.error } : {}),
    };
  });
  return { predictions: preds, missed, actions };
}

export type ScoreBand = 'forte' | 'medio' | 'fraco';

/** Faixa de qualidade (cor como DADO; o número acompanha sempre). */
export function scoreBand(v: number | null): ScoreBand | null {
  if (v === null || Number.isNaN(v)) return null;
  if (v >= 0.75) return 'forte';
  if (v >= 0.5) return 'medio';
  return 'fraco';
}

export const BAND_CLASS: Record<ScoreBand, string> = {
  forte: 'border-resolve/30 bg-resolve-soft text-resolve',
  medio: 'border-parcial/30 bg-parcial-soft text-parcial',
  fraco: 'border-nao/30 bg-nao-soft text-nao',
};

export const BAND_LABEL: Record<ScoreBand, string> = { forte: 'forte', medio: 'médio', fraco: 'fraco' };

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (v === 0) return '$0';
  return `$${v.toFixed(v < 0.01 ? 5 : 4)}`;
}

/** Vencedor determinístico: nota → mapa F1 → id do modelo (desempate estável). */
export function winnerOf(record: VisionRunRecord): VisionRunRecord['contestants'][number] | null {
  if (record.contestants.length === 0) return null;
  return [...record.contestants].sort(
    (a, b) => b.score - a.score || (b.map?.f1 ?? 0) - (a.map?.f1 ?? 0) || a.modelId.localeCompare(b.modelId),
  )[0]!;
}

/** Cenários do record que têm imagem no dataset carregado. */
export function scenesOfRun(record: VisionRunRecord, dataset: { scenes: VisionScene[] }): VisionScene[] {
  const porId = new Map(dataset.scenes.map((s) => [s.id, s]));
  return record.dataset.scenes.map((id) => porId.get(id)).filter((s): s is VisionScene => Boolean(s));
}

/** Rótulo curto de um elemento (label ou descrição do ícone). */
export function elementName(el: { label: string | null; iconDescription?: string | null }): string {
  return el.label ?? el.iconDescription ?? '—';
}
