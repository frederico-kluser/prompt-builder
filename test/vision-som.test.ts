// `vision som` — benchmark de ELEMENTOS para modelos de decisão (SOMs).
//
// O que estes testes travam: (a) o candidato negativo NUNCA é um rótulo que
// existe na cena (conferido no HTML), senão o "ouro" estaria errado; (b) cada
// bloco tem exatamente `slots` perguntas e o `expected` casa com o candidato;
// (c) a partição é por CENA (a mesma tela não cai nos dois lados); (d) as
// métricas de conjunto (precisão/recall/F1) não confundem acurácia por pergunta.

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SOM_BENCHMARK_FORMAT,
  SOM_DISCOVERY_TYPES,
  SOM_REGIONS,
  SOM_SCENE_SPLITS,
  buildDiscoveryBenchmark,
  buildSomBenchmark,
  discoveryMetrics,
  elementSetMetrics,
  normalizeLabel,
  visibleLabelOf,
  type SomBenchmark,
} from '../src/engine/vision/index.js';
import type { VisionDataset } from '../src/engine/vision/index.js';

const scene = (id: string, labels: Array<[string, string]>, extra: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id,
  family: 'bootstrap',
  title: id,
  theme: 'light',
  viewport: { width: 1920, height: 1080 },
  image: { file: `images/${id}.png`, sha256: 'a'.repeat(64), bytes: 10 },
  code: { file: `scenes/bootstrap/${id}.html` },
  elements: labels.map(([label, type], i) => ({
    id: `${id}-el${i}`,
    type,
    label,
    iconDescription: null,
    bbox: { x: 10 + i * 20, y: 10, w: 40, h: 20 },
    center: { x: 30 + i * 20, y: 20 },
  })),
  tasks: [],
  ...extra,
});

function dataset(scenes: Array<Record<string, unknown>>): VisionDataset {
  return {
    format: 'vision-dataset@1',
    version: '0.0.1',
    generator: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    viewport: { width: 1920, height: 1080 },
    scenes,
    assets: [],
  } as unknown as VisionDataset;
}

const IMG = 'data:image/png;base64,iVBORw0KGgo=';

function build(scenes: Array<Record<string, unknown>>, opts: Partial<Parameters<typeof buildSomBenchmark>[1]> = {}): SomBenchmark {
  return buildSomBenchmark(dataset(scenes), { imageFor: () => IMG, ...opts });
}

describe('rótulos', () => {
  it('normaliza acento/caixa e prefere label à descrição de ícone', () => {
    expect(normalizeLabel('  Filtrar   por NOME ')).toBe('filtrar por nome');
    expect(normalizeLabel('Relatório')).toBe('relatorio');
    expect(visibleLabelOf({ label: 'Salvar', iconDescription: 'disquete' })).toBe('Salvar');
    expect(visibleLabelOf({ label: null, iconDescription: 'sino de notificações' })).toBe('sino de notificações');
    expect(visibleLabelOf({ label: '  ', iconDescription: null })).toBeNull();
  });
});

describe('construção dos casos', () => {
  const base = [
    scene('bootstrap-painel-cursos', [['Novo curso', 'button'], ['Filtrar por nome', 'input'], ['Status', 'select']]),
    scene('bootstrap-login', [['Entrar', 'button'], ['Senha', 'input']]),
    scene('react95-painel', [['Pedidos', 'link'], ['Imprimir', 'button']]),
    scene('fluent-painel', [['Exportar', 'button'], ['Filtro', 'select']]),
  ];

  it('empacota em blocos de `slots` perguntas e o ouro casa com o candidato', () => {
    const b = build(base, { slots: 4 });
    expect(b.format).toBe(SOM_BENCHMARK_FORMAT);
    for (const c of b.cases) {
      expect(Object.keys(c.expected)).toHaveLength(4);
      expect(c.state[2]).toMatchObject({ type: 'image_url' });
    }
    const total = b.cases.reduce((n, c) => n + Object.keys(c.expected).length, 0);
    expect(total).toBe(b.counts.positives + b.counts.negatives);
    // todo positivo do DOM aparece exatamente uma vez
    expect(b.counts.positives).toBe(9);
    for (const pos of b.candidates.filter((c) => c.kind === 'positive')) {
      expect(['Novo curso', 'Filtrar por nome', 'Status', 'Entrar', 'Senha', 'Pedidos', 'Imprimir', 'Exportar', 'Filtro']).toContain(
        pos.description,
      );
    }
  });

  it('negativo é rótulo de OUTRA cena e nunca aparece no HTML da cena-alvo', () => {
    const sceneText = { 'bootstrap-painel-cursos': '<button>novo curso</button><label>entrar</label>' };
    const b = build(base, { slots: 4, sceneText });
    for (const c of b.cases) {
      const block = b.caseSlots.find((x) => x.caseId === c.id)!.slots;
      const negativos = block.filter((x) => x.kind === 'negative');
      if (c.id.startsWith('bootstrap-painel-cursos')) {
        // "Entrar" está no HTML desta cena → não pode virar negativo dela
        expect(negativos.map((n) => normalizeLabel(n.description))).not.toContain('entrar');
      }
      for (const neg of negativos) expect(neg.ref).not.toBe(c.tags[0].slice('scene:'.length));
    }
  });

  it('o state NÃO leva ouro, tipo nem id de elemento (só o rótulo literal)', () => {
    const b = build(base, { slots: 4 });
    const alvo = b.cases[0];
    const alvoStr = JSON.stringify(alvo.state[1]);
    expect(alvoStr).not.toContain('positive');
    expect(alvoStr).not.toContain('negative');
    for (const tag of ['button', 'input', 'select']) expect(alvoStr).not.toContain(tag);
  });

  it('partição por CENA e determinismo (mesma entrada, mesmos ids/ouro)', () => {
    const a = build(base, { slots: 4 });
    const c = build(base, { slots: 4 });
    expect(a.cases.map((x) => x.id)).toEqual(c.cases.map((x) => x.id));
    expect(a.cases.map((x) => x.expected)).toEqual(c.cases.map((x) => x.expected));
    for (const item of a.cases) {
      const sceneId = item.tags[0].slice('scene:'.length);
      expect(item.split).toBe(SOM_SCENE_SPLITS[sceneId]);
      expect(new Set(a.cases.filter((x) => x.tags[0] === item.tags[0]).map((x) => x.split)).size).toBe(1);
    }
  });

  it('sem pool suficiente para preencher o bloco, falha em vez de inventar', () => {
    const pequeno = [scene('bootstrap-painel-cursos', [['A', 'button'], ['B', 'button'], ['C', 'button']]), scene('bootstrap-login', [['D', 'button']])];
    expect(() => build(pequeno, { slots: 12 })).toThrow(/pool insuficiente|negativos </);
  });
});

