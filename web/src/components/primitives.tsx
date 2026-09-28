import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  StaggerReveal,
  StaggerRevealHeadline,
  StaggerRevealItem,
} from '@/components/motion-ui/stagger-reveal';
import type { DiffLine } from '../diff';
import { cn } from '@/lib/utils';

/**
 * Peças recorrentes da tela, escritas uma vez sobre os tokens semânticos do
 * shadcn. Não são componentes do catálogo Motion — são a gramática do produto
 * (cabeçalho de página, linha de ajuste, pílula de status, bloco de prompt).
 */

/* ------------------------------------------------------------------ layout */

/** Coluna central de uma página. `wide` para telas com heatmap. */
export function Screen({
  children,
  wide,
  className,
}: {
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('mx-auto w-full px-5 pb-32 sm:px-6', wide ? 'max-w-6xl' : 'max-w-3xl', className)}>
      {children}
    </div>
  );
}

/** Título da página + subtítulo, com a entrada orquestrada do Motion UI. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <StaggerReveal as="header" className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <StaggerRevealHeadline
          as="h1"
          className="font-heading text-3xl font-medium tracking-tight text-balance"
        >
          {title}
        </StaggerRevealHeadline>
        {subtitle && (
          <StaggerRevealItem as="p" className="mt-1.5 max-w-prose text-sm text-muted-foreground">
            {subtitle}
          </StaggerRevealItem>
        )}
      </div>
      {actions && <StaggerRevealItem className="flex shrink-0 items-center gap-2">{actions}</StaggerRevealItem>}
    </StaggerReveal>
  );
}

/** Rótulo de seção: caixa-alta discreta + filete até a borda. */
export function SectionHead({
  children,
  status,
  className,
}: {
  children: ReactNode;
  status?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mt-10 mb-3 flex items-center gap-3', className)}>
      <h2 className="text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {children}
      </h2>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      {status && <span className="text-xs text-muted-foreground">{status}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ avisos */

type BannerTone = 'error' | 'neutral' | 'warn';

const BANNER_TONE: Record<BannerTone, string> = {
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
  warn: 'border-parcial/30 bg-parcial-soft/60 text-foreground',
  neutral: 'border-border bg-muted/50 text-muted-foreground',
};

export function Banner({
  tone = 'neutral',
  children,
  className,
  alert,
}: {
  tone?: BannerTone;
  children: ReactNode;
  className?: string;
  /** Anuncia já ao leitor de tela (role="alert") — para avisos acionáveis. */
  alert?: boolean;
}) {
  return (
    <div
      role={tone === 'error' || alert ? 'alert' : undefined}
      className={cn('rounded-lg border px-4 py-3 text-sm', BANNER_TONE[tone], className)}
    >
      {children}
    </div>
  );
}

/** Linha "✓ algo veio pronto do arquivo — [ação]". */
export function ImportedLine({
  text,
  action,
  onAction,
}: {
  text: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-sm">
      <span className="text-foreground">✓ {text}</span>
      <button type="button" className="text-primary underline-offset-4 hover:underline" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- pílulas */

const STATUS_TONE: Record<string, string> = {
  running: 'border-primary/30 bg-primary/10 text-primary',
  finished: 'border-resolve/30 bg-resolve-soft/60 text-resolve',
  // IMPL-004: terminou, mas a evidência não sustenta conclusão — mesmo token
  // do pill de veredito 'parcial' (contraste já medido nos dois temas).
  inconclusive: 'border-parcial/30 bg-parcial-soft/60 text-parcial',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
  aborted: 'border-border bg-muted text-muted-foreground',
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        STATUS_TONE[status] ?? STATUS_TONE.aborted,
      )}
    >
      {status === 'running' && (
        <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />
      )}
      {status}
    </span>
  );
}

/** Pílula neutra para modo, técnica, contagem. */
export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">
      {children}
    </kbd>
  );
}

/* ----------------------------------------------------- linhas de ajuste */

/**
 * Linha de ajuste: rótulo + explicação à esquerda, controle à direita.
 * `wide` desce o controle para baixo do texto (textareas, grades de chips).
 */
