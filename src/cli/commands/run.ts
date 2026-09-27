// `compare` | `vary` | `train` — monta o RunConfig (por flags ou por
// arena-config@1), faz o pre-voo de orcamento e executa ate o fim.

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runToCompletion } from '../../orchestrator.js';
import { trainToCompletion } from '../../trainer.js';
import { prepareOptsFor } from '../../prepareRun.js';
import { subscribe, subscribeSession } from '../../events.js';
import { loadRun, loadSession } from '../../storage.js';
import { makeCallEstimator } from '../../estimate.js';
import { parseRunConfig } from '../../runConfigSchema.js';
import { parseArenaConfig } from '../../configFile.js';
import { checkRunPii, describeRunPii } from '../../engine/pii.js';
import { arenaConfigToRunConfig, libraryRefFrom } from '../../arenaConfig.js';
import { listItems } from '../../library.js';
import { hasGabarito, labelIssue, toStageSpec } from '../../engine/libraryCore.js';
import { formatGateSummary, formatSignificance } from '../../stats.js';
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
  type PreflightGuard,
  type PreflightReport,
} from '../preflight.js';
import {
  acquireRunLock,
  claimIdempotency,
  configHash,
  dropIdempotency,
  idempotencyConflictError,
  idempotencyFile,
  idempotencyOwnerAlive,
  inspectRunLock,
  readIdempotency,
  runLockedError,
  startHeartbeat,
  updateIdempotency,
  validateIdempotencyKey,
  type IdempotencyRecord,
  type RunLock,
} from '../runLock.js';
import {
  openMachineLedger,
  readDailySnapshot,
  resolveDailyCap,
  type FileSpendLedger,
  type MachineBudgetLedger,
} from '../spendLedger.js';
import { pruneSpendState } from '../spendGuards.js';
import { emitRunEvent, emitSessionEventNdjson, truncationFields } from '../ndjson.js';
import { ROLE_LABEL } from '../../budget.js';
import type {
  CostRole,
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
  // IMPL-031 (anti-gasto-N×): repetir a MESMA key anexa à run existente (não
  // gasta de novo); `--allow-concurrent` libera réplica intencional da mesma
  // config (sem o lock `run.locked`).
  'idempotency-key': { type: 'string' },
  'allow-concurrent': { type: 'boolean' },
  // LGPD (IMPL-042): 'synthetic' recusa dado de aparência real; `--allow-pii`
  // = revisei o dado apontado e pode seguir pseudonimizado (modo 'redact').
  'pii-mode': { type: 'string' },
  'allow-pii': { type: 'boolean' },
} as const;

/** `--pii-mode` validado (uso errado = exit 2, nada gasto). */
function piiModeFlag(v: unknown): 'redact' | 'synthetic' | undefined {
  if (v === undefined) return undefined;
  if (v === 'redact' || v === 'synthetic') return v;
  throw new CliError('--pii-mode deve ser "redact" ou "synthetic".', EXIT.USAGE, { flag: '--pii-mode', value: v }, {
    code: 'usage.invalid_flag_value',
    hint: 'Use `--pii-mode redact` (pseudonimiza no envio) ou `--pii-mode synthetic` (só dado sintético).',
  });
}

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

/**
 * Lê e valida `--config` (arena-config@1 ou RunConfig cru). Todo problema de
 * config sai como `CliError(EXIT.CONFIG)` = exit 3 — exportado para o teste
 * de contrato do exit code (IMPL-003).
 */
