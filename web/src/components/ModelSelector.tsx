import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import type { ModelCaps, OpenRouterModel, ReasoningLevel } from '../api';
import {
  EFFORT_LABEL,
  effortOptions,
  fetchModels,
  formatPricingLabel,
  modelCaps,
  unknownPriceNote,
  UNKNOWN_PRICE_LABEL,
} from '../api';
import { useMotionUITransition, useMotionUITheme } from '@/components/motion-ui/ui-theme';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from './Modal';
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
  const [query, setQuery] = useState('');
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

  // Ao fechar, limpa a busca — reabrir sempre começa do catálogo inteiro.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  // Mantém TODOS os ids selecionados, mesmo os que ainda não estão no catálogo
  // carregado (ex.: defaults pré-preenchidos) — senão o chip some da tela.
  const selected = useMemo(
    () => value.map((id) => ({ id, model: models.find((m) => m.id === id) })),
    [value, models],
  );

  const filtered = useMemo(() => {
    const excluded = new Set([...excludeIds, ...value]);
    const available = models.filter((m) => !excluded.has(m.id));

    const q = query.trim();
    if (!q) return available.slice(0, 60);

    return available
      .map((m) => {
        const idScore = multiTokenScore(m.id, q);
        const nameScore = multiTokenScore(m.name, q);
        return { m, score: idScore * 1.5 + nameScore };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60)
      .map((x) => x.m);
  }, [query, models, excludeIds, value]);

  function select(id: string) {
    if (multi) {
      if (!value.includes(id)) onChange([...value, id]);
      setQuery('');
      searchRef.current?.focus();
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

  return (
    <div className={cn('w-full', !inline && 'rounded-xl bg-card p-4 ring-1 ring-foreground/10')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-medium text-foreground" title={hint}>
          {title}
        </span>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <AnimatePresence initial={false} mode="popLayout">
            {selected.map(({ id, model }) => {
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
                    <button
                      type="button"
                      className="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
                      aria-label={`Ajustar ${id}`}
                      aria-expanded={tuneOpen === id}
                      aria-controls={tunePanelId}
                      onClick={() => setTuneOpen((v) => (v === id ? null : id))}
                    >
                      <SlidersHorizontal className="size-3" aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
                    aria-label={`Remover ${id}`}
                    onClick={() => remove(id)}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </motion.span>
              );
            })}
          </AnimatePresence>

          <Button type="button" variant="outline" size="xs" disabled={loading} onClick={() => setOpen(true)}>
            <Plus aria-hidden="true" />
            {addLabel}
          </Button>
        </div>
      </div>

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
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={searchRef}
            type="text"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder="Buscar modelo…"
            aria-label="Buscar modelo"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && filtered.length > 0) {
                e.preventDefault();
                select(filtered[0].id);
              }
            }}
          />
          <span className="mr-8 shrink-0 text-[11px] text-muted-foreground tabular">
            {filtered.length}
          </span>
        </div>

        <ul className="scroll-slim max-h-[52vh] overflow-y-auto p-1.5" role="listbox" aria-label={title}>
          {error && <li className="px-3 py-6 text-center text-sm text-destructive">{error}</li>}
          {!error && filtered.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">Nenhum modelo encontrado</li>
          )}
          {filtered.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="flex w-full items-baseline gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                onClick={() => select(m.id)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12.5px] text-foreground">{m.id}</span>
                  <span className="block truncate text-[12px] text-muted-foreground">{m.name}</span>
                </span>
                <span
                  className="shrink-0 font-mono text-[11px] text-muted-foreground tabular"
                  title={unknownPriceNote(m) ?? undefined}
                >
                  {priceLabel(m)}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {multi && (
          <div className="border-t border-border px-4 py-2.5 text-[12px] text-muted-foreground">
            {value.length} escolhido{value.length === 1 ? '' : 's'} · a lista continua aberta para somar mais
          </div>
        )}
      </Modal>
    </div>
  );
}
