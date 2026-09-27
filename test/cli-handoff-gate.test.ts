// Contrato do GATE DO HANDOFF (IMPL-027, R-22:REC-6).
//
// O furo: `sessions winner --apply` só avisava `holdoutSkipped` e aplicava
// direto — `holdout.regressed` nunca era lido, então um campeão PIOR que a base
// nos cenários reservados ia para produção sem bloqueio, aviso ou rastro.
//
// Provamos em duas camadas:
//   1. UNIDADE (`evaluateHandoffGuards`, puro): a matriz holdout (regredido ×
//      pulado × ausente × ok) × IC95% (contém 0 × abaixo de 0 × positivo × sem
//      IC) × judgeDrift — só `holdout.regressed` bloqueia; o resto avisa.
//   2. PROCESSO REAL (tsx): exit 10 (`gate`) com o destino INTOCADO (conteúdo,
//      backup, diretório, commit); override com motivo gravado na trilha
//      `handoffs.jsonl`, no stdout e no trailer do commit; e a métrica do
//      REC-6 — handoffs aplicados com holdout regredido sem override = 0.
//
// Nenhum teste toca a rede: as sessões são fixtures em disco, o gateway aponta
// para uma porta local fechada e não há OPENROUTER_API_KEY.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fsPromises,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateHandoffGuards,
  normalizeOverrideReason,
  type HandoffGuardInput,
  type HandoffIssueCode,
} from '../src/engine/handoffGuards.js';
import {
  appendHandoffAudit,
  ensureHandoffAuditWritable,
  readHandoffAudit,
  unsafeHandoffs,
  type HandoffAuditEntry,
} from '../src/cli/handoff.js';
import { EXIT, kindForExit, type Output } from '../src/cli/output.js';
import { BudgetExceeded, RunCancelled, isControlSignal } from '../src/budget.js';
import { getDataDir, setDataDir } from '../src/storage.js';

// --- 1. unidade ---------------------------------------------------------------

type HoldoutState = 'regressed' | 'ok' | 'skipped' | 'missing';
type CiState = 'contains0' | 'below0' | 'positive' | 'none';

function input(h: HoldoutState, ci: CiState, drift: boolean): HandoffGuardInput {
  const holdout =
    h === 'regressed'
      ? { n: 6, controlScore: 70, championScore: 61, gain: -9, regressed: true }
      : h === 'ok'
        ? { n: 6, controlScore: 60, championScore: 72, gain: 12, regressed: false }
        : undefined;
  const ci95Pp: [number, number] | null =
    ci === 'contains0' ? [-4, 9] : ci === 'below0' ? [-15, -2] : ci === 'positive' ? [3, 20] : null;
  return {
    status: 'finished',
    holdout,
    holdoutSkipped: h === 'skipped',
    significance: ci95Pp ? { n: 6, meanDiffPp: (ci95Pp[0] + ci95Pp[1]) / 2, ci95Pp, pValue: 0.2 } : null,
    judgeDrift: drift,
  };
}

const codes = (xs: { code: HandoffIssueCode }[]): HandoffIssueCode[] => xs.map((x) => x.code);

