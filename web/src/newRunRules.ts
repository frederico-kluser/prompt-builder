// Regras PURAS do formulário de Nova Run (pages/NewRun.tsx + GuidedSetup).
//
// O componente é grande e cheio de estado; o que decide O QUE a run manda
// (esforço por papel, nº de cenários, papéis separados) mora aqui, sem React,
// para ser testado direto (test/newrun-rules.test.ts) — as duas superfícies
// (guiada e completa) leem o MESMO estado e chamam as MESMAS regras.

import { roleConflictMessage, roleSeparationIssues, type ReasoningConfig, type ReasoningLevel, type RunMode } from './api';
import { PREFERRED_JUDGES } from './arenaForm';
import type { ModelTuning } from './components/ModelSelector';

/* ----------------------------------------------------- esforço por papel */

/** Esforço ajustado no modelo ('' / ausente = padrão do provedor, não envia). */
export function effortOfTuning(tuning: Record<string, ModelTuning>, modelId?: string): ReasoningLevel | undefined {
  const level = modelId ? tuning[modelId]?.effort : undefined;
  return level ? level : undefined;
}

/**
 * `reasoning` da run a partir do ajuste de CADA modelo no seu papel (o esforço
 * mora no modelo, não num campo global). Esforço POR PAPEL de juízo (IMPL-079):
 * o do gabarito vai em `gab` e nunca vaza para o juiz nem para o duelo — antes
 * o form mandava `judge = juiz ?? gabarito`, então gabarito 'low' puxava juiz e
 * duelo para 'low', e juiz 'minimal' + gabarito 'high' mandava o gabarito em
 * 'minimal'. Gabarito vazio = o 1º juiz escreve, e o engine cai em `judge`.
 * `duel` fica sem campo: cai em `judge` e depois no default do papel ('low').
 */
export function reasoningFromTuning(p: {
  tuning: Record<string, ModelTuning>;
  /** variation/training: o esforço do modelo sob teste vale para todas as variantes. */
  isSingle: boolean;
  contestant?: string;
  judge?: string;
  reference?: string;
  datagen?: string;
  rewriter?: string;
}): ReasoningConfig {
  const r: ReasoningConfig = {};
  const competitor = p.isSingle ? effortOfTuning(p.tuning, p.contestant) : undefined;
  if (competitor) r.competitor = competitor;
  const judge = effortOfTuning(p.tuning, p.judge);
  if (judge) r.judge = judge;
  const gab = effortOfTuning(p.tuning, p.reference);
  if (gab) r.gab = gab;
  const datagen = effortOfTuning(p.tuning, p.datagen);
  if (datagen) r.datagen = datagen;
  const rewriter = effortOfTuning(p.tuning, p.rewriter);
  if (rewriter) r.rewriter = rewriter;
  return r;
}

/* ------------------------------------------------------------- cenários */

/** Faixa aceita no nº de cenários a gerar (a mesma do schema da run). */
export const STAGES_MIN = 1;
export const STAGES_MAX = 50;

/**
 * Nº de cenários EFETIVO (inteiro em 1–50). O input numérico aceita qualquer
 * coisa enquanto se digita (o clamp é no envio): 0, 2.5 ou 100 chegavam CRUS ao
 * engine — 0 cenários terminava a run 'inconclusive' e 2.5 virava "alvo: 2.5"
 * no pedido ao gerador. Clamp num lugar só: envio, estimativa e textos concordam.
 */
export function clampStages(stages: number): number {
  const n = Math.round(stages);
  if (!Number.isFinite(n)) return STAGES_MIN;
  return Math.max(STAGES_MIN, Math.min(STAGES_MAX, n));
}

/** Pendência do campo de cenários (null = ok). O clamp não corrige calado: avisa. */
export function stagesProblem(stages: number): string | null {
  return Number.isInteger(stages) && stages >= STAGES_MIN && stages <= STAGES_MAX
    ? null
    : `Cenários: informe um número inteiro entre ${STAGES_MIN} e ${STAGES_MAX}.`;
}

/* -------------------------------------------- papéis separados (IMPL-048) */

/**
 * Gabarito default dos modos de prompt: o 1º da lista preferida de juízes que
 * NÃO julga nem compete (papéis distintos). Sem candidato livre = undefined (o
 * form mostra a pendência e o usuário escolhe).
 */
export function defaultReferenceFor(judges: readonly string[], competing: readonly string[]): string | undefined {
  const ocupados = new Set([...judges, ...competing]);
  return PREFERRED_JUDGES.find((id) => !ocupados.has(id));
}

/**
 * Pendências de papel do formulário, na linguagem da tela — a regra é a do
 * schema/portão (`roleSeparationIssues`, src/engine/roleSeparation.ts).
 */
export function referenceProblemTexts(p: {
  mode: RunMode;
  reference?: string;
  judges: readonly string[];
  competitors: readonly string[];
  contestant?: string;
}): string[] {
  const issues = roleSeparationIssues({
    mode: p.mode,
    referenceModelId: p.reference,
    judgeModelIds: p.judges,
    competitorModelIds: p.mode === 'compare' ? p.competitors : undefined,
    contestantModelId: p.contestant,
  });
  return issues.map((c) => {
    if (c.kind === 'reference-missing')
      return 'Escolha o modelo do gabarito — em teste e treino ele é obrigatório e diferente dos juízes e do modelo sob teste.';
    if (c.kind === 'reference-is-judge')
      return `O gabarito (${c.ref}) não pode ser também juiz: o mesmo modelo escreveria a régua e julgaria contra ela.`;
    if (c.kind === 'reference-is-competitor')
      return `O gabarito (${c.ref}) não pode ser também ${p.mode === 'compare' ? 'competidor' : 'o modelo sob teste'}: quem escreve a régua não compete contra ela.`;
    // 2º gabarito (IMPL-055): o formulário não o escolhe hoje, mas a regra é a mesma.
    return roleConflictMessage(c);
  });
}
