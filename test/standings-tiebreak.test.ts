// cli#1 — empate nas finais NUNCA coroa o pior contestant.
//
// Antes: standings ordenados por `winRate || wins` com sort ESTÁVEL. Com juiz de
// duelo enviesado por posição (as duas ordens discordam ⇒ todo duelo empata) a
// ordem dos contestants ficava — o controle é o 1º do array — e `runs winner`
// devolvia `standings[0]`: o PIOR contestant (judge-score 0 × 100) como
// vencedor, com o judge-score escondido do relatório.
//
// Contratos:
//  (i)   `sortStandings`: taxa ↓, vitórias ↓, judge-score ↓, rank cego — nunca
//        a ordem de entrada;
//  (ii)  `winnerFromStandings` diz o empate (tie/tiedIds/tieBreak/unresolved) e
//        re-ordena records antigos (gravados com a ordem de cadastro);
//  (iii) pipeline Node E SPA: todo duelo empatado + judge-score {a:0, b:100}
//        ⇒ standings[0] é o b;
//  (iv)  `runs winner --json` (CLI real) reporta o empate e o vencedor certo.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, setDefaultGateway, type FetchLike } from '../src/openrouter.js';
import { buildFinalStandings, sortStandings, winnerFromStandings } from '../src/engine/duelCore.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import type { RunConfig, RunRecord, StageSpec } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { candidateOf, duelReply, pointwiseReply } from './judgeReplies.js';
import { nodeOrTsx } from './support/cli.js';

vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { cmd: NODE, entry: ENTRY } = nodeOrTsx(join(ROOT, 'src', 'cli', 'index.ts'));

const linha = (id: string, wins: number, ties: number, losses: number) => {
  const played = wins + ties + losses;
  return {
    id,
    label: id.toUpperCase(),
    isControl: id === 'controle',
    wins,
    ties,
    losses,
    winRate: played ? Number(((wins + 0.5 * ties) / played).toFixed(4)) : 0,
  };
};

