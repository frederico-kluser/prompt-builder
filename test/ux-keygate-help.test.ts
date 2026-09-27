// IMPL-111 (R-11b:REC-6) — KeyGate cobre os 4 pontos de risco e a ajuda segue a rota.
//
// Antes: o KeyGate explicava só localStorage + envio direto + link de keys —
// faltavam os riscos concretos (XSS, extensões, máquina partilhada), a
// recomendação de key COM limite e como revogar; o limite do GET /key aparecia
// como "sem limite" decorativo, sem alerta acionável; e o "?" abria SEMPRE o
// tutorial do comparar em qualquer tela.
//
// Critérios: (a) o texto contém os 4 itens; (b) sem limite lido de GET /key,
// alerta com link de ação aparece; (c) "?" abre o tópico da rota atual (teste
// por rota); (d) nenhum tutorial abre automaticamente; (e) cada afirmação do
// HelpModal é verdadeira sob o default correspondente.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { accessibleText, innersOf, openTagsOf } from './uxHtml';

const ROOT = process.cwd();
const WEB_REACT = join(ROOT, 'web', 'node_modules', 'react', 'index.js');
const WEB_REACT_DOM_SERVER = join(ROOT, 'web', 'node_modules', 'react-dom', 'server.node.js');
const temWebDeps = existsSync(WEB_REACT) && existsSync(WEB_REACT_DOM_SERVER);

vi.mock('@/components/motion-ui/multi-state-button', () => ({
  MultiStateButton: (p: { children?: unknown }) => p.children,
}));
vi.mock('@/components/motion-ui/ui-theme', () => ({
  useMotionUITransition: () => ({}),
  useMotionUITheme: () => ({ motionMode: 'off' }),
}));
vi.mock('@/components/motion-ui/stagger-reveal', () => ({
  StaggerReveal: (p: { children?: unknown }) => p.children,
  StaggerRevealHeadline: (p: { children?: unknown }) => p.children,
  StaggerRevealItem: (p: { children?: unknown }) => p.children,
}));
vi.mock('@/components/ui/button', () => ({ Button: (p: { children?: unknown }) => p.children }));
vi.mock('@/components/ui/input', () => ({ Input: () => null }));
vi.mock('@/lib/utils', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }));
vi.mock('@/components/motion-ui/smooth-tabs', () => ({
  SmoothTabs: (p: { children?: unknown }) => p.children,
  SmoothTabsList: (p: { children?: unknown }) => p.children,
  SmoothTabsTab: () => null,
  SmoothTabsPanels: (p: { children?: unknown }) => p.children,
  SmoothTabsPanel: (p: { children?: unknown }) => p.children,
}));
// O Modal real usa createPortal(document.body); aqui ele só devolve o conteúdo.
vi.mock('../web/src/components/Modal', () => ({
  Modal: (p: { children?: unknown }) => p.children,
}));

/** localStorage mínimo p/ render no node — e devolvido ao fim do teste. */
function stubLocalStorage(): () => void {
  const anterior = (globalThis as Record<string, unknown>).localStorage;
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  return () => {
    (globalThis as Record<string, unknown>).localStorage = anterior;
  };
}

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe.skipIf(!temWebDeps)('IMPL-111 (a) — KeyGate com os 4 pontos de risco', () => {
  it('o texto contém localização, riscos, limite de crédito e revogação', async () => {
    const restore = stubLocalStorage();
    try {
      const { createElement } = await import(pathToFileURL(WEB_REACT).href);
      const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
      const { KeySetup } = await import('../web/src/components/KeySetup');
      const html: string = renderToStaticMarkup(createElement(KeySetup, {}));
      const texto = accessibleText(html);
      // (1) localização da key
      expect(texto).toContain('localStorage');
      expect(texto).toContain('Onde ela fica');
      // (2) riscos: XSS, extensões e máquina partilhada
      expect(texto).toContain('XSS');
      expect(texto).toContain('extensão');
      expect(texto).toMatch(/m[áa]quina partilhada/);
      // (3) recomendação de key COM limite de crédito
      expect(texto).toContain('Limite de crédito');
      expect(texto).toMatch(/crie a key COM limite/i);
      // (4) como revogar (a key é exibida uma única vez) + página de keys
      expect(texto).toMatch(/Como revogar/);
      expect(texto).toContain('exibida uma única vez');
      expect(html).toContain('href="https://openrouter.ai/keys"');
    } finally {
      restore();
    }
  });
});

