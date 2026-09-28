// IMPL-095 (R-14b:REC-3) — teste de CONTRATO do AgentExecutor v2.
//
// O defeito: o contrato era o protocolo de env `PI_*` — modelo/tarefa/prompt
// entravam por `PI_MODEL_ID`/`PI_TASK`/`PI_SYSTEM_PROMPT` e os extras (signal,
// onEvent, preços) viajavam num 2º PARÂMETRO fora do contrato, com cast
// explícito. O contrato v2 carrega tudo em `AgentRunOpts`.
//
// Camadas (todas sem rede e sem gasto):
//   1. varredura estática do contrato (executor.ts / runAgentStage.ts / pi.ts);
//   2. `piExecutor.run` com binário falso: precedência do contrato sobre o env
//      legado, cancelamento por `opts.signal` → `stopReason: 'cancelled'` e
//      `onEvent` com o custo REAL por turno.

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { piExecutor } from '../src/agent/pi.js';
import type { AgentRunOpts, AgentStreamEvent } from '../src/agent/executor.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const temps: string[] = [];
function mkTmp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
});

/** "pi" falso: despeja argv/stdin em `$PB_DUMP` e encerra com o JSONL pedido. */
function fakePi(lines: string[] = ['{"type":"agent_settled"}'], prelude = 'cat >/dev/null'): { bin: string; dump: string } {
  const dir = mkTmp('pb095-fakepi-');
  const dump = path.join(dir, 'dump');
  const bin = path.join(dir, 'pi');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'mkdir -p "$PB_DUMP"',
      'printf \'%s\\n\' "$@" > "$PB_DUMP/argv.txt"',
      `${prelude} > "$PB_DUMP/stdin.txt"`,
      ...lines.map((l) => `printf '%s\\n' '${l.replace(/'/g, "'\\''")}'`),
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(bin, 0o755);
  return { bin, dump: path.join(dir, 'dump') };
}

function runOpts(over: Partial<AgentRunOpts> & { env: Record<string, string>; bin: string }): AgentRunOpts {
  const base = mkTmp('pb095-run-');
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
    ...over,
  } as AgentRunOpts;
}

// ---------------------------------------------------------------------------
// 1. Contrato estático: sem variáveis `PI_*` e sem 2º parâmetro fora dele.
// ---------------------------------------------------------------------------
describe('IMPL-095 — AgentRunOpts sem canal PI_* nem 2º parâmetro fora do contrato', () => {
  it('executor.ts declara os campos explícitos do contrato v2', () => {
    const src = readFileSync(path.join(ROOT, 'src/agent/executor.ts'), 'utf8');
    for (const campo of [
      'modelId?:',
      'instruction?:',
      'systemPrompt?:',
      'promptMode?:',
      'thinking?:',
      'contextFiles?:',
      'signal?:',
      'onEvent?:',
      'sandbox?:',
    ]) {
      expect(src, `AgentRunOpts deve declarar ${campo}`).toContain(campo);
    }
    // O contrato tem UM parâmetro só.
    expect(src).toMatch(/run\(opts: AgentRunOpts\): Promise<AgentRunOutcome>;/);
  });

  it('runAgentStage não injeta PI_MODEL_ID/PI_TASK/PI_SYSTEM_PROMPT e chama gateway.run sem cast', () => {
    const src = readFileSync(path.join(ROOT, 'src/agent/runAgentStage.ts'), 'utf8');
    expect(src).not.toMatch(/PI_MODEL_ID\s*[:=]/);
    expect(src).not.toContain('PI_TASK');
    expect(src).not.toContain('PI_SYSTEM_PROMPT');
    // O cast do 2º parâmetro (o gap original) foi eliminado.
    expect(src).not.toMatch(/piExecutor\.run\s+as\s/);
    // E o contrato viaja em AgentRunOpts: modelo, tarefa e prompt explícitos.
    expect(src).toContain('modelId,');
    expect(src).toContain('instruction: stage.question,');
    expect(src).toContain('systemPrompt,');
  });

  it('pi.ts deriva modelo/tarefa/prompt do contrato (env PI_* só como tolerância legada)', () => {
    const src = readFileSync(path.join(ROOT, 'src/agent/pi.ts'), 'utf8');
    // A resolução primária é o contrato.
    expect(src).toContain('opts.modelId');
    expect(src).toContain('opts.instruction');
    expect(src).toContain('opts.systemPrompt');
    expect(src).toContain('opts.signal');
    expect(src).toContain('opts.onEvent');
    // O canal legado existe SÓ como fallback declarado.
    expect(src).toContain('mergeLegacyRunOpts');
  });
});

