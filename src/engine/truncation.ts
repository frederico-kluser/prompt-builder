// Deteccao de TRUNCAMENTO por chamada (IMPL-014 / R-07b:DEC-2 + REC-2).
//
// Os provedores devolvem 200 OK tanto para a resposta completa quanto para a
// cortada no teto de `max_tokens` (OpenAI `length`, Anthropic `max_tokens`,
// Gemini `MAX_TOKENS`) — sem ler os sinais de fim as duas sao
// indistinguiveis, e a cortada virava veredito 'nao' em silencio. O caso mais
// comum hoje e o raciocinio comer o teto inteiro: `finish_reason: length`,
// `content` vazio e `completion_tokens` todos de raciocinio.
//
// Modulo PURO (sem rede, sem Node): o gateway (`src/openrouter.ts`) decide o
// `truncated` de cada chamada aqui e entrega os sinais ao ledger (ponto unico
// da contabilidade), que os agrega POR PAPEL com `tallyFinish` — e assim que o
// juiz, o duelo, o datagen e o reescritor tem os sinais no RunRecord sem cada
// papel persisti-los. Competidor e gabarito guardam, alem disso, os sinais
// por chamada. Os dois orquestradores (Node e SPA) calculam a
// `truncationRate` da run com a mesma funcao — fonte unica, o web importa
// direto de `src/engine/`.

import type {
  CallFinishSignals,
  CostRole,
  FinishSignalCounts,
  JudgeCutKind,
  TruncationSignal,
  VerdictError,
} from '../types.js';

/**
 * `native_finish_reason` que significam "parou no teto", comparados sem caixa:
 * OpenAI/Mistral `length`, Anthropic `max_tokens`, Gemini/Cohere `MAX_TOKENS`,
 * Responses API `max_output_tokens`, vLLM `model_length` (janela esgotada).
 */
const NATIVE_LENGTH = new Set(['length', 'max_tokens', 'max_output_tokens', 'model_length']);

/**
 * "reasoning_tokens ≈ teto": >= 95% do `max_tokens` enviado. A folga de 5%
 * cobre a diferenca de contagem entre provedores (alguns somam o separador de
 * raciocinio, outros nao) sem virar um limiar arbitrariamente baixo.
 */
export const REASONING_CAP_RATIO = 0.95;

/** Retry unico por truncamento: teto x2 (R-07b:DEC-2). */
export const TRUNCATION_RETRY_FACTOR = 2;

/** Acima desta fracao de chamadas truncadas numa run, CLI e UI alertam (R-07b:REC-2). */
export const TRUNCATION_ALERT_RATE = 0.02;

/** O que o gateway observou no fim de UMA chamada. */
export interface FinishObservation {
  finishReason?: string;
  nativeFinishReason?: string;
  reasoningTokens?: number;
  /** `completion_tokens` (inclui raciocinio). */
  tokensOut: number;
  /** Tamanho do conteudo VISIVEL (sem a recusa declarada). */
  contentChars: number;
  /** `max_tokens` enviado (ausente = sem teto no corpo => `reasoning_at_cap` nao se aplica). */
  maxTokens?: number;
  /**
   * O conteudo vazio JA tem explicacao (bloqueio de moderacao, recusa
   * declarada em `message.refusal`): nao conta como `empty_with_tokens`.
   */
  explainedEmpty?: boolean;
}

/** Todos os sinais presentes — inclusive os auxiliares que, sozinhos, nao decidem. */
export function truncationSignals(o: FinishObservation): TruncationSignal[] {
  const sinais: TruncationSignal[] = [];
  if (o.finishReason?.trim().toLowerCase() === 'length') sinais.push('finish_length');
  const nativo = o.nativeFinishReason?.trim().toLowerCase();
  if (nativo && NATIVE_LENGTH.has(nativo)) sinais.push('native_length');
  if (
    typeof o.maxTokens === 'number' &&
    o.maxTokens > 0 &&
    typeof o.reasoningTokens === 'number' &&
    o.reasoningTokens >= REASONING_CAP_RATIO * o.maxTokens
  ) {
    sinais.push('reasoning_at_cap');
  }
  if (!o.explainedEmpty && o.contentChars === 0 && o.tokensOut > 0) sinais.push('empty_with_tokens');
  return sinais;
}

