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
//   5 oracle-pass       → 'resolve' do oráculo; o juiz só rebaixa a 'parcial'.
//   6 oracle-fail       → 'nao' (score 0).
//   7 oracle-partial    → 'parcial' do oráculo; o juiz confirma ou rebaixa a
//                          'nao' — NUNCA promove a 'resolve' (IMPL-033, A2).
//   8 no-oracle-empty   → 'nao' (completou sem mudar nada).
//   9 no-oracle-judge   → juiz pleno pelo dossiê (sem oráculo não há faixa).
//
// Verificador que NÃO terminou (IMPL-033, revisão): check que não teve exit
// normal entra no `score` como FALHO (`ok:false`, peso no denominador) — a rep
// nunca sai do denominador por isso, e o juiz nunca a promove (o score < 1 já
// põe o teto em 'parcial'). O motivo decide de quem é a culpa:
//   - timeout/sinal do check: o código sob teste pendurou/morreu sob um teto
//     da tarefa, igual para todos — é desfecho do agente (mesma lógica do corte
//     por limite). SEM re-verificação: repetir só quando pendura seria retry
//     dependente de resultado (daria a um check instável até 3 chances).
//   - comando que nem começou (spawn): re-verificado às cegas (só esse check,
//     no mesmo workspace, `recheckIndices`/`mergeOracleRecheck`); persistindo,
//     a CÉLULA decide (`oracleCellDefect`): se o check rodou em alguma execução
//     da etapa, o ambiente serve e a falha é do agente (conta como check falho);
//     se não rodou em NENHUMA, é defeito do ambiente e a etapa fica inválida
//     para TODOS os contestants (R-14a DEC-2) — simétrico, sem viés de
//     sobrevivência. Antes (1ª versão do IMPL-033) a rep inconclusiva saía do
//     denominador só para aquele contestant: quem pendurava a suíte de testes
//     ganhava de quem falhava limpo (inversão de ranking reproduzida).
//
// Hierarquia oráculo > juiz (IMPL-033 / R-14a DEC-3, confiança ALTA): o oráculo
// define a FAIXA [floor, ceiling] e o juiz só gradua dentro dela
// (`settleRepVerdict`). Falha do juiz (exceção/timeout/saída inválida mesmo após
// 2 retentativas) NÃO degrada: cai no veredito do ORÁCULO com a flag
// `judgeError`; sem oráculo, a rep fica sem veredito (Inspect: `unscored`,
// reason="grader_failed"). Antes a falha virava 'parcial' — resolve→parcial
// (A3) — e o juiz podia promover um oráculo parcial a 'resolve' (A2). Teste
// passando não é oráculo de validade (APR: só 51–63% dos patches "plausíveis"
// são corretos), então o papel do juiz é AUDITAR — rebaixar —, nunca promover.
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
import type { Verdict, VerdictError, VerdictSource } from '../types.js';
import type { AgentStopReason, OracleNotRun, OracleResult } from './types.js';

/**
 * Versão da semântica da árvore gravada em `RunRecord.agentVerdictTreeVersion`.
 * - 1 (legado — o campo AUSENTE numa run com agente): corte por limite sem
 *   oráculo 100% virava `null` e saía de judge-score/resolveRate (viés de
 *   sobrevivência, defeito A4).
 * - 2 (IMPL-032): corte por limite conta 'nao' nos três consumidores
 *   (judge-score, resolveRate, significância).
 * - 3 (IMPL-033): juiz confinado à faixa do oráculo (oráculo parcial nunca
 *   vira 'resolve'); falha do juiz cai no veredito do oráculo (+ `judgeError`)
 *   ou, sem oráculo, deixa a rep sem veredito, em vez de 'parcial'; check que
 *   não terminou conta como falho, e comando ausente em TODAS as execuções da
 *   etapa invalida a etapa para todos (defeito do ambiente).
 * Notas de runs com versões diferentes NÃO são comparáveis entre si.
 */
export const AGENT_VERDICT_TREE_VERSION = 3;

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

/** Caminhos em que o juiz LLM gradua (dentro da faixa do oráculo, quando há). */
export type JudgePath = 'oracle-pass' | 'oracle-partial' | 'no-oracle-judge';

