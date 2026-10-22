// `prompt-builder vision …` — o BENCHMARK DE VISÃO no terminal.
//
// Mede duas habilidades numa imagem 1080p de UI real (renderizada por nós):
//   • `map`    — listar TODOS os elementos clicáveis com posição;
//   • `action` — dado um pedido, devolver a ação e onde clicar.
//
// A verdade é o DOM do cenário (caixa + rótulo), não um juiz LLM: o placar é
// determinístico e o dataset é versionado/pinado por hash. Este arquivo só tem
// o que é de terminal — flags, orçamento, guardas de gasto, SIGINT e contrato
// de saída (stdout = payload, stderr = narração).

import { promises as fs } from 'node:fs';
import { getGateway, APPROX_IMAGE_TOKENS } from '../../openrouter.js';
import { makeCallEstimator } from '../../estimate.js';
import { REASONING_LEVELS } from '../../reasoning.js';
import { isBudgetSignal } from '../../budget.js';
import {
  VISION_COORD_SPACES,
  VISION_FAMILIES,
  VISION_TASKS,
  type VisionCoordSpace,
  type VisionDataset,
  type VisionFamily,
  type VisionRunConfig,
  type VisionRunRecord,
  type VisionTaskKind,
} from '../../engine/vision/index.js';
import { datasetHash, VisionDatasetError } from '../../engine/vision/dataset.js';
import {
  loadVisionDataset,
  selectVisionScenes,
  sceneSource,
  verifyVisionDataset,
  visionDataDir,
  type LoadedVisionDataset,
} from '../../vision/dataset.js';
import { listVisionRuns, loadVisionRun, saveVisionRun, summarizeVisionRun } from '../../vision/store.js';
import { modelsWithoutImageInput } from '../../engine/vision/models.js';
import { planVisionRun, runVision } from '../../vision/runner.js';
import { renderVisionReportHtml, renderVisionReportMarkdown, renderVisionSummary } from '../../vision/report.js';
import type { OpenRouterModel, ReasoningLevel } from '../../types.js';
import {
  assertKnownSubcommand,
  buildContext,
  isAgentContext,
  limitList,
  loadCatalog,
  parse,
  parseListLimit,
  resolveKey,
  tryResolveKey,
  type CliContext,
} from '../context.js';
import { CliError, EXIT, failAndExit, isCliError, type Output } from '../output.js';
import { budgetRequiredError, budgetUsdOf, toRefusal, type BudgetChoice } from '../preflight.js';
import { openSpendGuards, spendGuardRefusals, type SpendGuards } from '../spendGuards.js';
import { forceExitNow, installGracefulStop } from '../runControl.js';

export const VISION_SUBCOMMANDS = ['run', 'list', 'show', 'report', 'dataset'] as const;

const RUN_OPTIONS = {
  models: { type: 'string', short: 'm' },
  tasks: { type: 'string' },
  families: { type: 'string' },
  scenes: { type: 'string' },
  limit: { type: 'string' },
  'coord-space': { type: 'string' },
  temperature: { type: 'string' },
  'max-tokens': { type: 'string' },
  reasoning: { type: 'string' },
  timeout: { type: 'string' },
  retries: { type: 'string' },
  'dataset-dir': { type: 'string' },
  budget: { type: 'string' },
  'dry-run': { type: 'boolean' },
  'allow-concurrent': { type: 'boolean' },
} as const;

const LIST_OPTIONS = { limit: { type: 'string' }, all: { type: 'boolean' } } as const;

const DATASET_OPTIONS = { 'dataset-dir': { type: 'string' } } as const;

const REPORT_OPTIONS = {
  'dataset-dir': { type: 'string' },
  out: { type: 'string', short: 'o' },
  html: { type: 'string' },
} as const;

// ---------------------------------------------------------------------------
// Helpers de flag
// ---------------------------------------------------------------------------

function listaDe(valor: unknown, flag: string): string[] {
  if (typeof valor !== 'string' || !valor.trim()) return [];
  const itens = valor
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (itens.length === 0) throw new CliError(`${flag} veio vazio.`, EXIT.USAGE, { flag });
  return [...new Set(itens)];
}

