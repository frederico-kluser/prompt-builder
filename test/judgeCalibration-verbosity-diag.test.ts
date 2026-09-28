// IMPL-053 (R-03b:REC-1) — diagnóstico de verbosidade em CAMADAS no lugar do
// Pearson agregado. Contratos provados aqui (transporte FALSO, zero rede):
//  (i)   vereditos sintéticos com efeito de comprimento CONHECIDO ⇒
//        `betaLenRel > 0` com `pPermutacao < 0.05` (efeito + incerteza + n);
//  (ii)  sem efeito real, o teste de permutação NÃO acusa (guarda anti-teatro);
//  (iii) sondas contrafactuais: `taxaInversaoSondas` reportada (limiar bom
//        < 10%), com falhas de re-julgamento FORA do denominador;
//  (iv)  o Pearson vira legenda descritiva — nunca mais "viés detectado";
//  (v)   a RUN emite `verbosityDiag` com todos os campos, nos DOIS runtimes
//        (record + espelho web em par).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway } from '../src/openrouter.js';
import {
  buildCounterfactualText,
  probeInversionRate,
  runCounterfactualProbes,
  selectCounterfactualProbes,
  verbosityDiag,
  verbosityReport,
  verbositySamples,
  verdictOfScore,
  type CounterfactualProbePair,
  type VerbositySampleRow,
} from '../src/engine/judgeCalibration.js';
import type { RunConfig, RunRecord } from '../src/types.js';
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

/**
 * Linha sintética de veredito pointwise: comprimento em TOKENS medidos (a
 * referência é fixa ⇒ a razão candidato/referência varia só com o candidato).
 */
const linha = (
  contestantId: string,
  scenarioId: string,
  candidateTokens: number,
  score: number,
): VerbositySampleRow => ({
  contestantId,
  scenarioId,
  source: 'pointwise',
  score,
  text: `resposta ${'w'.repeat(Math.max(8, Math.round(candidateTokens / 2)))}`,
  candidateTokens,
  referenceText: 'referência de tamanho fixo para a razão de comprimento relativo.',
  referenceTokens: 200,
});

describe('IMPL-053 — regressão ordinal: efeito do comprimento conhecido detecta-se', () => {
  // 12 vereditos sintéticos: score MONÓTONO (com ruído) em função do comprimento
  // — o efeito verdadeiro é positivo e forte. Distribuídos por 3 cenários × 2
  // contestants (efeitos fixos dos dois controlados), cada grupo com respostas
  // curtas E compridas (o efeito identifica-se DENTRO do grupo, como manda o
  // desenho: FE(cenário) controla o confundidor de dificuldade).
  const pares: Array<[number, number]> = [
    [90, 0], [120, 0], [160, 0.5], [200, 0], [240, 0.5], [280, 0.5],
    [330, 0.5], [380, 1], [420, 1], [470, 0.5], [510, 1], [560, 1],
  ];
  const rowsEfeito = pares.map(([tokens, score], i) =>
    linha(`c${Math.floor(i / 6)}`, `s${i % 3}`, tokens, score),
  );

  it('betaLenRel > 0 (p < 0.05) com efeito de comprimento conhecido', () => {
    const samples = verbositySamples(rowsEfeito);
    const diag = verbosityDiag(samples, { permutations: 200, bootstrap: 100 });
    expect(diag).not.toBeNull();
    expect(diag!.betaLenRel).toBeGreaterThan(0);
    expect(diag!.pPermutacao).toBeLessThan(0.05);
    // Nunca número sozinho: efeito + incerteza + n.
    expect(diag!.ic95[0]).toBeLessThanOrEqual(diag!.ic95[1]);
    expect(diag!.nPorFonte).toEqual({ pointwise: 12 });
    // judgeScoreLC AUXILIAR sai por contestant (0–100).
    expect(Object.keys(diag!.judgeScoreLC ?? {}).sort()).toEqual(['c0', 'c1']);
  });

  it('sem efeito real, a permutação NÃO acusa viés (guarda anti-teatro)', () => {
    // Mesmos comprimentos, scores embaralhados INDEPENDENTES deles.
    const scores = [1, 0, 0.5, 1, 0, 0.5, 1, 0.5, 0, 1, 0.5, 0];
    const rowsRuido = rowsEfeito.map((r, i) => ({ ...r, score: scores[i] }));
    const diag = verbosityDiag(verbositySamples(rowsRuido), { permutations: 200, bootstrap: 50 });
    expect(diag).not.toBeNull();
    expect(diag!.pPermutacao).toBeGreaterThan(0.05);
  });

  it('n insuficiente ou comprimento constante ⇒ null (efeito sem amostra seria inventado)', () => {
    const poucos = rowsEfeito.slice(0, 4);
    expect(verbosityDiag(verbositySamples(poucos))).toBeNull();
    const mesmoTamanho = rowsEfeito.map((r) => ({ ...r, candidateTokens: 200 }));
    expect(verbosityDiag(verbositySamples(mesmoTamanho))).toBeNull();
    // Níveis de veredito únicos também não sustentam o modelo ordinal.
    const umNivel = rowsEfeito.map((r) => ({ ...r, score: 1 }));
    expect(verbosityDiag(verbositySamples(umNivel))).toBeNull();
  });

  it('judgeScoreLC é AUXILIAR: o judge-score bruto continua sendo o primário', () => {
    const diag = verbosityDiag(verbositySamples(rowsEfeito))!;
    for (const nota of Object.values(diag.judgeScoreLC!)) {
      expect(nota).toBeGreaterThanOrEqual(0);
      expect(nota).toBeLessThanOrEqual(100);
    }
  });
});

