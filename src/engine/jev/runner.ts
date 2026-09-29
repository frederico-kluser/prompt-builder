// Modo JEV — o RUNNER (`runJev`, §9): roda competidores de decisão (e LLMs) nos
// casos rotulados, pontua e grava o record. Fonte ÚNICA para Node e navegador:
// os seams (compliance, persistência, eventos, gateway) são INJETADOS — nada de
// `src/lgpd.ts` (Node) nem `storage.ts` aqui.
//
// Dinheiro e controle:
//   - toda chamada paga passa pelo gateway (`decide`/`chatCompletion`) com
//     role `competitor` + sink = ledger da run: contabilidade num ponto só;
//   - sem cap local de concorrência: o limitador AIMD do gateway manda;
//   - células nascem em ordem CASO-MAIOR e vão todas para um Promise.all: a
//     reserva é tomada ao nascer, então o estouro corta os ÚLTIMOS casos de
//     TODOS os competidores (pares honestos) e intercala competidores no tempo;
//   - `BudgetExceeded`/`RunCancelled` NUNCA viram nota: a célula sai `skipped`
//     (tratamento explícito do sinal — não é degradação) e o caso incompleto
//     fica FORA das métricas e comparações ("etapa cortada fica fora do placar");
//   - 400 do EDGE com problemas de esquema das perguntas = spec recusada:
//     fail-fast só daquele competidor (A3.4); se for o controle, a run inteira.

import { BudgetLedger, isBudgetSignal, isControlSignal, RunCancelled } from '../../budget.js';
import { makeCallEstimator } from '../../estimate.js';
import { getGateway, gatewayErrorKind, type OpenRouterGateway } from '../../openrouter.js';
import type { SensitiveRouting } from '../sensitiveRouting.js';
import type { PiiRunReport } from '../pii.js';
import type { ComplianceConfigLike } from '../lgpdCore.js';
import type { PiiConfigLike } from '../pii.js';
import type { CostRole, OpenRouterModel } from '../../types.js';
import type {
  DecisionsIssue,
  JevCase,
  JevCell,
  JevContestant,
  JevEvent,
  JevLintIssue,
  JevOwner,
  JevQuestionPolicy,
  JevRunRecord,
  JevScoredAnswer,
  JevSpec,
  ResolvedJevConfig,
} from './types.js';
import {
  buildDecisionsRequest,
  errorBodyFromMessage,
  expectedList,
  isSpecRejection,
  parseDecisionsError,
  validateDecisionsResponse,
  wireQuestionsOf,
} from './wire.js';
import { applyStrict, isRunnable, lintJevCases, lintJevSpec } from './lint.js';
import { jevComplianceView, snapshotOf } from './config.js';
import { answerWithLlm } from './llmContestant.js';
import {
  aggregateReps,
  cellIndex,
  compareToControl,
  headlineOf,
  inconclusiveReasons,
  policyFor,
  scoreDist,
  scoreRun,
  simulateCascade,
} from './scoring.js';
import { distFromAnswer } from './dist.js';
import { fitQuestionPolicy, type FitPoint } from './calibration.js';

/** Config inválida/lint com erro: nada foi gasto (CLI exit 3). Reconheça por `isJevConfigError`. */
export class JevConfigError extends Error {
  readonly code = 'JEV_CONFIG';
  readonly issues: JevLintIssue[];
  constructor(message: string, issues: JevLintIssue[]) {
    super(message);
    this.name = 'JevConfigError';
    this.issues = issues;
  }
}

export function isJevConfigError(err: unknown): err is JevConfigError {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'JEV_CONFIG');
}

export interface JevComplianceResult {
  sensitiveRouting?: SensitiveRouting;
  piiReport?: PiiRunReport;
}

