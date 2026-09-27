// SHIM do estimador de custo (IMPL-020): fonte única em `src/estimate.ts`. O
// motor do navegador usa a MESMA estimativa por papel do Node para as portas
// suaves (grupo competidores+julgamento atômico) e o `makeCallEstimator` que
// alimenta a reserva otimista da porta dura do ledger.
export * from '../../../src/estimate.js';
