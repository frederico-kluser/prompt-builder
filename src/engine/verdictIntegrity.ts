// Integridade do veredito da run (IMPL-004, R-03b:REC-4) — núcleo PURO.
//
// Fonte única para os dois motores (Node e SPA importam daqui): a regra que
// decide se uma run que TERMINOU o pipeline é `finished` ou `inconclusive`, e
// a contagem `failureCountByRole` que o record carrega.
//
// Por quê: falha de juiz NÃO é veredito. Antes, juiz que caía (ou devolvia
// lixo) virava 'parcial' e entrava na média — a pesquisa mostra que UM veredito
// imputado já move o judge-score mais que o `minGain` (N3: resolve→parcial move
// 6,25 p.p. com n=8). Tirar o imputado da média resolve a mentira, mas cria
// outra: uma run com metade dos vereditos perdidos sairia "finished" com a
// mesma cara de uma run íntegra. Daí o status próprio.
//
// Regra (limiares de PROJETO — a pesquisa não achou fonte publicada para a
// taxa tolerável; ficam gravados no record para a decisão ser reproduzível):
//   • inconclusiva se, em ALGUM papel, (falhas + vereditos degradados) >
//     10% dos vereditos esperados daquele papel;
//   • inconclusiva se algum contestant tem n efetivo < 5 cenários julgados
//     (cenários DISTINTOS com veredito legítimo na régua primária da run).
//
// Só lê o record — zero LLM, zero I/O.

import type {
  Contestant,
  CostRole,
  JudgeResult,
  ReferenceJudgeResult,
  StageRecord,
  Verdict,
  VerdictError,
  VerdictErrorKind,
  VerdictIntegrity,
  VerdictSource,
} from '../types.js';

/** Teto de (falha + degradado) por papel para a run ser `finished`. */
export const MAX_FAILURE_RATE = 0.1;
/** Piso de cenários julgados por contestant para a run ser `finished`. */
export const MIN_JUDGED_SCENARIOS = 5;

/**
 * Papel responsável por cada motivo de veredito ausente. `blocked` devolve
 * `undefined`: bloqueio do gateway é defesa (moderação), não falha do
 * pipeline — fica fora de `failureCountByRole`, mas o contestant continua sem
 * observação ali (e isso pesa no n efetivo).
 */
export function failureRoleOf(kind: VerdictErrorKind, runner?: 'chat' | 'agent'): CostRole | undefined {
  switch (kind) {
    case 'judge_failed':
    case 'invalid_output':
    case 'timeout':
    case 'truncated':
    case 'no_reference':
      return 'judge';
    case 'competitor_error':
      return runner === 'agent' ? 'agent' : 'competitor';
    case 'blocked':
      return undefined;
  }
}

/** Soma dois mapas de contagem por papel (sessão = soma das runs). */
export function mergeFailureCounts(
  a: Partial<Record<CostRole, number>> | undefined,
  b: Partial<Record<CostRole, number>> | undefined,
): Partial<Record<CostRole, number>> | undefined {
  if (!a && !b) return undefined;
  const out: Partial<Record<CostRole, number>> = { ...(a ?? {}) };
  for (const [role, n] of Object.entries(b ?? {}) as [CostRole, number][]) {
    out[role] = (out[role] ?? 0) + (n ?? 0);
  }
  return out;
}

/**
 * Motivo de veredito ausente de um competidor cuja resposta não é julgável —
 * a REGRA DE ORIGEM do CONVENTIONS, num lugar só para os 3 juízes:
 * sem resposta/`error` => `competitor_error`; `blocked` => `blocked`;
 * `ok`/`refused` => `undefined` (julgável; vazia vira 'nao' automático).
 */
export function unjudgeableReason(
  response: { status: string; errorMsg?: string } | undefined,
): VerdictError | undefined {
  if (!response) {
    return { kind: 'competitor_error', message: 'Sem resposta registrada nesta etapa.' };
  }
  if (response.status === 'error') {
    return {
      kind: 'competitor_error',
      message: `Competidor falhou (infraestrutura): ${(response.errorMsg ?? 'erro sem mensagem').slice(0, 160)}`,
    };
  }
  if (response.status === 'blocked') {
    return {
      kind: 'blocked',
      message: `Resposta bloqueada pelo gateway/moderação: ${(response.errorMsg ?? 'sem detalhe').slice(0, 160)}`,
    };
  }
  return undefined;
}

type VerdictBearer = Pick<
  ReferenceJudgeResult | JudgeResult,
  'verdictByContestant' | 'verdictSourceByContestant' | 'verdictErrorByContestant'
>;

export interface IntegrityInput {
  stages: StageRecord[];
  contestants: Pick<Contestant, 'id' | 'runner'>[];
  /** A run pediu gabarito por cenário (julgamento por referência efetivo). */
  referenceJudging: boolean;
}

export interface IntegrityOptions {
  maxFailureRate?: number;
  minJudgedScenarios?: number;
}

export interface IntegrityAssessment {
  failureCountByRole: Partial<Record<CostRole, number>>;
  integrity: VerdictIntegrity;
  inconclusive: boolean;
}

const pct = (x: number): string => `${(x * 100).toFixed(1).replace(/\.0$/, '')}%`;

/**
 * Conta falhas/degradações por papel e o n efetivo por contestant, e decide
 * se a run é inconclusiva. Etapas cortadas (`incomplete`) ou puladas
 * (`error`) ficam FORA — elas já estão fora do placar e das médias; contá-las
 * aqui puniria a run duas vezes pelo mesmo corte.
 */
