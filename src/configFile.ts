// Arquivo de CONFIGURAÇÃO do assistente Nova Run (formato 'arena-config@1'): um
// JSON gerado por uma IA externa que o usuário importa na UI para preencher TUDO
// de uma vez (modo, modelos, effort, cenários pinados, prompt, toggles).
//
// Espelho de `web/src/engine/configFile.ts` — mantenha os dois em sincronia.
// O arquivo descreve o ESTADO DO ASSISTENTE (Nova Run), nao um RunConfig; a
// traducao para RunConfig vive em `arenaConfig.ts`.
//
// A validação (zod) NUNCA lança exceção: qualquer problema vira uma mensagem de
// erro em PT-BR legível, para a UI exibir num banner sem derrubar nada.

import { z } from 'zod';
import { getTechnique } from './techniques.js';
import type { ReasoningLevel } from './types.js';
import type { AgentLimits } from './agent/types.js';

/** Valor do campo `format` — versão do contrato do arquivo de configuração. */
export const ARENA_CONFIG_FORMAT = 'arena-config@1';

/** Valor do campo `format` do arquivo de configuração do MODO AGENTE. */
export const ARENA_AGENT_CONFIG_FORMAT = 'arena-agent-config@1';

// ----------------------------------------------------------------------------
// ⚠️ ESPELHO ASSIMÉTRICO — arquivo `arena-agent-config@1` NO BACKEND.
//
// O espelho `web/src/engine/configFile.ts` NÃO conhece este formato. Isto é de
// PROPÓSITO, não um buraco para "consertar": o modo agente spawna um executável
// num workspace isolado (child_process, filesystem, git) — o navegador não tem
// nada disso. Se a SPA estática validasse `arena-agent-config@1`, ela aceitaria
// (com sucesso) uma configuração que NUNCA conseguirá executar — o pior tipo de
// erro, porque só aparece depois. Portanto não exista espelho do modo agente em
// `web/src/engine/`; o frontend só roda chat (ver src/agent/types.ts, §25).
// ----------------------------------------------------------------------------

/** Cenário pinado no arquivo de configuração (vira `scenarioSeed` da run). */
export interface ArenaConfigScenario {
  id?: string;
  question: string; // min 1
  productContext?: string; // default ''
  /** A UI preenche os ausentes com `limits.maxOutputTokens`. */
  maxTokens?: number; // int positivo <= 16000
  rubric?: string; // default ''
  /** Gabarito (opcional — a engine gera se ausente). */
  reference?: string;
  /**
   * Rótulo esperado (ground-truth, F1/P0.5): veredito determinístico sem juiz
   * LLM. `string` | alternativas | par campo→valor (resposta JSON).
   */
  expected?: string | string[] | Record<string, string | number | boolean>;
}

/**
 * Referência à BIBLIOTECA de cenários persistente (F1/P0.1). Em vez de pinar
 * cenários no arquivo, o config aponta um banco curado estável — é o que torna
 * a evolução comparável entre sessões. Resolvido pelo CLI (`pb library`); a
 * SPA client-side usa `scenarios: [...]` (sem filesystem).
 */
export interface ArenaConfigLibraryRef {
  from: 'library';
  /** Perfil da biblioteca (`<data-dir>/library/<profile>/`). */
  profile: string;
  /** Subset de ids (ausente = todos os itens do perfil). */
  ids?: string[];
}

/** Contratos never-break do prompt base (F2/P0.3) — vivem no perfil do prompt. */
export interface ArenaConfigContracts {
  neverBreak?: string[];
  placeholders?: string[];
  minLengthRatio?: number;
}

