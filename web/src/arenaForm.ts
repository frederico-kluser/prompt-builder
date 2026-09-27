// Paridade arena-config@1 × formulário Nova Run (IMPL-045, R-11b:REC-4).
//
// Antes, `applyArenaConfig` (NewRun.tsx) validava o arquivo inteiro mas só
// restaurava parte dele: `repeats`, `training.reflection/paretoPool/halving` e
// `prompt.group/promptId` passavam pela validação e SUMIAM sem aviso — a run
// rodava com uma config diferente da importada (nota/custo mudavam sem sinal).
//
// Este módulo PURO (sem React) é a fonte única da tradução nos dois sentidos:
//   • `applyArenaConfigToForm` — arquivo → estado do formulário, devolvendo um
//     aviso NOMEANDO cada campo que não entra na run (não aplicável ao modo,
//     ignorado na SPA, descontinuado, desconhecido, ajustado ou em conflito);
//   • `exportArenaConfig` — estado → arquivo (botão "Exportar JSON");
//   • `ARENA_FIELD_HANDLING` — TODO campo do schema é `ui` (tem controle) ou
//     `json-only` (lista visível "só pelo arquivo"). `test/arena-form-parity`
//     deriva a lista de campos do próprio zod e falha se algum ficar de fora.

import {
  ARENA_CONFIG_FORMAT,
  arenaConfigSchema,
  type ArenaConfigFile,
  type ArenaConfigScenario,
} from './engine/configFile';
import { AREA_LIVRE, type PiiMode } from './lgpd';
import type {
  ManualVariant,
  PromptContracts,
  ReasoningLevel,
  RunConfig,
  RunMode,
  ScenarioPack,
  StageSpec,
} from './api';
import { validatePromptGroup, type PromptGroup } from '../../src/engine/promptGroup.js';
import type { ModelTuning } from './components/ModelSelector';

// Defaults da Nova Run — fonte única (o NewRun inicializa o estado daqui).
export const DEFAULT_COMPETITORS = ['openai/gpt-5-mini', 'openai/gpt-5-nano', 'openai/gpt-5.4-mini', 'openai/gpt-5.4-nano'];
export const DEFAULT_CONTESTANT = 'openai/gpt-5-mini';
export const DEFAULT_DATAGEN = 'deepseek/deepseek-v4-pro';
export const DEFAULT_JUDGE = 'moonshotai/kimi-k2.6';
export const DEFAULT_TECHNIQUES = ['persona', 'cot', 'constraints', 'format'];
export const DEFAULT_THEME =
  'Assistente virtual de uma clínica de diagnósticos que orienta os pacientes no preparo para exames médicos e ' +
  'laboratoriais: tempo de jejum, suspensão de medicamentos, ingestão de água, restrições alimentares, preparo ' +
  'intestinal, documentos necessários, horários de coleta e reagendamento. As respostas devem ser claras, objetivas ' +
  'e seguras, orientando a confirmar com a clínica ou com o médico quando a dúvida envolver decisão clínica.';
export const DEFAULT_MAX_OUTPUT_TOKENS = 500;
/** Nº de finalistas que disputam os duelos no fim (0 = sem finais). */
export const DEFAULT_FINALISTS = 3;

/** Faixas dos inputs da tela (min/max nativos): fora delas o submit morre calado. */
const LIMITS_RANGE = {
  maxOutputTokens: { min: 50, max: Infinity },
  timeoutMs: { min: 1000, max: 300000 },
  concurrency: { min: 1, max: 32 },
} as const;

// Linha do editor de configs do compare-llms. A identidade do concorrente é a
// TRIPLA modelo+temperatura+reasoning. temperature como texto: '' = padrão.
export interface ConfigRow {
  modelId: string;
  temperature: string;
  reasoningLevel: '' | ReasoningLevel;
}

/** Recorte do estado da Nova Run que o arena-config descreve (sem React). */
export interface ArenaFormState {
  mode: RunMode;
  theme: string;
  scenarioBrief: string;
  stages: number;
  pack: ScenarioPack | null;
  customStages: StageSpec[] | null;
  basePrompt: string;
  taskDescription: string;
  promptImported: boolean;
  datagen: string[];
  judge: string[];
  referenceModel: string[];
  contestantModel: string[];
  competitors: string[];
  compareAxis: 'models' | 'configs';
  competitorConfigs: ConfigRow[];
  rewriterModel: string[];
  tuning: Record<string, ModelTuning>;
  optimize: boolean;
  techniques: string[];
  manualVariants: ManualVariant[];
  iterations: number;
  /** IMPL-002: '' = margem AUTOMÁTICA (max(1; 50/n), resolvida no gate); número = fixa. */
  minGain: string;
  holdoutRatio: number;
  feedbackDriven: boolean;
  duelsOn: boolean;
  finalists: number;
  twoPassJudge: boolean;
  maxOutputTokens: string;
  timeoutMs: number;
  concurrency: number;
  complianceArea: string;
  includeRessalvas: boolean;
  /** LGPD (IMPL-040): 'redact' (default) pseudonimiza; 'synthetic' recusa PII. */
  piiMode: PiiMode;
  // --- só pelo arquivo (sem controle na tela; ver ARENA_FIELD_HANDLING) ---
  /** judging.reference — null = default do modo/eixo. */
  refJudgingChoice: boolean | null;
  promptContracts?: PromptContracts;
  promptGroup?: PromptGroup;
  promptId?: string;
  repeats?: 1 | 2 | 3;
  reflection?: 'off' | 'deterministic' | 'llm';
  paretoPool?: number;
}

