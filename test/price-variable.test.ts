// IMPL-043 (R-11b:REC-7) — preço "-1" (roteadores) na SPA.
//
// O IMPL-018 já fez o "-1" do catálogo virar `null` (desconhecido). Aqui o
// contrato é o da TELA da Nova run e do seletor:
//  (1) a prévia de custo não é contaminada pelo modelo de preço variável
//      (contribuição NEUTRA + o modelo marcado para o aviso), e o filtro de
//      preço máximo NÃO o inclui por default — só por decisão explícita;
//  (2) a UI nunca renderiza número negativo para preço (render real do
//      ModelSelector + guarda estrutural contra aritmética crua de preço);
//  (3) a contagem "X de Y" e o aviso "custo não estimável" refletem o caso.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGateway, parseModelsPayload, setDefaultGateway } from '../src/openrouter.js';
import { cmdModels } from '../src/cli/commands/models.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import {
  createCostPreviewPricer,
  describeMaxPriceFilter,
  filterByMaxPrice,
  formatPricingLabel,
  unestimableCostNotice,
  unknownPriceNote,
  UNESTIMABLE_COST_LABEL,
  UNKNOWN_PRICE_LABEL,
  type PricedModel,
} from '../src/engine/pricing.js';
import type { OpenRouterModel } from '../src/types.js';
import { COST_CONFIRM_THRESHOLD_USD, estimateLaunchCost } from '../src/engine/costConfirmation.js';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'sk-or-v1-fake-key-para-teste-impl043-000000';

/** Roteador cru, como o /models real manda ("-1" = preço variável). */
function routerItem(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    context_length: 2_000_000,
    pricing: { prompt: '-1', completion: '-1' },
    supported_parameters: [],
  };
}

// Catálogo passando pelo parse REAL do fio (o "-1" chega como string).
const CATALOGO: OpenRouterModel[] = parseModelsPayload({
  data: [
    catalogItem('a/barato', 1e-7, 4e-7), // $0.10 / $0.40 por 1M
    catalogItem('a/medio', 1e-6, 2e-6), // $1 / $2
    catalogItem('a/caro', 5e-6, 2e-5), // $5 / $20
    routerItem('openrouter/auto'),
    // Só a SAÍDA é desconhecida (campo lixo): teto só de entrada não depende dela.
    { ...catalogItem('b/meio', 5e-7, 1e-6), pricing: { prompt: '0.0000005', completion: 'n/a' } },
  ],
});

const ids = (ms: readonly PricedModel[]): string[] => ms.map((m) => m.id);

/** Registro/cache ANTIGO que ainda guardou o -1 como número (antes do IMPL-018). */
const LEGADO: PricedModel = { id: 'openrouter/legado', pricing: { prompt: -1, completion: -1 } };

// ---------------------------------------------------------------------------

