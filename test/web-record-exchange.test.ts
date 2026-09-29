// left#11 — parte web do IMPL-089 (R-22:REC-1): o export/import JSON da SPA
// (runs e treinos) fala `prompt-builder-exchange@1`, o MESMO pacote do CLI.
//
// Antes o "JSON" da tela de run baixava o record cru — o `runs import` do CLI
// recusava — e a SPA não importava run nem sessão. Contratos, com o IndexedDB
// falso (e o CLI real no fim):
//
//  (1) ida e volta = identidade: exportar e reimportar devolve o record
//      byte a byte (campo desconhecido incluso), só com o carimbo `importedAt`;
//  (2) sessão leva as runs dela (iterações + re-avaliações);
//  (3) o pacote do CLI entra: arquivo único, envelope `--json` e o DIRETÓRIO
//      (manifest.json + *.jsonl escolhidos juntos); `lostFields` declarado na
//      origem volta no resultado; itens de biblioteca são contados, não somem
//      calados;
//  (4) formatos antigos seguem importáveis: record cru (o "JSON" antigo e o
//      do aviso de "não salvo") e `prompt-builder-run@1`;
//  (5) validação ANTES de gravar: forma inválida, `running`, conflito (mesmo
//      id, outro conteúdo) recusam o pacote inteiro — `overwrite` substitui,
//      idêntico é pulado; JEV/config/manifesto sozinho recusam com a dica;
//  (6) o backup do histórico não leva o journal de chamadas;
//  (7) o que a SPA exporta, o `runs import` do terminal importa (processo real).

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FakeIdb } from './fakeIndexedDb.js';
import { idbGet, idbPut, resetIdbConnection, setIdbFactory } from '../web/src/idb.js';
import {
  historyExchangeJson,
  importRecordFiles,
  isRecordImportError,
  readRecordPackage,
  recordShapeProblem,
  runExchangeJson,
  sessionExchangeJson,
  sessionRunIds,
  WEB_EXCHANGE_PRODUCER,
} from '../web/src/recordExchange.js';
import { buildExchangeBundle, EXCHANGE_FORMAT, parseExchangeBundle, toSingleFileBundle } from '../src/engine/exchange.js';
import { contentHash } from '../src/engine/hash.js';
import type { RunRecord, SessionRecord } from '../web/src/api.js';
import { nodeOrTsx, ROOT } from './support/cli.js';

const AGORA = '2026-09-29T12:00:00.000Z';

function run(id: string, extra: Record<string, unknown> = {}): RunRecord {
  return {
    id,
    status: 'finished',
    mode: 'compare',
    startedAt: '2026-09-01T10:00:00.000Z',
    finishedAt: '2026-09-01T10:03:00.000Z',
    config: { theme: 'suporte', stages: 1, competitorModelIds: ['fake/a'] },
    contestants: [{ id: 'fake/a', modelId: 'fake/a', label: 'A' }],
    stages: [{ index: 0, spec: { question: 'q?', productContext: 'ctx', maxTokens: 100 }, responses: [] }],
    scoreboard: {},
    totalCostUsd: 0.0123,
    // Campo que nenhuma versão conhece: tem de sobreviver à ida e volta.
    campoDoFuturo: { x: [1, 2, 3] },
    ...extra,
  } as unknown as RunRecord;
}

function sessao(id: string, runIds: string[], reevalRunId?: string): SessionRecord {
  return {
    id,
    status: 'finished',
    startedAt: '2026-09-02T10:00:00.000Z',
    config: { theme: 'suporte', iterations: 1, mode: 'training' },
    runIds,
    bestPromptByIteration: [
      {
        iteration: 0,
        runId: runIds[0],
        winnerContestantId: 'original',
        systemPrompt: 'p',
        score: 0,
        ...(reevalRunId ? { gate: { decision: 'held', reeval: { runId: reevalRunId } } } : {}),
      },
    ],
    totalCostUsd: 0.2,
  } as unknown as SessionRecord;
}

const arquivo = (name: string, text: string) => ({ name, text });

let disco: FakeIdb;
beforeEach(() => {
  disco = new FakeIdb();
  setIdbFactory(disco.factory);
});
afterEach(() => {
  resetIdbConnection();
  setIdbFactory(undefined);
});