export async function readConfigFile(
  file: string,
  pii: { allowPii?: boolean; piiMode?: 'redact' | 'synthetic' } = {},
): Promise<RunConfig> {
  let json = await readJsonFile(file);

  // Detecta o dialeto pela chave `format`: arena-config@1 (declarativo, o que a
  // ARENA-CONFIG.md documenta) vs RunConfig cru.
  // As flags de dado pessoal valem sobre o arquivo (o dialeto cru e o arena).
  if (pii.piiMode && json && typeof json === 'object') {
    json = { ...(json as Record<string, unknown>), piiMode: pii.piiMode };
  }
  const formato = (json as Record<string, unknown>)?.format;
  if (typeof formato === 'string') {
    const parsed = parseArenaConfig(json, { allowPii: pii.allowPii });
    if (!parsed.ok) throw new CliError(parsed.error, EXIT.CONFIG);
    // Chave descontinuada (ex.: training.halving, IMPL-012): narração no stderr.
    for (const w of parsed.warnings ?? []) process.stderr.write(`! ${w}\n`);
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
      // IMPL-003: os itens viram customStages DEPOIS do parseRunConfig da
      // tradução — sem esta checagem um item antigo de rótulo curto sem
      // labelSet escaparia da regra do schema.
      const semLabelSet = selecionados
        .map((i) => ({ id: i.id, erro: labelIssue(i) }))
        .filter((x): x is { id: string; erro: string } => x.erro !== null);
      if (semLabelSet.length) {
        throw new CliError(
          `Itens com rótulo esperado sem labelSet válido: ${semLabelSet
            .map((x) => `${x.id} (${x.erro})`)
            .join('; ')}. Corrija com \`prompt-builder library verify --profile ${lib.profile}\`.`,
          EXIT.CONFIG,
        );
      }
      conv.config.customStages = selecionados.map((i) => toStageSpec(i));
      conv.config.stages = selecionados.length;
    }
    return conv.config;
  }
  // RunConfig cru também é importação: o schema recusa dado pessoal de
  // aparência real nomeando o campo, até a revisão explícita (`--allow-pii`).
  const cru = pii.allowPii && json && typeof json === 'object' ? { ...(json as object), allowPii: true } : json;
  const parsed = parseRunConfig(cru);
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
    ...(piiModeFlag(values['pii-mode']) ? { piiMode: piiModeFlag(values['pii-mode']) } : {}),
    ...(values['allow-pii'] === true ? { allowPii: true } : {}),
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
      ` · key ${c.key === 'ok' ? 'ok' : c.key === 'missing' ? 'ausente' : c.key === 'unchecked' ? 'não verificada (rede)' : 'inválida'}` +
      (typeof c.creditRemainingUsd === 'number' ? ` · saldo ${fmtUsd(c.creditRemainingUsd)}` : ''),
  );
  if (c.daily) {
    out.line(
      'Máquina:        ' +
        (c.daily.capUsd === null
          ? `sem teto diário · ${fmtUsd(c.daily.spentUsd)} gastos hoje (UTC)`
          : `teto diário ${fmtUsd(c.daily.capUsd)} (${c.daily.source}) · restam ${fmtUsd(c.daily.remainingUsd ?? 0)} hoje (UTC)`) +
        (c.lock ? ` · lock ${c.lock === 'free' ? 'livre' : c.lock === 'held' ? 'OCUPADO' : 'ignorado (--allow-concurrent)'}` : ''),
    );
  }
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
export function exitFor(
  stoppedReason: 'budget' | 'cancelled' | undefined,
  budgetExhausted?: boolean,
  status?: string,
): number {
  if (stoppedReason === 'cancelled') return EXIT.SIGINT;
  if (budgetExhausted || stoppedReason === 'budget') return EXIT.BUDGET;
  // IMPL-004: terminou, mas a evidencia nao sustenta conclusao.
  if (status === 'inconclusive') return EXIT.INCONCLUSIVE;
  return EXIT.OK;
}

