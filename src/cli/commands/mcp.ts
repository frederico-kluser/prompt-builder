// Servidor MCP por stdio, no MESMO binario (precedente: `npx -y prisma mcp`).
//
// Implementado a mao, sem SDK: o transporte stdio do MCP e JSON-RPC 2.0
// delimitado por linha, e `initialize` + `tools/list` + `tools/call` cabem em
// ~150 linhas. Puxar o SDK custaria dezenas de pacotes transitivos em TODA
// instalacao — inclusive de quem so quer o CLI — e o cold start rapido e
// metade da vantagem de um binario sobre um servidor MCP.
//
// A superficie e deliberadamente PEQUENA (6 ferramentas): o schema de cada uma
// entra no contexto do agente a cada turno, entao cada ferramenta a mais e um
// imposto permanente de tokens.
//
// Cancelamento cooperativo (IMPL-025, R-13:REC-4): o laço de leitura NUNCA
// espera uma ferramenta — `ping`, `tools/list` e `notifications/cancelled`
// são atendidos enquanto uma run de minutos está em voo (antes o `await
// tool.run` serial travava tudo: deadlock MDAT e gasto órfão). Cada
// `tools/call` ganha um AbortController cujo sinal É o AbortSignal do motor
// (ledger + fetch em voo); cancelada pelo cliente, a chamada grava o parcial
// (record 'aborted', stoppedReason 'cancelled') e NÃO recebe resposta. EOF do
// stdin e SIGTERM abortam tudo com graça de ~10 s antes de sair.

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { RunCancelled, isControlSignal } from '../../budget.js';
import { HeavyLane, SHUTDOWN_GRACE_MS, processLane, settleWithin } from '../../jobs.js';
import { PKG_DOCS_DIR, pkgVersion } from '../../paths.js';
import { assertValidRecordId, publicErrorMessage } from '../../pathSafety.js';
import { readDocTopic } from './knowledge.js';
import { setDataDir, loadRun, loadSession } from '../../storage.js';
import { ensureCatalog } from '../../modelsCache.js';
import { toExportRow } from '../../modelCaps.js';
import { estimateInputFromConfig, estimateRunCost } from '../../estimate.js';
import { parseRunConfig } from '../../runConfigSchema.js';
import { parseArenaConfig, parseArenaAgentConfig } from '../../configFile.js';
import { arenaConfigToRunConfig, arenaAgentConfigToRunConfig } from '../../arenaConfig.js';
import { runToCompletion } from '../../orchestrator.js';
import { readArtifact } from '../../agent/store.js';
import { prepareOptsFor } from '../../prepareRun.js';
import { trainToCompletion } from '../../trainer.js';
import { resolveHome, resolveKey, parse } from '../context.js';
import { EXIT } from '../output.js';
import type { RunConfig, RunRecord } from '../../types.js';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'prompt-builder', version: pkgVersion() };

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

