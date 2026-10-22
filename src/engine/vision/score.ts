// BENCHMARK DE VISÃO — placar (puro). Sem LLM, sem heurística escondida: a
// verdade é a caixa do DOM e a comparação está documentada em `match.ts`.
//
// Casamento um-para-um: cada previsão casa com no máximo um elemento e vice-
// versa, gulosamente, por qualidade (rótulo > tipo > distância). Previsões
// sobrando contam contra a precisão (alucinação/duplicata); elementos sobrando
// contam contra o recall (o modelo não viu).
//
// `matched` é acerto de REGIÃO (o ponto caiu na caixa); `labeled`/`typed`
// qualificam o acerto e têm métricas próprias. `pass` do modo ação é o único
// critério de sucesso da tarefa.

import {
  distanceToCenter,
  elementNameMatches,
  normalizeType,
  pointInBBox,
  textSimilarity,
} from './match.js';
import type {
  VisionActionCell,
  VisionActionAggregate,
  VisionActionPrediction,
  VisionActionScore,
  VisionActionTask,
  VisionBenchmark,
  VisionCell,
  VisionContestant,
  VisionElement,
  VisionElementMatch,
  VisionElementPrediction,
  VisionMapAggregate,
  VisionMapCell,
  VisionMapScore,
  VisionScene,
  VisionVariantAggregate,
} from './types.js';
import { VISION_SCORE_WEIGHTS } from './types.js';

/** Limiar do texto digitado/declarado (0–1) para contar como acerto. */
export const TEXT_MATCH_THRESHOLD = 0.75;

interface Candidato {
  predIndex: number;
  elementId: string;
  elementType: VisionElement['type'];
  labeled: boolean;
  typed: boolean;
  distance: number;
  qualidade: number;
}

/** Trecho comum: casa previsões com elementos (1-para-1) por qualidade. */
function casar(
  elements: readonly VisionElement[],
  predictions: readonly VisionElementPrediction[],
): { candidatos: Candidato[]; escolhidos: Candidato[]; porElemento: Map<string, Candidato> } {
  const candidatos: Candidato[] = [];
  for (let pi = 0; pi < predictions.length; pi++) {
    const p = predictions[pi]!;
    for (const el of elements) {
      if (!pointInBBox(p.x, p.y, el.bbox)) continue;
      const labeled = elementNameMatches(el, p.label) || elementNameMatches(el, p.iconDescription);
      const tipoPrevisto = normalizeType(p.type);
      const typed = tipoPrevisto === el.type;
      const distance = distanceToCenter(p.x, p.y, el.bbox);
      // Qualidade: rótulo vale mais que tipo; distância desempata.
      const qualidade = (labeled ? 2 : 0) + (typed ? 1 : 0) - distance / 1e6;
      candidatos.push({
        predIndex: pi,
        elementId: el.id,
        elementType: el.type,
        labeled,
        typed,
        distance,
        qualidade,
      });
    }
  }
  candidatos.sort((a, b) => b.qualidade - a.qualidade || a.distance - b.distance);
  const predUsada = new Set<number>();
  const elementoUsado = new Set<string>();
  const escolhidos: Candidato[] = [];
  const porElemento = new Map<string, Candidato>();
  for (const c of candidatos) {
    if (predUsada.has(c.predIndex) || elementoUsado.has(c.elementId)) continue;
    predUsada.add(c.predIndex);
    elementoUsado.add(c.elementId);
    escolhidos.push(c);
    porElemento.set(c.elementId, c);
  }
  return { candidatos, escolhidos, porElemento };
}

