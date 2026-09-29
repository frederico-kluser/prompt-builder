// IMPL-008 (R-05:REC-6) — bug E5: o gerador de cenários tem de RECEBER o
// grounding do perfil, não só calculá-lo.
//
// O E5 era um system "calculado e descartado": `runBatch` renderizava as regras
// do perfil ({{context}}/{{fewShot}}/{{setupKeys}}) numa variável e mandava
// `batchSystemPrompt(scenarioBrief)` na chamada — no CLI (`library seed
// --generate`) os cenários saíam genéricos, sem os exemplos reais; no navegador
// o espelho já enviava certo. Por isso o contrato aqui é sobre o que é ENVIADO:
// `chatCompletion` é espionado (vi.fn em volta do real) e o gateway padrão é um
// OpenRouter FALSO — zero rede, zero gasto. O teste reprova o código antigo
// (`git show d70c7ba:src/datagen.ts`) e aprova o atual.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/openrouter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/openrouter.js')>();
  return { ...real, chatCompletion: vi.fn(real.chatCompletion) };
});

import { chatCompletion, createGateway, setDefaultGateway, type ChatMessage } from '../src/openrouter.js';
// Namespace (e não import nomeado): o arquivo carrega também contra o código
// antigo, que não exportava `buildBatchMessages` — a prova de regressão roda.
import * as datagenSrc from '../src/datagen.js';
import * as datagenWeb from '../web/src/engine/datagen.js';
import {
  lintScenarioRules,
  parseScenarioRules,
  renderScenarioRules,
  templatePlaceholders,
} from '../src/engine/scenarioRules.js';
import type { ScenarioRules } from '../src/engine/libraryCore.js';
import { cmdLibrary } from '../src/cli/commands/library.js';
import { EXIT, resetOutputState } from '../src/cli/output.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { listItems } from '../src/library.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const spy = vi.mocked(chatCompletion);

/** Perfil com grounding REAL nos três campos — o que o E5 jogava fora. */
const RULES: ScenarioRules = {
  templates: {
    system:
      'Você gera cenários para a central de trocas da loja ACME.\n' +
      'CATÁLOGO REAL:\n{{context}}\n' +
      'EXEMPLOS REAIS (few-shot):\n{{ fewShot }}\n' +
      'CHAVES DE SETUP: {{setupKeys}}',
    user: 'Tema {{theme}} — gere {{count}} cenários ancorados no catálogo acima.',
  },
  grounding: {
    context: 'SKU-7781 Fone Aurora — troca em até 30 dias com nota fiscal.',
    fewShot: 'P: O Aurora tem garantia? R: 12 meses direto com a ACME.',
    setupKeys: ['loja-acme', 'politica-trocas'],
  },
};
const GROUNDING = [
  'SKU-7781 Fone Aurora — troca em até 30 dias com nota fiscal.',
  'P: O Aurora tem garantia? R: 12 meses direto com a ACME.',
  'CHAVES DE SETUP: loja-acme, politica-trocas',
];
const PLACEHOLDER_CRU = /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/;

function cenario(i: number): Record<string, unknown> {
  return {
    question: `Pergunta distinta número ${i} sobre ${['troca', 'garantia', 'frete', 'nota', 'prazo', 'defeito'][i % 6]} do produto ${i * 37}?`,
    productContext: `Política ${i}: trocas em até 30 dias.`,
    maxTokens: 300,
    rubric: `Deve citar o prazo da política ${i}.`,
  };
}

/** Responde JSON de cenários ao datagen e texto de gabarito ao resto. */
function fakeGerador(porChamada: (n: number) => Record<string, unknown>[]): FakeOpenRouter {
  let nDatagen = 0;
  return fakeOpenRouter({
    catalog: [catalogItem('fake/gen', 0.000001, 0.000002)],
    chat: (req) =>
      req.system.includes('gerador de cenarios de benchmark')
        ? { text: JSON.stringify({ stages: porChamada(nDatagen++) }) }
        : { text: 'Resposta de referência ideal.' },
  });
}