describe('cli#1 — ordenação e vencedor das finais', () => {
  it('(i) empate total nos duelos: o judge-score desempata (nunca a ordem de entrada)', () => {
    const rows = [linha('controle', 0, 6, 0), linha('b', 0, 6, 0)];
    const ord = sortStandings(rows, { controle: 0, b: 100 }, 42);
    expect(ord.map((r) => r.id)).toEqual(['b', 'controle']);
    // A entrada não é mutada.
    expect(rows.map((r) => r.id)).toEqual(['controle', 'b']);
  });

  it('(i) taxa e vitórias continuam acima do judge-score', () => {
    const rows = [linha('a', 2, 0, 1), linha('b', 1, 0, 2)];
    expect(sortStandings(rows, { a: 0, b: 100 }, 1).map((r) => r.id)).toEqual(['a', 'b']);
    // Mesma taxa, mais vitórias ganha (duelo decisivo > empates).
    const mesmaTaxa = [linha('empatador', 0, 2, 0), linha('decisivo', 1, 0, 1)];
    expect(sortStandings(mesmaTaxa, { empatador: 100, decisivo: 0 }, 1).map((r) => r.id)).toEqual([
      'decisivo',
      'empatador',
    ]);
  });

  it('(i) empate até no judge-score: rank CEGO semeado — muda com a seed, não com a ordem de entrada', () => {
    const rows = [linha('x', 0, 2, 0), linha('y', 0, 2, 0), linha('z', 0, 2, 0)];
    const js = { x: 50, y: 50, z: 50 };
    const a = sortStandings(rows, js, 7).map((r) => r.id);
    const b = sortStandings([...rows].reverse(), js, 7).map((r) => r.id);
    expect(a).toEqual(b); // independe da ordem de entrada
  });

  it('(ii) vencedor com o empate EXPLÍCITO — e record antigo (ordem de cadastro) re-ordenado', () => {
    const antigo = {
      id: 'run-antiga',
      standings: [linha('controle', 0, 6, 0), linha('b', 0, 6, 0)], // gravado com o sort estável antigo
      judgeScoreByContestant: { controle: 0, b: 100 },
    };
    const w = winnerFromStandings(antigo);
    expect(w).toEqual({
      contestantId: 'b',
      ruler: 'duels+judge-score',
      tie: true,
      tiedIds: ['b', 'controle'],
      tieBreak: 'judge-score',
      unresolved: false,
    });
    const semEmpate = winnerFromStandings({
      id: 'r',
      standings: [linha('a', 2, 0, 0), linha('b', 0, 0, 2)],
      judgeScoreByContestant: { a: 10, b: 90 },
    });
    expect(semEmpate).toMatchObject({ contestantId: 'a', ruler: 'duels', tie: false, tieBreak: 'none' });
    const indecidivel = winnerFromStandings({
      id: 'r',
      standings: [linha('a', 0, 2, 0), linha('b', 0, 2, 0)],
      judgeScoreByContestant: { a: 50, b: 50 },
    });
    expect(indecidivel).toMatchObject({ tie: true, tieBreak: 'blind', unresolved: true, ruler: 'duels' });
    // Sem finais: judge-score puro.
    expect(winnerFromStandings({ id: 'r', judgeScoreByContestant: { a: 10, b: 90 } })).toMatchObject({
      contestantId: 'b',
      ruler: 'judge-score',
      tie: false,
    });
  });

  it('buildFinalStandings soma V/E/D e ordena com o desempate', () => {
    const st = buildFinalStandings({
      contestantIds: ['controle', 'b'],
      duels: [
        { a: 'controle', b: 'b', outcome: 'tie' },
        { a: 'b', b: 'controle', outcome: 'tie' },
      ],
      labelOf: (id) => id.toUpperCase(),
      controlId: 'controle',
      judgeScoreByContestant: { controle: 0, b: 100 },
      seed: 1,
    });
    expect(st.map((s) => s.id)).toEqual(['b', 'controle']);
    expect(st[1]).toMatchObject({ isControl: true, wins: 0, ties: 2, losses: 0, winRate: 0.5 });
  });
});

// ---------------------------------------------------------------------------
// (iii) Pipeline: juiz de duelo SEMPRE 'A' (viés de posição) ⇒ todo duelo empata.
// ---------------------------------------------------------------------------

const TRES: StageSpec[] = Array.from({ length: 3 }, (_, i) => ({
  question: `CEN-${i} Qual o prazo para trocar?`,
  productContext: 'Trocas em até 30 dias com nota fiscal.',
  maxTokens: 200,
  reference: `Trinta dias (item ${i}).`,
}));

const CONFIG = {
  mode: 'compare',
  theme: 'suporte',
  stages: 3,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  // fake/a é o 1º (âncora/controle do compare) e o PIOR.
  competitorModelIds: ['fake/a', 'fake/b'],
  customStages: TRES,
  finalists: 2,
  timeoutMs: 5_000,
} as unknown as RunConfig;

function fakeEnviesado() {
  return fakeOpenRouter({
    catalog: ['fake/judge', 'fake/a', 'fake/b', 'fake/ref', 'fake/gen'].map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: (req) => {
      if (req.stream) return { text: `Resposta de ${req.model}` };
      // Viés de posição: SEMPRE 'A' — as duas ordens discordam ⇒ empate.
      if (req.system.includes('DUELO')) return { text: duelReply(req, 'A') };
      const v = candidateOf(req) === 'Resposta de fake/a' ? 'nao' : 'resolve';
      return { text: pointwiseReply(req, v) };
    },
  });
}

async function comGateway<T>(fetch: FetchLike, fn: () => Promise<T>): Promise<T> {
  const anterior = setDefaultGateway(createGateway({ fetch, sleep: noSleep }));
  try {
    return await fn();
  } finally {
    setDefaultGateway(anterior);
  }
}