export interface JevRunDeps {
  apiKey: string;
  /** Pré-atribuído (job/CLI). */
  runId?: string;
  signal?: AbortSignal;
  /** Raiz do teto (spend guards do CLI/MCP ou sessão de treino): a run usa um `fork()`. */
  parentLedger?: BudgetLedger;
  /** Default: a instância padrão (a SPA e o Node usam a MESMA via shim). */
  gateway?: OpenRouterGateway;
  /** Pré-voo LGPD/PII (Node: `enforceRunCompliance`; SPA: web/src/lgpd.ts). Lança = recusa. */
  compliance?: (view: ComplianceConfigLike & PiiConfigLike & Record<string, unknown>) => Promise<JevComplianceResult> | JevComplianceResult;
  emit?: (e: JevEvent) => void;
  /** Persistência (throttle ≥ 800 ms pelo runner + gravação final). */
  save?: (rec: JevRunRecord) => Promise<void>;
  client: 'node' | 'browser';
  now?: () => number;
  /** Narração (stderr no CLI — stdout é payload). */
  log?: (msg: string) => void;
  /** Perguntas perguntadas (treino: só as-alvo). Default: todas. */
  qids?: readonly string[];
  /** Casos avaliados (treino: train∪calib, depois holdout). Default: todos. */
  caseFilter?: (c: JevCase) => boolean;
  /** Sobrescreve `resolved.fit` (o treino ajusta a política por conta própria). */
  fit?: boolean;
  /** Pula o pré-voo (run aninhada no treino: a sessão já passou por ele). */
  skipCompliance?: boolean;
  /** Lint `--strict`. */
  strict?: boolean;
  /** Pula o lint (run aninhada no treino: a sessão já validou tudo, e os subconjuntos seriam "pequenos"). */
  skipLint?: boolean;
  sessionId?: string;
  iteration?: number;
  owner?: JevOwner;
  saveThrottleMs?: number;
}

const agora = (deps: JevRunDeps): number => (deps.now ? deps.now() : Date.now());