/** Contexto de UMA chamada de ferramenta (IMPL-025). */
export interface ToolCtx {
  /**
   * Aborta em `notifications/cancelled`, EOF do stdin ou SIGTERM. É o MESMO
   * AbortSignal que vai ao motor: o ledger para de reservar e o fetch em voo cai.
   */
  signal: AbortSignal;
  /**
   * Roda `fn` na fila de runs pesadas do processo (1 por vez, FIFO). A espera
   * é cancelável e só a parte cara entra nela — validação e catálogo não.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Não precisa de key (lê disco/docs embarcadas): funciona sem OPENROUTER_API_KEY. */
  noKey?: boolean;
  run: (args: Record<string, unknown>, apiKey: string, ctx: ToolCtx) => Promise<unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const numOf = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

async function toRunConfig(raw: unknown): Promise<RunConfig> {
  if (typeof (raw as Record<string, unknown>)?.format === 'string') {
    const p = parseArenaConfig(raw);
    if (!p.ok) throw new Error(p.error);
    const c = arenaConfigToRunConfig(p.config);
    if (!c.ok) throw new Error(c.error);
    return c.config;
  }
  const p = parseRunConfig(raw);
  if (!p.ok) throw new Error(p.error);
  return p.config;
}

// Config de agente chega como STRING JSON (arena-agent-config@1). Aceita tambem
// objeto por robustez, mas o contrato do schema e a string.
function parseAgentConfigRaw(config: unknown): RunConfig {
  let raw: unknown = config;
  if (typeof config === 'string') {
    try {
      raw = JSON.parse(config);
    } catch {
      throw new Error('config não é um JSON válido de arena-agent-config@1.');
    }
  }
  const p = parseArenaAgentConfig(raw);
  if (!p.ok) throw new Error(p.error);
  const c = arenaAgentConfigToRunConfig(p.config);
  if (!c.ok) throw new Error(c.error);
  return c.config;
}

// Derivado do record, nao inferido: conta so respostas de agente (com execution).
// "cut" = a execucao parou pela parede/teto (nao e um veredito 'nao').
const AGENT_CUT_REASONS = new Set(['maxTurns', 'maxCost', 'timeout', 'maxOutput', 'cancelled']);

function agentSummary(rec: { stages: { responses: { costUsd: number; execution?: { turns: number; stopReason: string; oracle?: { score: number } } }[] }[] }) {
  const execs = rec.stages.flatMap((s) => s.responses.filter((r) => r.execution));
  if (execs.length === 0) return undefined;
  const executions = execs.length;
  const failed = execs.filter((r) => r.execution!.stopReason === 'error').length;
  const incomplete = execs.filter((r) => AGENT_CUT_REASONS.has(r.execution!.stopReason)).length;
  const avgTurns = execs.reduce((a, r) => a + r.execution!.turns, 0) / executions;
  const avgCostUsd = execs.reduce((a, r) => a + r.costUsd, 0) / executions;
  const withOracle = execs.filter((r) => r.execution!.oracle !== undefined);
  const oracleRate =
    withOracle.length > 0
      ? withOracle.reduce((a, r) => a + (r.execution!.oracle!.score ?? 0), 0) / withOracle.length
      : undefined;
  return { executions, failed, incomplete, avgTurns, avgCostUsd, oracleRate };
}

const TOOLS: McpTool[] = [
  {
    name: 'list_models',
    description:
      'Lista modelos do OpenRouter com preço e, principalmente, quais níveis de raciocínio ' +
      '(think levels) cada um aceita. Use ANTES de escolher um modelo ou um nível de esforço.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'filtra por parte do id ou do nome' },
        limit: { type: 'number', description: 'máximo de resultados (padrão 20)' },
      },
    },
    run: async (args, apiKey) => {
      const cat = await ensureCatalog(apiKey);
      const busca = str(args.search)?.toLowerCase();
      let rows = cat.models;
      if (busca) {
        rows = rows.filter(
          (m) => m.id.toLowerCase().includes(busca) || m.name.toLowerCase().includes(busca),
        );
      }
      return {
        count: rows.length,
        models: rows.slice(0, numOf(args.limit) ?? 20).map(toExportRow),
      };
    },
  },
  {
    name: 'estimate_cost',
    description:
      'Estima quanto uma configuração vai custar, SEM chamar nenhum modelo. ' +
      'Aceita arena-config@1 ou RunConfig. Rode isto antes de qualquer run cara.',
    inputSchema: {
      type: 'object',
      properties: { config: { type: 'object', description: 'a configuração da run' } },
      required: ['config'],
    },
    run: async (args, apiKey) => {
      const cfg = await toRunConfig(args.config);
      const cat = await ensureCatalog(apiKey);
      return estimateRunCost(estimateInputFromConfig(cfg), cat.models);
    },
  },
  {
    name: 'run_benchmark',
    description:
      'Roda um benchmark (compare ou vary) até o fim e devolve o resultado. ' +
      'budgetUsd é OBRIGATÓRIO — é o teto de gasto em dólares.',
    inputSchema: {
      type: 'object',
      properties: {
        config: { type: 'object' },
        budgetUsd: { type: 'number', description: 'teto de gasto em USD' },
      },
      required: ['config', 'budgetUsd'],
    },
    run: async (args, apiKey, { signal, exclusive }) => {
      const base = await toRunConfig(args.config);
      const budgetUsd = numOf(args.budgetUsd);
      if (budgetUsd === undefined || budgetUsd <= 0) {
        throw new Error('budgetUsd é obrigatório e deve ser maior que zero.');
      }
      if (base.mode === 'training') {
        throw new Error('Use train_prompt para o modo training.');
      }
      await ensureCatalog(apiKey);
      const cfg: RunConfig = { ...base, budgetUsd };
      // IMPL-025: o sinal da requisição É o do motor (mesmo caminho do Ctrl-C do CLI).
      const rec = await exclusive(() =>
        runToCompletion(cfg, apiKey, prepareOptsFor(cfg, apiKey, { ctx: { signal } })),
      );
      return {
        runId: rec.id,
        status: rec.status,
        stoppedReason: rec.stoppedReason,
        totalCostUsd: rec.totalCostUsd,
        costByRole: rec.costByRole,
        budgetExhausted: Boolean(rec.budgetExhausted),
        stoppedAtPhase: rec.stoppedAtPhase,
        standings: rec.standings,
        judgeScoreByContestant: rec.judgeScoreByContestant,
      };
    },
  },
  {
    name: 'train_prompt',
    description:
      'Treina um system prompt ao longo de iterações e devolve o prompt campeão, ' +
      'com holdout e significância. budgetUsd é OBRIGATÓRIO.',
    inputSchema: {
      type: 'object',
      properties: {
        config: { type: 'object', description: 'configuração com mode "training"' },
        budgetUsd: { type: 'number' },
      },
      required: ['config', 'budgetUsd'],
    },
    run: async (args, apiKey, { signal, exclusive }) => {
      const base = await toRunConfig(args.config);
      const budgetUsd = numOf(args.budgetUsd);
      if (budgetUsd === undefined || budgetUsd <= 0) {
        throw new Error('budgetUsd é obrigatório e deve ser maior que zero.');
      }
      if (base.mode !== 'training') throw new Error('config.mode precisa ser "training".');
      await ensureCatalog(apiKey);
      const rec = await exclusive(() => trainToCompletion({ ...base, budgetUsd }, apiKey, { signal }));
      const campeao = rec.bestPromptByIteration.at(-1);
      return {
        sessionId: rec.id,
        status: rec.status,
        stoppedReason: rec.stoppedReason,
        totalCostUsd: rec.totalCostUsd,
        costByRole: rec.costByRole,
        iterationsDone: rec.bestPromptByIteration.length,
        championPrompt: campeao?.systemPrompt,
        holdout: rec.holdout,
        significance: rec.significance,
        // Sem o holdout o ganho NAO esta validado contra sobreajuste.
        holdoutSkipped: Boolean(rec.holdoutSkipped),
        budgetExhausted: Boolean(rec.budgetExhausted),
      };
    },
  },
  {
    name: 'get_result',
    description: 'Lê o resultado completo de uma run ou sessão já executada, pelo id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        kind: { type: 'string', enum: ['run', 'session'] },
      },
      required: ['id'],
    },
    noKey: true,
    run: async (args) => {
      // IMPL-024: id com '../' (ou fora do formato) é REJEITADO antes de tocar o
      // disco — a mensagem não ecoa o valor recebido.
      const id = args.id;
      assertValidRecordId(id);
      const kind = args.kind;
      if (kind !== undefined && kind !== 'run' && kind !== 'session') {
        throw new Error('kind deve ser "run" ou "session".');
      }
      if (kind === 'session') return (await loadSession(id)) ?? { error: 'sessão não encontrada' };
      return (await loadRun(id)) ?? (await loadSession(id)) ?? { error: 'não encontrado' };
    },
  },
  {
    name: 'run_agent_benchmark',
    description:
      'Roda um benchmark de AGENTES (arena-agent-config@1) até o fim e devolve um resumo. ' +
      'config é um JSON string; budgetUsd é OBRIGATÓRIO.',
    inputSchema: {
      type: 'object',
      properties: {
        config: { type: 'string', description: 'JSON string de arena-agent-config@1' },
        budgetUsd: { type: 'number', description: 'teto de gasto em USD' },
      },
      required: ['config', 'budgetUsd'],
    },
    run: async (args, apiKey, { signal, exclusive }) => {
      // Validacao nunca derruba o servidor: erros viram {ok:false, error}.
      let cfg: RunConfig;
      try {
        cfg = parseAgentConfigRaw(args.config);
      } catch (err) {
        return { ok: false, error: publicErrorMessage(err) };
      }
      const budgetUsd = numOf(args.budgetUsd);
      if (budgetUsd === undefined || budgetUsd <= 0) {
        return { ok: false, error: 'budgetUsd é obrigatório e deve ser maior que zero.' };
      }
      let rec: RunRecord;
      try {
        await ensureCatalog(apiKey);
        rec = await exclusive(() =>
          runToCompletion({ ...cfg, budgetUsd }, apiKey, prepareOptsFor(cfg, apiKey, { ctx: { signal } })),
        );
      } catch (err) {
        // Cancelado na fila: controle, não erro de config (IMPL-025).
        if (isControlSignal(err)) throw err;
        // IMPL-024: erro de workspace/executor costuma citar caminho absoluto.
        return { ok: false, error: publicErrorMessage(err) };
      }
      return {
        ok: true,
        runId: rec.id,
        status: rec.status,
        stoppedReason: rec.stoppedReason,
        totalCostUsd: rec.totalCostUsd,
        agentSummary: agentSummary(rec),
      };
    },
  },
  {
    name: 'get_agent_dossier',
    description:
      'Lê o dossiê (dossier.md) de uma execução de agente — o MESMO texto que o juiz viu. ' +
      'Diagnóstico: para entender por que um contestant perdeu uma etapa.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        stageIndex: { type: 'number' },
        contestantId: { type: 'string' },
        repetition: { type: 'number', description: '0-based; default 0' },
      },
      required: ['runId', 'stageIndex', 'contestantId'],
    },
    noKey: true,
    run: async (args) => {
      assertValidRecordId(args.runId, 'runId');
      const rec = await loadRun(args.runId);
      const stage = rec?.stages[numOf(args.stageIndex) ?? 0];
      const ref = stage?.responses.find(
        (r) => r.contestantId === str(args.contestantId) && r.execution && r.execution.repetition === (numOf(args.repetition) ?? 0),
      )?.execution;
      if (!ref) return { ok: false, error: 'dossier não encontrado' };
      const content = await readArtifact(ref, 'dossier.md');
      if (content === null) return { ok: false, error: 'dossier não encontrado' };
      const sha256 = createHash('sha256').update(content).digest('hex');
      return { ok: true, dossier: content, sha256, truncated: Boolean(ref.dossierTruncated) };
    },
  },
  {
    name: 'read_docs',
    description:
      'Lê a documentação embarcada nesta versão do prompt-builder. ' +
      'Sem "topic", devolve a lista de tópicos. Comece por "quickstart".',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string' } },
    },
    noKey: true,
    run: async (args) => {
      if (args.topic === undefined || args.topic === '') {
        const raw = await fs.readFile(path.join(PKG_DOCS_DIR, 'index.json'), 'utf-8');
        return JSON.parse(raw);
      }
      // IMPL-024: tópico por ALLOWLIST (mesma função do `docs` do CLI) — o input
      // nunca entra num path.join; `{topic:'../README'}` é rejeitado.
      const lido = await readDocTopic(args.topic);
      if (!lido.ok) throw new Error(lido.message);
      return { topic: lido.topic, content: lido.content };
    },
  },
];