describe('left#11 (1) ida e volta = identidade', () => {
  it('run exportada e reimportada volta igual (campo desconhecido incluso), só com importedAt', async () => {
    const original = run('run-1');
    const json = runExchangeJson({ ...original, importedAt: '2026-01-01T00:00:00.000Z' } as RunRecord);
    const pacote = JSON.parse(json);
    expect(pacote.format).toBe(EXCHANGE_FORMAT);
    expect(pacote.producer).toBe(WEB_EXCHANGE_PRODUCER);
    // O carimbo local NÃO viaja: o pacote leva o record como a origem o criou.
    const lido = parseExchangeBundle(pacote.files);
    expect(lido.ok && lido.runs).toEqual([original]);

    const res = await importRecordFiles([arquivo('run-1.json', json)], { now: () => AGORA });
    expect(res).toMatchObject({ format: 'exchange', imported: { runs: ['run-1'], sessions: [] }, skipped: [], overwritten: [] });
    const gravado = await idbGet<Record<string, unknown>>('runs', 'run-1');
    const { importedAt, ...resto } = gravado!;
    expect(importedAt).toBe(AGORA);
    expect(resto).toEqual(original);
    expect(contentHash(resto)).toBe(contentHash(original));
    // O resumo da lista entra na MESMA transação (o Histórico acha).
    expect(await idbGet('runSummaries', 'run-1')).toMatchObject({ id: 'run-1', status: 'finished' });
  });
});

describe('left#11 (2) sessão leva as runs dela', () => {
  it('iterações + re-avaliação limpa; run que falta é relatada', async () => {
    const s = sessao('sessao-1', ['run-a', 'run-b'], 'run-reeval');
    expect(sessionRunIds(s)).toEqual(['run-a', 'run-b', 'run-reeval']);
    const { json, runs, missingRunIds } = sessionExchangeJson(s, [run('run-a'), run('run-reeval'), run('outra')]);
    expect(runs).toBe(2);
    expect(missingRunIds).toEqual(['run-b']);
    const res = await importRecordFiles([arquivo('treino.json', json)]);
    expect(res.imported.sessions).toEqual(['sessao-1']);
    expect(res.imported.runs.sort()).toEqual(['run-a', 'run-reeval']);
  });
});

describe('left#11 (3) o pacote do CLI entra na SPA', () => {
  const cliBundle = () =>
    buildExchangeBundle({
      producer: 'prompt-builder-cli@0.2.0',
      runs: [run('run-cli')],
      sessions: [sessao('sessao-cli', ['run-cli'])],
      library: [{ id: 'item-1', title: 't' }],
      lostFields: { run: ['live'] },
    });

  it('arquivo único (-o arq.json) e envelope `--json`', async () => {
    const unico = JSON.stringify(toSingleFileBundle(cliBundle()));
    const res = await importRecordFiles([arquivo('pacote.json', unico)]);
    expect(res.imported).toEqual({ runs: ['run-cli'], sessions: ['sessao-cli'] });
    expect(res.lostFields).toEqual({ run: ['live'] });
    expect(res.libraryItemsIgnored).toBe(1);
    const envelope = JSON.stringify({ ok: true, command: 'runs.export', data: { bundle: toSingleFileBundle(cliBundle()) } });
    const r2 = await importRecordFiles([arquivo('saida.json', envelope)]);
    expect(r2.skipped.sort()).toEqual(['run-cli', 'sessao-cli']); // reimportar é idempotente
  });

  it('o DIRETÓRIO: manifest.json + *.jsonl escolhidos juntos', async () => {
    const b = cliBundle();
    const escolhidos = Object.entries(b.files).map(([nome, texto]) => arquivo(`pacote/${nome}`, texto));
    const res = await importRecordFiles(escolhidos);
    expect(res.format).toBe('exchange');
    expect(res.imported).toEqual({ runs: ['run-cli'], sessions: ['sessao-cli'] });
    // Faltando um .jsonl que o manifesto cita: corrupção, não silêncio.
    const semRuns = escolhidos.filter((f) => !f.name.endsWith('runs.jsonl'));
    expect(readRecordPackage(semRuns)).toMatchObject({ ok: false, error: expect.stringMatching(/falta o arquivo runs\.jsonl/) });
  });
});

