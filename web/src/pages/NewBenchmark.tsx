import { Suspense, lazy, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, Crosshair } from 'lucide-react';
import { SegmentedToggle, SegmentedToggleOption } from '@/components/motion-ui/segmented-toggle';
import { NewRun } from './NewRun';
import { BENCH_KIND_KEY, initialBenchKind, type BenchKind } from '../jev/benchKind';

// left#15: o formulário JEV (e o motor JEV) vira chunk próprio — "quem nunca
// abre o JEV não paga nada por ele" passa a valer também para o download.
const NewJevRun = lazy(async () => ({ default: (await import('./jev/NewJevRun')).NewJevRun }));

/**
 * `/new` — o SELETOR "LLM | JEV" (D-12) é a primeira escolha da página, acima
 * da barra Guiado/Completo de cada formulário. É um wrapper: `NewRun` (LLM,
 * 1.944 linhas, duas superfícies) e `GuidedSetup` ficam INTOCADOS.
 *
 * Precedência da escolha (crítica A4.1, `initialBenchKind`): `?tipo=jev|llm`;
 * depois os handoffs que implicam LLM (`?objetivo=` do /welcome e o rascunho
 * da biblioteca `arena:prompt-draft`); por fim a escolha lembrada
 * (`localStorage['pb.benchKind']`, sempre em try/catch); default LLM.
 *
 * Cada lado só é montado quando visitado e fica montado (escondido) depois:
 * trocar de lado não perde o que foi preenchido, e quem nunca abre o JEV não
 * paga nada por ele.
 */

const HELP: Record<BenchKind, string> = {
  llm: 'Compara modelos e evolui system prompts que geram texto.',
  jev: 'Mede e evolui decisões tipadas (sim/não, escolha, escala) do Jev em casos rotulados.',
};

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function NewBenchmark() {
  const location = useLocation();
  const navigate = useNavigate();
  const [kind, setKind] = useState<BenchKind>(() => initialBenchKind(location.search, storage()));
  const [visitados, setVisitados] = useState<ReadonlySet<BenchKind>>(() => new Set([kind]));

  function escolher(k: BenchKind) {
    setKind(k);
    setVisitados((v) => (v.has(k) ? v : new Set([...v, k])));
    try {
      storage()?.setItem(BENCH_KIND_KEY, k);
    } catch {
      // armazenamento indisponível: a escolha vale só nesta visita.
    }
    // Deep link estável: /new?tipo=jev abre direto no JEV.
    const q = new URLSearchParams(location.search);
    q.set('tipo', k);
    navigate({ search: `?${q.toString()}` }, { replace: true });
  }

  return (
    <>
      <div className="mx-auto w-full max-w-3xl px-5 sm:px-6">
        <div className="mb-6 flex flex-col gap-2">
          <SegmentedToggle
            value={kind}
            onChange={(v) => escolher(v as BenchKind)}
            ariaLabel="Tipo de benchmark"
            className="w-full sm:w-fit"
          >
            <SegmentedToggleOption value="llm" className="flex-1 justify-center px-4 py-1.5 text-[13px] whitespace-nowrap">
              LLM
            </SegmentedToggleOption>
            <SegmentedToggleOption value="jev" className="flex-1 justify-center px-4 py-1.5 text-[13px] whitespace-nowrap">
              JEV (decisões)
            </SegmentedToggleOption>
          </SegmentedToggle>
          <p className="text-[13px] text-muted-foreground" data-bench-help={kind}>
            {HELP[kind]}
          </p>
          <Link
            to="/vision"
            className="mt-1 flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:bg-muted/60"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Crosshair className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Benchmark de visão</span>
              <span className="block text-[12px] text-muted-foreground">
                O modelo lê uma tela 1080p e devolve o que é clicável — placar determinístico, com mapa de calor por modelo.
              </span>
            </span>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Link>
        </div>
      </div>
      {visitados.has('llm') && (
        <div hidden={kind !== 'llm'} data-bench="llm">
          <NewRun />
        </div>
      )}
      {visitados.has('jev') && (
        <div hidden={kind !== 'jev'} data-bench="jev">
          <Suspense
            fallback={
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 sm:px-6" role="status" aria-label="Carregando o formulário JEV…">
                <div className="h-10 w-2/3 animate-pulse rounded-lg bg-muted" />
                <div className="h-72 w-full animate-pulse rounded-xl bg-muted" />
              </div>
            }
          >
            <NewJevRun />
          </Suspense>
        </div>
      )}
    </>
  );
}
