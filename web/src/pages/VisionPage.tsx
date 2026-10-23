import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Crosshair, Play, RotateCcw, Square } from 'lucide-react';
import { ProgressBar } from '@/components/motion-ui/progress-bar';
import { Skeleton } from '@/components/motion-ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToasts } from '../components/AppShell';
import { ModelSelector } from '../components/ModelSelector';
import { VisionPreview } from '../components/vision/VisionPreview';
import { Banner, Chip, EmptyState, PageHeader, Screen, SectionHead, StatusPill, Tag } from '../components/primitives';
import { fetchModels, isKeyMissing, type OpenRouterModel } from '../api';
import {
  VISION_FAMILIES,
  modelsWithoutImageInput,
  selectScenes,
  type VisionCell,
  type VisionDataset,
  type VisionFamily,
  type VisionRunConfig,
  type VisionTaskKind,
} from '../engine/vision';
import { loadVisionDataset, VisionDatasetLoadError } from '../vision/dataset';
import {
  estimateVisionRun,
  runVisionInBrowser,
  selectionCounts,
  VisionNoKeyError,
  type VisionEstimate,
} from '../vision/api';
import { listVisionSummaries, type VisionSummary } from '../vision/store';
import { fmtPct, fmtUsd } from '../vision/view';
import { cn } from '@/lib/utils';

const FAMILY_LABEL: Record<VisionFamily, string> = {
  bootstrap: 'Bootstrap',
  react95: 'React95',
  fluent: 'Fluent UI',
  material: 'Material 3',
  macos: 'macOS',
};

const QUICK_COUNTS = [3, 5, 10] as const;

