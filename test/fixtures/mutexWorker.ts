// Processo-operário do teste de ESTRESSE do mutex entre processos (IMPL-031,
// revisão). NÃO é um teste (sem `.test.`): `test/cli-spend-guard.test.ts` o
// dispara N× via tsx, em paralelo, e exige a soma EXATA no fim.
//
// Dois modos, os dois read-modify-write sob `withMutexSync`:
//   • `mutex`  — M incrementos de um contador em JSON (a primitiva crua);
//   • `ledger` — M pares reserve/settle no `FileSpendLedger` (o uso real).
// Qualquer atualização perdida (dois processos na seção crítica ao mesmo
// tempo) aparece como soma menor que N×M — sem depender de timing de rede.
// Imprime uma linha JSON no stdout.

import { existsSync, writeFileSync } from 'node:fs';
import { readJsonSync, withMutexSync, writeAtomicSync } from '../../src/cli/fileGuard.js';
import { FileSpendLedger } from '../../src/cli/spendLedger.js';

interface WorkerCfg {
  mode: 'mutex' | 'ledger';
  dataDir: string;
  /** Arquivo do contador (modo `mutex`). */
  counter: string;
  ops: number;
  label: string;
  /** Custo liquidado por operação (modo `ledger`). */
  costUsd?: number;
  barrier: string;
}

const cfg = JSON.parse(process.argv[2] ?? '{}') as WorkerCfg;

writeFileSync(`${cfg.barrier}.ready-${cfg.label}`, '');
const limite = Date.now() + 60_000;
while (!existsSync(`${cfg.barrier}.go`)) {
  if (Date.now() > limite) throw new Error('barreira de largada não abriu');
  await new Promise((r) => setTimeout(r, 5));
}

const t0 = Date.now();
if (cfg.mode === 'mutex') {
  for (let i = 0; i < cfg.ops; i++) {
    withMutexSync(`${cfg.counter}.lock`, () => {
      const atual = readJsonSync<{ n: number }>(cfg.counter)?.n ?? 0;
      writeAtomicSync(cfg.counter, JSON.stringify({ n: atual + 1 }));
    });
  }
} else {
  const ledger = new FileSpendLedger({
    dataDir: cfg.dataDir,
    // Teto alto: o que se mede aqui é a soma, não a recusa.
    cap: { capUsd: 1e9, source: 'env' },
    label: cfg.label,
  });
  for (let i = 0; i < cfg.ops; i++) ledger.settle(ledger.reserve(0.002), cfg.costUsd ?? 0.001);
  ledger.close();
}
process.stdout.write(`${JSON.stringify({ label: cfg.label, ops: cfg.ops, ms: Date.now() - t0 })}\n`);