describe('evaluateHandoffGuards — matriz regredido × pulado × IC95% × drift', () => {
  const holdouts: HoldoutState[] = ['regressed', 'ok', 'skipped', 'missing'];
  const cis: CiState[] = ['contains0', 'below0', 'positive', 'none'];

  for (const h of holdouts) {
    for (const ci of cis) {
      for (const drift of [false, true]) {
        it(`holdout=${h} · IC=${ci} · drift=${drift}`, () => {
          const r = evaluateHandoffGuards(input(h, ci, drift));
          // SÓ o holdout regredido bloqueia; o resto é aviso.
          expect(r.blocked).toBe(h === 'regressed');
          expect(codes(r.blocks)).toEqual(h === 'regressed' ? ['holdout.regressed'] : []);
          expect(r.blocks.every((b) => b.severity === 'block')).toBe(true);
          expect(r.warnings.every((w) => w.severity === 'warn')).toBe(true);
          expect(r.override).toBeNull();

          const w = codes(r.warnings);
          expect(w.includes('holdout.skipped')).toBe(h === 'skipped');
          expect(w.includes('holdout.missing')).toBe(h === 'missing');
          expect(w.includes('significance.ci_contains_zero')).toBe(ci === 'contains0');
          expect(w.includes('significance.ci_below_zero')).toBe(ci === 'below0');
          expect(w.includes('significance.missing')).toBe(ci === 'none');
          expect(w.includes('judge.drift')).toBe(drift);
        });
      }
    }
  }

  it('IC95% com borda em 0 conta como "contém 0" (os dois lados)', () => {
    for (const ci95Pp of [[0, 8], [-6, 0]] as [number, number][]) {
      const r = evaluateHandoffGuards({ ...input('ok', 'positive', false), significance: { ci95Pp } });
      expect(codes(r.warnings)).toContain('significance.ci_contains_zero');
    }
  });

  it('ganho negativo sem a flag regressed (record editado à mão) também bloqueia', () => {
    const r = evaluateHandoffGuards({
      ...input('ok', 'positive', false),
      holdout: { n: 5, controlScore: 70, championScore: 65, gain: -5, regressed: false },
    });
    expect(r.blocked).toBe(true);
  });

  it('sessão não terminada avisa (o campeão pode não ser o final)', () => {
    const r = evaluateHandoffGuards({ ...input('ok', 'positive', false), status: 'running' });
    expect(codes(r.warnings)).toContain('session.unfinished');
    expect(r.blocked).toBe(false);
  });

  it('override com motivo sobrepõe o bloqueio, registra o motivo e avisa', () => {
    const r = evaluateHandoffGuards(input('regressed', 'below0', false), { overrideReason: 'motivo' });
    expect(r.blocked).toBe(false);
    expect(r.override).toEqual({ reason: 'motivo', bypassed: ['holdout.regressed'] });
    const aviso = r.warnings.find((w) => w.code === 'override.applied');
    expect(aviso?.message).toContain('motivo');
    // O bloqueio sobreposto continua listado (auditoria), só não impede.
    expect(codes(r.blocks)).toEqual(['holdout.regressed']);
  });

  it('motivo vazio/só espaços NÃO é override: o bloqueio fica de pé (fail-closed)', () => {
    for (const vazio of ['', '   ', '\n\t', null, undefined]) {
      const r = evaluateHandoffGuards(input('regressed', 'contains0', false), { overrideReason: vazio });
      expect(r.blocked).toBe(true);
      expect(r.override).toBeNull();
    }
  });

  it('override sem bloqueio a sobrepor é gravado, mas marcado como sem efeito', () => {
    const r = evaluateHandoffGuards(input('ok', 'positive', false), { overrideReason: 'por via das dúvidas' });
    expect(r.blocked).toBe(false);
    expect(r.override).toEqual({ reason: 'por via das dúvidas', bypassed: [] });
    expect(codes(r.warnings)).toContain('override.unused');
  });

  it('o motivo vira UMA linha (trailer de commit e JSONL não quebram)', () => {
    expect(normalizeOverrideReason('  decisão do PO\n  aceita a regressão\t ')).toBe('decisão do PO aceita a regressão');
    expect(normalizeOverrideReason('   ')).toBeNull();
  });

  it('exit GATE_BLOCKED = 10, kind gate', () => {
    expect(EXIT.GATE_BLOCKED).toBe(10);
    expect(kindForExit(EXIT.GATE_BLOCKED)).toBe('gate');
  });
});

// --- 2. processo real ---------------------------------------------------------

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const ENTRY = path.join(ROOT, 'src', 'cli', 'index.ts');
const DEAD_BASE = 'http://127.0.0.1:9/api/v1';
const CAMPEAO = 'Você é o prompt CAMPEÃO do treino.';
const ORIGINAL = 'prompt de produção ORIGINAL\n';

let home = '';
let work = '';

