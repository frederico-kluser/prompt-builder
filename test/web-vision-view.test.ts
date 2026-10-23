// Contrato da VISÃO da UI do benchmark de visão (puro): recorte cenário×modelo,
// overlay (acerto/perda/ação), faixas de nota e desempate do vencedor.
//
// O overlay é o que a tela desenha; se ele marcar como "perdido" um controle que
// o placar casou (ou vice-versa), o usuário vê um heatmap que contradiz a nota.

import { describe, expect, it } from 'vitest';
import {
  buildOverlay,
  elementName,
  fmtPct,
  fmtUsd,
  sceneModelMatrix,
  sceneModelView,
  scenesOfRun,
  scoreBand,
  winnerOf,
} from '../web/src/vision/view.js';
import type {
  VisionActionCell,
  VisionContestant,
  VisionMapCell,
  VisionRunRecord,
  VisionScene,
} from '../src/engine/vision/index.js';
import { VISION_RUN_FORMAT } from '../src/engine/vision/index.js';

const scene: VisionScene = {
  id: 's1',
  family: 'bootstrap',
  title: 'Cena',
  theme: 'light',
  viewport: { width: 1920, height: 1080 },
  image: { file: 'images/s1.png', sha256: 'a'.repeat(64), bytes: 1 },
  code: { file: 'scenes/bootstrap/s1.html' },
  elements: [
    { id: 'e1', type: 'button', label: 'Entrar', iconDescription: null, bbox: { x: 100, y: 100, w: 120, h: 40 }, center: { x: 160, y: 120 } },
    { id: 'e2', type: 'input', label: 'E-mail', iconDescription: null, bbox: { x: 100, y: 200, w: 300, h: 40 }, center: { x: 250, y: 220 } },
    { id: 'e3', type: 'link', label: 'Ajuda', iconDescription: null, bbox: { x: 500, y: 300, w: 60, h: 24 }, center: { x: 530, y: 312 } },
  ],
  tasks: [
    { id: 't1', sceneId: 's1', kind: 'action', instruction: 'Clique em Entrar', expect: { action: 'click', targetId: 'e1' } },
  ],
};

const mapCell: VisionMapCell = {
  kind: 'map',
  cellId: 'map:s1',
  sceneId: 's1',
  family: 'bootstrap',
  modelId: 'm1',
  contestantId: 'm1',
  prompt: 'p',
  status: 'ok',
  latencyMs: 1,
  tokensIn: 10,
  tokensOut: 5,
  costUsd: 0.001,
  parseOk: true,
  coordScale: 'pixels',
  predictions: [
    { type: 'button', label: 'Entrar', iconDescription: null, x: 160, y: 120 },
    { type: 'input', label: 'E-mail', iconDescription: null, x: 1000, y: 900 },
  ],
  score: {
    sceneId: 's1',
    elements: 3,
    predicted: 2,
    matched: 1,
    labeled: 1,
    typed: 1,
    precision: 0.5,
    recall: 1 / 3,
    f1: 0.4,
    labelPrecision: 0.5,
    labelRecall: 1 / 3,
    labelF1: 0.4,
    typeAccuracy: 1,
    meanDistancePx: 0,
    matches: [
      { elementId: 'e1', elementType: 'button', predIndex: 0, hit: true, labeled: true, typed: true, distancePx: 0, predictedType: 'button', predictedLabel: 'Entrar' },
      { elementId: 'e2', elementType: 'input', predIndex: -1, hit: false, labeled: false, typed: false, distancePx: -1, predictedType: '', predictedLabel: null },
      { elementId: 'e3', elementType: 'link', predIndex: -1, hit: false, labeled: false, typed: false, distancePx: -1, predictedType: '', predictedLabel: null },
    ],
    unmatchedPredictions: 1,
    missedElements: ['e2', 'e3'],
  },
};

const actionCell: VisionActionCell = {
  kind: 'action',
  cellId: 'action:t1',
  taskId: 't1',
  sceneId: 's1',
  family: 'bootstrap',
  modelId: 'm1',
  contestantId: 'm1',
  instruction: 'Clique em Entrar',
  prompt: 'p',
  status: 'ok',
  latencyMs: 1,
  tokensIn: 10,
  tokensOut: 5,
  costUsd: 0.001,
  parseOk: true,
  coordScale: 'pixels',
  prediction: { action: 'click', rawAction: 'click', target: 'Entrar', x: 160, y: 120, text: null },
  score: { taskId: 't1', sceneId: 's1', expectedAction: 'click', predictedAction: 'click', actionOk: true, targetHit: true, textOk: null, pass: true, distancePx: 0 },
};

