// IMPL-003 (R-03b:REC-5 / DEC-4) — `labelSet` OBRIGATÓRIO para rótulo curto.
//
// Contrato verificado aqui (sem rede, sem gasto):
//   • `expected` curto (≤5 palavras) sem `labelSet` REPROVA em toda porta de
//     entrada de config: `parseRunConfig` (API/CLI/MCP), `arena-config@1` (CLI e
//     o espelho do SPA), pacote de cenários, item da biblioteca;
//   • no CLI a reprovação é `CliError(EXIT.CONFIG)` = exit 3 — inclusive no
//     caminho `scenarios.from: 'library'`, em que os itens viram customStages
//     DEPOIS do parse (e escapariam do schema);
//   • o campo sobrevive a cada cópia campo a campo (arena-config → RunConfig,
//     biblioteca → StageSpec, `runs reproduce`, pacote) e chega ao juiz de
//     referência, que decide sem nenhuma chamada de LLM.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRunConfig } from '../src/runConfigSchema.js';
import { parseArenaConfig } from '../src/configFile.js';
import { parseArenaConfig as parseArenaConfigWeb } from '../web/src/engine/configFile.js';
import { arenaConfigToRunConfig } from '../src/arenaConfig.js';
import { runConfigToArenaConfig } from '../src/runArtifact.js';
import { buildScenarioPack, parseScenarioPack } from '../src/scenarioPack.js';
import { labelIssue, normalizeLibraryItem, toStageSpec } from '../src/engine/libraryCore.js';
import { saveItems, saveProfile } from '../src/library.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { CliError, EXIT } from '../src/cli/output.js';
import { readConfigFile } from '../src/cli/commands/run.js';
import { cmdConfig, cmdEstimate } from '../src/cli/commands/misc.js';
import { judgeStageReference } from '../src/refJudge.js';
import { variationConfigFrom } from '../src/trainer.js';
import { normalizeRunRecord } from '../src/normalize.js';
import { createGateway, setDefaultGateway } from '../src/openrouter.js';
import type { CompetitorResponse, Contestant, StageSpec, TrainingConfig, VariationConfig } from '../src/types.js';
import { fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const SENT = ['positivo', 'negativo', 'neutro'];

const variationBase = {
  mode: 'variation',
  theme: 'Classificação de sentimento de tickets',
  stages: 1,
  datagenModelId: 'gerador/x',
  judgeModelIds: ['juiz/x'],
  // IMPL-048: obrigatório em variation/training (papéis separados).
  referenceModelId: 'referencia/x',
  contestantModelId: 'modelo/x',
  basePrompt: 'Classifique o sentimento do ticket.',
  techniqueIds: ['persona', 'constraints'],
};

const etapa = (over: Partial<StageSpec> = {}): Record<string, unknown> => ({
  question: 'Ticket: "o pedido atrasou de novo, quero cancelar"',
  productContext: 'Rótulos: positivo, negativo, neutro.',
  maxTokens: 50,
  ...over,
});

const arenaBase = {
  format: 'arena-config@1',
  mode: 'variation',
  theme: 'Classificação de sentimento de tickets',
  prompt: { text: 'Classifique o sentimento do ticket.' },
  models: { datagen: 'gerador/x', judges: ['juiz/x'], contestant: 'modelo/x', reference: 'referencia/x' },
  variation: { techniques: ['persona', 'constraints'] },
};

describe('IMPL-003 — parseRunConfig reprova rótulo curto sem labelSet', () => {
  it('customStages: expected curto sem labelSet reprova, nomeando campo e etapa', () => {
    const r = parseRunConfig({ ...variationBase, customStages: [etapa({ expected: 'negativo' })] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('customStages');
      expect(r.error).toContain('etapa 1');
      expect(r.error).toContain('labelSet obrigatório');
    }
  });

  it('scenarioSeed e alternativas curtas também reprovam', () => {
    const seed = parseRunConfig({ ...variationBase, scenarioSeed: [etapa({ expected: 'negativo' })] });
    expect(seed.ok).toBe(false);
    if (!seed.ok) expect(seed.error).toContain('scenarioSeed');
    const alts = parseRunConfig({ ...variationBase, customStages: [etapa({ expected: ['edit', 'help'] })] });
    expect(alts.ok).toBe(false);
  });

  it('compare também reprova (a regra é por etapa, não por modo)', () => {
    const r = parseRunConfig({
      mode: 'compare',
      theme: 't',
      stages: 1,
      datagenModelId: 'gerador/x',
      judgeModelIds: ['juiz/x'],
      competitorModelIds: ['a/x', 'b/x'],
      customStages: [etapa({ expected: 'negativo' })],
    });
    expect(r.ok).toBe(false);
  });

  it('com labelSet que contém o esperado: aceita e PRESERVA o campo', () => {
    const r = parseRunConfig({ ...variationBase, customStages: [etapa({ expected: 'negativo', labelSet: SENT })] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.customStages?.[0]?.labelSet).toEqual(SENT);
  });

  it('esperado fora do labelSet e labelSet vazio reprovam', () => {
    expect(parseRunConfig({ ...variationBase, customStages: [etapa({ expected: 'raiva', labelSet: SENT })] }).ok).toBe(false);
    expect(parseRunConfig({ ...variationBase, customStages: [etapa({ expected: 'negativo', labelSet: [] })] }).ok).toBe(false);
  });

  // Revisão IMPL-003: labelSet = [expected] satisfazia a regra e DESLIGAVA a
  // detecção de lista — o motivo de o labelSet existir.
  it('labelSet com um só rótulo categórico reprova; rótulo numérico aceita [expected]', () => {
    const um = parseRunConfig({ ...variationBase, customStages: [etapa({ expected: 'negativo', labelSet: ['negativo'] })] });
    expect(um.ok).toBe(false);
    if (!um.ok) expect(um.error).toContain('pelo menos 2 rótulos distintos');
    // duplicata só de caixa/acento também é UM rótulo
    expect(
      parseRunConfig({ ...variationBase, customStages: [etapa({ expected: 'negativo', labelSet: ['Negativo', 'negativo'] })] }).ok,
    ).toBe(false);
    expect(parseRunConfig({ ...variationBase, customStages: [etapa({ expected: '42', labelSet: ['42'] })] }).ok).toBe(true);
  });

  it('rótulo longo (6+ palavras) e objeto campo→valor NÃO exigem labelSet', () => {
    const longo = parseRunConfig({
      ...variationBase,
      customStages: [etapa({ expected: 'encaminhar para o time de cobrança agora' })],
    });
    expect(longo.ok).toBe(true);
    const objeto = parseRunConfig({ ...variationBase, customStages: [etapa({ expected: { sentimento: 'negativo' } })] });
    expect(objeto.ok).toBe(true);
  });
});

describe('IMPL-003 — arena-config@1 (CLI e espelho do SPA)', () => {
  for (const [lado, parse] of [
    ['src', parseArenaConfig],
    ['web', parseArenaConfigWeb],
  ] as const) {
    it(`${lado}: cenário com rótulo curto sem labelSet é recusado nomeando o cenário`, () => {
      const r = parse({ ...arenaBase, scenarios: [{ question: 'q', productContext: 'ctx', expected: 'negativo' }] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/^cenário 1: labelSet obrigatório/);
    });

    it(`${lado}: com labelSet é aceito`, () => {
      const r = parse({ ...arenaBase, scenarios: [{ question: 'q', productContext: 'ctx', expected: 'negativo', labelSet: SENT }] });
      expect(r.ok).toBe(true);
      if (r.ok && Array.isArray(r.config.scenarios)) expect(r.config.scenarios[0].labelSet).toEqual(SENT);
    });
  }

  it('a tradução para RunConfig carrega o labelSet (whitelist campo a campo)', () => {
    const p = parseArenaConfig({ ...arenaBase, scenarios: [{ question: 'q', productContext: 'ctx', expected: 'negativo', labelSet: SENT }] });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const conv = arenaConfigToRunConfig(p.config);
    expect(conv.ok).toBe(true);
    if (conv.ok) expect(conv.config.scenarioSeed?.[0]?.labelSet).toEqual(SENT);
  });

  it('`runs reproduce`: a vista arena-config@1 do RunConfig mantém o labelSet e volta válida', () => {
    const cfg = parseRunConfig({ ...variationBase, customStages: [etapa({ expected: 'negativo', labelSet: SENT })] });
    expect(cfg.ok).toBe(true);
    if (!cfg.ok) return;
    const vista = runConfigToArenaConfig(cfg.config);
    const scen = Array.isArray(vista.scenarios) ? vista.scenarios : [];
    expect(scen[0]?.labelSet).toEqual(SENT);
    expect(parseArenaConfig(vista).ok).toBe(true);
  });
});

describe('IMPL-003 — labelSet sobrevive aos whitelists silenciosos', () => {
  const comRotulo: StageSpec = {
    question: 'q',
    productContext: 'ctx',
    maxTokens: 50,
    expected: 'negativo',
    labelSet: SENT,
  };

  it('variationConfigFrom (cada iteração do treino) mantém o labelSet das etapas', () => {
    const cfg: TrainingConfig = {
      mode: 'training',
      theme: 't',
      stages: 1,
      datagenModelId: 'g/x',
      judgeModelIds: ['j/x'],
      contestantModelId: 'c/x',
      iterations: 2,
      customStages: [comRotulo],
      scenarioSeed: [comRotulo],
    };
    const v = variationConfigFrom(cfg);
    expect(v.customStages?.[0]?.labelSet).toEqual(SENT);
    expect(v.scenarioSeed?.[0]?.labelSet).toEqual(SENT);
  });

  it('normalizeRunRecord (reler do disco/IndexedDB) mantém o labelSet no config e na etapa', () => {
    const rec = normalizeRunRecord({
      id: 'r',
      status: 'finished',
      config: { ...variationBase, customStages: [comRotulo] },
      stages: [{ index: 0, startedAt: 'now', spec: comRotulo, responses: [] }],
      startedAt: 'now',
    });
    expect((rec.config as VariationConfig).customStages?.[0]?.labelSet).toEqual(SENT);
    expect(rec.stages[0].spec?.labelSet).toEqual(SENT);
  });
});

describe('IMPL-003 — pacote de cenários e biblioteca', () => {
  it('pacote com rótulo curto sem labelSet é recusado; com labelSet, round-trip preserva', () => {
    const sem = buildScenarioPack({
      theme: 't',
      prompt: { text: 'p', source: 'base' },
      scenarios: [etapa({ expected: 'negativo' }) as unknown as StageSpec],
    });
    const r = parseScenarioPack(JSON.parse(JSON.stringify(sem)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cenário 1: labelSet obrigatório/);

    const com = buildScenarioPack({
      theme: 't',
      prompt: { text: 'p', source: 'base' },
      scenarios: [etapa({ expected: 'negativo', labelSet: SENT }) as unknown as StageSpec],
    });
    const ok = parseScenarioPack(JSON.parse(JSON.stringify(com)));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.pack.scenarios[0].labelSet).toEqual(SENT);
  });

  const itemBase = {
    id: 'sent-001',
    title: 'ticket de atraso',
    tier: 'mft',
    question: 'Ticket: "atrasou de novo"',
    productContext: 'Rótulos: positivo, negativo, neutro.',
    maxTokens: 50,
    origin: 'manual',
    createdAt: '2026-09-27T00:00:00.000Z',
  };

  it('item da biblioteca com rótulo curto sem labelSet é recusado na entrada', () => {
    const r = normalizeLibraryItem({ ...itemBase, expected: 'negativo' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^labelSet: labelSet obrigatório/);
  });

  it('com labelSet entra, e o StageSpec gerado carrega o conjunto', () => {
    const r = normalizeLibraryItem({ ...itemBase, expected: 'negativo', labelSet: SENT });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(labelIssue(r.item)).toBeNull();
      expect(toStageSpec(r.item).labelSet).toEqual(SENT);
    }
  });
});

describe('IMPL-003 — CLI: config sem labelSet sai com exit 3', () => {
  let dir = '';
  let dataDirAnterior = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pb-impl003-'));
    dataDirAnterior = getDataDir();
    setDataDir(join(dir, 'data'));
  });
  afterAll(() => {
    setDataDir(dataDirAnterior);
    rmSync(dir, { recursive: true, force: true });
  });

  const escrever = (nome: string, json: unknown): string => {
    const file = join(dir, nome);
    writeFileSync(file, JSON.stringify(json), 'utf-8');
    return file;
  };

  const exitDe = async (file: string): Promise<number | 'ok'> => {
    try {
      await readConfigFile(file);
      return 'ok';
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      return (err as CliError).code;
    }
  };

  it('EXIT.CONFIG é o código 3', () => {
    expect(EXIT.CONFIG).toBe(3);
  });

  it('RunConfig cru sem labelSet → exit 3; com labelSet → ok', async () => {
    const sem = escrever('cru-sem.json', { ...variationBase, customStages: [etapa({ expected: 'negativo' })] });
    expect(await exitDe(sem)).toBe(3);
    const com = escrever('cru-com.json', {
      ...variationBase,
      customStages: [etapa({ expected: 'negativo', labelSet: SENT })],
    });
    expect(await exitDe(com)).toBe('ok');
  });

  it('arena-config@1 sem labelSet → exit 3; com labelSet → RunConfig com o campo', async () => {
    const sem = escrever('arena-sem.json', { ...arenaBase, scenarios: [{ question: 'q', productContext: 'ctx', expected: 'negativo' }] });
    expect(await exitDe(sem)).toBe(3);
    const com = escrever('arena-com.json', {
      ...arenaBase,
      scenarios: [{ question: 'q', productContext: 'ctx', expected: 'negativo', labelSet: SENT }],
    });
    const cfg = (await readConfigFile(com)) as VariationConfig;
    expect(cfg.scenarioSeed?.[0]?.labelSet).toEqual(SENT);
  });

  it('biblioteca: item ANTIGO (gravado sem labelSet) → exit 3 no evolve', async () => {
    await saveProfile({ id: 'sent', name: 'sentimento' });
    // grava direto (sem normalizeLibraryItem): simula item de antes da regra
    await saveItems('sent', [
      {
        id: 'velho-001',
        title: 'antigo',
        tier: 'mft',
        question: 'q',
        productContext: 'ctx',
        maxTokens: 50,
        expected: 'negativo',
        origin: 'manual',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const file = escrever('arena-lib.json', { ...arenaBase, scenarios: { from: 'library', profile: 'sent' } });
    let erro: CliError | undefined;
    try {
      await readConfigFile(file);
    } catch (err) {
      erro = err as CliError;
    }
    expect(erro?.code).toBe(3);
    expect(erro?.message).toContain('velho-001');
    expect(erro?.message).toContain('labelSet');
  });

  // Revisão IMPL-003 (defeito 7): `config validate` e `estimate` dizem o mesmo
  // que o `vary --config` sobre a biblioteca — antes diziam "válido".
  it('biblioteca: `config validate` e `estimate` também recusam o item antigo com exit 3', async () => {
    const file = escrever('arena-lib2.json', { ...arenaBase, scenarios: { from: 'library', profile: 'sent' } });
    const codigo = async (fn: () => Promise<number>): Promise<number | 'ok'> => {
      try {
        await fn();
        return 'ok';
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).message).toContain('velho-001');
        return (err as CliError).code;
      }
    };
    const dataDir = join(dir, 'data');
    expect(await codigo(() => cmdConfig(['validate', file, '--json', '--data-dir', dataDir]))).toBe(3);
    // estimate confere o config ANTES da rede: nenhum fetch do catálogo acontece.
    expect(await codigo(() => cmdEstimate(['--config', file, '--json', '--data-dir', dataDir]))).toBe(3);
  });
});

describe('IMPL-003 — o labelSet chega ao juiz de referência (0 chamadas de LLM)', () => {
  const resp = (id: string, text: string): CompetitorResponse => ({
    contestantId: id,
    modelId: 'fake/a',
    text,
    latencyMs: 1,
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
    status: 'ok',
  });
  const cont = (id: string): Contestant => ({ id, label: id, modelId: 'fake/a' });

  it('lista de rótulos dá nao, rótulo na primeira linha resolve, prosa dá parcial', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: '{"verdict":"resolve","explanation":"x"}' }) });
    const anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    try {
      const r = await judgeStageReference({
        stage: {
          question: 'Ticket: "o pedido atrasou de novo"',
          productContext: 'Rótulos: positivo, negativo, neutro.',
          maxTokens: 50,
          expected: 'negativo',
          labelSet: SENT,
        },
        responses: [
          resp('lista', 'positivo | negativo | neutro'),
          resp('firme', 'Negativo. O cliente reclama do atraso.'),
          resp('prosa', 'O sentimento do cliente é negativo.'),
          resp('negado', 'Não é negativo.'),
        ],
        contestants: [cont('lista'), cont('firme'), cont('prosa'), cont('negado')],
        judgeModelIds: ['juiz/x'],
        apiKey: 'sk-or-v1-fake',
      });
      expect(r.judgeModelId).toBe('ground-truth');
      expect(r.verdictByContestant).toEqual({ lista: 'nao', firme: 'resolve', prosa: 'parcial', negado: 'nao' });
      expect(r.verdictSourceByContestant?.lista).toBe('ground-truth');
      expect(fake.chatRequests()).toHaveLength(0);
    } finally {
      setDefaultGateway(anterior);
    }
  });
});
