// Modo JEV na SPA (chunk 2) — contratos SEM navegador (render real por
// react-dom/server + stubs das peças Motion UI/shadcn, a receita de
// test/ux-nova-run.test.ts):
//
//  (a) seletor "LLM | JEV" em /new: precedência ?tipo= > handoffs que
//      implicam LLM (?objetivo= do /welcome, rascunho da biblioteca) >
//      escolha lembrada; localStorage indisponível não quebra; o NewRun
//      continua INTACTO sob "LLM" (e o JEV nem monta);
//  (b) Nova run JEV: 5 passos no guiado, as 5 seções-âncora no completo,
//      rodapé (pendência + custo + Iniciar) nas duas superfícies;
//  (c) cores como DADO: os pares de token que as telas JEV usam passam AA
//      (4,5:1) em 13px nos DOIS temas — medido, não a olho.

import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contrastRatio, oklchToRgb, type Rgb } from './uxHtml';

const ROOT = process.cwd();
const WEB_REACT = join(ROOT, 'web', 'node_modules', 'react', 'index.js');
const WEB_REACT_DOM_SERVER = join(ROOT, 'web', 'node_modules', 'react-dom', 'server.node.js');
const temWebDeps = existsSync(WEB_REACT) && existsSync(WEB_REACT_DOM_SERVER);

/* ------------------------------------------------------------- stubs da UI */

vi.mock('@/lib/utils', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }));
vi.mock('@/components/motion-ui/ui-theme', () => ({
  useMotionUITransition: () => ({}),
  useMotionUITheme: () => ({ motionMode: 'off' }),
}));
vi.mock('@/components/motion-ui/stagger-reveal', () => ({
  StaggerReveal: (p: { children?: unknown }) => p.children,
  StaggerRevealHeadline: (p: { children?: unknown }) => p.children,
  StaggerRevealItem: (p: { children?: unknown }) => p.children,
}));
vi.mock('@/components/motion-ui/segmented-toggle', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return {
    SegmentedToggle: (p: { ariaLabel?: string; value?: string; children?: unknown }) =>
      createElement('div', { role: 'group', 'aria-label': p.ariaLabel, 'data-value': p.value }, p.children),
    SegmentedToggleOption: (p: { value?: string; children?: unknown }) =>
      createElement('button', { type: 'button', 'data-value': p.value }, p.children),
  };
});
vi.mock('@/components/motion-ui/smooth-tabs', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return {
    SmoothTabs: (p: { children?: unknown }) => createElement('div', null, p.children),
    SmoothTabsList: (p: { ariaLabel?: string; children?: unknown }) => createElement('div', { role: 'tablist', 'aria-label': p.ariaLabel }, p.children),
    SmoothTabsTab: (p: { value?: string; children?: unknown }) => createElement('button', { type: 'button', role: 'tab', 'data-passo': p.value }, p.children),
    SmoothTabsPanels: (p: { children?: unknown }) => createElement('div', null, p.children),
    SmoothTabsPanel: (p: { value?: string; children?: unknown }) => createElement('div', { role: 'tabpanel', 'data-passo': p.value }, p.children),
  };
});
vi.mock('@/components/motion-ui/multi-state-button', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return {
    MultiStateButton: (p: Record<string, unknown>) =>
      createElement('button', { type: p.type ?? 'button', 'aria-label': p['aria-label'], 'data-iniciar': '' }, p.children),
  };
});
vi.mock('@/components/ui/button', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return {
    Button: (p: Record<string, unknown>) => createElement('button', { type: p.type ?? 'button', 'aria-label': p['aria-label'] }, p.children),
    buttonVariants: () => '',
  };
});
vi.mock('@/components/ui/input', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return { Input: (p: Record<string, unknown>) => createElement('input', { type: p.type ?? 'text', 'aria-label': p['aria-label'], defaultValue: p.value }) };
});
vi.mock('@/components/ui/switch', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return { Switch: (p: Record<string, unknown>) => createElement('input', { type: 'checkbox', role: 'switch', 'aria-label': p['aria-label'] }) };
});
vi.mock('@/components/ui/textarea', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return { Textarea: (p: Record<string, unknown>) => createElement('textarea', { 'aria-label': p['aria-label'], defaultValue: p.value }) };
});
vi.mock('../web/src/components/Modal', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return { Modal: (p: { open?: boolean; children?: unknown }) => (p.open ? createElement('div', { 'data-modal': '' }, p.children) : null) };
});
// O search do stub é trocado por teste (deep link ?tipo=jev etc.).
const rota = { search: '' };
async function routerStub() {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return {
    Link: (p: { to?: string; children?: unknown }) => createElement('a', { href: p.to }, p.children),
    useNavigate: () => () => undefined,
    useLocation: () => ({ pathname: '/new', search: rota.search, hash: '', state: null, key: '' }),
    useParams: () => ({}),
  };
}
vi.mock('../web/node_modules/react-router-dom/dist/main.js', routerStub);
vi.mock('../web/node_modules/react-router-dom/dist/index.js', routerStub);
vi.mock('react-router-dom', routerStub);

