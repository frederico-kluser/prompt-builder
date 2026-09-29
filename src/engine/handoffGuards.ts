// Guarda-corpos do HANDOFF (IMPL-027, R-22:REC-6/DEC-6).
//
// `sessions winner --apply` leva o campeão de um treino para um arquivo de
// produção. Até aqui o único sinal consultado era `holdoutSkipped` (aviso): um
// campeão que REGREDIU no holdout — pior que a base justamente nos cenários que
// o treino nunca viu — ia para produção sem bloqueio, sem aviso e sem rastro.
//
// Política (R-22 Q9d: "gate por exit code com limiar explícito"):
//   • BLOQUEIA: `holdout.regressed`. Só passa com override JUSTIFICADO — o
//     motivo é devolvido aqui para quem aplica gravá-lo (auditoria + trailer).
//   • AVISA, sem bloquear: holdout pulado ou ausente, IC95% contendo 0 (ou sem
//     IC), `judgeDrift` e sessão não terminada. São sinais de evidência fraca,
//     não de evidência contrária — bloquear aí travaria todo treino pequeno.
//
// Puro (sem node:*, sem I/O): serve ao CLI hoje e ao SPA quando ele passar a
// promover campeões. A entrada é ESTRUTURAL (subconjunto do SessionRecord) de
// propósito: campos novos em `significance` (cluster stats) não quebram nada.
//
// cli#9: o aviso de holdout diz o MOTIVO real (`holdoutSkipReason`, derivado
// dos campos antigos em record legado) — antes toda sessão com < 20 cenários
// lia "pulado por orçamento/cancelamento" e o agente ia subir o --budget quando
// o remédio era ter mais cenários.

import { holdoutSkipReasonText } from '../holdout.js';
import { holdoutSkipReasonOf } from './sessionDecision.js';
import type { HoldoutSkipReason } from '../types.js';

/** Identificador estável de cada sinal (vai no JSON, no log de auditoria e no trailer). */
export type HandoffIssueCode =
  | 'holdout.regressed'
  | 'champion.undeclared'
  | 'holdout.skipped'
  | 'holdout.missing'
  | 'significance.ci_contains_zero'
  | 'significance.ci_below_zero'
  | 'significance.missing'
  | 'judge.drift'
  | 'session.unfinished'
  | 'override.applied'
  | 'override.unused';

export interface HandoffIssue {
  code: HandoffIssueCode;
  /** `block` impede o handoff sem override; `warn` só informa. */
  severity: 'block' | 'warn';
  message: string;
}

/** Override registrado: o motivo humano e os bloqueios que ele sobrepôs. */
export interface HandoffOverride {
  reason: string;
  bypassed: HandoffIssueCode[];
}

/** O que o gate lê do SessionRecord (subconjunto estrutural). */
export interface HandoffGuardInput {
  status?: string;
  holdout?: {
    n: number;
    controlScore: number;
    championScore: number;
    gain: number;
    regressed: boolean;
  };
  holdoutSkipped?: boolean;
  /** Por que não houve holdout (ausente em record antigo — derivado dos campos abaixo). */
  holdoutSkipReason?: HoldoutSkipReason;
  /** Parada da sessão: distingue orçamento/cancelamento do piso de cenários em record antigo. */
  stoppedReason?: string | null;
  budgetExhausted?: boolean;
  significance?: { ci95Pp: [number, number]; n?: number; meanDiffPp?: number; pValue?: number } | null;
  judgeDrift?: boolean;
  /** IMPL-065: declaração sob âncora humana (ausente em record antigo = sem bloqueio). */
  championDeclaration?: { declared: boolean; message?: string; curatedItems?: number; minCuratedItems?: number };
}

export interface HandoffGuardReport {
  /** true = há bloqueio SEM override: o handoff não pode gravar nada. */
  blocked: boolean;
  blocks: HandoffIssue[];
  warnings: HandoffIssue[];
  /** Presente quando um motivo de override válido foi dado (com ou sem bloqueio a sobrepor). */
  override: HandoffOverride | null;
}

/**
 * Motivo de override normalizado: uma linha só (vai para trailer de commit e
 * para uma linha JSONL), espaços colapsados. `null` = vazio — e motivo vazio
 * NÃO é override: o bloqueio continua de pé (fail-closed).
 */
export function normalizeOverrideReason(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const reason = raw.replace(/\s+/g, ' ').trim();
  return reason.length > 0 ? reason : null;
}

function fmtScore(v: number): string {
  return Number.isFinite(v) ? v.toFixed(1) : String(v);
}

function fmtPp(v: number): string {
  if (!Number.isFinite(v)) return `${v} pp`;
  return `${v > 0 ? '+' : ''}${v.toFixed(1)} pp`;
}

/** Holdout regredido: a flag gravada ou, por defesa, ganho negativo (record editado à mão). */
function holdoutRegressed(h: NonNullable<HandoffGuardInput['holdout']>): boolean {
  return h.regressed === true || (typeof h.gain === 'number' && Number.isFinite(h.gain) && h.gain < 0);
}

