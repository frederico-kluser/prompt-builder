import { fmtNum, fmtP, fmtPct, fmtPp, fmtUsd, type JevComparison, type JevContestant, type JevMetrics } from '../../engine/jev';
import { Tag } from '../primitives';
import { LegendSwatch } from './ReliabilityDiagram';
import { contestantColor } from '../../jev/view';

/**
 * Tabela de competidores: acurácia, macro-F1, calibração (Brier em p.p. e
 * ECE top-label), bandas (cobertura/precisão na auto e "errado com
 * confiança"), latência p50/p95 e custo MEDIDO por 1k decisões (asterisco =
 * chamada sem custo medido ou pendente: o total é limite inferior).
 */

const ms = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${Math.round(v)}`);

export function MetricsTable({
  contestants,
  metrics,
  rejected,
  calibrated,
}: {
  contestants: JevContestant[];
  metrics: Record<string, JevMetrics | undefined>;
  rejected?: Record<string, unknown>;
  /** Mostra a coluna do resultado com a política ajustada. */
  calibrated?: boolean;
}) {
  return (
    <div className="scroll-slim overflow-x-auto rounded-xl bg-card ring-1 ring-foreground/10">
      <table className="w-full text-left text-[12.5px] tabular">
        <caption className="sr-only">Métricas por competidor</caption>
        <thead className="text-[11px] text-muted-foreground">
          <tr className="border-b border-border">
            <th scope="col" className="px-3 py-2 font-medium">Competidor</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">Acurácia</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">Macro-F1</th>
            <th scope="col" className="px-2 py-2 text-right font-medium" title="100·(1 − Brier normalizado): maior é melhor">
              Brier (p.p.)
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium" title="Erro de calibração top-label (10 faixas): menor é melhor">
              ECE
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium">Cobertura auto</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">Precisão auto</th>
            <th scope="col" className="px-2 py-2 text-right font-medium" title="Erros dentro da banda auto — ninguém os revisa">
              Errados c/ confiança
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium">p50 / p95 (ms)</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">US$ / 1k decisões</th>
          </tr>
        </thead>
        <tbody>
          {contestants.map((c, i) => {
            const m = metrics[c.id];
            const cal = calibrated ? m?.calibrated : undefined;
            return (
              <tr key={c.id} className="border-b border-border last:border-b-0">
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  <span className="flex items-center gap-1.5">
                    {contestantColor(i) !== null && <LegendSwatch i={i} />}
                    <span className="font-medium">{c.label}</span>
                  </span>
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    {c.isControl && <Tag>controle</Tag>}
                    <Tag>{c.kind === 'llm' ? 'LLM · prob. verbalizada' : 'decisão'}</Tag>
                    {rejected?.[c.id] ? <Tag className="border-destructive/30 text-destructive">recusado (400)</Tag> : null}
                  </span>
                </th>
                {/* Nenhum caso pontuado (tudo sem nota): 0% seria uma nota inventada. */}
                {m && m.nScored > 0 ? (
                  <>
                    <td className="px-2 py-2 text-right">{fmtPct(m.accuracy)}</td>
                    <td className="px-2 py-2 text-right">{fmtPct(m.macroF1)}</td>
                    <td className="px-2 py-2 text-right">
                      {fmtNum(cal?.brierScore ?? m.brierScore, 1)}
                      {cal && <span className="block text-[10.5px] text-muted-foreground">cru {fmtNum(m.brierScore, 1)}</span>}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {fmtNum(cal?.ece ?? m.ece, 3)}
                      {cal && <span className="block text-[10.5px] text-muted-foreground">cru {fmtNum(m.ece, 3)}</span>}
                    </td>
                    <td className="px-2 py-2 text-right">{fmtPct(cal?.coverageAtAuto ?? m.coverageAtAuto)}</td>
                    <td className="px-2 py-2 text-right">{fmtPct(cal ? cal.precisionAtAuto : m.precisionAtAuto)}</td>
                    <td className="px-2 py-2 text-right">{m.wrongAuto}</td>
                    <td className="px-2 py-2 text-right">
                      {ms(m.latencyP50)} / {ms(m.latencyP95)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {fmtUsd(m.costPer1kDecisions)}
                      {!m.costExact && (
                        <span className="text-muted-foreground" title="Há chamada sem custo medido ou pendente: o total é limite inferior até conciliar.">
                          {' '}
                          *
                        </span>
                      )}
                    </td>
                  </>
                ) : (
                  <td colSpan={9} className="px-2 py-2 text-muted-foreground">
                    sem métricas (ainda rodando ou sem casos pontuados)
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Comparações pareadas contra o controle (mesmos casos). */
export function ComparisonsTable({ comparisons, contestants }: { comparisons: JevComparison[]; contestants: JevContestant[] }) {
  if (!comparisons.length) return null;
  const nome = (id: string) => contestants.find((c) => c.id === id)?.label ?? id;
  return (
    <div className="scroll-slim overflow-x-auto rounded-xl bg-card ring-1 ring-foreground/10">
      <table className="w-full text-left text-[12.5px] tabular">
        <caption className="sr-only">Comparação pareada contra o controle</caption>
        <thead className="text-[11px] text-muted-foreground">
          <tr className="border-b border-border">
            <th scope="col" className="px-3 py-2 font-medium">Competidor vs controle</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">Δ primária</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">IC 95%</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">p (pareado)</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">Δ acurácia</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">McNemar p</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">melhor / pior</th>
          </tr>
        </thead>
        <tbody>
          {comparisons.map((c) => (
            <tr key={c.contestantId} className="border-b border-border last:border-b-0">
              <th scope="row" className="px-3 py-2 text-left font-normal">
                <span className="font-medium">{nome(c.contestantId)}</span>
                <span className="block text-[11px] text-muted-foreground">
                  vs {nome(c.controlId)} · métrica {c.metric === 'accuracy' ? 'acurácia' : 'Brier'} · {c.nEfetivo} pares
                </span>
              </th>
              <td className="px-2 py-2 text-right">{fmtPp(c.meanDiffPp)}</td>
              <td className="px-2 py-2 text-right">{c.ci95Pp ? `${fmtPp(c.ci95Pp[0])} … ${fmtPp(c.ci95Pp[1])}` : '—'}</td>
              <td className="px-2 py-2 text-right">{fmtP(c.pValue)}</td>
              <td className="px-2 py-2 text-right">{fmtPp(c.accuracyDiffPp)}</td>
              <td className="px-2 py-2 text-right">{fmtP(c.mcnemarP)}</td>
              <td className="px-3 py-2 text-right">
                {c.discordant.better} / {c.discordant.worse}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border px-3 py-2 text-[11.5px] text-muted-foreground">
        Pareado por caso (mesmos casos dos dois lados). p bilateral; McNemar exato nos casos em que só um acertou. Sem significância, "diferente" não está
        demonstrado.
      </p>
    </div>
  );
}