describe('left#11 (4) formatos antigos seguem importáveis', () => {
  it('record cru de run/sessão (o "JSON" antigo) e prompt-builder-run@1', async () => {
    const res = await importRecordFiles([
      arquivo('run-velha.json', JSON.stringify(run('run-velha'))),
      arquivo('treino-velho.json', JSON.stringify(sessao('sessao-velha', ['run-velha']))),
    ]);
    expect(res.format).toBe('record');
    expect(res.imported).toEqual({ runs: ['run-velha'], sessions: ['sessao-velha'] });
    const artefato = { format: 'prompt-builder-run@1', exportedAt: AGORA, record: run('run-artefato'), stages: [], contestants: [], judge: {} };
    const r2 = await importRecordFiles([arquivo('artefato.json', JSON.stringify(artefato))]);
    expect(r2).toMatchObject({ format: 'run-artifact', imported: { runs: ['run-artefato'] } });
  });
});

describe('left#11 (5) validação antes de gravar', () => {
  it('forma inválida ou running recusa o pacote INTEIRO — nada é gravado', async () => {
    const ruim = { ...run('run-ok') };
    const bundle = toSingleFileBundle(
      buildExchangeBundle({ producer: 'x', runs: [ruim, { ...run('run-rodando'), status: 'running' }, { id: '../etc' }] }),
    );
    const err = await importRecordFiles([arquivo('p.json', JSON.stringify(bundle))]).catch((e: unknown) => e);
    expect(isRecordImportError(err)).toBe(true);
    const e = err as { problems: string[] };
    expect(e.problems.join(' | ')).toMatch(/running/);
    expect(e.problems.join(' | ')).toMatch(/id ausente ou fora do formato/);
    expect(await idbGet('runs', 'run-ok')).toBeUndefined();
    expect(recordShapeProblem('session', { id: 's', status: 'finished', startedAt: AGORA, config: {} })).toMatch(/runIds/);
  });

  it('conflito: recusa com a lista; overwrite substitui; idêntico é pulado', async () => {
    await importRecordFiles([arquivo('a.json', runExchangeJson(run('run-x')))]);
    const outro = runExchangeJson(run('run-x', { totalCostUsd: 9 }));
    const err = await importRecordFiles([arquivo('b.json', outro)]).catch((e: unknown) => e);
    expect(isRecordImportError(err)).toBe(true);
    expect((err as { conflicts: unknown[] }).conflicts).toEqual([{ kind: 'run', id: 'run-x' }]);
    expect((await idbGet<RunRecord>('runs', 'run-x'))?.totalCostUsd).toBe(0.0123);
    const sub = await importRecordFiles([arquivo('b.json', outro)], { overwrite: true });
    expect(sub.overwritten).toEqual(['run-x']);
    expect((await idbGet<RunRecord>('runs', 'run-x'))?.totalCostUsd).toBe(9);
    const igual = await importRecordFiles([arquivo('b.json', outro)]);
    expect(igual.skipped).toEqual(['run-x']);
  });

  it('JEV, configuração e manifesto sozinho recusam com a dica do caminho certo', () => {
    const erro = (obj: unknown) => {
      const r = readRecordPackage([arquivo('x.json', JSON.stringify(obj))]);
      return r.ok ? '' : r.error;
    };
    expect(erro({ format: 'jev-run@1', id: 'j' })).toMatch(/Importar do terminal/);
    expect(erro({ format: 'arena-config@1' })).toMatch(/Importar JSON/);
    const manifesto = buildExchangeBundle({ producer: 'x', runs: [run('r')] }).manifest;
    expect(erro(manifesto)).toMatch(/selecione junto os arquivos \.jsonl/);
    expect(erro({ nada: 1 })).toMatch(/esperado prompt-builder-exchange@1/);
    expect(readRecordPackage([arquivo('q.json', '{ruim')])).toMatchObject({ ok: false, error: expect.stringMatching(/não é JSON/) });
  });
});

