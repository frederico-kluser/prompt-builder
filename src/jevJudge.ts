// JUIZ JEV — modelo de decisão como juiz dos modos de benchmark (compare/
// variation/training). Fonte única; o web re-exporta por shim
// (`web/src/engine/jevJudge.ts`, classificado em test/engine-sync.test.ts).
//
// Por que: o Jev decide perguntas TIPADAS em milissegundos a ~US$ 0,00002 por
// request, com saída grátis e probabilidades calibradas. Julgar uma resposta
// vira uma decisão tipada (`choice` de veredito + `noul` por critério da
// rubrica) em vez de um JSON de LLM — e as características do Jev são
// aproveitadas de verdade:
//   1. Perguntas decompostas: `verdict` (choice resolve/parcial/nao) + uma
//      pergunta `noul` por critério de checklist da rubrica — diagnóstico por
//      critério pelo preço de UMA chamada (saída é grátis).
//   2. Probabilidades declaradas → score suave e motivo DETERMINÍSTICO
//      (nenhum texto gerado: `motivo` resume p(·), critérios e banda).
//   3. Bandas auto/hitl/abstain sobre o `confidence` opaco → CASCATA: o que
//      está em `auto` fica decidido pelo Jev; o resto escala para o painel de
//      juízes LLM (`judgeModelIds`) e, se a escalada falhar, fica o veredito
//      declarado do Jev com confiança baixa (triagem humana) — nunca nota
//      inventada nem veredito imputado.
//   4. PREVISTO = resposta DECLARADA (o `choice`), nunca o argmax das
//      probabilidades — mesma regra das métricas do modo JEV.
//
// Regras de origem replicadas do refJudge (CONVENTIONS/IMPL-004): erro de
// infra/bloqueio => SEM veredito; resposta vazia => 'nao' automático (fonte
// 'auto'); `stage.expected` => veredito determinístico (ground-truth) ANTES de
// qualquer juiz. `BudgetExceeded`/`RunCancelled` sobem sempre (controle).
//
// LGPD: o Jev não é ZDR. Em área sensível o `decide()` recusa ANTES do envio
// (fail-closed de `engine/sensitiveRouting.ts`) — aqui isso vira fallback ao
// painel LLM com `jevFallback.reason = 'lgpd'`, nunca uma volta ao fail-closed.

import { isControlSignal } from './budget.js';
import { decide } from './openrouter.js';
import { sha256Hex } from './engine/hash.js';
import { matchExpected } from './engine/groundTruth.js';
import { unjudgeableReason } from './engine/verdictIntegrity.js';
import { judgeStage, type JudgeStageParams } from './judge.js';
import { judgeStageReference, type JudgeStageReferenceParams } from './refJudge.js';
import {
  specIdOf,
  validateDecisionsResponse,
  wireQuestionsOf,
  type JevSpec,
  type JevState,
  type JevQuestionSpec,
  type JevStateView,
  type JevWireAnswer,
  type JevWireQuestion,
} from './engine/jev/index.js';
import type {
  CompetitorResponse,
  Contestant,
  JevJudgeBand,
  JevJudgeCell,
  JevJudgeConfig,
  JevJudgeFallback,
  JudgeCallFinish,
  JudgeConfidence,
  JudgeResult,
  JudgeVerdict,
  JudgeVote,
  ReferenceJudgeResult,
  RunCtx,
  SingleJudgeResult,
  StageSpec,
  Verdict,
  VerdictError,
  VerdictSource,
} from './types.js';

// ---------------------------------------------------------------------------
// Contrato e defaults
// ---------------------------------------------------------------------------

/**
 * O CONTRATO do juiz JEV (equivalente `JUDGE_CONTRACT_TEXT` do refJudge): o
 * texto fixo que define a escala de veredito. Vai hasheado no record
 * (`judgeDiagnostics.contract`) — contrato diferente quebra comparação entre
 * sessões e precisa aparecer no drift.
 */
export const JEV_JUDGE_CONTRACT_TEXT =
  'Juiz JEV (decisão tipada). Escala de veredito: resolve = a RESPOSTA CANDIDATA alcança plenamente ' +
  'o resultado e a intenção exigidos pela TAREFA; parcial = acerta o essencial mas está incompleto, ' +
  'impreciso ou falta parte; nao = errado, não respondeu o pedido ou fez outra coisa. A RUBRICA tem ' +
  'prioridade sobre a REFERÊNCIA (que é candidata e pode estar errada). Ignore redação/estilo salvo ' +
  'quando a rubrica pedir forma.';

/** Modelo de decisão default do juiz (SNAPSHOT fixado — nunca `~typesafe/jev-latest`). */
export const JEV_JUDGE_MODEL_DEFAULT = 'typesafe/jev-1.13';

/** Bandas default (mesmas do modo JEV para `choice`): auto 0,90 / hitl 0,50. */
export const JEV_JUDGE_BANDS_DEFAULT = { auto: 0.9, hitl: 0.5 } as const;

/** Banda de ação → confiança do veredito (triagem de revisão humana, IMPL-047). */
export function jevConfidenceOf(band: JevJudgeBand): JudgeConfidence {
  if (band === 'auto') return 'alta';
  if (band === 'hitl') return 'media';
  return 'baixa';
}

interface JevJudgeResolved {
  decisionModelId: string;
  auto: number;
  hitl: number;
  rubricQuestions: boolean;
}

