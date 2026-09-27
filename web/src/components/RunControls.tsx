import { HoldToConfirmButton } from '@/components/motion-ui/hold-to-confirm';
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
  stoppedReason?: 'budget' | 'cancelled';
  stoppedAtPhase?: RunPhase;
  budgetUsd?: number;
  totalCostUsd: number;
  stoppedAtIteration?: number;
}

/**
 * Aviso de parada. `aborted` sem `stoppedReason` é o caso legado (a aba/servidor
 * fechou no meio): a mensagem antiga continua valendo para ele.
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
    return (
      <Banner tone="warn" className={className}>
        <strong>Orçamento esgotado{iter}:</strong> {aRun.toLowerCase()} parou{onde} para não passar do
        teto{teto} (gasto: {usd(info.totalCostUsd)}). O resultado é parcial: cenários cortados ficam fora do
        placar e das médias — nenhuma nota foi inventada para completá-los.
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
  return <Banner className={className}>{legacyText}</Banner>;
}