/** Contrato do arquivo de configuração importável do assistente Nova Run. */
export interface ArenaConfigFile {
  format: 'arena-config@1';
  mode: 'compare' | 'variation' | 'training';
  theme: string; // min 1
  /** Briefing detalhado para guiar o datagen (max 4000). */
  scenarioBrief?: string;
  stages?: number; // int 1..50
  /** Cenários pinados (viram scenarioSeed) OU referência à biblioteca (F1). */
  scenarios?: ArenaConfigScenario[] | ArenaConfigLibraryRef;
  /**
   * text = basePrompt (multi-prompt: o texto ATUAL do fragmento-alvo);
   * generateFrom = taskDescription p/ o botão "gerar base" da UI.
   * `group` + `promptId` = coordinate ascent (F2/P0.4): o grupo de fragmentos
   * da feature e qual deles esta sessao evolui (irmaos congelados).
   */
  prompt?: {
    text: string;
    generateFrom?: string;
    contracts?: ArenaConfigContracts;
    group?: { id: string; label?: string; text: string }[];
    promptId?: string;
  };
  models: {
    datagen: string;
    judges: string[]; // min 1
    reference?: string; // default na prática: judges[0]
    contestant?: string; // obrigatório em variation/training
    competitors?: string[]; // compare eixo "modelos distintos" (>=2)
    competitorConfigs?: { model: string; temperature?: number; reasoning?: ReasoningLevel }[]; // compare eixo "configs" (2..12)
    rewriter?: string; // otimizador; default na prática: datagen
  };
  effort?: {
    competitor?: ReasoningLevel;
    judge?: ReasoningLevel;
    rewriter?: ReasoningLevel;
    datagen?: ReasoningLevel;
  };
  variation?: {
    optimize?: boolean; // default true
    techniques?: string[]; // ids validados contra getTechnique — id desconhecido = ERRO
    manualVariants?: { label: string; systemPrompt: string }[];
  };
  training?: {
    iterations?: number; // int 2..10
    minGain?: number; // 0..100
    holdoutRatio?: number; // 0..0.5
    feedbackDriven?: boolean;
    /** Reflexao GEPA: 'deterministic' (default) | 'llm' | 'off' (F2, §7.5). */
    /** Reflexao GEPA: 'deterministic' (default) | 'llm' | 'off' (F2, §7.5). */
    reflection?: 'off' | 'deterministic' | 'llm';
    /** Pool Pareto (F4.1): >1 = população de prompts em vez do campeão único. */
    paretoPool?: number;
    // `halving` foi descontinuado (IMPL-012): arquivo antigo que o traga ainda
    // é aceito — o zod descarta a chave e `parseArenaConfig` devolve um aviso.
    /** Aceito aqui por compat; o lugar canônico é a raiz do arquivo. */
    duels?: boolean;
    /** Aceito aqui por compat; o lugar canônico é a raiz do arquivo. */
    finalists?: number; // int 0..12
  };
  /** Liga/desliga a fase de finais (duelos). Default: true onde há gabarito. */
  duels?: boolean;
  /** Repetições por cenário (1–3, só compare) — mede instabilidade estocástica (F2 §7.9). */
  repeats?: 1 | 2 | 3;
  /** Nº de finalistas que duelam entre si em cada cenário (0 = sem finais). Default 3. */
  finalists?: number; // int 0..12
  judging?: { reference?: boolean; passes?: 1 | 2 };
  limits?: { maxOutputTokens?: number; timeoutMs?: number; concurrency?: number }; // int positivos
  compliance?: { area: string; includeRessalvas: boolean };
}

// ----------------------------------------------------------------------------
// Modo agente — contrato do arquivo `arena-agent-config@1` (backend/local).
// Tradução para RunConfig: `arenaAgentConfigToRunConfig` em arenaConfig.ts.
// ----------------------------------------------------------------------------

/** `limits` do agente no arquivo — espelha `AgentLimits`, com `maxCostUsd` na
 * prática obrigatório (o schema exige via superRefine; sem teto não há estimativa). */
export interface ArenaAgentConfigLimits extends AgentLimits {
  /** Teto de gasto DA EXECUÇÃO (USD). OBRIGATÓRIO em modo agente (§20.1). */
  maxCostUsd: number;
}

/** Nó `scenario[].agentTask` do arquivo — espelha `AgentTaskSpec` (src/agent/types.ts). */
export interface ArenaAgentTaskConfig {
  repo?: { kind: 'git'; url?: string; path?: string; ref: string; shallow?: boolean };
  setup?: { cmd: string; timeoutMs?: number }[];
  files?: { path: string; content: string }[];
  verify?: { label?: string; cmd: string; expectExit?: number; timeoutMs?: number; weight?: number }[];
  forbiddenPaths?: string[];
  contextFiles?: boolean;
  limits?: ArenaAgentConfigLimits;
}

/** Nó `agent` do arquivo — espelha `AgentRunnerConfig` (src/agent/types.ts). */
export interface ArenaAgentConfigAgent {
  executor: 'pi';
  executorVersion: string;
  install?: 'system' | 'isolated';
  provider?: string;
  promptMode?: 'replace' | 'append' | 'none';
  thinking?: ReasoningLevel;
  tools?: string[];
  repetitions?: number; // int 1..10
  maxParallel?: number; // int 1..32
  limits: ArenaAgentConfigLimits;
  isolation?: { kind?: 'worktree' | 'clone' | 'container'; keepWorkspace?: boolean; image?: string };
}

