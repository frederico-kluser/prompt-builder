import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import type { ModelCaps, OpenRouterModel, ReasoningLevel } from '../api';
import {
  EFFORT_LABEL,
  effortOptions,
  fetchModels,
  formatPricingLabel,
  isKnownPrice,
  modelCaps,
  unknownPriceNote,
  UNKNOWN_PRICE_LABEL,
} from '../api';
import { DEFAULT_OPENROUTER_BASE_URL } from '../engine/openrouter';
import { useMotionUITransition, useMotionUITheme } from '@/components/motion-ui/ui-theme';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from './Modal';
import { Chip, RovingItem, RovingToolbar, useRovingTabStop } from './primitives';
import { cn } from '@/lib/utils';

/** Ajuste fino de UM modelo escolhido. temperature como TEXTO: '' = padrão do modelo. */
export interface ModelTuning {
  effort?: '' | ReasoningLevel;
  temperature?: string;
}

interface Props {
  multi?: boolean;
  value: string[];
  onChange: (ids: string[]) => void;
  title: string;
  hint?: string;
  excludeIds?: string[];
  /** Catálogo compartilhado (evita cada seletor refazer o fetch). Sem ele, busca sozinho. */
  models?: OpenRouterModel[];
  loading?: boolean;
  /** Compacto: sem card próprio, para embutir numa linha de outro bloco. Default true. */
  inline?: boolean;
  /** Ajuste fino por modelo escolhido. Ausente = seletor simples, sem ajustes. */
  tuning?: Record<string, ModelTuning>;
  onTuningChange?: (modelId: string, patch: Partial<ModelTuning>) => void;
  /** Quais ajustes oferecer; a capacidade REAL ainda vem do supported_parameters. */
  tuningFields?: ('effort' | 'temperature')[];
}

const ALL_TUNING_FIELDS: ('effort' | 'temperature')[] = ['effort', 'temperature'];

/**
 * Rótulo de preço. Desconhecido ("-1" no catálogo: roteadores) vira "preço
 * variável" — nunca "-1" nem "$-1000000.00" (IMPL-018). Regra única em
 * src/engine/pricing.ts (a mesma do CLI).
 */
function priceLabel(model: OpenRouterModel): string {
  return formatPricingLabel(model.pricing);
}

/** Nome curto do modelo: o que vem depois da última '/' do id. */
function shortName(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/** Resumo do ajuste ativo (vai no `title` do chip). Vazio = sem ajuste. */
function tuneSummary(t?: ModelTuning): string {
  const partes: string[] = [];
  const nivel = t?.effort;
  if (nivel) {
    const rotulo = EFFORT_LABEL[nivel === 'off' ? 'none' : nivel] ?? nivel;
    partes.push(`esforço ${rotulo.toLowerCase()}`);
  }
  const temp = t?.temperature?.trim();
  if (temp) partes.push(`temperatura ${temp}`);
  return partes.join(' · ');
}

// -------- fuzzy search --------
// Score baseado em: subsequence match, prefixos, palavras-chave e proximidade.
function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();

  if (h === n) return 1000;
  if (h.startsWith(n)) return 700 + Math.max(0, 50 - (h.length - n.length));
  if (h.includes(n)) return 500;

  // Subsequence: cada caractere de n precisa aparecer em h em ordem.
  let hi = 0;
  let score = 0;
  let consecutive = 0;
  let prevChar = '';
  for (let ni = 0; ni < n.length; ni++) {
    const c = n[ni];
    let found = -1;
    while (hi < h.length) {
      if (h[hi] === c) {
        found = hi;
        break;
      }
      hi++;
    }
    if (found === -1) return 0;

    const before = found > 0 ? h[found - 1] : '';
    const isBoundary = found === 0 || /[/\-_.: ]/.test(before);
    if (isBoundary) score += 8;

    if (prevChar && h[found - 1] === prevChar && found > 0) {
      consecutive += 1;
      score += 4 + consecutive * 2;
    } else {
      consecutive = 0;
    }

    score += 2;
    prevChar = c;
    hi = found + 1;
  }

  score -= Math.floor(h.length / 20);
  return score;
}

