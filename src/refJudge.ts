import { z } from 'zod';
import { chatCompletion, supportsPromptCacheControl } from './openrouter.js';
import { ROLE_MAX_TOKENS } from './roleLimits.js';
import { matchExpected } from './engine/groundTruth.js';
import { callJudgeWithRetry, JUDGE_TEMPERATURE, withReminder } from './engine/judgeRetry.js';
import { caseParts } from './engine/caseInput.js';
import { unjudgeableReason } from './engine/verdictIntegrity.js';
import { isJudgeCutKind } from './engine/truncation.js';
import { aggregateVerdicts, tieLabel } from './engine/verdictAggregate.js';
import { hasLengthAnomaly, type CascadeEscalationReason, type CascadeReport } from './judge.js';
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
} from './engine/judgeGuard.js';
import type {
  CompetitorResponse,
  Contestant,
  JudgeCallFinish,
  JudgeConfidence,
  JudgeResult,
  JudgeVote,
  ReasoningLevel,
  ReferenceJudgeResult,
  StageSpec,
  Verdict,
  VerdictError,
  VerdictErrorKind,
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
//
// IMPL-047 (R-03a:REC-7) — prompt HONESTO: a referência é CANDIDATA (pode estar
// errada — nem toda referência está correta), a RUBRICA tem prioridade (se a
// referência contrariar a rubrica, siga a rubrica) e o JSON traz `confianca`
// para triar revisão humana. "Ignore redação/estilo" deixou de ser
// incondicional: a instrução vive no bloco INSTRUÇÕES e só aparece quando a
// rubrica NÃO tem critério de forma (`styleRuleFor`). ⚠️ Mudança de CONTRATO —
// o hash do juiz muda (IMPL-049); executar ANTES de qualquer calibração.
const SYSTEM_PROMPT = `Você é um juiz técnico estrito. A RESPOSTA DE REFERÊNCIA é CANDIDATA: foi gerada por outro modelo e PODE ESTAR ERRADA — use-a como apoio, nunca como gabarito inquestionável. A RUBRICA (critério de corretude) da etapa tem prioridade sobre a referência: se a referência contrariar a rubrica, SIGA A RUBRICA. Julgue se o CANDIDATO alcança o resultado e a intenção exigidos. ${DATA_BLOCKS_NOTICE} Responda APENAS com um objeto JSON {"canario": "<o CANÁRIO das INSTRUÇÕES>", "explanation": "<uma frase curta em pt-BR>", "verdict": "resolve"|"parcial"|"nao", "confianca": "baixa"|"media"|"alta"} onde resolve = corresponde plenamente ao exigido, parcial = parcialmente/impreciso/faltando parte, nao = errado ou fez outra coisa; "confianca" diz quão seguro está o veredito ("baixa" = merece revisão humana).`;

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
  confianca: { type: 'string', enum: ['baixa', 'media', 'alta'] },
});

/**
 * O mesmo contrato em zod ESTRITO (campo a mais, valor fora do enum => invalido).
 * `confianca` entra OBRIGATÓRIO no contrato pedido (JSON Schema acima) mas
 * ACEITO SEM PRESENÇA no parse (IMPL-047): um veredito válido não é rejeitado
 * inteiro só porque o juiz omitiu o campo de auto-confiança — quem tria revisão
 * humana usa o campo quando presente. Valor fora do enum continua invalidando.
 */
const referenceReplySchema = z
  .object({
    canario: z.string(),
    explanation: z.string(),
    verdict: z.enum(['resolve', 'parcial', 'nao']),
    confianca: z.enum(['baixa', 'media', 'alta']).optional(),
  })
  .strict();

/**
 * Parse ESTRITO do veredito (IMPL-006): o texto INTEIRO e um objeto JSON no
 * schema, com o canario DESTE veredito. Qualquer outra coisa devolve `null`
 * (saida invalida): quem chama pede UMA vez de novo com lembrete de formato e,
 * persistindo, registra o veredito como AUSENTE (`invalid_output`). Sem
 * recorte de `{...}` no meio do texto nem normalizacao ('Resolve', 'não'):
 * o recorte deixava um JSON forjado pelo candidato virar veredito.
 * `confianca` (IMPL-047) volta junto quando o juiz a devolve.
 */