/** Placar de UMA cena no modo mapa. */
export function scoreMapScene(
  scene: VisionScene,
  predictions: readonly VisionElementPrediction[],
): VisionMapScore {
  const { escolhidos, porElemento } = casar(scene.elements, predictions);
  const matched = escolhidos.length;
  const labeled = escolhidos.filter((c) => c.labeled).length;
  const typed = escolhidos.filter((c) => c.typed).length;
  const precision = predictions.length > 0 ? matched / predictions.length : 0;
  const recall = scene.elements.length > 0 ? matched / scene.elements.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const labelRecall = scene.elements.length > 0 ? labeled / scene.elements.length : 0;
  const labelPrecision = predictions.length > 0 ? labeled / predictions.length : 0;
  const labelF1 =
    labelPrecision + labelRecall > 0
      ? (2 * labelPrecision * labelRecall) / (labelPrecision + labelRecall)
      : 0;
  const matches: VisionElementMatch[] = scene.elements.map((el) => {
    const c = porElemento.get(el.id);
    const p = c ? predictions[c.predIndex] : undefined;
    return {
      elementId: el.id,
      elementType: el.type,
      predIndex: c?.predIndex ?? -1,
      hit: Boolean(c),
      labeled: Boolean(c?.labeled),
      typed: Boolean(c?.typed),
      distancePx: c ? Math.round(c.distance) : -1,
      predictedType: p?.type ?? '',
      predictedLabel: p?.label ?? null,
    };
  });
  const distancias = escolhidos.map((c) => c.distance);
  return {
    sceneId: scene.id,
    elements: scene.elements.length,
    predicted: predictions.length,
    matched,
    labeled,
    typed,
    precision,
    recall,
    f1,
    labelPrecision,
    labelRecall,
    labelF1,
    typeAccuracy: matched > 0 ? typed / matched : null,
    meanDistancePx:
      distancias.length > 0 ? Math.round(distancias.reduce((a, b) => a + b, 0) / distancias.length) : null,
    matches,
    unmatchedPredictions: predictions.length - matched,
    missedElements: scene.elements.filter((el) => !porElemento.has(el.id)).map((el) => el.id),
  };
}

/** Placar de UMA tarefa do modo ação. */
export function scoreActionTask(
  scene: VisionScene,
  task: VisionActionTask,
  prediction: VisionActionPrediction | null,
): VisionActionScore {
  const alvo = task.expect.targetId
    ? scene.elements.find((e) => e.id === task.expect.targetId)
    : undefined;
  const predictedAction = prediction?.action ?? 'unknown';
  const actionOk = prediction != null && prediction.action === task.expect.action;
  const temPonto = prediction?.x != null && prediction?.y != null;
  let targetHit: boolean | null = null;
  let distancePx: number | null = null;
  if (alvo) {
    if (temPonto) {
      targetHit = pointInBBox(prediction!.x!, prediction!.y!, alvo.bbox);
      distancePx = Math.round(distanceToCenter(prediction!.x!, prediction!.y!, alvo.bbox));
    } else {
      targetHit = false;
    }
  }
  let textOk: boolean | null = null;
  if (task.expect.text !== undefined) {
    textOk = prediction?.text ? textSimilarity(task.expect.text, prediction.text) >= TEXT_MATCH_THRESHOLD : false;
  }
  const precisaPonto = alvo !== undefined;
  const pass = Boolean(
    actionOk && (!precisaPonto || targetHit === true) && (textOk === null || textOk === true),
  );
  return {
    taskId: task.id,
    sceneId: scene.id,
    expectedAction: task.expect.action,
    predictedAction,
    actionOk,
    targetHit,
    textOk,
    pass,
    distancePx,
  };
}

function razao(numerador: number, denominador: number): number {
  return denominador > 0 ? numerador / denominador : 0;
}

/** Agrega as células de mapa de UM competidor (micro-média). */
export function aggregateMap(entries: ReadonlyArray<{ cell: VisionMapCell; scene: VisionScene }>): VisionMapAggregate {
  const validas = entries.filter((e) => e.cell.status !== 'skipped');
  let elements = 0;
  let predicted = 0;
  let matched = 0;
  let labeled = 0;
  let typed = 0;
  let parseFailures = 0;
  const byFamily: VisionMapAggregate['byFamily'] = {};
  const byElementType: VisionMapAggregate['byElementType'] = {};
  for (const { cell, scene } of validas) {
    const score = cell.score;
    if (!score) {
      // Chamada falhou (sem score): a cena continua no denominador do recall —
      // erro de modelo é resposta errada, não amostra excluída.
      elements += scene.elements.length;
      continue;
    }
    elements += score.elements;
    predicted += score.predicted;
    matched += score.matched;
    labeled += score.labeled;
    typed += score.typed;
    if (!cell.parseOk) parseFailures += 1;
    const fam = (byFamily[cell.family] ??= { scenes: 0, f1: 0, labelF1: 0, recall: 0 });
    fam.scenes += 1;
    fam.f1 += score.f1;
    fam.labelF1 += score.labelF1;
    fam.recall += score.recall;
    for (const m of score.matches) {
      const t = (byElementType[m.elementType] ??= { elements: 0, matched: 0, recall: 0 });
      t.elements += 1;
      if (m.hit) t.matched += 1;
    }
  }
  for (const v of Object.values(byFamily)) {
    v.f1 = razao(v.f1, v.scenes);
    v.labelF1 = razao(v.labelF1, v.scenes);
    v.recall = razao(v.recall, v.scenes);
  }
  for (const v of Object.values(byElementType)) v.recall = razao(v.matched, v.elements);
  const precision = razao(matched, predicted);
  const recall = razao(matched, elements);
  return {
    scenes: validas.length,
    elements,
    predicted,
    matched,
    labeled,
    typed,
    precision,
    recall,
    f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
    labelF1:
      razao(labeled, predicted) + razao(labeled, elements) > 0
        ? (2 * razao(labeled, predicted) * razao(labeled, elements)) /
          (razao(labeled, predicted) + razao(labeled, elements))
        : 0,
    typeAccuracy: matched > 0 ? typed / matched : null,
    parseFailures,
    meanPredicted: razao(predicted, validas.length),
    byFamily,
    byElementType,
  };
}

