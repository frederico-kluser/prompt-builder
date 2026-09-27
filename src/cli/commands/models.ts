// `models` — listar, inspecionar e EXPORTAR o catalogo com as capacidades de
// ajuste de cada modelo.
//
// E o comando central para "treinar no ambiente em que a IA roda": o agente
// descobre o proprio modelo no catalogo, le quais degraus de raciocinio aquele
// modelo aceita (`thinkLevels`) e treina contra ele sem arriscar um HTTP 400.

import { MODELS_EXPORT_FORMAT, modelCaps, toExportRow, type ModelExportRow } from '../../modelCaps.js';
import { filterModels, getLgpdData } from '../../lgpd.js';
import { REASONING_LEVELS } from '../../reasoning.js';
import { promises as fs } from 'node:fs';
import {
  formatPricePerMTok,
  isFreePricing,
  withinMaxPricePerMTok,
} from '../../engine/pricing.js';
import { CliError, EXIT } from '../output.js';
import { buildNetworkContext, parse, type ParsedArgs } from '../context.js';
import type { OpenRouterModel, ReasoningLevel } from '../../types.js';

const OPTIONS = {
  search: { type: 'string' },
  provider: { type: 'string', multiple: true },
  effort: { type: 'string' },
  supports: { type: 'string', multiple: true },
  reasoning: { type: 'boolean' },
  'no-reasoning': { type: 'boolean' },
  'min-context': { type: 'string' },
  'max-prompt-price': { type: 'string' },
  'max-completion-price': { type: 'string' },
  free: { type: 'boolean' },
  'lgpd-area': { type: 'string' },
  'include-ressalvas': { type: 'boolean' },
  limit: { type: 'string' },
  format: { type: 'string' },
  out: { type: 'string', short: 'o' },
} as const;

function num(v: unknown, campo: string): number | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new CliError(`${campo} deve ser um número.`, EXIT.USAGE);
  return n;
}

function applyFilters(models: OpenRouterModel[], v: Record<string, unknown>): OpenRouterModel[] {
  let out = models;

  const search = typeof v.search === 'string' ? v.search.toLowerCase().trim() : '';
  if (search) {
    out = out.filter(
      (m) => m.id.toLowerCase().includes(search) || m.name.toLowerCase().includes(search),
    );
  }

  const providers = (v.provider as string[] | undefined)?.map((p) => p.toLowerCase());
  if (providers?.length) {
    out = out.filter((m) => providers.some((p) => m.id.toLowerCase().startsWith(`${p}/`)));
  }

  if (v.reasoning === true) out = out.filter((m) => modelCaps(m).reasoning);
  if (v['no-reasoning'] === true) out = out.filter((m) => !modelCaps(m).reasoning);

  // `--effort <nivel>`: so modelos que aceitam AQUELE degrau (sem encaixe).
  const effort = typeof v.effort === 'string' ? v.effort.trim() : '';
  if (effort) {
    if (!(REASONING_LEVELS as readonly string[]).includes(effort)) {
      throw new CliError(
        `--effort deve ser um de: ${REASONING_LEVELS.join(', ')}.`,
        EXIT.USAGE,
      );
    }
    out = out.filter((m) => toExportRow(m).thinkLevels.accepted.includes(effort as ReasoningLevel));
  }

  const supports = v.supports as string[] | undefined;
  if (supports?.length) {
    out = out.filter((m) => supports.every((p) => m.supportedParameters?.includes(p)));
  }

  const minCtx = num(v['min-context'], '--min-context');
  if (minCtx !== undefined) out = out.filter((m) => (m.contextLength ?? 0) >= minCtx);

  // Precos de filtro sao em USD por MILHAO (o que humanos usam); o catalogo e
  // por token. Preco DESCONHECIDO (roteador, "-1") nao passa em teto nenhum nem
  // conta como gratis — antes o -1 passava em qualquer `--max-*-price`.
  const maxIn = num(v['max-prompt-price'], '--max-prompt-price');
  if (maxIn !== undefined) out = out.filter((m) => withinMaxPricePerMTok(m.pricing.prompt, maxIn));
  const maxOut = num(v['max-completion-price'], '--max-completion-price');
  if (maxOut !== undefined) out = out.filter((m) => withinMaxPricePerMTok(m.pricing.completion, maxOut));

  if (v.free === true) {
    out = out.filter((m) => isFreePricing(m.pricing));
  }

  const area = typeof v['lgpd-area'] === 'string' ? v['lgpd-area'].trim() : '';
  if (area) {
    const data = getLgpdData();
    const areas = data.areas.map((a) => a.id);
    if (!areas.includes(area)) {
      throw new CliError(
        `--lgpd-area desconhecida: "${area}". Disponíveis: ${areas.join(', ')}.`,
        EXIT.USAGE,
      );
    }
    out = filterModels(out, area, v['include-ressalvas'] === true, data).allowed;
  }

  return out;
}

/** Preco de uma linha de export ("variável" quando desconhecido — nunca "-1"). */
function fmtRowPrice(p: ModelExportRow['pricing']['prompt']): string {
  return formatPricePerMTok(typeof p === 'number' ? p : null);
}

