// IMPL-019 (R-07b:REC-8) — ciclo de vida de modelos: o que a run grava do
// catálogo, as janelas de alerta 30/14/7 dias, a política de remoção e o job
// semanal que confere ids citados nas docs. Zero rede: o catálogo é um recorte
// REAL de GET /models de 2026-09-27 (test/fixtures) ou o transporte falso.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkCitedModelIds,
  daysUntil,
  expirationWindow,
  extractModelIds,
  judgeIdentity,
  judgeIdentityChanged,
  knownVendorsFrom,
  mergeJudgeIdentity,
  lifecycleAlertFor,
  modelRolesForRun,
  parseLifecycleMeta,
  removalAction,
  snapshotModelLifecycle,
  suggestSuccessor,
} from '../src/engine/modelLifecycle.js';
import { createGateway, parseModelsPayload, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { normalizeRunRecord } from '../src/normalize.js';
import { toExportRow } from '../src/modelCaps.js';
import { runModelIdsCheck } from '../src/modelIdsCheck.js';
import { setDataDir, getDataDir } from '../src/storage.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { prepareOptsFor } from '../src/prepareRun.js';
import type { OpenRouterModel, RunConfig, RunRecord } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter } from './fakeOpenRouter.js';
import { expectPipelineDone } from './runOutcome.js';
import { duelReply, pointwiseReply } from './judgeReplies.js';

// O storage do web é IndexedDB — fora do navegador, um no-op em memória.
vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(ROOT, 'test', 'fixtures', 'models-2026-09-27.json');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const HOJE = new Date('2026-09-27T12:00:00Z');

/** Catálogo real do recorte, pelo MESMO parser da produção. */
function catalogoReal(): OpenRouterModel[] {
  return parseModelsPayload(JSON.parse(readFileSync(FIXTURE, 'utf-8')));
}

describe('parse do catálogo: canonical_slug / expiration_date / alias_target', () => {
  it('parseModelsPayload carrega os campos de ciclo de vida (e o export também)', () => {
    const cat = catalogoReal();
    const flash = cat.find((m) => m.id === 'google/gemini-2.5-flash')!;
    expect(flash.canonicalSlug).toBe('google/gemini-2.5-flash');
    expect(flash.expirationDate).toBe('2026-10-20');
    const sonnet = cat.find((m) => m.id === 'anthropic/claude-sonnet-5')!;
    expect(sonnet.canonicalSlug).toBe('anthropic/claude-sonnet-5-20260630');
    expect(sonnet.expirationDate).toBeNull(); // o catálogo DISSE "sem data"
    const alias = cat.find((m) => m.id === '~google/gemini-flash-latest')!;
    expect(alias.aliasTarget).toBe('google/gemini-3.8-flash');
    expect(toExportRow(flash).lifecycle).toEqual({
      canonicalSlug: 'google/gemini-2.5-flash',
      expirationDate: '2026-10-20',
      aliasTarget: null,
    });
  });

  it('normaliza data ISO completa e ignora lixo', () => {
    expect(parseLifecycleMeta({ expiration_date: '2026-10-09T00:00:00Z' }).expirationDate).toBe('2026-10-09');
    expect(parseLifecycleMeta({ expiration_date: 'amanhã' }).expirationDate).toBeUndefined();
    expect(parseLifecycleMeta({ alias_target: 'x/y' }).aliasTarget).toBe('x/y');
    expect(parseLifecycleMeta({})).toEqual({});
  });
});

describe('janelas 30/14/7 dias', () => {
  it('daysUntil conta dias de calendário em UTC', () => {
    expect(daysUntil('2026-09-28', HOJE)).toBe(1);
    expect(daysUntil('2026-09-27', HOJE)).toBe(0);
    expect(daysUntil('2026-10-20', HOJE)).toBe(23);
    expect(daysUntil('ontem', HOJE)).toBeNull();
  });

  it.each([
    [45, null], [31, null], [30, 30], [15, 30], [14, 14], [8, 14], [7, 7], [1, 7], [0, null], [-3, null],
  ])('faltando %i dias → janela %s', (dias, janela) => {
    expect(expirationWindow(dias)).toBe(janela);
  });
});

