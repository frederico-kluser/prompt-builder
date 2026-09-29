// IMPL-058 (R-03a:REC-4 / DEC-4) — calibração juiz × humano: o formato
// calibration-jsonl@1, o α ordinal de Krippendorff, o AC2 de Gwet, o IC95% por
// bootstrap, sensibilidade/especificidade e o PORTÃO do `calib report` (exit 10).
//
// As fórmulas são conferidas contra exemplos PUBLICADOS — não contra a própria
// implementação:
//  - Krippendorff (2011), "Computing Krippendorff's Alpha-Reliability", seção C:
//    4 codificadores × 12 unidades, valores 1–5 com dado faltante. Publicado:
//    α nominal .743, ordinal .815, intervalar .849, razão .797. Os dígitos
//    completos abaixo batem com o pacote `krippendorff` 0.8.2 (Python);
//  - Wikipedia, "Krippendorff's alpha" (3 codificadores × 15 unidades):
//    publicado α nominal .691 e intervalar .811 (dígitos completos e o ordinal
//    pelo mesmo pacote);
//  - Gwet (2014), Handbook of Inter-Rater Reliability, 4ª ed., sobre os MESMOS
//    dados de Krippendorff (dataset `cac.raw4raters` do irrCAC): AC1 0,7754
//    (p_a 0,8182; p_e 0,1903). AC2 com pesos ordinal/quadrático/linear pelo
//    `irrCAC` para Python (arredondado a 5 casas lá — daí o `toBeCloseTo(…, 4)`).
//
// O resto (piloto primeiro, juiz só com α humano ≥ 0,667, faixa humana, sens/
// espec, prontidão, exit codes) é conferido sobre dados construídos aqui.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALPHA_MIN,
  MAX_CI_WIDTH,
  agreementWeights,
  bootstrapCi,
  calibrationReport,
  goldDiagnostics,
  gwetAc2,
  krippendorffAlpha,
  parseCalibrationJsonl,
  wilson,
  type CalibrationItem,
  type Unit,
} from '../src/engine/calibration.js';
import { calibrationTemplate } from '../src/cli/commands/calib.js';
import { COMMANDS, renderCommandHelp } from '../src/cli/help.js';
import { commandLabel } from '../src/cli/context.js';
import { EXIT } from '../src/cli/output.js';
import type { Verdict } from '../src/types.js';
import { nodeOrTsx } from './support/cli.js';

// --- dados publicados -------------------------------------------------------------

const _ = null;
/** Krippendorff (2011), seção C: linhas = codificadores A–D, colunas = unidades 1–12. */
const KRIPPENDORFF_2011: (number | null)[][] = [
  [1, 2, 3, 3, 2, 1, 4, 1, 2, _, _, _],
  [1, 2, 3, 3, 2, 2, 4, 1, 2, 5, _, 3],
  [_, 3, 3, 3, 2, 3, 4, 2, 2, 5, 1, _],
  [1, 2, 3, 3, 2, 4, 4, 1, 2, 5, 1, _],
];
/** Wikipedia, "Krippendorff's alpha": codificadores A–C × unidades 1–15. */
const WIKIPEDIA: (number | null)[][] = [
  [_, _, _, _, _, 3, 4, 1, 2, 1, 1, 3, 3, _, 3],
  [1, _, 2, 1, 3, 3, 4, 3, _, _, _, _, _, _, _],
  [_, _, 2, 1, 3, 4, 4, _, 2, 1, 1, 3, 3, _, 4],
];

/** Matriz codificador × unidade → unidades (só os valores presentes). */
function toUnits(m: (number | null)[][]): Unit[] {
  return m[0].map((__, u) => m.map((linha) => linha[u]).filter((v): v is number => v !== null));
}

