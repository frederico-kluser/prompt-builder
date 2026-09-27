import { z } from 'zod';
import { chatCompletion } from './openrouter.js';
import { callJudgeWithRetry, withReminder } from './engine/judgeRetry.js';
import { unjudgeableReason } from './engine/verdictIntegrity.js';
import type {
  CompetitorResponse,
  JudgeResult,
  JudgeVerdict,
  SingleJudgeResult,
  ReasoningLevel,
  RunCtx,
  StageSpec,
  Verdict,
  VerdictError,
  VerdictSource,
} from './types.js';

// Juiz LISTWISE e COMPACTO: uma unica chamada por juiz devolve (a) o RANKING de
// TODAS as respostas e (b) por resposta, ACEITAVEL (sim/nao) + um MOTIVO de <= 1
// frase. Sem texto verboso. Suporta MULTIPLOS juizes (rodam em paralelo, gateados
// pelo limitador global) — agregamos um CONSENSO de ranking (posicao media) e a
// aceitabilidade por MAIORIA. Cada juiz pode rodar 1 ou 2 passagens (shuffles
// diferentes) para reduzir vies de posicao; a aceitabilidade vem da 1a passagem
// (independe da ordem). O prompt e neutro (anti-vies de tamanho e de posicao).
//
// Falha NAO e veredito (IMPL-004, R-03b:REC-4): a saida do juiz e validada de
// forma ESTRITA (JSON no schema, ranking com TODOS os rotulos, veredito
// reconhecivel para cada um). Invalida => UM novo pedido com lembrete de
// formato; persistindo, a passagem falha. Sem nenhuma passagem valida o juiz
// nao vota; sem nenhum juiz, os contestants ficam SEM veredito (motivo em
// `verdictErrorByContestant`). Antes: regex de letras no texto cru e 'parcial'
// para quem o juiz nao classificou — notas inventadas no placar e nas medias.

const SYSTEM_PROMPT = `Voce e um juiz imparcial de respostas de IA. Recebe a pergunta do usuario, o CONTEXTO fornecido aos modelos e VARIAS respostas anonimizadas (rotuladas A, B, C, ...).

Quando um CRITERIO DE CORRETUDE (rubrica) for fornecido para a etapa, ele e a REFERENCIA PRINCIPAL do que e uma resposta correta: priorize-o acima do seu proprio palpite. Uma resposta que satisfaz a rubrica e aceitavel; uma que a viola (ou ignora um item exigido) NAO e, por mais bem escrita que seja.

Faca DUAS coisas:
1) "ranking": ordene TODAS as respostas da MELHOR para a PIOR, considerando, em ordem de importancia: (a) aderencia ao CRITERIO DE CORRETUDE (rubrica) da etapa, quando fornecido; (b) corretude factual e ausencia de alucinacao; (c) aderencia ao contexto/politicas fornecidos; (d) completude; (e) seguranca; (f) clareza.
2) "verdicts": para CADA resposta, PRIMEIRO escreva uma "justificativa" curta (1-2 frases) analisando se ela resolve a tarefa, e SO DEPOIS atribua um "veredito" TERNARIO. Raciocine primeiro, classifique por ultimo.
   - "resolve": resolve a tarefa corretamente e com seguranca (satisfaz a rubrica, quando houver).
   - "parcial": resolve em parte — incompleta, imprecisa em pontos menores, ou util mas com ressalvas.
   - "nao": NAO resolve — erro factual, viola o contexto/politica/rubrica, inseguro, ou incompleto a ponto de nao servir.

Regras de justica (siga estritamente):
- NAO premie respostas mais longas: avalie conteudo e utilidade, NUNCA o tamanho.
- A ordem em que aparecem (A, B, C...) e ALEATORIA e NAO deve influenciar.
- Cada rotulo aparece EXATAMENTE UMA vez no ranking; inclua TODOS os rotulos.
- A "justificativa" vem ANTES do "veredito" em cada item.

Saida ESTRITAMENTE em JSON valido, sem markdown e sem comentarios:
{"ranking":["<melhor>","...","<pior>"],"verdicts":[{"label":"<letra>","justificativa":"<1-2 frases>","veredito":"resolve|parcial|nao"}, ... TODOS os rotulos]}`;