/** Decisão do juiz LLM: a faixa do oráculo e o fallback. */
export interface JudgeDecision {
  kind: 'judge';
  path: JudgePath;
  /**
   * Veredito do ORÁCULO — é o que fica quando o juiz falha (ou não há juiz).
   * `null` = sem oráculo (caminho 9): falha do juiz deixa a rep SEM veredito,
   * nunca um 'parcial' inventado (IMPL-033).
   */
  candidate: Verdict | null;
  /** Piso: até onde o juiz pode REBAIXAR. */
  floor: 'parcial' | 'nao';
  /** Teto: o juiz nunca PROMOVE acima da faixa do oráculo (DEC-3). */
  ceiling: Verdict;
  explanation: string;
}

/** Decisão da parte pura da árvore. */
export type TreeDecision =
  /** Sem veredito — SÓ cancelamento. A etapa sai inteira (quem chama re-lança). */
  | { kind: 'incomplete'; path: 'cancelled'; explanation: string }
  /** Veredito final, sem juiz. */
  | { kind: 'final'; path: VerdictPath; verdict: Verdict; source: VerdictSource; explanation: string }
  /** O juiz LLM gradua dentro de [floor, ceiling]. */
  | JudgeDecision;

export interface TreeInput {
  stopReason: AgentStopReason | string;
  /**
   * Resultado do oráculo (verify[]/forbiddenPaths), quando houve. Check que não
   * terminou já está no `score` como FALHO (ver cabeçalho) — a árvore não
   * precisa saber o motivo; a invalidação por defeito do ambiente é da célula
   * (`oracleCellDefect`, no orquestrador), não da rep.
   */
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
    return {
      kind: 'final',
      path: 'error',
      verdict: 'nao',
      source: 'auto',
      explanation: 'a execução do agente falhou (processo morreu)',
    };
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
      source: 'auto',
      explanation: `execução cortada por limite (${stopReason}) sem verificação 100%${detalhe} — conta 'nao'`,
    };
  }

  // 4-7) O ORÁCULO MANDA; o juiz só gradua dentro da faixa dele.
  if (oracle) {
    // 4) Violação é medida no DIFF, não nos checks.
    if (oracle.violations.length > 0) {
      return {
        kind: 'final',
        path: 'oracle-violation',
        verdict: 'nao',
        source: 'ground-truth',
        explanation: `arquivos proibidos modificados: ${oracle.violations.join(', ')}`,
      };
    }
    // 5) Score 1: 'resolve' do oráculo; o juiz só pode rebaixar a 'parcial'.
    if (oracle.score === 1) {
      return {
        kind: 'judge',
        path: 'oracle-pass',
        candidate: 'resolve',
        floor: 'parcial',
        ceiling: 'resolve',
        explanation: 'verificação automática passou integralmente (score 1)',
      };
    }
    // 6) Score 0: 'nao' sem juiz.
    if (oracle.score === 0) {
      return {
        kind: 'final',
        path: 'oracle-fail',
        verdict: 'nao',
        source: 'ground-truth',
        explanation: 'verificação automática falhou integralmente (score 0)',
      };
    }
    // 7) Score ∈ (0,1): 'parcial' do oráculo; o juiz confirma ou cai a 'nao'.
    //    TETO 'parcial' — o juiz nunca promove a 'resolve' (defeito A2).
    return {
      kind: 'judge',
      path: 'oracle-partial',
      candidate: 'parcial',
      floor: 'nao',
      ceiling: 'parcial',
      explanation: `verificação automática incompleta (score ${Math.round(oracle.score * 100)}%)`,
    };
  }

  // 8) Sem oráculo e sem diff: completou e não mudou nada — é uma resposta, errada.
  if (diffEmpty) {
    return {
      kind: 'final',
      path: 'no-oracle-empty',
      verdict: 'nao',
      source: 'auto',
      explanation: 'o agente terminou sem alterar nada',
    };
  }

  // 9) Sem oráculo com diff: julgamento pleno pelo dossiê. Sem oráculo não há
  //    faixa nem fallback: se o juiz falhar, a rep fica sem veredito.
  return {
    kind: 'judge',
    path: 'no-oracle-judge',
    candidate: null,
    floor: 'nao',
    ceiling: 'resolve',
    explanation: 'sem oráculo: julgamento pleno pelo dossiê',
  };
}

// ---------------------------------------------------------------------------
// Fechamento do veredito: o juiz dentro da faixa do oráculo (IMPL-033)
// ---------------------------------------------------------------------------

const ORDINAL: Record<Verdict, number> = { nao: 0, parcial: 1, resolve: 2 };

/**
 * Confina um veredito à faixa [floor, ceiling] (DEC-3). É a ÚNICA porta por
 * onde o veredito do juiz entra numa rep de agente.
 */
