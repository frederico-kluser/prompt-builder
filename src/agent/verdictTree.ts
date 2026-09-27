// ----------------------------------------------------------------------------
// ÁRVORE DE VEREDITO de UMA repetição de agente — a parte PURA (sem juiz LLM,
// sem I/O) — e as métricas de agente que saem dela.
//
// Extraída de `runAgentStage.adjudicateRep` para ser testável caminho a caminho
// (IMPL-032 / R-14a REC-1). O juiz continua em `runAgentStage`: aqui só se
// decide QUAL caminho a repetição toma e, quando o juiz é chamado, qual é o
// candidato do oráculo e até onde o juiz pode rebaixar.
//
// Os 9 caminhos (é a ordem de avaliação e a dos testes):
//   1 cancelled         → SEM veredito (incomplete). Sinal de controle: quem
//                          chama re-lança RunCancelled e a ETAPA inteira sai.
//   2 error             → 'nao' (o processo morreu). É o defeito A5 da R-14a;
//                          a taxonomia transient × defect é do IMPL-094.
//   3 limit-cut         → 'nao'. timeout/maxTurns/maxCost/maxOutput SEM oráculo
//                          100%. Antes era `null` e saía do denominador (A4).
//   4 oracle-violation  → 'nao' (forbiddenPaths tocados).
//   5 oracle-pass       → 'resolve' candidato; o juiz só rebaixa a 'parcial'.
//   6 oracle-fail       → 'nao' (score 0).
//   7 oracle-partial    → 'parcial' candidato; o juiz confirma ou rebaixa.
//   8 no-oracle-empty   → 'nao' (completou sem mudar nada).
//   9 no-oracle-judge   → juiz pleno pelo dossiê.
//
// Por que o corte por limite conta 'nao' (R-14a DEC-1, confiança alta): nenhum
// harness de referência exclui por limite — SWE-bench ("never remove anything
// from the total"; timeout = unresolved), Inspect AI (limite = saída antecipada,
// o score "counts in the denominator"), Terminal-Bench (trials com erro
// contados). O limite é parte da tarefa e é IGUAL para todos os contestants;
// tirá-lo do denominador cria viés de sobrevivência: quem estoura o timeout em
// toda tarefa difícil ficaria com nota perfeita nas fáceis. `incomplete` fica
// reservado aos sinais de controle (cancelamento e orçamento da RUN), que não
// dependem do comportamento do agente.
//
// ⚠️ Módulo PURO de propósito: sem `node:*`, sem `process.env`.
// ----------------------------------------------------------------------------
import type { Verdict } from '../types.js';
import type { AgentStopReason } from './types.js';

/**
 * Versão da semântica da árvore gravada em `RunRecord.agentVerdictTreeVersion`.
 * - 1 (legado — o campo AUSENTE numa run com agente): corte por limite sem
 *   oráculo 100% virava `null` e saía de judge-score/resolveRate (viés de
 *   sobrevivência, defeito A4).
 * - 2 (IMPL-032): corte por limite conta 'nao' nos três consumidores
 *   (judge-score, resolveRate, significância).
 * Notas de runs com versões diferentes NÃO são comparáveis entre si.
 */
export const AGENT_VERDICT_TREE_VERSION = 2;

/** Os tetos da EXECUÇÃO. `maxCost` é o `maxCostUsd` da execução, não o orçamento da run. */
export const LIMIT_STOP_REASONS: readonly AgentStopReason[] = ['timeout', 'maxTurns', 'maxCost', 'maxOutput'];

/** Classe de um `stopReason` — o que ele significa para a nota. */
export type StopClass = 'completed' | 'limit' | 'error' | 'cancelled';

/**
 * Classifica um `stopReason`. Aceita `string` porque o valor também é lido de
 * records em disco; um motivo desconhecido vira `'error'` (conta 'nao') — nunca
 * `'cancelled'`, que tiraria a execução do placar em silêncio.
 */
export function classifyStop(stopReason: AgentStopReason | string): StopClass {
  switch (stopReason) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'timeout':
    case 'maxTurns':
    case 'maxCost':
    case 'maxOutput':
      return 'limit';
    default:
      return 'error';
  }
}

/** true = a execução parou num teto DELA (timeout/maxTurns/maxCost/maxOutput). */
export function isLimitStop(stopReason: AgentStopReason | string): boolean {
  return classifyStop(stopReason) === 'limit';
}