describe('left#11 (6) backup do histórico', () => {
  it('leva runs e sessões do navegador, sem o journal de chamadas e sem importedAt', async () => {
    await importRecordFiles([arquivo('a.json', runExchangeJson(run('run-h')))]);
    await idbPut('runs', { id: 'journal:run-h:abc', t: 'call' } as { id: string });
    await idbPut('sessions', sessao('sessao-h', ['run-h']) as unknown as { id: string });
    const { json, runs, sessions } = await historyExchangeJson();
    expect({ runs, sessions }).toEqual({ runs: 1, sessions: 1 });
    const lido = parseExchangeBundle(JSON.parse(json).files);
    expect(lido.ok && lido.runs).toEqual([run('run-h')]);
  });
});

// --- (7) SPA → terminal (processo real) ---------------------------------------

const { cmd: CMD, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));
const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe('left#11 (7) o que a SPA exporta, o `runs import` do terminal importa', () => {
  it('sessão + runs exportadas pela SPA entram no data-dir do CLI sem perda', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'pb-spa-exch-'));
    temps.push(home);
    const s = sessao('sessao-spa', ['run-spa']);
    const arq = path.join(home, 'treino.json');
    writeFileSync(arq, sessionExchangeJson(s, [run('run-spa')]).json);
    const env: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: home, OPENROUTER_BASE_URL: 'http://127.0.0.1:9/api/v1' };
    delete env.OPENROUTER_API_KEY;
    const r = spawnSync(CMD, [ENTRY, 'runs', 'import', arq, '--json'], { env, encoding: 'utf-8', timeout: 60_000, cwd: home });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.data.imported).toEqual({ runs: ['run-spa'], sessions: ['sessao-spa'] });
    const gravado = JSON.parse(readFileSync(path.join(home, 'runs', 'run-spa.json'), 'utf-8'));
    const { importedAt: _i, ...resto } = gravado;
    expect(resto).toEqual(run('run-spa'));
  }, 60_000);
});

// --- (8) revisão: redação de segredos e ids duplicados no pacote ---------------

describe('revisão (8) credencial não viaja; id repetido no pacote', () => {
  it('record cru com apiKey embutida não exporta nem persiste a credencial', async () => {
    const cru = run('run-segredo', {
      apiKey: 'sk-or-fake-topo',
      config: { theme: 'suporte', stages: 1, competitorModelIds: ['fake/a'], authorization: 'Bearer x' },
    });
    // export: a credencial não sai
    expect(runExchangeJson(cru)).not.toMatch(/sk-or-fake-topo|Bearer x/);
    // import de record cru: a credencial não fica
    const res = await importRecordFiles([arquivo('cru.json', JSON.stringify(cru))]);
    expect(res.imported.runs).toEqual(['run-segredo']);
    const gravado = await idbGet<Record<string, unknown>>('runs', 'run-segredo');
    expect(JSON.stringify(gravado)).not.toMatch(/sk-or-fake-topo|Bearer x/);
    // campo desconhecido segue sobrevivendo (a redação só tira credenciais)
    expect(gravado?.campoDoFuturo).toEqual({ x: [1, 2, 3] });
  });

  it('mesma run DUAS vezes no pacote: idêntico fica uma; conteúdo diferente recusa o pacote', async () => {
    const duploIgual = toSingleFileBundle(
      buildExchangeBundle({ producer: 'x', runs: [run('run-d'), run('run-d')] }),
    );
    const ok = await importRecordFiles([arquivo('d.json', JSON.stringify(duploIgual))]);
    expect(ok.imported.runs).toEqual(['run-d']); // só UMA vez — sem sobrescrever em silêncio

    const duploDiferente = toSingleFileBundle(
      buildExchangeBundle({ producer: 'x', runs: [run('run-e'), run('run-e', { totalCostUsd: 9 })] }),
    );
    const err = await importRecordFiles([arquivo('e.json', JSON.stringify(duploDiferente))]).catch((e: unknown) => e);
    expect(isRecordImportError(err)).toBe(true);
    expect((err as { problems: string[] }).problems.join(' | ')).toMatch(/DUAS vezes/);
    expect(await idbGet('runs', 'run-e')).toBeUndefined(); // nada gravado pela metade
  });
});
