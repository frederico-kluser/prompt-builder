// IMPL-098 (R-14c:REC-2) — `arena-agent-config@2` no CAMINHO DA RUN.
//
// O furo medido: o schema da TAREFA avulsa (`taskSchema.ts`) já tinha os campos
// @2, mas o arquivo da RUN (`configFile.ts`) continuava `arena-agent-config@1`:
// `agents run --config` com `agentTask { solution, testsDir, regression }` saía
// exit 3 `config.unknown_key` nos três, e `format: 'arena-agent-config@2'` dava
// "Arquivo não é uma configuração". Pior: `testsDir`/`regression[]` eram
// ignorados pela run e pelo oráculo — o isolamento "tests/ só depois do agente"
// só existia dentro do `task validate`. Aqui:
//
//   1. o @2 é aceito (e o @1 continua legível), com as MESMAS regras do schema
//      da tarefa (env.path relativo e testsDir absoluto/`../` recusados);
//   2. os campos novos sobrevivem aos DOIS parses (arquivo → RunConfig — o
//      `runConfigSchema` os descartava em silêncio);
//   3. o MESMO arquivo passa em `agents task validate` e em
//      `agents run --dry-run`;
//   4. na RUN: `tests/` ausente do workspace durante o agente, materializado no
//      verificador depois dele (o teste adulterado pelo agente não vale), e
//      `regression[]` roda como PASS_TO_PASS (quebrar zera a nota).
//
// Sem rede real, sem LLM pago, sem Docker: gateway/juiz falsos e git/sh locais.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ARENA_AGENT_CONFIG_FORMAT,
  ARENA_AGENT_CONFIG_FORMAT_V2,
  isArenaAgentConfigFormat,
  parseArenaAgentConfig,
} from '../src/configFile.js';
import { arenaAgentConfigToRunConfig } from '../src/arenaConfig.js';
import { cmdAgents, readAgentConfigFile } from '../src/cli/commands/agents.js';
import { EXIT, isCliError, resetOutputState, type CliError } from '../src/cli/output.js';
import { runAgentStage, type AgentGateway, type RunAgentStageParams } from '../src/agent/runAgentStage.js';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import type { AgentTaskSpec } from '../src/agent/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const DIGEST = `sha256:${'b'.repeat(64)}`;

let tmp = '';
let dirAnterior = '';
let gwAnterior: OpenRouterGateway;
let silencio: Array<{ mockRestore(): void }> = [];

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'pb-impl098-run-'));
  dirAnterior = getDataDir();
  setDataDir(tmp);
  // Catálogo e juiz FALSOS (o dry-run lê o catálogo; a run graduaria com o juiz).
  const f = fakeOpenRouter({
    catalog: ['acme/alpha', 'acme/beta', 'acme/judge'].map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: () => ({ text: '{"verdict":"resolve","explanation":"confere"}' }),
  });
  gwAnterior = setDefaultGateway(createGateway({ fetch: f.fetch, sleep: noSleep }));
  silencio = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
});

afterAll(() => {
  silencio.forEach((s) => s.mockRestore());
  setDefaultGateway(gwAnterior);
  setDataDir(dirAnterior);
  rmSync(tmp, { recursive: true, force: true });
});

/** arena-agent-config mínimo com um cenário cujo agentTask é `task`. */
function arquivo(task: Record<string, unknown>, format: string = ARENA_AGENT_CONFIG_FORMAT_V2): Record<string, unknown> {
  return {
    format,
    mode: 'compare',
    theme: 'Correção de bugs',
    agent: { executor: 'pi', executorVersion: '0.84.2', limits: { maxCostUsd: 0.2 } },
    models: { datagen: 'acme/judge', judges: ['acme/judge'], competitors: ['acme/alpha', 'acme/beta'] },
    scenarios: [{ question: 'Crie done.txt.', agentTask: task }],
  };
}

