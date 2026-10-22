import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Eye, Flame, Trophy } from 'lucide-react';
import { Skeleton } from '@/components/motion-ui/skeleton';
import { Button } from '@/components/ui/button';
import { VisionPreview } from '../components/vision/VisionPreview';
import { Banner, Chip, EmptyState, PageHeader, Screen, SectionHead, StatusPill, Tag } from '../components/primitives';
import type { VisionDataset, VisionRunRecord, VisionScene } from '../engine/vision';
import { loadVisionDataset } from '../vision/dataset';
import { loadVisionRun } from '../vision/store';
import {
  BAND_CLASS,
  BAND_LABEL,
  buildOverlay,
  elementName,
  fmtPct,
  fmtUsd,
  sceneModelView,
  scenesOfRun,
  scoreBand,
  winnerOf,
} from '../vision/view';
import { cn } from '@/lib/utils';

const FAMILY_LABEL: Record<string, string> = {
  bootstrap: 'Bootstrap',
  react95: 'React95',
  fluent: 'Fluent UI',
  material: 'Material 3',
  macos: 'macOS',
};

function shortModel(id: string): string {
  const i = id.lastIndexOf('/');
  return i >= 0 ? id.slice(i + 1) : id;
}

function baixarJson(rec: VisionRunRecord): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${rec.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * `/vision/runs/:id` — RESULTADO da run de visão.
 *
 * Placar por modelo + matriz cenário × modelo. Passar o mouse (ou focar) uma
 * célula mostra a TELA DO CENÁRIO com o mapa de calor DAQUELE modelo: halo
 * verde/vermelho nas previsões, caixas dos controles não vistos e alvos das
 * ações. O número acompanha a cor em todo lugar (cor nunca é o único canal).
 */
export function VisionRunPage() {
  const { id } = useParams<{ id: string }>();
  const [record, setRecord] = useState<VisionRunRecord | null | undefined>(undefined);
  const [dataset, setDataset] = useState<VisionDataset | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [sel, setSel] = useState<{ sceneId: string; modelId: string } | null>(null);
  const [modo, setModo] = useState<'previsoes' | 'verdade'>('previsoes');

  useEffect(() => {
    let vivo = true;
    if (!id) {
      setRecord(null);
      return;
    }
    Promise.all([loadVisionRun(id), loadVisionDataset()])
      .then(([rec, ds]) => {
        if (!vivo) return;
        setRecord(rec);
        setDataset(ds.dataset);
      })
      .catch((err: unknown) => vivo && setErro(err instanceof Error ? err.message : String(err)));
    return () => {
      vivo = false;
    };
  }, [id]);

  const cenas = useMemo(() => (record && dataset ? scenesOfRun(record, dataset) : []), [record, dataset]);
  const vencedor = useMemo(() => (record ? winnerOf(record) : null), [record]);
  const modelos = useMemo(() => record?.contestants.map((c) => c.modelId) ?? [], [record]);
  const selecionada = useMemo(() => {
    const sceneId = sel?.sceneId ?? cenas[0]?.id ?? null;
    const modelId = sel?.modelId ?? vencedor?.modelId ?? modelos[0] ?? null;
    const scene = cenas.find((s) => s.id === sceneId) ?? null;
    return scene && modelId ? { scene, modelId } : null;
  }, [sel, cenas, vencedor, modelos]);

  const view = useMemo(
    () => (record && selecionada ? sceneModelView(record, selecionada.scene.id, selecionada.modelId) : null),
    [record, selecionada],
  );
  const overlay = useMemo(
    () => (selecionada && view ? buildOverlay(selecionada.scene, view) : null),
    [selecionada, view],
  );

  if (record === undefined) {
    return (
      <Screen wide>
        <Skeleton className="h-10 w-2/3 rounded-lg" />
        <Skeleton className="mt-4 h-64 w-full rounded-xl" />
      </Screen>
    );
  }
  if (!record) {
    return (
      <Screen wide>
        <PageHeader title="Run de visão não encontrada" />
        <EmptyState>
          Este navegador não tem a run <code className="font-mono">{id}</code>. Ela pode ter sido apagada ou rodado em outra
          máquina. <Link className="text-primary underline-offset-4 hover:underline" to="/vision">Rodar de novo</Link>.
        </EmptyState>
      </Screen>
    );
  }

  const parciais = record.budget?.exhausted || record.totals.skipped > 0;
  const comErro = record.totals.errors > 0;

  return (
    <Screen wide>
      <PageHeader
        title="Resultado da visão"
        subtitle={
          <>
            Dataset <code className="font-mono">vision-dataset@{record.dataset.version}</code> ·{' '}
            <code className="font-mono">{record.dataset.hash.slice(0, 16)}…</code> · prompt{' '}
            <code className="font-mono">{record.promptVersion}</code> · {record.config.tasks.join(' + ')} ·{' '}
            {record.config.coordSpace === 'pixels' ? 'pixels' : 'normalizado 0–1000'}
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => baixarJson(record)}>
              <Download aria-hidden="true" /> JSON
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Eye aria-hidden="true" /> Imprimir
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
        <StatusPill status={record.status} />
        <span>{record.contestants.length} modelo(s)</span>
        <span>·</span>
        <span>{record.dataset.scenes.length} cenário(s)</span>
        <span>·</span>
        <span>{record.totals.calls} chamada(s)</span>
        <span>·</span>
        <span className="tabular-nums">{fmtUsd(record.totals.costUsd)}</span>
        <span>·</span>
        <span>{new Date(record.startedAt).toLocaleString('pt-BR')}</span>
        <Link to="/vision" className="ml-auto inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">
          <ArrowLeft className="size-3.5" aria-hidden="true" /> Nova run de visão
        </Link>
      </div>

      {parciais && (
        <Banner tone="warn" className="mb-3">
          <strong>Placar parcial:</strong> {record.totals.skipped} célula(s) ficaram fora por orçamento/cancelamento.
          {record.budget?.exhausted ? ' A run parou no teto de gasto.' : ''}
        </Banner>
      )}
      {comErro && (
        <Banner tone="warn" className="mb-3">
          {record.totals.errors} chamada(s) falharam e contam como resposta errada no denominador.
        </Banner>
      )}
      {erro && <Banner tone="error">{erro}</Banner>}

      {vencedor && (
        <>
          <SectionHead status={`${fmtPct(vencedor.score)} de nota`}>Vencedor</SectionHead>
          <div className="flex flex-wrap items-stretch gap-3">
            <div className="min-w-0 basis-full flex-1 rounded-xl border border-primary/30 bg-primary/5 p-4 sm:basis-auto">
              <div className="flex flex-wrap items-center gap-2">
                <Trophy className="size-4 text-primary" aria-hidden="true" />
                <span className="text-[11px] font-semibold tracking-[0.08em] text-primary uppercase">melhor nota</span>
                <Tag className="ml-auto">1º</Tag>
              </div>
              <p className="mt-1 truncate font-heading text-xl font-medium" title={vencedor.modelId}>
                {shortModel(vencedor.modelId)}
              </p>
              <p className="truncate text-[11.5px] text-muted-foreground">{vencedor.modelId}</p>
              <dl className="mt-3 grid grid-cols-3 gap-2 text-[12px]">
                <div>
                  <dt className="text-muted-foreground">Mapa F1</dt>
                  <dd className="font-medium tabular-nums">{fmtPct(vencedor.map?.f1 ?? null)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Ação</dt>
                  <dd className="font-medium tabular-nums">{fmtPct(vencedor.action?.passRate ?? null)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Custo</dt>
                  <dd className="font-medium tabular-nums">{fmtUsd(vencedor.costUsd)}</dd>
                </div>
              </dl>
            </div>
            {record.contestants
              .filter((c) => c.modelId !== vencedor.modelId)
              .map((c) => (
                <div key={c.modelId} className="min-w-0 basis-full flex-1 rounded-xl border border-border bg-card p-4 sm:basis-[12rem]">
                  <p className="truncate text-sm font-medium" title={c.modelId}>
                    {shortModel(c.modelId)}
                  </p>
                  <p className="text-[11.5px] text-muted-foreground">nota {fmtPct(c.score)}</p>
                  <dl className="mt-2 grid grid-cols-2 gap-2 text-[12px]">
                    <div>
                      <dt className="text-muted-foreground">Mapa F1</dt>
                      <dd className="tabular-nums">{fmtPct(c.map?.f1 ?? null)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Ação</dt>
                      <dd className="tabular-nums">{fmtPct(c.action?.passRate ?? null)}</dd>
                    </div>
                  </dl>
                </div>
              ))}
          </div>
        </>
      )}

      <SectionHead
        status={
          <span className="inline-flex items-center gap-1">
            <Flame className="size-3.5" aria-hidden="true" /> passe o mouse/foco numa célula
          </span>
        }
      >
        Cenário × modelo
      </SectionHead>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <div className="min-w-0">
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full border-collapse text-[12.5px]">
              <caption className="sr-only">
                Nota por cenário e modelo. Cada célula abre o mapa de calor daquele modelo no cenário.
              </caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium">
                    Cenário
                  </th>
                  {modelos.map((m) => (
                    <th key={m} scope="col" className="px-2 py-2 text-center font-medium">
                      <span className="block max-w-[9rem] truncate" title={m}>
                        {shortModel(m)}
                      </span>
                      {m === vencedor?.modelId && <span className="text-[10px] font-semibold text-primary">1º</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cenas.map((scene) => (
                  <tr key={scene.id} className="border-b border-border last:border-0">
                    <th scope="row" className="sticky left-0 z-10 max-w-[15rem] bg-card px-3 py-2 text-left font-normal">
                      <span className="block truncate" title={scene.title}>
                        {scene.title}
                      </span>
                      <span className="text-[10.5px] text-muted-foreground">{FAMILY_LABEL[scene.family] ?? scene.family}</span>
                    </th>
                    {modelos.map((modelId) => {
                      const v = sceneModelView(record, scene.id, modelId);
                      const band = scoreBand(v.combined);
                      const ativo = selecionada?.scene.id === scene.id && selecionada?.modelId === modelId;
                      return (
                        <td key={modelId} className="p-1 align-middle">
                          <button
                            type="button"
                            onMouseEnter={() => setSel({ sceneId: scene.id, modelId })}
                            onFocus={() => setSel({ sceneId: scene.id, modelId })}
                            onClick={() => setSel({ sceneId: scene.id, modelId })}
                            aria-pressed={ativo}
                            aria-label={`${scene.title}, ${modelId}: nota ${fmtPct(v.combined)}; mapa ${fmtPct(v.mapF1)}; ação ${fmtPct(v.actionPass)}`}
                            className={cn(
                              'mx-auto flex min-h-11 w-full min-w-[6.5rem] flex-col items-center justify-center rounded-lg border px-2 py-1.5 text-center transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                              band ? BAND_CLASS[band] : 'border-border bg-muted text-muted-foreground',
                              ativo && 'ring-2 ring-ring/70',
                            )}
                          >
                            <span className="text-[13px] font-semibold tabular-nums">{fmtPct(v.combined)}</span>
                            <span className="text-[10.5px] tabular-nums opacity-80">
                              mapa {fmtPct(v.mapF1)} · ação {fmtPct(v.actionPass)}
                            </span>
                            {v.skipped > 0 && <span className="text-[10px] opacity-80">{v.skipped} pulada(s)</span>}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground sm:hidden">
            Deslize a tabela para ver os outros modelos.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11.5px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm border border-resolve/30 bg-resolve-soft" aria-hidden="true" /> forte ≥ 75%
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm border border-parcial/30 bg-parcial-soft" aria-hidden="true" /> médio 50–75%
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm border border-nao/30 bg-nao-soft" aria-hidden="true" /> fraco &lt; 50%
            </span>
            <span className="ml-auto">Nota = média das notas disponíveis (mapa F1, ação pass).</span>
          </div>
        </div>

        <aside className="min-w-0 lg:sticky lg:top-24" aria-label="Detalhe do cenário e modelo selecionados">
          {selecionada && view ? (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{selecionada.scene.title}</h2>
                <Tag>{FAMILY_LABEL[selecionada.scene.family] ?? selecionada.scene.family}</Tag>
                <span className="max-w-[11rem] truncate text-[11.5px] text-muted-foreground" title={selecionada.modelId}>
                  {shortModel(selecionada.modelId)}
                </span>
              </div>
              <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="Camada do overlay">
                <Chip on={modo === 'previsoes'} label="Mapa de calor" onClick={() => setModo('previsoes')} index={0} />
                <Chip on={modo === 'verdade'} label="Só a verdade" onClick={() => setModo('verdade')} index={1} />
              </div>
              <VisionPreview
                scene={selecionada.scene}
                overlay={modo === 'previsoes' ? overlay : null}
                mode={modo === 'previsoes' ? 'predictions' : 'truth'}
              />
              <div className="mt-3 grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4">
                <div className="rounded-lg border border-border bg-card px-2.5 py-2">
                  <p className="text-[10.5px] text-muted-foreground">Mapa F1</p>
                  <p className="font-medium tabular-nums">{fmtPct(view.mapF1)}</p>
                </div>
                <div className="rounded-lg border border-border bg-card px-2.5 py-2">
                  <p className="text-[10.5px] text-muted-foreground">Precisão</p>
                  <p className="font-medium tabular-nums">{fmtPct(view.mapPrecision)}</p>
                </div>
                <div className="rounded-lg border border-border bg-card px-2.5 py-2">
                  <p className="text-[10.5px] text-muted-foreground">Recall</p>
                  <p className="font-medium tabular-nums">{fmtPct(view.mapRecall)}</p>
                </div>
                <div className="rounded-lg border border-border bg-card px-2.5 py-2">
                  <p className="text-[10.5px] text-muted-foreground">Ação</p>
                  <p className="font-medium tabular-nums">{fmtPct(view.actionPass)}</p>
                </div>
              </div>
              <p className="mt-2 text-[11.5px] text-muted-foreground tabular-nums">
                {view.mapMatched} de {view.mapElements} controles casados · {view.mapLabeled} com rótulo reconhecido ·{' '}
                {overlay?.missed.length ?? 0} não visto(s)
              </p>

              {overlay && overlay.missed.length > 0 && (
                <details className="mt-3 rounded-lg border border-border bg-card px-3 py-2 text-[12px]" open>
                  <summary className="cursor-pointer font-medium">Controles não vistos ({overlay.missed.length})</summary>
                  <ul className="mt-2 space-y-1">
                    {overlay.missed.slice(0, 8).map((m) => (
                      <li key={m.id} className="flex items-center gap-2">
                        <span className="size-2 rounded-sm bg-nao" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{elementName(m)}</span>
                        <span className="text-[10.5px] text-muted-foreground">{m.type}</span>
                      </li>
                    ))}
                    {overlay.missed.length > 8 && (
                      <li className="text-[11px] text-muted-foreground">+{overlay.missed.length - 8}</li>
                    )}
                  </ul>
                </details>
              )}

              {overlay && overlay.actions.length > 0 && (
                <div className="mt-3 rounded-lg border border-border bg-card px-3 py-2 text-[12px]">
                  <p className="font-medium">Ações ({overlay.actions.filter((a) => a.pass).length}/{overlay.actions.length} passaram)</p>
                  <ul className="mt-2 space-y-2">
                    {overlay.actions.map((a, i) => (
                      <li key={a.taskId} className="flex gap-2">
                        <span
                          className={cn(
                            'mt-0.5 inline-grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold tabular-nums',
                            a.pass ? 'bg-resolve-soft text-resolve' : 'bg-nao-soft text-nao',
                          )}
                          aria-label={a.pass ? 'passou' : 'falhou'}
                        >
                          {i + 1}
                        </span>
                        <span className="min-w-0">
                          <span className="block">{a.instruction}</span>
                          <span className="block text-[11px] text-muted-foreground">
                            esperado <strong>{a.expectedAction}</strong>
                            {a.predictedAction ? <> · previsto <strong>{a.predictedAction}</strong></> : ' · sem previsão'}
                            {a.targetHit !== null && <> · alvo {a.targetHit ? 'acertou' : 'errou'}</>}
                            {a.textOk !== null && <> · texto {a.textOk ? 'ok' : 'diferente'}</>}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <p className="mt-2 text-[11px] text-muted-foreground">
                Verde = ponto dentro da caixa; vermelho = ponto fora ou controle não visto; azul = alvo da ação. O número
                acompanha sempre — cor não é o único canal.
              </p>
            </>
          ) : (
            <EmptyState>Selecione uma célula da matriz para ver o cenário.</EmptyState>
          )}
        </aside>
      </div>

      <SectionHead>Metodologia</SectionHead>
      <p className="max-w-prose text-[12.5px] text-muted-foreground">
        A verdade é o DOM do cenário (caixa de cada controle em pixels de 1920×1080). No mapa, uma previsão casa quando o
        ponto cai DENTRO da caixa — casamento um-para-um, guloso, por qualidade (rótulo &gt; tipo &gt; proximidade). No
        modo ação, a tarefa passa quando a ação declarada é a esperada, o ponto cai na caixa do alvo (quando há alvo) e o
        texto confere (quando há texto). Erro de chamada conta como resposta errada; célula pulada por orçamento fica fora
        das métricas. Nenhuma técnica de grade/zoom/Set-of-Mark nesta versão — o roadmap cobre as variantes.
      </p>
    </Screen>
  );
}
