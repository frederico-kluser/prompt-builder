// Ciclo de vida dos registros pelo CLI (onda 2, cluster cli-a):
//
//  • IMPL-100 (R-16:REC-6, LGPD): `runs delete <id>` apaga de verdade —
//    record, dono, `.tmp`, journal, job (o de mesmo id E o do `--detach`),
//    chave de job, registro de `--idempotency-key`, `agent-runs/<id>/` e a
//    linha do índice — com ZERO resíduo lógico no data-dir; `sessions delete`
//    leva as runs da sessão; o TTL (90 dias por default, PB_RETENTION_DAYS)
//    roda sozinho no `runs list`/`sessions list`; `runs prune` sob demanda.
//  • IMPL-089 (R-22:REC-1): `runs export --format exchange` / `sessions
//    export` → `runs|sessions import` num data-dir NOVO devolve o record
//    VERBATIM (campo desconhecido incluso); conflito nunca sobrescreve em
//    silêncio; reimportar o idêntico é idempotente.
//
// Zero rede: tudo é disco local (sem key).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { EXIT } from '../src/cli/output.js';
import { nodeOrTsx, ROOT } from './support/cli.js';

const { cmd: NODE, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));

const RUN = 'a1b2c3d4-0000-4000-8000-000000000001';
const OUTRA = 'a1b2c3d4-0000-4000-8000-000000000002';
const VELHA = 'a1b2c3d4-0000-4000-8000-000000000003';
const SESS = 'b1b2c3d4-0000-4000-8000-00000000000a';
const S_RUN1 = 'c1b2c3d4-0000-4000-8000-000000000011';
const S_RUN2 = 'c1b2c3d4-0000-4000-8000-000000000012';
const S_REEVAL = 'c1b2c3d4-0000-4000-8000-000000000013';
const JOB = 'd1b2c3d4-0000-4000-8000-0000000000ff';

let dirs: string[] = [];
function tempDir(prefixo: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefixo));
  dirs.push(d);
  return d;
}
beforeEach(() => {
  dirs = [];
});
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function cli(dataDir: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', OPENROUTER_BASE_URL: 'http://127.0.0.1:9/api/v1', ...extraEnv };
  delete env.OPENROUTER_API_KEY;
  delete env.PB_RETENTION_DAYS;
  Object.assign(env, extraEnv);
  const r = spawnSync(NODE, [ENTRY, ...args, '--data-dir', dataDir, '--json'], { env, encoding: 'utf-8', timeout: 60_000 });
  const ultima = r.stdout.trim().split('\n').at(-1) ?? '';
  let json: { ok: boolean; command: string; data?: Record<string, unknown>; error?: { code: string; hint?: string } };
  try {
    json = JSON.parse(ultima);
  } catch {
    throw new Error(`stdout não-JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`);
  }
  return { status: r.status, json, stderr: r.stderr };
}

/** O record sem o carimbo local `importedAt` (revisão w2). */
function semCarimbo(r: Record<string, unknown>): Record<string, unknown> {
  const { importedAt: _local, ...resto } = r;
  return resto;
}

function runRecord(id: string, startedAt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: 'finished',
    mode: 'compare',
    config: { mode: 'compare', theme: 'ciclo-de-vida', stages: 1 },
    contestants: [],
    stages: [],
    scoreboard: {},
    totalCostUsd: 0.01,
    startedAt,
    finishedAt: startedAt,
    // Campo que esta versão não conhece: tem de sobreviver à ida e volta.
    campoDoFuturo: { nivel: 2, lista: ['a', 'b'] },
    ...extra,
  };
}

function sessionRecord(id: string, startedAt: string): Record<string, unknown> {
  return {
    id,
    status: 'finished',
    config: { mode: 'training', theme: 'ciclo-de-vida', stages: 4, iterations: 2 },
    runIds: [S_RUN1, S_RUN2],
    reevalRunIds: [S_REEVAL],
    bestPromptByIteration: [{ iteration: 0, runId: S_RUN1, winnerContestantId: 'v1', systemPrompt: 'p', score: 1 }],
    totalCostUsd: 0.02,
    startedAt,
    finishedAt: startedAt,
    sessaoDoFuturo: true,
  };
}

function write(dataDir: string, rel: string, conteudo: unknown): void {
  const abs = path.join(dataDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo, null, 2));
}