/** Tarefa @2 completa (válida para `task validate`: solution + checks). */
function tarefaV2(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    files: [{ path: 'seed.txt', content: 'base\n' }],
    verify: [{ cmd: 'sh check.sh', label: 'suite', critical: true }],
    regression: [{ cmd: 'test -f seed.txt', label: 'seed' }],
    solution: { kind: 'script', script: 'printf ok > done.txt' },
    testsDir: 'suites',
    env: { digest: DIGEST },
    metadata: { origin: 'teste', difficulty: 'easy', tags: ['impl-098'], canary: false },
    ...extra,
  };
}

/** Diretório com o arquivo de config + `suites/check.sh` ao lado. */
function mundo(nome: string, cfg: Record<string, unknown>): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmp, `${nome}-`));
  mkdirSync(path.join(dir, 'suites'));
  writeFileSync(path.join(dir, 'suites', 'check.sh'), 'test -f done.txt\n');
  const file = path.join(dir, 'arena.json');
  writeFileSync(file, JSON.stringify(cfg));
  return { dir, file };
}

// ===========================================================================
// 1–2. Schema do arquivo da run e os dois parses
// ===========================================================================

describe('IMPL-098 — arena-agent-config@2 no schema da RUN', () => {
  it('aceita @2 com solution/regression/testsDir/env/metadata; o @1 continua legível', () => {
    expect(isArenaAgentConfigFormat(ARENA_AGENT_CONFIG_FORMAT)).toBe(true);
    expect(isArenaAgentConfigFormat(ARENA_AGENT_CONFIG_FORMAT_V2)).toBe(true);
    expect(isArenaAgentConfigFormat('arena-agent-config@3')).toBe(false);
    const v2 = parseArenaAgentConfig(arquivo(tarefaV2()));
    expect(v2.ok, v2.ok ? '' : v2.error).toBe(true);
    const v1 = parseArenaAgentConfig(arquivo({ verify: [{ cmd: 'true' }] }, ARENA_AGENT_CONFIG_FORMAT));
    expect(v1.ok).toBe(true);
    // Aditivo: o @1 com os campos novos também lê (a tarefa validada roda).
    expect(parseArenaAgentConfig(arquivo(tarefaV2(), ARENA_AGENT_CONFIG_FORMAT)).ok).toBe(true);
    const outro = parseArenaAgentConfig(arquivo(tarefaV2(), 'arena-agent-config@9'));
    expect(outro.ok).toBe(false);
    if (!outro.ok) expect(outro.error).toContain('não é uma configuração');
  });

  it('mesmas regras do schema da tarefa: env.path relativo, testsDir absoluto ou com ../ são recusados', () => {
    const casos: Record<string, unknown>[] = [
      { env: { digest: DIGEST, path: 'locks/pkg.json' } },
      { env: { digest: 'latest' } },
      { testsDir: '/abs/suites' },
      { testsDir: '../fora' },
      { solution: { kind: 'patch', diff: 'x' } },
    ];
    for (const extra of casos) {
      const r = parseArenaAgentConfig(arquivo(tarefaV2(extra)));
      expect(r.ok, JSON.stringify(extra)).toBe(false);
    }
  });

  it('os campos novos sobrevivem ao RunConfig (o runConfigSchema os descartava em silêncio)', () => {
    const p = parseArenaAgentConfig(arquivo(tarefaV2()));
    if (!p.ok) throw new Error(p.error);
    const conv = arenaAgentConfigToRunConfig(p.config);
    if (!conv.ok) throw new Error(conv.error);
    const t = conv.config.customStages![0].agentTask!;
    expect(t.regression).toEqual([{ cmd: 'test -f seed.txt', label: 'seed' }]);
    expect(t.verify?.[0].critical).toBe(true);
    expect(t.solution).toEqual({ kind: 'script', script: 'printf ok > done.txt' });
    expect(t.testsDir).toBe('suites');
    expect(t.env).toEqual({ digest: DIGEST });
    expect(t.metadata).toMatchObject({ origin: 'teste', difficulty: 'easy', tags: ['impl-098'] });
  });

  it('readAgentConfigFile resolve o testsDir pelo diretório do ARQUIVO; ausente = exit 3', async () => {
    const { dir, file } = mundo('resolve', arquivo(tarefaV2()));
    const cfg = await readAgentConfigFile(file);
    expect(cfg.customStages![0].agentTask!.testsDir).toBe(path.join(dir, 'suites'));

    const semDir = path.join(dir, 'sem-suites.json');
    writeFileSync(semDir, JSON.stringify(arquivo(tarefaV2({ testsDir: 'nao-existe' }))));
    await expect(readAgentConfigFile(semDir)).rejects.toMatchObject({
      code: EXIT.CONFIG,
      errorCode: 'config.tests_dir_invalid',
    });
  });

  it('testsDir que é SYMLINK para fora do diretório da config é recusado (contenção por realpath)', async () => {
    const fora = mkdtempSync(path.join(tmp, 'fora-'));
    writeFileSync(path.join(fora, 'segredo.txt'), 'não deveria ir para o verificador\n');
    const dir = mkdtempSync(path.join(tmp, 'symlink-'));
    symlinkSync(fora, path.join(dir, 'suites'));
    const file = path.join(dir, 'arena.json');
    writeFileSync(file, JSON.stringify(arquivo(tarefaV2())));
    await expect(readAgentConfigFile(file)).rejects.toMatchObject({
      code: EXIT.CONFIG,
      errorCode: 'config.tests_dir_invalid',
    });
  });

  it('typo num check de regression é recusado (fail-closed), não descartado', async () => {
    const { file } = mundo('typo', arquivo(tarefaV2({ regression: [{ cmd: 'true', critcal: true }] })));
    await expect(readAgentConfigFile(file)).rejects.toMatchObject({ code: EXIT.CONFIG });
  });
});

