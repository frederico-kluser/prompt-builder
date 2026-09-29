import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Upload } from 'lucide-react';
import { SegmentedToggle, SegmentedToggleOption } from '@/components/motion-ui/segmented-toggle';
import { SkeletonResolveList, SkeletonResolveRow, Skeleton } from '@/components/motion-ui/skeleton';
import { Button } from '@/components/ui/button';
import { Banner, EmptyState, StatusPill, Tag } from '../primitives';
import { fmtPct, fmtUsd } from '../../engine/jev';
import { importJevRecordFiles, listJevHistory, sweepJevOrphans, type JevImportResult } from '../../jev/api';
import type { JevSummary } from '../../jev/store';

/**
 * Histórico do modo JEV (aba "JEV" do Histórico): runs avulsas e sessões de
 * treino deste navegador. As runs de ciclo de um treino (com `sessionId`) não
 * entram na lista plana — abrem pela sessão. Antes de listar, varre as órfãs
 * (lock livre = a aba que executava fechou).
 */

const MODE_LABEL: Record<string, string> = { eval: 'avaliar', compare: 'comparar', train: 'treino' };
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

type Group = 'all' | 'running' | 'finished' | 'error';

function groupOf(status: string): Exclude<Group, 'all'> {
  if (status === 'running') return 'running';
  if (status === 'finished' || status === 'inconclusive') return 'finished';
  return 'error';
}

/** Resultado de "Importar do terminal": o que entrou (com link) e o que foi recusado (com o motivo). */
function ImportReport({ results, onDismiss }: { results: JevImportResult[]; onDismiss: () => void }) {
  const ok = results.filter((r) => r.ok);
  const falhas = results.filter((r) => !r.ok);
  return (
    <Banner tone={falhas.length && !ok.length ? 'error' : falhas.length ? 'warn' : 'neutral'} className="flex flex-col gap-1.5">
      <p>
        <strong>
          {ok.length} record(s) importado(s) do terminal
          {falhas.length ? `, ${falhas.length} recusado(s)` : ''}.
        </strong>{' '}
        <button type="button" className="text-primary underline-offset-4 hover:underline" onClick={onDismiss}>
          dispensar
        </button>
      </p>
      <ul className="flex flex-col gap-1 text-[13px]">
        {ok.map((r) => (
          <li key={`${r.name}-${r.id}`}>
            <Link className="text-primary underline-offset-4 hover:underline" to={r.kind === 'session' ? `/jev/training/${r.id}` : `/jev/runs/${r.id}`}>
              {r.theme || r.id}
            </Link>{' '}
            <span className="text-muted-foreground">({r.kind === 'session' ? 'treino' : 'run'} · {r.name})</span>
          </li>
        ))}
        {falhas.map((r, i) => (
          <li key={`${r.name}-${i}`}>
            <code className="font-mono">{r.name}</code>: {r.error}
          </li>
        ))}
      </ul>
    </Banner>
  );
}