function dataCurta(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * `/vision` — o BENCHMARK DE VISÃO na SPA.
 *
 * Três passos numa tela: escolher quantos cenários puxar do banco, o que medir
 * (mapa/ação) e com quais modelos + teto. A run roda NA ABA (mesmo motor do
 * CLI) e o progresso mostra o cenário a cenário; passar o mouse/focar um
 * cenário mostra a TELA DO TESTE com a verdade do DOM. O resultado abre em
 * `/vision/runs/:id`.
 */
export function VisionPage() {
  const navigate = useNavigate();
  const { notify } = useToasts();
  const [dados, setDados] = useState<{ dataset: VisionDataset; hash: string } | null>(null);
  const [erroDataset, setErroDataset] = useState<string | null>(null);
  const [catalogo, setCatalogo] = useState<OpenRouterModel[] | null>(null);
  const [erroCatalogo, setErroCatalogo] = useState<string | null>(null);
  const [modelos, setModelos] = useState<string[]>([]);
  const [familias, setFamilias] = useState<VisionFamily[]>([]);
  const [quantos, setQuantos] = useState(3);
  const [mapa, setMapa] = useState(true);
  const [acao, setAcao] = useState(true);
  const [teto, setTeto] = useState('1.00');
  const [coordSpace, setCoordSpace] = useState<'pixels' | 'normalized'>('pixels');
  const [maxTokens, setMaxTokens] = useState('4096');
  const [temperatura, setTemperatura] = useState('0');
  const [avancado, setAvancado] = useState(false);
  const [fase, setFase] = useState<'setup' | 'rodando'>('setup');
  const [vivas, setVivas] = useState<ReadonlyMap<string, VisionCell>>(new Map());
  const [totalCelulas, setTotalCelulas] = useState(0);
  const [erroRun, setErroRun] = useState<string | null>(null);
  const [historico, setHistorico] = useState<VisionSummary[] | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let vivo = true;
    loadVisionDataset()
      .then((d) => vivo && setDados(d))
      .catch((err: unknown) => vivo && setErroDataset(err instanceof VisionDatasetLoadError ? err.message : String(err)));
    return () => {
      vivo = false;
    };
  }, []);

  useEffect(() => {
    let vivo = true;
    fetchModels()
      .then((m) => vivo && setCatalogo(m))
      .catch((err: unknown) => {
        if (vivo) setErroCatalogo(err instanceof Error ? err.message : String(err));
      });
    return () => {
      vivo = false;
    };
  }, []);

  const recarregarHistorico = useCallback(() => {
    listVisionSummaries()
      .then(setHistorico)
      .catch(() => setHistorico([]));
  }, []);
  useEffect(recarregarHistorico, [recarregarHistorico]);

  const dataset = dados?.dataset ?? null;
  const cenasDisponiveis = useMemo(
    () => (dataset ? selectScenes(dataset, { families: familias.length > 0 ? familias : null }).scenes : []),
    [dataset, familias],
  );
  const maxCenas = cenasDisponiveis.length;
  const tarefas = useMemo<VisionTaskKind[]>(() => [...(mapa ? (['map'] as const) : []), ...(acao ? (['action'] as const) : [])], [mapa, acao]);

  useEffect(() => {
    if (maxCenas > 0) setQuantos((n) => Math.min(Math.max(1, n), maxCenas));
  }, [maxCenas]);

  const config = useMemo<VisionRunConfig | null>(() => {
    const n = Math.max(1, Math.min(quantos, maxCenas || 1));
    const tetoNum = Number(teto);
    if (!dataset || tarefas.length === 0 || modelos.length === 0 || !(tetoNum > 0)) return null;
    return {
      models: modelos,
      tasks: tarefas,
      families: familias.length > 0 ? familias : null,
      scenes: null,
      limit: n,
      coordSpace,
      temperature: Number(temperatura) || 0,
      maxTokens: Math.round(Number(maxTokens)) || 4096,
      retries: 0,
      budgetUsd: tetoNum,
    };
  }, [dataset, tarefas, modelos, familias, quantos, maxCenas, coordSpace, temperatura, maxTokens, teto]);

  const estimativa: VisionEstimate | null = useMemo(
    () => (dataset && catalogo && config ? estimateVisionRun(dataset, config, catalogo) : null),
    [dataset, catalogo, config],
  );

  const semVisao = useMemo(
    () => (catalogo ? modelsWithoutImageInput(modelos, catalogo) : []),
    [catalogo, modelos],
  );

  // A prévia NÃO depende de ter modelo/teto escolhido: o banco já está lá.
  const cenasDaRun = useMemo(
    () =>
      dataset
        ? selectScenes(dataset, {
            families: familias.length > 0 ? familias : null,
            limit: Math.max(1, Math.min(quantos, maxCenas || 1)),
          }).scenes
        : [],
    [dataset, familias, quantos, maxCenas],
  );

  const preview = useMemo(() => {
    const id = previewId ?? cenasDaRun[0]?.id ?? null;
    return cenasDaRun.find((s) => s.id === id) ?? cenasDaRun[0] ?? null;
  }, [previewId, cenasDaRun]);

  const feitas = vivas.size;
  const progresso = totalCelulas > 0 ? Math.min(1, feitas / totalCelulas) : 0;

  function statusDaCena(sceneId: string): { done: number; total: number; erro: number } {
    const cells = [...vivas.values()].filter((c) => c.sceneId === sceneId);
    const porModelo = (mapa ? 1 : 0) + (acao ? (dataset?.scenes.find((s) => s.id === sceneId)?.tasks.length ?? 0) : 0);
    return {
      done: cells.length,
      total: porModelo * Math.max(1, modelos.length),
      erro: cells.filter((c) => c.status !== 'ok').length,
    };
  }

  async function iniciar() {
    if (!dataset || !config) return;
    if (!catalogo) {
      notify('O catálogo de modelos ainda não carregou.', 'error');
      return;
    }
    if (semVisao.length > 0) {
      notify(`Sem entrada de imagem: ${semVisao.join(', ')}.`, 'error');
      return;
    }
    const ac = new AbortController();
    abortRef.current = ac;
    const counts = selectionCounts(dataset, config.families, config.limit, config.tasks);
    setTotalCelulas((counts.scenes * (mapa ? 1 : 0) + counts.actionTasks) * modelos.length);
    setVivas(new Map());
    setErroRun(null);
    setFase('rodando');
    try {
      const { record, saved } = await runVisionInBrowser({
        dataset,
        config,
        models: catalogo,
        signal: ac.signal,
        onCell: (cell) => setVivas((prev) => new Map(prev).set(cell.cellId, cell)),
      });
      if (!saved) notify('A run terminou, mas o navegador não conseguiu salvar no histórico.', 'error');
      recarregarHistorico();
      navigate(`/vision/runs/${record.id}`);
    } catch (err) {
      if (isKeyMissing(err) || err instanceof VisionNoKeyError) {
        setErroRun('Sua chave da OpenRouter sumiu desta sessão. Conecte de novo para rodar.');
      } else {
        setErroRun(err instanceof Error ? err.message : String(err));
      }
      setFase('setup');
    } finally {
      abortRef.current = null;
    }
  }

  function cancelar() {
    abortRef.current?.abort('cancelado pelo usuário');
  }

  const podeIniciar = Boolean(config) && modelos.length > 0 && tarefas.length > 0 && semVisao.length === 0;

  return (
    <Screen wide>
      <PageHeader
        title="Visão — o que é clicável nesta tela?"
        subtitle={
          <>
            O modelo lê uma captura 1080p e devolve os elementos interativos (<strong>mapa</strong>) e/ou a ação pedida
            (<strong>ação</strong>). A verdade vem do DOM do cenário: o placar é determinístico, sem juiz LLM.
          </>
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => recarregarHistorico()} title="Recarregar o histórico de runs">
            <RotateCcw aria-hidden="true" /> Atualizar
          </Button>
        }
      />

      {erroDataset && (
        <Banner tone="error" alert>
          <strong>Dataset de visão indisponível.</strong> {erroDataset}
        </Banner>
      )}
      {erroRun && (
        <Banner tone="error" alert className="mt-3">
          {erroRun}
        </Banner>
      )}

      {!dataset && !erroDataset && (
        <div className="grid gap-4 lg:grid-cols-2" aria-busy="true" aria-label="Carregando o dataset">
          <Skeleton className="h-72 w-full rounded-xl" />
          <Skeleton className="h-72 w-full rounded-xl" />
        </div>
      )}

      {dataset && fase === 'setup' && (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)]">
          <div className="min-w-0">
            <SectionHead status={`${dataset.scenes.length} cenários · ${dataset.scenes.reduce((a, s) => a + s.elements.length, 0)} controles`}>
              Banco de cenários
            </SectionHead>
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-[13px] text-muted-foreground">
                Dataset <code className="font-mono">vision-dataset@{dataset.version}</code> · hash{' '}
                <code className="font-mono">{dados?.hash.slice(0, 16)}…</code> · imagens 1920×1080 pinadas por sha256.
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Filtrar famílias">
                <Chip on={familias.length === 0} label="Todas" onClick={() => setFamilias([])} index={0} />
                {VISION_FAMILIES.map((f, i) => (
                  <Chip
                    key={f}
                    on={familias.includes(f)}
                    label={FAMILY_LABEL[f]}
                    index={i + 1}
                    onClick={() =>
                      setFamilias((atual) => (atual.includes(f) ? atual.filter((x) => x !== f) : [...atual, f]))
                    }
                  />
                ))}
              </div>
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <div className="min-w-0">
                  <Label htmlFor="vision-quantos">Quantos cenários puxar do banco</Label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Input
                      id="vision-quantos"
                      type="number"
                      min={1}
                      max={Math.max(1, maxCenas)}
                      value={quantos}
                      onChange={(e) => setQuantos(Math.max(1, Math.min(maxCenas || 1, Number(e.target.value) || 1)))}
                      className="w-20 tabular-nums"
                    />
                    <span className="text-[12.5px] text-muted-foreground">de {maxCenas} disponíveis</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 pb-0.5" role="group" aria-label="Atalhos de quantidade">
                  {QUICK_COUNTS.filter((n) => n < maxCenas).map((n) => (
                    <Chip key={n} on={quantos === n} label={`${n}`} onClick={() => setQuantos(n)} />
                  ))}
                  <Chip on={quantos === maxCenas} label="Todos" onClick={() => setQuantos(Math.max(1, maxCenas))} />
                </div>
              </div>
              <p className="mt-3 text-[12px] text-muted-foreground">
                A seleção é determinística (ordem do manifesto) — o mesmo recorte sempre puxa os mesmos cenários.
              </p>
            </div>

            <SectionHead>O que medir</SectionHead>
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Modos do benchmark">
                <Chip on={mapa} label="Mapa · todos os clicáveis" onClick={() => setMapa((v) => !v)} index={0} />
                <Chip on={acao} label="Ação · o que clicar" onClick={() => setAcao((v) => !v)} index={1} />
              </div>
              <p className="mt-2 text-[12.5px] text-muted-foreground">
                {mapa && acao
                  ? 'Os dois modos: lista completa + intenção por tarefa.'
                  : mapa
                    ? 'Só o mapa: todos os controles com posição.'
                    : 'Só a ação: o pedido de cada tarefa e a posição do alvo.'}
              </p>
              <button
                type="button"
                className="mt-3 text-[12.5px] font-medium text-primary underline-offset-4 hover:underline"
                aria-expanded={avancado}
                onClick={() => setAvancado((v) => !v)}
              >
                {avancado ? 'Ocultar ajustes' : 'Ajustes avançados'}
              </button>
              {avancado && (
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <div>
                    <Label htmlFor="vision-coord">Coordenadas</Label>
                    <select
                      id="vision-coord"
                      className="mt-1.5 h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm"
                      value={coordSpace}
                      onChange={(e) => setCoordSpace(e.target.value === 'normalized' ? 'normalized' : 'pixels')}
                    >
                      <option value="pixels">pixels (1920×1080)</option>
                      <option value="normalized">normalizado (0–1000)</option>
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="vision-temp">Temperatura</Label>
                    <Input id="vision-temp" inputMode="decimal" value={temperatura} onChange={(e) => setTemperatura(e.target.value)} className="mt-1.5" />
                  </div>
                  <div>
                    <Label htmlFor="vision-max">Máx. de saída</Label>
                    <Input id="vision-max" inputMode="numeric" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} className="mt-1.5 tabular-nums" />
                  </div>
                </div>
              )}
            </div>

            <SectionHead>Modelos e teto</SectionHead>
            <div className="rounded-xl border border-border bg-card p-4">
              {erroCatalogo ? (
                <Banner tone="warn">Catálogo indisponível: {erroCatalogo}. Sem ele não dá para estimar o custo.</Banner>
              ) : (
                <ModelSelector
                  multi
                  value={modelos}
                  onChange={setModelos}
                  title="Modelos (VLMs)"
                  hint="Escolha um ou mais modelos com entrada de imagem. O mesmo cenário é medido em todos."
                  models={catalogo ?? undefined}
                  loading={catalogo === null}
                />
              )}
              {semVisao.length > 0 && (
                <Banner tone="error" alert className="mt-3">
                  Sem entrada de imagem declarada no catálogo: <strong>{semVisao.join(', ')}</strong>. Escolha outro modelo —
                  nada foi gasto.
                </Banner>
              )}
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <div>
                  <Label htmlFor="vision-teto">Teto de gasto (US$)</Label>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <span className="text-sm text-muted-foreground" aria-hidden="true">$</span>
                    <Input id="vision-teto" inputMode="decimal" value={teto} onChange={(e) => setTeto(e.target.value)} className="w-24 tabular-nums" />
                  </div>
                </div>
                <div className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">
                  {estimativa ? (
                    <>
                      <span className="tabular-nums">
                        {estimativa.scenes} cenário(s) · {estimativa.calls} chamada(s) · estimativa ≤ {fmtUsd(estimativa.usd)}
                      </span>
                      {estimativa.unpriced.length > 0 && (
                        <span className="mt-1 block text-parcial">
                          Sem preço no catálogo (contados como zero): {estimativa.unpriced.join(', ')}.
                        </span>
                      )}
                      {estimativa.usd > (Number(teto) || 0) && (
                        <span className="mt-1 block text-parcial">
                          A estimativa no teto passa do seu teto — a run pode parar no meio (as células cortadas ficam fora do placar).
                        </span>
                      )}
                    </>
                  ) : (
                    'Selecione modelos para ver a estimativa.'
                  )}
                </div>
              </div>
              <Button className="mt-4 h-10 w-full" disabled={!podeIniciar} onClick={() => void iniciar()}>
                <Play aria-hidden="true" />
                {estimativa ? `Rodar ${estimativa.calls} chamada(s)` : 'Rodar o benchmark'}
              </Button>
              <p className="mt-2 text-center text-[11.5px] text-muted-foreground">
                Nada é executado no computador do cenário: o benchmark mede a intenção, não o clique real.
              </p>
            </div>

            <SectionHead status={historico ? `${historico.length} run(s)` : undefined}>Runs de visão salvas</SectionHead>
            {historico === null ? (
              <Skeleton className="h-20 w-full rounded-xl" />
            ) : historico.length === 0 ? (
              <EmptyState>Nenhuma run de visão ainda. A primeira aparece aqui (e em `/vision/runs/:id`).</EmptyState>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {historico.slice(0, 6).map((r) => (
                  <li key={r.id}>
                    <Link
                      to={`/vision/runs/${r.id}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm transition-colors hover:bg-muted/60"
                    >
                      <StatusPill status={r.status} />
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {r.bestModel ?? 'sem modelo'} · {fmtPct(r.bestScore)}
                      </span>
                      <span className="text-[12px] text-muted-foreground">
                        {r.scenes} cenário(s) · {r.calls} chamada(s) · {fmtUsd(r.costUsd)}
                      </span>
                      <span className="text-[12px] text-muted-foreground">{dataCurta(r.startedAt)}</span>
                      <ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <aside className="order-first min-w-0 lg:order-none lg:sticky lg:top-24" aria-label="Prévia do cenário">
            {preview ? (
              <>
                <VisionPreview scene={preview} mode="truth" />
                <div className="mt-3 rounded-xl border border-border bg-card p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Crosshair className="size-4 text-muted-foreground" aria-hidden="true" />
                    <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{preview.title}</h2>
                    <Tag>{FAMILY_LABEL[preview.family]}</Tag>
                  </div>
                  <p className="mt-1 text-[12.5px] text-muted-foreground">
                    {preview.elements.length} controles · {preview.tasks.length} tarefa(s) de ação. As caixas são a verdade
                    do DOM — passe o mouse nos cenários para trocar a prévia.
                  </p>
                  {preview.tasks.length > 0 && (
                    <ul className="mt-3 space-y-1.5 text-[12.5px]">
                      {preview.tasks.map((t, i) => {
                        const alvo = preview.elements.find((e) => e.id === t.expect.targetId);
                        return (
                          <li key={t.id} className="flex gap-2">
                            <span className="mt-0.5 inline-grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold tabular-nums">
                              {i + 1}
                            </span>
                            <span className="min-w-0">
                              {t.instruction}
                              {alvo && <span className="text-muted-foreground"> → {alvo.label ?? alvo.iconDescription}</span>}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </>
            ) : (
              <EmptyState>Nenhum cenário neste filtro.</EmptyState>
            )}
          </aside>
        </div>
      )}

      {dataset && fase === 'rodando' && (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)]">
          <div className="min-w-0">
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-heading text-lg font-medium">Rodando…</h2>
                  <p className="text-[12.5px] text-muted-foreground tabular-nums" aria-live="polite">
                    {feitas} de {totalCelulas} chamada(s) · {modelos.length} modelo(s) · {cenasDaRun.length} cenário(s)
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={cancelar}>
                  <Square aria-hidden="true" /> Cancelar
                </Button>
              </div>
              <ProgressBar
                className="mt-3"
                value={progresso}
                progressbar
                aria-label="Progresso da run de visão"
                valueLabel={`${Math.round(progresso * 100)}%`}
              />
              <p className="mt-2 text-[11.5px] text-muted-foreground">
                A run continua na aba. Fechar/recarregar perde o que ainda não foi salvo (o resultado salvo abre no histórico).
              </p>
            </div>

            <SectionHead>Cenários</SectionHead>
            <ul className="grid gap-2 sm:grid-cols-2">
              {cenasDaRun.map((s) => {
                const st = statusDaCena(s.id);
                const ativo = preview?.id === s.id;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onMouseEnter={() => setPreviewId(s.id)}
                      onFocus={() => setPreviewId(s.id)}
                      onClick={() => setPreviewId(s.id)}
                      className={cn(
                        'w-full rounded-xl border p-3 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                        ativo ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted/50',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{s.title}</span>
                        <Tag>{FAMILY_LABEL[s.family]}</Tag>
                      </span>
                      <span className="mt-1 flex items-center gap-2 text-[11.5px] text-muted-foreground tabular-nums">
                        <span>
                          {st.done}/{st.total} chamada(s)
                        </span>
                        {st.erro > 0 && <span className="text-nao">{st.erro} erro(s)</span>}
                        {st.done >= st.total && st.total > 0 && <span className="text-resolve">pronto</span>}
                      </span>
                      <span className="mt-1 block text-[11.5px] text-muted-foreground">
                        {s.elements.length} controles · {s.tasks.length} tarefa(s)
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <aside className="min-w-0 lg:sticky lg:top-24" aria-label="Prévia do cenário em execução">
            {preview ? (
              <>
                <VisionPreview scene={preview} mode="truth" />
                <p className="mt-2 text-[12px] text-muted-foreground">
                  A tela do teste enquanto roda. O mapa de calor de cada modelo aparece no resultado.
                </p>
              </>
            ) : null}
          </aside>
        </div>
      )}
    </Screen>
  );
}
