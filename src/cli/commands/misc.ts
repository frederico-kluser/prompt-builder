// Comandos menores: `key`, `estimate`, `runs`, `sessions`, `techniques`,
// `lgpd`, `config`, `registry`, `doctor`.

import { promises as fs, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  ensurePrivateDataDir,
  listRuns,
  loadRun,
  listSessions,
  loadSession,
  getDataDir,
  setDataDir,
  sweepOrphanRecords,
  writePrivateDataFile,
} from '../../storage.js';
import { LOCKLESS_ORPHAN_AFTER_MS } from '../../jobs.js';
import { recordTelemetryEvent } from './telemetry.js';
import { runsCancel, runsStatus, runsWait } from './runsJobs.js';
import { runsResume } from './runsResume.js';
import { isValidRecordId } from '../../pathSafety.js';
import { z } from 'zod';
import { listTechniques } from '../../techniques.js';
import { allowlistHealth, getLgpdData, isSensitiveArea, PII_COVERAGE, PII_MODES } from '../../lgpd.js';
import { parseRunConfig, runConfigSchema } from '../../runConfigSchema.js';
import {
  parseArenaConfig,
  arenaConfigSummary,
  arenaConfigSchema,
  ARENA_CONFIG_FORMAT,
  isArenaAgentConfigFormat,
} from '../../configFile.js';
import { loadAgentConfigFile } from './agents.js';
import { arenaConfigToRunConfig } from '../../arenaConfig.js';
import { estimateInputFromConfig, estimateRunCost, formatAssumptions, formatRoleBreakdown } from '../../estimate.js';
import { exampleRegistryJson, parseRegistry, validateRegistry } from '../../registry.js';
import { sampleSizeWarning } from '../../engine/judgeCalibration.js';
import {
  contestantRepetitionReports,
  formatIterationGate,
  formatPairCoverage,
  formatPowerPlan,
  formatRepetitionReport,
  formatRunCompleteness,
  formatSignificance,
  formatSignificanceOrigin,
  planPower,
  runCompleteness,
  type ContestantRepetitionReport,
} from '../../stats.js';
import {
  convergenceReasonText,
  sessionConfirmationText,
  sessionRecommendationOf,
} from '../../engine/sessionDecision.js';
import { plannedTrainingStages, trainingPromotionPower } from '../../engine/trainingPolicy.js';
import { judgeScaleWarning } from '../../engine/verdictAggregate.js';
import { winnerFromStandings } from '../../engine/duelCore.js';
import { groupVerdictFailures, verdictFailuresFromStages } from '../../refJudge.js';
import { replayRun, replayUnsupportedReason } from '../replay.js';
import { buildReproduceArtifact, buildRunArtifact, configFileForRun } from '../../runArtifact.js';
import {
  assertKnownSubcommand,
  assertNoPositionals,
  assertNoUnknownConfigKeys,
  buildCatalogContext,
  buildContext,
  buildNetworkContext,
  checkKey,
  keyFilePath,
  limitList,
  loadCatalog,
  parse,
  parseListLimit,
  resolveHome,
  readJsonFile,
  removeStoredKey,
  resolveKey,
  writeStoredKey,
} from '../context.js';
import { CliError, EXIT, fmtUsd, renderSpend, toCliError, type Output } from '../output.js';
import type { KeyInfo } from '../../openrouter.js';
import { DEFAULT_DAILY_CAP_USD, readDailySnapshot, resolveDailyCap } from '../spendLedger.js';
import { listRunLocks } from '../runLock.js';
import {
  evaluateHandoffGuards,
  normalizeOverrideReason,
  type HandoffGuardReport,
} from '../../engine/handoffGuards.js';
import {
  appendHandoffAudit,
  buildHandoffAuditEntry,
  ensureHandoffAuditWritable,
  handoffAuditPath,
  overrideTrailers,
  type HandoffAuditEntry,
} from '../handoff.js';
import type { RunRecord, SessionRecord } from '../../types.js';
import { buildSessionReport, renderSessionReportMarkdown } from '../../engine/sessionReport.js';
import { renderSessionReportHtml } from '../../engine/sessionReportHtml.js';
import { readConfigFile, resolveArenaLibrary, type LibraryCuration } from './run.js';
import { loadPilot } from '../pilot.js';
import {
  approvalTrailers,
  buildPromptApproval,
  PROMPT_APPROVAL_FORMAT,
  assertCleanApprover,
  recordDirOutsideRepo,
  resolveApprover,
  writePromptApproval,
  type PromptApproval,
} from '../approval.js';
import {
  importRecords,
  retentionSweep,
  runsDelete,
  runsExportExchange,
  runsPrune,
  sessionsDelete,
  sessionsExportExchange,
} from '../records.js';

/**
 * Veredito + confirmação da sessão (IMPL-046/IMPL-050): o objeto ESTÁVEL de
 * recomendação (com recusa honesta quando a evidência não decide) e o texto de
 * confirmação do campeão contra sobreajuste — a MESMA saída no CLI e na UI.
 */
function sessionDecisionOf(record: SessionRecord): {
  confirmation: string;
  recommendation: ReturnType<typeof sessionRecommendationOf>;
} {
  // IMPL-050: "validado" só com holdout forte que RODOU e CONFIRMOU (sem
  // regressão, p do próprio holdout ≤ 0,05); sem holdout, a frase traz o motivo.
  const confirmation = sessionConfirmationText(record);
  // Fonte única com a TrainingView (braços rotulados, nunca `holdout-control`).
  const recommendation = sessionRecommendationOf(record);
  return { confirmation, recommendation };
}

/**
 * Relatório de REPETIÇÃO de `runs show` (IMPL-054, R-04:REC-7): por contestant
 * com reps, ICC + design effect + nEfetivo (repetição não é observação
 * independente) e pass@k (estimador não enviesado de Chen) + pass^k, ambos com
 * a regra de sucesso EXPLÍCITA. Mesma fonte para o texto E o payload JSON — o
 * `--json` nunca fica sem o diagnóstico que o texto mostra. Sem repetição não há
 * nada a reportar (`null`).
 */
function repetitionReportOf(record: RunRecord): {
  repeats: number;
  contestants: ContestantRepetitionReport[];
  lines: string[];
} | null {
  const mFlat =
    record.config.mode === 'compare' ? Math.max(1, Math.round(record.config.repeats ?? 1)) : 1;
  const mAgent = record.config.agent
    ? Math.max(1, Math.round(record.config.agent.repetitions ?? 1))
    : 1;
  if (mFlat <= 1 && mAgent <= 1) return null;
  const contestants = contestantRepetitionReports(record.stages, record.contestants, {
    repeatsPerScenario: mFlat,
  });
  const lines: string[] = [
    `repetições (m=${Math.max(mFlat, mAgent)}): repetição ≠ observação independente — o par analítico é o cenário`,
  ];
  for (const rep of contestants) {
    lines.push(`  ${rep.label}:`);
    for (const l of formatRepetitionReport(rep.diagnostics, rep.pass)) lines.push(`    ${l}`);
    const sens = rep.sensitivity;
    lines.push(
      `    sensibilidade (${sens.ruleDefinition}): pass@${sens.k}=${(sens.passAtK * 100).toFixed(1)}% · pass^${sens.k}=${(sens.passK * 100).toFixed(1)}%`,
    );
  }
  return { repeats: Math.max(mFlat, mAgent), contestants, lines };
}

// --- key ---------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf-8').trim();
}

const KEY_SUBS = ['check', 'path', 'rm', 'set'] as const;

export async function cmdKey(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'check';
  // cli#13: ANTES de parse/rede — `key remove` validava a key no OpenRouter.
  assertKnownSubcommand('key', sub, KEY_SUBS, {
    usage: 'key check | key path | key rm | key set --stdin',
    aliases: { remove: 'rm', delete: 'rm', del: 'rm', unset: 'rm', show: 'path', validate: 'check', add: 'set' },
  });
  const parsed = parse(sub === argv[0] ? argv.slice(1) : argv, { stdin: { type: 'boolean' } });
  const ctx = buildContext(parsed);
  const { out } = ctx;

  if (sub === 'path') {
    out.line(keyFilePath());
    out.result(true, 'key.path', { path: keyFilePath() });
    return EXIT.OK;
  }

  if (sub === 'rm') {
    await removeStoredKey();
    out.info('key removida.');
    out.result(true, 'key.rm', {});
    return EXIT.OK;
  }

  if (sub === 'set') {
    // Exigir --stdin fora de um terminal e uma protecao real: uma key em argv
    // entra no historico do shell E na transcricao do proprio agente.
    if (parsed.values.stdin !== true) {
      throw new CliError(
        'Use `prompt-builder key set --stdin` e mande a key pela entrada padrão — ' +
          'passar a key como argumento a deixaria no histórico do shell.',
        EXIT.USAGE,
      );
    }
    const key = await readStdin();
    if (!key) throw new CliError('Nada recebido na entrada padrão.', EXIT.USAGE);
    const info = await checkKey(key);
    const file = await writeStoredKey(key);
    out.info(`key válida, gravada em ${file}`);
    out.result(true, 'key.set', { path: file, ...info });
    return EXIT.OK;
  }

  // check
  const net = await buildNetworkContext(parsed);
  const info = await checkKey(net.apiKey);
  if (out.isText) {
    out.line(`key válida${info.label ? ` (${info.label})` : ''}`);
    if (typeof info.usageUsd === 'number') out.line(`  uso        ${fmtUsd(info.usageUsd)}`);
    if (info.limitUsd != null) out.line(`  limite     ${fmtUsd(info.limitUsd)}`);
    if (info.limitRemainingUsd != null) out.line(`  disponível ${fmtUsd(info.limitRemainingUsd)}`);
    if (info.isFreeTier) out.line('  tier       gratuito (limites de rate dominam o custo)');
    out.line(`  catálogo   ${net.models.length} modelos (${net.catalogSource})`);
  }
  out.result(true, 'key.check', { ...info, models: net.models.length });
  return EXIT.OK;
}

// --- estimate ----------------------------------------------------------------

