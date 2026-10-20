// `local [list] [--check]` — os modelos LOCAIS configurados (PB_LOCAL_MODELS / PB_LOCAL_CHAT, ver
// src/localModels.ts) e, com `--check`, se cada endpoint responde. Sem key e sem chamada paga.

import { buildContext, parse } from '../context.js';
import { CliError, EXIT } from '../output.js';
import { checkLocalModel, parseLocalModelsEnv, resolveLocalEndpoint } from '../../localModels.js';

const SUBS = ['list'] as const;

export async function cmdLocal(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'list';
  const parsed = parse(sub === argv[0] ? argv.slice(1) : argv, { check: { type: 'boolean' } });
  const ctx = buildContext(parsed);
  const { out } = ctx;
  if (sub !== 'list') {
    throw new CliError(`Subcomando desconhecido: local ${sub}.`, EXIT.USAGE, { subcommand: sub, accepted: SUBS }, {
      code: 'usage.unknown_subcommand',
      hint: 'Use `prompt-builder local list [--check]`.',
    });
  }
  const reg = parseLocalModelsEnv(process.env);
  const rows = reg.models.map((m) => {
    let url: string | null = null;
    try {
      url = resolveLocalEndpoint(m).url;
    } catch {
      url = null;
    }
    return { id: m.id, kind: m.kind, target: m.target, url };
  });
  const checks = parsed.values.check
    ? await Promise.all(reg.models.map((m) => checkLocalModel(m, reg, (input, init) => globalThis.fetch(input, init))))
    : [];
  if (out.isText) {
    if (rows.length === 0) {
      out.line('nenhum modelo local configurado.');
      out.line('  decisões (llama-server):  PB_LOCAL_MODELS="local/laya-ptes=http://127.0.0.1:18081"');
      out.line('  chat (OpenAI-compatível): PB_LOCAL_CHAT="local/k2-horizon=http://127.0.0.1:18100/v1" (ou =@endpoint.json)');
      out.line('  guia: prompt-builder docs local');
    }
    for (const r of rows) {
      const c = checks.find((x) => x.id === r.id);
      const estado = c ? (c.ok ? 'ok' : `FALHOU${c.status ? ` (HTTP ${c.status})` : c.error ? ` (${c.error})` : ''}`) : '';
      out.line(`${r.id.padEnd(24)} ${r.kind.padEnd(9)} ${r.url ?? r.target}${estado ? `  ${estado}` : ''}`);
    }
    for (const issue of reg.issues) out.warn(issue);
  }
  out.result(true, 'local.list', {
    models: rows,
    chatContext: reg.chatContext,
    decisionAuth: Boolean(reg.apiKey),
    issues: reg.issues,
    ...(parsed.values.check ? { checks } : {}),
  });
  return EXIT.OK;
}
