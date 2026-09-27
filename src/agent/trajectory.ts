// ----------------------------------------------------------------------------
// `fromPi` — normaliza o rastro CRU do executor (`--mode json`) para o formato
// canônico `AgentTrajectory`.
//
// `dossier.ts`, `agentJudge.ts` e a UI leem SÓ daqui — nunca o formato de um
// executor específico — senão trocar de executor (pi → codex → claude code)
// vira uma reescrita inteira. É uma função PURA que roda uma vez e grava
// `trajectory.json`; o bruto continua em disco (`events.jsonl`,
// `session/*.jsonl`). Normalizar não é descartar.
//
// Nomes de evento (autoridade: spike do pi 0.84.2):
//   session → agent_start → turn_start → message_start → message_update →
//   message_end → tool_execution_start → tool_execution_update →
//   tool_execution_end → turn_end → … → agent_end → agent_settled
//
// Regras que este módulo impõe (§14/§15 do PLANO-AGENT-ARENA):
// - `message_update` é DELTA-only e NÃO é remontado. A reconstrução usa
//   `message_end` (mensagem autoritativa com blocos text/thinking/toolCall) e
//   `turn_end` (traz message + toolResults completos).
// - `stopReason: 'pending'` nunca é persistido (é o estado durante o streaming).
// - `usage.cost` é *derivado do agente* (o pi calcula por tabela própria); a
//   reconciliação com o cobrado é papel futuro do runAgentStage.
// - Cap de saída por step (~8k chars) e de argumento — nunca um step infinito.
// ----------------------------------------------------------------------------
import type { AgentCostSource, AgentStep, AgentStopReason, AgentTrajectory, AgentTurn } from './types.js';
import type { ReasoningLevel } from '../types.js';

export interface FromPiOpts {
  /** Linhas parseadas do stream `--mode json` (cru). */
  events: unknown[];
  /** Linhas do transcript `sess/*.jsonl` — enriquecimento opcional (hoje não usado). */
  sessionLines?: unknown[];
  /** Override do runner (ex.: 'maxTurns' quando o processo foi morto pelo teto). */
  stopReason?: AgentStopReason;
  model?: { provider: string; id: string; thinking?: ReasoningLevel };
  /** Versão do executor ('pi'), para `executor.version`. */
  executorVersion?: string;
  /** Linhas do stream que não deram parse. > 0 ⇒ trajetória incompleta. */
  parseErrors?: number;
  /** Do runner, quando o stream não tem timestamps confiáveis. */
  startedAt?: string;
  finishedAt?: string;
}

// ---------------------------------------------------------------------------
// Helpers de leitura defensiva de objetos `unknown` (o stream é `unknown[]`).
// Nunca lança por causa de um campo ausente: degrade o default, nunca derrube.
// ---------------------------------------------------------------------------

type RawEvent = Record<string, unknown>;

function asObj(x: unknown): RawEvent {
  if (x !== null && typeof x === 'object') return x as RawEvent;
  return {};
}

function asStr(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined;
}

function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

function eventTs(e: RawEvent): string | undefined {
  return asStr(e.ts);
}

function msOf(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const n = Date.parse(date);
  return Number.isNaN(n) ? undefined : n;
}

const ARG_VALUE_CAP = 2000;
const OUTPUT_CAP = 8000;

/** Marca de truncamento obrigatória — o plano exige exatamente este shape. */
function trunc(str: string, cap: number): string {
  if (str.length <= cap) return str;
  return `${str.slice(0, cap)}\n…<${str.length - cap} chars omitidos>…`;
}

// ---------------------------------------------------------------------------
// Argumentos / saída truncados e marcados.
// ---------------------------------------------------------------------------

function truncateArgs(raw: RawEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') {
      out[k] = trunc(v, ARG_VALUE_CAP);
    } else if (v !== null && typeof v === 'object') {
      out[k] = trunc(JSON.stringify(v), ARG_VALUE_CAP);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** Bloco `toolCall` → arguments normalizado (longos truncados com marca). */
function normalizeArgs(argsRaw: unknown): Record<string, unknown> {
  if (typeof argsRaw === 'string') {
    try {
      const p = JSON.parse(argsRaw) as unknown;
      if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
        return truncateArgs(p as RawEvent);
      }
    } catch {
      // não é JSON válido — segue como string crua abaixo
    }
    return { raw: trunc(argsRaw, ARG_VALUE_CAP) };
  }
  if (argsRaw !== null && typeof argsRaw === 'object') {
    return truncateArgs(argsRaw as RawEvent);
  }
  if (argsRaw === undefined) return {};
  return { value: trunc(String(argsRaw), ARG_VALUE_CAP) };
}

/**
 * Extrai os blocos de uma `message` do executor. Aceita tanto `message.blocks`
 * quanto `message.content` (o pi documenta `blocks`, mas o fallback torna a
 * leitura tolerante sem reescrever nada quando um executor varia o campo).
 */
