// cli#0 + IMPL-117 + web-code#2 — o contrato do juiz que a run PINA é o mesmo
// que o gate recalcula e o que vai no fio.
//
//  (i)   run REAL do orquestrador (fake gateway, config default) → `baseline
//        pin` → `baseline check` passa (exit 0). Antes: exit 3 "contrato do
//        juiz mudou" logo depois do pin — o check deixava de fora o think level
//        default do papel ('medium') que o orquestrador SEMPRE pina;
//  (ii)  run com `reasoning.judge: 'high'`: check com `--config` da run passa;
//        sem `--config` reprova (o setup default é outro contrato — dito);
//  (iii) o pin cobre a temperatura que os juízes ENVIAM (IMPL-117): o hash
//        muda se ela mudar e o corpo de toda chamada de juízo leva a mesma;
//  (iv)  web-code#2: o listwise da SPA recebe o esforço do juiz (antes ia
//        `null` enquanto o contrato gravado dizia 'high').

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, setDefaultGateway, type FetchLike } from '../src/openrouter.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { contractHashFor } from '../src/cli/commands/baseline.js';
import { judgeSetupFromConfig } from '../src/engine/judgeBaseline.js';
import { judgeContractHash, pipelineContractComponents } from '../src/engine/judgeCalibration.js';
import { JUDGE_TEMPERATURE } from '../src/engine/judgeRetry.js';
import type { RunConfig, RunRecord } from '../src/types.js';
import { fakeOpenRouter, noSleep, type FakeRequest } from './fakeOpenRouter.js';
import { listwiseReply, pointwiseReply } from './judgeReplies.js';
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
const FIXTURE = join(ROOT, 'test', 'fixtures', 'models-2026-09-27.json');
const { cmd: NODE, entry: ENTRY } = nodeOrTsx(join(ROOT, 'src', 'cli', 'index.ts'));
const RAW = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as { data: unknown[] };

const JUIZ = 'anthropic/claude-sonnet-5';
const GABARITO = 'openai/gpt-5-mini';
const COMP = ['google/gemini-3.8-flash', 'deepseek/deepseek-v4-pro'];

const baseConfig = (extra: Record<string, unknown> = {}): RunConfig =>
  ({
    mode: 'compare',
    theme: 'suporte',
    stages: 1,
    datagenModelId: 'openai/gpt-5-nano',
    judgeModelIds: [JUIZ],
    referenceModelId: GABARITO,
    referenceJudging: true,
    competitorModelIds: COMP,
    finalists: 0,
    duels: false,
    timeoutMs: 5_000,
    customStages: [
      {
        question: 'Qual o prazo para trocar um produto?',
        productContext: 'Trocas em até 30 dias.',
        maxTokens: 200,
        reference: 'Trinta dias, com nota fiscal.',
      },
    ],
    ...extra,
  }) as unknown as RunConfig;

/** O juiz LISTWISE (fallback sem gabarito) — o system dele é o "juiz imparcial". */
const ehListwise = (req: FakeRequest): boolean => req.system.includes('juiz imparcial');

function fakeReal(): ReturnType<typeof fakeOpenRouter> {
  return fakeOpenRouter({
    catalog: RAW.data,
    chat: (req) => {
      if (req.stream) return { text: `Resposta de ${req.model}`, finishReason: 'stop' };
      if (ehListwise(req)) {
        // Rótulos da passagem: `RESPOSTAS A AVALIAR (n, rotulos ["A","B"])`.
        const enumLabels = JSON.parse(/rotulos (\[[^\]]*\])/.exec(req.user)![1]) as string[];
        return {
          text: listwiseReply(
            req,
            enumLabels,
            enumLabels.map((label) => ({ label, justificativa: 'ok', veredito: 'resolve' })),
          ),
          finishReason: 'stop',
        };
      }
      return { text: pointwiseReply(req, 'resolve'), finishReason: 'stop' };
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

describe('cli#0 — pin da run × `baseline check` (CLI real)', () => {
  let tmp: string;
  let dirAnterior: string;
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-cli0-'));
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

  const cli = (...args: string[]) =>
    spawnSync(NODE, [ENTRY, 'baseline', ...args, '--data-dir', tmp], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, OPENROUTER_API_KEY: '', CI: '1' },
    });

  it('(i) config default: o hash pinado pelo orquestrador é o que o check recalcula → exit 0', async () => {
    const rec = await comGateway(fakeReal().fetch, () => runNode(baseConfig(), KEY, {}));
    // 1 cenário: n efetivo < 5 ⇒ 'inconclusive' (IMPL-004) — terminal, com pin.
    expect(['finished', 'inconclusive'], rec.error).toContain(rec.status);
    const pin = rec.judgeDiagnostics!.contract;
    // A run pina o esforço DEFAULT do papel e a temperatura do juízo…
    expect(pin.components?.judgeReasoningLevel).toBe('medium');
    expect(pin.components?.judgeTemperature).toBe(JUDGE_TEMPERATURE);
    // …e o cálculo do CLI (sem config: setup default) chega ao MESMO hash.
    expect(contractHashFor(judgeSetupFromConfig(rec.config)!)).toBe(pin.hash);

    const arq = join(tmp, 'bl-default.json');
    const p = cli('pin', rec.id, '-o', arq, '--catalog', FIXTURE);
    expect(p.status, p.stderr).toBe(0);
    const c = cli('check', '--file', arq, '--catalog', FIXTURE);
    expect(c.status, c.stdout + c.stderr).toBe(0);
    expect(c.stdout).not.toContain('contract-changed');
    // Com a MESMA config em arquivo também passa.
    const cfgFile = join(tmp, 'cfg-default.json');
    writeFileSync(cfgFile, JSON.stringify(rec.config));
    const c2 = cli('check', '--file', arq, '--config', cfgFile, '--catalog', FIXTURE);
    expect(c2.status, c2.stdout + c2.stderr).toBe(0);
  });

  it("(ii) reasoning.judge='high': check com --config da run passa; sem config reprova (contract-changed)", async () => {
    const cfg = baseConfig({ reasoning: { judge: 'high' } });
    const rec = await comGateway(fakeReal().fetch, () => runNode(cfg, KEY, {}));
    expect(rec.judgeDiagnostics!.contract.components?.judgeReasoningLevel).toBe('high');

    const arq = join(tmp, 'bl-high.json');
    const p = cli('pin', rec.id, '-o', arq, '--catalog', FIXTURE);
    expect(p.status, p.stderr).toBe(0);
    expect(p.stderr).toContain("esforço do juiz 'high'");

    const cfgFile = join(tmp, 'cfg-high.json');
    writeFileSync(cfgFile, JSON.stringify(rec.config));
    const ok = cli('check', '--file', arq, '--config', cfgFile, '--catalog', FIXTURE);
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);

    const semConfig = cli('check', '--file', arq, '--catalog', FIXTURE);
    expect(semConfig.status).toBe(3);
    expect(semConfig.stdout).toContain('contract-changed');
  });
});