function sessao(id: string, extra: Record<string, unknown>): void {
  const record = {
    id,
    status: 'finished',
    config: { theme: 'tema', iterations: 2 },
    runIds: ['r0', 'r1'],
    bestPromptByIteration: [
      { iteration: 1, runId: 'r1', winnerContestantId: 'v1', systemPrompt: CAMPEAO, score: 3 },
    ],
    totalCostUsd: 0.01,
    startedAt: '2026-09-27T00:00:00.000Z',
    finishedAt: '2026-09-27T00:10:00.000Z',
    ...extra,
  };
  writeFileSync(path.join(home, 'sessions', `${id}.json`), JSON.stringify(record, null, 2));
}

const REGREDIDO = { n: 6, controlScore: 70, championScore: 61, gain: -9, regressed: true };
const OK_HOLDOUT = { n: 6, controlScore: 60, championScore: 72, gain: 12, regressed: false };

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'pb-handoff-home-'));
  work = mkdtempSync(path.join(tmpdir(), 'pb-handoff-work-'));
  mkdirSync(path.join(home, 'sessions'), { recursive: true });
  sessao('s-regredida', {
    holdout: REGREDIDO,
    significance: { n: 6, meanDiffPp: -9, ci95Pp: [-18, -1], pValue: 0.97 },
  });
  sessao('s-pulada', { holdoutSkipped: true, significance: { n: 8, meanDiffPp: 6, ci95Pp: [1, 11], pValue: 0.02 } });
  sessao('s-ic-zero', { holdout: OK_HOLDOUT, significance: { n: 6, meanDiffPp: 4, ci95Pp: [-3, 11], pValue: 0.18 } });
  sessao('s-drift', {
    holdout: OK_HOLDOUT,
    significance: { n: 6, meanDiffPp: 12, ci95Pp: [4, 20], pValue: 0.01 },
    judgeDrift: true,
  });
});

