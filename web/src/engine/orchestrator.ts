const randomUUID = (): string => crypto.randomUUID();
import { generateStages } from './datagen';
import { countCompetitorOutcomes, runCompetitor } from './competitor';
import { judgeStage } from './judge';
import { generateReferences } from './gabarito';
import { judgeStageReference } from './refJudge';
import { blindRankMap, pickFinalists, runStageDuels, seedFromId, VERDICT_SCORE } from './duels';
import { oracleScoresFromVerdicts } from '../../../src/engine/duelCore.js';
import { fairnessWarningsForModels } from './llmVariants';
import { JUDGE_CONTRACT_TEXT } from './refJudge';
import { pinJudgeContract, verbosityReport } from '../../../src/engine/judgeCalibration.js';
import { modelRolesForRun, snapshotModelLifecycle } from '../../../src/engine/modelLifecycle.js';
import { mergeScenarios } from './scenarioPack';
import { sanitizeLlmVariants, variantsToContestants } from './llmVariants';
import { judgeScoreFromVerdicts } from './rank';
import { runCompleteness } from './stats';
import { emitEvent } from './events';
import { saveRun } from './storage';
import { contestantsFromConfig } from './normalize';
import { listModels } from './openrouter';
import { BudgetLedger, isControlSignal, RunCancelled, toControlSignal } from './budget';
import { estimateInputFromConfig, estimateRunCost, makeCallEstimator } from './estimate';
import { acquireLock } from './runLocks';
import {
  describeTruncatedReference,
  describeTruncatedStage,
  truncatedResponses,
  truncationAlert,
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
} from './types';

function nowIso(): string {
  return new Date().toISOString();
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
  if (snap.upstreamUsd > 0) record.upstreamCostUsd = snap.upstreamUsd;
  // IMPL-014 (espelho do Node): sinais de fim por papel + taxa de truncamento
  // da run, do MESMO ponto unico do custo — 100% das chamadas, juiz inclusive.
  Object.assign(record, truncationRecordFields(snap.finishByRole));
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
  if (contestants[0]) contestants[0] = { ...contestants[0], isOriginal: true };
  return contestants;
}

