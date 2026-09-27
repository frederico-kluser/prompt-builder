import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Download } from 'lucide-react';
import type { Contestant, RunRecord, StageRecord, StageSpec, Verdict } from '../api';
import {
  buildScenarioPack,
  cacheRun,
  downloadScenarioPack,
  fetchRun,
  normalizeContestants,
  openRunStream,
  runMode,
} from '../api';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionPanel,
} from '@/components/motion-ui/accordion';
import { ProgressBar } from '@/components/motion-ui/progress-bar';
import { Skeleton } from '@/components/motion-ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  Banner,
  EmptyState,
  MiniLabel,
  Pre,
  Screen,
  SectionHead,
  StatusPill,
  Tag,
} from '../components/primitives';
import { VERDICT_META, verdictOf, trunc, denseStages, applyEvent, ScoreHeatmap, FinalsPanel } from './runShared';
import { FailureDigest, DeltaBars, VariantPromptDrawer, JudgeDiagnostics } from '../components/RunInsights';
import { TruncationNotice } from '../components/TruncationNotice';
import { cn } from '@/lib/utils';

// Notacao decimal sempre: "$4.00e-4" e ilegivel para quem so quer saber quanto
// custou. Abaixo de 1 centesimo de centavo, um teto basta.
function formatUsd(v: number): string {
  if (!v) return '$0';
  if (v < 0.0001) return '<$0.0001';
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// Ordem de exibicao das respostas dentro do cenario: melhor veredito primeiro.
const VERDICT_ORDER: Record<Verdict, number> = { resolve: 0, parcial: 1, nao: 2 };

// Veredito de um competidor na etapa: pointwise vs gabarito quando existe,
// senao o consenso do juiz (com retrocompat ao binario `acceptable`).
function stageVerdict(stage: StageRecord, contestantId: string): Verdict | undefined {
  const ref = stage.referenceJudge?.verdictByContestant?.[contestantId];
  if (ref) return ref;
  return verdictOf({
    verdict: stage.judge?.verdictByContestant?.[contestantId],
    acceptable: stage.judge?.acceptableByContestant?.[contestantId],
  });
}

// Export client-side (sem backend): gera o blob e dispara o download.
function download(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvEscape(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV plano: uma linha por resposta (cenario × competidor), com o veredito.
function runToCsv(record: RunRecord, byId: Map<string, Contestant>): string {
  const rows: string[] = [];
  rows.push(
    ['runId', 'sessionId', 'iteration', 'stageIndex', 'question', 'contestantId', 'label', 'technique', 'modelId', 'status', 'latencyMs', 'tokensIn', 'tokensOut', 'costUsd', 'verdict', 'errorMsg', 'text']
      .map(csvEscape)
      .join(','),
  );
  for (const stage of record.stages) {
    if (!stage) continue;
    for (const r of stage.responses) {
      const c = byId.get(r.contestantId);
      rows.push(
        [record.id, record.sessionId ?? '', record.iteration ?? '', stage.index, stage.spec?.question ?? '', r.contestantId, c?.label ?? '', c?.techniqueId ?? '', r.modelId, r.status, r.latencyMs, r.tokensIn, r.tokensOut, r.costUsd, stageVerdict(stage, r.contestantId) ?? '', r.errorMsg ?? '', r.text]
          .map(csvEscape)
          .join(','),
      );
    }
  }
  return rows.join('\n');
}

/** Número grande + rótulo pequeno, no cabeçalho da run. */
function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-[5rem]">
      <div className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className="mt-0.5 font-heading text-lg font-medium tabular">{children}</div>
    </div>
  );
}

export function RunView() {
  const { id } = useParams<{ id: string }>();
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Accordion dos cenarios (Base UI, um aberto por vez): array de valores.
  const [openStages, setOpenStages] = useState<string[]>([]);
  // Lista de cenarios: controlada para o clique no heatmap poder força-la
  // aberta. null = default (aberta so quando a run termina).
  const [listOpen, setListOpen] = useState<boolean | null>(null);
  // Progresso agregado dos duelos (evento `duel.progress`) — NUNCA passa pelo
  // reducer: o evento nem stageIndex tem. Fica local e alimenta o FinalsPanel.
  const [duelProgress, setDuelProgress] = useState<{ done: number; total: number } | null>(null);
  // F3: drawer do prompt da variante (aberto pelo DeltaBars).
  const [drawerVariant, setDrawerVariant] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setDuelProgress(null);

    fetchRun(id)
      .then((r) => !cancelled && setRecord(r))
      .catch((e) => !cancelled && setError(e.message));

    const close = openRunStream(
      id,
      (event) => {
        if (cancelled) return;
        if (event.type === 'snapshot') {
          setRecord(event.record);
          void cacheRun(event.record);
          return;
        }
        if (event.type === 'run.finished') void cacheRun(event.record);
        // Ramifica ANTES do applyEvent: progresso agregado nao e uma etapa —
        // `stage.gabarito` tem stageIndex -1 (sem UI propria) e `duel.progress`
        // nem stageIndex tem.
        if (event.type === 'stage.gabarito') return;
        if (event.type === 'duel.progress') {
          setDuelProgress({ done: event.done, total: event.total });
          return;
        }
        setRecord((prev) => prev && applyEvent(prev, event));
      },
      () => {
        fetchRun(id).then((r) => !cancelled && setRecord(r)).catch(() => undefined);
      },
    );

    return () => {
      cancelled = true;
      close();
    };
  }, [id]);

  // Clique numa celula do heatmap: abre o cenario correspondente e rola ate o
  // card. A lista pode estar recolhida durante a run — força aberta ANTES do
  // scroll (o rAF espera o painel renderizar aberto).
  function openStageFromHeatmap(idx: number) {
    // O `value` do AccordionItem É o id do elemento no DOM (âncora de deep-link).
    setOpenStages([`stage-${idx}`]);
    setListOpen(true);
    requestAnimationFrame(() => {
      document.getElementById(`stage-${idx}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  const contestants = useMemo(() => (record ? normalizeContestants(record) : []), [record]);
  const byId = useMemo(
    () => new Map<string, Contestant>(contestants.map((c) => [c.id, c])),
    [contestants],
  );
  // Etapas densas (sem buracos) e ordenadas — base de toda a UI de resultados.
  const stages = useMemo(() => (record ? denseStages(record.stages) : []), [record]);

  // Cenarios do pacote de export: spec de cada etapa, dedup por question
  // (seeds podem repetir a mesma pergunta; o gabarito viaja no spec).
  const packScenarios = useMemo(() => {
    const seen = new Set<string>();
    const out: StageSpec[] = [];
    for (const s of stages) {
      const spec = s.spec;
      if (!spec) continue;
      const key = spec.question.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(spec);
    }
    return out;
  }, [stages]);
  const packRefCount = packScenarios.filter((s) => s.reference?.trim()).length;

  // Prompt do pacote: o do CAMPEAO (maior judge-score entre nao-controle);
  // sem campeao com prompt, cai para o prompt base da run.
  const packPrompt = useMemo(() => {
    if (!record) return null;
    const scores = record.judgeScoreByContestant;
    const champion = scores
      ? contestants
          .filter((c) => !c.isOriginal && c.systemPrompt?.trim() && scores[c.id] !== undefined)
          .sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0))[0]
      : undefined;
    if (champion && champion.systemPrompt && champion.systemPrompt.trim()) {
      return { text: champion.systemPrompt, source: 'champion' as const, label: champion.label };
    }
    const base = record.config.basePrompt?.trim();
    if (base) return { text: base, source: 'base' as const, label: 'Prompt base' };
    return null;
  }, [record, contestants]);

  if (error) {
    return (
      <Screen wide>
        <Banner tone="error">{error}</Banner>
      </Screen>
    );
  }

  if (!record) {
    return (
      <Screen wide>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </Screen>
    );
  }

  const mode = runMode(record);
  const isSingle = mode !== 'compare';
  const isRunning = record.status === 'running';
  const totalStages = record.config.stages;
  const doneStages = stages.filter((s) => s.judge || s.error).length;
  // Bloco "Final": mesma condicao de nulidade do FinalsPanel (evita o rotulo orfao).
  const hasFinals = Boolean(record.finalists?.length) || stages.some((s) => s.duels);
  // Pacote de cenarios: SO variation terminada e com gabaritos. Compare nao
  // exporta (seus contestants sao modelos, sem systemPrompt proprio); treino
  // exporta pela TrainingView.
  const canExportPack =
    record.status === 'finished' && mode === 'variation' && packRefCount > 0 && Boolean(packPrompt);
  const stagesOpen = listOpen ?? !isRunning;

  function exportScenarioPack() {
    if (!record || !packPrompt) return;
    downloadScenarioPack(
      buildScenarioPack({ theme: record.config.theme, prompt: packPrompt, scenarios: packScenarios }),
    );
  }

  return (
    <Screen wide>
      <header className="rounded-xl bg-card p-5 ring-1 ring-foreground/10">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-heading text-xl font-medium tracking-tight">
                Run <code className="font-mono text-[17px] text-muted-foreground">{record.id.slice(0, 8)}</code>
              </h1>
              <StatusPill status={record.status} />
            </div>
            <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">
              {trunc(record.config.theme, 180)}
            </p>
            {record.sessionId && (
              <Link
                className="mt-2 inline-flex items-center gap-1 text-[13px] text-primary underline-offset-4 hover:underline"
                to={`/training/${record.sessionId}`}
              >
                <ArrowLeft className="size-3.5" aria-hidden="true" />
                sessão de treino
                {record.iteration != null ? ` · rodada ${record.iteration + 1}` : ''}
              </Link>
            )}
          </div>

          <div className="flex shrink-0 flex-wrap items-start gap-6">
            <Stat label="cenários">
              {doneStages}/{totalStages}
            </Stat>
            <Stat label="custo">{formatUsd(record.totalCostUsd)}</Stat>
          </div>
        </div>

        {isRunning && (
          <ProgressBar
            className="mt-4"
            value={totalStages ? doneStages / totalStages : 0}
            size="sm"
            progressbar
            aria-label="Cenários julgados"
          />
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => download(`run-${record.id}.json`, JSON.stringify(record, null, 2), 'application/json')}
          >
            <Download aria-hidden="true" />
            JSON
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => download(`run-${record.id}.csv`, runToCsv(record, byId), 'text/csv;charset=utf-8')}
          >
            <Download aria-hidden="true" />
            CSV
          </Button>
          {canExportPack && (
            <Button variant="outline" size="sm" onClick={exportScenarioPack}>
              <Download aria-hidden="true" />
              Pacote
            </Button>
          )}
        </div>
      </header>

      {record.status === 'error' && record.error && (
        <Banner tone="error" className="mt-4">
          <strong>A run falhou:</strong> {record.error}
        </Banner>
      )}
      {record.status === 'aborted' && (
        <Banner className="mt-4">Run interrompida — o servidor reiniciou enquanto ela rodava.</Banner>
      )}

      <SectionHead>Resultados</SectionHead>
      <ScoreHeatmap record={record} ranked={!isRunning} onStageClick={openStageFromHeatmap} />

      {hasFinals && (
        <>
          <SectionHead>Final</SectionHead>
          <FinalsPanel record={record} progress={duelProgress} />
        </>
      )}

      {/* F3 (PLANO-PARIDADE): delta vs controle, "onde falhou" e diagnóstico do
          juiz — só depois de rodar (durante, a tela é o heatmap). O DeltaBars
          abre o drawer do prompt da variante no clique. */}
      {!isRunning && (
        <>
          <DeltaBars record={record} onVariantClick={setDrawerVariant} />
          <FailureDigest record={record} />
          <JudgeDiagnostics record={record} />
          <TruncationNotice record={record} />
        </>
      )}
      <VariantPromptDrawer
        record={record}
        variantId={drawerVariant}
        onClose={() => setDrawerVariant(null)}
      />

      {/* Enquanto roda, a tela e SO o heatmap: o drill-down por cenario fica
          recolhido por default (aberto so quando a run termina), mas o usuario
          e o clique no heatmap mandam. */}
      <SectionHead
        status={
          <button
            type="button"
            className="text-primary underline-offset-4 hover:underline"
            onClick={() => setListOpen(!stagesOpen)}
          >
            {stagesOpen ? 'recolher' : 'expandir'}
          </button>
        }
      >
        Cenários{stages.length ? ` (${stages.length})` : ''}
      </SectionHead>

      {stages.length === 0 ? (
        <EmptyState>Aguardando o primeiro cenário…</EmptyState>
      ) : stagesOpen ? (
        <Accordion
          value={openStages}
          onValueChange={setOpenStages}
          className="divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10"
        >
          {stages.map((stage) => (
            <StageRow key={stage.index} stage={stage} byId={byId} contestants={contestants} />
          ))}
        </Accordion>
      ) : (
        <EmptyState>{stages.length} cenários — expanda para ver enunciado e respostas.</EmptyState>
      )}

      {isSingle && contestants.length > 0 && (
        <>
          <SectionHead status={contestants[0]?.modelId}>Variantes ({contestants.length})</SectionHead>
          <div className="flex flex-col gap-3">
            {contestants.map((c) => (
              <div key={c.id} className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{c.label}</span>
                  {c.isOriginal && <Tag>base</Tag>}
                  {c.techniqueId && <Tag>{c.techniqueId}</Tag>}
                </div>
                {c.systemPrompt && <Pre>{c.systemPrompt}</Pre>}
              </div>
            ))}
          </div>
        </>
      )}
    </Screen>
  );
}

interface StageRowProps {
  stage: StageRecord;
  byId: Map<string, Contestant>;
  /** Contestants na ordem da run — desempate estavel da lista de respostas. */
  contestants: Contestant[];
}

// Um cenario do accordion: cabecalho "01 · pergunta" e, aberto, o enunciado
// completo + as respostas ordenadas por veredito.
function StageRow({ stage, byId, contestants }: StageRowProps) {
  const orderOf = new Map<string, number>(contestants.map((c, i) => [c.id, i] as [string, number]));
  const sortedResponses = stage.responses.slice().sort((a, b) => {
    const va = stageVerdict(stage, a.contestantId);
    const vb = stageVerdict(stage, b.contestantId);
    const oa = va ? VERDICT_ORDER[va] : 3;
    const ob = vb ? VERDICT_ORDER[vb] : 3;
    if (oa !== ob) return oa - ob;
    return (orderOf.get(a.contestantId) ?? 0) - (orderOf.get(b.contestantId) ?? 0);
  });

  const numLabel = String(stage.index + 1).padStart(2, '0');
  const snippet = stage.spec ? trunc(stage.spec.question, 110) : stage.error ? 'Cenário pulado' : 'Gerando cenário…';

  return (
    <AccordionItem value={`stage-${stage.index}`}>
      <AccordionTrigger className="px-4 py-3.5 text-left" headingLevel={3}>
        <span className="flex min-w-0 flex-1 items-baseline gap-3">
          <span className="shrink-0 font-mono text-[12px] text-muted-foreground tabular">{numLabel}</span>
          <span className="min-w-0 flex-1 truncate text-[13px]">{snippet}</span>
          {stage.error && <Tag className="shrink-0">pulado</Tag>}
        </span>
      </AccordionTrigger>
      <AccordionPanel className="px-4 pb-4">
        {stage.error && (
          <Banner className="mb-4">
            <strong>Cenário pulado:</strong> {stage.error}
          </Banner>
        )}

        {stage.spec && (
          <div className="flex flex-col gap-4">
            <div>
              <MiniLabel>Pergunta</MiniLabel>
              <p className="text-sm leading-relaxed">{stage.spec.question}</p>
            </div>
            <div>
              <MiniLabel>Contexto</MiniLabel>
              <Pre>{stage.spec.productContext}</Pre>
            </div>
            {stage.spec.rubric?.trim() && (
              <div>
                <MiniLabel>Rubrica</MiniLabel>
                <Pre>{stage.spec.rubric}</Pre>
              </div>
            )}
            {stage.spec.reference?.trim() && (
              <div>
                <MiniLabel>Gabarito</MiniLabel>
                <Pre>{stage.spec.reference}</Pre>
              </div>
            )}
          </div>
        )}

        {sortedResponses.length > 0 && (
          <div className="mt-5 flex flex-col gap-3">
            {sortedResponses.map((r) => {
              const v = stageVerdict(stage, r.contestantId);
              const meta = v ? VERDICT_META[v] : undefined;
              const explanation = stage.referenceJudge?.explanationByContestant?.[r.contestantId];
              return (
                <div key={r.contestantId} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium">
                      {byId.get(r.contestantId)?.label ?? r.modelId}
                    </span>
                    {meta && (
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
                          meta.pill,
                        )}
                      >
                        {meta.label}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 font-mono text-[11.5px] text-muted-foreground tabular">
                    {formatMs(r.latencyMs)} · {r.tokensIn}→{r.tokensOut} tok · {formatUsd(r.costUsd)}
                    {r.status === 'error' && <span className="text-destructive"> · ERRO: {r.errorMsg}</span>}
                    {/* IMPL-010: bloqueio é a defesa do gateway (sem veredito), não erro nem key. */}
                    {r.status === 'blocked' && (
                      <span className="text-muted-foreground"> · BLOQUEADO pela moderação: {r.errorMsg}</span>
                    )}
                    {r.status === 'refused' && <span className="text-muted-foreground"> · o modelo recusou</span>}
                    {/* IMPL-014: cortada no teto (mesmo com o retry x2) — a etapa fica fora do placar. */}
                    {r.truncated && (
                      <span className="text-muted-foreground">
                        {' '}· TRUNCADA no teto de {r.maxTokens ?? '?'} tokens ({r.finishReason ?? r.nativeFinishReason ?? 'sem finish_reason'}) — etapa fora do placar
                      </span>
                    )}
                    {!r.truncated && r.truncationRetried && (
                      <span className="text-muted-foreground"> · truncou na 1ª tentativa; refeita com teto {r.maxTokens}</span>
                    )}
                  </div>
                  {explanation && (
                    <p className="mt-2 border-l-2 border-border pl-3 text-[13px] text-muted-foreground">
                      {explanation}
                    </p>
                  )}
                  {(r.status === 'ok' || r.status === 'refused') && <Pre className="mt-2">{r.text}</Pre>}
                </div>
              );
            })}
          </div>
        )}
      </AccordionPanel>
    </AccordionItem>
  );
}
