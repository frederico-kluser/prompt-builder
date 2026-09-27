// IMPL-019 (R-07b:REC-8) — gate de CI do contrato de julgamento:
// `baseline check` sai com exit != 0 quando juiz/gabarito mudam (ou somem do
// catálogo, ou o alias/snapshot deriva) SEM re-baseline declarada. Zero rede:
// catálogo = recorte REAL de GET /models de 2026-09-27 (test/fixtures), e o
// CLI roda de verdade (tsx) para o exit code ser o que o CI veria.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildJudgeBaseline,
  checkJudgeBaseline,
  declareRebaseline,
  JUDGE_BASELINE_FORMAT,
  parseJudgeBaseline,
  type JudgeBaseline,
  type JudgeSetup,
} from '../src/engine/judgeBaseline.js';
import { snapshotModelLifecycle, type CatalogModelLike } from '../src/engine/modelLifecycle.js';
import { judgeContractHash } from '../src/engine/judgeCalibration.js';
import { JUDGE_CONTRACT_TEXT } from '../src/refJudge.js';
import { parseModelsPayload } from '../src/openrouter.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(ROOT, 'test', 'fixtures', 'models-2026-09-27.json');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const HOJE = new Date('2026-09-27T12:00:00Z');

const JUIZ = 'anthropic/claude-sonnet-5';
const GABARITO = 'openai/gpt-5-mini';
const SETUP: JudgeSetup = { judgeModelIds: [JUIZ], referenceModelId: GABARITO };
const hashFor = (s: JudgeSetup): string => judgeContractHash(s.judgeModelIds, JUDGE_CONTRACT_TEXT);

function catalogo(): CatalogModelLike[] {
  return parseModelsPayload(JSON.parse(readFileSync(FIXTURE, 'utf-8')));
}

/** Baseline pinada a partir do snapshot que a run gravou (o caminho real do `baseline pin`). */
function pinar(cat = catalogo()): JudgeBaseline {
  const lifecycle = snapshotModelLifecycle(
    { [JUIZ]: ['judge'], [GABARITO]: ['reference'] },
    cat,
    HOJE,
  );
  return buildJudgeBaseline({ setup: SETUP, contractHash: hashFor(SETUP), lifecycle, baselineRunId: 'run-base', now: HOJE })
    .baseline;
}

const semJuiz = (cat: CatalogModelLike[]) => cat.filter((m) => m.id !== JUIZ);