function resolveJevJudge(cfg: JevJudgeConfig | undefined): JevJudgeResolved {
  const auto = cfg?.autoBand ?? JEV_JUDGE_BANDS_DEFAULT.auto;
  const hitl = cfg?.hitlBand ?? JEV_JUDGE_BANDS_DEFAULT.hitl;
  return {
    decisionModelId: (cfg?.decisionModelId ?? JEV_JUDGE_MODEL_DEFAULT).trim() || JEV_JUDGE_MODEL_DEFAULT,
    auto: Math.min(1, Math.max(0, auto)),
    hitl: Math.min(1, Math.max(0, hitl)),
    rubricQuestions: cfg?.rubricQuestions !== false,
  };
}

// ---------------------------------------------------------------------------
// A definição de decisão do juiz (o "prompt" JEV)
// ---------------------------------------------------------------------------

export const VERDICT_QID = 'verdict';

/** Chaves do fio do `verdict` → veredito do produto (a resposta DECLARADA manda). */
const CHOICE_TO_VERDICT: Record<string, Verdict> = { resolve: 'resolve', parcial: 'parcial', nao: 'nao' };

/**
 * Itens de checklist da rubrica (linhas `-`/`*`/`•`/`1.`), que viram perguntas
 * `noul` por critério. Rubrica em prosa (sem marcador) NÃO é decomposta — o
 * critério completo já vai no estado. Máximo de 6 (o essencial da rubrica).
 */
export function rubricCriteriaOf(rubric: string | undefined): string[] {
  if (!rubric) return [];
  return rubric
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^([-*•]|\d+[.)])\s+\S/.test(l))
    .map((l) => l.replace(/^([-*•]|\d+[.)])\s+/, '').trim())
    .filter((l) => l.length >= 8)
    .slice(0, 6);
}

export interface JevJudgeSpecParts {
  spec: JevSpec;
  state: JevState;
  questions: Record<string, JevWireQuestion>;
  criteriaQids: string[];
}

/**
 * Monta a definição de decisão do juiz para UM candidato. O estado leva a
 * tarefa, o contexto, a rubrica, a referência (apoio CANDIDATO) e a resposta;
 * a pergunta `verdict` traz a escala fixa; cada critério de checklist da
 * rubrica vira uma pergunta `noul` (diagnóstico decomposto, custo marginal ~0
 * porque a saída é grátis). `stateView` marca a resposta como conteúdo
 * NÃO CONFIÁVEL (texto de terceiros).
 */
export function buildJevJudgeSpec(params: {
  stage: StageSpec;
  reference?: string;
  candidate: string;
  jevJudge?: JevJudgeConfig;
}): JevJudgeSpecParts {
  const jev = resolveJevJudge(params.jevJudge);
  const rubric = params.stage.rubric?.trim() || undefined;
  const reference = params.reference?.trim() || undefined;
  const state: JevState = {
    tarefa: params.stage.question,
    contexto: params.stage.productContext,
    ...(rubric ? { rubrica: rubric } : {}),
    ...(reference ? { referencia: reference } : {}),
    resposta_candidato: params.candidate,
  };

  const criteriaItems = jev.rubricQuestions ? rubricCriteriaOf(rubric) : [];
  const questions: JevQuestionSpec[] = [
    {
      id: VERDICT_QID,
      type: 'choice',
      instructions:
        `${JEV_JUDGE_CONTRACT_TEXT} Considere a TAREFA (campo \`tarefa\`), o CONTEXTO (\`contexto\`), ` +
        'quando houver a RUBRICA (\`rubrica\`) e a REFERÊNCIA (\`referencia\`), e decida o veredito da ' +
        'RESPOSTA CANDIDATA (campo `resposta_candidato`).',
      criteria: {
        resolve: {
          what: 'A RESPOSTA CANDIDATA alcança plenamente o resultado e a intenção exigidos.',
          not_for: 'Erra o ponto central, inventa fato ou faz outra coisa (é "nao").',
        },
        parcial: {
          what: 'A RESPOSTA CANDIDATA acerta o essencial, mas está incompleta, imprecisa ou falta parte.',
          not_for: 'Resposta plena e correta (é "resolve") ou erro no ponto central (é "nao").',
        },
        nao: {
          what: 'A RESPOSTA CANDIDATA está errada, não respondeu o pedido ou fez outra coisa.',
          not_for: 'Resposta correta com detalhe menor faltando (é "parcial").',
        },
      },
    },
    ...criteriaItems.map(
      (item, i): JevQuestionSpec => ({
        id: `criterio_${i + 1}`,
        type: 'noul',
        instructions:
          `Critério ${i + 1} da rubrica: "${item}". ` +
          'A RESPOSTA CANDIDATA (campo `resposta_candidato`) satisfaz ESTE critério?',
        criteria: { true: 'Satisfaz o critério.', false: 'Não satisfaz o critério.' },
      }),
    ),
  ];

  const stateView: JevStateView = {
    fields: [
      { from: 'tarefa', as: 'tarefa' },
      { from: 'contexto', as: 'contexto' },
      ...(rubric ? [{ from: 'rubrica', as: 'rubrica' }] : []),
      ...(reference ? [{ from: 'referencia', as: 'referencia' }] : []),
      { from: 'resposta_candidato', as: 'resposta_candidato', untrusted: true },
    ],
  };

  const spec: JevSpec = {
    id: '',
    label: 'juiz-jev',
    questions,
    stateView,
    policy: {
      questions: {
        [VERDICT_QID]: { auto: jev.auto, hitl: jev.hitl, signal: 'confidence' },
      },
    },
  };
  spec.id = specIdOf(spec);

  return {
    spec,
    state,
    questions: wireQuestionsOf(spec),
    criteriaQids: criteriaItems.map((_, i) => `criterio_${i + 1}`),
  };
}