/** Mensagens que o datagen PASSOU ao chatCompletion, chamada a chamada. */
function mensagensDatagen(): ChatMessage[][] {
  return spy.mock.calls
    .map(([params]) => params)
    .filter((p) => p.role === 'datagen')
    .map((p) => p.messages);
}
const systemDe = (msgs: ChatMessage[]): string => msgs.find((m) => m.role === 'system')?.content ?? '';
const userDe = (msgs: ChatMessage[]): string => msgs.find((m) => m.role === 'user')?.content ?? '';

let anterior: ReturnType<typeof setDefaultGateway> | undefined;
let fake: FakeOpenRouter;

function instalar(f: FakeOpenRouter): void {
  fake = f;
  anterior = setDefaultGateway(createGateway({ fetch: f.fetch, sleep: noSleep }));
}

beforeEach(() => {
  spy.mockClear();
});
afterEach(() => {
  if (anterior) setDefaultGateway(anterior);
  anterior = undefined;
});

describe('IMPL-008 — o grounding do perfil chega ao gerador (bug E5)', () => {
  it('o system ENVIADO contém o template renderizado: {{context}}/{{fewShot}} preenchidos, sem placeholder cru', async () => {
    instalar(fakeGerador(() => [cenario(1)]));
    const out = await datagenSrc.generateStages({
      apiKey: KEY,
      theme: 'trocas',
      count: 1,
      modelId: 'fake/gen',
      rules: RULES,
    });
    expect(out).toHaveLength(1);

    const chamadas = mensagensDatagen();
    expect(chamadas).toHaveLength(1);
    const system = systemDe(chamadas[0]);
    for (const trecho of GROUNDING) expect(system).toContain(trecho);
    expect(system).not.toMatch(PLACEHOLDER_CRU);
    // Grounding ABRE o system; o contrato JSON (em código) o fecha.
    expect(system.startsWith('Você gera cenários para a central de trocas da loja ACME.')).toBe(true);
    expect(system).toContain('Saida ESTRITAMENTE em JSON valido');
    expect(system.indexOf('SKU-7781')).toBeLessThan(system.indexOf('Saida ESTRITAMENTE'));
    // O user renderizado também vai (tema/contagem interpolados).
    expect(userDe(chamadas[0])).toContain('Tema trocas — gere 1 cenários ancorados no catálogo acima.');
    expect(userDe(chamadas[0])).not.toMatch(PLACEHOLDER_CRU);
    // E é isso mesmo que sai no fio (nada o reescreve depois do chatCompletion).
    expect(fake.chatRequests()[0].system).toBe(system);
  });

  it('100% das chamadas do datagen levam o grounding — lotes paralelos E o backfill', async () => {
    // Todo lote devolve os MESMOS 4 cenários: o dedup deixa faltar e força o backfill.
    instalar(fakeGerador(() => [cenario(1), cenario(2), cenario(3), cenario(4)]));
    await datagenSrc.generateStages({
      apiKey: KEY,
      theme: 'trocas',
      count: 8,
      modelId: 'fake/gen',
      rules: RULES,
    });
    const chamadas = mensagensDatagen();
    // 2 lotes + o laço de reposição (web-live#7): o gerador só repete, então
    // as DATAGEN_MAX_BACKFILL_ROUNDS rodadas rodam — todas com o grounding.
    expect(chamadas).toHaveLength(2 + datagenSrc.DATAGEN_MAX_BACKFILL_ROUNDS);
    expect(chamadas.filter((m) => userDe(m).includes('LACUNAS DE VARIEDADE'))).toHaveLength(
      datagenSrc.DATAGEN_MAX_BACKFILL_ROUNDS,
    );
    for (const msgs of chamadas) {
      for (const trecho of GROUNDING) expect(systemDe(msgs)).toContain(trecho);
      expect(systemDe(msgs)).not.toMatch(PLACEHOLDER_CRU);
    }
  });

  it('o enviado é EXATAMENTE buildBatchMessages(...) — não há system alternativo montado por fora', async () => {
    instalar(fakeGerador(() => [cenario(5)]));
    await datagenSrc.generateStages({
      apiKey: KEY,
      theme: 'trocas',
      count: 1,
      modelId: 'fake/gen',
      excludePrompts: ['Já existe: qual o prazo de troca?'],
      rules: RULES,
      coverageInstructionText: 'COBERTURA ALVO — priorize: tier "edge"',
    });
    const [enviado] = mensagensDatagen();
    expect(enviado).toEqual(
      datagenSrc.buildBatchMessages({
        theme: 'trocas',
        count: 1,
        batchIndex: 0,
        batchCount: 1,
        excludePrompts: ['Já existe: qual o prazo de troca?'],
        rules: RULES,
        coverageInstructionText: 'COBERTURA ALVO — priorize: tier "edge"',
      }),
    );
    const rendered = renderScenarioRules(RULES, {
      theme: 'trocas',
      count: 1,
      excludePrompts: ['Já existe: qual o prazo de troca?'],
      coverageInstruction: 'COBERTURA ALVO — priorize: tier "edge"',
    });
    expect(systemDe(enviado).startsWith(rendered.system)).toBe(true);
    expect(userDe(enviado).startsWith(rendered.user)).toBe(true);
  });

  it('paridade Node × SPA: o shim do web monta e ENVIA mensagens idênticas às do src/', async () => {
    expect(datagenWeb.buildBatchMessages).toBe(datagenSrc.buildBatchMessages);
    expect(datagenWeb.generateStages).toBe(datagenSrc.generateStages);

    const params = {
      apiKey: KEY,
      theme: 'trocas',
      scenarioBrief: 'Foque em clientes irritados.',
      count: 2,
      modelId: 'fake/gen',
      excludePrompts: ['Já existe?'],
      rules: RULES,
      coverageInstructionText: 'COBERTURA ALVO — priorize: tier "adversarial"',
    };
    instalar(fakeGerador(() => [cenario(1), cenario(2)]));
    await datagenSrc.generateStages(params);
    const doNode = mensagensDatagen();
    setDefaultGateway(anterior!);
    spy.mockClear();

    instalar(fakeGerador(() => [cenario(1), cenario(2)]));
    await datagenWeb.generateStages(params);
    const daSpa = mensagensDatagen();

    expect(daSpa).toEqual(doNode);
    for (const trecho of GROUNDING) expect(systemDe(daSpa[0])).toContain(trecho);
  });
});

