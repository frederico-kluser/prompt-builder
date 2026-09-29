// Onda 2 — telas de run (cluster web-views-a). Render REAL com
// react-dom/server (mesma receita de test/ux-heatmap-a11y.test.ts), sem
// navegador e sem rede:
//
//  web-code#12  heatRows conta pela MESMA regra do judge-score oficial
//               (`judgeScoreTally`/`stageCountsInJudgeScore`);
//  web-code#10  o resumo nomeia o vencedor pela régua única (`winnerFromStandings`
//  web-live#4   — a do `runs winner`): final > judge-score; empate é dito, nunca
//               coroado pela ordem de cadastro; troféu só no vencedor;
//  web-live#3   a barra do placar vai num wrapper `w-24` (o `w-full` da raiz do
//               ProgressBar vencia e o nome colapsava a 0 px);
//  web-code#11  total de cenários = slots EXECUTADOS, não `config.stages`;
//  web-code#4   o placar de evolução liga as rodadas pela TÉCNICA, não pelo id
//               posicional (`v0` de uma rodada ≠ `v0` da outra);
//  web-live#16  status em PT-BR, "interrompida" ≠ "erro", metadados com unidade;
//  web-code#7   confirmação de custo com motivo 'unknown' (preço variável);
//  IMPL-057     concordância do painel, 'avaliador falhou', falhas agrupadas e
//               a linha de auditoria do contrato;
//  IMPL-112     saturação por item + fila de revisão humana do gabarito.

import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { accessibleText, allText, innersOf, openTagsOf } from './uxHtml';
import { judgeScoreTally } from '../src/engine/verdictAggregate.js';
import { costConfirmationReason, requiresCostConfirmation } from '../src/engine/costConfirmation.js';
import { itemSaturationReport } from '../src/datagen.js';

const ROOT = process.cwd();
const WEB_REACT = join(ROOT, 'web', 'node_modules', 'react', 'index.js');
const WEB_REACT_DOM_SERVER = join(ROOT, 'web', 'node_modules', 'react-dom', 'server.node.js');
const temWebDeps = existsSync(WEB_REACT) && existsSync(WEB_REACT_DOM_SERVER);

/** React do web/ (o MESMO que os componentes importam). */
async function webReact(): Promise<typeof import('react')> {
  const { join: j } = await import('node:path');
  const { pathToFileURL: u } = await import('node:url');
  return import(u(j(process.cwd(), 'web', 'node_modules', 'react', 'index.js')).href);
}

vi.mock('@/components/motion-ui/accordion', () => ({
  Accordion: (p: { children?: unknown }) => p.children,
  AccordionItem: (p: { children?: unknown }) => p.children,
  AccordionTrigger: (p: { children?: unknown }) => p.children,
  AccordionPanel: (p: { children?: unknown }) => p.children,
}));
// ProgressBar que reproduz a raiz real (`flex w-full … ${className}`) — é o
// que o web-live#3 media no navegador.
vi.mock('@/components/motion-ui/progress-bar', async () => {
  const React = await webReact();
  return {
    ProgressBar: (p: { className?: string; 'aria-label'?: string }) =>
      React.createElement('div', {
        'data-progress': p['aria-label'] ?? '',
        className: `flex w-full flex-col gap-2 ${p.className ?? ''}`,
      }),
  };
});
vi.mock('@/components/motion-ui/segmented-toggle', async () => {
  const React = await webReact();
  return {
    SegmentedToggle: (p: { children?: unknown; ariaLabel?: string }) =>
      React.createElement('div', { role: 'group', 'aria-label': p.ariaLabel }, p.children as never),
    SegmentedToggleOption: (p: { children?: unknown; value: string }) =>
      React.createElement('button', { type: 'button', 'data-value': p.value }, p.children as never),
  };
});
vi.mock('@/components/motion-ui/sparkline', async () => {
  const real = await import(
    pathToFileURL(join(ROOT, 'web', 'src', 'components', 'motion-ui', 'sparkline', 'index.tsx')).href
  );
  return real;
});
vi.mock('@/components/motion-ui/ui-theme', () => ({
  useMotionUITransition: () => ({}),
  useMotionUITheme: () => ({ motionMode: 'off' }),
}));
vi.mock('@/components/motion-ui/stagger-reveal', () => ({
  StaggerReveal: (p: { children?: unknown }) => p.children,
  StaggerRevealHeadline: (p: { children?: unknown }) => p.children,
  StaggerRevealItem: (p: { children?: unknown }) => p.children,
}));
vi.mock('@/components/ui/button', async () => {
  const React = await webReact();
  return {
    Button: (p: { children?: unknown; onClick?: () => void }) =>
      React.createElement('button', { type: 'button' }, p.children as never),
  };
});
// Modal real usa portal + foco: aqui só o conteúdo quando aberto.
vi.mock('../web/src/components/Modal', () => ({
  Modal: (p: { open: boolean; children?: unknown }) => (p.open ? p.children : null),
}));
vi.mock('@/lib/utils', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }));
// RunsList: só os helpers puros são exercitados — as peças visuais viram nada.
vi.mock('@/components/motion-ui/skeleton', () => ({
  Skeleton: () => null,
  SkeletonResolveList: () => null,
  SkeletonResolveRow: () => null,
}));
vi.mock('@/components/ui/input', () => ({ Input: () => null }));

