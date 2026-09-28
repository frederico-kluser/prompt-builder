// IMPL-106 (R-11b:REC-1) + IMPL-107 (R-11b:REC-7) — contratos SEM navegador.
//
// IMPL-106: a Nova Run deixou de ser um fluxo em abas (SmoothTabs, validação
// por aba, conteúdo obrigatório escondido em aba não-default) e passou a ser
// PÁGINA ÚNICA com 3 seções de conteúdo sempre à vista + "Avançado" recolhível
// (2 níveis de revelação progressiva). Aqui se prova a estrutura no render REAL
// (react-dom/server) + a fonte; os gates de viewport e teclado num browser real
// vivem em test/ux-nova-run-e2e.test.ts.
//
// IMPL-107: a lista do seletor de modelos era truncada em .slice(0, 60) (87% do
// catálogo sumia sem contagem honesta), sem sorts nativos do catálogo e com
// aria-selected fixo em false. Aqui se prova a VIRTUALIZAÇÃO (contagem de nós
// estável com 459 itens), a contagem "mostrando X de Y", a ordenação default
// ≠ newest e o padrão ARIA combobox/listbox (aria-activedescendant, foco ≠
// seleção) — as teclas de verdade no teste E2E.
//
// As peças shadcn/Motion UI viram stubs (mesma receita de
// test/price-variable.test.ts): o que se testa é a estrutura e o texto.

import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openTagsOf } from './uxHtml';

const ROOT = process.cwd();
const WEB_REACT = join(ROOT, 'web', 'node_modules', 'react', 'index.js');
const WEB_REACT_DOM_SERVER = join(ROOT, 'web', 'node_modules', 'react-dom', 'server.node.js');
const temWebDeps = existsSync(WEB_REACT) && existsSync(WEB_REACT_DOM_SERVER);

/**
 * Importa o seletor DEPOIS dos stubs estarem registrados (os factories dos
 * `vi.mock` acordam com o primeiro import do grafo — a receita de
 * test/price-variable.test.ts importa o web/ só dentro dos testes).
 */
async function carregaModelSelector() {
  return await import('../web/src/components/ModelSelector');
}

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
    SegmentedToggle: (p: { ariaLabel?: string; children?: unknown }) =>
      createElement('div', { role: 'group', 'aria-label': p.ariaLabel }, p.children),
    SegmentedToggleOption: (p: { value?: string; children?: unknown }) =>
      createElement('button', { type: 'button', 'data-value': p.value }, p.children),
  };
});
vi.mock('@/components/motion-ui/multi-state-button', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return {
    MultiStateButton: (p: Record<string, unknown>) =>
      createElement(
        'button',
        { type: p.type ?? 'button', 'aria-label': p['aria-label'], 'data-iniciar': '' },
        p.children,
      ),
  };
});
vi.mock('@/components/ui/button', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return {
    Button: (p: Record<string, unknown>) =>
      createElement('button', { type: p.type ?? 'button', 'aria-label': p['aria-label'], tabIndex: p.tabIndex }, p.children),
  };
});
vi.mock('@/components/ui/input', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return {
    Input: (p: Record<string, unknown>) =>
      createElement('input', { type: p.type ?? 'text', 'aria-label': p['aria-label'], defaultValue: p.value }),
  };
});
vi.mock('@/components/ui/switch', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return {
    Switch: (p: Record<string, unknown>) =>
      createElement('input', { type: 'checkbox', role: 'switch', 'aria-label': p['aria-label'] }),
  };
});
vi.mock('@/components/ui/textarea', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return {
    Textarea: (p: Record<string, unknown>) =>
      createElement('textarea', { 'aria-label': p['aria-label'], defaultValue: p.value }),
  };
});
// O Modal real usa createPortal(document.body): aqui ele só devolve o conteúdo.
vi.mock('../web/src/components/Modal', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return { Modal: (p: { children?: unknown }) => createElement('div', { 'data-modal': '' }, p.children) };
});
// O specifier pelado resolve para o pacote REAL em web/node_modules — o mock
// tem de apontar os entry points concretos (CJS `main` e ESM `module`) para o
// stub casar com o id resolvido do importador. Declaração (não const) porque o
// `vi.mock` é içado acima das inicializações.
async function routerStub() {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return {
    Link: (p: { to?: string; children?: unknown }) => createElement('a', { href: p.to }, p.children),
    useNavigate: () => () => undefined,
  };
}
vi.mock('../web/node_modules/react-router-dom/dist/main.js', routerStub);
vi.mock('../web/node_modules/react-router-dom/dist/index.js', routerStub);
vi.mock('react-router-dom', routerStub);