function renderTable(rows: ModelExportRow[]): string[] {
  return rows.map((r) => {
    const think = r.thinkLevels.accepted.length
      ? r.thinkLevels.accepted.join(',')
      : '—';
    const preco = `in ${fmtRowPrice(r.pricing.prompt)} / out ${fmtRowPrice(r.pricing.completion)}`;
    return `${r.id}\n    ${preco} /1M · ctx ${r.contextLength ?? '?'} · think: ${think}`;
  });
}

function toCsv(rows: ModelExportRow[]): string {
  const esc = (v: unknown): string => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = [
    'id',
    'name',
    'contextLength',
    'promptPerMTok',
    'completionPerMTok',
    'temperature',
    'reasoning',
    'mandatory',
    'defaultEffort',
    'thinkLevels',
  ];
  const linhas = rows.map((r) =>
    [
      r.id,
      r.name,
      r.contextLength ?? '',
      r.pricePerMTok.prompt,
      r.pricePerMTok.completion,
      r.caps.temperature,
      r.caps.reasoning,
      r.caps.mandatory,
      r.thinkLevels.default ?? '',
      r.thinkLevels.accepted.join('|'),
    ]
      .map(esc)
      .join(','),
  );
  return [head.join(','), ...linhas].join('\n');
}

export async function cmdModels(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'list';
  const rest = sub === argv[0] ? argv.slice(1) : argv;
  const parsed: ParsedArgs = parse(rest, OPTIONS);
  const ctx = await buildNetworkContext(parsed);
  const { out, values } = ctx;

  // `show <id>` — tudo o que se pode ajustar naquele modelo.
  if (sub === 'show') {
    const id = parsed.positionals[0];
    if (!id) throw new CliError('Uso: prompt-builder models show <id>', EXIT.USAGE);
    const model = ctx.models.find((m) => m.id === id);
    if (!model) {
      throw new CliError(
        `Modelo "${id}" não está no catálogo. Use \`models list --search ${id.split('/').pop()}\`.`,
        EXIT.USAGE,
      );
    }
    const row = toExportRow(model);
    if (out.isText) {
      out.line(`${row.id}  —  ${row.name}`);
      out.line(`  contexto        ${row.contextLength ?? '?'} tokens`);
      out.line(
        `  preço           in ${fmtRowPrice(row.pricing.prompt)} / out ${fmtRowPrice(row.pricing.completion)} por 1M tokens`,
      );
      out.line(`  temperature     ${row.caps.temperature ? 'aceita' : 'NÃO aceita'}`);
      out.line(
        `  raciocínio      ${row.caps.reasoning ? (row.caps.mandatory ? 'obrigatório' : 'opcional') : 'não suporta'}`,
      );
      out.line(`  think levels    ${row.thinkLevels.accepted.join(', ') || '—'}`);
      if (row.thinkLevels.default) out.line(`  padrão          ${row.thinkLevels.default}`);
      out.line('  encaixe (o que vai no fio para cada nível pedido):');
      for (const [pedido, real] of Object.entries(row.thinkLevels.fit)) {
        out.line(`    ${pedido.padEnd(8)} -> ${real}`);
      }
    }
    out.result(true, 'models.show', { model: row });
    return EXIT.OK;
  }

  // list | export
  const filtrados = applyFilters(ctx.models, values);
  const limit = num(values.limit, '--limit');
  const rows = (limit !== undefined ? filtrados.slice(0, limit) : filtrados).map(toExportRow);

  const format =
    typeof values.format === 'string'
      ? values.format
      : out.format === 'json'
        ? 'json'
        : out.format === 'ndjson'
          ? 'ndjson'
          : sub === 'export'
            ? 'json'
            : 'table';

  let payload: string;
  switch (format) {
    case 'json':
      payload = JSON.stringify(
        {
          format: MODELS_EXPORT_FORMAT,
          fetchedAt: new Date().toISOString(),
          source: ctx.catalogSource,
          count: rows.length,
          data: rows,
        },
        null,
        2,
      );
      break;
    case 'ndjson':
      payload = rows.map((r) => JSON.stringify(r)).join('\n');
      break;
    case 'csv':
      payload = toCsv(rows);
      break;
    case 'ids':
      payload = rows.map((r) => r.id).join('\n');
      break;
    case 'table':
      payload = renderTable(rows).join('\n');
      break;
    default:
      throw new CliError(
        `--format deve ser table, json, ndjson, csv ou ids (recebi "${format}").`,
        EXIT.USAGE,
      );
  }

  const destino = typeof values.out === 'string' ? values.out : undefined;
  if (destino) {
    await fs.writeFile(destino, `${payload}\n`, 'utf-8');
    out.info(`${rows.length} modelos gravados em ${destino}`);
    out.result(true, `models.${sub}`, { count: rows.length, file: destino });
    return EXIT.OK;
  }

  // Em json/ndjson o payload JA e a saida estruturada — nao duplicar no result.
  if (format === 'json' || format === 'ndjson') {
    process.stdout.write(`${payload}\n`);
  } else {
    out.line(payload);
    out.info(`${rows.length} de ${ctx.models.length} modelos.`);
    out.result(true, `models.${sub}`, { count: rows.length });
  }
  return EXIT.OK;
}
