// `limits show | set --daily <usd|none>` — o teto diário da máquina e quem
// gastou hoje (IMPL-031, R-12:REC-6). Só disco: sem key, sem rede.

import { buildContext, parse } from '../context.js';
import { CliError, EXIT, fmtUsd } from '../output.js';
import { listRunLocks } from '../runLock.js';
import {
  DAILY_CAP_ENV,
  DEFAULT_DAILY_CAP_USD,
  parseCapValue,
  readDailySnapshot,
  resolveDailyCap,
  writeDailyCap,
} from '../spendLedger.js';

const SUBS = ['show', 'set'] as const;

export async function cmdLimits(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'show';
  const parsed = parse(sub === argv[0] ? argv.slice(1) : argv, { daily: { type: 'string' } });
  const ctx = buildContext(parsed);
  const { out, dataDir } = ctx;

  if (sub === 'set') {
    const raw = parsed.values.daily;
    const v = parseCapValue(raw);
    if (typeof raw !== 'string' || v === undefined) {
      throw new CliError('Uso: prompt-builder limits set --daily <usd|none>', EXIT.USAGE, { flag: '--daily', value: raw ?? null }, {
        code: 'usage.invalid_daily_cap',
        hint: `Ex.: \`prompt-builder limits set --daily 20\` (US$ 20 por dia UTC, todos os processos) ou \`--daily none\`.`,
      });
    }
    const file = writeDailyCap(dataDir, v);
    const efetivo = resolveDailyCap(dataDir);
    if (efetivo.source === 'env') {
      out.warn(`${DAILY_CAP_ENV} está definida e vence o arquivo: o teto efetivo continua ${efetivo.capUsd === null ? 'desligado' : fmtUsd(efetivo.capUsd)}.`);
    }
    out.info(`teto diário ${v === null ? 'DESLIGADO' : fmtUsd(v)} gravado em ${file}`);
    out.result(true, 'limits.set', { dailyCapUsd: v, file, effective: efetivo });
    return EXIT.OK;
  }

  if (sub !== 'show') {
    throw new CliError(`Subcomando desconhecido: limits ${sub}.`, EXIT.USAGE, { subcommand: sub, accepted: SUBS }, {
      code: 'usage.unknown_subcommand',
      hint: 'Use `prompt-builder limits show` ou `prompt-builder limits set --daily <usd|none>`.',
    });
  }

  const cap = resolveDailyCap(dataDir);
  const dia = readDailySnapshot(dataDir, cap);
  const locks = listRunLocks(dataDir).filter((l) => !l.stale);
  if (out.isText) {
    out.line(
      `teto diário   ${cap.capUsd === null ? 'desligado' : fmtUsd(cap.capUsd)} (${cap.source}` +
        `${cap.source === 'default' ? `: US$ ${DEFAULT_DAILY_CAP_USD}` : ''})`,
    );
    out.line(`hoje (UTC)    ${dia.day} · gasto ${fmtUsd(dia.spentUsd)} · em voo ${fmtUsd(dia.pendingUsd)}`);
    if (dia.presumedUsd > 0) out.line(`presumido     ${fmtUsd(dia.presumedUsd)} (processos que morreram com chamadas em voo)`);
    if (dia.remainingUsd !== null) out.line(`resta         ${fmtUsd(dia.remainingUsd)} até ${dia.resetsAt}`);
    for (const e of dia.entries) {
      out.line(
        `  ${e.alive ? 'vivo ' : 'fim  '} pid ${String(e.pid).padEnd(7)} ${fmtUsd(e.spentUsd + e.presumedUsd).padStart(10)}  ` +
          `${e.calls} chamadas  ${e.label}`,
      );
    }
    if (locks.length) {
      out.line();
      out.line('runs ativas (lock por config):');
      for (const l of locks) {
        const h = l.holder;
        out.line(`  pid ${h?.pid ?? '?'} ${h?.command ?? '?'} ${h?.runId ?? h?.sessionId ?? ''}`);
      }
    }
  }
  out.result(true, 'limits.show', {
    dailyCap: cap,
    today: dia,
    activeLocks: locks.map((l) => ({
      file: l.file,
      pid: l.holder?.pid ?? null,
      host: l.holder?.host ?? null,
      command: l.holder?.command ?? null,
      runId: l.holder?.runId ?? null,
      sessionId: l.holder?.sessionId ?? null,
      startedAt: l.holder?.startedAt ?? null,
      heartbeatAgeMs: Math.round(l.heartbeatAgeMs),
    })),
  });
  return EXIT.OK;
}