export async function cmdEstimate(argv: string[]): Promise<number> {
  const parsed = parse(argv, {
    config: { type: 'string', short: 'c' },
    // IMPL-050: σd calibrado por um piloto GRAVADO (IC95% medido), não pela tabela.
    'pilot-run': { type: 'string' },
    'pilot-session': { type: 'string' },
  });
  assertNoPositionals(
    'estimate',
    parsed.positionals,
    'prompt-builder estimate --config <arq> [--pilot-run <runId> | --pilot-session <id>]',
  );
  const file = parsed.values.config;
  if (typeof file !== 'string') {
    throw new CliError('Uso: prompt-builder estimate --config <arquivo.json>', EXIT.USAGE, undefined, {
      code: 'usage.missing_flag',
      hint: 'Passe `--config <arquivo.json>` (`prompt-builder config example -o arena.json` gera um).',
    });
  }
  // Mesma leitura do `vary/evolve --config` (inclui `scenarios.from: 'library'`,
  // a checagem de labelSet dos itens e o aviso de chave descontinuada) — e
  // ANTES da rede: config inválida sai com exit 3 sem baixar o catálogo. O
  // data-dir (onde mora a biblioteca) é fixado antes, como o buildContext faria.
  setDataDir(resolveHome(parsed.values));
  // Estimar não executa nada: config de modo agente é aceita (só roda pelo portão).
  const config = await readConfigFile(file, {}, { inspectOnly: true });
  // O piloto é disco local: recusa (id errado, IC ausente) ANTES da rede.
  const pilot = await loadPilot(parsed.values);
  // Estimar e ler preco do catalogo PUBLICO: nao exige key (IMPL-029).
  const ctx = await buildCatalogContext(parsed);
  const { out } = ctx;

  const est = estimateRunCost(estimateInputFromConfig(config), ctx.models);
  // IMPL-050/IMPL-054: poder e desenho de amostra junto do custo — estimar
  // dinheiro sem estimar poder produz run cara que não decide nada.
  const power = planPower({
    n: config.stages,
    ...(pilot ? { pilotCi95Pp: pilot.ci95Pp, pilotN: pilot.n } : {}),
  });
  // web-live#5: no treino, o gate da melhor de K precisa CONSEGUIR promover.
  const trainingPower =
    config.mode === 'training'
      ? trainingPromotionPower({
          stages: plannedTrainingStages(config),
          holdoutRatio: config.holdoutRatio,
          techniques: config.techniqueIds?.length,
        })
      : undefined;
  const reps =
    config.mode === 'compare'
      ? Math.max(1, Math.round(config.repeats ?? 1))
      : Math.max(1, Math.round(config.agent?.repetitions ?? 1));
  if (out.isText) {
    out.line(`Estimativa: ${fmtUsd(est.low)} – ${fmtUsd(est.high)}`);
    out.line();
    // cli#11: em training o teto por papel é POR ITERAÇÃO (e o rótulo diz isso).
    for (const l of formatRoleBreakdown(est, config.mode, fmtUsd)) out.line(l);
    out.line();
    out.line('Poder (IMPL-050):');
    for (const l of formatPowerPlan(power)) out.line(`  ${l}`);
    if (pilot) {
      const par = pilot.championId ? ` — ${pilot.championId} × ${pilot.controlId}` : '';
      out.line(
        `  piloto: ${pilot.source === 'run' ? 'run' : 'sessão'} ${pilot.id}${par} (IC95% [${pilot.ci95Pp[0].toFixed(1)}; ${pilot.ci95Pp[1].toFixed(1)}] p.p., n=${pilot.n}${pilot.pOrigin ? `, p de ${pilot.pOrigin}` : ''})`,
      );
    }
    if (trainingPower?.message) out.warn(`poder do gate: ${trainingPower.message}`);
    if (config.stages <= 5) {
      out.warn(
        `modo econômico (stages=${config.stages}): com n=${power.n} só se detectam efeitos ≥ ${power.deltaDetectavelPp.toFixed(1)} p.p. (poder 80%, α=0,05 unilateral) — suba --stages para decidir Δ menores`,
      );
    }
    out.line();
    out.line('Amostra — cenários × repetições (IMPL-054):');
    out.line(
      `  ICC>0,3 (faixa típica de tarefas agênticas: 0,30–0,77) → repetições agregam pouco: prefira MAIS CENÁRIOS a mais reps`,
    );
    out.line(
      `  design effect DE=1+(m−1)·ICC: com m=${reps} e ICC=0,5, o nEfetivo é ${(reps / (1 + (reps - 1) * 0.5)).toFixed(2)}× o n de cenários (reps não dobram o n)`,
    );
    out.line();
    out.line('Premissas:');
    // cli#11/IMPL-050: `range` (objeto) sai resumido, nunca `[object Object]`.
    for (const l of formatAssumptions(est.assumptions)) out.line(l);
    if (est.unpricedModelIds.length) {
      out.warn(`sem preço no catálogo: ${est.unpricedModelIds.join(', ')}`);
    }
    if (est.unknownPriceModelIds.length) {
      out.warn(`preço variável (fora da estimativa): ${est.unknownPriceModelIds.join(', ')}`);
    }
  }
  out.result(true, 'estimate', {
    estimate: est,
    power,
    ...(trainingPower ? { trainingPower } : {}),
    ...(pilot ? { pilot } : {}),
    sample: { stages: config.stages, repeats: reps, economicMode: config.stages <= 5 },
    catalog: { source: ctx.catalogSource, scope: ctx.catalogScope, models: ctx.models.length },
  });
  return EXIT.OK;
}

// --- runs / sessions ---------------------------------------------------------

const RUNS_SUBS = [
  'list',
  'show',
  'winner',
  'status',
  'wait',
  'cancel',
  // IMPL-081: retoma a run parada sem pagar de novo o que está no journal.
  'resume',
  'reproduce',
  'export',
  'import',
  'delete',
  'prune',
] as const;

/** Parece um id de record (e não um verbo)? — para a dica `runs show <id>`. */
const pareceId = (x: string): boolean => isValidRecordId(x) && (/\d/.test(x) || x.length >= 16);

