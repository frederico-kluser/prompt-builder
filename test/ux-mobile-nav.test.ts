// IMPL-110 (R-11c:REC-6) — navegação visível abaixo de 768px.
//
// Antes: o <nav> do header era `hidden md:flex` (só desktop) e a paleta ⌘K
// `hidden sm:block` — entre 640–767px a paleta era o ÚNICO caminho entre telas
// e abaixo de 640px não havia navegação visível alguma. E o wrapper de transição
// usava `transform`, que vira containing block de `fixed` no iOS.
//
// Agora: barra inferior com 4 destinos em 1 toque, <nav> com links <a href>
// reais + aria-current="page" (exatamente 1 por rota), alvos ≥ 44px, utilitários
// no header, paleta ⌘K como complemento, posicionamento por visualViewport +
// env(safe-area-inset-*) e wrapper de transição SEM transform.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { innerOf, openTagsOf } from './uxHtml';

const ROOT = process.cwd();
const WEB_REACT = join(ROOT, 'web', 'node_modules', 'react', 'index.js');
const WEB_REACT_DOM_SERVER = join(ROOT, 'web', 'node_modules', 'react-dom', 'server.node.js');
const temWebDeps = existsSync(WEB_REACT) && existsSync(WEB_REACT_DOM_SERVER);

vi.mock('@/lib/utils', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }));

type AnyRec = Record<string, any>;

describe('IMPL-110 (i)+(ii) — barra inferior: 4 destinos em 1 toque, 1 aria-current por rota', () => {
  it.skipIf(!temWebDeps)('render: 4 links reais, alvos ≥44px, exatamente 1 aria-current', async () => {
    const { createElement } = await import(pathToFileURL(WEB_REACT).href);
    const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
    const { BottomNav } = await import('../web/src/components/BottomNav');
    const html: string = renderToStaticMarkup(createElement(BottomNav, { pathname: '/runs' }));
    const nav = innerOf(html, 'nav');
    expect(nav).not.toBeNull();
    // 4 destinos, cada um um <a href> REAL (abre em aba nova funciona).
    const links = openTagsOf(html, 'a').filter((t) => t.includes('href="/'));
    expect(links.length).toBe(4);
    for (const href of ['/new', '/runs', '/prompts', '/settings']) {
      expect(links.some((t) => t.includes(`href="${href}"`)), `falta link ${href}`).toBe(true);
    }
    // Exatamente 1 com aria-current="page" (a rota atual).
    const currents = openTagsOf(html, 'a').filter((t) => t.includes('aria-current="page"'));
    expect(currents.length).toBe(1);
    expect(currents[0]).toContain('href="/runs"');
    // Alvos ≥ 24px exigidos / 44px confortáveis (min-h-11 min-w-11 = 2,75rem).
    for (const t of links) expect(t).toMatch(/min-h-11/);
    // Posicionamento: viewport visual + safe-area (teclado virtual no iOS).
    expect(html).toMatch(/bottom:\s*calc\(\d+px \+ env\(safe-area-inset-bottom\)\)/);
    expect(html).toContain('env(safe-area-inset-left)');
    // Só < 768px (a barra não duplica a navegação no desktop).
    expect(html).toMatch(/class="[^"]*md:hidden/);
  });

  it('activeNavTarget: exatamente 1 destino por rota, inclusive detalhes', async () => {
    const { NAV_DESTINATIONS, activeNavTarget } = await import('../web/src/components/BottomNav');
    const rotas = ['/new', '/runs', '/runs/abc123', '/training/s1', '/prompts', '/settings', '/'];
    for (const rota of rotas) {
      const alvo = activeNavTarget(rota);
      const bate = NAV_DESTINATIONS.filter((d) => d.to === alvo);
      expect(bate.length, `${rota} → ${alvo}`).toBe(1);
    }
    // Detalhe de run e cockpit pertencem ao Histórico.
    expect(activeNavTarget('/runs/abc')).toBe('/runs');
    expect(activeNavTarget('/training/s1')).toBe('/runs');
    expect(activeNavTarget('/settings')).toBe('/settings');
  });
});

describe('IMPL-110 — AppShell: barra montada, wrapper sem transform, header com links', () => {
  const shell = readFileSync(join(ROOT, 'web/src/components/AppShell.tsx'), 'utf8');

  it('a barra inferior é montada e o wrapper de transição não tem transform', () => {
    expect(shell).toMatch(/<BottomNav pathname=\{location\.pathname\} onNavigate=\{navigate\} \/>/);
    // Nada de transform no wrapper: vira containing block de fixed no iOS.
    const transicao = shell.slice(shell.indexOf('function RouteTransition'));
    expect(transicao).not.toContain('transform');
    expect(transicao).not.toContain('translateY');
  });

  it('nav do header usa links <a href> reais com o mesmo mapa de rotas', () => {
    expect(shell).toMatch(/<Link/);
    expect(shell).toMatch(/aria-current=\{active \? 'page' : undefined\}/);
    expect(shell).toMatch(/activeNavTarget\(pathname\)/);
  });

  it('(iii) Esc devolve foco ao gatilho: o overlay restaura o foco', () => {
    const modal = readFileSync(join(ROOT, 'web/src/components/Modal.tsx'), 'utf8');
    expect(modal).toMatch(/useFocusTrap\(\{[^}]*onEscape: onClose[^}]*restoreFocus: true/);
  });
});
