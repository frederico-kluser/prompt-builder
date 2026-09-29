// IMPL-120 — os GANCHOS de funil da telemetria opt-in: docs --list, runs
// export, 1ª run concluída da instalação e saída 7. Antes nenhum comando
// contava nada (`hooksWired: false`), e os funis que a auditoria achou
// invisíveis continuavam invisíveis mesmo com opt-in.
//
// Propriedades provadas:
//   - sem opt-in (default) NADA é contado nem gravado — nem o disco é lido;
//   - saída 7 conta `budget.exhausted` no processo que gastou, não nas
//     releituras (`runs wait` de um --detach duplicaria o evento);
//   - `run.first_completed` conta UMA vez por data dir e só quando nenhuma
//     OUTRA run concluída existe ali (as iterações da própria sessão não são
//     "outra"); quem já tinha runs antes do opt-in nunca conta;
//   - pelo processo real: `docs --list` e `runs export` gravam o contador (e o
//     data dir que ainda não existe é criado — antes o ENOENT perdia a conta).
//
// Zero rede, zero gasto.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeOrTsx } from './support/cli.js';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT } from '../src/cli/output.js';
import {
  TELEMETRY_COUNTERS_FILE,
  recordExitTelemetry,
  recordRunCompletedTelemetry,
  telemetryEventForExit,
  type TelemetryRunLike,
} from '../src/cli/commands/telemetry.js';
import { getDataDir, saveRun, setDataDir } from '../src/storage.js';
import type { RunRecord } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { cmd: NODE, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));
const DEAD_BASE = 'http://127.0.0.1:9/api/v1';
const ON = { PROMPT_BUILDER_TELEMETRY: 'on' };

let base = '';
beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'pb-telemetry-hooks-'));
});
afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function dirNovo(): string {
  return mkdtempSync(path.join(base, 'dd-'));
}

function contadores(dir: string): Record<string, number> {
  return (JSON.parse(readFileSync(path.join(dir, TELEMETRY_COUNTERS_FILE), 'utf-8')) as { counters: Record<string, number> })
    .counters;
}

describe('IMPL-120 — saída 7 → budget.exhausted', () => {
  it('só a saída 7 tem funil; releituras (`runs`/`sessions`) não contam', () => {
    expect(telemetryEventForExit('compare', EXIT.BUDGET)).toBe('budget.exhausted');
    expect(telemetryEventForExit('train', EXIT.BUDGET)).toBe('budget.exhausted');
    expect(telemetryEventForExit('agents', EXIT.BUDGET)).toBe('budget.exhausted');
    for (const code of [EXIT.OK, EXIT.USAGE, EXIT.ERROR, EXIT.SIGINT, undefined, '7']) {
      expect(telemetryEventForExit('compare', code), String(code)).toBeNull();
    }
    expect(telemetryEventForExit('runs', EXIT.BUDGET)).toBeNull();
    expect(telemetryEventForExit('sessions', EXIT.BUDGET)).toBeNull();
  });

  it('sem opt-in nada é gravado; com opt-in a saída 7 soma 1', () => {
    const dir = dirNovo();
    expect(recordExitTelemetry('compare', EXIT.BUDGET, dir, {})).toBe(false);
    expect(existsSync(path.join(dir, TELEMETRY_COUNTERS_FILE))).toBe(false);
    expect(recordExitTelemetry('compare', EXIT.OK, dir, ON)).toBe(false);
    expect(existsSync(path.join(dir, TELEMETRY_COUNTERS_FILE))).toBe(false);
    expect(recordExitTelemetry('compare', EXIT.BUDGET, dir, ON)).toBe(true);
    expect(recordExitTelemetry('runs', EXIT.BUDGET, dir, ON)).toBe(false);
    expect(contadores(dir)['budget.exhausted']).toBe(1);
  });
});

