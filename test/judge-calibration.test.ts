// Testes de CONTRATO de `judgeCalibration` — calibração do juiz.
//
// Travam a semântica que os dois motores (src/ e web/src/engine/) vão
// compartilhar byte a byte: correlação de verbosidade, pin do contrato do juiz
// (calibration drift), orientação de amostra pequena e o IC 95% da média. Tudo
// determinístico — um golden que mudar é decisão deliberada, não refactor
// "de leve".

import { describe, expect, it } from 'vitest';
import {
  judgeContractHash,
  meanCi95,
  pearsonCorrelation,
  pinJudgeContract,
  sampleSizeWarning,
  verbosityReport,
  type CalibrationSample,
} from '../src/engine/judgeCalibration.js';

const sample = (length: number, score: number): CalibrationSample => ({ score, length });

/**
 * Padrão SEM relação score×comprimento: [1,0,0,1] repetido contra comprimento
 * aritmético cancela a covariância exatamente (r = 0), útil para testar o
 * limiar de viés sem depender de aproximação estatística.
 */
const semRelacao = (n: number): CalibrationSample[] =>
  Array.from({ length: n }, (_, i) => sample((i + 1) * 100, [1, 0, 0, 1][i % 4]));

describe('pearsonCorrelation — score × comprimento', () => {
  it('correlação perfeita positiva ⇒ r = 1', () => {
    const samples = [1, 2, 3, 4, 5].map((i) => sample(i * 100, i / 5));
    expect(pearsonCorrelation(samples)).toBeCloseTo(1, 10);
  });

  it('correlação perfeita negativa ⇒ r = −1', () => {
    const samples = [1, 2, 3, 4, 5].map((i) => sample(i * 100, 1 - i / 5));
    expect(pearsonCorrelation(samples)).toBeCloseTo(-1, 10);
  });

  it('padrão sem relação ⇒ r ≈ 0 (covariância cancela)', () => {
    expect(pearsonCorrelation(semRelacao(8))).toBeCloseTo(0, 10);
  });

  it('variância zero em qualquer eixo ⇒ 0 (correlação indefinida não vira NaN)', () => {
    // Comprimento constante…
    expect(pearsonCorrelation([sample(500, 0.1), sample(500, 0.9), sample(500, 0.5)])).toBe(0);
    // …e score constante (o clássico "todo mundo empatado não prova nada").
    expect(pearsonCorrelation([sample(100, 0.5), sample(900, 0.5), sample(5000, 0.5)])).toBe(0);
  });

  it('n < 2 ⇒ 0 (um par só não tem covariância)', () => {
    expect(pearsonCorrelation([])).toBe(0);
    expect(pearsonCorrelation([sample(100, 0.9)])).toBe(0);
  });
});

describe('verbosityReport — viés de verbosidade', () => {
  // 12 respostas com score crescendo (com ruído) junto do comprimento: r alto,
  // mas não perfeito — como numa medição real de juiz verbosidade-inclinado.
  const enviesadas: CalibrationSample[] = [
    sample(100, 0.1),
    sample(150, 0.3),
    sample(200, 0.2),
    sample(250, 0.45),
    sample(300, 0.35),
    sample(350, 0.6),
    sample(400, 0.5),
    sample(450, 0.75),
    sample(500, 0.65),
    sample(550, 0.9),
    sample(600, 0.8),
    sample(650, 0.95),
  ];

  it('n ≥ 10 e |r| ≥ 0.3 ⇒ biased, com aviso PT-BR citando r e n', () => {
    const report = verbosityReport(enviesadas);
    expect(report.n).toBe(12);
    expect(report.r).toBeGreaterThan(0.3);
    expect(report.biased).toBe(true);
    expect(report.warning).not.toBe('');
    expect(report.warning).toContain('verbosidade');
    expect(report.warning).toContain('n=12');
  });

  it('viés negativo também conta (o limiar é |r|)', () => {
    const inversas = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) =>
      sample(i * 100, 1 - i / 12),
    );
    const report = verbosityReport(inversas);
    expect(report.r).toBeCloseTo(-1, 10);
    expect(report.biased).toBe(true);
  });

  it('r baixo com n ≥ 10 ⇒ sem viés e warning vazio', () => {
    const report = verbosityReport(semRelacao(12));
    expect(report.r).toBeCloseTo(0, 10);
    expect(report.biased).toBe(false);
    expect(report.warning).toBe('');
  });

  it('|r| alto mas n < 10 ⇒ não declara viés (amostra não sustenta acusação)', () => {
    const report = verbosityReport([1, 2, 3, 4, 5].map((i) => sample(i * 100, i / 5)));
    expect(report.n).toBe(5);
    expect(report.r).toBeCloseTo(1, 10);
    expect(report.biased).toBe(false);
    expect(report.warning).toBe('');
  });
});