describe('alerta com sucedâneo e política de remoção', () => {
  const cat = catalogoReal();
  const byId = (id: string) => cat.find((m) => m.id === id);

  it('(iv) expiration_date ≤ 30 dias gera AVISO com sucedâneo nomeado pelo catálogo', () => {
    const a = lifecycleAlertFor('google/gemini-2.5-flash', ['judge'], byId('google/gemini-2.5-flash'), cat, HOJE)!;
    expect(a.kind).toBe('expiring');
    expect(a.daysLeft).toBe(23);
    expect(a.window).toBe(30);
    expect(a.successor).toEqual({
      id: 'google/gemini-3.8-flash',
      source: 'alias',
      via: '~google/gemini-flash-latest',
    });
    expect(a.action).toBe('bridge-run'); // anunciada + sucessor nomeado → run-ponte
    expect(a.message).toContain('google/gemini-3.8-flash');
  });

  it('(iv) data futura além de 30 dias NÃO falha nem avisa; sem data idem', () => {
    const futuro = { ...byId('google/gemini-2.5-flash')!, expirationDate: '2026-12-31' };
    expect(lifecycleAlertFor(futuro.id, ['judge'], futuro, cat, HOJE)).toBeNull();
    expect(lifecycleAlertFor('openai/gpt-5-mini', ['judge'], byId('openai/gpt-5-mini'), cat, HOJE)).toBeNull();
  });

  it('janela de 7 dias e expiração consumada', () => {
    const v32 = byId('deepseek/deepseek-v3.2')!; // expira 2026-09-28 no catálogo real
    expect(lifecycleAlertFor(v32.id, ['competitor'], v32, cat, HOJE)!.window).toBe(7);
    const depois = new Date('2026-09-29T00:00:00Z');
    const exp = lifecycleAlertFor(v32.id, ['competitor'], v32, cat, depois)!;
    expect(exp.kind).toBe('expired');
    expect(exp.action).toBe('freeze-rescore'); // competidor: congela e re-pontua (default)
  });

  it('sucessor: declarado > alias do catálogo > heurística (heurística não é "nomeado")', () => {
    expect(suggestSuccessor('google/gemini-2.5-flash', cat, { 'google/gemini-2.5-flash': 'openai/gpt-5-mini' }))
      .toEqual({ id: 'openai/gpt-5-mini', source: 'declared' });
    expect(suggestSuccessor('google/gemini-2.5-pro', cat)?.source).toBe('alias');
    const heur = suggestSuccessor('deepseek/deepseek-v4', cat)!;
    expect(heur.source).toBe('heuristic');
    expect(heur.id.startsWith('deepseek/')).toBe(true);
  });

  it('política: tabela de decisão', () => {
    const alias = { id: 'x/b', source: 'alias' as const };
    const heur = { id: 'x/b', source: 'heuristic' as const };
    expect(removalAction({ phase: 'announced', roles: ['judge'], successor: alias })).toBe('bridge-run');
    expect(removalAction({ phase: 'announced', roles: ['judge'], successor: heur })).toBe('freeze-rescore');
    expect(removalAction({ phase: 'removed', roles: ['competitor'], successor: null })).toBe('freeze-rescore');
    expect(removalAction({ phase: 'removed', roles: ['judge'], successor: alias })).toBe('freeze-rescore');
    expect(removalAction({ phase: 'removed', roles: ['reference'], successor: heur })).toBe('invalidate-baseline');
    expect(removalAction({ phase: 'removed', roles: ['judge'], successor: null })).toBe('invalidate-baseline');
  });
});

