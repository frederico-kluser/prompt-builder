import { useMemo } from 'react';
import { Check, CircleDashed, LoaderCircle, Trophy } from 'lucide-react';
import { ProgressBar } from '@/components/motion-ui/progress-bar';
import type { RunRecord } from '../api';
import { normalizeContestants, runMode } from '../api';
import { heatRows, type HeatRow } from '../pages/runShared';
import { cn } from '@/lib/utils';

/**
 * NARRATIVA DA RUN — a representação de ALTO NÍVEL do processo (pedido do
 * dono: "representações de maior nível… até durante a execução").
 *
 * Vive acima do heatmap (que continua sendo o detalhe): diz, em linguagem
 * simples, em que FASE está o pipeline, quem vai à frente, quanto já custou e
 * — no fim — quem venceu e porquê. Números brutos (tokens, latências, vereditos
 * por célula) ficam nas seções de detalhe abaixo.
 */

export interface RunNarrativeProps {
  record: RunRecord;
  /** Progresso agregado dos duelos finais (evento `duel.progress`). */
  duelProgress: { done: number; total: number } | null;
}

interface Phase {
  label: string;
  done: number;
  total: number;
}

function usd(v: number): string {
  if (!v) return 'US$ 0';
  return `US$ ${v.toFixed(v < 1 ? 4 : 2)}`;
}

/** As 4 fases do pipeline, com contagem — a espinha da narrativa. */
function pipelinePhases(record: RunRecord, duelProgress: RunNarrativeProps['duelProgress']): Phase[] {
  const stages = record.stages ?? [];
  const totalStages = Math.max(record.config?.stages ?? 0, stages.length);
  const contestants = normalizeContestants(record);
  const gerados = stages.filter((s) => s.spec).length;
  const respostas = stages.reduce((n, s) => n + (s.responses?.length ?? 0), 0);
  const esperadas = totalStages * Math.max(contestants.length, 1);
  const julgados = stages.filter((s) => s.judge || s.referenceJudge).length;
  const duelosTotal = duelProgress?.total ?? (record.standings?.length ? 1 : record.finalists?.length ? 0 : 0);
  const duelosFeitos = duelProgress?.done ?? (record.standings?.length ? 1 : 0);
  return [
    { label: 'Cenários', done: gerados, total: totalStages },
    { label: 'Respostas', done: respostas, total: esperadas },
    { label: 'Julgamento', done: julgados, total: totalStages },
    { label: 'Duelo final', done: duelosFeitos, total: Math.max(duelosTotal, record.standings?.length ? 1 : 0) },
  ];
}

/** 1 frase sobre onde está (ou onde parou) o processo. */
function statusLine(record: RunRecord, phases: Phase[]): string {
  if (record.status === 'running') {
    const atual = phases.find((p) => p.total > 0 && p.done < p.total);
    if (!atual) return 'A concluir…';
    if (atual.label === 'Cenários') return `A gerar cenários (${atual.done} de ${atual.total})…`;
    if (atual.label === 'Respostas') return `A receber respostas (${atual.done} de ${atual.total})…`;
    if (atual.label === 'Julgamento') return `A julgar respostas (${atual.done} de ${atual.total} cenários)…`;
    return `No duelo final (${atual.done} de ${atual.total} duelos)…`;
  }
  if (record.status === 'aborted') return 'A run parou antes do fim — o placar vale para o que foi concluído.';
  if (record.status === 'error') return 'A run falhou antes de produzir resultado.';
  if (record.status === 'inconclusive') return 'A run terminou, mas o resultado não sustenta conclusão.';
  return 'Run concluída.';
}

