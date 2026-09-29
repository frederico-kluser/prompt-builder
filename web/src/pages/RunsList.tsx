import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Search } from 'lucide-react';
import type { RunMode, RunSummary, SessionSummary } from '../api';
import { fetchRuns, fetchSessions } from '../api';
import { SegmentedToggle, SegmentedToggleOption } from '@/components/motion-ui/segmented-toggle';
import { SkeletonResolveList, SkeletonResolveRow, Skeleton } from '@/components/motion-ui/skeleton';
import { Input } from '@/components/ui/input';
import { Banner, EmptyState, PageHeader, Screen, StatusPill, Tag } from '../components/primitives';
import { StorageNotice } from '../components/StorageNotice';
import { JevHistory } from '../components/jev/JevHistory';

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export type Group = 'running' | 'finished' | 'aborted' | 'error';

export function groupOf(status: RunSummary['status']): Group {
  if (status === 'running') return 'running';
  // `inconclusive` (IMPL-004) terminou o pipeline: fica em "Concluídas" e a
  // pílula de status diz que o resultado não sustenta conclusão.
  if (status === 'finished' || status === 'inconclusive') return 'finished';
  // web-live#16: cancelada/orçamento/reinício NÃO é "erro" — tem grupo próprio.
  if (status === 'aborted') return 'aborted';
  return 'error';
}

/**
 * Linha de metadados com UNIDADE (web-live#16): antes a coluna mostrava
 * `5/3` (cenários/participantes) para run — lido como progresso — e `2/5`
 * (rodadas) para treino, sem nada que os distinguisse.
 */
export function runMeta(r: Pick<RunSummary, 'stages' | 'contestants' | 'competitors'>): string {
  const n = r.contestants ?? r.competitors;
  return `${r.stages} cenário${r.stages === 1 ? '' : 's'} · ${n} participante${n === 1 ? '' : 's'}`;
}

export function sessionMeta(s: Pick<SessionSummary, 'iterationsDone' | 'iterationsPlanned'>): string {
  return `rodada ${s.iterationsDone} de ${s.iterationsPlanned}`;
}

function modeLabel(mode?: RunMode): string {
  if (mode === 'variation') return 'variação';
  if (mode === 'training') return 'treino';
  return 'comparar';
}

const FILTERS: { key: 'all' | Group; label: string }[] = [
  { key: 'all', label: 'Todas' },
  { key: 'running', label: 'Em andamento' },
  { key: 'finished', label: 'Concluídas' },
  { key: 'aborted', label: 'Interrompidas' },
  { key: 'error', label: 'Com erro' },
];

type Item =
  | { kind: 'session'; s: SessionSummary; at: string; status: RunSummary['status']; theme: string }
  | { kind: 'run'; r: RunSummary; at: string; status: RunSummary['status']; theme: string };

/** Uma linha da lista — mesma grade para run e sessão de treino. */
function Row({
  to,
  id,
  status,
  mode,
  theme,
  meta,
  cost,
  at,
}: {
  to: string;
  id: string;
  status: RunSummary['status'];
  mode: string;
  theme: string;
  /** Metadados JÁ com unidade ("5 cenários · 3 participantes", "rodada 2 de 5"). */
  meta: string;
  cost: number;
  at: string;
}) {
  return (
    <Link
      to={to}
      className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 last:border-b-0 hover:bg-muted/60 focus-visible:bg-muted focus-visible:outline-none sm:grid-cols-[5.5rem_8rem_1fr_auto_auto_10rem]"
    >
      <code className="font-mono text-[12px] text-muted-foreground">{id.slice(0, 8)}</code>
      <span className="flex items-center gap-1.5">
        <StatusPill status={status} />
      </span>
      <span className="col-span-3 min-w-0 truncate text-sm sm:col-span-1" title={theme}>
        {theme}
      </span>
      <span className="hidden items-center gap-1.5 sm:flex">
        <Tag>{mode}</Tag>
      </span>
      <span className="hidden shrink-0 text-right text-[12px] text-muted-foreground tabular sm:block">
        {meta}
      </span>
      <span className="hidden shrink-0 text-right text-[12px] text-muted-foreground tabular md:block">
        ${cost.toFixed(4)} · {formatDate(at)}
      </span>
    </Link>
  );
}

