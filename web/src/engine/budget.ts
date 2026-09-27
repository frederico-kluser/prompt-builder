// SHIM do ledger de orçamento (IMPL-020, R-10:REC-3): a fonte ÚNICA é
// `src/budget.ts` — o mesmo BudgetLedger, as mesmas portas e os mesmos sinais
// de controle (BudgetExceeded/RunCancelled + isControlSignal) do Node. O web
// só injeta o que é dele: o teto (`config.budgetUsd`), o AbortSignal raiz da
// run e o `estimateCall` montado do catálogo (`makeCallEstimator`, via o shim
// de estimate). Duplicar o ledger aqui abriria espaço para os dois motores
// divergirem justamente no dinheiro.
export * from '../../../src/budget.js';
