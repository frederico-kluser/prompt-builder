// `prompt-builder jev …` (alias `decisions`) — o MODO JEV no terminal: mede e
// evolui definições de DECISÃO TIPADA (noul/choice/score) do Jev (e de outros
// modelos de decisão) em casos rotulados. O motor é o de `src/engine/jev/`
// (o mesmo da SPA); aqui só mora o que é de terminal: arquivos, flags,
// orçamento, guardas de gasto, SIGINT e o contrato de saída (stdout =
// payload, stderr = narração).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getGateway } from '../../openrouter.js';
import { enforceRunCompliance, isLgpdPolicyError, isPiiPolicyError } from '../../lgpd.js';
import {
  JEV_CONFIG_FORMAT,
  JEV_EXAMPLE_KINDS,
  JEV_OPERATORS,
  JEV_TECHNIQUE_MAP,
  buildDecisionsRequest,
  buildJevRunReport,
  buildJevSessionReport,
  estimateJev,
  estimateJevTrain,
  isJevConfig,
  isJevConfigError,
  jevComplianceView,
  jevExample,
  lintJevCases,
  lintJevSpec,
  lintResolved,
  parseJevConfig,
  parseJevDataset,
  renderJevRunReportMarkdown,
  renderJevSessionReportMarkdown,
  resolveJevConfig,
  runJev,
  sessionVerdict,
  specFromInput,
  specFromWireQuestions,
  splitCounts,
  summarizeJevRun,
  summarizeJevSession,
  toJsonl,
  trainJev,
  withSpecId,
  isPlainObject,
  applyStrict,
  type JevCase,
  type JevComplianceResult,
  type JevConfigFile,
  type JevEvent,
  type JevExampleKind,
  type JevLintIssue,
  type JevMode,
  type JevRunRecord,
  type JevSessionRecord,
  type ResolvedJevConfig,
} from '../../engine/jev/index.js';
import {
  findJevRecord,
  jevOwner,
  listJevRecords,
  loadJevSessionRuns,
  saveJevRun,
  saveJevSession,
} from '../../jev/store.js';
import type { OpenRouterModel } from '../../types.js';
import {
  buildContext,
  isAgentContext,
  limitList,
  loadCatalog,
  parse,
  parseListLimit,
  readJsonFile,
  resolveKey,
  tryResolveKey,
  type CliContext,
} from '../context.js';
import { CliError, EXIT, failAndExit, isCliError, type Output } from '../output.js';
import { budgetRequiredError, keyRequirement, toRefusal, type BudgetChoice } from '../preflight.js';
import { openSpendGuards, spendGuardRefusals, type SpendGuards } from '../spendGuards.js';
import { forceExitNow, installGracefulStop } from '../runControl.js';
import { emitJevEventNdjson, narrateJevEvent } from '../jevNdjson.js';

export const JEV_SUBCOMMANDS = [
  'validate',
  'example',
  'models',
  'import',
  'run',
  'eval',
  'compare',
  'train',
  'list',
  'show',
  'report',
  'export',
  'techniques',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveBudget(value: unknown, fromConfig: number | undefined, warn: (m: string) => void): BudgetChoice {
  if (typeof value === 'string' && value.trim()) {
    // `none` = sem teto, assumido explicitamente (mesma regra do compare/vary/train).
    if (value.trim().toLowerCase() === 'none') return { kind: 'none' };
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) {
      throw new CliError('--budget deve ser um valor em USD maior que zero, ou "none".', EXIT.USAGE, { value }, {
        code: 'usage.invalid_budget',
        hint: 'Use `--budget 0.05` (teto de US$ 0,05) — decisões custam ~US$ 0,00002 cada.',
      });
    }
    return { kind: 'usd', usd: v };
  }
  if (typeof fromConfig === 'number' && fromConfig > 0) return { kind: 'usd', usd: fromConfig };
  if (isAgentContext()) return { kind: 'missing' };
  warn('Sem --budget: rodando SEM teto de gasto.');
  return { kind: 'unset' };
}

const issuesText = (issues: readonly JevLintIssue[], n = 4): string =>
  issues
    .filter((i) => i.level === 'error')
    .slice(0, n)
    .map((i) => `${i.code}${i.line ? ` (linha ${i.line})` : ''} — ${i.message}`)
    .join('; ');

function configError(message: string, issues: readonly JevLintIssue[], code: string, hint?: string): CliError {
  return new CliError(message, EXIT.CONFIG, { issues: issues.slice(0, 50) }, {
    code,
    hint: hint ?? 'Valide com `prompt-builder jev validate <arquivo>`; `prompt-builder jev example -o jev.json` gera um exemplo válido.',
  });
}

interface LoadedJevConfig {
  cfg: JevConfigFile;
  cases?: JevCase[];
  caseIssues: JevLintIssue[];
}

