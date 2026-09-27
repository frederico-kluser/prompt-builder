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
import { estimateInputFromConfig, estimateRunCost, toPerMTok } from '../../estimate.js';
import { formatGateSummary, formatSignificance } from '../../stats.js';
import { CliError, EXIT, fmtUsd, renderSpend } from '../output.js';
import { buildNetworkContext, checkKey, isAgentContext, parse, type NetworkContext } from '../context.js';
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
  if (!Number.isFinite(x)) throw new CliError(`${campo} deve ser um número.`, EXIT.USAGE);
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
 */
function resolveBudget(values: Record<string, unknown>, warn: (m: string) => void): number | undefined {
  const raw = values.budget;
  if (typeof raw === 'string' && raw.trim()) {
    if (raw.trim().toLowerCase() === 'none') return undefined;
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) {
      throw new CliError('--budget deve ser um valor em USD maior que zero, ou "none".', EXIT.USAGE);
    }
    return v;
  }
  if (isAgentContext()) {
    throw new CliError(
      'Faltou definir orçamento. Escolha explicitamente:\n' +
        '  --budget 5      teto de US$ 5 para esta execução\n' +
        '  --budget none   sem teto (assumindo o custo)\n' +
        '(a exigência vale fora de um terminal interativo — nada foi gasto)',
      EXIT.USAGE,
    );
  }
  warn('Sem --budget: rodando SEM teto de gasto.');
  return undefined;
}

