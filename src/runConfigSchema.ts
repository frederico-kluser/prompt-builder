// Schema Zod do RunConfig — a ESPECIFICACAO REAL de uma run.
//
// Morava dentro de `routes.ts` (acoplado ao Express) mas nao tem nada de HTTP:
// sao os limites de cada campo, o XOR do compare, a regra de que juiz nao
// compete e o preprocess de `customStages`. O CLI precisa validar exatamente
// igual ao servidor — uma segunda copia derivaria no primeiro ajuste de limite.

import { z } from 'zod';
import { sanitizeLlmVariants, MIN_LLM_VARIANTS, MAX_LLM_VARIANTS } from './llmVariants.js';
import { validatePromptGroup } from './engine/promptGroup.js';
import { promptContractsSchema } from './engine/contracts.js';
import { checkRunPii, runPiiMessage, runPiiRefusal } from './engine/pii.js';
import { stageLabelIssues } from './engine/groundTruth.js';
import { roleConflictField, roleConflictMessage, roleSeparationIssues } from './engine/roleSeparation.js';
import { testsDirProblem } from './agent/taskSchema.js';
import type { RunConfig } from './types.js';

// Nivel de esforco de raciocinio (ReasoningLevel de types.ts / REASONING_LEVELS
// de reasoning.ts), repetido aqui como literal para o enum do Zod.
const reasoningLevelSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

// ----------------------------------------------------------------------------
// Modo agente (Agent Arena) — schemas Zod da tarefa executavel (`agentTask`) e
// da config do executor (`config.agent`). Espelham `AgentTaskSpec` e
// `AgentRunnerConfig` de src/agent/types.ts (case EXATO) — suficiente aqui, sem
// importar de la (evita acoplar o schema ao dominio do agente).
// ----------------------------------------------------------------------------

const agentLimitsSchema = z.object({
  // Turnos do agente. Default 30 no dominio.
  maxTurns: z.number().int().positive().optional(),
  // Teto de gasto DESTA execucao em USD. Em modo agente e OBRIGATORIO (o
  // superRefine abaixo exige, pois sem teto nao ha estimativa/orcamento — §20.1).
  maxCostUsd: z.number().positive().optional(),
  // Parede de tempo da execucao. Default 600_000.
  timeoutMs: z.number().int().positive().optional(),
  // Teto de bytes de stdout+stderr. Default 8 MiB.
  maxOutputBytes: z.number().int().positive().optional(),
  // Teto de bytes do diff considerado. Default 512 KiB.
  maxDiffBytes: z.number().int().positive().optional(),
});

// Um check do oraculo (`verify[]`) ou da regressao (`regression[]`, IMPL-098).
const agentCheckSchema = z.object({
  cmd: z.string().min(1),
  expectExit: z.number().int().optional(),
  timeoutMs: z.number().int().positive().optional(),
  weight: z.number().positive().optional(),
  label: z.string().optional(),
  // IMPL-039: F2P (default) x P2P (regressao: quebrar = falha).
  kind: z.enum(['fail_to_pass', 'pass_to_pass']).optional(),
  // IMPL-098: check critico (barreira da validacao da tarefa).
  critical: z.boolean().optional(),
});

