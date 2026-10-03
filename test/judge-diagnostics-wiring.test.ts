// Diagnósticos do juiz LIGADOS no pipeline (antes eram só bibliotecas sem
// chamador). Transporte falso, zero rede, zero gasto.
//
//  IMPL-053 — (a) `scenarioId` chega às amostras (efeito fixo do cenário muda o
//             betaLenRel num confundidor de dificuldade); (b) com
//             `verbosityProbes` as sondas contrafactuais rodam e a taxa de
//             inversão é reportada (não-nula); (c) BudgetExceeded dentro do
//             re-julgamento SOBE (antes: `catch {}` engolia o controle).
//  IMPL-055 — gabarito divergente da rubrica dispara a verificação, o 2º
//             gabarito (família distinta) e entra em `needsHumanReview`
//             (preservado no re-read); custo extra medido ≤ 16% da iteração
//             no cenário padrão (10 cenários).
//  IMPL-112 — `itemSaturation` na run: item 100% 'resolve' em k execuções vai
//             para a fila de revisão humana (nunca descartado).
//  IMPL-049 — drift do contrato ENTRE processos: com a memória zerada (outro
//             processo do CLI), a 2ª run ainda acusa `judge.contract.changed`
//             pela run GRAVADA; `contractAudit` fica no record.
//  IMPL-047 — veredito com confiança 'baixa' entra na fila de revisão.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway, type FetchLike } from '../src/openrouter.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { getDataDir, loadRun, setDataDir } from '../src/storage.js';
import { subscribe } from '../src/events.js';
import { subscribeRun as subscribeWeb } from '../web/src/engine/events.js';

type WebRunEvent = { type: string };
import { normalizeRunRecord } from '../src/normalize.js';
import { BudgetExceeded, isControlSignal } from '../src/budget.js';
import {
  resetJudgeContractMemory,
  runCounterfactualProbes,
  verbosityDiag,
  verbositySamples,
  type VerbositySampleRow,
} from '../src/engine/judgeCalibration.js';
import { GABARITO_ROLE_PROMPT } from '../src/gabarito.js';
import type { RunConfig, RunEvent, RunRecord, StageSpec } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeRequest } from './fakeOpenRouter.js';
import { canaryOf, candidateOf, duelReply, questionOf } from './judgeReplies.js';

// Storage da SPA: vazio por padrão (= IndexedDB indisponível); o IMPL-049 da
// SPA liga `persist` para simular o IndexedDB que SOBREVIVE ao reload.
const webStore = vi.hoisted(() => ({ persist: false, runs: new Map<string, Record<string, unknown>>() }));
vi.mock('../web/src/engine/storage', () => ({
  saveRun: async (r: Record<string, unknown>) => {
    if (webStore.persist) webStore.runs.set(String(r.id), JSON.parse(JSON.stringify(r)) as Record<string, unknown>);
  },
  saveSession: async () => undefined,
  loadRun: async (id: string) => (webStore.persist ? (webStore.runs.get(id) ?? null) : null),
  loadSession: async () => null,
  listRuns: async () =>
    webStore.persist
      ? [...webStore.runs.values()].map((r) => ({ id: r.id, status: r.status, startedAt: r.startedAt }))
      : [],
  listSessions: async () => [],
}));

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const MODELOS = ['fake/judge', 'fake/a', 'fake/b', 'fake/c', 'fake/ref', 'fake/ref2', 'fake/gen'];

async function comGateway<T>(fetch: FetchLike, fn: () => Promise<T>): Promise<T> {
  const anterior = setDefaultGateway(createGateway({ fetch, sleep: noSleep }));
  try {
    return await fn();
  } finally {
    setDefaultGateway(anterior);
  }
}

const pointwise = (req: FakeRequest, verdict: string, confianca = 'alta'): string =>
  JSON.stringify({ canario: canaryOf(req), explanation: 'x', verdict, confianca });

let tmp: string;
let dirAnterior: string;
let silencio: Array<{ mockRestore(): void }> = [];
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pb-diag-wiring-'));
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

// ---------------------------------------------------------------------------
// IMPL-053
// ---------------------------------------------------------------------------

