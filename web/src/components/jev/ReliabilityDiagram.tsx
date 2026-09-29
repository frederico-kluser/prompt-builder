import { useState } from 'react';
import { fmtNum } from '../../engine/jev';
import { contestantColor, contestantShape, type ReliabilitySeries, type SeriesShape } from '../../jev/view';

/**
 * Diagrama de CONFIABILIDADE (calibração top-label): x = confiança média do
 * bin (pTop — a probabilidade da classe prevista, nunca o `confidence` opaco
 * da API), y = acurácia no bin. Na diagonal, "diz 80% e acerta 80%". Abaixo
 * dela = superconfiante; acima = subconfiante. Bins de mesma largura (10),
 * marcador maior = mais casos.
 *
 * Marcas finas (linha 2px, marcadores ≥ 8px com anel da superfície), grade em
 * filete, uma cor + um MARCADOR por competidor, legenda sempre presente com
 * ≥ 2 séries, dica por marcador e a tabela para quem não lê o gráfico.
 */

const W = 320;
const H = 280;
const PAD = { l: 40, r: 12, t: 12, b: 36 };
const IW = W - PAD.l - PAD.r;
const IH = H - PAD.t - PAD.b;
const x = (v: number) => PAD.l + v * IW;
const y = (v: number) => PAD.t + (1 - v) * IH;
const TICKS = [0, 0.25, 0.5, 0.75, 1];

export function Marker({ shape, cx, cy, r, color }: { shape: SeriesShape; cx: number; cy: number; r: number; color: string }) {
  const ring = { stroke: 'var(--card)', strokeWidth: 2, fill: color };
  if (shape === 'square') return <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} rx={1.5} {...ring} />;
  if (shape === 'triangle') return <polygon points={`${cx},${cy - r * 1.15} ${cx + r * 1.1},${cy + r * 0.85} ${cx - r * 1.1},${cy + r * 0.85}`} {...ring} />;
  if (shape === 'diamond') return <polygon points={`${cx},${cy - r * 1.2} ${cx + r * 1.2},${cy} ${cx},${cy + r * 1.2} ${cx - r * 1.2},${cy}`} {...ring} />;
  return <circle cx={cx} cy={cy} r={r} {...ring} />;
}

export function LegendSwatch({ i }: { i: number }) {
  const cor = contestantColor(i) ?? 'var(--muted-foreground)';
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="shrink-0">
      <Marker shape={contestantShape(i)} cx={7} cy={7} r={4.5} color={cor} />
    </svg>
  );
}

export function ReliabilityDiagram({ series, title }: { series: ReliabilitySeries[]; title: string }) {
  const [tabela, setTabela] = useState(false);
  const plot = series.filter((s) => contestantColor(s.index) !== null);
  const nMax = Math.max(1, ...plot.flatMap((s) => s.bins.map((b) => b.n)));
  const raio = (n: number) => 4 + 4 * Math.sqrt(n / nMax);
  if (series.length === 0) {
    return <p className="text-[13px] text-muted-foreground">Sem respostas pontuadas para desenhar a calibração.</p>;
  }
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-[13px] font-medium">{title}</figcaption>
      {series.length >= 2 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]" aria-label="Legenda">
          {series.map((s) => (
            <li key={s.contestant.id} className="flex items-center gap-1.5">
              {contestantColor(s.index) !== null ? <LegendSwatch i={s.index} /> : <span className="text-muted-foreground">(só na tabela)</span>}
              <span className="text-foreground">{s.contestant.label}</span>
              <span className="text-muted-foreground tabular">ECE {fmtNum(s.ece, 3)}</span>
            </li>
          ))}
        </ul>
      )}
      {series.length === 1 && (
        <p className="text-[12px] text-muted-foreground tabular">
          {series[0].contestant.label} · ECE {fmtNum(series[0].ece, 3)} · {series[0].n} respostas
        </p>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[26rem] text-muted-foreground" role="img" aria-label={`${title}: acurácia por faixa de confiança`}>
        {TICKS.map((t) => (
          <g key={t}>
            <line x1={x(0)} x2={x(1)} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <line x1={x(t)} x2={x(t)} y1={y(0)} y2={y(1)} stroke="var(--border)" strokeWidth={1} />
            <text x={PAD.l - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill="currentColor">
              {Math.round(t * 100)}%
            </text>
            <text x={x(t)} y={H - PAD.b + 14} textAnchor="middle" fontSize={10} fill="currentColor">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}
        <text x={PAD.l + IW / 2} y={H - 4} textAnchor="middle" fontSize={10.5} fill="currentColor">
          confiança média (pTop)
        </text>
        <text x={11} y={PAD.t + IH / 2} textAnchor="middle" fontSize={10.5} fill="currentColor" transform={`rotate(-90 11 ${PAD.t + IH / 2})`}>
          acurácia
        </text>
        {/* Diagonal: calibração perfeita. */}
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--muted-foreground)" strokeOpacity={0.55} strokeWidth={1} />
        {plot.map((s) => {
          const cor = contestantColor(s.index)!;
          const pts = s.bins.map((b) => `${x(b.conf)},${y(b.acc)}`).join(' ');
          return (
            <g key={s.contestant.id}>
              {s.bins.length > 1 && <polyline points={pts} fill="none" stroke={cor} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
              {s.bins.map((b) => (
                <g key={b.lo}>
                  <title>
                    {`${s.contestant.label} · faixa ${fmtNum(b.lo, 1)}–${fmtNum(b.hi, 1)}: ${b.n} resposta(s), confiança média ${fmtNum(b.conf, 2)}, acurácia ${fmtNum(b.acc, 2)}`}
                  </title>
                  {/* Alvo de toque maior que a marca. */}
                  <circle cx={x(b.conf)} cy={y(b.acc)} r={12} fill="transparent" />
                  <Marker shape={contestantShape(s.index)} cx={x(b.conf)} cy={y(b.acc)} r={raio(b.n)} color={cor} />
                </g>
              ))}
            </g>
          );
        })}
      </svg>
      <button type="button" className="self-start text-[12px] text-primary underline-offset-4 hover:underline" aria-expanded={tabela} onClick={() => setTabela((t) => !t)}>
        {tabela ? 'esconder a tabela' : 'ver em tabela'}
      </button>
      {tabela && (
        <table className="w-full text-left text-[12px] tabular">
          <caption className="sr-only">{title} — por faixa de confiança</caption>
          <thead className="text-[11px] text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 pr-2 font-medium">competidor</th>
              <th scope="col" className="py-1 pr-2 font-medium">faixa</th>
              <th scope="col" className="py-1 pr-2 font-medium">n</th>
              <th scope="col" className="py-1 pr-2 font-medium">confiança</th>
              <th scope="col" className="py-1 font-medium">acurácia</th>
            </tr>
          </thead>
          <tbody>
            {series.flatMap((s) =>
              s.bins.map((b) => (
                <tr key={`${s.contestant.id}-${b.lo}`} className="border-t border-border">
                  <td className="py-1 pr-2">{s.contestant.label}</td>
                  <td className="py-1 pr-2">
                    {fmtNum(b.lo, 1)}–{fmtNum(b.hi, 1)}
                  </td>
                  <td className="py-1 pr-2">{b.n}</td>
                  <td className="py-1 pr-2">{fmtNum(b.conf, 2)}</td>
                  <td className="py-1">{fmtNum(b.acc, 2)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
    </figure>
  );
}
