// IMPL-100 (R-16:REC-6) — retenção/apagamento LGPD.
//
// Antes: sem TTL, sem `runs delete` e a SPA só apagava LOGICAMENTE (os
// tombstones do LevelDB continuam recuperáveis, crbug 40418460). Os critérios:
//
//  (1) grava run → `runs delete` (eraseRuns) → varre o diretório de dados:
//      zero resíduo lógico (record, `.tmp` da escrita atômica, dono, job,
//      cache de artefato do agente);
//  (2) run com idade > TTL ausente após o prune, com ZERO exceções;
//  (3) o wipe da SPA derruba o MESMO banco que `web/src/idb.ts` abre (contrato
//      de nome) e o `navigator.storage.estimate()` volta a ≈ 0 — aqui com o
//      fake IndexedDB; o E2E num browser REAL (Playwright
//      `launch_persistent_context`) é o `test/lgpd-wipe-e2e.test.ts`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getDataDir, saveRun, setDataDir } from '../src/storage.js';
import {
  autoPrune,
  eraseRunFiles,
  eraseRuns,
  isOlderThan as nodeIsOlderThan,
  loadRetentionPolicy,
  pruneExpiredRuns,
  resetAutoPruneThrottle,
  retentionCutoffMs as nodeRetentionCutoffMs,
  retentionReferenceMs,
  DEFAULT_RETENTION_DAYS,
  RETENTION_DAYS_ENV,
} from '../src/lgpd.js';
import {
  estimateSiteStorage,
  isOlderThan as webIsOlderThan,
  retentionCutoffMs as webRetentionCutoffMs,
  retentionDaysFor,
  siteWipeInstructions,
  wipeLocalData,
} from '../web/src/lgpd.js';
import { idbPut, idbGetAll, setIdbFactory, resetIdbConnection } from '../web/src/idb.js';
import { FakeIdb } from './fakeIndexedDb.js';
import type { RunRecord } from '../src/types.js';

const DAY = 86_400_000;

let base: string;
let prevDataDir: string;

beforeEach(() => {
  // Revisão w2: o `autoPrune` guarda um throttle POR PROCESSO — sem zerar, um
  // teste que já varreu faria o próximo pular o prune em silêncio.
  resetAutoPruneThrottle();
  base = mkdtempSync(join(tmpdir(), 'pb-lgpd-ret-'));
  prevDataDir = getDataDir();
  setDataDir(base);
});

afterEach(() => {
  setDataDir(prevDataDir);
  resetIdbConnection();
  rmSync(base, { recursive: true, force: true });
});

function runRecord(id: string, startedAt: string, status: RunRecord['status'] = 'running'): RunRecord {
  return {
    id,
    status,
    mode: 'compare',
    config: { theme: 'retencao-lgpd', stages: 1 } as unknown as RunRecord['config'],
    contestants: [],
    totalCostUsd: 0,
    startedAt,
  } as unknown as RunRecord;
}

/** Varre TODO o data-dir: caminhos + conteúdos que ainda citam o id. */
function sweepResidue(dataDir: string, id: string): string[] {
  const achados: string[] = [];
  const walk = (dir: string): void => {
    for (const nome of readdirSync(dir)) {
      const abs = join(dir, nome);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (nome === id || nome.includes(id)) achados.push(abs);
        walk(abs);
        continue;
      }
      if (nome.includes(id)) achados.push(abs);
      // resíduo LÓGICO: conteúdo que ainda aponta para a run (ex.: jobs/keys)
      if (readFileSync(abs, 'utf-8').includes(id)) achados.push(`${abs} (conteúdo)`);
    }
  };
  walk(dataDir);
  return achados;
}