/** Caminhos + conteúdos do data-dir que ainda citam o id. */
function residuos(dataDir: string, id: string): string[] {
  const achados: string[] = [];
  const walk = (dir: string): void => {
    for (const nome of readdirSync(dir)) {
      const abs = path.join(dir, nome);
      if (nome.includes(id)) achados.push(abs);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (readFileSync(abs, 'utf-8').includes(id)) achados.push(`${abs} (conteúdo)`);
    }
  };
  walk(dataDir);
  return achados;
}

const agora = (): string => new Date().toISOString();

describe('IMPL-100 — `runs delete` apaga com zero resíduo', { timeout: 120_000 }, () => {
  it('record + dono + .tmp + journal + jobs (inclusive o do --detach) + chaves + agent-runs + índice', () => {
    const dd = tempDir('pb-rec-del-');
    write(dd, `runs/${RUN}.json`, runRecord(RUN, agora()));
    write(dd, `runs/${RUN}.owner`, { pid: 1 });
    write(dd, `runs/${RUN}.journal`, `{"runId":"${RUN}"}\n`);
    write(dd, `runs/${RUN}.0f3a.tmp`, '{}');
    write(dd, `runs/${OUTRA}.json`, runRecord(OUTRA, agora()));
    write(
      dd,
      'runs/_index.jsonl',
      `${JSON.stringify({ summary: { id: RUN } })}\n${JSON.stringify({ summary: { id: OUTRA } })}\n`,
    );
    write(dd, `jobs/${RUN}.json`, { jobId: RUN, runId: RUN });
    write(dd, `jobs/${RUN}.log`, 'log');
    write(dd, `jobs/${RUN}.ndjson`, '{}\n');
    write(dd, `jobs/${JOB}.json`, { jobId: JOB, runId: RUN }); // job do --detach: id próprio
    write(dd, `jobs/${JOB}.log`, 'log do detach');
    write(dd, 'jobs/keys/abc123.json', { jobId: JOB });
    write(dd, 'idempotency/def456.json', { key: 'k', runId: RUN, sessionId: null });
    write(dd, `agent-runs/${RUN}/repo-cache/arquivo.txt`, 'cache');

    const r = cli(dd, ['runs', 'delete', RUN]);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(r.json).toMatchObject({ ok: true, command: 'runs.delete', data: { count: 1 } });
    expect(residuos(dd, RUN)).toEqual([]);
    // A vizinha fica intacta (inclusive a linha dela no índice).
    expect(existsSync(path.join(dd, 'runs', `${OUTRA}.json`))).toBe(true);
    expect(readFileSync(path.join(dd, 'runs', '_index.jsonl'), 'utf-8')).toContain(OUTRA);
  });

  it('id inexistente → exit 2 runs.not_found, nada apagado; id fora do formato → exit 2', () => {
    const dd = tempDir('pb-rec-del404-');
    write(dd, `runs/${OUTRA}.json`, runRecord(OUTRA, agora()));
    const r = cli(dd, ['runs', 'delete', RUN]);
    expect(r.status).toBe(EXIT.USAGE);
    expect(r.json.error?.code).toBe('runs.not_found');
    expect(existsSync(path.join(dd, 'runs', `${OUTRA}.json`))).toBe(true);
    expect(cli(dd, ['runs', 'delete', '../etc']).status).toBe(EXIT.USAGE);
    expect(cli(dd, ['runs', 'delete']).status).toBe(EXIT.USAGE);
  });

  it('`sessions delete` leva a sessão e as runs dela; `--keep-runs` preserva as runs', () => {
    const dd = tempDir('pb-rec-sdel-');
    write(dd, `sessions/${SESS}.json`, sessionRecord(SESS, agora()));
    for (const id of [S_RUN1, S_RUN2, S_REEVAL]) write(dd, `runs/${id}.json`, runRecord(id, agora(), { sessionId: SESS }));
    const r = cli(dd, ['sessions', 'delete', SESS, '--keep-runs']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(existsSync(path.join(dd, 'sessions', `${SESS}.json`))).toBe(false);
    for (const id of [S_RUN1, S_RUN2, S_REEVAL]) expect(existsSync(path.join(dd, 'runs', `${id}.json`))).toBe(true);

    write(dd, `sessions/${SESS}.json`, sessionRecord(SESS, agora()));
    const r2 = cli(dd, ['sessions', 'delete', SESS]);
    expect(r2.status, r2.stderr).toBe(EXIT.OK);
    for (const id of [SESS, S_RUN1, S_RUN2, S_REEVAL]) expect(residuos(dd, id)).toEqual([]);
  });
});

describe('modo JEV × IMPL-100 — `runs delete`/`sessions delete` alcançam jev-runs/jev-sessions', { timeout: 120_000 }, () => {
  const J_RUN = 'e1b2c3d4-0000-4000-8000-000000000021';
  const J_SESS = 'e1b2c3d4-0000-4000-8000-00000000002a';
  const J_S_RUN = 'e1b2c3d4-0000-4000-8000-000000000022';
  const jevRun = (id: string, extra: Record<string, unknown> = {}) => ({
    format: 'jev-run@1',
    id,
    status: 'finished',
    mode: 'eval',
    theme: 'jev-apagar',
    startedAt: agora(),
    totalCostUsd: 0,
    ...extra,
  });

  it('`runs delete <id JEV>` apaga o record jev-runs; running com dono vivo recusa', () => {
    const dd = tempDir('pb-rec-jev-');
    write(dd, `jev-runs/${J_RUN}.json`, jevRun(J_RUN));
    const r = cli(dd, ['runs', 'delete', J_RUN]);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(residuos(dd, J_RUN)).toEqual([]);

    // Dono = este processo de teste (vivo): nada é apagado.
    write(dd, `jev-runs/${J_RUN}.json`, jevRun(J_RUN, { status: 'running', owner: { pid: process.pid, host: os.hostname(), startToken: null } }));
    const vivo = cli(dd, ['runs', 'delete', J_RUN]);
    expect(vivo.status).toBe(EXIT.USAGE);
    expect(vivo.json.error?.code).toBe('runs.delete_running');
    expect(existsSync(path.join(dd, 'jev-runs', `${J_RUN}.json`))).toBe(true);
  });

  it('`sessions delete <id JEV>` leva a sessão JEV e as runs dela', () => {
    const dd = tempDir('pb-rec-jevs-');
    write(dd, `jev-sessions/${J_SESS}.json`, { format: 'jev-session@1', id: J_SESS, status: 'finished', theme: 't', runIds: [J_S_RUN], startedAt: agora(), totalCostUsd: 0 });
    write(dd, `jev-runs/${J_S_RUN}.json`, jevRun(J_S_RUN, { sessionId: J_SESS }));
    const r = cli(dd, ['sessions', 'delete', J_SESS]);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    for (const id of [J_SESS, J_S_RUN]) expect(residuos(dd, id)).toEqual([]);
  });
});

describe('IMPL-100 — TTL ligado por default (90 dias)', { timeout: 120_000 }, () => {
  it('`runs list` apaga a run vencida (e narra no stderr); PB_RETENTION_DAYS=0 desliga', () => {
    const dd = tempDir('pb-rec-ttl-');
    write(dd, `runs/${VELHA}.json`, runRecord(VELHA, '2020-01-01T00:00:00.000Z'));
    write(dd, `runs/${RUN}.json`, runRecord(RUN, agora()));

    const desligado = cli(dd, ['runs', 'list'], { PB_RETENTION_DAYS: '0' });
    expect(desligado.status).toBe(EXIT.OK);
    const idsDesligado = (desligado.json.data?.runs as Array<{ id: string }>).map((x) => x.id);
    expect(idsDesligado).toEqual(expect.arrayContaining([VELHA, RUN]));

    const r = cli(dd, ['runs', 'list']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const ids = (r.json.data?.runs as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toContain(RUN);
    expect(ids).not.toContain(VELHA);
    expect(existsSync(path.join(dd, 'runs', `${VELHA}.json`))).toBe(false);
    expect(r.stderr).toMatch(/retenção LGPD/);
  });

  it('`sessions list` aplica o mesmo TTL às sessões', () => {
    const dd = tempDir('pb-rec-sttl-');
    write(dd, `sessions/${SESS}.json`, sessionRecord(SESS, '2020-01-01T00:00:00.000Z'));
    const r = cli(dd, ['sessions', 'list']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    expect(existsSync(path.join(dd, 'sessions', `${SESS}.json`))).toBe(false);
  });

  it('`runs prune --older-than 30d --dry-run` só relata; sem --dry-run apaga', () => {
    const dd = tempDir('pb-rec-prune-');
    const quarentaDias = new Date(Date.now() - 40 * 86_400_000).toISOString();
    write(dd, `runs/${VELHA}.json`, runRecord(VELHA, quarentaDias));
    write(dd, `runs/${RUN}.json`, runRecord(RUN, agora()));

    const seco = cli(dd, ['runs', 'prune', '--older-than', '30d', '--dry-run']);
    expect(seco.status, seco.stderr).toBe(EXIT.OK);
    expect(seco.json.data).toMatchObject({ retentionDays: 30, dryRun: true, runs: { deleted: [VELHA] } });
    expect(existsSync(path.join(dd, 'runs', `${VELHA}.json`))).toBe(true);

    const real = cli(dd, ['runs', 'prune', '--older-than', '30d']);
    expect(real.status).toBe(EXIT.OK);
    expect(existsSync(path.join(dd, 'runs', `${VELHA}.json`))).toBe(false);
    expect(existsSync(path.join(dd, 'runs', `${RUN}.json`))).toBe(true);

    const ruim = cli(dd, ['runs', 'prune', '--older-than', 'ontem']);
    expect(ruim.status).toBe(EXIT.USAGE);
    expect(ruim.json.error?.code).toBe('usage.invalid_flag_value');
  });
});

describe('IMPL-089 — runs/sessões em prompt-builder-exchange@1 (ida e volta = identidade)', { timeout: 120_000 }, () => {
  it('`runs export --format exchange -o <dir>` → `runs import <dir>` num data-dir novo: record verbatim', () => {
    const origem = tempDir('pb-rec-exa-');
    const destino = tempDir('pb-rec-exb-');
    const pacote = path.join(tempDir('pb-rec-exp-'), 'pacote');
    const original = runRecord(RUN, agora());
    write(origem, `runs/${RUN}.json`, original);

    const ex = cli(origem, ['runs', 'export', RUN, '--format', 'exchange', '-o', pacote]);
    expect(ex.status, ex.stderr).toBe(EXIT.OK);
    expect(ex.json.data).toMatchObject({ format: 'prompt-builder-exchange@1', runs: 1, lostFields: [] });
    expect(existsSync(path.join(pacote, 'manifest.json'))).toBe(true);

    const im = cli(destino, ['runs', 'import', pacote]);
    expect(im.status, im.stderr).toBe(EXIT.OK);
    expect(im.json.data).toMatchObject({ imported: { runs: [RUN], sessions: [] } });
    const volta = JSON.parse(readFileSync(path.join(destino, 'runs', `${RUN}.json`), 'utf-8'));
    // Revisão w2: o disco guarda o record verbatim + o carimbo LOCAL de
    // importação (o TTL conta dele); o pacote re-exportado não o leva.
    expect(semCarimbo(volta)).toEqual(original);
    expect(Date.parse(volta.importedAt as string)).toBeGreaterThan(0);
    const reexport = path.join(tempDir('pb-rec-exr-'), 'de-volta.json');
    expect(cli(destino, ['runs', 'export', RUN, '--format', 'exchange', '-o', reexport]).status).toBe(EXIT.OK);
    expect(readFileSync(reexport, 'utf-8')).not.toContain('importedAt');
    const terceiro = tempDir('pb-rec-exc-');
    expect(cli(terceiro, ['runs', 'import', reexport]).status).toBe(EXIT.OK);
    expect(semCarimbo(JSON.parse(readFileSync(path.join(terceiro, 'runs', `${RUN}.json`), 'utf-8')))).toEqual(original);

    // Reimportar o idêntico é idempotente (pulado, nada muda).
    const de_novo = cli(destino, ['runs', 'import', pacote]);
    expect(de_novo.status).toBe(EXIT.OK);
    expect(de_novo.json.data).toMatchObject({ skipped: [RUN] });
  });

  // Revisão w2 (IMPL-100 × IMPL-089): o TTL media a idade pelo `startedAt`
  // ORIGINAL — importar o arquivo de uma run de > 90 dias "dava certo" e o
  // próximo `runs list` a apagava em silêncio. Agora conta da importação.
  it('importar run com startedAt além da retenção: o `runs list` seguinte NÃO a apaga', () => {
    const origem = tempDir('pb-rec-tta-');
    const destino = tempDir('pb-rec-ttb-');
    const pacote = path.join(tempDir('pb-rec-ttp-'), 'arquivo.json');
    const antiga = runRecord(VELHA, new Date(Date.now() - 200 * 86_400_000).toISOString());
    write(origem, `runs/${VELHA}.json`, antiga);
    // A origem exporta com o TTL desligado (senão ela mesma já teria apagado).
    expect(cli(origem, ['runs', 'export', VELHA, '--format', 'exchange', '-o', pacote], { PB_RETENTION_DAYS: '0' }).status).toBe(EXIT.OK);
    expect(cli(destino, ['runs', 'import', pacote]).status).toBe(EXIT.OK);
    const lista = cli(destino, ['runs', 'list']);
    expect(lista.status, lista.stderr).toBe(EXIT.OK);
    expect(existsSync(path.join(destino, 'runs', `${VELHA}.json`))).toBe(true);
    // Controle: sem o carimbo (record gravado à mão), o mesmo TTL apaga.
    const manual = tempDir('pb-rec-ttc-');
    write(manual, `runs/${VELHA}.json`, antiga);
    expect(cli(manual, ['runs', 'list']).status).toBe(EXIT.OK);
    expect(existsSync(path.join(manual, 'runs', `${VELHA}.json`))).toBe(false);
  });

  it('conflito (mesmo id, conteúdo diferente) recusa com exit 3; `--overwrite` substitui', () => {
    const origem = tempDir('pb-rec-cfa-');
    const destino = tempDir('pb-rec-cfb-');
    const arq = path.join(tempDir('pb-rec-cfp-'), 'run.json');
    write(origem, `runs/${RUN}.json`, runRecord(RUN, agora()));
    write(destino, `runs/${RUN}.json`, runRecord(RUN, agora(), { totalCostUsd: 99 }));
    expect(cli(origem, ['runs', 'export', RUN, '--format', 'exchange', '-o', arq]).status).toBe(EXIT.OK);

    const recusa = cli(destino, ['runs', 'import', arq]);
    expect(recusa.status).toBe(EXIT.CONFIG);
    expect(recusa.json.error?.code).toBe('records.import_conflict');
    expect(JSON.parse(readFileSync(path.join(destino, 'runs', `${RUN}.json`), 'utf-8')).totalCostUsd).toBe(99);

    const sobrescreve = cli(destino, ['runs', 'import', arq, '--overwrite']);
    expect(sobrescreve.status, sobrescreve.stderr).toBe(EXIT.OK);
    expect(sobrescreve.json.data).toMatchObject({ overwritten: [RUN] });
    expect(JSON.parse(readFileSync(path.join(destino, 'runs', `${RUN}.json`), 'utf-8')).totalCostUsd).toBe(0.01);
  });

  it('`sessions export` leva a sessão E as runs dela; `sessions import` devolve tudo verbatim', () => {
    const origem = tempDir('pb-rec-sxa-');
    const destino = tempDir('pb-rec-sxb-');
    const pacote = path.join(tempDir('pb-rec-sxp-'), 'sessao.json');
    const sessao = sessionRecord(SESS, agora());
    write(origem, `sessions/${SESS}.json`, sessao);
    const runs = [S_RUN1, S_RUN2, S_REEVAL].map((id) => runRecord(id, agora(), { sessionId: SESS }));
    for (const r of runs) write(origem, `runs/${r.id as string}.json`, r);

    const ex = cli(origem, ['sessions', 'export', SESS, '-o', pacote]);
    expect(ex.status, ex.stderr).toBe(EXIT.OK);
    expect(ex.json.data).toMatchObject({ sessions: 1, runs: 3, missingRunIds: [] });

    const im = cli(destino, ['sessions', 'import', pacote]);
    expect(im.status, im.stderr).toBe(EXIT.OK);
    expect(semCarimbo(JSON.parse(readFileSync(path.join(destino, 'sessions', `${SESS}.json`), 'utf-8')))).toEqual(sessao);
    for (const r of runs) {
      expect(semCarimbo(JSON.parse(readFileSync(path.join(destino, 'runs', `${r.id as string}.json`), 'utf-8')))).toEqual(r);
    }
  });

  it('pacote que não é exchange@1 → exit 3 sem gravar nada', () => {
    const destino = tempDir('pb-rec-bad-');
    const arq = path.join(tempDir('pb-rec-badp-'), 'lixo.json');
    writeFileSync(arq, JSON.stringify({ format: 'outra-coisa@1' }));
    const r = cli(destino, ['runs', 'import', arq]);
    expect(r.status).toBe(EXIT.CONFIG);
    expect(r.json.error?.code).toBe('records.exchange_invalid');
    expect(existsSync(path.join(destino, 'runs'))).toBe(false);
  });

  it('`runs export --format bogus` → exit 2 usage.invalid_flag_value', () => {
    const dd = tempDir('pb-rec-fmt-');
    write(dd, `runs/${RUN}.json`, runRecord(RUN, agora()));
    const r = cli(dd, ['runs', 'export', RUN, '--format', 'bogus']);
    expect(r.status).toBe(EXIT.USAGE);
    expect(r.json.error?.code).toBe('usage.invalid_flag_value');
  });
});
