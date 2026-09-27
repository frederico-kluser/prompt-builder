// Testes de CONTRATO do sandbox endurecido do modo agente (IMPL-036 / R-15 REC-1).
//
// Duas camadas:
//   1. Puras (rodam em qualquer máquina): o perfil FIXO de flags do `docker run`,
//      a recusa de imagem por tag, o `argv.json` com o digest sha256, a válvula de
//      rede do operador, o rebaixamento de "erro do provedor" para erro de infra
//      (`infraError` → repetição SEM veredito, nunca `nao`), o schema de
//      `isolation.runtime` e — com um `docker` FALSO no PATH — o `--cpus` pelas CPUs
//      do DAEMON e o runtime chegando à validação da imagem e ao selfTest.
//   2. Docker real (só quando o daemon responde E a imagem já está no daemon —
//      NUNCA puxa nem builda): `docker inspect` de uma execução REAL do pi em modo
//      container, `/proc/1/status` do processo do agente (o que o amicontained
//      reporta: 0 capabilities, seccomp em modo filtro, no_new_privs) e o
//      mapeamento de escrita (rootfs read-only; /tmp, /ws, /exec/{session,pi-home}
//      graváveis). Nenhuma chamada paga: a key é FALSA e a rede é `none`.
//      `PB_SKIP_DOCKER_TESTS=1` desliga esta camada.

import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertDockerRuntime,
  buildDockerArgv,
  buildSandboxRunArgv,
  CONTAINER_EXEC_DIR,
  CONTAINER_PI_HOME_DIR,
  CONTAINER_SESSION_DIR,
  CONTAINER_WS_DIR,
  containerAuditRecord,
  containerUser,
  dockerDaemonCpus,
  ENV_FILE_MASK,
  ENV_FILE_PREFIX,
  ensurePiImage,
  hardeningFlags,
  hardeningProfile,
  HARDENING_PROFILE_VERSION,
  isDigestRef,
  parseDockerNcpu,
  parseDockerRuntimes,
  parseImageInspect,
  resolveContainerNetwork,
  resolveImageDigest,
  sandboxNetworkHint,
  sandboxProfile,
  UNSAFE_NETWORK_ENV,
} from '../src/agent/container.js';
import { runCleanRoomCanary, runPreflight } from '../src/agent/doctor.js';
import { runAgentStage, type RunAgentStageParams } from '../src/agent/runAgentStage.js';
import { doctorIsolation } from '../src/cli/commands/agents.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import type { RunConfig } from '../src/types.js';
import type { AgentRunOpts, AgentRunOutcome } from '../src/agent/executor.js';
import { piExecutor, piProviderError, type PiRunOptions, type PiRunOutcome } from '../src/agent/pi.js';
import { parseArenaAgentConfig } from '../src/configFile.js';
import { parseRunConfig } from '../src/runConfigSchema.js';

const execFileP = promisify(execFile);

const DIGEST = `sha256:${'a'.repeat(64)}`;

/** Diretórios temporários criados pelos testes (limpos no afterAll). */
const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Perfil com uid/cpus/env fixos — o teste não pode depender da máquina. */
function fixedProfile(over: Parameters<typeof hardeningProfile>[0] = {}) {
  return hardeningProfile({ uid: 1234, gid: 5678, hostCpus: 16, env: {}, ...over });
}

/** Valor de uma flag `--x valor` no argv. */
function flagValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === flag) out.push(argv[i + 1]);
  });
  return out;
}

// ----------------------------------------------------------------------------
// 1. Perfil fixo
// ----------------------------------------------------------------------------

describe('perfil fixo de endurecimento (R-15 REC-1)', () => {
  it('default: cap-drop ALL, no-new-privileges, rootfs read-only, tmpfs /tmp e /exec, rede none, limites, não-root, pull never', () => {
    const p = fixedProfile();
    expect(p).toMatchObject({
      version: HARDENING_PROFILE_VERSION,
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges'],
      readOnlyRootfs: true,
      network: 'none',
      pidsLimit: 512,
      cpus: 2,
      memory: '2g',
      memorySwap: '2g',
      user: '1234:5678',
      pull: 'never',
      unsafe: [],
    });
    expect(Object.keys(p.tmpfs).sort()).toEqual(['/exec', '/tmp']);
    expect(p.runtime).toBeUndefined();
  });

  it('hardeningFlags materializa TODAS as flags, em ordem estável', () => {
    const flags = hardeningFlags(fixedProfile());
    expect(flags).toEqual([
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--read-only',
      '--tmpfs', '/tmp:rw,nosuid,nodev,exec,size=512m',
      '--tmpfs', '/exec:rw,nosuid,nodev,noexec,size=16m',
      '--network', 'none',
      '--pids-limit', '512',
      '--cpus', '2',
      '--memory', '2g',
      '--memory-swap', '2g',
      '--user', '1234:5678',
      '--pull', 'never',
    ]);
  });

  it('--cpus encaixa no número de CPUs do host (o daemon recusa acima dele)', () => {
    expect(fixedProfile({ hostCpus: 1 }).cpus).toBe(1);
    expect(fixedProfile({ hostCpus: 64 }).cpus).toBe(2);
  });

  it('usuário: nunca root; sem getuid (Windows) cai no `node` 1000:1000 da imagem', () => {
    expect(() => containerUser(0, 0)).toThrow(/não roda o agente como root/);
    expect(() => fixedProfile({ uid: 0, gid: 0 })).toThrow(/root/);
    expect(containerUser(null, null)).toBe('1000:1000');
    expect(containerUser(1001, undefined)).toBe('1001:1001');
  });

  it('rede: `none` por default; `bridge` só pela válvula do OPERADOR e fica registrada em `unsafe`', () => {
    expect(resolveContainerNetwork({})).toEqual({ network: 'none', unsafe: [] });
    expect(resolveContainerNetwork({ [UNSAFE_NETWORK_ENV]: 'none' }).network).toBe('none');
    const bridged = fixedProfile({ env: { [UNSAFE_NETWORK_ENV]: 'bridge' } });
    expect(bridged.network).toBe('bridge');
    expect(bridged.unsafe).toHaveLength(1);
    expect(bridged.unsafe[0]).toMatch(/exfiltr/);
    expect(flagValues(hardeningFlags(bridged), '--network')).toEqual(['bridge']);
    // Qualquer outro valor (host, container:<id>…) é recusado — não há "meio endurecido".
    expect(() => resolveContainerNetwork({ [UNSAFE_NETWORK_ENV]: 'host' })).toThrow(/inválido/);
  });

  it('gVisor/runtime é opt-in: ausente = runc; nome válido vira `--runtime`; nome inválido é recusado', () => {
    expect(hardeningFlags(fixedProfile())).not.toContain('--runtime');
    const gv = fixedProfile({ runtime: 'runsc' });
    expect(flagValues(hardeningFlags(gv), '--runtime')).toEqual(['runsc']);
    expect(() => fixedProfile({ runtime: 'runsc --privileged' })).toThrow(/runtime inválido/);
    expect(parseDockerRuntimes('{"runc":{},"io.containerd.runc.v2":{},"runsc":{"path":"/usr/bin/runsc"}}')).toEqual([
      'runc',
      'io.containerd.runc.v2',
      'runsc',
    ]);
    expect(parseDockerRuntimes('lixo')).toEqual([]);
  });

  it('assertDockerRuntime recusa nome malformado ANTES de falar com o daemon', async () => {
    await expect(assertDockerRuntime('../../bin/sh')).rejects.toThrow(/runtime inválido/);
  });
});

