import { useEffect, useState } from 'react';
import {
  FileText,
  History,
  Plus,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Barra inferior de navegação (IMPL-110, R-11c:REC-6). Abaixo de 768px a
// navegação somecia: o <nav> do header era `hidden md:flex` e a paleta ⌘K era o
// ÚNICO caminho entre telas — abaixo de 640px não havia caminho nenhum. Agora
// há 4 destinos em 1 toque, com links <a href> reais e `aria-current="page"`.
// ---------------------------------------------------------------------------

export interface NavDestination {
  to: string;
  label: string;
  icon: LucideIcon;
}

/** Os 4 destinos em 1 toque. A paleta ⌘K fica como complemento, nunca como via única. */
export const NAV_DESTINATIONS: NavDestination[] = [
  { to: '/new', label: 'Nova run', icon: Plus },
  { to: '/runs', label: 'Histórico', icon: History },
  { to: '/prompts', label: 'Prompts', icon: FileText },
  { to: '/settings', label: 'Configurações', icon: SettingsIcon },
];

/**
 * Destino "atual" de uma rota — exatamente 1 por rota (IMPL-110 critério ii).
 * O detalhe de run (`/runs/:id`) e o cockpit (`/training/:id`) pertencem ao
 * Histórico: é de lá que se chega e para lá que se volta.
 */
export function activeNavTarget(pathname: string): string {
  if (pathname.startsWith('/settings')) return '/settings';
  if (pathname.startsWith('/prompts')) return '/prompts';
  // Modo JEV: /jev/runs/:id e /jev/training/:id também voltam ao Histórico.
  if (pathname.startsWith('/runs') || pathname.startsWith('/training') || pathname.startsWith('/jev')) return '/runs';
  return '/new';
}

/**
 * Distância (px) entre o fundo da viewport VISUAL e o da janela — é onde a
 * barra tem de morar com o teclado virtual aberto no iOS. `bottom: 0` puro
 * posiciona contra a viewport de layout e a barra some atrás do teclado.
 */
function useVisualViewportBottom(): number {
  const [bottom, setBottom] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => setBottom(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
    };
  }, []);
  return bottom;
}

/**
 * Barra inferior fixa (só < 768px). Posicionada por `window.visualViewport` +
 * `env(safe-area-inset-*)` — nunca dentro de um wrapper com `transform`, que
 * vira containing block de `fixed` no iOS (o wrapper de transição perdeu o
 * transform por isso). Alvos ≥ 44px (≥ 24px exigidos; 44pt é o confortável).
 *
 * Os destinos são `<a href>` REAIS (IMPL-110): clique simples navega no SPA
 * via `onNavigate` (sem reload), modificadores deixam o navegador agir (abrir
 * em aba nova, copiar endereço) e sem JS o link continua um link.
 */
export function BottomNav({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: (to: string) => void;
}) {
  const bottom = useVisualViewportBottom();
  const ativo = activeNavTarget(pathname);
  return (
    <nav
      aria-label="Navegação"
      className="fixed inset-x-0 z-50 border-t border-border bg-card/95 backdrop-blur md:hidden"
      style={{
        bottom: `calc(${bottom}px + env(safe-area-inset-bottom))`,
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
    >
      <ul className="mx-auto flex max-w-6xl items-stretch gap-1 px-2 py-1">
        {NAV_DESTINATIONS.map(({ to, label, icon: Icon }) => {
          const active = to === ativo;
          return (
            <li key={to} className="min-w-0 flex-1">
              <a
                href={to}
                aria-current={active ? 'page' : undefined}
                onClick={(e) => {
                  if (!onNavigate) return;
                  // Modificadores/segundo botão = gesto do navegador (aba nova…).
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  e.preventDefault();
                  onNavigate(to);
                }}
                className={cn(
                  'flex min-h-11 min-w-11 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5 text-[11px] font-medium',
                  active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                <span className="truncate">{label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
