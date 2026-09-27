// Contrato de saida do CLI.
//
// Regra 1 — STDOUT E PAYLOAD, STDERR E NARRACAO. Progresso, avisos e barras vao
// para stderr, sempre. Assim `prompt-builder models export --json > m.json`
// esta sempre correto, sem flag extra.
//
// Regra 2 — `--json` imprime UM objeto no stdout, no fim.
//
// Regra 3 — `--output-format ndjson` imprime um objeto por linha, com flush por
// linha, terminando SEMPRE em `result`.
//
// Regra 4 — ERRO TEM UM ENVELOPE SO (IMPL-028, R-12:REC-1). Todo desfecho
// negativo e um `CliError` lancado e renderizado num UNICO ponto (`Output.fail`,
// chamado pelo catch do `main`): `{ok:false, command, error:{code, kind,
// message, hint, details}}` — a MESMA arvore em JSON e em NDJSON (onde e a
// linha `{type:'result', ok:false, …}`). Em texto vira "Erro:"/"Dica:" no
// stderr. `result()` so aceita `ok: true`: nao existe mais ok:false sem `error`.
// `ok:true` com exit != 0 so existe para resultado PARCIAL (7 orcamento, 130
// interrompido com o parcial salvo) — ai o `data` traz `stoppedReason`.

import type { CostEntry, CostRole } from '../types.js';
import { gatewayErrorKind, type GatewayErrorKind } from '../openrouter.js';
import { isBudgetSignal, isControlSignal } from '../budget.js';

export type OutputFormat = 'text' | 'json' | 'ndjson';

/** Codigos de saida. Importam mais que o normal: o consumidor e um agente. */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  /** Uso invalido — inclui a falta de `--budget` fora de TTY. */
  USAGE: 2,
  CONFIG: 3,
  AUTH: 4,
  NO_CREDIT: 5,
  /**
   * Run INCONCLUSIVA (IMPL-004): terminou, mas vereditos perdidos/degradados
   * > 10% em algum papel ou n efetivo < 5 cenarios julgados por contestant.
   * Ha resultado, so que ele nao sustenta conclusao — nao promova com base nele.
   */
  INCONCLUSIVE: 6,
  /** Resultado PARCIAL por orcamento esgotado — nao e erro. */
  BUDGET: 7,
  NETWORK: 8,
  /** `runs wait --timeout` esgotou antes de a run chegar a um estado terminal. */
  WAIT_TIMEOUT: 9,
  /**
   * Um PORTAO de qualidade recusou a promocao (IMPL-027): ex. `sessions winner
   * --apply` com holdout regredido e sem `--override`. Nao e erro de uso nem
   * run inconclusiva — e evidencia CONTRARIA; nada foi gravado.
   */
  GATE_BLOCKED: 10,
  SIGINT: 130,
} as const;

/**
 * Codigo de saida para uma falha CLASSIFICADA do gateway (IMPL-010). So `auth`
 * (HTTP 401) vira `4`: um 403 de moderacao/guardrail e BLOQUEIO — sair com
 * "auth" mandaria o agente trocar uma key que funciona. `undefined` = nao e
 * falha do gateway (o chamador decide).
 */
/** Exit por tipo de falha do gateway (mapa, nao `return EXIT.X`: o envelope e o unico renderizador). */
const GATEWAY_EXIT: Readonly<Record<GatewayErrorKind, number>> = {
  auth: EXIT.AUTH,
  no_credit: EXIT.NO_CREDIT,
  rate_limit: EXIT.NETWORK,
  // `http` depende do status (5xx = rede); o resto e erro generico.
  http: EXIT.ERROR,
  blocked: EXIT.ERROR,
};

export function exitCodeForGatewayError(err: unknown): number | undefined {
  const kind = gatewayErrorKind(err);
  if (!kind) return undefined;
  const status = (err as { httpStatus?: number }).httpStatus ?? 0;
  return kind === 'http' && status >= 500 ? GATEWAY_EXIT.rate_limit : GATEWAY_EXIT[kind];
}

/**
 * Familia do erro — o que um agente usa para decidir o proximo passo sem ler a
 * mensagem: `usage` (corrija a chamada), `config` (corrija o arquivo), `auth`
 * (key), `credit` (saldo), `network` (tente de novo), `control` (parou por
 * orcamento/interrupcao), `inconclusive`, `timeout` (a espera acabou, nao a
 * run), `gate` (um portao de qualidade recusou promover — nao sobreponha sem
 * decisao humana) e `internal` (bug ou falha inesperada).
 */
