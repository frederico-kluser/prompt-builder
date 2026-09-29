// `baseline` — GATE DE CI do contrato de julgamento (IMPL-019, R-07b:REC-8).
//
//   baseline pin <runId> [-o arq] [--successor id=sucessor]…
//       pina juízes/gabarito/hash do contrato + o snapshot de ciclo de vida
//       GRAVADO NA RUN num `judge-baseline@1` (versione junto com o código);
//   baseline check [--file arq] [--config cfg.json | --judge a,b --reference x]
//                  [--catalog models.json]
//       reprova (exit 3) se juiz/gabarito/contrato mudou, se um alias/snapshot
//       derivou, ou se um juiz/gabarito saiu do catálogo — sem re-baseline
//       declarada; catálogo indisponível = exit 8 (fail-closed);
//   baseline declare --reason "…" [--judge a,b] [--reference x] [--bridge-run id]
//       grava a re-baseline DECLARADA no arquivo (a decisão consciente).
//
// O catálogo é o PÚBLICO (GET /models, sem key): o gate roda em CI sem segredo.
// A lógica é pura (`src/engine/judgeBaseline.ts`); aqui só entram disco/rede.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  buildJudgeBaseline,
  checkJudgeBaseline,
  declareRebaseline,
  judgeSetupFromConfig,
  parseJudgeBaseline,
  type JudgeBaseline,
  type JudgeSetup,
} from '../../engine/judgeBaseline.js';
import { judgeContractHash } from '../../engine/judgeCalibration.js';
import { DUEL_HEAD } from '../../engine/duelPrompt.js';
import { JUDGE_LISTWISE_CONTRACT_TEXT } from '../../judge.js';
import { JUDGE_CONTRACT_TEXT } from '../../refJudge.js';
import { getGateway } from '../../openrouter.js';
import { loadCatalogFile, loadPublicCatalog } from '../../publicCatalog.js';
import { getDataDir, loadRun } from '../../storage.js';
import { isArenaAgentConfigFormat, parseArenaConfig, parseArenaAgentConfig } from '../../configFile.js';
import { arenaAgentConfigToRunConfig, arenaConfigToRunConfig } from '../../arenaConfig.js';
import { parseRunConfig } from '../../runConfigSchema.js';
import { CliError, EXIT } from '../output.js';
import { buildContext, parse, type CliContext } from '../context.js';
import type { OpenRouterModel } from '../../types.js';

const OPTIONS = {
  file: { type: 'string' },
  out: { type: 'string', short: 'o' },
  config: { type: 'string' },
  judge: { type: 'string' },
  reference: { type: 'string' },
  catalog: { type: 'string' },
  reason: { type: 'string' },
  'bridge-run': { type: 'string' },
  successor: { type: 'string', multiple: true },
} as const;

/**
 * Hash do contrato do juiz EM VIGOR neste binário para um setup. Mesmo cálculo
 * do orquestrador (`pinJudgeContract`) no caminho DEFAULT (chat sem esforço de
 * raciocínio explícito nem roteamento ZDR): juízes + prompt pointwise + prompt
 * do duelo + prompt listwise + modelo de referência (IMPL-049 — trocar qualquer
 * um destes muda o hash). Se uma versão nova do CLI mudar QUALQUER prompt de
 * julgamento, o gate acusa.
 *
 * GRANULARIDADE (IMPL-049, decisão consciente): o gate compara no espaço de
 * SETUP — think level e política de provedor entram no hash DA RUN (o pin do
 * `judgeDiagnostics.contract`) e no drift `judge.contract.changed`/`runs show`.
 * Uma run pinada com esforço/roteamento fora do default vai exigir re-baseline
 * declarada: as notas dela não são comparáveis com as do default sem dizer.
 */
function contractHashFor(setup: JudgeSetup): string {
  return judgeContractHash(setup.judgeModelIds, JUDGE_CONTRACT_TEXT, {
    duelPromptText: DUEL_HEAD,
    listwisePromptText: JUDGE_LISTWISE_CONTRACT_TEXT,
    referenceModelId: setup.referenceModelId,
  });
}

function defaultFile(): string {
  return path.join(getDataDir(), 'judge-baseline.json');
}

function csv(v: unknown): string[] | undefined {
  if (typeof v !== 'string') return undefined;
  const itens = v.split(',').map((s) => s.trim()).filter(Boolean);
  return itens.length ? itens : undefined;
}

function successorsFrom(v: unknown): Record<string, string> | undefined {
  if (!Array.isArray(v) || !v.length) return undefined;
  const out: Record<string, string> = {};
  for (const par of v as string[]) {
    const i = par.indexOf('=');
    const de = i > 0 ? par.slice(0, i).trim() : '';
    const para = i > 0 ? par.slice(i + 1).trim() : '';
    if (!de || !para) {
      throw new CliError(`--successor espera "id=sucessor" (recebi "${par}").`, EXIT.USAGE);
    }
    out[de] = para;
  }
  return out;
}