/**
 * A DECISAO. `length` (normalizado ou nativo) decide sozinho. Os sinais
 * auxiliares (`reasoning_at_cap`, `empty_with_tokens`) decidem quando o
 * provedor nao declarou `finish_reason` nenhum; com um motivo explicito que
 * nao e teto (ex.: `stop`), so decidem se os DOIS concordarem — o raciocinio
 * comeu o teto E nao sobrou conteudo. Assim uma resposta vazia com `stop`
 * legitimo segue sendo resposta (o juiz a pune como 'nao'), e um `stop` mal
 * rotulado por um provedor com o teto consumido nao passa como completo.
 */
export function isTruncated(o: FinishObservation, sinais: TruncationSignal[] = truncationSignals(o)): boolean {
  if (sinais.includes('finish_length') || sinais.includes('native_length')) return true;
  const semMotivo = !o.finishReason?.trim() && !o.nativeFinishReason?.trim();
  if (semMotivo) return sinais.includes('reasoning_at_cap') || sinais.includes('empty_with_tokens');
  return sinais.includes('reasoning_at_cap') && sinais.includes('empty_with_tokens');
}

/** O que `finishSignalsOf` le do `ChatCompletionResult` (estrutural: modulo puro). */
export interface FinishedCallLike {
  text: string;
  tokensOut: number;
  reasoningTokens?: number;
  finishReason?: string;
  nativeFinishReason?: string;
  truncated?: boolean;
  truncationSignals?: TruncationSignal[];
}

/**
 * Registro persistido (`CallFinishSignals`) de uma chamada que completou. NAO
 * recalcula a decisao: ela e do gateway (`ChatCompletionResult.truncated`),
 * ponto unico — aqui so se copia o que ele observou + o teto usado.
 * `firstAttempt`: sinais da 1a tentativa (a que truncou) quando esta chamada e
 * o retry com teto x2 — marca `truncationRetried` e guarda os dois.
 */