describe('judge-baseline@1 — formato', () => {
  it('pin a partir da run guarda juízes, gabarito, hash e o snapshot do catálogo', () => {
    const b = pinar();
    expect(b.format).toBe(JUDGE_BASELINE_FORMAT);
    expect(b.judge).toEqual({ modelIds: [JUIZ], contractHash: hashFor(SETUP) });
    expect(b.reference.modelId).toBe(GABARITO);
    expect(b.models[JUIZ]).toEqual({
      canonicalSlug: 'anthropic/claude-sonnet-5-20260630',
      aliasTarget: null,
      expirationDate: null,
    });
    // ida e volta pelo parser (o arquivo é versionado e relido no CI)
    const p = parseJudgeBaseline(JSON.parse(JSON.stringify(b)));
    expect(p.ok && p.baseline).toEqual(b);
  });

  it('parse nunca lança e explica o campo errado', () => {
    expect(parseJudgeBaseline(null)).toMatchObject({ ok: false });
    expect(parseJudgeBaseline({ format: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('format') });
    const b = JSON.parse(JSON.stringify(pinar()));
    b.rebaseline = { declaredAt: HOJE.toISOString(), judgeModelIds: ['x/y'], referenceModelId: 'x/y' };
    expect(parseJudgeBaseline(b)).toMatchObject({ ok: false, error: expect.stringContaining('reason') });
  });
});

describe('checkJudgeBaseline — o gate', () => {
  it('mesmo contrato, mesmo catálogo → passa', () => {
    const r = checkJudgeBaseline(pinar(), { catalog: catalogo(), now: HOJE, contractHashFor: hashFor });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('(iii) remoção do modelo de juiz → REPROVA sem re-baseline declarada', () => {
    const r = checkJudgeBaseline(pinar(), { catalog: semJuiz(catalogo()), now: HOJE, contractHashFor: hashFor });
    expect(r.ok).toBe(false);
    const f = r.failures.find((x) => x.kind === 'model-removed')!;
    expect(f.modelId).toBe(JUIZ);
    // A política vem junto. O alias `~anthropic/claude-sonnet-latest` apontava
    // para o PRÓPRIO juiz removido: o catálogo não nomeia sucessor, a sugestão
    // é só heurística → juiz sem sucessor nomeado = baseline invalidada.
    expect(f.successor?.source).toBe('heuristic');
    expect(f.action).toBe('invalidate-baseline');
  });

  it('(iii) juiz removido COM sucessor declarado em `successors`: ainda reprova, mas a ação é congelar + re-pontuar', () => {
    const b = { ...pinar(), successors: { [JUIZ]: 'anthropic/claude-opus-5' } };
    const r = checkJudgeBaseline(b, { catalog: semJuiz(catalogo()), now: HOJE, contractHashFor: hashFor });
    expect(r.ok).toBe(false);
    const f = r.failures.find((x) => x.kind === 'model-removed')!;
    expect(f.successor).toEqual({ id: 'anthropic/claude-opus-5', source: 'declared' });
    expect(f.action).toBe('freeze-rescore');
  });

  it('(iii) com re-baseline DECLARADA para o sucessor → passa com aviso', () => {
    const decl = declareRebaseline(
      pinar(),
      { reason: 'juiz removido do catálogo', judgeModelIds: ['anthropic/claude-opus-5'], referenceModelId: GABARITO },
      HOJE,
    );
    const r = checkJudgeBaseline(decl, { catalog: semJuiz(catalogo()), now: HOJE, contractHashFor: hashFor });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.effective.source).toBe('rebaseline');
    expect(r.warnings.map((w) => w.kind)).toContain('rebaseline-declared');
  });

  it('declaração não salva um juiz que não roda mais (config ainda aponta para o removido)', () => {
    const decl = declareRebaseline(
      pinar(),
      { reason: 'troca', judgeModelIds: ['anthropic/claude-opus-5'], referenceModelId: GABARITO },
      HOJE,
    );
    const r = checkJudgeBaseline(decl, { current: SETUP, catalog: semJuiz(catalogo()), now: HOJE, contractHashFor: hashFor });
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.kind)).toContain('model-removed');
    expect(r.warnings.map((w) => w.kind)).toContain('rebaseline-pending');
  });

  it('juiz ou gabarito trocados na config sem declaração → REPROVA', () => {
    const r = checkJudgeBaseline(pinar(), {
      current: { judgeModelIds: ['anthropic/claude-opus-5'], referenceModelId: 'openai/gpt-5-nano' },
      catalog: catalogo(),
      now: HOJE,
      contractHashFor: hashFor,
    });
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.kind).sort()).toEqual(['judge-changed', 'reference-changed']);
  });

  it('ordem dos juízes não é mudança de contrato', () => {
    const cat = catalogo();
    const dois: JudgeSetup = { judgeModelIds: [JUIZ, 'google/gemini-3.8-flash'], referenceModelId: GABARITO };
    const b = buildJudgeBaseline({ setup: dois, contractHash: hashFor(dois), catalog: cat, now: HOJE }).baseline;
    const r = checkJudgeBaseline(b, {
      current: { judgeModelIds: ['google/gemini-3.8-flash', JUIZ], referenceModelId: GABARITO },
      catalog: cat,
      now: HOJE,
      contractHashFor: hashFor,
    });
    expect(r.ok).toBe(true);
  });

  it('prompt de julgamento mudou (hash) → REPROVA; declarado com o mesmo setup → aviso', () => {
    const outroHash = (): string => 'f'.repeat(32);
    const r = checkJudgeBaseline(pinar(), { catalog: catalogo(), now: HOJE, contractHashFor: outroHash });
    expect(r.failures.map((f) => f.kind)).toEqual(['contract-changed']);
    const decl = declareRebaseline(pinar(), { reason: 'prompt do juiz v2', ...SETUP }, HOJE);
    const ok = checkJudgeBaseline(decl, { catalog: catalogo(), now: HOJE, contractHashFor: outroHash });
    expect(ok.ok).toBe(true);
    expect(ok.warnings.map((w) => w.kind)).toContain('contract-changed');
  });

  it('alias do juiz passou a apontar para outro snapshot → REPROVA (migração silenciosa)', () => {
    const alias = '~anthropic/claude-sonnet-latest';
    const cat = catalogo();
    const setup: JudgeSetup = { judgeModelIds: [alias], referenceModelId: GABARITO };
    const b = buildJudgeBaseline({ setup, contractHash: hashFor(setup), catalog: cat, now: HOJE }).baseline;
    expect(b.models[alias].aliasTarget).toBe('anthropic/claude-sonnet-5');
    const movido = cat.map((m) => (m.id === alias ? { ...m, aliasTarget: 'anthropic/claude-opus-5' } : m));
    const r = checkJudgeBaseline(b, { catalog: movido, now: HOJE, contractHashFor: hashFor });
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.kind)).toEqual(['alias-drift']);
  });

  it('canonical_slug do juiz mudou → REPROVA', () => {
    const cat = catalogo().map((m) => (m.id === JUIZ ? { ...m, canonicalSlug: 'anthropic/claude-sonnet-5-20261001' } : m));
    const r = checkJudgeBaseline(pinar(), { catalog: cat, now: HOJE, contractHashFor: hashFor });
    expect(r.failures.map((f) => f.kind)).toEqual(['slug-drift']);
  });

  it('juiz expirando em ≤ 30 dias só AVISA; catálogo indisponível REPROVA (fail-closed)', () => {
    const cat = catalogo();
    const setup: JudgeSetup = { judgeModelIds: ['google/gemini-2.5-flash'], referenceModelId: GABARITO };
    const b = buildJudgeBaseline({ setup, contractHash: hashFor(setup), catalog: cat, now: HOJE }).baseline;
    const r = checkJudgeBaseline(b, { catalog: cat, now: HOJE, contractHashFor: hashFor });
    expect(r.ok).toBe(true);
    const w = r.warnings.find((x) => x.kind === 'model-expiring')!;
    expect(w.successor?.id).toBe('google/gemini-3.8-flash');
    expect(w.action).toBe('bridge-run');
    const semCat = checkJudgeBaseline(b, { catalog: [], now: HOJE });
    expect(semCat.failures.map((f) => f.kind)).toEqual(['catalog-unavailable']);
  });
});

