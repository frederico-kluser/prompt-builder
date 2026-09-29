import { useId, useState } from 'react';
import { fmtNum, fmtPct, fmtUsd, type JevCascade, type JevCascadePoint, type JevContestant } from '../../engine/jev';

/**
 * Simulador de CASCATA (Jev → LLM): o Jev decide quando o sinal dele passa do
 * limiar; o resto escala para o LLM. A curva mostra o que se ganha de
 * acurácia a cada % escalado — uma série só (acurácia × % escalado, UM eixo
 * de cada), com a acurácia do LLM sozinho como referência rotulada. Custo não
 * vai num segundo eixo: sai nos números ao lado (US$ por 1k decisões).
 *
 * A curva vem do record (limiares 0, 0,05 … 1 sobre as respostas pareadas) —
 * nada é recalculado aqui além de escolher o ponto.
 */

const W = 340;
const H = 220;
const PAD = { l: 42, r: 14, t: 12, b: 34 };
const IW = W - PAD.l - PAD.r;
const IH = H - PAD.t - PAD.b;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-border px-3 py-2">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold">{value}</span>
      {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

export function CascadeSimulator({ cascades, contestants }: { cascades: JevCascade[]; contestants: JevContestant[] }) {
  const [par, setPar] = useState(0);
  const [iLimiar, setILimiar] = useState(18); // 0,90 — o auto padrão
  const id = useId();
  if (!cascades.length) return null;
  const k = cascades[Math.min(par, cascades.length - 1)];
  const nome = (cid: string) => contestants.find((c) => c.id === cid)?.label ?? cid;
  const ponto: JevCascadePoint = k.curve[Math.min(iLimiar, k.curve.length - 1)];
  const accs = [...k.curve.map((p) => p.accuracy), k.llmOnly.accuracy, k.decisionOnly.accuracy];
  const yMin = Math.max(0, Math.floor((Math.min(...accs) - 0.05) * 10) / 10);
  const x = (v: number) => PAD.l + v * IW;
  const y = (v: number) => PAD.t + (1 - (v - yMin) / (1 - yMin || 1)) * IH;
  const ordenada = [...k.curve].sort((a, b) => a.escalatedRate - b.escalatedRate);
  const ticksY = Array.from({ length: 5 }, (_, i) => yMin + ((1 - yMin) * i) / 4);

  return (
    <div className="flex flex-col gap-3">
      {cascades.length > 1 && (
        <label className="flex flex-wrap items-center gap-2 text-[13px]">
          Par
          <select className="rounded-md border border-border bg-background px-2 py-1 text-[13px]" value={par} onChange={(e) => setPar(Number(e.target.value))}>
            {cascades.map((c, i) => (
              <option key={`${c.decisionId}-${c.llmId}`} value={i}>
                {nome(c.decisionId)} → {nome(c.llmId)}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="text-[13px] text-muted-foreground">
        {nome(k.decisionId)} decide quando o sinal ≥ limiar; o resto vai para {nome(k.llmId)}. {k.n} decisões pareadas.
        {k.escalationToMatchLlm !== null
          ? ` Para empatar com o LLM sozinho, basta escalar ${fmtPct(k.escalationToMatchLlm)}.`
          : ' Nenhum limiar empata com o LLM sozinho.'}
      </p>
      <label htmlFor={`${id}-lim`} className="flex flex-wrap items-center gap-3 text-[13px]">
        Limiar do sinal: <strong className="tabular">{fmtNum(ponto.threshold, 2)}</strong>
        <input
          id={`${id}-lim`}
          type="range"
          min={0}
          max={k.curve.length - 1}
          step={1}
          value={Math.min(iLimiar, k.curve.length - 1)}
          onChange={(e) => setILimiar(Number(e.target.value))}
          className="w-56 accent-[var(--primary)]"
          aria-valuetext={`limiar ${fmtNum(ponto.threshold, 2)}: acurácia ${fmtPct(ponto.accuracy)}, ${fmtPct(ponto.escalatedRate)} escalado`}
        />
      </label>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Acurácia da cascata" value={fmtPct(ponto.accuracy)} sub={`LLM sozinho ${fmtPct(k.llmOnly.accuracy)}`} />
        <Stat label="Escalado para o LLM" value={fmtPct(ponto.escalatedRate)} />
        <Stat label="US$ / 1k decisões" value={fmtUsd(ponto.costPer1kDecisions)} sub={`LLM sozinho ${fmtUsd(k.llmOnly.costPer1kDecisions)}`} />
        <Stat label="Na política (banda auto)" value={fmtPct(k.atDefault.accuracy)} sub={`${fmtPct(k.atDefault.escalatedRate)} escalado`} />
      </div>
      <figure className="flex flex-col gap-1">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[28rem] text-muted-foreground" role="img" aria-label="Acurácia da cascata por fração escalada">
          {ticksY.map((t) => (
            <g key={t}>
              <line x1={x(0)} x2={x(1)} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
              <text x={PAD.l - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill="currentColor">
                {Math.round(t * 100)}%
              </text>
            </g>
          ))}
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <text key={t} x={x(t)} y={H - PAD.b + 14} textAnchor="middle" fontSize={10} fill="currentColor">
              {Math.round(t * 100)}%
            </text>
          ))}
          <text x={PAD.l + IW / 2} y={H - 4} textAnchor="middle" fontSize={10.5} fill="currentColor">
            fração escalada para o LLM
          </text>
          {/* Referência: LLM sozinho. */}
          <line x1={x(0)} x2={x(1)} y1={y(k.llmOnly.accuracy)} y2={y(k.llmOnly.accuracy)} stroke="var(--muted-foreground)" strokeOpacity={0.6} strokeWidth={1} />
          <text x={x(0) + 4} y={y(k.llmOnly.accuracy) - 4} fontSize={10} fill="currentColor">
            LLM sozinho {fmtPct(k.llmOnly.accuracy)}
          </text>
          <polyline
            points={ordenada.map((p) => `${x(p.escalatedRate)},${y(p.accuracy)}`).join(' ')}
            fill="none"
            stroke="var(--chart-1)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {k.curve.map((p, i) => (
            <g key={p.threshold} onClick={() => setILimiar(i)} className="cursor-pointer">
              <title>{`limiar ${fmtNum(p.threshold, 2)}: acurácia ${fmtPct(p.accuracy)}, ${fmtPct(p.escalatedRate)} escalado, ${fmtUsd(p.costPer1kDecisions)}/1k`}</title>
              <circle cx={x(p.escalatedRate)} cy={y(p.accuracy)} r={10} fill="transparent" />
            </g>
          ))}
          <circle cx={x(ponto.escalatedRate)} cy={y(ponto.accuracy)} r={5} fill="var(--chart-1)" stroke="var(--card)" strokeWidth={2} />
        </svg>
        <figcaption className="text-[12px] text-muted-foreground">Clique num ponto da curva ou use o controle para escolher o limiar.</figcaption>
      </figure>
    </div>
  );
}