export function assessVerdictIntegrity(
  input: IntegrityInput,
  opts: IntegrityOptions = {},
): IntegrityAssessment {
  const maxFailureRate = opts.maxFailureRate ?? MAX_FAILURE_RATE;
  const minJudgedScenarios = opts.minJudgedScenarios ?? MIN_JUDGED_SCENARIOS;
  const expected: Partial<Record<CostRole, number>> = {};
  const failures: Partial<Record<CostRole, number>> = {};
  const degraded: Partial<Record<CostRole, number>> = {};
  const bump = (m: Partial<Record<CostRole, number>>, role: CostRole, n = 1): void => {
    m[role] = (m[role] ?? 0) + n;
  };

  const counted = (input.stages ?? []).filter((s) => s && s.spec && !s.error && !s.incomplete);
  // Régua PRIMÁRIA: com julgamento por referência em alguma etapa, o
  // judge-score só usa as etapas pointwise — o n efetivo tem de ser medido na
  // MESMA régua (uma etapa que caiu no listwise por falta de gabarito não
  // entra na média, então também não conta como cenário julgado).
  const primaryIsReference = counted.some((s) => s.referenceJudge);
  const judged = new Map<string, Set<string>>(input.contestants.map((c) => [c.id, new Set<string>()]));

  for (const s of counted) {
    // Cenário DISTINTO: as cópias de `repeats` compartilham a spec inteira, então
    // contam uma vez só (n efetivo é de cenários, não de observações).
    const scenarioKey = `${s.spec!.question ?? ''}\u0000${s.spec!.productContext ?? ''}`;
    // Gabarito: 1 por cenário quando a run pediu julgamento por referência.
    if (input.referenceJudging) {
      bump(expected, 'gabarito');
      if (!s.spec!.reference?.trim()) bump(failures, 'gabarito');
    }
    const vr: VerdictBearer | undefined = s.referenceJudge ?? s.judge;
    for (const c of input.contestants) {
      const runnerRole: CostRole = c.runner === 'agent' ? 'agent' : 'competitor';
      bump(expected, runnerRole);
      const v: Verdict | undefined = vr?.verdictByContestant?.[c.id];
      const src: VerdictSource | undefined = vr?.verdictSourceByContestant?.[c.id];
      const err: VerdictError | undefined = vr?.verdictErrorByContestant?.[c.id];
      if (v !== undefined) {
        if (src === 'judge' || src === 'degraded') bump(expected, 'judge');
        if (src === 'degraded') bump(degraded, 'judge');
        const conta = primaryIsReference ? s.referenceJudge?.verdictByContestant?.[c.id] : v;
        if (conta !== undefined) judged.get(c.id)?.add(scenarioKey);
        continue;
      }
      if (err) {
        const role = failureRoleOf(err.kind, c.runner === 'agent' ? 'agent' : 'chat');
        if (role) {
          bump(failures, role);
          // O slot do competidor já está no denominador; o do juiz não.
          if (role === 'judge') bump(expected, 'judge');
        }
        continue;
      }
      // Sem veredito E sem motivo — conservador: um buraco sem explicação
      // nunca pode passar por run íntegra. Sem resposta registrada (o
      // competidor/agente lançou) => perda do competidor; com resposta (juiz
      // que sumiu sem registrar motivo, record antigo) => perda do juiz.
      if (!s.responses?.some((r) => r.contestantId === c.id)) {
        bump(failures, runnerRole);
      } else {
        bump(expected, 'judge');
        bump(failures, 'judge');
      }
    }
    // Duelos: só os decididos por LLM entram no denominador (o oráculo não
    // falha); todo duelo sem resultado é uma falha do papel `duel`.
    for (const d of s.duels?.duels ?? []) {
      if (d.source !== 'ground-truth') bump(expected, 'duel');
    }
    const falhos = s.duels?.failedDuels?.length ?? 0;
    if (falhos > 0) {
      bump(expected, 'duel', falhos);
      bump(failures, 'duel', falhos);
    }
  }

  const failureCountByRole: Partial<Record<CostRole, number>> = {};
  const reasons: string[] = [];
  for (const [role, total] of Object.entries(expected) as [CostRole, number][]) {
    if (!total) continue;
    const f = failures[role] ?? 0;
    const d = degraded[role] ?? 0;
    failureCountByRole[role] = f;
    const rate = (f + d) / total;
    if (rate > maxFailureRate) {
      reasons.push(
        `papel ${role}: ${f + d} de ${total} vereditos perdidos${d ? ` (${d} degradados)` : ''} ` +
          `= ${pct(rate)} > ${pct(maxFailureRate)}`,
      );
    }
  }

  const judgedScenariosByContestant: Record<string, number> = {};
  const poucos: string[] = [];
  for (const c of input.contestants) {
    const n = judged.get(c.id)?.size ?? 0;
    judgedScenariosByContestant[c.id] = n;
    if (n < minJudgedScenarios) poucos.push(`${c.id} (${n})`);
  }
  if (poucos.length > 0) {
    reasons.push(
      `n efetivo < ${minJudgedScenarios} cenários julgados: ${poucos.join(', ')}`,
    );
  }

  const degradedByRole: Partial<Record<CostRole, number>> = {};
  for (const [role, n] of Object.entries(degraded) as [CostRole, number][]) if (n) degradedByRole[role] = n;

  return {
    failureCountByRole,
    integrity: {
      expectedByRole: expected,
      degradedByRole,
      judgedScenariosByContestant,
      maxFailureRate,
      minJudgedScenarios,
      reasons,
    },
    inconclusive: reasons.length > 0,
  };
}
