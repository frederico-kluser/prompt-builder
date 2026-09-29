import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Download, Search, Upload } from 'lucide-react';
import type { RunMode, RunSummary, SessionSummary } from '../api';
import { fetchRuns, fetchSessions } from '../api';
import { SegmentedToggle, SegmentedToggleOption } from '@/components/motion-ui/segmented-toggle';
import { SkeletonResolveList, SkeletonResolveRow, Skeleton } from '@/components/motion-ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Banner, EmptyState, PageHeader, Screen, StatusPill, Tag } from '../components/primitives';
import { StorageNotice } from '../components/StorageNotice';
import {
  historyExchangeJson,
  importRecordFiles,
  isRecordImportError,
  type RecordImportResult,
} from '../recordExchange';

// left#15: o histórico JEV (e o motor JEV que ele puxa) só baixa quando a aba
// "JEV (decisões)" é aberta.
const JevHistory = lazy(async () => ({ default: (await import('../components/jev/JevHistory')).JevHistory }));

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

function baixar(nome: string, texto: string): void {
  const url = URL.createObjectURL(new Blob([texto], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Arquivo = { name: string; text: string };
type ImportState =
  | { kind: 'ok'; result: RecordImportResult }
  | { kind: 'conflict'; message: string; ids: string[]; files: Arquivo[] }
  | { kind: 'error'; message: string };

const plural = (n: number, um: string, varios: string): string => `${n} ${n === 1 ? um : varios}`;

/** Resumo do que entrou (e do que o pacote declara ter perdido NA ORIGEM). */
function ImportOk({ result: r }: { result: RecordImportResult }) {
  const partes = [
    r.imported.runs.length ? plural(r.imported.runs.length, 'run', 'runs') : '',
    r.imported.sessions.length ? plural(r.imported.sessions.length, 'treino', 'treinos') : '',
  ].filter(Boolean);
  const perdidos = Object.entries(r.lostFields).filter(([, campos]) => campos && campos.length > 0);
  const abrir = r.imported.sessions[0]
    ? { to: `/training/${r.imported.sessions[0]}`, label: 'Abrir o treino' }
    : r.imported.runs.length === 1
      ? { to: `/runs/${r.imported.runs[0]}`, label: 'Abrir a run' }
      : null;
  return (
    <>
      <strong>{partes.length ? `Importado: ${partes.join(' e ')}.` : 'Nada novo para importar.'}</strong>
      {r.skipped.length > 0 && <> {plural(r.skipped.length, 'registro idêntico pulado', 'registros idênticos pulados')}.</>}
      {r.overwritten.length > 0 && <> {plural(r.overwritten.length, 'registro substituído', 'registros substituídos')}.</>}
      {r.failed.length > 0 && <> {plural(r.failed.length, 'registro não coube', 'registros não couberam')} no armazenamento do navegador.</>}
      {perdidos.length > 0 && (
        <> O pacote declara campos perdidos na origem: {perdidos.map(([k, c]) => `${k}: ${c!.join(', ')}`).join(' · ')}.</>
      )}
      {r.libraryItemsIgnored > 0 && (
        <>
          {' '}
          {plural(r.libraryItemsIgnored, 'item', 'itens')} de biblioteca de cenários ficaram de fora (ela mora no terminal:{' '}
          <code className="font-mono text-[12px]">prompt-builder library add &lt;arquivo&gt;</code>).
        </>
      )}
      {abrir && (
        <>
          {' '}
          <Link to={abrir.to} className="font-medium text-primary underline-offset-2 hover:underline">
            {abrir.label}
          </Link>
        </>
      )}
    </>
  );
}

/**
 * left#11 (IMPL-089): troca com o terminal em `prompt-builder-exchange@1` —
 * «Importar» aceita o pacote do CLI (`runs|sessions export`, arquivo único ou
 * o diretório inteiro) e os JSON antigos; «Exportar histórico» baixa as runs e
 * os treinos DESTE navegador no mesmo formato (backup antes de apagar/do TTL).
 */
function HistoryTransfer({ onImported }: { onImported: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [estado, setEstado] = useState<ImportState | null>(null);
  const [ocupado, setOcupado] = useState(false);

  async function importar(files: Arquivo[], overwrite = false) {
    setOcupado(true);
    try {
      const result = await importRecordFiles(files, { overwrite });
      setEstado({ kind: 'ok', result });
      onImported();
    } catch (err) {
      if (isRecordImportError(err) && err.conflicts.length > 0) {
        setEstado({ kind: 'conflict', message: err.message, ids: err.conflicts.map((c) => c.id), files });
      } else {
        setEstado({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setOcupado(false);
    }
  }

  async function exportar() {
    setOcupado(true);
    try {
      const { json, runs, sessions } = await historyExchangeJson();
      if (runs + sessions === 0) {
        setEstado({ kind: 'error', message: 'Nada para exportar: não há runs nem treinos salvos neste navegador.' });
        return;
      }
      baixar(`prompt-builder-historico-${new Date().toISOString().slice(0, 10)}.json`, json);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="mb-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={ocupado}
          onClick={() => ref.current?.click()}
          title="Pacote prompt-builder-exchange@1 (runs export --format exchange / sessions export) ou o JSON de uma run"
        >
          <Upload aria-hidden="true" />
          Importar
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={ocupado} onClick={() => void exportar()}>
          <Download aria-hidden="true" />
          Exportar histórico
        </Button>
        <input
          ref={ref}
          type="file"
          multiple
          accept="application/json,.json,.jsonl"
          className="hidden"
          aria-label="Pacote exchange@1 ou JSON de run/treino"
          onChange={(e) => {
            const fs = e.target.files ? [...e.target.files] : [];
            e.target.value = '';
            if (fs.length) void Promise.all(fs.map(async (f) => ({ name: f.name, text: await f.text() }))).then((lidos) => importar(lidos));
          }}
        />
      </div>
      {estado?.kind === 'ok' && (
        <Banner tone="neutral">
          <ImportOk result={estado.result} />
        </Banner>
      )}
      {estado?.kind === 'error' && <Banner tone="error">{estado.message}</Banner>}
      {estado?.kind === 'conflict' && (
        <Banner tone="warn" alert>
          <strong>{estado.message}</strong>{' '}
          {estado.ids.slice(0, 5).map((id) => (
            <code key={id} className="mr-1 font-mono text-[12px]">
              {id.slice(0, 8)}
            </code>
          ))}
          {estado.ids.length > 5 && <>+{estado.ids.length - 5}</>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={ocupado} onClick={() => void importar(estado.files, true)}>
              Substituir pelos do arquivo
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setEstado(null)}>
              Cancelar
            </Button>
          </div>
        </Banner>
      )}
    </div>
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
  // Recarrega a lista depois de um import (left#11).
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    Promise.all([fetchRuns(), fetchSessions().catch(() => [] as SessionSummary[])])
      .then(([r, s]) => {
        setRuns(r);
        setSessions(s);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [recarga]);

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
          <Suspense fallback={<Skeleton className="h-40 w-full rounded-xl" />}>
            <JevHistory query={query} />
          </Suspense>
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

      <HistoryTransfer onImported={() => setRecarga((n) => n + 1)} />

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