function newRunId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `jev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Lint completo de uma run (todas as specs × modelos de decisão, casos). */
export function lintResolved(
  r: ResolvedJevConfig,
  opts: { decisionCatalog?: readonly OpenRouterModel[]; qids?: readonly string[]; strict?: boolean; cases?: readonly JevCase[] } = {},
): JevLintIssue[] {
  const issues: JevLintIssue[] = [];
  const casos = opts.cases ?? r.cases;
  const alvo = r.train?.targetQuestions;
  const visto = new Set<string>();
  for (const ct of r.contestants) {
    const spec = r.specs.find((s) => s.id === ct.specId)!;
    const k = `${spec.id}\u0000${ct.kind === 'decision' ? ct.modelId : ''}`;
    if (visto.has(k)) continue;
    visto.add(k);
    const model = ct.kind === 'decision' ? opts.decisionCatalog?.find((m) => m.id === ct.modelId) : undefined;
    for (const i of lintJevSpec(spec, {
      ...(model ? { model } : {}),
      ...(ct.kind === 'decision' ? { modelId: ct.modelId } : {}),
      mode: r.mode,
      ...(alvo ? { targetQuestions: alvo } : {}),
      cases: casos,
    })) {
      const dup = issues.some((x) => x.code === i.code && x.questionId === i.questionId && x.path === i.path && x.message === i.message);
      if (!dup) issues.push(ct.kind === 'decision' && i.code.startsWith('budget.') ? { ...i, message: `[${ct.modelId}] ${i.message}` } : i);
    }
  }
  issues.push(...lintJevCases(casos, r.specs[0], { mode: r.mode, ...(alvo ? { targetQuestions: alvo } : {}) }));
  return applyStrict(issues, opts.strict);
}

interface PlannedCell {
  ct: JevContestant;
  spec: JevSpec;
  c: JevCase;
  rep: number;
  cold: boolean;
}

/** Roda uma run JEV (eval/compare, ou uma avaliação dentro do treino). */
export async function runJev(resolved: ResolvedJevConfig, deps: JevRunDeps): Promise<JevRunRecord> {
  const gateway = deps.gateway ?? getGateway();
  const log = deps.log ?? (() => undefined);
  const runId = deps.runId ?? newRunId();
  const casos = resolved.cases.filter((c) => (deps.caseFilter ? deps.caseFilter(c) : true));
  const specById = new Map(resolved.specs.map((s) => [s.id, s]));
  const qids = deps.qids ?? resolved.specs[0].questions.map((q) => q.id);

  // 1) Lint estrutural (sem catálogo): erro = nada gasto.
  const lint1 = deps.skipLint ? [] : lintResolved(resolved, { strict: deps.strict, cases: casos });
  if (!isRunnable(lint1)) {
    throw new JevConfigError(
      `definição/casos inválidos: ${lint1.filter((i) => i.level === 'error').slice(0, 4).map((i) => `${i.code} — ${i.message}`).join('; ')}`,
      lint1,
    );
  }

  // 2) Pré-voo LGPD/PII (fail-closed; lança = recusa ANTES de gastar).
  let compliance: JevComplianceResult = {};
  if (deps.compliance && !deps.skipCompliance) compliance = await deps.compliance(jevComplianceView({ ...resolved, cases: casos }));

  // 3) Catálogos no CACHE DO GATEWAY (A1.5): sem preço a reserva serializa.
  let decisionCatalog: OpenRouterModel[] = [];
  if (resolved.contestants.some((c) => c.kind === 'decision')) {
    try {
      decisionCatalog = await gateway.listDecisionModels(deps.apiKey);
    } catch (err) {
      log(`catálogo de decisões indisponível (${(err as Error).message}) — a reserva por chamada fica sem preço.`);
    }
  }
  let chatCatalog = gateway.peekModelsCache(deps.apiKey)?.data ?? [];
  if (resolved.contestants.some((c) => c.kind === 'llm') && chatCatalog.length === 0) {
    try {
      chatCatalog = await gateway.listModels(deps.apiKey);
    } catch (err) {
      log(`catálogo de chat indisponível (${(err as Error).message}).`);
    }
  }
  // Lint de orçamento de contexto POR MODELO (agora com o catálogo).
  const lint2 = deps.skipLint
    ? []
    : lintResolved(resolved, { decisionCatalog, strict: deps.strict, cases: casos }).filter((i) => i.code.startsWith('budget.'));
  if (!isRunnable(lint2)) {
    throw new JevConfigError(`estado grande demais para o contexto do modelo: ${lint2.filter((i) => i.level === 'error').map((i) => i.message).join('; ')}`, lint2);
  }

  // 4) Ledger: fork do pai (spend guards/sessão) ou raiz própria com o teto.
  const ledger =
    deps.parentLedger?.fork() ??
    new BudgetLedger({
      budgetUsd: resolved.budgetUsd,
      signal: deps.signal,
      estimateCall: makeCallEstimator([...chatCatalog, ...decisionCatalog]),
    });
  ledger.setSensitiveRouting(compliance.sensitiveRouting);

  // 5) Plano caso-maior.
  const plan: PlannedCell[] = [];
  const frio = new Set<string>();
  for (const c of casos) {
    for (const ct of resolved.contestants) {
      const spec = specById.get(ct.specId)!;
      for (let rep = 0; rep < resolved.repeats; rep++) {
        const cold = !frio.has(ct.id);
        frio.add(ct.id);
        plan.push({ ct, spec, c, rep, cold });
      }
    }
  }
  const requestsPlanned = plan.reduce((s, p) => s + (p.ct.kind === 'llm' && p.ct.batching !== 'per-case' ? qids.length : 1), 0);

  const record: JevRunRecord = {
    format: 'jev-run@1',
    id: runId,
    mode: resolved.mode,
    status: 'running',
    theme: resolved.theme,
    client: deps.client,
    config: snapshotOf(resolved),
    specs: resolved.specs,
    contestants: resolved.contestants,
    cases: casos,
    questionIds: [...qids],
    cells: [],
    progress: { requestsPlanned, requestsDone: 0, cellsPlanned: plan.length, cellsDone: 0, spentUsd: 0 },
    metrics: {},
    byQuestion: {},
    byType: {},
    confusion: {},
    incompleteCaseIds: [],
    warnings: lint1.filter((i) => i.level === 'warning').slice(0, 30).map((i) => `${i.code}: ${i.message}`),
    resolvedModels: {},
    cost: { totalUsd: 0, pendingUsd: 0, byRole: {}, byContestant: {}, byKind: { decision: 0, llm: 0, rewriter: 0 } },
    totalCostUsd: 0,
    ...(resolved.budgetUsd !== undefined ? { budgetUsd: resolved.budgetUsd } : {}),
    datasetHash: resolved.datasetHash,
    startedAt: new Date(agora(deps)).toISOString(),
    ...(deps.owner ? { owner: deps.owner } : {}),
    ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
    ...(deps.iteration !== undefined ? { iteration: deps.iteration } : {}),
    ...(compliance.piiReport ? { piiReport: compliance.piiReport } : {}),
  };

  // Persistência com throttle (≥ 800 ms) + gravação final garantida.
  const throttleMs = deps.saveThrottleMs ?? 800;
  let ultimoSave = 0;
  let salvando: Promise<void> | null = null;
  let pendente = false;
  const salvar = (): void => {
    if (!deps.save) return;
    const t = agora(deps);
    if (salvando || t - ultimoSave < throttleMs) {
      pendente = true;
      return;
    }
    ultimoSave = t;
    salvando = deps
      .save({ ...record, cells: [...record.cells] })
      .catch((err: unknown) => log(`falha ao gravar a run ${runId}: ${(err as Error).message}`))
      .finally(() => {
        salvando = null;
        if (pendente) {
          pendente = false;
          salvar();
        }
      });
  };

  deps.emit?.({
    type: 'jev.run.started',
    runId,
    mode: resolved.mode,
    cases: casos.length,
    contestants: resolved.contestants.map((c) => c.id),
    requestsPlanned,
  });
  if (deps.save) {
    ultimoSave = agora(deps);
    await deps.save({ ...record });
  }

  // 6) Execução.
  const rejected = new Map<string, DecisionsIssue[]>();
  const porCompetidor = new Map(resolved.contestants.map((ct) => [ct.id, new AbortController()]));
  const controle = resolved.contestants.find((c) => c.isControl) ?? resolved.contestants[0];
  let fatal: unknown = null;
  let budgetHit = false;
  const fatalCtl = new AbortController();
  let ultimoProgresso = 0;
  const casesById = new Map(casos.map((c) => [c.id, c]));

  const sinalDe = (ct: JevContestant): AbortSignal => {
    const sinais = [porCompetidor.get(ct.id)!.signal, fatalCtl.signal];
    if (deps.signal) sinais.push(deps.signal);
    return AbortSignal.any(sinais);
  };

  const concluir = (p: PlannedCell, cell: JevCell): JevCell => {
    record.cells.push(cell);
    record.progress.cellsDone += 1;
    if (cell.status !== 'skipped') record.progress.requestsDone += cell.requests ?? 1;
    record.progress.spentUsd = ledger.spentUsd;
    const correct: Record<string, boolean> = {};
    if (cell.status === 'ok' || cell.status === 'invalid') {
      for (const q of p.spec.questions) {
        if (!qids.includes(q.id)) continue;
        const gold = expectedList(p.c.expected[q.id]);
        if (!gold.length) continue;
        const oc = aggregateReps(q, [cell]);
        if (!oc.dist) continue;
        correct[q.id] = scoreDist(q, p.c.id, oc.dist, p.c.expected[q.id], policyFor(p.spec, q, resolved.bands), {
          tolerance: resolved.scoreTolerance,
          invalid: oc.invalid,
        }).correct;
      }
    }
    deps.emit?.({
      type: 'jev.cell.done',
      runId,
      caseId: cell.caseId,
      contestantId: cell.contestantId,
      rep: cell.rep,
      status: cell.status,
      correct,
      ...(typeof cell.latencyMs === 'number' ? { latencyMs: cell.latencyMs } : {}),
      ...(cell.cost ? { costUsd: cell.cost.usd } : {}),
    });
    const t = agora(deps);
    if (t - ultimoProgresso >= 1000 || record.progress.cellsDone === plan.length) {
      ultimoProgresso = t;
      deps.emit?.({
        type: 'jev.progress',
        runId,
        done: record.progress.cellsDone,
        total: plan.length,
        spentUsd: ledger.spentUsd,
        pendingUsd: ledger.pendingUsd,
      });
    }
    salvar();
    return cell;
  };

  const runCell = async (p: PlannedCell): Promise<JevCell> => {
    const base = { caseId: p.c.id, contestantId: p.ct.id, rep: p.rep, ...(p.cold ? { cold: true } : {}) };
    if (rejected.has(p.ct.id)) return concluir(p, { ...base, status: 'skipped', skippedBy: 'spec-rejected' });
    const signal = sinalDe(p.ct);
    try {
      if (p.ct.kind === 'decision') {
        const questions = wireQuestionsOf(p.spec, qids);
        const req = buildDecisionsRequest(p.spec, p.c.state, { model: p.ct.modelId, sessionId: runId, qids });
        const res = await gateway.decide({
          apiKey: deps.apiKey,
          modelId: p.ct.modelId,
          state: req.state,
          questions: req.questions,
          sessionId: runId,
          role: 'competitor',
          sink: ledger,
          signal,
        });
        const v = validateDecisionsResponse(questions, res.answers);
        const vistos = (record.resolvedModels[p.ct.modelId] ??= []);
        if (!vistos.includes(res.resolvedModel)) vistos.push(res.resolvedModel);
        const nInv = Object.keys(v.invalid).length;
        return concluir(p, {
          ...base,
          status: nInv === Object.keys(questions).length ? 'invalid' : 'ok',
          answers: v.answers,
          ...(nInv ? { invalid: v.invalid } : {}),
          requests: 1,
          latencyMs: res.latencyMs,
          cost: res.cost,
          tokensIn: res.tokensIn,
          tokensOut: res.tokensOut,
          resolvedModel: res.resolvedModel,
          ...(res.provider ? { provider: res.provider } : {}),
          ...(res.generationId ? { generationId: res.generationId } : {}),
        });
      }
      const r = await answerWithLlm(p.ct, p.spec, p.c, qids, { apiKey: deps.apiKey, gateway, sink: ledger, signal });
      const vistos = (record.resolvedModels[p.ct.modelId] ??= []);
      if (r.resolvedModel && !vistos.includes(r.resolvedModel)) vistos.push(r.resolvedModel);
      return concluir(p, { ...base, ...r });
    } catch (err) {
      // Sinal de controle: nunca vira nota. Recusa de spec daquele competidor,
      // orçamento ou cancelamento → célula `skipped` (fora de tudo).
      if (isControlSignal(err)) {
        const porRecusa = rejected.has(p.ct.id) && !deps.signal?.aborted && !isBudgetSignal(err);
        if (isBudgetSignal(err)) budgetHit = true;
        return concluir(p, {
          ...base,
          status: 'skipped',
          skippedBy: porRecusa ? 'spec-rejected' : isBudgetSignal(err) ? 'budget' : 'cancelled',
        });
      }
      if (fatalCtl.signal.aborted && fatal) {
        return concluir(p, { ...base, status: 'skipped', skippedBy: 'cancelled' });
      }
      const kind = gatewayErrorKind(err);
      const e = err as { message?: unknown; httpStatus?: unknown; code?: unknown; responseBody?: unknown };
      const message = typeof e?.message === 'string' ? e.message : String(err);
      // Falha de CONTA (401/402): derruba a run inteira (CLI exit 4/5).
      if (kind === 'auth' || kind === 'no_credit') {
        if (!fatal) fatal = err;
        fatalCtl.abort(new RunCancelled('falha de conta'));
        return concluir(p, { ...base, status: 'error', error: { kind, message: message.slice(0, 500) } });
      }
      // Recusa de política LGPD antes do fetch (o pré-voo devia ter pego): fatal.
      if (e?.code === 'LGPD_POLICY') {
        if (!fatal) fatal = err;
        fatalCtl.abort(new RunCancelled('LGPD'));
        return concluir(p, { ...base, status: 'blocked', error: { kind: 'lgpd', message: message.slice(0, 500) } });
      }
      if (kind === 'http' && e?.httpStatus === 400 && p.ct.kind === 'decision') {
        const issues = parseDecisionsError(400, typeof e.responseBody === 'string' ? e.responseBody : errorBodyFromMessage(message));
        if (isSpecRejection(issues)) {
          if (!rejected.has(p.ct.id)) {
            rejected.set(p.ct.id, issues);
            log(`${p.ct.label}: definição recusada pela API (400) — ${issues.map((i) => `${i.path}: ${i.message}`).slice(0, 3).join('; ')}`);
            porCompetidor.get(p.ct.id)!.abort(new RunCancelled('spec-rejected'));
            // Controle recusado = a run inteira não compara nada.
            if (p.ct.id === controle.id) {
              for (const ct of resolved.contestants) {
                if (!rejected.has(ct.id)) rejected.set(ct.id, []);
                porCompetidor.get(ct.id)!.abort(new RunCancelled('spec-rejected'));
              }
            }
          }
          return concluir(p, { ...base, status: 'error', error: { kind: 'spec_rejected', message: message.slice(0, 500), issues, httpStatus: 400 } });
        }
        return concluir(p, { ...base, status: 'error', error: { kind: 'http', message: message.slice(0, 500), issues, httpStatus: 400 } });
      }
      return concluir(p, {
        ...base,
        status: kind === 'blocked' ? 'blocked' : 'error',
        error: {
          kind: kind ?? 'error',
          message: message.slice(0, 500),
          ...(typeof e?.httpStatus === 'number' ? { httpStatus: e.httpStatus } : {}),
        },
      });
    }
  };

  await Promise.all(plan.map((p) => runCell(p)));
  if (salvando) await salvando;

  // 7) Fechamento.
  const cancelado = Boolean(deps.signal?.aborted) && !fatal;
  const incompletos = new Set<string>();
  for (const cell of record.cells) {
    if (cell.status === 'skipped' && cell.skippedBy !== 'spec-rejected') incompletos.add(cell.caseId);
  }
  record.incompleteCaseIds = [...incompletos].sort();
  if (rejected.size) record.rejected = Object.fromEntries(rejected);
  // Ordem estável das células (o plano), independentemente da ordem de chegada.
  const ordem = new Map(plan.map((p, i) => [`${p.c.id}\u0000${p.ct.id}\u0000${p.rep}`, i]));
  record.cells.sort((a, b) => (ordem.get(`${a.caseId}\u0000${a.contestantId}\u0000${a.rep}`) ?? 0) - (ordem.get(`${b.caseId}\u0000${b.contestantId}\u0000${b.rep}`) ?? 0));

  // Política ajustada no `calib` (fit), por competidor e pergunta.
  const fit = deps.fit ?? resolved.fit;
  let fitted: Record<string, Record<string, JevQuestionPolicy>> | undefined;
  if (fit) {
    fitted = fitPolicies(resolved, record.cells, casos.filter((c) => c.split === 'calib' && !incompletos.has(c.id)), qids, record.resolvedModels);
    if (Object.keys(fitted).length) record.policy = fitted;
  }
  const scored = scoreRun({
    specs: resolved.specs,
    contestants: resolved.contestants,
    cases: casos,
    cells: record.cells,
    questionIds: qids,
    bands: resolved.bands,
    tolerance: resolved.scoreTolerance,
    repeats: resolved.repeats,
    incompleteCaseIds: incompletos,
    ...(fitted ? { fitted } : {}),
  });
  record.metrics = scored.metrics;
  record.byQuestion = scored.byQuestion;
  record.byType = scored.byType;
  record.confusion = scored.confusion;

  const vivos = resolved.contestants.filter((c) => !rejected.has(c.id));
  if (resolved.mode === 'compare' && vivos.some((c) => c.id === controle.id)) {
    record.comparisons = vivos
      .filter((c) => c.id !== controle.id)
      .map((c) => compareToControl(controle.id, c.id, scored.items[controle.id] ?? [], scored.items[c.id] ?? [], resolved.primary));
    const decisoes = vivos.filter((c) => c.kind === 'decision');
    const llms = vivos.filter((c) => c.kind === 'llm');
    if (decisoes.length && llms.length) {
      record.cascade = [];
      for (const d of decisoes) {
        for (const l of llms) {
          record.cascade.push(
            simulateCascade({
              decisionId: d.id,
              llmId: l.id,
              decision: scored.items[d.id] ?? [],
              llm: scored.items[l.id] ?? [],
              decisionCostPer1k: scored.metrics[d.id]?.costPer1kDecisions ?? null,
              llmCostPer1k: scored.metrics[l.id]?.costPer1kDecisions ?? null,
            }),
          );
        }
      }
    }
  }

  // Inconclusivo (§8.4): > 10% sem nota ou < 5 pontuados numa pergunta com ouro.
  const planejadas: Record<string, number> = {};
  const semNota: Record<string, number> = {};
  for (const cell of record.cells) {
    if (incompletos.has(cell.caseId) || rejected.has(cell.contestantId)) continue;
    planejadas[cell.contestantId] = (planejadas[cell.contestantId] ?? 0) + 1;
    if (cell.status === 'error' || cell.status === 'blocked') semNota[cell.contestantId] = (semNota[cell.contestantId] ?? 0) + 1;
  }
  const motivos = cancelado ? [] : inconclusiveReasons(scored, vivos, planejadas, semNota);

  // Deriva de snapshot (J14): mais de um modelo resolvido para o mesmo pedido.
  for (const [pedido, vistos] of Object.entries(record.resolvedModels)) {
    if (vistos.length > 1) record.warnings.push(`snapshot-drift: ${pedido} resolveu para ${vistos.join(', ')} durante a run — números não comparáveis entre si.`);
  }

  // Custo: o ledger é a verdade (inclui o que falhou depois de despachado).
  const snap = ledger.snapshot();
  const byRole: Partial<Record<CostRole, number>> = {};
  for (const [role, e] of Object.entries(snap.byRole) as [CostRole, { usd: number; calls: number }][]) {
    if (e.calls > 0) byRole[role] = e.usd;
  }
  const byContestant: Record<string, number> = {};
  for (const cell of record.cells) byContestant[cell.contestantId] = (byContestant[cell.contestantId] ?? 0) + (cell.cost?.usd ?? 0);
  const kindOf = new Map(resolved.contestants.map((c) => [c.id, c.kind]));
  record.cost = {
    totalUsd: ledger.spentUsd,
    pendingUsd: ledger.pendingUsd,
    byRole,
    byContestant,
    byKind: {
      decision: Object.entries(byContestant).filter(([id]) => kindOf.get(id) === 'decision').reduce((s, [, v]) => s + v, 0),
      llm: Object.entries(byContestant).filter(([id]) => kindOf.get(id) === 'llm').reduce((s, [, v]) => s + v, 0),
      rewriter: 0,
    },
    ledger: ledger.summary(),
  };
  record.totalCostUsd = ledger.spentUsd;
  record.progress.spentUsd = ledger.spentUsd;
  record.finishedAt = new Date(agora(deps)).toISOString();

  const todasDecisaoRecusadas =
    resolved.contestants.some((c) => c.kind === 'decision') &&
    resolved.contestants.filter((c) => c.kind === 'decision').every((c) => rejected.has(c.id));
  if (fatal) {
    record.status = 'error';
    record.error = (fatal as Error).message ?? String(fatal);
  } else if (cancelado) {
    record.status = 'aborted';
    record.stoppedReason = 'cancelled';
  } else if (rejected.has(controle.id) || todasDecisaoRecusadas) {
    record.status = 'error';
    record.stoppedReason = 'spec-rejected';
    const issues = [...rejected.values()].flat();
    record.error = `definição recusada pela API (400): ${issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`).join('; ') || 'ver rejected'}`;
  } else {
    if (budgetHit) {
      record.stoppedReason = 'budget';
      record.budgetExhausted = true;
      deps.emit?.({ type: 'jev.budget.exhausted', spentUsd: ledger.spentUsd, budgetUsd: resolved.budgetUsd ?? 0 });
    }
    if (motivos.length) {
      record.status = 'inconclusive';
      record.inconclusiveReasons = motivos;
    } else {
      record.status = 'finished';
    }
  }
  for (const ct of resolved.contestants) {
    const m = record.metrics[ct.id];
    if (m) deps.emit?.({ type: 'jev.contestant.done', runId, contestantId: ct.id, metrics: headlineOf(m) });
  }
  deps.emit?.({ type: 'jev.run.finished', runId, status: record.status, ...(record.stoppedReason ? { stoppedReason: record.stoppedReason } : {}) });
  if (deps.save) await deps.save(record);
  if (fatal) throw fatal;
  return record;
}

