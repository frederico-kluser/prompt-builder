// GUARDA DE SINCRONIA do motor duplicado (F0 do PLANO-PARIDADE, item 9.3).
//
// O motor vive em `src/` (Node: CLI + servidor) e em `web/src/engine/` (SPA
// client-side). O plano mandava IMPLEMENTAR TUDO 2× enquanto os dois lados
// forem cópias; esta guarda transforma a duplicação num contrato verificável:
//
//   • `shim`  — o arquivo do web é um re-export do canônico em `src/`
//               (fonte única; impossível divergir);
//   • `mirror`— cópia mantida à mão porque o seam é outro (fs vs IndexedDB,
//               budget/ledger, modo agente, fetch do navegador). Precisa existir
//               nos DOIS lados e ser atualizada em par;
//   • `web-only` / `src-only` — legítimos de um lado só.
//
// Um módulo NOVO em qualquer dos lados derruba este teste até ser classificado.
// É proposital: é a única forma de o próximo campo/feature não nascer duplicado
// e divergir em silêncio (como `stats.pairKeys` divergiu — o web ficou sem ele).

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const WEB_ENGINE = join(ROOT, 'web', 'src', 'engine');

/** Classificação obrigatória de todo módulo do espelho web. */
const CLASSIFICACAO: Record<string, 'shim' | 'mirror' | 'web-only'> = {
  // Fonte única: canônico em src/, o web re-exporta.
  dedup: 'shim',
  holdout: 'shim',
  llmVariants: 'shim',
  medals: 'shim',
  normalize: 'shim',
  rank: 'shim',
  reasoning: 'shim',
  scenarioPack: 'shim',
  stats: 'shim',
  techniques: 'shim',
  // IMPL-021 (R-09:REC-2): gateway único com configuração INJETADA — o shim do
  // web só acrescenta a config do navegador (origem da página) — e os 6
  // módulos de papel, que agora chamam o MESMO gateway com role + sink.
  openrouter: 'shim',
  competitor: 'shim',
  datagen: 'shim',
  gabarito: 'shim',
  judge: 'shim',
  refJudge: 'shim',
  variator: 'shim',
  // Pares mantidos à mão (seams diferentes). Ao mudar UM lado, mude o outro.
  configFile: 'mirror',
  duels: 'mirror', // a MATEMÁTICA é compartilhada via src/engine/duelCore.ts (src lê dossiê de agente do disco)
  events: 'mirror',
  orchestrator: 'mirror',
  storage: 'mirror',
  trainer: 'mirror',
  types: 'mirror',
  // Client-only de propósito.
  promptStore: 'web-only',
};

/**
 * Módulos que o gateway/papéis arrastam para o bundle do navegador NÃO podem
 * tocar Node: nada de `node:*`/builtins nem de `process.env` (o Vite não
 * polifila `process`; a SPA quebraria em runtime com "process is not defined").
 */
const NODE_BUILTINS = new Set([
  'fs', 'fs/promises', 'path', 'os', 'child_process', 'crypto', 'url', 'util', 'stream',
  'http', 'https', 'net', 'events', 'worker_threads', 'module', 'readline', 'zlib',
]);

const semExt = (f: string): string => f.replace(/\.ts$/, '');

