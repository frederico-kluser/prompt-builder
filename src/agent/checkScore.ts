// Pontuação F2P×P2P do oráculo (IMPL-039) — módulo PURO (sem node:*, sem I/O).
//
// Separado de `guard.ts` (que lê o filesystem) para que a árvore de veredito
// (`verdictTree.mergeOracleRecheck`, IMPL-033) recalcule a nota depois da
// re-verificação com a MESMA conta do oráculo — antes a fusão usava
// Σ(ok·peso)/Σ(peso) crua e desfazia a penalidade de P2P quebrado.
import type { OracleNotRun } from './types.js';

export type VerifyKind = 'fail_to_pass' | 'pass_to_pass';

/** Por que um check não teve exit normal (o mesmo union de `OracleResult.checks[].notRun`). */
export type NotRunReason = OracleNotRun;

export interface ScoredCheck {
  ok: boolean;
  weight: number;
  /** Ausente = `fail_to_pass` (compatível com o v1: todo check era "o que precisa passar"). */
  kind?: VerifyKind;
  /** O check não teve exit normal (timeout/sinal/spawn error/rebuild falho). */
  inconclusive?: boolean;
  /** Motivo do `inconclusive` — decide se um P2P conta como quebrado. */
  reason?: NotRunReason;
}

export interface CheckScore {
  /** Nota final em [0,1]: 0 se algum P2P quebrou; senão Σ(ok·w)/Σw dos F2P (ou dos P2P, se só há P2P). */
  score: number;
  /** Mesma conta sem a penalidade de P2P (auditoria). */
  rawScore: number;
  f2p: { passed: number; total: number };
  /**
   * `broken` ⇒ regressão. `unverified` = P2P que não pôde ser aferido (spawn
   * error, rebuild falho): a regressão NÃO foi descartada, logo a nota não pode
   * sustentar um `resolve` (quem consome trata `unverified > 0` como não-conclusivo).
   */
  p2p: { passed: number; total: number; broken: boolean; unverified: number };
}

/**
 * P2P que TRAVOU (timeout) ou MORREU por sinal está quebrado: por contrato ele
 * passava no seed, então "agora não termina" é regressão — não "não aferido".
 * Sem isto, um agente que faz o teste de regressão pendurar escapava do
 * `broken` e ficava com a nota cheia dos F2P. Spawn error (comando ausente) e
 * rebuild falho continuam inconclusivos: não dizem nada sobre o que o agente fez.
 */
function p2pBroken(c: ScoredCheck): boolean {
  if (c.ok) return false;
  if (!c.inconclusive) return true;
  return c.reason === 'timeout' || c.reason === 'signal';
}

/**
 * Pontuação F2P×P2P. Pura. P2P é REGRESSÃO: o que passava no seed e tem de
 * continuar passando. Quebrar um P2P zera a nota (a execução FALHOU), mesmo
 * com todos os F2P verdes — "consertei o bug quebrando o resto" não é solução.
 * P2P que não rodou por motivo alheio ao agente fica `unverified` (não zera,
 * mas também não deixa a nota cheia decidir sozinha).
 */
export function scoreChecks(checks: readonly ScoredCheck[]): CheckScore {
  const f2p = checks.filter((c) => (c.kind ?? 'fail_to_pass') === 'fail_to_pass');
  const p2p = checks.filter((c) => c.kind === 'pass_to_pass');
  const ratio = (xs: readonly ScoredCheck[]): number => {
    const w = xs.reduce((s, c) => s + c.weight, 0);
    return w > 0 ? xs.reduce((s, c) => s + (c.ok ? c.weight : 0), 0) / w : 0;
  };
  const broken = p2p.some(p2pBroken);
  const unverified = p2p.filter((c) => !c.ok && !p2pBroken(c)).length;
  const rawScore = f2p.length > 0 ? ratio(f2p) : ratio(p2p);
  return {
    score: broken ? 0 : rawScore,
    rawScore,
    f2p: { passed: f2p.filter((c) => c.ok).length, total: f2p.length },
    p2p: { passed: p2p.filter((c) => c.ok).length, total: p2p.length, broken, unverified },
  };
}

