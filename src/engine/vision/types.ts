// BENCHMARK DE VISÃO (UI grounding) — tipos do dataset, das previsões e do
// record. Tudo aqui é PURO (sem fs, sem rede): é o contrato que o gerador de
// cenários, o runner, o placar e o relatório compartilham.
//
// A pergunta do benchmark é uma só: **o modelo sabe ONDE estão os elementos
// clicáveis desta imagem — e, no modo ação, o que clicar para cumprir o
// pedido?** A verdade é exata por construção: cada cenário é HTML renderizado
// por nós, então a posição de cada botão/input sai do DOM (getBoundingClientRect)
// e não de uma anotação humana sujeita a erro.
//
// Dois modos, um dataset:
//   • `map`    — o modelo recebe a imagem e devolve TODOS os elementos
//                interativos com posição: `{type, label, iconDescription, x, y}`.
//   • `action` — o modelo recebe a imagem + um pedido em linguagem natural e
//                devolve a AÇÃO e a posição quando ela precisa de alvo.
//
// O dataset é versionado e cresce por adição (nunca "prova criada na hora"): o
// record referencia o hash do dataset usado, e um cenário novo é um commit.

import type { RunStatus } from '../../types.js';

/** Formato do manifesto do dataset (chave de leitura, não de escrita). */
export const VISION_DATASET_FORMAT = 'vision-dataset@1';

/** Formato do record de uma run. */
export const VISION_RUN_FORMAT = 'vision-run@1';

/** Resolução canônica das imagens — o dataset inteiro é 1080p. */
export const VISION_VIEWPORT = { width: 1920, height: 1080 } as const;

/**
 * Vocabulário FECHADO de tipos de elemento. O modelo pode responder o que
 * quiser (o parser normaliza sinônimos PT/EN), mas o placar só compara dentro
 * deste conjunto — é ele que o prompt apresenta.
 */
export const VISION_ELEMENT_TYPES = [
  'button',
  'link',
  'input',
  'textarea',
  'select',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'tab',
  'menuitem',
  'other',
] as const;

export type VisionElementType = (typeof VISION_ELEMENT_TYPES)[number];

/**
 * Vocabulário FECHADO de ações do modo `action`. `scroll`/`key` não têm alvo
 * (a posição é opcional e não é pontuada); as demais exigem um ponto.
 */
export const VISION_ACTIONS = [
  'click',
  'double_click',
  'right_click',
  'type',
  'select',
  'hover',
  'scroll',
  'key',
] as const;

export type VisionAction = (typeof VISION_ACTIONS)[number];

/** Família visual do cenário — cada uma usa um framework/estilo diferente. */
export const VISION_FAMILIES = ['bootstrap', 'react95', 'fluent', 'material', 'macos'] as const;

export type VisionFamily = (typeof VISION_FAMILIES)[number];

/** Modos do benchmark. */
export const VISION_TASKS = ['map', 'action'] as const;

export type VisionTaskKind = (typeof VISION_TASKS)[number];

/** Caixa em PIXELS da imagem (1920×1080) — sempre normalizada para essa grade. */
export interface VisionBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Estado observável de um controle no momento do render. */
export interface VisionElementState {
  disabled?: boolean;
  checked?: boolean;
  focused?: boolean;
  expanded?: boolean;
}

/**
 * Um elemento interativo do cenário — a VERDADE do benchmark.
 *
 * `label` é o nome visível (ou o nome acessível do controle); `iconDescription`
 * só existe para controles sem texto (uma lupa, um "x" de fechar). `aliases`
 * são nomes alternativos aceitos no placar (ex.: "pesquisar" para a lupa),
 * escritos à mão no cenário quando o nome visual é ambíguo — nunca gerados na
 * hora da prova.
 */
export interface VisionElement {
  id: string;
  type: VisionElementType;
  label: string | null;
  iconDescription: string | null;
  aliases?: string[];
  bbox: VisionBBox;
  /** Centro arredondado — a referência de clique do modo `action`. */
  center: { x: number; y: number };
  state?: VisionElementState;
  /** Texto de apoio (placeholder, valor atual, opções) — diagnóstico, não placar. */
  hint?: string;
}

/**
 * Tarefa do modo `action`: um pedido em linguagem natural + o alvo esperado.
 * `targetId` ausente = ação sem alvo (scroll/key) — a posição não é pontuada.
 */
export interface VisionActionTask {
  id: string;
  sceneId: string;
  kind: 'action';
  instruction: string;
  expect: {
    action: VisionAction;
    targetId?: string;
    /** Texto que deve ser digitado/selecionado (comparação normalizada). */
    text?: string;
  };
  /** Dificuldade declarada (triagem do roadmap) — não entra no placar. */
  difficulty?: 'easy' | 'medium' | 'hard';
  tags?: string[];
}