describe('métricas de conjunto', () => {
  it('precisão/recall/F1 do conjunto aceito (não é acurácia por pergunta)', () => {
    const expected = { s1: true, s2: true, s3: false, s4: false };
    // aceitou 1 e 2 (certos), recusou 4 (certo) e recusou 3 (falso negativo)
    expect(elementSetMetrics({ s1: true, s2: true, s3: false, s4: false }, expected)).toMatchObject({
      tp: 2, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1,
    });
    // aceitou TUDO: recall 1, precisão 0.5
    const todos = elementSetMetrics({ s1: true, s2: true, s3: true, s4: true }, expected);
    expect(todos.tp).toBe(2);
    expect(todos.fp).toBe(2);
    expect(todos.precision).toBeCloseTo(0.5);
    expect(todos.recall).toBe(1);
    // recusou tudo: precisão indefinida (0 aceites), recall 0
    const nada = elementSetMetrics({ s1: false, s2: false, s3: false, s4: false }, expected);
    expect(nada.precision).toBeNull();
    expect(nada.recall).toBe(0);
    expect(nada.f1).toBeNull();
    // dois falsos negativos com um acerto
    const parcial = elementSetMetrics({ s1: true, s2: false, s3: false, s4: true }, expected);
    expect(parcial).toMatchObject({ tp: 1, fp: 1, fn: 1 });
    expect(parcial.f1).toBeCloseTo(0.5);
  });
});

