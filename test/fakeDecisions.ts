// Helpers do fake do endpoint de DECISÕES (modo JEV). Não é arquivo de teste
// (sem `.test.`): usado pelos testes jev-*. Nunca toca a rede nem gasta.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FakeDecisionReply, FakeRequest } from './fakeOpenRouter.js';

/** Catálogo REAL de modelos de decisão (fixture de 2026-09-28). */
export const DECISION_CATALOG: unknown[] = (
  JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/decision-models.json', import.meta.url)), 'utf8')) as { data: unknown[] }
).data;

export function decisionCatalogItem(id: string, promptPrice = 0.042e-6, ctx = 32_000): Record<string, unknown> {
  return {
    id,
    name: id,
    context_length: ctx,
    architecture: { modality: 'text->decisions', input_modalities: ['text'], output_modalities: ['decisions'] },
    pricing: { prompt: String(promptPrice), completion: '0' },
    supported_parameters: [],
  };
}

/** Corpo de 400 do EDGE (validação do gateway): todos os problemas num array serializado. */
export function edge400(issues: { path: (string | number)[]; message: string; code?: string }[]): string {
  return JSON.stringify({ error: { message: JSON.stringify(issues, null, 2), code: 400 }, user_id: 'x' });
}

/** Corpo de 400 do UPSTREAM (provedor): só o 1º problema, `HTTP 400: {"detail":…}`. */
export function upstream400(detail: string): string {
  return JSON.stringify({ error: { message: `HTTP 400: ${JSON.stringify({ detail })}`, code: 400 } });
}

/** Resposta tipada: noul com p; choice na chave `pick` com p (resto dividido); score no nível `pick`. */
export function answerFor(q: { type?: unknown; criteria?: unknown }, pick: unknown, p = 0.9, confidence = 0.8): Record<string, unknown> {
  if (q.type === 'noul') return { type: 'noul', noul: pick === true ? p : 1 - p };
  if (q.type === 'choice') {
    const keys = Object.keys((q.criteria ?? {}) as Record<string, unknown>);
    const resto = keys.length > 1 ? (1 - p) / (keys.length - 1) : 0;
    return {
      type: 'choice',
      choice: pick,
      probabilities: Object.fromEntries(keys.map((k) => [k, k === pick ? p : resto])),
      confidence,
    };
  }
  const L = Array.isArray(q.criteria) ? q.criteria.length : 1;
  const lv = Number(pick);
  const resto = L > 1 ? (1 - p) / (L - 1) : 0;
  const probs = Object.fromEntries(Array.from({ length: L }, (_, i) => [String(i), i === lv ? p : resto]));
  return { type: 'score', score: Object.entries(probs).reduce((s, [k, x]) => s + Number(k) * x, 0), probabilities: probs, confidence };
}

/**
 * Um Jev falso "que sabe o ouro": `goldOf(state, qid)` devolve o rótulo certo;
 * `accuracy(state, qid, question)` decide se acerta (default sempre). Errando,
 * escolhe outra opção com a mesma confiança (erro confiante).
 */
export function oracleJev(opts: {
  goldOf: (state: unknown, qid: string) => unknown;
  hits?: (state: unknown, qid: string, question: Record<string, unknown>, req: FakeRequest) => boolean;
  p?: number;
  confidence?: number;
}): (req: FakeRequest) => FakeDecisionReply {
  return (req) => {
    const answers: Record<string, unknown> = {};
    for (const [qid, raw] of Object.entries(req.questions ?? {})) {
      const q = raw as Record<string, unknown>;
      const gold = opts.goldOf(req.state, qid);
      const acerta = opts.hits ? opts.hits(req.state, qid, q, req) : true;
      let pick: unknown = gold;
      if (!acerta) {
        if (q.type === 'noul') pick = !gold;
        else if (q.type === 'choice') pick = Object.keys(q.criteria as Record<string, unknown>).find((k) => k !== gold);
        else {
          const L = Array.isArray(q.criteria) ? q.criteria.length : 1;
          pick = (Number(gold) + 1) % Math.max(1, L);
        }
      }
      answers[qid] = answerFor(q, pick, opts.p ?? 0.9, opts.confidence ?? 0.8);
    }
    return { answers };
  };
}