function modelosDe(valor: unknown): string[] {
  const modelos = listaDe(valor, '--models');
  if (modelos.length === 0) {
    throw new CliError('Falta --models (um ou mais ids do OpenRouter, separados por vírgula).', EXIT.USAGE, undefined, {
      code: 'usage.missing_models',
      hint: 'Ex.: `prompt-builder vision run --models anthropic/claude-opus-5.5,google/gemini-3-pro --budget 1`.',
    });
  }
  return modelos;
}

function tarefasDe(valor: unknown): VisionTaskKind[] {
  const bruto = listaDe(valor, '--tasks');
  if (bruto.length === 0) return [...VISION_TASKS];
  const invalidas = bruto.filter((t) => !(VISION_TASKS as readonly string[]).includes(t));
  if (invalidas.length > 0) {
    throw new CliError(`--tasks inválido: ${invalidas.join(', ')}.`, EXIT.USAGE, { accepted: VISION_TASKS }, {
      code: 'usage.invalid_flag_value',
      hint: `Use --tasks ${VISION_TASKS.join(',')} (padrão: todos).`,
    });
  }
  return bruto as VisionTaskKind[];
}

function familiasDe(valor: unknown): VisionFamily[] | null {
  const bruto = listaDe(valor, '--families');
  if (bruto.length === 0) return null;
  const invalidas = bruto.filter((f) => !(VISION_FAMILIES as readonly string[]).includes(f));
  if (invalidas.length > 0) {
    throw new CliError(`--families inválido: ${invalidas.join(', ')}.`, EXIT.USAGE, { accepted: VISION_FAMILIES }, {
      code: 'usage.invalid_flag_value',
      hint: `Famílias: ${VISION_FAMILIES.join(', ')}.`,
    });
  }
  return bruto as VisionFamily[];
}

function coordSpaceDe(valor: unknown): VisionCoordSpace {
  if (valor === undefined || valor === '') return 'pixels';
  if (typeof valor === 'string' && (VISION_COORD_SPACES as readonly string[]).includes(valor)) {
    return valor as VisionCoordSpace;
  }
  throw new CliError(`--coord-space inválido: ${String(valor)}.`, EXIT.USAGE, { accepted: VISION_COORD_SPACES }, {
    code: 'usage.invalid_flag_value',
    hint: 'Use `--coord-space pixels` (padrão) ou `normalized` (0–1000, melhor para modelos com grounding nativo).',
  });
}

function inteiroDe(valor: unknown, flag: string, min: number, max: number, padrao: number): number {
  if (valor === undefined || valor === '') return padrao;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new CliError(`${flag} deve ser um inteiro entre ${min} e ${max} (recebi "${String(valor)}").`, EXIT.USAGE, {
      flag,
      value: valor,
    });
  }
  return n;
}

function numeroDe(valor: unknown, flag: string, min: number, max: number, padrao: number): number {
  if (valor === undefined || valor === '') return padrao;
  const n = Number(valor);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new CliError(`${flag} deve ser um número entre ${min} e ${max} (recebi "${String(valor)}").`, EXIT.USAGE, {
      flag,
      value: valor,
    });
  }
  return n;
}

function reasoningDe(valor: unknown): ReasoningLevel | undefined {
  if (valor === undefined || valor === '') return undefined;
  if (typeof valor === 'string' && (REASONING_LEVELS as readonly string[]).includes(valor)) {
    return valor as ReasoningLevel;
  }
  throw new CliError(`--reasoning inválido: ${String(valor)}.`, EXIT.USAGE, { accepted: REASONING_LEVELS }, {
    code: 'usage.invalid_flag_value',
    hint: `Níveis: ${REASONING_LEVELS.join(', ')}.`,
  });
}

function resolveBudget(valor: unknown, warn: (m: string) => void): BudgetChoice {
  if (typeof valor === 'string' && valor.trim()) {
    if (valor.trim().toLowerCase() === 'none') return { kind: 'none' };
    const v = Number(valor);
    if (!Number.isFinite(v) || v <= 0) {
      throw new CliError('--budget deve ser um valor em USD maior que zero, ou "none".', EXIT.USAGE, { value: valor }, {
        code: 'usage.invalid_budget',
        hint: 'Use `--budget 1` (teto de US$ 1) ou `--budget none` (sem teto, assumindo o custo).',
      });
    }
    return { kind: 'usd', usd: v };
  }
  if (isAgentContext()) return { kind: 'missing' };
  warn('Sem --budget: rodando SEM teto de gasto.');
  return { kind: 'unset' };
}

