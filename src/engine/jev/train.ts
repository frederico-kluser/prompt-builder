// Modo JEV — EVOLUÇÃO da definição (`trainJev`, §11). Laço próprio (não o
// `trainer.ts`, que dirige juiz/gabarito/duelos): a avaliação é barata e tem
// régua determinística, então cada ciclo avalia o TREINO INTEIRO, sem
// minibatch e sem juiz. Só COMPÕE peças puras que já existem:
// `bestOfKTest`/`resolveMinGain`/`winnersCurseInflation` (gate),
// `pairedSignificance` (holdout) e `shouldStopForPatience`.
//
// Honestidade estatística (crítica A2):
//   - vetores por caso na escala 0–1 (1 − Brier calibrado), já agregados nas
//     reps e ALINHADOS por caseId antes do teste posicional;
//   - T ajustado POR VARIANTE no `calib` (ganha a definição, não a variante
//     que só está mais bem calibrada — a política corrige calibração em código);
//   - casos copiados como EXEMPLO para uma rubrica saem dos pares do gate
//     daquela iteração (senão a variante vence por eco);
//   - holdout intocado até o fim; dossiê e exemplos só do `train`.

import { BudgetLedger, isBudgetSignal, isControlSignal } from '../../budget.js';
import { makeCallEstimator } from '../../estimate.js';
import { getGateway, type OpenRouterGateway } from '../../openrouter.js';
import { pairedSignificance } from '../../stats.js';
import { GATE_ALPHA, bestOfKTest, resolveMinGain, winnersCurseInflation } from '../bestOfK.js';
import { shouldStopForPatience } from '../trainingPolicy.js';
import { MIN_HOLDOUT_SCENARIOS, holdoutStrength } from '../../holdout.js';
import type { CostRole, OpenRouterModel } from '../../types.js';
import type {
  JevCase,
  JevContestant,
  JevEvent,
  JevHoldout,
  JevIterationCandidate,
  JevIterationRecord,
  JevLintIssue,
  JevOwner,
  JevQuestionPolicy,
  JevRunRecord,
  JevSessionRecord,
  JevSpec,
  ResolvedJevConfig,
} from './types.js';
import { expectedList, hasGold } from './wire.js';
import { isRunnable, MIN_TRAIN_LABELED } from './lint.js';
import { jevComplianceView, shortModel, snapshotOf, withSpecId } from './config.js';
import { applyTemperature, type Dist } from './dist.js';
import { aggregateReps, cellIndex, policyFor, scoreDist, scoreRun } from './scoring.js';
import { fitQuestionPolicy, fitTemperature, type FitPoint } from './calibration.js';
import { JevConfigError, lintResolved, runJev, type JevRunDeps } from './runner.js';
import { buildJevDossier, type JevDossier } from './dossier.js';
import { pickOperators } from './techniques.js';
import { addExamples, proposeQuestionVariant, withQuestion } from './rewriter.js';
import { checkVariantContract } from './contract.js';

