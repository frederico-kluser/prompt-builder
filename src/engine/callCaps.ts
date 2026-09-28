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

// Papeis de JUIZO: o teto TOTAL (raciocinio + resposta) mora em
// `src/roleLimits.ts` (IMPL-016) — aqui so se re-exporta, para nao haver dois
// numeros para o mesmo papel (o IMPL-017 tinha 1500/1024/512 aqui enquanto o
// IMPL-016 subia o corpo para 3072/4096/2048).
import { ROLE_MAX_TOKENS } from '../roleLimits.js';

/** Gabarito temp-0 por cenario (retry por truncamento dobra, ver IMPL-014). */
export const MAX_TOKENS_GABARITO = ROLE_MAX_TOKENS.gabarito;
/** Juiz pointwise por referencia. */
export const MAX_TOKENS_REF_JUDGE = ROLE_MAX_TOKENS.judge;
/** Duelo das finais. */
export const MAX_TOKENS_DUEL = ROLE_MAX_TOKENS.duel;
/** Juiz listwise (fallback): N vereditos numa chamada so — o mesmo teto do juiz. */
export const MAX_TOKENS_JUDGE_LISTWISE = ROLE_MAX_TOKENS.judge;
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
/**
 * Tokens de entrada projetados por lote de datagen (tema + regras + instruções
 * de JSON). Re-medido com o tokenizer do IMPL-113 (`countTextTokens`, ~3,7
 * chars/token em PT/JSON onde o `chars/4` antigo media 400) e com a margem da
 * reserva dura (~20% — `RESERVE_TOKEN_MARGIN`): a porta suave tem de cobrir a
 * reserva que o gateway realmente faz (`test/call-caps-contract.test.ts` vigia
 * projeção ≥ reserva, papel a papel).
 */
export const DATAGEN_PROMPT_TOKENS = 550;
