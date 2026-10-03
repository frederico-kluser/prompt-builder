// SHIM do juiz JEV (modelo de decisão como juiz): fonte única em
// `src/jevJudge.ts` — o mesmo mapping de células, bandas e cascata roda no
// Node e na SPA (o endpoint de decisões tem CORS aberto). Classificado em
// test/engine-sync.test.ts.
export * from '../../../src/jevJudge.js';
