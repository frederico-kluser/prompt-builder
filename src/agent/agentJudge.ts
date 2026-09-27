// ----------------------------------------------------------------------------
// O JUIZ POINTWISE DE AGENTE — `judgeDossier`.
//
// É o paralelo agentic de `refJudge.ts`, com uma diferença central: o juiz lê o
// DOSSIÊ (§16 do plano) em vez do texto da resposta. O contrato de saída não muda:
// `{"verdict": "resolve"|"parcial"|"nao", "explanation": "<uma frase>"}` e a
// agregação multi-juiz é a mesma média ordinal.
//
// Hierarquia (§17.1): o oráculo MANDA; o juiz só aparece nas lacunas. Quem decide
// QUANDO chamar é o `runAgentStage` (§18), e quem confina o veredito à faixa do
// oráculo é `settleRepVerdict` (`verdictTree.ts`). Este módulo só IMPLEMENTA a
// chamada.
//
// FALHA NÃO É VEREDITO (IMPL-033 / R-14a DEC-3): exceção, timeout ou saída sem
// veredito reconhecível contam como FALHA do juiz, re-tentada 2× (3 tentativas
// no total, cegas ao resultado — o gateway já re-tenta 429/5xx/rede por baixo).
// Esgotadas, o juiz devolve `verdict: null` + `judgeError`, e quem chama cai no
// veredito do ORÁCULO. Antes a falha virava 'parcial' e um oráculo 100% saía
// rebaixado (resolve→parcial, defeito A3) sem ninguém saber.
//
// Três parágrafos novos no system prompt (Apêndice B.1 do plano), e por quê
// (§18.1): julgue o RESULTADO não o estilo; a VERIFICAÇÃO AUTOMÁTICA tem
// precedência; trajetória mais longa NÃO é melhor.
//
// ⚠️ ESPELHO CLIENT-SIDE: NÃO existe — o navegador não executa agente (§7.3).
// ----------------------------------------------------------------------------
import { chatCompletion } from '../openrouter.js';
import { isControlSignal, RunCancelled } from '../budget.js';
import type { ReasoningLevel, RunCtx, StageSpec, Verdict, VerdictError } from '../types.js';

// ---------------------------------------------------------------------------
// System prompt do juiz de agentes — transcrição do Apêndice B.1 do plano.
// ---------------------------------------------------------------------------
const JUDGE_SYSTEM_PROMPT = `Você é um juiz técnico estrito avaliando o trabalho de um AGENTE DE PROGRAMAÇÃO.

Você recebe um DOSSIÊ com: a verificação automática (quando existe), o resumo das
mudanças, o diff produzido, a lista do que o agente fez e a mensagem final dele.

REGRAS DE JULGAMENTO, em ordem de precedência:
1. A VERIFICAÇÃO AUTOMÁTICA tem precedência sobre a sua impressão. Se ela falhou,
   a tarefa não foi resolvida — não importa quão convincente seja a explicação
   do agente.
2. Julgue o RESULTADO (o diff e a verificação), não o estilo de trabalho. Um
   agente que resolveu em 3 passos não é pior que um que resolveu em 40.
   Trajetória mais longa NÃO é melhor.
3. Respeite o CRITÉRIO DE CORRETUDE da etapa quando ele existir; ele tem
   prioridade sobre o seu próprio critério.
4. Mudanças fora do escopo pedido são um DEFEITO, não um bônus.
5. Se o dossiê estiver marcado como truncado, julgue apenas com o que está
   presente e diga isso na explicação.

Responda APENAS com {"verdict": "resolve"|"parcial"|"nao",
"explanation": "<uma frase curta em pt-BR>"}, onde
resolve = a tarefa foi cumprida; parcial = incompleta, imprecisa, ou cumprida com
efeito colateral relevante; nao = não cumprida, ou cumprida burlando o critério.`;

const VERDICT_ORDINAL: Record<Verdict, number> = { nao: 0, parcial: 1, resolve: 2 };

/**
 * Agrega vereditos ternarios por media ordinal (resolve=2, parcial=1, nao=0;
 * media >= 1.5 => resolve, >= 0.5 => parcial, senao nao). Copia LOCAL do
 * `aggregateVerdict` de refJudge.ts (nao exportado), mantido em sincronia.
 */