describe('snapshot gravado na run', () => {
  it('papéis: gabarito cai no 1º juiz; otimizador no datagen em variation', () => {
    const roles = modelRolesForRun(
      { mode: 'variation', datagenModelId: 'g/d', judgeModelIds: ['g/j'] },
      [{ modelId: 'g/c' }, { modelId: 'g/c' }],
    );
    expect(roles).toEqual({
      'g/c': ['competitor'],
      'g/j': ['judge', 'reference'],
      'g/d': ['datagen', 'optimizer'],
    });
  });

  it('catálogo indisponível: entradas presentes com null explícito e NENHUM alerta inventado', () => {
    const snap = snapshotModelLifecycle({ 'a/b': ['judge'] }, [], HOJE);
    expect(snap.source).toBe('unavailable');
    expect(snap.models['a/b']).toEqual({
      modelId: 'a/b', roles: ['judge'], inCatalog: false,
      canonicalSlug: null, expirationDate: null, aliasTarget: null,
    });
    expect(snap.alerts).toEqual([]);
  });

  it('judgeIdentity: alias do juiz movido é deriva; catálogo fora do ar numa iteração NÃO é', () => {
    const run = (alvo: string | null, hash = 'h1') => ({
      judgeDiagnostics: { contract: { hash } },
      modelLifecycle: snapshotModelLifecycle(
        { '~v/juiz-latest': ['judge'] },
        alvo === null ? [] : [{ id: '~v/juiz-latest', canonicalSlug: '~v/juiz-latest', aliasTarget: alvo }],
        HOJE,
      ),
    });
    const id1 = judgeIdentity(run('v/juiz-1'))!;
    expect(judgeIdentityChanged(id1, judgeIdentity(run('v/juiz-1'))!)).toBe(false);
    expect(judgeIdentityChanged(id1, judgeIdentity(run('v/juiz-2'))!)).toBe(true); // alias movido
    expect(judgeIdentityChanged(id1, judgeIdentity(run('v/juiz-1', 'h2'))!)).toBe(true); // prompt do juiz
    const semCatalogo = judgeIdentity(run(null))!;
    expect(judgeIdentityChanged(id1, semCatalogo)).toBe(false);
    // a referência aprende o snapshot que faltava e passa a vigiar a deriva
    const ref = mergeJudgeIdentity(semCatalogo, id1);
    expect(judgeIdentityChanged(ref, judgeIdentity(run('v/juiz-2'))!)).toBe(true);
    expect(judgeIdentity({})).toBeUndefined();
  });

  it('whitelist: normalizeRunRecord preserva modelLifecycle ao reler do disco/IndexedDB', () => {
    const snap = snapshotModelLifecycle({ 'a/b': ['judge'] }, [{ id: 'a/b', canonicalSlug: 'a/b-1', expirationDate: null }], HOJE);
    const relido = normalizeRunRecord(JSON.parse(JSON.stringify({
      id: 'r1', status: 'finished', config: { mode: 'compare', judgeModelIds: ['a/b'] },
      stages: [], scoreboard: {}, totalCostUsd: 0, startedAt: HOJE.toISOString(), modelLifecycle: snap,
    })));
    expect(relido.modelLifecycle).toEqual(snap);
  });
});

// --- (i) 100% das runs, nos DOIS motores -------------------------------------

const DEZ_DIAS = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);

function fakeComCicloDeVida(): FakeOpenRouter {
  const extras: Record<string, Record<string, unknown>> = {
    'fake/gen': { canonical_slug: 'fake/gen-20260101', expiration_date: null },
    'fake/ref': { canonical_slug: 'fake/ref-20260101', expiration_date: null },
    'fake/judge': { canonical_slug: 'fake/judge-20260101', expiration_date: DEZ_DIAS },
    'fake/a': { canonical_slug: 'fake/a-20260101', expiration_date: null },
    'fake/b': { canonical_slug: 'fake/b-20260101' }, // sem o campo: vira null explícito
    'fake/opt': { canonical_slug: 'fake/opt-20260101', expiration_date: null },
    'fake/judge-2': { canonical_slug: 'fake/judge-2-20260901', expiration_date: null },
    '~fake/judge-latest': { canonical_slug: '~fake/judge-latest', alias_target: { slug: 'fake/judge-2' } },
  };
  return fakeOpenRouter({
    catalog: Object.entries(extras).map(([id, extra]) => catalogItem(id, 1e-6, 1e-6, extra)),
    chat: (req) => {
      const usage = { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 };
      if (req.model === 'fake/gen') {
        return {
          text: JSON.stringify({
            stages: [
              { question: 'Qual o prazo de troca de um tenis?', productContext: 'Trocas em 30 dias.', maxTokens: 200 },
              { question: 'Como calcular juros compostos mensais?', productContext: 'M = C (1 + i)^n.', maxTokens: 200 },
            ],
          }),
          usage,
        };
      }
      if (req.model === 'fake/opt') {
        const tecnica = /tecnica id="([^"]+)"/.exec(req.user)?.[1] ?? 'x';
        return {
          text: `Voce e um atendente cordial e preciso (${tecnica}). Responda sempre com base no contexto do produto, cite prazos e regras exatamente como aparecem e recuse o que estiver fora do escopo.`,
          usage,
        };
      }
      if (req.model === 'fake/ref') return { text: 'Gabarito de referencia.', usage };
      if (req.stream) return { text: `Resposta de ${req.model}`, usage };
      if (req.system.includes('DUELO')) return { text: duelReply(req, 'A', 'A melhor'), usage };
      return { text: pointwiseReply(req, 'resolve', 'confere'), usage };
    },
  });
}