async function readConfigFile(file: string): Promise<RunConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch {
    throw new CliError(`Não consegui ler o arquivo "${file}".`, EXIT.USAGE);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new CliError(`"${file}" não é um JSON válido: ${(err as Error).message}`, EXIT.CONFIG);
  }

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
  if (!theme) throw new CliError('--theme é obrigatório (ou use --config <arquivo>).', EXIT.USAGE);

  const judges = (values.judge as string[] | undefined) ?? [];
  if (judges.length === 0) {
    throw new CliError('--judge é obrigatório (pode repetir para vários juízes).', EXIT.USAGE);
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
      throw new CliError('--models precisa de ao menos 2 ids separados por vírgula.', EXIT.USAGE);
    }
    candidate = { mode, ...common, competitorModelIds: models };
  } else {
    const contestant =
      (typeof values.contestant === 'string' && values.contestant.trim()) ||
      (typeof values.model === 'string' && values.model.trim());
    if (!contestant) {
      throw new CliError('--model (o modelo sob teste) é obrigatório.', EXIT.USAGE);
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

/**
 * Pre-voo: catalogo quente -> key valida -> estimativa -> decisao.
 * Fora de TTY, a faixa duvidosa RECUSA em vez de perguntar — um `--yes`
 * esquecido vira um erro claro em vez de uma conta inesperada.
 */
async function preflight(ctx: NetworkContext, config: RunConfig, budgetUsd?: number): Promise<void> {
  const { out, values } = ctx;
  const est = estimateRunCost(estimateInputFromConfig(config), ctx.models);

  if (est.unpricedModelIds.length > 0) {
    const msg = `modelos fora do catálogo (custo contado como zero): ${est.unpricedModelIds.join(', ')}`;
    if (budgetUsd !== undefined) {
      throw new CliError(
        `Não dá para respeitar um orçamento com ${msg}. Verifique os ids com \`models list --search ...\`.`,
        EXIT.CONFIG,
      );
    }
    out.warn(msg);
  }

  out.info(
    `Custo estimado: ${fmtUsd(est.low)} – ${fmtUsd(est.high)} ` +
      `(${est.assumptions.stages} cenários × ${est.assumptions.contestants} participantes` +
      (est.assumptions.iterations > 1 ? ` × até ${est.assumptions.iterations} iterações` : '') +
      ')',
  );

  // Teto por requisicao: um valor apertado demais vira 404 "No allowed
  // providers" em runtime — que NAO e sinal de controle e viraria veredito
  // 'parcial'. Recusar aqui e o que impede a run corrompida.
  const cap = config.maxPricePerMTok;
  if (cap) {
    const usados = new Set<string>([
      ...(config.mode === 'compare'
        ? (config.competitorModelIds ?? config.competitorConfigs?.map((c) => c.modelId) ?? [])
        : [config.contestantModelId]),
      ...config.judgeModelIds,
      config.datagenModelId,
    ]);
    for (const id of usados) {
      const m = ctx.models.find((x) => x.id === id);
      if (!m) continue;
      if (cap.prompt !== undefined && toPerMTok(m.pricing.prompt) > cap.prompt) {
        throw new CliError(
          `--max-price-in ${cap.prompt} está abaixo do preço de "${id}" ` +
            `(${toPerMTok(m.pricing.prompt).toFixed(2)} por 1M). Lembre: a flag é USD por MILHÃO de tokens.`,
          EXIT.CONFIG,
        );
      }
      if (cap.completion !== undefined && toPerMTok(m.pricing.completion) > cap.completion) {
        throw new CliError(
          `--max-price-out ${cap.completion} está abaixo do preço de "${id}" ` +
            `(${toPerMTok(m.pricing.completion).toFixed(2)} por 1M). A flag é USD por MILHÃO de tokens.`,
          EXIT.CONFIG,
        );
      }
    }
  }

  const info = await checkKey(ctx.apiKey);
  const saldo = info.limitRemainingUsd;
  if (typeof saldo === 'number') {
    if (saldo < est.low) {
      throw new CliError(
        `A key tem ${fmtUsd(saldo)} disponíveis e a run custa pelo menos ${fmtUsd(est.low)}. ` +
          'Adicione créditos ou reduza --stages/--iterations.',
        EXIT.NO_CREDIT,
      );
    }
    if (saldo < est.high) out.warn(`saldo da key (${fmtUsd(saldo)}) pode não cobrir o teto estimado.`);
    if (budgetUsd !== undefined && budgetUsd > saldo) {
      out.warn(`orçamento ${fmtUsd(budgetUsd)} maior que o saldo da key — teto real: ${fmtUsd(saldo)}.`);
    }
  }

  if (budgetUsd === undefined) return;

  if (est.high <= budgetUsd) return;
  if (est.low > budgetUsd && values.force !== true) {
    throw new CliError(
      `Orçamento ${fmtUsd(budgetUsd)} abaixo do piso estimado ${fmtUsd(est.low)}.\n` +
        'Reduza --stages, desligue as finais (--no-duels), use menos juízes, ' +
        'ou passe --force para rodar mesmo assim (as portas de orçamento seguem armadas).',
      EXIT.USAGE,
    );
  }
  if (values.yes !== true && isAgentContext()) {
    throw new CliError(
      `Orçamento ${fmtUsd(budgetUsd)} está dentro da faixa estimada (${fmtUsd(est.low)} – ${fmtUsd(est.high)}), ` +
        'então a run pode parar no meio. Confirme com --yes.',
      EXIT.USAGE,
    );
  }
  out.warn(
    `orçamento ${fmtUsd(budgetUsd)} pode não cobrir o teto (${fmtUsd(est.high)}) — a run pode parar cedo.`,
  );
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

export async function cmdRun(mode: RunMode, argv: string[]): Promise<number> {
  const parsed = parse(argv, OPTIONS);
  const ctx = await buildNetworkContext(parsed);
  const { out, values } = ctx;

  const config =
    typeof values.config === 'string'
      ? await readConfigFile(values.config)
      : await buildFromFlags(mode, values);

  if (config.mode !== mode && typeof values.config === 'string') {
    out.warn(`o arquivo declara mode "${config.mode}"; usando o do arquivo.`);
  }

  const budgetUsd = resolveBudget(values, (m) => out.warn(m));
  const configComOrcamento: RunConfig = { ...config, ...(budgetUsd !== undefined ? { budgetUsd } : {}) };

  // --dry-run: valida, estima e NAO chama nenhuma API. Transforma um erro caro
  // de 20 minutos num de 200 ms.
  if (values['dry-run'] === true) {
    const est = estimateRunCost(estimateInputFromConfig(configComOrcamento), ctx.models);
    if (out.isText) {
      out.line(JSON.stringify(configComOrcamento, null, 2));
      out.line();
      out.line(`Custo estimado: ${fmtUsd(est.low)} – ${fmtUsd(est.high)}`);
    }
    out.result(true, `${mode}.dry-run`, { config: configComOrcamento, estimate: est });
    return EXIT.OK;
  }

  await preflight(ctx, configComOrcamento, budgetUsd);

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
    process.exit(EXIT.SIGINT);
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
  out.result(record.status !== 'error', config.mode, {
    runId: record.id,
    status: record.status,
    totalCostUsd: record.totalCostUsd,
    budgetExhausted: Boolean(record.budgetExhausted),
    stoppedAtPhase: record.stoppedAtPhase,
    standings: record.standings,
    judgeScoreByContestant: record.judgeScoreByContestant,
  });

  if (record.status === 'error') throw new CliError(record.error ?? 'run falhou', EXIT.ERROR);
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
          // IMPL-002: bruto (máximo entre K) e corrigido lado a lado com o p ajustado.
          out.info(
            `  iteração ${e.iteration + 1}: promovido — ${formatGateSummary({
              gainPp: e.gain,
              gainCorrectedPp: e.gainCorrected,
              pAdjusted: e.pAdjusted,
              k: e.k,
              method: e.method,
              minGain: e.minGain,
            })}`,
          );
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
      // IMPL-001: relatório mostra o p BILATERAL (o unilateral é o do gate).
      out.line(`Significância  ${formatSignificance(record.significance)}`);
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

  out.result(record.status !== 'error', 'train', {
    sessionId: sessionId || record.id,
    status: record.status,
    totalCostUsd: record.totalCostUsd,
    iterationsDone: record.bestPromptByIteration.length,
    budgetExhausted: Boolean(record.budgetExhausted),
    holdoutSkipped: Boolean(record.holdoutSkipped),
    championPrompt: campeao?.systemPrompt,
    holdout: record.holdout,
    significance: record.significance,
  });

  if (record.status === 'error') throw new CliError(record.error ?? 'treino falhou', EXIT.ERROR);
  return exitFor(record.stoppedReason, record.budgetExhausted);
}