function datasetRaiz(values: Record<string, unknown>): string {
  const dir = values['dataset-dir'];
  return typeof dir === 'string' && dir.trim() ? dir : visionDataDir();
}

function datasetCliError(err: unknown): CliError {
  if (err instanceof VisionDatasetError) {
    return new CliError(err.message, EXIT.CONFIG, { issues: err.issues }, {
      code: 'vision.dataset_invalid',
      hint: 'Rode `prompt-builder vision dataset verify` para a lista completa; o dataset viaja no pacote (`src/data/vision`).',
    });
  }
  return err as CliError;
}

function configDe(values: Record<string, unknown>, budget: BudgetChoice): VisionRunConfig {
  const models = modelosDe(values.models);
  const scenes = listaDe(values.scenes, '--scenes');
  return {
    models,
    tasks: tarefasDe(values.tasks),
    families: familiasDe(values.families),
    scenes: scenes.length > 0 ? scenes : null,
    limit: values.limit === undefined || values.limit === '' ? null : inteiroDe(values.limit, '--limit', 1, 10_000, 0),
    coordSpace: coordSpaceDe(values['coord-space']),
    temperature: numeroDe(values.temperature, '--temperature', 0, 2, 0),
    maxTokens: inteiroDe(values['max-tokens'], '--max-tokens', 256, 65_536, 4096),
    ...(reasoningDe(values.reasoning) ? { reasoning: reasoningDe(values.reasoning)! } : {}),
    timeoutMs: inteiroDe(values.timeout, '--timeout', 1_000, 3_600_000, 180_000),
    retries: inteiroDe(values.retries, '--retries', 0, 3, 0),
    ...(budgetUsdOf(budget) !== undefined ? { budgetUsd: budgetUsdOf(budget)! } : {}),
  };
}

function exitFor(record: VisionRunRecord, cancelado: boolean): number {
  if (cancelado) return EXIT.SIGINT;
  if (record.budget?.exhausted) return EXIT.BUDGET;
  return EXIT.OK;
}

/** Resumo curto e serializável (o payload das superfícies). */
function resumoRun(record: VisionRunRecord): Record<string, unknown> {
  return {
    ...summarizeVisionRun(record),
    statusDetail: record.status,
    datasetHash: record.dataset.hash,
    promptVersion: record.promptVersion,
    skipped: record.totals.skipped,
    errors: record.totals.errors,
    tokensIn: record.totals.tokensIn,
    tokensOut: record.totals.tokensOut,
    contestants: record.contestants,
    warnings: record.warnings,
    next: `prompt-builder vision report ${record.id}`,
  };
}

