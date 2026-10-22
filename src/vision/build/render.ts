/// <reference lib="dom" />
// BENCHMARK DE VISÃO — renderização e EXTRAÇÃO da verdade (Node, só build).
//
// Cada cenário é HTML nosso. O Chromium renderiza em 1920×1080 e o MESMO
// documento entrega a verdade: caixa de cada controle, nome acessível, tipo e
// estado. Não há anotação humana no meio — é por isso que o benchmark pode
// afirmar a posição exata de um botão de 18 px.
//
// Regra de cobertura (o que impede o dataset de "esquecer" um clique):
//   • a verdade são os elementos com `data-vision-id` (id estável e legível);
//   • o build VARRE todo elemento interativo detectável (tags de formulário,
//     roles ARIA e web components `md-*`/`fluent-*`) e FALHA se algum não tiver
//     `data-vision-id` (ou `data-vision-ignore` declarado).
// Sem essa varredura, um botão sem anotação sumiria da verdade e o recall do
// modelo seria punido por um erro NOSSO.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { VISION_VIEWPORT, type VisionBBox, type VisionElementState, type VisionElementType } from '../../engine/vision/index.js';

export interface ExtractedElement {
  visionId: string;
  type: VisionElementType;
  label: string | null;
  iconDescription: string | null;
  aliases: string[];
  bbox: VisionBBox;
  center: { x: number; y: number };
  state?: VisionElementState;
  hint?: string;
}

export interface ExtractedScene {
  elements: ExtractedElement[];
  /** Problemas de cobertura/anotação: qualquer um aborta o build. */
  issues: string[];
  title: string;
}

export interface RenderOptions {
  /** Executável do Chromium (default: o do playwright-core). */
  executablePath?: string;
}

const VIEWPORT = VISION_VIEWPORT;

/** Abre o Chromium uma vez para o build inteiro. */
export async function launchBrowser(opts: RenderOptions = {}): Promise<Browser> {
  return chromium.launch({
    headless: true,
    ...(opts.executablePath || process.env.VISION_CHROME
      ? { executablePath: opts.executablePath ?? process.env.VISION_CHROME }
      : {}),
    args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--disable-lcd-text'],
  });
}

/** Bloqueia animação/caret para o PNG ser determinístico. */
const CONGELA_CSS = `
  *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
  html { scrollbar-width: none; }
  ::-webkit-scrollbar { display: none; }
`;

