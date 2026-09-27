// `compare` | `vary` | `train` — monta o RunConfig (por flags ou por
// arena-config@1), faz o pre-voo de orcamento e executa ate o fim.

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runToCompletion } from '../../orchestrator.js';
import { trainToCompletion } from '../../trainer.js';
import { prepareOptsFor } from '../../prepareRun.js';
import { subscribe, subscribeSession } from '../../events.js';
import { parseRunConfig } from '../../runConfigSchema.js';
import { parseArenaConfig } from '../../configFile.js';
import { arenaConfigToRunConfig, libraryRefFrom } from '../../arenaConfig.js';
import { listItems } from '../../library.js';
import { hasGabarito, toStageSpec } from '../../engine/libraryCore.js';
import { CliError, DEFAULT_HINT, EXIT, failAndExit, fmtUsd, renderSpend, type Output } from '../output.js';
import {
  buildContext,
  checkKey,
  isAgentContext,
  loadCatalog,
  parse,
  readJsonFile,
  tryResolveKey,
  type CliContext,
  type NetworkContext,
} from '../context.js';
import {
  budgetUsdOf,
  runPreflight,
  type BudgetChoice,
  type PreflightDeps,
  type PreflightReport,
} from '../preflight.js';
import { emitRunEvent, emitSessionEventNdjson } from '../ndjson.js';
import type {
  RunConfig,
  RunMode,
  RunRecord,
  SessionRecord,
  ReasoningLevel,
  TrainingConfig,
} from '../../types.js';

const OPTIONS = {
  config: { type: 'string', short: 'c' },
  theme: { type: 'string' },
  models: { type: 'string' },
  model: { type: 'string' },
  contestant: { type: 'string' },
  datagen: { type: 'string' },
  judge: { type: 'string', multiple: true },
  reference: { type: 'string' },
  rewriter: { type: 'string' },
  stages: { type: 'string' },
  iterations: { type: 'string' },
  techniques: { type: 'string' },
  'base-prompt': { type: 'string' },
  'base-prompt-file': { type: 'string' },
  'scenario-brief': { type: 'string' },
  'effort-competitor': { type: 'string' },
  'effort-judge': { type: 'string' },
  'effort-datagen': { type: 'string' },
  'effort-rewriter': { type: 'string' },
  temperature: { type: 'string' },
  'max-output-tokens': { type: 'string' },
  'judge-passes': { type: 'string' },
  finalists: { type: 'string' },
  'no-duels': { type: 'boolean' },
  'timeout-ms': { type: 'string' },
  'min-gain': { type: 'string' },
  'holdout-ratio': { type: 'string' },
  // Reflexao GEPA: deterministic (default) | llm (meta-modelo) | off (F2 §7.5).
  reflection: { type: 'string' },
  budget: { type: 'string' },
  'on-budget': { type: 'string' },
  'max-price-in': { type: 'string' },
  'max-price-out': { type: 'string' },
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  force: { type: 'boolean' },
} as const;

function n(v: unknown, campo: string): number | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const x = Number(v);
  if (!Number.isFinite(x)) {
    throw new CliError(`${campo} deve ser um número.`, EXIT.USAGE, { flag: campo, value: v }, { code: 'usage.invalid_number' });
  }
  return x;
}

function list(v: unknown): string[] | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function effort(v: unknown): ReasoningLevel | undefined {
  return typeof v === 'string' && v.trim() ? (v.trim() as ReasoningLevel) : undefined;
}

/**
 * Orcamento. `none` = sem teto. **Ausente e sem TTY = recusa**: um agente
 * autonomo rodando sem teto por omissao e exatamente o risco que se quer
 * evitar; melhor um erro claro antes de gastar do que uma fatura surpresa.
 * A recusa em si (`usage.budget_required`) e do pre-voo (`../preflight.ts`):
 * assim o `--dry-run` a reporta com a estimativa em vez de morrer antes dela.
 * Valor malformado continua erro de uso imediato.
 */
function resolveBudget(values: Record<string, unknown>, warn: (m: string) => void): BudgetChoice {
  const raw = values.budget;
  if (typeof raw === 'string' && raw.trim()) {
    if (raw.trim().toLowerCase() === 'none') return { kind: 'none' };
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) {
      throw new CliError('--budget deve ser um valor em USD maior que zero, ou "none".', EXIT.USAGE, { value: raw }, {
        code: 'usage.invalid_budget',
        hint: 'Use `--budget 5` (teto de US$ 5) ou `--budget none` (sem teto, assumindo o custo).',
      });
    }
    return { kind: 'usd', usd: v };
  }
  if (isAgentContext()) return { kind: 'missing' };
  warn('Sem --budget: rodando SEM teto de gasto.');
  return { kind: 'unset' };
}

