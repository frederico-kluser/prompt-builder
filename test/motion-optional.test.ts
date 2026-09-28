// IMPL-118 (R-10:REC-8) — Motion+ opcional: `npm ci && npm run web:build` SEM
// MOTION_TOKEN, substituto de `splitText` (Intl.Segmenter) com o título animado
// e ANUNCIADO igual ao atual (aria-label com o texto completo) em ≤ 3 KB min, e
// stub de `AnimateView` por alias do Vite.
//
// O que se prova aqui: (a) o contrato de install (optionalDependencies + lock
// em sincronia + alias condicional); (b) o substituto de splitText (linhas
// medidas, palavras com classe, espaços preservados, aria-label intacto); (c) o
// teto de bytes do substituto. O build completo sem o pacote privado (critério
// "sourcemap sem bytes do @motionplus/core") é verificado na execução manual
// (mover node_modules/motion-plus e rodar `npm run web:build`) — ver notas.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { transformSync } from 'esbuild';
import { segmentWords, splitText } from '../web/src/motion-plus-fallback/split-text.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');

// ---------------------------------------------------------------------------
// DOM falso (o substituto usa textContent/offsetTop/replaceChildren — o teste
// controla o "wrap" atribuindo offsetTop às palavras)
// ---------------------------------------------------------------------------

type FakeChild = FakeEl | FakeText;
interface FakeText { kind: 'text'; text: string }

class FakeDoc {
  /** Tops atribuídos por ordem de criação de <span> (as palavras vêm primeiro). */
  tops: number[];
  constructor(tops: number[] = []) {
    this.tops = [...tops];
  }
  createElement(tag: string): FakeEl {
    const el = new FakeEl(this, tag, false);
    el.offsetTop = this.tops.shift() ?? 0;
    return el;
  }
  createTextNode(text: string): FakeText {
    return { kind: 'text', text };
  }
}

class FakeEl {
  kind = 'el' as const;
  tag: string;
  doc: FakeDoc;
  children: FakeChild[] = [];
  style: Record<string, string> = {};
  className = '';
  attrs = new Map<string, string>();
  offsetTop: number;
  constructor(doc: FakeDoc, tag: string, consomeTop = true) {
    this.doc = doc;
    this.tag = tag;
    this.offsetTop = consomeTop ? doc.tops.shift() ?? 0 : 0;
  }
  get textContent(): string {
    return this.children.map((c) => (c.kind === 'text' ? c.text : c.textContent)).join('');
  }
  set textContent(v: string) {
    this.children = v ? [{ kind: 'text', text: v }] : [];
  }
  get childNodes(): FakeChild[] {
    return this.children;
  }
  get ownerDocument(): FakeDoc {
    return this.doc;
  }
  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  appendChild(c: FakeChild): FakeChild {
    this.children.push(c);
    return c;
  }
  replaceChildren(...cs: FakeChild[]): void {
    this.children = cs;
  }
}

const comTexto = (texto: string, tops: number[], aria?: string): FakeEl => {
  // A raiz não consome tops: eles pertencem às palavras criadas pelo split.
  const el = new FakeEl(new FakeDoc(tops), 'h1', false);
  el.textContent = texto;
  if (aria !== undefined) el.setAttribute('aria-label', aria);
  return el;
};

const palavrasDe = (linha: FakeEl): FakeEl[] => linha.children.filter((c): c is FakeEl => c.kind === 'el');

/** splitText tipa `HTMLElement` (DOM real); o DOM falso cumpre o mesmo contrato. */
type SplitFake = { lines: FakeEl[]; words: FakeEl[]; chars: FakeEl[] };
const rodarSplit = (el: FakeEl, opts: { lineClass?: string; wordClass?: string }): SplitFake =>
  splitText(el as unknown as HTMLElement, opts) as unknown as SplitFake;

