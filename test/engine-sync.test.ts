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
  // Pares mantidos à mão (seams diferentes). Ao mudar UM lado, mude o outro.
  competitor: 'mirror',
  configFile: 'mirror',
  datagen: 'mirror',
  duels: 'mirror', // a MATEMÁTICA é compartilhada via src/engine/duelCore.ts
  events: 'mirror',
  gabarito: 'mirror',
  judge: 'mirror',
  openrouter: 'mirror',
  orchestrator: 'mirror',
  refJudge: 'mirror',
  storage: 'mirror',
  trainer: 'mirror',
  types: 'mirror',
  variator: 'mirror',
  // Client-only de propósito.
  promptStore: 'web-only',
};

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