/** Renderiza o HTML e devolve o PNG + os elementos anotados (uma passada). */
export async function renderScene(
  browser: Browser,
  htmlPath: string,
  pngPath: string,
  opts: { autoPrefix?: string } = {},
): Promise<ExtractedScene> {
  const page = await browser.newPage({
    viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
    deviceScaleFactor: 1,
  });
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // tsx/esbuild injeta `__name(...)` nas funções nomeadas do arquivo; a
    // função de extração é serializada para a página e precisa do helper lá.
    await page.addInitScript({
      content:
        'globalThis.__name = globalThis.__name || ((f, n) => { try { Object.defineProperty(f, "name", { value: n, configurable: true }); } catch {} return f; });',
    });
    await page.goto(`file://${path.resolve(htmlPath)}`, { waitUntil: 'load' });
    await page.addStyleTag({ content: CONGELA_CSS });
    // Fontes + upgrade de web components (o `customElements.whenDefined` pode
    // demorar; o teto evita build pendurado).
    await page.evaluate(async () => {
      await document.fonts.ready;
      // Web components (Fluent/Material) precisam estar DEFINIDOS e com o
      // shadow DOM montado antes de a gente medir caixas; o teto evita build
      // pendurado num componente que nunca registra.
      const tags = new Set(
        Array.from(document.querySelectorAll('*'))
          .map((el) => el.tagName.toLowerCase())
          .filter((t) => t.includes('-')),
      );
      await Promise.all(
        Array.from(tags).map((t) =>
          Promise.race([
            customElements.whenDefined(t).catch(() => undefined),
            new Promise((r) => setTimeout(r, 1500)),
          ]),
        ),
      );
      await new Promise((r) => setTimeout(r, 300));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    // Cenário de framework alheio (React95/Fluent/Material): o build ANOTA o
    // que está clicável AGORA (visível e não coberto por modal), em ordem de
    // documento. Cenário nosso já vem anotado à mão.
    if (opts.autoPrefix) {
      await page.evaluate(anotarInterativos, opts.autoPrefix);
    }
    const extraido = await page.evaluate(extrairNoNavegador);
    await fs.mkdir(path.dirname(pngPath), { recursive: true });
    await page.screenshot({
      path: pngPath,
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
      animations: 'disabled',
      caret: 'hide',
    });
    return extraido;
  } finally {
    await page.close();
  }
}

/**
 * Anotação AUTOMÁTICA para cenários de terceiros (os demos dos frameworks):
 * percorre os interativos visíveis e alcançáveis, ignora o que está dentro de
 * um elemento já anotado (ou marcado `data-vision-ignore`) e grava
 * `data-vision-id="<prefixo>-<n>"` em ordem de documento.
 *
 * O HTML original do framework fica intacto; a anotação é do BUILD e só marca
 * o que o usuário conseguiria clicar naquele estado da tela.
 */
function anotarInterativos(prefix: string): number {
  // Autocontido: o Playwright serializa só o corpo desta função.
  const WEB_CONTROL = /(?:^|-)(button|text-input|text-area|textarea|input|text-field|checkbox|radio|switch|slider|tab|menu-button|dropdown|option|combobox|select|link|fab|chip)$/;
  const ROLE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'slider', 'tab', 'menuitem', 'combobox', 'listbox']);
  const interativo = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'select' || tag === 'textarea') return true;
    if (tag === 'input') return (el as HTMLInputElement).type !== 'hidden';
    if (tag === 'a') return el.hasAttribute('href');
    const role = el.getAttribute('role');
    if (role && ROLE.has(role)) return true;
    if ((el as HTMLElement).isContentEditable) return true;
    return /^(md|fluent|fast)-/.test(tag) && WEB_CONTROL.test(tag);
  };
  const alcancavel = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.2) return false;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(hit && (el === hit || el.contains(hit) || hit.contains(el)));
  };
  let n = 0;
  for (const el of Array.from(document.querySelectorAll('*'))) {
    if (!interativo(el)) continue;
    if (el.closest('[data-vision-id]') || el.closest('[data-vision-ignore]')) continue;
    if (!alcancavel(el)) continue;
    el.setAttribute('data-vision-id', `${prefix}-${++n}`);
  }
  return n;
}

/**
 * A função roda DENTRO da página. Precisa ser autocontida (nada de imports):
 * o Playwright serializa o corpo dela.
 */
