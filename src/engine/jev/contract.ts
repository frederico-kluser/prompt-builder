// Modo JEV — contrato NEVER-BREAK de uma variante (§11.3). Recusa local, sem
// gasto, registrada em `candidates[].reason`.
//
// Uma variante PODE reescrever: instrução, texto e estrutura da rubrica,
// exemplos (só do treino), chaves de choice com `keyMap` fechando.
// NÃO PODE: mudar tipo, rótulos canônicos, número/ordem de níveis; tocar
// pergunta de guarda ou pergunta irmã congelada; mudar a projeção do estado
// (v1: `project_state` adiado); citar caminho inexistente; ter lint com erro.

import { canonicalJson } from '../hash.js';
import type { JevCase, JevSpec } from './types.js';
import { labelSpaceOf } from './wire.js';
import { isRunnable, lintJevSpec } from './lint.js';

export type ContractCheck = { ok: true } | { ok: false; reason: string };

const igual = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/** Espaço de rótulos de uma pergunta (tipo + rótulos canônicos | nº de níveis). */
export const labelSpaceHash = labelSpaceOf;

export function checkVariantContract(
  parent: JevSpec,
  child: JevSpec,
  opts: { targetQuestions: readonly string[]; cases?: readonly JevCase[]; modelId?: string },
): ContractCheck {
  const idsP = parent.questions.map((q) => q.id);
  const idsC = child.questions.map((q) => q.id);
  if (!igual(idsP, idsC)) return { ok: false, reason: 'perguntas adicionadas/removidas/reordenadas' };
  if (!igual(parent.stateView ?? null, child.stateView ?? null)) return { ok: false, reason: 'projeção do estado alterada (operador project_state não disponível nesta versão)' };
  const alvo = new Set(opts.targetQuestions);
  for (let i = 0; i < parent.questions.length; i++) {
    const p = parent.questions[i];
    const c = child.questions[i];
    if (p.type !== c.type) return { ok: false, reason: `"${p.id}": tipo mudou (${p.type} → ${c.type})` };
    if (labelSpaceOf(p) !== labelSpaceOf(c)) return { ok: false, reason: `"${p.id}": espaço de rótulos mudou (${labelSpaceOf(p)} → ${labelSpaceOf(c)})` };
    if (p.guard && !igual(p, c)) return { ok: false, reason: `"${p.id}" é pergunta de guarda: intocável` };
    if (Boolean(p.guard) !== Boolean(c.guard)) return { ok: false, reason: `"${p.id}": marca de guarda mudou` };
    if (!alvo.has(p.id) && !igual(p, c)) return { ok: false, reason: `"${p.id}" não é pergunta-alvo: está congelada` };
  }
  const issues = lintJevSpec(child, { mode: 'train', targetQuestions: opts.targetQuestions, ...(opts.cases ? { cases: opts.cases } : {}), ...(opts.modelId ? { modelId: opts.modelId } : {}) });
  if (!isRunnable(issues)) {
    const e = issues.filter((i) => i.level === 'error').slice(0, 2).map((i) => `${i.code}: ${i.message}`);
    return { ok: false, reason: `lint: ${e.join('; ')}` };
  }
  const caminho = issues.find((i) => i.code === 'path.missing' && i.questionId && alvo.has(i.questionId));
  if (caminho) return { ok: false, reason: `${caminho.code}: ${caminho.message}` };
  if (igual(parent.questions, child.questions)) return { ok: false, reason: 'variante idêntica à campeã' };
  return { ok: true };
}