export async function cmdRuns(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'list';
  // cli#13: antes `runs delete <id>` caía no `runs show` (exit 0, nada apagado).
  assertKnownSubcommand('runs', sub, RUNS_SUBS, {
    usage: `runs ${RUNS_SUBS.join('|')} (ver \`prompt-builder runs --help\`)`,
    aliases: { rm: 'delete', remove: 'delete', del: 'delete', get: 'show', ls: 'list', gc: 'prune' },
    hint: (x) => (pareceId(x) ? `Para ver a run, use \`prompt-builder runs show ${x}\`.` : undefined),
  });
  const parsed = parse(sub === argv[0] ? argv.slice(1) : argv, {
    limit: { type: 'string' },
    // IMPL-092: --all devolve a lista inteira (o default tem teto de 50).
    all: { type: 'boolean' },
    status: { type: 'string' },
    'prompt-only': { type: 'boolean' },
    out: { type: 'string', short: 'o' },
    timeout: { type: 'string' },
    reason: { type: 'string' },
    // IMPL-117: `runs reproduce <id> --replay` re-pontua a run gravada a US$ 0.
    replay: { type: 'boolean' },
    // IMPL-089: `runs export --format exchange` (prompt-builder-exchange@1).
    format: { type: 'string' },
    // IMPL-089: `runs import --overwrite` substitui registro conflitante.
    overwrite: { type: 'boolean' },
    // IMPL-100: `runs prune [--older-than 30d] [--dry-run]`.
    'older-than': { type: 'string' },
    'dry-run': { type: 'boolean' },
    // IMPL-081: `runs resume <id> [--budget <usd>|none]` (teto da continuação).
    budget: { type: 'string' },
  });
  const ctx = buildContext(parsed);
  const { out } = ctx;

  // IMPL-030: acompanhamento de runs longas (`--detach` ou outro shell).
  if (sub === 'status') return runsStatus(ctx);
  if (sub === 'wait') return runsWait(ctx);
  if (sub === 'cancel') return runsCancel(ctx);
  if (sub === 'resume') return runsResume(ctx);

  // IMPL-100: apagamento de verdade (record + resíduos) e o TTL sob demanda.
  if (sub === 'delete') return runsDelete(out, parsed.positionals);
  if (sub === 'prune') return runsPrune(out, parsed.values);
  // IMPL-089: pacote prompt-builder-exchange@1 (runs e sessões, verbatim).
  if (sub === 'import') {
    return importRecords(out, 'runs.import', parsed.positionals[0], { overwrite: parsed.values.overwrite === true });
  }

  if (sub === 'list') {
    // IMPL-100: TTL ligado por default — a lista nunca mostra o que já venceu.
    await retentionSweep(out);
    // IMPL-030: run 'running' cujo processo dono morreu (SIGKILL do host) sai
    // como 'aborted' — a lista nunca mostra 'running' para sempre.
    await sweepOrphanRecords({ locklessAfterMs: LOCKLESS_ORPHAN_AFTER_MS });
    let rows = await listRuns();
    if (typeof parsed.values.status === 'string') {
      rows = rows.filter((r) => r.status === parsed.values.status);
    }
    const total = rows.length;
    // IMPL-092: teto default de 50 (--limit N / --all; truncar avisa no stderr).
    rows = limitList(rows, parseListLimit(parsed.values), out, 'runs');
    if (out.isText) {
      for (const r of rows) {
        out.line(
          `${r.id}  ${r.status.padEnd(8)} ${r.mode.padEnd(9)} ${fmtUsd(r.totalCostUsd).padStart(9)}  ${r.theme.slice(0, 48)}`,
        );
      }
      if (rows.length === 0) out.info('nenhuma run em ' + getDataDir());
    }
    out.result(true, 'runs.list', { runs: rows, total });
    return EXIT.OK;
  }

  const id = parsed.positionals[0];
  if (!id) throw new CliError(`Uso: prompt-builder runs ${sub} <id>`, EXIT.USAGE);
  // IMPL-024: id fora do formato nem chega ao disco (e não é ecoado).
  if (!isValidRecordId(id)) throw new CliError('Id de run inválido: use o id listado em `prompt-builder runs list`.', EXIT.USAGE);
  // Argumento solto nunca é ignorado em silêncio (cli#13, mesmo critério do
  // `assertNoPositionals`): `runs show <id> <extra>` descartava o extra e o
  // agente achava que o comando o levara em conta (left#10).
  const extrasRuns = parsed.positionals.slice(1);
  if (extrasRuns.length) {
    throw new CliError(
      `Argumento inesperado para "runs ${sub}": "${extrasRuns[0]}" — o comando leva só o id da run.`,
      EXIT.USAGE,
      { command: `runs ${sub}`, positionals: extrasRuns },
      { code: 'usage.unexpected_argument', hint: `Use: \`prompt-builder runs ${sub} <id>\`.` },
    );
  }
  await sweepOrphanRecords({ only: { kind: 'run', id }, locklessAfterMs: LOCKLESS_ORPHAN_AFTER_MS });
  const record = await loadRun(id);
  // IMPL-024: sem caminho absoluto do data dir no erro (o id já passou pela regex)
  if (!record) {
    throw new CliError(
      `Run "${id}" não encontrada no diretório de dados (confira \`prompt-builder runs list\` e --data-dir).`,
      EXIT.USAGE,
    );
  }

  if (sub === 'reproduce' && parsed.values.replay === true) {
    // IMPL-117 (R-07b:REC-5): re-pontua as respostas GRAVADAS com o pipeline de
    // hoje, a US$ 0 (gateway de replay — nenhuma chamada sai para a rede).
    const motivo = replayUnsupportedReason(record);
    if (motivo) throw new CliError(`Replay indisponível: ${motivo}`, EXIT.USAGE);
    out.info(`replay da run ${record.id}: re-pontuando as respostas gravadas (sem rede, US$ 0)…`);
    const { replay, comparison, calls } = await replayRun(record);
    const payload = {
      runId: record.id,
      identical: comparison.identical,
      costUsd: replay.totalCostUsd,
      calls,
      scenarios: comparison.scenarios,
      judgeScoreOriginal: comparison.judgeScoreOriginal,
      judgeScoreReplay: comparison.judgeScoreReplay,
      mismatches: comparison.mismatches,
    };
    if (out.isText) {
      out.line(`replay: ${calls} chamada(s) respondidas do record · custo $${replay.totalCostUsd} · ${comparison.scenarios} cenário(s)`);
      for (const [id, nota] of Object.entries(comparison.judgeScoreOriginal)) {
        out.line(`  ${id.padEnd(28)} original ${nota.toFixed(1)} · replay ${comparison.judgeScoreReplay[id]?.toFixed(1) ?? '—'}`);
      }
      out.line(comparison.identical ? 'ok: judge-score idêntico em 100% dos cenários.' : 'DIVERGIU:');
      for (const m of comparison.mismatches.slice(0, 20)) out.line(`  [${m.what}] ${m.detail}`);
    }
    if (!comparison.identical) {
      // Drift de PONTUAÇÃO (agregação/regra do judge-score/finais) — o mesmo
      // código de saída do gate de contrato (`baseline check`).
      throw new CliError(
        `Replay divergiu da run gravada em ${comparison.mismatches.length} ponto(s): ${comparison.mismatches[0]?.detail ?? ''}`,
        EXIT.CONFIG,
        payload,
        {
          code: 'config.replay_mismatch',
          hint: 'O binário de hoje pontua as respostas gravadas de outro jeito — compare as versões antes de comparar notas.',
        },
      );
    }
    out.result(true, 'runs.reproduce.replay', payload);
    return EXIT.OK;
  }

  if (sub === 'reproduce') {
    // Reprodutibilidade: o config equivalente ao da run salva + o comando EXATO
    // para re-rodá-la. A vista arena-config@1 vem junto no --json (o `config` é
    // a fonte de verdade lossless — ver src/runArtifact.ts).
    const art = buildReproduceArtifact(record);
    if (out.isText) {
      // IMPL-092: JSON compacto por padrão (--pretty formata).
      out.line(out.json(art.config));
      out.line();
      out.line(`Comando sugerido (grave o JSON acima em ${configFileForRun(record.id)}):`);
      out.line(`  ${art.suggestedCommand}`);
    }
    out.result(true, 'runs.reproduce', {
      runId: art.runId,
      config: art.config,
      arenaConfig: art.arenaConfig,
      suggestedCommand: art.suggestedCommand,
    });
    return EXIT.OK;
  }

  if (sub === 'export') {
    const formato = typeof parsed.values.format === 'string' ? parsed.values.format.trim() : 'artifact';
    if (formato !== 'artifact' && formato !== 'exchange') {
      throw new CliError(
        `--format deve ser "artifact" ou "exchange" (recebi "${formato}").`,
        EXIT.USAGE,
        { flag: '--format', value: formato, accepted: ['artifact', 'exchange'] },
        {
          code: 'usage.invalid_flag_value',
          hint: 'artifact (default) é o artefato auditável; exchange é o pacote reimportável sem perda (`runs import`).',
        },
      );
    }
    if (formato === 'exchange') {
      // IMPL-089: o record VERBATIM (campo desconhecido incluso) — `runs import`
      // num data-dir novo devolve exatamente o mesmo record.
      const alvoEx =
        typeof parsed.values.out === 'string' && parsed.values.out.trim() ? parsed.values.out.trim() : undefined;
      return runsExportExchange(out, record.id, alvoEx);
    }
    // Artefato auto-contido: record + etapas com gabaritos + system prompts +
    // vereditos do juiz — auditável/reproduzível sem o disco original.
    const artifact = buildRunArtifact(record);
    // IMPL-092: JSON compacto por padrão (--pretty formata).
    const texto = `${out.json(artifact)}\n`;
    const alvo =
      typeof parsed.values.out === 'string' && parsed.values.out.trim()
        ? parsed.values.out.trim()
        : undefined;
    if (alvo) {
      await fs.writeFile(alvo, texto, 'utf-8');
      out.info(`artefato gravado em ${alvo}`);
    } else if (out.isText) {
      out.raw(texto);
    }
    // left#10: a auditoria (bloco `audit` do artefato) também narrada no stderr.
    const { judgeContract, itemReviewQueue, needsHumanReview } = artifact.audit;
    if (judgeContract?.line) out.info(judgeContract.line);
    if (itemReviewQueue.length || needsHumanReview.length) {
      out.info(
        `revisão humana do gabarito: ${itemReviewQueue.length} item(ns) saturado(s) + ` +
          `${needsHumanReview.length} na fila needs-human-review (audit no artefato)`,
      );
    }
    out.result(true, 'runs.export', { runId: record.id, file: alvo ?? null, artifact });
    recordTelemetryEvent('runs.export', ctx.dataDir); // IMPL-120: funil (no-op sem opt-in)
    return EXIT.OK;
  }

  if (sub === 'winner') {
    // cli#1: empate nos duelos NUNCA sai calado — o desempate é o judge-score
    // (a régua que escolheu os finalistas), e o vencedor nunca é "o 1º da
    // lista" (o controle vinha 1º por ordem de cadastro). Re-ordena também os
    // records gravados antes do desempate.
    const w = winnerFromStandings(record);
    const vencedorId = w.contestantId;
    const vencedor = record.contestants.find((c) => c.id === vencedorId);
    const labelDe = (cid: string): string => record.contestants.find((c) => c.id === cid)?.label ?? cid;
    const aviso = w.unresolved
      ? `empate também no desempate (${w.tiedIds.map(labelDe).join(', ')}): o vencedor saiu do sorteio cego, não dos dados — rode mais cenários.`
      : w.tie
        ? `empate nos duelos (${w.tiedIds.map(labelDe).join(', ')}) — desempate por ${w.tieBreak === 'wins' ? 'nº de vitórias' : 'judge-score'}.`
        : undefined;
    if (parsed.values['prompt-only'] === true) {
      // Payload puro no stdout: e o movimento final do fluxo
      // (`… winner <id> --prompt-only > prompt.md`). O empate vai no stderr.
      if (aviso) out.warn(aviso);
      out.raw(vencedor?.systemPrompt ?? '');
      return EXIT.OK;
    }
    if (aviso) out.warn(aviso);
    if (out.isText) {
      const js = vencedorId !== undefined ? record.judgeScoreByContestant?.[vencedorId] : undefined;
      out.line(`vencedor: ${vencedor?.label ?? vencedorId ?? '—'}${typeof js === 'number' ? ` · judge-score ${js.toFixed(1)}` : ''}`);
      out.line(
        `régua: ${w.ruler === 'judge-score' ? 'judge-score' : w.ruler === 'duels+judge-score' ? 'duelos das finais (empate desfeito pelo judge-score)' : 'duelos das finais'}`,
      );
      if (vencedor?.systemPrompt) {
        out.line();
        out.line(vencedor.systemPrompt);
      }
    }
    out.result(true, 'runs.winner', {
      contestantId: vencedorId,
      label: vencedor?.label,
      systemPrompt: vencedor?.systemPrompt,
      ruler: w.ruler,
      tie: w.tie,
      tiedIds: w.tiedIds,
      tieBreak: w.tieBreak,
      unresolved: w.unresolved,
      judgeScore: vencedorId !== undefined ? (record.judgeScoreByContestant?.[vencedorId] ?? null) : null,
    });
    return EXIT.OK;
  }

  // show
  // IMPL-005: n nominal × efetivo SEMPRE visível (runs antigas: recalculado das etapas).
  const completeness = record.completeness ?? runCompleteness(record);
  // IMPL-054: ICC, design effect, nEfetivo e pass@k/pass^k sempre que há
  // repetição (compare `repeats` ou agente `repetitions`) — no texto E no JSON.
  const repeticao = repetitionReportOf(record);
  // IMPL-057: falhas de veredito agrupadas (derivadas das etapas — vale para runs antigas).
  const gruposDeFalha = groupVerdictFailures(verdictFailuresFromStages(record.stages));
  if (out.isText) {
    out.line(`${record.id}  ${record.status}  ${record.mode}`);
    out.line(`tema: ${record.config.theme}`);
    out.line(`etapas: ${record.stages.length} · participantes: ${record.contestants.length}`);
    const labelOf = (cid: string): string => record.contestants.find((c) => c.id === cid)?.label ?? cid;
    for (const l of formatRunCompleteness(completeness, labelOf)) out.line(l);
    for (const l of repeticao?.lines ?? []) out.line(l);
    out.line();
    for (const l of renderSpend(
      record.costByRole,
      record.totalCostUsd,
      record.budgetUsd,
      record.costAccuracy,
      record.costLedger,
    )) {
      out.line(l);
    }
    // F4.2/F4.4 — diagnostico do juiz e orientacao de amostra: o que faz a
    // comparacao entre sessoes ser (ou nao) confiavel, junto do resultado.
    const diag = record.judgeDiagnostics;
    if (diag) {
      out.line();
      out.line(`juiz: contrato ${diag.contract.hash.slice(0, 12)} (${diag.contract.modelIds.join(', ')})`);
      // IMPL-049/IMPL-057: o contrato comparado com a ÚLTIMA run gravada.
      if (diag.contractAudit) out.line(`${diag.contractAudit.changed ? '! ' : ''}${diag.contractAudit.line}`);
      if (diag.verbosity.warning) out.line(`! ${diag.verbosity.warning}`);
    }
    // IMPL-057: falhas de veredito AGRUPADAS por (cenário, categoria, causa) —
    // 'degraded' (painel reduzido) nunca é falha do candidato.
    if (gruposDeFalha.length > 0) {
      const total = gruposDeFalha.reduce((s, g) => s + g.count, 0);
      out.line(`falhas de veredito: ${total} em ${gruposDeFalha.length} grupo(s) (cenário × categoria × causa)`);
      for (const g of gruposDeFalha.slice(0, 4)) {
        out.line(`  ${g.count}× ${g.category}/${g.cause}${g.scenario ? ` — ${g.scenario.slice(0, 60)}` : ''}`);
      }
      if (gruposDeFalha.length > 4) out.line(`  … +${gruposDeFalha.length - 4} grupo(s) no --json`);
    }
    // IMPL-055/IMPL-047: fila needs-human-review; IMPL-112: itens saturados.
    if (record.needsHumanReview?.length) {
      const motivos = [...new Set(record.needsHumanReview.map((i) => i.reason))].join(', ');
      out.line(`! revisão humana: ${record.needsHumanReview.length} item(ns) na fila needs-human-review (${motivos})`);
    }
    if (record.itemSaturation?.reviewQueue.length) {
      const fila = record.itemSaturation.reviewQueue;
      out.line(
        `! saturação: ${fila.length} item(ns) com 100% 'resolve' ou 100% 'nao' em ` +
          `≥${record.itemSaturation.minExecutions} execuções — revise o GABARITO (nunca descarte o item)`,
      );
      // IMPL-112 (left#10): a FILA de revisão humana, item a item (teto de 5 no
      // texto; inteira em --json/`runs export`).
      for (const it of fila.slice(0, 5)) {
        out.line(
          `  ${it.saturated === 'all-nao' ? "100% 'nao'    " : "100% 'resolve'"} ${String(it.executions).padStart(3)} exec · ` +
            `etapa(s) ${it.stageIndexes.join(',')} — ${it.question.replace(/\s+/g, ' ').slice(0, 70)}`,
        );
      }
      if (fila.length > 5) out.line(`  … +${fila.length - 5} item(ns) em --json (itemReviewQueue)`);
    }
    // IMPL-063 / web-live#7 (left#4): o relatório da geração de cenários.
    const dg = record.datagenReport;
    if (dg) {
      out.line(
        `datagen: ${dg.final}/${dg.requested} cenário(s) gerado(s) entregue(s) · descartes: ${dg.dedupedExact} exato(s) + ` +
          `${dg.dedupedSemantic} semântico(s)${dg.droppedVsSeed ? ` (${dg.droppedVsSeed} repetindo o seed)` : ''} · ` +
          `${dg.backfillRounds}/${dg.maxBackfillRounds} reposição(ões)` +
          (dg.semantic ? ` · embeddings ${dg.embedModelId ?? '(injetado)'} (cosseno ${dg.effectiveCosineThreshold})` : ''),
      );
      if (dg.warning) out.line(`! ${dg.warning}`);
      else if (dg.alert) out.line(`! dedup removeu ${(dg.rate * 100).toFixed(0)}% dos gerados — o gerador repete o molde`);
      if (dg.semanticError) out.line(`! embeddings falharam (${dg.semanticError}) — o dedup seguiu só com a passe exata`);
      if (dg.rubricUnanswerable > 0) {
        out.line(`! ${dg.rubricUnanswerable} rubrica(s) exigem fatos ausentes do caso — revise o cenário/contexto`);
      }
    }
    // IMPL-115 (left#4): o modo econômico — quanto foi ao juiz forte e por quê.
    const cc = record.judgeCascade;
    if (cc) {
      const motivos = Object.entries(cc.reasons ?? {})
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}=${n}`)
        .join(' ');
      out.line(
        `modo econômico: ${cc.escalatedVerdicts}/${cc.verdicts} veredito(s) ao juiz forte ` +
          `(${(cc.escalatedFraction * 100).toFixed(0)}%) em ${cc.escalatedStages}/${cc.stages} etapa(s) · ` +
          `baratos ${cc.cheapJudgeIds.join(' + ')} → forte ${cc.strongJudgeId}${motivos ? ` · gatilhos: ${motivos}` : ''}`,
      );
      if (cc.strongFailedStages > 0) {
        out.line(`! o juiz forte falhou em ${cc.strongFailedStages} etapa(s): valeu o consenso dos baratos (degradado)`);
      }
    }
    for (const aviso of record.fairnessWarnings ?? []) out.line(`! ${aviso}`);
    // IMPL-056/068: política dos cenários gravada no início da run (todas as fontes).
    for (const aviso of record.languageWarnings ?? []) out.line(`! idioma: ${aviso}`);
    const adv = record.adversarialCoverage;
    if (adv) {
      out.line(
        `adversarial (${adv.turnLabel}: ASR@1 é limite inferior): ${Object.entries(adv.byCategory)
          .map(([k, v]) => `${k}=${v}`)
          .join('  ')}`,
      );
      if (adv.gaps.length) out.line(`! cobertura adversarial abaixo de ${adv.minPerCategory}/categoria: ${adv.gaps.join(', ')}`);
    }
    // IMPL-019: alertas de ciclo de vida gravados NO INÍCIO da run (30/14/7
    // dias, expirado, ausente). Para o estado de hoje: `baseline check`.
    for (const a of record.modelLifecycle?.alerts ?? []) {
      out.line(`! ciclo de vida (em ${record.modelLifecycle!.capturedAt.slice(0, 10)}): ${a.message}`);
    }
    const escala = judgeScaleWarning(record);
    if (escala) out.line(`! ${escala}`);
    const amostra = sampleSizeWarning(record.stages.length, 'etapas');
    if (amostra) out.line(`! ${amostra}`);
  }
  out.result(true, 'runs.show', {
    run: record,
    completeness,
    // IMPL-054: ICC/design effect/nEfetivo + pass@k/pass^k no payload — o
    // `--json` vê exatamente o que o texto mostra (null sem repetição).
    repetition: repeticao ? { repeats: repeticao.repeats, contestants: repeticao.contestants } : null,
    judgeDiagnostics: record.judgeDiagnostics ?? null,
    // IMPL-057 (left#10): a linha de auditoria do contrato do juiz, explícita.
    judgeContractAudit: record.judgeDiagnostics?.contractAudit ?? null,
    // IMPL-112/IMPL-055 (left#10): as filas de revisão HUMANA do gabarito.
    itemReviewQueue: record.itemSaturation?.reviewQueue ?? [],
    needsHumanReview: record.needsHumanReview ?? [],
    // IMPL-063/IMPL-115 (left#4): relatório da geração e do modo econômico.
    datagenReport: record.datagenReport ?? null,
    judgeCascade: record.judgeCascade ?? null,
    // IMPL-057: falhas agrupadas (cenário × categoria × causa) no mesmo payload do texto.
    verdictFailureGroups: gruposDeFalha,
    fairnessWarnings: record.fairnessWarnings ?? [],
    lifecycleAlerts: record.modelLifecycle?.alerts ?? [],
    // IMPL-007: judge-score de painel em escala antiga (média ordinal inflada).
    judgeScaleWarning: judgeScaleWarning(record) ?? null,
    sampleWarnings: [sampleSizeWarning(record.stages.length, 'etapas')].filter(Boolean),
  });
  return EXIT.OK;
}

// --- handoff versionado (`sessions winner --apply`) ---------------------------
//
// O prompt campeão sai do disco da sessão e entra num arquivo de produção. O
// fluxo NUNCA perde o anterior: backup antes de sobrescrever, diff sempre, e
// qualquer falha de git vira AVISO (o prompt já está salvo — derrubar o
// comando depois disso seria perder o movimento inteiro por causa do enfeite).

/** Resultado do `--apply` (payload do `--json`). */
export interface ApplyReport {
  applied: boolean;
  file: string;
  backup: string | null;
  committed: boolean;
}

type GitResult = { ok: true; out: string } | { ok: false; error: string };

function git(args: string[]): GitResult {
  try {
    return {
      ok: true,
      out: execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }),
    };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return { ok: false, error: (e.stderr ?? e.stdout ?? e.message ?? 'erro desconhecido').trim() };
  }
}

/** `git diff --no-index`: exit 1 = há diferenças (não é erro). */
function gitNoIndexDiff(antes: string, depois: string): GitResult {
  try {
    return {
      ok: true,
      out: execFileSync('git', ['diff', '--no-index', '--', antes, depois], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (err) {
    const e = err as { status?: number; stderr?: string; stdout?: string; message?: string };
    if (e.status === 1 && typeof e.stdout === 'string') return { ok: true, out: e.stdout };
    return { ok: false, error: (e.stderr ?? e.stdout ?? e.message ?? 'erro desconhecido').trim() };
  }
}

/**
 * `git add` + `git commit` SÓ do arquivo aplicado (não arrasta o index alheio).
 * `trailers` (ex.: `Override-Reason:`) viram o último parágrafo da mensagem —
 * o formato que `git interpret-trailers --parse` lê.
 */
function commitAppliedFile(
  file: string,
  sessionId: string,
  out: Output,
  trailers: string[] = [],
  extraFiles: string[] = [],
): boolean {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const top = git(['-C', dir, 'rev-parse', '--show-toplevel']);
  if (!top.ok) {
    out.warn('destino fora de um repositório git — commit pulado.');
    return false;
  }
  // IMPL-088: o registro prompt-approval@1 vai no MESMO commit do prompt.
  const caminhos = [base, ...extraFiles];
  const add = git(['-C', dir, 'add', '--', ...caminhos]);
  if (!add.ok) {
    out.warn(`git add falhou (${add.error}) — commit pulado.`);
    return false;
  }
  const assunto = `prompt: atualiza ${base} (sessão ${sessionId})`;
  const mensagem = trailers.length > 0 ? `${assunto}\n\n${trailers.join('\n')}` : assunto;
  const commit = git(['-C', dir, 'commit', '-m', mensagem, '--', ...caminhos]);
  if (!commit.ok) {
    out.warn(`git commit falhou (${commit.error}) — o prompt já está aplicado em ${file}.`);
    return false;
  }
  return true;
}

/**
 * Erro do gate do handoff (IMPL-027): exit GATE_BLOCKED, `error.code`
 * específico do bloqueio e a evidência inteira em `details`.
 */
function handoffBlockedError(record: SessionRecord, file: string, guards: HandoffGuardReport): CliError {
  const code =
    guards.blocks.length === 1 ? `handoff.${guards.blocks[0].code.replace(/\./g, '_')}` : 'handoff.blocked';
  return new CliError(
    `Handoff bloqueado: ${guards.blocks.map((b) => b.message).join(' ')} Nada foi gravado em ${file}.`,
    EXIT.GATE_BLOCKED,
    {
      sessionId: record.id,
      file,
      applied: false,
      blocks: guards.blocks,
      warnings: guards.warnings,
      holdout: record.holdout ?? null,
      significance: record.significance ?? null,
      judgeDrift: Boolean(record.judgeDrift),
      auditLog: handoffAuditPath(),
    },
    {
      code,
      hint:
        'Não promova este campeão: treine de novo (mais --stages, outro --holdout-ratio) ou mantenha o prompt atual. ' +
        `Se uma pessoa decidiu promover mesmo assim, repita com --override "<motivo>" — o motivo fica gravado em ${handoffAuditPath()}.`,
    },
  );
}

/**
 * Aplica o prompt campeão em `destino`: backup `<destino>.bak-<ISO-ts>` quando o
 * arquivo existe, escrita com `\n` final, diff do que mudou e commit opcional.
 *
 * Exige o laudo do gate e RECUSA antes de qualquer efeito (nem o diretório é
 * criado) quando ele está bloqueado: é o único escritor do handoff, então
 * nenhum caminho futuro aplica um campeão regredido sem passar por aqui.
 */
async function applyPromptFile(
  destino: string,
  prompt: string,
  opts: {
    commit: boolean;
    record: SessionRecord;
    guards: HandoffGuardReport;
    out: Output;
    /** IMPL-088: registro versionado (vai no commit) e os trailers dele. */
    approval?: { file: string | null; trailers: string[] };
  },
): Promise<ApplyReport> {
  const { out } = opts;
  const file = path.resolve(destino);
  if (opts.guards.blocked) throw handoffBlockedError(opts.record, file, opts.guards);
  await fs.mkdir(path.dirname(file), { recursive: true });

  let backup: string | null = null;
  const existia = await fs
    .access(file)
    .then(() => true)
    .catch(() => false);
  if (existia) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backup = `${file}.bak-${ts}`;
    await fs.copyFile(file, backup);
  }

  await fs.writeFile(file, prompt.endsWith('\n') ? prompt : `${prompt}\n`, 'utf-8');

  // Diff no stdout (payload de texto); fora do formato text o report do --json
  // é que carrega o resultado — nada de sujar o JSON com diff.
  if (backup) {
    const diff = gitNoIndexDiff(backup, file);
    if (diff.ok) {
      if (diff.out.trim()) out.line(diff.out.replace(/\n+$/, ''));
    } else {
      out.warn(`não consegui gerar o diff: ${diff.error}`);
    }
  } else {
    out.line('(arquivo criado)');
  }

  const committed = opts.commit
    ? commitAppliedFile(
        file,
        opts.record.id,
        out,
        [...(opts.approval?.trailers ?? []), ...overrideTrailers(opts.guards.override)],
        opts.approval?.file ? [opts.approval.file] : [],
      )
    : false;
  return { applied: true, file, backup, committed };
}

const SESSIONS_SUBS = ['list', 'show', 'winner', 'report', 'export', 'import', 'delete'] as const;

export async function cmdSessions(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'list';
  // Antes um subcomando desconhecido caía em silêncio no `show` (com o nome
  // do subcomando lido como id): o agente achava que rodou outra coisa.
  assertKnownSubcommand('sessions', sub, SESSIONS_SUBS, {
    usage: 'sessions list | show <id> | winner <id> | report <id> | export <id> | import <arq> | delete <id>',
    aliases: { rm: 'delete', remove: 'delete', del: 'delete', get: 'show', ls: 'list' },
    hint: (x) => (pareceId(x) ? `Para ver a sessão, use \`prompt-builder sessions show ${x}\`.` : undefined),
  });
  const parsed = parse(sub === argv[0] ? argv.slice(1) : argv, {
    'prompt-only': { type: 'boolean' },
    limit: { type: 'string' },
    // IMPL-092: --all devolve a lista inteira (o default tem teto de 50).
    all: { type: 'boolean' },
    apply: { type: 'string' },
    commit: { type: 'boolean' },
    override: { type: 'string' },
    // `sessions report`: relatório de ciclos (quanto melhorou × quanto muda o custo).
    html: { type: 'string' },
    markdown: { type: 'string' },
    'calls-per-month': { type: 'string' },
    annotate: { type: 'boolean' },
    // IMPL-089: `sessions export -o <dir|arq.json>` / `sessions import --overwrite`.
    out: { type: 'string', short: 'o' },
    overwrite: { type: 'boolean' },
    // IMPL-100: `sessions delete <id> --keep-runs` preserva as runs da sessão.
    'keep-runs': { type: 'boolean' },
    // IMPL-088: registro prompt-approval@1 versionado no repo (o --commit implica).
    record: { type: 'boolean' },
    // left#9: onde gravar o registro (implica --record); default <repo>/.prompt-approvals/.
    'record-dir': { type: 'string' },
    approver: { type: 'string' },
  });
  const ctx = buildContext(parsed);
  const { out } = ctx;

  if (sub === 'delete') {
    return sessionsDelete(out, parsed.positionals, { keepRuns: parsed.values['keep-runs'] === true });
  }
  if (sub === 'import') {
    return importRecords(out, 'sessions.import', parsed.positionals[0], { overwrite: parsed.values.overwrite === true });
  }

  if (sub === 'list') {
    await retentionSweep(out); // IMPL-100: TTL ligado por default
    await sweepOrphanRecords({ locklessAfterMs: LOCKLESS_ORPHAN_AFTER_MS }); // IMPL-030
    const todas = await listSessions();
    // IMPL-092: teto default de 50 (--limit N / --all; truncar avisa no stderr).
    const rows = limitList(todas, parseListLimit(parsed.values), out, 'sessões');
    if (out.isText) {
      for (const r of rows) {
        out.line(
          `${r.id}  ${r.status.padEnd(8)} ${String(r.iterationsDone).padStart(2)}/${r.iterationsPlanned} it  ${fmtUsd(r.totalCostUsd).padStart(9)}  ${r.theme.slice(0, 40)}`,
        );
      }
    }
    out.result(true, 'sessions.list', { sessions: rows, total: todas.length });
    return EXIT.OK;
  }

  const id = parsed.positionals[0];
  if (!id) throw new CliError(`Uso: prompt-builder sessions ${sub} <id>`, EXIT.USAGE);
  if (!isValidRecordId(id)) throw new CliError('Id de sessão inválido: use o id listado em `prompt-builder sessions list`.', EXIT.USAGE);
  // Argumento solto nunca é ignorado em silêncio (cli#13, mesmo critério do
  // `assertNoPositionals`): `sessions winner <id> --record <caminho>` (o
  // `--record` é booleano) punha o caminho em positional e ele sumia — o
  // registro ia para o default e o usuário achava que escolhera o lugar
  // (left#9). Estes subcomandos levam SÓ o id; o resto é erro de uso com a
  // dica que resolve.
  const extras = parsed.positionals.slice(1);
  if (extras.length) {
    throw new CliError(
      `Argumento inesperado para "sessions ${sub}": "${extras[0]}" — o comando leva só o id da sessão.`,
      EXIT.USAGE,
      { command: `sessions ${sub}`, positionals: extras },
      {
        code: 'usage.unexpected_argument',
        hint:
          sub === 'winner'
            ? 'Para escolher ONDE gravar o registro prompt-approval@1, use `--record-dir <dir>` (o `--record` sozinho grava em <repo>/.prompt-approvals/).'
            : `Use: \`prompt-builder sessions ${sub} <id>\`.`,
      },
    );
  }
  await sweepOrphanRecords({ only: { kind: 'session', id }, locklessAfterMs: LOCKLESS_ORPHAN_AFTER_MS }); // IMPL-030
  const record = await loadSession(id);
  if (!record) throw new CliError(`Sessão "${id}" não encontrada.`, EXIT.USAGE);
  const campeao = record.bestPromptByIteration.at(-1);

  if (sub === 'report') return sessionsReport(record, parsed.values, out);
  if (sub === 'export') {
    const alvo = typeof parsed.values.out === 'string' && parsed.values.out.trim() ? parsed.values.out.trim() : undefined;
    return sessionsExportExchange(out, record.id, alvo);
  }

  if (sub === 'winner') {
    // Handoff versionado: --apply leva o campeão para um arquivo de produção,
    // com backup + diff + commit opcional (ver applyPromptFile acima) — e,
    // desde o IMPL-027, atrás de um GATE: holdout regredido bloqueia (exit
    // GATE_BLOCKED, destino intocado) salvo --override "<motivo>", que fica
    // gravado na trilha de auditoria e no trailer do commit.
    const applyRaw = parsed.values.apply;
    const applyTo = typeof applyRaw === 'string' ? applyRaw.trim() : undefined;
    const wantCommit = parsed.values.commit === true;
    const overrideRaw = parsed.values.override;
    if (typeof applyRaw === 'string' && !applyTo) {
      throw new CliError('--apply exige um caminho de arquivo.', EXIT.USAGE);
    }
    if (parsed.values['prompt-only'] === true && applyTo) {
      throw new CliError('Use --prompt-only OU --apply, nunca os dois.', EXIT.USAGE);
    }
    if (wantCommit && !applyTo) {
      throw new CliError('--commit só faz sentido junto de --apply <arquivo>.', EXIT.USAGE);
    }
    // left#9: `--record-dir <dir>` escolhe ONDE o registro vai (implica --record).
    const recordDirRaw = parsed.values['record-dir'];
    const recordDir = typeof recordDirRaw === 'string' ? recordDirRaw.trim() : undefined;
    if (typeof recordDirRaw === 'string' && !recordDir) {
      throw new CliError('--record-dir exige um diretório.', EXIT.USAGE, { flag: '--record-dir' }, {
        code: 'usage.missing_flag_value',
        hint: 'Ex.: `--record-dir docs/aprovacoes` (relativo ao diretório atual).',
      });
    }
    const wantRecord = parsed.values.record === true || recordDir !== undefined;
    const approverRaw = typeof parsed.values.approver === 'string' ? parsed.values.approver : undefined;
    // Revisão w2: recusa ANTES de qualquer efeito (trilha, destino, commit).
    assertCleanApprover(approverRaw);
    if ((wantRecord || approverRaw !== undefined) && !applyTo) {
      throw new CliError('--record/--record-dir/--approver só fazem sentido junto de --apply <arquivo>.', EXIT.USAGE, undefined, {
        code: 'usage.record_without_apply',
        hint: 'Use `sessions winner <id> --apply <arquivo> --record [--record-dir <dir>] [--approver "Nome <email>"]`.',
      });
    }
    // Com --commit o registro entra no MESMO commit do prompt: fora do repo do
    // destino ele não entraria (o `git add` falharia DEPOIS de aplicar).
    if (applyTo && recordDir !== undefined && wantCommit) {
      const raiz = recordDirOutsideRepo(path.resolve(applyTo), recordDir);
      if (raiz) {
        throw new CliError(
          `--record-dir "${recordDir}" fica fora do repositório do destino (${raiz}): com --commit o registro vai no mesmo commit do prompt.`,
          EXIT.USAGE,
          { flag: '--record-dir', value: recordDir, repo: raiz },
          {
            code: 'usage.record_dir_outside_repo',
            hint: 'Aponte um diretório dentro do repo do destino, ou rode sem --commit (o registro é gravado onde você pediu).',
          },
        );
      }
    }
    if (typeof overrideRaw === 'string' && !applyTo) {
      throw new CliError('--override só faz sentido junto de --apply <arquivo>.', EXIT.USAGE, undefined, {
        code: 'usage.override_without_apply',
        hint: 'Use `sessions winner <id> --apply <arquivo> --override "<motivo>"`.',
      });
    }
    const overrideReason = normalizeOverrideReason(typeof overrideRaw === 'string' ? overrideRaw : null);
    if (typeof overrideRaw === 'string' && !overrideReason) {
      // Motivo vazio não é override: sem isto `--override ""` sobreporia o
      // bloqueio sem justificativa nenhuma.
      throw new CliError('--override exige um motivo não vazio.', EXIT.USAGE, undefined, {
        code: 'usage.override_reason_required',
        hint: 'Diga por que promover mesmo assim: --override "<motivo>" (fica gravado na auditoria e no commit).',
      });
    }
    // O laudo é o mesmo para ver, imprimir e aplicar — só o --apply bloqueia.
    const guards = evaluateHandoffGuards(record, { overrideReason });
    if (parsed.values['prompt-only'] === true) {
      // Payload cru no stdout (costuma ir para `> arquivo`): bloquear aqui
      // truncaria o destino do redirecionamento. Só avisa — o handoff com
      // gate é o --apply.
      for (const i of [...guards.blocks, ...guards.warnings]) out.warn(i.message);
      if (guards.blocks.length > 0) {
        out.warn('--prompt-only não passa pelo gate do handoff: use --apply <arquivo> para promover.');
      }
      out.raw(campeao?.systemPrompt ?? '');
      return EXIT.OK;
    }
    if (applyTo) {
      const prompt = campeao?.systemPrompt;
      if (!campeao || !prompt || !prompt.trim()) {
        throw new CliError(`A sessão "${id}" não tem prompt campeão para aplicar.`, EXIT.ERROR);
      }
      const destino = path.resolve(applyTo);
      if (guards.blocked) {
        // A tentativa bloqueada também fica na trilha (o destino não é tocado).
        await appendHandoffAudit(
          buildHandoffAuditEntry(record, guards, {
            outcome: 'blocked',
            file: destino,
            backup: null,
            committed: false,
            prompt,
          }),
          out,
        );
        throw handoffBlockedError(record, destino, guards);
      }
      // Override sem registro não passa: a trilha precisa ser gravável ANTES
      // de o destino ser tocado.
      if (guards.override) await ensureHandoffAuditWritable();
      // IMPL-088: prompt-approval@1. O `--commit` IMPLICA o registro versionado
      // (o commit leva `Approved-by:` e o arquivo); sem aprovador identificável
      // recusa ANTES de tocar o destino.
      const versionar = wantRecord || wantCommit;
      const approver = resolveApprover(approverRaw, path.dirname(destino));
      if (versionar && !approver) {
        throw new CliError(
          'Registro de aprovação sem aprovador: não há `--approver` nem identidade git (user.name/user.email) aqui.',
          EXIT.USAGE,
          { file: destino },
          {
            code: 'usage.approver_required',
            hint: 'Passe `--approver "Nome <email>"` (ou configure user.name/user.email no repo do destino).',
          },
        );
      }
      const primeiraRun = record.runIds[0] ? await loadRun(record.runIds[0]).catch(() => null) : null;
      const approval = buildPromptApproval({
        record,
        firstRun: primeiraRun,
        prompt,
        destino,
        approver,
        override: guards.override,
      });
      const approvalFile = versionar ? await writePromptApproval(destino, approval, recordDir) : null;
      for (const w of guards.warnings) {
        // O override é parte do RESULTADO (quem lê só o stdout tem de vê-lo);
        // o resto é narração no stderr. Sob --json/ndjson ele vai no payload.
        if (w.code.startsWith('override.') && out.isText) out.line(`! ${w.message}`);
        else out.warn(w.message);
      }
      const report = await applyPromptFile(applyTo, prompt, {
        commit: wantCommit,
        record,
        guards,
        out,
        approval: { file: approvalFile, trailers: approvalFile ? approvalTrailers(approval) : [] },
      });
      // A trilha local leva o registro INTEIRO em toda aplicação (100%), com ou
      // sem a cópia versionada no repo.
      const entrada: HandoffAuditEntry & { approval: PromptApproval; approvalFile: string | null } = {
        ...buildHandoffAuditEntry(record, guards, {
          outcome: 'applied',
          file: report.file,
          backup: report.backup,
          committed: report.committed,
          prompt,
        }),
        approval,
        approvalFile,
      };
      const auditLog = await appendHandoffAudit(entrada, out);
      out.info(
        `prompt aplicado em ${report.file}${report.backup ? ` (backup: ${report.backup})` : ''}`,
      );
      if (approvalFile) out.info(`registro ${PROMPT_APPROVAL_FORMAT} ${approval.approvalId} em ${approvalFile}`);
      if (wantCommit) out.info(report.committed ? 'commit criado.' : 'commit não criado (ver aviso).');
      out.result(true, 'sessions.winner', {
        applied: report.applied,
        file: report.file,
        backup: report.backup,
        committed: report.committed,
        sessionId: record.id,
        override: guards.override,
        blocks: guards.blocks,
        warnings: guards.warnings,
        auditLog,
        // IMPL-088: o registro de aprovação (hashes + evidência) e onde ficou.
        approval,
        approvalFile,
      });
      return EXIT.OK;
    }
    const decisaoWinner = sessionDecisionOf(record);
    if (out.isText && campeao) {
      out.line(`campeão da iteração ${campeao.iteration + 1}: ${campeao.winnerContestantId}`);
      // IMPL-050/IMPL-046: confirmação + veredito de recomendação antes do prompt.
      out.line(`confirmação: ${decisaoWinner.confirmation}`);
      if (decisaoWinner.recommendation) {
        out.line(`recomendação (${decisaoWinner.recommendation.ruler}): ${decisaoWinner.recommendation.text}`);
      }
      for (const i of [...guards.blocks, ...guards.warnings]) out.warn(i.message);
      if (guards.blocked) out.warn('--apply será BLOQUEADO para esta sessão (só passa com --override "<motivo>").');
      out.line();
      out.line(campeao.systemPrompt);
    }
    out.result(true, 'sessions.winner', {
      systemPrompt: campeao?.systemPrompt,
      iteration: campeao?.iteration,
      holdoutSkipped: Boolean(record.holdoutSkipped),
      holdout: record.holdout,
      significance: record.significance,
      judgeDrift: Boolean(record.judgeDrift),
      // IMPL-046/IMPL-050: veredito estável + texto de confirmação (CLI e UI).
      confirmation: decisaoWinner.confirmation,
      recommendation: decisaoWinner.recommendation,
      // Laudo do gate SEM aplicar: um agente decide antes de tentar o --apply.
      handoff: { wouldBlock: guards.blocked, blocks: guards.blocks, warnings: guards.warnings },
    });
    return EXIT.OK;
  }

  const decisao = sessionDecisionOf(record);
  if (out.isText) {
    out.line(`${record.id}  ${record.status}`);
    out.line(`tema: ${record.config.theme}`);
    out.line(`iterações: ${record.bestPromptByIteration.length}/${record.config.iterations}`);
    // IMPL-051: convergência com iteração E motivo (platão vs paciência). O
    // campo vai CRU: o default de record legado (sem `convergenceReason`) mora
    // SÓ em `convergenceReasonText` — a TrainingView passa o mesmo campo, e o
    // mesmo record tem a mesma explicação nas duas telas. (Record antigo não
    // tinha a paciência de hoje — "paciência — 2 iterações" seria inventado.)
    if (record.convergedAtIteration !== undefined) {
      out.line(
        `convergência: iteração ${record.convergedAtIteration + 1} (${convergenceReasonText(
          record.convergenceReason,
          record.config.patience,
        )})`,
      );
    }
    // IMPL-002: gate de cada iteração — bruto × corrigido × p ajustado (max-T).
    for (const it of record.bestPromptByIteration) {
      if (it.gate) out.line(`  iteração ${it.iteration + 1}: ${formatIterationGate(it.gate)}`);
    }
    // IMPL-005: pareamento final (n nominal × efetivo) e significância.
    if (record.pairing) {
      out.line(`pareamento (${record.pairing.source}): ${formatPairCoverage(record.pairing)}`);
    }
    if (record.significance) out.line(`significância: ${formatSignificance(record.significance)}`);
    else out.line(`significância: ${formatSignificanceOrigin(null)}`);
    // IMPL-050: confirmação do campeão — a palavra "validado" só com holdout forte.
    out.line(`confirmação: ${decisao.confirmation}`);
    // IMPL-046: veredito de recomendação com recusa honesta (mesmo objeto na UI).
    if (decisao.recommendation) {
      out.line(`recomendação (${decisao.recommendation.ruler}): ${decisao.recommendation.text}`);
    }
    out.line();
    for (const l of renderSpend(record.costByRole, record.totalCostUsd, record.budgetUsd, record.costAccuracy, record.costLedger)) out.line(l);
  }
  out.result(true, 'sessions.show', {
    session: record,
    // IMPL-046/IMPL-050: veredito estável + texto de confirmação (CLI e UI).
    confirmation: decisao.confirmation,
    recommendation: decisao.recommendation,
  });
  return EXIT.OK;
}