describe('descoberta: o modelo reporta o que existe, sem candidatos', () => {
  const cena = (id: string, els: Array<[string, string, number, number]>) => ({
    id,
    family: 'bootstrap',
    title: id,
    theme: 'light',
    viewport: { width: 1920, height: 1080 },
    image: { file: `images/${id}.png`, sha256: 'a'.repeat(64), bytes: 10 },
    code: { file: `scenes/bootstrap/${id}.html` },
    elements: els.map(([label, type, x, y], i) => ({
      id: `${id}-el${i}`,
      type,
      label,
      iconDescription: null,
      bbox: { x, y, w: 80, h: 30 },
      center: { x: x + 40, y: y + 15 },
    })),
    tasks: [],
  });
  const base = [
    // topo-esquerda (100,100), topo-direita (1500,200), baixo-centro (900,900)
    cena('bootstrap-painel-cursos', [['Novo curso', 'button', 100, 100], ['Buscar', 'input', 1500, 200], ['Ver mais', 'link', 900, 900]]),
    cena('fluent-painel', [['Salvar', 'button', 120, 120], ['Modo', 'switch', 1400, 150], ['Aba', 'tab', 1000, 950]]),
  ];
  const build = () => buildDiscoveryBenchmark(dataset(base), { imageFor: () => IMG });

  it('pergunta 10 tipos + 6 regiões (16, teto de adaptadores como Drex Max)', () => {
    const b = build();
    expect(b.questions).toHaveLength(16);
    expect(b.questions.map((q) => q.id)).toEqual([
      ...SOM_DISCOVERY_TYPES.map((t) => `type_${t.id}`),
      ...SOM_REGIONS.map((r) => `region_${r.id}`),
    ]);
    expect(b.cases).toHaveLength(2);
    expect(b.counts).toMatchObject({ cases: 2, train: 1, holdout: 1, questions: 16 });
    for (const q of b.questions) expect(q.type).toBe('noul');
  });

  it('o state leva SÓ a imagem: nenhum rótulo, id, contagem ou candidato', () => {
    const b = build();
    for (const c of b.cases) {
      expect(c.state).toHaveLength(2);
      expect(typeof c.state[0]).toBe('string');
      expect(c.state[1]).toMatchObject({ type: 'image_url' });
      const serializado = JSON.stringify(c.state);
      for (const word of ['Novo curso', 'Salvar', 'button', 'switch', 'element', 'bbox']) {
        expect(serializado).not.toContain(word);
      }
    }
  });

  it('o ouro vem do DOM: tipos que existem e regiões ocupadas', () => {
    const b = build();
    const porCaso = new Map(b.gold.map((g) => [g.caseId, g]));
    const g1 = porCaso.get('bootstrap-painel-cursos·descoberta')!;
    expect(g1.types).toEqual(['button', 'input', 'link']);
    expect(g1.regions).toEqual(['bottom-center', 'top-left', 'top-right']);
    expect(g1.elementCount).toBe(3);
    const esperado = b.cases[0].expected;
    expect(esperado.type_button).toBe(true);
    expect(esperado.type_radio).toBe(false); // tipo ausente continua a ser uma pergunta (negativa)
    expect(esperado['region_top-left']).toBe(true);
    expect(esperado['region_bottom-left']).toBe(false);
  });

  it('as mesmas perguntas em todas as telas (spec fixa) e partição por cena', () => {
    const b = build();
    const ids0 = Object.keys(b.cases[0].expected).sort();
    for (const c of b.cases) expect(Object.keys(c.expected).sort()).toEqual(ids0);
    expect(b.cases[0].tags).toContain('task:discovery');
    expect(b.cases.map((c) => c.split)).toEqual(['train', 'holdout']);
  });
});

describe('métricas de descoberta', () => {
  it('P/R/F1 dos tipos e das regiões reportadas', () => {
    const esperado = {
      type_button: true, type_link: true, type_radio: false, type_slider: false,
      region_top_left: true, region_top_right: false,
    };
    // acertou tudo
    expect(discoveryMetrics({ ...esperado }, esperado)).toMatchObject({
      typeTruePositives: 2, typeFalsePositives: 0, typeFalseNegatives: 0,
      regionTruePositives: 1, regionFalsePositives: 0, regionFalseNegatives: 0,
    });
    // exagerou: reportou radio e slider; esqueceu link e top-right
    const exagerou = discoveryMetrics(
      { type_button: true, type_link: false, type_radio: true, type_slider: true, region_top_left: true, region_top_right: true },
      esperado,
    );
    expect(exagerou).toMatchObject({ typeTruePositives: 1, typeFalsePositives: 2, typeFalseNegatives: 1 });
    expect(exagerou.typePrecision).toBeCloseTo(1 / 3);
    expect(exagerou.typeRecall).toBeCloseTo(1 / 2);
    expect(exagerou.regionTruePositives).toBe(1);
    expect(exagerou.regionFalsePositives).toBe(1);
  });

  it('recusar tudo não inventa precisão (null, não 1)', () => {
    const esperado = { type_button: true, type_radio: false, region_top_left: true, region_top_right: false };
    const m = discoveryMetrics({}, esperado);
    expect(m.typePrecision).toBeNull();
    expect(m.typeRecall).toBe(0);
    expect(m.typeF1).toBeNull();
    expect(m.regionRecall).toBe(0);
  });
});

describe('gerador real (dataset do pacote)', () => {
  it('gera jev-config@1 + proveniência sem Base64 a partir do dataset pinado', async () => {
    const { cmdVision } = await import('../src/cli/commands/vision.js');
    const dir = await mkdtemp(join(tmpdir(), 'pb-som-'));
    try {
      const out = join(dir, 'som.json');
      const code = await cmdVision(['som', '--out', out, '--task', 'elements', '--slots', '12', '--scenes', 'bootstrap-login']);
      expect(code).toBe(0);
      const cfg = JSON.parse(await (await import('node:fs/promises')).readFile(out, 'utf8'));
      expect(cfg.format).toBe('jev-config@1');
      expect(cfg.mode).toBe('compare');
      expect(cfg.fit).toBe(false);
      expect(Object.keys(cfg.spec.questions)).toHaveLength(12);
      for (const q of Object.values(cfg.spec.questions as Record<string, { type: string }>)) expect(q.type).toBe('noul');
      expect(cfg.cases.length).toBeGreaterThan(0);
      expect(cfg.models.decision.length).toBeGreaterThan(3);
      const prov = JSON.parse(await (await import('node:fs/promises')).readFile(`${out}.provenance.json`, 'utf8'));
      expect(prov.cases[0].slots[0]).toHaveProperty('kind');
      expect(JSON.stringify(prov)).not.toMatch(/base64/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
