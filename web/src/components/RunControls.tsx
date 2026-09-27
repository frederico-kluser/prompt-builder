import { HoldToConfirmButton } from '@/components/motion-ui/hold-to-confirm';
import { Button } from '@/components/ui/button';
import { Banner } from './primitives';
import type { RunPhase } from '../api';

// Controles de execução compartilhados por RunView e TrainingView (IMPL-020):
// o Cancelar (segurar para confirmar — sem diálogo e sem clique acidental) e o
// aviso de parada honesta (orçamento/cancelamento), que diz o que ficou de fora.

/** A fase em que a run parou, na linguagem da tela. */
const STOP_PHASE_LABEL: Record<RunPhase, string> = {
  variants: 'a geração de variantes',
  datagen: 'a geração de cenários',
  gabarito: 'os gabaritos',
  competitors: 'as respostas e o julgamento',
  judging: 'o julgamento',
  finals: 'as finais',
  holdout: 'o holdout',
  agents: 'a execução de agentes',
};

function usd(v: number): string {
  return `US$ ${v.toFixed(v < 1 ? 4 : 2)}`;
}

/**
 * Segurar para cancelar. Cancelar aborta a RAIZ da run: o que está em voo é
 * interrompido e nenhuma chamada nova começa — o que já foi julgado fica.
 */
export function CancelHoldButton({ onConfirm, label = 'Segure para cancelar' }: { onConfirm: () => void; label?: string }) {
  return (
    <HoldToConfirmButton
      holdSeconds={1}
      onConfirm={onConfirm}
      className="!h-8 !w-auto rounded-lg px-3 !text-[0.8rem]"
    >
      {label}
    </HoldToConfirmButton>
  );
}

interface StopInfo {
  status: string;
  stoppedReason?: 'budget' | 'cancelled' | 'orphan';
  stoppedAtPhase?: RunPhase;
  budgetUsd?: number;
  totalCostUsd: number;
  stoppedAtIteration?: number;
  /** Run de rodada de treino: o teto (`budgetUsd`) é o da SESSÃO, não o desta run. */
  sessionId?: string;
}

/**
 * Aviso de parada. `aborted` sem `stoppedReason` é o caso legado (a aba/servidor
 * fechou no meio): a mensagem antiga continua valendo para ele. `orphan`
 * (IMPL-023) é o mesmo acontecimento, agora DETECTADO pelo lock da run.
 */
export function StopBanner({
  info,
  subject,
  legacyText,
  className,
}: {
  info: StopInfo;
  /** 'run' | 'treino' — só muda a concordância do texto. */
  subject: 'run' | 'treino';
  legacyText: string;
  className?: string;
}) {
  if (info.status !== 'aborted') return null;
  const aRun = subject === 'run' ? 'A run' : 'O treino';
  if (info.stoppedReason === 'budget') {
    const onde = info.stoppedAtPhase ? ` antes de ${STOP_PHASE_LABEL[info.stoppedAtPhase]}` : '';
    const iter =
      info.stoppedAtIteration !== undefined ? ` (rodada ${info.stoppedAtIteration + 1})` : '';
    const teto = info.budgetUsd !== undefined ? ` de ${usd(info.budgetUsd)}` : '';
    const daSessao = subject === 'run' && info.sessionId !== undefined;
    return (
      <Banner tone="warn" className={className}>
        <strong>Orçamento esgotado{iter}:</strong> {aRun.toLowerCase()} parou{onde} para não passar do
        teto{daSessao ? ' da sessão de treino' : ''}
        {teto} (gasto{daSessao ? ' desta rodada' : ''}: {usd(info.totalCostUsd)}). O resultado é parcial:
        cenários cortados ficam fora do placar e das médias — nenhuma nota foi inventada para completá-los.
      </Banner>
    );
  }
  if (info.stoppedReason === 'cancelled') {
    const iter =
      info.stoppedAtIteration !== undefined ? ` na rodada ${info.stoppedAtIteration + 1}` : '';
    return (
      <Banner className={className}>
        <strong>{subject === 'run' ? 'Run cancelada' : 'Treino cancelado'}{iter}.</strong> O que já tinha sido
        julgado fica; cenários interrompidos ficam fora do placar (gasto até aqui: {usd(info.totalCostUsd)}).
      </Banner>
    );
  }
  if (info.stoppedReason === 'orphan') {
    return (
      <Banner tone="warn" className={className}>
        <strong>{subject === 'run' ? 'Run interrompida' : 'Treino interrompido'}:</strong> a aba que{' '}
        {subject === 'run' ? 'a executava' : 'o executava'} foi fechada, recarregada ou travou antes do fim. Fica o
        que foi salvo até o último checkpoint; cenários sem julgamento ficam fora do placar e das médias. O gasto
        registrado ({usd(info.totalCostUsd)}) vai até esse checkpoint — chamadas em voo no fechamento podem ter
        sido cobradas sem aparecer aqui (confira o painel do OpenRouter).
      </Banner>
    );
  }
  return <Banner className={className}>{legacyText}</Banner>;
}

/**
 * A run/sessão 'running' aberta nesta tela NÃO roda nesta aba (IMPL-023).
 * `elsewhere`: outra aba segura o lock — a tela mostra o último salvamento e se
 * atualiza sozinha quando ela terminar (ou se aquela aba for fechada).
 * `unsupported`: navegador sem Web Locks — não dá para saber se ainda roda;
 * o usuário pode marcá-la como interrompida.
 */
export function OwnershipBanner({
  state,
  subject,
  onMarkInterrupted,
  className,
}: {
  state: 'elsewhere' | 'unsupported' | null;
  subject: 'run' | 'treino';
  onMarkInterrupted?: () => void;
  className?: string;
}) {
  if (!state) return null;
  const aRun = subject === 'run' ? 'Esta run' : 'Este treino';
  if (state === 'elsewhere') {
    return (
      <Banner className={className}>
        <strong>{aRun} está rodando em outra aba deste navegador.</strong> Acompanhe e cancele por lá; aqui
        aparece o último salvamento, e esta tela se atualiza sozinha quando {subject === 'run' ? 'ela' : 'ele'}{' '}
        terminar — ou vira “interrompid{subject === 'run' ? 'a' : 'o'}” se aquela aba for fechada.
      </Banner>
    );
  }
  return (
    <Banner tone="warn" className={className}>
      <span>
        <strong>Não dá para saber se {aRun.toLowerCase()} ainda roda:</strong> este navegador não oferece Web Locks
        (exclusão entre abas). Se a aba que {subject === 'run' ? 'a' : 'o'} executava já foi fechada ou recarregada,
        marque {subject === 'run' ? 'a run' : 'o treino'} como interrompid{subject === 'run' ? 'a' : 'o'}.
      </span>
      {onMarkInterrupted && (
        <div className="mt-2">
          <Button variant="outline" size="sm" onClick={onMarkInterrupted}>
            Marcar como interrompid{subject === 'run' ? 'a' : 'o'}
          </Button>
        </div>
      )}
    </Banner>
  );
}
