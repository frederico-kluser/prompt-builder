// Modo JEV — estimativa ANTES de gastar (`jev run --dry-run`, `estimate_cost`
// do MCP, rodapé da UI). É ESTIMATIVA: o dinheiro real sai de `usage.cost`.
//
// Modelo de custo do Jev (medido ao vivo): US$ 0,042/Mtok de ENTRADA, saída
// grátis, piso de ~270–400 tokens por request mesmo com estado vazio — o nº de
// requests pesa mais que o tamanho do estado. Preço vem do catálogo de
// DECISÕES; sem ele, a constante abaixo (rotulada "estimativa").

import { countTextTokens, DECISION_REQUEST_OVERHEAD_TOKENS, RESERVE_TOKEN_MARGIN } from '../../openrouter.js';
import { priceCall } from '../../estimate.js';
import { deltaDetectavelPp } from '../../stats.js';
import type { OpenRouterModel } from '../../types.js';
import type { JevContestant, JevSpec, ResolvedJevConfig } from './types.js';
import { projectState, wireQuestionsOf } from './wire.js';
import { renderLlmDecisionMessages } from './llmRender.js';

/** Fallback SÓ da estimativa quando o catálogo de decisões não pôde ser lido (jev-1.13). */
export const JEV_FALLBACK_PROMPT_PRICE = 0.042e-6;
/** Expansão desconhecida do corpo pelo provedor (Solar mediu ×2,7 do mesmo corpo). */
export const JEV_HIGH_FACTOR = 1.5;
/**
 * σ prior das diferenças pareadas de (1−Brier) por caso (A2.7) — o default
 * 0,5 do módulo de poder foi calibrado para veredito ternário e faria o
 * "Δ detectável" mentir aqui.
 */
export const JEV_SIGMA_PRIOR = 0.15;

export interface JevContestantEstimate {
  id: string;
  label: string;
  kind: JevContestant['kind'];
  requests: number;
  tokensIn: number;
  usd: number;
  priceSource: 'catalog' | 'fallback' | 'unknown';
}

export interface JevEstimate {
  requests: number;
  tokensIn: number;
  /** Estimativa central. */
  usd: number;
  usdLow: number;
  usdHigh: number;
  /** O que a PORTA DURA reserva (tokens × margem): o teto precisa comportar isto em voo. */
  reserveUsd: number;
  byContestant: JevContestantEstimate[];
  byKind: { decision: number; llm: number; rewriter: number };
  /** Menor Δ (p.p. de 1−Brier) detectável com os casos avaliados (σ prior declarado). */
  detectableDeltaPp: number | null;
  notes: string[];
}

function decisionTokens(spec: JevSpec, state: unknown, qids?: readonly string[]): number {
  const st = projectState(state as never, spec.stateView);
  return countTextTokens(JSON.stringify({ state: st, questions: wireQuestionsOf(spec, qids) })) + DECISION_REQUEST_OVERHEAD_TOKENS;
}

export interface EstimateJevOptions {
  chatCatalog?: readonly OpenRouterModel[];
  decisionCatalog?: readonly OpenRouterModel[];
  /** Perguntas perguntadas (treino: só as-alvo). */
  qids?: readonly string[];
  /** Casos avaliados (default: todos). */
  caseFilter?: (split: string | undefined) => boolean;
}