export function parseJudgeReply(
  text: string,
  canary: string,
): { verdict: Verdict; explanation: string; canary: string; confianca?: JudgeConfidence } | null {
  const p = parseStrictJudgeJson(text, referenceReplySchema, canary);
  if (!p) return null;
  return {
    verdict: p.verdict,
    explanation: p.explanation.trim() || '(veredito do juiz de referência)',
    canary: p.canario,
    ...(p.confianca ? { confianca: p.confianca } : {}),
  };
}

/** Prompt montado de UM veredito pointwise (marcador + canario mudam a cada chamada). */
export interface ReferenceJudgePrompt {
  system: string;
  user: string;
  /**
   * IMPL-114 — `user` partido no fim do prefixo ESTÁVEL (layout v1):
   * `prefix` = REFERÊNCIA + PERGUNTA + CRITÉRIO (igual para todo candidato da
   * etapa quando o marcador é compartilhado); `suffix` = CANDIDATO +
   * INSTRUÇÕES. `user === prefix + '\n\n' + suffix`.
   */
  prefix: string;
  suffix: string;
  guard: JudgeGuard;
  formatReminder: string;
}

/**
 * Prompt do usuario (IMPL-006): referencia, contexto do caso (IMPL-059),
 * pergunta, rubrica (prioritaria) e candidato, CADA UM num bloco marcado com o
 * codigo sorteado para ESTE
 * veredito, e o bloco INSTRUCOES anti-injecao por ultimo. O texto do candidato
 * so aparece escapado e dentro de `⟦CANDIDATO·codigo⟧ … ⟦/CANDIDATO·codigo⟧`.
 */