function messageBlocks(msg: unknown): RawEvent[] {
  const m = asObj(msg);
  const raw = m.blocks ?? m.content;
  if (Array.isArray(raw)) return raw.filter((b) => b !== null && typeof b === 'object') as RawEvent[];
  return [];
}

/**
 * Texto + pensamento de uma mensagem: TODOS os blocos text (em ordem, unidos por
 * '\n') e o ÚLTIMO bloco thinking legível.
 */
function messageTextAndThinking(
  msg: unknown,
): { text?: string; thinking?: string; thinkingOpaque: boolean } {
  const texts: string[] = [];
  let thinking: string | undefined;
  let thinkingOpaque = false;
  for (const b of messageBlocks(msg)) {
    const type = asStr(b.type);
    if (type === 'text') {
      const t = asStr(b.text) ?? asStr(b.content);
      if (t !== undefined && t.length > 0) texts.push(t);
    } else if (type === 'thinking') {
      const t = asStr(b.text) ?? asStr(b.thinking) ?? asStr(b.content);
      // O pi/Google pode expor o raciocínio como conteúdo OPACO
      // (`thoughtSignature`/`reasoning.encrypted`), ou como texto vazio — sem
      // conteúdo legível não reconstruímos daí: `thinking: undefined`.
      if (t !== undefined && t.trim().length > 0) {
        thinking = t;
      }
    }
  }
  // Proteção extra: uma mensagem marcada com assinatura de raciocínio opaco
  // (sem texto legível) é tratada como opaca.
  if (thinking === undefined && (asObj(msg).thoughtSignature !== undefined || asObj(msg).reasoning !== undefined)) {
    thinkingOpaque = true;
  }
  if (thinkingOpaque) thinking = undefined;
  return { text: texts.length > 0 ? texts.join('\n') : undefined, thinking, thinkingOpaque };
}

/**
 * A mensagem é do ASSISTENTE? No pi, `message_end` sai para TODA mensagem do
 * turno: o prompt do usuário (1º turno), a do assistente e cada `toolResult`.
 * Só a do assistente tem texto/pensamento/toolCalls do agente — ler as outras
 * poria a TAREFA e as SAÍDAS das ferramentas na "mensagem final" do dossiê.
 * Sem `role` (executor que não o expõe): tratada como do assistente.
 */
function isAssistantMessage(msg: unknown): boolean {
  const role = asStr(asObj(msg).role);
  return role === undefined || role === 'assistant';
}

/**
 * Texto da saída de uma ferramenta. O pi devolve `{ content: [{type:'text',
 * text}], details }`: o que o agente leu é o texto dos blocos, não o JSON do
 * envelope. String crua passa como está; o resto vira JSON (nunca some).
 */
function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  const content = asObj(result).content;
  if (Array.isArray(content)) {
    const texts = content
      .map((b) => asObj(b))
      .filter((b) => asStr(b.type) === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string);
    if (texts.length > 0) return texts.join('\n');
  }
  return JSON.stringify(result) ?? '';
}

/**
 * O `bash` do pi não expõe exit code em campo: comando com exit ≠ 0 vira
 * `isError` com o texto terminando em "Command exited with code N".
 */
const BASH_EXIT_RE = /Command exited with code (-?\d+)\s*$/;

// ---------------------------------------------------------------------------
// Uso (tokens/custo). O pi calcula por tabela própria ⇒ `costSource: 'agent-derived'`.
// ---------------------------------------------------------------------------

interface UsageFields {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
}

function sameUsage(a: UsageFields, b: UsageFields): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.reasoning === b.reasoning &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite &&
    a.totalTokens === b.totalTokens &&
    a.costTotal === b.costTotal
  );
}

/**
 * Extrai o uso de UMA mensagem do executor. Campos documentados no plano:
 *   message.usage.{input,output,cacheRead,cacheWrite,totalTokens}
 *   message.usage.cost.{input,output,cacheRead,cacheWrite,total}
 * Aceita snake_case de fallback (`cache_read`, `total_tokens`).
 */
function extractUsage(msg: unknown): UsageFields | null {
  const u = asObj(asObj(msg).usage);
  const hasAny =
    u.input !== undefined ||
    u.output !== undefined ||
    u.cacheRead !== undefined ||
    u.cache_read !== undefined ||
    u.cacheWrite !== undefined ||
    u.cache_write !== undefined ||
    u.totalTokens !== undefined ||
    u.total_tokens !== undefined ||
    u.cost !== undefined;
  if (!hasAny) return null;
  const cost = asObj(u.cost);
  return {
    input: num(u.input),
    output: num(u.output),
    reasoning: num(u.reasoning) + num(u.thinking),
    cacheRead: num(u.cacheRead ?? u.cache_read),
    cacheWrite: num(u.cacheWrite ?? u.cache_write),
    totalTokens: num(u.totalTokens ?? u.total_tokens),
    costTotal: num(cost.total),
    costInput: num(cost.input),
    costOutput: num(cost.output),
    costCacheRead: num(cost.cacheRead ?? cost.cache_read),
    costCacheWrite: num(cost.cacheWrite ?? cost.cache_write),
  };
}