function multiTokenScore(haystack: string, query: string): number {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  let total = 0;
  for (const t of tokens) {
    const s = fuzzyScore(haystack, t);
    if (s <= 0) return 0; // todos os tokens precisam matchear
    total += s;
  }
  return total;
}

/* ------------------------------------------------- ordenação do catálogo */

/**
 * Os sorts NATIVOS do catálogo do OpenRouter (`GET /models?sort=…`), com os
 * mesmos ids — inclusive o default `top-weekly` (popularidade semanal), que NÃO
 * é o `newest` do endpoint (o /models cru vem por data de criação).
 */
export interface ModelSortOption {
  id: string;
  label: string;
  /**
   * true = ranking que só o servidor calcula (tokens processados na semana,
   * throughput, latência): não vem no payload do /models. A ordem chega pelo
   * `?sort=` do catálogo; fora da rede cai na ordem estável do catálogo local.
   */
  serverOnly: boolean;
}

export const MODEL_SORTS: ModelSortOption[] = [
  { id: 'top-weekly', label: 'Popularidade semanal', serverOnly: true },
  { id: 'newest', label: 'Mais novos', serverOnly: false },
  { id: 'context-high-to-low', label: 'Maior contexto', serverOnly: false },
  { id: 'pricing-low-to-high', label: 'Menor preço', serverOnly: false },
  { id: 'intelligence-high-to-low', label: 'Mais inteligentes', serverOnly: false },
  { id: 'coding-high-to-low', label: 'Melhores em coding', serverOnly: false },
  { id: 'agentic-high-to-low', label: 'Melhores em agentic', serverOnly: false },
  { id: 'throughput-high-to-low', label: 'Maior throughput', serverOnly: true },
  { id: 'latency-low-to-high', label: 'Menor latência', serverOnly: true },
];

/** Default ≠ `newest`: o catálogo abre por popularidade semanal (R-11b:REC-7). */
export const DEFAULT_MODEL_SORT = 'top-weekly';