async function readConfigFile(file: string): Promise<RunConfig> {
  const json = await readJsonFile(file);

  // Detecta o dialeto pela chave `format`: arena-config@1 (declarativo, o que a
  // ARENA-CONFIG.md documenta) vs RunConfig cru.
  const formato = (json as Record<string, unknown>)?.format;
  if (typeof formato === 'string') {
    const parsed = parseArenaConfig(json);
    if (!parsed.ok) throw new CliError(parsed.error, EXIT.CONFIG);
    const conv = arenaConfigToRunConfig(parsed.config);
    if (!conv.ok) throw new CliError(conv.error, EXIT.CONFIG);
    // F1/P0.1: `scenarios.from: 'library'` — o config aponta o banco curado
    // estável em <data-dir>/library/. Resolvido AQUI (fs é assíncrono): os
    // itens viram customStages e os SEM GABARITO são RECUSADOS (paridade com o
    // 409 do prompt-arena — sem âncora não há evolução comparável).
    const lib = libraryRefFrom(parsed.config);
    if (lib) {
      const itens = await listItems(lib.profile);
      const selecionados = lib.ids?.length
        ? itens.filter((i) => lib.ids!.includes(i.id))
        : itens;
      if (!selecionados.length) {
        throw new CliError(
          `Biblioteca "${lib.profile}" sem itens${lib.ids?.length ? ` para os ids ${lib.ids.join(', ')}` : ''}. Rode \`prompt-builder library add/seed --profile ${lib.profile}\`.`,
          EXIT.CONFIG,
        );
      }
      const semGabarito = selecionados.filter((i) => !hasGabarito(i));
      if (semGabarito.length) {
        throw new CliError(
          `Evolve recusa itens SEM gabarito (reference ou expected) — paridade com o 409 do prompt-arena: ${semGabarito
            .map((i) => i.id)
            .join(', ')}. Corrija com \`prompt-builder library verify --profile ${lib.profile}\`.`,
          EXIT.CONFIG,
        );
      }
      conv.config.customStages = selecionados.map((i) => toStageSpec(i));
      conv.config.stages = selecionados.length;
    }
    return conv.config;
  }
  const parsed = parseRunConfig(json);
  if (!parsed.ok) throw new CliError(parsed.error, EXIT.CONFIG, parsed.details);
  return parsed.config;
}