describe('cli#1 — pipeline Node e SPA: empate total nos duelos', () => {
  let dirAnterior: string;
  let tmp: string;
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-cli1-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
  });
  afterAll(() => {
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  const motores = [
    ['Node', (cfg: RunConfig) => runNode(cfg, KEY, {})],
    ['SPA', (cfg: RunConfig) => runWeb(cfg as never, KEY, {}) as unknown as Promise<RunRecord>],
  ] as const;

  for (const [nome, rodar] of motores) {
    it(`${nome}: standings[0] é o melhor por judge-score, não o 1º cadastrado`, async () => {
      const rec = await comGateway(fakeEnviesado().fetch, () => rodar(CONFIG));
      expect(rec.judgeScoreByContestant).toEqual({ 'fake/a': 0, 'fake/b': 100 });
      expect(rec.standings?.map((s) => [s.id, s.ties, s.winRate])).toEqual([
        ['fake/b', 3, 0.5],
        ['fake/a', 3, 0.5],
      ]);
      expect(winnerFromStandings(rec)).toMatchObject({
        contestantId: 'fake/b',
        tie: true,
        tieBreak: 'judge-score',
        ruler: 'duels+judge-score',
      });
    });
  }
});

// ---------------------------------------------------------------------------
// (iv) CLI de verdade: `runs winner --json` sobre um record ANTIGO (ordem de
// cadastro no empate) — o vencedor é o b e o empate é dito.
// ---------------------------------------------------------------------------

describe('cli#1 — `runs winner` (CLI real)', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-cli1-cli-'));
    mkdirSync(join(tmp, 'runs'), { recursive: true });
    const id = '00000000-0000-4000-8000-00000000c1a1';
    const record = {
      id,
      status: 'finished',
      mode: 'compare',
      config: { mode: 'compare', theme: 't', stages: 3, datagenModelId: 'g', judgeModelIds: ['j'], competitorModelIds: ['fake/a', 'fake/b'] },
      contestants: [
        { id: 'fake/a', label: 'A', modelId: 'fake/a', isOriginal: true, systemPrompt: 'PROMPT-A' },
        { id: 'fake/b', label: 'B', modelId: 'fake/b', systemPrompt: 'PROMPT-B' },
      ],
      stages: [],
      scoreboard: {},
      totalCostUsd: 0,
      startedAt: '2026-09-28T00:00:00.000Z',
      finishedAt: '2026-09-28T00:01:00.000Z',
      judgeScoreByContestant: { 'fake/a': 0, 'fake/b': 100 },
      standings: [
        { id: 'fake/a', label: 'A', isControl: true, wins: 0, ties: 6, losses: 0, winRate: 0.5 },
        { id: 'fake/b', label: 'B', isControl: false, wins: 0, ties: 6, losses: 0, winRate: 0.5 },
      ],
    };
    writeFileSync(join(tmp, 'runs', `${id}.json`), JSON.stringify(record));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const cli = (...args: string[]) =>
    spawnSync(NODE, [ENTRY, 'runs', ...args, '--data-dir', tmp], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, OPENROUTER_API_KEY: '', CI: '1' },
    });

  it('--json: vencedor b, empate declarado, judge-score no payload; --prompt-only avisa no stderr', () => {
    const r = cli('winner', '00000000-0000-4000-8000-00000000c1a1', '--json');
    expect(r.status, r.stderr).toBe(0);
    const payload = JSON.parse(r.stdout) as { ok: boolean; data: Record<string, unknown> };
    expect(payload.ok).toBe(true);
    expect(payload.data).toMatchObject({
      contestantId: 'fake/b',
      ruler: 'duels+judge-score',
      tie: true,
      tieBreak: 'judge-score',
      unresolved: false,
      judgeScore: 100,
    });
    expect(payload.data.tiedIds).toEqual(['fake/b', 'fake/a']);

    const p = cli('winner', '00000000-0000-4000-8000-00000000c1a1', '--prompt-only');
    expect(p.status, p.stderr).toBe(0);
    expect(p.stdout).toBe('PROMPT-B');
    expect(p.stderr).toContain('empate nos duelos');
  });
});
