import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, LoaderCircle, Trash2, Upload } from 'lucide-react';
import { ModelSelector, type ModelTuning } from '../components/ModelSelector';
import { ManualVariantsEditor } from '../components/ManualVariantsEditor';
import {
  arenaConfigSummary,
  createRun,
  createSession,
  estimateConfigCost,
  isCostConfirmationRequired,
  fetchLgpd,
  fetchModels,
  fetchTechniques,
  generateBasePrompt,
  getStoredKey,
  readImportFile,
  type ArenaConfigFile,
  type ManualVariant,
  type OpenRouterModel,
  type PromptContracts,
  type ReasoningConfig,
  type ReasoningLevel,
  type RunConfig,
  type RunMode,
  type ScenarioPack,
  type StageSpec,
  type Technique,
  type LaunchCostEstimate,
  effortOptions,
  modelCaps,
  describeMaxPriceFilter,
  filterByMaxPrice,
  unestimableCostNotice,
  UNKNOWN_PRICE_LABEL,
} from '../api';
import { CostConfirmDialog } from '../components/CostConfirmDialog';
import { AREA_LIVRE, creatorPrefix, familiaFor, filterModels, type LgpdData } from '../lgpd';
import { defaultMinGain, GATE_ALPHA } from '../engine/rank';
import { SegmentedToggle, SegmentedToggleOption } from '@/components/motion-ui/segmented-toggle';
import {
  SmoothTabs,
  SmoothTabsList,
  SmoothTabsTab,
  SmoothTabsPanels,
  SmoothTabsPanel,
} from '@/components/motion-ui/smooth-tabs';
import { MultiStateButton } from '@/components/motion-ui/multi-state-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Banner,
  ImportedLine,
  PageHeader,
  Screen,
  SettingGroup,
  SettingRow,
} from '../components/primitives';
import { cn } from '@/lib/utils';

// Defaults da run (ajustáveis na própria tela antes de iniciar).
const DEFAULT_COMPETITORS = ['openai/gpt-5-mini', 'openai/gpt-5-nano', 'openai/gpt-5.4-mini', 'openai/gpt-5.4-nano'];
const DEFAULT_CONTESTANT = 'openai/gpt-5-mini';
const DEFAULT_DATAGEN = 'deepseek/deepseek-v4-pro';
const DEFAULT_JUDGE = 'moonshotai/kimi-k2.6';
const DEFAULT_TECHNIQUES = ['persona', 'cot', 'constraints', 'format'];
const DEFAULT_THEME =
  'Assistente virtual de uma clínica de diagnósticos que orienta os pacientes no preparo para exames médicos e ' +
  'laboratoriais: tempo de jejum, suspensão de medicamentos, ingestão de água, restrições alimentares, preparo ' +
  'intestinal, documentos necessários, horários de coleta e reagendamento. As respostas devem ser claras, objetivas ' +
  'e seguras, orientando a confirmar com a clínica ou com o médico quando a dúvida envolver decisão clínica.';
const DEFAULT_MAX_OUTPUT_TOKENS = 500;
/** Nº de finalistas que disputam os duelos no fim (0 = sem finais). */
const DEFAULT_FINALISTS = 3;

// Ajustes oferecidos por papel. A capacidade REAL de cada modelo continua vindo
// do `supported_parameters` (o seletor cruza as duas coisas).
/** Quem responde sob teste: esforço e temperatura. */
const TUNE_FULL: ('effort' | 'temperature')[] = ['effort', 'temperature'];
/** Gerador, juízes, gabarito e reescritor: temperatura fixa por determinismo. */
const TUNE_EFFORT: ('effort' | 'temperature')[] = ['effort'];

const MODES: { id: RunMode; label: string }[] = [
  { id: 'compare', label: 'Comparar modelos' },
  { id: 'variation', label: 'Testar prompts' },
  { id: 'training', label: 'Treinar prompt' },
];

// 1 linha por modo, exibida sob o segmentado (o rótulo sozinho não diz o que roda).
const MODE_DESCRIPTIONS: Record<RunMode, string> = {
  compare: 'Vários modelos respondem aos mesmos cenários; os juízes decidem quem foi melhor.',
  variation: 'Um modelo, vários system prompts — descubra qual prompt funciona melhor.',
  training: 'O prompt evolui a cada rodada até convergir no melhor.',
};

/**
 * As abas do fluxo. Os ids são ESTÁVEIS entre modos — só o rótulo de `sujeitos`
 * muda — para a aba ativa nunca sumir ao trocar de modo.
 */
type Tab = 'cenarios' | 'sujeitos' | 'juizes' | 'avancado';

/** Pendência de validação, já com a aba que a resolve. */
interface Problem {
  tab: Tab;
  text: string;
}

// Linha do editor de configs do compare-llms. A identidade do concorrente é a
// TRIPLA modelo+temperatura+reasoning. temperature como texto: '' = padrão.
interface ConfigRow {
  modelId: string;
  temperature: string;
  reasoningLevel: '' | ReasoningLevel;
}

function fmtUsd(x: number): string {
  if (!x) return '$0.0000';
  // Decimal sempre (nada de "$4.00e-4" no rodapé de custo estimado).
  if (x < 0.0001) return '<$0.0001';
  return `$${x.toFixed(4)}`;
}

/* --------------------------------------------------------- campos compactos */

/** Campo numérico com valor TEXTO (vazio = default/sem limite). */
function TxtNumField(p: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-muted-foreground">{p.label}</span>
      <Input
        type="number"
        className="w-24"
        min={p.min}
        max={p.max}
        step={p.step}
        placeholder={p.placeholder}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
      />
    </label>
  );
}

