// IMPL-088 (left#9, onda 3) — `sessions winner --apply --record-dir <dir>`:
// o registro `prompt-approval@1` vai para o diretório ESCOLHIDO (implica
// `--record`), não só para `<repo>/.prompt-approvals/`. Com `--commit` o
// registro entra no MESMO commit do prompt — então o diretório tem de ficar
// dentro do repo do destino (senão exit 2 ANTES de tocar em nada).
// Zero rede: sessão de fixture gravada em disco; CLI em processo real.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXIT } from '../src/cli/output.js';
import { approvalFilePath, recordDirOutsideRepo } from '../src/cli/approval.js';
import { fixture } from './support/sessionReportFixture.js';
import { nodeOrTsx, ROOT } from './support/cli.js';

const { cmd: NODE, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));
const ORIGINAL = 'Prompt de produção original.\n';
const IDENT = {
  GIT_AUTHOR_NAME: 'teste',
  GIT_AUTHOR_EMAIL: 'teste@example.invalid',
  GIT_COMMITTER_NAME: 'teste',
  GIT_COMMITTER_EMAIL: 'teste@example.invalid',
};

let home = '';
let work = '';

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'pb-recdir-home-'));
  work = mkdtempSync(path.join(tmpdir(), 'pb-recdir-work-'));
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

