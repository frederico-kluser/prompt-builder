// IMPL-052 (R-03b:REC-2) — higiene das amostras do diagnóstico de verbosidade.
//
// Contratos provados aqui (transporte FALSO, zero rede):
//  (i)   resposta VAZIA nunca entra na regressão (contada em `excluidos.vazios`);
//  (ii)  resposta com ≥95% do teto de tokens (ou corte declarado) é MARCADA
//        `suspeito_de_truncamento` e excluída (`excluidos.truncados`);
//  (iii) mistura pointwise+listwise NÃO vira uma regressão só: cada papel tem a
//        própria calibração — a regressão usa SÓ a fonte-alvo (`alvo`), com n
//        por fonte e por célula (fonte × contestant) no relatório;
//  (iv)  veredito IMPUTADO (fonte 'auto') é excluído (`excluidos.imputados`) —
//        nota fabricada pela regra não é observação do juiz;
//  (v)   comprimento em TOKENS com razão candidato/referência; caracteres só
//        como fallback (sem tokenizer no bundle);
//  (vi)  0 amostras inválidas na regressão (assert) nos DOIS runtimes (o
//        relatório sai do módulo puro compartilhado — guarda de sincronia).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway } from '../src/openrouter.js';
import {
  TRUNCATION_SUSPECT_RATE,
  verbosityReport,
  verbositySamples,
  type CalibrationSample,
  type VerbositySampleRow,
} from '../src/engine/judgeCalibration.js';
import type { RunConfig, RunRecord, VerdictSampleSource } from '../src/types.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { canaryOf } from './judgeReplies.js';

// O storage do web é IndexedDB — fora do navegador, um no-op em memória.
vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

const linha = (
  contestantId: string,
  source: VerdictSampleSource,
  score: number,
  extra: Partial<VerbositySampleRow> = {},
): VerbositySampleRow => ({
  contestantId,
  source,
  score,
  text: 'resposta do candidato com algum conteúdo',
  ...extra,
});

describe('IMPL-052 — higiene: o que NÃO entra na regressão', () => {
  it('resposta vazia: fora da regressão e contada como vazia (mesmo com veredito)', () => {
    const rows = [
      linha('a', 'pointwise', 0, { text: '' }),
      linha('a', 'pointwise', 0, { text: '   ' }),
      linha('a', 'pointwise', 1, { text: 'Resposta boa.' }),
      linha('a', 'pointwise', 0.5, { text: 'Resposta média.' }),
    ];
    const rep = verbosityReport(verbositySamples(rows));
    expect(rep.excluidos).toEqual({ vazios: 2, truncados: 0, imputados: 0 });
    expect(rep.n).toBe(2); // só as duas respostas com conteúdo
  });

  it('resposta ≥95% do teto de tokens: MARCADA suspeita_de_truncamento e excluída', () => {
    const teto = 1000;
    const rows = [
      linha('a', 'pointwise', 1, { candidateTokens: Math.floor(TRUNCATION_SUSPECT_RATE * teto), maxTokens: teto }),
      linha('a', 'pointwise', 1, { candidateTokens: 999, maxTokens: teto }),
      linha('b', 'pointwise', 1, { truncated: true, maxTokens: teto }), // corte declarado também marca
      linha('b', 'pointwise', 1, { candidateTokens: 500, maxTokens: teto }),
    ];
    const samples = verbositySamples(rows);
    expect(samples.map((s) => s.suspectTruncation)).toEqual([true, true, true, false]);
    const rep = verbosityReport(samples);
    expect(rep.excluidos).toEqual({ vazios: 0, truncados: 3, imputados: 0 });
    expect(rep.n).toBe(1);
  });

  it('veredito imputado (fonte "auto"): fora da regressão e contado', () => {
    const rows = [
      linha('a', 'imputado', 0, { text: 'Resposta vazia virou nao automatico.' }),
      linha('a', 'pointwise', 1, { text: 'Resposta boa.' }),
    ];
    const rep = verbosityReport(verbositySamples(rows));
    expect(rep.excluidos).toEqual({ vazios: 0, truncados: 0, imputados: 1 });
    expect(rep.n).toBe(1);
    expect(rep.nPorFonte).toEqual({ pointwise: 1 });
  });

  it('0 amostras inválidas na regressão (assert): n = só as válidas da fonte-alvo', () => {
    const rows = [
      linha('a', 'pointwise', 1, { text: '' }), // vazia
      linha('a', 'imputado', 0), // imputada
      linha('a', 'pointwise', 1, { truncated: true }), // truncada
      linha('a', 'pointwise', 1, { text: 'Válida 1.' }),
      linha('b', 'pointwise', 0, { text: 'Válida 2.' }),
    ];
    const rep = verbosityReport(verbositySamples(rows));
    // O relatório não expõe as amostras, mas n/nPorFonte contam SÓ o válido —
    // e a soma das contagens exclui os três motivos acima.
    expect(rep.n).toBe(2);
    expect(rep.nPorFonte).toEqual({ pointwise: 2 });
    expect(rep.excluidos).toEqual({ vazios: 1, truncados: 1, imputados: 1 });
  });
});