export function RunsList() {
  // Modo JEV (chunk 2): aba "LLM | JEV" sobre a lista; `?tipo=jev` abre direto nela.
  const location = useLocation();
  const [tipo, setTipo] = useState<'llm' | 'jev'>(() => (new URLSearchParams(location.search).get('tipo') === 'jev' ? 'jev' : 'llm'));
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | Group>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    Promise.all([fetchRuns(), fetchSessions().catch(() => [] as SessionSummary[])])
      .then(([r, s]) => {
        setRuns(r);
        setSessions(s);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Sessões de treino viram uma linha (link p/ /training); as runs-filhas (iterações)
  // ficam ocultas da lista plana — são acessíveis pela tela da sessão.
  const items = useMemo<Item[]>(() => {
    const standalone = runs.filter((r) => !r.sessionId);
    const list: Item[] = [
      ...sessions.map((s) => ({ kind: 'session' as const, s, at: s.startedAt, status: s.status, theme: s.theme })),
      ...standalone.map((r) => ({ kind: 'run' as const, r, at: r.startedAt, status: r.status, theme: r.theme })),
    ];
    return list.sort((a, b) => b.at.localeCompare(a.at));
  }, [runs, sessions]);

  const counts = useMemo(() => {
    const c = { all: items.length, running: 0, finished: 0, aborted: 0, error: 0 };
    for (const it of items) c[groupOf(it.status)]++;
    return c;
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (it) => (filter === 'all' || groupOf(it.status) === filter) && (!q || it.theme.toLowerCase().includes(q)),
    );
  }, [items, filter, query]);

  if (error) {
    return (
      <Screen wide>
        <Banner tone="error">{error}</Banner>
      </Screen>
    );
  }

  return (
    <Screen wide>
      <PageHeader title="Histórico" subtitle="Runs e treinos executados, mais recentes primeiro." />
      {/* IMPL-022: o Histórico lê do IndexedDB — o que não foi salvo não aparece
          na lista, então o aviso (e a persistência negada) aparece aqui. */}
      <StorageNotice className="mb-4" targets="all" />

      <SegmentedToggle value={tipo} onChange={(v) => setTipo(v as 'llm' | 'jev')} ariaLabel="Tipo de run" className="mb-4">
        <SegmentedToggleOption value="llm" className="px-4 py-1.5 text-[13px]">
          LLM
        </SegmentedToggleOption>
        <SegmentedToggleOption value="jev" className="px-4 py-1.5 text-[13px] whitespace-nowrap">
          JEV (decisões)
        </SegmentedToggleOption>
      </SegmentedToggle>
      {tipo === 'jev' ? (
        <>
          <div className="mb-4 relative min-w-[14rem] sm:max-w-xs">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input className="pl-8" placeholder="Buscar por tema…" aria-label="Buscar por tema" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <JevHistory query={query} />
        </>
      ) : (
      <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {/* web-live#13 + web-live#16: a 390 px os 5 filtros (com "Interrompidas")
            não cabem numa linha. Em tela estreita o controle ocupa a largura e
            QUEBRA em linhas em vez de vazar ou rolar — tudo à vista, sem rolagem
            escondida; cada rótulo fica numa linha só. */}
        <SegmentedToggle
          value={filter}
          onChange={(v) => setFilter(v as 'all' | Group)}
          ariaLabel="Filtrar por status"
          className="max-w-full flex-wrap max-sm:w-full"
        >
          {FILTERS.map((f) => (
            <SegmentedToggleOption
              key={f.key}
              value={f.key}
              className="px-3 py-1.5 text-[13px] whitespace-nowrap max-sm:flex-1 max-sm:justify-center"
            >
              {f.label}
              <span className="text-[11px] opacity-70 tabular">{counts[f.key]}</span>
            </SegmentedToggleOption>
          ))}
        </SegmentedToggle>

        <div className="relative min-w-[14rem] flex-1 sm:max-w-xs sm:flex-none">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            className="pl-8"
            placeholder="Buscar por tema…"
            aria-label="Buscar por tema"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        {loading ? (
          <SkeletonResolveList loading>
            {[0, 1, 2, 3].map((i) => (
              <SkeletonResolveRow
                key={i}
                index={i}
                className="border-b border-border px-4 py-3 last:border-b-0"
                skeleton={<Skeleton className="h-6 w-full rounded-md" />}
                content={null}
              />
            ))}
          </SkeletonResolveList>
        ) : visible.length === 0 ? (
          <EmptyState>
            {items.length === 0 ? 'Nenhuma run ainda.' : 'Nenhuma run corresponde a esse filtro.'}
          </EmptyState>
        ) : (
          visible.map((it) =>
            it.kind === 'run' ? (
              <Row
                key={it.r.id}
                to={`/runs/${it.r.id}`}
                id={it.r.id}
                status={it.r.status}
                mode={modeLabel(it.r.mode)}
                theme={it.r.theme}
                meta={runMeta(it.r)}
                cost={it.r.totalCostUsd}
                at={it.r.startedAt}
              />
            ) : (
              <Row
                key={it.s.id}
                to={`/training/${it.s.id}`}
                id={it.s.id}
                status={it.s.status}
                mode="treino"
                theme={it.s.theme}
                meta={sessionMeta(it.s)}
                cost={it.s.totalCostUsd}
                at={it.s.startedAt}
              />
            ),
          )
        )}
      </div>
      </>
      )}
    </Screen>
  );
}
