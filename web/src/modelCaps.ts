// Camada de capacidade de ajuste por modelo (client-side).
//
// A verdade sobre o que cada modelo aceita vem do PRÓPRIO catálogo do OpenRouter
// (já buscado e cacheado por listModels), NUNCA de uma tabela chumbada:
//   `supported_parameters`  quais parâmetros ele aceita (temperature, reasoning…)
//   `reasoning`             quais DEGRAUS de esforço ele aceita, e se dá para desligar
//
// Medido em 2026-07-26 (345 modelos): 287 aceitam `temperature`, 214 têm
// raciocínio e 83 declaram allowlist de esforço — em **20 conjuntos distintos**.
// `openai/gpt-5-mini` aceita [high, medium, low, minimal] e `deepseek-v4-pro` só
// [xhigh, high]; uma lista fixa de níveis levaria o usuário a escolher um degrau
// que aquele modelo não tem.
//
// Espelha `modelTuningCaps` do engine (engine/openrouter.ts) — a UI só oferece o
// que a chamada vai realmente conseguir enviar.

import type { ReasoningConfig, ReasoningLevel } from './api';
import { fitEffort } from './engine/reasoning';

/** Metadados de raciocínio declarados pelo modelo (campo `reasoning` de /models). */
export interface ModelReasoningMeta {
  /** true = raciocínio não pode ser desligado (o degrau 'none' é rejeitado). */
  mandatory?: boolean;
  defaultEnabled?: boolean;
  /** Degraus permitidos, em ordem decrescente. AUSENTE = sem restrição. */
  supportedEfforts?: string[];
  defaultEffort?: string;
  supportsMaxTokens?: boolean;
}

export interface ModelCaps {
  /** Aceita `temperature`. */
  temperature: boolean;
  /** Aceita algum controle de raciocínio (`reasoning` OU `reasoning_effort`). */
  reasoning: boolean;
  /** Aceita níveis discretos — `reasoning: { effort }` é o formato nativo dele. */
  effort: boolean;
  /** Degraus que ESTE modelo aceita (ausente = sem restrição declarada). */
  supportedEfforts?: string[];
  /** Degrau usado quando não mandamos nada — vira o rótulo do "Padrão". */
  defaultEffort?: string;
  /** true = não oferecer "Sem raciocínio": o provedor rejeita. */
  mandatory: boolean;
}

interface ModelLike {
  id?: string;
  supportedParameters?: string[];
  reasoning?: ModelReasoningMeta;
}

/** Capacidades de ajuste do modelo, direto do catálogo do OpenRouter. */
export function modelCaps(m?: ModelLike): ModelCaps {
  const supported = m?.supportedParameters;
  const r = m?.reasoning;
  if (!supported) {
    // Sem metadados (modelo fora do catálogo carregado): oferece temperatura e
    // esconde esforço. No envio, a heurística por nome do engine ainda pode
    // omitir a temperatura de modelos de raciocínio — igual a hoje.
    return { temperature: true, reasoning: false, effort: false, mandatory: false };
  }
  // `[]` = declarado vazio (roteadores) ou fail-closed de campo malformado
  // (IMPL-018): o gateway não envia nada opcional, então nada é oferecido.
  const effort = supported.includes('reasoning_effort');
  return {
    temperature: supported.includes('temperature'),
    reasoning: effort || supported.includes('reasoning'),
    effort,
    supportedEfforts: r?.supportedEfforts,
    defaultEffort: r?.defaultEffort,
    mandatory: r?.mandatory ?? false,
  };
}

/**
 * IMPL-079 (R-08:REC-1 / DEC-1) — papéis de JUÍZO com esforço próprio. O
 * `reasoning.judge` único mandava no juiz pointwise, no duelo e no gabarito ao
 * mesmo tempo; acima de `low` o ganho de esforço satura ou reverte e o papel
 * juiz domina o custo (~47%). Agora cada papel resolve o degrau:
 *   judge  → medium (pointwise: acima disso satura)
 *   duel   → low    (par curto; `low` já pega o ganho)
 *   gab    → high   (escrever a régua é a tarefa mais exigente)
 * Compat: papel sem campo próprio cai no `reasoning.judge` antigo (comportamento
 * legado preservado) e, sem nenhum dos dois, no default do papel.
 */
export type JudgingRole = 'judge' | 'duel' | 'gab';

/** Defaults por papel de juízo (IMPL-079) — só valem quando nada foi pedido. */
export const REASONING_ROLE_DEFAULT: Record<JudgingRole, ReasoningLevel> = {
  judge: 'medium',
  duel: 'low',
  gab: 'high',
};

/**
 * Degrau EFETIVO do papel de juízo + o `effort` que vai no fio depois do
 * `fitEffort` na allowlist do modelo (mesma regra do `applyReasoning`; `off`
 * não é degrau — sai como `'none'`, que o gateway traduz em `enabled: false`).
 */
export function reasoningForRole(
  reasoning: ReasoningConfig | undefined,
  role: JudgingRole,
  meta?: ModelReasoningMeta,
): { level: ReasoningLevel; effort: string } {
  const proprio = role === 'judge' ? reasoning?.judge : reasoning?.[role];
  // Campo único antigo (`reasoning.judge`) como fallback dos papéis novos.
  const level = proprio ?? reasoning?.judge ?? REASONING_ROLE_DEFAULT[role];
  return { level, effort: level === 'off' ? 'none' : fitEffort(level, meta) };
}

/** Atalho para os call sites: só o degrau efetivo do papel. */
export function reasoningLevelForRole(
  reasoning: ReasoningConfig | undefined,
  role: JudgingRole,
): ReasoningLevel {
  return reasoningForRole(reasoning, role).level;
}

/** Rótulo PT-BR de cada degrau de esforço. */
export const EFFORT_LABEL: Record<string, string> = {
  none: 'Sem raciocínio',
  minimal: 'Mínimo',
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  xhigh: 'Muito alto',
  max: 'Máximo',
};

/** Todos os degraus, do mais barato ao mais caro (ordem de exibição). */
const EFFORT_ASC: ReasoningLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Opções de esforço a MOSTRAR para um modelo: só os degraus que ele aceita.
 * - `supportedEfforts` presente → exatamente esses (na nossa ordem crescente).
 * - ausente → todos (o modelo não declarou restrição).
 * - `mandatory` → sem a opção "Sem raciocínio".
 * O primeiro item é sempre "Padrão", que não envia nada e deixa o modelo no
 * `default_effort` dele (mostrado no rótulo quando o catálogo informa).
 */
export function effortOptions(caps: ModelCaps): { value: '' | ReasoningLevel; label: string }[] {
  const padrao = caps.defaultEffort
    ? `Padrão (${(EFFORT_LABEL[caps.defaultEffort] ?? caps.defaultEffort).toLowerCase()})`
    : 'Padrão';
  const out: { value: '' | ReasoningLevel; label: string }[] = [{ value: '', label: padrao }];
  if (!caps.mandatory) out.push({ value: 'off', label: EFFORT_LABEL.none });
  const allow = caps.supportedEfforts;
  for (const level of EFFORT_ASC) {
    if (allow && !allow.includes(level)) continue;
    out.push({ value: level, label: EFFORT_LABEL[level] });
  }
  return out;
}
