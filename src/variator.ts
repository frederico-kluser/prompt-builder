import { z } from 'zod';
import { chatCompletion } from './openrouter.js';
import { isControlSignal } from './budget.js';
import { getTechnique, filterTechniquesForTarget, TECHNIQUE_LIBRARY, type TechniqueTarget, type TargetModelInfo } from './techniques.js';
import { modelFamily } from './llmVariants.js';
import { modelCaps } from './modelCaps.js';
import { extractPlaceholders, isInfraViolation, redactGuardSpans, stripFences } from './engine/contracts.js';
import { createContractGate } from './contractGate.js';
import type { ContractGate } from './contractGate.js';
import { MAX_TOKENS_REWRITER } from './engine/callCaps.js';
import { composePrompt, siblingsContext, targetFragment } from './engine/promptGroup.js';
import type { PromptGroup } from './engine/promptGroup.js';
import type { PromptContracts } from './engine/contracts.js';
import type { Contestant, ManualVariant, PromptTechnique, ReasoningLevel, RunCtx } from './types.js';

const variantSchema = z.object({ systemPrompt: z.string().min(1) });

/**
 * Versão do CONTRATO DO PAYLOAD do reescritor (IMPL-066/IMPL-070). Cada mudança
 * de estrutura do payload sobe a versão — o marcador `<payload_reescritor
 * versao="…">` viaja no próprio payload e é o que os snapshots/regexes dos
 * testes ancoram.
 *  - v1 = tema/técnica/lições/contrato/base (reescritor cego ao modelo-alvo);
 *  - v2 = v1 + `<modelo_alvo>` (modelId, família, think level de produção,
 *    capacidades do catálogo) + redação do conjunto de guarda.
 */
export const REWRITER_PAYLOAD_VERSION = 2;

// Meta-prompt do reescritor (portado do rewriter do prompt-arena): TEXTO PURO
// in/out, sem JSON — assim o prompt reescrito, cheio de backticks e quebras de
// linha, nao precisa sobreviver ao escaping de JSON na ida nem na volta.
export const REWRITER_SYSTEM_PROMPT = `Voce e um reescritor cirurgico de system prompts. Recebe um system prompt base (ou apenas um tema, quando nao houver base) e UMA tecnica de engenharia de prompt a aplicar.
Sua reescrita sera benchmarkada contra o prompt base atual — so uma variante genuinamente melhor vence.

REGRAS DURAS (violar qualquer uma torna a variante inutil — ela simplesmente pontua pior):
- Responda APENAS com o prompt reescrito. Sem preambulo, sem explicacao, sem comentarios, sem code fences.
- O texto e um drop-in replacement do prompt base, no mesmo papel.
- Seja CIRURGICO: mude APENAS o que a tecnica pede e o que as licoes expoem; preserve o SIGNIFICADO de todas as demais regras intacto (reformular por clareza vale; remover ou enfraquecer uma regra, nao). Evite inchar o prompt — mudanca fora do escopo esconde se a tecnica ajudou.
- NAO adicione exemplos few-shot a menos que a tecnica peca explicitamente.
- Mantenha o idioma do prompt base.
- NAO responda a tarefa do usuario; apenas reescreva o system prompt.`;

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) return match[1].trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