function relatorioFinal(out: Output, record: RunRecord): void {
  if (!out.isText) return;
  out.line();
  for (const l of renderSpend(record.costByRole, record.totalCostUsd, record.budgetUsd, record.costAccuracy)) {
    out.line(l);
  }
  if (record.budgetExhausted) {
    out.line(`Parou em   ${record.stoppedAtPhase ?? '?'} — orçamento esgotado`);
  }
  if (record.status === 'inconclusive') {
    // IMPL-004: o resultado existe, mas nao sustenta conclusao — dizer o porque.
    out.warn('run INCONCLUSIVA — o resultado não sustenta conclusão:');
    for (const motivo of record.verdictIntegrity?.reasons ?? []) out.warn(`  ${motivo}`);
  }
  // IMPL-010: bloqueio (moderação/guardrail do gateway) NÃO é erro de key nem
  // falha do prompt — sai numa linha própria, separado de recusa e de erro.
  const desfechos = record.competitorOutcomeCounts;
  if (desfechos && desfechos.blocked + desfechos.refused + desfechos.error > 0) {
    out.line(
      `Respostas  ${desfechos.blocked} bloqueadas (moderação) · ${desfechos.refused} recusadas pelo modelo · ` +
        `${desfechos.error} com erro`,
    );
  }
  // IMPL-014: truncamento no teto de tokens — etapas cortadas saem do placar.
  const trunc = truncationFields(record);
  const etapasTruncadas = record.stages.filter((s) => s.incompleteReason === 'truncation').length;
  const gabaritosTruncados = record.stages.filter((s) => s.gabaritoCall?.truncated).length;
  if (trunc.truncationCounts && trunc.truncationCounts.truncated > 0) {
    // Quebra por papel: o teto a subir depende de QUEM foi cortado.
    const papeis = Object.entries(trunc.truncationByRole ?? {})
      .filter(([, c]) => c && c.truncated > 0)
      .map(([role, c]) => `${ROLE_LABEL[role as CostRole] ?? role} ${c!.truncated}/${c!.calls}`)
      .join(', ');
    out.line(
      `Truncadas  ${trunc.truncationCounts.truncated} de ${trunc.truncationCounts.calls} chamadas ` +
        `(${((trunc.truncationRate ?? 0) * 100).toFixed(1)}%)${papeis ? ` [${papeis}]` : ''} · ` +
        `${etapasTruncadas} etapa(s) fora do placar` +
        (gabaritosTruncados > 0 ? ` · ${gabaritosTruncados} gabarito(s) descartado(s)` : ''),
    );
  }

  // Qual REGUA foi usada precisa ficar explicito: standings (finais) e
  // judge-score nao sao intercambiaveis.
  if (record.standings?.length) {
    out.line();
    out.line('Classificação (duelos das finais, por taxa de vitória):');
    for (const s of record.standings) {
      // IMPL-007: taxa de vitória = (V + ½E) / disputados — rótulo honesto do placar.
      const taxa = `${Math.round(s.winRate * 100)}%`.padStart(4);
      out.line(`  ${s.label.padEnd(24)} taxa de vitória ${taxa}  (${s.wins}V ${s.ties}E ${s.losses}D)`);
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

/** O que o resultado diz sobre a --idempotency-key (IMPL-031). */
interface IdempotencyInfo {
  key: string;
  /** true = esta invocacao NAO rodou nada: devolveu a run existente (gasto novo = 0). */
  reused: boolean;
  /** true = a run ainda rodava e esta invocacao esperou por ela. */
  attached?: boolean;
}

/** Campos extras do resultado vindos das camadas anti-gasto-N×. */
interface OutcomeExtras {
  idempotency?: IdempotencyInfo;
  /** A run parou (ou foi barrada) pelo teto DIARIO da maquina, nao pelo `--budget`. */
  dailyCapReached?: boolean;
}

function extrasData(x: OutcomeExtras): Record<string, unknown> {
  return {
    ...(x.idempotency ? { idempotency: x.idempotency } : {}),
    ...(x.dailyCapReached ? { dailyCapReached: true } : {}),
  };
}

/**
 * Desfecho de uma run compare/vary — o MESMO para a run recem-rodada e para a
 * reaproveitada por --idempotency-key (o agente nao distingue pelo formato, so
 * por `idempotency.reused`).
 */
function runOutcome(out: Output, record: RunRecord, x: OutcomeExtras): number {
  // IMPL-014: o alerta de truncamento (> 2% das chamadas) vai SEMPRE para o
  // stderr (narração), em qualquer formato; no payload ele sai em `truncationAlert`.
  const alertaTrunc = truncationFields(record).truncationAlert;
  if (alertaTrunc) out.warn(alertaTrunc);
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
        ...extrasData(x),
      },
      { code: 'run.failed', hint: `Veja o record em \`prompt-builder runs show ${record.id} --json\`.` },
    );
  }
  // ok:true com exit != 0 so para PARCIAL (7/130): `stoppedReason` diz qual.
  const resumo = {
    runId: record.id,
    status: record.status,
    totalCostUsd: record.totalCostUsd,
    budgetExhausted: Boolean(record.budgetExhausted),
    stoppedReason: record.stoppedReason ?? null,
    stoppedAtPhase: record.stoppedAtPhase,
    standings: record.standings,
    judgeScoreByContestant: record.judgeScoreByContestant,
    // IMPL-010: blocked (defesa do gateway) / refused (modelo) / error (infra).
    competitorOutcomeCounts: record.competitorOutcomeCounts,
    // IMPL-014: truncationRate (+ truncationAlert acima de 2%) — mesmo formato do NDJSON.
    ...truncationFields(record),
    // IMPL-004: falhas por papel e, se inconclusiva, o porquê.
    failureCountByRole: record.failureCountByRole,
    inconclusiveReasons: record.verdictIntegrity?.reasons,
    ...extrasData(x),
  };
  const exit = exitFor(record.stoppedReason, record.budgetExhausted, record.status);
  // IMPL-004 × IMPL-028: inconclusiva (6) sai pelo envelope único de erro, com
  // o resultado inteiro em `details` — há resultado, mas ele não sustenta conclusão.
  if (exit === EXIT.INCONCLUSIVE) {
    throw new CliError(
      `Run ${record.id} inconclusiva: ${(record.verdictIntegrity?.reasons ?? []).join('; ') || 'o resultado não sustenta conclusão'}.`,
      exit,
      resumo,
      {
        code: 'run.inconclusive',
        hint: `Não promova com base nela; leia o record com \`prompt-builder runs show ${record.id} --json\` (verdictIntegrity, failureCountByRole).`,
      },
    );
  }
  out.result(true, record.config.mode, resumo);
  return exit;
}

