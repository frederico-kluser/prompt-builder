// Contrato do PLACAR do benchmark de visão — puro, sem rede e sem imagem.
//
// O que estes testes protegem:
//   • o parser aceita o que os modelos devolvem de verdade (JSON cercado de
//     texto, `bbox`, `%`, 0–1000 vs pixels) e NÃO inventa coordenada;
//   • "acertou" = ponto DENTRO da caixa; rótulo/tipo qualificam, não salvam;
//   • casamento é um-para-um (duplicata/alucinação derruba a precisão);
//   • o modo ação exige ação + alvo + texto quando a tarefa pede.

import { describe, expect, it } from 'vitest';
import {
  aggregateAction,
  aggregateMap,
  elementNameMatches,
  headlineScore,
  labelMatches,
  normalizeText,
  normalizeType,
  parseActionOutput,
  parseMapOutput,
  pointInBBox,
  scoreActionTask,
  scoreMapScene,
  textSimilarity,
  VISION_VIEWPORT,
  type VisionActionCell,
  type VisionMapCell,
  type VisionScene,
} from '../src/engine/vision/index.js';

const opts = { space: 'pixels' as const, viewport: VISION_VIEWPORT };

const scene = (): VisionScene => ({
  id: 'teste',
  family: 'bootstrap',
  title: 'Cena de teste',
  theme: 'light',
  viewport: { ...VISION_VIEWPORT },
  image: { file: 'images/x.png', sha256: 'a'.repeat(64), bytes: 1 },
  code: { file: 'scenes/bootstrap/x.html' },
  elements: [
    {
      id: 'el-entrar',
      type: 'button',
      label: 'Entrar',
      iconDescription: null,
      aliases: ['acessar'],
      bbox: { x: 100, y: 200, w: 120, h: 40 },
      center: { x: 160, y: 220 },
    },
    {
      id: 'el-busca',
      type: 'input',
      label: 'Buscar',
      iconDescription: null,
      bbox: { x: 300, y: 100, w: 200, h: 36 },
      center: { x: 400, y: 118 },
    },
    {
      id: 'el-lupa',
      type: 'button',
      label: null,
      iconDescription: 'lupa de busca',
      aliases: ['pesquisar'],
      bbox: { x: 520, y: 100, w: 32, h: 32 },
      center: { x: 536, y: 116 },
    },
  ],
  tasks: [
    {
      id: 't1',
      sceneId: 'teste',
      kind: 'action',
      instruction: 'Clique em Entrar',
      expect: { action: 'click', targetId: 'el-entrar' },
    },
    {
      id: 't2',
      sceneId: 'teste',
      kind: 'action',
      instruction: 'Digite ana@exemplo.com em Buscar',
      expect: { action: 'type', targetId: 'el-busca', text: 'ana@exemplo.com' },
    },
    {
      id: 't3',
      sceneId: 'teste',
      kind: 'action',
      instruction: 'Role a página',
      expect: { action: 'scroll' },
    },
  ],
});

describe('normalização de nomes/tipos', () => {
  it('ignora acento, caixa e pontuação; aceita contenção e Jaccard', () => {
    expect(normalizeText('  Relatório  Q3.PDF ')).toBe('relatorio q3 pdf');
    expect(labelMatches('Relatório Q3.pdf', 'relatorio q3 pdf')).toBe(true);
    expect(labelMatches('Enviar formulário', 'Enviar')).toBe(true);
    expect(labelMatches('Salvar', 'Cancelar')).toBe(false);
    expect(labelMatches('Excluir', 'Excluir tudo')).toBe(true);
  });

  it('aceita os aliases declarados do cenário (lupa = pesquisar)', () => {
    const lupa = scene().elements[2]!;
    expect(elementNameMatches(lupa, 'pesquisar')).toBe(true);
    expect(elementNameMatches(lupa, 'lupa')).toBe(true);
    expect(elementNameMatches(lupa, 'fechar')).toBe(false);
  });

  it('mapeia sinônimos de tipo PT/EN para o vocabulário fechado', () => {
    expect(normalizeType('botão')).toBe('button');
    expect(normalizeType('text field')).toBe('input');
    expect(normalizeType('dropdown')).toBe('select');
    expect(normalizeType('check_box')).toBe('checkbox');
    expect(normalizeType('menu item')).toBe('menuitem');
    expect(normalizeType('coisa estranha')).toBe('other');
  });

  it('similaridade de texto digitado tolera acento/caixa e reprova texto diferente', () => {
    expect(textSimilarity('Relatório-Q3-final.pdf', 'relatorio-q3-final.pdf')).toBe(1);
    expect(textSimilarity('ana@exemplo.com', 'ana@exemplo.com')).toBe(1);
    expect(textSimilarity('ana@exemplo.com', 'outra@coisa.com')).toBeLessThan(0.5);
  });
});

