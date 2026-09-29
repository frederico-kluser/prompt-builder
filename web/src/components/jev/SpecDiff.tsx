import { diffLines } from '../../diff';
import { DiffView, MiniLabel } from '../primitives';
import type { JevSpec } from '../../engine/jev';

/**
 * Diff da definição original × campeã, POR PERGUNTA (o treino muda uma
 * pergunta por variante; as irmãs ficam congeladas). Texto = JSON da pergunta
 * como vai ao fio — o mesmo que o `jev export` entrega.
 */

function texto(q: unknown): string {
  return JSON.stringify(q, null, 2);
}

export function SpecDiff({ original, champion }: { original: JevSpec; champion: JevSpec }) {
  const mudadas = original.questions
    .map((q) => ({ q, c: champion.questions.find((x) => x.id === q.id) }))
    .filter(({ q, c }) => c && texto(q) !== texto(c));
  const view = JSON.stringify(original.stateView ?? null) !== JSON.stringify(champion.stateView ?? null);
  if (!mudadas.length && !view) {
    return <p className="text-[13px] text-muted-foreground">A campeã é a própria definição original — nenhuma variante superou o gate.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {mudadas.map(({ q, c }) => (
        <div key={q.id} className="flex flex-col gap-1">
          <MiniLabel>
            pergunta <code className="font-mono normal-case">{q.id}</code>
          </MiniLabel>
          <DiffView diff={diffLines(texto(q), texto(c))} />
        </div>
      ))}
      {view && (
        <div className="flex flex-col gap-1">
          <MiniLabel>projeção do estado (stateView)</MiniLabel>
          <DiffView diff={diffLines(texto(original.stateView ?? null), texto(champion.stateView ?? null))} />
        </div>
      )}
    </div>
  );
}
