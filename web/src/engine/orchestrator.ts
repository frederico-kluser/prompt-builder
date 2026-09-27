const randomUUID = (): string => crypto.randomUUID();
import { generateStages } from './datagen';
import { runCompetitor } from './competitor';
import { judgeStage } from './judge';
import { generateReferences } from './gabarito';
import { judgeStageReference } from './refJudge';
import { blindRankMap, pickFinalists, runStageDuels, seedFromId, VERDICT_SCORE } from './duels';
import { oracleScoresFromVerdicts } from '../../../src/engine/duelCore.js';
import { fairnessWarningsForModels } from './llmVariants';
import { JUDGE_CONTRACT_TEXT } from './refJudge';
import { pinJudgeContract, verbosityReport } from '../../../src/engine/judgeCalibration.js';
import { mergeScenarios } from './scenarioPack';
import { sanitizeLlmVariants, variantsToContestants } from './llmVariants';
import { judgeScoreFromVerdicts } from './rank';
import { emitEvent } from './events';
import { saveRun } from './storage';
import { contestantsFromConfig } from './normalize';
import { listModels } from './openrouter';
import { enforceRunCompliance } from '../lgpd';
import { BudgetLedger, isControlSignal } from '../../../src/budget.js';
import type { Contestant, RunConfig, RunCtx, RunRecord, StageRecord, StageSpec } from './types';

function nowIso(): string {
  return new Date().toISOString();
}

function log(runId: string, msg: string, extra?: Record<string, unknown>): void {
  const payload = extra ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[bench ${runId}] ${msg}${payload}`);
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
   * Ledger EXTERNO (sessão de treino): a run reporta o próprio total e escreve
   * no pai (espelho de src/orchestrator.ts). Ausente => a run cria o próprio.
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
    startedAt: nowIso(),
    sessionId: opts.sessionId,
    iteration: opts.iteration,
    parentRunId: opts.parentRunId,
  };
}

/** Executa o loop e SEMPRE resolve com o record final (status finished/error). */
async function executeRun(
  record: RunRecord,
  apiKey: string,
  opts: StartRunOpts,
): Promise<RunRecord> {
  // Ledger: filho do da sessão (treino) ou próprio. Sem teto no web por ora —
  // aqui ele é a contabilidade de ponto único (role + sink) do gateway.
  const ledger = opts.parentLedger?.fork() ?? new BudgetLedger();
  try {
    await runLoop(record, apiKey, opts, ledger);
  } catch (err) {
    // Mesmo falhando, o que já foi gasto aparece no record.
    syncLedger(record, ledger);
    console.error(`[bench ${record.id}] run.error:`, err);
    record.status = 'error';
    record.error = err instanceof Error ? err.message : String(err);
    record.finishedAt = nowIso();
    await saveRun(record).catch(() => undefined);
    emitEvent({ type: 'run.error', runId: record.id, error: record.error });
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
  ledger: BudgetLedger,
): Promise<void> {
  const { id: runId } = record;
  // Contexto que atravessa todos os módulos de papel: o gateway contabiliza
  // cada chamada no ledger com o papel certo (datagen/gabarito/competitor/
  // judge/duel) — um ponto só, o mesmo do Node.
  const ctx: RunCtx = { signal: ledger.signal, sink: ledger };

  // --- Persistencia com THROTTLE: as etapas paralelas geram MUITAS escritas;
  // coalescemos em no max. 1x/SAVE_INTERVAL_MS (trailing) e damos flush nos
  // marcos. O estado ao vivo ja vai por SSE, entao o disco nao precisa de cada
  // delta. storage.saveRun continua serializando por run (escrita atomica). ---
  const SAVE_INTERVAL_MS = 800;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSave = 0;
  const scheduleSave = (): void => {
    if (saveTimer) return;
    const delay = Math.max(0, SAVE_INTERVAL_MS - (Date.now() - lastSave));
    saveTimer = setTimeout(() => {
      saveTimer = null;
      lastSave = Date.now();
      void saveRun(record).catch(() => undefined);
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
  // preço quando falta `usage.cost` e a allowlist de esforço/amostragem por
  // modelo. Antes só o competidor esquentava — depois de o datagen já ter ido.
  // Vem DEPOIS do run.started para a tela da run abrir sem esperar a rede.
  await listModels(apiKey).catch((err: unknown) => {
    console.warn(`[bench ${runId}] catalogo indisponivel: ${(err as Error).message}`);
    return [];
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
      // stageIndex -1 = progresso AGREGADO do lote (done/total de gabaritos
      // concluidos), nao de uma etapa especifica.
      onProgress: (done, total) =>
        emitEvent({ type: 'stage.gabarito', runId, stageIndex: -1, done, total }),
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

  // === FASE 2: rodar TODAS as etapas (com spec) EM PARALELO. ===
  // Cada etapa e isolada (try/catch): uma falha nao derruba a run nem as outras.
  // O placar e ADITIVO (applyScoreboard) — independe da ordem de termino.
  await Promise.all(
    record.stages.map(async (stageRecord) => {
      const i = stageRecord.index;
      const stageSpec = stageRecord.spec;
      if (!stageSpec || stageRecord.error) return; // pulada na fase 1

      try {
        // Competidores em paralelo — SEM cap local; o limitador global throttla.
        await Promise.all(
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
            stageRecord.judge = await judgeStage({
              apiKey,
              stage: stageSpec,
              responses: stageRecord.responses,
              judgeModelIds: record.config.judgeModelIds,
              timeoutMs: record.config.timeoutMs,
              passes: record.config.judgePasses,
              ctx,
            });
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
      } catch (stageErr) {
        // rede de seguranca: qualquer imprevisto na etapa NAO mata a run —
        // MENOS orcamento/cancelamento, que sao decisao, nao acidente.
        if (isControlSignal(stageErr)) throw stageErr;
        const msg = stageErr instanceof Error ? stageErr.message : String(stageErr);
        stageRecord.error = stageRecord.error ?? msg;
        stageRecord.finishedAt = nowIso();
        emitEvent({ type: 'stage.failed', runId, stageIndex: i, error: msg });
        log(runId, `stage ${i + 1} erro inesperado, pulando: ${msg}`);
      }
    }),
  );

  // === Agregados do julgamento por referencia (trainer/UI consomem). ===
  const stagesComRef = record.stages.filter((s) => s.referenceJudge);
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
  const stagesParaDuelo = record.stages.filter((s) => s.spec?.reference?.trim() && !s.error);
  if (
    finalsOn &&
    finalistCount !== 0 &&
    stagesParaDuelo.length > 0 &&
    record.contestants.length >= 2 &&
    record.judgeScoreByContestant
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
      await Promise.all(
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
  } catch (err) {
    // Diagnostico e SUPORTE, nunca derruba a finalizacao.
    log(runId, `diagnostico do juiz falhou (ignorado): ${err instanceof Error ? err.message : String(err)}`);
  }

  syncLedger(record, ledger);
  record.status = 'finished';
  record.finishedAt = nowIso();
  await flushSave();
  emitEvent({ type: 'run.finished', runId, record });
  log(runId, 'finished', { totalCostUsd: record.totalCostUsd });
}
