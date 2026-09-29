import { useMemo } from 'react';
import { Check, CircleDashed, Equal, LoaderCircle, Trophy } from 'lucide-react';
import { ProgressBar } from '@/components/motion-ui/progress-bar';
import type { RunRecord } from '../api';
import { normalizeContestants, runMode } from '../api';
import { denseStages, heatRows, runWinner, tieMarks, type HeatRow, type RunWinnerView } from '../pages/runShared';
import { cn } from '@/lib/utils';

/**
 * NARRATIVA DA RUN — a representação de ALTO NÍVEL do processo (pedido do
 * dono: "representações de maior nível… até durante a execução").
 *
 * Vive acima do heatmap (que continua sendo o detalhe): diz, em linguagem
 * simples, em que FASE está o pipeline, quem vai à frente, quanto já custou e
 * — no fim — quem venceu e porquê. Números brutos (tokens, latências, vereditos
 * por célula) ficam nas seções de detalhe abaixo.
 *
 * O vencedor sai da MESMA régua do `runs winner`/MCP (`runWinner` →
 * `winnerFromStandings`): com finais, o duelo final decide; sem finais, o
 * judge-score — e empate é dito como empate, nunca coroado pela ordem de
 * cadastro (web-code#10 / web-live#4).
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

/**
 * Cenários que a run EXECUTA (web-code#11): os slots alocados em
 * `record.stages`, não `config.stages` — rodada de treino pinada roda só a
 * fatia de treino, `repeats` multiplica os slots e o seed pode passar do alvo.
 * `config.stages` só enquanto os slots ainda não chegaram.
 */
export function executedStageCount(record: Pick<RunRecord, 'stages' | 'config'>): number {
  return denseStages(record.stages ?? []).length || (record.config?.stages ?? 0);
}

/** As 4 fases do pipeline, com contagem — a espinha da narrativa. */
export function pipelinePhases(record: RunRecord, duelProgress: RunNarrativeProps['duelProgress']): Phase[] {
  const stages = denseStages(record.stages ?? []);
  const totalStages = executedStageCount(record);
  const contestants = normalizeContestants(record);
  // Etapa PULADA (falha no datagen) é terminal: não gera respostas nem
  // julgamento — contá-la no alvo deixava a fase aberta para sempre.
  const pulados = stages.filter((s) => s.error).length;
  const ativos = Math.max(0, totalStages - pulados);
  const gerados = stages.filter((s) => s.spec || s.error).length;
  const respostas = stages.reduce((n, s) => n + (s.error ? 0 : (s.responses?.length ?? 0)), 0);
  const esperadas = ativos * Math.max(contestants.length, 1);
  // Terminal no julgamento: julgada, ou cortada (`incomplete` — orçamento,
  // cancelamento, truncamento) — esta nunca vai ter veredito.
  const julgados = stages.filter((s) => !s.error && (s.judge || s.referenceJudge || s.incomplete)).length;
  const duelosTotal = duelProgress?.total ?? (record.standings?.length ? 1 : 0);
  const duelosFeitos = duelProgress?.done ?? (record.standings?.length ? 1 : 0);
  return [
    { label: 'Cenários', done: gerados, total: totalStages },
    { label: 'Respostas', done: Math.min(respostas, esperadas), total: esperadas },
    { label: 'Julgamento', done: julgados, total: ativos },
    { label: 'Duelo final', done: duelosFeitos, total: Math.max(duelosTotal, record.standings?.length ? 1 : 0) },
  ];
}