export type ErrorKind =
  | 'usage'
  | 'config'
  | 'auth'
  | 'credit'
  | 'network'
  | 'control'
  | 'inconclusive'
  | 'timeout'
  | 'gate'
  | 'internal';

/** Exit code -> kind. Cobre toda a tabela EXIT (menos OK); fora dela = `internal`. */
export const EXIT_KIND: Readonly<Record<number, ErrorKind>> = {
  [EXIT.ERROR]: 'internal',
  [EXIT.USAGE]: 'usage',
  [EXIT.CONFIG]: 'config',
  [EXIT.AUTH]: 'auth',
  [EXIT.NO_CREDIT]: 'credit',
  [EXIT.INCONCLUSIVE]: 'inconclusive',
  [EXIT.BUDGET]: 'control',
  [EXIT.NETWORK]: 'network',
  [EXIT.WAIT_TIMEOUT]: 'timeout',
  [EXIT.GATE_BLOCKED]: 'gate',
  [EXIT.SIGINT]: 'control',
};

export function kindForExit(exit: number): ErrorKind {
  return EXIT_KIND[exit] ?? 'internal';
}

/** `error.code` quando quem lancou nao deu um mais especifico. */
const DEFAULT_CODE: Record<ErrorKind, string> = {
  usage: 'usage.invalid',
  config: 'config.invalid',
  auth: 'auth.failed',
  credit: 'credit.insufficient',
  network: 'network.failed',
  control: 'control.stopped',
  inconclusive: 'run.inconclusive',
  timeout: 'wait.timeout',
  gate: 'gate.blocked',
  internal: 'internal.error',
};

/**
 * Dica padrao por kind: sempre um PROXIMO PASSO executavel (comando exato).
 * Erros especificos (flag desconhecida, key ausente, …) trazem a propria.
 */
export const DEFAULT_HINT: Readonly<Record<ErrorKind, string>> = {
  usage: 'Veja comandos e flags em `prompt-builder --help` (e o fluxo em `prompt-builder docs quickstart`).',
  config:
    'Valide o arquivo com `prompt-builder config validate <arquivo.json>`; ' +
    '`prompt-builder config example -o arena.json` gera um exemplo válido.',
  auth:
    'Grave a key com `prompt-builder key set --stdin` (lida da entrada padrão) ou exporte ' +
    'OPENROUTER_API_KEY; confira com `prompt-builder key check`.',
  credit:
    'Adicione créditos na conta do OpenRouter ou reduza a run (menos cenários, iterações ou juízes); ' +
    '`--dry-run` estima sem gastar.',
  network: 'Confira a conexão com openrouter.ai e tente de novo; `prompt-builder doctor` diagnostica key e catálogo.',
  control:
    'Parou por orçamento ou interrupção; o que já foi gravado aparece em ' +
    '`prompt-builder runs list` / `prompt-builder sessions list`.',
  inconclusive: 'O resultado não sustenta conclusão; leia o record com `prompt-builder runs show <id> --json`.',
  timeout: 'A espera acabou, não a run: ela segue rodando — consulte o estado de novo mais tarde.',
  gate:
    'Um portão de qualidade recusou a promoção e nada foi gravado: leia error.details (o que ' +
    'bloqueou e a evidência). Só sobreponha por decisão humana, com o override do comando e o motivo.',
  internal: 'Rode de novo com --verbose; se persistir, abra uma issue com a saída do stderr.',
};

export interface CliErrorOptions {
  /** Identificador ESTAVEL legivel por maquina (`usage.unknown_flag`, `run.locked`, …). */
  code?: string;
  /** O que fazer a seguir — de preferencia um comando exato. */
  hint?: string;
}

export class CliError extends Error {
  /** `error.code` do envelope: string estavel. (`code`, numerico, e o exit code.) */
  readonly errorCode: string;
  readonly hint: string | undefined;

  constructor(
    message: string,
    /** Exit code (tabela EXIT). Mantem o nome historico por compatibilidade. */
    readonly code: number = EXIT.ERROR,
    readonly details?: unknown,
    opts: CliErrorOptions = {},
  ) {
    super(message);
    this.name = 'CliError';
    this.errorCode = opts.code ?? DEFAULT_CODE[kindForExit(code)];
    this.hint = opts.hint;
  }

  get kind(): ErrorKind {
    return kindForExit(this.code);
  }
}

/**
 * Reconhece um CliError por FORMA, nao por `instanceof` — mesmo motivo do
 * `isControlSignal`: duas instancias do modulo (tsx × dist) dariam `false` em
 * silencio e o erro viraria `internal`.
 */
