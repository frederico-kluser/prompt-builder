// Utilitarios de visualizacao de run compartilhados entre RunView (por run) e
// TrainingView (cockpit de treino). A UNICA visualizacao de progresso/resultado
// e o heatmap (cenario x variante); o bloco de finais so aparece no fim.
import { useMemo } from 'react';
import type { KeyboardEvent } from 'react';
import type { RunRecord, StageRecord, Verdict } from '../api';
import { normalizeContestants } from '../api';
import { useTheme } from '../theme';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionPanel,
} from '@/components/motion-ui/accordion';
import { ProgressBar } from '@/components/motion-ui/progress-bar';
import { Tag } from '../components/primitives';
import { cn } from '@/lib/utils';

// Veredito ternario -> rotulo + classes do token semantico correspondente.
export const VERDICT_META: Record<Verdict, { label: string; cell: string; pill: string }> = {
  resolve: {
    label: 'resolve',
    cell: 'bg-resolve-soft text-resolve',
    pill: 'border-resolve/30 bg-resolve-soft/60 text-resolve',
  },
  parcial: {
    label: 'parcial',
    cell: 'bg-parcial-soft text-parcial',
    pill: 'border-parcial/30 bg-parcial-soft/60 text-parcial',
  },
  nao: {
    label: 'não resolve',
    cell: 'bg-nao-soft text-nao',
    pill: 'border-nao/30 bg-nao-soft/60 text-nao',
  },
};

/** Glifo de cada veredito no heatmap (pendente = ponto). */
const VERDICT_GLYPH: Record<Verdict, string> = {
  resolve: '✓',
  parcial: '◐',
  nao: '✕',
};

/** Veredito de um item, com retrocompat ao binario antigo (acceptable). */
export function verdictOf(v?: { verdict?: Verdict; acceptable?: boolean }): Verdict | undefined {
  if (!v) return undefined;
  if (v.verdict) return v.verdict;
  if (typeof v.acceptable === 'boolean') return v.acceptable ? 'resolve' : 'nao';
  return undefined;
}

