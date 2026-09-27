import { z } from 'zod';
import { chatCompletion } from './openrouter.js';
import { ROLE_MAX_TOKENS } from './roleLimits.js';
import { matchExpected } from './engine/groundTruth.js';
import { callJudgeWithRetry, withReminder } from './engine/judgeRetry.js';
import { unjudgeableReason } from './engine/verdictIntegrity.js';
import { aggregateVerdicts, tieLabel } from './engine/verdictAggregate.js';
import {
  DATA_BLOCKS_NOTICE,
  formatReminderFor,
  instructionsBlock,
  markedBlock,
  newJudgeGuard,
  parseStrictJudgeJson,
  strictObjectSchema,
  type JudgeGuard,
} from './engine/judgeGuard.js';
import type {
  CompetitorResponse,
  Contestant,
  ReasoningLevel,
  ReferenceJudgeResult,
  StageSpec,
  Verdict,
  VerdictError,
  VerdictSource,
  RunCtx,
} from './types.js';

// Juiz POINTWISE contra o gabarito (`StageSpec.reference`), portado do
// referenceJudge.mjs do prompt-arena (vocabulario local: resolve/parcial/nao).
// Cada resposta e classificada ISOLADAMENTE contra a referencia — sem comparar
// contestants entre si (isso e papel dos duelos). E a base do judge-score.
//
// Falha NAO e veredito (IMPL-004, R-03b:REC-4). Degrada sem derrubar a run,
// mas NUNCA imputa nota: juiz que falhou, saida invalida apos o lembrete,
// timeout apos a 2a chance, cenario sem gabarito, competidor com erro de infra
// ou bloqueado => a chave do contestant fica AUSENTE de `verdictByContestant`
// e o motivo vai em `verdictErrorByContestant`. Antes tudo isso virava
// 'parcial' — nota inventada que entrava nas medias e nas licoes do treino.
// So a resposta `ok` VAZIA vira 'nao' automatico (fonte 'auto'): nao responder
// e uma falha legitima do candidato, nao do pipeline.

// Head portado do prompt-arena (fixa o contrato de veredito JSON). IMPL-006:
// + aviso dos blocos marcados e o campo `canario`; o schema exato da saida vai
// no bloco INSTRUCOES de cada chamada (e em `response_format`, quando o
// catalogo permite).
const SYSTEM_PROMPT = `Você é um juiz técnico estrito. Um modelo mais forte já produziu a RESPOSTA DE REFERÊNCIA (correta). Compare o CANDIDATO com ela. Ignore redação/estilo — julgue se o candidato alcança o MESMO resultado e intenção. ${DATA_BLOCKS_NOTICE} Responda APENAS com um objeto JSON {"canario": "<o CANÁRIO das INSTRUÇÕES>", "explanation": "<uma frase curta em pt-BR>", "verdict": "resolve"|"parcial"|"nao"} onde resolve = corresponde plenamente à referência, parcial = parcialmente/impreciso/faltando parte, nao = errado ou fez outra coisa.`;

/**
 * O CONTRATO do juiz pointwise (F4.2): o texto fixo que define a escala de
 * veredito. Vai hasheado no record (`judgeDiagnostics.contract`) para o
 * calibration drift aparecer — mesma rúbrica com juiz/contrato diferente
 * quebra comparacao entre sessoes.
 */
export const JUDGE_CONTRACT_TEXT = SYSTEM_PROMPT;

// Formato: o lembrete do 2o pedido e POR VEREDITO (`formatReminderFor`, com o
// canario e o schema — IMPL-006). Agregacao do painel: MAIORIA SIMPLES em
// `engine/verdictAggregate.ts` (IMPL-007) — a media ordinal local arredondava
// painel dividido PARA CIMA.

/** Saida do juiz pointwise — JSON Schema `strict` (response_format + bloco INSTRUCOES). */
export const REFERENCE_JUDGE_SCHEMA: Record<string, unknown> = strictObjectSchema({
  canario: { type: 'string' },
  explanation: { type: 'string' },
  verdict: { type: 'string', enum: ['resolve', 'parcial', 'nao'] },
});

/** O mesmo contrato em zod ESTRITO (campo a mais, valor fora do enum => invalido). */
const referenceReplySchema = z
  .object({
    canario: z.string(),
    explanation: z.string(),
    verdict: z.enum(['resolve', 'parcial', 'nao']),
  })
  .strict();

