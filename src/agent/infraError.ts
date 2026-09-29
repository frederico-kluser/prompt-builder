// ----------------------------------------------------------------------------
// Erro de INFRAESTRUTURA numa execução de agente → sem veredito (IMPL-036).
//
// O executor marca `AgentRunOutcome.infraError` quando a execução terminou
// porque o PROVEDOR/rede falhou (ex.: `--network none` sem proxy de inferência →
// "Connection error." com as retentativas do pi esgotadas), e não por decisão do
// agente. O `stopReason` vem 'error', mas isso NÃO é o "processo morreu" do §18.3
// (que conta `nao`): a culpa não é do contestant. Regra das CONVENTIONS (§2,
// veredito ausente): "competidor `error` (infra) → sem veredito, nunca imputar
// `nao`" — a repetição sai do placar e das médias (chave ausente = sem
// observação), e o motivo fica na explicação e em `ExecutionRef.infraError`.
//
// EXCEÇÃO (o oráculo MANDA, §17.1): quando o oráculo é CONCLUSIVO sobre o que o
// agente fez — passou 100% (o mundo mudou de forma verificável: o agente fez o
// trabalho e só a última chamada caiu) ou violou `forbiddenPaths` (dano
// verificável, atribuível ao agente) —, a repetição segue a árvore normal como
// execução concluída. É a mesma lógica da exceção de corte do §15.2.
//
// IMPL-094 (R-14a DEC-2/REC-2) — TAXONOMIA transient × defect (padrão Inspect/
// Harbor), decidida pelo TIPO da falha, nunca pelo resultado:
//   • `transient` — 429/5xx do provedor, rede (ECONNRESET/ETIMEDOUT/…), sandbox
//     morto (docker/daemon/container que caiu): a execução é refeita às cegas
//     até `INFRA_RETRIES` (2) vezes; persistindo, a rep sai SEM veredito
//     (`infra_error`, fora de todos os denominadores);
//   • `defect` — a TAREFA/ambiente não serve (setup/clone/fixture falhou,
//     comando ausente, executor que não prepara, testsDir inválido): a célula
//     (etapa) fica inválida para TODOS os contestants — nunca nota de alguém;
//   • `infra` — falha de infraestrutura que repetir não conserta (erro do
//     harness, 401/402/403 do provedor, rebuild de dependências): sem veredito,
//     sem retentativa (repetir um erro determinístico só gastaria).
// A taxa `infra_error / execuções` vai para o record (`infraErrorRate`): acima
// de 5% é alerta; acima de 10% a run é declarada INVÁLIDA (status
// `inconclusive` com o motivo; exit 6 `run.infra_invalid` no `agents run`).
// Nunca retry dependente de resultado: uma tentativa que produziu observação
// (qualquer veredito) NUNCA é refeita — "reexecutar até passar" infla a nota.
//
// ⚠️ Módulo PURO: sem `node:*`, sem `process.env`.
// ----------------------------------------------------------------------------

/** Retentativas CEGAS de uma execução com falha transitória (total = 1 + 2). */
export const INFRA_RETRIES = 2;
/** Acima disto (fração de execuções com infra_error) a run ganha ALERTA. */
export const INFRA_WARN_RATE = 0.05;
/** Acima disto a run é INVÁLIDA (mede a infraestrutura, não os agentes). */
export const INFRA_INVALID_RATE = 0.1;

/** Classe de uma falha que NÃO é do agente (IMPL-094). */
export type AgentFailureClass = 'transient' | 'defect' | 'infra';

/** Fase da tentativa em que a falha aconteceu (decide a classe de uma exceção). */
export type FailurePhase = 'prepare' | 'execute' | 'harness';

export interface AgentFailure {
  class: AgentFailureClass;
  /** O porquê, curto (mensagem do provedor/erro) — vai para a explicação e o record. */
  reason: string;
}

/** O mínimo do outcome do executor que a classificação lê. */
export interface FailureOutcomeView {
  stopReason: string;
  infraError?: string;
  exitCode?: number | null;
}

/** Códigos de erro de rede/recurso do Node/undici que passam sozinhos. */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EAGAIN',
  'EMFILE',
  'ENFILE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const TRANSIENT_MSG =
  /\b(?:429|50[0-4]|52[0-4])\b|too many requests|rate.?limit|overloaded|service unavailable|bad gateway|gateway time-?out|internal server error|socket hang up|fetch failed|connection (?:error|reset|refused|closed)|network (?:error|unreachable)|timed? ?out|\bECONN\w*|\bETIMEDOUT\b|\bEAI_AGAIN\b/i;
