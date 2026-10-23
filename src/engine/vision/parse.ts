// BENCHMARK DE VISÃO — parser da saída do modelo (puro).
//
// Um benchmark de grounding morre no parser: o modelo devolve JSON cercado de
// texto, com `bbox` em vez de ponto, `"50%"`, coordenada 0–1000 quando pedimos
// pixel (ou o contrário), sinônimos de tipo em PT/EN. Nada disso é placar — é
// normalização. O que o parser NÃO faz é "consertar" alucinação: item sem
// coordenada finita é descartado, e a contagem de previsões é a que o modelo
// devolveu de verdade.
//
// Convenção (a mesma do record): a previsão guarda PIXELS da imagem canônica.
// O prompt pede o espaço configurado; a conversão para pixels acontece aqui, e
// o `coordScale` detectado vai junto para o record (se o modelo ignorou o
// pedido, o relatório mostra).

import type {
  VisionAction,
  VisionActionPrediction,
  VisionCoordScale,
  VisionCoordSpace,
  VisionElementPrediction,
  VisionParseResult,
} from './types.js';
import { VISION_ACTIONS } from './types.js';

/** Saída crua guardada no record — generosa, mas limitada (não é o placar). */
export const MAX_RAW_CHARS = 16_000;

const MAX_ELEMENTS = 200;

/** Texto auxiliar: isola o primeiro bloco JSON (array ou objeto) de uma resposta. */
export function extractJson(text: string): unknown | null {
  const cru = text.trim();
  if (!cru) return null;
  // 1) resposta inteira já é JSON.
  const direto = tryJson(cru);
  if (direto !== undefined) return direto;
  // 2) bloco cercado ```json … ```
  for (const m of cru.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) {
    const v = tryJson(m[1]!.trim());
    if (v !== undefined) return v;
  }
  // 3) primeiro array/objeto balanceado do texto.
  const v = firstBalanced(cru);
  return v ?? null;
}

function tryJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // tolera vírgula final antes de `]`/`}` (erro comum de modelo)
    try {
      return JSON.parse(text.replace(/,\s*([}\]])/g, '$1')) as unknown;
    } catch {
      return undefined;
    }
  }
}

/** Varre o texto e devolve o primeiro `[...]`/`{...}` balanceado que parseia. */
function firstBalanced(text: string): unknown | null {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '{' && c !== '[') continue;
    const fim = balancedEnd(text, i);
    if (fim < 0) continue;
    const v = tryJson(text.slice(i, fim + 1));
    if (v !== undefined) return v;
  }
  return null;
}

/** Índice do fechamento correspondente, ignorando strings; -1 se não fecha. */
function balancedEnd(text: string, start: number): number {
  const abre = text[start];
  const fecha = abre === '{' ? '}' : ']';
  let depth = 0;
  let emString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (emString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') emString = false;
      continue;
    }
    if (c === '"') emString = true;
    else if (c === abre) depth++;
    else if (c === fecha) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Número tolerante: `123`, `"123"`, `"123px"`, `"12,5"`, `"50%"`. */
export function looseNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, '').replace(/%$/, '');
  // decimal com vírgula (PT) quando não há ponto
  const normalizado = /^-?\d+,\d+$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}

const lc = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

