// `agents` — a superfície CLI do MODO AGENTE (Agent Arena, plano §22).
//
// Subcomandos:
//   doctor   [--deep] [--container] [--config <arq>] [--json]   pré-voo do executor (pi) + canário de sala limpa
//   run      --config <arq> --budget .. roda a arena até o fim (+ --dry-run)
//   show     <runId> [--json]           record (loadRun) + execução via store
//   list     [--json]                   varre <dataDir>/agent-runs/<runId>
//   logs     <runId> --stage N --contestant <id> [--rep N] [--what ...]
//   replay   <runId> --stage N --contestant <id> [--rep N]
//   reconcile <runId> [--generations] [--json]  custo medido (proxy) × derivado × cobrado (§20.4, IMPL-035)
//   gc       [--older-than 30d] [--dry-run]
//
// Contrato de saída idêntico ao resto do CLI: stdout é PAYLOAD, stderr é narração.
// A regra de ouro: NENHUM destes comandos interfere nos comandos existentes de
// chat — isto é um arquivo novo, e `index.ts` só ganha um `case` + um bloco de HELP.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { runToCompletion } from '../../orchestrator.js';
import { prepareOptsFor } from '../../prepareRun.js';
import { parseArenaAgentConfig } from '../../configFile.js';
import { arenaAgentConfigToRunConfig } from '../../arenaConfig.js';
import { estimateInputFromConfig, estimateRunCost } from '../../estimate.js';
import { runPreflight, type PreflightOpts } from '../../agent/doctor.js';
import { agentVerdictTreeVersionOf, classifyStop } from '../../agent/verdictTree.js';
import { defaultPiImageTag } from '../../agent/container.js';
import {
  COST_FIDELITY_TOLERANCE,
  reconcileGenerations,
  summarizeProxyCostLog,
  type GenerationReconciliation,
} from '../../agent/costProxy.js';
import { getGateway } from '../../openrouter.js';
import {
  agentRunsRoot,
  execDir,
  readArtifact,
  readExecutionRef,
} from '../../agent/store.js';
import { loadRun, getDataDir } from '../../storage.js';
import { subscribe } from '../../events.js';
import {
  buildContext,
  isAgentContext,
  loadCatalog,
  parse,
  readJsonFile,
  resolveKey,
  tryResolveKey,
  type LoadedCatalog,
} from '../context.js';
import { budgetRequiredError, budgetUsdOf, keyRequirement, toRefusal, type BudgetChoice } from '../preflight.js';
import { CliError, EXIT, failAndExit, fmtUsd, isCliError, renderSpend } from '../output.js';
import { emitRunEvent } from '../ndjson.js';
import { openSpendGuards, spendGuardRefusals, type SpendGuards } from '../spendGuards.js';
import type { RunRecord, RunConfig, OpenRouterModel } from '../../types.js';
import type { AgentRunnerConfig, ExecutionRef } from '../../agent/types.js';

/** Versão pinada do executor `pi` (plano §22/§26). Divergência => doctor falha. */
const EXPECTED_PI_VERSION = '0.84.2';
/** Modelo usado no canário real (`--deep`). Barato, usado UMA vez. */
const DEFAULT_CANARY_MODEL = 'google/gemini-2.5-flash';
/** Default do `--what` em `logs`. */
const DEFAULT_WHAT = 'dossier';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function n(v: unknown, campo: string): number | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const x = Number(v);
  if (!Number.isFinite(x)) throw new CliError(`${campo} deve ser um número.`, EXIT.USAGE);
  return x;
}

/**
 * `--budget <usd|none>`; ausente e sem TTY => recusa `usage.budget_required`
 * (mesma regra, mesma mensagem e mesmo código do chat — `../preflight.ts`). A
 * recusa em si fica para o chamador: o `--dry-run` a reporta com a estimativa.
 */
