// IMPL-083: PRIMEIRO import — liga o `jitless` do zod antes de qualquer schema
// nascer (sem a sonda de eval que a CSP reporta como violação em toda rota).
import './zodJitless';
import React, { Suspense, lazy, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { MotionUIThemeProvider } from '@/components/motion-ui/ui-theme';
import { Skeleton } from '@/components/motion-ui/skeleton';
// Fica na raiz do web/ porque é lá que o CLI da Motion o gerencia (e o único
// comando que o sobrescreve é `add @motion/motion-theme` — não rode de novo).
import motionTheme from '../motion.theme';
import { AppShell, RouteTransition } from './components/AppShell';
import { FirstRun, keyAskSkipped } from './components/FirstRun';
import { KeyGate } from './components/KeySetup';
import { Screen } from './components/primitives';
import { NewBenchmark } from './pages/NewBenchmark';
import { RouteErrorBoundary } from './components/RouteErrorBoundary';
import { getStoredKey, startOrphanWatch } from './api';
import { startLocalRetention } from './localRetention';
import './index.css';

// left#15: o SPA saía num chunk único de ~1,7 MB. A Nova Run (`/new`, a rota
// de entrada — `/` redireciona para ela) e o first-run ficam no chunk
// principal; as demais telas viram chunks sob demanda (React.lazy): quem abre
// só a Nova Run não baixa o relatório, o modo JEV, o histórico nem as telas de
// run/treino. A fronteira de erro por rota continua em volta (chunk que falha
// ao carregar cai nela, com "Recarregar"), e o carregamento mostra o esqueleto.
function lazyPage<M, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(async () => ({ default: (await load())[name] as unknown as ComponentType }));
}
const RunView = lazyPage(() => import('./pages/RunView'), 'RunView');
const RunsList = lazyPage(() => import('./pages/RunsList'), 'RunsList');
const TrainingView = lazyPage(() => import('./pages/TrainingView'), 'TrainingView');
const TrainingReport = lazyPage(() => import('./pages/TrainingReport'), 'TrainingReport');
const SettingsPage = lazyPage(() => import('./pages/Settings'), 'SettingsPage');
const PromptsPage = lazyPage(() => import('./pages/PromptsPage'), 'PromptsPage');
const JevRunView = lazyPage(() => import('./pages/jev/JevRunView'), 'JevRunView');
const JevTrainingView = lazyPage(() => import('./pages/jev/JevTrainingView'), 'JevTrainingView');
const JevReportPage = lazyPage(() => import('./pages/jev/JevReportPage'), 'JevReportPage');

/**
 * Deploy novo com a aba aberta: os chunks antigos somem (o rewrite da Vercel
 * devolve o index.html no lugar) e o `import()` da rota falha. Recarrega UMA
 * vez para pegar o index novo; se falhar de novo em seguida, a fronteira da
 * rota mostra o erro (sem laço de recarga).
 */
window.addEventListener('vite:preloadError', (event) => {
  try {
    const ultima = Number(sessionStorage.getItem('pb.chunkReloadAt') ?? 0);
    if (Date.now() - ultima < 30_000) return;
    sessionStorage.setItem('pb.chunkReloadAt', String(Date.now()));
  } catch {
    return; // sem sessionStorage não há como evitar o laço: deixa a fronteira mostrar
  }
  event.preventDefault();
  window.location.reload();
});

/** Esqueleto de rota enquanto o chunk da tela chega. */
function RouteSkeleton() {
  return (
    <Screen wide>
      <div className="flex flex-col gap-4 pt-6" role="status" aria-label="Carregando a tela…">
        <Skeleton className="h-10 w-2/3 rounded-lg" />
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    </Screen>
  );
}

// IMPL-023: na carga, runs/treinos 'running' sem dono (a aba que os executava
// fechou ou recarregou) viram interrompidos — sem ninguém precisar abri-los.
startOrphanWatch();
// Modo JEV: a mesma regra para as runs/sessões JEV (lock livre = órfã). O
// motor JEV vem num chunk próprio, fora do caminho da primeira pintura.
void import('./jev/api')
  .then((m) => m.startJevOrphanWatch())
  .catch((err: unknown) => console.warn('[jev] varredura de órfãs não rodou:', err));