// --- sessions report ---------------------------------------------------------

/**
 * `sessions report <id>`: o relatório de ciclos (src/engine/sessionReport.ts).
 * Texto = Markdown no stdout (é o brief da skill plannotator-visual-explainer);
 * `--json` = o objeto `prompt-builder-session-report@1`; `--html <arq>` grava a
 * página autocontida no design system do Plannotator; `--annotate` a abre na UI
 * de anotação (`plannotator annotate`, binário instalado pelo agent-setup).
 */
async function sessionsReport(
  record: SessionRecord,
  values: Record<string, unknown>,
  out: Output,
): Promise<number> {
  const cpmRaw = values['calls-per-month'];
  let callsPerMonth: number | undefined;
  if (typeof cpmRaw === 'string') {
    const n = Number(cpmRaw.replace(/[_.]/g, ''));
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      throw new CliError('--calls-per-month exige um inteiro positivo (ex.: 50000).', EXIT.USAGE);
    }
    callsPerMonth = n;
  }
  const htmlRaw = values.html;
  const mdRaw = values.markdown;
  if (typeof htmlRaw === 'string' && !htmlRaw.trim()) throw new CliError('--html exige um caminho de arquivo.', EXIT.USAGE);
  if (typeof mdRaw === 'string' && !mdRaw.trim()) throw new CliError('--markdown exige um caminho de arquivo.', EXIT.USAGE);

  // Runs da sessão + as de re-avaliação limpa (os ids vivem no gate, não em runIds).
  const ids = new Set<string>(record.runIds);
  for (const it of record.bestPromptByIteration) {
    const rid = it.gate?.reeval?.runId;
    if (rid) ids.add(rid);
  }
  const runs: RunRecord[] = [];
  for (const rid of ids) {
    if (!isValidRecordId(rid)) continue;
    const r = await loadRun(rid);
    if (r) runs.push(r);
  }
  const report = buildSessionReport(record, runs, {
    generatedAt: new Date().toISOString(),
    ...(callsPerMonth ? { callsPerMonth } : {}),
  });

  const files: { html?: string; markdown?: string } = {};
  let htmlPath = typeof htmlRaw === 'string' ? path.resolve(htmlRaw.trim()) : undefined;
  if (values.annotate === true && !htmlPath) {
    // --annotate sem --html: grava ao lado dos dados (0700), nunca no cwd do usuário.
    const dir = await ensurePrivateDataDir(path.join(getDataDir(), 'reports'));
    htmlPath = path.join(dir, `${record.id}.html`);
  }
  if (htmlPath) {
    await fs.mkdir(path.dirname(htmlPath), { recursive: true });
    await fs.writeFile(htmlPath, renderSessionReportHtml(report), 'utf-8');
    files.html = htmlPath;
    out.info(`relatório HTML: ${htmlPath}`);
  }
  if (typeof mdRaw === 'string') {
    const mdPath = path.resolve(mdRaw.trim());
    await fs.mkdir(path.dirname(mdPath), { recursive: true });
    await fs.writeFile(mdPath, renderSessionReportMarkdown(report), 'utf-8');
    files.markdown = mdPath;
    out.info(`relatório Markdown: ${mdPath}`);
  }

  let annotated: boolean | undefined;
  if (values.annotate === true && htmlPath) {
    annotated = openInPlannotator(htmlPath, out);
  }

  if (out.isText) {
    // Sem --html/--markdown, o Markdown vai para o stdout (payload do comando).
    if (!files.html && !files.markdown) out.raw(renderSessionReportMarkdown(report));
    else out.line(report.headline);
  }
  out.result(true, 'sessions.report', {
    report,
    ...(files.html || files.markdown ? { files } : {}),
    ...(annotated !== undefined ? { annotated } : {}),
  });
  return EXIT.OK;
}

