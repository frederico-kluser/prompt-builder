// Respostas FALSAS de juiz no contrato do IMPL-006 (R-03b:REC-3). Não é um
// arquivo de teste (sem `.test.`): helper dos testes que simulam juízes.
//
// Desde o IMPL-006 todo veredito tem de devolver o CANÁRIO sorteado para a
// chamada (lido do bloco INSTRUÇÕES do pedido) e os textos chegam em blocos
// marcados — os seletores abaixo leem o bloco em vez de `CANDIDATO:\n…`.

import { readCanary, readMarkedBlock } from '../src/engine/judgeGuard.js';
import type { Verdict } from '../src/types.js';

type Req = { user: string };

/** Canário do veredito pedido (bloco INSTRUÇÕES). */
export const canaryOf = (req: Req): string => readCanary(req.user) ?? '';

/** Texto do candidato do juiz pointwise (bloco `⟦CANDIDATO·…⟧`). */
export const candidateOf = (req: Req): string | undefined => readMarkedBlock(req.user, 'CANDIDATO');

/** Pergunta do cenário (bloco `⟦PERGUNTA·…⟧`, nos 3 juízes). */
export const questionOf = (req: Req): string => readMarkedBlock(req.user, 'PERGUNTA') ?? '';

/** Veredito pointwise válido, com o canário do pedido. */
export const pointwiseReply = (req: Req, verdict: Verdict, explanation = 'confere'): string =>
  JSON.stringify({ canario: canaryOf(req), explanation, verdict });

/** Veredito de duelo válido, com o canário do pedido. */
export const duelReply = (req: Req, winner: 'A' | 'B' | 'tie', explanation = 'x'): string =>
  JSON.stringify({ canario: canaryOf(req), explanation, winner });

/** Saída listwise com o canário do pedido. */
export const listwiseReply = (
  req: Req,
  ranking: string[],
  verdicts: { label: string; justificativa: string; veredito: string }[],
): string => JSON.stringify({ canario: canaryOf(req), ranking, verdicts });
