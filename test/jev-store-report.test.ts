// Modo JEV — persistência Node (dono/órfã), LGPD (apagar e reter jev-runs/
// jev-sessions) e relatórios (vereditos, custo de USAR só pela entrada,
// payback, Markdown).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDataDir, setDataDir } from '../src/storage.js';
import { eraseRunFiles, pruneExpiredRuns } from '../src/lgpd.js';
import { findJevRecord, listJevRecords, loadJevRun, saveJevRun, saveJevSession } from '../src/jev/store.js';
import {
  computeMetrics,
  renderJevRunReportHtml,
  buildJevRunReport,
  buildJevSessionReport,
  lineDiffCounts,
  renderJevRunReportMarkdown,
  renderJevSessionReportMarkdown,
  sessionVerdict,
  withSpecId,
  type JevCell,
  type JevQuestionSpec,
  type JevRunRecord,
  type JevSessionRecord,
} from '../src/engine/jev/index.js';

let dir = '';
let anterior = '';
beforeAll(() => {
  anterior = getDataDir();
  dir = mkdtempSync(path.join(os.tmpdir(), 'jev-store-'));
  setDataDir(dir);
});
afterAll(() => {
  setDataDir(anterior);
  rmSync(dir, { recursive: true, force: true });
});

const spec = withSpecId({ label: 'o', questions: [{ id: 'b', type: 'noul', instructions: 'É bug?' }] as JevQuestionSpec[] });
const champ = withSpecId({ label: 'c', questions: [{ id: 'b', type: 'noul', instructions: 'O cliente relata defeito?', criteria: { true: { what: 'quebrado', examples: ['x'] }, false: 'pedido' } }] as JevQuestionSpec[] });

function runRecord(id: string, extra: Partial<JevRunRecord> = {}): JevRunRecord {
  return {
    format: 'jev-run@1',
    id,
    mode: 'eval',
    status: 'finished',
    theme: 'tema',
    client: 'node',
    config: { format: 'jev-config@1', mode: 'eval', theme: 'tema', repeats: 1, scoreTolerance: 0.5, bands: { noul: { auto: 0.9, hitl: 0.6 }, choice: { auto: 0.9, hitl: 0.5 }, score: { auto: 0.9, hitl: 0.5 } }, targetPrecision: 0.95, fit: false, primary: 'brierScore', split: { holdoutRatio: 0, calibrationRatio: 0, seed: 1 }, specHash: 'h', datasetHash: 'd' },
    specs: [spec],
    contestants: [{ id: 'd:o@m', label: 'm · o', kind: 'decision', modelId: 'm', specId: spec.id, probabilitySource: 'native', isControl: true }],
    cases: [{ id: 'c1', state: 'Checkout quebrou', expected: { b: true } }],
    questionIds: ['b'],
    cells: [],
    progress: { requestsPlanned: 1, requestsDone: 1, cellsPlanned: 1, cellsDone: 1, spentUsd: 0 },
    metrics: {},
    byQuestion: {},
    byType: {},
    confusion: {},
    incompleteCaseIds: [],
    warnings: [],
    resolvedModels: {},
    cost: { totalUsd: 0, pendingUsd: 0, byRole: {}, byContestant: {}, byKind: { decision: 0, llm: 0, rewriter: 0 } },
    totalCostUsd: 0,
    datasetHash: 'd',
    startedAt: new Date().toISOString(),
    ...extra,
  };
}