/** Agrega as células de ação de UM competidor. */
export function aggregateAction(entries: ReadonlyArray<VisionActionCell>): VisionActionAggregate {
  const validas = entries.filter((c) => c.status !== 'skipped');
  let passed = 0;
  let actionOk = 0;
  let comAlvo = 0;
  let alvoOk = 0;
  let comTexto = 0;
  let textoOk = 0;
  let parseFailures = 0;
  const byFamily: VisionActionAggregate['byFamily'] = {};
  const byAction: VisionActionAggregate['byAction'] = {};
  for (const cell of validas) {
    const score = cell.score;
    if (!score) continue; // erro de chamada: conta em `actionAccuracy`/`passRate`, não como parse
    if (!cell.parseOk) parseFailures += 1;
    if (score.pass) passed += 1;
    if (score.actionOk) actionOk += 1;
    if (score.targetHit !== null) {
      comAlvo += 1;
      if (score.targetHit) alvoOk += 1;
    }
    if (score.textOk !== null) {
      comTexto += 1;
      if (score.textOk) textoOk += 1;
    }
    const fam = (byFamily[cell.family] ??= { tasks: 0, passed: 0, passRate: 0 });
    fam.tasks += 1;
    if (score.pass) fam.passed += 1;
    const act = (byAction[score.expectedAction] ??= { tasks: 0, passed: 0, passRate: 0 });
    act.tasks += 1;
    if (score.pass) act.passed += 1;
  }
  for (const v of Object.values(byFamily)) v.passRate = razao(v.passed, v.tasks);
  for (const v of Object.values(byAction)) v.passRate = razao(v.passed, v.tasks);
  return {
    tasks: validas.length,
    passed,
    passRate: razao(passed, validas.length),
    actionAccuracy: razao(actionOk, validas.length),
    targetHitRate: comAlvo > 0 ? razao(alvoOk, comAlvo) : null,
    textOkRate: comTexto > 0 ? razao(textoOk, comTexto) : null,
    parseFailures,
    byFamily,
    byAction,
  };
}

/** Nota de manchete 0–1 (média das notas disponíveis: mapa F1 e ação passRate). */
export function headlineScore(map?: VisionMapAggregate, action?: VisionActionAggregate): number {
  const partes: number[] = [];
  if (map && map.scenes > 0) partes.push(map.f1);
  if (action && action.tasks > 0) partes.push(action.passRate);
  if (partes.length === 0) return 0;
  return partes.reduce((a, b) => a + b, 0) / partes.length;
}