const COMPARE = {
  mode: 'compare',
  theme: 'suporte ao cliente',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  finalists: 2,
  timeoutMs: 5_000,
} as const;

const VARIATION = {
  mode: 'variation',
  theme: 'suporte ao cliente',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  contestantModelId: 'fake/a',
  basePrompt: 'Voce e um atendente de suporte. Responda com base no contexto do produto.',
  techniqueIds: ['persona', 'constraints'],
  promptOptimization: true,
  optimizerModelId: 'fake/opt',
  finalists: 2,
  timeoutMs: 5_000,
} as const;

/** (i): TODO modelo da run tem os 3 campos preenchidos (null explícito quando o catálogo não informa). */
function conferirCicloDeVida(rec: Pick<RunRecord, 'status' | 'error' | 'modelLifecycle'>, esperados: Record<string, string[]>): void {
  expectPipelineDone(rec);
  const snap = rec.modelLifecycle!;
  expect(snap, 'run sem modelLifecycle').toBeDefined();
  expect(snap.source).toBe('catalog');
  expect(Object.keys(snap.models).sort()).toEqual(Object.keys(esperados).sort());
  for (const [id, papeis] of Object.entries(esperados)) {
    const e = snap.models[id];
    expect(e.roles.sort(), id).toEqual([...papeis].sort());
    expect(e.inCatalog, id).toBe(true);
    for (const campo of ['canonicalSlug', 'expirationDate', 'aliasTarget'] as const) {
      expect(e[campo], `${id}.${campo}`).not.toBeUndefined();
    }
    expect(e.canonicalSlug).toBe(`${id}-20260101`);
  }
  // O juiz expira em 10 dias: alerta da janela de 14, com o sucessor nomeado pelo alias.
  const alerta = snap.alerts.find((a) => a.modelId === 'fake/judge')!;
  expect(alerta.kind).toBe('expiring');
  expect(alerta.window).toBe(14);
  expect(alerta.successor).toEqual({ id: 'fake/judge-2', source: 'alias', via: '~fake/judge-latest' });
  expect(alerta.action).toBe('bridge-run');
  expect(snap.alerts.filter((a) => a.modelId !== 'fake/judge')).toEqual([]);
}

describe('(i) RunRecord.modelLifecycle em 100% das runs — Node e SPA (transporte falso)', () => {
  let anterior: OpenRouterGateway;
  let dirAnterior: string;
  let tmp: string;
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl019-'));
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

  async function comFake<T>(fn: () => Promise<T>): Promise<T> {
    const fake = fakeComCicloDeVida();
    anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    try {
      return await fn();
    } finally {
      setDefaultGateway(anterior);
    }
  }

  const PAPEIS_COMPARE = {
    'fake/gen': ['datagen'],
    'fake/ref': ['reference'],
    'fake/judge': ['judge'],
    'fake/a': ['competitor'],
    'fake/b': ['competitor'],
  };

  it('Node — compare', async () => {
    const rec = await comFake(() => runNode(COMPARE as unknown as RunConfig, 'sk-fake', {}));
    conferirCicloDeVida(rec, PAPEIS_COMPARE);
    // `fake/b` não trouxe expiration_date: null explícito, não undefined.
    expect(rec.modelLifecycle!.models['fake/b'].expirationDate).toBeNull();
  });

  it('SPA — compare', async () => {
    const rec = await comFake(() => runWeb(COMPARE as never, 'sk-fake', {}));
    conferirCicloDeVida(rec as unknown as RunRecord, PAPEIS_COMPARE);
  });

  it('Node — variation (o prepare troca os contestants e o otimizador entra no snapshot)', async () => {
    const rec = await comFake(() =>
      runNode(VARIATION as unknown as RunConfig, 'sk-fake', prepareOptsFor(VARIATION as unknown as RunConfig, 'sk-fake')),
    );
    conferirCicloDeVida(rec, {
      'fake/gen': ['datagen'],
      'fake/ref': ['reference'],
      'fake/judge': ['judge'],
      'fake/a': ['competitor'],
      'fake/opt': ['optimizer'],
    });
  });

  it('Node — catálogo fora do ar: a run segue e o snapshot diz "unavailable" (não inventa ausência)', async () => {
    const fake = fakeOpenRouter({ catalog: [], chat: (req) => ({ text: pointwiseReply(req, 'resolve', 'ok') }) });
    const prev = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    try {
      const rec = await runNode(
        { ...COMPARE, customStages: [{ question: 'Pergunta?', productContext: 'Contexto.', maxTokens: 100 }] } as unknown as RunConfig,
        'sk-fake-2',
        {},
      );
      expect(rec.modelLifecycle?.source).toBe('unavailable');
      expect(Object.keys(rec.modelLifecycle!.models).length).toBe(5);
      expect(rec.modelLifecycle!.alerts).toEqual([]);
    } finally {
      setDefaultGateway(prev);
    }
  });
});