describe('IMPL-117 — temperatura do juízo no contrato E no fio', () => {
  it('trocar a temperatura muda o hash do pipeline (sensibilidade)', () => {
    const base = pipelineContractComponents({
      duelPromptText: 'D',
      listwisePromptText: 'L',
      referenceModelId: 'r',
      judgeReasoningLevel: 'medium',
    });
    expect(base.judgeTemperature).toBe(0);
    expect(judgeContractHash(['j'], 'P', base)).not.toBe(judgeContractHash(['j'], 'P', { ...base, judgeTemperature: 0.7 }));
  });

  it('toda chamada de juízo sai com a temperatura pinada', async () => {
    const fake = fakeReal();
    const silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    const tmp = mkdtempSync(join(tmpdir(), 'pb-impl117-'));
    const dirAnterior = getDataDir();
    setDataDir(tmp);
    try {
      const rec = await comGateway(fake.fetch, () => runNode(baseConfig(), KEY, {}));
      const juizes = fake.chatRequests().filter((r) => !r.stream);
      expect(juizes.length).toBeGreaterThan(0);
      for (const r of juizes) expect(r.body?.temperature ?? 0).toBe(rec.judgeDiagnostics!.contract.components?.judgeTemperature);
    } finally {
      silencio.forEach((s) => s.mockRestore());
      setDataDir(dirAnterior);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('web-code#2 — listwise recebe o esforço do juiz nos DOIS motores', () => {
  const listwiseCfg = baseConfig({
    referenceJudging: false,
    reasoning: { judge: 'high' },
    customStages: [
      { question: 'Qual o prazo para trocar um produto?', productContext: 'Trocas em até 30 dias.', maxTokens: 200 },
    ],
  });
  const motores = [
    ['Node', (cfg: RunConfig) => runNode(cfg, KEY, {})],
    ['SPA', (cfg: RunConfig) => runWeb(cfg as never, KEY, {}) as unknown as Promise<RunRecord>],
  ] as const;

  for (const [nome, rodar] of motores) {
    it(`${nome}: o corpo do pedido listwise leva reasoning e o contrato gravado diz o mesmo`, async () => {
      const silencio = [
        vi.spyOn(console, 'log').mockImplementation(() => undefined),
        vi.spyOn(console, 'warn').mockImplementation(() => undefined),
        vi.spyOn(console, 'error').mockImplementation(() => undefined),
      ];
      const tmp = mkdtempSync(join(tmpdir(), 'pb-wc2-'));
      const dirAnterior = getDataDir();
      setDataDir(tmp);
      try {
        const fake = fakeReal();
        const rec = await comGateway(fake.fetch, () => rodar(listwiseCfg));
        const listwise = fake.chatRequests().filter((r) => !r.stream && ehListwise(r));
        expect(listwise.length).toBeGreaterThan(0);
        for (const r of listwise) expect(r.body?.reasoning).toEqual({ effort: 'high' });
        expect(rec.judgeDiagnostics?.contract.components?.judgeReasoningLevel).toBe('high');
      } finally {
        silencio.forEach((s) => s.mockRestore());
        setDataDir(dirAnterior);
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});