/**
 * Política ajustada (T + limiares) de cada competidor/pergunta no split
 * `calib` — casos de fora do `calib` nunca entram no ajuste.
 */
export function fitPolicies(
  resolved: ResolvedJevConfig,
  cells: readonly JevCell[],
  calibCases: readonly JevCase[],
  qids: readonly string[],
  resolvedModels: Record<string, string[]>,
  split: 'calib' | 'train' = 'calib',
): Record<string, Record<string, JevQuestionPolicy>> {
  const out: Record<string, Record<string, JevQuestionPolicy>> = {};
  if (!calibCases.length) return out;
  const idx = cellIndex(cells);
  for (const ct of resolved.contestants) {
    const spec = resolved.specs.find((s) => s.id === ct.specId);
    if (!spec) continue;
    for (const q of spec.questions) {
      if (!qids.includes(q.id)) continue;
      const pontos: FitPoint[] = [];
      for (const c of calibCases) {
        const gold = expectedList(c.expected[q.id]);
        if (!gold.length) continue;
        const oc = aggregateReps(q, idx.get(`${c.id}\u0000${ct.id}`) ?? []);
        if (!oc.dist) continue;
        const it: JevScoredAnswer = scoreDist(q, c.id, oc.dist, c.expected[q.id], policyFor(spec, q, resolved.bands), {
          tolerance: resolved.scoreTolerance,
          invalid: oc.invalid,
        });
        pontos.push({ dist: oc.dist, expected: gold, correct: it.correct, ...(oc.invalid ? { invalid: true } : {}) });
      }
      const pol = fitQuestionPolicy(q, policyFor(spec, q, resolved.bands), pontos, {
        targetPrecision: resolved.targetPrecision,
        split,
        ...(resolvedModels[ct.modelId]?.[0] ? { resolvedModel: resolvedModels[ct.modelId][0] } : {}),
      });
      if (!pol.fitted) continue;
      const { fitted: _f, ...politica } = pol;
      (out[ct.id] ??= {})[q.id] = politica;
    }
  }
  return out;
}

/** Distribuição de uma resposta crua (reexport útil a relatórios). */
export { distFromAnswer };