describe('IMPL-053 — diagnóstico de verbosidade ligado', () => {
  it('(a) sem scenarioId o confundidor de dificuldade contamina o betaLenRel; com ele, o efeito muda', () => {
    // Cenário DIFÍCIL: respostas longas e nota baixa; FÁCIL: curtas e nota alta.
    // Dentro de cada cenário o comprimento NÃO move a nota.
    const linha = (scenarioId: string, tokens: number, score: number, i: number): VerbositySampleRow => ({
      contestantId: `c${i % 2}`,
      source: 'pointwise',
      score,
      text: `r ${'w'.repeat(tokens / 4)}`,
      candidateTokens: tokens,
      referenceText: 'referência',
      referenceTokens: 100,
      scenarioId,
    });
    const rows: VerbositySampleRow[] = [];
    for (let i = 0; i < 8; i++) rows.push(linha('dificil', 400 + (i % 4) * 20, i % 2 ? 0 : 0.5, i));
    for (let i = 0; i < 8; i++) rows.push(linha('facil', 80 + (i % 4) * 20, i % 2 ? 1 : 0.5, i));
    const com = verbosityDiag(verbositySamples(rows), { permutations: 50, bootstrap: 20 })!;
    const sem = verbosityDiag(
      verbositySamples(rows.map(({ scenarioId: _s, ...r }) => r)),
      { permutations: 50, bootstrap: 20 },
    )!;
    expect(sem.betaLenRel).toBeLessThan(0); // confundido: "longo é pior"
    expect(com.betaLenRel).not.toBeCloseTo(sem.betaLenRel, 2);
  });

  it('(c) BudgetExceeded dentro do re-julgamento SOBE (controle, nunca "sonda falhou")', async () => {
    const rows: VerbositySampleRow[] = Array.from({ length: 10 }, (_, i) => ({
      contestantId: 'c',
      source: 'pointwise',
      score: 1,
      text: `resposta ${i}`,
    }));
    const erro = await runCounterfactualProbes({
      rows,
      rejudge: async () => {
        throw new BudgetExceeded(1, 1, 'judge');
      },
    }).catch((e: unknown) => e);
    expect(isControlSignal(erro)).toBe(true);
    // Erro COMUM continua degradando para "sem veredito" (fora da taxa).
    const pares = await runCounterfactualProbes({
      rows,
      rejudge: async () => {
        throw new Error('juiz caiu');
      },
    });
    expect(pares.every((p) => p.probeVerdict === null)).toBe(true);
  });

  const SEIS: StageSpec[] = Array.from({ length: 6 }, (_, i) => ({
    question: `CEN-${i} Qual o prazo?`,
    productContext: 'Trocas em 30 dias.',
    maxTokens: 400,
    reference: `Trinta dias (item ${i}).`,
  }));
  const CFG = {
    mode: 'compare',
    theme: 'suporte',
    stages: 6,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceModelId: 'fake/ref',
    referenceJudging: true,
    competitorModelIds: ['fake/a', 'fake/b'],
    customStages: SEIS,
    finalists: 0,
    duels: false,
    judgeEngine: 'llm',
    timeoutMs: 5_000,
  } as unknown as RunConfig;

  function fakeComprimento() {
    return fakeOpenRouter({
      catalog: MODELOS.map((id) => catalogItem(id, 1e-6, 1e-6)),
      chat: (req) => {
        if (req.stream) {
          const n = Number(/CEN-(\d)/.exec(req.user)?.[1] ?? 0);
          // fake/a curto; fake/b longo — e o tamanho varia por cenário.
          return { text: req.model === 'fake/a' ? `curta ${'x'.repeat(n)}` : `longa ${'y'.repeat(40 + n * 5)}` };
        }
        const c = candidateOf(req) ?? '';
        return { text: pointwise(req, c.length >= 30 ? 'resolve' : 'parcial') };
      },
    });
  }

  const motores = [
    ['Node', (cfg: RunConfig) => runNode(cfg, KEY, {})],
    ['SPA', (cfg: RunConfig) => runWeb(cfg as never, KEY, {}) as unknown as Promise<RunRecord>],
  ] as const;

  for (const [nome, rodar] of motores) {
    it(`(b) ${nome}: verbosityProbes ⇒ sondas rodam e a taxa de inversão é reportada; sem a flag, null`, async () => {
      const semFlag = fakeComprimento();
      const rec0 = await comGateway(semFlag.fetch, () => rodar(CFG));
      expect(rec0.judgeDiagnostics?.verbosity.verbosityDiag?.taxaInversaoSondas).toBeNull();

      const fake = fakeComprimento();
      const rec = await comGateway(fake.fetch, () => rodar({ ...CFG, verbosityProbes: true } as RunConfig));
      const diag = rec.judgeDiagnostics?.verbosity.verbosityDiag;
      expect(diag, 'diagnóstico ajustado').toBeTruthy();
      expect(typeof diag!.taxaInversaoSondas).toBe('number');
      // As sondas custaram chamadas de juiz (mais que a run sem sondas).
      const juizes = (f: ReturnType<typeof fakeOpenRouter>) => f.chatRequests().filter((r) => !r.stream).length;
      expect(juizes(fake)).toBeGreaterThan(juizes(semFlag));
    });
  }
});

