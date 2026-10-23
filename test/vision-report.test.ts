// Contrato do RELATÓRIO de visão: os números saem do record, a metodologia
// aparece e o HTML é autocontido (sem rede, com as tabelas do placar).

import { describe, expect, it } from 'vitest';
import {
  renderVisionReportHtml,
  renderVisionReportMarkdown,
  renderVisionSummary,
} from '../src/vision/report.js';
import type { VisionContestant, VisionRunRecord } from '../src/engine/vision/types.js';

function contestant(over: Partial<VisionContestant> = {}): VisionContestant {
  return {
    contestantId: 'm',
    modelId: 'vendor/modelo',
    map: {
      scenes: 2,
      elements: 10,
      predicted: 12,
      matched: 8,
      labeled: 6,
      typed: 8,
      precision: 0.667,
      recall: 0.8,
      f1: 0.727,
      labelF1: 0.545,
      typeAccuracy: 1,
      parseFailures: 0,
      meanPredicted: 6,
      byFamily: { bootstrap: { scenes: 2, f1: 0.727, labelF1: 0.545, recall: 0.8 } },
      byElementType: { button: { elements: 6, matched: 5, recall: 0.833 } },
    },
    action: {
      tasks: 2,
      passed: 1,
      passRate: 0.5,
      actionAccuracy: 0.5,
      targetHitRate: 0.5,
      textOkRate: null,
      parseFailures: 0,
      byFamily: { bootstrap: { tasks: 2, passed: 1, passRate: 0.5 } },
      byAction: { click: { tasks: 2, passed: 1, passRate: 0.5 } },
    },
    score: 0.6135,
    calls: 4,
    errors: 0,
    skipped: 0,
    parseFailures: 0,
    costUsd: 0.0021,
    tokensIn: 7200,
    tokensOut: 800,
    meanLatencyMs: 1200,
    ...over,
  };
}

const record = (): VisionRunRecord => ({
  format: 'vision-run@1',
  id: 'vision-teste',
  status: 'finished',
  dataset: {
    version: '0.1.0',
    hash: `sha256:${'a'.repeat(64)}`,
    scenes: ['bootstrap-login'],
    images: { 'bootstrap-login': 'b'.repeat(64) },
  },
  promptVersion: 'vision-prompt@1',
  config: {
    models: ['vendor/modelo'],
    tasks: ['map', 'action'],
    families: ['bootstrap'],
    scenes: ['bootstrap-login'],
    limit: null,
    coordSpace: 'pixels',
    temperature: 0,
    maxTokens: 4096,
    retries: 0,
    budgetUsd: 1,
  },
  contestants: [contestant()],
  cells: [
    {
      kind: 'map',
      cellId: 'map:bootstrap-login',
      sceneId: 'bootstrap-login',
      family: 'bootstrap',
      modelId: 'vendor/modelo',
      contestantId: 'm',
      prompt: 'pedido',
      status: 'error',
      error: 'HTTP 500',
      latencyMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      parseOk: false,
      coordScale: 'unknown',
      predictions: [],
    },
  ],
  totals: { calls: 4, errors: 1, skipped: 0, costUsd: 0.0021, tokensIn: 7200, tokensOut: 800 },
  budget: { spentUsd: 0.0021, budgetUsd: 1 },
  startedAt: '2026-10-21T12:00:00.000Z',
  finishedAt: '2026-10-21T12:00:30.000Z',
  warnings: [],
});

describe('relatório de visão', () => {
  it('Markdown traz placar, metodologia e a célula com erro', () => {
    const md = renderVisionReportMarkdown(record());
    expect(md).toContain('# Benchmark de visão');
    expect(md).toContain('vendor/modelo');
    expect(md).toContain('72.7%'); // F1
    expect(md).toContain('50.0%'); // action pass
    expect(md).toContain('## Metodologia');
    expect(md).toContain('HTTP 500');
    expect(md).toContain('vision-prompt@1');
    expect(md).toContain('pixels 0–1920/0–1080');
  });

  it('HTML é autocontido e escapa conteúdo (sem <script>, sem http externo)', () => {
    const rec = record();
    rec.contestants[0]!.modelId = 'x/<img src=x onerror=alert(1)>';
    const html = renderVisionReportHtml(rec);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<table>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('&lt;img');
  });

  it('resumo em texto lista os modelos e as notas', () => {
    const txt = renderVisionSummary(record());
    expect(txt).toContain('Benchmark de visão vision-teste');
    expect(txt).toContain('vendor/modelo');
    expect(txt).toContain('mapa F1');
  });
});
