// SHIM do modo JEV (D-3): fonte única em `src/engine/jev/` — runner, métricas,
// lint, datasets, treino e relatórios rodam IGUAIS no Node e na SPA (o
// endpoint de decisões tem CORS aberto). Classificado em test/engine-sync.test.ts.
// O import de efeito colateral aplica a config do gateway do NAVEGADOR (origem
// da página) antes de qualquer `decide` — mesmo para quem só importa este shim.
import './openrouter';

export * from '../../../src/engine/jev/index.js';