describe('IMPL-043 (1) — filtro de preço máximo: variável fica FORA por default', () => {
  it('sem teto não há filtro: todos passam, inclusive o roteador (nada a garantir)', () => {
    const r = filterByMaxPrice(CATALOGO, {});
    expect(r.active).toBe(false);
    expect(ids(r.models)).toEqual(ids(CATALOGO));
    expect(r.unknownIds).toEqual([]);
    // Campo vazio no formulário = parseFloat('') = NaN = sem teto.
    expect(filterByMaxPrice(CATALOGO, { maxPromptPerMTok: NaN, maxCompletionPerMTok: NaN }).active).toBe(false);
  });

  it('teto ativo: roteador "-1" NÃO passa por default (antes -1e6 > teto era sempre falso)', () => {
    // Teto altíssimo: todo modelo de preço CONHECIDO cabe; o variável, não.
    const r = filterByMaxPrice(CATALOGO, { maxPromptPerMTok: 1_000_000, maxCompletionPerMTok: 1_000_000 });
    expect(r.active).toBe(true);
    expect(ids(r.models)).toEqual(['a/barato', 'a/medio', 'a/caro']);
    expect(r.unknownIds).toEqual(['openrouter/auto', 'b/meio']);
    expect(r.includeUnknown).toBe(false);
    // O regime antigo (-1 numérico em cache/record) também fica de fora.
    expect(filterByMaxPrice([LEGADO], { maxPromptPerMTok: 0 }).models).toEqual([]);
  });

  it('decisão EXPLÍCITA do usuário (includeUnknown) traz o variável de volta — e só ele', () => {
    const r = filterByMaxPrice(CATALOGO, { maxPromptPerMTok: 1, maxCompletionPerMTok: 2, includeUnknown: true });
    expect(ids(r.models)).toEqual(['a/barato', 'a/medio', 'openrouter/auto', 'b/meio']);
    // Preço CONHECIDO acima do teto continua fora mesmo com a escolha explícita.
    expect(r.aboveCap).toBe(1);
    expect(ids(r.models)).not.toContain('a/caro');
    expect(r.unknownIds).toEqual(['openrouter/auto', 'b/meio']);
  });

  it('só o lado COM teto importa: saída desconhecida não bloqueia teto só de entrada', () => {
    const soEntrada = filterByMaxPrice(CATALOGO, { maxPromptPerMTok: 1 });
    expect(ids(soEntrada.models)).toEqual(['a/barato', 'a/medio', 'b/meio']);
    expect(soEntrada.unknownIds).toEqual(['openrouter/auto']);
    const soSaida = filterByMaxPrice(CATALOGO, { maxCompletionPerMTok: 2 });
    expect(ids(soSaida.models)).toEqual(['a/barato', 'a/medio']);
    expect(soSaida.unknownIds).toEqual(['openrouter/auto', 'b/meio']);
  });

  it('teto inválido/negativo é ignorado (não vira "nada passa" nem "tudo passa" em silêncio)', () => {
    expect(filterByMaxPrice(CATALOGO, { maxPromptPerMTok: -1 }).active).toBe(false);
    expect(filterByMaxPrice(CATALOGO, { maxPromptPerMTok: Infinity }).active).toBe(false);
    const zero = filterByMaxPrice(CATALOGO, { maxPromptPerMTok: 0 });
    expect(zero.active).toBe(true);
    expect(zero.models).toEqual([]); // nenhum modelo pago cabe em $0
  });
});

describe('IMPL-043 (1) — prévia de custo da SPA: variável não contamina o total', () => {
  /** As chamadas da prévia da Nova run (competidores, gabarito, juiz) — mesma forma do NewRun. */
  function previa(contestants: string[], catalogo: ReadonlyMap<string, PricedModel> | readonly PricedModel[]) {
    const pricer = createCostPreviewPricer(catalogo);
    let total = 0;
    for (const id of contestants) total += pricer.cost(id, 500, 1500);
    total += pricer.cost('a/medio', 500 + 600, 1500); // gabarito
    total += pricer.cost('a/medio', 500 + 1500 + 1500, 350) * contestants.length; // juiz pointwise
    return { total, unknown: pricer.unknownPriceIds(), unpriced: pricer.unpricedIds() };
  }

  it('roteador contribui 0 (NEUTRO): o total é o da parte precificável, nunca menor', () => {
    const base = previa(['a/barato'], CATALOGO);
    const comRoteador = previa(['a/barato', 'openrouter/auto'], CATALOGO);
    // A parte do juiz escala com o nº de competidores (é conhecida); a do
    // roteador em si fica fora. O bug antigo SUBTRAÍA 500 + 1500 tokens × 1.
    const juizExtra = 3500 * 1e-6 + 350 * 2e-6;
    expect(comRoteador.total).toBeCloseTo(base.total + juizExtra, 12);
    expect(comRoteador.total).toBeGreaterThan(base.total);
    expect(comRoteador.unknown).toEqual(['openrouter/auto']);
    expect(comRoteador.unpriced).toEqual([]);
  });

  it('só roteador: total 0 declarado incompleto (marcado), nunca negativo nem "grátis" calado', () => {
    const pricer = createCostPreviewPricer(CATALOGO);
    expect(pricer.cost('openrouter/auto', 500, 1500)).toBe(0);
    expect(pricer.unknownPriceIds()).toEqual(['openrouter/auto']);
    expect(unestimableCostNotice(pricer.unknownPriceIds(), pricer.unpricedIds())).not.toBeNull();
  });

  it('-1 numérico de cache/record antigo e fora do catálogo também são neutros e marcados', () => {
    const catalogo = new Map<string, PricedModel>([
      [LEGADO.id, LEGADO],
      ['a/medio', CATALOGO.find((m) => m.id === 'a/medio')!],
    ]);
    const r = previa([LEGADO.id, 'sumiu/do-catalogo'], catalogo);
    expect(r.total).toBeGreaterThan(0);
    expect(Number.isFinite(r.total)).toBe(true);
    expect(r.unknown).toEqual([LEGADO.id]);
    expect(r.unpriced).toEqual(['sumiu/do-catalogo']);
  });

  it('faixa de preço desconhecida só neutraliza a chamada que cai nela', () => {
    const faixa: PricedModel = {
      id: 'c/faixa',
      pricing: { prompt: 1e-6, completion: 1e-6, overrides: [{ minPromptTokens: 1000, prompt: null, completion: null }] },
    };
    const pricer = createCostPreviewPricer([faixa]);
    expect(pricer.cost('c/faixa', 500, 100)).toBeCloseTo(600e-6, 12);
    expect(pricer.unknownPriceIds()).toEqual([]);
    expect(pricer.cost('c/faixa', 5000, 100)).toBe(0);
    expect(pricer.unknownPriceIds()).toEqual(['c/faixa']);
  });
});