/** Lê um jev-config@1 e, se ele apontar `cases.path`, o dataset relativo ao config. */
async function loadJevConfigFile(file: string): Promise<LoadedJevConfig> {
  const raw = await readJsonFile(file);
  if (!isJevConfig(raw)) {
    const f = isPlainObject(raw) && typeof raw.format === 'string' ? raw.format : 'desconhecido';
    throw new CliError(`"${file}" não é ${JEV_CONFIG_FORMAT} (formato ${f}).`, EXIT.CONFIG, { path: file, format: f }, {
      code: 'jev.config_invalid',
      hint: '`prompt-builder jev example -o jev.json` gera um jev-config@1 válido.',
    });
  }
  const p = parseJevConfig(raw);
  if (!p.ok) {
    throw new CliError(`jev-config@1 inválido: ${p.error}`, EXIT.CONFIG, { issues: p.issues.slice(0, 50) }, { code: 'jev.config_invalid' });
  }
  const cfg = p.config;
  if (Array.isArray(cfg.cases)) return { cfg, caseIssues: [] };
  const abs = path.resolve(path.dirname(path.resolve(file)), cfg.cases.path);
  let text: string;
  try {
    text = await fs.readFile(abs, 'utf-8');
  } catch (err) {
    throw new CliError(`Não consegui ler os casos em "${cfg.cases.path}" (relativo ao config).`, EXIT.USAGE, { path: cfg.cases.path, errno: (err as { code?: string }).code ?? null }, {
      code: 'usage.file_unreadable',
      hint: '`cases.path` é resolvido a partir do diretório do jev-config.',
    });
  }
  const parsed = parseJevDataset(text, 'auto', specFromInput(cfg.spec));
  return { cfg, cases: parsed.cases, caseIssues: parsed.issues };
}

function resolveOrThrow(loaded: LoadedJevConfig, opts: { mode?: JevMode; repeats?: number; allowPii?: boolean }): { resolved: ResolvedJevConfig; issues: JevLintIssue[] } {
  const datasetErros = loaded.caseIssues.filter((i) => i.level === 'error');
  if (datasetErros.length) {
    throw configError(`dataset inválido: ${issuesText(datasetErros)}`, datasetErros, 'jev.dataset_invalid', 'Confira `prompt-builder jev import --from <arquivo> --spec <config>` (erros com linha/coluna).');
  }
  const r = resolveJevConfig(loaded.cfg, {
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.repeats ? { repeats: opts.repeats } : {}),
    ...(loaded.cases ? { cases: loaded.cases } : {}),
    ...(opts.allowPii ? { allowPii: true } : {}),
  });
  if (!r.ok) {
    const codigo = r.issues.some((i) => i.code.startsWith('cases') || i.code.startsWith('dataset') || i.code.startsWith('state') || i.code.startsWith('expected') || i.code.startsWith('labels')) ? 'jev.dataset_invalid' : 'jev.config_invalid';
    throw configError(`jev-config@1 não resolve: ${issuesText(r.issues)}`, r.issues, codigo);
  }
  return { resolved: r.resolved, issues: [...loaded.caseIssues, ...r.issues] };
}

/** A recusa por lint (a MESMA na execução real e no --dry-run). `null` = sem erro. */
function lintError(resolved: ResolvedJevConfig, issues: readonly JevLintIssue[]): CliError | null {
  const erros = issues.filter((i) => i.level === 'error');
  if (!erros.length) return null;
  const poucos = resolved.mode === 'train' && erros.some((i) => i.code === 'cases.too_few' || i.code === 'question.no_gold');
  return configError(
    `${poucos ? 'casos rotulados insuficientes para treinar' : 'a definição/os casos têm erro'}: ${issuesText(erros)}`,
    issues,
    poucos ? 'jev.dataset_too_small' : 'jev.lint',
    poucos ? 'O treino exige ≥ 20 casos rotulados por pergunta-alvo (holdout ≥ 10 para confirmar).' : undefined,
  );
}

function lintOrThrow(resolved: ResolvedJevConfig, decisionCatalog: OpenRouterModel[], strict: boolean): JevLintIssue[] {
  const issues = lintResolved(resolved, { decisionCatalog, strict });
  const e = lintError(resolved, issues);
  if (e) throw e;
  return issues;
}

/** Pré-voo LGPD/PII (o mesmo `enforceRunCompliance` do produto) → recusa = exit 3. */
async function preflightCompliance(resolved: ResolvedJevConfig): Promise<JevComplianceResult> {
  try {
    const r = await enforceRunCompliance(jevComplianceView(resolved));
    return { ...(r.sensitiveRouting ? { sensitiveRouting: r.sensitiveRouting } : {}), ...(r.piiReport ? { piiReport: r.piiReport } : {}) };
  } catch (err) {
    if (isLgpdPolicyError(err)) {
      throw new CliError(err.message, EXIT.CONFIG, { violations: err.violations }, {
        code: 'lgpd.refused',
        hint: 'Em área sensível o modo JEV fica indisponível na v1 (nenhum modelo de decisão está na allowlist ZDR). Rode com dados sintéticos em área livre.',
      });
    }
    if (isPiiPolicyError(err)) {
      throw new CliError(err.message, EXIT.CONFIG, { fields: err.fields.map((f) => ({ path: f.path, kinds: f.assessment.kinds })) }, {
        code: 'pii.refused',
        hint: 'Revise os casos. Se pode seguir (identificadores saem pseudonimizados), repita com `--allow-pii`.',
      });
    }
    throw err;
  }
}

async function decisionCatalogOf(apiKey: string | null, out: Output): Promise<OpenRouterModel[]> {
  try {
    return await getGateway().listDecisionModels(apiKey ?? '');
  } catch (err) {
    out.warn(`catálogo de decisões indisponível (${(err as Error).message}) — estimativa com o preço de referência.`);
    return [];
  }
}

async function chatCatalogIfNeeded(ctx: CliContext, resolved: ResolvedJevConfig, apiKey: string | null): Promise<OpenRouterModel[]> {
  const precisa = resolved.contestants.some((c) => c.kind === 'llm') || Boolean(resolved.train?.rewriterModelId);
  if (!precisa) return [];
  try {
    return (await loadCatalog(ctx, apiKey)).models;
  } catch (err) {
    if (!isCliError(err)) throw err;
    ctx.out.warn(`sem catálogo de chat (${err.message}) — preços dos LLMs saem 0 na estimativa.`);
    return [];
  }
}

