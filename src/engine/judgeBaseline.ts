// GATE DE BASELINE do julgamento (IMPL-019, R-07b:REC-8 — "gate de CI falha se
// juiz/gabarito mudar sem re-baseline declarada").
//
// Uma baseline só é comparável com outra run se as duas foram julgadas pelo
// MESMO contrato: mesmos juízes, mesmo modelo de gabarito, mesmo prompt de
// julgamento E o mesmo snapshot por trás de cada id (alias `~…-latest` movido
// = outro modelo com o mesmo nome). O `judge-baseline@1` é o arquivo
// VERSIONADO junto com o código que pina esse contrato; `checkJudgeBaseline`
// confere, SEM LLM, o contrato em vigor × o pinado × o catálogo do dia e
// reprova (exit != 0 no CLI) quando algo mudou sem re-baseline DECLARADA.
//
// Nunca migra sozinho (regra da pesquisa): quando o juiz some ou muda, o gate
// só diz o que fazer (política de remoção de `modelLifecycle.ts`); quem decide
// declara a re-baseline no próprio arquivo (`rebaseline`), e o gate passa a
// aceitar o novo contrato com aviso até a baseline ser refeita (`baseline pin`).
//
// Módulo PURO (sem node:*, sem fetch): o CLI injeta arquivo, config e catálogo.

import {
  lifecycleAlertFor,
  type CatalogModelLike,
  type ModelLifecycleSnapshot,
  type ModelUsageRole,
  type RemovalAction,
  type SuccessorSuggestion,
} from './modelLifecycle.js';

/** Valor do campo `format` — versão do contrato do arquivo. */
export const JUDGE_BASELINE_FORMAT = 'judge-baseline@1';

/** Snapshot de UM modelo no momento em que a baseline foi medida. */
export interface JudgeBaselineModelPin {
  canonicalSlug: string | null;
  aliasTarget: string | null;
  expirationDate: string | null;
}

/** Quem julga: juízes + modelo do gabarito. */
export interface JudgeSetup {
  judgeModelIds: string[];
  referenceModelId: string;
}

/**
 * Re-baseline DECLARADA: a decisão consciente de passar a um novo contrato de
 * julgamento (sucessor, novo prompt de juiz, alias que mudou de alvo). O gate
 * aceita o contrato declarado — com aviso — até a baseline ser refeita.
 */
export interface RebaselineDeclaration {
  /** Por quê (obrigatório): fica no histórico do arquivo versionado. */
  reason: string;
  declaredAt: string;
  judgeModelIds: string[];
  referenceModelId: string;
  /** Hash do contrato aceito (opcional: ausente aceita o hash em vigor para esse setup). */
  contractHash?: string;
  /** Run-ponte (modelo antigo × sucessor nos mesmos cenários), quando houve. */
  bridgeRunId?: string;
}

export interface JudgeBaseline {
  format: typeof JUDGE_BASELINE_FORMAT;
  pinnedAt: string;
  /** Run que mediu a baseline (proveniência). */
  baselineRunId?: string;
  judge: { modelIds: string[]; contractHash: string };
  reference: { modelId: string };
  /** Snapshot do catálogo de cada juiz/gabarito NA baseline. */
  models: Record<string, JudgeBaselineModelPin>;
  /** Sucessores NOMEADOS pelo usuário (id → sucessor) — contam para a política de remoção. */
  successors?: Record<string, string>;
  rebaseline?: RebaselineDeclaration;
}

export type ParseJudgeBaselineResult =
  | { ok: true; baseline: JudgeBaseline }
  | { ok: false; error: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringList(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.length) return null;
  const out = v.map((x) => (typeof x === 'string' ? x.trim() : ''));
  return out.every(Boolean) ? out : null;
}

function nullableString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Valida o JSON do arquivo. NUNCA lança: qualquer problema vira
 * `{ ok: false, error }` com mensagem PT-BR citando o campo responsável.
 * Chaves `"//"` (comentário) e desconhecidas são ignoradas.
 */