/**
 * Avalia os guarda-corpos do handoff de uma sessão. Sem `overrideReason`, um
 * holdout regredido deixa `blocked: true`; com ele, o bloqueio vira override
 * registrado e um aviso `override.applied` (que quem aplica mostra no stdout).
 */
export function evaluateHandoffGuards(
  input: HandoffGuardInput,
  opts: { overrideReason?: string | null } = {},
): HandoffGuardReport {
  const blocks: HandoffIssue[] = [];
  const warnings: HandoffIssue[] = [];

  const h = input.holdout;
  if (h && holdoutRegressed(h)) {
    blocks.push({
      code: 'holdout.regressed',
      severity: 'block',
      message:
        `campeão REGREDIU no holdout: ${fmtScore(h.championScore)} × base ${fmtScore(h.controlScore)} ` +
        `(${fmtPp(h.gain)} em ${h.n} cenários reservados) — o ganho do treino não generalizou.`,
    });
  }

  // IMPL-065 (R-05:REC-4): a sessão RECUSOU declarar campeão (itens curados
  // abaixo do piso) — o prompt é o melhor do bootstrap sintético, não
  // evidência. Levar para produção exige override justificado.
  if (input.championDeclaration?.declared === false) {
    blocks.push({
      code: 'champion.undeclared',
      severity: 'block',
      message:
        input.championDeclaration.message ??
        `campeão NÃO declarado: ${input.championDeclaration.curatedItems ?? 0} itens curados < piso ${input.championDeclaration.minCuratedItems ?? '?'}.`,
    });
  }

  // O motivo só vale sem resultado de holdout (com `holdout` não há o que explicar).
  const motivo = h ? undefined : holdoutSkipReasonOf({ ...input, significance: undefined });
  if (input.holdoutSkipped) {
    warnings.push({
      code: 'holdout.skipped',
      severity: 'warn',
      message: `campeão NÃO validado em holdout (${
        motivo ? holdoutSkipReasonText(motivo) : 'pulado'
      }) — pode estar sobreajustado.`,
    });
  } else if (!h) {
    warnings.push({
      code: 'holdout.missing',
      severity: 'warn',
      message: motivo
        ? `sessão sem resultado de holdout (${holdoutSkipReasonText(motivo)}) — campeão não validado contra sobreajuste.`
        : 'sessão sem resultado de holdout (seleção < 20 cenários, holdoutRatio 0, campeão = base ou run de ' +
          'holdout falhou) — campeão não validado contra sobreajuste.',
    });
  }

  const sig = input.significance;
  const ci = sig && Array.isArray(sig.ci95Pp) && sig.ci95Pp.length === 2 ? sig.ci95Pp : null;
  if (ci && Number.isFinite(ci[0]) && Number.isFinite(ci[1])) {
    const [lo, hi] = ci;
    const faixa = `[${fmtPp(lo)}, ${fmtPp(hi)}]`;
    if (hi < 0) {
      warnings.push({
        code: 'significance.ci_below_zero',
        severity: 'warn',
        message: `IC95% ${faixa} inteiro abaixo de 0: a evidência aponta o campeão como PIOR que a base.`,
      });
    } else if (lo <= 0) {
      warnings.push({
        code: 'significance.ci_contains_zero',
        severity: 'warn',
        message: `IC95% ${faixa} contém 0: o ganho não é distinguível de ruído.`,
      });
    }
  } else {
    warnings.push({
      code: 'significance.missing',
      severity: 'warn',
      message:
        sig === null
          ? 'sem IC95%: amostra pareada insuficiente (< 5 pares) ou nada a comparar — ganho não testado.'
          : 'sessão sem teste de significância — ganho não testado.',
    });
  }

  if (input.judgeDrift) {
    warnings.push({
      code: 'judge.drift',
      severity: 'warn',
      message:
        'o contrato do juiz MUDOU no meio da sessão (judgeDrift): parte do ganho entre iterações pode ser do juiz, não do prompt.',
    });
  }

  if (input.status && input.status !== 'finished') {
    warnings.push({
      code: 'session.unfinished',
      severity: 'warn',
      message: `sessão com status "${input.status}": o campeão pode não ser o final.`,
    });
  }

  const reason = normalizeOverrideReason(opts.overrideReason);
  let override: HandoffOverride | null = null;
  if (reason) {
    override = { reason, bypassed: blocks.map((b) => b.code) };
    warnings.push(
      blocks.length > 0
        ? {
            code: 'override.applied',
            severity: 'warn',
            message: `OVERRIDE: ${override.bypassed.join(', ')} sobreposto por decisão humana — motivo: "${reason}".`,
          }
        : {
            code: 'override.unused',
            severity: 'warn',
            message: `--override sem efeito: nenhum bloqueio a sobrepor (o motivo fica gravado mesmo assim: "${reason}").`,
          },
    );
  }

  return { blocked: blocks.length > 0 && override === null, blocks, warnings, override };
}
