// extra#2 — PISOS DE TIMEOUT por papel (juiz/duelo/gabarito/datagen/reescritor).
//
// Num treino REAL (2026-09-29) o `config.timeoutMs` (60 s, pensado para a
// resposta do competidor) era repassado a todo papel e o gateway só ENCURTA o
// teto do papel com ele: o juiz que raciocina estourou ("veredito INVÁLIDO") e
// o reescritor também ("timeout total (60000ms, papel rewriter)"). Contratos
// (transporte falso + relógio falso, zero rede):
//   (i)   `roleTimeoutMs` = max(configurado, piso do papel), piso menor com
//         raciocínio 'off'; o competidor não tem piso;
//   (ii)  numa RUN com `timeoutMs: 60_000` (Node e SPA), o juiz que leva 90 s
//         COMPLETA, enquanto o competidor com o mesmo atraso estoura aos 60 s;
//   (iii) o reescritor (variator) de 150 s completa com `timeoutMs: 60_000`;
//   (iv)  o override EXPLÍCITO do usuário (`roleTimeouts` do gateway) continua
//         encurtando por cima do piso;
//   (v)   o `--dry-run` mostra os timeouts efetivos (`effectiveRoleTimeouts`).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway, type FetchLike, type OpenRouterGateway } from '../src/openrouter.js';
import {
  effectiveRoleTimeouts,
  ROLE_TIMEOUT_FLOOR_MS,
  ROLE_TIMEOUT_FLOOR_NO_REASONING_MS,
  roleTimeoutMs,
} from '../src/roleLimits.js';
import { generateContestants } from '../src/variator.js';
import { setDataDir, getDataDir } from '../src/storage.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import type { RunConfig, RunRecord } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeRequest } from './fakeOpenRouter.js';
import { pointwiseReply } from './judgeReplies.js';

vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