describe('parser do modo map', () => {
  it('aceita JSON puro, cercado e com prosa em volta', () => {
    const esperado = [{ type: 'button', label: 'Entrar', iconDescription: null, x: 160, y: 220 }];
    for (const texto of [
      JSON.stringify({ elements: esperado }),
      '```json\n' + JSON.stringify({ elements: esperado }) + '\n```',
      'Aqui está:\n' + JSON.stringify(esperado) + '\nfim.',
    ]) {
      const r = parseMapOutput(texto, opts);
      expect(r.ok, texto).toBe(true);
      expect(r.value).toEqual(esperado);
    }
  });

  it('converte 0–1000 para pixels quando o modelo ignora o espaço pedido', () => {
    const r = parseMapOutput('{"elements":[{"type":"button","label":"X","x":500,"y":250}]}', {
      space: 'normalized',
      viewport: VISION_VIEWPORT,
    });
    expect(r.coordScale).toBe('normalized');
    expect(r.value).toEqual([{ type: 'button', label: 'X', iconDescription: null, x: 960, y: 270 }]);
  });

  it('aceita bbox, point e porcentagem; descarta item sem coordenada', () => {
    const r = parseMapOutput(
      JSON.stringify({
        elements: [
          { type: 'button', label: 'A', bbox: [100, 200, 300, 260] },
          { type: 'link', label: 'B', point: [400, 500] },
          { type: 'input', label: 'C', x: '50%', y: '25%' },
          { type: 'button', label: 'D' },
        ],
      }),
      opts,
    );
    expect(r.ok).toBe(true);
    expect(r.value).toHaveLength(3);
    expect(r.value![0]).toMatchObject({ x: 200, y: 230 });
    expect(r.value![1]).toMatchObject({ x: 400, y: 500 });
    expect(r.value![2]).toMatchObject({ x: 960, y: 270 });
  });

  it('saída sem JSON não vira previsão', () => {
    const r = parseMapOutput('não consegui encontrar a tela', opts);
    expect(r.ok).toBe(false);
    expect(r.value).toBeNull();
    expect(r.error).toContain('sem JSON');
  });
});

describe('parser do modo action', () => {
  it('reconhece ação em PT/EN e o ponto', () => {
    const r = parseActionOutput(
      '{"acao":"clicar","alvo":"Entrar","x":160,"y":220,"texto":null}',
      opts,
    );
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ action: 'click', target: 'Entrar', x: 160, y: 220 });
  });

  it('ação desconhecida é inválida mesmo com coordenada', () => {
    const r = parseActionOutput('{"action":"voar","x":10,"y":10}', opts);
    expect(r.ok).toBe(false);
    expect(r.value?.action).toBe('unknown');
  });

  it('scroll não exige ponto', () => {
    const r = parseActionOutput('{"action":"scroll","direction":"down"}', opts);
    expect(r.ok).toBe(true);
    expect(r.value?.x).toBeNull();
  });
});

describe('placar do modo map', () => {
  it('clique perfeito com rótulo e tipo = F1 1 e casamento 1-para-1', () => {
    const s = scene();
    const score = scoreMapScene(s, [
      { type: 'button', label: 'Entrar', iconDescription: null, x: 160, y: 220 },
      { type: 'input', label: 'Buscar', iconDescription: null, x: 400, y: 118 },
      { type: 'button', label: 'pesquisar', iconDescription: null, x: 536, y: 116 },
    ]);
    expect(score.matched).toBe(3);
    expect(score.labeled).toBe(3);
    expect(score.typed).toBe(3);
    expect(score.f1).toBe(1);
    expect(score.labelF1).toBe(1);
    expect(score.missedElements).toEqual([]);
  });

  it('ponto FORA da caixa não acerta, mesmo com o rótulo certo', () => {
    const s = scene();
    const score = scoreMapScene(s, [
      { type: 'button', label: 'Entrar', iconDescription: null, x: 10, y: 10 },
    ]);
    expect(score.matched).toBe(0);
    expect(score.recall).toBe(0);
    expect(score.missedElements).toContain('el-entrar');
  });

  it('duplicata e alucinação derrubam a precisão; casamento não reusa elemento', () => {
    const s = scene();
    const score = scoreMapScene(s, [
      { type: 'button', label: 'Entrar', iconDescription: null, x: 160, y: 220 },
      { type: 'button', label: 'Entrar', iconDescription: null, x: 165, y: 225 },
      { type: 'button', label: 'Fantasma', iconDescription: null, x: 1500, y: 900 },
    ]);
    expect(score.matched).toBe(1);
    expect(score.predicted).toBe(3);
    expect(score.precision).toBeCloseTo(1 / 3);
    expect(score.unmatchedPredictions).toBe(2);
  });

  it('tipo errado não impede o acerto de região, mas não conta como tipo certo', () => {
    const s = scene();
    const score = scoreMapScene(s, [
      { type: 'link', label: 'Entrar', iconDescription: null, x: 160, y: 220 },
    ]);
    expect(score.matched).toBe(1);
    expect(score.typed).toBe(0);
    expect(score.typeAccuracy).toBe(0);
  });

  it('ponto dentro da caixa é inclusivo nas bordas', () => {
    expect(pointInBBox(100, 200, { x: 100, y: 200, w: 10, h: 10 })).toBe(true);
    expect(pointInBBox(110, 210, { x: 100, y: 200, w: 10, h: 10 })).toBe(true);
    expect(pointInBBox(111, 200, { x: 100, y: 200, w: 10, h: 10 })).toBe(false);
  });
});