export function isCliError(e: unknown): e is CliError {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as { name?: unknown; code?: unknown; errorCode?: unknown };
  return o.name === 'CliError' && typeof o.code === 'number' && typeof o.errorCode === 'string';
}

/** Erros de sistema de arquivo que significam "caminho errado/sem permissao". */
const FS_ERRNO = new Set(['ENOENT', 'EACCES', 'EISDIR', 'ENOTDIR', 'EPERM', 'ENAMETOOLONG']);
/** Erros de socket/DNS/undici que significam "rede", nao bug. */
const NET_ERRNO = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Normaliza QUALQUER coisa lancada num CliError — o envelope nunca recebe um
 * erro cru. Sinais de controle mantem o exit do desfecho (7/130); erro de
 * arquivo vira uso (2); erro de socket vira rede (8); o resto e `internal` (1).
 */
export function toCliError(err: unknown): CliError {
  if (isCliError(err)) return err;
  if (isControlSignal(err)) {
    // Teto DIÁRIO da máquina (IMPL-031, `DailyCapExceeded` em spendLedger.ts —
    // reconhecido por forma para não criar import circular): o mesmo exit 7,
    // mas o code diz que o limite é o da máquina, não o `--budget` da run.
    const diario = err as { scope?: unknown; reason?: unknown };
    if (isBudgetSignal(err) && diario.scope === 'daily') {
      return new CliError(
        err.message,
        EXIT.BUDGET,
        { spentTodayUsd: err.spentUsd, capUsd: err.budgetUsd, role: err.role ?? null, reason: diario.reason ?? 'cap' },
        {
          code: 'control.daily_cap_reached',
          hint:
            'O teto diário vale para TODOS os processos desta máquina. Espere o reset (00:00 UTC) ou, por ' +
            'decisão humana, `prompt-builder limits set --daily <usd>`; `prompt-builder limits show` mostra quem gastou.',
        },
      );
    }
    return isBudgetSignal(err)
      ? new CliError(
          err.message,
          EXIT.BUDGET,
          { spentUsd: err.spentUsd, budgetUsd: err.budgetUsd, role: err.role ?? null },
          { code: 'control.budget_exceeded' },
        )
      : new CliError(err.message, EXIT.SIGINT, undefined, { code: 'control.cancelled' });
  }
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    message?: unknown;
    name?: unknown;
    code?: unknown;
    path?: unknown;
    syscall?: unknown;
    cause?: unknown;
  };
  const message = typeof e.message === 'string' && e.message ? e.message : String(err);
  const name = typeof e.name === 'string' ? e.name : null;

  // Falha CLASSIFICADA do gateway (IMPL-010): 401 => auth (4), sem crédito =>
  // 5, 429/5xx => rede (8), 403 de moderação => 1 (bloqueio, NUNCA auth).
  const gwKind = gatewayErrorKind(err);
  if (gwKind) {
    const exit = exitCodeForGatewayError(err) ?? EXIT.ERROR;
    const gwCode: Record<typeof gwKind, string> = {
      auth: 'auth.failed',
      no_credit: 'credit.insufficient',
      rate_limit: 'network.rate_limited',
      http: exit === EXIT.NETWORK ? 'network.upstream_error' : 'gateway.http_error',
      blocked: 'gateway.blocked',
    };
    const httpStatus = (err as { httpStatus?: unknown }).httpStatus;
    return new CliError(
      message,
      exit,
      { gatewayError: gwKind, httpStatus: typeof httpStatus === 'number' ? httpStatus : null },
      {
        code: gwCode[gwKind],
        ...(gwKind === 'blocked'
          ? { hint: 'Bloqueio de moderação/guardrail do provedor — a key está boa; ajuste o conteúdo ou troque o modelo/provedor.' }
          : {}),
      },
    );
  }

  // Abort cru de fetch/AbortSignal (Ctrl-C que escapou sem virar RunCancelled):
  // e interrupcao, nao bug.
  if (name === 'AbortError') {
    return new CliError(message, EXIT.SIGINT, undefined, { code: 'control.cancelled' });
  }

  if (typeof e.code === 'string' && FS_ERRNO.has(e.code) && typeof e.path === 'string') {
    return new CliError(
      `Não consegui acessar "${e.path}" (${e.code}).`,
      EXIT.USAGE,
      { path: e.path, syscall: typeof e.syscall === 'string' ? e.syscall : null, errno: e.code },
      {
        code: 'usage.file_unreadable',
        hint: 'Confira o caminho (relativo ao diretório atual) e as permissões do arquivo.',
      },
    );
  }

  const causeCode =
    typeof e.cause === 'object' && e.cause !== null ? (e.cause as { code?: unknown }).code : undefined;
  const netCode = [e.code, causeCode].find((c): c is string => typeof c === 'string' && NET_ERRNO.has(c));
  if (netCode || name === 'TimeoutError' || (name === 'TypeError' && message === 'fetch failed')) {
    return new CliError(
      `Falha de rede: ${message}`,
      EXIT.NETWORK,
      { cause: netCode ?? name },
      { code: name === 'TimeoutError' ? 'network.timeout' : 'network.unreachable' },
    );
  }

  return new CliError(message, EXIT.ERROR, { name }, { code: 'internal.unexpected' });
}

