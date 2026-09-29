// IMPL-081 (R-10:REC-2) — journal de retomada: crash/reload não repete chamadas
// pagas. Aqui o que depende do ARMAZENAMENTO e da morte REAL do processo (o
// núcleo e o seam do gateway estão em test/call-journal.test.ts; a retomada em
// processo nos dois motores e no CLI, em test/run-resume.test.ts):
//
//  (i)  kill -9 do motor com K chamadas concluídas + retomada em OUTRO
//       processo => só as N−K que faltavam são pagas (0 paga repetida) — o
//       journal já estava em disco (fsync por entrada);
//  (ii) o grupo competidores+julgamento NUNCA é retomado pela metade: kill no
//       MEIO do julgamento => a retomada reconstrói toda etapa (resposta +
//       veredito), pagando só as chamadas que não chegaram ao journal. (Não há
//       "commit de grupo": travar o replay até o grupo fechar faria o kill no
//       meio do julgamento pagar de novo todas as respostas — o contrário do
//       critério (i). A chave é o conteúdo do pedido, então resposta refeita =>
//       pedido do juiz novo => juiz chamado de novo; nunca nota de outra
//       resposta.)
//  (iii) record e resumo gravados numa ÚNICA transação (grava os dois ou
//       nenhum — rollback com cota simulada);
//  (iv) durability 'strict' por INSPEÇÃO do código (fsync por entrada no Node,
//       `durability: 'strict'` no IndexedDB) + perda simulada (linha rasgada
//       por kill no meio do append).

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALL_JOURNAL_FORMAT, journalEntryId, type JournalEntry } from '../src/engine/callJournal.js';
import { createGateway, setDefaultGateway } from '../src/openrouter.js';
import { planResume, resumeToCompletion } from '../src/orchestrator.js';
import {
  appendCallJournal,
  callJournalStore,
  clearCallJournal,
  loadCallJournal,
  loadRun,
  readCallJournal,
  setDataDir,
  sweepOrphanRecords,
} from '../src/storage.js';
import type { RunRecord } from '../src/types.js';
import { noSleep } from './fakeOpenRouter.js';
import { JOURNAL_COMPARE_CALLS, JOURNAL_KEY, journalPipeline } from './journalFixture.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUN_ID = 'run-journal-teste';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'pb-journal-'));
  setDataDir(dir);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const entrada = (seq: number, text: string): JournalEntry => ({
  format: CALL_JOURNAL_FORMAT,
  key: `sha256:${'a'.repeat(64)}`,
  seq,
  role: 'competitor',
  modelId: 'fake/a',
  at: '2026-09-29T00:00:00.000Z',
  result: { text, tokensIn: 1, tokensOut: 1, latencyMs: 1, cost: { usd: 0.001, source: 'usage' } },
});

// ---------------------------------------------------------------------------
// Arquivo append-only (Node)
// ---------------------------------------------------------------------------