function extrairNoNavegador(): ExtractedScene {
  const TIPOS: Record<string, string> = {
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    a: 'link',
    select: 'select',
    textarea: 'textarea',
    input: 'input',
    checkbox: 'checkbox',
    radio: 'radio',
    range: 'slider',
    text: 'input',
    email: 'input',
    password: 'input',
    search: 'input',
    tel: 'input',
    url: 'input',
    number: 'input',
    date: 'input',
    time: 'input',
    datetime: 'input',
    month: 'input',
    week: 'input',
    file: 'input',
    color: 'input',
  };
  const ROLE: Record<string, string> = {
    button: 'button',
    link: 'link',
    textbox: 'input',
    searchbox: 'input',
    checkbox: 'checkbox',
    radio: 'radio',
    switch: 'switch',
    slider: 'slider',
    tab: 'tab',
    menuitem: 'menuitem',
    combobox: 'select',
    listbox: 'select',
  };
  const texto = (v: string | null | undefined): string =>
    (v ?? '').replace(/\s+/g, ' ').trim();
  const nomeAcessivel = (el: Element): string => {
    const aria = texto(el.getAttribute('aria-label'));
    if (aria) return aria;
    const porId = el.getAttribute('aria-labelledby');
    if (porId) {
      const partes = porId
        .split(/\s+/)
        .map((id) => texto(document.getElementById(id)?.textContent))
        .filter(Boolean);
      if (partes.length) return partes.join(' ');
    }
    const titulo = texto(el.getAttribute('title'));
    if (titulo) return titulo;
    const alt = texto(el.getAttribute('alt'));
    if (alt) return alt;
    const id = el.id;
    const ehCustom = el.tagName.includes('-');
    // Web component de campo: `placeholder`/`label` são o nome visível do
    // controle (o texto do host costuma ser a soma das opções do select).
    if (ehCustom) {
      const ph = texto(el.getAttribute('placeholder'));
      if (ph) return ph;
      const rotuloAttr = texto(el.getAttribute('label'));
      if (rotuloAttr) return rotuloAttr;
    }
    // <label for> / <label> envolvente — o caminho normal de checkbox, radio e
    // campo de formulário (custom element incluso).
    const ehCampo = ehCustom || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
    if (ehCampo) {
      if (id) {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        const t = texto(label?.textContent);
        if (t) return t;
      }
      const pai = el.closest('label');
      const t = texto(pai?.textContent);
      if (t) return t;
    }
    const placeholder = texto(el.getAttribute('placeholder'));
    if (placeholder) return placeholder;
    // Checkbox/switch "solto" ao lado de um texto (padrão dos demos).
    if (ehCampo) {
      const irmao = el.nextElementSibling;
      const depois = texto(irmao?.textContent);
      if (depois && depois.length <= 80) return depois;
      const anterior = el.previousElementSibling;
      const antes = texto(anterior?.textContent);
      if (antes && antes.length <= 80) return antes;
    }
    const interno = texto(el.textContent);
    if (interno) {
      // Material Web renderiza o ícone como LIGADURA: o texto do host sai
      // "filter_altFiltros salvos". O prefixo em snake_case/minúsculo é o nome
      // do ícone, não o rótulo visível — sai do nome (o run mede o rótulo).
      if (ehCustom) {
        const ligadura = /^[a-z][a-z0-9_]{0,24}([\p{Lu}].*)$/u.exec(interno);
        if (ligadura?.[1]) return ligadura[1];
      }
      return interno;
    }
    return texto(el.getAttribute('value'));
  };
  const tipoDe = (el: Element): string => {
    const declarado = el.getAttribute('data-vision-type');
    if (declarado) return declarado;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type.toLowerCase();
      return TIPOS[type] ?? 'input';
    }
    if (tag === 'button') {
      const type = (el as HTMLButtonElement).type.toLowerCase();
      return TIPOS[type] ?? 'button';
    }
    if (tag === 'a') return 'link';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    const role = el.getAttribute('role');
    if (role && ROLE[role]) return ROLE[role];
    if (tag.startsWith('md-') || tag.startsWith('fluent-') || tag.startsWith('fast-')) {
      if (/text-?field|input/.test(tag)) return 'input';
      if (/checkbox/.test(tag)) return 'checkbox';
      if (/radio/.test(tag)) return 'radio';
      if (/switch|toggle/.test(tag)) return 'switch';
      if (/slider/.test(tag)) return 'slider';
      if (/tab/.test(tag)) return 'tab';
      if (/menu-?item|option/.test(tag)) return 'menuitem';
      if (/combobox|select|dropdown/.test(tag)) return 'select';
      if (/option/.test(tag)) return 'menuitem';
      if (/chip|fab/.test(tag)) return 'button';
      if (/button/.test(tag)) return 'button';
      if (/link/.test(tag)) return 'link';
    }
    return 'other';
  };
  const ehInterativo = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    if (['button', 'select', 'textarea'].includes(tag)) return true;
    if (tag === 'input') return (el as HTMLInputElement).type !== 'hidden';
    if (tag === 'a') return el.hasAttribute('href');
    const role = el.getAttribute('role');
    if (role && role in ROLE) return true;
    if ((el as HTMLElement).isContentEditable) return true;
    // Containers (`fluent-tablist`, `fluent-radio-group`, `md-dialog`…) NÃO são
    // controles; marcar o container engoliria os filhos clicáveis.
    return /^(md|fluent|fast)-/.test(tag) && WEB_CONTROL.test(tag);
  };

  const WEB_CONTROL = /(?:^|-)(button|text-input|text-area|textarea|input|text-field|checkbox|radio|switch|slider|tab|menu-button|dropdown|option|combobox|select|link|fab|chip)$/;
  const issues: string[] = [];
  const vistos = new Map<string, number>();
  const elementos: ExtractedElement[] = [];
  const todos = Array.from(document.querySelectorAll('[data-vision-id]'));

  for (const el of todos) {
    const id = texto(el.getAttribute('data-vision-id'));
    if (!id) {
      issues.push('elemento com data-vision-id vazio');
      continue;
    }
    if (vistos.has(id)) issues.push(`data-vision-id duplicado: ${id}`);
    vistos.set(id, (vistos.get(id) ?? 0) + 1);
    if (el.getAttribute('data-vision-ignore') === 'true') continue;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width < 2 || rect.height < 2) {
      issues.push(`${id}: caixa degenerada (${rect.width.toFixed(1)}×${rect.height.toFixed(1)})`);
      continue;
    }
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) {
      issues.push(`${id}: fora da viewport`);
      continue;
    }
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.2) {
      issues.push(`${id}: invisível (display/visibility/opacity)`);
      continue;
    }
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit) {
      issues.push(`${id}: nada no centro da caixa`);
      continue;
    }
    const pertence = el === hit || el.contains(hit) || hit.contains(el);
    if (!pertence) {
      issues.push(`${id}: coberto por ${hit.tagName.toLowerCase()}`);
      continue;
    }
    const label = texto(el.getAttribute('data-vision-label')) || nomeAcessivel(el) || null;
    const icon = texto(el.getAttribute('data-vision-icon')) || null;
    if (!label && !icon) {
      issues.push(
        `${id}: sem label e sem data-vision-icon (o placar precisa de um nome) — ${el.outerHTML.slice(0, 120)}`,
      );
      continue;
    }
    const aliases = texto(el.getAttribute('data-vision-aliases'))
      .split(/[|;]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const state: VisionElementState = {};
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') state.disabled = true;
    if ((el as HTMLInputElement).checked) state.checked = true;
    if (el === document.activeElement) state.focused = true;
    if (el.getAttribute('aria-expanded')) state.expanded = el.getAttribute('aria-expanded') === 'true';
    const bbox: VisionBBox = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
    const hint = texto(
      el.getAttribute('data-vision-hint') ||
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? el.getAttribute('placeholder') ?? el.value ?? ''
          : ''),
    );
    elementos.push({
      visionId: id,
      type: tipoDe(el) as never,
      label,
      iconDescription: label ? null : icon,
      aliases,
      bbox,
      center: { x: Math.round(bbox.x + bbox.w / 2), y: Math.round(bbox.y + bbox.h / 2) },
      ...(Object.keys(state).length > 0 ? { state } : {}),
      ...(hint ? { hint } : {}),
    });
  }

  // Varredura de cobertura: todo interativo detectável e ALCANÇÁVEL precisa de
  // anotação. Descendente de um elemento já anotado conta como coberto (o
  // clique cai no anotado); o que está atrás de modal/fora da tela não é
  // clicável neste estado e fica fora da verdade.
  const alcancavel = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.2) return false;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(hit && (el === hit || el.contains(hit) || hit.contains(el)));
  };
  for (const el of Array.from(document.querySelectorAll('*'))) {
    if (!ehInterativo(el)) continue;
    if (el.closest('[data-vision-ignore]')) continue;
    if (el.closest('[data-vision-id]')) continue;
    if (el.hasAttribute('data-vision-ignore')) continue;
    const tag = el.tagName.toLowerCase();
    // Inputs internos de web components (light DOM) e campos hidden ficam fora.
    if (el.getAttribute('type') === 'hidden') continue;
    if (!alcancavel(el)) continue;
    const desc = `${tag}${el.id ? `#${el.id}` : ''}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''} sem data-vision-id`;
    issues.push(`interativo não anotado: ${desc}`);
  }

  return { elements: elementos, issues, title: document.title };
}

/** Abre o navegador com diagnóstico amigável de falta de Chromium. */
export async function openBrowserForBuild(opts: RenderOptions = {}): Promise<Browser> {
  try {
    return await launchBrowser(opts);
  } catch (err) {
    const msg = (err as Error).message.split('\n')[0];
    throw new Error(
      `não consegui abrir o Chromium (${msg}). Este passo é de MANUTENÇÃO: instale o navegador ` +
        '(`npx playwright install chromium`) ou aponte VISION_CHROME para um executável do Chrome.',
    );
  }
}