describe('α de Krippendorff — matriz de coincidências contra os exemplos publicados', () => {
  const k2011 = toUnits(KRIPPENDORFF_2011);

  it('Krippendorff (2011): nominal .743, ordinal .815, intervalar .849, razão .797', () => {
    expect(krippendorffAlpha(k2011, 'nominal').alpha).toBeCloseTo(0.743421052631579, 12);
    expect(krippendorffAlpha(k2011, 'ordinal').alpha).toBeCloseTo(0.8153875037548814, 12);
    expect(krippendorffAlpha(k2011, 'interval').alpha).toBeCloseTo(0.8491071428571428, 12);
    expect(krippendorffAlpha(k2011, 'ratio').alpha).toBeCloseTo(0.7974027747116121, 12);
    // Arredondado como no artigo.
    expect(krippendorffAlpha(k2011, 'ordinal').alpha!.toFixed(3)).toBe('0.815');
  });

  it('n = valores PAREÁVEIS: a unidade 12 (um valor só) não entra', () => {
    const r = krippendorffAlpha(k2011, 'nominal');
    expect(r.units).toBe(11);
    expect(r.pairable).toBe(40); // Krippendorff (2011): n.. = 40
  });

  it('Wikipedia: nominal .691, intervalar .811 (ordinal pelo pacote de referência)', () => {
    const w = toUnits(WIKIPEDIA);
    expect(krippendorffAlpha(w, 'nominal').alpha).toBeCloseTo(0.691358024691358, 12);
    expect(krippendorffAlpha(w, 'interval').alpha).toBeCloseTo(0.8108448928121059, 12);
    expect(krippendorffAlpha(w, 'ordinal').alpha).toBeCloseTo(0.8067214199413153, 12);
  });

  it('ordinal usa só a ORDEM: reescalar os valores de forma monotônica não muda α', () => {
    const esticado = k2011.map((u) => u.map((v) => v ** 3 + 10));
    expect(krippendorffAlpha(esticado, 'ordinal').alpha).toBeCloseTo(0.8153875037548814, 12);
    // …mas muda o intervalar (a distância importa lá).
    expect(krippendorffAlpha(esticado, 'interval').alpha).not.toBeCloseTo(0.8491071428571428, 3);
  });

  it('indefinido (null) sem variação ou sem pares — nunca 0 nem NaN', () => {
    expect(krippendorffAlpha([[2, 2], [2, 2], [2, 2]]).alpha).toBeNull();
    expect(krippendorffAlpha([[1], [2]]).alpha).toBeNull();
    expect(krippendorffAlpha([]).alpha).toBeNull();
  });

  it('concordância perfeita = 1; na escala do veredito, exemplo conferido com o pacote', () => {
    expect(krippendorffAlpha([[0, 0], [1, 1], [2, 2]]).alpha).toBe(1);
    const a = [2, 2, 1, 0, 2, 1, 0, 2, 1, 2];
    const b = [2, 1, 1, 0, 2, 2, 0, 2, 0, 2];
    expect(krippendorffAlpha(a.map((x, i) => [x, b[i]])).alpha).toBeCloseTo(0.7677777777777778, 12);
  });
});

describe('AC2 de Gwet — contra o Handbook (Gwet 2014) e o irrCAC', () => {
  const k2011 = toUnits(KRIPPENDORFF_2011);
  const escala = [1, 2, 3, 4, 5];

  it('AC1 (pesos identidade) nos dados de Krippendorff: 0,7754 com p_a 0,8182 e p_e 0,1903', () => {
    const r = gwetAc2(k2011, escala, 'identity');
    expect(r.ac2).toBeCloseTo(0.77544, 4);
    expect(r.pa).toBeCloseTo(0.81818, 4);
    expect(r.pe).toBeCloseTo(0.19032, 4);
    expect(r.units).toBe(12); // a unidade com 1 rótulo entra em π (não em p_a)
  });

  it('AC2 ordinal 0,89894 · quadrático 0,914 · linear 0,85874 (irrCAC)', () => {
    const o = gwetAc2(k2011, escala, 'ordinal');
    expect(o.ac2).toBeCloseTo(0.89894, 4);
    expect(o.pa).toBeCloseTo(0.96818, 4);
    expect(o.pe).toBeCloseTo(0.68516, 4);
    expect(gwetAc2(k2011, escala, 'quadratic').ac2).toBeCloseTo(0.914, 4);
    expect(gwetAc2(k2011, escala, 'linear').ac2).toBeCloseTo(0.85874, 4);
  });

  it('pesos ordinais de Gwet na escala do veredito: vizinhos 2/3, extremos 0', () => {
    const w = agreementWeights([0, 1, 2], 'ordinal');
    expect(w[0][0]).toBe(1);
    expect(w[0][1]).toBeCloseTo(2 / 3, 12);
    expect(w[0][2]).toBe(0);
    expect(w[1][0]).toBeCloseTo(2 / 3, 12);
    expect(w[1][2]).toBeCloseTo(2 / 3, 12);
  });

  it('escala do veredito (irrCAC): AC2 ordinal 0,75593; AC1 0,56364', () => {
    const a = [2, 2, 1, 0, 2, 1, 0, 2, 1, 2];
    const b = [2, 1, 1, 0, 2, 2, 0, 2, 0, 2];
    const u = a.map((x, i) => [x, b[i]]);
    expect(gwetAc2(u, [0, 1, 2], 'ordinal').ac2).toBeCloseTo(0.75593, 4);
    expect(gwetAc2(u, [0, 1, 2], 'identity').ac2).toBeCloseTo(0.56364, 4);
  });

  it('PARADOXO DA PREVALÊNCIA: quase tudo "resolve" → α despenca, AC2 não (por isso os dois)', () => {
    const p1 = [...Array<number>(18).fill(2), 1, 2];
    const p2 = [...Array<number>(18).fill(2), 2, 1];
    const u = p1.map((x, i) => [x, p2[i]]);
    expect(krippendorffAlpha(u).alpha).toBeCloseTo(-0.026315789473684292, 12);
    expect(gwetAc2(u, [0, 1, 2]).ac2).toBeCloseTo(0.96338, 4);
  });

  it('categoria fora da escala é erro de programação (não some em silêncio)', () => {
    expect(() => gwetAc2([[1, 7]], [0, 1, 2])).toThrow(/fora da escala/);
  });
});

