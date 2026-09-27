// Tetos de `max_tokens` por papel — FONTE UNICA (IMPL-017, revisao).
//
// O mesmo numero faz tres coisas: vai no corpo da chamada, dimensiona a
// reserva da PORTA DURA (o gateway reserva `preco x teto`) e alimenta a
// projecao da PORTA SUAVE (`estimateRunCost`). Quando os dois lados viviam em
// arquivos diferentes, o IMPL-017 subiu o teto do reescritor para 8192 e a
// projecao ficou em 1200: a porta suave aprovava a fase e a porta dura a
// cortava no meio — o modo de falha que as portas existem para evitar.
// `test/call-caps-contract.test.ts` vigia: projecao por chamada >= reserva
// por chamada, papel a papel, com o teto que o corpo realmente leva.
//
// Modulo puro (sem Node): entra no grafo do web pelos papeis-shim.

/** Gabarito temp-0 por cenario (retry por truncamento dobra, ver IMPL-014). */
export const MAX_TOKENS_GABARITO = 1500;
/** Juiz pointwise por referencia: 1 veredito curto. */
export const MAX_TOKENS_REF_JUDGE = 1024;
/** Duelo das finais: 1 escolha + motivo. */
export const MAX_TOKENS_DUEL = 512;
/** Juiz listwise (fallback): N vereditos numa chamada so. */
export const MAX_TOKENS_JUDGE_LISTWISE = 4096;
/** Reescritor/otimizador: devolve um system prompt inteiro (ou licoes). */
export const MAX_TOKENS_REWRITER = 8192;
/** Datagen de UM cenario (`generateStage`). */
export const MAX_TOKENS_DATAGEN_STAGE = 4096;
/** Datagen em LOTE (`generateStages`): varios cenarios no mesmo JSON. */
export const MAX_TOKENS_DATAGEN_BATCH = 8192;

/**
 * Tokens de ENTRADA que a porta suave projeta por chamada do reescritor
 * (prompt base + tecnica + instrucoes). A saida domina a reserva (8192 x
 * preco de saida), mas o teste de contrato usa este mesmo numero.
 */
export const REWRITER_PROMPT_TOKENS = 1200;
/** Tokens de entrada projetados por lote de datagen (tema + regras). */
export const DATAGEN_PROMPT_TOKENS = 400;