/** Sandbox morto: o container/daemon caiu sem decisão do agente. */
const SANDBOX_DEAD_MSG =
  /no such container|container .{0,60}(?:died|exited unexpectedly|was killed|is not running|oom)|oomkilled|cannot connect to the docker daemon|docker daemon .{0,40}(?:not running|unavailable)|error response from daemon/i;
/** Erro do provedor que repetir NÃO conserta (key/crédito/permissão). */
const NON_RETRIABLE_PROVIDER_MSG = /\b(?:401|402|403)\b|unauthori[sz]ed|forbidden|payment required|insufficient (?:credit|balance|funds)|invalid (?:api )?key/i;
/** Comando ausente / sem permissão (defeito do ambiente). */
const MISSING_COMMAND_MSG = /\bENOENT\b|\bEACCES\b|command not found|not found in \$?PATH|no such file or directory/i;

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/** Status HTTP / código de erro de uma exceção (e da sua `cause`, 3 níveis). */
function errFacts(err: unknown): { status?: number; codes: string[]; messages: string[] } {
  const codes: string[] = [];
  const messages: string[] = [];
  let status: number | undefined;
  let cur: unknown = err;
  for (let i = 0; i < 3 && cur !== undefined && cur !== null; i += 1) {
    const o = (typeof cur === 'object' ? cur : {}) as Record<string, unknown>;
    for (const k of ['httpStatus', 'status', 'statusCode']) {
      const v = o[k];
      if (status === undefined && typeof v === 'number' && Number.isFinite(v)) status = v;
    }
    if (typeof o.code === 'string') codes.push(o.code);
    messages.push(errMessage(cur));
    cur = o.cause;
  }
  return { status, codes, messages };
}

/** A exceção é transitória por TIPO (HTTP 429/5xx, rede, sandbox morto)? */
export function isTransientError(err: unknown): boolean {
  const f = errFacts(err);
  if (f.status !== undefined && (f.status === 429 || (f.status >= 500 && f.status < 600))) return true;
  if (f.codes.some((c) => TRANSIENT_CODES.has(c))) return true;
  return f.messages.some((m) => TRANSIENT_MSG.test(m) || SANDBOX_DEAD_MSG.test(m));
}

/**
 * Classifica uma falha que NÃO é decisão do agente (IMPL-094). Pura.
 * - exceção na fase `prepare` (workspace: clone/setup/fixtures) ⇒ `defect`;
 * - exceção na fase `execute` (o executor lançou) ⇒ `transient` por tipo
 *   (HTTP 429/5xx, rede, sandbox morto), `defect` se o comando não existe,
 *   senão `infra`;
 * - exceção na fase `harness` (coleta/oráculo/escrita) ⇒ `infra`;
 * - outcome com `infraError` (o executor diz que o PROVEDOR falhou) ⇒
 *   `transient`, salvo key/crédito/permissão (401/402/403 ⇒ `infra`);
 * - modo container com exit 125 (o próprio `docker run` falhou) ⇒ `transient`
 *   (sandbox morto sem decisão do agente).
 * `null` = não é falha de infraestrutura (a árvore de veredito decide).
 */
export function classifyAgentFailure(input: {
  phase: FailurePhase;
  error?: unknown;
  outcome?: FailureOutcomeView;
  container?: boolean;
}): AgentFailure | null {
  if (input.error !== undefined) {
    const msg = errMessage(input.error).slice(0, 300);
    if (input.phase === 'prepare') return { class: 'defect', reason: msg };
    if (input.phase === 'execute') {
      if (isTransientError(input.error)) return { class: 'transient', reason: msg };
      const f = errFacts(input.error);
      if (f.codes.includes('ENOENT') || f.codes.includes('EACCES') || f.messages.some((m) => MISSING_COMMAND_MSG.test(m))) {
        return { class: 'defect', reason: msg };
      }
      return { class: 'infra', reason: msg };
    }
    return { class: 'infra', reason: msg };
  }
  const o = input.outcome;
  if (!o) return null;
  if (o.infraError) {
    return NON_RETRIABLE_PROVIDER_MSG.test(o.infraError)
      ? { class: 'infra', reason: o.infraError }
      : { class: 'transient', reason: o.infraError };
  }
  if (input.container && o.stopReason === 'error' && o.exitCode === 125) {
    return { class: 'transient', reason: 'sandbox morto: o docker run falhou (exit 125, erro do daemon/runtime)' };
  }
  return null;
}

