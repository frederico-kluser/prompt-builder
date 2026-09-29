import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, Download, LoaderCircle, Trash2, Upload } from 'lucide-react';
import { ModelSelector, type ModelTuning } from '../components/ModelSelector';
import { ManualVariantsEditor } from '../components/ManualVariantsEditor';
import {
  arenaConfigSummary,
  createRun,
  createSession,
  estimateConfigCost,
  isCostConfirmationRequired,
  isKeyMissing,
  fetchLgpd,
  fetchModels,
  fetchTechniques,
  generateBasePrompt,
  getStoredKey,
  readImportFile,
  type ArenaConfigFile,
  type ManualVariant,
  type OpenRouterModel,
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
  parseArenaConfig,
} from '../api';
import {
  ARENA_JSON_ONLY_FIELDS,
  DEFAULT_DATAGEN,
  DEFAULT_DATAGEN_COMPARE,
  DEFAULT_MAX_OUTPUT_TOKENS,
  applyArenaConfigToForm,
  defaultArenaFormState,
  exportArenaConfig,
  formatArenaWarning,
  jsonOnlyActiveValue,
  jsonOnlyRunPatch,
  promptGroupProblem,
  type ArenaFieldWarning,
  type ArenaFormState,
  type ConfigRow,
} from '../arenaForm';
import { CostConfirmDialog } from '../components/CostConfirmDialog';
import { KeySetup } from '../components/KeySetup';
import { AreaRow, LinkButton, NumRow, SwitchRow, TxtNumRow } from '../components/formRows';
import { GuidedSetup, SECTION_STEP, type GuidedStep } from '../components/GuidedSetup';
import {
  clampStages,
  defaultReferenceFor,
  effortOfTuning,
  reasoningFromTuning,
  referenceProblemTexts,
  stagesProblem,
} from '../newRunRules';
import {
  AREA_LIVRE,
  allowlistNotice,
  checkRunCompliance,
  checkImportPii,
  checkRunPii,
  creatorPrefix,
  familiaFor,
  filterModels,
  piiReviewKeys,
  runPiiMessage,
  unreviewedPii,
  type LgpdData,
  type PiiMode,
} from '../lgpd';
import { defaultMinGain, GATE_ALPHA } from '../engine/rank';
import { SegmentedToggle, SegmentedToggleOption } from '@/components/motion-ui/segmented-toggle';
import { MultiStateButton } from '@/components/motion-ui/multi-state-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Banner,
  Chip,
  Disclosure,
  ImportedLine,
  PageHeader,
  RovingItem,
  RovingToolbar,
  Screen,
  SettingGroup,
  SettingRow,
} from '../components/primitives';
import { cn } from '@/lib/utils';

// Defaults da run (ajustáveis na própria tela antes de iniciar): fonte única em
// `../arenaForm` — o mesmo estado-base que o import/export do arena-config usa.
const INIT = defaultArenaFormState();

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
 * As seções da página única (IMPL-106). Os ids são ESTÁVEIS entre modos — só o
 * rótulo de `sujeitos` muda — e servem de âncora para a navegação de
 * pendências do rodapé (rolagem + foco, nunca troca de aba).
 */
type SectionId = 'cenarios' | 'sujeitos' | 'juizes' | 'avancado';

/** Pendência de validação, já com a seção que a resolve. */
interface Problem {
  section: SectionId;
  text: string;
  /**
   * Passo do GUIADO que mostra o campo, quando não é o da seção (ex.: o
   * gabarito mora no Avançado da completa mas em "Participantes" no guiado).
   */
  step?: GuidedStep;
  /**
   * O campo NÃO existe no guiado (técnicas/variantes manuais, eixo de configs,
   * grupo multi-prompt): no guiado a pendência abre a configuração COMPLETA na
   * seção — nunca um passo que não mostra o campo (IMPL-106 d).
   */
  onlyComplete?: boolean;
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


/* ------------------------------------------------------------------ página */

export function NewRun() {
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setModeRaw] = useState<RunMode>(INIT.mode);
  // Modo do formulário (pedido do dono: "configuração totalmente guiada"):
  // 'guided' é o default — uma pergunta por passo; 'complete' é a página única
  // inteira. O ESTADO é o mesmo nos dois; só a superfície muda.
  const [formStyle, setFormStyle] = useState<'guided' | 'complete'>(() => {
    try {
      return localStorage.getItem('pb.formStyle') === 'complete' ? 'complete' : 'guided';
    } catch {
      return 'guided';
    }
  });
  const [guidedStep, setGuidedStep] = useState<GuidedStep>('objetivo');
  // "Avançado" é o 2º nível da revelação progressiva: fechado por default, e
  // aberto sozinho quando a pendência que o usuário tentou resolver mora lá.
  const [avancadoOpen, setAvancadoOpen] = useState(false);
  const [theme, setTheme] = useState(INIT.theme);
  const [scenarioBrief, setScenarioBrief] = useState(INIT.scenarioBrief);
  const [stages, setStages] = useState(INIT.stages);
  const [concurrency, setConcurrency] = useState(INIT.concurrency);
  const [timeoutMs, setTimeoutMs] = useState(INIT.timeoutMs);
  // Máx. tokens por resposta: campo LIVRE (texto). ''/inválido cai no default
  // no envio (ver maxTokensNum) — o teto real é o do modelo.
  const [maxOutputTokens, setMaxOutputTokens] = useState(INIT.maxOutputTokens);
  const [datagen, setDatagen] = useState<string[]>(INIT.datagen);
  const [judge, setJudge] = useState<string[]>(INIT.judge);

  // compare
  const [competitors, setCompetitors] = useState<string[]>(INIT.competitors);
  const [compareAxis, setCompareAxis] = useState<'models' | 'configs'>(INIT.compareAxis);
  const [competitorConfigs, setCompetitorConfigs] = useState<ConfigRow[]>(INIT.competitorConfigs);