/**
 * Parse ESTRITO do veredito (IMPL-006): o texto INTEIRO e um objeto JSON no
 * schema, com o canario DESTE veredito. Qualquer outra coisa devolve `null`
 * (saida invalida): quem chama pede UMA vez de novo com lembrete de formato e,
 * persistindo, registra o veredito como AUSENTE (`invalid_output`). Sem
 * recorte de `{...}` no meio do texto nem normalizacao ('Resolve', 'não'):
 * o recorte deixava um JSON forjado pelo candidato virar veredito.
 */
export function parseJudgeReply(
  text: string,
  canary: string,
): { verdict: Verdict; explanation: string; canary: string } | null {
  const p = parseStrictJudgeJson(text, referenceReplySchema, canary);
  if (!p) return null;
  return {
    verdict: p.verdict,
    explanation: p.explanation.trim() || '(veredito do juiz de referência)',
    canary: p.canario,
  };
}

/** Prompt montado de UM veredito pointwise (marcador + canario mudam a cada chamada). */
export interface ReferenceJudgePrompt {
  system: string;
  user: string;
  guard: JudgeGuard;
  formatReminder: string;
}

/**
 * Prompt do usuario (IMPL-006): referencia, pergunta, rubrica (prioritaria) e
 * candidato, CADA UM num bloco marcado com o codigo sorteado para ESTE
 * veredito, e o bloco INSTRUCOES anti-injecao por ultimo. O texto do candidato
 * so aparece escapado e dentro de `⟦CANDIDATO·codigo⟧ … ⟦/CANDIDATO·codigo⟧`.
 */
export function buildReferenceJudgePrompt(
  stage: StageSpec,
  reference: string,
  candidateText: string,
): ReferenceJudgePrompt {
  const rubric = stage.rubric?.trim();
  const guard = newJudgeGuard([reference, stage.question, rubric ?? '', candidateText]);
  const partes = [
    'REFERÊNCIA (resposta correta):',
    markedBlock('REFERÊNCIA', guard.nonce, reference),
    'PERGUNTA:',
    markedBlock('PERGUNTA', guard.nonce, stage.question),
  ];
  if (rubric) {
    partes.push('CRITÉRIO DE CORRETUDE DESTA ETAPA (tem prioridade):', markedBlock('CRITÉRIO', guard.nonce, rubric));
  }
  partes.push(
    'CANDIDATO (resposta a julgar):',
    markedBlock('CANDIDATO', guard.nonce, candidateText),
    instructionsBlock({
      guard,
      candidateLabels: ['CANDIDATO'],
      rules: [
        'Compare o CANDIDATO com a REFERÊNCIA; quando houver CRITÉRIO DE CORRETUDE, ele tem prioridade sobre a referência.',
        '"verdict": resolve = corresponde plenamente; parcial = parcialmente/impreciso/faltando parte; nao = errado ou fez outra coisa. Escreva "explanation" (uma frase curta em pt-BR) ANTES de decidir o veredito.',
      ],
      outputSchema: REFERENCE_JUDGE_SCHEMA,
    }),
  );
  return {
    system: SYSTEM_PROMPT,
    user: partes.join('\n\n'),
    guard,
    formatReminder: formatReminderFor(guard, REFERENCE_JUDGE_SCHEMA),
  };
}

export interface JudgeStageReferenceParams {
  stage: StageSpec;
  responses: CompetitorResponse[];
  /** Fonte de verdade da lista de contestants (cobre quem ficou sem resposta). */
  contestants: Contestant[];
  /** Um ou mais juizes — 1 chamada por (juiz x competidor), todas em paralelo. */
  judgeModelIds: string[];
  apiKey: string;
  reasoningLevel?: ReasoningLevel;
  timeoutMs?: number;
  /** Sinal de abort + ledger de custo. */
  ctx?: RunCtx;
  maxPricePerMTok?: { prompt?: number; completion?: number };
}

type SingleVerdict =
  | { ok: true; judgeModelId: string; contestantId: string; verdict: Verdict; explanation: string; canary: string }
  | { ok: false; judgeModelId: string; contestantId: string; error: VerdictError };

/**
 * UM juiz avaliando UMA resposta contra a referencia, com a re-tentativa
 * SELETIVA de `judgeRetry` (timeout 1x; saida invalida => 1 pedido com
 * lembrete). Nunca lanca erro comum: falha volta como `{ ok: false, error }`.
 * `BudgetExceeded`/`RunCancelled` sobem (controle, nao erro).
 */