const judgeSchema = z.object({
  ranking: z.array(z.string().min(1)).min(1),
  verdicts: z
    .array(
      z.object({
        label: z.string().min(1),
        // justificativa primeiro (G-Eval); aceita "motivo" do formato antigo.
        justificativa: z.string().optional().default(''),
        motivo: z.string().optional(),
        // veredito ternario; aceita "acceptable" (bool) do formato antigo.
        veredito: z.string().optional(),
        acceptable: z.boolean().optional(),
      }),
    )
    .optional()
    .default([]),
});

const ORDINAL: Record<Verdict, number> = { nao: 0, parcial: 1, resolve: 2 };

/**
 * Normaliza o veredito cru do juiz (ternario, com fallback ao binario antigo).
 * Valor irreconhecivel => `null` (saida invalida), NUNCA 'parcial': o antigo
 * "ambiguo => neutro" era um veredito imputado.
 */
function toVerdict(raw: { veredito?: string; acceptable?: boolean }): Verdict | null {
  const s = (raw.veredito ?? '').trim().toLowerCase();
  if (s.startsWith('resolv') || s === 'sim' || s === 'ok' || s === 'true') return 'resolve';
  if (s.startsWith('parc')) return 'parcial';
  if (s.startsWith('nao') || s.startsWith('não') || s === 'no' || s === 'false') return 'nao';
  if (typeof raw.acceptable === 'boolean') return raw.acceptable ? 'resolve' : 'nao';
  return null;
}

/**
 * Agrega vereditos ternarios por media ordinal (resolve=2, parcial=1, nao=0).
 * So e chamada com >= 1 voto legitimo (lista vazia nao vira veredito).
 */
function aggregateVerdict(verdicts: Verdict[]): Verdict {
  const avg = verdicts.reduce((s, v) => s + ORDINAL[v], 0) / verdicts.length;
  if (avg >= 1.5) return 'resolve';
  if (avg >= 0.5) return 'parcial';
  return 'nao';
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function letterFor(index: number): string {
  return String.fromCharCode(65 + index);
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) return match[1].trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

export interface JudgeStageParams {
  apiKey: string;
  stage: StageSpec;
  responses: CompetitorResponse[];
  /** Um ou mais juizes — rodam EM PARALELO (sem cap local; limitador global gateia). */
  judgeModelIds: string[];
  timeoutMs?: number;
  /** Passagens listwise POR JUIZ: 2 = duas ordens agregadas (anti-vies de posicao). Default 1. */
  passes?: 1 | 2;
  /** Sinal de abort + ledger de custo. */
  ctx?: RunCtx;
  maxPricePerMTok?: { prompt?: number; completion?: number };
  /** Esforco de raciocinio do juiz listwise (o pointwise ja tinha o dele). */
  reasoningLevel?: ReasoningLevel;
}

interface PassResult {
  /** contestantIds da melhor para a pior. */
  order: string[];
  /** veredito (aceitavel + motivo) por contestantId. */
  verdicts: JudgeVerdict[];
  /** letra -> contestantId desta passagem (cosmetico p/ a UI "(era X)"). */
  blindMap: Record<string, string>;
}

type PassAttempt = { ok: true; pass: PassResult } | { ok: false; error: VerdictError };

/** Lembrete anexado ao 2o pedido depois de uma saida fora do contrato. */
function formatReminder(labels: string[]): string {
  return (
    'LEMBRETE DE FORMATO: a resposta anterior não seguiu o contrato. Responda APENAS com JSON válido, sem markdown: ' +
    `{"ranking":[...],"verdicts":[{"label":"<letra>","justificativa":"<1-2 frases>","veredito":"resolve|parcial|nao"}]} — ` +
    `"ranking" com TODOS estes rótulos exatamente uma vez: ${JSON.stringify(labels)}; e UM item em "verdicts" para CADA rótulo.`
  );
}

/**
 * Parse ESTRITO de uma passagem: JSON no schema, ranking cobrindo TODOS os
 * rotulos (duplicatas/rotulos estranhos ignorados) e veredito reconhecivel
 * para CADA rotulo. Qualquer lacuna => `null` (saida invalida).
 */
function parsePass(
  text: string,
  labels: string[],
): { ranking: string[]; verdicts: Map<string, { verdict: Verdict; motivo: string }> } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJson(text));
  } catch {
    return null;
  }
  const parsed = judgeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const labelSet = new Set(labels);
  const ranking: string[] = [];
  for (const l of parsed.data.ranking.map((x) => x.trim().toUpperCase())) {
    if (labelSet.has(l) && !ranking.includes(l)) ranking.push(l);
  }
  if (ranking.length !== labels.length) return null;
  const verdicts = new Map<string, { verdict: Verdict; motivo: string }>();
  for (const v of parsed.data.verdicts) {
    const label = v.label.trim().toUpperCase();
    if (!labelSet.has(label) || verdicts.has(label)) continue;
    const verdict = toVerdict(v);
    if (verdict === null) return null;
    verdicts.set(label, { verdict, motivo: (v.justificativa || v.motivo || '').trim() });
  }
  if (verdicts.size !== labels.length) return null;
  return { ranking, verdicts };
}