// Schema Zod de AgentTaskSpec (src/agent/types.ts): a etapa de agente.
const agentTaskSchema = z.object({
  // Repositorio-semente. `ref` OBRIGATORIO quando ha repo (sem ref pinada nao
  // ha reprodutibilidade); `url` (clonavel) ou `path` (local), um dos dois.
  repo: z
    .object({
      kind: z.literal('git'),
      url: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      ref: z.string().min(1),
      shallow: z.boolean().optional(),
    })
    .optional(),
  // Comandos rodados ANTES do agente acordar (npm ci, build) — nao entram na
  // trajetoria julgada.
  setup: z
    .array(
      z.object({
        cmd: z.string().min(1),
        timeoutMs: z.number().int().positive().optional(),
      }),
    )
    .optional(),
  // Fixtures escritos no workspace depois do setup.
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
    )
    .optional(),
  // Oraculo deterministico: comandos cujo exit code decide o veredito.
  verify: z.array(agentCheckSchema).optional(),
  // IMPL-098 (agentTask@2) — ADITIVOS. Sem eles aqui o parse do RunConfig os
  // DESCARTAVA em silencio (z.object tira chave desconhecida) e a run rodava
  // sem regressao/testsDir mesmo com o arquivo dizendo o contrario.
  regression: z.array(agentCheckSchema).optional(),
  solution: z
    .union([
      z.object({ kind: z.literal('script'), script: z.string().min(1) }),
      z.object({ kind: z.literal('diff'), diff: z.string().min(1) }),
    ])
    .optional(),
  // IMPL-098: a RunConfig CRUA (HTTP /v1/agents, MCP, `--config` do CLI) NUNCA
  // carrega caminho de host — mesma regra do arquivo (`testsDirProblem`:
  // relativo e sem `../`). Um absoluto aqui levaria arquivos da maquina
  // (as chaves SSH da home, o diretorio de dados) para o verificador, onde o verify[] do
  // chamador os le. O absoluto so existe DEPOIS do parse, posto pelo proprio
  // CLI a partir do diretorio do arquivo (`resolveConfigTestsDirs`, agents.ts);
  // relativo sem diretorio de origem a etapa recusa antes de executar.
  testsDir: z
    .string()
    .min(1)
    .superRefine((v, ctx) => {
      const problema = testsDirProblem(v);
      if (problema) ctx.addIssue({ code: 'custom', message: `testsDir ${problema}` });
    })
    .optional(),
  env: z.object({ digest: z.string().min(1), path: z.string().optional() }).optional(),
  metadata: z
    .object({
      origin: z.string().optional(),
      commit: z.string().optional(),
      difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
      tags: z.array(z.string()).optional(),
      canary: z.boolean().optional(),
    })
    .optional(),
  // Caminhos que o agente NAO pode tocar (reward-hacking). Semantica gitignore.
  forbiddenPaths: z.array(z.string()).optional(),
  // IMPL-039: rebuild de dependencias (lockfile do seed) antes do verify[].
  rebuild: z
    .object({
      cmd: z.string().min(1).optional(),
      lockfiles: z.array(z.string()).optional(),
      protect: z.array(z.string()).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .optional(),
  // IMPL-039: detectores estaticos (skip/xfail/exit0/teste apagado/config de runner).
  detectors: z.enum(['off', 'warn', 'fail']).optional(),
  // default false: ver aviso §12.2 do plano (`--no-context-files`).
  contextFiles: z.boolean().default(false),
  // Limites POR EXECUCAO (contrato de custo da tarefa). Default = config.agent.limits.
  limits: agentLimitsSchema.optional(),
});

// Schema Zod de AgentRunnerConfig (src/agent/types.ts): `config.agent`.
const agentSchema = z.object({
  // v1 implementa so 'pi'. O enum existe desde ja para o ponto de extensao.
  executor: z.literal('pi'),
  // Versao EXIGIDA do executor — divergencia = run falha no pre-voo.
  executorVersion: z.string().min(1),
  // Como o binario e obtido. Default 'isolated'.
  install: z.enum(['system', 'isolated']).optional(),
  // Provider do agente. Default 'openrouter'.
  provider: z.string().min(1).optional(),
  // Como o prompt sob teste chega ao agente. Default 'append'.
  promptMode: z.enum(['replace', 'append', 'none']).default('append'),
  // Ferramentas liberadas (allowlist). Ausente = built-ins do executor.
  tools: z.array(z.string()).optional(),
  // Repeticoes por (contestant x cenario). Agente e estocastico. Default 1.
  repetitions: z.number().int().min(1).max(10).optional(),
  // Maximo de execucoes SIMULTANEAS neste processo. Default min(4, cpus-1).
  // Nao viola a regra do limitador global de openrouter.ts — recurso escasso
  // aqui e a MAQUINA, nao o rate limit do provedor.
  maxParallel: z.number().int().min(1).max(32).optional(),
  // Limites default, herdados por toda AgentTaskSpec que nao os declare.
  limits: agentLimitsSchema.optional(),
  // Isolamento do workspace.
  isolation: z
    .object({
      kind: z.enum(['worktree', 'clone', 'container']).optional(),
      // Guarda o workspace ao fim (debug). Default false.
      keepWorkspace: z.boolean().optional(),
      // Imagem, quando kind==='container': tag (pinada no digest sha256 na
      // preparacao) ou referencia por digest. O docker run usa SEMPRE o digest.
      image: z.string().optional(),
      // Runtime OCI opt-in (ex.: 'runsc' = gVisor) — alto risco, fora do default.
      // Mesmo formato de nome que o daemon registra (RUNTIME_NAME_RE, container.ts).
      runtime: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'runtime: nome de runtime Docker invalido')
        .optional(),
    })
    .optional(),
  // Nivel de esforco do agente. MESMA escada do repo (7 degraus).
  thinking: reasoningLevelSchema.optional(),
  // Orcamento de tokens do dossier entregue ao juiz. Default 12_000.
  dossierTokens: z.number().int().min(1000).max(200_000).optional(),
});