// ===========================================================================
// 3. O MESMO arquivo passa em `task validate` e em `agents run --dry-run`
// ===========================================================================

async function cli(argv: string[]): Promise<{ exit: number; err?: CliError }> {
  resetOutputState();
  try {
    return { exit: await cmdAgents([...argv, '--json', '--data-dir', tmp, '--quiet']) };
  } catch (err) {
    if (!isCliError(err)) throw err;
    return { exit: (err as CliError).code, err: err as CliError };
  }
}

describe('IMPL-098 — um arquivo @2, dois comandos', { timeout: 60_000 }, () => {
  it('passa em `agents task validate` E em `agents run --dry-run` (antes: unknown_key na run)', async () => {
    const { file } = mundo('dois', arquivo(tarefaV2()));
    const validate = await cli(['task', 'validate', file, '--allow-exec-config']);
    expect(validate.exit, validate.err?.message).toBe(EXIT.OK);
    // Pinado pela validação (mesmo store, mesma identidade): o dry-run passa sem flag.
    const dry = await cli(['run', '--config', file, '--budget', '5', '--dry-run']);
    expect(dry.exit, dry.err?.message).toBe(EXIT.OK);
  });
});

// ===========================================================================
// 4. Caminho da RUN: isolamento do testsDir e regression[] como P2P
// ===========================================================================

type Passo = { write?: string[]; remove?: string[]; fakeTest?: boolean };

/** Executor injetado: registra se o material de teste estava visível e age no workspace. */
function gatewayFalso(passo: Passo, visto: { tests: boolean[] }): AgentGateway {
  return {
    id: 'pi-fake',
    prepare: async () => ({ bin: 'pi-fake', env: {} }),
    run: async (opts) => {
      visto.tests.push(existsSync(path.join(opts.workspaceDir, 'check.sh')));
      for (const f of passo.write ?? []) writeFileSync(path.join(opts.workspaceDir, f), 'ok\n');
      for (const f of passo.remove ?? []) rmSync(path.join(opts.workspaceDir, f), { force: true });
      // Agente trapaceiro: planta o "teste" que sempre passa.
      if (passo.fakeTest) writeFileSync(path.join(opts.workspaceDir, 'check.sh'), 'exit 0\n');
      const now = new Date().toISOString();
      const usage = { tokensIn: 1, tokensOut: 1, tokensReasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, costSource: 'agent-derived' as const };
      return {
        stopReason: 'completed',
        turns: 1,
        toolCalls: 0,
        durationMs: 1,
        usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
        trajectory: {
          format: 'agent-trajectory@1' as const,
          executor: { id: 'pi-fake', version: '0' },
          model: { provider: 'openrouter', id: opts.modelId ?? 'fake/a' },
          startedAt: now,
          finishedAt: now,
          durationMs: 1,
          stopReason: 'completed',
          turns: [{ index: 0, text: 'feito', steps: [] }],
          usage,
          parseErrors: 0,
          compactions: [],
        },
        parseErrors: 0,
        responseIds: [],
        stderrTail: '',
        exitCode: 0,
        signal: null,
      } as never;
    },
  };
}