type AnyRec = Record<string, any>;

async function render(el: (React: typeof import('react')) => unknown): Promise<string> {
  const React = await webReact();
  const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
  return renderToStaticMarkup(el(React) as never);
}

/** Etapa julgada POR REFERÊNCIA (o `judge` sintetizado espelha os vereditos). */
function refStage(index: number, verdicts: Record<string, 'resolve' | 'parcial' | 'nao'>, extra: AnyRec = {}): AnyRec {
  return {
    index,
    spec: { question: `Pergunta ${index + 1}?`, productContext: 'ctx', maxTokens: 100, reference: 'ref' },
    responses: [],
    referenceJudge: { verdictByContestant: verdicts, explanationByContestant: {}, judgeModelId: 'j/1', ...extra },
    judge: { verdictByContestant: verdicts, rankedContestantIds: [], acceptableByContestant: {}, judges: [], blindMap: {}, rawJudgeText: '' },
  };
}

/** Etapa julgada só LISTWISE (gabarito falhou/foi cortado). */
function listwiseStage(index: number, verdicts: Record<string, 'resolve' | 'parcial' | 'nao'>): AnyRec {
  return {
    index,
    spec: { question: `Pergunta ${index + 1}?`, productContext: 'ctx', maxTokens: 100 },
    responses: [],
    judge: { verdictByContestant: verdicts, rankedContestantIds: [], acceptableByContestant: {}, judges: [], blindMap: {}, rawJudgeText: '' },
  };
}

// ---------------------------------------------------------------------------

describe.skipIf(!temWebDeps)('web-code#12 — heatRows pela regra única do judge-score', () => {
  it('etapa listwise numa run por referência fica FORA da contagem e da nota (a célula continua visível)', async () => {
    const { heatRows, heatmapCellState } = await import('../web/src/pages/runShared');
    const record: AnyRec = {
      id: 'r-js',
      status: 'finished',
      mode: 'compare',
      config: { stages: 3 },
      contestants: [
        { id: 'a', label: 'Alpha', modelId: 'x/a' },
        { id: 'b', label: 'Beta', modelId: 'x/b' },
      ],
      stages: [
        refStage(0, { a: 'resolve', b: 'nao' }),
        refStage(1, { a: 'parcial', b: 'nao' }),
        // Gabarito falhou: o listwise dá a vitória a Beta — NÃO entra no score.
        listwiseStage(2, { a: 'nao', b: 'resolve' }),
      ],
      judgeScoreByContestant: { a: 75, b: 0 },
    };
    const { rows, stages } = heatRows(record as never);
    const a = rows.find((r) => r.contestantId === 'a')!;
    const b = rows.find((r) => r.contestantId === 'b')!;
    for (const r of [a, b]) {
      const t = judgeScoreTally(stages as never, r.contestantId);
      expect({ resolve: r.resolve, parcial: r.parcial, nao: r.nao, judged: r.judged }).toEqual(t);
    }
    expect(a).toMatchObject({ resolve: 1, parcial: 1, nao: 0, judged: 2, score: 75 });
    expect(b).toMatchObject({ resolve: 0, nao: 2, judged: 2, score: 0 });
    // A célula listwise continua lá, com o aviso de que não conta.
    expect(b.verdicts[2]).toBe('resolve');
    const cel = heatmapCellState(stages[2] as never, b, 2, { referenceRun: true });
    expect(cel.label).toContain('fora do score');
  });

  it('ao vivo (recarregou no meio da run): etapa por referência só com o `judge` sintetizado CONTA', async () => {
    const { heatRows, heatmapCellState, stageInJudgeScore } = await import('../web/src/pages/runShared');
    // Snapshot trouxe a etapa 0 inteira; a etapa 1 chegou depois pelo
    // `stage.judged` (só o `judge` sintetizado, com gabarito na spec); a 2 é
    // listwise de verdade (sem gabarito) — continua fora.
    const { referenceJudge: _omitido, ...soSintetizado } = refStage(1, { a: 'resolve', b: 'nao' });
    const base: AnyRec = {
      id: 'r-live',
      mode: 'compare',
      config: { stages: 3 },
      contestants: [
        { id: 'a', label: 'Alpha', modelId: 'x/a' },
        { id: 'b', label: 'Beta', modelId: 'x/b' },
      ],
      stages: [refStage(0, { a: 'resolve', b: 'nao' }), soSintetizado, listwiseStage(2, { a: 'nao', b: 'resolve' })],
    };
    const vivo = heatRows({ ...base, status: 'running' } as never);
    expect(vivo.rows[0]).toMatchObject({ resolve: 2, nao: 0, judged: 2, score: 100 });
    expect(vivo.rows[1]).toMatchObject({ resolve: 0, nao: 2, judged: 2, score: 0 });
    expect(stageInJudgeScore(vivo.stages[1] as never, true)).toBe(true);
    const cel = heatmapCellState(vivo.stages[1] as never, vivo.rows[0], 1, { referenceRun: true, live: true });
    expect(cel.label).not.toContain('fora do score');
    const celLw = heatmapCellState(vivo.stages[2] as never, vivo.rows[1], 2, { referenceRun: true, live: true });
    expect(celLw.label).toContain('fora do score');
    // Record GRAVADO (terminal): exatamente a regra do motor — sem referenceJudge não conta.
    const fim = heatRows({ ...base, status: 'finished' } as never);
    expect(fim.rows[0]).toMatchObject({ resolve: 1, judged: 1 });
    expect(stageInJudgeScore(fim.stages[1] as never)).toBe(false);
  });

  it('run SÓ listwise (sem gabarito nenhum) continua contando o que há', async () => {
    const { heatRows } = await import('../web/src/pages/runShared');
    const record: AnyRec = {
      id: 'r-lw',
      status: 'finished',
      mode: 'compare',
      config: { stages: 2 },
      contestants: [{ id: 'a', label: 'Alpha', modelId: 'x/a' }],
      stages: [listwiseStage(0, { a: 'resolve' }), listwiseStage(1, { a: 'nao' })],
    };
    const [a] = heatRows(record as never).rows;
    expect(a).toMatchObject({ resolve: 1, nao: 1, judged: 2, score: 50 });
  });
});

