import { randomUUID } from 'node:crypto';
import { runToCompletion } from './orchestrator.js';
import { generateContestants, llmReflectLessons } from './variator.js';
import { composePrompt } from './engine/promptGroup.js';
import { addToPool, pickParent, sliceScores, type ParetoEntry } from './engine/pareto.js';
import { planHalving, survivorsOf } from './engine/halving.js';
import { seedFromId } from './engine/duelCore.js';
import { emitSessionEvent } from './events.js';
import { saveSession } from './storage.js';
import { computeMedals } from './medals.js';
import { judgeScoreFromVerdicts, pickWinner, type RankEntry } from './rank.js';
import { MIN_HOLDOUT_SCENARIOS, splitHoldout } from './holdout.js';
import { pairedSignificance, VERDICT_SCORE } from './stats.js';
import { BudgetLedger, isControlSignal } from './budget.js';
import { estimateInputFromConfig, estimateRunCost, makeCallEstimator } from './estimate.js';
import { listModels } from './openrouter.js';
import type {
  Contestant,
  RunCtx,
  RunRecord,
  SessionRecord,
  StageSpec,
  TrainingConfig,
  VariationConfig,
} from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function log(sessionId: string, msg: string): void {
  // stderr: ver a nota em orchestrator.ts — stdout e payload.
  console.error(`[train ${sessionId}] ${msg}`);
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
function buildLessons(run: RunRecord, championId: string): string {
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
    // Estagio sem veredito E sem motivo (o pipeline falhou ali) nao vira licao:
    // seria ruido, nao uma fraqueza observada do campeao.
    if (verdict === undefined && !motivo) continue;
    const question = (s.spec?.question ?? '?').replace(/\s+/g, ' ').trim().slice(0, 60);
    items.push(`- [${question}] veredito=${verdict ?? '?'} — ${motivo.slice(0, 200)}`);
  }
  if (!items.length) return '';
  return (LESSONS_PREFIX + items.join('\n')).slice(0, 4000);
}

/**
 * Scores por estagio (escala 0-1 de `VERDICT_SCORE`) de controle e campeao,
 * posicao a posicao, para o bootstrap pareado. Veredito ausente conta como
 * 'nao' (0) — mesma convencao de `judgeScoreFromVerdicts`.
 */
function pairedStageScores(
  run: RunRecord,
  controlId: string,
  championId: string,
): { controlScores: number[]; championScores: number[] } {
  const controlScores: number[] = [];
  const championScores: number[] = [];
  for (const s of run.stages) {
    const vc =
      s.referenceJudge?.verdictByContestant?.[controlId] ??
      s.judge?.verdictByContestant?.[controlId];
    const vh =
      s.referenceJudge?.verdictByContestant?.[championId] ??
      s.judge?.verdictByContestant?.[championId];
    controlScores.push(VERDICT_SCORE[vc ?? 'nao']);
    championScores.push(VERDICT_SCORE[vh ?? 'nao']);
  }
  return { controlScores, championScores };
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
  /** Sinal de abort (Ctrl-C). */
  signal?: AbortSignal;
  /**
   * Chamado com o id ANTES do laco comecar. E onde um consumidor assina o bus
   * de eventos sem corrida — `session.started` e emitido dentro do laco.
   */
  onSession?: (sessionId: string, record: SessionRecord) => void;
  /**
   * Ledger EXTERNO (IMPL-031): a sessao vira FILHA dele e o teto segue na raiz
   * (que o chamador cria com o `budgetUsd` da sessao). O CLI passa aqui a raiz
   * que tambem reserva no ledger EM ARQUIVO da maquina (teto diario somando
   * processos). Ausente => raiz propria a partir de cfg.budgetUsd, como antes.
   * Seam so do Node: o mirror web nao tem ledger de maquina.
   */
  parentLedger?: BudgetLedger;
}

function newSessionRecord(config: TrainingConfig): SessionRecord {
  return {
    id: randomUUID(),
    status: 'running',
    config,
    runIds: [],
    bestPromptByIteration: [],
    totalCostUsd: 0,
    startedAt: nowIso(),
  };
}

export async function startTraining(
  config: TrainingConfig,
  apiKey: string,
  opts: StartTrainingOpts = {},
): Promise<StartTrainingResult> {
  const record = newSessionRecord(config);
  const sessionId = record.id;
  // Persiste ANTES de responder ao cliente, para a TrainingView nunca pegar 404.
  await saveSession(record);
  opts.onSession?.(sessionId, record);
  void trainingLoop(record, apiKey, opts).catch(async (err) => {
    record.status = 'error';
    record.error = err instanceof Error ? err.message : String(err);
    record.finishedAt = nowIso();
    await saveSession(record).catch(() => undefined);
    emitSessionEvent({ type: 'session.error', sessionId, error: record.error });
  });
  return { sessionId, record };
}

