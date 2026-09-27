// ----------------------------------------------------------------------------
// O JUIZ POINTWISE DE AGENTE — `judgeDossier`.
//
// É o paralelo agentic de `refJudge.ts`, com uma diferença central: o juiz lê o
// DOSSIÊ (§16 do plano) em vez do texto da resposta. O contrato de saída não muda:
// `{"verdict": "resolve"|"parcial"|"nao", "explanation": "<uma frase>"}`, o parse
// é o mesmo tolerante (JSON, fallback regex, lixo ⇒ 'parcial') e a agregação
// multi-juiz é a mesma média ordinal.
//
// Hierarquia (§17.1): o oráculo MANDA; o juiz só aparece nas lacunas. Quem decide
// QUANDO chamar é o `runAgentStage` (§18). Este módulo só IMPLEMENTA uma chamada.
//
// Três parágrafos novos no system prompt (Apêndice B.1 do plano), e por quê
// (§18.1): julgue o RESULTADO não o estilo; a VERIFICAÇÃO AUTOMÁTICA tem
// precedência; trajetória mais longa NÃO é melhor.
//
// ⚠️ ESPELHO CLIENT-SIDE: NÃO existe — o navegador não executa agente (§7.3).
// ----------------------------------------------------------------------------
import { chatCompletion } from '../openrouter.js';
import { isControlSignal } from '../budget.js';
import { aggregateVerdicts } from '../engine/verdictAggregate.js';
import type { ReasoningLevel, RunCtx, StageSpec, Verdict } from '../types.js';

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

/**
 * Agrega vereditos ternarios (juizes ou repeticoes) por MAIORIA SIMPLES — fonte
 * unica em `engine/verdictAggregate.ts` (IMPL-007): sem maioria clara =>
 * empate tecnico com o nivel que a maioria endossa, nunca o voto de cima (a
 * antiga media ordinal fazia resolve+parcial => resolve).
 */
export function aggregateAgentVerdict(verdicts: Verdict[]): Verdict {
  return aggregateVerdicts(verdicts)?.verdict ?? 'parcial';
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
  // 'nao' antes de 'resolve' (texto "não resolve" nao pode virar 'resolve').
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
          : '(veredito do juiz de agente)';
      return { verdict, explanation };
    }
  } catch {
    // JSON invalido — cai no fallback regex abaixo.
  }
  return { verdict: verdictFromText(text), explanation: '(veredito do juiz de agente)' };
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
  verdict: Verdict;
  explanation: string;
  judgeModelId: string;
  /** true = o juiz não conseguiu produzir um veredito confiável (falha de chamada). */
  inconclusive?: boolean;
}

interface SingleAgentVerdict {
  judgeModelId: string;
  verdict: Verdict;
  explanation: string;
}

/**
 * UM juiz julgando UM dossiê. NUNCA lança: falha de chamada => 'parcial' com
 * motivo (exceto sinais de controle — isControlSignal com rethrow).
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
  try {
    const result = await chatCompletion({
      apiKey,
      modelId: judgeModelId,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(stage, dossierText) },
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
    return { judgeModelId, ...parsed };
  } catch (err) {
    // ESTE catch degrada: sem o rethrow, um estouro de orcamento viraria
    // 'parcial' e a run sairia 'concluida' com notas inventadas (§29.3).
    if (isControlSignal(err)) throw err;
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 160);
    return { judgeModelId, verdict: 'parcial', explanation: `Juiz de agentes falhou: ${msg}` };
  }
}

/**
 * Julga UM dossiê contra o critério da etapa. Multi-juiz: cada juiz vota e o
 * veredito agregado é a média ordinal; a explanation agregada é a do 1º juiz
 * que deu o veredito agregado (fallback: a do 1º juiz).
 */
export async function judgeDossier(
  opts: JudgeDossierParams,
): Promise<JudgeDossierResult> {
  const { stage, dossierText, judgeModelIds, apiKey, reasoningLevel, ctx, maxPricePerMTok } = opts;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  // dedup: um mesmo juiz duas vezes distorceria a média ordinal.
  const judgeIds = [...new Set(judgeModelIds ?? [])];
  const judgeModelId = judgeIds.join('+');

  // Sem juiz configurado => inconclusivo (sem chamadas LLM).
  if (judgeIds.length === 0 || !dossierText.trim()) {
    return {
      verdict: 'parcial',
      explanation: '(sem juiz configurado ou dossiê vazio)',
      judgeModelId,
      inconclusive: true,
    };
  }

  // UMA chamada por juiz, todas em paralelo — o limitador global gateia.
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

  const agg = aggregateAgentVerdict(singles.map((s) => s.verdict));
  const explanation = (singles.find((s) => s.verdict === agg) ?? singles[0])?.explanation ?? '';
  return { verdict: agg, explanation, judgeModelId };
}