// Schema Zod de StageSpec (types.ts), compartilhado por customStages e
// scenarioSeed. Em customStages o preprocess preenche maxTokens ausente
// (herda maxOutputTokens); em scenarioSeed o item ja deve trazer maxTokens.
const stageSpecSchema = z.object({
  question: z.string().min(1),
  productContext: z.string().min(1),
  rubric: z.string().optional(),
  // maxTokens omitido pelo usuario e preenchido no preprocess (herda maxOutputTokens).
  maxTokens: z.number().int().positive().max(16_000),
  // Gabarito (resposta de referencia ideal) p/ julgamento pointwise + duelos.
  reference: z.string().max(32_000).optional(),
  // Rotulo ESPERADO (ground-truth): veredito deterministico sem juiz LLM
  // (`engine/groundTruth.ts`). string | alternativas | par campo->valor.
  expected: z
    .union([
      z.string().min(1),
      z.array(z.string().min(1)).min(1),
      z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    ])
    .optional(),
  // TODOS os rotulos validos da etapa (IMPL-003). Obrigatorio com `expected`
  // curto (<=5 palavras) — o superRefine abaixo aplica `labelSetIssue`.
  labelSet: z.array(z.string().min(1)).min(1).max(200).optional(),
  // Proveniencia da etapa: gerada pela IA ou importada de pacote JSON.
  origin: z.enum(['ai', 'import']).optional(),
  // Metadados de curriculo/idioma/seguranca do StageSpec (IMPL-064/056/068):
  // sem eles o zod os stripava de customStages/scenarioSeed e o fail-closed
  // (IMPL-093) recusava o proprio cenario exportado pela biblioteca/datagen.
  tier: z.string().min(1).optional(),
  dimensionTags: z.array(z.string()).optional(),
  language: z.string().min(2).optional(),
  persona: z.string().optional(),
  difficultyEstimate: z.number().optional(),
  invarianceGroup: z.string().optional(),
  adversarialCategory: z.string().optional(),
  turnLabel: z.string().optional(),
  basePromptHash: z.string().optional(),
  // A etapa, quando executada por um agente. AUSENTE => a etapa so serve ao
  // runner 'chat'. Em modo agente (config.agent presente) e obrigatorio em toda
  // etapa — o superRefine abaixo exige.
  agentTask: agentTaskSchema.optional(),
});