export function defaultArenaFormState(): ArenaFormState {
  return {
    mode: 'compare',
    theme: DEFAULT_THEME,
    scenarioBrief: '',
    stages: 5,
    pack: null,
    customStages: null,
    basePrompt: '',
    taskDescription: '',
    promptImported: false,
    datagen: [DEFAULT_DATAGEN],
    judge: [DEFAULT_JUDGE],
    referenceModel: [],
    contestantModel: [DEFAULT_CONTESTANT],
    competitors: [...DEFAULT_COMPETITORS],
    compareAxis: 'models',
    competitorConfigs: [
      { modelId: '', temperature: '', reasoningLevel: '' },
      { modelId: '', temperature: '', reasoningLevel: '' },
    ],
    rewriterModel: [],
    tuning: {},
    optimize: true,
    techniques: [...DEFAULT_TECHNIQUES],
    manualVariants: [
      { label: 'Variante 1', systemPrompt: '' },
      { label: 'Variante 2', systemPrompt: '' },
    ],
    iterations: 3,
    minGain: '',
    holdoutRatio: 0.2,
    feedbackDriven: true,
    duelsOn: true,
    finalists: DEFAULT_FINALISTS,
    twoPassJudge: false,
    maxOutputTokens: String(DEFAULT_MAX_OUTPUT_TOKENS),
    timeoutMs: 60000,
    concurrency: 8,
    complianceArea: AREA_LIVRE,
    includeRessalvas: true,
    piiMode: 'redact',
    refJudgingChoice: null,
  };
}

// ----------------------------------------------------------------------------
// Tabela de paridade: TODO campo-folha do schema tem uma entrada aqui.
// ----------------------------------------------------------------------------

const LIBRARY_NOTE = 'biblioteca de cenários só no CLI (`pb library`): a SPA não tem filesystem para resolvê-la';
const SINGLE: RunMode[] = ['variation', 'training'];
const COMPARE: RunMode[] = ['compare'];
const TRAINING: RunMode[] = ['training'];

export type ArenaFieldHandling =
  | {
      kind: 'ui';
      /** Onde o campo aparece na tela. */
      control: string;
      /** Modos em que o campo entra na run (ausente = todos). */
      modes?: RunMode[];
      /** Sinônimo legado de outro campo (o export escreve o canônico). */
      aliasOf?: string;
      /**
       * Só entra na run com `variation.optimize` igual a este valor (o
       * buildConfig manda técnicas/reescritor OU variantes manuais, nunca os dois).
       */
      whenOptimize?: boolean;
    }
  | {
      kind: 'json-only';
      /** `aplicado` = vai para a run; `ignorado` = aceito pelo schema, fora da run (com aviso). */
      status: 'aplicado' | 'ignorado';
      note: string;
      modes?: RunMode[];
      aliasOf?: string;
      /** Idem ao `whenOptimize` do ramo `ui`. */
      whenOptimize?: boolean;
      /** Descontinuado: pode sumir do schema sem derrubar a guarda de itens órfãos. */
      discontinued?: boolean;
      /**
       * Consumido no import e NUNCA exportado (ex.: `allowPii` — a revisão vale
       * só para o dado DAQUELE arquivo). Fora do round-trip de propósito.
       */
      oneShot?: boolean;
    };