/** Estimativa de UMA run (eval/compare) ou de uma rodada de avaliação do treino. */
export function estimateJev(r: ResolvedJevConfig, opts: EstimateJevOptions = {}): JevEstimate {
  const byId = new Map<string, OpenRouterModel>();
  for (const m of opts.chatCatalog ?? []) byId.set(m.id, m);
  for (const m of opts.decisionCatalog ?? []) byId.set(m.id, m);
  const specById = new Map(r.specs.map((s) => [s.id, s]));
  const casos = r.cases.filter((c) => (opts.caseFilter ? opts.caseFilter(c.split) : true));
  const notes: string[] = [];
  const out: JevContestantEstimate[] = [];
  let reserve = 0;
  let fallbackUsado = false;
  for (const ct of r.contestants) {
    const spec = specById.get(ct.specId)!;
    const qids = opts.qids ?? spec.questions.map((q) => q.id);
    const m = byId.get(ct.modelId);
    let tokens = 0;
    let usd = 0;
    let requests = 0;
    let fonte: JevContestantEstimate['priceSource'] = 'catalog';
    for (const c of casos) {
      if (ct.kind === 'decision') {
        const t = decisionTokens(spec, c.state, qids);
        tokens += t * r.repeats;
        requests += r.repeats;
        const price = m?.pricing.prompt;
        const pp = typeof price === 'number' && price >= 0 ? price : null;
        if (pp === null) {
          fonte = m ? 'unknown' : 'fallback';
          fallbackUsado = true;
        }
        const unit = pp ?? JEV_FALLBACK_PROMPT_PRICE;
        usd += t * unit * r.repeats;
        reserve += Math.ceil(t * RESERVE_TOKEN_MARGIN) * unit * r.repeats;
      } else {
        const lotes = ct.batching === 'per-case' ? [qids] : qids.map((q) => [q]);
        for (const lote of lotes) {
          const msgs = renderLlmDecisionMessages(spec, lote, c.state);
          const t = countTextTokens(msgs.map((x) => x.content).join('\n'));
          const saida = ct.reasoning && ct.reasoning !== 'off' ? 1500 : 60 * lote.length;
          const v = priceCall(m, t, saida);
          if (v === null) fonte = 'unknown';
          usd += (v ?? 0) * r.repeats;
          tokens += t * r.repeats;
          requests += r.repeats;
          const teto = ct.maxTokens ?? (ct.reasoning && ct.reasoning !== 'off' ? 8192 : 512);
          reserve += (priceCall(m, Math.ceil(t * RESERVE_TOKEN_MARGIN), teto) ?? 0) * r.repeats;
        }
      }
    }
    out.push({ id: ct.id, label: ct.label, kind: ct.kind, requests, tokensIn: tokens, usd, priceSource: fonte });
  }
  if (fallbackUsado) {
    notes.push(`preço de decisão fora do catálogo: estimativa com US$ ${(JEV_FALLBACK_PROMPT_PRICE * 1e6).toFixed(3)}/Mtok (o custo real vem de usage.cost).`);
  }
  if (out.some((o) => o.kind === 'llm' && o.priceSource === 'unknown')) {
    notes.push('LLM sem preço no catálogo: a estimativa dele sai 0 (a porta dura serializa chamadas sem preço).');
  }
  const decision = out.filter((o) => o.kind === 'decision').reduce((s, o) => s + o.usd, 0);
  const llm = out.filter((o) => o.kind === 'llm').reduce((s, o) => s + o.usd, 0);
  const usd = decision + llm;
  const nCasos = casos.length;
  return {
    requests: out.reduce((s, o) => s + o.requests, 0),
    tokensIn: out.reduce((s, o) => s + o.tokensIn, 0),
    usd,
    usdLow: usd * 0.8,
    usdHigh: decision * JEV_HIGH_FACTOR + llm * 2,
    reserveUsd: reserve,
    byContestant: out,
    byKind: { decision, llm, rewriter: 0 },
    detectableDeltaPp: nCasos >= 2 ? Number(deltaDetectavelPp(nCasos, JEV_SIGMA_PRIOR).toFixed(1)) : null,
    notes,
  };
}

/**
 * Estimativa do TREINO: baseline + ciclos × (campeã + K variantes) no
 * train∪calib (só perguntas-alvo) + fit + holdout (original × campeã) +
 * proponente (chamadas curtas de LLM, uma por variante proposta).
 */
export function estimateJevTrain(
  r: ResolvedJevConfig,
  opts: EstimateJevOptions & { rewriterPricePerCallUsd?: number } = {},
): JevEstimate {
  const t = r.train;
  if (!t) return estimateJev(r, opts);
  const naoHoldout = (s: string | undefined): boolean => s !== 'holdout';
  const umaAvaliacao = estimateJev({ ...r, repeats: t.repeats }, { ...opts, qids: t.targetQuestions, caseFilter: naoHoldout });
  const holdout = estimateJev({ ...r, repeats: t.repeats }, { ...opts, caseFilter: (s) => s === 'holdout' });
  const avaliacoes = 1 + t.iterations * (1 + t.variantsPerIteration);
  const propostas = t.iterations * t.variantsPerIteration;
  const rewriter = t.operators.some((o) => o !== 'add_examples') ? propostas * (opts.rewriterPricePerCallUsd ?? 0.01) : 0;
  const decision = umaAvaliacao.usd * avaliacoes + holdout.usd * 2;
  const notes = [...umaAvaliacao.notes];
  if (rewriter > 0 && opts.rewriterPricePerCallUsd === undefined) {
    notes.push('proponente estimado em ~US$ 0,01 por variante proposta (sem catálogo do modelo reescritor).');
  }
  return {
    requests: umaAvaliacao.requests * avaliacoes + holdout.requests * 2 + (rewriter > 0 ? propostas : 0),
    tokensIn: umaAvaliacao.tokensIn * avaliacoes + holdout.tokensIn * 2,
    usd: decision + rewriter,
    usdLow: (decision + rewriter) * 0.8,
    usdHigh: decision * JEV_HIGH_FACTOR + rewriter * 2,
    reserveUsd: Math.max(umaAvaliacao.reserveUsd, holdout.reserveUsd * 2),
    byContestant: umaAvaliacao.byContestant,
    byKind: { decision, llm: 0, rewriter },
    detectableDeltaPp: umaAvaliacao.detectableDeltaPp,
    notes,
  };
}