/** Contrato do arquivo de configuração do MODO AGENTE (`arena-agent-config@1`). */
export interface ArenaAgentConfigFile {
  format: 'arena-agent-config@1';
  mode: 'compare' | 'variation' | 'training';
  theme: string; // min 1
  scenarioBrief?: string;
  agent: ArenaAgentConfigAgent;
  models: {
    datagen: string;
    judges: string[]; // min 1
    reference?: string;
    /** Ids dos modelos que rodam COMO AGENTES no eixo de competidores (compare). */
    competitors: string[]; // >= 2 quando mode compare
  };
  scenarios: {
    question: string;
    productContext?: string;
    rubric?: string;
    agentTask?: ArenaAgentTaskConfig;
    limits?: ArenaAgentConfigLimits;
  }[];
  judging?: { reference?: boolean; passes?: 1 | 2; dossierTokens?: number };
  duels?: boolean;
  finalists?: number; // int 0..12
}

// ----------------------------------------------------------------------------
// parse (validação zod do shape inteiro; nunca lança exceção)
// ----------------------------------------------------------------------------

const reasoningLevelSchema = z.enum(
  ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  "deve ser 'off', 'minimal', 'low', 'medium', 'high', 'xhigh' ou 'max'",
);

// Mensagens inline já citam o nome do campo — o prefixo 'cenário N:' é
// acrescentado em descreverIssues a partir do path do issue.
const scenarioSchema = z.object({
  id: z.string('id deve ser texto').min(1, 'id não pode ser vazio').optional(),
  question: z.string('question obrigatória').min(1, 'question obrigatória'),
  productContext: z.string('productContext deve ser texto').default(''),
  maxTokens: z
    .number('maxTokens deve ser número inteiro')
    .int('maxTokens deve ser número inteiro')
    .positive('maxTokens deve ser maior que zero')
    .max(16000, 'maxTokens não pode passar de 16000')
    .optional(),
  rubric: z.string('rubric deve ser texto').default(''),
  reference: z.string('reference deve ser texto').optional(),
  // Rotulo esperado (ground-truth, F1/P0.5): veredito deterministico sem LLM.
  expected: z
    .union([
      z.string().min(1),
      z.array(z.string().min(1)).min(1),
      z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    ])
    .optional(),
});

// Referencia a biblioteca de cenarios persistente (`scenarios.from: 'library'`).
const libraryRefSchema = z.object(
  {
    from: z.literal('library', "from deve ser 'library'"),
    profile: z.string('profile obrigatório').min(1, 'profile obrigatório'),
    ids: z.array(z.string().min(1)).optional(),
  },
  'library deve ser { from: "library", profile, ids? }',
);

const contractsSchema = z.object(
  {
    neverBreak: z.array(z.string()).optional(),
    placeholders: z.array(z.string()).optional(),
    minLengthRatio: z
      .number('minLengthRatio deve ser número')
      .min(0, 'mínimo 0')
      .max(1, 'máximo 1')
      .optional(),
  },
  'contracts deve ser um objeto { neverBreak?, placeholders?, minLengthRatio? }',
);

const modelsSchema = z.object(
  {
    datagen: z.string('obrigatório').min(1, 'obrigatório'),
    judges: z
      .array(z.string('ids de juiz devem ser texto').min(1, 'id de juiz não pode ser vazio'), 'deve ser uma lista de ids de modelo')
      .min(1, 'informe ao menos 1 juiz'),
    // Default na prática: judges[0] (preenchido pela UI).
    reference: z.string('deve ser texto').min(1, 'não pode ser vazio').optional(),
    contestant: z.string('deve ser texto').min(1, 'não pode ser vazio').optional(),
    competitors: z
      .array(z.string().min(1, 'id de competidor não pode ser vazio'), 'deve ser uma lista de ids de modelo')
      .min(2, 'informe ao menos 2 competidores')
      .optional(),
    competitorConfigs: z
      .array(
        z.object(
          {
            model: z.string('model obrigatório').min(1, 'model obrigatório'),
            temperature: z.number('temperature deve ser número').optional(),
            reasoning: reasoningLevelSchema.optional(),
          },
          'cada item deve ser { model, temperature?, reasoning? }',
        ),
        'deve ser uma lista de configurações',
      )
      .min(2, 'informe ao menos 2 configurações')
      .max(12, 'não pode passar de 12 configurações')
      .optional(),
    // Default na prática: datagen (preenchido pela UI).
    rewriter: z.string('deve ser texto').min(1, 'não pode ser vazio').optional(),
  },
  'models deve ser um objeto com { datagen, judges }',
);