/** Um cenário = uma imagem 1080p + os elementos + as tarefas + o código. */
export interface VisionScene {
  id: string;
  family: VisionFamily;
  title: string;
  theme: 'light' | 'dark';
  viewport: { width: number; height: number };
  /** Imagem renderizada, relativa à raiz do dataset. */
  image: { file: string; sha256: string; bytes: number };
  /** Código-fonte HTML do cenário, relativo à raiz do dataset. */
  code: { file: string };
  /** Elementos interativos em ordem de leitura do DOM (ids `el-1…`). */
  elements: VisionElement[];
  /** Tarefas do modo ação (o modo mapa usa o cenário inteiro). */
  tasks: VisionActionTask[];
  tags?: string[];
}

/** Manifesto completo — é o que viaja no pacote e é pinado por hash. */
export interface VisionDataset {
  format: typeof VISION_DATASET_FORMAT;
  /** Versão semântica do CONJUNTO (cresce com adições/correções). */
  version: string;
  /** Versão do gerador que produziu as imagens (diagnóstico de deriva). */
  generator: string;
  createdAt: string;
  viewport: { width: number; height: number };
  scenes: VisionScene[];
  /** Frame CSS/js (nome + versão + licença) usado por família — proveniência. */
  assets: VisionAssetRef[];
}

export interface VisionAssetRef {
  family: VisionFamily;
  name: string;
  version: string;
  license: string;
  files: string[];
}

/**
 * Previsão de UM elemento no formato pedido ao modelo — e o formato do record:
 * `{type, label, iconDescription, x, y}`. `x`/`y` estão em PIXELS da imagem
 * canonica (o parser converte 0–1000 → pixels; o modelo nunca vê essa conta).
 */
export interface VisionElementPrediction {
  type: string;
  label: string | null;
  iconDescription: string | null;
  x: number;
  y: number;
}

/** Previsão do modo ação (já normalizada para o vocabulário interno). */
export interface VisionActionPrediction {
  action: VisionAction | 'unknown';
  /** Texto cru da ação declarada (diagnóstico). */
  rawAction: string;
  target: string | null;
  x: number | null;
  y: number | null;
  text: string | null;
}

/** Resultado do parser sobre a saída crua do modelo. */
export interface VisionParseResult<T> {
  ok: boolean;
  value: T | null;
  /** Erro curto (para o record); ausente = ok. */
  error?: string;
  /** Sistema de coordenadas detectado (o pedido pode não ser o entregue). */
  coordScale: VisionCoordScale;
  /** Saída crua (truncada) — auditoria do record, nunca placar. */
  raw: string;
}

export type VisionCoordScale = 'pixels' | 'normalized' | 'unknown';

/** Espaço de coordenadas PEDIDO no prompt. */
export const VISION_COORD_SPACES = ['pixels', 'normalized'] as const;

export type VisionCoordSpace = (typeof VISION_COORD_SPACES)[number];

/** O que foi efetivamente perguntado numa célula. */
export interface VisionMapCell {
  kind: 'map';
  cellId: string;
  sceneId: string;
  family: VisionFamily;
  modelId: string;
  contestantId: string;
  prompt: string;
  status: 'ok' | 'error' | 'skipped';
  error?: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Identificadores do provedor que serviu (diagnóstico de deriva). */
  provider?: string;
  /** Saída crua do modelo (limitada) — auditoria. */
  raw?: string;
  parseOk: boolean;
  coordScale: VisionCoordScale;
  predictions: VisionElementPrediction[];
  score?: VisionMapScore;
}

export interface VisionActionCell {
  kind: 'action';
  cellId: string;
  taskId: string;
  sceneId: string;
  family: VisionFamily;
  modelId: string;
  contestantId: string;
  instruction: string;
  prompt: string;
  status: 'ok' | 'error' | 'skipped';
  error?: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  provider?: string;
  raw?: string;
  parseOk: boolean;
  coordScale: VisionCoordScale;
  prediction: VisionActionPrediction | null;
  score?: VisionActionScore;
}

export type VisionCell = VisionMapCell | VisionActionCell;

/** Par elemento↔previsão decidido pelo casamento do placar. */
export interface VisionElementMatch {
  elementId: string;
  elementType: VisionElementType;
  predIndex: number;
  hit: boolean;
  labeled: boolean;
  typed: boolean;
  /** Distância do ponto previsto ao centro do elemento (pixels). */
  distancePx: number;
  predictedType: string;
  predictedLabel: string | null;
}

