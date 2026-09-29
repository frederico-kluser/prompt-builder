// IMPL-050 (gap 4) — `estimate --pilot-run <runId> | --pilot-session <id>`:
// o σd do plano de poder calibrado pelo IC95% de uma run-piloto GRAVADA, em
// vez da tabela (σd=0,5, "não calibrado"). Antes a doc do `train` mandava
// fazer a conta à mão porque o `estimate` só lia `--config`.
//
// A fonte do IC é sempre MEDIDA, nunca inventada:
//  • sessão: `significance` gravada pelo trainer (holdout ou seleção);
//  • run: o teste pareado recomputado das etapas gravadas — controle = a
//    régua da run (`holdout-control` > `carry` > `original`) × o vencedor
//    pela régua única do `runs winner`; sem régua (compare de modelos), o 1º
//    × o 2º colocado. Menos de 5 pares com veredito nos dois lados = recusa.

import { pairedSignificance, pairedStageScores, controlIdOf, pairCoverage, stageScoresByContestant } from '../stats.js';
import { seedFromId, sortStandings, winnerFromStandings } from '../engine/duelCore.js';
import { loadRun, loadSession } from '../storage.js';
import { isValidRecordId } from '../pathSafety.js';
import { CliError, EXIT } from './output.js';
import type { RunRecord, SessionRecord } from '../types.js';

export interface PilotCalibration {
  source: 'run' | 'session';
  id: string;
  /** IC95% bilateral da diferença pareada (p.p.). */
  ci95Pp: [number, number];
  /** Pares efetivos do piloto (o n do σd). */
  n: number;
  controlId?: string;
  championId?: string;
  /** Origem do p na sessão (holdout | seleção), quando veio de uma. */
  pOrigin?: string;
}

function naoUsavel(message: string, details: Record<string, unknown>, hint: string): CliError {
  return new CliError(message, EXIT.CONFIG, details, { code: 'estimate.pilot_unusable', hint });
}

function idInvalido(flag: string, id: string): CliError {
  return new CliError(`${flag} "${id}" não é um id válido.`, EXIT.USAGE, { flag, value: id }, {
    code: 'usage.invalid_flag_value',
    hint: `Use o id listado em \`prompt-builder ${flag === '--pilot-run' ? 'runs' : 'sessions'} list\`.`,
  });
}

/** Controle × campeão de uma run gravada (ver o cabeçalho). */
export function pilotPairOf(
  record: Pick<RunRecord, 'id' | 'contestants' | 'standings' | 'judgeScoreByContestant' | 'stages'>,
): {
  controlId?: string;
  championId?: string;
} {
  const ids = record.contestants.map((c) => c.id);
  const controle = controlIdOf(ids);
  const js = record.judgeScoreByContestant;
  // Sem standings nem judge-score (record antigo/parcial): a média dos
  // vereditos por etapa ordena — nunca "o 1º da lista".
  const porEtapa = stageScoresByContestant(record.stages, ids);
  const media = (id: string): number => {
    const xs = (porEtapa[id] ?? []).filter((x): x is number => typeof x === 'number');
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : -Infinity;
  };
  const nota = (id: string): number => (typeof js?.[id] === 'number' ? js[id] : media(id));
  const ordem: string[] = record.standings?.length
    ? sortStandings(record.standings, js, seedFromId(record.id)).map((r) => r.id)
    : [...ids].sort((a, b) => nota(b) - nota(a) || a.localeCompare(b));
  if (controle) {
    const w = winnerFromStandings(record).contestantId;
    const campeao = w && w !== controle ? w : ordem.find((id) => id !== controle);
    return { controlId: controle, championId: campeao };
  }
  return { championId: ordem[0], controlId: ordem[1] };
}