describe('extra#2 (i) — roleTimeoutMs: piso por papel sobre o configurado', () => {
  it('60 s configurado sobe ao piso; acima do piso fica o configurado; off tem piso menor', () => {
    expect(roleTimeoutMs('judge', 60_000)).toBe(120_000);
    expect(roleTimeoutMs('judge', 60_000, 'low')).toBe(120_000);
    expect(roleTimeoutMs('judge', 60_000, 'off')).toBe(90_000);
    expect(roleTimeoutMs('rewriter', 60_000)).toBe(180_000);
    expect(roleTimeoutMs('duel', 60_000)).toBe(90_000);
    expect(roleTimeoutMs('judge', 300_000)).toBe(300_000);
    // Gabarito/datagen nunca abaixo dos 120 s que o orquestrador já garantia.
    expect(roleTimeoutMs('gabarito', 60_000, 'off')).toBe(120_000);
    expect(roleTimeoutMs('datagen', 60_000, 'off')).toBe(120_000);
    // Ausente/inválido = o piso.
    expect(roleTimeoutMs('datagen', undefined)).toBe(ROLE_TIMEOUT_FLOOR_MS.datagen);
    expect(roleTimeoutMs('datagen', Number.NaN)).toBe(ROLE_TIMEOUT_FLOOR_MS.datagen);
    for (const [papel, piso] of Object.entries(ROLE_TIMEOUT_FLOOR_NO_REASONING_MS)) {
      expect(piso, papel).toBeGreaterThanOrEqual(60_000);
      expect(ROLE_TIMEOUT_FLOOR_MS[papel as keyof typeof ROLE_TIMEOUT_FLOOR_MS], papel).toBeGreaterThanOrEqual(piso);
    }
  });

  it('(v) effectiveRoleTimeouts (dry-run): competidor no configurado, papéis no piso', () => {
    expect(effectiveRoleTimeouts({ timeoutMs: 60_000, reasoning: { judge: 'off' } })).toEqual({
      competitor: 60_000,
      judge: 90_000,
      duel: 60_000,
      gabarito: 120_000,
      datagen: 180_000,
      rewriter: 180_000,
    });
    expect(effectiveRoleTimeouts({}).competitor).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// (ii)-(iv) — transporte LENTO sob relógio falso.
// ---------------------------------------------------------------------------

/** Atrasa /chat/completions de quem `lento(req)` escolher; honra o abort (watchdog do gateway). */
function atrasar(base: FetchLike, atrasoMs: (body: Record<string, unknown>) => number): FetchLike {
  return (url, init) => {
    if (!String(url).includes('/chat/completions')) return base(url, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const ms = atrasoMs(body);
    if (ms <= 0) return base(url, init);
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const t = setTimeout(() => base(url, init).then(resolve, reject), ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(signal.reason ?? new Error('aborted'));
        },
        { once: true },
      );
    });
  };
}

function responder(req: FakeRequest) {
  if (req.model === 'fake/judge') return { text: pointwiseReply(req, 'resolve') };
  if (req.model === 'fake/rw') return { text: 'Voce e um atendente cordial e objetivo; responda com base no contexto.' };
  return { text: 'Você tem 30 dias para trocar.' };
}

let anterior: OpenRouterGateway | undefined;
function instalar(atrasoMs: (body: Record<string, unknown>) => number, extra: Parameters<typeof createGateway>[0] = {}): void {
  const fake = fakeOpenRouter({
    catalog: ['fake/judge', 'fake/a', 'fake/rw'].map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: responder,
  });
  anterior = setDefaultGateway(createGateway({ fetch: atrasar(fake.fetch, atrasoMs), sleep: noSleep, ...extra }));
}

/**
 * Relógio falso SÓ para os timers (setImmediate/Date reais): o motor do Node
 * grava o record em disco (I/O real) no meio da run — cada passo cede ao loop
 * de eventos antes de avançar o relógio.
 */
function relogioFalso(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
}

/** Avança o relógio falso em passos até a promessa assentar (teto de segurança). */
async function ateAssentar<T>(p: Promise<T>, passoMs = 1_000, tetoRealMs = 20_000): Promise<T> {
  let pronto = false;
  const vigiada = p.finally(() => {
    pronto = true;
  });
  const inicio = performance.now();
  while (!pronto && performance.now() - inicio < tetoRealMs) {
    // Cede ao I/O real (fs do motor Node) antes de cada passo do relógio.
    for (let k = 0; k < 5; k += 1) await new Promise<void>((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(passoMs);
  }
  return vigiada;
}

const CONFIG = {
  mode: 'compare',
  theme: 'trocas',
  stages: 1,
  datagenModelId: 'fake/judge',
  judgeModelIds: ['fake/judge'],
  referenceJudging: true,
  competitorModelIds: ['fake/a'],
  // Com `reference`: nenhum gabarito a gerar (só competidor + juiz no fio).
  customStages: [
    {
      question: 'Qual o prazo de troca?',
      productContext: 'Trocas em 30 dias.',
      maxTokens: 200,
      reference: 'O prazo de troca é de 30 dias.',
    },
  ],
  finalists: 0,
  timeoutMs: 60_000,
} as const;

let tmp: string;
let dirAnterior: string;
let mudos: Array<{ mockRestore(): void }> = [];
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pb-extra2-'));
  dirAnterior = getDataDir();
  setDataDir(tmp);
  mudos = (['log', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
});
afterAll(() => {
  mudos.forEach((m) => m.mockRestore());
  setDataDir(dirAnterior);
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
  vi.useRealTimers();
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
});

const MOTORES = [
  ['Node', runNode],
  ['SPA', runWeb],
] as const;

describe('extra#2 (ii) — numa run com timeoutMs 60 s o juiz de 90 s completa', { timeout: 30_000 }, () => {
  for (const [motor, run] of MOTORES) {
    it(`${motor}: juiz lento (90 s) → veredito válido; competidor rápido`, async () => {
      relogioFalso();
      instalar((body) => (body.model === 'fake/judge' ? 90_000 : 0));
      const rec = (await ateAssentar(run(CONFIG as unknown as RunConfig as never, KEY, { runId: `extra2-${motor}-juiz` } as never))) as RunRecord;
      const etapa = rec.stages[0];
      expect(etapa.referenceJudge?.verdictErrorByContestant?.['fake/a']).toBeUndefined();
      expect(etapa.referenceJudge?.verdictByContestant['fake/a']).toBe('resolve');
    });

    it(`${motor}: competidor lento (90 s) com o MESMO timeout → estoura aos 60 s (sem piso)`, async () => {
      relogioFalso();
      instalar((body) => (body.model === 'fake/a' ? 90_000 : 0));
      const rec = (await ateAssentar(run(CONFIG as unknown as RunConfig as never, KEY, { runId: `extra2-${motor}-comp` } as never))) as RunRecord;
      const resp = rec.stages[0].responses.find((r) => r.contestantId === 'fake/a');
      expect(resp?.status).toBe('error');
      expect(resp?.errorMsg).toMatch(/timeout/i);
    });
  }
});

describe('extra#2 (iii)/(iv) — reescritor com piso; override explícito do gateway ainda encurta', { timeout: 30_000 }, () => {
  const params = {
    apiKey: KEY,
    modelId: 'fake/a',
    theme: 'suporte',
    basePrompt: 'Voce e um atendente.',
    includeOriginal: true,
    techniqueIds: ['persona'],
    promptOptimization: true,
    optimizerModelId: 'fake/rw',
    timeoutMs: 60_000,
  };

  it('reescrita de 150 s com timeoutMs 60 s: a variante sai (piso 180 s)', async () => {
    relogioFalso();
    instalar((body) => (body.model === 'fake/rw' ? 150_000 : 0));
    const lista = await ateAssentar(generateContestants(params as never));
    expect(lista.some((c) => !c.isOriginal)).toBe(true);
  });

  it('roleTimeouts.rewriter explícito (30 s) encurta por cima do piso: a técnica cai', async () => {
    relogioFalso();
    instalar((body) => (body.model === 'fake/rw' ? 150_000 : 0), {
      roleTimeouts: { rewriter: { totalMs: 30_000, idleMs: 30_000 } },
    });
    const lista = await ateAssentar(generateContestants(params as never));
    expect(lista.every((c) => c.isOriginal)).toBe(true);
  });
});
