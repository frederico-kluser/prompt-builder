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

/**
 * Bancos de prova do MESMO dataset. `grounding` é o F0 (imagem crua); os
 * demais são experimentos CONTROLADOS que mudam UMA variável por célula:
 *   • `resolution` — a mesma tela em 1080p/720p/540p/360p, com coordenadas
 *     convertidas de volta para a grade canônica (mede robustez à escala);
 *   • `grid` — a mesma tarefa de ação com (ou sem) overlay de grade e, no
 *     `mark-grid`, uma segunda rodada sobre o recorte da célula escolhida.
 * A prova em si (imagem + verdade do DOM) é a mesma; o que muda é a
 * APRESENTAÇÃO. Nunca se cria uma prova na hora da run.
 */
export const VISION_BENCHMARKS = ['grounding', 'resolution', 'grid'] as const;

export type VisionBenchmark = (typeof VISION_BENCHMARKS)[number];

/** Escalas do banco `resolution` — todas 16:9, para não misturar recorte. */
export const VISION_RESOLUTIONS = ['1920x1080', '1280x720', '960x540', '640x360'] as const;

export type VisionResolution = (typeof VISION_RESOLUTIONS)[number];

/** Variantes do banco `grid` (controle + técnicas do roadmap). */
export const VISION_GRID_VARIANTS = ['plain', 'grid-simple', 'axis-grid', 'mark-grid'] as const;

export type VisionGridVariant = (typeof VISION_GRID_VARIANTS)[number];

/** Célula do `mark-grid`: caixa canônica + o recorte que a segunda rodada vê. */
export interface VisionGridCellSpec {
  id: string;
  bbox: VisionBBox;
  /** Recorte com padding, já ampliado — o que a rodada 2 recebe. */
  image: VisionImageRef;
  viewport: { width: number; height: number };
  /** Caixa canônica efetivamente recortada (inclui o padding). */
  source: VisionBBox;
}

/** Overlay de grade renderizado no build (nunca desenhado na hora da prova). */
export interface VisionGridOverlay {
  id: Exclude<VisionGridVariant, 'plain'>;
  image: VisionImageRef;
  viewport: { width: number; height: number };
  cols?: number;
  rows?: number;
  /** Passo dos eixos (px canônicos), no `axis-grid`. */
  step?: number;
  /** Células rotuladas do `mark-grid` (com os recortes da rodada 2). */
  cells?: VisionGridCellSpec[];
}

/** Variante de resolução pinada no manifesto (o native reusa a imagem base). */
export interface VisionResolutionRef extends VisionImageRef {
  id: VisionResolution;
  width: number;
  height: number;
}

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

/** Referência de imagem pinada por sha256 (base e variantes). */
export interface VisionImageRef {
  file: string;
  sha256: string;
  bytes: number;
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
  /**
   * Variantes de APRESENTAÇÃO pinadas junto com a tela base. Ausente = o
   * dataset só tem o F0; os bancos novos recusam rodar sem as variantes.
   */
  probes?: {
    resolutions?: VisionResolutionRef[];
    overlays?: VisionGridOverlay[];
  };
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
  /** Célula declarada no `mark-grid` (ex.: "C3"); ausente nos outros bancos. */
  cell?: string | null;
}

/** Rastro de uma rodada do `mark-grid` (a 1ª e a 2ª são medidas e cobradas). */
export interface VisionRoundTrace {
  round: 1 | 2;
  prompt: string;
  status: 'ok' | 'error' | 'skipped';
  error?: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  provider?: string;
  parseOk: boolean;
  coordScale: VisionCoordScale;
  raw: string;
  prediction: VisionActionPrediction | null;
  /** Célula da grade (rodada 1) / recorte usado (rodada 2). */
  cell?: string | null;
  crop?: VisionBBox;
  imageViewport?: { width: number; height: number };
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
  /** Banco e variante desta célula (`resolution`: 1280x720 etc.). */
  benchmark?: VisionBenchmark;
  variant?: string;
  /** Viewport da imagem ENVIADA (as previsões já estão na grade canônica). */
  imageViewport?: { width: number; height: number };
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
  /** Banco e variante desta célula (`grid`: plain/grid-simple/...). */
  benchmark?: VisionBenchmark;
  variant?: string;
  /** Rodadas efetivamente executadas (2 no `mark-grid` com recorte). */
  rounds?: 1 | 2;
  /** Rastros das rodadas (a 1ª também custou e fica auditável). */
  trace?: VisionRoundTrace[];
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

/** Agregado de UMA variante (resolução ou grade) para um modelo. */
export interface VisionVariantAggregate {
  variant: string;
  benchmark: VisionBenchmark;
  cells: number;
  errors: number;
  skipped: number;
  calls: number;
  costUsd: number;
  meanLatencyMs: number;
  tokensIn: number;
  tokensOut: number;
  /** Presente no banco `resolution` (métricas de mapa). */
  map?: {
    scenes: number;
    f1: number;
    precision: number;
    recall: number;
    labelF1: number;
    typeAccuracy: number | null;
  };
  /** Presente no banco `grid` (métricas de ação). */
  action?: {
    tasks: number;
    passed: number;
    passRate: number;
    actionAccuracy: number;
    targetHitRate: number | null;
    textOkRate: number | null;
  };
}

/** Um competidor = um modelo, com os dois agregados. */
export interface VisionContestant {
  contestantId: string;
  modelId: string;
  map?: VisionMapAggregate;
  action?: VisionActionAggregate;
  /**
   * Recorte por variante do banco (o que responde "cai quanto em 360p?" ou
   * "o Mark-Grid bate o controle?"). Fora dos bancos de probe, ausente.
   */
  variants?: VisionVariantAggregate[];
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
  /** Banco de prova; ausente/`grounding` = F0 (compatível com runs antigas). */
  benchmark?: VisionBenchmark;
  /** `resolution`: escalas a rodar (default: todas as do dataset). */
  resolutions?: string[];
  /** `grid`: variantes a rodar (default: todas). */
  gridVariants?: VisionGridVariant[];
  /**
   * Provedor FIXADO no OpenRouter (ex.: `DeepInfra`). Sem pin, o roteamento
   * automático troca de provedor entre células — e um provedor que ignora a
   * imagem vira "resultado do modelo". Com pin, a comparação mede o modelo.
   */
  provider?: string;
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
  /** Banco de prova (ausente em records antigos = `grounding`). */
  benchmark?: VisionBenchmark;
  config: VisionRunConfig;
  contestants: VisionContestant[];
  cells: VisionCell[];
  totals: {
    /** Células avaliadas (no mark-grid, uma célula pode ter 2 chamadas). */
    cells?: number;
    /** Chamadas HTTP efetivamente despachadas. */
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