/** Resultado de `tools/call` (o `result` do JSON-RPC). */
export interface ToolCallResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface CallToolOptions {
  /** Cancelamento cooperativo (IMPL-025): vira o AbortSignal do motor. */
  signal?: AbortSignal;
  /** Fila de runs pesadas. Padrão: a do processo (1 run por vez). */
  lane?: HeavyLane;
  /** Narração (stderr no servidor real). */
  log?: (msg: string) => void;
  /** Só testes: substitui a tabela de ferramentas. */
  tools?: readonly McpTool[];
}

/** Sinal que nunca aborta — chamadas diretas (testes, CLI) sem cancelamento. */
const NUNCA_ABORTA = new AbortController().signal;

/**
 * Executa UMA tool e devolve o `result` do `tools/call`. Exportado para os
 * testes de contrato (test/security-baseline.test.ts). Erro de ferramenta vai
 * como resultado com `isError`, não como erro de protocolo: o agente precisa
 * LER a mensagem para se corrigir — e ela sai sem caminho absoluto (IMPL-024).
 */
export async function callTool(
  name: unknown,
  args: Record<string, unknown>,
  getKey: () => Promise<string> = async () => '',
  opts: CallToolOptions = {},
): Promise<ToolCallResult | null> {
  const tool = (opts.tools ?? TOOLS).find((t) => t.name === name);
  if (!tool) return null;
  const signal = opts.signal ?? NUNCA_ABORTA;
  const lane = opts.lane ?? processLane;
  const ctx: ToolCtx = {
    signal,
    exclusive: (fn) => {
      if (lane.busy) {
        opts.log?.(
          `[mcp] ${tool.name} aguardando a vez — 1 run pesada por processo ` +
            `(${lane.snapshot().queued + 1} na fila)`,
        );
      }
      return lane.run(fn, signal);
    },
  };
  try {
    const key = tool.noKey ? '' : await getKey();
    const out = await tool.run(args, key, ctx);
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: publicErrorMessage(err) }], isError: true };
  }
}

