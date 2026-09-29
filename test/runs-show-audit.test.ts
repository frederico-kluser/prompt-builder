// left#10 (IMPL-057/IMPL-112) e left#4 (IMPL-063/IMPL-115), onda 3 — o que o
// record já sabia e o `runs show`/`runs export` escondiam:
//   - a FILA de revisão humana do gabarito (itens saturados 100%/0%) item a
//     item, não só a contagem; e no --json/export, explícita;
//   - a linha de auditoria do contrato do juiz, explícita no payload e no
//     bloco `audit` do artefato (o record inteiro já ia, mas enterrado);
//   - o relatório da geração (`datagenReport`) e o do modo econômico
//     (`judgeCascade`: fração escalonada, gatilhos, forte que falhou).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdRuns } from '../src/cli/commands/misc.js';
import { resetOutputState } from '../src/cli/output.js';
import { getDataDir, saveRun, setDataDir } from '../src/storage.js';
import { buildRunArtifact, runArtifactAudit } from '../src/runArtifact.js';
import type { RunRecord } from '../src/types.js';

function registro(extra: Record<string, unknown> = {}): RunRecord {
  const stages = [0, 1].map((i) => ({
    index: i,
    spec: { question: `cenario ${i}: posso trocar depois de 40 dias?`, productContext: 'ctx', maxTokens: 100, reference: 'ref' },
    responses: [],
    referenceJudge: { verdictByContestant: { a: 'resolve', b: 'resolve' }, explanationByContestant: {}, judgeModelId: 'fake/judge' },
    startedAt: '2026-09-27T00:00:00.000Z',
  }));
  return {
    id: `run-${Math.random().toString(36).slice(2, 10)}`,
    status: 'finished',
    config: { mode: 'compare', theme: 'trocas', stages: 2, datagenModelId: 'fake/gen', judgeModelIds: ['fake/judge'] },
    mode: 'compare',
    contestants: [
      { id: 'a', label: 'A', modelId: 'fake/a' },
      { id: 'b', label: 'B', modelId: 'fake/b' },
    ],
    stages,
    scoreboard: {},
    totalCostUsd: 0,
    startedAt: '2026-09-27T00:00:00.000Z',
    ...extra,
  } as unknown as RunRecord;
}

const FILA = [
  {
    itemKey: 'sha256:aaa',
    question: 'cenario 0: posso trocar depois de 40 dias?',
    stageIndexes: [0],
    executions: 6,
    resolve: 6,
    parcial: 0,
    nao: 0,
    hitRate: 1,
    byContestant: [],
    saturated: 'all-resolve',
    needsReview: true,
    needsReviewReason: "100% 'resolve'",
  },
  {
    itemKey: 'sha256:bbb',
    question: 'cenario 1: posso trocar depois de 40 dias?',
    stageIndexes: [1],
    executions: 6,
    resolve: 0,
    parcial: 0,
    nao: 6,
    hitRate: 0,
    byContestant: [],
    saturated: 'all-nao',
    needsReview: true,
    needsReviewReason: "100% 'nao'",
  },
];

const EXTRAS = {
  itemSaturation: { minExecutions: 5, items: FILA, reviewQueue: FILA, needsReviewCount: 2 },
  judgeDiagnostics: {
    contract: { hash: 'f'.repeat(64), modelIds: ['fake/judge'], pinnedAt: '2026-09-27T00:00:00.000Z' },
    contractAudit: {
      changed: true,
      previousHash: 'e'.repeat(64),
      line: 'juiz: fake/judge (contrato mudou — scores não comparáveis com a última run)',
      detail: `juiz: fake/judge (contrato mudou — scores não comparáveis com a última run) · contrato ${'f'.repeat(12)}`,
    },
    verbosity: { n: 0, r: 0, biased: false, warning: '' },
  },
  datagenReport: {
    requested: 6,
    seed: 0,
    batches: 2,
    failedCalls: 0,
    generated: 9,
    backfillRounds: 1,
    maxBackfillRounds: 3,
    backfilled: 3,
    dedupedExact: 2,
    dedupedSemantic: 3,
    droppedVsSeed: 0,
    templateEcho: 1,
    final: 4,
    shortfall: 2,
    rate: 5 / 9,
    alert: true,
    semantic: true,
    embedModelId: 'fake/embed',
    cosineThreshold: 0.9,
    effectiveCosineThreshold: 0.93,
    echoThreshold: 0.85,
    stoppedBy: 'rounds',
    rubricUnanswerable: 0,
    warning: 'Datagen entregou 4 de 6 cenários (5 quase-duplicata(s) descartada(s)).',
  },
  judgeCascade: {
    cheapJudgeIds: ['fake/barato-1', 'fake/barato-2'],
    strongJudgeId: 'fake/forte',
    stages: 2,
    escalatedStages: 1,
    verdicts: 4,
    escalatedVerdicts: 1,
    escalatedFraction: 0.25,
    strongFailedStages: 1,
    reasons: { disagreement: 1, parcial: 0, 'length-anomaly': 0 },
  },
};

let dir = '';
let anterior = '';
let homeAnterior: string | undefined;
const cli = (argv: string[]): string[] => [...argv, '--data-dir', dir];

beforeAll(() => {
  anterior = getDataDir();
  homeAnterior = process.env.PROMPT_BUILDER_HOME;
  dir = mkdtempSync(join(tmpdir(), 'pb-show-audit-'));
  process.env.PROMPT_BUILDER_HOME = dir;
  setDataDir(dir);
});
afterAll(() => {
  if (homeAnterior === undefined) delete process.env.PROMPT_BUILDER_HOME;
  else process.env.PROMPT_BUILDER_HOME = homeAnterior;
  setDataDir(anterior);
  rmSync(dir, { recursive: true, force: true });
});