export function aggregateAgentVerdict(verdicts: Verdict[]): Verdict {
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

/**
 * Fallback regex: 1a ocorrencia de resolve|parcial|nao no texto cru. `null` =
 * nenhum rótulo reconhecível (lixo) — é FALHA do juiz, não 'parcial' (IMPL-033).
 * (A saída estrita validada por schema, sem este fallback, é o IMPL-034.)
 */
function verdictFromText(text: string): Verdict | null {
  const lower = text.toLowerCase();
  // 'nao' antes de 'resolve' (texto "não resolve" nao pode virar 'resolve').
  if (lower.includes('parcial')) return 'parcial';
  if (/n[aã]o/.test(lower)) return 'nao';
  if (lower.includes('resolve')) return 'resolve';
  return null;
}

/**
 * Parse do veredito: JSON primeiro; regex como fallback; `null` = saída sem
 * veredito reconhecível (vira tentativa falha, re-tentada).
 */
function parseJudgeReply(text: string): { verdict: Verdict; explanation: string } | null {
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
          : '(veredito do juiz de agente)';
      return { verdict, explanation };
    }
  } catch {
    // JSON invalido — cai no fallback regex abaixo.
  }
  const verdict = verdictFromText(text);
  return verdict === null ? null : { verdict, explanation: '(veredito do juiz de agente)' };
}

/**
 * Prompt do usuario do juiz de agentes: as seções DECISIVAS do dossiê no topo
 * (a VERIFICAÇÃO AUTOMÁTICA e O QUE O AGENTE FEZ), o critério ancorado (rubrica,
 * prioridade) e o candidato por dossiê — todo o corpo do dossiê.
 */
function buildUserPrompt(stage: StageSpec, dossierText: string): string {
  const rubric = stage.rubric?.trim();
  const lines: string[] = [];
  lines.push(`PERGUNTA (tarefa do agente):\n${stage.question}`);
  if (rubric) {
    lines.push(`\nCRITÉRIO DE CORRETUDE DESTA ETAPA (tem prioridade):\n${rubric}`);
  }
  lines.push(`\nCANDIDATO (dossiê):\n${dossierText}`);
  return lines.join('\n');
}

export interface JudgeDossierParams {
  stage: StageSpec;
  dossierText: string;
  contestantId: string;
  /** Um ou mais juizes — 1 chamada por juiz, todas em paralelo. */
  judgeModelIds: string[];
  apiKey: string;
  reasoningLevel?: ReasoningLevel;
  timeoutMs?: number;
  /** Sinal de abort + ledger de custo. */
  ctx?: RunCtx;
  maxPricePerMTok?: { prompt?: number; completion?: number };
}

export interface JudgeDossierResult {
  /**
   * Veredito agregado dos juízes que RESPONDERAM. `null` = nenhum juiz produziu
   * veredito válido mesmo após as retentativas — ver `judgeError`. Nunca um
   * 'parcial' inventado no lugar da falha (IMPL-033).
   */
  verdict: Verdict | null;
  explanation: string;
  judgeModelId: string;
  /** true = o juiz não conseguiu produzir um veredito confiável (falha total). */
  inconclusive?: boolean;
  /** Falha TOTAL do juiz (todos os juízes falharam após 1+2 tentativas). */
  judgeError?: VerdictError;
  /** Tentativas (chamadas) do juiz que mais tentou — auditoria/explicação. */
  attempts: number;
  /** Juízes que falharam (painel reduzido quando < total). */
  failedJudges?: { judgeModelId: string; error: VerdictError }[];
  /** true = parte do painel falhou; o veredito vem só de quem respondeu. */
  degraded?: boolean;
}

/**
 * Retentativas do juiz de agente além da 1ª chamada (R-14a DEC-3: "retry 2×").
 * Cegas ao resultado: exceção, timeout e saída sem veredito são re-tentados
 * igual. Sinais de controle (orçamento/cancelamento) NUNCA são re-tentados.
 */
export const AGENT_JUDGE_RETRIES = 2;

/** Lembrete de formato anexado à tentativa seguinte a uma saída sem veredito. */
const FORMAT_REMINDER =
  'LEMBRETE: responda APENAS com o objeto JSON {"verdict": "resolve"|"parcial"|"nao", "explanation": "<uma frase>"} — nada antes nem depois.';

type SingleAgentVerdict =
  | { ok: true; judgeModelId: string; verdict: Verdict; explanation: string; attempts: number }
  | { ok: false; judgeModelId: string; error: VerdictError; attempts: number };

/** Timeout do gateway (`abort(new Error('timeout'))`) ou `TimeoutError` do runtime. */
function isTimeout(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; message?: unknown };
  if (e.name === 'TimeoutError') return true;
  return typeof e.message === 'string' && /\btime-?out\b|\btimed out\b/i.test(e.message);
}

function describeFailure(err: unknown): VerdictError {
  const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim().slice(0, 160);
  return { kind: isTimeout(err) ? 'timeout' : 'judge_failed', message };
}

/**
 * UM juiz julgando UM dossiê, com até {@link AGENT_JUDGE_RETRIES} retentativas.
 * NUNCA lança erro comum: devolve `{ ok: false, error }` quando todas as
 * tentativas falham. Sinais de controle sobem (isControlSignal com rethrow), e
 * um abort externo no meio da chamada vira `RunCancelled` — cancelamento não é
 * falha do juiz e não pode inflar a contagem de `judgeError`.
 */