async function buildFromFlags(
  mode: RunMode,
  values: Record<string, unknown>,
): Promise<RunConfig> {
  const theme = typeof values.theme === 'string' ? values.theme.trim() : '';
  if (!theme) {
    throw new CliError('--theme é obrigatório (ou use --config <arquivo>).', EXIT.USAGE, { flag: '--theme' }, {
      code: 'usage.missing_flag',
      hint: 'Passe `--theme "<tema>"` com os modelos, ou `--config <arquivo.json>` (`prompt-builder config example` gera um).',
    });
  }

  const judges = (values.judge as string[] | undefined) ?? [];
  if (judges.length === 0) {
    throw new CliError('--judge é obrigatório (pode repetir para vários juízes).', EXIT.USAGE, { flag: '--judge' }, {
      code: 'usage.missing_flag',
      hint: 'Passe `--judge <id>` (repita para vários); o juiz não pode ser um competidor.',
    });
  }

  const reasoning: Record<string, ReasoningLevel> = {};
  const ec = effort(values['effort-competitor']);
  if (ec) reasoning.competitor = ec;
  const ej = effort(values['effort-judge']);
  if (ej) reasoning.judge = ej;
  const ed = effort(values['effort-datagen']);
  if (ed) reasoning.datagen = ed;
  const er = effort(values['effort-rewriter']);
  if (er) reasoning.rewriter = er;

  let basePrompt: string | undefined;
  if (typeof values['base-prompt-file'] === 'string') {
    basePrompt = await fs.readFile(values['base-prompt-file'], 'utf-8');
  } else if (typeof values['base-prompt'] === 'string') {
    basePrompt = values['base-prompt'];
  }

  const maxPriceIn = n(values['max-price-in'], '--max-price-in');
  const maxPriceOut = n(values['max-price-out'], '--max-price-out');

  const common: Record<string, unknown> = {
    theme,
    stages: n(values.stages, '--stages') ?? 5,
    datagenModelId:
      (typeof values.datagen === 'string' && values.datagen.trim()) || judges[0],
    judgeModelIds: judges,
    ...(typeof values.reference === 'string' ? { referenceModelId: values.reference } : {}),
    ...(typeof values['scenario-brief'] === 'string'
      ? { scenarioBrief: values['scenario-brief'] }
      : {}),
    ...(Object.keys(reasoning).length ? { reasoning } : {}),
    maxOutputTokens: n(values['max-output-tokens'], '--max-output-tokens') ?? 1000,
    judgePasses: (n(values['judge-passes'], '--judge-passes') === 2 ? 2 : 1) as 1 | 2,
    finalists: n(values.finalists, '--finalists') ?? 3,
    ...(values['no-duels'] === true ? { duels: false } : {}),
    ...(n(values['timeout-ms'], '--timeout-ms') !== undefined
      ? { timeoutMs: n(values['timeout-ms'], '--timeout-ms') }
      : {}),
    ...(maxPriceIn !== undefined || maxPriceOut !== undefined
      ? {
          maxPricePerMTok: {
            ...(maxPriceIn !== undefined ? { prompt: maxPriceIn } : {}),
            ...(maxPriceOut !== undefined ? { completion: maxPriceOut } : {}),
          },
        }
      : {}),
  };

  let candidate: Record<string, unknown>;
  if (mode === 'compare') {
    const models = list(values.models);
    if (!models || models.length < 2) {
      throw new CliError('--models precisa de ao menos 2 ids separados por vírgula.', EXIT.USAGE, { flag: '--models' }, {
        code: 'usage.missing_flag',
        hint: 'Ex.: `--models openai/gpt-5-mini,anthropic/claude-haiku-4.5` (ids de `prompt-builder models list --json`).',
      });
    }
    candidate = { mode, ...common, competitorModelIds: models };
  } else {
    const contestant =
      (typeof values.contestant === 'string' && values.contestant.trim()) ||
      (typeof values.model === 'string' && values.model.trim());
    if (!contestant) {
      throw new CliError('--model (o modelo sob teste) é obrigatório.', EXIT.USAGE, { flag: '--model' }, {
        code: 'usage.missing_flag',
        hint: 'Passe `--model <id>` (ids de `prompt-builder models list --json`).',
      });
    }
    const techniques = list(values.techniques);
    candidate = {
      mode,
      ...common,
      contestantModelId: contestant,
      ...(basePrompt?.trim() ? { basePrompt } : {}),
      promptOptimization: true,
      techniqueIds: techniques ?? [],
      ...(typeof values.rewriter === 'string' ? { optimizerModelId: values.rewriter } : {}),
      ...(n(values.temperature, '--temperature') !== undefined
        ? { temperature: n(values.temperature, '--temperature') }
        : {}),
      ...(mode === 'training'
        ? {
            iterations: n(values.iterations, '--iterations') ?? 3,
            ...(n(values['min-gain'], '--min-gain') !== undefined
              ? { minGain: n(values['min-gain'], '--min-gain') }
              : {}),
            ...(n(values['holdout-ratio'], '--holdout-ratio') !== undefined
              ? { holdoutRatio: n(values['holdout-ratio'], '--holdout-ratio') }
              : {}),
            ...(values.reflection === 'llm' ||
            values.reflection === 'deterministic' ||
            values.reflection === 'off'
              ? { reflection: values.reflection }
              : {}),
          }
        : {}),
    };
  }

  const parsed = parseRunConfig(candidate);
  if (!parsed.ok) throw new CliError(parsed.error, EXIT.CONFIG, parsed.details);
  return parsed.config;
}

/** I/O real do pre-voo: catalogo (publico sem key), `GET /key`, narracao no stderr. */
function preflightDeps(ctx: CliContext): PreflightDeps {
  return {
    loadCatalog: (apiKey) => loadCatalog(ctx, apiKey),
    checkKey,
    info: (m) => ctx.out.info(m),
    warn: (m) => ctx.out.warn(m),
  };
}