export interface GenerateContestantsParams {
  apiKey: string;
  /** O unico modelo sob teste (eixo contestant). */
  modelId: string;
  theme: string;
  /** Base de derivacao das variantes (variation: base do usuario; treino i>0: vencedora). */
  basePrompt?: string;
  /** Prompt original do usuario, rodado como controle quando includeOriginal. */
  originalPrompt?: string;
  /** Melhor da iteracao anterior, re-testado verbatim (treino i>0). */
  carryPrompt?: string;
  carryLabel?: string;
  carryParentId?: string;
  includeOriginal: boolean;
  techniqueIds?: string[];
  manualVariants?: ManualVariant[];
  /** Liga/desliga a geracao por LLM. Off => usa manualVariants/base verbatim. */
  promptOptimization: boolean;
  /** Meta-modelo que reescreve os prompts. */
  optimizerModelId: string;
  /** Aprendizados da iteracao anterior (treino) injetados na geracao. */
  analysisHint?: string;
  /** Nivel de raciocinio do papel "rewriter" (RunConfig.reasoning.rewriter). */
  reasoningLevel?: ReasoningLevel;
  /**
   * Niveis de raciocinio das verificacoes do contrato: juiz do diff
   * (`RunConfig.reasoning.judge`) e canarios no modelo sob teste
   * (`RunConfig.reasoning.competitor`). Ausentes = default do provedor.
   */
  contractJudgeReasoningLevel?: ReasoningLevel;
  contestantReasoningLevel?: ReasoningLevel;
  /**
   * IMPL-066 (R-20:REC-2): capacidades do modelo SOB TESTE, direto do catálogo
   * (`supported_parameters` + `reasoning` parseados). Filtra as técnicas
   * classe-dependentes ANTES da reescrita e informa o reescritor no payload.
   * Ausente = sem metadados (só o think level decide).
   */
  targetModel?: TargetModelInfo;
  /**
   * IMPL-069 (R-21:REC-2/REC-3): conjunto de guarda — cenários de segurança
   * INVISÍVEIS ao otimizador. Nenhum trecho deles pode entrar no payload do
   * reescritor (lições/demos que os citem são redigidos antes de enviar).
   */
  guardScenarios?: string[];
  /**
   * Contratos never-break do prompt base (F2/P0.3 + IMPL-011): a reescrita
   * passa pelo gate de 3 camadas (`contractGate.ts`: regras locais → juiz LLM
   * do diff → canários) — violação tenta UMA correção; persistindo, a variante
   * é rejeitada.
   */
  contracts?: PromptContracts;
  /**
   * Juiz do diff (camada 2 do contrato). Os chamadores passam o 1º juiz da run
   * (`judgeModelIds[0]`): o reescritor julgando a própria reescrita tende a se
   * aprovar. Ausente = `optimizerModelId`.
   */
  contractJudgeModelId?: string;
  /**
   * Multi-prompt (F2/P0.4, coordinate ascent): grupo de fragmentos + qual deles
   * esta sendo evoluido. Com grupo, a variante gerada e o FRAGMENTO; o
   * systemPrompt efetivo do contestant e a composicao (irmaos congelados).
   */
  promptGroup?: PromptGroup;
  promptId?: string;
  /**
   * Runner dos contestants gerados. 'agent' quando a run e de agente
   * (`config.agent` presente): sem isso o treino com agente rodaria as
   * iteracoes (e o holdout) como CHAT em silencio (§29.2). Ausente/undefined
   * mantém o comportamento de chat intacto.
   */
  runner?: 'chat' | 'agent';
  timeoutMs?: number;
  /** Sinal de abort + ledger de custo. */
  ctx?: RunCtx;
  maxPricePerMTok?: { prompt?: number; completion?: number };
}

/** Texto-sentinela do base quando a variante nasce só do tema. */
const NO_BASE_TEXT = 'Não há prompt base — escreva um prompt completo do zero sobre o tema.';

/** Fração default do base que a reescrita precisa preservar (espelha engine/contracts.ts). */
const DEFAULT_MIN_LENGTH_RATIO = 0.3;

/**
 * IMPL-071 (R-20:REC-6): o piso de tamanho é medido contra o prompt ORIGINAL
 * da sessão, nunca contra o pai da iteração. O `verifyRewrite` calcula o piso
 * como `base.length × minLengthRatio` sobre o base que o gate conhece — o PAI
 * da reescrita —, e como cada pai é derivado do anterior o piso composto
 * encolhia 0,3^k por rodada (3000→900→270→81): somado ao desempate "o mais
 * curto vence", o mecanismo premiava quem APAGA texto (inclusive cláusulas
 * defensivas que o gate substring não protege). Ajustar a razão faz o piso
 * valer `original.length × ratio` em TODA iteração — o encolhimento acumulado
 * da sessão fica limitado a `minLengthRatio` do original.
 */
