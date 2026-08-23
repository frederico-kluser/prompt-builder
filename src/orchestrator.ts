import { randomUUID } from 'node:crypto';
import { cpus } from 'node:os';
import { generateStages } from './datagen.js';
import { runCompetitor } from './competitor.js';
import { judgeStage } from './judge.js';
import { generateReferences } from './gabarito.js';
import { judgeStageReference } from './refJudge.js';
import { blindRankMap, pickFinalists, runStageDuels, seedFromId, VERDICT_SCORE } from './duels.js';
import { mergeScenarios } from './scenarioPack.js';
import { sanitizeLlmVariants, variantsToContestants } from './llmVariants.js';
import { judgeScoreFromVerdicts } from './rank.js';
import { emitEvent } from './events.js';
import { saveRun, getDataDir } from './storage.js';
import { contestantsFromConfig } from './normalize.js';
import { BudgetLedger, isControlSignal } from './budget.js';
import { estimateInputFromConfig, estimateRunCost, makeCallEstimator } from './estimate.js';
import { listModels } from './openrouter.js';
import { runAgentStage, aggregateAgentVerdict } from './agent/runAgentStage.js';
import type {
  Contestant,
  ReferenceJudgeResult,
  RunConfig,
  RunCtx,
  RunPhase,
  RunRecord,
  StageRecord,
  StageSpec,
  Verdict,
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
   */
  prepare?: () => Promise<Contestant[]>;
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
}