/** Uma passagem de UM juiz: embaralha, pede ranking + vereditos, devolve por contestantId. */
async function rankOnePass(
  apiKey: string,
  stage: StageSpec,
  okResponses: CompetitorResponse[],
  judgeModelId: string,
  timeoutMs: number,
  extra: { ctx?: RunCtx; maxPricePerMTok?: { prompt?: number; completion?: number }; reasoningLevel?: ReasoningLevel } = {},
): Promise<PassAttempt> {
  const shuffled = shuffle(okResponses);
  const blindMap: Record<string, string> = {};
  const letterToContestant: Record<string, string> = {};
  const blocks: string[] = [];
  shuffled.forEach((r, i) => {
    const letter = letterFor(i);
    blindMap[letter] = r.contestantId;
    letterToContestant[letter] = r.contestantId;
    blocks.push(`### Resposta ${letter}\n${r.text}`);
  });

  const labels = Object.keys(blindMap);
  const rubricBlock =
    stage.rubric && stage.rubric.trim()
      ? `\nCRITERIO DE CORRETUDE DESTA ETAPA (rubrica — use como referencia principal do que e correto):\n${stage.rubric.trim()}\n`
      : '';
  const userPrompt = `PERGUNTA DO USUARIO:
${stage.question}

CONTEXTO FORNECIDO AOS MODELOS:
${stage.productContext}
${rubricBlock}
RESPOSTAS A AVALIAR:
${blocks.join('\n\n')}

Em "ranking", ordene TODOS estes rotulos da melhor para a pior: ${JSON.stringify(labels)}.
Em "verdicts", de para CADA rotulo: "acceptable" (bool) e "motivo" (<= 1 frase).`;

  // Controle (orcamento/cancelamento) sobe de dentro de callJudgeWithRetry:
  // sem isso a etapa sairia sem ranking — incompleta com cara de completa.
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
          timeoutMs,
          responseFormatJson: true,
          reasoningLevel: extra.reasoningLevel,
          role: 'judge',
          signal: extra.ctx?.signal,
          sink: extra.ctx?.sink,
          maxPricePerMTok: extra.maxPricePerMTok,
        })
      ).text,
    parse: (text) => parsePass(text, labels),
    formatReminder: formatReminder(labels),
    signal: extra.ctx?.signal,
  });
  if (!attempt.ok) return { ok: false, error: attempt.error };

  const order = attempt.value.ranking.map((l) => letterToContestant[l]);
  const verdicts: JudgeVerdict[] = okResponses.map((r) => {
    const letter = labels.find((l) => letterToContestant[l] === r.contestantId)!;
    const v = attempt.value.verdicts.get(letter)!;
    return { contestantId: r.contestantId, verdict: v.verdict, motivo: v.motivo };
  });
  return { ok: true, pass: { order, verdicts, blindMap } };
}