export const ARENA_FIELD_HANDLING: Record<string, ArenaFieldHandling> = {
  format: { kind: 'json-only', status: 'aplicado', note: "discriminador de versão do arquivo (sempre 'arena-config@1')" },
  mode: { kind: 'ui', control: 'seletor de modo (topo)' },
  theme: { kind: 'ui', control: 'Cenários › Tema' },
  scenarioBrief: { kind: 'ui', control: 'Cenários › Briefing' },
  stages: { kind: 'ui', control: 'Cenários › Nº de cenários' },
  'scenarios[].id': { kind: 'ui', control: 'Cenários › lista importada' },
  'scenarios[].question': { kind: 'ui', control: 'Cenários › lista importada' },
  'scenarios[].productContext': { kind: 'ui', control: 'Cenários › lista importada' },
  'scenarios[].maxTokens': { kind: 'ui', control: 'Cenários › lista importada' },
  'scenarios[].rubric': { kind: 'ui', control: 'Cenários › lista importada' },
  'scenarios[].reference': { kind: 'ui', control: 'Cenários › lista importada' },
  'scenarios[].expected': { kind: 'ui', control: 'Cenários › lista importada' },
  'scenarios[].labelSet': { kind: 'ui', control: 'Cenários › lista importada' },
  // Biblioteca de cenários: a resolução exige filesystem (CLI `pb library`).
  'scenarios.from': { kind: 'json-only', status: 'ignorado', note: LIBRARY_NOTE },
  'scenarios.profile': { kind: 'json-only', status: 'ignorado', note: LIBRARY_NOTE },
  'scenarios.ids': { kind: 'json-only', status: 'ignorado', note: LIBRARY_NOTE },
  'prompt.text': { kind: 'ui', control: 'Sujeitos › Prompt base', modes: SINGLE },
  'prompt.generateFrom': { kind: 'ui', control: 'Sujeitos › Gerar prompt base', modes: SINGLE },
  'prompt.contracts.neverBreak': { kind: 'json-only', status: 'aplicado', note: 'contratos never-break do prompt base', modes: SINGLE, whenOptimize: true },
  'prompt.contracts.placeholders': { kind: 'json-only', status: 'aplicado', note: 'placeholders que o reescritor preserva', modes: SINGLE, whenOptimize: true },
  'prompt.contracts.minLengthRatio': { kind: 'json-only', status: 'aplicado', note: 'razão mínima de tamanho da reescrita', modes: SINGLE, whenOptimize: true },
  // Camadas 2 e 3 do contrato never-break (IMPL-011).
  'prompt.contracts.judgeDiff': { kind: 'json-only', status: 'aplicado', note: 'juiz LLM do diff base × reescrita (camada 2)', modes: SINGLE, whenOptimize: true },
  ...Object.fromEntries(
    (['id', 'kind', 'input', 'pattern', 'forbid', 'json', 'requiredKeys', 'fill', 'maxTokens'] as const).map((k) => [
      `prompt.contracts.canaries[].${k}`,
      { kind: 'json-only', status: 'aplicado', note: 'canários comportamentais do contrato (camada 3)', modes: SINGLE, whenOptimize: true } as const,
    ]),
  ),
  'prompt.group[].id': { kind: 'json-only', status: 'aplicado', note: 'multi-prompt: grupo de fragmentos (irmãos congelados)', modes: SINGLE },
  'prompt.group[].label': { kind: 'json-only', status: 'aplicado', note: 'multi-prompt: rótulo do fragmento', modes: SINGLE },
  'prompt.group[].text': { kind: 'json-only', status: 'aplicado', note: 'multi-prompt: texto do fragmento', modes: SINGLE },
  'prompt.promptId': { kind: 'json-only', status: 'aplicado', note: 'multi-prompt: fragmento que esta run evolui', modes: SINGLE },
  'models.datagen': { kind: 'ui', control: 'Cenários › Gerador' },
  'models.judges': { kind: 'ui', control: 'Juízes' },
  'models.reference': { kind: 'ui', control: 'Avançado › Gabarito' },
  'models.contestant': { kind: 'ui', control: 'Sujeitos › Modelo sob teste', modes: SINGLE },
  'models.competitors': { kind: 'ui', control: 'Sujeitos › Competidores', modes: COMPARE },
  'models.competitorConfigs[].model': { kind: 'ui', control: 'Avançado › Configs', modes: COMPARE },
  'models.competitorConfigs[].temperature': { kind: 'ui', control: 'Avançado › Configs', modes: COMPARE },
  'models.competitorConfigs[].reasoning': { kind: 'ui', control: 'Avançado › Configs', modes: COMPARE },
  'models.rewriter': { kind: 'ui', control: 'Avançado › Reescritor', modes: SINGLE, whenOptimize: true },
  'effort.competitor': { kind: 'ui', control: 'ajuste (chip) do modelo sob teste/competidores' },
  'effort.judge': { kind: 'ui', control: 'ajuste (chip) do juiz' },
  'effort.rewriter': { kind: 'ui', control: 'ajuste (chip) do reescritor', modes: SINGLE, whenOptimize: true },
  'effort.datagen': { kind: 'ui', control: 'ajuste (chip) do gerador' },
  'variation.optimize': { kind: 'ui', control: 'Sujeitos › Otimizar com técnicas', modes: SINGLE },
  'variation.techniques': { kind: 'ui', control: 'Sujeitos › Técnicas', modes: SINGLE, whenOptimize: true },
  'variation.manualVariants[].label': { kind: 'ui', control: 'Sujeitos › Variantes manuais', modes: SINGLE, whenOptimize: false },
  'variation.manualVariants[].systemPrompt': { kind: 'ui', control: 'Sujeitos › Variantes manuais', modes: SINGLE, whenOptimize: false },
  'training.iterations': { kind: 'ui', control: 'Sujeitos › Iterações', modes: TRAINING },
  'training.minGain': { kind: 'ui', control: 'Avançado › Ganho mínimo', modes: TRAINING },
  'training.holdoutRatio': { kind: 'ui', control: 'Avançado › Holdout', modes: TRAINING },
  'training.feedbackDriven': { kind: 'ui', control: 'Avançado › Lições das falhas', modes: TRAINING },
  'training.reflection': { kind: 'json-only', status: 'aplicado', note: "reflexão GEPA ('deterministic' | 'llm' | 'off')", modes: TRAINING },
  'training.paretoPool': { kind: 'json-only', status: 'aplicado', note: 'pool Pareto (>1 = população de prompts)', modes: TRAINING },
  // IMPL-012 remove o sequential halving: o campo segue aceito por compat, mas
  // NÃO vai para a run — o import avisa em vez de engolir.
  'training.halving': { kind: 'json-only', status: 'ignorado', note: 'sequential halving descontinuado (IMPL-012)', modes: TRAINING, discontinued: true },
  'training.duels': { kind: 'ui', control: 'Avançado › Finalistas (duelos)', aliasOf: 'duels' },
  'training.finalists': { kind: 'ui', control: 'Avançado › Finalistas', aliasOf: 'finalists' },
  'training.repeats': { kind: 'json-only', status: 'aplicado', note: 'sinônimo legado de `repeats`', modes: COMPARE, aliasOf: 'repeats' },
  duels: { kind: 'ui', control: 'Avançado › Finalistas (0 desliga)' },
  repeats: { kind: 'json-only', status: 'aplicado', note: 'repetições por cenário (1–3): mede instabilidade e multiplica o custo', modes: COMPARE },
  finalists: { kind: 'ui', control: 'Avançado › Finalistas' },
  'judging.reference': { kind: 'json-only', status: 'aplicado', note: 'força ligar/desligar o julgamento por gabarito (sem ele: default do modo)' },
  'judging.passes': { kind: 'ui', control: 'Avançado › Juiz em 2 ordens' },
  'limits.maxOutputTokens': { kind: 'ui', control: 'Avançado › Máx. tokens por resposta' },
  'limits.timeoutMs': { kind: 'ui', control: 'Avançado › Timeout' },
  'limits.concurrency': { kind: 'ui', control: 'Avançado › Concorrência' },
  'compliance.area': { kind: 'ui', control: 'Avançado › Conformidade (área)' },
  'compliance.includeRessalvas': { kind: 'ui', control: 'Avançado › Conformidade (ressalvas)' },
  // LGPD (IMPL-040).
  piiMode: { kind: 'ui', control: 'Avançado › Dados pessoais (só sintético)' },
  allowPii: {
    kind: 'json-only',
    status: 'aplicado',
    note: 'revisão de PII do arquivo (dados sintéticos) — vale só para o dado deste arquivo; não é exportado',
    oneShot: true,
  },
};

/** A lista visível "só pelo arquivo JSON" (Avançado). */
export const ARENA_JSON_ONLY_FIELDS = Object.entries(ARENA_FIELD_HANDLING)
  .filter(([, h]) => h.kind === 'json-only')
  .map(([path, h]) => ({ path, ...(h as Extract<ArenaFieldHandling, { kind: 'json-only' }>) }));