describe('journal em disco (Node): append-only, perda simulada, limpeza', () => {
  it('perda simulada: linha rasgada por kill no meio do append é descartada; as anteriores valem (crit. iv)', async () => {
    const store = callJournalStore(RUN_ID);
    await store.append(entrada(0, 'r0'));
    await store.append(entrada(1, 'r1'));
    // O kill no meio do append seguinte deixa UMA linha incompleta no fim:
    await fs.appendFile(path.join(dir, 'runs', `${RUN_ID}.journal`), '{"t":"call","key":"abc","gro', 'utf-8');
    const lidas = await loadCallJournal(RUN_ID);
    expect(lidas.map((e) => e.result.text)).toEqual(['r0', 'r1']);
    expect((await readCallJournal(RUN_ID)).map((e) => e.key)).toEqual([journalEntryId(entrada(0, '')), journalEntryId(entrada(1, ''))]);
  });

  it('entrada adulterada/antiga (id ≠ conteúdo, formato velho, linha `commit` legada) é ignorada — paga de novo', async () => {
    await callJournalStore(RUN_ID).append(entrada(0, 'boa'));
    // id que não bate com a entrada (adulterado) e formato antigo de outra versão
    await appendCallJournal(RUN_ID, { key: 'sha256:outra#0', group: 'competitor', at: '', result: entrada(5, 'ruim') });
    await appendCallJournal(RUN_ID, { key: 'x#0', group: 'competitor', at: '', result: { format: 'call-journal@0' } });
    await fs.appendFile(path.join(dir, 'runs', `${RUN_ID}.journal`), '{"t":"commit","group":"stage:1","at":"x"}\n', 'utf-8');
    expect((await loadCallJournal(RUN_ID)).map((e) => e.result.text)).toEqual(['boa']);
  });

  it('clearCallJournal apaga só o journal (idempotente)', async () => {
    await callJournalStore(RUN_ID).append(entrada(0, 'r0'));
    await clearCallJournal(RUN_ID);
    await clearCallJournal(RUN_ID);
    expect(await loadCallJournal(RUN_ID)).toEqual([]);
  });

  it('durability strict por inspeção: fsync por entrada (Node) e durability strict (IndexedDB)', async () => {
    const fsSrc = await fs.readFile(path.join(ROOT, 'src', 'storage.ts'), 'utf-8');
    // O append do journal sincroniza o disco ANTES de fechar: entrada de chamada
    // paga confirmada = checkpoint 'strict'.
    const append = fsSrc.slice(fsSrc.indexOf('async function appendJournalLine'));
    expect(append.slice(0, append.indexOf('\n}'))).toContain('await fh.sync()');
    // E a escrita durável do record: fsync do arquivo ANTES do rename e do
    // diretório DEPOIS (IMPL-091 — ver test/storage-runstore.test.ts).
    const iSync = fsSrc.indexOf('await fh.sync()');
    const iRename = fsSrc.indexOf('await fs.rename(tmp, abs)');
    const iDirSync = fsSrc.indexOf('await fsyncDir(dir)');
    expect(iSync, 'fsync do arquivo').toBeGreaterThan(0);
    expect(iRename, 'rename DEPOIS do fsync do arquivo').toBeGreaterThan(iSync);
    expect(iDirSync, 'fsync do diretório DEPOIS do rename').toBeGreaterThan(iRename);

    const webJournal = await fs.readFile(path.join(ROOT, 'web', 'src', 'engine', 'callJournal.ts'), 'utf-8');
    const webAppend = webJournal.slice(webJournal.indexOf('export function idbCallJournalStore'));
    expect(webAppend.slice(0, webAppend.indexOf('\n}')), 'append do journal é checkpoint: strict explícito').toContain(
      "durability: 'strict'",
    );
    // …e o default do record segue strict, com o escape 'relaxed' das batidas
    // de 800 ms (SaveOpts) mantido de propósito (R-10:DEC-2).
    const webStorage = await fs.readFile(path.join(ROOT, 'web', 'src', 'engine', 'storage.ts'), 'utf-8');
    expect(webStorage).toContain("opts.durability ?? 'strict'");
  });
});

// ---------------------------------------------------------------------------
// Morte REAL do processo (SIGKILL) + retomada em outro processo
// ---------------------------------------------------------------------------

// Filho: roda a run de verdade (motor Node + pipeline falso) com K chamadas
// concluídas e o resto segurado em voo; fica vivo até o SIGKILL.
const FILHO = `
import { createGateway, setDefaultGateway } from '${path.join(ROOT, 'src', 'openrouter.js')}';
import { runToCompletion } from '${path.join(ROOT, 'src', 'orchestrator.js')}';
import { setDataDir } from '${path.join(ROOT, 'src', 'storage.js')}';
import { noSleep } from '${path.join(ROOT, 'test', 'fakeOpenRouter.js')}';
import { JOURNAL_COMPARE, JOURNAL_KEY, journalPipeline } from '${path.join(ROOT, 'test', 'journalFixture.js')}';

const [dir, runId, k] = process.argv.slice(2);
setDataDir(dir);
const fake = journalPipeline({ hangAfter: Number(k) });
setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
void runToCompletion({ ...JOURNAL_COMPARE, budgetUsd: 1 }, JOURNAL_KEY, { runId });
setInterval(() => {}, 1000); // vivo até o SIGKILL
`;