/** `costUsd` de uma contribuição: usa cost.total; cai para a soma dos componentes. */
function costUsdOf(u: UsageFields): number {
  if (u.costTotal > 0) return u.costTotal;
  return u.costInput + u.costOutput + u.costCacheRead + u.costCacheWrite;
}

function addNotDupe(list: UsageFields[], u: UsageFields): void {
  // message_end e turn_end carregam a MESMA mensagem num turno típico; somar os
  // dois contaria em dobro. Dedupe por igualdade do uso registrado.
  if (list.some((e) => sameUsage(e, u))) return;
  list.push(u);
}

function totalOf(
  list: UsageFields[],
): { tokensIn: number; tokensOut: number; tokensReasoning: number; cacheRead: number; cacheWrite: number; costUsd: number } {
  return {
    tokensIn: sum(list, (u) => u.input),
    tokensOut: sum(list, (u) => u.output),
    tokensReasoning: sum(list, (u) => u.reasoning),
    cacheRead: sum(list, (u) => u.cacheRead),
    cacheWrite: sum(list, (u) => u.cacheWrite),
    costUsd: sum(list, costUsdOf),
  };
}

function sum(list: UsageFields[], f: (u: UsageFields) => number): number {
  let acc = 0;
  for (const u of list) acc += f(u);
  return acc;
}

// ---------------------------------------------------------------------------
// Steps: toolCall (message_end) correlacionado com tool_execution_* (toolCallId).
// ---------------------------------------------------------------------------

interface ExecStart {
  ts?: string;
}

interface ExecEnd {
  ts?: string;
  result?: unknown;
  isError?: boolean;
  exitCode?: number;
}

function extractExitCode(e: RawEvent): number | undefined {
  if (typeof e.exitCode === 'number') return e.exitCode;
  const meta = asObj(e.meta);
  if (typeof meta.exitCode === 'number') return meta.exitCode;
  const result = asObj(e.result);
  if (typeof result.exitCode === 'number') return result.exitCode;
  const rmeta = asObj(result.meta);
  if (typeof rmeta.exitCode === 'number') return rmeta.exitCode;
  return undefined;
}

// ---------------------------------------------------------------------------
// Turno: mensagens, steps, texto/pensamento, uso, stopReason do turno.
// ---------------------------------------------------------------------------

interface TurnBuilder {
  start: RawEvent;
  events: RawEvent[];
  end?: RawEvent;
}

/**
 * Constrói um `AgentTurn` a partir do segmento do stream entre `turn_start` e
 * `turn_end`. Devolve também o uso GLOBAL do turno (incl. reasoning/cache),
 * para consolidar o total da trajetória sem re-percorrer o stream.
 */
