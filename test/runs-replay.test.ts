// IMPL-117 (critério i) — `runs reproduce <id> --replay` sobre uma run GRAVADA
// termina com exit 0, custo $0 e judge-score idêntico (±0) ao original em 100%
// dos cenários. A run gravada é produzida pelo pipeline REAL com gateway falso
// (painel de 2 juízes com voto falho, listwise por gabarito vazio, finais com
// duelo sem resultado, resposta com retry x2 de truncamento, repeats). O replay
// roda o CLI de verdade (dist/) — nenhuma chamada sai para a rede.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, setDefaultGateway, type FetchLike } from '../src/openrouter.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { GABARITO_ROLE_PROMPT } from '../src/gabarito.js';
import { readMarkedBlock } from '../src/engine/judgeGuard.js';
import { replayTransport } from '../src/cli/replay.js';
import type { RunConfig, RunRecord, StageSpec } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeRequest } from './fakeOpenRouter.js';
import { candidateOf, canaryOf, listwiseReply, questionOf } from './judgeReplies.js';
import { nodeOrTsx } from './support/cli.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { cmd: NODE, entry: ENTRY } = nodeOrTsx(join(ROOT, 'src', 'cli', 'index.ts'));

const ETAPAS: StageSpec[] = [
  ...Array.from({ length: 5 }, (_, i) => ({
    question: `CEN-${i} Qual o prazo para trocar?`,
    productContext: 'Trocas em até 30 dias com nota fiscal.',
    maxTokens: 200,
    reference: `Trinta dias (item ${i}).`,
  })),
  // Sem gabarito e o gabarito gerado vem vazio ⇒ julgada LISTWISE.
  { question: 'CEN-L Qual o horário?', productContext: 'Das 8h às 18h.', maxTokens: 200 },
];

const CONFIG = {
  mode: 'compare',
  theme: 'suporte',
  stages: ETAPAS.length,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/j1', 'fake/j2'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b', 'fake/c'],
  customStages: ETAPAS,
  finalists: 3,
  judgeEngine: 'llm',
  timeoutMs: 5_000,
} as unknown as RunConfig;

const VEREDITO: Record<string, Record<string, string>> = {
  'fake/j1': { 'fake/a': 'resolve', 'fake/b': 'parcial', 'fake/c': 'nao' },
  'fake/j2': { 'fake/a': 'resolve', 'fake/b': 'resolve', 'fake/c': 'parcial' },
};

function gatewayGravacao(): FetchLike {
  const truncou = new Set<string>();
  return fakeOpenRouter({
    catalog: ['fake/j1', 'fake/j2', 'fake/a', 'fake/b', 'fake/c', 'fake/ref', 'fake/gen'].map((id) =>
      catalogItem(id, 1e-6, 1e-6),
    ),
    chat: (req: FakeRequest) => {
      if (req.stream) {
        const cen = /CEN-(\w)/.exec(req.user)?.[1] ?? '?';
        // fake/b no CEN-0: 1ª tentativa cortada no teto, o retry x2 completa.
        if (req.model === 'fake/b' && cen === '0' && !truncou.has('b0')) {
          truncou.add('b0');
          return { text: 'Resposta cortad', finishReason: 'length' };
        }
        return { text: `Resposta de ${req.model} p/ ${cen}`, finishReason: 'stop' };
      }
      if (req.system === GABARITO_ROLE_PROMPT) return { text: '' };
      if (req.system.includes('juiz imparcial')) {
        const labels = JSON.parse(/rotulos (\[[^\]]*\])/.exec(req.user)![1]) as string[];
        const ordem = [...labels].sort(); // ranking determinístico por rótulo
        return {
          text: listwiseReply(
            req,
            ordem,
            labels.map((label) => ({ label, justificativa: `lw ${req.model}`, veredito: 'parcial' })),
          ),
        };
      }
      if (req.system.includes('DUELO')) {
        const a = readMarkedBlock(req.user, 'CANDIDATO A') ?? '';
        const b = readMarkedBlock(req.user, 'CANDIDATO B') ?? '';
        // Par (fake/b × fake/c) no CEN-2: o juiz de duelo devolve lixo ⇒ duelo sem resultado.
        if (questionOf(req).startsWith('CEN-2') && /fake\/[bc]/.test(a) && /fake\/[bc]/.test(b)) {
          return { text: 'sem JSON' };
        }
        const winner = a < b ? 'A' : 'B'; // decisivo e independente da ordem
        return { text: JSON.stringify({ canario: canaryOf(req), explanation: 'duelo', winner, confianca: 'media' }) };
      }
      const cand = candidateOf(req) ?? '';
      const cid = /fake\/[abc]/.exec(cand)?.[0] ?? 'fake/a';
      // j2 falha (saída inválida 2x) para o fake/c no CEN-3 ⇒ voto com erro, painel reduzido.
      if (req.model === 'fake/j2' && cid === 'fake/c' && questionOf(req).startsWith('CEN-3')) return { text: 'não sei' };
      const verdict = VEREDITO[req.model]?.[cid] ?? 'parcial';
      return {
        text: JSON.stringify({ canario: canaryOf(req), explanation: `voto ${req.model}`, verdict, confianca: 'alta' }),
      };
    },
  }).fetch;
}

