import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Banner, EmptyState, PageHeader, Screen, SectionHead, Tag } from '../../components/primitives';
import { SpecDiff } from '../../components/jev/SpecDiff';
import {
  DEFAULT_REQUESTS_PER_MONTH,
  buildJevSessionReport,
  fmtNum,
  fmtP,
  fmtPct,
  fmtPp,
  fmtUsd,
  renderJevSessionReportHtml,
  renderJevSessionReportMarkdown,
  type JevHeadline,
  type JevRunRecord,
} from '../../engine/jev';
import { getJevSessionRuns } from '../../jev/api';
import { useJevRecord } from '../../jev/useJevRecord';
import { CYCLE_DECISION_LABEL } from '../../jev/view';

/**
 * Relatório de CICLOS do treino JEV (`prompt-builder-jev-report@1`, o MESMO
 * que o `jev report` do CLI gera): quanto melhorou (holdout, pareado), quanto
 * a mudança mexe no custo de USAR (só tokens de entrada — a saída é grátis),
 * quanto custou otimizar e quando se paga. Baixa em Markdown, HTML e JSON.
 */

const VERDICT_LABEL: Record<string, string> = {
  melhorou: 'melhorou',
  piorou: 'piorou',
  'sem-diferenca': 'sem diferença',
  inconclusivo: 'inconclusivo',
  'sem-mudanca': 'sem mudança',
};

function baixar(nome: string, texto: string, tipo: string): void {
  const url = URL.createObjectURL(new Blob([texto], { type: tipo }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  a.click();
  URL.revokeObjectURL(url);
}

function Linha({ nome, h }: { nome: string; h: JevHeadline }) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <th scope="row" className="px-3 py-2 text-left font-medium">
        {nome}
      </th>
      <td className="px-2 py-2 text-right">{fmtPct(h.accuracy)}</td>
      <td className="px-2 py-2 text-right">{fmtNum(h.brierScore, 1)}</td>
      <td className="px-2 py-2 text-right">{fmtNum(h.ece, 3)}</td>
      <td className="px-2 py-2 text-right">{fmtPct(h.coverageAtAuto)}</td>
      <td className="px-3 py-2 text-right">{fmtPct(h.precisionAtAuto)}</td>
    </tr>
  );
}