/**
 * Abre o HTML na UI de anotação do Plannotator e ESPERA a pessoa terminar.
 * O stdout do plannotator vai para o NOSSO stderr: o stdout do CLI é payload.
 */
function openInPlannotator(file: string, out: Output): boolean {
  const home = process.env.HOME ?? '';
  const candidatos = [process.env.PB_PLANNOTATOR_BIN, 'plannotator', home ? path.join(home, '.local/bin/plannotator') : '']
    .filter((x): x is string => Boolean(x));
  for (const bin of candidatos) {
    try {
      execFileSync(bin, ['annotate', file], { stdio: ['ignore', 2, 2] });
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      out.warn(`plannotator annotate terminou com erro: ${(err as Error).message}`);
      return false;
    }
  }
  out.warn(
    'Plannotator não encontrado — rode `npm run agent-setup` no repositório do prompt-builder ' +
      `(ou abra ${file} no navegador).`,
  );
  return false;
}

// --- techniques / lgpd / config / registry / doctor --------------------------

export async function cmdTechniques(argv: string[]): Promise<number> {
  const parsed = parse(argv, {});
  assertNoPositionals('techniques', parsed.positionals, 'prompt-builder techniques [--json]');
  const ctx = buildContext(parsed);
  const techs = listTechniques();
  if (ctx.out.isText) {
    for (const t of techs) ctx.out.line(`${t.id.padEnd(16)} ${t.name} — ${t.good}`);
  }
  ctx.out.result(true, 'techniques', { techniques: techs });
  return EXIT.OK;
}