export function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Etapas sem buracos (array pode ficar esparso/fora de ordem sob execucao
// paralela) e ordenadas por index. Toda a UI de resultados usa isto — sem o
// filtro, `stages.map(s => s.index)` quebra em buracos (foi o bug do heatmap).
export function denseStages(stages: StageRecord[]): StageRecord[] {
  return stages.filter((s): s is StageRecord => Boolean(s)).slice().sort((a, b) => a.index - b.index);
}

export interface RankColor {
  solid: string;
  soft: string;
  text: string;
}

// Verde (melhor) -> vermelho (pior), em HSL. `pos` é 1-based. Escala de DADO
// (posição no ranking), por isso é uma rampa contínua e não um token do tema.
export function rankColor(pos: number, total: number, dark: boolean): RankColor {
  const tl = dark ? 72 : 34;
  const sa = dark ? 0.22 : 0.15;
  if (total <= 1 || pos < 1) {
    return { solid: 'hsl(145 60% 42%)', soft: `hsl(145 70% 50% / ${sa})`, text: `hsl(145 55% ${tl}%)` };
  }
  const frac = (pos - 1) / (total - 1);
  const hue = Math.round(145 - (145 - 6) * frac);
  return { solid: `hsl(${hue} 62% 44%)`, soft: `hsl(${hue} 75% 50% / ${sa})`, text: `hsl(${hue} 58% ${tl}%)` };
}

// ---------------------------------------------------------------------------
// Heatmap de vereditos: cenario x variante. E a unica visualizacao durante a
// execucao — nada de numero que sobe e desce, so glifos que se preenchem.
// ---------------------------------------------------------------------------

/** Uma linha do heatmap: uma variante/modelo e como ela foi em cada cenário. */
export interface HeatRow {
  contestantId: string;
  label: string;
  isControl: boolean;
  isFinalist: boolean;
  /** Veredito por índice de cenário (denso, alinhado com `stages`). */
  verdicts: (Verdict | undefined)[];
  resolve: number;
  parcial: number;
  nao: number;
  judged: number;
  /** (resolve + 0,5·parcial) / judged × 100. `null` enquanto nada foi julgado. */
  score: number | null;
}

/** Veredito de um contestant numa etapa (gabarito > juiz > avaliador antigo). */
function verdictInStage(stage: StageRecord, contestantId: string): Verdict | undefined {
  const ref = stage.referenceJudge?.verdictByContestant?.[contestantId];
  if (ref) return ref;
  const doJuiz = verdictOf({
    verdict: stage.judge?.verdictByContestant?.[contestantId],
    acceptable: stage.judge?.acceptableByContestant?.[contestantId],
  });
  if (doJuiz) return doJuiz;
  // Retrocompat: records antigos guardavam o binario no avaliador separado.
  return verdictOf(stage.evaluation?.verdicts.find((v) => v.contestantId === contestantId));
}

/** Deriva as linhas do heatmap. Ordem = ordem de `record.contestants` (ESTÁVEL). */
export function heatRows(record: RunRecord): { rows: HeatRow[]; stages: StageRecord[] } {
  const stages = denseStages(record.stages);
  const contestants = normalizeContestants(record);
  const finalistas = new Set(record.finalists ?? []);
  // Controle = ancora da run: o prompt original ou o 'carry' do treino. Sem
  // fallback para o 1o contestant — em compare ninguem e "base".
  const controlId = contestants.find((c) => c.isOriginal || c.id === 'carry')?.id;
  const rows = contestants.map((c) => {
    const verdicts = stages.map((s) => verdictInStage(s, c.id));
    let resolve = 0;
    let parcial = 0;
    let nao = 0;
    for (const v of verdicts) {
      if (v === 'resolve') resolve++;
      else if (v === 'parcial') parcial++;
      else if (v === 'nao') nao++;
    }
    const judged = resolve + parcial + nao;
    return {
      contestantId: c.id,
      label: c.label,
      isControl: c.id === controlId,
      isFinalist: finalistas.has(c.id),
      verdicts,
      resolve,
      parcial,
      nao,
      judged,
      score: judged ? ((resolve + 0.5 * parcial) / judged) * 100 : null,
    };
  });
  return { rows, stages };
}

interface ScoreHeatmapProps {
  record: RunRecord;
  /** Ordena por score desc (só use quando a run terminou). Default false. */
  ranked?: boolean;
  /** Clique numa célula/coluna abre o cenário correspondente (recebe o index da etapa). */
  onStageClick?: (index: number) => void;
}

/**
 * A ÚNICA visualização de progresso/resultado: linhas = variantes (ordem
 * estável), colunas = cenários, célula = ✓ (resolve) / ◐ (parcial) / ✕ (não) /
 * · (pendente). Coluna final = score 0–100 + contagem `n✓ n◐ n✕`.
 *
 * Não sai do catálogo: o Motion UI tem `sparkline` como único gráfico, e uma
 * matriz cenário × variante não é nenhuma das 35 peças. Daí a grade explícita.
 */
export function ScoreHeatmap({ record, ranked = false, onStageClick }: ScoreHeatmapProps) {
  const { rows, stages } = useMemo(() => heatRows(record), [record]);
  // Interatividade opcional: célula/coluna só vira "botão" (foco, teclado)
  // quando há onStageClick — sem handler, continua um div inerte.
  const clickProps = (index: number) =>
    onStageClick
      ? {
          role: 'button' as const,
          tabIndex: 0,
          onClick: () => onStageClick(index),
          onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onStageClick(index);
            }
          },
        }
      : {};
  // Ordenacao so quando pedida (fim da run): sort e estavel, entao empate
  // preserva a ordem de `contestants`.
  const linhas = useMemo(
    () => (ranked ? [...rows].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)) : rows),
    [rows, ranked],
  );

  if (!linhas.length || !stages.length) {
    return (
      <div className="rounded-xl bg-card px-4 py-10 text-center text-sm text-muted-foreground ring-1 ring-foreground/10">
        Aguardando os primeiros resultados…
      </div>
    );
  }

  // Grade derivada do NÚMERO de cenários — é dado, não decoração de layout.
  const gridStyle = {
    gridTemplateColumns: `minmax(8rem, 1fr) repeat(${stages.length}, 1.75rem) 5rem`,
  };
  const cellBase =
    'grid h-7 place-items-center rounded-[5px] text-[13px] leading-none select-none';

  return (
    <div className="rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="border-b border-border px-4 py-2 text-[12px] text-muted-foreground">
        ✓ resolve · ◐ parcial · ✕ não resolve · ⏳ aguardando julgamento · ⊘ bloqueado · ✂ truncada · ! erro · · pendente
      </div>
      <div className="scroll-slim overflow-x-auto p-3">
        <div className="min-w-fit">
          <div className="grid items-center gap-1 pb-1.5" style={gridStyle}>
            <div />
            {stages.map((s, i) => {
              // IMPL-014: gabarito truncado mesmo após o retry x2 foi descartado —
              // o cenário é julgado SEM régua (listwise). Marca visível no cabeçalho.
              const semRegua = s.gabaritoCall?.truncated === true;
              const base = `Cenário ${i + 1}${semRegua ? ' — gabarito truncado no teto e descartado: julgado sem gabarito' : ''}`;
              return (
                <div
                  key={s.index}
                  title={onStageClick ? `${base} — clique para abrir` : base}
                  className={cn(
                    'grid h-6 place-items-center rounded-[5px] text-[11px] text-muted-foreground tabular',
                    semRegua && 'underline decoration-dotted underline-offset-2',
                    onStageClick && 'cursor-pointer hover:bg-muted focus-visible:bg-muted focus-visible:outline-none',
                  )}
                  {...clickProps(s.index)}
                >
                  {semRegua ? `${i + 1}✂` : i + 1}
                </div>
              );
            })}
            <div
              className="pr-1 text-right text-[11px] text-muted-foreground"
              title="(resolve + ½·parcial) ÷ julgados × 100"
            >
              score
            </div>
          </div>

          {linhas.map((row) => (
            <div key={row.contestantId} className="grid items-center gap-1 py-0.5" style={gridStyle}>
              <div className="flex min-w-0 items-center gap-1.5 pr-3" title={row.label}>
                <span className="truncate text-[13px]">{row.label}</span>
                {row.isControl && <Tag>base</Tag>}
                {row.isFinalist && (
                  <Tag className="border-primary/30 bg-primary/10 text-primary">final</Tag>
                )}
              </div>
              {stages.map((s, i) => {
                // Fan-out ao vivo (F3/§7.2): a célula mostra a FASE do par
                // (variante × cenário) — pendente → resposta recebida → julgada,
                // com erro à parte. É o que faz a run longa não parecer travada.
                const v = row.verdicts[i];
                const resp = (s.responses ?? []).find((r) => r.contestantId === row.contestantId);
                // Bloqueio (moderação/guardrail) vem ANTES do veredito: o cenário
                // é inconclusivo para o prompt, nunca um 'não' (IMPL-010).
                const estado = resp?.status === 'blocked'
                  ? { glyph: '⊘', cls: 'bg-muted text-muted-foreground', label: 'bloqueado pela moderação — sem veredito para o prompt' }
                  : resp?.truncated
                  ? // IMPL-014: cortada no teto mesmo após o retry x2 — a etapa inteira sai do placar.
                    { glyph: '✂', cls: 'bg-muted text-muted-foreground', label: 'resposta truncada no teto de tokens — etapa fora do placar' }
                  : s.incompleteReason === 'truncation' && !v
                  ? { glyph: '–', cls: 'bg-muted/50 text-muted-foreground', label: 'etapa fora do placar (outra resposta foi truncada)' }
                  : v
                  ? { glyph: VERDICT_GLYPH[v], cls: VERDICT_META[v].cell, label: VERDICT_META[v].label }
                  : resp?.status === 'error'
                    ? { glyph: '!', cls: 'bg-nao/20 text-nao', label: 'resposta com erro' }
                    : resp
                      ? {
                          glyph: '⏳',
                          cls: 'bg-muted text-muted-foreground',
                          label: 'resposta recebida — aguardando julgamento',
                        }
                      : { glyph: '·', cls: 'bg-muted/50 text-muted-foreground', label: 'pendente' };
                return (
                  <div
                    key={s.index}
                    title={`Cenário ${i + 1}: ${estado.label}${onStageClick ? ' — clique para abrir' : ''}`}
                    className={cn(
                      cellBase,
                      estado.cls,
                      onStageClick && 'cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    )}
                    {...clickProps(s.index)}
                  >
                    {estado.glyph}
                  </div>
                );
              })}
              <div className="pr-1 text-right leading-tight">
                <span className="text-[13px] font-medium tabular">
                  {row.score === null ? '—' : row.score.toFixed(0)}
                </span>
                <span className="block text-[10px] text-muted-foreground tabular">
                  {row.resolve}✓ {row.parcial}◐ {row.nao}✕
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Finais: os N melhores por judge-score duelam entre si em todos os cenarios.
// Podio (Copeland) + confrontos agregados por par.
// ---------------------------------------------------------------------------

/** Linha do pódio: stats de duelo quando ja houve duelo, senao o judge-score. */
interface FinalsRow {
  id: string;
  label: string;
  points?: number;
  wins?: number;
  ties?: number;
  losses?: number;
  score?: number;
}

/** Confronto agregado de um par de finalistas em TODOS os cenários. */
interface PairSummary {
  key: string;
  labelA: string;
  labelB: string;
  winsA: number;
  winsB: number;
  total: number;
}

interface FinalsPanelProps {
  record: RunRecord;
  /** Progresso agregado dos duelos (evento `duel.progress`). */
  progress?: { done: number; total: number } | null;
}

/**
 * Bloco "Final": os N finalistas (top judge-score) e o resultado dos duelos
 * entre eles — pódio com pontos Copeland e V–E–D, e um accordion enxuto com os
 * confrontos.
 */
export function FinalsPanel({ record, progress }: FinalsPanelProps) {
  const { resolved } = useTheme();
  const dark = resolved === 'dark';
  const stagesComDuelos = useMemo(
    () => denseStages(record.stages).filter((s) => s.duels),
    [record],
  );
  const finalistIds = useMemo(() => record.finalists ?? [], [record]);

  const rows = useMemo<FinalsRow[]>(() => {
    const labelOf = (id: string) => record.contestants?.find((c) => c.id === id)?.label ?? id;
    const finalistas = new Set(finalistIds);
    const standings = (record.standings ?? []).filter((s) => !finalistas.size || finalistas.has(s.id));
    if (standings.length) {
      return standings.map((s) => ({
        id: s.id,
        label: s.label,
        points: s.points,
        wins: s.wins,
        ties: s.ties,
        losses: s.losses,
      }));
    }
    // Ainda sem Copeland (duelos rodando): pódio provisório por judge-score.
    return finalistIds.map((id) => ({
      id,
      label: labelOf(id),
      score: record.judgeScoreByContestant?.[id] ?? 0,
    }));
  }, [record, finalistIds]);

  const pares = useMemo<PairSummary[]>(() => {
    const labelOf = (id: string) => record.contestants?.find((c) => c.id === id)?.label ?? id;
    const acc = new Map<string, PairSummary>();
    for (const s of stagesComDuelos) {
      for (const d of s.duels!.duels) {
        // Chave por par NAO-ordenado: agrega os dois sentidos num confronto so.
        const [a, b] = d.a < d.b ? [d.a, d.b] : [d.b, d.a];
        const key = `${a}|${b}`;
        let p = acc.get(key);
        if (!p) {
          p = { key, labelA: labelOf(a), labelB: labelOf(b), winsA: 0, winsB: 0, total: 0 };
          acc.set(key, p);
        }
        p.total++;
        const vencedor = d.outcome === 'a' ? d.a : d.outcome === 'b' ? d.b : undefined;
        if (vencedor === a) p.winsA++;
        else if (vencedor === b) p.winsB++;
      }
    }
    return [...acc.values()];
  }, [record, stagesComDuelos]);

  if (!finalistIds.length && !stagesComDuelos.length) return null;

  const running = progress && progress.done < progress.total;

  return (
    <div className="rounded-xl bg-card ring-1 ring-foreground/10">
      {running && (
        <div className="border-b border-border px-4 py-3">
          <ProgressBar
            value={progress.done / Math.max(1, progress.total)}
            size="sm"
            progressbar
            label="Duelos"
            valueLabel={`${progress.done}/${progress.total}`}
            aria-label="Progresso dos duelos"
          />
        </div>
      )}

      <ol className="p-2">
        {rows.map((r, i) => (
          <li key={r.id} className="flex items-center gap-3 rounded-lg px-2 py-2">
            <span
              className="grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white"
              style={{ background: rankColor(i + 1, rows.length, dark).solid }}
            >
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm" title={r.label}>
              {r.label}
            </span>
            {typeof r.points === 'number' ? (
              <>
                <span className="shrink-0 text-[13px] font-medium tabular">{r.points} pts</span>
                <span className="w-16 shrink-0 text-right text-[12px] text-muted-foreground tabular">
                  {r.wins}–{r.ties}–{r.losses}
                </span>
              </>
            ) : (
              <span className="shrink-0 text-[13px] tabular" title="judge-score">
                {(r.score ?? 0).toFixed(0)}
              </span>
            )}
          </li>
        ))}
      </ol>

      {pares.length > 0 && (
        <Accordion className="border-t border-border">
          <AccordionItem value="confrontos">
            <AccordionTrigger className="px-4 py-3 text-[13px]" headingLevel={3}>
              Confrontos
            </AccordionTrigger>
            <AccordionPanel className="px-4 pb-4 text-[13px] text-muted-foreground">
              <ul className="space-y-1">
                {pares.map((p) => (
                  <li key={p.key}>
                    {p.labelA} × {p.labelB} —{' '}
                    {p.winsA === p.winsB
                      ? `empate (${p.winsA}–${p.winsB} de ${p.total})`
                      : `venceu ${p.winsA > p.winsB ? p.labelA : p.labelB} (${Math.max(p.winsA, p.winsB)} de ${p.total})`}
                  </li>
                ))}
              </ul>
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reducer client-side: dobra os eventos granulares (chegam FORA de ordem sob
// execucao paralela) sobre o RunRecord vivo. Usado por RunView e pela cockpit.
// ---------------------------------------------------------------------------

export function applyEvent(prev: RunRecord, event: any): RunRecord {
  const next: RunRecord = {
    ...prev,
    stages: prev.stages.map((s) => ({ ...s, responses: [...s.responses] })),
  };
  switch (event.type) {
    case 'run.started':
      return event.record;
    case 'variants.generated':
      return { ...next, contestants: event.contestants };
    case 'stage.generating': {
      // Coloca POR INDICE (nao push): sob execucao paralela os eventos chegam
      // fora de ordem; o push desalinhava o array (era o bug do heatmap/resumo).
      if (!next.stages[event.stageIndex]) {
        next.stages[event.stageIndex] = {
          index: event.stageIndex,
          responses: [],
          startedAt: new Date().toISOString(),
        };
      }
      return next;
    }
    case 'stage.generated': {
      const s = next.stages[event.stageIndex];
      if (s) {
        s.spec = event.spec;
        // IMPL-014: sinais do gabarito (inclusive "truncado e descartado").
        if (event.gabaritoCall) s.gabaritoCall = event.gabaritoCall;
      }
      return next;
    }
    case 'stage.incomplete': {
      // IMPL-014: etapa fora do placar e das médias (hoje: truncamento). Por
      // índice, como os demais — os eventos chegam fora de ordem.
      const s = next.stages[event.stageIndex];
      if (s) {
        s.incomplete = true;
        s.incompleteReason = event.reason;
        s.finishedAt = new Date().toISOString();
      }
      return next;
    }
    case 'stage.failed': {
      let s = next.stages[event.stageIndex];
      if (!s) {
        s = { index: event.stageIndex, responses: [], startedAt: new Date().toISOString() };
        next.stages[event.stageIndex] = s;
      }
      s.error = event.error;
      s.finishedAt = new Date().toISOString();
      return next;
    }
    case 'competitor.finished': {
      const s = next.stages[event.stageIndex];
      if (s) {
        const idx = s.responses.findIndex((r) => r.contestantId === event.response.contestantId);
        if (idx >= 0) s.responses[idx] = event.response;
        else s.responses.push(event.response);
        next.totalCostUsd = (next.totalCostUsd ?? 0) + event.response.costUsd;
      }
      return next;
    }
    case 'finals.started': {
      // Finalistas escolhidos (top-N por judge-score) — o heatmap marca "final".
      // Guarda TAMBEM os scores que vem no evento: `judgeScoreByContestant` so
      // chega no `run.finished`, entao sem isto o podio provisorio ficaria "0"
      // durante toda a fase de duelos (a mais longa da run).
      const finalists = event.finalists as { id: string; label: string; score: number }[];
      const scores = { ...(next.judgeScoreByContestant ?? {}) };
      for (const f of finalists) scores[f.id] = f.score;
      return { ...next, finalists: finalists.map((f) => f.id), judgeScoreByContestant: scores };
    }
    case 'stage.dueled': {
      // Duelos (Copeland) da etapa — rodam DEPOIS de todas as etapas, na fase
      // de finais. Por indice, como os demais handlers: sob execucao paralela
      // os eventos chegam fora de ordem e push desalinharia o array.
      const s = next.stages[event.stageIndex];
      if (s) s.duels = event.duels;
      return next;
    }
    case 'stage.gabarito':
    case 'duel.progress':
      // Progresso AGREGADO: `stage.gabarito` vem com stageIndex -1 (NUNCA
      // indexar `stages` com ele) e `duel.progress` nem stageIndex tem. O
      // record nao muda — as paginas guardam esse progresso em estado proprio.
      // Retorna `prev` (sem copia) p/ evitar re-render inutil.
      return prev;
    case 'stage.judged': {
      const s = next.stages[event.stageIndex];
      if (s) {
        s.judge = event.judge;
        s.finishedAt = new Date().toISOString();
      }
      next.scoreboard = event.scoreboard;
      next.totalCostUsd = event.totalCostUsd;
      return next;
    }
    case 'run.finished':
      return event.record;
    case 'run.error':
      return { ...next, status: 'error', error: event.error };
    default:
      return next;
  }
}