export function JevReportPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { record: s } = useJevRecord('session', sessionId);
  const [runs, setRuns] = useState<JevRunRecord[] | null>(null);
  const [rpm, setRpm] = useState(String(DEFAULT_REQUESTS_PER_MONTH));

  useEffect(() => {
    if (!s) return;
    let ativo = true;
    void getJevSessionRuns(s).then((r) => ativo && setRuns(r));
    return () => {
      ativo = false;
    };
  }, [s]);

  const report = useMemo(() => {
    if (!s || !runs) return null;
    const n = Number(rpm);
    return buildJevSessionReport(s, runs, { requestsPerMonth: Number.isFinite(n) && n > 0 ? n : DEFAULT_REQUESTS_PER_MONTH });
  }, [s, runs, rpm]);

  if (s === undefined || (s && !report)) {
    return (
      <Screen wide>
        <p className="text-sm text-muted-foreground">Carregando…</p>
      </Screen>
    );
  }
  if (s === null || !report) {
    return (
      <Screen wide>
        <EmptyState>Treino JEV não encontrado neste navegador.</EmptyState>
      </Screen>
    );
  }
  const base = `jev-relatorio-${s.id.slice(0, 8)}`;

  return (
    <Screen wide>
      <PageHeader
        title={`Relatório de ciclos — ${report.session.theme}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Tag>veredito: {VERDICT_LABEL[report.verdict] ?? report.verdict}</Tag>
            <span>
              {report.session.cyclesRun}/{report.session.iterationsPlanned} ciclos · {report.session.promotions} promoção(ões) · {report.session.modelId}
            </span>
          </span>
        }
        actions={
          <>
            <Link className="inline-flex items-center gap-1 text-[13px] text-primary underline-offset-4 hover:underline" to={`/jev/training/${s.id}`}>
              <ArrowLeft className="size-3.5" aria-hidden="true" />
              sessão
            </Link>
            <Button type="button" variant="outline" size="sm" onClick={() => baixar(`${base}.md`, renderJevSessionReportMarkdown(report), 'text/markdown')}>
              <Download aria-hidden="true" />
              Markdown
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => baixar(`${base}.html`, renderJevSessionReportHtml(report), 'text/html')}>
              <Download aria-hidden="true" />
              HTML
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => baixar(`${base}.json`, JSON.stringify(report, null, 2), 'application/json')}>
              <Download aria-hidden="true" />
              JSON
            </Button>
          </>
        }
      />

      <Banner tone={report.verdict === 'piorou' ? 'error' : report.verdict === 'inconclusivo' ? 'warn' : 'neutral'}>
        <p className="text-sm text-foreground">{report.headline}</p>
      </Banner>

      <SectionHead>Quanto melhorou (holdout, com a política ajustada)</SectionHead>
      <div className="scroll-slim overflow-x-auto rounded-xl bg-card ring-1 ring-foreground/10">
        <table className="w-full text-left text-[12.5px] tabular">
          <caption className="sr-only">Original × campeã no holdout</caption>
          <thead className="text-[11px] text-muted-foreground">
            <tr className="border-b border-border">
              <th scope="col" className="px-3 py-2 font-medium" />
              <th scope="col" className="px-2 py-2 text-right font-medium">Acurácia</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Brier (p.p.)</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">ECE</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Cobertura auto</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Precisão auto</th>
            </tr>
          </thead>
          <tbody>
            <Linha nome="Original" h={report.quality.original} />
            <Linha nome="Campeã" h={report.quality.champion} />
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[13px] text-muted-foreground tabular">
        Δ acurácia {fmtPp(report.quality.deltaPp.accuracy)} · Δ Brier {fmtPp(report.quality.deltaPp.brierScore)} · IC 95%{' '}
        {report.quality.ci95Pp ? `${fmtPp(report.quality.ci95Pp[0])} … ${fmtPp(report.quality.ci95Pp[1])}` : '—'} · p {fmtP(report.quality.pValue)} · {report.quality.basis}
      </p>

      <SectionHead>Quanto muda o custo de USAR</SectionHead>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border px-3 py-2">
          <span className="block text-[11px] text-muted-foreground">Tokens de entrada / request</span>
          <span className="text-sm font-medium tabular">
            {fmtNum(report.cost.original.meanTokensIn, 0)} → {fmtNum(report.cost.champion.meanTokensIn, 0)}
          </span>
          {report.cost.deltaCostPct !== null && <span className="block text-[11px] text-muted-foreground">{fmtNum(report.cost.deltaCostPct, 1)}% por request</span>}
        </div>
        <div className="rounded-lg border border-border px-3 py-2">
          <span className="block text-[11px] text-muted-foreground">US$ por 1k requests</span>
          <span className="text-sm font-medium tabular">
            {report.cost.per1kRequests ? `${fmtUsd(report.cost.per1kRequests.originalUsd)} → ${fmtUsd(report.cost.per1kRequests.championUsd)}` : '—'}
          </span>
        </div>
        <label className="rounded-lg border border-border px-3 py-2">
          <span className="block text-[11px] text-muted-foreground">Projeção por mês (decisões)</span>
          <Input type="number" aria-label="Decisões por mês" className="mt-1 h-7 w-32" min={1} value={rpm} onChange={(e) => setRpm(e.target.value)} />
          {report.cost.projection && (
            <span className="mt-1 block text-[12px] tabular">
              {fmtUsd(report.cost.projection.originalUsd)} → {fmtUsd(report.cost.projection.championUsd)} ({report.cost.projection.deltaUsd >= 0 ? '+' : ''}
              {fmtUsd(report.cost.projection.deltaUsd)})
            </span>
          )}
        </label>
      </div>
      <p className="mt-2 text-[13px] text-muted-foreground">
        Base: {report.cost.basis}. A saída do Jev é grátis: só os tokens de entrada (rubricas maiores, exemplos, estado) mudam o custo de usar.
        {report.cost.paybackRequests !== null && ` A otimização se paga em ${report.cost.paybackRequests.toLocaleString('pt-BR')} requests.`}
        {report.cost.extraUsdPer1kPerPp !== null && ` Custo extra: ${fmtUsd(report.cost.extraUsdPer1kPerPp)} por 1k requests por p.p. de Brier ganho.`}
      </p>

      <SectionHead>Ciclos</SectionHead>
      <div className="scroll-slim overflow-x-auto rounded-xl bg-card ring-1 ring-foreground/10">
        <table className="w-full text-left text-[12.5px] tabular">
          <caption className="sr-only">Ciclos: decisão do gate e custo</caption>
          <thead className="text-[11px] text-muted-foreground">
            <tr className="border-b border-border">
              <th scope="col" className="px-3 py-2 font-medium">Ciclo</th>
              <th scope="col" className="px-2 py-2 font-medium">Decisão</th>
              <th scope="col" className="px-2 py-2 font-medium">Operadores</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Ganho</th>
              <th scope="col" className="px-2 py-2 text-right font-medium" title="Descontada a inflação do 'melhor de K' (winner's curse)">
                Corrigido
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">p ajustado</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Δ acurácia</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Custo</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Acumulado</th>
            </tr>
          </thead>
          <tbody>
            {report.cycles.map((c) => (
              <tr key={c.iteration} className="border-b border-border align-top last:border-b-0">
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  {c.iteration}
                </th>
                <td className="px-2 py-2">
                  {CYCLE_DECISION_LABEL[c.decision] ?? c.decision}
                  {c.heldBy.length > 0 && <span className="block text-[11px] text-muted-foreground">{c.heldBy.join('; ')}</span>}
                </td>
                <td className="px-2 py-2">{c.operators.join(', ') || '—'}</td>
                <td className="px-2 py-2 text-right">{fmtPp(c.bestGainPp, 2)}</td>
                <td className="px-2 py-2 text-right">{fmtPp(c.gainCorrectedPp, 2)}</td>
                <td className="px-2 py-2 text-right">{fmtP(c.pAdjusted)}</td>
                <td className="px-2 py-2 text-right">{fmtPp(c.accuracyDeltaPp, 1)}</td>
                <td className="px-2 py-2 text-right">{fmtUsd(c.costUsd)}</td>
                <td className="px-3 py-2 text-right">{fmtUsd(c.cumulativeCostUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionHead>Quanto custou otimizar</SectionHead>
      <p className="text-sm tabular">
        Total <strong>{fmtUsd(report.optimization.totalUsd)}</strong> — decisões {fmtUsd(report.optimization.byKind.decision)}, proponente{' '}
        {fmtUsd(report.optimization.byKind.rewriter)}
        {report.optimization.budgetUsd ? ` · ${fmtNum(report.optimization.budgetUsedPct, 0)}% do teto de ${fmtUsd(report.optimization.budgetUsd)}` : ''}
        {report.optimization.pendingUsd > 0 ? ` · + ${fmtUsd(report.optimization.pendingUsd)} pendente` : ''}.
      </p>

      <SectionHead>O que mudou na definição</SectionHead>
      <SpecDiff original={report.spec.original} champion={report.spec.champion} />

      {report.warnings.length > 0 && (
        <>
          <SectionHead>Avisos</SectionHead>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-muted-foreground">
            {report.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </>
      )}
    </Screen>
  );
}
