import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Download, FileText } from 'lucide-react';
import type { RunRecord, SessionRecord } from '../api';
import { fetchRun, fetchSession } from '../api';
import {
  buildSessionReport,
  DECISION_LABEL,
  DEFAULT_CALLS_PER_MONTH,
  fmtDuration,
  fmtInt,
  fmtPct,
  fmtPp,
  fmtSignedNumber,
  fmtSignedUsd,
  fmtUsd,
  renderSessionReportMarkdown,
  ROLE_LABEL,
  VERDICT_LABEL,
  type CycleRow,
  type SessionReport,
} from '../engine/sessionReport';
import { renderSessionReportHtml } from '../engine/sessionReportHtml';
import { diffLines } from '../diff';
import { CopyButton } from '@/components/motion-ui/copy-button';
import { Skeleton } from '@/components/motion-ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Banner, DiffView, Pre, Screen, StatusPill } from '../components/primitives';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Relatório de CICLOS de um treino — a mesma leitura que `prompt-builder
// sessions report` (motor único em src/engine/sessionReport.ts, via shim) e a
// mesma linguagem visual da skill plannotator-visual-explainer: rótulo mono em
// caixa-alta, título em serifa, faixa de cartões, seções numeradas, linha do
// tempo e callouts — só com tokens semânticos do app (nada de cor na mão).
// "Baixar HTML" gera o MESMO arquivo que `sessions report --html`.
// ---------------------------------------------------------------------------

type Tone = 'good' | 'bad' | 'flat';

function tone(x: number | null | undefined, goodWhenPositive: boolean): Tone {
  if (x == null || !Number.isFinite(x) || x === 0) return 'flat';
  return x > 0 === goodWhenPositive ? 'good' : 'bad';
}

const TONE_TEXT: Record<Tone, string> = {
  good: 'text-resolve',
  bad: 'text-nao',
  flat: 'text-foreground',
};

function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('font-mono text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase', className)}>
      {children}
    </span>
  );
}