function firstPresent(obj: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function textOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/** Coordenada tolerante: aceita `%` (relativo à dimensão) e converte para pixel. */
function coord(v: unknown, dim: number): number | null {
  const n = looseNumber(v);
  if (n == null) return null;
  if (typeof v === 'string' && v.trim().endsWith('%')) return (n / 100) * dim;
  return n;
}

/** `[x1,y1,x2,y2]` (ou objeto `{x,y,w,h}`) → centro em pixels. */
function centerFromBBox(v: unknown, viewport: { width: number; height: number }): { x: number; y: number } | null {
  const { width, height } = viewport;
  if (Array.isArray(v) && v.length === 4) {
    const a = coord(v[0], width);
    const b = coord(v[1], height);
    const c = coord(v[2], width);
    const d = coord(v[3], height);
    if (a == null || b == null || c == null || d == null) return null;
    return { x: (a + c) / 2, y: (b + d) / 2 };
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const x = coord(firstPresent(o, ['x', 'left']), width);
    const y = coord(firstPresent(o, ['y', 'top']), height);
    const w = coord(firstPresent(o, ['w', 'width']), width);
    const h = coord(firstPresent(o, ['h', 'height']), height);
    if (x != null && y != null && w != null && h != null) return { x: x + w / 2, y: y + h / 2 };
    const x1 = coord(firstPresent(o, ['x1', 'left']), width);
    const y1 = coord(firstPresent(o, ['y1', 'top']), height);
    const x2 = coord(firstPresent(o, ['x2', 'right']), width);
    const y2 = coord(firstPresent(o, ['y2', 'bottom']), height);
    if (x1 != null && y1 != null && x2 != null && y2 != null) return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  }
  return null;
}

/** Ponto cru do item: `x/y`, `point`, `position`, `coordinates`, `bbox`. */
function rawPoint(
  obj: Record<string, unknown>,
  viewport: { width: number; height: number },
): { x: number; y: number } | null {
  const { width, height } = viewport;
  const bbox = firstPresent(obj, ['bbox', 'box', 'bounds', 'rect', 'caixa', 'bounding_box']);
  const byBox = centerFromBBox(bbox, viewport);
  let x = coord(firstPresent(obj, ['x', 'cx', 'px', 'left']), width);
  let y = coord(firstPresent(obj, ['y', 'cy', 'py', 'top']), height);
  if (x != null && y != null) return { x, y };
  const ponto = firstPresent(obj, ['point', 'position', 'pos', 'coordinates', 'coords', 'coordenadas', 'ponto']);
  if (Array.isArray(ponto) && ponto.length >= 2) {
    const px = coord(ponto[0], width);
    const py = coord(ponto[1], height);
    if (px != null && py != null) return { x: px, y: py };
  }
  if (ponto && typeof ponto === 'object') {
    const o = ponto as Record<string, unknown>;
    x = coord(firstPresent(o, ['x', 'left']), width);
    y = coord(firstPresent(o, ['y', 'top']), height);
    if (x != null && y != null) return { x, y };
  }
  return byBox;
}

export interface CoordOptions {
  space: VisionCoordSpace;
  viewport: { width: number; height: number };
}

/** Detecta o espaço real usado (o modelo nem sempre obedece ao pedido). */
export function detectCoordScale(
  pontos: ReadonlyArray<{ x: number; y: number }>,
  opts: CoordOptions,
): VisionCoordScale {
  if (pontos.length === 0) return 'unknown';
  const maxX = Math.max(...pontos.map((p) => Math.abs(p.x)));
  const maxY = Math.max(...pontos.map((p) => Math.abs(p.y)));
  const max = Math.max(maxX, maxY);
  // Relativo 0–1 ocupa no máximo 1.0 — nenhum pixel legítimo cai aí.
  if (max > 0 && max <= 1.0001) return opts.space === 'pixels' ? 'normalized' : 'normalized';
  // Fora de 1000 em qualquer eixo não pode ser 0–1000 (a imagem é 1080p > 1000 na largura).
  if (max > 1000) return 'pixels';
  // Ambíguo: valores cabem nos dois. Fica com o PEDIDO (documentado no record).
  return opts.space;
}

/** Converte um ponto cru para pixels da imagem, com clamp e arredondamento. */
export function toPixels(
  p: { x: number; y: number },
  escala: VisionCoordScale,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const { width, height } = viewport;
  let x = p.x;
  let y = p.y;
  if (escala === 'normalized') {
    // 0–1000 é a convenção de UI-TARS/Gemini; 0–1 também aparece.
    const base = Math.max(Math.abs(x), Math.abs(y)) <= 1.0001 ? 1 : 1000;
    x = (x / base) * width;
    y = (y / base) * height;
  }
  return {
    x: Math.max(0, Math.min(width, Math.round(x))),
    y: Math.max(0, Math.min(height, Math.round(y))),
  };
}

/** Lista de elementos devolvida pelo modelo (array, ou objeto com a lista). */
export function elementsFromRoot(root: unknown, viewport: { width: number; height: number } = { width: 1920, height: 1080 }): unknown[] {
  if (Array.isArray(root)) return root;
  if (root && typeof root === 'object') {
    const o = root as Record<string, unknown>;
    for (const k of ['elements', 'elementos', 'items', 'interactive', 'controls', 'controles', 'result']) {
      const v = o[k];
      if (Array.isArray(v)) return v;
    }
    // Objeto único (um elemento só) — aceita.
    if (rawPoint(o, viewport)) return [o];
  }
  return [];
}

/**
 * Modo `map` — normaliza a lista de elementos prevista.
 * Item sem coordenada utilizável é descartado (não vira ponto 0,0).
 */
export function parseMapOutput(
  text: string,
  opts: CoordOptions,
): VisionParseResult<VisionElementPrediction[]> {
  const raw = text.slice(0, MAX_RAW_CHARS);
  const root = extractJson(text);
  if (root === null) {
    return { ok: false, value: null, error: 'sem JSON na resposta', coordScale: 'unknown', raw };
  }
  const brutos = elementsFromRoot(root, opts.viewport).slice(0, MAX_ELEMENTS);
  if (brutos.length === 0) {
    return { ok: false, value: null, error: 'JSON sem lista de elementos', coordScale: 'unknown', raw };
  }
  const itens: Array<{ obj: Record<string, unknown>; ponto: { x: number; y: number } }> = [];
  for (const b of brutos) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
    const obj = b as Record<string, unknown>;
    const ponto = rawPoint(obj, opts.viewport);
    if (!ponto) continue;
    itens.push({ obj, ponto });
  }
  if (itens.length === 0) {
    return { ok: false, value: null, error: 'nenhum item com coordenada', coordScale: 'unknown', raw };
  }
  const coordScale = detectCoordScale(
    itens.map((i) => i.ponto),
    opts,
  );
  const value = itens.map(({ obj, ponto }) => {
    const px = toPixels(ponto, coordScale, opts.viewport);
    const tipo = textOrNull(firstPresent(obj, ['type', 'tipo', 'role', 'kind', 'element_type']));
    const rotulo = textOrNull(
      firstPresent(obj, ['label', 'rotulo', 'rótulo', 'text', 'texto', 'name', 'nome', 'descricao', 'description']),
    );
    const icone = textOrNull(
      firstPresent(obj, [
        'iconDescription',
        'icon_description',
        'icone',
        'ícone',
        'icon',
        'aria_label',
        'ariaLabel',
      ]),
    );
    return {
      type: tipo ?? 'unknown',
      label: rotulo,
      iconDescription: icone,
      x: px.x,
      y: px.y,
    } satisfies VisionElementPrediction;
  });
  return { ok: true, value, coordScale, raw };
}

