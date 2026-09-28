// SHIM (IMPL-009): fonte única em `src/engine/caseInput.ts` — a montagem do
// input do caso (bloco de contexto delimitado + pergunta; variante só no
// system) é a mesma no Node e na SPA. Classificado em test/engine-sync.test.ts.
export * from '../../../src/engine/caseInput.js';