async function carregarDataset(root: string): Promise<LoadedVisionDataset> {
  try {
    return await loadVisionDataset(root);
  } catch (err) {
    throw datasetCliError(err);
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function cmdRun(argv: string[]): Promise<number> {
  const parsed = parse(argv, RUN_OPTIONS);
  const ctx = buildContext(parsed);
  const { out, values } = ctx;
  const budget = resolveBudget(values.budget, (m) => out.warn(m));
  const config = configDe(values, budget);
  const root = datasetRaiz(values);
  const carregado = await carregarDataset(root);
  const dataset = carregado.dataset;
  const selecao = selectVisionScenes(dataset, {
    families: config.families,
    scenes: config.scenes,
    limit: config.limit,
  });
  if (selecao.unknownSceneIds.length > 0) {
    throw new CliError(
      `--scenes inclui cenário(s) que não existem: ${selecao.unknownSceneIds.join(', ')}.`,
      EXIT.CONFIG,
      { unknown: selecao.unknownSceneIds, available: dataset.scenes.map((s) => s.id) },
      {
        code: 'vision.dataset_scope',
        hint: '`prompt-builder vision dataset list` mostra os ids disponíveis.',
      },
    );
  }
  if (selecao.scenes.length === 0) {
    throw new CliError('a seleção não casou com nenhum cenário do dataset.', EXIT.CONFIG, {
      filters: { families: config.families, scenes: config.scenes, limit: config.limit },
    }, { code: 'vision.dataset_scope', hint: '`vision dataset list` mostra famílias e ids disponíveis.' });
  }
  const plano = planVisionRun(dataset, config);
  if (plano.cells === 0) {
    throw new CliError('o plano ficou vazio (nenhuma célula para rodar).', EXIT.CONFIG, {
      tasks: config.tasks,
      scenes: selecao.scenes.map((s) => s.id),
    }, {
      code: 'vision.empty_plan',
      hint: 'Cenários sem tarefas de ação + `--tasks action` não geram células; use `--tasks map` ou outro recorte.',
    });
  }
  // Identidade do experimento (hash do lock) + o TETO. O orçamento tem de
  // estar aqui: `openSpendGuards` abre a raiz da máquina com o teto da run, e
  // é dela que o ledger da visão faz `fork()`.
  const guardConfig = {
    dataset: datasetHash(dataset),
    scenes: selecao.scenes.map((s) => s.id),
    models: config.models,
    tasks: config.tasks,
    coordSpace: config.coordSpace,
    promptVersion: 'vision-prompt@1',
    ...(config.budgetUsd !== undefined ? { budgetUsd: config.budgetUsd } : {}),
  };

  if (values['dry-run'] === true) {
    const apiKey = await tryResolveKey(values);
    let catalog: OpenRouterModel[] = [];
    try {
      catalog = (await loadCatalog(ctx, apiKey)).models;
    } catch (err) {
      out.warn(`catálogo indisponível no dry-run (${isCliError(err) ? err.message : String(err)}); estimativa fica ausente.`);
    }
    const semVisao = modelsWithoutImageInput(config.models, catalog);
    const recusas = [];
    if (budget.kind === 'missing') recusas.push(toRefusal(budgetRequiredError()));
    if (semVisao.length > 0) {
      recusas.push(
        toRefusal(
          new CliError(`modelo(s) sem entrada de imagem no catálogo: ${semVisao.join(', ')}.`, EXIT.CONFIG, { models: semVisao }, {
            code: 'vision.model_without_image',
            hint: 'Escolha um VLM (o catálogo expõe `architecture.input_modalities`); nada foi gasto.',
          }),
        ),
      );
    }
    recusas.push(
      ...spendGuardRefusals({
        dataDir: ctx.dataDir,
        config: guardConfig,
        lock: values['allow-concurrent'] !== true,
      }).map(toRefusal),
    );
    let estimativaUsd: number | null = null;
    if (catalog.length > 0) {
      const estimador = makeCallEstimator(catalog);
      const promptTokens = 900 + APPROX_IMAGE_TOKENS;
      estimativaUsd = 0;
      for (const modelId of config.models) {
        estimativaUsd += estimador(modelId, promptTokens, config.maxTokens) * plano.cells / config.models.length;
      }
    }
    const resumo = {
      dryRun: true,
      dataset: { version: dataset.version, hash: crop(datasetHash(dataset)), scenes: selecao.scenes.map((s) => s.id) },
      tasks: config.tasks,
      models: config.models,
      cells: plano.cells,
      mapCells: plano.mapCells * config.models.length,
      actionCells: plano.actionCells * config.models.length,
      coordSpace: config.coordSpace,
      families: selecao.scenes.reduce<Record<string, number>>((acc, s) => {
        acc[s.family] = (acc[s.family] ?? 0) + 1;
        return acc;
      }, {}),
      estimateUsd: estimativaUsd,
      wouldRefuse: recusas,
      requires: apiKey ? [] : [{ code: 'auth.key_missing', what: 'key' }],
    };
    if (out.isText) {
      out.line(`visão · dataset ${dataset.version} · ${selecao.scenes.length} cenário(s) · ${plano.cells} célula(s) · ${config.models.length} modelo(s)`);
      out.line(`tarefas: ${config.tasks.join('+')} · coordenadas: ${config.coordSpace}`);
      out.line(`estimativa pelo teto: ${estimativaUsd === null ? 'indisponível (sem catálogo)' : usd(estimativaUsd)}`);
      for (const r of recusas) out.line(`  RECUSARIA  ${r.code} — ${r.message.split('\n')[0]}`);
      for (const r of resumo.requires) out.line(`  REQUER     ${r.code}`);
    }
    const primeira = recusas[0];
    if (primeira) throw new CliError(primeira.message, primeira.exit, resumo, { code: primeira.code, hint: primeira.hint ?? undefined });
    out.result(true, 'vision.run.dry-run', resumo);
    return EXIT.OK;
  }

  if (budget.kind === 'missing') throw budgetRequiredError();
  const apiKey = await resolveKey(values);
  const catalogo = await loadCatalog(ctx, apiKey);
  const semVisao = modelsWithoutImageInput(config.models, catalogo.models);
  if (semVisao.length > 0) {
    throw new CliError(`modelo(s) sem entrada de imagem no catálogo: ${semVisao.join(', ')}.`, EXIT.CONFIG, {
      models: semVisao,
    }, {
      code: 'vision.model_without_image',
      hint: 'Escolha um VLM (o catálogo expõe `architecture.input_modalities`); nada foi gasto.',
    });
  }

  const ac = new AbortController();
  const guards: SpendGuards = openSpendGuards({
    dataDir: ctx.dataDir,
    config: guardConfig,
    command: 'vision run',
    models: catalogo.models,
    signal: ac.signal,
    lock: values['allow-concurrent'] !== true,
    warn: (m) => out.warn(m),
  });
  const sairInterrompido = (code: number): void =>
    failAndExit(out, 'vision.run', new CliError('Interrompido: saída imediata, sem esperar a run fechar.', code, undefined, {
      code: 'control.interrupted',
    }));
  let interrupts = 0;
  const onSigint = (): void => {
    interrupts += 1;
    if (interrupts === 1) {
      out.warn('interrompendo… (Ctrl-C de novo para sair na hora)');
      ac.abort('SIGINT');
      return;
    }
    void forceExitNow(EXIT.SIGINT, sairInterrompido);
  };
  process.on('SIGINT', onSigint);
  const stopGraceful = installGracefulStop(ac, { warn: (m) => out.warn(m), exit: sairInterrompido });
  const total = plano.cells;
  let feitas = 0;
  let record: VisionRunRecord;
  try {
    record = await runVision({
      dataset,
      datasetRoot: root,
      config,
      apiKey,
      signal: ac.signal,
      gateway: getGateway(),
      parentLedger: guards.parentLedger,
      catalog: catalogo.models,
      now: () => new Date(),
      onCell: (cell) => {
        feitas += 1;
        out.event('vision.cell', {
          done: feitas,
          total,
          cell: cell.cellId,
          model: cell.modelId,
          status: cell.status,
          score: cell.kind === 'map' ? cell.score?.f1 : cell.score ? (cell.score.pass ? 1 : 0) : undefined,
        });
      },
    });
    await saveVisionRun(record);
  } finally {
    process.off('SIGINT', onSigint);
    stopGraceful();
    guards.close();
  }
  const payload = resumoRun(record);
  if (out.isText) {
    out.line(renderVisionSummary(record));
    out.line('');
    out.line(`relatório: prompt-builder vision report ${record.id} --html vision-${record.id}.html`);
  }
  const code = exitFor(record, ac.signal.aborted);
  if (record.status === 'error') {
    throw new CliError(record.error ?? 'todas as células falharam', EXIT.ERROR, payload, {
      code: 'vision.run_failed',
      hint: 'Confira a modalidade de entrada dos modelos e a key; `vision show <id>` traz as células.',
    });
  }
  out.result(true, 'vision.run', payload);
  return code;
}

function crop(hash: string): string {
  return `${hash.slice(0, 16)}…`;
}

function usd(v: number): string {
  return v === 0 ? '$0' : `$${v.toFixed(v < 0.01 ? 5 : 4)}`;
}

// ---------------------------------------------------------------------------
// list / show / report
// ---------------------------------------------------------------------------

async function cmdList(argv: string[]): Promise<number> {
  const parsed = parse(argv, LIST_OPTIONS);
  const ctx = buildContext(parsed);
  const cap = parseListLimit(ctx.values);
  const runs = limitList(await listVisionRuns(), cap, ctx.out, 'runs de visão');
  if (ctx.out.isText) {
    if (runs.length === 0) ctx.out.line('nenhuma run de visão ainda — comece com `vision run`.');
    for (const r of runs) {
      ctx.out.line(`${r.id}  ${r.status}  ${r.datasetVersion}  ${r.scenes} cenário(s)  ${r.calls} chamada(s)  ${usd(r.costUsd)}`);
      ctx.out.line(`  melhor: ${r.bestModel ?? '—'} (${(r.bestScore * 100).toFixed(1)}%)`);
    }
  }
  ctx.out.result(true, 'vision.list', { runs });
  return EXIT.OK;
}

async function cmdShow(argv: string[]): Promise<number> {
  const parsed = parse(argv, LIST_OPTIONS);
  const ctx = buildContext(parsed);
  const id = parsed.positionals[0];
  if (!id) {
    throw new CliError('Uso: prompt-builder vision show <id>', EXIT.USAGE, undefined, {
      code: 'usage.missing_id',
      hint: '`prompt-builder vision list` mostra os ids.',
    });
  }
  const record = await loadVisionRun(id);
  if (!record) {
    throw new CliError(`run de visão não encontrada: ${id}`, EXIT.CONFIG, { id }, {
      code: 'vision.run_not_found',
      hint: '`prompt-builder vision list` mostra os ids existentes.',
    });
  }
  if (ctx.out.isText) {
    ctx.out.line(renderVisionSummary(record));
    ctx.out.line('');
    const problemas = record.cells.filter((c) => c.status !== 'ok');
    if (problemas.length > 0) {
      for (const c of problemas.slice(0, 20)) {
        ctx.out.line(`  ${c.status} ${c.cellId} (${c.modelId})${c.error ? ` — ${c.error}` : ''}`);
      }
    }
  }
  ctx.out.result(true, 'vision.show', { record });
  return EXIT.OK;
}

async function cmdReport(argv: string[]): Promise<number> {
  const parsed = parse(argv, REPORT_OPTIONS);
  const ctx = buildContext(parsed);
  const id = parsed.positionals[0];
  if (!id) {
    throw new CliError('Uso: prompt-builder vision report <id> [--html <arquivo>] [--out <arquivo.md>]', EXIT.USAGE, undefined, {
      code: 'usage.missing_id',
      hint: '`prompt-builder vision list` mostra os ids.',
    });
  }
  const record = await loadVisionRun(id);
  if (!record) {
    throw new CliError(`run de visão não encontrada: ${id}`, EXIT.CONFIG, { id }, {
      code: 'vision.run_not_found',
      hint: '`prompt-builder vision list` mostra os ids existentes.',
    });
  }
  const markdown = renderVisionReportMarkdown(record);
  const html = renderVisionReportHtml(record);
  const outPath = typeof ctx.values.out === 'string' ? ctx.values.out : undefined;
  const htmlPath = typeof ctx.values.html === 'string' ? ctx.values.html : undefined;
  if (outPath) await fs.writeFile(outPath, markdown, 'utf8');
  if (htmlPath) await fs.writeFile(htmlPath, html, 'utf8');
  if (ctx.out.isText) {
    if (!outPath) ctx.out.raw(`${markdown}\n`);
    return EXIT.OK;
  }
  ctx.out.result(true, 'vision.report', {
    ...(outPath ? { outPath } : {}),
    ...(htmlPath ? { htmlPath } : {}),
    ...(outPath ? {} : { markdown }),
  });
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// dataset
// ---------------------------------------------------------------------------

async function cmdDataset(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub && !sub.startsWith('-')) {
    assertKnownSubcommand('vision dataset', sub, ['list', 'show', 'verify'], {
      usage: 'vision dataset list|show <cena>|verify',
    });
  }
  const parsed = parse(rest, { ...DATASET_OPTIONS, ...LIST_OPTIONS, code: { type: 'boolean' } });
  const ctx = buildContext(parsed);
  const root = datasetRaiz(ctx.values);
  if (sub === 'verify') {
    const v = await verifyVisionDataset(root);
    if (ctx.out.isText) {
      if (v.ok) ctx.out.line(`dataset íntegro — ${v.checked} arquivo(s) conferido(s) · hash ${v.hash ? crop(v.hash) : '—'}`);
      else for (const i of v.issues) ctx.out.line(`  ${i}`);
    }
    if (!v.ok) {
      throw new CliError(`dataset de visão inválido: ${v.issues[0] ?? 'ver issues'}`, EXIT.CONFIG, v, {
        code: 'vision.dataset_invalid',
        hint: 'Rode `npm run vision:build` no repositório para regenerar as imagens e o manifesto.',
      });
    }
    ctx.out.result(true, 'vision.dataset.verify', v as unknown as Record<string, unknown>);
    return EXIT.OK;
  }
  const carregado = await carregarDataset(root);
  if (sub === 'show') {
    const id = parsed.positionals[0];
    if (!id) {
      throw new CliError('Uso: prompt-builder vision dataset show <cena>', EXIT.USAGE, undefined, {
        code: 'usage.missing_id',
        hint: '`vision dataset list` mostra os ids.',
      });
    }
    const scene = carregado.dataset.scenes.find((s) => s.id === id);
    if (!scene) {
      throw new CliError(`cenário não encontrado: ${id}`, EXIT.CONFIG, { id }, {
        code: 'vision.scene_not_found',
        hint: '`vision dataset list` mostra os ids.',
      });
    }
    const code = ctx.values.code === true ? await sceneSource(root, scene) : undefined;
    if (ctx.out.isText) {
      ctx.out.line(`${scene.id} — ${scene.title} (${scene.family}, ${scene.theme})`);
      ctx.out.line(`${scene.elements.length} elemento(s) · ${scene.tasks.length} tarefa(s) de ação · imagem ${scene.image.file}`);
      for (const el of scene.elements) {
        ctx.out.line(
          `  ${el.id} ${el.type} · ${el.label ?? `icon:${el.iconDescription ?? '?'}`} @ (${el.bbox.x},${el.bbox.y} ${el.bbox.w}×${el.bbox.h})`,
        );
      }
      for (const t of scene.tasks) {
        ctx.out.line(`  [ação] ${t.id}: "${t.instruction}" → ${t.expect.action}${t.expect.targetId ? ` @ ${t.expect.targetId}` : ''}`);
      }
    }
    ctx.out.result(true, 'vision.dataset.show', { scene, ...(code ? { code } : {}) });
    return EXIT.OK;
  }
  // list (default)
  const resumo = {
    version: carregado.dataset.version,
    generator: carregado.dataset.generator,
    createdAt: carregado.dataset.createdAt,
    hash: datasetHash(carregado.dataset),
    scenes: carregado.dataset.scenes.map((s) => ({
      id: s.id,
      family: s.family,
      title: s.title,
      elements: s.elements.length,
      tasks: s.tasks.length,
      image: s.image.file,
      bytes: s.image.bytes,
    })),
    assets: carregado.dataset.assets,
  };
  if (ctx.out.isText) {
    ctx.out.line(`dataset de visão ${resumo.version} — ${resumo.scenes.length} cenário(s) · hash ${crop(resumo.hash)}`);
    for (const s of resumo.scenes) {
      ctx.out.line(`  ${s.id.padEnd(28)} ${s.family.padEnd(10)} ${String(s.elements).padStart(2)} elemento(s) · ${s.tasks} tarefa(s)`);
    }
  }
  ctx.out.result(true, 'vision.dataset.list', resumo);
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export async function cmdVision(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub && !sub.startsWith('-')) {
    assertKnownSubcommand('vision', sub, VISION_SUBCOMMANDS, {
      usage: `vision ${VISION_SUBCOMMANDS.join('|')} (ver \`prompt-builder vision --help\`)`,
      aliases: { ls: 'list', get: 'show', runs: 'list', benchmark: 'run' },
    });
  }
  switch (sub) {
    case 'run':
      return cmdRun(rest);
    case 'list':
      return cmdList(rest);
    case 'show':
      return cmdShow(rest);
    case 'report':
      return cmdReport(rest);
    case 'dataset':
      return cmdDataset(rest);
    default:
      throw new CliError(
        sub ? `Subcomando desconhecido: "vision ${sub}".` : 'Uso: prompt-builder vision <subcomando> — veja `prompt-builder vision --help`.',
        EXIT.USAGE,
        { subcommands: VISION_SUBCOMMANDS },
        { code: 'usage.unknown_command', hint: `Subcomandos: ${VISION_SUBCOMMANDS.join(', ')}.` },
      );
  }
}

/** Reexport para o dispatch (e para o teste de ajuda não importar o motor). */
export type { VisionDataset };