// --- o CLI de verdade: exit code que o CI veria --------------------------------

describe('(iii) `prompt-builder baseline` — exit code real', () => {
  let tmp: string;
  let catSemJuiz: string;

  const cli = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(TSX, ['src/cli/index.ts', 'baseline', ...args, '--data-dir', tmp], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, OPENROUTER_API_KEY: '', CI: '1' },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-baseline-'));
    mkdirSync(join(tmp, 'runs'), { recursive: true });
    // Uma run "baseline" salva no data-dir, com o snapshot de ciclo de vida.
    const record = {
      id: 'run-base',
      status: 'finished',
      mode: 'compare',
      config: {
        mode: 'compare',
        theme: 't',
        stages: 1,
        datagenModelId: 'openai/gpt-5-nano',
        judgeModelIds: [JUIZ],
        referenceModelId: GABARITO,
        competitorModelIds: ['google/gemini-3.8-flash', 'deepseek/deepseek-v4-pro'],
      },
      contestants: [],
      stages: [],
      scoreboard: {},
      totalCostUsd: 0,
      startedAt: HOJE.toISOString(),
      judgeDiagnostics: {
        contract: { hash: hashFor(SETUP), modelIds: [JUIZ], pinnedAt: HOJE.toISOString() },
        verbosity: { n: 0, r: 0, biased: false, warning: '' },
      },
      modelLifecycle: snapshotModelLifecycle({ [JUIZ]: ['judge'], [GABARITO]: ['reference'] }, catalogo(), HOJE),
    };
    writeFileSync(join(tmp, 'runs', 'run-base.json'), JSON.stringify(record));
    const raw = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as { data: { id: string }[] };
    catSemJuiz = join(tmp, 'models-sem-juiz.json');
    writeFileSync(catSemJuiz, JSON.stringify({ data: raw.data.filter((m) => m.id !== JUIZ) }));
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('pin → check passa (0) → juiz removido reprova (3) → declare → passa (0)', () => {
    const arq = join(tmp, 'judge-baseline.json');
    const pin = cli('pin', 'run-base', '-o', arq, '--catalog', FIXTURE);
    expect(pin.status, pin.stderr).toBe(0);
    const pinado = JSON.parse(readFileSync(arq, 'utf-8')) as JudgeBaseline;
    expect(pinado.baselineRunId).toBe('run-base');
    expect(pinado.models[JUIZ].canonicalSlug).toBe('anthropic/claude-sonnet-5-20260630');

    const ok = cli('check', '--file', arq, '--catalog', FIXTURE);
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);

    // Simulação da remoção do juiz: o catálogo do dia não tem mais o modelo.
    const removido = cli('check', '--file', arq, '--catalog', catSemJuiz, '--json');
    expect(removido.status).toBe(3);
    // Reprovação sai pelo envelope único de erro (IMPL-028): `error.details.report`.
    const payload = JSON.parse(removido.stdout) as {
      ok: boolean;
      error: { code: string; details: { report: { failures: { kind: string }[] } } };
    };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('config.baseline_drift');
    expect(payload.error.details.report.failures.map((f) => f.kind)).toContain('model-removed');

    // Config trocando o juiz sem declaração também reprova.
    const cfg = join(tmp, 'arena.json');
    writeFileSync(cfg, JSON.stringify({
      mode: 'compare', theme: 't', stages: 1, datagenModelId: 'openai/gpt-5-nano',
      judgeModelIds: ['anthropic/claude-opus-5'], referenceModelId: GABARITO,
      competitorModelIds: ['google/gemini-3.8-flash', 'deepseek/deepseek-v4-pro'],
    }));
    const trocado = cli('check', '--file', arq, '--config', cfg, '--catalog', catSemJuiz);
    expect(trocado.status).toBe(3);
    expect(trocado.stdout).toContain('judge-changed');

    // Re-baseline declarada para o sucessor → o mesmo cenário passa.
    const decl = cli('declare', '--file', arq, '--reason', 'juiz removido do catálogo', '--judge', 'anthropic/claude-opus-5', '--reference', GABARITO);
    expect(decl.status, decl.stderr).toBe(0);
    const depois = cli('check', '--file', arq, '--config', cfg, '--catalog', catSemJuiz);
    expect(depois.status, depois.stdout).toBe(0);
    expect(depois.stdout).toContain('rebaseline-declared');
  }, 180_000);

  it('baseline ausente é erro de config (3), não "passou"', () => {
    const r = cli('check', '--file', join(tmp, 'nao-existe.json'), '--catalog', FIXTURE);
    expect(r.status).toBe(3);
  }, 60_000);
});
