// Shim do benchmark de visão: o motor PURO (dataset/prompt/parse/placar/runner
// core) é fonte única em `src/engine/vision/`. O que é seam de navegador
// (fetch das imagens, IndexedDB, key) vive em `web/src/vision/`.
export * from '../../../src/engine/vision/index.js';
