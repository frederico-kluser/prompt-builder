// IMPL-030 (R-12:REC-5) — peças de unidade da execução longa no CLI: arquivo
// de DONO da run (PID + token de início), varredura de órfãs, parada graciosa
// (SIGTERM / `requestStop`) com graça e saída forçada, job destacado
// (criar → adotar → cancelar de outro "processo") e os códigos de saída.
// Zero rede. (Os processos reais estão em cli-detach.test.ts.)

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isControlSignal } from '../src/budget.js';
import { JobManager, isOrphanJob, readJobRecord } from '../src/jobManager.js';
import { currentOwner, isOwnerAlive, processStartToken } from '../src/procOwner.js';
import {
  loadRun,
  markOrphansAsAborted,
  readRecordOwner,
  saveRun,
  setDataDir,
  sweepOrphanRecords,
} from '../src/storage.js';
import { detachedChildArgv, runAsDetachedChild, takeDetachedJobId, DETACHED_JOB_ENV } from '../src/cli/detach.js';
import { installGracefulStop, requestStop, resetStopStateForTests } from '../src/cli/runControl.js';
import { exitCodeForRecord } from '../src/cli/commands/runsJobs.js';
import { EXIT } from '../src/cli/output.js';
import type { RunConfig, RunRecord } from '../src/types.js';

const dirs: string[] = [];
let dataDir = '';

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'pb-runctl-'));
  dirs.push(dataDir);
  setDataDir(dataDir);
});
afterEach(() => resetStopStateForTests());
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

let seq = 0;
function run(status: RunRecord['status'], extra: Partial<RunRecord> = {}): RunRecord {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    status,
    config: { mode: 'compare', theme: 't', stages: 1, datagenModelId: 'x', judgeModelIds: ['y'] } as unknown as RunConfig,
    mode: 'compare',
    contestants: [],
    stages: [],
    scoreboard: {},
    costByContestant: {},
    totalCostUsd: 0,
    startedAt: new Date().toISOString(),
    ...extra,
  };
}

/** PID de um processo que JÁ morreu. */
const pidMorto = (): number => spawnSync(process.execPath, ['-e', '']).pid!;

function gravarDono(id: string, dono: Record<string, unknown>): void {
  writeFileSync(path.join(dataDir, 'runs', `${id}.owner`), JSON.stringify({ kind: 'run', id, ...dono }));
}

describe('IMPL-030 — arquivo de dono da run', () => {
  it('nasce com o primeiro record running (PID/token deste processo) e some com o terminal', async () => {
    const r = run('running');
    await saveRun(r);
    const dono = await readRecordOwner('run', r.id);
    expect(dono).toMatchObject({ pid: process.pid, host: os.hostname(), startToken: currentOwner().startToken });
    await saveRun({ ...r, status: 'finished', finishedAt: new Date().toISOString() });
    expect(await readRecordOwner('run', r.id)).toBeNull();
    expect(existsSync(path.join(dataDir, 'runs', `${r.id}.owner`))).toBe(false);
  });

  it('a escrita terminal nunca é ultrapassada pela running (ordem das CHAMADAS preservada)', async () => {
    const r = run('running');
    // sem await entre as duas: a terminal tem de ganhar
    const a = saveRun(r);
    const b = saveRun({ ...r, status: 'aborted', stoppedReason: 'cancelled' });
    await Promise.all([a, b]);
    expect((await loadRun(r.id))?.status).toBe('aborted');
    expect(await readRecordOwner('run', r.id)).toBeNull();
  });

  it('PID vivo com OUTRO token de início = PID reaproveitado = morto', () => {
    const eu = currentOwner();
    expect(isOwnerAlive(eu, 60_000)).toBe(true);
    if (processStartToken(process.pid) === null) return; // SO sem /proc: só o PID conta
    expect(isOwnerAlive({ ...eu, startToken: 'outro-boot:1' }, 60_000)).toBe(false);
    expect(isOwnerAlive({ ...eu, pid: pidMorto() }, 60_000)).toBe(false);
  });
});