/** A tentativa deve ser refeita? Só por CLASSE (transitória) e dentro do teto — nunca pelo resultado. */
export function shouldRetryAttempt(failureClass: AgentFailureClass | undefined, attempt: number): boolean {
  return failureClass === 'transient' && attempt <= INFRA_RETRIES;
}

/** Explicação da rep que terminou SEM veredito por falha de infraestrutura/defeito. */
export function failureExplanation(f: AgentFailure, attempts = 1): string {
  if (f.class === 'defect') {
    return `defeito da tarefa/ambiente (${f.reason}) — a etapa fica inválida para TODOS os contestants`;
  }
  const tentativas = attempts > 1 ? ` após ${attempts} tentativas` : '';
  return (
    `erro de infraestrutura${f.class === 'transient' ? ' transitório' : ''}${tentativas} (${f.reason}) — ` +
    'sem veredito, fora do placar (a falha é do provedor/rede/ambiente, não do agente)'
  );
}

// ---------------------------------------------------------------------------
// Contagens por run (infraErrorRate) e o defeito da célula
// ---------------------------------------------------------------------------

/** Contagem de falhas de infraestrutura das execuções de agente de uma run. */
export interface AgentInfraCounts {
  /** Repetições que valem (observações tentadas) — fora canceladas e etapas inválidas. */
  executions: number;
  /** Delas, as que terminaram SEM veredito por infraestrutura (transitória esgotada ou `infra`). */
  infraErrors: number;
  /** Tentativas feitas (inclui as retentativas e as etapas invalidadas). */
  attempts: number;
  /** Retentativas cegas feitas (tentativas descartadas por falha transitória). */
  retries: number;
  /** Etapas invalidadas para TODOS por defeito da tarefa/ambiente (IMPL-094). */
  defectStages: number;
}

/** O mínimo de uma rep que a contagem lê. */
export interface InfraTallyRep {
  path: string;
  verdict: unknown;
  attempts?: number;
  infraClass?: AgentFailureClass;
}

export function emptyInfraCounts(): AgentInfraCounts {
  return { executions: 0, infraErrors: 0, attempts: 0, retries: 0, defectStages: 0 };
}

/**
 * Contagem de UMA etapa. `stageInvalid` = a etapa saiu para todos (defeito da
 * tarefa, oráculo que não roda em lugar nenhum): as reps dela não entram no
 * denominador (já estão fora do placar), mas as TENTATIVAS contam (houve gasto).
 */
export function tallyInfra(
  reps: readonly InfraTallyRep[],
  opts: { stageInvalid?: boolean; defect?: boolean } = {},
): AgentInfraCounts {
  const c = emptyInfraCounts();
  for (const r of reps) {
    const attempts = Math.max(1, r.attempts ?? 1);
    c.attempts += attempts;
    c.retries += attempts - 1;
    if (opts.stageInvalid || r.path === 'cancelled') continue;
    c.executions += 1;
    if (r.verdict === null && (r.infraClass === 'transient' || r.infraClass === 'infra')) c.infraErrors += 1;
  }
  if (opts.defect) c.defectStages += 1;
  return c;
}

export function mergeInfraCounts(a: AgentInfraCounts | undefined, b: AgentInfraCounts): AgentInfraCounts {
  const base = a ?? emptyInfraCounts();
  return {
    executions: base.executions + b.executions,
    infraErrors: base.infraErrors + b.infraErrors,
    attempts: base.attempts + b.attempts,
    retries: base.retries + b.retries,
    defectStages: base.defectStages + b.defectStages,
  };
}

/** Defeito da tarefa/ambiente numa etapa: a 1ª rep `defect` (de qualquer contestant). */
export function stageInfraDefect(reps: readonly (InfraTallyRep & { infraError?: string; explanation?: string })[]): {
  message: string;
} | null {
  const d = reps.find((r) => r.infraClass === 'defect');
  if (!d) return null;
  return { message: (d.infraError ?? d.explanation ?? 'defeito da tarefa/ambiente').slice(0, 300) };
}