/** Narracao do dry-run em texto (payload no stdout, como antes). */
function renderDryRun(out: Output, config: RunConfig, rep: PreflightReport): void {
  if (!out.isText) return;
  out.line(JSON.stringify(config, null, 2));
  out.line();
  out.line(`Custo estimado: ${fmtUsd(rep.estimate.low)} – ${fmtUsd(rep.estimate.high)}`);
  const c = rep.checks;
  out.line(
    'Pré-voo:        ' +
      (c.catalog ? `catálogo ${c.catalog.models} modelos (${c.catalog.source}, ${c.catalog.scope})` : 'catálogo indisponível') +
      ` · key ${c.key === 'ok' ? 'ok' : c.key === 'missing' ? 'ausente' : 'inválida'}` +
      (typeof c.creditRemainingUsd === 'number' ? ` · saldo ${fmtUsd(c.creditRemainingUsd)}` : ''),
  );
  for (const r of rep.wouldRefuse) out.line(`  RECUSARIA  ${r.code} — ${r.message.split('\n')[0]}`);
  for (const r of rep.requires) out.line(`  REQUER     ${r.code} — ${r.message}`);
  if (!rep.wouldRefuse.length) {
    out.line(
      rep.requires.length
        ? 'Nenhuma recusa de configuração; a execução real ainda exige o que está em REQUER.'
        : 'Pré-voo aprovado: a execução real não recusaria.',
    );
  }
}

/**
 * Codigo de saida do desfecho. Distingue os tres finais que um agente precisa
 * tratar diferente: terminou (0), parou por orcamento com resultado parcial (7)
 * e foi interrompido pelo usuario (130).
 */
function exitFor(stoppedReason: 'budget' | 'cancelled' | undefined, budgetExhausted?: boolean): number {
  if (stoppedReason === 'cancelled') return EXIT.SIGINT;
  if (budgetExhausted || stoppedReason === 'budget') return EXIT.BUDGET;
  return EXIT.OK;
}

function relatorioFinal(ctx: NetworkContext, record: RunRecord): void {
  const { out } = ctx;
  if (!out.isText) return;
  out.line();
  for (const l of renderSpend(record.costByRole, record.totalCostUsd, record.budgetUsd, record.costAccuracy)) {
    out.line(l);
  }
  if (record.budgetExhausted) {
    out.line(`Parou em   ${record.stoppedAtPhase ?? '?'} — orçamento esgotado`);
  }

  // Qual REGUA foi usada precisa ficar explicito: standings (finais) e
  // judge-score nao sao intercambiaveis.
  if (record.standings?.length) {
    out.line();
    out.line('Classificação (duelos das finais):');
    for (const s of record.standings) {
      out.line(`  ${s.label.padEnd(24)} ${s.points} pts  (${s.wins}V ${s.ties}E ${s.losses}D)`);
    }
  } else if (record.judgeScoreByContestant) {
    out.line();
    out.line('Ranking por judge-score (sem finais):');
    const ord = Object.entries(record.judgeScoreByContestant).sort((a, b) => b[1] - a[1]);
    for (const [id, score] of ord) {
      const label = record.contestants.find((c) => c.id === id)?.label ?? id;
      out.line(`  ${label.padEnd(24)} ${score.toFixed(1)}`);
    }
  }
}

/** Nome do comando digitado (rotulo do envelope) por modo de run. */
const COMMAND_BY_MODE: Record<RunMode, string> = {
  compare: 'compare',
  variation: 'vary',
  training: 'train',
};