describe('placar do modo action', () => {
  it('passa só com ação + alvo + texto corretos', () => {
    const s = scene();
    const t1 = s.tasks[0]!;
    const t2 = s.tasks[1]!;
    const ok = scoreActionTask(s, t1, { action: 'click', rawAction: 'click', target: 'Entrar', x: 160, y: 220, text: null });
    expect(ok.pass).toBe(true);
    const fora = scoreActionTask(s, t1, { action: 'click', rawAction: 'click', target: 'Entrar', x: 10, y: 10, text: null });
    expect(fora.pass).toBe(false);
    expect(fora.targetHit).toBe(false);
    const textoErrado = scoreActionTask(s, t2, {
      action: 'type', rawAction: 'type', target: 'Buscar', x: 400, y: 118, text: 'outro@x.com',
    });
    expect(textoErrado.pass).toBe(false);
    const textoCerto = scoreActionTask(s, t2, {
      action: 'type', rawAction: 'type', target: 'Buscar', x: 400, y: 118, text: 'ana@exemplo.com',
    });
    expect(textoCerto.pass).toBe(true);
  });

  it('scroll sem alvo passa se a ação é a esperada', () => {
    const s = scene();
    const t3 = s.tasks[2]!;
    expect(scoreActionTask(s, t3, { action: 'scroll', rawAction: 'scroll', target: null, x: null, y: null, text: null }).pass).toBe(true);
    expect(scoreActionTask(s, t3, null).pass).toBe(false);
  });
});

describe('agregação e nota de manchete', () => {
  const mapCell = (over: Partial<VisionMapCell>): VisionMapCell => ({
    kind: 'map',
    cellId: 'map:teste',
    sceneId: 'teste',
    family: 'bootstrap',
    modelId: 'm',
    contestantId: 'm',
    prompt: 'p',
    status: 'ok',
    latencyMs: 10,
    tokensIn: 100,
    tokensOut: 10,
    costUsd: 0.001,
    parseOk: true,
    coordScale: 'pixels',
    predictions: [],
    ...over,
  });

  it('micro-média de mapa e ação + manchete média', () => {
    const s = scene();
    const map = aggregateMap([
      { cell: mapCell({}), scene: s },
    ]);
    expect(map.scenes).toBe(1);
    expect(map.f1).toBe(0);
    const actionCells: VisionActionCell[] = s.tasks.map((t, i) => ({
      kind: 'action',
      cellId: `action:${t.id}`,
      taskId: t.id,
      sceneId: s.id,
      family: s.family,
      modelId: 'm',
      contestantId: 'm',
      instruction: t.instruction,
      prompt: 'p',
      status: 'ok',
      latencyMs: 5,
      tokensIn: 50,
      tokensOut: 5,
      costUsd: 0.0005,
      parseOk: true,
      coordScale: 'pixels',
      prediction: null,
      score: scoreActionTask(s, t, i === 0 ? { action: 'click', rawAction: 'click', target: 'Entrar', x: 160, y: 220, text: null } : null),
    }));
    const action = aggregateAction(actionCells);
    expect(action.tasks).toBe(3);
    expect(action.passed).toBe(1);
    expect(action.passRate).toBeCloseTo(1 / 3);
    expect(action.byAction.click?.passRate).toBe(1);
    expect(headlineScore(undefined, action)).toBeCloseTo(1 / 3);
    expect(headlineScore(map, action)).toBeCloseTo(1 / 6);
  });
});