export function SettingRow({
  label,
  sub,
  wide,
  htmlFor,
  children,
}: {
  label?: string;
  sub?: ReactNode;
  wide?: boolean;
  htmlFor?: string;
  children?: ReactNode;
}) {
  const Label = htmlFor ? 'label' : 'span';
  return (
    <div
      className={cn(
        'flex gap-4 border-b border-border px-4 py-3.5 last:border-b-0',
        wide ? 'flex-col items-stretch' : 'flex-wrap items-center justify-between',
      )}
    >
      {(label || sub) && (
        <div className="min-w-0 flex-1">
          {label && (
            <Label htmlFor={htmlFor} className="block text-sm font-medium text-foreground">
              {label}
            </Label>
          )}
          {sub && <p className="mt-0.5 max-w-prose text-[13px] leading-snug text-muted-foreground">{sub}</p>}
        </div>
      )}
      {children && (
        <div className={cn('flex items-center gap-2', wide ? 'flex-col items-stretch' : 'shrink-0 justify-end')}>
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Grupo de linhas de ajuste, com cabeçalho e rodapé opcionais.
 * `id` torna a seção uma ÂNCORA estável (foco + scroll da navegação de
 * pendências do formulário de Nova Run — IMPL-106).
 */
export function SettingGroup({
  id,
  title,
  status,
  footer,
  pending,
  children,
  className,
}: {
  /** Âncora estável da seção (id do `<section>`, focável em `tabIndex={-1}`). */
  id?: string;
  title?: string;
  status?: ReactNode;
  footer?: ReactNode;
  /** Ponto de pendência ao lado do título ('muted' antes de tentar, 'error' depois). */
  pending?: 'muted' | 'error';
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      tabIndex={id ? -1 : undefined}
      className={cn('mb-4 scroll-mt-28 outline-none', className)}
    >
      {title && (
        <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            {title}
            {pending && (
              <span
                className={cn('size-1.5 rounded-full', pending === 'error' ? 'bg-destructive' : 'bg-muted-foreground/60')}
                aria-label="pendência nesta seção"
              />
            )}
          </h2>
          {status && <span className="text-xs text-muted-foreground tabular">{status}</span>}
        </div>
      )}
      <div className="rounded-xl bg-card ring-1 ring-foreground/10">{children}</div>
      {footer && <p className="mt-2 px-1 text-[13px] text-muted-foreground">{footer}</p>}
    </section>
  );
}

/* ------------------------------------------------- foco composto (roving) */

/**
 * Toolbar com ROVING TABINDEX (padrão APG "toolbar"): o grupo inteiro é UMA
 * parada de Tab e as setas movem o item ativo entre os controles dele. É o que
 * segura o orçamento de Tab do formulário — uma fileira de 14 chips não pode
 * virar 14 paradas antes do "Iniciar" (R-11b:REC-1).
 */
const RovingCtx = createContext<{ active: number } | null>(null);

export interface RovingProps {
  tabIndex: 0 | -1;
  'data-roving-item': '';
}

/**
 * Props de roving para o item `index` do toolbar mais próximo. Fora de um
 * `RovingToolbar` devolve tab stop normal (tabIndex 0).
 */
export function useRovingTabStop(index: number): RovingProps {
  const ctx = useContext(RovingCtx);
  return { tabIndex: ctx ? (ctx.active === index ? 0 : -1) : 0, 'data-roving-item': '' };
}

/**
 * Item de um `RovingToolbar` cujo controle vem de render-prop. O hook precisa
 * rodar num COMPONENTE filho do toolbar (o contexto não pega em chamadas feitas
 * no corpo do pai) — é por isso que o controle é devolvido como função.
 */
export function RovingItem({
  index,
  children,
}: {
  index: number;
  children: (p: RovingProps) => ReactNode;
}) {
  return <>{children(useRovingTabStop(index))}</>;
}

/** Grupo de controles relacionados com uma parada de Tab só (setas navegam). */
export function RovingToolbar({
  label,
  count,
  className,
  children,
}: {
  /** Nome acessível do grupo. */
  label: string;
  /** Nº de itens focáveis do grupo (define o wrap das setas). */
  count: number;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  function move(next: number) {
    const total = Math.max(1, count);
    const alvo = ((next % total) + total) % total;
    setActive(alvo);
    ref.current?.querySelectorAll<HTMLElement>('[data-roving-item]')[alvo]?.focus();
  }
  return (
    <RovingCtx.Provider value={{ active }}>
      <div
        ref={ref}
        role="toolbar"
        aria-label={label}
        className={className}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            move(active + 1);
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            move(active - 1);
          } else if (e.key === 'Home') {
            e.preventDefault();
            move(0);
          } else if (e.key === 'End') {
            e.preventDefault();
            move(count - 1);
          }
        }}
      >
        {children}
      </div>
    </RovingCtx.Provider>
  );
}

/**
 * Seção recolhível — o 2º nível da revelação progressiva. A região fica
 * MONTADA com `hidden`: o estado dos campos sobrevive ao recolher, e o
 * `aria-controls` nunca aponta para id inexistente. Conteúdo recolhido sai da
 * ordem de Tab (o `hidden` cuida disso).
 */
export function Disclosure({
  id,
  title,
  status,
  pending,
  open,
  onToggle,
  children,
  footer,
}: {
  /** Âncora estável da seção (id do `<section>` e base do `aria-controls`). */
  id: string;
  title: string;
  status?: ReactNode;
  /** Ponto de pendência ao lado do título ('muted' antes de tentar, 'error' depois). */
  pending?: 'muted' | 'error';
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section id={id} tabIndex={-1} className="mb-4 scroll-mt-28 outline-none">
      <div className="mt-10 mb-3 flex items-center gap-3">
        <h2 className="text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`${id}-region`}
            onClick={onToggle}
            className="flex items-center gap-2 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronRight className={cn('size-3.5', open && 'rotate-90')} aria-hidden="true" />
            {title}
          </button>
        </h2>
        {pending && (
          <span
            className={cn('size-1.5 rounded-full', pending === 'error' ? 'bg-destructive' : 'bg-muted-foreground/60')}
            aria-label="pendência nesta seção"
          />
        )}
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
        {status && <span className="text-xs text-muted-foreground">{status}</span>}
      </div>
      <div id={`${id}-region`} hidden={!open}>
        {children}
      </div>
      {footer && open && <p className="mt-2 px-1 text-[13px] text-muted-foreground">{footer}</p>}
    </section>
  );
}

/* ------------------------------------------------------------------ chips */

/**
 * Chip de alternância (`aria-pressed`). Dentro de um `RovingToolbar`, `index`
 * decide quem é a parada de Tab do grupo.
 */
export function Chip(p: {
  on: boolean;
  label: string;
  title?: string;
  onClick: () => void;
  index?: number;
}) {
  const roving = useRovingTabStop(p.index ?? 0);
  return (
    <button
      type="button"
      {...roving}
      aria-pressed={p.on}
      title={p.title}
      onClick={p.onClick}
      className={cn(
        'rounded-full border px-2.5 py-1 text-[12.5px] font-medium transition-colors',
        p.on
          ? 'border-primary bg-primary/12 text-foreground'
          : 'border-border bg-muted text-muted-foreground hover:text-foreground',
      )}
    >
      {p.label}
    </button>
  );
}

/* ------------------------------------------------------------- conteúdo */

/** Bloco de texto longo preservado (prompt, contexto, resposta). */
export function Pre({
  children,
  className,
  max = 'max-h-80',
}: {
  children: ReactNode;
  className?: string;
  max?: string;
}) {
  return (
    <pre
      className={cn(
        'scroll-slim overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-foreground',
        max,
        className,
      )}
    >
      {children}
    </pre>
  );
}

/** Rótulo minúsculo acima de um bloco. */
export function MiniLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'mb-1.5 text-[11px] font-semibold tracking-[0.07em] text-muted-foreground uppercase',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Diff linha-a-linha (versões de prompt / vs. original). */
export function DiffView({ diff, className }: { diff: DiffLine[]; className?: string }) {
  return (
    <Pre className={cn('p-0', className)}>
      {diff.map((l, i) => (
        <div
          key={i}
          className={cn(
            'flex gap-2 px-3',
            l.type === 'add' && 'bg-resolve-soft/50 text-resolve',
            l.type === 'del' && 'bg-nao-soft/50 text-nao',
          )}
        >
          <span className="w-3 shrink-0 select-none text-muted-foreground">
            {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}
          </span>
          <span className="min-w-0 flex-1">{l.text || ' '}</span>
        </div>
      ))}
    </Pre>
  );
}