/** IC do piloto a partir de uma run gravada. */
export function pilotFromRun(record: RunRecord): PilotCalibration {
  const { controlId, championId } = pilotPairOf(record);
  if (!controlId || !championId) {
    throw naoUsavel(
      `A run-piloto "${record.id}" não tem dois contestants para parear.`,
      { runId: record.id },
      'Use uma run com controle (vary/train) ou com ≥ 2 modelos (compare).',
    );
  }
  const { controlScores, championScores } = pairedStageScores(record.stages, controlId, championId);
  const sig = pairedSignificance(controlScores, championScores);
  if (!sig) {
    const cov = pairCoverage(controlScores, championScores);
    throw naoUsavel(
      `A run-piloto "${record.id}" tem ${cov.nEfetivo} par(es) com veredito nos dois lados — menos de 5, sem IC para calibrar σd.`,
      { runId: record.id, controlId, championId, nEfetivo: cov.nEfetivo },
      'Rode um piloto com ≥ 5 cenários julgados (ou planeje pela tabela, sem --pilot-run).',
    );
  }
  return { source: 'run', id: record.id, ci95Pp: sig.ci95Pp, n: sig.nEfetivo, controlId, championId };
}

/** IC do piloto a partir da significância gravada numa sessão. */
export function pilotFromSession(record: SessionRecord): PilotCalibration {
  const s = record.significance;
  if (!s || !Array.isArray(s.ci95Pp)) {
    const ultima = record.runIds?.at(-1);
    throw naoUsavel(
      `A sessão "${record.id}" não tem significância gravada (menos de 5 pares efetivos, ou terminou antes do teste final).`,
      { sessionId: record.id },
      ultima
        ? `Calibre por uma run da sessão: \`prompt-builder estimate --config <arq> --pilot-run ${ultima}\`.`
        : 'Calibre por uma run-piloto: `--pilot-run <runId>`.',
    );
  }
  const origem = (s as { pOrigin?: unknown }).pOrigin;
  return {
    source: 'session',
    id: record.id,
    ci95Pp: [s.ci95Pp[0], s.ci95Pp[1]],
    n: typeof s.nEfetivo === 'number' ? s.nEfetivo : s.n,
    // `pOrigin` é gravado pelo trainer (IMPL-050) mas não faz parte do tipo
    // armazenado de sessões antigas — lido por forma.
    ...(typeof origem === 'string' ? { pOrigin: origem } : {}),
  };
}

/**
 * Lê o piloto pedido pelas flags (`--pilot-run` XOR `--pilot-session`), do
 * data-dir já fixado. `undefined` = sem piloto (plano pela tabela).
 */
export async function loadPilot(values: Record<string, unknown>): Promise<PilotCalibration | undefined> {
  const run = typeof values['pilot-run'] === 'string' ? values['pilot-run'].trim() : undefined;
  const sessao = typeof values['pilot-session'] === 'string' ? values['pilot-session'].trim() : undefined;
  if (run && sessao) {
    throw new CliError('Use --pilot-run OU --pilot-session, não os dois.', EXIT.USAGE, undefined, {
      code: 'usage.conflicting_flags',
      hint: 'A calibração vem de UM piloto: a run (IC recomputado) ou a sessão (IC gravado).',
    });
  }
  if (run) {
    if (!isValidRecordId(run)) throw idInvalido('--pilot-run', run);
    const r = await loadRun(run);
    if (!r) {
      throw new CliError(`Run-piloto "${run}" não encontrada no diretório de dados.`, EXIT.USAGE, { runId: run }, {
        code: 'runs.not_found',
        hint: 'Confira `prompt-builder runs list` e --data-dir.',
      });
    }
    return pilotFromRun(r);
  }
  if (sessao) {
    if (!isValidRecordId(sessao)) throw idInvalido('--pilot-session', sessao);
    const s = await loadSession(sessao);
    if (!s) {
      throw new CliError(`Sessão-piloto "${sessao}" não encontrada no diretório de dados.`, EXIT.USAGE, { sessionId: sessao }, {
        code: 'sessions.not_found',
        hint: 'Confira `prompt-builder sessions list` e --data-dir.',
      });
    }
    return pilotFromSession(s);
  }
  return undefined;
}