describe('IMPL-043 × IMPL-020 — estimativa de lançamento (rodapé + portão de confirmação)', () => {
  const cfg = {
    mode: 'compare',
    theme: 't',
    stages: 2,
    datagenModelId: 'a/barato',
    judgeModelIds: ['a/medio'],
    referenceModelId: 'a/medio',
    referenceJudging: true,
    competitorModelIds: ['a/barato', 'openrouter/auto'],
  };

  it('preço variável fica NEUTRO na faixa, é listado e pede confirmação (custo que não dá para limitar)', () => {
    const est = estimateLaunchCost(cfg as never, CATALOGO);
    expect(est.unknownPriceModelIds).toEqual(['openrouter/auto']);
    expect(est.unpricedModelIds).toEqual([]);
    expect(est.low).toBeGreaterThanOrEqual(0);
    expect(est.high).toBeLessThan(COST_CONFIRM_THRESHOLD_USD);
    expect(est.requiresConfirmation).toBe(true);
    expect(unestimableCostNotice(est.unknownPriceModelIds, est.unpricedModelIds)).toMatch(/openrouter\/auto/);
  });

  it('só modelos precificados e barato: sem aviso e sem confirmação', () => {
    const est = estimateLaunchCost({ ...cfg, competitorModelIds: ['a/barato', 'a/medio'] } as never, CATALOGO);
    expect(est.unknownPriceModelIds).toEqual([]);
    expect(est.requiresConfirmation).toBe(false);
  });
});

describe('IMPL-043 (3) — contagem "X de Y" e aviso "custo não estimável"', () => {
  it('contagem reflete o variável EXCLUÍDO por default', () => {
    const r = filterByMaxPrice(CATALOGO, { maxPromptPerMTok: 1, maxCompletionPerMTok: 2 });
    expect(describeMaxPriceFilter(r)).toBe(
      `Mostrando 2 de 5 modelos · 1 acima do teto · 2 de preço ${UNKNOWN_PRICE_LABEL} fora do filtro (não dá para garantir o teto)`,
    );
  });

  it('contagem reflete o variável INCLUÍDO por escolha explícita (com o aviso de custo)', () => {
    const r = filterByMaxPrice(CATALOGO, { maxPromptPerMTok: 1_000_000, includeUnknown: true });
    const txt = describeMaxPriceFilter(r)!;
    expect(txt).toBe(
      `Mostrando 5 de 5 modelos · 1 de preço ${UNKNOWN_PRICE_LABEL} incluído por escolha sua (${UNESTIMABLE_COST_LABEL}; o teto não é garantido)`,
    );
  });

  it('sem teto não há contagem de filtro; sem variável a contagem não o menciona', () => {
    expect(describeMaxPriceFilter(filterByMaxPrice(CATALOGO, {}))).toBeNull();
    const semVariavel = filterByMaxPrice(CATALOGO.slice(0, 3), { maxPromptPerMTok: 1_000_000 });
    expect(describeMaxPriceFilter(semVariavel)).toBe('Mostrando 3 de 3 modelos');
  });

  it('aviso: singular "para este modelo", plural, motivo de cada um; null quando tudo tem preço', () => {
    expect(unestimableCostNotice([], [])).toBeNull();
    expect(unestimableCostNotice(['openrouter/auto'])).toBe(
      `Custo não estimável para este modelo: openrouter/auto (preço ${UNKNOWN_PRICE_LABEL}) — fica fora da soma; o custo real será maior.`,
    );
    const plural = unestimableCostNotice(['openrouter/auto', 'openrouter/fusion'], ['sumiu/do-catalogo'])!;
    expect(plural).toContain('Custo não estimável para estes modelos');
    expect(plural).toContain('openrouter/auto, openrouter/fusion (preço variável)');
    expect(plural).toContain('sumiu/do-catalogo (fora do catálogo)');
  });

  it('nota por modelo (chip/lista do seletor) só existe para preço desconhecido', () => {
    const router = CATALOGO.find((m) => m.id === 'openrouter/auto')!;
    expect(unknownPriceNote(router)).toContain(`${UNESTIMABLE_COST_LABEL} para este modelo`);
    expect(unknownPriceNote(LEGADO)).not.toBeNull();
    expect(unknownPriceNote(CATALOGO.find((m) => m.id === 'a/barato')!)).toBeNull();
    expect(unknownPriceNote(undefined)).toBeNull();
  });
});