export function contractsAgainstOriginal(
  contracts: PromptContracts | undefined,
  originalText: string | undefined,
  parentText: string,
): PromptContracts | undefined {
  const bruto = contracts?.minLengthRatio;
  const ratio =
    typeof bruto === 'number' && Number.isFinite(bruto) && bruto >= 0 ? bruto : DEFAULT_MIN_LENGTH_RATIO;
  const originalLen = (originalText ?? '').length;
  const parentLen = parentText.length;
  // Sem original ou sem pai o verifyRewrite já usa o piso absoluto (40 chars).
  if (originalLen <= 0 || parentLen <= 0 || originalLen === parentLen) return contracts;
  return { ...contracts, minLengthRatio: (ratio * originalLen) / parentLen };
}

/** Base de derivação: o base do usuário ou (multi-prompt) o texto atual do fragmento-alvo. */
function derivationBase(p: GenerateContestantsParams): string {
  return (
    p.basePrompt?.trim() ||
    (p.promptGroup ? (targetFragment(p.promptGroup, p.promptId)?.text ?? '') : '')
  );
}

/**
 * Bloco do contrato para o REESCRITOR (antes ele só descobria o contrato
 * depois de violá-lo, na correção): invariantes e placeholders que o gate vai
 * cobrar. Vazio quando não há nada a preservar.
 */
function contractBlock(p: GenerateContestantsParams, baseText: string): string {
  const invariantes = (p.contracts?.neverBreak ?? []).filter((s) => typeof s === 'string' && s.trim());
  const placeholders = Array.isArray(p.contracts?.placeholders)
    ? p.contracts.placeholders.filter((s) => typeof s === 'string' && s)
    : extractPlaceholders(baseText);
  if (!invariantes.length && !placeholders.length) return '';
  const linhas: string[] = [];
  if (invariantes.length) {
    linhas.push(
      'Invariantes (mantenha cada uma LITERALMENTE e com a MESMA forca — sem acrescentar excecao, condicao, atenuante ou regra que a anule):',
      ...invariantes.map((s) => `- ${s}`),
    );
  }
  if (placeholders.length) {
    linhas.push(`Placeholders (copie exatamente como estao): ${placeholders.join(' ')}`);
  }
  return `\n<contrato_never_break>\n${linhas.join('\n')}\n</contrato_never_break>\n`;
}

/**
 * Bloco `<modelo_alvo>` do payload (IMPL-066, R-20:REC-2/DEC-2): o reescritor
 * deixa de ser cego ao modelo de produção — recebe o modelId, a FAMÍLIA e o
 * THINK LEVEL de produção do modelo sob teste, mais as capacidades do catálogo
 * (supported_parameters/reasoning: mandatory, degraus aceitos). Com isso a
 * regra da técnica `cot` ("nao acrescente CoT se o modelo ja for de raciocinio")
 * finalmente tem como ser cumprida. O texto reescrito continua PORTÁVEL: só o
 * classe-dependente (cot/fewshot/selfcritique/stepback) é condicionado.
 */
function targetModelBlock(p: GenerateContestantsParams): string {
  const caps = modelCaps(p.targetModel);
  const nivel = p.contestantReasoningLevel ?? 'default-do-provedor';
  const linhas = [
    `Modelo em producao (o que vai rodar o prompt reescrito): ${p.modelId} (familia ${modelFamily(p.modelId)}).`,
    `Nivel de raciocinio em producao: ${nivel}.`,
  ];
  if (p.targetModel) {
    const capacidades = [
      caps.mandatory ? 'raciocinio OBRIGATORIO (nao da para desligar)' : 'raciocinio opcional',
      caps.supportedEfforts?.length
        ? `degraus de esforco aceitos: ${caps.supportedEfforts.join(', ')}`
        : 'sem allowlist de degraus declarada',
    ];
    if (caps.defaultEffort) capacidades.push(`esforco default do catalogo: ${caps.defaultEffort}`);
    linhas.push(`Capacidades do catalogo: ${capacidades.join('; ')}.`);
  }
  linhas.push(
    'Use este contexto APENAS para decidir o que e dependente da classe do modelo ' +
      '(raciocinio passo a passo, exemplos, autocritica, step-back): o texto reescrito deve permanecer ' +
      'PORTAVEL para outros modelos, sem citar o modelo nem o nivel de raciocinio no prompt final.',
  );
  return `<modelo_alvo>\n${linhas.join('\n')}\n</modelo_alvo>\n`;
}

