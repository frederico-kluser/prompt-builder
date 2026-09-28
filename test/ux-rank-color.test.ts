// IMPL-109 (R-11c:REC-1) — cor por valor semântico, empate em texto, AA medido.
//
// Antes: rankColor() desenhava uma rampa contínua hue 145→6 (verde→vermelho,
// colapsa sob deuteranopia/protanopia) usada POR POSIÇÃO — o pódio punha
// numeral branco sobre hsl(h 62% 44%) medido em 2,36–3,16:1 (reprova AA) e o
// placar de evolução coloria por lugar, dando cor diferente a empates e
// mudando o significado da cor por coluna. "Não participou" era um '·' mudo.
//
// Política nova: score em texto neutro; cor SÓ nos tokens de veredito (com
// glifo); empate com marcador não cromático idêntico nas linhas empatadas
// (sufixo 'E' + 'empatado com X' no resumo); pódio com número em texto sobre
// fundo neutro + medalha textual; rankColor REMOVIDO.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  accessibleText,
  allText,
  contrastRatio,
  innersOf,
  mixAlpha,
  openTagsOf,
  readThemeTokens,
  type Rgb,
} from './uxHtml';

const ROOT = process.cwd();
const WEB_REACT = join(ROOT, 'web', 'node_modules', 'react', 'index.js');
const WEB_REACT_DOM_SERVER = join(ROOT, 'web', 'node_modules', 'react-dom', 'server.node.js');
const temWebDeps = existsSync(WEB_REACT) && existsSync(WEB_REACT_DOM_SERVER);

vi.mock('@/components/motion-ui/accordion', () => ({
  Accordion: (p: { children?: unknown }) => p.children,
  AccordionItem: (p: { children?: unknown }) => p.children,
  AccordionTrigger: (p: { children?: unknown }) => p.children,
  AccordionPanel: (p: { children?: unknown }) => p.children,
}));
vi.mock('@/components/motion-ui/progress-bar', () => ({ ProgressBar: () => null }));
vi.mock('@/components/motion-ui/sparkline', async () => {
  const real = await import(
    pathToFileURL(join(ROOT, 'web', 'src', 'components', 'motion-ui', 'sparkline', 'index.tsx')).href
  );
  return real;
});
vi.mock('@/components/motion-ui/ui-theme', () => ({
  useMotionUITransition: () => ({}),
  useMotionUITheme: () => ({ motionMode: 'off' }),
}));
vi.mock('@/components/motion-ui/stagger-reveal', () => ({
  StaggerReveal: (p: { children?: unknown }) => p.children,
  StaggerRevealHeadline: (p: { children?: unknown }) => p.children,
  StaggerRevealItem: (p: { children?: unknown }) => p.children,
}));
vi.mock('@/lib/utils', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }));

type AnyRec = Record<string, any>;