/** Identidade do EXPERIMENTO para o lock (o hash ignora `budgetUsd`). */
function guardConfigOf(r: ResolvedJevConfig): Record<string, unknown> & { budgetUsd?: number } {
  return {
    format: JEV_CONFIG_FORMAT,
    mode: r.mode,
    specHash: r.specHash,
    datasetHash: r.datasetHash,
    contestants: r.contestants.map((c) => c.id),
    repeats: r.repeats,
    ...(r.train ? { train: r.train } : {}),
    ...(r.budgetUsd !== undefined ? { budgetUsd: r.budgetUsd } : {}),
  };
}

function modeOf(v: unknown): JevMode | undefined {
  if (v === undefined) return undefined;
  if (v === 'eval' || v === 'compare' || v === 'train') return v;
  throw new CliError(`--mode deve ser eval, compare ou train (recebi "${String(v)}").`, EXIT.USAGE, { value: v }, { code: 'usage.invalid_flag_value' });
}

function intOf(v: unknown, flag: string, min: number, max: number): number | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new CliError(`${flag} deve ser um inteiro entre ${min} e ${max}.`, EXIT.USAGE, { flag, value: v }, { code: 'usage.invalid_flag_value' });
  }
  return n;
}

const pct = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null | undefined, c = 1): string => (v === null || v === undefined ? '—' : v.toFixed(c));
const usd = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `$${v.toFixed(v < 0.01 ? 6 : 4)}`);

// ---------------------------------------------------------------------------
// run | eval | compare | train
// ---------------------------------------------------------------------------

const RUN_OPTIONS = {
  config: { type: 'string', short: 'c' },
  budget: { type: 'string' },
  mode: { type: 'string' },
  repeats: { type: 'string' },
  'dry-run': { type: 'boolean' },
  'emit-cells': { type: 'boolean' },
  'allow-pii': { type: 'boolean' },
  'allow-concurrent': { type: 'boolean' },
  strict: { type: 'boolean' },
} as const;

/**
 * Código de saída do desfecho (parcial não é erro): cancelado 130, orçamento 7.
 * Inconclusivo (6), spec recusada (3) e falha (1) saem por throw (envelope).
 */
function exitFor(stoppedReason: string | undefined, budgetExhausted: boolean | undefined): number {
  if (stoppedReason === 'cancelled') return EXIT.SIGINT;
  if (budgetExhausted || stoppedReason === 'budget') return EXIT.BUDGET;
  return EXIT.OK;
}