export function buildReferenceJudgePrompt(
  stage: StageSpec,
  reference: string,
  candidateText: string,
  opts: { sharedNonce?: string } = {},
): ReferenceJudgePrompt {
  const rubric = stage.rubric?.trim();
  // IMPL-059 (R-05:REC-2): o CASO que o candidato recebeu — contexto + pergunta,
  // byte a byte (`caseParts`). Antes o pointwise NÃO via o productContext: a
  // referência (escrita com ele) punia o candidato por informação privilegiada.
  const caso = caseParts(stage);
  const dados = [reference, caso.context, caso.question, rubric ?? '', candidateText];
  // IMPL-114: marcador COMPARTILHADO pela etapa (o prefixo fica byte a byte
  // igual entre candidatos e o cache de prompt do provedor acerta); o canário
  // segue novo por veredito. O escape de `⟦`/`⟧` é o que impede fechar bloco —
  // o marcador comum não enfraquece a blindagem. O CONTEXTO do caso é da
  // etapa (igual p/ todo candidato), então mora no prefixo estável.
  const guard: JudgeGuard = opts.sharedNonce
    ? { nonce: opts.sharedNonce, canary: newJudgeGuard([...dados, opts.sharedNonce]).canary }
    : newJudgeGuard(dados);
  const prefixo = [
    'REFERÊNCIA (resposta CANDIDATA de outro modelo — pode estar errada):',
    markedBlock('REFERÊNCIA', guard.nonce, reference),
    ...(caso.context
      ? ['CONTEXTO DO CASO (o mesmo que o candidato recebeu, como dado):', markedBlock('CONTEXTO', guard.nonce, caso.context)]
      : []),
    'PERGUNTA:',
    markedBlock('PERGUNTA', guard.nonce, caso.question),
  ];
  if (rubric) {
    prefixo.push('CRITÉRIO DE CORRETUDE DESTA ETAPA (tem prioridade):', markedBlock('CRITÉRIO', guard.nonce, rubric));
  }
  const partes: string[] = [];
  partes.push(
    'CANDIDATO (resposta a julgar):',
    markedBlock('CANDIDATO', guard.nonce, candidateText),
    instructionsBlock({
      guard,
      candidateLabels: ['CANDIDATO'],
      rules: [
        // IMPL-047: a referência é APOIO, não gabarito; a rubrica manda.
        'A REFERÊNCIA é candidata e pode estar errada; quando houver CRITÉRIO DE CORRETUDE, ele tem prioridade — se a referência contrariar a rubrica, siga a rubrica.',
        '"verdict": resolve = corresponde plenamente ao exigido; parcial = parcialmente/impreciso/faltando parte; nao = errado ou fez outra coisa. Escreva "explanation" (uma frase curta em pt-BR) ANTES de decidir o veredito, e devolva "confianca" ("baixa"|"media"|"alta") no mesmo JSON — "baixa" sinaliza que o veredito merece revisão humana.',
        // IMPL-047: "ignore estilo" condicionado à rubrica (critério de forma conta quando existe).
        styleRuleFor(rubric),
      ],
      outputSchema: REFERENCE_JUDGE_SCHEMA,
    }),
  );
  return {
    system: SYSTEM_PROMPT,
    user: [...prefixo, ...partes].join('\n\n'),
    prefix: prefixo.join('\n\n'),
    suffix: partes.join('\n\n'),
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
  | {
      ok: true;
      judgeModelId: string;
      contestantId: string;
      verdict: Verdict;
      explanation: string;
      canary: string;
      confianca?: JudgeConfidence;
      /** Sinais de fim + artefato da chamada (IMPL-014/IMPL-117). */
      finish?: JudgeCallFinish;
    }
  | { ok: false; judgeModelId: string; contestantId: string; error: VerdictError; finish?: JudgeCallFinish };

/** Ordem crescente de confiança — o MENOR valor entre votos manda na triagem (IMPL-047). */
const CONFIDENCE_RANK: Record<JudgeConfidence, number> = { baixa: 0, media: 1, alta: 2 };

function minConfidence(values: JudgeConfidence[]): JudgeConfidence {
  return values.reduce((a, b) => (CONFIDENCE_RANK[b] < CONFIDENCE_RANK[a] ? b : a));
}

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
  /** IMPL-114: marcador da ETAPA (prefixo cacheável); só vale p/ juiz com `cache_control`. */
  sharedNonce?: string;
}): Promise<SingleVerdict> {
  const { apiKey, judgeModelId, stage, reference, response, reasoningLevel, timeoutMs, ctx, maxPricePerMTok } =
    params;
  // IMPL-114: cache de prompt EXPLÍCITO só onde o provedor o aceita
  // (Anthropic): lá o prefixo estável vai numa mensagem própria com
  // `cache_control`. Nos outros, a montagem de sempre (uma mensagem só).
  const cacheavel = params.sharedNonce !== undefined && supportsPromptCacheControl(judgeModelId);
  // Canario sorteado AQUI: um novo por veredito (as re-tentativas do MESMO
  // veredito reusam o par); o marcador e o da etapa quando cacheavel.
  const prompt = buildReferenceJudgePrompt(stage, reference, response.text, cacheavel ? { sharedNonce: params.sharedNonce } : {});
  const attempt = await callJudgeWithRetry({
    call: async (reminder) =>
      // Resultado INTEIRO (texto + finish_reason): o truncamento e checado antes do parse (IMPL-015).
      await chatCompletion({
        apiKey,
        modelId: judgeModelId,
        messages: cacheavel
          ? [
              { role: 'system', content: prompt.system },
              // Layout v1 (IMPL-114): prefixo ESTÁVEL (com o cache_control) → candidato.
              { role: 'user', content: prompt.prefix },
              { role: 'user', content: withReminder(prompt.suffix, reminder) },
            ]
          : [
              { role: 'system', content: prompt.system },
              { role: 'user', content: withReminder(prompt.user, reminder) },
            ],
        ...(cacheavel ? { cacheControlAfter: 1 } : {}),
        temperature: JUDGE_TEMPERATURE,
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
      }),
    parse: (text) => parseJudgeReply(text, prompt.guard.canary),
    formatReminder: prompt.formatReminder,
    signal: ctx?.signal,
  });
  const finish = attempt.finish ? { finish: attempt.finish } : {};
  if (!attempt.ok) {
    return { ok: false, judgeModelId, contestantId: response.contestantId, error: attempt.error, ...finish };
  }
  return { ok: true, judgeModelId, contestantId: response.contestantId, ...attempt.value, ...finish };
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
  // IMPL-047: confianca do veredito agregado (menor entre os votos — triagem).
  const confidenceByContestant: Record<string, JudgeConfidence> = {};
  // IMPL-057 (R-11a:REC-8): o voto de CADA juiz por contestant — veredito +
  // explicação + confiança + canário, OU a falha do juiz (`error`, sem
  // veredito). Antes o agregado descartava os singles e era impossível mostrar
  // "2 de 3: resolve" com o divergente destacado. Ausente em vereditos
  // determinísticos (ground-truth/auto — não há painel).
  const judgeVotesByContestant: Record<string, JudgeVote[]> = {};
  const result = (inconclusive?: boolean): ReferenceJudgeResult => ({
    verdictByContestant,
    explanationByContestant,
    verdictSourceByContestant,
    verdictErrorByContestant,
    ...(Object.keys(verdictTieByContestant).length > 0 ? { verdictTieByContestant } : {}),
    ...(Object.keys(canaryByContestant).length > 0 ? { canaryByContestant } : {}),
    ...(Object.keys(confidenceByContestant).length > 0 ? { confidenceByContestant } : {}),
    ...(Object.keys(judgeVotesByContestant).length > 0 ? { judgeVotesByContestant } : {}),
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

  // IMPL-114: marcador da ETAPA para os juízes com cache de prompt explícito —
  // sorteado contra TODOS os dados da etapa (nenhum texto o contém) — inclui o
  // CONTEXTO do caso (IMPL-059), que também entra num bloco marcado.
  const casoEtapa = caseParts(stage);
  const sharedNonce = judgeIds.some(supportsPromptCacheControl)
    ? newJudgeGuard([
        reference,
        casoEtapa.context,
        casoEtapa.question,
        stage.rubric?.trim() ?? '',
        ...judgeable.map((r) => r.text),
      ]).nonce
    : undefined;
  // UMA chamada por (juiz x competidor), TODAS em paralelo — sem cap local;
  // o limitador global de openrouter.ts gateia (e o aquecimento do prefixo,
  // IMPL-114, segura só a 1a chamada de cada prefixo).
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
          sharedNonce,
        }),
      ),
    ),
  );

  let algumVeredito = false;
  for (const r of judgeable) {
    const vs = singles.filter((s) => s.contestantId === r.contestantId);
    // IMPL-057: persiste o voto de CADA juiz (inclusive a falha — badge
    // 'avaliador falhou' é do juiz, nunca nota do candidato). IMPL-014: com os
    // sinais de fim da chamada daquele voto (qual veredito terminou em qual
    // `finish_reason`) + o artefato da resposta (IMPL-117).
    judgeVotesByContestant[r.contestantId] = vs.map(
      (s): JudgeVote =>
        s.ok
          ? {
              judgeModelId: s.judgeModelId,
              verdict: s.verdict,
              explanation: s.explanation,
              ...(s.confianca ? { confianca: s.confianca } : {}),
              canary: s.canary,
              ...(s.finish ?? {}),
            }
          : { judgeModelId: s.judgeModelId, error: s.error, ...(s.finish ?? {}) },
    );
    const oks = vs.filter((s): s is Extract<SingleVerdict, { ok: true }> => s.ok);
    if (oks.length === 0) {
      // Saida CORTADA tem precedencia no motivo (IMPL-015): e ela que o evento
      // `judge.truncated` e a taxa papel x esforco precisam enxergar.
      const falhas = vs.filter((s): s is Extract<SingleVerdict, { ok: false }> => !s.ok);
      const falha = falhas.find((s) => isJudgeCutKind(s.error.kind)) ?? falhas[0];
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
    // IMPL-047: `confianca` persistida por veredito — o MENOR entre os votos
    // legítimos (painel inseguro tria revisão humana; nunca o mais confiante).
    const confs = oks.map((v) => v.confianca).filter((c): c is JudgeConfidence => c !== undefined);
    if (confs.length > 0) confidenceByContestant[r.contestantId] = minConfidence(confs);
    // Painel reduzido: o veredito existe, mas vale menos — conta na regra de
    // run inconclusiva como 'degradado' (R-03b:REC-4).
    verdictSourceByContestant[r.contestantId] = oks.length < vs.length ? 'degraded' : 'judge';
  }

  // Nenhum veredito de juiz na etapa inteira: a etapa nao pontua no placar.
  return result(!algumVeredito);
}

