import { chatCompletion } from './openrouter.js';
import { isControlSignal } from './budget.js';
import { matchExpected } from './engine/groundTruth.js';
import type {
  CompetitorResponse,
  Contestant,
  ReasoningLevel,
  ReferenceJudgeResult,
  StageSpec,
  Verdict, RunCtx } from './types.js';

// Juiz POINTWISE contra o gabarito (`StageSpec.reference`), portado do
// referenceJudge.mjs do prompt-arena (vocabulario local: resolve/parcial/nao).
// Cada resposta e classificada ISOLADAMENTE contra a referencia — sem comparar
// contestants entre si (isso e papel dos duelos). E a base do judge-score.
// Degrada, NUNCA derruba a run: sem referencia => 'parcial' p/ todos; resposta
// com erro/vazia => 'nao' automatico (sem gastar LLM); chamada que falha =>
// 'parcial' com a mensagem de erro na explanation.

// Head portado do prompt-arena (fixa o contrato de veredito JSON).
const SYSTEM_PROMPT = `Você é um juiz técnico estrito. Um modelo mais forte já produziu a RESPOSTA DE REFERÊNCIA (correta). Compare o CANDIDATO com ela. Ignore redação/estilo — julgue se o candidato alcança o MESMO resultado e intenção. Responda APENAS com um objeto JSON {"verdict": "resolve"|"parcial"|"nao", "explanation": "<uma frase curta em pt-BR>"} onde resolve = corresponde plenamente à referência, parcial = parcialmente/impreciso/faltando parte, nao = errado ou fez outra coisa.`;

/**
 * O CONTRATO do juiz pointwise (F4.2): o texto fixo que define a escala de
 * veredito. Vai hasheado no record (`judgeDiagnostics.contract`) para o
 * calibration drift aparecer — mesma rúbrica com juiz/contrato diferente
 * quebra comparacao entre sessoes.
 */
export const JUDGE_CONTRACT_TEXT = SYSTEM_PROMPT;

const VERDICT_ORDINAL: Record<Verdict, number> = { nao: 0, parcial: 1, resolve: 2 };

/**
 * Agrega vereditos ternarios por media ordinal (resolve=2, parcial=1, nao=0;
 * media >= 1.5 => resolve, >= 0.5 => parcial, senao nao). Copia LOCAL de
 * `aggregateVerdict` de judge.ts (la nao e exportado) — manter sincronizado.
 */
function aggregateVerdict(verdicts: Verdict[]): Verdict {
  if (verdicts.length === 0) return 'parcial';
  const avg = verdicts.reduce((s, v) => s + VERDICT_ORDINAL[v], 0) / verdicts.length;
  if (avg >= 1.5) return 'resolve';
  if (avg >= 0.5) return 'parcial';
  return 'nao';
}

/** Recorta o objeto JSON da resposta do juiz (tolera texto em volta). */
function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

/** Fallback regex: 1a ocorrencia de resolve|parcial|nao no texto cru. */
function verdictFromText(text: string): Verdict {
  const lower = text.toLowerCase();
  // ORDEM IMPORTA: 'parcial' e 'nao' ANTES de 'resolve' — um texto como
  // "não resolve o problema" contem "resolve" como substring e NAO pode
  // virar 'resolve'.
  if (lower.includes('parcial')) return 'parcial';
  if (/n[aã]o/.test(lower)) return 'nao';
  if (lower.includes('resolve')) return 'resolve';
  return 'parcial'; // lixo => neutro
}

/** Parse tolerante do veredito: JSON primeiro; regex como fallback; lixo => 'parcial'. */
function parseJudgeReply(text: string): { verdict: Verdict; explanation: string } {
  try {
    const parsed = JSON.parse(extractJson(text)) as {
      verdict?: unknown;
      explanation?: unknown;
    };
    const raw = typeof parsed.verdict === 'string' ? parsed.verdict.trim().toLowerCase() : '';
    const verdict = raw === 'não' ? 'nao' : raw;
    if (verdict === 'resolve' || verdict === 'parcial' || verdict === 'nao') {
      const explanation =
        typeof parsed.explanation === 'string' && parsed.explanation.trim()
          ? parsed.explanation.trim()
          : '(veredito do juiz de referência)';
      return { verdict, explanation };
    }
  } catch {
    // JSON invalido — cai no fallback regex abaixo.
  }
  return { verdict: verdictFromText(text), explanation: '(veredito do juiz de referência)' };
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

interface SingleVerdict {
  judgeModelId: string;
  contestantId: string;
  verdict: Verdict;
  explanation: string;
}

/** UM juiz avaliando UMA resposta contra a referencia. NUNCA lanca: erro => 'parcial'. */
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
  try {
    const result = await chatCompletion({
      apiKey,
      modelId: judgeModelId,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(stage, reference, response.text) },
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
    });
    const parsed = parseJudgeReply(result.text);
    return { judgeModelId, contestantId: response.contestantId, ...parsed };
  } catch (err) {
    // ESTE e o catch mais perigoso do repositorio: sem o rethrow, um estouro de
    // orcamento viraria veredito 'parcial' em TODO competidor e a run sairia
    // "concluida" com notas inventadas. Sinal de controle sobe.
    if (isControlSignal(err)) throw err;
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 160);
    return {
      judgeModelId,
      contestantId: response.contestantId,
      verdict: 'parcial',
      explanation: `Juiz de referência falhou: ${msg}`,
    };
  }
}