async function cmdRunJev(argv: string[], forcedMode?: JevMode): Promise<number> {
  const parsed = parse(argv, RUN_OPTIONS);
  const ctx = buildContext(parsed);
  const { out, values } = ctx;
  const file = values.config ?? parsed.positionals[0];
  if (typeof file !== 'string') {
    throw new CliError('Uso: prompt-builder jev run -c <jev-config.json> --budget <usd>', EXIT.USAGE, undefined, {
      code: 'usage.missing_config',
      hint: '`prompt-builder jev example -o jev.json` gera um config de exemplo (com casos inline).',
    });
  }
  const mode = forcedMode ?? modeOf(values.mode);
  const strict = values.strict === true;
  const loaded = await loadJevConfigFile(file);
  const budget = resolveBudget(values.budget, loaded.cfg.budgetUsd, (m) => out.warn(m));
  const { resolved: r0, issues: resolveIssues } = resolveOrThrow(loaded, {
    ...(mode ? { mode } : {}),
    ...(intOf(values.repeats, '--repeats', 1, 5) ? { repeats: intOf(values.repeats, '--repeats', 1, 5) } : {}),
    allowPii: values['allow-pii'] === true,
  });
  const resolved: ResolvedJevConfig = { ...r0, ...(budget.kind === 'usd' ? { budgetUsd: budget.usd } : {}) };
  if (budget.kind !== 'usd') delete (resolved as { budgetUsd?: number }).budgetUsd;
  const label = `jev.${forcedMode ?? 'run'}`;

  // --dry-run: a MESMA sequência de recusas da execução real, sem gastar.
  if (values['dry-run'] === true) {
    const apiKey = await tryResolveKey(values);
    const decisionCatalog = await decisionCatalogOf(apiKey, out);
    const chatCatalog = await chatCatalogIfNeeded(ctx, resolved, apiKey);
    const lint = lintResolved(resolved, { decisionCatalog, strict });
    const est =
      resolved.mode === 'train'
        ? estimateJevTrain(resolved, { chatCatalog, decisionCatalog })
        : estimateJev(resolved, { chatCatalog, decisionCatalog });
    // Mesma ordem da execução real: orçamento → lint → LGPD/PII → lock/teto diário.
    const recusas = [];
    if (budget.kind === 'missing') recusas.push(toRefusal(budgetRequiredError()));
    const recusaLint = lintError(resolved, lint);
    if (recusaLint) recusas.push(toRefusal(recusaLint));
    try {
      await preflightCompliance(resolved);
    } catch (err) {
      if (!isCliError(err)) throw err;
      recusas.push(toRefusal(err));
    }
    recusas.push(
      ...spendGuardRefusals({ dataDir: ctx.dataDir, config: guardConfigOf(resolved), lock: values['allow-concurrent'] !== true }).map(toRefusal),
    );
    const requires = apiKey ? [] : [keyRequirement()];
    if (resolved.budgetUsd !== undefined && est.reserveUsd > resolved.budgetUsd) {
      out.warn(`a reserva da porta dura (${usd(est.reserveUsd)}) passa do teto (${usd(resolved.budgetUsd)}): os últimos casos podem ser cortados.`);
    }
    const resumo = {
      dryRun: true,
      mode: resolved.mode,
      cases: resolved.cases.length,
      splits: splitCounts(resolved.cases),
      contestants: resolved.contestants.map((c) => ({ id: c.id, kind: c.kind, modelId: c.modelId })),
      repeats: resolved.repeats,
      estimate: est,
      lint: [...resolveIssues, ...lint].filter((i) => i.level !== 'info').slice(0, 40),
      wouldRefuse: recusas,
      requires,
      checks: { decisionCatalog: decisionCatalog.length, key: apiKey ? 'present' : 'missing' },
    };
    if (out.isText) {
      out.line(`${resolved.mode} · ${resolved.cases.length} casos · ${resolved.contestants.length} competidor(es) · ${resolved.repeats} rep.`);
      out.line(`Estimativa: ${est.requests} requests · ${usd(est.usdLow)} – ${usd(est.usdHigh)} (reserva ${usd(est.reserveUsd)})${est.detectableDeltaPp !== null ? ` · Δ detectável ≈ ${est.detectableDeltaPp} p.p.` : ''}`);
      for (const n of est.notes) out.line(`  nota: ${n}`);
      for (const x of recusas) out.line(`  RECUSARIA  ${x.code} — ${x.message.split('\n')[0]}`);
      for (const x of requires) out.line(`  REQUER     ${x.code} — ${x.message}`);
    }
    const primeira = recusas[0];
    if (primeira) throw new CliError(primeira.message, primeira.exit, resumo, { code: primeira.code, hint: primeira.hint ?? undefined });
    out.result(true, `${label}.dry-run`, resumo);
    return EXIT.OK;
  }

  // Execução real: orçamento → key → LGPD/PII → catálogos → guardas → run.
  if (budget.kind === 'missing') throw budgetRequiredError();
  let apiKey = '';
  try {
    apiKey = await resolveKey(values);
  } catch (err) {
    throw new CliError(`Exige a key do OpenRouter (OPENROUTER_API_KEY ou \`key set\`): ${(err as Error).message}`, EXIT.AUTH, isCliError(err) ? err.details : undefined, {
      code: 'auth.key_missing',
      hint: isCliError(err) ? err.hint : undefined,
    });
  }
  const decisionCatalog = await decisionCatalogOf(apiKey, out);
  lintOrThrow(resolved, decisionCatalog, strict);
  const compliance = await preflightCompliance(resolved);
  const chatCatalog = await chatCatalogIfNeeded(ctx, resolved, apiKey);

  const ac = new AbortController();
  const guards: SpendGuards = openSpendGuards({
    dataDir: ctx.dataDir,
    config: guardConfigOf(resolved),
    command: `jev ${resolved.mode}`,
    models: [...chatCatalog, ...decisionCatalog],
    signal: ac.signal,
    lock: values['allow-concurrent'] !== true,
    warn: (m) => out.warn(m),
  });
  const sairInterrompido = (code: number): void =>
    failAndExit(out, label, new CliError('Interrompido: saída imediata, sem esperar a run fechar.', code, undefined, { code: 'control.interrupted' }));
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
  const estado = { lastProgress: 0 };
  const emit = (e: JevEvent): void => {
    if (out.isNdjson) emitJevEventNdjson(out, e, { cells: values['emit-cells'] === true });
    else narrateJevEvent(out, e, estado);
  };
  const id = randomUUID();
  guards.lock?.update(resolved.mode === 'train' ? { sessionId: id } : { runId: id });
  guards.machine.setLabel(`jev ${resolved.mode} ${id}`);
  let run: JevRunRecord | undefined;
  let session: JevSessionRecord | undefined;
  try {
    const comum = {
      apiKey,
      client: 'node' as const,
      signal: ac.signal,
      parentLedger: guards.parentLedger,
      compliance: async () => compliance,
      emit,
      log: (m: string) => out.warn(m),
      owner: jevOwner(),
      strict,
    };
    if (resolved.mode === 'train') {
      session = await trainJev(resolved, { ...comum, sessionId: id, saveRun: saveJevRun, saveSession: saveJevSession });
    } else {
      run = await runJev(resolved, { ...comum, runId: id, save: saveJevRun });
    }
  } catch (err) {
    if (isJevConfigError(err)) throw configError(err.message, err.issues, err.message.startsWith('jev.dataset_too_small') ? 'jev.dataset_too_small' : 'jev.lint');
    throw err;
  } finally {
    process.off('SIGINT', onSigint);
    stopGraceful();
    guards.close();
  }

  if (session) {
    const resumo = { ...summarizeJevSession(session), ...(guards.machine.capHit ? { dailyCapReached: true } : {}), next: `prompt-builder jev report ${session.id}` };
    if (out.isText) renderSessionText(out, session);
    const code = exitFor(session.stoppedReason, session.budgetExhausted);
    out.result(true, label, resumo);
    return code;
  }
  const rec = run!;
  const resumo = { ...summarizeJevRun(rec), ...(guards.machine.capHit ? { dailyCapReached: true } : {}), next: `prompt-builder jev report ${rec.id}` };
  if (out.isText) renderRunText(out, rec);
  if (rec.status === 'error') {
    const recusada = rec.stoppedReason === 'spec-rejected';
    throw new CliError(rec.error ?? 'run JEV falhou', recusada ? EXIT.CONFIG : EXIT.ERROR, { ...resumo, spentUsd: rec.totalCostUsd }, {
      code: recusada ? 'jev.spec_rejected' : 'run.failed',
      hint: recusada
        ? 'A API recusou a definição (400): veja details.rejected e rode `prompt-builder jev validate` — o gasto até a recusa está em details.spentUsd.'
        : `Veja \`prompt-builder jev show ${rec.id} --json\`.`,
    });
  }
  const code = exitFor(rec.stoppedReason, rec.budgetExhausted);
  // Orçamento (7) vence inconclusivo (6): o parcial é o desfecho principal.
  if (code === EXIT.OK && rec.status === 'inconclusive') {
    throw new CliError(`Run JEV ${rec.id} inconclusiva: ${(rec.inconclusiveReasons ?? []).join('; ')}.`, EXIT.INCONCLUSIVE, resumo, {
      code: 'run.inconclusive',
      hint: `Não conclua com base nela; veja \`prompt-builder jev show ${rec.id} --json\`.`,
    });
  }
  out.result(true, label, resumo);
  return code;
}