/** Os 9 caminhos da árvore (ver cabeçalho). */
export type VerdictPath =
  | 'cancelled'
  | 'error'
  | 'limit-cut'
  | 'oracle-violation'
  | 'oracle-pass'
  | 'oracle-fail'
  | 'oracle-partial'
  | 'no-oracle-empty'
  | 'no-oracle-judge';

export const VERDICT_PATHS: readonly VerdictPath[] = [
  'cancelled',
  'error',
  'limit-cut',
  'oracle-violation',
  'oracle-pass',
  'oracle-fail',
  'oracle-partial',
  'no-oracle-empty',
  'no-oracle-judge',
];

/** Decisão da parte pura da árvore. */
export type TreeDecision =
  /** Sem veredito — SÓ cancelamento. A etapa sai inteira (quem chama re-lança). */
  | { kind: 'incomplete'; path: 'cancelled'; explanation: string }
  /** Veredito final, sem juiz. */
  | { kind: 'final'; path: VerdictPath; verdict: Verdict; explanation: string }
  /**
   * O juiz LLM gradua. `candidate` é o veredito do oráculo (e o fallback sem
   * juiz); `floor` é o piso até onde o juiz pode rebaixar.
   */
  | {
      kind: 'judge';
      path: 'oracle-pass' | 'oracle-partial' | 'no-oracle-judge';
      candidate: Verdict;
      floor: 'parcial' | 'nao';
      explanation: string;
    };

export interface TreeInput {
  stopReason: AgentStopReason | string;
  /** Resultado do oráculo (verify[]/forbiddenPaths), quando houve. */
  oracle?: { score: number; violations: string[] };
  /** true = diff seed..HEAD vazio (o agente não mudou nada). */
  diffEmpty: boolean;
}

/** Percorre a árvore — ver os 9 caminhos no cabeçalho. */
export function decideRepVerdict(input: TreeInput): TreeDecision {
  const { stopReason, oracle, diffEmpty } = input;
  const cls = classifyStop(stopReason);

  // 1) Cancelamento é sinal de controle: nunca vira nota de ninguém.
  if (cls === 'cancelled') {
    return { kind: 'incomplete', path: 'cancelled', explanation: 'execução cancelada (sinal de controle)' };
  }

  // 2) O processo morreu => é do contestant => 'nao' (A5; ver IMPL-094).
  if (cls === 'error') {
    return { kind: 'final', path: 'error', verdict: 'nao', explanation: 'a execução do agente falhou (processo morreu)' };
  }

  // 3) Corte por limite. Exceção ÚNICA: o oráculo passou inteiro, sem violação —
  //    o mundo mudou de forma verificável e o critério é o teste, não a
  //    despedida do agente. Qualquer outro corte é FALHA no denominador.
  const oraclePassing = oracle !== undefined && oracle.violations.length === 0 && oracle.score === 1;
  if (cls === 'limit' && !oraclePassing) {
    const detalhe = oracle
      ? oracle.violations.length > 0
        ? `; arquivos proibidos modificados: ${oracle.violations.join(', ')}`
        : `; verificação automática em ${Math.round(oracle.score * 100)}%`
      : '';
    return {
      kind: 'final',
      path: 'limit-cut',
      verdict: 'nao',
      explanation: `execução cortada por limite (${stopReason}) sem verificação 100%${detalhe} — conta 'nao'`,
    };
  }

  // 4-7) O ORÁCULO MANDA; o juiz só gradua dentro da faixa dele.
  if (oracle) {
    if (oracle.violations.length > 0) {
      return {
        kind: 'final',
        path: 'oracle-violation',
        verdict: 'nao',
        explanation: `arquivos proibidos modificados: ${oracle.violations.join(', ')}`,
      };
    }
    if (oracle.score === 1) {
      return {
        kind: 'judge',
        path: 'oracle-pass',
        candidate: 'resolve',
        floor: 'parcial',
        explanation: 'verificação automática passou integralmente (score 1)',
      };
    }
    if (oracle.score === 0) {
      return {
        kind: 'final',
        path: 'oracle-fail',
        verdict: 'nao',
        explanation: 'verificação automática falhou integralmente (score 0)',
      };
    }
    return {
      kind: 'judge',
      path: 'oracle-partial',
      candidate: 'parcial',
      floor: 'nao',
      explanation: 'verificação automática incompleta (score parcial)',
    };
  }

  // 8) Sem oráculo e sem diff: completou e não mudou nada — é uma resposta, errada.
  if (diffEmpty) {
    return { kind: 'final', path: 'no-oracle-empty', verdict: 'nao', explanation: 'o agente terminou sem alterar nada' };
  }

  // 9) Sem oráculo com diff: julgamento pleno pelo dossiê.
  return {
    kind: 'judge',
    path: 'no-oracle-judge',
    candidate: 'parcial',
    floor: 'nao',
    explanation: 'sem oráculo, sem veredito do juiz',
  };
}