export async function cmdRun(mode: RunMode, argv: string[]): Promise<number> {
  const parsed = parse(argv, OPTIONS);
  // Key OPCIONAL aqui (IMPL-029): o pre-voo checa a config contra o catalogo
  // publico antes e so exige a key no fim — e o dry-run roda sem ela.
  const base = buildContext(parsed);
  const { out, values } = base;

  const config =
    typeof values.config === 'string'
      ? await readConfigFile(values.config)
      : await buildFromFlags(mode, values);

  if (config.mode !== mode && typeof values.config === 'string') {
    out.warn(`o arquivo declara mode "${config.mode}"; usando o do arquivo.`);
  }

  const budget = resolveBudget(values, (m) => out.warn(m));
  const budgetUsd = budgetUsdOf(budget);
  const configComOrcamento: RunConfig = { ...config, ...(budgetUsd !== undefined ? { budgetUsd } : {}) };
  const apiKey = await tryResolveKey(values);
  const input = {
    config: configComOrcamento,
    budget,
    apiKey,
    yes: values.yes === true,
    force: values.force === true,
    agentContext: isAgentContext(),
  };

  // --dry-run: o pre-voo INTEIRO, sem gastar (so leituras gratuitas: catalogo
  // publico e, com key, GET /key). Recusa sai com o MESMO error.code/exit da
  // execucao real (paridade por construcao — ver ../preflight.ts); sem recusa,
  // exit 0 com `wouldRefuse: []` e o que falta em `requires`.
  if (values['dry-run'] === true) {
    const rep = await runPreflight(input, preflightDeps(base), 'dry-run');
    renderDryRun(out, configComOrcamento, rep);
    const resumo = {
      dryRun: true,
      estimate: rep.estimate,
      wouldRefuse: rep.wouldRefuse,
      requires: rep.requires,
      warnings: rep.warnings,
      checks: rep.checks,
    };
    const primeira = rep.wouldRefuse[0];
    if (primeira) {
      // Mesmo code/exit/mensagem da recusa real; `details` traz o relatorio
      // inteiro (todas as recusas, na ordem, + a estimativa).
      throw new CliError(primeira.message, primeira.exit, resumo, {
        code: primeira.code,
        hint:
          (primeira.hint ?? DEFAULT_HINT[primeira.kind]) +
          (rep.wouldRefuse.length > 1
            ? ` (${rep.wouldRefuse.length} recusas no total: veja details.wouldRefuse.)`
            : ''),
      });
    }
    out.result(true, `${mode}.dry-run`, { config: configComOrcamento, ...resumo });
    return EXIT.OK;
  }

  // Execucao real: a mesma sequencia; a primeira recusa e lancada.
  const rep = await runPreflight(input, preflightDeps(base), 'real');
  const ctx: NetworkContext = {
    ...base,
    // Sem key ou sem catalogo o pre-voo real ja lancou (auth.key_missing /
    // network.catalog_unavailable).
    apiKey: apiKey as string,
    models: rep.catalog!.models,
    catalogSource: rep.catalog!.catalogSource,
  };

  // Ctrl-C: o primeiro aborta com elegancia (a run finaliza, salva e imprime o
  // parcial); o segundo mata na hora.
  const ac = new AbortController();
  let interrupts = 0;
  const onSigint = (): void => {
    interrupts += 1;
    if (interrupts === 1) {
      out.warn('interrompendo… (Ctrl-C de novo para sair na hora)');
      ac.abort('SIGINT');
      return;
    }
    // Saida imediata ainda termina no envelope: o NDJSON nao fica sem `result`.
    failAndExit(
      out,
      COMMAND_BY_MODE[mode],
      new CliError('Interrompido (2º Ctrl-C): saída imediata, sem esperar a run fechar.', EXIT.SIGINT, undefined, {
        code: 'control.interrupted',
      }),
    );
  };
  process.on('SIGINT', onSigint);

  try {
    if (configComOrcamento.mode === 'training') {
      return await runTraining(ctx, configComOrcamento, ac.signal);
    }
    return await runSingle(ctx, configComOrcamento, ac.signal);
  } finally {
    process.off('SIGINT', onSigint);
  }
}

async function runSingle(
  ctx: NetworkContext,
  config: RunConfig,
  signal: AbortSignal,
): Promise<number> {
  const { out } = ctx;
  // Id proprio + assinatura ANTES de comecar: sem isso ha corrida com o
  // primeiro evento emitido pelo loop.
  const runId = randomUUID();
  const unsub = subscribe(runId, (e) => emitRunEvent(out, e, { verbose: ctx.verbose }));
  out.event('start', { command: config.mode, runId });
  out.info(`run ${runId} — ${config.mode}`);

  let record: RunRecord;
  try {
    record = await runToCompletion(
      config,
      ctx.apiKey,
      prepareOptsFor(config, ctx.apiKey, { runId, ctx: { signal } }),
    );
  } finally {
    unsub();
  }

  relatorioFinal(ctx, record);
  // Falha vira o envelope de erro (com o resumo em `details`), nunca um
  // `result` ok:false seguido de um segundo objeto — dois JSONs no stdout.
  if (record.status === 'error') {
    throw new CliError(
      record.error ?? 'run falhou',
      EXIT.ERROR,
      {
        runId: record.id,
        status: record.status,
        totalCostUsd: record.totalCostUsd,
        stoppedAtPhase: record.stoppedAtPhase ?? null,
      },
      { code: 'run.failed', hint: `Veja o record em \`prompt-builder runs show ${record.id} --json\`.` },
    );
  }
  // ok:true com exit != 0 so para PARCIAL (7/130): `stoppedReason` diz qual.
  out.result(true, config.mode, {
    runId: record.id,
    status: record.status,
    totalCostUsd: record.totalCostUsd,
    budgetExhausted: Boolean(record.budgetExhausted),
    stoppedReason: record.stoppedReason ?? null,
    stoppedAtPhase: record.stoppedAtPhase,
    standings: record.standings,
    judgeScoreByContestant: record.judgeScoreByContestant,
  });
  return exitFor(record.stoppedReason, record.budgetExhausted);
}

