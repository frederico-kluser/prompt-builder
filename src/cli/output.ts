// Contrato de saida do CLI.
//
// Regra 1 — STDOUT E PAYLOAD, STDERR E NARRACAO. Progresso, avisos e barras vao
// para stderr, sempre. Assim `prompt-builder models export --json > m.json`
// esta sempre correto, sem flag extra.
//
// Regra 2 — `--json` imprime UM objeto no stdout, no fim.
//
// Regra 3 — `--output-format ndjson` imprime um objeto por linha, com flush por
// linha, abrindo em `start` e terminando SEMPRE em `result`.

import type { CostEntry, CostLedgerSummary, CostRole } from '../types.js';
import { gatewayErrorKind } from '../openrouter.js';

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
  /** Resultado PARCIAL por orcamento esgotado — nao e erro. */
  BUDGET: 7,
  NETWORK: 8,
  SIGINT: 130,
} as const;

/**
 * Codigo de saida para uma falha CLASSIFICADA do gateway (IMPL-010). So `auth`
 * (HTTP 401) vira `4`: um 403 de moderacao/guardrail e BLOQUEIO — sair com
 * "auth" mandaria o agente trocar uma key que funciona. `undefined` = nao e
 * falha do gateway (o chamador decide).
 */
export function exitCodeForGatewayError(err: unknown): number | undefined {
  const kind = gatewayErrorKind(err);
  if (!kind) return undefined;
  switch (kind) {
    case 'auth':
      return EXIT.AUTH;
    case 'no_credit':
      return EXIT.NO_CREDIT;
    case 'rate_limit':
      return EXIT.NETWORK;
    case 'http': {
      const status = (err as { httpStatus?: number }).httpStatus ?? 0;
      return status >= 500 ? EXIT.NETWORK : EXIT.ERROR;
    }
    case 'blocked':
      return EXIT.ERROR;
  }
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number = EXIT.ERROR,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

let seq = 0;

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

  /** Uma linha NDJSON. Flush por linha — um agente que faz tail precisa disso. */
  event(type: string, payload: Record<string, unknown> = {}): void {
    if (!this.isNdjson) return;
    seq += 1;
    process.stdout.write(
      `${JSON.stringify({ type, ts: new Date().toISOString(), seq, ...payload })}\n`,
    );
  }

  /** Resultado final. Em json/ndjson e a ultima linha; em text nao imprime nada. */
  result(ok: boolean, command: string, data: Record<string, unknown>): void {
    if (this.opts.format === 'json') {
      process.stdout.write(`${JSON.stringify({ ok, command, data }, null, 2)}\n`);
    } else if (this.opts.format === 'ndjson') {
      this.event('result', { ok, command, ...data });
    }
  }

  fail(command: string, err: CliError): void {
    if (this.opts.format === 'json') {
      process.stdout.write(
        `${JSON.stringify(
          { ok: false, command, error: { code: err.code, message: err.message, details: err.details } },
          null,
          2,
        )}\n`,
      );
    } else if (this.opts.format === 'ndjson') {
      this.event('result', { ok: false, command, error: err.message, code: err.code });
    } else {
      process.stderr.write(`\nErro: ${err.message}\n`);
    }
  }
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

/**
 * Bloco de gasto por papel, ordenado do mais caro para o mais barato.
 * `ledger` (IMPL-017): sem ele a narracao mostrava so `totalCostUsd`, que
 * EXCLUI o pendente — uma run cancelada com streams cortados aparecia mais
 * barata do que o comprometido, sem aviso nenhum.
 */
export function renderSpend(
  byRole: Record<CostRole, CostEntry> | undefined,
  total: number,
  budgetUsd?: number,
  accuracy?: { exact: number; estimated: number; unknown: number },
  ledger?: CostLedgerSummary,
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
  const pendentes = ledger?.pendingCalls ?? 0;
  if (ledger && pendentes > 0) {
    // Fora do "Gasto" ate conciliar, mas provavelmente cobrado: o humano
    // precisa ver o teto do que pode ter saido (gasto + pendente).
    linhas.push(
      `Pendente   ${fmtUsd(ledger.pendingUsd)}  ${pendentes} chamada(s) sem custo medido ` +
        `(abort/timeout/sem usage) — o gasto real pode chegar a ${fmtUsd(total + ledger.pendingUsd)}`,
    );
  }
  if (ledger && ledger.conservativeCalls > 0) {
    linhas.push(
      `Conservador ${fmtUsd(ledger.conservativeUsd)} de ${ledger.conservativeCalls} chamada(s) sem id ` +
        `lançadas pela reserva inteira (limite superior, já no gasto)`,
    );
  }
  if (accuracy) {
    const partes = [`${accuracy.exact} exatas`];
    if (accuracy.estimated) partes.push(`${accuracy.estimated} estimadas`);
    if (accuracy.unknown) partes.push(`${accuracy.unknown} SEM PREÇO`);
    // Pendente nao passa pelo `accuracy` (nao ha custo lancado): sem isto
    // sumia da contagem de chamadas sem preco.
    if (pendentes > 0) partes.push(`${pendentes} PENDENTES`);
    linhas.push(`Precisão   ${partes.join(' · ')}`);
  }
  return linhas;
}