const arenaConfigSchema = z
  .object(
    {
      format: z.literal(ARENA_CONFIG_FORMAT),
      mode: z.enum(['compare', 'variation', 'training'], "deve ser 'compare', 'variation' ou 'training'"),
      theme: z.string('obrigatório').min(1, 'obrigatório'),
      scenarioBrief: z
        .string('deve ser texto')
        .max(4000, 'não pode passar de 4000 caracteres')
        .optional(),
      stages: z
        .number('deve ser número inteiro')
        .int('deve ser número inteiro')
        .min(1, 'deve ser ao menos 1')
        .max(50, 'não pode passar de 50')
        .optional(),
      scenarios: z
        .union(
          [z.array(scenarioSchema, 'deve ser uma lista de cenários'), libraryRefSchema],
          "scenarios deve ser uma lista de cenários OU { from: 'library', profile, ids? }",
        )
        .optional(),
      prompt: z
        .object(
          {
            text: z.string('prompt.text obrigatório').min(1, 'prompt.text obrigatório'),
            generateFrom: z.string('generateFrom deve ser texto').optional(),
            contracts: contractsSchema.optional(),
            group: z
              .array(
                z.object({
                  id: z.string('id obrigatório').min(1, 'id obrigatório'),
                  label: z.string().optional(),
                  text: z.string('text obrigatório').min(1, 'text obrigatório'),
                }),
              )
              .optional(),
            promptId: z.string().min(1).optional(),
          },
          'prompt deve ser um objeto com { text }',
        )
        .optional(),
      models: modelsSchema,
      effort: z
        .object(
          {
            competitor: reasoningLevelSchema.optional(),
            judge: reasoningLevelSchema.optional(),
            rewriter: reasoningLevelSchema.optional(),
            datagen: reasoningLevelSchema.optional(),
          },
          'effort deve ser um objeto com níveis de reasoning por papel',
        )
        .optional(),
      variation: z
        .object(
          {
            optimize: z.boolean('deve ser boolean').default(true),
            techniques: z
              .array(z.string().min(1, 'id de técnica não pode ser vazio'), 'deve ser uma lista de ids de técnica')
              .optional(),
            manualVariants: z
              .array(
                z.object(
                  {
                    label: z.string('label obrigatório').min(1, 'label obrigatório'),
                    systemPrompt: z.string('systemPrompt obrigatório').min(1, 'systemPrompt obrigatório'),
                  },
                  'cada variante manual deve ser { label, systemPrompt }',
                ),
                'deve ser uma lista de variantes',
              )
              .optional(),
          },
          'variation deve ser um objeto',
        )
        .optional(),
      training: z
        .object(
          {
            // Opcional no arquivo (default 3 na UI); se presente, 2..10.
            iterations: z
              .number('deve ser número inteiro')
              .int('deve ser número inteiro')
              .min(2, 'deve ser ao menos 2')
              .max(10, 'não pode passar de 10')
              .optional(),
            minGain: z.number('deve ser número').min(0, 'mínimo 0').max(100, 'máximo 100').optional(),
            holdoutRatio: z.number('deve ser número').min(0, 'mínimo 0').max(0.5, 'máximo 0.5').optional(),
            feedbackDriven: z.boolean('deve ser boolean').optional(),
            reflection: z
              .enum(['off', 'deterministic', 'llm'], "deve ser 'off', 'deterministic' ou 'llm'")
              .optional(),
            paretoPool: z.number().int().min(0).max(8).optional(),
            // `halving`: descontinuado (IMPL-012) — fora do schema de propósito; o
            // zod descarta a chave (qualquer valor) e o aviso sai de
            // `deprecationWarnings`, então arquivo antigo nunca quebra.
            // Compat: `duels`/`finalists` valem para todos os modos e moram na
            // raiz; aceitos aqui para não invalidar arquivos antigos.
            duels: z.boolean('deve ser boolean').optional(),
      repeats: z.union([z.literal(1), z.literal(2), z.literal(3)], 'deve ser 1, 2 ou 3').optional(),
            finalists: z
              .number('deve ser número inteiro')
              .int('deve ser número inteiro')
              .min(0, 'mínimo 0')
              .max(12, 'máximo 12')
              .optional(),
          },
          'training deve ser um objeto',
        )
        .optional(),
      duels: z.boolean('deve ser boolean').optional(),
      repeats: z.union([z.literal(1), z.literal(2), z.literal(3)], 'deve ser 1, 2 ou 3').optional(),
      finalists: z
        .number('deve ser número inteiro')
        .int('deve ser número inteiro')
        .min(0, 'mínimo 0')
        .max(12, 'máximo 12')
        .optional(),
      judging: z
        .object(
          {
            reference: z.boolean('deve ser boolean').optional(),
            passes: z.union([z.literal(1), z.literal(2)], 'deve ser 1 ou 2').optional(),
          },
          'judging deve ser um objeto',
        )
        .optional(),
      limits: z
        .object(
          {
            // LIVRE de propósito (sem teto aqui): o teto real de max_tokens é o
            // da janela do modelo escolhido — o arquivo não deve adivinhá-lo.
            maxOutputTokens: z
              .number('deve ser número inteiro')
              .int('deve ser número inteiro')
              .positive('deve ser maior que zero')
              .optional(),
            timeoutMs: z
              .number('deve ser número inteiro')
              .int('deve ser número inteiro')
              .positive('deve ser maior que zero')
              .optional(),
            concurrency: z
              .number('deve ser número inteiro')
              .int('deve ser número inteiro')
              .positive('deve ser maior que zero')
              .optional(),
          },
          'limits deve ser um objeto',
        )
        .optional(),
      compliance: z
        .object(
          {
            area: z.string('obrigatório').min(1, 'obrigatório'),
            includeRessalvas: z.boolean('includeRessalvas deve ser boolean'),
          },
          'compliance deve ser um objeto com { area, includeRessalvas }',
        )
        .optional(),
    },
    'O arquivo deve ser um objeto de configuração',
  )
  .superRefine((cfg, ctx) => {
    const { mode, models, variation } = cfg;

    // compare: o eixo de competidores é XOR — modelos distintos OU configs.
    if (mode === 'compare') {
      const temLista = (models.competitors?.length ?? 0) > 0;
      const temConfigs = (models.competitorConfigs?.length ?? 0) > 0;
      if (temLista && temConfigs) {
        ctx.addIssue({
          code: 'custom',
          path: ['models'],
          message: "compare: use 'competitors' OU 'competitorConfigs', nunca os dois",
        });
      } else if (!temLista && !temConfigs) {
        ctx.addIssue({
          code: 'custom',
          path: ['models'],
          message: "compare: informe 'competitors' (>=2) ou 'competitorConfigs' (2..12)",
        });
      }
    }

    // variation/training: o modelo sob teste é obrigatório.
    if (mode !== 'compare' && !models.contestant) {
      ctx.addIssue({
        code: 'custom',
        path: ['models', 'contestant'],
        message: mode === 'variation' ? 'obrigatório no modo variação' : 'obrigatório no modo treino',
      });
    }

    // competitorConfigs: a identidade do contestant é a TRIPLA
    // modelo+temperatura+reasoning — repetir a tripla criaria dois
    // contestants indistinguíveis no placar.
    if (models.competitorConfigs) {
      const vistas = new Set<string>();
      for (const c of models.competitorConfigs) {
        const chave = `${c.model}${c.temperature ?? ''}${c.reasoning ?? ''}`;
        if (vistas.has(chave)) {
          ctx.addIssue({
            code: 'custom',
            path: ['models', 'competitorConfigs'],
            message: `configuração duplicada para '${c.model}' (mesmo modelo, temperatura e reasoning)`,
          });
          break;
        }
        vistas.add(chave);
      }
    }

    if (variation) {
      // Otimização desligada => as variantes vêm verbatim do arquivo (mínimo 2).
      if (variation.optimize === false && (variation.manualVariants?.length ?? 0) < 2) {
        ctx.addIssue({
          code: 'custom',
          path: ['variation', 'manualVariants'],
          message: 'com optimize desligado, informe ao menos 2 variantes manuais',
        });
      }
      // Id de técnica desconhecido é ERRO (citando o id) — ignorar em silêncio
      // daria a falsa impressão de que a técnica foi aplicada.
      for (const id of variation.techniques ?? []) {
        if (!getTechnique(id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['variation', 'techniques'],
            message: `técnica desconhecida: '${id}'`,
          });
        }
      }
    }
  });

