const randomUUID = (): string => crypto.randomUUID();
import {
  batchCountFor,
  describeDatagenShortfall,
  generateStages,
  itemSaturationReport,
  scenarioPolicyReport,
  type DatagenReport,
} from './datagen';
import { countCompetitorOutcomes, runCompetitor } from './competitor';
import {
  judgeStage,
  judgeStageCascade,
  JUDGE_LISTWISE_CONTRACT_TEXT,
  summarizeJudgeCascade,
  type JudgeStageParams,
} from './judge';
import { generateReferences, validateGeneratedReferences } from './gabarito';
import {
  judgeStageReference,
  judgeStageReferenceCascade,
  type JudgeStageReferenceParams,
} from './refJudge';
import { blindRankMap, DUEL_HEAD, pickFinalists, runStageDuels, seedFromId, VERDICT_SCORE } from './duels';
import { buildFinalStandings, oracleScoresFromVerdicts } from '../../../src/engine/duelCore.js';
import { assessVerdictIntegrity } from '../../../src/engine/verdictIntegrity.js';
import { lowConfidenceReviewItems, stageCountsInJudgeScore, VERDICT_AGGREGATION } from '../../../src/engine/verdictAggregate.js';
import { humanReviewQueueFromStages } from '../../../src/engine/groundTruth.js';
import { fairnessWarningsForModels } from './llmVariants';
import { JUDGE_CONTRACT_TEXT } from './refJudge';
import { judgeStageListwiseJev, judgeStageReferenceJev, JEV_JUDGE_CONTRACT_TEXT } from './jevJudge';
import {
  contractDrift,
  judgeContractAudit,
  noteJudgeContract,
  pinJudgeContract,
  pipelineContractComponents,
  previousContractPin,
  runCounterfactualProbes,
  verbosityReport,
  verbositySamples,
  type CounterfactualProbePair,
  type VerbositySampleRow,
} from '../../../src/engine/judgeCalibration.js';
import type { JudgeContractComponents } from './types';
import { modelRolesForRun, snapshotModelLifecycle } from '../../../src/engine/modelLifecycle.js';
import { mergeScenariosReport } from './scenarioPack';
import { sanitizeLlmVariants, variantsToContestants } from './llmVariants';
import { judgeScoreFromVerdicts } from './rank';
import { runCompleteness } from './stats';
import { emitEvent } from './events';
import { listRuns, loadRun, saveRun } from './storage';
import {
  CallJournal,
  clearIdbCallJournal,
  discountByRole,
  idbCallJournalStore,
  journalEnabledFor,
  loadIdbCallJournal,
  resumeBudgetUsd,
  resumeInfoFor,
  resumeRefusal,
} from './callJournal';
import { withStageCountInRange } from '../../../src/engine/stageCount.js';
import { contestantsFromConfig } from './normalize';
import { AUDITABLE_ROLES, gatewayErrorFields, isFatalGatewayError, listModels, reconcileAtRunEnd } from './openrouter';
import { enforceRunCompliance } from '../lgpd';
import { BudgetLedger, isControlSignal, RunCancelled, toControlSignal } from './budget';
import { estimateInputFromConfig, estimateRunCost, makeCallEstimator } from './estimate';
import { reasoningLevelForRole } from '../modelCaps';
import { roleTimeoutMs } from './roleLimits';
import { pipelineMetaPromptsFingerprint } from '../../../src/metaPrompts.js';
import { stageSecurity, summarizeSecurity } from '../../../src/engine/contracts.js';
import { assertRoleSeparation, judgingModelIds } from '../../../src/engine/roleSeparation.js';
import { acquireLock } from './runLocks';
import {
  cutDuels,
  cutVerdicts,
  describeJudgeCut,
  describeTruncatedReference,
  describeTruncatedStage,
  truncatedResponses,
  truncationAlert,
  truncationByRoleEffort,
  truncationCellAlert,
  truncationRecordFields,
} from '../../../src/engine/truncation.js';
import type {
  CallFinishSignals,
  Contestant,
  RunConfig,
  RunCtx,
  RunPhase,
  RunRecord,
  StageRecord,
  StageSpec,
  ReasoningLevel,
} from './types';

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * cli#3 (espelho do Node) — o que NUNCA degrada numa etapa: sinal de CONTROLE (orçamento/
 * cancelamento) e falha FATAL do gateway (401 key recusada / 402 sem crédito).
 * Nenhum retry nem outro modelo conserta estas; degradar deixava a run
 * "concluir" com etapas vazias e sair com exit 1 em vez do 4/5 documentado.
 */
function mustPropagate(err: unknown): boolean {
  return isControlSignal(err) || isFatalGatewayError(err);
}