/** Desfecho de uma sessao de treino (recem-rodada ou reaproveitada). */
function sessionOutcome(out: Output, record: SessionRecord, sessionId: string, x: OutcomeExtras): number {
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

  if (record.status === 'error') {
    throw new CliError(
      record.error ?? 'treino falhou',
      EXIT.ERROR,
      {
        sessionId,
        status: record.status,
        totalCostUsd: record.totalCostUsd,
        iterationsDone: record.bestPromptByIteration.length,
        ...extrasData(x),
      },
      {
        code: 'session.failed',
        hint: `Veja a sessão em \`prompt-builder sessions show ${sessionId} --json\`.`,
      },
    );
  }
  out.result(true, 'train', {
    sessionId,
    status: record.status,
    totalCostUsd: record.totalCostUsd,
    iterationsDone: record.bestPromptByIteration.length,
    budgetExhausted: Boolean(record.budgetExhausted),
    stoppedReason: record.stoppedReason ?? null,
    holdoutSkipped: Boolean(record.holdoutSkipped),
    championPrompt: campeao?.systemPrompt,
    holdout: record.holdout,
    significance: record.significance,
    ...extrasData(x),
  });
  return exitFor(record.stoppedReason, record.budgetExhausted);
}

// --- IMPL-031: anexar à run dona da --idempotency-key -----------------------

/** Intervalo de leitura do record da run dona enquanto ela roda (em outro processo). */
const ATTACH_POLL_MS = 400;

