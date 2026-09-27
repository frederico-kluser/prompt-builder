// Processo-operário do teste de 2 PROCESSOS do ledger em arquivo (IMPL-031).
// NÃO é um teste (sem `.test.`): `test/cli-spend-guard.test.ts` o dispara 2×
// via tsx, em paralelo, contra um OpenRouter FALSO em 127.0.0.1 (nada sai da
// máquina, nada é pago).
//
// Faz o que o pipeline faz: uma raiz de ledger (a do CLI, `openMachineLedger`,
// ou — no controle negativo `plain` — o BudgetLedger por processo de antes),
// um filho por `fork()` como o orquestrador, e chamadas pelo gateway REAL com
// `sink` + `role`, em `concurrency` laços, até o primeiro sinal de controle.
// Imprime uma linha JSON no stdout.

import { existsSync, writeFileSync } from 'node:fs';
import { createGateway } from '../../src/openrouter.js';
import { BudgetLedger, isControlSignal } from '../../src/budget.js';
import { openMachineLedger } from '../../src/cli/spendLedger.js';

interface WorkerCfg {
  dataDir: string;
  baseUrl: string;
  label: string;
  budgetUsd?: number;
  /** null = sem teto diário. */
  capUsd: number | null;
  estUsd: number;
  concurrency: number;
  /** Controle negativo: ledger só em memória (o comportamento pré-IMPL-031). */
  plain?: boolean;
  /**
   * Barreira de largada: o operário cria `<barrier>.ready-<label>` e só começa
   * a gastar quando `<barrier>.go` existir — os dois processos disputam o teto
   * AO MESMO TEMPO (sem isso, sob carga, um boot lento de tsx chegava com o
   * teto já gasto pelo outro).
   */
  barrier?: string;
}

const cfg = JSON.parse(process.argv[2] ?? '{}') as WorkerCfg;
const KEY = `sk-or-v1-${'w'.repeat(48)}`;

const gateway = createGateway({ baseUrl: cfg.baseUrl, sleep: async () => undefined, maxConcurrency: 16 });
const estimateCall = (): number => cfg.estUsd;

let root: BudgetLedger;
let close = (): void => undefined;
if (cfg.plain) {
  root = new BudgetLedger({ budgetUsd: cfg.budgetUsd, estimateCall });
} else {
  const m = openMachineLedger({
    dataDir: cfg.dataDir,
    label: cfg.label,
    budgetUsd: cfg.budgetUsd,
    estimateCall,
    cap: { capUsd: cfg.capUsd, source: 'env' },
  });
  root = m.root;
  close = () => m.machine.close();
}
// Como o orquestrador: a run é FILHA da raiz (`parentLedger.fork()`).
const run = root.fork();

let calls = 0;
const paradas: string[] = [];

async function laco(): Promise<void> {
  for (;;) {
    try {
      await gateway.chatCompletion({
        apiKey: KEY,
        modelId: 'acme/alpha',
        messages: [{ role: 'user', content: 'oi' }],
        maxTokens: 100,
        timeoutMs: 10_000,
        role: 'competitor',
        sink: run,
      });
      calls += 1;
    } catch (err) {
      if (isControlSignal(err)) {
        paradas.push((err as { scope?: string }).scope === 'daily' ? 'daily' : 'budget');
        return;
      }
      throw err;
    }
  }
}

if (cfg.barrier) {
  writeFileSync(`${cfg.barrier}.ready-${cfg.label}`, '');
  const limite = Date.now() + 60_000;
  while (!existsSync(`${cfg.barrier}.go`)) {
    if (Date.now() > limite) throw new Error('barreira de largada não abriu');
    await new Promise((r) => setTimeout(r, 10));
  }
}

await Promise.all(Array.from({ length: cfg.concurrency }, () => laco()));
close();
process.stdout.write(`${JSON.stringify({ label: cfg.label, spentUsd: run.spentUsd, calls, stoppedBy: paradas })}\n`);