const baseFields = {
  theme: z.string().min(1),
  stages: z.number().int().min(1).max(50),
  datagenModelId: z.string().min(1),
  // Um ou mais juizes (rodam em paralelo). Aceita tambem o legado judgeModelId
  // (string) via preprocess do runConfigSchema.
  judgeModelIds: z.array(z.string().min(1)).min(1),
  concurrency: z.number().int().min(1).max(32).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  // maxOutputTokens livre (teto generoso): a UI virou input livre — o teto
  // real e a janela do modelo; o OpenRouter rejeita o que exceder.
  maxOutputTokens: z.number().int().min(50).max(1_000_000).optional(),
  // Config DA RUN do modo agente (Agent Runner). AUSENTE => run de chat.
  // `maxCostUsd` (dentro de `limits`) e exigido pelo superRefine.
  agent: agentSchema.optional(),
  promptOptimization: z.boolean().optional(),
  optimizerModelId: z.string().min(1).optional(),
  judgePasses: z.union([z.literal(1), z.literal(2)]).optional(),
  // Perfil de conformidade LGPD escolhido no assistente. Área sensível é
  // fail-closed: pré-voo (IMPL-041) + roteamento ZDR forçado em toda requisição
  // (IMPL-040); "geral" segue consultiva. Ausente = "livre".
  compliance: z.object({ area: z.string().min(1), includeRessalvas: z.boolean() }).optional(),
  // Dado pessoal (IMPL-042): 'synthetic' recusa a run com dado de aparencia
  // real; a pseudonimizacao no gateway vale nos dois modos.
  piiMode: z.enum(['redact', 'synthetic']).optional(),
  // Revisao explicita do dado pessoal apontado (modo 'redact'): sem ela, um
  // RunConfig com dado de aparencia real e RECUSADO aqui, nomeando o campo.
  allowPii: z.boolean().optional(),
  // Etapas fornecidas pelo usuario (JSON): pulam o datagen. Quando presentes,
  // `stages` e forcado ao tamanho desta lista (ver preprocess do runConfigSchema).
  customStages: z.array(stageSpecSchema).min(1).max(50).optional(),
  // Esforco de raciocinio por papel (competitor/judge/duel/gab/rewriter/datagen);
  // papel ausente = default do pipeline. IMPL-079: juiz/duelo/gabarito deixam de
  // compartilhar o `judge` unico — papel novo sem campo cai no `judge` antigo e,
  // sem nenhum dos dois, no default do papel (judge=medium, duel=low, gab=high).
  reasoning: z
    .object({
      competitor: reasoningLevelSchema.optional(),
      judge: reasoningLevelSchema.optional(),
      duel: reasoningLevelSchema.optional(),
      gab: reasoningLevelSchema.optional(),
      rewriter: reasoningLevelSchema.optional(),
      datagen: reasoningLevelSchema.optional(),
    })
    .optional(),
  // Modelo que gera os gabaritos (respostas de referencia).
  // IMPL-048 (R-03a:REC-2) — papéis separados: OBRIGATÓRIO em training/
  // variation (o gabarito não pode sair do 1º juiz: o mesmo modelo escrever a
  // régua e julgar contra ela produz erros correlacionados que não se cancelam).
  // Nos demais modos (compare) o default é explícito e documentado: o
  // orquestrador resolve `referenceModelId ?? judgeModelIds[0]` — o risco de
  // auto-preferência desse default aparece em `fairnessWarnings`, não escondido.
  // Erro de config quando a referência é igual a um juiz ou a um competidor
  // (superRefine abaixo); mesmo vendor/família é AVISO (não-bloqueante).
  referenceModelId: z.string().min(1).optional(),
  // Julgamento por referencia (pointwise vs gabarito + duelos).
  referenceJudging: z.boolean().optional(),
  // IMPL-053: sondas contrafactuais do diagnostico de verbosidade (opt-in, custa juiz).
  verbosityProbes: z.boolean().optional(),
  // IMPL-055: valida os gabaritos gerados (rubrica + amostra humana); o 2º
  // gabarito (familia distinta) liga a validacao por si so.
  validateReferences: z.boolean().optional(),
  secondReferenceModelId: z.string().min(1).optional(),
  // Descricao detalhada do que testar — guia o datagen na geracao de cenarios.
  scenarioBrief: z.string().max(4000).optional(),
  // IMPL-056 (R-03a:REC-6): idiomas permitidos no datagen — opt-in; ausente =
  // 100% pt-BR. Tag de idioma curta (BCP 47: 'pt-BR', 'en', 'es-419').
  languages: z
    .array(z.string().trim().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'idioma deve ser uma tag BCP 47 (ex.: pt-BR, en)'))
    .min(1)
    .max(10)
    .optional(),
  // Cenarios importados de pacote JSON (seed); o datagen complementa ate `stages`.
  scenarioSeed: z.array(stageSpecSchema).max(50).optional(),
  // Nº de finalistas (melhores por judge-score) que disputam os duelos. 0 = sem finais.
  finalists: z.number().int().min(0).max(12).optional(),
  // Liga/desliga a fase de finais (duelos entre os finalistas, por taxa de vitória).
  duels: z.boolean().optional(),
  // Teto de gasto em USD para a run/sessao inteira. Ausente = sem limite.
  budgetUsd: z.number().positive().optional(),
  // Teto de preco POR REQUISICAO repassado ao OpenRouter (`provider.max_price`).
  // ATENCAO A UNIDADE: aqui e USD por MILHAO de tokens, enquanto o catalogo
  // (`/models.pricing`) e USD por token. Ver toPerMTok/toPerToken em estimate.ts.
  maxPricePerMTok: z
    .object({
      prompt: z.number().positive().optional(),
      completion: z.number().positive().optional(),
    })
    .optional(),
  // Contratos never-break do prompt base (F2/P0.3): o pos-rewriter valida toda
  // reescrita (invariantes, placeholders verbatim, piso de comprimento).
  // IMPL-011: schema fonte única (inclui judgeDiff e canaries — sem ele o zod
  // STRIPAVA os campos novos em silêncio e a camada 3 nunca rodava pela API).
  contracts: promptContractsSchema.optional(),
  // IMPL-075 (R-07b:REC-4): modo AUDITÁVEL por run/sessão — juiz e gabarito
  // saem com provedor travado (`provider.order`, `allow_fallbacks:false`,
  // `require_parameters:true`, quantizações de precisão cheia). A contagem por
  // papel (`costByRole[*].auditableCalls`) e o registo por chamada (`callLog`)
  // tornam isso visível no artefato de replay.
  auditable: z.boolean().optional(),
};

