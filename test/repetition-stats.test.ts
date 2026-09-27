// IMPL-054 (R-04:REC-7 / R-14a:REC-5) — repetição ≠ observação independente.
//
// O que se testa:
//   1. agregação por CENÁRIO (reps agregadas dentro do cenário) e o n do teste
//      pareado — repetições NÃO dobram o n (nEfetivo reportado);
//   2. ICC (via única), design effect DE = 1+(m−1)·ICC, √DE e nEfetivo = n·m/DE;
//   3. pass@k pelo estimador não enviesado de CHEN (divergência ≤ 1 p.p. vs a
//      estimativa plug-in por subamostragem em simulação com m=10) e pass^k
//      com a regra de sucesso EXPLÍCITA (resolve como principal; resolve ou
//      parcial como sensibilidade);
//   4. `estimate` recomenda cenários × repetições conforme o ICC.

import { describe, expect, it } from 'vitest';
import {
  aggregateByScenario,
  contestantRepetitionReports,
  formatRepetitionReport,
  iccOneWay,
  mulberry32,
  pairedSignificance,
  passAtK,
  passAtKReport,
  repVerdictMatrix,
  repetitionDiagnostics,
  repetitionDiagnosticsFromRows,
  SUCCESS_RULE_DEFINITION,
  type PairScore,
} from '../src/stats.js';
import type { Verdict } from '../src/types.js';

/** Referência ingênua do pass@k de Chen: 1 − C(n−c, k)/C(n, k) com fatoriais. */
function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i += 1) r = (r * (n - i)) / (i + 1);
  return r;
}
function passAtKIngenuo(n: number, c: number, k: number): number {
  if (n - c < k) return 1;
  return 1 - comb(n - c, k) / comb(n, k);
}

describe('IMPL-054 — pass@k: estimador não enviesado de Chen', () => {
  it('bate com a fórmula combinatória ingênua (todas as células n ≤ 12)', () => {
    for (let n = 1; n <= 12; n += 1) {
      for (let c = 0; c <= n; c += 1) {
        for (let k = 1; k <= n; k += 1) {
          expect(passAtK(n, c, k), `n=${n} c=${c} k=${k}`).toBeCloseTo(passAtKIngenuo(n, c, k), 9);
        }
      }
    }
  });

  it('divergência ≤ 1 p.p. vs plug-in por subamostragem (simulação m=10)', () => {
    // Plug-in: percorre TODOS os subconjuntos de k entre as m=10 tentativas e
    // mede a fração com ≥1 sucesso (subamostragem exaustiva — sem ruído MC).
    // O estimador de Chen tem de ficar ≤ 1 p.p. desse valor empírico.
    const rng = mulberry32(42);
    for (let t = 0; t < 200; t += 1) {
      const m = 10;
      const k = 1 + Math.floor(rng() * 5);
      const c = Math.floor(rng() * (m + 1));
      // Tentativas simuladas: as c primeiras com sucesso.
      const attempts = Array.from({ length: m }, (_, i) => (i < c ? 1 : 0));
      let subconjuntos = 0;
      let comSucesso = 0;
      const idx = Array.from({ length: k }, (_, i) => i);
      const avanca = (): boolean => {
        for (let i = k - 1; i >= 0; i -= 1) {
          if (idx[i] < m - k + i) {
            idx[i] += 1;
            for (let j = i + 1; j < k; j += 1) idx[j] = idx[j - 1] + 1;
            return true;
          }
        }
        return false;
      };
      do {
        subconjuntos += 1;
        if (idx.some((i) => attempts[i] === 1)) comSucesso += 1;
      } while (avanca());
      const plugIn = comSucesso / subconjuntos;
      const chen = passAtK(m, c, k);
      expect(Math.abs(chen - plugIn) * 100, `m=${m} c=${c} k=${k}`).toBeLessThanOrEqual(1);
    }
  });

  it('é NÃO enviesado para o pass@k populacional (o plug-in c/n não é)', () => {
    // Problemas heterogêneos: p ~ U(0,2; 0,8), m = 10 tentativas cada. O
    // verdadeiro pass@k do problema i é 1−(1−pᵢ)^k; a média do estimador de
    // Chen tem de ficar ≤ 1 p.p. dela — e MAIS PERTO que o plug-in 1−(1−c/n)^k.
    const rng = mulberry32(7);
    const PROB = 4000;
    const m = 10;
    const k = 3;
    let somaChen = 0;
    let somaPlug = 0;
    let somaVerdade = 0;
    for (let i = 0; i < PROB; i += 1) {
      const p = 0.2 + rng() * 0.6;
      let c = 0;
      for (let j = 0; j < m; j += 1) if (rng() < p) c += 1;
      somaChen += passAtK(m, c, k);
      somaPlug += 1 - (1 - c / m) ** k;
      somaVerdade += 1 - (1 - p) ** k;
    }
    const chen = somaChen / PROB;
    const plug = somaPlug / PROB;
    const verdade = somaVerdade / PROB;
    expect(Math.abs(chen - verdade) * 100).toBeLessThanOrEqual(1);
    // O plug-in (1−(1−c/n)^k) é enviesado — Chen fica mais perto da verdade.
    expect(Math.abs(chen - verdade)).toBeLessThan(Math.abs(plug - verdade));
  });
});

