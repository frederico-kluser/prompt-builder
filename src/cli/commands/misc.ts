// Comandos menores: `key`, `estimate`, `runs`, `sessions`, `techniques`,
// `lgpd`, `config`, `registry`, `doctor`.

import { promises as fs, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { listRuns, loadRun, listSessions, loadSession, getDataDir, setDataDir } from '../../storage.js';
import { listTechniques } from '../../techniques.js';
import { allowlistHealth, getLgpdData, isSensitiveArea, PII_COVERAGE, PII_MODES } from '../../lgpd.js';
import { parseRunConfig } from '../../runConfigSchema.js';
import { parseArenaConfig, arenaConfigSummary } from '../../configFile.js';
import { arenaConfigToRunConfig } from '../../arenaConfig.js';
import { estimateInputFromConfig, estimateRunCost } from '../../estimate.js';
import { exampleRegistryJson, parseRegistry, validateRegistry } from '../../registry.js';
import { sampleSizeWarning } from '../../engine/judgeCalibration.js';
import {
  formatIterationGate,
  formatPairCoverage,
  formatRunCompleteness,
  formatSignificance,
  runCompleteness,
} from '../../stats.js';
import { judgeScaleWarning } from '../../engine/verdictAggregate.js';
import { buildReproduceArtifact, buildRunArtifact, configFileForRun } from '../../runArtifact.js';
import {
  buildCatalogContext,
  buildContext,
  buildNetworkContext,
  checkKey,
  keyFilePath,
  loadCatalog,
  parse,
  resolveHome,
  readJsonFile,
  removeStoredKey,
  resolveKey,
  writeStoredKey,
} from '../context.js';
import { CliError, EXIT, fmtUsd, renderSpend, toCliError, type Output } from '../output.js';
import type { KeyInfo } from '../../openrouter.js';
import { DEFAULT_DAILY_CAP_USD, readDailySnapshot, resolveDailyCap } from '../spendLedger.js';
import { listRunLocks } from '../runLock.js';
import {
  evaluateHandoffGuards,
  normalizeOverrideReason,
  type HandoffGuardReport,
} from '../../engine/handoffGuards.js';
import {
  appendHandoffAudit,
  buildHandoffAuditEntry,
  ensureHandoffAuditWritable,
  handoffAuditPath,
  overrideTrailers,
} from '../handoff.js';
import type { SessionRecord } from '../../types.js';
import { readConfigFile, resolveArenaLibrary } from './run.js';

// --- key ---------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf-8').trim();
}

export async function cmdKey(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'check';
  const parsed = parse(sub === argv[0] ? argv.slice(1) : argv, { stdin: { type: 'boolean' } });
  const ctx = buildContext(parsed);
  const { out } = ctx;

  if (sub === 'path') {
    out.line(keyFilePath());
    out.result(true, 'key.path', { path: keyFilePath() });
    return EXIT.OK;
  }

  if (sub === 'rm') {
    await removeStoredKey();
    out.info('key removida.');
    out.result(true, 'key.rm', {});
    return EXIT.OK;
  }

  if (sub === 'set') {
    // Exigir --stdin fora de um terminal e uma protecao real: uma key em argv
    // entra no historico do shell E na transcricao do proprio agente.
    if (parsed.values.stdin !== true) {
      throw new CliError(
        'Use `prompt-builder key set --stdin` e mande a key pela entrada padrão — ' +
          'passar a key como argumento a deixaria no histórico do shell.',
        EXIT.USAGE,
      );
    }
    const key = await readStdin();
    if (!key) throw new CliError('Nada recebido na entrada padrão.', EXIT.USAGE);
    const info = await checkKey(key);
    const file = await writeStoredKey(key);
    out.info(`key válida, gravada em ${file}`);
    out.result(true, 'key.set', { path: file, ...info });
    return EXIT.OK;
  }

  // check
  const net = await buildNetworkContext(parsed);
  const info = await checkKey(net.apiKey);
  if (out.isText) {
    out.line(`key válida${info.label ? ` (${info.label})` : ''}`);
    if (typeof info.usageUsd === 'number') out.line(`  uso        ${fmtUsd(info.usageUsd)}`);
    if (info.limitUsd != null) out.line(`  limite     ${fmtUsd(info.limitUsd)}`);
    if (info.limitRemainingUsd != null) out.line(`  disponível ${fmtUsd(info.limitRemainingUsd)}`);
    if (info.isFreeTier) out.line('  tier       gratuito (limites de rate dominam o custo)');
    out.line(`  catálogo   ${net.models.length} modelos (${net.catalogSource})`);
  }
  out.result(true, 'key.check', { ...info, models: net.models.length });
  return EXIT.OK;
}

// --- estimate ----------------------------------------------------------------