async function filhoComJournal(runId: string, k: number): Promise<ReturnType<typeof spawn>> {
  // `.mts` de propósito: top-level import ESM e o tmpdir não tem package.json.
  const script = path.join(dir, 'filho-journal.mts');
  await fs.writeFile(script, FILHO, 'utf-8');
  const filho = spawn(process.execPath, ['--import', 'tsx', script, dir, runId, String(k)], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  filho.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const limite = Date.now() + 30_000;
  for (;;) {
    if ((await loadCallJournal(runId).catch(() => [])).length >= k) break;
    if (filho.exitCode !== null || Date.now() > limite) {
      filho.kill('SIGKILL');
      throw new Error(`filho não gravou ${k} entradas: ${stderr.slice(-800)}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return filho;
}

function matar(filho: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    filho.on('exit', () => resolve());
    filho.kill('SIGKILL');
  });
}

describe('kill -9 do motor + retomada em outro processo (crit. i e ii)', () => {
  it('K=22 (meio do julgamento): SIGKILL, órfã detectada, retomada paga só N−K e fecha toda etapa', async () => {
    // N = chamadas pagas de uma run completa (conferido em test/run-resume.test.ts).
    const N = JOURNAL_COMPARE_CALLS;

    const K = 22;
    const filho = await filhoComJournal(RUN_ID, K);
    await matar(filho); // SIGKILL: nada de flush gracioso — o journal já está em disco
    expect((await loadRun(RUN_ID))?.status, 'o disco ficou com a run "running"').toBe('running');

    // Outro processo (este): o dono morreu => órfã => 'aborted', retomável.
    const varrida = await sweepOrphanRecords({ only: { kind: 'run', id: RUN_ID } });
    expect(varrida.runs).toEqual([RUN_ID]);
    const plano = await planResume(RUN_ID);
    if (!plano.ok) throw new Error(plano.reason);
    expect(plano.plan.entries).toHaveLength(K);

    const f2 = journalPipeline();
    const prev2 = setDefaultGateway(createGateway({ fetch: f2.fetch, sleep: noSleep }));
    let rec: RunRecord;
    try {
      rec = (await resumeToCompletion(plano.plan, JOURNAL_KEY)) as RunRecord;
    } finally {
      setDefaultGateway(prev2);
    }
    // (i) 0 chamada paga repetida
    expect(f2.chatRequests().length, 'pagas na retomada').toBe(N - K);
    expect(rec.resume).toMatchObject({ attempt: 2, journalCalls: K, replayedCalls: K, previousStatus: 'aborted' });
    expect(rec.totalCostUsd).toBeCloseTo(f2.billedUsd(), 10);
    // (ii) etapa inteira: resposta E veredito em todas, nenhuma cortada
    expect(rec.status, rec.error).toBe('finished');
    for (const st of rec.stages) {
      expect(st.incomplete).toBeFalsy();
      expect(st.responses).toHaveLength(2);
      expect(st.referenceJudge).toBeDefined();
    }
    expect(await loadCallJournal(RUN_ID), 'concluída: journal limpo').toEqual([]);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Seam do navegador (IndexedDB): transação do record+resumo (crit. iii) e o
// adaptador do journal (crit. iv).
// ---------------------------------------------------------------------------

describe('journal no IndexedDB + record/resumo numa transação (IMPL-081)', () => {
  let fake: import('./fakeIndexedDb.js').FakeIdb;

  beforeEach(async () => {
    const { FakeIdb } = await import('./fakeIndexedDb.js');
    fake = new FakeIdb();
    const { setIdbFactory } = await import('../web/src/idb.js');
    setIdbFactory(fake.factory);
    const { resetStorageHealth } = await import('../web/src/storageHealth.js');
    resetStorageHealth();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const { setIdbFactory } = await import('../web/src/idb.js');
    setIdbFactory(undefined);
  });

  function recordWeb(id: string): RunRecord {
    return {
      id,
      status: 'done',
      mode: 'compare',
      config: { theme: 'journal web', stages: 1, competitorModelIds: ['a', 'b'] },
      contestants: [
        { id: 'a', label: 'a', modelId: 'a' },
        { id: 'b', label: 'b', modelId: 'b' },
      ],
      stages: [],
      scoreboard: {},
      totalCostUsd: 0.5,
      startedAt: '2026-01-01T00:00:00.000Z',
    } as unknown as RunRecord;
  }

  it('record e resumo entram na MESMA transação: ou os dois, ou nenhum (crit. iii)', async () => {
    const storage = await import('../web/src/engine/storage.js');
    const id = 'run-transacao';
    // Sucesso: uma transação só, com as duas stores.
    await storage.saveRun(recordWeb(id));
    const txs = fake.transactions.filter((t) => t.ops.some((o) => o.id === id));
    expect(txs, 'record + resumo = UMA transação').toHaveLength(1);
    expect(txs[0].stores.sort()).toEqual(['runSummaries', 'runs']);
    expect(txs[0].ops.map((o) => o.store).sort()).toEqual(['runSummaries', 'runs']);
    expect(await storage.loadRun(id)).not.toBeNull();
    expect((await storage.listRuns<Array<{ id: string }>>()).map((s) => s.id)).toContain(id);

    // Cota estourada no COMMIT: rollback conjunto — nem record nem resumo.
    fake.quotaBytes = 1;
    const ok = await storage.saveRun(recordWeb('run-transacao-2'));
    fake.quotaBytes = Number.POSITIVE_INFINITY;
    expect(ok, 'saveRun nunca rejeita, mas devolve false').toBe(false);
    expect(await storage.loadRun('run-transacao-2'), 'record não fica sem o resumo').toBeNull();
    expect((await storage.listRuns<Array<{ id: string }>>()).map((s) => s.id)).not.toContain('run-transacao-2');
  });

  it('adaptador IndexedDB: append strict, releitura depois do "reload", limpeza só do journal', async () => {
    const cj = await import('../web/src/engine/callJournal.js');
    const storage = await import('../web/src/engine/storage.js');
    const id = 'run-web-journal';
    const store = cj.idbCallJournalStore(id);
    expect(await store.append(entrada(0, 'r0'))).toBe(true);
    expect(await store.append(entrada(1, 'r1'))).toBe(true);
    const doJournal = fake.transactions.filter((t) => t.ops.some((o) => o.id.startsWith(`journal:${id}:`)));
    expect(doJournal).toHaveLength(2);
    for (const t of doJournal) expect(t.durability, 'checkpoint do journal = strict').toBe('strict');

    // "Reload" da aba: o estado vive no IndexedDB, não em memória.
    vi.resetModules();
    const { setIdbFactory: reinstalar } = await import('../web/src/idb.js');
    reinstalar(fake.factory);
    const cj2 = await import('../web/src/engine/callJournal.js');
    expect((await cj2.loadIdbCallJournal(id)).map((e) => e.result.text)).toEqual(['r0', 'r1']);
    // Records de run convivem na store: a limpeza apaga SÓ o journal.
    await storage.saveRun(recordWeb('run-web-journal-record'));
    await cj2.clearIdbCallJournal(id);
    expect(await cj2.loadIdbCallJournal(id)).toEqual([]);
    const storage2 = await import('../web/src/engine/storage.js');
    expect(await storage2.loadRun('run-web-journal-record'), 'records intactos').not.toBeNull();
    // loadRun nunca devolve uma entrada do journal como record
    expect(await storage2.loadRun(`journal:${id}:call:${journalEntryId(entrada(0, ''))}`)).toBeNull();
  });

  it('sem IndexedDB: o adaptador responde "unavailable" (não grava, não avisa) — a run segue', async () => {
    const { setIdbFactory } = await import('../web/src/idb.js');
    setIdbFactory(null);
    const cj = await import('../web/src/engine/callJournal.js');
    expect(await cj.idbCallJournalStore('x').append(entrada(0, 'r'))).toBe('unavailable');
    expect(await cj.loadIdbCallJournal('x')).toEqual([]);
    await expect(cj.clearIdbCallJournal('x')).resolves.toBeUndefined();
  });

  it('falha REAL de leitura SOBE (não vira []): calada, a retomada repagaria chamadas já pagas', async () => {
    const cj = await import('../web/src/engine/callJournal.js');
    const id = 'run-leitura-falha';
    expect(await cj.idbCallJournalStore(id).append(entrada(0, 'paga'))).toBe(true);
    // 'UnknownError' NÃO é 'unavailable': é falha real numa base que existe.
    fake.failNextRead('UnknownError', 1);
    await expect(cj.loadIdbCallJournal(id)).rejects.toThrow();
  });
});