describe('IMPL-054 — pass^k com definição explícita de sucesso', () => {
  const rows: (Verdict | undefined)[][] = [
    ['resolve', 'resolve'],
    ['resolve', 'parcial'],
    ['parcial', 'parcial'],
    ['resolve', 'nao'],
    ['nao', 'nao'],
  ];

  it('sucesso = resolve (regra principal); resolve ou parcial é SENSIBILIDADE', () => {
    const principal = passAtKReport(rows, 2);
    expect(principal.rule).toBe('resolve');
    expect(principal.ruleDefinition).toBe(SUCCESS_RULE_DEFINITION.resolve);
    expect(principal.ruleDefinition).toContain('resolve');
    // pass^2 = fração de cenários com sucesso nas DUAS reps: só o cenário 0.
    expect(principal.passK).toBeCloseTo(1 / 5, 4);
    const sens = passAtKReport(rows, 2, 'resolve-ou-parcial');
    expect(sens.ruleDefinition).toBe(SUCCESS_RULE_DEFINITION['resolve-ou-parcial']);
    // Sensibilidade: cenários 0, 1 e 2 têm ≥2 sucessos.
    expect(sens.passK).toBeCloseTo(3 / 5, 4);
    expect(sens.passAtK).toBeGreaterThan(principal.passAtK);
  });

  it('regra de sucesso sempre impressa no relatório', () => {
    const diag = repetitionDiagnosticsFromRows([[1, 1], [0, 0]]);
    const linhas = formatRepetitionReport(diag, passAtKReport(rows, 2)).join('\n');
    expect(linhas).toContain('sucesso =');
    expect(linhas).toMatch(/pass@2=[\d.,]+%/);
  });
});

