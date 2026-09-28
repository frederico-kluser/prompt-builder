// Utilitários dos testes de UX/a11y (lote M-ux-web). Sem DOM: o render real é
// `react-dom/server` (ver test/price-variable.test.ts) e a análise é sobre o
// HTML gerado + tokens de cor do web/src/index.css. Nada disto é dependência
// nova: é só o contraste WCAG e umas fatias de regex sobre o markup.

/* ------------------------------------------------------------ HTML */

/** Sub-árvores `aria-hidden="true"` saem da árvore de acessibilidade. */
export function accessibleText(html: string): string {
  let out = html;
  for (let i = 0; i < 12; i++) {
    const next = out
      .replace(/<(\w+)([^>]*\baria-hidden="true"[^>]*)\/>/g, '')
      .replace(/<(\w+)([^>]*\baria-hidden="true"[^>]*)>[\s\S]*?<\/\1>/g, '');
    if (next === out) break;
    out = next;
  }
  return out
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Texto total (visível + sr-only), semântica nenhuma removida. */
export function allText(html: string): string {
  return accessibleText(html.replace(/\saria-hidden="true"/g, ''));
}

/** Conteúdo interno da primeira ocorrência de `<tag ...>…</tag>`. */
export function innerOf(html: string, tag: string): string | null {
  const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}

/** Todos os conteúdos internos de `<tag …>…</tag>` (sem aninhamento do mesmo tag). */
export function innersOf(html: string, tag: string): string[] {
  return [...html.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
}

/** Todos os elementos `<tag …>` (abertura), com atributos. */
export function openTagsOf(html: string, tag: string): string[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))].map((m) => m[0]);
}

/**
 * Elementos focáveis por Tab: `<a href>`, `<button>` e qualquer `tabindex`
 * numérico. É a contagem de paradas de Tab que o Playwright verificaria.
 */
export function focusStopCount(html: string): number {
  const anchors = openTagsOf(html, 'a').filter((t) => /\bhref="/.test(t)).length;
  const buttons = openTagsOf(html, 'button').length;
  const tabbable = [...html.matchAll(/\stabindex="(-?\d+)"/g)].filter((m) => m[1] !== '-1').length;
  return anchors + buttons + tabbable;
}

/* --------------------------------------------------------- contraste */

/** oklch(L C H) → sRGB 0..1. L em [0,1], C em [0,~0.4], H em graus. */
export function oklchToRgb(l: number, c: number, h: number): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l2 = l + 0.3963377774 * a + 0.2158037573 * b;
  const m2 = l - 0.1055613458 * a - 0.0638541728 * b;
  const s2 = l - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l2 ** 3;
  const m3 = m2 ** 3;
  const s3 = s2 ** 3;
  const lin = (x: number) => {
    const v = Math.min(1, Math.max(0, x));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  };
  return [
    lin(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
    lin(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
    lin(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
  ];
}

export type Rgb = [number, number, number];

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    return c as number;
  }) as unknown as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contraste WCAG 2.1 entre texto e fundo (já em sRGB 0..1). */
export function contrastRatio(fg: Rgb, bg: Rgb): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** `bg` com alpha sobre `under` (color-mix in srgb). */
export function mixAlpha(fg: Rgb, under: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => fg[i] * alpha + under[i] * (1 - alpha)) as Rgb;
}

/** Tokens `--nome: oklch(…)` dos blocos `:root` e `.dark` do index.css. */
export function readThemeTokens(css: string): { light: Record<string, Rgb>; dark: Record<string, Rgb> } {
  const parse = (bloco: string): Record<string, Rgb> => {
    const out: Record<string, Rgb> = {};
    for (const m of bloco.matchAll(/--([\w-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)[^)]*\)/g)) {
      out[m[1]] = oklchToRgb(+m[2], +m[3], +m[4]);
    }
    return out;
  };
  const root = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  const dark = css.match(/\.dark\s*\{([\s\S]*?)\n\}/);
  if (!root || !dark) throw new Error('tokens :root/.dark não encontrados no index.css');
  return { light: parse(root[1]), dark: parse(dark[1]) };
}