/** Placar de UMA cena no modo mapa. */
export interface VisionMapScore {
  sceneId: string;
  elements: number;
  predicted: number;
  matched: number;
  labeled: number;
  typed: number;
  /** Precisão/recall/F1 de REGIÃO (o clique caiu na caixa do elemento?). */
  precision: number;
  recall: number;
  f1: number;
  /** Precisão/recall/F1 de RÓTULO (região + nome reconhecido). */
  labelPrecision: number;
  labelRecall: number;
  labelF1: number;
  /** Acerto de TIPO entre os casados; `null` sem casados. */
  typeAccuracy: number | null;
  /** Média de distância (px) dos casados — diagnóstico. */
  meanDistancePx: number | null;
  matches: VisionElementMatch[];
  /** Previsões que não casaram com ninguém (alucinação/duplicata). */
  unmatchedPredictions: number;
  /** Elementos que ninguém apontou. */
  missedElements: string[];
}

/** Placar de UMA tarefa no modo ação. */
export interface VisionActionScore {
  taskId: string;
  sceneId: string;
  expectedAction: VisionAction;
  predictedAction: string;
  actionOk: boolean;
  /** `null` = a ação esperada não tem alvo (scroll/key). */
  targetHit: boolean | null;
  /** `null` = a tarefa não pede texto. */
  textOk: boolean | null;
  pass: boolean;
  distancePx: number | null;
}

/** Agregado de um contestador (modelo) no modo mapa. */
export interface VisionMapAggregate {
  scenes: number;
  elements: number;
  predicted: number;
  matched: number;
  labeled: number;
  typed: number;
  precision: number;
  recall: number;
  f1: number;
  labelF1: number;
  typeAccuracy: number | null;
  /** Cenários em que o parser falhou por inteiro. */
  parseFailures: number;
  /** Média de elementos devolvidos por cena (verbosidade). */
  meanPredicted: number;
  byFamily: Record<string, { scenes: number; f1: number; labelF1: number; recall: number }>;
  byElementType: Record<string, { elements: number; matched: number; recall: number }>;
}

/** Agregado de um contestador no modo ação. */
export interface VisionActionAggregate {
  tasks: number;
  passed: number;
  passRate: number;
  actionAccuracy: number;
  targetHitRate: number | null;
  textOkRate: number | null;
  parseFailures: number;
  byFamily: Record<string, { tasks: number; passed: number; passRate: number }>;
  byAction: Record<string, { tasks: number; passed: number; passRate: number }>;
}

/** Um competidor = um modelo, com os dois agregados. */
export interface VisionContestant {
  contestantId: string;
  modelId: string;
  map?: VisionMapAggregate;
  action?: VisionActionAggregate;
  /** Nota de manchete: média das notas disponíveis (map F1, action passRate). */
  score: number;
  calls: number;
  errors: number;
  skipped: number;
  parseFailures: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  meanLatencyMs: number;
}

/** Configuração RESOLVIDA de uma run (vai no record para reprodutibilidade). */
export interface VisionRunConfig {
  models: string[];
  tasks: VisionTaskKind[];
  families: VisionFamily[] | null;
  scenes: string[] | null;
  limit: number | null;
  coordSpace: VisionCoordSpace;
  temperature: number;
  maxTokens: number;
  reasoning?: string;
  timeoutMs?: number;
  retries: number;
  budgetUsd?: number;
}

export interface VisionRunRecord {
  format: typeof VISION_RUN_FORMAT;
  id: string;
  status: RunStatus;
  /** Versão do dataset + hash do manifesto: a prova é a mesma ou não é a mesma. */
  dataset: { version: string; hash: string; scenes: string[]; images: Record<string, string> };
  /** Versão do contrato de prompt (muda o texto = muda a medição). */
  promptVersion: string;
  config: VisionRunConfig;
  contestants: VisionContestant[];
  cells: VisionCell[];
  totals: {
    calls: number;
    errors: number;
    skipped: number;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
  };
  budget?: { spentUsd: number; budgetUsd?: number; exhausted?: boolean };
  startedAt: string;
  finishedAt?: string;
  error?: string;
  warnings: string[];
}

/** Nota de manchete do benchmark (0–1). Documentada no relatório. */
export const VISION_SCORE_WEIGHTS = { map: 0.5, action: 0.5 } as const;

/** Elemento do dataset por id (nunca lança; `undefined` = id inválido). */
export function sceneById(dataset: VisionDataset, id: string): VisionScene | undefined {
  return dataset.scenes.find((s) => s.id === id);
}

/** Todos os elementos de um cenário indexados por id. */
export function elementsById(scene: VisionScene): Map<string, VisionElement> {
  return new Map(scene.elements.map((e) => [e.id, e]));
}