/** Item cru do /models — o catálogo manda mais do que o tipo de domínio carrega. */
function rawItem(m: OpenRouterModel): Record<string, unknown> | null {
  const raw = (m as { raw?: unknown }).raw;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/**
 * Índice de benchmark do catálogo (`benchmarks.artificial_analysis.*` no item
 * cru). Ausente/malformado = null (o modelo cai para o fim daquele ranking,
 * nunca numa posição inventada).
 */
export function benchmarkIndex(
  m: OpenRouterModel,
  key: 'intelligence_index' | 'coding_index' | 'agentic_index',
): number | null {
  const bench = rawItem(m)?.benchmarks;
  const aa = bench && typeof bench === 'object' ? (bench as Record<string, unknown>).artificial_analysis : undefined;
  const v = aa && typeof aa === 'object' ? (aa as Record<string, unknown>)[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Modalidades de ENTRADA do modelo (`architecture.input_modalities` cru). */
function inputModalities(m: OpenRouterModel): string[] {
  const arch = rawItem(m)?.architecture;
  const mods = arch && typeof arch === 'object' ? (arch as Record<string, unknown>).input_modalities : undefined;
  return Array.isArray(mods) ? mods.filter((x): x is string => typeof x === 'string') : [];
}

/** Soma entrada+saída por token (ordem do sort "menor preço"); null = preço variável. */
function priceSum(m: OpenRouterModel): number | null {
  const { prompt, completion } = m.pricing;
  if (!isKnownPrice(prompt) || !isKnownPrice(completion)) return null;
  return prompt + completion;
}

/**
 * Ordenação local (determinística, sem rede) por dado do próprio catálogo.
 * Para os sorts `serverOnly` não há dado local — a ordem fica estável e quem
 * ordena de verdade é o `?sort=` do catálogo (ver `applyServerOrder`).
 */
export function sortModels(models: OpenRouterModel[], sortId: string): OpenRouterModel[] {
  const out = [...models];
  // nulls sempre no fim do ranking, nunca em posição inventada.
  const porIndice = (key: 'intelligence_index' | 'coding_index' | 'agentic_index') => (a: OpenRouterModel, b: OpenRouterModel) => {
    const ka = benchmarkIndex(a, key);
    const kb = benchmarkIndex(b, key);
    if (ka === null && kb === null) return 0;
    if (ka === null) return 1;
    if (kb === null) return -1;
    return kb - ka;
  };
  switch (sortId) {
    case 'newest':
      return out.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    case 'context-high-to-low':
      return out.sort((a, b) => (b.contextLength ?? -1) - (a.contextLength ?? -1));
    case 'pricing-low-to-high': {
      return out.sort((a, b) => {
        const pa = priceSum(a);
        const pb = priceSum(b);
        if (pa === null && pb === null) return 0;
        if (pa === null) return 1;
        if (pb === null) return -1;
        return pa - pb;
      });
    }
    case 'intelligence-high-to-low':
      return out.sort(porIndice('intelligence_index'));
    case 'coding-high-to-low':
      return out.sort(porIndice('coding_index'));
    case 'agentic-high-to-low':
      return out.sort(porIndice('agentic_index'));
    default:
      // top-weekly / throughput / latency: ranking do servidor, sem dado local.
      return out;
  }
}

/** URL do catálogo com o sort nativo (o parâmetro é do próprio /models). */
export function modelsSortUrl(baseUrl: string, sortId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/models?sort=${encodeURIComponent(sortId)}`;
}

/**
 * Aplica a ordem do RANKING do servidor sobre a lista local: o que não veio no
 * ranking (fora do catálogo servidor) fica no fim, na ordem atual.
 */
export function applyServerOrder(models: OpenRouterModel[], serverIds: readonly string[]): OpenRouterModel[] {
  const pos = new Map(serverIds.map((id, i) => [id, i]));
  return [...models].sort((a, b) => {
    const pa = pos.get(a.id);
    const pb = pos.get(b.id);
    if (pa === undefined && pb === undefined) return 0;
    if (pa === undefined) return 1;
    if (pb === undefined) return -1;
    return pa - pb;
  });
}

// Ordem do servidor por sort, em memória (o ranking muda devagar; 10 min).
const ORDER_CACHE = new Map<string, { at: number; ids: string[] }>();
const ORDER_TTL_MS = 10 * 60_000;

/**
 * Ids do catálogo NA ORDEM do sort pedido (`GET /models?sort=…` — endpoint
 * público de METADADOS, sem chamada de modelo). Falhou = null (o chamador cai
 * na ordenação local); nunca lança.
 */
export async function fetchSortOrder(sortId: string): Promise<string[] | null> {
  const hit = ORDER_CACHE.get(sortId);
  if (hit && Date.now() - hit.at < ORDER_TTL_MS) return hit.ids;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(modelsSortUrl(DEFAULT_OPENROUTER_BASE_URL, sortId), { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: unknown };
    const raw = Array.isArray(json.data) ? json.data : [];
    const ids = raw
      .map((i) => (i && typeof i === 'object' ? (i as Record<string, unknown>).id : undefined))
      .filter((x): x is string => typeof x === 'string');
    ORDER_CACHE.set(sortId, { at: Date.now(), ids });
    return ids;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------------------- facetas */

/** Capacidades do modelo, direto do catálogo (nunca de tabela chumbada). */
export interface ModelFacets {
  reasoning: boolean;
  tools: boolean;
  vision: boolean;
  longContext: boolean;
  free: boolean;
  deprecated: boolean;
}

export const FACET_OPTIONS: { id: keyof ModelFacets; label: string }[] = [
  { id: 'reasoning', label: 'Raciocínio' },
  { id: 'tools', label: 'Tools' },
  { id: 'vision', label: 'Visão' },
  { id: 'longContext', label: 'Contexto longo' },
  { id: 'free', label: 'Gratuito' },
  { id: 'deprecated', label: 'Depreciados' },
];

export function modelFacets(m: OpenRouterModel): ModelFacets {
  const { prompt, completion } = m.pricing;
  return {
    reasoning: modelCaps(m).reasoning,
    tools: (m.supportedParameters ?? []).includes('tools'),
    vision: inputModalities(m).includes('image'),
    longContext: (m.contextLength ?? 0) >= 128_000,
    free: isKnownPrice(prompt) && isKnownPrice(completion) && prompt === 0 && completion === 0,
    deprecated: !!m.expirationDate,
  };
}

/** Provedor = autor do id (parte antes da primeira '/'). */
export function providerOf(id: string): string {
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : id;
}

/* ------------------------------------------------- virtualização da lista */

/** Altura nominal de uma linha da lista (id + nome + preço). */
export const PICKER_ROW_PX = 56;
/** Altura nominal da viewport da lista (a real é `max-h-[52vh]`); overscan cobre a diferença. */
const PICKER_VIEWPORT_PX = 600;
const PICKER_OVERSCAN = 8;

/** Janela visível da lista virtualizada (puro; testado fora do navegador). */
export function virtualWindow(
  scrollTop: number,
  count: number,
  viewportPx = PICKER_VIEWPORT_PX,
  rowPx = PICKER_ROW_PX,
  overscan = PICKER_OVERSCAN,
): { start: number; end: number; padTop: number; padBottom: number } {
  const first = Math.floor(Math.max(0, scrollTop) / rowPx);
  const visible = Math.ceil(viewportPx / rowPx) + overscan * 2;
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, start + visible);
  return {
    start,
    end,
    padTop: start * rowPx,
    padBottom: Math.max(0, (count - end) * rowPx),
  };
}

/* ------------------------------------------------- teclado do combobox */

export type PickerKeyAction =
  | { type: 'move'; index: number }
  | { type: 'select'; index: number }
  | { type: 'close' }
  | { type: 'open' }
  | { type: 'none' };

/**
 * Teclado do combobox (W3C APG): setas movem o item ATIVO (foco ≠ seleção),
 * Enter seleciona o ativo, Esc fecha o popup. Puro — o componente só aplica a
 * intenção no estado.
 */
export function pickerKeyAction(
  key: string,
  s: { active: number; count: number; open: boolean },
): PickerKeyAction {
  if (key === 'Escape') return s.open ? { type: 'close' } : { type: 'none' };
  if (!s.open && (key === 'ArrowDown' || key === 'ArrowUp')) return { type: 'open' };
  if (s.count === 0) return { type: 'none' };
  switch (key) {
    case 'ArrowDown':
      return { type: 'move', index: Math.min(s.count - 1, s.active + 1) };
    case 'ArrowUp':
      return { type: 'move', index: Math.max(0, s.active - 1) };
    case 'Home':
      return { type: 'move', index: 0 };
    case 'End':
      return { type: 'move', index: s.count - 1 };
    case 'Enter':
      return { type: 'select', index: Math.min(s.active, s.count - 1) };
    default:
      return { type: 'none' };
  }
}

/* ------------------------------------------------------ painel de ajuste */

/**
 * Ajustes do modelo aberto — SOMENTE os controles que ele aceita (capacidade
 * real do `supported_parameters`, cruzada com `tuningFields`).
 */
function ModelTune(p: {
  panelId: string;
  modelId: string;
  caps: ModelCaps;
  fields: ('effort' | 'temperature')[];
  value: ModelTuning;
  onChange: (patch: Partial<ModelTuning>) => void;
}) {
  const temEsforco = p.caps.reasoning && p.fields.includes('effort');
  const temTemperatura = p.caps.temperature && p.fields.includes('temperature');
  const ui = useMotionUITransition('ui');
  const { motionMode } = useMotionUITheme();

  return (
    <motion.div
      id={p.panelId}
      role="group"
      aria-label={`Ajustes de ${p.modelId}`}
      layout={motionMode === 'full'}
      initial={motionMode === 'off' ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={ui}
      className="mt-2 rounded-lg border border-border bg-muted/40 p-3"
    >
      <div className="mb-2 font-mono text-[11px] text-muted-foreground">{p.modelId}</div>

      {temEsforco && (
        <label className="mb-2 flex flex-wrap items-center justify-between gap-2 last:mb-0">
          <span className="text-[13px]">
            Esforço
            <span className="block text-[12px] text-muted-foreground">
              Quanto o modelo pensa antes de responder. Mais esforço custa mais tokens.
            </span>
          </span>
          <select
            className="h-8 rounded-lg border border-input bg-background px-2 text-[13px] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-label={`Esforço de ${p.modelId}`}
            value={p.value.effort ?? ''}
            onChange={(e) => p.onChange({ effort: e.target.value as '' | ReasoningLevel })}
          >
            {effortOptions(p.caps).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {temTemperatura && (
        <label className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13px]">
            Temperatura
            <span className="block text-[12px] text-muted-foreground">
              0 = sempre a resposta mais provável. Acima disso, mais variação entre execuções.
            </span>
          </span>
          <Input
            type="number"
            className="h-8 w-24"
            min={0}
            max={2}
            step={0.1}
            placeholder="padrão"
            aria-label={`Temperatura de ${p.modelId}`}
            value={p.value.temperature ?? ''}
            onChange={(e) => p.onChange({ temperature: e.target.value })}
          />
        </label>
      )}

      {!temEsforco && !temTemperatura && (
        <p className="text-[12px] text-muted-foreground">
          Este modelo não aceita ajuste de esforço nem de temperatura.
        </p>
      )}
    </motion.div>
  );
}

/* ------------------------------------------------ painel do catálogo (popup) */

export interface ModelPickerProps {
  /** Catálogo DISPONÍVEL (já sem selecionados/excluídos pelo chamador). */
  models: OpenRouterModel[];
  /** Seleção atual (para o `aria-selected` honesto de cada opção). */
  value: string[];
  onPick: (id: string) => void;
  /** Fecha o popup (Esc). Ausente = o chamador não tem popup para fechar. */
  onClose?: () => void;
  title: string;
  error?: string | null;
  /** Nome acessível do listbox. */
  listLabel?: string;
  /** Seleção múltipla: a lista continua aberta depois de escolher. */
  multi?: boolean;
  /**
   * Ref do input combobox — é o foco inicial do popup (padrão W3C APG: o foco
   * vive no input, o item ATIVO é só o `aria-activedescendant`).
   */
  inputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * O conteúdo do popup de escolha: busca + ordenação nativa + facetas com
 * contagem + LISTA VIRTUALIZADA no padrão ARIA combobox (input combobox →
 * popup listbox, `aria-activedescendant` marcando o item ATIVO). Os chips de
 * seleção múltipla ficam FORA do listbox, no corpo do seletor.
 */
export function ModelPicker({ models, value, onPick, onClose, title, error, listLabel, multi, inputRef }: ModelPickerProps) {
  const uid = useId();
  const listId = `${uid}-list`;
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(DEFAULT_MODEL_SORT);
  const [provider, setProvider] = useState('');
  const [facets, setFacets] = useState<Set<keyof ModelFacets>>(new Set());
  const [active, setActive] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [serverIds, setServerIds] = useState<string[] | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const sortOption = MODEL_SORTS.find((s) => s.id === sort) ?? MODEL_SORTS[0];

  // Sorts de ranking: a ordem vem do próprio catálogo (`?sort=`). Falhou ou é
  // sort local → ordenação determinística pelos dados do catálogo.
  useEffect(() => {
    if (!sortOption.serverOnly) {
      setServerIds(null);
      return;
    }
    let activeFetch = true;
    fetchSortOrder(sort)
      .then((ids) => activeFetch && setServerIds(ids))
      .catch(() => activeFetch && setServerIds(null));
    return () => {
      activeFetch = false;
    };
  }, [sort, sortOption.serverOnly]);

  const providers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of models) counts.set(providerOf(m.id), (counts.get(providerOf(m.id)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [models]);

  const facetCounts = useMemo(() => {
    const counts = new Map<keyof ModelFacets, number>();
    for (const m of models) {
      const f = modelFacets(m);
      for (const { id } of FACET_OPTIONS) if (f[id]) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [models]);

  // Busca + facetas + provedor. Com query a ordem é relevância (score); sem
  // query é o sort escolhido (local ou a ordem de ranking do servidor).
  const filtered = useMemo(() => {
    const q = query.trim();
    const semFiltro = models.filter((m) => {
      if (provider && providerOf(m.id) !== provider) return false;
      const f = modelFacets(m);
      for (const id of facets) if (!f[id]) return false;
      return true;
    });
    const base = serverIds ? applyServerOrder(semFiltro, serverIds) : sortModels(semFiltro, sort);
    if (!q) return base;
    return base
      .map((m) => {
        const idScore = multiTokenScore(m.id, q);
        const nameScore = multiTokenScore(m.name, q);
        return { m, score: idScore * 1.5 + nameScore };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.m);
  }, [models, query, sort, provider, facets, serverIds]);

  const win = virtualWindow(scrollTop, filtered.length);
  const optionId = (i: number) => `${uid}-opt-${i}`;
  const selectedSet = useMemo(() => new Set(value), [value]);

  function applyAction(a: PickerKeyAction) {
    if (a.type === 'move') {
      setActive(a.index);
      // Rola o item ativo para dentro da janela visível (virtualização).
      const el = listRef.current;
      if (el) {
        const top = a.index * PICKER_ROW_PX;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (top + PICKER_ROW_PX > el.scrollTop + el.clientHeight) {
          el.scrollTop = top + PICKER_ROW_PX - el.clientHeight;
        }
      }
    } else if (a.type === 'select') {
      const m = filtered[a.index];
      if (m) {
        onPick(m.id);
        // Multi: a lista fica aberta para somar mais — limpa a busca e volta ao topo.
        setQuery('');
        setActive(0);
        setScrollTop(0);
        if (listRef.current) listRef.current.scrollTop = 0;
      }
    } else if (a.type === 'close') {
      onClose?.();
    }
  }

  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder="Buscar modelo…"
          aria-label="Buscar modelo"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={filtered.length > 0 ? optionId(Math.min(active, filtered.length - 1)) : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setScrollTop(0);
            if (listRef.current) listRef.current.scrollTop = 0;
          }}
          onKeyDown={(e) => {
            const a = pickerKeyAction(e.key, { active, count: filtered.length, open: true });
            if (a.type === 'none') return;
            e.preventDefault();
            applyAction(a);
          }}
        />
        {/* Contagem HONESTA: X filtrado de Y disponível (antes era um número
            solto sobre uma lista truncada em 60 — R-11b:REC-7). */}
        <span className="mr-8 shrink-0 text-[11px] text-muted-foreground tabular" aria-live="polite">
          mostrando {filtered.length} de {models.length}
        </span>
      </div>

      {/* Ordenação nativa + facetas: UMA parada de Tab (roving). */}
      <RovingToolbar
        label="Ordenação e filtros do catálogo"
        count={2 + FACET_OPTIONS.length}
        className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5"
      >
        <RovingItem index={0}>
          {(roving) => (
            <select
              {...roving}
              className="h-8 rounded-lg border border-input bg-background px-2 text-[12.5px] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label="Ordenar por"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value);
                setActive(0);
                setScrollTop(0);
                if (listRef.current) listRef.current.scrollTop = 0;
              }}
            >
              {MODEL_SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          )}
        </RovingItem>
        <RovingItem index={1}>
          {(roving) => (
            <select
              {...roving}
              className="h-8 rounded-lg border border-input bg-background px-2 text-[12.5px] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label="Provedor"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="">Provedor (todos)</option>
              {providers.map(([id, n]) => (
                <option key={id} value={id}>
                  {id} ({n})
                </option>
              ))}
            </select>
          )}
        </RovingItem>
        {FACET_OPTIONS.map((f, i) => (
          <Chip
            key={f.id}
            index={i + 2}
            on={facets.has(f.id)}
            label={`${f.label} ${facetCounts.get(f.id) ?? 0}`}
            onClick={() =>
              setFacets((prev) => {
                const next = new Set(prev);
                if (next.has(f.id)) next.delete(f.id);
                else next.add(f.id);
                return next;
              })
            }
          />
        ))}
      </RovingToolbar>

      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={listLabel ?? title}
        className="scroll-slim max-h-[52vh] overflow-y-auto p-1.5"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {error && <li className="px-3 py-6 text-center text-sm text-destructive">{error}</li>}
        {!error && filtered.length === 0 && (
          <li className="px-3 py-6 text-center text-sm text-muted-foreground">Nenhum modelo encontrado</li>
        )}
        {win.padTop > 0 && <li aria-hidden="true" style={{ height: win.padTop }} />}
        {filtered.slice(win.start, win.end).map((m, i) => {
          const idx = win.start + i;
          return (
            <li
              key={m.id}
              id={optionId(idx)}
              role="option"
              aria-selected={selectedSet.has(m.id)}
              onClick={() => onPick(m.id)}
              onMouseDown={(e) => e.preventDefault()}
              className={cn(
                'flex cursor-pointer items-baseline gap-3 rounded-lg px-2.5 py-2 hover:bg-muted',
                idx === Math.min(active, filtered.length - 1) && 'bg-muted',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[12.5px] text-foreground">{m.id}</span>
                <span className="block truncate text-[12px] text-muted-foreground">{m.name}</span>
                {/* Badges de capacidade — o que a chamada consegue fazer. */}
                <span className="mt-0.5 flex flex-wrap gap-1">
                  {modelFacets(m).reasoning && (
                    <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">raciocínio</span>
                  )}
                  {modelFacets(m).tools && (
                    <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">tools</span>
                  )}
                  {modelFacets(m).vision && (
                    <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">visão</span>
                  )}
                </span>
              </span>
              <span
                className="shrink-0 font-mono text-[11px] text-muted-foreground tabular"
                title={unknownPriceNote(m) ?? undefined}
              >
                {priceLabel(m)}
              </span>
            </li>
          );
        })}
        {win.padBottom > 0 && <li aria-hidden="true" style={{ height: win.padBottom }} />}
      </ul>

      {multi && (
        <div className="border-t border-border px-4 py-2.5 text-[12px] text-muted-foreground">
          {value.length} escolhido{value.length === 1 ? '' : 's'} · a lista continua aberta para somar mais
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------- chip do modelo */

/** Botão de ação dentro do chip escolhido (uma parada de Tab no toolbar). */
function ChipAction(p: { index: number; label: string; onClick: () => void; children: ReactNode }) {
  const roving = useRovingTabStop(p.index);
  return (
    <button
      type="button"
      {...roving}
      aria-label={p.label}
      onClick={p.onClick}
      className="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
    >
      {p.children}
    </button>
  );
}

/* -------------------------------------------------------------- seletor */

export function ModelSelector({
  multi = true,
  value,
  onChange,
  title,
  hint,
  excludeIds = [],
  models: sharedModels,
  loading: sharedLoading,
  inline = true,
  tuning,
  onTuningChange,
  tuningFields = ALL_TUNING_FIELDS,
}: Props) {
  const selfManaged = sharedModels === undefined;
  const [selfModels, setSelfModels] = useState<OpenRouterModel[]>([]);
  const [selfLoading, setSelfLoading] = useState(selfManaged);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Id do modelo com o painel de ajuste aberto (um por vez). null = fechado.
  const [tuneOpen, setTuneOpen] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const tunePanelId = `tune-${title.replace(/\s+/g, '-').toLowerCase()}`;

  const models = sharedModels ?? selfModels;
  const loading = selfManaged ? selfLoading : !!sharedLoading;

  useEffect(() => {
    if (!selfManaged) return;
    let active = true;
    fetchModels()
      .then((data) => active && setSelfModels(data))
      .catch((err) => active && setError(err.message))
      .finally(() => active && setSelfLoading(false));
    return () => {
      active = false;
    };
  }, [selfManaged]);

  // Mantém TODOS os ids selecionados, mesmo os que ainda não estão no catálogo
  // carregado (ex.: defaults pré-preenchidos) — senão o chip some da tela.
  const selected = useMemo(
    () => value.map((id) => ({ id, model: models.find((m) => m.id === id) })),
    [value, models],
  );

  // Disponíveis = catálogo menos os já escolhidos e os excluídos pelo chamador.
  const available = useMemo(() => {
    const excluded = new Set([...excludeIds, ...value]);
    return models.filter((m) => !excluded.has(m.id));
  }, [models, excludeIds, value]);

  function select(id: string) {
    if (multi) {
      if (!value.includes(id)) onChange([...value, id]);
    } else {
      onChange([id]);
      setOpen(false);
    }
  }

  function remove(id: string) {
    onChange(value.filter((v) => v !== id));
  }

  const addLabel = loading ? 'carregando…' : !multi && value.length > 0 ? 'trocar' : 'adicionar';

  // Sem as duas props de ajuste, o seletor é o de sempre: chips + adicionar.
  const tunable = !!(tuning && onTuningChange);
  // Modelo removido enquanto o painel dele estava aberto: não renderiza órfão.
  const tuneModelId = tunable && tuneOpen && value.includes(tuneOpen) ? tuneOpen : null;
  // Índices de roving: por chip cabem 1 (remover) ou 2 (ajustar + remover) botões.
  const perChip = tunable ? 2 : 1;
  const addIndex = selected.length * perChip;

  return (
    <div className={cn('w-full', !inline && 'rounded-xl bg-card p-4 ring-1 ring-foreground/10')}>
      <RovingToolbar label={title} count={addIndex + 1} className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-medium text-foreground" title={hint}>
          {title}
        </span>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <AnimatePresence initial={false} mode="popLayout">
            {selected.map(({ id, model }, i) => {
              const resumo = tunable ? tuneSummary(tuning?.[id]) : '';
              // Preço variável (roteador, "-1"): selo textual + aviso de custo não
              // estimável no title — nunca um número negativo (IMPL-043).
              const nota = unknownPriceNote(model);
              const base = model
                ? `${id} — ${priceLabel(model)}${nota ? ` · ${nota}` : ''}`
                : loading
                  ? `${id} — carregando…`
                  : `${id} — fora do catálogo`;
              return (
                <motion.span
                  key={id}
                  layout
                  initial={{ opacity: 0, transform: 'scale(0.9)' }}
                  animate={{ opacity: 1, transform: 'scale(1)' }}
                  exit={{ opacity: 0, transform: 'scale(0.9)' }}
                  transition={{ type: 'spring', stiffness: 700, damping: 45 }}
                  title={resumo ? `${base} · ${resumo}` : base}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-2.5 text-[12px] font-medium',
                    resumo
                      ? 'border-primary/40 bg-primary/10 text-foreground'
                      : 'border-border bg-muted text-foreground',
                  )}
                >
                  {shortName(id)}
                  {nota && (
                    <span className="rounded-full bg-background px-1.5 text-[10px] font-normal text-muted-foreground">
                      {UNKNOWN_PRICE_LABEL}
                    </span>
                  )}
                  {tunable && (
                    <ChipAction
                      index={i * perChip}
                      label={`Ajustar ${id}`}
                      onClick={() => setTuneOpen((v) => (v === id ? null : id))}
                    >
                      <SlidersHorizontal className="size-3" aria-hidden="true" />
                    </ChipAction>
                  )}
                  <ChipAction
                    index={i * perChip + (tunable ? 1 : 0)}
                    label={`Remover ${id}`}
                    onClick={() => remove(id)}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </ChipAction>
                </motion.span>
              );
            })}
          </AnimatePresence>

          <RovingItem index={addIndex}>
            {(roving) => (
              <Button
                type="button"
                variant="outline"
                size="xs"
                {...roving}
                disabled={loading}
                onClick={() => setOpen(true)}
              >
                <Plus aria-hidden="true" />
                {addLabel}
              </Button>
            )}
          </RovingItem>
        </div>
      </RovingToolbar>

      {tuneModelId && (
        <ModelTune
          panelId={tunePanelId}
          modelId={tuneModelId}
          caps={modelCaps(models.find((m) => m.id === tuneModelId) ?? { id: tuneModelId })}
          fields={tuningFields}
          value={tuning?.[tuneModelId] ?? {}}
          onChange={(patch) => onTuningChange?.(tuneModelId, patch)}
        />
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        label={`Escolher modelo — ${title}`}
        initialFocus={searchRef}
        className="max-w-xl"
      >
        <ModelPicker
          models={available}
          value={value}
          onPick={select}
          onClose={() => setOpen(false)}
          title={title}
          error={error}
          listLabel={title}
          multi={multi}
          inputRef={searchRef}
        />
      </Modal>
    </div>
  );
}
