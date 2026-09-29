// Entrada do harness de browser das telas de treino (test/web-views-e2e.test.ts).
// Monta as páginas REAIS (TrainingView, TrainingReport e PromptsPage, com
// StrictMode como o main.tsx) numa MemoryRouter, sob a MESMA fronteira de erro
// por rota do app; o `../api` do grafo é trocado pelo fake
// (test/support/trainingViewFakeApi.ts) no bundle do esbuild. Os cenários vêm
// de trainingViewFixture.ts.
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TrainingView } from '../../web/src/pages/TrainingView';
import { TrainingReport } from '../../web/src/pages/TrainingReport';
import { PromptsPage } from '../../web/src/pages/PromptsPage';
import { RouteErrorBoundary } from '../../web/src/components/RouteErrorBoundary';
import { aoVivo, semRodadasCarregadas, tresRodadas } from './trainingViewFixture';

type AnyRecord = Record<string, any>;
interface FakeControl {
  state: {
    sessions: Map<string, AnyRecord>;
    runs: Map<string, AnyRecord>;
    runsPending: boolean;
    cancellable: Set<string>;
  };
  reset(): void;
}

const fake = (globalThis as unknown as { __tvFake: FakeControl }).__tvFake;
let root: Root | null = null;

function seed(scenario: string): string {
  fake.reset();
  const put = (s: AnyRecord, runs: AnyRecord[]) => {
    fake.state.sessions.set(s.id, s);
    for (const r of runs) fake.state.runs.set(r.id, r);
    return s.id as string;
  };
  switch (scenario) {
    case 'tres-rodadas': {
      const { session, runs } = tresRodadas();
      return put(session, runs);
    }
    case 'sem-rodadas-finished':
    case 'sem-rodadas-running': {
      const s = semRodadasCarregadas(scenario.endsWith('running') ? 'running' : 'finished');
      fake.state.runsPending = true;
      if (s.status === 'running') fake.state.cancellable.add(s.id);
      return put(s, []);
    }
    case 'ao-vivo': {
      const { session, runs } = aoVivo();
      fake.state.cancellable.add(session.id);
      return put(session, runs);
    }
    default:
      throw new Error(`cenário desconhecido: ${scenario}`);
  }
}

const harness = {
  /**
   * Semeia o cenário e monta `/training/:id` do zero (ou `path`, com `:sid`
   * trocado pelo id). `keep: true` remonta SEM ressemear — a biblioteca e as
   * sessões do fake continuam (ex.: salvar no treino e abrir /prompts).
   * Devolve o id da sessão.
   */
  mount(scenario: string, opts: { path?: string; keep?: boolean } = {}): string {
    root?.unmount();
    const sid = opts.keep ? scenario : seed(scenario);
    const path = (opts.path ?? '/training/:sid').replace(':sid', sid);
    const el = document.getElementById('root')!;
    root = createRoot(el);
    root.render(
      <StrictMode>
        <MemoryRouter initialEntries={[path]}>
          <RouteErrorBoundary>
            <Routes>
              <Route path="/training/:sessionId" element={<TrainingView />} />
              <Route path="/training/:sessionId/report" element={<TrainingReport />} />
              <Route path="/prompts" element={<PromptsPage />} />
              <Route path="*" element={<div data-testid="outra-rota" />} />
            </Routes>
          </RouteErrorBoundary>
        </MemoryRouter>
      </StrictMode>,
    );
    return sid;
  },
};

(globalThis as unknown as { __tv: typeof harness }).__tv = harness;
(globalThis as unknown as { __tvReady: boolean }).__tvReady = true;