function cli(args: string[]) {
  const e: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: home, OPENROUTER_BASE_URL: 'http://127.0.0.1:9/api/v1', ...IDENT };
  delete e.OPENROUTER_API_KEY;
  const r = spawnSync(NODE, [ENTRY, ...args], { env: e, encoding: 'utf-8', timeout: 60_000, cwd: work });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function git(dir: string, args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf-8', env: { ...process.env, ...IDENT } });
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

describe('approvalFilePath / recordDirOutsideRepo (puras)', () => {
  it('com recordDir: <dir>/<id>.json (relativo ao cwd); sem: <repo>/.prompt-approvals/<id>.json', () => {
    expect(approvalFilePath('/x/y/prompt.md', 'pa-1', '/tmp/aprov')).toBe(path.join('/tmp/aprov', 'pa-1.json'));
    expect(approvalFilePath('/x/y/prompt.md', 'pa-1', 'rel/dir')).toBe(path.join(process.cwd(), 'rel', 'dir', 'pa-1.json'));
    expect(approvalFilePath('/nao/existe/prompt.md', 'pa-1')).toBe(path.join('/nao/existe', '.prompt-approvals', 'pa-1.json'));
  });

  it('dentro do repo do destino = ok; fora = a raiz do repo; destino fora de repo = ok (o commit é pulado)', () => {
    const { dir, file } = repo('puras');
    expect(recordDirOutsideRepo(file, path.join(dir, 'docs', 'aprov'))).toBeNull();
    expect(recordDirOutsideRepo(file, path.join(work, 'fora'))).not.toBeNull();
    // Destino num subdiretório que ainda não existe: o repo é o do ancestral.
    expect(recordDirOutsideRepo(path.join(dir, 'novo', 'sub', 'p.md'), path.join(dir, 'aprov'))).toBeNull();
    const semRepo = mkdtempSync(path.join(tmpdir(), 'pb-recdir-semrepo-'));
    try {
      expect(recordDirOutsideRepo(path.join(semRepo, 'p.md'), path.join(work, 'qualquer'))).toBeNull();
    } finally {
      rmSync(semRepo, { recursive: true, force: true });
    }
  });
});

describe('sessions winner --apply --record-dir (processo real)', { timeout: 120_000 }, () => {
  it('--record-dir implica --record: o registro vai para o diretório escolhido, não para .prompt-approvals/', () => {
    const { dir, file } = repo('escolhido');
    const destinoRegistro = path.join(work, 'aprovacoes-fora-do-repo');
    const r = cli(['sessions', 'winner', 's1', '--apply', file, '--record-dir', destinoRegistro, '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const data = JSON.parse(r.stdout).data as { committed: boolean; approvalFile: string; approval: { approvalId: string } };
    expect(data.committed).toBe(false);
    expect(data.approvalFile).toBe(path.join(destinoRegistro, `${data.approval.approvalId}.json`));
    expect(JSON.parse(readFileSync(data.approvalFile, 'utf-8')).approvalId).toBe(data.approval.approvalId);
    expect(existsSync(path.join(dir, '.prompt-approvals'))).toBe(false);
  });

  it('relativo ao diretório atual (cwd), como o --apply', () => {
    const { file } = repo('relativo');
    const r = cli(['sessions', 'winner', 's1', '--apply', file, '--record-dir', 'registros/rel', '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const data = JSON.parse(r.stdout).data as { approvalFile: string };
    expect(data.approvalFile.startsWith(path.join(work, 'registros', 'rel') + path.sep)).toBe(true);
  });

  it('--commit com --record-dir DENTRO do repo: registro e prompt no MESMO commit', () => {
    const { dir, file } = repo('commit-dentro');
    const r = cli(['sessions', 'winner', 's1', '--apply', file, '--commit', '--record-dir', path.join(dir, 'docs', 'aprov'), '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const data = JSON.parse(r.stdout).data as { committed: boolean; approval: { approvalId: string } };
    expect(data.committed).toBe(true);
    const noCommit = git(dir, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort();
    expect(noCommit).toEqual([`docs/aprov/${data.approval.approvalId}.json`, 'prompts/suporte.md']);
  });

  it('--commit com --record-dir FORA do repo → exit 2 usage.record_dir_outside_repo, nada tocado', () => {
    const { dir, file } = repo('commit-fora');
    const antes = git(dir, ['rev-parse', 'HEAD']);
    const fora = path.join(work, 'aprov-fora');
    const r = cli(['sessions', 'winner', 's1', '--apply', file, '--commit', '--record-dir', fora, '--json']);
    expect(r.status, r.stdout).toBe(EXIT.USAGE);
    expect(JSON.parse(r.stdout).error.code).toBe('usage.record_dir_outside_repo');
    expect(readFileSync(file, 'utf-8')).toBe(ORIGINAL);
    expect(readdirSync(path.dirname(file)).filter((f) => f.includes('.bak-'))).toEqual([]);
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(antes);
    expect(existsSync(fora)).toBe(false);
  });

  it('--record-dir vazio → exit 2; --record-dir sem --apply → usage.record_without_apply', () => {
    const vazio = cli(['sessions', 'winner', 's1', '--apply', repo('vazio').file, '--record-dir', ' ', '--json']);
    expect(vazio.status).toBe(EXIT.USAGE);
    expect(JSON.parse(vazio.stdout).error.code).toBe('usage.missing_flag_value');
    const semApply = cli(['sessions', 'winner', 's1', '--record-dir', 'x', '--json']);
    expect(semApply.status).toBe(EXIT.USAGE);
    expect(JSON.parse(semApply.stdout).error.code).toBe('usage.record_without_apply');
  });

  it('argumento solto não some em silêncio: `--record <caminho>` (forma errada) → exit 2 com a dica do --record-dir', () => {
    const { dir, file } = repo('record-caminho');
    // O `--record` é booleano: `--record docs/aprov` punha "docs/aprov" em
    // positional e ele era ignorado — o registro ia para o default e o
    // usuário achava que escolhera o lugar (left#9).
    const r = cli(['sessions', 'winner', 's1', '--apply', file, '--record', 'registros/x', '--json']);
    expect(r.status, r.stdout).toBe(EXIT.USAGE);
    const erro = JSON.parse(r.stdout).error as { code: string; hint: string; details: { positionals: string[] } };
    expect(erro.code).toBe('usage.unexpected_argument');
    expect(erro.hint).toContain('--record-dir');
    expect(erro.details.positionals).toEqual(['registros/x']);
    // Nada tocado: nem prompt, nem backup, nem registro em lugar nenhum.
    expect(readFileSync(file, 'utf-8')).toBe(ORIGINAL);
    expect(readdirSync(path.dirname(file)).filter((f) => f.includes('.bak-'))).toEqual([]);
    expect(existsSync(path.join(dir, '.prompt-approvals'))).toBe(false);
    expect(existsSync(path.join(work, 'registros', 'x'))).toBe(false);
  });

  it('o mesmo guarda vale para show/report/export: `sessions show <id> <extra>` → exit 2', () => {
    const r = cli(['sessions', 'show', 's1', 'de-mais', '--json']);
    expect(r.status).toBe(EXIT.USAGE);
    const erro = JSON.parse(r.stdout).error as { code: string; hint: string };
    expect(erro.code).toBe('usage.unexpected_argument');
    expect(erro.hint).toContain('sessions show <id>');
  });
});