// ----------------------------------------------------------------------------
// MODO ECONÔMICO do julgamento pointwise (IMPL-115 / R-08:REC-2). O papel juiz
// domina o custo do pipeline; aqui os DOIS juízes baratos votam em paralelo e
// o forte é chamado POR VEREDITO, só onde há dúvida:
//   • `disagreement` — os baratos divergem (ou um deles não votou);
//   • `parcial`      — algum voto barato saiu 'parcial' (nível intermediário);
//   • `length-anomaly` — a resposta é um extremo (maior/menor) de uma etapa
//     com razão de comprimento > 3× (viés de verbosidade derruba juiz barato).
// Sem gatilho, o consenso dos baratos decide. A fração escalonada vai no
// relatório; o custo por veredito continua MEDIDO pelo ledger (papel judge).
// Nenhum sinal estatístico por token é pedido ou lido (só vereditos + comprimento).
// ----------------------------------------------------------------------------

export interface JudgeStageReferenceCascadeParams extends Omit<JudgeStageReferenceParams, 'judgeModelIds'> {
  /** Os 2 juízes BARATOS (a 1ª camada, em paralelo). */
  cheapJudgeIds: string[];
  /** O juiz FORTE — só nos vereditos em dúvida. */
  strongJudgeId: string;
}

/** Contestants cujo veredito vai ao juiz forte, com os gatilhos da etapa. */
function pointwiseEscalation(
  cheap: string[],
  barato: ReferenceJudgeResult,
  responses: CompetitorResponse[],
): { ids: string[]; reasons: CascadeEscalationReason[] } {
  const votos = barato.judgeVotesByContestant ?? {};
  const julgados = Object.keys(votos);
  const motivos = new Set<CascadeEscalationReason>();
  const escalar = new Set<string>();
  for (const id of julgados) {
    const porJuiz = new Map(votos[id].map((v) => [v.judgeModelId, v.verdict]));
    const vs = cheap.map((j) => porJuiz.get(j));
    if (cheap.length < 2 || vs.some((v) => v === undefined) || new Set(vs).size > 1) {
      motivos.add('disagreement');
      escalar.add(id);
    }
    if (vs.includes('parcial')) {
      motivos.add('parcial');
      escalar.add(id);
    }
  }
  // Anomalia de comprimento: SÓ os extremos da etapa (maior e menor resposta)
  // vão ao forte — escalar a etapa inteira anularia a economia.
  const comTexto = responses.filter((r) => julgados.includes(r.contestantId) && r.text.trim().length > 0);
  const tamanhos = comTexto.map((r) => r.text.length);
  if (hasLengthAnomaly(tamanhos)) {
    const max = Math.max(...tamanhos);
    const min = Math.min(...tamanhos);
    for (const r of comTexto) {
      if (r.text.length === max || r.text.length === min) {
        motivos.add('length-anomaly');
        escalar.add(r.contestantId);
      }
    }
  }
  const ordem: CascadeEscalationReason[] = ['disagreement', 'parcial', 'length-anomaly'];
  return { ids: julgados.filter((id) => escalar.has(id)), reasons: ordem.filter((m) => motivos.has(m)) };
}