describe('store JEV', () => {
  it('grava/lê; run `running` de dono MORTO nesta máquina vira aborted ao carregar', async () => {
    await saveJevRun(runRecord('run-ok'));
    expect((await loadJevRun('run-ok'))?.status).toBe('finished');
    await saveJevRun(runRecord('run-orfa', { status: 'running', owner: { pid: 2_147_000_000, host: os.hostname(), startToken: null } }));
    const r = await loadJevRun('run-orfa');
    expect(r?.status).toBe('aborted');
    expect(r?.stoppedReason).toBe('cancelled');
    // dono VIVO (este processo) não é mexido
    await saveJevRun(runRecord('run-viva', { status: 'running', owner: { pid: process.pid, host: os.hostname(), startToken: null } }));
    expect((await loadJevRun('run-viva'))?.status).toBe('running');
    // id fora do formato nunca toca o disco
    expect(await loadJevRun('../x')).toBeNull();
    const lista = await listJevRecords('run');
    expect(lista.map((x) => x.id).sort()).toEqual(['run-ok', 'run-orfa', 'run-viva']);
    expect((await findJevRecord('run-ok'))?.kind).toBe('run');
  });

  it('LGPD: apagar remove jev-runs/<id>.json e jev-sessions/<id>.json; o TTL vale para eles', async () => {
    await saveJevRun(runRecord('apagar-1'));
    await saveJevSession({ format: 'jev-session@1', id: 'apagar-1' } as unknown as JevSessionRecord);
    const res = await eraseRunFiles(dir, 'apagar-1');
    expect(res.removed.sort()).toEqual(['jev-runs/apagar-1.json', 'jev-sessions/apagar-1.json']);
    expect(existsSync(path.join(dir, 'jev-runs', 'apagar-1.json'))).toBe(false);
    // TTL: record antigo em jev-runs/ é podado junto com as runs
    mkdirSync(path.join(dir, 'jev-runs'), { recursive: true });
    writeFileSync(path.join(dir, 'jev-runs', 'velha.json'), JSON.stringify(runRecord('velha', { startedAt: '2020-01-01T00:00:00.000Z' })));
    const rep = await pruneExpiredRuns({ dataDir: dir, retentionDays: 90 });
    expect(rep.deleted).toContain('velha');
    expect(rep.kept).toContain('run-ok');
    expect(existsSync(path.join(dir, 'jev-runs', 'velha.json'))).toBe(false);
  });
});

