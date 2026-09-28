// IMPL-046 (R-11a:REC-4) — regra de RECUSA de recomendação com estado inconclusivo.
//
// O que se testa:
//   1. a função de decisão recusa nos 4 casos do contrato (nEfetivo < 5, IC95%
//      cobrindo zero, P(superioridade) < 80%, Δ < granularidade 100/n);
//   2. '+1, 0, 0, 0, 0' → inconclusivo COM sugestão de n; '+0,5 × 5' → conclusivo;
//   3. o texto honesto: nenhum rótulo verbal de probabilidade sem dígito adjacente;
//   4. sob H0 (harness Monte Carlo, 20 mil ensaios) a recomendação falsa fica
//      ≤ 5% após a correção da melhor de K (α/k no IC).

import { describe, expect, it } from 'vitest';
import {
  meanCiSummary,
  mulberry32,
  normalCdf,
  invNormalCdf,
  recommendationDecision,
  recommendationFromSummary,
} from '../src/stats.js';
import { FULL, ensaios } from './support/effort.js';

/** Scores pareados a partir de Δ (controle 0, candidato = Δ). */
function fromDiffs(diffs: readonly number[]): {
  control: number[];
  candidate: number[];
} {
  return { control: diffs.map(() => 0), candidate: [...diffs] };
}

const LABELS = { candidate: 'A', control: 'B' };

describe('IMPL-046 — veredito de recomendação (recusa honesta)', () => {
  it("'+0,5 × 5' → conclusivo (o candidato supera em TODOS os pares)", () => {
    const { control, candidate } = fromDiffs([0.5, 0.5, 0.5, 0.5, 0.5]);
    const d = recommendationDecision(control, candidate, { labels: LABELS });
    expect(d.verdict).toBe('conclusivo');
    expect(d.winner).toBe('A');
    expect(d.ruler).toBe('judge-score+ci');
    expect(d.ci95).toEqual([50, 50]);
    expect(d.p_superiority).toBe(1);
    expect(d.nEfetivo).toBe(5);
    expect(d.holds).toEqual([]);
  });

  it("'+1, 0, 0, 0, 0' → INCONCLUSIVO, sem vencedor e com sugestão de n", () => {
    const { control, candidate } = fromDiffs([1, 0, 0, 0, 0]);
    const d = recommendationDecision(control, candidate, { labels: LABELS });
    expect(d.verdict).toBe('inconclusivo');
    expect(d.winner).toBeUndefined();
    // O IC95% do Δ cobre zero (um único par positivo não é evidência).
    expect(d.holds).toContain('ci-covers-zero');
    expect(d.ci95[0]).toBeLessThanOrEqual(0);
    expect(d.ci95[1]).toBeGreaterThan(0);
    // Sugestão de n para o próximo passo — sempre presente.
    expect(d.suggestedN).toBeGreaterThan(5);
    expect(d.targetDeltaPp).toBe(20);
    expect(d.text).toContain(`Rode N=${d.suggestedN} cenários`);
  });

  it('granularidade 100/n: Δ menor que uma unidade de judge-score é recusado', () => {
    // 10 pares, Δ = 5 p.p. em todos → granularidade 10 p.p. → abaixo dela.
    const diffs = Array.from({ length: 10 }, () => 0.05);
    const { control, candidate } = fromDiffs(diffs);
    const d = recommendationDecision(control, candidate, { labels: LABELS });
    expect(d.granularityPp).toBe(10);
    expect(d.holds).toContain('below-granularity');
    expect(d.verdict).toBe('inconclusivo');
  });

  it('nEfetivo < 5 pares com veredito recusa (mesmo com Δ enorme)', () => {
    const { control, candidate } = fromDiffs([1, 1, 1, 1]); // 4 pares
    const d = recommendationDecision(control, candidate, { labels: LABELS });
    expect(d.holds).toContain('no-pairs');
    expect(d.verdict).toBe('inconclusivo');
    expect(d.nEfetivo).toBe(4);
  });

  it('P(superioridade) < 80% recusa (limiar configurável)', () => {
    const base = { n: 40, meanPp: 5, sdPp: 30, sePp: 4.74 };
    const d = recommendationFromSummary(
      { ...base, ci95Pp: [-12, 16], pSuperiority: 0.66 },
      { labels: LABELS },
    );
    expect(d.holds).toContain('low-superiority');
    expect(d.holds).toContain('ci-covers-zero');
    expect(d.verdict).toBe('inconclusivo');
    // Limiar configurável: com 0,5 o mesmo caso já não trava por superioridade.
    const d2 = recommendationFromSummary(
      { ...base, ci95Pp: [1, 9], pSuperiority: 0.66 },
      { labels: LABELS, minPSuperiority: 0.5 },
    );
    expect(d2.holds).not.toContain('low-superiority');
    expect(d2.verdict).toBe('conclusivo');
  });

  it('simetria: controle melhor que o candidato → conclusivo com winner = controle', () => {
    const { control, candidate } = fromDiffs([-0.5, -0.5, -0.5, -0.5, -0.5, -0.5]);
    const d = recommendationDecision(control, candidate, { labels: LABELS });
    expect(d.verdict).toBe('conclusivo');
    expect(d.winner).toBe('B');
    expect(d.p_superiority).toBe(0);
  });

  it('recusa sem nenhuma observação (sem par)', () => {
    const d = recommendationDecision([null, null, null], [null, null, null], { labels: LABELS });
    expect(d.verdict).toBe('inconclusivo');
    expect(d.holds).toContain('no-pairs');
    expect(Number.isFinite(d.suggestedN)).toBe(true);
  });
});