const ACTION_SYNONYMS: Record<string, VisionAction> = {
  click: 'click',
  clique: 'click',
  clicar: 'click',
  tap: 'click',
  toque: 'click',
  single_click: 'click',
  double_click: 'double_click',
  doubleclick: 'double_click',
  double: 'double_click',
  duplo_clique: 'double_click',
  right_click: 'right_click',
  rightclick: 'right_click',
  context_click: 'right_click',
  botao_direito: 'right_click',
  type: 'type',
  digitar: 'type',
  escrever: 'type',
  input: 'type',
  fill: 'type',
  preencher: 'type',
  select: 'select',
  escolher: 'select',
  choose: 'select',
  combobox: 'select',
  dropdown: 'select',
  hover: 'hover',
  passar_mouse: 'hover',
  mouse_over: 'hover',
  scroll: 'scroll',
  rolar: 'scroll',
  deslizar: 'scroll',
  key: 'key',
  press_key: 'key',
  tecla: 'key',
  atalho: 'key',
  hotkey: 'key',
};

/** Ação crua → vocabulário interno; `unknown` quando não reconhece. */
export function normalizeAction(v: unknown): { action: VisionAction | 'unknown'; rawAction: string } {
  const raw = typeof v === 'string' ? v.trim() : '';
  if (!raw) return { action: 'unknown', rawAction: '' };
  const chave = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const direto = ACTION_SYNONYMS[chave];
  if (direto) return { action: direto, rawAction: raw };
  // "click(400,300)", "type: texto" — fica com o primeiro token.
  const primeiro = chave.split(/[^a-z_]+/).filter(Boolean)[0];
  const parcial = primeiro ? ACTION_SYNONYMS[primeiro] : undefined;
  if (parcial) return { action: parcial, rawAction: raw };
  return { action: 'unknown', rawAction: raw };
}