// ----------------------------------------------------------------------------
// Campos-folha do schema (derivados do PRÓPRIO zod)
// ----------------------------------------------------------------------------

interface ZodDefLike {
  type: string;
  shape?: Record<string, unknown>;
  innerType?: unknown;
  element?: unknown;
  options?: unknown[];
  in?: unknown;
}

function defOf(schema: unknown): ZodDefLike {
  return (schema as { _zod: { def: ZodDefLike } })._zod.def;
}

function unwrap(schema: unknown): unknown {
  let s = schema;
  for (;;) {
    const d = defOf(s);
    if (['optional', 'default', 'nullable', 'prefault', 'readonly', 'catch', 'nonoptional'].includes(d.type)) s = d.innerType;
    else if (d.type === 'pipe') s = d.in;
    else return s;
  }
}

/**
 * Caminhos-folha do schema: objetos são percorridos (`a.b`), listas de objetos
 * viram `a[].campo`, uniões com ramo objeto/lista de objetos contribuem com os
 * dois ramos (`scenarios[].question` + `scenarios.from`); o resto é folha.
 */
export function arenaSchemaFieldPaths(schema: unknown = arenaConfigSchema): string[] {
  const out = new Set<string>();
  const walk = (s: unknown, path: string): void => {
    const d = defOf(unwrap(s));
    if (d.type === 'object') {
      for (const [k, v] of Object.entries(d.shape ?? {})) walk(v, path ? `${path}.${k}` : k);
      return;
    }
    if (d.type === 'array' && defOf(unwrap(d.element)).type === 'object') return walk(d.element, `${path}[]`);
    if (d.type === 'union') {
      const estruturados = (d.options ?? []).filter((o) => {
        const od = defOf(unwrap(o));
        return od.type === 'object' || (od.type === 'array' && defOf(unwrap(od.element)).type === 'object');
      });
      if (estruturados.length) {
        for (const o of estruturados) walk(o, path);
        if (estruturados.length < (d.options ?? []).length) out.add(path);
        return;
      }
    }
    out.add(path);
  };
  walk(schema, '');
  return [...out].sort();
}

/** Campos do schema SEM controle na tela e SEM entrada só-JSON (a guarda exige []). */
export function unclassifiedArenaFields(paths: string[] = arenaSchemaFieldPaths()): string[] {
  return paths.filter((p) => !(p in ARENA_FIELD_HANDLING));
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Caminhos-folha PRESENTES num objeto (mesma notação de `arenaSchemaFieldPaths`). */
export function presentArenaFieldPaths(value: unknown, leaves: Set<string> = new Set(arenaSchemaFieldPaths())): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, path: string): void => {
    if (v === undefined) return;
    if (path && leaves.has(path)) {
      out.add(path);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, `${path}[]`);
      return;
    }
    if (isPlainObject(v)) {
      for (const [k, sub] of Object.entries(v)) walk(sub, path ? `${path}.${k}` : k);
      return;
    }
    out.add(path);
  };
  walk(value, '');
  return [...out].sort();
}

/**
 * Chaves do JSON cru que o zod DESCARTOU (z.object remove chave desconhecida em
 * silêncio). Ex.: `training.halvng` (typo) ou um campo que saiu do schema.
 */
export function unknownArenaFields(raw: unknown, parsed: unknown, path = ''): string[] {
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    return raw.flatMap((item, i) => unknownArenaFields(item, parsed[i], `${path}[${i}]`));
  }
  if (!isPlainObject(raw) || !isPlainObject(parsed)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const sub = path ? `${path}.${k}` : k;
    if (v === undefined) continue;
    if (!(k in parsed)) out.push(sub);
    else out.push(...unknownArenaFields(v, parsed[k], sub));
  }
  return out;
}

// ----------------------------------------------------------------------------
// Import: arquivo → estado (com aviso nomeando o que não entra na run)
// ----------------------------------------------------------------------------

export interface ArenaFieldWarning {
  path: string;
  message: string;
}

export function formatArenaWarning(w: ArenaFieldWarning): string {
  return `${w.path}: ${w.message}`;
}

const MODE_LABEL: Record<RunMode, string> = {
  compare: 'comparar',
  variation: 'testar prompts',
  training: 'treinar',
};

function clampLimit(
  key: keyof typeof LIMITS_RANGE,
  value: number,
  warnings: ArenaFieldWarning[],
): number {
  const { min, max } = LIMITS_RANGE[key];
  const v = Math.max(min, Math.min(max, Math.round(value)));
  if (v !== value) {
    warnings.push({
      path: `limits.${key}`,
      message: `${value} fora da faixa da tela (${min}–${max === Infinity ? '∞' : max}); ajustado para ${v}`,
    });
  }
  return v;
}

/**
 * Aplica uma arena-config ao estado da tela. Campos de UI AUSENTES no arquivo
 * não pisam o estado atual; campos só-JSON (sem controle na tela) espelham o
 * ÚLTIMO arquivo — ausente = desligado —, senão um valor invisível de um import
 * anterior vazaria para a run seguinte. Nunca lança.
 */