// ---------------------------------------------------------------------------
// Sessão JSON-RPC (transporte-agnóstica: o stdio real e os testes a dirigem)
// ---------------------------------------------------------------------------

export interface McpSessionOptions {
  /** Escreve UMA mensagem JSON-RPC (uma linha) no transporte. */
  write: (msg: Record<string, unknown>) => void;
  /** Resolvida preguiçosamente: `read_docs` funciona sem key. */
  getKey?: () => Promise<string>;
  log?: (msg: string) => void;
  lane?: HeavyLane;
  /** Graça do encerramento (EOF/SIGTERM). Padrão SHUTDOWN_GRACE_MS (10 s). */
  graceMs?: number;
  /** Só testes: substitui a tabela de ferramentas. */
  tools?: readonly McpTool[];
}

export interface ShutdownResult {
  /** A graça esgotou com chamadas ainda pendentes (o processo sai assim mesmo). */
  forced: boolean;
  /** Chamadas ainda pendentes quando a espera terminou. */
  pending: number;
}

interface InflightCall {
  tool: string;
  controller: AbortController;
  /** Cancelada pelo CLIENTE (notifications/cancelled): nenhuma resposta sai. */
  cancelled: boolean;
  done: Promise<void>;
}

/**
 * Chave do mapa de chamadas em voo. JSON-RPC distingue `1` de `"1"`, e o
 * `requestId` do cancelamento precisa casar com o id EXATO da requisição.
 */