function renderRunText(out: Output, rec: JevRunRecord): void {
  out.line(`${rec.id}  ${rec.mode}  ${rec.status}${rec.stoppedReason ? ` (${rec.stoppedReason})` : ''}`);
  out.line('competidor                                acurácia  brier  ECE    auto   prec.auto  p50      US$/1k dec.');
  for (const c of rec.contestants) {
    const m = rec.metrics[c.id];
    if (!m) continue;
    out.line(
      `${c.label.slice(0, 40).padEnd(41)} ${pct(m.accuracy).padStart(7)}  ${num(m.brierScore).padStart(5)}  ${num(m.ece, 3).padStart(5)}  ${pct(m.coverageAtAuto).padStart(5)}  ${pct(m.precisionAtAuto).padStart(8)}  ${(m.latencyP50 === null ? '—' : `${Math.round(m.latencyP50)}ms`).padStart(7)}  ${usd(m.costPer1kDecisions)}${m.costExact ? '' : '*'}`,
    );
  }
  for (const c of rec.comparisons ?? []) {
    out.line(`  vs controle ${c.contestantId}: Δ ${num(c.meanDiffPp, 2)} p.p. (${c.metric}), p=${num(c.pValue, 3)} · Δ acurácia ${num(c.accuracyDiffPp, 1)} p.p., McNemar p=${num(c.mcnemarP, 3)}`);
  }
  for (const k of rec.cascade ?? []) {
    out.line(`  cascata ${k.decisionId} → ${k.llmId}: acurácia ${pct(k.atDefault.accuracy)} escalando ${pct(k.atDefault.escalatedRate)}`);
  }
  out.line(`Gasto ${usd(rec.totalCostUsd)}${rec.cost.pendingUsd > 0 ? ` (+ ${usd(rec.cost.pendingUsd)} pendente)` : ''}${rec.budgetUsd ? ` de ${usd(rec.budgetUsd)}` : ''}`);
  if (rec.incompleteCaseIds.length) out.line(`${rec.incompleteCaseIds.length} caso(s) incompleto(s) fora das métricas.`);
}

function renderSessionText(out: Output, s: JevSessionRecord): void {
  out.line(`${s.id}  treino  ${s.status}${s.stoppedReason ? ` (${s.stoppedReason})` : ''}  veredito: ${sessionVerdict(s)}`);
  for (const i of s.iterations) {
    out.line(`  ciclo ${i.iteration}: ${i.gate.decision}${i.gate.heldBy?.length ? ` — ${i.gate.heldBy.join('; ')}` : ''}`);
  }
  if (s.holdout) out.line(`  holdout: ${s.holdout.text}`);
  out.line(`Gasto ${usd(s.totalCostUsd)}${s.budgetUsd ? ` de ${usd(s.budgetUsd)}` : ''}`);
}

// ---------------------------------------------------------------------------
// validate | example | import | models | techniques
// ---------------------------------------------------------------------------