async function capturar(fn: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  resetOutputState();
  const out: string[] = [];
  const err: string[] = [];
  const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    out.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
    return true;
  });
  const se = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
    err.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
    return true;
  });
  try {
    const code = await fn();
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    so.mockRestore();
    se.mockRestore();
    resetOutputState();
  }
}

describe('runs show — fila de revisão, contrato do juiz, datagen e modo econômico', () => {
  it('texto: a fila de revisão sai ITEM A ITEM (não só a contagem) e a linha do contrato', async () => {
    const r = registro(EXTRAS);
    await saveRun(r);
    const { code, stdout } = await capturar(() => cmdRuns(cli(['show', r.id, '--output-format', 'text'])));
    expect(code).toBe(0);
    expect(stdout).toContain("! saturação: 2 item(ns) com 100% 'resolve' ou 100% 'nao'");
    expect(stdout).toMatch(/100% 'resolve'\s+6 exec · etapa\(s\) 0 — cenario 0: posso trocar/);
    expect(stdout).toMatch(/100% 'nao'\s+6 exec · etapa\(s\) 1 — cenario 1/);
    expect(stdout).toContain('! juiz: fake/judge (contrato mudou — scores não comparáveis com a última run)');
  });

  it('texto: relatório da geração (descartes, reposição, embeddings) e do modo econômico', async () => {
    const r = registro(EXTRAS);
    await saveRun(r);
    const { stdout } = await capturar(() => cmdRuns(cli(['show', r.id, '--output-format', 'text'])));
    expect(stdout).toContain('datagen: 4/6 cenário(s) gerado(s) entregue(s) · descartes: 2 exato(s) + 3 semântico(s)');
    expect(stdout).toContain('1/3 reposição(ões) · embeddings fake/embed (cosseno 0.93)');
    expect(stdout).toContain('! Datagen entregou 4 de 6 cenários');
    expect(stdout).toContain(
      'modo econômico: 1/4 veredito(s) ao juiz forte (25%) em 1/2 etapa(s) · baratos fake/barato-1 + fake/barato-2 → forte fake/forte · gatilhos: disagreement=1',
    );
    expect(stdout).toContain('! o juiz forte falhou em 1 etapa(s)');
  });

  it('--json: os quatro blocos EXPLÍCITOS no payload (null/[] quando a run não os tem)', async () => {
    const r = registro(EXTRAS);
    await saveRun(r);
    const { stdout } = await capturar(() => cmdRuns(cli(['show', r.id, '--json'])));
    const data = (JSON.parse(stdout) as { data: Record<string, unknown> }).data;
    expect(data.itemReviewQueue).toEqual(FILA);
    expect(data.judgeContractAudit).toMatchObject({ changed: true, line: EXTRAS.judgeDiagnostics.contractAudit.line });
    expect(data.datagenReport).toMatchObject({ final: 4, shortfall: 2 });
    expect(data.judgeCascade).toMatchObject({ escalatedFraction: 0.25 });

    const vazio = registro();
    await saveRun(vazio);
    const v = (JSON.parse((await capturar(() => cmdRuns(cli(['show', vazio.id, '--json'])))).stdout) as {
      data: Record<string, unknown>;
    }).data;
    expect(v).toMatchObject({ itemReviewQueue: [], needsHumanReview: [], judgeContractAudit: null, datagenReport: null, judgeCascade: null });
  });
});

describe('runs export — bloco `audit` explícito no artefato', () => {
  it('artefato: contrato do juiz (linha + detalhe com 12 chars) e as filas de revisão humana', () => {
    const art = buildRunArtifact(registro(EXTRAS), '2026-09-29T00:00:00.000Z');
    expect(art.audit.judgeContract).toEqual({
      hash: 'f'.repeat(64),
      modelIds: ['fake/judge'],
      changed: true,
      line: EXTRAS.judgeDiagnostics.contractAudit.line,
      detail: EXTRAS.judgeDiagnostics.contractAudit.detail,
      previousHash: 'e'.repeat(64),
    });
    expect(art.audit.itemReviewQueue).toEqual(FILA);
    expect(art.audit.needsHumanReview).toEqual([]);
    // Run sem diagnóstico (listwise/antiga): null, nunca inventado.
    expect(runArtifactAudit(registro()).judgeContract).toBeNull();
    // Record ANTERIOR à auditoria entre runs: hash sim, comparação não.
    const antigo = registro({ judgeDiagnostics: { ...EXTRAS.judgeDiagnostics, contractAudit: undefined } });
    expect(runArtifactAudit(antigo).judgeContract).toMatchObject({ changed: null, line: null, hash: 'f'.repeat(64) });
  });

  it('CLI: `runs export -o` grava o artefato COM o audit e narra a auditoria no stderr', async () => {
    const r = registro(EXTRAS);
    await saveRun(r);
    const alvo = join(dir, 'export.json');
    const { code, stderr } = await capturar(() => cmdRuns(cli(['export', r.id, '-o', alvo])));
    expect(code).toBe(0);
    const gravado = JSON.parse(readFileSync(alvo, 'utf-8')) as { audit: { itemReviewQueue: unknown[]; judgeContract: { line: string } } };
    expect(gravado.audit.itemReviewQueue).toHaveLength(2);
    expect(gravado.audit.judgeContract.line).toContain('contrato mudou');
    expect(stderr).toContain('revisão humana do gabarito: 2 item(ns) saturado(s) + 0 na fila needs-human-review');
  });
});
