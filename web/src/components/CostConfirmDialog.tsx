import { useRef } from 'react';
import { Modal } from './Modal';
import { Banner } from './primitives';
import { Button } from '@/components/ui/button';
import {
  costConfirmationReason,
  UNESTIMABLE_COST_LABEL,
  UNKNOWN_PRICE_LABEL,
  type LaunchCostEstimate,
} from '../api';

// Confirmação de custo ANTES de rodar (IMPL-020, R-10:REC-3 Q5c): acima de
// US$ 1 (faixa alta) — ou com preço desconhecido — a run só começa com um "sim"
// explícito, depois de o usuário ver a FAIXA low–high e os DRIVERS do custo.
// A faixa é a mesma conta que as portas de orçamento do motor usam.
//
// O foco inicial vai para "Voltar", a ação SEGURA: quem envia o formulário com
// Enter e segura a tecla não pode confirmar o gasto pelo auto-repeat do teclado
// antes de ler a faixa.

function usd(v: number): string {
  if (!v) return 'US$ 0';
  if (v < 0.01) return `US$ ${v.toFixed(4)}`;
  return `US$ ${v.toFixed(2)}`;
}

export function CostConfirmDialog({
  estimate,
  mode,
  onConfirm,
  onClose,
}: {
  /** null = fechado. */
  estimate: LaunchCostEstimate | null;
  mode: 'compare' | 'variation' | 'training';
  onConfirm: () => void;
  onClose: () => void;
}) {
  const backRef = useRef<HTMLButtonElement>(null);
  const a = estimate?.assumptions;
  const motivo = estimate ? costConfirmationReason(estimate) : null;
  const alvo = mode === 'training' ? 'sessão de treino' : 'run';
  return (
    <Modal open={estimate !== null} onClose={onClose} label="Confirmar custo estimado" initialFocus={backRef}>
      {estimate && a && (
        <div className="flex flex-col gap-4 overflow-y-auto p-5">
          <div className="pr-8">
            <h2 className="font-heading text-lg font-medium tracking-tight">Confirmar custo estimado</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {motivo === 'unpriced' ? (
                <>
                  Esta {alvo} usa modelo sem preço no catálogo: a faixa abaixo o conta como zero, então o custo
                  real pode passar dela sem aviso.
                </>
              ) : motivo === 'unknown' ? (
                // web-code#7: a faixa CABE no limiar — o que falta é poder limitar
                // o custo do modelo de preço variável, não um custo alto.
                <>
                  Esta {alvo} usa modelo de preço {UNKNOWN_PRICE_LABEL} (ex.: roteado pelo OpenRouter): ele
                  fica fora da faixa abaixo ({UNESTIMABLE_COST_LABEL}), então o custo real pode passar dela.
                </>
              ) : (
                <>
                  Esta {alvo} pode custar mais de {usd(estimate.thresholdUsd)}
                  {motivo === 'both'
                    ? estimate.unpricedModelIds.length > 0
                      ? ' — e usa modelo sem preço no catálogo, contado como zero'
                      : ` — e usa modelo de preço ${UNKNOWN_PRICE_LABEL}, fora da soma`
                    : ''}
                  .
                </>
              )}{' '}
              A faixa é larga de propósito: não dá para saber quantos tokens cada resposta vai usar.
            </p>
          </div>

          <div className="rounded-lg border border-border px-4 py-3">
            <div className="text-[11px] tracking-wide text-muted-foreground uppercase">faixa estimada</div>
            <div className="mt-0.5 font-heading text-2xl font-medium tabular">
              {usd(estimate.low)} – {usd(estimate.high)}
            </div>
            <div className="mt-1 text-[12px] text-muted-foreground tabular">
              {a.stages} cenário(s)
              {a.repeats > 1 ? ` × ${a.repeats} repetições` : ''} × {a.contestants} participante(s) × {a.judges} juiz(es)
              {a.iterations > 1 ? ` × até ${a.iterations} rodadas` : ''}
            </div>
          </div>

          <div>
            <div className="mb-2 text-[11px] tracking-wide text-muted-foreground uppercase">o que pesa na conta</div>
            <ul className="flex flex-col gap-2">
              {estimate.drivers.map((d) => (
                <li key={d.role} className="text-[13px]">
                  <div className="flex items-baseline justify-between gap-3">
                    <span>
                      {d.label}
                      <span className="text-muted-foreground"> · {d.calls} chamada(s)</span>
                    </span>
                    <span className="shrink-0 font-mono tabular">
                      até {usd(d.usd)} <span className="text-muted-foreground">({Math.round(d.share * 100)}%)</span>
                    </span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, d.share * 100)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {estimate.unpricedModelIds.length > 0 && (
            <Banner tone="warn">
              Sem preço no catálogo (contados como zero — o custo real pode ser maior):{' '}
              {estimate.unpricedModelIds.join(', ')}.
            </Banner>
          )}
          {(estimate.unknownPriceModelIds?.length ?? 0) > 0 && (
            <Banner tone="warn">
              Preço {UNKNOWN_PRICE_LABEL} (fora da soma — o custo real pode ser maior):{' '}
              {estimate.unknownPriceModelIds.join(', ')}.
            </Banner>
          )}
          {estimate.budgetUsd !== undefined ? (
            <Banner tone={estimate.budgetBelowLow ? 'warn' : 'neutral'}>
              Teto de orçamento: {usd(estimate.budgetUsd)}.{' '}
              {estimate.budgetBelowLow
                ? 'Está abaixo do piso da faixa: a run quase certamente para antes do fim, com resultado parcial.'
                : estimate.budgetBelowHigh
                  ? 'Se o gasto real encostar no teto, a run para numa fronteira de fase, com resultado parcial.'
                  : 'A faixa cabe no teto.'}
            </Banner>
          ) : (
            <p className="text-[12px] text-muted-foreground">
              Sem teto de orçamento — defina um em Avançado para a run parar sozinha antes de passar dele.
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
            <Button ref={backRef} type="button" variant="ghost" size="sm" onClick={onClose}>
              Voltar
            </Button>
            <Button type="button" size="sm" onClick={onConfirm}>
              Confirmar e iniciar
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
