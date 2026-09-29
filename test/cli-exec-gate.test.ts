// IMPL-099 (R-15:REC-6) — portão explícito para config EXECUTÁVEL + contenção
// de `files[]` ao workspace:
//   1. E6: `files[]` com '../fora.txt' ou caminho ABSOLUTO é rejeitado por
//      VALIDAÇÃO com exit 3 (antes o writeFileNoFollow só barra na escrita);
//   2. config sem aceite de hash é RECUSADO com instrução exata de aprovar;
//   3. config alterado depois de aprovado é RECUSADO (hash mudou ⇒ revisão
//      revive);
//   4. a pin SHA-256 é ÚNICA por conteúdo: aprovou uma vez, o MESMO conteúdo
//      passa sem flag;
//   5. `run_agent_benchmark` (MCP) passa pelo MESMO portão — sem portão não
//      executa (critério do item).
//
// Tudo offline: gateway em porta fechada, data-dir temporário.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeOrTsx } from './support/cli.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, isCliError, resetOutputState, type CliError } from '../src/cli/output.js';
import {
  checkExecConfigApproval,
  cmdAgents,
  ensureExecConfigApproved,
  readAgentConfigFile,
  sha256Hex,
} from '../src/cli/commands/agents.js';
import { McpSession } from '../src/cli/commands/mcp.js';
import { getDataDir, setDataDir } from '../src/storage.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { cmd: TSX, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));
const DEAD_BASE = 'http://127.0.0.1:9/api/v1';
const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

let home = '';

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'pb-exec-gate-'));
});

afterAll(() => {
  if (home) rmSync(home, { force: true, recursive: true });
});

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): CliRun {
  const env: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: home, OPENROUTER_BASE_URL: DEAD_BASE };
  delete env.OPENROUTER_API_KEY;
  const r = spawnSync(TSX, [ENTRY, ...args], { env, encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** arena-agent-config@1 mínimo e válido (mesma forma da paridade dry-run). */
function agentConfig(files: { path: string; content: string }[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'arena-agent-config@1',
    mode: 'compare',
    theme: 'Correção de bugs',
    agent: { executor: 'pi', executorVersion: '0.84.2', limits: { maxCostUsd: 0.2 } },
    models: { datagen: 'acme/judge', judges: ['acme/judge'], competitors: ['acme/alpha', 'acme/beta'] },
    scenarios: [{ question: 'Conserte o parser.', agentTask: { files } }],
    ...extra,
  };
}

function grava(nome: string, json: unknown): string {
  const file = path.join(home, nome);
  writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json));
  return file;
}

// ---------------------------------------------------------------------------
// 1. E6 — files[] contido ao workspace
// ---------------------------------------------------------------------------