describe('IMPL-100 (1) runs delete apaga a run e TODOS os resíduos', () => {
  it('grava run → eraseRuns (o "runs delete" do CLI) → varre o diretório: zero resíduo', async () => {
    const id = 'run-ret-1';
    await saveRun(runRecord(id, new Date().toISOString()));

    // resíduo REAL de escrita atômica interrompida (.tmp do writePrivateFileAtomic)
    writeFileSync(join(base, 'runs', `${id}.json.0b7c5e70-dead-beef-0000-000000000000.tmp`), '{"parcial":');
    // job do processo + log + chave de idempotência apontando para a run
    mkdirSync(join(base, 'jobs', 'keys'), { recursive: true });
    writeFileSync(join(base, 'jobs', `${id}.json`), JSON.stringify({ jobId: id }));
    writeFileSync(join(base, 'jobs', `${id}.log`), `executando ${id}`);
    writeFileSync(
      join(base, 'jobs', 'keys', `${createHash('sha256').update('k').digest('hex')}.json`),
      JSON.stringify({ jobId: id }),
    );
    // cache de artefato do agente (o "cache" do critério): agent-runs/<id>/repo-cache
    mkdirSync(join(base, 'agent-runs', id, 'repo-cache'), { recursive: true });
    writeFileSync(join(base, 'agent-runs', id, 'repo-cache', 'tree.json'), JSON.stringify({ run: id }));
    // outra run que NÃO pode ser tocada
    await saveRun(runRecord('run-intocada', new Date().toISOString(), 'done'));

    const [res] = await eraseRuns(base, [id]);
    expect(res?.removed).toEqual(expect.arrayContaining([
      `runs/${id}.json`,
      `runs/${id}.json.0b7c5e70-dead-beef-0000-000000000000.tmp`,
      `runs/${id}.owner`,
      `jobs/${id}.json`,
      `jobs/${id}.log`,
      'agent-runs/' + id,
    ]));

    expect(sweepResidue(base, id)).toEqual([]);
    // a run vizinha sobrevive inteira
    expect(readFileSync(join(base, 'runs', 'run-intocada.json'), 'utf-8')).toContain('run-intocada');
  });

  it('apagamento é idempotente e o id é validado antes de resolver caminhos', async () => {
    const id = 'run-ret-2';
    await saveRun(runRecord(id, new Date().toISOString()));
    const primeiro = await eraseRunFiles(base, id);
    expect(primeiro.removed.length).toBeGreaterThan(0);
    const segundo = await eraseRunFiles(base, id);
    expect(segundo.removed).toEqual([]);
    await expect(eraseRunFiles(base, '../../etc/passwd')).rejects.toThrow();
  });

  it('a chave de idempotência de OUTRA run não é apagada junto', async () => {
    const id = 'run-ret-3';
    await saveRun(runRecord(id, new Date().toISOString()));
    mkdirSync(join(base, 'jobs', 'keys'), { recursive: true });
    writeFileSync(join(base, 'jobs', 'keys', 'alheia.json'), JSON.stringify({ jobId: 'outra-run' }));
    await eraseRuns(base, [id]);
    expect(readdirSync(join(base, 'jobs', 'keys'))).toEqual(['alheia.json']);
  });
});