/**
 * Roda o treino ate o fim e resolve com o record final — a simetrica de
 * `runToCompletion` do lado da sessao, que faltava. `trainingLoop` ja tem o
 * proprio try/catch terminal, entao herda o contrato "nunca rejeita".
 */
export async function trainToCompletion(
  config: TrainingConfig,
  apiKey: string,
  opts: StartTrainingOpts = {},
): Promise<SessionRecord> {
  const record = newSessionRecord(config);
  await saveSession(record);
  opts.onSession?.(record.id, record);
  await trainingLoop(record, apiKey, opts);
  return record;
}

/**
 * Monta a VariationConfig de cada iteração a partir do TrainingConfig da sessão.
 * ⚠️ WHITELIST campo a campo (ver AGENTS.md): o que faltar aqui é descartado em
 * silêncio em TODA iteração e no holdout. O teste `test/runtime-guards.test.ts`
 * falha quando um campo novo de RunConfigBase não aparece nem aqui nem na lista
 * de exclusões documentadas.
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
    // Teto por requisicao vale para toda chamada da sessao.
    maxPricePerMTok: cfg.maxPricePerMTok,
    // Contratos never-break (F2/P0.3): valem para toda reescrita da sessao.
    contracts: cfg.contracts,
    // Multi-prompt (F2/P0.4): o grupo e o fragmento-alvo atravessam as iteracoes.
    promptGroup: cfg.promptGroup,
    promptId: cfg.promptId,
    // ⚠️ `budgetUsd` NAO entra aqui DE PROPOSITO. Este whitelist normalmente
    // engole campo novo em silencio (ver AGENTS.md) e a reacao natural e
    // "corrigir" a ausencia — mas copiar o orcamento daria a CADA uma das N
    // iteracoes o teto inteiro da sessao, e o gasto total seria N x o teto.
    // Quem controla o dinheiro e o ledger da sessao, repassado por parentLedger.
    //
    // `agent` (Fase 4, §29.2): copiado por REQUERIDO. Sem isso o treino com
    // agente rodaria todas as iteracoes (e o holdout) como CHAT em silencio —
    // o bug mais caro e mais silencioso do plano. O runner='agent' dos
    // contestants e marcado pelo variator/trainer quando `agent` presente.
    agent: cfg.agent,
  };
}

async function trainingLoop(
  record: SessionRecord,
  apiKey: string,
  opts: StartTrainingOpts = {},
): Promise<void> {
  const cfg = record.config;
  const sessionId = record.id;
  const optimizerModelId = cfg.optimizerModelId ?? cfg.datagenModelId;
  const promptOptimization = cfg.promptOptimization !== false;
  const hasBase = Boolean(cfg.basePrompt && cfg.basePrompt.trim());
  const minGain = cfg.minGain ?? 1;

  // Catalogo quente antes do primeiro gasto (senao o custo sai 0 e a porta de
  // orcamento acha que tudo e de graca).
  const catalogo = await listModels(apiKey).catch(() => []);

  // UM ledger raiz para a sessao inteira: o teto e da sessao, nao da iteracao.
  // Com `parentLedger` (CLI, IMPL-031) a sessao e filha dele — o teto continua
  // UM so, na raiz, e a reserva passa tambem pelo ledger da maquina.
  const ledger =
    opts.parentLedger?.fork() ??
    new BudgetLedger({
      budgetUsd: cfg.budgetUsd,
      signal: opts.signal,
      estimateCall: makeCallEstimator(catalogo),
    });
  const ctx: RunCtx = { signal: opts.signal, sink: ledger };
  record.budgetUsd = cfg.budgetUsd;

  const estIter = estimateRunCost(estimateInputFromConfig(cfg), catalogo).perIteration;

  const syncLedger = (): void => {
    const snap = ledger.snapshot();
    record.totalCostUsd = snap.spentUsd;
    record.costByRole = snap.byRole;
    record.costAccuracy = snap.accuracy;
    if (snap.upstreamUsd > 0) record.upstreamCostUsd = snap.upstreamUsd;
  };

  await saveSession(record);
  emitSessionEvent({ type: 'session.started', sessionId, record });
  log(sessionId, `started: ${cfg.iterations} iteracoes (minGain=${minGain})`);

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
  let primeiroHashJuiz: string | undefined;
  let champion: Champion | undefined;
  // Id que o campeao teve na run MAIS RECENTE (promovido: o id da variante;
  // convergido: a regua, que segurou o titulo). Usado na linhagem e no
  // pareamento da significancia.
  let championIdInLastRun = '';

  try {
    for (let i = 0; i < cfg.iterations; i++) {
      // Porta suave por ITERACAO: uma iteracao inteira e descartavel, e parar
      // aqui deixa o campeao da anterior intacto. Compara contra `high`, nao
      // `low` — comecar uma iteracao que provavelmente nao termina e o
      // desperdicio que este gate existe para evitar.
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
          techniqueIds: cfg.techniqueIds,
          manualVariants: cfg.manualVariants,
          promptOptimization,
          optimizerModelId,
          reasoningLevel: cfg.reasoning?.rewriter,
          timeoutMs: cfg.timeoutMs,
          ctx,
          maxPricePerMTok: cfg.maxPricePerMTok,
          // Contratos never-break (F2/P0.3): valem em toda iteracao.
          contracts: cfg.contracts,
          // Multi-prompt (F2/P0.4): evolui 1 fragmento, irmaos congelados.
          promptGroup: cfg.promptGroup,
          promptId: cfg.promptId,
          // Fase 4: sem `runner='agent'` o treino com agente rodaria como chat (§29.2).
          runner: cfg.agent ? 'agent' : undefined,
        });
      } else {
        // Reflection GEPA (deterministico — ver buildLessons): substitui a
        // antiga etapa LLM de analise; so a partir da iteracao 1 e se
        // feedbackDriven nao foi desligado.
        const hint0 =
          cfg.feedbackDriven !== false && prevRun
            ? buildLessons(prevRun, champion!.contestantId)
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
              maxPricePerMTok: cfg.maxPricePerMTok,
            });
            log(sessionId, `reflexao LLM aplicada (${hint.length} chars de licoes)`);
          } catch (err) {
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
          includeOriginal: hasBase,
          techniqueIds: cfg.techniqueIds,
          manualVariants: cfg.manualVariants,
          promptOptimization,
          optimizerModelId,
          analysisHint: hint,
          reasoningLevel: cfg.reasoning?.rewriter,
          timeoutMs: cfg.timeoutMs,
          ctx,
          maxPricePerMTok: cfg.maxPricePerMTok,
          // Contratos never-break (F2/P0.3): valem em toda iteracao.
          contracts: cfg.contracts,
          // Multi-prompt (F2/P0.4): evolui 1 fragmento, irmaos congelados.
          promptGroup: cfg.promptGroup,
          promptId: cfg.promptId,
          // Fase 4: mesmo runner nas iteracoes seguintes (agente quando config.agent).
          runner: cfg.agent ? 'agent' : undefined,
        });
      }

      if (contestants.length < 2) {
        throw new Error(`Iteracao ${i + 1}: variantes insuficientes (${contestants.length}).`);
      }

      // 2) Roda a iteracao (benchmark pinado a partir da iteracao 1).
      // F4.3 — SEQUENTIAL HALVING (opt-in `training.halving`): antes da rodada
      // completa, uma TRIAGEM barata num subconjunto de cenários corta as piores
      // variantes (o controle nunca cai). O custo da triagem é real e entra no
      // ledger; o ganho é rodar o benchmark completo só com os sobreviventes.
      // Com dataset conhecido (customStages/scenarioSeed/pinos) e variantes > 3.
      const estagiosConhecidos = pinnedStages ?? cfg.customStages ?? cfg.scenarioSeed ?? [];
      if (cfg.halving && contestants.length > 3 && estagiosConhecidos.length >= 8) {
        const seed = seedFromId(`halving:${sessionId}:${i}`);
        const plano = planHalving(
          contestants.map((c) => c.id),
          estagiosConhecidos.map((s) => s.question),
          seed,
          { protectedIds: ['original', 'carry'] },
        );
        const rodada1 = plano.rounds[0];
        const subset = estagiosConhecidos.filter((s) => rodada1.scenarioIds.includes(s.question));
        log(sessionId, `halving: triagem de ${contestants.length} variantes em ${subset.length} cenarios`);
        const rascunho = await runToCompletion(
          { ...variationConfigFrom(cfg), stages: subset.length, customStages: subset, scenarioSeed: undefined },
          apiKey,
          {
            runId: randomUUID(),
            contestants,
            sessionId,
            iteration: i,
            parentRunId: prevRun?.id,
            parentLedger: ledger,
            signal: opts.signal,
          },
        );
        syncLedger();
        const { survivors, eliminated } = survivorsOf(
          rascunho.contestants.map((c) => ({ id: c.id, score: judgeScoreOf(rascunho, c.id) })),
          rodada1.keepCount,
          { seed, protectedIds: ['original', 'carry'] },
        );
        const antes = contestants.length;
        contestants = contestants.filter((c) => survivors.includes(c.id));
        log(
          sessionId,
          `halving: ${antes - contestants.length} variante(s) eliminada(s) na triagem (${eliminated.join(', ')})`,
        );
      }

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
        signal: opts.signal,
      });

      
      // F4.2: calibration drift — contrato do juiz diferente no meio da sessao
      // significa que o delta entre iteracoes pode ser do JUIZ, nao do prompt.
      const hashJuiz = runRec.judgeDiagnostics?.contract.hash;
      if (hashJuiz) {
        if (primeiroHashJuiz && hashJuiz !== primeiroHashJuiz) record.judgeDrift = true;
        primeiroHashJuiz ??= hashJuiz;
      }
      // O ledger e a fonte de verdade do gasto (soma todos os papeis de todas
      // as runs); somar `runRec.totalCostUsd` aqui contaria duas vezes.
      // F4.1: o front final (sem o texto — grande demais p/ o record) mostra a
    // POPULACAO que sobreviveu, nao so o campeao.
    record.pool = pool.map(({ text: _text, ...e }) => ({ ...e, label: e.label ?? e.id }));
    syncLedger();

      // A run filha parou por orcamento/cancelamento => a sessao para tambem.
      if (runRec.status === 'aborted' && runRec.stoppedReason) {
        record.budgetExhausted = runRec.stoppedReason === 'budget';
        record.stoppedReason = runRec.stoppedReason;
        record.stoppedAtPhase = runRec.stoppedAtPhase;
        record.stoppedAtIteration = i;
        await saveSession(record);
        break;
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

      // 4) Gate de promocao por margem (port do evolve.mjs): a melhor variante
      //    so vira campea se superar a REGUA desta iteracao por >= minGain
      //    pontos de judge-score. A regua e o 'original' (base) na iteracao 0 e
      //    o 'carry' (campeao anterior re-testado verbatim) nas demais.
      const controlId = i === 0 ? 'original' : 'carry';
      const pick = pickWinner(buildRankEntries(runRec, controlId), { minGain });
      let promoted = false;
      if (pick.isWinner && pick.best) {
        const wc = runRec.contestants.find((c) => c.id === pick.best!.id);
        champion = {
          contestantId: pick.best.id,
          // Multi-prompt: o campeao e o FRAGMENTO evoluido (nunca o composto).
          systemPrompt: wc?.promptFragment ?? wc?.systemPrompt ?? champion?.systemPrompt ?? cfg.basePrompt ?? '',
          label: wc?.label ?? pick.best.id,
        };
        championIdInLastRun = pick.best.id;
        promoted = true;
      } else if (!champion) {
        // A regua segurou o titulo logo na 1a rodada.
        const controlC = runRec.contestants.find((c) => c.id === controlId);
        champion = {
          contestantId: controlId,
          systemPrompt: controlC?.systemPrompt ?? cfg.basePrompt ?? '',
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
      const medalRow = computeMedals(runRec).find((r) => r.contestantId === championIdInLastRun);
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
        });
        log(sessionId, `iteracao ${i + 1}: promovido ${champion.contestantId} (ganho +${pick.gain.toFixed(1)}pp)`);
      }
      await saveSession(record);

      if (!promoted) {
        // Convergiu: a promocao exige margem real sobre o campeao. Sem ganho —
        // mesmo ja na iteracao 0 — nao ha campeao NOVO de onde derivar a
        // proxima geracao; continuar so queimaria custo re-testando a regua.
        record.convergedAtIteration = i;
        emitSessionEvent({ type: 'session.converged', sessionId, iteration: i });
        log(sessionId, `convergiu na iteracao ${i + 1} (ganho ${pick.gain.toFixed(1)}pp < minGain ${minGain})`);
        await saveSession(record);
        break;
      }
    }

    // 6) Gate final: holdout + significancia. NUNCA derruba a sessao — falha
    //    aqui vira warn e o treino termina com o que se tem.
    try {
      // O holdout e uma run extra. Sem orcamento para ela o campeao fica NAO
      // VALIDADO contra sobreajuste — e isso precisa aparecer no resultado, nao
      // sumir. Ver `holdoutSkipped`.
      const estHoldout =
        holdoutStages.length > 0 ? estIter * (holdoutStages.length / Math.max(1, cfg.stages)) : 0;
      if (record.stoppedReason || (estHoldout > 0 && !ledger.canAfford(estHoldout))) {
        record.holdoutSkipped = true;
        log(
          sessionId,
          'holdout pulado (orcamento/cancelamento): campeao NAO validado contra sobreajuste',
        );
      } else {
        await finalizeHoldout(record, apiKey, champion, championIdInLastRun, holdoutStages, prevRun, {
          ledger,
          signal: opts.signal,
        });
      }
    } catch (err) {
      if (isControlSignal(err)) {
        record.holdoutSkipped = true;
        record.stoppedReason =
          record.stoppedReason ?? (err.benchControl === 'budget' ? 'budget' : 'cancelled');
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
    record.status = record.stoppedReason ? 'aborted' : 'finished';
    record.finishedAt = nowIso();
    await saveSession(record);
    emitSessionEvent({ type: 'session.finished', sessionId, record });
    log(sessionId, `finished: custo ${record.totalCostUsd}`);
  } catch (err) {
    syncLedger();
    if (isControlSignal(err)) {
      // Orcamento/cancelamento: sessao interrompida COM resultado parcial.
      record.status = 'aborted';
      record.stoppedReason = err.benchControl === 'budget' ? 'budget' : 'cancelled';
      if (err.benchControl === 'budget') record.budgetExhausted = true;
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
 * significancia estatistica (bootstrap pareado). E SUPORTE A DECISAO (a UI
 * mostra ganho/regressao/p-valor); nao bloqueia a promocao nem derruba a
 * sessao (o chamador envolve em try/catch).
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

  let holdoutRun: RunRecord | undefined;
  // Fase 4, treino com agente e reps>1: o pareamento do holdout (e da
  // significancia) usa o veredito AGREGADO por cenário, nao o vetor plano por
  // (cenário × rep) — mantém o comportamento atual ate a sub-tarefa de reps
  // expor `referenceJudge.verdictsByRep`.
  if (cfg.agent && (cfg.agent.repetitions ?? 1) > 1) {
    console.warn(
      `[train ${sessionId}] holdout pareado por cenário (reps não pareadas) — agent.repetitions=${cfg.agent.repetitions}`,
    );
  }
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

    // Multi-prompt: no holdout o systemPrompt efetivo e a composicao do grupo
    // (controle = base do fragmento + irmaos; campeao = fragmento vencedor).
    const comporHoldout = (fragmento: string): string =>
      cfg.promptGroup ? composePrompt(cfg.promptGroup, cfg.promptId, fragmento) : fragmento;
    const contestants: Contestant[] = [
      {
        id: 'holdout-control',
        label: 'Controle (base)',
        modelId: cfg.contestantModelId,
        systemPrompt: comporHoldout(basePrompt),
        // Fase 4: holdout com agente precisa do runner para nao medir chat (§29.2).
        ...(cfg.agent ? { runner: 'agent' as const } : {}),
      },
      {
        id: 'holdout-champion',
        label: 'Campeao (final)',
        modelId: cfg.contestantModelId,
        systemPrompt: comporHoldout(champion.systemPrompt),
        // Fase 4: mesmo runner no campeao do holdout.
        ...(cfg.agent ? { runner: 'agent' as const } : {}),
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
    } else {
      record.totalCostUsd += holdoutRun.totalCostUsd;
    }
    if (holdoutRun.status !== 'finished') {
      console.warn(
        `[train ${sessionId}] run de holdout terminou com status ${holdoutRun.status}; gate descartado`,
      );
      holdoutRun = undefined; // cai no fallback de significancia abaixo
    }
  }

  if (holdoutRun) {
    const controlScore = judgeScoreOf(holdoutRun, 'holdout-control');
    const championScore = judgeScoreOf(holdoutRun, 'holdout-champion');
    record.holdout = {
      n: holdoutStages.length,
      controlScore,
      championScore,
      gain: championScore - controlScore,
      regressed: championScore < controlScore,
    };
    emitSessionEvent({ type: 'session.holdout', sessionId, holdout: record.holdout });
    const { controlScores, championScores } = pairedStageScores(
      holdoutRun,
      'holdout-control',
      'holdout-champion',
    );
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
        lastRun,
        pairingControl,
        championIdInLastRun,
      );
      record.significance = pairedSignificance(controlScores, championScores);
    } else {
      // Campeao == controle (convergiu sem ganho) ou ids ausentes na run:
      // nao ha comparacao a testar.
      record.significance = null;
    }
  }
  await saveSession(record);
}
