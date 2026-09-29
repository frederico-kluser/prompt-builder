// IMPL-088 (R-22:REC-5) — handoff com rastro: `prompt-approval@1`.
//  (1) `sessions winner --apply --record` grava todos os hashes + evidência;
//  (2) `--commit` tem trailers `Approved-by:`/`Prompt-Approval:` parseáveis por
//      `git interpret-trailers --parse`, com o registro no MESMO commit;
//  (3) 100% das aplicações levam o registro completo na trilha local
//      (`handoffs.jsonl`), com ou sem a cópia versionada;
//  (4) o hash do dataset (JCS do CONJUNTO) é estável entre execuções — ordem,
//      formatação e campos de execução não o mudam.
// Zero rede: sessão de fixture gravada em disco.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXIT } from '../src/cli/output.js';
import { buildPromptApproval, datasetHashOf, sessionDataset, PROMPT_APPROVAL_FORMAT } from '../src/cli/approval.js';
import { CHAMP, fixture } from './support/sessionReportFixture.js';
import { nodeOrTsx, ROOT } from './support/cli.js';

const { cmd: NODE, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));
const ORIGINAL = 'Prompt de produção original.\n';

let home = '';
let work = '';

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'pb-approval-home-'));
  work = mkdtempSync(path.join(tmpdir(), 'pb-approval-work-'));
  const { session, runs } = fixture();
  const hoje = new Date().toISOString();
  mkdirSync(path.join(home, 'sessions'), { recursive: true });
  mkdirSync(path.join(home, 'runs'), { recursive: true });
  writeFileSync(path.join(home, 'sessions', 's1.json'), JSON.stringify({ ...session, startedAt: hoje }));
  for (const r of runs) writeFileSync(path.join(home, 'runs', `${r.id}.json`), JSON.stringify({ ...r, startedAt: hoje }));
});
afterAll(() => {
  for (const d of [home, work]) if (d) rmSync(d, { recursive: true, force: true });
});

const IDENT = { GIT_AUTHOR_NAME: 'teste', GIT_AUTHOR_EMAIL: 'teste@example.invalid', GIT_COMMITTER_NAME: 'teste', GIT_COMMITTER_EMAIL: 'teste@example.invalid' };