export function applyArenaConfigToForm(
  prev: ArenaFormState,
  config: ArenaConfigFile,
  opts: { raw?: unknown; now?: string } = {},
): { state: ArenaFormState; warnings: ArenaFieldWarning[] } {
  const warnings: ArenaFieldWarning[] = [];
  const s: ArenaFormState = { ...prev };
  const mode = config.mode;
  const leaves = new Set(arenaSchemaFieldPaths());
  const present = presentArenaFieldPaths(config, leaves);
  const aplicavel = (path: string): boolean => {
    const h = ARENA_FIELD_HANDLING[path];
    return !h?.modes || h.modes.includes(mode);
  };
  // `variation.optimize` ausente no arquivo = o da tela (o import não o pisa).
  const optimizeEfetivo = config.variation?.optimize ?? prev.optimize;

  // 1) Aviso por campo presente que NÃO entra nesta run (tabela de paridade).
  // Subcampos de lista (`x[].y`) viram UM aviso para a lista; ignorados com o
  // mesmo motivo (a referência à biblioteca) também.
  const avisados = new Set<string>();
  for (const path of present) {
    const h = ARENA_FIELD_HANDLING[path];
    if (!h) continue; // impossível com a guarda verde; o teste cobre
    const raiz = path.replace(/\[\]\..*$/, '');
    if (h.kind === 'json-only' && h.status === 'ignorado') {
      if (avisados.has(h.note)) continue;
      warnings.push({ path, message: `ignorado — ${h.note}` });
      avisados.add(h.note);
    } else if (!aplicavel(path) && !avisados.has(raiz)) {
      warnings.push({
        path: raiz,
        message:
          h.kind === 'ui'
            ? `não se aplica ao modo ${MODE_LABEL[mode]} — mantido no formulário, fora desta run`
            : `não se aplica ao modo ${MODE_LABEL[mode]} — ignorado`,
      });
      avisados.add(raiz);
    } else if (
      aplicavel(path) &&
      mode !== 'compare' &&
      h.whenOptimize !== undefined &&
      h.whenOptimize !== optimizeEfetivo &&
      !avisados.has(raiz)
    ) {
      // Técnicas/reescritor/contratos só valem com optimize ligado; variantes
      // manuais só com ele desligado — o outro lado era aceito e sumia calado.
      warnings.push({
        path: raiz,
        message: `só entra na run com variation.optimize ${h.whenOptimize ? 'ligado' : 'desligado'} — mantido no formulário, fora desta run`,
      });
      avisados.add(raiz);
    }
  }
  // 2) Chaves que o zod descartou (desconhecidas/typo/campo removido do schema).
  if (opts.raw !== undefined) {
    for (const path of unknownArenaFields(opts.raw, config)) {
      // Descontinuado que saiu do schema (ex.: training.halving, IMPL-012): o
      // zod o descarta, mas o aviso nomeia o MOTIVO, não "desconhecido".
      const h = ARENA_FIELD_HANDLING[path];
      warnings.push(
        h?.kind === 'json-only' && h.discontinued
          ? { path, message: `ignorado — ${h.note}` }
          : { path, message: 'campo desconhecido — ignorado' },
      );
    }
  }

  s.mode = mode;
  s.theme = config.theme;
  if (config.scenarioBrief !== undefined) s.scenarioBrief = config.scenarioBrief;
  if (config.stages !== undefined) s.stages = config.stages;
  // Cenários pinados: viram seed no MESMO estado do pacote de cenários.
  if (Array.isArray(config.scenarios)) {
    const tokensFallback = config.limits?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    s.customStages = null;
    s.pack = {
      format: 'prompt-builder-pack@1',
      theme: config.theme,
      exportedAt: opts.now ?? new Date().toISOString(),
      prompt: { text: config.prompt?.text ?? '', source: 'base' },
      scenarios: config.scenarios.map((sc, i) => ({
        id: sc.id ?? `import-${i + 1}`,
        question: sc.question,
        productContext: sc.productContext ?? '',
        maxTokens: sc.maxTokens ?? tokensFallback,
        rubric: sc.rubric ?? '',
        ...(sc.reference !== undefined ? { reference: sc.reference } : {}),
        ...(sc.expected !== undefined ? { expected: sc.expected } : {}),
        // IMPL-003: sem o labelSet o verificador estrito perde a lista de rótulos.
        ...(sc.labelSet !== undefined ? { labelSet: [...sc.labelSet] } : {}),
        origin: 'import' as const,
      })),
    };
  }
  if (config.prompt?.text !== undefined) {
    s.basePrompt = config.prompt.text;
    s.promptImported = !!config.prompt.text.trim();
  }
  if (config.prompt?.generateFrom !== undefined) s.taskDescription = config.prompt.generateFrom;

  s.datagen = [config.models.datagen];
  s.judge = [...config.models.judges];
  if (config.models.reference !== undefined) s.referenceModel = config.models.reference ? [config.models.reference] : [];
  if (config.models.contestant !== undefined) s.contestantModel = config.models.contestant ? [config.models.contestant] : [];
  if (config.models.competitors) {
    s.competitors = [...config.models.competitors];
    s.compareAxis = 'models';
  }
  if (config.models.competitorConfigs) {
    s.competitorConfigs = config.models.competitorConfigs.map((c) => ({
      modelId: c.model,
      temperature: c.temperature !== undefined ? String(c.temperature) : '',
      reasoningLevel: c.reasoning ?? '',
    }));
    s.compareAxis = 'configs';
  }
  if (config.models.rewriter !== undefined) s.rewriterModel = config.models.rewriter ? [config.models.rewriter] : [];

  // O esforço do arquivo é por PAPEL; na tela ele mora no MODELO. Dois papéis no
  // mesmo modelo com níveis diferentes não cabem num chip só: o último vence e o
  // perdedor é NOMEADO no aviso (antes sumia calado).
  const tuned: Record<string, ModelTuning> = {};
  const origem: Record<string, string> = {};
  const putEffort = (ids: string[], effort: ReasoningLevel | undefined, path: string) => {
    if (!effort) return;
    for (const id of ids) {
      if (!id) continue;
      const antes = tuned[id]?.effort;
      if (antes && antes !== effort && origem[id]) {
        warnings.push({
          path: origem[id],
          message: `'${antes}' substituído por '${effort}' (${path}) no modelo ${id} — na tela o esforço é por modelo`,
        });
      }
      tuned[id] = { ...tuned[id], effort };
      origem[id] = path;
    }
  };
  if (config.effort?.competitor && mode === 'compare' && config.models.competitorConfigs) {
    // Eixo configs: o esforço é por LINHA (`competitorConfigs[].reasoning`).
    warnings.push({
      path: 'effort.competitor',
      message: 'ignorado — com competitorConfigs o esforço vai em cada config (reasoning)',
    });
  } else {
    putEffort(
      mode === 'compare' ? config.models.competitors ?? s.competitors : s.contestantModel,
      config.effort?.competitor,
      'effort.competitor',
    );
  }
  putEffort([config.models.datagen], config.effort?.datagen, 'effort.datagen');
  putEffort(config.models.judges, config.effort?.judge, 'effort.judge');
  putEffort(s.rewriterModel, config.effort?.rewriter, 'effort.rewriter');
  for (const c of config.models.competitorConfigs ?? []) {
    if (c.reasoning !== undefined && origem[c.model] && tuned[c.model]?.effort !== c.reasoning) {
      warnings.push({
        path: origem[c.model],
        message: `'${tuned[c.model]?.effort}' substituído pelo reasoning '${c.reasoning}' da config de ${c.model} — na tela o esforço é por modelo`,
      });
      delete origem[c.model];
    }
    tuned[c.model] = {
      ...tuned[c.model],
      ...(c.reasoning !== undefined ? { effort: c.reasoning } : {}),
      ...(c.temperature !== undefined ? { temperature: String(c.temperature) } : {}),
    };
  }
  if (Object.keys(tuned).length) s.tuning = { ...prev.tuning, ...tuned };

  if (config.variation?.optimize !== undefined) s.optimize = config.variation.optimize;
  if (config.variation?.techniques) s.techniques = [...config.variation.techniques];
  if (config.variation?.manualVariants) s.manualVariants = config.variation.manualVariants.map((v) => ({ ...v }));
  if (config.training?.iterations !== undefined) s.iterations = config.training.iterations;
  if (config.training?.minGain !== undefined) s.minGain = String(config.training.minGain);
  if (config.training?.holdoutRatio !== undefined) s.holdoutRatio = config.training.holdoutRatio;
  if (config.training?.feedbackDriven !== undefined) s.feedbackDriven = config.training.feedbackDriven;

  // duels/finalists/repeats: a raiz é o lugar canônico; o bloco training é
  // compat. Os dois presentes e divergentes = o de training perde, com aviso.
  const alias = <T>(root: T | undefined, legado: T | undefined, nome: string): T | undefined => {
    if (root !== undefined && legado !== undefined && root !== legado) {
      warnings.push({ path: `training.${nome}`, message: `ignorado — a raiz \`${nome}\` (${String(root)}) tem precedência` });
    }
    return root ?? legado;
  };
  const duelsFlag = alias(config.duels, config.training?.duels, 'duels');
  if (duelsFlag !== undefined) s.duelsOn = duelsFlag;
  const finalistsCfg = alias(config.finalists, config.training?.finalists, 'finalists');
  if (finalistsCfg !== undefined) s.finalists = finalistsCfg;
  if (config.judging?.passes !== undefined) s.twoPassJudge = config.judging.passes === 2;
  // Clamp na entrada: os inputs têm min/max nativos e um valor fora da faixa
  // faz o browser abortar o submit SEM mensagem — ajustar sim, mas avisando.
  if (config.limits?.maxOutputTokens !== undefined)
    s.maxOutputTokens = String(clampLimit('maxOutputTokens', config.limits.maxOutputTokens, warnings));
  if (config.limits?.timeoutMs !== undefined) s.timeoutMs = clampLimit('timeoutMs', config.limits.timeoutMs, warnings);
  if (config.limits?.concurrency !== undefined)
    s.concurrency = clampLimit('concurrency', config.limits.concurrency, warnings);
  if (config.compliance) {
    s.complianceArea = config.compliance.area;
    s.includeRessalvas = config.compliance.includeRessalvas;
  }
  if (config.piiMode !== undefined) s.piiMode = config.piiMode;

  // Só-JSON: espelham o arquivo (ausente/não aplicável = desligado).
  s.refJudgingChoice = config.judging?.reference ?? null;
  const single = mode !== 'compare';
  s.promptContracts = single ? config.prompt?.contracts : undefined;
  s.promptGroup = single && config.prompt?.group ? { prompts: config.prompt.group.map((p) => ({ ...p })) } : undefined;
  s.promptId = single ? config.prompt?.promptId : undefined;
  // Grupo inválido (o schema já recusa; defesa p/ quem chama sem o parse) NÃO
  // entra: `composePrompt` descartaria a variante e a run não mediria nada.
  if (s.promptGroup) {
    const grupo = validatePromptGroup(s.promptGroup, s.promptId);
    if (!grupo.ok) {
      warnings.push({ path: 'prompt.group', message: `ignorado — ${grupo.error}` });
      s.promptGroup = undefined;
      s.promptId = undefined;
    }
  } else if (s.promptId !== undefined) {
    // promptId sozinho não escolhe fragmento nenhum (o motor só o lê com grupo).
    warnings.push({ path: 'prompt.promptId', message: 'ignorado — sem prompt.group não há fragmento a escolher' });
    s.promptId = undefined;
  }
  const repeats = alias(config.repeats, (config.training as { repeats?: 1 | 2 | 3 } | undefined)?.repeats, 'repeats');
  s.repeats = mode === 'compare' ? repeats : undefined;
  s.reflection = mode === 'training' ? config.training?.reflection : undefined;
  if (s.reflection === 'off') {
    // 'off' = sem lições (== feedbackDriven false, ver types.ts). Vira o toggle
    // da tela, que é quem o usuário vê — senão a tela mostraria "Lições das
    // falhas" ligado numa run sem lições.
    if (config.training?.feedbackDriven === true) {
      warnings.push({
        path: 'training.feedbackDriven',
        message: "ignorado — training.reflection 'off' desliga as lições das falhas",
      });
    }
    s.feedbackDriven = false;
    s.reflection = undefined;
  }
  s.paretoPool = mode === 'training' ? config.training?.paretoPool : undefined;
  // Tira chaves `undefined` (o estado fica igual ao de quem nunca importou).
  for (const k of ['promptContracts', 'promptGroup', 'promptId', 'repeats', 'reflection', 'paretoPool'] as const) {
    if (s[k] === undefined) delete s[k];
  }
  return { state: s, warnings };
}

