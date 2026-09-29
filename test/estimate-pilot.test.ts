// IMPL-050 (gap 4) — `estimate --pilot-run <runId> | --pilot-session <id>`:
// o σd do plano de poder sai do IC95% MEDIDO de um piloto gravado (sessão:
// a significância gravada; run: o teste pareado recomputado das etapas), não
// da tabela "não calibrada". Antes a doc do train mandava fazer a conta à mão.
// Zero rede: catálogo semeado em disco, porta morta no OPENROUTER_BASE_URL.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXIT } from '../src/cli/output.js';
import { pilotFromRun, pilotFromSession, pilotPairOf } from '../src/cli/pilot.js';
import { planPower, sigmaFromPilot } from '../src/stats.js';
import { fixture } from './support/sessionReportFixture.js';
import { nodeOrTsx, ROOT } from './support/cli.js';
import type { RunRecord } from '../src/types.js';

const { cmd: NODE, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));
const DEAD_BASE = 'http://127.0.0.1:9/api/v1';

describe('pilotFromRun / pilotFromSession (puros)', () => {
  it('run com régua: controle = original, campeão = o melhor pelos vereditos; IC e n medidos', () => {
    const { runs } = fixture();
    const r0 = runs.find((r) => r.id === 'r0')!;
    expect(pilotPairOf(r0)).toEqual({ controlId: 'original', championId: 'v1' });
    const p = pilotFromRun(r0);
    expect(p).toMatchObject({ source: 'run', id: 'r0', controlId: 'original', championId: 'v1', n: 6 });
    expect(p.ci95Pp[0]).toBeLessThanOrEqual(p.ci95Pp[1]);
    const plano = planPower({ n: 10, pilotCi95Pp: p.ci95Pp, pilotN: p.n });
    expect(plano.sigmaSource).toBe('pilot');
    expect(plano.uncalibrated).toBe(false);
    expect(plano.sigmaD).toBeCloseTo(sigmaFromPilot(p.ci95Pp, p.n), 12);
  });

  it('compare sem régua: 1º × 2º pelo judge-score', () => {
    const { runs } = fixture();
    const base = runs.find((r) => r.id === 'r0')!;
    const compare = {
      ...base,
      contestants: [{ id: 'm-a' }, { id: 'm-b' }, { id: 'm-c' }],
      judgeScoreByContestant: { 'm-a': 40, 'm-b': 90, 'm-c': 70 },
    } as unknown as RunRecord;
    expect(pilotPairOf(compare)).toEqual({ championId: 'm-b', controlId: 'm-c' });
  });

  it('menos de 5 pares efetivos → recusa (exit 3, estimate.pilot_unusable)', () => {
    const { runs } = fixture();
    const r0 = runs.find((r) => r.id === 'r0')!;
    const curta = { ...r0, stages: r0.stages.slice(0, 3) } as RunRecord;
    expect(() => pilotFromRun(curta)).toThrow(expect.objectContaining({ code: EXIT.CONFIG, errorCode: 'estimate.pilot_unusable' }));
  });

  it('sessão: a significância gravada (IC, nEfetivo e origem do p)', () => {
    const { session } = fixture();
    expect(pilotFromSession(session)).toEqual({
      source: 'session',
      id: 's1',
      ci95Pp: [25, 75],
      n: 6,
      pOrigin: 'holdout',
    });
  });

  it('sessão sem significância → recusa com a dica de calibrar por uma run da sessão', () => {
    const { session } = fixture({ withHoldout: false });
    const sem = { ...session, significance: null };
    try {
      pilotFromSession(sem);
      expect.unreachable();
    } catch (e) {
      const err = e as { errorCode: string; hint: string };
      expect(err.errorCode).toBe('estimate.pilot_unusable');
      expect(err.hint).toContain('--pilot-run r1');
    }
  });
});

describe('`estimate --pilot-*` pelo processo real', { timeout: 120_000 }, () => {
  let home = '';
  let cfg = '';
  beforeAll(() => {
    home = mkdtempSync(path.join(tmpdir(), 'pb-est-pilot-'));
    mkdirSync(path.join(home, 'cache'), { recursive: true });
    const modelo = (id: string) => ({ id, name: id, pricing: { prompt: 1e-6, completion: 2e-6 } });
    writeFileSync(
      path.join(home, 'cache', 'models-public.json'),
      JSON.stringify({
        v: 1,
        fetchedAt: Date.now(),
        base: DEAD_BASE,
        count: 4,
        data: ['fake/gen', 'fake/judge', 'fake/a', 'fake/b'].map(modelo),
      }),
    );
    const { session, runs } = fixture();
    mkdirSync(path.join(home, 'sessions'), { recursive: true });
    mkdirSync(path.join(home, 'runs'), { recursive: true });
    // Datas de hoje: o TTL (90 dias) não pode apagar o fixture no meio do teste.
    const hoje = new Date().toISOString();
    writeFileSync(path.join(home, 'sessions', 's1.json'), JSON.stringify({ ...session, startedAt: hoje }));
    for (const r of runs) writeFileSync(path.join(home, 'runs', `${r.id}.json`), JSON.stringify({ ...r, startedAt: hoje }));
    cfg = path.join(home, 'cfg.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        mode: 'compare',
        theme: 'suporte',
        stages: 10,
        datagenModelId: 'fake/gen',
        judgeModelIds: ['fake/judge'],
        competitorModelIds: ['fake/a', 'fake/b'],
      }),
    );
  });
  afterAll(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  function cli(args: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: home, OPENROUTER_BASE_URL: DEAD_BASE, CI: '1' };
    delete env.OPENROUTER_API_KEY;
    const r = spawnSync(NODE, [ENTRY, 'estimate', '--config', cfg, ...args, '--json'], { env, encoding: 'utf-8', timeout: 60_000 });
    return { status: r.status, json: JSON.parse(r.stdout) as Record<string, any>, stderr: r.stderr };
  }

  it('sem piloto: σd de tabela, "não calibrado"', () => {
    const r = cli([]);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(r.json.data.power).toMatchObject({ sigmaSource: 'fallback', uncalibrated: true });
    expect(r.json.data.pilot).toBeUndefined();
  });

  it('--pilot-session s1: σd calibrado pelo IC gravado da sessão', () => {
    const r = cli(['--pilot-session', 's1']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(r.json.data.power).toMatchObject({ sigmaSource: 'pilot', uncalibrated: false, n: 10 });
    expect(r.json.data.pilot).toMatchObject({ source: 'session', id: 's1', ci95Pp: [25, 75], n: 6 });
  });

  it('--pilot-run r0: σd calibrado pelo IC recomputado da run', () => {
    const r = cli(['--pilot-run', 'r0']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(r.json.data.power.sigmaSource).toBe('pilot');
    expect(r.json.data.pilot).toMatchObject({ source: 'run', id: 'r0', controlId: 'original', championId: 'v1' });
  });

  it('piloto inexistente → exit 2 runs.not_found; as duas flags juntas → exit 2', () => {
    const a = cli(['--pilot-run', 'nao-existe']);
    expect(a.status).toBe(EXIT.USAGE);
    expect(a.json.error.code).toBe('runs.not_found');
    const b = cli(['--pilot-run', 'r0', '--pilot-session', 's1']);
    expect(b.status).toBe(EXIT.USAGE);
    expect(b.json.error.code).toBe('usage.conflicting_flags');
  });
});