const manualVariantSchema = z.object({
  label: z.string().min(1),
  systemPrompt: z.string().min(1),
});

const singleModelFields = {
  contestantModelId: z.string().min(1),
  basePrompt: z.string().optional(),
  techniqueIds: z.array(z.string().min(1)).optional(),
  manualVariants: z.array(manualVariantSchema).optional(),
  // Temperatura do modelo sob teste, aplicada a TODAS as variantes. Ausente = 0.
  temperature: z.number().min(0).max(2).optional(),
  // Multi-prompt (F2/P0.4, coordinate ascent): grupo de fragmentos; a sessao
  // evolui `promptId` com os irmaos congelados.
  promptGroup: z
    .object({
      prompts: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().optional(),
            text: z.string().min(1),
          }),
        )
        .min(1),
    })
    .optional(),
  promptId: z.string().min(1).optional(),
};

const compareObj = z.object({
  mode: z.literal('compare'),
  // Repeticoes por cenario (1–3, F2 §7.9): medicao de instabilidade. SÓ no
  // compare — nos demais modos a chave e descartada em silencio (retrocompat:
  // configs antigos que a trazem nao quebram).
  repeats: z
    .union([z.literal(1), z.literal(2), z.literal(3)], 'deve ser 1, 2 ou 3')
    .optional(),
  // >= 2 competidores, todos distintos (eixo classico). Opcional porque
  // competitorConfigs e a alternativa — o superRefine impede ambos/nenhum.
  competitorModelIds: z.array(z.string().min(1)).min(2).optional(),
  // compare-llms: variantes de config {modelo, temperatura, reasoning} no eixo
  // de contestants (identidade = tripla; o mesmo modelo pode competir 2x com
  // configs diferentes). O superRefine roda sanitizeLlmVariants sobre a lista.
  competitorConfigs: z
    .array(
      z.object({
        modelId: z.string().min(1),
        temperature: z.number().min(0).max(2).optional(),
        reasoningLevel: reasoningLevelSchema.optional(),
      }),
    )
    .min(MIN_LLM_VARIANTS)
    .max(MAX_LLM_VARIANTS)
    .optional(),
  // web-code#16: `false` = a 1ª config NÃO vira controle (lista de modelos
  // diferentes, não configs do mesmo modelo). Sem isto o zod descartaria o campo.
  competitorAnchor: z.boolean().optional(),
  ...baseFields,
});
const variationObj = z.object({
  mode: z.literal('variation'),
  ...singleModelFields,
  ...baseFields,
});
const trainingObj = z.object({
  mode: z.literal('training'),
  ...singleModelFields,
  iterations: z.number().int().min(2).max(10),
  // Margem minima de ganho (pp) sobre o campeao para promover; sem ganho = convergiu.
  minGain: z.number().min(0).max(100).optional(),
  // Fracao de cenarios reservada p/ holdout (re-score campeao vs controle).
  holdoutRatio: z.number().min(0).max(0.5).optional(),
  // Paciencia do laco (IMPL-051): iteracoes seguidas sem promocao antes de
  // convergir. Default 2 (trainingPolicy) — 1 com veredito ruidoso e anti-patrao.
  patience: z.number().int().min(1).max(5).optional(),
  // Reflection estilo GEPA: variantes recebem licoes das falhas do campeao.
  feedbackDriven: z.boolean().optional(),
  // Reflexao GEPA por LLM (opt-in, §7.5): default deterministico (zero custo).
  reflection: z.enum(['off', 'deterministic', 'llm']).optional(),
  // ⚠️ Os campos do LAÇO abaixo existiam em TrainingConfig e o trainer os lia,
  // mas o zod os STRIPAVA (chave desconhecida) — CLI (`train --config`), MCP e
  // POST /sessions rodavam sempre com o default, enquanto a SPA os aplicava.
  // IMPL-062 (R-02b:REC-4): pool Pareto (>1 = população) e amostragem de pai
  // ∝ cobertura (feature-flag; só atua com fatias múltiplas e n ≥ 20).
  paretoPool: z.number().int().min(0).max(8).optional(),
  paretoCoverageSampling: z.boolean().optional(),
  // IMPL-060 (R-02b:REC-1): teto do dossiê de lições em TOKENS (≤ 4000) e o
  // gabarito no dossiê (default OFF — risco de exploração do juiz, R-03b).
  maxLessonTokens: z.number().int().min(200).max(4000).optional(),
  lessonsIncludeReference: z.boolean().optional(),
  // IMPL-065 (R-05:REC-4): piso de itens CURADOS (âncora humana) para declarar
  // campeão. Default 20 — proposta sem fonte (calibrar). 0 = não exige âncora.
  minCuratedItems: z.number().int().min(0).max(1000).optional(),
  ...baseFields,
});