// ----------------------------------------------------------------------------
// Export: estado → arquivo (o que se aplica ao modo atual)
// ----------------------------------------------------------------------------

function effortOf(tuning: Record<string, ModelTuning>, id?: string): ReasoningLevel | undefined {
  const e = id ? tuning[id]?.effort : undefined;
  return e ? e : undefined;
}

function toArenaScenario(sc: StageSpec & { id?: string }): ArenaConfigScenario {
  return {
    ...(sc.id !== undefined ? { id: sc.id } : {}),
    question: sc.question,
    productContext: sc.productContext ?? '',
    maxTokens: sc.maxTokens,
    rubric: sc.rubric ?? '',
    ...(sc.reference !== undefined ? { reference: sc.reference } : {}),
    ...(sc.expected !== undefined ? { expected: sc.expected } : {}),
    ...(sc.labelSet !== undefined ? { labelSet: [...sc.labelSet] } : {}),
  };
}

/**
 * Serializa o estado da tela como arena-config@1 — só o que se aplica ao modo
 * atual (é o arquivo que reproduz ESTA run). `omitted` nomeia o que a tela tem e
 * o formato não representa (o chamador avisa; nada some calado).
 */
export function exportArenaConfig(s: ArenaFormState): { config: ArenaConfigFile; omitted: ArenaFieldWarning[] } {
  const omitted: ArenaFieldWarning[] = [];
  const single = s.mode !== 'compare';
  const maxTok = parseFloat(s.maxOutputTokens);

  const models: ArenaConfigFile['models'] = {
    datagen: s.datagen[0] ?? DEFAULT_DATAGEN,
    judges: [...s.judge],
    ...(s.referenceModel[0] ? { reference: s.referenceModel[0] } : {}),
  };
  const effort: NonNullable<ArenaConfigFile['effort']> = {};
  if (single) {
    if (s.contestantModel[0]) models.contestant = s.contestantModel[0];
    // Reescritor só existe com optimize ligado (mesma regra do buildConfig).
    if (s.optimize && s.rewriterModel[0]) models.rewriter = s.rewriterModel[0];
    const ce = effortOf(s.tuning, s.contestantModel[0]);
    if (ce) effort.competitor = ce;
    const re = s.optimize ? effortOf(s.tuning, s.rewriterModel[0]) : undefined;
    if (re) effort.rewriter = re;
    if (s.contestantModel[0] && s.tuning[s.contestantModel[0]]?.temperature?.trim()) {
      omitted.push({
        path: 'temperatura do modelo sob teste',
        message: 'o arena-config não tem campo para ela — ajuste de novo após importar',
      });
    }
  } else if (s.compareAxis === 'configs') {
    models.competitorConfigs = s.competitorConfigs
      .filter((r) => r.modelId)
      .map((r) => {
        const t = parseFloat(r.temperature);
        return {
          model: r.modelId,
          ...(Number.isFinite(t) ? { temperature: t } : {}),
          ...(r.reasoningLevel ? { reasoning: r.reasoningLevel } : {}),
        };
      });
  } else {
    // Ajuste uniforme cabe em effort.competitor; ajuste POR competidor (ou
    // temperatura) só cabe em competitorConfigs — a mesma promoção do buildConfig.
    const efforts = new Set(s.competitors.map((id) => effortOf(s.tuning, id) ?? ''));
    const temTemp = s.competitors.some((id) => s.tuning[id]?.temperature?.trim());
    const [unico] = [...efforts];
    if (!temTemp && efforts.size === 1) {
      models.competitors = [...s.competitors];
      if (unico) effort.competitor = unico as ReasoningLevel;
    } else {
      models.competitorConfigs = s.competitors.map((id) => {
        const t = parseFloat(s.tuning[id]?.temperature ?? '');
        const e = effortOf(s.tuning, id);
        return { model: id, ...(Number.isFinite(t) ? { temperature: t } : {}), ...(e ? { reasoning: e } : {}) };
      });
    }
  }
  const je = effortOf(s.tuning, s.judge[0]);
  if (je) effort.judge = je;
  const de = effortOf(s.tuning, s.datagen[0]);
  if (de) effort.datagen = de;
  const refE = effortOf(s.tuning, s.referenceModel[0]);
  if (refE && refE !== je) {
    omitted.push({
      path: 'esforço do gabarito',
      message: 'o arena-config não tem effort.reference — o gabarito segue o esforço do juiz',
    });
  }

  const scenarios = s.pack?.scenarios ?? s.customStages ?? null;
  // Etapas cruas SUBSTITUEM o gerador; no arquivo elas voltam como seed de
  // pacote. Com `stages` = nº de etapas o seed cobre o alvo e o datagen não
  // gera nada — sem isto o `stages` velho da tela (default 5) fazia a run
  // reimportada gerar cenários a mais (e custar mais) sem aviso.
  const stages = !s.pack && s.customStages?.length ? Math.min(50, s.customStages.length) : s.stages;

  const config: ArenaConfigFile = {
    format: ARENA_CONFIG_FORMAT,
    mode: s.mode,
    theme: s.theme,
    ...(s.scenarioBrief ? { scenarioBrief: s.scenarioBrief } : {}),
    stages,
    ...(scenarios?.length ? { scenarios: scenarios.map(toArenaScenario) } : {}),
    models,
    ...(Object.keys(effort).length ? { effort } : {}),
    duels: s.duelsOn,
    finalists: s.finalists,
    judging: {
      ...(s.refJudgingChoice !== null ? { reference: s.refJudgingChoice } : {}),
      passes: s.twoPassJudge ? 2 : 1,
    },
    limits: {
      ...(Number.isFinite(maxTok) && maxTok > 0 ? { maxOutputTokens: Math.round(maxTok) } : {}),
      timeoutMs: s.timeoutMs,
      concurrency: s.concurrency,
    },
    compliance: { area: s.complianceArea, includeRessalvas: s.includeRessalvas },
    // 'redact' é o default: só o modo estrito vai para o arquivo.
    ...(s.piiMode === 'synthetic' ? { piiMode: 'synthetic' as const } : {}),
  };

  if (single) {
    if (s.basePrompt.trim()) {
      config.prompt = {
        text: s.basePrompt,
        ...(s.taskDescription ? { generateFrom: s.taskDescription } : {}),
        ...(s.promptContracts && s.optimize ? { contracts: s.promptContracts } : {}),
        ...(s.promptGroup ? { group: s.promptGroup.prompts.map((p) => ({ ...p })) } : {}),
        ...(s.promptId !== undefined ? { promptId: s.promptId } : {}),
      };
    } else if (s.taskDescription || s.promptContracts || s.promptGroup || s.promptId) {
      omitted.push({
        path: 'prompt',
        message: 'sem prompt base o arquivo não aceita o bloco prompt (prompt.text é obrigatório) — descrição, contratos e grupo ficaram de fora',
      });
    }
    config.variation = s.optimize
      ? { optimize: true, techniques: [...s.techniques] }
      : { optimize: false, manualVariants: s.manualVariants.filter((v) => v.systemPrompt.trim()).map((v) => ({ ...v })) };
    if (s.mode === 'training') {
      config.training = {
        iterations: s.iterations,
        // '' = automática (IMPL-002): o campo fica de fora e o gate resolve.
        ...(s.minGain.trim() !== '' && Number.isFinite(Number(s.minGain))
          ? { minGain: Math.max(0, Math.min(100, Number(s.minGain))) }
          : {}),
        holdoutRatio: s.holdoutRatio,
        feedbackDriven: s.feedbackDriven,
        ...(s.reflection !== undefined ? { reflection: s.reflection } : {}),
        ...(s.paretoPool !== undefined ? { paretoPool: s.paretoPool } : {}),
      };
    }
  } else if (s.repeats !== undefined) {
    config.repeats = s.repeats;
  }
  return { config, omitted };
}

