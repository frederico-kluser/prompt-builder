// SHIM: fonte única em `src/engine/sessionReport.ts` — relatório de CICLOS do
// treino (quanto melhorou × quanto a mudança muda o custo por chamada). CLI,
// MCP e a tela /training/:id/report usam a MESMA função.
export * from '../../../src/engine/sessionReport.js';