// ----------------------------------------------------------------------------
// 2. Imagem por digest
// ----------------------------------------------------------------------------

describe('imagem por digest sha256 (nunca tag)', () => {
  it('isDigestRef aceita `sha256:<64hex>` e `repo@sha256:<64hex>`, recusa tag', () => {
    expect(isDigestRef(DIGEST)).toBe(true);
    expect(isDigestRef(`prompt-builder-pi@${DIGEST}`)).toBe(true);
    expect(isDigestRef(`ghcr.io/x/pi:0.84.2@${DIGEST}`)).toBe(true);
    expect(isDigestRef('prompt-builder-pi:0.84.2')).toBe(false);
    expect(isDigestRef('prompt-builder-pi:latest')).toBe(false);
    expect(isDigestRef('sha256:abc')).toBe(false);
    expect(isDigestRef(`${DIGEST} --privileged`)).toBe(false);
  });

  it('parseImageInspect lê o Id e os RepoDigests do `docker image inspect`', () => {
    const out = JSON.stringify([{ Id: DIGEST, RepoDigests: [`prompt-builder-pi@${DIGEST}`, 'lixo'] }]);
    expect(parseImageInspect(out, 'prompt-builder-pi:0.84.2')).toEqual({
      ref: 'prompt-builder-pi:0.84.2',
      digest: DIGEST,
      repoDigests: [`prompt-builder-pi@${DIGEST}`],
    });
    expect(parseImageInspect('[]', 'x')).toBeNull();
    expect(parseImageInspect('não é json', 'x')).toBeNull();
    expect(parseImageInspect(JSON.stringify([{ Id: 'prompt-builder-pi:0.84.2' }]), 'x')).toBeNull();
  });

  it('o `docker run` do sandbox RECUSA tag — só roda o conteúdo imutável', () => {
    expect(() =>
      buildSandboxRunArgv({ image: 'prompt-builder-pi:0.84.2', profile: fixedProfile(), command: ['pi', '--version'] }),
    ).toThrow(/digest sha256/);
  });

  it('ensurePiImage NÃO builda nem puxa uma referência por digest ausente — erro acionável', async () => {
    const ref = `sha256:${'0'.repeat(64)}`;
    await expect(ensurePiImage('0.0.0', { image: ref })).rejects.toThrow(/docker pull/);
  });
});

// ----------------------------------------------------------------------------
// 3. argv do docker run e argv.json
// ----------------------------------------------------------------------------

