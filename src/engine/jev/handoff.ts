// Modo JEV — o HANDOFF (`jev export`, botão "Exportar" da SPA): a definição
// medida sai como `DecisionsRequest` pronto + política por pergunta + evidência.
// Fonte única para o CLI e a web — o `jev.mjs ask|batch|serve` da
// jev-agent-skill consome o `request` direto.

import type { DecisionsRequest, JevQuestionPolicy, JevRunRecord, JevSessionRecord, JevSpec, JevStateView } from './types.js';
import { buildDecisionsRequest } from './wire.js';
import { sessionVerdict } from './train.js';
import { summarizeJevRun } from './report.js';

export const JEV_HANDOFF_FORMAT = 'jev-handoff@1';
/** O marcador que o usuário troca pelo estado real. */
export const JEV_STATE_PLACEHOLDER = '<<STATE>>';

export interface JevHandoff {
  format: typeof JEV_HANDOFF_FORMAT;
  model: string;
  resolvedModel: string | null;
  request: DecisionsRequest;
  stateView?: JevStateView;
  keyMap?: Record<string, Record<string, string>>;
  policy: Record<string, JevQuestionPolicy | Partial<JevQuestionPolicy>>;
  evidence: Record<string, unknown>;
  notes: string[];
}

/** Recusa do handoff: a campeã REGREDIU no holdout (CLI exit 10). */
export interface JevHandoffBlocked {
  blocked: true;
  reason: 'holdout-regressed';
  message: string;
}

export type JevHandoffSource =
  | { kind: 'session'; rec: JevSessionRecord }
  | { kind: 'run'; rec: JevRunRecord; contestantId?: string };

export const JEV_HANDOFF_NOTES: readonly string[] = [
  `Troque "${JEV_STATE_PLACEHOLDER}" pelo estado real (aplique o stateView antes, se houver).`,
  'A política é POR PERGUNTA (temperatura + limiares). O `jev.mjs` da jev-agent-skill aplica UM par de limiares a todas e não aplica temperatura.',
  'Fixe o modelo (não use alias ~…-latest): a política foi ajustada no snapshot em resolvedModel.',
];

/**
 * Monta o handoff. Sessão com holdout regredido RECUSA (sem `override`) — o
 * espelho do `sessions winner --apply`. Run: competidor explícito ou o 1º de
 * decisão. Lança `Error` legível quando o competidor não existe.
 */
export function buildJevHandoff(src: JevHandoffSource, opts: { override?: string } = {}): JevHandoff | JevHandoffBlocked {
  let spec: JevSpec;
  let model: string;
  let resolvedModel: string | null;
  let policy: JevHandoff['policy'];
  let evidence: Record<string, unknown>;
  if (src.kind === 'session') {
    const s = src.rec;
    if (s.holdout?.regressed && !opts.override) {
      return {
        blocked: true,
        reason: 'holdout-regressed',
        message: 'A definição campeã REGREDIU no holdout: o handoff foi recusado. Só sobreponha por decisão humana, com um motivo.',
      };
    }
    spec = s.championSpec;
    model = s.modelId;
    resolvedModel = s.resolvedModels[0] ?? null;
    policy = s.policy;
    evidence = {
      sessionId: s.id,
      verdict: sessionVerdict(s),
      holdout: s.holdout ? { n: s.holdout.n, strength: s.holdout.strength, pValue: s.holdout.comparison?.pValue ?? null, regressed: s.holdout.regressed } : null,
      ...(opts.override ? { override: opts.override } : {}),
    };
  } else {
    const rec = src.rec;
    const ctId = src.contestantId ?? rec.contestants.find((c) => c.kind === 'decision')?.id;
    const ct = rec.contestants.find((c) => c.id === ctId);
    if (!ct) throw new Error(`competidor "${String(ctId)}" não existe na run (${rec.contestants.map((c) => c.id).join(', ')}).`);
    if (ct.kind !== 'decision') throw new Error(`"${ct.id}" é um LLM: o handoff é de um modelo de DECISÃO.`);
    spec = rec.specs.find((s) => s.id === ct.specId)!;
    model = ct.modelId;
    resolvedModel = rec.resolvedModels[ct.modelId]?.[0] ?? null;
    policy = rec.policy?.[ct.id] ?? spec.policy?.questions ?? {};
    evidence = { runId: rec.id, contestantId: ct.id, metrics: rec.metrics[ct.id] ? summarizeJevRun(rec).contestants : null };
  }
  const request = buildDecisionsRequest(spec, JEV_STATE_PLACEHOLDER, { model });
  const keyMap = Object.fromEntries(
    spec.questions.filter((q) => q.type === 'choice' && q.keyMap).map((q) => [q.id, (q as { keyMap?: Record<string, string> }).keyMap!]),
  );
  return {
    format: JEV_HANDOFF_FORMAT,
    model,
    resolvedModel,
    request,
    ...(spec.stateView ? { stateView: spec.stateView } : {}),
    ...(Object.keys(keyMap).length ? { keyMap } : {}),
    policy,
    evidence,
    notes: [...JEV_HANDOFF_NOTES],
  };
}

export function isHandoffBlocked(h: JevHandoff | JevHandoffBlocked): h is JevHandoffBlocked {
  return (h as JevHandoffBlocked).blocked === true;
}

/**
 * O MESMO request como cURL (a key vem de `$OPENROUTER_API_KEY` — nunca
 * embutida). Aspas simples do JSON são escapadas para o shell POSIX.
 */
export function handoffCurl(req: DecisionsRequest, url = 'https://openrouter.ai/api/alpha/decisions'): string {
  const corpo = JSON.stringify(req, null, 2).replace(/'/g, `'\\''`);
  return [
    `curl -sS ${url} \\`,
    `  -H "Authorization: Bearer $OPENROUTER_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${corpo}'`,
  ].join('\n');
}