/**
 * Julgamento pointwise em modo econômico (IMPL-115). Mesma regra de origem e
 * mesmo contrato de `judgeStageReference` (é ele que roda nas duas camadas); o
 * resultado carrega `cascade` com o que cada camada decidiu. Juiz forte que
 * falha num veredito escalonado: vale o consenso barato, marcado 'degraded'.
 */
export async function judgeStageReferenceCascade(
  opts: JudgeStageReferenceCascadeParams,
): Promise<ReferenceJudgeResult & { cascade?: CascadeReport }> {
  const { cheapJudgeIds, strongJudgeId, ...rest } = opts;
  const cheap = [...new Set(cheapJudgeIds)];
  const barato = await judgeStageReference({ ...rest, judgeModelIds: cheap });
  const julgados = Object.keys(barato.judgeVotesByContestant ?? {});
  // Etapa sem juiz LLM (ground-truth, sem gabarito, nada julgável): a cascata
  // não se aplica — nada a relatar.
  if (julgados.length === 0) return barato;

  const { ids, reasons } = pointwiseEscalation(cheap, barato, rest.responses);
  const base = {
    reasons,
    cheapJudgeIds: cheap,
    strongJudgeId,
    cheapVerdictByContestant: { ...barato.verdictByContestant },
    verdicts: julgados.length,
  };
  if (ids.length === 0) {
    return { ...barato, cascade: { ...base, escalated: false, strongDecided: false, escalatedContestantIds: [] } };
  }

  const alvo = new Set(ids);
  const forte = await judgeStageReference({
    ...rest,
    responses: rest.responses.filter((r) => alvo.has(r.contestantId)),
    contestants: rest.contestants.filter((c) => alvo.has(c.id)),
    judgeModelIds: [strongJudgeId],
  });

  const out: ReferenceJudgeResult = {
    ...barato,
    verdictByContestant: { ...barato.verdictByContestant },
    explanationByContestant: { ...barato.explanationByContestant },
    verdictSourceByContestant: { ...(barato.verdictSourceByContestant ?? {}) },
    verdictErrorByContestant: { ...(barato.verdictErrorByContestant ?? {}) },
    judgeVotesByContestant: { ...(barato.judgeVotesByContestant ?? {}) },
    ...(barato.verdictTieByContestant ? { verdictTieByContestant: { ...barato.verdictTieByContestant } } : {}),
    ...(barato.canaryByContestant ? { canaryByContestant: { ...barato.canaryByContestant } } : {}),
    ...(barato.confidenceByContestant ? { confidenceByContestant: { ...barato.confidenceByContestant } } : {}),
    judgeModelId: `${cheap.join('+')}>${strongJudgeId}`,
  };
  let fortesDecidiram = 0;
  for (const id of ids) {
    // O voto do forte fica AO LADO dos baratos (auditável: quem decidiu o quê).
    const votosForte = forte.judgeVotesByContestant?.[id] ?? [];
    out.judgeVotesByContestant![id] = [...(out.judgeVotesByContestant![id] ?? []), ...votosForte];
    const v = forte.verdictByContestant[id];
    if (v) {
      fortesDecidiram += 1;
      out.verdictByContestant[id] = v;
      out.explanationByContestant[id] = forte.explanationByContestant[id] ?? '';
      out.verdictSourceByContestant![id] = forte.verdictSourceByContestant?.[id] ?? 'judge';
      delete out.verdictErrorByContestant![id];
      delete out.verdictTieByContestant?.[id];
      if (forte.canaryByContestant?.[id]) out.canaryByContestant = { ...(out.canaryByContestant ?? {}), [id]: forte.canaryByContestant[id] };
      if (forte.confidenceByContestant?.[id]) {
        out.confidenceByContestant = { ...(out.confidenceByContestant ?? {}), [id]: forte.confidenceByContestant[id] };
      } else if (out.confidenceByContestant) {
        delete out.confidenceByContestant[id];
      }
    } else if (out.verdictByContestant[id]) {
      // Forte falhou: vale o consenso barato, com a marca de painel reduzido.
      out.verdictSourceByContestant![id] = 'degraded';
    }
  }
  if (Object.keys(out.verdictByContestant).length > 0) delete out.inconclusive;
  return {
    ...out,
    cascade: {
      ...base,
      escalated: true,
      strongDecided: fortesDecidiram === ids.length,
      escalatedContestantIds: ids,
    },
  };
}