async function judgeOneDossier(opts: {
  apiKey: string;
  judgeModelId: string;
  stage: StageSpec;
  dossierText: string;
  reasoningLevel?: ReasoningLevel;
  timeoutMs: number;
  ctx?: RunCtx;
  maxPricePerMTok?: { prompt?: number; completion?: number };
}): Promise<SingleAgentVerdict> {
  const { apiKey, judgeModelId, stage, dossierText, reasoningLevel, timeoutMs, ctx, maxPricePerMTok } = opts;
  const userPrompt = buildUserPrompt(stage, dossierText);
  let lastError: VerdictError = { kind: 'judge_failed', message: 'sem tentativa' };
  let reminder = false;
  let attempts = 0;
  for (let attempt = 0; attempt <= AGENT_JUDGE_RETRIES; attempt++) {
    attempts += 1;
    try {
      const result = await chatCompletion({
        apiKey,
        modelId: judgeModelId,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          { role: 'user', content: reminder ? `${userPrompt}\n\n${FORMAT_REMINDER}` : userPrompt },
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
      if (parsed) return { ok: true, judgeModelId, ...parsed, attempts };
      const t = result.text.replace(/\s+/g, ' ').trim();
      lastError = {
        kind: 'invalid_output',
        message: `saída sem veredito reconhecível: ${t ? `"${t.slice(0, 80)}${t.length > 80 ? '…' : ''}"` : '(vazia)'}`,
      };
      reminder = true;
    } catch (err) {
      // ESTE catch degrada: sem o rethrow, um estouro de orcamento viraria
      // falha do juiz e a run sairia 'concluida' com notas do oráculo (§29.3).
      if (isControlSignal(err)) throw err;
      if (ctx?.signal?.aborted) throw new RunCancelled(ctx.signal.reason);
      lastError = describeFailure(err);
    }
  }
  return { ok: false, judgeModelId, error: lastError, attempts };
}

/**
 * Julga UM dossiê contra o critério da etapa. Multi-juiz: cada juiz vota e o
 * veredito agregado é a média ordinal DOS QUE RESPONDERAM (painel reduzido =
 * `degraded`); a explanation agregada é a do 1º juiz que deu o veredito
 * agregado. Todos falharam ⇒ `verdict: null` + `judgeError` (nunca 'parcial').
 */
export async function judgeDossier(
  opts: JudgeDossierParams,
): Promise<JudgeDossierResult> {
  const { stage, dossierText, judgeModelIds, apiKey, reasoningLevel, ctx, maxPricePerMTok } = opts;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  // dedup: um mesmo juiz duas vezes distorceria a média ordinal.
  const judgeIds = [...new Set(judgeModelIds ?? [])];
  const judgeModelId = judgeIds.join('+');

  // Sem juiz configurado ou dossiê vazio => sem veredito (sem chamadas LLM).
  if (judgeIds.length === 0 || !dossierText.trim()) {
    return {
      verdict: null,
      explanation: '(sem juiz configurado ou dossiê vazio)',
      judgeModelId,
      inconclusive: true,
      judgeError: { kind: 'judge_failed', message: 'sem juiz configurado ou dossiê vazio' },
      attempts: 0,
    };
  }

  // UMA chamada por juiz (mais as retentativas), todas em paralelo — o
  // limitador global gateia.
  const singles = await Promise.all(
    judgeIds.map((jid) =>
      judgeOneDossier({
        apiKey,
        judgeModelId: jid,
        stage,
        dossierText,
        reasoningLevel,
        timeoutMs,
        ctx,
        maxPricePerMTok,
      }),
    ),
  );

  const attempts = Math.max(0, ...singles.map((s) => s.attempts));
  const ok = singles.filter((s): s is Extract<SingleAgentVerdict, { ok: true }> => s.ok);
  const failedJudges = singles
    .filter((s): s is Extract<SingleAgentVerdict, { ok: false }> => !s.ok)
    .map((s) => ({ judgeModelId: s.judgeModelId, error: s.error }));

  if (ok.length === 0) {
    const first = failedJudges[0]?.error ?? { kind: 'judge_failed' as const, message: 'juiz sem resposta' };
    const error: VerdictError =
      failedJudges.length > 1
        ? { kind: first.kind, message: failedJudges.map((f) => `${f.judgeModelId}: ${f.error.message}`).join(' | ').slice(0, 300) }
        : first;
    return {
      verdict: null,
      explanation: `Juiz de agentes falhou: ${error.message}`,
      judgeModelId,
      inconclusive: true,
      judgeError: error,
      attempts,
      failedJudges,
    };
  }

  const agg = aggregateAgentVerdict(ok.map((s) => s.verdict));
  const explanation = (ok.find((s) => s.verdict === agg) ?? ok[0])?.explanation ?? '';
  return {
    verdict: agg,
    explanation,
    judgeModelId,
    attempts,
    ...(failedJudges.length > 0 ? { failedJudges, degraded: true } : {}),
  };
}