describe('judgeContractHash — pin do contrato (calibration drift)', () => {
  const modelos = ['anthropic/claude-x', 'openai/gpt-y'];
  const rubrica = 'Você é um juiz. Vereditos: resolve/parcial/nao.';

  it('é determinístico: mesma entrada ⇒ mesmo hash, 32 chars hex', () => {
    const a = judgeContractHash(modelos, rubrica);
    const b = judgeContractHash(modelos, rubrica);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('modelo mudou ⇒ hash muda (troca de juiz é drift e precisa aparecer)', () => {
    expect(judgeContractHash(modelos, rubrica)).not.toBe(
      judgeContractHash(['anthropic/claude-x', 'openai/gpt-z'], rubrica),
    );
  });

  it('rúbrica mudou ⇒ hash muda (mesmo que seja um caractere)', () => {
    expect(judgeContractHash(modelos, rubrica)).not.toBe(
      judgeContractHash(modelos, `${rubrica} `),
    );
  });

  it('a ordem de cadastro dos modelos não muda o contrato (ids são um conjunto)', () => {
    expect(judgeContractHash(['b-model', 'a-model'], rubrica)).toBe(
      judgeContractHash(['a-model', 'b-model'], rubrica),
    );
  });

  it('framing por comprimento: ["ab","c"] ≠ ["a","bc"]', () => {
    expect(judgeContractHash(['ab', 'c'], 'x')).not.toBe(judgeContractHash(['a', 'bc'], 'x'));
  });
});

describe('pinJudgeContract — registro no record da run', () => {
  it('grava pinnedAt em ISO usando o relógio injetado, e o hash do contrato', () => {
    const agora = new Date('2026-07-30T12:34:56.789Z');
    const pin = pinJudgeContract(['openai/gpt-y'], 'rubrica', agora);
    expect(pin.pinnedAt).toBe('2026-07-30T12:34:56.789Z');
    expect(new Date(pin.pinnedAt).toISOString()).toBe(pin.pinnedAt); // ISO de verdade
    expect(pin.hash).toBe(judgeContractHash(['openai/gpt-y'], 'rubrica'));
    expect(pin.modelIds).toEqual(['openai/gpt-y']);
  });

  it('sem relógio injetado usa o agora (e não pode mutar o array de entrada)', () => {
    const modelos = ['openai/gpt-y'];
    const pin = pinJudgeContract(modelos, 'rubrica');
    expect(Math.abs(Date.now() - new Date(pin.pinnedAt).getTime())).toBeLessThan(5000);
    expect(pin.modelIds).toEqual(modelos);
    expect(pin.modelIds).not.toBe(modelos);
  });
});

describe('sampleSizeWarning — orientação de amostra (plano: avisar n<10)', () => {
  it('n = 3 avisa citando o label', () => {
    const aviso = sampleSizeWarning(3, 'variante A');
    expect(aviso).not.toBe('');
    expect(aviso).toContain('variante A');
    expect(aviso).toContain('n=3');
  });

  it('n = 10 silencioso', () => {
    expect(sampleSizeWarning(10, 'variante A')).toBe('');
  });

  it('label é opcional; n = 9 ainda avisa (o piso é estrito)', () => {
    const aviso = sampleSizeWarning(9);
    expect(aviso).not.toBe('');
    expect(aviso).toContain('n=9');
  });
});

describe('meanCi95 — IC 95% da média por bootstrap (seed 1337)', () => {
  it('n < 5 ⇒ null (mesmo piso do resto do projeto)', () => {
    expect(meanCi95([])).toBeNull();
    expect(meanCi95([0.2, 0.4, 0.6, 0.8])).toBeNull();
    expect(meanCi95([0.2, 0.4, 0.6, 0.8, 1.0])).not.toBeNull();
  });

  it('média correta e na unidade dos scores (sem ×100)', () => {
    const res = meanCi95([0.2, 0.4, 0.6, 0.8, 1.0]);
    if (!res) throw new Error('meanCi95 não devolve null com n=5');
    expect(res.mean).toBeCloseTo(0.6, 10);
    expect(res.n).toBe(5);
  });

  it('IC ordenado e contém a média', () => {
    const res = meanCi95([0.1, 0.4, 0.5, 0.5, 0.6, 0.7, 0.9, 1.0]);
    if (!res) throw new Error('meanCi95 não devolve null com n=8');
    expect(res.ci95[0]).toBeLessThanOrEqual(res.ci95[1]);
    expect(res.ci95[0]).toBeLessThanOrEqual(res.mean);
    expect(res.ci95[1]).toBeGreaterThanOrEqual(res.mean);
  });

  it('é determinístico: duas chamadas idênticas devolvem o mesmo intervalo', () => {
    const scores = [0.1, 0.4, 0.5, 0.5, 0.6, 0.7, 0.9, 1.0];
    expect(meanCi95(scores)).toEqual(meanCi95(scores));
  });

  it('golden: o intervalo é pinado (mudar seed/resamples é decisão deliberada)', () => {
    expect(meanCi95([0.2, 0.4, 0.6, 0.8, 1.0])).toMatchInlineSnapshot(`
      {
        "ci95": [
          0.36,
          0.84,
        ],
        "mean": 0.6,
        "n": 5,
      }
    `);
  });
});