/**
 * Payload do reescritor — CONTRATO VERSIONADO (IMPL-070/IMPL-066,
 * {@link REWRITER_PAYLOAD_VERSION}). Extraído como função pura para os
 * snapshots de mensagem por papel (R-05:REC-3) ancorarem a montagem.
 */
export function buildRewriterUserPrompt(input: {
  theme: string;
  technique: PromptTechnique;
  baseText: string;
  lessonsBlock?: string;
  siblingsBlock?: string;
  contractBlock?: string;
  targetModelBlock?: string;
}): string {
  return `<payload_reescritor versao="${REWRITER_PAYLOAD_VERSION}">
${input.targetModelBlock ?? ''}<contexto_da_tarefa>
${input.theme}
</contexto_da_tarefa>
${input.siblingsBlock ?? ''}<tecnica id="${input.technique.id}" nome="${input.technique.name}">
<quando_ajuda>${input.technique.good}</quando_ajuda>
<cuidado>${input.technique.bad}</cuidado>
<instrucao>${input.technique.metaInstruction}</instrucao>
</tecnica>
${input.lessonsBlock ?? ''}${input.contractBlock ?? ''}<prompt_base>
${input.baseText}
</prompt_base>
</payload_reescritor>

Reescreva o prompt agora, aplicando a tecnica.`;
}