describe('IMPL-109 (i) — rankColor fora do FinalsPanel/TrainingView/placar', () => {
  it('nenhuma referência a rankColor nas fontes de UI de run', () => {
    for (const f of ['web/src/pages/runShared.tsx', 'web/src/pages/TrainingView.tsx', 'web/src/pages/RunView.tsx']) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(src.includes('rankColor'), `${f} ainda menciona rankColor`).toBe(false);
    }
  });

  it('pódio sem cor por posição: sem texto branco sobre rampa e sem style de fundo', async () => {
    const src = readFileSync(join(ROOT, 'web/src/pages/runShared.tsx'), 'utf8');
    // O numeral do pódio era `text-white` com `style={{ background: …}}`.
    expect(src).not.toMatch(/text-white/);
    const finals = src.slice(src.indexOf('export function FinalsPanel'));
    expect(finals).not.toMatch(/style=\{\{\s*background/);
    expect(finals).not.toMatch(/rankColor/);
  });
});

describe('IMPL-109 (ii) — empate com marcador textual idêntico', () => {
  it('tieMarks dá o MESMO marcador às linhas empatadas e nomeia as demais', async () => {
    const { tieMarks, TIE_MARKER } = await import('../web/src/pages/runShared');
    const marks = tieMarks(
      ['a', 'b', 'c'],
      (id) => (id === 'a' ? 50 : id === 'b' ? 50 : 72),
      (id) => ({ a: 'Alpha', b: 'Beta', c: 'Gamma' })[id]!,
    );
    expect(marks.get('a')!.marker).toBe(TIE_MARKER);
    expect(marks.get('b')!.marker).toBe(TIE_MARKER);
    expect(marks.get('a')!.marker).toBe(marks.get('b')!.marker);
    expect(marks.get('a')!.summary).toBe('empatado com Beta');
    expect(marks.get('b')!.summary).toBe('empatado com Alpha');
    expect(marks.has('c')).toBe(false); // quem não empata não ganha marcador
  });

  it.skipIf(!temWebDeps)('FinalsPanel: linhas empatadas mostram o sufixo idêntico + resumo', async () => {
    const { createElement } = await import(pathToFileURL(WEB_REACT).href);
    const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
    const { FinalsPanel } = await import('../web/src/pages/runShared');
    const record: AnyRec = {
      id: 'r1',
      status: 'done',
      contestants: [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta' },
        { id: 'c', label: 'Gamma' },
      ],
      finalists: ['a', 'b', 'c'],
      stages: [],
      // a e b empatam em 50% — o marcador TEM de ser idêntico nas duas linhas.
      standings: [
        { id: 'a', label: 'Alpha', winRate: 0.5, wins: 2, ties: 1, losses: 2 },
        { id: 'b', label: 'Beta', winRate: 0.5, wins: 2, ties: 1, losses: 2 },
        { id: 'c', label: 'Gamma', winRate: 0.25, wins: 1, ties: 1, losses: 3 },
      ],
    };
    const html: string = renderToStaticMarkup(createElement(FinalsPanel, { record }));
    const itens = innersOf(html, 'li');
    expect(itens.length).toBe(3);
    const empatados = itens.filter((li) => accessibleText(li).includes('empatado com'));
    expect(empatados.length).toBe(2);
    // Marcador textual idêntico nas DUAS linhas (sufixo do valor, não cor).
    for (const li of empatados) {
      expect(accessibleText(li)).toContain('50%E');
      expect(allText(li)).toContain('empatado com');
    }
    const marcadores = empatados.map((li) => accessibleText(li).match(/50%(\S*)/)?.[1]);
    expect(marcadores[0]).toBe(marcadores[1]);
    expect(marcadores[0]).toBe('E');
  });

  it.skipIf(!temWebDeps)('pódio: número em texto sobre fundo neutro + medalha textual', async () => {
    const { createElement } = await import(pathToFileURL(WEB_REACT).href);
    const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
    const { FinalsPanel } = await import('../web/src/pages/runShared');
    const record: AnyRec = {
      id: 'r1',
      status: 'done',
      contestants: [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta' },
        { id: 'c', label: 'Gamma' },
      ],
      finalists: ['a', 'b', 'c'],
      stages: [],
      standings: [
        { id: 'a', label: 'Alpha', winRate: 0.75, wins: 3, ties: 0, losses: 1 },
        { id: 'b', label: 'Beta', winRate: 0.5, wins: 2, ties: 1, losses: 1 },
        { id: 'c', label: 'Gamma', winRate: 0.25, wins: 1, ties: 1, losses: 2 },
      ],
    };
    const html: string = renderToStaticMarkup(createElement(FinalsPanel, { record }));
    const texto = allText(html);
    for (const medalha of ['ouro', 'prata', 'bronze']) expect(texto).toContain(medalha);
    // Fundo neutro (bg-muted), nunca hsl de posição nem texto branco.
    expect(html).not.toContain('text-white');
    expect(html).not.toMatch(/style=\{\{\s*background/);
    expect(html).toMatch(/bg-muted[^"]*"[^>]*>\s*1\s*<\/span>/);
  });

  it.skipIf(!temWebDeps)('placar de evolução: empate por rodada com marcador idêntico + resumo', async () => {
    const { createElement } = await import(pathToFileURL(WEB_REACT).href);
    const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
    const { EvolutionHeatmap } = await import('../web/src/pages/runShared');
    // v1 e v2 empatam em 60 na rodada 0 (v3 tem outra nota).
    const rounds: AnyRec[] = [
      {
        id: 'r0',
        iteration: 0,
        contestants: [
          { id: 'v1', label: 'Base' },
          { id: 'v2', label: 'Var' },
          { id: 'v3', label: 'Outra' },
        ],
        stages: [],
        judgeScoreByContestant: { v1: 60, v2: 60, v3: 40 },
      },
    ];
    const html: string = renderToStaticMarkup(createElement(EvolutionHeatmap, { rounds }));
    const tds = innersOf(html, 'td');
    const comMarcador = tds.filter((td) => accessibleText(td).includes('60E'));
    // As DUAS linhas empatadas com o mesmo marcador textual.
    expect(comMarcador.length).toBe(2);
    for (const td of comMarcador) {
      expect(accessibleText(td)).toContain('empatado com');
    }
    // Quem não empata não ganha marcador.
    expect(tds.filter((td) => accessibleText(td).includes('40E')).length).toBe(0);
  });
});

describe('IMPL-109 (iii) — "não participou" tem texto, não só "·"', () => {
  it.skipIf(!temWebDeps)('célula vazia do placar de evolução anuncia "não participou"', async () => {
    const { createElement } = await import(pathToFileURL(WEB_REACT).href);
    const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
    const { EvolutionHeatmap } = await import('../web/src/pages/runShared');
    const rounds: AnyRec[] = [
      {
        id: 'r0',
        iteration: 0,
        contestants: [
          { id: 'v1', label: 'Base' },
          { id: 'v2', label: 'Var' },
        ],
        stages: [],
        judgeScoreByContestant: { v1: 55 }, // v2 não participou
      },
    ];
    const html: string = renderToStaticMarkup(createElement(EvolutionHeatmap, { rounds }));
    const tds = innersOf(html, 'td');
    const alvo = tds.find((td) => accessibleText(td) === 'não participou');
    expect(alvo).toBeDefined();
    expect(alvo).not.toContain('·'); // não é o ponto mudo antigo
  });
});

describe('IMPL-109 (iv) — contraste AA (4,5:1) em todos os pares de célula, nos 2 temas', () => {
  const css = readFileSync(join(ROOT, 'web/src/index.css'), 'utf8');
  const { light, dark } = readThemeTokens(css);

  // Pares texto/fundo que as células do heatmap/placar usam (medidos, não
  // julgados a olho): fundo com alpha compõe sobre `card`.
  const pares: { nome: string; fg: string; bg: string; alpha: number; celulas: string[] }[] = [
    {
      nome: 'veredito resolve',
      fg: 'resolve',
      bg: 'resolve-soft',
      alpha: 1,
      celulas: ['bg-resolve-soft text-resolve'],
    },
    {
      nome: 'veredito parcial',
      fg: 'parcial',
      bg: 'parcial-soft',
      alpha: 1,
      celulas: ['bg-parcial-soft text-parcial'],
    },
    {
      nome: 'veredito não resolve',
      fg: 'nao',
      bg: 'nao-soft',
      alpha: 1,
      celulas: ['bg-nao-soft text-nao'],
    },
    {
      nome: 'resposta com erro',
      fg: 'nao',
      bg: 'nao',
      alpha: 0.15,
      celulas: ['bg-nao/15 text-nao'],
    },
    {
      nome: 'estado neutro (muted)',
      fg: 'muted-foreground',
      bg: 'muted',
      alpha: 1,
      celulas: ['bg-muted text-muted-foreground'],
    },
    {
      nome: 'estado neutro (muted/50)',
      fg: 'muted-foreground',
      bg: 'muted',
      alpha: 0.5,
      celulas: ['bg-muted/50 text-muted-foreground'],
    },
    {
      nome: 'score em texto neutro',
      fg: 'foreground',
      bg: 'muted',
      alpha: 0.5,
      celulas: ['bg-muted/50 text-foreground'],
    },
    {
      nome: 'cabeçalho/rótulo sobre card',
      fg: 'muted-foreground',
      bg: 'card',
      alpha: 1,
      celulas: ['text-muted-foreground', 'text-foreground'],
    },
  ];

  for (const tema of ['light', 'dark'] as const) {
    it(`tema ${tema}: todos os pares de célula ≥ 4,5:1`, () => {
      const tokens = tema === 'light' ? light : dark;
      const card = tokens.card;
      for (const par of pares) {
        const fg: Rgb = tokens[par.fg];
        const bg: Rgb = par.alpha === 1 ? tokens[par.bg] : mixAlpha(tokens[par.bg], card, par.alpha);
        const r = contrastRatio(fg, bg);
        expect(r, `${tema}: ${par.nome} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('as classes de célula do código são exatamente as medidas acima', () => {
    const src = readFileSync(join(ROOT, 'web/src/pages/runShared.tsx'), 'utf8');
    const medidos = new Set(pares.flatMap((p) => p.celulas));
    // Toda classe de célula declarada em heatmapCellState (`cls:`) e em
    // VERDICT_META (`cell:`) passa pelo medidor acima — nada de cor solta sem
    // contraste verificado.
    const declaradas = [...src.matchAll(/(?:cls|cell): '([^']+)'/g)].map((m) => m[1]);
    for (const cls of declaradas) {
      const par = cls.split(' ').sort().join(' ');
      const ok = [...medidos].some((m) => m.split(' ').sort().join(' ') === par);
      expect(ok, `classe de célula não medida: "${cls}"`).toBe(true);
    }
    // E o par que reprovava (bg-nao/20 em dark: 4,43:1) não volta.
    expect(src).not.toContain('bg-nao/20');
  });
});
