// Aviso de TRUNCAMENTO da run (IMPL-014 / R-07b:REC-2). Mostra quantas
// chamadas (de TODOS os papéis: competidor, gabarito, juiz, duelo…) saíram
// cortadas no teto de tokens, quais papéis truncaram e quantas etapas ficaram
// fora do placar por isso; acima de 2% vira alerta (mesmo texto do CLI — a
// regra e o limiar vêm do módulo puro `src/engine/truncation.ts`, fonte única).
import type { CostRole, RunRecord } from '../api';
import { truncationAlert, truncationByRoleEffort, truncationCellAlert } from '../../../src/engine/truncation.js';
import { ROLE_LABEL } from '../../../src/budget.js';
import { Banner } from './primitives';

export function TruncationNotice({ record }: { record: RunRecord }) {
  const counts = record.truncationCounts;
  const rate = record.truncationRate;
  // Record anterior ao IMPL-014, ou nenhuma truncagem: nada a dizer.
  if (!counts || typeof rate !== 'number' || counts.truncated === 0) return null;
  const etapas = record.stages.filter((s) => s.incompleteReason === 'truncation').length;
  const gabaritos = record.stages.filter((s) => s.gabaritoCall?.truncated).length;
  const porPapel = record.finishSignalsByRole;
  const alerta = truncationAlert({ ...counts, rate }, porPapel);
  // IMPL-015: taxa por papel × esforço — só as células que truncaram; alerta > 1%.
  const celulas = truncationByRoleEffort(porPapel).filter((c) => c.truncated > 0);
  const alertaCelula = truncationCellAlert(celulas);
  const pct = (rate * 100).toFixed(1).replace('.', ',');
  const papeis = Object.entries(porPapel ?? {})
    .filter(([, c]) => c && c.truncated > 0)
    .map(([role, c]) => `${ROLE_LABEL[role as CostRole] ?? role} ${c!.truncated} de ${c!.calls}`)
    .join(', ');
  return (
    <Banner tone={alerta || alertaCelula ? 'warn' : 'neutral'}>
      {alerta ?? (
        <>
          {counts.truncated} de {counts.calls} chamadas ({pct}%) saíram truncadas no teto de tokens
          {papeis ? ` (${papeis})` : ''}
          {/* Competidor e gabarito são refeitos 1x com teto x2; juiz/duelo não (IMPL-015). */}
          {etapas > 0 ? ` — ${etapas} etapa(s) fora do placar.` : '.'}
        </>
      )}
      {gabaritos > 0 && ` ${gabaritos} gabarito(s) truncado(s) foram descartados — esses cenários foram julgados sem gabarito.`}
      {celulas.length > 0 && (
        <span className="mt-1 block text-muted-foreground">
          Por papel × esforço:{' '}
          {celulas
            .map(
              (c) =>
                `${ROLE_LABEL[c.role] ?? c.role} @ ${c.effort} ${c.truncated} de ${c.calls} ` +
                `(${(c.rate * 100).toFixed(1).replace('.', ',')}%)${c.alert ? ' — acima de 1%' : ''}`,
            )
            .join(' · ')}
          . Veredito de juiz/duelo truncado é descartado (nunca vira parcial nem empate).
        </span>
      )}
    </Banner>
  );
}