let seq = 0;
function params(task: AgentTaskSpec, gateway: AgentGateway): RunAgentStageParams {
  return {
    runId: 'run-impl098',
    stageIndex: seq++,
    contestant: { id: 'ag', label: 'ag', modelId: 'acme/alpha', runner: 'agent' },
    stage: { question: 'crie done.txt', productContext: 'repo', maxTokens: 500, agentTask: task },
    agentConfig: { executor: 'pi', executorVersion: '0.0.0-fake', limits: { maxCostUsd: 0.05 } },
    apiKey: KEY,
    ctx: {},
    dataDir: tmp,
    catalog: [],
    judgeModelIds: ['acme/judge'],
    gateway,
  };
}

describe('IMPL-098 — run: tests/ só DEPOIS do agente e regression[] como PASS_TO_PASS', { timeout: 60_000 }, () => {
  let suites = '';
  beforeAll(() => {
    suites = mkdtempSync(path.join(tmp, 'suites-'));
    writeFileSync(path.join(suites, 'check.sh'), 'test -f done.txt\n');
  });

  const task = (): AgentTaskSpec => ({
    files: [{ path: 'seed.txt', content: 'base\n' }],
    verify: [{ cmd: 'sh check.sh', label: 'suite' }],
    regression: [{ cmd: 'test ! -e broken.txt', label: 'intacto' }],
    testsDir: suites,
  });

  it('o agente NÃO vê o teste; o verificador o recebe depois e a nota sai do teste real', async () => {
    const visto = { tests: [] as boolean[] };
    const res = await runAgentStage(params(task(), gatewayFalso({ write: ['done.txt'] }, visto)));
    expect(visto.tests).toEqual([false]);
    const rep = res.repResults[0];
    expect(rep.oracle?.checks.map((c) => [c.label, c.ok, c.kind ?? 'fail_to_pass'])).toEqual([
      ['suite', true, 'fail_to_pass'],
      ['intacto', true, 'pass_to_pass'],
    ]);
    expect(rep.oracle?.score).toBe(1);
    expect(rep.verdict).toBe('resolve');
  });

  it('teste plantado pelo agente não vale: o verificador reescreve o material prístino', async () => {
    const visto = { tests: [] as boolean[] };
    const res = await runAgentStage(params(task(), gatewayFalso({ fakeTest: true }, visto)));
    const rep = res.repResults[0];
    expect(rep.oracle?.checks[0]).toMatchObject({ label: 'suite', ok: false });
    expect(rep.oracle?.score).toBe(0);
    expect(rep.verdict).toBe('nao');
  });

  it('regressão quebrada (PASS_TO_PASS) zera a nota mesmo com o F2P passando', async () => {
    const visto = { tests: [] as boolean[] };
    // (`files[]` são reescritos prístinos no verificador; a regressão é o que o agente QUEBRA.)
    const res = await runAgentStage(params(task(), gatewayFalso({ write: ['done.txt', 'broken.txt'] }, visto)));
    const rep = res.repResults[0];
    expect(rep.oracle?.checks.map((c) => c.ok)).toEqual([true, false]);
    expect(rep.oracle?.p2p?.broken).toBe(true);
    expect(rep.oracle?.score).toBe(0);
  });

  it('testsDir RELATIVO (config sem diretório de origem) é recusado ANTES de executar o agente', async () => {
    const visto = { tests: [] as boolean[] };
    const res = await runAgentStage(params({ ...task(), testsDir: 'suites' }, gatewayFalso({ write: ['done.txt'] }, visto)));
    expect(visto.tests).toEqual([]); // o executor nem foi chamado
    expect(res.errorMsg).toContain('testsDir');
    expect(res.repResults.every((r) => r.verdict !== 'resolve')).toBe(true);
  });
});