export const runConfigSchema = z
  .preprocess(
    (val) => {
      if (!val || typeof val !== 'object') return val;
      const obj = { ...(val as Record<string, unknown>) };
      // compat: payloads antigos sem `mode` sao tratados como compare.
      if (obj.mode === undefined) obj.mode = 'compare';
      // compat: judgeModelId (string, legado) -> judgeModelIds (array).
      if (obj.judgeModelIds === undefined && typeof obj.judgeModelId === 'string') {
        obj.judgeModelIds = [obj.judgeModelId];
      }
      // Etapas manuais ditam a contagem: `stages` = nº de etapas fornecidas.
      // maxTokens ausente/invalido herda maxOutputTokens (ou 1000) — o competidor
      // faz Math.min(maxOutputTokens, stage.maxTokens) e undefined viraria NaN.
      if (Array.isArray(obj.customStages) && obj.customStages.length > 0) {
        obj.stages = obj.customStages.length;
        const fallback =
          typeof obj.maxOutputTokens === 'number' && obj.maxOutputTokens > 0
            ? obj.maxOutputTokens
            : 1000;
        obj.customStages = obj.customStages.map((s) => {
          if (s && typeof s === 'object') {
            const mt = (s as Record<string, unknown>).maxTokens;
            if (typeof mt !== 'number' || mt <= 0) {
              return { ...(s as Record<string, unknown>), maxTokens: fallback };
            }
          }
          return s;
        });
      }
      return obj;
    },
    z.discriminatedUnion('mode', [compareObj, variationObj, trainingObj]),
  )
  .superRefine((cfg, ctx) => {
    // ---------------------------------------------------------- rotulos (IMPL-003)
    // Rotulo esperado CURTO sem `labelSet` e erro de config (R-03b:DEC-4): sem o
    // conjunto de rotulos validos o verificador estrito nao reconhece a resposta
    // que lista/hesita entre rotulos. O CLI traduz em exit 3 (EXIT.CONFIG).
    for (const [campo, lista] of [
      ['customStages', cfg.customStages],
      ['scenarioSeed', cfg.scenarioSeed],
    ] as const) {
      for (const { index, message } of stageLabelIssues(lista)) {
        ctx.addIssue({
          code: 'custom',
          path: [campo, index, 'labelSet'],
          message: `etapa ${index + 1}: ${message}`,
        });
      }
    }

    // ------------------------------------------------------------ dado pessoal
    // LGPD (IMPL-042): um RunConfig CRU e importacao como qualquer outra — CLI
    // (`--config`, flags, `estimate`, `config validate`), MCP, HTTP (POST
    // /runs, /sessions, rotas de agente) e o arena-agent-config (que termina
    // aqui). MESMA regra do pre-voo do orquestrador: dado de aparencia real
    // bloqueia nomeando o campo — no "so sintetico" e no modo agente sem
    // excecao; no "redigir" ate a revisao explicita (`allowPii: true`).
    const pii = checkRunPii(cfg);
    if (runPiiRefusal(pii)) {
      ctx.addIssue({ code: 'custom', path: [], message: runPiiMessage(pii) });
    }

    // ------------------------------------------------------------------ agente
    // Validacoes do modo agente, ativas quando `config.agent` existe (qualquer
    // `mode` — o eixo runner e ortogonal ao mode).
    if (cfg.agent) {
      // 1. `maxCostUsd` OBRIGATORIO (§20.1). Sem teto nao ha estimativa, e sem
      // estimativa nao ha orcamento — a run seria aceita e gastaria o que quisesse.
      const maxCost = cfg.agent.limits?.maxCostUsd;
      if (!maxCost || maxCost <= 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['agent', 'limits', 'maxCostUsd'],
          message: 'maxCostUsd é obrigatório em modo agente (§20.1)',
        });
      }
      // 2. Toda etapa precisa de `agentTask` — sem ela nao ha tarefa executavel,
      // e cair em silencio para chat mediria outra coisa (§25). `stages` em si e
      // forcado na traducao (arenaConfig), nao exige aqui.
      for (const [campo, lista] of [
        ['customStages', cfg.customStages ?? []],
        ['scenarioSeed', cfg.scenarioSeed ?? []],
      ] as const) {
        const semTask = lista.findIndex((s) => !s.agentTask);
        if (semTask >= 0) {
          ctx.addIssue({
            code: 'custom',
            path: [campo, semTask],
            message: 'Em modo agente, toda etapa precisa de agentTask',
          });
        }
      }
      // 3. §29.10 — o modelo do agente nao pode julgar a propria trajetoria. Os
      // contestants (que em modo agente rodam como agentes) sao exatamente os
      // ids de `effectiveModelIds`; o checque judiz-nao-compete abaixo ja as cobre
      // para `compare`. Aqui reforcamos a mensagem para nao depender de interpretar.
      // (maxOutputTokens/#maxTokens NAO se aplicam ao agente — ele controla os
      // proprios tokens — entao nao os exigimos aqui; §29.11 mantem o campo para
      // o caso de a etapa rodar em modo chat tambem.)
    }

    // ------------------------------------------- papéis separados (IMPL-048, R-03a:REC-2)
    // A REFERÊNCIA (quem escreve o gabarito) não pode ser juiz nem competidor:
    // o mesmo modelo escrever a régua e julgar contra ela produz erros
    // CORRELACIONADOS que não se cancelam (DEC-2). Modelo igual => ERRO de
    // config; mesmo vendor/família => AVISO em `fairnessWarnings` (a validação
    // não bloqueia famílias — o mercado muda de vendor mais rápido que o schema).
    // IMPL-048: `referenceModelId` também é OBRIGATÓRIO em training/variation.
    // Em compare o default (1º juiz) continua existindo, explícito e documentado
    // + `fairnessWarnings` — mas train/vary sem referência própria reprova AQUI.
    // A regra é FONTE ÚNICA em src/engine/roleSeparation.ts (a SPA recusa com
    // ela no createRun/createSession e o formulário a mostra como pendência).
    for (const conflito of roleSeparationIssues(cfg)) {
      ctx.addIssue({ code: 'custom', path: [roleConflictField(conflito)], message: roleConflictMessage(conflito) });
    }

    // Gerador e juiz PODEM repetir o mesmo modelo (repeticao permitida).
    if (cfg.mode === 'compare') {
      // Eixo de competidores: competitorModelIds (classico) OU competitorConfigs
      // (compare-llms) — nunca ambos, nunca nenhum (>= 2 competidores efetivos).
      if (cfg.competitorModelIds && cfg.competitorConfigs) {
        ctx.addIssue({
          code: 'custom',
          path: ['competitorConfigs'],
          message: 'Use competitorConfigs OU competitorModelIds, nao ambos.',
        });
      }
      if (!cfg.competitorModelIds && !cfg.competitorConfigs) {
        ctx.addIssue({
          code: 'custom',
          path: ['competitorModelIds'],
          message: 'Informe ao menos 2 competidores (competitorModelIds ou competitorConfigs).',
        });
      }
      // Modelos efetivos no eixo: das ids simples e/ou das configs. Em configs o
      // MESMO modelo pode repetir (identidade = tripla modelo/temperatura/reasoning).
      const competitorIds = cfg.competitorModelIds ?? [];
      const configModelIds = (cfg.competitorConfigs ?? []).map((c) => c.modelId);
      const effectiveModelIds = [...competitorIds, ...configModelIds];
      if (cfg.competitorModelIds) {
        const dup = competitorIds.find((id, i) => competitorIds.indexOf(id) !== i);
        if (dup) {
          ctx.addIssue({
            code: 'custom',
            path: ['competitorModelIds'],
            message: `Competidor repetido: "${dup}". Cada competidor deve ser unico.`,
          });
        }
      }
      if (cfg.competitorConfigs) {
        // Dedup pela tripla + limites 2-12 + itens validos (o erro ja vem em PT-BR).
        const { error } = sanitizeLlmVariants(cfg.competitorConfigs);
        if (error) {
          ctx.addIssue({ code: 'custom', path: ['competitorConfigs'], message: error });
        }
      }
      if (effectiveModelIds.includes(cfg.datagenModelId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['datagenModelId'],
          message: 'O gerador de cenarios nao pode ser tambem um competidor.',
        });
      }
      const judgeAsCompetitor = cfg.judgeModelIds.find((id) => effectiveModelIds.includes(id));
      if (judgeAsCompetitor) {
        ctx.addIssue({
          code: 'custom',
          path: ['judgeModelIds'],
          message: `O juiz "${judgeAsCompetitor}" nao pode ser tambem um competidor.`,
        });
      }
    } else {
      // Multi-prompt (F2/P0.4): grupo com >1 prompt exige promptId valido —
      // sem ele o coordinate ascent nao sabe QUAL fragmento esta evoluindo.
      const grupoCheck = validatePromptGroup(cfg.promptGroup, cfg.promptId);
      if (!grupoCheck.ok) {
        ctx.addIssue({ code: 'custom', path: ['promptGroup'], message: grupoCheck.error! });
      }
      // variation | training: anti vies de auto-preferencia do juiz.
      if (cfg.judgeModelIds.includes(cfg.contestantModelId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['judgeModelIds'],
          message: 'Nenhum juiz pode ser o mesmo modelo sob teste (vies de auto-preferencia).',
        });
      }
      const optimize = cfg.promptOptimization !== false;
      const baseCount = cfg.basePrompt && cfg.basePrompt.trim() ? 1 : 0;
      if (optimize) {
        const techCount = cfg.techniqueIds?.length ?? 0;
        if (techCount + baseCount < 2) {
          ctx.addIssue({
            code: 'custom',
            path: ['techniqueIds'],
            message:
              'Selecione ao menos 2 tecnicas (ou 1 tecnica + prompt base) para ter contestants suficientes.',
          });
        }
      } else {
        const manualCount = (cfg.manualVariants ?? []).filter((v) => v.systemPrompt.trim()).length;
        if (manualCount + baseCount < 2) {
          ctx.addIssue({
            code: 'custom',
            path: ['manualVariants'],
            message:
              'Com otimizacao desligada, forneca ao menos 2 variantes (ou 1 variante + prompt base).',
          });
        }
      }
    }
  });