describe('IMPL-117 — runs reproduce --replay (CLI real)', () => {
  let tmp: string;
  let dirAnterior: string;
  let original: RunRecord;
  let comRepeats: RunRecord;
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-replay-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    const gravar = async (cfg: RunConfig): Promise<RunRecord> => {
      const anterior = setDefaultGateway(createGateway({ fetch: gatewayGravacao(), sleep: noSleep }));
      try {
        return await runNode(cfg, KEY, {});
      } finally {
        setDefaultGateway(anterior);
      }
    };
    original = await gravar(CONFIG);
    comRepeats = await gravar({ ...CONFIG, repeats: 2, customStages: ETAPAS.slice(1, 4), stages: 3 } as RunConfig);
  });

  afterAll(() => {
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  const cli = (...args: string[]) =>
    spawnSync(NODE, [ENTRY, 'runs', ...args, '--data-dir', tmp], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, OPENROUTER_API_KEY: '', OPENROUTER_BASE_URL: 'http://127.0.0.1:9', CI: '1' },
    });

  it('a run gravada exercita o que o replay precisa reproduzir', () => {
    // Voto falho no painel, etapa listwise, duelo sem resultado, retry x2.
    expect(original.stages[3].referenceJudge?.judgeVotesByContestant?.['fake/c']?.some((v) => v.error)).toBe(true);
    expect(original.stages[5].referenceJudge).toBeUndefined();
    expect(original.stages[5].judge?.judges.length).toBe(2);
    expect(original.stages[2].duels?.failedDuels?.length).toBeGreaterThan(0);
    expect(original.stages[0].responses.find((r) => r.contestantId === 'fake/b')?.truncationRetried).toBe(true);
    expect(original.standings?.length).toBe(3);
  });

  it('(i) exit 0, custo $0, judge-score idêntico em 100% dos cenários — sem rede', () => {
    const r = cli('reproduce', original.id, '--replay', '--json');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const payload = JSON.parse(r.stdout) as { ok: boolean; data: Record<string, unknown> };
    expect(payload.ok).toBe(true);
    expect(payload.data).toMatchObject({ identical: true, costUsd: 0, mismatches: [], scenarios: 6 });
    expect(payload.data.judgeScoreReplay).toEqual(original.judgeScoreByContestant);
    expect(payload.data.calls as number).toBeGreaterThan(0);
  });

  it('(i) com repeats (clones do mesmo cenário) também é idêntico', () => {
    const r = cli('reproduce', comRepeats.id, '--replay', '--json');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).data).toMatchObject({ identical: true, costUsd: 0 });
  });

  it('record adulterado (pontuação que o binário não reproduz) ⇒ exit 3 config.replay_mismatch', () => {
    const arq = join(tmp, 'runs', `${original.id}.json`);
    const bruto = JSON.parse(readFileSync(arq, 'utf-8')) as RunRecord;
    bruto.judgeScoreByContestant = { ...bruto.judgeScoreByContestant, 'fake/a': 12.5 };
    writeFileSync(arq, JSON.stringify(bruto));
    const r = cli('reproduce', original.id, '--replay', '--json');
    expect(r.status).toBe(3);
    const payload = JSON.parse(r.stdout) as { ok: boolean; error: { code: string; details: { mismatches: { what: string }[] } } };
    expect(payload.error.code).toBe('config.replay_mismatch');
    expect(payload.error.details.mismatches.map((m) => m.what)).toContain('judge-score');
  });

  it('run de agente: sem replay (exit 2, dito — nunca simulado)', () => {
    const arq = join(tmp, 'runs', `${comRepeats.id}.json`);
    const bruto = JSON.parse(readFileSync(arq, 'utf-8')) as RunRecord;
    (bruto.config as unknown as Record<string, unknown>).agent = { executor: 'fake' };
    writeFileSync(arq, JSON.stringify(bruto));
    const r = cli('reproduce', comRepeats.id, '--replay', '--json');
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('AGENTE');
  });

  it('o transporte de replay nunca responde chamada não gravada (miss é registrado)', async () => {
    const t = replayTransport(original);
    const res = await t.fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'fake/x', messages: [{ role: 'system', content: 'outro papel' }, { role: 'user', content: 'oi' }] }),
    });
    expect(res.status).toBe(400);
    expect(t.misses).toHaveLength(1);
  });
});