describe('juiz × humano: unidades replicadas (juiz, anotador_k)', () => {
  it('α e AC2 batem com o pacote de referência sobre os pares replicados', () => {
    const h1 = [2, 2, 1, 0, 2, 1, 0, 2, 1, 2];
    const h2 = [2, 1, 1, 0, 2, 2, 0, 2, 0, 2];
    const j = [2, 2, 2, 0, 1, 1, 0, 2, 1, 2];
    const u = [...j.map((x, i) => [x, h1[i]]), ...j.map((x, i) => [x, h2[i]])];
    expect(krippendorffAlpha(u).alpha).toBeCloseTo(0.6656368186874304, 12);
    const g = gwetAc2(u, [0, 1, 2]);
    expect(g.ac2).toBeCloseTo(0.71607, 4);
    expect(g.pa).toBeCloseTo(0.88333, 4);
  });
});

describe('IC95%: bootstrap percentil por item (semeado) e Wilson', () => {
  const itens = Array.from({ length: 60 }, (__, i) => (i % 7 === 0 ? [2, 1] : [i % 3, i % 3]));
  const stat = (s: readonly number[][]): number | null => krippendorffAlpha(s).alpha;

  it('mesma semente = mesmo intervalo (reproduzível); semente diferente = outro sorteio', () => {
    const a = bootstrapCi(itens, stat, { seed: 7, resamples: 500 });
    const b = bootstrapCi(itens, stat, { seed: 7, resamples: 500 });
    const c = bootstrapCi(itens, stat, { seed: 8, resamples: 500 });
    expect(a).toEqual(b);
    expect(c!.low === a!.low && c!.high === a!.high).toBe(false);
    expect(a!.method).toBe('bootstrap-percentil-por-item');
    expect(a!.seed).toBe(7);
  });

  it('o intervalo contém a estimativa pontual e é ordenado', () => {
    const ci = bootstrapCi(itens, stat, { seed: 1, resamples: 1000 })!;
    const alpha = stat(itens)!;
    expect(ci.low).toBeLessThanOrEqual(alpha);
    expect(ci.high).toBeGreaterThanOrEqual(alpha);
    expect(ci.valid).toBe(1000);
  });

  it('com < 2 itens não há intervalo (null, nunca um IC de mentira)', () => {
    expect(bootstrapCi([[1, 1]], stat)).toBeNull();
  });

  it('Wilson 9/10 = [0,596; 0,982] e n = 0 é indefinido', () => {
    const p = wilson(9, 10);
    expect(p.value).toBe(0.9);
    expect(p.ci95!.low).toBeCloseTo(0.59585, 4);
    expect(p.ci95!.high).toBeCloseTo(0.98212, 4);
    expect(wilson(0, 0)).toEqual({ value: null, successes: 0, n: 0, ci95: null });
    // Não degenera em [0, 0] com 0 sucessos.
    expect(wilson(0, 10).ci95!.high).toBeGreaterThan(0.2);
  });
});

// --- formato calibration-jsonl@1 ---------------------------------------------------

const linha = (o: Record<string, unknown>): string => JSON.stringify(o);
const BASE = {
  id: 'x1',
  domain: 'suporte',
  taskType: 'factual',
  question: 'Qual o prazo de troca?',
  candidate: '30 dias.',
  humanLabels: [
    { annotator: 'a1', verdict: 'resolve' },
    { annotator: 'a2', verdict: 'parcial' },
  ],
};