function requestKey(id: unknown): string {
  return JSON.stringify(id);
}

/** Texto curto e de uma linha para a narração (motivo vem do cliente). */
function umaLinha(v: unknown, max = 200): string {
  return String(v).replace(/\s+/gu, ' ').trim().slice(0, max);
}

/**
 * Linha de narração do parcial de uma chamada cancelada, a partir do resumo
 * que a ferramenta devolveu (e que NÃO vai ao cliente): onde ficou gravado,
 * como terminou e quanto o ledger mediu. É o "log do ledger" do cancelamento.
 */
function resumoDoParcial(result: ToolCallResult | null): string | undefined {
  try {
    const out = JSON.parse(result?.content[0]?.text ?? '') as {
      runId?: unknown;
      sessionId?: unknown;
      status?: unknown;
      stoppedReason?: unknown;
      totalCostUsd?: unknown;
    };
    const alvo =
      typeof out.runId === 'string'
        ? `run ${out.runId}`
        : typeof out.sessionId === 'string'
          ? `sessão ${out.sessionId}`
          : undefined;
    if (!alvo) return undefined;
    const fim = [out.status, out.stoppedReason].filter((x) => typeof x === 'string').join('/');
    const gasto = typeof out.totalCostUsd === 'number' ? `, gasto medido US$ ${out.totalCostUsd.toFixed(6)}` : '';
    return `${alvo} ${fim}${gasto} — parcial em get_result`;
  } catch {
    return undefined;
  }
}