describe('E6: files[] fora do workspace é rejeitado por validação (exit 3)', { timeout: 120_000 }, () => {
  it("files[] com '../fora.txt' sai exit 3 antes de executar qualquer coisa", () => {
    const file = grava('e6-ponto-ponto.json', agentConfig([{ path: '../fora.txt', content: 'x' }]));
    const r = cli(['agents', 'run', '--config', file, '--budget', '5', '--json']);
    expect(r.status).toBe(EXIT.CONFIG);
    const env = JSON.parse(r.stdout) as { error: { code: string; kind: string; message: string } };
    expect(env.error.code).toBe('config.files_path_escapes_workspace');
    expect(env.error.kind).toBe('config');
    expect(env.error.message).toContain('../fora.txt');
  });

  it('files[] com caminho ABSOLUTO também sai exit 3', () => {
    const file = grava('e6-absoluto.json', agentConfig([{ path: '/tmp/fora.txt', content: 'x' }]));
    const r = cli(['agents', 'run', '--config', file, '--budget', '5', '--json']);
    expect(r.status).toBe(EXIT.CONFIG);
    const env = JSON.parse(r.stdout) as { error: { code: string } };
    expect(env.error.code).toBe('config.files_path_escapes_workspace');
  });

  it('files[] relativo dentro do workspace passa (contenção não é proibição)', async () => {
    const file = grava('e6-ok.json', agentConfig([{ path: 'src/a.ts', content: 'x' }]));
    await expect(readAgentConfigFile(file)).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2–4. Flag + pin SHA-256 (aprovação única por conteúdo)
// ---------------------------------------------------------------------------

describe('config sem aceite de hash é recusado; conteúdo mudo revive a revisão', { timeout: 120_000 }, () => {
  it('sem --allow-exec-config e sem pin: recusa com instrução de aprovar', () => {
    const file = grava('gate-sem-aceite.json', agentConfig([{ path: 'a.ts', content: 'x' }]));
    const r = cli(['agents', 'run', '--config', file, '--budget', '5', '--key', KEY, '--json']);
    expect(r.status).toBe(EXIT.CONFIG);
    const env = JSON.parse(r.stdout) as { error: { code: string; hint: string } };
    expect(env.error.code).toBe('config.exec_not_approved');
    expect(env.error.hint).toContain('--allow-exec-config');
  });

  it('config APROVADO e depois ALTERADO é recusado (hash mudou)', () => {
    const file = grava('gate-mudou.json', agentConfig([{ path: 'a.ts', content: 'x' }]));
    // Pin gravado para OUTRO conteúdo do MESMO arquivo (a revisão revive).
    writeFileSync(
      path.join(home, 'exec-config-approvals.json'),
      JSON.stringify({
        version: 1,
        approvals: {
          [sha256Hex('conteúdo antigo já aprovado')]: {
            identity: path.resolve(file),
            approvedAt: '2026-09-01T00:00:00.000Z',
            command: 'agents run --config …',
          },
        },
      }),
    );
    const r = cli(['agents', 'run', '--config', file, '--budget', '5', '--key', KEY, '--json']);
    expect(r.status).toBe(EXIT.CONFIG);
    const env = JSON.parse(r.stdout) as { error: { code: string; hint: string } };
    expect(env.error.code).toBe('config.exec_hash_changed');
    expect(env.error.hint).toContain('--allow-exec-config');
    rmSync(path.join(home, 'exec-config-approvals.json'), { force: true });
  });

  it('pin: aprovação única por conteúdo (unidade do portão)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pb-exec-pin-'));
    // O store mora no data-dir ATIVO (mesma semântica do `key set`).
    const anterior = getDataDir();
    setDataDir(dir);
    try {
      const base = {
        dataDir: dir,
        identity: '/tmp/config.json',
        label: 'config.json',
        command: 'agents run --config config.json',
      };
      // 1. sem aceite e sem pin ⇒ recusa
      await expect(ensureExecConfigApproved({ ...base, content: 'v1', allowExecConfig: false })).rejects.toMatchObject({
        errorCode: 'config.exec_not_approved',
      });
      // 2. aceite explícito grava o pin (primeira aprovação)
      const a1 = await ensureExecConfigApproved({ ...base, content: 'v1', allowExecConfig: true });
      expect(a1.firstApproval).toBe(true);
      expect(a1.hash).toBe(sha256Hex('v1'));
      expect(existsSync(path.join(dir, 'exec-config-approvals.json'))).toBe(true);
      // 3. MESMO conteúdo passa SEM flag (aprovação única)
      const a2 = await ensureExecConfigApproved({ ...base, content: 'v1', allowExecConfig: false });
      expect(a2.firstApproval).toBe(false);
      // 4. conteúdo ALTERADO sem flag ⇒ revisão revive
      await expect(ensureExecConfigApproved({ ...base, content: 'v2', allowExecConfig: false })).rejects.toMatchObject({
        errorCode: 'config.exec_hash_changed',
      });
      // 5. conteúdo alterado COM flag ⇒ novo pin (e o antigo continua lá)
      const a3 = await ensureExecConfigApproved({ ...base, content: 'v2', allowExecConfig: true });
      expect(a3.firstApproval).toBe(true);
      const store = JSON.parse(readFileSync(path.join(dir, 'exec-config-approvals.json'), 'utf-8')) as {
        approvals: Record<string, { identity: string }>;
      };
      expect(Object.keys(store.approvals)).toHaveLength(2);
      expect(store.approvals[sha256Hex('v1')].identity).toBe('/tmp/config.json');
    } finally {
      setDataDir(anterior);
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. A tool MCP passa pelo MESMO portão
// ---------------------------------------------------------------------------

interface ToolText {
  content?: { type: string; text: string }[];
}

describe('MCP: run_agent_benchmark sem portão não executa', { timeout: 60_000 }, () => {
  it('recusa sem allowExecConfig; com o portão passa; o pin persiste; muda ⇒ revisão', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pb-exec-mcp-'));
    setDataDir(dir);
    const saidas: Record<string, unknown>[] = [];
    const s = new McpSession({
      write: (m) => saidas.push(m),
      log: () => undefined,
      getKey: async () => KEY,
      graceMs: 2_000,
    });
    let seq = 0;
    const chamar = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const id = `g-${++seq}`;
      s.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'run_agent_benchmark', arguments: args } }));
      const fim = Date.now() + 10_000;
      for (;;) {
        const m = saidas.find((x) => (x as { id?: unknown }).id === id) as { result?: ToolText } | undefined;
        if (m) {
          try {
            return JSON.parse(m.result?.content?.[0]?.text ?? '') as Record<string, unknown>;
          } catch {
            return { semJson: true };
          }
        }
        if (Date.now() > fim) throw new Error('timeout na tool run_agent_benchmark');
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    try {
      s.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18' } }));

      const cfg = agentConfig([{ path: 'a.ts', content: 'x' }]);
      const cfgJson = JSON.stringify(cfg);

      // (a) SEM portão ⇒ NÃO executa (recusa estruturada do MESMO portão do CLI)
      const semPortao = await chamar({ config: cfgJson, budgetUsd: 1 });
      expect(semPortao.ok).toBe(false);
      expect(semPortao.code).toBe('config.exec_not_approved');
      expect(String(semPortao.hint)).toContain('allowExecConfig');

      // (b) COM allowExecConfig ⇒ passa o portão (o recuso seguinte é de budget:
      //     budgetUsd 0 é recusado DEPOIS do portão — nada é executado)
      const comAceite = await chamar({ config: cfgJson, budgetUsd: 0, allowExecConfig: true });
      expect(comAceite.ok).toBe(false);
      expect(String(comAceite.error)).toContain('budgetUsd');
      expect(comAceite.code).toBeUndefined(); // não foi o portão que recusou

      // (c) o pin persiste: MESMO conteúdo sem flag volta a passar o portão
      const pinado = await chamar({ config: cfgJson, budgetUsd: 0 });
      expect(pinado.ok).toBe(false);
      expect(String(pinado.error)).toContain('budgetUsd');

      // (d) conteúdo ALTERADO sem flag ⇒ a revisão revive
      const mudou = await chamar({ config: JSON.stringify(agentConfig([{ path: 'a.ts', content: 'OUTRO' }])), budgetUsd: 0 });
      expect(mudou.ok).toBe(false);
      expect(mudou.code).toBe('config.exec_hash_changed');
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 6. cli#6 / skill-install#6 — o `--dry-run` recusa com o MESMO error.code/exit
//    da execução real (paridade documentada: "exit 0 = a run real passaria").
//    Antes: dry-run exit 0 com wouldRefuse [] e a real exit 3
//    `config.exec_not_approved`. E o dry-run NUNCA pina (nem com a flag).
// ---------------------------------------------------------------------------

function cliEm(dir: string, args: string[]): CliRun {
  const env: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: dir, OPENROUTER_BASE_URL: DEAD_BASE };
  delete env.OPENROUTER_API_KEY;
  const r = spawnSync(TSX, [ENTRY, ...args], { env, encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

interface Envelope {
  ok: boolean;
  data?: { wouldRefuse: { code: string; exit: number }[]; checks: { execConfig: string } };
  error?: {
    code: string;
    kind: string;
    hint: string;
    details: { wouldRefuse: { code: string }[]; checks: { execConfig: string } };
  };
}

describe('cli#6: `agents run --dry-run` espelha o portão de config executável', { timeout: 180_000 }, () => {
  it('sem pin e sem flag: dry-run e real recusam com config.exec_not_approved (exit 3) e nada é pinado', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pb-exec-dry-'));
    try {
      const file = path.join(dir, 'agent.json');
      writeFileSync(file, JSON.stringify(agentConfig([{ path: 'a.ts', content: 'x' }])));
      const dry = cliEm(dir, ['agents', 'run', '--config', file, '--budget', '5', '--dry-run', '--json']);
      const real = cliEm(dir, ['agents', 'run', '--config', file, '--budget', '5', '--key', KEY, '--json']);
      const envDry = JSON.parse(dry.stdout) as Envelope;
      const envReal = JSON.parse(real.stdout) as Envelope;
      expect(dry.status, dry.stderr).toBe(EXIT.CONFIG);
      expect(envDry.error?.code).toBe('config.exec_not_approved');
      expect(envDry.error?.hint).toContain('--allow-exec-config');
      expect(envDry.error?.details.wouldRefuse.map((w) => w.code)).toEqual(['config.exec_not_approved']);
      expect(envDry.error?.details.checks.execConfig).toBe('not_approved');
      // Paridade: MESMO código e MESMO exit da execução real.
      expect(real.status).toBe(dry.status);
      expect(envReal.error?.code).toBe(envDry.error?.code);
      // O dry-run é só leitura: nenhum pin nasceu.
      expect(existsSync(path.join(dir, 'exec-config-approvals.json'))).toBe(false);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('com --allow-exec-config: dry-run passa (would_approve) SEM gravar o pin; pinado, passa sem flag (approved)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pb-exec-dry-'));
    try {
      const file = path.join(dir, 'agent.json');
      const texto = JSON.stringify(agentConfig([{ path: 'a.ts', content: 'x' }]));
      writeFileSync(file, texto);
      const comFlag = cliEm(dir, ['agents', 'run', '--config', file, '--budget', '5', '--dry-run', '--allow-exec-config', '--json']);
      expect(comFlag.status, comFlag.stderr).toBe(EXIT.OK);
      const env = JSON.parse(comFlag.stdout) as Envelope;
      expect(env.data?.wouldRefuse).toEqual([]);
      expect(env.data?.checks.execConfig).toBe('would_approve');
      expect(existsSync(path.join(dir, 'exec-config-approvals.json'))).toBe(false);

      // Aprovação real (a MESMA que o `agents run --allow-exec-config` grava; o
      // store mora no data-dir ATIVO).
      const anterior = getDataDir();
      setDataDir(dir);
      try {
        await ensureExecConfigApproved({
          dataDir: dir,
          content: texto,
          identity: path.resolve(file),
          label: file,
          command: `agents run --config ${file}`,
          allowExecConfig: true,
        });
      } finally {
        setDataDir(anterior);
      }
      const pinado = cliEm(dir, ['agents', 'run', '--config', file, '--budget', '5', '--dry-run', '--json']);
      expect(pinado.status, pinado.stderr).toBe(EXIT.OK);
      expect((JSON.parse(pinado.stdout) as Envelope).data?.checks.execConfig).toBe('approved');

      // Conteúdo mudou depois do pin ⇒ o dry-run recusa com exec_hash_changed (como a real).
      writeFileSync(file, JSON.stringify(agentConfig([{ path: 'a.ts', content: 'OUTRO' }])));
      const mudou = cliEm(dir, ['agents', 'run', '--config', file, '--budget', '5', '--dry-run', '--json']);
      const real = cliEm(dir, ['agents', 'run', '--config', file, '--budget', '5', '--key', KEY, '--json']);
      expect(mudou.status).toBe(EXIT.CONFIG);
      expect((JSON.parse(mudou.stdout) as Envelope).error?.code).toBe('config.exec_hash_changed');
      expect(real.status).toBe(mudou.status);
      expect((JSON.parse(real.stdout) as Envelope).error?.code).toBe('config.exec_hash_changed');
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('ordem das recusas = a da real: orçamento ausente vem ANTES do portão', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pb-exec-dry-'));
    try {
      const file = path.join(dir, 'agent.json');
      writeFileSync(file, JSON.stringify(agentConfig([{ path: 'a.ts', content: 'x' }])));
      const dry = cliEm(dir, ['agents', 'run', '--config', file, '--dry-run', '--json']);
      const env = JSON.parse(dry.stdout) as Envelope;
      expect(env.error?.code).toBe('usage.budget_required');
      expect(env.error?.details.wouldRefuse.map((w) => w.code)).toEqual([
        'usage.budget_required',
        'config.exec_not_approved',
      ]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('checkExecConfigApproval é só leitura e decide igual ao ensureExecConfigApproved', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pb-exec-check-'));
    const anterior = getDataDir();
    setDataDir(dir);
    try {
      const base = { dataDir: dir, identity: '/x/c.json', label: 'c.json', command: 'agents run --config c.json' };
      const semFlag = await checkExecConfigApproval({ ...base, content: 'v1', allowExecConfig: false });
      expect(semFlag.state).toBe('not_approved');
      expect(semFlag.refusal?.errorCode).toBe('config.exec_not_approved');
      const comFlag = await checkExecConfigApproval({ ...base, content: 'v1', allowExecConfig: true });
      expect(comFlag).toMatchObject({ state: 'would_approve', refusal: null, hash: sha256Hex('v1') });
      expect(existsSync(path.join(dir, 'exec-config-approvals.json'))).toBe(false);
      await ensureExecConfigApproved({ ...base, content: 'v1', allowExecConfig: true });
      expect((await checkExecConfigApproval({ ...base, content: 'v1', allowExecConfig: false })).state).toBe('approved');
      const mudou = await checkExecConfigApproval({ ...base, content: 'v2', allowExecConfig: false });
      expect(mudou.refusal?.errorCode).toBe('config.exec_hash_changed');
    } finally {
      setDataDir(anterior);
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 7. IMPL-099 — `agents task validate` EXECUTA setup[]/solution/checks no host:
//    passa pelo MESMO portão (flag + pin SHA-256), e o hash cobre o testsDir.
//    Antes: rodava `setup[]` arbitrário sem flag nem pin (marcador criado).
// ---------------------------------------------------------------------------

describe('IMPL-099: `agents task validate` passa pelo portão de config executável', { timeout: 120_000 }, () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pb-exec-validate-'));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { force: true, recursive: true });
  });

  async function validate(file: string, extra: string[] = []): Promise<{ exit: number; err?: CliError }> {
    resetOutputState();
    try {
      return { exit: await cmdAgents(['task', 'validate', file, '--json', '--data-dir', dir, '--quiet', ...extra]) };
    } catch (err) {
      if (!isCliError(err)) throw err;
      return { exit: err.code, err };
    }
  }

  /** Tarefa VÁLIDA cujo setup[] deixa um marcador FORA do workspace (prova de execução). */
  function tarefa(marker: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      agentTask: {
        setup: [{ cmd: `touch ${marker}` }],
        verify: [{ cmd: 'test -f done.txt', label: 'done' }],
        solution: { kind: 'script', script: 'printf ok > done.txt' },
        ...extra,
      },
    };
  }

  it('sem --allow-exec-config e sem pin: exit 3 config.exec_not_approved e o setup NÃO roda', async () => {
    const marker = path.join(dir, 'PWNED-1');
    const file = path.join(dir, 'task-1.json');
    writeFileSync(file, JSON.stringify(tarefa(marker)));
    const r = await validate(file);
    expect(r.exit).toBe(EXIT.CONFIG);
    expect(r.err?.errorCode).toBe('config.exec_not_approved');
    expect(r.err?.hint).toContain('agents task validate');
    expect(r.err?.hint).toContain('--allow-exec-config');
    expect(existsSync(marker)).toBe(false);
  });

  it('com a flag: roda (marcador criado) e pina; o MESMO conteúdo passa sem flag depois', async () => {
    const marker = path.join(dir, 'PWNED-2');
    const file = path.join(dir, 'task-2.json');
    writeFileSync(file, JSON.stringify(tarefa(marker)));
    expect((await validate(file, ['--allow-exec-config'])).exit).toBe(EXIT.OK);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker, { force: true });
    expect((await validate(file)).exit).toBe(EXIT.OK);
    expect(existsSync(marker)).toBe(true);
  });

  it('o hash cobre o testsDir: trocar um arquivo de teste depois do aceite revive a revisão', async () => {
    const sub = mkdtempSync(path.join(dir, 'td-'));
    mkdirSync(path.join(sub, 'suites'));
    writeFileSync(path.join(sub, 'suites', 'check.sh'), 'test -f done.txt\n');
    const marker = path.join(sub, 'PWNED-3');
    const file = path.join(sub, 'task.json');
    writeFileSync(
      file,
      JSON.stringify(tarefa(marker, { testsDir: 'suites', verify: [{ cmd: 'sh check.sh', label: 'suite' }] })),
    );
    expect((await validate(file, ['--allow-exec-config'])).exit).toBe(EXIT.OK);
    // Só o teste muda (o JSON é o mesmo) — e o teste também EXECUTA.
    writeFileSync(path.join(sub, 'suites', 'check.sh'), `touch ${marker}-teste; exit 0\n`);
    rmSync(marker, { force: true });
    const r = await validate(file);
    expect(r.exit).toBe(EXIT.CONFIG);
    expect(r.err?.errorCode).toBe('config.exec_hash_changed');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(`${marker}-teste`)).toBe(false);
  });

  it('env mínimo: o setup[] aprovado não herda a key do OpenRouter do processo', async () => {
    const dump = path.join(dir, 'env-dump.txt');
    const file = path.join(dir, 'task-env.json');
    writeFileSync(
      file,
      JSON.stringify({
        agentTask: {
          setup: [{ cmd: `sh -c "env > ${dump}"` }],
          verify: [{ cmd: 'test -f done.txt', label: 'done' }],
          solution: { kind: 'script', script: 'printf ok > done.txt' },
        },
      }),
    );
    const anterior = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = KEY;
    try {
      expect((await validate(file, ['--allow-exec-config'])).exit).toBe(EXIT.OK);
    } finally {
      if (anterior === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = anterior;
    }
    const env = readFileSync(dump, 'utf-8');
    expect(env).not.toContain('OPENROUTER_API_KEY');
    expect(env).not.toContain(KEY);
  });
});