// Converte os issues do zod numa frase PT-BR com o caminho do campo —
// ex.: 'models.judges: informe ao menos 1 juiz' / 'cenário 2: question
// obrigatória'. Limita a 3 para não inundar a UI.
function descreverIssues(error: z.ZodError): string {
  const partes = error.issues.slice(0, 3).map((iss) => {
    const [head, idx] = iss.path;
    if (head === 'scenarios' && typeof idx === 'number') {
      return `cenário ${idx + 1}: ${iss.message}`;
    }
    const caminho = iss.path.map(String).join('.');
    return caminho ? `${caminho}: ${iss.message}` : iss.message;
  });
  const restantes = error.issues.length - partes.length;
  return restantes > 0 ? `${partes.join('; ')} (+${restantes} erros)` : partes.join('; ');
}

/**
 * Valida um JSON lido de arquivo como ArenaConfigFile. Nunca lança: qualquer
 * problema (não-objeto, format divergente, campo inválido, regra cruzada) vira
 * `{ ok: false, error }` com mensagem legível em PT-BR.
 */
export function parseArenaConfig(
  json: unknown,
): { ok: true; config: ArenaConfigFile; warnings?: string[] } | { ok: false; error: string } {
  // O discriminador `format` é checado à mão ANTES do zod, para garantir a
  // mensagem exata quando o arquivo não é uma configuração (ou é de outra versão).
  const formato =
    json && typeof json === 'object' ? (json as Record<string, unknown>).format : undefined;
  if (formato !== ARENA_CONFIG_FORMAT) {
    const desc = typeof formato === 'string' && formato.trim() ? formato : 'desconhecido';
    return {
      ok: false,
      error: `Arquivo não é uma configuração do prompt-builder (formato ${desc})`,
    };
  }
  const result = arenaConfigSchema.safeParse(json);
  if (!result.success) return { ok: false, error: descreverIssues(result.error) };
  const warnings = deprecationWarnings(json);
  return warnings.length ? { ok: true, config: result.data, warnings } : { ok: true, config: result.data };
}