export function clampToOracleBand(verdict: Verdict, floor: Verdict, ceiling: Verdict): Verdict {
  if (ORDINAL[verdict] < ORDINAL[floor]) return floor;
  if (ORDINAL[verdict] > ORDINAL[ceiling]) return ceiling;
  return verdict;
}

/** O que a chamada ao juiz devolveu, já depois das retentativas. */
export type JudgeOutcome =
  /** O juiz (painel inteiro ou parte dele — `degraded`) deu um veredito válido. */
  | { status: 'ok'; verdict: Verdict; explanation: string; degraded?: boolean }
  /** Nenhum juiz produziu veredito válido mesmo após 1+2 tentativas. */
  | { status: 'failed'; error: VerdictError; attempts: number }
  /**
   * O juiz não foi chamado (sem juiz configurado, ou dossiê vazio — nada a
   * ler). Não é falha do juiz (sem `judgeError`), mas também não há graduação.
   */
  | { status: 'skipped'; reason?: string };

/** Veredito FINAL de uma repetição. */
export interface SettledRepVerdict {
  /** null = sem veredito (cancelamento, ou juiz falhou/não chamado sem oráculo). */
  verdict: Verdict | null;
  explanation: string;
  /** Origem do veredito presente (nomes do CONVENTIONS). Ausente quando `verdict` é null. */
  source?: VerdictSource;
  /** true = o veredito do juiz LLM foi usado (dentro da faixa). */
  judgeUsed: boolean;
  /** Flag `judgeError` (DEC-3): o juiz falhou mesmo após as retentativas. */
  judgeError?: VerdictError;
  /** O veredito CRU do juiz, quando a faixa do oráculo o confinou (auditoria). */
  judgeVerdictBeforeClamp?: Verdict;
}

/**
 * Fecha o veredito de uma repetição a partir da decisão da árvore e (nos
 * caminhos que graduam) do desfecho do juiz. Puro — é aqui que moram as três
 * garantias do IMPL-033:
 *   1. o juiz nunca promove acima do teto do oráculo (e nunca rebaixa abaixo
 *      do piso);
 *   2. falha do juiz ⇒ veredito do ORÁCULO + `judgeError` (nunca 'parcial'
 *      inventado; sem oráculo ⇒ sem veredito);
 *   3. juiz que não chegou a ser chamado (`skipped`: sem juiz, dossiê vazio)
 *      não é falha do juiz — sem `judgeError`.
 */
export function settleRepVerdict(decision: TreeDecision, judge?: JudgeOutcome): SettledRepVerdict {
  if (decision.kind === 'incomplete') {
    return { verdict: null, explanation: decision.explanation, judgeUsed: false };
  }
  if (decision.kind === 'final') {
    return { verdict: decision.verdict, explanation: decision.explanation, source: decision.source, judgeUsed: false };
  }
  const outcome: JudgeOutcome = judge ?? { status: 'skipped' };
  if (outcome.status === 'ok') {
    const verdict = clampToOracleBand(outcome.verdict, decision.floor, decision.ceiling);
    const clamped = verdict !== outcome.verdict;
    return {
      verdict,
      explanation: clamped
        ? `${outcome.explanation} [juiz disse '${outcome.verdict}'; confinado a '${verdict}' pela faixa do oráculo — ${decision.explanation}]`
        : outcome.explanation,
      source: outcome.degraded ? 'degraded' : 'judge',
      judgeUsed: true,
      ...(clamped ? { judgeVerdictBeforeClamp: outcome.verdict } : {}),
    };
  }
  if (outcome.status === 'failed') {
    const motivo = `juiz falhou após ${outcome.attempts} tentativa(s): ${outcome.error.message}`;
    if (decision.candidate !== null) {
      return {
        verdict: decision.candidate,
        explanation: `${decision.explanation} — ${motivo}; veredito do oráculo preservado`,
        source: 'ground-truth',
        judgeUsed: false,
        judgeError: outcome.error,
      };
    }
    return {
      verdict: null,
      explanation: `sem oráculo e ${motivo} — sem veredito (fora do denominador)`,
      judgeUsed: false,
      judgeError: outcome.error,
    };
  }
  // Sem juiz configurado: o oráculo fica; sem oráculo, nada a afirmar.
  if (decision.candidate !== null) {
    return { verdict: decision.candidate, explanation: decision.explanation, source: 'ground-truth', judgeUsed: false };
  }
  return {
    verdict: null,
    explanation: `sem oráculo e ${outcome.reason ?? 'sem juiz configurado'} — sem veredito (fora do denominador)`,
    judgeUsed: false,
  };
}

