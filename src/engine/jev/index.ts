// Modo JEV — barrel SEM Node (D-3). É o que o shim `web/src/engine/jev.ts`
// re-exporta: o mesmo motor roda no CLI/MCP e na SPA. A persistência Node
// (`src/jev/store.ts`) e o CLI ficam FORA daqui.

export * from './types.js';
export * from './wire.js';
export * from './lint.js';
export * from './dist.js';
export * from './scoring.js';
export * from './calibration.js';
export * from './dataset.js';
export * from './config.js';
export * from './examples.js';
export * from './estimate.js';
export * from './llmRender.js';
export * from './llmContestant.js';
export * from './runner.js';
export * from './techniques.js';
export * from './contract.js';
export * from './dossier.js';
export * from './rewriter.js';
export * from './train.js';
export * from './report.js';