// ---------------------------------------------------------------------------
// Resposta → célula (mapping determinístico)
// ---------------------------------------------------------------------------

function fmtP(p: number): string {
  return p.toFixed(2).replace('.', ',');
}

/**
 * Converte as respostas cruas do endpoint em UMA célula de julgamento. O
 * veredito é o `choice` DECLARADO (nunca argmax); a banda vem do `confidence`
 * opaco (ou de max(p) quando ausente); o `motivo` é determinístico.
 */
export function jevJudgeCellFrom(
  rawAnswers: Record<string, unknown>,
  questions: Record<string, JevWireQuestion>,
  bands: { auto: number; hitl: number },
): JevJudgeCell {
  const v = validateDecisionsResponse(questions, rawAnswers);
  const a = v.answers[VERDICT_QID] as JevWireAnswer | undefined;
  const invalid = v.invalid[VERDICT_QID];
  if (invalid || !a || a.type !== 'choice') {
    return {
      band: 'failed',
      motivo: invalid
        ? `Resposta fora do contrato (${invalid}) — sem veredito do Jev.`
        : 'Modelo de decisão não respondeu a pergunta de veredito.',
      source: 'jev',
    };
  }

  const verdict = CHOICE_TO_VERDICT[a.choice];
  const probabilities: Partial<Record<Verdict, number>> = {};
  if (a.probabilities) {
    for (const [k, p] of Object.entries(a.probabilities)) {
      const vd = CHOICE_TO_VERDICT[k];
      if (vd) probabilities[vd] = Math.round(p * 100) / 100;
    }
  }
  const pTop = a.probabilities
    ? Math.max(...Object.values(a.probabilities).map((p) => Math.round(p * 100) / 100))
    : undefined;
  // `confidence` é opaco e só decide a banda; sem ele, cai em max(p) (pTop).
  const signal = a.confidence ?? pTop;
  const band: JevJudgeBand =
    signal === undefined ? 'abstain' : signal >= bands.auto ? 'auto' : signal >= bands.hitl ? 'hitl' : 'abstain';

  const criteria: Record<string, boolean> = {};
  for (const [qid, ans] of Object.entries(v.answers)) {
    if (qid === VERDICT_QID || ans.type !== 'noul') continue;
    criteria[qid] = ans.noul >= 0.5;
  }

  const partes: string[] = [];
  if (a.probabilities) {
    partes.push(
      (['resolve', 'parcial', 'nao'] as Verdict[])
        .map((k) => `p(${k})=${fmtP(probabilities[k] ?? 0)}`)
        .join(' · '),
    );
  } else {
    partes.push(`veredito declarado "${a.choice}" (sem distribuição)`);
  }
  const critIds = Object.keys(criteria);
  if (critIds.length > 0) {
    const ok = critIds.filter((k) => criteria[k]).length;
    partes.push(`critérios ${ok}/${critIds.length}`);
  }
  partes.push(
    a.confidence !== undefined
      ? `confiança ${fmtP(a.confidence)} → banda ${band}`
      : `certeza ${signal !== undefined ? fmtP(signal) : '?'} → banda ${band}`,
  );

  return {
    verdict,
    ...(a.probabilities ? { probabilities } : {}),
    ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
    band,
    criteria,
    motivo: partes.join(' · '),
    source: 'jev',
  };
}

// ---------------------------------------------------------------------------
// Chamada (seam do gateway) e política LGPD
// ---------------------------------------------------------------------------

/** Falha de contrato do fio vira VerdictError (invalid_output); resto, judge_failed. */
function errorOf(err: unknown): VerdictError {
  const message = err instanceof Error ? err.message : String(err);
  return /contrato|not_in_criteria|type_mismatch|answer\.|choice\.|noul\.|score\./i.test(message)
    ? { kind: 'invalid_output', message }
    : { kind: 'judge_failed', message };
}

/**
 * O Jev não é ZDR: em área sensível, o modelo de decisão fora da allowlist é
 * recusado ANTES do envio. Detectamos uma vez (sem gastar) e mandamos a run
 * inteira para o painel LLM (`jevFallback.reason = 'lgpd'`) — o fail-closed do
 * Jev é respeitado, a run não morre.
 */
export function jevBlockedByPolicy(ctx: RunCtx | undefined, modelId: string): JevJudgeFallback | undefined {
  const routing = ctx?.sink?.sensitiveRouting?.();
  if (!routing) return undefined;
  const route = routing.routeFor(modelId);
  if (route.ok) return undefined;
  return {
    reason: 'lgpd',
    message:
      `Modo sensível LGPD (área "${routing.area}"): modelo de decisão ${modelId} fora da allowlist ZDR ` +
      '— juiz JEV indisponível (fail-closed), usando o painel de juízes LLM.',
  };
}

interface JevCellCall {
  cell: JevJudgeCell;
  finish?: JudgeCallFinish;
}