// Esforço de UM modelo: as opções vêm da allowlist DELE (`supported_efforts` do
// catálogo). Sem o modelo escolhido ainda, cai na lista completa.
function EffortField(p: {
  label: string;
  value: '' | ReasoningLevel;
  onChange: (v: '' | ReasoningLevel) => void;
  model?: OpenRouterModel;
}) {
  const opcoes = effortOptions(modelCaps(p.model));
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-muted-foreground">{p.label}</span>
      <select
        className="h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        value={p.value}
        onChange={(e) => p.onChange(e.target.value as '' | ReasoningLevel)}
      >
        {opcoes.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Chip(p: { on: boolean; label: string; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={p.on}
      title={p.title}
      onClick={p.onClick}
      className={cn(
        'rounded-full border px-2.5 py-1 text-[12.5px] font-medium transition-colors',
        p.on
          ? 'border-primary bg-primary/12 text-foreground'
          : 'border-border bg-muted text-muted-foreground hover:text-foreground',
      )}
    >
      {p.label}
    </button>
  );
}

/** Linha numérica (valor NUMBER). Sem clamp na digitação — o clamp é no envio. */
function NumRow(p: {
  label: string;
  sub?: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <SettingRow label={p.label} sub={p.sub}>
      <Input
        type="number"
        className="w-24"
        aria-label={p.label}
        min={p.min}
        max={p.max}
        step={p.step ?? 1}
        value={p.value}
        onChange={(e) => {
          const v = e.target.valueAsNumber;
          if (!Number.isNaN(v)) p.onChange(v);
        }}
      />
    </SettingRow>
  );
}

/** Linha numérica com valor TEXTO (vazio = default/sem limite). */
function TxtNumRow(p: {
  label: string;
  sub?: string;
  value: string;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}) {
  return (
    <SettingRow label={p.label} sub={p.sub}>
      <Input
        type="number"
        className="w-24"
        aria-label={p.label}
        min={p.min}
        max={p.max}
        step={p.step}
        placeholder={p.placeholder}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
      />
    </SettingRow>
  );
}

/** Linha booleana. O rótulo visível é o da linha, daí o aria-label no switch. */
function SwitchRow(p: { label: string; sub: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <SettingRow label={p.label} sub={p.sub}>
      <Switch aria-label={p.label} checked={p.checked} onCheckedChange={(v) => p.onChange(!!v)} />
    </SettingRow>
  );
}

/** Linha de texto longo: a caixa ocupa a largura toda, sob o rótulo. */
function AreaRow(p: {
  label: string;
  sub?: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  children?: ReactNode;
}) {
  return (
    <SettingRow label={p.label} sub={p.sub} wide>
      <Textarea
        rows={p.rows ?? 3}
        aria-label={p.label}
        value={p.value}
        placeholder={p.placeholder}
        onChange={(e) => p.onChange(e.target.value)}
      />
      {p.children}
    </SettingRow>
  );
}

/** Botão de texto discreto ("gerar com IA", "escrever manualmente"). */
function LinkButton(p: { onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={p.disabled}
      onClick={p.onClick}
      className="self-start text-[13px] text-primary underline-offset-4 hover:underline disabled:opacity-50"
    >
      {p.children}
    </button>
  );
}

/* ------------------------------------------------------------------ página */

export function NewRun() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<RunMode>('compare');
  const [tab, setTab] = useState<Tab>('cenarios');
  const [theme, setTheme] = useState(DEFAULT_THEME);
  const [scenarioBrief, setScenarioBrief] = useState('');
  const [briefOpen, setBriefOpen] = useState(false);
  const [stages, setStages] = useState(5);
  const [concurrency, setConcurrency] = useState(8);
  const [timeoutMs, setTimeoutMs] = useState(60000);
  // Máx. tokens por resposta: campo LIVRE (texto). ''/inválido cai no default
  // no envio (ver maxTokensNum) — o teto real é o do modelo.
  const [maxOutputTokens, setMaxOutputTokens] = useState(String(DEFAULT_MAX_OUTPUT_TOKENS));
  const [datagen, setDatagen] = useState<string[]>([DEFAULT_DATAGEN]);
  const [judge, setJudge] = useState<string[]>([DEFAULT_JUDGE]);

  // compare
  const [competitors, setCompetitors] = useState<string[]>(DEFAULT_COMPETITORS);
  const [compareAxis, setCompareAxis] = useState<'models' | 'configs'>('models');
  const [competitorConfigs, setCompetitorConfigs] = useState<ConfigRow[]>([
    { modelId: '', temperature: '', reasoningLevel: '' },
    { modelId: '', temperature: '', reasoningLevel: '' },
  ]);

  // variation / training
  const [contestantModel, setContestantModel] = useState<string[]>([DEFAULT_CONTESTANT]);
  const [basePrompt, setBasePrompt] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [genOpen, setGenOpen] = useState(false);
  const [genBaseLoading, setGenBaseLoading] = useState(false);
  const [genBaseError, setGenBaseError] = useState<string | null>(null);
  const [optimize, setOptimize] = useState(true);
  const [techniques, setTechniques] = useState<string[]>(DEFAULT_TECHNIQUES);
  const [techs, setTechs] = useState<Technique[]>([]);
  const [manualVariants, setManualVariants] = useState<ManualVariant[]>([
    { label: 'Variante 1', systemPrompt: '' },
    { label: 'Variante 2', systemPrompt: '' },
  ]);
  const [iterations, setIterations] = useState(3);
  const [twoPassJudge, setTwoPassJudge] = useState(false);

  // Cenários prontos: pacote importado (seed do datagen) OU etapas cruas (array
  // JSON), que substituem o gerador por completo.
  const [pack, setPack] = useState<ScenarioPack | null>(null);
  // Contratos never-break (F2/P0.3): chegam pelo arena-config importado
  // (`prompt.contracts`) — sem controle de UI, vão direto no RunConfig.
  const [promptContracts, setPromptContracts] = useState<PromptContracts | undefined>(undefined);
  const [customStages, setCustomStages] = useState<StageSpec[] | null>(null);
  // Import: resumo da arena-config aplicada + flag do prompt que já veio pronto.
  const [configSummary, setConfigSummary] = useState<string | null>(null);
  const [promptImported, setPromptImported] = useState(false);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  // Julgamento por referência (gabarito). null = default do modo/eixo; só um
  // arquivo importado (judging.reference) muda isso explicitamente.
  const [refJudgingChoice, setRefJudgingChoice] = useState<boolean | null>(null);
  const [finalists, setFinalists] = useState(DEFAULT_FINALISTS);
  const [duelsOn, setDuelsOn] = useState(true);
  // IMPL-002: '' = margem AUTOMÁTICA (max(1; 50/n), resolvida no gate); número = fixa.
  const [minGain, setMinGain] = useState('');
  const [holdoutRatio, setHoldoutRatio] = useState(0.2);
  const [feedbackDriven, setFeedbackDriven] = useState(true);

  // Ajuste fino POR MODELO (esforço/temperatura): o esforço mora no modelo, não
  // num campo global — cada modelo aceita o que o `supported_parameters` diz.
  const [tuning, setTuning] = useState<Record<string, ModelTuning>>({});
  // `referenceModel` escreve os gabaritos (vazio = 1º juiz); `rewriterModel`
  // reescreve os prompts por técnica (vazio = mesmo do gerador) → optimizerModelId.
  const [referenceModel, setReferenceModel] = useState<string[]>([]);
  const [rewriterModel, setRewriterModel] = useState<string[]>([]);

  // Conformidade LGPD (consultivo): filtra o catálogo dos participantes.
  const [complianceArea, setComplianceArea] = useState<string>(AREA_LIVRE);
  const [includeRessalvas, setIncludeRessalvas] = useState(true);
  const [lgpd, setLgpd] = useState<LgpdData | null>(null);
  const [prunedNotice, setPrunedNotice] = useState<string | null>(null);

  // Filtro de preço dos PARTICIPANTES (USD por 1M tokens; '' = sem limite).
  // Teto de gasto (US$) da run/sessão. '' = sem limite.
  const [budget, setBudget] = useState('');
  // Config aguardando o "sim" do diálogo de custo (+ a estimativa mostrada).
  const [pendingLaunch, setPendingLaunch] = useState<{ config: RunConfig; estimate: LaunchCostEstimate } | null>(
    null,
  );
  const [maxInputPrice, setMaxInputPrice] = useState('');
  const [maxOutputPrice, setMaxOutputPrice] = useState('');
  // Preço VARIÁVEL (roteadores, "-1") fica fora do teto por default; só entra por
  // decisão explícita do usuário (IMPL-043 / R-11b:REC-7).
  const [includeUnknownPrice, setIncludeUnknownPrice] = useState(false);

  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Só depois de o usuário TENTAR iniciar a pendência vira erro (vermelho) —
  // validação prematura em vermelho é anti-padrão.
  const [tried, setTried] = useState(false);

  const isSingle = mode === 'variation' || mode === 'training';
  const isLivre = complianceArea === AREA_LIVRE;
  // Default do julgamento por referência muda com o modo/eixo — sem pisar em
  // escolha vinda de arquivo (refJudgingChoice !== null).
  const referenceJudging = refJudgingChoice ?? (mode !== 'compare' || compareAxis === 'configs');

  useEffect(() => {
    let active = true;
    fetchModels()
      .then((data) => active && setModels(data))
      .catch(() => undefined)
      .finally(() => active && setModelsLoading(false));
    fetchLgpd().then((d) => active && setLgpd(d)).catch(() => undefined);
    fetchTechniques().then((t) => active && setTechs(t)).catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // Handoff da biblioteca de prompts (/prompts → Nova Run): lê UMA vez no
  // mount, preenche o prompt base e REMOVE a chave p/ não reaplicar depois.
  useEffect(() => {
    const raw = localStorage.getItem('arena:prompt-draft');
    if (!raw) return;
    localStorage.removeItem('arena:prompt-draft');
    try {
      const data = JSON.parse(raw) as { text?: unknown; name?: unknown };
      if (typeof data.text === 'string' && data.text.trim()) {
        setBasePrompt(data.text);
        const name = typeof data.name === 'string' && data.name.trim() ? data.name : 'sem nome';
        setDraftNotice(`Prompt '${name}' carregado da biblioteca.`);
      }
    } catch {
      // JSON inválido: ignora (a chave já foi removida acima).
    }
  }, []);

  // Catálogo filtrado pela área/LGPD. Em 'livre' devolve o catálogo inteiro.
  const filteredModels = useMemo(() => {
    if (!lgpd || isLivre) return models;
    return filterModels(models, complianceArea, includeRessalvas, lgpd).allowed;
  }, [models, lgpd, complianceArea, includeRessalvas, isLivre]);

  // Catálogo dos PARTICIPANTES: LGPD + filtro de preço. Gerador e juiz NÃO
  // usam este — eles veem o catálogo completo (`models`). Preço desconhecido
  // (roteador, "-1") NÃO passa num teto por default: não dá para garantir que
  // fique abaixo dele (antes o -1 passava em qualquer filtro) — só com a escolha
  // explícita `includeUnknownPrice`. Regra e contagem em src/engine/pricing.ts.
  const priceFilter = useMemo(
    () =>
      filterByMaxPrice(filteredModels, {
        maxPromptPerMTok: parseFloat(maxInputPrice),
        maxCompletionPerMTok: parseFloat(maxOutputPrice),
        includeUnknown: includeUnknownPrice,
      }),
    [filteredModels, maxInputPrice, maxOutputPrice, includeUnknownPrice],
  );
  const participantModels = priceFilter.models;
  const priceFilterCount = describeMaxPriceFilter(priceFilter);

  // Espelho das seleções p/ a poda ler o estado mais recente sem re-rodar a cada
  // clique de seleção (só quando área/rigor/preço mudam).
  const selRef = useRef({ competitors, contestantModel, competitorConfigs });
  selRef.current = { competitors, contestantModel, competitorConfigs };

  // Ao mudar os filtros, remove dos PARTICIPANTES os modelos que saíram do
  // catálogo permitido e avisa. Gerador e juiz não são afetados.
  useEffect(() => {
    const priceActive = priceFilter.active;
    const lgpdActive = !!lgpd && complianceArea !== AREA_LIVRE;
    if ((!priceActive && !lgpdActive) || models.length === 0) {
      setPrunedNotice(null);
      return;
    }
    const allowed = new Set(participantModels.map((m) => m.id));
    const removed = new Set<string>();
    const keep = (ids: string[]) =>
      ids.filter((id) => {
        if (allowed.has(id)) return true;
        removed.add(id);
        return false;
      });
    const { competitors: c, contestantModel: cm, competitorConfigs: cf } = selRef.current;
    const nc = keep(c);
    const ncm = keep(cm);
    // Eixo configs: limpa só o modelo da linha (não remove a linha) p/ não
    // perder temperatura/reasoning já escolhidos.
    const ncf = cf.map((r) => {
      if (!r.modelId || allowed.has(r.modelId)) return r;
      removed.add(r.modelId);
      return { ...r, modelId: '' };
    });
    if (nc.length !== c.length) setCompetitors(nc);
    if (ncm.length !== cm.length) setContestantModel(ncm);
    if (ncf.some((r, i) => r !== cf[i])) setCompetitorConfigs(ncf);
    setPrunedNotice(removed.size ? `Removidos pelo filtro: ${[...removed].join(', ')}.` : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participantModels]);

  // nº de variantes (modos de 1 LLM) ou de competidores (compare).
  const variantCount = useMemo(() => {
    if (!isSingle) {
      return compareAxis === 'configs' ? competitorConfigs.filter((r) => r.modelId).length : competitors.length;
    }
    const base = basePrompt.trim() ? 1 : 0;
    if (optimize) return techniques.length + base;
    return manualVariants.filter((v) => v.systemPrompt.trim()).length + base;
  }, [isSingle, compareAxis, competitorConfigs, competitors, basePrompt, optimize, techniques, manualVariants]);

  // Máx. tokens efetivo: parse do campo livre; vazio/inválido cai no default.
  const maxTokensNum = useMemo(() => {
    const v = parseFloat(maxOutputTokens);
    return Number.isFinite(v) && v >= 50 ? Math.round(v) : DEFAULT_MAX_OUTPUT_TOKENS;
  }, [maxOutputTokens]);

  // Teto de gasto efetivo: vazio/inválido = sem limite (a validação avisa).
  const budgetNum = useMemo(() => {
    const v = parseFloat(budget);
    return budget.trim() !== '' && Number.isFinite(v) && v > 0 ? v : undefined;
  }, [budget]);

  // Cenários já prontos: etapas cruas mandam; senão o pacote entra como seed.
  const rawStages = customStages?.length ? customStages : null;
  const seedCount = !rawStages && pack ? pack.scenarios.length : 0;
  const importedList: StageSpec[] = rawStages ?? pack?.scenarios ?? [];
  const importedCount = rawStages ? rawStages.length : seedCount;
  const importedRefs = importedList.filter((s) => s.reference?.trim()).length;
  // O orchestrator só gera o que falta p/ `stages`; garante etapas >= seed.
  const plannedStages = rawStages ? rawStages.length : Math.max(stages, seedCount);
  // Só chama o gerador quando ainda faltam cenários para completar `stages`.
  const precisaGerar = !rawStages && plannedStages > seedCount;

  // Guard-rail anti-viés de painel (consultivo): juiz da MESMA família dos
  // modelos avaliados, ou painel pouco diverso.
  const panelWarnings = useMemo(() => {
    if (judge.length === 0) return [] as string[];
    const familyKey = (id: string) => (lgpd ? familiaFor(id, lgpd)?.id : undefined) ?? creatorPrefix(id);
    const execFams = new Set((mode === 'compare' ? competitors : contestantModel).map(familyKey));
    const warns: string[] = [];
    const shared = judge.filter((j) => execFams.has(familyKey(j)));
    if (shared.length) warns.push(`Juiz da mesma família do avaliado (${shared.join(', ')}) — risco de auto-preferência.`);
    if (new Set(judge.map(familyKey)).size < 2)
      warns.push('Painel de uma família só — juízes de provedores distintos reduzem viés correlacionado.');
    return warns;
  }, [judge, competitors, contestantModel, mode, lgpd]);

  // Compare-llms: tripla repetida = concorrentes indistinguíveis.
  const dupConfigWarning = useMemo(() => {
    if (compareAxis !== 'configs') return null;
    const counts = new Map<string, number>();
    for (const r of competitorConfigs) {
      if (!r.modelId) continue;
      const key = `${r.modelId}|${r.temperature.trim() || '0'}|${r.reasoningLevel || 'padrao'}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.values()].some((c) => c > 1)
      ? 'Configs repetidas (mesmo modelo + temperatura + reasoning) — ajuste para diferenciar.'
      : null;
  }, [compareAxis, competitorConfigs]);

  function updateConfigRow(i: number, patch: Partial<ConfigRow>) {
    setCompetitorConfigs((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function patchTuning(modelId: string, patch: Partial<ModelTuning>) {
    setTuning((prev) => ({ ...prev, [modelId]: { ...prev[modelId], ...patch } }));
  }

  /** Esforço ajustado no modelo ('' / ausente = padrão do provedor, não envia). */
  function effortOf(modelId?: string): ReasoningLevel | undefined {
    const level = modelId ? tuning[modelId]?.effort : undefined;
    return level ? level : undefined;
  }

  /** Temperatura ajustada no modelo (texto → número, com clamp). */
  function tempOf(modelId?: string): number | undefined {
    const t = parseFloat((modelId ? tuning[modelId]?.temperature : undefined) ?? '');
    return Number.isFinite(t) ? Math.max(0, Math.min(2, t)) : undefined;
  }

  // Aplica uma configuração importada (arena-config@1) no estado da tela.
  // Campos AUSENTES no arquivo não pisam o estado atual.
  function applyArenaConfig(config: ArenaConfigFile) {
    setMode(config.mode);
    setTheme(config.theme);
    if (config.scenarioBrief !== undefined) setScenarioBrief(config.scenarioBrief);
    if (config.stages !== undefined) setStages(Math.max(1, Math.min(50, Math.round(config.stages))));
    // Cenários pinados: viram seed no MESMO estado do pacote de cenários.
    // `scenarios.from: 'library'` NÃO é resolvível na SPA (sem filesystem) — a
    // resolução vive no CLI (`pb library`); o resumo já anuncia a biblioteca.
    if (Array.isArray(config.scenarios)) {
      const tokensFallback = config.limits?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
      setCustomStages(null);
      setPack({
        format: 'prompt-builder-pack@1',
        theme: config.theme,
        exportedAt: new Date().toISOString(),
        prompt: { text: config.prompt?.text ?? '', source: 'base' },
        scenarios: config.scenarios.map((sc, i) => ({
          id: sc.id ?? `import-${i + 1}`,
          question: sc.question,
          productContext: sc.productContext ?? '',
          maxTokens: sc.maxTokens ?? tokensFallback,
          rubric: sc.rubric ?? '',
          reference: sc.reference,
          expected: sc.expected,
          origin: 'import' as const,
        })),
      });
    }
    if (config.prompt?.contracts !== undefined) setPromptContracts(config.prompt.contracts);
    if (config.prompt?.text !== undefined) {
      setBasePrompt(config.prompt.text);
      setPromptImported(!!config.prompt.text.trim());
    }
    if (config.prompt?.generateFrom !== undefined) setTaskDescription(config.prompt.generateFrom);
    setDatagen([config.models.datagen]);
    setJudge(config.models.judges);
    if (config.models.reference !== undefined) setReferenceModel(config.models.reference ? [config.models.reference] : []);
    if (config.models.contestant !== undefined) setContestantModel(config.models.contestant ? [config.models.contestant] : []);
    if (config.models.competitors) {
      setCompetitors(config.models.competitors);
      setCompareAxis('models');
    }
    if (config.models.competitorConfigs) {
      // Eixo compare-llms: a identidade é a tripla modelo+temperatura+reasoning.
      setCompetitorConfigs(
        config.models.competitorConfigs.map((c) => ({
          modelId: c.model,
          temperature: c.temperature !== undefined ? String(c.temperature) : '',
          reasoningLevel: c.reasoning ?? '',
        })),
      );
      setCompareAxis('configs');
    }
    if (config.models.rewriter !== undefined) setRewriterModel(config.models.rewriter ? [config.models.rewriter] : []);
    // O esforço do arquivo é por PAPEL; na tela ele mora no modelo daquele papel
    // — traduz na entrada para o usuário VER no chip o que veio no JSON.
    const tuned: Record<string, ModelTuning> = {};
    const putEffort = (ids: string[], effort?: ReasoningLevel) => {
      if (!effort) return;
      for (const id of ids) if (id) tuned[id] = { ...tuned[id], effort };
    };
    const fileContestant = config.models.contestant !== undefined ? [config.models.contestant] : contestantModel;
    putEffort(
      config.mode === 'compare' ? config.models.competitors ?? competitors : fileContestant,
      config.effort?.competitor,
    );
    putEffort([config.models.datagen], config.effort?.datagen);
    putEffort(config.models.judges, config.effort?.judge);
    putEffort(config.models.rewriter !== undefined ? [config.models.rewriter] : rewriterModel, config.effort?.rewriter);
    // Configs do compare-llms: além das linhas do editor, o ajuste aparece no chip.
    for (const c of config.models.competitorConfigs ?? []) {
      tuned[c.model] = {
        ...tuned[c.model],
        ...(c.reasoning !== undefined ? { effort: c.reasoning } : {}),
        ...(c.temperature !== undefined ? { temperature: String(c.temperature) } : {}),
      };
    }
    if (Object.keys(tuned).length) setTuning((prev) => ({ ...prev, ...tuned }));
    if (config.variation?.optimize !== undefined) setOptimize(config.variation.optimize);
    if (config.variation?.techniques) setTechniques(config.variation.techniques);
    if (config.variation?.manualVariants) setManualVariants(config.variation.manualVariants);
    if (config.training?.iterations !== undefined)
      setIterations(Math.max(2, Math.min(10, Math.round(config.training.iterations))));
    if (config.training?.minGain !== undefined) setMinGain(String(config.training.minGain));
    if (config.training?.holdoutRatio !== undefined)
      setHoldoutRatio(Math.max(0, Math.min(0.5, config.training.holdoutRatio)));
    if (config.training?.feedbackDriven !== undefined) setFeedbackDriven(config.training.feedbackDriven);
    // duels/finalists: a raiz é o lugar canônico; o bloco training é compat.
    const duelsFlag = config.duels ?? config.training?.duels;
    if (duelsFlag !== undefined) setDuelsOn(duelsFlag);
    const finalistsCfg = config.finalists ?? config.training?.finalists;
    if (finalistsCfg !== undefined) setFinalists(Math.max(0, Math.min(12, Math.round(finalistsCfg))));
    if (config.judging?.reference !== undefined) setRefJudgingChoice(config.judging.reference);
    if (config.judging?.passes !== undefined) setTwoPassJudge(config.judging.passes === 2);
    // Clamp na entrada: os inputs têm min/max nativos e um valor fora da faixa
    // faz o browser abortar o submit SEM mensagem — o botão Iniciar morre calado.
    if (config.limits?.maxOutputTokens !== undefined)
      setMaxOutputTokens(String(Math.max(50, Math.round(config.limits.maxOutputTokens))));
    if (config.limits?.timeoutMs !== undefined)
      setTimeoutMs(Math.max(1000, Math.min(300000, Math.round(config.limits.timeoutMs))));
    if (config.limits?.concurrency !== undefined)
      setConcurrency(Math.max(1, Math.min(32, Math.round(config.limits.concurrency))));
    if (config.compliance) {
      setComplianceArea(config.compliance.area);
      setIncludeRessalvas(config.compliance.includeRessalvas);
    }
  }

  // Import unificado: UM arquivo, três formatos possíveis (arena-config@1,
  // prompt-builder-pack@1 (ou o legado ai-benchmark-pack@1) ou array cru — `readImportFile` detecta.
  async function handleImport(file: File) {
    setError(null);
    const res = await readImportFile(file);
    if (!res.ok) return setError(res.error);
    if (res.data.kind === 'config') {
      applyArenaConfig(res.data.config);
      setConfigSummary(arenaConfigSummary(res.data.config));
      return;
    }
    if (res.data.kind === 'pack') {
      setCustomStages(null);
      setPack(res.data.pack);
      setTheme(res.data.pack.theme);
      if (res.data.pack.prompt.text.trim()) {
        setBasePrompt(res.data.pack.prompt.text);
        setPromptImported(true);
      }
      return;
    }
    setPack(null);
    setCustomStages(res.data.stages);
  }

  async function gerarPromptBase() {
    setGenBaseLoading(true);
    setGenBaseError(null);
    try {
      setBasePrompt(
        await generateBasePrompt(taskDescription.trim(), datagen[0] ?? DEFAULT_DATAGEN, theme.trim() || undefined),
      );
    } catch (err) {
      setGenBaseError((err as Error).message);
    } finally {
      setGenBaseLoading(false);
    }
  }

  // Validação: 1 frase por problema, com a aba que resolve cada uma. O rodapé
  // mostra a primeira e leva até lá.
  function problems(): Problem[] {
    const out: Problem[] = [];
    if (!theme.trim()) out.push({ tab: 'cenarios', text: 'Descreva o tema do benchmark.' });
    // O gerador só é exigido quando ele vai ser chamado: com os cenários já
    // prontos no arquivo, o campo nem aparece — não pode travar o botão.
    if (precisaGerar && datagen.length !== 1)
      out.push({ tab: 'cenarios', text: 'Selecione 1 modelo gerador.' });
    if (judge.length < 1) out.push({ tab: 'juizes', text: 'Selecione ao menos 1 juiz.' });
    if (mode === 'compare') {
      if (compareAxis === 'configs') {
        if (competitorConfigs.filter((r) => r.modelId).length < 2)
          out.push({ tab: 'avancado', text: 'Preencha o modelo em pelo menos 2 configs (Avançado).' });
      } else if (competitors.length < 2) {
        out.push({ tab: 'sujeitos', text: 'Selecione pelo menos 2 modelos competidores.' });
      }
    } else {
      if (contestantModel.length !== 1)
        out.push({ tab: 'sujeitos', text: 'Selecione 1 modelo sob teste.' });
      if (variantCount < 2)
        out.push({
          tab: 'sujeitos',
          text: optimize
            ? 'Selecione ao menos 2 técnicas (ou 1 técnica + prompt base).'
            : 'Escreva ao menos 2 variantes manuais (ou 1 + prompt base).',
        });
    }
    if (budget.trim() !== '' && !(parseFloat(budget) > 0))
      out.push({ tab: 'avancado', text: 'Orçamento máximo: informe um valor em US$ maior que zero (ou deixe vazio).' });
    return out;
  }

  const pendencias = problems();
  const pendenciaPorAba = useMemo(() => {
    const set = new Set<Tab>();
    for (const p of pendencias) set.add(p.tab);
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendencias.map((p) => p.tab).join('|')]);
  const keyConnected = !!getStoredKey();

  /**
   * Monta o RunConfig a partir do estado da tela. Sem efeitos colaterais: é a
   * MESMA config que o rodapé estima e que o submit envia — a faixa de custo
   * que o usuário confirma é a da run que vai rodar.
   */
  function buildConfig(): RunConfig {
    // Reasoning por papel: sai do ajuste do modelo daquele papel (o esforço mora
    // no modelo). No compare por modelos ele é POR competidor — vai lá embaixo,
    // em competitorConfigs.
    const reasoning: ReasoningConfig = {};
    const competitorEffort = isSingle ? effortOf(contestantModel[0]) : undefined;
    if (competitorEffort) reasoning.competitor = competitorEffort;
    // O engine usa um nível só para juiz e gabarito (`reasoning.judge`); com o
    // juiz no padrão, o ajuste do modelo de gabarito é quem manda.
    const judgeEffort = effortOf(judge[0]) ?? effortOf(referenceModel[0]);
    if (judgeEffort) reasoning.judge = judgeEffort;
    const datagenEffort = effortOf(datagen[0]);
    if (datagenEffort) reasoning.datagen = datagenEffort;
    const rewriterEffort = effortOf(rewriterModel[0]);
    if (rewriterEffort) reasoning.rewriter = rewriterEffort;
    // Temperatura do modelo sob teste: vale para TODAS as variantes (o que se
    // compara são os prompts, não as configs).
    const contestantTemp = isSingle ? tempOf(contestantModel[0]) : undefined;

    const finalistsNum = Math.max(0, Math.min(12, Math.round(finalists)));
    const semFinais = !duelsOn || finalistsNum === 0;

    const common = {
      theme: theme.trim(),
      // Com cenários prontos, `stages` acompanha o que veio no arquivo (senão
      // parte deles ficaria de fora — o engine só completa o que falta).
      stages: plannedStages,
      // Sempre presente (o schema exige), mesmo quando o datagen não vai rodar.
      datagenModelId: datagen[0] ?? DEFAULT_DATAGEN,
      judgeModelIds: judge,
      concurrency: Math.max(1, Math.min(32, Math.round(concurrency))),
      timeoutMs: Math.max(1000, Math.min(300000, Math.round(timeoutMs))),
      maxOutputTokens: maxTokensNum,
      ...(rawStages ? { customStages: rawStages } : {}),
      ...(isLivre ? {} : { compliance: { area: complianceArea, includeRessalvas } }),
      ...(scenarioBrief.trim() ? { scenarioBrief: scenarioBrief.trim() } : {}),
      // Seed do pacote: perde o `id` do arquivo (o engine re-rotula as etapas).
      ...(seedCount > 0 && pack ? { scenarioSeed: pack.scenarios.map(({ id, ...spec }) => spec) } : {}),
      // Explícito: o default muda por modo/eixo, então o valor efetivo vai sempre.
      referenceJudging,
      finalists: finalistsNum,
      ...(semFinais ? { duels: false } : {}),
      // Vale nos TRÊS modos: no compare clássico o julgamento é o listwise, que é
      // justamente quem usa `judgePasses` (antes só ia em variation/training).
      judgePasses: (twoPassJudge ? 2 : 1) as 1 | 2,
      ...(referenceModel[0] ? { referenceModelId: referenceModel[0] } : {}),
      ...(Object.keys(reasoning).length ? { reasoning } : {}),
      // Só nos modos de 1 modelo (no compare a temperatura é por concorrente).
      ...(contestantTemp !== undefined ? { temperature: contestantTemp } : {}),
      // Contratos never-break do prompt base (F2/P0.3).
      ...(promptContracts ? { contracts: promptContracts } : {}),
      // Teto de gasto (IMPL-020): o ledger do motor para a run numa porta de
      // fase antes de passar dele. Em training o teto é da SESSÃO inteira.
      ...(budgetNum !== undefined ? { budgetUsd: budgetNum } : {}),
    };

    let config: RunConfig;
    if (mode === 'compare') {
      if (compareAxis === 'configs') {
        // Eixo configs (compare-llms): NÃO enviar competitorModelIds — a
        // identidade do concorrente é a tripla modelo/temp/reasoning.
        config = {
          mode,
          ...common,
          competitorConfigs: competitorConfigs
            .filter((r) => r.modelId)
            .map((r) => {
              const t = parseFloat(r.temperature);
              return {
                modelId: r.modelId,
                ...(Number.isFinite(t) ? { temperature: Math.max(0, Math.min(2, t)) } : {}),
                ...(r.reasoningLevel ? { reasoningLevel: r.reasoningLevel } : {}),
              };
            }),
        };
      } else if (competitors.some((id) => effortOf(id) || tempOf(id) !== undefined)) {
        // Ajuste por competidor: uma lista de ids não representa mais a run —
        // promove para competitorConfigs, NA ORDEM dos chips.
        config = {
          mode,
          ...common,
          competitorConfigs: competitors.map((id) => {
            const t = tempOf(id);
            const e = effortOf(id);
            return {
              modelId: id,
              ...(t !== undefined ? { temperature: t } : {}),
              ...(e ? { reasoningLevel: e } : {}),
            };
          }),
        };
      } else {
        // Sem ajuste nenhum: ids puros (preserva os rótulos atuais do placar).
        config = { mode, ...common, competitorModelIds: competitors };
      }
    } else {
      config = {
        mode,
        ...common,
        contestantModelId: contestantModel[0],
        basePrompt: basePrompt.trim() || undefined,
        promptOptimization: optimize,
        techniqueIds: optimize ? techniques : undefined,
        manualVariants: optimize ? undefined : manualVariants.filter((v) => v.systemPrompt.trim()),
        ...(optimize && rewriterModel[0] ? { optimizerModelId: rewriterModel[0] } : {}),
        ...(mode === 'training'
          ? {
              iterations: Math.max(2, Math.min(10, Math.round(iterations))),
              // Vazio = sem minGain no config: o gate aplica max(1; 50/n) (IMPL-002).
              ...(minGain.trim() !== '' && Number.isFinite(Number(minGain))
                ? { minGain: Math.max(0, Math.min(100, Number(minGain))) }
                : {}),
              holdoutRatio: Math.max(0, Math.min(0.5, holdoutRatio)),
              feedbackDriven,
            }
          : {}),
      };
    }
    return config;
  }

  /** Inicia de fato. `costConfirmed` = o usuário viu a faixa e disse sim. */
  async function launch(config: RunConfig, costConfirmed: boolean) {
    setSubmitting(true);
    try {
      if (mode === 'training') {
        navigate(`/training/${await createSession(config, { costConfirmed })}`);
      } else {
        navigate(`/runs/${await createRun(config, { costConfirmed })}`);
      }
    } catch (err) {
      setSubmitting(false);
      // O portão do api.ts recusou (estimativa mudou desde a tela): mostra a
      // faixa e pede o "sim" — nunca gasta calado.
      if (isCostConfirmationRequired(err)) {
        setPendingLaunch({ config, estimate: err.estimate });
        return;
      }
      setError((err as Error).message);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const faltas = problems();
    if (faltas.length) {
      setTried(true);
      setTab(faltas[0].tab);
      return setError(faltas[0].text);
    }
    const config = buildConfig();
    // Confirmação de custo (IMPL-020): faixa alta > US$ 1 (ou preço
    // desconhecido) exige um "sim" explícito com a faixa e os drivers à vista.
    const est = estimateConfigCost(config, models);
    if (est.requiresConfirmation) {
      setPendingLaunch({ config, estimate: est });
      return;
    }
    await launch(config, false);
  }

  /** Rótulo da aba, com o ponto de pendência quando ela tem alguma. */
  function TabLabel({ id, children }: { id: Tab; children: ReactNode }) {
    return (
      <span className="flex items-center gap-1.5">
        {children}
        {pendenciaPorAba.has(id) && (
          <span
            className={cn('size-1.5 rounded-full', tried ? 'bg-destructive' : 'bg-muted-foreground/60')}
            aria-label="pendência nesta etapa"
          />
        )}
      </span>
    );
  }

  const primeira = pendencias[0];
  // Estimativa do rodapé: a MESMA conta do diálogo de confirmação e das portas
  // de orçamento do motor (src/estimate.ts), sobre a config que vai ser enviada.
  const launchEstimate = modelsLoading ? null : estimateConfigCost(buildConfig(), models);
  // Preço variável/desconhecido (IMPL-018/043) fica FORA da soma (neutro): o
  // total é declarado parcial por este aviso, nunca "grátis".
  const launchCostNotice = launchEstimate
    ? unestimableCostNotice(launchEstimate.unknownPriceModelIds, launchEstimate.unpricedModelIds)
    : null;

  return (
    <form onSubmit={submit}>
      <Screen>
        <PageHeader
          title="Nova run"
          subtitle={MODE_DESCRIPTIONS[mode]}
          actions={
            <>
              <Button type="button" variant="outline" size="sm" onClick={() => importRef.current?.click()}>
                <Upload aria-hidden="true" />
                Importar JSON
              </Button>
              <input
                ref={importRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleImport(file);
                  e.target.value = '';
                }}
              />
            </>
          }
        />

        <SegmentedToggle
          value={mode}
          onChange={(v) => setMode(v as RunMode)}
          ariaLabel="Modo do benchmark"
          className="w-full"
        >
          {MODES.map((m) => (
            <SegmentedToggleOption key={m.id} value={m.id} className="flex-1 justify-center">
              {m.label}
            </SegmentedToggleOption>
          ))}
        </SegmentedToggle>

        {(configSummary || draftNotice) && (
          <div className="mt-4 flex flex-col gap-2">
            {configSummary && (
              <ImportedLine
                text={`Configuração importada — ${configSummary}`}
                action="dispensar"
                onAction={() => setConfigSummary(null)}
              />
            )}
            {draftNotice && (
              <ImportedLine text={draftNotice} action="dispensar" onAction={() => setDraftNotice(null)} />
            )}
          </div>
        )}

        <SmoothTabs
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          className="mt-6 flex flex-col gap-5"
        >
          {/* `w-fit`: o segmentado de modo é a escolha primária e ocupa a
              largura toda; as abas são o nível abaixo e não podem se parecer
              com ele. */}
          <SmoothTabsList ariaLabel="Etapas da configuração" className="w-fit">
            <SmoothTabsTab value="cenarios">
              <TabLabel id="cenarios">Cenários</TabLabel>
            </SmoothTabsTab>
            <SmoothTabsTab value="sujeitos">
              <TabLabel id="sujeitos">{mode === 'compare' ? 'Modelos' : 'Prompts'}</TabLabel>
            </SmoothTabsTab>
            <SmoothTabsTab value="juizes">
              <TabLabel id="juizes">Juízes</TabLabel>
            </SmoothTabsTab>
            <SmoothTabsTab value="avancado">
              <TabLabel id="avancado">Avançado</TabLabel>
            </SmoothTabsTab>
          </SmoothTabsList>

          <SmoothTabsPanels>
            {/* ----------------------------------------------------- cenários */}
            <SmoothTabsPanel value="cenarios">
              <SettingGroup
                status={
                  importedCount > 0
                    ? `${importedCount} importados${precisaGerar ? ` · +${plannedStages - seedCount} a gerar` : ''}`
                    : `${plannedStages} a gerar`
                }
              >
                {importedCount > 0 ? (
                  <>
                    <SettingRow wide>
                      <ImportedLine
                        text={`${importedCount} cenários importados${importedRefs ? ` (${importedRefs} com gabarito)` : ''}`}
                        action="remover"
                        onAction={() => {
                          setPack(null);
                          setCustomStages(null);
                        }}
                      />
                    </SettingRow>
                    {/* Tema continua sendo enviado e guia o datagen/reescritor. Só some
                        quando veio pronto no arquivo E não faz mais falta — senão um
                        pacote com tema vazio travaria a run sem campo para corrigir. */}
                    {(rawStages || !theme.trim() || precisaGerar) && (
                      <AreaRow label="Tema" value={theme} onChange={setTheme} />
                    )}
                    {!rawStages && (
                      <>
                        {/* Mantido montado mesmo com seedCount >= stages: desmontar o
                            campo enquanto o usuário digita nele é um beco sem saída. */}
                        {precisaGerar && (
                          <SettingRow wide>
                            <ModelSelector
                              multi={false}
                              title="Gerador"
                              value={datagen}
                              onChange={setDatagen}
                              models={models}
                              loading={modelsLoading}
                              tuning={tuning}
                              onTuningChange={patchTuning}
                              tuningFields={TUNE_EFFORT}
                            />
                          </SettingRow>
                        )}
                        <NumRow
                          label="Quantos"
                          value={stages}
                          onChange={setStages}
                          min={1}
                          max={50}
                          sub={
                            precisaGerar
                              ? `Serão gerados mais ${plannedStages - seedCount} para completar ${plannedStages}.`
                              : `Os ${seedCount} cenários do arquivo já cobrem o total — nada a gerar.`
                          }
                        />
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <AreaRow
                      label="Tema"
                      value={theme}
                      onChange={setTheme}
                      placeholder="Ex.: atendimento de clínica de exames — FAQs, preparo e agendamento"
                    />
                    <SettingRow wide>
                      <ModelSelector
                        multi={false}
                        title="Gerador"
                        value={datagen}
                        onChange={setDatagen}
                        models={models}
                        loading={modelsLoading}
                        tuning={tuning}
                        onTuningChange={patchTuning}
                        tuningFields={TUNE_EFFORT}
                      />
                    </SettingRow>
                    <NumRow label="Quantos" value={stages} onChange={setStages} min={1} max={50} />
                    {briefOpen ? (
                      <AreaRow
                        label="O que testar"
                        value={scenarioBrief}
                        onChange={setScenarioBrief}
                        placeholder="Ex.: se respeitam as regras de jejum de cada exame e não inventam orientação médica."
                      />
                    ) : (
                      <SettingRow wide>
                        <LinkButton onClick={() => setBriefOpen(true)}>detalhar o que testar</LinkButton>
                      </SettingRow>
                    )}
                  </>
                )}
              </SettingGroup>
            </SmoothTabsPanel>

            {/* -------------------------------------- modelos (compare) / prompts */}
            <SmoothTabsPanel value="sujeitos">
              {mode === 'compare' ? (
                <SettingGroup
                  status={
                    compareAxis === 'configs'
                      ? `${competitorConfigs.filter((r) => r.modelId).length} configs`
                      : `${competitors.length} competidores`
                  }
                >
                  {compareAxis === 'configs' ? (
                    <SettingRow sub="Comparando configs do mesmo modelo — edite as linhas em Avançado.">
                      <Button type="button" variant="outline" size="sm" onClick={() => setTab('avancado')}>
                        Ir para Avançado
                      </Button>
                    </SettingRow>
                  ) : (
                    <SettingRow wide>
                      <ModelSelector
                        multi
                        title="Competidores"
                        value={competitors}
                        onChange={setCompetitors}
                        excludeIds={[...datagen, ...judge]}
                        models={participantModels}
                        loading={modelsLoading}
                        tuning={tuning}
                        onTuningChange={patchTuning}
                        tuningFields={TUNE_FULL}
                      />
                    </SettingRow>
                  )}
                </SettingGroup>
              ) : (
                <SettingGroup status={`${variantCount} variações`}>
                  <SettingRow wide>
                    <ModelSelector
                      multi={false}
                      title="Modelo sob teste"
                      value={contestantModel}
                      onChange={setContestantModel}
                      excludeIds={[...datagen, ...judge]}
                      models={participantModels}
                      loading={modelsLoading}
                      tuning={tuning}
                      onTuningChange={patchTuning}
                      tuningFields={TUNE_FULL}
                    />
                  </SettingRow>

                  {promptImported ? (
                    <SettingRow wide>
                      <ImportedLine
                        text="Prompt base importado"
                        action="editar"
                        onAction={() => setPromptImported(false)}
                      />
                    </SettingRow>
                  ) : (
                    <>
                      <AreaRow
                        label="Prompt base"
                        value={basePrompt}
                        onChange={setBasePrompt}
                        rows={4}
                        placeholder="System prompt de partida (opcional) — roda como controle."
                      >
                        {!genOpen && <LinkButton onClick={() => setGenOpen(true)}>gerar com IA</LinkButton>}
                      </AreaRow>
                      {genOpen && (
                        <AreaRow
                          label="Descreva a tarefa"
                          value={taskDescription}
                          onChange={setTaskDescription}
                          rows={2}
                          placeholder="O gerador redige um prompt base a partir desta descrição."
                        >
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="self-start"
                            disabled={!taskDescription.trim() || genBaseLoading}
                            onClick={() => void gerarPromptBase()}
                          >
                            {genBaseLoading && <LoaderCircle className="animate-spin" aria-hidden="true" />}
                            {genBaseLoading ? 'Gerando…' : 'Gerar prompt base'}
                          </Button>
                          {genBaseError && <span className="text-[13px] text-destructive">{genBaseError}</span>}
                        </AreaRow>
                      )}
                    </>
                  )}

                  {optimize ? (
                    <SettingRow label="Variações" wide>
                      <div className="flex flex-wrap gap-1.5">
                        <Chip
                          on={techs.length > 0 && techniques.length === techs.length}
                          label="Todas"
                          onClick={() =>
                            setTechniques(techniques.length === techs.length ? [] : techs.map((t) => t.id))
                          }
                        />
                        {techs.map((t) => (
                          <Chip
                            key={t.id}
                            on={techniques.includes(t.id)}
                            label={t.name}
                            title={`Bom: ${t.good} · Cuidado: ${t.bad}`}
                            onClick={() =>
                              setTechniques(
                                techniques.includes(t.id)
                                  ? techniques.filter((x) => x !== t.id)
                                  : [...techniques, t.id],
                              )
                            }
                          />
                        ))}
                      </div>
                      <LinkButton onClick={() => setOptimize(false)}>escrever manualmente</LinkButton>
                    </SettingRow>
                  ) : (
                    <SettingRow wide>
                      <ManualVariantsEditor value={manualVariants} onChange={setManualVariants} />
                      <LinkButton onClick={() => setOptimize(true)}>usar técnicas</LinkButton>
                    </SettingRow>
                  )}

                  {mode === 'training' && (
                    <NumRow label="Rodadas" value={iterations} onChange={setIterations} min={2} max={10} />
                  )}
                </SettingGroup>
              )}
            </SmoothTabsPanel>

            {/* ------------------------------------------------------- juízes */}
            <SmoothTabsPanel value="juizes">
              <SettingGroup
                status={judge.length === 1 ? '1 juiz' : `${judge.length} juízes`}
                footer="Gerador e juízes rodam com temperatura fixa para o resultado ser reproduzível."
              >
                <SettingRow wide>
                  <ModelSelector
                    multi
                    title="Juízes"
                    value={judge}
                    onChange={setJudge}
                    excludeIds={mode === 'compare' ? competitors : contestantModel}
                    models={models}
                    loading={modelsLoading}
                    tuning={tuning}
                    onTuningChange={patchTuning}
                    tuningFields={TUNE_EFFORT}
                  />
                  {panelWarnings.map((w, i) => (
                    <Banner key={i} tone="warn" className="mt-1 w-full">
                      {w}
                    </Banner>
                  ))}
                </SettingRow>
              </SettingGroup>
            </SmoothTabsPanel>

            {/* ----------------------------------------------------- avançado */}
            <SmoothTabsPanel value="avancado">
              <SettingGroup>
                <NumRow
                  label="Finalistas"
                  sub="Quantas variantes disputam o duelo final. As melhores por score entram; 0 desliga a final."
                  value={finalists}
                  onChange={setFinalists}
                  min={0}
                  max={12}
                />
                <TxtNumRow
                  label="Orçamento máx. (US$)"
                  sub={
                    mode === 'training'
                      ? 'Teto de gasto da sessão inteira (todas as rodadas + holdout). A execução para numa fronteira de fase antes de passar dele, com resultado parcial. Vazio = sem limite.'
                      : 'Teto de gasto da run. Ela para numa fronteira de fase antes de passar dele, com resultado parcial — nunca com notas inventadas. Vazio = sem limite.'
                  }
                  value={budget}
                  onChange={setBudget}
                  min={0}
                  step={0.5}
                  placeholder="sem limite"
                />
                <TxtNumRow
                  label="Máx. tokens por resposta"
                  sub="Teto de tamanho de cada resposta. Modelos de raciocínio precisam de folga: deixe alto."
                  value={maxOutputTokens}
                  onChange={setMaxOutputTokens}
                  min={50}
                  placeholder={String(DEFAULT_MAX_OUTPUT_TOKENS)}
                />
                <NumRow
                  label="Timeout (ms)"
                  sub="Quanto esperar por uma resposta antes de desistir dela."
                  value={timeoutMs}
                  onChange={setTimeoutMs}
                  min={1000}
                  max={300000}
                  step={1000}
                />
                <NumRow
                  label="Concorrência"
                  sub="Quantas chamadas seguem em paralelo. Mais é mais rápido e bate no limite do provedor mais cedo."
                  value={concurrency}
                  onChange={setConcurrency}
                  min={1}
                  max={32}
                />

                {/* Vale nos 3 modos: quem consome `judgePasses` é o juiz listwise, que é
                    justamente o default do compare clássico. */}
                <SwitchRow
                  label="Juiz em 2 ordens"
                  sub="Julga cada cenário duas vezes, invertendo a ordem das respostas. Corrige o viés de posição e dobra o custo do juiz."
                  checked={twoPassJudge}
                  onChange={setTwoPassJudge}
                />

                <SettingRow
                  wide
                  sub="Escreve a resposta ideal de cada cenário; o juiz compara as respostas com ela. Vazio = o primeiro juiz."
                >
                  <ModelSelector
                    multi={false}
                    title="Gabarito"
                    value={referenceModel}
                    onChange={setReferenceModel}
                    models={models}
                    loading={modelsLoading}
                    tuning={tuning}
                    onTuningChange={patchTuning}
                    tuningFields={TUNE_EFFORT}
                  />
                </SettingRow>

                {isSingle && optimize && (
                  <SettingRow
                    wide
                    sub="Aplica cada técnica ao seu prompt base para criar as variações. Vazio = o mesmo modelo do gerador."
                  >
                    <ModelSelector
                      multi={false}
                      title="Reescritor"
                      value={rewriterModel}
                      onChange={setRewriterModel}
                      excludeIds={contestantModel}
                      models={models}
                      loading={modelsLoading}
                      tuning={tuning}
                      onTuningChange={patchTuning}
                      tuningFields={TUNE_EFFORT}
                    />
                  </SettingRow>
                )}

                {mode === 'compare' && (
                  <>
                    <SwitchRow
                      label="Mesmo modelo, configs diferentes"
                      sub="Compara um mesmo modelo em temperaturas e esforços diferentes. A identidade de cada concorrente passa a ser modelo + temperatura + esforço."
                      checked={compareAxis === 'configs'}
                      onChange={(v) => setCompareAxis(v ? 'configs' : 'models')}
                    />
                    {compareAxis === 'configs' && (
                      <SettingRow wide>
                        <div className="flex w-full flex-col gap-3">
                          {competitorConfigs.map((row, i) => (
                            <div
                              key={i}
                              className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-3"
                            >
                              <div className="min-w-[14rem] flex-1">
                                <ModelSelector
                                  multi={false}
                                  title={`Config ${i + 1}`}
                                  value={row.modelId ? [row.modelId] : []}
                                  onChange={(ids) => updateConfigRow(i, { modelId: ids[0] ?? '' })}
                                  excludeIds={[...datagen, ...judge]}
                                  models={participantModels}
                                  loading={modelsLoading}
                                />
                              </div>
                              <TxtNumField
                                label="Temp."
                                value={row.temperature}
                                onChange={(v) => updateConfigRow(i, { temperature: v })}
                                min={0}
                                max={2}
                                step={0.1}
                                placeholder="padrão"
                              />
                              <EffortField
                                label="Reasoning"
                                value={row.reasoningLevel}
                                onChange={(v) => updateConfigRow(i, { reasoningLevel: v })}
                                model={models.find((m) => m.id === row.modelId)}
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Remover config ${i + 1}`}
                                disabled={competitorConfigs.length <= 2}
                                onClick={() =>
                                  setCompetitorConfigs((rows) => rows.filter((_, idx) => idx !== i))
                                }
                              >
                                <Trash2 aria-hidden="true" />
                              </Button>
                            </div>
                          ))}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="self-start"
                            disabled={competitorConfigs.length >= 12}
                            onClick={() =>
                              setCompetitorConfigs((rows) => [
                                ...rows,
                                { modelId: '', temperature: '', reasoningLevel: '' },
                              ])
                            }
                          >
                            + config
                          </Button>
                          {dupConfigWarning && <Banner tone="warn">{dupConfigWarning}</Banner>}
                        </div>
                      </SettingRow>
                    )}
                  </>
                )}

                {mode === 'training' && (
                  <>
                    <TxtNumRow
                      label="Margem p/ promover"
                      sub={`Quanto a vencedora precisa superar a campeã atual (em pontos). Vazio = automática, max(1; 50/n): ${Number(defaultMinGain(stages).toFixed(2))} com ${stages} cenários. Além da margem, ela precisa passar no teste da melhor de K (p ajustado ≤ ${GATE_ALPHA}); sem isso, o treino para.`}
                      value={minGain}
                      onChange={setMinGain}
                      min={0}
                      max={100}
                      step={0.5}
                      placeholder="auto"
                    />
                    <NumRow
                      label="Validação (%)"
                      sub="Fatia dos cenários que fica fora do treino. No fim, campeã e base são reavaliadas nela para flagrar overfit."
                      value={Math.round(holdoutRatio * 100)}
                      onChange={(v) => setHoldoutRatio(v / 100)}
                      min={0}
                      max={50}
                      step={5}
                    />
                    <SwitchRow
                      label="Aprender com as falhas da rodada anterior"
                      sub="O reescritor recebe onde a campeã errou na rodada anterior antes de gerar as próximas variações."
                      checked={feedbackDriven}
                      onChange={setFeedbackDriven}
                    />
                  </>
                )}

                <SettingRow
                  label="Conformidade LGPD"
                  sub="Filtra o catálogo de modelos pela área de uso. É consultivo: orienta a escolha, não muda o roteamento no OpenRouter."
                  wide
                >
                  <div className="flex flex-wrap gap-1.5">
                    <Chip on={isLivre} label="Livre" onClick={() => setComplianceArea(AREA_LIVRE)} />
                    {lgpd?.areas.map((a) => (
                      <Chip
                        key={a.id}
                        on={complianceArea === a.id}
                        label={a.label}
                        title={a.descricao}
                        onClick={() => setComplianceArea(a.id)}
                      />
                    ))}
                  </div>
                  {prunedNotice && <Banner tone="warn">{prunedNotice}</Banner>}
                </SettingRow>

                {!isLivre && (
                  <SwitchRow
                    label="Incluir modelos permitidos com ressalvas"
                    sub="Também oferece modelos liberados sob condições (ZDR, DPA, cláusulas contratuais)."
                    checked={includeRessalvas}
                    onChange={setIncludeRessalvas}
                  />
                )}

                <SettingRow
                  label="Preço input/output máx. ($/1M)"
                  sub={
                    <>
                      Esconde dos participantes os modelos acima do preço. Não afeta gerador nem juízes.
                      {priceFilterCount && (
                        // Contagem honesta "X de Y" com o caso do preço variável (IMPL-043).
                        <span className="mt-1 block text-foreground tabular" aria-live="polite">
                          {priceFilterCount}
                        </span>
                      )}
                    </>
                  }
                >
                  <Input
                    type="number"
                    className="w-24"
                    min={0}
                    step={0.1}
                    placeholder="input"
                    aria-label="Preço input máx. ($/1M)"
                    title="Vazio = sem limite."
                    value={maxInputPrice}
                    onChange={(e) => setMaxInputPrice(e.target.value)}
                  />
                  <Input
                    type="number"
                    className="w-24"
                    min={0}
                    step={0.1}
                    placeholder="output"
                    aria-label="Preço output máx. ($/1M)"
                    title="Vazio = sem limite."
                    value={maxOutputPrice}
                    onChange={(e) => setMaxOutputPrice(e.target.value)}
                  />
                </SettingRow>

                {priceFilter.active && (priceFilter.unknownIds.length > 0 || includeUnknownPrice) && (
                  // Decisão EXPLÍCITA: preço variável não passa no teto por default (IMPL-043).
                  <SwitchRow
                    label={`Incluir modelos de preço ${UNKNOWN_PRICE_LABEL}`}
                    sub={`Roteadores (ex.: openrouter/auto) não têm preço fixo: o teto não é garantido e o custo deles fica fora da estimativa. ${priceFilter.unknownIds.length} no catálogo filtrado.`}
                    checked={includeUnknownPrice}
                    onChange={setIncludeUnknownPrice}
                  />
                )}
              </SettingGroup>
            </SmoothTabsPanel>
          </SmoothTabsPanels>
        </SmoothTabs>
      </Screen>

      {/* --------------------------------------------------------------- rodapé */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-[color-mix(in_srgb,var(--background)_88%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3 px-5 py-3 sm:px-6">
          {/* Vermelho só depois de tentar (ou erro real); antes, dica neutra. Com
              `tried` a mensagem acompanha a pendência atual, não a do clique. */}
          <div className="min-w-0 flex-1 text-[13px]">
            {error !== null || (tried && primeira) ? (
              <button
                type="button"
                className="text-left text-destructive underline-offset-4 hover:underline"
                onClick={() => primeira && setTab(primeira.tab)}
              >
                {tried && primeira ? primeira.text : error}
              </button>
            ) : primeira ? (
              <button
                type="button"
                className="text-left text-muted-foreground underline-offset-4 hover:underline"
                onClick={() => setTab(primeira.tab)}
              >
                {primeira.text}
              </button>
            ) : (
              <span className="text-muted-foreground">
                {keyConnected ? (
                  ''
                ) : (
                  <>
                    Conecte sua chave da OpenRouter em{' '}
                    <Link className="text-primary underline-offset-4 hover:underline" to="/settings">
                      Configurações
                    </Link>
                    .
                  </>
                )}
              </span>
            )}
          </div>

          <span
            className="shrink-0 text-right text-[12px] text-muted-foreground tabular"
            title={
              launchEstimate
                ? `Estimativa pelo teto de tokens; inclui gabaritos, finais e o holdout do treino.\n${launchEstimate.drivers
                    .map((d) => `${d.label}: ${d.calls} chamada(s) · até ${fmtUsd(d.usd)}`)
                    .join('\n')}${launchCostNotice ? `\n${launchCostNotice}` : ''}`
                : undefined
            }
          >
            <span className="block text-[10px] tracking-wide uppercase">
              custo estimado{budgetNum !== undefined ? ` · teto ${fmtUsd(budgetNum)}` : ''}
            </span>
            {launchEstimate ? `~${fmtUsd(launchEstimate.low)} – ${fmtUsd(launchEstimate.high)}` : '—'}
            {launchEstimate && launchEstimate.unknownPriceModelIds.length > 0 && ` + ${UNKNOWN_PRICE_LABEL}`}
            {launchCostNotice && (
              // Aviso VISÍVEL (não só no title): o total acima é parcial (IMPL-043).
              <span className="block max-w-[22rem] text-[10px] leading-snug text-foreground" role="note">
                {launchCostNotice}
              </span>
            )}
            {/* CostPreview (F3/§7.4): os 3 drivers que mais pesam, numa linha. */}
            <span className="block text-[10px] text-muted-foreground/80">
              {launchEstimate?.drivers
                .filter((d) => d.usd > 0)
                .slice(0, 3)
                .map((d) => `${d.label} ${fmtUsd(d.usd)}`)
                .join(' · ')}
            </span>
          </span>

          <MultiStateButton
            type="submit"
            state={submitting ? 'submitting' : 'idle'}
            icon={
              submitting ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <ArrowRight className="size-4" aria-hidden="true" />
              )
            }
            disabled={submitting}
            aria-label="Iniciar a run"
            pillClassName="rounded-lg px-4 py-2 text-sm font-medium"
          >
            {submitting ? 'Iniciando…' : 'Iniciar'}
          </MultiStateButton>
        </div>
      </div>

      <CostConfirmDialog
        estimate={pendingLaunch?.estimate ?? null}
        mode={mode}
        onClose={() => setPendingLaunch(null)}
        onConfirm={() => {
          const p = pendingLaunch;
          setPendingLaunch(null);
          if (p) void launch(p.config, true);
        }}
      />
    </form>
  );
}