/** Aviso de `training.halving`, descontinuado no IMPL-012 (lido e ignorado, nunca erro). */
export const HALVING_DEPRECATED_WARNING =
  'training.halving foi descontinuado e será ignorado: a triagem cobrava uma run completa, ' +
  'não eliminava nenhuma variante e descartava as respostas (IMPL-012). Remova a chave do arquivo.';

/**
 * Chaves descontinuadas presentes no JSON CRU (o zod já as descartou do
 * `config`). Vazio = nada a avisar; o chamador narra os avisos (stderr no CLI).
 */
function deprecationWarnings(json: unknown): string[] {
  const training = (json as { training?: unknown }).training;
  if (training && typeof training === 'object' && 'halving' in training) {
    return [HALVING_DEPRECATED_WARNING];
  }
  return [];
}

/**
 * Resumo de 1 linha da configuração, para o banner de confirmação da UI —
 * ex.: 'treino · 3 iterações · 6 cenários (4 importados) · 2 técnicas · juiz gpt-x'.
 */
export function arenaConfigSummary(config: ArenaConfigFile): string {
  const partes: string[] = [];
  partes.push(
    config.mode === 'training' ? 'treino' : config.mode === 'variation' ? 'variação' : 'comparação',
  );

  if (config.mode === 'training') {
    // iterations ausente => default 3 (aplicado pela UI).
    const n = config.training?.iterations ?? 3;
    partes.push(`${n} ${n === 1 ? 'iteração' : 'iterações'}`);
  }
  if (config.mode === 'compare') {
    partes.push(
      config.models.competitorConfigs
        ? `${config.models.competitorConfigs.length} configs`
        : `${config.models.competitors?.length ?? 0} modelos`,
    );
  }

  // Cenários: total pedido (stages) + quantos vêm pinados do arquivo, ou a
  // referência à biblioteca (F1) quando o config aponta um banco curado.
  const pinados = Array.isArray(config.scenarios) ? config.scenarios.length : 0;
  const lib = !Array.isArray(config.scenarios) && config.scenarios ? config.scenarios : undefined;
  if (lib) {
    partes.push(`cenários da biblioteca "${lib.profile}"${lib.ids?.length ? ` (${lib.ids.length} selecionados)` : ''}`);
  } else if (config.stages && pinados) partes.push(`${config.stages} cenários (${pinados} importados)`);
  else if (config.stages) partes.push(`${config.stages} cenários`);
  else if (pinados) partes.push(`${pinados} ${pinados === 1 ? 'cenário importado' : 'cenários importados'}`);

  if (config.mode !== 'compare' && config.variation?.optimize === false) {
    const n = config.variation.manualVariants?.length ?? 0;
    partes.push(`${n} ${n === 1 ? 'variante manual' : 'variantes manuais'}`);
  } else {
    const tecnicas = config.variation?.techniques?.length ?? 0;
    if (tecnicas) partes.push(`${tecnicas} ${tecnicas === 1 ? 'técnica' : 'técnicas'}`);
  }

  const juizes = config.models.judges;
  partes.push(juizes.length === 1 ? `juiz ${juizes[0]}` : `${juizes.length} juízes`);
  return partes.join(' · ');
}