describe('IMPL-052 — segregação por papel: nenhum veredito de papel diferente do alvo na regressão', () => {
  it('mistura pointwise+listwise: a regressão é SÓ pointwise (alvo), com n por fonte e por célula', () => {
    // pointwise SEM relação score×comprimento (r ≈ 0); listwise com relação
    // PERFEITA (r = 1). Se o listwise vazasse para a regressão, o r subia.
    const pointwise: VerbositySampleRow[] = Array.from({ length: 12 }, (_, i) =>
      linha(i % 2 ? 'a' : 'b', 'pointwise', [1, 0, 0, 1][i % 4], {
        text: 'x'.repeat((i + 1) * 100),
      }),
    );
    const listwise: VerbositySampleRow[] = Array.from({ length: 6 }, (_, i) =>
      linha('c', 'listwise', (i + 1) / 6, { text: 'y'.repeat((i + 1) * 100) }),
    );
    const rep = verbosityReport(verbositySamples([...pointwise, ...listwise]));
    expect(rep.alvo).toBe('pointwise');
    expect(rep.n).toBe(12);
    expect(rep.r).toBeCloseTo(0, 10); // só o papel-alvo na regressão
    expect(rep.nPorFonte).toEqual({ pointwise: 12, listwise: 6 });
    expect(rep.nPorCelula).toEqual({ 'pointwise×a': 6, 'pointwise×b': 6, 'listwise×c': 6 });
    expect(rep.excluidos).toEqual({ vazios: 0, truncados: 0, imputados: 0 });
  });

  it('run só de listwise: o alvo é o listwise (e o r mede SÓ ele)', () => {
    const listwise: VerbositySampleRow[] = Array.from({ length: 10 }, (_, i) =>
      linha('c', 'listwise', (i + 1) / 10, { text: 'y'.repeat((i + 1) * 100) }),
    );
    const rep = verbosityReport(verbositySamples(listwise));
    expect(rep.alvo).toBe('listwise');
    expect(rep.n).toBe(10);
    expect(rep.r).toBeCloseTo(1, 10);
  });

  it('rótulo (ground-truth) também é papel próprio — nunca entra na regressão do pointwise', () => {
    const rows = [
      linha('a', 'rotulo', 1, { text: 'Rótulo 1.' }),
      linha('a', 'rotulo', 0, { text: 'Rótulo 2.' }),
      ...Array.from({ length: 10 }, (_, i) =>
        linha('b', 'pointwise', (i + 1) / 10, { text: 'x'.repeat((i + 1) * 50) }),
      ),
    ];
    const rep = verbosityReport(verbositySamples(rows));
    expect(rep.alvo).toBe('pointwise');
    expect(rep.n).toBe(10);
    expect(rep.nPorFonte).toEqual({ pointwise: 10, rotulo: 2 });
  });
});