async function cmdValidate(argv: string[]): Promise<number> {
  const parsed = parse(argv, { spec: { type: 'string' }, strict: { type: 'boolean' }, mode: { type: 'string' } });
  const ctx = buildContext(parsed);
  const { out, values } = ctx;
  const file = parsed.positionals[0];
  if (!file) throw new CliError('Uso: prompt-builder jev validate <arquivo> [--strict] [--spec <config>]', EXIT.USAGE, undefined, { code: 'usage.missing_file' });
  const strict = values.strict === true;
  let kind: string;
  let issues: JevLintIssue[] = [];
  let resumo: Record<string, unknown> = {};
  const texto = await fs.readFile(file, 'utf-8').catch(() => {
    throw new CliError(`Não consegui ler o arquivo "${file}".`, EXIT.USAGE, { path: file }, { code: 'usage.file_unreadable' });
  });
  let json: unknown;
  try {
    json = JSON.parse(texto);
  } catch {
    json = undefined;
  }
  if (isJevConfig(json)) {
    kind = 'jev-config';
    const loaded = await loadJevConfigFile(file);
    const { resolved, issues: iss } = resolveOrThrow(loaded, { ...(modeOf(values.mode) ? { mode: modeOf(values.mode) } : {}) });
    issues = [...iss, ...lintResolved(resolved, { strict })];
    resumo = {
      mode: resolved.mode,
      questions: resolved.specs[0].questions.map((q) => ({ id: q.id, type: q.type })),
      cases: resolved.cases.length,
      splits: splitCounts(resolved.cases),
      contestants: resolved.contestants.map((c) => c.id),
    };
  } else if (isPlainObject(json) && isPlainObject(json.questions) && 'state' in json) {
    kind = 'decisions-request';
    const spec = withSpecId(specFromWireQuestions(json.questions));
    issues = [
      ...lintJevSpec(spec, { ...(typeof json.model === 'string' ? { modelId: json.model } : {}), cases: [{ id: 'estado', state: json.state as never, expected: {} }], strict }),
      ...applyStrict(lintJevCases([{ id: 'estado', state: json.state as never, expected: {} }], spec).filter((i) => !['question.no_gold', 'cases.too_few'].includes(i.code)), strict),
    ];
    if (typeof json.session_id === 'string' && json.session_id.length > 256) issues.push({ level: 'error', code: 'session_id.len', message: '`session_id` passa de 256 caracteres.' });
    if (typeof json.user === 'string' && json.user.length > 256) issues.push({ level: 'error', code: 'user.len', message: '`user` passa de 256 caracteres (a API recusa com 400).' });
    resumo = { model: json.model ?? null, questions: spec.questions.map((q) => ({ id: q.id, type: q.type })) };
  } else {
    kind = 'dataset';
    let specBase;
    if (typeof values.spec === 'string') specBase = specFromInput((await loadJevConfigFile(values.spec)).cfg.spec);
    const parsedDs = parseJevDataset(texto, 'auto', specBase);
    const spec = specBase ?? (parsedDs.spec ? withSpecId(parsedDs.spec) : undefined);
    issues = [...parsedDs.issues, ...(spec ? applyStrict(lintJevCases(parsedDs.cases, spec), strict) : [])];
    if (!spec) issues.push({ level: 'warning', code: 'dataset.no_spec', message: 'sem --spec: o ouro não foi conferido contra as perguntas.' });
    resumo = { format: parsedDs.format, cases: parsedDs.cases.length };
  }
  const erros = issues.filter((i) => i.level === 'error');
  if (out.isText) {
    for (const i of issues) out.line(`${i.level.toUpperCase().padEnd(7)} ${i.code}${i.questionId ? ` [${i.questionId}]` : ''}${i.line ? ` (linha ${i.line})` : ''} — ${i.message}`);
    out.line(erros.length ? `${erros.length} erro(s): nada seria enviado.` : `OK (${kind}) — ${issues.length} aviso(s)/nota(s).`);
  }
  if (erros.length) throw configError(`${kind} inválido: ${issuesText(erros)}`, issues, 'jev.lint');
  out.result(true, 'jev.validate', { kind, ok: true, issues, ...resumo });
  return EXIT.OK;
}

async function cmdExample(argv: string[]): Promise<number> {
  const parsed = parse(argv, { kind: { type: 'string' }, mode: { type: 'string' }, output: { type: 'string', short: 'o' } });
  const ctx = buildContext(parsed);
  const { out, values } = ctx;
  const kind = (values.kind ?? 'triagem') as JevExampleKind;
  if (!JEV_EXAMPLE_KINDS.includes(kind)) {
    throw new CliError(`--kind deve ser ${JEV_EXAMPLE_KINDS.join('|')}.`, EXIT.USAGE, { value: values.kind }, { code: 'usage.invalid_flag_value' });
  }
  const cfg = jevExample(kind, modeOf(values.mode) ?? 'eval');
  const texto = `${JSON.stringify(cfg, null, 2)}\n`;
  if (typeof values.output === 'string') {
    await fs.writeFile(values.output, texto, 'utf-8');
    out.info(`exemplo gravado em ${values.output}`);
    out.result(true, 'jev.example', { path: values.output, kind, mode: cfg.mode, cases: (cfg.cases as unknown[]).length });
    return EXIT.OK;
  }
  if (out.isText) out.raw(texto);
  out.result(true, 'jev.example', { kind, config: cfg });
  return EXIT.OK;
}

async function cmdImport(argv: string[]): Promise<number> {
  const parsed = parse(argv, { from: { type: 'string' }, spec: { type: 'string' }, output: { type: 'string', short: 'o' } });
  const ctx = buildContext(parsed);
  const { out, values } = ctx;
  const from = values.from ?? parsed.positionals[0];
  if (typeof from !== 'string') throw new CliError('Uso: prompt-builder jev import --from <csv|jsonl|json> [--spec <config>] -o <casos.jsonl>', EXIT.USAGE, undefined, { code: 'usage.missing_file' });
  const texto = await fs.readFile(from, 'utf-8').catch(() => {
    throw new CliError(`Não consegui ler "${from}".`, EXIT.USAGE, { path: from }, { code: 'usage.file_unreadable' });
  });
  const specBase = typeof values.spec === 'string' ? specFromInput((await loadJevConfigFile(values.spec)).cfg.spec) : undefined;
  const r = parseJevDataset(texto, 'auto', specBase);
  const spec = specBase ?? (r.spec ? withSpecId(r.spec) : undefined);
  const issues = [...r.issues, ...(spec ? lintJevCases(r.cases, spec).filter((i) => i.level === 'error') : [])];
  if (out.isText) for (const i of issues) out.line(`${i.level.toUpperCase().padEnd(7)} ${i.code}${i.line ? ` (linha ${i.line})` : ''} — ${i.message}`);
  if (issues.some((i) => i.level === 'error')) throw configError(`dataset inválido: ${issuesText(issues)}`, issues, 'jev.dataset_invalid');
  const jsonl = toJsonl(r.cases);
  if (typeof values.output === 'string') await fs.writeFile(values.output, jsonl, 'utf-8');
  else if (out.isText) out.raw(jsonl);
  out.result(true, 'jev.import', {
    format: r.format,
    cases: r.cases.length,
    issues,
    ...(typeof values.output === 'string' ? { path: values.output } : {}),
    ...(r.spec ? { spec: { questions: r.spec.questions } } : {}),
  });
  return EXIT.OK;
}

