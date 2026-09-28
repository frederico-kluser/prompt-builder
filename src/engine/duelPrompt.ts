// Prompt e parse do juiz de DUELO (IMPL-006, R-03b:REC-3) — fonte ÚNICA para
// `src/duels.ts` e o espelho `web/src/engine/duels.ts` (antes cada lado tinha a
// sua cópia, e já divergiam no rótulo "(dossiê)"). Puro e sem Node.
//
// Cada ORDEM de um duelo é um veredito: sorteia marcador + canário próprios,
// os dois candidatos entram escapados em blocos marcados e o bloco INSTRUÇÕES
// fecha o prompt. Saída: JSON estrito com o canário; qualquer desvio => `null`
// (a ordem fica SEM resultado e o duelo vai para `failedDuels`, nunca empate).

import { z } from 'zod';
import type { JudgeConfidence, StageSpec } from '../types.js';
import {
  DATA_BLOCKS_NOTICE,
  formatReminderFor,
  instructionsBlock,
  markedBlock,
  newJudgeGuard,
  parseStrictJudgeJson,
  strictObjectSchema,
  styleRuleFor,
  type JudgeGuard,
} from './judgeGuard.js';

// Head do prompt de duelo — fixa o contrato do veredito head-to-head (portado).
//
// IMPL-047 (R-03a:REC-7) — prompt HONESTO, mesmo espírito do pointwise: a
// referência é CANDIDATA (pode estar errada), a rubrica tem prioridade (se a
// referência contrariar a rubrica, siga a rubrica) e o JSON traz `confianca`
// por ordem. "Ignore redação/estilo e tamanho" não é mais incondicional: a
// instrução vai nas regras de cada pedido e só aparece quando a rubrica NÃO
// tem critério de forma (`styleRuleFor`). ⚠️ Mudança de CONTRATO — o hash do
// juiz muda (IMPL-049); executar ANTES de qualquer calibração.
export const DUEL_HEAD = `Você é um juiz técnico estrito decidindo um DUELO DIRETO entre DUAS respostas candidatas para a MESMA tarefa. A RESPOSTA DE REFERÊNCIA é CANDIDATA: foi gerada por outro modelo e PODE ESTAR ERRADA — use-a como apoio, nunca como gabarito inquestionável. A RUBRICA (critério de corretude) da etapa tem prioridade sobre a referência: se a referência contrariar a rubrica, SIGA A RUBRICA. Decida qual candidato alcança melhor o resultado e a intenção exigidos. Os rótulos A/B são neutros e a ordem não significa nada. ${DATA_BLOCKS_NOTICE} Responda APENAS com um objeto JSON {"canario": "<o CANÁRIO das INSTRUÇÕES>", "explanation": "<uma frase curta>", "winner": "A"|"B"|"tie", "confianca": "baixa"|"media"|"alta"} — "tie" SOMENTE quando ambos alcançam resultado genuinamente equivalente (ou falham igualmente); "confianca" diz quão seguro está o voto ("baixa" = merece revisão humana).`;

/** Saída do juiz de duelo — JSON Schema `strict` (response_format + bloco INSTRUÇÕES). */
export const DUEL_SCHEMA: Record<string, unknown> = strictObjectSchema({
  canario: { type: 'string' },
  explanation: { type: 'string' },
  winner: { type: 'string', enum: ['A', 'B', 'tie'] },
  confianca: { type: 'string', enum: ['baixa', 'media', 'alta'] },
});

/**
 * Contrato em zod ESTRITO (campo a mais, valor fora do enum => invalido).
 * `confianca` é PEDIDA no contrato (JSON Schema acima) mas aceita sem presença
 * no parse (IMPL-047, mesma decisão do pointwise): a ordem não é rejeitada
 * inteira só porque o juiz omitiu a auto-confiança.
 */
const duelReplySchema = z
  .object({
    canario: z.string(),
    explanation: z.string(),
    winner: z.enum(['A', 'B', 'tie']),
    confianca: z.enum(['baixa', 'media', 'alta']).optional(),
  })
  .strict();

export interface DuelPrompt {
  system: string;
  user: string;
  guard: JudgeGuard;
  formatReminder: string;
}

/**
 * Prompt de UMA ordem do duelo: referência, pergunta, rubrica e os candidatos
 * A/B, cada um num bloco marcado com o código sorteado AGORA.
 */
export function buildDuelPrompt(stage: StageSpec, reference: string, textA: string, textB: string): DuelPrompt {
  const rubric = stage.rubric?.trim();
  const a = textA || '(vazio)';
  const b = textB || '(vazio)';
  const guard = newJudgeGuard([reference, stage.question, rubric ?? '', a, b]);
  const partes = [
    'REFERÊNCIA (resposta CANDIDATA de outro modelo — pode estar errada):',
    markedBlock('REFERÊNCIA', guard.nonce, reference),
    'PERGUNTA DO USUÁRIO:',
    markedBlock('PERGUNTA', guard.nonce, stage.question),
  ];
  if (rubric) partes.push('RUBRICA DA ETAPA (critério de corretude — tem prioridade):', markedBlock('RUBRICA', guard.nonce, rubric));
  partes.push(
    'Candidato A:',
    markedBlock('CANDIDATO A', guard.nonce, a),
    'Candidato B:',
    markedBlock('CANDIDATO B', guard.nonce, b),
    instructionsBlock({
      guard,
      candidateLabels: ['CANDIDATO A', 'CANDIDATO B'],
      rules: [
        // IMPL-047: referência é APOIO, não gabarito; a rubrica manda.
        'A REFERÊNCIA é candidata e pode estar errada; quando houver RUBRICA, ela tem prioridade — se a referência contrariar a rubrica, siga a rubrica.',
        'Qual candidato alcança melhor o resultado e a intenção exigidos — "A", "B" ou "tie"? Escreva "explanation" (uma frase curta) ANTES de decidir "winner", e devolva "confianca" ("baixa"|"media"|"alta") no mesmo JSON — "baixa" sinaliza que o voto merece revisão humana.',
        // IMPL-047: "ignore estilo" condicionado à rubrica (critério de forma conta quando existe).
        styleRuleFor(rubric),
      ],
      outputSchema: DUEL_SCHEMA,
    }),
  );
  return {
    system: DUEL_HEAD,
    user: partes.join('\n\n'),
    guard,
    formatReminder: formatReminderFor(guard, DUEL_SCHEMA),
  };
}

/**
 * Parse ESTRITO da resposta do duelo: o texto INTEIRO é um objeto JSON com
 * `winner` em A|B|tie e o canário DESTA ordem. Sem normalização ("empate",
 * minúsculas) e sem recorte de `{…}` no meio do texto (IMPL-006). `confianca`
 * (IMPL-047) volta junto quando o juiz a devolve.
 */
export function parseDuelVerdict(
  text: string,
  canary: string,
): { winner: 'A' | 'B' | 'tie'; explanation: string; canary: string; confianca?: JudgeConfidence } | null {
  const p = parseStrictJudgeJson(text, duelReplySchema, canary);
  if (!p) return null;
  return {
    winner: p.winner,
    explanation: p.explanation.trim().slice(0, 300),
    canary: p.canario,
    ...(p.confianca ? { confianca: p.confianca } : {}),
  };
}