export function parseJudgeBaseline(json: unknown): ParseJudgeBaselineResult {
  if (!isObject(json)) {
    return { ok: false, error: 'O arquivo deve ser um objeto JSON com "format", "judge" e "reference".' };
  }
  if (json.format !== JUDGE_BASELINE_FORMAT) {
    const recebido = typeof json.format === 'string' && json.format.trim() ? json.format : 'ausente';
    return {
      ok: false,
      error: `Campo "format" inválido: esperado "${JUDGE_BASELINE_FORMAT}", recebi "${recebido}".`,
    };
  }
  const pinnedAt = json.pinnedAt;
  if (typeof pinnedAt !== 'string' || Number.isNaN(Date.parse(pinnedAt))) {
    return { ok: false, error: 'Campo "pinnedAt" ausente ou não é uma data ISO-8601 válida.' };
  }
  if (!isObject(json.judge)) return { ok: false, error: 'Campo "judge" ausente ou não é um objeto.' };
  const judgeIds = stringList(json.judge.modelIds);
  if (!judgeIds) return { ok: false, error: 'Campo "judge.modelIds" deve ser uma lista não vazia de ids.' };
  const contractHash = json.judge.contractHash;
  if (typeof contractHash !== 'string' || !contractHash.trim()) {
    return { ok: false, error: 'Campo "judge.contractHash" ausente ou vazio.' };
  }
  if (!isObject(json.reference) || typeof json.reference.modelId !== 'string' || !json.reference.modelId.trim()) {
    return { ok: false, error: 'Campo "reference.modelId" ausente ou vazio.' };
  }

  const models: Record<string, JudgeBaselineModelPin> = {};
  if (json.models !== undefined) {
    if (!isObject(json.models)) return { ok: false, error: 'Campo "models" deve ser um objeto id → snapshot.' };
    for (const [id, pin] of Object.entries(json.models)) {
      if (id === '//') continue;
      if (!isObject(pin)) return { ok: false, error: `Campo "models.${id}" deve ser um objeto.` };
      models[id] = {
        canonicalSlug: nullableString(pin.canonicalSlug),
        aliasTarget: nullableString(pin.aliasTarget),
        expirationDate: nullableString(pin.expirationDate),
      };
    }
  }

  let successors: Record<string, string> | undefined;
  if (json.successors !== undefined) {
    if (!isObject(json.successors)) {
      return { ok: false, error: 'Campo "successors" deve ser um objeto id → sucessor.' };
    }
    successors = {};
    for (const [id, alvo] of Object.entries(json.successors)) {
      if (id === '//') continue;
      if (typeof alvo !== 'string' || !alvo.trim()) {
        return { ok: false, error: `Campo "successors.${id}" deve ser o id do sucessor.` };
      }
      successors[id] = alvo.trim();
    }
  }

  let rebaseline: RebaselineDeclaration | undefined;
  if (json.rebaseline !== undefined && json.rebaseline !== null) {
    const r = json.rebaseline;
    if (!isObject(r)) return { ok: false, error: 'Campo "rebaseline" deve ser um objeto.' };
    if (typeof r.reason !== 'string' || !r.reason.trim()) {
      return { ok: false, error: 'Campo "rebaseline.reason" é obrigatório: declare POR QUE a baseline mudou.' };
    }
    if (typeof r.declaredAt !== 'string' || Number.isNaN(Date.parse(r.declaredAt))) {
      return { ok: false, error: 'Campo "rebaseline.declaredAt" ausente ou não é uma data ISO-8601 válida.' };
    }
    const rJudges = stringList(r.judgeModelIds);
    if (!rJudges) return { ok: false, error: 'Campo "rebaseline.judgeModelIds" deve ser uma lista não vazia de ids.' };
    if (typeof r.referenceModelId !== 'string' || !r.referenceModelId.trim()) {
      return { ok: false, error: 'Campo "rebaseline.referenceModelId" ausente ou vazio.' };
    }
    rebaseline = {
      reason: r.reason.trim(),
      declaredAt: r.declaredAt,
      judgeModelIds: rJudges,
      referenceModelId: r.referenceModelId.trim(),
      ...(typeof r.contractHash === 'string' && r.contractHash.trim() ? { contractHash: r.contractHash.trim() } : {}),
      ...(typeof r.bridgeRunId === 'string' && r.bridgeRunId.trim() ? { bridgeRunId: r.bridgeRunId.trim() } : {}),
    };
  }

  return {
    ok: true,
    baseline: {
      format: JUDGE_BASELINE_FORMAT,
      pinnedAt,
      ...(typeof json.baselineRunId === 'string' && json.baselineRunId.trim()
        ? { baselineRunId: json.baselineRunId.trim() }
        : {}),
      judge: { modelIds: judgeIds, contractHash: contractHash.trim() },
      reference: { modelId: json.reference.modelId.trim() },
      models,
      ...(successors && Object.keys(successors).length ? { successors } : {}),
      ...(rebaseline ? { rebaseline } : {}),
    },
  };
}