function buildRecord(config: RunConfig, opts: StartRunOpts): RunRecord {
  const runId = opts.runId ?? randomUUID();
  const concurrency = Math.max(1, config.concurrency ?? 8);
  const timeoutMs = config.timeoutMs ?? 60_000;
  const contestants = opts.contestants ?? compareContestants(config);

  return {
    id: runId,
    status: 'running',
    config: { ...config, concurrency, timeoutMs },
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
      record.finishedAt = nowIso();
      await saveRun(record);
      emitEvent({ type: 'run.error', runId: record.id, error: record.error });
    }
  } finally {
    runControllers.delete(record.id);
    opts.signal?.removeEventListener('abort', onParentAbort);
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

async function runLoop(
  record: RunRecord,
  apiKey: string,
  opts: StartRunOpts,
  signal: AbortSignal,
  state: RunState,
): Promise<void> {
  const { id: runId } = record;

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
      budgetUsd: record.config.budgetUsd,
      signal,
      estimateCall: makeCallEstimator(catalogo),
    });
  state.ledger = ledger;
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
  const estimar = (contestantIds: string[]) =>
    estimateRunCost(
      estimateInputFromConfig(
        record.config as never,
        contestantIds.length > 0 ? { contestantIds } : {},
      ),
      catalogo,
      // Preço desconhecido (roteador, "-1") pelo PIOR CASO — espelho do Node (IMPL-018).
      { unknownPrice: 'worst-case' },
    );
  let est = estimar(record.contestants.map((c) => c.id));

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
    est = estimar(contestants.map((c) => c.id));
    await saveRun(record);
    emitEvent({ type: 'variants.generated', runId, contestants });
  }

  // Datagen em lote/gabaritos podem ser lentos (varios cenarios por chamada,
  // as vezes com reasoning): folga alem do timeout dos competidores.
  const datagenTimeout = Math.max(record.config.timeoutMs ?? 60_000, 120_000);

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

  let specs: StageSpec[];
  if (pinado) {
    specs = pinnedStages!;
  } else if (seed.length >= record.config.stages) {
    // O seed cobre (ou excede) o alvo: tudo importado, o datagen NAO e chamado.
    specs = seed;
  } else {
    // Gera em LOTE apenas o que falta para o alvo (batches paralelos + dedup
    // exato/ROUGE-L + 1 backfill dentro de generateStages — substitui o antigo
    // retry por etapa) e mescla: seed primeiro (curadoria do usuario, nunca
    // descartado), gerados como complemento nao-duplicado.
    const gerados = await generateStages({
      apiKey,
      theme: record.config.theme,
      scenarioBrief: record.config.scenarioBrief,
      count: alvo - seed.length,
      modelId: record.config.datagenModelId,
      excludePrompts: seed.map((s) => s.question),
      reasoningLevel: record.config.reasoning?.datagen,
      timeoutMs: datagenTimeout,
      ctx,
    });
    // Cancelou no meio do lote: "nenhum cenário" seria um erro falso.
    throwIfCancelled();
    specs = mergeScenarios(seed, gerados).map(saneMaxTokens);
    if (specs.length === 0) {
      throw new Error(
        `Datagen nao entregou nenhum cenario valido (alvo: ${alvo}). Verifique o modelo gerador (${record.config.datagenModelId}) ou importe um pacote de cenarios.`,
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
  if (referenceJudging) {
    state.phase = 'gabarito';
    specs = await generateReferences({
      stages: specs,
      apiKey,
      modelId: record.config.referenceModelId ?? record.config.judgeModelIds[0],
      reasoningLevel: record.config.reasoning?.judge,
      timeoutMs: datagenTimeout,
      ctx,
      // stageIndex -1 = progresso AGREGADO do lote (done/total de gabaritos
      // concluidos), nao de uma etapa especifica.
      onProgress: (done, total) =>
        emitEvent({ type: 'stage.gabarito', runId, stageIndex: -1, done, total }),
      onCall: (idx, call) => gabaritoCalls.set(idx, call),
    });
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
    const msg = `Datagen entregou menos cenarios que o alvo apos dedup/falha de lote; etapa descartada.`;
    record.stages[i].error = msg;
    record.stages[i].finishedAt = nowIso();
    emitEvent({ type: 'stage.failed', runId, stageIndex: i, error: msg });
  }
  syncLedger(record, ledger);
  scheduleSave();

  // Contestants ja sao finais aqui (opts.prepare rodou). Controle = ancora do
  // standings: o prompt original (isOriginal), o 'carry' do treino, ou o 1o
  // contestant como fallback.
  const controlId =
    record.contestants.find((c) => c.isOriginal || c.id === 'carry')?.id ??
    record.contestants[0]?.id;
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
            const refJudge = await judgeStageReference({
              stage: stageSpec,
              responses: stageRecord.responses,
              contestants: record.contestants,
              judgeModelIds: record.config.judgeModelIds,
              apiKey,
              reasoningLevel: record.config.reasoning?.judge,
              timeoutMs: record.config.timeoutMs,
              ctx,
            });
            // Defesa em profundidade: veredito que chegou DEPOIS do Cancelar
            // pode ter sido degradado por um abort ('parcial' inventado) —
            // descarta e deixa a etapa incompleta.
            throwIfCancelled();
            stageRecord.referenceJudge = refJudge;

            // JudgeResult SINTETIZADO para nao quebrar scoreboard/medals/UI:
            // ranking SEMPRE por veredito (resolve > parcial > nao). Os duelos so
            // acontecem na fase 4, entao nao ha ordem Copeland para consultar aqui.
            // O desempate NAO pode ser a ordem dos contestants: o controle
            // ('original'/'carry') e sempre o primeiro do array, entao sort estavel
            // daria a ele todos os 1os lugares em empate — enviesando medalhas e
            // placar a favor da regua. Usa o shuffle cego semeado pelo conteudo da
            // etapa (mesmo criterio dos duelos): deterministico e neutro.
            const ordemCega = blindRankMap(
              record.contestants.map((c) => c.id),
              seedFromId(stageSpec.question),
            );
            const ranked = [...record.contestants]
              .sort(
                (a, b) =>
                  VERDICT_SCORE[refJudge.verdictByContestant[b.id] ?? 'nao'] -
                    VERDICT_SCORE[refJudge.verdictByContestant[a.id] ?? 'nao'] ||
                  (ordemCega.get(a.id) ?? 0) - (ordemCega.get(b.id) ?? 0),
              )
              .map((c) => c.id);
            stageRecord.judge = {
              rankedContestantIds: ranked,
              acceptableByContestant: Object.fromEntries(
                Object.entries(refJudge.verdictByContestant).map(([id, v]) => [id, v !== 'nao']),
              ),
              verdictByContestant: { ...refJudge.verdictByContestant },
              judges: [],
              blindMap: {},
              rawJudgeText: 'Juiz de referência (gabarito)',
              inconclusive: refJudge.inconclusive,
            };
          } else {
            const listwise = await judgeStage({
              apiKey,
              stage: stageSpec,
              responses: stageRecord.responses,
              judgeModelIds: record.config.judgeModelIds,
              timeoutMs: record.config.timeoutMs,
              passes: record.config.judgePasses,
              ctx,
            });
            throwIfCancelled();
            stageRecord.judge = listwise;
          }
        } catch (judgeErr) {
          // Sinal de controle (orcamento/cancelamento) nao e "juiz inconclusivo".
          if (isControlSignal(judgeErr)) throw judgeErr;
          stageRecord.judge = {
            rankedContestantIds: [],
            acceptableByContestant: {},
            judges: [],
            blindMap: {},
            rawJudgeText: judgeErr instanceof Error ? judgeErr.message : String(judgeErr),
            inconclusive: true,
          };
          log(runId, `stage ${i + 1} juiz falhou: ${stageRecord.judge.rawJudgeText}`);
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
        stageRecord.error = stageRecord.error ?? msg;
        stageRecord.finishedAt = nowIso();
        emitEvent({ type: 'stage.failed', runId, stageIndex: i, error: msg });
        log(runId, `stage ${i + 1} erro inesperado, pulando: ${msg}`);
      }
    }),
  );
  for (const r of etapasSettled) {
    if (r.status === 'rejected' && isControlSignal(r.reason)) throw r.reason;
  }
  syncLedger(record, ledger);

  // === Agregados do julgamento por referencia (trainer/UI consomem). ===
  // Etapas `incomplete` (cortadas por orçamento/cancelamento ou por
  // truncamento) ficam de fora: contar uma etapa sem julgamento como 'nao'
  // rebaixaria todo mundo por falta de dinheiro ou pelo nosso teto de tokens.
  // Espelho do Node.
  const stagesComRef = record.stages.filter((s) => s.referenceJudge && !s.incomplete);
  if (stagesComRef.length > 0) {
    // judge-score = (resolve + 0.5*parcial) / total * 100, por contestant,
    // sobre as etapas com juiz de referencia (ausente conta como 'nao').
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
              reasoningLevel: record.config.reasoning?.judge,
              timeoutMs: record.config.timeoutMs,
              ctx,
            });
            emitEvent({ type: 'stage.dueled', runId, stageIndex: st.index, duels: st.duels });
          } catch (duelErr) {
            if (isControlSignal(duelErr)) throw duelErr;
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
        if (r.status === 'rejected' && isControlSignal(r.reason)) throw r.reason;
      }
      // Duelo decidido depois do Cancelar pode ter sido degradado para empate.
      throwIfCancelled();
      syncLedger(record, ledger);
    }
  }

  const stagesComDuelos = record.stages.filter((s) => s.duels);
  if (stagesComDuelos.length > 0) {
    // Copeland agregado cross-estagio: vitoria 1, empate 0.5, derrota 0.
    const acc = new Map(
      record.contestants.map((c) => [c.id, { points: 0, wins: 0, ties: 0, losses: 0 }]),
    );
    for (const s of stagesComDuelos) {
      for (const d of s.duels!.duels) {
        const A = acc.get(d.a);
        const B = acc.get(d.b);
        if (!A || !B) continue;
        if (d.outcome === 'a') {
          A.points += 1;
          A.wins += 1;
          B.losses += 1;
        } else if (d.outcome === 'b') {
          B.points += 1;
          B.wins += 1;
          A.losses += 1;
        } else {
          A.points += 0.5;
          B.points += 0.5;
          A.ties += 1;
          B.ties += 1;
        }
      }
    }
    record.standings = [...acc.entries()]
      .map(([id, s]) => {
        const played = s.wins + s.ties + s.losses;
        return {
          id,
          label: labelOf(id),
          isControl: id === controlId,
          ...s,
          winRate: played > 0 ? Number(((s.wins + 0.5 * s.ties) / played).toFixed(4)) : 0,
        };
      })
      // Estavel: empate de pontos E winRate mantem a ordem dos contestants.
      .sort((a, b) => b.points - a.points || b.winRate - a.winRate);
  }

  // IMPL-005 (R-04:REC-2): n nominal × efetivo por contestant, motivo de cada
  // veredito ausente e pares com a regua — a diferenca fica NO RECORD, visivel
  // em `runs show`/UI, em vez de sumir numa media com ausente contado como 'nao'.
  record.completeness = runCompleteness(record);

  // F3.6 + F4.2 (PLANO-PARIDADE): avisos de imparcialidade + diagnostico do
  // juiz ficam NO RECORD — zero LLM, tudo derivado do que ja rodou. O pin do
  // contrato (hash do prompt do juiz + modelos) denuncia calibration drift ao
  // comparar sessoes; o relatorio de verbosidade expoe o vies score×comprimento.
  try {
    record.fairnessWarnings = fairnessWarningsForModels(
      record.contestants.map((c) => c.modelId),
      record.config.judgeModelIds,
    );
    const samples: { score: number; length: number }[] = [];
    for (const st of record.stages) {
      for (const r of st.responses) {
        const v =
          st.referenceJudge?.verdictByContestant?.[r.contestantId] ??
          st.judge?.verdictByContestant?.[r.contestantId];
        if (!v || r.status !== 'ok') continue;
        samples.push({
          score: v === 'resolve' ? 1 : v === 'parcial' ? 0.5 : 0,
          length: r.text.length,
        });
      }
    }
    record.judgeDiagnostics = {
      contract: pinJudgeContract(record.config.judgeModelIds, JUDGE_CONTRACT_TEXT),
      verbosity: verbosityReport(samples),
    };
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
  } catch (err) {
    // Diagnostico e SUPORTE, nunca derruba a finalizacao.
    log(runId, `diagnostico do juiz falhou (ignorado): ${err instanceof Error ? err.message : String(err)}`);
  }

  syncLedger(record, ledger);
  // Parou numa porta (finais sem orçamento): o resultado é PARCIAL e diz isso —
  // `aborted` + `stoppedReason`, nunca 'finished' com cara de completo.
  record.status = record.stoppedReason ? 'aborted' : 'finished';
  record.finishedAt = nowIso();
  await flushSave();
  emitEvent({ type: 'run.finished', runId, record });
  log(runId, record.stoppedReason ? `encerrada (${record.stoppedReason})` : 'finished', {
    totalCostUsd: record.totalCostUsd,
  });
}