// ----------------------------------------------------------------------------
// Modo agente — schema zod + parse do `arena-agent-config@1`
// ----------------------------------------------------------------------------

// `limits` do agente: `maxCostUsd` obrigatório por construção.
const agentLimitsSchema = z
  .object(
    {
      maxTurns: z.number('deve ser número inteiro').int('deve ser número inteiro').positive('deve ser maior que zero').optional(),
      maxCostUsd: z.number('obrigatório').positive('deve ser maior que zero'),
      timeoutMs: z.number('deve ser número inteiro').int('deve ser número inteiro').positive('deve ser maior que zero').optional(),
      maxOutputBytes: z.number('deve ser número inteiro').int('deve ser número inteiro').positive('deve ser maior que zero').optional(),
      maxDiffBytes: z.number('deve ser número inteiro').int('deve ser número inteiro').positive('deve ser maior que zero').optional(),
    },
    'agent.limits deve ser um objeto com maxCostUsd obrigatório',
  );

const agentTaskSchema = z
  .object(
    {
      repo: z
        .object(
          {
            kind: z.literal('git'),
            url: z.string('url deve ser texto').min(1, 'url não pode ser vazia').optional(),
            path: z.string('path deve ser texto').min(1, 'path não pode ser vazio').optional(),
            ref: z.string('ref obrigatório').min(1, 'ref obrigatório'),
            shallow: z.boolean('shallow deve ser boolean').optional(),
          },
          'repo deve ser um objeto { kind: "git" }',
        )
        .optional(),
      setup: z
        .array(
          z.object(
            {
              cmd: z.string('cmd obrigatório').min(1, 'cmd obrigatório'),
              timeoutMs: z.number('deve ser número inteiro').int('deve ser número inteiro').positive('deve ser maior que zero').optional(),
            },
            'cada setup deve ser { cmd }',
          ),
          'setup deve ser uma lista',
        )
        .optional(),
      files: z
        .array(
          z.object(
            {
              path: z.string('path obrigatório').min(1, 'path obrigatório'),
              content: z.string('content deve ser texto'),
            },
            'cada arquivo deve ser { path, content }',
          ),
          'files deve ser uma lista',
        )
        .optional(),
      verify: z
        .array(
          z.object(
            {
              label: z.string('label deve ser texto').optional(),
              cmd: z.string('cmd obrigatório').min(1, 'cmd obrigatório'),
              expectExit: z.number('deve ser número inteiro').int('deve ser número inteiro').optional(),
              timeoutMs: z.number('deve ser número inteiro').int('deve ser número inteiro').positive('deve ser maior que zero').optional(),
              weight: z.number('deve ser número').positive('deve ser maior que zero').optional(),
            },
            'cada verify deve ser { cmd }',
          ),
          'verify deve ser uma lista',
        )
        .optional(),
      forbiddenPaths: z.array(z.string('caminho deve ser texto'), 'deve ser uma lista de caminhos').optional(),
      contextFiles: z.boolean('contextFiles deve ser boolean').optional(),
      limits: agentLimitsSchema.optional(),
    },
    'agentTask deve ser um objeto',
  );

