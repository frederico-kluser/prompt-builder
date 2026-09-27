// ----------------------------------------------------------------------------
// Erro de INFRAESTRUTURA numa execução de agente → sem veredito (IMPL-036).
//
// O executor marca `AgentRunOutcome.infraError` quando a execução terminou
// porque o PROVEDOR/rede falhou (ex.: `--network none` sem proxy de inferência →
// "Connection error." com as retentativas do pi esgotadas), e não por decisão do
// agente. O `stopReason` vem 'error', mas isso NÃO é o "processo morreu" do §18.3
// (que conta `nao`): a culpa não é do contestant. Regra das CONVENTIONS (§2,
// veredito ausente): "competidor `error` (infra) → sem veredito, nunca imputar
// `nao`" — a repetição sai do placar e das médias (chave ausente = sem
// observação), e o motivo fica na explicação e em `ExecutionRef.infraError`.
//
// EXCEÇÃO (o oráculo MANDA, §17.1): quando o oráculo é CONCLUSIVO sobre o que o
// agente fez — passou 100% (o mundo mudou de forma verificável: o agente fez o
// trabalho e só a última chamada caiu) ou violou `forbiddenPaths` (dano
// verificável, atribuível ao agente) —, a repetição segue a árvore normal como
// execução concluída. É a mesma lógica da exceção de corte do §15.2.
//
// Retentativa cega e `infraErrorRate` (taxonomia transient × defect) são do
// IMPL-094; aqui só se garante que infra nunca vira nota de ninguém.
//
// ⚠️ Módulo PURO: sem `node:*`, sem `process.env`.
// ----------------------------------------------------------------------------

/** O mínimo do resultado do oráculo que a decisão lê. */
export interface InfraOracleView {
  score: number;
  violations: string[];
}

export type InfraDecision =
  /** Sem erro de infra: a árvore de veredito decide com o `stopReason` real. */
  | { kind: 'none' }
  /** Erro de infra sem oráculo conclusivo: repetição SEM veredito (fora do placar). */
  | { kind: 'no-verdict'; explanation: string }
  /**
   * Erro de infra, mas o oráculo é conclusivo: a árvore decide como se a
   * execução tivesse concluído (`stopReason` efetivo `'completed'`).
   */
  | { kind: 'oracle-decides'; explanation: string };

/** O oráculo diz algo DEFINITIVO sobre o que o agente fez (100% ou violação)? */
export function isOracleConclusive(oracle?: InfraOracleView): boolean {
  return oracle !== undefined && (oracle.violations.length > 0 || oracle.score === 1);
}

/** Decide o destino de uma repetição a partir do marcador de infra do executor. */
export function decideInfraError(infraError: string | undefined, oracle?: InfraOracleView): InfraDecision {
  if (!infraError) return { kind: 'none' };
  if (isOracleConclusive(oracle)) {
    return {
      kind: 'oracle-decides',
      explanation: `erro de infraestrutura no fim da execução (${infraError}), mas o oráculo é conclusivo — ele decide`,
    };
  }
  return {
    kind: 'no-verdict',
    explanation:
      `erro de infraestrutura na execução (${infraError}) — sem veredito, fora do placar ` +
      '(a falha é do provedor/rede, não do agente)',
  };
}