// ---------------------------------------------------------------------------
// 2. Comportamento do run() com o contrato v2.
// ---------------------------------------------------------------------------
describe('IMPL-095 — piExecutor.run consome o contrato v2', () => {
  it('modelId/instruction/systemPrompt vêm do contrato e VENCEM o env PI_* legado', async () => {
    const { bin, dump } = fakePi();
    const events: AgentStreamEvent[] = [];
    const opts = runOpts({
      bin,
      env: {
        PATH: '/usr/bin:/bin',
        PB_DUMP: dump,
        PI_MODEL_ID: 'legado/nao-usado',
        PI_TASK: 'tarefa-legada',
        PI_SYSTEM_PROMPT: 'prompt-legado',
      },
      modelId: 'openai/model-do-contrato',
      instruction: 'tarefa do contrato',
      systemPrompt: 'prompt do contrato',
      promptMode: 'replace',
      onEvent: (e) => events.push(e),
    });
    const out = await piExecutor.run(opts);
    expect(out.stopReason).toBe('completed');

    const argv = readFileSync(path.join(dump, 'argv.txt'), 'utf8');
    const stdin = readFileSync(path.join(dump, 'stdin.txt'), 'utf8');
    expect(argv).toContain('--model\nopenai/model-do-contrato');
    expect(argv).not.toContain('legado/nao-usado');
    expect(stdin.trim()).toBe('tarefa do contrato');
    expect(argv).toContain('--system-prompt');
    expect(argv).toContain('prompt do contrato');
    expect(argv).not.toContain('prompt-legado');
  });

  it('cancelamento por opts.signal interrompe run() com stopReason "cancelled" (controle, não erro)', async () => {
    // Fake que nunca termina sozinho: só o cancelamento o mata.
    const { bin } = fakePi(['{"type":"turn_start"}'], 'cat >/dev/null; sleep 60');
    const ac = new AbortController();
    const opts = runOpts({
      bin,
      env: { PATH: '/usr/bin:/bin', PB_DUMP: mkTmp('pb095-dump-') },
      modelId: 'openai/x',
      instruction: 'oi',
      signal: ac.signal,
      config: { executor: 'pi', executorVersion: '0.84.2', limits: { timeoutMs: 60_000 } },
    });
    const started = Date.now();
    const running = piExecutor.run(opts);
    setTimeout(() => ac.abort(), 300);
    const out = await running;
    expect(out.stopReason).toBe('cancelled');
    expect(out.trajectory.stopReason).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(20_000); // não esperou a parede de 60 s
    expect(out.infraError).toBeUndefined(); // cancelamento não é erro de provedor
  });

  it('onEvent emite o turno com o custo REAL (medido), nunca o placeholder 0', async () => {
    const { bin, dump } = fakePi([
      '{"type":"turn_start"}',
      '{"type":"message_end","message":{"role":"assistant","stopReason":"end","usage":{"cost":{"total":0.02},"input":10,"output":5}}}',
      '{"type":"turn_end","message":{"role":"assistant","stopReason":"end","usage":{"cost":{"total":0.02},"input":10,"output":5}}}',
      '{"type":"agent_settled"}',
    ]);
    const events: AgentStreamEvent[] = [];
    const opts = runOpts({
      bin,
      env: { PATH: '/usr/bin:/bin', PB_DUMP: dump },
      modelId: 'openai/x',
      instruction: 'oi',
      onEvent: (e) => events.push(e),
    });
    await piExecutor.run(opts);
    const turns = events.filter((e) => e.type === 'turn');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ type: 'turn', index: 1, costUsd: 0.02 });
  });
});