  // variation / training
  const [contestantModel, setContestantModel] = useState<string[]>(INIT.contestantModel);
  const [basePrompt, setBasePrompt] = useState(INIT.basePrompt);
  const [taskDescription, setTaskDescription] = useState(INIT.taskDescription);
  const [genBaseLoading, setGenBaseLoading] = useState(false);
  const [genBaseError, setGenBaseError] = useState<string | null>(null);
  const [optimize, setOptimize] = useState(INIT.optimize);
  const [techniques, setTechniques] = useState<string[]>(INIT.techniques);
  const [techs, setTechs] = useState<Technique[]>([]);
  const [manualVariants, setManualVariants] = useState<ManualVariant[]>(INIT.manualVariants);
  const [iterations, setIterations] = useState(INIT.iterations);
  const [twoPassJudge, setTwoPassJudge] = useState(INIT.twoPassJudge);

  // Cenários prontos: pacote importado (seed do datagen) OU etapas cruas (array
  // JSON), que substituem o gerador por completo.
  const [pack, setPack] = useState<ScenarioPack | null>(INIT.pack);
  // Campos SÓ-JSON (IMPL-045): sem controle na tela, chegam pelo arena-config
  // importado e vão para o RunConfig (`jsonOnlyRunPatch`). A lista visível com o
  // valor ativo de cada um fica em Avançado › "Só pelo arquivo JSON".
  const [promptContracts, setPromptContracts] = useState<ArenaFormState['promptContracts']>(INIT.promptContracts);
  const [promptGroup, setPromptGroup] = useState<ArenaFormState['promptGroup']>(INIT.promptGroup);
  const [promptId, setPromptId] = useState<ArenaFormState['promptId']>(INIT.promptId);
  const [repeats, setRepeats] = useState<ArenaFormState['repeats']>(INIT.repeats);
  const [reflection, setReflection] = useState<ArenaFormState['reflection']>(INIT.reflection);
  const [paretoPool, setParetoPool] = useState<ArenaFormState['paretoPool']>(INIT.paretoPool);
  // Aviso NOMEANDO o que o import descartou/ajustou (ou o que o export não
  // representa) — nada some calado.
  const [fieldNotice, setFieldNotice] = useState<{ title: string; items: ArenaFieldWarning[] } | null>(null);
  const [customStages, setCustomStages] = useState<StageSpec[] | null>(INIT.customStages);
  // Import: resumo da arena-config aplicada + flag do prompt que já veio pronto.
  const [configSummary, setConfigSummary] = useState<string | null>(null);
  const [promptImported, setPromptImported] = useState(INIT.promptImported);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  // Julgamento por referência (gabarito). null = default do modo/eixo; só um
  // arquivo importado (judging.reference) muda isso explicitamente.
  const [refJudgingChoice, setRefJudgingChoice] = useState<boolean | null>(INIT.refJudgingChoice);
  const [finalists, setFinalists] = useState(INIT.finalists);
  const [duelsOn, setDuelsOn] = useState(INIT.duelsOn);
  // IMPL-002: '' = margem AUTOMÁTICA (max(1; 50/n), resolvida no gate); número = fixa.
  const [minGain, setMinGain] = useState(INIT.minGain);
  const [holdoutRatio, setHoldoutRatio] = useState(INIT.holdoutRatio);
  const [feedbackDriven, setFeedbackDriven] = useState(INIT.feedbackDriven);

  // Ajuste fino POR MODELO (esforço/temperatura): o esforço mora no modelo, não
  // num campo global — cada modelo aceita o que o `supported_parameters` diz.
  const [tuning, setTuning] = useState<Record<string, ModelTuning>>(INIT.tuning);
  // `referenceModel` escreve os gabaritos (vazio = 1º juiz); `rewriterModel`
  // reescreve os prompts por técnica (vazio = mesmo do gerador) → optimizerModelId.
  const [referenceModel, setReferenceModel] = useState<string[]>(INIT.referenceModel);
  const [rewriterModel, setRewriterModel] = useState<string[]>(INIT.rewriterModel);

  // Conformidade LGPD (consultivo): filtra o catálogo dos participantes.
  const [complianceArea, setComplianceArea] = useState<string>(INIT.complianceArea);
  const [includeRessalvas, setIncludeRessalvas] = useState(INIT.includeRessalvas);
  const [lgpd, setLgpd] = useState<LgpdData | null>(null);
  const [prunedNotice, setPrunedNotice] = useState<string | null>(null);
  // Dado pessoal (IMPL-042): 'synthetic' recusa dado de aparência real antes de
  // começar; nos dois modos o gateway pseudonimiza CPF/telefone/e-mail… no envio.
  const [piiMode, setPiiMode] = useState<PiiMode>(INIT.piiMode);
  // Importação bloqueada por dado pessoal: o arquivo fica pendente até o usuário
  // revisar (nunca corrigimos em silêncio) — ele pode confirmar e importar.
  // `keys` = o dado que o aviso mostrou (hash, nunca o valor): é o que "Revisei" confirma.
  const [piiImport, setPiiImport] = useState<{ file: File; message: string; keys: string[] } | null>(null);
  // Dado de aparência real nos campos no modo "redigir": a run só sai depois da
  // revisão explícita (vira `allowPii: true` no config). A revisão vale para o
  // dado REVISADO (chaves de `piiReviewKeys`), não para o que o usuário puser
  // depois: CPF trocado ou celular novo em qualquer campo pede nova
  // confirmação. Ref = leitura síncrona no submit disparado pelo próprio botão.
  const [piiSubmit, setPiiSubmit] = useState<{ message: string; keys: string[] } | null>(null);
  const piiAck = useRef<Set<string>>(new Set());
  const ackPii = (keys: readonly string[]) => {
    for (const k of keys) piiAck.current.add(k);
  };

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
  // "Key sumida" no meio da configuração (IMPL-082 crit. iv): a key vive só na
  // memória da aba por default e o navegador pode apagar a lembrada. O que
  // gasta recusa com `KeyMissingError` ANTES de qualquer fetch — aqui isso vira
  // RE-PROMPT (o KeySetup no topo, com tudo o que foi preenchido intacto),
  // nunca um erro genérico no rodapé.
  const [needKey, setNeedKey] = useState(false);
  // Só depois de o usuário TENTAR iniciar a pendência vira erro (vermelho) —
  // validação prematura em vermelho é anti-padrão.
  const [tried, setTried] = useState(false);