/** Valor atual de um campo só-JSON aplicado (para a lista visível), ou undefined. */
export function jsonOnlyActiveValue(s: ArenaFormState, path: string): unknown {
  switch (path) {
    case 'judging.reference':
      return s.refJudgingChoice ?? undefined;
    case 'repeats':
      return s.repeats;
    case 'training.reflection':
      return s.reflection;
    case 'training.paretoPool':
      return s.paretoPool;
    case 'prompt.promptId':
      return s.promptId;
    case 'prompt.contracts.neverBreak':
      return s.promptContracts?.neverBreak;
    case 'prompt.contracts.placeholders':
      return s.promptContracts?.placeholders;
    case 'prompt.contracts.minLengthRatio':
      return s.promptContracts?.minLengthRatio;
    case 'prompt.contracts.judgeDiff':
      return s.promptContracts?.judgeDiff;
    case 'prompt.contracts.canaries[].id':
      return s.promptContracts?.canaries?.map((c, i) => c.id ?? `${c.kind}#${i + 1}`);
    case 'prompt.group[].id':
      return s.promptGroup?.prompts.map((p) => p.id);
    default:
      return undefined;
  }
}

/**
 * O que os campos só-JSON APLICADOS acrescentam ao RunConfig (o buildConfig do
 * NewRun espalha isto). Antes do IMPL-045 eles eram validados e nunca enviados.
 * `judging.reference` fica de fora: o NewRun resolve o default por modo/eixo.
 */