describe('formato calibration-jsonl@1 (parse fail-closed, com linha)', () => {
  it('comentários (#), linhas vazias, BOM, "meta" e chaves "_…" são aceitos', () => {
    const texto =
      '﻿# cabeçalho\n\n' +
      `${linha({ ...BASE, meta: { tool: 'argilla' }, _nota: 'livre', judgeVerdict: 'resolve', gold: 'resolve' })}\n` +
      `   # outro comentário\n${linha({ ...BASE, id: 'x2', humanLabels: [{ annotator: 'a1', verdict: 'nao', _t: 3 }, { annotator: 'a2', verdict: 'nao', note: 'errou o prazo' }] })}\n`;
    const p = parseCalibrationJsonl(texto);
    expect(p.errors).toEqual([]);
    expect(p.items.map((i) => i.id)).toEqual(['x1', 'x2']);
    expect(p.items[0].judgeVerdict).toBe('resolve');
    expect(p.items[1].humanLabels[1].note).toBe('errou o prazo');
  });

  it('erros apontam a LINHA: JSON quebrado, chave desconhecida (typo), veredito inválido', () => {
    const texto = [
      '# c',
      '{"id": "q"',
      linha({ ...BASE, id: 'y1', judgeVerdit: 'resolve' }),
      linha({ ...BASE, id: 'y2', humanLabels: [{ annotator: 'a1', verdict: 'não' }, { annotator: 'a2', verdict: 'nao' }] }),
    ].join('\n');
    const p = parseCalibrationJsonl(texto);
    expect(p.errors.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(p.errors[0].message).toMatch(/JSON inválido/);
    // O typo sumiria com o rótulo do juiz em silêncio: é ERRO.
    expect(p.errors[1].message).toMatch(/judgeVerdit/);
    expect(p.errors[2].message).toMatch(/"nao" \(sem til\)/);
    expect(p.items).toEqual([]);
  });

  it('id duplicado e o MESMO anotador 2× no item são erro (inflariam a concordância)', () => {
    const p = parseCalibrationJsonl(
      [
        linha(BASE),
        linha(BASE),
        linha({ ...BASE, id: 'z', humanLabels: [{ annotator: 'a1', verdict: 'nao' }, { annotator: 'a1', verdict: 'nao' }] }),
      ].join('\n'),
    );
    expect(p.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/id duplicado \(já usado na linha 1\)/),
      expect.stringMatching(/anotador "a1" rotulou o item mais de uma vez/),
    ]);
  });

  it('campos obrigatórios faltando são listados', () => {
    const p = parseCalibrationJsonl(linha({ id: 'k', humanLabels: [] }));
    const msgs = p.errors.map((e) => e.message).join(' | ');
    for (const campo of ['domain', 'taskType', 'question', 'candidate']) expect(msgs).toContain(campo);
  });

  it('avisos: item com < 2 rótulos (fica fora do α) e taskType fora da lista', () => {
    const p = parseCalibrationJsonl(
      linha({ ...BASE, taskType: 'factal', humanLabels: [{ annotator: 'a1', verdict: 'resolve' }] }),
    );
    expect(p.errors).toEqual([]);
    expect(p.items).toHaveLength(1);
    expect(p.warnings.map((w) => w.message)).toEqual([
      expect.stringMatching(/taskType "factal" fora da lista/),
      expect.stringMatching(/FORA do α/),
    ]);
  });

  it('o template (itens SINTÉTICOS) é um arquivo válido e todo item é marcado', () => {
    const p = parseCalibrationJsonl(calibrationTemplate());
    expect(p.errors).toEqual([]);
    expect(p.warnings).toEqual([]);
    expect(p.items.length).toBeGreaterThanOrEqual(6);
    for (const i of p.items) {
      expect(i.synthetic).toBe(true);
      expect(i.id).toMatch(/^SINTETICO-/);
      expect(i.humanLabels.length).toBeGreaterThanOrEqual(2);
    }
    expect(calibrationTemplate()).toMatch(/EXEMPLO SINTÉTICO/);
  });
});

// --- relatório e portão ---------------------------------------------------------------

const ESCALA: Verdict[] = ['nao', 'parcial', 'resolve'];
const TIPOS = ['extracao', 'factual', 'raciocinio', 'formato', 'recusa', 'aberta'];
const vizinho = (v: Verdict): Verdict => (v === 'resolve' ? 'parcial' : v === 'nao' ? 'parcial' : 'resolve');

interface Gerador {
  n: number;
  /** Rótulo do 2º anotador a partir do "verdadeiro". */
  a2?: (v: Verdict, i: number) => Verdict;
  judge?: (v: Verdict, i: number) => Verdict | undefined;
  gold?: boolean;
}

/** Conjunto construído: classe verdadeira em ciclo; a1 = verdade; a2/juiz derivados. */
function conjunto({ n, a2 = (v) => v, judge, gold = false }: Gerador): CalibrationItem[] {
  return Array.from({ length: n }, (__, i) => {
    const v = ESCALA[i % 3];
    const j = judge?.(v, i);
    return {
      id: `it-${i}`,
      domain: 'teste',
      taskType: TIPOS[i % TIPOS.length],
      question: `pergunta ${i}`,
      candidate: `resposta ${i}`,
      humanLabels: [
        { annotator: 'a1', verdict: v },
        { annotator: 'a2', verdict: a2(v, i) },
      ],
      ...(j ? { judgeVerdict: j } : {}),
      ...(gold ? { gold: v } : {}),
    };
  });
}

