import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { MotionUIThemeProvider } from '@/components/motion-ui/ui-theme';
// Fica na raiz do web/ porque é lá que o CLI da Motion o gerencia (e o único
// comando que o sobrescreve é `add @motion/motion-theme` — não rode de novo).
import motionTheme from '../motion.theme';
import { AppShell } from './components/AppShell';
import { FirstRun, keyAskSkipped } from './components/FirstRun';
import { KeyGate } from './components/KeySetup';
import { NewRun } from './pages/NewRun';
import { RunView } from './pages/RunView';
import { RunsList } from './pages/RunsList';
import { TrainingView } from './pages/TrainingView';
import { TrainingReport } from './pages/TrainingReport';
import { RouteErrorBoundary } from './components/RouteErrorBoundary';
import { SettingsPage } from './pages/Settings';
import { PromptsPage } from './pages/PromptsPage';
import { getStoredKey, startOrphanWatch } from './api';
import './index.css';

// IMPL-023: na carga, runs/treinos 'running' sem dono (a aba que os executava
// fechou ou recarregou) viram interrompidos — sem ninguém precisar abri-los.
startOrphanWatch();

/**
 * "Pede direto a key" (pedido do dono): sem chave salva — e sem o "explorar sem
 * chave" desta sessão — QUALQUER rota cai no first-run (`/welcome`), que pede a
 * key como passo seguinte. Com chave (ou com o salto), a app segue normal.
 */
function KeyFirstGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const semChave = !getStoredKey() && !keyAskSkipped();
  if (semChave && location.pathname !== '/welcome') {
    return <Navigate to="/welcome" replace />;
  }
  return <>{children}</>;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      {/* Uma vez só, na raiz: sem isto toda peça do Motion UI cai nos defaults. */}
      <MotionUIThemeProvider theme={motionTheme}>
        <AppShell>
          <KeyFirstGate>
            <RouteErrorBoundary>
            <Routes>
              <Route path="/" element={<Navigate to="/new" replace />} />
              <Route path="/welcome" element={<FirstRun />} />
              <Route path="/new" element={<KeyGate><NewRun /></KeyGate>} />
              <Route path="/runs" element={<RunsList />} />
              <Route path="/runs/:id" element={<RunView />} />
              <Route path="/training/:sessionId" element={<TrainingView />} />
              <Route path="/training/:sessionId/report" element={<TrainingReport />} />
              <Route path="/prompts" element={<PromptsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
            </RouteErrorBoundary>
          </KeyFirstGate>
        </AppShell>
      </MotionUIThemeProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