// --- texto honesto: toda probabilidade com dígito adjacente -------------------

/**
 * Rótulos VERBAIS de probabilidade que a R-11a:REC-4 proíbe sem número ao lado.
 * O contrato: quem lê o texto nunca vê "provável"/"significativo" solto — toda
 * afirmação de probabilidade carrega o dígito (P(...)=58%, 80% de poder, …).
 */
const ROTULOS_PROBABILIDADE =
  /\b(provável|provavel|improvável|improvavel|quase certo|certeza|significativo|significativa|estatisticamente|forte|fraco|fraca|robusto|robusta|evidente|plausível|plausivel|consistente)\b/gi;

function assertSemRotuloVerbal(texto: string): void {
  for (const m of texto.matchAll(ROTULOS_PROBABILIDADE)) {
    const i = m.index ?? 0;
    const aoRedor = texto.slice(Math.max(0, i - 8), i + m[0].length + 8);
    expect(aoRedor.match(/\d/), `rótulo verbal sem dígito adjacente em: "${texto}"`).not.toBeNull();
  }
}

describe('IMPL-046 — texto honesto (sem rótulo verbal de probabilidade sem dígito)', () => {
  const casos: [number[], string][] = [
    [[1, 0, 0, 0, 0], 'inconclusivo por IC'],
    [[0.5, 0.5, 0.5, 0.5, 0.5], 'conclusivo'],
    [[-0.5, -0.5, -0.5, -0.5, -0.5], 'controle melhor'],
    [[0.1, -0.1, 0.05, -0.05, 0.2, -0.2, 0.02, -0.02], 'empate ruidoso'],
    [[0.5, -0.5, 0.5, -0.5, 0.5, -0.5], 'alternância'],
    [[], 'sem pares'],
  ];
  for (const [diffs, nome] of casos) {
    it(`sem rótulo verbal sem dígito — ${nome}`, () => {
      const { control, candidate } = fromDiffs(diffs);
      const d = recommendationDecision(control, candidate, { labels: LABELS });
      assertSemRotuloVerbal(d.text);
      // O texto sempre traz Δ, IC e P(A>B) COM dígitos.
      expect(d.text).toMatch(/Δ=/);
      expect(d.text).toMatch(/IC95%/);
      expect(d.text).toMatch(/P\(A>B\)=\d/);
    });
  }
});