describe('IMPL-100 (2) TTL + prune automático', () => {
  it('run com idade > TTL é apagada após o prune; a recente fica (0 exceções)', async () => {
    const agora = Date.now();
    const velha = 'run-velha-1';
    const nova = 'run-nova-1';
    await saveRun(runRecord(velha, new Date(agora - 200 * DAY).toISOString()));
    await saveRun(runRecord(nova, new Date(agora - 2 * DAY).toISOString()));
    // resíduo da velha também vaza se o prune só apagar o record
    mkdirSync(join(base, 'agent-runs', velha, 'repo-cache'), { recursive: true });
    writeFileSync(join(base, 'agent-runs', velha, 'repo-cache', 'x.json'), '{}');

    const rel = await pruneExpiredRuns({ dataDir: base, now: agora, retentionDays: 90 });

    expect(rel.deleted).toEqual([velha]);
    expect(rel.kept).toEqual([nova]);
    expect(sweepResidue(base, velha)).toEqual([]);
    expect(statSync(join(base, 'runs', `${nova}.json`)).isFile()).toBe(true);
  });

  it('record corrompido e nome estranho em runs/ não derrubam o prune (0 exceções)', async () => {
    const agora = Date.now();
    mkdirSync(join(base, 'runs'), { recursive: true });
    writeFileSync(join(base, 'runs', 'corrompida.json'), 'não é json {{{');
    utimesSync(join(base, 'runs', 'corrompida.json'), new Date(agora - 400 * DAY), new Date(agora - 400 * DAY));
    writeFileSync(join(base, 'runs', 'nome invalido!.json'), '{}');
    await saveRun(runRecord('run-saudavel', new Date(agora - 1 * DAY).toISOString(), 'done'));

    const rel = await pruneExpiredRuns({ dataDir: base, now: agora, retentionDays: 90 });

    // ilegível + vencida (pelo mtime) ⇒ sai; nome fora do formato ignora; nada lança
    expect(rel.deleted).toEqual(['corrompida']);
    expect(rel.kept).toEqual(['run-saudavel']);
    expect(rel.errors).toEqual([]);
  });

  it('retentionDays: 0 desliga o TTL (nada vence por idade)', async () => {
    const agora = Date.now();
    await saveRun(runRecord('run-eterna', new Date(agora - 900 * DAY).toISOString(), 'done'));
    const rel = await pruneExpiredRuns({ dataDir: base, now: agora, retentionDays: 0 });
    expect(rel.deleted).toEqual([]);
    expect(statSync(join(base, 'runs', 'run-eterna.json')).isFile()).toBe(true);
  });

  it('política: default 90 dias do JSON; PB_RETENTION_DAYS sobrescreve; inválido cai no default', () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(90);
    expect(loadRetentionPolicy({}).retentionDays).toBe(90);
    expect(loadRetentionPolicy({ [RETENTION_DAYS_ENV]: '7' }).retentionDays).toBe(7);
    expect(loadRetentionPolicy({ [RETENTION_DAYS_ENV]: '0' }).retentionDays).toBe(0);
    expect(loadRetentionPolicy({ [RETENTION_DAYS_ENV]: 'abc' }).retentionDays).toBe(90);
    expect(loadRetentionPolicy({ [RETENTION_DAYS_ENV]: '-5' }).retentionDays).toBe(90);
  });

  it('autoPrune não rejeita e é limitado a uma varredura por intervalo', async () => {
    const agora = Date.now();
    await saveRun(runRecord('run-velha-2', new Date(agora - 200 * DAY).toISOString(), 'done'));
    const primeira = await autoPrune({ dataDir: base, now: agora, retentionDays: 90, intervalMs: 60_000 });
    expect(primeira.deleted).toEqual(['run-velha-2']);
    const segunda = await autoPrune({ dataDir: base, now: agora + 1_000, retentionDays: 90, intervalMs: 60_000 });
    expect(segunda.scanned).toBe(0); // throttled: não varreu de novo
    // Isolamento de teste: zerar o throttle faz a varredura seguinte rodar.
    resetAutoPruneThrottle();
    await saveRun(runRecord('run-velha-3', new Date(agora - 200 * DAY).toISOString(), 'done'));
    const terceira = await autoPrune({ dataDir: base, now: agora + 2_000, retentionDays: 90, intervalMs: 60_000 });
    expect(terceira.deleted).toEqual(['run-velha-3']);
  });

  // Revisão w2: record IMPORTADO conta da importação (`importedAt`), não do
  // `startedAt` original — senão o próximo `runs list` apagava o que acabou de
  // entrar pelo `runs import`.
  it('TTL: `importedAt` recente segura um record com `startedAt` antigo', async () => {
    const agora = Date.now();
    const velho = new Date(agora - 200 * DAY).toISOString();
    expect(retentionReferenceMs({ startedAt: velho, importedAt: new Date(agora).toISOString() })).toBe(agora);
    expect(retentionReferenceMs({ startedAt: velho })).toBe(Date.parse(velho));
    expect(retentionReferenceMs({ startedAt: 'lixo' })).toBeNull();
    await saveRun({ ...runRecord('run-importada', velho, 'done'), importedAt: new Date(agora - DAY).toISOString() } as never);
    await saveRun(runRecord('run-velha-4', velho, 'done'));
    const r = await pruneExpiredRuns({ dataDir: base, now: agora, retentionDays: 90 });
    expect(r.deleted).toEqual(['run-velha-4']);
    expect(r.kept).toContain('run-importada');
  });

  it('corte/idade: a MESMA semântica nos dois lados (Node × navegador)', () => {
    const agora = Date.UTC(2026, 5, 15);
    for (const dias of [1, 30, 90, 0, -1, 1.5]) {
      expect(webRetentionCutoffMs(agora, dias)).toBe(nodeRetentionCutoffMs(agora, dias));
    }
    const casos: Array<[string | number, number, boolean]> = [
      [agora - 91 * DAY, 90, true],
      [agora - 89 * DAY, 90, false],
      [agora, 90, false],
      ['2020-01-01T00:00:00.000Z', 30, true],
      ['data ilegível', 30, true],
    ];
    for (const [ref, dias, esperado] of casos) {
      expect(webIsOlderThan(ref, agora, dias), String(ref)).toBe(esperado);
      expect(nodeIsOlderThan(ref, agora, dias), String(ref)).toBe(esperado);
    }
    // limite exato: na idade == TTL ainda NÃO vence; um ms depois vence
    expect(nodeIsOlderThan(agora - 90 * DAY, agora, 90)).toBe(false);
    expect(nodeIsOlderThan(agora - 90 * DAY - 1, agora, 90)).toBe(true);
    // data ilegível não vira retenção eterna
    expect(nodeIsOlderThan('xx', agora, 90)).toBe(true);
    expect(nodeIsOlderThan('xx', agora, 0)).toBe(false);
  });

  it('TTL no navegador: override em localStorage, default do JSON', () => {
    expect(retentionDaysFor({ getItem: (k: string) => (k === 'pb.retentionDays' ? '30' : null) })).toBe(30);
    expect(retentionDaysFor({ getItem: () => null })).toBe(90);
    expect(retentionDaysFor({ getItem: () => 'x' })).toBe(90);
    expect(retentionDaysFor({ getItem: () => '0' })).toBe(0);
  });
});

