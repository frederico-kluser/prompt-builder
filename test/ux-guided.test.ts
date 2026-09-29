// Superfície GUIADA da Nova Run (components/GuidedSetup.tsx) — render REAL
// (react-dom/server), sem navegador. Os gates de viewport/Tab num browser
// real ficam em test/ux-nova-run-e2e.test.ts.
//
//  IMPL-106 (d) no guiado: nenhum obrigatório oculto SEM pista visível — o
//    passo com pendência ganha um ponto no TRILHO (sempre à vista) e
//    "(pendente)" no nome acessível; a pendência aponta para o passo que MOSTRA
//    o campo (`step`), e a que só existe na completa leva à completa.
//  IMPL-048 no guiado: em teste/treino o Gabarito é pergunta do passo
//    "Participantes" (obrigatório); no compare só aparece se já escolhido.
//  web-code#15: o plano descreve o nº de cenários EFETIVO (clamp), não o cru.

import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { accessibleText } from './uxHtml';

const ROOT = process.cwd();
const WEB_REACT = join(ROOT, 'web', 'node_modules', 'react', 'index.js');
const WEB_REACT_DOM_SERVER = join(ROOT, 'web', 'node_modules', 'react-dom', 'server.node.js');
const temWebDeps = existsSync(WEB_REACT) && existsSync(WEB_REACT_DOM_SERVER);

vi.mock('@/lib/utils', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }));
vi.mock('@/components/motion-ui/ui-theme', () => ({
  useMotionUITransition: () => ({}),
  useMotionUITheme: () => ({ motionMode: 'off' }),
}));
vi.mock('@/components/motion-ui/stagger-reveal', () => ({
  StaggerReveal: (p: { children?: unknown }) => p.children,
  StaggerRevealHeadline: (p: { children?: unknown }) => p.children,
  StaggerRevealItem: (p: { children?: unknown }) => p.children,
}));
// Trilho semântico simples: TODOS os painéis renderizados, cada um marcado.
vi.mock('@/components/motion-ui/smooth-tabs', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return {
    SmoothTabs: (p: { children?: unknown }) => createElement('div', null, p.children),
    SmoothTabsList: (p: { ariaLabel?: string; children?: unknown }) =>
      createElement('div', { role: 'tablist', 'aria-label': p.ariaLabel }, p.children),
    SmoothTabsTab: (p: { value?: string; children?: unknown }) =>
      createElement('button', { type: 'button', role: 'tab', 'data-passo': p.value }, p.children),
    SmoothTabsPanels: (p: { children?: unknown }) => createElement('div', null, p.children),
    SmoothTabsPanel: (p: { value?: string; children?: unknown }) =>
      createElement('section', { role: 'tabpanel', 'data-painel': p.value }, p.children),
  };
});
vi.mock('@/components/ui/button', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return {
    Button: (p: Record<string, unknown>) =>
      createElement('button', { type: p.type ?? 'button', 'aria-label': p['aria-label'] }, p.children),
  };
});
vi.mock('@/components/ui/input', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return {
    Input: (p: Record<string, unknown>) =>
      createElement('input', { type: p.type ?? 'text', 'aria-label': p['aria-label'], defaultValue: p.value }),
  };
});
vi.mock('@/components/ui/switch', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return {
    Switch: (p: Record<string, unknown>) =>
      createElement('input', { type: 'checkbox', role: 'switch', 'aria-label': p['aria-label'] }),
  };
});
vi.mock('@/components/ui/textarea', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return {
    Textarea: (p: Record<string, unknown>) => createElement('textarea', { 'aria-label': p['aria-label'], defaultValue: p.value }),
  };
});
vi.mock('../web/src/components/Modal', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return { Modal: (p: { children?: unknown }) => createElement('div', { 'data-modal': '' }, p.children) };
});

type Props = import('../web/src/components/GuidedSetup').GuidedSetupProps;

function props(over: Partial<Props> = {}): Props {
  const nada = () => undefined;
  return {
    step: 'objetivo',
    onStepChange: nada,
    mode: 'variation',
    setMode: nada,
    theme: 'suporte ao cliente',
    setTheme: nada,
    basePrompt: '',
    setBasePrompt: nada,
    stages: 5,
    plannedStages: 5,
    setStages: nada,
    budget: '',
    setBudget: nada,
    competitors: ['x/c1', 'x/c2'],
    setCompetitors: nada,
    contestantModel: ['x/a'],
    setContestantModel: nada,
    datagen: ['x/gen'],
    setDatagen: nada,
    judge: ['x/j'],
    setJudge: nada,
    referenceModel: ['x/ref'],
    setReferenceModel: nada,
    duelsOn: true,
    setDuelsOn: nada,
    finalists: 3,
    setFinalists: nada,
    models: [],
    modelsLoading: false,
    tuning: {},
    onTuningChange: nada,
    problems: [],
    estimate: null,
    onOpenClassic: nada,
    ...over,
  };
}