async function readBaseline(file: string): Promise<JudgeBaseline> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch {
    throw new CliError(
      `Baseline "${file}" não encontrada. Crie uma com \`prompt-builder baseline pin <runId> -o ${file}\`.`,
      EXIT.CONFIG,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new CliError(`"${file}" não é um JSON válido: ${(err as Error).message}`, EXIT.CONFIG);
  }
  const p = parseJudgeBaseline(json);
  if (!p.ok) throw new CliError(p.error, EXIT.CONFIG);
  return p.baseline;
}

async function writeBaseline(file: string, baseline: JudgeBaseline): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8');
}

/** Juízes/gabarito de um arquivo de config (arena-config@1, arena-agent-config@1 ou RunConfig cru). */
async function setupFromConfigFile(file: string): Promise<JudgeSetup> {
  let json: unknown;
  try {
    json = JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch (err) {
    throw new CliError(`Não consegui ler a config "${file}": ${(err as Error).message}`, EXIT.CONFIG);
  }
  const formato = (json as Record<string, unknown> | null)?.format;
  let cfg: { judgeModelIds?: string[]; referenceModelId?: string };
  if (isArenaAgentConfigFormat(formato)) {
    const p = parseArenaAgentConfig(json);
    if (!p.ok) throw new CliError(p.error, EXIT.CONFIG);
    const conv = arenaAgentConfigToRunConfig(p.config);
    if (!conv.ok) throw new CliError(conv.error, EXIT.CONFIG);
    cfg = conv.config;
  } else if (typeof formato === 'string') {
    const p = parseArenaConfig(json);
    if (!p.ok) throw new CliError(p.error, EXIT.CONFIG);
    const conv = arenaConfigToRunConfig(p.config);
    if (!conv.ok) throw new CliError(conv.error, EXIT.CONFIG);
    cfg = conv.config;
  } else {
    const p = parseRunConfig(json);
    if (!p.ok) throw new CliError(p.error, EXIT.CONFIG, p.details);
    cfg = p.config;
  }
  const setup = judgeSetupFromConfig(cfg);
  if (!setup) throw new CliError(`A config "${file}" não declara juízes.`, EXIT.CONFIG);
  return setup;
}

/** Catálogo: `--catalog <arquivo>` (snapshot) ou o público com cache de 24 h. */
async function catalogFor(
  ctx: CliContext,
  values: Record<string, unknown>,
): Promise<{ models: OpenRouterModel[]; source: string }> {
  if (typeof values.catalog === 'string' && values.catalog.trim()) {
    try {
      const models = await loadCatalogFile(path.resolve(values.catalog.trim()));
      return { models, source: `arquivo ${values.catalog}` };
    } catch (err) {
      throw new CliError((err as Error).message, EXIT.CONFIG);
    }
  }
  try {
    const r = await loadPublicCatalog({
      cachePath: path.join(getDataDir(), 'cache', 'public-catalog.json'),
      force: values['refresh-models'] === true,
      baseUrl: getGateway().config.baseUrl,
      onWarn: (m) => ctx.out.warn(m),
    });
    return { models: r.models, source: r.source };
  } catch (err) {
    // Fail-closed: sem catálogo não dá para afirmar que o juiz existe.
    throw new CliError(
      `Não consegui carregar o catálogo de modelos (GET /models): ${(err as Error).message}`,
      EXIT.NETWORK,
    );
  }
}

export async function cmdBaseline(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'check';
  const parsed = parse(sub === argv[0] ? argv.slice(1) : argv, OPTIONS);
  const ctx = buildContext(parsed);
  const { out, values } = ctx;
  const now = new Date();

  if (sub === 'pin') {
    const runId = parsed.positionals[0];
    if (!runId) throw new CliError('Uso: prompt-builder baseline pin <runId> [-o <arquivo>]', EXIT.USAGE);
    const record = await loadRun(runId);
    if (!record) throw new CliError(`Run "${runId}" não encontrada em ${getDataDir()}.`, EXIT.USAGE);
    const setup = judgeSetupFromConfig(record.config);
    if (!setup) throw new CliError(`A run "${runId}" não tem juízes na config.`, EXIT.CONFIG);
    const temSnapshot = record.modelLifecycle?.source === 'catalog';
    const catalogo = temSnapshot ? null : (await catalogFor(ctx, values)).models;
    const { baseline, usedCatalogFallback } = buildJudgeBaseline({
      setup,
      contractHash: record.judgeDiagnostics?.contract.hash ?? contractHashFor(setup),
      lifecycle: record.modelLifecycle,
      catalog: catalogo,
      baselineRunId: record.id,
      successors: successorsFrom(values.successor),
      now,
    });
    if (usedCatalogFallback.length) {
      out.warn(
        `a run não gravou o ciclo de vida de ${usedCatalogFallback.join(', ')} (record antigo?) — ` +
          'pinei o snapshot do catálogo de HOJE; deriva anterior a hoje fica invisível.',
      );
    }
    // Sem canonical_slug o gate não enxerga deriva de snapshot daquele modelo
    // (run feita com um cache de catálogo anterior ao IMPL-019, p.ex.).
    const semSlug = Object.entries(baseline.models)
      .filter(([, pin]) => !pin.canonicalSlug)
      .map(([id]) => id);
    if (semSlug.length) {
      out.warn(
        `sem canonical_slug para ${semSlug.join(', ')}: o gate não verá troca de snapshot desses modelos. ` +
          'Se a run usou um catálogo em cache antigo, refaça-a com --refresh-models e pine de novo.',
      );
    }
    const alvo = typeof values.out === 'string' && values.out.trim() ? path.resolve(values.out.trim()) : defaultFile();
    await writeBaseline(alvo, baseline);
    out.info(`baseline pinada em ${alvo} (run ${record.id}, contrato ${baseline.judge.contractHash.slice(0, 12)})`);
    out.result(true, 'baseline.pin', { file: alvo, baseline });
    return EXIT.OK;
  }

  const file =
    typeof values.file === 'string' && values.file.trim() ? path.resolve(values.file.trim()) : defaultFile();

  if (sub === 'declare') {
    const reason = typeof values.reason === 'string' ? values.reason.trim() : '';
    if (!reason) {
      throw new CliError('`baseline declare` exige --reason "<por que a baseline mudou>".', EXIT.USAGE);
    }
    const baseline = await readBaseline(file);
    const judges = csv(values.judge) ?? baseline.judge.modelIds;
    // Sem --reference: mantém o gabarito pinado — salvo quando ele era o
    // default (o 1º juiz), caso em que acompanha o novo 1º juiz (mesma regra
    // do orquestrador: referenceModelId ausente = judgeModelIds[0]).
    const gabaritoEraDefault = baseline.reference.modelId === baseline.judge.modelIds[0];
    const reference =
      (typeof values.reference === 'string' && values.reference.trim()) ||
      (gabaritoEraDefault ? judges[0] : baseline.reference.modelId);
    const extras = successorsFrom(values.successor);
    const atualizado = declareRebaseline(
      extras ? { ...baseline, successors: { ...(baseline.successors ?? {}), ...extras } } : baseline,
      {
        reason,
        judgeModelIds: judges,
        referenceModelId: reference,
        bridgeRunId:
          typeof values['bridge-run'] === 'string' && values['bridge-run'].trim()
            ? values['bridge-run'].trim()
            : undefined,
      },
      now,
    );
    await writeBaseline(file, atualizado);
    out.info(`re-baseline declarada em ${file}: juízes [${judges.join(', ')}] / gabarito ${reference}`);
    out.result(true, 'baseline.declare', { file, rebaseline: atualizado.rebaseline });
    return EXIT.OK;
  }

  if (sub !== 'check') {
    throw new CliError(
      `Subcomando desconhecido: "${sub}". Uso: prompt-builder baseline <check|pin|declare>.`,
      EXIT.USAGE,
    );
  }

  const baseline = await readBaseline(file);
  let current: JudgeSetup | null = null;
  if (typeof values.config === 'string' && values.config.trim()) {
    current = await setupFromConfigFile(path.resolve(values.config.trim()));
  } else if (csv(values.judge)) {
    const judges = csv(values.judge)!;
    current = {
      judgeModelIds: judges,
      referenceModelId:
        typeof values.reference === 'string' && values.reference.trim() ? values.reference.trim() : judges[0],
    };
  }
  const cat = await catalogFor(ctx, values);
  const report = checkJudgeBaseline(baseline, {
    current,
    catalog: cat.models,
    now,
    contractHashFor,
  });

  if (out.isText) {
    out.line(`baseline: ${file}${baseline.baselineRunId ? ` (run ${baseline.baselineRunId})` : ''}`);
    out.line(
      `contrato em vigor (${report.effective.source}): juízes [${report.effective.judgeModelIds.join(', ')}] · ` +
        `gabarito ${report.effective.referenceModelId}`,
    );
    out.line(`catálogo: ${cat.models.length} modelos (${cat.source})`);
    for (const f of report.failures) out.line(`ERRO  [${f.kind}] ${f.message}`);
    for (const w of report.warnings) out.line(`AVISO [${w.kind}] ${w.message}`);
    out.line(report.ok ? 'ok: o contrato de julgamento é o da baseline.' : 'REPROVADO: o julgamento não é comparável com a baseline.');
  }
  // Gate reprovado = config: a baseline versionada não descreve mais o
  // julgamento em vigor (mesmo código do drift de `registry validate`). Falha
  // sai pelo envelope único de erro (IMPL-028), nunca um `result` ok:false.
  if (!report.ok) {
    throw new CliError(
      `Baseline reprovada: ${report.failures.map((f) => f.message).join('; ') || 'o julgamento não é comparável com a baseline'}.`,
      EXIT.CONFIG,
      { file, report },
      {
        code: 'config.baseline_drift',
        hint: 'Rode uma run-ponte e declare a re-baseline com `prompt-builder baseline declare --reason "…"` (ver `docs lifecycle`).',
      },
    );
  }
  out.result(true, 'baseline.check', { file, report });
  return EXIT.OK;
}