describe('IMPL-100 (3) wipe da SPA: deleteDatabase do banco inteiro + estimate ≈ 0', () => {
  it('apaga o MESMO banco que o idb.ts abre e o estimate volta a zero', async () => {
    const fake = new FakeIdb();
    setIdbFactory(fake.factory);
    await idbPut('runs', { id: 'run-local-1' });
    await idbPut('prompts', { id: 'prompt-local-1' });
    expect((await idbGetAll('runs')).length).toBe(1);

    const mgr = { estimate: async () => ({ usage: fake.usedBytes(), quota: 1_000_000 }) };
    const antes = await estimateSiteStorage(mgr);
    expect(antes.usage).toBeGreaterThan(0);

    const res = await wipeLocalData({ indexedDB: fake.factory, storage: mgr });

    expect(res.deleted).toBe(true);
    expect(res.blocked).toBe(false);
    expect(res.estimateBefore.usage).toBeGreaterThan(0);
    expect(res.estimateAfter.usage).toBe(0);
    // CONTRATO DE NOME: o wipe derruba exatamente o banco que o idb.ts abriu
    // (se web/src/idb.ts trocar o DB_NAME, isto reprova em vez de apagar nada).
    expect(fake.deletedNames[0]).toBe(fake.openNames[0]);
    expect(fake.data.size).toBe(0);
    expect(await idbGetAll('runs')).toEqual([]);
  });

  it('outra aba com conexão aberta ⇒ blocked: true e nada é apagado ainda', async () => {
    const fake = new FakeIdb();
    setIdbFactory(fake.factory);
    await idbPut('runs', { id: 'run-local-2' });
    // segunda "aba": conexão segura aberta fora do idb.ts
    const extra = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = (fake.factory as IDBFactory).open('prompt-builder', 2);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const mgr = { estimate: async () => ({ usage: fake.usedBytes(), quota: 1_000_000 }) };
    const res = await wipeLocalData({ indexedDB: fake.factory, storage: mgr, blockedWaitMs: 10 });

    expect(res.deleted).toBe(false);
    expect(res.blocked).toBe(true);
    expect(fake.data.size).toBeGreaterThan(0); // intacto enquanto a aba segura
    extra.close();
  });

  it('wipe sem IndexedDB disponível reporta e não quebra; instruções cobrem o resto', async () => {
    const res = await wipeLocalData({ indexedDB: null });
    expect(res.deleted).toBe(true);
    expect(res.blocked).toBe(false);

    const passos = siteWipeInstructions();
    expect(passos.length).toBeGreaterThanOrEqual(4);
    expect(passos.join('\n')).toMatch(/limpar/iu);
    expect(passos.join('\n')).toMatch(/Excluir|Remover/u);
    // caminhos dos 3 navegadores principais
    expect(passos.join('\n')).toMatch(/Chrome/u);
    expect(passos.join('\n')).toMatch(/Firefox/u);
    expect(passos.join('\n')).toMatch(/Safari/u);
  });
});