// BENCHMARK DE VISÃO — runner CORE (puro; Node e navegador).
//
// Uma célula = uma CHAMADA: (modelo × cenário) no modo mapa e
// (modelo × tarefa) no modo ação. Todas as células nascem de uma vez em
// `Promise.all` — o limitador AIMD do gateway manda na concorrência (não há
// cap local, regra do projeto) — e a reserva do ledger é tomada no nascimento
// da chamada, então um teto apertado corta as ÚLTIMAS e a run fica `aborted`
// com o parcial medido.
//
// Dinheiro: TODA chamada passa por `chatCompletion` com role `competitor` +
// sink = ledger da run (o ledger é INJETADO — no Node vem dos guards, na aba é
// um BudgetLedger local). O custo do record é o do LEDGER (medido), não a soma
// dos retornos — chamada que falhou depois de despachada também custou.
//
// Sem `node:*`: a imagem do cenário chega por `imageFor` (fs no Node, fetch no
// navegador) e o id do record é gerado pelo chamador.
//
// A célula que estoura orçamento/cancelamento NUNCA vira nota: sai `skipped`
// (fora das métricas, e o record diz quantas). Erro de chamada sai `error` e
// CONTA contra o modelo (resposta errada não é amostra excluída).

import { isBudgetSignal, isControlSignal, type BudgetLedger } from '../../budget.js';
import {
  isCallerRetryable,
  measuredCallUsd,
  type ChatCompletionResult,
  type ChatMessage,
  type OpenRouterGateway,
} from '../../openrouter.js';
import type { OpenRouterModel, ReasoningLevel } from '../../types.js';
import { VISION_PROMPT_VERSION, actionSystemPrompt, actionUserPrompt, mapSystemPrompt, mapUserPrompt } from './prompt.js';
import { parseActionOutput, parseMapOutput } from './parse.js';
import { aggregateContestant, scoreActionTask, scoreMapScene } from './score.js';
import { datasetHash, planCells, selectScenes } from './dataset.js';
import { modelsWithoutImageInput } from './models.js';
import {
  VISION_RUN_FORMAT,
  type VisionActionCell,
  type VisionCell,
  type VisionContestant,
  type VisionDataset,
  type VisionMapCell,
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
   * Imagem do cenário como data URL (ou https). O seam é INJETADO: no Node é
   * o fs do dataset; no navegador é `fetch` do asset estático.
   */
  imageFor: (scene: VisionScene) => Promise<string>;
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

/** Célula vazia (skipped/erro de chamada) com o shape completo. */
function celulaVazia(
  plano: ReturnType<typeof planCells>[number],
  modelId: string,
  status: 'error' | 'skipped',
  prompt: string,
  error: string | undefined,
): VisionCell {
  const base = {
    // Mesmo id que a célula "ok" usa (task ids são únicos no dataset).
    cellId: plano.kind === 'map' ? `map:${plano.scene.id}` : `action:${plano.task!.id}`,
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

/**
 * Executa um benchmark de visão e devolve o record (o chamador persiste).
 * Fonte ÚNICA do laço de células: Node (CLI) e navegador (SPA) injetam o seam
 * da imagem e o ledger — nenhuma cópia da lógica de run/placar.
 */
export async function runVisionCore(params: RunVisionCoreParams): Promise<VisionRunRecord> {
  const { dataset, config, apiKey, gateway, ledger } = params;
  const now = params.now ?? (() => new Date());
  if (config.models.length === 0) throw new VisionRunError('nenhum modelo selecionado.');
  const inicio = now();

  const selecao = selectScenes(dataset, {
    families: config.families,
    scenes: config.scenes,
    limit: config.limit,
  });
  if (selecao.scenes.length === 0) {
    throw new VisionRunError('a seleção não casou com nenhum cenário do dataset.');
  }
  const planos = planCells(selecao.scenes, config.tasks);
  if (planos.length === 0) {
    throw new VisionRunError('o plano ficou vazio (modo sem cenas ou sem tarefas de ação).');
  }

  const catalog = params.catalog ?? gateway.peekModelsCache(apiKey)?.data ?? [];

  const scenesById = new Map(selecao.scenes.map((s) => [s.id, s]));
  const cells: VisionCell[] = [];
  let parado = false;
  let budgetExhausted = false;

  const promessas: Array<Promise<VisionCell>> = [];
  for (const modelId of config.models) {
    for (const plano of planos) {
      promessas.push(
        (async (): Promise<VisionCell> => {
          const scene = plano.scene;
          const prompt =
            plano.kind === 'map'
              ? mapUserPrompt({ coordSpace: config.coordSpace, viewport: scene.viewport })
              : actionUserPrompt(plano.task!.instruction, {
                  coordSpace: config.coordSpace,
                  viewport: scene.viewport,
                });
          if (parado) {
            return celulaVazia(plano, modelId, 'skipped', prompt, 'run parada (orçamento/cancelamento)');
          }
          let imagem: string;
          try {
            imagem = await params.imageFor(scene);
          } catch (err) {
            return celulaVazia(plano, modelId, 'error', prompt, `imagem do cenário indisponível: ${erroCurto(err)}`);
          }
          if (parado) {
            return celulaVazia(plano, modelId, 'skipped', prompt, 'run parada (orçamento/cancelamento)');
          }
          const opts = { coordSpace: config.coordSpace, viewport: scene.viewport };
          // TEXTO ANTES DA IMAGEM: a instrução é a parte de texto da mensagem e
          // o screenshot vem depois, como parte `image_url`.
          const messages: ChatMessage[] = [
            { role: 'system', content: plano.kind === 'map' ? mapSystemPrompt(opts) : actionSystemPrompt(opts) },
            { role: 'user', content: prompt, images: [{ url: imagem }] },
          ];
          let resultado: ChatCompletionResult;
          try {
            resultado = await comRetries(config.retries, () =>
              gateway.chatCompletion({
                apiKey,
                modelId,
                messages,
                temperature: config.temperature,
                maxTokens: config.maxTokens,
                ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
                ...(config.reasoning ? { reasoningLevel: config.reasoning as ReasoningLevel } : {}),
                responseFormatJson: true,
                role: 'competitor',
                sink: ledger,
                ...(params.signal ? { signal: params.signal } : {}),
              }),
            );
          } catch (err) {
            if (isControlSignal(err)) {
              parado = true;
              if (isBudgetSignal(err)) budgetExhausted = true;
              return celulaVazia(plano, modelId, 'skipped', prompt, 'run parada (orçamento/cancelamento)');
            }
            return celulaVazia(plano, modelId, 'error', prompt, erroCurto(err));
          }
          const custo = measuredCallUsd(resultado.cost) ?? 0;
          const provider = resultado.provider?.name;
          if (plano.kind === 'map') {
            const parse = parseMapOutput(resultado.text, { space: config.coordSpace, viewport: scene.viewport });
            const predictions = parse.value ?? [];
            const cell: VisionMapCell = {
              kind: 'map',
              cellId: `map:${scene.id}`,
              sceneId: scene.id,
              family: scene.family,
              modelId,
              contestantId: modelId,
              prompt,
              status: 'ok',
              latencyMs: resultado.latencyMs,
              tokensIn: resultado.tokensIn,
              tokensOut: resultado.tokensOut,
              costUsd: custo,
              ...(provider ? { provider } : {}),
              raw: parse.raw,
              parseOk: parse.ok,
              coordScale: parse.coordScale,
              predictions,
              score: scoreMapScene(scene, predictions),
            };
            return cell;
          }
          const parse = parseActionOutput(resultado.text, { space: config.coordSpace, viewport: scene.viewport });
          const pred = parse.value;
          const scoreAction = plano.task ? scoreActionTask(scene, plano.task, pred) : undefined;
          const cell: VisionActionCell = {
            kind: 'action',
            cellId: `action:${plano.task!.id}`,
            taskId: plano.task!.id,
            sceneId: scene.id,
            family: scene.family,
            modelId,
            contestantId: modelId,
            instruction: plano.task!.instruction,
            prompt,
            status: 'ok',
            latencyMs: resultado.latencyMs,
            tokensIn: resultado.tokensIn,
            tokensOut: resultado.tokensOut,
            costUsd: custo,
            ...(provider ? { provider } : {}),
            raw: parse.raw,
            parseOk: parse.ok,
            coordScale: parse.coordScale,
            prediction: pred,
            ...(scoreAction ? { score: scoreAction } : {}),
          };
          return cell;
        })().then((cell) => {
          // Progresso AO VIVO: o CLI emite NDJSON e a SPA pinta o cenário assim
          // que a célula termina (antes era só no fim de todas).
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
    }),
  );
  contestants.sort((a, b) => b.score - a.score);

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
  // O ledger é a verdade do dinheiro. Se ele ficou em 0 e as células mediram
  // custo, há um buraco de contabilidade — avisa em vez de "corrigir" o total
  // somando células (isso mascararia exatamente o que a regra protege).
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

  const record: VisionRunRecord = {
    format: VISION_RUN_FORMAT,
    id: params.id,
    status: status as VisionRunRecord['status'],
    dataset: {
      version: dataset.version,
      hash: datasetHash(dataset),
      scenes: selecao.scenes.map((s: VisionScene) => s.id),
      images: Object.fromEntries(selecao.scenes.map((s) => [s.id, s.image.sha256])),
    },
    promptVersion: VISION_PROMPT_VERSION,
    config,
    contestants,
    cells,
    totals: {
      calls: cells.length,
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
): { cells: number; scenes: number; mapCells: number; actionCells: number; scenesIds: string[] } {
  const selecao = selectScenes(dataset, {
    families: config.families,
    scenes: config.scenes,
    limit: config.limit,
  });
  const planos = planCells(selecao.scenes, config.tasks);
  const mapCells = planos.filter((p) => p.kind === 'map').length;
  const actionCells = planos.filter((p) => p.kind === 'action').length;
  return {
    cells: planos.length * config.models.length,
    scenes: selecao.scenes.length,
    mapCells,
    actionCells,
    scenesIds: selecao.scenes.map((s) => s.id),
  };
}
