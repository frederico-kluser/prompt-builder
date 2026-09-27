// Prompt e parse do juiz de DUELO (IMPL-006, R-03b:REC-3) — fonte ÚNICA para
// `src/duels.ts` e o espelho `web/src/engine/duels.ts` (antes cada lado tinha a
// sua cópia, e já divergiam no rótulo "(dossiê)"). Puro e sem Node.
//
// Cada ORDEM de um duelo é um veredito: sorteia marcador + canário próprios,
// os dois candidatos entram escapados em blocos marcados e o bloco INSTRUÇÕES
// fecha o prompt. Saída: JSON estrito com o canário; qualquer desvio => `null`
// (a ordem fica SEM resultado e o duelo vai para `failedDuels`, nunca empate).

import { z } from 'zod';
import type { StageSpec } from '../types.js';
import {
  DATA_BLOCKS_NOTICE,
  formatReminderFor,
  instructionsBlock,
  markedBlock,
  newJudgeGuard,
  parseStrictJudgeJson,
  strictObjectSchema,
  type JudgeGuard,
} from './judgeGuard.js';

// Head do prompt de duelo — fixa o contrato do veredito head-to-head (portado).
export const DUEL_HEAD = `Você é um juiz técnico estrito decidindo um DUELO DIRETO entre DUAS respostas candidatas para a MESMA tarefa. Um modelo mais forte já produziu a RESPOSTA DE REFERÊNCIA (correta). Decida qual candidato alcança melhor o MESMO resultado e intenção da referência; ignore redação, estilo e tamanho. Os rótulos A/B são neutros e a ordem não significa nada. ${DATA_BLOCKS_NOTICE} Responda APENAS com um objeto JSON {"canario": "<o CANÁRIO das INSTRUÇÕES>", "explanation": "<uma frase curta>", "winner": "A"|"B"|"tie"} — "tie" SOMENTE quando ambos alcançam resultado genuinamente equivalente (ou falham igualmente).`;

/** Saída do juiz de duelo — JSON Schema `strict` (response_format + bloco INSTRUÇÕES). */
export const DUEL_SCHEMA: Record<string, unknown> = strictObjectSchema({
  canario: { type: 'string' },
  explanation: { type: 'string' },
  winner: { type: 'string', enum: ['A', 'B', 'tie'] },
});

const duelReplySchema = z
  .object({
    canario: z.string(),
    explanation: z.string(),
    winner: z.enum(['A', 'B', 'tie']),
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
    'REFERÊNCIA (resposta correta):',
    markedBlock('REFERÊNCIA', guard.nonce, reference),
    'PERGUNTA DO USUÁRIO:',
    markedBlock('PERGUNTA', guard.nonce, stage.question),
  ];
  if (rubric) partes.push('RUBRICA DA ETAPA (critério de corretude):', markedBlock('RUBRICA', guard.nonce, rubric));
  partes.push(
    'Candidato A:',
    markedBlock('CANDIDATO A', guard.nonce, a),
    'Candidato B:',
    markedBlock('CANDIDATO B', guard.nonce, b),
    instructionsBlock({
      guard,
      candidateLabels: ['CANDIDATO A', 'CANDIDATO B'],
      rules: [
        'Qual candidato alcança melhor o resultado e a intenção da referência — "A", "B" ou "tie"? Escreva "explanation" (uma frase curta) ANTES de decidir "winner".',
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
 * minúsculas) e sem recorte de `{…}` no meio do texto (IMPL-006).
 */
export function parseDuelVerdict(
  text: string,
  canary: string,
): { winner: 'A' | 'B' | 'tie'; explanation: string; canary: string } | null {
  const p = parseStrictJudgeJson(text, duelReplySchema, canary);
  if (!p) return null;
  return { winner: p.winner, explanation: p.explanation.trim().slice(0, 300), canary: p.canario };
}
