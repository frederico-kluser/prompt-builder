// Harness de simulação do gate de promoção (IMPL-002, R-04:REC-3) —
// `npm run stats:sim`. Reprodutível: cada célula tem seed própria derivada de
// (modo, n, K, flip), então o resultado não depende da ordem nem do paralelismo.
//
//   npm run stats:sim                      # grade de aceite completa (20.000 ensaios/célula)
//   npm run stats:sim -- --trials 2000     # mais rápida, mesma grade
//   npm run stats:sim -- --sparse          # + H1 esparso (só 1 variante real), informativo
//   npm run stats:sim -- --holm            # fallback Holm no lugar do max-T
//   npm run stats:sim -- --out sim.jsonl   # uma célula por linha (JSONL)
//   npm run stats:sim -- --jobs 8          # processos em paralelo (default: nº de CPUs − 1)
//
// Saída: a tabela por célula no stderr e o veredito dos dois critérios de aceite
// (promoção falsa ≤ 5,5% em 100% das células H0; |viés| do ganho corrigido
// ≤ 1 p.p. sob H1 de +10 p.p.). Exit 1 se algum critério falhar.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  acceptanceGrid,
  MAX_ABS_BIAS_PP,
  MAX_FALSE_PROMOTION,
  simulateCell,
  type CellResult,
  type CellSpec,
} from './stats-sim-core.js';

const SELF = fileURLToPath(import.meta.url);

async function runCellInChild(spec: CellSpec): Promise<CellResult> {
  return new Promise((resolve, reject) => {
    // Reusa os flags do loader do tsx (process.execArgv) no filho.
    const child = spawn(process.execPath, [...process.execArgv, SELF, '--cell', JSON.stringify(spec)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`célula ${JSON.stringify(spec)} saiu com ${code}`));
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()!) as CellResult);
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function pool<T, R>(items: T[], jobs: number, fn: (t: T) => Promise<R>, onDone: (r: R, i: number) => void) {
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      const r = await fn(items[i]);
      done += 1;
      onDone(r, done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
}

const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;
const pp = (x: number | null): string => (x === null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}`);

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      cell: { type: 'string' },
      trials: { type: 'string', default: '20000' },
      jobs: { type: 'string' },
      out: { type: 'string' },
      sparse: { type: 'boolean', default: false },
      holm: { type: 'boolean', default: false },
    },
  });
  if (values.cell) {
    // Modo filho: uma célula, uma linha JSON no stdout.
    process.stdout.write(`${JSON.stringify(simulateCell(JSON.parse(values.cell) as CellSpec))}\n`);
    return 0;
  }

  const trials = Math.max(1, Number(values.trials));
  const jobs = Math.max(1, Number(values.jobs ?? Math.max(1, availableParallelism() - 1)));
  const multiplicity = values.holm ? ('holm' as const) : undefined;
  const cells = acceptanceGrid(trials).map((c) => ({ ...c, ...(multiplicity ? { multiplicity } : {}) }));
  if (values.sparse) {
    for (const flip of [0.15, 0.3])
      for (const n of [5, 8, 12, 20, 50])
        for (const K of [2, 4, 8]) cells.push({ n, K, flip, mode: 'h1-sparse', trials, ...(multiplicity ? { multiplicity } : {}) });
  }
  // As células caras (n = 20 exato, n ≥ 30 Monte Carlo, K grande) primeiro: o pool termina junto.
  const cost = (c: CellSpec): number => (c.n >= 15 ? c.n * c.K * 10 : c.n * c.K);
  const order = [...cells].sort((a, b) => cost(b) - cost(a));

  console.error(
    `stats:sim — ${cells.length} células × ${trials} ensaios, ${jobs} processos` +
      `${multiplicity ? ' (Holm)' : ' (max-T)'}; gate = pickWinner real (minGain default max(1; 50/n), α = 0,05)`,
  );
  const results: CellResult[] = [];
  const t0 = Date.now();
  await pool(order, jobs, runCellInChild, (r, done) => {
    results.push(r);
    console.error(
      `[${done}/${cells.length}] ${r.mode.padEnd(9)} n=${String(r.n).padStart(2)} K=${r.K} flip=${r.flip.toFixed(2)}  ` +
        `promo ${pct(r.promotionRate).padStart(7)} (antigo ${pct(r.legacyPromotionRate).padStart(7)})  ` +
        `viés bruto ${pp(r.biasRawPp).padStart(6)} corrigido ${pp(r.biasCorrectedPp).padStart(6)}±${r.biasCorrectedSe.toFixed(2)}  ${(r.ms / 1000).toFixed(1)}s`,
    );
  });
  results.sort((a, b) => a.mode.localeCompare(b.mode) || a.flip - b.flip || a.n - b.n || a.K - b.K);
  if (values.out) writeFileSync(values.out, results.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const h0 = results.filter((r) => r.mode === 'h0');
  const h1 = results.filter((r) => r.mode === 'h1');
  const h0Fail = h0.filter((r) => r.promotionRate > MAX_FALSE_PROMOTION);
  const h1Fail = h1.filter((r) => Math.abs(r.biasCorrectedPp) > MAX_ABS_BIAS_PP);
  const worstH0 = h0.reduce((a, b) => (b.promotionRate > a.promotionRate ? b : a), h0[0]);
  const worstBias = h1.reduce((a, b) => (Math.abs(b.biasCorrectedPp) > Math.abs(a.biasCorrectedPp) ? b : a), h1[0]);
  console.error('');
  console.error(`tempo total: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.error(
    `H0 — promoção falsa por iteração: máx ${pct(worstH0.promotionRate)} (n=${worstH0.n} K=${worstH0.K} flip=${worstH0.flip}); ` +
      `gate antigo: ${pct(Math.min(...h0.map((r) => r.legacyPromotionRate)))}–${pct(Math.max(...h0.map((r) => r.legacyPromotionRate)))}; ` +
      `células ≤ ${pct(MAX_FALSE_PROMOTION)}: ${h0.length - h0Fail.length}/${h0.length}`,
  );
  console.error(
    `H1 (+${10} p.p. em todas) — |viés| corrigido máx ${Math.abs(worstBias.biasCorrectedPp).toFixed(2)} p.p. ` +
      `(n=${worstBias.n} K=${worstBias.K} flip=${worstBias.flip}); bruto até ${Math.max(...h1.map((r) => r.biasRawPp)).toFixed(2)} p.p.; ` +
      `células ≤ ${MAX_ABS_BIAS_PP} p.p.: ${h1.length - h1Fail.length}/${h1.length}`,
  );
  for (const r of h1Fail) {
    console.error(`  fora: n=${r.n} K=${r.K} flip=${r.flip} viés corrigido ${pp(r.biasCorrectedPp)}±${r.biasCorrectedSe}`);
  }
  // Resumo no stdout (payload): um objeto JSON.
  process.stdout.write(
    `${JSON.stringify({
      cells: results.length,
      trials,
      multiplicity: multiplicity ?? 'max-t',
      h0: { cells: h0.length, pass: h0.length - h0Fail.length, maxFalsePromotion: worstH0.promotionRate },
      h1: {
        cells: h1.length,
        pass: h1.length - h1Fail.length,
        maxAbsBiasCorrectedPp: Math.abs(worstBias.biasCorrectedPp),
        maxBiasRawPp: Math.max(...h1.map((r) => r.biasRawPp)),
      },
    })}\n`,
  );
  return h0Fail.length === 0 && h1Fail.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(2);
  },
);