/** UM candidato → UMA decisão tipada. Nunca lança erro comum (controle sobe). */
async function judgeOneJev(params: {
  apiKey: string;
  stage: StageSpec;
  reference: string;
  candidate: string;
  jev: JevJudgeResolved;
  ctx?: RunCtx;
  timeoutMs?: number;
}): Promise<JevCellCall> {
  const { spec, state, questions } = buildJevJudgeSpec({
    stage: params.stage,
    reference: params.reference,
    candidate: params.candidate,
    jevJudge: params.jev,
  });
  try {
    const res = await decide({
      apiKey: params.apiKey,
      modelId: params.jev.decisionModelId,
      state,
      questions,
      role: 'judge',
      signal: params.ctx?.signal,
      sink: params.ctx?.sink,
      ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
    });
    const cell = jevJudgeCellFrom(res.answers, questions, params.jev);
    const finish: JudgeCallFinish = {
      ...(res.generationId ? { generationId: res.generationId } : {}),
      responseSha256: sha256Hex(JSON.stringify(res.answers ?? {})),
    };
    return { cell, finish };
  } catch (err) {
    if (isControlSignal(err)) throw err;
    const error = errorOf(err);
    return {
      cell: { band: 'failed', motivo: `Decisão falhou (${error.kind}): ${error.message}`, source: 'jev' },
    };
  }
}

// ---------------------------------------------------------------------------
// Pré-regras compartilhadas (CONVENTIONS: falha não é veredito)
// ---------------------------------------------------------------------------

interface PreRules {
  verdictByContestant: Record<string, Verdict>;
  explanationByContestant: Record<string, string>;
  verdictSourceByContestant: Record<string, VerdictSource>;
  verdictErrorByContestant: Record<string, VerdictError>;
  judgeable: CompetitorResponse[];
  /** stage.expected presente: veredito determinístico já aplicado a todos. */
  groundTruth: boolean;
}

function applyPreRules(stage: StageSpec, responses: CompetitorResponse[], orderedIdsIn: string[]): PreRules {
  const out: PreRules = {
    verdictByContestant: {},
    explanationByContestant: {},
    verdictSourceByContestant: {},
    verdictErrorByContestant: {},
    judgeable: [],
    groundTruth: false,
  };
  const byContestant = new Map(responses.map((r) => [r.contestantId, r]));
  const orderedIds = [...orderedIdsIn];
  const known = new Set(orderedIds);
  for (const r of responses) {
    if (!known.has(r.contestantId)) {
      known.add(r.contestantId);
      orderedIds.push(r.contestantId);
    }
  }
  for (const id of orderedIds) {
    const r = byContestant.get(id);
    const semVeredito = unjudgeableReason(r);
    if (semVeredito) {
      out.verdictErrorByContestant[id] = semVeredito;
    } else if (r!.text.trim().length === 0) {
      out.verdictByContestant[id] = 'nao';
      out.explanationByContestant[id] = 'Resposta vazia (veredito automático).';
      out.verdictSourceByContestant[id] = 'auto';
    } else {
      out.judgeable.push(r!);
    }
  }
  // F1.4: rótulo ESPERADO ⇒ veredito determinístico, sem gastar juiz nenhum.
  if (stage.expected !== undefined) {
    for (const r of out.judgeable) {
      const gt = matchExpected(r.text, stage.expected, { labelSet: stage.labelSet });
      out.verdictByContestant[r.contestantId] = gt.verdict;
      out.explanationByContestant[r.contestantId] = gt.explanation;
      out.verdictSourceByContestant[r.contestantId] = 'ground-truth';
    }
    out.groundTruth = true;
  }
  return out;
}

/** A célula precisa de escalada? band !== 'auto' (hitl/abstain) ou falha da decisão. */
function needsEscalation(cell: JevJudgeCell): boolean {
  return cell.band !== 'auto';
}

/** Rótulo da escalada para a célula (`error` = falha da decisão). */
function escalationOf(cell: JevJudgeCell): 'hitl' | 'abstain' | 'error' | undefined {
  if (cell.band === 'failed') return 'error';
  if (cell.band === 'hitl' || cell.band === 'abstain') return cell.band;
  return undefined;
}

// ---------------------------------------------------------------------------
// Caminho 1: pointwise vs gabarito (contrato ReferenceJudgeResult)
// ---------------------------------------------------------------------------

export type JevReferenceJudgeResult = ReferenceJudgeResult & {
  jevByContestant?: Record<string, JevJudgeCell>;
  jevFallback?: JevJudgeFallback;
};

/**
 * Julga todas as respostas da etapa contra o gabarito com o JUÍZ JEV (1 decisão
 * tipada por resposta, em paralelo). Células em `hitl`/`abstain`/falha escalam
 * para o painel `judgeModelIds` (o refJudge LLM, pointwise); se a escalada
 * falhar e o Jev tiver veredito declarado, ele fica com confiança da banda
 * (triagem humana) — e sem veredito declarado, AUSENTE com o motivo.
 */