/** Modo `action` — normaliza a ação prevista (com posição/target quando houver). */
export function parseActionOutput(
  text: string,
  opts: CoordOptions,
): VisionParseResult<VisionActionPrediction> {
  const raw = text.slice(0, MAX_RAW_CHARS);
  let root = extractJson(text);
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    const o = root as Record<string, unknown>;
    const acaoDe = firstPresent(o, ['action', 'acao', 'ação', 'action_type', 'tipo_acao']);
    if (acaoDe === undefined) {
      // às vezes vem `{action: {type, x, y}}` — desembrulha.
      const inner = o['action'] ?? o['acao'];
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) root = inner;
    }
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    return { ok: false, value: null, error: 'sem objeto JSON na resposta', coordScale: 'unknown', raw };
  }
  const obj = root as Record<string, unknown>;
  const acaoCru = firstPresent(obj, ['action', 'acao', 'ação', 'action_type', 'type', 'tipo', 'command']);
  const { action, rawAction } = normalizeAction(acaoCru);
  const ponto = rawPoint(obj, opts.viewport);
  let coordScale: VisionCoordScale = 'unknown';
  let x: number | null = null;
  let y: number | null = null;
  if (ponto) {
    coordScale = detectCoordScale([ponto], opts);
    const px = toPixels(ponto, coordScale, opts.viewport);
    x = px.x;
    y = px.y;
  }
  const target = textOrNull(firstPresent(obj, ['target', 'alvo', 'element', 'elemento', 'element_id']));
  const texto = textOrNull(firstPresent(obj, ['text', 'texto', 'value', 'valor', 'input', 'content']));
  // Só o mark-grid usa célula; normaliza "c3"/"C-3" para "C3" e ignora lixo.
  const cellCru = textOrNull(firstPresent(obj, ['cell', 'celula', 'célula', 'grid_cell', 'cell_id', 'mark', 'mark_id']));
  const cell = cellCru ? cellCru.toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
  if (action === 'unknown') {
    return {
      ok: false,
      value: { action, rawAction, target, x, y, text: texto, cell },
      error: `ação não reconhecida: ${rawAction || '(vazia)'}`,
      coordScale,
      raw,
    };
  }
  return {
    ok: true,
    value: { action, rawAction, target, x, y, text: texto, cell },
    coordScale,
    raw,
  };
}

/** A ação precisa de um ponto? (scroll/key não precisam.) */
export function actionNeedsPoint(action: VisionAction | 'unknown'): boolean {
  return action !== 'scroll' && action !== 'key';
}

/** Vocabulário exposto ao modelo (na ordem do prompt). */
export const ACTION_VOCAB = VISION_ACTIONS;