/** Agrega varias ordenacoes por POSICAO MEDIA (menor = melhor). Empate -> 1a ordenacao. */
function aggregate(ids: string[], orders: string[][]): string[] {
  const n = ids.length;
  const firstOrder = orders[0] ?? [];
  const tiebreak = (id: string) => {
    const i = firstOrder.indexOf(id);
    return i < 0 ? n : i;
  };
  const avgPos: Record<string, number> = {};
  for (const id of ids) {
    let sum = 0;
    for (const o of orders) {
      const idx = o.indexOf(id);
      sum += idx < 0 ? n : idx; // ausente conta como pior
    }
    avgPos[id] = sum / orders.length;
  }
  return [...ids].sort((a, b) => {
    if (avgPos[a] !== avgPos[b]) return avgPos[a] - avgPos[b];
    return tiebreak(a) - tiebreak(b);
  });
}

/**
 * UM juiz: roda `passes` passagens EM PARALELO (anti-vies de posicao) e agrega o
 * ranking por posicao media; os vereditos vem da 1a passagem valida (a
 * aceitabilidade independe da ordem). Sem nenhuma passagem valida o juiz nao
 * vota — devolve o motivo da 1a falha.
 */
async function runOneJudge(
  apiKey: string,
  stage: StageSpec,
  okResponses: CompetitorResponse[],
  judgeModelId: string,
  passes: number,
  timeoutMs: number,
  extra: { ctx?: RunCtx; maxPricePerMTok?: { prompt?: number; completion?: number }; reasoningLevel?: ReasoningLevel } = {},
): Promise<{ ok: true; judge: SingleJudgeResult } | { ok: false; judgeModelId: string; error: VerdictError }> {
  const passResults = await Promise.all(
    Array.from({ length: passes }, () =>
      rankOnePass(apiKey, stage, okResponses, judgeModelId, timeoutMs, extra),
    ),
  );
  const valid = passResults.flatMap((p) => (p.ok ? [p.pass] : []));
  if (valid.length === 0) {
    const falha = passResults.find((p): p is Extract<PassAttempt, { ok: false }> => !p.ok);
    return {
      ok: false,
      judgeModelId,
      error: falha?.error ?? { kind: 'judge_failed', message: 'Juiz sem passagem válida.' },
    };
  }

  const ids = okResponses.map((r) => r.contestantId);
  const rankedContestantIds = aggregate(
    ids,
    valid.map((p) => p.order),
  );
  return {
    ok: true,
    judge: {
      judgeModelId,
      rankedContestantIds,
      verdicts: valid[0].verdicts,
      blindMap: valid[0].blindMap,
    },
  };
}