describe('IMPL-008 — montagem das mensagens sem perda silenciosa (mesma classe do E5)', () => {
  const build = (p: Partial<Parameters<typeof datagenSrc.buildBatchMessages>[0]>): ChatMessage[] =>
    datagenSrc.buildBatchMessages({ theme: 'trocas', count: 2, excludePrompts: [], ...p });

  it('sem regras: briefing no system; cobertura e exclusões no user (antes a cobertura sumia)', () => {
    const msgs = build({
      scenarioBrief: 'Foque em clientes irritados.',
      coverageInstructionText: 'COBERTURA ALVO — priorize: tier "edge"',
      excludePrompts: ['Qual o prazo?'],
    });
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    expect(systemDe(msgs)).toContain('BRIEFING DETALHADO DO USUÁRIO');
    expect(systemDe(msgs)).toContain('Foque em clientes irritados.');
    expect(userDe(msgs)).toContain('COBERTURA ALVO — priorize: tier "edge"');
    expect(userDe(msgs)).toContain('EVITE perguntas equivalentes a estas já existentes:\n- Qual o prazo?');
  });

  it('com regras + briefing: grounding primeiro, contrato JSON e briefing depois (antes o briefing sumia)', () => {
    const system = systemDe(build({ rules: RULES, scenarioBrief: 'Foque em clientes irritados.' }));
    const iGround = system.indexOf('SKU-7781');
    const iContrato = system.indexOf('Saida ESTRITAMENTE em JSON');
    const iBrief = system.indexOf('Foque em clientes irritados.');
    expect(iGround).toBeGreaterThanOrEqual(0);
    expect(iGround).toBeLessThan(iContrato);
    expect(iContrato).toBeLessThan(iBrief);
  });

  it('sem briefing nem cobertura o texto do caminho genérico não muda (compatibilidade)', () => {
    const msgs = build({});
    expect(systemDe(msgs).startsWith('Voce e um gerador de cenarios de benchmark para LLMs.')).toBe(true);
    expect(systemDe(msgs)).not.toContain('BRIEFING');
    expect(userDe(msgs)).toBe('TEMA: trocas\nQUANTIDADE: 2 cenarios\n\n\nGere os 2 cenarios em JSON conforme as regras.');
    // Lote de vários: a linha de fatia entra no mesmo lugar de antes.
    expect(userDe(build({ batchIndex: 1, batchCount: 3 }))).toContain('\nEste é o lote 2 de 3.');
  });
});

