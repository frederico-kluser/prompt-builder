// SHIM (IMPL-021): fonte única em `src/gabarito.ts` — o mesmo módulo de papel roda
// no Node e na SPA, chamando o gateway único (`src/openrouter.ts`) com
// role + sink. Classificado em test/engine-sync.test.ts.
export * from '../../../src/gabarito.js';