describe('IMPL-030 — varredura de órfãs', () => {
  it('run running com dono MORTO vira aborted (sem stoppedReason) e o dono some; dono vivo fica', async () => {
    const orfa = run('running');
    const viva = run('running');
    // records gravados "por outro processo": direto no disco
    await saveRun(orfa);
    await saveRun(viva);
    gravarDono(orfa.id, { pid: pidMorto(), host: os.hostname(), startToken: null });
    const t0 = performance.now();
    const r = await sweepOrphanRecords();
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(r.runs).toEqual([orfa.id]);
    const lida = await loadRun(orfa.id);
    expect(lida?.status).toBe('aborted');
    expect(lida?.stoppedReason).toBeUndefined();
    expect(await readRecordOwner('run', orfa.id)).toBeNull();
    expect((await loadRun(viva.id))?.status).toBe('running');
  });

  it('record running SEM dono: só vira órfão pela idade da última escrita', async () => {
    const r = run('running');
    await saveRun(r);
    rmSync(path.join(dataDir, 'runs', `${r.id}.owner`));
    expect((await sweepOrphanRecords()).runs).toEqual([]); // padrão: nunca
    expect((await sweepOrphanRecords({ locklessAfterMs: 10 * 60_000 })).runs).toEqual([]); // recente
    const velho = (Date.now() - 11 * 60_000) / 1000;
    utimesSync(path.join(dataDir, 'runs', `${r.id}.json`), velho, velho);
    expect((await sweepOrphanRecords({ locklessAfterMs: 10 * 60_000 })).runs).toEqual([r.id]);
  });

  it('boot do servidor (markOrphansAsAborted) NÃO aborta a run de um processo do CLI vivo', async () => {
    const viva = run('running');
    await saveRun(viva); // dono = este processo, vivo
    const semDono = run('running');
    await saveRun(semDono);
    rmSync(path.join(dataDir, 'runs', `${semDono.id}.owner`));
    const r = await markOrphansAsAborted();
    expect(r.runs).toEqual([semDono.id]); // regra histórica p/ record sem dono
    expect((await loadRun(viva.id))?.status).toBe('running');
    await saveRun({ ...viva, status: 'finished' });
  });
});

describe('IMPL-030 — parada graciosa (SIGTERM / runs cancel)', () => {
  it('SIGTERM aborta com sinal de CONTROLE; o segundo sai na hora gravando o parcial (exit 130)', async () => {
    const r = run('running');
    await saveRun(r);
    const ac = new AbortController();
    const saidas: number[] = [];
    const avisos: string[] = [];
    const antes = process.listenerCount('SIGTERM');
    const parar = installGracefulStop(ac, { warn: (m) => avisos.push(m), graceMs: 60_000, exit: (c) => saidas.push(c) });
    expect((await readRecordOwner('run', r.id))?.signalStop).toBeUndefined(); // gravado antes do install
    process.emit('SIGTERM');
    expect(ac.signal.aborted).toBe(true);
    expect(isControlSignal(ac.signal.reason)).toBe(true);
    expect(saidas).toEqual([]);
    process.emit('SIGTERM');
    await new Promise((res) => setTimeout(res, 50));
    expect(saidas).toEqual([EXIT.SIGINT]);
    const lida = await loadRun(r.id);
    expect(lida?.status).toBe('aborted');
    expect(lida?.stoppedReason).toBe('cancelled');
    parar();
    expect(process.listenerCount('SIGTERM')).toBe(antes);
  });

  it('graça esgotada (algo ignorou o abort) força a saída com o parcial gravado', async () => {
    const r = run('running');
    const ac = new AbortController();
    const saidas: number[] = [];
    const parar = installGracefulStop(ac, { warn: () => undefined, graceMs: 30, exit: (c) => saidas.push(c) });
    await saveRun(r); // dono gravado DEPOIS do install: "para por sinal"
    expect((await readRecordOwner('run', r.id))?.signalStop).toBe(true);
    requestStop('runs cancel');
    await new Promise((res) => setTimeout(res, 150));
    expect(saidas).toEqual([EXIT.SIGINT]);
    expect((await loadRun(r.id))?.status).toBe('aborted');
    parar();
  });

  it('SIGTERM + marcador do mesmo `runs cancel` (requestStop) NÃO contam como segundo sinal: a graça vale', async () => {
    const ac = new AbortController();
    const saidas: number[] = [];
    const parar = installGracefulStop(ac, { warn: () => undefined, graceMs: 60_000, exit: (c) => saidas.push(c) });
    process.emit('SIGTERM');
    requestStop('runs cancel (CLI)');
    await new Promise((res) => setTimeout(res, 50));
    expect(ac.signal.aborted).toBe(true);
    expect(saidas).toEqual([]);
    parar();
  });

  it('pedido de parada ANTES de a run se registrar fica pendente e é aplicado no registro', () => {
    requestStop('cancelado no pré-voo');
    const ac = new AbortController();
    const parar = installGracefulStop(ac, { warn: () => undefined, graceMs: 60_000, exit: () => undefined });
    expect(ac.signal.aborted).toBe(true);
    parar();
  });
});

