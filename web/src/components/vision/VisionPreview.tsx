import { useId, useState } from 'react';
import { ImageOff, Maximize2 } from 'lucide-react';
import { Skeleton } from '@/components/motion-ui/skeleton';
import { Modal } from '@/components/Modal';
import { cn } from '@/lib/utils';
import type { VisionScene } from '../../engine/vision';
import { sceneImageUrl } from '../../vision/dataset';
import type { Overlay } from '../../vision/view';
import { fmtPct } from '../../vision/view';

/**
 * A TELA DO TESTE — imagem 1080p do cenário + o overlay da verdade/previsões.
 *
 * É o mesmo componente na seleção (verdade), na run ao vivo (verdade) e no
 * resultado (mapa de calor daquele modelo). As cores são DADO: verde = ponto
 * dentro da caixa, vermelho = ponto fora/controle não visto, azul = alvo da
 * ação. Sempre com legenda e com o número ao lado — cor nunca é o único canal.
 */
export function VisionPreview({
  scene,
  overlay,
  mode = 'predictions',
  className,
  compact = false,
  expandable = true,
}: {
  scene: VisionScene;
  /** Ausente = só a verdade do cenário. */
  overlay?: Overlay | null;
  /** `truth` esconde as previsões e mostra todas as caixas. */
  mode?: 'truth' | 'predictions';
  className?: string;
  compact?: boolean;
  /** Botão "Ampliar" (abre um diálogo com a imagem grande). */
  expandable?: boolean;
}) {
  const [estado, setEstado] = useState<'carregando' | 'ok' | 'erro'>('carregando');
  const [ampliado, setAmpliado] = useState(false);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const truth = mode === 'truth' || !overlay;
  const preds = truth ? [] : overlay.predictions;
  const missed = truth ? [] : overlay.missed;
  const actions = truth ? [] : overlay.actions;
  const acertos = preds.filter((p) => p.hit).length;
  const label =
    truth || !overlay
      ? `${scene.title}: ${scene.elements.length} controles interativos (verdade do cenário)`
      : `${scene.title}: ${acertos} de ${preds.length} previsões dentro da caixa; ${missed.length} controle(s) não vistos`;

  return (
    <figure className={cn('relative m-0 overflow-hidden rounded-xl border border-border bg-muted/60', className)}>
      {expandable && !compact && (
        <button
          type="button"
          onClick={() => setAmpliado(true)}
          className="absolute right-2 top-2 z-10 inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/90 px-2 py-1 text-[11.5px] font-medium shadow-sm backdrop-blur transition-colors hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-label="Ampliar a imagem do cenário"
        >
          <Maximize2 className="size-3.5" aria-hidden="true" />
          Ampliar
        </button>
      )}
      <div className="relative aspect-[16/9] w-full">
        {estado === 'carregando' && <Skeleton className="absolute inset-0 size-full rounded-none" />}
        {estado === 'erro' ? (
          <div className="absolute inset-0 grid place-items-center gap-2 text-xs text-muted-foreground">
            <ImageOff className="size-5" aria-hidden="true" />
            imagem do cenário indisponível
          </div>
        ) : (
          <img
            src={sceneImageUrl(scene)}
            alt={label}
            className={cn('absolute inset-0 size-full object-cover transition-opacity', estado === 'ok' ? 'opacity-100' : 'opacity-0')}
            loading="lazy"
            decoding="async"
            onLoad={() => setEstado('ok')}
            onError={() => setEstado('erro')}
          />
        )}
        <svg
          viewBox={`0 0 ${scene.viewport.width} ${scene.viewport.height}`}
          className="absolute inset-0 size-full"
          role="img"
          aria-label={label}
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <radialGradient id={`${uid}-hit`}>
              <stop offset="0%" stopColor="var(--resolve)" stopOpacity="0.55" />
              <stop offset="100%" stopColor="var(--resolve)" stopOpacity="0" />
            </radialGradient>
            <radialGradient id={`${uid}-miss`}>
              <stop offset="0%" stopColor="var(--nao)" stopOpacity="0.55" />
              <stop offset="100%" stopColor="var(--nao)" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Verdade: caixas dos controles. Na previsão ficam discretas; as
              perdidas viram vermelho. */}
          {scene.elements.map((el) => {
            const perdido = missed.some((m) => m.id === el.id);
            return (
              <rect
                key={el.id}
                x={el.bbox.x}
                y={el.bbox.y}
                width={el.bbox.w}
                height={el.bbox.h}
                rx={3}
                fill={truth ? 'var(--primary)' : 'none'}
                fillOpacity={truth ? 0.08 : 0}
                stroke={perdido ? 'var(--nao)' : truth ? 'var(--primary)' : 'var(--border)'}
                strokeWidth={perdido ? 3 : truth ? 2 : 1.5}
                strokeDasharray={perdido || !truth ? '7 5' : undefined}
                opacity={truth ? 0.9 : perdido ? 0.95 : 0.55}
              />
            );
          })}

          {/* Alvos das ações (azul) — independentes do mapa. */}
          {actions.map((a, i) =>
            a.target ? (
              <g key={`alvo-${a.taskId}`}>
                <rect
                  x={a.target.bbox.x - 3}
                  y={a.target.bbox.y - 3}
                  width={a.target.bbox.w + 6}
                  height={a.target.bbox.h + 6}
                  rx={4}
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth={3}
                  strokeDasharray="10 6"
                />
                <circle cx={a.target.bbox.x - 12} cy={a.target.bbox.y - 12} r={13} fill="var(--primary)" />
                <text x={a.target.bbox.x - 12} y={a.target.bbox.y - 7} textAnchor="middle" fontSize={17} fill="var(--primary-foreground)" fontWeight={700}>
                  {i + 1}
                </text>
              </g>
            ) : null,
          )}

          {/* Mapa de calor das previsões: halo (densidade) + ponto. */}
          {preds.map((p, i) => (
            <g key={`pred-${i}`}>
              <circle cx={p.x} cy={p.y} r={p.hit ? 58 : 46} fill={`url(#${uid}-${p.hit ? 'hit' : 'miss'})`} />
              <circle
                cx={p.x}
                cy={p.y}
                r={8}
                fill={p.hit ? 'var(--resolve)' : 'var(--nao)'}
                stroke="var(--background)"
                strokeWidth={2.5}
              />
            </g>
          ))}

          {/* Ações: ponto previsto (número = ordem da tarefa). */}
          {actions.map((a, i) =>
            a.point ? (
              <g key={`acao-${a.taskId}`}>
                <circle cx={a.point.x} cy={a.point.y} r={10} fill={a.pass ? 'var(--resolve)' : 'var(--nao)'} stroke="var(--background)" strokeWidth={3} />
                <text x={a.point.x} y={a.point.y + 5} textAnchor="middle" fontSize={14} fontWeight={700} fill="var(--background)">
                  {i + 1}
                </text>
              </g>
            ) : null,
          )}
        </svg>
      </div>
      {!compact && (
        <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-card/80 px-3 py-2 text-[11.5px] text-muted-foreground">
          {truth || !overlay ? (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm bg-primary/80" aria-hidden="true" /> controle interativo
              </span>
              <span>{scene.elements.length} controles · {scene.tasks.length} tarefa(s) de ação</span>
            </>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-resolve" aria-hidden="true" /> dentro da caixa ({acertos})
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-nao" aria-hidden="true" /> fora/não visto ({preds.length - acertos + missed.length})
              </span>
              {actions.length > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2.5 rounded-sm border border-primary" aria-hidden="true" /> alvo da ação
                </span>
              )}
              <span className="ml-auto tabular-nums">
                {overlay.predictions.length > 0 ? `${fmtPct(acertos / Math.max(1, overlay.predictions.length))} dentro` : 'sem previsões'}
              </span>
            </>
          )}
        </figcaption>
      )}
      {expandable && (
        <Modal
          open={ampliado}
          onClose={() => setAmpliado(false)}
          label={`Imagem ampliada: ${scene.title}`}
          className="max-w-6xl"
        >
          <div className="p-3">
            <VisionPreview
              scene={scene}
              overlay={overlay ?? null}
              mode={mode}
              compact={false}
              expandable={false}
            />
          </div>
        </Modal>
      )}
    </figure>
  );
}