// ---------------------------------------------------------------------------
// IMPL-055
// ---------------------------------------------------------------------------

describe('IMPL-055 — validação dos gabaritos no pipeline', () => {
  const DEZ: StageSpec[] = Array.from({ length: 10 }, (_, i) => ({
    question: `CEN-${i} Qual o prazo para trocar?`,
    productContext: 'Trocas em até 30 dias com nota fiscal.',
    maxTokens: 200,
    rubric: 'Deve dizer 30 dias com nota fiscal.',
  }));
  const CFG = {
    mode: 'compare',
    theme: 'suporte',
    stages: 10,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceModelId: 'fake/ref',
    referenceJudging: true,
    competitorModelIds: ['fake/a', 'fake/b'],
    customStages: DEZ,
    finalists: 2,
    validateReferences: true,
    secondReferenceModelId: 'fake/ref2',
    judgeEngine: 'llm',
    timeoutMs: 5_000,
  } as unknown as RunConfig;

  const ehVerificador = (r: FakeRequest) => r.system.includes('VERIFICADOR de gabaritos');
  const ehGabarito = (r: FakeRequest) => r.system === GABARITO_ROLE_PROMPT;

  function fakeValidacao() {
    return fakeOpenRouter({
      catalog: MODELOS.map((id) => catalogItem(id, 1e-6, 1e-6)),
      chat: (req) => {
        if (req.stream) return { text: `Resposta de ${req.model}` };
        if (ehGabarito(req)) {
          return { text: req.model === 'fake/ref2' ? 'Garantia estendida de doze meses para eletrônicos importados.' : `Trinta dias com nota (${questionOf(req) || req.user.slice(-40)}).` };
        }
        if (ehVerificador(req)) {
          // O gabarito do CEN-0 CONTRARIA a rubrica.
          const v = questionOf(req).startsWith('CEN-0') ? 'nao' : 'resolve';
          return { text: JSON.stringify({ canario: canaryOf(req), explanation: 'confere', verdict: v }) };
        }
        if (req.system.includes('DUELO')) return { text: duelReply(req, 'A') };
        return { text: pointwise(req, 'resolve') };
      },
    });
  }

  it('Node: divergência → 2º gabarito → needsHumanReview (preservado no re-read); custo extra ≤ 16%', async () => {
    const fake = fakeValidacao();
    const rec = await comGateway(fake.fetch, () => runNode(CFG, KEY, {}));
    const verif = fake.chatRequests().filter(ehVerificador);
    const segundo = fake.chatRequests().filter((r) => ehGabarito(r) && r.model === 'fake/ref2');
    expect(verif).toHaveLength(10); // 1 verificação por gabarito gerado
    expect(segundo).toHaveLength(1); // CONDICIONADO: só o divergente
    const fila = rec.needsHumanReview ?? [];
    expect(fila.filter((f) => f.stageIndex === 0).map((f) => f.reason)).toEqual(
      expect.arrayContaining(['reference_rubric_divergence', 'reference_disagreement']),
    );
    expect(fila.some((f) => f.stageIndex !== 0 && f.reason === 'reference_rubric_divergence')).toBe(false);
    expect(rec.stages[0].spec?.referenceValidation?.secondReference?.modelId).toBe('fake/ref2');
    // Re-read (disco + normalize) preserva a fila e a validação.
    const relido = normalizeRunRecord(JSON.parse(JSON.stringify(await loadRun(rec.id))));
    expect(relido.needsHumanReview).toEqual(rec.needsHumanReview);
    // Custo extra MEDIDO (usage.cost das chamadas de validação) / custo da iteração.
    const extra = (verif.length + segundo.length) * 0.001;
    const ratio = extra / (rec.totalCostUsd - extra);
    expect(ratio).toBeLessThanOrEqual(0.16);
  });

  it('SPA (mirror): a mesma fila', async () => {
    const fake = fakeValidacao();
    const rec = (await comGateway(fake.fetch, () => runWeb(CFG as never, KEY, {}))) as unknown as RunRecord;
    expect(rec.needsHumanReview?.some((f) => f.stageIndex === 0 && f.reason === 'reference_rubric_divergence')).toBe(true);
  });

  it('sem a flag: nenhuma chamada de validação (opt-in) e a fila não aparece', async () => {
    const fake = fakeValidacao();
    const { validateReferences: _v, secondReferenceModelId: _s, ...semFlag } = CFG as unknown as Record<string, unknown>;
    const rec = await comGateway(fake.fetch, () => runNode(semFlag as unknown as RunConfig, KEY, {}));
    expect(fake.chatRequests().filter(ehVerificador)).toHaveLength(0);
    expect(rec.needsHumanReview).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// IMPL-112 + IMPL-047
// ---------------------------------------------------------------------------

describe('IMPL-112 — saturação por item na run; IMPL-047 — confiança baixa na fila', () => {
  const DOIS: StageSpec[] = [
    { question: 'CEN-S Pergunta saturada?', productContext: 'c', maxTokens: 200, reference: 'R0' },
    { question: 'CEN-M Pergunta mista?', productContext: 'c', maxTokens: 200, reference: 'R1' },
  ];
  const CFG = {
    mode: 'compare',
    theme: 'suporte',
    stages: 2,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceModelId: 'fake/ref',
    referenceJudging: true,
    competitorModelIds: ['fake/a', 'fake/b', 'fake/c'],
    customStages: DOIS,
    finalists: 0,
    duels: false,
    judgeEngine: 'llm',
    timeoutMs: 5_000,
  } as unknown as RunConfig;
  const fake = () =>
    fakeOpenRouter({
      catalog: MODELOS.map((id) => catalogItem(id, 1e-6, 1e-6)),
      chat: (req) => {
        if (req.stream) return { text: `Resposta de ${req.model}` };
        if (questionOf(req).startsWith('CEN-S')) return { text: pointwise(req, 'resolve') };
        const c = candidateOf(req);
        return { text: pointwise(req, c === 'Resposta de fake/a' ? 'nao' : 'resolve', c === 'Resposta de fake/b' ? 'baixa' : 'alta') };
      },
    });

  for (const [nome, rodar] of [
    ['Node', (cfg: RunConfig) => runNode(cfg, KEY, {})],
    ['SPA', (cfg: RunConfig) => runWeb(cfg as never, KEY, {}) as unknown as Promise<RunRecord>],
  ] as const) {
    it(`${nome}: item 100% 'resolve' em k=3 execuções vai para a revisão; nada é descartado`, async () => {
      const rec = await comGateway(fake().fetch, () => rodar(CFG));
      const sat = rec.itemSaturation!;
      expect(sat.items).toHaveLength(2); // nenhum item descartado
      expect(sat.reviewQueue.map((i) => i.question)).toEqual(['CEN-S Pergunta saturada?']);
      expect(sat.reviewQueue[0]).toMatchObject({ saturated: 'all-resolve', needsReview: true, executions: 3 });
      // IMPL-047: o veredito com confiança 'baixa' (fake/b no CEN-M) entra na fila.
      expect(rec.needsHumanReview).toEqual([
        expect.objectContaining({ stageIndex: 1, contestantId: 'fake/b', reason: 'low_confidence_verdict' }),
      ]);
    });
  }
});

// ---------------------------------------------------------------------------
// `runs show` (CLI real): auditoria do contrato, falhas agrupadas, filas
// ---------------------------------------------------------------------------

describe('IMPL-057/055/112 — `runs show` mostra o que a run gravou', () => {
  it('linha de auditoria, ≤ 4 grupos de falha, fila de revisão e saturação (texto e --json)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-show-diag-'));
    const antes = getDataDir();
    setDataDir(dir);
    try {
      const fakeCli = fakeOpenRouter({
        catalog: MODELOS.map((id) => catalogItem(id, 1e-6, 1e-6)),
        chat: (req) => {
          if (req.stream) return { text: `Resposta de ${req.model}` };
          // O juiz FALHA (saída inválida duas vezes) para fake/c ⇒ veredito ausente.
          if (candidateOf(req) === 'Resposta de fake/c') return { text: 'não sei' };
          return { text: pointwise(req, 'resolve', candidateOf(req) === 'Resposta de fake/b' ? 'baixa' : 'alta') };
        },
      });
      const cfg = {
        mode: 'compare',
        theme: 'suporte',
        stages: 3,
        datagenModelId: 'fake/gen',
        judgeModelIds: ['fake/judge'],
        referenceModelId: 'fake/ref',
        referenceJudging: true,
        competitorModelIds: ['fake/a', 'fake/b', 'fake/c'],
        finalists: 0,
        duels: false,
        judgeEngine: 'llm',
        timeoutMs: 5_000,
        customStages: Array.from({ length: 3 }, (_, i) => ({
          question: `CEN-${i} Prazo?`,
          productContext: 'c',
          maxTokens: 200,
          reference: 'R',
        })),
      } as unknown as RunConfig;
      // Data dir novo = processo novo do CLI: sem run gravada NEM memória de
      // contrato (a memória do processo é a âncora de reserva — IMPL-049).
      resetJudgeContractMemory();
      const rec = await comGateway(fakeCli.fetch, () => runNode(cfg, KEY, {}));
      const { spawnSync } = await import('node:child_process');
      const { fileURLToPath } = await import('node:url');
      const { nodeOrTsx } = await import('./support/cli.js');
      const root = fileURLToPath(new URL('..', import.meta.url));
      const { cmd, entry } = nodeOrTsx(join(root, 'src', 'cli', 'index.ts'));
      const cli = (...args: string[]) =>
        spawnSync(cmd, [entry, 'runs', ...args, '--data-dir', dir], {
          cwd: root,
          encoding: 'utf-8',
          timeout: 60_000,
          env: { ...process.env, OPENROUTER_API_KEY: '', CI: '1' },
        });
      const txt = cli('show', rec.id);
      expect(txt.status, txt.stderr).toBe(0);
      expect(txt.stdout).toContain('juiz: fake/judge (primeira run');
      expect(txt.stdout).toMatch(/falhas de veredito: 3 em 3 grupo\(s\)/);
      expect(txt.stdout).toContain('revisão humana: 3 item(ns)');
      expect(txt.stdout).toContain('low_confidence_verdict');
      const js = cli('show', rec.id, '--json');
      const payload = JSON.parse(js.stdout) as { data: { verdictFailureGroups: { cause: string; count: number }[] } };
      expect(payload.data.verdictFailureGroups.map((g) => g.cause)).toEqual(['invalid_output', 'invalid_output', 'invalid_output']);
    } finally {
      setDataDir(antes);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// IMPL-049
// ---------------------------------------------------------------------------

describe('IMPL-049 — drift do contrato entre PROCESSOS (âncora gravada)', () => {
  const CFG = {
    mode: 'compare',
    theme: 'suporte',
    stages: 1,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceModelId: 'fake/ref',
    referenceJudging: true,
    competitorModelIds: ['fake/a', 'fake/b'],
    finalists: 0,
    duels: false,
    judgeEngine: 'llm',
    timeoutMs: 5_000,
    customStages: [{ question: 'CEN-X Prazo?', productContext: 'c', maxTokens: 200, reference: 'R' }],
  } as unknown as RunConfig;
  const fake = () =>
    fakeOpenRouter({
      catalog: MODELOS.map((id) => catalogItem(id, 1e-6, 1e-6)),
      chat: (req) => (req.stream ? { text: 'ok' } : { text: pointwise(req, 'resolve') }),
    });

  it('memória zerada entre runs (= outro processo do CLI) e o evento AINDA dispara; contractAudit no record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-impl049-proc-'));
    const antes = getDataDir();
    setDataDir(dir);
    try {
      resetJudgeContractMemory();
      const r1 = await comGateway(fake().fetch, () => runNode(CFG, KEY, {}));
      expect(r1.judgeDiagnostics?.contractAudit).toMatchObject({ changed: false });
      expect(r1.judgeDiagnostics?.contractAudit?.line).toContain('primeira run');

      resetJudgeContractMemory(); // "novo processo"
      const eventos: RunEvent[] = [];
      const runId = '00000000-0000-4000-8000-000000000492';
      const off = subscribe(runId, (e) => eventos.push(e));
      let r2: RunRecord;
      try {
        r2 = await comGateway(fake().fetch, () =>
          runNode({ ...CFG, reasoning: { judge: 'high' } } as RunConfig, KEY, { runId }),
        );
      } finally {
        off();
      }
      expect(eventos.filter((e) => e.type === 'judge.contract.changed')).toHaveLength(1);
      expect(r2!.judgeDiagnostics?.contractAudit).toMatchObject({
        changed: true,
        previousHash: r1.judgeDiagnostics!.contract.hash,
        previousRunId: r1.id,
      });
      expect(r2!.judgeDiagnostics?.contractAudit?.line).toContain('scores não comparáveis');
      expect(r2!.judgeDiagnostics?.contractAudit?.detail).toContain(r2!.judgeDiagnostics!.contract.hash.slice(0, 12));

      resetJudgeContractMemory();
      const r3 = await comGateway(fake().fetch, () =>
        runNode({ ...CFG, reasoning: { judge: 'high' } } as RunConfig, KEY, {}),
      );
      expect(r3.judgeDiagnostics?.contractAudit).toMatchObject({ changed: false, previousRunId: r2!.id });
      expect(r3.judgeDiagnostics?.contractAudit?.line).toContain('mesmo contrato desde a última run');
    } finally {
      setDataDir(antes);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SPA: storage persistido (IndexedDB) + memória zerada entre runs (= reload) — o evento AINDA dispara', async () => {
    webStore.persist = true;
    webStore.runs.clear();
    try {
      const rodarWeb = async (cfg: RunConfig, runId?: string) =>
        (await comGateway(fake().fetch, () => runWeb(cfg as never, KEY, runId ? { runId } : {}))) as unknown as RunRecord;
      resetJudgeContractMemory();
      const r1 = await rodarWeb(CFG);
      // 1 cenário: 'inconclusive' (n efetivo < 5) — terminal e âncora válida.
      expect(['finished', 'inconclusive'], r1.error).toContain(r1.status);
      expect(r1.judgeDiagnostics?.contractAudit?.line).toContain('primeira run');

      resetJudgeContractMemory(); // "reload" da aba: só o IndexedDB sobrevive
      const eventos: WebRunEvent[] = [];
      const runId = '00000000-0000-4000-8000-000000000493';
      const off = subscribeWeb(runId, (e) => eventos.push(e));
      let r2: RunRecord;
      try {
        r2 = await rodarWeb({ ...CFG, reasoning: { judge: 'high' } } as RunConfig, runId);
      } finally {
        off();
      }
      expect(eventos.filter((e) => e.type === 'judge.contract.changed')).toHaveLength(1);
      expect(r2!.judgeDiagnostics?.contractAudit).toMatchObject({
        changed: true,
        previousHash: r1.judgeDiagnostics!.contract.hash,
        previousRunId: r1.id,
      });

      resetJudgeContractMemory();
      const r3 = await rodarWeb({ ...CFG, reasoning: { judge: 'high' } } as RunConfig);
      expect(r3.judgeDiagnostics?.contractAudit).toMatchObject({ changed: false, previousRunId: r2!.id });
      expect(r3.judgeDiagnostics?.contractAudit?.line).toContain('mesmo contrato desde a última run');
    } finally {
      webStore.persist = false;
      webStore.runs.clear();
    }
  });

  it('sem run gravada legível (IndexedDB indisponível): a memória do processo é a reserva — MESMO contrato ⇒ "mesmo contrato"', async () => {
    // Storage da SPA vazio (listRuns → []): a âncora só pode vir da memória.
    resetJudgeContractMemory();
    const r1 = (await comGateway(fake().fetch, () => runWeb(CFG as never, KEY, {}))) as unknown as RunRecord;
    expect(r1.judgeDiagnostics?.contractAudit?.line).toContain('primeira run');
    const r2 = (await comGateway(fake().fetch, () => runWeb(CFG as never, KEY, {}))) as unknown as RunRecord;
    expect(r2.judgeDiagnostics?.contractAudit).toMatchObject({
      changed: false,
      previousHash: r1.judgeDiagnostics!.contract.hash,
    });
    expect(r2.judgeDiagnostics?.contractAudit?.line).toContain('mesmo contrato desde a última run');
    expect(r2.judgeDiagnostics?.contractAudit?.line).not.toContain('primeira run');
  });
});