/**
 * Campos de infraestrutura do `agentSummary` (IMPL-094) — FONTE ÚNICA para os
 * três resumos (`result` do `agents run`, `run.finished` do NDJSON e o job do
 * MCP): tentativas, retentativas cegas, infra_error, a taxa e as etapas
 * invalidadas por defeito. Vazio em record sem `agentInfra` (legado).
 */
export function infraSummaryFields(rec: { agentInfra?: AgentInfraCounts; infraErrorRate?: number }): {
  attempts?: number;
  retries?: number;
  infraErrors?: number;
  infraErrorRate?: number;
  defectStages?: number;
} {
  return {
    ...(rec.agentInfra
      ? {
          attempts: rec.agentInfra.attempts,
          retries: rec.agentInfra.retries,
          infraErrors: rec.agentInfra.infraErrors,
          defectStages: rec.agentInfra.defectStages,
        }
      : {}),
    ...(rec.infraErrorRate !== undefined ? { infraErrorRate: rec.infraErrorRate } : {}),
  };
}

export interface InfraRateAssessment {
  /** infra_error / execuções (0..1). */
  rate: number;
  warn: boolean;
  invalid: boolean;
  /** Frase PT-BR para o log/motivo (sempre presente quando `warn`). */
  message: string;
}

const pct = (x: number): string => `${(x * 100).toFixed(1).replace(/\.0$/, '')}%`;

/** A taxa da run e os limiares (5% alerta, 10% inválida). `undefined` = sem execução de agente. */
export function assessInfraErrorRate(counts: AgentInfraCounts | undefined): InfraRateAssessment | undefined {
  if (!counts || counts.executions <= 0) return undefined;
  const rate = counts.infraErrors / counts.executions;
  const invalid = rate > INFRA_INVALID_RATE;
  const warn = rate > INFRA_WARN_RATE;
  const base =
    `infra_error em ${counts.infraErrors} de ${counts.executions} execuções de agente = ${pct(rate)}` +
    (counts.retries > 0 ? ` (${counts.retries} retentativa(s) cega(s))` : '');
  const message = invalid
    ? `${base} > ${pct(INFRA_INVALID_RATE)} — run INVÁLIDA: mede a infraestrutura, não os agentes`
    : warn
      ? `${base} > ${pct(INFRA_WARN_RATE)} (alerta; inválida acima de ${pct(INFRA_INVALID_RATE)})`
      : base;
  return { rate: Number(rate.toFixed(4)), warn, invalid, message };
}

/** O mínimo do resultado do oráculo que a decisão lê. */
export interface InfraOracleView {
  score: number;
  violations: string[];
  /** IMPL-039: P2P não aferido tira a conclusividade da nota cheia. */
  p2p?: { unverified?: number };
}

export type InfraDecision =
  /** Sem erro de infra: a árvore de veredito decide com o `stopReason` real. */
  | { kind: 'none' }
  /** Erro de infra sem oráculo conclusivo: repetição SEM veredito (fora do placar). */
  | { kind: 'no-verdict'; explanation: string }
  /**
   * Erro de infra, mas o oráculo é conclusivo: a árvore decide como se a
   * execução tivesse concluído (`stopReason` efetivo `'completed'`).
   */
  | { kind: 'oracle-decides'; explanation: string };

/**
 * O oráculo diz algo DEFINITIVO sobre o que o agente fez (100% ou violação)?
 * Nota cheia com P2P não aferido (IMPL-039) NÃO é 100%: a regressão ficou em aberto.
 */
export function isOracleConclusive(oracle?: InfraOracleView): boolean {
  if (oracle === undefined) return false;
  if (oracle.violations.length > 0) return true;
  return oracle.score === 1 && (oracle.p2p?.unverified ?? 0) === 0;
}

/** Decide o destino de uma repetição a partir do marcador de infra do executor. */
export function decideInfraError(infraError: string | undefined, oracle?: InfraOracleView): InfraDecision {
  if (!infraError) return { kind: 'none' };
  if (isOracleConclusive(oracle)) {
    return {
      kind: 'oracle-decides',
      explanation: `erro de infraestrutura no fim da execução (${infraError}), mas o oráculo é conclusivo — ele decide`,
    };
  }
  return {
    kind: 'no-verdict',
    explanation:
      `erro de infraestrutura na execução (${infraError}) — sem veredito, fora do placar ` +
      '(a falha é do provedor/rede, não do agente)',
  };
}