describe('IMPL-043 — paridade no CLI: `models list` com teto (gateway falso, sem rede)', () => {
  const CRU = [
    catalogItem('a/barato', 1e-7, 4e-7),
    catalogItem('a/caro', 5e-6, 2e-5),
    routerItem('openrouter/auto'),
  ];
  let dir: string;
  let prevDataDir: string;
  let restore: ReturnType<typeof setDefaultGateway> | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pb-impl043-'));
    prevDataDir = getDataDir();
    restore = setDefaultGateway(createGateway({ fetch: fakeOpenRouter({ catalog: CRU }).fetch, sleep: noSleep }));
  });
  afterEach(() => {
    if (restore) setDefaultGateway(restore);
    setDataDir(prevDataDir);
    rmSync(dir, { recursive: true, force: true });
  });

  async function rodar(extra: string[]): Promise<{ code: number; ids: string[]; stderr: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const s1 = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => (out.push(String(c)), true));
    const s2 = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => (err.push(String(c)), true));
    let code: number;
    try {
      code = await cmdModels(['list', '--format', 'ids', '--key', KEY, '--data-dir', dir, ...extra]);
    } finally {
      s1.mockRestore();
      s2.mockRestore();
    }
    return { code, ids: out.join('').trim().split('\n').filter(Boolean), stderr: err.join('') };
  }

  it('teto exclui o variável por default e o stderr conta "X de Y" + como incluí-lo', async () => {
    const r = await rodar(['--max-prompt-price', '1000000']);
    expect(r.code).toBe(0);
    expect(r.ids).toEqual(['a/barato', 'a/caro']);
    expect(r.stderr).toContain(
      'teto de preço: 1 de preço variável fora do filtro (não dá para garantir o teto) — use --include-variable-price',
    );
    expect(r.stderr).toContain('2 de 3 modelos.');
  });

  it('--include-variable-price é a decisão explícita: o roteador volta, o caro acima do teto não', async () => {
    const r = await rodar(['--max-prompt-price', '1', '--include-variable-price']);
    expect(r.ids).toEqual(['a/barato', 'openrouter/auto']);
    expect(r.stderr).toContain('teto de preço: 1 acima do teto · 1 de preço variável incluído por escolha sua');
    expect(r.stderr).not.toContain('use --include-variable-price');
    expect(r.stderr).toContain('2 de 3 modelos.');
  });

  it('teto negativo é erro de uso (exit 2), não um filtro que some em silêncio', async () => {
    await expect(rodar(['--max-prompt-price=-1'])).rejects.toMatchObject({
      code: 2,
      message: '--max-prompt-price deve ser >= 0.',
    });
  });
});

// ---------------------------------------------------------------------------
// (2) A UI nunca renderiza número negativo para preço.
// ---------------------------------------------------------------------------