function buildTurn(t: TurnBuilder, index: number): { turn: AgentTurn; usage: UsageFields[] } {
  const textParts: string[] = [];
  let thinking: string | undefined = undefined;
  const usageList: UsageFields[] = [];
  const toolCalls: { id: string; name: string; arguments?: unknown }[] = [];
  const execStarts = new Map<string, ExecStart>();
  const execEnds = new Map<string, ExecEnd>();
  let messageStopReason: string | undefined;
  let sawAssistantMessage = false;

  const pushMessage = (msg: unknown): void => {
    // Prompt do usuário e `toolResult` também passam por message_end: não são
    // do agente (ver `isAssistantMessage`).
    if (!isAssistantMessage(msg)) return;
    sawAssistantMessage = true;
    const tt = messageTextAndThinking(msg);
    if (tt.text !== undefined) textParts.push(tt.text);
    if (tt.thinking !== undefined) thinking = tt.thinking;
    const u = extractUsage(msg);
    if (u) addNotDupe(usageList, u);
    for (const b of messageBlocks(msg)) {
      if (asStr(b.type) !== 'toolCall') continue;
      const id = asStr(b.id) ?? asStr(b.toolCallId);
      const name = asStr(b.name) ?? asStr(b['tool']);
      if (!id || toolCalls.some((tc) => tc.id === id)) continue;
      toolCalls.push({ id, name: name ?? 'unknown', arguments: b.arguments ?? b.args ?? b.input });
    }
    const sr = asStr(asObj(msg).stopReason);
    if (sr !== undefined && sr !== 'pending') messageStopReason = sr;
  };

  for (const ev of t.events) {
    const e = asObj(ev);
    const type = asStr(e.type) ?? '';
    if (type === 'message_end') {
      pushMessage(e.message ?? e);
    } else if (type === 'tool_execution_start') {
      // Correlaciona pela toolCallId; só registramos o início p/ calcular
      // durationMs. Nome/args do step vêm do bloco `toolCall` do message_end.
      const id = asStr(e.toolCallId) ?? asStr(asObj(e.toolCall).id);
      if (!id) continue;
      execStarts.set(id, { ts: eventTs(e) });
    } else if (type === 'tool_execution_end') {
      const id = asStr(e.toolCallId);
      if (!id) continue;
      execEnds.set(id, {
        ts: eventTs(e),
        result: e.result,
        isError: e.isError === true,
        exitCode: extractExitCode(e),
      });
    }
    // `message_update` é DELTA-only: intencionalmente ignorado aqui.
  }

  // turn_end traz a MESMA mensagem do assistente que o message_end do turno já
  // entregou (+ toolResults). Relê-la duplicaria o texto e cada passo; ela só é
  // lida quando o turno não teve message_end do assistente (stream cortado ou
  // executor que só emite turn_end). O stopReason do turno vem do message_end
  // (autoridade, §15); o do turn_end só é usado se nenhum message_end expôs um.
  if (t.end) {
    const m = asObj(t.end).message ?? asObj(t.end);
    if (!sawAssistantMessage) pushMessage(m);
    const sr = asStr(asObj(t.end).stopReason) ?? (isAssistantMessage(m) ? asStr(asObj(m).stopReason) : undefined);
    if (messageStopReason === undefined && sr !== undefined && sr !== 'pending') messageStopReason = sr;
  }

  const steps: AgentStep[] = [];
  for (const tc of toolCalls) {
    const start = execStarts.get(tc.id);
    const end = execEnds.get(tc.id);
    let output: string | undefined;
    let outputTruncated = false;
    if (end && end.result !== undefined) {
      const rawOut = toolResultText(end.result);
      outputTruncated = rawOut.length > OUTPUT_CAP;
      output = trunc(rawOut, OUTPUT_CAP);
    }
    const ok = end ? !end.isError : true;
    const bashExit = end?.isError && output !== undefined ? BASH_EXIT_RE.exec(output) : null;
    const exitCode = end?.exitCode ?? (bashExit ? Number(bashExit[1]) : undefined);
    const durationMs =
      start?.ts !== undefined && end?.ts !== undefined
        ? (() => {
            const a = msOf(start.ts);
            const b = msOf(end.ts);
            return a !== undefined && b !== undefined ? Math.max(0, b - a) : undefined;
          })()
        : undefined;
    const step: AgentStep = {
      id: tc.id,
      tool: tc.name,
      args: normalizeArgs(tc.arguments),
      ok,
      ...(output !== undefined ? { output } : {}),
      ...(outputTruncated ? { outputTruncated } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
    steps.push(step);
  }

  const turn: AgentTurn = {
    index,
    ...(textParts.length > 0 ? { text: textParts.join('\n') } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    steps,
    ...(messageStopReason !== undefined ? { stopReason: messageStopReason } : {}),
    ...(usageList.length > 0
      ? { usage: (() => { const t = totalOf(usageList); return { tokensIn: t.tokensIn, tokensOut: t.tokensOut, costUsd: t.costUsd }; })() }
      : {}),
  };

  return { turn, usage: usageList };
}

// ---------------------------------------------------------------------------
// `fromPi` — o ponto de entrada.
// ---------------------------------------------------------------------------

export function fromPi(opts: FromPiOpts): AgentTrajectory {
  const events = Array.isArray(opts.events) ? opts.events : [];

  // ---- segmenta o stream em turnos, num passe único ------------------------
  const segments: TurnBuilder[] = [];
  let current: TurnBuilder | null = null;
  const compactions: { at: string; tokensBefore: number }[] = [];
  let lastEventType = '';

  for (const raw of events) {
    const e = asObj(raw);
    const type = asStr(e.type) ?? '';
    if (type !== '') lastEventType = type;

    if (type === 'turn_start') {
      if (current) segments.push(current); // turno não terminado (stream cortado)
      current = { start: e, events: [] };
      continue;
    }
    if (type === 'turn_end') {
      if (current) {
        current.end = e;
        segments.push(current);
        current = null;
      }
      continue;
    }
    if (current) current.events.push(e);

    // Compactação de contexto — o pi faz isso sozinho; evento que menciona
    // 'compact' no tipo. tokensBefore: o pi não expõe; registramos 0 (§15.1).
    if (type.toLowerCase().includes('compact')) {
      compactions.push({ at: eventTs(e) ?? opts.startedAt ?? '', tokensBefore: 0 });
    }
  }
  if (current) segments.push(current);

  // ---- monta os turnos e consolida o uso -----------------------------------
  const turns: AgentTurn[] = [];
  const allUsage: UsageFields[] = [];
  for (let i = 0; i < segments.length; i++) {
    const built = buildTurn(segments[i], i);
    turns.push(built.turn);
    for (const u of built.usage) addNotDupe(allUsage, u);
  }

  const usage = totalOf(allUsage);

  // ---- consistência com agent_end.messages[] -------------------------------
  // O uso derivado (message_end/turn_end) é o autoritativo. agent_end também
  // carrega usage por mensagem; se divergir, narramos (stderr) e seguimos com o
  // nosso — nenhuma linha de payload é corrompida (stdout é PAYLOAD no motor).
  let agentEndTokensIn = 0;
  let agentEndCostUsd = 0;
  let agentEndSeen = false;
  for (const raw of events) {
    const e = asObj(raw);
    if (asStr(e.type) !== 'agent_end') continue;
    agentEndSeen = true;
    const messages = e.messages;
    if (!Array.isArray(messages)) continue;
    for (const m of messages) {
      const u = extractUsage(m);
      if (!u) continue;
      agentEndTokensIn += u.input;
      agentEndCostUsd += costUsdOf(u);
    }
  }
  if (agentEndSeen && (agentEndTokensIn !== usage.tokensIn || agentEndCostUsd !== usage.costUsd)) {
    console.warn(
      `[trajectory] usage divergente: agent_end(${agentEndTokensIn} in / ${agentEndCostUsd} USD) ` +
        `vs message_end/turn_end(${usage.tokensIn} in / ${usage.costUsd} USD); usando message_end/turn_end`,
    );
  }

  // ---- timestamps ----------------------------------------------------------
  const firstTs = events.length > 0 ? eventTs(asObj(events[0])) : undefined;
  const lastTs = events.length > 0 ? eventTs(asObj(events[events.length - 1])) : undefined;
  const startedAt = opts.startedAt ?? firstTs ?? new Date(0).toISOString();
  const finishedAt = opts.finishedAt ?? lastTs ?? startedAt;
  const sMs = msOf(startedAt);
  const fMs = msOf(finishedAt);
  const durationMs = sMs !== undefined && fMs !== undefined ? Math.max(0, fMs - sMs) : 0;

  // ---- stopReason da trajetória --------------------------------------------
  // Override do runner tem prioridade. Sem ele: agent_settled/agent_end ⇒
  // 'completed'; stream sem terminal (cortado) ⇒ 'error'.
  let stopReason: AgentStopReason;
  if (opts.stopReason !== undefined) {
    stopReason = opts.stopReason;
  } else if (lastEventType === 'agent_settled' || lastEventType === 'agent_end') {
    stopReason = 'completed';
  } else {
    stopReason = 'error';
  }

  const model = opts.model
    ? {
        provider: opts.model.provider,
        id: opts.model.id,
        ...(opts.model.thinking !== undefined ? { thinking: opts.model.thinking } : {}),
      }
    : { provider: 'unknown', id: 'unknown' };

  return {
    format: 'agent-trajectory@1',
    executor: { id: 'pi', version: opts.executorVersion ?? 'unknown' },
    model,
    startedAt,
    finishedAt,
    durationMs,
    stopReason,
    turns,
    usage: {
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      tokensReasoning: usage.tokensReasoning,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      costUsd: usage.costUsd,
      costSource: 'agent-derived',
    },
    parseErrors: opts.parseErrors ?? 0,
    compactions,
  };
}


// ---------------------------------------------------------------------------
// IMPL-095 — `agent-trajectory@2` + conversores ATIF (RFC 0001 do Harbor).
//
// ATIF ("Agent Trajectory Interchange Format", RFC 0001 do Harbor, v1.7) é o
// ÚNICO formato de intercâmbio de trajetória cross-ferramenta estável: cobre
// mensagens, reasoning, tool calls, observações, usage e custo. Ele é o formato
// de TROCA, nunca o contrato interno — o contrato interno continua sendo
// `AgentTrajectory` (e o dossiê/juiz leem só ele).
//
// Regras de mapeamento (as duas direções):
//   turn                ↔ step (1:1, na ordem)
//   turn.text           ↔ step.message
//   turn.thinking       ↔ step.reasoning_content
//   turn.source         ↔ step.source ('agent' default em @1)
//   turn.timestamp      ↔ step.timestamp
//   AgentStep           ↔ tool_call (id↔tool_call_id, tool↔function_name,
//                          args↔arguments) + observation result
//                          (source_call_id↔id, content↔output)
//   turn.usage          ↔ step.metrics (tokensIn↔prompt_tokens,
//                          tokensOut↔completion_tokens, costUsd↔cost_usd)
//   turn.stopReason     ↔ step.extra.stop_reason
//   trajectory.usage    ↔ final_metrics (+ cache/tokensReasoning/costSource em
//                          extra.pb — o ATIF só tem total_cached_tokens)
//   trajectory.stopReason ↔ extra.stop_reason
//
// Campos fora do núcleo canônico (ok/exitCode/durationMs/outputTruncated,
// compactions, startedAt/finishedAt exatos…) viajam em `extra.pb` — mecanismo
// SANÇÃONADO pelo próprio RFC para metadados próprios. Por isso o round-trip
// ATIF→próprio→ATIF é sem perda nos campos canônicos (mensagens, tool calls,
// usage, stopReason, timestamps) e a única perda DECLARADA é `parseErrors`
// (linhas/entradas ilegíveis, que não existiam como dado aproveitável).
// ---------------------------------------------------------------------------

/** Versão do ATIF emitida/aceite (RFC 0001 v1.7 — a que o Harbor valida). */
export const ATIF_SCHEMA_VERSION = 'ATIF-v1.7';

/** Quem falhou/falou num step (RFC 0001). */
export type AtifSource = 'system' | 'user' | 'agent';

export interface AtifToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface AtifObservationResult {
  source_call_id: string;
  content: string;
}

export interface AtifObservation {
  results: AtifObservationResult[];
}

export interface AtifStepMetrics {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  cost_usd?: number;
  reasoning_tokens?: number;
}

export interface AtifStep {
  step_id: number;
  source: AtifSource;
  /** String OU array de content parts (RFC 0001). */
  message: string | unknown[];
  timestamp?: string;
  model_name?: string;
  reasoning_effort?: unknown;
  reasoning_content?: string;
  tool_calls?: AtifToolCall[];
  observation?: AtifObservation;
  metrics?: AtifStepMetrics;
  is_copied_context?: boolean;
  extra?: Record<string, unknown>;
}

export interface AtifAgent {
  name: string;
  version?: string;
  model_name?: string;
  extra?: Record<string, unknown>;
}

export interface AtifFinalMetrics {
  model_name?: string;
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_cached_tokens?: number;
  total_cost_usd?: number;
  total_steps?: number;
  llm_call_count?: number;
  notes?: string;
  extra?: Record<string, unknown>;
}

export interface AtifTrajectory {
  schema_version: string;
  session_id?: string;
  trajectory_id?: string;
  agent: AtifAgent;
  steps: AtifStep[];
  final_metrics?: AtifFinalMetrics;
  extra?: Record<string, unknown>;
}

/**
 * Relatório de perda da conversão ATIF↔próprio (IMPL-095). A única perda
 * TOLERADA é `parseErrors` (entrada ilegível — não havia dado aproveitável);
 * `droppedCanonical` tem de ficar VAZIO: perda de campo canônico é defeito.
 */
export interface AtifLossReport {
  /** Entradas ilegíveis/não-mapeáveis (declarado). */
  parseErrors: number;
  /** Campos canônicos perdidos. Esperado: sempre vazio. */
  droppedCanonical: string[];
  /** Normalizações/descartes não-canônicos, documentados. */
  notes: string[];
}

type AnyObj = Record<string, unknown>;

function objOr(x: unknown): AnyObj {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as AnyObj) : {};
}

/** `message` do ATIF (string OU content parts) → texto único. O bruto fica em extra. */
function atifMessageText(msg: unknown): string {
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg)) {
    return msg
      .map((part) => {
        const p = objOr(part);
        return typeof p.text === 'string' ? p.text : '';
      })
      .filter((t) => t !== '')
      .join('');
  }
  return '';
}