// ---------------------------------------------------------------------------
// Verificador que não terminou: re-verificação cega e defeito da CÉLULA
// (IMPL-033, revisão — R-14a DEC-1/DEC-2)
// ---------------------------------------------------------------------------

/**
 * Índices dos checks a re-verificar: SÓ os que nem começaram (`notRun:
 * 'spawn'` — comando ausente/sem permissão, o único motivo que pode ser soluço
 * do ambiente, ex.: EAGAIN sob carga). Timeout e sinal NÃO entram: o comando
 * rodou e o código sob teste pendurou/morreu — repetir só nesse caso seria
 * retry dependente de resultado (um check instável ganharia até 3 chances).
 */
export function recheckIndices(oracle: Pick<OracleResult, 'checks'>): number[] {
  const idx: number[] = [];
  oracle.checks.forEach((c, i) => {
    if (c.notRun === 'spawn') idx.push(i);
  });
  return idx;
}

/**
 * Re-verificar só vale quando o oráculo ainda pode mudar a nota: execução que
 * terminou ou foi cortada por limite (o corte só é salvo pelo oráculo 100%),
 * SEM violação (que decide 'nao' de qualquer jeito). `error`/`cancelled` já
 * têm desfecho fixo — re-verificar ali só gastaria tempo (até 2× o timeout).
 */
export function shouldRecheckOracle(
  stopReason: AgentStopReason | string,
  oracle: Pick<OracleResult, 'checks' | 'violations'>,
): boolean {
  const cls = classifyStop(stopReason);
  if (cls !== 'completed' && cls !== 'limit') return false;
  if (oracle.violations.length > 0) return false;
  return recheckIndices(oracle).length > 0;
}

/**
 * Funde a re-verificação de ALGUNS checks (`indices`, na ordem de `recheck`)
 * no resultado anterior: substitui só esses checks e recalcula `score` e
 * `inconclusive` com a MESMA fórmula do oráculo (Σ ok·peso / Σ peso). Os
 * outros checks e as violações (medidas no diff) ficam como estavam — nenhum
 * check que já tinha desfecho ganha outra chance.
 */
export function mergeOracleRecheck(prev: OracleResult, indices: number[], recheck: OracleResult): OracleResult {
  const checks = prev.checks.map((c) => ({ ...c }));
  indices.forEach((i, k) => {
    const novo = recheck.checks[k];
    if (novo && checks[i]) checks[i] = { ...novo, label: checks[i].label, weight: checks[i].weight };
  });
  const sumWeight = checks.reduce((a, c) => a + c.weight, 0);
  const sumOk = checks.reduce((a, c) => a + (c.ok ? c.weight : 0), 0);
  return {
    checks,
    score: sumWeight > 0 ? sumOk / sumWeight : 0,
    violations: prev.violations,
    inconclusive: checks.some((c) => c.notRun !== undefined),
  };
}

/** O mínimo de uma rep que a regra da célula lê. */
export interface CellRep {
  oracle?: { checks: { label: string; notRun?: OracleNotRun }[] };
}

/** Defeito do ambiente numa célula (etapa): checks que não rodaram em NENHUMA execução. */
export interface OracleCellDefect {
  /** Rótulos dos checks que nem começaram em todas as execuções que rodaram o oráculo. */
  labels: string[];
  /** Execuções consideradas (todas as reps, de todos os contestants, com oráculo). */
  executions: number;
}

/**
 * Defeito do AMBIENTE da tarefa (R-14a DEC-2: "comando ausente → invalida a
 * célula para TODOS"). Decidido na CÉLULA, não na rep, porque o mesmo sintoma
 * (spawn falhou) tem dois donos: o ambiente (o comando não existe para
 * ninguém) ou o agente (apagou/estragou o script). A régua é simétrica: se um
 * check nem começou em NENHUMA das execuções da etapa que rodaram o oráculo —
 * todos os contestants, todas as reps —, o ambiente não serve e a etapa é
 * inválida para todos; se rodou em pelo menos uma, o ambiente serve e quem
 * não conseguiu rodá-lo fica com o check FALHO (já contado assim no `score`).
 * Timeout/sinal nunca são defeito do ambiente aqui (são desfecho do código).
 * `null` = sem defeito (ou nenhuma execução rodou o oráculo).
 */