export async function cmdLgpd(argv: string[]): Promise<number> {
  const parsed = parse(argv, {});
  // cli#13: `lgpd delete` mostrava as áreas (exit 0) — apagar é `runs delete`.
  assertNoPositionals(
    'lgpd',
    parsed.positionals,
    'prompt-builder lgpd [--json] (apagar dados: `runs delete <id>`, `sessions delete <id>`, `runs prune`)',
  );
  const ctx = buildContext(parsed);
  const data = getLgpdData();
  // IMPL-041: área sensível é FAIL-CLOSED (allowlist de endpoints ZDR); a
  // "geral" segue consultiva. O estado do snapshot vai junto.
  const health = allowlistHealth(data.allowlist);
  if (ctx.out.isText) {
    for (const a of data.areas) {
      ctx.out.line(`${a.id.padEnd(24)} ${a.label}${isSensitiveArea(a.id, data) ? '  [sensível: bloqueia fora da allowlist]' : ''}`);
    }
    ctx.out.info(`${health.message} Detalhes: \`prompt-builder models allowlist --check\`.`);
    // IMPL-042: o que a cascata de dado pessoal cobre (e o que NÃO cobre).
    ctx.out.info(
      'Dado pessoal: CPF/CNPJ/CNS (dígito verificador), RG, CEP, telefone, e-mail e CRM são pseudonimizados ' +
        'antes de TODA chamada de LLM; nomes/endereços em texto livre: não coberto. Dado de aparência real ' +
        'no config recusa a run até a revisão (`--allow-pii`); `--pii-mode synthetic` e o modo agente ' +
        'recusam sem exceção.',
    );
  }
  ctx.out.result(true, 'lgpd.areas', {
    areas: data.areas.map((a) => ({ ...a, sensivel: isSensitiveArea(a.id, data) })),
    allowlist: { state: health.state, usable: health.usable, dataGeracao: health.geradoEm ?? null, ageDays: health.ageDays ?? null },
    pii: { modes: PII_MODES, coverage: PII_COVERAGE },
  });
  return EXIT.OK;
}

