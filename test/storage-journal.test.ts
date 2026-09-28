// IMPL-081 (R-10:REC-2) — journal de retomada: crash/reload não repete chamadas
// pagas.
//
// Antes não havia journal/checkpoint/retomada em lugar nenhum (grep vazio fora
// de comentários): o saveRun guardava só o snapshot e, depois de um kill no
// meio da run, o usuário reexecutava TUDO — as chamadas já pagas eram repetidas
// do zero. O contrato verificado aqui:
//  (i) kill do motor após 3 chamadas concluídas (grupos fechados) + retomada =>
//      0 chamadas pagas repetidas — o replay devolve o resultado gravado ANTES
//      de a chamada ser refeita (teste com SIGKILL de verdade no processo que
//      gravava o journal);
//  (ii) grupo atômico (competidores+julgamento) NUNCA retomado pela metade:
//      kill em cada fase (1ª, 2ª, 3ª chamada antes do commit) => nenhuma
//      entrada é replayable e o grupo inteiro é refeito;
//  (iii) record e resumo gravados numa ÚNICA transação (grava os dois ou
//       nenhum — rollback com cota simulada);
//  (iv) durability 'strict' por INSPEÇÃO do código (fsync por entrada no Node,
//      `durability: 'strict'` no IndexedDB) + teste de perda simulada (linha
//      rasgada por kill no meio do append; commit perdido).
//
// Chave de idempotência = hash canônico de model+messages+params — paridade
// obrigatória entre os dois runtimes (o replay pode vir de outro processo).

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendCallJournal,
  callJournalKey,
  clearCallJournal,
  commitCallGroup,
  readCallJournal,
  replayCall,
  saveRun,
  setDataDir,
} from '../src/storage.js';
import type { RunRecord } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUN_ID = 'run-journal-teste';

// ---------------------------------------------------------------------------
// Chamadas de mentira (0 rede, 0 gasto): 3 chamadas pagas num grupo + 1 noutro.
// ---------------------------------------------------------------------------

interface Chamada {
  model: string;
  messages: unknown;
  params: unknown;
  group: string;
  result: unknown;
}

const CHAMADAS: Chamada[] = [
  {
    model: 'openai/gpt-4o-mini',
    messages: [
      { role: 'system', content: 'responda curto' },
      { role: 'user', content: 'pergunta 1' },
    ],
    params: { temperature: 0, max_tokens: 64 },
    group: 'stage:1:competitors+judge',
    result: { text: 'resposta paga 1', usage: { cost: 0.001 } },
  },
  {
    model: 'openai/gpt-4o-mini',
    messages: [
      { role: 'system', content: 'responda curto' },
      { role: 'user', content: 'pergunta 2' },
    ],
    params: { temperature: 0, max_tokens: 64 },
    group: 'stage:1:competitors+judge',
    result: { text: 'resposta paga 2', usage: { cost: 0.001 } },
  },
  {
    model: 'anthropic/claude-3.5-haiku',
    messages: [{ role: 'user', content: 'pergunta 3' }],
    params: { temperature: 0 },
    group: 'stage:2:competitors+judge',
    result: { text: 'resposta paga 3', usage: { cost: 0.002 } },
  },
];

const keyDe = (c: Chamada): string => callJournalKey(c.model, c.messages, c.params);

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'pb-journal-'));
  setDataDir(dir);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Filho SIGKILL-ável: grava o journal do pai até a fase pedida e fica vivo.
// ---------------------------------------------------------------------------