describe('IMPL-030 — job destacado (pai cria, filho adota, outro processo cancela)', () => {
  it('cancel de OUTRO gerente vira requestStop no filho; o job termina cancelled com exit 130', async () => {
    const pai = new JobManager();
    const job = await pai.createDetached({ kind: 'benchmark', tool: 'cli:compare', budgetUsd: 1, fingerprint: 'f' });
    expect(job.status).toBe('queued');

    const ac = new AbortController();
    const parar = installGracefulStop(ac, { warn: () => undefined, graceMs: 60_000, exit: () => undefined });
    const filho = runAsDetachedChild(job.id, 'benchmark', dataDir, async (hooks) => {
      hooks.onRunId('11111111-1111-4111-8111-111111111111');
      await new Promise<void>((res) => ac.signal.addEventListener('abort', () => res(), { once: true }));
      return EXIT.SIGINT;
    });
    // espera a adoção
    for (let i = 0; i < 100 && (await readJobRecord(job.id))?.runId === undefined; i++) {
      await new Promise((res) => setTimeout(res, 10));
    }
    expect((await readJobRecord(job.id))?.status).toBe('working');

    await new JobManager().cancel(job.id, 'runs cancel (teste)'); // marcador em disco
    expect(await filho).toBe(EXIT.SIGINT);
    const fim = await readJobRecord(job.id);
    expect(fim).toMatchObject({ status: 'cancelled', exitCode: 130, runId: '11111111-1111-4111-8111-111111111111' });
    parar();
  });

  it('erro do comando no filho termina o job failed com o código do comando e é relançado', async () => {
    const job = await new JobManager().createDetached({ kind: 'benchmark', tool: 'cli:compare', fingerprint: 'f' });
    const { CliError } = await import('../src/cli/output.js');
    await expect(
      runAsDetachedChild(job.id, 'benchmark', dataDir, async () => {
        throw new CliError('key inválida', EXIT.AUTH);
      }),
    ).rejects.toThrow('key inválida');
    expect(await readJobRecord(job.id)).toMatchObject({ status: 'failed', exitCode: EXIT.AUTH, failure: 'tool' });
  });

  it('assignOwner: o dono passa ao filho — pai morto não torna o job órfão; filho morto sim', async () => {
    const mgr = new JobManager();
    const job = await mgr.createDetached({ kind: 'benchmark', tool: 'cli:compare', fingerprint: 'f' });
    const morto = pidMorto();
    await mgr.assignOwner(job.id, morto);
    const rec = (await readJobRecord(job.id))!;
    expect(rec.ownerPid).toBe(morto);
    expect(isOrphanJob(rec)).toBe(true);
    expect(isOrphanJob({ ...rec, ownerPid: process.pid, ownerStartToken: currentOwner().startToken })).toBe(false);
  });

  it('argv do filho: sem --detach, orçamento resolvido, data dir absoluto e NDJSON (a última ocorrência vence)', () => {
    const a = detachedChildArgv(['--config', 'c.json', '--detach', '--json'], { budgetUsd: undefined, dataDir: '/d' });
    expect(a).not.toContain('--detach');
    expect(a.slice(-6)).toEqual(['--budget', 'none', '--data-dir', '/d', '--output-format', 'ndjson']);
    expect(detachedChildArgv([], { budgetUsd: 2.5, dataDir: '/d' }).slice(0, 2)).toEqual(['--budget', '2.5']);
  });

  it('a variável do filho é consumida (subprocessos não herdam o job)', () => {
    const env: NodeJS.ProcessEnv = { [DETACHED_JOB_ENV]: '11111111-1111-4111-8111-111111111111' };
    expect(takeDetachedJobId(env)).toBe('11111111-1111-4111-8111-111111111111');
    expect(env[DETACHED_JOB_ENV]).toBeUndefined();
    expect(takeDetachedJobId({ [DETACHED_JOB_ENV]: '../x' })).toBeNull();
  });
});

describe('IMPL-030 — códigos de saída de `runs wait`', () => {
  it('mesmo código do comando em foreground', () => {
    expect(exitCodeForRecord({ status: 'running' })).toBeNull();
    expect(exitCodeForRecord({ status: 'finished' })).toBe(EXIT.OK);
    expect(exitCodeForRecord({ status: 'inconclusive' })).toBe(EXIT.INCONCLUSIVE);
    expect(exitCodeForRecord({ status: 'aborted', stoppedReason: 'budget' })).toBe(EXIT.BUDGET);
    expect(exitCodeForRecord({ status: 'finished', budgetExhausted: true })).toBe(EXIT.BUDGET);
    expect(exitCodeForRecord({ status: 'aborted', stoppedReason: 'cancelled' })).toBe(EXIT.SIGINT);
    expect(exitCodeForRecord({ status: 'aborted' })).toBe(EXIT.ERROR); // órfã
    expect(exitCodeForRecord({ status: 'error' })).toBe(EXIT.ERROR);
    expect(EXIT.WAIT_TIMEOUT).toBe(9);
    expect(EXIT.INCONCLUSIVE).toBe(6);
  });
});