export function JevHistory({ query }: { query: string }) {
  const [rows, setRows] = useState<JevSummary[] | null>(null);
  const [filter, setFilter] = useState<Group>('all');
  const [importados, setImportados] = useState<JevImportResult[] | null>(null);
  const [recarga, setRecarga] = useState(0);
  const arquivoRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let ativo = true;
    void sweepJevOrphans()
      .catch(() => undefined)
      .then(() => listJevHistory())
      .then((r) => ativo && setRows(r));
    return () => {
      ativo = false;
    };
  }, [recarga]);

  async function importar(files: FileList): Promise<void> {
    const lidos = await Promise.all([...files].map(async (f) => ({ name: f.name, text: await f.text() })));
    setImportados(await importJevRecordFiles(lidos));
    setRecarga((n) => n + 1);
  }

  const itens = useMemo(() => (rows ?? []).filter((r) => !(r.kind === 'run' && r.sessionId)), [rows]);
  const counts = useMemo(() => {
    const c = { all: itens.length, running: 0, finished: 0, error: 0 };
    for (const it of itens) c[groupOf(it.status)]++;
    return c;
  }, [itens]);
  const visiveis = useMemo(() => {
    const q = query.trim().toLowerCase();
    return itens.filter((it) => (filter === 'all' || groupOf(it.status) === filter) && (!q || it.theme.toLowerCase().includes(q)));
  }, [itens, filter, query]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Em 390px os 4 filtros não cabem: rolam dentro da própria faixa, nunca a página. */}
        <div className="scroll-slim max-w-full overflow-x-auto">
          <SegmentedToggle value={filter} onChange={(v) => setFilter(v as Group)} ariaLabel="Filtrar runs JEV por status">
            {(
              [
                ['all', 'Todas'],
                ['running', 'Em andamento'],
                ['finished', 'Concluídas'],
                ['error', 'Com erro'],
              ] as const
            ).map(([k, label]) => (
              <SegmentedToggleOption key={k} value={k} className="px-3 py-1.5 text-[13px]">
                {label}
                <span className="text-[11px] opacity-70 tabular">{counts[k]}</span>
              </SegmentedToggleOption>
            ))}
          </SegmentedToggle>
        </div>
        {/* Os dois caminhos (ver web/src/jev/transfer.ts): o que rodou no terminal abre nas mesmas telas. */}
        <Button type="button" variant="outline" size="sm" onClick={() => arquivoRef.current?.click()} title="Records de ~/.prompt-builder/jev-runs e jev-sessions, ou jev show <id> --full --json">
          <Upload aria-hidden="true" />
          Importar do terminal
        </Button>
        <input
          ref={arquivoRef}
          type="file"
          multiple
          accept="application/json,.json"
          className="hidden"
          aria-label="Records JEV do terminal (jev-run@1 / jev-session@1)"
          onChange={(e) => {
            const fs = e.target.files;
            if (fs && fs.length) void importar(fs);
            e.target.value = '';
          }}
        />
      </div>
      {importados && <ImportReport results={importados} onDismiss={() => setImportados(null)} />}
      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        {rows === null ? (
          <SkeletonResolveList loading>
            {[0, 1, 2].map((i) => (
              <SkeletonResolveRow key={i} index={i} className="border-b border-border px-4 py-3 last:border-b-0" skeleton={<Skeleton className="h-6 w-full rounded-md" />} content={null} />
            ))}
          </SkeletonResolveList>
        ) : visiveis.length === 0 ? (
          <EmptyState>
            {itens.length === 0
              ? 'Nenhuma run JEV neste navegador ainda. Rodou no terminal? «Importar do terminal» abre o record aqui.'
              : 'Nenhuma run JEV corresponde a esse filtro.'}
          </EmptyState>
        ) : (
          visiveis.map((it) => (
            <Link
              key={it.id}
              to={it.kind === 'session' ? `/jev/training/${it.id}` : `/jev/runs/${it.id}`}
              className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 last:border-b-0 hover:bg-muted/60 focus-visible:bg-muted focus-visible:outline-none sm:grid-cols-[5.5rem_7rem_1fr_auto_auto_10rem]"
            >
              <code className="font-mono text-[12px] text-muted-foreground">{it.id.slice(0, 8)}</code>
              <span className="flex items-center gap-1.5">
                <StatusPill status={it.status} />
              </span>
              <span className="col-span-3 min-w-0 truncate text-sm sm:col-span-1" title={it.theme}>
                {it.theme}
              </span>
              <span className="hidden items-center gap-1.5 sm:flex">
                <Tag>JEV · {MODE_LABEL[it.mode] ?? it.mode}</Tag>
              </span>
              <span className="hidden shrink-0 text-right text-[12px] text-muted-foreground tabular sm:block">
                {it.kind === 'session'
                  ? `${it.iterationsDone ?? 0}/${it.iterationsPlanned ?? 0} ciclos`
                  : `${it.cases} casos${it.accuracy !== null && it.accuracy !== undefined ? ` · ${fmtPct(it.accuracy)}` : ''}`}
              </span>
              <span className="hidden shrink-0 text-right text-[12px] text-muted-foreground tabular md:block">
                {fmtUsd(it.totalCostUsd)} · {formatDate(it.startedAt)}
              </span>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