async function render(over: Partial<Props> = {}): Promise<string> {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
  const { GuidedSetup } = await import('../web/src/components/GuidedSetup');
  return renderToStaticMarkup(createElement(GuidedSetup, props(over)));
}

/** HTML de UM botão do trilho. */
function aba(html: string, passo: string): string {
  const m = new RegExp(`<button[^>]*data-passo="${passo}"[^>]*>([\\s\\S]*?)</button>`).exec(html);
  expect(m, `aba ${passo}`).not.toBeNull();
  return m![1];
}

/** HTML de UM painel. */
function painel(html: string, passo: string): string {
  const ini = html.indexOf(`data-painel="${passo}"`);
  expect(ini).toBeGreaterThan(0);
  const fim = html.indexOf('data-painel="', ini + 20);
  return html.slice(ini, fim < 0 ? undefined : fim);
}

describe.skipIf(!temWebDeps)('IMPL-106 (d) — guiado: pendência sempre com pista visível no trilho', () => {
  it('passo com pendência ganha ponto + "(pendente)"; os demais não', async () => {
    const html = await render({ problems: [{ section: 'juizes', text: 'Selecione ao menos 1 juiz.' }] });
    expect(aba(html, 'participantes')).toContain('data-pendente');
    expect(accessibleText(aba(html, 'participantes'))).toContain('(pendente)');
    for (const passo of ['objetivo', 'teste', 'limites', 'revisao']) {
      expect(aba(html, passo), passo).not.toContain('data-pendente');
    }
    // Sem pendência nenhuma: trilho limpo.
    expect(await render()).not.toContain('data-pendente');
  });

  it('a pendência aponta o passo que MOSTRA o campo (`step`), não o da seção', async () => {
    // Gerador: seção "cenarios" (→ Teste), mas no guiado o seletor mora em Participantes.
    const html = await render({
      mode: 'compare',
      referenceModel: [],
      problems: [{ section: 'cenarios', step: 'participantes', text: 'Selecione 1 modelo gerador.' }],
    });
    expect(aba(html, 'participantes')).toContain('data-pendente');
    expect(aba(html, 'teste')).not.toContain('data-pendente');
    expect(painel(html, 'participantes')).toContain('aria-label="Gerador"');
    expect(painel(html, 'teste')).not.toContain('aria-label="Gerador"');
  });

  it('pendência de campo que o guiado não tem leva à configuração COMPLETA', async () => {
    const html = await render({
      problems: [{ section: 'sujeitos', text: 'Escreva ao menos 2 variantes manuais (ou 1 + prompt base).', onlyComplete: true }],
    });
    expect(accessibleText(painel(html, 'revisao'))).toContain('— na configuração completa');
  });

  it('a Nova Run passa o `step`/`onlyComplete` das pendências (fonte)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(ROOT, 'web', 'src', 'pages', 'NewRun.tsx'), 'utf8');
    expect(src).toMatch(/section: 'cenarios', step: 'participantes', text: 'Selecione 1 modelo gerador\./);
    expect(src).toMatch(/Preencha o modelo em pelo menos 2 configs\.', onlyComplete: true/);
    expect(src).toMatch(/tried=\{tried\}/);
  });
});

describe.skipIf(!temWebDeps)('IMPL-048 no guiado — o Gabarito é pergunta de "Participantes"', () => {
  it('teste/treino: Gabarito obrigatório à vista, no passo Participantes', async () => {
    for (const mode of ['variation', 'training'] as const) {
      const p = painel(await render({ mode }), 'participantes');
      expect(p, mode).toContain('aria-label="Gabarito"');
      expect(accessibleText(p)).toMatch(/Obrigatório, e diferente dos juízes e do modelo sob teste/);
    }
  });

  it('compare: só aparece quando já escolhido (para poder corrigir); vazio = 1º juiz', async () => {
    expect(painel(await render({ mode: 'compare', referenceModel: [] }), 'participantes')).not.toContain(
      'aria-label="Gabarito"',
    );
    expect(painel(await render({ mode: 'compare', referenceModel: ['x/ref'] }), 'participantes')).toContain(
      'aria-label="Gabarito"',
    );
  });

  it('o plano nomeia quem escreve o gabarito', async () => {
    const plano = accessibleText(painel(await render({ referenceModel: ['x/ref'] }), 'revisao'));
    expect(plano).toMatch(/O modelo x\/ref escreve o gabarito/);
  });
});

describe.skipIf(!temWebDeps)('web-code#15 no guiado — o plano usa o nº de cenários EFETIVO', () => {
  it('stages cru 0 → plano diz 1 cenário (o que vai de fato para o motor)', async () => {
    const plano = accessibleText(painel(await render({ stages: 0, plannedStages: 1 }), 'revisao'));
    expect(plano).toMatch(/cria 1 cenário /);
    expect(plano).not.toMatch(/cria 0 cenário/);
  });
});