describe('IMPL-008 — regras do perfil: grounding que não chegaria ao gerador vira aviso', () => {
  it('perfil bem formado: nenhum aviso', () => {
    expect(lintScenarioRules(RULES)).toEqual([]);
    expect(templatePlaceholders(RULES.templates.system)).toEqual(['context', 'fewShot', 'setupKeys']);
  });

  it('grounding declarado sem placeholder, placeholder desconhecido e placeholder com grounding vazio', () => {
    const avisos = lintScenarioRules({
      templates: { system: 'Catálogo: {{blockCatalog}}\n{{context}}', user: 'Chaves {{setupKeys}}' },
      grounding: { fewShot: 'P: x? R: y.', context: '   ' },
    });
    expect(avisos.some((a) => a.includes('{{blockCatalog}}') && a.includes('vazio'))).toBe(true);
    expect(avisos.some((a) => a.includes('grounding.fewShot') && a.includes('nunca chega ao gerador'))).toBe(true);
    expect(avisos.some((a) => a.includes('{{context}}') && a.includes('grounding.context está vazio'))).toBe(true);
    expect(avisos.some((a) => a.includes('{{setupKeys}}') && a.includes('grounding.setupKeys está vazio'))).toBe(true);
    expect(avisos).toHaveLength(4);
  });

  it('parseScenarioRules recusa o que quebraria o render dentro de cada lote', () => {
    expect(parseScenarioRules({ templates: {} })).toMatchObject({ ok: false });
    expect(parseScenarioRules({ templates: { system: '  ' } })).toMatchObject({ ok: false });
    expect(parseScenarioRules({ templates: { system: 'x', user: 3 } })).toMatchObject({ ok: false });
    expect(parseScenarioRules({ templates: { system: 'x' }, grounding: { setupKeys: 'a' } })).toMatchObject({
      ok: false,
    });
    expect(parseScenarioRules({ templates: { system: 'x' }, grounding: { fewShot: 1 } })).toMatchObject({ ok: false });
    expect(parseScenarioRules(null)).toMatchObject({ ok: false });
    const ok = parseScenarioRules(RULES);
    expect(ok).toEqual({ ok: true, rules: RULES, warnings: [] });
  });
});