const RAPIDO = { resamples: 300 };

describe('relatório: ordem obrigatória humano × humano → juiz × humano', () => {
  it('--pilot mede só anotador × anotador (o juiz nem é lido)', () => {
    const r = calibrationReport(
      conjunto({ n: 40, a2: (v, i) => (i % 10 === 0 ? vizinho(v) : v), judge: (v) => v }),
      { pilot: true, ...RAPIDO },
    );
    expect(r.mode).toBe('pilot');
    expect(r.human.alpha!).toBeGreaterThan(ALPHA_MIN);
    expect(r.judge).toMatchObject({ status: 'skipped', reason: 'pilot' });
    expect(r.gate).toEqual({ passed: true, code: null, reasons: [] });
    expect(r.readiness.ready).toBe(true); // 40 itens: dentro de 30–50
  });

  it('α humano < 0,667 → portão REPROVA e o juiz NÃO é medido (mesmo perfeito)', () => {
    const r = calibrationReport(
      conjunto({ n: 60, a2: (__, i) => ESCALA[(i * 7 + 1) % 3], judge: (v) => v, gold: true }),
      RAPIDO,
    );
    expect(r.human.alpha!).toBeLessThan(ALPHA_MIN);
    expect(r.judge).toMatchObject({ status: 'skipped', reason: 'human_alpha_below_min' });
    expect(r.gate.passed).toBe(false);
    expect(r.gate.code).toBe('gate.calibration_human_alpha_low');
  });

  it('α humano INDEFINIDO (todos iguais) reprova — "não deu para medir" não é "concorda"', () => {
    const r = calibrationReport(conjunto({ n: 30, a2: () => 'resolve' }).map((i) => ({
      ...i,
      humanLabels: i.humanLabels.map((l) => ({ ...l, verdict: 'resolve' as Verdict })),
    })), RAPIDO);
    expect(r.human.alpha).toBeNull();
    expect(r.gate.code).toBe('gate.calibration_human_alpha_low');
    expect(r.gate.reasons[0]).toMatch(/indefinido/);
  });

  it('juiz que concorda como um humano: medido, dentro da faixa, aceitável, portão aprovado', () => {
    const r = calibrationReport(
      conjunto({ n: 90, a2: (v, i) => (i % 10 === 0 ? vizinho(v) : v), judge: (v) => v }),
      RAPIDO,
    );
    expect(r.judge.status).toBe('measured');
    if (r.judge.status !== 'measured') return;
    expect(r.judge.agreement.alpha!).toBeGreaterThanOrEqual(r.judge.humanSameItems.alpha!);
    expect(r.judge.withinHumanBand).toBe(true);
    expect(r.judge.acceptable).toBe(true);
    expect(r.judge.agreement.coders).toBe(3); // 2 anotadores + o juiz
    expect(r.gate.passed).toBe(true);
    // Δ pareado com IC: o juiz (= a1) concorda mais que a1 × a2.
    expect(r.judge.deltaVsHuman.value!).toBeGreaterThan(0);
    expect(r.judge.deltaVsHuman.ci95).not.toBeNull();
  });

  it('juiz aleatório → gate.calibration_judge_alpha_low', () => {
    const r = calibrationReport(
      conjunto({ n: 90, a2: (v, i) => (i % 10 === 0 ? vizinho(v) : v), judge: (__, i) => ESCALA[(i * 5 + 2) % 3] }),
      RAPIDO,
    );
    expect(r.judge).toMatchObject({ status: 'measured', acceptable: false });
    expect(r.gate.code).toBe('gate.calibration_judge_alpha_low');
  });

  it('juiz com α ≥ 0,667 mas ABAIXO da faixa humano × humano → gate.calibration_judge_outside_human_band', () => {
    // Humanos em concordância perfeita (IC [1, 1]); juiz erra 1 vizinho a cada 8.
    const r = calibrationReport(
      conjunto({ n: 90, judge: (v, i) => (i % 8 === 0 ? vizinho(v) : v) }),
      RAPIDO,
    );
    expect(r.judge.status).toBe('measured');
    if (r.judge.status !== 'measured') return;
    expect(r.judge.agreement.alpha!).toBeGreaterThanOrEqual(ALPHA_MIN);
    expect(r.judge.withinHumanBand).toBe(false);
    expect(r.gate.code).toBe('gate.calibration_judge_outside_human_band');
    expect(r.gate.reasons).toHaveLength(1);
  });

  it('sem "judgeVerdict": juiz não medido, portão olha só o humano (aprovado) e a prontidão acusa', () => {
    const r = calibrationReport(conjunto({ n: 30 }), RAPIDO);
    expect(r.judge).toMatchObject({ status: 'skipped', reason: 'no_judge_labels' });
    expect(r.gate.passed).toBe(true);
    expect(r.readiness.issues).toContain('sem "judgeVerdict": o juiz não foi medido');
  });

  it('juiz × humano é medido NOS MESMOS itens (item sem veredito do juiz fica fora dos dois lados)', () => {
    const r = calibrationReport(
      conjunto({ n: 60, a2: (v, i) => (i % 10 === 0 ? vizinho(v) : v), judge: (v, i) => (i < 30 ? v : undefined) }),
      RAPIDO,
    );
    expect(r.human.items).toBe(60);
    if (r.judge.status !== 'measured') throw new Error('juiz deveria ter sido medido');
    expect(r.judge.agreement.items).toBe(30);
    expect(r.judge.humanSameItems.items).toBe(30);
  });
});