export function finishSignalsOf(
  res: FinishedCallLike,
  maxTokens: number | undefined,
  firstAttempt?: CallFinishSignals,
): CallFinishSignals {
  return {
    ...(res.finishReason ? { finishReason: res.finishReason } : {}),
    ...(res.nativeFinishReason ? { nativeFinishReason: res.nativeFinishReason } : {}),
    ...(typeof res.reasoningTokens === 'number' ? { reasoningTokens: res.reasoningTokens } : {}),
    tokensOut: res.tokensOut,
    contentChars: res.text.length,
    ...(typeof maxTokens === 'number' && maxTokens > 0 ? { maxTokens } : {}),
    truncated: res.truncated === true,
    ...(res.truncationSignals?.length ? { truncationSignals: [...res.truncationSignals] } : {}),
    ...(firstAttempt ? { truncationRetried: true, firstAttempt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Agregado por papel (ledger -> RunRecord.finishSignalsByRole)
// ---------------------------------------------------------------------------

/** Chave do histograma quando o provedor nao mandou `finish_reason`/`native_finish_reason`. */
export const FINISH_ABSENT = '(none)';
/** Chave que absorve motivos novos depois de `MAX_REASON_KEYS` distintos (record limitado). */
export const FINISH_OTHER = '(other)';
/** Teto de chaves distintas por histograma: o texto vem do provedor, o record e reescrito inteiro a cada save. */
export const MAX_REASON_KEYS = 24;

export function emptyFinishCounts(): FinishSignalCounts {
  return { calls: 0, truncated: 0, finishReasons: {}, nativeFinishReasons: {}, signals: {} };
}

function bumpReason(hist: Record<string, number>, raw: string | undefined): void {
  const key = raw?.trim().slice(0, 48) || FINISH_ABSENT;
  const slot = key in hist || Object.keys(hist).length < MAX_REASON_KEYS ? key : FINISH_OTHER;
  hist[slot] = (hist[slot] ?? 0) + 1;
}

/**
 * Soma UMA chamada que completou ao agregado do papel (muta `counts`). Os 4
 * sinais do R-07b:REC-2 ficam contados: motivo normalizado, motivo nativo,
 * raciocinio ≈ teto e conteudo vazio com tokens (os dois ultimos em `signals`).
 */
export function tallyFinish(counts: FinishSignalCounts, call: CallFinishSignals): FinishSignalCounts {
  counts.calls += 1;
  if (call.truncated) counts.truncated += 1;
  bumpReason(counts.finishReasons, call.finishReason);
  bumpReason(counts.nativeFinishReasons, call.nativeFinishReason);
  for (const sinal of call.truncationSignals ?? []) {
    counts.signals[sinal] = (counts.signals[sinal] ?? 0) + 1;
  }
  // IMPL-015: 2a dimensao (papel x esforco). So conta quem levou `reasoning`
  // explicito — o resto e o padrao do provedor, derivado por diferenca.
  const effort = call.effort?.trim();
  if (effort) {
    const hist = (counts.byEffort ??= {});
    const key = effort.slice(0, 24);
    const slot = key in hist || Object.keys(hist).length < MAX_REASON_KEYS ? key : FINISH_OTHER;
    const c = (hist[slot] ??= { calls: 0, truncated: 0 });
    c.calls += 1;
    if (call.truncated) c.truncated += 1;
  }
  return counts;
}

/** Copia profunda (o record nao pode compartilhar objeto vivo com o ledger). */
export function cloneFinishCounts(c: FinishSignalCounts): FinishSignalCounts {
  return {
    calls: c.calls,
    truncated: c.truncated,
    finishReasons: { ...c.finishReasons },
    nativeFinishReasons: { ...c.nativeFinishReasons },
    signals: { ...c.signals },
    ...(c.byEffort
      ? { byEffort: Object.fromEntries(Object.entries(c.byEffort).map(([k, v]) => [k, { ...v }])) }
      : {}),
  };
}

/**
 * O esforco de raciocinio que o corpo MONTADO leva (IMPL-015) — o degrau ja
 * encaixado por `applyReasoning` (nao o pedido cru): `{ effort }` => o degrau;
 * `{ enabled: false }` => 'off'; sem `reasoning` => `undefined` (padrao do
 * provedor). Puro: o gateway chama com o `body` que vai no fio.
 */
export function effortLabelOf(body: Record<string, unknown>): string | undefined {
  const r = body.reasoning;
  if (!r || typeof r !== 'object') return undefined;
  const { effort, enabled } = r as { effort?: unknown; enabled?: unknown };
  if (typeof effort === 'string' && effort.trim()) return effort.trim();
  if (enabled === false) return 'off';
  return undefined;
}

/**
 * Taxa de truncamento da RUN a partir do agregado por papel: TODAS as chamadas
 * que completaram, de todo papel (competidor, gabarito, juiz, duelo, datagen,
 * reescritor). E o que vai para `RunRecord.truncationRate`/`truncationCounts`.
 */
export function truncationStatsByRole(
  byRole: Partial<Record<CostRole, Pick<FinishSignalCounts, 'calls' | 'truncated'>>> | undefined,
): TruncationStats {
  let calls = 0;
  let truncated = 0;
  for (const c of Object.values(byRole ?? {})) {
    if (!c) continue;
    calls += c.calls;
    truncated += c.truncated;
  }
  return { calls, truncated, rate: calls > 0 ? Number((truncated / calls).toFixed(4)) : 0 };
}

/** Teto do retry por truncamento (inteiro, nunca menor que o original + 1). */
export function retryMaxTokens(maxTokens: number): number {
  return Math.max(maxTokens + 1, Math.ceil(maxTokens * TRUNCATION_RETRY_FACTOR));
}

/** Forma minima que `truncationStats` le de um StageRecord (Node e SPA). */
interface StageLike {
  responses?: ReadonlyArray<{ truncated?: boolean; truncationRetried?: boolean }>;
  gabaritoCall?: { truncated?: boolean; truncationRetried?: boolean };
}

export interface TruncationStats {
  /** Chamadas com sinal de fim observado (cada tentativa conta; o retry x2 e uma chamada). */
  calls: number;
  /** Quantas dessas sairam truncadas. */
  truncated: number;
  /** truncated / calls, 4 casas (0 quando nao houve chamada). */
  rate: number;
}

/**
 * Visao POR ETAPA do truncamento — so competidores + gabaritos, derivada do
 * que o record guarda por chamada (CADA TENTATIVA conta: a 1a que truncou e
 * foi repetida tambem e uma chamada truncada — e justamente o que calibra o
 * teto, R-07b:REC-1). Respostas sem `truncated` (erro de infra, 403, records
 * antigos, agente) ficam fora do denominador. A `truncationRate` da run vem
 * do agregado por papel (`truncationStatsByRole`), que cobre tambem juiz,
 * duelo e datagen; esta funcao e a conferencia independente das duas fatias
 * que tem sinal por chamada. Puro e idempotente.
 */
export function truncationStats(stages: ReadonlyArray<StageLike>): TruncationStats {
  let calls = 0;
  let truncated = 0;
  const contar = (c: { truncated?: boolean; truncationRetried?: boolean }): void => {
    const repetida = c.truncationRetried === true;
    if (typeof c.truncated !== 'boolean') {
      // O retry falhou (erro/403) depois de uma 1a tentativa truncada: essa 1a
      // chamada completou e truncou — conta; a que falhou nao tem sinal de fim.
      if (repetida) {
        calls += 1;
        truncated += 1;
      }
      return;
    }
    calls += repetida ? 2 : 1;
    truncated += (repetida ? 1 : 0) + (c.truncated ? 1 : 0);
  };
  for (const st of stages) {
    for (const r of st.responses ?? []) contar(r);
    if (st.gabaritoCall) contar(st.gabaritoCall);
  }
  return { calls, truncated, rate: calls > 0 ? Number((truncated / calls).toFixed(4)) : 0 };
}

/**
 * Os campos de truncamento do RunRecord a partir do agregado por papel do
 * ledger — o MESMO calculo nos dois orquestradores (chamado no `syncLedger`).
 */
export function truncationRecordFields(finishByRole: Partial<Record<CostRole, FinishSignalCounts>>): {
  finishSignalsByRole: Partial<Record<CostRole, FinishSignalCounts>>;
  truncationRate: number;
  truncationCounts: { calls: number; truncated: number };
} {
  const t = truncationStatsByRole(finishByRole);
  return {
    finishSignalsByRole: finishByRole,
    truncationRate: t.rate,
    truncationCounts: { calls: t.calls, truncated: t.truncated },
  };
}

/** Rotulo PT-BR de cada papel no texto do alerta (espelha `ROLE_LABEL` de budget.ts sem importa-lo: sem ciclo). */
const ROLE_PT: Record<CostRole, string> = {
  datagen: 'datagen',
  gabarito: 'gabarito',
  competitor: 'competidor',
  judge: 'juiz',
  duel: 'duelo',
  rewriter: 'reescritor',
  agent: 'agente',
};

/**
 * Mensagem de alerta (PT-BR) quando a taxa passa de 2%; `undefined` abaixo.
 * Estritamente ACIMA do limiar ("> 2%"), como no criterio da pesquisa. Com
 * `byRole`, diz QUAIS papeis truncaram — o teto a subir (ou o esforco a
 * baixar) depende de quem foi cortado: competidor, gabarito ou juiz.
 */
export function truncationAlert(
  stats: Pick<TruncationStats, 'calls' | 'truncated' | 'rate'>,
  byRole?: Partial<Record<CostRole, Pick<FinishSignalCounts, 'calls' | 'truncated'>>>,
): string | undefined {
  if (!(stats.calls > 0) || !(stats.rate > TRUNCATION_ALERT_RATE)) return undefined;
  const pct = (stats.rate * 100).toFixed(1).replace('.', ',');
  const papeis = Object.entries(byRole ?? {})
    .filter(([, c]) => c && c.truncated > 0)
    .map(([role, c]) => `${ROLE_PT[role as CostRole] ?? role} ${c!.truncated} de ${c!.calls}`);
  return (
    `${stats.truncated} de ${stats.calls} chamadas (${pct}%) saíram truncadas no teto de tokens` +
    (papeis.length ? ` (${papeis.join(', ')})` : '') +
    ` — acima do limite de ${(TRUNCATION_ALERT_RATE * 100).toFixed(0)}%. Etapas com resposta truncada ficaram ` +
    `fora do placar; aumente o teto (maxTokens/--max-output-tokens) ou baixe o esforço de raciocínio.`
  );
}

/** Respostas de competidor que TRUNCARAM (mesmo apos o retry) — o gatilho da etapa `incomplete`. */
export function truncatedResponses<R extends { truncated?: boolean }>(responses: ReadonlyArray<R>): R[] {
  return responses.filter((r) => r.truncated === true);
}

/**
 * Texto (PT-BR) do evento `stage.incomplete` por truncamento — o MESMO nos dois
 * orquestradores. Nunca inclui o texto das respostas (so quem, e em que teto).
 */
export function describeTruncatedStage(
  stageIndex: number,
  truncadas: ReadonlyArray<{ contestantId: string; maxTokens?: number }>,
  labelOf: (id: string) => string = (id) => id,
): string {
  const quem = truncadas
    .map((r) => `${labelOf(r.contestantId)}${typeof r.maxTokens === 'number' ? ` (teto ${r.maxTokens})` : ''}`)
    .join(', ');
  return (
    `Etapa ${stageIndex + 1} incompleta por truncamento: ${quem} — resposta cortada no teto de tokens ` +
    `mesmo após o retry com teto x2. Etapa fora do placar e das médias (não foi julgada).`
  );
}

/**
 * Aviso (PT-BR) do gabarito que CONTINUOU truncado depois do retry x2 e foi
 * descartado — vai no evento `stage.generated` (`warning`) dos dois
 * orquestradores. Regua cortada nao julga ninguem: a etapa segue SEM gabarito
 * (juiz listwise), fora do judge-score por referencia.
 */
export function describeTruncatedReference(stageIndex: number, call: CallFinishSignals): string {
  const sinais = call.truncationSignals?.length ? `; sinais: ${call.truncationSignals.join(', ')}` : '';
  return (
    `Gabarito da etapa ${stageIndex + 1} truncado no teto de ${call.maxTokens ?? '?'} tokens mesmo após o ` +
    `retry com teto x2 (${call.finishReason ?? call.nativeFinishReason ?? 'sem finish_reason'}${sinais}) — ` +
    `descartado; a etapa é julgada SEM gabarito (juiz listwise) e fica fora do judge-score por referência.`
  );
}

// ---------------------------------------------------------------------------
// IMPL-015 (R-08:REC-11): juiz truncado NAO e veredito + taxa papel x esforco
// ---------------------------------------------------------------------------

/**
 * Limiar de alerta POR CELULA papel x esforco (R-08:REC-11: "> 1%"). Mais
 * baixo que o da run (2%, R-07b): uma celula e uma configuracao concreta
 * (ex.: juiz em `high`) e 1% de vereditos perdidos nela ja pesa no placar.
 */
export const TRUNCATION_CELL_ALERT_RATE = 0.01;

/** Rotulo da celula das chamadas SEM `reasoning` no pedido (padrao do provedor). */
export const EFFORT_DEFAULT = 'padrão';

/** Uma celula da tabela papel x esforco. */
export interface TruncationCell {
  role: CostRole;
  effort: string;
  calls: number;
  truncated: number;
  /** truncated / calls, 4 casas. */
  rate: number;
  /** rate > TRUNCATION_CELL_ALERT_RATE. */
  alert: boolean;
}

const ROLE_ORDER: CostRole[] = ['datagen', 'gabarito', 'competitor', 'judge', 'duel', 'rewriter', 'agent'];

/**
 * A taxa de truncamento por papel x esforco (R-08:REC-11) a partir do
 * agregado do ledger (`RunRecord.finishSignalsByRole`). As chamadas sem
 * esforco explicito caem em `EFFORT_DEFAULT` (por diferenca — record anterior
 * ao IMPL-015 vira tudo `padrão`). Puro, ordem estavel (papel, esforco).
 */
export function truncationByRoleEffort(
  byRole: Partial<Record<CostRole, FinishSignalCounts>> | undefined,
): TruncationCell[] {
  const cells: TruncationCell[] = [];
  const cell = (role: CostRole, effort: string, calls: number, truncated: number): void => {
    if (!(calls > 0)) return;
    const t = Math.max(0, Math.min(truncated, calls));
    const rate = Number((t / calls).toFixed(4));
    cells.push({ role, effort, calls, truncated: t, rate, alert: rate > TRUNCATION_CELL_ALERT_RATE });
  };
  const roles = Object.keys(byRole ?? {}) as CostRole[];
  roles.sort((a, b) => {
    const ia = ROLE_ORDER.indexOf(a);
    const ib = ROLE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  for (const role of roles) {
    const c = byRole?.[role];
    if (!c || !(c.calls > 0)) continue;
    let somaCalls = 0;
    let somaTrunc = 0;
    for (const [effort, e] of Object.entries(c.byEffort ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      somaCalls += e.calls;
      somaTrunc += e.truncated;
      cell(role, effort, e.calls, e.truncated);
    }
    cell(role, EFFORT_DEFAULT, c.calls - somaCalls, c.truncated - somaTrunc);
  }
  return cells;
}

/**
 * Alerta (PT-BR) das celulas papel x esforco acima de 1%; `undefined` se
 * nenhuma passar. Diz a combinacao exata a mexer (teto do papel ou esforco).
 */
export function truncationCellAlert(cells: ReadonlyArray<TruncationCell>): string | undefined {
  const acima = cells.filter((c) => c.alert);
  if (acima.length === 0) return undefined;
  const lista = acima
    .map((c) => `${ROLE_PT[c.role] ?? c.role} @ ${c.effort}: ${c.truncated} de ${c.calls} (${pctBr(c.rate)})`)
    .join('; ');
  return (
    `Truncamento acima de ${(TRUNCATION_CELL_ALERT_RATE * 100).toFixed(0)}% por papel × esforço — ${lista}. ` +
    `Veredito de juiz/duelo truncado é descartado (sem veredito, nunca 'parcial' nem empate); ` +
    `suba o teto do papel ou baixe o esforço de raciocínio.`
  );
}

function pctBr(rate: number): string {
  return `${(rate * 100).toFixed(1).replace('.', ',')}%`;
}

/** O que o juiz le do fim de UMA chamada (estrutural: `ChatCompletionResult` serve). */
export interface JudgeReplyFinish {
  text: string;
  truncated?: boolean;
  finishReason?: string;
  nativeFinishReason?: string;
  truncationSignals?: ReadonlyArray<string>;
}

/**
 * A saida do juiz foi CORTADA? (IMPL-015). Checado ANTES do parse: conteudo
 * truncado nunca vira veredito — nem se, por acaso, o pedaco for um JSON
 * valido. `truncated` do gateway (length normalizado/nativo, raciocinio no
 * teto) ou `finish_reason` `length` => 'truncated'; `finish_reason` (ou nativo)
 * `timeout` => 'timeout'. `undefined` = saida completa, pode ir ao parse.
 */
export function judgeReplyCut(reply: JudgeReplyFinish): VerdictError | undefined {
  const fr = reply.finishReason?.trim().toLowerCase();
  const nativo = reply.nativeFinishReason?.trim().toLowerCase();
  const motivo = [reply.finishReason, reply.nativeFinishReason].filter(Boolean).join(' / ') || 'sem finish_reason';
  if (reply.truncated === true || fr === 'length' || (nativo !== undefined && NATIVE_LENGTH.has(nativo))) {
    const sinais = reply.truncationSignals?.length ? `; sinais: ${reply.truncationSignals.join(', ')}` : '';
    return {
      kind: 'truncated',
      message:
        `saída do juiz cortada no teto de tokens (${motivo}${sinais}) — veredito descartado, ` +
        `nunca lido de conteúdo truncado`,
    };
  }
  if (fr === 'timeout' || nativo === 'timeout') {
    return {
      kind: 'timeout',
      message: `saída do juiz cortada por timeout (${motivo}) — veredito descartado`,
    };
  }
  return undefined;
}

/** O motivo e de saida CORTADA (truncamento/timeout)? */
export function isJudgeCutKind(kind: string | undefined): kind is JudgeCutKind {
  return kind === 'truncated' || kind === 'timeout';
}

/**
 * Contestants de UMA etapa cujo veredito ficou AUSENTE por saida de juiz
 * cortada (pointwise e/ou listwise sintetizado). Ordem estavel, sem repetidos.
 */
export function cutVerdicts(
  ...results: ReadonlyArray<{ verdictErrorByContestant?: Record<string, VerdictError> } | undefined>
): { contestantId: string; kind: JudgeCutKind }[] {
  const out = new Map<string, JudgeCutKind>();
  for (const r of results) {
    for (const [id, e] of Object.entries(r?.verdictErrorByContestant ?? {})) {
      if (!out.has(id) && isJudgeCutKind(e?.kind)) out.set(id, e.kind);
    }
  }
  return [...out].map(([contestantId, kind]) => ({ contestantId, kind }));
}

/** Duelos da etapa que ficaram SEM resultado por saida de juiz cortada. */
export function cutDuels(
  duels: { failedDuels?: ReadonlyArray<{ a: string; b: string; error: VerdictError }> } | undefined,
): { a: string; b: string; kind: JudgeCutKind }[] {
  return (duels?.failedDuels ?? [])
    .filter((d) => isJudgeCutKind(d.error?.kind))
    .map((d) => ({ a: d.a, b: d.b, kind: d.error.kind as JudgeCutKind }));
}

/**
 * Texto (PT-BR) do evento `judge.truncated` — o MESMO nos dois orquestradores.
 * Nunca inclui o texto das respostas nem a saida do juiz.
 */
export function describeJudgeCut(
  stageIndex: number,
  phase: 'judge' | 'duel',
  itens: ReadonlyArray<{ label: string; kind: JudgeCutKind }>,
): string {
  const quem = itens.map((x) => `${x.label} (${x.kind === 'truncated' ? 'teto de tokens' : 'timeout'})`).join(', ');
  return phase === 'judge'
    ? `Etapa ${stageIndex + 1}: saída do juiz cortada ao julgar ${quem} — veredito INVÁLIDO (descartado, fora do ` +
        `placar e das médias; nunca vira 'parcial').`
    : `Etapa ${stageIndex + 1}: saída do juiz de duelo cortada em ${quem} — duelo SEM resultado (fora do placar; ` +
        `nunca vira empate).`;
}
