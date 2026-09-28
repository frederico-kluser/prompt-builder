// Capacidade de ajuste POR MODELO, direto do catalogo do OpenRouter.
//
// A verdade sobre o que cada modelo aceita vem do proprio `/models`, NUNCA de
// uma tabela chumbada:
//   `supported_parameters`  quais parametros ele aceita (temperature, reasoning…)
//   `reasoning`             quais DEGRAUS de esforco, e se da para desligar
//
// Medido em 2026-07-26 (345 modelos): 287 aceitam `temperature`, 214 tem
// raciocinio e 83 declaram allowlist de esforco — em 20 conjuntos DISTINTOS.
// `openai/gpt-5-mini` aceita [high, medium, low, minimal]; outro so aceita
// [xhigh, high]. Uma lista fixa de niveis levaria o agente a escolher um degrau
// que aquele modelo nao tem e comer um HTTP 400.

import { fitEffort, REASONING_LEVELS } from './reasoning.js';
import { exportPrice, UNKNOWN_PRICE_JSON } from './engine/pricing.js';
import type {
  ModelReasoningMeta,
  OpenRouterModel,
  ReasoningConfig,
  ReasoningLevel,
} from './types.js';

export interface ModelCaps {
  /** Aceita `temperature`. */
  temperature: boolean;
  /** Aceita algum controle de raciocinio (`reasoning` OU `reasoning_effort`). */
  reasoning: boolean;
  /** Aceita niveis discretos — `reasoning: { effort }` e o formato nativo dele. */
  effort: boolean;
  /** Degraus que ESTE modelo aceita (ausente = sem restricao declarada). */
  supportedEfforts?: string[];
  /** Degrau usado quando nao mandamos nada. */
  defaultEffort?: string;
  /** true = nao oferecer "sem raciocinio": o provedor rejeita. */
  mandatory: boolean;
}

interface ModelLike {
  id?: string;
  supportedParameters?: string[];
  reasoning?: ModelReasoningMeta;
}