describe('IMPL-118 — substituto de splitText (Intl.Segmenter, sem pacote privado)', () => {
  it('agrupa em linhas pela medida real e preserva os espaços ENTRE palavras', () => {
    // 4 palavras, 2 linhas visuais: tops [10, 10, 24, 24].
    const el = comTexto('Olá mundo bonito hoje', [10, 10, 24, 24]);
    const r = rodarSplit(el, { lineClass: 'linha', wordClass: 'palavra' });
    expect(r.words).toHaveLength(4);
    expect(r.lines).toHaveLength(2);
    expect(r.lines.map((l) => l.className)).toEqual(['linha', 'linha']);
    expect(r.lines.map((l) => l.style.display)).toEqual(['block', 'block']);
    // Os espaços entre palavras da MESMA linha viajam para dentro do span de
    // linha — sem eles as palavras colavam ("Olámundo").
    expect(r.lines[0].textContent).toBe('Olá mundo');
    expect(r.lines[1].textContent).toBe('bonito hoje');
    // Word spans com a classe pedida, dentro da linha certa, na ordem de leitura.
    const todas = r.lines.flatMap((l) => palavrasDe(l));
    expect(todas.map((w) => w.className)).toEqual(['palavra', 'palavra', 'palavra', 'palavra']);
    expect(todas.map((w) => w.textContent)).toEqual(['Olá', 'mundo', 'bonito', 'hoje']);
  });

  it('quebras consecutivas viram linhas separadas (palavra sozinha também é linha)', () => {
    const el = comTexto('a bb ccc dddd', [5, 5, 5, 9]);
    const r = rodarSplit(el, { lineClass: 'l', wordClass: 'w' });
    expect(r.lines.map((l) => l.textContent)).toEqual(['a bb ccc', 'dddd']);
  });

  it('anúncio por leitor de tela IGUAL ao título não partido (aria-label com o texto completo)', () => {
    // Com aria-label (contrato do stagger-reveal): o atributo é PRESERVADO cru.
    const comLabel = comTexto('Título partido em duas linhas aqui', [0, 0, 1], 'Título partido em duas linhas aqui');
    rodarSplit(comLabel, { lineClass: 'l', wordClass: 'w' });
    expect(comLabel.getAttribute('aria-label')).toBe('Título partido em duas linhas aqui');
    // Sem aria-label: criado com o texto COMPLETO — a repartição nunca some do anúncio.
    const semLabel = comTexto('Olá mundo', [0, 0]);
    rodarSplit(semLabel, { lineClass: 'l', wordClass: 'w' });
    expect(semLabel.getAttribute('aria-label')).toBe('Olá mundo');
  });

  it('re-partir sobre texto reposto (ciclo do stagger-reveal) não aninha spans', () => {
    const el = comTexto('Olá mundo', [10, 10]);
    rodarSplit(el, { lineClass: 'l', wordClass: 'w' });
    // O consumidor repõe o texto a partir do aria-label e re-rola (mudança de
    // fonte/motion-mode) — a 2.ª passagem opera em texto limpo.
    el.textContent = el.getAttribute('aria-label') ?? '';
    const r = rodarSplit(el, { lineClass: 'l', wordClass: 'w' });
    expect(r.lines.map((l) => l.textContent)).toEqual(['Olá mundo']);
    for (const w of r.words) expect(w.children.every((c) => c.kind === 'text')).toBe(true);
  });

  it('segmentação: pontuação cola à palavra; CJK segmenta mesmo sem espaços', () => {
    expect(segmentWords('trocar?')).toEqual([{ text: 'trocar?', space: false }]);
    expect(segmentWords('Olá mundo')).toEqual([
      { text: 'Olá', space: false },
      { text: ' ', space: true },
      { text: 'mundo', space: false },
    ]);
    const cjk = segmentWords('日本語のテキスト').filter((p) => !p.space);
    expect(cjk.length).toBeGreaterThan(1); // Intl.Segmenter divide por palavra
    expect(cjk.map((p) => p.text).join('')).toBe('日本語のテキスト');
  });

  it('o substituto cabe em ≤ 3 KB minificado (teto do critério)', () => {
    const fonte = readFileSync(join(WEB, 'src', 'motion-plus-fallback', 'split-text.ts'), 'utf-8');
    const min = transformSync(fonte, { minify: true, loader: 'ts', format: 'esm', target: 'es2022' });
    expect(Buffer.byteLength(min.code, 'utf-8')).toBeLessThanOrEqual(3 * 1024);
  });
});