/**
 * O objeto `error` do envelope. Campos SEMPRE presentes (null quando vazios) —
 * exatamente os cinco do contrato v1 (R-12:DEC-1). O exit code NAO entra: ele
 * ja e o codigo de saida do processo, e `code` (string) desambigua o que o
 * `kind` agrupa (ex.: `control.budget_exceeded` × `control.cancelled`).
 */
export interface CliErrorObject {
  code: string;
  kind: ErrorKind;
  message: string;
  hint: string | null;
  details: unknown;
}

export interface ErrorEnvelope {
  ok: false;
  command: string;
  error: CliErrorObject;
}

/** Ordem canonica dos campos de `error` (o teste de contrato compara contra ela). */
export const ERROR_FIELDS = ['code', 'kind', 'message', 'hint', 'details'] as const;

/** `details` que nao serializa (ciclo, BigInt) nao pode derrubar o proprio erro. */
function serializableDetails(details: unknown): unknown {
  if (details === undefined || details === null) return null;
  try {
    JSON.stringify(details);
    return details;
  } catch {
    return { unserializable: true, preview: String(details).slice(0, 200) };
  }
}

export function errorObject(err: CliError): CliErrorObject {
  const kind = kindForExit(err.code);
  return {
    code: err.errorCode,
    kind,
    message: err.message,
    hint: err.hint ?? DEFAULT_HINT[kind],
    details: serializableDetails(err.details),
  };
}

export function errorEnvelope(command: string, err: unknown): ErrorEnvelope {
  return { ok: false, command, error: errorObject(toCliError(err)) };
}

let seq = 0;
/**
 * Ja saiu a saida TERMINAL no stdout (o objeto `--json` ou a linha `result`)?
 * Compartilhado entre instancias: o `main` cria um Output antes do dispatch e o
 * comando cria o seu. Depois do terminal nada mais vai para o stdout — o NDJSON
 * termina em `result` e o `--json` continua sendo UM objeto.
 */
let terminal = false;

/** Zera o estado de modulo (seq/terminal). Para testes que rodam o CLI no mesmo processo. */
export function resetOutputState(): void {
  seq = 0;
  terminal = false;
}

export interface OutputOptions {
  format: OutputFormat;
  quiet?: boolean;
  color?: boolean;
}

export class Output {
  constructor(private readonly opts: OutputOptions) {}

  get format(): OutputFormat {
    return this.opts.format;
  }

  get isNdjson(): boolean {
    return this.opts.format === 'ndjson';
  }

  get isText(): boolean {
    return this.opts.format === 'text';
  }

  /** Narracao (stderr). Silenciada por `--quiet`. */
  info(msg: string): void {
    if (!this.opts.quiet) process.stderr.write(`${msg}\n`);
  }

  warn(msg: string): void {
    process.stderr.write(`! ${msg}\n`);
  }

  /** Texto de payload (stdout). Ignorado fora do formato `text`. */
  line(msg = ''): void {
    if (this.opts.format === 'text') process.stdout.write(`${msg}\n`);
  }

  /** Escreve direto no stdout, sem formatacao (ex.: `--prompt-only`). */
  raw(text: string): void {
    process.stdout.write(text);
  }

  private ndjsonLine(type: string, payload: Record<string, unknown>): void {
    seq += 1;
    process.stdout.write(
      `${JSON.stringify({ type, ts: new Date().toISOString(), seq, ...payload })}\n`,
    );
  }

  /** Uma linha NDJSON. Flush por linha — um agente que faz tail precisa disso. */
  event(type: string, payload: Record<string, unknown> = {}): void {
    if (!this.isNdjson || terminal) return;
    this.ndjsonLine(type, payload);
  }