const FILHO = `
import { writeFileSync } from 'node:fs';
import { appendCallJournal, commitCallGroup, callJournalKey, setDataDir } from '${path.join(ROOT, 'src', 'storage.js')}';

const [dir, modo, stopAfter] = process.argv.slice(2);
setDataDir(dir);
const chamadas = ${JSON.stringify(
  CHAMADAS.map((c) => ({ model: c.model, messages: c.messages, params: c.params, group: c.group, result: c.result })),
)};

if (modo === 'fechando-grupos') {
  // 3 chamadas CONCLUÍDAS com os grupos fechados (crit. i).
  const feitos = new Set();
  for (let i = 0; i < chamadas.length; i++) {
    const c = chamadas[i];
    await appendCallJournal('${RUN_ID}', {
      key: callJournalKey(c.model, c.messages, c.params),
      group: c.group,
      at: new Date().toISOString(),
      result: c.result,
    });
    writeFileSync(dir + '/marker-c' + (i + 1), 'ok');
    feitos.add(c.group);
    const doGrupo = chamadas.filter((x) => x.group === c.group);
    const jaForam = chamadas.slice(0, i + 1).filter((x) => x.group === c.group).length;
    if (jaForam === doGrupo.length) {
      await commitCallGroup('${RUN_ID}', c.group);
      writeFileSync(dir + '/marker-g-' + c.group, 'ok');
    }
  }
} else {
  // Para em N entradas SEM commit (crit. ii: kill em cada fase do grupo).
  for (let i = 0; i < Number(stopAfter); i++) {
    const c = chamadas[i];
    await appendCallJournal('${RUN_ID}', {
      key: callJournalKey(c.model, c.messages, c.params),
      group: c.group,
      at: new Date().toISOString(),
      result: c.result,
    });
    writeFileSync(dir + '/marker-c' + (i + 1), 'ok');
  }
}
writeFileSync(dir + '/marker-pronto', 'ok');
setInterval(() => {}, 1000); // vivo até o SIGKILL
`;