// ----------------------------------------------------------------------------
// Diagnostico do juiz contestavel (IMPL-057, R-11a:REC-8) — helpers PUROS sobre
// os votos/falhas ja persistidos. Continuam aqui (e nao num modulo novo de
// `src/engine/`) porque sao a continuacao direta do contrato deste juiz
// pointwise; o shim do web re-exporta tudo sem terceira copia.
// ----------------------------------------------------------------------------

/** Concordancia do painel de juizes — o "2 de 3: resolve" da UI. */
export interface PanelAgreement {
  /** Rótulo curto em PT-BR ("2 de 3: resolve"; "sem veredito (3 juízes)"). */
  label: string;
  /** Veredito agregado (o que a maioria endossa). Ausente = sem veredito. */
  verdict?: Verdict;
  /** Votos que endossam o veredito agregado. */
  agreeCount: number;
  /** Total de juízes do painel (inclui os que FALHARAM). */
  total: number;
  /** Juízes divergentes (destacar na UI). */
  divergentJudgeIds: string[];
  /** Juízes que FALHARAM (badge 'avaliador falhou' — ≠ veredito do candidato). */
  failedJudgeIds: string[];
}

/**
 * Concordância do painel a partir dos votos persistidos
 * (`ReferenceJudgeResult.judgeVotesByContestant`). `aggregated` é o veredito
 * agregado gravado (voto da maioria); sem ele, deriva dos votos. Juiz que
 * falhou CONT no denominador (o painel tinha N juízes) mas nunca conta como
 * voto — falha não é veredito (IMPL-004).
 */