async function generateOneVariant(
  p: GenerateContestantsParams,
  technique: PromptTechnique,
  gate: ContractGate,
): Promise<string | null> {
  const lessonsBlock = p.analysisHint?.trim()
    ? `\n<licoes_da_iteracao_anterior>\n${p.analysisHint.trim()}\n</licoes_da_iteracao_anterior>\n`
    : '';
  // Multi-prompt: o ALVO da reescrita e o fragmento (nunca o composto); sem
  // basePrompt, o texto atual do fragmento no grupo vira base.
  const baseText = derivationBase(p) || NO_BASE_TEXT;

  const irmaosBlock = p.promptGroup
    ? (() => {
        const ctx = siblingsContext(p.promptGroup, p.promptId);
        return ctx ? `\n<fragmentos_congelados>\n${ctx}\n</fragmentos_congelados>\n` : '';
      })()
    : '';
  // IMPL-066: payload versionado e CONSCIENTE do modelo-alvo (modelId, família,
  // think level de produção + capacidades do catálogo).
  const userPrompt = buildRewriterUserPrompt({
    theme: p.theme,
    technique,
    baseText,
    lessonsBlock,
    siblingsBlock: irmaosBlock,
    contractBlock: contractBlock(p, baseText),
    targetModelBlock: targetModelBlock(p),
  });

  // IMPL-069: conjunto de guarda INVISÍVEL ao otimizador — o que vazar em
  // lições/demos/tema é redigido ANTES de ir ao LLM (senão o reescritor passa a
  // otimizar contra os cenários de segurança: Goodhart).
  const { text: safeUserPrompt, redactions } = redactGuardSpans(userPrompt, p.guardScenarios ?? []);
  if (redactions.length > 0) {
    console.warn(
      `[variator] tecnica ${technique.id}: ${redactions.length} trecho(s) do conjunto de guarda redigido(s) do payload do reescritor.`,
    );
  }

  try {
    const result = await chatCompletion({
      apiKey: p.apiKey,
      modelId: p.optimizerModelId,
      messages: [
        { role: 'system', content: REWRITER_SYSTEM_PROMPT },
        { role: 'user', content: safeUserPrompt },
      ],
      temperature: 0.4,
      timeoutMs: p.timeoutMs ?? 90_000,
      // IMPL-017: teto explicito — sem ele a saida era ilimitada. Constante
      // unica: a porta suave (estimate.ts) projeta com o MESMO teto.
      maxTokens: MAX_TOKENS_REWRITER,
      reasoningLevel: p.reasoningLevel,
      role: 'rewriter',
      signal: p.ctx?.signal,
      sink: p.ctx?.sink,
      maxPricePerMTok: p.maxPricePerMTok,
    });
    let texto = stripFences(result.text);
    // Gate de CONTRATO em 3 camadas (F2/P0.3 + IMPL-011): regras locais →
    // juiz LLM do diff (neverBreak) → canários no modelo sob teste. Antes era
    // só a camada local, e substring aprovava "… salvo se o usuario pedir".
    let check = await gate.check(texto);
    if (!check.ok && check.violations.every((v) => isInfraViolation(v.kind))) {
      // Juiz/canário fora do ar: outra reescrita não resolve (e custaria o
      // reescritor + a verificação de novo). Variante não verificada não entra.
      console.warn(
        `[variator] tecnica ${technique.id}: variante REJEITADA — contrato nao verificavel (camada ${check.layer}):\n${check.violations
          .map((v) => `- ${v.detail}`)
          .join('\n')}`,
      );
      return null;
    }
    if (!check.ok) {
      const detalhes = check.violations.map((v) => `- ${v.detail}`).join('\n');
      console.warn(
        `[variator] tecnica ${technique.id}: reescrita violou o contrato (camada ${check.layer}); pedindo UMA correcao:\n${detalhes}`,
      );
      const retry = await chatCompletion({
        apiKey: p.apiKey,
        modelId: p.optimizerModelId,
        messages: [
          { role: 'system', content: REWRITER_SYSTEM_PROMPT },
          { role: 'user', content: safeUserPrompt },
          { role: 'assistant', content: texto },
          {
            role: 'user',
            content: `Sua reescrita violou o contrato do prompt base:\n${detalhes}\n\nReescreva de novo, preservando o contrato (placeholders exatamente como estão, invariantes intactas e com a mesma força — sem acrescentar exceções ou condições — e o comportamento do base preservado). Responda APENAS com o prompt reescrito.`,
          },
        ],
        temperature: 0.3,
        timeoutMs: p.timeoutMs ?? 90_000,
        maxTokens: MAX_TOKENS_REWRITER, // IMPL-017
        reasoningLevel: p.reasoningLevel,
        role: 'rewriter',
        signal: p.ctx?.signal,
        sink: p.ctx?.sink,
        maxPricePerMTok: p.maxPricePerMTok,
      });
      texto = stripFences(retry.text);
      check = await gate.check(texto);
      if (!check.ok) {
        console.warn(
          `[variator] tecnica ${technique.id}: variante REJEITADA — contrato quebrado mesmo apos correcao (camada ${check.layer}: ${check.violations
            .map((v) => v.kind)
            .join(', ')})`,
        );
        return null;
      }
    }
    return texto;
  } catch (err) {
    // Sem o rethrow, orcamento estourado produziria uma lista de variantes
    // menor do que o pedido — o treino "converge" por falta de candidatos.
    if (isControlSignal(err)) throw err;
    console.warn(`[variator] tecnica ${technique.id} falhou: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Resolve a lista de contestants de uma run de variacao/treino:
 * (controle original) + (carry da vencedora anterior) + (variantes geradas/manuais).
 * Garante ids unicos. Pode retornar menos do que o pedido se variantes falharem —
 * o chamador deve exigir >= 2 contestants.
 */
export async function generateContestants(
  p: GenerateContestantsParams,
): Promise<Contestant[]> {
  const contestants: Contestant[] = [];
  // Multi-prompt (F2/P0.4): com grupo, o contestant carrega o FRAGMENTO em
  // `promptFragment` (o que o treino evolui/reusa) e o COMPOSTO em
  // `systemPrompt` (o que o modelo sob teste recebe — irmaos congelados junto).
  const compor = (fragmento: string): { systemPrompt: string; promptFragment?: string } =>
    p.promptGroup
      ? {
          systemPrompt: composePrompt(p.promptGroup, p.promptId, fragmento),
          promptFragment: fragmento,
        }
      : { systemPrompt: fragmento };

  // Runner de agente (quando `config.agent` presente). Sem isso os contestants
  // de uma run de agente sairiam com runner indefinido (= chat) e o treino
  // mediria respostas de chat em PASSO de agente, sem erro nenhum (§29.2).
  const stampRunner = (): void => {
    if (p.runner && p.runner !== 'chat') {
      for (const c of contestants) c.runner = p.runner;
    }
  };

  // 1) Controle: o prompt original do usuario (sempre, quando fornecido e pedido).
  const original =
    (p.originalPrompt ?? p.basePrompt)?.trim() ??
    (p.promptGroup ? (targetFragment(p.promptGroup, p.promptId)?.text ?? '') : '');
  if (p.includeOriginal && original) {
    contestants.push({
      id: 'original',
      label: 'Original (controle)',
      modelId: p.modelId,
      ...compor(original),
      isOriginal: true,
    });
  }

  // 2) Carry: a melhor da iteracao anterior, re-testada verbatim (treino i>0).
  if (p.carryPrompt?.trim()) {
    contestants.push({
      id: 'carry',
      label: p.carryLabel ?? 'Melhor anterior',
      modelId: p.modelId,
      ...compor(p.carryPrompt.trim()),
      parentContestantId: p.carryParentId,
    });
  }

  // 3) Variantes.
  if (!p.promptOptimization) {
    // Toggle OFF: variantes manuais verbatim (sem LLM).
    (p.manualVariants ?? []).forEach((v, i) => {
      const sp = v.systemPrompt.trim();
      if (!sp) return;
      contestants.push({
        id: `m${i}`,
        label: v.label?.trim() || `Variante ${i + 1}`,
        modelId: p.modelId,
        ...compor(sp),
      });
    });
    stampRunner();
    return contestants;
  }

  // Toggle ON: gera uma variante por tecnica selecionada (em paralelo).
  // IMPL-066 (R-20:REC-2): ANTES da reescrita, filtra as técnicas
  // classe-dependentes pelo modelo-alvo (think level de produção + capacidades
  // do catálogo) — nada de chamada paga para variante redundante em modelo de
  // raciocínio (cot/fewshot/selfcritique/stepback degradam lá).
  const alvo: TechniqueTarget = {
    modelId: p.modelId,
    thinkLevel: p.contestantReasoningLevel,
    catalogModel: p.targetModel,
  };
  const { kept, dropped } = filterTechniquesForTarget(p.techniqueIds ?? [], alvo);
  if (dropped.length > 0) {
    console.warn(
      `[variator] ${dropped.length} tecnica(s) classe-dependente(s) NAO proposta(s) para o modelo-alvo ${p.modelId}: ` +
        dropped.map((d) => `${d.id} (${d.reason})`).join('; '),
    );
  }
  const techniques = kept
    .map((id) => getTechnique(id))
    .filter((t): t is PromptTechnique => Boolean(t));
  if (techniques.length === 0) {
    // Nada a reescrever (tudo filtrado ou ids desconhecidos): não monta gate nem
    // roda baseline de canário — zero custo.
    stampRunner();
    return contestants;
  }

  // UM gate por lote: a baseline dos canários no base roda uma vez só e vale
  // para todas as técnicas (e para a correção de cada uma).
  const baseRef = derivationBase(p);
  const gate = createContractGate({
    apiKey: p.apiKey,
    // IMPL-071: o piso de tamanho é contra o ORIGINAL da sessão (não contra o
    // pai da iteração, cujo piso composto encolhe 0,3^k por rodada).
    contracts: contractsAgainstOriginal(p.contracts, p.originalPrompt ?? p.basePrompt, baseRef),
    baseText: baseRef || NO_BASE_TEXT,
    hasBase: Boolean(baseRef),
    compose: p.promptGroup
      ? (fragmento) => composePrompt(p.promptGroup!, p.promptId, fragmento)
      : undefined,
    judgeModelId: p.contractJudgeModelId || p.optimizerModelId,
    contestantModelId: p.modelId,
    judgeReasoningLevel: p.contractJudgeReasoningLevel,
    contestantReasoningLevel: p.contestantReasoningLevel,
    runner: p.runner,
    timeoutMs: p.timeoutMs,
    ctx: p.ctx,
    maxPricePerMTok: p.maxPricePerMTok,
  });
  const results = await Promise.all(techniques.map((t) => generateOneVariant(p, t, gate)));
  results.forEach((systemPrompt, i) => {
    if (!systemPrompt) return;
    const t = techniques[i];
    contestants.push({
      id: `v${i}`,
      label: t.name,
      modelId: p.modelId,
      ...compor(systemPrompt),
      techniqueId: t.id,
      parentContestantId: p.carryParentId,
    });
  });

  stampRunner();
  return contestants;
}

// ---------------------------------------------------------------------------
// Geracao de PROMPT BASE a partir de uma descricao de tarefa (opcional no
// assistente). O prompt gerado preenche o campo do prompt base — que sempre
// roda como CONTROLE/original no treino.
// ---------------------------------------------------------------------------

export interface GenerateBasePromptParams {
  apiKey: string;
  /** Modelo que redige o prompt (reusa o gerador/optimizer do assistente). */
  modelId: string;
  /** O que o usuario descreveu que a tarefa precisa fazer. */
  taskDescription: string;
  /** Contexto/tema extra opcional. */
  theme?: string;
  timeoutMs?: number;
  ctx?: RunCtx;
}

export const BASE_GENERATION_SYSTEM_PROMPT = `Voce e um engenheiro de prompts senior. Recebe a DESCRICAO de uma tarefa e produz um SYSTEM PROMPT completo e reutilizavel para um assistente que executa essa tarefa.
NAO responda a tarefa; escreva APENAS o system prompt (instrucoes para o assistente), pronto para uso, claro e conciso.
Saida ESTRITAMENTE em JSON valido, sem markdown, sem comentarios: {"systemPrompt":"<system prompt completo>"}`;

/**
 * Gera um system prompt base a partir de uma descricao em linguagem natural.
 * Lanca erro (mensagem PT-BR) se o modelo nao devolver um prompt valido.
 */
export async function generateBasePrompt(p: GenerateBasePromptParams): Promise<string> {
  const themeBlock = p.theme?.trim() ? `\n\nCONTEXTO/TEMA:\n${p.theme.trim()}` : '';
  const userPrompt = `DESCRICAO DA TAREFA:\n${p.taskDescription.trim()}${themeBlock}\n\nDevolva o JSON {"systemPrompt":"..."}.`;

  const result = await chatCompletion({
    apiKey: p.apiKey,
    modelId: p.modelId,
    messages: [
      { role: 'system', content: BASE_GENERATION_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.4,
    timeoutMs: p.timeoutMs ?? 90_000,
    maxTokens: MAX_TOKENS_REWRITER, // IMPL-017
    responseFormatJson: true,
    role: 'rewriter',
    signal: p.ctx?.signal,
    sink: p.ctx?.sink,
  });

  let parsed;
  try {
    parsed = variantSchema.safeParse(JSON.parse(extractJson(result.text)));
  } catch {
    throw new Error('Nao consegui interpretar a resposta do modelo como JSON. Tente novamente.');
  }
  if (!parsed.success) {
    throw new Error('O modelo nao devolveu um system prompt valido. Tente novamente.');
  }
  const sp = parsed.data.systemPrompt.trim();
  if (!sp) throw new Error('O modelo devolveu um system prompt vazio.');
  return sp;
}

// ---------------------------------------------------------------------------
// Reflexao GEPA POR LLM (opt-in, F2 §7.5). O default continua deterministico
// (`buildLessons`, zero custo); aqui um meta-modelo REESCREVE as licoes num
// bloco mais denso e acionavel para o reescritor da proxima rodada. Cada chamada
// e contada no ledger como papel 'rewriter' — dinheiro medido, nunca inferido.
// ---------------------------------------------------------------------------

export const REFLECT_SYSTEM_PROMPT = `Voce e um meta-otimizador de prompts (reflexao estilo GEPA). Recebe as FRAQUEZAS observadas ao benchmarkar um prompt e produz um bloco de licoes ACIONAVEL e conciso para o reescritor de prompts da proxima rodada.

Regras:
- Responda APENAS com o bloco de licoes (texto puro, sem preambulo, sem code fences).
- Maximo ~1500 caracteres. Frases curtas e imperativas.
- Agrupe PADROES (ex.: "falha sempre que a pergunta traz pressuposto falso") em vez de listar casos isolados.
- NAO invente fraquezas nao observadas; NAO proponha mudancas que quebrem o contrato do prompt.`;

export interface ReflectLessonsParams {
  apiKey: string;
  /** Meta-modelo que reescreve as licoes (no treino: o optimizer). */
  modelId: string;
  /** Licoes deterministicas (buildLessons) — materia-prima da reflexao. */
  baseLessons: string;
  /** Tema da run (contexto para o meta-modelo). */
  theme?: string;
  reasoningLevel?: ReasoningLevel;
  timeoutMs?: number;
  /** Sinal de abort + ledger de custo. */
  ctx?: RunCtx;
  maxPricePerMTok?: { prompt?: number; completion?: number };
  /**
   * IMPL-060: teto do bloco REESCRITO em caracteres (default 4000). A entrada
   * agora é o dossiê completo (pergunta/resposta/explicação integrais); a saída
   * continua compacta de propósito — reflexão é síntese, não cópia.
   */
  maxChars?: number;
}

/**
 * Reescreve as licoes deterministicas num bloco acionavel. Lanca erro (o
 * chamador degrada para as licoes deterministicas) — nunca derruba a iteracao.
 */
/**
 * Liga as lições das falhas (GEPA) na próxima iteração? `feedbackDriven: false`
 * OU `reflection: 'off'` desligam (types.ts documenta 'off' == feedbackDriven
 * false). Antes nenhum motor lia o 'off': as lições entravam mesmo assim, e o
 * import da SPA o rotulava como "aplicado" (IMPL-045). Fonte única dos dois trainers.
 */
export function lessonsEnabled(cfg: {
  feedbackDriven?: boolean;
  reflection?: 'off' | 'deterministic' | 'llm';
}): boolean {
  return cfg.feedbackDriven !== false && cfg.reflection !== 'off';
}

export async function llmReflectLessons(p: ReflectLessonsParams): Promise<string> {
  const userPrompt = `${p.theme?.trim() ? `TEMA DA RUN: ${p.theme.trim()}\n\n` : ''}FRAQUEZAS OBSERVADAS:
${p.baseLessons}

Produza o bloco de licoes para a proxima rodada de reescrita.`;

  const result = await chatCompletion({
    apiKey: p.apiKey,
    modelId: p.modelId,
    messages: [
      { role: 'system', content: REFLECT_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
    timeoutMs: p.timeoutMs ?? 90_000,
    maxTokens: MAX_TOKENS_REWRITER, // IMPL-017
    reasoningLevel: p.reasoningLevel,
    role: 'rewriter',
    signal: p.ctx?.signal,
    sink: p.ctx?.sink,
    maxPricePerMTok: p.maxPricePerMTok,
  });

  const texto = result.text.trim();
  if (!texto) throw new Error('Reflexao LLM devolveu bloco vazio.');
  return texto.slice(0, Math.max(200, Math.floor(p.maxChars ?? 4000)));
}

// ---------------------------------------------------------------------------
// Meta-prompts embutidos POR PAPEL (IMPL-070, R-20:REC-8/M-120).
//
// Antes só o prompt do juiz entrava no hash de contrato da run: editar o
// meta-prompt do reescritor, da reflexão ou as instruções das técnicas mudava o
// comportamento de TODAS as sessões seguintes sem rastro (duas sessões de treino
// com meta-prompts diferentes ficavam comparáveis por acaso). Este mapa é a
// entrada do `metaPromptsFingerprint` (`src/engine/contracts.ts`) que o hash de
// contrato da run cobre junto com o pin do juiz: qualquer edição de texto muda o
// fingerprint (os snapshots de mensagem por papel acusam a mudança).
// `datagen`/`gabarito`/juízes vivem nos próprios módulos e entram no mapa pelos
// chamadores (orchestrator/trainer), que são quem monta o pin.
// ---------------------------------------------------------------------------

/** Papel → texto do meta-prompt embutido (chaves estáveis, ordenadas no hash). */
export function metaPromptTexts(): Record<string, string> {
  return {
    'rewriter/system': REWRITER_SYSTEM_PROMPT,
    'rewriter/generate-base': BASE_GENERATION_SYSTEM_PROMPT,
    'reflection/system': REFLECT_SYSTEM_PROMPT,
    'techniques/meta-instructions': TECHNIQUE_LIBRARY.map((t) => `${t.id}\u0001${t.metaInstruction}`).join(
      '\u0002',
    ),
  };
}