async function filhoAte(marker: string, args: string[]): Promise<ReturnType<typeof spawn>> {
  // `.mts` de propósito: top-level await exige ESM e o tmpdir não tem
  // package.json com "type": "module".
  const script = path.join(dir, 'filho-journal.mts');
  await fs.writeFile(script, FILHO, 'utf-8');
  const filho = spawn(process.execPath, ['--import', 'tsx', script, dir, ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  filho.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const limite = Date.now() + 20_000;
  for (;;) {
    const ok = await fs
      .access(path.join(dir, marker))
      .then(() => true)
      .catch(() => false);
    if (ok) break;
    if (Date.now() > limite) {
      filho.kill('SIGKILL');
      throw new Error(`filho não chegou a ${marker}: ${stderr.slice(0, 500)}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return filho;
}

function matar(filho: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    filho.on('exit', () => resolve());
    filho.kill('SIGKILL');
  });
}

/** "Motor de retomada": replay antes de cada chamada; conta o que sai caro. */
async function retomar(grupos: string[]): Promise<{ pagas: number; replayadas: number }> {
  let pagas = 0;
  let replayadas = 0;
  for (const grupo of grupos) {
    for (const c of CHAMADAS.filter((x) => x.group === grupo)) {
      const hit = await replayCall(RUN_ID, keyDe(c));
      if (hit === undefined) pagas++;
      else replayadas++;
    }
  }
  return { pagas, replayadas };
}

describe('journal de chamadas: retomada idempotente (IMPL-081)', () => {
  it('chave de idempotência é paridade exata src × web e independe da ordem das chaves', async () => {
    const web = await import('../web/src/engine/storage.js');
    for (const c of CHAMADAS) {
      expect(callJournalKey(c.model, c.messages, c.params)).toBe(web.callJournalKey(c.model, c.messages, c.params));
    }
    // JCS: ordem de chaves do params não muda a identidade da chamada.
    expect(callJournalKey('m', [{ role: 'user', content: 'oi' }], { b: 2, a: 1 })).toBe(
      callJournalKey('m', [{ role: 'user', content: 'oi' }], { a: 1, b: 2 }),
    );
    // Parâmetro diferente = chamada diferente (nunca replay errado).
    expect(callJournalKey('m', [{ role: 'user', content: 'oi' }], { temperature: 0 })).not.toBe(
      callJournalKey('m', [{ role: 'user', content: 'oi' }], { temperature: 1 }),
    );
  });

  it('kill do motor após 3 chamadas concluídas + retomada => 0 chamadas pagas repetidas (crit. i)', async () => {
    // Motor 1: executa as 3 chamadas, grava o journal e fecha os grupos.
    const filho = await filhoAte('marker-pronto', ['fechando-grupos']);
    await matar(filho); // SIGKILL: nada de flush gracioso — o journal já está em disco

    // Retomada (processo novo): replay antes de cada chamada.
    const { pagas, replayadas } = await retomar(['stage:1:competitors+judge', 'stage:2:competitors+judge']);
    expect(replayadas, 'as 3 chamadas pagas vêm do journal').toBe(3);
    expect(pagas, 'chamadas pagas repetidas na retomada').toBe(0);

    // E o resultado replayado é EXATAMENTE o que foi pago.
    const hit = await replayCall<{ text: string }>(RUN_ID, keyDe(CHAMADAS[0]));
    expect(hit).toEqual(CHAMADAS[0].result);
  }, 60_000);

  it('grupo atômico nunca retomado pela metade: kill em cada fase => grupo refeito inteiro (crit. ii)', async () => {
    for (let fase = 1; fase <= 3; fase++) {
      // motor morre depois da fase-ésima chamada, ANTES do commit do grupo.
      const filho = await filhoAte(`marker-c${fase}`, ['parcial', String(fase)]);
      await matar(filho);

      // O journal guarda as `fase` chamadas já pagas…
      expect((await readCallJournal(RUN_ID)).length).toBe(fase);
      // …mas NADA do grupo aberto é replayable — nem o que já foi pago. A
      // retomada re-executa o grupo INTEIRO: 3 chamadas pagas de novo, nunca
      // etapa com resposta e sem nota.
      const { pagas, replayadas } = await retomar(['stage:1:competitors+judge', 'stage:2:competitors+judge']);
      expect(replayadas, `fase ${fase}: zero replay de grupo aberto`).toBe(0);
      expect(pagas, `fase ${fase}: o grupo inteiro é refeito`).toBe(CHAMADAS.length);

      // Re-execução completa do grupo + commit => aí sim o replay vale.
      for (const c of CHAMADAS) {
        await appendCallJournal(RUN_ID, {
          key: keyDe(c),
          group: c.group,
          at: new Date().toISOString(),
          result: c.result,
        });
      }
      await commitCallGroup(RUN_ID, 'stage:1:competitors+judge');
      await commitCallGroup(RUN_ID, 'stage:2:competitors+judge');
      const depois = await retomar(['stage:1:competitors+judge', 'stage:2:competitors+judge']);
      expect(depois.replayadas, `fase ${fase}: grupo fechado => replay total`).toBe(3);
      expect(depois.pagas).toBe(0);
      await clearCallJournal(RUN_ID); // ciclo seguinte começa limpo
    }
  }, 90_000);

  it('perda simulada: linha rasgada por kill no meio do append não derruba o journal (crit. iv)', async () => {
    for (const c of CHAMADAS.slice(0, 2)) {
      await appendCallJournal(RUN_ID, {
        key: keyDe(c),
        group: c.group,
        at: new Date().toISOString(),
        result: c.result,
      });
    }
    await commitCallJournalSafe('stage:1:competitors+judge');
    // O kill no meio do append seguinte deixa UMA linha incompleta no fim:
    await fs.appendFile(path.join(dir, 'runs', `${RUN_ID}.journal`), '{"t":"call","key":"abc","gro', 'utf-8');

    const entradas = await readCallJournal(RUN_ID);
    expect(entradas, 'as entradas com fsync sobrevivem; a rasgada é descartada').toHaveLength(2);
    const { replayadas } = await retomar(['stage:1:competitors+judge']);
    expect(replayadas).toBe(2);
  });

  it('perda simulada: commit perdido (kill antes dele) => sem replay, sem resultado meio-alvo', async () => {
    for (const c of CHAMADAS.slice(0, 2)) {
      await appendCallJournal(RUN_ID, {
        key: keyDe(c),
        group: c.group,
        at: new Date().toISOString(),
        result: c.result,
      });
    }
    // SEM commitCallGroup — o motor morreu aqui.
    for (const c of CHAMADAS.slice(0, 2)) {
      expect(await replayCall(RUN_ID, keyDe(c)), 'grupo aberto não é replayable').toBeUndefined();
    }
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

    const webSrc = await fs.readFile(path.join(ROOT, 'web', 'src', 'engine', 'storage.ts'), 'utf-8');
    const webAppend = webSrc.slice(webSrc.indexOf('export async function appendCallJournal'));
    const webCommit = webSrc.slice(webSrc.indexOf('export async function commitCallGroup'));
    expect(webAppend, 'append do journal é checkpoint: strict explícito').toContain("durability: 'strict'");
    expect(webCommit, 'commit do grupo idem').toContain("durability: 'strict'");
    // …e o default do record segue strict, com o escape 'relaxed' das batidas
    // de 800 ms (SaveOpts) mantido de propósito (R-10:DEC-2).
    expect(webSrc).toContain("opts.durability ?? 'strict'");
  });
});

async function commitCallJournalSafe(group: string): Promise<void> {
  await commitCallGroup(RUN_ID, group);
}

// ---------------------------------------------------------------------------
// Seam do navegador (IndexedDB): mesmo contrato na transação do record+resumo
// (crit. iii) e nos appends do journal.
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
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

  it('journal no IndexedDB: replay por chave, grupo atômico e limpeza', async () => {
    const storage = await import('../web/src/engine/storage.js');
    const id = 'run-web-journal';
    const c = CHAMADAS[0];
    const key = storage.callJournalKey(c.model, c.messages, c.params);
    expect(key).toBe(callJournalKey(c.model, c.messages, c.params)); // paridade src × web

    expect(await storage.appendCallJournal(id, { key, group: c.group, at: '2026-01-01T00:00:00.000Z', result: c.result })).toBe(true);
    expect(await storage.replayCall(id, key), 'grupo aberto: sem replay').toBeUndefined();
    expect(await storage.commitCallGroup(id, c.group)).toBe(true);
    expect(await storage.replayCall(id, key), 'grupo fechado: replay do resultado pago').toEqual(c.result);

    // "Reload" da aba: o estado vive no IndexedDB, não em memória. (O reload
    // também zera os módulos de idb — o fake precisa ser reinstalado neles.)
    vi.resetModules();
    const storage2 = await import('../web/src/engine/storage.js');
    const { setIdbFactory: reinstalar } = await import('../web/src/idb.js');
    reinstalar(fake.factory);
    expect(await storage2.replayCall(id, key)).toEqual(c.result);

    // Limpeza apaga SÓ o journal.
    await storage.saveRun(recordWeb('run-web-journal-record'));
    await storage2.clearCallJournal(id);
    expect(await storage2.readCallJournal(id)).toHaveLength(0);
    expect(await storage2.replayCall(id, key)).toBeUndefined();
    expect(await storage2.loadRun('run-web-journal-record'), 'records intactos').not.toBeNull();
  });

  it('appends do journal são durability strict — e as batidas do throttle podem ser relaxed', async () => {
    const storage = await import('../web/src/engine/storage.js');
    const id = 'run-durabilidade';
    const c = CHAMADAS[0];
    await storage.appendCallJournal(id, {
      key: storage.callJournalKey(c.model, c.messages, c.params),
      group: c.group,
      at: '2026-01-01T00:00:00.000Z',
      result: c.result,
    });
    await storage.commitCallGroup(id, c.group);
    await storage.saveRun(recordWeb('run-durabilidade-rec'));
    await storage.saveRun(recordWeb('run-durabilidade-rec'), { durability: 'relaxed' });

    const doJournal = fake.transactions.filter((t) => t.ops.some((o) => o.id.startsWith('journal:')));
    expect(doJournal.length, 'append + commit no journal').toBeGreaterThanOrEqual(2);
    for (const t of doJournal) {
      expect(t.durability, 'checkpoint do journal = strict').toBe('strict');
    }
    const doRecord = fake.transactions.filter(
      (t) => t.ops.some((o) => o.id === 'run-durabilidade-rec') && t.stores.includes('runSummaries'),
    );
    expect(doRecord.map((t) => t.durability), 'default strict; batida de 800 ms pode ser relaxed').toEqual(['strict', 'relaxed']);
  });
});