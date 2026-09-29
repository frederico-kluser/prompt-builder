// `models` — listar, inspecionar e EXPORTAR o catalogo com as capacidades de
// ajuste de cada modelo.
//
// E o comando central para "treinar no ambiente em que a IA roda": o agente
// descobre o proprio modelo no catalogo, le quais degraus de raciocinio aquele
// modelo aceita (`thinkLevels`) e treina contra ele sem arriscar um HTTP 400.

import { MODELS_EXPORT_FORMAT, modelCaps, toExportRow, type ModelExportRow } from '../../modelCaps.js';
import {
  AREA_LIVRE,
  allowlistHealth,
  allowlistReport,
  filterModels,
  getLgpdData,
  isSensitiveArea,
  permissionOf,
  type LgpdData,
} from '../../lgpd.js';
import { REASONING_LEVELS } from '../../reasoning.js';
import { promises as fs } from 'node:fs';
import {
  filterByMaxPrice,
  formatPricePerMTok,
  isFreePricing,
  maxPriceFilterDetails,
  type MaxPriceFilterResult,
} from '../../engine/pricing.js';
import { CliError, EXIT } from '../output.js';
import {
  buildCatalogContext,
  buildContext,
  limitList,
  parse,
  parseListLimit,
  type ParsedArgs,
} from '../context.js';
import { daysUntil, describeSuccessor, lifecycleAlertFor } from '../../engine/modelLifecycle.js';
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
  'include-variable-price': { type: 'boolean' },
  free: { type: 'boolean' },
  'lgpd-area': { type: 'string' },
  'include-ressalvas': { type: 'boolean' },
  // IMPL-092: teto de lista — default 50, --all devolve a lista inteira.
  limit: { type: 'string' },
  all: { type: 'boolean' },
  expiring: { type: 'string' },
  format: { type: 'string' },
  out: { type: 'string', short: 'o' },
  // `models allowlist`
  check: { type: 'boolean' },
  area: { type: 'string' },
  'max-age': { type: 'string' },
} as const;

function num(v: unknown, campo: string): number | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new CliError(`${campo} deve ser um número.`, EXIT.USAGE);
  return n;
}

interface FilterOutcome {
  models: OpenRouterModel[];
  /** Resultado do teto de preço (contagem "X de Y" + preço variável), quando houve teto. */
  price?: MaxPriceFilterResult<OpenRouterModel>;
}