async function judgeOne(params: {
  apiKey: string;
  judgeModelId: string;
  stage: StageSpec;
  reference: string;
  response: CompetitorResponse;
  reasoningLevel?: ReasoningLevel;
  timeoutMs: number;
  ctx?: RunCtx;
  maxPricePerMTok?: { prompt?: number; completion?: number };
}): Promise<SingleVerdict> {
  const { apiKey, judgeModelId, stage, reference, response, reasoningLevel, timeoutMs, ctx, maxPricePerMTok } =
    params;
  // Marcador + canario sorteados AQUI: um par novo por veredito (as
  // re-tentativas do MESMO veredito reusam o par).
  const prompt = buildReferenceJudgePrompt(stage, reference, response.text);
  const attempt = await callJudgeWithRetry({
    call: async (reminder) =>
      (
        await chatCompletion({
          apiKey,
          modelId: judgeModelId,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: withReminder(prompt.user, reminder) },
          ],
          temperature: 0,
          // Teto TOTAL com sala p/ raciocinio (IMPL-016): 1024 virava `length` vazio.
          maxTokens: ROLE_MAX_TOKENS.judge,
          responseFormatJson: true,
          responseSchema: { name: 'veredito_pointwise', schema: REFERENCE_JUDGE_SCHEMA },
          reasoningLevel,
          timeoutMs,
          role: 'judge',
          signal: ctx?.signal,
          sink: ctx?.sink,
          maxPricePerMTok,
        })
      ).text,
    parse: (text) => parseJudgeReply(text, prompt.guard.canary),
    formatReminder: prompt.formatReminder,
    signal: ctx?.signal,
  });
  if (!attempt.ok) {
    return { ok: false, judgeModelId, contestantId: response.contestantId, error: attempt.error };
  }
  return { ok: true, judgeModelId, contestantId: response.contestantId, ...attempt.value };
}

/**
 * Julga TODAS as respostas de uma etapa contra o gabarito (`stage.reference`),
 * pointwise. Multi-juiz: cada juiz vota por competidor e o veredito agregado e
 * a MAIORIA SIMPLES dos votos LEGITIMOS (IMPL-007); sem maioria clara =>
 * EMPATE TECNICO (`verdictTieByContestant`), gravado com o nivel que a maioria
 * endossa — nunca o voto de cima. Painel reduzido (parte dos juizes falhou) =>
 * fonte 'degraded'; nenhum voto => veredito AUSENTE com o motivo. A explanation
 * agregada vem de um juiz que votou EXATAMENTE o veredito agregado (em empate,
 * nunca do juiz que deu o voto mais alto).
 */
