import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Banner, Screen } from './primitives';
import { Button } from '@/components/ui/button';

// Um widget que lança durante o render NÃO pode apagar o app inteiro: sem
// fronteira, o React desmonta a árvore e a tela fica em branco (foi o que o
// VariantPromptDrawer fazia na tela de Treino). A fronteira é por ROTA — trocar
// de página a reinicia (key = pathname).

interface State {
  error: Error | null;
}

class Boundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] erro de render capturado pela fronteira da rota', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <Screen>
        <div className="flex flex-col gap-4 pt-10">
          <Banner tone="error">
            Esta tela encontrou um erro e não pôde ser exibida: {this.state.error.message}
          </Banner>
          <p className="text-sm text-muted-foreground">
            Seus dados continuam salvos no navegador. Tente recarregar ou volte ao histórico.
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => window.location.reload()}>
              Recarregar
            </Button>
            <Button size="sm" variant="outline" onClick={() => window.location.assign('/runs')}>
              Ir ao histórico
            </Button>
          </div>
        </div>
      </Screen>
    );
  }
}

export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <Boundary key={pathname}>{children}</Boundary>;
}
