import { fmtPct, type JevContestant, type JevMetrics } from '../../engine/jev';

/**
 * Bandas de AÇÃO por competidor: a fração das decisões que cai em "auto" (age
 * sozinho), "revisão" (humano no laço) e "abstém". As três faixas são
 * ORDENADAS (confiança decrescente) → um tom só, do mais forte ao mais fraco;
 * abstenção em cinza. Separação por vão de 2px na cor da superfície, nunca por
 * contorno. Os números ficam no texto ao lado (tinta de texto), não sobre a
 * cor — e "errado com confiança" é o que mais importa: erro DENTRO da banda
 * auto é erro que ninguém revisa.
 */

export const BAND_FILL = {
  auto: 'var(--chart-1)',
  hitl: 'color-mix(in oklch, var(--chart-1) 45%, var(--card))',
  abstain: 'color-mix(in oklch, var(--muted-foreground) 30%, var(--card))',
} as const;

const BAND_LABEL = { auto: 'auto', hitl: 'revisão', abstain: 'abstém' } as const;

export function BandLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]" aria-label="Legenda das bandas">
      {(['auto', 'hitl', 'abstain'] as const).map((b) => (
        <li key={b} className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-[3px]" style={{ background: BAND_FILL[b] }} aria-hidden="true" />
          {BAND_LABEL[b]}
        </li>
      ))}
    </ul>
  );
}

export function BandBars({ rows }: { rows: { contestant: JevContestant; metrics: JevMetrics; calibrated?: boolean }[] }) {
  if (!rows.length) return null;
  return (
    <div className="flex flex-col gap-3">
      <BandLegend />
      <ul className="flex flex-col gap-3">
        {rows.map(({ contestant, metrics, calibrated }) => {
          const b = calibrated && metrics.calibrated ? metrics.calibrated.bands : metrics.bands;
          const prec = calibrated && metrics.calibrated ? metrics.calibrated.precisionAtAuto : metrics.precisionAtAuto;
          const partes = (['auto', 'hitl', 'abstain'] as const).filter((k) => b[k] > 0);
          return (
            <li key={contestant.id} className="flex flex-col gap-1">
              <span className="flex flex-wrap items-baseline justify-between gap-x-3 text-[12.5px]">
                <span className="font-medium">{contestant.label}</span>
                <span className="text-muted-foreground tabular">
                  auto {fmtPct(b.auto)} · precisão na auto {fmtPct(prec)} · <span className="text-foreground">{metrics.wrongAuto}</span> errado(s) com confiança
                </span>
              </span>
              <div
                className="flex h-3 w-full gap-[2px] overflow-hidden rounded-[4px] bg-card"
                role="img"
                aria-label={`${contestant.label}: auto ${fmtPct(b.auto)}, revisão ${fmtPct(b.hitl)}, abstém ${fmtPct(b.abstain)}`}
              >
                {partes.map((k) => (
                  <span key={k} className="h-full first:rounded-l-[4px] last:rounded-r-[4px]" style={{ width: `${b[k] * 100}%`, background: BAND_FILL[k] }} title={`${BAND_LABEL[k]}: ${fmtPct(b[k])}`} />
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