/**
 * Converte a trajetória própria (`AgentTrajectory` @1 ou @2) para ATIF.
 * Pura. Campos fora do canônico viajam em `extra.pb` (sanção do RFC).
 */
export function toAtif(t: AgentTrajectory): AtifTrajectory {
  const steps: AtifStep[] = t.turns.map((turn, i) => {
    const toolCalls: AtifToolCall[] = turn.steps.map((st) => ({
      tool_call_id: st.id,
      function_name: st.tool,
      arguments: st.args ?? {},
      extra: {
        pb: {
          ok: st.ok,
          ...(st.exitCode !== undefined ? { exitCode: st.exitCode } : {}),
          ...(st.durationMs !== undefined ? { durationMs: st.durationMs } : {}),
          ...(st.outputTruncated !== undefined ? { outputTruncated: st.outputTruncated } : {}),
        },
      },
    }));
    const results: AtifObservationResult[] = turn.steps
      .filter((st) => st.output !== undefined)
      .map((st) => ({ source_call_id: st.id, content: st.output as string }));
    return {
      step_id: i + 1,
      source: turn.source ?? 'agent',
      message: turn.text ?? '',
      ...(turn.timestamp !== undefined ? { timestamp: turn.timestamp } : {}),
      ...(turn.thinking !== undefined ? { reasoning_content: turn.thinking } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(results.length > 0 ? { observation: { results } } : {}),
      ...(turn.usage
        ? {
            metrics: {
              prompt_tokens: turn.usage.tokensIn,
              completion_tokens: turn.usage.tokensOut,
              cost_usd: turn.usage.costUsd,
            },
          }
        : {}),
      extra: {
        ...(turn.stopReason !== undefined ? { stop_reason: turn.stopReason } : {}),
        pb: {
          index: turn.index,
          ...(turn.usage ? { usage: turn.usage } : {}),
        },
      },
    };
  });

  return {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: {
      name: t.executor.id,
      version: t.executor.version,
      model_name: t.model.id,
      extra: { pb: { model: t.model } },
    },
    steps,
    final_metrics: {
      model_name: t.model.id,
      total_prompt_tokens: t.usage.tokensIn,
      total_completion_tokens: t.usage.tokensOut,
      total_cached_tokens: t.usage.cacheRead + t.usage.cacheWrite,
      total_cost_usd: t.usage.costUsd,
      total_steps: t.turns.length,
      extra: {
        pb: {
          cacheRead: t.usage.cacheRead,
          cacheWrite: t.usage.cacheWrite,
          tokensReasoning: t.usage.tokensReasoning,
          costSource: t.usage.costSource,
          ...(t.usage.agentDerivedCostUsd !== undefined ? { agentDerivedCostUsd: t.usage.agentDerivedCostUsd } : {}),
        },
      },
    },
    extra: {
      stop_reason: t.stopReason,
      pb: {
        format: t.format,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
        durationMs: t.durationMs,
        parseErrors: t.parseErrors,
        compactions: t.compactions,
      },
    },
  };
}

/**
 * Converte um documento ATIF (RFC 0001) para o formato próprio
 * (`agent-trajectory@2`) e devolve o RELATÓRIO DE PERDA (IMPL-095).
 * Pura e defensiva: entrada ilegível conta em `parseErrors` (a única perda
 * declarada), nunca derruba a conversão.
 */
export function fromAtif(input: unknown): { trajectory: AgentTrajectory; loss: AtifLossReport } {
  const loss: AtifLossReport = { parseErrors: 0, droppedCanonical: [], notes: [] };
  const doc = objOr(input);
  const rawSteps = Array.isArray(doc.steps) ? doc.steps : [];

  const turns: AgentTurn[] = [];
  let sawMessageRaw = false;
  for (const raw of rawSteps) {
    const st = objOr(raw);
    const stepId = typeof st.step_id === 'number' && Number.isFinite(st.step_id) ? st.step_id : undefined;
    const source = st.source === 'system' || st.source === 'user' || st.source === 'agent' ? st.source : undefined;
    if (stepId === undefined || source === undefined) {
      // Entrada ilegível: perda DECLARADA (parseErrors), não canônica.
      loss.parseErrors += 1;
      continue;
    }
    const extra = objOr(st.extra);
    const pb = objOr(extra.pb);

    // message: string OU content parts. O bruto não-string viaja em extra.
    let text: string | undefined;
    if (typeof st.message === 'string') {
      text = st.message;
    } else if (st.message !== undefined) {
      text = atifMessageText(st.message);
      sawMessageRaw = true;
    }
    if (text === '') text = undefined;

    const steps: AgentStep[] = [];
    const calls = Array.isArray(st.tool_calls) ? st.tool_calls : [];
    const obsResults = Array.isArray(objOr(st.observation).results) ? (objOr(st.observation).results as unknown[]) : [];
    const obsByCall = new Map<string, string>();
    for (const r of obsResults) {
      const ro = objOr(r);
      if (typeof ro.source_call_id === 'string' && typeof ro.content === 'string') {
        obsByCall.set(ro.source_call_id, ro.content);
      }
    }
    for (const c of calls) {
      const co = objOr(c);
      const callId = typeof co.tool_call_id === 'string' ? co.tool_call_id : undefined;
      const fn = typeof co.function_name === 'string' ? co.function_name : undefined;
      if (callId === undefined || fn === undefined) {
        loss.parseErrors += 1;
        continue;
      }
      const cpb = objOr(objOr(co.extra).pb);
      const output = obsByCall.get(callId);
      steps.push({
        id: callId,
        tool: fn,
        args: objOr(co.arguments),
        ok: typeof cpb.ok === 'boolean' ? cpb.ok : true,
        ...(output !== undefined ? { output } : {}),
        ...(typeof cpb.outputTruncated === 'boolean' ? { outputTruncated: cpb.outputTruncated } : {}),
        ...(typeof cpb.exitCode === 'number' ? { exitCode: cpb.exitCode } : {}),
        ...(typeof cpb.durationMs === 'number' ? { durationMs: cpb.durationMs } : {}),
      });
    }
    // Observações sem tool call correspondente: entrada útil ainda — vira step
    // de observação pura (tool 'observation'), sem perder o conteúdo.
    for (const [callId, content] of obsByCall) {
      if (!steps.some((s) => s.id === callId)) {
        steps.push({ id: callId, tool: 'observation', args: {}, ok: true, output: content });
      }
    }

    const metrics = objOr(st.metrics);
    const usageFromMetrics =
      typeof metrics.prompt_tokens === 'number' || typeof metrics.completion_tokens === 'number' || typeof metrics.cost_usd === 'number'
        ? {
            tokensIn: typeof metrics.prompt_tokens === 'number' ? metrics.prompt_tokens : 0,
            tokensOut: typeof metrics.completion_tokens === 'number' ? metrics.completion_tokens : 0,
            costUsd: typeof metrics.cost_usd === 'number' ? metrics.cost_usd : 0,
          }
        : undefined;
    const usagePb = objOr(pb.usage);
    const usage =
      typeof usagePb.tokensIn === 'number' && typeof usagePb.tokensOut === 'number' && typeof usagePb.costUsd === 'number'
        ? { tokensIn: usagePb.tokensIn, tokensOut: usagePb.tokensOut, costUsd: usagePb.costUsd }
        : usageFromMetrics;

    const stopReason = typeof extra.stop_reason === 'string' ? extra.stop_reason : undefined;

    turns.push({
      index: typeof pb.index === 'number' ? pb.index : turns.length,
      source,
      ...(text !== undefined ? { text } : {}),
      ...(typeof st.reasoning_content === 'string' ? { thinking: st.reasoning_content } : {}),
      ...(typeof st.timestamp === 'string' ? { timestamp: st.timestamp } : {}),
      steps,
      ...(usage ? { usage } : {}),
      ...(stopReason !== undefined ? { stopReason } : {}),
    });
  }
  if (sawMessageRaw) loss.notes.push('message em content parts foi normalizado para string (o bruto foi restaurado no round-trip via extra)');

  // --- nível trajetória -----------------------------------------------------
  const agent = objOr(doc.agent);
  const agentPb = objOr(objOr(agent.extra).pb);
  const modelPb = objOr(agentPb.model);
  const model: { provider: string; id: string; thinking?: ReasoningLevel } = {
    provider: typeof modelPb.provider === 'string' ? modelPb.provider : 'unknown',
    id: typeof agent.model_name === 'string' ? agent.model_name : typeof modelPb.id === 'string' ? modelPb.id : 'unknown',
    ...(typeof modelPb.thinking === 'string' ? { thinking: modelPb.thinking as ReasoningLevel } : {}),
  };

  const fm = objOr(doc.final_metrics);
  const fmPb = objOr(objOr(fm.extra).pb);
  const usage = {
    tokensIn: typeof fm.total_prompt_tokens === 'number' ? fm.total_prompt_tokens : 0,
    tokensOut: typeof fm.total_completion_tokens === 'number' ? fm.total_completion_tokens : 0,
    tokensReasoning: typeof fmPb.tokensReasoning === 'number' ? fmPb.tokensReasoning : 0,
    // Entrada estrangeira (sem `extra.pb`): o ATIF só tem `total_cached_tokens`
    // agregado — fica em `cacheRead` (o mais próximo) para o round-trip fechar.
    cacheRead: typeof fmPb.cacheRead === 'number' ? fmPb.cacheRead : typeof fm.total_cached_tokens === 'number' ? fm.total_cached_tokens : 0,
    cacheWrite: typeof fmPb.cacheWrite === 'number' ? fmPb.cacheWrite : 0,
    costUsd: typeof fm.total_cost_usd === 'number' ? fm.total_cost_usd : 0,
    costSource: (typeof fmPb.costSource === 'string' ? fmPb.costSource : 'agent-derived') as AgentCostSource,
    ...(typeof fmPb.agentDerivedCostUsd === 'number' ? { agentDerivedCostUsd: fmPb.agentDerivedCostUsd } : {}),
  };

  const extra = objOr(doc.extra);
  const ePb = objOr(extra.pb);
  const stopReason: AgentStopReason =
    typeof extra.stop_reason === 'string' && isStopReason(extra.stop_reason) ? extra.stop_reason : 'completed';
  if (typeof extra.stop_reason === 'string' && !isStopReason(extra.stop_reason)) {
    loss.notes.push(`stopReason desconhecido "${extra.stop_reason}" → 'completed'`);
  }

  const timestamps = turns.map((t) => t.timestamp).filter((t): t is string => typeof t === 'string');
  const startedAt =
    typeof ePb.startedAt === 'string' ? ePb.startedAt : (timestamps[0] ?? new Date(0).toISOString());
  const finishedAt =
    typeof ePb.finishedAt === 'string' ? ePb.finishedAt : (timestamps[timestamps.length - 1] ?? startedAt);
  const durationMs =
    typeof ePb.durationMs === 'number' ? ePb.durationMs : Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt) || 0);

  // Campos ATIF sem casa no formato próprio (não-canônicos): DECLARADOS em notes.
  if (typeof doc.session_id === 'string') loss.notes.push('session_id não tem casa no formato próprio (identificador do documento)');
  if (typeof doc.trajectory_id === 'string') loss.notes.push('trajectory_id não tem casa no formato próprio (identificador do documento)');
  if (typeof fm.llm_call_count === 'number') loss.notes.push('llm_call_count derivável dos steps não tem casa no formato próprio');

  const trajectory: AgentTrajectory = {
    format: 'agent-trajectory@2',
    executor: {
      id: typeof agent.name === 'string' && agent.name !== '' ? agent.name : 'unknown',
      version: typeof agent.version === 'string' ? agent.version : 'unknown',
    },
    model,
    startedAt,
    finishedAt,
    durationMs,
    stopReason,
    turns,
    usage,
    // `parseErrors` é o canal DECLARADO de perda (IMPL-095).
    parseErrors: (typeof ePb.parseErrors === 'number' ? ePb.parseErrors : 0) + loss.parseErrors,
    compactions: Array.isArray(ePb.compactions) ? (ePb.compactions as { at: string; tokensBefore: number }[]) : [],
  };

  return { trajectory, loss };
}

function isStopReason(v: string): v is AgentStopReason {
  return (
    v === 'completed' ||
    v === 'maxTurns' ||
    v === 'maxCost' ||
    v === 'timeout' ||
    v === 'maxOutput' ||
    v === 'error' ||
    v === 'cancelled'
  );
}