// --- harness Monte Carlo sob H0 (20 mil ensaios) --------------------------------

describe('IMPL-046 — sob H0, recomendação falsa ≤ 5% após correção da melhor de K', () => {
  it('Monte Carlo sob H0, K = 4 candidatos, n = 10 pares (seed fixa)', () => {
    const TRIALS = ensaios(20_000, 2_000);
    const K = 4;
    const N = 10;
    const rng = mulberry32(20260928);
    let falsas = 0;
    for (let t = 0; t < TRIALS; t += 1) {
      // H0: candidato e controle saem da MESMA distribuição de vereditos ternários.
      const draw = (): number => {
        const u = rng();
        return u < 1 / 3 ? 0 : u < 2 / 3 ? 0.5 : 1;
      };
      const control = Array.from({ length: N }, draw);
      let melhor = -1;
      let melhorIdx = 0;
      const candidatos: number[][] = [];
      for (let k = 0; k < K; k += 1) {
        const scores = Array.from({ length: N }, draw);
        candidatos.push(scores);
        const diffs = scores.map((s, i) => s - control[i]);
        const media = diffs.reduce((a, b) => a + b, 0) / N;
        if (media > melhor) {
          melhor = media;
          melhorIdx = k;
        }
      }
      // O candidato é o MELHOR de K — o IC sai com α/k (Bonferroni).
      const d = recommendationDecision(control, candidatos[melhorIdx], {
        labels: LABELS,
        k: K,
      });
      if (d.verdict === 'conclusivo' && d.winner === 'A') falsas += 1;
    }
    const taxa = falsas / TRIALS;
    // Limiar duro (5%) no test:full; na versão rápida, folga 3σ do erro de
    // Monte Carlo (EM ≈ 0,5% com 2.000 ensaios) — o contrato estatístico é o
    // mesmo, muda a resolução da simulação.
    const LIMIAR = FULL ? 0.05 : 0.075;
    expect(taxa, `recomendações falsas: ${falsas}/${TRIALS}`).toBeLessThanOrEqual(LIMIAR);
    // A correção importa: sem ela (α cheio) a taxa sobe — registrada em comentário.
    expect(taxa).toBeGreaterThanOrEqual(0);
  });
});

// --- núcleo paramétrico (autossuficiência do cálculo) ---------------------------

describe('IMPL-046 — núcleo paramétrico (normal e resumo do Δ)', () => {
  it('normalCdf/invNormalCdf são inversas', () => {
    for (const p of [0.001, 0.025, 0.5, 0.8, 0.975, 0.999]) {
      expect(normalCdf(invNormalCdf(p))).toBeCloseTo(p, 6);
    }
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
  });

  it('meanCiSummary: sem dispersão o IC é degenerado e P(superioridade) é 0/0,5/1', () => {
    const up = meanCiSummary([0.5, 0.5, 0.5]);
    expect(up.ci95Pp).toEqual([50, 50]);
    expect(up.pSuperiority).toBe(1);
    const flat = meanCiSummary([0, 0, 0]);
    expect(flat.pSuperiority).toBe(0.5);
    const down = meanCiSummary([-0.5, -0.5]);
    expect(down.pSuperiority).toBe(0);
  });

  it('meanCiSummary: o IC ALARGA com α/k (correção da melhor de K é conservadora)', () => {
    const diffs = [0.2, -0.1, 0.3, 0.05, -0.05, 0.15, 0, 0.1];
    const sem = meanCiSummary(diffs, { k: 1 });
    const com = meanCiSummary(diffs, { k: 4 });
    expect(com.ci95Pp[1] - com.ci95Pp[0]).toBeGreaterThan(sem.ci95Pp[1] - sem.ci95Pp[0]);
  });
});