// ---------------------------------------------------------------------------
// Métricas de agente (consumidores da árvore)
// ---------------------------------------------------------------------------

/** O mínimo de `ReferenceJudgeResult` que as métricas leem. */
export interface AgentStageVerdicts {
  verdictByContestant: Record<string, Verdict>;
  verdictsByRep?: Record<string, Verdict[]>;
  limitCutByContestant?: Record<string, number>;
}

/**
 * Observações de UM contestant numa etapa: o vetor por repetição quando existe
 * (§18.4 — cada rep é uma observação), senão o veredito agregado da etapa.
 * Contestant de chat numa run mista com reps > 1 cai no agregado (antes ficava
 * com vetor vazio e judge-score 0). Veredito ausente = nenhuma observação.
 */
export function stageObservations(stage: AgentStageVerdicts, contestantId: string): Verdict[] {
  const porRep = stage.verdictsByRep?.[contestantId];
  if (porRep) return porRep;
  const v = stage.verdictByContestant[contestantId];
  return v === undefined ? [] : [v];
}

export interface AgentRateMetrics {
  /**
   * MÉTRICA PRINCIPAL: fração de 'resolve' sobre TODAS as observações — corte
   * por limite incluído como 'nao'. Viés de sobrevivência ≡ 0: nunca exclui.
   */
  resolveRateByContestant: Record<string, number>;
  /**
   * DIAGNÓSTICO "sucesso até o limite": 'resolve' / (observações − cortes por
   * limite). É a antiga métrica censurada — mostra o quanto o agente acerta
   * quando termina dentro dos tetos. NUNCA alimenta ranking, finais nem gate.
   * Chave ausente = todas as observações do contestant foram cortadas.
   */
  censoredResolveRateByContestant: Record<string, number>;
  /** Observações decididas pelo caminho 'limit-cut' (contadas como 'nao'). */
  limitCutsByContestant: Record<string, number>;
}

const rate = (num: number, den: number): number => Number((num / den).toFixed(3));

/**
 * resolveRate (principal), sucesso-até-o-limite (diagnóstico) e contagem de
 * cortes por contestant de agente, sobre as etapas JULGADAS (quem chama já tirou
 * as `incomplete` — orçamento/cancelamento).
 */
export function agentRateMetrics(stages: AgentStageVerdicts[], agentIds: string[]): AgentRateMetrics {
  const resolveRateByContestant: Record<string, number> = {};
  const censoredResolveRateByContestant: Record<string, number> = {};
  const limitCutsByContestant: Record<string, number> = {};
  for (const id of agentIds) {
    let resolve = 0;
    let total = 0;
    let cuts = 0;
    for (const s of stages) {
      const obs = stageObservations(s, id);
      total += obs.length;
      resolve += obs.filter((v) => v === 'resolve').length;
      // Um corte nunca é 'resolve' (caminho 3 → 'nao'), então só o
      // denominador da métrica censurada muda. Clamp: não passa das observações.
      cuts += Math.min(s.limitCutByContestant?.[id] ?? 0, obs.length);
    }
    resolveRateByContestant[id] = total > 0 ? rate(resolve, total) : 0;
    const semCorte = total - cuts;
    if (semCorte > 0) censoredResolveRateByContestant[id] = rate(resolve, semCorte);
    limitCutsByContestant[id] = cuts;
  }
  return { resolveRateByContestant, censoredResolveRateByContestant, limitCutsByContestant };
}

/**
 * Versão da árvore que produziu as notas de uma run: o campo gravado, ou 1
 * (legado) numa run com agente que não o tem; `undefined` = run sem agente.
 */
export function agentVerdictTreeVersionOf(record: {
  agentVerdictTreeVersion?: number;
  contestants: { runner?: 'chat' | 'agent' }[];
}): number | undefined {
  if (record.agentVerdictTreeVersion !== undefined) return record.agentVerdictTreeVersion;
  return record.contestants.some((c) => c.runner === 'agent') ? 1 : undefined;
}
