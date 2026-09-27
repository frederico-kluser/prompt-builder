// Aviso de TRUNCAMENTO da run (IMPL-014 / R-07b:REC-2). Mostra quantas
// chamadas saíram cortadas no teto de tokens e quantas etapas ficaram fora do
// placar por isso; acima de 2% vira alerta (mesmo texto do CLI — a regra e o
// limiar vêm do módulo puro `src/engine/truncation.ts`, fonte única).
import type { RunRecord } from '../api';
import { truncationAlert } from '../../../src/engine/truncation.js';
import { Banner } from './primitives';

export function TruncationNotice({ record }: { record: RunRecord }) {
  const counts = record.truncationCounts;
  const rate = record.truncationRate;
  // Record anterior ao IMPL-014, ou nenhuma truncagem: nada a dizer.
  if (!counts || typeof rate !== 'number' || counts.truncated === 0) return null;
  const etapas = record.stages.filter((s) => s.incompleteReason === 'truncation').length;
  const alerta = truncationAlert({ ...counts, rate });
  const pct = (rate * 100).toFixed(1).replace('.', ',');
  return (
    <Banner tone={alerta ? 'warn' : 'neutral'}>
      {alerta ?? (
        <>
          {counts.truncated} de {counts.calls} chamadas ({pct}%) saíram truncadas no teto de tokens
          {etapas > 0 ? ` — ${etapas} etapa(s) fora do placar.` : ' e foram refeitas com teto x2.'}
        </>
      )}
    </Banner>
  );
}