describe('IMPL-118 — contrato de install: Motion+ opcional e build sem o token', () => {
  const pkg = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf-8')) as {
    dependencies: Record<string, string>;
    optionalDependencies: Record<string, string>;
  };
  const lock = JSON.parse(readFileSync(join(WEB, 'package-lock.json'), 'utf-8')) as {
    packages: Record<string, { optional?: boolean; optionalDependencies?: Record<string, string> }>;
  };

  it('motion-plus saiu das dependências duras e entrou em optionalDependencies', () => {
    expect(pkg.dependencies['motion-plus']).toBeUndefined();
    expect(pkg.optionalDependencies['motion-plus']).toBe('npm:@motionplus/core@^2.12.0');
  });

  it('lock em sincronia (sem isto o npm ci reprova e o clone limpo morre)', () => {
    expect(lock.packages['']?.optionalDependencies?.['motion-plus']).toBe('npm:@motionplus/core@^2.12.0');
    expect(lock.packages['node_modules/motion-plus']?.optional).toBe(true);
  });

  it('vite.config.ts liga os substitutos por alias quando o pacote está ausente', () => {
    const vite = readFileSync(join(WEB, 'vite.config.ts'), 'utf-8');
    // Resolução condicional: pacote instalado ⇒ pacote real (sem alias).
    expect(vite).toMatch(/createRequire\(import\.meta\.url\)\.resolve\('motion-plus'\)/);
    expect(vite).toMatch(/'motion-plus\/animate-view'/);
    expect(vite).toMatch(/\.\/src\/motion-plus-fallback/);
    expect(vite).toMatch(/FALLBACK_DIR, 'animate-view\.ts'/);
    expect(vite).toMatch(/FALLBACK_DIR, 'split-text\.ts'/);
  });

  it('tipos ambientais cobrem os DOIS módulos usados pela UI (tsc sem o pacote)', () => {
    const dts = readFileSync(join(WEB, 'src', 'motion-plus-fallback', 'motion-plus.d.ts'), 'utf-8');
    expect(dts).toMatch(/declare module 'motion-plus'/);
    expect(dts).toMatch(/declare module 'motion-plus\/animate-view'/);
    expect(existsSync(join(WEB, 'src', 'motion-plus-fallback', 'animate-view.ts'))).toBe(true);
  });
});

// Render REAL do stub AnimateView (react-dom/server, sem navegador). As deps do
// web/ existem quando `npm run setup` correu; sem elas o bloco é pulado.
const WEB_REACT = join(WEB, 'node_modules', 'react', 'index.js');
const WEB_REACT_DOM_SERVER = join(WEB, 'node_modules', 'react-dom', 'server.node.js');
const temWebDeps = existsSync(WEB_REACT) && existsSync(WEB_REACT_DOM_SERVER);

describe.skipIf(!temWebDeps)('IMPL-118 — stub de AnimateView (alias sem o pacote privado)', () => {
  it('envolve os filhos no view-transition-name e não some com o conteúdo', async () => {
    const { createElement } = await import(pathToFileURL(WEB_REACT).href);
    const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
    const { AnimateView } = await import('../web/src/motion-plus-fallback/animate-view.js');
    const html = renderToStaticMarkup(
      createElement(AnimateView, { name: 'velocity-skeleton-card' }, createElement('span', null, 'conteúdo carregado')),
    );
    expect(html).toContain('conteúdo carregado');
    expect(html).toContain('view-transition-name:velocity-skeleton-card');
  });
});