/** Capacidades de ajuste do modelo, direto do catalogo. */
export function modelCaps(m?: ModelLike): ModelCaps {
  const supported = m?.supportedParameters;
  const r = m?.reasoning;
  if (!supported) {
    // Sem metadados (modelo fora do catalogo carregado): oferece temperatura e
    // esconde esforco — e o que a chamada consegue enviar com seguranca.
    return { temperature: true, reasoning: false, effort: false, mandatory: false };
  }
  // `[]` = declarado vazio (roteadores) ou fail-closed de campo malformado
  // (IMPL-018): o gateway nao envia nada opcional, entao nada e oferecido.
  // Espelha `deterministicSampling`/`modelTuningCaps` de openrouter.ts.
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
 * juiz domina o custo (~47%). Agora cada papel resolve o seu degrau:
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
  // Campo unico antigo (`reasoning.judge`) como fallback dos papeis novos.
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

/** Rotulo PT-BR de cada degrau de esforco. */
export const EFFORT_LABEL: Record<string, string> = {
  none: 'Sem raciocínio',
  minimal: 'Mínimo',
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  xhigh: 'Muito alto',
  max: 'Máximo',
};

/** Todos os degraus, do mais barato ao mais caro. */
const EFFORT_ASC: ReasoningLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Degraus de esforco que este modelo REALMENTE aceita.
 * - `supportedEfforts` presente → exatamente esses (em ordem crescente).
 * - ausente → todos (o modelo nao declarou restricao).
 * - `mandatory` → sem a opcao `off` (o provedor rejeita 'none').
 */
export function effortOptions(caps: ModelCaps): ReasoningLevel[] {
  const out: ReasoningLevel[] = [];
  if (!caps.mandatory) out.push('off');
  const allow = caps.supportedEfforts;
  for (const level of EFFORT_ASC) {
    if (allow && !allow.includes(level)) continue;
    out.push(level);
  }
  return out;
}

/** O que o agente precisa saber sobre raciocinio para NAO tomar um 400. */
export interface ThinkLevels {
  /** Niveis que podem ser pedidos a este modelo. */
  accepted: ReasoningLevel[];
  /** Degrau usado quando nao mandamos nada. */
  default?: string;
  /** false = raciocinio obrigatorio; `off` sera ignorado. */
  canDisable: boolean;
  /**
   * O que REALMENTE vai no fio para cada nivel pedido — `fitEffort` encaixa o
   * pedido na allowlist do modelo (menor distancia ordinal; empate = o mais
   * barato). Pedir `max` a um modelo que so tem ['xhigh','high'] vira `xhigh`,
   * nunca um erro. Este mapa nao existia em lugar nenhum antes.
   *
   * `off` e um caso a parte e NAO passa por `fitEffort`: desligar raciocinio
   * usa `{ enabled: false }`, nao um degrau de esforco (ver `applyReasoning`).
   */
  fit: Record<ReasoningLevel, string>;
}

export function thinkLevelsFor(m?: ModelLike): ThinkLevels {
  const caps = modelCaps(m);
  const meta = m?.reasoning;
  const fit = {} as Record<ReasoningLevel, string>;
  for (const level of REASONING_LEVELS) {
    if (level === 'off') {
      // Espelha `applyReasoning`: em modelo `mandatory` nada e enviado (o
      // provedor rejeita 'none'); no resto vai `{ enabled: false }`. Rodar
      // `fitEffort` aqui devolveria o degrau MAIS BAIXO da allowlist, o que
      // faria um agente ler "off vira low" — o oposto do que acontece.
      fit[level] = caps.mandatory ? '(ignorado: raciocínio obrigatório)' : 'reasoning.enabled=false';
      continue;
    }
    fit[level] = fitEffort(level, meta);
  }
  return {
    accepted: effortOptions(caps),
    default: caps.defaultEffort,
    canDisable: !caps.mandatory,
    fit,
  };
}

/**
 * Formato de export do catalogo (`prompt-builder models --json`).
 * @2 (IMPL-018): preco desconhecido/variavel sai como a string `'unknown'` —
 * no @1 o "-1" do catalogo (roteadores) saia como numero negativo.
 */
export const MODELS_EXPORT_FORMAT = 'prompt-builder-models@2';

/** Preco exportado: numero, ou `'unknown'` (catalogo trouxe "-1"/ausente/invalido). */
export type ExportPrice = number | typeof UNKNOWN_PRICE_JSON;

export interface ModelExportRow {
  id: string;
  name: string;
  contextLength?: number;
  pricing: { prompt: ExportPrice; completion: ExportPrice; unit: 'usd-per-token' };
  /** Mesmos precos em USD por milhao — o que humanos e tabelas usam. */
  pricePerMTok: { prompt: ExportPrice; completion: ExportPrice };
  supportedParameters?: string[];
  caps: ModelCaps;
  thinkLevels: ThinkLevels;
  /**
   * Ciclo de vida do catálogo (IMPL-019): snapshot datado por trás do id, data
   * de deprecação (AAAA-MM-DD) e alvo do alias. null = o catálogo não informa.
   */
  lifecycle: { canonicalSlug: string | null; expirationDate: string | null; aliasTarget: string | null };
}

export function toExportRow(m: OpenRouterModel): ModelExportRow {
  return {
    id: m.id,
    name: m.name,
    contextLength: m.contextLength,
    pricing: {
      prompt: exportPrice(m.pricing.prompt),
      completion: exportPrice(m.pricing.completion),
      unit: 'usd-per-token',
    },
    pricePerMTok: {
      prompt: exportPrice(m.pricing.prompt, 1_000_000),
      completion: exportPrice(m.pricing.completion, 1_000_000),
    },
    supportedParameters: m.supportedParameters,
    caps: modelCaps(m),
    thinkLevels: thinkLevelsFor(m),
    lifecycle: {
      canonicalSlug: m.canonicalSlug ?? null,
      expirationDate: m.expirationDate ?? null,
      aliasTarget: m.aliasTarget ?? null,
    },
  };
}
