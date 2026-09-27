import { chatCompletion } from './openrouter.js';
import { matchExpected } from './engine/groundTruth.js';
import { callJudgeWithRetry, withReminder } from './engine/judgeRetry.js';
import { unjudgeableReason } from './engine/verdictIntegrity.js';
import { aggregateVerdicts, tieLabel } from './engine/verdictAggregate.js';
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

// Head portado do prompt-arena (fixa o contrato de veredito JSON).
const SYSTEM_PROMPT = `Você é um juiz técnico estrito. Um modelo mais forte já produziu a RESPOSTA DE REFERÊNCIA (correta). Compare o CANDIDATO com ela. Ignore redação/estilo — julgue se o candidato alcança o MESMO resultado e intenção. Responda APENAS com um objeto JSON {"verdict": "resolve"|"parcial"|"nao", "explanation": "<uma frase curta em pt-BR>"} onde resolve = corresponde plenamente à referência, parcial = parcialmente/impreciso/faltando parte, nao = errado ou fez outra coisa.`;

/**
 * O CONTRATO do juiz pointwise (F4.2): o texto fixo que define a escala de
 * veredito. Vai hasheado no record (`judgeDiagnostics.contract`) para o
 * calibration drift aparecer — mesma rúbrica com juiz/contrato diferente
 * quebra comparacao entre sessoes.
 */
export const JUDGE_CONTRACT_TEXT = SYSTEM_PROMPT;

/** Lembrete anexado ao 2o pedido depois de uma saida fora do contrato. */
const FORMAT_REMINDER =
  'LEMBRETE DE FORMATO: a resposta anterior não seguiu o contrato. Responda APENAS com um objeto JSON ' +
  '{"verdict": "resolve"|"parcial"|"nao", "explanation": "<uma frase curta em pt-BR>"} — sem markdown e sem texto antes ou depois.';

// Agregacao do painel: MAIORIA SIMPLES em `engine/verdictAggregate.ts`
// (IMPL-007) — a media ordinal local arredondava painel dividido PARA CIMA.

/** Recorta o objeto JSON da resposta do juiz (tolera texto em volta). */
function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

/**
 * Parse ESTRITO do veredito: objeto JSON com `verdict` em resolve|parcial|nao.
 * Qualquer outra coisa devolve `null` (saida invalida): quem chama pede UMA
 * vez de novo com lembrete de formato e, persistindo, registra o veredito como
 * AUSENTE (`invalid_output`). O antigo fallback por regex ("1a ocorrencia de
 * parcial/nao/resolve no texto cru; lixo => 'parcial'") foi removido: ele
 * transformava falha de formato em nota.
 */
function parseJudgeReply(text: string): { verdict: Verdict; explanation: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const p = parsed as { verdict?: unknown; explanation?: unknown };
  const raw = typeof p.verdict === 'string' ? p.verdict.trim().toLowerCase() : '';
  const verdict = raw === 'não' ? 'nao' : raw;
  if (verdict !== 'resolve' && verdict !== 'parcial' && verdict !== 'nao') return null;
  const explanation =
    typeof p.explanation === 'string' && p.explanation.trim()
      ? p.explanation.trim()
      : '(veredito do juiz de referência)';
  return { verdict, explanation };
}

/** Prompt do usuario: referencia no topo, pergunta, rubrica (prioritaria) e candidato. */
function buildUserPrompt(stage: StageSpec, reference: string, candidateText: string): string {
  const rubric = stage.rubric?.trim();
  let prompt = `REFERÊNCIA (resposta correta):\n${reference}\n\nPERGUNTA:\n${stage.question}`;
  if (rubric) {
    prompt += `\n\nCRITÉRIO DE CORRETUDE DESTA ETAPA (tem prioridade):\n${rubric}`;
  }
  prompt += `\n\nCANDIDATO:\n${candidateText}`;
  return prompt;
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
  | { ok: true; judgeModelId: string; contestantId: string; verdict: Verdict; explanation: string }
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
  const userPrompt = buildUserPrompt(stage, reference, response.text);
  const attempt = await callJudgeWithRetry({
    call: async (reminder) =>
      (
        await chatCompletion({
          apiKey,
          modelId: judgeModelId,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: withReminder(userPrompt, reminder) },
          ],
          temperature: 0,
          maxTokens: 1024,
          responseFormatJson: true,
          reasoningLevel,
          timeoutMs,
          role: 'judge',
          signal: ctx?.signal,
          sink: ctx?.sink,
          maxPricePerMTok,
        })
      ).text,
    parse: parseJudgeReply,
    formatReminder: FORMAT_REMINDER,
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
  const result = (inconclusive?: boolean): ReferenceJudgeResult => ({
    verdictByContestant,
    explanationByContestant,
    verdictSourceByContestant,
    verdictErrorByContestant,
    ...(Object.keys(verdictTieByContestant).length > 0 ? { verdictTieByContestant } : {}),
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
    // Painel reduzido: o veredito existe, mas vale menos — conta na regra de
    // run inconclusiva como 'degradado' (R-03b:REC-4).
    verdictSourceByContestant[r.contestantId] = oks.length < vs.length ? 'degraded' : 'judge';
  }

  // Nenhum veredito de juiz na etapa inteira: a etapa nao pontua no placar.
  return result(!algumVeredito);
}
