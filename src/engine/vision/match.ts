// BENCHMARK DE VISÃO — casamento previsto × verdade (puro).
//
// A comparação é textual e sem LLM: normaliza acento/caixa/pontuação, aceita
// contenção ("Enviar formulário" × "Enviar") e aliases declarados no cenário
// (ex.: "pesquisar" para a lupa). Tipo é comparado dentro do vocabulário
// fechado, com sinônimos PT/EN do que o modelo costuma responder.
//
// Regra de honestidade: quem decide "acertou" é a CAIXA do elemento. Rótulo e
// tipo qualificam o acerto (e alimentam métricas separadas), mas nunca
// transformam um clique fora em acerto.

import type { VisionBBox, VisionElement, VisionElementType } from './types.js';

/** Texto comparável: sem acento, minúsculo, pontuação vira espaço. */
export function normalizeText(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokens significativos (descarta conectivos curtos). */
function tokens(s: string): string[] {
  return normalizeText(s)
    .split(' ')
    .filter((t) => t.length > 1);
}

/**
 * Dois nomes "são o mesmo rótulo"? Igualdade normalizada, contenção (quando o
 * menor tem ≥ 3 caracteres) ou Jaccard de tokens ≥ 0,6.
 */
export function labelMatches(expected: string | null | undefined, predicted: string | null | undefined): boolean {
  const a = normalizeText(expected);
  const b = normalizeText(predicted);
  if (!a || !b) return false;
  if (a === b) return true;
  const [curto, longo] = a.length <= b.length ? [a, b] : [b, a];
  if (curto.length >= 3 && longo.includes(curto)) return true;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const inter = ta.filter((t) => tb.includes(t)).length;
  const uniao = new Set([...ta, ...tb]).size;
  return inter / uniao >= 0.6;
}

/** Nomes aceitos de um elemento: rótulo visível, descrição do ícone e aliases. */
export function acceptedNames(el: VisionElement): string[] {
  return [el.label, el.iconDescription, ...(el.aliases ?? [])].filter(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );
}

/** O nome previsto casa com ALGUM nome aceito do elemento. */
export function elementNameMatches(el: VisionElement, predicted: string | null | undefined): boolean {
  if (!predicted) return false;
  return acceptedNames(el).some((nome) => labelMatches(nome, predicted));
}

const TYPE_ALIASES: Record<string, VisionElementType> = {
  button: 'button',
  btn: 'button',
  botao: 'button',
  push_button: 'button',
  icon_button: 'button',
  link: 'link',
  hyperlink: 'link',
  anchor: 'link',
  ancora: 'link',
  a: 'link',
  input: 'input',
  text_input: 'input',
  textinput: 'input',
  text_field: 'input',
  textfield: 'input',
  textbox: 'input',
  text_box: 'input',
  campo: 'input',
  campo_de_texto: 'input',
  edit: 'input',
  edittext: 'input',
  edit_text: 'input',
  search: 'input',
  searchbox: 'input',
  search_field: 'input',
  searchbar: 'input',
  email_input: 'input',
  password_input: 'input',
  form_field: 'input',
  textarea: 'textarea',
  text_area: 'textarea',
  multiline: 'textarea',
  select: 'select',
  dropdown: 'select',
  combobox: 'select',
  combo_box: 'select',
  picker: 'select',
  menu_suspenso: 'select',
  listbox: 'select',
  checkbox: 'checkbox',
  check_box: 'checkbox',
  caixa_de_selecao: 'checkbox',
  check: 'checkbox',
  radio: 'radio',
  radio_button: 'radio',
  radio_group: 'radio',
  option: 'radio',
  opcao: 'radio',
  switch: 'switch',
  toggle: 'switch',
  interruptor: 'switch',
  slider: 'slider',
  range: 'slider',
  range_slider: 'slider',
  tab: 'tab',
  aba: 'tab',
  tab_item: 'tab',
  menuitem: 'menuitem',
  menu_item: 'menuitem',
  item_de_menu: 'menuitem',
  menu: 'menuitem',
  listitem: 'other',
  list_item: 'other',
};

/** Tipo livre do modelo → vocabulário fechado (`other` quando não reconhece). */
export function normalizeType(raw: string | null | undefined): VisionElementType {
  const chave = normalizeText(raw).replace(/ /g, '_');
  if (!chave) return 'other';
  const direto = TYPE_ALIASES[chave];
  if (direto) return direto;
  // "button_with_icon", "input_field_email": primeiro token reconhecível.
  for (const parte of chave.split('_')) {
    const t = TYPE_ALIASES[parte];
    if (t) return t;
  }
  return 'other';
}

/** Ponto dentro da caixa (bordas inclusivas). */
export function pointInBBox(x: number, y: number, b: VisionBBox): boolean {
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}

/** Distância euclidiana ao centro do elemento. */
export function distanceToCenter(x: number, y: number, b: VisionBBox): number {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return Math.hypot(x - cx, y - cy);
}

/** IoU (diagnóstico/relatório; o placar usa o ponto). */
export function bboxIoU(a: VisionBBox, b: VisionBBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const uniao = a.w * a.h + b.w * b.h - inter;
  return uniao > 0 ? inter / uniao : 0;
}

/** Similaridade para o `text` de ações de digitação (0–1). */
export function textSimilarity(expected: string, predicted: string): number {
  const a = normalizeText(expected);
  const b = normalizeText(predicted);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.9;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const inter = ta.filter((t) => tb.includes(t)).length;
  return inter / Math.max(ta.length, tb.length);
}