function applyFilters(models: OpenRouterModel[], v: Record<string, unknown>): FilterOutcome {
  let out = models;
  let price: MaxPriceFilterResult<OpenRouterModel> | undefined;

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
  // por token. Preco DESCONHECIDO (roteador, "-1") nao passa em teto nenhum por
  // default nem conta como gratis — antes o -1 passava em qualquer
  // `--max-*-price`. `--include-variable-price` e a decisao EXPLICITA de mante-los
  // (IMPL-043: mesma regra do filtro da SPA, src/engine/pricing.ts).
  const maxIn = num(v['max-prompt-price'], '--max-prompt-price');
  const maxOut = num(v['max-completion-price'], '--max-completion-price');
  for (const [campo, teto] of [['--max-prompt-price', maxIn], ['--max-completion-price', maxOut]] as const) {
    // Teto negativo nao tem sentido (e o filtro puro o ignora): erro de uso, nao silencio.
    if (teto !== undefined && teto < 0) throw new CliError(`${campo} deve ser >= 0.`, EXIT.USAGE);
  }
  if (maxIn !== undefined || maxOut !== undefined) {
    price = filterByMaxPrice(out, {
      maxPromptPerMTok: maxIn,
      maxCompletionPerMTok: maxOut,
      includeUnknown: v['include-variable-price'] === true,
    });
    out = price.models;
  }

  if (v.free === true) {
    out = out.filter((m) => isFreePricing(m.pricing));
  }

  // `--expiring <dias>` (IMPL-019): só modelos com expiration_date em até N
  // dias (inclui os já expirados que o catálogo ainda lista).
  const expiring = num(v.expiring, '--expiring');
  if (expiring !== undefined) {
    const agora = new Date();
    out = out.filter((m) => {
      if (!m.expirationDate) return false;
      const d = daysUntil(m.expirationDate, agora);
      return d !== null && d <= expiring;
    });
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

  return { models: out, price };
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

/** Resultado de `models allowlist` (puro: `now`/`data` injetáveis nos testes). */
export interface AllowlistCheck {
  ok: boolean;
  /** Por que o `--check` reprovou (vazio = aprovado). */
  failures: string[];
  data: Record<string, unknown>;
  lines: string[];
}

/**
 * Idade e contagem da allowlist LGPD por endpoint que ESTE pacote carrega
 * (IMPL-041). Não precisa de key nem de rede: lê o snapshot versionado.
 * `--check` vira porta (CI): reprova snapshot vencido/ausente/inválido,
 * idade acima de `--max-age` e qualquer desconhecido liberado em área sensível.
 */
export function allowlistCheck(
  data: LgpdData,
  opts: { area?: string; maxAgeDays?: number; now?: Date | number } = {},
): AllowlistCheck {
  const now = opts.now ?? Date.now();
  const rep = allowlistReport(data, now);
  const h = rep.health;
  const desconhecidos = Object.values(rep.porArea).reduce((s, a) => s + a.desconhecidos_liberados, 0);
  const failures: string[] = [];
  if (!h.usable) failures.push(h.message);
  if (opts.maxAgeDays !== undefined && h.ageDays !== undefined && h.ageDays > opts.maxAgeDays) {
    failures.push(`idade ${h.ageDays} dias > --max-age ${opts.maxAgeDays}`);
  }
  if (desconhecidos > 0) failures.push(`${desconhecidos} desconhecido(s) liberado(s) em área sensível (limiar 0)`);

  const lines = [
    h.message,
    `  estado ${h.state} · validade ${h.maxAgeDays} dias · alvo ${h.targetAgeDays} dias`,
    `  ${h.modelos} modelos no snapshot · ${h.modelosComZdr} com endpoint ZDR · ${h.endpoints} endpoints ZDR`,
    `  modelos com endpoint elegível na UE: ${rep.modelosComEndpointUe}`,
  ];
  if (rep.provedoresForaDoMapa.length) {
    lines.push(`  provedores fora do mapa (excluídos): ${rep.provedoresForaDoMapa.join(', ')}`);
  }
  for (const [id, a] of Object.entries(rep.porArea)) {
    lines.push(
      `  ${id.padEnd(22)} ${a.sensivel ? 'sensível  ' : 'consultiva'} permitidos=${a.permitidos} ` +
        `ressalvas=${a.com_ressalvas} bloqueados=${a.bloqueados} desconhecidos_liberados=${a.desconhecidos_liberados}`,
    );
  }

  let modelos: { id: string; status: string; endpoints: string[] }[] | undefined;
  if (opts.area) {
    modelos = Object.keys(data.allowlist?.modelos ?? {})
      .sort()
      .map((id) => ({ id, p: permissionOf(id, opts.area!, data, now) }))
      .filter(({ p }) => p.status !== 'não recomendado')
      .map(({ id, p }) => ({ id, status: p.status, endpoints: (p.endpoints ?? []).map((e) => e.tag) }));
    lines.push('', `Liberados em "${opts.area}" (${modelos.length}):`);
    for (const m of modelos) {
      lines.push(`  ${m.id}  [${m.status}]${m.endpoints.length ? `  only: ${m.endpoints.join(', ')}` : ''}`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    lines,
    data: {
      state: h.state,
      usable: h.usable,
      dataGeracao: h.geradoEm ?? null,
      ageDays: h.ageDays ?? null,
      maxAgeDays: h.maxAgeDays,
      targetAgeDays: h.targetAgeDays,
      counts: { modelos: h.modelos, modelosComZdr: h.modelosComZdr, endpoints: h.endpoints },
      desconhecidosLiberados: desconhecidos,
      modelosComEndpointUe: rep.modelosComEndpointUe,
      provedoresForaDoMapa: rep.provedoresForaDoMapa,
      porArea: rep.porArea,
      fonte: data.allowlist?.fonte ?? null,
      ...(modelos ? { area: opts.area, modelos } : {}),
      ...(failures.length ? { failures } : {}),
    },
  };
}

async function cmdAllowlist(parsed: ParsedArgs): Promise<number> {
  const ctx = buildContext(parsed);
  const { out, values } = ctx;
  const data = getLgpdData();
  const area = typeof values.area === 'string' ? values.area.trim() : '';
  if (area && (area === AREA_LIVRE || !data.areas.some((a) => a.id === area))) {
    throw new CliError(
      `--area desconhecida: "${area}". Disponíveis: ${data.areas.map((a) => a.id).join(', ')}.`,
      EXIT.USAGE,
    );
  }
  const maxAge = num(values['max-age'], '--max-age');
  const r = allowlistCheck(data, { area: area || undefined, maxAgeDays: maxAge });
  for (const l of r.lines) out.line(l);
  const check = values.check === true;
  if (check && !r.ok) for (const f of r.failures) out.warn(`allowlist reprovada: ${f}`);
  // Sem --check é só relatório; com --check a reprovação é erro de CONFIG (3),
  // pelo envelope único de erro (IMPL-028).
  if (check && !r.ok) {
    throw new CliError(`Allowlist LGPD reprovada: ${r.failures.join('; ')}.`, EXIT.CONFIG, r.data, {
      code: 'config.lgpd_allowlist_failed',
      hint: 'Regenere o snapshot com `npm run lgpd:allowlist` (ou atualize o pacote) e rode `models allowlist --check` de novo.',
    });
  }
  out.result(true, 'models.allowlist', r.data);
  return EXIT.OK;
}

export async function cmdModels(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'list';
  const rest = sub === argv[0] ? argv.slice(1) : argv;
  const parsed: ParsedArgs = parse(rest, OPTIONS);
  // `allowlist` lê o snapshot do pacote: sem key, sem rede.
  if (sub === 'allowlist') return cmdAllowlist(parsed);
  // Catalogo e dado PUBLICO (GET /models responde sem Authorization): sem key,
  // usa o cache em disco ou busca o publico — nunca exit 4 (IMPL-029).
  const ctx = await buildCatalogContext(parsed);
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
      if (row.thinkLevels.accepted.length > 0) {
        out.line('  encaixe (o que vai no fio para cada nível pedido):');
        for (const [pedido, real] of Object.entries(row.thinkLevels.fit)) {
          out.line(`    ${pedido.padEnd(8)} -> ${real}`);
        }
      } else {
        // cli#2: o gateway não envia `reasoning` a este modelo — nenhum nível vale.
        out.line('  encaixe         (nenhum: o modelo não aceita raciocínio — nada vai no fio)');
      }
      // IMPL-019: ciclo de vida — o snapshot por trás do id e quando ele sai.
      if (row.lifecycle.canonicalSlug) out.line(`  snapshot        ${row.lifecycle.canonicalSlug}`);
      if (row.lifecycle.aliasTarget) out.line(`  alias ->        ${row.lifecycle.aliasTarget} (muda sem aviso: não use como juiz de baseline)`);
      out.line(`  expira          ${row.lifecycle.expirationDate ?? 'sem data anunciada'}`);
    }
    // Alerta 30/14/7 dias (stderr) com sucedâneo — o agente vê antes de treinar.
    const alerta = lifecycleAlertFor(model.id, [], model, ctx.models, new Date());
    if (alerta) {
      const quando =
        alerta.kind === 'expired'
          ? `expirou em ${alerta.expirationDate}`
          : `expira em ${alerta.expirationDate} (${alerta.daysLeft} dias; janela de ${alerta.window})`;
      out.warn(
        `${model.id} ${quando} — ${describeSuccessor(alerta.successor)}. Numa baseline, rode uma ` +
          'run-ponte com o sucessor antes da data e declare a re-baseline (`docs lifecycle`).',
      );
    }
    out.result(true, 'models.show', { model: row, lifecycleAlert: alerta });
    return EXIT.OK;
  }

  // list | export
  const { models: filtrados, price } = applyFilters(ctx.models, values);
  // O que o teto de preço fez, com o preço variável explícito — na NARRAÇÃO
  // (stderr), nunca no payload. O "X de Y modelos." geral sai no fim, como antes.
  const detalhes = price ? maxPriceFilterDetails(price) : [];
  if (price && detalhes.length > 0) {
    const dica =
      price.unknownIds.length > 0 && !price.includeUnknown ? ' — use --include-variable-price para mantê-los' : '';
    out.info(`teto de preço: ${detalhes.join(' · ')}${dica}`);
  }
  // Área sensível com snapshot inutilizável (ou velho) esvazia/encolhe a lista:
  // diga POR QUÊ em vez de devolver 0 modelos em silêncio.
  const lgpdArea = typeof values['lgpd-area'] === 'string' ? values['lgpd-area'].trim() : '';
  if (lgpdArea && isSensitiveArea(lgpdArea, getLgpdData())) {
    const h = allowlistHealth(getLgpdData().allowlist);
    if (h.state !== 'ok') out.warn(h.message);
  }
  const destino = typeof values.out === 'string' && values.out.trim() ? values.out.trim() : undefined;
  // IMPL-092: teto default de 50 itens — `models list --json` sem flags já
  // devolveu o catálogo inteiro (~594 KB ≈ 150 mil tokens, satura o contexto
  // do agente). --all é a decisão explícita de querer tudo; truncar avisa.
  // cli#10: o teto protege o CONTEXTO do agente — `models export` (o catálogo
  // é o produto pedido) e `-o <arquivo>` (nada vai para o stdout) não levam o
  // default. Com ele, `export -o models.json` gravava 50 de ~460 modelos e o
  // `baseline check --catalog` acusava juiz "removido". `--limit` explícito
  // continua valendo em qualquer caso.
  const limiteExplicito = values.limit !== undefined && values.limit !== '';
  const cap = (sub === 'export' || destino !== undefined) && !limiteExplicito ? { limit: null } : parseListLimit(values);
  const rows = limitList(filtrados, cap, out, 'modelos').map(toExportRow);
  const truncado = rows.length < filtrados.length;

  // Formato do ARQUIVO (-o) não depende do modo do stdout: sem --format, um
  // arquivo leva o export JSON (o que `baseline check --catalog` lê).
  const formatoExplicito = typeof values.format === 'string' ? values.format : undefined;
  const format =
    formatoExplicito ??
    (destino !== undefined
      ? sub === 'export' || !out.isText
        ? 'json'
        : 'table'
      : out.format === 'json'
        ? 'json'
        : out.format === 'ndjson'
          ? 'ndjson'
          : sub === 'export'
            ? 'json'
            : 'table');

  // JSON compacto por padrão (--pretty formata) — IMPL-092.
  const json = (v: unknown): string => (values.pretty === true ? JSON.stringify(v, null, 2) : JSON.stringify(v));

  let payload: string;
  switch (format) {
    case 'json':
      payload = json({
        format: MODELS_EXPORT_FORMAT,
        fetchedAt: new Date().toISOString(),
        source: ctx.catalogSource,
        scope: ctx.catalogScope,
        count: rows.length,
        total: filtrados.length,
        truncated: truncado,
        data: rows,
      });
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

  const resumo = { count: rows.length, total: filtrados.length, truncated: truncado };
  if (destino) {
    await fs.writeFile(destino, `${payload}\n`, 'utf-8');
    out.info(`${rows.length} de ${filtrados.length} modelos gravados em ${destino}`);
    // cli#10: o envelope diz se o ARQUIVO é parcial (antes só o conteúdo dizia).
    out.result(true, `models.${sub}`, { ...resumo, file: destino, format });
    return EXIT.OK;
  }

  // cli#18: NDJSON do contrato (--output-format ndjson) = linhas TIPADAS
  // terminadas em `result`. O `--format ndjson` em modo texto segue sendo o
  // export cru (uma linha por modelo, sem envelope) — é formato de arquivo.
  if (out.isNdjson) {
    for (const r of rows) out.event('model', { ...r });
    out.result(true, `models.${sub}`, resumo);
    return EXIT.OK;
  }
  // `--json` + formato default (json): o objeto de export documentado É a
  // saída estruturada — não duplicar num envelope.
  if (format === 'json') {
    process.stdout.write(`${payload}\n`);
    return EXIT.OK;
  }
  // cli#18: `--json` com --format csv|ids|table|ndjson: o texto vai DENTRO do
  // envelope (antes o payload sumia e sobrava só {count}).
  if (!out.isText) {
    out.result(true, `models.${sub}`, { ...resumo, format, payload });
    return EXIT.OK;
  }
  if (format === 'ndjson') {
    process.stdout.write(`${payload}\n`);
    return EXIT.OK;
  }
  out.line(payload);
  out.info(`${rows.length} de ${ctx.models.length} modelos.`);
  return EXIT.OK;
}
