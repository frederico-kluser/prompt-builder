// IMPL-030 (R-12:REC-5) — execução longa no CLI: `--detach` + `runs
// status/wait/cancel`, SIGTERM gracioso e varredura de órfãs.
//
// Processos REAIS do CLI (`node --import tsx src/cli/index.ts`, um processo só:
// o PID que recebe o sinal é o que grava a run) contra o OpenRouter FALSO em
// http local do harness do MCP — o competidor pendura até o cliente desistir,
// então a run dura o quanto o teste quiser (≥ 60 s) sem gastar nada.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI, COMPARE, KEY, ROOT, TSX, ate, dormir, openRouterHttp, recordsDoDisco } from './mcpHarness.js';
import { pidAlive } from '../src/procOwner.js';
import { readJobRecord } from '../src/jobManager.js';
import { readRecordOwner, setDataDir, sweepOrphanRecords } from '../src/storage.js';
import type { RunRecord } from '../src/types.js';

type Http = Awaited<ReturnType<typeof openRouterHttp>>;

let http: Http;
const dirs: string[] = [];

beforeAll(async () => {
  http = await openRouterHttp();
});
afterAll(async () => {
  await http.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function novoDataDir(): { dataDir: string; config: string } {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'pb-detach-'));
  dirs.push(dataDir);
  const config = path.join(dataDir, 'compare.json');
  writeFileSync(config, JSON.stringify(COMPARE));
  return { dataDir, config };
}

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENROUTER_BASE_URL: http.baseUrl,
    OPENROUTER_API_KEY: KEY,
    NO_COLOR: '1',
    CLAUDECODE: '',
    CI: '',
  };
}

function iniciar(args: string[]) {
  const child = spawn(TSX, [CLI, ...args], {
    cwd: ROOT,
    env: env(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += String(c)));
  child.stderr.on('data', (c) => (stderr += String(c)));
  const saiu = new Promise<{ code: number | null; signal: NodeJS.Signals | null; t: number }>((r) =>
    child.on('exit', (code, signal) => r({ code, signal, t: performance.now() })),
  );
  return { child, saiu, stdout: () => stdout, stderr: () => stderr };
}

async function rodar(args: string[]): Promise<{ code: number | null; json: Record<string, unknown>; stderr: string; ms: number }> {
  const t0 = performance.now();
  const p = iniciar(args);
  const fim = await p.saiu;
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(p.stdout()) as Record<string, unknown>;
  } catch {
    // saída não-JSON: o teste que depende dela falha no expect
  }
  return { code: fim.code, json, stderr: p.stderr(), ms: fim.t - t0 };
}

const dadosDe = (json: Record<string, unknown>) => (json.data ?? {}) as Record<string, unknown>;

function runDoDisco(dataDir: string, id: string): RunRecord | undefined {
  return recordsDoDisco(dataDir).find((r) => r.id === id);
}

/** Espera a run em disco chegar aos competidores (onde o fake pendura). */
async function ateCompetidores(dataDir: string, id: string, desde: number): Promise<void> {
  await ate(
    () =>
      http.chegadas.slice(desde).some((c) => c.papel === 'competitor' && !c.servida && !c.abortada) &&
      runDoDisco(dataDir, id)?.status === 'running',
    20_000,
    'run nos competidores',
  );
}

