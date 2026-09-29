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
//  web-live#10: comparando modelos (sem gabarito) o plano não promete gabarito
//    nem final, e o switch/nº de finalistas (que não agiriam) saem do Limites.
//  web-live#14: o plano descreve os cenários IMPORTADOS e o teto VÁLIDO.
//  web-live#5: no treino o plano e o Limites avisam do poder do gate.

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
    // Sem cenário importado: o gerador cria todos (web-live#14).
    importedCount: 0,
    importedRefs: 0,
    importedFixed: false,
    precisaGerar: true,
    // variation (o modo default deste helper) julga por referência (web-live#10).
    referenceJudging: true,
    trainingPower: null,
    budget: '',
    budgetNum: undefined,
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

describe.skipIf(!temWebDeps)('web-live#10 no guiado — sem gabarito não há régua nem final', () => {
  const compareModelos = { mode: 'compare' as const, referenceModel: [], referenceJudging: false };

  it('comparar modelos: o plano diz "lado a lado" e "sem duelo final" (nada de gabarito)', async () => {
    const plano = accessibleText(painel(await render(compareModelos), 'revisao'));
    expect(plano).toMatch(/compara as respostas lado a lado — sem gabarito — e as ranqueia/);
    expect(plano).toMatch(/Sem duelo final: os duelos exigem gabarito/);
    expect(plano).not.toMatch(/escreve o gabarito/);
    expect(plano).not.toMatch(/compara cada resposta com o gabarito/);
    expect(plano).not.toMatch(/duelam entre si/);
  });

  it('comparar modelos: o Limites não oferece switch/finalistas que não agiriam — diz o porquê', async () => {
    const limites = painel(await render(compareModelos), 'limites');
    expect(limites).not.toContain('aria-label="Duelo final entre os melhores"');
    expect(limites).not.toContain('aria-label="Finalistas"');
    expect(accessibleText(limites)).toMatch(/Duelo final Indisponível aqui: sem gabarito/);
  });

  it('com gabarito (variation) o switch e o duelo continuam — e o plano os promete', async () => {
    const html = await render();
    expect(painel(html, 'limites')).toContain('aria-label="Duelo final entre os melhores"');
    const plano = accessibleText(painel(html, 'revisao'));
    expect(plano).toMatch(/compara cada resposta com o gabarito e dá um veredito/);
    expect(plano).toMatch(/os 3 melhores duelam entre si em todos os cenários —/);
  });

  it('cenários importados COM referência trazem régua e final mesmo comparando modelos', async () => {
    const html = await render({ ...compareModelos, importedCount: 2, importedRefs: 2, importedFixed: true, precisaGerar: false, plannedStages: 2 });
    expect(painel(html, 'limites')).toContain('aria-label="Duelo final entre os melhores"');
    const plano = accessibleText(painel(html, 'revisao'));
    expect(plano).toMatch(/compara com o gabarito nos 2 cenários importados que o trazem/);
    expect(plano).toMatch(/duelam entre si em todos os cenários com gabarito/);
    // Concordância no singular (medido na tela: "nos 1 cenário importados").
    const um = accessibleText(
      painel(await render({ ...compareModelos, importedCount: 1, importedRefs: 1, importedFixed: true, precisaGerar: false, plannedStages: 1 }), 'revisao'),
    );
    expect(um).toMatch(/compara com o gabarito no cenário importado que o traz/);
    expect(um).toMatch(/O cenário importado é usado como está/);
  });
});

describe.skipIf(!temWebDeps)('web-live#14 no guiado — o plano descreve o que a run VAI fazer', () => {
  it('etapas importadas: o gerador não é chamado (e o nº de cenários não é oferecido)', async () => {
    const html = await render({ importedCount: 2, importedFixed: true, precisaGerar: false, plannedStages: 2 });
    const plano = accessibleText(painel(html, 'revisao'));
    expect(plano).toMatch(/Os 2 cenários importados são usados como estão — o gerador não é chamado\./);
    expect(plano).not.toMatch(/O gerador x\/gen cria/);
    const limites = painel(html, 'limites');
    expect(limites).not.toContain('aria-label="Cenários"');
    expect(accessibleText(limites)).toMatch(/2 cenários importados — o arquivo fixa o total/);
  });

  it('pacote (seed) menor que o total: o gerador cria só o que falta', async () => {
    const plano = accessibleText(
      painel(await render({ importedCount: 3, precisaGerar: true, stages: 5, plannedStages: 5 }), 'revisao'),
    );
    expect(plano).toMatch(/3 cenários vêm do arquivo; o gerador x\/gen cria mais 2 sobre/);
  });

  it('teto inválido NÃO vira promessa; o válido sai formatado', async () => {
    const invalido = accessibleText(painel(await render({ budget: '-3', budgetNum: undefined }), 'revisao'));
    expect(invalido).toMatch(/Teto de gasto inválido — corrija no passo Limites\./);
    expect(invalido).not.toMatch(/antes de passar de -3/);
    const valido = accessibleText(painel(await render({ budget: '2', budgetNum: 2 }), 'revisao'));
    expect(valido).toMatch(/A run para sozinha antes de passar de US\$ 2\.00\./);
  });
});

describe.skipIf(!temWebDeps)('web-live#5 no guiado — poder do gate do treino à vista', () => {
  const aviso = { blocking: false, text: 'Com 5 cenários a variante só é promovida se vencer em TODOS.' };

  it('o aviso aparece no Limites (ao lado do nº de cenários) e no plano', async () => {
    const html = await render({ mode: 'training', trainingPower: aviso });
    expect(accessibleText(painel(html, 'limites'))).toContain(aviso.text);
    expect(accessibleText(painel(html, 'revisao'))).toContain(aviso.text);
    expect(accessibleText(painel(html, 'revisao'))).toMatch(/margem e passar no teste de significância/);
  });

  it('o Limites não promete mais "Cinco é um bom começo" no treino', async () => {
    const limites = accessibleText(painel(await render({ mode: 'training', stages: 10, plannedStages: 10 }), 'limites'));
    expect(limites).not.toMatch(/Cinco é um bom começo/);
    expect(limites).toMatch(/O padrão é 10/);
  });
});