/** Juízes + gabarito de uma config (gabarito default = 1º juiz, como o orquestrador). */
export function judgeSetupFromConfig(config: {
  judgeModelIds?: readonly string[];
  referenceModelId?: string;
}): JudgeSetup | null {
  const judges = (config.judgeModelIds ?? []).filter((j) => typeof j === 'string' && j.trim());
  if (!judges.length) return null;
  return { judgeModelIds: [...judges], referenceModelId: config.referenceModelId ?? judges[0] };
}

function setupModels(s: JudgeSetup): string[] {
  return [...new Set([...s.judgeModelIds, s.referenceModelId])];
}

/**
 * Pina a baseline a partir de uma run: juízes/gabarito da config, o hash do
 * contrato e o snapshot de ciclo de vida GRAVADO NA RUN (o que foi medido).
 * Sem snapshot na run (record antigo), usa o catálogo de hoje e avisa por
 * `usedCatalogFallback` — nesse caso a deriva anterior ao pin fica invisível.
 */
export function buildJudgeBaseline(input: {
  setup: JudgeSetup;
  contractHash: string;
  lifecycle?: ModelLifecycleSnapshot | null;
  catalog?: readonly CatalogModelLike[] | null;
  baselineRunId?: string;
  successors?: Record<string, string>;
  now: Date;
}): { baseline: JudgeBaseline; usedCatalogFallback: string[] } {
  const models: Record<string, JudgeBaselineModelPin> = {};
  const fallback: string[] = [];
  const byId = new Map((input.catalog ?? []).map((m) => [m.id, m]));
  for (const id of setupModels(input.setup)) {
    const daRun =
      input.lifecycle?.source === 'catalog' ? input.lifecycle.models[id] : undefined;
    if (daRun?.inCatalog) {
      models[id] = {
        canonicalSlug: daRun.canonicalSlug,
        aliasTarget: daRun.aliasTarget,
        expirationDate: daRun.expirationDate,
      };
      continue;
    }
    const m = byId.get(id);
    fallback.push(id);
    models[id] = {
      canonicalSlug: m?.canonicalSlug ?? null,
      aliasTarget: m?.aliasTarget ?? null,
      expirationDate: m?.expirationDate ?? null,
    };
  }
  return {
    baseline: {
      format: JUDGE_BASELINE_FORMAT,
      pinnedAt: input.now.toISOString(),
      ...(input.baselineRunId ? { baselineRunId: input.baselineRunId } : {}),
      judge: { modelIds: [...input.setup.judgeModelIds], contractHash: input.contractHash },
      reference: { modelId: input.setup.referenceModelId },
      models,
      ...(input.successors && Object.keys(input.successors).length ? { successors: { ...input.successors } } : {}),
    },
    usedCatalogFallback: fallback,
  };
}

/** Grava a declaração de re-baseline no arquivo (substitui uma anterior). */
export function declareRebaseline(
  baseline: JudgeBaseline,
  decl: Omit<RebaselineDeclaration, 'declaredAt'> & { declaredAt?: string },
  now: Date,
): JudgeBaseline {
  return {
    ...baseline,
    rebaseline: {
      reason: decl.reason,
      declaredAt: decl.declaredAt ?? now.toISOString(),
      judgeModelIds: [...decl.judgeModelIds],
      referenceModelId: decl.referenceModelId,
      ...(decl.contractHash ? { contractHash: decl.contractHash } : {}),
      ...(decl.bridgeRunId ? { bridgeRunId: decl.bridgeRunId } : {}),
    },
  };
}

// ----------------------------------------------------------------------------
// O gate
// ----------------------------------------------------------------------------

export type BaselineFindingKind =
  | 'judge-changed'
  | 'reference-changed'
  | 'contract-changed'
  | 'model-removed'
  | 'model-expired'
  | 'model-expiring'
  | 'slug-drift'
  | 'alias-drift'
  | 'catalog-unavailable'
  | 'rebaseline-declared'
  | 'rebaseline-pending';

export interface BaselineFinding {
  kind: BaselineFindingKind;
  modelId?: string;
  message: string;
  action?: RemovalAction;
  successor?: SuccessorSuggestion | null;
}