  // Chegada do first-run (`/welcome`): objetivo escolhido lá vira o modo da
  // run e o fluxo guiado entra já no passo a seguir ao objetivo.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const objetivo = q.get('objetivo');
    if (objetivo === 'compare' || objetivo === 'variation' || objetivo === 'training') {
      setMode(objetivo);
      const passo = q.get('passo');
      setGuidedStep(
        passo === 'objetivo' || passo === 'teste' || passo === 'participantes' || passo === 'limites' || passo === 'revisao'
          ? passo
          : 'teste',
      );
    }
    // Só na entrada (a URL de origem não muda durante a edição).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isSingle = mode === 'variation' || mode === 'training';
  const isLivre = complianceArea === AREA_LIVRE;
  // Default do julgamento por referência muda com o modo/eixo — sem pisar em
  // escolha vinda de arquivo (refJudgingChoice !== null).
  const referenceJudging = refJudgingChoice ?? (mode !== 'compare' || compareAxis === 'configs');

  // IMPL-048: nos modos de prompt o gabarito é OBRIGATÓRIO e distinto dos
  // juízes e do modelo sob teste (o schema do Node e o portão da SPA recusam
  // sem ele). Ao entrar num desses modos sem gabarito, ele ganha um default —
  // o 1º juiz preferido LIVRE, como os demais papéis têm default —, visível no
  // passo "Participantes" do guiado e no Avançado (citado em Juízes) da
  // completa. Ao voltar ao compare, o default INTOCADO sai: lá o gabarito é
  // opcional (vazio = 1º juiz) e o id poderia colidir com um competidor.
  const autoReference = useRef<string | null>(null);
  useEffect(() => {
    if (isSingle) {
      if (referenceModel.length === 0) {
        const id = defaultReferenceFor(judge, contestantModel);
        if (id) {
          autoReference.current = id;
          setReferenceModel([id]);
        }
      }
    } else if (autoReference.current && referenceModel[0] === autoReference.current) {
      autoReference.current = null;
      setReferenceModel([]);
    }
    // Só na troca de modo (inclusive a que vem de um import): depois disso o
    // gabarito é do usuário — até removê-lo (vira pendência, nunca re-default).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSingle]);

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
  // Nº de cenários efetivo (inteiro 1–50): o input aceita qualquer coisa na
  // digitação — o clamp mora AQUI, uma vez, e envio/estimativa/textos leem ele.
  const stagesNum = clampStages(stages);
  // O orchestrator só gera o que falta p/ `stages`; garante etapas >= seed.
  const plannedStages = rawStages ? rawStages.length : Math.max(stagesNum, seedCount);
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
    return effortOfTuning(tuning, modelId);
  }

  /** Temperatura ajustada no modelo (texto → número, com clamp). */
  function tempOf(modelId?: string): number | undefined {
    const t = parseFloat((modelId ? tuning[modelId]?.temperature : undefined) ?? '');
    return Number.isFinite(t) ? Math.max(0, Math.min(2, t)) : undefined;
  }

  /** Recorte do estado que o arena-config descreve (ver `../arenaForm`). */
  function snapshot(): ArenaFormState {
    return {
      mode, theme, scenarioBrief, stages, pack, customStages, basePrompt, taskDescription, promptImported,
      datagen, judge, referenceModel, contestantModel, competitors, compareAxis, competitorConfigs,
      rewriterModel, tuning, optimize, techniques, manualVariants, iterations, minGain, holdoutRatio,
      feedbackDriven, duelsOn, finalists, twoPassJudge, maxOutputTokens, timeoutMs, concurrency,
      complianceArea, includeRessalvas, piiMode, refJudgingChoice, promptContracts, promptGroup, promptId,
      repeats, reflection, paretoPool,
    };
  }

  /** Escreve um estado do assistente de volta na tela (um setter por campo). */
  function applyFormState(f: ArenaFormState) {
    setMode(f.mode);
    setTheme(f.theme);
    setScenarioBrief(f.scenarioBrief);
    setStages(f.stages);
    setPack(f.pack);
    setCustomStages(f.customStages);
    setBasePrompt(f.basePrompt);
    setTaskDescription(f.taskDescription);
    setPromptImported(f.promptImported);
    setDatagen(f.datagen);
    setJudge(f.judge);
    setReferenceModel(f.referenceModel);
    setContestantModel(f.contestantModel);
    setCompetitors(f.competitors);
    setCompareAxis(f.compareAxis);
    setCompetitorConfigs(f.competitorConfigs);
    setRewriterModel(f.rewriterModel);
    setTuning(f.tuning);
    setOptimize(f.optimize);
    setTechniques(f.techniques);
    setManualVariants(f.manualVariants);
    setIterations(f.iterations);
    setMinGain(f.minGain);
    setHoldoutRatio(f.holdoutRatio);
    setFeedbackDriven(f.feedbackDriven);
    setDuelsOn(f.duelsOn);
    setFinalists(f.finalists);
    setTwoPassJudge(f.twoPassJudge);
    setMaxOutputTokens(f.maxOutputTokens);
    setTimeoutMs(f.timeoutMs);
    setConcurrency(f.concurrency);
    setComplianceArea(f.complianceArea);
    setIncludeRessalvas(f.includeRessalvas);
    setPiiMode(f.piiMode);
    setRefJudgingChoice(f.refJudgingChoice);
    setPromptContracts(f.promptContracts);
    setPromptGroup(f.promptGroup);
    setPromptId(f.promptId);
    setRepeats(f.repeats);
    setReflection(f.reflection);
    setParetoPool(f.paretoPool);
  }

  // Aplica uma configuração importada (arena-config@1) no estado da tela. A
  // tradução é pura (`applyArenaConfigToForm`) e devolve um aviso NOMEANDO cada
  // campo que não entra na run — antes, 5 campos validados sumiam calados.
  function applyArenaConfig(config: ArenaConfigFile, raw?: unknown) {
    const { state, warnings } = applyArenaConfigToForm(snapshot(), config, { raw });
    applyFormState(state);
    // LGPD (IMPL-040): a revisão do arquivo vive fora do ArenaFormState — é
    // one-shot, nunca exportada. Importado com "Revisei" (ou `allowPii` no arquivo): a revisão cobre o dado
    // DESTE arquivo — não o que for digitado depois.
    if (config.allowPii) ackPii(piiReviewKeys(checkImportPii(config).blocked));
    setFieldNotice(
      warnings.length ? { title: 'Campos do arquivo que NÃO entram nesta run', items: warnings } : null,
    );
  }

  // Exporta o assistente como arena-config@1 — o mesmo arquivo que o import lê
  // (round-trip coberto por test/arena-form-parity.test.ts).
  function handleExport() {
    setError(null);
    const { config, omitted } = exportArenaConfig(snapshot());
    const json = JSON.stringify(config, null, 2);
    // Só baixa o que o import aceita de volta: arquivo exportado que não reabre
    // seria pior que nenhum.
    const check = parseArenaConfig(JSON.parse(json));
    if (!check.ok) return setError(`Não dá para exportar ainda: ${check.error}`);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `arena-config-${mode}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    // O teto de gasto não faz parte do arena-config (é decisão de quem roda).
    if (budget.trim())
      omitted.push({ path: 'Orçamento máx.', message: 'o arena-config não tem teto de gasto — defina de novo após importar' });
    setFieldNotice(
      omitted.length ? { title: 'Ajustes da tela que o arquivo exportado não carrega', items: omitted } : null,
    );
  }

  // Import unificado: UM arquivo, três formatos possíveis (arena-config@1,
  // prompt-builder-pack@1 (ou o legado ai-benchmark-pack@1) ou array cru — `readImportFile` detecta.
  async function handleImport(file: File, allowPii = false, reviewedKeys: readonly string[] = []) {
    setError(null);
    setFieldNotice(null);
    const res = await readImportFile(file, { allowPii });
    if (!res.ok) {
      if (res.pii) return setPiiImport({ file, message: res.error, keys: piiReviewKeys(res.pii.blocked) });
      return setError(res.error);
    }
    setPiiImport(null);
    if (allowPii) ackPii(reviewedKeys);
    if (res.data.kind === 'config') {
      applyArenaConfig(res.data.config, res.data.raw);
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
        await generateBasePrompt(
          taskDescription.trim(),
          datagen[0] ?? DEFAULT_DATAGEN,
          theme.trim() || undefined,
          // IMPL-040: em área sensível a geração também sai com o roteamento ZDR forçado.
          isLivre ? undefined : { area: complianceArea, includeRessalvas },
        ),
      );
    } catch (err) {
      if (isKeyMissing(err)) {
        setNeedKey(true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else setGenBaseError((err as Error).message);
    } finally {
      setGenBaseLoading(false);
    }
  }

  // Validação: 1 frase por problema, com a SEÇÃO que resolve cada uma. O rodapé
  // mostra a primeira e leva até lá (rolagem + foco — a página é única, nada
  // fica escondido em aba). O campo exigido é sempre um que a tela está
  // mostrando: exigir campo escondido trava o "Iniciar" sem explicação visível.
  function problems(): Problem[] {
    const out: Problem[] = [];
    if (!theme.trim()) out.push({ section: 'cenarios', text: 'Descreva o tema do benchmark.' });
    // O gerador só é exigido quando ele vai ser chamado: com os cenários já
    // prontos no arquivo, o campo nem aparece — não pode travar o botão.
    if (precisaGerar && datagen.length !== 1)
      // No guiado o seletor do gerador mora em "Participantes" (não em "Teste").
      out.push({ section: 'cenarios', step: 'participantes', text: 'Selecione 1 modelo gerador.' });
    if (judge.length < 1) out.push({ section: 'juizes', text: 'Selecione ao menos 1 juiz.' });
    if (mode === 'compare') {
      if (compareAxis === 'configs') {
        if (competitorConfigs.filter((r) => r.modelId).length < 2)
          out.push({ section: 'sujeitos', text: 'Preencha o modelo em pelo menos 2 configs.', onlyComplete: true });
      } else if (competitors.length < 2) {
        out.push({ section: 'sujeitos', text: 'Selecione pelo menos 2 modelos competidores.' });
      }
    } else {
      if (contestantModel.length !== 1)
        out.push({ section: 'sujeitos', text: 'Selecione 1 modelo sob teste.' });
      if (variantCount < 2)
        out.push({
          section: 'sujeitos',
          // Técnicas e variantes manuais só existem na completa.
          onlyComplete: true,
          text: optimize
            ? 'Selecione ao menos 2 técnicas (ou 1 técnica + prompt base).'
            : 'Escreva ao menos 2 variantes manuais (ou 1 + prompt base).',
        });
    }
    // Papéis separados (IMPL-048): a mesma regra do schema/portão da SPA. O
    // gabarito mora no Avançado da completa (o irPara abre) e em
    // "Participantes" no guiado.
    for (const text of referenceProblemTexts({
      mode,
      reference: referenceModel[0],
      judges: judge,
      competitors: compareAxis === 'configs' ? competitorConfigs.map((r) => r.modelId).filter(Boolean) : competitors,
      contestant: contestantModel[0],
    })) {
      out.push({ section: 'avancado', step: 'participantes', text });
    }
    // Cenários: só quando o campo aparece (com etapas cruas, `stages` nem vale).
    const cenarios = rawStages ? null : stagesProblem(stages);
    if (cenarios) out.push({ section: 'avancado', text: cenarios });
    const grupo = promptGroupProblem({ mode, promptGroup, promptId });
    if (grupo) out.push({ section: 'avancado', text: grupo, onlyComplete: true });
    if (budget.trim() !== '' && !(parseFloat(budget) > 0))
      out.push({
        section: 'avancado',
        text: 'Orçamento máximo: informe um valor em US$ maior que zero (ou deixe vazio).',
      });
    return out;
  }

  const pendencias = problems();
  // Ponto de pendência no cabeçalho da seção — vermelho só depois de tentar.
  function pendenciaEm(section: SectionId): 'muted' | 'error' | undefined {
    return pendencias.some((p) => p.section === section) ? (tried ? 'error' : 'muted') : undefined;
  }

  /**
   * Leva ao ponto que resolve uma pendência: no fluxo guiado, ao PASSO certo;
   * no completo, abre o "Avançado" se preciso e rola/foca a âncora. Nunca troca
   * de aba (a página é única).
   */
  function irPara(section: SectionId, step?: GuidedStep, onlyComplete?: boolean) {
    if (formStyle === 'guided' && !onlyComplete) {
      setGuidedStep(step ?? SECTION_STEP[section]);
      return;
    }
    // Campo que o guiado não tem: abre a completa (mesmo estado) na seção.
    if (formStyle === 'guided') setFormStyle('complete');
    if (section === 'avancado') setAvancadoOpen(true);
    // Depois do render (o Avançado precisa abrir antes de existir no layout).
    requestAnimationFrame(() => {
      const el = document.getElementById(`sec-${section}`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.focus({ preventScroll: true });
    });
  }
  const keyConnected = !!getStoredKey();

  /**
   * Troca o modo. Se o gerador de cenários ainda for um DEFAULT intocado, ele
   * segue o default do modo (compare ≠ modos de papel — ver `arenaForm.ts`).
   */
  function setMode(m: RunMode) {
    setModeRaw(m);
    const alvo = m === 'compare' ? DEFAULT_DATAGEN_COMPARE : DEFAULT_DATAGEN;
    setDatagen((atual) =>
      atual.length === 1 && (atual[0] === DEFAULT_DATAGEN || atual[0] === DEFAULT_DATAGEN_COMPARE)
        ? [alvo]
        : atual,
    );
  }

  /** Troca a superfície do formulário e grava a preferência. */
  function mudarFormStyle(s: 'guided' | 'complete') {
    setFormStyle(s);
    try {
      localStorage.setItem('pb.formStyle', s);
    } catch {
      // sem localStorage a preferência dura só esta sessão
    }
  }

  /**
   * Monta o RunConfig a partir do estado da tela. Sem efeitos colaterais: é a
   * MESMA config que o rodapé estima e que o submit envia — a faixa de custo
   * que o usuário confirma é a da run que vai rodar.
   */
  function buildConfig(): RunConfig {
    // Reasoning por papel: sai do ajuste do modelo daquele papel (o esforço mora
    // no modelo). No compare por modelos ele é POR competidor — vai lá embaixo,
    // em competitorConfigs. Gabarito em `gab`, nunca vazando no juiz/duelo.
    const reasoning: ReasoningConfig = reasoningFromTuning({
      tuning,
      isSingle,
      contestant: contestantModel[0],
      judge: judge[0],
      reference: referenceModel[0],
      datagen: datagen[0],
      rewriter: rewriterModel[0],
    });
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
      ...(piiMode === 'synthetic' ? { piiMode } : {}),
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
      // Campos só-JSON aplicados (IMPL-045): contratos never-break, grupo
      // multi-prompt, repeats (compare), reflexão/pool Pareto (training).
      ...jsonOnlyRunPatch({ mode, promptContracts, promptGroup, promptId, repeats, reflection, paretoPool }),
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
        // promove para competitorConfigs, NA ORDEM dos chips. Continua sendo
        // uma lista de MODELOS: `competitorAnchor: false` impede o 1º de virar
        // "base/controlo" (regra do eixo compare-llms — web-code#16).
        config = {
          mode,
          ...common,
          competitorAnchor: false,
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
      if (isKeyMissing(err)) {
        setNeedKey(true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
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
      irPara(faltas[0].section, faltas[0].step, faltas[0].onlyComplete);
      return setError(faltas[0].text);
    }
    let config = buildConfig();

    // LGPD (IMPL-041): área sensível é fail-closed para TODO papel que vê o
    // dado (gerador, juiz e gabarito inclusive, que não passam pelo filtro dos
    // participantes). Avisa aqui em vez de a run nascer e morrer no pré-voo.
    if (lgpd) {
      const lgpdCheck = checkRunCompliance(config, lgpd);
      if (lgpdCheck.violations.length) {
        return setError(
          `LGPD (${complianceArea}): ${lgpdCheck.violations.map((v) => v.message).join('; ')}.`,
        );
      }
    }

    // IMPL-042: "só sintético" recusa dado pessoal de aparência real — avisa
    // aqui, nomeando o campo, em vez de a run nascer e morrer no pré-voo.
    if (piiMode === 'synthetic') {
      const piiCheck = checkRunPii(config);
      if (piiCheck.blocked.length) return setError(runPiiMessage(piiCheck));
    } else {
      // Modo "redigir": nada sai com dado de aparência real sem revisão —
      // pseudonimizar sem avisar seria correção silenciosa (e nome não é redigido).
      const piiCheck = checkRunPii(config);
      const pendentes = unreviewedPii(piiCheck.blocked, piiAck.current);
      if (pendentes.length) {
        setPiiSubmit({
          message: runPiiMessage({ ...piiCheck, blocked: pendentes }),
          keys: piiReviewKeys(pendentes),
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return setError('Dado pessoal com aparência de dado real — revise o aviso no topo da página.');
      }
      if (piiCheck.blocked.length) config = { ...config, allowPii: true };
    }
    setPiiSubmit(null);

    // Confirmação de custo (IMPL-020): faixa alta > US$ 1 (ou preço
    // desconhecido) exige um "sim" explícito com a faixa e os drivers à vista.
    const est = estimateConfigCost(config, models);
    if (est.requiresConfirmation) {
      setPendingLaunch({ config, estimate: est });
      return;
    }
    await launch(config, false);
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
  // Valores ativos da lista "Só pelo arquivo JSON" (Avançado).
  const formSnap = snapshot();

  return (
    <form onSubmit={submit}>
      {/* `pb-44` em telas com barra inferior (IMPL-110): o último campo não pode
          ficar nem sob o rodapé fixo nem sob a barra de navegação. */}
      <Screen className="pb-44 md:pb-32">
        <PageHeader
          title="Nova run"
          subtitle={MODE_DESCRIPTIONS[mode]}
          actions={
            <>
              {/* Ações da configuração: UMA parada de Tab (roving) — ações irmãs
                  não podem virar paradas novas antes do "Iniciar" (o orçamento
                  IMPL-106 (c) é contrato). Aqui entram o arquivo da configuração
                  e a SUPERFÍCIE do formulário (guiado/completo), que sem isto
                  estourava o orçamento no modo variation. */}
              <RovingToolbar label="Ações da configuração" count={4} className="flex items-center gap-2">
                <RovingItem index={0}>
                  {(roving) => (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      {...roving}
                      onClick={() => importRef.current?.click()}
                    >
                      <Upload aria-hidden="true" />
                      Importar JSON
                    </Button>
                  )}
                </RovingItem>
                <RovingItem index={1}>
                  {(roving) => (
                    <Button type="button" variant="outline" size="sm" {...roving} onClick={handleExport}>
                      <Download aria-hidden="true" />
                      Exportar JSON
                    </Button>
                  )}
                </RovingItem>
                <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
                {/* Superfície do formulário: guiado (default) ou completo — o
                    MESMO estado nos dois; trocar não perde o que foi preenchido. */}
                <RovingItem index={2}>
                  {(roving) => (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      {...roving}
                      aria-pressed={formStyle === 'guided'}
                      className={formStyle === 'guided' ? 'bg-muted text-foreground' : 'text-muted-foreground'}
                      onClick={() => mudarFormStyle('guided')}
                    >
                      Guiado
                    </Button>
                  )}
                </RovingItem>
                <RovingItem index={3}>
                  {(roving) => (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      {...roving}
                      aria-pressed={formStyle === 'complete'}
                      className={formStyle === 'complete' ? 'bg-muted text-foreground' : 'text-muted-foreground'}
                      onClick={() => mudarFormStyle('complete')}
                    >
                      Completo
                    </Button>
                  )}
                </RovingItem>
              </RovingToolbar>
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

        {formStyle === 'complete' && (
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
        )}

        {needKey && (
          <div className="mt-4 flex flex-col gap-3">
            <Banner tone="warn">
              A chave da OpenRouter não está mais nesta aba (recarregou sem «Lembrar neste dispositivo», ou o
              navegador apagou os dados do site). Conecte-a de novo — o que você preencheu continua aqui.
            </Banner>
            <KeySetup onSaved={() => setNeedKey(false)} />
          </div>
        )}

        {piiImport && (
          <Banner tone="warn" className="mt-4 flex flex-col gap-3">
            <p>{piiImport.message}</p>
            <p className="text-muted-foreground">
              {piiMode === 'synthetic'
                ? 'No modo "só sintético" não há exceção: corrija o arquivo ou troque para o modo "redigir" em Avançado.'
                : 'Se você revisou e são dados sintéticos, pode importar mesmo assim: CPF, telefone, e-mail e demais identificadores continuam pseudonimizados antes de cada envio ao modelo. Nomes em texto livre não são cobertos.'}
            </p>
            <div className="flex flex-wrap gap-2">
              {piiMode !== 'synthetic' && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void handleImport(piiImport.file, true, piiImport.keys)}
                >
                  Revisei — importar mesmo assim
                </Button>
              )}
              <Button type="button" size="sm" variant="ghost" onClick={() => setPiiImport(null)}>
                Dispensar
              </Button>
            </div>
          </Banner>
        )}

        {piiSubmit && (
          <Banner tone="warn" className="mt-4 flex flex-col gap-3">
            <p>{piiSubmit.message}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                size="sm"
                variant="outline"
                onClick={() => ackPii(piiSubmit.keys)}
              >
                Revisei — iniciar mesmo assim
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPiiSubmit(null)}>
                Voltar e corrigir
              </Button>
            </div>
          </Banner>
        )}

        {(configSummary || draftNotice || fieldNotice) && (
          <div className="mt-4 flex flex-col gap-2">
            {fieldNotice && (
              <Banner tone="warn">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium">{fieldNotice.title}</p>
                  <button
                    type="button"
                    className="shrink-0 text-[13px] text-primary underline-offset-4 hover:underline"
                    onClick={() => setFieldNotice(null)}
                  >
                    dispensar
                  </button>
                </div>
                <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5 text-[13px]">
                  {fieldNotice.items.map((w) => (
                    <li key={`${w.path}|${w.message}`}>
                      <code className="font-mono text-[12px]">{w.path}</code>
                      {': '}
                      {w.message}
                    </li>
                  ))}
                </ul>
              </Banner>
            )}
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

        {/* Página ÚNICA (IMPL-106): 3 seções de conteúdo sempre à vista + o
            "Avançado" recolhível (2º nível da revelação progressiva). Sem abas:
            conteúdo obrigatório nunca fica escondido em aba não-default.
            O GUIADO mostra as mesmas perguntas, uma por passo. */}
        {formStyle === 'guided' ? (
          <GuidedSetup
            step={guidedStep}
            onStepChange={setGuidedStep}
            mode={mode}
            setMode={setMode}
            theme={theme}
            setTheme={setTheme}
            basePrompt={basePrompt}
            setBasePrompt={setBasePrompt}
            stages={stages}
            plannedStages={plannedStages}
            setStages={setStages}
            budget={budget}
            setBudget={setBudget}
            competitors={competitors}
            setCompetitors={setCompetitors}
            contestantModel={contestantModel}
            setContestantModel={setContestantModel}
            datagen={datagen}
            setDatagen={setDatagen}
            judge={judge}
            setJudge={setJudge}
            referenceModel={referenceModel}
            setReferenceModel={setReferenceModel}
            duelsOn={duelsOn}
            setDuelsOn={setDuelsOn}
            finalists={finalists}
            setFinalists={setFinalists}
            models={models}
            modelsLoading={modelsLoading}
            tuning={tuning}
            onTuningChange={patchTuning}
            problems={pendencias}
            estimate={launchEstimate ? { low: launchEstimate.low, high: launchEstimate.high } : null}
            onOpenClassic={() => setFormStyle('complete')}
            tried={tried}
          />
        ) : (
        <div className="mt-6 flex flex-col gap-5">
          {/* --------------------------------------------------------- cenários */}
          <SettingGroup
            id="sec-cenarios"
            title="Cenários"
            pending={pendenciaEm('cenarios')}
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
                  </>
                )}
          </SettingGroup>

          {/* -------------------------------------- modelos (compare) / prompts */}
          <SettingGroup
            id="sec-sujeitos"
            title={mode === 'compare' ? 'Modelos' : 'Prompts'}
            pending={pendenciaEm('sujeitos')}
            status={
              mode === 'compare'
                ? compareAxis === 'configs'
                  ? `${competitorConfigs.filter((r) => r.modelId).length} configs`
                  : `${competitors.length} competidores`
                : `${variantCount} variações`
            }
          >
              {mode === 'compare' ? (
                <>
                  <SwitchRow
                    label="Mesmo modelo, configs diferentes"
                    sub="Compara um mesmo modelo em temperaturas e esforços diferentes. A identidade de cada concorrente passa a ser modelo + temperatura + esforço."
                    checked={compareAxis === 'configs'}
                    onChange={(v) => setCompareAxis(v ? 'configs' : 'models')}
                  />
                  {compareAxis === 'configs' ? (
                    /* As configs são OBRIGATÓRIAS para a run neste eixo: ficam
                       aqui, sempre à vista — nunca dentro do "Avançado" fechado
                       (IMPL-106, critério d). */
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
                                excludeIds={[...datagen, ...judge, ...referenceModel]}
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
                  ) : (
                    <SettingRow wide>
                      <ModelSelector
                        multi
                        title="Competidores"
                        value={competitors}
                        onChange={setCompetitors}
                        excludeIds={[...datagen, ...judge, ...referenceModel]}
                        models={participantModels}
                        loading={modelsLoading}
                        tuning={tuning}
                        onTuningChange={patchTuning}
                        tuningFields={TUNE_FULL}
                      />
                    </SettingRow>
                  )}
                </>
              ) : (
                <>
                  <SettingRow wide>
                    <ModelSelector
                      multi={false}
                      title="Modelo sob teste"
                      value={contestantModel}
                      onChange={setContestantModel}
                      excludeIds={[...datagen, ...judge, ...referenceModel]}
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
                    <AreaRow
                      label="Prompt base"
                      value={basePrompt}
                      onChange={setBasePrompt}
                      rows={4}
                      placeholder="System prompt de partida (opcional) — roda como controle."
                    />
                  )}

                  {optimize ? (
                    <SettingRow label="Variações" wide>
                      {/* Chips + o alternador "escrever manualmente": UMA parada de
                          Tab (roving) — 10 técnicas não podem virar 10 paradas antes
                          do "Iniciar" (R-11b:REC-1). */}
                      <RovingToolbar
                        label="Variações de prompt"
                        count={techs.length + 2}
                        className="flex flex-wrap items-center gap-1.5"
                      >
                        <Chip
                          index={0}
                          on={techs.length > 0 && techniques.length === techs.length}
                          label="Todas"
                          onClick={() =>
                            setTechniques(techniques.length === techs.length ? [] : techs.map((t) => t.id))
                          }
                        />
                        {techs.map((t, i) => (
                          <Chip
                            key={t.id}
                            index={i + 1}
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
                        <RovingItem index={techs.length + 1}>
                          {(roving) => (
                            <button
                              type="button"
                              {...roving}
                              onClick={() => setOptimize(false)}
                              className="text-[13px] text-primary underline-offset-4 hover:underline"
                            >
                              escrever manualmente
                            </button>
                          )}
                        </RovingItem>
                      </RovingToolbar>
                    </SettingRow>
                  ) : (
                    <SettingRow wide>
                      <ManualVariantsEditor value={manualVariants} onChange={setManualVariants} />
                      <LinkButton onClick={() => setOptimize(true)}>usar técnicas</LinkButton>
                    </SettingRow>
                  )}
                </>
              )}
          </SettingGroup>

          {/* ------------------------------------------------------- juízes */}
          <SettingGroup
            id="sec-juizes"
            title="Juízes"
            pending={pendenciaEm('juizes')}
            status={judge.length === 1 ? '1 juiz' : `${judge.length} juízes`}
            footer={
              <>
                {isSingle && (
                  // O gabarito é obrigatório aqui (IMPL-048) mas mora no Avançado
                  // (orçamento de Tab do IMPL-106): fica CITADO à vista, sem
                  // virar parada de Tab — trocá-lo é no Avançado.
                  <span className="mb-1 block">
                    Gabarito: <span className="font-mono text-[12px] text-foreground">{referenceModel[0] ?? '—'}</span>{' '}
                    — escreve a resposta ideal de cada cenário e não pode ser juiz nem o modelo sob teste. Troque
                    em Avançado.
                  </span>
                )}
                Gerador e juízes rodam com temperatura fixa para o resultado ser reproduzível.
              </>
            }
          >
                <SettingRow wide>
                  <ModelSelector
                    multi
                    title="Juízes"
                    value={judge}
                    onChange={setJudge}
                    excludeIds={[...(mode === 'compare' ? competitors : contestantModel), ...referenceModel]}
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

          {/* ----------------------------------------------------- avançado */}
          {/* 2º nível da revelação progressiva: recolhido por default, abre
              sozinho quando a pendência escolhida mora aqui. */}
          <Disclosure
            id="sec-avancado"
            title="Avançado"
            pending={pendenciaEm('avancado')}
            open={avancadoOpen}
            onToggle={() => setAvancadoOpen((v) => !v)}
            footer="O que 9 em 10 runs não mexem. Os campos que decidem o resultado da run ficam nas seções acima."
          >
            {/* Volume de cenários + geração do prompt base: opcionais, mas com
                valor sempre à vista quando o Avançado abre. */}
            <SettingGroup title="Cenários e prompts">
              {!rawStages && (
                <NumRow
                  label="Quantos"
                  value={stages}
                  onChange={setStages}
                  min={1}
                  max={50}
                  sub={
                    importedCount > 0
                      ? precisaGerar
                        ? `Serão gerados mais ${plannedStages - seedCount} para completar ${plannedStages}.`
                        : `Os ${seedCount} cenários do arquivo já cobrem o total — nada a gerar.`
                      : 'Quantos cenários o gerador cria para a run.'
                  }
                />
              )}
              {importedCount === 0 && (
                <AreaRow
                  label="O que testar"
                  value={scenarioBrief}
                  onChange={setScenarioBrief}
                  placeholder="Ex.: se respeitam as regras de jejum de cada exame e não inventam orientação médica."
                />
              )}
              {isSingle && !promptImported && (
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
            </SettingGroup>

            <SettingGroup title="Execução">
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
                  sub={
                    isSingle
                      ? 'Escreve a resposta ideal de cada cenário; o juiz compara as respostas com ela. Obrigatório em teste e treino — e diferente dos juízes e do modelo sob teste (quem escreve a régua não julga nem compete contra ela).'
                      : 'Escreve a resposta ideal de cada cenário; o juiz compara as respostas com ela. Vazio = o primeiro juiz. Não pode ser juiz nem competidor.'
                  }
                >
                  <ModelSelector
                    multi={false}
                    title="Gabarito"
                    value={referenceModel}
                    onChange={setReferenceModel}
                    excludeIds={[
                      ...judge,
                      ...(mode === 'compare'
                        ? compareAxis === 'configs'
                          ? competitorConfigs.map((r) => r.modelId).filter(Boolean)
                          : competitors
                        : contestantModel),
                    ]}
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

                {/* O eixo compare-llms e o editor de configs mudaram para a
                    seção "Modelos" (IMPL-106): as configs são obrigatórias no
                    eixo e não podem ficar sob um Avançado fechado. */}

                {mode === 'training' && (
                  <>
                    <NumRow
                      label="Rodadas"
                      sub="Quantas rodadas de evolução o treino roda (2–10)."
                      value={iterations}
                      onChange={setIterations}
                      min={2}
                      max={10}
                    />
                    <TxtNumRow
                      label="Margem p/ promover"
                      sub={`Quanto a vencedora precisa superar a campeã atual (em pontos). Vazio = automática, max(1; 50/n): ${Number(defaultMinGain(plannedStages).toFixed(2))} com ${plannedStages} cenários. Além da margem, ela precisa passar no teste da melhor de K (p ajustado ≤ ${GATE_ALPHA}); sem isso, o treino para.`}
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
                  sub="Filtra o catálogo pela área de uso. Geral é consultiva; nas áreas sensíveis só passam modelos com endpoint ZDR na allowlist (vale também para gerador, juiz e gabarito) e o desconhecido é bloqueado."
                  wide
                >
                  {/* Áreas de conformidade: UMA parada de Tab (roving). */}
                  <RovingToolbar
                    label="Áreas de conformidade"
                    count={1 + (lgpd?.areas.length ?? 0)}
                    className="flex flex-wrap gap-1.5"
                  >
                    <Chip index={0} on={isLivre} label="Livre" onClick={() => setComplianceArea(AREA_LIVRE)} />
                    {lgpd?.areas.map((a, i) => (
                      <Chip
                        key={a.id}
                        index={i + 1}
                        on={complianceArea === a.id}
                        label={a.label}
                        title={a.descricao}
                        onClick={() => setComplianceArea(a.id)}
                      />
                    ))}
                  </RovingToolbar>
                  {prunedNotice && <Banner tone="warn">{prunedNotice}</Banner>}
                  {(() => {
                    const aviso = allowlistNotice(lgpd, complianceArea);
                    return aviso ? <Banner tone={aviso.tone}>{aviso.text}</Banner> : null;
                  })()}
                </SettingRow>

                {!isLivre && (
                  <SwitchRow
                    label="Incluir modelos permitidos com ressalvas"
                    sub="Também oferece modelos liberados sob condições (ZDR, DPA, cláusulas contratuais)."
                    checked={includeRessalvas}
                    onChange={setIncludeRessalvas}
                  />
                )}

                <SwitchRow
                  label="Só dados sintéticos"
                  sub="Recusa a run se algum campo tiver dado pessoal com aparência real (CPF, CNS, RG, celular, e-mail pessoal, nome junto de documento ou endereço). Nos dois modos, identificadores são pseudonimizados antes de cada envio; nomes em texto livre não são cobertos pelo detector."
                  checked={piiMode === 'synthetic'}
                  onChange={(v) => setPiiMode(v ? 'synthetic' : 'redact')}
                />

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

              {/* Paridade formulário × arena-config (IMPL-045): o que o schema
                  aceita e a tela não tem controle. `aplicado` vai para a run
                  (com o valor ativo à vista); `ignorado` é aceito e avisado. */}
              <SettingGroup
                title="Só pelo arquivo JSON"
                footer="Estes campos não têm controle na tela: entram pelo Importar JSON e saem no Exportar JSON. Cada import substitui os valores ativos."
              >
                <ul className="flex flex-col divide-y divide-border">
                  {ARENA_JSON_ONLY_FIELDS.map((f) => {
                    const ativo = jsonOnlyActiveValue(formSnap, f.path);
                    return (
                      <li key={f.path} className="flex flex-col gap-0.5 px-4 py-2 text-[13px]">
                        <span className="flex flex-wrap items-center gap-2">
                          <code className="font-mono text-[12px] text-foreground">{f.path}</code>
                          <span
                            className={cn(
                              'rounded px-1.5 text-[11px]',
                              f.status === 'aplicado'
                                ? 'bg-muted text-muted-foreground'
                                : 'bg-parcial-soft text-foreground',
                            )}
                          >
                            {f.status}
                          </span>
                          {ativo !== undefined && (
                            <span className="text-[12px] text-primary">ativo: {JSON.stringify(ativo)}</span>
                          )}
                        </span>
                        <span className="text-muted-foreground">{f.note}</span>
                      </li>
                    );
                  })}
                </ul>
              </SettingGroup>
          </Disclosure>
        </div>
        )}
      </Screen>

      {/* --------------------------------------------------------------- rodapé */}
      {/* Fixo acima da barra inferior de navegação em telas pequenas (IMPL-110);
          `fixed` só funciona sem `transform` nos ancestrais — o wrapper de
          transição de rota é só opacity por isso. */}
      <div className="fixed inset-x-0 z-30 border-t border-border bg-[color-mix(in_srgb,var(--background)_88%,transparent)] backdrop-blur-md bottom-[calc(3.5rem+env(safe-area-inset-bottom))] md:bottom-0">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3 px-5 py-3 sm:px-6">
          {/* Vermelho só depois de tentar (ou erro real); antes, dica neutra. Com
              `tried` a mensagem acompanha a pendência atual, não a do clique. */}
          <div className="min-w-0 flex-1 text-[13px]">
            {error !== null || (tried && primeira) ? (
              <button
                type="button"
                className="text-left text-destructive underline-offset-4 hover:underline"
                onClick={() => primeira && irPara(primeira.section, primeira.step, primeira.onlyComplete)}
              >
                {tried && primeira ? primeira.text : error}
              </button>
            ) : primeira ? (
              <button
                type="button"
                className="text-left text-muted-foreground underline-offset-4 hover:underline"
                onClick={() => irPara(primeira.section, primeira.step, primeira.onlyComplete)}
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