export async function cmdEstimate(argv: string[]): Promise<number> {
  const parsed = parse(argv, { config: { type: 'string', short: 'c' } });
  const file = parsed.values.config;
  if (typeof file !== 'string') {
    throw new CliError('Uso: prompt-builder estimate --config <arquivo.json>', EXIT.USAGE, undefined, {
      code: 'usage.missing_flag',
      hint: 'Passe `--config <arquivo.json>` (`prompt-builder config example -o arena.json` gera um).',
    });
  }
  // Mesma leitura do `vary/evolve --config` (inclui `scenarios.from: 'library'`,
  // a checagem de labelSet dos itens e o aviso de chave descontinuada) — e
  // ANTES da rede: config inválida sai com exit 3 sem baixar o catálogo. O
  // data-dir (onde mora a biblioteca) é fixado antes, como o buildContext faria.
  setDataDir(resolveHome(parsed.values));
  const config = await readConfigFile(file);
  // Estimar e ler preco do catalogo PUBLICO: nao exige key (IMPL-029).
  const ctx = await buildCatalogContext(parsed);
  const { out } = ctx;

  const est = estimateRunCost(estimateInputFromConfig(config), ctx.models);
  if (out.isText) {
    out.line(`Estimativa: ${fmtUsd(est.low)} – ${fmtUsd(est.high)}`);
    out.line();
    out.line('Por papel (no teto):');
    for (const [role, usd] of Object.entries(est.byRole).sort((a, b) => b[1] - a[1])) {
      if (usd > 0) out.line(`  ${role.padEnd(12)} ${fmtUsd(usd)}`);
    }
    out.line();
    out.line('Premissas:');
    for (const [k, v] of Object.entries(est.assumptions)) out.line(`  ${k.padEnd(18)} ${v}`);
    if (est.unpricedModelIds.length) {
      out.warn(`sem preço no catálogo: ${est.unpricedModelIds.join(', ')}`);
    }
    if (est.unknownPriceModelIds.length) {
      out.warn(`preço variável (fora da estimativa): ${est.unknownPriceModelIds.join(', ')}`);
    }
  }
  out.result(true, 'estimate', {
    estimate: est,
    catalog: { source: ctx.catalogSource, scope: ctx.catalogScope, models: ctx.models.length },
  });
  return EXIT.OK;
}

// --- runs / sessions ---------------------------------------------------------

export async function cmdRuns(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'list';
  const parsed = parse(sub === argv[0] ? argv.slice(1) : argv, {
    limit: { type: 'string' },
    status: { type: 'string' },
    'prompt-only': { type: 'boolean' },
    out: { type: 'string', short: 'o' },
  });
  const ctx = buildContext(parsed);
  const { out } = ctx;

  if (sub === 'list') {
    let rows = await listRuns();
    if (typeof parsed.values.status === 'string') {
      rows = rows.filter((r) => r.status === parsed.values.status);
    }
    const limit = Number(parsed.values.limit ?? 20);
    rows = rows.slice(0, Number.isFinite(limit) ? limit : 20);
    if (out.isText) {
      for (const r of rows) {
        out.line(
          `${r.id}  ${r.status.padEnd(8)} ${r.mode.padEnd(9)} ${fmtUsd(r.totalCostUsd).padStart(9)}  ${r.theme.slice(0, 48)}`,
        );
      }
      if (rows.length === 0) out.info('nenhuma run em ' + getDataDir());
    }
    out.result(true, 'runs.list', { runs: rows });
    return EXIT.OK;
  }

  const id = parsed.positionals[0];
  if (!id) throw new CliError(`Uso: prompt-builder runs ${sub} <id>`, EXIT.USAGE);
  const record = await loadRun(id);
  if (!record) throw new CliError(`Run "${id}" não encontrada em ${getDataDir()}.`, EXIT.USAGE);

  if (sub === 'reproduce') {
    // Reprodutibilidade: o config equivalente ao da run salva + o comando EXATO
    // para re-rodá-la. A vista arena-config@1 vem junto no --json (o `config` é
    // a fonte de verdade lossless — ver src/runArtifact.ts).
    const art = buildReproduceArtifact(record);
    if (out.isText) {
      out.line(JSON.stringify(art.config, null, 2));
      out.line();
      out.line(`Comando sugerido (grave o JSON acima em ${configFileForRun(record.id)}):`);
      out.line(`  ${art.suggestedCommand}`);
    }
    out.result(true, 'runs.reproduce', {
      runId: art.runId,
      config: art.config,
      arenaConfig: art.arenaConfig,
      suggestedCommand: art.suggestedCommand,
    });
    return EXIT.OK;
  }

  if (sub === 'export') {
    // Artefato auto-contido: record + etapas com gabaritos + system prompts +
    // vereditos do juiz — auditável/reproduzível sem o disco original.
    const artifact = buildRunArtifact(record);
    const texto = `${JSON.stringify(artifact, null, 2)}\n`;
    const alvo =
      typeof parsed.values.out === 'string' && parsed.values.out.trim()
        ? parsed.values.out.trim()
        : undefined;
    if (alvo) {
      await fs.writeFile(alvo, texto, 'utf-8');
      out.info(`artefato gravado em ${alvo}`);
    } else if (out.isText) {
      out.raw(texto);
    }
    out.result(true, 'runs.export', { runId: record.id, file: alvo ?? null, artifact });
    return EXIT.OK;
  }

  if (sub === 'winner') {
    const ranking = record.standings?.length
      ? record.standings.map((s) => s.id)
      : Object.entries(record.judgeScoreByContestant ?? {})
          .sort((a, b) => b[1] - a[1])
          .map(([cid]) => cid);
    const vencedorId = ranking[0];
    const vencedor = record.contestants.find((c) => c.id === vencedorId);
    if (parsed.values['prompt-only'] === true) {
      // Payload puro no stdout: e o movimento final do fluxo
      // (`… winner <id> --prompt-only > prompt.md`).
      out.raw(vencedor?.systemPrompt ?? '');
      return EXIT.OK;
    }
    if (out.isText) {
      out.line(`vencedor: ${vencedor?.label ?? vencedorId ?? '—'}`);
      out.line(`régua: ${record.standings?.length ? 'duelos das finais' : 'judge-score'}`);
      if (vencedor?.systemPrompt) {
        out.line();
        out.line(vencedor.systemPrompt);
      }
    }
    out.result(true, 'runs.winner', {
      contestantId: vencedorId,
      label: vencedor?.label,
      systemPrompt: vencedor?.systemPrompt,
      ruler: record.standings?.length ? 'duels' : 'judge-score',
    });
    return EXIT.OK;
  }

  // show
  // IMPL-005: n nominal × efetivo SEMPRE visível (runs antigas: recalculado das etapas).
  const completeness = record.completeness ?? runCompleteness(record);
  if (out.isText) {
    out.line(`${record.id}  ${record.status}  ${record.mode}`);
    out.line(`tema: ${record.config.theme}`);
    out.line(`etapas: ${record.stages.length} · participantes: ${record.contestants.length}`);
    const labelOf = (cid: string): string => record.contestants.find((c) => c.id === cid)?.label ?? cid;
    for (const l of formatRunCompleteness(completeness, labelOf)) out.line(l);
    out.line();
    for (const l of renderSpend(
      record.costByRole,
      record.totalCostUsd,
      record.budgetUsd,
      record.costAccuracy,
    )) {
      out.line(l);
    }
    // F4.2/F4.4 — diagnostico do juiz e orientacao de amostra: o que faz a
    // comparacao entre sessoes ser (ou nao) confiavel, junto do resultado.
    const diag = record.judgeDiagnostics;
    if (diag) {
      out.line();
      out.line(`juiz: contrato ${diag.contract.hash.slice(0, 12)} (${diag.contract.modelIds.join(', ')})`);
      if (diag.verbosity.warning) out.line(`! ${diag.verbosity.warning}`);
    }
    for (const aviso of record.fairnessWarnings ?? []) out.line(`! ${aviso}`);
    // IMPL-019: alertas de ciclo de vida gravados NO INÍCIO da run (30/14/7
    // dias, expirado, ausente). Para o estado de hoje: `baseline check`.
    for (const a of record.modelLifecycle?.alerts ?? []) {
      out.line(`! ciclo de vida (em ${record.modelLifecycle!.capturedAt.slice(0, 10)}): ${a.message}`);
    }
    const escala = judgeScaleWarning(record);
    if (escala) out.line(`! ${escala}`);
    const amostra = sampleSizeWarning(record.stages.length, 'etapas');
    if (amostra) out.line(`! ${amostra}`);
  }
  out.result(true, 'runs.show', {
    run: record,
    completeness,
    judgeDiagnostics: record.judgeDiagnostics ?? null,
    fairnessWarnings: record.fairnessWarnings ?? [],
    lifecycleAlerts: record.modelLifecycle?.alerts ?? [],
    // IMPL-007: judge-score de painel em escala antiga (média ordinal inflada).
    judgeScaleWarning: judgeScaleWarning(record) ?? null,
    sampleWarnings: [sampleSizeWarning(record.stages.length, 'etapas')].filter(Boolean),
  });
  return EXIT.OK;
}

