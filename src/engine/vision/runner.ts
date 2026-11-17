// BENCHMARK DE VISÃO — runner CORE (puro; Node e navegador).
//
// Uma célula = uma CHAMADA (ou duas, no `mark-grid`): (modelo × cenário) no
// modo mapa e (modelo × tarefa) no modo ação. Todas as células nascem de uma
// vez em `Promise.all` — o limitador AIMD do gateway manda na concorrência —
// e a reserva do ledger é tomada no nascimento da chamada, então um teto
// apertado corta as ÚLTIMAS e a run fica `aborted` com o parcial medido.
//
// Dinheiro: TODA chamada passa por `chatCompletion` com role `competitor` +
// sink = ledger da run. O custo do record é o do LEDGER (medido), não a soma
// dos retornos — chamada que falhou depois de despachada também custou.
//
// Bancos de probe (ROADMAP F2/F3): `resolution` muda só a escala da imagem e
// converte as coordenadas de volta para 1920×1080 antes de pontuar; `grid`
// muda só a apresentação (overlay) e, no `mark-grid`, faz uma segunda rodada
// sobre o recorte da célula. A verdade continua sendo o DOM da tela base.
//
// Sem `node:*`: a imagem do cenário chega por `imageFor` (fs no Node, fetch no
// navegador) e o id do record é gerado pelo chamador.

import { isBudgetSignal, isControlSignal, type BudgetLedger } from '../../budget.js';
import {
  isCallerRetryable,
  measuredCallUsd,
  type ChatCompletionResult,
  type ChatMessage,
  type OpenRouterGateway,
} from '../../openrouter.js';
import type { OpenRouterModel, ReasoningLevel } from '../../types.js';
import {
  VISION_GRID_PROMPT_VERSION,
  VISION_MATRIX_PROMPT_VERSION,
  VISION_PROMPT_VERSION,
  actionSystemPrompt,
  actionUserPrompt,
  gridSystemPrompt,
  gridUserPrompt,
  matrixSystemPrompt,
  matrixUserPrompt,
  mapSystemPrompt,
  mapUserPrompt,
  resolutionMapSystemPrompt,
  resolutionMapUserPrompt,
} from './prompt.js';
import { parseActionOutput, parseMapOutput } from './parse.js';
import { aggregateContestant, scoreActionTask, scoreMapScene } from './score.js';
import { datasetHash, planCells, selectScenes } from './dataset.js';
import { modelsWithoutImageInput } from './models.js';
import {
  VISION_RUN_FORMAT,
  VISION_VIEWPORT,
  type VisionActionCell,
  type VisionActionPrediction,
  type VisionBenchmark,
  type VisionCell,
  type VisionContestant,
  type VisionDataset,
  type VisionElementPrediction,
  type VisionGridCellSpec,
  type VisionGridVariant,
  type VisionImageRef,
  type VisionMatrixGrid,
  type VisionMapCell,
  type VisionRoundTrace,
  type VisionRunConfig,
  type VisionRunRecord,
  type VisionScene,
} from './types.js';

export interface RunVisionCoreParams {
  dataset: VisionDataset;
  config: VisionRunConfig;
  apiKey: string;
  gateway: OpenRouterGateway;
  /** Ledger da run (o chamador cria/forka e passa). */
  ledger: BudgetLedger;
  /**
   * Imagem do cenário (ou de uma variante) como data URL (ou https). O seam é
   * INJETADO: no Node é o fs do dataset; no navegador é `fetch` do asset.
   */
  imageFor: (scene: VisionScene, ref?: VisionImageRef) => Promise<string>;
  /** Id do record (o chamador gera; o core não conhece `node:crypto`). */
  id: string;
  signal?: AbortSignal;
  catalog?: readonly OpenRouterModel[];
  onCell?: (cell: VisionCell) => void;
  now?: () => Date;
}

export class VisionRunError extends Error {
  readonly code = 'VISION_RUN';
}

const MAX_ERROR_CHARS = 400;

function erroCurto(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > MAX_ERROR_CHARS ? `${msg.slice(0, MAX_ERROR_CHARS)}…` : msg;
}