function resolveBudget(value: unknown, warn: (m: string) => void): BudgetChoice {
  if (typeof value === 'string' && value.trim()) {
    if (value.trim().toLowerCase() === 'none') return { kind: 'none' };
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) {
      throw new CliError('--budget deve ser um valor em USD maior que zero, ou "none".', EXIT.USAGE, { value }, {
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

/** Lê e valida um `arena-agent-config@1` -> RunConfig (nunca lança por config). */
async function readAgentConfigFile(file: string): Promise<RunConfig> {
  // Leitor comum do CLI: caminho errado = uso (2), JSON quebrado = config (3).
  const json = await readJsonFile(file);
  const parsed = parseArenaAgentConfig(json);
  if (!parsed.ok) throw new CliError(parsed.error, EXIT.CONFIG);
  const conv = arenaAgentConfigToRunConfig(parsed.config);
  if (!conv.ok) throw new CliError(conv.error, EXIT.CONFIG);
  return conv.config;
}

/** Ajusta `config.agent` pelas flags `--repetitions/--max-parallel/--keep-workspace`. */
function applyAgentOverrides(
  config: RunConfig,
  values: Record<string, unknown>,
): RunConfig {
  const reps = n(values.repetitions, '--repetitions');
  const maxPar = n(values['max-parallel'], '--max-parallel');
  const keep = values['keep-workspace'] === true;
  if (reps === undefined && maxPar === undefined && keep === false) return config;
  const agent: AgentRunnerConfig = {
    ...config.agent!,
    ...(reps !== undefined ? { repetitions: reps } : {}),
    ...(maxPar !== undefined ? { maxParallel: maxPar } : {}),
    ...(keep
      ? { isolation: { ...(config.agent?.isolation ?? {}), keepWorkspace: keep } }
      : {}),
  };
  return { ...config, agent };
}

/** Aggregação das execuções de agente da run p/ o `result` (mesma fórmula do ndjson). */
export interface AgentRunSummary {
  executions: number;
  failed: number;
  /** Só canceladas (sinal de controle) — as únicas fora do placar (IMPL-032). */
  incomplete: number;
  /** Cortadas por limite (timeout/maxTurns/maxCost/maxOutput) — contam 'nao'. */
  limitCut: number;
  avgTurns: number;
  avgCostUsd: number;
  oracleRate: number;
  /** Versão da árvore de veredito (1 = legado: corte por limite fora do denominador). */
  verdictTreeVersion?: number;
  /** IMPL-033: reps com falha do juiz após 2 retentativas (nota ficou com o oráculo). */
  judgeErrors?: number;
  /** IMPL-033: reps sem veredito (execução inválida / juiz falho sem oráculo). */
  unscoredReps?: number;
}

function buildAgentSummary(record: RunRecord): AgentRunSummary | undefined {
  const exes = record.stages
    .flatMap((s) => s.responses)
    .filter(
      (r): r is typeof r & { execution: NonNullable<typeof r['execution']> } =>
        Boolean(r.execution),
    );
  if (exes.length === 0) return undefined;
  let failed = 0;
  let incomplete = 0;
  let limitCut = 0;
  let turnsSum = 0;
  let costSum = 0;
  let oraclePassed = 0;
  let oracleTotal = 0;
  for (const r of exes) {
    turnsSum += r.execution.turns;
    costSum += r.costUsd;
    const cls = classifyStop(r.execution.stopReason);
    if (cls === 'error') failed += 1;
    else if (cls === 'limit') limitCut += 1;
    else if (cls === 'cancelled') incomplete += 1;
    if (r.execution.oracle) {
      oraclePassed += r.execution.oracle.passed;
      oracleTotal += r.execution.oracle.passed + r.execution.oracle.failed;
    }
  }
  return {
    executions: exes.length,
    failed,
    incomplete,
    limitCut,
    avgTurns: turnsSum / exes.length,
    avgCostUsd: costSum / exes.length,
    oracleRate: oracleTotal > 0 ? oraclePassed / oracleTotal : 0,
    verdictTreeVersion: agentVerdictTreeVersionOf(record),
    ...(record.agentJudgeErrorCount !== undefined ? { judgeErrors: record.agentJudgeErrorCount } : {}),
    ...(record.agentUnscoredRepsByContestant
      ? { unscoredReps: Object.values(record.agentUnscoredRepsByContestant).reduce((a, n) => a + n, 0) }
      : {}),
  };
}

function firstAgentError(record: RunRecord): string | undefined {
  for (const s of record.stages) {
    for (const r of s.responses) {
      if (r.status === 'error' && r.errorMsg) return `${s.index}/${r.contestantId}: ${r.errorMsg}`;
    }
  }
  return record.error;
}

/** Código de saída do desfecho — 130/7/1/6/0 (o 6 é o INCONCLUSIVE do IMPL-004). */
function exitFor(record: RunRecord, summary: AgentRunSummary | undefined): number {
  if (record.stoppedReason === 'cancelled') return EXIT.SIGINT;
  if (record.budgetExhausted || record.stoppedReason === 'budget') return EXIT.BUDGET;
  // Todas as execuções de agente falharam por infra/processo => resultado-lixo
  // com cara de sucesso; é EXIT.ERROR com a mensagem do primeiro erro (§22).
  if (summary && summary.executions > 0 && summary.failed === summary.executions) {
    return EXIT.ERROR;
  }
  if (record.status === 'error') return EXIT.ERROR;
  // IMPL-004: terminou, mas a evidencia nao sustenta conclusao.
  if (record.status === 'inconclusive') return EXIT.INCONCLUSIVE;
  return EXIT.OK;
}

/** Constrói um ExecutionRef válido (só `.dir` importa p/ leitura) dado runId/etapa/rep. */
function refFor(
  runId: string,
  stageIndex: number,
  contestantId: string,
  repetition: number,
): ExecutionRef {
  return {
    execId: '',
    repetition,
    dir: execDir(runId, stageIndex, contestantId, repetition),
    turns: 0,
    toolCalls: 0,
    durationMs: 0,
    stopReason: 'completed',
  };
}

/** Resolve um dir relativo sob agentRunsRoot() e valida que não escapa (path traversal, §21.6). */
function resolveUnderAgentRuns(refDir: string): string {
  const root = path.resolve(agentRunsRoot());
  const abs = path.resolve(getDataDir(), refDir);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new CliError(`ExecutionRef.dir escapa de agent-runs: ${refDir}`, EXIT.USAGE);
  }
  return abs;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

/**
 * O isolamento que o `agents doctor` verifica. Com `--config`, o sandbox DAQUELA
 * run: `isolation.image`/`runtime` do arquivo (e a imagem default da
 * `executorVersion` dele). Sem isso, o "ok" — inclusive o do canário, cacheado
 * por imagem/runtime — seria de OUTRO sandbox (imagem default, runc) enquanto a
 * run usaria outra imagem ou o gVisor. `--container` sozinho = imagem default.
 */
export function doctorIsolation(config: RunConfig | undefined, containerFlag: boolean): PreflightOpts['isolation'] {
  const iso = config?.agent?.isolation;
  if (config && (iso?.kind === 'container' || containerFlag)) {
    return {
      kind: 'container',
      image: iso?.image ?? defaultPiImageTag(config.agent?.executorVersion ?? EXPECTED_PI_VERSION),
      ...(iso?.runtime ? { runtime: iso.runtime } : {}),
    };
  }
  return containerFlag ? { kind: 'container' } : undefined;
}

async function cmdDoctor(argv: string[]): Promise<number> {
  const parsed = parse(argv, {
    deep: { type: 'boolean' },
    model: { type: 'string' },
    container: { type: 'boolean' },
    config: { type: 'string', short: 'c' },
  });
  const ctx = buildContext(parsed);
  const { out, values } = ctx;
  const deep = values.deep === true;

  const isolation = doctorIsolation(
    typeof values.config === 'string' ? await readAgentConfigFile(values.config) : undefined,
    values.container === true,
  );
  const containerMode = isolation?.kind === 'container';

  // runDir temporário para o doctor (salary: cria doctor-proj/doctor-home).
  let runDir = '';
  try {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-agent-doctor-'));
  } catch {
    // se o /tmp não deixar, cai no dataDir — só para o `dfGb` ter um caminho
    runDir = path.join(getDataDir(), 'doctor-tmp');
  }

  // key só entra no canário REAL (--deep), via ambiente; nunca por flag. Sem
  // key, `--deep` não tem como afirmar isolamento => EXIT.AUTH (plano §21/§22).
  let apiKey = '';
  if (deep) {
    try {
      apiKey = await resolveKey(values);
    } catch (err) {
      throw new CliError(
        `--deep exige a key do OpenRouter no ambiente (OPENROUTER_API_KEY): ${(err as Error).message}`,
        EXIT.AUTH,
        isCliError(err) ? err.details : undefined,
        { code: 'auth.key_missing', hint: isCliError(err) ? err.hint : undefined },
      );
    }
  }
  const model = typeof values.model === 'string' && values.model.trim() ? values.model.trim() : DEFAULT_CANARY_MODEL;

  out.info(
    `doctor (nível ${deep ? 'profundo — canário REAL' : 'rápido'}${containerMode ? ' · modo container' : ''}, esperado pi ${EXPECTED_PI_VERSION})…`,
  );
  const preflight = await runPreflight({
    expectedVersion: EXPECTED_PI_VERSION,
    runDir,
    apiKey,
    model,
    cacheKey: deep ? `pi-v${EXPECTED_PI_VERSION}:${model}` : undefined,
    isolation,
  });

  if (!preflight.ok) {
    // Sala suja/versão errada (ou modo container sem Docker CLI/imagem) =>
    // EXIT.CONFIG (3). O detalhe vai nos `details`.
    throw new CliError(
      `Sala do modo agente NÃO está pronta: ${preflight.errors.join('; ')}`,
      EXIT.CONFIG,
      { preflight },
    );
  }

  if (out.isText) {
    out.line(
      `ok — pi ${preflight.pi.version ?? '?'}${preflight.pi.expected ? ` (esperado ${preflight.pi.expected})` : ''} · git ${preflight.git ? 'presente' : 'AUSENTE'} · disco ${preflight.diskFreeGb.toFixed(1)} GB`,
    );
    // Modo container: ecoa o estado do Docker (presente + imagem ok/ausente).
    const d = preflight.docker;
    if (d) {
      if (d.imagePresent) {
        // O digest é o que a run usa (a tag só serve para achá-lo) — IMPL-036.
        out.line(`· docker ok (${d.image}${d.digest ? ` → ${d.digest}` : ''})`);
      } else {
        out.warn(`· docker ${d.present ? '' : 'CLI AUSENTE — '}imagem '${d.image ?? '?'}' ausente`);
      }
    }
    // Rota de inferência medida DENTRO do sandbox (IMPL-037): relay → proxy, key fora, egress.
    const route = preflight.inferenceRoute;
    if (route?.ok) {
      const egress = route.egressBlocked === null ? 'egress ABERTO (válvula bridge)' : 'egress bloqueado';
      out.line(`· rota de inferência ok (proxy local via socket; key fora do sandbox; ${egress})`);
    }
    for (const e of preflight.errors) out.warn(e);
  }
  out.result(true, 'agents.doctor', { preflight });
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function cmdRun(argv: string[]): Promise<number> {
  const parsed = parse(argv, {
    config: { type: 'string', short: 'c' },
    budget: { type: 'string' },
    'dry-run': { type: 'boolean' },
    repetitions: { type: 'string' },
    'max-parallel': { type: 'string' },
    'keep-workspace': { type: 'boolean' },
    // IMPL-031 (revisão): réplica intencional da mesma config, sem o lock.
    'allow-concurrent': { type: 'boolean' },
  });
  const ctx = buildContext(parsed);
  const { out, values } = ctx;

  const file = values.config;
  if (typeof file !== 'string') {
    throw new CliError('Uso: prompt-builder agents run --config <arena-agent-config.json>', EXIT.USAGE);
  }
  const config = await readAgentConfigFile(file);
  const budget = resolveBudget(values.budget, (m) => out.warn(m));
  const budgetUsd = budgetUsdOf(budget);
  const configComOrcamento: RunConfig = {
    ...config,
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
  };

  // --dry-run: valida, estima COM o catálogo (público sem key — IMPL-029; antes
  // saía sem catálogo e a estimativa dava $0) e espelha as recusas da execução
  // real de agentes: orçamento ausente fora de TTY, lock da mesma config e teto
  // diário esgotado (recusas, na ordem da real — IMPL-031) e key ausente
  // (pré-condição em `requires`). Nada é gasto.
  if (values['dry-run'] === true) {
    const apiKey = await tryResolveKey(values);
    let catalog: LoadedCatalog | null = null;
    try {
      catalog = await loadCatalog(ctx, apiKey);
    } catch (err) {
      if (!isCliError(err)) throw err;
      // A execução de agentes não recusa por catálogo — aqui é só aviso.
      out.warn(`sem catálogo (${err.message}) — preços dos papéis de LLM saem 0 na estimativa.`);
    }
    const est = estimateRunCost(estimateInputFromConfig(configComOrcamento), catalog?.models ?? []);
    const guardas = spendGuardRefusals({
      dataDir: ctx.dataDir,
      config: applyAgentOverrides(configComOrcamento, values),
      lock: values['allow-concurrent'] !== true,
    });
    const wouldRefuse = [
      ...(budget.kind === 'missing' ? [toRefusal(budgetRequiredError())] : []),
      ...guardas.map(toRefusal),
    ];
    const requires = apiKey ? [] : [keyRequirement()];
    const resumo = {
      dryRun: true,
      estimate: est,
      wouldRefuse,
      requires,
      checks: {
        catalog: catalog
          ? { source: catalog.catalogSource, scope: catalog.catalogScope, models: catalog.models.length }
          : null,
        key: apiKey ? 'present' : 'missing',
      },
    };
    if (out.isText) {
      out.line(JSON.stringify(configComOrcamento, null, 2));
      out.line();
      out.line(`Custo estimado: ${fmtUsd(est.low)} – ${fmtUsd(est.high)}`);
      for (const r of wouldRefuse) out.line(`  RECUSARIA  ${r.code} — ${r.message.split('\n')[0]}`);
      for (const r of requires) out.line(`  REQUER     ${r.code} — ${r.message}`);
    }
    const primeira = wouldRefuse[0];
    if (primeira) {
      throw new CliError(primeira.message, primeira.exit, resumo, {
        code: primeira.code,
        hint: primeira.hint ?? undefined,
      });
    }
    out.result(true, 'agents.run.dry-run', { config: configComOrcamento, ...resumo });
    return EXIT.OK;
  }

  if (budget.kind === 'missing') throw budgetRequiredError();

  // execução real: precisa da key (EXIT.AUTH quando ausente).
  let apiKey = '';
  try {
    apiKey = await resolveKey(values);
  } catch (err) {
    throw new CliError(
      `Exige a key do OpenRouter (OPENROUTER_API_KEY ou \`key set\`): ${(err as Error).message}`,
      EXIT.AUTH,
      isCliError(err) ? err.details : undefined,
      { code: 'auth.key_missing', hint: isCliError(err) ? err.hint : undefined },
    );
  }

  const runConfigComFlags = applyAgentOverrides(configComOrcamento, values);

  // Catálogo para a reserva otimista do ledger da máquina (sem ele a reserva
  // por chamada vale 0 e o teto diário só pega DEPOIS do gasto).
  let modelos: OpenRouterModel[] = [];
  try {
    modelos = (await loadCatalog(ctx, apiKey)).models;
  } catch (err) {
    if (!isCliError(err)) throw err;
    out.warn(`sem catálogo (${err.message}) — a reserva do teto diário por chamada fica em 0.`);
  }

  // Ctrl-C: primeiro aborta com elegância (a run finaliza/salva e imprime o
  // parcial), segundo mata. Mesmo padrão do chat (run.ts).
  const ac = new AbortController();

  // IMPL-031 (revisão): a run de agentes passa pelas MESMAS camadas do
  // compare/vary/train — teto diário da máquina somando processos (ledger em
  // arquivo, via parentLedger) e lock por config (`run.locked`). Recusa aqui,
  // antes de gastar (e antes de armar o handler de Ctrl-C).
  const guards: SpendGuards = openSpendGuards({
    dataDir: ctx.dataDir,
    config: runConfigComFlags,
    command: 'agents run',
    models: modelos,
    signal: ac.signal,
    lock: values['allow-concurrent'] !== true,
    warn: (m) => out.warn(m),
  });

  let interrupts = 0;
  const onSigint = (): void => {
    interrupts += 1;
    if (interrupts === 1) {
      out.warn('interrompendo… (Ctrl-C de novo para sair na hora)');
      ac.abort('SIGINT');
      return;
    }
    failAndExit(
      out,
      'agents.run',
      new CliError('Interrompido (2º Ctrl-C): saída imediata, sem esperar a run fechar.', EXIT.SIGINT, undefined, {
        code: 'control.interrupted',
      }),
    );
  };
  process.on('SIGINT', onSigint);

  let record: RunRecord;
  try {
    const runId = randomUUID();
    const unsub = subscribe(runId, (e) => emitRunEvent(out, e, { verbose: ctx.verbose }));
    out.info(`agents run ${runId} — ${runConfigComFlags.mode}`);
    try {
      guards.lock?.update({ runId });
      guards.machine.setLabel(`agents run ${runId}`);
      record = await runToCompletion(runConfigComFlags, apiKey, {
        ...prepareOptsFor(runConfigComFlags, apiKey, { runId, ctx: { signal: ac.signal } }),
        parentLedger: guards.parentLedger,
      });
    } finally {
      unsub();
    }
  } finally {
    process.off('SIGINT', onSigint);
    guards.close();
  }

  const summary = buildAgentSummary(record);

  if (out.isText) {
    for (const l of renderSpend(record.costByRole, record.totalCostUsd, record.budgetUsd, record.costAccuracy)) {
      out.line(l);
    }
    if (record.budgetExhausted) out.line(`Parou em   ${record.stoppedAtPhase ?? '?'} — orçamento esgotado`);
    if (summary) {
      out.line(
        `Agentes    ${summary.executions} execuções · ${summary.failed} falhas · ` +
          `${summary.limitCut} cortadas por limite (contam 'nao') · ${summary.incomplete} canceladas · ` +
          `média ${summary.avgTurns.toFixed(1)} turnos · ${fmtUsd(summary.avgCostUsd)} · oráculo ${(summary.oracleRate * 100).toFixed(0)}%` +
          (summary.judgeErrors ? ` · ${summary.judgeErrors} falha(s) do juiz (nota do oráculo)` : '') +
          (summary.unscoredReps ? ` · ${summary.unscoredReps} sem veredito (fora do placar)` : ''),
      );
    }
  }
  const resumo = {
    runId: record.id,
    status: record.status,
    totalCostUsd: record.totalCostUsd,
    budgetExhausted: Boolean(record.budgetExhausted),
    // ok:true com exit 7/130 = parcial; o motivo explicito evita ler o exit code.
    stoppedReason: record.stoppedReason ?? null,
    stoppedAtPhase: record.stoppedAtPhase,
    standings: record.standings,
    judgeScoreByContestant: record.judgeScoreByContestant,
    ...(summary ? { agentSummary: summary } : {}),
    // A run parou (ou foi barrada) pelo teto DIÁRIO da máquina, não pelo --budget.
    ...(guards.machine.capHit ? { dailyCapReached: true } : {}),
  };
  const code = exitFor(record, summary);
  // Falha sai SÓ pelo envelope de erro (resumo em `details`) — antes saía um
  // `result` ok:false E depois o erro: dois objetos no stdout (IMPL-028).
  if (code === EXIT.ERROR) {
    const todasFalharam = summary && summary.executions > 0 && summary.failed === summary.executions;
    throw new CliError(
      todasFalharam
        ? `A run terminou mas TODAS as execuções de agente falharam: ${firstAgentError(record) ?? 'sem detalhes'}. ` +
            'É problema de infra/credencial, não de qualidade — corrija e rode de novo.'
        : (record.error ?? 'run de agentes falhou'),
      EXIT.ERROR,
      resumo,
      {
        code: todasFalharam ? 'agents.all_executions_failed' : 'run.failed',
        hint: `Rode \`prompt-builder agents doctor --deep\` e veja \`prompt-builder agents show ${record.id} --json\`.`,
      },
    );
  }
  // IMPL-004 × IMPL-028: inconclusiva (6) também sai pelo envelope — há
  // resultado (em `details`), mas ele não sustenta conclusão.
  if (code === EXIT.INCONCLUSIVE) {
    throw new CliError(
      `Run de agentes ${record.id} inconclusiva: ${(record.verdictIntegrity?.reasons ?? []).join('; ') || 'o resultado não sustenta conclusão'}.`,
      code,
      resumo,
      {
        code: 'run.inconclusive',
        hint: `Não promova com base nela; veja \`prompt-builder agents show ${record.id} --json\` (verdictIntegrity, failureCountByRole).`,
      },
    );
  }
  out.result(true, 'agents.run', resumo);
  return code;
}

// ---------------------------------------------------------------------------
// show / list
// ---------------------------------------------------------------------------

async function cmdShow(argv: string[]): Promise<number> {
  const parsed = parse(argv, {});
  const ctx = buildContext(parsed);
  const { out } = ctx;
  const id = parsed.positionals[0];
  if (!id) throw new CliError('Uso: prompt-builder agents show <runId> [--json]', EXIT.USAGE);
  const record = await loadRun(id);
  if (!record) throw new CliError(`Run de agente "${id}" não encontrada em ${getDataDir()}.`, EXIT.USAGE);

  const execs = record.stages
    .flatMap((s) =>
      s.responses
        .filter((r) => r.execution)
        .map((r) => ({ stageIndex: s.index, contestantId: r.contestantId, execution: r.execution })),
    )
    .map((x) => ({
      stageIndex: x.stageIndex,
      contestantId: x.contestantId,
      repetition: x.execution!.repetition,
      stopReason: x.execution!.stopReason,
      turns: x.execution!.turns,
      toolCalls: x.execution!.toolCalls,
      oracle: x.execution!.oracle,
      dir: x.execution!.dir,
    }));

  if (out.isText) {
    out.line(`${record.id}  ${record.status}  ${record.mode}`);
    out.line(`tema: ${record.config.theme}`);
    out.line(`etapas: ${record.stages.length} · contestants: ${record.contestants.length}`);
    for (const l of renderSpend(record.costByRole, record.totalCostUsd, record.budgetUsd, record.costAccuracy)) out.line(l);
    out.line();
    out.line(`execuções de agente: ${execs.length}`);
    for (const e of execs) {
      const orc = e.oracle ? ` oráculo ${e.oracle.score}` : '';
      out.line(`  etapa ${String(e.stageIndex).padStart(2)}  ${e.contestantId}  rep${e.repetition}  ${e.stopReason.padEnd(10)} ${e.turns} turnos${orc}`);
    }
  }
  out.result(true, 'agents.show', { run: record, executions: execs });
  return EXIT.OK;
}

/** "Manifest simples": varre <dataDir>/agent-runs/<runId> — não usa listRuns (que é de chat). */
async function scanAgentRunDirs(): Promise<
  { runId: string; stages: number; files: number; sizeBytes: number; mtimeMs: number }[]
> {
  const root = agentRunsRoot();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const outList: { runId: string; stages: number; files: number; sizeBytes: number; mtimeMs: number }[] = [];
  for (const e of entries) {
    const abs = path.join(root, e);
    let st: { sizeBytes: number; mtimeMs: number };
    try {
      const s = await fs.stat(abs);
      if (!s.isDirectory()) continue;
      st = { sizeBytes: s.size, mtimeMs: s.mtimeMs };
    } catch {
      continue;
    }
    const stagesDir = path.join(abs, 'stages');
    let stages = 0;
    let files = 0;
    let size = st.sizeBytes;
    try {
      const stagesEntries = await fs.readdir(stagesDir);
      stages = stagesEntries.length;
      for (const se of stagesEntries) {
        size += (await sizeOfDir(path.join(stagesDir, se))).size;
      }
    } catch {
      /* run sem stages (interrompida cedo) */
    }
    files = await countFiles(abs);
    outList.push({ runId: e, stages, files, sizeBytes: size, mtimeMs: st.mtimeMs });
  }
  outList.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return outList;
}

async function sizeOfDir(dir: string): Promise<{ size: number }> {
  let size = 0;
  try {
    for (const e of await fs.readdir(dir)) {
      const abs = path.join(dir, e);
      const s = await fs.stat(abs);
      if (s.isDirectory()) size += (await sizeOfDir(abs)).size;
      else size += s.size;
    }
  } catch {
    /* ignora */
  }
  return { size };
}

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  try {
    for (const e of await fs.readdir(dir)) {
      const abs = path.join(dir, e);
      const s = await fs.stat(abs);
      n += s.isDirectory() ? await countFiles(abs) : 1;
    }
  } catch {
    /* ignora */
  }
  return n;
}

async function cmdList(argv: string[]): Promise<number> {
  const parsed = parse(argv, {});
  const ctx = buildContext(parsed);
  const { out } = ctx;
  const rows = await scanAgentRunDirs();
  if (out.isText) {
    for (const r of rows) {
      out.line(
        `${r.runId}  ${new Date(r.mtimeMs).toISOString().slice(0, 19).replace('T', ' ')}  ${String(r.stages).padStart(2)} etapas  ${fmtBytes(r.sizeBytes).padStart(8)}  ${r.files} arquivos`,
      );
    }
    if (rows.length === 0) out.info(`nenhuma run de agente em ${agentRunsRoot()}`);
  }
  const list = rows.map((r) => ({
    runId: r.runId,
    stages: r.stages,
    files: r.files,
    sizeBytes: r.sizeBytes,
    mtime: new Date(r.mtimeMs).toISOString(),
  }));
  out.result(true, 'agents.list', { runs: list });
  return EXIT.OK;
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}B`;
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

/** Nome de artefato (allowlist do store) por valor de `--what`. */
const WHAT_ARTIFACT: Record<string, string> = {
  dossier: 'dossier.md',
  diff: 'workspace.diff',
  trajectory: 'trajectory.json',
  events: 'events.jsonl',
  stderr: 'stderr.log',
  oracle: 'oracle.json',
};

async function cmdLogs(argv: string[]): Promise<number> {
  const parsed = parse(argv, {
    stage: { type: 'string' },
    contestant: { type: 'string' },
    rep: { type: 'string' },
    what: { type: 'string' },
  });
  const ctx = buildContext(parsed);
  const { out } = ctx;
  const runId = parsed.positionals[0];
  const stageIndex = n(parsed.values.stage, '--stage');
  const contestantId = parsed.values.contestant;
  if (!runId) throw new CliError('Uso: prompt-builder agents logs <runId> --stage N --contestant <id> [--what …]', EXIT.USAGE);
  if (stageIndex === undefined) throw new CliError('--stage N é obrigatório.', EXIT.USAGE);
  if (typeof contestantId !== 'string' || !contestantId.trim()) {
    throw new CliError('--contestant <id> é obrigatório.', EXIT.USAGE);
  }
  const rep = n(parsed.values.rep, '--rep') ?? 0;
  const what = typeof parsed.values.what === 'string' && parsed.values.what.trim() ? parsed.values.what.trim() : DEFAULT_WHAT;

  const ref = refFor(runId, stageIndex, contestantId.trim(), rep);

  if (what === 'session') {
    // `--what session` imprime o transcript da sessão: arquivos sob <execDir>/session/.
    const abs = path.join(resolveUnderAgentRuns(ref.dir), 'session');
    let names: string[];
    try {
      names = (await fs.readdir(abs)).filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      throw new CliError(
        `Sessão não encontrada para ${runId} etapa ${stageIndex} contestante ${contestantId} rep ${rep} (esperava ${abs}).`,
        EXIT.ERROR,
      );
    }
    if (names.length === 0) {
      throw new CliError(`Nenhum arquivo de sessão sob ${abs}.`, EXIT.ERROR);
    }
    for (const name of names) {
      out.raw(`\n===== session/${name} =====\n`);
      const content = await fs.readFile(path.join(abs, name), 'utf-8');
      out.raw(content);
      if (!content.endsWith('\n')) out.raw('\n');
    }
    return EXIT.OK;
  }

  const artifact = WHAT_ARTIFACT[what];
  if (!artifact) {
    throw new CliError(
      `--what deve ser um de: dossier, diff, trajectory, events, session, stderr, oracle (recebi "${what}").`,
      EXIT.USAGE,
    );
  }
  const content = await readArtifact(ref, artifact);
  if (content === null) {
    throw new CliError(
      `Artefato "${what}" não encontrado para ${runId} etapa ${stageIndex} contestante ${contestantId} rep ${rep} em ${path.join(getDataDir(), ref.dir)}.`,
      EXIT.ERROR,
    );
  }
  // stdout é PAYLOAD: o artefato vai inteiro, sem formatação extra.
  out.raw(content);
  if (!content.endsWith('\n')) out.raw('\n');
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

async function cmdReplay(argv: string[]): Promise<number> {
  const parsed = parse(argv, {
    stage: { type: 'string' },
    contestant: { type: 'string' },
    rep: { type: 'string' },
  });
  const ctx = buildContext(parsed);
  const { out } = ctx;
  const runId = parsed.positionals[0];
  const stageIndex = n(parsed.values.stage, '--stage');
  const contestantId = parsed.values.contestant;
  const rep = n(parsed.values.rep, '--rep') ?? 0;
  if (!runId || stageIndex === undefined || typeof contestantId !== 'string' || !contestantId.trim()) {
    throw new CliError(
      'Uso: prompt-builder agents replay <runId> --stage N --contestant <id> [--rep N]',
      EXIT.USAGE,
    );
  }
  const ref = refFor(runId, stageIndex, contestantId.trim(), rep);
  const exec = await readExecutionRef(ref);
  if (!exec) {
    throw new CliError(
      `exec.json não encontrado para ${runId} etapa ${stageIndex} contestante ${contestantId} rep ${rep} em ${path.join(getDataDir(), ref.dir)}.`,
      EXIT.ERROR,
    );
  }

  const inv = exec.invocation;
  // NUNCA imprimir a key: o env do invocation já vem redigido NA ESCRITA (store.ts).
  const cmdline = [inv.executor.bin, ...inv.argv].join(' ');
  if (out.isText) {
    out.line(`executor   ${inv.executor.id} ${inv.executor.version}`);
    out.line(`bin        ${inv.executor.bin}`);
    out.line();
    out.line('comando EXATO (para reproduzir à mão):');
    out.line(cmdline);
    out.line();
    out.line('env (redigido):');
    for (const [k, v] of Object.entries(inv.env)) out.line(`  ${k}=${v}`);
    out.line();
    out.line(`cwd: ${inv.cwd}`);
    out.line(`stdin sha256: ${inv.stdinSha256}`);
  } else {
    out.result(true, 'agents.replay', {
      runId,
      stageIndex,
      contestantId,
      repetition: rep,
      executor: inv.executor,
      argv: inv.argv,
      env: inv.env,
      cwd: inv.cwd,
      stdinSha256: inv.stdinSha256,
    });
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// reconcile — §20.4 + IMPL-035
// ---------------------------------------------------------------------------
//
// Fecha a conta do custo de modo agente. Três números, lado a lado:
//   - DERIVADO: o que cada execução registrou na resposta (hoje = o medido,
//     quando a execução passou pelo proxy; o do executor, quando não);
//   - MEDIDO: a soma do `usage.cost` que o proxy de custo leu do último chunk SSE
//     de CADA chamada do agente (`inference-proxy.jsonl`, uma linha por chamada,
//     com o id de geração do OpenRouter);
//   - COBRADO (`--generations`): o `total_cost` que o OpenRouter lançou para cada
//     id de geração (`GET /generation`, leitura de auditoria — não é chamada de
//     LLM). Fidelidade exigida: |medido − cobrado| ≤ 2% por run (R-14b REC-2).
// Histórico (2026-08-23): o `responseId` que o PI reporta (`gen-<unix>-…`) dava
// 404 em `/generation`; os ids que o proxy lê vêm do PROVEDOR (`gen-<24>`), que é
// o formato documentado.
async function cmdReconcile(argv: string[]): Promise<number> {
  const parsed = parse(argv, { generations: { type: 'boolean' } });
  const ctx = buildContext(parsed);
  const { out } = ctx;
  const runId = parsed.positionals[0];
  if (!runId) {
    throw new CliError('Uso: prompt-builder agents reconcile <runId> [--generations] [--json]', EXIT.USAGE);
  }
  const record = await loadRun(runId);
  if (!record) {
    throw new CliError(`Run de agente "${runId}" não encontrada em ${getDataDir()}.`, EXIT.USAGE);
  }

  // Soma o custo registrado por execução (resposta de cada contestant de agente).
  let derivedExecutionUsd = 0;
  let executions = 0;
  for (const s of record.stages) {
    for (const r of s.responses) {
      if (r.execution && typeof r.costUsd === 'number') {
        derivedExecutionUsd += r.costUsd;
        executions += 1;
      }
    }
  }
  // totalCostUsd já embute as execuções + os demais papéis (juiz/gabarito/…).
  const totalUsd = typeof record.totalCostUsd === 'number' ? record.totalCostUsd : 0;

  // MEDIDO: o log do proxy de custo da run (uma linha `exchange` por chamada).
  const logFile = path.join(agentRunsRoot(), runId, 'inference-proxy.jsonl');
  const logText = await fs.readFile(logFile, 'utf8').catch(() => undefined);
  const measured = logText !== undefined ? summarizeProxyCostLog(logText) : undefined;

  // COBRADO: só com --generations (usa a key; leitura de auditoria, não gasta).
  let billing: GenerationReconciliation | undefined;
  if (parsed.values.generations === true) {
    if (!measured || measured.generationIds.length === 0) {
      throw new CliError(
        `Sem ids de geração no log do proxy (${logFile}) — nada a conferir com o OpenRouter.`,
        EXIT.USAGE,
      );
    }
    const apiKey = await resolveKey(parsed.values);
    billing = await reconcileGenerations(measured, { baseUrl: getGateway().config.baseUrl, apiKey });
  }

  const aviso = measured
    ? billing
      ? !billing.fidelity.withinTolerance
        ? `medido × cobrado fora da tolerância de ${COST_FIDELITY_TOLERANCE * 100}%`
        : !billing.complete
          ? `${billing.notFound + billing.errors} geração(ões) sem lançamento conferível no OpenRouter (404 pode ser transitório: rode de novo em alguns minutos)`
          : undefined
      : 'custo MEDIDO pelo proxy (usage.cost); confira com a fatura via --generations'
    : `log do proxy de custo ausente (${logFile}) — run anterior ao IMPL-035: custo permanece derivado (source 'catalog'/'agent-derived')`;

  if (out.isText) {
    out.line(`reconcile ${record.id}  ${record.status}  ${record.mode}`);
    out.line(`execuções de agente: ${executions}`);
    out.line(`custo registrado nas execuções: ${fmtUsd(derivedExecutionUsd)}`);
    if (measured) {
      out.line(
        `custo MEDIDO pelo proxy: ${fmtUsd(measured.usd)} em ${measured.calls} chamada(s) ` +
          `(${measured.exact} com usage.cost · ${measured.estimated} catálogo · ${measured.unknown} desconhecido · ` +
          `${measured.refused} recusada(s) pelo freio)`,
      );
    }
    if (billing) {
      out.line(
        `COBRADO pelo OpenRouter: ${fmtUsd(billing.billedUsd)} (${billing.found} geração(ões) conferida(s), ` +
          `${billing.notFound} não encontrada(s), ${billing.errors} erro(s))`,
      );
      out.line(
        `fidelidade: |medido − cobrado| = ${fmtUsd(billing.fidelity.diffUsd)} ` +
          `(${(billing.fidelity.relative * 100).toFixed(2)}%) — ${billing.fidelity.withinTolerance ? 'OK' : 'FORA'} (≤ ${COST_FIDELITY_TOLERANCE * 100}%)`,
      );
    }
    out.line(`custo total da run (totalCostUsd): ${fmtUsd(totalUsd)}`);
    if (aviso) out.warn(aviso);
  }
  out.result(true, 'agents.reconcile', {
    runId,
    // Conciliada = toda geração do log foi conferida E a fidelidade ficou na tolerância.
    reconciled: billing !== undefined && billing.complete && billing.fidelity.withinTolerance,
    available: measured !== undefined,
    executions,
    derivedExecutionUsd,
    totalCostUsd: totalUsd,
    ...(measured
      ? {
          measured: {
            usd: measured.usd,
            calls: measured.calls,
            exact: measured.exact,
            estimated: measured.estimated,
            unknown: measured.unknown,
            refused: measured.refused,
            generationIds: measured.generationIds.length,
          },
        }
      : {}),
    ...(billing ? { billing } : {}),
    ...(aviso ? { note: aviso } : {}),
  });
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// gc
// ---------------------------------------------------------------------------

/** Interpreta `30d|7d|2w|48h` -> ms. Default 30 dias. */
function olderThanMs(value: unknown): number {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : '30d';
  const m = /^(\d+)\s*(d|w|h)$/.exec(raw);
  if (!m) throw new CliError(`--older-than deve ser algo como "30d", "2w" ou "48h" (recebi "${raw}").`, EXIT.USAGE);
  const n = Number(m[1]);
  const mult = m[2] === 'd' ? 86_400_000 : m[2] === 'w' ? 7 * 86_400_000 : 3_600_000;
  return n * mult;
}

async function cmdGc(argv: string[]): Promise<number> {
  const parsed = parse(argv, { 'older-than': { type: 'string' }, 'dry-run': { type: 'boolean' } });
  const ctx = buildContext(parsed);
  const { out } = ctx;
  const thresholdMs = olderThanMs(parsed.values['older-than']);
  const cutoff = Date.now() - thresholdMs;
  const dry = parsed.values['dry-run'] === true;

  const rows = await scanAgentRunDirs();
  const eligible = rows.filter((r) => r.mtimeMs < cutoff);

  let freedBytes = 0;
  for (const r of eligible) {
    const abs = path.join(agentRunsRoot(), r.runId);
    if (dry) {
      out.line(`[dry-run] apagaria ${r.runId} (${fmtBytes(r.sizeBytes)})`);
      continue;
    }
    try {
      await fs.rm(abs, { recursive: true, force: true });
      freedBytes += r.sizeBytes;
      out.info(`apagou ${r.runId} (${fmtBytes(r.sizeBytes)})`);
    } catch (err) {
      throw new CliError(`Não consegui apagar ${abs}: ${(err as Error).message}`, EXIT.ERROR);
    }
  }
  if (dry) out.info(`daría para liberar ${fmtBytes(eligible.reduce((a, r) => a + r.sizeBytes, 0))} em ${eligible.length} run(s).`);
  out.result(true, 'agents.gc', {
    dryRun: dry,
    cutoff: new Date(cutoff).toISOString(),
    removed: dry ? 0 : eligible.length,
    eligible: eligible.map((r) => ({ runId: r.runId, sizeBytes: r.sizeBytes })),
    freedBytes,
  });
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

export async function cmdAgents(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : undefined;
  const rest = sub ? argv.slice(1) : argv;
  switch (sub) {
    case 'doctor':
      return cmdDoctor(rest);
    case 'run':
      return cmdRun(rest);
    case 'show':
      return cmdShow(rest);
    case 'list':
      return cmdList(rest);
    case 'logs':
      return cmdLogs(rest);
    case 'replay':
      return cmdReplay(rest);
    case 'reconcile':
      return cmdReconcile(rest);
    case 'gc':
      return cmdGc(rest);
    default:
      throw new CliError(
        `Subcomando desconhecido de "agents": "${sub ?? ''}". Use um de: doctor, run, show, list, logs, replay, reconcile, gc.`,
        EXIT.USAGE,
      );
  }
}