// --- handoff versionado (`sessions winner --apply`) ---------------------------
//
// O prompt campeão sai do disco da sessão e entra num arquivo de produção. O
// fluxo NUNCA perde o anterior: backup antes de sobrescrever, diff sempre, e
// qualquer falha de git vira AVISO (o prompt já está salvo — derrubar o
// comando depois disso seria perder o movimento inteiro por causa do enfeite).

/** Resultado do `--apply` (payload do `--json`). */
export interface ApplyReport {
  applied: boolean;
  file: string;
  backup: string | null;
  committed: boolean;
}

type GitResult = { ok: true; out: string } | { ok: false; error: string };

function git(args: string[]): GitResult {
  try {
    return {
      ok: true,
      out: execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }),
    };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return { ok: false, error: (e.stderr ?? e.stdout ?? e.message ?? 'erro desconhecido').trim() };
  }
}

/** `git diff --no-index`: exit 1 = há diferenças (não é erro). */
function gitNoIndexDiff(antes: string, depois: string): GitResult {
  try {
    return {
      ok: true,
      out: execFileSync('git', ['diff', '--no-index', '--', antes, depois], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (err) {
    const e = err as { status?: number; stderr?: string; stdout?: string; message?: string };
    if (e.status === 1 && typeof e.stdout === 'string') return { ok: true, out: e.stdout };
    return { ok: false, error: (e.stderr ?? e.stdout ?? e.message ?? 'erro desconhecido').trim() };
  }
}

/**
 * `git add` + `git commit` SÓ do arquivo aplicado (não arrasta o index alheio).
 * `trailers` (ex.: `Override-Reason:`) viram o último parágrafo da mensagem —
 * o formato que `git interpret-trailers --parse` lê.
 */
function commitAppliedFile(file: string, sessionId: string, out: Output, trailers: string[] = []): boolean {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const top = git(['-C', dir, 'rev-parse', '--show-toplevel']);
  if (!top.ok) {
    out.warn('destino fora de um repositório git — commit pulado.');
    return false;
  }
  const add = git(['-C', dir, 'add', '--', base]);
  if (!add.ok) {
    out.warn(`git add falhou (${add.error}) — commit pulado.`);
    return false;
  }
  const assunto = `prompt: atualiza ${base} (sessão ${sessionId})`;
  const mensagem = trailers.length > 0 ? `${assunto}\n\n${trailers.join('\n')}` : assunto;
  const commit = git(['-C', dir, 'commit', '-m', mensagem, '--', base]);
  if (!commit.ok) {
    out.warn(`git commit falhou (${commit.error}) — o prompt já está aplicado em ${file}.`);
    return false;
  }
  return true;
}

/**
 * Erro do gate do handoff (IMPL-027): exit GATE_BLOCKED, `error.code`
 * específico do bloqueio e a evidência inteira em `details`.
 */
function handoffBlockedError(record: SessionRecord, file: string, guards: HandoffGuardReport): CliError {
  const code =
    guards.blocks.length === 1 ? `handoff.${guards.blocks[0].code.replace(/\./g, '_')}` : 'handoff.blocked';
  return new CliError(
    `Handoff bloqueado: ${guards.blocks.map((b) => b.message).join(' ')} Nada foi gravado em ${file}.`,
    EXIT.GATE_BLOCKED,
    {
      sessionId: record.id,
      file,
      applied: false,
      blocks: guards.blocks,
      warnings: guards.warnings,
      holdout: record.holdout ?? null,
      significance: record.significance ?? null,
      judgeDrift: Boolean(record.judgeDrift),
      auditLog: handoffAuditPath(),
    },
    {
      code,
      hint:
        'Não promova este campeão: treine de novo (mais --stages, outro --holdout-ratio) ou mantenha o prompt atual. ' +
        `Se uma pessoa decidiu promover mesmo assim, repita com --override "<motivo>" — o motivo fica gravado em ${handoffAuditPath()}.`,
    },
  );
}

/**
 * Aplica o prompt campeão em `destino`: backup `<destino>.bak-<ISO-ts>` quando o
 * arquivo existe, escrita com `\n` final, diff do que mudou e commit opcional.
 *
 * Exige o laudo do gate e RECUSA antes de qualquer efeito (nem o diretório é
 * criado) quando ele está bloqueado: é o único escritor do handoff, então
 * nenhum caminho futuro aplica um campeão regredido sem passar por aqui.
 */
async function applyPromptFile(
  destino: string,
  prompt: string,
  opts: { commit: boolean; record: SessionRecord; guards: HandoffGuardReport; out: Output },
): Promise<ApplyReport> {
  const { out } = opts;
  const file = path.resolve(destino);
  if (opts.guards.blocked) throw handoffBlockedError(opts.record, file, opts.guards);
  await fs.mkdir(path.dirname(file), { recursive: true });

  let backup: string | null = null;
  const existia = await fs
    .access(file)
    .then(() => true)
    .catch(() => false);
  if (existia) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backup = `${file}.bak-${ts}`;
    await fs.copyFile(file, backup);
  }

  await fs.writeFile(file, prompt.endsWith('\n') ? prompt : `${prompt}\n`, 'utf-8');

  // Diff no stdout (payload de texto); fora do formato text o report do --json
  // é que carrega o resultado — nada de sujar o JSON com diff.
  if (backup) {
    const diff = gitNoIndexDiff(backup, file);
    if (diff.ok) {
      if (diff.out.trim()) out.line(diff.out.replace(/\n+$/, ''));
    } else {
      out.warn(`não consegui gerar o diff: ${diff.error}`);
    }
  } else {
    out.line('(arquivo criado)');
  }

  const committed = opts.commit
    ? commitAppliedFile(file, opts.record.id, out, overrideTrailers(opts.guards.override))
    : false;
  return { applied: true, file, backup, committed };
}

export async function cmdSessions(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'list';
  const parsed = parse(sub === argv[0] ? argv.slice(1) : argv, {
    'prompt-only': { type: 'boolean' },
    limit: { type: 'string' },
    apply: { type: 'string' },
    commit: { type: 'boolean' },
    override: { type: 'string' },
  });
  const ctx = buildContext(parsed);
  const { out } = ctx;

  if (sub === 'list') {
    const rows = (await listSessions()).slice(0, Number(parsed.values.limit ?? 20));
    if (out.isText) {
      for (const r of rows) {
        out.line(
          `${r.id}  ${r.status.padEnd(8)} ${String(r.iterationsDone).padStart(2)}/${r.iterationsPlanned} it  ${fmtUsd(r.totalCostUsd).padStart(9)}  ${r.theme.slice(0, 40)}`,
        );
      }
    }
    out.result(true, 'sessions.list', { sessions: rows });
    return EXIT.OK;
  }

  const id = parsed.positionals[0];
  if (!id) throw new CliError(`Uso: prompt-builder sessions ${sub} <id>`, EXIT.USAGE);
  const record = await loadSession(id);
  if (!record) throw new CliError(`Sessão "${id}" não encontrada.`, EXIT.USAGE);
  const campeao = record.bestPromptByIteration.at(-1);

  if (sub === 'winner') {
    // Handoff versionado: --apply leva o campeão para um arquivo de produção,
    // com backup + diff + commit opcional (ver applyPromptFile acima) — e,
    // desde o IMPL-027, atrás de um GATE: holdout regredido bloqueia (exit
    // GATE_BLOCKED, destino intocado) salvo --override "<motivo>", que fica
    // gravado na trilha de auditoria e no trailer do commit.
    const applyRaw = parsed.values.apply;
    const applyTo = typeof applyRaw === 'string' ? applyRaw.trim() : undefined;
    const wantCommit = parsed.values.commit === true;
    const overrideRaw = parsed.values.override;
    if (typeof applyRaw === 'string' && !applyTo) {
      throw new CliError('--apply exige um caminho de arquivo.', EXIT.USAGE);
    }
    if (parsed.values['prompt-only'] === true && applyTo) {
      throw new CliError('Use --prompt-only OU --apply, nunca os dois.', EXIT.USAGE);
    }
    if (wantCommit && !applyTo) {
      throw new CliError('--commit só faz sentido junto de --apply <arquivo>.', EXIT.USAGE);
    }
    if (typeof overrideRaw === 'string' && !applyTo) {
      throw new CliError('--override só faz sentido junto de --apply <arquivo>.', EXIT.USAGE, undefined, {
        code: 'usage.override_without_apply',
        hint: 'Use `sessions winner <id> --apply <arquivo> --override "<motivo>"`.',
      });
    }
    const overrideReason = normalizeOverrideReason(typeof overrideRaw === 'string' ? overrideRaw : null);
    if (typeof overrideRaw === 'string' && !overrideReason) {
      // Motivo vazio não é override: sem isto `--override ""` sobreporia o
      // bloqueio sem justificativa nenhuma.
      throw new CliError('--override exige um motivo não vazio.', EXIT.USAGE, undefined, {
        code: 'usage.override_reason_required',
        hint: 'Diga por que promover mesmo assim: --override "<motivo>" (fica gravado na auditoria e no commit).',
      });
    }
    // O laudo é o mesmo para ver, imprimir e aplicar — só o --apply bloqueia.
    const guards = evaluateHandoffGuards(record, { overrideReason });
    if (parsed.values['prompt-only'] === true) {
      // Payload cru no stdout (costuma ir para `> arquivo`): bloquear aqui
      // truncaria o destino do redirecionamento. Só avisa — o handoff com
      // gate é o --apply.
      for (const i of [...guards.blocks, ...guards.warnings]) out.warn(i.message);
      if (guards.blocks.length > 0) {
        out.warn('--prompt-only não passa pelo gate do handoff: use --apply <arquivo> para promover.');
      }
      out.raw(campeao?.systemPrompt ?? '');
      return EXIT.OK;
    }
    if (applyTo) {
      const prompt = campeao?.systemPrompt;
      if (!campeao || !prompt || !prompt.trim()) {
        throw new CliError(`A sessão "${id}" não tem prompt campeão para aplicar.`, EXIT.ERROR);
      }
      const destino = path.resolve(applyTo);
      if (guards.blocked) {
        // A tentativa bloqueada também fica na trilha (o destino não é tocado).
        await appendHandoffAudit(
          buildHandoffAuditEntry(record, guards, {
            outcome: 'blocked',
            file: destino,
            backup: null,
            committed: false,
            prompt,
          }),
          out,
        );
        throw handoffBlockedError(record, destino, guards);
      }
      // Override sem registro não passa: a trilha precisa ser gravável ANTES
      // de o destino ser tocado.
      if (guards.override) await ensureHandoffAuditWritable();
      for (const w of guards.warnings) {
        // O override é parte do RESULTADO (quem lê só o stdout tem de vê-lo);
        // o resto é narração no stderr. Sob --json/ndjson ele vai no payload.
        if (w.code.startsWith('override.') && out.isText) out.line(`! ${w.message}`);
        else out.warn(w.message);
      }
      const report = await applyPromptFile(applyTo, prompt, {
        commit: wantCommit,
        record,
        guards,
        out,
      });
      const auditLog = await appendHandoffAudit(
        buildHandoffAuditEntry(record, guards, {
          outcome: 'applied',
          file: report.file,
          backup: report.backup,
          committed: report.committed,
          prompt,
        }),
        out,
      );
      out.info(
        `prompt aplicado em ${report.file}${report.backup ? ` (backup: ${report.backup})` : ''}`,
      );
      if (wantCommit) out.info(report.committed ? 'commit criado.' : 'commit não criado (ver aviso).');
      out.result(true, 'sessions.winner', {
        applied: report.applied,
        file: report.file,
        backup: report.backup,
        committed: report.committed,
        sessionId: record.id,
        override: guards.override,
        blocks: guards.blocks,
        warnings: guards.warnings,
        auditLog,
      });
      return EXIT.OK;
    }
    if (out.isText && campeao) {
      out.line(`campeão da iteração ${campeao.iteration + 1}: ${campeao.winnerContestantId}`);
      for (const i of [...guards.blocks, ...guards.warnings]) out.warn(i.message);
      if (guards.blocked) out.warn('--apply será BLOQUEADO para esta sessão (só passa com --override "<motivo>").');
      out.line();
      out.line(campeao.systemPrompt);
    }
    out.result(true, 'sessions.winner', {
      systemPrompt: campeao?.systemPrompt,
      iteration: campeao?.iteration,
      holdoutSkipped: Boolean(record.holdoutSkipped),
      holdout: record.holdout,
      significance: record.significance,
      judgeDrift: Boolean(record.judgeDrift),
      // Laudo do gate SEM aplicar: um agente decide antes de tentar o --apply.
      handoff: { wouldBlock: guards.blocked, blocks: guards.blocks, warnings: guards.warnings },
    });
    return EXIT.OK;
  }

  if (out.isText) {
    out.line(`${record.id}  ${record.status}`);
    out.line(`tema: ${record.config.theme}`);
    out.line(`iterações: ${record.bestPromptByIteration.length}/${record.config.iterations}`);
    // IMPL-002: gate de cada iteração — bruto × corrigido × p ajustado (max-T).
    for (const it of record.bestPromptByIteration) {
      if (it.gate) out.line(`  iteração ${it.iteration + 1}: ${formatIterationGate(it.gate)}`);
    }
    // IMPL-005: pareamento final (n nominal × efetivo) e significância.
    if (record.pairing) {
      out.line(`pareamento (${record.pairing.source}): ${formatPairCoverage(record.pairing)}`);
    }
    if (record.significance) out.line(`significância: ${formatSignificance(record.significance)}`);
    out.line();
    for (const l of renderSpend(record.costByRole, record.totalCostUsd, record.budgetUsd)) out.line(l);
  }
  out.result(true, 'sessions.show', { session: record });
  return EXIT.OK;
}

// --- techniques / lgpd / config / registry / doctor --------------------------

export async function cmdTechniques(argv: string[]): Promise<number> {
  const parsed = parse(argv, {});
  const ctx = buildContext(parsed);
  const techs = listTechniques();
  if (ctx.out.isText) {
    for (const t of techs) ctx.out.line(`${t.id.padEnd(16)} ${t.name} — ${t.good}`);
  }
  ctx.out.result(true, 'techniques', { techniques: techs });
  return EXIT.OK;
}

export async function cmdLgpd(argv: string[]): Promise<number> {
  const parsed = parse(argv, {});
  const ctx = buildContext(parsed);
  const data = getLgpdData();
  // IMPL-041: área sensível é FAIL-CLOSED (allowlist de endpoints ZDR); a
  // "geral" segue consultiva. O estado do snapshot vai junto.
  const health = allowlistHealth(data.allowlist);
  if (ctx.out.isText) {
    for (const a of data.areas) {
      ctx.out.line(`${a.id.padEnd(24)} ${a.label}${isSensitiveArea(a.id, data) ? '  [sensível: bloqueia fora da allowlist]' : ''}`);
    }
    ctx.out.info(`${health.message} Detalhes: \`prompt-builder models allowlist --check\`.`);
    // IMPL-042: o que a cascata de dado pessoal cobre (e o que NÃO cobre).
    ctx.out.info(
      'Dado pessoal: CPF/CNPJ/CNS (dígito verificador), RG, CEP, telefone, e-mail e CRM são pseudonimizados ' +
        'antes de TODA chamada de LLM; nomes/endereços em texto livre: não coberto. Dado de aparência real ' +
        'no config recusa a run até a revisão (`--allow-pii`); `--pii-mode synthetic` e o modo agente ' +
        'recusam sem exceção.',
    );
  }
  ctx.out.result(true, 'lgpd.areas', {
    areas: data.areas.map((a) => ({ ...a, sensivel: isSensitiveArea(a.id, data) })),
    allowlist: { state: health.state, usable: health.usable, dataGeracao: health.geradoEm ?? null, ageDays: health.ageDays ?? null },
    pii: { modes: PII_MODES, coverage: PII_COVERAGE },
  });
  return EXIT.OK;
}

export async function cmdConfig(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'validate';
  const parsed = parse(sub === argv[0] ? argv.slice(1) : argv, {
    mode: { type: 'string' },
    out: { type: 'string', short: 'o' },
  });
  const ctx = buildContext(parsed);
  const { out } = ctx;

  if (sub === 'example') {
    const mode = typeof parsed.values.mode === 'string' ? parsed.values.mode : 'train';
    const exemplo = {
      format: 'arena-config@1',
      mode: mode === 'train' ? 'training' : mode,
      theme: 'Assistente de suporte técnico de um SaaS de faturamento',
      scenarioBrief: 'Cubra dúvidas de cobrança, recusa de pedidos fora da política e extração de dados de faturas.',
      stages: 8,
      prompt: { text: 'Você é um assistente de suporte. Responda com base na política do produto.' },
      models: {
        datagen: 'openai/gpt-5-mini',
        judges: ['anthropic/claude-sonnet-5'],
        contestant: 'openai/gpt-5-mini',
      },
      effort: { judge: 'high', datagen: 'low' },
      variation: { optimize: true, techniques: ['persona', 'constraints', 'format'] },
      // minGain ausente = margem prática default max(1; 50/n) (IMPL-002).
      training: { iterations: 3, holdoutRatio: 0.2 },
      finalists: 3,
      limits: { maxOutputTokens: 600 },
    };
    const texto = JSON.stringify(exemplo, null, 2);
    if (typeof parsed.values.out === 'string') {
      await fs.writeFile(parsed.values.out, `${texto}\n`, 'utf-8');
      out.info(`exemplo gravado em ${parsed.values.out}`);
    } else {
      out.raw(`${texto}\n`);
    }
    return EXIT.OK;
  }

  const file = parsed.positionals[0];
  if (!file) throw new CliError('Uso: prompt-builder config validate <arquivo.json>', EXIT.USAGE);
  const json = await readJsonFile(file);
  const formato = (json as Record<string, unknown>)?.format;

  if (typeof formato === 'string') {
    const p = parseArenaConfig(json);
    if (!p.ok) throw new CliError(p.error, EXIT.CONFIG);
    for (const w of p.warnings ?? []) out.warn(w); // chave descontinuada (IMPL-012)
    const c = arenaConfigToRunConfig(p.config);
    if (!c.ok) throw new CliError(c.error, EXIT.CONFIG);
    // `scenarios.from: 'library'`: mesma resolução/checagem do `vary --config`.
    const config = await resolveArenaLibrary(p.config, c.config);
    out.info(`válido — ${arenaConfigSummary(p.config)}`);
    out.result(true, 'config.validate', { format: formato, config });
    return EXIT.OK;
  }
  const p = parseRunConfig(json);
  if (!p.ok) throw new CliError(p.error, EXIT.CONFIG, p.details);
  out.info('válido (RunConfig)');
  out.result(true, 'config.validate', { format: 'run-config', config: p.config });
  return EXIT.OK;
}

// --- registry (guarda de drift de prompts) -----------------------------------

export async function cmdRegistry(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'validate';
  const parsed = parse(sub === argv[0] ? argv.slice(1) : argv, {
    file: { type: 'string' },
    out: { type: 'string', short: 'o' },
  });
  const ctx = buildContext(parsed);
  const { out } = ctx;

  if (sub === 'init') {
    const alvo =
      typeof parsed.values.out === 'string' && parsed.values.out.trim()
        ? parsed.values.out.trim()
        : path.join(getDataDir(), 'prompt-registry.json');
    const existe = await fs
      .access(alvo)
      .then(() => true)
      .catch(() => false);
    if (existe) {
      // O registro é versionado junto com o código — nunca sobrescrever em silêncio.
      throw new CliError(`"${alvo}" já existe — não vou sobrescrever um registro.`, EXIT.CONFIG);
    }
    await fs.mkdir(path.dirname(alvo), { recursive: true });
    await fs.writeFile(alvo, exampleRegistryJson(), 'utf-8');
    out.info(`registro-exemplo gravado em ${alvo}`);
    out.result(true, 'registry.init', { file: alvo });
    return EXIT.OK;
  }

  if (sub !== 'validate') {
    throw new CliError(
      `Subcomando desconhecido: "${sub}". Uso: prompt-builder registry <validate|init>.`,
      EXIT.USAGE,
    );
  }

  const file =
    typeof parsed.values.file === 'string' && parsed.values.file.trim()
      ? path.resolve(parsed.values.file.trim())
      : path.join(getDataDir(), 'prompt-registry.json');

  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch {
    throw new CliError(
      `Registro "${file}" não encontrado ou ilegível. ` +
        'Crie um com `prompt-builder registry init -o <arquivo>`.',
      EXIT.CONFIG,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new CliError(`"${file}" não é um JSON válido: ${(err as Error).message}`, EXIT.CONFIG);
  }
  const p = parseRegistry(json);
  if (!p.ok) throw new CliError(p.error, EXIT.CONFIG);

  // A checagem de drift é PURA (src/registry.ts); aqui só se injeta a leitura
  // real. Caminhos relativos de `source.file` resolvem contra o diretório de
  // trabalho (o registro default mora no data-dir, o fonte mora no projeto).
  const report = validateRegistry(p.registry, (alvo) => {
    try {
      return readFileSync(path.resolve(alvo), 'utf-8');
    } catch {
      return undefined;
    }
  });

  if (out.isText) {
    out.line(`registro: ${file}`);
    out.line(
      `prompts: ${report.total} · ok: ${report.ok.length} · drift: ${report.drifted.length}`,
    );
    if (report.ok.length) {
      out.line();
      out.line('ok:');
      for (const pid of report.ok) out.line(`  ${pid}`);
    }
    if (report.drifted.length) {
      out.line();
      out.line('drift:');
      for (const d of report.drifted) out.line(`  ${d.id} — ${d.reason}`);
    }
  }
  // Drift = config: o registro não descreve mais o fonte de produção (exit 3).
  // Sai pelo envelope de erro (o relatório vai em `details`), não por um
  // `result` ok:false sem `error` (IMPL-028).
  if (report.drifted.length > 0) {
    throw new CliError(
      `${report.drifted.length} de ${report.total} prompt(s) com drift em ${file}.`,
      EXIT.CONFIG,
      { file, report },
      {
        code: 'registry.drift',
        hint: 'O fonte de produção mudou: reverta o prompt ou atualize o registro; o motivo de cada um está em details.report.drifted.',
      },
    );
  }
  out.result(true, 'registry.validate', { file, report });
  return EXIT.OK;
}

/**
 * Recomendações sobre o LIMITE DA KEY no OpenRouter (IMPL-031, R-12:DEC-5): é
 * a única camada anti-gasto que vale ENTRE MÁQUINAS e contra agente
 * desgovernado — o teto diário local só vê esta máquina. O OpenRouter aplica o
 * limite no servidor (`limit` em USD + `limit_reset`, o TIPO da janela:
 * daily/weekly/monthly; o diário zera às 00:00 UTC). Pura: testável sem rede.
 */
export function keyLimitAdvice(info: KeyInfo | null, localDailyCapUsd: number | null): string[] {
  if (!info) return [];
  const sugestao = localDailyCapUsd ?? DEFAULT_DAILY_CAP_USD;
  const onde = 'em https://openrouter.ai/settings/keys';
  if (info.limitUsd === null || info.limitUsd === undefined) {
    return [
      `A key NÃO tem limite de crédito: defina limit + limit_reset=daily ${onde} (ex.: US$ ${sugestao}/dia; ` +
        'o reset diário é 00:00 UTC). É a única camada que vale entre máquinas e contra um agente desgovernado — ' +
        'o teto diário local (`prompt-builder limits`) só enxerga esta máquina.',
    ];
  }
  const reset = info.limitReset ?? null;
  if (reset === null) {
    return [
      `A key tem limite de ${fmtUsd(info.limitUsd)} SEM reset (teto vitalício): esgotado, tudo para até alguém ` +
        `subir o limite. Prefira limit_reset=daily ${onde} — contém um estrago em 24 h e volta sozinho às 00:00 UTC.`,
    ];
  }
  if (reset !== 'daily') {
    return [
      `O limite da key reseta "${reset}": um agente desgovernado pode gastar a janela inteira num dia. ` +
        `limit_reset=daily ${onde} limita o estrago a 24 h (reset 00:00 UTC).`,
    ];
  }
  return [];
}

export async function cmdDoctor(argv: string[]): Promise<number> {
  const parsed = parse(argv, {});
  const ctx = buildContext(parsed);
  const { out, dataDir } = ctx;
  const checks: Record<string, unknown> = {
    node: process.version,
    dataDir: getDataDir(),
  };

  try {
    await fs.mkdir(path.join(getDataDir(), 'cache'), { recursive: true });
    checks.dataDirWritable = true;
  } catch (err) {
    checks.dataDirWritable = false;
    checks.dataDirError = (err as Error).message;
  }

  // Camadas locais anti-gasto-N× (IMPL-031): teto diário da máquina e runs
  // ativas (lock por config). Só disco. Teto INVÁLIDO (env ou limits.json) é
  // falha do doctor (exit 3, o mesmo `config.invalid_daily_cap` com que todo
  // compare/vary/train sai) — antes ele saía 0 com ok:true e a run quebrava.
  let capLocal: number | null = null;
  let falhaTeto: CliError | null = null;
  try {
    const cap = resolveDailyCap(dataDir);
    capLocal = cap.capUsd;
    const dia = readDailySnapshot(dataDir, cap);
    checks.dailyCap = {
      capUsd: cap.capUsd,
      source: cap.source,
      spentTodayUsd: dia.spentUsd,
      pendingUsd: dia.pendingUsd,
      remainingUsd: dia.remainingUsd,
      resetsAt: dia.resetsAt,
      processesToday: dia.processes,
    };
  } catch (err) {
    falhaTeto = toCliError(err);
    checks.dailyCap = `inválido: ${falhaTeto.message}`;
  }
  checks.activeRuns = listRunLocks(dataDir)
    .filter((l) => !l.stale)
    .map((l) => ({ pid: l.holder?.pid ?? null, command: l.holder?.command ?? null, runId: l.holder?.runId ?? l.holder?.sessionId ?? null }));

  // Key: ausente ou recusada = o doctor FALHA (exit 4); rede = exit 8. Antes
  // ele saía 0 com `ok:true` e "key: falhou: …" — um agente lia "saudável".
  let falha: CliError | null = null;
  let info: KeyInfo | null = null;
  try {
    const apiKey = await resolveKey(ctx.values);
    info = await checkKey(apiKey);
    checks.key = 'ok';
    checks.creditRemaining = info.limitRemainingUsd ?? null;
    checks.keyLimit = {
      limitUsd: info.limitUsd ?? null,
      limitRemainingUsd: info.limitRemainingUsd ?? null,
      limitReset: info.limitReset ?? null,
      usageDailyUsd: info.usageDailyUsd ?? null,
    };
    try {
      const cat = await loadCatalog(ctx, apiKey);
      checks.models = cat.models.length;
      checks.catalogSource = cat.catalogSource;
    } catch (err) {
      falha = toCliError(err);
      checks.models = `falhou: ${falha.message}`;
    }
  } catch (err) {
    falha = toCliError(err);
    checks.key = `falhou: ${falha.message}`;
  }

  const recomendacoes = keyLimitAdvice(info, capLocal);
  checks.recommendations = recomendacoes;

  if (out.isText) {
    for (const [k, v] of Object.entries(checks)) {
      if (k === 'recommendations') continue;
      out.line(`${k.padEnd(18)} ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`);
    }
    for (const r of recomendacoes) out.warn(r);
  }
  // Key/rede primeiro (4/8: sem eles nada roda); com a key boa, o teto
  // inválido ainda impede toda run — o doctor não pode dizer "saudável".
  if (!falha && falhaTeto) falha = falhaTeto;
  if (falha) {
    // O relatório inteiro vai em details: o agente vê o que passou e o que não.
    throw new CliError(falha.message, falha.code, { checks }, { code: falha.errorCode, hint: falha.hint });
  }
  out.result(true, 'doctor', checks);
  return EXIT.OK;
}
