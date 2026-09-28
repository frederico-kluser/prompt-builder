// Fonte única: tetos de max_tokens por papel (IMPL-016) são CANÔNICOS em
// `src/roleLimits.ts` e re-exportados aqui para o motor client-side (o duelo do
// SPA é mirror e lê o teto daqui). NÃO edite uma cópia.
export * from '../../../src/roleLimits.js';
