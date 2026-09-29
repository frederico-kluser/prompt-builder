import { confusionLabel, confusionTable } from '../../jev/view';
import type { JevRunRecord } from '../../engine/jev';
import { cn } from '@/lib/utils';

/**
 * Matriz de confusão (linhas = ouro, colunas = previsto; "saída" = a opção de
 * abstenção). Intensidade SEQUENCIAL de um só tom (chart-1 misturado ao
 * cartão, 8–60%): mais escuro = mais casos. O número fica sempre no texto
 * (tinta de texto, nunca a cor da série) — o contraste do teto da mistura é
 * medido em test/ux-jev-selector.test.ts nos dois temas. Diagonal = acerto.
 */

export const CONFUSION_MAX_MIX = 60;

export function confusionFill(count: number, max: number): string | undefined {
  if (count <= 0 || max <= 0) return undefined;
  const pct = Math.round(8 + (CONFUSION_MAX_MIX - 8) * (count / max));
  return `color-mix(in oklch, var(--chart-1) ${pct}%, var(--card))`;
}

export function ConfusionMatrix({ run, contestantId, qid }: { run: JevRunRecord; contestantId: string; qid: string }) {
  const t = confusionTable(run, contestantId, qid);
  if (t.n === 0) return <p className="text-[13px] text-muted-foreground">Sem respostas pontuadas nesta pergunta.</p>;
  const rotulo = (k: string) => confusionLabel(run, qid, k);
  return (
    <div className="scroll-slim overflow-x-auto">
      <table className="border-separate border-spacing-[2px] text-[12px] tabular">
        <caption className="mb-1.5 text-left text-[12px] text-muted-foreground">
          Linhas: ouro · colunas: previsto · {t.n} resposta(s)
        </caption>
        <thead>
          <tr>
            <th scope="col" className="px-2 py-1 text-left font-medium text-muted-foreground">
              ouro ＼ previsto
            </th>
            {t.predicted.map((p) => (
              <th key={p} scope="col" className="max-w-[7rem] truncate px-2 py-1 text-left font-medium" title={rotulo(p)}>
                {rotulo(p)}
              </th>
            ))}
            <th scope="col" className="px-2 py-1 text-right font-medium text-muted-foreground">
              acerto
            </th>
          </tr>
        </thead>
        <tbody>
          {t.gold.map((g, i) => {
            const diag = t.predicted.indexOf(g);
            const acerto = diag >= 0 && t.rowTotals[i] ? t.counts[i][diag] / t.rowTotals[i] : 0;
            return (
              <tr key={g}>
                <th scope="row" className="max-w-[9rem] truncate px-2 py-1 text-left font-medium" title={rotulo(g)}>
                  {rotulo(g)}
                </th>
                {t.counts[i].map((n, j) => (
                  <td
                    key={t.predicted[j]}
                    className={cn(
                      'min-w-10 rounded-[4px] px-2 py-1 text-center text-foreground',
                      n === 0 && 'text-muted-foreground/60',
                      j === diag && 'font-semibold ring-1 ring-foreground/25 ring-inset',
                    )}
                    style={{ background: confusionFill(n, t.max) }}
                    title={`ouro ${rotulo(g)} → previsto ${rotulo(t.predicted[j])}: ${n} (${t.rowTotals[i] ? Math.round((n / t.rowTotals[i]) * 100) : 0}% da linha)`}
                  >
                    {n}
                  </td>
                ))}
                <td className="px-2 py-1 text-right text-muted-foreground">{Math.round(acerto * 100)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