function cli(args: string[], env: NodeJS.ProcessEnv = IDENT) {
  const e: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: home, OPENROUTER_BASE_URL: 'http://127.0.0.1:9/api/v1', ...env };
  delete e.OPENROUTER_API_KEY;
  const r = spawnSync(NODE, [ENTRY, ...args], { env: e, encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function git(dir: string, args: string[], input?: string): string {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf-8', env: { ...process.env, ...IDENT }, input });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function repo(nome: string): { dir: string; file: string } {
  const dir = path.join(work, nome);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  const file = path.join(dir, 'prompts', 'suporte.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, ORIGINAL);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return { dir, file };
}

describe('datasetHashOf — JCS do conjunto, estável', () => {
  const a = { question: 'q1', productContext: 'c', reference: 'r1', maxTokens: 200, origin: 'ai' };
  const b = { question: 'q2', productContext: 'c', reference: 'r2', maxTokens: 300 };

  it('ordem, formatação e campos de execução não mudam o hash; conteúdo muda', () => {
    const h1 = datasetHashOf([a, b]);
    expect(h1.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(h1.n).toBe(2);
    expect(datasetHashOf([b, a]).hash).toBe(h1.hash);
    // Mesmos dados reserializados (outra ordem de chaves) e outro maxTokens/origin.
    const a2 = JSON.parse(JSON.stringify({ reference: 'r1', productContext: 'c', question: 'q1', maxTokens: 999, origin: 'manual' }));
    expect(datasetHashOf([a2, b]).hash).toBe(h1.hash);
    // Duplicata não conta duas vezes.
    expect(datasetHashOf([a, b, a]).hash).toBe(h1.hash);
    expect(datasetHashOf([{ ...a, reference: 'outra régua' }, b]).hash).not.toBe(h1.hash);
    expect(datasetHashOf([])).toEqual({ hash: null, n: 0 });
  });
});

describe('buildPromptApproval — todos os campos', () => {
  it('hashes, sessão, runs, aprovador e a evidência do holdout/IC/custo', () => {
    const { session, runs } = fixture();
    const r0 = runs.find((r) => r.id === 'r0')!;
    const destino = path.join(work, 'fora-de-repo', 'p.md');
    const a = buildPromptApproval({ record: session, firstRun: r0, prompt: CHAMP, destino, approver: 'Ana <ana@x>', override: null });
    expect(a.format).toBe(PROMPT_APPROVAL_FORMAT);
    expect(a.approvalId).toMatch(/^pa-\d{8}-[0-9a-f]{12}$/);
    expect(a.promptHash).toBe(`sha256:${createHash('sha256').update(`${CHAMP}\n`).digest('hex')}`);
    expect(a.datasetHash).toBe(datasetHashOf(sessionDataset(session, r0).specs).hash);
    expect(a.datasetSource).toBe('iteration-0');
    expect(a.datasetSize).toBe(6);
    expect(a.configHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.sessionId).toBe('s1');
    expect(a.runIds).toEqual(['r0', 'r1', 'rh', 'rr0']);
    expect(a.approver).toBe('Ana <ana@x>');
    expect(a.evidence).toMatchObject({
      holdoutN: 6,
      controlScore: 41.67,
      championScore: 91.67,
      gain: 50,
      regressed: false,
      ci95Pp: [25, 75],
      pValue: 0.031,
      pOrigin: 'holdout',
      costUsd: 0.32,
      iterations: 2,
    });
    expect(a.git).toBeNull(); // fora de um repo
    // Estável entre execuções: o hash do dataset e o do prompt não dependem do instante.
    const b = buildPromptApproval({ record: session, firstRun: r0, prompt: CHAMP, destino, approver: 'Ana <ana@x>', override: null });
    expect(b.datasetHash).toBe(a.datasetHash);
    expect(b.promptHash).toBe(a.promptHash);
    expect(b.configHash).toBe(a.configHash);
  });
});

describe('sessions winner --apply — registro versionado e trailers (processo real)', { timeout: 120_000 }, () => {
  it('(1)(2) --commit: registro no MESMO commit, trailers parseáveis, hash do prompt confere com os bytes', () => {
    const { dir, file } = repo('commit');
    const r = cli(['sessions', 'winner', 's1', '--apply', file, '--commit', '--approver', 'Ana Revisora <ana@example.invalid>', '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const data = (JSON.parse(r.stdout) as { data: { committed: boolean; approvalFile: string; approval: { approvalId: string; promptHash: string; datasetHash: string; file: string } } }).data;
    expect(data.committed).toBe(true);
    expect(data.approvalFile).toBe(path.join(dir, '.prompt-approvals', `${data.approval.approvalId}.json`));
    expect(data.approval.file).toBe('prompts/suporte.md');

    // O registro é o do disco e o hash do prompt confere com `sha256sum`.
    const gravado = JSON.parse(readFileSync(data.approvalFile, 'utf-8')) as { promptHash: string; approver: string };
    expect(gravado).toMatchObject({ promptHash: data.approval.promptHash, approver: 'Ana Revisora <ana@example.invalid>' });
    expect(gravado.promptHash).toBe(`sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`);

    // Os dois arquivos no MESMO commit; nada pendente além do backup (`.bak-`, nunca versionado).
    const noCommit = git(dir, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort();
    expect(noCommit).toEqual([`.prompt-approvals/${data.approval.approvalId}.json`, 'prompts/suporte.md']);
    const pendentes = git(dir, ['status', '--porcelain']).split('\n').filter((l) => l.trim() && !l.includes('.bak-'));
    expect(pendentes).toEqual([]);

    const mensagem = git(dir, ['log', '-1', '--format=%B']);
    const trailers = spawnSync('git', ['interpret-trailers', '--parse'], { input: mensagem, encoding: 'utf-8' }).stdout;
    expect(trailers).toContain('Approved-by: Ana Revisora <ana@example.invalid>');
    expect(trailers).toContain(`Prompt-Approval: ${data.approval.approvalId}`);
    expect(trailers).toContain(`Prompt-Hash: ${data.approval.promptHash}`);
    expect(trailers).toContain(`Dataset-Hash: ${data.approval.datasetHash}`);
    expect(git(dir, ['log', '-1', '--format=%(trailers:key=Approved-by,valueonly)']).trim()).toBe('Ana Revisora <ana@example.invalid>');
  });

  it('sem --approver o aprovador é a identidade que o git usaria no commit', () => {
    const { file } = repo('ident');
    const r = cli(['sessions', 'winner', 's1', '--apply', file, '--commit', '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(JSON.parse(r.stdout).data.approval.approver).toBe('teste <teste@example.invalid>');
  });

  it('(4) duas aprovações da mesma sessão: MESMO datasetHash/promptHash/configHash, ids diferentes', () => {
    const a = cli(['sessions', 'winner', 's1', '--apply', repo('estavel-a').file, '--record', '--json']);
    const b = cli(['sessions', 'winner', 's1', '--apply', repo('estavel-b').file, '--record', '--json']);
    const [x, y] = [a, b].map((r) => JSON.parse(r.stdout).data.approval as Record<string, string>);
    expect(x.datasetHash).toBe(y.datasetHash);
    expect(x.promptHash).toBe(y.promptHash);
    expect(x.configHash).toBe(y.configHash);
  });

  it('--record sem --commit grava o registro e NÃO mexe no índice do git', () => {
    const { dir, file } = repo('record');
    const r = cli(['sessions', 'winner', 's1', '--apply', file, '--record', '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const data = JSON.parse(r.stdout).data as { committed: boolean; approvalFile: string };
    expect(data.committed).toBe(false);
    expect(existsSync(data.approvalFile)).toBe(true);
    expect(git(dir, ['diff', '--cached', '--name-only']).trim()).toBe('');
  });

  it('(3) toda aplicação — até sem --record — leva o registro completo na trilha local', () => {
    const { dir, file } = repo('trilha');
    const r = cli(['sessions', 'winner', 's1', '--apply', file, '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const data = JSON.parse(r.stdout).data as { approvalFile: string | null; auditLog: string };
    expect(data.approvalFile).toBeNull();
    expect(existsSync(path.join(dir, '.prompt-approvals'))).toBe(false);
    const linhas = readFileSync(data.auditLog, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const aplicadas = linhas.filter((l) => l.outcome === 'applied');
    expect(aplicadas.length).toBeGreaterThan(0);
    for (const l of aplicadas) {
      expect(l.approval.format).toBe(PROMPT_APPROVAL_FORMAT);
      for (const campo of ['approvalId', 'promptHash', 'datasetHash', 'configHash', 'sessionId', 'runIds', 'approvedAt', 'evidence']) {
        expect(l.approval[campo], campo).toBeDefined();
      }
    }
  });

  it('--commit sem aprovador identificável → exit 2 usage.approver_required, destino intocado', () => {
    const { dir, file } = repo('sem-ident');
    const semIdent: NodeJS.ProcessEnv = {
      GIT_AUTHOR_NAME: '',
      GIT_AUTHOR_EMAIL: '',
      GIT_COMMITTER_NAME: '',
      GIT_COMMITTER_EMAIL: '',
      HOME: mkdtempSync(path.join(tmpdir(), 'pb-approval-nohome-')),
      XDG_CONFIG_HOME: path.join(work, 'xdg-vazio'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.useConfigOnly',
      GIT_CONFIG_VALUE_0: 'true',
    };
    const r = cli(['sessions', 'winner', 's1', '--apply', file, '--commit', '--json'], semIdent);
    expect(r.status, r.stdout).toBe(EXIT.USAGE);
    expect(JSON.parse(r.stdout).error.code).toBe('usage.approver_required');
    expect(readFileSync(file, 'utf-8')).toBe(ORIGINAL);
    expect(readdirSync(path.dirname(file)).filter((f) => f.includes('.bak-'))).toEqual([]);
    expect(git(dir, ['status', '--porcelain'])).toBe('');
  });

  it('--record/--approver sem --apply → exit 2 usage.record_without_apply', () => {
    const r = cli(['sessions', 'winner', 's1', '--record', '--json']);
    expect(r.status).toBe(EXIT.USAGE);
    expect(JSON.parse(r.stdout).error.code).toBe('usage.record_without_apply');
  });
});