/** Ponto da imagem enviada (moldura ou print) → ponto da tela canônica. */
function pontoDaMatriz(
  p: VisionActionPrediction,
  sent: { width: number; height: number },
  margins?: { left: number; top: number; right: number; bottom: number },
): VisionActionPrediction {
  if (p.x == null || p.y == null) return p;
  const contentW = margins ? sent.width - margins.left - margins.right : sent.width;
  const contentH = margins ? sent.height - margins.top - margins.bottom : sent.height;
  const x = margins ? p.x - margins.left : p.x;
  const y = margins ? p.y - margins.top : p.y;
  return {
    ...p,
    x: Math.max(0, Math.min(VISION_VIEWPORT.width, Math.round((x / contentW) * VISION_VIEWPORT.width))),
    y: Math.max(0, Math.min(VISION_VIEWPORT.height, Math.round((y / contentH) * VISION_VIEWPORT.height))),
  };
}

/** Um retry curto só para falha de transporte do chamador (não control signal). */
async function comRetries<T>(tentativas: number, fn: () => Promise<T>, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  let ultimo: unknown;
  for (let i = 0; i <= tentativas; i++) {
    try {
      return await fn();
    } catch (err) {
      if (isControlSignal(err) || !isCallerRetryable(err) || i === tentativas) throw err;
      ultimo = err;
      await sleep(250 * (i + 1));
    }
  }
  throw ultimo;
}

type Chamada =
  | { ok: true; result: ChatCompletionResult }
  | { ok: false; kind: 'error' | 'skipped'; error: string; budget: boolean };

interface CallContext {
  apiKey: string;
  gateway: OpenRouterGateway;
  ledger: BudgetLedger;
  config: VisionRunConfig;
  signal?: AbortSignal;
}

