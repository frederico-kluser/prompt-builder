// IMPL-108 (R-11c:REC-1) — heatmap/placar como <table> NATIVA.
//
// Antes: o ScoreHeatmap montava uma grade de DIVS (gridTemplateColumns), cada
// célula virava role="button" + tabIndex=0 (M+N·M paradas de Tab) e o nome
// acessível da célula era o GLIFO (✓ ◐ ✕ ⏳ ! ·) — a informação real só vivia
// em `title`. Sem <caption>, <th scope> nem <td>: a associação
// cabeçalho/célula não existia na árvore de acessibilidade.
//
// Aqui o render é REAL (react-dom/server, sem navegador — mesma receita de
// test/price-variable.test.ts) e os critérios são:
//  (i)  paradas de Tab no componente ≤ M+1 (run 4×8: ≤9);
//  (ii) 0 células com nome acessível ∈ glifos;
//  (iii) cada td tem veredito textual;
//  (iv) DOM sem elementos intermediários entre table/tr/td, clique só nos th.

import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { accessibleText, allText, focusStopCount, innersOf, innerOf, openTagsOf } from './uxHtml';

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
// Sparkline REAL (com o label a virar aria-label + role="img") — só o alias
// '@/…' é interceptado; o módulo em si carrega de web/src.
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

/** Run enxuta: contestants + stages já julgados (sem rede, sem motor). */
function record(contestants: AnyRec[], stages: AnyRec[]): AnyRec {
  return { id: 'r1', status: 'done', mode: 'compare', contestants, stages };
}

const GLIFOS = new Set(['✓', '◐', '✕', '⏳', '!', '·', '?', '⊘', '✂', '⏹', '–']);

describe.skipIf(!temWebDeps)('IMPL-108 — ScoreHeatmap como tabela nativa', () => {
  async function renderHeat(props: AnyRec): Promise<string> {
    const { createElement } = await import(pathToFileURL(WEB_REACT).href);
    const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
    const { ScoreHeatmap } = await import('../web/src/pages/runShared');
    return renderToStaticMarkup(createElement(ScoreHeatmap, props));
  }

  // 4 variantes × 8 cenários (o caso do critério i: ≤ 9 paradas de Tab).
  const contestants = [
    { id: 'a', label: 'Alpha', isOriginal: true },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Gamma' },
    { id: 'd', label: 'Delta' },
  ];
  const stages = Array.from({ length: 8 }, (_, i) => ({
    index: i,
    responses: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    judge: {
      verdictByContestant: {
        a: i % 3 === 0 ? 'resolve' : i % 3 === 1 ? 'parcial' : 'nao',
        b: 'resolve',
        c: i % 2 ? 'nao' : 'parcial',
        d: 'resolve',
      },
    },
  }));

  it('(iv) table > caption/thead/tbody > tr > th/td sem divs intermediárias', async () => {
    const html = await renderHeat({ record: record(contestants, stages) });
    const tabela = innerOf(html, 'table');
    expect(tabela).not.toBeNull();
    // Sem elementos intermediários entre table/tr/td (era div>div>div).
    expect(tabela!).not.toContain('<div');
    expect(html).toMatch(/<table[^>]*>/);
    expect(html).toMatch(/<caption[^>]*>/);
    expect(innersOf(html, 'thead').length).toBe(1);
    expect(innersOf(html, 'tbody').length).toBe(1);
    // Cabeçalho: th scope="col" por cenário + coluna de score.
    const colThs = openTagsOf(html, 'th').filter((t) => t.includes('scope="col"'));
    expect(colThs.length).toBe(stages.length + 2); // variante + 8 cenários + score
    // Corpo: th scope="row" por variante e td por célula.
    const rowThs = openTagsOf(html, 'th').filter((t) => t.includes('scope="row"'));
    expect(rowThs.length).toBe(contestants.length);
    const tds = innersOf(html, 'td');
    expect(tds.length).toBe(contestants.length * (stages.length + 1)); // + score
    // <caption> traz a legenda (não é ornamento mudo).
    expect(accessibleText(innerOf(html, 'caption')!)).toContain('resolve');
    expect(accessibleText(innerOf(html, 'caption')!)).toContain('não resolve');
  });

  it('(i) paradas de Tab ≤ M+1 (run 4×8: ≤9) e (iv) clique só nos th de coluna', async () => {
    const html = await renderHeat({
      record: record(contestants, stages),
      onStageClick: () => undefined,
    });
    const tabela = innerOf(html, 'table')!;
    const M = stages.length; // colunas
    expect(focusStopCount(tabela)).toBeLessThanOrEqual(M + 1);
    // O interativo é o cabeçalho de coluna (botão por cenário)…
    const thead = innerOf(html, 'thead')!;
    expect(openTagsOf(thead, 'button').length).toBe(M);
    // …e NUNCA a célula: tbody sem botão, sem tabindex, sem role="button".
    const tbody = innerOf(html, 'tbody')!;
    expect(openTagsOf(tbody, 'button').length).toBe(0);
    expect(tbody).not.toMatch(/tabindex=/);
    expect(tbody).not.toMatch(/role="button"/);
    expect(tbody).not.toMatch(/onclick=/i);
    // Sem onStageClick não há NENHUMA parada de Tab no componente.
    const inerte = await renderHeat({ record: record(contestants, stages) });
    expect(focusStopCount(innerOf(inerte, 'table')!)).toBe(0);
  });

  it('(ii)+(iii) cada td tem veredito textual e nenhum anuncia só glifo', async () => {
    // Uma célula por estado conhecido (fan-out ao vivo: pendente → recebida →
    // julgada, com erro/bloqueio/corte à parte).
    const estados: AnyRec[] = [
      {
        index: 0,
        responses: [],
        judge: { verdictByContestant: { a: 'resolve' } },
        esperado: 'resolve',
      },
      {
        index: 1,
        responses: [],
        judge: { verdictByContestant: { a: 'parcial' } },
        esperado: 'parcial',
      },
      {
        index: 2,
        responses: [],
        judge: { verdictByContestant: { a: 'nao' } },
        esperado: 'não resolve',
      },
      { index: 3, responses: [], esperado: 'pendente' },
      {
        index: 4,
        responses: [{ contestantId: 'a', status: 'ok', costUsd: 0 }],
        esperado: 'resposta recebida — aguardando julgamento',
      },
      {
        index: 5,
        responses: [{ contestantId: 'a', status: 'error', costUsd: 0 }],
        esperado: 'resposta com erro',
      },
      {
        index: 6,
        responses: [{ contestantId: 'a', status: 'blocked', costUsd: 0 }],
        esperado: 'bloqueado pela moderação — sem veredito para o prompt',
      },
      {
        index: 7,
        responses: [],
        incomplete: true,
        incompleteReason: 'budget',
        esperado: 'cortado pelo orçamento — fora do placar',
      },
    ];
    const html = await renderHeat({
      record: record([{ id: 'a', label: 'Alpha' }], estados),
    });
    const tbody = innerOf(html, 'tbody')!;
    const tds = innersOf(tbody, 'td');
    // 8 células de estado + 1 de score.
    expect(tds.length).toBe(estados.length + 1);
    estados.forEach((e, i) => {
      const nome = accessibleText(tds[i]);
      expect(nome, `célula ${i}`).toBe(e.esperado);
      expect(GLIFOS.has(nome), `célula ${i} anuncia glifo`).toBe(false);
    });
    // A célula de score tem contagem textual (não só "3✓ 1◐…").
    expect(accessibleText(tds[estados.length])).toContain('resolve');
    expect(accessibleText(tds[estados.length])).toContain('não resolve');
    // Todo glifo é decoração: o <span> que o traz é sempre aria-hidden.
    for (const m of html.matchAll(/<span([^>]*)>([✓◐✕⏳·])<\/span>/g)) {
      expect(m[1], `glifo ${m[2]} sem aria-hidden`).toContain('aria-hidden="true"');
    }
    expect(openTagsOf(html, 'span').some((t) => t.includes('aria-hidden="true"'))).toBe(true);
    // E nada de glifo como nome acessível em NENHUMA célula.
    for (const td of tds) expect(GLIFOS.has(accessibleText(td))).toBe(false);
  });
});