describe('ouro: sensibilidade/especificidade (resolve × resto) com Wilson', () => {
  it('contagens exatas e a matriz de confusão (linha = ouro, coluna = juiz)', () => {
    // 30 de cada classe. Juiz: 3 "resolve" viram "parcial" (FN); 4 "parcial" viram "resolve" (FP).
    const itens = conjunto({
      n: 90,
      gold: true,
      judge: (v, i) => {
        if (v === 'resolve' && i < 9) return 'parcial';
        if (v === 'parcial' && i < 12) return 'resolve';
        return v;
      },
    });
    const g = goldDiagnostics(itens)!;
    expect(g.items).toBe(90);
    expect(g.sensitivity).toMatchObject({ successes: 27, n: 30, value: 0.9 });
    expect(g.specificity).toMatchObject({ successes: 56, n: 60 });
    expect(g.specificity.value).toBeCloseTo(56 / 60, 12);
    expect(g.confusion.resolve).toEqual({ nao: 0, parcial: 3, resolve: 27 });
    expect(g.confusion.parcial).toEqual({ nao: 0, parcial: 26, resolve: 4 });
    expect(g.goldPrevalence).toBeCloseTo(1 / 3, 12);
    expect(g.sensitivity.ci95!.low).toBeCloseTo(wilson(27, 30).ci95!.low, 12);
  });

  it('sem ouro nos itens julgados = null (nada inventado)', () => {
    expect(goldDiagnostics(conjunto({ n: 10, judge: (v) => v }))).toBeNull();
  });
});