function esperar(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

function orphanError(key: string, rec: IdempotencyRecord, status: string | null): CliError {
  const id = rec.runId ?? rec.sessionId;
  return new CliError(
    `A execução dona da --idempotency-key "${key}" (pid ${rec.pid}@${rec.host}) morreu sem concluir` +
      (id ? ` a ${rec.sessionId ? 'sessão' : 'run'} ${id}` : ' (antes de criar a run)') +
      '. Reusar a key devolve SEMPRE o mesmo desfecho: nada foi rodado de novo.',
    EXIT.ERROR,
    { idempotencyKey: key, runId: rec.runId, sessionId: rec.sessionId, pid: rec.pid, host: rec.host, status },
    {
      code: 'run.orphaned',
      hint:
        (id ? `O parcial está em \`prompt-builder ${rec.sessionId ? 'sessions' : 'runs'} show ${id} --json\`. ` : '') +
        'Para rodar de novo (gastando de novo), use OUTRA --idempotency-key.',
    },
  );
}

/**
 * Reuso pela --idempotency-key: a run dona ja terminou → devolve o desfecho
 * dela; ainda roda (outro processo) → espera, lendo o record do disco, e
 * devolve quando terminar. NADA e gasto aqui: nem pre-voo, nem rede, nem key.
 * `'released'` = o dono desistiu antes de rodar (ex.: lock recusado) e apagou
 * o registro — o chamador segue como invocacao nova.
 *
 * `mode` e o mode EFETIVO da config (o do arquivo, nunca o verbo digitado).
 * Como a key esta presa ao hash da config — que inclui o mode —, ele e o mesmo
 * da execucao dona; o id gravado no registro, quando ja existe, desempata.
 */
async function attachToExisting(
  out: Output,
  dataDir: string,
  mode: RunMode,
  key: string,
  hash: string,
): Promise<number | 'released'> {
  const ac = new AbortController();
  const onSigint = (): void => ac.abort('SIGINT');
  process.on('SIGINT', onSigint);
  let anunciado = false;
  try {
    for (;;) {
      const rec = readIdempotency(dataDir, key);
      if (!rec) return 'released';
      if (rec.configHash !== hash) throw idempotencyConflictError(key, rec, hash);
      const ehSessao = rec.sessionId ? true : rec.runId ? false : mode === 'training';
      const id = ehSessao ? rec.sessionId : rec.runId;

      const terminal = async (): Promise<RunRecord | SessionRecord | null> => {
        if (!id) return null;
        const r = ehSessao ? await loadSession(id) : await loadRun(id);
        // Qualquer status != 'running' e terminal (inclui os que vierem a
        // existir, como 'inconclusive') — sem lista solta de status.
        return r && r.status !== 'running' ? r : null;
      };

      let fim = await terminal();
      if (!fim && !idempotencyOwnerAlive(dataDir, rec)) {
        // O registro pode ter sido desfeito/trocado entre a leitura e o stat
        // (o dono desistiu antes de rodar): reavalia do zero, sem veredito.
        const again = readIdempotency(dataDir, key);
        if (!again || again.token !== rec.token) continue;
        // O dono pode ter gravado o fim logo antes de sair: uma ultima leitura.
        fim = await terminal();
        if (!fim) {
          const r = id ? (ehSessao ? await loadSession(id) : await loadRun(id)) : null;
          throw orphanError(key, rec, r?.status ?? null);
        }
      }
      if (fim) {
        const info: IdempotencyInfo = { key, reused: true, attached: anunciado };
        out.info(
          `${ehSessao ? 'sessão' : 'run'} ${fim.id} reaproveitada pela --idempotency-key "${key}" — ` +
            'nada foi gasto por esta invocação.',
        );
        if (ehSessao) return sessionOutcome(out, fim as SessionRecord, fim.id, { idempotency: info });
        relatorioFinal(out, fim as RunRecord);
        return runOutcome(out, fim as RunRecord, { idempotency: info });
      }

      if (!anunciado) {
        anunciado = true;
        out.event('attached', {
          command: COMMAND_BY_MODE[mode],
          idempotencyKey: key,
          ...(ehSessao ? { sessionId: id } : { runId: id }),
          ownerPid: rec.pid,
        });
        out.info(
          `anexando à ${ehSessao ? 'sessão' : 'run'} ${id ?? '(iniciando)'} da --idempotency-key "${key}" ` +
            `(pid ${rec.pid}) — esperando ela terminar; nada será gasto por esta invocação.`,
        );
      }
      await esperar(ATTACH_POLL_MS, ac.signal);
      if (ac.signal.aborted) {
        throw new CliError(
          'Espera interrompida (Ctrl-C). A run dona da key segue rodando no outro processo.',
          EXIT.SIGINT,
          { idempotencyKey: key, ...(ehSessao ? { sessionId: id } : { runId: id }) },
          {
            code: 'control.cancelled',
            hint: 'Repita o comando com a mesma --idempotency-key para se anexar de novo.',
          },
        );
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
  }
}

// --- o comando ------------------------------------------------------------------

/** Tudo que a run recem-criada carrega das camadas anti-gasto-N× (IMPL-031). */
interface SpendGuards {
  root: MachineBudgetLedger;
  machine: FileSpendLedger;
  lock: RunLock | null;
  claim: IdempotencyRecord | null;
  dataDir: string;
}

export async function cmdRun(mode: RunMode, argv: string[]): Promise<number> {
  const parsed = parse(argv, OPTIONS);
  // Key OPCIONAL aqui (IMPL-029): o pre-voo checa a config contra o catalogo
  // publico antes e so exige a key no fim — e o dry-run roda sem ela.
  const base = buildContext(parsed);
  const { out, values, dataDir } = base;
  // `command` = o VERBO digitado: so rotula os envelopes de antes da run
  // (pre-voo, 2º Ctrl-C). O que roda — e o `result` — segue o mode do ARQUIVO.
  const command = COMMAND_BY_MODE[mode];
  const dryRun = values['dry-run'] === true;
  const allowConcurrent = values['allow-concurrent'] === true;
  const idemKey = values['idempotency-key'] !== undefined ? validateIdempotencyKey(values['idempotency-key']) : null;

  const config =
    typeof values.config === 'string'
      ? await readConfigFile(values.config, {
          allowPii: values['allow-pii'] === true,
          piiMode: piiModeFlag(values['pii-mode']),
        })
      : await buildFromFlags(mode, values);

  // LGPD (IMPL-042): o que sai pseudonimizado no envio é dito, nunca silencioso
  // (stderr: narração; o record guarda o mesmo relatório em `piiReport`).
  const piiNota = describeRunPii(checkRunPii(config));
  if (piiNota) out.warn(piiNota);

  if (config.mode !== mode && typeof values.config === 'string') {
    out.warn(`o arquivo declara mode "${config.mode}"; usando o do arquivo.`);
  }
  // Mode EFETIVO (IMPL-031, revisão): run × sessão, runId e o registro da
  // --idempotency-key seguem o que vai RODAR, nunca o verbo. Com o verbo, um
  // `train --config compare.json` assinava o bus com runId null (NDJSON sem
  // nenhum evento) e gravava a key sem id — o reuso virava um run.orphaned
  // falso e o agente pagava de novo com key nova.
  const efetivo: RunMode = config.mode;
  const commandEfetivo = COMMAND_BY_MODE[efetivo];

  const budget = resolveBudget(values, (m) => out.warn(m));
  const budgetUsd = budgetUsdOf(budget);
  const configComOrcamento: RunConfig = { ...config, ...(budgetUsd !== undefined ? { budgetUsd } : {}) };
  const hash = configHash(configComOrcamento);

  // IMPL-031 — IDEMPOTENCIA ANTES DE TUDO: a key ja usada com a MESMA config
  // anexa/devolve a run existente sem pre-voo, sem rede e sem key (nada vai ser
  // gasto). Com config diferente e erro de uso — nunca reuso de outro
  // experimento. O dry-run diz o que a real faria (reusar), com paridade.
  if (idemKey) {
    const existente = readIdempotency(dataDir, idemKey);
    if (existente) {
      if (existente.configHash !== hash) throw idempotencyConflictError(idemKey, existente, hash);
      if (dryRun) {
        const id = existente.runId ?? existente.sessionId;
        out.line(`A execução real REUSARIA ${existente.sessionId ? 'a sessão' : 'a run'} ${id ?? '(iniciando)'} — nada seria gasto.`);
        out.result(true, `${mode}.dry-run`, {
          config: configComOrcamento,
          dryRun: true,
          wouldRefuse: [],
          requires: [],
          idempotency: {
            key: idemKey,
            wouldReuse: true,
            runId: existente.runId,
            sessionId: existente.sessionId,
          },
        });
        return EXIT.OK;
      }
      const r = await attachToExisting(out, dataDir, efetivo, idemKey, hash);
      if (r !== 'released') return r;
    }
  }

  const cap = resolveDailyCap(dataDir);
  const guard: PreflightGuard = {
    ...(allowConcurrent
      ? {}
      : {
          lockRefusal: () => {
            const insp = inspectRunLock(dataDir, hash);
            return insp && !insp.stale ? runLockedError(insp) : null;
          },
        }),
    daily: () => readDailySnapshot(dataDir, cap),
  };
  const apiKey = await tryResolveKey(values);
  const input = {
    config: configComOrcamento,
    budget,
    apiKey,
    yes: values.yes === true,
    force: values.force === true,
    agentContext: isAgentContext(),
  };
  const deps: PreflightDeps = { ...preflightDeps(base), guard };

  // --dry-run: o pre-voo INTEIRO, sem gastar (so leituras gratuitas: catalogo
  // publico e, com key, GET /key; lock e teto diario so leem o disco). Recusa
  // sai com o MESMO error.code/exit da execucao real (paridade por construcao —
  // ver ../preflight.ts); sem recusa, exit 0 com `wouldRefuse: []` e o que
  // falta em `requires`.
  if (dryRun) {
    const rep = await runPreflight(input, deps, 'dry-run');
    renderDryRun(out, configComOrcamento, rep);
    const resumo = {
      dryRun: true,
      estimate: rep.estimate,
      wouldRefuse: rep.wouldRefuse,
      requires: rep.requires,
      warnings: rep.warnings,
      checks: rep.checks,
      ...(idemKey ? { idempotency: { key: idemKey, wouldReuse: false } } : {}),
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
  const rep = await runPreflight(input, deps, 'real');
  const ctx: NetworkContext = {
    ...base,
    // Sem key ou sem catalogo o pre-voo real ja lancou (auth.key_missing /
    // network.catalog_unavailable).
    apiKey: apiKey as string,
    models: rep.catalog!.models,
    catalogSource: rep.catalog!.catalogSource,
  };

  // IMPL-031 — registra a key (atomico: de dois processos com a mesma key,
  // exatamente um vence; o outro se ANEXA a ele) e so depois toma o lock da
  // config. Lock recusado desfaz o registro: a run nem comecou.
  const runId: string | null = efetivo === 'training' ? null : randomUUID();
  let claim: IdempotencyRecord | null = null;
  if (idemKey) {
    for (let tentativa = 0; tentativa < 5 && !claim; tentativa++) {
      claim = claimIdempotency(dataDir, { key: idemKey, configHash: hash, command: commandEfetivo, runId, sessionId: null });
      if (claim) break;
      const existente = readIdempotency(dataDir, idemKey);
      if (!existente) continue;
      if (existente.configHash !== hash) throw idempotencyConflictError(idemKey, existente, hash);
      const r = await attachToExisting(out, dataDir, efetivo, idemKey, hash);
      if (r !== 'released') return r;
    }
    if (!claim) {
      throw new CliError(
        `Não consegui registrar a --idempotency-key "${idemKey}" (disputa com outros processos).`,
        EXIT.ERROR,
        { idempotencyKey: idemKey, file: idempotencyFile(dataDir, idemKey) },
        { code: 'run.idempotency_unavailable', hint: 'Repita o comando com a mesma key.' },
      );
    }
  }
  let lock: RunLock | null = null;
  try {
    if (!allowConcurrent) {
      lock = acquireRunLock(dataDir, { command: commandEfetivo, configHash: hash, runId, idempotencyKey: idemKey });
    }
  } catch (err) {
    if (claim) dropIdempotency(dataDir, claim);
    throw err;
  }
  // Heartbeat do registro da key: quem se anexa decide "dono vivo" por ele.
  const stopClaimHeartbeat = claim ? startHeartbeat(() => [idempotencyFile(dataDir, idemKey as string)]) : () => undefined;

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
      command,
      new CliError('Interrompido (2º Ctrl-C): saída imediata, sem esperar a run fechar.', EXIT.SIGINT, undefined, {
        code: 'control.interrupted',
      }),
    );
  };
  process.on('SIGINT', onSigint);

  // Raiz do ledger da run que TAMBEM reserva no ledger em arquivo da maquina
  // (teto diario somando processos). Vai como `parentLedger`: o teto da run
  // continua na raiz, com a mesma semantica de antes. Antes, o GC do estado
  // no disco (dias velhos do ledger, keys vencidas) — revisao do IMPL-031.
  pruneSpendState(dataDir);
  const { root, machine } = openMachineLedger({
    dataDir,
    label: `${commandEfetivo}${runId ? ` run ${runId}` : ''}`,
    budgetUsd: configComOrcamento.budgetUsd,
    signal: ac.signal,
    estimateCall: makeCallEstimator(rep.catalog!.models, { maxPricePerMTok: configComOrcamento.maxPricePerMTok }),
    warn: (m) => out.warn(m),
    cap,
  });
  const guards: SpendGuards = { root, machine, lock, claim, dataDir };

  try {
    // `runId` nulo <=> mode efetivo 'training' (sessao: o id nasce no onSession).
    if (runId === null) return await runTraining(ctx, configComOrcamento, ac.signal, guards);
    return await runSingle(ctx, configComOrcamento, ac.signal, runId, guards);
  } finally {
    process.off('SIGINT', onSigint);
    stopClaimHeartbeat();
    lock?.release();
    machine.close();
  }
}

async function runSingle(
  ctx: NetworkContext,
  config: RunConfig,
  signal: AbortSignal,
  runId: string,
  guards: SpendGuards,
): Promise<number> {
  const { out } = ctx;
  // Id proprio + assinatura ANTES de comecar: sem isso ha corrida com o
  // primeiro evento emitido pelo loop.
  const unsub = subscribe(runId, (e) => emitRunEvent(out, e, { verbose: ctx.verbose }));
  out.event('start', {
    command: config.mode,
    runId,
    ...(guards.claim ? { idempotencyKey: guards.claim.key } : {}),
  });
  out.info(`run ${runId} — ${config.mode}`);

  let record: RunRecord;
  try {
    record = await runToCompletion(config, ctx.apiKey, {
      ...prepareOptsFor(config, ctx.apiKey, { runId, ctx: { signal } }),
      parentLedger: guards.root,
    });
  } finally {
    unsub();
  }

  relatorioFinal(out, record);
  return runOutcome(out, record, {
    ...(guards.claim ? { idempotency: { key: guards.claim.key, reused: false } } : {}),
    dailyCapReached: guards.machine.capHit,
  });
}

async function runTraining(
  ctx: NetworkContext,
  config: RunConfig,
  signal: AbortSignal,
  guards: SpendGuards,
): Promise<number> {
  const { out } = ctx;
  const cfg = config as TrainingConfig;
  let unsubSession = (): void => undefined;
  const unsubRuns: (() => void)[] = [];
  let sessionId = '';

  const record: SessionRecord = await trainToCompletion(cfg, ctx.apiKey, {
    signal,
    parentLedger: guards.root,
    onSession: (id) => {
      sessionId = id;
      // O id da sessao so nasce aqui: grava no lock e no registro da key
      // (quem se anexar le a sessao por ele).
      guards.lock?.update({ sessionId: id });
      if (guards.claim) {
        guards.claim = { ...guards.claim, sessionId: id };
        updateIdempotency(guards.dataDir, guards.claim);
      }
      guards.machine.setLabel(`train sessão ${id}`);
      out.event('start', {
        command: 'train',
        sessionId: id,
        ...(guards.claim ? { idempotencyKey: guards.claim.key } : {}),
      });
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

  return sessionOutcome(out, record, sessionId || record.id, {
    ...(guards.claim ? { idempotency: { key: guards.claim.key, reused: false } } : {}),
    dailyCapReached: guards.machine.capHit,
  });
}
