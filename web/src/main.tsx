// IMPL-083: PRIMEIRO import — liga o `jitless` do zod antes de qualquer schema
// nascer (sem a sonda de eval que a CSP reporta como violação em toda rota).
import './zodJitless';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { MotionUIThemeProvider } from '@/components/motion-ui/ui-theme';
// Fica na raiz do web/ porque é lá que o CLI da Motion o gerencia (e o único
// comando que o sobrescreve é `add @motion/motion-theme` — não rode de novo).
import motionTheme from '../motion.theme';
import { AppShell, RouteTransition } from './components/AppShell';
import { FirstRun, keyAskSkipped } from './components/FirstRun';
import { KeyGate } from './components/KeySetup';
import { NewBenchmark } from './pages/NewBenchmark';
import { RunView } from './pages/RunView';
import { RunsList } from './pages/RunsList';
import { TrainingView } from './pages/TrainingView';
import { TrainingReport } from './pages/TrainingReport';
import { RouteErrorBoundary } from './components/RouteErrorBoundary';
import { SettingsPage } from './pages/Settings';
import { PromptsPage } from './pages/PromptsPage';
import { JevRunView } from './pages/jev/JevRunView';
import { JevTrainingView } from './pages/jev/JevTrainingView';
import { JevReportPage } from './pages/jev/JevReportPage';
import { getStoredKey, startOrphanWatch } from './api';
import { startJevOrphanWatch } from './jev/api';
import { startLocalRetention } from './localRetention';
import './index.css';

// IMPL-023: na carga, runs/treinos 'running' sem dono (a aba que os executava
// fechou ou recarregou) viram interrompidos — sem ninguém precisar abri-los.
startOrphanWatch();
// Modo JEV: a mesma regra para as runs/sessões JEV (lock livre = órfã).
void startJevOrphanWatch();
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
                <Outlet />
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