export interface BaselineGateReport {
  ok: boolean;
  /** Contrato conferido: o da config (se veio), o declarado, ou o pinado. */
  effective: JudgeSetup & { source: 'config' | 'rebaseline' | 'baseline' };
  rebaselineDeclared: boolean;
  failures: BaselineFinding[];
  warnings: BaselineFinding[];
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function sameSetup(a: JudgeSetup, b: JudgeSetup): boolean {
  return sameList(a.judgeModelIds, b.judgeModelIds) && a.referenceModelId === b.referenceModelId;
}

const COMO_DECLARAR =
  'se a mudança é intencional, declare a re-baseline (`prompt-builder baseline declare --reason …`) e refaça a baseline (`baseline pin <runId>`)';

/**
 * Confere o contrato de julgamento em vigor contra a baseline pinada e o
 * catálogo do dia. REPROVA (ok=false) quando, sem re-baseline declarada que
 * cubra o contrato em vigor:
 *   • juízes ou gabarito mudaram (`judge-changed` / `reference-changed`);
 *   • o hash do contrato do juiz mudou (`contract-changed` — ex.: nova versão
 *     do prompt de julgamento);
 *   • o `canonical_slug` ou o alvo do alias de um juiz/gabarito mudou
 *     (`slug-drift` / `alias-drift` — migração silenciosa).
 * E reprova SEMPRE (nem a declaração salva) quando um modelo do contrato em
 * vigor saiu do catálogo ou expirou — ele não roda mais — ou quando o catálogo
 * não carregou (fail-closed: sem catálogo não há como afirmar que o juiz existe).
 * Expiração em até 30 dias é AVISO com sucedâneo e ação da política.
 */
export function checkJudgeBaseline(
  baseline: JudgeBaseline,
  opts: {
    /** Contrato da config em uso (ausente = confere o declarado ou o pinado). */
    current?: JudgeSetup | null;
    catalog: readonly CatalogModelLike[] | null | undefined;
    now: Date;
    /** Hash do contrato do juiz em vigor para um setup (o CLI injeta o do binário). */
    contractHashFor?: (setup: JudgeSetup) => string;
  },
): BaselineGateReport {
  const failures: BaselineFinding[] = [];
  const warnings: BaselineFinding[] = [];
  const pinned: JudgeSetup = {
    judgeModelIds: baseline.judge.modelIds,
    referenceModelId: baseline.reference.modelId,
  };
  const decl = baseline.rebaseline;
  const declSetup: JudgeSetup | null = decl
    ? { judgeModelIds: decl.judgeModelIds, referenceModelId: decl.referenceModelId }
    : null;

  let effective: BaselineGateReport['effective'];
  if (opts.current) effective = { ...opts.current, source: 'config' };
  else if (declSetup) effective = { ...declSetup, source: 'rebaseline' };
  else effective = { ...pinned, source: 'baseline' };

  const sameAsPinned = sameSetup(effective, pinned);
  const covered = !!declSetup && sameSetup(effective, declSetup);
  const currentHash = opts.contractHashFor?.(effective);
  const hashOk = !decl?.contractHash || decl.contractHash === currentHash;

  // 1) Troca de juiz/gabarito.
  if (!sameAsPinned) {
    if (covered && hashOk) {
      warnings.push({
        kind: 'rebaseline-declared',
        message:
          `re-baseline declarada em ${decl!.declaredAt.slice(0, 10)} ("${decl!.reason}"): juízes ` +
          `[${effective.judgeModelIds.join(', ')}] / gabarito ${effective.referenceModelId} aceitos. ` +
          'As notas da baseline antiga NÃO são comparáveis com as novas — refaça a baseline com `baseline pin <runId>`' +
          (decl!.bridgeRunId ? ` (run-ponte: ${decl!.bridgeRunId}).` : '.'),
      });
    } else {
      const extra = declSetup && !covered
        ? ` A re-baseline declarada aponta para [${declSetup.judgeModelIds.join(', ')}] / ${declSetup.referenceModelId}, não para o contrato em vigor.`
        : '';
      if (!sameList(effective.judgeModelIds, pinned.judgeModelIds)) {
        failures.push({
          kind: 'judge-changed',
          message:
            `juiz mudou de [${pinned.judgeModelIds.join(', ')}] para [${effective.judgeModelIds.join(', ')}] ` +
            `sem re-baseline declarada — ${COMO_DECLARAR}.${extra}`,
        });
      }
      if (effective.referenceModelId !== pinned.referenceModelId) {
        failures.push({
          kind: 'reference-changed',
          message:
            `gabarito mudou de ${pinned.referenceModelId} para ${effective.referenceModelId} ` +
            `sem re-baseline declarada — ${COMO_DECLARAR}.${extra}`,
        });
      }
    }
  } else if (declSetup && !covered) {
    // Declarou a troca mas a config ainda usa o contrato antigo: pendente.
    warnings.push({
      kind: 'rebaseline-pending',
      message:
        `re-baseline declarada para [${declSetup.judgeModelIds.join(', ')}] / ${declSetup.referenceModelId}, ` +
        'mas o contrato em vigor ainda é o da baseline — atualize a config ou remova a declaração.',
    });
  }

  // 2) Hash do contrato do juiz (prompt de julgamento, juízes).
  if (currentHash !== undefined) {
    if (sameAsPinned && currentHash !== baseline.judge.contractHash) {
      if (covered && hashOk) {
        warnings.push({
          kind: 'contract-changed',
          message: `contrato do juiz mudou (${baseline.judge.contractHash.slice(0, 12)} → ${currentHash.slice(0, 12)}), coberto pela re-baseline declarada.`,
        });
      } else {
        failures.push({
          kind: 'contract-changed',
          message:
            `contrato do juiz mudou (${baseline.judge.contractHash.slice(0, 12)} → ${currentHash.slice(0, 12)}): ` +
            `o prompt/configuração de julgamento não é o da baseline — ${COMO_DECLARAR}.`,
        });
      }
    } else if (covered && !hashOk) {
      failures.push({
        kind: 'contract-changed',
        message:
          `o hash declarado na re-baseline (${decl!.contractHash!.slice(0, 12)}) não confere com o contrato em vigor ` +
          `(${currentHash.slice(0, 12)}) — declare de novo sem hash ou com o hash atual.`,
      });
    }
  }

  // 3) Catálogo do dia: removido/expirado reprova; ≤30 dias avisa; slug/alias deriva.
  const catalog = opts.catalog ?? [];
  if (!catalog.length) {
    failures.push({
      kind: 'catalog-unavailable',
      message: 'catálogo de modelos indisponível — sem ele não há como afirmar que o juiz/gabarito ainda existe (fail-closed).',
    });
  } else {
    const byId = new Map(catalog.map((m) => [m.id, m]));
    for (const id of setupModels(effective)) {
      const roles: ModelUsageRole[] = [];
      if (effective.judgeModelIds.includes(id)) roles.push('judge');
      if (effective.referenceModelId === id) roles.push('reference');
      const entry = byId.get(id);
      const alerta = lifecycleAlertFor(id, roles, entry, catalog, opts.now, baseline.successors);
      if (alerta?.kind === 'missing') {
        failures.push({
          kind: 'model-removed',
          modelId: id,
          action: alerta.action,
          successor: alerta.successor,
          message: `${alerta.message} O gate não passa com um juiz/gabarito que não roda mais.`,
        });
      } else if (alerta?.kind === 'expired') {
        failures.push({
          kind: 'model-expired',
          modelId: id,
          action: alerta.action,
          successor: alerta.successor,
          message: alerta.message,
        });
      } else if (alerta?.kind === 'expiring') {
        warnings.push({
          kind: 'model-expiring',
          modelId: id,
          action: alerta.action,
          successor: alerta.successor,
          message: alerta.message,
        });
      }

      const pin = baseline.models[id];
      if (!entry || !pin) continue;
      const deriva: BaselineFinding[] = [];
      if (pin.canonicalSlug && entry.canonicalSlug && pin.canonicalSlug !== entry.canonicalSlug) {
        deriva.push({
          kind: 'slug-drift',
          modelId: id,
          message:
            `${id}: canonical_slug mudou (${pin.canonicalSlug} → ${entry.canonicalSlug}) — o mesmo id aponta ` +
            `para OUTRO snapshot; as notas novas não são comparáveis com a baseline.`,
        });
      }
      const alvoPin = pin.aliasTarget ?? null;
      const alvoHoje = entry.aliasTarget ?? null;
      if ((alvoPin || alvoHoje) && alvoPin !== alvoHoje) {
        deriva.push({
          kind: 'alias-drift',
          modelId: id,
          message:
            `${id}: o alias passou a apontar para ${alvoHoje ?? '(nada)'} (era ${alvoPin ?? '(nada)'}) — ` +
            'migração silenciosa; as notas novas não são comparáveis com a baseline.',
        });
      }
      for (const d of deriva) {
        if (covered && hashOk) warnings.push({ ...d, message: `${d.message} Coberto pela re-baseline declarada.` });
        else failures.push({ ...d, message: `${d.message} ${COMO_DECLARAR[0].toUpperCase()}${COMO_DECLARAR.slice(1)}.` });
      }
    }
  }

  return {
    ok: failures.length === 0,
    effective,
    rebaselineDeclared: !!decl,
    failures,
    warnings,
  };
}