function memoria(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

async function render(search: string, storage: Storage | null | 'throws'): Promise<string> {
  const g = globalThis as { localStorage?: unknown };
  const anterior = g.localStorage;
  rota.search = search;
  if (storage === 'throws') {
    Object.defineProperty(g, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('bloqueado', 'SecurityError');
      },
    });
  } else {
    Object.defineProperty(g, 'localStorage', { configurable: true, writable: true, value: storage ?? undefined });
  }
  try {
    const { createElement } = await import(pathToFileURL(WEB_REACT).href);
    const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
    const { NewBenchmark } = await import('../web/src/pages/NewBenchmark');
    return renderToStaticMarkup(createElement(NewBenchmark));
  } finally {
    Object.defineProperty(g, 'localStorage', { configurable: true, writable: true, value: anterior });
  }
}

/* ============================================================== (a) seletor */

describe('(a) seletor LLM | JEV em /new', () => {
  it('precedência: ?tipo= > ?objetivo=/rascunho da biblioteca (LLM) > pb.benchKind > LLM', async () => {
    const { initialBenchKind } = await import('../web/src/jev/form');
    expect(initialBenchKind('?tipo=jev', memoria())).toBe('jev');
    expect(initialBenchKind('?tipo=llm', memoria({ 'pb.benchKind': 'jev' }))).toBe('llm');
    // Vindo do /welcome com um objetivo LLM: a escolha lembrada NÃO pode desviar para o JEV.
    expect(initialBenchKind('?objetivo=training&passo=teste', memoria({ 'pb.benchKind': 'jev' }))).toBe('llm');
    // Rascunho da biblioteca de prompts (/prompts → Nova Run) implica LLM.
    expect(initialBenchKind('', memoria({ 'pb.benchKind': 'jev', 'arena:prompt-draft': '{"text":"x"}' }))).toBe('llm');
    expect(initialBenchKind('', memoria({ 'pb.benchKind': 'jev' }))).toBe('jev');
    expect(initialBenchKind('', memoria())).toBe('llm');
    expect(initialBenchKind('', null)).toBe('llm');
    const quebra = { getItem: () => { throw new DOMException('x', 'SecurityError'); } } as unknown as Storage;
    expect(initialBenchKind('', quebra)).toBe('llm');
  });

  it.skipIf(!temWebDeps)('LLM (default): o seletor + o NewRun intacto; o JEV nem monta', async () => {
    const html = await render('', memoria());
    expect(html).toContain('aria-label="Tipo de benchmark"');
    expect(html).toContain('data-value="llm"');
    expect(html).toContain('JEV (decisões)');
    expect(html).toContain('data-bench="llm"');
    expect(html).not.toContain('data-bench="jev"');
    // O guiado LLM continua o mesmo (passo de objetivo + rodapé).
    expect(html).toContain('O que você quer descobrir?');
    expect(html).toContain('Iniciar a run');
    expect(html).not.toContain('Nova run JEV');
    // O seletor vem ANTES do formulário (primeira escolha da página).
    expect(html.indexOf('Tipo de benchmark')).toBeLessThan(html.indexOf('<form'));
  });

  it.skipIf(!temWebDeps)('deep link ?tipo=jev abre o JEV; localStorage bloqueado não quebra', async () => {
    const html = await render('?tipo=jev', 'throws');
    expect(html).toContain('data-bench="jev"');
    expect(html).not.toContain('data-bench="llm"');
    expect(html).toContain('Nova run JEV');
    expect(html).toContain('Mede e evolui decisões tipadas');
  });

  it.skipIf(!temWebDeps)('escolha lembrada (pb.benchKind=jev) abre o JEV', async () => {
    const html = await render('', memoria({ 'pb.benchKind': 'jev' }));
    expect(html).toContain('data-bench="jev"');
  });

  it('fonte: NewRun e GuidedSetup não importam nada do JEV (wrapper, D-12)', () => {
    for (const f of ['web/src/pages/NewRun.tsx', 'web/src/components/GuidedSetup.tsx']) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(src).not.toMatch(/jev/i);
    }
    const main = readFileSync(join(ROOT, 'web/src/main.tsx'), 'utf8');
    expect(main).toMatch(/path="\/new" element=\{<KeyGate><NewBenchmark \/><\/KeyGate>\}/);
    expect(main).toMatch(/startJevOrphanWatch\(\)/);
    for (const r of ['/jev/runs/:id', '/jev/training/:sessionId', '/jev/training/:sessionId/report']) expect(main).toContain(`path="${r}"`);
  });
});