export function panelAgreement(
  votes: readonly JudgeVote[] | undefined,
  aggregated?: Verdict,
): PanelAgreement {
  const todos = votes ?? [];
  const oks = todos.filter((v): v is JudgeVote & { verdict: Verdict } => v.verdict !== undefined);
  const deriva = aggregateVerdicts(oks.map((v) => v.verdict));
  const verdict = aggregated ?? deriva?.verdict;
  const agreeCount = verdict === undefined ? 0 : oks.filter((v) => v.verdict === verdict).length;
  return {
    label:
      verdict === undefined
        ? `sem veredito (${todos.length} juízes)`
        : `${agreeCount} de ${todos.length}: ${verdict}`,
    ...(verdict === undefined ? {} : { verdict }),
    agreeCount,
    total: todos.length,
    divergentJudgeIds:
      verdict === undefined ? [] : oks.filter((v) => v.verdict !== verdict).map((v) => v.judgeModelId),
    failedJudgeIds: todos.filter((v) => v.verdict === undefined).map((v) => v.judgeModelId),
  };
}

/**
 * Categoria da falha (taxonomia tipo ErrorAtlas, R-11a:REC-8): o agrupamento
 * GROSSO por quem falhou; a causa técnica fina continua em `VerdictErrorKind`.
 */
export type VerdictFailureCategory =
  | 'judge'
  | 'reference'
  | 'infrastructure'
  | 'gateway'
  | 'competitor';

/** Mapeia a causa técnica na categoria do ErrorAtlas. */
export function failureCategoryOf(kind: VerdictErrorKind): VerdictFailureCategory {
  switch (kind) {
    case 'judge_failed':
    case 'invalid_output':
    case 'truncated':
      return 'judge';
    case 'no_reference':
      return 'reference';
    case 'timeout':
      return 'infrastructure';
    case 'blocked':
      return 'gateway';
    case 'competitor_error':
    default:
      return 'competitor';
  }
}