const CONFIG_SUBS = ['validate', 'schema', 'example'] as const;

export async function cmdConfig(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'validate';
  // cli#13: `config explain f.json` validava em silêncio (exit 0).
  assertKnownSubcommand('config', sub, CONFIG_SUBS, {
    usage: 'config validate <arq> | config schema [--dialect arena|run] | config example [--mode …]',
    aliases: { check: 'validate', lint: 'validate', verify: 'validate', explain: 'validate', init: 'example', new: 'example' },
    hint: (x) =>
      /\.json$/i.test(x) || x.includes('/')
        ? `Para validar o arquivo, use \`prompt-builder config validate ${x}\`.`
        : undefined,
  });
  const parsed = parse(sub === argv[0] ? argv.slice(1) : argv, {
    mode: { type: 'string' },
    dialect: { type: 'string' },
    out: { type: 'string', short: 'o' },
  });
  const ctx = buildContext(parsed);
  const { out } = ctx;

  if (sub === 'schema') {
    // IMPL-093: o JSON Schema PUBLICADO sai do MESMO zod que valida
    // (`toJSONSchema` do zod v4) — nunca uma reimpressão que pudesse divergir —
    // com `$schema` versionado (draft 2020-12) e `$id` carregando a versão do
    // formato. O consumidor valida o arquivo sem depender do binário.
    const DIALECTOS: Record<string, string> = {
      arena: `urn:prompt-builder:schema:${ARENA_CONFIG_FORMAT}`,
      run: 'urn:prompt-builder:schema:run-config@1',
    };
    const pedido = typeof parsed.values.dialect === 'string' ? parsed.values.dialect.trim() : 'arena';
    const id = DIALECTOS[pedido];
    if (!id) {
      throw new CliError(
        `--dialect deve ser arena ou run (recebi "${pedido}").`,
        EXIT.USAGE,
        { flag: '--dialect', value: pedido, accepted: ['arena', 'run'] },
        { code: 'usage.invalid_flag_value', hint: 'Use `config schema` (arena-config@1) ou `config schema --dialect run` (RunConfig cru).' },
      );
    }
    const alvo = pedido === 'run' ? runConfigSchema : arenaConfigSchema;
    const gerado = z.toJSONSchema(alvo, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    const rascunho = typeof gerado.$schema === 'string' ? gerado.$schema : 'https://json-schema.org/draft/2020-12/schema';
    const { $schema: _omitido, ...corpo } = gerado;
    const doc = { $schema: rascunho, $id: id, ...corpo };
    const texto = out.json(doc); // compacto por padrão; --pretty formata (IMPL-092)
    if (typeof parsed.values.out === 'string' && parsed.values.out.trim()) {
      await fs.writeFile(parsed.values.out.trim(), `${texto}\n`, 'utf-8');
      out.info(`schema gravado em ${parsed.values.out.trim()}`);
    } else {
      out.raw(`${texto}\n`);
    }
    return EXIT.OK;
  }

  if (sub === 'example') {
    // IMPL-093 (R-12:REC-2): o exemplo tem de passar em `config validate` para
    // os 3 modos (round-trip). Antes `--mode vary` emitia mode:'vary' (que o
    // parser recusa) e o compare saía sem `models.competitors` (compare exige
    // >= 2) — example→validate quebrava em 2 dos 3 modos.
    const ALIAS_DE_MODO: Record<string, string> = {
      compare: 'compare',
      variation: 'variation',
      vary: 'variation',
      training: 'training',
      train: 'training',
    };
    const pedido = typeof parsed.values.mode === 'string' ? parsed.values.mode.trim() : 'train';
    const mode = ALIAS_DE_MODO[pedido];
    if (!mode) {
      throw new CliError(
        `--mode deve ser compare, variation ou training (recebi "${pedido}"; aliases: train, vary).`,
        EXIT.USAGE,
        { flag: '--mode', value: pedido, accepted: ['compare', 'variation', 'training'], aliases: ['train', 'vary'] },
        {
          code: 'usage.invalid_flag_value',
          hint: 'Use `--mode training` (alias `train`), `--mode variation` (alias `vary`) ou `--mode compare`.',
        },
      );
    }
    // Campo de tokens UNIFICADO: `limits.maxOutputTokens` é o canônico do
    // arena-config@1 (src/arenaConfig.ts o traduz em RunConfig.maxOutputTokens;
    // src/runArtifact.ts faz o caminho de volta). O `maxOutputTokens` no topo é
    // do RunConfig CRU — em arena-config é chave desconhecida e hoje o
    // `config validate` o recusa citando o caminho (fail-closed, IMPL-093).
    const comum = {
      format: 'arena-config@1',
      mode,
      theme: 'Assistente de suporte técnico de um SaaS de faturamento',
      scenarioBrief: 'Cubra dúvidas de cobrança, recusa de pedidos fora da política e extração de dados de faturas.',
      stages: 8,
      prompt: { text: 'Você é um assistente de suporte. Responda com base na política do produto.' },
      effort: { judge: 'high', datagen: 'low' },
      finalists: 3,
      limits: { maxOutputTokens: 600 },
    };
    const exemplo =
      mode === 'compare'
        ? {
            ...comum,
            // compare: eixo de competidores (>= 2) — juiz, datagen e referência
            // ficam FORA (IMPL-048: quem escreve o gabarito não compete nem julga).
            models: {
              // Defaults do dono (2026-09-27): o gerador NÃO pode ser
              // competidor (runConfigSchema) e os 3 preferidos competem, daí o
              // muse-spark (1º livre do universo preferido). Sem `reference`
              // explícito: no compare o gabarito cai no 1º juiz (aviso de viés).
              datagen: 'meta/muse-spark-1.3',
              judges: ['google/gemini-3.8-flash', 'meta/muse-spark-1.3'],
              competitors: ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash', 'xiaomi/mimo-v2.6-pro'],
            },
          }
        : {
            ...comum,
            // IMPL-048: `reference` OBRIGATÓRIO em variation/training e distinto
            // de juiz e do modelo sob teste (papéis separados).
            models: {
              // Defaults do dono (2026-09-27). O gabarito (reference) não pode
              // ser juiz nem o modelo sob teste (IMPL-048): z-ai é o 1º livre.
              datagen: 'xiaomi/mimo-v2.6-pro',
              judges: ['google/gemini-3.8-flash', 'meta/muse-spark-1.3'],
              reference: 'z-ai/glm-5.3-flash',
              contestant: 'xiaomi/mimo-v2.6-pro',
            },
            variation: { optimize: true, techniques: ['persona', 'constraints', 'format'] },
            // minGain ausente = margem prática default max(1; 50/n) (IMPL-002).
            // holdoutRatio 0.3 (IMPL-050): com o piso absoluto de 10 cenários, só a
            // partir de ~34 cenários o split alcança um holdout de verdade.
            ...(mode === 'training' ? { training: { iterations: 3, holdoutRatio: 0.3 } } : {}),
          };
    // JSON compacto por padrão (--pretty formata) — IMPL-092.
    const texto = out.json(exemplo);
    if (typeof parsed.values.out === 'string') {
      await fs.writeFile(parsed.values.out, `${texto}\n`, 'utf-8');
      out.info(`exemplo gravado em ${parsed.values.out}`);
    } else {
      out.raw(`${texto}\n`);
    }
    return EXIT.OK;
  }

  const file = parsed.positionals[0];
  if (!file) throw new CliError('Uso: prompt-builder config validate <arquivo.json>', EXIT.USAGE);
  const json = await readJsonFile(file);
  const formato = (json as Record<string, unknown>)?.format;

  if (isArenaAgentConfigFormat(formato)) {
    // cli#20: o arquivo de AGENTE valida aqui também — antes saía "não é uma
    // configuração do prompt-builder" (exit 3), e a dica de erro do `agents
    // run` mandava justamente para este comando. Mesma leitura do `agents run`
    // (schema, chave desconhecida, `files[].path` contido, `testsDir`).
    const { config } = await loadAgentConfigFile(file);
    out.info(
      `válido (${formato}) — ${config.customStages?.length ?? 0} cenário(s), executor ${config.agent?.executor ?? '?'}`,
    );
    out.result(true, 'config.validate', { format: formato, config });
    return EXIT.OK;
  }

  if (typeof formato === 'string') {
    const p = parseArenaConfig(json);
    if (!p.ok) throw new CliError(p.error, EXIT.CONFIG);
    // IMPL-093: chave que o parser descartaria em silêncio é ERRO (fail-closed),
    // com caminho JSON e "você quis dizer" — nunca sumir em silêncio.
    assertNoUnknownConfigKeys(json, p.config);
    for (const w of p.warnings ?? []) out.warn(w); // chave descontinuada (IMPL-012)
    const c = arenaConfigToRunConfig(p.config);
    if (!c.ok) throw new CliError(c.error, EXIT.CONFIG);
    // `scenarios.from: 'library'`: mesma resolução/checagem do `vary --config`.
    let curation: LibraryCuration | undefined;
    const config = await resolveArenaLibrary(p.config, c.config, { onCuration: (x) => (curation = x) });
    out.info(`válido — ${arenaConfigSummary(p.config)}`);
    // IMPL-090: o validate já diz o k de n curados (e avisa o que a run avisaria).
    if (curation) for (const w of curation.warnings) out.warn(w);
    out.result(true, 'config.validate', {
      format: formato,
      config,
      ...(curation ? { curatedKofN: curation.curatedKofN, curation } : {}),
    });
    return EXIT.OK;
  }
  const p = parseRunConfig(json);
  if (!p.ok) throw new CliError(p.error, EXIT.CONFIG, p.details);
  assertNoUnknownConfigKeys(json, p.config); // IMPL-093: fail-closed
  out.info('válido (RunConfig)');
  out.result(true, 'config.validate', { format: 'run-config', config: p.config });
  return EXIT.OK;
}

// --- registry (guarda de drift de prompts) -----------------------------------

const REGISTRY_SUBS = ['validate', 'init'] as const;

export async function cmdRegistry(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'validate';
  assertKnownSubcommand('registry', sub, REGISTRY_SUBS, {
    usage: 'registry validate [--file <arq>] | registry init [-o <arq>]',
  });
  const parsed = parse(sub === argv[0] ? argv.slice(1) : argv, {
    file: { type: 'string' },
    out: { type: 'string', short: 'o' },
  });
  const ctx = buildContext(parsed);
  const { out } = ctx;

  if (sub === 'init') {
    const alvo =
      typeof parsed.values.out === 'string' && parsed.values.out.trim()
        ? parsed.values.out.trim()
        : path.join(getDataDir(), 'prompt-registry.json');
    const existe = await fs
      .access(alvo)
      .then(() => true)
      .catch(() => false);
    if (existe) {
      // O registro é versionado junto com o código — nunca sobrescrever em silêncio.
      throw new CliError(`"${alvo}" já existe — não vou sobrescrever um registro.`, EXIT.CONFIG);
    }
    if (alvo === path.join(getDataDir(), 'prompt-registry.json')) {
      // IMPL-024: no data dir, raiz 0700 e arquivo 0600 como todo o resto
      await writePrivateDataFile(alvo, exampleRegistryJson());
    } else {
      await fs.mkdir(path.dirname(alvo), { recursive: true });
      await fs.writeFile(alvo, exampleRegistryJson(), 'utf-8');
    }
    out.info(`registro-exemplo gravado em ${alvo}`);
    out.result(true, 'registry.init', { file: alvo });
    return EXIT.OK;
  }

  const file =
    typeof parsed.values.file === 'string' && parsed.values.file.trim()
      ? path.resolve(parsed.values.file.trim())
      : path.join(getDataDir(), 'prompt-registry.json');

  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch {
    throw new CliError(
      `Registro "${file}" não encontrado ou ilegível. ` +
        'Crie um com `prompt-builder registry init -o <arquivo>`.',
      EXIT.CONFIG,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new CliError(`"${file}" não é um JSON válido: ${(err as Error).message}`, EXIT.CONFIG);
  }
  const p = parseRegistry(json);
  if (!p.ok) throw new CliError(p.error, EXIT.CONFIG);

  // A checagem de drift é PURA (src/registry.ts); aqui só se injeta a leitura
  // real. Caminhos relativos de `source.file` resolvem contra o diretório de
  // trabalho (o registro default mora no data-dir, o fonte mora no projeto).
  const report = validateRegistry(p.registry, (alvo) => {
    try {
      return readFileSync(path.resolve(alvo), 'utf-8');
    } catch {
      return undefined;
    }
  });

  if (out.isText) {
    out.line(`registro: ${file}`);
    out.line(
      `prompts: ${report.total} · ok: ${report.ok.length} · drift: ${report.drifted.length}`,
    );
    if (report.ok.length) {
      out.line();
      out.line('ok:');
      for (const pid of report.ok) out.line(`  ${pid}`);
    }
    if (report.drifted.length) {
      out.line();
      out.line('drift:');
      for (const d of report.drifted) out.line(`  ${d.id} — ${d.reason}`);
    }
  }
  // Drift = config: o registro não descreve mais o fonte de produção (exit 3).
  // Sai pelo envelope de erro (o relatório vai em `details`), não por um
  // `result` ok:false sem `error` (IMPL-028).
  if (report.drifted.length > 0) {
    throw new CliError(
      `${report.drifted.length} de ${report.total} prompt(s) com drift em ${file}.`,
      EXIT.CONFIG,
      { file, report },
      {
        code: 'registry.drift',
        hint: 'O fonte de produção mudou: reverta o prompt ou atualize o registro; o motivo de cada um está em details.report.drifted.',
      },
    );
  }
  out.result(true, 'registry.validate', { file, report });
  return EXIT.OK;
}

/**
 * Recomendações sobre o LIMITE DA KEY no OpenRouter (IMPL-031): quando a key
 * TEM limite, vale avisar se a janela dele não é diária (o estrago podia
 * acumular num dia).
 *
 * ⚠️ Decisão do DONO (2026-09-27): key SEM limite de crédito é ACEITE em
 * igualdade — nada de recomendação, aviso ou bloqueio por isso (o parágrafo
 * antigo "defina limit + limit_reset=daily" foi removido). O limite é opcional
 * do usuário. Pura: testável sem rede.
 */
export function keyLimitAdvice(info: KeyInfo | null, localDailyCapUsd: number | null): string[] {
  if (!info) return [];
  const onde = 'em https://openrouter.ai/settings/keys';
  if (info.limitUsd === null || info.limitUsd === undefined) {
    // Sem limite: aceite, sem nada a dizer (decisão do dono).
    return [];
  }
  const reset = info.limitReset ?? null;
  if (reset === null) {
    return [
      `A key tem limite de ${fmtUsd(info.limitUsd)} SEM reset (teto vitalício): esgotado, tudo para até alguém ` +
        `subir o limite. Prefira limit_reset=daily ${onde} — contém um estrago em 24 h e volta sozinho às 00:00 UTC.`,
    ];
  }
  if (reset !== 'daily') {
    return [
      `O limite da key reseta "${reset}": um agente desgovernado pode gastar a janela inteira num dia. ` +
        `limit_reset=daily ${onde} limita o estrago a 24 h (reset 00:00 UTC).`,
    ];
  }
  return [];
}

export async function cmdDoctor(argv: string[]): Promise<number> {
  const parsed = parse(argv, {});
  assertNoPositionals('doctor', parsed.positionals, 'prompt-builder doctor [--json]');
  const ctx = buildContext(parsed);
  const { out, dataDir } = ctx;
  const checks: Record<string, unknown> = {
    node: process.version,
    dataDir: getDataDir(),
  };

  try {
    // IMPL-024: raiz + cache/ em 0700 (o doctor não pode ser o único writer
    // que deixa o data dir 0755)
    await ensurePrivateDataDir(path.join(getDataDir(), 'cache'));
    checks.dataDirWritable = true;
  } catch (err) {
    checks.dataDirWritable = false;
    checks.dataDirError = (err as Error).message;
  }

  // Camadas locais anti-gasto-N× (IMPL-031): teto diário da máquina e runs
  // ativas (lock por config). Só disco. Teto INVÁLIDO (env ou limits.json) é
  // falha do doctor (exit 3, o mesmo `config.invalid_daily_cap` com que todo
  // compare/vary/train sai) — antes ele saía 0 com ok:true e a run quebrava.
  let capLocal: number | null = null;
  let falhaTeto: CliError | null = null;
  try {
    const cap = resolveDailyCap(dataDir);
    capLocal = cap.capUsd;
    const dia = readDailySnapshot(dataDir, cap);
    checks.dailyCap = {
      capUsd: cap.capUsd,
      source: cap.source,
      spentTodayUsd: dia.spentUsd,
      pendingUsd: dia.pendingUsd,
      remainingUsd: dia.remainingUsd,
      resetsAt: dia.resetsAt,
      processesToday: dia.processes,
    };
  } catch (err) {
    falhaTeto = toCliError(err);
    checks.dailyCap = `inválido: ${falhaTeto.message}`;
  }
  checks.activeRuns = listRunLocks(dataDir)
    .filter((l) => !l.stale)
    .map((l) => ({ pid: l.holder?.pid ?? null, command: l.holder?.command ?? null, runId: l.holder?.runId ?? l.holder?.sessionId ?? null }));

  // Key: ausente ou recusada = o doctor FALHA (exit 4); rede = exit 8. Antes
  // ele saía 0 com `ok:true` e "key: falhou: …" — um agente lia "saudável".
  let falha: CliError | null = null;
  let info: KeyInfo | null = null;
  try {
    const apiKey = await resolveKey(ctx.values);
    info = await checkKey(apiKey);
    checks.key = 'ok';
    checks.creditRemaining = info.limitRemainingUsd ?? null;
    checks.keyLimit = {
      limitUsd: info.limitUsd ?? null,
      limitRemainingUsd: info.limitRemainingUsd ?? null,
      limitReset: info.limitReset ?? null,
      usageDailyUsd: info.usageDailyUsd ?? null,
    };
    try {
      const cat = await loadCatalog(ctx, apiKey);
      checks.models = cat.models.length;
      checks.catalogSource = cat.catalogSource;
    } catch (err) {
      falha = toCliError(err);
      checks.models = `falhou: ${falha.message}`;
    }
  } catch (err) {
    falha = toCliError(err);
    checks.key = `falhou: ${falha.message}`;
  }

  const recomendacoes = keyLimitAdvice(info, capLocal);
  checks.recommendations = recomendacoes;

  if (out.isText) {
    for (const [k, v] of Object.entries(checks)) {
      if (k === 'recommendations') continue;
      out.line(`${k.padEnd(18)} ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`);
    }
    for (const r of recomendacoes) out.warn(r);
  }
  // Key/rede primeiro (4/8: sem eles nada roda); com a key boa, o teto
  // inválido ainda impede toda run — o doctor não pode dizer "saudável".
  if (!falha && falhaTeto) falha = falhaTeto;
  if (falha) {
    // O relatório inteiro vai em details: o agente vê o que passou e o que não.
    throw new CliError(falha.message, falha.code, { checks }, { code: falha.errorCode, hint: falha.hint });
  }
  out.result(true, 'doctor', checks);
  return EXIT.OK;
}