describe('guarda de sincronia src/ × web/src/engine/', () => {
  const webFiles = readdirSync(WEB_ENGINE)
    .filter((f) => f.endsWith('.ts'))
    .map(semExt);

  it('todo módulo do espelho web está classificado (novo arquivo = decidir o destino)', () => {
    const naoClassificados = webFiles.filter((f) => !(f in CLASSIFICACAO));
    expect(naoClassificados, 'classifique em test/engine-sync.test.ts: shim | mirror | web-only').toEqual([]);
    const sumidos = Object.keys(CLASSIFICACAO).filter((f) => !webFiles.includes(f));
    expect(sumidos, 'módulos classificados que não existem mais').toEqual([]);
  });

  it('shims re-exportam do canônico (fonte única real)', () => {
    for (const [nome, kind] of Object.entries(CLASSIFICACAO)) {
      if (kind !== 'shim') continue;
      const caminho = join(WEB_ENGINE, `${nome}.ts`);
      const fonte = readFileSync(caminho, 'utf8');
      expect(fonte, `web/src/engine/${nome}.ts deve re-exportar src/${nome}.js`).toContain(
        `from '../../../src/${nome}.js'`,
      );
      // E o canônico precisa existir.
      expect(existsSync(join(SRC, `${nome}.ts`)), `src/${nome}.ts sumiu`).toBe(true);
    }
  });

  it('mirrors existem nos dois lados (par obrigatório)', () => {
    for (const [nome, kind] of Object.entries(CLASSIFICACAO)) {
      if (kind !== 'mirror') continue;
      expect(existsSync(join(SRC, `${nome}.ts`)), `src/${nome}.ts (par do mirror) sumiu`).toBe(true);
      expect(existsSync(join(WEB_ENGINE, `${nome}.ts`))).toBe(true);
    }
  });

  it('shims do gateway e dos 6 papéis são o MESMO objeto nos dois motores (IMPL-021)', async () => {
    type Mod = Record<string, unknown>;
    const pares: Array<[string, Mod, Mod, string[]]> = [
      ['openrouter', await import('../src/openrouter.js'), await import('../web/src/engine/openrouter.js'),
        ['chatCompletion', 'chatCompletionStream', 'listModels', 'validateKey', 'getGateway']],
      ['competitor', await import('../src/competitor.js'), await import('../web/src/engine/competitor.js'),
        ['runCompetitor']],
      ['datagen', await import('../src/datagen.js'), await import('../web/src/engine/datagen.js'),
        ['generateStages']],
      ['gabarito', await import('../src/gabarito.js'), await import('../web/src/engine/gabarito.js'),
        ['generateReferences']],
      ['judge', await import('../src/judge.js'), await import('../web/src/engine/judge.js'), ['judgeStage']],
      ['refJudge', await import('../src/refJudge.js'), await import('../web/src/engine/refJudge.js'),
        ['judgeStageReference', 'JUDGE_CONTRACT_TEXT']],
      ['variator', await import('../src/variator.js'), await import('../web/src/engine/variator.js'),
        ['generateContestants', 'llmReflectLessons']],
    ];
    for (const [nome, canonico, espelho, fns] of pares) {
      for (const fn of fns) {
        expect(canonico[fn], `src/${nome}.${fn}`).toBeDefined();
        expect(espelho[fn], `web/src/engine/${nome}.${fn} deve ser o de src/`).toBe(canonico[fn]);
      }
    }
    // Uma instância de gateway por aba: o shim configura a MESMA instância
    // padrão que os módulos de papel usam (senão o limitador se partiria em 2).
    const gw = (await import('../src/openrouter.js')).getGateway();
    const gwWeb = (await import('../web/src/engine/openrouter.js')).getGateway();
    expect(gwWeb).toBe(gw);
  });

  it('o grafo importado pelo web não arrasta Node (node:*, builtins, process.env) de src/', () => {
    const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
    const resolve = (from: string, spec: string): string | null => {
      if (!spec.startsWith('.')) return null;
      const base = join(from, '..', spec);
      for (const cand of [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
        if (existsSync(cand) && !cand.endsWith('/')) {
          try {
            readFileSync(cand, 'utf8');
            return cand;
          } catch {
            /* diretório */
          }
        }
      }
      return null;
    };
    const semComentarios = (t: string): string =>
      t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const WEB_SRC = join(ROOT, 'web', 'src');
    const fila = readdirSync(WEB_ENGINE)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(WEB_ENGINE, f));
    fila.push(join(WEB_SRC, 'api.ts'));
    const vistos = new Set<string>();
    const violacoes: string[] = [];
    while (fila.length) {
      const arq = fila.pop()!;
      if (vistos.has(arq)) continue;
      vistos.add(arq);
      const texto = readFileSync(arq, 'utf8');
      const doSrc = arq.startsWith(SRC + '/');
      for (const m of texto.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2] ?? m[3];
        if (!spec) continue;
        if (doSrc && (spec.startsWith('node:') || NODE_BUILTINS.has(spec))) {
          violacoes.push(`${arq.slice(ROOT.length)} importa ${spec}`);
        }
        const alvo = resolve(arq, spec);
        if (alvo) fila.push(alvo);
      }
      if (doSrc && /\bprocess\.env\b/.test(semComentarios(texto))) {
        violacoes.push(`${arq.slice(ROOT.length)} lê process.env`);
      }
    }
    // Sanidade do rastreio: o gateway e os papéis de src/ estão no grafo.
    for (const nome of ['openrouter', 'competitor', 'datagen', 'gabarito', 'judge', 'refJudge', 'variator', 'budget']) {
      expect(vistos.has(join(SRC, `${nome}.ts`)), `src/${nome}.ts no grafo do web`).toBe(true);
    }
    expect(violacoes).toEqual([]);
  });

  it('shim é IDÊNTICO em objeto: importar pelos dois caminhos devolve a mesma função', async () => {
    const canonico = await import('../src/rank.js');
    const espelho = await import('../web/src/engine/rank.js');
    expect(espelho.judgeScoreFromVerdicts).toBe(canonico.judgeScoreFromVerdicts);
    expect(espelho.pickWinner).toBe(canonico.pickWinner);
    const duelsCore = await import('../src/engine/duelCore.js');
    const duelsWeb = await import('../web/src/engine/duels.js');
    expect(duelsWeb.pickFinalists).toBe(duelsCore.pickFinalists);
    expect(duelsWeb.standingsFromDuels).toBe(duelsCore.standingsFromDuels);
  });
});