export async function judgeStageReferenceJev(
  opts: JudgeStageReferenceParams & { jevJudge?: JevJudgeConfig },
): Promise<JevReferenceJudgeResult> {
  const { stage, responses, contestants, apiKey, ctx, maxPricePerMTok, reasoningLevel } = opts;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const jev = resolveJevJudge(opts.jevJudge);
  const judgeIds = [...new Set(opts.judgeModelIds ?? [])];
  const pre = applyPreRules(stage, responses, contestants.map((c) => c.id));

  const verdictByContestant = { ...pre.verdictByContestant };
  const explanationByContestant = { ...pre.explanationByContestant };
  const verdictSourceByContestant = { ...pre.verdictSourceByContestant };
  const verdictErrorByContestant = { ...pre.verdictErrorByContestant };
  const confidenceByContestant: Record<string, JudgeConfidence> = {};
  const judgeVotesByContestant: Record<string, JudgeVote[]> = {};
  const jevByContestant: Record<string, JevJudgeCell> = {};
  let jevFallback: JevJudgeFallback | undefined;

  const judgeModelId = judgeIds.length > 0 ? [jev.decisionModelId, ...judgeIds].join('+') : jev.decisionModelId;
  const result = (inconclusive?: boolean): JevReferenceJudgeResult => ({
    verdictByContestant,
    explanationByContestant,
    verdictSourceByContestant,
    verdictErrorByContestant,
    ...(Object.keys(confidenceByContestant).length > 0 ? { confidenceByContestant } : {}),
    ...(Object.keys(judgeVotesByContestant).length > 0 ? { judgeVotesByContestant } : {}),
    judgeModelId,
    ...(Object.keys(jevByContestant).length > 0 ? { jevByContestant } : {}),
    ...(jevFallback ? { jevFallback } : {}),
    ...(inconclusive ? { inconclusive: true } : {}),
  });

  if (pre.groundTruth) return { ...result(), judgeModelId: 'ground-truth' };
  if (pre.judgeable.length === 0) return result(true);

  // LGPD: Jev fora da allowlist ZDR => fallback TOTAL ao painel LLM.
  const bloqueio = jevBlockedByPolicy(ctx, jev.decisionModelId);
  if (bloqueio) {
    jevFallback = bloqueio;
    return escalateReference(pre.judgeable, result);
  }

  // UMA decisão tipada por resposta, em paralelo (limitador global gateia).
  const calls = await Promise.all(
    pre.judgeable.map((r) =>
      judgeOneJev({
        apiKey,
        stage,
        reference: stage.reference?.trim() ?? '',
        candidate: r.text,
        jev,
        ctx,
        timeoutMs,
      }),
    ),
  );
  pre.judgeable.forEach((r, i) => {
    jevByContestant[r.contestantId] = calls[i].cell;
  });

  // Banda AUTO: o veredito DECLARADO do Jev decide já (o resto escala depois).
  for (const r of pre.judgeable) {
    const cell = jevByContestant[r.contestantId];
    if (cell.band !== 'auto' || !cell.verdict) continue;
    verdictByContestant[r.contestantId] = cell.verdict;
    explanationByContestant[r.contestantId] = cell.motivo;
    verdictSourceByContestant[r.contestantId] = 'jev';
    confidenceByContestant[r.contestantId] = jevConfidenceOf(cell.band);
    judgeVotesByContestant[r.contestantId] = [
      {
        judgeModelId: jev.decisionModelId,
        verdict: cell.verdict,
        explanation: cell.motivo,
        confianca: jevConfidenceOf(cell.band),
      },
    ];
    delete verdictErrorByContestant[r.contestantId];
  }

  const escaladas = pre.judgeable.filter((r) => needsEscalation(jevByContestant[r.contestantId]));
  if (escaladas.length > 0) return escalateReference(escaladas, result);

  // Sem escalada pendente: célula sem veredito (decisão falhou, painel vazio) =
  // erro honesto — nunca nota inventada.
  for (const r of pre.judgeable) {
    if (verdictByContestant[r.contestantId] === undefined && verdictErrorByContestant[r.contestantId] === undefined) {
      verdictErrorByContestant[r.contestantId] = {
        kind: 'judge_failed',
        message: 'Decisão JEV sem veredito declarado e sem painel LLM para escalada.',
      };
    }
  }
  return result();

  /** Escala o subconjunto para o refJudge LLM e mescla no resultado. */
  async function escalateReference(
    subset: CompetitorResponse[],
    done: (inconclusive?: boolean) => JevReferenceJudgeResult,
  ): Promise<JevReferenceJudgeResult> {
    if (subset.length === 0) return done();
    if (judgeIds.length === 0) {
      // Sem painel: fica o veredito declarado do Jev (confiança da banda) ou o erro.
      for (const r of subset) {
        const cell = jevByContestant[r.contestantId];
        if (cell?.verdict) {
          verdictByContestant[r.contestantId] = cell.verdict;
          explanationByContestant[r.contestantId] = cell.motivo;
          verdictSourceByContestant[r.contestantId] = 'jev';
          confidenceByContestant[r.contestantId] = jevConfidenceOf(cell.band);
          delete verdictErrorByContestant[r.contestantId];
        } else if (verdictErrorByContestant[r.contestantId] === undefined) {
          verdictErrorByContestant[r.contestantId] = {
            kind: cell ? 'judge_failed' : 'judge_failed',
            message: cell
              ? `Banda ${cell.band} sem painel LLM para escalada.`
              : 'Decisão JEV falhou e não há painel LLM para escalada.',
          };
        }
      }
      return done();
    }
    const esc = await judgeStageReference({
      stage,
      responses: subset,
      contestants: contestants.filter((c) => subset.some((r) => r.contestantId === c.id)),
      judgeModelIds: judgeIds,
      apiKey,
      reasoningLevel,
      timeoutMs,
      ctx,
      maxPricePerMTok,
    });
    for (const r of subset) {
      const id = r.contestantId;
      const cell = jevByContestant[id];
      const vEsc = esc.verdictByContestant[id];
      if (cell) {
        const escala = escalationOf(cell);
        if (escala) cell.escalated = escala;
        if (vEsc) cell.source = (esc.verdictSourceByContestant?.[id] ?? 'judge') as VerdictSource;
      }
      if (vEsc) {
        verdictByContestant[id] = vEsc;
        explanationByContestant[id] = esc.explanationByContestant[id] ?? cell?.motivo ?? '';
        verdictSourceByContestant[id] = esc.verdictSourceByContestant?.[id] ?? 'judge';
        delete verdictErrorByContestant[id];
        if (esc.confidenceByContestant?.[id]) confidenceByContestant[id] = esc.confidenceByContestant[id];
        else if (cell) confidenceByContestant[id] = jevConfidenceOf(cell.band);
        if (esc.judgeVotesByContestant?.[id]) judgeVotesByContestant[id] = esc.judgeVotesByContestant[id];
      } else if (cell?.verdict) {
        // Escalada falhou: o veredito DECLARADO do Jev continua legítimo (fraco).
        verdictByContestant[id] = cell.verdict;
        explanationByContestant[id] = cell.motivo;
        verdictSourceByContestant[id] = 'jev';
        confidenceByContestant[id] = jevConfidenceOf(cell.band);
        delete verdictErrorByContestant[id];
      } else {
        verdictErrorByContestant[id] =
          esc.verdictErrorByContestant?.[id] ?? {
            kind: 'judge_failed',
            message: 'Decisão JEV falhou e a escalada ao painel LLM não produziu veredito.',
          };
      }
    }
    return done();
  }
}

