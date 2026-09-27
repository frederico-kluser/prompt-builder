const randomUUID = (): string => crypto.randomUUID();
import { runToCompletion } from './orchestrator';
import { listModels } from './openrouter';
import { enforceRunCompliance } from '../lgpd';
import { generateContestants, lessonsEnabled, llmReflectLessons } from './variator';
import { composePrompt } from '../../../src/engine/promptGroup.js';
import { addToPool, pickParent, sliceScores, type ParetoEntry } from '../../../src/engine/pareto.js';
import {
  judgeIdentity,
  judgeIdentityChanged,
  mergeJudgeIdentity,
  type JudgeIdentity,
} from '../../../src/engine/modelLifecycle.js';
import { seedFromId } from '../../../src/engine/duelCore.js';
import {
  pickReevalMinibatch,
  reevalDecision,
  shouldStopForPatience,
  techniquesForIteration,
  TRAINING_PATIENCE,
} from '../../../src/engine/trainingPolicy.js';
import { emitSessionEvent } from './events';
import { saveSession } from './storage';
import { acquireLock } from './runLocks';
import { computeMedals } from './medals';
import { judgeScoreFromVerdicts, pickWinner, promotionEventFields, type RankEntry } from './rank';
import { MIN_HOLDOUT_SCENARIOS, splitHoldout } from './holdout';
import { pairCoverage, pairedStageScores, stageScoresByContestant } from './stats';
import { formatIterationGate, pairedSignificance, VERDICT_SCORE } from './stats';
import { BudgetLedger, isControlSignal, RunCancelled } from './budget';
import { estimateInputFromConfig, estimateRunCost, makeCallEstimator } from './estimate';
import { mergeFailureCounts } from '../../../src/engine/verdictIntegrity.js';
import type {
  Contestant,
  IterationGate,
  PromotionReeval,
  RunCtx,
  RunRecord,
  SessionRecord,
  StageSpec,
  TrainingConfig,
  VariationConfig,
} from './types';

function nowIso(): string {
  return new Date().toISOString();
}

function log(sessionId: string, msg: string): void {
  console.log(`[train ${sessionId}] ${msg}`);
}

/** Campeao corrente do treino (prompt + rotulo + o id que tinha na run em que venceu). */
interface Champion {
  contestantId: string;
  systemPrompt: string;
  label: string;
}

/**
 * Judge-score 0-100 do contestant na run. Usa o agregado do orchestrator
 * (preenchido quando houve juiz de referencia); em runs legadas, sem
 * `judgeScoreByContestant`, cai nos vereditos listwise dos estagios
 * (`stage.judge.verdictByContestant`).
 */
function judgeScoreOf(run: RunRecord, contestantId: string): number {
  const agg = run.judgeScoreByContestant?.[contestantId];
  if (agg !== undefined) return agg;
  return judgeScoreFromVerdicts(
    run.stages.map(
      (s) =>
        s.referenceJudge?.verdictByContestant?.[contestantId] ??
        s.judge?.verdictByContestant?.[contestantId],
    ),
  );
}

/** Placement medio do contestant nos estagios COM duelo (undefined se nenhum duelo). */
function meanPlacementOf(run: RunRecord, contestantId: string): number | undefined {
  const placements = run.stages
    .map((s) => s.duels?.placementByContestant?.[contestantId])
    .filter((p): p is number => p !== undefined);
  if (!placements.length) return undefined;
  return placements.reduce((sum, p) => sum + p, 0) / placements.length;
}

/**
 * Monta as entradas do ranking de selecao (port do evolve.mjs do prompt-arena).
 * `controlId` e a REGUA desta iteracao ('original' na 0, 'carry' nas demais):
 * ela nao disputa o titulo, entao seu promptLen e zerado — o desempate por
 * tamanho so vale entre candidatas.
 */
function buildRankEntries(run: RunRecord, controlId: string): RankEntry[] {
  return run.contestants.map((c) => {
    const isControl = c.id === controlId;
    let errored = 0;
    for (const s of run.stages) {
      for (const r of s.responses) {
        if (r.contestantId === c.id && r.status === 'error') errored++;
      }
    }
    return {
      id: c.id,
      label: c.label,
      isControl,
      judgeScore: judgeScoreOf(run, c.id),
      meanPlacement: meanPlacementOf(run, c.id),
      errored,
      promptLen: isControl ? 0 : (c.systemPrompt ?? '').length,
    };
  });
}

const LESSONS_PREFIX =
  'Fraquezas observadas ao benchmarkar o prompt base ATUAL. Enderece-as SEM quebrar o contrato de saida:\n';

/**
 * Reflection estilo GEPA (port do evolve.mjs): SUBSTITUI a antiga analise por
 * LLM (`analyzeIteration`, removida — a analise deixou de ser uma etapa do
 * pipeline, e o evento `iteration.analyzing` nao e mais emitido; o tipo
 * permanece em types.ts apenas para sessoes antigas). As licoes sao montadas
 * DETERMINISTICAMENTE das falhas do campeao na ultima run: ate 8 estagios em
 * que o veredito nao foi 'resolve', com cap de 4000 chars no total. O variator
 * injeta o resultado em `<licoes_da_iteracao_anterior>`.
 */
