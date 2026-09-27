import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, Download } from 'lucide-react';
import type { RunRecord, SessionRecord, StageSpec } from '../api';
import {
  cacheSession,
  fetchSession,
  openSessionStream,
  fetchRun,
  getLiveRun,
  subscribeRunLive,
  savePrompt,
  buildScenarioPack,
  downloadScenarioPack,
} from '../api';
import { useTheme } from '../theme';
import { applyEvent, denseStages, rankColor, ScoreHeatmap, FinalsPanel } from './runShared';
import { FailureDigest, DeltaBars, VariantPromptDrawer, JudgeDiagnostics } from '../components/RunInsights';
import { diffLines } from '../diff';
import {
  SmoothTabs,
  SmoothTabsList,
  SmoothTabsTab,
  SmoothTabsPanels,
  SmoothTabsPanel,
} from '@/components/motion-ui/smooth-tabs';
import { CopyButton } from '@/components/motion-ui/copy-button';
import { Sparkline } from '@/components/motion-ui/sparkline';
import { Skeleton } from '@/components/motion-ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Banner,
  DiffView,
  EmptyState,
  Pre,
  Screen,
  SectionHead,
  StatusPill,
  Tag,
} from '../components/primitives';
import { useToasts } from '../components/AppShell';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Cockpit de treino: acompanha a sessao inteira sem precisar entrar em cada
// /runs/:id. So o essencial — heatmap da rodada corrente, finais, evolucao
// entre rodadas e a escolha do melhor prompt.
// ---------------------------------------------------------------------------