// --- (ii) job semanal: ids citados × catálogo --------------------------------

/** Linha 5 do agent-docs/compare.md ANTES da correção (ids que nunca existiram). */
const COMPARE_ANTES = [
  '```bash',
  'prompt-builder compare \\',
  '  --models openai/gpt-5-mini,google/gemini-3-flash,deepseek/deepseek-v4 \\',
  '  --judge anthropic/claude-sonnet-5 \\',
  '```',
].join('\n');

describe('extração de ids citados', () => {
  const vendors = knownVendorsFrom(catalogoReal());

  it('pega ids reais (inclusive alias ~ e :variante) e ignora caminhos, URLs, escopos e placeholders', () => {
    const texto = [
      'use `openai/gpt-5-mini` ou "~anthropic/claude-sonnet-latest" e qwen/qwen3-max:free',
      'veja src/cli/index.ts, agent-docs/models.md e https://openrouter.ai/google/gemini-2.5-pro',
      'npm i @openai/agents · "competitors": ["anthropic/claude-…", "openai/gpt-*", "google/gemini-..."]',
      'removido de propósito: deepseek/deepseek-v4 <!-- model-ids:ignore -->',
    ].join('\n');
    expect(extractModelIds(texto, vendors).map((c) => c.id)).toEqual([
      'openai/gpt-5-mini',
      '~anthropic/claude-sonnet-latest',
      'qwen/qwen3-max:free',
    ]);
  });

  it('(ii) reprova os exemplos quebrados de HOJE e passa após a correção', () => {
    const cat = catalogoReal();
    const cite = (texto: string) =>
      extractModelIds(texto, knownVendorsFrom(cat)).map((c) => ({ ...c, file: 'agent-docs/compare.md' }));
    const antes = checkCitedModelIds(cite(COMPARE_ANTES), cat, HOJE);
    expect(antes.ok).toBe(false);
    expect(antes.failures.map((f) => f.id).sort()).toEqual(['deepseek/deepseek-v4', 'google/gemini-3-flash']);
    expect(antes.failures.every((f) => f.line === 3 && f.alert.kind === 'missing')).toBe(true);
    // o sucedâneo vem junto: o alias do catálogo nomeia o do gemini
    expect(antes.failures.find((f) => f.id === 'google/gemini-3-flash')!.alert.successor?.id).toBe('google/gemini-3.8-flash');

    const depois = checkCitedModelIds(
      cite(COMPARE_ANTES.replace('google/gemini-3-flash,deepseek/deepseek-v4', 'google/gemini-3.8-flash,deepseek/deepseek-v4-pro')),
      cat,
      HOJE,
    );
    expect(depois.ok).toBe(true);
    expect(depois.failures).toEqual([]);
  });

  it('canonical_slug citado (ex.: JSON de exemplo do export) vale pelo modelo dono', () => {
    const cat = catalogoReal();
    const r = checkCitedModelIds(
      [
        { id: 'anthropic/claude-sonnet-5-20260630', file: 'agent-docs/lifecycle.md', line: 21 },
        { id: 'google/gemini-2.5-flash', file: 'x.md', line: 1 },
      ],
      cat,
      HOJE,
    );
    expect(r.ok).toBe(true);
    // e um slug de snapshot que não pertence a ninguém continua reprovando
    const r2 = checkCitedModelIds([{ id: 'anthropic/claude-sonnet-5-20990101', file: 'x.md', line: 1 }], cat, HOJE);
    expect(r2.ok).toBe(false);
  });

  it('(iv) citação com expiração ≤ 30 dias só AVISA; depois da data REPROVA', () => {
    const cat = catalogoReal();
    const cited = [{ id: 'google/gemini-2.5-flash', file: 'agent-docs/agent-task.md', line: 182 }];
    const hoje = checkCitedModelIds(cited, cat, HOJE);
    expect(hoje.ok).toBe(true);
    expect(hoje.warnings).toHaveLength(1);
    expect(hoje.warnings[0].alert.successor?.id).toBe('google/gemini-3.8-flash');
    const depois = checkCitedModelIds(cited, cat, new Date('2026-10-21T00:00:00Z'));
    expect(depois.ok).toBe(false);
    expect(depois.failures[0].alert.kind).toBe('expired');
  });

  it('runModelIdsCheck varre agent-docs/, skills/ e README.md de uma raiz explícita', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'pb-ids-'));
    try {
      mkdirSync(join(raiz, 'agent-docs'));
      mkdirSync(join(raiz, 'skills', 'x'), { recursive: true });
      writeFileSync(join(raiz, 'agent-docs', 'compare.md'), COMPARE_ANTES);
      writeFileSync(join(raiz, 'skills', 'x', 'SKILL.md'), 'modelo: openai/gpt-5-nano');
      writeFileSync(join(raiz, 'README.md'), '`moonshotai/kimi-k2.6`');
      writeFileSync(join(raiz, 'fora.md'), 'google/gemini-3-flash'); // fora dos alvos: não conta
      const r = await runModelIdsCheck({ root: raiz, catalog: catalogoReal(), now: HOJE });
      expect(r.files).toBe(3);
      expect(r.failures.map((f) => `${f.file}:${f.line}:${f.id}`).sort()).toEqual([
        'agent-docs/compare.md:3:deepseek/deepseek-v4',
        'agent-docs/compare.md:3:google/gemini-3-flash',
      ]);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });
});