export function oracleCellDefect(reps: CellRep[]): OracleCellDefect | null {
  const comOraculo = reps.filter((r) => r.oracle && r.oracle.checks.length > 0);
  if (comOraculo.length === 0) return null;
  const n = Math.min(...comOraculo.map((r) => r.oracle!.checks.length));
  const labels: string[] = [];
  for (let i = 0; i < n; i++) {
    if (comOraculo.every((r) => r.oracle!.checks[i].notRun === 'spawn')) {
      labels.push(comOraculo[0].oracle!.checks[i].label);
    }
  }
  return labels.length > 0 ? { labels, executions: comOraculo.length } : null;
}

/** O mínimo de uma rep que a procedência do veredito da etapa lê. */
export interface ProvenanceRep {
  path: VerdictPath;
  verdict: Verdict | null;
  explanation: string;
  source?: VerdictSource;
  judgeError?: VerdictError;
}

/**
 * Procedência do veredito AGREGADO de um contestant de agente numa etapa, nos
 * nomes fixos do CONVENTIONS §2 (`verdictSourceByContestant` /
 * `verdictErrorByContestant` do `ReferenceJudgeResult`):
 * - com veredito: a origem mais "frágil" entre as reps que pontuaram —
 *   `degraded` (painel reduzido) > `judge` (LLM) > `ground-truth` (oráculo) >
 *   `auto` (regra) —, porque o agregado depende de todas elas;
 * - sem veredito por motivo não-controle: o `judgeError` da 1ª rep que o tem
 *   (juiz falhou sem oráculo) ou `no_reference` (sem oráculo e sem juiz/dossiê:
 *   não houve régua — não é falha do juiz);
 * - tudo cancelado: nada (controle; a etapa inteira sai).
 */
export function agentStageProvenance(reps: ProvenanceRep[]): { source?: VerdictSource; error?: VerdictError } {
  const pontuadas = reps.filter((r) => r.verdict !== null);
  if (pontuadas.length > 0) {
    const ordem: VerdictSource[] = ['degraded', 'judge', 'ground-truth', 'auto'];
    const fontes = new Set(pontuadas.map((r) => r.source ?? 'auto'));
    return { source: ordem.find((f) => fontes.has(f)) ?? 'auto' };
  }
  const semVeredito = reps.filter((r) => r.path !== 'cancelled');
  if (semVeredito.length === 0) return {};
  const comErro = semVeredito.find((r) => r.judgeError);
  if (comErro?.judgeError) return { error: comErro.judgeError };
  return { error: { kind: 'no_reference', message: semVeredito[0].explanation.slice(0, 200) } };
}

// ---------------------------------------------------------------------------
// Métricas de agente (consumidores da árvore)
// ---------------------------------------------------------------------------
/** O mínimo de uma repetição que as contagens por etapa leem. */
export interface RepTally {
  path: VerdictPath;
  verdict: Verdict | null;
  judgeError?: VerdictError;
}

/** Contagens de UM contestant numa etapa (quem chama grava só as > 0). */
export interface RepCounts {
  /** Vereditos presentes, na ordem das reps (observações). */
  verdicts: Verdict[];
  /** Reps decididas pelo corte por limite (já 'nao'). */
  limitCuts: number;
  /** Reps canceladas (controle). */
  cancelled: number;
  /** Reps sem veredito por motivo NÃO-controle (sem oráculo: juiz falhou ou não foi chamado). */
  unscored: number;
  /** Reps com a flag `judgeError`. */
  judgeErrors: number;
}

/** Conta as repetições de um contestant numa etapa (puro). */
export function tallyReps(reps: RepTally[]): RepCounts {
  const verdicts: Verdict[] = [];
  let limitCuts = 0;
  let cancelled = 0;
  let unscored = 0;
  let judgeErrors = 0;
  for (const r of reps) {
    if (r.verdict !== null) verdicts.push(r.verdict);
    else if (r.path === 'cancelled') cancelled += 1;
    else unscored += 1;
    if (r.path === 'limit-cut') limitCuts += 1;
    if (r.judgeError) judgeErrors += 1;
  }
  return { verdicts, limitCuts, cancelled, unscored, judgeErrors };
}


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
   * por limite e check que não terminou incluídos como falha. Nada que dependa
   * do comportamento do agente tira uma rep do denominador; sem observação só
   * ficam: cancelamento/orçamento (controle, a etapa inteira sai), etapa com
   * defeito do ambiente (sai para TODOS) e rep SEM oráculo cujo juiz falhou ou
   * não foi chamado (Inspect: `unscored`, reportada em `unscoredReps`).
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