export async function judgeStageReference(
  opts: JudgeStageReferenceParams,
): Promise<ReferenceJudgeResult> {
  const { stage, responses, contestants, apiKey, reasoningLevel, ctx, maxPricePerMTok } = opts;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  // dedup: um mesmo juiz duas vezes votaria dobrado na maioria.
  const judgeIds = [...new Set(opts.judgeModelIds ?? [])];
  const judgeModelId = judgeIds.join('+');

  const verdictByContestant: Record<string, Verdict> = {};
  const explanationByContestant: Record<string, string> = {};
  const verdictSourceByContestant: Record<string, VerdictSource> = {};
  const verdictErrorByContestant: Record<string, VerdictError> = {};
  const verdictTieByContestant: Record<string, Verdict[]> = {};
  // IMPL-006: o canario de CADA voto legitimo (1 por juiz), registrado.
  const canaryByContestant: Record<string, string[]> = {};
  const result = (inconclusive?: boolean): ReferenceJudgeResult => ({
    verdictByContestant,
    explanationByContestant,
    verdictSourceByContestant,
    verdictErrorByContestant,
    ...(Object.keys(verdictTieByContestant).length > 0 ? { verdictTieByContestant } : {}),
    ...(Object.keys(canaryByContestant).length > 0 ? { canaryByContestant } : {}),
    judgeModelId,
    ...(inconclusive ? { inconclusive: true } : {}),
  });

  // `contestants` e a fonte de verdade da lista; respostas com id desconhecido
  // entram ao fim (defensivo — o pipeline passa as duas listas alinhadas).
  const byContestant = new Map(responses.map((r) => [r.contestantId, r]));
  const orderedIds = contestants.map((c) => c.id);
  const known = new Set(orderedIds);
  for (const r of responses) {
    if (!known.has(r.contestantId)) {
      known.add(r.contestantId);
      orderedIds.push(r.contestantId);
    }
  }

  // Regra de origem (CONVENTIONS): sem resposta/erro de infra/bloqueio =>
  // SEM veredito (motivo registrado); resposta vazia => 'nao' automatico.
  const judgeable: CompetitorResponse[] = [];
  for (const id of orderedIds) {
    const r = byContestant.get(id);
    const semVeredito = unjudgeableReason(r);
    if (semVeredito) {
      verdictErrorByContestant[id] = semVeredito;
    } else if (r!.text.trim().length === 0) {
      verdictByContestant[id] = 'nao';
      explanationByContestant[id] = 'Resposta vazia (veredito automático).';
      verdictSourceByContestant[id] = 'auto';
    } else {
      judgeable.push(r!);
    }
  }

  // F1.4 (PLANO-PARIDADE P0.5): rótulo ESPERADO ⇒ veredito DETERMINÍSTICO,
  // sem gastar LLM — "quando existe determinístico, ele manda" (mesmo
  // princípio do oráculo do Agent Arena). `judgeModelId` vira o marcador
  // 'ground-truth' para o registro mostrar que NENHUM juiz LLM opinou.
  if (stage.expected !== undefined) {
    for (const r of judgeable) {
      // Verificador ESTRITO (IMPL-003): o labelSet da etapa deixa a lista de
      // rótulos/hesitação ("positivo | negativo") visível — sem ele só a
      // negação/hesitação sobre o próprio rótulo é detectada.
      const gt = matchExpected(r.text, stage.expected, { labelSet: stage.labelSet });
      verdictByContestant[r.contestantId] = gt.verdict;
      explanationByContestant[r.contestantId] = gt.explanation;
      verdictSourceByContestant[r.contestantId] = 'ground-truth';
    }
    return { ...result(), judgeModelId: 'ground-truth' };
  }

  if (judgeable.length === 0) return result(true);

  const reference = stage.reference?.trim() ?? '';
  // Sem gabarito ou sem juiz => sem régua: NENHUM veredito (antes: 'parcial'
  // para todos, zero chamadas — a nota mais perigosa, porque parecia neutra).
  if (!reference || judgeIds.length === 0) {
    const error: VerdictError = !reference
      ? { kind: 'no_reference', message: 'Cenário sem gabarito — o juiz pointwise não tem régua.' }
      : { kind: 'judge_failed', message: 'Nenhum juiz configurado.' };
    for (const r of judgeable) verdictErrorByContestant[r.contestantId] = error;
    return result(true);
  }

  // UMA chamada por (juiz x competidor), TODAS em paralelo — sem cap local;
  // o limitador global de openrouter.ts gateia.
  const singles = await Promise.all(
    judgeIds.flatMap((jid) =>
      judgeable.map((r) =>
        judgeOne({
          apiKey,
          judgeModelId: jid,
          stage,
          reference,
          response: r,
          reasoningLevel,
          timeoutMs,
          ctx,
          maxPricePerMTok,
        }),
      ),
    ),
  );

  let algumVeredito = false;
  for (const r of judgeable) {
    const vs = singles.filter((s) => s.contestantId === r.contestantId);
    const oks = vs.filter((s): s is Extract<SingleVerdict, { ok: true }> => s.ok);
    if (oks.length === 0) {
      const falha = vs.find((s): s is Extract<SingleVerdict, { ok: false }> => !s.ok);
      const error = falha?.error ?? { kind: 'judge_failed' as const, message: 'Juiz sem resposta.' };
      verdictErrorByContestant[r.contestantId] =
        judgeIds.length > 1 ? { ...error, message: `${falha?.judgeModelId}: ${error.message}` } : error;
      continue;
    }
    algumVeredito = true;
    const agg = aggregateVerdicts(oks.map((v) => v.verdict))!;
    verdictByContestant[r.contestantId] = agg.verdict;
    // O veredito agregado e sempre um dos votos (mediana inferior): a explanation
    // vem de quem votou ELE — nunca do juiz que deu o voto inflado.
    const autor = oks.find((v) => v.verdict === agg.verdict)!;
    explanationByContestant[r.contestantId] = agg.tie
      ? `${tieLabel(agg.votes)}: ${autor.explanation}`
      : autor.explanation;
    if (agg.tie) verdictTieByContestant[r.contestantId] = agg.votes;
    canaryByContestant[r.contestantId] = oks.map((v) => v.canary);
    // Painel reduzido: o veredito existe, mas vale menos — conta na regra de
    // run inconclusiva como 'degradado' (R-03b:REC-4).
    verdictSourceByContestant[r.contestantId] = oks.length < vs.length ? 'degraded' : 'judge';
  }

  // Nenhum veredito de juiz na etapa inteira: a etapa nao pontua no placar.
  return result(!algumVeredito);
}