async function chamar(ctx: CallContext, modelId: string, messages: ChatMessage[]): Promise<Chamada> {
  try {
    const result = await comRetries(ctx.config.retries, () =>
      ctx.gateway.chatCompletion({
        apiKey: ctx.apiKey,
        modelId,
        messages,
        temperature: ctx.config.temperature,
        maxTokens: ctx.config.maxTokens,
        ...(ctx.config.timeoutMs ? { timeoutMs: ctx.config.timeoutMs } : {}),
        ...(ctx.config.reasoning ? { reasoningLevel: ctx.config.reasoning as ReasoningLevel } : {}),
        responseFormatJson: true,
        role: 'competitor',
        sink: ctx.ledger,
        ...(ctx.config.provider ? { auditable: true } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
    );
    return { ok: true, result };
  } catch (err) {
    if (isControlSignal(err)) {
      return { ok: false, kind: 'skipped', error: 'run parada (orçamento/cancelamento)', budget: isBudgetSignal(err) };
    }
    return { ok: false, kind: 'error', error: erroCurto(err), budget: false };
  }
}

function celulaVazia(
  plano: ReturnType<typeof planCells>[number],
  modelId: string,
  status: 'error' | 'skipped',
  prompt: string,
  error: string | undefined,
): VisionCell {
  const base = {
    cellId: plano.cellId,
    sceneId: plano.scene.id,
    family: plano.scene.family,
    modelId,
    contestantId: modelId,
    prompt,
    status,
    ...(error ? { error } : {}),
    latencyMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    parseOk: false,
    coordScale: 'unknown' as const,
    raw: '',
    ...(plano.benchmark ? { benchmark: plano.benchmark } : {}),
    ...(plano.variant ? { variant: plano.variant } : {}),
  };
  if (plano.kind === 'map') {
    return { ...base, kind: 'map', predictions: [] } satisfies VisionMapCell;
  }
  return {
    ...base,
    kind: 'action',
    taskId: plano.task!.id,
    instruction: plano.task!.instruction,
    prediction: null,
  } satisfies VisionActionCell;
}

/** Converte pixels da imagem reduzida para a grade canônica 1920×1080. */
function escalaParaCanonica(
  predictions: readonly VisionElementPrediction[],
  viewport: { width: number; height: number },
): VisionElementPrediction[] {
  const sx = VISION_VIEWPORT.width / viewport.width;
  const sy = VISION_VIEWPORT.height / viewport.height;
  return predictions.map((p) => ({
    ...p,
    x: Math.max(0, Math.min(VISION_VIEWPORT.width, Math.round(p.x * sx))),
    y: Math.max(0, Math.min(VISION_VIEWPORT.height, Math.round(p.y * sy))),
  }));
}

/** Ponto do recorte ampliado → ponto canônico (fonte pinada no manifesto). */
function pontoDoRecorte(
  p: VisionActionPrediction,
  cell: VisionGridCellSpec,
): VisionActionPrediction {
  if (p.x == null || p.y == null) return p;
  const x = cell.source.x + (p.x / cell.viewport.width) * cell.source.w;
  const y = cell.source.y + (p.y / cell.viewport.height) * cell.source.h;
  return {
    ...p,
    x: Math.max(0, Math.min(VISION_VIEWPORT.width, Math.round(x))),
    y: Math.max(0, Math.min(VISION_VIEWPORT.height, Math.round(y))),
  };
}

function traceOf(
  round: 1 | 2,
  prompt: string,
  chamada: Chamada,
  parse?: { ok: boolean; value: VisionActionPrediction | null; coordScale: VisionRoundTrace['coordScale']; raw: string },
  extra: Partial<VisionRoundTrace> = {},
): VisionRoundTrace {
  if (!chamada.ok) {
    return {
      round,
      prompt,
      status: chamada.kind,
      error: chamada.error,
      latencyMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      parseOk: false,
      coordScale: 'unknown',
      raw: '',
      prediction: null,
      ...extra,
    };
  }
  const r = chamada.result;
  return {
    round,
    prompt,
    status: 'ok',
    latencyMs: r.latencyMs,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    costUsd: measuredCallUsd(r.cost) ?? 0,
    ...(r.provider?.name ? { provider: r.provider.name } : {}),
    parseOk: Boolean(parse?.ok),
    coordScale: parse?.coordScale ?? 'unknown',
    raw: parse?.raw ?? '',
    prediction: parse?.value ?? null,
    ...extra,
  };
}

/**
 * Executa um benchmark de visão e devolve o record (o chamador persiste).
 * Fonte ÚNICA do laço de células: Node (CLI) e navegador (SPA) injetam o seam
 * da imagem e o ledger — nenhuma cópia da lógica de run/placar.
 */
export async function runVisionCore(params: RunVisionCoreParams): Promise<VisionRunRecord> {
  const { dataset, config, apiKey, gateway, ledger } = params;
  const now = params.now ?? (() => new Date());
  if (config.models.length === 0) throw new VisionRunError('nenhum modelo selecionado.');
  const benchmark: VisionBenchmark = config.benchmark ?? 'grounding';
  const inicio = now();

  const selecao = selectScenes(dataset, {
    families: config.families,
    scenes: config.scenes,
    limit: config.limit,
  });
  if (selecao.scenes.length === 0) {
    throw new VisionRunError('a seleção não casou com nenhum cenário do dataset.');
  }
  const planos = planCells(selecao.scenes, config.tasks, {
    benchmark,
    ...(config.resolutions ? { resolutions: config.resolutions } : {}),
    ...(config.gridVariants ? { gridVariants: config.gridVariants } : {}),
    ...(config.matrixGrids ? { matrixGrids: config.matrixGrids } : {}),
  });
  if (planos.length === 0) {
    throw new VisionRunError(
      benchmark === 'resolution'
        ? 'o banco de resolução não gerou células (use --tasks map e um dataset com variantes).'
        : benchmark === 'grid'
          ? 'o banco de grade não gerou células (use --tasks action e um dataset com overlays).'
          : 'o plano ficou vazio (modo sem cenas ou sem tarefas de ação).',
    );
  }

  const catalog = params.catalog ?? gateway.peekModelsCache(apiKey)?.data ?? [];
  const scenesById = new Map(selecao.scenes.map((s) => [s.id, s]));
  const cells: VisionCell[] = [];
  let parado = false;
  let budgetExhausted = false;
  const callCtx: CallContext = { apiKey, gateway, ledger, config, ...(params.signal ? { signal: params.signal } : {}) };

  const promessas: Array<Promise<VisionCell>> = [];
  for (const modelId of config.models) {
    for (const plano of planos) {
      promessas.push(
        (async (): Promise<VisionCell> => {
          const scene = plano.scene;
          const variant = plano.variant;
          const overlay = plano.overlay;
          const resolution = plano.resolutionRef;
          const mainViewport = resolution
            ? { width: resolution.width, height: resolution.height }
            : scene.viewport;
          const isMatrixFrame = benchmark === 'matrix' && overlay?.kind === 'frame';
          // A moldura é só referência visual: o ponto é pedido na área da
          // captura (0..w, 0..h), com origem no canto da captura. As margens
          // ficam fora do ponto e não entram no parser.
          const imageViewport = isMatrixFrame
            ? mainViewport
            : resolution
              ? mainViewport
              : overlay?.viewport ?? scene.viewport;
          const matrixOpts =
            benchmark === 'matrix'
              ? {
                  coordSpace: config.coordSpace,
                  viewport: imageViewport,
                  imageViewport: mainViewport,
                  grid: (plano.matrixGrid ?? 'plain') as VisionMatrixGrid,
                  ...(overlay?.margins ? { margins: overlay.margins } : {}),
                }
              : null;
          const promptOpts = { coordSpace: config.coordSpace, viewport: imageViewport };
          const prompt =
            benchmark === 'resolution'
              ? resolutionMapUserPrompt(promptOpts)
              : benchmark === 'matrix' && matrixOpts
                ? matrixUserPrompt(plano.task!.instruction, matrixOpts)
                : benchmark === 'grid'
                  ? gridUserPrompt(plano.task!.instruction, {
                      ...promptOpts,
                      variant: (variant ?? 'plain') as VisionGridVariant,
                    })
                  : plano.kind === 'map'
                    ? mapUserPrompt(promptOpts)
                    : actionUserPrompt(plano.task!.instruction, promptOpts);

          if (parado) return celulaVazia(plano, modelId, 'skipped', prompt, 'run parada (orçamento/cancelamento)');

          const system =
            benchmark === 'resolution'
              ? resolutionMapSystemPrompt(promptOpts)
              : benchmark === 'matrix' && matrixOpts
                ? matrixSystemPrompt(matrixOpts)
                : benchmark === 'grid'
                  ? gridSystemPrompt({
                      ...promptOpts,
                      variant: (variant ?? 'plain') as VisionGridVariant,
                    })
                  : plano.kind === 'map'
                    ? mapSystemPrompt(promptOpts)
                    : actionSystemPrompt(promptOpts);
          const messages: ChatMessage[] = [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ];

          const imageRefs: VisionImageRef[] = [];
          if (benchmark === 'matrix') {
            if (overlay?.kind === 'frame') imageRefs.push(overlay.image);
            else if (resolution) imageRefs.push(resolution);
            if (overlay?.kind === 'sidecar') imageRefs.push(overlay.image);
          } else {
            imageRefs.push((resolution ?? overlay?.image)!);
          }
          const imagens: string[] = [];
          try {
            for (const ref of imageRefs) imagens.push(await params.imageFor(scene, ref));
          } catch (err) {
            return celulaVazia(plano, modelId, 'error', prompt, `imagem do cenário indisponível: ${erroCurto(err)}`);
          }
          if (parado) return celulaVazia(plano, modelId, 'skipped', prompt, 'run parada (orçamento/cancelamento)');
          messages[1] = { role: 'user', content: prompt, images: imagens.map((url) => ({ url })) };

          if (benchmark === 'resolution' || plano.kind === 'map') {
            const chamada = await chamar(callCtx, modelId, messages);
            if (!chamada.ok) {
              if (chamada.kind === 'skipped') {
                parado = true;
                if (chamada.budget) budgetExhausted = true;
              }
              return celulaVazia(plano, modelId, chamada.kind, prompt, chamada.error);
            }
            const parse = parseMapOutput(chamada.result.text, { space: config.coordSpace, viewport: imageViewport });
            const rawPredictions = parse.value ?? [];
            const predictions = benchmark === 'resolution' ? escalaParaCanonica(rawPredictions, imageViewport) : rawPredictions;
            const provider = chamada.result.provider?.name;
            const cell: VisionMapCell = {
              kind: 'map',
              cellId: plano.cellId,
              sceneId: scene.id,
              family: scene.family,
              modelId,
              contestantId: modelId,
              prompt,
              status: 'ok',
              latencyMs: chamada.result.latencyMs,
              tokensIn: chamada.result.tokensIn,
              tokensOut: chamada.result.tokensOut,
              costUsd: measuredCallUsd(chamada.result.cost) ?? 0,
              ...(provider ? { provider } : {}),
              raw: parse.raw,
              parseOk: parse.ok,
              coordScale: parse.coordScale,
              predictions,
              score: scoreMapScene(scene, predictions),
              ...(plano.benchmark ? { benchmark: plano.benchmark } : {}),
              ...(plano.variant ? { variant: plano.variant } : {}),
              ...(benchmark === 'resolution' ? { imageViewport } : {}),
            };
            return cell;
          }

          const variantName = (variant ?? 'plain') as VisionGridVariant;
          const parse1 = (text: string) =>
            parseActionOutput(text, { space: config.coordSpace, viewport: imageViewport });
          const chamada1 = await chamar(callCtx, modelId, messages);
          if (!chamada1.ok) {
            if (chamada1.kind === 'skipped') {
              parado = true;
              if (chamada1.budget) budgetExhausted = true;
            }
            return celulaVazia(plano, modelId, chamada1.kind, prompt, chamada1.error);
          }
          const parsed1 = parse1(chamada1.result.text);
          const trace1 = traceOf(1, prompt, chamada1, parsed1, {
            ...(parsed1.value?.cell ? { cell: parsed1.value.cell } : {}),
            imageViewport,
          });

          if (benchmark === 'matrix') {
            const pred = parsed1.value
              ? pontoDaMatriz(parsed1.value, imageViewport, isMatrixFrame ? undefined : overlay?.margins)
              : null;
            return {
              kind: 'action',
              cellId: plano.cellId,
              taskId: plano.task!.id,
              sceneId: scene.id,
              family: scene.family,
              modelId,
              contestantId: modelId,
              instruction: plano.task!.instruction,
              prompt,
              status: 'ok',
              latencyMs: chamada1.result.latencyMs,
              tokensIn: chamada1.result.tokensIn,
              tokensOut: chamada1.result.tokensOut,
              costUsd: measuredCallUsd(chamada1.result.cost) ?? 0,
              ...(chamada1.result.provider?.name ? { provider: chamada1.result.provider.name } : {}),
              raw: parsed1.raw,
              parseOk: parsed1.ok,
              coordScale: parsed1.coordScale,
              prediction: pred,
              score: scoreActionTask(scene, plano.task!, pred),
              benchmark,
              variant,
              resolution: resolution?.id,
              grid: plano.matrixGrid,
              ...(overlay?.margins ? { margins: overlay.margins } : {}),
              imageViewport,
              rounds: 1,
              trace: [trace1],
            };
          }

          let finalPred = parsed1.value;
          let finalParse = parsed1;
          let rounds: 1 | 2 = 1;
          let totalLatency = chamada1.result.latencyMs;
          let totalIn = chamada1.result.tokensIn;
          let totalOut = chamada1.result.tokensOut;
          let totalCost = measuredCallUsd(chamada1.result.cost) ?? 0;
          let provider = chamada1.result.provider?.name;
          const trace: VisionRoundTrace[] = [trace1];

          if (variantName === 'mark-grid' && parsed1.value?.cell) {
            const targetCell = overlay?.cells?.find((c) => c.id === parsed1.value!.cell);
            if (targetCell) {
              const round2PromptOpts = {
                coordSpace: config.coordSpace,
                viewport: targetCell.viewport,
                variant: variantName,
                round: 2 as const,
                cell: targetCell.id,
                cropSource: targetCell.source,
              };
              const prompt2 = gridUserPrompt(plano.task!.instruction, round2PromptOpts);
              const system2 = gridSystemPrompt(round2PromptOpts);
              let image2: string;
              try {
                image2 = await params.imageFor(scene, targetCell.image);
              } catch (err) {
                trace.push({
                  round: 2,
                  prompt: prompt2,
                  status: 'error',
                  error: `recorte indisponível: ${erroCurto(err)}`,
                  latencyMs: 0,
                  tokensIn: 0,
                  tokensOut: 0,
                  costUsd: 0,
                  parseOk: false,
                  coordScale: 'unknown',
                  raw: '',
                  prediction: null,
                  cell: targetCell.id,
                  crop: targetCell.source,
                  imageViewport: targetCell.viewport,
                });
                image2 = '';
              }
              if (image2) {
                const chamada2 = await chamar(callCtx, modelId, [
                  { role: 'system', content: system2 },
                  { role: 'user', content: prompt2, images: [{ url: image2 }] },
                ]);
                if (!chamada2.ok) {
                  trace.push(traceOf(2, prompt2, chamada2, undefined, {
                    cell: targetCell.id,
                    crop: targetCell.source,
                    imageViewport: targetCell.viewport,
                  }));
                  if (chamada2.kind === 'skipped') {
                    parado = true;
                    if (chamada2.budget) budgetExhausted = true;
                  }
                } else {
                  const parsed2 = parse1(chamada2.result.text);
                  trace.push(
                    traceOf(2, prompt2, chamada2, parsed2, {
                      cell: targetCell.id,
                      crop: targetCell.source,
                      imageViewport: targetCell.viewport,
                    }),
                  );
                  totalLatency += chamada2.result.latencyMs;
                  totalIn += chamada2.result.tokensIn;
                  totalOut += chamada2.result.tokensOut;
                  totalCost += measuredCallUsd(chamada2.result.cost) ?? 0;
                  provider = chamada2.result.provider?.name ?? provider;
                  // A rodada 2 é um REFINO DE POSIÇÃO: ação/alvo/texto vêm da
                  // rodada 1 (foi ela que decidiu o que fazer). Sem isso, o
                  // crop mediria "o modelo reescreve a ação sob zoom?", não o
                  // ganho de localização que o Mark-Grid promete.
                  if (parsed2.value && parsed2.value.x != null && parsed2.value.y != null) {
                    const base = parsed1.value;
                    const acao = base && base.action !== 'unknown' ? base.action : parsed2.value.action;
                    const rawAction = base && base.action !== 'unknown' ? base.rawAction : parsed2.value.rawAction;
                    const refinado = pontoDoRecorte(parsed2.value, targetCell);
                    finalPred = {
                      action: acao,
                      rawAction,
                      target: base?.target ?? parsed2.value.target,
                      text: base?.text ?? parsed2.value.text,
                      cell: base?.cell ?? parsed1.value?.cell ?? null,
                      x: refinado.x,
                      y: refinado.y,
                    };
                    finalParse = { ...parsed2, ok: acao !== 'unknown', value: finalPred };
                    rounds = 2;
                  }
                }
              }
            }
          }

          const cell: VisionActionCell = {
            kind: 'action',
            cellId: plano.cellId,
            taskId: plano.task!.id,
            sceneId: scene.id,
            family: scene.family,
            modelId,
            contestantId: modelId,
            instruction: plano.task!.instruction,
            prompt,
            status: 'ok',
            latencyMs: totalLatency,
            tokensIn: totalIn,
            tokensOut: totalOut,
            costUsd: totalCost,
            ...(provider ? { provider } : {}),
            raw: finalParse.raw,
            parseOk: finalParse.ok,
            coordScale: finalParse.coordScale,
            prediction: finalPred,
            score: scoreActionTask(scene, plano.task!, finalPred),
            ...(plano.benchmark ? { benchmark: plano.benchmark } : {}),
            ...(plano.variant ? { variant: plano.variant } : {}),
            rounds,
            trace,
          };
          return cell;
        })().then((cell) => {
          params.onCell?.(cell);
          return cell;
        }),
      );
    }
  }
  const resolvidas = await Promise.all(promessas);
  cells.push(...resolvidas);

  const porModelo = new Map<string, VisionCell[]>();
  for (const cell of cells) {
    const lista = porModelo.get(cell.modelId) ?? [];
    lista.push(cell);
    porModelo.set(cell.modelId, lista);
  }
  const contestants: VisionContestant[] = config.models.map((modelId) =>
    aggregateContestant({
      contestantId: modelId,
      modelId,
      cells: porModelo.get(modelId) ?? [],
      scenes: scenesById,
      benchmark,
    }),
  );
  contestants.sort((a, b) => b.score - a.score || a.modelId.localeCompare(b.modelId));

  const erros = cells.filter((c) => c.status === 'error').length;
  const skips = cells.filter((c) => c.status === 'skipped').length;
  const finalizadas = cells.length - skips;
  const status = parado
    ? 'aborted'
    : finalizadas > 0 && erros === finalizadas
      ? 'error'
      : 'finished';
  const gasto = ledger.spentUsd;
  const somaCelulas = cells.reduce((a, c) => a + c.costUsd, 0);
  const warnings: string[] = [];
  if (gasto === 0 && somaCelulas > 0) {
    warnings.push(`ledger sem custo (${somaCelulas.toFixed(6)} USD medido nas células): total do record fica 0.`);
  }
  const semVisao = modelsWithoutImageInput(config.models, catalog);
  if (semVisao.length > 0) {
    warnings.push(`catálogo não declara entrada de imagem para: ${semVisao.join(', ')} — resultado provavelmente inválido.`);
  }
  if (semVisao.length > 0 && cells.every((c) => c.status !== 'ok')) {
    warnings.push('todas as células falharam: confira a modalidade de entrada dos modelos.');
  }
  if (benchmark !== 'grounding' && !config.provider) {
    warnings.push('sem provedor fixado (`--provider`): o roteamento do OpenRouter pode trocar de provedor entre células e confundir o efeito medido.');
  }
  if (benchmark === 'resolution' && selecao.scenes.some((s) => !s.probes?.resolutions?.length)) {
    warnings.push('algum cenário não tem resoluções pinadas; ele ficou fora do banco de resolução.');
  }
  if (benchmark === 'grid' && selecao.scenes.some((s) => !s.probes?.overlays?.length)) {
    warnings.push('algum cenário não tem overlays pinados; ele ficou fora do banco de grade.');
  }

  const promptVersion =
    benchmark === 'grid'
      ? VISION_GRID_PROMPT_VERSION
      : benchmark === 'matrix'
        ? VISION_MATRIX_PROMPT_VERSION
        : VISION_PROMPT_VERSION;
  const record: VisionRunRecord = {
    format: VISION_RUN_FORMAT,
    id: params.id,
    status: status as VisionRunRecord['status'],
    benchmark,
    dataset: {
      version: dataset.version,
      hash: datasetHash(dataset),
      scenes: selecao.scenes.map((s: VisionScene) => s.id),
      images: Object.fromEntries(selecao.scenes.map((s) => [s.id, s.image.sha256])),
    },
    promptVersion,
    config: { ...config, benchmark },
    contestants,
    cells,
    totals: {
      // Célula do mark-grid faz 2 chamadas HTTP; o custo/tokens já somam as
      // duas, então `calls` conta as duas e `cells` continua sendo o plano.
      cells: cells.length,
      calls: cells.reduce((a, c) => a + (c.kind === 'action' ? c.trace?.length ?? 1 : 1), 0),
      errors: erros,
      skipped: skips,
      costUsd: gasto,
      tokensIn: cells.reduce((a, c) => a + c.tokensIn, 0),
      tokensOut: cells.reduce((a, c) => a + c.tokensOut, 0),
    },
    budget: {
      spentUsd: gasto,
      ...(config.budgetUsd !== undefined ? { budgetUsd: config.budgetUsd } : {}),
      ...(budgetExhausted ? { exhausted: true } : {}),
    },
    startedAt: inicio.toISOString(),
    finishedAt: now().toISOString(),
    warnings,
  };
  return record;
}

/** Limite de células planejadas (prévia do `--dry-run`). */
export function planVisionRun(
  dataset: VisionDataset,
  config: VisionRunConfig,
): {
  cells: number;
  scenes: number;
  mapCells: number;
  actionCells: number;
  scenesIds: string[];
  benchmark: VisionBenchmark;
  variants: string[];
} {
  const benchmark = config.benchmark ?? 'grounding';
  const selecao = selectScenes(dataset, {
    families: config.families,
    scenes: config.scenes,
    limit: config.limit,
  });
  const planos = planCells(selecao.scenes, config.tasks, {
    benchmark,
    ...(config.resolutions ? { resolutions: config.resolutions } : {}),
    ...(config.gridVariants ? { gridVariants: config.gridVariants } : {}),
    ...(config.matrixGrids ? { matrixGrids: config.matrixGrids } : {}),
  });
  const mapCells = planos.filter((p) => p.kind === 'map').length;
  const actionCells = planos.filter((p) => p.kind === 'action').length;
  return {
    cells: planos.length * config.models.length,
    scenes: selecao.scenes.length,
    mapCells,
    actionCells,
    scenesIds: selecao.scenes.map((s) => s.id),
    benchmark,
    variants: [...new Set(planos.map((p) => p.variant).filter((v): v is string => Boolean(v)))],
  };
}