async function cmdModels(argv: string[]): Promise<number> {
  const parsed = parse(argv, { all: { type: 'boolean' } });
  const ctx = buildContext(parsed);
  const { out, values } = ctx;
  const apiKey = await tryResolveKey(values);
  let modelos: OpenRouterModel[];
  try {
    modelos = await getGateway().listDecisionModels(apiKey ?? '', values['refresh-models'] === true);
  } catch (err) {
    throw new CliError(`Não consegui carregar o catálogo de decisões: ${(err as Error).message}`, EXIT.NETWORK, undefined, { code: 'network.catalog_unavailable' });
  }
  const rows = modelos.map((m) => ({
    id: m.id,
    name: m.name,
    contextLength: m.contextLength ?? null,
    promptUsdPerMTok: typeof m.pricing.prompt === 'number' ? m.pricing.prompt * 1e6 : null,
    completionUsdPerMTok: typeof m.pricing.completion === 'number' ? m.pricing.completion * 1e6 : null,
    snapshot: m.canonicalSlug ?? null,
    alias: m.id.startsWith('~') || /-latest$/.test(m.id),
  }));
  if (out.isText) {
    for (const r of rows) {
      out.line(`${r.id.padEnd(28)} ctx ${String(r.contextLength ?? '?').padStart(7)}  entrada $${num(r.promptUsdPerMTok, 3)}/Mtok  saída $${num(r.completionUsdPerMTok, 3)}/Mtok  ${r.snapshot ?? ''}${r.alias ? '  (alias: fixe a versão para calibrar)' : ''}`);
    }
  }
  out.result(true, 'jev.models', { count: rows.length, models: rows });
  return EXIT.OK;
}