export function jsonOnlyRunPatch(
  s: Pick<ArenaFormState, 'mode' | 'promptContracts' | 'promptGroup' | 'promptId' | 'repeats' | 'reflection' | 'paretoPool'>,
): Pick<RunConfig, 'contracts' | 'promptGroup' | 'promptId' | 'repeats' | 'reflection' | 'paretoPool'> {
  const out: Pick<RunConfig, 'contracts' | 'promptGroup' | 'promptId' | 'repeats' | 'reflection' | 'paretoPool'> = {};
  if (s.mode === 'compare') {
    // Repetir o mesmo cenário só é medido no compare (o orchestrator ignora fora dele).
    if (s.repeats !== undefined && s.repeats > 1) out.repeats = s.repeats;
    return out;
  }
  if (s.promptContracts) out.contracts = s.promptContracts;
  // Só grupo VÁLIDO vai para a run: o Node o recusaria (runConfigSchema) e a
  // SPA, sem esta guarda, evoluía o fragmento errado (ou nenhum) calada.
  if (s.promptGroup && validatePromptGroup(s.promptGroup, s.promptId).ok) {
    out.promptGroup = s.promptGroup;
    if (s.promptId !== undefined) out.promptId = s.promptId;
  }
  if (s.mode === 'training') {
    if (s.reflection !== undefined) out.reflection = s.reflection;
    if (s.paretoPool !== undefined) out.paretoPool = s.paretoPool;
  }
  return out;
}

/**
 * Pendência do grupo multi-prompt (a MESMA regra do runConfigSchema do Node),
 * ou null. O import já recusa grupo inválido; o problems() do NewRun chama isto
 * antes do submit como última guarda — run paga que não mede nada não sai.
 */
export function promptGroupProblem(
  s: Pick<ArenaFormState, 'mode' | 'promptGroup' | 'promptId'>,
): string | null {
  if (s.mode === 'compare' || !s.promptGroup) return null;
  const r = validatePromptGroup(s.promptGroup, s.promptId);
  return r.ok ? null : `Grupo multi-prompt do arquivo inválido — ${r.error} Reimporte o JSON corrigido.`;
}