/**
 * Julga TODAS as respostas de uma etapa contra o gabarito (`stage.reference`),
 * pointwise. Multi-juiz: cada juiz vota por competidor e o veredito agregado e
 * a media ordinal; a explanation agregada e a do 1o juiz que deu o veredito
 * agregado (fallback: a do 1o juiz).
 */
export async function judgeStageReference(
  opts: JudgeStageReferenceParams,
): Promise<ReferenceJudgeResult> {
  const { stage, responses, contestants, apiKey, reasoningLevel, ctx, maxPricePerMTok } = opts;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  // dedup: um mesmo juiz duas vezes distorceria a media ordinal.
  const judgeIds = [...new Set(opts.judgeModelIds ?? [])];
  const judgeModelId = judgeIds.join('+');

  const verdictByContestant: Record<string, Verdict> = {};
  const explanationByContestant: Record<string, string> = {};

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

  // Resposta ausente/com erro/vazia => 'nao' AUTOMATICO (sem gastar LLM).
  const judgeable: CompetitorResponse[] = [];
  for (const id of orderedIds) {
    const r = byContestant.get(id);
    if (!r) {
      verdictByContestant[id] = 'nao';
      explanationByContestant[id] = 'Sem resposta registrada nesta etapa.';
    } else if (r.status !== 'ok' || r.text.trim().length === 0) {
      verdictByContestant[id] = 'nao';
      explanationByContestant[id] = 'Resposta com erro ou vazia (veredito automático).';
    } else {
      judgeable.push(r);
    }
  }

  // F1.4 (PLANO-PARIDADE P0.5): rótulo ESPERADO ⇒ veredito DETERMINÍSTICO,
  // sem gastar LLM — "quando existe determinístico, ele manda" (mesmo
  // princípio do oráculo do Agent Arena). `judgeModelId` vira o marcador
  // 'ground-truth' para o registro mostrar que NENHUM juiz LLM opinou.
  if (stage.expected !== undefined) {
    for (const r of judgeable) {
      const gt = matchExpected(r.text, stage.expected);
      verdictByContestant[r.contestantId] = gt.verdict;
      explanationByContestant[r.contestantId] = gt.explanation;
    }
    return { verdictByContestant, explanationByContestant, judgeModelId: 'ground-truth' };
  }

  const reference = stage.reference?.trim() ?? '';

  // Sem gabarito => degrada TODOS os julgaveis p/ 'parcial', zero chamadas LLM.
  if (!reference) {
    for (const r of judgeable) {
      verdictByContestant[r.contestantId] = 'parcial';
      explanationByContestant[r.contestantId] = '(sem referência para este cenário)';
    }
    return {
      verdictByContestant,
      explanationByContestant,
      judgeModelId,
      inconclusive: judgeIds.length === 0 || judgeable.length === 0 ? true : undefined,
    };
  }

  // Sem juizes ou sem nada julgavel => inconclusivo (sem chamadas LLM).
  if (judgeIds.length === 0 || judgeable.length === 0) {
    for (const r of judgeable) {
      verdictByContestant[r.contestantId] = 'parcial';
      explanationByContestant[r.contestantId] = '(sem juiz configurado)';
    }
    return {
      verdictByContestant,
      explanationByContestant,
      judgeModelId,
      inconclusive: true,
    };
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

  // Multi-juiz: veredito agregado por media ordinal; explanation = a do 1o
  // juiz que deu o veredito agregado (fallback: a do 1o juiz).
  for (const r of judgeable) {
    const vs = singles.filter((s) => s.contestantId === r.contestantId);
    const agg = aggregateVerdict(vs.map((v) => v.verdict));
    verdictByContestant[r.contestantId] = agg;
    explanationByContestant[r.contestantId] =
      (vs.find((v) => v.verdict === agg) ?? vs[0])?.explanation ?? '';
  }

  return { verdictByContestant, explanationByContestant, judgeModelId };
}