describe('IMPL-008 — CLI `library seed --generate` (métrica da R-05: grounding em 100% das chamadas)', () => {
  let dir: string;
  let dataDirAnterior: string;
  let stdout: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pb-impl008-'));
    dataDirAnterior = getDataDir();
    stdout = [];
    // Um resultado por processo (IMPL-028): cada comando do teste é uma "invocação" nova.
    resetOutputState();
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setDataDir(dataDirAnterior);
    rmSync(dir, { recursive: true, force: true });
  });

  /** Último objeto `--json` escrito no stdout (um `write` por resultado). */
  const payload = (): { ok: boolean; data: Record<string, unknown> } =>
    JSON.parse(stdout.filter((c) => c.trimStart().startsWith('{')).pop()!);

  it('init --rules + seed --generate: toda chamada do gerador leva o grounding do perfil', async () => {
    const rulesFile = join(dir, 'regras.json');
    writeFileSync(rulesFile, JSON.stringify(RULES));
    const init = await cmdLibrary(['init', '--profile', 'acme', '--rules', rulesFile, '--data-dir', dir, '--json']);
    expect(init).toBe(EXIT.OK);
    expect(payload().data.warnings).toEqual([]);

    instalar(fakeGerador((n) => [cenario(10 * n + 1), cenario(10 * n + 2), cenario(10 * n + 3)]));
    stdout = [];
    // Um resultado por processo (IMPL-028): cada comando do teste é uma "invocação" nova.
    resetOutputState();
    const code = await cmdLibrary([
      'seed', '--profile', 'acme', '--generate', '3', '--theme', 'trocas', '--model', 'fake/gen',
      '--budget', 'none', '--key', KEY, '--data-dir', dir, '--json',
    ]);
    expect(code).toBe(EXIT.OK);

    const chamadas = mensagensDatagen();
    expect(chamadas.length).toBeGreaterThanOrEqual(1);
    const comGrounding = chamadas.filter((m) => GROUNDING.every((t) => systemDe(m).includes(t)));
    expect(comGrounding.length / chamadas.length).toBe(1);
    for (const m of chamadas) expect(systemDe(m)).not.toMatch(PLACEHOLDER_CRU);
    // E o que o fio levou é o mesmo system (o gateway não o perdeu).
    const doFio = fake.chatRequests().filter((r) => r.system.includes('gerador de cenarios de benchmark'));
    expect(doFio.map((r) => r.system)).toEqual(chamadas.map(systemDe));

    const res = payload();
    expect(res.ok).toBe(true);
    expect(res.data.added).toHaveLength(3);
    expect(await listItems('acme')).toHaveLength(3);
  });

  it('init recusa regras que quebrariam o render (exit 3) e avisa grounding que não chegaria ao gerador', async () => {
    const quebrada = join(dir, 'quebrada.json');
    writeFileSync(quebrada, JSON.stringify({ templates: { user: 'só user' } }));
    await expect(
      cmdLibrary(['init', '--profile', 'x', '--rules', quebrada, '--data-dir', dir, '--json']),
    ).rejects.toMatchObject({ code: EXIT.CONFIG });

    const semUso = join(dir, 'sem-uso.json');
    writeFileSync(
      semUso,
      JSON.stringify({ templates: { system: 'Gere cenários da ACME.' }, grounding: { fewShot: 'P: a? R: b.' } }),
    );
    stdout = [];
    // Um resultado por processo (IMPL-028): cada comando do teste é uma "invocação" nova.
    resetOutputState();
    expect(await cmdLibrary(['init', '--profile', 'y', '--rules', semUso, '--data-dir', dir, '--json'])).toBe(EXIT.OK);
    const avisos = payload().data.warnings as string[];
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain('grounding.fewShot');
  });

  it('seed recusa ANTES de gastar quando as regras salvas no perfil estão quebradas', async () => {
    const perfilDir = join(dir, 'library', 'z');
    // Perfil gravado à mão/por versão antiga, sem templates.system.
    await cmdLibrary(['init', '--profile', 'z', '--data-dir', dir, '--json']);
    const arq = join(perfilDir, 'profile.json');
    const perfil = JSON.parse(readFileSync(arq, 'utf8')) as Record<string, unknown>;
    writeFileSync(arq, JSON.stringify({ ...perfil, scenarioRules: { templates: {} } }));

    instalar(fakeGerador(() => [cenario(1)]));
    await expect(
      cmdLibrary([
        'seed', '--profile', 'z', '--generate', '1', '--theme', 't', '--model', 'fake/gen',
        '--budget', 'none', '--key', KEY, '--data-dir', dir, '--json',
      ]),
    ).rejects.toMatchObject({ code: EXIT.CONFIG });
    expect(fake.chatRequests()).toHaveLength(0);
    expect(fake.billedUsd()).toBe(0);
  });
});
