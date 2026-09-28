import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { AnimatePresence, motion, useTransform } from 'motion/react';
import {
  Check,
  CircleHelp,
  FileText,
  History,
  Monitor,
  Moon,
  Plus,
  Settings as SettingsIcon,
  Sun,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import {
  ShrinkHeader,
  ShrinkHeaderFill,
  ShrinkHeaderRow,
  useCondenseProgress,
} from '@/components/motion-ui/shrink-header';
import {
  CommandPalette,
  type CommandPaletteItem,
} from '@/components/motion-ui/command-palette';
import { Toast, ToastStack, useToastStack } from '@/components/motion-ui/toast-stack';
import { useMotionUITransition, useMotionUITheme } from '@/components/motion-ui/ui-theme';
import { Button } from '@/components/ui/button';
import { ThemeContext, applyTheme, getStoredTheme, persistTheme, type ResolvedTheme, type Theme } from '../theme';
import { HelpContext, helpTopicForRoute, markFirstOpen, type HelpTutorial } from '../help';
import { HelpModal } from './HelpModal';
import { BottomNav, NAV_DESTINATIONS, activeNavTarget } from './BottomNav';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ toasts */

type ToastTone = 'ok' | 'error';
interface ToastApi {
  notify: (text: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastApi>({ notify: () => {} });

/** Feedback efêmero (salvo, copiado, falhou). Uma linha, some sozinho. */
export function useToasts(): ToastApi {
  return useContext(ToastContext);
}

function ToastLayer({ children }: { children: ReactNode }) {
  const { toasts, add, dismiss } = useToastStack();
  // O ToastStack só gerencia ids; o conteúdo de cada um vive aqui.
  const content = useRef(new Map<number, { text: string; tone: ToastTone }>());
  const [, force] = useState(0);

  const notify = useCallback(
    (text: string, tone: ToastTone = 'ok') => {
      const id = add();
      content.current.set(id, { text, tone });
      force((n) => n + 1);
      setTimeout(() => {
        content.current.delete(id);
        dismiss(id);
      }, 3200);
    },
    [add, dismiss],
  );

  const api = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastStack className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] mx-auto w-[min(24rem,calc(100%-2rem))]">
        {toasts.map((id) => {
          const item = content.current.get(id);
          if (!item) return null;
          return (
            <Toast key={id}>
              <div
                className={cn(
                  'pointer-events-auto flex items-center gap-2.5 rounded-lg border bg-popover px-4 py-3 text-sm shadow-lg',
                  item.tone === 'error' ? 'border-destructive/30 text-destructive' : 'border-border text-foreground',
                )}
              >
                {item.tone === 'error' ? (
                  <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
                ) : (
                  <Check className="size-4 shrink-0 text-resolve" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1">{item.text}</span>
              </div>
            </Toast>
          );
        })}
      </ToastStack>
    </ToastContext.Provider>
  );
}

/* ------------------------------------------------------------------- tema */

const THEME_ICON: Record<Theme, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };
const THEME_NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_LABEL: Record<Theme, string> = { system: 'sistema', light: 'claro', dark: 'escuro' };

function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  const Icon = THEME_ICON[theme];
  const snap = useMotionUITransition('snap');
  const { motionMode } = useMotionUITheme();
  return (
    <Button
      variant="ghost"
      size="icon"
      title={`Tema: ${THEME_LABEL[theme]} — clique para trocar`}
      aria-label={`Tema: ${THEME_LABEL[theme]}. Trocar para ${THEME_LABEL[THEME_NEXT[theme]]}`}
      onClick={() => onChange(THEME_NEXT[theme])}
    >
      {/* Só o glifo troca; a caixa fica parada (nada de layout animado). */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={theme}
          initial={motionMode === 'off' ? false : { opacity: 0, transform: 'scale(0.6)' }}
          animate={{ opacity: 1, transform: 'scale(1)' }}
          exit={{ opacity: 0, transform: 'scale(0.6)' }}
          transition={snap}
          className="flex"
        >
          <Icon className="size-4" aria-hidden="true" />
        </motion.span>
      </AnimatePresence>
    </Button>
  );
}

/* ------------------------------------------------------------- cabeçalho */

/**
 * Adapta um ícone do Lucide ao slot do CommandPalette. O Lucide tipa
 * `aria-hidden` como Booleanish (aceita a string "true"), e o slot pede
 * `boolean` — sem o wrapper o TS recusa o ícone.
 */
type CommandIcon = NonNullable<CommandPaletteItem['icon']>;
function cmdIcon(Icon: LucideIcon): CommandIcon {
  return ({ className }) => <Icon className={className} aria-hidden="true" />;
}

/** Marca + navegação: encolhem junto com a barra (transform, nunca layout). */
function HeaderContent({
  theme,
  onTheme,
  onHelp,
  palette,
}: {
  theme: Theme;
  onTheme: (t: Theme) => void;
  onHelp: () => void;
  palette: ReactNode;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const condense = useCondenseProgress();
  const wordmarkScale = useTransform(condense, [0, 1], [1, 0.88]);

  return (
    <ShrinkHeaderRow className="mx-auto max-w-6xl gap-3 px-5 sm:px-6">
      <motion.button
        type="button"
        onClick={() => navigate('/new')}
        style={{ scale: wordmarkScale }}
        className="flex shrink-0 origin-left items-center gap-2 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span
          aria-hidden="true"
          className="grid size-6 place-items-center rounded-md bg-primary font-mono text-[13px] font-semibold text-primary-foreground"
        >
          P
        </span>
        <span className="font-heading text-sm font-medium tracking-tight">Prompt Builder</span>
      </motion.button>

      {/* Navegação do topo: <a href> reais (mesmos destinos da barra inferior),
          com `aria-current` do MESMO mapa de rotas — exatamente 1 por rota. */}
      <nav className="ml-2 hidden items-center gap-0.5 md:flex" aria-label="Seções">
        {NAV_DESTINATIONS.map((item) => {
          const active = activeNavTarget(pathname) === item.to;
          return (
            <Link
              key={item.to}
              to={item.to}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors',
                active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {active && (
                <motion.span
                  layoutId="nav-active"
                  className="absolute inset-0 rounded-lg bg-muted"
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                  aria-hidden="true"
                />
              )}
              <span className="relative">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* A paleta é a navegação primária: mora na própria barra, não flutuando
          sob ela. As variantes de descendente encolhem o gatilho (h-12 por
          padrão) sem tocar no source instalado. */}
      <div className="ml-auto hidden w-full max-w-[260px] sm:block [&_button[aria-keyshortcuts]]:h-8 [&_button[aria-keyshortcuts]]:text-[13px] [&_button[aria-keyshortcuts]]:shadow-none">
        {palette}
      </div>

      <div className="ml-auto flex items-center gap-1.5 sm:ml-0">
        <Button variant="ghost" size="icon" title="Como funciona" aria-label="Como funciona" onClick={onHelp}>
          <CircleHelp className="size-4" aria-hidden="true" />
        </Button>
        <ThemeToggle theme={theme} onChange={onTheme} />
        {/* Na própria Nova Run o CTA seria um no-op — só aparece fora dela. */}
        {pathname !== '/new' && (
          <Button size="sm" className="hidden md:inline-flex" onClick={() => navigate('/new')}>
            <Plus aria-hidden="true" />
            Nova run
          </Button>
        )}
      </div>
    </ShrinkHeaderRow>
  );
}

/* --------------------------------------------------------------- shell */

const HEADER_TALL = 84;
const HEADER_COMPACT = 56;

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);
  const [resolved, setResolved] = useState<ResolvedTheme>('dark');
  const [help, setHelp] = useState<HelpTutorial | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    setResolved(applyTheme(theme));
    persistTheme(theme);
  }, [theme]);

  // Em 'system' o tema acompanha o SO enquanto o app está aberto.
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setResolved(applyTheme('system'));
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [theme]);

  useEffect(() => {
    markFirstOpen();
  }, []);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);
  const themeApi = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  const helpApi = useMemo(() => ({ open: (t: HelpTutorial) => setHelp(t) }), []);

  const commands = useMemo<CommandPaletteItem[]>(
    () => [
      { id: 'new', label: 'Nova run', group: 'Ir para', icon: cmdIcon(Plus), keywords: ['criar', 'benchmark', 'rodar'] },
      { id: 'runs', label: 'Histórico', group: 'Ir para', icon: cmdIcon(History), keywords: ['runs', 'treinos', 'passado'] },
      { id: 'prompts', label: 'Prompts', group: 'Ir para', icon: cmdIcon(FileText), keywords: ['biblioteca', 'salvos'] },
      { id: 'settings', label: 'Configurações', group: 'Ir para', icon: cmdIcon(SettingsIcon), keywords: ['chave', 'key', 'openrouter'] },
      { id: 'help:compare', label: 'Como funciona: comparar modelos', group: 'Ajuda', icon: cmdIcon(CircleHelp), keywords: ['tutorial'] },
      { id: 'help:variation', label: 'Como funciona: testar prompts', group: 'Ajuda', icon: cmdIcon(CircleHelp), keywords: ['tutorial', 'variação'] },
      { id: 'help:training', label: 'Como funciona: treinar prompt', group: 'Ajuda', icon: cmdIcon(CircleHelp), keywords: ['tutorial', 'treino'] },
      { id: 'help:runs', label: 'Como funciona: histórico de runs', group: 'Ajuda', icon: cmdIcon(CircleHelp), keywords: ['tutorial', 'histórico'] },
      { id: 'help:prompts', label: 'Como funciona: biblioteca de prompts', group: 'Ajuda', icon: cmdIcon(CircleHelp), keywords: ['tutorial', 'biblioteca'] },
      { id: 'help:settings', label: 'Como funciona: configurações', group: 'Ajuda', icon: cmdIcon(CircleHelp), keywords: ['tutorial', 'key', 'tema'] },
      { id: 'theme:light', label: 'Tema claro', group: 'Aparência', icon: cmdIcon(Sun) },
      { id: 'theme:dark', label: 'Tema escuro', group: 'Aparência', icon: cmdIcon(Moon) },
      { id: 'theme:system', label: 'Tema do sistema', group: 'Aparência', icon: cmdIcon(Monitor) },
    ],
    [],
  );

  const runCommand = useCallback(
    (item: CommandPaletteItem) => {
      if (item.id.startsWith('help:')) return setHelp(item.id.slice(5) as HelpTutorial);
      if (item.id.startsWith('theme:')) return setTheme(item.id.slice(6) as Theme);
      navigate(`/${item.id}`);
    },
    [navigate, setTheme],
  );

  return (
    <ThemeContext.Provider value={themeApi}>
      <HelpContext.Provider value={helpApi}>
        <ToastLayer>
          <ShrinkHeader tallHeight={HEADER_TALL} compactHeight={HEADER_COMPACT}>
            <ShrinkHeaderFill />
            <HeaderContent
              theme={theme}
              onTheme={setTheme}
              onHelp={() => setHelp(helpTopicForRoute(location.pathname))}
              palette={
                <CommandPalette
                  open={paletteOpen}
                  onOpenChange={setPaletteOpen}
                  items={commands}
                  groupOrder={['Ir para', 'Ajuda', 'Aparência']}
                  triggerLabel="Buscar…"
                  inputPlaceholder="Para onde vamos?"
                  inputAriaLabel="Buscar comandos"
                  dialogLabel="Paleta de comandos"
                  footerHints={[
                    { keys: '↑↓', label: 'navegar' },
                    { keys: '↵', label: 'abrir' },
                    { keys: 'esc', label: 'fechar' },
                  ]}
                  renderEmpty={(q) => <>Nada corresponde a “{q}”.</>}
                  onSelect={runCommand}
                />
              }
            />
          </ShrinkHeader>

          <main style={{ paddingTop: HEADER_TALL + 16, paddingBottom: 24 }}>
            <RouteTransition routeKey={location.pathname}>{children}</RouteTransition>
          </main>

          {/* Barra inferior (IMPL-110): os 4 destinos ficam a1 toque abaixo de
              768px. Mora FORA do wrapper de transição, que não pode ter
              transform (vira containing block de `fixed` no iOS). */}
          <BottomNav pathname={location.pathname} onNavigate={navigate} />

          {help && <HelpModal tutorial={help} onClose={() => setHelp(null)} />}
        </ToastLayer>
      </HelpContext.Provider>
    </ThemeContext.Provider>
  );
}

/**
 * Transição entre rotas. O catálogo tem `page-curtain` e `mask-wipe`, mas os
 * dois carregam o NOME da página atravessando a tela — coreografia de site de
 * marketing, insuportável numa ferramenta que se navega o dia inteiro (e o
 * mask-wipe ainda é React 19 canary). Aqui é só opacity, no token "ui" do tema.
 * SEM transform: qualquer `transform` no wrapper vira containing block dos
 * `fixed` descendentes no iOS (IMPL-110) — a barra inferior e os toasts ficam
 * fora, mas a regra vale para o que entrar aqui.
 */
function RouteTransition({ routeKey, children }: { routeKey: string; children: ReactNode }) {
  const ui = useMotionUITransition('ui');
  const { motionMode } = useMotionUITheme();
  const still = motionMode === 'off';

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={routeKey}
        initial={still ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={still ? { opacity: 1 } : { opacity: 0 }}
        transition={still ? { duration: 0 } : { type: 'tween', duration: ui.duration * 0.7, ease: ui.ease }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