function Stat({ value, label, hint, t = 'flat' }: { value: string; label: string; hint?: string; t?: Tone }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-4 text-center">
      <div className={cn('font-display text-2xl leading-tight font-medium tabular', TONE_TEXT[t])}>{value}</div>
      <Eyebrow className="mt-1.5 block">{label}</Eyebrow>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Section({ n, title, id, children }: { n: number; title: string; id: string; children: ReactNode }) {
  return (
    <section id={id} className="mt-14 scroll-mt-20">
      <div className="mb-5 flex items-baseline gap-4 border-b border-border pb-2">
        <span className="font-mono text-xs font-semibold text-primary">{String(n).padStart(2, '0')}</span>
        <h2 className="font-display text-2xl font-medium">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Callout({ title, children, warn }: { title?: string; children: ReactNode; warn?: boolean }) {
  return (
    <div className={cn('my-4 rounded-r-xl border-l-[3px] bg-card px-5 py-4', warn ? 'border-l-parcial' : 'border-l-primary')}>
      {title && <h3 className="mb-1 font-display text-lg font-medium">{title}</h3>}
      <div className="text-sm leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}

function Chip({ children, highlight }: { children: ReactNode; highlight?: boolean }) {
  return (
    <span
      className={cn(
        'rounded-md px-2 py-0.5 font-mono text-[11px]',
        highlight ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

const DECISION_CHIP: Record<CycleRow['decision'], string> = {
  promoted: 'bg-resolve-soft text-resolve',
  held: 'bg-parcial-soft text-parcial',
  inconclusive: 'bg-parcial-soft text-parcial',
  baseline: 'bg-muted text-muted-foreground',
  stopped: 'bg-nao-soft text-nao',
};

// ---------------------------------------------------------------------------
// gráficos (SVG com classes semânticas: stroke-primary, fill-resolve…)
// ---------------------------------------------------------------------------

function CyclesChart({ report }: { report: SessionReport }) {
  const cy = report.cycles;
  if (cy.length === 0) return null;
  const W = 960;
  const H = 300;
  const padL = 48;
  const padR = 24;
  const padT = 34;
  const padB = 40;
  const inset = 56;
  const iw = W - padL - padR - 2 * inset;
  const ih = H - padT - padB;
  const xs = (i: number) => padL + inset + (cy.length === 1 ? iw / 2 : (iw * i) / (cy.length - 1));
  const ys = (v: number) => padT + ih - (Math.max(0, Math.min(100, v)) / 100) * ih;
  const series: { key: 'controlScorePp' | 'bestScorePp' | 'championScorePp'; line: string; dot: string; label: string; dash?: boolean }[] = [
    { key: 'controlScorePp', line: 'stroke-muted-foreground', dot: 'fill-muted-foreground', label: 'régua do ciclo', dash: true },
    { key: 'bestScorePp', line: 'stroke-chart-2', dot: 'fill-chart-2', label: 'melhor variante' },
    { key: 'championScorePp', line: 'stroke-primary', dot: 'fill-primary', label: 'campeão vigente' },
  ];
  return (
    <figure className="rounded-xl border border-border bg-card p-5">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Judge-score por ciclo" className="w-full">
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={ys(v)} y2={ys(v)} className="stroke-border" strokeWidth={1} />
            <text x={padL - 8} y={ys(v) + 4} textAnchor="end" className="fill-muted-foreground font-mono text-[13px]">
              {v}
            </text>
          </g>
        ))}
        {series.map((s) => {
          const pontos = cy
            .map((c, i) => (c[s.key] == null ? null : `${xs(i).toFixed(1)},${ys(c[s.key] as number).toFixed(1)}`))
            .filter(Boolean)
            .join(' ');
          if (!pontos) return null;
          return (
            <g key={s.key}>
              <polyline
                points={pontos}
                fill="none"
                strokeWidth={2.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={s.dash ? '6 5' : undefined}
                className={s.line}
              />
              {cy.map((c, i) =>
                c[s.key] == null ? null : (
                  <circle key={i} cx={xs(i)} cy={ys(c[s.key] as number)} r={4} className={s.dot}>
                    <title>{`${c.label} · ${s.label}: ${fmtPp(c[s.key], false)}`}</title>
                  </circle>
                ),
              )}
            </g>
          );
        })}
        {cy.map((c, i) => (
          <text key={c.iteration} x={xs(i)} y={H - 14} textAnchor="middle" className="fill-muted-foreground font-mono text-[13px]">
            {c.label}
          </text>
        ))}
        {cy.map((c, i) =>
          c.decision === 'promoted' ? (
            <text
              key={`p${c.iteration}`}
              x={xs(i)}
              y={ys(Math.max(c.championScorePp ?? 0, c.bestScorePp ?? 0, c.controlScorePp ?? 0)) - 14}
              textAnchor="middle"
              className="fill-resolve font-mono text-[12px] font-semibold"
            >
              ▲ promovida
            </text>
          ) : null,
        )}
      </svg>
      <figcaption className="mt-3 flex flex-wrap justify-center gap-x-5 gap-y-1 font-mono text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <i className="inline-block size-3 rounded-sm bg-muted-foreground" />
          régua do ciclo
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block size-3 rounded-sm bg-chart-2" />
          melhor variante
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block size-3 rounded-sm bg-primary" />
          campeão vigente
        </span>
      </figcaption>
    </figure>
  );
}

function CompareRow({ label, a, b, fmt }: { label: string; a: number | null; b: number | null; fmt: (x: number | null) => string }) {
  const max = Math.max(a ?? 0, b ?? 0) || 1;
  const pctOf = (x: number | null) => (x == null ? 0 : Math.max(1.5, (x / max) * 100));
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_1fr] items-center gap-x-4 gap-y-1.5 py-2 sm:grid-cols-[11rem_1fr]">
      <div className="row-span-2 text-sm font-medium">{label}</div>
      <div className="flex items-center gap-2">
        <div className="h-3.5 rounded-sm bg-muted-foreground/45" style={{ width: `${pctOf(a) * 0.78}%` }} />
        <span className="font-mono text-xs tabular">{fmt(a)}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-3.5 rounded-sm bg-primary" style={{ width: `${pctOf(b) * 0.78}%` }} />
        <span className="font-mono text-xs tabular">{fmt(b)}</span>
      </div>
    </div>
  );
}

function VerdictBar({ label, v }: { label: string; v: { resolve: number; parcial: number; nao: number } }) {
  const total = v.resolve + v.parcial + v.nao || 1;
  const seg = (n: number, cls: string, t: string) =>
    n > 0 ? (
      <span className={cn('flex items-center justify-center font-mono text-[11px]', cls)} style={{ flex: n }} title={`${t}: ${n}`}>
        {n}
      </span>
    ) : null;
  return (
    <div className="grid grid-cols-[5rem_1fr_3.5rem] items-center gap-3">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex h-6 overflow-hidden rounded-md border border-border">
        {seg(v.resolve, 'bg-resolve text-background', 'resolve')}
        {seg(v.parcial, 'bg-parcial text-background', 'parcial')}
        {seg(v.nao, 'bg-nao text-background', 'não resolve')}
      </div>
      <span className="text-right font-mono text-xs text-muted-foreground tabular">
        {fmtPct(((v.resolve + 0.5 * v.parcial) / total) * 100, false)}
      </span>
    </div>
  );
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// página
// ---------------------------------------------------------------------------

export function TrainingReport() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [callsPerMonth, setCallsPerMonth] = useState(DEFAULT_CALLS_PER_MONTH);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setError(null);
    setLoadingRuns(true);
    fetchSession(sessionId)
      .then(async (s) => {
        if (cancelled) return;
        setSession(s);
        // Runs da sessão + as de re-avaliação limpa (ids no gate, fora de runIds).
        const ids = new Set<string>(s.runIds ?? []);
        for (const it of s.bestPromptByIteration ?? []) {
          const rid = it.gate?.reeval?.runId;
          if (rid) ids.add(rid);
        }
        const got = await Promise.all([...ids].map((id) => fetchRun(id).catch(() => null)));
        if (!cancelled) setRuns(got.filter((r): r is RunRecord => Boolean(r)));
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoadingRuns(false));
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const report = useMemo<SessionReport | null>(() => {
    if (!session || loadingRuns) return null;
    // Tipos do web espelham os de src/ (mirror): mesma forma em runtime.
    return buildSessionReport(
      session as unknown as Parameters<typeof buildSessionReport>[0],
      runs as unknown as Parameters<typeof buildSessionReport>[1],
      { generatedAt: new Date().toISOString(), callsPerMonth },
    );
  }, [session, runs, loadingRuns, callsPerMonth]);

  if (error) {
    return (
      <Screen wide>
        <Banner tone="error">{error}</Banner>
      </Screen>
    );
  }
  if (!session || !report) {
    return (
      <Screen wide>
        <div className="flex flex-col gap-4 pt-6">
          <Skeleton className="h-10 w-2/3 rounded-lg" />
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-72 w-full rounded-xl" />
        </div>
      </Screen>
    );
  }

  const q = report.quality;
  const c = report.cost;
  const o = report.optimization;
  const s = report.session;
  const markdown = renderSessionReportMarkdown(report);
  const baseName = `relatorio-ciclos-${s.id.slice(0, 8)}`;
  const verdictBorder =
    report.verdict === 'melhorou'
      ? 'border-l-resolve'
      : report.verdict === 'piorou'
        ? 'border-l-nao'
        : report.verdict === 'inconclusivo'
          ? 'border-l-parcial'
          : 'border-l-primary';

  return (
    <Screen wide>
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <Link
          to={`/training/${s.id}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Voltar ao treino
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton value={markdown} label="Copiar relatório em Markdown" copiedLabel="Relatório copiado">
            Copiar
          </CopyButton>
          <Button variant="outline" size="sm" onClick={() => download(`${baseName}.md`, markdown, 'text/markdown')}>
            <FileText className="size-4" aria-hidden="true" /> Markdown
          </Button>
          <Button size="sm" onClick={() => download(`${baseName}.html`, renderSessionReportHtml(report), 'text/html')}>
            <Download className="size-4" aria-hidden="true" /> Baixar HTML
          </Button>
        </div>
      </div>

      <header className="mt-8">
        <Eyebrow>Relatório de ciclos · sessão {s.id.slice(0, 8)}</Eyebrow>
        <h1 className="mt-2 mb-6 font-display text-3xl leading-tight font-medium text-balance sm:text-4xl">
          {s.theme || 'Treino de prompt'}
        </h1>
        <div className={cn('rounded-xl border border-l-4 border-border bg-muted/50 px-5 py-4', verdictBorder)}>
          <Eyebrow className="mb-1 block">{VERDICT_LABEL[report.verdict]}</Eyebrow>
          <p className="text-base leading-relaxed">{report.headline}</p>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <StatusPill status={s.status} />
          <Chip>modelo {s.modelId}</Chip>
          <Chip>
            {s.cyclesRun}/{s.iterationsPlanned} ciclos
          </Chip>
          <Chip>{s.promotions} promoção(ões)</Chip>
          <Chip>duração {fmtDuration(s.durationMs)}</Chip>
        </div>
        {s.status === 'running' && (
          <Banner tone="warn" className="mt-4">
            A sessão ainda está rodando — este relatório é parcial e muda a cada ciclo concluído.
          </Banner>
        )}
      </header>

      <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          value={fmtPp(q.gainPp)}
          label="Δ qualidade"
          t={tone(q.gainPp, true)}
          hint={q.source === 'holdout' ? 'holdout' : q.source === 'training' ? 'cenários de treino' : 'sem par'}
        />
        <Stat value={`${fmtPp(q.originalScorePp, false)} → ${fmtPp(q.championScorePp, false)}`} label="Judge-score" hint="original → campeão" />
        <Stat value={fmtPct(c.deltaCostPct)} label="Δ custo/chamada" t={tone(c.deltaCostPct, false)} hint={`${fmtSignedUsd(c.per1kCalls?.deltaUsd)} / mil`} />
        <Stat value={fmtSignedNumber(c.deltaTokensIn)} label="Δ tokens entrada" t={tone(c.deltaTokensIn, false)} hint="por chamada" />
        <Stat value={fmtUsd(o.totalUsd)} label="Custo da otimização" hint={o.budgetUsd != null ? `de ${fmtUsd(o.budgetUsd)}` : undefined} />
        {c.paybackCalls != null ? (
          <Stat value={fmtInt(c.paybackCalls)} label="Chamadas p/ se pagar" t="good" />
        ) : (
          <Stat
            value={q.pValue == null ? '—' : q.pValue.toFixed(3).replace('.', ',')}
            label="p-valor"
            t={q.significant ? 'good' : 'flat'}
            hint={q.pOrigin === 'holdout' ? 'confirmação' : q.pOrigin === 'selecao' ? 'da seleção' : undefined}
          />
        )}
      </div>

      <Section n={1} title="Quanto melhorou" id="qualidade">
        <Callout title={VERDICT_LABEL[report.verdict]}>
          <p>{q.basis}</p>
          <p className="mt-2 font-mono text-xs text-primary">
            n = {q.n} (efetivo {q.nEfetivo}) · IC95 {q.ci95Pp ? `${fmtPp(q.ci95Pp[0])} a ${fmtPp(q.ci95Pp[1])}` : '—'} · p{' '}
            {q.pValue == null ? '—' : q.pValue.toFixed(4).replace('.', ',')}
            {q.pOrigin === 'holdout' ? ' · teste de confirmação (holdout)' : q.pOrigin === 'selecao' ? ' · p da própria seleção (anti-conservador)' : ''}
          </p>
        </Callout>
        {q.verdicts && (
          <div className="mt-6 flex flex-col gap-2.5">
            <div className="flex flex-wrap gap-4 font-mono text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5"><i className="inline-block size-3 rounded-sm bg-resolve" /> resolve</span>
              <span className="flex items-center gap-1.5"><i className="inline-block size-3 rounded-sm bg-parcial" /> parcial</span>
              <span className="flex items-center gap-1.5"><i className="inline-block size-3 rounded-sm bg-nao" /> não resolve</span>
            </div>
            <VerdictBar label="Original" v={q.verdicts.original} />
            <VerdictBar label="Campeão" v={q.verdicts.champion} />
          </div>
        )}
      </Section>

      <Section n={2} title="Ciclos de melhoria" id="ciclos">
        <CyclesChart report={report} />
        <ol className="mt-8 flex flex-col">
          {report.cycles.map((cy, i) => (
            <li key={cy.iteration} className="grid grid-cols-[4.5rem_1.75rem_1fr] gap-x-3 sm:grid-cols-[6rem_1.75rem_1fr]">
              <div className="pt-1 text-right font-mono text-xs text-muted-foreground">{cy.label}</div>
              <div className="flex flex-col items-center">
                <span
                  className={cn(
                    'mt-1.5 size-3.5 shrink-0 rounded-full border-[3px]',
                    cy.decision === 'promoted'
                      ? 'border-resolve bg-resolve'
                      : cy.decision === 'stopped'
                        ? 'border-nao bg-nao'
                        : 'border-primary bg-card',
                  )}
                />
                {i < report.cycles.length - 1 && <span className="my-1 w-0.5 flex-1 bg-border" />}
              </div>
              <div className="pb-7">
                <h3 className="font-display text-lg font-medium">
                  {cy.decision === 'promoted'
                    ? `Promovida: ${cy.championLabel}`
                    : cy.decision === 'stopped'
                      ? 'Ciclo interrompido'
                      : `Régua manteve o título (${DECISION_LABEL[cy.decision]})`}
                </h3>
                <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                  {cy.variants} variante(s) contra a régua ({cy.controlId === 'original' ? 'prompt original' : 'campeão anterior'}). Δ bruto{' '}
                  {fmtPp(cy.gainPp)}
                  {cy.gainCorrectedPp != null && `, corrigido ${fmtPp(cy.gainCorrectedPp)}`}
                  {cy.minGainPp != null && `, margem exigida ${fmtPp(cy.minGainPp)}`}
                  {cy.reeval &&
                    `; re-avaliação limpa ${fmtPp(cy.reeval.gainPp)} em ${cy.reeval.size} cenário(s) — ${cy.reeval.confirmed ? 'confirmada' : 'não confirmada'}`}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Chip>custo {fmtUsd(cy.costUsd)}</Chip>
                  {cy.technique && <Chip highlight>{cy.technique}</Chip>}
                  <Link to={`/runs/${cy.runId}`} className="rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground">
                    run {cy.runId.slice(0, 8)}
                  </Link>
                </div>
              </div>
            </li>
          ))}
        </ol>
        <div className="scroll-slim overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[42rem] text-sm">
            <thead className="bg-muted/60">
              <tr className="text-left font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
                <th className="px-3.5 py-2.5">Ciclo</th>
                <th className="px-3.5 py-2.5">Régua</th>
                <th className="px-3.5 py-2.5">Melhor</th>
                <th className="px-3.5 py-2.5">Δ bruto</th>
                <th className="px-3.5 py-2.5">Δ corrigido</th>
                <th className="px-3.5 py-2.5">p aj.</th>
                <th className="px-3.5 py-2.5">Decisão</th>
                <th className="px-3.5 py-2.5">Custo</th>
                <th className="px-3.5 py-2.5">Acumulado</th>
              </tr>
            </thead>
            <tbody>
              {report.cycles.map((cy) => (
                <tr key={cy.iteration} className="border-t border-border tabular">
                  <td className="px-3.5 py-2.5">{cy.label}</td>
                  <td className="px-3.5 py-2.5">{fmtPp(cy.controlScorePp, false)}</td>
                  <td className="px-3.5 py-2.5">{fmtPp(cy.bestScorePp, false)}</td>
                  <td className={cn('px-3.5 py-2.5 font-medium', TONE_TEXT[tone(cy.gainPp, true)])}>{fmtPp(cy.gainPp)}</td>
                  <td className="px-3.5 py-2.5">{fmtPp(cy.gainCorrectedPp)}</td>
                  <td className="px-3.5 py-2.5">{cy.pAdjusted == null ? '—' : cy.pAdjusted.toFixed(3).replace('.', ',')}</td>
                  <td className="px-3.5 py-2.5">
                    <span className={cn('rounded-md px-2 py-0.5 font-mono text-[10.5px] font-semibold uppercase', DECISION_CHIP[cy.decision])}>
                      {DECISION_LABEL[cy.decision]}
                    </span>
                    {cy.heldBy?.length ? <div className="mt-0.5 text-[11px] text-muted-foreground">{cy.heldBy.join(', ')}</div> : null}
                  </td>
                  <td className="px-3.5 py-2.5">{fmtUsd(cy.costUsd)}</td>
                  <td className="px-3.5 py-2.5">{fmtUsd(cy.cumulativeCostUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section n={3} title="Quanto a mudança mexe no custo de uso" id="custo">
        {c.pairs === 0 ? (
          <Callout title="Custo por chamada não medido" warn>
            {c.basis}
          </Callout>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {c.basis} — {c.pairs} par(es).
            </p>
            <div className="mt-4 rounded-xl border border-border bg-card px-5 py-3">
              <CompareRow label="Custo por chamada" a={c.original.meanCostUsd} b={c.champion.meanCostUsd} fmt={(x) => fmtUsd(x)} />
              <CompareRow label="Tokens de entrada" a={c.original.meanTokensIn} b={c.champion.meanTokensIn} fmt={fmtInt} />
              <CompareRow label="Tokens de saída" a={c.original.meanTokensOut} b={c.champion.meanTokensOut} fmt={fmtInt} />
              <CompareRow label="Latência (ms)" a={c.original.meanLatencyMs} b={c.champion.meanLatencyMs} fmt={fmtInt} />
              <div className="mt-2 flex justify-center gap-5 font-mono text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5"><i className="inline-block size-3 rounded-sm bg-muted-foreground/45" /> original</span>
                <span className="flex items-center gap-1.5"><i className="inline-block size-3 rounded-sm bg-primary" /> campeão</span>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <Eyebrow>Volume mensal (chamadas)</Eyebrow>
                <Input
                  type="number"
                  min={1}
                  step={1000}
                  className="w-44"
                  value={callsPerMonth}
                  onChange={(e) => {
                    const n = Math.round(Number(e.target.value));
                    if (Number.isFinite(n) && n > 0) setCallsPerMonth(n);
                  }}
                />
              </label>
            </div>
            {c.projection && (
              <div className="mt-3 scroll-slim overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full min-w-[28rem] text-sm tabular">
                  <thead className="bg-muted/60">
                    <tr className="text-left font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
                      <th className="px-3.5 py-2.5">Volume</th>
                      <th className="px-3.5 py-2.5">Original</th>
                      <th className="px-3.5 py-2.5">Campeão</th>
                      <th className="px-3.5 py-2.5">Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-border">
                      <td className="px-3.5 py-2.5">1 chamada</td>
                      <td className="px-3.5 py-2.5">{fmtUsd(c.original.meanCostUsd)}</td>
                      <td className="px-3.5 py-2.5">{fmtUsd(c.champion.meanCostUsd)}</td>
                      <td className={cn('px-3.5 py-2.5 font-medium', TONE_TEXT[tone(c.deltaCostPerCallUsd, false)])}>{fmtSignedUsd(c.deltaCostPerCallUsd)}</td>
                    </tr>
                    {c.per1kCalls && (
                      <tr className="border-t border-border">
                        <td className="px-3.5 py-2.5">1.000 chamadas</td>
                        <td className="px-3.5 py-2.5">{fmtUsd(c.per1kCalls.originalUsd)}</td>
                        <td className="px-3.5 py-2.5">{fmtUsd(c.per1kCalls.championUsd)}</td>
                        <td className={cn('px-3.5 py-2.5 font-medium', TONE_TEXT[tone(c.per1kCalls.deltaUsd, false)])}>{fmtSignedUsd(c.per1kCalls.deltaUsd)}</td>
                      </tr>
                    )}
                    <tr className="border-t border-border">
                      <td className="px-3.5 py-2.5">{fmtInt(c.projection.callsPerMonth)} / mês</td>
                      <td className="px-3.5 py-2.5">{fmtUsd(c.projection.originalUsd)}</td>
                      <td className="px-3.5 py-2.5">{fmtUsd(c.projection.championUsd)}</td>
                      <td className={cn('px-3.5 py-2.5 font-medium', TONE_TEXT[tone(c.projection.deltaUsd, false)])}>{fmtSignedUsd(c.projection.deltaUsd)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
            {c.paybackCalls != null && (
              <Callout>
                O campeão é mais barato: a otimização ({fmtUsd(o.totalUsd)}) se paga em {fmtInt(c.paybackCalls)} chamada(s).
              </Callout>
            )}
            {c.extraUsdPer1kPerPp != null && (
              <Callout>
                O campeão custa mais: cada p.p. de qualidade sai por {fmtUsd(c.extraUsdPer1kPerPp)} a mais a cada 1.000 chamadas.
              </Callout>
            )}
          </>
        )}
      </Section>

      <Section n={4} title="Quanto custou otimizar" id="otimizacao">
        {o.budgetUsd != null ? (
          <>
            <div className="h-3 overflow-hidden rounded-full border border-border bg-muted" role="img" aria-label="Uso do orçamento">
              <div className="h-full bg-primary" style={{ width: `${Math.min(100, o.budgetUsedPct ?? 0)}%` }} />
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              {fmtUsd(o.totalUsd)} de {fmtUsd(o.budgetUsd)} ({fmtPct(o.budgetUsedPct, false)} do teto)
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Total gasto: {fmtUsd(o.totalUsd)} (sessão sem teto registrado).</p>
        )}
        {o.byRole.length > 0 && (
          <div className="mt-4 flex flex-col gap-2 rounded-xl border border-border bg-card px-5 py-4">
            {o.byRole.map((r) => {
              const max = Math.max(...o.byRole.map((x) => x.usd)) || 1;
              return (
                <div key={r.role} className="grid grid-cols-[minmax(0,10rem)_1fr] items-center gap-3 sm:grid-cols-[13rem_1fr]">
                  <span className="truncate text-sm">{ROLE_LABEL[r.role] ?? r.role}</span>
                  <div className="flex items-center gap-2">
                    <div className="h-3.5 rounded-sm bg-chart-3" style={{ width: `${Math.max(1.5, (r.usd / max) * 70)}%` }} />
                    <span className="font-mono text-xs tabular">
                      {fmtUsd(r.usd)} · {fmtPct(r.pct, false)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {(o.pendingUsd > 0 || (o.sessionOverheadUsd ?? 0) > 0) && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {o.pendingUsd > 0 && <Chip>pendente sem custo apurado: {fmtUsd(o.pendingUsd)}</Chip>}
            {(o.sessionOverheadUsd ?? 0) > 0 && <Chip>fora das runs (reescritor/reflexão): {fmtUsd(o.sessionOverheadUsd)}</Chip>}
          </div>
        )}
        {o.accuracy && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Chip>{o.accuracy.exact} chamada(s) com custo exato</Chip>
            <Chip>{o.accuracy.estimated} estimada(s)</Chip>
            {o.accuracy.unknown > 0 && <Chip highlight>{o.accuracy.unknown} desconhecida(s)</Chip>}
          </div>
        )}
      </Section>

      <Section n={5} title="O que mudou no prompt" id="prompt">
        {report.prompts.changed ? (
          <>
            <div className="mb-3 flex flex-wrap gap-1.5">
              <Chip highlight>{report.prompts.championLabel}</Chip>
              {report.prompts.promotedAtIteration != null && <Chip>promovido no ciclo {report.prompts.promotedAtIteration + 1}</Chip>}
              <Chip>
                +{report.prompts.diff.linesAdded} / −{report.prompts.diff.linesRemoved} linhas
              </Chip>
              <Chip>
                {fmtSignedNumber(report.prompts.diff.charsDelta)} caracteres (≈ {fmtSignedNumber(report.prompts.diff.approxTokensDelta)} tokens)
              </Chip>
            </div>
            <DiffView diff={diffLines(report.prompts.original, report.prompts.champion)} />
            <details className="mt-3 rounded-xl border border-border bg-card">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Prompt campeão (texto integral)</summary>
              <div className="px-4 pb-4">
                <Pre>{report.prompts.champion}</Pre>
              </div>
            </details>
            <details className="mt-2 rounded-xl border border-border bg-card">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Prompt original (texto integral)</summary>
              <div className="px-4 pb-4">
                <Pre>{report.prompts.original || '(vazio)'}</Pre>
              </div>
            </details>
          </>
        ) : (
          <Callout>Nenhuma variante superou a régua: o prompt campeão é o original.</Callout>
        )}
      </Section>

      <Section n={6} title="Ressalvas" id="ressalvas">
        {report.warnings.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma ressalva: a leitura acima vale como está.</p>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-border bg-card">
            {report.warnings.map((w) => (
              <li key={w} className="flex items-start gap-3 border-b border-border px-4 py-3 text-sm last:border-b-0">
                <span className="mt-0.5 rounded-md bg-parcial-soft px-2 py-0.5 font-mono text-[10.5px] font-semibold text-parcial uppercase">
                  ressalva
                </span>
                <span>{w}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section n={7} title="Método e reprodução" id="metodo">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
          {(
            [
              ['Modelo sob teste', s.modelId],
              ['Juízes', s.judgeModelIds.join(', ') || '—'],
              ['Gerador de cenários', s.datagenModelId],
              ['Reescritor', s.optimizerModelId ?? s.datagenModelId],
              ['Convergência', s.convergedAtIteration != null ? `ciclo ${s.convergedAtIteration + 1} (${s.convergenceReason ?? '—'})` : '—'],
              ['Parada', s.stoppedReason ? `${s.stoppedReason}${s.stoppedAtPhase ? ` em ${s.stoppedAtPhase}` : ''}` : '—'],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-mono text-[12.5px] break-all">{v}</dd>
            </div>
          ))}
        </dl>
        <Pre className="mt-4">{`prompt-builder sessions report ${s.id} --html relatorio.html --annotate
prompt-builder sessions report ${s.id} --json
prompt-builder sessions winner ${s.id} --prompt-only`}</Pre>
      </Section>

      <footer className="mt-16 border-t border-border pt-4 font-mono text-[11px] text-muted-foreground">
        prompt-builder · {report.format} · sessão {s.id}
      </footer>
    </Screen>
  );
}
