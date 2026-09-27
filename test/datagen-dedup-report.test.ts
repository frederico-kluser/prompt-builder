// IMPL-063 (R-05:REC-7) — relatório de duplicatas removidas POR RUN de datagen.
//
// O gap: o resultado do dedup (dropped/method) era DESCARTADO dentro de
// `generateStages` — nenhuma run reportava quantas duplicatas foram removidas.
// O relatório (`DedupeReport`) agora sai por `onDedupReport` em toda geração E
// por narração no stderr (uma linha quando houve descarte; com taxa > 20% a
// linha traz o alerta). Este contrato cobre o fio inteiro (lotes → backfill →
// relatório combinado), não só a função pura de `test/dedup-semantic.test.ts`.
//
// Decisão honesta: com 0 descartes NÃO ha linha (sem ruído); o relatório
// continua sendo entregue ao chamador sempre (dropped = 0), para quem quiser
// persisti-lo no record.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/openrouter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/openrouter.js')>();
  return { ...real, chatCompletion: vi.fn(real.chatCompletion) };
});

import { createGateway, setDefaultGateway } from '../src/openrouter.js';
import * as datagen from '../src/datagen.js';
import { DEDUP_ALERT_RATE, type DedupeReport } from '../src/dedup.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

/** Cenário distinto por i (pergunta + contexto); cópia literal = duplicata exata. */
function cenario(i: number): Record<string, unknown> {
  return {
    question: `Pergunta distinta número ${i} sobre ${['troca', 'garantia', 'frete', 'nota', 'prazo', 'defeito'][i % 6]} do produto ${i * 37}?`,
    productContext: `Política ${i}: trocas em até 30 dias.`,
    maxTokens: 300,
    rubric: `Deve citar o prazo da política ${i}.`,
  };
}

/** Fake do gerador: a n-ésima chamada devolve `porChamada(n)` cenários. */
function fakeGerador(porChamada: (n: number) => Record<string, unknown>[]): FakeOpenRouter {
  let nDatagen = 0;
  return fakeOpenRouter({
    catalog: [catalogItem('fake/gen', 0.000001, 0.000002)],
    chat: () => ({ text: JSON.stringify({ stages: porChamada(nDatagen++) }) }),
  });
}

let anterior: ReturnType<typeof setDefaultGateway> | undefined;
let warn: ReturnType<typeof vi.spyOn>;

function instalar(f: FakeOpenRouter): void {
  anterior = setDefaultGateway(createGateway({ fetch: f.fetch, sleep: noSleep }));
}

/** Linhas de narração do dedup no stderr. */
function avisosDedup(): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((a) => a.includes('[datagen] dedup'));
}

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
});

describe('IMPL-063 — a run de datagen reporta quantas duplicatas removeu', () => {
  it('acima de 20%: relatório combinado (sem dupla-contagem) + alerta no stderr', async () => {
    // 2 lotes devolvendo as MESMAS 4 cenas (4 exatas duplicadas) + backfill de 6.
    instalar(
      fakeGerador((n) => (n < 2 ? [cenario(1), cenario(2), cenario(3), cenario(4)] : [cenario(5), cenario(6), cenario(7), cenario(8), cenario(9), cenario(10)])),
    );
    const relatorios: DedupeReport[] = [];
    const out = await datagen.generateStages({
      apiKey: KEY,
      theme: 'trocas',
      count: 8,
      modelId: 'fake/gen',
      onDedupReport: (r) => relatorios.push(r),
    });
    expect(out.length).toBe(8);

    // UM relatório por run (os passes somam sem duplicar): 8 brutos + 6 do
    // backfill = 14 considerados, 4 exatas descartadas — nunca a soma dos
    // totais dos dois passes (8 + 10 = 18, que inflaria o denominador).
    expect(relatorios).toHaveLength(1);
    const r = relatorios[0];
    expect(r.total).toBe(14);
    expect(r.kept).toBe(10);
    expect(r.dropped).toBe(4);
    expect(r.exactDropped).toBe(4);
    expect(r.rate).toBeCloseTo(4 / 14);
    expect(r.alertRate).toBe(DEDUP_ALERT_RATE);
    expect(r.alert).toBe(true);

    // A run REPORTA (stderr) com taxa e o alerta de > 20%.
    const linhas = avisosDedup();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toContain('dedup removeu');
    expect(linhas[0]).toContain('(4/14)');
    expect(linhas[0]).toContain('acima de 20%');
  });

  it('abaixo de 20%: sem alerta, MAS a linha de resumo continua contando os descartes', async () => {
    // 1 lote com 1 duplicata exata (1/6 = 17% de descarte) + backfill de 2.
    instalar(fakeGerador((n) => (n === 0 ? [cenario(1), cenario(2), cenario(3), cenario(1)] : [cenario(5), cenario(6)])));
    const relatorios: DedupeReport[] = [];
    const out = await datagen.generateStages({
      apiKey: KEY,
      theme: 'trocas',
      count: 4,
      modelId: 'fake/gen',
      onDedupReport: (r) => relatorios.push(r),
    });
    expect(out.length).toBe(4);

    const r = relatorios[0];
    expect(r.dropped).toBe(1);
    expect(r.rate).toBeCloseTo(1 / 6);
    expect(r.alert).toBe(false);

    const linhas = avisosDedup();
    expect(linhas).toHaveLength(1); // reporta mesmo SEM alerta (o gap era este)
    expect(linhas[0]).toContain('(1/6)');
    expect(linhas[0]).not.toContain('acima de');
  });

  it('0 descartes: relatório entregue (dropped = 0) e nenhuma linha de ruído', async () => {
    instalar(fakeGerador(() => [cenario(1), cenario(2)]));
    const relatorios: DedupeReport[] = [];
    await datagen.generateStages({
      apiKey: KEY,
      theme: 'trocas',
      count: 2,
      modelId: 'fake/gen',
      onDedupReport: (r) => relatorios.push(r),
    });
    const r = relatorios[0];
    expect(r.total).toBe(2);
    expect(r.kept).toBe(2);
    expect(r.dropped).toBe(0);
    expect(r.rate).toBe(0);
    expect(r.alert).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});