describe('IMPL-054 — ICC, design effect e nEfetivo (repetição não dobra o n)', () => {
  it('reps perfeitamente correlatas: ICC=1, DE=m e nEfetivo = n (não n·m)', () => {
    const rows: PairScore[][] = Array.from({ length: 12 }, (_, i) => [i % 2, i % 2]);
    const d = repetitionDiagnosticsFromRows(rows);
    expect(d.scenarios).toBe(12);
    expect(d.repsPerScenario).toBe(2);
    expect(d.observations).toBe(24);
    expect(d.icc).toBe(1);
    expect(d.designEffect).toBe(2);
    expect(d.seInflation).toBeCloseTo(Math.SQRT2, 2);
    // nEfetivo = n·m/DE = 24/2 = 12 — as reps NÃO dobram o n.
    expect(d.nEfetivo).toBe(12);
  });

  it('reps independentes: ICC ≈ 0, DE ≈ 1 e nEfetivo ≈ n·m', () => {
    const rng = mulberry32(11);
    const rows: PairScore[][] = Array.from({ length: 40 }, () =>
      Array.from({ length: 3 }, () => (rng() < 0.5 ? 0 : 1)),
    );
    const d = repetitionDiagnosticsFromRows(rows);
    expect(d.icc).not.toBeNull();
    expect(d.icc!).toBeLessThan(0.2);
    expect(d.designEffect!).toBeLessThan(1.5);
    expect(d.nEfetivo).toBeGreaterThan(100);
  });

  it('ICC > 0,3 ⇒ a recomendação é MAIS CENÁRIOS (mais reps agregam pouco)', () => {
    const rows: PairScore[][] = Array.from({ length: 12 }, (_, i) => [i % 2, i % 2]);
    const d = repetitionDiagnosticsFromRows(rows);
    expect(d.advice).toBe('more-scenarios');
    const linhas = formatRepetitionReport(d).join('\n');
    expect(linhas).toContain('MAIS CENÁRIOS');
    expect(linhas).toMatch(/ICC=1\.000 · design effect DE=2\.000/);
    expect(linhas).toMatch(/nEfetivo=12/);
  });

  it('m=1: sem ICC estimável e nEfetivo = observações', () => {
    const d = repetitionDiagnostics([1, 0, 1, 0, 1], 1);
    expect(d.icc).toBeNull();
    expect(d.designEffect).toBeNull();
    expect(d.nEfetivo).toBe(5);
  });

  it('iccOneWay devolve null sem dispersão estimável', () => {
    expect(iccOneWay([[1], [1]])).toBeNull();
    expect(iccOneWay([[1, 1]])).toBeNull();
    expect(iccOneWay([])).toBeNull();
  });

  it('aggregateByScenario: reps viram a média do CENÁRIO (ausente sem obs)', () => {
    expect(aggregateByScenario([1, 0, 0.5, 0.5, 1, 1], 2)).toEqual([0.5, 0.5, 1]);
    expect(aggregateByScenario([null, 1, 0, 0], 2)).toEqual([1, 0]);
    expect(aggregateByScenario([0.5, 0.5, 0.5], 1)).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('IMPL-054 — o teste pareado não tem o n dobrado pelas repetições', () => {
  it('12 cenários × 2 reps idênticas → n = 12 (o par é o cenário)', () => {
    const control = Array.from({ length: 12 }, () => 0);
    const champion = Array.from({ length: 12 }, () => 1);
    // Vetor PLANO cenário-major: [c0r0, c0r1, c1r0, c1r1, ...] — como o
    // orchestrator expande `repeats`.
    const flatControl = control.flatMap((v) => [v, v]);
    const flatChampion = champion.flatMap((v) => [v, v]);
    const semAgregacao = pairedSignificance(flatControl, flatChampion);
    expect(semAgregacao!.n).toBe(24); // o bug antigo: n nominal dobrado
    const comAgregacao = pairedSignificance(flatControl, flatChampion, { repeatsPerScenario: 2 });
    expect(comAgregacao!.n).toBe(12);
    expect(comAgregacao!.nEfetivo).toBe(12);
    expect(comAgregacao!.meanDiffPp).toBe(100);
  });

  it('reps ruidosas agregadas dentro do cenário: nEfetivo reportado = cenários', () => {
    const flatControl: PairScore[] = [];
    const flatChampion: PairScore[] = [];
    for (let i = 0; i < 10; i += 1) {
      flatControl.push(0, 0.5, 1, 0.5); // 4 reps por cenário
      flatChampion.push(1, 0.5, 1, 1);
    }
    const sig = pairedSignificance(flatControl, flatChampion, { repeatsPerScenario: 4 });
    expect(sig!.n).toBe(10);
    expect(sig!.nEfetivo).toBe(10);
  });
});

describe('IMPL-054 — matriz de reps nas duas geometrias (agente e compare)', () => {
  const stages = [
    {
      referenceJudge: {
        verdictByContestant: { a: 'resolve' as Verdict },
        verdictsByRep: { a: ['resolve', 'parcial'] as Verdict[] },
      },
    },
    {
      referenceJudge: {
        verdictByContestant: { a: 'nao' as Verdict },
        verdictsByRep: { a: ['nao', 'nao'] as Verdict[] },
      },
    },
  ];

  it('agente (reps dentro da etapa): linhas por cenário com as reps', () => {
    const rows = repVerdictMatrix(stages, 'a');
    expect(rows).toEqual([
      ['resolve', 'parcial'],
      ['nao', 'nao'],
    ]);
  });

  it('compare (repeats>1): clones consecutivos viram UM cenário com m reps', () => {
    const clones = [...stages, ...stages.map((s) => ({ ...s }))];
    const rows = repVerdictMatrix(clones, 'a', { repeatsPerScenario: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(4);
  });
});

describe('IMPL-054 — repetitionDiagnostics com vetor plano (compare repeats)', () => {
  it('m=2: nEfetivo = n·m/DE e o relatório sai com dígitos', () => {
    const flat: PairScore[] = [];
    for (let i = 0; i < 20; i += 1) flat.push(i % 2, i % 2);
    const d = repetitionDiagnostics(flat, 2);
    expect(d.scenarios).toBe(20);
    expect(d.nEfetivo).toBe(20);
    const linhas = formatRepetitionReport(d).join('\n');
    expect(linhas).toMatch(/m=2 × 20 cenários \(40 observações\)/);
    expect(linhas).toMatch(/√DE=1\.41/);
  });
});

describe('IMPL-054 — runs show: ICC/design effect/nEfetivo sempre que há repetição', () => {
  // Geometria de agente: reps DENTRO da etapa (`verdictsByRep`), 4 cenários × 2
  // reps perfeitamente correlatas (a rep nunca diverge da irmã). O cenário 2
  // tem só 'parcial' — entra apenas na sensibilidade (sucesso = resolve OU parcial).
  const stages = [
    {
      referenceJudge: {
        verdictByContestant: { a: 'resolve' as Verdict, b: 'nao' as Verdict },
        verdictsByRep: { a: ['resolve', 'resolve'] as Verdict[], b: ['nao', 'nao'] as Verdict[] },
      },
    },
    {
      referenceJudge: {
        verdictByContestant: { a: 'nao' as Verdict, b: 'resolve' as Verdict },
        verdictsByRep: { a: ['nao', 'nao'] as Verdict[], b: ['resolve', 'resolve'] as Verdict[] },
      },
    },
    {
      referenceJudge: {
        verdictByContestant: { a: 'parcial' as Verdict, b: 'parcial' as Verdict },
        verdictsByRep: { a: ['parcial', 'parcial'] as Verdict[], b: ['parcial', 'parcial'] as Verdict[] },
      },
    },
    {
      referenceJudge: {
        verdictByContestant: { a: 'nao' as Verdict, b: 'nao' as Verdict },
        verdictsByRep: { a: ['nao', 'nao'] as Verdict[], b: ['nao', 'nao'] as Verdict[] },
      },
    },
  ];

  const contestants = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ];

  it('por contestant: ICC, DE, nEfetivo E pass@k/pass^k — a fonte única do texto e do JSON', () => {
    const reports = contestantRepetitionReports(stages, contestants);
    expect(reports.map((r) => r.contestantId)).toEqual(['a', 'b']);
    for (const r of reports) {
      // Sempre que há repetição: os três diagnósticos existem e são coerentes.
      expect(r.diagnostics.repsPerScenario).toBe(2);
      expect(r.diagnostics.observations).toBe(8); // 4 cenários × 2 reps
      expect(r.diagnostics.icc).not.toBeNull();
      expect(r.diagnostics.designEffect).not.toBeNull();
      expect(r.diagnostics.seInflation).not.toBeNull();
    }
    const a = reports[0];
    // Reps perfeitamente correlatas: ICC=1, DE=2 e nEfetivo = 4 CENÁRIOS —
    // as repetições NÃO dobram o n (8 observações, 4 pares analíticos).
    expect(a.diagnostics.icc).toBe(1);
    expect(a.diagnostics.designEffect).toBe(2);
    expect(a.diagnostics.nEfetivo).toBe(4);
    // Sucesso EXPLÍCITO nas duas saídas: principal = 'resolve'; o cenário 2
    // (só 'parcial') entra SOMENTE na sensibilidade ('resolve' OU 'parcial').
    expect(a.pass.rule).toBe('resolve');
    expect(a.pass.ruleDefinition).toBe(SUCCESS_RULE_DEFINITION.resolve);
    expect(a.pass.passK).toBeCloseTo(1 / 4, 4); // só o cenário 0 tem 2× 'resolve'
    expect(a.sensitivity.rule).toBe('resolve-ou-parcial');
    expect(a.sensitivity.ruleDefinition).toContain('parcial');
    expect(a.sensitivity.passK).toBeCloseTo(2 / 4, 4); // cenários 0 e 2
  });

  it('geometria compare (clones consecutivos): mesmo contrato, nEfetivo = cenários', () => {
    // Compare `repeats=2`: o orchestrator expande cada cenário em 2 clones
    // consecutivos SEM `verdictsByRep` — o par analítico continua o cenário.
    const flat = stages.map((s) => ({
      referenceJudge: { verdictByContestant: s.referenceJudge.verdictByContestant },
    }));
    const clones = flat.flatMap((s) => [s, { ...s }]);
    const reports = contestantRepetitionReports(clones, [contestants[0]], { repeatsPerScenario: 2 });
    expect(reports).toHaveLength(1);
    const d = reports[0].diagnostics;
    expect(d.scenarios).toBe(4);
    expect(d.repsPerScenario).toBe(2);
    expect(d.observations).toBe(8);
    expect(d.nEfetivo).toBe(4); // 8 observações/DE=2 — nunca 8
    // O relatório textual sai da MESMA fonte (formatRepetitionReport(d, pass)).
    const linhas = formatRepetitionReport(d, reports[0].pass).join('\n');
    expect(linhas).toContain(`nEfetivo=${d.nEfetivo}`);
    expect(linhas).toContain('sucesso =');
  });
});
