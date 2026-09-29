// Seletor "LLM | JEV" de `/new` — módulo LEVE, sem o motor JEV.
//
// left#15: morava em `./form.ts`, que importa o motor JEV inteiro
// (`../engine/jev`): o `NewBenchmark` (rota de entrada) puxava o JEV para o
// chunk principal só para ler uma chave do localStorage. `./form.ts`
// re-exporta daqui — quem já importava de lá segue funcionando.

/** "Modo JEV" é a escolha lembrada? (`?tipo=` > handoffs LLM > `pb.benchKind`). */
export type BenchKind = 'llm' | 'jev';

export const BENCH_KIND_KEY = 'pb.benchKind';

/**
 * Qual lado do seletor abre. Precedência (crítica A4.1): `?tipo=` explícito;
 * depois os handoffs que IMPLICAM LLM (`?objetivo=` vindo do /welcome e o
 * rascunho da biblioteca `arena:prompt-draft`) — senão o usuário cairia no JEV
 * e perderia o que escolheu; por fim a escolha lembrada; default LLM.
 */
export function initialBenchKind(search: string, storage: Pick<Storage, 'getItem'> | null): BenchKind {
  const q = new URLSearchParams(search);
  const tipo = q.get('tipo');
  if (tipo === 'jev' || tipo === 'llm') return tipo;
  if (q.get('objetivo')) return 'llm';
  try {
    if (storage?.getItem('arena:prompt-draft')) return 'llm';
    const lembrado = storage?.getItem(BENCH_KIND_KEY);
    if (lembrado === 'jev' || lembrado === 'llm') return lembrado;
  } catch {
    // localStorage indisponível (privado/bloqueado): segue o default.
  }
  return 'llm';
}