/** Consolida todas as células de um modelo no competidor do record. */
export function aggregateContestant(params: {
  contestantId: string;
  modelId: string;
  cells: readonly VisionCell[];
  scenes: ReadonlyMap<string, VisionScene>;
  /** Banco da run — decide a nota de manchete por variante. */
  benchmark?: VisionBenchmark;
}): VisionContestant {
  const { contestantId, modelId, cells, scenes } = params;
  const benchmark = params.benchmark ?? 'grounding';
  const mapEntries: Array<{ cell: VisionMapCell; scene: VisionScene }> = [];
  const actionCells: VisionActionCell[] = [];
  for (const cell of cells) {
    const scene = scenes.get(cell.sceneId);
    if (!scene) continue;
    if (cell.kind === 'map') mapEntries.push({ cell, scene });
    else actionCells.push(cell);
  }
  const map = mapEntries.length > 0 ? aggregateMap(mapEntries) : undefined;
  const action = actionCells.length > 0 ? aggregateAction(actionCells) : undefined;

  // Recorte por variante: é o número que responde "quanto caiu em 360p?" e
  // "o Mark-Grid bateu o controle?". A agregação global acima continua sendo
  // a leitura genérica (e é o que a SPA antiga sabe desenhar).
  const variants: VisionVariantAggregate[] = [];
  if (benchmark !== 'grounding') {
    const porVariante = new Map<string, VisionCell[]>();
    for (const c of cells) {
      if (!c.variant) continue;
      const lista = porVariante.get(c.variant) ?? [];
      lista.push(c);
      porVariante.set(c.variant, lista);
    }
    for (const [variant, lista] of porVariante) {
      const mapV = lista.filter((c): c is VisionMapCell => c.kind === 'map');
      const actionV = lista.filter((c): c is VisionActionCell => c.kind === 'action');
      const mapAgg = mapV.length > 0 ? aggregateMap(mapV.map((cell) => ({ cell, scene: scenes.get(cell.sceneId)! })).filter((e) => e.scene)) : undefined;
      const actionAgg = actionV.length > 0 ? aggregateAction(actionV) : undefined;
      const naoPuladas = lista.filter((c) => c.status !== 'skipped');
      const latenciasV = naoPuladas.filter((c) => c.latencyMs > 0).map((c) => c.latencyMs);
      variants.push({
        variant,
        benchmark,
        cells: lista.length,
        errors: lista.filter((c) => c.status === 'error').length,
        skipped: lista.filter((c) => c.status === 'skipped').length,
        calls: lista.reduce((a, c) => a + (c.kind === 'action' ? c.trace?.length ?? 1 : 1), 0),
        costUsd: lista.reduce((a, c) => a + c.costUsd, 0),
        meanLatencyMs:
          latenciasV.length > 0 ? Math.round(latenciasV.reduce((a, b) => a + b, 0) / latenciasV.length) : 0,
        tokensIn: lista.reduce((a, c) => a + c.tokensIn, 0),
        tokensOut: lista.reduce((a, c) => a + c.tokensOut, 0),
        ...(mapAgg
          ? {
              map: {
                scenes: mapAgg.scenes,
                f1: mapAgg.f1,
                precision: mapAgg.precision,
                recall: mapAgg.recall,
                labelF1: mapAgg.labelF1,
                typeAccuracy: mapAgg.typeAccuracy,
              },
            }
          : {}),
        ...(actionAgg
          ? {
              action: {
                tasks: actionAgg.tasks,
                passed: actionAgg.passed,
                passRate: actionAgg.passRate,
                actionAccuracy: actionAgg.actionAccuracy,
                targetHitRate: actionAgg.targetHitRate,
                textOkRate: actionAgg.textOkRate,
              },
            }
          : {}),
      });
    }
    variants.sort((a, b) => {
      // Controle primeiro (grade), depois escalas da maior para a menor.
      if (a.variant === 'plain') return -1;
      if (b.variant === 'plain') return 1;
      const na = Number(a.variant.split('x')[0]);
      const nb = Number(b.variant.split('x')[0]);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return nb - na;
      return a.variant.localeCompare(b.variant);
    });
  }

  const notasVariante = variants
    .map((v) => v.map?.f1 ?? v.action?.passRate ?? null)
    .filter((v): v is number => v !== null);
  const score =
    benchmark !== 'grounding' && notasVariante.length > 0
      ? notasVariante.reduce((a, b) => a + b, 0) / notasVariante.length
      : headlineScore(map, action);
  const feitas = cells.filter((c) => c.status !== 'skipped');
  const latencias = feitas.filter((c) => c.latencyMs > 0).map((c) => c.latencyMs);
  return {
    contestantId,
    modelId,
    ...(map ? { map } : {}),
    ...(action ? { action } : {}),
    ...(variants.length > 0 ? { variants } : {}),
    score,
    calls: cells.reduce((a, c) => a + (c.kind === 'action' ? c.trace?.length ?? 1 : 1), 0),
    errors: cells.filter((c) => c.status === 'error').length,
    skipped: cells.filter((c) => c.status === 'skipped').length,
    parseFailures: cells.filter((c) => c.status === 'ok' && !c.parseOk).length,
    costUsd: cells.reduce((a, c) => a + c.costUsd, 0),
    tokensIn: cells.reduce((a, c) => a + c.tokensIn, 0),
    tokensOut: cells.reduce((a, c) => a + c.tokensOut, 0),
    meanLatencyMs:
      latencias.length > 0 ? Math.round(latencias.reduce((a, b) => a + b, 0) / latencias.length) : 0,
  };
}

/** Peso documentado de cada modo (a manchete usa a média das notas presentes). */
export const VISION_HEADLINE_WEIGHTS = VISION_SCORE_WEIGHTS;