function contestant(modelId: string, score: number, mapF1 = 0.4): VisionContestant {
  return {
    contestantId: modelId,
    modelId,
    map: { scenes: 1, elements: 3, predicted: 2, matched: 1, labeled: 1, typed: 1, precision: 0.5, recall: 1 / 3, f1: mapF1, labelF1: 0.4, typeAccuracy: 1, parseFailures: 0, meanPredicted: 2, byFamily: {}, byElementType: {} },
    action: { tasks: 1, passed: 1, passRate: 1, actionAccuracy: 1, targetHitRate: 1, textOkRate: null, parseFailures: 0, byFamily: {}, byAction: {} },
    score,
    calls: 2,
    errors: 0,
    skipped: 0,
    parseFailures: 0,
    costUsd: 0.002,
    tokensIn: 20,
    tokensOut: 10,
    meanLatencyMs: 1,
  };
}

function record(): VisionRunRecord {
  return {
    format: VISION_RUN_FORMAT,
    id: 'vision-x',
    status: 'finished',
    dataset: { version: '0.1.0', hash: 'sha256:' + 'a'.repeat(64), scenes: ['s1'], images: { s1: 'a'.repeat(64) } },
    promptVersion: 'vision-prompt@1',
    config: { models: ['m1', 'm2'], tasks: ['map', 'action'], families: null, scenes: null, limit: null, coordSpace: 'pixels', temperature: 0, maxTokens: 100, retries: 0, budgetUsd: 1 },
    contestants: [contestant('m2', 0.9, 0.2), contestant('m1', 0.9, 0.8)],
    cells: [mapCell, actionCell],
    totals: { calls: 2, errors: 0, skipped: 0, costUsd: 0.002, tokensIn: 20, tokensOut: 10 },
    startedAt: '2026-10-21T00:00:00.000Z',
    finishedAt: '2026-10-21T00:00:10.000Z',
    warnings: [],
  };
}

describe('visão da UI — recorte e overlay', () => {
  it('recorta cenário×modelo e combina mapa + ação', () => {
    const v = sceneModelView(record(), 's1', 'm1');
    expect(v.mapF1).toBeCloseTo(0.4);
    expect(v.actionPass).toBe(1);
    expect(v.combined).toBeCloseTo(0.7);
    expect(v.mapMatched).toBe(1);
    expect(v.mapElements).toBe(3);
    expect(v.counted).toBe(2);
  });

  it('modelo sem célula no cenário não quebra (tudo null)', () => {
    const v = sceneModelView(record(), 's1', 'nao-rodou');
    expect(v.map).toBeNull();
    expect(v.mapF1).toBeNull();
    expect(v.combined).toBeNull();
  });

  it('overlay marca previsão casada, ponto fora e controles não vistos', () => {
    const o = buildOverlay(scene, { map: mapCell, actions: [actionCell] });
    expect(o.predictions).toHaveLength(2);
    expect(o.predictions[0]).toMatchObject({ hit: true, labeled: true });
    expect(o.predictions[1]).toMatchObject({ hit: false });
    expect(o.missed.map((m) => m.id).sort()).toEqual(['e2', 'e3']);
    expect(o.actions[0]).toMatchObject({ pass: true, expectedAction: 'click', targetHit: true });
    expect(o.actions[0]?.target?.label).toBe('Entrar');
  });

  it('matriz respeita a ordem de cenários e modelos', () => {
    const m = sceneModelMatrix(record(), ['s1'], ['m1', 'm2']);
    expect(m).toHaveLength(1);
    expect(m[0]!.map((c) => c.modelId)).toEqual(['m1', 'm2']);
  });

  it('vencedor desempata por mapa F1 e depois por id', () => {
    const r = record();
    expect(winnerOf(r)?.modelId).toBe('m1');
    const empatado = record();
    empatado.contestants = [contestant('b', 0.9, 0.5), contestant('a', 0.9, 0.5)];
    expect(winnerOf(empatado)?.modelId).toBe('a');
  });

  it('faixas e formatação são estáveis', () => {
    expect(scoreBand(0.8)).toBe('forte');
    expect(scoreBand(0.6)).toBe('medio');
    expect(scoreBand(0.2)).toBe('fraco');
    expect(scoreBand(null)).toBeNull();
    expect(fmtPct(0.1234)).toBe('12.3%');
    expect(fmtPct(null)).toBe('—');
    expect(fmtUsd(0)).toBe('$0');
    expect(fmtUsd(0.00012)).toBe('$0.00012');
    expect(elementName({ label: null, iconDescription: 'lupa' })).toBe('lupa');
  });

  it('cenários do record são resolvidos pelo dataset e órfãos são descartados', () => {
    const ds = { scenes: [scene] };
    expect(scenesOfRun(record(), ds).map((s) => s.id)).toEqual(['s1']);
    const sem = { scenes: [] };
    expect(scenesOfRun(record(), sem)).toEqual([]);
  });
});