describe('IMPL-053 — sondas contrafactuais: taxa de inversão reportada', () => {
  const par = (verdict: 'resolve' | 'parcial' | 'nao', probe: 'resolve' | 'parcial' | 'nao' | null): CounterfactualProbePair => ({
    contestantId: 'c1',
    mode: 'truncar',
    originalVerdict: verdict,
    probeVerdict: probe,
  });

  it('taxa = inversões / sondas AVALIADAS; falha de re-julgamento sai do denominador', () => {
    const pares = [
      ...Array.from({ length: 19 }, () => par('resolve', 'resolve')),
      par('resolve', 'nao'), // a ÚNICA inversão
      par('resolve', null), // re-julgamento falhou — fora da taxa
      par('nao', null),
    ];
    const taxa = probeInversionRate(pares);
    expect(taxa).toBe(0.05); // 1 de 20 avaliadas
    expect(taxa!).toBeLessThan(0.1); // limiar bom
    expect(probeInversionRate([])).toBeNull();
  });

  it('manipulação de comprimento: truncar tira 20% da cauda; preencher cresce 20% com reticências', () => {
    const texto = 'a'.repeat(100);
    expect(buildCounterfactualText(texto, 'truncar')).toHaveLength(80);
    const cheio = buildCounterfactualText(texto, 'preencher');
    expect(cheio.length).toBeGreaterThan(texto.length);
    expect(cheio.endsWith('…')).toBe(true);
  });

  it('runCounterfactualProbes re-julga com o juiz INJETADO e o diag reporta taxaInversaoSondas', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      linha(`c${i % 2}`, `s${i % 3}`, 200 + i * 30, i % 3 === 0 ? 0 : i % 3 === 1 ? 0.5 : 1),
    );
    const alvos = selectCounterfactualProbes(rows, 0.2, 7);
    expect(alvos.length).toBeGreaterThanOrEqual(1);
    const pares = await runCounterfactualProbes({
      rows,
      rate: 0.2,
      seed: 7,
      // O re-julgamento devolve SEMPRE 'resolve': inverte só quem não era.
      rejudge: async () => 'resolve',
    });
    expect(pares.length).toBe(alvos.length);
    const taxa = probeInversionRate(pares);
    expect(taxa).not.toBeNull();
    const diag = verbosityDiag(verbositySamples(rows), { probes: pares });
    expect(diag!.taxaInversaoSondas).toBe(taxa);
    // Sem sondas rodadas, o campo existe e é null — nunca inventado.
    expect(verbosityDiag(verbositySamples(rows))!.taxaInversaoSondas).toBeNull();
    expect(verdictOfScore(1)).toBe('resolve');
    expect(verdictOfScore(0.5)).toBe('parcial');
    expect(verdictOfScore(0)).toBe('nao');
  });
});

describe('IMPL-053 — o Pearson vira legenda descritiva (nunca "viés detectado")', () => {
  it('mesmo com |r| alto, o warning é legenda e aponta o verbosityDiag', () => {
    const pares: Array<[number, number]> = [
      [90, 0], [110, 0], [150, 0], [200, 0.5], [240, 0.5], [280, 0.5],
      [330, 0.5], [380, 1], [420, 1], [470, 1], [510, 1], [560, 1],
    ];
    const rows = pares.map(([tokens, score], i) => linha(`c${i % 2}`, `s${i % 3}`, tokens, score));
    const rep = verbosityReport(verbositySamples(rows));
    expect(rep.biased).toBe(true); // a legenda APARECE…
    expect(rep.warning).not.toMatch(/viés detectado/i); // …mas nunca acusa
    expect(rep.warning).toContain('legenda descritiva');
    expect(rep.warning).toMatch(/NÃO é diagnóstico de viés/);
    expect(rep.warning).toContain('verbosityDiag');
    // O diagnóstico de verdade sai junto: efeito + incerteza + n.
    expect(rep.verbosityDiag).toBeDefined();
    expect(rep.verbosityDiag!.betaLenRel).toBeGreaterThan(0);
    expect(rep.verbosityDiag!.pPermutacao).toBeLessThan(0.05);
  });
});