export class McpSession {
  private readonly inflight = new Map<string, InflightCall>();
  private closing: Promise<ShutdownResult> | null = null;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: McpSessionOptions) {
    this.log = opts.log ?? (() => undefined);
  }

  /** Chamadas de ferramenta ainda em andamento. */
  get pendingCalls(): number {
    return this.inflight.size;
  }

  /** Encerramento já pedido (EOF/SIGTERM): novas `tools/call` são recusadas. */
  get isClosing(): boolean {
    return this.closing !== null;
  }

  /**
   * Uma linha do transporte. NUNCA espera a ferramenta terminar: devolve o
   * controle ao laço de leitura na hora, e a resposta sai quando ela assentar.
   */
  handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.replyError(null, -32700, 'JSON inválido');
      return;
    }
    this.handleMessage(msg);
  }

  handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this.replyError(null, -32600, 'Requisição inválida');
      return;
    }
    const req = msg as JsonRpcRequest & { result?: unknown; error?: unknown };
    // Notificacoes (sem `id`) nao recebem resposta — responder quebra o cliente.
    const isNotification = req.id === undefined || req.id === null;
    if (typeof req.method !== 'string') {
      // Resposta do cliente (este servidor nunca pede nada) ou lixo sem método.
      if (!isNotification && !('result' in req) && !('error' in req)) {
        this.replyError(req.id, -32600, 'Requisição inválida');
      }
      return;
    }

    try {
      switch (req.method) {
        case 'initialize': {
          const pedido = str((req.params as Record<string, unknown>)?.protocolVersion);
          this.reply(req.id, {
            // Ecoa a versao pedida quando conhecida; senao anuncia a nossa.
            protocolVersion: pedido ?? PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          });
          return;
        }
        case 'notifications/initialized':
          return;
        case 'notifications/cancelled':
          this.cancel(req.params);
          return;
        case 'ping':
          if (!isNotification) this.reply(req.id, {});
          return;
        case 'tools/list':
          if (!isNotification) {
            this.reply(req.id, {
              tools: (this.opts.tools ?? TOOLS).map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
            });
          }
          return;
        case 'tools/call':
          // Sem id não haveria como devolver o resultado nem cancelar: uma run
          // paga disparada assim seria gasto órfão por construção.
          if (isNotification) {
            this.log('[mcp] tools/call sem id ignorado (notificação não pode disparar ferramenta)');
            return;
          }
          this.startCall(req.id as string | number, req.params);
          return;
        default:
          if (!isNotification) {
            this.replyError(req.id, -32601, `Método não suportado: ${umaLinha(req.method, 80)}`);
          }
      }
    } catch (err) {
      if (!isNotification) this.replyError(req.id, -32603, publicErrorMessage(err));
    }
  }

  /**
   * Encerramento gracioso (EOF do stdin, SIGTERM, stdout quebrado): aborta
   * TODAS as chamadas em voo — as runs gravam o parcial como 'aborted' — e
   * espera no máximo `graceMs`. As respostas dessas chamadas ainda saem (o
   * cliente não as cancelou; só foi embora). Idempotente.
   */
  shutdown(reason: string): Promise<ShutdownResult> {
    if (this.closing) return this.closing;
    const graceMs = this.opts.graceMs ?? SHUTDOWN_GRACE_MS;
    const calls = [...this.inflight.values()];
    for (const c of calls) c.controller.abort(new RunCancelled(`servidor MCP encerrando (${reason})`));
    if (calls.length > 0) {
      this.log(
        `[mcp] encerrando (${reason}): ${calls.length} chamada(s) em andamento abortada(s); ` +
          `graça de ${Math.round(graceMs / 1000)} s para gravar o parcial`,
      );
    }
    this.closing = settleWithin(
      calls.map((c) => c.done),
      graceMs,
    ).then((ok) => {
      const pending = this.inflight.size;
      if (!ok) this.log(`[mcp] graça esgotada com ${pending} chamada(s) pendente(s); saindo assim mesmo`);
      return { forced: !ok, pending };
    });
    return this.closing;
  }

  // --- interno ---------------------------------------------------------------

  private startCall(id: string | number, params: unknown): void {
    if (this.closing) {
      this.replyError(id, -32000, 'Servidor MCP encerrando: chamada recusada.');
      return;
    }
    const key = requestKey(id);
    if (this.inflight.has(key)) {
      // Ids precisam ser únicos na sessão; reusar um em voo tornaria o
      // cancelamento ambíguo (qual das duas parar?).
      this.replyError(id, -32600, 'id de requisição já em uso por uma chamada em andamento.');
      return;
    }
    const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
    const args =
      p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments)
        ? (p.arguments as Record<string, unknown>)
        : {};
    const call: InflightCall = {
      tool: umaLinha(p.name, 80),
      controller: new AbortController(),
      cancelled: false,
      done: Promise.resolve(),
    };
    this.inflight.set(key, call);
    call.done = (async () => {
      try {
        const result = await callTool(p.name, args, this.opts.getKey, {
          signal: call.controller.signal,
          lane: this.opts.lane,
          log: this.log,
          tools: this.opts.tools,
        });
        if (call.cancelled) {
          // Spec (Cancellation): quem recebe o cancelamento NÃO responde. Não
          // existe "resultado parcial" no protocolo — o parcial vive no disco.
          const parcial = resumoDoParcial(result);
          this.log(
            `[mcp] ${umaLinha(id, 80)} (${call.tool}) cancelada — resposta suprimida` +
              (parcial ? `; ${parcial}` : ''),
          );
          return;
        }
        if (!result) {
          this.replyError(id, -32602, `Ferramenta desconhecida: ${call.tool}`);
          return;
        }
        this.reply(id, result);
      } catch (err) {
        // callTool não rejeita (erro de ferramenta vira isError); rede de segurança.
        if (!call.cancelled) this.replyError(id, -32603, publicErrorMessage(err));
      } finally {
        this.inflight.delete(key);
      }
    })();
  }

  private cancel(params: unknown): void {
    const p = (params ?? {}) as { requestId?: unknown; reason?: unknown };
    if (typeof p.requestId !== 'string' && typeof p.requestId !== 'number') return;
    const call = this.inflight.get(requestKey(p.requestId));
    // Desconhecida ou já respondida (a notificação cruzou com a resposta) — e
    // `initialize`, que nunca fica em voo: a spec manda ignorar.
    if (!call || call.cancelled) return;
    call.cancelled = true;
    const motivo = typeof p.reason === 'string' && p.reason.trim() ? umaLinha(p.reason) : 'sem motivo';
    this.log(
      `[mcp] notifications/cancelled para ${umaLinha(p.requestId, 80)} (${call.tool}): ${motivo} — ` +
        'abortando; nenhuma chamada paga nova e nenhuma resposta',
    );
    // O motivo é um SINAL DE CONTROLE: o fetch em voo rejeita com ele e os
    // catch que degradam (competidor/juiz/duelo) o re-lançam (isControlSignal).
    call.controller.abort(new RunCancelled(`cliente MCP cancelou (${motivo})`));
  }

  private reply(id: unknown, result: unknown): void {
    this.opts.write({ jsonrpc: '2.0', id, result });
  }

  private replyError(id: unknown, code: number, message: string): void {
    this.opts.write({ jsonrpc: '2.0', id, error: { code, message } });
  }
}

