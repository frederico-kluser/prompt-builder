import { useMemo, useState } from 'react';
import { SegmentedToggle, SegmentedToggleOption } from '@/components/motion-ui/segmented-toggle';
import { fmtNum, type JevRunRecord } from '../../engine/jev';
import type { GridCell, GridRow } from '../../jev/view';
import { cn } from '@/lib/utils';

/**
 * Caso × competidor numa pergunta: acerto/erro com a probabilidade da classe
 * prevista e a banda. Os tons de veredito (`resolve`/`nao` + `-soft`) são DADO
 * — o contraste AA em 13px dos pares usados aqui é medido nos dois temas
 * (test/ux-jev-selector.test.ts). O símbolo (✓ ✗ !) repete a informação: cor
 * nunca é o único canal. "Errado com confiança" = erro dentro da banda auto.
 */

type Filtro = 'todos' | 'erros' | 'confiantes';

const CELL_CLASS: Record<GridCell['state'], string> = {
  hit: 'bg-resolve-soft text-resolve',
  miss: 'bg-nao-soft text-nao',
  invalid: 'bg-nao-soft text-nao',
  noscore: 'bg-muted text-muted-foreground',
  incomplete: 'bg-muted text-muted-foreground',
  nogold: 'text-muted-foreground/60',
};

function simbolo(c: GridCell): string {
  if (c.state === 'hit') return '✓';
  if (c.state === 'invalid') return 'inv';
  if (c.state === 'miss') return c.wrongConfident ? '✗!' : '✗';
  if (c.state === 'noscore') return '—';
  if (c.state === 'incomplete') return '…';
  return '';
}

function dica(c: GridCell, label: string): string {
  const base: Record<GridCell['state'], string> = {
    hit: 'acertou',
    miss: c.wrongConfident ? 'errou COM CONFIANÇA (banda auto)' : 'errou',
    invalid: 'resposta fora do contrato (conta errado)',
    noscore: 'sem nota (erro de infraestrutura/bloqueio)',
    incomplete: 'caso incompleto (orçamento/cancelamento): fora das métricas',
    nogold: 'caso sem ouro nesta pergunta',
  };
  const extra = c.predicted !== null ? ` · previu ${c.predicted}` : '';
  const p = c.pTop !== null ? ` · p=${fmtNum(c.pTop, 2)}` : '';
  const banda = c.band ? ` · banda ${c.band === 'hitl' ? 'revisão' : c.band === 'abstain' ? 'abstém' : 'auto'}` : '';
  return `${label}: ${base[c.state]}${extra}${p}${banda}`;
}

export function CaseGrid({ run, rows }: { run: JevRunRecord; rows: GridRow[] }) {
  const [filtro, setFiltro] = useState<Filtro>('todos');
  const [limite, setLimite] = useState(60);
  const visiveis = useMemo(
    () =>
      rows.filter((r) =>
        filtro === 'todos'
          ? true
          : filtro === 'erros'
            ? r.cells.some((c) => c.state === 'miss' || c.state === 'invalid')
            : r.cells.some((c) => c.wrongConfident),
      ),
    [rows, filtro],
  );
  const labels = new Map(run.contestants.map((c) => [c.id, c.label]));
  const nConf = rows.filter((r) => r.cells.some((c) => c.wrongConfident)).length;
  const nErr = rows.filter((r) => r.cells.some((c) => c.state === 'miss' || c.state === 'invalid')).length;

  return (
    <div className="flex flex-col gap-2.5">
      <SegmentedToggle value={filtro} onChange={(v) => setFiltro(v as Filtro)} ariaLabel="Filtrar casos">
        <SegmentedToggleOption value="todos" className="px-2.5 py-1 text-[12.5px]">
          Todos <span className="text-[11px] opacity-70 tabular">{rows.length}</span>
        </SegmentedToggleOption>
        <SegmentedToggleOption value="erros" className="px-2.5 py-1 text-[12.5px]">
          Com erro <span className="text-[11px] opacity-70 tabular">{nErr}</span>
        </SegmentedToggleOption>
        <SegmentedToggleOption value="confiantes" className="px-2.5 py-1 text-[12.5px]">
          Errados com confiança <span className="text-[11px] opacity-70 tabular">{nConf}</span>
        </SegmentedToggleOption>
      </SegmentedToggle>
      <div className="scroll-slim max-h-[32rem] overflow-auto rounded-lg border border-border">
        <table className="w-full border-separate border-spacing-0 text-left text-[12.5px]">
          <caption className="sr-only">Resultado por caso e competidor</caption>
          <thead className="sticky top-0 z-10 bg-muted text-[11px] text-muted-foreground">
            <tr>
              <th scope="col" className="px-2.5 py-1.5 font-medium">caso</th>
              <th scope="col" className="px-2.5 py-1.5 font-medium">ouro</th>
              {run.contestants.map((c) => (
                <th key={c.id} scope="col" className="max-w-[8rem] truncate px-2 py-1.5 text-center font-medium" title={c.label}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visiveis.slice(0, limite).map((r) => (
              <tr key={r.caseId} className="align-top">
                <td className="max-w-[20rem] border-t border-border px-2.5 py-1.5">
                  <code className="block font-mono text-[11px] text-muted-foreground">{r.caseId}</code>
                  <span className="line-clamp-2 text-[12px]">{r.preview}</span>
                </td>
                <td className="border-t border-border px-2.5 py-1.5 font-mono text-[11.5px]">{r.gold}</td>
                {r.cells.map((c) => (
                  <td key={c.contestantId} className="border-t border-border px-1 py-1 text-center">
                    <span
                      className={cn(
                        'inline-flex min-w-12 flex-col items-center rounded-md px-1.5 py-0.5 text-[12px] font-medium tabular',
                        CELL_CLASS[c.state],
                        c.wrongConfident && 'ring-1 ring-nao ring-inset',
                      )}
                      title={dica(c, labels.get(c.contestantId) ?? c.contestantId)}
                    >
                      <span aria-hidden="true">{simbolo(c)}</span>
                      <span className="sr-only">{dica(c, labels.get(c.contestantId) ?? c.contestantId)}</span>
                      {c.pTop !== null && <span className="text-[10.5px] font-normal">{fmtNum(c.pTop, 2)}</span>}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visiveis.length > limite && (
        <button type="button" className="self-start text-[12.5px] text-primary underline-offset-4 hover:underline" onClick={() => setLimite((l) => l + 120)}>
          mostrar mais ({visiveis.length - limite} restantes)
        </button>
      )}
    </div>
  );
}