describe.skipIf(!temWebDeps)('IMPL-108 — placar de evolução (EvolutionHeatmap) como tabela', () => {
  async function renderEvo(rounds: AnyRec[], holdoutAt?: number): Promise<string> {
    const { createElement } = await import(pathToFileURL(WEB_REACT).href);
    const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
    const { EvolutionHeatmap } = await import('../web/src/pages/runShared');
    return renderToStaticMarkup(createElement(EvolutionHeatmap, { rounds, holdoutAt }));
  }

  it('tabela nativa + sparkline com texto alternativo + "não participou" em texto', async () => {
    const vars = [
      { id: 'v1', label: 'Base' },
      { id: 'v2', label: 'Técnica XPTO' },
    ];
    // 5 rodadas: v1 sobe de 40 para 72; v2 não participa da rodada 3.
    const rounds = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`,
      iteration: i,
      contestants: vars,
      stages: [],
      judgeScoreByContestant:
        i === 2 ? { v1: 50 } : { v1: [40, 48, 50, 61, 72][i], v2: 55 - i },
    }));
    const html = await renderEvo(rounds);
    expect(innerOf(html, 'table')).not.toBeNull();
    expect(innerOf(html, 'table')!).not.toContain('<div');
    expect(html).toMatch(/<caption[^>]*>/);
    expect(openTagsOf(html, 'th').filter((t) => t.includes('scope="col"')).length).toBe(5 + 2);
    expect(openTagsOf(html, 'th').filter((t) => t.includes('scope="row"')).length).toBe(2);
    // Texto alternativo da sparkline (não um traço mudo): via aria-label,
    // que é o que o leitor de tela anuncia (role="img" + label).
    expect(html).toContain('aria-label="Evolução de Base: subiu de 40 para 72 em 5 rodadas"');
    expect(html).toMatch(/role="img"[^>]*aria-label="Evolução de Base/);
    // "não participou" é TEXTO (não só '·' nem só title).
    expect(accessibleText(html)).toContain('não participou');
    const tds = innersOf(html, 'td');
    const naoParticipou = tds.find((td) => accessibleText(td) === 'não participou');
    expect(naoParticipou).toBeDefined();
    // Nenhuma célula anuncia glifo.
    for (const td of tds) expect(GLIFOS.has(accessibleText(td))).toBe(false);
  });
});