/* ========================================================= (b) Nova run JEV */

describe('(b) Nova run JEV — guiado e completo', () => {
  it.skipIf(!temWebDeps)('guiado: 5 passos, objetivos, exemplos e rodapé', async () => {
    const html = await render('?tipo=jev', memoria());
    for (const passo of ['Objetivo', 'Decisão', 'Casos', 'Participantes', 'Limites e revisão']) expect(html).toContain(passo);
    expect(html).toMatch(/role="tablist" aria-label="Passos da configuração JEV"/);
    for (const g of ['Avaliar', 'Comparar', 'Treinar']) expect(html).toContain(g);
    expect(html).toContain('Triagem de tickets de suporte');
    // Rodapé: pendência (sem casos) + custo + Iniciar.
    expect(html).toContain('Importe ou cole os casos rotulados');
    expect(html).toContain('custo estimado');
    expect(html).toContain('aria-label="Iniciar a run JEV"');
    // A expectativa honesta (§1.3): o JEV mede, não promete acurácia de LLM.
    expect(html).toMatch(/o JEV <strong[^>]*>mede<\/strong>/);
  });

  it.skipIf(!temWebDeps)('completo (pb.formStyle=complete): 5 seções-âncora, sem abas', async () => {
    const html = await render('?tipo=jev', memoria({ 'pb.formStyle': 'complete' }));
    for (const s of ['objetivo', 'decisao', 'casos', 'participantes', 'limites']) expect(html).toContain(`id="jev-sec-${s}"`);
    expect(html).not.toMatch(/aria-label="Passos da configuração JEV"/);
    expect(html).toContain('aria-label="Iniciar a run JEV"');
  });
});

/* ======================================================= (c) contraste medido */

/** Tokens `--nome: oklch(L C H)` crus de um bloco do index.css. */
function oklchTokens(css: string, bloco: ':root' | '.dark'): Record<string, [number, number, number]> {
  const re = bloco === ':root' ? /:root\s*\{([\s\S]*?)\n\}/ : /\.dark\s*\{([\s\S]*?)\n\}/;
  const m = css.match(re);
  if (!m) throw new Error(`bloco ${bloco} não encontrado`);
  const out: Record<string, [number, number, number]> = {};
  for (const t of m[1].matchAll(/--([\w-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)[^)]*\)/g)) out[t[1]] = [+t[2], +t[3], +t[4]];
  return out;
}

/** `color-mix(in oklch, A p%, B)` — hue "sem força" (croma 0) herda o do outro lado. */
function mixOklch(a: [number, number, number], b: [number, number, number], p: number): Rgb {
  const hb = b[1] === 0 ? a[2] : b[2];
  const ha = a[1] === 0 ? hb : a[2];
  return oklchToRgb(a[0] * p + b[0] * (1 - p), a[1] * p + b[1] * (1 - p), ha * p + hb * (1 - p));
}

describe('(c) cores das telas JEV — contraste AA 13px nos dois temas', () => {
  const css = readFileSync(join(ROOT, 'web', 'src', 'index.css'), 'utf8');
  for (const tema of [':root', '.dark'] as const) {
    it(`tema ${tema === ':root' ? 'claro' : 'escuro'}: veredito na grade de casos e número na matriz de confusão`, async () => {
      const t = oklchTokens(css, tema);
      const rgb = (k: string) => oklchToRgb(...t[k]);
      // CaseGrid: acerto/erro (texto do veredito sobre o fundo suave do veredito).
      expect(contrastRatio(rgb('resolve'), rgb('resolve-soft'))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(rgb('nao'), rgb('nao-soft'))).toBeGreaterThanOrEqual(4.5);
      // Sem nota / incompleto: tinta secundária sobre muted.
      expect(contrastRatio(rgb('muted-foreground'), rgb('muted'))).toBeGreaterThanOrEqual(4.5);
      // Matriz de confusão: número (tinta de texto) sobre o teto da mistura sequencial.
      const { CONFUSION_MAX_MIX } = await import('../web/src/components/jev/ConfusionMatrix');
      const teto = mixOklch(t['chart-1'], t.card, CONFUSION_MAX_MIX / 100);
      expect(contrastRatio(rgb('foreground'), teto)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