export function buildLessons(run: RunRecord, championId: string): string {
  const items: string[] = [];
  for (const s of run.stages) {
    if (items.length >= 8) break;
    const verdict =
      s.referenceJudge?.verdictByContestant?.[championId] ??
      s.judge?.verdictByContestant?.[championId];
    if (verdict === 'resolve') continue;
    const motivo = (
      s.referenceJudge?.explanationByContestant?.[championId] ??
      (s.judge?.judges ?? [])
        .map((j) => j.verdicts.find((v) => v.contestantId === championId)?.motivo)
        .find((m) => m && m.trim()) ??
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    // Veredito AUSENTE (juiz que falhou, competidor com erro de infra/bloqueado
    // — IMPL-004) NUNCA vira licao: o motivo dele descreve o PIPELINE, nao uma
    // fraqueza do campeao, e a licao falsa empurraria o reescritor para
    // "consertar" o que nao estava quebrado (R-03b:REC-4).
    if (verdict === undefined) continue;
    const question = (s.spec?.question ?? '?').replace(/\s+/g, ' ').trim().slice(0, 60);
    items.push(`- [${question}] veredito=${verdict} — ${motivo.slice(0, 200)}`);
  }
  if (!items.length) return '';
  return (LESSONS_PREFIX + items.join('\n')).slice(0, 4000);
}


/**
 * F4.1 — judge-score (escala 0–1) por FATIA (tier/dimensionTags do cenário) de
 * um contestant. É o vetor que a dominância de Pareto compara: prompts
 * diferentes são especialistas em fatias diferentes, e o campeão único não vê
 * isso.
 */
function sliceScoresOf(run: RunRecord, contestantId: string): Record<string, number> {
  const obs: { slice: string; score: number }[] = [];
  for (const st of run.stages) {
    const v =
      st.referenceJudge?.verdictByContestant?.[contestantId] ??
      st.judge?.verdictByContestant?.[contestantId];
    if (!v) continue;
    const fatias = st.spec?.dimensionTags?.length
      ? st.spec.dimensionTags
      : [st.spec?.tier ?? 'geral'];
    for (const f of fatias) obs.push({ slice: f, score: VERDICT_SCORE[v] });
  }
  return sliceScores(obs);
}

interface PoolMember extends ParetoEntry {
  text: string;
}

export interface StartTrainingResult {
  sessionId: string;
  record: SessionRecord;
}

export interface StartTrainingOpts {
  /** Sinal EXTERNO (espelho de src/trainer.ts). A sessão tem sempre a própria raiz. */
  signal?: AbortSignal;
}

// Cancelamento da SESSÃO (IMPL-020): um AbortController raiz por sessão; as
// runs de cada iteração (e o holdout) herdam o sinal — abortar a raiz aborta a
// run em voo e impede a próxima iteração de começar.
const sessionControllers = new Map<string, AbortController>();

/** Cancela um treino em andamento NESTA aba. false = não está rodando aqui. */
export function cancelTraining(sessionId: string, reason = 'cancelado pelo usuario'): boolean {
  const ctrl = sessionControllers.get(sessionId);
  if (!ctrl || ctrl.signal.aborted) return false;
  ctrl.abort(new RunCancelled(reason));
  return true;
}

/** true = o treino está rodando nesta aba e ainda pode ser cancelado. */
export function isTrainingCancellable(sessionId: string): boolean {
  const ctrl = sessionControllers.get(sessionId);
  return Boolean(ctrl && !ctrl.signal.aborted);
}

export async function startTraining(
  config: TrainingConfig,
  apiKey: string,
  opts: StartTrainingOpts = {},
): Promise<StartTrainingResult> {
  const sessionId = randomUUID();
  const record: SessionRecord = {
    id: sessionId,
    status: 'running',
    config,
    runIds: [],
    bestPromptByIteration: [],
    totalCostUsd: 0,
    startedAt: nowIso(),
  };
  const root = new AbortController();
  const onParentAbort = (): void => root.abort(opts.signal?.reason);
  if (opts.signal?.aborted) root.abort(opts.signal.reason);
  else opts.signal?.addEventListener('abort', onParentAbort, { once: true });
  sessionControllers.set(sessionId, root);
  // IMPL-023 (R-10:REC-1): lock EXCLUSIVO da sessão (Web Locks) antes da 1ª
  // gravação, solto só depois da última (no `finally` do laço). Aba fechada ou
  // recarregada => o navegador solta o lock e a próxima carga marca a sessão
  // órfã (aborted + stoppedReason 'orphan'). As runs das iterações seguram o
  // lock PRÓPRIO (orchestrator.executeRun).
  const lock = await acquireLock('session', sessionId);
  if (!lock) {
    sessionControllers.delete(sessionId);
    opts.signal?.removeEventListener('abort', onParentAbort);
    throw new Error('Esta sessão de treino já está em execução em outra aba deste navegador.');
  }
  const liberar = (): void => {
    sessionControllers.delete(sessionId);
    opts.signal?.removeEventListener('abort', onParentAbort);
    lock.release();
  };
  // Persiste ANTES de responder ao cliente, para a TrainingView nunca pegar 404.
  await saveSession(record);
  void trainingLoop(record, apiKey, root.signal)
    .catch(async (err) => {
      record.status = 'error';
      record.error = err instanceof Error ? err.message : String(err);
      record.finishedAt = nowIso();
      // saveSession nunca rejeita: falha de gravacao vira evento storage.* (IMPL-022).
      await saveSession(record);
      emitSessionEvent({ type: 'session.error', sessionId, error: record.error });
    })
    .finally(liberar);
  return { sessionId, record };
}

/**
 * Config da run de cada iteração. ⚠️ Whitelist campo a campo: o que faltar
 * aqui some em silêncio. `budgetUsd` fica de fora DE PROPÓSITO (espelho de
 * src/trainer.ts): copiá-lo daria a cada uma das N iterações o teto inteiro da
 * sessão; quem controla o dinheiro é o ledger da sessão, via `parentLedger`.
 */
export function variationConfigFrom(cfg: TrainingConfig): VariationConfig {
  return {
    mode: 'variation',
    theme: cfg.theme,
    stages: cfg.stages,
    datagenModelId: cfg.datagenModelId,
    judgeModelIds: cfg.judgeModelIds,
    concurrency: cfg.concurrency,
    timeoutMs: cfg.timeoutMs,
    maxOutputTokens: cfg.maxOutputTokens,
    promptOptimization: cfg.promptOptimization,
    optimizerModelId: cfg.optimizerModelId,
    judgePasses: cfg.judgePasses,
    customStages: cfg.customStages,
    // Campos declarativos repassados verbatim p/ a run nao perder o intent do
    // usuario (datagen guiado, julgamento por referencia, reasoning por papel).
    compliance: cfg.compliance,
    // IMPL-042: o modo de dado pessoal vale para toda iteracao e o holdout.
    piiMode: cfg.piiMode,
    // ...e a revisao do usuario (`allowPii`) vale para a sessao inteira.
    allowPii: cfg.allowPii,
    reasoning: cfg.reasoning,
    referenceModelId: cfg.referenceModelId,
    referenceJudging: cfg.referenceJudging,
    scenarioBrief: cfg.scenarioBrief,
    scenarioSeed: cfg.scenarioSeed,
    // Fase de finais: sem repassar, TODA iteracao (e o holdout) cairia no
    // default de 3 finalistas — a escolha do usuario era descartada em silencio.
    duels: cfg.duels,
    finalists: cfg.finalists,
    contestantModelId: cfg.contestantModelId,
    basePrompt: cfg.basePrompt,
    techniqueIds: cfg.techniqueIds,
    manualVariants: cfg.manualVariants,
    // Sem repassar, a temperatura do modelo sob teste sumiria em toda iteracao.
    temperature: cfg.temperature,
    // Contratos never-break (F2/P0.3): valem para toda reescrita da sessao.
    contracts: cfg.contracts,
    // Multi-prompt (F2/P0.4): grupo + fragmento-alvo atravessam as iteracoes.
    promptGroup: cfg.promptGroup,
    promptId: cfg.promptId,
  };
}

/**
 * IMPL-013 — re-avaliação LIMPA do candidato antes de confirmar a promoção
 * (aceitação estilo GEPA). O gate da melhor de K escolheu E testou o candidato
 * nas MESMAS avaliações (winner's curse); aqui candidato e régua rodam de novo —
 * respostas e vereditos NOVOS, nada reaproveitado — num minibatch de
 * max(5, ceil(0,3·n)) cenários de TREINO (o holdout nunca entra), sem finais.
 * Confirma só com melhora ESTRITA. O custo entra no ledger da sessão
 * (`parentLedger`) e na estimativa pré-iteração (`estimateInputFromConfig`).
 */
async function reevaluateCandidate(args: {
  cfg: TrainingConfig;
  apiKey: string;
  sessionId: string;
  iteration: number;
  selectionRun: RunRecord;
  controlId: string;
  candidateId: string;
  trainStages: StageSpec[];
  ledger: BudgetLedger;
  signal?: AbortSignal;
}): Promise<{ reeval: PromotionReeval; run?: RunRecord }> {
  const { cfg, selectionRun, controlId, candidateId, trainStages } = args;
  const minibatch = pickReevalMinibatch(trainStages, seedFromId(`reeval:${args.sessionId}:${args.iteration}`));
  const base = { candidateId, controlId, size: minibatch.length, poolSize: trainStages.length };
  const control = selectionRun.contestants.find((c) => c.id === controlId);
  const candidate = selectionRun.contestants.find((c) => c.id === candidateId);
  // Sem régua/candidato/cenário não há evidência limpa: não confirma.
  if (!control || !candidate || minibatch.length === 0) {
    return { reeval: { ...base, gainPp: 0, confirmed: false } };
  }
  const runId = randomUUID();
  const run = await runToCompletion(
    {
      ...variationConfigFrom(cfg),
      stages: minibatch.length,
      customStages: undefined,
      scenarioSeed: undefined,
      // Só o veredito por referência decide; finais seriam custo sem uso aqui.
      duels: false,
    },
    args.apiKey,
    {
      runId,
      contestants: [{ ...control }, { ...candidate }],
      pinnedStages: minibatch,
      sessionId: args.sessionId,
      iteration: args.iteration,
      parentRunId: selectionRun.id,
      parentLedger: args.ledger,
      signal: args.signal,
    },
  );
  if (run.status !== 'finished') {
    return { reeval: { ...base, runId, gainPp: 0, confirmed: false, runStatus: run.status }, run };
  }
  const { controlScores, championScores } = pairedStageScores(run.stages, controlId, candidateId);
  const d = reevalDecision(controlScores, championScores);
  return { reeval: { ...base, runId, pairing: d.pairing, gainPp: d.gainPp, confirmed: d.confirmed }, run };
}

async function trainingLoop(
  record: SessionRecord,
  apiKey: string,
  signal: AbortSignal,
): Promise<void> {
  const cfg = record.config;
  const sessionId = record.id;
  const optimizerModelId = cfg.optimizerModelId ?? cfg.datagenModelId;
  const promptOptimization = cfg.promptOptimization !== false;
  const hasBase = Boolean(cfg.basePrompt && cfg.basePrompt.trim());
  // IMPL-002: ausente = margem pratica default max(1; 50/n), resolvida NO GATE
  // (depende do n de pares da iteracao). O gate tambem exige p ajustado <= 0,05.
  const minGain = cfg.minGain;

  // Catálogo quente antes do primeiro gasto (espelho do Node): o reescritor da
  // iteração 0 roda ANTES da 1ª run, e sem catálogo perde a allowlist de
  // esforço/amostragem, o fallback de preço e a base das portas de orçamento.
  const catalogo = await listModels(apiKey).catch(() => []);

  // UM ledger raiz para a sessão inteira (espelho de src/trainer.ts): o teto é
  // da SESSÃO, não da iteração. As runs escrevem nele via `parentLedger` e o
  // reescritor via `ctx`. É a fonte de verdade do gasto (IMPL-021/IMPL-020).
  const ledger = new BudgetLedger({
    budgetUsd: cfg.budgetUsd,
    signal,
    estimateCall: makeCallEstimator(catalogo),
  });
  const ctx: RunCtx = { signal, sink: ledger };
  record.budgetUsd = cfg.budgetUsd;
  // Porta de orçamento: preço desconhecido pelo pior caso (IMPL-018) — espelho do Node.
  const estIter = estimateRunCost(estimateInputFromConfig(cfg as never), catalogo, {
    unknownPrice: 'worst-case',
  }).perIteration;
  const syncLedger = (): void => {
    const snap = ledger.snapshot();
    record.totalCostUsd = snap.spentUsd;
    record.costByRole = snap.byRole;
    record.costAccuracy = snap.accuracy;
    if (snap.upstreamUsd > 0) record.upstreamCostUsd = snap.upstreamUsd;
  };

  await saveSession(record);
  emitSessionEvent({ type: 'session.started', sessionId, record });
  log(sessionId, `started: ${cfg.iterations} iteracoes (minGain=${minGain ?? 'auto max(1; 50/n)'}, gate max-T a 5%)`);

  let pinnedStages: StageSpec[] | undefined;
  // Fatia de holdout (split anti-overfit na iteracao 0): fica so EM MEMORIA —
  // sessoes nao resumem entre processos hoje, entao nao precisa ir para o disco.
  let holdoutStages: StageSpec[] = [];
  let prevRun: RunRecord | undefined;
  // F4.1: pool Pareto (populacao diversa). maxSize 1 = elitismo classico.
  const poolSize = Math.max(1, Math.round(cfg.paretoPool ?? 1));
  let pool: PoolMember[] = [];
  const usoPai: Record<string, number> = {};
  // F4.2: 1o hash do contrato do juiz visto na sessao (detecta drift).
  let primeiroIdJuiz: JudgeIdentity | undefined;
  let champion: Champion | undefined;
  // Id que o campeao teve na run MAIS RECENTE (promovido: o id da variante;
  // convergido: a regua, que segurou o titulo). Usado na linhagem e no
  // pareamento da significancia.
  let championIdInLastRun = '';
  // IMPL-013: paciência — iterações SEGUIDAS sem promoção (encerra em 2).
  let semPromocao = 0;
  // Enquanto nada foi promovido o campeão É a base: o carry já a re-testa, e
  // repetir o 'original' seria um candidato nulo pago (e mais um no max-T).
  let promovidas = 0;
  // IMPL-013: K ≤ 6 técnicas por iteração; acima disso elas rodam na sessão.
  const techSeed = seedFromId(`techniques:${sessionId}`);

  // Rodada em curso — vira `stoppedAtIteration` se um sinal de controle subir
  // fora de uma run (reescritor/reflexão da rodada).
  let iterAtual = 0;
  try {
    // LGPD (IMPL-041): recusa a sessão sensível fora da allowlist ANTES do
    // reescritor da iteração 0 (que roda antes da 1ª run e do pré-voo dela).
    // IMPL-040: + liga o roteamento ZDR forçado no ledger da SESSÃO (o
    // reescritor e todas as runs aninhadas, que são forks dele, herdam).
    ledger.setSensitiveRouting((await enforceRunCompliance(cfg)).sensitiveRouting);
    for (let i = 0; i < cfg.iterations; i++) {
      iterAtual = i;
      // Porta suave por ITERAÇÃO (espelho do Node): uma iteração inteira é
      // descartável, e parar aqui deixa o campeão da anterior intacto. Compara
      // contra a ponta ALTA — começar uma iteração que provavelmente não
      // termina é o desperdício que esta porta existe para evitar.
      ledger.throwIfCancelled();
      if (i > 0 && !ledger.canAfford(estIter)) {
        record.budgetExhausted = true;
        record.stoppedAtPhase = 'competitors';
        record.stoppedReason = 'budget';
        record.stoppedAtIteration = i;
        log(sessionId, `orcamento esgotado antes da iteracao ${i + 1}; encerrando com o campeao atual`);
        break;
      }

      // 1) Resolve as variantes desta iteracao.
      let contestants: Contestant[];
      if (i === 0) {
        contestants = await generateContestants({
          apiKey,
          modelId: cfg.contestantModelId,
          theme: cfg.theme,
          basePrompt: cfg.basePrompt,
          originalPrompt: cfg.basePrompt,
          includeOriginal: hasBase,
          techniqueIds: techniquesForIteration(cfg.techniqueIds, i, techSeed),
          manualVariants: cfg.manualVariants,
          promptOptimization,
          optimizerModelId,
          reasoningLevel: cfg.reasoning?.rewriter,
          contracts: cfg.contracts,
          // IMPL-011: juiz do diff do contrato = 1º juiz da run (não o reescritor).
          contractJudgeModelId: cfg.judgeModelIds?.[0],
          // Verificações do contrato no MESMO raciocínio da run (juiz/competidor).
          contractJudgeReasoningLevel: cfg.reasoning?.judge,
          contestantReasoningLevel: cfg.reasoning?.competitor,
          // Multi-prompt (F2/P0.4): evolui 1 fragmento, irmaos congelados.
          promptGroup: cfg.promptGroup,
          promptId: cfg.promptId,
          timeoutMs: cfg.timeoutMs,
          ctx,
        });
      } else {
        // Reflection GEPA (deterministico — ver buildLessons): substitui a
        // antiga etapa LLM de analise; so a partir da iteracao 1 e se
        // as licoes nao foram desligadas (feedbackDriven false / reflection off).
        const hint0 =
          lessonsEnabled(cfg) && prevRun
            ? // IMPL-013: com paciência a iteração anterior pode não ter
              // promovido — o campeão rodou nela como 'carry'; `v<k>` de lá é
              // OUTRA variante. O id da última run é o que vale.
              buildLessons(prevRun, championIdInLastRun)
            : '';
        // Reflexao GEPA POR LLM (opt-in, §7.5): o meta-modelo reescreve as
        // licoes deterministicas num bloco acionavel. Custo extra contado no
        // ledger; falha DEGRADA para o deterministico — nunca derruba a iteracao.
        let hint = hint0;
        if (hint0 && cfg.reflection === 'llm') {
          try {
            hint = await llmReflectLessons({
              apiKey,
              modelId: optimizerModelId,
              baseLessons: hint0,
              theme: cfg.theme,
              reasoningLevel: cfg.reasoning?.rewriter,
              timeoutMs: cfg.timeoutMs,
              ctx,
            });
            log(sessionId, `reflexao LLM aplicada (${hint.length} chars de licoes)`);
          } catch (err) {
            // Sinal de controle sobe; qualquer outra falha degrada para as
            // licoes deterministicas — nunca derruba a iteracao.
            if (isControlSignal(err)) throw err;
            log(
              sessionId,
              `reflexao LLM falhou; licoes deterministicas seguem: ${err instanceof Error ? err.message : String(err)}`,
            );
            hint = hint0;
          }
        }
        contestants = await generateContestants({
          apiKey,
          modelId: cfg.contestantModelId,
          theme: cfg.theme,
          // F4.1: com pool >1 a base de DERIVACAO rotaciona entre os membros
          // nao-dominados (pais diversos — o GEPA mostra que colapsar num unico
          // campeao e preso a otimo local). A REGUA ('carry') continua sendo o
          // campeao: o gate por margem nao muda de significado.
          basePrompt: (() => {
            const pai = poolSize > 1 && pool.length ? pickParent(pool, usoPai) : undefined;
            if (pai) usoPai[pai.id] = (usoPai[pai.id] ?? 0) + 1;
            return pai?.text ?? champion!.systemPrompt;
          })(),
          originalPrompt: cfg.basePrompt,
          carryPrompt: champion!.systemPrompt,
          carryLabel: `Melhor it.${i}`,
          carryParentId: champion!.contestantId,
          includeOriginal: hasBase && promovidas > 0,
          techniqueIds: techniquesForIteration(cfg.techniqueIds, i, techSeed),
          manualVariants: cfg.manualVariants,
          promptOptimization,
          optimizerModelId,
          analysisHint: hint,
          reasoningLevel: cfg.reasoning?.rewriter,
          contracts: cfg.contracts,
          // IMPL-011: juiz do diff do contrato = 1º juiz da run (não o reescritor).
          contractJudgeModelId: cfg.judgeModelIds?.[0],
          // Verificações do contrato no MESMO raciocínio da run (juiz/competidor).
          contractJudgeReasoningLevel: cfg.reasoning?.judge,
          contestantReasoningLevel: cfg.reasoning?.competitor,
          // Multi-prompt (F2/P0.4): evolui 1 fragmento, irmaos congelados.
          promptGroup: cfg.promptGroup,
          promptId: cfg.promptId,
          timeoutMs: cfg.timeoutMs,
          ctx,
        });
      }

      if (contestants.length < 2) {
        throw new Error(`Iteracao ${i + 1}: variantes insuficientes (${contestants.length}).`);
      }

      // 2) Roda a iteracao (benchmark pinado a partir da iteracao 1).
      // IMPL-012 (R-02b:REC-3): o sequential halving (F4.3, `training.halving`)
      // foi REMOVIDO daqui. A triagem rodava uma run completa (competidores +
      // juiz + finais), a rodada 1 mantinha keep = V (0 eliminadas sempre) e o
      // rascunho era descartado: custo puro. As simulacoes da pesquisa vetam
      // religar como estava: H4 — P(eliminar a verdadeira melhor) 21,7–24,3% com
      // c <= 3 cenarios por rodada; H5 — nenhuma configuracao economiza >= 20%
      // com P(melhor sobreviver) >= 0,9; H6 — reusar as avaliacoes da triagem
      // infla o ganho reportado do vencedor em 4,9–8,7 p.p. So reimplementar do
      // zero se K >= 8 e n >= 20 virarem rotina: corte real (keepCount < V desde
      // a rodada 1), re-avaliacao limpa e as simulacoes como teste de regressao.

      const runId = randomUUID();
      record.runIds.push(runId);
      await saveSession(record);
      emitSessionEvent({ type: 'iteration.started', sessionId, iteration: i, runId });
      log(sessionId, `iteracao ${i + 1}/${cfg.iterations} -> run ${runId} (${contestants.length} variantes)`);

      const runRec = await runToCompletion(variationConfigFrom(cfg), apiKey, {
        runId,
        contestants,
        pinnedStages,
        sessionId,
        iteration: i,
        parentRunId: prevRun?.id,
        parentLedger: ledger,
        signal,
      });

      // O ledger e a fonte de verdade do gasto (todos os papeis de todas as
      // runs + reescritor); somar `runRec.totalCostUsd` contaria duas vezes.
      syncLedger();

      // IMPL-004: vereditos perdidos da sessao = soma das runs (iteracoes,
      // triagem e holdout) — a mesma conta que cada run carrega.
      record.failureCountByRole = mergeFailureCounts(record.failureCountByRole, runRec.failureCountByRole);
      // A run da iteração parou por orçamento/cancelamento => a sessão para
      // também, com o campeão da iteração ANTERIOR (a desta ficou parcial e
      // não pode promover ninguém).
      if (runRec.stoppedReason) {
        record.budgetExhausted = runRec.stoppedReason === 'budget';
        record.stoppedReason = runRec.stoppedReason;
        record.stoppedAtPhase = runRec.stoppedAtPhase;
        record.stoppedAtIteration = i;
        await saveSession(record);
        break;
      }

      // F4.2: calibration drift — contrato do juiz diferente no meio da sessao
      // significa que o delta entre iteracoes pode ser do JUIZ, nao do prompt.
      // IMPL-019: a identidade inclui o snapshot (canonicalSlug/aliasTarget) do
      // juiz e do gabarito — alias `~…-latest` movido no meio da sessao e outro
      // modelo com o MESMO id, e o hash sozinho nao veria.
      const idJuiz = judgeIdentity(runRec);
      if (idJuiz) {
        if (primeiroIdJuiz && judgeIdentityChanged(primeiroIdJuiz, idJuiz)) record.judgeDrift = true;
        primeiroIdJuiz = primeiroIdJuiz ? mergeJudgeIdentity(primeiroIdJuiz, idJuiz) : idJuiz;
      }

      // 3) Pina o benchmark depois da iteracao 0 (mesmas perguntas em todas),
      //    com split anti-overfit: a fatia de holdout fica FORA da selecao e so
      //    entra no gate final (ver finalizeHoldout).
      if (i === 0) {
        const specs = runRec.stages
          .map((s) => s.spec)
          .filter((s): s is StageSpec => Boolean(s));
        if (cfg.holdoutRatio !== 0) {
          const split = splitHoldout(specs, cfg.holdoutRatio ?? 0.2);
          pinnedStages = split.train;
          holdoutStages = split.holdout;
        } else {
          pinnedStages = specs;
        }
        record.pinnedStages = pinnedStages;
      }

      // 4) Gate de promocao (port do evolve.mjs + IMPL-002): a melhor variante
      //    so vira campea se superar a REGUA desta iteracao por >= minGain
      //    pontos de judge-score E passar no max-T sobre as K variantes (p
      //    ajustado <= 0,05 — a "melhor de K" nao ganha mais sozinha). A regua e
      //    o 'original' (base) na iteracao 0 e o 'carry' (campeao anterior
      //    re-testado verbatim) nas demais.
      const controlId = i === 0 ? 'original' : 'carry';
      // IMPL-005: o ganho e o Δ PAREADO (so etapas com veredito nos DOIS
      // lados; ausente nunca vira 'nao') e, com >10% de pares excluidos, a
      // promocao so vale se sobreviver ao pior/melhor caso (ver pickWinner).
      const pick = pickWinner(buildRankEntries(runRec, controlId), {
        minGain,
        scoresById: stageScoresByContestant(
          runRec.stages,
          runRec.contestants.map((c) => c.id),
        ),
      });
      // IMPL-013: passou no gate da melhor de K → re-avaliação LIMPA num
      // minibatch antes de confirmar (as avaliações da seleção não confirmam a
      // própria seleção). Sem régua (treino sem prompt base, iteração 0) não há
      // contra quem re-avaliar: a melhor vence por definição, como antes.
      let gate: IterationGate | undefined = pick.gate;
      let confirmed = pick.isWinner && Boolean(pick.best);
      if (confirmed && pick.best && pick.control) {
        const r = await reevaluateCandidate({
          cfg,
          apiKey,
          sessionId,
          iteration: i,
          selectionRun: runRec,
          controlId,
          candidateId: pick.best.id,
          trainStages: pinnedStages ?? [],
          ledger,
          signal,
        });
        syncLedger();
        confirmed = r.reeval.confirmed;
        if (gate) {
          gate = confirmed
            ? { ...gate, reeval: r.reeval }
            : { ...gate, reeval: r.reeval, decision: 'held', heldBy: [...(gate.heldBy ?? []), 'reeval'] };
        }
        log(
          sessionId,
          `re-avaliacao limpa de ${pick.best.id} em ${r.reeval.size} cenarios: Δ ${r.reeval.gainPp.toFixed(1)}pp — ${
            confirmed ? 'confirmada' : `NAO confirmada${r.reeval.runStatus ? ` (run ${r.reeval.runStatus})` : ''}`
          }`,
        );
      }
      let promoted = false;
      if (confirmed && pick.best) {
        const wc = runRec.contestants.find((c) => c.id === pick.best!.id);
        champion = {
          contestantId: pick.best.id,
          // Multi-prompt: o campeao e o FRAGMENTO evoluido (nunca o composto).
          systemPrompt: wc?.promptFragment ?? wc?.systemPrompt ?? champion?.systemPrompt ?? cfg.basePrompt ?? '',
          label: wc?.label ?? pick.best.id,
        };
        championIdInLastRun = pick.best.id;
        promoted = true;
        promovidas += 1;
      } else if (!champion) {
        // A regua segurou o titulo logo na 1a rodada.
        const controlC = runRec.contestants.find((c) => c.id === controlId);
        champion = {
          contestantId: controlId,
          // Multi-prompt: o FRAGMENTO (com paciência o laço segue e o carry
          // compõe de novo — o composto seria composto duas vezes).
          systemPrompt: controlC?.promptFragment ?? controlC?.systemPrompt ?? cfg.basePrompt ?? '',
          label: controlC?.label ?? controlId,
        };
        championIdInLastRun = controlId;
      } else {
        // Convergencia em i>0: o campeao anterior rodou como 'carry' e se manteve.
        championIdInLastRun = controlId;
      }

      // 5) Linhagem: registra o CAMPEAO POS-GATE de cada iteracao (score e
      //    medalhas seguem de computeMedals apenas para a UI — a decisao de
      //    promocao e do gate por margem, nao do quadro de medalhas).
      // Cast: o RunRecord do web aceita stoppedReason 'orphan' (IMPL-023, só
      // SPA) e o de src/ ainda não — uma run desta aba nunca é órfã aqui.
      const medalRow = computeMedals(runRec as Parameters<typeof computeMedals>[0]).find(
        (r) => r.contestantId === championIdInLastRun,
      );
      record.bestPromptByIteration.push({
        iteration: i,
        runId: runRec.id,
        winnerContestantId: championIdInLastRun,
        systemPrompt: champion.systemPrompt,
        score: medalRow?.golds ?? 0,
        medals: medalRow?.medals ?? [],
        golds: medalRow?.golds ?? 0,
        silvers: medalRow?.silvers ?? 0,
        bronzes: medalRow?.bronzes ?? 0,
        ...(gate ? { gate } : {}),
      });

      // F4.1: promocao entra no POOL (nunca derruba o campeao unico — o pool
      // e aditivo e o champion segue sendo o melhor absoluto p/ holdout).
      if (promoted) {
        pool = addToPool(
          pool,
          {
            id: `it-${i}`,
            label: champion.label,
            bySlice: sliceScoresOf(runRec, championIdInLastRun),
            text: champion.systemPrompt,
          },
          { maxSize: poolSize },
        );
      }

      prevRun = runRec;
      emitSessionEvent({
        type: 'iteration.finished',
        sessionId,
        iteration: i,
        runId: runRec.id,
        winnerContestantId: championIdInLastRun,
      });
      if (promoted) {
        emitSessionEvent({
          type: 'iteration.promoted',
          sessionId,
          iteration: i,
          championId: champion.contestantId,
          gain: pick.gain,
          // IMPL-002: bruto (gain) e corrigido lado a lado, com o p ajustado.
          ...promotionEventFields(gate),
        });
        log(
          sessionId,
          `iteracao ${i + 1}: promovido ${champion.contestantId} (${
            gate ? formatIterationGate(gate) : `ganho +${pick.gain.toFixed(1)}pp`
          })`,
        );
      }
      await saveSession(record);

      // IMPL-013 — paciência 2: uma iteração sem promoção NÃO encerra a sessão
      // (antes encerrava: paciência implícita 1). A próxima deriva de novo do
      // campeão atual, com lições novas; só 2 SEGUIDAS sem promoção = convergiu.
      semPromocao = promoted ? 0 : semPromocao + 1;
      if (!promoted && shouldStopForPatience(semPromocao)) {
        record.convergedAtIteration = i;
        emitSessionEvent({ type: 'session.converged', sessionId, iteration: i });
        log(
          sessionId,
          gate?.decision === 'inconclusive'
            ? `parou sem promocao na iteracao ${i + 1} (${semPromocao} seguidas): gate INCONCLUSIVO (${gate.pairing.excludedPairs} de ${gate.pairing.n} pares sem veredito; a decisao muda no pior/melhor caso)`
            : gate
              ? `convergiu na iteracao ${i + 1} (${semPromocao} seguidas sem promocao; ${formatIterationGate(gate)})`
              : `convergiu na iteracao ${i + 1} (${semPromocao} seguidas sem promocao; ganho ${pick.gain.toFixed(1)}pp < minGain ${minGain ?? 1})`,
        );
        await saveSession(record);
        break;
      }
      if (!promoted) {
        log(
          sessionId,
          `iteracao ${i + 1} sem promocao (${semPromocao}/${TRAINING_PATIENCE} da paciencia): segue com o campeao atual`,
        );
      }
    }

    // 6) Gate final: holdout + significancia. NUNCA derruba a sessao — falha
    //    aqui vira warn e o treino termina com o que se tem.
    try {
      // O holdout é uma run extra. Sem orçamento para ela o campeão fica NÃO
      // VALIDADO contra sobreajuste — e isso precisa aparecer no resultado
      // (`holdoutSkipped`), não sumir. Espelho de src/trainer.ts.
      const estHoldout =
        holdoutStages.length > 0 ? estIter * (holdoutStages.length / Math.max(1, cfg.stages)) : 0;
      if (record.stoppedReason || (estHoldout > 0 && !ledger.canAfford(estHoldout))) {
        // Só há o que "pular" se havia fatia de holdout reservada.
        if (holdoutStages.length > 0) record.holdoutSkipped = true;
        log(sessionId, 'holdout pulado (orcamento/cancelamento): campeao NAO validado contra sobreajuste');
      } else {
        await finalizeHoldout(record, apiKey, champion, championIdInLastRun, holdoutStages, prevRun, {
          ledger,
          signal,
        });
      }
    } catch (err) {
      if (isControlSignal(err)) {
        record.holdoutSkipped = true;
        record.stoppedReason ??= err.benchControl === 'budget' ? 'budget' : 'cancelled';
        if (err.benchControl === 'budget') record.budgetExhausted = true;
      } else {
        console.warn(
          `[train ${sessionId}] gate de holdout/significancia falhou (sessao segue): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    syncLedger();
    // Parou cedo (orçamento/cancelamento): resultado PARCIAL, e diz isso.
    record.status = record.stoppedReason ? 'aborted' : 'finished';
    record.finishedAt = nowIso();
    await saveSession(record);
    emitSessionEvent({ type: 'session.finished', sessionId, record });
    log(sessionId, `finished: custo ${record.totalCostUsd}`);
  } catch (err) {
    syncLedger();
    if (isControlSignal(err)) {
      // Orçamento/cancelamento fora de uma run (reescritor, porta da
      // iteração): sessão interrompida COM o resultado parcial, não erro.
      record.status = 'aborted';
      record.stoppedReason = err.benchControl === 'budget' ? 'budget' : 'cancelled';
      if (err.benchControl === 'budget') record.budgetExhausted = true;
      record.stoppedAtIteration ??= iterAtual;
      record.finishedAt = nowIso();
      await saveSession(record);
      emitSessionEvent({ type: 'session.finished', sessionId, record });
      log(sessionId, `sessao interrompida (${record.stoppedReason})`);
      return;
    }
    record.status = 'error';
    record.error = err instanceof Error ? err.message : String(err);
    record.finishedAt = nowIso();
    await saveSession(record);
    emitSessionEvent({ type: 'session.error', sessionId, error: record.error });
    log(sessionId, `error: ${record.error}`);
  }
}

/**
 * Gate final do treino (port do evolve.mjs): re-score do campeao contra o
 * controle (base) nos cenarios de HOLDOUT — que ficaram fora da selecao — mais
 * significancia estatistica (teste pareado exato por troca de sinais + IC por
 * inversao, IMPL-001). E SUPORTE A DECISAO (a UI mostra ganho/regressao/
 * p-valor); nao bloqueia a promocao nem derruba a sessao (o chamador envolve
 * em try/catch).
 */
async function finalizeHoldout(
  record: SessionRecord,
  apiKey: string,
  champion: Champion | undefined,
  championIdInLastRun: string,
  holdoutStages: StageSpec[],
  lastRun: RunRecord | undefined,
  ctxOpts: { ledger?: BudgetLedger; signal?: AbortSignal } = {},
): Promise<void> {
  const cfg = record.config;
  const sessionId = record.id;
  const basePrompt = cfg.basePrompt ?? '';
  // Multi-prompt: no holdout o systemPrompt efetivo e a composicao do grupo.
  const comporHoldout = (fragmento: string): string =>
    cfg.promptGroup ? composePrompt(cfg.promptGroup, cfg.promptId, fragmento) : fragmento;

  let holdoutRun: RunRecord | undefined;
  // So ha o que re-testar se a fatia de holdout e confiavel, existe um prompt
  // base p/ servir de controle e o campeao final e uma VARIANTE (se o treino
  // convergiu sem ganho, campeao == base e a run compararia ele consigo mesmo).
  if (
    champion &&
    holdoutStages.length >= MIN_HOLDOUT_SCENARIOS &&
    basePrompt.trim() &&
    champion.systemPrompt !== basePrompt
  ) {
    const runId = randomUUID();
    record.runIds.push(runId);
    await saveSession(record);
    log(sessionId, `holdout: run ${runId} (${holdoutStages.length} cenarios reservados)`);

    const contestants: Contestant[] = [
      {
        id: 'holdout-control',
        label: 'Controle (base)',
        modelId: cfg.contestantModelId,
        systemPrompt: comporHoldout(basePrompt),
      },
      {
        id: 'holdout-champion',
        label: 'Campeao (final)',
        modelId: cfg.contestantModelId,
        systemPrompt: comporHoldout(champion.systemPrompt),
      },
    ];
    holdoutRun = await runToCompletion(
      { ...variationConfigFrom(cfg), stages: holdoutStages.length, customStages: undefined },
      apiKey,
      {
        runId,
        contestants,
        pinnedStages: holdoutStages,
        sessionId,
        // Marcador "rodada H": a iteracao logo apos a ultima do treino — na UI
        // a run de holdout aparece como uma iteracao extra (N+1).
        iteration: cfg.iterations,
        parentRunId: lastRun?.id,
        parentLedger: ctxOpts.ledger,
        signal: ctxOpts.signal,
      },
    );
    if (ctxOpts.ledger) {
      const snap = ctxOpts.ledger.snapshot();
      record.totalCostUsd = snap.spentUsd;
      record.costByRole = snap.byRole;
      record.costAccuracy = snap.accuracy;
    } else {
      record.totalCostUsd += holdoutRun.totalCostUsd;
    }
    // Holdout cortado por orçamento/cancelamento: o gate não aconteceu — o
    // campeão fica NÃO validado, e o motivo sobe para a sessão.
    if (holdoutRun.stoppedReason) {
      record.holdoutSkipped = true;
      record.stoppedReason ??= holdoutRun.stoppedReason;
      if (holdoutRun.stoppedReason === 'budget') {
        record.budgetExhausted = true;
        record.stoppedAtPhase ??= 'holdout';
      }
    }
    record.failureCountByRole = mergeFailureCounts(record.failureCountByRole, holdoutRun.failureCountByRole);
    // `inconclusive` (IMPL-004) tambem descarta o gate: holdout com vereditos
    // perdidos demais ou n efetivo < 5 nao valida campeao nenhum.
    if (holdoutRun.status !== 'finished') {
      console.warn(
        `[train ${sessionId}] run de holdout terminou com status ${holdoutRun.status}; gate descartado`,
      );
      holdoutRun = undefined; // cai no fallback de significancia abaixo
    }
  }

  if (holdoutRun) {
    // IMPL-005: medias, ganho e teste sobre OS MESMOS pares — so etapas com
    // veredito nos DOIS lados (ausente sai dos dois, nunca vira 'nao').
    const { controlScores, championScores } = pairedStageScores(
      holdoutRun.stages,
      'holdout-control',
      'holdout-champion',
    );
    const coverage = pairCoverage(controlScores, championScores);
    const controlScore = coverage.controlMeanPp ?? 0;
    const championScore = coverage.championMeanPp ?? 0;
    record.holdout = {
      n: holdoutStages.length,
      controlScore,
      championScore,
      gain: coverage.meanDiffPp ?? 0,
      regressed: championScore < controlScore,
      nEfetivo: coverage.nEfetivo,
      excludedPairs: coverage.excludedPairs,
      completeness: coverage.completeness,
    };
    record.pairing = {
      source: 'holdout',
      controlId: 'holdout-control',
      championId: 'holdout-champion',
      ...coverage,
    };
    emitSessionEvent({ type: 'session.holdout', sessionId, holdout: record.holdout });
    record.significance = pairedSignificance(controlScores, championScores);
  } else if (lastRun && champion) {
    // Sem run de holdout (split invalido, campeao == base ou run falhou): a
    // significancia vem da ultima run de treino, pareando a BASE ('original',
    // quando presente — mesma comparacao que o holdout faria) com o campeao;
    // sem base na run, cai na regua da iteracao ('carry'). null se n<5 — a
    // funcao ja trata.
    const lastControlId = (lastRun.iteration ?? 0) === 0 ? 'original' : 'carry';
    const pairingControl = lastRun.contestants.some((c) => c.id === 'original')
      ? 'original'
      : lastControlId;
    const pairable =
      pairingControl !== championIdInLastRun &&
      lastRun.contestants.some((c) => c.id === pairingControl) &&
      lastRun.contestants.some((c) => c.id === championIdInLastRun);
    if (pairable) {
      const { controlScores, championScores } = pairedStageScores(
        lastRun.stages,
        pairingControl,
        championIdInLastRun,
      );
      record.pairing = {
        source: 'training',
        controlId: pairingControl,
        championId: championIdInLastRun,
        ...pairCoverage(controlScores, championScores),
      };
      record.significance = pairedSignificance(controlScores, championScores);
    } else {
      // Campeao == controle (convergiu sem ganho) ou ids ausentes na run:
      // nao ha comparacao a testar.
      record.significance = null;
    }
  }
  await saveSession(record);
}