/** Textos VISÍVEIS/lidos por leitor de tela: nós de texto e atributos title/aria-label (sem SVG). */
function textosDaUi(html: string): string[] {
  const semSvg = html.replace(/<svg[\s\S]*?<\/svg>/g, '');
  const out: string[] = [];
  for (const m of semSvg.matchAll(/>([^<]+)</g)) out.push(m[1]);
  for (const m of semSvg.matchAll(/\s(?:title|aria-label)="([^"]*)"/g)) out.push(m[1]);
  return out.map((t) => t.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
}

/** Número negativo em texto de preço: "-1", "$-1000000.00", "- 3", "−1" (sinal unicode). */
const NEGATIVO = /(^|[^\w/.])[-−]\s*\$?\d|\$\s*[-−]/;

describe('IMPL-043 (2) — UI nunca mostra preço negativo', () => {
  it('fuzz: nenhum valor cru de preço gera texto de UI com número negativo', () => {
    const crus: unknown[] = ['-1', -1, '-0.000001', -0.5, 'abc', '', null, undefined, 'NaN', 'Infinity', '0', '7e-7'];
    for (const p of crus) {
      for (const c of crus) {
        const [m] = parseModelsPayload({
          data: [{ id: 'f/uzz', name: 'f', pricing: { prompt: p, completion: c }, supported_parameters: [] }],
        });
        // Também o regime antigo: o número cru direto no modelo (cache/record velho).
        const velho: PricedModel = {
          id: 'v/elho',
          pricing: { prompt: typeof p === 'number' ? p : null, completion: typeof c === 'number' ? c : null },
        };
        for (const modelo of [m, velho]) {
          const pricer = createCostPreviewPricer([modelo]);
          const custo = pricer.cost(modelo.id, 500, 1500);
          expect(Number.isFinite(custo) && custo >= 0, `${String(p)}/${String(c)} => ${custo}`).toBe(true);
          const textos = [
            formatPricingLabel(modelo.pricing),
            unknownPriceNote(modelo) ?? '',
            describeMaxPriceFilter(filterByMaxPrice([modelo], { maxPromptPerMTok: 1, maxCompletionPerMTok: 1 })) ?? '',
            describeMaxPriceFilter(
              filterByMaxPrice([modelo], { maxPromptPerMTok: 1, maxCompletionPerMTok: 1, includeUnknown: true }),
            ) ?? '',
            unestimableCostNotice(pricer.unknownPriceIds(), pricer.unpricedIds()) ?? '',
          ];
          for (const t of textos) expect(NEGATIVO.test(t), `${String(p)}/${String(c)}: "${t}"`).toBe(false);
        }
      }
    }
  });

  it('guarda estrutural: a UI não faz aritmética crua com preço (tudo passa por src/engine/pricing.ts)', () => {
    const webSrc = join(ROOT, 'web', 'src');
    const arquivos: string[] = [];
    const walk = (dir: string): void => {
      for (const nome of readdirSync(dir)) {
        const p = join(dir, nome);
        if (statSync(p).isDirectory()) {
          // Peças do CLI do shadcn/Motion UI não tocam preço (e não são nossas).
          if (nome === 'ui' || nome === 'motion-ui') continue;
          walk(p);
        } else if (/\.(ts|tsx)$/.test(nome)) {
          arquivos.push(p);
        }
      }
    };
    walk(webSrc);
    // `pricing.prompt * …`, `… * m.pricing.completion`, `pricing.prompt.toFixed`: o
    // formato do bug (preço cru multiplicado/formatado — o -1 virava -1000000).
    const CRU = /pricing\??\.(prompt|completion)\s*(\*|\/|\.toFixed|\.toLocaleString)|[*/]\s*[\w.?]*pricing\??\.(prompt|completion)/;
    const ofensores = arquivos.filter((f) => CRU.test(readFileSync(f, 'utf8'))).map((f) => f.slice(ROOT.length));
    expect(ofensores).toEqual([]);

    // A tela usa OS helpers testados acima (não uma cópia local da regra).
    const newRun = readFileSync(join(webSrc, 'pages', 'NewRun.tsx'), 'utf8');
    expect(newRun).toMatch(/filterByMaxPrice\(/);
    expect(newRun).toMatch(/describeMaxPriceFilter\(/);
    // A prévia de custo do rodapé é a MESMA conta do diálogo de confirmação e
    // das portas do motor (IMPL-020: `estimateConfigCost` → src/estimate.ts →
    // src/engine/pricing.ts); preço variável fica neutro e vira o aviso abaixo.
    expect(newRun).toMatch(/estimateConfigCost\(/);
    expect(newRun).toMatch(/unknownPriceModelIds/);
    expect(newRun).toMatch(/unestimableCostNotice\(/);
    expect(newRun).toMatch(/includeUnknown:\s*includeUnknownPrice/);
    // Default da escolha explícita: DESLIGADO (variável fora do teto).
    expect(newRun).toMatch(/const \[includeUnknownPrice, setIncludeUnknownPrice\] = useState\(false\)/);
    const selector = readFileSync(join(webSrc, 'components', 'ModelSelector.tsx'), 'utf8');
    expect(selector).toMatch(/formatPricingLabel\(/);
    expect(selector).toMatch(/unknownPriceNote\(/);
  });
});

// Render REAL do ModelSelector (react-dom/server, sem navegador). As peças do
// shadcn/Motion UI e o Modal (portal em document.body) viram stubs: o que se
// testa é o texto de preço que o seletor produz. As dependências do web/ exigem
// MOTION_TOKEN (`npm run setup`); sem elas este bloco é pulado — o CI do
// catálogo instala só a raiz.
const WEB_REACT = join(ROOT, 'web', 'node_modules', 'react', 'index.js');
const WEB_REACT_DOM_SERVER = join(ROOT, 'web', 'node_modules', 'react-dom', 'server.node.js');
const temWebDeps = existsSync(WEB_REACT) && existsSync(WEB_REACT_DOM_SERVER);

vi.mock('@/components/motion-ui/ui-theme', () => ({
  useMotionUITransition: () => ({}),
  useMotionUITheme: () => ({}),
}));
// primitives.tsx (importado pelo ModelSelector) usa StaggerReveal no PageHeader;
// sem o stub o specifier `@/…` não resolve fora do Vite do web/ — mesma receita
// de test/ux-keygate-help.test.ts.
vi.mock('@/components/motion-ui/stagger-reveal', () => ({
  StaggerReveal: (p: { children?: unknown }) => p.children,
  StaggerRevealHeadline: (p: { children?: unknown }) => p.children,
  StaggerRevealItem: (p: { children?: unknown }) => p.children,
}));
vi.mock('@/components/motion-ui/overlay', () => ({
  Backdrop: () => null,
  useFocusTrap: () => undefined,
  useScrollLock: () => undefined,
}));
vi.mock('@/components/ui/button', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return { Button: (p: { children?: unknown }) => createElement('button', null, p.children) };
});
vi.mock('@/components/ui/input', () => ({ Input: () => null }));
vi.mock('@/lib/utils', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }));
// O Modal real usa createPortal(document.body): aqui ele só devolve o conteúdo,
// para a LISTA do catálogo (com os rótulos de preço) entrar no HTML.
vi.mock('../web/src/components/Modal', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return { Modal: (p: { children?: unknown }) => createElement('div', { 'data-modal': '' }, p.children) };
});

describe.skipIf(!temWebDeps)('IMPL-043 (2) — render do ModelSelector com roteadores', () => {
  it('chip e lista mostram "variável" + aviso de custo, e nenhum texto de preço negativo', async () => {
    const { createElement } = await import(pathToFileURL(WEB_REACT).href);
    const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
    const { ModelSelector } = await import('../web/src/components/ModelSelector');
    const models = [
      ...CATALOGO, // roteador "-1" parseado (null) + b/meio (saída desconhecida)
      { id: 'openrouter/legado', name: 'legado', pricing: { prompt: -1, completion: -1 } }, // cache velho
      { id: 'openrouter/estranho', name: 'estranho', pricing: { prompt: -0.5, completion: NaN } },
    ];
    const html: string = renderToStaticMarkup(
      createElement(ModelSelector, {
        multi: true,
        value: ['openrouter/auto', 'a/barato'],
        onChange: () => undefined,
        title: 'Participantes',
        models,
        loading: false,
      }),
    );
    const textos = textosDaUi(html);
    // Chip selecionado do roteador: selo textual + aviso no title.
    expect(textos).toContain(UNKNOWN_PRICE_LABEL);
    expect(textos.some((t) => t.startsWith('openrouter/auto — preço variável') && t.includes(UNESTIMABLE_COST_LABEL))).toBe(true);
    // Lista do catálogo: roteadores (inclusive o -1 NUMÉRICO do cache velho) como "preço variável".
    expect(textos.filter((t) => t === `preço ${UNKNOWN_PRICE_LABEL}`).length).toBeGreaterThanOrEqual(2);
    expect(textos).toContain('in $0.50 / out variável /1M'); // b/meio: só a saída desconhecida
    expect(textos).toContain('in $5.00 / out $20.00 /1M'); // preço conhecido segue igual
    // Nenhum texto/título com preço negativo ("-1", "$-1000000.00", …).
    const negativos = textos.filter((t) => NEGATIVO.test(t));
    expect(negativos).toEqual([]);
    expect(html).not.toContain('$-');
    expect(html).not.toContain('-1000000');
  });
});