// ---------------------------------------------------------------------------
// Caminho 2: fallback listwise (contrato JudgeResult, etapa sem gabarito)
// ---------------------------------------------------------------------------

export type JevListwiseJudgeResult = JudgeResult & {
  jevByContestant?: Record<string, JevJudgeCell>;
  jevFallback?: JevJudgeFallback;
};

/**
 * Sem gabarito (compare clássico), o Jev ainda julga pointwise contra a tarefa
 * e a rubrica — o ranking sai do score suave das probabilidades (e o contrato
 * "ranking por veredito" é preservado: veredito primeiro, score suave como
 * desempate). Células fora de `auto` escalam para o juiz listwise LLM.
 */
export async function judgeStageListwiseJev(
  opts: JudgeStageParams & { jevJudge?: JevJudgeConfig; contestants?: Contestant[] },
): Promise<JevListwiseJudgeResult> {
  const { stage, responses, apiKey, ctx, maxPricePerMTok, reasoningLevel } = opts;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const jev = resolveJevJudge(opts.jevJudge);
  const judgeIds = [...new Set(opts.judgeModelIds ?? [])];
  const orderedIds = opts.contestants?.map((c) => c.id) ?? responses.map((r) => r.contestantId);
  const pre = applyPreRules(stage, responses, orderedIds);

  const verdictByContestant: Record<string, Verdict> = { ...pre.verdictByContestant };
  const verdictSourceByContestant: Record<string, VerdictSource> = { ...pre.verdictSourceByContestant };
  const verdictErrorByContestant: Record<string, VerdictError> = { ...pre.verdictErrorByContestant };
  const jevByContestant: Record<string, JevJudgeCell> = {};
  const judges: SingleJudgeResult[] = [];
  let jevFallback: JevJudgeFallback | undefined;

  const softScore = (id: string): number => {
    const cell = jevByContestant[id];
    const p = cell?.probabilities;
    if (p) return (p.resolve ?? 0) * 1 + (p.parcial ?? 0) * 0.5;
    const v = verdictByContestant[id];
    return v === 'resolve' ? 1 : v === 'parcial' ? 0.5 : v === 'nao' ? 0 : -1;
  };
  const verdictScore = (id: string): number => {
    const v = verdictByContestant[id];
    return v === 'resolve' ? 2 : v === 'parcial' ? 1 : v === 'nao' ? 0 : -1;
  };

  const result = (inconclusive?: boolean): JevListwiseJudgeResult => {
    const rankedContestantIds = [...new Set(responses.map((r) => r.contestantId))].sort((a, b) => {
      const dv = verdictScore(b) - verdictScore(a);
      if (dv !== 0) return dv;
      const ds = softScore(b) - softScore(a);
      if (ds !== 0) return ds;
      return 0;
    });
    const acceptableByContestant: Record<string, boolean> = {};
    for (const [id, v] of Object.entries(verdictByContestant)) acceptableByContestant[id] = v !== 'nao';
    return {
      rankedContestantIds,
      acceptableByContestant,
      verdictByContestant,
      verdictSourceByContestant,
      verdictErrorByContestant,
      judges,
      blindMap: {},
      rawJudgeText: '',
      ...(Object.keys(jevByContestant).length > 0 ? { jevByContestant } : {}),
      ...(jevFallback ? { jevFallback } : {}),
      ...(inconclusive ? { inconclusive: true } : {}),
    };
  };

  if (pre.groundTruth) {
    judges.push({
      judgeModelId: 'ground-truth',
      rankedContestantIds: pre.judgeable.map((r) => r.contestantId),
      verdicts: pre.judgeable.map(
        (r): JudgeVerdict => ({
          contestantId: r.contestantId,
          verdict: verdictByContestant[r.contestantId],
          motivo: explanationOf(pre, r.contestantId),
        }),
      ),
      blindMap: {},
    });
    return result();
  }
  if (pre.judgeable.length === 0) return result(true);

  const bloqueio = jevBlockedByPolicy(ctx, jev.decisionModelId);
  if (bloqueio) jevFallback = bloqueio;

  if (!bloqueio) {
    const calls = await Promise.all(
      pre.judgeable.map((r) =>
        judgeOneJev({
          apiKey,
          stage,
          reference: stage.reference?.trim() ?? '',
          candidate: r.text,
          jev,
          ctx,
          timeoutMs,
        }),
      ),
    );
    pre.judgeable.forEach((r, i) => {
      jevByContestant[r.contestantId] = calls[i].cell;
    });
  }

  const escaladas = bloqueio
    ? pre.judgeable
    : pre.judgeable.filter((r) => needsEscalation(jevByContestant[r.contestantId]));

  // Banda AUTO decide já (o veredito DECLARADO do Jev); o resto escala abaixo.
  if (!bloqueio) {
    for (const r of pre.judgeable) {
      const cell = jevByContestant[r.contestantId];
      if (cell.band !== 'auto' || !cell.verdict) continue;
      verdictByContestant[r.contestantId] = cell.verdict;
      verdictSourceByContestant[r.contestantId] = 'jev';
      delete verdictErrorByContestant[r.contestantId];
    }
  }

  if (escaladas.length > 0) {
    if (judgeIds.length > 0) {
      const esc = await judgeStage({
        apiKey,
        stage,
        responses: escaladas,
        judgeModelIds: judgeIds,
        timeoutMs,
        ...(opts.passes ? { passes: opts.passes } : {}),
        ctx,
        maxPricePerMTok,
        reasoningLevel,
      });
      judges.push(...esc.judges);
      for (const r of escaladas) {
        const id = r.contestantId;
        const cell = jevByContestant[id];
        const vEsc = esc.verdictByContestant?.[id];
        if (cell) {
          const escala = escalationOf(cell);
          if (escala) cell.escalated = escala;
          if (vEsc) cell.source = (esc.verdictSourceByContestant?.[id] ?? 'judge') as VerdictSource;
        }
        if (vEsc) {
          verdictByContestant[id] = vEsc;
          verdictSourceByContestant[id] = esc.verdictSourceByContestant?.[id] ?? 'judge';
          delete verdictErrorByContestant[id];
        } else if (cell?.verdict) {
          verdictByContestant[id] = cell.verdict;
          verdictSourceByContestant[id] = 'jev';
          delete verdictErrorByContestant[id];
        } else {
          verdictErrorByContestant[id] =
            esc.verdictErrorByContestant?.[id] ?? {
              kind: 'judge_failed',
              message: 'Decisão JEV falhou e a escalada ao juiz listwise LLM não produziu veredito.',
            };
        }
      }
    } else {
      for (const r of escaladas) {
        const cell = jevByContestant[r.contestantId];
        if (cell?.verdict) {
          verdictByContestant[r.contestantId] = cell.verdict;
          verdictSourceByContestant[r.contestantId] = 'jev';
          delete verdictErrorByContestant[r.contestantId];
        } else {
          verdictErrorByContestant[r.contestantId] = {
            kind: 'judge_failed',
            message: 'Decisão JEV sem veredito e sem juiz LLM configurado para escalada.',
          };
        }
      }
    }
  } else if (!bloqueio) {
    // Nada escalou: célula sem veredito (decisão falhou, painel vazio) = erro.
    for (const r of pre.judgeable) {
      if (verdictByContestant[r.contestantId] === undefined) {
        verdictErrorByContestant[r.contestantId] = {
          kind: 'judge_failed',
          message: 'Decisão JEV sem veredito declarado.',
        };
      }
    }
  }

  // Painel do Jev (placar aditivo): um "juiz" — o modelo de decisão.
  const votos = pre.judgeable.filter((r) => verdictByContestant[r.contestantId] !== undefined);
  if (votos.length > 0) {
    judges.unshift({
      judgeModelId: jev.decisionModelId,
      rankedContestantIds: votos
        .map((r) => r.contestantId)
        .sort((a, b) => verdictScore(b) - verdictScore(a) || softScore(b) - softScore(a)),
      verdicts: votos.map(
        (r): JudgeVerdict => ({
          contestantId: r.contestantId,
          verdict: verdictByContestant[r.contestantId],
          motivo: jevByContestant[r.contestantId]?.motivo ?? '',
        }),
      ),
      blindMap: {},
    });
  }
  return result();
}