function log(runId: string, msg: string, extra?: Record<string, unknown>): void {
  const payload = extra ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[bench ${runId}] ${msg}${payload}`);
}

// ---------------------------------------------------------------------------
// Cancelamento (IMPL-020, R-10:REC-3). Cada run tem UM AbortController RAIZ,
// criado aqui e propagado a TODAS as chamadas pelo `ctx.signal` (o gateway o
// repassa ao fetch e à fila do limitador). O botão Cancelar da UI aborta a
// raiz: o que está em voo morre, o que está na fila do limitador sai dela e as
// portas de fase recusam novo grupo — nenhuma chamada nova começa depois do
// clique. O motivo do abort já é um RunCancelled: qualquer rejeição que o
// transporte devolva carrega o sinal de CONTROLE, nunca um erro comum que os
// papéis degradariam em nota inventada.
// ---------------------------------------------------------------------------
const runControllers = new Map<string, AbortController>();

/**
 * Cancela uma run em andamento NESTA aba. Devolve false se a run não está
 * rodando aqui (já terminou, ou é de outra aba/sessão do navegador).
 */
export function cancelRun(runId: string, reason = 'cancelada pelo usuario'): boolean {
  const ctrl = runControllers.get(runId);
  if (!ctrl || ctrl.signal.aborted) return false;
  ctrl.abort(new RunCancelled(reason));
  return true;
}

/** true = a run está rodando nesta aba e ainda pode ser cancelada. */
export function isRunCancellable(runId: string): boolean {
  const ctrl = runControllers.get(runId);
  return Boolean(ctrl && !ctrl.signal.aborted);
}

function applyScoreboard(
  scoreboard: Record<string, number>,
  rankedContestantIds: string[],
): void {
  // pontos: melhor recebe N-1, proximo N-2, ... pior 0
  const n = rankedContestantIds.length;
  rankedContestantIds.forEach((contestantId, idx) => {
    const points = n - 1 - idx;
    scoreboard[contestantId] = (scoreboard[contestantId] ?? 0) + points;
  });
}

export interface StartRunResult {
  runId: string;
  record: RunRecord;
}

export interface StartRunOpts {
  /** Id pre-gerado da run (treino emite iteration.started antes de rodar). */
  runId?: string;
  /** Contestants resolvidos (variation/training). Em compare derivam da config. */
  contestants?: Contestant[];
  /** Especificacoes de etapa pre-geradas — pula o datagen (benchmark pinado do treino). */
  pinnedStages?: StageSpec[];
  /**
   * Resolve os contestants no inicio da run (ex.: gerar variantes via optimizer),
   * emitindo variants.generating/generated. Usado pelo modo variacao.
   * Recebe o `ctx` DA RUN (sinal + ledger): sem ele o reescritor chamava o
   * gateway sem `sink` e o custo das variantes escapava do ledger e das
   * portas de orcamento (IMPL-021 — soma(papeis) == fatura).
   */
  prepare?: (ctx: RunCtx) => Promise<Contestant[]>;
  sessionId?: string;
  iteration?: number;
  parentRunId?: string;
  /**
   * Sinal EXTERNO (a sessão de treino): abortá-lo aborta a raiz desta run. A
   * run tem sempre a PRÓPRIA raiz (cancelável por `cancelRun`), ligada a este.
   */
  signal?: AbortSignal;
  /**
   * Ledger EXTERNO (sessão de treino): a run reporta o próprio total e escreve
   * no pai (espelho de src/orchestrator.ts). Ausente => a run cria o próprio,
   * com o teto `config.budgetUsd`.
   */
  parentLedger?: BudgetLedger;
  /**
   * IMPL-081 (espelho do Node) — journal de chamadas PRONTO (a retomada o passa
   * carregado com as respostas das tentativas anteriores). Ausente => a run
   * avulsa de chat cria o seu, vazio (IndexedDB); rodada de treino não grava.
   */
  callJournal?: CallJournal;
  /**
   * Teto EFETIVO desta execução quando a run cria o próprio ledger. A
   * retomada passa o que SOBROU do teto original — nunca o teto inteiro de novo.
   */
  budgetUsd?: number;
}

/**
 * Copia o ledger para o record. O custo da run é o do LEDGER — alimentado de
 * dentro do gateway (`usage.cost` medido, catálogo só como fallback) para
 * TODOS os papéis — e não mais a soma dos competidores a preço de catálogo
 * (IMPL-021; a SPA subcontava por um múltiplo e ignorava cache/raciocínio).
 */
function syncLedger(record: RunRecord, ledger: BudgetLedger): void {
  const snap = ledger.snapshot();
  record.totalCostUsd = snap.spentUsd;
  record.costByRole = snap.byRole;
  record.costAccuracy = snap.accuracy;
  record.costLedger = ledger.summary(); // IMPL-017: spent/committed/pending
  // IMPL-074 (espelho do Node): registo por chamada (id de geração/provedor/conciliação).
  record.callLog = ledger.callLog();
  if (ledger.callLogDropped > 0) record.callLogDropped = ledger.callLogDropped;
  // IMPL-014 (espelho do Node): sinais de fim por papel + taxa de truncamento
  // da run, do MESMO ponto unico do custo — 100% das chamadas, juiz inclusive.
  Object.assign(record, truncationRecordFields(snap.finishByRole));
  // IMPL-081 (espelho do Node): quantas respostas desta tentativa vieram do journal.
  const journal = ledger.callJournal();
  if (record.resume && journal) {
    const st = journal.stats();
    record.resume.replayedCalls = st.replayedCalls;
    record.resume.replayedUsd = st.replayedUsd;
  }
}

/**
 * Contestants do modo compare. compare-llms (competitorConfigs): as variantes
 * de config {modelo, temperatura, reasoning} viram os contestants (identidade =
 * tripla) e a PRIMEIRA e marcada isOriginal — ancora dos duelos/standings —
 * sem mudar o label. Saneamento invalido NAO lanca aqui (buildRecord e
 * sincrono): cai no fallback classico e o runLoop revalida para falhar a run
 * cedo com a mensagem PT-BR do sanitize.
 */
function compareContestants(config: RunConfig): Contestant[] {
  if (config.mode !== 'compare' || !config.competitorConfigs?.length) {
    return contestantsFromConfig(config);
  }
  const sane = sanitizeLlmVariants(config.competitorConfigs);
  if (sane.error) return contestantsFromConfig(config);
  for (const w of sane.warnings) console.warn(`[compare-llms] ${w}`);
  const contestants = variantsToContestants(sane.variants);
  // web-code#16: só o eixo compare-llms tem âncora; lista de MODELOS
  // (competitorAnchor: false) não tem controle.
  if (contestants[0] && config.competitorAnchor !== false) {
    contestants[0] = { ...contestants[0], isOriginal: true };
  }
  return contestants;
}

function buildRecord(config: RunConfig, opts: StartRunOpts): RunRecord {
  const runId = opts.runId ?? randomUUID();
  const concurrency = Math.max(1, config.concurrency ?? 8);
  const timeoutMs = config.timeoutMs ?? 60_000;
  const contestants = opts.contestants ?? compareContestants(config);
  // left#13 (web-code#15, espelho do Node): nº de cenários na faixa documentada
  // (inteiro 1–50) também no motor — a SPA não tem zod na frente do startRun.
  const noIntervalo = withStageCountInRange(config);
  if (noIntervalo !== config) {
    console.warn(`[bench ${runId}] stages ${String(config.stages)} fora da faixa (inteiro 1–50): usando ${noIntervalo.stages}`);
  }

  return {
    id: runId,
    status: 'running',
    config: { ...noIntervalo, concurrency, timeoutMs },
    mode: config.mode,
    contestants,
    stages: [],
    scoreboard: Object.fromEntries(contestants.map((c) => [c.id, 0])),
    costByContestant: Object.fromEntries(contestants.map((c) => [c.id, 0])),
    totalCostUsd: 0,
    // IMPL-010: sempre presente numa run nova — "0 bloqueios" e informacao.
    competitorOutcomeCounts: { blocked: 0, refused: 0, error: 0 },
    // IMPL-014: idem — "0% truncado" tambem e informacao.
    truncationRate: 0,
    truncationCounts: { calls: 0, truncated: 0 },
    // IMPL-007: vereditos de painel por MAIORIA SIMPLES (empate tecnico) — marca a
    // escala do judge-score; record sem isto = media ordinal antiga (inflada).
    verdictAggregation: VERDICT_AGGREGATION,
    startedAt: nowIso(),
    sessionId: opts.sessionId,
    iteration: opts.iteration,
    parentRunId: opts.parentRunId,
  };
}

/**
 * Recusa de executar (IMPL-023): o lock da run já tem dono — outra aba a está
 * executando. Executar de novo somaria gasto na mesma key sem ninguém ver.
 */
export const RUN_LOCKED_ELSEWHERE =
  'Esta run já está em execução em outra aba deste navegador — nada foi executado aqui.';

/** Estado que o runLoop publica para o fechamento em executeRun. */
interface RunState {
  /** Criado no runLoop, depois do catálogo (a reserva otimista precisa dele). */
  ledger?: BudgetLedger;
  /** Grupo de fase em curso — vira `stoppedAtPhase` se um sinal de controle subir. */
  phase?: RunPhase;
}

/**
 * Executa o loop e SEMPRE resolve com o record final (finished/aborted/error).
 * Espelho do fechamento de src/orchestrator.ts: orçamento/cancelamento são
 * CONTROLE, não erro — a run sai `aborted` com `stoppedReason` e o resultado
 * parcial honesto (etapas cortadas marcadas `incomplete`, fora do placar).
 */
async function executeRun(
  record: RunRecord,
  apiKey: string,
  opts: StartRunOpts,
): Promise<RunRecord> {
  const root = new AbortController();
  const onParentAbort = (): void => root.abort(opts.signal?.reason);
  if (opts.signal?.aborted) root.abort(opts.signal.reason);
  else opts.signal?.addEventListener('abort', onParentAbort, { once: true });
  runControllers.set(record.id, root);

  // IMPL-023 (R-10:REC-1): lock EXCLUSIVO da run (Web Locks) ANTES da primeira
  // gravação e segurado até DEPOIS da última. Assim nenhuma outra aba vê este
  // record 'running' sem dono (não o marca órfão) e nenhuma o executa de novo.
  // Se a aba morrer, o navegador solta o lock e a próxima carga marca a órfã.
  const lock = await acquireLock('run', record.id);
  if (!lock) {
    // Outra aba é a dona: NÃO grava (o record no disco é dela) e não executa.
    runControllers.delete(record.id);
    opts.signal?.removeEventListener('abort', onParentAbort);
    record.status = 'error';
    record.error = RUN_LOCKED_ELSEWHERE;
    record.finishedAt = nowIso();
    console.warn(`[bench ${record.id}] ${RUN_LOCKED_ELSEWHERE}`);
    emitEvent({ type: 'run.error', runId: record.id, error: record.error });
    return record;
  }

  const state: RunState = {};
  try {
    await runLoop(record, apiKey, opts, root.signal, state);
    // As portas suaves saem do runLoop com `return` (sem lançar) — é o que
    // preserva o parcial. O fechamento terminal acontece aqui.
    if (record.status === 'running') {
      // IMPL-074 (espelho do Node): pendentes conciliadas pela fatura antes da escrita terminal.
      if (state.ledger && record.stoppedReason !== 'cancelled') await reconcileAtRunEnd(state.ledger, apiKey);
      if (state.ledger) syncLedger(record, state.ledger);
      record.status = record.stoppedReason ? 'aborted' : 'finished';
      record.finishedAt = nowIso();
      await saveRun(record);
      emitEvent({ type: 'run.finished', runId: record.id, record });
      log(record.id, `run encerrada cedo (${record.stoppedReason ?? 'sem fase executavel'})`, {
        totalCostUsd: record.totalCostUsd,
      });
    }
  } catch (err) {
    // IMPL-074: concilia as pendentes (menos no Cancelar: sai na hora).
    const cancelou = isControlSignal(err) && err.benchControl !== 'budget';
    if (state.ledger && !cancelou) await reconcileAtRunEnd(state.ledger, apiKey);
    // Mesmo falhando, o que já foi gasto aparece no record.
    if (state.ledger) syncLedger(record, state.ledger);
    if (isControlSignal(err)) {
      record.status = 'aborted';
      record.stoppedReason = err.benchControl === 'budget' ? 'budget' : 'cancelled';
      if (err.benchControl === 'budget') record.budgetExhausted = true;
      record.stoppedAtPhase ??= state.phase;
      for (const st of record.stages) {
        // Etapa que não chegou a ser julgada foi CORTADA: fica fora do placar e
        // das médias — sem veredito inventado para completar o quadro.
        if (st.spec && !st.error && !st.judge && !st.incomplete) {
          st.incomplete = true;
          st.incompleteReason = record.stoppedReason;
          st.finishedAt ??= nowIso();
        }
      }
      record.finishedAt = nowIso();
      log(record.id, `run interrompida (${record.stoppedReason})`, {
        totalCostUsd: record.totalCostUsd,
      });
      await saveRun(record);
      emitEvent({ type: 'run.finished', runId: record.id, record });
    } else {
      console.error(`[bench ${record.id}] run.error:`, err);
      record.status = 'error';
      record.error = err instanceof Error ? err.message : String(err);
      // cli#3 (espelho do Node): a classe da falha do gateway, estruturada.
      Object.assign(record, gatewayErrorFields(err));
      record.finishedAt = nowIso();
      await saveRun(record);
      emitEvent({ type: 'run.error', runId: record.id, error: record.error });
    }
  } finally {
    runControllers.delete(record.id);
    opts.signal?.removeEventListener('abort', onParentAbort);
    // IMPL-081 (espelho do Node): run CONCLUÍDA não tem o que retomar — o
    // journal some. Abortada/com erro mantém o dela para a retomada.
    const journal = state.ledger?.callJournal();
    if ((record.status === 'finished' || record.status === 'inconclusive') && journal && journalEnabledFor(record)) {
      await clearIdbCallJournal(record.id, journal.entryIds());
    }
    // Só depois do checkpoint final (os `await saveRun` acima): soltar antes
    // abriria a janela em que outra aba vê 'running' sem dono.
    lock.release();
  }
  return record;
}

/** Dispara a run em background e retorna imediatamente. */
export function startRun(config: RunConfig, apiKey: string, opts: StartRunOpts = {}): StartRunResult {
  const record = buildRecord(config, opts);
  void executeRun(record, apiKey, opts);
  return { runId: record.id, record };
}

/** Roda ate o fim e resolve com o record final (usado pelo trainer). */
export function runToCompletion(
  config: RunConfig,
  apiKey: string,
  opts: StartRunOpts = {},
): Promise<RunRecord> {
  const record = buildRecord(config, opts);
  return executeRun(record, apiKey, opts);
}

// ---------------------------------------------------------------------------
// IMPL-081 (espelho do Node) — RETOMADA: a run órfã (aba fechada/recarregada),
// cancelada, cortada por orçamento ou com erro roda de novo com o MESMO id e a
// MESMA config; as chamadas já pagas voltam do journal (IndexedDB) a US$ 0.
// ---------------------------------------------------------------------------

/** Refusa com o motivo quando a run não pode ser retomada. */
export class ResumeRefusedError extends Error {
  readonly code = 'run.not_resumable' as const;
  constructor(readonly reason: string) {
    super(`Esta run não pode ser retomada: ${reason}`);
    this.name = 'ResumeRefusedError';
  }
}

/**
 * Retoma a run NESTA aba (em background, como `startRun`). O record é
 * RECONSTRUÍDO do zero — nenhuma etapa carregada pela metade; só as chamadas
 * vêm do journal — e carimbado com `resume`. O teto é o que sobrou do original.
 * Quem chama decide órfã × viva antes (o lock da run: `reconcileRun`); se
 * outra aba segurar a run, o `executeRun` recusa sem gastar nada.
 */
export async function resumeRun(runId: string, apiKey: string, opts: StartRunOpts = {}): Promise<StartRunResult> {
  const prev = await loadRun(runId);
  if (!prev) throw new ResumeRefusedError('run não encontrada neste navegador.');
  const motivo = resumeRefusal(prev);
  if (motivo) throw new ResumeRefusedError(motivo);
  const entries = await loadIdbCallJournal(runId);
  const record = buildRecord(prev.config, { ...opts, runId });
  record.startedAt = prev.startedAt;
  record.resume = resumeInfoFor(prev, entries.length);
  const callJournal = new CallJournal({
    store: idbCallJournalStore(runId),
    entries,
    onError: (err) => console.warn(`[bench ${runId}] journal de chamadas: falhou ao gravar (a retomada pagaria de novo):`, err),
  });
  void executeRun(record, apiKey, {
    ...opts,
    runId,
    callJournal,
    budgetUsd: opts.budgetUsd ?? resumeBudgetUsd(prev),
  });
  return { runId, record };
}

async function runLoop(
  record: RunRecord,
  apiKey: string,
  opts: StartRunOpts,
  signal: AbortSignal,
  state: RunState,
): Promise<void> {
  const { id: runId } = record;

  // left#13 (IMPL-048, espelho do Node): papéis separados ANTES de qualquer
  // chamada. O portão da SPA (api.ts) já barra; isto é a defesa para quem
  // chama o motor direto (a run sai 'error', nada gasto).
  assertRoleSeparation(record.config);

  // --- Persistencia com THROTTLE: as etapas paralelas geram MUITAS escritas;
  // coalescemos em no max. 1x/SAVE_INTERVAL_MS (trailing) e damos flush nos
  // marcos. O estado ao vivo ja vai por SSE, entao o disco nao precisa de cada
  // delta. O IndexedDB serializa as transacoes de escrita da mesma store na
  // ordem de criacao (record + resumo numa transacao so — storage.ts).
  // IMPL-022: saveRun NUNCA rejeita — falha de gravacao vira evento
  // `storage.*` + aviso na UI (nada de `.catch(() => undefined)` aqui). A batida
  // periodica e 'relaxed' (a proxima a sobrescreve); marcos e fechamento sao
  // checkpoint 'strict' (default do saveRun). ---
  const SAVE_INTERVAL_MS = 800;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSave = 0;
  const scheduleSave = (): void => {
    if (saveTimer) return;
    const delay = Math.max(0, SAVE_INTERVAL_MS - (Date.now() - lastSave));
    saveTimer = setTimeout(() => {
      saveTimer = null;
      lastSave = Date.now();
      void saveRun(record, { durability: 'relaxed' });
    }, delay);
  };
  const flushSave = async (): Promise<void> => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    lastSave = Date.now();
    await saveRun(record);
  };

  await saveRun(record);
  emitEvent({ type: 'run.started', runId, record });
  log(runId, 'started', {
    mode: record.mode,
    stages: record.config.stages,
    contestants: record.contestants.length,
  });

  // Catálogo QUENTE antes do primeiro gasto (espelho do Node): é o fallback de
  // preço quando falta `usage.cost`, a allowlist de esforço/amostragem por
  // modelo e a base das portas de orçamento (sem ele tudo "custa zero").
  // Vem DEPOIS do run.started para a tela da run abrir sem esperar a rede.
  const catalogo = await listModels(apiKey).catch((err: unknown) => {
    console.warn(`[bench ${runId}] catalogo indisponivel: ${(err as Error).message}`);
    return [];
  });

  // IMPL-019 (espelho do Node) — ciclo de vida de TODO modelo da run, do
  // catálogo já carregado: canonicalSlug/expirationDate/aliasTarget por papel +
  // alertas 30/14/7 dias. Nunca migra sozinho: só grava e avisa. Recapturado
  // quando o `prepare` troca os contestants.
  const avisados = new Set<string>();
  const captureLifecycle = (): void => {
    record.modelLifecycle = snapshotModelLifecycle(
      modelRolesForRun(record.config, record.contestants),
      catalogo,
      new Date(),
    );
    for (const a of record.modelLifecycle.alerts) {
      if (avisados.has(a.modelId)) continue;
      avisados.add(a.modelId);
      console.warn(`[bench ${runId}] ciclo de vida: ${a.message}`);
    }
  };
  captureLifecycle();

  // Ledger (fonte ÚNICA em src/budget.ts, via shim): filho do da sessão
  // (treino — o teto é da SESSÃO e vive na raiz) ou próprio, com o teto da run.
  const ledger =
    opts.parentLedger?.fork() ??
    new BudgetLedger({
      budgetUsd: opts.budgetUsd ?? record.config.budgetUsd,
      signal,
      estimateCall: makeCallEstimator(catalogo),
    });
  state.ledger = ledger;
  // IMPL-081 (espelho do Node): journal de chamadas PAGAS no IndexedDB — replay
  // a US$ 0 na retomada, gravação 'strict' depois de cada resposta. Só a run
  // AVULSA de chat (rodada de treino e modo agente não gravam).
  const journal =
    opts.callJournal ??
    (journalEnabledFor(record)
      ? new CallJournal({
          store: idbCallJournalStore(runId),
          onError: (err) => console.warn(`[bench ${runId}] journal de chamadas: falhou ao gravar (a retomada pagaria de novo):`, err),
        })
      : undefined);
  if (journal) ledger.setCallJournal(journal);
  // Contexto que atravessa todos os módulos de papel: o gateway contabiliza
  // cada chamada no ledger com o papel certo e repassa o sinal RAIZ da run ao
  // fetch e à fila do limitador — um ponto só, o mesmo do Node.
  const ctx: RunCtx = { signal, sink: ledger };
  // Com `parentLedger` (rodada de treino) este é o teto da SESSÃO — é ele que
  // governa a run; a tela o rotula como tal pelo `sessionId` (RunView).
  record.budgetUsd = ledger.snapshot().budgetUsd;

  // Estimativa por papel — base das PORTAS SUAVES (espelho do Node).
  // ⚠️ Em variation standalone (`opts.prepare`) os contestants ainda NÃO
  // existem aqui: `contestantIds: []` estimaria ZERO competidores e a porta
  // atômica G2 nunca dispararia (a run pagava as respostas e parava sem nota,
  // passando do teto). Lista vazia => deixa o estimador contar técnicas+base,
  // e a estimativa é refeita com os contestants reais depois do `prepare`.
  // Degrau por contestant = o que o competidor recebe (IMPL-016, espelho do Node).
  // `stagesReais` (web-live#7, espelho do Node): se o datagen entregou menos,
  // a porta G2 projeta com o n REAL.
  // IMPL-081 (espelho do Node): na RETOMADA a projeção desconta o que o journal cobre.
  const jaPagoPorPapel = journal?.loadedUsdByRole() ?? {};
  const descontarJournal = <E extends { byRole: Record<string, number> }>(e: E): E =>
    Object.keys(jaPagoPorPapel).length > 0 ? { ...e, byRole: discountByRole(e.byRole, jaPagoPorPapel) } : e;
  const estimar = (
    contestants: ReadonlyArray<{ id: string; reasoningLevel?: ReasoningLevel }>,
    stagesReais?: number,
  ) =>
    descontarJournal(estimateRunCost(
      estimateInputFromConfig(
        (stagesReais !== undefined
          ? { ...record.config, stages: Math.max(1, stagesReais) }
          : record.config) as never,
        contestants.length > 0
          ? {
              contestantIds: contestants.map((c) => c.id),
              contestantReasoningLevels: contestants.map(
                (c) => c.reasoningLevel ?? record.config.reasoning?.competitor,
              ),
            }
          : {},
      ),
      catalogo,
      // Preço desconhecido (roteador, "-1") pelo PIOR CASO — espelho do Node (IMPL-018).
      { unknownPrice: 'worst-case' },
    ));
  let est = estimar(record.contestants);

  /** Cancelamento: a raiz da run (ou a sessão, via ledger) abortou => controle. */
  const throwIfCancelled = (): void => {
    if (signal.aborted) throw toControlSignal(signal.reason);
    ledger.throwIfCancelled();
  };

  /**
   * Porta suave (espelho do Node). A unidade NÃO é "uma fase", é um GRUPO que
   * produz resultado coerente: competidores+julgamento são atômicos, porque
   * autorizar respostas sem poder pagar o julgamento produz etapas com resposta
   * e sem nota. Checa o cancelamento ANTES de autorizar novo grupo. Devolver
   * false NÃO lança: o controle cai no fechamento (aborted/budget).
   */
  const gate = (phase: RunPhase, projectedUsd: number): boolean => {
    state.phase = phase;
    throwIfCancelled();
    if (ledger.canAfford(projectedUsd)) return true;
    record.budgetExhausted = true;
    record.stoppedAtPhase = phase;
    record.stoppedReason = 'budget';
    emitEvent({
      type: 'run.budget',
      runId,
      phase,
      projectedUsd,
      remainingUsd: ledger.remainingUsd() ?? 0,
      decision: 'stop',
    });
    log(runId, `orcamento insuficiente para ${phase}`, {
      projectedUsd,
      remainingUsd: ledger.remainingUsd(),
    });
    return false;
  };

  // compare-llms: falha a run CEDO (antes de qualquer chamada de LLM) se as
  // variantes forem invalidas. buildRecord nao pode lancar (e sincrono e a
  // rota espera o record de volta); sanitize e puro/barato, rodar 2x e inocuo.
  if (
    !opts.contestants &&
    record.config.mode === 'compare' &&
    record.config.competitorConfigs?.length
  ) {
    const sane = sanitizeLlmVariants(record.config.competitorConfigs);
    if (sane.error) throw new Error(sane.error);
  }

  // LGPD (IMPL-041): área SENSÍVEL é fail-closed — todo papel que vê o dado
  // (competidor, juiz/duelo, gerador, gabarito, reescritor) precisa de endpoint
  // ZDR na allowlist fresca; senão a run é recusada AQUI, antes de qualquer LLM.
  // IMPL-042: + dado pessoal de aparência real recusa a run ("só sintético",
  // modo agente, ou "redigir" sem `allowPii`). Runs de uma sessão só relatam:
  // o config da SESSÃO já passou. O relatório (campo + tipos, nunca o valor)
  // fica no record — pseudonimizar no envio nunca é correção silenciosa.
  const preflight = await enforceRunCompliance(record.config, undefined, {
    nested: Boolean(record.sessionId),
  });
  if (preflight.piiReport) record.piiReport = preflight.piiReport;
  // IMPL-040: área sensível ⇒ o gateway força o roteamento ZDR em TODA chamada
  // desta run (a política viaja no ledger, que todo papel recebe via ctx.sink).
  ledger.setSensitiveRouting(preflight.sensitiveRouting);
  // IMPL-075: modo AUDITÁVEL por run (`config.auditable`) — juiz, duelo e gabarito com
  // provedor travado; como o modo sensível, só liga e vale para a cadeia abaixo.
  if (record.config.auditable) ledger.setAuditableRoles(AUDITABLE_ROLES);

  // Resolve contestants on-demand (variacao: gera as variantes via optimizer).
  if (opts.prepare) {
    if (!gate('variants', est.byRole.rewriter)) {
      record.stages = [];
      syncLedger(record, ledger);
      return;
    }
    emitEvent({ type: 'variants.generating', runId });
    const contestants = await opts.prepare(ctx);
    throwIfCancelled();
    if (contestants.length < 2) {
      throw new Error(
        'Variacao precisa de ao menos 2 contestants validos (verifique as tecnicas/variantes ou o modelo optimizer).',
      );
    }
    record.contestants = contestants;
    record.scoreboard = Object.fromEntries(contestants.map((c) => [c.id, 0]));
    record.costByContestant = Object.fromEntries(contestants.map((c) => [c.id, 0]));
    captureLifecycle();
    // As portas seguintes (G1, G2 atômica, finais) medem com os contestants REAIS.
    est = estimar(contestants);
    await saveRun(record);
    emitEvent({ type: 'variants.generated', runId, contestants });
  }

  // Datagen em lote/gabaritos podem ser lentos (varios cenarios por chamada,
  // as vezes com reasoning): folga alem do timeout dos competidores.
  // extra#2: timeout EFETIVO por papel (src/roleLimits.ts). `config.timeoutMs`
  // (default 60 s) é da RESPOSTA do competidor; juiz/duelo/gabarito/datagen têm
  // piso próprio — num treino real o juiz e o reescritor estouravam os 60 s.
  const cfgTimeout = record.config.timeoutMs;
  const tempoPapel = {
    datagen: roleTimeoutMs('datagen', cfgTimeout, record.config.reasoning?.datagen),
    gabarito: roleTimeoutMs('gabarito', cfgTimeout, reasoningLevelForRole(record.config.reasoning, 'gab')),
    judge: roleTimeoutMs('judge', cfgTimeout, reasoningLevelForRole(record.config.reasoning, 'judge')),
    duel: roleTimeoutMs('duel', cfgTimeout, reasoningLevelForRole(record.config.reasoning, 'duel')),
  };
  const datagenTimeout = tempoPapel.datagen;
  // IMPL-115: modo ECONÔMICO do julgamento — 2 juízes baratos em paralelo e o
  // forte só nos vereditos em dúvida. Ausente = o painel de `judgeModelIds`.
  const cascata = record.config.judgeCascade;
  // JUÍZ JEV (default em todos os modos, espelho de src/orchestrator.ts): o
  // modelo de decisão julga com perguntas tipadas e as bandas auto/hitl/abstain
  // escalam o RESTO para o painel LLM (`judgeModelIds`). `judgeEngine: 'llm'`
  // volta ao painel puro; LGPD/indisponibilidade do Jev caem no painel
  // automaticamente (`jevFallback` no record).
  const judgeEngine = record.config.judgeEngine ?? 'jev';
  const jevJudgeCfg = record.config.jevJudge;
  const julgarPorReferencia = (p: Omit<JudgeStageReferenceParams, 'judgeModelIds'>) =>
    judgeEngine === 'jev'
      ? judgeStageReferenceJev({ ...p, judgeModelIds: record.config.judgeModelIds, jevJudge: jevJudgeCfg })
      : cascata
        ? judgeStageReferenceCascade({ ...p, cheapJudgeIds: cascata.cheap, strongJudgeId: cascata.strong })
        : judgeStageReference({ ...p, judgeModelIds: record.config.judgeModelIds });
  const julgarListwise = (p: Omit<JudgeStageParams, 'judgeModelIds'>) =>
    judgeEngine === 'jev'
      ? judgeStageListwiseJev({ ...p, judgeModelIds: record.config.judgeModelIds, jevJudge: jevJudgeCfg })
      : cascata
        ? judgeStageCascade({ ...p, cheapJudgeIds: cascata.cheap, strongJudgeId: cascata.strong })
        : judgeStage({ ...p, judgeModelIds: record.config.judgeModelIds });

  // Saneia maxTokens (o competidor faz Math.min(maxOutputTokens, stage.maxTokens);
  // ausente/<=0 viraria NaN). Aplica-se a pinadas, seed e geradas.
  const saneMaxTokens = (s: StageSpec): StageSpec => ({
    ...s,
    maxTokens: s.maxTokens && s.maxTokens > 0 ? s.maxTokens : record.config.maxOutputTokens ?? 1000,
  });

  // Etapas pinadas: do treino (opts.pinnedStages — iteracao > 0, ja trazem
  // `reference` congelada) OU fornecidas pelo usuario (config.customStages).
  // Ambas tem precedencia total e pulam o datagen (fluxo atual intacto), MAS
  // entram no fluxo de gabarito (fase 1.5) quando falta `reference`.
  const rawPinned = opts.pinnedStages ?? record.config.customStages;
  const pinnedStages = rawPinned?.map(saneMaxTokens);
  const pinado = Boolean(pinnedStages && pinnedStages.length);

  // Julgamento por referencia efetivo: ligado por default em variation/training
  // e no compare-llms; DESLIGADO no compare classico — runs listwise antigas
  // ficam compativeis em comportamento. Se TODOS os gabaritos falharem,
  // nenhuma etapa tera `reference` e a run inteira degrada para o listwise
  // classico na fase 3 (degrada, nunca crash).
  const referenceJudging =
    record.config.referenceJudging ??
    (record.config.mode !== 'compare' || Boolean(record.config.competitorConfigs?.length));

  // === FASE 1: cenarios. Cria todos os slots e emite stage.generating ANTES
  // da geracao (a UI cria um slot por stageIndex a partir deste evento). ===
  const seed = pinado
    ? []
    : (record.config.scenarioSeed ?? []).map((s) => saneMaxTokens({ ...s, origin: 'import' as const }));
  const alvo = pinado ? pinnedStages!.length : Math.max(record.config.stages, seed.length);
  // F2 §7.9 — REPEATS (só compare): cada cenário roda N× para medir a
  // instabilidade estocástica. Os slots são alvo × N; a expansão das specs
  // acontece DEPOIS do gabarito (clones compartilham a referência — o gabarito
  // continua custando 1× por cenário).
  const repeats =
    record.config.mode === 'compare'
      ? Math.max(1, Math.min(3, Math.round(record.config.repeats ?? 1)))
      : 1;
  record.stages = Array.from(
    { length: alvo * repeats },
    (_, i): StageRecord => ({ index: i, responses: [], startedAt: nowIso() }),
  );
  for (let i = 0; i < record.stages.length; i++) {
    emitEvent({ type: 'stage.generating', runId, stageIndex: i });
  }

  // G1 = datagen + gabaritos: descartável inteiro, antes de gastar com respostas.
  const custoG1 = est.byRole.datagen + est.byRole.gabarito;
  if (!gate('datagen', custoG1)) {
    syncLedger(record, ledger);
    return;
  }

  /**
   * web-live#7 (espelho do Node) — relatório da geração no record, no evento
   * `datagen.report` e no log quando faltou cenário, ANTES de gastar com
   * gabarito/competidores/juízes.
   */
  const publishDatagenReport = (r: DatagenReport): void => {
    record.datagenReport = r;
    emitEvent({ type: 'datagen.report', runId, report: r });
    if (r.warning) log(runId, `datagen: ${r.warning}`);
    if (r.rubricUnanswerable > 0) {
      log(runId, `datagen: ${r.rubricUnanswerable} rubrica(s) exigem fatos ausentes do caso (IMPL-059)`);
    }
  };

  let specs: StageSpec[];
  // web-live#7: relatório da geração (ausente = sem datagen nesta run).
  // (o `as` evita o estreitamento para `undefined`: a atribuição é num callback)
  let datagenReport = undefined as DatagenReport | undefined;
  if (pinado) {
    specs = pinnedStages!;
  } else if (seed.length >= record.config.stages) {
    // O seed cobre (ou excede) o alvo: tudo importado, o datagen NAO e chamado.
    specs = seed;
  } else {
    // Gera em LOTE apenas o que falta para o alvo (batches paralelos + dedup
    // exato/semântico COM o seed como âncora + reposição por diversidade em
    // laço limitado, tudo dentro de generateStages) e mescla: seed primeiro
    // (curadoria do usuario, nunca descartado), gerados como complemento.
    const pedido = alvo - seed.length;
    // Porta suave da reposição: um lote a mais só se couber no orçamento.
    const custoLote = est.byRole.datagen / Math.max(1, batchCountFor(pedido));
    const gerados = await generateStages({
      apiKey,
      theme: record.config.theme,
      scenarioBrief: record.config.scenarioBrief,
      count: pedido,
      modelId: record.config.datagenModelId,
      seed,
      reasoningLevel: record.config.reasoning?.datagen,
      timeoutMs: datagenTimeout,
      // IMPL-056: idioma opt-in; o aviso de idioma sai do relatório da run
      // (todas as fontes, logo abaixo) — sem duplicar no console do datagen.
      languages: record.config.languages,
      onLanguageWarnings: () => undefined,
      // IMPL-063: dedup semântico da run (embedder de produção dentro do datagen).
      scenarioDedup: record.config.scenarioDedup,
      canAffordBatch: () => ledger.canAfford(custoLote),
      onReport: (r) => {
        datagenReport = r;
      },
      ctx,
    });
    // Cancelou no meio do lote: "nenhum cenário" seria um erro falso.
    throwIfCancelled();
    const merged = mergeScenariosReport(seed, gerados);
    specs = merged.specs.map(saneMaxTokens);
    if (datagenReport) {
      // Rede de segurança do merge (par exato contra o seed) entra na conta.
      if (merged.droppedVsSeed > 0) {
        datagenReport.droppedVsSeed += merged.droppedVsSeed;
        datagenReport.final -= merged.droppedVsSeed;
        datagenReport.shortfall += merged.droppedVsSeed;
        datagenReport.warning = describeDatagenShortfall(datagenReport, alvo);
      }
      publishDatagenReport(datagenReport);
    }
    if (specs.length === 0) {
      throw new Error(
        `Datagen nao entregou nenhum cenario valido (alvo: ${alvo}). Verifique o modelo gerador (${record.config.datagenModelId}) ou importe um pacote de cenarios.`,
      );
    }
    // Faltou cenário: a porta G2 (competidores + juízes) projeta com o n REAL.
    if (specs.length < alvo) est = estimar(record.contestants, specs.length);
  }

  // IMPL-056 + IMPL-068: política dos cenários sobre TODAS as fontes (seed,
  // pinadas, biblioteca, datagen) — idioma fora da política vira aviso e a
  // cobertura adversarial por categoria fica NO RECORD (antes: só console.warn
  // do datagen, e a cobertura não era contada em lugar nenhum).
  {
    const politica = scenarioPolicyReport(specs, { languages: record.config.languages });
    record.languageWarnings = politica.languageWarnings;
    if (politica.adversarialCoverage) record.adversarialCoverage = politica.adversarialCoverage;
    for (const aviso of politica.languageWarnings) log(runId, `idioma: ${aviso}`);
    if (politica.adversarialCoverage?.gaps.length) {
      log(
        runId,
        `cobertura adversarial abaixo de ${politica.adversarialCoverage.minPerCategory}/categoria: ${politica.adversarialCoverage.gaps.join(', ')}`,
      );
    }
  }

  // === FASE 1.5: gabaritos (respostas de referencia), um por cenario — cada
  // cenario roda uma unica vez. Etapas que ja trazem reference (seed/pinadas)
  // passam intactas; falha num gabarito so deixa a etapa sem reference
  // (degrada na fase 3). ===
  // Sinais de fim de cada gabarito (IMPL-014), por posicao em `specs` ANTES
  // da expansao de repeats — vao para o StageRecord na materializacao.
  const gabaritoCalls = new Map<number, CallFinishSignals>();
  // IMPL-055 (espelho do Node): valida os gabaritos GERADOS nesta run (opt-in).
  const validacaoLigada = Boolean(record.config.validateReferences || record.config.secondReferenceModelId);
  if (referenceJudging) {
    state.phase = 'gabarito';
    const semGabarito = specs.map((s) => !s.reference?.trim());
    specs = await generateReferences({
      stages: specs,
      apiKey,
      // IMPL-048: default EXPLÍCITO e documentado — só compare chega aqui sem
      // `referenceModelId` (train/vary reprova na validação sem ele). Sem
      // referência própria o gabarito sai do 1º juiz: o risco de auto-preferência
      // aparece em `fairnessWarnings`, nunca escondido.
      modelId: record.config.referenceModelId ?? record.config.judgeModelIds[0],
      // IMPL-079: gabarito tem esforço PRÓPRIO (default high) — não mais o do juiz.
      reasoningLevel: reasoningLevelForRole(record.config.reasoning, 'gab'),
      timeoutMs: tempoPapel.gabarito,
      ctx,
      // stageIndex -1 = progresso AGREGADO do lote (done/total de gabaritos
      // concluidos), nao de uma etapa especifica.
      onProgress: (done, total) =>
        emitEvent({ type: 'stage.gabarito', runId, stageIndex: -1, done, total }),
      onCall: (idx, call) => gabaritoCalls.set(idx, call),
    });
    const gerados = specs.map((s, i) => (semGabarito[i] && s.reference?.trim() ? i : -1)).filter((i) => i >= 0);
    if (validacaoLigada && gerados.length > 0) {
      if (!ledger.canAfford(est.byRole.gabarito)) {
        log(runId, 'validação dos gabaritos pulada: sem folga no orçamento (IMPL-055)');
      } else {
        const validadas = await validateGeneratedReferences({
          stages: gerados.map((i) => specs[i]),
          stageNumbers: gerados.map((i) => i + 1),
          apiKey,
          verifyModelId: record.config.judgeModelIds[0],
          secondModelId: record.config.secondReferenceModelId,
          reasoningLevel: reasoningLevelForRole(record.config.reasoning, 'judge'),
          timeoutMs: tempoPapel.gabarito,
          ctx,
          seed: seedFromId(record.id),
        });
        specs = specs.slice();
        gerados.forEach((i, k) => {
          specs[i] = validadas[k];
        });
      }
    }
  }
  syncLedger(record, ledger);

  // REPEATS (F2 §7.9): clona as specs finais (com gabarito já preenchido).
  if (repeats > 1) {
    specs = specs.flatMap((s) => Array.from({ length: repeats }, () => ({ ...s })));
  }

  // Materializa as specs nos slots; se faltou cenario (dedup/falha de lote),
  // os slots do rabo viram stage.failed e a run segue com o que houver.
  specs.forEach((spec, i) => {
    record.stages[i].spec = spec;
    // O gabarito e UMA chamada por cenario: com repeats, so o 1o clone guarda
    // os sinais (senao a visao por etapa contaria a mesma chamada N vezes).
    const call = i % repeats === 0 ? gabaritoCalls.get(i / repeats) : undefined;
    if (call) record.stages[i].gabaritoCall = call;
    // Gabarito truncado apos o retry x2 foi descartado: aviso VISIVEL (Node idem),
    // um por gabarito — com repeats, no 1o clone (onde a chamada fica persistida).
    const warning = call?.truncated ? describeTruncatedReference(i, call) : undefined;
    if (warning) log(runId, warning);
    emitEvent({
      type: 'stage.generated',
      runId,
      stageIndex: i,
      spec,
      ...(call ? { gabaritoCall: call } : {}),
      ...(warning ? { warning } : {}),
    });
  });
  for (let i = specs.length; i < record.stages.length; i++) {
    // web-live#7: a etapa descartada diz QUANTOS vieram e POR QUE (espelho do Node).
    const msg = datagenReport?.warning
      ? `${datagenReport.warning} Etapa descartada.`
      : `Datagen entregou menos cenarios que o alvo apos dedup/falha de lote; etapa descartada.`;
    record.stages[i].error = msg;
    record.stages[i].finishedAt = nowIso();
    emitEvent({ type: 'stage.failed', runId, stageIndex: i, error: msg });
  }
  syncLedger(record, ledger);
  scheduleSave();

  // Contestants ja sao finais aqui (opts.prepare rodou). Controle = ancora do
  // standings: o prompt original (isOriginal), o 'carry' do treino, ou o 1o
  // contestant como fallback. web-code#16: lista de MODELOS sem âncora
  // (`competitorAnchor: false`) não tem controle — sem o fallback posicional,
  // senão o `standings[].isControl` gravado/exportado apontaria um modelo
  // qualquer como controle.
  const controlId =
    record.contestants.find((c) => c.isOriginal || c.id === 'carry')?.id ??
    ((record.config as { competitorAnchor?: boolean }).competitorAnchor === false
      ? undefined
      : record.contestants[0]?.id);
  const labelOf = (id: string): string => record.contestants.find((c) => c.id === id)?.label ?? id;

  // === FASE 2+3: G2 — respostas E julgamento são UM grupo indivisível. ===
  // Autorizar os competidores sem reservar o julgamento na MESMA decisão
  // produziria etapas com resposta e sem nota (ou metade julgada), que é o
  // resultado incompleto com aparência de completo.
  const custoG2 = est.byRole.competitor + est.byRole.judge;
  if (!gate('competitors', custoG2)) {
    for (const st of record.stages) {
      if (st.spec && !st.error) {
        st.incomplete = true;
        st.incompleteReason = 'budget';
      }
    }
    syncLedger(record, ledger);
    return;
  }

  // Cada etapa é isolada (try/catch): uma falha não derruba a run nem as outras.
  // O placar é ADITIVO (applyScoreboard) — independe da ordem de término.
  // allSettled em vez de all (espelho do Node): com `all`, a primeira rejeição
  // desenrola o loop enquanto as irmãs seguem gastando, e o resultado delas se
  // perde DEPOIS de o dinheiro sair. Aqui todas terminam e só então o sinal de
  // controle sobe.
  const etapasSettled = await Promise.allSettled(
    record.stages.map(async (stageRecord) => {
      const i = stageRecord.index;
      const stageSpec = stageRecord.spec;
      if (!stageSpec || stageRecord.error) return; // pulada na fase 1

      try {
        // Competidores em paralelo — SEM cap local; o limitador global throttla.
        const respSettled = await Promise.allSettled(
          record.contestants.map(async (contestant) => {
            const response = await runCompetitor({
              apiKey,
              contestantId: contestant.id,
              modelId: contestant.modelId,
              systemPrompt: contestant.systemPrompt,
              stage: stageSpec,
              timeoutMs: record.config.timeoutMs,
              retries: 1,
              maxOutputTokens: record.config.maxOutputTokens,
              // compare-llms: temperatura/reasoning da tripla de identidade.
              // Prioridade do reasoning: override do contestant, senao o do papel.
              // Temperatura: override do contestant, senao a do modelo sob teste
              // (variation/training aplicam a mesma a TODAS as variantes).
              temperature:
                contestant.temperature ??
                ('temperature' in record.config ? record.config.temperature : undefined),
              reasoningLevel: contestant.reasoningLevel ?? record.config.reasoning?.competitor,
              ctx,
            });

            stageRecord.responses.push(response);
            // Bloqueio (defesa do gateway) ≠ recusa do modelo ≠ erro de infra —
            // tres contagens separadas no record (IMPL-010 / R-21:REC-6).
            record.competitorOutcomeCounts = countCompetitorOutcomes(record.stages);
            // Total verdadeiro vem do ledger (juiz/duelo/datagen nao sao
            // atribuiveis a um contestant); `costByContestant` segue sendo a
            // fatia dos competidores — agora com o custo MEDIDO (usage.cost).
            syncLedger(record, ledger);
            if (record.costByContestant) {
              record.costByContestant[contestant.id] =
                (record.costByContestant[contestant.id] ?? 0) + response.costUsd;
            }
            scheduleSave();
            emitEvent({ type: 'competitor.finished', runId, stageIndex: i, response });
            return response;
          }),
        );
        // Sinal de controle tem prioridade sobre qualquer outra rejeição.
        const rejeitada =
          respSettled.find((r) => r.status === 'rejected' && isControlSignal(r.reason)) ??
          respSettled.find((r) => r.status === 'rejected');
        if (rejeitada?.status === 'rejected') throw rejeitada.reason;
        // Cancelou enquanto as respostas chegavam: nem começa o julgamento.
        throwIfCancelled();
        // IMPL-069: estado de SEGURANÇA das respostas nos cenários do conjunto
        // de guarda (vazamento do system prompt / recusa / recusa excessiva).
        const seguranca = stageSecurity(stageSpec, stageRecord.responses, record.contestants);
        if (seguranca) stageRecord.security = seguranca;

        // IMPL-014 (espelho do Node): resposta que CONTINUOU truncada depois
        // do retry x2 torna a etapa `incomplete` — fora do placar e das medias,
        // sem julgamento (comparar resposta cortada mede o nosso teto).
        const truncadas = truncatedResponses(stageRecord.responses);
        if (truncadas.length > 0) {
          stageRecord.incomplete = true;
          stageRecord.incompleteReason = 'truncation';
          stageRecord.finishedAt = nowIso();
          const detail = describeTruncatedStage(i, truncadas, labelOf);
          log(runId, detail);
          scheduleSave();
          emitEvent({
            type: 'stage.incomplete',
            runId,
            stageIndex: i,
            reason: 'truncation',
            detail,
            contestantIds: truncadas.map((r) => r.contestantId),
          });
          return;
        }

        // === FASE 3: julgamento. Com gabarito: pointwise vs referencia (os
        // duelos sairam daqui — agora sao a FASE 4, so entre os finalistas).
        // Sem gabarito: juiz LISTWISE classico (compare antigo / fallback). ===
        emitEvent({ type: 'stage.judging', runId, stageIndex: i });
        try {
          if (stageSpec.reference?.trim()) {
            // Pointwise: cada resposta classificada isoladamente contra o
            // gabarito (resolve/parcial/nao) — base do judge-score.
            const refJudge = await julgarPorReferencia({
              stage: stageSpec,
              responses: stageRecord.responses,
              contestants: record.contestants,
              apiKey,
              reasoningLevel: reasoningLevelForRole(record.config.reasoning, 'judge'),
              timeoutMs: tempoPapel.judge,
              ctx,
            });
            // Defesa em profundidade: veredito que chegou DEPOIS do Cancelar
            // pode ter sido degradado por um abort ('parcial' inventado) —
            // descarta e deixa a etapa incompleta.
            throwIfCancelled();
            stageRecord.referenceJudge = refJudge;

            // JudgeResult SINTETIZADO para nao quebrar scoreboard/medals/UI:
            // ranking SEMPRE por veredito (resolve > parcial > nao). Os duelos so
            // acontecem na fase 4, entao nao ha ordem de duelos para consultar aqui.
            // O desempate NAO pode ser a ordem dos contestants: o controle
            // ('original'/'carry') e sempre o primeiro do array, entao sort estavel
            // daria a ele todos os 1os lugares em empate — enviesando medalhas e
            // placar a favor da regua. Usa o shuffle cego semeado pelo conteudo da
            // etapa (mesmo criterio dos duelos): deterministico e neutro.
            // Contestant SEM veredito (juiz que falhou, competidor com erro de
            // infra/bloqueado — IMPL-004) fica FORA do ranking: sem pontos e sem
            // 'nao' imputado — por isso o `filter` (espelho de src/).
            const ordemCega = blindRankMap(
              record.contestants.map((c) => c.id),
              seedFromId(stageSpec.question),
            );
            const ranked = [...record.contestants]
              .filter((c) => refJudge.verdictByContestant[c.id] !== undefined)
              .sort(
                (a, b) =>
                  VERDICT_SCORE[refJudge.verdictByContestant[b.id]] -
                    VERDICT_SCORE[refJudge.verdictByContestant[a.id]] ||
                  (ordemCega.get(a.id) ?? 0) - (ordemCega.get(b.id) ?? 0),
              )
              .map((c) => c.id);
            stageRecord.judge = {
              rankedContestantIds: ranked,
              acceptableByContestant: Object.fromEntries(
                Object.entries(refJudge.verdictByContestant).map(([id, v]) => [id, v !== 'nao']),
              ),
              verdictByContestant: { ...refJudge.verdictByContestant },
              verdictSourceByContestant: { ...refJudge.verdictSourceByContestant },
              verdictErrorByContestant: { ...refJudge.verdictErrorByContestant },
              judges: [],
              blindMap: {},
              rawJudgeText: 'Juiz de referência (gabarito)',
              inconclusive: refJudge.inconclusive,
            };
          } else {
            const listwise = await julgarListwise({
              apiKey,
              stage: stageSpec,
              responses: stageRecord.responses,
              timeoutMs: tempoPapel.judge,
              passes: record.config.judgePasses,
              // web-code#2: o esforço do juiz ia só para o pointwise — o
              // listwise (default do compare por modelos na SPA) rodava sem ele
              // enquanto o contrato gravado dizia o contrário. Espelho do Node.
              reasoningLevel: reasoningLevelForRole(record.config.reasoning, 'judge'),
              ctx,
            });
            throwIfCancelled();
            stageRecord.judge = listwise;
          }
        } catch (judgeErr) {
          // Sinal de controle (orcamento/cancelamento) nao e "juiz inconclusivo".
          // 401/402 idem (cli#3).
          if (mustPropagate(judgeErr)) throw judgeErr;
          const motivo = judgeErr instanceof Error ? judgeErr.message : String(judgeErr);
          // IMPL-004: a etapa fica SEM veredito para todos — com o motivo, para
          // a falha entrar em failureCountByRole (espelho de src/).
          stageRecord.judge = {
            rankedContestantIds: [],
            acceptableByContestant: {},
            verdictByContestant: {},
            verdictErrorByContestant: Object.fromEntries(
              record.contestants.map((c) => [
                c.id,
                { kind: 'judge_failed' as const, message: motivo.slice(0, 200) },
              ]),
            ),
            judges: [],
            blindMap: {},
            rawJudgeText: motivo,
            inconclusive: true,
          };
          log(runId, `stage ${i + 1} juiz falhou: ${stageRecord.judge.rawJudgeText}`);
        }
        // IMPL-015 (R-08:REC-11): saida do juiz CORTADA (finish_reason
        // length/timeout) => veredito INVALIDO — ja chega AUSENTE (fora do
        // placar sintetizado, das medias e do pareamento; conta em
        // failureCountByRole.judge). Aqui so o torna VISIVEL.
        const cortados = cutVerdicts(stageRecord.referenceJudge, stageRecord.judge);
        if (cortados.length > 0) {
          const detail = describeJudgeCut(
            i,
            'judge',
            cortados.map((c) => ({ label: labelOf(c.contestantId), kind: c.kind })),
          );
          log(runId, detail);
          emitEvent({
            type: 'judge.truncated',
            runId,
            stageIndex: i,
            phase: 'judge',
            contestantIds: cortados.map((c) => c.contestantId),
            kinds: cortados.map((c) => c.kind),
            detail,
          });
        }
        // Placar ADITIVO (ordem-independente). Listwise: POR JUIZ (cada juiz
        // pontua seu ranking). Referencia: 1x pelo ranking por veredito —
        // judges vem vazio de proposito.
        if (!stageRecord.judge.inconclusive) {
          if (stageRecord.judge.judges.length > 0) {
            for (const j of stageRecord.judge.judges) {
              if (j.rankedContestantIds.length > 0) {
                applyScoreboard(record.scoreboard, j.rankedContestantIds);
              }
            }
          } else if (stageRecord.judge.rankedContestantIds.length > 0) {
            applyScoreboard(record.scoreboard, stageRecord.judge.rankedContestantIds);
          }
        }

        stageRecord.finishedAt = nowIso();
        syncLedger(record, ledger);
        scheduleSave();
        emitEvent({
          type: 'stage.judged',
          runId,
          stageIndex: i,
          judge: stageRecord.judge,
          scoreboard: { ...record.scoreboard },
          totalCostUsd: record.totalCostUsd,
        });
        emitEvent({
          type: 'run.spend',
          runId,
          spentUsd: ledger.spentUsd,
          budgetUsd: ledger.snapshot().budgetUsd,
          byRole: ledger.byRole,
        });
      } catch (stageErr) {
        // rede de seguranca: qualquer imprevisto na etapa NAO mata a run —
        // MENOS orcamento/cancelamento, que sao decisao, nao acidente: a etapa
        // cortada fica `incomplete` (fora do placar e das medias).
        if (isControlSignal(stageErr)) {
          stageRecord.incomplete = true;
          stageRecord.incompleteReason = stageErr.benchControl === 'budget' ? 'budget' : 'cancelled';
          stageRecord.finishedAt = nowIso();
          throw stageErr;
        }
        const msg = stageErr instanceof Error ? stageErr.message : String(stageErr);
        if (isFatalGatewayError(stageErr)) {
          // cli#3 (espelho do Node): 401/402 derruba a RUN, não só a etapa.
          stageRecord.error = stageRecord.error ?? msg;
          stageRecord.finishedAt = nowIso();
          throw stageErr;
        }
        stageRecord.error = stageRecord.error ?? msg;
        stageRecord.finishedAt = nowIso();
        emitEvent({ type: 'stage.failed', runId, stageIndex: i, error: msg });
        log(runId, `stage ${i + 1} erro inesperado, pulando: ${msg}`);
      }
    }),
  );
  for (const r of etapasSettled) {
    if (r.status === 'rejected' && mustPropagate(r.reason)) throw r.reason;
  }
  // IMPL-069: resumo de segurança (conjunto de guarda) — separado do judge-score.
  const resumoSeguranca = summarizeSecurity(record.stages);
  if (resumoSeguranca) record.securitySummary = resumoSeguranca;
  // IMPL-115: resumo do modo econômico (fração escalonada + gatilhos). O
  // custo por veredito sai MEDIDO do ledger (costByRole.judge), nunca daqui.
  if (cascata) {
    const relatorios = record.stages.flatMap((s) => {
      const c = s.referenceJudge?.cascade ?? s.judge?.cascade;
      return c ? [c] : [];
    });
    record.judgeCascade = summarizeJudgeCascade(cascata, relatorios);
    log(
      runId,
      `modo econômico: ${record.judgeCascade.escalatedVerdicts}/${record.judgeCascade.verdicts} veredito(s) ao juiz forte ` +
        `(${(record.judgeCascade.escalatedFraction * 100).toFixed(0)}%)`,
    );
  }
  syncLedger(record, ledger);

  // === Agregados do julgamento por referencia (trainer/UI consomem). ===
  // Etapas `incomplete` (cortadas por orçamento/cancelamento ou por
  // truncamento) ficam de fora: contar uma etapa sem julgamento como 'nao'
  // rebaixaria todo mundo por falta de dinheiro ou pelo nosso teto de tokens.
  // Espelho do Node.
  // A regra "etapa entra no judge-score" é fonte única (web-code#12).
  const stagesComRef = record.stages.filter(stageCountsInJudgeScore);
  if (stagesComRef.length > 0) {
    // judge-score = (resolve + 0.5*parcial) / julgados * 100, por contestant,
    // sobre as etapas com juiz de referencia. Veredito AUSENTE (IMPL-004) é
    // "sem evidência": `judgeScoreFromVerdicts` o tira do numerador E do
    // denominador — nunca conta como 'nao'.
    record.judgeScoreByContestant = Object.fromEntries(
      record.contestants.map((c) => [
        c.id,
        judgeScoreFromVerdicts(stagesComRef.map((s) => s.referenceJudge!.verdictByContestant[c.id])),
      ]),
    );
  }

  // === FASE 4: FINAIS. So os melhores por judge-score MEDIO (todos os cenarios)
  // duelam — e ai sim em TODOS os cenarios, todos em paralelo (sem cap local; o
  // limitador global do openrouter gateia). Antes cada etapa montava seu proprio
  // bracket; agora a final e uma so, global, e roda depois de tudo. ===
  const finalsOn = record.config.duels !== false;
  const finalistCount = record.config.finalists ?? 3;
  const stagesParaDuelo = record.stages.filter(
    (s) => s.spec?.reference?.trim() && !s.error && !s.incomplete,
  );
  // Porta das finais: cancelamento checado sempre; orçamento só quando as
  // finais vão MESMO rodar (sem gabarito não há final — parar "por orçamento"
  // ali seria marcar como parcial uma run completa). Sem orçamento, a run fecha
  // com o que já foi julgado (aborted/budget) — sem duelo pela metade.
  throwIfCancelled();
  const finaisPlanejadas =
    finalsOn &&
    finalistCount !== 0 &&
    stagesParaDuelo.length > 0 &&
    record.contestants.length >= 2;
  if (
    finaisPlanejadas &&
    record.judgeScoreByContestant &&
    (est.byRole.duel === 0 || gate('finals', est.byRole.duel))
  ) {
    const scores = record.judgeScoreByContestant;
    const finalistas = pickFinalists(
      record.contestants.map((c) => ({ id: c.id, score: scores[c.id] ?? 0 })),
      finalistCount,
      seedFromId(record.id),
    );
    // Menos de 2 finalistas nao forma par — sem final.
    if (finalistas.length >= 2) {
      record.finalists = finalistas;
      emitEvent({
        type: 'finals.started',
        runId,
        finalists: finalistas.map((id) => ({ id, label: labelOf(id), score: scores[id] ?? 0 })),
      });

      let duelosDone = 0;
      const total = stagesParaDuelo.length;
      emitEvent({ type: 'duel.progress', runId, done: 0, total });
      const dueloSettled = await Promise.allSettled(
        stagesParaDuelo.map(async (st) => {
          try {
            st.duels = await runStageDuels({
              stage: st.spec!,
              responses: st.responses,
              contestants: record.contestants,
              judgeModelId: record.config.judgeModelIds[0],
              // Juiz JEV do duelo (default em todos os modos).
              judgeEngine: record.config.judgeEngine ?? 'jev',
              jevJudge: record.config.jevJudge,
              duelists: finalistas,
              topK: finalistas.length,
              verdictByContestant: st.referenceJudge?.verdictByContestant,
              // Etapa ground-truth (F1.4): vereditos deterministicos viram
              // scores de oraculo — os duelos decidem sem LLM.
              oracleScoresByContestant:
                st.spec?.expected !== undefined
                  ? oracleScoresFromVerdicts(st.referenceJudge?.verdictByContestant)
                  : undefined,
              apiKey,
              // IMPL-079: duelo tem esforço PRÓPRIO (default low) — não mais o do juiz.
              reasoningLevel: reasoningLevelForRole(record.config.reasoning, 'duel'),
              timeoutMs: tempoPapel.duel,
              ctx,
            });
            // IMPL-015: duelo com saida do juiz cortada fica SEM resultado
            // (failedDuels, nunca empate) — e o evento o torna visivel.
            const duelosCortados = cutDuels(st.duels);
            if (duelosCortados.length > 0) {
              const detail = describeJudgeCut(
                st.index,
                'duel',
                duelosCortados.map((d) => ({ label: `${labelOf(d.a)} × ${labelOf(d.b)}`, kind: d.kind })),
              );
              log(runId, detail);
              emitEvent({
                type: 'judge.truncated',
                runId,
                stageIndex: st.index,
                phase: 'duel',
                contestantIds: [...new Set(duelosCortados.flatMap((d) => [d.a, d.b]))],
                kinds: duelosCortados.map((d) => d.kind),
                detail,
              });
            }
            emitEvent({ type: 'stage.dueled', runId, stageIndex: st.index, duels: st.duels });
          } catch (duelErr) {
            if (mustPropagate(duelErr)) throw duelErr;
            // Degrada: a etapa fica sem duelo, a run NUNCA cai por causa disso.
            log(
              runId,
              `duelos da etapa ${st.index + 1} falharam: ${
                duelErr instanceof Error ? duelErr.message : String(duelErr)
              }`,
            );
          } finally {
            duelosDone += 1;
            emitEvent({ type: 'duel.progress', runId, done: duelosDone, total });
            scheduleSave();
          }
        }),
      );
      for (const r of dueloSettled) {
        if (r.status === 'rejected' && mustPropagate(r.reason)) throw r.reason;
      }
      // Duelo decidido depois do Cancelar pode ter sido degradado para empate.
      throwIfCancelled();
      syncLedger(record, ledger);
    }
  }

  const stagesComDuelos = record.stages.filter((s) => s.duels);
  if (stagesComDuelos.length > 0) {
    // Taxa de vitória agregada cross-estagio (IMPL-007, R-04:DEC-5): vitoria 1,
    // empate 0.5, derrota 0, dividido pelos duelos disputados. NAO e Copeland.
    // Desempate (cli#1, espelho do Node): vitorias, judge-score, rank cego —
    // NUNCA a ordem dos contestants (o controle e sempre o 1o).
    record.standings = buildFinalStandings({
      contestantIds: record.contestants.map((c) => c.id),
      duels: stagesComDuelos.flatMap((s) => s.duels!.duels),
      labelOf,
      controlId,
      judgeScoreByContestant: record.judgeScoreByContestant,
      seed: seedFromId(record.id),
    });
  }

  // IMPL-005 (R-04:REC-2): n nominal × efetivo por contestant, motivo de cada
  // veredito ausente e pares com a regua — a diferenca fica NO RECORD, visivel
  // em `runs show`/UI, em vez de sumir numa media com ausente contado como 'nao'.
  record.completeness = runCompleteness(record);

  // IMPL-112 (espelho do Node): taxa de acerto POR ITEM × contestants + fila de
  // revisão HUMANA do gabarito (nunca descarte). Zero LLM.
  record.itemSaturation = itemSaturationReport(record.stages.filter((s) => !s.incomplete && !s.error));
  // IMPL-055 + IMPL-047 (espelho do Node): fila `needs-human-review`.
  const filaRevisao = [
    ...humanReviewQueueFromStages(record.stages).filter((it) => it.stageIndex % repeats === 0),
    ...lowConfidenceReviewItems(record.stages),
  ];
  if (filaRevisao.length > 0 || validacaoLigada) record.needsHumanReview = filaRevisao;

  /** IMPL-053 (espelho do Node): sondas contrafactuais de verbosidade, opt-in. */
  const sondasDeVerbosidade = async (
    rows: VerbositySampleRow[],
    specDaAmostra: Map<VerbositySampleRow, StageSpec>,
  ): Promise<CounterfactualProbePair[] | undefined> => {
    if (!record.config.verbosityProbes) return undefined;
    const alvo = rows.filter((r) => r.source === 'pointwise' && specDaAmostra.get(r)?.reference?.trim());
    if (alvo.length === 0) return undefined;
    if (!ledger.canAfford(est.byRole.judge * 0.25)) {
      log(runId, 'sondas de verbosidade puladas: sem folga no orçamento (IMPL-053)');
      return undefined;
    }
    const contestantDe = new Map(record.contestants.map((c) => [c.id, c]));
    return runCounterfactualProbes({
      rows: alvo,
      seed: seedFromId(record.id),
      rejudge: async (probeText, row) => {
        const stage = specDaAmostra.get(row)!;
        const contestant = contestantDe.get(row.contestantId);
        if (!contestant) return null;
        const res = await judgeStageReference({
          stage,
          responses: [
            {
              contestantId: row.contestantId,
              modelId: contestant.modelId,
              text: probeText,
              latencyMs: 0,
              tokensIn: 0,
              tokensOut: 0,
              costUsd: 0,
              status: 'ok',
            },
          ],
          contestants: [contestant],
          judgeModelIds: record.config.judgeModelIds,
          apiKey,
          reasoningLevel: reasoningLevelForRole(record.config.reasoning, 'judge'),
          timeoutMs: tempoPapel.judge,
          ctx,
        });
        throwIfCancelled();
        return res.verdictByContestant[row.contestantId] ?? null;
      },
    });
  };

  // F3.6 + F4.2 (PLANO-PARIDADE): avisos de imparcialidade + diagnostico do
  // juiz ficam NO RECORD — zero LLM, tudo derivado do que ja rodou. O pin do
  // contrato (hash do prompt do juiz + modelos) denuncia calibration drift ao
  // comparar sessoes; o relatorio de verbosidade expoe o vies score×comprimento.
  try {
    // IMPL-048: a REFERÊNCIA entra na conta de imparcialidade (default do
    // compare = 1º juiz — o aviso denuncia o default, ele não fica escondido).
    const referenceModelId = record.config.referenceModelId ?? record.config.judgeModelIds[0];
    // web-live#10: o aviso sobre "quem escreve o gabarito" só vale quando ALGUM
    // gabarito existe (gerado ou importado) — comparando modelos sem referência
    // ele acusava um papel que ninguém exerceu. (O pin do contrato do juiz
    // segue com `referenceModelId`: mudar o hash seria drift falso.)
    const autorDoGabarito = record.stages.some((s) => s.spec?.reference?.trim()) ? referenceModelId : undefined;
    // IMPL-115 (revisão w2): com cascata quem julga são os baratos + o forte —
    // o aviso de auto-preferência olha o painel EFETIVO, não só judgeModelIds.
    record.fairnessWarnings = fairnessWarningsForModels(
      record.contestants.map((c) => c.modelId),
      judgingModelIds(record.config),
      autorDoGabarito,
    );
    // IMPL-052 (R-03b:REC-2, espelho de src/orchestrator.ts): higiene das
    // amostras — fontes segregadas, vazios/imputados/truncados excluídos e
    // contados, comprimento em tokens (razão candidato/referência) e n por
    // célula (fonte × contestant) no relatório.
    const rows: VerbositySampleRow[] = [];
    // Spec de cada amostra — as sondas (IMPL-053) re-julgam contra a mesma régua.
    const specDaAmostra = new Map<VerbositySampleRow, StageSpec>();
    for (const st of record.stages) {
      const refJudge = st.referenceJudge;
      const listwise = st.judge;
      for (const r of st.responses) {
        if (r.status !== 'ok') continue;
        const vRef = refJudge?.verdictByContestant?.[r.contestantId];
        const vList = vRef === undefined ? listwise?.verdictByContestant?.[r.contestantId] : undefined;
        const v = vRef ?? vList;
        if (!v) continue;
        const origem =
          vRef !== undefined
            ? refJudge?.verdictSourceByContestant?.[r.contestantId]
            : listwise?.verdictSourceByContestant?.[r.contestantId];
        const fonte: VerbositySampleRow['source'] =
          origem === 'auto'
            ? 'imputado'
            : origem === 'ground-truth'
              ? 'rotulo'
              : vRef !== undefined
                ? 'pointwise'
                : 'listwise';
        rows.push({
          contestantId: r.contestantId,
          source: fonte,
          score: v === 'resolve' ? 1 : v === 'parcial' ? 0.5 : 0,
          text: r.text,
          candidateTokens: r.tokensOut > 0 ? r.tokensOut : undefined,
          referenceText: st.spec?.reference,
          referenceTokens: st.gabaritoCall?.tokensOut ? st.gabaritoCall.tokensOut : undefined,
          maxTokens: r.maxTokens ?? st.spec?.maxTokens,
          truncated: r.truncated === true || r.finishReason === 'length',
          // IMPL-053: efeito fixo do CENÁRIO (clones de repeat = o mesmo cenário).
          scenarioId: String(Math.floor(st.index / repeats)),
        });
        if (st.spec) specDaAmostra.set(rows[rows.length - 1], st.spec);
      }
    }
    // IMPL-049 (R-03a:REC-9, espelho de src/orchestrator.ts): o contrato cobre
    // juízes + prompts (pointwise/duelo/listwise) + modelo de referência +
    // think level + provedor; drift dispara `judge.contract.changed`.
    // cli#0 + IMPL-117 (espelho do Node): fonte única dos componentes — think
    // level EFETIVO (default incluso) e a temperatura que os juízes enviam.
    const components: JudgeContractComponents = pipelineContractComponents({
      duelPromptText: DUEL_HEAD,
      listwisePromptText: JUDGE_LISTWISE_CONTRACT_TEXT,
      referenceModelId,
      judgeReasoningLevel: reasoningLevelForRole(record.config.reasoning, 'judge'),
      providerPolicy: ctx.sink?.sensitiveRouting?.()
        ? JSON.stringify(ctx.sink.sensitiveRouting!())
        : undefined,
    });
    // IMPL-115: no modo econômico quem julga as etapas são os baratos + o forte
    // — o contrato pinado os inclui (trocar a cascata = contrato novo).
    const juizesDoContrato = cascata
      ? [...new Set([...record.config.judgeModelIds, ...cascata.cheap, cascata.strong])]
      : record.config.judgeModelIds;
    // IMPL-070: o pin carrega o fingerprint dos meta-prompts do pipeline e o
    // hash de contrato DA RUN (juiz + meta-prompts) — o hash do juiz não muda.
    // Juiz JEV: o contrato é a escala tipada de src/jevJudge.ts (trocar o motor
    // do juiz muda o hash e sinaliza drift — espelho de src/orchestrator.ts).
    const contract = pinJudgeContract(
      juizesDoContrato,
      (record.config.judgeEngine ?? 'jev') === 'jev' ? JEV_JUDGE_CONTRACT_TEXT : JUDGE_CONTRACT_TEXT,
      undefined,
      components,
      { metaPromptsFingerprint: pipelineMetaPromptsFingerprint() },
    );
    // IMPL-049 (espelho do Node): âncora = pin da última run GRAVADA (sobrevive
    // ao reload da aba); a memória do módulo é a reserva.
    const memoria = noteJudgeContract(contract.hash);
    const anterior = await previousContractPin({
      runId: record.id,
      startedAt: record.startedAt,
      listRuns: () => listRuns<{ id: string; status?: string; startedAt?: string }>(),
      loadRun,
    });
    const drift = contractDrift(anterior?.hash ?? memoria.previousHash, contract.hash);
    const audit = judgeContractAudit({
      modelIds: juizesDoContrato,
      hash: contract.hash,
      previousHash: drift.previousHash,
    });
    const sondas = await sondasDeVerbosidade(rows, specDaAmostra);
    record.judgeDiagnostics = {
      contract,
      contractAudit: {
        changed: drift.changed,
        ...(drift.previousHash ? { previousHash: drift.previousHash } : {}),
        ...(anterior && anterior.hash === drift.previousHash ? { previousRunId: anterior.runId } : {}),
        ...audit,
      },
      verbosity: verbosityReport(verbositySamples(rows), sondas ? { probes: sondas } : undefined),
    };
    if (drift.changed) {
      const detail = `judge.contract.changed: ${drift.message}`;
      log(runId, detail);
      emitEvent({
        type: 'judge.contract.changed',
        runId,
        previousHash: drift.previousHash ?? '',
        currentHash: contract.hash,
        detail,
      });
    }
    if (record.judgeDiagnostics.verbosity.warning) {
      log(runId, `aviso de verbosidade do juiz: ${record.judgeDiagnostics.verbosity.warning}`);
    }
    for (const aviso of record.fairnessWarnings) log(runId, `imparcialidade: ${aviso}`);
    const desfechos = record.competitorOutcomeCounts;
    if (desfechos && desfechos.blocked + desfechos.refused + desfechos.error > 0) {
      // Bloqueio NAO e erro de key nem falha do prompt: e a defesa do gateway.
      log(runId, 'desfechos dos competidores (bloqueio ≠ recusa ≠ erro)', { ...desfechos });
    }
    // IMPL-014: acima de 2% de chamadas truncadas (TODOS os papeis) o teto
    // esta baixo p/ estes modelos; o alerta diz quais papeis truncaram.
    syncLedger(record, ledger);
    const alertaTrunc = truncationAlert(
      { ...record.truncationCounts!, rate: record.truncationRate! },
      record.finishSignalsByRole,
    );
    if (alertaTrunc) log(runId, `ALERTA de truncamento: ${alertaTrunc}`);
    // IMPL-015: taxa por papel x esforco, alerta por celula > 1%.
    const alertaCelula = truncationCellAlert(truncationByRoleEffort(record.finishSignalsByRole));
    if (alertaCelula) log(runId, `ALERTA de truncamento: ${alertaCelula}`);
  } catch (err) {
    // Orçamento/cancelamento nas sondas (IMPL-053) é CONTROLE: sobe.
    if (isControlSignal(err)) throw err;
    // Diagnostico e SUPORTE, nunca derruba a finalizacao.
    log(runId, `diagnostico do juiz falhou (ignorado): ${err instanceof Error ? err.message : String(err)}`);
  }

  // IMPL-004 (R-03b:REC-4): só é `finished` se a evidência sustenta conclusão
  // — senão `inconclusive` (terminal), com a conta no record (espelho de src/).
  const integridade = assessVerdictIntegrity({
    stages: record.stages,
    contestants: record.contestants,
    referenceJudging,
  });
  record.failureCountByRole = integridade.failureCountByRole;
  record.verdictIntegrity = integridade.integrity;
  for (const motivo of integridade.integrity.reasons) log(runId, `inconclusiva: ${motivo}`);

  await reconcileAtRunEnd(ledger, apiKey); // IMPL-074: pendentes conciliadas antes da escrita terminal
  syncLedger(record, ledger);
  // Parou numa porta (finais sem orçamento): o resultado é PARCIAL e diz isso —
  // `aborted` + `stoppedReason`, nunca 'finished' com cara de completo. Sem
  // parada, só é `finished` se a evidência sustenta conclusão (IMPL-004).
  record.status = record.stoppedReason ? 'aborted' : integridade.inconclusive ? 'inconclusive' : 'finished';
  record.finishedAt = nowIso();
  await flushSave();
  emitEvent({ type: 'run.finished', runId, record });
  log(runId, record.stoppedReason ? `encerrada (${record.stoppedReason})` : record.status, {
    totalCostUsd: record.totalCostUsd,
  });
}