  /**
   * Resultado final de SUCESSO. Em json/ndjson e a ultima saida; em text nao
   * imprime nada. So aceita `ok: true`: desfecho negativo e `throw new
   * CliError(…)`, que o `main` transforma no envelope unico (IMPL-028).
   */
  result(ok: true, command: string, data: Record<string, unknown>): void {
    if (this.opts.format === 'text') return;
    if (terminal) {
      process.stderr.write(`! resultado de "${command}" descartado: a saída final já foi emitida.\n`);
      return;
    }
    if (this.opts.format === 'json') {
      process.stdout.write(`${JSON.stringify({ ok, command, data }, null, 2)}\n`);
    } else {
      this.ndjsonLine('result', { ok, command, ...data });
    }
    terminal = true;
  }

  /**
   * O UNICO ponto que renderiza erro. Aceita qualquer coisa lancada (normaliza
   * por `toCliError`) e devolve o CliError, cujo `code` e o exit code.
   */
  fail(command: string, err: unknown): CliError {
    const cliErr = toCliError(err);
    const envelope = errorEnvelope(command, cliErr);
    if (this.opts.format === 'text' || terminal) {
      process.stderr.write(`\nErro: ${envelope.error.message}\n`);
      if (envelope.error.hint) process.stderr.write(`Dica: ${envelope.error.hint}\n`);
      return cliErr;
    }
    if (this.opts.format === 'json') {
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      this.ndjsonLine('result', { ...envelope });
    }
    terminal = true;
    return cliErr;
  }
}

/**
 * Saida IMEDIATA (2º Ctrl-C, excecao sem dono): o envelope sai primeiro e o
 * processo termina com o exit code dele. Em POSIX o stdout num pipe e
 * assincrono — sair so depois do flush (com teto curto), senao o `result`
 * final se perde e o NDJSON fica sem terminar.
 */
export function failAndExit(out: Output, command: string, err: unknown): void {
  const cliErr = out.fail(command, err);
  process.exitCode = cliErr.code;
  process.stdout.write('', () => process.exit(cliErr.code));
  setTimeout(() => process.exit(cliErr.code), 250).unref();
}

/** Formata USD com casas suficientes para nao virar 0,00 em runs baratas. */
export function fmtUsd(v: number): string {
  if (v === 0) return '$0';
  if (Math.abs(v) < 0.0001) return '<$0.0001';
  return `$${v.toFixed(4)}`;
}

export function fmtPerMTok(usdPerToken: number): string {
  const perM = usdPerToken * 1_000_000;
  if (perM === 0) return '$0';
  if (perM < 0.01) return `$${perM.toFixed(4)}`;
  return `$${perM.toFixed(2)}`;
}

const ROLE_LABEL_PT: Record<CostRole, string> = {
  competitor: 'competidor',
  judge: 'juiz',
  duel: 'duelo',
  gabarito: 'gabarito',
  datagen: 'datagen',
  rewriter: 'reescritor',
  /** Gasto de LLM feito DENTRO de uma execução de agente. */
  agent: 'agente de execução',
};

/** Bloco de gasto por papel, ordenado do mais caro para o mais barato. */
export function renderSpend(
  byRole: Record<CostRole, CostEntry> | undefined,
  total: number,
  budgetUsd?: number,
  accuracy?: { exact: number; estimated: number; unknown: number },
): string[] {
  const linhas: string[] = [];
  const pct = budgetUsd ? ` (${Math.round((total / budgetUsd) * 100)}%)` : '';
  linhas.push(
    `Gasto      ${fmtUsd(total)}${budgetUsd ? ` de ${fmtUsd(budgetUsd)}${pct}` : ' (sem limite)'}`,
  );
  if (byRole) {
    const linhasPapel = (Object.entries(byRole) as [CostRole, CostEntry][])
      .filter(([, e]) => e.calls > 0)
      .sort((a, b) => b[1].usd - a[1].usd)
      .map(([role, e]) => `${ROLE_LABEL_PT[role].padEnd(11)} ${fmtUsd(e.usd).padStart(9)}  ${e.calls} chamadas`);
    linhasPapel.forEach((l, i) => linhas.push(`${i === 0 ? 'Por papel  ' : '           '}${l}`));
  }
  if (accuracy) {
    const partes = [`${accuracy.exact} exatas`];
    if (accuracy.estimated) partes.push(`${accuracy.estimated} estimadas`);
    if (accuracy.unknown) partes.push(`${accuracy.unknown} SEM PREÇO`);
    linhas.push(`Precisão   ${partes.join(' · ')}`);
  }
  return linhas;
}