/** Placar em linguagem simples, melhor primeiro. */
function Leaderboard({ rows, record }: { rows: HeatRow[]; record: RunRecord }) {
  const comNota = rows.filter((r) => r.score !== null);
  if (!comNota.length) {
    return (
      <p className="text-sm leading-relaxed text-muted-foreground">
        Ainda sem vereditos — o placar aparece assim que o juiz avaliar a primeira resposta.
      </p>
    );
  }
  // Sem duelo final, o placar de vereditos é quem decide; com standings, os
  // duelos confirmam (eles vêm ordenados por taxa de vitória).
  const ordenado = [...comNota].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const total = ordenado[0]?.judged ?? 0;
  const modo = runMode(record);
  return (
    <ul className="flex flex-col gap-2.5">
      {ordenado.map((r, i) => (
        <li key={r.contestantId} className="flex items-center gap-3">
          <span
            className={cn(
              'grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-medium tabular',
              i === 0 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
            )}
            aria-hidden="true"
          >
            {i + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="truncate text-sm font-medium">{r.label}</span>
              {r.isControl && <span className="text-[11px] text-muted-foreground">controlo</span>}
              {i === 0 && (
                <span className="inline-flex items-center gap-1 text-[11px] text-primary">
                  <Trophy className="size-3" aria-hidden="true" />
                  {modo === 'compare' ? 'à frente' : 'melhor prompt'}
                </span>
              )}
            </span>
            <span className="mt-0.5 block text-[12px] text-muted-foreground">
              resolveu {r.resolve} de {r.judged || total}
              {r.parcial ? ` · ${r.parcial} parcial` : ''}
              {r.nao ? ` · ${r.nao} não resolveu` : ''}
              {' · nota '}
              {Math.round(r.score ?? 0)}
            </span>
          </span>
          <ProgressBar
            className="w-24 shrink-0"
            size="sm"
            value={(r.score ?? 0) / 100}
            aria-label={`Nota de ${r.label}`}
          />
        </li>
      ))}
    </ul>
  );
}

export function RunNarrative({ record, duelProgress }: RunNarrativeProps) {
  const { rows, stages } = useMemo(() => heatRows(record), [record]);
  const phases = useMemo(() => pipelinePhases(record, duelProgress), [record, duelProgress]);
  const running = record.status === 'running';
  const julgados = stages.filter((s) => s.judge || s.referenceJudge).length;

  // Desfecho final, em 1 frase: quem venceu e por quanto (só com veredito real).
  const vencedor = useMemo(() => {
    if (running) return null;
    const ordenado = rows.filter((r) => r.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const top = ordenado[0];
    if (!top) return null;
    const segundo = ordenado[1];
    const modo = runMode(record);
    const verbo = modo === 'compare' ? 'O melhor modelo foi' : 'A melhor variação foi';
    const margem =
      segundo && top.score !== null && segundo.score !== null
        ? ` (margem de ${Math.round(top.score - segundo.score)} pontos sobre ${segundo.label})`
        : '';
    return `${verbo} ${top.label}: resolveu ${top.resolve} de ${top.judged} cenários${margem}.`;
  }, [rows, record, running]);

  const outcomes = record.competitorOutcomeCounts;
  const desfechos = outcomes
    ? [outcomes.blocked ? `${outcomes.blocked} bloqueada(s) pela moderação` : null,
       outcomes.refused ? `${outcomes.refused} recusa(s) do modelo` : null,
       outcomes.error ? `${outcomes.error} erro(s)` : null].filter(Boolean).join(' · ')
    : '';

  return (
    <section aria-label="Resumo da run" className="rounded-xl bg-card p-5 ring-1 ring-foreground/10">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-heading text-base font-medium">
          {running ? 'O que está acontecendo' : 'O que aconteceu'}
        </h2>
        {running ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
            em curso
          </span>
        ) : (
          julgados > 0 && (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Check className="size-3.5 text-resolve" aria-hidden="true" />
              {julgados} cenário{julgados > 1 ? 's' : ''} julgado{julgados > 1 ? 's' : ''}
            </span>
          )
        )}
      </div>

      <p className="mt-1.5 flex items-center gap-2 text-sm leading-relaxed text-muted-foreground">
        {running && <CircleDashed className="size-4 shrink-0" aria-hidden="true" />}
        {statusLine(record, phases)}
      </p>

      {/* As 4 fases, com contagem — onde está o processo, sem jargão. */}
      <ol className="mt-4 grid gap-3 sm:grid-cols-4">
        {phases.map((p, i) => {
          const completo = p.total > 0 && p.done >= p.total;
          const atual = phases.findIndex((x) => x.total > 0 && x.done < x.total) === i;
          return (
            <li key={p.label} className="flex flex-col gap-1.5">
              <span className="flex items-baseline gap-1.5">
                <span className="font-mono text-[11px] text-muted-foreground tabular">{i + 1}</span>
                <span className={cn('text-[13px] font-medium', atual && 'text-primary')}>{p.label}</span>
                {completo && <Check className="size-3.5 text-resolve" aria-hidden="true" />}
              </span>
              <ProgressBar
                size="sm"
                progressbar
                value={p.total ? Math.min(1, p.done / p.total) : 0}
                aria-label={`${p.label}: ${p.done} de ${p.total}`}
              />
              <span className="text-[11px] text-muted-foreground tabular">
                {p.total ? `${p.done} / ${p.total}` : '—'}
              </span>
            </li>
          );
        })}
      </ol>

      {vencedor && (
        <p className="mt-4 border-t border-border pt-3 text-sm leading-relaxed">
          <Trophy className="mr-1.5 inline size-4 text-primary" aria-hidden="true" />
          {vencedor}
        </p>
      )}

      <div className="mt-4 border-t border-border pt-4">
        <h3 className="text-[12px] tracking-wide text-muted-foreground uppercase">Placar</h3>
        <div className="mt-2.5">
          <Leaderboard rows={rows} record={record} />
        </div>
      </div>

      <p className="mt-4 border-t border-border pt-3 text-[12px] leading-relaxed text-muted-foreground">
        Gasto até agora: <span className="tabular">{usd(record.totalCostUsd)}</span>
        {record.budgetUsd !== undefined && (
          <>
            {' '}
            de teto <span className="tabular">{usd(record.budgetUsd)}</span>
            {record.budgetExhausted ? ' — o teto foi atingido e a run parou aí.' : ''}
          </>
        )}
        {desfechos && <> · {desfechos}</>}
      </p>
    </section>
  );
}