/** Uma falha de veredito (chave AUSENTE em `verdictByContestant`) da run. */
export interface VerdictFailureEntry {
  stageIndex: number;
  /** Cenário (rótulo curto — a pergunta da etapa), para o facet por cenário. */
  scenario?: string;
  contestantId: string;
  /** Causa técnica (taxonomia `VerdictErrorKind`). */
  kind: VerdictErrorKind;
  message: string;
}

/** Grupo de falhas por (cenário, categoria, causa técnica) — o ErrorAtlas. */
export interface VerdictFailureGroup {
  category: VerdictFailureCategory;
  /** Causa técnica. */
  cause: VerdictErrorKind;
  /** Cenário do grupo (facet (i)); ausente no rollup de cenários. */
  scenario?: string;
  count: number;
  items: VerdictFailureEntry[];
}

/**
 * Coleta as falhas de veredito de uma run: as chaves AUSENTES de
 * `verdictByContestant` (IMPL-004) de cada etapa, do pointwise e do listwise.
 * ⚠️ `verdictSource=degraded` é veredito PRESENTE com painel reduzido — nunca é
 * falha do candidato e nunca entra aqui (critério IMPL-057).
 */
export function verdictFailuresFromStages(
  stages: ReadonlyArray<{
    spec?: { question?: string } | null;
    referenceJudge?: Pick<ReferenceJudgeResult, 'verdictErrorByContestant' | 'verdictSourceByContestant'> | null;
    judge?: Pick<JudgeResult, 'verdictErrorByContestant' | 'verdictSourceByContestant'> | null;
  }>,
): VerdictFailureEntry[] {
  const entradas: VerdictFailureEntry[] = [];
  stages.forEach((st, stageIndex) => {
    const scenario = st.spec?.question;
    // Etapa POR REFERÊNCIA: o `judge` dela é o SINTETIZADO a partir do
    // `referenceJudge` (mesmos erros copiados) — ler os dois contava cada falha
    // duas vezes. Só a etapa sem referência (listwise) usa o `judge`.
    for (const res of st.referenceJudge ? [st.referenceJudge] : [st.judge]) {
      const erros = res?.verdictErrorByContestant;
      if (!erros) continue;
      for (const [contestantId, error] of Object.entries(erros)) {
        if (res?.verdictSourceByContestant?.[contestantId] === 'degraded') continue;
        entradas.push({
          stageIndex,
          ...(scenario ? { scenario } : {}),
          contestantId,
          kind: error.kind,
          message: error.message,
        });
      }
    }
  });
  return entradas;
}

/**
 * Agrupa as falhas por (cenário, categoria, causa técnica) — a compressão da
 * lista que o ErrorAtlas promete (fixture N3: 12 falhas em run 8×4 ⇒ ≤ 4 grupos,
 * compressão ≥ 3:1). `rollupScenarios: true` funde os cenários num grupo só por
 * (categoria, causa). Grupos ordenados por contagem decrescente (o maior primeiro).
 */
export function groupVerdictFailures(
  entries: readonly VerdictFailureEntry[],
  opts: { rollupScenarios?: boolean } = {},
): VerdictFailureGroup[] {
  const grupos = new Map<string, VerdictFailureGroup>();
  for (const e of entries) {
    const category = failureCategoryOf(e.kind);
    const scenario = opts.rollupScenarios ? undefined : e.scenario;
    const chave = `${scenario ?? ''}\u0000${category}\u0000${e.kind}`;
    const g = grupos.get(chave);
    if (g) {
      g.items.push(e);
      g.count += 1;
    } else {
      grupos.set(chave, {
        category,
        cause: e.kind,
        ...(scenario ? { scenario } : {}),
        count: 1,
        items: [e],
      });
    }
  }
  return [...grupos.values()].sort(
    (a, b) => b.count - a.count || a.cause.localeCompare(b.cause) || (a.scenario ?? '').localeCompare(b.scenario ?? ''),
  );
}