export type ParseRunConfigResult =
  | { ok: true; config: RunConfig }
  | { ok: false; error: string; details: z.core.$ZodFlattenedError<unknown> };

/**
 * Valida um RunConfig e devolve o erro ja ACHATADO em uma mensagem PT-BR — o
 * CLI nao deveria precisar importar o encanamento de erros do zod so para
 * imprimir "o que esta errado".
 */
/**
 * Campos de uma RunConfig que EXECUTAM comando nesta máquina (modo agente):
 * `agent` (o executor) e todo `agentTask` de etapa (setup[]/verify[]/rebuild/
 * solution — scripts do host). Lista vazia = config de chat, sem execução.
 *
 * As portas de entrada que aceitam RunConfig CRUA sem portão de execução
 * (`POST /v1/benchmark/{runs,sessions}`, MCP start_run/run_benchmark/
 * train_prompt, `--config` de compare/vary/train) RECUSAM config com qualquer
 * um destes: antes elas rodavam comando arbitrário do host sem o token/
 * isolamento do `/v1/agents` (§21.5) nem o pin SHA-256 do `agents run`
 * (IMPL-099). Modo agente entra SÓ pelos caminhos com portão.
 */
export function agentExecFields(config: unknown): string[] {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
  const c = config as Record<string, unknown>;
  const out: string[] = [];
  if (c.agent !== undefined && c.agent !== null) out.push('agent');
  for (const [key, value] of Object.entries(c)) {
    if (!Array.isArray(value)) continue;
    value.forEach((item, i) => {
      if (item && typeof item === 'object' && (item as Record<string, unknown>).agentTask != null) {
        out.push(`${key}[${i}].agentTask`);
      }
    });
  }
  return out;
}