afterAll(() => {
  for (const d of [home, work]) if (d) rmSync(d, { recursive: true, force: true });
});

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): CliRun {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PROMPT_BUILDER_HOME: home,
    OPENROUTER_BASE_URL: DEAD_BASE,
    // Commit reprodutível em qualquer máquina/CI (sem depender do git config global).
    GIT_AUTHOR_NAME: 'teste',
    GIT_AUTHOR_EMAIL: 'teste@example.invalid',
    GIT_COMMITTER_NAME: 'teste',
    GIT_COMMITTER_EMAIL: 'teste@example.invalid',
    ...extraEnv,
  };
  delete env.OPENROUTER_API_KEY;
  const r = spawnSync(TSX, [ENTRY, ...args], { env, encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function git(dir: string, args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** Repo git novo com o prompt de produção ORIGINAL commitado. */
function repoComPrompt(nome: string): { dir: string; file: string } {
  const dir = path.join(work, nome);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  const file = path.join(dir, 'prompt.md');
  writeFileSync(file, ORIGINAL);
  git(dir, ['add', 'prompt.md']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return { dir, file };
}

const backups = (dir: string): string[] => readdirSync(dir).filter((f) => f.includes('.bak-'));

describe('sessions winner --apply — processo real (tsx)', { timeout: 120_000 }, () => {
  it('(1) holdout regredido sem --override: exit 10 (gate) e o destino NÃO muda (conteúdo, backup, commit)', () => {
    const { dir, file } = repoComPrompt('bloqueio');
    const headAntes = git(dir, ['rev-parse', 'HEAD']);
    const r = cli(['sessions', 'winner', 's-regredida', '--apply', file, '--commit', '--json']);

    expect(r.status).toBe(EXIT.GATE_BLOCKED);
    const env = JSON.parse(r.stdout) as {
      ok: boolean;
      error: { code: string; kind: string; hint: string; details: { applied: boolean; blocks: { code: string }[] } };
    };
    expect(env.ok).toBe(false);
    expect(env.error.kind).toBe('gate');
    expect(env.error.code).toBe('handoff.holdout_regressed');
    expect(env.error.hint).toContain('--override');
    expect(env.error.details.applied).toBe(false);
    expect(env.error.details.blocks.map((b) => b.code)).toEqual(['holdout.regressed']);

    expect(readFileSync(file, 'utf-8')).toBe(ORIGINAL);
    expect(backups(dir)).toEqual([]);
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(headAntes);
    expect(git(dir, ['status', '--porcelain'])).toBe('');
  });

  it('(1) também em texto e em NDJSON; destino inexistente nem tem o diretório criado', () => {
    const alvo = path.join(work, 'nao-existe', 'sub', 'prompt.md');
    const txt = cli(['sessions', 'winner', 's-regredida', '--apply', alvo]);
    expect(txt.status).toBe(EXIT.GATE_BLOCKED);
    expect(txt.stdout).toBe('');
    expect(txt.stderr).toContain('Handoff bloqueado');
    expect(existsSync(path.join(work, 'nao-existe'))).toBe(false);

    const nd = cli(['sessions', 'winner', 's-regredida', '--apply', alvo, '--output-format', 'ndjson']);
    expect(nd.status).toBe(EXIT.GATE_BLOCKED);
    const ultima = JSON.parse(nd.stdout.trim().split('\n').at(-1) ?? '{}') as {
      type: string;
      ok: boolean;
      error: { kind: string };
    };
    expect(ultima).toMatchObject({ type: 'result', ok: false, error: { kind: 'gate' } });
    expect(existsSync(path.join(work, 'nao-existe'))).toBe(false);
  });

  it('--override vazio é uso inválido (exit 2) e não grava nada; --override sem --apply também', () => {
    const { file } = repoComPrompt('override-vazio');
    const vazio = cli(['sessions', 'winner', 's-regredida', '--apply', file, '--override', '   ', '--json']);
    expect(vazio.status).toBe(EXIT.USAGE);
    expect(JSON.parse(vazio.stdout).error.code).toBe('usage.override_reason_required');
    expect(readFileSync(file, 'utf-8')).toBe(ORIGINAL);

    const semApply = cli(['sessions', 'winner', 's-regredida', '--override', 'motivo', '--json']);
    expect(semApply.status).toBe(EXIT.USAGE);
    expect(JSON.parse(semApply.stdout).error.code).toBe('usage.override_without_apply');
  });

  it("(2) --override 'motivo': aplica, avisa no STDOUT e grava o motivo (trilha + trailer do commit)", () => {
    const { dir, file } = repoComPrompt('override');
    const r = cli(['sessions', 'winner', 's-regredida', '--apply', file, '--commit', '--override', 'motivo']);

    expect(r.status).toBe(EXIT.OK);
    expect(readFileSync(file, 'utf-8')).toBe(`${CAMPEAO}\n`);
    // Aviso no stdout (texto): o override faz parte do resultado.
    expect(r.stdout).toContain('OVERRIDE');
    expect(r.stdout).toContain('"motivo"');

    // Trailer parseável por `git interpret-trailers --parse`.
    const mensagem = git(dir, ['log', '-1', '--format=%B']);
    const parse = spawnSync('git', ['interpret-trailers', '--parse'], { input: mensagem, encoding: 'utf-8' });
    expect(parse.stdout).toContain('Override-Reason: motivo');
    expect(parse.stdout).toContain('Override-Bypassed: holdout.regressed');
    expect(git(dir, ['log', '-1', '--format=%(trailers:key=Override-Reason,valueonly)']).trim()).toBe('motivo');
  });

  it('(2) sob --json o override e o aviso vão no payload', () => {
    const { file } = repoComPrompt('override-json');
    const r = cli(['sessions', 'winner', 's-regredida', '--apply', file, '--override', 'aceito pelo time', '--json']);
    expect(r.status).toBe(EXIT.OK);
    const { ok, data } = JSON.parse(r.stdout) as {
      ok: boolean;
      data: { applied: boolean; override: { reason: string; bypassed: string[] }; warnings: { code: string }[]; auditLog: string };
    };
    expect(ok).toBe(true);
    expect(data.applied).toBe(true);
    expect(data.override).toEqual({ reason: 'aceito pelo time', bypassed: ['holdout.regressed'] });
    expect(data.warnings.map((w) => w.code)).toContain('override.applied');
    expect(data.auditLog).toBe(path.join(home, 'handoffs.jsonl'));
  });

  it('(3) holdout pulado e IC95% contendo 0 AVISAM mas não bloqueiam', () => {
    const casos: [string, HandoffIssueCode][] = [
      ['s-pulada', 'holdout.skipped'],
      ['s-ic-zero', 'significance.ci_contains_zero'],
      ['s-drift', 'judge.drift'],
    ];
    for (const [sid, codigo] of casos) {
      const { file } = repoComPrompt(`aviso-${sid}`);
      const r = cli(['sessions', 'winner', sid, '--apply', file, '--json']);
      expect(r.status, `${sid}: ${r.stdout}${r.stderr}`).toBe(EXIT.OK);
      const { data } = JSON.parse(r.stdout) as { data: { applied: boolean; override: unknown; warnings: { code: string }[] } };
      expect(data.applied).toBe(true);
      expect(data.override).toBeNull();
      expect(data.warnings.map((w) => w.code)).toContain(codigo);
      expect(r.stderr).toContain('! '); // o aviso também é narrado no stderr
      expect(readFileSync(file, 'utf-8')).toBe(`${CAMPEAO}\n`);
    }
  });

  it('sem --apply o laudo sai no payload (wouldBlock) e --prompt-only só avisa', () => {
    const view = cli(['sessions', 'winner', 's-regredida', '--json']);
    expect(view.status).toBe(EXIT.OK);
    const { data } = JSON.parse(view.stdout) as { data: { handoff: { wouldBlock: boolean; blocks: { code: string }[] } } };
    expect(data.handoff.wouldBlock).toBe(true);
    expect(data.handoff.blocks.map((b) => b.code)).toEqual(['holdout.regressed']);

    const cru = cli(['sessions', 'winner', 's-regredida', '--prompt-only']);
    expect(cru.status).toBe(EXIT.OK);
    expect(cru.stdout).toBe(CAMPEAO);
    expect(cru.stderr).toContain('REGREDIU');
    expect(cru.stderr).toContain('--apply');
  });

  it('override com trilha NÃO gravável é recusado (fail-closed): exit 2 e destino intocado', () => {
    // Outro data-dir, onde `handoffs.jsonl` é um DIRETÓRIO (EISDIR em qualquer
    // usuário, inclusive root no CI — chmod não serviria).
    const homeRuim = mkdtempSync(path.join(tmpdir(), 'pb-handoff-ro-'));
    try {
      mkdirSync(path.join(homeRuim, 'sessions'), { recursive: true });
      mkdirSync(path.join(homeRuim, 'handoffs.jsonl'));
      writeFileSync(
        path.join(homeRuim, 'sessions', 's-regredida.json'),
        readFileSync(path.join(home, 'sessions', 's-regredida.json')),
      );
      const { dir, file } = repoComPrompt('trilha-ruim');
      const r = cli(['sessions', 'winner', 's-regredida', '--apply', file, '--override', 'motivo', '--json'], {
        PROMPT_BUILDER_HOME: homeRuim,
      });
      expect(r.status).toBe(EXIT.USAGE);
      expect(JSON.parse(r.stdout).error.code).toBe('handoff.audit_unwritable');
      expect(readFileSync(file, 'utf-8')).toBe(ORIGINAL);
      expect(backups(dir)).toEqual([]);
    } finally {
      rmSync(homeRuim, { recursive: true, force: true });
    }
  });

  it('(4) métrica REC-6: na trilha, handoffs aplicados com holdout regredido sem override = 0', async () => {
    const entradas: HandoffAuditEntry[] = await readHandoffAudit(path.join(home, 'handoffs.jsonl'));
    // A trilha tem os dois lados: tentativas bloqueadas E o override aplicado.
    const bloqueadas = entradas.filter((e) => e.outcome === 'blocked');
    expect(bloqueadas.length).toBeGreaterThanOrEqual(1);
    expect(bloqueadas.every((e) => e.blocks.includes('holdout.regressed') && e.override === null)).toBe(true);
    const comOverride = entradas.filter((e) => e.outcome === 'applied' && e.override);
    expect(comOverride.map((e) => e.override?.reason)).toEqual(expect.arrayContaining(['motivo', 'aceito pelo time']));
    expect(comOverride.every((e) => e.override?.bypassed.includes('holdout.regressed'))).toBe(true);
    expect(unsafeHandoffs(entradas)).toEqual([]);
  });

  it('unsafeHandoffs detecta a violação se ela existir (prova negativa da métrica)', () => {
    const base = {
      schema: 'handoff-audit@1' as const,
      at: '2026-09-27T00:00:00.000Z',
      sessionId: 's',
      file: '/x',
      backup: null,
      committed: false,
      promptSha256: 'h',
      warnings: [],
      holdout: null,
      significance: null,
      judgeDrift: false,
    };
    const violacao: HandoffAuditEntry = { ...base, outcome: 'applied', blocks: ['holdout.regressed'], override: null };
    const legitima: HandoffAuditEntry = {
      ...base,
      outcome: 'applied',
      blocks: ['holdout.regressed'],
      override: { reason: 'ok', bypassed: ['holdout.regressed'] },
    };
    expect(unsafeHandoffs([violacao, legitima])).toEqual([violacao]);
  });
});

// --- 3. sinais de controle na trilha -------------------------------------------

describe('trilha de auditoria — sinal de controle é relançado, nunca degradado', () => {
  let dataDirAntes = '';
  let dirTrilha = '';
  beforeAll(() => {
    // Data-dir temporário: o mkdir da trilha nunca toca o ./data do repo.
    dataDirAntes = getDataDir();
    dirTrilha = mkdtempSync(path.join(tmpdir(), 'pb-handoff-unit-'));
    setDataDir(dirTrilha);
  });
  afterAll(() => {
    setDataDir(dataDirAntes);
    rmSync(dirTrilha, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const entrada = (): HandoffAuditEntry => ({
    schema: 'handoff-audit@1',
    at: '2026-09-27T00:00:00.000Z',
    sessionId: 's',
    outcome: 'applied',
    file: '/x',
    backup: null,
    committed: false,
    promptSha256: 'h',
    blocks: [],
    warnings: [],
    override: null,
    holdout: null,
    significance: null,
    judgeDrift: false,
  });

  it('appendHandoffAudit: RunCancelled/BudgetExceeded sobem; erro comum vira aviso', async () => {
    const avisos: string[] = [];
    const out = { warn: (m: string) => avisos.push(m) } as unknown as Output;
    const spy = vi.spyOn(fsPromises, 'appendFile');

    spy.mockRejectedValueOnce(new RunCancelled('SIGINT'));
    await expect(appendHandoffAudit(entrada(), out)).rejects.toSatisfy(isControlSignal);
    spy.mockRejectedValueOnce(new BudgetExceeded(2, 1, 'judge'));
    await expect(appendHandoffAudit(entrada(), out)).rejects.toSatisfy(isControlSignal);
    expect(avisos).toEqual([]);

    spy.mockRejectedValueOnce(Object.assign(new Error('disco cheio'), { code: 'ENOSPC' }));
    await expect(appendHandoffAudit(entrada(), out)).resolves.toBeNull();
    expect(avisos.join('\n')).toContain('disco cheio');
  });

  it('ensureHandoffAuditWritable: sinal de controle sobe cru; erro comum vira handoff.audit_unwritable', async () => {
    const spy = vi.spyOn(fsPromises, 'appendFile');
    spy.mockRejectedValueOnce(new RunCancelled('SIGINT'));
    await expect(ensureHandoffAuditWritable()).rejects.toSatisfy(isControlSignal);

    spy.mockRejectedValueOnce(Object.assign(new Error('somente leitura'), { code: 'EROFS' }));
    await expect(ensureHandoffAuditWritable()).rejects.toMatchObject({
      errorCode: 'handoff.audit_unwritable',
      code: EXIT.USAGE,
    });
  });
});