describe('relatórios', () => {
  it('lineDiffCounts conta linhas adicionadas/removidas (LCS)', () => {
    expect(lineDiffCounts('a\nb\nc', 'a\nx\nc\nd')).toEqual({ added: 2, removed: 1 });
  });

  it('relatório de run: tabela por competidor e Markdown estável (sem estado de caso)', () => {
    const rec = runRecord('rep-1', {
      metrics: {
        'd:o@m': {
          n: 1, nScored: 1, nInvalid: 0, nNoScore: 0, accuracy: 1, brier: 0.01, brierScore: 99, brierWorstCase: 0.01, logLoss: 0.1, ece: 0.05, eceAdaptive: 0.05, bins: [],
          bands: { auto: 1, hitl: 0, abstain: 0 }, precisionAtAuto: 1, coverageAtAuto: 1, wrongAuto: 0, aurc: 0, auroc: null, flipRate: null,
          latencyP50: 300, latencyP95: 300, coldLatencyMs: null, requests: 1, totalCostUsd: 0.0000168, costPer1kRequests: 0.0168, costPer1kDecisions: 0.0168, costExact: true, unknownCostCalls: 0, pendingUsd: 0,
        },
      },
    });
    const r = buildJevRunReport(rec, new Date('2026-09-29T00:00:00Z'));
    expect(r.format).toBe('prompt-builder-jev-run-report@1');
    expect(r.contestants[0]).toMatchObject({ accuracy: 1, brierScore: 99, costPer1kDecisions: 0.0168 });
    const md = renderJevRunReportMarkdown(r);
    expect(md).toContain('| m · o | 100,0% |');
    expect(md).not.toContain('Checkout quebrou');
    expect(renderJevRunReportMarkdown(buildJevRunReport(rec, new Date('2026-09-29T00:00:00Z')))).toBe(md);
  });

  it('L2: competidor SEM nada pontuado sai "—" no Markdown e no HTML, nunca "0,0%" / ECE 0', () => {
    const vazio = computeMetrics({ items: [], goldOf: () => [], planned: 1, noScore: 1, cells: [], questionsPerCell: 1, repeats: 1 });
    const rec = runRecord('rep-vazio', { status: 'inconclusive', metrics: { 'd:o@m': vazio }, byQuestion: { 'd:o@m': { b: vazio } } });
    const r = buildJevRunReport(rec, new Date('2026-09-29T00:00:00Z'));
    expect(r.contestants[0]).toMatchObject({ accuracy: null, ece: null, coverageAtAuto: null, brierScore: null });
    const md = renderJevRunReportMarkdown(r);
    const linha = md.split('\n').find((l) => l.startsWith('| m · o |'))!;
    expect(linha).toMatch(/^\| m · o \| — \| — \| — \| — \| — \|/);
    expect(md).not.toMatch(/\| 0,0% \|/);
    const linhaQ = md.split('\n').find((l) => l.startsWith('| b | m · o |'))!;
    expect(linhaQ).toContain('| 0 | — | — | — | — |');
    const html = renderJevRunReportHtml(r);
    expect(html).not.toContain('>0,0%<');
    expect(html).not.toContain('>0,000<');
  });

  function sessao(extra: Partial<JevSessionRecord>): JevSessionRecord {
    return {
      format: 'jev-session@1',
      id: 's1',
      status: 'finished',
      theme: 'tema',
      config: runRecord('x').config,
      modelId: 'typesafe/jev-1.13',
      originalSpec: spec,
      championSpec: champ,
      iterations: [],
      runIds: ['h1'],
      policy: {},
      cost: { totalUsd: 0.01, pendingUsd: 0, byRole: { competitor: 0.01 }, byContestant: {}, byKind: { decision: 0.01, llm: 0, rewriter: 0 } },
      totalCostUsd: 0.01,
      resolvedModels: ['typesafe/jev-1.13-20260917'],
      warnings: [],
      startedAt: '2026-09-29T00:00:00Z',
      ...extra,
    };
  }

  it('vereditos: sem-mudanca, melhorou, piorou, inconclusivo, sem-diferenca', () => {
    const cmp = (meanDiffPp: number, pValue: number) => ({ contestantId: 'c', controlId: 'o', metric: 'brierScore' as const, meanDiffPp, ci95Pp: [1, 9] as [number, number], pValue, nEfetivo: 12, accuracyDiffPp: 5, mcnemarP: null, discordant: { better: 3, worse: 0 } });
    const h = (extra: object) => ({ runId: 'h1', n: 12, strength: 'holdout' as const, comparison: cmp(5, 0.01), original: null, champion: null, regressed: false, text: 't', ...extra });
    expect(sessionVerdict(sessao({ championSpec: spec }))).toBe('sem-mudanca');
    expect(sessionVerdict(sessao({ holdout: h({}) }))).toBe('melhorou');
    expect(sessionVerdict(sessao({ holdout: h({ regressed: true }) }))).toBe('piorou');
    expect(sessionVerdict(sessao({ holdout: h({ strength: 'confirmacao-fraca' }) }))).toBe('inconclusivo');
    expect(sessionVerdict(sessao({ holdout: h({ comparison: cmp(1, 0.4) }) }))).toBe('sem-diferenca');
  });

  it('custo de USAR = só tokens de entrada (pareado no holdout); extra por p.p. só quando custa mais E ganha', () => {
    const cel = (ct: string, caseId: string, tokensIn: number): JevCell => ({
      caseId, contestantId: ct, rep: 0, status: 'ok', tokensIn, tokensOut: 22, latencyMs: 300, cost: { usd: tokensIn * 0.042e-6, source: 'usage' }, requests: 1,
    });
    const h1 = runRecord('h1', {
      sessionId: 's1',
      contestants: [
        { id: 'o', label: 'o', kind: 'decision', modelId: 'm', specId: spec.id, probabilitySource: 'native', isControl: true },
        { id: 'c', label: 'c', kind: 'decision', modelId: 'm', specId: champ.id, probabilitySource: 'native' },
      ],
      cells: [cel('o', 'a', 400), cel('o', 'b', 400), cel('c', 'a', 500), cel('c', 'b', 500)],
    });
    const base = { original: null, champion: null };
    const s = sessao({
      holdout: {
        runId: 'h1', n: 12, strength: 'holdout', regressed: false, text: 'ok',
        comparison: { contestantId: 'c', controlId: 'o', metric: 'brierScore', meanDiffPp: 4, ci95Pp: [1, 7], pValue: 0.01, nEfetivo: 12, accuracyDiffPp: 3, mcnemarP: null, discordant: { better: 2, worse: 0 } },
        ...base,
        original: { accuracy: 0.8, brierScore: 80, ece: 0.1, coverageAtAuto: 0.5, precisionAtAuto: 0.9 } as never,
        champion: { accuracy: 0.83, brierScore: 84, ece: 0.05, coverageAtAuto: 0.6, precisionAtAuto: 0.95 } as never,
      },
    });
    const r = buildJevSessionReport(s, [h1], { requestsPerMonth: 1_000_000, now: new Date('2026-09-29T00:00:00Z') });
    expect(r.verdict).toBe('melhorou');
    expect(r.cost.deltaTokensIn).toBe(100);
    expect(r.cost.deltaCostPct).toBeCloseTo(25, 6);
    expect(r.cost.per1kRequests?.deltaUsd).toBeCloseTo(1000 * 100 * 0.042e-6, 12);
    expect(r.cost.paybackRequests).toBeNull();
    expect(r.cost.extraUsdPer1kPerPp).toBeCloseTo((1000 * 100 * 0.042e-6) / 4, 12);
    expect(r.spec.changedQuestions).toEqual(['b']);
    const md = renderJevSessionReportMarkdown(r);
    expect(md).toContain('**Veredito: melhorou.**');
    expect(md).toContain('só tokens de entrada');
    expect(md).toContain('1.000.000 decisões/mês');
  });
});
