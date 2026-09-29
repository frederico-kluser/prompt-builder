// IMPL-112 (restante) — a API de BIBLIOTECA (`src/index.ts`, o `.` do pacote)
// exporta a régua de saturação por item e o relatório da geração: quem
// consome o pacote audita records antigos e monta a fila de revisão de
// gabarito com o MESMO cálculo que a run grava — sem reimplementar.

import { describe, expect, it } from 'vitest';
import * as lib from '../src/index.js';
import * as datagen from '../src/datagen.js';

describe('IMPL-112 — itemSaturationReport & cia. na API de biblioteca', () => {
  it('exporta as MESMAS funções do módulo (identidade, não cópia)', () => {
    expect(lib.itemSaturationReport).toBe(datagen.itemSaturationReport);
    expect(lib.gabaritoReviewQueue).toBe(datagen.gabaritoReviewQueue);
    expect(lib.assertIrtSampleSize).toBe(datagen.assertIrtSampleSize);
    expect(lib.IrtSampleSizeError).toBe(datagen.IrtSampleSizeError);
    expect(lib.DEFAULT_SATURATION_MIN_EXECUTIONS).toBe(datagen.DEFAULT_SATURATION_MIN_EXECUTIONS);
    expect(lib.rubricAnswerability).toBe(datagen.rubricAnswerability);
    expect(lib.describeDatagenShortfall).toBe(datagen.describeDatagenShortfall);
  });

  it('IMPL-063: o embedder de produção também sai pela API de biblioteca', async () => {
    const emb = await import('../src/embeddings.js');
    expect(lib.createOpenRouterEmbedder).toBe(emb.createOpenRouterEmbedder);
    expect(typeof lib.meteredInputCall).toBe('function');
  });

  it('item 100% resolve em k execuções entra na fila de revisão pela API pública', () => {
    const spec = { question: 'Qual o prazo de troca?', productContext: 'Trocas em 30 dias.' };
    const stages = [0, 1, 2].map((index) => ({
      index,
      spec,
      referenceJudge: { verdictByContestant: { a: 'resolve' as const } },
    }));
    const rep = lib.itemSaturationReport(stages, { minExecutions: 3 });
    expect(rep.needsReviewCount).toBe(1);
    expect(lib.gabaritoReviewQueue(rep).map((r) => r.saturated)).toEqual(['all-resolve']);
    // Nunca descarta: o item continua em `items`.
    expect(rep.items).toHaveLength(1);
  });
});