describe('prontidão do conjunto e --strict', () => {
  it('protocolo completo (≥ 150, ≥ 30 por classe e tipo, IC ≤ 0,2): pronto', () => {
    const r = calibrationReport(
      conjunto({ n: 180, a2: (v, i) => (i % 25 === 0 ? vizinho(v) : v), judge: (v, i) => (i % 20 === 0 ? vizinho(v) : v), gold: true }),
      { resamples: 500 },
    );
    expect(r.readiness.issues).toEqual([]);
    expect(r.readiness.ready).toBe(true);
    expect(r.human.alphaCi95!.high - r.human.alphaCi95!.low).toBeLessThanOrEqual(MAX_CI_WIDTH);
  });

  it('pequeno, sintético e com estratos rasos: NÃO pronto — e só reprova o portão com strict', () => {
    const itens = conjunto({ n: 12, judge: (v) => v }).map((i) => ({ ...i, synthetic: true }));
    const r = calibrationReport(itens, RAPIDO);
    expect(r.readiness.ready).toBe(false);
    const texto = r.readiness.issues.join(' | ');
    expect(texto).toMatch(/SINTÉTICO/);
    expect(texto).toMatch(/12 item\(ns\) completo\(s\) \(mínimo 150/);
    expect(texto).toMatch(/classe "nao": 4 item\(ns\) \(mínimo 30\)/);
    expect(texto).toMatch(/tipo de tarefa "factual"/);
    expect(r.gate.passed).toBe(true);
    const estrito = calibrationReport(itens, { ...RAPIDO, strict: true });
    expect(estrito.gate.code).toBe('gate.calibration_not_ready');
  });

  it('domínios misturados e juízes misturados são pendência', () => {
    const itens = conjunto({ n: 30, judge: (v) => v }).map((i, k) => ({
      ...i,
      domain: k % 2 ? 'a' : 'b',
      judgeModel: k % 2 ? 'juiz-1' : 'juiz-2',
    }));
    const r = calibrationReport(itens, RAPIDO);
    const texto = r.readiness.issues.join(' | ');
    expect(texto).toMatch(/POR domínio/);
    expect(texto).toMatch(/2 juízes misturados/);
  });

  it('item com 1 rótulo fica fora do α e é contado como incompleto', () => {
    const itens = conjunto({ n: 31 });
    itens[0] = { ...itens[0], humanLabels: itens[0].humanLabels.slice(0, 1) };
    const r = calibrationReport(itens, RAPIDO);
    expect(r.items).toMatchObject({ total: 31, complete: 30, incomplete: 1 });
    expect(r.human.items).toBe(30);
  });

  it('3 anotadores em rodízio: α de todos + o α de cada par', () => {
    const nomes = ['ana', 'bia', 'caio'];
    const itens: CalibrationItem[] = Array.from({ length: 45 }, (__, i) => {
      // Classe muda a cada 3 itens: cada par de anotadores vê as 3 classes.
      const v = ESCALA[Math.floor(i / 3) % 3];
      const par = [nomes[i % 3], nomes[(i + 1) % 3]];
      return {
        id: `r${i}`,
        domain: 'teste',
        taskType: 'factual',
        question: 'q',
        candidate: 'c',
        humanLabels: par.map((annotator, k) => ({ annotator, verdict: k === 1 && par[1] === 'caio' && i % 5 === 0 ? vizinho(v) : v })),
      };
    });
    const r = calibrationReport(itens, { pilot: true, ...RAPIDO });
    expect(r.annotators).toEqual(['ana', 'bia', 'caio']);
    expect(r.human.pairs).toHaveLength(3);
    expect(r.human.pairs.every((p) => p.items === 15)).toBe(true);
    const semCaio = r.human.pairs.find((p) => p.a === 'ana' && p.b === 'bia')!;
    expect(semCaio.alpha).toBe(1);
  });

  it('o relatório é JSON puro (sem NaN/Infinity) e o α bate com a função pura', () => {
    const itens = conjunto({ n: 45, a2: (v, i) => (i % 9 === 0 ? vizinho(v) : v), judge: (v) => v, gold: true });
    const r = calibrationReport(itens, RAPIDO);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    expect(r.human.alpha).toBe(krippendorffAlpha(itens.map((i) => i.humanLabels.map((l) => ESCALA.indexOf(l.verdict)))).alpha);
  });
});

// --- CLI (processo real) ----------------------------------------------------------------

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { cmd: BIN, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));
let dir = '';

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: path.join(dir, 'home'), OPENROUTER_BASE_URL: 'http://127.0.0.1:9/api/v1' };
  delete env.OPENROUTER_API_KEY;
  const r = spawnSync(BIN, [ENTRY, ...args], { env, encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const jsonl = (itens: CalibrationItem[]): string => `${itens.map((i) => JSON.stringify(i)).join('\n')}\n`;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pb-calib-'));
  writeFileSync(
    path.join(dir, 'bom.jsonl'),
    jsonl(conjunto({ n: 45, a2: (v, i) => (i % 10 === 0 ? vizinho(v) : v), judge: (v) => v, gold: true })),
  );
  writeFileSync(
    path.join(dir, 'ruim.jsonl'),
    jsonl(conjunto({ n: 45, a2: (__, i) => ESCALA[(i * 7 + 1) % 3], judge: (v) => v })),
  );
  writeFileSync(path.join(dir, 'quebrado.jsonl'), `${JSON.stringify(BASE)}\n{"id": "x2", "verdict": \n`);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('`calib` no processo real (exit codes e envelope)', { timeout: 120_000 }, () => {
  it('report --json: exit 0, ok:true, calibration-report@1', () => {
    const r = cli(['calib', 'report', '--file', path.join(dir, 'bom.jsonl'), '--json', '--resamples', '300']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const env = JSON.parse(r.stdout);
    expect(env).toMatchObject({ ok: true, command: 'calib.report' });
    expect(env.data.report.format).toBe('calibration-report@1');
    expect(env.data.report.judge.status).toBe('measured');
    expect(env.data.report.judge.gold.sensitivity.value).toBe(1);
  });

  it('α humano < 0,667 → exit 10 (gate) com o relatório inteiro em error.details', () => {
    const r = cli(['calib', 'report', '--file', path.join(dir, 'ruim.jsonl'), '--json', '--resamples', '300']);
    expect(r.status).toBe(EXIT.GATE_BLOCKED);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.command).toBe('calib.report');
    expect(env.error.kind).toBe('gate');
    expect(env.error.code).toBe('gate.calibration_human_alpha_low');
    expect(env.error.hint).toMatch(/--pilot/);
    expect(env.error.details.report.judge.reason).toBe('human_alpha_below_min');
    expect(env.error.details.report.human.alpha).toBeLessThan(ALPHA_MIN);
  });

  it('--pilot ignora o juiz; texto vai ao stdout e a narração ao stderr', () => {
    const r = cli(['calib', 'report', path.join(dir, 'bom.jsonl'), '--pilot', '--resamples', '300']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(r.stdout).toMatch(/HUMANO × HUMANO/);
    expect(r.stdout).toMatch(/JUIZ × HUMANO — piloto/);
    expect(r.stdout).toMatch(/PORTÃO {6}aprovado/);
  });

  it('arquivo ausente = 2 (usage.file_unreadable); inválido = 3 com a linha; sem --file = 2', () => {
    const ausente = cli(['calib', 'report', '--file', path.join(dir, 'nao-existe.jsonl'), '--json']);
    expect(ausente.status).toBe(EXIT.USAGE);
    expect(JSON.parse(ausente.stdout).error.code).toBe('usage.file_unreadable');

    const quebrado = cli(['calib', 'report', '--file', path.join(dir, 'quebrado.jsonl'), '--json']);
    expect(quebrado.status).toBe(EXIT.CONFIG);
    const env = JSON.parse(quebrado.stdout);
    expect(env.error.code).toBe('config.calibration_invalid');
    expect(env.error.details.errors[0].line).toBe(2);

    const semArquivo = cli(['calib', 'report', '--json']);
    expect(semArquivo.status).toBe(EXIT.USAGE);
    expect(JSON.parse(semArquivo.stdout).error.code).toBe('usage.missing_file');
  });

  it('--seed/--resamples inválidos e subcomando desconhecido = 2', () => {
    expect(cli(['calib', 'report', '--file', path.join(dir, 'bom.jsonl'), '--resamples', '5', '--json']).status).toBe(EXIT.USAGE);
    expect(cli(['calib', 'report', '--file', path.join(dir, 'bom.jsonl'), '--seed', '-1', '--json']).status).toBe(EXIT.USAGE);
    const r = cli(['calib', 'frobnicate', '--json']);
    expect(r.status).toBe(EXIT.USAGE);
    expect(JSON.parse(r.stdout).error.code).toBe('usage.unknown_subcommand');
  });

  it('template -o grava o exemplo (válido no report) e NUNCA sobrescreve', () => {
    const alvo = path.join(dir, 'sub', 'exemplo.jsonl');
    const r = cli(['calib', 'template', '-o', alvo, '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(JSON.parse(r.stdout).data.file).toBe(alvo);
    expect(readFileSync(alvo, 'utf-8')).toBe(calibrationTemplate());

    const rep = cli(['calib', 'report', '--file', alvo, '--json', '--resamples', '300']);
    expect(rep.status, rep.stderr).toBe(EXIT.OK);
    expect(rep.stderr).toMatch(/SINTÉTICO/);
    expect(JSON.parse(rep.stdout).data.report.readiness.ready).toBe(false);
    // …e com --strict o sintético reprova.
    expect(cli(['calib', 'report', '--file', alvo, '--strict', '--json', '--resamples', '300']).status).toBe(EXIT.GATE_BLOCKED);

    const de2 = cli(['calib', 'template', '-o', alvo, '--json']);
    expect(de2.status).toBe(EXIT.CONFIG);
    expect(JSON.parse(de2.stdout).error.code).toBe('config.file_exists');
  });

  it('dado pessoal com cara de real é AVISADO no stderr e listado em data.pii (o arquivo é versionado)', () => {
    const itens = conjunto({ n: 30 });
    itens[3] = { ...itens[3], candidate: 'O CPF do titular é 529.982.247-25.' };
    const alvo = path.join(dir, 'pii.jsonl');
    writeFileSync(alvo, jsonl(itens));
    const r = cli(['calib', 'report', '--file', alvo, '--json', '--resamples', '300']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(JSON.parse(r.stdout).data.pii).toEqual({ blocked: ['it-3'], warned: 0 });
    expect(r.stderr).toMatch(/dado pessoal.*it-3.*anonimize/);
    // O template (sintético) não carrega dado pessoal nenhum.
    const tpl = path.join(dir, 'tpl-pii.jsonl');
    writeFileSync(tpl, calibrationTemplate());
    const t = cli(['calib', 'report', '--file', tpl, '--json', '--resamples', '300']);
    expect(JSON.parse(t.stdout).data.pii).toEqual({ blocked: [], warned: 0 });
  });

  it('`calib --help` imprime o help do comando com a tabela de códigos', () => {
    const r = cli(['calib', '--help']);
    expect(r.status).toBe(EXIT.OK);
    expect(r.stdout).toMatch(/calib report --file/);
    expect(r.stdout).toMatch(/calib template/);
    expect(r.stdout).toMatch(/CÓDIGOS DE SAÍDA/);
  });
});

describe('registro do comando', () => {
  it('calib está em COMMANDS, com help próprio e rótulo calib.<sub> no envelope', () => {
    expect(COMMANDS).toContain('calib');
    expect(renderCommandHelp('calib')).toMatch(/10 portão recusou/);
    expect(commandLabel(['calib', 'report', '--file', 'x'])).toBe('calib.report');
  });
});