/** 1 frase sobre onde está (ou onde parou) o processo. */
export function statusLine(record: RunRecord, phases: Phase[]): string {
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

/** Desfecho em 1 frase + se houve vencedor claro. */
export interface Outcome {
  text: string;
  /** Id do vencedor (ausente = empate sem vencedor claro). */
  winnerId?: string;
}

/**
 * Quem venceu, pela régua única — com o empate NUNCA escondido e a régua dita.
 * `null` enquanto roda ou sem nenhuma nota.
 */
export function runOutcome(record: RunRecord, rows: HeatRow[], w: RunWinnerView = runWinner(record)): Outcome | null {
  if (record.status === 'running' || !w.contestantId) return null;
  const labelOf = (id: string): string =>
    rows.find((r) => r.contestantId === id)?.label ??
    normalizeContestants(record).find((c) => c.id === id)?.label ??
    id;
  const nomes = (ids: string[]): string =>
    ids.length <= 2 ? ids.map(labelOf).join(' e ') : `${ids.slice(0, -1).map(labelOf).join(', ')} e ${labelOf(ids[ids.length - 1])}`;
  const modo = runMode(record);
  const ehModelo = modo === 'compare';
  const comNota = rows.filter((r) => r.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  if (w.unresolved) {
    // Empate que resistiu a todos os desempates que medem algo: o "vencedor"
    // seria o sorteio cego — a tela não coroa ninguém.
    const nota = comNota.find((r) => w.tiedIds.includes(r.contestantId))?.score;
    if (w.ruler !== 'judge-score') {
      return {
        text: `Empate no duelo final entre ${nomes(w.tiedIds)} (mesma taxa de vitória e mesmo judge-score) — nenhum vencedor claro; rode mais cenários.`,
      };
    }
    if (w.tiedIds.length === comNota.length && comNota.length > 1) {
      return {
        text: `Nenhum${ehModelo ? ' modelo' : 'a variação'} se destacou: todos empataram com nota ${Math.round(nota ?? 0)}.`,
      };
    }
    return {
      text: `Empate entre ${nomes(w.tiedIds)} com nota ${Math.round(nota ?? 0)} — nenhum vencedor claro; rode mais cenários.`,
    };
  }

  const id = w.contestantId;
  const linha = rows.find((r) => r.contestantId === id);
  const liderNota = comNota[0];
  const segundo = comNota.find((r) => r.contestantId !== id);

  if (w.ruler === 'duels' || w.ruler === 'duels+judge-score') {
    const st = (record.standings ?? []).find((s) => s.id === id);
    const desempate =
      w.tieBreak === 'wins'
        ? ' (empate na taxa de vitória desfeito pelo nº de vitórias)'
        : w.tieBreak === 'judge-score'
          ? ' (empate nos duelos desfeito pelo judge-score)'
          : '';
    const placar = st ? ` com taxa de vitória de ${Math.round(st.winRate * 100)}% (${st.wins}V–${st.ties}E–${st.losses}D)` : '';
    let text = `${ehModelo ? 'O melhor modelo foi' : 'A melhor variação foi'} ${labelOf(id)}: venceu o duelo final${placar}${desempate}.`;
    // As réguas podem discordar (pointwise × pareado): dito, não escondido.
    const liderUnico = liderNota && comNota.filter((r) => r.score === liderNota.score).length === 1;
    if (liderUnico && liderNota.contestantId !== id) {
      text += ` No placar de vereditos quem vai à frente é ${liderNota.label} — as réguas discordam, o que é esperado com poucos cenários.`;
    } else if (linha && linha.judged) {
      text += ` No placar de vereditos resolveu ${linha.resolve} de ${linha.judged} cenários.`;
    }
    return { text, winnerId: id };
  }

  // Régua: judge-score (sem finais, ou rodada de treino).
  const nota = linha?.score ?? record.judgeScoreByContestant?.[id] ?? 0;
  const margem =
    segundo && segundo.score !== null ? ` (margem de ${Math.round(nota - segundo.score)} pontos sobre ${segundo.label})` : '';
  const resolveu = linha && linha.judged ? `resolveu ${linha.resolve} de ${linha.judged} cenários, nota ${Math.round(nota)}` : `nota ${Math.round(nota)}`;
  if (w.training) {
    return {
      text: `À frente no placar desta rodada: ${labelOf(id)} — ${resolveu}${margem}. Quem vira campeão é o gate da sessão (margem mínima + teste).`,
      winnerId: id,
    };
  }
  return {
    text: `${ehModelo ? 'O melhor modelo foi' : 'A melhor variação foi'} ${labelOf(id)}: ${resolveu}${margem}.`,
    winnerId: id,
  };
}

/** Placar em linguagem simples, melhor primeiro (placar de VEREDITOS). */
function Leaderboard({
  rows,
  record,
  winnerId,
}: {
  rows: HeatRow[];
  record: RunRecord;
  winnerId?: string;
}) {
  const comNota = rows.filter((r) => r.score !== null);
  if (!comNota.length) {
    return (
      <p className="text-sm leading-relaxed text-muted-foreground">
        Ainda sem vereditos — o placar aparece assim que o juiz avaliar a primeira resposta.
      </p>
    );
  }
  // Ordem = judge-score (é o placar de VEREDITOS). Quem VENCEU é outra
  // pergunta — com finais, decide o duelo final (`winnerId`); o troféu só vai
  // para ele, e empate na nota vira texto ("empatado com X"), nunca 1º lugar
  // dado pela ordem de cadastro (o controle vem 1º no array).
  const ordenado = [...comNota].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const total = ordenado[0]?.judged ?? 0;
  const modo = runMode(record);
  const running = record.status === 'running';
  const empates = tieMarks(
    ordenado.map((r) => r.contestantId),
    (id) => ordenado.find((r) => r.contestantId === id)?.score ?? undefined,
    (id) => ordenado.find((r) => r.contestantId === id)?.label ?? id,
  );
  // Posição por competição: empatados dividem o número.
  const posicao = (r: HeatRow): number => 1 + ordenado.filter((o) => (o.score ?? 0) > (r.score ?? 0)).length;
  const lider = ordenado[0];
  const liderUnico = lider && !empates.has(lider.contestantId);
  return (
    <ul className="flex flex-col gap-2.5">
      {ordenado.map((r) => {
        const vence = !running && r.contestantId === winnerId;
        const aFrente = running && liderUnico && r.contestantId === lider.contestantId;
        const empate = empates.get(r.contestantId);
        return (
          <li key={r.contestantId} className="flex items-center gap-3">
            <span
              className={cn(
                'grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-medium tabular',
                vence || aFrente ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
              )}
              aria-hidden="true"
            >
              {posicao(r)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="truncate text-sm font-medium">{r.label}</span>
                {r.isControl && <span className="text-[11px] text-muted-foreground">controle</span>}
                {vence && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-primary">
                    <Trophy className="size-3" aria-hidden="true" />
                    {modo === 'compare' ? 'vencedor' : 'melhor prompt'}
                  </span>
                )}
                {aFrente && <span className="text-[11px] text-primary">à frente</span>}
                {empate && <span className="text-[11px] text-muted-foreground">{empate.summary}</span>}
              </span>
              <span className="mt-0.5 block text-[12px] text-muted-foreground">
                resolveu {r.resolve} de {r.judged || total}
                {r.parcial ? ` · ${r.parcial} parcial` : ''}
                {r.nao ? ` · ${r.nao} não resolveu` : ''}
                {' · nota '}
                {Math.round(r.score ?? 0)}
              </span>
            </span>
            {/* web-live#3: a largura vai num WRAPPER — o ProgressBar monta
                `w-full` na raiz e, com `w-24` no mesmo nó, o w-full vencia e a
                coluna do nome colapsava a 0 px. */}
            <div className="w-24 shrink-0">
              <ProgressBar size="sm" value={(r.score ?? 0) / 100} aria-label={`Nota de ${r.label}`} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function RunNarrative({ record, duelProgress }: RunNarrativeProps) {
  const { rows, stages } = useMemo(() => heatRows(record), [record]);
  const phases = useMemo(() => pipelinePhases(record, duelProgress), [record, duelProgress]);
  const running = record.status === 'running';
  const julgados = stages.filter((s) => s.judge || s.referenceJudge).length;

  // Desfecho final, em 1 frase: quem venceu, por qual régua (só com veredito real).
  const outcome = useMemo(() => runOutcome(record, rows), [record, rows]);
  const temFinais = Boolean(record.standings?.length) && !record.sessionId;

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
                <span className={cn('text-[13px] font-medium', atual && running && 'text-primary')}>{p.label}</span>
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

      {outcome && (
        <p className="mt-4 border-t border-border pt-3 text-sm leading-relaxed">
          {outcome.winnerId ? (
            <Trophy className="mr-1.5 inline size-4 text-primary" aria-hidden="true" />
          ) : (
            <Equal className="mr-1.5 inline size-4 text-muted-foreground" aria-hidden="true" />
          )}
          {outcome.text}
        </p>
      )}

      <div className="mt-4 border-t border-border pt-4">
        <h3 className="text-[12px] tracking-wide text-muted-foreground uppercase">
          {temFinais ? 'Placar de vereditos' : 'Placar'}
        </h3>
        {temFinais && (
          <p className="mt-1 text-[12px] text-muted-foreground">
            Ordem pelo judge-score; quem vence é decidido no duelo final (abaixo).
          </p>
        )}
        <div className="mt-2.5">
          <Leaderboard rows={rows} record={record} winnerId={outcome?.winnerId} />
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