describe('argv do `docker run` do pi', () => {
  const base = mkTmp('pb036-argv-');
  const spec = {
    image: DIGEST,
    containerName: 'pb-agent-x',
    envFile: '/tmp/pb-agent-y.env',
    workspaceDir: path.join(base, 'ws'),
    workDir: path.join(base, 'exec'),
    profile: fixedProfile(),
    piArgv: ['--mode', 'json'],
  };

  it('perfil completo + binds só de ws/session/pi-home (o execDir do host NÃO entra em /exec)', () => {
    const argv = buildDockerArgv(spec);
    expect(argv.slice(0, 5)).toEqual(['run', '-i', '--rm', '--name', 'pb-agent-x']);
    for (const f of hardeningFlags(spec.profile)) expect(argv).toContain(f);
    expect(flagValues(argv, '--env-file')).toEqual(['/tmp/pb-agent-y.env']);
    expect(flagValues(argv, '--mount')).toEqual([
      `type=bind,source=${spec.workspaceDir},target=${CONTAINER_WS_DIR}`,
      `type=bind,source=${path.join(spec.workDir, 'session')},target=${CONTAINER_SESSION_DIR}`,
      `type=bind,source=${path.join(spec.workDir, 'pi-home')},target=${CONTAINER_PI_HOME_DIR}`,
    ]);
    // Nada de `-v` (criaria origem ausente como root) nem bind do execDir inteiro.
    expect(argv).not.toContain('-v');
    expect(argv.join(' ')).not.toContain(`${spec.workDir}:${CONTAINER_EXEC_DIR}`);
    expect(flagValues(argv, '-w')).toEqual([CONTAINER_WS_DIR]);
    // imagem por digest imediatamente antes do comando.
    const i = argv.indexOf(DIGEST);
    expect(argv.slice(i)).toEqual([DIGEST, 'pi', '--mode', 'json']);
  });

  it('mount: caminho com vírgula é citado (sintaxe CSV do --mount); relativo e quebra de linha são recusados', () => {
    const argv = buildSandboxRunArgv({
      image: DIGEST,
      profile: fixedProfile(),
      command: ['true'],
      mounts: [{ host: '/tmp/a,b', container: '/ws', readOnly: true }],
    });
    expect(flagValues(argv, '--mount')).toEqual(['type=bind,"source=/tmp/a,b",target=/ws,readonly']);
    expect(() =>
      buildSandboxRunArgv({ image: DIGEST, profile: fixedProfile(), command: ['true'], mounts: [{ host: 'rel', container: '/ws' }] }),
    ).toThrow(/absoluto/);
    expect(() =>
      buildSandboxRunArgv({ image: DIGEST, profile: fixedProfile(), command: ['true'], mounts: [{ host: '/tmp/a\nb', container: '/ws' }] }),
    ).toThrow(/quebra de linha/);
  });

  it('argv.json: digest sha256 no campo `image` E no argv, perfil efetivo, env-file mascarado', () => {
    const argv = ['docker', ...buildDockerArgv(spec)];
    const audit = containerAuditRecord({
      imageDigest: DIGEST,
      imageRef: 'prompt-builder-pi:0.84.2',
      profile: spec.profile,
      argv,
      envFile: spec.envFile,
    });
    expect(audit.mode).toBe('container');
    expect(audit.image).toBe(DIGEST);
    expect(audit.imageRef).toBe('prompt-builder-pi:0.84.2');
    expect(audit.argv).toContain(DIGEST);
    expect(audit.argv).toContain(ENV_FILE_MASK);
    expect(audit.argv).not.toContain(spec.envFile);
    expect(audit.hardening).toEqual(spec.profile);
    expect(() => containerAuditRecord({ imageDigest: 'prompt-builder-pi:0.84.2', profile: spec.profile, argv })).toThrow(
      /digest/,
    );
  });

  it('dica de rede só quando a rede é `none` (e aponta a válvula do operador)', () => {
    expect(sandboxNetworkHint({ network: 'none' })).toContain(`${UNSAFE_NETWORK_ENV}=bridge`);
    expect(sandboxNetworkHint({ network: 'bridge' })).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// 4. Executor: guardas e erro do provedor (sem Docker)
// ----------------------------------------------------------------------------

/** `piExecutor.run` com o 2º argumento (opções internas) — o contrato público só tem 1. */
const runPi = (opts: AgentRunOpts, base?: PiRunOptions): Promise<PiRunOutcome> =>
  (piExecutor.run as (o: AgentRunOpts, b?: PiRunOptions) => Promise<AgentRunOutcome>).call(
    piExecutor,
    opts,
    base,
  ) as Promise<PiRunOutcome>;

function runOpts(over: Partial<AgentRunOpts> & { env: Record<string, string> }): AgentRunOpts {
  const base = mkTmp('pb036-run-');
  const workspaceDir = path.join(base, 'ws');
  const workDir = path.join(base, 'exec');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  return {
    execId: `t${Date.now()}${Math.floor(Math.random() * 1e6)}`,
    task: {},
    config: { executor: 'pi', executorVersion: '0.84.2' },
    workspaceDir,
    workDir,
    bin: 'pi',
    ...over,
  } as AgentRunOpts;
}

/** Um "pi" falso (shell) que imprime `lines` como JSONL e sai com `exitCode` (default 0). */
function fakePi(lines: unknown[], exitCode = 0): string {
  const dir = mkTmp('pb036-fakepi-');
  const file = path.join(dir, 'pi');
  const body = lines.map((l) => `printf '%s\\n' '${JSON.stringify(l).replaceAll("'", "'\\''")}'`).join('\n');
  writeFileSync(file, `#!/bin/sh\ncat >/dev/null\n${body}\nexit ${exitCode}\n`, 'utf8');
  chmodSync(file, 0o755);
  return file;
}

const providerErrorEnd = {
  type: 'message_end',
  message: { role: 'assistant', stopReason: 'error', errorMessage: 'Connection error.' },
};
const normalEnd = { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } };

describe('erro do provedor ≠ execução concluída', () => {
  it('piProviderError: só o fim de mensagem do ASSISTENTE com stopReason=error', () => {
    expect(piProviderError(providerErrorEnd)).toBe('Connection error.');
    expect(piProviderError(normalEnd)).toBeUndefined();
    expect(piProviderError({ type: 'message_end', message: { role: 'user', stopReason: 'error' } })).toBeUndefined();
    expect(piProviderError({ type: 'turn_end', message: { role: 'assistant', stopReason: 'error' } })).toBeUndefined();
    expect(piProviderError(null)).toBeUndefined();
  });

  it('pi que sai 0 com a última chamada em erro vira stopReason `error` + `infraError` (infra), com a mensagem no stderrTail', async () => {
    const bin = fakePi([{ type: 'turn_start' }, providerErrorEnd, { type: 'agent_settled' }]);
    const out = await runPi(runOpts({ bin, env: { PATH: '/usr/bin:/bin', PI_MODEL_ID: 'x/y', PI_TASK: 'oi' } }));
    expect(out.exitCode).toBe(0);
    expect(out.stopReason).toBe('error');
    // O marcador é o que separa "a rede caiu" de "o processo morreu" (§18.3 → nao).
    expect(out.infraError).toBe('Connection error.');
    expect(out.stderrTail).toContain('Connection error.');
  });

  it('erro transitório seguido de resposta normal continua `completed`', async () => {
    const bin = fakePi([providerErrorEnd, normalEnd, { type: 'agent_settled' }]);
    const out = await runPi(runOpts({ bin, env: { PATH: '/usr/bin:/bin', PI_MODEL_ID: 'x/y', PI_TASK: 'oi' } }));
    expect(out.stopReason).toBe('completed');
    expect(out.infraError).toBeUndefined();
    // O header do tail não sai mais duplicado.
    expect(out.stderrTail?.match(/stderr \(/g)).toHaveLength(1);
  });

  it('processo que MORRE (exit≠0) sem erro do provedor: `error` SEM `infraError`; com erro do provedor: infra', async () => {
    const env = { PATH: '/usr/bin:/bin', PI_MODEL_ID: 'x/y', PI_TASK: 'oi' };
    const morreu = await runPi(runOpts({ bin: fakePi([{ type: 'turn_start' }, normalEnd], 1), env }));
    expect(morreu.stopReason).toBe('error');
    expect(morreu.infraError).toBeUndefined();
    const caiu = await runPi(runOpts({ bin: fakePi([{ type: 'turn_start' }, providerErrorEnd], 1), env }));
    expect(caiu.stopReason).toBe('error');
    expect(caiu.infraError).toBe('Connection error.');
  });

  it('ponta a ponta com o executor REAL: pi que não alcança o modelo → repetição SEM veredito (nunca nao)', async () => {
    const bin = fakePi([{ type: 'turn_start' }, providerErrorEnd, { type: 'agent_settled' }]);
    const dataDir = mkTmp('pb036-stage-');
    const anterior = getDataDir();
    setDataDir(dataDir);
    try {
      const params: RunAgentStageParams = {
        runId: 'run-036',
        stageIndex: 0,
        contestant: { id: 'ag', label: 'ag', modelId: 'x/y', runner: 'agent' },
        stage: {
          question: 'crie done.txt',
          productContext: 'repo vazio',
          maxTokens: 100,
          agentTask: { verify: [{ cmd: 'test -f done.txt', label: 'done' }] },
        },
        agentConfig: { executor: 'pi', executorVersion: '0.84.2', limits: { maxCostUsd: 0.05 } },
        apiKey: 'sk-falsa',
        ctx: {},
        dataDir,
        catalog: [],
        judgeModelIds: [],
        // Executor REAL (parser/rebaixamento do pi.ts) sobre o binário falso.
        gateway: {
          id: piExecutor.id,
          prepare: async () => ({ bin, env: { PATH: '/usr/bin:/bin' } }),
          run: (o, b) => runPi(o, b),
        },
      };
      const res = await runAgentStage(params);
      expect(res.repResults[0].stopReason).toBe('error');
      expect(res.repResults[0].oracle?.score).toBe(0);
      expect(res.repResults[0].verdict).toBeNull();
      expect(res.repResults[0].execution.infraError).toBe('Connection error.');
      expect(res.incomplete).toBe(true);
    } finally {
      setDataDir(anterior);
    }
  });

  it('canário do doctor: modelo que não respondeu NÃO é "sala limpa"', async () => {
    const bin = fakePi([providerErrorEnd, { type: 'agent_settled' }]);
    const report = await runCleanRoomCanary({ runDir: mkTmp('pb036-canary-'), apiKey: 'falsa', model: 'x/y', bin });
    expect(report.ok).toBe(false);
    expect(report.leaks.join(' ')).toMatch(/não respondeu ao canário.*Connection error/);
  });

  it('canário em container sem digest resolvível falha honesto, sem spawn', async () => {
    const report = await runCleanRoomCanary({
      runDir: mkTmp('pb036-canary-'),
      apiKey: 'falsa',
      model: 'x/y',
      container: true,
      image: 'prompt-builder-pi:nao-existe-impl-036',
    });
    expect(report.ok).toBe(false);
    expect(report.leaks.join(' ')).toMatch(/digest sha256/);
  });

  it('modo container recusa imagem por TAG e não grava env-file com a key', async () => {
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith(ENV_FILE_PREFIX)).length;
    const opts = runOpts({
      bin: 'docker',
      config: { executor: 'pi', executorVersion: '0.84.2', isolation: { kind: 'container' } },
      env: { OPENROUTER_API_KEY: 'sk-falsa', PI_MODEL_ID: 'x/y', PI_CONTAINER_IMAGE: 'prompt-builder-pi:0.84.2' },
    });
    await expect(runPi(opts)).rejects.toThrow(/pinada por digest/);
    expect(existsSync(path.join(opts.workDir, 'argv.json'))).toBe(false);
    const after = readdirSync(tmpdir()).filter((f) => f.startsWith(ENV_FILE_PREFIX)).length;
    expect(after).toBeLessThanOrEqual(before);
  });
});

// ----------------------------------------------------------------------------
// 5. Schema: isolation.runtime chega ao executor (não é descartado em silêncio)
// ----------------------------------------------------------------------------

describe('schema de isolation.runtime', () => {
  const agent = (isolation: Record<string, unknown>) => ({
    executor: 'pi',
    executorVersion: '0.84.2',
    limits: { maxCostUsd: 1 },
    isolation,
  });

  it('RunConfig: aceita `runsc` e o preserva; recusa nome com espaço/flag', () => {
    const base = {
      mode: 'compare',
      theme: 't',
      datagenModelId: 'g/x',
      judgeModelIds: ['j/x'],
      competitorModelIds: ['a/x', 'b/x'],
      customStages: [{ question: 'q', productContext: 'c', agentTask: { verify: [{ cmd: 'true' }] } }],
    };
    const ok = parseRunConfig({ ...base, agent: agent({ kind: 'container', runtime: 'runsc' }) });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.config.agent?.isolation).toEqual({ kind: 'container', runtime: 'runsc' });
    expect(parseRunConfig({ ...base, agent: agent({ kind: 'container', runtime: 'runsc --privileged' }) }).ok).toBe(false);
  });

  it('arquivo arena-agent-config@1: idem', () => {
    const file = (isolation: Record<string, unknown>) => ({
      format: 'arena-agent-config@1',
      mode: 'compare',
      theme: 't',
      agent: agent(isolation),
      models: { datagen: 'g/x', judges: ['j/x'], competitors: ['a/x', 'b/x'] },
      scenarios: [{ question: 'q', agentTask: { verify: [{ cmd: 'true' }] } }],
    });
    const ok = parseArenaAgentConfig(file({ kind: 'container', runtime: 'runsc' }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.config.agent.isolation?.runtime).toBe('runsc');
    expect(parseArenaAgentConfig(file({ kind: 'container', runtime: '../x' })).ok).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// 5b. `docker` FALSO no PATH: `--cpus` pelas CPUs do DAEMON e runtime propagado
// ----------------------------------------------------------------------------

interface FakeDocker {
  dir: string;
  /** Cada chamada ao `docker` (args unidos por espaço), em ordem. */
  calls(): string[];
}

/**
 * Um `docker` falso (shell): registra cada chamada e simula o daemon — `info`
 * (NCPU e runtimes), `image inspect` (ausente até o `build`), `build` e `run`
 * (responde a versão do pi). O CLI do docker recebe só PATH/HOME/DOCKER_HOST
 * (`dockerCliEnv`), então os caminhos vão EMBUTIDOS no script.
 */
function fakeDocker(opts: { ncpu: number; runtimes?: string[]; imagePresent?: boolean }): FakeDocker {
  const dir = mkTmp('pb036-fakedocker-');
  const log = path.join(dir, 'calls.log');
  const built = path.join(dir, 'built');
  if (opts.imagePresent) writeFileSync(built, '');
  const inspect = JSON.stringify([{ Id: DIGEST, RepoDigests: [] }]);
  const runtimes = JSON.stringify(Object.fromEntries((opts.runtimes ?? ['runc']).map((r) => [r, {}])));
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${log}'`,
    'case "$1" in',
    '  info)',
    '    case "$*" in',
    `      *NCPU*) echo ${opts.ncpu} ;;`,
    `      *Runtimes*) echo '${runtimes}' ;;`,
    '    esac ;;',
    `  image) if [ -f '${built}' ]; then echo '${inspect}'; else echo 'Error: No such image' >&2; exit 1; fi ;;`,
    `  build) : > '${built}' ;;`,
    `  run) echo '${PI_VERSION_FAKE}' ;;`,
    'esac',
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(path.join(dir, 'docker'), script, { mode: 0o755 });
  return {
    dir,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []),
  };
}
const PI_VERSION_FAKE = '0.84.2';

/** Roda `fn` com o docker falso à frente no PATH e um DOCKER_HOST único (chave nova no memo de NCPU). */
async function withFakeDocker<T>(fd: FakeDocker, fn: () => Promise<T>): Promise<T> {
  const saved = { path: process.env.PATH, host: process.env.DOCKER_HOST };
  process.env.PATH = `${fd.dir}:${saved.path ?? ''}`;
  process.env.DOCKER_HOST = `unix://${fd.dir}/daemon-falso.sock`;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved.path;
    if (saved.host === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = saved.host;
  }
}

/** A chamada `docker run` registrada (a única que sobe container). */
const runCalls = (fd: FakeDocker): string[] => fd.calls().filter((c) => c.startsWith('run '));

describe('`--cpus` pelas CPUs do DAEMON (não do processo cliente)', () => {
  it('parseDockerNcpu: inteiro positivo; lixo/zero = undefined', () => {
    expect(parseDockerNcpu('8\n')).toBe(8);
    expect(parseDockerNcpu(' 1 ')).toBe(1);
    expect(parseDockerNcpu('0')).toBeUndefined();
    expect(parseDockerNcpu('')).toBeUndefined();
    expect(parseDockerNcpu('4.5')).toBeUndefined();
    expect(parseDockerNcpu('Cannot connect to the Docker daemon')).toBeUndefined();
  });

  it('daemon de 1 vCPU (VM do Docker Desktop/DOCKER_HOST remoto): sandboxProfile encaixa `--cpus 1`, 1 `docker info` por daemon', async () => {
    const fd = fakeDocker({ ncpu: 1 });
    await withFakeDocker(fd, async () => {
      expect(await dockerDaemonCpus()).toBe(1);
      const p = await sandboxProfile({ uid: 1234, gid: 5678, env: {} });
      expect(p.cpus).toBe(1);
      // Sem a pergunta ao daemon, o cliente (esta máquina) diria outra coisa.
      expect(hardeningProfile({ uid: 1234, gid: 5678, env: {} }).cpus).toBe(Math.min(2, availableParallelism()));
      // Memorizado: a 2ª consulta não fala com o daemon de novo.
      await sandboxProfile({ uid: 1234, gid: 5678, env: {} });
      expect(fd.calls().filter((c) => c.startsWith('info ')).length).toBe(1);
      // `hostCpus` explícito dispensa o daemon.
      expect((await sandboxProfile({ uid: 1234, gid: 5678, env: {}, hostCpus: 16 })).cpus).toBe(2);
    });
  });

  it('run() do pi em container grava no argv.json (e no argv) o `--cpus` do daemon', async () => {
    const fd = fakeDocker({ ncpu: 1, imagePresent: true });
    await withFakeDocker(fd, async () => {
      const opts = runOpts({
        bin: 'docker',
        config: { executor: 'pi', executorVersion: '0.84.2', isolation: { kind: 'container' } },
        env: { OPENROUTER_API_KEY: 'sk-falsa', PI_MODEL_ID: 'x/y', PI_TASK: 'oi', PI_CONTAINER_IMAGE: DIGEST },
      });
      await runPi(opts);
      const audit = JSON.parse(readFileSync(path.join(opts.workDir, 'argv.json'), 'utf8'));
      expect(audit.hardening.cpus).toBe(1);
      expect(flagValues(audit.argv, '--cpus')).toEqual(['1']);
      expect(runCalls(fd)[0]).toContain('--cpus 1');
    });
  });
});

describe('isolation.runtime chega a TODO `docker run` (validação da imagem e selfTest)', () => {
  it('ensurePiImage: a validação de uma imagem recém-buildada roda no runtime da run', async () => {
    const fd = fakeDocker({ ncpu: 4, runtimes: ['runc', 'runsc'] });
    await withFakeDocker(fd, async () => {
      const pinned = await ensurePiImage(PI_VERSION_FAKE, { image: 'pb-fake-impl036:1', runtime: 'runsc' });
      expect(pinned.digest).toBe(DIGEST);
      expect(fd.calls().some((c) => c.startsWith('build '))).toBe(true);
      const [verify] = runCalls(fd);
      expect(verify).toContain('--runtime runsc');
      expect(verify).toContain('--cpus 2');
      expect(verify).toContain(`${DIGEST} pi --version`);
    });
    // Sem runtime: runc do daemon, sem `--runtime`.
    const semRuntime = fakeDocker({ ncpu: 4 });
    await withFakeDocker(semRuntime, async () => {
      await ensurePiImage(PI_VERSION_FAKE, { image: 'pb-fake-impl036:1' });
      expect(runCalls(semRuntime)[0]).not.toContain('--runtime');
    });
  });

  it('prepare() valida o runtime no daemon, builda/valida NELE e estampa PI_CONTAINER_RUNTIME para o selfTest', async () => {
    const fd = fakeDocker({ ncpu: 1, runtimes: ['runc', 'runsc'] });
    await withFakeDocker(fd, async () => {
      const prep = await piExecutor.prepare({
        install: 'system',
        executorVersion: PI_VERSION_FAKE,
        runDir: mkTmp('pb036-prep-'),
        isolation: { kind: 'container', image: 'pb-fake-impl036:1', runtime: 'runsc' },
      });
      expect(prep.bin).toBe('docker');
      expect(prep.env.PI_CONTAINER_IMAGE).toBe(DIGEST);
      expect(prep.env.PI_CONTAINER_RUNTIME).toBe('runsc');
      expect(fd.calls().some((c) => c.startsWith('info ') && c.includes('Runtimes'))).toBe(true);
      const [verify] = runCalls(fd);
      expect(verify).toContain('--runtime runsc');
      expect(verify).toContain('--cpus 1');

      // O selfTest recebe o env do prepare() e sobe o MESMO sandbox.
      const report = await piExecutor.selfTest({ bin: prep.bin, env: prep.env, runDir: mkTmp('pb036-self-') });
      expect(report.ok).toBe(true);
      expect(flagValues(report.flagsUsed, '--runtime')).toEqual(['runsc']);
      expect(flagValues(report.flagsUsed, '--cpus')).toEqual(['1']);
      expect(runCalls(fd)[1]).toContain('--runtime runsc');
    });
  });

  it('prepare() recusa runtime que o daemon não tem — antes de buildar', async () => {
    const fd = fakeDocker({ ncpu: 4, runtimes: ['runc'] });
    await withFakeDocker(fd, async () => {
      await expect(
        piExecutor.prepare({
          install: 'system',
          executorVersion: PI_VERSION_FAKE,
          runDir: mkTmp('pb036-prep-'),
          isolation: { kind: 'container', image: 'pb-fake-impl036:1', runtime: 'runsc' },
        }),
      ).rejects.toThrow(/não está registrado no daemon/);
      expect(fd.calls().some((c) => c.startsWith('build '))).toBe(false);
    });
  });
});

// ----------------------------------------------------------------------------
// 5c. doctor: rota até o provedor e o sandbox DAQUELA run (`--config`)
// ----------------------------------------------------------------------------

describe('agents doctor --container: falha CEDO quando o agente não alcança o provedor', () => {
  it('rede `none` sem proxy de inferência: erro acionável, ok=false e o canário (que gastaria) nem roda', async () => {
    const saved = process.env[UNSAFE_NETWORK_ENV];
    delete process.env[UNSAFE_NETWORK_ENV];
    try {
      const r = await runPreflight({
        expectedVersion: '0.84.2',
        runDir: mkTmp('pb036-doctor-'),
        apiKey: 'sk-falsa',
        model: 'x/y',
        isolation: { kind: 'container', image: 'pb-inexistente-impl036:0' },
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/não alcança o provedor.*--network none/);
      expect(r.errors.join(' ')).toContain(`${UNSAFE_NETWORK_ENV}=bridge`);
      expect(r.canary).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env[UNSAFE_NETWORK_ENV] = saved;
    }
  });

  it('válvula `bridge` do operador: a rota existe (sem esse erro), mas o desvio aparece no pré-voo', async () => {
    const saved = process.env[UNSAFE_NETWORK_ENV];
    process.env[UNSAFE_NETWORK_ENV] = 'bridge';
    try {
      const r = await runPreflight({
        expectedVersion: '0.84.2',
        runDir: mkTmp('pb036-doctor-'),
        isolation: { kind: 'container', image: 'pb-inexistente-impl036:0' },
      });
      const all = r.errors.join(' ');
      expect(all).not.toMatch(/não alcança o provedor/);
      expect(all).toMatch(/FORA do perfil endurecido.*network=bridge/);
    } finally {
      if (saved === undefined) delete process.env[UNSAFE_NETWORK_ENV];
      else process.env[UNSAFE_NETWORK_ENV] = saved;
    }
  });

  it('doctorIsolation: com --config, image/runtime/versão DAQUELA run chegam ao pré-voo (e à chave do canário)', () => {
    const cfg = (isolation?: Record<string, unknown>) =>
      ({ agent: { executor: 'pi', executorVersion: '0.90.0', ...(isolation ? { isolation } : {}) } }) as unknown as RunConfig;
    expect(doctorIsolation(cfg({ kind: 'container', image: 'meu/pi@' + DIGEST, runtime: 'runsc' }), false)).toEqual({
      kind: 'container',
      image: 'meu/pi@' + DIGEST,
      runtime: 'runsc',
    });
    // Sem image no arquivo: a imagem default da executorVersion DO ARQUIVO (a que a run builda).
    expect(doctorIsolation(cfg({ kind: 'container' }), false)).toEqual({ kind: 'container', image: 'prompt-builder-pi:0.90.0' });
    // Arquivo em worktree: sem --container, o doctor é o de host.
    expect(doctorIsolation(cfg({ kind: 'worktree' }), false)).toBeUndefined();
    expect(doctorIsolation(cfg(), true)).toEqual({ kind: 'container', image: 'prompt-builder-pi:0.90.0' });
    // Sem --config: comportamento de antes.
    expect(doctorIsolation(undefined, true)).toEqual({ kind: 'container' });
    expect(doctorIsolation(undefined, false)).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// 6. Docker real (opcional por ambiente — nunca puxa/builda imagem)
// ----------------------------------------------------------------------------

const PI_VERSION = '0.84.2';
const PI_IMAGE = `prompt-builder-pi:${PI_VERSION}`;

function dockerImageId(ref: string): string | null {
  const r = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}
const dockerReady =
  process.env.PB_SKIP_DOCKER_TESTS !== '1' &&
  spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 15_000 }).status === 0;
const piImageId = dockerReady ? dockerImageId(PI_IMAGE) : null;
/** NCPU do daemon real (a fonte do teto de `--cpus`). */
function daemonNcpu(): number {
  const r = spawnSync('docker', ['info', '--format', '{{.NCPU}}'], { encoding: 'utf8', timeout: 15_000 });
  return Number(r.stdout.trim());
}

/** Campos de `/proc/<pid>/status` que o amicontained resume. */
function procStatus(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

describe.runIf(dockerReady && piImageId !== null)('Docker real: execução endurecida do pi', () => {
  it('ensurePiImage devolve a imagem PINADA pelo digest do daemon', async () => {
    const pinned = await ensurePiImage(PI_VERSION);
    expect(pinned.ref).toBe(PI_IMAGE);
    expect(pinned.digest).toBe(piImageId);
    expect(isDigestRef(pinned.digest)).toBe(true);
    expect(await resolveImageDigest(PI_IMAGE)).toEqual(pinned);
  });

  it(
    'container do agente endurecido: rootfs read-only, sem capabilities, sem rede, só /tmp /ws /exec/{session,pi-home} graváveis',
    async () => {
      const base = mkTmp('pb036-probe-');
      for (const d of ['ws', 'session', 'pi-home']) mkdirSync(path.join(base, d));
      const script = [
        'cat /proc/self/status',
        'echo "UID=$(id -u)"',
        'touch /etc/pb036 2>/dev/null && echo W_ETC || echo RO_ETC',
        'touch /usr/local/pb036 2>/dev/null && echo W_USR || echo RO_USR',
        'touch /tmp/pb036 && echo W_TMP',
        'touch /ws/pb036 && echo W_WS',
        'touch /exec/session/pb036 && echo W_SESSION',
        'touch /exec/pi-home/pb036 && echo W_PIHOME',
        'ls /exec',
        'echo NETDEV_BEGIN; cat /proc/net/dev; echo NETDEV_END',
      ].join('; ');
      const argv = buildSandboxRunArgv({
        image: piImageId as string,
        profile: hardeningProfile({ env: {} }),
        command: ['bash', '-c', script],
        mounts: [
          { host: path.join(base, 'ws'), container: CONTAINER_WS_DIR },
          { host: path.join(base, 'session'), container: CONTAINER_SESSION_DIR },
          { host: path.join(base, 'pi-home'), container: CONTAINER_PI_HOME_DIR },
        ],
      });
      const { stdout } = await execFileP('docker', argv, { timeout: 60_000 });
      const st = procStatus(stdout);
      // O que o amicontained reporta: 0 capabilities, seccomp em filtro, no_new_privs.
      for (const k of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) expect(st[k]).toBe('0000000000000000');
      expect(st.Seccomp).toBe('2');
      expect(st.NoNewPrivs).toBe('1');
      expect(stdout).toMatch(/UID=(?!0\b)\d+/);
      for (const tag of ['RO_ETC', 'RO_USR', 'W_TMP', 'W_WS', 'W_SESSION', 'W_PIHOME']) expect(stdout).toContain(tag);
      // `/exec` só tem os pontos de montagem — nada do execDir do host.
      expect(stdout).toMatch(/^pi-home\nsession$/m);
      // Rede `none`: só a loopback.
      const netdev = stdout.slice(stdout.indexOf('NETDEV_BEGIN'), stdout.indexOf('NETDEV_END'));
      const ifaces = netdev
        .split('\n')
        .filter((l) => /^\s*[\w.-]+:\s+\d/.test(l))
        .map((l) => l.trim().split(':')[0]);
      expect(ifaces).toEqual(['lo']);
      // Os arquivos criados no container aparecem no host com a owneria do usuário.
      expect(existsSync(path.join(base, 'ws', 'pb036'))).toBe(true);
    },
    90_000,
  );

  it(
    'docker inspect da execução REAL do pi: CapDrop ALL, ReadonlyRootfs, NoNewPrivileges, NetworkMode none, PidsLimit 512, User não-root, imagem sha256 — e o argv.json casa',
    async () => {
      const saved = { key: process.env.OPENROUTER_API_KEY, model: process.env.PI_MODEL_ID, net: process.env[UNSAFE_NETWORK_ENV] };
      // Key FALSA + rede none: nenhuma chamada sai da máquina (nada é cobrado).
      process.env.OPENROUTER_API_KEY = 'sk-or-v1-FALSA-impl-036';
      process.env.PI_MODEL_ID = 'openai/gpt-4o-mini';
      delete process.env[UNSAFE_NETWORK_ENV];
      const ac = new AbortController();
      try {
        const runDir = mkTmp('pb036-e2e-run-');
        const prep = await piExecutor.prepare({
          install: 'system',
          executorVersion: PI_VERSION,
          runDir,
          isolation: { kind: 'container' },
        });
        expect(prep.bin).toBe('docker');
        expect(prep.env.PI_CONTAINER_IMAGE).toBe(piImageId);

        const opts = runOpts({
          bin: prep.bin,
          env: { ...prep.env, PI_TASK: 'responda só "oi"' },
          config: {
            executor: 'pi',
            executorVersion: PI_VERSION,
            isolation: { kind: 'container' },
            limits: { timeoutMs: 120_000 },
          },
        });
        const name = `pb-agent-${opts.execId}`;
        const running = runPi(opts, { signal: ac.signal });

        // Enquanto o pi roda: `docker inspect` + o status do PID 1 (o próprio pi).
        let inspect: Record<string, any> | undefined;
        let pid1 = '';
        const deadline = Date.now() + 60_000;
        while (!inspect && Date.now() < deadline) {
          try {
            const { stdout } = await execFileP('docker', ['inspect', name], { timeout: 10_000 });
            inspect = JSON.parse(stdout)[0];
            pid1 = (await execFileP('docker', ['exec', name, 'cat', '/proc/1/status'], { timeout: 10_000 })).stdout;
          } catch {
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        ac.abort(); // não precisa esperar as retentativas do pi sem rede
        const out = await running;

        expect(inspect, 'o container da execução deveria ter sido inspecionado').toBeDefined();
        const hc = inspect!.HostConfig;
        expect(hc.CapDrop).toEqual(['ALL']);
        expect(hc.CapAdd ?? null).toBeNull();
        expect(hc.Privileged).toBe(false);
        expect(hc.ReadonlyRootfs).toBe(true);
        expect(hc.SecurityOpt).toEqual(['no-new-privileges']);
        expect(hc.NetworkMode).toBe('none');
        expect(hc.PidsLimit).toBe(512);
        expect(hc.Memory).toBe(2 * 1024 ** 3);
        expect(hc.NanoCpus).toBeGreaterThan(0);
        expect(Object.keys(hc.Tmpfs).sort()).toEqual(['/exec', '/tmp']);
        expect(inspect!.Config.User).toMatch(/^[1-9]\d*:\d+$/);
        expect(inspect!.Image).toBe(piImageId);

        const st = procStatus(pid1);
        expect(st.CapEff).toBe('0000000000000000');
        expect(st.CapBnd).toBe('0000000000000000');
        expect(st.Seccomp).toBe('2');
        expect(st.NoNewPrivs).toBe('1');

        const audit = JSON.parse(readFileSync(path.join(opts.workDir, 'argv.json'), 'utf8'));
        expect(audit.image).toBe(piImageId);
        expect(audit.imageRef).toBe(PI_IMAGE);
        expect(audit.argv).toContain(piImageId);
        expect(audit.argv).not.toContain(PI_IMAGE);
        expect(audit.hardening).toMatchObject({ capDrop: ['ALL'], readOnlyRootfs: true, network: 'none', pidsLimit: 512 });
        // `--cpus` encaixado nas CPUs do DAEMON (e é o que o container recebeu).
        expect(audit.hardening.cpus).toBe(Math.min(2, daemonNcpu()));
        expect(hc.NanoCpus).toBe(audit.hardening.cpus * 1e9);
        expect(JSON.stringify(audit)).not.toContain('FALSA');

        expect(out.stopReason).toBe('cancelled');
        // Kill por nome: nenhum container órfão.
        const ps = await execFileP('docker', ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
        expect(ps.stdout.trim()).toBe('');
      } finally {
        ac.abort();
        if (saved.key === undefined) delete process.env.OPENROUTER_API_KEY;
        else process.env.OPENROUTER_API_KEY = saved.key;
        if (saved.model === undefined) delete process.env.PI_MODEL_ID;
        else process.env.PI_MODEL_ID = saved.model;
        if (saved.net !== undefined) process.env[UNSAFE_NETWORK_ENV] = saved.net;
      }
    },
    120_000,
  );

  it('selfTest em modo container roda `pi --version` no perfil endurecido e devolve as flags aplicadas', async () => {
    const report = await piExecutor.selfTest({
      bin: 'docker',
      env: { PI_CONTAINER_IMAGE: piImageId as string },
      runDir: mkTmp('pb036-self-'),
    });
    expect(report.ok).toBe(true);
    expect(report.piVersion).toContain(PI_VERSION);
    expect(report.flagsUsed).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--read-only', '--network', 'none']));
    // Tag não passa nem no selfTest.
    const bad = await piExecutor.selfTest({ bin: 'docker', env: { PI_CONTAINER_IMAGE: PI_IMAGE }, runDir: mkTmp('pb036-self-') });
    expect(bad.ok).toBe(false);
  }, 60_000);

  it('selfTest sobe o runtime estampado pelo prepare(): runtime ausente no daemon REPROVA (antes rodava em runc e passava)', async () => {
    const report = await piExecutor.selfTest({
      bin: 'docker',
      env: { PI_CONTAINER_IMAGE: piImageId as string, PI_CONTAINER_RUNTIME: 'pb-runtime-inexistente-impl036' },
      runDir: mkTmp('pb036-self-'),
    });
    expect(report.ok).toBe(false);
    expect(flagValues(report.flagsUsed, '--runtime')).toEqual(['pb-runtime-inexistente-impl036']);
  }, 60_000);

  it('dockerDaemonCpus lê o NCPU do daemon real; o pré-voo recusa runtime que o daemon não tem', async () => {
    expect(await dockerDaemonCpus()).toBe(daemonNcpu());
    const r = await runPreflight({
      expectedVersion: PI_VERSION,
      runDir: mkTmp('pb036-doctor-'),
      isolation: { kind: 'container', image: PI_IMAGE, runtime: 'pb-runtime-inexistente-impl036' },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/não está registrado no daemon/);
  }, 60_000);

  it(
    'run REAL em container com --network none e SEM proxy: a repetição fica SEM veredito (fora do placar) — nunca nao',
    async () => {
      // O caso da revisão: o default endurecido sem o proxy de inferência
      // (IMPL-037). O pi esgota as retentativas (~15 s) com "Connection error." e
      // sai 0. Key FALSA: nada sai da máquina.
      const saved = { key: process.env.OPENROUTER_API_KEY, net: process.env[UNSAFE_NETWORK_ENV] };
      process.env.OPENROUTER_API_KEY = 'sk-or-v1-FALSA-impl-036';
      delete process.env[UNSAFE_NETWORK_ENV];
      const dataDir = mkTmp('pb036-stage-docker-');
      const anterior = getDataDir();
      setDataDir(dataDir);
      try {
        const res = await runAgentStage({
          runId: 'run-036-docker',
          stageIndex: 0,
          contestant: { id: 'ag', label: 'ag', modelId: 'openai/gpt-4o-mini', runner: 'agent' },
          stage: {
            question: 'crie o arquivo done.txt',
            productContext: 'repo vazio',
            maxTokens: 100,
            agentTask: { verify: [{ cmd: 'test -f done.txt', label: 'done' }] },
          },
          agentConfig: {
            executor: 'pi',
            executorVersion: PI_VERSION,
            install: 'system',
            isolation: { kind: 'container' },
            limits: { maxCostUsd: 0.05, timeoutMs: 120_000 },
          },
          apiKey: 'sk-or-v1-FALSA-impl-036',
          ctx: {},
          dataDir,
          catalog: [],
          judgeModelIds: [],
        });
        const r0 = res.repResults[0];
        expect(r0.stopReason).toBe('error');
        expect(r0.execution.infraError).toMatch(/Connection error/);
        expect(r0.oracle?.score).toBe(0);
        expect(r0.verdict).toBeNull();
        expect(res.incomplete).toBe(true);
        // A causa e a dica acionável chegam a quem lê a resposta.
        expect(res.response.status).toBe('error');
        expect(res.response.errorMsg).toContain(UNSAFE_NETWORK_ENV);
      } finally {
        setDataDir(anterior);
        if (saved.key === undefined) delete process.env.OPENROUTER_API_KEY;
        else process.env.OPENROUTER_API_KEY = saved.key;
        if (saved.net !== undefined) process.env[UNSAFE_NETWORK_ENV] = saved.net;
      }
    },
    150_000,
  );
});

// A métrica de startup (p50 < 2 s, endurecido < +10% vs padrão) não é teste
// unitário (é ruidosa por natureza) — ver `scripts/bench-sandbox-startup.ts`.
