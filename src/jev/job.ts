// Modo JEV — o lado NODE das superfícies assíncronas: executor de job (MCP
// `start_run`), progresso para `run_status`, e os ganchos das tools
// (`estimate_cost`, `list_models {modality}`, `get_result`). Fica FORA de
// `mcp.ts`/`jobManager.ts` de propósito: lá entram só ganchos de 1–3 linhas
// (arquivos sob edição concorrente).
//
// Regras do MCP (crítica A3.7): só casos INLINE — `cases.path` num config
// vindo de agente seria leitura de arquivo arbitrário, e a idempotência
// cobriria só o caminho, não o conteúdo.

import { getGateway } from '../openrouter.js';
import { ensureCatalog } from '../modelsCache.js';
import { getDataDir } from '../storage.js';
import { enforceRunCompliance } from '../lgpd.js';
import { withSpendGuards } from '../cli/spendGuards.js';
import { throwIfAborted } from '../jobs.js';
import type { OpenRouterModel } from '../types.js';
import {
  estimateJev,
  estimateJevTrain,
  isJevConfig,
  jevComplianceView,
  lintResolved,
  parseJevConfig,
  resolveJevConfig,
  runJev,
  summarizeJevRun,
  summarizeJevSession,
  trainJev,
  type JevComplianceResult,
  type JevConfigFile,
  type ResolvedJevConfig,
} from '../engine/jev/index.js';
import { findJevRecord, jevOwner, loadJevRun, loadJevSession, saveJevRun, saveJevSession } from './store.js';

/** O pedido de um job JEV (config com casos INLINE, orçamento aplicado). */
export interface JevJobInput {
  kind: 'jev';
  config: JevConfigFile;
  budgetUsd: number;
}

/** Identidade do EXPERIMENTO para o lock (o hash ignora `budgetUsd`). */
export function jevGuardConfig(r: ResolvedJevConfig): Record<string, unknown> & { budgetUsd?: number } {
  return {
    format: r.format,
    mode: r.mode,
    specHash: r.specHash,
    datasetHash: r.datasetHash,
    contestants: r.contestants.map((c) => c.id),
    repeats: r.repeats,
    ...(r.train ? { train: r.train } : {}),
    ...(r.budgetUsd !== undefined ? { budgetUsd: r.budgetUsd } : {}),
  };
}

const primeiroErro = (issues: { level: string; code: string; message: string }[]): string =>
  issues
    .filter((i) => i.level === 'error')
    .slice(0, 4)
    .map((i) => `${i.code}: ${i.message}`)
    .join('; ');

/** Config de agente → config resolvido. Lança `Error` legível (a tool devolve como erro). */
export function resolveJevForTool(raw: unknown, budgetUsd?: number): { cfg: JevConfigFile; resolved: ResolvedJevConfig } {
  const p = parseJevConfig(raw);
  if (!p.ok) throw new Error(`jev-config@1 inválido: ${p.error}`);
  if (!Array.isArray(p.config.cases)) {
    throw new Error('jev-config@1 no MCP aceita só casos INLINE (`cases: [...]`); `cases.path` é só no CLI (`prompt-builder jev run`).');
  }
  const r = resolveJevConfig(p.config);
  if (!r.ok) throw new Error(`jev-config@1 não resolve: ${primeiroErro(r.issues)}`);
  const lint = lintResolved(r.resolved);
  if (lint.some((i) => i.level === 'error')) throw new Error(`jev-config@1 com erro de lint (nada foi gasto): ${primeiroErro(lint)}`);
  return { cfg: p.config, resolved: { ...r.resolved, ...(budgetUsd !== undefined ? { budgetUsd } : {}) } };
}

/** `start_run` com jev-config@1 → pedido de job (valida ANTES de criar o job). */
export function jevJobInput(raw: unknown, budgetUsd: number): JevJobInput {
  const { cfg } = resolveJevForTool(raw, budgetUsd);
  return { kind: 'jev', config: { ...cfg, budgetUsd }, budgetUsd };
}

/** Executor do job JEV (mesmas guardas de gasto do CLI: teto diário + lock). */
export async function executeJevJob(
  input: JevJobInput,
  apiKey: string,
  hooks: { signal: AbortSignal; runId?: string; onSessionId(id: string): void },
): Promise<{ summary: Record<string, unknown>; cancelled: boolean; runId?: string; sessionId?: string }> {
  const { resolved } = resolveJevForTool(input.config, input.budgetUsd);
  const decisionCatalog = await getGateway().listDecisionModels(apiKey).catch(() => [] as OpenRouterModel[]);
  const precisaChat = resolved.contestants.some((c) => c.kind === 'llm') || Boolean(resolved.train?.rewriterModelId);
  const chatCatalog = precisaChat ? (await ensureCatalog(apiKey)).models : [];
  throwIfAborted(hooks.signal);
  const r = await enforceRunCompliance(jevComplianceView(resolved));
  const compliance: JevComplianceResult = {
    ...(r.sensitiveRouting ? { sensitiveRouting: r.sensitiveRouting } : {}),
    ...(r.piiReport ? { piiReport: r.piiReport } : {}),
  };
  const log = (m: string): void => void process.stderr.write(`[jev] ${m}\n`);
  return withSpendGuards(
    {
      dataDir: getDataDir(),
      config: jevGuardConfig(resolved),
      command: `mcp start_run (jev ${resolved.mode})`,
      models: [...chatCatalog, ...decisionCatalog],
      signal: hooks.signal,
    },
    async (g) => {
      const comum = {
        apiKey,
        client: 'node' as const,
        signal: hooks.signal,
        parentLedger: g.parentLedger,
        compliance: async () => compliance,
        log,
        owner: jevOwner(),
      };
      if (resolved.mode === 'train') {
        const id = hooks.runId ?? undefined;
        if (id) hooks.onSessionId(id);
        const s = await trainJev(resolved, { ...comum, ...(id ? { sessionId: id } : {}), saveRun: saveJevRun, saveSession: saveJevSession });
        return { summary: summarizeJevSession(s), cancelled: s.status === 'aborted', sessionId: s.id };
      }
      const run = await runJev(resolved, { ...comum, ...(hooks.runId ? { runId: hooks.runId } : {}), save: saveJevRun });
      return { summary: summarizeJevRun(run), cancelled: run.status === 'aborted' && run.stoppedReason === 'cancelled', runId: run.id };
    },
  );
}