describe('IMPL-120 — run.first_completed: uma vez por instalação', () => {
  /** listPrior falso que conta as chamadas (prova que sem opt-in nada é lido). */
  function lista(runs: TelemetryRunLike[]): { fn: () => Promise<TelemetryRunLike[]>; calls: () => number } {
    let n = 0;
    return {
      fn: async () => {
        n += 1;
        return runs;
      },
      calls: () => n,
    };
  }

  it('sem opt-in: no-op sem ler o disco nem a lista de runs', async () => {
    const dir = dirNovo();
    const l = lista([]);
    expect(await recordRunCompletedTelemetry({ runId: 'r1', status: 'finished' }, dir, {}, l.fn)).toBe(false);
    expect(l.calls()).toBe(0);
    expect(existsSync(path.join(dir, TELEMETRY_COUNTERS_FILE))).toBe(false);
  });

  it('primeira run concluída conta 1; a segunda não (contador é 0/1 por data dir)', async () => {
    const dir = dirNovo();
    const l1 = lista([{ id: 'r1', status: 'finished' }]);
    expect(await recordRunCompletedTelemetry({ runId: 'r1', status: 'finished' }, dir, ON, l1.fn)).toBe(true);
    expect(contadores(dir)['run.first_completed']).toBe(1);
    const l2 = lista([
      { id: 'r1', status: 'finished' },
      { id: 'r2', status: 'finished' },
    ]);
    expect(await recordRunCompletedTelemetry({ runId: 'r2', status: 'finished' }, dir, ON, l2.fn)).toBe(false);
    expect(l2.calls()).toBe(0); // já contado: nem lista
    expect(contadores(dir)['run.first_completed']).toBe(1);
  });

  it('inconclusiva também chegou ao fim; erro/abortada não contam', async () => {
    const dir = dirNovo();
    for (const status of ['error', 'aborted', 'running']) {
      expect(await recordRunCompletedTelemetry({ runId: 'x', status }, dir, ON, lista([]).fn), status).toBe(false);
    }
    expect(await recordRunCompletedTelemetry({ runId: 'x', status: 'inconclusive' }, dir, ON, lista([]).fn)).toBe(true);
  });

  it('já havia OUTRA run concluída no data dir (antes do opt-in): não conta — não foi medido', async () => {
    const dir = dirNovo();
    const l = lista([
      { id: 'antiga', status: 'finished' },
      { id: 'r9', status: 'finished' },
    ]);
    expect(await recordRunCompletedTelemetry({ runId: 'r9', status: 'finished' }, dir, ON, l.fn)).toBe(false);
    expect(existsSync(path.join(dir, TELEMETRY_COUNTERS_FILE))).toBe(false);
  });

  it('sessão de treino: as iterações da PRÓPRIA sessão não são "outra run"', async () => {
    const dir = dirNovo();
    const l = lista([
      { id: 'it0', status: 'finished', sessionId: 's1' },
      { id: 'it1', status: 'finished', sessionId: 's1' },
      { id: 'falhou', status: 'error' },
    ]);
    expect(await recordRunCompletedTelemetry({ sessionId: 's1', status: 'finished' }, dir, ON, l.fn)).toBe(true);
  });

  it('falha ao listar nunca derruba o comando (best-effort)', async () => {
    const dir = dirNovo();
    const quebra = async (): Promise<TelemetryRunLike[]> => {
      throw new Error('disco');
    };
    await expect(recordRunCompletedTelemetry({ runId: 'r', status: 'finished' }, dir, ON, quebra)).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Processo real
// ---------------------------------------------------------------------------

function cli(args: string[], home: string, extra: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: home, OPENROUTER_BASE_URL: DEAD_BASE, ...extra };
  delete env.OPENROUTER_API_KEY;
  if (!('PROMPT_BUILDER_TELEMETRY' in extra)) delete env.PROMPT_BUILDER_TELEMETRY;
  const r = spawnSync(NODE, [ENTRY, ...args], { env, cwd: base, encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('IMPL-120 — ganchos pelo processo real', { timeout: 120_000 }, () => {
  it('`docs --list` sem opt-in não grava contador', () => {
    const home = path.join(base, 'sem-optin');
    const r = cli(['docs', '--list', '--json'], home);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(existsSync(path.join(home, TELEMETRY_COUNTERS_FILE))).toBe(false);
  });

  it('`docs --list` com opt-in conta docs.list (criando o data dir que ainda não existe)', () => {
    const home = path.join(base, 'nao-existe', 'ainda');
    const r = cli(['docs', '--list', '--json'], home, ON);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(contadores(home)['docs.list']).toBe(1);
    cli(['docs', '--json'], home, ON); // `docs` sem tópico = a lista
    expect(contadores(home)['docs.list']).toBe(2);
    // stdout segue sendo SÓ o payload
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it('`runs export` com opt-in conta runs.export', async () => {
    const home = dirNovo();
    const anterior = getDataDir();
    const id = randomUUID();
    setDataDir(home);
    try {
      await saveRun({
        id,
        status: 'finished',
        mode: 'compare',
        config: {
          mode: 'compare',
          theme: 'telemetria',
          stages: 1,
          datagenModelId: 'a/b',
          judgeModelIds: ['a/b'],
          competitorModelIds: ['a/b', 'c/d'],
        },
        contestants: [],
        stages: [],
        scoreboard: {},
        totalCostUsd: 0,
        startedAt: new Date().toISOString(),
      } as unknown as RunRecord);
    } finally {
      setDataDir(anterior);
    }
    const r = cli(['runs', 'export', id, '--json'], home, ON);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(contadores(home)['runs.export']).toBe(1);
  });
});