// ---------------------------------------------------------------------------
// Servidor por stdio
// ---------------------------------------------------------------------------

/** 128 + 15: convenção POSIX para "encerrado por SIGTERM". */
const EXIT_SIGTERM = 143;

type MotivoFim = 'eof' | 'SIGTERM' | 'SIGINT' | 'EPIPE';

function codigoDeSaida(motivo: MotivoFim): number {
  if (motivo === 'SIGTERM') return EXIT_SIGTERM;
  if (motivo === 'SIGINT') return EXIT.SIGINT;
  return EXIT.OK;
}

/** Espera o stdout escoar (pipe assíncrono fora do Linux), com teto. */
function flushStdout(maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, maxMs);
    process.stdout.write('', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export async function cmdMcp(argv: string[]): Promise<number> {
  const parsed = parse(argv, {});
  setDataDir(resolveHome(parsed.values));

  // A key e resolvida preguicosamente: `read_docs` funciona sem nenhuma key, e
  // um servidor MCP nao deve morrer no boot por causa disso.
  let apiKeyCache: string | null = null;
  const getKey = async (): Promise<string> => {
    if (apiKeyCache) return apiKeyCache;
    apiKeyCache = await resolveKey(parsed.values);
    return apiKeyCache;
  };

  // stdout é o canal JSON-RPC; narração vai para o stderr (o cliente a loga).
  let stdoutQuebrado = false;
  const session = new McpSession({
    write: (msg) => {
      if (!stdoutQuebrado) process.stdout.write(`${JSON.stringify(msg)}\n`);
    },
    getKey,
    log: (m) => {
      process.stderr.write(`${m}\n`);
    },
  });

  let motivo: MotivoFim | null = null;
  let terminar!: (m: MotivoFim) => void;
  const fim = new Promise<MotivoFim>((resolve) => (terminar = resolve));
  const pedirFim = (m: MotivoFim): void => {
    if (motivo) return;
    motivo = m;
    terminar(m);
  };

  // O laço de leitura só DESPACHA: nenhum handler espera ferramenta.
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => session.handleLine(line));
  // EOF do stdin = o cliente pediu o encerramento (transporte stdio do MCP).
  rl.once('close', () => pedirFim('eof'));

  const onSinal = (sig: 'SIGTERM' | 'SIGINT'): void => {
    // Segundo sinal durante a graça: o cliente perdeu a paciência — sai já.
    if (motivo) process.exit(codigoDeSaida(sig));
    pedirFim(sig);
  };
  const onSigterm = (): void => onSinal('SIGTERM');
  const onSigint = (): void => onSinal('SIGINT');
  // Cliente morreu: escrever no pipe fechado daria EPIPE e derrubaria o
  // processo SEM gravar o parcial das runs em voo.
  const onStdoutError = (): void => {
    stdoutQuebrado = true;
    pedirFim('EPIPE');
  };
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);
  process.stdout.on('error', onStdoutError);

  const razao = await fim;
  await session.shutdown(razao);
  rl.close();
  process.stdin.destroy();
  if (!stdoutQuebrado) await flushStdout(1000);
  process.off('SIGTERM', onSigterm);
  process.off('SIGINT', onSigint);
  // Saída EXPLÍCITA: depois da graça pode sobrar trabalho que ignorou o abort
  // (ou um socket vivo) e o cliente não pode ficar esperando o processo sumir.
  process.exit(codigoDeSaida(razao));
}