describe('IMPL-052 — comprimento em tokens com razão candidato/referência', () => {
  it('com medição nos dois lados, o comprimento é a RAZÃO de tokens (não chars)', () => {
    const samples = verbositySamples([
      linha('a', 'pointwise', 1, {
        text: 'curto',
        candidateTokens: 300,
        referenceTokens: 100,
        referenceText: 'referência',
      }),
    ]);
    expect(samples[0].length).toBeCloseTo(3, 10); // 300/100 — e não 5/10 de chars
  });

  it('sem medição, fallback em CARACTERES (razão candidato/referência)', () => {
    const samples = verbositySamples([
      linha('a', 'pointwise', 1, {
        text: 'x'.repeat(30),
        referenceText: 'y'.repeat(10),
      }),
    ]);
    expect(samples[0].length).toBeCloseTo(3, 10);
  });

  it('caminho legado (sem source/contestant) continua contando como pointwise', () => {
    const legados: CalibrationSample[] = [
      { score: 1, length: 100 },
      { score: 0, length: 900 },
    ];
    const rep = verbosityReport(legados);
    expect(rep.alvo).toBe('pointwise');
    expect(rep.n).toBe(2);
    expect(rep.nPorCelula).toEqual({});
    expect(rep.excluidos).toEqual({ vazios: 0, truncados: 0, imputados: 0 });
  });
});

// ---------------------------------------------------------------------------
// Integração: o relatório sai com n por célula nos DOIS runtimes (o builder é
// puro e compartilhado; o mapeamento StageRecord → linhas é espelho).
// ---------------------------------------------------------------------------
describe('IMPL-052 — relatório com nPorCelula nos dois runtimes (Node e SPA)', () => {
  let dirAnterior: string;
  let tmp: string;
  let silencio: Array<{ mockRestore(): void }> = [];
  let anterior: ReturnType<typeof setDefaultGateway> | undefined;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl052-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
  });
  afterAll(() => {
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
    if (anterior) setDefaultGateway(anterior);
  });

  const CONFIG = {
    mode: 'compare',
    theme: 'suporte',
    stages: 1,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceModelId: 'fake/ref',
    referenceJudging: true,
    competitorModelIds: ['fake/a', 'fake/b'],
    finalists: 0,
    duels: false,
    timeoutMs: 5_000,
    customStages: [
      {
        question: 'Qual o prazo para trocar um produto?',
        productContext: 'Trocas em até 30 dias.',
        maxTokens: 200,
        reference: 'Trinta dias, com nota fiscal.',
      },
    ],
  } as unknown as RunConfig;

  const juizFake = () =>
    fakeOpenRouter({
      chat: (req) => ({
        text: JSON.stringify({
          canario: canaryOf(req),
          explanation: 'confere com a referência',
          verdict: 'resolve',
          confianca: 'media',
        }),
        finishReason: 'stop',
      }),
    });

  const conferir = (rec: RunRecord): void => {
    const v = rec.judgeDiagnostics!.verbosity;
    expect(v.alvo).toBe('pointwise');
    expect(v.n).toBe(2); // 2 candidatos julgados pelo juiz pointwise
    expect(v.nPorFonte).toEqual({ pointwise: 2 });
    expect(v.nPorCelula).toEqual({ 'pointwise×fake/a': 1, 'pointwise×fake/b': 1 });
    expect(v.excluidos).toEqual({ vazios: 0, truncados: 0, imputados: 0 });
  };

  it('Node (src/orchestrator)', async () => {
    anterior = setDefaultGateway(createGateway({ fetch: juizFake().fetch, sleep: noSleep }));
    const rec = await runNode(CONFIG, KEY, { runId: 'run-impl052-node' });
    conferir(rec);
  });

  it('SPA (web/src/engine/orchestrator) — espelho', async () => {
    anterior = setDefaultGateway(createGateway({ fetch: juizFake().fetch, sleep: noSleep }));
    const rec = (await runWeb(CONFIG as never, KEY, {
      runId: 'run-impl052-web',
    })) as unknown as RunRecord;
    conferir(rec);
  });
});