describe.skipIf(!temWebDeps)('IMPL-111 (b) — sem limite no GET /key, alerta acionável', () => {
  it('keyLimitWarning só dispara sem limite e o banner traz link de ação', async () => {
    const { keyLimitWarning, KeyLimitAlert } = await import('../web/src/components/KeySetup');
    // Sem limite (null OU ausente) → aviso; com limite → silêncio.
    expect(keyLimitWarning({ ok: true, limitUsd: null })).not.toBeNull();
    expect(keyLimitWarning({ ok: true })).not.toBeNull();
    expect(keyLimitWarning({ ok: true, limitUsd: 25 })).toBeNull();
    expect(keyLimitWarning({ ok: false, limitUsd: null })).toBeNull(); // erro não é aviso

    const aviso = keyLimitWarning({ ok: true, limitUsd: null })!;
    const { createElement } = await import(pathToFileURL(WEB_REACT).href);
    const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
    const html: string = renderToStaticMarkup(createElement(KeyLimitAlert, { warning: aviso }));
    expect(html).toContain('role="alert"'); // anunciado, não decorativo
    expect(accessibleText(html)).toContain('Sem limite de crédito — defina um limite na página de keys.');
    // Link de AÇÃO (não só texto).
    const links = openTagsOf(html, 'a');
    expect(links.length).toBe(1);
    expect(links[0]).toContain('href="https://openrouter.ai/keys"');
  });

  it('KeySetup liga o aviso ao resultado de GET /key (validateKey)', () => {
    const src = read('web/src/components/KeySetup.tsx');
    expect(src).toMatch(/keyLimitWarning\(/);
    expect(src).toMatch(/\{avisoLimite && <KeyLimitAlert warning=\{avisoLimite\} \/>/);
    expect(src).toMatch(/setKeyInfo\(res\)/); // o limite vem da validação real
  });
});

describe('IMPL-111 (c) — "?" abre o tópico da rota atual', () => {
  it('helpTopicForRoute: cada rota tem seu tópico (teste por rota)', async () => {
    const { helpTopicForRoute } = await import('../web/src/help');
    const esperado: [string, string][] = [
      ['/new', 'compare'],
      ['/runs', 'runs'],
      ['/runs/abc123', 'runs'],
      ['/training/s1', 'training'],
      ['/prompts', 'prompts'],
      ['/settings', 'settings'],
    ];
    for (const [rota, topico] of esperado) {
      expect(helpTopicForRoute(rota), `rota ${rota}`).toBe(topico);
    }
  });

  it('o AppShell usa o tópico da rota (não "compare" fixo) e todo tópico tem tutorial', async () => {
    const shell = read('web/src/components/AppShell.tsx');
    expect(shell).toMatch(/onHelp=\{\(\) => setHelp\(helpTopicForRoute\(location\.pathname\)\)\}/);
    expect(shell).not.toMatch(/setHelp\('compare'\)/);
    const { helpTopicForRoute } = await import('../web/src/help');
    const { TUTORIALS } = await import('../web/src/components/HelpModal');
    for (const rota of ['/new', '/runs', '/runs/x', '/training/x', '/prompts', '/settings']) {
      expect(TUTORIALS[helpTopicForRoute(rota)], `sem tutorial p/ ${rota}`).toBeDefined();
    }
  });
});

describe('IMPL-111 (d) — nenhum tutorial abre automático; tour ≤3 passos', () => {
  /** Corpo do `useEffect(…)` mais próximo de `inicio` (parênteses balanceados). */
  function blocosUseEffect(src: string): string[] {
    const out: string[] = [];
    let i = 0;
    while ((i = src.indexOf('useEffect(', i)) >= 0) {
      let depth = 0;
      let j = i + 'useEffect('.length - 1;
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      out.push(src.slice(i, j + 1));
      i = j;
    }
    return out;
  }

  it('o help por contexto é no-op por default e nada abre tutorial em efeito', () => {
    const help = read('web/src/help.ts');
    expect(help).toMatch(/createContext<HelpApi>\(\{ open: \(\) => \{\} \}\)/);
    // Nenhum useEffect do app abre ajuda sozinho (era o "dispara automático").
    for (const f of [
      'web/src/components/AppShell.tsx',
      'web/src/components/HelpModal.tsx',
      'web/src/components/KeySetup.tsx',
      'web/src/pages/TrainingView.tsx',
      'web/src/pages/RunView.tsx',
    ]) {
      for (const bloco of blocosUseEffect(read(f))) {
        expect(/setHelp\(|help\.open\(|useHelp\(\)\.open\(/.test(bloco), `${f} abre ajuda em efeito`).toBe(false);
      }
    }
  });

  it('o HelpModal só renderiza quando o usuário pede, e cada tour tem ≤3 passos', async () => {
    const shell = read('web/src/components/AppShell.tsx');
    expect(shell).toMatch(/\{help && <HelpModal tutorial=\{help\}/);
    const { TUTORIALS } = await import('../web/src/components/HelpModal');
    for (const [nome, passos] of Object.entries(TUTORIALS)) {
      expect(passos.length, `tutorial ${nome}`).toBeLessThanOrEqual(3);
      expect(passos.length, `tutorial ${nome} vazio`).toBeGreaterThan(0);
    }
  });
});

describe('IMPL-111 (e) — cada afirmação do HelpModal é verdadeira sob o default', () => {
  it('"os 3 de maior score duelam" = default de finalists nos DOIS motores', async () => {
    const { TUTORIALS } = await import('../web/src/components/HelpModal');
    const defaults = ['src/orchestrator.ts', 'web/src/engine/orchestrator.ts'].map((f) => {
      const m = read(f).match(/config\.finalists \?\? (\d+)/);
      expect(m, `${f} sem default de finalists`).not.toBeNull();
      return Number(m![1]);
    });
    expect(new Set(defaults).size).toBe(1); // shim/mirror concordam
    const d = defaults[0];
    const corpos = `${TUTORIALS.compare[2].body} ${TUTORIALS.variation[2].body}`;
    const numeros = [...corpos.matchAll(/os (\d+) de maior score|as (\d+) melhores duelam/g)]
      .map((m) => Number(m[1] ?? m[2]))
      .filter((n) => Number.isFinite(n));
    expect(numeros.length).toBeGreaterThanOrEqual(2);
    for (const n of numeros) expect(n).toBe(d);
  });

  it('os verbos de veredito do tutorial são exatamente os do motor', async () => {
    const { TUTORIALS } = await import('../web/src/components/HelpModal');
    expect(TUTORIALS.compare[0].body).toContain('resolve, parcial ou não resolve');
    // O vocabulário vem do Verdict do motor (src/types.ts × web/src/api.ts).
    const tipos = read('src/types.ts');
    expect(tipos).toMatch(/export type Verdict = 'resolve' \| 'parcial' \| 'nao'/);
    const shared = read('web/src/pages/runShared.tsx');
    for (const rotulo of ["label: 'resolve'", "label: 'parcial'", "label: 'não resolve'"]) {
      expect(shared, `VERDICT_META sem ${rotulo}`).toContain(rotulo);
    }
  });

  it('afirmações de treino: cenários congelados, holdout e ganho mínimo existem', async () => {
    const { TUTORIALS } = await import('../web/src/components/HelpModal');
    const treino = TUTORIALS.training.map((s) => s.body).join(' ');
    expect(treino).toContain('congelados entre as rodadas');
    expect(read('src/trainer.ts')).toContain('pinnedStages'); // é o que congela
    expect(treino).toContain('reservada para validar o campeão'); // holdout
    const holdout = read('src/holdout.ts');
    // A fatia reservada existe e tem piso/ratio próprios (os valores são do
    // motor — o tutorial não cita número, só o mecanismo).
    expect(holdout).toMatch(/MIN_HOLDOUT_SCENARIOS = \d+/);
    expect(holdout).toMatch(/holdoutRatio/);
    expect(treino).toContain('não há mais ganho real'); // gate de minGain
    expect(read('src/rank.ts')).toMatch(/gain >= minGain/);
  });

  it('afirmações das telas de apoio (histórico/prompts/configurações) batem com o código', async () => {
    const { TUTORIALS } = await import('../web/src/components/HelpModal');
    // Histórico: runs E sessões guardadas neste navegador; iterações fora da lista.
    const runs = TUTORIALS.runs.map((s) => s.body).join(' ');
    expect(runs).toContain('neste navegador');
    expect(read('web/src/engine/storage.ts')).toMatch(/IndexedDB/);
    expect(read('web/src/pages/RunsList.tsx')).toMatch(/filter\(\(r\) => !r\.sessionId\)/);
    // Prompts: texto novo versiona, renomear não.
    const prompts = TUTORIALS.prompts.map((s) => s.body).join(' ');
    expect(prompts).toContain('cria uma nova versão');
    expect(prompts).toMatch(/renomear não cria vers[ãa]o/);
    expect(read('web/src/engine/promptStore.ts')).toMatch(/prompt\.version \+= 1/);
    expect(read('web/src/engine/promptStore.ts')).toMatch(/renomear n[ãa]o (gera vers[ãa]o|versiona)/);
    // Configurações: key no localStorage, tema claro/escuro/sistema.
    const cfg = TUTORIALS.settings.map((s) => s.body).join(' ');
    expect(cfg).toContain('localStorage');
    expect(cfg).toContain('claro, escuro ou o do sistema');
    expect(read('web/src/theme.ts')).toMatch(/export type Theme = 'light' \| 'dark' \| 'system'/);
  });
});