/** Progresso barato para `run_status` (lido do record em disco). */
export async function jevJobProgress(rec: { runId?: string; sessionId?: string }): Promise<Record<string, number> | undefined> {
  const id = rec.sessionId ?? rec.runId;
  if (!id) return undefined;
  const s = await loadJevSession(id).catch(() => null);
  if (s) {
    return {
      iterationsPlanned: s.config.train?.iterations ?? 0,
      iterationsDone: s.iterations.filter((i) => i.iteration > 0).length,
      spentUsd: s.totalCostUsd,
    };
  }
  const r = await loadJevRun(id).catch(() => null);
  if (!r) return undefined;
  return { requestsPlanned: r.progress.requestsPlanned, requestsDone: r.progress.requestsDone, spentUsd: r.progress.spentUsd };
}

/** `estimate_cost` com jev-config@1 (catálogos PÚBLICOS; nenhuma chamada paga). */
export async function estimateJevForTool(raw: unknown, apiKey: string): Promise<Record<string, unknown>> {
  const { resolved } = resolveJevForTool(raw);
  const decisionCatalog = await getGateway().listDecisionModels(apiKey).catch(() => [] as OpenRouterModel[]);
  const precisaChat = resolved.contestants.some((c) => c.kind === 'llm') || Boolean(resolved.train?.rewriterModelId);
  const chatCatalog = precisaChat ? (await ensureCatalog(apiKey).catch(() => ({ models: [] as OpenRouterModel[] }))).models : [];
  const est = resolved.mode === 'train' ? estimateJevTrain(resolved, { chatCatalog, decisionCatalog }) : estimateJev(resolved, { chatCatalog, decisionCatalog });
  const lint = lintResolved(resolved, { decisionCatalog }).filter((i) => i.level !== 'info');
  return { kind: 'jev', mode: resolved.mode, cases: resolved.cases.length, contestants: resolved.contestants.map((c) => c.id), estimate: est, lint: lint.slice(0, 30) };
}

/** `list_models {modality:"decisions"}`. */
export async function listDecisionModelsForTool(apiKey: string, search: string | undefined, limit: number): Promise<Record<string, unknown>> {
  let rows = await getGateway().listDecisionModels(apiKey);
  if (search) rows = rows.filter((m) => m.id.toLowerCase().includes(search) || m.name.toLowerCase().includes(search));
  return {
    count: rows.length,
    modality: 'decisions',
    models: rows.slice(0, limit).map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.contextLength ?? null,
      promptUsdPerMTok: typeof m.pricing.prompt === 'number' ? m.pricing.prompt * 1e6 : null,
      completionUsdPerMTok: typeof m.pricing.completion === 'number' ? m.pricing.completion * 1e6 : null,
      snapshot: m.canonicalSlug ?? null,
    })),
  };
}

/**
 * `get_result` para ids JEV: resumo (sem células nem estados) ou, com
 * `detail:"full"`, o record SEM os estados dos casos. `null` = não é JEV.
 */
export async function jevResultForTool(id: string, detail: unknown): Promise<Record<string, unknown> | null> {
  const r = await findJevRecord(id);
  if (!r) return null;
  if (r.kind === 'session') {
    return detail === 'full' ? { kind: 'jev-session', detail: 'full', id, status: r.rec.status, record: r.rec } : { ...summarizeJevSession(r.rec), detail: 'summary', id, kind: 'jev-session' };
  }
  if (detail === 'full') {
    const semEstado = { ...r.rec, cases: r.rec.cases.map(({ state: _s, ...c }) => c) };
    return { kind: 'jev-run', detail: 'full', id, status: r.rec.status, record: semEstado };
  }
  return { ...summarizeJevRun(r.rec), detail: 'summary', id, kind: 'jev-run' };
}

/** Um config (objeto ou string JSON) é jev-config@1? */
export function isJevConfigRaw(config: unknown): boolean {
  if (typeof config === 'string') {
    try {
      return isJevConfig(JSON.parse(config));
    } catch {
      return false;
    }
  }
  return isJevConfig(config);
}