describe('IMPL-053 — a run emite verbosityDiag com todos os campos (Node + SPA)', () => {
  let dirAnterior: string;
  let tmp: string;
  let silencio: Array<{ mockRestore(): void }> = [];
  let anterior: ReturnType<typeof setDefaultGateway> | undefined;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl053-'));
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

  // 12 cenários × 2 candidatos = 24 amostras; a pergunta CARREGA o tamanho da
  // resposta esperada (`LEN=`), o competidor devolve texto desse tamanho e o
  // juiz falso decide por ele — efeito de comprimento conhecido de ponta a ponta.
  const LENS = [100, 160, 220, 280, 330, 380, 430, 480, 530, 580, 630, 690];
  const customStages = LENS.map((len, i) => ({
    question: `Pergunta ${i} LEN=${len}`,
    productContext: 'Produto de teste.',
    maxTokens: 1200,
    reference: `Resposta ideal do cenário ${i} com tamanho estável.`,
  }));

  const CONFIG = {
    mode: 'compare',
    theme: 'verbosidade',
    stages: LENS.length,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceModelId: 'fake/ref',
    referenceJudging: true,
    competitorModelIds: ['fake/a', 'fake/b'],
    finalists: 0,
    duels: false,
    timeoutMs: 5_000,
    customStages,
  } as unknown as RunConfig;

  const gatewayFake = () =>
    fakeOpenRouter({
      chat: (req) => {
        if (req.model === 'fake/judge') {
          const len = Number(/LEN=(\d+)/.exec(req.user)?.[1] ?? '0');
          const verdict = len >= 430 ? 'resolve' : len >= 280 ? 'parcial' : 'nao';
          return {
            text: JSON.stringify({
              canario: canaryOf(req),
              explanation: `resposta ${verdict} (efeito de tamanho)`,
              verdict,
              confianca: 'media',
            }),
            finishReason: 'stop',
          };
        }
        const len = Number(/LEN=(\d+)/.exec(req.user)?.[1] ?? '100');
        return {
          text: `LEN=${len} ${'w'.repeat(len)}`,
          usage: { completion_tokens: len, cost: 0.0001 },
          finishReason: 'stop',
        };
      },
    });

  const conferir = (rec: RunRecord): void => {
    expect({ status: rec.status, error: rec.error, etapas: rec.stages.length }).toEqual({
      status: 'finished',
      error: undefined,
      etapas: LENS.length,
    });
    const v = rec.judgeDiagnostics!.verbosity;
    const diag = v.verbosityDiag!;
    expect(diag).toBeDefined();
    // TODOS os campos do VerbosityDiag publicados (critério IMPL-053).
    for (const campo of ['betaLenRel', 'ic95', 'pPermutacao', 'nPorFonte', 'taxaInversaoSondas', 'judgeScoreLC']) {
      expect(diag, `campo ${campo} ausente`).toHaveProperty(campo);
    }
    expect(diag.nPorFonte).toEqual({ pointwise: 24 });
    expect(Array.isArray(diag.ic95)).toBe(true);
    // As sondas não rodam dentro da run (quem chama passa os pares) ⇒ null
    // honesto, nunca taxa fabricada.
    expect(diag.taxaInversaoSondas).toBeNull();
    expect(Object.keys(diag.judgeScoreLC ?? {}).sort()).toEqual(['fake/a', 'fake/b']);
  };

  it('Node (src/orchestrator)', async () => {
    anterior = setDefaultGateway(createGateway({ fetch: gatewayFake().fetch, sleep: noSleep }));
    const rec = await runNode(CONFIG, KEY, { runId: 'run-impl053-node' });
    conferir(rec);
  });

  it('SPA (web/src/engine/orchestrator) — espelho web em par', async () => {
    anterior = setDefaultGateway(createGateway({ fetch: gatewayFake().fetch, sleep: noSleep }));
    const rec = (await runWeb(CONFIG as never, KEY, {
      runId: 'run-impl053-web',
    })) as unknown as RunRecord;
    conferir(rec);
  });
});