export interface JevTrainDeps {
  apiKey: string;
  sessionId?: string;
  signal?: AbortSignal;
  parentLedger?: BudgetLedger;
  gateway?: OpenRouterGateway;
  compliance?: JevRunDeps['compliance'];
  emit?: (e: JevEvent) => void;
  saveRun?: (rec: JevRunRecord) => Promise<void>;
  saveSession?: (s: JevSessionRecord) => Promise<void>;
  client: 'node' | 'browser';
  log?: (msg: string) => void;
  now?: () => number;
  owner?: JevOwner;
  strict?: boolean;
}

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `jevs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

interface CaseScore {
  /** 1 − Brier (com T), média das perguntas. */
  score: number | null;
  acc: number | null;
}

/** Pontos de ajuste de T por pergunta (casos de calibração). */
function fitPoints(run: JevRunRecord, spec: JevSpec, ctId: string, qid: string, cases: readonly JevCase[]): FitPoint[] {
  const q = spec.questions.find((x) => x.id === qid);
  if (!q) return [];
  const idx = cellIndex(run.cells);
  const out: FitPoint[] = [];
  for (const c of cases) {
    const gold = expectedList(c.expected[qid]);
    if (!gold.length) continue;
    const oc = aggregateReps(q, idx.get(`${c.id}\u0000${ctId}`) ?? []);
    if (!oc.dist) continue;
    const it = scoreDist(q, c.id, oc.dist, c.expected[qid], policyFor(spec, q, run.config.bands), {
      tolerance: run.config.scoreTolerance,
      invalid: oc.invalid,
    });
    out.push({ dist: oc.dist, expected: gold, correct: it.correct, ...(oc.invalid ? { invalid: true } : {}) });
  }
  return out;
}

/** Score por caso (0–1) de um competidor numa run, com T por pergunta. */
function caseScores(
  run: JevRunRecord,
  spec: JevSpec,
  ctId: string,
  cases: readonly JevCase[],
  qids: readonly string[],
  temps: Record<string, number>,
): Map<string, CaseScore> {
  const idx = cellIndex(run.cells);
  const out = new Map<string, CaseScore>();
  for (const c of cases) {
    const reps = idx.get(`${c.id}\u0000${ctId}`) ?? [];
    const briers: number[] = [];
    const accs: number[] = [];
    for (const qid of qids) {
      const q = spec.questions.find((x) => x.id === qid);
      if (!q || !hasGold(c, qid)) continue;
      const oc = aggregateReps(q, reps);
      if (!oc.dist) continue;
      const pol = policyFor(spec, q, run.config.bands);
      const raw = scoreDist(q, c.id, oc.dist, c.expected[qid], pol, { tolerance: run.config.scoreTolerance, invalid: oc.invalid });
      const d: Dist = applyTemperature(oc.dist, temps[qid]);
      const cal = scoreDist(q, c.id, d, c.expected[qid], pol, { tolerance: run.config.scoreTolerance, invalid: oc.invalid });
      if (cal.brier !== null) briers.push(oc.invalid ? 0 : 1 - cal.brier);
      accs.push(raw.correct ? 1 : 0);
    }
    out.set(c.id, { score: briers.length ? mean(briers) : null, acc: accs.length ? mean(accs) : null });
  }
  return out;
}

/** Tokens de entrada médios por request de um competidor (custo de USAR a definição). */
function meanTokensIn(run: JevRunRecord, ctId: string): number | null {
  const cs = run.cells.filter((c) => c.contestantId === ctId && typeof c.tokensIn === 'number' && c.status !== 'skipped');
  return cs.length ? mean(cs.map((c) => c.tokensIn as number)) : null;
}

function contestantFor(spec: JevSpec, modelId: string, isControl: boolean): JevContestant {
  return {
    id: `d:${spec.label}@${modelId}`,
    label: `${shortModel(modelId)} · ${spec.label}`,
    kind: 'decision',
    modelId,
    specId: spec.id,
    probabilitySource: 'native',
    ...(isControl ? { isControl: true } : {}),
  };
}

/** Evolui a definição de decisão. Devolve a sessão (record) já gravada. */
export async function trainJev(resolved: ResolvedJevConfig, deps: JevTrainDeps): Promise<JevSessionRecord> {
  const t = resolved.train;
  if (!t) throw new JevConfigError('modo train exige o bloco `train`', []);
  const gateway = deps.gateway ?? getGateway();
  const log = deps.log ?? (() => undefined);
  const agora = (): number => (deps.now ? deps.now() : Date.now());
  const sessionId = deps.sessionId ?? newId();
  const original = resolved.specs[0];
  const decisionCt = resolved.contestants.find((c) => c.kind === 'decision');
  if (!decisionCt) throw new JevConfigError('modo train exige um modelo de decisão', []);
  const modelId = decisionCt.modelId;

  // 1) Lint da sessão inteira (modo train: degeneradas e poucos casos viram ERRO).
  const lint = lintResolved(resolved, { strict: deps.strict });
  if (!isRunnable(lint)) {
    const poucos = lint.some((i) => i.level === 'error' && (i.code === 'cases.too_few' || i.code === 'question.no_gold'));
    const erros = lint.filter((i) => i.level === 'error');
    throw new JevConfigError(
      `${poucos ? 'jev.dataset_too_small: ' : ''}${erros.slice(0, 4).map((i) => `${i.code} — ${i.message}`).join('; ')}`,
      lint,
    );
  }
  const trainCases = resolved.cases.filter((c) => c.split === 'train');
  for (const qid of t.targetQuestions) {
    const n = trainCases.filter((c) => hasGold(c, qid)).length;
    if (n < Math.ceil(MIN_TRAIN_LABELED / 2)) {
      const issue: JevLintIssue = {
        level: 'error',
        code: 'jev.dataset_too_small',
        questionId: qid,
        message: `"${qid}" tem ${n} caso(s) rotulado(s) no split de treino — pouco para o gate decidir.`,
      };
      throw new JevConfigError(`jev.dataset_too_small: ${issue.message}`, [...lint, issue]);
    }
  }

  // 2) Pré-voo LGPD/PII UMA vez (as runs aninhadas pulam).
  const comp = deps.compliance ? await deps.compliance(jevComplianceView(resolved)) : {};

  // 3) Catálogos no cache do gateway + ledger da SESSÃO (as runs são forks).
  let decisionCatalog: OpenRouterModel[] = [];
  try {
    decisionCatalog = await gateway.listDecisionModels(deps.apiKey);
  } catch (err) {
    log(`catálogo de decisões indisponível (${(err as Error).message}) — a reserva por chamada fica sem preço.`);
  }
  const chatCatalog = gateway.peekModelsCache(deps.apiKey)?.data ?? [];
  const ledger =
    deps.parentLedger?.fork() ??
    new BudgetLedger({ budgetUsd: resolved.budgetUsd, signal: deps.signal, estimateCall: makeCallEstimator([...chatCatalog, ...decisionCatalog]) });
  ledger.setSensitiveRouting(comp.sensitiveRouting);

  const calibIsTrain = !resolved.cases.some((c) => c.split === 'calib');
  const calibCases = calibIsTrain ? trainCases : resolved.cases.filter((c) => c.split === 'calib');
  const holdoutCases = resolved.cases.filter((c) => c.split === 'holdout');
  const avaliados = (c: JevCase): boolean => c.split !== 'holdout';
  const allQids = original.questions.map((q) => q.id);

  const session: JevSessionRecord = {
    format: 'jev-session@1',
    id: sessionId,
    status: 'running',
    theme: resolved.theme,
    config: snapshotOf(resolved),
    modelId,
    originalSpec: original,
    championSpec: original,
    iterations: [],
    runIds: [],
    policy: {},
    cost: { totalUsd: 0, pendingUsd: 0, byRole: {}, byContestant: {}, byKind: { decision: 0, llm: 0, rewriter: 0 } },
    totalCostUsd: 0,
    ...(resolved.budgetUsd !== undefined ? { budgetUsd: resolved.budgetUsd } : {}),
    resolvedModels: [],
    warnings: [
      ...(calibIsTrain ? ['calibração ajustada no próprio treino (poucos casos para separar um split `calib`).'] : []),
      ...lint.filter((i) => i.level === 'warning').slice(0, 20).map((i) => `${i.code}: ${i.message}`),
    ],
    startedAt: new Date(agora()).toISOString(),
    ...(deps.owner ? { owner: deps.owner } : {}),
  };
  const salvarSessao = async (): Promise<void> => {
    const snap = ledger.snapshot();
    const byRole: Partial<Record<CostRole, number>> = {};
    for (const [role, e] of Object.entries(snap.byRole) as [CostRole, { usd: number; calls: number }][]) if (e.calls > 0) byRole[role] = e.usd;
    session.cost = {
      totalUsd: ledger.spentUsd,
      pendingUsd: ledger.pendingUsd,
      byRole,
      byContestant: session.cost.byContestant,
      byKind: { decision: byRole.competitor ?? 0, llm: 0, rewriter: byRole.rewriter ?? 0 },
      ledger: ledger.summary(),
    };
    session.totalCostUsd = ledger.spentUsd;
    if (deps.saveSession) await deps.saveSession(session);
  };
  await salvarSessao();

  const avaliar = async (
    specs: JevSpec[],
    iteration: number,
    qids: readonly string[],
    filtro: (c: JevCase) => boolean,
  ): Promise<{ run: JevRunRecord; cts: JevContestant[] }> => {
    const cts = specs.map((s, i) => contestantFor(s, modelId, i === 0));
    const sub: ResolvedJevConfig = { ...resolved, mode: 'compare', specs, contestants: cts, repeats: t.repeats, fit: false };
    const run = await runJev(sub, {
      apiKey: deps.apiKey,
      gateway,
      parentLedger: ledger,
      ...(deps.signal ? { signal: deps.signal } : {}),
      client: deps.client,
      qids,
      caseFilter: filtro,
      fit: false,
      skipLint: true,
      skipCompliance: true,
      sessionId,
      iteration,
      ...(deps.saveRun ? { save: deps.saveRun } : {}),
      ...(deps.emit ? { emit: deps.emit } : {}),
      log,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.owner ? { owner: deps.owner } : {}),
    });
    session.runIds.push(run.id);
    for (const vistos of Object.values(run.resolvedModels)) for (const v of vistos) if (!session.resolvedModels.includes(v)) session.resolvedModels.push(v);
    for (const [ct, usd] of Object.entries(run.cost.byContestant)) session.cost.byContestant[ct] = (session.cost.byContestant[ct] ?? 0) + usd;
    return { run, cts };
  };

  let champion = original;
  let championRun: { run: JevRunRecord; ctId: string } | null = null;
  let originalRun: { run: JevRunRecord; ctId: string } | null = null;
  let snapshot0: string | undefined;
  let streak = 0;
  const usados = new Set<string>();
  const parada = (run: JevRunRecord): JevSessionRecord['stoppedReason'] | undefined =>
    run.stoppedReason === 'budget' ? 'budget' : run.stoppedReason === 'cancelled' ? 'cancelled' : undefined;

  try {
    // 4) Ciclo 0 (baseline): original em train ∪ calib, só perguntas-alvo.
    const base = await avaliar([original], 0, t.targetQuestions, avaliados);
    championRun = originalRun = { run: base.run, ctId: base.cts[0].id };
    snapshot0 = base.run.resolvedModels[modelId]?.[0];
    const baseScores = caseScores(base.run, original, base.cts[0].id, trainCases, t.targetQuestions, {});
    const baseVals = [...baseScores.values()].map((s) => s.score).filter((x): x is number => x !== null);
    session.iterations.push({
      iteration: 0,
      runId: base.run.id,
      controlSpecId: original.id,
      candidates: [],
      gate: {
        metric: t.metric,
        controlScorePp: baseVals.length ? 100 * mean(baseVals) : null,
        meanDiffPp: [],
        pRaw: [],
        pAdjusted: [],
        minGainPp: t.minGainPp,
        winnersCurseInflationPp: 0,
        excludedExampleCaseIds: [],
        nPairs: baseVals.length,
        decision: 'baseline',
      },
      costUsd: base.run.cost.totalUsd,
      ...(snapshot0 ? { resolvedModel: snapshot0 } : {}),
    });
    await salvarSessao();
    session.stoppedReason = parada(base.run);

    // 5) Ciclos.
    for (let it = 1; it <= t.iterations && !session.stoppedReason; it++) {
      const gastoAntes = ledger.spentUsd;
      const dossies: Record<string, JevDossier | null> = {};
      for (const qid of t.targetQuestions) {
        dossies[qid] = buildJevDossier(championRun!.run, champion, championRun!.ctId, qid, trainCases);
      }
      const tipos = Object.fromEntries(champion.questions.map((q) => [q.id, q.type]));
      const picks = pickOperators({
        operators: t.operators,
        targets: t.targetQuestions,
        k: t.variantsPerIteration,
        used: usados,
        lint: lint,
        confusedPairs: Object.fromEntries(t.targetQuestions.map((q) => [q, (dossies[q]?.topConfusions[0]?.n ?? 0) >= 3])),
        emptyRubrics: Object.fromEntries(
          champion.questions
            .filter((q) => q.type === 'choice')
            .map((q) => [q.id, Object.values((q as { criteria: Record<string, unknown> }).criteria).some((v) => v === null || (typeof v === 'string' && v.trim().split(/\s+/).length <= 1))]),
        ),
        types: tipos,
      });
      const candidatos: JevIterationCandidate[] = [];
      const aceitos: JevSpec[] = [];
      const exemplosIter = new Set<string>();
      let porSlot = 1;
      for (const pk of picks) {
        usados.add(`${pk.operatorId}\u0000${pk.questionId}`);
        const rotulo = `c${it}.${candidatos.length + 1}-${pk.operatorId}-${pk.questionId}`;
        let filha: JevSpec | null = null;
        let motivo: string | undefined;
        if (pk.operatorId === 'add_examples') {
          const r = addExamples(champion, pk.questionId, trainCases, porSlot++);
          if (r) {
            filha = { ...r.spec, label: rotulo, origin: { ...r.spec.origin!, iteration: it } };
            r.exampleCaseIds.forEach((id) => exemplosIter.add(id));
          } else motivo = 'sem casos de treino para exemplos';
        } else if (t.rewriterModelId) {
          const q = champion.questions.find((x) => x.id === pk.questionId)!;
          try {
            const r = await proposeQuestionVariant({
              question: q,
              operator: pk.operatorId,
              dossier: dossies[pk.questionId] ?? null,
              rewriterModelId: t.rewriterModelId,
              ctx: { apiKey: deps.apiKey, gateway, sink: ledger, ...(deps.signal ? { signal: deps.signal } : {}) },
            });
            if (r.ok) {
              filha = withQuestion(champion, r.question, { kind: 'rewriter', parentId: champion.id, operatorId: pk.operatorId, iteration: it });
              filha = { ...filha, label: rotulo };
            } else motivo = r.reason;
          } catch (err) {
            if (isControlSignal(err)) throw err;
            motivo = `proponente falhou: ${(err as Error).message}`.slice(0, 300);
          }
        } else motivo = 'sem rewriterModelId';
        if (!filha) {
          candidatos.push({ specId: '', label: rotulo, operatorId: pk.operatorId, status: 'proposal-failed', ...(motivo ? { reason: motivo } : {}) });
          continue;
        }
        filha = withSpecId(filha);
        const ok = checkVariantContract(champion, filha, { targetQuestions: t.targetQuestions, cases: trainCases, modelId });
        if (!ok.ok) {
          candidatos.push({ specId: filha.id, label: rotulo, operatorId: pk.operatorId, status: 'rejected-local', reason: ok.reason });
          continue;
        }
        if (aceitos.some((a) => a.id === filha!.id)) {
          candidatos.push({ specId: filha.id, label: rotulo, operatorId: pk.operatorId, status: 'rejected-local', reason: 'duplicada de outra variante' });
          continue;
        }
        aceitos.push(filha);
        candidatos.push({ specId: filha.id, label: rotulo, operatorId: pk.operatorId, status: 'evaluated' });
      }

      if (!aceitos.length) {
        streak += 1;
        session.iterations.push({
          iteration: it,
          controlSpecId: champion.id,
          candidates: candidatos,
          gate: {
            metric: t.metric,
            controlScorePp: null,
            meanDiffPp: [],
            pRaw: [],
            pAdjusted: [],
            minGainPp: t.minGainPp,
            winnersCurseInflationPp: 0,
            excludedExampleCaseIds: [],
            nPairs: 0,
            decision: 'held',
            heldBy: ['nenhuma variante passou no contrato'],
          },
          costUsd: ledger.spentUsd - gastoAntes,
        });
        deps.emit?.({ type: 'jev.iteration.gated', sessionId, iteration: it, decision: 'held', gainPp: null, pAdjusted: null, costUsd: ledger.spentUsd - gastoAntes });
        await salvarSessao();
        if (shouldStopForPatience(streak, t.patience)) session.stoppedReason = 'patience';
        continue;
      }

      // Avaliação intercalada: campeã (carry) + variantes, train ∪ calib, só alvo.
      const campeaCarry: JevSpec = { ...champion, label: `campea-c${it}` };
      const { run, cts } = await avaliar([campeaCarry, ...aceitos], it, t.targetQuestions, avaliados);
      const drift = snapshot0 !== undefined && (run.resolvedModels[modelId] ?? []).some((m) => m !== snapshot0);
      const paradaRun = parada(run);

      // T por competidor no calib (só com a métrica brier-cal).
      const temps = cts.map((ct, i) => {
        const spec = i === 0 ? campeaCarry : aceitos[i - 1];
        if (t.metric !== 'brier-cal') return {} as Record<string, number>;
        return Object.fromEntries(t.targetQuestions.map((qid) => [qid, fitTemperature(fitPoints(run, spec, ct.id, qid, calibCases))]));
      });
      // Gate SÓ no train, SEM os casos que viraram exemplo nesta iteração (A2.6).
      const ids = trainCases.filter((c) => !exemplosIter.has(c.id) && !run.incompleteCaseIds.includes(c.id)).map((c) => c.id).sort();
      const casos = trainCases.filter((c) => ids.includes(c.id));
      const porCt = cts.map((ct, i) => caseScores(run, i === 0 ? campeaCarry : aceitos[i - 1], ct.id, casos, t.targetQuestions, temps[i]));
      const valor = (m: Map<string, CaseScore>, id: string): number | null => {
        const s = m.get(id);
        if (!s) return null;
        return t.metric === 'accuracy' ? s.acc : s.score;
      };
      const ctrlVec = ids.map((id) => valor(porCt[0], id));
      const varVecs = porCt.slice(1).map((m) => ids.map((id) => valor(m, id)));
      const bk = bestOfKTest(ctrlVec, varVecs, { method: 'max-t' });
      const wc = winnersCurseInflation(ctrlVec, varVecs);
      let melhor = -1;
      bk.meanDiff.forEach((d, k) => {
        if (Number.isFinite(d) && (melhor < 0 || d > bk.meanDiff[melhor])) melhor = k;
      });
      const ctrlVals = ctrlVec.filter((x): x is number => x !== null);
      const heldBy: string[] = [];
      let decision: JevIterationRecord['gate']['decision'] = 'held';
      let accDelta: number | null = null;
      let minGainPp = t.minGainPp;
      if (melhor < 0 || bk.nEfetivo[melhor] < 5) {
        decision = 'inconclusive';
        heldBy.push('pares insuficientes (< 5) para o teste');
      } else {
        minGainPp = resolveMinGain(t.minGainPp, bk.nEfetivo[melhor]).minGain;
        const accC = ids.map((id) => porCt[0].get(id)?.acc ?? null);
        const accV = ids.map((id) => porCt[melhor + 1].get(id)?.acc ?? null);
        const pares = accC.map((a, i) => [a, accV[i]]).filter((p): p is [number, number] => p[0] !== null && p[1] !== null);
        accDelta = pares.length ? 100 * mean(pares.map(([a, b]) => b - a)) : null;
        if (bk.pAdjusted[melhor] > GATE_ALPHA) heldBy.push(`p ajustado ${bk.pAdjusted[melhor].toFixed(3)} > ${GATE_ALPHA}`);
        if (bk.meanDiff[melhor] * 100 < minGainPp) heldBy.push(`ganho ${(bk.meanDiff[melhor] * 100).toFixed(2)} p.p. < minGain ${minGainPp} p.p.`);
        if (accDelta !== null && accDelta < -t.maxAccuracyDropPp) heldBy.push(`acurácia caiu ${accDelta.toFixed(2)} p.p. (> ${t.maxAccuracyDropPp})`);
        if (t.maxCostIncreasePct !== undefined) {
          const a = meanTokensIn(run, cts[0].id);
          const b = meanTokensIn(run, cts[melhor + 1].id);
          if (a && b && ((b - a) / a) * 100 > t.maxCostIncreasePct) heldBy.push(`custo por request +${(((b - a) / a) * 100).toFixed(1)}% > ${t.maxCostIncreasePct}%`);
        }
        if (drift) heldBy.push('snapshot do modelo mudou durante a sessão');
        if (paradaRun) heldBy.push(`run parada (${paradaRun}) — ciclo incompleto`);
        decision = heldBy.length ? 'held' : 'promoted';
      }
      const rec: JevIterationRecord = {
        iteration: it,
        runId: run.id,
        controlSpecId: champion.id,
        candidates: candidatos,
        gate: {
          metric: t.metric,
          controlScorePp: ctrlVals.length ? 100 * mean(ctrlVals) : null,
          ...(melhor >= 0 ? { bestSpecId: aceitos[melhor].id, bestScorePp: ctrlVals.length ? 100 * (mean(ctrlVals) + bk.meanDiff[melhor]) : null } : {}),
          meanDiffPp: bk.meanDiff.map((d) => (Number.isFinite(d) ? Number((d * 100).toFixed(3)) : null)),
          pRaw: bk.pRaw,
          pAdjusted: bk.pAdjusted,
          minGainPp,
          ...(accDelta !== null ? { accuracyDeltaPp: Number(accDelta.toFixed(3)) } : {}),
          winnersCurseInflationPp: Number((wc.inflation * 100).toFixed(3)),
          excludedExampleCaseIds: [...exemplosIter].sort(),
          nPairs: ids.length,
          decision,
          ...(heldBy.length ? { heldBy } : {}),
        },
        costUsd: ledger.spentUsd - gastoAntes,
        ...(run.resolvedModels[modelId]?.[0] ? { resolvedModel: run.resolvedModels[modelId][0] } : {}),
      };
      session.iterations.push(rec);
      if (decision === 'promoted') {
        const nova = aceitos[melhor];
        champion = { ...nova, label: `campea-c${it}` };
        championRun = { run, ctId: cts[melhor + 1].id };
        session.championSpec = champion;
        streak = 0;
      } else {
        streak += 1;
        championRun = { run, ctId: cts[0].id };
      }
      deps.emit?.({
        type: 'jev.iteration.gated',
        sessionId,
        iteration: it,
        decision,
        gainPp: melhor >= 0 && Number.isFinite(bk.meanDiff[melhor]) ? Number((bk.meanDiff[melhor] * 100).toFixed(3)) : null,
        pAdjusted: melhor >= 0 ? bk.pAdjusted[melhor] : null,
        costUsd: rec.costUsd,
      });
      await salvarSessao();
      if (drift) session.stoppedReason = 'snapshot-drift';
      else if (paradaRun) session.stoppedReason = paradaRun;
      else if (shouldStopForPatience(streak, t.patience)) {
        session.stoppedReason = 'patience';
        session.convergedAtIteration = it;
      }
    }
  } catch (err) {
    if (!isControlSignal(err)) {
      session.status = 'error';
      session.error = (err as Error).message ?? String(err);
      session.finishedAt = new Date(agora()).toISOString();
      await salvarSessao().catch(() => undefined);
      throw err;
    }
    session.stoppedReason = isBudgetSignal(err) ? 'budget' : 'cancelled';
  }

  // 6) Política final (T + limiares) no calib: campeã e original.
  const politicaDe = (alvo: { run: JevRunRecord; ctId: string } | null, spec: JevSpec): Record<string, JevQuestionPolicy> => {
    const out: Record<string, JevQuestionPolicy> = {};
    if (!alvo) return out;
    for (const qid of t.targetQuestions) {
      const q = spec.questions.find((x) => x.id === qid);
      if (!q) continue;
      const pol = fitQuestionPolicy(q, policyFor(spec, q, resolved.bands), fitPoints(alvo.run, spec, alvo.ctId, qid, calibCases), {
        targetPrecision: t.targetPrecision,
        split: calibIsTrain ? 'train' : 'calib',
        ...(snapshot0 ? { resolvedModel: snapshot0 } : {}),
      });
      const { fitted: _f, ...resto } = pol;
      out[qid] = resto;
    }
    return out;
  };
  const championSpecForRun = championRun ? championRun.run.specs.find((s) => s.id === champion.id) ?? champion : champion;
  session.policy = politicaDe(championRun, championSpecForRun);
  session.originalPolicy = politicaDe(originalRun, original);

  // 7) Holdout: original × campeã, TODAS as perguntas, com a política ajustada.
  const mudou = champion.id !== original.id;
  const cancelado = session.stoppedReason === 'cancelled' || Boolean(deps.signal?.aborted);
  if (!mudou) {
    session.holdout = {
      runId: '',
      n: holdoutCases.length,
      strength: holdoutStrength(holdoutCases.length),
      comparison: null,
      original: null,
      champion: null,
      regressed: false,
      text: 'sem mudança: a definição original seguiu campeã — holdout não rodado (nada a confirmar).',
    };
  } else if (!holdoutCases.length || cancelado || session.stoppedReason === 'budget') {
    session.holdout = {
      runId: '',
      n: holdoutCases.length,
      strength: holdoutStrength(holdoutCases.length),
      comparison: null,
      original: null,
      champion: null,
      regressed: false,
      text: holdoutCases.length
        ? `confirmação fraca: holdout (n=${holdoutCases.length} casos) pulado por ${cancelado ? 'cancelamento' : 'orçamento'} — sem confirmação contra sobreajuste`
        : 'confirmação fraca: sem casos de holdout — sem confirmação contra sobreajuste',
    };
  } else {
    try {
      const origH = { ...original, label: 'original-holdout' };
      const campH = { ...champion, label: 'campea-holdout' };
      const { run, cts } = await avaliar([origH, campH], t.iterations + 1, allQids, (c) => c.split === 'holdout');
      const fitted = {
        [cts[0].id]: session.originalPolicy ?? {},
        [cts[1].id]: session.policy,
      };
      const scored = scoreRun({
        specs: run.specs,
        contestants: run.contestants,
        cases: run.cases,
        cells: run.cells,
        questionIds: allQids,
        bands: resolved.bands,
        tolerance: resolved.scoreTolerance,
        repeats: t.repeats,
        incompleteCaseIds: new Set(run.incompleteCaseIds),
        fitted,
        calibratedCaseFilter: () => true,
      });
      const temps = (pol: Record<string, JevQuestionPolicy>): Record<string, number> =>
        Object.fromEntries(Object.entries(pol).map(([q, p]) => [q, p.temperature ?? 1]));
      const hCases = run.cases.filter((c) => !run.incompleteCaseIds.includes(c.id));
      const sO = caseScores(run, origH, cts[0].id, hCases, allQids, t.metric === 'brier-cal' ? temps(session.originalPolicy ?? {}) : {});
      const sC = caseScores(run, campH, cts[1].id, hCases, allQids, t.metric === 'brier-cal' ? temps(session.policy) : {});
      const ids = hCases.map((c) => c.id).sort();
      const pick = (m: Map<string, CaseScore>, id: string): number | null => (t.metric === 'accuracy' ? m.get(id)?.acc ?? null : m.get(id)?.score ?? null);
      const sig = pairedSignificance(ids.map((id) => pick(sO, id)), ids.map((id) => pick(sC, id)), { pOrigin: 'holdout' });
      const accPares = ids
        .map((id) => [sO.get(id)?.acc ?? null, sC.get(id)?.acc ?? null])
        .filter((p): p is [number, number] => p[0] !== null && p[1] !== null);
      const accDelta = accPares.length ? 100 * mean(accPares.map(([a, b]) => b - a)) : 0;
      let better = 0;
      let worse = 0;
      for (const [a, b] of accPares) {
        if (b > a) better += 1;
        else if (b < a) worse += 1;
      }
      const regressed = Boolean((sig && sig.meanDiffPp < 0 && sig.ci95Pp[1] < 0) || accDelta < -t.maxAccuracyDropPp);
      const n = ids.length;
      const forca = holdoutStrength(n);
      session.holdout = {
        runId: run.id,
        n,
        strength: forca,
        comparison: {
          contestantId: cts[1].id,
          controlId: cts[0].id,
          metric: t.metric === 'accuracy' ? 'accuracy' : 'brierScore',
          meanDiffPp: sig ? sig.meanDiffPp : null,
          ci95Pp: sig ? sig.ci95Pp : null,
          pValue: sig ? sig.pValue : null,
          nEfetivo: sig ? sig.nEfetivo : n,
          accuracyDiffPp: Number(accDelta.toFixed(3)),
          mcnemarP: null,
          discordant: { better, worse },
        },
        original: scored.metrics[cts[0].id] ?? null,
        champion: scored.metrics[cts[1].id] ?? null,
        regressed,
        text:
          forca === 'holdout'
            ? `validado em holdout intocado (n=${n} casos, α=0,05 unilateral${sig ? `, p=${sig.pValue.toFixed(3)}` : ''})${regressed ? ' — REGREDIU' : ''}`
            : `confirmação fraca: holdout com n=${n} < ${MIN_HOLDOUT_SCENARIOS} casos — sem confirmação contra sobreajuste`,
      };
      if (parada(run)) session.stoppedReason = session.stoppedReason ?? parada(run);
    } catch (err) {
      if (!isControlSignal(err)) throw err;
      session.stoppedReason = isBudgetSignal(err) ? 'budget' : 'cancelled';
    }
  }

  session.finishedAt = new Date(agora()).toISOString();
  if (session.stoppedReason === 'cancelled') session.status = 'aborted';
  else session.status = 'finished';
  if (session.stoppedReason === 'budget') session.budgetExhausted = true;
  if (session.resolvedModels.length > 1) session.warnings.push(`snapshot-drift: ${session.resolvedModels.join(', ')}`);
  await salvarSessao();
  deps.emit?.({ type: 'jev.session.finished', sessionId, status: session.status, verdict: sessionVerdict(session) });
  return session;
}

/** Veredito da sessão (as MESMAS regras do relatório LLM). */
export function sessionVerdict(s: Pick<JevSessionRecord, 'originalSpec' | 'championSpec' | 'holdout'>): 'melhorou' | 'piorou' | 'sem-diferenca' | 'inconclusivo' | 'sem-mudanca' {
  if (s.championSpec.id === s.originalSpec.id) return 'sem-mudanca';
  const h = s.holdout;
  if (!h || !h.comparison || h.strength !== 'holdout') return 'inconclusivo';
  if (h.regressed) return 'piorou';
  const c = h.comparison;
  if (c.meanDiffPp !== null && c.meanDiffPp > 0 && c.pValue !== null && c.pValue <= 0.05) return 'melhorou';
  return 'sem-diferenca';
}