describe('IMPL-030 — --detach + runs status/wait/cancel', () => {
  it('a run destacada sobrevive ao fim do pai; wait --timeout 1 sai 9; cancel encerra o processo com aborted em ≤ 2 s', async () => {
    const { dataDir, config } = novoDataDir();
    const desde = http.chegadas.length;
    const pai = await rodar(['compare', '--config', config, '--budget', '1', '--yes', '--detach', '--json', '--data-dir', dataDir]);
    expect(pai.code, pai.stderr).toBe(0);
    const d = dadosDe(pai.json);
    const jobId = String(d.jobId);
    const runId = String(d.runId);
    const pid = Number(d.pid);
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);

    // O PAI já saiu (rodar esperou o exit); o FILHO segue vivo e a run anda.
    expect(pidAlive(pid)).toBe(true);
    await ateCompetidores(dataDir, runId, desde);
    await dormir(1_500);
    expect(pidAlive(pid)).toBe(true);
    expect(runDoDisco(dataDir, runId)?.status).toBe('running');
    // o dono da run é o filho (não o pai morto) e o job foi adotado por ele
    setDataDir(dataDir);
    expect((await readRecordOwner('run', runId))?.pid).toBe(pid);
    const job = await readJobRecord(jobId);
    expect(job?.ownerPid).toBe(pid);
    expect(job?.status).toBe('working');
    // stdout do filho = NDJSON em arquivo, com o início da run
    const ndjson = readFileSync(String(d.ndjsonFile), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; runId?: string });
    expect(ndjson.some((e) => e.type === 'start' && e.runId === runId)).toBe(true);

    // status (por jobId e por runId) enxerga a run viva
    const st = await rodar(['runs', 'status', runId, '--json', '--data-dir', dataDir]);
    expect(st.code).toBe(0);
    expect(dadosDe(st.json)).toMatchObject({ jobId, runId, status: 'working', terminal: false, processAlive: true, exitCode: null });

    // wait com prazo curto: exit DEDICADO (9), a run continua
    const w = await rodar(['runs', 'wait', jobId, '--timeout', '1', '--json', '--data-dir', dataDir]);
    expect(w.code).toBe(9);
    // Envelope único de erro (IMPL-028): o estado vai em error.details.
    expect(w.json.ok).toBe(false);
    expect(((w.json.error as Record<string, unknown>).details as Record<string, unknown>).timedOut).toBe(true);
    expect(pidAlive(pid)).toBe(true);

    // cancel: SIGTERM + marcador → processo encerrado e record 'aborted' em ≤ 2 s
    const c = await rodar(['runs', 'cancel', jobId, '--json', '--data-dir', dataDir]);
    expect(c.code, c.stderr).toBe(0);
    const cd = dadosDe(c.json);
    expect(cd.signalled).toBe(true);
    expect(Number(cd.elapsedMs)).toBeLessThanOrEqual(2_000);
    expect(pidAlive(pid)).toBe(false);
    const rec = runDoDisco(dataDir, runId)!;
    expect(rec.status).toBe('aborted');
    expect(rec.stoppedReason).toBe('cancelled');
    const jobFim = await readJobRecord(jobId);
    expect(jobFim?.status).toBe('cancelled');
    expect(jobFim?.exitCode).toBe(130);
    // fechou pelo caminho GRACIOSO (a run devolveu), não pela saída forçada
    expect(jobFim?.statusMessage).not.toMatch(/forçado/);
    // o dono some junto com a escrita terminal
    expect(await readRecordOwner('run', runId)).toBeNull();

    // wait depois do fim: devolve o código do COMANDO (130 = interrompido)
    const w2 = await rodar(['runs', 'wait', jobId, '--json', '--data-dir', dataDir]);
    expect(w2.code).toBe(130);
    // cancel de novo é idempotente
    const c2 = await rodar(['runs', 'cancel', runId, '--json', '--data-dir', dataDir]);
    expect(c2.code).toBe(0);
    expect(dadosDe(c2.json).alreadyTerminal).toBe(true);
  }, 60_000);

  it('--detach sem orçamento fora de TTY recusa ANTES de criar processo (exit 2, nada gasto)', async () => {
    const { dataDir, config } = novoDataDir();
    const antes = http.chegadas.length;
    const r = await rodar(['compare', '--config', config, '--detach', '--json', '--data-dir', dataDir]);
    expect(r.code).toBe(2);
    expect(http.chegadas.length).toBe(antes);
  }, 30_000);
});