/* ------------------------------------------------------- catálogo de 459 */

function catalogo(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `provedor/modelo-${String(i).padStart(3, '0')}`,
    name: i < 10 ? `Modelo Cetim ${i}` : `Modelo ${i}`,
    created: 1_700_000_000 + i * 1_000,
    contextLength: 8_000 + i * 1_000,
    supportedParameters: ['temperature'],
    pricing: { prompt: 0.000001 * (i + 1), completion: 0.000002 * (i + 1) },
  })) as never[];
}

/* ================================================================ IMPL-106 */

describe('IMPL-106 — Nova Run como página única (sem abas, seções + Avançado)', () => {
  it('fonte: sem SmoothTabs/abas e validação por SEÇÃO, nunca por aba', () => {
    const src = readFileSync(join(ROOT, 'web', 'src', 'pages', 'NewRun.tsx'), 'utf8');
    expect(src).not.toContain('SmoothTabs');
    expect(src).not.toMatch(/role="(tab|tablist|tabpanel)"/);
    // Nada de `{ tab: … }`: a pendência aponta a seção que resolve.
    expect(src).not.toMatch(/\btab:\s*'/);
    expect(src).toMatch(/section:\s*'cenarios'/);
    expect(src).toMatch(/section:\s*'juizes'/);
    expect(src).toMatch(/section:\s*'sujeitos'/);
    expect(src).toMatch(/section:\s*'avancado'/);
    // O submit nunca troca de aba: leva à seção (rolagem + foco).
    expect(src).toMatch(/irPara\(faltas\[0\]\.section\)/);
  });

  it.skipIf(!temWebDeps)('render: 4 seções-âncora, obrigatórios à vista, Avançado recolhido', async () => {
    const { createElement } = await import(pathToFileURL(WEB_REACT).href);
    const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
    const { NewRun } = await import('../web/src/pages/NewRun');
    const html: string = renderToStaticMarkup(createElement(NewRun));

    // (i) página única: nenhuma semântica de aba.
    expect(html).not.toMatch(/role="(tab|tablist|tabpanel)"/);

    // (ii) as 4 seções existem como âncoras estáveis.
    for (const sec of ['sec-cenarios', 'sec-sujeitos', 'sec-juizes', 'sec-avancado']) {
      expect(html).toContain(`id="${sec}"`);
    }

    // (iii) o "Avançado" nasce RECOLIDHIDO (o conteúdo fica montado em `hidden`,
    //       fora da ordem de Tab) — 2º nível da revelação progressiva.
    expect(html).toMatch(/id="sec-avancado-region"[^>]*\bhidden\b/);

    // (iv) critério (d): NENHUM campo obrigatório escondido por default. Os
    //      obrigatórios (tema, competidores, juízes) aparecem ANTES do bloco
    //      recolhido — e o recolhido só leva o que é opcional (Quantos/O que
    //      testar), nunca o conteúdo obrigatório.
    const corte = html.indexOf('id="sec-avancado-region"');
    expect(corte).toBeGreaterThan(0);
    const visivel = html.slice(0, corte);
    const recolhido = html.slice(corte);
    expect(visivel).toContain('aria-label="Tema"');
    expect(visivel).toContain('Competidores');
    expect(visivel).toContain('Juízes');
    expect(recolhido).not.toContain('aria-label="Tema"');
    expect(recolhido).not.toContain('aria-label="Juízes"');
    expect(recolhido).toContain('Quantos'); // opcional → Avançado

    // (v) rodapé fixo: pendência + custo estimado + "Iniciar", acima da barra
    //     inferior em telas pequenas (IMPL-110).
    expect(html).toContain('data-iniciar');
    expect(html).toContain('Iniciar');
    expect(html).toContain('custo estimado');
    expect(html).toMatch(/class="[^"]*\bfixed\b[^"]*md:bottom-0/);
  });
});

/* ================================================================ IMPL-107 */

describe('IMPL-107 (a) — virtualização: nós DOM estáveis com 459 itens', () => {
  it('virtualWindow: janela limitada, estável e com padding que cobre o resto', async () => {
    const { PICKER_ROW_PX, virtualWindow } = await carregaModelSelector();
    const w459 = virtualWindow(0, 459);
    const w100 = virtualWindow(0, 100);
    // A janela visível NÃO cresce com o catálogo…
    expect(w459.end - w459.start).toBe(w100.end - w100.start);
    expect(w459.end - w459.start).toBeLessThan(60);
    // …e o padding (em px) cobre exatamente as linhas FORA da janela.
    expect(w459.padTop).toBe(w459.start * PICKER_ROW_PX);
    expect(w459.padBottom).toBe((459 - w459.end) * PICKER_ROW_PX);
    const meio = virtualWindow(10_000, 459);
    expect(meio.end - meio.start).toBe(w459.end - w459.start);
    expect(meio.padTop + (meio.end - meio.start) * PICKER_ROW_PX + meio.padBottom).toBe(459 * PICKER_ROW_PX);
  });

  it.skipIf(!temWebDeps)('render com 459 itens: contagem de options estável (≠ 459)', async () => {
    const { createElement } = await import(pathToFileURL(WEB_REACT).href);
    const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
    const { ModelPicker, virtualWindow } = await carregaModelSelector();
    const contaOptions = (html: string) =>
      openTagsOf(html, 'li').filter((t) => t.includes('role="option"')).length;

    const w = virtualWindow(0, 459);
    const esperado = w.end - w.start;
    const html459: string = renderToStaticMarkup(
      createElement(ModelPicker, { models: catalogo(459), value: [], onPick: () => {}, title: 'Competidores' }),
    );
    const html100: string = renderToStaticMarkup(
      createElement(ModelPicker, { models: catalogo(100), value: [], onPick: () => {}, title: 'Competidores' }),
    );
    expect(contaOptions(html459)).toBe(esperado);
    expect(contaOptions(html459)).toBe(contaOptions(html100)); // estável
    expect(contaOptions(html459)).toBeLessThan(60); // nunca a lista inteira
  });
});

describe('IMPL-107 (c)+(e) — ordenação nativa e contagem honesta "mostrando X de Y"', () => {
  it('default ≠ newest e a UI oferece os sorts do catálogo', async () => {
    const { DEFAULT_MODEL_SORT, MODEL_SORTS } = await carregaModelSelector();
    expect(DEFAULT_MODEL_SORT).toBe('top-weekly'); // popularidade semanal
    expect(DEFAULT_MODEL_SORT).not.toBe('newest');
    const ids = MODEL_SORTS.map((s) => s.id);
    for (const exigido of [
      'newest',
      'context-high-to-low',
      'pricing-low-to-high',
      'intelligence-high-to-low',
      'coding-high-to-low',
      'agentic-high-to-low',
      'throughput-high-to-low',
      'latency-low-to-high',
    ]) {
      expect(ids).toContain(exigido);
    }
  });

  it('sortModels: ordem determinística por dado do catálogo, nulls no fim', async () => {
    const { applyServerOrder, sortModels } = await carregaModelSelector();
    const modelos = catalogo(5) as { id: string; created: number }[];
    const porNovos = sortModels(modelos as never, 'newest');
    expect(porNovos.map((m) => m.id)).toEqual([...modelos].reverse().map((m) => m.id));
    // Ranking do servidor aplicado por cima: a ordem da lista do servidor manda
    // e quem não veio no ranking cai no fim.
    const ordem = applyServerOrder(modelos as never, ['provedor/modelo-003', 'provedor/modelo-001']);
    expect(ordem[0].id).toBe('provedor/modelo-003');
    expect(ordem[1].id).toBe('provedor/modelo-001');
  });

  it.skipIf(!temWebDeps)('render: "mostrando X de Y" reflete o total filtrado e o preço -1 nunca é negativo', async () => {
    const { createElement } = await import(pathToFileURL(WEB_REACT).href);
    const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
    const { ModelPicker } = await import('../web/src/components/ModelSelector');
    const modelos = [
      ...catalogo(2),
      { id: 'openrouter/auto', name: 'Auto Router', pricing: { prompt: -1, completion: -1 } },
    ];
    const html: string = renderToStaticMarkup(
      createElement(ModelPicker, { models: modelos, value: [], onPick: () => {}, title: 'Competidores' }),
    );
    expect(html).toContain('mostrando 3 de 3'); // sem filtro = total honesto
    // Preço variável: rótulo textual, nunca "-1"/"$-".
    expect(html).toContain('preço variável');
    expect(html).not.toContain('$-');
    expect(html).not.toMatch(/>-1</);
  });
});

describe('IMPL-107 (b) — padrão ARIA combobox: foco ≠ seleção (função pura)', () => {
  it('setas movem o item ATIVO, Enter seleciona, Esc fecha', async () => {
    const { pickerKeyAction } = await carregaModelSelector();
    const base = { active: 0, count: 10, open: true };
    expect(pickerKeyAction('ArrowDown', base)).toEqual({ type: 'move', index: 1 });
    expect(pickerKeyAction('ArrowUp', base)).toEqual({ type: 'move', index: 0 });
    expect(pickerKeyAction('Home', { ...base, active: 5 })).toEqual({ type: 'move', index: 0 });
    expect(pickerKeyAction('End', base)).toEqual({ type: 'move', index: 9 });
    expect(pickerKeyAction('Enter', { ...base, active: 3 })).toEqual({ type: 'select', index: 3 });
    expect(pickerKeyAction('Escape', base)).toEqual({ type: 'close' });
    // Seta com o popup fechado ABRE (não seleciona).
    expect(pickerKeyAction('ArrowDown', { ...base, open: false })).toEqual({ type: 'open' });
    // Esc fechado não faz nada; lista vazia não move.
    expect(pickerKeyAction('Escape', { ...base, open: false })).toEqual({ type: 'none' });
    expect(pickerKeyAction('ArrowDown', { ...base, count: 0 })).toEqual({ type: 'none' });
  });

  it.skipIf(!temWebDeps)('render: combobox → listbox com aria-activedescendant e aria-selected honesto', async () => {
    const { createElement } = await import(pathToFileURL(WEB_REACT).href);
    const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
    const { ModelPicker } = await import('../web/src/components/ModelSelector');
    const modelos = catalogo(459);
    const html: string = renderToStaticMarkup(
      createElement(ModelPicker, {
        models: modelos,
        value: ['provedor/modelo-000'],
        onPick: () => {},
        title: 'Competidores',
      }),
    );

    const input = openTagsOf(html, 'input').find((t) => t.includes('role="combobox"'));
    expect(input).toBeTruthy();
    expect(input).toContain('aria-expanded');
    expect(input).toContain('aria-autocomplete="list"');

    // aria-controls do combobox aponta para o listbox renderizado.
    const alvo = /aria-controls="([^"]+)"/.exec(input ?? '')?.[1];
    expect(alvo).toBeTruthy();
    expect(html).toContain(`id="${alvo}"`);
    expect(html).toMatch(new RegExp(`<ul[^>]*id="${alvo}"[^>]*role="listbox"`));

    // aria-activedescendant aponta para uma opção EXISTENTE (foco ≠ seleção).
    const ativo = /aria-activedescendant="([^"]+)"/.exec(input ?? '')?.[1];
    expect(ativo).toBeTruthy();
    expect(html).toContain(`id="${ativo}"`);
    expect(html).toContain(`id="${ativo}" role="option"`);

    // aria-selected honesto: true só para o valor selecionado (antes: false fixo).
    const selecionados = openTagsOf(html, 'li').filter((t) => t.includes('aria-selected="true"'));
    expect(selecionados.length).toBe(1);
    expect((html.match(/aria-selected="true"/g) ?? []).length).toBe(1);
  });
});