const agentConfigSchema = z
  .object(
    {
      executor: z.literal('pi'),
      executorVersion: z.string('executorVersion obrigatório').min(1, 'executorVersion obrigatório'),
      install: z.enum(['system', 'isolated'], "deve ser 'system' ou 'isolated'").optional(),
      provider: z.string('provider deve ser texto').min(1, 'provider não pode ser vazio').optional(),
      promptMode: z.enum(['replace', 'append', 'none'], "deve ser 'replace', 'append' ou 'none'").optional(),
      thinking: reasoningLevelSchema.optional(),
      tools: z.array(z.string('ferramenta deve ser texto'), 'deve ser uma lista de ferramentas').optional(),
      repetitions: z
        .number('deve ser número inteiro')
        .int('deve ser número inteiro')
        .min(1, 'mínimo 1')
        .max(10, 'máximo 10')
        .optional(),
      maxParallel: z
        .number('deve ser número inteiro')
        .int('deve ser número inteiro')
        .min(1, 'mínimo 1')
        .max(32, 'máximo 32')
        .optional(),
      limits: agentLimitsSchema,
      isolation: z
        .object(
          {
            kind: z.enum(['worktree', 'clone', 'container'], "deve ser 'worktree', 'clone' ou 'container'").optional(),
            keepWorkspace: z.boolean('keepWorkspace deve ser boolean').optional(),
            image: z.string('image deve ser texto').optional(),
          },
          'isolation deve ser um objeto',
        )
        .optional(),
    },
    'agent deve ser um objeto',
  );

const agentScenarioSchema = z
  .object(
    {
      question: z.string('question obrigatória').min(1, 'question obrigatória'),
      productContext: z.string('productContext deve ser texto').optional(),
      rubric: z.string('rubric deve ser texto').optional(),
      agentTask: agentTaskSchema.optional(),
      limits: agentLimitsSchema.optional(),
    },
    'cada cenário deve ser um objeto',
  );

const arenaAgentConfigSchema = z
  .object(
    {
      format: z.literal(ARENA_AGENT_CONFIG_FORMAT),
      mode: z.enum(['compare', 'variation', 'training'], "deve ser 'compare', 'variation' ou 'training'"),
      theme: z.string('obrigatório').min(1, 'obrigatório'),
      scenarioBrief: z.string('deve ser texto').max(4000, 'não pode passar de 4000 caracteres').optional(),
      agent: agentConfigSchema,
      models: z
        .object(
          {
            datagen: z.string('obrigatório').min(1, 'obrigatório'),
            judges: z
              .array(z.string('ids de juiz devem ser texto').min(1, 'id de juiz não pode ser vazio'), 'deve ser uma lista de ids de modelo')
              .min(1, 'informe ao menos 1 juiz'),
            reference: z.string('deve ser texto').min(1, 'não pode ser vazio').optional(),
            competitors: z
              .array(z.string('id de competidor não pode ser vazio').min(1, 'id de competidor não pode ser vazio'), 'deve ser uma lista de ids de modelo')
              .min(2, 'informe ao menos 2 competidores'),
          },
          'models deve ser um objeto',
        ),
      scenarios: z.array(agentScenarioSchema, 'deve ser uma lista de cenários').min(1, 'informe ao menos 1 cenário'),
      judging: z
        .object(
          {
            reference: z.boolean('deve ser boolean').optional(),
            passes: z.union([z.literal(1), z.literal(2)], 'deve ser 1 ou 2').optional(),
            dossierTokens: z
              .number('deve ser número inteiro')
              .int('deve ser número inteiro')
              .min(1000, 'mínimo 1000')
              .max(200000, 'máximo 200000')
              .optional(),
          },
          'judging deve ser um objeto',
        )
        .optional(),
      duels: z.boolean('deve ser boolean').optional(),
      repeats: z.union([z.literal(1), z.literal(2), z.literal(3)], 'deve ser 1, 2 ou 3').optional(),
      finalists: z
        .number('deve ser número inteiro')
        .int('deve ser número inteiro')
        .min(0, 'mínimo 0')
        .max(12, 'máximo 12')
        .optional(),
    },
    'O arquivo deve ser um objeto de configuração de agente',
  );

/**
 * Valida um JSON lido de arquivo como ArenaAgentConfigFile (`arena-agent-config@1`).
 * Nunca lança. Valida o `format` ANTES do zod, para a mensagem exata de "não é uma
 * configuração" quando o arquivo é outro (ou de outra versão).
 */
export function parseArenaAgentConfig(
  json: unknown,
): { ok: true; config: ArenaAgentConfigFile } | { ok: false; error: string } {
  const formato =
    json && typeof json === 'object' ? (json as Record<string, unknown>).format : undefined;
  if (formato !== ARENA_AGENT_CONFIG_FORMAT) {
    const desc = typeof formato === 'string' && formato.trim() ? formato : 'desconhecido';
    return {
      ok: false,
      error: `Arquivo não é uma configuração do prompt-builder (formato ${desc})`,
    };
  }
  const result = arenaAgentConfigSchema.safeParse(json);
  if (!result.success) return { ok: false, error: descreverIssues(result.error)  };
  return { ok: true, config: result.data };
}