async function runTraining(
  ctx: NetworkContext,
  config: RunConfig,
  signal: AbortSignal,
): Promise<number> {
  const { out } = ctx;
  const cfg = config as TrainingConfig;
  let unsubSession = (): void => undefined;
  const unsubRuns: (() => void)[] = [];
  let sessionId = '';

  const record: SessionRecord = await trainToCompletion(cfg, ctx.apiKey, {
    signal,
    onSession: (id) => {
      sessionId = id;
      out.event('start', { command: 'train', sessionId: id });
      out.info(`sessão ${id} — até ${cfg.iterations} iterações`);
      unsubSession = subscribeSession(id, (e) => {
        emitSessionEventNdjson(out, e);
        // Assina o bus de CADA iteracao assim que ela e anunciada — em NDJSON
        // as linhas de run levam sessionId + runId para o stream nao ficar
        // ambiguo com os dois niveis intercalados.
        if (e.type === 'iteration.started') {
          unsubRuns.push(
            subscribe(e.runId, (re) =>
              emitRunEvent(out, re, { verbose: ctx.verbose, sessionId: id }),
            ),
          );
        }
        if (e.type === 'iteration.promoted' && out.isText) {
          out.info(`  iteração ${e.iteration + 1}: promovido (+${e.gain.toFixed(1)}pp)`);
        }
      });
    },
  });

  unsubSession();
  for (const u of unsubRuns) u();

  const campeao = record.bestPromptByIteration.at(-1);

  if (out.isText) {
    out.line();
    for (const l of renderSpend(record.costByRole, record.totalCostUsd, record.budgetUsd, record.costAccuracy)) {
      out.line(l);
    }
    if (record.budgetExhausted) {
      out.line(
        `Parou em   iteração ${(record.stoppedAtIteration ?? 0) + 1} — orçamento esgotado`,
      );
    }
    if (record.holdout) {
      out.line(
        `Holdout    controle ${record.holdout.controlScore.toFixed(1)} → campeão ` +
          `${record.holdout.championScore.toFixed(1)} (${record.holdout.gain >= 0 ? '+' : ''}${record.holdout.gain.toFixed(1)}pp)`,
      );
    }
    if (record.significance) {
      out.line(
        `Significância  p=${record.significance.pValue.toFixed(3)} · ` +
          `IC95 [${record.significance.ci95Pp[0].toFixed(1)}, ${record.significance.ci95Pp[1].toFixed(1)}]pp`,
      );
    }
    if (record.holdoutSkipped) {
      out.line();
      // Sem o holdout o campeao esta NAO validado contra sobreajuste — omitir
      // isso transformaria a feature de orcamento numa regressao de qualidade.
      out.warn(
        'campeão NÃO validado em holdout (pulado por orçamento/interrupção) — ' +
          'pode estar sobreajustado aos cenários de treino.',
      );
    }
    if (campeao) {
      out.line();
      out.line('--- prompt campeão ---');
      out.line(campeao.systemPrompt);
    }
  }

  if (record.status === 'error') {
    throw new CliError(
      record.error ?? 'treino falhou',
      EXIT.ERROR,
      {
        sessionId: sessionId || record.id,
        status: record.status,
        totalCostUsd: record.totalCostUsd,
        iterationsDone: record.bestPromptByIteration.length,
      },
      {
        code: 'session.failed',
        hint: `Veja a sessão em \`prompt-builder sessions show ${sessionId || record.id} --json\`.`,
      },
    );
  }
  out.result(true, 'train', {
    sessionId: sessionId || record.id,
    status: record.status,
    totalCostUsd: record.totalCostUsd,
    iterationsDone: record.bestPromptByIteration.length,
    budgetExhausted: Boolean(record.budgetExhausted),
    stoppedReason: record.stoppedReason ?? null,
    holdoutSkipped: Boolean(record.holdoutSkipped),
    championPrompt: campeao?.systemPrompt,
    holdout: record.holdout,
    significance: record.significance,
  });
  return exitFor(record.stoppedReason, record.budgetExhausted);
}
