import { randomUUID } from 'node:crypto';
import { cpus } from 'node:os';
import { generateStages } from './datagen.js';
import { countCompetitorOutcomes, runCompetitor } from './competitor.js';
import { judgeStage } from './judge.js';
import { generateReferences } from './gabarito.js';
import { judgeStageReference } from './refJudge.js';
import { blindRankMap, pickFinalists, runStageDuels, seedFromId, VERDICT_SCORE } from './duels.js';
import { oracleScoresFromVerdicts } from './engine/duelCore.js';
import { assessVerdictIntegrity } from './engine/verdictIntegrity.js';
import { VERDICT_AGGREGATION } from './engine/verdictAggregate.js';
import { fairnessWarningsForModels } from './llmVariants.js';
import { JUDGE_CONTRACT_TEXT } from './refJudge.js';
import { pinJudgeContract, verbosityReport } from './engine/judgeCalibration.js';
import { modelRolesForRun, snapshotModelLifecycle } from './engine/modelLifecycle.js';
import { mergeScenarios } from './scenarioPack.js';
import { sanitizeLlmVariants, variantsToContestants } from './llmVariants.js';
import { judgeScoreFromVerdicts } from './rank.js';
import { runCompleteness } from './stats.js';
import { emitEvent } from './events.js';
import { saveRun, getDataDir } from './storage.js';
import { contestantsFromConfig } from './normalize.js';
import { BudgetLedger, isControlSignal } from './budget.js';
import { estimateInputFromConfig, estimateRunCost, makeCallEstimator } from './estimate.js';
import { listModels } from './openrouter.js';
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
} from './engine/truncation.js';
import { enforceRunCompliance } from './lgpd.js';
import { runAgentStage, aggregateAgentVerdict } from './agent/runAgentStage.js';
import { AGENT_JUDGE_SYSTEM_PROMPT } from './agent/agentJudge.js';
import {
  AGENT_VERDICT_TREE_VERSION,
  agentOracleDuelScores,
  agentRateMetrics,
  agentStageProvenance,
  needsTextReference,
  oracleCellDefect,
  stageHasVerify,
  stageObservations,
  tallyReps,
  type RepCounts,
} from './agent/verdictTree.js';
import type { AgentRepResult } from './agent/runAgentStage.js';
import type {
  CallFinishSignals,
  Contestant,
  ReferenceJudgeResult,
  RunConfig,
  RunCtx,
  RunPhase,
  RunRecord,
  StageRecord,
  StageSpec,
  Verdict,
  VerdictError,
  VerdictSource,
  ReasoningLevel,
} from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function log(runId: string, msg: string, extra?: Record<string, unknown>): void {
  const payload = extra ? ` ${JSON.stringify(extra)}` : '';
  // stderr, nao stdout: num CLI o stdout e PAYLOAD (NDJSON/JSON) e uma
  // linha de log no meio corrompe o stream de quem esta consumindo.
  console.error(`[bench ${runId}] ${msg}${payload}`);
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

/**
 * Semáforo assíncrono local de processos de AGENTE.
 *
 * ⚠️ Isto NÃO viola a regra do AGENTS.md "não ponha cap de concorrência local".
 * Aquela regra fala do limitador global de `openrouter.ts`, que existe para
 * respeitar o RATE LIMIT DO PROVEDOR (as nossas chamadas HTTP). Aqui o recurso
 * escasso é a MÁQUINA: cada execução de agente é um processo Node + shells filhos
 * + I/O de disco — e as chamadas do agente saem de DENTRO do executor, então o
 * limitador global nem as enxerga (plano §20.5). São dois problemas distintos.
 */
class AgentSemaphore {
  private running = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.max > 0) {
      while (this.running >= this.max) {
        await new Promise<void>((res) => this.queue.push(res));
      }
      this.running++;
      try {
        return await fn();
      } finally {
        this.running--;
        this.queue.shift()?.();
      }
    }
    return fn();
  }
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
  /** Sinal de abort (Ctrl-C, timeout global) — chega ao fetch de cada chamada. */
  signal?: AbortSignal;
  /**
   * Ledger EXTERNO (sessao de treino): a run reporta o proprio total e escreve
   * no pai. Ausente => a run cria o proprio ledger a partir de config.budgetUsd.
   */
  parentLedger?: BudgetLedger;
  /** Contexto pronto (usado por prepareOptsFor). Tem precedencia sobre signal. */
  ctx?: RunCtx;
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
  let contestants: Contestant[];
  if (config.mode !== 'compare' || !config.competitorConfigs?.length) {
    contestants = contestantsFromConfig(config);
  } else {
    const sane = sanitizeLlmVariants(config.competitorConfigs);
    if (sane.error) contestants = contestantsFromConfig(config);
    else {
      for (const w of sane.warnings) console.warn(`[compare-llms] ${w}`);
      contestants = variantsToContestants(sane.variants);
      if (contestants[0]) contestants[0] = { ...contestants[0], isOriginal: true };
    }
  }
  // F5: em modo agente (config.agent presente), TODO contestant do compare roda
  // como agente. Estampa `runner: 'agent'` AQUI — o único ponto por onde passam
  // AMBOS os caminhos do eixo compare (competitorModelIds via
  // `contestantsFromConfig` E competitorConfigs via `variantsToContestants`,
  // inclusive o fallback de config inválida). Sem isto o orquestrador (que
  // ramifica por `contestant.runner === 'agent'`) rodaria os candidatos como
  // CHAT. (O variator/trainer já estampam no modo variation/training; o compare
  // não tinha nenhum stamp.)
  if (config.agent) {
    contestants = contestants.map((c) => ({ ...c, runner: 'agent' }));
  }
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
 * Persistencia com THROTTLE: as etapas paralelas geram MUITAS escritas, entao
 * coalescemos em no max. 1x/SAVE_INTERVAL_MS (trailing) e damos flush nos
 * marcos. `dispose` existe porque o timer armado mantinha o event loop vivo por
 * ate 800ms depois do fim — imperceptivel num servidor, mas num CLI parece
 * travamento.
 */
const SAVE_INTERVAL_MS = 800;

interface Saver {
  schedule(): void;
  flush(): Promise<void>;
  /**
   * Liga o ledger da run: `flush` copia o custo para o record ANTES de gravar.
   * Sem isto uma run cortada por cancelamento/orçamento no meio de uma fase
   * era gravada com o gasto do ÚLTIMO marco (ou zero, antes das respostas) —
   * o parcial mentia sobre o dinheiro já cobrado (IMPL-025).
   */
  bindLedger(sync: () => void): void;
}