function explanationOf(pre: PreRules, id: string): string {
  return pre.explanationByContestant[id] ?? '';
}

// ---------------------------------------------------------------------------
// Caminho 3: ordem de duelo (pairwise das finais)
// ---------------------------------------------------------------------------

export type JevDuelOrderValue = {
  winner: 'A' | 'B' | 'tie';
  explanation: string;
  /** Sem canário no Jev (saída tipada não passa por parse de texto). */
  canary: string;
  confianca?: JudgeConfidence;
};

export type JevDuelAttempt =
  | { ok: true; value: JevDuelOrderValue; calls: number; finish?: JudgeCallFinish }
  | { ok: false; error: VerdictError; calls: number; finish?: JudgeCallFinish };

/**
 * UMA ordem de duelo com o juiz JEV: pergunta `choice` (a_melhor/b_melhor/
 * empate) sobre o par. Banda `auto` decide sozinha; `hitl`/`abstain`/falha
 * escalam para o juiz LLM do duelo (`fallback` — o `judgeOnce` clássico).
 */
export async function judgeDuelOrderJev(params: {
  apiKey: string;
  stage: StageSpec;
  reference: string;
  textA: string;
  textB: string;
  jevJudge?: JevJudgeConfig;
  ctx?: RunCtx;
  timeoutMs?: number;
  fallback: () => Promise<JevDuelAttempt>;
}): Promise<JevDuelAttempt> {
  const jev = resolveJevJudge(params.jevJudge);
  const rubric = params.stage.rubric?.trim() || undefined;
  const reference = params.reference.trim() || undefined;
  const state: JevState = {
    tarefa: params.stage.question,
    contexto: params.stage.productContext,
    ...(rubric ? { rubrica: rubric } : {}),
    ...(reference ? { referencia: reference } : {}),
    resposta_a: params.textA,
    resposta_b: params.textB,
  };
  const questions: JevQuestionSpec[] = [
    {
      id: 'vencedor',
      type: 'choice',
      instructions:
        'Você é um avaliador técnico estrito. Compare as duas RESPOSTAS CANDIDATAS (campos ' +
        '`resposta_a` e `resposta_b`) para a TAREFA (campo `tarefa`) sob o CONTEXTO (`contexto`). ' +
        'Quando houver RUBRICA (`rubrica`), ela tem prioridade sobre a REFERÊNCIA (`referencia`), ' +
        'que é apoio candidato e pode estar errada. Decida qual resposta é MELHOR (corretude e ' +
        'completude para o exigido; ignore redação/estilo salvo pedido de forma).',
      criteria: {
        a_melhor: {
          what: 'A resposta A é claramente melhor que a B.',
          not_for: 'Qualidade equivalente (é "empate").',
        },
        b_melhor: {
          what: 'A resposta B é claramente melhor que a A.',
          not_for: 'Qualidade equivalente (é "empate").',
        },
        empate: {
          what: 'Qualidade equivalente — inclui duas respostas ruins ou duas boas demais para distinguir.',
          not_for: 'Uma das respostas é claramente melhor.',
        },
      },
    },
  ];
  const stateView: JevStateView = {
    fields: [
      { from: 'tarefa', as: 'tarefa' },
      { from: 'contexto', as: 'contexto' },
      ...(rubric ? [{ from: 'rubrica', as: 'rubrica' }] : []),
      ...(reference ? [{ from: 'referencia', as: 'referencia' }] : []),
      { from: 'resposta_a', as: 'resposta_a', untrusted: true },
      { from: 'resposta_b', as: 'resposta_b', untrusted: true },
    ],
  };
  const spec: JevSpec = {
    id: '',
    label: 'juiz-jev-duelo',
    questions,
    stateView,
    policy: { questions: { vencedor: { auto: jev.auto, hitl: jev.hitl, signal: 'confidence' } } },
  };
  spec.id = specIdOf(spec);
  const wireQs = wireQuestionsOf(spec);

  const CHOICE_TO_WINNER: Record<string, JevDuelOrderValue['winner']> = {
    a_melhor: 'A',
    b_melhor: 'B',
    empate: 'tie',
  };

  try {
    const res = await decide({
      apiKey: params.apiKey,
      modelId: jev.decisionModelId,
      state,
      questions: wireQs,
      role: 'duel',
      signal: params.ctx?.signal,
      sink: params.ctx?.sink,
      ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
    });
    const v = validateDecisionsResponse(wireQs, res.answers);
    const a = v.answers['vencedor'] as JevWireAnswer | undefined;
    const invalid = v.invalid['vencedor'];
    if (invalid || !a || a.type !== 'choice' || !(a.choice in CHOICE_TO_WINNER)) {
      return params.fallback();
    }
    const pTop = a.probabilities ? Math.max(...Object.values(a.probabilities)) : undefined;
    const signal = a.confidence ?? pTop;
    const band: JevJudgeBand =
      signal === undefined ? 'abstain' : signal >= jev.auto ? 'auto' : signal >= jev.hitl ? 'hitl' : 'abstain';
    if (band !== 'auto') return params.fallback();
    const winner = CHOICE_TO_WINNER[a.choice];
    const p = a.probabilities?.[a.choice];
    return {
      ok: true,
      calls: 1,
      value: {
        winner,
        explanation: `Juiz JEV: ${a.choice}${p !== undefined ? ` (p=${fmtP(p)})` : ''}${
          a.confidence !== undefined ? ` · confiança ${fmtP(a.confidence)}` : ''
        } · banda auto`,
        canary: '',
        confianca: 'alta',
      },
      ...(res.generationId ? { finish: { generationId: res.generationId } } : {}),
    };
  } catch (err) {
    if (isControlSignal(err)) throw err;
    return params.fallback();
  }
}

// ---------------------------------------------------------------------------
// Utilidades de record
// ---------------------------------------------------------------------------

/** Tipo de juiz efetivo por célula (diagnóstico/relatórios). */
export function jevJudgeKindOf(cell: JevJudgeCell | undefined): 'jev' | 'llm' | undefined {
  if (!cell) return undefined;
  return cell.source === 'jev' ? 'jev' : 'llm';
}