/** Heatmap de evolucao: variante x rodada; celula = judge-score arredondado. */
function EvolutionHeatmap({
  rounds,
  dark,
  holdoutAt,
}: {
  rounds: RunRecord[];
  dark: boolean;
  holdoutAt?: number;
}) {
  const cols = useMemo(
    () =>
      rounds.map((r) => {
        const scores = r.judgeScoreByContestant ?? {};
        const ordered = Object.entries(scores).sort((a, b) => b[1] - a[1]);
        return {
          iteration: r.iteration ?? 0,
          isHoldout: r.iteration === holdoutAt,
          scores,
          total: ordered.length,
          place: new Map(ordered.map(([id], i) => [id, i + 1])),
        };
      }),
    [rounds, holdoutAt],
  );
  // Ordem estavel: primeira aparicao da variante ao longo das rodadas.
  const vars = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; label: string; isOriginal?: boolean }[] = [];
    for (const r of rounds) {
      for (const c of r.contestants ?? []) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push({ id: c.id, label: c.label, isOriginal: c.isOriginal });
      }
    }
    return out;
  }, [rounds]);

  if (!cols.length || !vars.length) return null;

  const gridStyle = {
    gridTemplateColumns: `minmax(8rem, 1fr) repeat(${cols.length}, 3rem) 5rem`,
  };

  return (
    <div className="rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="scroll-slim overflow-x-auto p-3">
        <div className="min-w-fit">
          <div className="grid items-center gap-1 pb-1.5" style={gridStyle}>
            <div />
            {cols.map((col) => (
              <div
                key={col.iteration}
                className="grid h-6 place-items-center text-[11px] text-muted-foreground tabular"
              >
                {col.isHoldout ? 'H' : `R${col.iteration + 1}`}
              </div>
            ))}
            <div className="pr-1 text-right text-[11px] text-muted-foreground">curva</div>
          </div>

          {vars.map((v) => {
            // A trilha da variante ao longo das rodadas alimenta a sparkline.
            const history = cols.map((c) => c.scores[v.id]).filter((s): s is number => s !== undefined);
            return (
              <div key={v.id} className="grid items-center gap-1 py-0.5" style={gridStyle}>
                <div className="flex min-w-0 items-center gap-1.5 pr-3">
                  <span className="truncate text-[13px]">{v.label}</span>
                  {v.isOriginal && <Tag>base</Tag>}
                </div>
                {cols.map((col) => {
                  const rodada = col.isHoldout ? 'Holdout' : `Rodada ${col.iteration + 1}`;
                  const score = col.scores[v.id];
                  if (score === undefined) {
                    return (
                      <div
                        key={col.iteration}
                        className="grid h-7 place-items-center rounded-[5px] bg-muted/50 text-[13px] text-muted-foreground"
                        title={`${rodada}: não participou`}
                      >
                        ·
                      </div>
                    );
                  }
                  const rc = rankColor(col.place.get(v.id) ?? 1, col.total, dark);
                  return (
                    <div
                      key={col.iteration}
                      className="grid h-7 place-items-center rounded-[5px] text-[13px] font-medium tabular"
                      style={{ background: rc.soft, color: rc.text }}
                      title={`${rodada}: judge-score ${score.toFixed(1)}`}
                    >
                      {Math.round(score)}
                    </div>
                  );
                })}
                <div className="flex justify-end pr-1">
                  {history.length > 1 ? (
                    <Sparkline
                      history={history}
                      width={64}
                      height={22}
                      tone="primary"
                      label={`Evolução de ${v.label}`}
                    />
                  ) : (
                    <span className="text-[12px] text-muted-foreground">—</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Estudio final: escolher qualquer variante de qualquer rodada, ver o diff vs.
 *  o prompt original, copiar e salvar na biblioteca local. */
function BestPromptStudio({
  rounds,
  originalPrompt,
  defaultRunId,
  defaultCid,
  sessionId,
  holdoutAt,
}: {
  rounds: RunRecord[];
  originalPrompt: string;
  defaultRunId?: string;
  defaultCid?: string;
  sessionId: string;
  holdoutAt?: number;
}) {
  const { notify } = useToasts();
  // Variantes de cada rodada, ordenadas por judge-score (sem score vai pro fim).
  const data = useMemo(
    () =>
      rounds.map((r) => {
        const scores = r.judgeScoreByContestant ?? {};
        const variants = (r.contestants ?? [])
          .map((c) => ({
            id: c.id,
            label: c.label,
            isOriginal: c.isOriginal,
            techniqueId: c.techniqueId,
            systemPrompt: c.systemPrompt,
            score: scores[c.id],
          }))
          .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
        return { iteration: r.iteration ?? 0, runId: r.id, variants };
      }),
    [rounds],
  );

  const [selRunId, setSelRunId] = useState<string | undefined>(defaultRunId ?? data[data.length - 1]?.runId);
  // F3: drawer do prompt da variante (aberto pelo DeltaBars).
  const [selCid, setSelCid] = useState<string | undefined>(defaultCid);
  const [view, setView] = useState<'diff' | 'prompt'>('diff');
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Quem o usuario ja escolheu a mao manda; enquanto ele nao escolheu, a
  // selecao SEGUE o campeao sugerido. Acompanhando a sessao ao vivo, `defaultRunId`
  // /`defaultCid` so existem depois da 1a rodada fechar — com `prev ?? …` a
  // sugestao nunca chegava e a tela ficava presa numa variante arbitraria.
  const escolhaManual = useRef(false);
  useEffect(() => {
    if (!data.length || escolhaManual.current) return;
    const run = data.find((d) => d.runId === defaultRunId) ?? data[data.length - 1];
    setSelRunId(run.runId);
    setSelCid(defaultCid ?? run.variants[0]?.id);
  }, [data, defaultRunId, defaultCid]);

  function escolher(runId: string | undefined, cid: string | undefined) {
    escolhaManual.current = true;
    if (runId !== undefined) setSelRunId(runId);
    setSelCid(cid);
  }

  const selRound = data.find((d) => d.runId === selRunId) ?? data[data.length - 1];
  const selVariant = selRound && selCid ? selRound.variants.find((v) => v.id === selCid) : undefined;
  const selPrompt = selVariant?.systemPrompt ?? '';
  // useMemo antes de qualquer early-return (regras dos hooks).
  const diff = useMemo(() => diffLines(originalPrompt, selPrompt), [originalPrompt, selPrompt]);

  // Trocar de rodada/variante reseta o form e o feedback de salvar.
  useEffect(() => {
    setSaveOpen(false);
    setSaved(false);
  }, [selRunId, selCid]);

  function openSaveForm() {
    if (!selRound) return;
    const tag = selRound.iteration === holdoutAt ? 'holdout' : `rodada ${selRound.iteration + 1}`;
    setSaveName(`Prompt ${selVariant?.label ?? selCid ?? 'variante'} · ${tag}`);
    setSaveOpen(true);
  }

  async function saveToLibrary() {
    const name = saveName.trim();
    if (!selRound || !selPrompt || !name || saving) return;
    setSaving(true);
    try {
      await savePrompt({
        name,
        text: selPrompt,
        origin: {
          kind: 'training',
          sessionId,
          runId: selRound.runId,
          techniqueId: selVariant?.techniqueId,
          iteration: selRound.iteration,
        },
      });
      setSaved(true);
      setSaveOpen(false);
      notify('Prompt salvo na biblioteca.');
    } catch {
      notify('Não foi possível salvar na biblioteca.', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!selRound) return null;

  return (
    <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <label className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Rodada</span>
        <select
          className="h-8 rounded-lg border border-input bg-background px-2 text-[13px] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          value={selRunId ?? ''}
          onChange={(e) => {
            const rid = e.target.value;
            const r = data.find((d) => d.runId === rid);
            escolher(rid, r?.variants[0]?.id);
          }}
        >
          {data.map((d) => (
            <option key={d.runId} value={d.runId}>
              {d.iteration === holdoutAt ? 'Holdout' : `Rodada ${d.iteration + 1}`}
            </option>
          ))}
        </select>
      </label>

      <div className="mt-3 flex flex-col gap-1.5">
        {selRound.variants.map((v, idx) => (
          <button
            type="button"
            key={v.id}
            onClick={() => escolher(undefined, v.id)}
            disabled={!v.systemPrompt}
            title={v.systemPrompt ? '' : 'Esta variante não tem system prompt próprio.'}
            className={cn(
              'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
              v.id === selCid ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted',
              !v.systemPrompt && 'cursor-not-allowed opacity-50',
            )}
          >
            <span className="w-6 shrink-0 font-mono text-[12px] text-muted-foreground tabular">{idx + 1}º</span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="truncate text-[13px]">{v.label}</span>
              {v.isOriginal && <Tag>base</Tag>}
            </span>
            <span className="shrink-0 text-[12px] text-muted-foreground tabular">
              {v.score === undefined ? '—' : `${Math.round(v.score)} pts`}
            </span>
          </button>
        ))}
      </div>

      {!selPrompt ? (
        <p className="mt-4 text-[13px] text-muted-foreground">
          Esta variante usa o contexto do cenário (sem system prompt próprio).
        </p>
      ) : (
        <SmoothTabs
          value={view}
          onValueChange={(v) => setView(v as 'diff' | 'prompt')}
          className="mt-4 flex flex-col gap-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* nowrap: as abas dividem a largura por igual e "Diff vs. original"
                quebrava em duas linhas, deixando a lista com o dobro da altura. */}
            <SmoothTabsList ariaLabel="Ver prompt ou diff" className="w-fit">
              <SmoothTabsTab value="diff" className="px-3 py-1.5 text-[13px] whitespace-nowrap">
                Diff vs. original
              </SmoothTabsTab>
              <SmoothTabsTab value="prompt" className="px-3 py-1.5 text-[13px] whitespace-nowrap">
                Prompt
              </SmoothTabsTab>
            </SmoothTabsList>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={openSaveForm} disabled={saved}>
                {saved ? 'Salvo' : 'Salvar na biblioteca'}
              </Button>
              {/* variant="icon": o default é uma pílula primary em mono-caixa-alta,
                  que gritava ao lado do botão de salvar. */}
              <CopyButton
                variant="icon"
                value={selPrompt}
                label="Copiar prompt"
                copiedLabel="Prompt copiado"
                className="h-7 rounded-lg"
              />
            </div>
          </div>

          <SmoothTabsPanels>
            <SmoothTabsPanel value="diff">
              <DiffView diff={diff} />
            </SmoothTabsPanel>
            <SmoothTabsPanel value="prompt">
              <Pre>{selPrompt}</Pre>
            </SmoothTabsPanel>
          </SmoothTabsPanels>
        </SmoothTabs>
      )}

      {saveOpen && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            className="h-8 min-w-[16rem] flex-1"
            aria-label="Nome na biblioteca"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="Nome na biblioteca"
          />
          <Button size="sm" onClick={() => void saveToLibrary()} disabled={saving || !saveName.trim()}>
            {saving ? 'Salvando…' : 'Salvar'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSaveOpen(false)}>
            Cancelar
          </Button>
        </div>
      )}

      {saved && (
        <p className="mt-3 text-[13px] text-muted-foreground">
          Salvo ·{' '}
          <Link className="text-primary underline-offset-4 hover:underline" to="/prompts">
            ver na biblioteca
          </Link>
        </p>
      )}
    </div>
  );
}

export function TrainingView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { resolved } = useTheme();
  const dark = resolved === 'dark';
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<RunRecord | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string | undefined>(undefined);
  // F3: drawer do prompt da variante (aberto pelo DeltaBars).
  const [drawerVariant, setDrawerVariant] = useState<string | null>(null);
  const [pastRuns, setPastRuns] = useState<Record<string, RunRecord>>({});
  const [duelProgress, setDuelProgress] = useState<{ done: number; total: number } | null>(null);

  // Efeito A: eventos da SESSAO (iteracoes, snapshot, fim).
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const refetch = () =>
      fetchSession(sessionId)
        .then((s) => {
          if (cancelled) return;
          setSession(s);
          // Mesma regra do snapshot: mais runs do que iteracoes concluidas => a
          // ultima e a corrente (cobre a run de holdout, que NAO emite iteration.started).
          const doneN = s.bestPromptByIteration.length;
          const cur = s.runIds.length > doneN ? s.runIds[s.runIds.length - 1] : undefined;
          if (cur) setCurrentRunId(cur);
        })
        .catch((e) => !cancelled && setError(e.message));
    refetch();
    const close = openSessionStream(
      sessionId,
      (event) => {
        if (cancelled) return;
        if (event.type === 'snapshot') {
          const rec = event.record as SessionRecord;
          setSession(rec);
          void cacheSession(rec);
          const doneN = rec.bestPromptByIteration.length;
          const cur = rec.runIds.length > doneN ? rec.runIds[rec.runIds.length - 1] : undefined;
          if (cur) setCurrentRunId(cur);
          return;
        }
        if (event.type === 'iteration.started') {
          setLiveRun(null);
          setCurrentRunId(event.runId);
          return;
        }
        if (event.type === 'iteration.finished') {
          fetchRun(event.runId)
            .then((r) => !cancelled && setPastRuns((prev) => ({ ...prev, [event.runId]: r })))
            .catch(() => undefined);
        }
        if (event.type === 'session.converged') {
          setSession((prev) => (prev ? { ...prev, convergedAtIteration: event.iteration } : prev));
        }
        if (event.type === 'session.holdout') {
          setSession((prev) => (prev ? { ...prev, holdout: event.holdout } : prev));
        }
        if (event.type === 'session.finished') void cacheSession(event.record);
        refetch();
      },
      () => refetch(),
    );
    return () => {
      cancelled = true;
      close();
    };
  }, [sessionId]);

  // Efeito B: assina o run da ITERACAO CORRENTE e dobra os eventos (applyEvent).
  useEffect(() => {
    setDuelProgress(null);
    if (!currentRunId) {
      setLiveRun(null);
      return;
    }
    let cancelled = false;
    const seed = getLiveRun(currentRunId);
    if (seed) setLiveRun(seed);
    // Runs de iteracao de treino NAO sao pre-cacheadas (so createRun cacheia), entao
    // o seed pode ser undefined ate run.started. O fetch de fallback e IDB e pode
    // resolver DEPOIS de a subscricao ja ter populado stages — nao pode sobrescrever
    // (prev ?? r); senao a rodada ao vivo "esvazia" ate run.finished.
    else fetchRun(currentRunId).then((r) => !cancelled && setLiveRun((prev) => prev ?? r)).catch(() => undefined);
    const unsub = subscribeRunLive(currentRunId, (e) => {
      if (cancelled) return;
      if (e.type === 'run.started' || e.type === 'run.finished') {
        setLiveRun(e.record);
        return;
      }
      // Progresso agregado dos duelos: nao entra no record (applyEvent devolve
      // `prev`), vive em estado proprio e alimenta o painel de finais.
      if (e.type === 'duel.progress') {
        setDuelProgress({ done: e.done, total: e.total });
        return;
      }
      setLiveRun((prev) => (prev ? applyEvent(prev, e) : prev));
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [currentRunId]);

  // Efeito C: backfill dos runs concluidos (inclui sessoes ja finalizadas).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    for (const rid of session.runIds ?? []) {
      if (rid === currentRunId || pastRuns[rid]) continue;
      fetchRun(rid)
        .then((r) => {
          if (!cancelled) setPastRuns((prev) => (prev[rid] ? prev : { ...prev, [rid]: r }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
    // pastRuns omitido de proposito (guardado por prev[rid]) p/ evitar loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, currentRunId]);

  // Rodadas conhecidas (concluidas + a corrente), ordenadas por iteracao.
  const rounds = useMemo(() => {
    const map = new Map<string, RunRecord>();
    for (const r of Object.values(pastRuns)) map.set(r.id, r);
    if (liveRun) map.set(liveRun.id, liveRun);
    return [...map.values()].filter((r) => r.iteration != null).sort((a, b) => (a.iteration ?? 0) - (b.iteration ?? 0));
  }, [pastRuns, liveRun]);

  // Cenarios do pacote: dedup por pergunta preferindo a versao COM gabarito;
  // fallback = cenarios pinados da sessao.
  const packScenarios = useMemo(() => {
    const byQuestion = new Map<string, StageSpec>();
    for (const r of rounds) {
      for (const st of denseStages(r.stages)) {
        const spec = st.spec;
        if (!spec?.question) continue;
        const prev = byQuestion.get(spec.question);
        if (!prev || (!prev.reference && spec.reference)) byQuestion.set(spec.question, spec);
      }
    }
    const list = [...byQuestion.values()];
    if (list.length) return list;
    return (session?.pinnedStages ?? []).filter((s) => s.question);
  }, [rounds, session]);

  if (error) {
    return (
      <Screen wide>
        <Banner tone="error">{error}</Banner>
      </Screen>
    );
  }

  if (!session) {
    return (
      <Screen wide>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </Screen>
    );
  }

  const done = session.bestPromptByIteration.length;
  const planned = session.config.iterations ?? 0;
  const isRunning = session.status === 'running';
  // A run de holdout e marcada com iteracao == planned ("rodada H"): em toda
  // lista de rodadas ela vira "Holdout", nunca "Rodada N+1".
  const holdoutAt = planned > 0 ? planned : undefined;
  const best = session.bestPromptByIteration.length
    ? session.bestPromptByIteration.reduce((a, b) => (b.score >= a.score ? b : a))
    : undefined;
  const originalPrompt = session.config.basePrompt ?? '';
  // Rodada em foco: a corrente ao vivo, ou a ultima conhecida quando acabou.
  const roundShown = liveRun ?? rounds[rounds.length - 1];
  const roundLabel = roundShown
    ? roundShown.iteration === holdoutAt
      ? 'Holdout'
      : `Rodada ${(roundShown.iteration ?? 0) + 1}`
    : '';
  const showFinals = Boolean(
    roundShown &&
      ((roundShown.finalists?.length ?? 0) > 0 || denseStages(roundShown.stages).some((s) => s.duels)),
  );

  // Gates (holdout / significancia / convergencia) em UMA linha.
  const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;
  const gates: string[] = [];
  if (session.convergedAtIteration != null) gates.push(`Convergiu na rodada ${session.convergedAtIteration + 1}`);
  if (session.holdout) {
    const h = session.holdout;
    gates.push(
      `Holdout n=${h.n}: base ${h.controlScore.toFixed(0)} → campeão ${h.championScore.toFixed(0)} (${signed(h.gain)})${h.regressed ? ' — regrediu' : ''}`,
    );
  }
  if (session.significance !== undefined) {
    const sig = session.significance;
    gates.push(sig === null ? 'amostra insuficiente p/ significância' : sig.pValue < 0.001 ? 'p<0.001' : `p=${sig.pValue.toFixed(3)}`);
  }

  function downloadPack() {
    if (!session || !packScenarios.length) return;
    const lastBest = session.bestPromptByIteration[session.bestPromptByIteration.length - 1];
    const prompt = lastBest?.systemPrompt
      ? { text: lastBest.systemPrompt, source: 'champion' as const, label: `Campeão da rodada ${lastBest.iteration + 1}` }
      : { text: session.config.basePrompt ?? '', source: 'base' as const, label: 'Prompt base' };
    downloadScenarioPack(buildScenarioPack({ theme: session.config.theme, prompt, scenarios: packScenarios }));
  }

  return (
    <Screen wide>
      <header className="rounded-xl bg-card p-5 ring-1 ring-foreground/10">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-heading text-xl font-medium tracking-tight">
                Treino <code className="font-mono text-[17px] text-muted-foreground">{session.id.slice(0, 8)}</code>
              </h1>
              <StatusPill status={session.status} />
            </div>
            <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">
              {session.config.theme} ·{' '}
              <code className="font-mono text-[12.5px]">{session.config.contestantModelId}</code>
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-start gap-6">
            <div className="min-w-[5rem]">
              <div className="text-[11px] tracking-wide text-muted-foreground uppercase">rodada</div>
              <div className="mt-0.5 font-heading text-lg font-medium tabular">
                {done}/{planned}
              </div>
            </div>
            <div className="min-w-[5rem]">
              <div className="text-[11px] tracking-wide text-muted-foreground uppercase">custo</div>
              <div className="mt-0.5 font-heading text-lg font-medium tabular">
                ${session.totalCostUsd.toFixed(4)}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 border-t border-border pt-4">
          <Button variant="outline" size="sm" onClick={downloadPack} disabled={!packScenarios.length}>
            <Download aria-hidden="true" />
            Pacote
          </Button>
        </div>
      </header>

      {session.status === 'error' && session.error && (
        <Banner tone="error" className="mt-4">
          <strong>Treino falhou:</strong> {session.error}
        </Banner>
      )}
      {session.status === 'aborted' && (
        <Banner className="mt-4">Treino interrompido — o servidor reiniciou enquanto ele rodava.</Banner>
      )}
      {gates.length > 0 && (
        <Banner tone={session.holdout?.regressed ? 'error' : 'neutral'} className="mt-4">
          {gates.join(' · ')}
        </Banner>
      )}

      {roundShown ? (
        <>
          <SectionHead
            status={
              <Link
                className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                to={`/runs/${roundShown.id}`}
              >
                detalhe
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
            }
          >
            {roundLabel}
            {isRunning && ' — ao vivo'}
          </SectionHead>
          <ScoreHeatmap
            record={roundShown}
            ranked={roundShown.status === 'finished' || roundShown.status === 'inconclusive'}
            onStageClick={() => navigate(`/runs/${roundShown.id}`)}
          />

          {showFinals && (
            <>
              <SectionHead>Final da rodada</SectionHead>
              <FinalsPanel record={roundShown} progress={duelProgress} />
            </>
          )}

          {/* F3 (PLANO-PARIDADE): delta vs controle, onde falhou e diagnóstico
              do juiz — só depois de rodar o delta abre o drawer da variante. */}
          {!isRunning && (
            <>
              <DeltaBars record={roundShown} onVariantClick={setDrawerVariant} />
              <FailureDigest record={roundShown} />
              <JudgeDiagnostics record={roundShown} />
            </>
          )}
        </>
      ) : (
        <EmptyState>Preparando a rodada…</EmptyState>
      )}

      <VariantPromptDrawer
        record={roundShown ?? rounds[rounds.length - 1]}
        variantId={drawerVariant}
        onClose={() => setDrawerVariant(null)}
      />

      {rounds.length > 1 && (
        <>
          <SectionHead>Evolução</SectionHead>
          <EvolutionHeatmap rounds={rounds} dark={dark} holdoutAt={holdoutAt} />
        </>
      )}

      {rounds.length > 0 && (
        <>
          <SectionHead>Melhor prompt</SectionHead>
          <BestPromptStudio
            rounds={rounds}
            originalPrompt={originalPrompt}
            defaultRunId={best?.runId}
            defaultCid={best?.winnerContestantId}
            sessionId={session.id}
            holdoutAt={holdoutAt}
          />
        </>
      )}
    </Screen>
  );
}