/** Mensagem canônica da recusa (HTTP/MCP/CLI citam o caminho com portão). */
export function agentExecRefusalMessage(fields: readonly string[]): string {
  return (
    `Config de MODO AGENTE (${fields.slice(0, 3).join(', ')}${fields.length > 3 ? ', …' : ''}) não roda por aqui: ` +
    'setup[]/verify[] executam comandos nesta máquina e só entram pelo portão de execução — ' +
    '`prompt-builder agents run --config <arena-agent-config@1>` (revisão + SHA-256), a tool MCP ' +
    'run_agent_benchmark/start_run com arena-agent-config@1, ou POST /v1/agents/runs (token + isolamento).'
  );
}

export function parseRunConfig(input: unknown): ParseRunConfigResult {
  const parsed = runConfigSchema.safeParse(input);
  if (parsed.success) return { ok: true, config: parsed.data as RunConfig };

  const flat = parsed.error.flatten();
  const campos = Object.entries(flat.fieldErrors)
    .map(([campo, msgs]) => `${campo}: ${(msgs ?? []).join('; ')}`)
    .join(' | ');
  const gerais = flat.formErrors.join('; ');
  const error = [gerais, campos].filter(Boolean).join(' | ') || 'Config invalida.';
  return { ok: false, error, details: flat };
}