function createSaver(record: RunRecord): Saver {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSave = 0;
  let syncLedger: (() => void) | undefined;
  return {
    bindLedger(sync: () => void): void {
      syncLedger = sync;
    },
    schedule(): void {
      if (saveTimer) return;
      const delay = Math.max(0, SAVE_INTERVAL_MS - (Date.now() - lastSave));
      saveTimer = setTimeout(() => {
        saveTimer = null;
        lastSave = Date.now();
        void saveRun(record).catch(() => undefined);
      }, delay);
      saveTimer.unref?.();
    },
    async flush(): Promise<void> {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      syncLedger?.();
      lastSave = Date.now();
      await saveRun(record).catch(() => undefined);
    },
  };
}

/** Executa o loop e SEMPRE resolve com o record final (status finished/error). */
async function executeRun(
  record: RunRecord,
  apiKey: string,
  opts: StartRunOpts,
): Promise<RunRecord> {
  const saver = createSaver(record);
  try {
    await runLoop(record, apiKey, opts, saver);
    // As portas suaves de orcamento saem do runLoop com `return`, sem lancar —
    // e o que preserva o resultado parcial. Mas o record ficaria eternamente
    // 'running' (e um agente que faz polling esperaria para sempre), entao o
    // fechamento terminal acontece aqui.
    if (record.status === 'running') {
      record.status = record.stoppedReason ? 'aborted' : 'finished';
      record.finishedAt = nowIso();
      emitEvent({ type: 'run.finished', runId: record.id, record });
      log(record.id, `run encerrada cedo (${record.stoppedReason ?? 'sem fase executavel'})`, {
        totalCostUsd: record.totalCostUsd,
      });
    }
  } catch (err) {
    if (isControlSignal(err)) {
      // Orcamento/cancelamento NAO sao erro: a run tem resultado parcial valido.
      // Reusa o status 'aborted' que ja existe (SSE, listagem e
      // markOrphansAsAborted ja o tratam) e discrimina em `stoppedReason`.
      record.status = 'aborted';
      record.stoppedReason = err.benchControl === 'budget' ? 'budget' : 'cancelled';
      if (err.benchControl === 'budget') record.budgetExhausted = true;
      record.finishedAt = nowIso();
      log(record.id, `run interrompida (${record.stoppedReason})`, {
        totalCostUsd: record.totalCostUsd,
      });
      emitEvent({ type: 'run.finished', runId: record.id, record });
    } else {
      console.error(`[bench ${record.id}] run.error:`, err);
      record.status = 'error';
      record.error = err instanceof Error ? err.message : String(err);
      record.finishedAt = nowIso();
      emitEvent({ type: 'run.error', runId: record.id, error: record.error });
    }
  } finally {
    // UMA escrita terminal, sem timer orfao — vale para os tres desfechos.
    await saver.flush();
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
  saver: Saver,
): Promise<void> {
  const { id: runId } = record;
  const scheduleSave = (): void => saver.schedule();

  // Catalogo QUENTE antes do primeiro gasto. Sem isto `computeCost` devolve 0 e
  // `fitEffort` ignora a allowlist de esforco (HTTP 400 em 83 modelos). Antes o
  // cache so esquentava dentro do competidor — depois de o datagen ja ter gasto.
  const catalogo = await listModels(apiKey).catch((err: unknown) => {
    console.warn(`[bench ${runId}] catalogo indisponivel: ${(err as Error).message}`);
    return [];
  });

  // Ledger: filho do da sessao (treino) ou proprio, a partir de config.budgetUsd.
  const ledger =
    opts.parentLedger?.fork() ??
    new BudgetLedger({
      budgetUsd: record.config.budgetUsd,
      signal: opts.ctx?.signal ?? opts.signal,
      estimateCall: makeCallEstimator(catalogo, { maxPricePerMTok: record.config.maxPricePerMTok }),
    });
  const ctx: RunCtx = { signal: opts.ctx?.signal ?? opts.signal ?? ledger.signal, sink: ledger };
  const maxPricePerMTok = record.config.maxPricePerMTok;
  record.budgetUsd = ledger.remainingUsd() !== undefined ? ledger.snapshot().budgetUsd : undefined;

  // Estimativa por papel — base das PORTAS SUAVES de orcamento. Preco
  // desconhecido (roteador, "-1") entra pelo PIOR CASO: projetar de menos
  // deixaria a fase comecar e a porta dura corta-la no meio (IMPL-018).
  // ⚠️ Em variation (`opts.prepare`) os contestants ainda NAO existem aqui:
  // `contestantIds: []` estimaria ZERO competidores e a porta atomica G2 nunca
  // dispararia (a run pagava as respostas e parava sem nota, passando do teto).
  // Lista vazia => o estimador conta tecnicas+base; a estimativa e refeita com
  // os contestants reais depois do `prepare` (espelho do web).
  // Degrau por contestant = o MESMO que o competidor recebe (IMPL-016): o teto
  // do competidor inclui a folga de raciocinio desse degrau.
  const estimar = (contestants: ReadonlyArray<{ id: string; reasoningLevel?: ReasoningLevel }>) =>
    estimateRunCost(
      estimateInputFromConfig(
        record.config,
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
      { unknownPrice: 'worst-case' },
    );
  let est = estimar(record.contestants);

  /**
   * Porta suave. A unidade NAO e "uma fase", e um GRUPO que produz resultado
   * coerente: competidores+julgamento sao atomicos, porque autorizar respostas
   * sem poder paga-las de volta produz etapas com resposta e sem nota — o
   * resultado-lixo-com-cara-de-sucesso que este design existe para evitar.
   * Devolver false NAO lanca: o controle cai na finalizacao normal.
   */
  const gate = (phase: RunPhase, projectedUsd: number): boolean => {
    ledger.throwIfCancelled();
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

  /**
   * Copia o ledger para o record (chamado nos marcos e no fim). Inclui os
   * sinais de fim por papel e a taxa de truncamento da run (IMPL-014): o
   * gateway os entrega ao ledger no mesmo ponto unico do custo, entao cobrem
   * 100% das chamadas que completaram — juiz e duelo inclusive.
   */
  const syncLedger = (): void => {
    const snap = ledger.snapshot();
    record.totalCostUsd = snap.spentUsd;
    record.costByRole = snap.byRole;
    record.costAccuracy = snap.accuracy;
    record.costLedger = ledger.summary(); // IMPL-017: spent/committed/pending
    if (snap.upstreamUsd > 0) record.upstreamCostUsd = snap.upstreamUsd;
    Object.assign(record, truncationRecordFields(snap.finishByRole));
  };
  saver.bindLedger(syncLedger);

  /**
   * IMPL-019 (R-07b:REC-8) — ciclo de vida de TODO modelo da run, do catálogo
   * já carregado (zero rede extra): canonicalSlug/expirationDate/aliasTarget por
   * papel + alertas 30/14/7 dias / expirado / ausente. NUNCA migra sozinho: só
   * grava e avisa — trocar o modelo em silêncio quebraria a comparação pareada.
   * Roda no início (cobre a run que para cedo) e de novo quando o `prepare`
   * troca os contestants; `avisados` evita repetir o mesmo aviso no log.
   */
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
      log(runId, `ciclo de vida: ${a.message}`);
    }
  };
  captureLifecycle();

  await saveRun(record);
  emitEvent({ type: 'run.started', runId, record });
  log(runId, 'started', {
    mode: record.mode,
    stages: record.config.stages,
    contestants: record.contestants.length,
  });

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

  // Resolve contestants on-demand (variacao: gera as variantes via optimizer).
  if (opts.prepare) {
    if (!gate('variants', est.byRole.rewriter)) {
      record.stages = [];
      syncLedger();
      return;
    }
    emitEvent({ type: 'variants.generating', runId });
    const contestants = await opts.prepare(ctx);
    if (contestants.length < 2) {
      throw new Error(
        'Variacao precisa de ao menos 2 contestants validos (verifique as tecnicas/variantes ou o modelo optimizer).',
      );
    }
    record.contestants = contestants;
    record.scoreboard = Object.fromEntries(contestants.map((c) => [c.id, 0]));
    record.costByContestant = Object.fromEntries(contestants.map((c) => [c.id, 0]));
    captureLifecycle();
    // As portas seguintes (G1, G2 atomica, finais) medem com os contestants REAIS.
    est = estimar(contestants);
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

  // G1 = datagen + gabaritos: descartavel inteiro, antes de gastar com respostas.
  const custoG1 = est.byRole.datagen + est.byRole.gabarito;
  if (custoG1 > 0 && !gate('datagen', custoG1)) {
    syncLedger();
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
  // IMPL-034 (R-14a DEC-7): etapa com `verify[]` numa run só de agentes NÃO
  // gera gabarito — o veredito vem do oráculo (+ juiz de dossiê, que não lê a
  // referência) e as finais são decididas pelo oráculo. Antes o gabarito saía
  // igual e era 64% do custo de uma run trivial, sem leitor (0 tokens agora).
  const hasChatContestant = record.contestants.some((c) => c.runner !== 'agent');
  const precisamGabarito = specs
    .map((spec, idx) => ({ spec, idx }))
    .filter(({ spec }) => needsTextReference(spec, { hasChatContestant }));
  if (referenceJudging && precisamGabarito.length > 0) {
    const preenchidas = await generateReferences({
      stages: precisamGabarito.map((p) => p.spec),
      stageNumbers: precisamGabarito.map((p) => p.idx + 1),
      apiKey,
      modelId: record.config.referenceModelId ?? record.config.judgeModelIds[0],
      reasoningLevel: record.config.reasoning?.judge,
      timeoutMs: datagenTimeout,
      ctx,
      maxPricePerMTok,
      // stageIndex -1 = progresso AGREGADO do lote (done/total de gabaritos
      // concluidos), nao de uma etapa especifica.
      onProgress: (done, total) =>
        emitEvent({ type: 'stage.gabarito', runId, stageIndex: -1, done, total }),
      // `k` indexa o SUBCONJUNTO que precisou de gabarito (IMPL-034) — volta
      // para a posicao em `specs`.
      onCall: (k, call) => gabaritoCalls.set(precisamGabarito[k].idx, call),
    });
    specs = specs.slice();
    precisamGabarito.forEach((p, k) => {
      specs[p.idx] = preenchidas[k];
    });
  }

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
    // Gabarito que CONTINUOU truncado apos o retry x2 foi descartado: a etapa
    // segue sem regua (listwise). Aviso VISIVEL — antes so um console.warn. Um aviso
    // por gabarito: com repeats, no 1o clone (onde a chamada fica persistida).
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
  syncLedger();
  scheduleSave();

  // Contestants ja sao finais aqui (opts.prepare rodou). Controle = ancora do
  // standings: o prompt original (isOriginal), o 'carry' do treino, ou o 1o
  // contestant como fallback.
  const controlId =
    record.contestants.find((c) => c.isOriginal || c.id === 'carry')?.id ??
    record.contestants[0]?.id;
  const labelOf = (id: string): string => record.contestants.find((c) => c.id === id)?.label ?? id;

  // === FASE 2+3: G2 — respostas E julgamento sao UM grupo indivisivel. ===
  // Autorizar os competidores sem reservar o julgamento na MESMA decisao
  // produziria etapas com resposta e sem nota (ou metade julgada), que e o
  // resultado incompleto com aparencia de completo.
  // Em modo agente, G2 ganha `est.byRole.agent` no mesmo grupo (o plano §20.1/§20.6:
  // execuções de agente + julgamento são ATÔMICOS, de propósito).
  const hasAgent = record.contestants.some((c) => c.runner === 'agent');
  // Versão da árvore de veredito de agente que produz as notas desta run —
  // estampada ANTES de qualquer veredito, para valer também em run abortada.
  // Ausente numa run com agente = legado (v1: corte por limite fora do
  // denominador); notas de versões diferentes não se comparam (IMPL-032).
  if (hasAgent) record.agentVerdictTreeVersion = AGENT_VERDICT_TREE_VERSION;
  // IMPL-033: contagem de `judgeError` (juiz de agente que falhou mesmo após as
  // 2 retentativas) e de reps sem veredito por motivo não-controle, POR RUN —
  // presentes desde já (0) para valerem também em run abortada.
  if (hasAgent) {
    record.agentJudgeErrorCount = 0;
    record.agentJudgeErrorsByContestant = {};
    record.agentUnscoredRepsByContestant = {};
  }
  const custoG2 = est.byRole.competitor + est.byRole.judge + (hasAgent ? est.byRole.agent : 0);
  if (custoG2 > 0 && !gate('competitors', custoG2)) {
    for (const st of record.stages) {
      if (st.spec && !st.error) {
        st.incomplete = true;
        st.incompleteReason = 'budget';
      }
    }
    syncLedger();
    return;
  }

  // Cada etapa e isolada (try/catch): uma falha nao derruba a run nem as outras.
  // O placar e ADITIVO (applyScoreboard) — independe da ordem de termino.
  // allSettled em vez de all: com `all`, a primeira rejeicao desenrola o loop
  // enquanto as irmas seguem gastando, e o resultado delas se perde DEPOIS de o
  // dinheiro sair. Aqui todas terminam e so entao o sinal de controle sobe.
  const agentMaxParallel = Math.max(
    1,
    record.config.agent?.maxParallel ?? Math.min(4, (hasAgent ? cpus().length - 1 : 1)),
  );
  // Governador de processos de agente COMPARTILHADO entre todas as etapas: se
  // cada etapa tivesse o próprio, N etapas em paralelo = N×maxParallel processos.
  const agentSemaphore = hasAgent ? new AgentSemaphore(agentMaxParallel) : undefined;
  // IMPL-034: nota de ORÁCULO por contestant das etapas decididas pelo oráculo
  // (verify[] + só agentes) — as finais dessas etapas saem daqui, sem LLM.
  const oracleDuelScoresByStage = new Map<number, Record<string, number>>();

  const etapasSettled = await Promise.allSettled(
    record.stages.map(async (stageRecord) => {
      const i = stageRecord.index;
      const stageSpec = stageRecord.spec;
      if (!stageSpec || stageRecord.error) return; // pulada na fase 1

      try {
        // Verditios dos contestants de runner 'agent' (agregados por rep) e os
        // que ficaram sem veredito — cancelamento, ou (IMPL-033) toda rep sem
        // observação: sem oráculo e juiz falho/não chamado. Corte por limite e
        // check que não terminou contam como falha e ficam no ranking/judge-score.
        const agentVerdicts: Record<string, Verdict> = {};
        const agentExplanations: Record<string, string> = {};
        const agentIncompleteIds = new Set<string>();
        // Vereditos POR REPETIÇÃO, por contestant — só quando a etapa roda com
        // reps > 1 (§18.4). Cada rep é uma observação independente; quem consome
        // o record precisa do vetor plano (cenário × repetição) para o
        // judge-score e a significância, não só da média ordinal da etapa.
        const agentVerdictsByRep: Record<string, Verdict[]> = {};
        const agentRepIncomplete: Record<string, number> = {};
        // Reps decididas pelo caminho 'limit-cut' (já contadas como 'nao'): só
        // alimentam o diagnóstico "sucesso até o limite" (IMPL-032).
        const agentLimitCuts: Record<string, number> = {};
        // IMPL-033: reps com juiz falho (flag judgeError) e reps sem veredito por
        // motivo NÃO-controle (sem oráculo: juiz falhou ou não foi chamado).
        const agentJudgeErrors: Record<string, number> = {};
        const agentUnscored: Record<string, number> = {};
        // Procedência do veredito agregado de cada agente, nos nomes FIXOS do
        // CONVENTIONS §2 (os consumidores do IMPL-004 leem esses dois mapas).
        // Sai das reps (`agentStageProvenance`): o motivo da ausência é o real
        // (juiz falhou / sem régua), não um 'competitor_error' genérico — no
        // merge com o IMPL-004, este mapa prevalece para os agentes.
        const agentVerdictSources: Record<string, VerdictSource> = {};
        const agentVerdictErrors: Record<string, VerdictError> = {};
        // Reps e contagens de cada agente — a regra da CÉLULA (defeito do
        // ambiente) só pode ser aplicada depois que TODOS terminaram.
        const agentRepsById: Record<string, AgentRepResult[]> = {};
        const agentTallies: Record<string, RepCounts> = {};
        const agentContestants = record.contestants.filter((c) => c.runner === 'agent');
        const chatContestants = record.contestants.filter((c) => c.runner !== 'agent');

        // Competidores em paralelo — SEM cap local; o limitador global throttla.
        // (Agentes têm `reps` SEQUENCIAIS dentro do próprio contestant; a
        // concorrência ENTRE contestants é gateada pelo `maxParallel` do agente
        // em `runAgentStage`/orquestrador e pelo limitador global de openrouter.)
        const respSettled = await Promise.allSettled(
          record.contestants.map(async (contestant) => {
            let response;
            if (contestant.runner === 'agent') {
              // Processos de agente são gateados pelo semáforo local (§20.5);
              // o valor 1+ garante que o fake/smoke nunca fique sem vaga.
              const run = (): ReturnType<typeof runAgentStage> =>
                runAgentStage({
                  runId,
                  stageIndex: stageRecord.index,
                  contestant,
                  stage: stageSpec,
                  agentConfig: record.config.agent!,
                  apiKey,
                  ctx,
                  dataDir: getDataDir(),
                  catalog: catalogo,
                  blindIds: record.contestants.map((c) => c.id),
                  judgeModelIds: record.config.judgeModelIds,
                });
              const agentRes = agentSemaphore ? await agentSemaphore.run(run) : await run();
              response = agentRes.response;
              // Veredito agregado da etapa = MAIORIA SIMPLES das reps (IMPL-007).
              // Sem veredito algum (cancelamento — que na prática já subiu como
              // RunCancelled — ou rep sem veredito legítimo, IMPL-033) => fora do
              // ranking e do judge-score SEM pontos e SEM 'nao' (IMPL-004). Corte
              // por limite e erro de execução TÊM veredito ('nao') e ficam no
              // denominador (IMPL-032).
              const tally = tallyReps(agentRes.repResults);
              const valid = tally.verdicts;
              agentRepsById[contestant.id] = agentRes.repResults;
              agentTallies[contestant.id] = tally;
              if (tally.judgeErrors > 0) agentJudgeErrors[contestant.id] = tally.judgeErrors;
              if (tally.unscored > 0) agentUnscored[contestant.id] = tally.unscored;
              const proc = agentStageProvenance(agentRes.repResults);
              if (proc.source) agentVerdictSources[contestant.id] = proc.source;
              if (proc.error) agentVerdictErrors[contestant.id] = proc.error;
              if (valid.length === 0) {
                agentIncompleteIds.add(contestant.id);
              } else {
                const agg = aggregateAgentVerdict(valid);
                agentVerdicts[contestant.id] = agg;
                // Explicação de uma rep que votou O veredito agregado — nunca a
                // da rep de voto mais alto num empate (IMPL-007).
                agentExplanations[contestant.id] =
                  agentRes.repResults.find((r) => r.verdict === agg)?.explanation ??
                  '(sem explicação do juiz)';
              }
              if (tally.limitCuts > 0) agentLimitCuts[contestant.id] = tally.limitCuts;
              // Expõe POR-REPETIÇÃO quando reps > 1 (§18.4): o vetor plano vira
              // observações independentes no denominador do judge-score e no
              // pareamento (cenário × repetição) do pairedSignificance. Reps
              // sem veredito NÃO entram no vetor — canceladas contam em
              // repIncomplete, juiz-sem-oráculo em unscoredRepsByContestant;
              // reps cortadas por limite ENTRAM como 'nao'.
              const reps = record.config.agent?.repetitions ?? 1;
              if (reps > 1) {
                agentVerdictsByRep[contestant.id] = valid;
                if (tally.cancelled > 0) agentRepIncomplete[contestant.id] = tally.cancelled;
              }
            } else {
              response = await runCompetitor({
                apiKey,
                contestantId: contestant.id,
                modelId: contestant.modelId,
                systemPrompt: contestant.systemPrompt,
                stage: stageSpec,
                timeoutMs: record.config.timeoutMs,
                retries: 1,
                maxOutputTokens: record.config.maxOutputTokens,
                temperature:
                  contestant.temperature ??
                  ('temperature' in record.config ? record.config.temperature : undefined),
                reasoningLevel: contestant.reasoningLevel ?? record.config.reasoning?.competitor,
                ctx,
                maxPricePerMTok,
              });
            }

            stageRecord.responses.push(response);
            // Bloqueio (defesa do gateway) ≠ recusa do modelo ≠ erro de infra —
            // tres contagens separadas no record (IMPL-010 / R-21:REC-6).
            record.competitorOutcomeCounts = countCompetitorOutcomes(record.stages);
            // `costByContestant` continua sendo a FATIA dos competidores; o
            // total verdadeiro vem do ledger (juiz/duelo/datagen nao sao
            // atribuiveis a um contestant e nao devem ser espalhados neles).
            if (record.costByContestant) {
              record.costByContestant[contestant.id] =
                (record.costByContestant[contestant.id] ?? 0) + response.costUsd;
            }
            syncLedger();
            scheduleSave();
            emitEvent({ type: 'competitor.finished', runId, stageIndex: i, response });
            return response;
          }),
        );
        for (const r of respSettled) {
          if (r.status === 'rejected' && isControlSignal(r.reason)) throw r.reason;
        }
        // IMPL-004: agente 'incomplete' (§18.3) não tem veredito — o motivo fica
        // registrado (conta em failureCountByRole.agent), nunca um 'nao'.
        const agentErrors: Record<string, VerdictError> = {};
        for (const id of agentIncompleteIds) {
          agentErrors[id] = {
            kind: 'competitor_error',
            message: 'Execução de agente incompleta (nenhuma repetição com veredito).',
          };
        }
        // O motivo da árvore de veredito (`agentStageProvenance`) prevalece.
        const agentErrorsAll: Record<string, VerdictError> = { ...agentErrors, ...agentVerdictErrors };

        // IMPL-033 (revisão) — DEFEITO DO AMBIENTE invalida a CÉLULA para TODOS
        // (R-14a DEC-2). Check que nem começou (comando ausente/sem permissão)
        // já entra no score de cada rep como FALHO; aqui se decide se isso era
        // o agente (o check rodou em alguma outra execução da etapa: o ambiente
        // serve) ou a tarefa (não rodou em NENHUMA: o ambiente não serve).
        // No 2º caso a etapa sai do placar para todos — agentes E chat —, com
        // `error` explícito; tirar só de quem falhou recriaria o viés de
        // sobrevivência (quem quebra o verificador escaparia do denominador).
        const defeito =
          agentContestants.length > 0 ? oracleCellDefect(Object.values(agentRepsById).flat()) : null;
        if (defeito) {
          const msg =
            `etapa inválida para TODOS os contestants: o verificador (${defeito.labels.join(', ')}) ` +
            `nem começou em nenhuma das ${defeito.executions} execução(ões) — comando ausente ou sem ` +
            `permissão no ambiente da tarefa (defeito da tarefa, não desempenho; R-14a DEC-2)`;
          stageRecord.error = msg;
          stageRecord.finishedAt = nowIso();
          scheduleSave();
          emitEvent({ type: 'stage.failed', runId, stageIndex: i, error: msg });
          log(runId, `stage ${i + 1} ${msg}`);
          return;
        }
        // IMPL-014 (R-07b:DEC-2): resposta que CONTINUOU truncada depois do
        // retry x2 torna a etapa `incomplete` — fora do placar e das medias.
        // Nao julga: comparar uma resposta cortada com respostas inteiras mede
        // o nosso teto, nao o prompt (e o juiz so pagaria por um veredito que
        // seria descartado). Sem veredito, todo consumidor (judge-score,
        // medalhas, pareamento, licoes, finais) ja pula a etapa.
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

        // Contagens POR RUN só das etapas que valem (a inválida acima não soma).
        for (const [id, t] of Object.entries(agentTallies)) {
          if (t.judgeErrors > 0) {
            record.agentJudgeErrorCount = (record.agentJudgeErrorCount ?? 0) + t.judgeErrors;
            const porContestant = (record.agentJudgeErrorsByContestant ??= {});
            porContestant[id] = (porContestant[id] ?? 0) + t.judgeErrors;
          }
          if (t.unscored > 0) {
            const porContestant = (record.agentUnscoredRepsByContestant ??= {});
            porContestant[id] = (porContestant[id] ?? 0) + t.unscored;
          }
        }

        // IMPL-034: etapa com verify[] numa run só de agentes é DECIDIDA PELO
        // ORÁCULO — sem gabarito textual (fase 1.5 pulada): o veredito vem da
        // árvore de cada execução e as finais, das notas do oráculo.
        const decididaPeloOraculo =
          agentContestants.length > 0 && chatContestants.length === 0 && stageHasVerify(stageSpec);
        if (decididaPeloOraculo) oracleDuelScoresByStage.set(i, agentOracleDuelScores(agentRepsById));

        // === FASE 3: julgamento POINTWISE. Com gabarito: cada resposta contra
        // a referencia (os duelos sairam daqui — viraram a fase 4 de finais).
        // Etapa decidida pelo oráculo: os vereditos da árvore de agente.
        // Sem gabarito: juiz LISTWISE classico (compare antigo / fallback). ===
        emitEvent({ type: 'stage.judging', runId, stageIndex: i });
        try {
          if (stageSpec.reference?.trim() || decididaPeloOraculo) {
            // Pointwise: cada resposta classificada isoladamente contra o
            // gabarito (resolve/parcial/nao) — base do judge-score.
            //
            // Em modo AGENTE (runner 'agent'), o veredito do contestant já saiu
            // da própria execução (oráculo/dossiê — ver `runAgentStage`). O
            // juiz de referência aqui SÓ julga os contestants de 'chat': os
            // agentes são SOMADOS ao veredito no final, sem reavaliar (a
            // trajetória não é texto de chat). Etapa 100% agente nem chama o
            // refJudge — o `referenceJudge` é montado dos vereditos de agente.
            let refJudge: ReferenceJudgeResult;
            if (agentContestants.length === 0) {
              // 100% chat — fluxo de hoje, intacto.
              refJudge = await judgeStageReference({
                stage: stageSpec,
                responses: stageRecord.responses,
                contestants: record.contestants,
                judgeModelIds: record.config.judgeModelIds,
                apiKey,
                reasoningLevel: record.config.reasoning?.judge,
                timeoutMs: record.config.timeoutMs,
                ctx,
                maxPricePerMTok,
              });
            } else if (chatContestants.length === 0) {
              // 100% agente — os vereditos já vieram do runAgentStage.
              refJudge = {
                verdictByContestant: { ...agentVerdicts },
                explanationByContestant: { ...agentExplanations },
                verdictSourceByContestant: { ...agentVerdictSources },
                // IMPL-004: agente sem veredito fica SEM chave, com o motivo (o da
                // árvore de veredito prevalece sobre o genérico de 'incomplete').
                ...(Object.keys(agentErrorsAll).length > 0 && { verdictErrorByContestant: { ...agentErrorsAll } }),
                judgeModelId: record.config.judgeModelIds.join('+'),
                // §18.4: quando a etapa tem reps>1, guarda o vetor plano por rep
                // para o orquestrador montar o judge-score/vetor plano e a
                // significância (o irmão `repIncomplete` registra as rep perdidas).
                ...(Object.keys(agentVerdictsByRep).length > 0 && {
                  verdictsByRep: agentVerdictsByRep,
                }),
                ...(Object.keys(agentRepIncomplete).length > 0 && {
                  repIncomplete: agentRepIncomplete,
                }),
                ...(Object.keys(agentLimitCuts).length > 0 && {
                  limitCutByContestant: agentLimitCuts,
                }),
                ...(Object.keys(agentJudgeErrors).length > 0 && {
                  judgeErrorByContestant: agentJudgeErrors,
                }),
                ...(Object.keys(agentUnscored).length > 0 && {
                  unscoredRepsByContestant: agentUnscored,
                }),
              };
            } else {
              // Misto: refJudge roda SÓ com as respostas/contestants de chat, e o
              // orquestrador COMPLETA verdictByContestant com os agentes.
              const chatResponses = stageRecord.responses.filter(
                (r) => !agentContestants.some((a) => a.id === r.contestantId),
              );
              const base = await judgeStageReference({
                stage: stageSpec,
                responses: chatResponses,
                contestants: chatContestants,
                judgeModelIds: record.config.judgeModelIds,
                apiKey,
                reasoningLevel: record.config.reasoning?.judge,
                timeoutMs: record.config.timeoutMs,
                ctx,
                maxPricePerMTok,
              });
              const erros = { ...(base.verdictErrorByContestant ?? {}), ...agentErrorsAll };
              refJudge = {
                ...base,
                verdictByContestant: { ...base.verdictByContestant, ...agentVerdicts },
                explanationByContestant: { ...base.explanationByContestant, ...agentExplanations },
                verdictSourceByContestant: { ...(base.verdictSourceByContestant ?? {}), ...agentVerdictSources },
                ...(Object.keys(erros).length > 0 && { verdictErrorByContestant: erros }),
                // §18.4: reps>1 — anexa o vetor plano por rep e o count de
                // incomplete dos agentes (chat não tem reps, fica de fora).
                ...(Object.keys(agentVerdictsByRep).length > 0 && {
                  verdictsByRep: agentVerdictsByRep,
                }),
                ...(Object.keys(agentRepIncomplete).length > 0 && {
                  repIncomplete: agentRepIncomplete,
                }),
                ...(Object.keys(agentLimitCuts).length > 0 && {
                  limitCutByContestant: agentLimitCuts,
                }),
                ...(Object.keys(agentJudgeErrors).length > 0 && {
                  judgeErrorByContestant: agentJudgeErrors,
                }),
                ...(Object.keys(agentUnscored).length > 0 && {
                  unscoredRepsByContestant: agentUnscored,
                }),
              };
            }
            stageRecord.referenceJudge = refJudge;

            // JudgeResult SINTETIZADO para nao quebrar scoreboard/medals/UI:
            // ranking SEMPRE por veredito (resolve > parcial > nao). Os duelos so
            // acontecem na fase 4, entao nao ha ordem de duelos para consultar aqui.
            // O desempate NAO pode ser a ordem dos contestants: o controle
            // ('original'/'carry') e sempre o primeiro do array, entao sort estavel
            // daria a ele todos os 1os lugares em empate — enviesando medalhas e
            // placar a favor da regua. Usa o shuffle cego semeado pelo conteudo da
            // etapa (mesmo criterio dos duelos): deterministico e neutro.
            // Contestant SEM veredito (agente sem veredito legítimo, juiz que
            // falhou, competidor com erro de infra/bloqueado — IMPL-004) fica
            // FORA do ranking: sem pontos e sem 'nao' imputado — por isso o
            // `filter` abaixo. Corte por limite de agente é 'nao' e é ranqueado.
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
              rawJudgeText:
                chatContestants.length === 0
                  ? 'Árvore de veredito do agente (oráculo + juiz de dossiê)'
                  : 'Juiz de referência (gabarito)',
              inconclusive: refJudge.inconclusive,
            };
          } else {
            // F2: etapa sem gabarito em modo agente — o fluxo listwise julgará a
            // resposta do AGENTE pelo texto-resumo (não pela trajetória). Aviso
            // ÚNICO no stderr (comportamento mantido — só avisa).
            if (agentContestants.length > 0) {
              console.warn(
                'etapa sem gabarito em modo agente — candidato julgado pelo resumo (1 linha); use verify[] ou reference para modo agente',
              );
            }
            stageRecord.judge = await judgeStage({
              apiKey,
              stage: stageSpec,
              responses: stageRecord.responses,
              judgeModelIds: record.config.judgeModelIds,
              timeoutMs: record.config.timeoutMs,
              passes: record.config.judgePasses,
              reasoningLevel: record.config.reasoning?.judge,
              ctx,
              maxPricePerMTok,
            });
          }
        } catch (judgeErr) {
          // Sem isto, orcamento estourado viraria "juiz inconclusivo" e a etapa
          // entraria no placar como se tivesse sido avaliada.
          if (isControlSignal(judgeErr)) throw judgeErr;
          const motivo = judgeErr instanceof Error ? judgeErr.message : String(judgeErr);
          // IMPL-004: a etapa fica SEM veredito para todos — com o motivo, para
          // a falha entrar em failureCountByRole (nunca passa por run íntegra).
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
        // pontua seu ranking). Referencia: 1x pelo ranking sintetizado por
        // veredito — judges vem vazio de proposito.
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
        // MENOS orcamento/cancelamento, que sao decisao, nao acidente.
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
  syncLedger();

  // === Agregados do julgamento por referencia (trainer/UI consomem). ===
  // Etapas `incomplete` (cortadas por orcamento) ficam de fora: contar uma
  // etapa sem julgamento como 'nao' rebaixaria todo mundo por falta de dinheiro.
  const stagesComRef = record.stages.filter((s) => s.referenceJudge && !s.incomplete);
  if (stagesComRef.length > 0) {
    // judge-score = (resolve + 0.5*parcial) / julgados * 100, por contestant,
    // sobre as etapas com juiz de referencia. Veredito AUSENTE (IMPL-004: juiz
    // que falhou, competidor com erro de infra/bloqueado, agente sem veredito
    // legitimo) e "sem evidencia" e NAO conta como 'nao' — sai do numerador e
    // do denominador (`judgeScoreFromVerdicts` ignora `undefined`).
    //
    // Observacoes por etapa (`stageObservations`): o vetor POR REP quando existe
    // (§18.4 — cada rep de agente e uma observacao independente; vetor PLANO de
    // todas as etapas x todas as reps), senao o veredito agregado da etapa.
    // Para agentes a ausencia so acontece por cancelamento ou rep sem veredito
    // legitimo (IMPL-033: sem oraculo e juiz falho/nao chamado); etapa com
    // defeito do ambiente sai para TODOS (error, sem referenceJudge). Corte por
    // limite (timeout/maxTurns/maxCost/maxOutput) chega aqui como 'nao' e CONTA
    // no denominador (IMPL-032 / R-14a DEC-1 — antes saia, e um agente que
    // estourava o teto nas tarefas dificeis ficava com nota perfeita nas
    // faceis: vies de sobrevivencia). Chat numa run mista com reps>1 usa o
    // agregado da etapa (antes ficava com vetor vazio => 0).
    record.judgeScoreByContestant = Object.fromEntries(
      record.contestants.map((c) => [
        c.id,
        judgeScoreFromVerdicts(stagesComRef.flatMap((s) => stageObservations(s.referenceJudge!, c.id))),
      ]),
    );
  }

  // §18.4 — resolveRate por contestant de agente: fracao de 'resolve' entre os
  // vereditos PLANOS (todas as etapas x todas as reps), em 0..1 com 3 casas —
  // o numero que separa "resolve sempre" de "resolve as vezes". Mesmo vetor do
  // judge-score, corte por limite incluido como 'nao'. Ao lado, SO como
  // diagnostico (nunca ranking/finais/gate): "sucesso ate o limite" (a metrica
  // censurada, sem os cortes no denominador) e a contagem de cortes.
  const agentIds = record.contestants.filter((c) => c.runner === 'agent').map((c) => c.id);
  if (agentIds.length > 0 && stagesComRef.length > 0) {
    const m = agentRateMetrics(
      stagesComRef.map((s) => s.referenceJudge!),
      agentIds,
    );
    record.resolveRateByContestant = m.resolveRateByContestant;
    record.censoredResolveRateByContestant = m.censoredResolveRateByContestant;
    record.limitCutsByContestant = m.limitCutsByContestant;
  }

  // === FASE 4: FINAIS. So os N melhores por judge-score MEDIO (todos os
  // cenarios) duelam entre si, em cada cenario com gabarito. Sai bem mais
  // barato que o antigo bracket por etapa e o resultado e comparavel (o mesmo
  // conjunto de finalistas em todas as etapas). ===
  const finalsOn = record.config.duels !== false;
  const finalistCount = record.config.finalists ?? 3;
  // Etapa decidida pelo oráculo (IMPL-034) entra nas finais SEM gabarito: o
  // par é decidido pela nota do oráculo e empate de oráculo é empate — o juiz
  // LLM não duela ali (não há régua textual, nem deve haver).
  const stagesParaDuelo = record.stages.filter(
    (s) =>
      (s.spec?.reference?.trim() || oracleDuelScoresByStage.has(s.index)) && !s.error && !s.incomplete,
  );
  const podeFinais = est.byRole.duel === 0 || gate('finals', est.byRole.duel);
  if (
    podeFinais &&
    finalsOn &&
    finalistCount !== 0 &&
    stagesParaDuelo.length > 0 &&
    record.contestants.length >= 2 &&
    record.judgeScoreByContestant
  ) {
    const finalistas = pickFinalists(
      record.contestants.map((c) => ({
        id: c.id,
        score: record.judgeScoreByContestant![c.id] ?? 0,
      })),
      finalistCount,
      seedFromId(record.id),
    );
    // Menos de 2 finalistas nao forma par — nao ha final a disputar.
    if (finalistas.length >= 2) {
      record.finalists = finalistas;
      emitEvent({
        type: 'finals.started',
        runId,
        finalists: finalistas.map((id) => ({
          id,
          label: labelOf(id),
          score: record.judgeScoreByContestant![id] ?? 0,
        })),
      });

      // TODAS as etapas em paralelo — SEM cap local; o limitador global gateia.
      let duelosDone = 0;
      const total = stagesParaDuelo.length;
      emitEvent({ type: 'duel.progress', runId, done: 0, total });
      const dueloSettled = await Promise.allSettled(
        stagesParaDuelo.map(async (st) => {
          try {
            const notasDoOraculo = oracleDuelScoresByStage.get(st.index);
            // Sem `reference`, `runStageDuels` só decide pelo oráculo (par com
            // notas iguais empata) — é o que torna a final "do oráculo" mesmo
            // quando a etapa trazia um gabarito importado.
            const { reference: _semGabarito, ...specSemGabarito } = st.spec!;
            st.duels = await runStageDuels({
              stage: notasDoOraculo ? specSemGabarito : st.spec!,
              responses: st.responses,
              contestants: record.contestants,
              judgeModelId: record.config.judgeModelIds[0],
              duelists: finalistas,
              topK: finalistas.length,
              verdictByContestant: st.referenceJudge?.verdictByContestant,
              // Etapa ground-truth (F1.4): vereditos determinísticos viram
              // scores de oráculo — os duelos decidem sem LLM (§19.1).
              // Etapa com verify[] (IMPL-034): notas do oráculo por execução.
              oracleScoresByContestant:
                notasDoOraculo ??
                (st.spec?.expected !== undefined
                  ? oracleScoresFromVerdicts(st.referenceJudge?.verdictByContestant)
                  : undefined),
              apiKey,
              reasoningLevel: record.config.reasoning?.judge,
              timeoutMs: record.config.timeoutMs,
              ctx,
              maxPricePerMTok,
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
          } catch (err) {
            if (isControlSignal(err)) throw err;
            // Degrada: a etapa fica sem duelo; a final NUNCA derruba a run.
            log(runId, `duelo da etapa ${st.index + 1} falhou`, {
              error: err instanceof Error ? err.message : String(err),
            });
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
      syncLedger();
    }
  }

  const stagesComDuelos = record.stages.filter((s) => s.duels);
  if (stagesComDuelos.length > 0) {
    // Taxa de vitória agregada cross-estagio (IMPL-007, R-04:DEC-5): vitoria 1,
    // empate 0.5, derrota 0, dividido pelos duelos disputados. NAO e Copeland.
    const acc = new Map(
      record.contestants.map((c) => [c.id, { wins: 0, ties: 0, losses: 0 }]),
    );
    for (const s of stagesComDuelos) {
      for (const d of s.duels!.duels) {
        const A = acc.get(d.a);
        const B = acc.get(d.b);
        if (!A || !B) continue;
        if (d.outcome === 'a') {
          A.wins += 1;
          B.losses += 1;
        } else if (d.outcome === 'b') {
          B.wins += 1;
          A.losses += 1;
        } else {
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
      // Estavel: empate de taxa (e de vitorias) mantem a ordem dos contestants.
      .sort((a, b) => b.winRate - a.winRate || b.wins - a.wins);
  }

  syncLedger();

  // §18.4 — aviso de repetições, irmão do `holdoutSkipped` do treino. Cada rep
  // de agente é UMA observação independente; `repetitions` default é 1, ou seja,
  // uma amostra de tamanho 1 por (cenário × contestant). A diferença de
  // judge-score entre dois agentes medida com 1 execução por cenário pode ser
  // inteiramente ruído — omitir essa fragilidade transformaria a feature em
  // regressão de qualidade. Dispara SEMPRE que uma run de agente termina com
  // repetições 1 (default também avisa: `repetitions` ausente resolve para 1).
  const repsDefault = record.config.agent?.repetitions ?? 1;
  const haAgenteReps1 =
    record.contestants.some((c) => c.runner === 'agent') && repsDefault === 1;
  if (haAgenteReps1) {
    console.warn(
      'Repetições 1 — a diferença entre contestants pode ser ruído; use 3+ para decidir.',
    );
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
      // IMPL-034: numa run com agente quem dá as notas é o juiz de DOSSIÊ — o
      // pin precisa mudar quando o prompt DELE muda (senão o drift some).
      contract: pinJudgeContract(
        record.config.judgeModelIds,
        !hasAgent
          ? JUDGE_CONTRACT_TEXT
          : record.contestants.every((c) => c.runner === 'agent')
            ? AGENT_JUDGE_SYSTEM_PROMPT
            : `${JUDGE_CONTRACT_TEXT}\n\n${AGENT_JUDGE_SYSTEM_PROMPT}`,
      ),
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
    syncLedger();
    const alertaTrunc = truncationAlert(
      { ...record.truncationCounts!, rate: record.truncationRate! },
      record.finishSignalsByRole,
    );
    if (alertaTrunc) log(runId, `ALERTA de truncamento: ${alertaTrunc}`);
    // IMPL-015: taxa por papel x esforco, alerta por celula > 1%.
    const alertaCelula = truncationCellAlert(truncationByRoleEffort(record.finishSignalsByRole));
    if (alertaCelula) log(runId, `ALERTA de truncamento: ${alertaCelula}`);
  } catch (err) {
    // Diagnostico e SUPORTE, nunca derruba a finalizacao.
    log(runId, `diagnostico do juiz falhou (ignorado): ${err instanceof Error ? err.message : String(err)}`);
  }

  // IMPL-004 (R-03b:REC-4): a run terminou o pipeline, mas só é `finished` se
  // a evidência sustenta conclusão — senão `inconclusive` (terminal), com a
  // conta gravada no record para auditoria.
  const integridade = assessVerdictIntegrity({
    stages: record.stages,
    contestants: record.contestants,
    referenceJudging,
  });
  record.failureCountByRole = integridade.failureCountByRole;
  record.verdictIntegrity = integridade.integrity;
  for (const motivo of integridade.integrity.reasons) log(runId, `inconclusiva: ${motivo}`);

  record.status = integridade.inconclusive ? 'inconclusive' : 'finished';
  record.finishedAt = nowIso();
  await saver.flush();
  emitEvent({ type: 'run.finished', runId, record });
  log(runId, record.status, { totalCostUsd: record.totalCostUsd });
}