async function cmdTechniques(argv: string[]): Promise<number> {
  const parsed = parse(argv, {});
  const { out } = buildContext(parsed);
  const ops = Object.values(JEV_OPERATORS);
  if (out.isText) {
    out.line('OPERADORES DO MODO JEV (evolução da definição)');
    for (const o of ops) out.line(`  ${o.id.padEnd(17)} ${o.ref.padEnd(4)} ${o.kind.padEnd(13)} ${o.available ? '' : '(adiado) '}${o.what}`);
    out.line('');
    out.line('AS 19 TÉCNICAS DE PROMPT LLM NO JEV (T = transfere · T± = muda de lugar · NA = não se aplica)');
    for (const t of JEV_TECHNIQUE_MAP) out.line(`  ${t.id.padEnd(15)} ${t.verdict.padEnd(3)} ${t.jev}`);
  }
  out.result(true, 'jev.techniques', { operators: ops, techniques: JEV_TECHNIQUE_MAP });
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// list | show | report | export
// ---------------------------------------------------------------------------

async function cmdList(argv: string[]): Promise<number> {
  const parsed = parse(argv, { kind: { type: 'string' }, limit: { type: 'string' }, all: { type: 'boolean' } });
  const ctx = buildContext(parsed);
  const { out, values } = ctx;
  const kind = values.kind === 'run' || values.kind === 'session' ? values.kind : 'all';
  const todos = await listJevRecords(kind);
  const rows = limitList(todos, parseListLimit(values), out, 'registros JEV');
  if (out.isText) {
    for (const r of rows) out.line(`${r.id}  ${r.kind.padEnd(7)} ${r.mode.padEnd(7)} ${r.status.padEnd(12)} ${r.startedAt.slice(0, 19).replace('T', ' ')}  ${usd(r.totalCostUsd)}  ${r.theme}`);
    if (!rows.length) out.info('nenhuma run/sessão JEV neste data-dir.');
  }
  out.result(true, 'jev.list', { items: rows, total: todos.length });
  return EXIT.OK;
}

async function achar(id: string | undefined, uso: string): Promise<NonNullable<Awaited<ReturnType<typeof findJevRecord>>>> {
  if (!id) throw new CliError(`Uso: ${uso}`, EXIT.USAGE, undefined, { code: 'usage.missing_id' });
  const r = await findJevRecord(id);
  if (!r) {
    throw new CliError(`Run/sessão JEV "${id}" não encontrada neste data-dir.`, EXIT.USAGE, { id }, {
      code: 'jev.not_found',
      hint: '`prompt-builder jev list` mostra as runs e sessões (confira --data-dir).',
    });
  }
  return r;
}

async function cmdShow(argv: string[]): Promise<number> {
  const parsed = parse(argv, { full: { type: 'boolean' } });
  const ctx = buildContext(parsed);
  const { out, values } = ctx;
  const r = await achar(parsed.positionals[0], 'prompt-builder jev show <id> [--full] [--json]');
  if (r.kind === 'run') {
    if (out.isText) renderRunText(out, r.rec);
    out.result(true, 'jev.show', values.full === true ? { kind: 'jev-run', record: r.rec } : summarizeJevRun(r.rec));
  } else {
    if (out.isText) renderSessionText(out, r.rec);
    out.result(true, 'jev.show', values.full === true ? { kind: 'jev-session', record: r.rec } : summarizeJevSession(r.rec));
  }
  return EXIT.OK;
}

async function cmdReport(argv: string[]): Promise<number> {
  const parsed = parse(argv, { markdown: { type: 'string' }, 'requests-per-month': { type: 'string' } });
  const ctx = buildContext(parsed);
  const { out, values } = ctx;
  const r = await achar(parsed.positionals[0], 'prompt-builder jev report <id> [--json | --markdown <arq>]');
  const rpm = intOf(values['requests-per-month'], '--requests-per-month', 1, 1e12);
  let report: Record<string, unknown>;
  let md: string;
  if (r.kind === 'run') {
    const rep = buildJevRunReport(r.rec);
    report = rep as unknown as Record<string, unknown>;
    md = renderJevRunReportMarkdown(rep);
  } else {
    const rep = buildJevSessionReport(r.rec, await loadJevSessionRuns(r.rec), rpm ? { requestsPerMonth: rpm } : {});
    report = rep as unknown as Record<string, unknown>;
    md = renderJevSessionReportMarkdown(rep);
  }
  if (typeof values.markdown === 'string') {
    await fs.writeFile(values.markdown, md, 'utf-8');
    out.info(`relatório gravado em ${values.markdown}`);
  } else if (out.isText) out.raw(md);
  out.result(true, 'jev.report', { ...report, ...(typeof values.markdown === 'string' ? { markdownPath: values.markdown } : {}) });
  return EXIT.OK;
}

async function cmdExport(argv: string[]): Promise<number> {
  const parsed = parse(argv, { request: { type: 'boolean' }, output: { type: 'string', short: 'o' }, override: { type: 'string' }, contestant: { type: 'string' } });
  const ctx = buildContext(parsed);
  const { out, values } = ctx;
  const r = await achar(parsed.positionals[0], 'prompt-builder jev export <id> [--request] [-o <arq>] [--override "<motivo>"]');
  let spec;
  let model: string;
  let resolvedModel: string | null = null;
  let policy: Record<string, unknown> = {};
  let evidence: Record<string, unknown>;
  if (r.kind === 'session') {
    const s = r.rec;
    if (s.holdout?.regressed && typeof values.override !== 'string') {
      throw new CliError('A definição campeã REGREDIU no holdout: o handoff foi recusado.', EXIT.GATE_BLOCKED, { sessionId: s.id, holdout: s.holdout }, {
        code: 'gate.holdout_regressed',
        hint: 'Não use esta definição. Só sobreponha por decisão humana: `--override "<motivo>"`.',
      });
    }
    spec = s.championSpec;
    model = s.modelId;
    resolvedModel = s.resolvedModels[0] ?? null;
    policy = s.policy;
    evidence = {
      sessionId: s.id,
      verdict: sessionVerdict(s),
      holdout: s.holdout ? { n: s.holdout.n, strength: s.holdout.strength, pValue: s.holdout.comparison?.pValue ?? null, regressed: s.holdout.regressed } : null,
      ...(typeof values.override === 'string' ? { override: values.override } : {}),
    };
  } else {
    const rec = r.rec;
    const ctId = typeof values.contestant === 'string' ? values.contestant : rec.contestants.find((c) => c.kind === 'decision')?.id;
    const ct = rec.contestants.find((c) => c.id === ctId);
    if (!ct) throw new CliError(`competidor "${String(ctId)}" não existe na run.`, EXIT.USAGE, { contestants: rec.contestants.map((c) => c.id) }, { code: 'usage.invalid_flag_value' });
    spec = rec.specs.find((s) => s.id === ct.specId)!;
    model = ct.modelId;
    resolvedModel = rec.resolvedModels[ct.modelId]?.[0] ?? null;
    policy = rec.policy?.[ct.id] ?? {};
    evidence = { runId: rec.id, contestantId: ct.id, metrics: rec.metrics[ct.id] ? summarizeJevRun(rec).contestants : null };
  }
  const request = buildDecisionsRequest(spec, '<<STATE>>', { model });
  const keyMap = Object.fromEntries(spec.questions.filter((q) => q.type === 'choice' && q.keyMap).map((q) => [q.id, (q as { keyMap?: Record<string, string> }).keyMap]));
  const handoff = {
    format: 'jev-handoff@1',
    model,
    resolvedModel,
    request,
    ...(spec.stateView ? { stateView: spec.stateView } : {}),
    ...(Object.keys(keyMap).length ? { keyMap } : {}),
    policy,
    evidence,
    notes: [
      'Troque "<<STATE>>" pelo estado real (aplique o stateView antes, se houver).',
      'A política é POR PERGUNTA (temperatura + limiares). O `jev.mjs` da jev-agent-skill aplica UM par de limiares a todas e não aplica temperatura.',
      'Fixe o modelo (não use alias ~…-latest): a política foi ajustada no snapshot em resolvedModel.',
    ],
  };
  const payload = values.request === true ? request : handoff;
  const texto = `${JSON.stringify(payload, null, 2)}\n`;
  if (typeof values.output === 'string') {
    await fs.writeFile(values.output, texto, 'utf-8');
    out.info(`handoff gravado em ${values.output}`);
  } else if (out.isText) out.raw(texto);
  out.result(true, 'jev.export', { ...(typeof values.output === 'string' ? { path: values.output } : {}), handoff: payload });
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export async function cmdJev(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case 'validate':
      return cmdValidate(rest);
    case 'example':
      return cmdExample(rest);
    case 'models':
      return cmdModels(rest);
    case 'import':
      return cmdImport(rest);
    case 'run':
      return cmdRunJev(rest);
    case 'eval':
    case 'compare':
    case 'train':
      return cmdRunJev(rest, sub);
    case 'list':
      return cmdList(rest);
    case 'show':
      return cmdShow(rest);
    case 'report':
      return cmdReport(rest);
    case 'export':
      return cmdExport(rest);
    case 'techniques':
      return cmdTechniques(rest);
    default:
      throw new CliError(
        sub ? `Subcomando desconhecido: "jev ${sub}".` : 'Uso: prompt-builder jev <subcomando> — veja `prompt-builder jev --help`.',
        EXIT.USAGE,
        { subcommands: JEV_SUBCOMMANDS },
        { code: 'usage.unknown_command', hint: `Subcomandos: ${JEV_SUBCOMMANDS.join(', ')}.` },
      );
  }
}