// ---------------------------------------------------------------------------

function variationRecord(over: AnyRec = {}): AnyRec {
  return {
    id: 'r-var',
    status: 'finished',
    mode: 'variation',
    config: { stages: 4, theme: 't' },
    totalCostUsd: 0.01,
    contestants: [
      { id: 'original', label: 'Original (controle)', modelId: 'm', isOriginal: true, systemPrompt: 'base' },
      { id: 'v0', label: 'Cadeia de raciocínio', modelId: 'm', techniqueId: 'cot', systemPrompt: 'cot' },
      { id: 'v1', label: 'Formato de saída explícito', modelId: 'm', techniqueId: 'format', systemPrompt: 'fmt' },
    ],
    stages: [
      refStage(0, { original: 'nao', v0: 'resolve', v1: 'parcial' }),
      refStage(1, { original: 'nao', v0: 'resolve', v1: 'parcial' }),
    ],
    judgeScoreByContestant: { original: 0, v0: 100, v1: 50 },
    finalists: ['v0', 'v1', 'original'],
    ...over,
  };
}

describe.skipIf(!temWebDeps)('web-code#10 / web-live#4 — vencedor pela régua única', () => {
  it('com finais, o duelo decide — e a discordância com o placar de vereditos é dita', async () => {
    const { RunNarrative } = await import('../web/src/components/RunNarrative');
    const record = variationRecord({
      standings: [
        { id: 'v1', label: 'Formato de saída explícito', isControl: false, wins: 12, ties: 0, losses: 0, winRate: 1 },
        { id: 'v0', label: 'Cadeia de raciocínio', isControl: false, wins: 6, ties: 0, losses: 6, winRate: 0.5 },
        { id: 'original', label: 'Original (controle)', isControl: true, wins: 0, ties: 0, losses: 12, winRate: 0 },
      ],
    });
    const html = await render((R) => R.createElement(RunNarrative, { record: record as never, duelProgress: null }));
    const texto = allText(html);
    expect(texto).toContain('A melhor variação foi Formato de saída explícito: venceu o duelo final');
    expect(texto).toContain('as réguas discordam');
    expect(texto).not.toContain('A melhor variação foi Cadeia');
    // Troféu ('melhor prompt') SÓ na linha do vencedor do duelo.
    const itens = innersOf(html, 'li').filter((li) => li.includes('data-progress'));
    const comTrofeu = itens.filter((li) => allText(li).includes('melhor prompt'));
    expect(comTrofeu).toHaveLength(1);
    expect(allText(comTrofeu[0])).toContain('Formato');
  });

  it('compare com todos em 0: ninguém é "o melhor modelo" e ninguém ganha troféu', async () => {
    const { RunNarrative } = await import('../web/src/components/RunNarrative');
    const record: AnyRec = {
      id: 'r-zero',
      status: 'finished',
      mode: 'compare',
      config: { stages: 2, theme: 't' },
      totalCostUsd: 0,
      contestants: [
        { id: 'deepseek/x', label: 'deepseek/x', modelId: 'deepseek/x' },
        { id: 'z-ai/glm', label: 'z-ai/glm', modelId: 'z-ai/glm' },
      ],
      stages: [refStage(0, { 'deepseek/x': 'nao', 'z-ai/glm': 'nao' }), refStage(1, { 'deepseek/x': 'nao', 'z-ai/glm': 'nao' })],
      judgeScoreByContestant: { 'deepseek/x': 0, 'z-ai/glm': 0 },
    };
    const html = await render((R) => R.createElement(RunNarrative, { record: record as never, duelProgress: null }));
    const texto = allText(html);
    expect(texto).toContain('Nenhum modelo se destacou');
    expect(texto).not.toContain('O melhor modelo foi');
    expect(texto).not.toContain('margem de 0');
    expect(texto).not.toMatch(/vencedor|à frente/);
    expect(texto).toContain('empatado com');
  });

  it('empate no judge-score sem finais: o controle (1º do array) NÃO é coroado', async () => {
    const { RunNarrative } = await import('../web/src/components/RunNarrative');
    const record = variationRecord({
      judgeScoreByContestant: { original: 100, v0: 100, v1: 50 },
      stages: [
        refStage(0, { original: 'resolve', v0: 'resolve', v1: 'parcial' }),
        refStage(1, { original: 'resolve', v0: 'resolve', v1: 'parcial' }),
      ],
      finalists: undefined,
    });
    const html = await render((R) => R.createElement(RunNarrative, { record: record as never, duelProgress: null }));
    const texto = allText(html);
    expect(texto).toMatch(/Empate entre (Original \(controle\) e Cadeia de raciocínio|Cadeia de raciocínio e Original \(controle\))/);
    expect(texto).not.toContain('A melhor variação foi');
    expect(texto).not.toContain('melhor prompt');
  });

  it('web-live#3: a barra do placar tem largura num WRAPPER, não no nó com w-full', async () => {
    const { RunNarrative } = await import('../web/src/components/RunNarrative');
    const html = await render((R) =>
      R.createElement(RunNarrative, { record: variationRecord() as never, duelProgress: null }),
    );
    const barras = openTagsOf(html, 'div').filter((t) => t.includes('data-progress="Nota de'));
    expect(barras.length).toBe(3);
    for (const b of barras) expect(b).not.toContain('w-24');
    expect(html).toMatch(/<div class="w-24 shrink-0"><div data-progress="Nota de/);
  });

  it('runWinner = winnerFromStandings (a régua do `runs winner`) e rodada de treino usa o judge-score', async () => {
    const { runWinner } = await import('../web/src/pages/runShared');
    const { winnerFromStandings } = await import('../src/engine/duelCore.js');
    const record = variationRecord({
      standings: [
        { id: 'v1', label: 'F', isControl: false, wins: 3, ties: 0, losses: 0, winRate: 1 },
        { id: 'v0', label: 'C', isControl: false, wins: 0, ties: 0, losses: 3, winRate: 0 },
      ],
    });
    const w = runWinner(record as never);
    expect(w.contestantId).toBe(winnerFromStandings(record as never).contestantId);
    expect(w.contestantId).toBe('v1');
    const treino = runWinner({ ...record, sessionId: 's1', iteration: 1 } as never);
    expect(treino).toMatchObject({ training: true, ruler: 'judge-score', contestantId: 'v0' });
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(!temWebDeps)('web-code#11 — cenários EXECUTADOS, não config.stages', () => {
  it('rodada pinada (10 de 20): a narrativa não fica presa em "A gerar cenários"', async () => {
    const { pipelinePhases, statusLine, executedStageCount } = await import('../web/src/components/RunNarrative');
    const stages = Array.from({ length: 10 }, (_, i) => refStage(i, { original: 'resolve', v0: 'nao' }));
    const record: AnyRec = {
      id: 'r-it',
      status: 'running',
      mode: 'variation',
      config: { stages: 20 },
      contestants: [
        { id: 'original', label: 'O', modelId: 'm', isOriginal: true },
        { id: 'v0', label: 'V', modelId: 'm', techniqueId: 'cot' },
      ],
      stages: stages.map((s) => ({
        ...s,
        responses: [
          { contestantId: 'original', status: 'ok' },
          { contestantId: 'v0', status: 'ok' },
        ],
      })),
      finalists: ['original', 'v0'],
    };
    expect(executedStageCount(record as never)).toBe(10);
    const fases = pipelinePhases(record as never, { done: 3, total: 20 });
    expect(fases.map((f) => [f.label, f.done, f.total])).toEqual([
      ['Cenários', 10, 10],
      ['Respostas', 20, 20],
      ['Julgamento', 10, 10],
      ['Duelo final', 3, 20],
    ]);
    expect(statusLine(record as never, fases)).toBe('No duelo final (3 de 20 duelos)…');
  });

  it('compare com repeats (5 × 3): o total é 15, nunca "15/5"', async () => {
    const { executedStageCount } = await import('../web/src/components/RunNarrative');
    const record: AnyRec = { config: { stages: 5, repeats: 3 }, stages: Array.from({ length: 15 }, (_, i) => ({ index: i, responses: [] })) };
    expect(executedStageCount(record as never)).toBe(15);
    // Antes dos slots chegarem, o planejado.
    expect(executedStageCount({ config: { stages: 5 }, stages: [] } as never)).toBe(5);
  });

  it('etapa pulada (falha no datagen) não deixa as fases abertas', async () => {
    const { pipelinePhases } = await import('../web/src/components/RunNarrative');
    const record: AnyRec = {
      id: 'r-skip',
      status: 'running',
      mode: 'compare',
      config: { stages: 3 },
      contestants: [{ id: 'a', label: 'A', modelId: 'a' }],
      stages: [
        { ...refStage(0, { a: 'resolve' }), responses: [{ contestantId: 'a', status: 'ok' }] },
        { ...refStage(1, { a: 'nao' }), responses: [{ contestantId: 'a', status: 'ok' }] },
        { index: 2, responses: [], error: 'datagen falhou' },
      ],
    };
    const fases = pipelinePhases(record as never, null);
    for (const f of fases.slice(0, 3)) expect(f.done).toBe(f.total);
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(!temWebDeps)('web-code#4 — placar de evolução ligado pela técnica', () => {
  it('v0 de rodadas diferentes (técnicas diferentes) NÃO vira uma linha só', async () => {
    const { EvolutionHeatmap, evolutionRowKey } = await import('../web/src/pages/runShared');
    const rounds: AnyRec[] = [
      {
        id: 'r0',
        iteration: 0,
        stages: [],
        contestants: [
          { id: 'original', label: 'Original (controle)', isOriginal: true },
          { id: 'v0', label: 'Cadeia', techniqueId: 'cot' },
          { id: 'v1', label: 'Formato', techniqueId: 'format' },
        ],
        judgeScoreByContestant: { original: 40, v0: 70, v1: 55 },
      },
      {
        id: 'r1',
        iteration: 1,
        stages: [],
        contestants: [
          { id: 'carry', label: 'Melhor it.1' },
          // A lista de técnicas rodou: agora v0 é Formato, v1 é Papel.
          { id: 'v0', label: 'Formato', techniqueId: 'format' },
          { id: 'v1', label: 'Papel', techniqueId: 'role' },
        ],
        judgeScoreByContestant: { carry: 72, v0: 80, v1: 30 },
      },
      {
        id: 'r2',
        iteration: 2,
        stages: [],
        contestants: [
          { id: 'carry', label: 'Melhor it.2' },
          { id: 'v0', label: 'Papel', techniqueId: 'role' },
        ],
        judgeScoreByContestant: { carry: 81, v0: 35 },
      },
    ];
    expect(evolutionRowKey({ id: 'v0', techniqueId: 'cot' })).toBe('t:cot');
    expect(evolutionRowKey({ id: 'carry' })).toBe('carry');
    const html = await render((R) => R.createElement(EvolutionHeatmap, { rounds: rounds as never }));
    const linhas = openTagsOf(html, 'th').filter((t) => t.includes('scope="row"'));
    // original, Cadeia, Formato, carry, Papel — 5 linhas (antes: v0, v1, original, carry = 4 misturadas).
    expect(linhas).toHaveLength(5);
    const trs = innersOf(html, 'tr');
    const formato = trs.find((tr) => /<th scope="row"[^>]*>[\s\S]*Formato/.test(tr))!;
    // Formato: 55 na R1 e 80 na R2 — a nota DELE, não a de "v0".
    expect(accessibleText(formato)).toMatch(/55 80/);
    expect(formato).toContain('aria-label="Nota da técnica Formato por rodada: subiu de 55 para 80 em 2 rodadas"');
    const cadeia = trs.find((tr) => /<th scope="row"[^>]*>[\s\S]*Cadeia/.test(tr))!;
    expect(accessibleText(cadeia)).toMatch(/70 não participou não participou/);
    // O carry é o PAPEL (campeão re-testado), com rótulo estável.
    expect(allText(html)).toContain('Campeão anterior (re-testado)');
    expect(allText(html)).not.toContain('Melhor it.1');
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(!temWebDeps)('web-live#16 — status em PT-BR e lista com unidade', () => {
  it('StatusPill mostra o rótulo PT-BR (o enum continua a chave do tom)', async () => {
    const { StatusPill, STATUS_LABEL } = await import('../web/src/components/primitives');
    for (const [status, rotulo] of Object.entries({
      running: 'em andamento',
      finished: 'concluída',
      inconclusive: 'inconclusiva',
      error: 'erro',
      aborted: 'interrompida',
    })) {
      expect(STATUS_LABEL[status]).toBe(rotulo);
      const html = await render((R) => R.createElement(StatusPill, { status }));
      expect(allText(html)).toBe(rotulo);
    }
  });

  it('RunsList: "interrompida" tem grupo próprio e os metadados dizem a unidade', async () => {
    const { groupOf, runMeta, sessionMeta } = await import('../web/src/pages/RunsList');
    expect(groupOf('aborted')).toBe('aborted');
    expect(groupOf('error')).toBe('error');
    expect(groupOf('inconclusive')).toBe('finished');
    expect(runMeta({ stages: 5, contestants: 3, competitors: 3 })).toBe('5 cenários · 3 participantes');
    expect(runMeta({ stages: 1, competitors: 1 })).toBe('1 cenário · 1 participante');
    expect(sessionMeta({ iterationsDone: 2, iterationsPlanned: 5 })).toBe('rodada 2 de 5');
  });
});

// ---------------------------------------------------------------------------

describe('web-code#7 — preço variável tem motivo próprio na confirmação', () => {
  const base = { thresholdUsd: 1, unpricedModelIds: [] as string[] };

  it("só preço variável (faixa ≤ limiar) ⇒ 'unknown', nunca null", () => {
    expect(costConfirmationReason({ ...base, high: 0.0081, unknownPriceModelIds: ['openrouter/auto'] })).toBe('unknown');
    expect(costConfirmationReason({ ...base, high: 3, unknownPriceModelIds: ['openrouter/auto'] })).toBe('both');
    expect(costConfirmationReason({ ...base, high: 0.2, unpricedModelIds: ['x'], unknownPriceModelIds: ['y'] })).toBe('unpriced');
    // Coerente com o portão (que já contava os de preço variável).
    const e = { ...base, high: 0.0081, unknownPriceModelIds: ['openrouter/auto'] };
    expect(costConfirmationReason(e) !== null).toBe(
      requiresCostConfirmation(e.high, [...e.unpricedModelIds, ...e.unknownPriceModelIds]),
    );
  });

  it.skipIf(!temWebDeps)('o diálogo não diz "mais de US$ 1" com faixa de centavos e NOMEIA o modelo variável', async () => {
    const { CostConfirmDialog } = await import('../web/src/components/CostConfirmDialog');
    const estimate: AnyRec = {
      low: 0.0061,
      high: 0.0081,
      drivers: [],
      unpricedModelIds: [],
      unknownPriceModelIds: ['openrouter/auto'],
      assumptions: { stages: 3, repeats: 1, contestants: 2, judges: 1, iterations: 1 },
      thresholdUsd: 1,
      requiresConfirmation: true,
      budgetBelowLow: false,
      budgetBelowHigh: false,
    };
    const html = await render((R) =>
      R.createElement(CostConfirmDialog, { estimate: estimate as never, mode: 'compare', onConfirm: () => {}, onClose: () => {} }),
    );
    const texto = allText(html);
    expect(texto).not.toContain('pode custar mais de');
    expect(texto).toContain('preço variável');
    expect(texto).toContain('openrouter/auto');
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(!temWebDeps)('IMPL-057 — painel do juiz, avaliador falhou, falhas agrupadas e contrato', () => {
  it('célula com painel dividido mostra "painel 2 de 3" com o divergente; degradado diz "avaliador falhou"', async () => {
    const { heatRows, heatmapCellState, panelInfo } = await import('../web/src/pages/runShared');
    const votos = [
      { judgeModelId: 'j/a', verdict: 'resolve' },
      { judgeModelId: 'j/b', verdict: 'resolve' },
      { judgeModelId: 'j/c', verdict: 'parcial' },
    ];
    const stage = refStage(0, { a: 'resolve', b: 'parcial' }, {
      judgeVotesByContestant: {
        a: votos,
        b: [
          { judgeModelId: 'j/a', verdict: 'parcial' },
          { judgeModelId: 'j/b', error: { kind: 'judge_failed', message: 'caiu' } },
        ],
      },
      verdictSourceByContestant: { a: 'judge', b: 'degraded' },
    });
    const record: AnyRec = {
      id: 'r-painel',
      status: 'finished',
      mode: 'compare',
      config: { stages: 1 },
      contestants: [
        { id: 'a', label: 'A', modelId: 'a' },
        { id: 'b', label: 'B', modelId: 'b' },
      ],
      stages: [stage],
    };
    const { rows, stages } = heatRows(record as never);
    const celA = heatmapCellState(stages[0] as never, rows[0], 0, { referenceRun: true });
    expect(celA.label).toContain('painel 2 de 3');
    expect(celA.label).toContain('divergente: j/c');
    expect(celA.glyph).toBe('✓*');
    const celB = heatmapCellState(stages[0] as never, rows[1], 0, { referenceRun: true });
    expect(celB.label).toContain('avaliador falhou');
    expect(panelInfo(stages[0] as never, 'b')).toMatchObject({ degraded: true });
    expect(panelInfo(stages[0] as never, 'b').agreement?.failedJudgeIds).toEqual(['j/b']);
  });

  it('veredito AUSENTE por falha do juiz: "sem veredito — avaliador falhou"', async () => {
    const { heatRows, heatmapCellState } = await import('../web/src/pages/runShared');
    const stage = refStage(0, { a: 'resolve' }, {
      verdictErrorByContestant: { b: { kind: 'invalid_output', message: 'JSON inválido' } },
    });
    const record: AnyRec = {
      id: 'r-falha',
      status: 'finished',
      mode: 'compare',
      config: { stages: 1 },
      contestants: [
        { id: 'a', label: 'A', modelId: 'a' },
        { id: 'b', label: 'B', modelId: 'b' },
      ],
      stages: [stage],
    };
    const { rows, stages } = heatRows(record as never);
    const cel = heatmapCellState(stages[0] as never, rows[1], 0, { referenceRun: true });
    expect(cel.label).toBe('sem veredito — avaliador falhou: JSON inválido');
  });

  it('fixture N3 (8×4, 12 falhas) renderiza ≤ 4 grupos; degraded nunca vira falha', async () => {
    const { VerdictFailuresPanel } = await import('../web/src/components/RunInsights');
    const cenarios = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const falhas: Record<string, Array<[string, string]>> = {
      A: [['c1', 'timeout'], ['c2', 'timeout'], ['c3', 'timeout'], ['c4', 'timeout']],
      B: [['c1', 'invalid_output'], ['c2', 'invalid_output'], ['c3', 'invalid_output']],
      C: [['c2', 'judge_failed'], ['c3', 'judge_failed'], ['c4', 'judge_failed']],
      D: [['c1', 'blocked'], ['c2', 'blocked']],
    };
    const stages = cenarios.map((nome, i) => ({
      index: i,
      spec: { question: `Cenário ${nome}`, productContext: 'ctx', maxTokens: 100, reference: 'r' },
      responses: [],
      referenceJudge: {
        verdictByContestant: {},
        explanationByContestant: {},
        judgeModelId: 'j',
        verdictErrorByContestant: Object.fromEntries(
          (falhas[nome] ?? []).map(([c, kind]) => [c, { kind, message: `${kind} em ${nome}` }]),
        ),
        // Painel reduzido com veredito presente: NÃO é falha do candidato.
        verdictSourceByContestant: nome === 'E' ? { c1: 'degraded' } : {},
      },
    }));
    // O 'degraded' de E tem veredito; por garantia, um erro gravado junto não conta.
    (stages[4].referenceJudge.verdictErrorByContestant as AnyRec).c1 = { kind: 'judge_failed', message: 'um juiz caiu' };
    const record: AnyRec = {
      id: 'r-n3',
      status: 'finished',
      contestants: ['c1', 'c2', 'c3', 'c4'].map((id) => ({ id, label: id.toUpperCase(), modelId: id })),
      stages,
    };
    const html = await render((R) => R.createElement(VerdictFailuresPanel, { record: record as never }));
    const grupos = openTagsOf(html, 'span').filter((t) => t.includes('data-failure-group'));
    expect(grupos.length).toBeGreaterThan(0);
    expect(grupos.length).toBeLessThanOrEqual(4);
    expect(12 / grupos.length).toBeGreaterThanOrEqual(3);
    const texto = allText(html);
    expect(texto).toContain('12 veredito(s) ausente(s) em 4 grupo(s)');
    expect(texto).not.toContain('um juiz caiu');
    // Filtro por categoria presente (há 3 categorias: infraestrutura, juiz, moderação).
    expect(html).toContain('aria-label="Filtrar falhas por quem falhou"');
  });

  it('auditoria do contrato: linha curta sem hash; ao mudar, "scores não comparáveis"', async () => {
    const { JudgeDiagnostics } = await import('../web/src/components/RunInsights');
    const hash = 'abcdef1234567890ffff';
    const mk = (changed: boolean): AnyRec => ({
      id: 'r-contrato',
      status: 'finished',
      contestants: [],
      stages: [],
      judgeDiagnostics: {
        contract: { hash, modelIds: ['j/a'], pinnedAt: '2026-09-29T00:00:00Z' },
        contractAudit: {
          changed,
          previousHash: changed ? '0000000000001111' : hash,
          line: changed
            ? 'juiz: j/a (contrato mudou — scores não comparáveis com a última run)'
            : 'juiz: j/a (mesmo contrato desde a última run)',
          detail: `juiz: j/a · contrato ${hash.slice(0, 12)}`,
        },
        verbosity: { n: 0, r: 0, biased: false, warning: '' },
      },
    });
    const igual = await render((R) => R.createElement(JudgeDiagnostics, { record: mk(false) as never }));
    const linha = innersOf(igual, 'p').find((p) => p.includes('mesmo contrato'))!;
    expect(linha).toBe('juiz: j/a (mesmo contrato desde a última run)');
    expect(linha).not.toContain(hash.slice(0, 12));
    // O hash (12 chars) aparece UMA vez — no detalhe.
    expect(igual.split(hash.slice(0, 12)).length - 1).toBe(1);
    const mudou = allText(await render((R) => R.createElement(JudgeDiagnostics, { record: mk(true) as never })));
    expect(mudou).toContain('scores não comparáveis');
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(!temWebDeps)('IMPL-112 — saturação por item e fila de revisão humana na run', () => {
  it('item 100% resolve vai à fila (com o porquê) e o relatório por item × participante é mostrado', async () => {
    const { GabaritoReview } = await import('../web/src/components/RunInsights');
    const stages = [
      refStage(0, { a: 'resolve', b: 'resolve', c: 'resolve' }),
      refStage(1, { a: 'resolve', b: 'nao', c: 'parcial' }),
    ];
    const itemSaturation = itemSaturationReport(stages as never);
    expect(itemSaturation.reviewQueue).toHaveLength(1);
    const record: AnyRec = {
      id: 'r-sat',
      status: 'finished',
      contestants: ['a', 'b', 'c'].map((id) => ({ id, label: `Part ${id}`, modelId: id })),
      stages,
      itemSaturation,
      needsHumanReview: [{ stageIndex: 1, contestantId: 'b', reason: 'low_confidence_verdict', detail: 'confiança baixa' }],
    };
    const html = await render((R) => R.createElement(GabaritoReview, { record: record as never }));
    const texto = allText(html);
    expect(texto).toContain('100% resolve');
    expect(texto).toContain('Pergunta 1?');
    expect(texto).toContain('nenhum item é descartado');
    expect(texto).toMatch(/gabarito pode estar largo demais/);
    expect(texto).toContain('veredito com confiança baixa');
    expect(texto).toContain('Part b');
    // Relatório por item: uma linha por item com veredito (nada descartado).
    expect(openTagsOf(html, 'th').filter((t) => t.includes('scope="row"'))).toHaveLength(itemSaturation.items.length);
    // 1 execução por participante em cada item: "resolveu/execuções" por célula.
    expect(texto).toMatch(/Pergunta 1\? 100% 1\/1 1\/1 1\/1/);
    expect(texto).toMatch(/Pergunta 2\? 33% 1\/1 0\/1 0\/1/);
  });

  it('sem saturação nem fila: nada é renderizado', async () => {
    const { GabaritoReview } = await import('../web/src/components/RunInsights');
    const html = await render((R) =>
      R.createElement(GabaritoReview, { record: { id: 'x', status: 'finished', contestants: [], stages: [] } as never }),
    );
    expect(html).toBe('');
  });

  it('fila longa de revisão humana vem RECOLHIDA (acordeão), curta fica à vista', async () => {
    const { GabaritoReview } = await import('../web/src/components/RunInsights');
    const fila = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ stageIndex: i, contestantId: 'a', reason: 'low_confidence_verdict' }));
    const rec = (n: number): AnyRec => ({
      id: 'r-fila',
      status: 'finished',
      contestants: [{ id: 'a', label: 'A', modelId: 'a' }],
      stages: [],
      needsHumanReview: fila(n),
    });
    // O mock do acordeão rende os filhos: o que distingue é o gatilho com o título.
    const longa = await render((R) => R.createElement(GabaritoReview, { record: rec(8) as never }));
    expect(allText(longa)).toContain('Fila de revisão humana (needs-human-review) · 8');
    // Longa: o título é o GATILHO do acordeão, não o rótulo à vista (MiniLabel).
    expect(longa).not.toMatch(/<div class="[^"]*uppercase[^"]*">Fila de revisão humana/);
    const curta = await render((R) => R.createElement(GabaritoReview, { record: rec(2) as never }));
    expect(curta).toMatch(/<div class="[^"]*uppercase[^"]*">Fila de revisão humana \(needs-human-review\) · 2/);
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(!temWebDeps)('RunView — record vivo mutado no lugar', () => {
  it('run.finished com o MESMO objeto do estado devolve referência nova (senão o React não re-renderiza)', async () => {
    const { applyEvent } = await import('../web/src/pages/runShared');
    // O motor da SPA muta o record vivo: cancelada ainda na geração, o estado
    // (snapshot) e o `run.finished` carregam o MESMO objeto — só o status mudou.
    const vivo: AnyRec = { id: 'r-vivo', status: 'running', config: { stages: 2 }, contestants: [], stages: [] };
    const estado = vivo;
    vivo.status = 'aborted';
    const fim = applyEvent(estado as never, { type: 'run.finished', runId: 'r-vivo', record: vivo });
    expect(fim).not.toBe(estado);
    expect(fim.status).toBe('aborted');
    const inicio = applyEvent(estado as never, { type: 'run.started', runId: 'r-vivo', record: vivo });
    expect(inicio).not.toBe(estado);
  });
});