// left#6 (IMPL-100): TTL LGPD do histórico local — o vencido sai na abertura.
void startLocalRetention();

/**
 * "Pede direto a key" (pedido do dono): sem chave — e sem o "explorar sem
 * chave" desta sessão — QUALQUER rota cai no first-run (`/welcome`), que pede a
 * key como passo seguinte. Com chave (ou com o salto), a app segue normal.
 *
 * A key vive só na memória da aba por default (IMPL-082: localStorage só com
 * «Lembrar neste dispositivo»), e o navegador pode apagar a lembrada (Safari:
 * 7 dias sem uso). "Key sumida" é RE-PROMPT, não erro: o gate leva a rota de
 * origem em `state.from` e o first-run devolve o usuário a ela — recarregar
 * `/runs/:id` não perde mais a run que estava aberta.
 *
 * Mora DENTRO das <Routes> (rota de layout): o `useLocation` daqui lê a
 * location CONGELADA da página (web-live#9), nunca a da rota para onde se vai.
 */
function KeyFirstGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const from = `${location.pathname}${location.search}`;
  // `state` ESTÁVEL: o <Navigate> refaz o navigate quando a identidade dele
  // muda, e o wrapper que sai re-renderiza a cada navegação — um objeto novo
  // por render redispararia o redirect em laço durante a animação de saída.
  const state = React.useMemo(() => ({ from }), [from]);
  const semChave = !getStoredKey() && !keyAskSkipped();
  if (semChave && location.pathname !== '/welcome') {
    return <Navigate to="/welcome" replace state={state} />;
  }
  return <>{children}</>;
}

/**
 * Rotas com a transição entre páginas (web-live#9). A location é lida AQUI e
 * passada às <Routes>: cada filho da transição fica preso à SUA location — o
 * wrapper que sai (AnimatePresence mode="wait") continua mostrando a página
 * antiga, e a de destino monta uma vez só, no wrapper que entra. Antes as
 * <Routes> liam o contexto e o destino montava também no wrapper que saía:
 * efeitos de uma vez só (o rascunho do "Usar como base") eram consumidos pela
 * cópia descartada, e toda navegação dobrava os fetches da página nova.
 * Gate de key e fronteira de erro ficam na rota de LAYOUT, sob a mesma
 * location congelada.
 */
function AppRoutes() {
  const location = useLocation();
  return (
    <RouteTransition routeKey={location.pathname}>
      <Routes location={location}>
        <Route
          element={
            <KeyFirstGate>
              <RouteErrorBoundary>
                {/* Dentro da fronteira: chunk que não carrega vira a tela de erro da rota. */}
                <Suspense fallback={<RouteSkeleton />}>
                  <Outlet />
                </Suspense>
              </RouteErrorBoundary>
            </KeyFirstGate>
          }
        >
          <Route path="/" element={<Navigate to="/new" replace />} />
          <Route path="/welcome" element={<FirstRun />} />
          {/* Seletor LLM | JEV (D-12): wrapper sobre o NewRun intocado. */}
          <Route path="/new" element={<KeyGate><NewBenchmark /></KeyGate>} />
          <Route path="/runs" element={<RunsList />} />
          <Route path="/runs/:id" element={<RunView />} />
          <Route path="/training/:sessionId" element={<TrainingView />} />
          <Route path="/training/:sessionId/report" element={<TrainingReport />} />
          <Route path="/jev/runs/:id" element={<JevRunView />} />
          <Route path="/jev/training/:sessionId" element={<JevTrainingView />} />
          <Route path="/jev/training/:sessionId/report" element={<JevReportPage />} />
          <Route path="/prompts" element={<PromptsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </RouteTransition>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      {/* Uma vez só, na raiz: sem isto toda peça do Motion UI cai nos defaults. */}
      <MotionUIThemeProvider theme={motionTheme}>
        <AppShell>
          <AppRoutes />
        </AppShell>
      </MotionUIThemeProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