describe('(ii) scripts/check-model-ids.ts — exit code de verdade (o que o workflow roda)', () => {
  const rodar = (raiz: string): { status: number | null; stdout: string } => {
    const r = spawnSync(
      TSX,
      ['scripts/check-model-ids.ts', '--root', raiz, '--catalog', FIXTURE, '--now', HOJE.toISOString()],
      { cwd: ROOT, encoding: 'utf-8', timeout: 60_000 },
    );
    return { status: r.status, stdout: r.stdout };
  };

  it('reprova (exit 1) com os ids quebrados e passa (exit 0) depois da correção', () => {
    const raiz = mkdtempSync(join(tmpdir(), 'pb-ids-cli-'));
    try {
      mkdirSync(join(raiz, 'agent-docs'));
      writeFileSync(join(raiz, 'agent-docs', 'compare.md'), COMPARE_ANTES);
      const antes = rodar(raiz);
      expect(antes.status).toBe(1);
      expect(antes.stdout).toContain('google/gemini-3-flash');
      expect(antes.stdout).toContain('deepseek/deepseek-v4 ');

      writeFileSync(
        join(raiz, 'agent-docs', 'compare.md'),
        COMPARE_ANTES.replace('google/gemini-3-flash,deepseek/deepseek-v4', 'google/gemini-3.8-flash,deepseek/deepseek-v4-pro'),
      );
      const depois = rodar(raiz);
      expect(depois.status).toBe(0);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  }, 120_000);

  it('o agent-docs/compare.md DO REPOSITÓRIO (corrigido) passa contra o recorte de 2026-09-27', () => {
    // Só o arquivo corrigido por este item: conferir TODAS as docs contra um
    // recorte congelado reprovaria ids novos e válidos — isso é papel do job
    // semanal contra o catálogo ao vivo, não do npm test.
    const r = spawnSync(
      TSX,
      ['scripts/check-model-ids.ts', '--catalog', FIXTURE, '--now', HOJE.toISOString(), '--target', 'agent-docs/compare.md'],
      { cwd: ROOT, encoding: 'utf-8', timeout: 60_000 },
    );
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('0 reprovado(s)');
  }, 120_000);
});