describe('IMPL-030 — SIGTERM gracioso', () => {
  it('SIGTERM numa run em foreground grava o parcial (status ≠ running) em ≤ 10 s e sai 130', async () => {
    const { dataDir, config } = novoDataDir();
    const desde = http.chegadas.length;
    const p = iniciar(['compare', '--config', config, '--budget', '1', '--yes', '--output-format', 'ndjson', '--data-dir', dataDir]);
    let runId = '';
    await ate(() => {
      const m = /"type":"start"[^\n]*"runId":"([0-9a-f-]{36})"/.exec(p.stdout());
      if (m) runId = m[1];
      return runId !== '';
    }, 20_000, 'início da run');
    await ateCompetidores(dataDir, runId, desde);
    const t0 = performance.now();
    p.child.kill('SIGTERM');
    await ate(() => (runDoDisco(dataDir, runId)?.status ?? 'running') !== 'running', 10_000, 'record terminal');
    const gravadoEm = performance.now() - t0;
    const fim = await p.saiu;
    expect(gravadoEm).toBeLessThanOrEqual(10_000);
    expect(fim.code).toBe(130);
    const rec = runDoDisco(dataDir, runId)!;
    expect(rec.status).toBe('aborted');
    expect(rec.stoppedReason).toBe('cancelled');
    // o stream NDJSON termina SEMPRE num `result`
    const ultima = JSON.parse(p.stdout().trim().split('\n').at(-1)!) as { type: string; status?: string };
    expect(ultima.type).toBe('result');
    expect(ultima.status).toBe('aborted');
  }, 60_000);
});

describe('IMPL-030 — varredura de órfãs na CLI', () => {
  it('run morta por SIGKILL é detectada como aborted em ≤ 1 s (e pelo `runs status`)', async () => {
    const { dataDir, config } = novoDataDir();
    const desde = http.chegadas.length;
    const p = iniciar(['compare', '--config', config, '--budget', '1', '--yes', '--output-format', 'ndjson', '--data-dir', dataDir]);
    let runId = '';
    await ate(() => {
      const m = /"type":"start"[^\n]*"runId":"([0-9a-f-]{36})"/.exec(p.stdout());
      if (m) runId = m[1];
      return runId !== '';
    }, 20_000, 'início da run');
    await ateCompetidores(dataDir, runId, desde);
    p.child.kill('SIGKILL');
    await p.saiu;
    expect(runDoDisco(dataDir, runId)?.status).toBe('running'); // ninguém gravou o fim

    // A detecção em si (o que todo comando de leitura faz antes de ler):
    setDataDir(dataDir);
    const t0 = performance.now();
    const varrida = await sweepOrphanRecords({ only: { kind: 'run', id: runId } });
    const detectadoEm = performance.now() - t0;
    expect(varrida.runs).toEqual([runId]);
    expect(detectadoEm).toBeLessThanOrEqual(1_000);
    expect(runDoDisco(dataDir, runId)?.status).toBe('aborted');

    // …e a CLI a enxerga assim (órfã = exit 1 no wait, nunca 'running' para sempre)
    const st = await rodar(['runs', 'status', runId, '--json', '--data-dir', dataDir]);
    expect(dadosDe(st.json)).toMatchObject({ runId, status: 'aborted', terminal: true, orphan: true, exitCode: 1 });
    const w = await rodar(['runs', 'wait', runId, '--timeout', '5', '--json', '--data-dir', dataDir]);
    expect(w.code).toBe(1);
  }, 60_000);

  it('`runs list` marca a órfã sem ninguém pedir o id dela', async () => {
    const { dataDir, config } = novoDataDir();
    const desde = http.chegadas.length;
    const p = iniciar(['compare', '--config', config, '--budget', '1', '--yes', '--output-format', 'ndjson', '--data-dir', dataDir]);
    let runId = '';
    await ate(() => {
      const m = /"type":"start"[^\n]*"runId":"([0-9a-f-]{36})"/.exec(p.stdout());
      if (m) runId = m[1];
      return runId !== '';
    }, 20_000, 'início da run');
    await ateCompetidores(dataDir, runId, desde);
    p.child.kill('SIGKILL');
    await p.saiu;
    const l = await rodar(['runs', 'list', '--json', '--data-dir', dataDir]);
    const runs = dadosDe(l.json).runs as { id: string; status: string }[];
    expect(runs.find((r) => r.id === runId)?.status).toBe('aborted');
  }, 60_000);
});