export async function judgeStage(params: JudgeStageParams): Promise<JudgeResult> {
  const { apiKey, stage, responses, judgeModelIds, timeoutMs = 90_000, ctx, maxPricePerMTok, reasoningLevel } =
    params;
  const extra = { ctx, maxPricePerMTok, reasoningLevel };
  const passes = params.passes === 2 ? 2 : 1;
  // dedup: um mesmo juiz duas vezes distorceria a maioria e o placar aditivo.
  const judgeIds = [...new Set(judgeModelIds ?? [])];

  // Regra de origem (CONVENTIONS): erro de infra/bloqueio => SEM veredito
  // (motivo registrado); resposta vazia => 'nao' automatico (sem gastar LLM).
  const verdictByContestant: Record<string, Verdict> = {};
  const acceptableByContestant: Record<string, boolean> = {};
  const verdictSourceByContestant: Record<string, VerdictSource> = {};
  const verdictErrorByContestant: Record<string, VerdictError> = {};
  const okResponses: CompetitorResponse[] = [];
  for (const r of responses) {
    const semVeredito = unjudgeableReason(r);
    if (semVeredito) {
      verdictErrorByContestant[r.contestantId] = semVeredito;
    } else if (r.text.trim().length === 0) {
      verdictByContestant[r.contestantId] = 'nao';
      acceptableByContestant[r.contestantId] = false;
      verdictSourceByContestant[r.contestantId] = 'auto';
    } else {
      okResponses.push(r);
    }
  }
  const semJuiz = (rawJudgeText: string, error?: VerdictError): JudgeResult => {
    if (error) for (const r of okResponses) verdictErrorByContestant[r.contestantId] = error;
    return {
      rankedContestantIds: [],
      acceptableByContestant,
      verdictByContestant,
      verdictSourceByContestant,
      verdictErrorByContestant,
      judges: [],
      blindMap: {},
      rawJudgeText,
      inconclusive: true,
    };
  };

  if (okResponses.length === 0) return semJuiz('');
  if (judgeIds.length === 0) {
    return semJuiz('Nenhum juiz configurado.', { kind: 'judge_failed', message: 'Nenhum juiz configurado.' });
  }

  // Roda TODOS os juizes EM PARALELO — SEM cap local; o limitador global throttla.
  const results = await Promise.all(
    judgeIds.map((jid) => runOneJudge(apiKey, stage, okResponses, jid, passes, timeoutMs, extra)),
  );
  const judges = results.flatMap((j) => (j.ok ? [j.judge] : []));
  const falhas = results.flatMap((j) => (j.ok ? [] : [j]));

  if (judges.length === 0) {
    const f = falhas[0];
    const error: VerdictError =
      judgeIds.length > 1 ? { ...f.error, message: `${f.judgeModelId}: ${f.error.message}` } : f.error;
    return semJuiz('Nenhum juiz retornou saída válida.', error);
  }

  const ids = okResponses.map((r) => r.contestantId);
  // Consenso de ranking: posicao media entre os juizes.
  const rankedContestantIds = aggregate(
    ids,
    judges.map((j) => j.rankedContestantIds),
  );

  // Veredito TERNARIO de consenso (media ordinal entre os juizes que VOTARAM) e
  // o binario "aceitavel" derivado dele (resolve|parcial => aceitavel).
  // Painel reduzido (algum juiz falhou) => fonte 'degraded'.
  const fonte: VerdictSource = judges.length < judgeIds.length ? 'degraded' : 'judge';
  for (const id of ids) {
    const vs: Verdict[] = [];
    for (const j of judges) {
      const v = j.verdicts.find((x) => x.contestantId === id);
      if (v) vs.push(v.verdict);
    }
    if (vs.length === 0) continue; // defensivo: o parse estrito garante 1 por rotulo
    const agg = aggregateVerdict(vs);
    verdictByContestant[id] = agg;
    acceptableByContestant[id] = agg !== 'nao';
    verdictSourceByContestant[id] = fonte;
  }

  const rawJudgeText =
    `${judges.length} juiz(es)${passes === 2 ? ' x2 passagens' : ''}. ` +
    `Consenso (melhor->pior): ${rankedContestantIds.join(' > ')}` +
    (falhas.length
      ? ` · ${falhas.length} juiz(es) sem saída válida: ${falhas.map((f) => `${f.judgeModelId} (${f.error.kind})`).join(', ')}`
      : '');

  return {
    rankedContestantIds,
    acceptableByContestant,
    verdictByContestant,
    verdictSourceByContestant,
    verdictErrorByContestant,
    judges,
    blindMap: judges[0].blindMap,
    rawJudgeText,
  };
}