function createSaver(record: RunRecord): Saver {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSave = 0;
  return {
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
      estimateCall: makeCallEstimator(catalogo),
    });
  const ctx: RunCtx = { signal: opts.ctx?.signal ?? opts.signal ?? ledger.signal, sink: ledger };
  const maxPricePerMTok = record.config.maxPricePerMTok;
  record.budgetUsd = ledger.remainingUsd() !== undefined ? ledger.snapshot().budgetUsd : undefined;

  // Estimativa por papel — base das PORTAS SUAVES de orcamento.
  const est = estimateRunCost(
    estimateInputFromConfig(record.config, {
      contestantIds: record.contestants.map((c) => c.id),
    }),
    catalogo,
  );

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

  /** Copia o ledger para o record (chamado nos marcos e no fim). */
  const syncLedger = (): void => {
    const snap = ledger.snapshot();
    record.totalCostUsd = snap.spentUsd;
    record.costByRole = snap.byRole;
    record.costAccuracy = snap.accuracy;
    if (snap.upstreamUsd > 0) record.upstreamCostUsd = snap.upstreamUsd;
  };

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

  // Resolve contestants on-demand (variacao: gera as variantes via optimizer).
  if (opts.prepare) {
    if (!gate('variants', est.byRole.rewriter)) {
      record.stages = [];
      syncLedger();
      return;
    }
    emitEvent({ type: 'variants.generating', runId });
    const contestants = await opts.prepare();
    if (contestants.length < 2) {
      throw new Error(
        'Variacao precisa de ao menos 2 contestants validos (verifique as tecnicas/variantes ou o modelo optimizer).',
      );
    }
    record.contestants = contestants;
    record.scoreboard = Object.fromEntries(contestants.map((c) => [c.id, 0]));
    record.costByContestant = Object.fromEntries(contestants.map((c) => [c.id, 0]));
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
  record.stages = Array.from(
    { length: alvo },
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
  if (referenceJudging) {
    specs = await generateReferences({
      stages: specs,
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
    });
  }

  // Materializa as specs nos slots; se faltou cenario (dedup/falha de lote),
  // os slots do rabo viram stage.failed e a run segue com o que houver.
  specs.forEach((spec, i) => {
    record.stages[i].spec = spec;
    emitEvent({ type: 'stage.generated', runId, stageIndex: i, spec });
  });
  for (let i = specs.length; i < record.stages.length; i++) {
    const msg = `Datagen entregou menos cenarios que o alvo apos dedup/falha de lote; etapa descartada.`;
    record.stages[i].error = msg;
    record.stages[i].finishedAt = nowIso();
    emitEvent({ type: 'stage.failed', runId, stageIndex: i, error: msg });
  }
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
  const custoG2 = est.byRole.competitor + est.byRole.judge + (hasAgent ? est.byRole.agent : 0);
  if (custoG2 > 0 && !gate('competitors', custoG2)) {
    for (const st of record.stages) {
      if (st.spec && !st.error) st.incomplete = true;
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

  const etapasSettled = await Promise.allSettled(
    record.stages.map(async (stageRecord) => {
      const i = stageRecord.index;
      const stageSpec = stageRecord.spec;
      if (!stageSpec || stageRecord.error) return; // pulada na fase 1

      try {
        // Verditios dos contestants de runner 'agent' (agregados por rep) e os
        // que ficaram 'incomplete' (§18.3 — saem do ranking/judgeScore).
        const agentVerdicts: Record<string, Verdict> = {};
        const agentExplanations: Record<string, string> = {};
        const agentIncompleteIds = new Set<string>();
        // Vereditos POR REPETIÇÃO, por contestant — só quando a etapa roda com
        // reps > 1 (§18.4). Cada rep é uma observação independente; quem consome
        // o record precisa do vetor plano (cenário × repetição) para o
        // judge-score e a significância, não só da média ordinal da etapa.
        const agentVerdictsByRep: Record<string, Verdict[]> = {};
        const agentRepIncomplete: Record<string, number> = {};
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
              // Veredito agregado da etapa = média ordinal dos vereditos das reps.
              // incomplete (tudo null, ou tudo erro) => contestant sai do ranking
              // e do judgeScore SEM pontos e SEM 'nao' (§18.3/§15.2).
              const valid = agentRes.repResults
                .map((r) => r.verdict)
                .filter((v): v is Verdict => v !== null);
              if (valid.length === 0) {
                agentIncompleteIds.add(contestant.id);
              } else {
                agentVerdicts[contestant.id] = aggregateAgentVerdict(valid);
                agentExplanations[contestant.id] =
                  agentRes.repResults.find((r) => r.verdict !== null)?.explanation ??
                  '(sem explicação do juiz)';
              }
              // Expõe POR-REPETIÇÃO quando reps > 1 (§18.4): o vetor plano vira
              // observações independentes no denominador do judge-score e no
              // pareamento (cenário × repetição) do pairedSignificance. Reps
              // `incomplete` (veredito null) NÃO entram no vetor — são contadas
              // em repIncomplete.
              const reps = record.config.agent?.repetitions ?? 1;
              if (reps > 1) {
                agentVerdictsByRep[contestant.id] = valid;
                const incompletas = agentRes.repResults.filter((r) => r.verdict === null).length;
                if (incompletas > 0) agentRepIncomplete[contestant.id] = incompletas;
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

        // === FASE 3: julgamento POINTWISE. Com gabarito: cada resposta contra
        // a referencia (os duelos sairam daqui — viraram a fase 4 de finais).
        // Sem gabarito: juiz LISTWISE classico (compare antigo / fallback). ===
        emitEvent({ type: 'stage.judging', runId, stageIndex: i });
        try {
          if (stageSpec.reference?.trim()) {
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
              refJudge = {
                ...base,
                verdictByContestant: { ...base.verdictByContestant, ...agentVerdicts },
                explanationByContestant: { ...base.explanationByContestant, ...agentExplanations },
                // §18.4: reps>1 — anexa o vetor plano por rep e o count de
                // incomplete dos agentes (chat não tem reps, fica de fora).
                ...(Object.keys(agentVerdictsByRep).length > 0 && {
                  verdictsByRep: agentVerdictsByRep,
                }),
                ...(Object.keys(agentRepIncomplete).length > 0 && {
                  repIncomplete: agentRepIncomplete,
                }),
              };
            }
            stageRecord.referenceJudge = refJudge;

            // JudgeResult SINTETIZADO para nao quebrar scoreboard/medals/UI:
            // ranking SEMPRE por veredito (resolve > parcial > nao). Os duelos so
            // acontecem na fase 4, entao nao ha ordem Copeland para consultar aqui.
            // O desempate NAO pode ser a ordem dos contestants: o controle
            // ('original'/'carry') e sempre o primeiro do array, entao sort estavel
            // daria a ele todos os 1os lugares em empate — enviesando medalhas e
            // placar a favor da regua. Usa o shuffle cego semeado pelo conteudo da
            // etapa (mesmo criterio dos duelos): deterministico e neutro.
            // Agentes incompletos (§18.3) ficam FORA do ranking (sem pontos, sem
            // 'nao') — por isso o `filter` abaixo.
            const ordemCega = blindRankMap(
              record.contestants.map((c) => c.id),
              seedFromId(stageSpec.question),
            );
            const ranked = [...record.contestants]
              .filter((c) => !agentIncompleteIds.has(c.id))
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
    // judge-score = (resolve + 0.5*parcial) / total * 100, por contestant,
    // sobre as etapas com juiz de referencia (ausente conta como 'nao').
    //
    // Agentes 'incomplete' (§18.3) NÃO aparecem no verdictByContestant (o
    // orquestrador só os soma quando tiveram veredito) — para eles o `undefined`
    // é "sem evidência" e NÃO pode contar como 'nao' (a culpa foi do nosso teto,
    // não do agente). Filtramos os `undefined`, então o contestant entra no
    // judge-score só com as etapas em que ele pontuou de verdade. Chat NÃO muda:
    // vereditos de chat nunca são `undefined` no map.
    //
    // §18.4 — REPETIÇÕES: cada rep é uma observação independente. Quando algum
    // `referenceJudge` guarda `verdictsByRep` (contestant de agente com reps>1),
    // o score do contestant sai do vetor PLANO (todas as etapas × todas as reps),
    // não da média ordinal por etapa. `judgeScoreFromVerdicts` não muda uma linha;
    // mudou só QUEM chama com o quê. Sem `verdictsByRep` (reps=1 / chat) o fluxo
    // é exatamente o legado.
    const temVerdictsByRep = stagesComRef.some(
      (s) => s.referenceJudge!.verdictsByRep && Object.keys(s.referenceJudge!.verdictsByRep!).length > 0,
    );
    record.judgeScoreByContestant = Object.fromEntries(
      record.contestants.map((c) => {
        if (temVerdictsByRep) {
          // Vetor PLANO: concatena os vereditos POR REP de todas as etapas.
          const flat: Verdict[] = [];
          for (const s of stagesComRef) {
            const porRep = s.referenceJudge!.verdictsByRep?.[c.id];
            if (porRep) flat.push(...porRep);
          }
          return [c.id, judgeScoreFromVerdicts(flat)];
        }
        return [
          c.id,
          judgeScoreFromVerdicts(
            stagesComRef
              .map((s) => s.referenceJudge!.verdictByContestant[c.id])
              .filter((v): v is Verdict => v !== undefined),
          ),
        ];
      }),
    );
  }

  // §18.4 — resolveRate por contestant: fração de 'resolve' entre os vereditos
  // PLANOS (todas as etapas × todas as reps), em 0..1 com 3 casas. Presente só
  // quando há contestants de agente: é o número que separa "resolve sempre" de
  // "resolve às vezes". Com reps=1 vira uma amostra de tamanho 1 — o relatório
  // final já avisa (§18.4). Usa o mesmo vetor plano do judge-score acima.
  const agentIds = record.contestants.filter((c) => c.runner === 'agent').map((c) => c.id);
  if (agentIds.length > 0 && stagesComRef.length > 0) {
    record.resolveRateByContestant = Object.fromEntries(
      agentIds.map((id) => {
        let resolve = 0;
        let total = 0;
        for (const s of stagesComRef) {
          const porRep = s.referenceJudge?.verdictsByRep?.[id];
          if (porRep) {
            for (const v of porRep) {
              total += 1;
              if (v === 'resolve') resolve += 1;
            }
          } else {
            // reps=1 / etapa sem verdictsByRep — usa o veredito agregado da etapa.
            const v = s.referenceJudge?.verdictByContestant[id];
            if (v !== undefined) {
              total += 1;
              if (v === 'resolve') resolve += 1;
            }
          }
        }
        return [id, total > 0 ? Number((resolve / total).toFixed(3)) : 0];
      }),
    );
  }

  // === FASE 4: FINAIS. So os N melhores por judge-score MEDIO (todos os
  // cenarios) duelam entre si, em cada cenario com gabarito. Sai bem mais
  // barato que o antigo bracket por etapa e o resultado e comparavel (o mesmo
  // conjunto de finalistas em todas as etapas). ===
  const finalsOn = record.config.duels !== false;
  const finalistCount = record.config.finalists ?? 3;
  const stagesParaDuelo = record.stages.filter(
    (s) => s.spec?.reference?.trim() && !s.error && !s.incomplete,
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
            st.duels = await runStageDuels({
              stage: st.spec!,
              responses: st.responses,
              contestants: record.contestants,
              judgeModelId: record.config.judgeModelIds[0],
              duelists: finalistas,
              topK: finalistas.length,
              verdictByContestant: st.referenceJudge?.verdictByContestant,
              apiKey,
              reasoningLevel: record.config.reasoning?.judge,
              timeoutMs: record.config.timeoutMs,
              ctx,
              maxPricePerMTok,
            });
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

  record.status = 'finished';
  record.finishedAt = nowIso();
  await saver.flush();
  emitEvent({ type: 'run.finished', runId, record });
  log(runId, 'finished', { totalCostUsd: record.totalCostUsd });
}
