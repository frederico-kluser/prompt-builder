// IMPL-106 (R-11b:REC-1) + IMPL-107 (R-11b:REC-7) — gates num browser REAL.
//
// O que corre aqui é o SPA DE VERDADE: `vite build` do web/ servido em
// 127.0.0.1, com o Playwright (playwright-core) por cima — mesma receita de
// browser de test/lgpd-wipe-e2e.test.ts (PB_E2E_CHROMIUM → chromium do
// playwright-core → Chrome/Chromium/Brave do sistema; sem NENHUM browser o
// teste é PULADO COM AVISO, nunca verde mudo). A rede é interceptada: o
// catálogo do OpenRouter vem de fixture determinística de 459 modelos.
//
// Critérios verificados:
//  IMPL-106 (b) "Iniciar" + custo estimado dentro da viewport em 1440×900 e
//      390×844, com a página rolada em cada seção (CTA fixo, sem rolagem até
//      ele) — e sem colisão com a barra inferior (IMPL-110) em 390px;
//  IMPL-106 (c) ≤ 10 paradas de Tab do topo do formulário até "Iniciar";
//  IMPL-106 (d) nenhum campo obrigatório oculto por default + zero semântica
//      de aba (a validação deixou de ser atrelada a abas);
//  IMPL-107 (a) virtualização com 459 itens: contagem de nós DOM estável;
//  IMPL-107 (b) teclado no padrão ARIA combobox: setas movem o
//      aria-activedescendant, Enter seleciona, Esc fecha;
//  IMPL-107 (c)+(e) ordenação default (popularidade semanal) ≠ newest e
//      trocável na UI; "mostrando X de Y" reflete o total filtrado; preço
//      "-1" nunca aparece como número negativo.
//
// SUPERFÍCIE GUIADA (2026-09-27, pedido do dono): a Nova Run abre por default
// num fluxo GUIADO de 5 passos (Objetivo → Teste → Participantes → Limites →
// Revisão, com plano em linguagem natural) e guarda a página única IMPL-106
// como superfície "Completa" num toggle, com o MESMO estado e o MESMO rodapé
// fixo. Os contratos acima medem a completa; o describe final cobre o guiado.
//
// A superfície GUIADA (default) tem os MESMOS gates (b) e (c) — medidos em
// todos os passos e nos 3 modos — e o (d) na forma que cabe num assistente
// (decisão do dono, ef07ce2): nenhum obrigatório oculto SEM pista visível —
// ponto de pendência no trilho (sempre à vista), 1ª pendência no rodapé fixo
// com link para o passo.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'web', 'dist');

/* ------------------------------------------------------------- browser */

interface BrowserAlvo {
  executablePath?: string;
  origem: string;
}

/** Onde está um browser (ordem: env → playwright-core → sistema). */
function resolverBrowser(): BrowserAlvo | null {
  const env = process.env.PB_E2E_CHROMIUM;
  if (env && existsSync(env)) return { executablePath: env, origem: `PB_E2E_CHROMIUM=${env}` };
  try {
    const proprio = chromium.executablePath();
    if (proprio && existsSync(proprio)) return { origem: `chromium do playwright-core (${proprio})` };
  } catch {
    // sem registry do playwright para esta plataforma — segue para o sistema
  }
  const sistema = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/brave',
    '/usr/bin/brave-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const bin of sistema) if (existsSync(bin)) return { executablePath: bin, origem: `browser do sistema (${bin})` };
  return null;
}

const alvo = resolverBrowser();
if (!alvo) {
  console.warn(
    '[ux-nova-run-e2e] SEM BROWSER — os gates Playwright do IMPL-106/107 não foram verificados nesta máquina.\n' +
      '                   Ligue com: npx playwright-core install chromium\n' +
      '                   (ou instale Chrome/Chromium/Brave, ou exporte PB_E2E_CHROMIUM=<caminho>).',
  );
}

/* ------------------------------------------------- build + servidor estático */

/** Build atual do SPA (o teste mede o código de HOJE, não um dist velho). */
function buildWeb(): void {
  const viteBin = join(ROOT, 'web', 'node_modules', 'vite', 'bin', 'vite.js');
  const r = spawnSync(process.execPath, [viteBin, 'build'], {
    cwd: join(ROOT, 'web'),
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`vite build falhou:\n${r.stdout}\n${r.stderr}`);
}

const TIPOS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

async function servirDist(): Promise<{ servidor: Server; url: string }> {
  const servidor = createServer((req, res) => {
    const rota = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const arquivo = join(DIST, rota === '/' ? 'index.html' : rota.replace(/^\/+/, ''));
    const existe = existsSync(arquivo) && !rota.endsWith('/');
    // SPA fallback: qualquer rota sem arquivo servido volta ao index.html.
    const alvoArquivo = existe ? arquivo : join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': TIPOS[extname(alvoArquivo)] ?? 'application/octet-stream' });
    res.end(readFileSync(alvoArquivo));
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const end = servidor.address();
  if (!end || typeof end === 'string') throw new Error('servidor E2E sem porta');
  return { servidor, url: `http://127.0.0.1:${end.port}/` };
}

/* ------------------------------------------------------- fixture do catálogo */

/**
 * Catálogo determinístico de 459 modelos no fio do OpenRouter: 458 "normais"
 * + 1 roteador de PREÇO VARIÁVEL ("-1"). 10 nomes trazem "Cetim" — é o que a
 * busca do critério (e) filtra para provar a contagem honesta.
 */
function fixtureCatalogo() {
  const data = Array.from({ length: 458 }, (_, i) => ({
    id: `provedor/modelo-${String(i).padStart(3, '0')}`,
    name: i < 10 ? `Modelo Cetim ${i}` : `Modelo ${i}`,
    created: 1_700_000_000 + i * 1_000,
    context_length: 64_000,
    supported_parameters: ['temperature', 'tools'],
    architecture: { input_modalities: ['text'] },
    pricing: { prompt: (0.000001 * (i + 1)).toString(), completion: (0.000002 * (i + 1)).toString() },
    expiration_date: null,
  }));
  data.push({
    id: 'openrouter/auto',
    name: 'Auto Router',
    created: 1_600_000_000,
    context_length: 64_000,
    supported_parameters: ['temperature'],
    architecture: { input_modalities: ['text'] },
    pricing: { prompt: '-1', completion: '-1' }, // preço variável (IMPL-018/043)
    expiration_date: null,
  } as (typeof data)[number]);
  return { data };
}

/* -------------------------------------------------------------- utilitários */

let navegador: Browser | null = null;
let servidor: Server | null = null;
let url = '';

/** Contexto novo por teste (localStorage/cache zerados) + rede interceptada. */
async function paginaNova(
  viewport: { width: number; height: number },
  // Superfície do formulário (2026-09-27): os contratos IMPL-106/107 medem a
  // página única COMPLETA; a superfície GUIADA (default) tem o seu describe.
  estilo: 'guided' | 'complete' = 'complete',
  // `key: false` = navegador SEM key (fluxo BYOK: o first-run pede a key).
  opts: { key?: boolean } = {},
): Promise<{
  contexto: BrowserContext;
  page: Page;
}> {
  const contexto = await navegador!.newContext({ viewport });
  const page = await contexto.newPage();
  // KeyGate deixa passar com key "lembrada" — sem tocar no OpenRouter de verdade.
  // O init roda em TODA navegação (inclusive reload): só grava a key se pedido.
  await page.addInitScript(
    ({ s, comKey }: { s: string; comKey: boolean }) => {
      if (comKey) {
        localStorage.setItem('openrouter_api_key', 'sk-or-e2e-nao-real');
        localStorage.setItem('openrouter_api_key:remember', '1');
      }
      localStorage.setItem('pb.formStyle', s);
      localStorage.setItem('pb.onboarded', '1'); // o first-run abre direto no passo da key
    },
    { s: estilo, comKey: opts.key !== false },
  );
  await page.route('**/*', async (route) => {
    const alvoUrl = route.request().url();
    if (alvoUrl.includes('/api/v1/models')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fixtureCatalogo()),
      });
    }
    // Validação da key (GET /key): resposta de key válida, sem rede real.
    if (/\/api\/v1\/key(\?|$)/.test(alvoUrl)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { label: 'e2e', usage: 0, limit: null, is_free_tier: false } }),
      });
    }
    if (alvoUrl.startsWith(url)) return route.continue();
    // Nada de rede externa nos gates.
    return route.abort();
  });
  return { contexto, page };
}

/** Espera o formulário renderizado com o catálogo carregado (sem "carregando…"). */
async function esperarFormulario(page: Page): Promise<void> {
  await page.waitForSelector('[aria-label="Iniciar a run"]', { timeout: 30_000 });
  await page.waitForFunction(
    () => ![...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'carregando…'),
    undefined,
    { timeout: 30_000 },
  );
}

/** Paradas de Tab do PRIMEIRO controle do formulário até o "Iniciar". */
async function paradasAteIniciar(page: Page): Promise<number> {
  // O foco inicial tem de CAIR no formulário: logo depois de uma troca de
  // passo/rota um re-render pode engolir o focus() (a contagem começaria no
  // <body> e mediria o cabeçalho da app, não o formulário).
  await page.waitForFunction(
    () => {
      const form = document.querySelector('form');
      const primeiro = form?.querySelector<HTMLElement>(
        'button:not([tabindex="-1"]), input:not([type="hidden"]), select, textarea, a[href]',
      );
      primeiro?.focus();
      return !!primeiro && document.activeElement === primeiro;
    },
    undefined,
    { polling: 100, timeout: 10_000 },
  );
  for (let presses = 0; presses <= 40; presses++) {
    const noIniciar = await page.evaluate(
      () => document.activeElement?.getAttribute('aria-label') === 'Iniciar a run',
    );
    if (noIniciar) return presses;
    await page.keyboard.press('Tab');
  }
  throw new Error('"Iniciar" não alcançado em 40 paradas de Tab');
}

beforeAll(async () => {
  if (!alvo) return;
  buildWeb();
  const s = await servirDist();
  servidor = s.servidor;
  url = s.url;
  navegador = await chromium.launch({
    headless: true,
    ...(alvo.executablePath ? { executablePath: alvo.executablePath } : {}),
  });
}, 300_000);

afterAll(async () => {
  await navegador?.close();
  await new Promise<void>((ok) => (servidor ? servidor.close(() => ok()) : ok()));
});

/* ================================================================ IMPL-106 */

describe.skipIf(!alvo)('IMPL-106 (b) — "Iniciar" + custo na viewport, todas as seções', () => {
  for (const vp of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    it(`${vp.width}×${vp.height}: CTA e custo dentro da viewport em cada seção`, async () => {
      const { contexto, page } = await paginaNova(vp);
      try {
        await page.goto(`${url}new`);
        await esperarFormulario(page);

        for (const sec of ['sec-cenarios', 'sec-sujeitos', 'sec-juizes', 'sec-avancado']) {
          await page.evaluate((id) => document.getElementById(id)?.scrollIntoView({ block: 'start' }), sec);
          const r = await page.evaluate(() => {
            const caixa = (el: Element | null) => {
              const b = el?.getBoundingClientRect();
              return b ? { top: b.top, bottom: b.bottom, left: b.left, right: b.right } : null;
            };
            const botao = document.querySelector('[aria-label="Iniciar a run"]');
            const custo = [...document.querySelectorAll('span')].find((s) =>
              s.textContent?.includes('custo estimado'),
            );
            return {
              botao: caixa(botao),
              custo: caixa(custo),
              vh: window.innerHeight,
              vw: window.innerWidth,
            };
          });
          expect(r.botao, `sem "Iniciar" em ${sec}`).not.toBeNull();
          expect(r.custo, `sem custo estimado em ${sec}`).not.toBeNull();
          for (const [nome, b] of [
            ['Iniciar', r.botao!],
            ['custo', r.custo!],
          ] as const) {
            expect(b.top, `${nome} cortado em cima (${sec})`).toBeGreaterThanOrEqual(0);
            expect(b.bottom, `${nome} cortado embaixo (${sec})`).toBeLessThanOrEqual(r.vh + 1);
            expect(b.left, `${nome} cortado à esquerda (${sec})`).toBeGreaterThanOrEqual(0);
            expect(b.right, `${nome} cortado à direita (${sec})`).toBeLessThanOrEqual(r.vw + 1);
          }
        }

        if (vp.width < 768) {
          // O rodapé fixo não pode morrer ATRÁS da barra inferior (IMPL-110).
          const sobreposicao = await page.evaluate(() => {
            const botao = document.querySelector('[aria-label="Iniciar a run"]')?.getBoundingClientRect();
            const barra = document.querySelector('nav[aria-label="Navegação"]')?.getBoundingClientRect();
            if (!botao || !barra) return null;
            return botao.bottom > barra.top + 1;
          });
          expect(sobreposicao, 'rodapé colide com a barra inferior').toBe(false);
        }
      } finally {
        await contexto.close();
      }
    }, 120_000);
  }
});

describe.skipIf(!alvo)('IMPL-106 (c)+(d) — orçamento de Tab e obrigatórios à vista', () => {
  it('≤ 10 paradas de Tab do topo do formulário até "Iniciar" (nos 3 modos)', async () => {
    const { contexto, page } = await paginaNova({ width: 1440, height: 900 });
    try {
      const modos: [string, string][] = [
        ['Comparar modelos', 'compare'],
        ['Testar prompts', 'variation'],
        ['Treinar prompt', 'training'],
      ];
      const contagens: Record<string, number> = {};
      for (const [rotulo, id] of modos) {
        await page.goto(`${url}new`);
        await esperarFormulario(page);
        if (id !== 'compare') {
          // `:text-is` não casa quando o rótulo vive num <span> filho (o
          // segmentado do Motion UI) — o papel/nome acessível é que decide.
          await page.getByRole('button', { name: rotulo, exact: true }).click();
          await page.waitForTimeout(150);
        }
        const presses = await paradasAteIniciar(page);
        contagens[id] = presses + 1; // paradas do topo do formulário até (e incluindo) o Iniciar
        expect(contagens[id], `modo ${id}: ${contagens[id]} paradas`).toBeLessThanOrEqual(10);
      }
      // O orçamento medido pela pesquisa era 18 — o gate cobra 10 ou menos.
      expect(Math.max(...Object.values(contagens))).toBeLessThanOrEqual(10);
    } finally {
      await contexto.close();
    }
  }, 180_000);

  it('sem abas; obrigatórios visíveis sem tocar em nada; Avançado é que recolhe', async () => {
    const { contexto, page } = await paginaNova({ width: 1440, height: 900 });
    try {
      await page.goto(`${url}new`);
      await esperarFormulario(page);

      // Nenhuma semântica de aba — a validação não é mais atrelada a abas.
      expect(await page.locator('[role="tab"], [role="tablist"], [role="tabpanel"]').count()).toBe(0);

      // (d) campos obrigatórios à vista por default: tema, participantes, juízes.
      for (const rotulo of ['Tema', 'Gerador', 'Competidores', 'Juízes']) {
        const visivel = await page
          .locator(`text=${rotulo}`)
          .first()
          .isVisible();
        expect(visivel, `campo obrigatório "${rotulo}" escondido`).toBe(true);
      }
      const textareaTema = page.locator('textarea[aria-label="Tema"]');
      expect(await textareaTema.isVisible()).toBe(true);

      // O "Avançado" nasce recolhido (montado em `hidden`) e só ele recolhe.
      expect(
        await page.evaluate(() => document.getElementById('sec-avancado-region')?.hidden),
      ).toBe(true);
      await page.getByRole('button', { name: 'Avançado', exact: true }).click();
      expect(
        await page.evaluate(() => document.getElementById('sec-avancado-region')?.hidden),
      ).toBe(false);
      // O que é opcional mora lá (Quantos), nunca o conteúdo obrigatório.
      expect(await page.locator('text=Quantos').first().isVisible()).toBe(true);
    } finally {
      await contexto.close();
    }
  }, 120_000);
});

/* ================================================================ IMPL-107 */

describe.skipIf(!alvo)('IMPL-107 — seletor de modelos num browser real', () => {
  it('(a)+(c)+(e) virtualização com 459, sort default ≠ newest, contagem honesta', async () => {
    const { contexto, page } = await paginaNova({ width: 1440, height: 900 });
    try {
      await page.goto(`${url}new`);
      await esperarFormulario(page);

      // Abre o popup do seletor de Competidores.
      await page
        .locator('#sec-sujeitos')
        .getByRole('button', { name: 'adicionar', exact: true })
        .click();
      await page.waitForSelector('[role="listbox"]');

      // (a) virtualização: poucos nós DOM para 459 itens…
      const n1 = await page.locator('[role="option"]').count();
      expect(n1).toBeGreaterThan(5);
      expect(n1).toBeLessThan(60);
      // …e contagem ESTÁVEL ao rolar (a janela desliza, não a lista inteira).
      await page.locator('[role="listbox"]').evaluate((el) => {
        el.scrollTop = 20_000;
      });
      await page.waitForFunction(
        (n) => document.querySelectorAll('[role="option"]').length === n,
        n1,
        { timeout: 5_000 },
      );
      const n2 = await page.locator('[role="option"]').count();
      expect(n2).toBe(n1);

      // (c) sort default = popularidade semanal, ≠ newest, e trocável.
      const sortSelect = page.locator('select[aria-label="Ordenar por"]');
      expect(await sortSelect.inputValue()).toBe('top-weekly');
      await sortSelect.selectOption('newest');
      await page.waitForTimeout(150);
      const primeiroDepois = await page.locator('[role="option"]').first().innerText();
      expect(primeiroDepois).toContain('modelo-457'); // o mais novo do catálogo

      // (e) contagem honesta do TOTAL FILTRADO: 10 dos 459 têm "Cetim".
      await page.locator('input[role="combobox"]').fill('Cetim');
      await page.waitForFunction(
        () => document.body.innerText.includes('mostrando 10 de 459'),
        undefined,
        { timeout: 5_000 },
      );

      // (d) preço "-1": rótulo textual, nunca número negativo.
      await page.locator('input[role="combobox"]').fill('auto');
      await page.waitForFunction(() => document.body.innerText.includes('preço variável'), undefined, {
        timeout: 5_000,
      });
      const texto = await page.locator('[role="listbox"]').innerText();
      expect(texto).toContain('preço variável');
      // "-1" nunca como NÚMERO negativo (ids como "modelo-011" não contam).
      expect(texto).not.toContain('$-');
      expect(texto).not.toMatch(/\$\s*-\d/);
    } finally {
      await contexto.close();
    }
  }, 120_000);

  it('(b) teclado: setas movem aria-activedescendant, Enter seleciona, Esc fecha', async () => {
    const { contexto, page } = await paginaNova({ width: 1440, height: 900 });
    try {
      await page.goto(`${url}new`);
      await esperarFormulario(page);
      await page
        .locator('#sec-sujeitos')
        .getByRole('button', { name: 'adicionar', exact: true })
        .click();
      await page.waitForSelector('[role="listbox"]');

      // O foco vive no INPUT combobox (padrão W3C APG) — nunca nas opções.
      expect(
        await page.evaluate(() => document.activeElement?.getAttribute('role')),
      ).toBe('combobox');

      const input = page.locator('input[role="combobox"]');
      const antes = await input.getAttribute('aria-activedescendant');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      const depois = await input.getAttribute('aria-activedescendant');
      expect(depois, 'setas não moveram o item ativo').not.toBe(antes);
      expect(depois).toMatch(/-opt-2$/);
      // Foco ≠ seleção: nada foi escolhido ainda.
      expect(await page.locator('#sec-sujeitos >> text=modelo-002').count()).toBe(0);

      // Enter seleciona o item ATIVO e (multi) mantém a lista aberta.
      await page.keyboard.press('Enter');
      await page.locator('#sec-sujeitos >> text=modelo-002').first().waitFor({ timeout: 5_000 });
      expect(await page.locator('#sec-sujeitos >> text=modelo-002').count()).toBeGreaterThan(0);

      // Esc fecha o popup.
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelectorAll('[role="listbox"]').length === 0, undefined, {
        timeout: 5_000,
      });
    } finally {
      await contexto.close();
    }
  }, 120_000);
});
/* ================================================================ GUIADO */

// Superfície GUIADA (2026-09-27, pedido do dono: "configuração totalmente
// guiada"): 5 passos em linguagem natural, uma pergunta por vez, com o MESMO
// rodapé fixo (pendência + custo + Iniciar) da completa. O que se guarda aqui:
// trilho estável, pergunta única por passo, rodapé visível em todos os passos,
// revisão com plano + pendências nomeadas, e o toggle de volta à completa.
describe.skipIf(!alvo)('superfície GUIADA (default) — 5 passos, plano e rodapé fixo', () => {
  it('trilho de passos, pergunta por vez, rodapé sempre visível e toggle Completo', async () => {
    const { contexto, page } = await paginaNova({ width: 1440, height: 900 }, 'guided');
    try {
      await page.goto(`${url}new`);
      await esperarFormulario(page);

      // (i) o trilho estável com os 5 passos.
      for (const passo of ['Objetivo', 'Teste', 'Participantes', 'Limites', 'Revisão']) {
        await page.getByRole('tab', { name: new RegExp(passo) }).first().waitFor({ timeout: 10_000 });
      }

      // (ii) começa na pergunta de ALTO NÍVEL — uma pergunta por passo.
      expect(await page.locator('text=O que você quer descobrir?').first().isVisible()).toBe(true);
      expect(await page.locator('textarea[aria-label="Tema"]').count()).toBe(0);

      // (iii) escolher o objetivo adapta o resto (pergunta do passo seguinte).
      await page.getByRole('button', { name: /Comparar modelos/ }).first().click();
      await page.getByRole('tab', { name: /Teste/ }).first().click();
      await page.locator('text=Sobre o que é o teste?').first().waitFor({ timeout: 10_000 });
      expect(await page.locator('textarea[aria-label="Tema"]').isVisible()).toBe(true);

      // (iv) o rodapé fixo (pendência + custo + Iniciar) acompanha TODOS os
      //      passos, dentro da viewport (o CTA nunca some atrás de um passo).
      for (const passo of ['Objetivo', 'Teste', 'Participantes', 'Limites', 'Revisão']) {
        await page.getByRole('tab', { name: new RegExp(passo) }).first().click();
        await page.waitForTimeout(150);
        const r = await page.evaluate(() => {
          const caixa = (el: Element | null | undefined) => {
            const b = el?.getBoundingClientRect();
            return b ? { top: b.top, bottom: b.bottom, vh: window.innerHeight } : null;
          };
          return {
            botao: caixa(document.querySelector('[aria-label="Iniciar a run"]')),
            custo: caixa(
              [...document.querySelectorAll('span')].find((s) => s.textContent?.includes('custo estimado')),
            ),
          };
        });
        expect(r.botao, `sem "Iniciar" no passo ${passo}`).not.toBeNull();
        expect(r.custo, `sem custo estimado no passo ${passo}`).not.toBeNull();
        expect(r.botao!.bottom, `Iniciar cortado (${passo})`).toBeLessThanOrEqual(r.botao!.vh + 1);
        expect(r.custo!.bottom, `custo cortado (${passo})`).toBeLessThanOrEqual(r.custo!.vh + 1);
      }

      // (v) a revisão mostra o PLANO em linguagem natural e diz o estado do
      //      envio: "Tudo pronto" com os defaults válidos — ou o que falta,
      //      nomeado, com link para o passo que resolve.
      await page.getByRole('tab', { name: /Revisão/ }).first().click();
      await page.locator('text=O plano da run').first().waitFor({ timeout: 10_000 });
      expect(
        await page.locator('text=/Tudo pronto|Antes de iniciar/').first().isVisible(),
        'revisão não diz se está pronto nem o que falta',
      ).toBe(true);

      // (vi) o "Completo" leva à superfície de página única IMPL-106 — sem
      //      abas, com as 4 seções-âncora (o estado preenchido vai junto).
      await page.getByRole('button', { name: 'Completo', exact: true }).click();
      await page.waitForTimeout(250);
      expect(await page.locator('[role="tab"], [role="tablist"], [role="tabpanel"]').count()).toBe(0);
      for (const sec of ['sec-cenarios', 'sec-sujeitos', 'sec-juizes', 'sec-avancado']) {
        expect(await page.locator(`#${sec}`).count(), `falta ${sec} na completa`).toBe(1);
      }
    } finally {
      await contexto.close();
    }
  }, 180_000);
});

/* ================================================================== BYOK */

// web-code#3 + IMPL-082 (i)/(iv) — num browser REAL: a key só sobrevive ao
// reload com «Lembrar neste dispositivo»; sem ela, "key sumida" é RE-PROMPT que
// devolve o usuário à rota de onde veio (antes: a key morria em todo reload e o
// texto dizia "salva no localStorage").
describe.skipIf(!alvo)('BYOK — «Lembrar neste dispositivo» num browser real', () => {
  const KEY = 'sk-or-v1-e2e-nao-real-000000000000';
  const lida = (page: Page) => page.evaluate(() => localStorage.getItem('openrouter_api_key'));

  async function conectar(page: Page, lembrar: boolean): Promise<void> {
    await page.waitForSelector('input[aria-label="OpenRouter API key"]', { timeout: 30_000 });
    // A transição de rota (AppShell, AnimatePresence mode="wait") remonta a
    // página ao fim da saída do redirect → espera o MESMO input sobreviver a
    // duas sondagens antes de digitar (senão a digitação cai na instância que sai).
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __pbKeyInput?: Element };
        const el = document.querySelector('input[aria-label="OpenRouter API key"]');
        if (el && w.__pbKeyInput === el) return true;
        w.__pbKeyInput = el ?? undefined;
        return false;
      },
      undefined,
      { polling: 400, timeout: 10_000 },
    );
    const sw = page.getByRole('switch', { name: 'Lembrar neste dispositivo' });
    // Opt-in: nasce DESLIGADO (key em memória por default).
    expect(await sw.getAttribute('aria-checked')).toBe('false');
    if (lembrar) await sw.click();
    await page.fill('input[aria-label="OpenRouter API key"]', KEY);
    await page.getByRole('button', { name: /Validar e conectar/ }).click();
    await page.getByText('Key conectada').first().waitFor({ timeout: 10_000 });
  }

  it('sem «Lembrar»: a key morre no reload e o app pede de novo, voltando à rota de origem', async () => {
    const { contexto, page } = await paginaNova({ width: 1440, height: 900 }, 'guided', { key: false });
    try {
      await page.goto(`${url}runs`);
      await page.waitForURL(/\/welcome$/, { timeout: 30_000 });
      await conectar(page, false);
      expect(await lida(page), 'sem opt-in nada vai para o disco').toBeNull();
      await page.getByRole('button', { name: 'Voltar para onde estava' }).click();
      await page.waitForURL(/\/runs$/);

      await page.reload();
      await page.waitForURL(/\/welcome$/, { timeout: 30_000 }); // memória da aba: o reload apagou
      await page.getByRole('button', { name: 'Voltar para onde estava' }).waitFor({ timeout: 10_000 });
    } finally {
      await contexto.close();
    }
  }, 120_000);

  it('com «Lembrar»: sobrevive ao reload, a tela declara, e desligar tira do disco na hora', async () => {
    const { contexto, page } = await paginaNova({ width: 1440, height: 900 }, 'guided', { key: false });
    try {
      await page.goto(`${url}settings`);
      await page.waitForURL(/\/welcome$/, { timeout: 30_000 });
      await conectar(page, true);
      expect(await lida(page)).toBe(KEY);
      await page.getByRole('button', { name: 'Voltar para onde estava' }).click();
      await page.waitForURL(/\/settings$/);

      await page.reload();
      await page.getByText(/no localStorage deste navegador, até você a remover/).first().waitFor({ timeout: 30_000 });
      expect(page.url(), 'a key lembrada não pede first-run').toMatch(/\/settings$/);
      const sw = page.getByRole('switch', { name: 'Lembrar neste dispositivo' });
      expect(await sw.getAttribute('aria-checked')).toBe('true');

      await sw.click();
      await page.getByText(/só na memória desta aba — recarregar/).first().waitFor({ timeout: 10_000 });
      expect(await lida(page), 'desmarcar remove a cópia persistida').toBeNull();
    } finally {
      await contexto.close();
    }
  }, 120_000);
});

/* ============================================ GUIADO — gates do IMPL-106 */

// IMPL-106 (b)/(c)/(d) medidos na superfície DEFAULT (guiada). O auditor achou
// os gates rodando só com pb.formStyle='complete' — o default nunca era medido.
describe.skipIf(!alvo)('IMPL-106 na superfície GUIADA (default) — viewport, Tab e pendência visível', () => {
  const PASSOS = ['Objetivo', 'Teste', 'Participantes', 'Limites', 'Revisão'];

  async function irAoPasso(page: Page, passo: string): Promise<void> {
    await page.getByRole('tab', { name: new RegExp(passo) }).first().click();
    await page.waitForTimeout(250); // painel do SmoothTabs assenta
  }

  for (const vp of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    it(`(b) ${vp.width}×${vp.height}: "Iniciar" e custo inteiros na viewport em TODOS os passos`, async () => {
      const { contexto, page } = await paginaNova(vp, 'guided');
      try {
        await page.goto(`${url}new`);
        await esperarFormulario(page);
        for (const passo of PASSOS) {
          await irAoPasso(page, passo);
          const r = await page.evaluate(() => {
            const caixa = (el: Element | null | undefined) => {
              const b = el?.getBoundingClientRect();
              return b ? { top: b.top, bottom: b.bottom, left: b.left, right: b.right } : null;
            };
            return {
              botao: caixa(document.querySelector('[aria-label="Iniciar a run"]')),
              custo: caixa([...document.querySelectorAll('span')].find((s) => s.textContent?.includes('custo estimado'))),
              barra: caixa(document.querySelector('nav[aria-label="Navegação"]')),
              vh: window.innerHeight,
              vw: window.innerWidth,
            };
          });
          for (const [nome, b] of [
            ['Iniciar', r.botao],
            ['custo', r.custo],
          ] as const) {
            expect(b, `sem ${nome} no passo ${passo}`).not.toBeNull();
            expect(b!.top, `${nome} cortado em cima (${passo})`).toBeGreaterThanOrEqual(0);
            expect(b!.bottom, `${nome} cortado embaixo (${passo})`).toBeLessThanOrEqual(r.vh + 1);
            expect(b!.left, `${nome} cortado à esquerda (${passo})`).toBeGreaterThanOrEqual(0);
            expect(b!.right, `${nome} cortado à direita (${passo})`).toBeLessThanOrEqual(r.vw + 1);
          }
          if (vp.width < 768 && r.barra) {
            expect(r.botao!.bottom, `rodapé colide com a barra inferior (${passo})`).toBeLessThanOrEqual(r.barra.top + 1);
          }
        }
      } finally {
        await contexto.close();
      }
    }, 180_000);
  }

  it('(c) ≤ 10 paradas de Tab do topo do formulário até "Iniciar" — 3 modos × 5 passos', async () => {
    const { contexto, page } = await paginaNova({ width: 1440, height: 900 }, 'guided');
    try {
      const contagens: Record<string, number> = {};
      for (const objetivo of ['Comparar modelos', 'Testar o meu prompt', 'Treinar um prompt']) {
        await page.goto(`${url}new`);
        await esperarFormulario(page);
        await page.getByRole('button', { name: new RegExp(objetivo) }).first().click();
        for (const passo of PASSOS) {
          await irAoPasso(page, passo);
          const n = (await paradasAteIniciar(page)) + 1;
          contagens[`${objetivo} › ${passo}`] = n;
          expect(n, `${objetivo} › ${passo}: ${n} paradas`).toBeLessThanOrEqual(10);
        }
      }
      expect(Math.max(...Object.values(contagens))).toBeLessThanOrEqual(10);
    } finally {
      await contexto.close();
    }
  }, 240_000);

  it('(d) obrigatório pendente nunca fica oculto sem pista: ponto no trilho + rodapé que leva ao passo', async () => {
    const { contexto, page } = await paginaNova({ width: 1440, height: 900 }, 'guided');
    try {
      await page.goto(`${url}new`);
      await esperarFormulario(page);
      // Defaults válidos: nenhum passo marcado como pendente.
      expect(await page.locator('[data-pendente]').count()).toBe(0);

      // Tira os juízes (obrigatórios) no passo Participantes e volta ao início.
      await irAoPasso(page, 'Participantes');
      // (No compare o gerador default também é o muse — o chip certo é o do toolbar Juízes.)
      const juizes = page.getByRole('toolbar', { name: 'Juízes' }).first();
      for (const id of ['google/gemini-3.8-flash', 'meta/muse-spark-1.3']) {
        await juizes.getByRole('button', { name: `Remover ${id}`, exact: true }).click();
      }
      await irAoPasso(page, 'Objetivo');
      expect(await page.locator('text=Selecione ao menos 1 juiz.').count(), 'no passo Objetivo o campo não está à vista').toBe(1);

      // Pista visível no TRILHO (sempre à vista) — e no nome acessível do passo.
      const aba = page.getByRole('tab', { name: /Participantes.*pendente/ });
      expect(await aba.count()).toBe(1);
      expect(await aba.locator('[data-pendente]').isVisible()).toBe(true);
      // Os passos sem pendência não ganham o ponto.
      expect(await page.locator('[data-pendente]').count()).toBe(1);

      // Rodapé fixo: nomeia a pendência, dentro da viewport, e LEVA ao passo.
      const rodape = page.getByRole('button', { name: 'Selecione ao menos 1 juiz.' });
      expect(await rodape.isVisible()).toBe(true);
      const caixa = await rodape.boundingBox();
      expect(caixa!.y + caixa!.height).toBeLessThanOrEqual(900 + 1);
      await rodape.click();
      await page.getByText('Quem compete, quem escreve e quem avalia?').first().waitFor({ timeout: 10_000 });
      expect(await page.getByRole('toolbar', { name: 'Juízes' }).first().isVisible()).toBe(true);

      // O GERADOR também mora em Participantes no guiado: a pendência dele
      // aponta para lá (antes apontava para "Teste", que não mostra o seletor).
      await page
        .getByRole('toolbar', { name: 'Gerador' })
        .first()
        .getByRole('button', { name: 'Remover meta/muse-spark-1.3', exact: true })
        .click();
      await irAoPasso(page, 'Objetivo');
      expect(await page.getByRole('tab', { name: /Teste.*pendente/ }).count(), 'Teste não mostra o gerador').toBe(0);
      expect(await page.getByRole('tab', { name: /Participantes.*pendente/ }).count()).toBe(1);
    } finally {
      await contexto.close();
    }
  }, 120_000);

  it('IMPL-048: teste de prompt nasce com gabarito próprio (sem pendência) e o plano o nomeia', async () => {
    const { contexto, page } = await paginaNova({ width: 1440, height: 900 }, 'guided');
    try {
      await page.goto(`${url}new`);
      await esperarFormulario(page);
      await page.getByRole('button', { name: /Testar o meu prompt/ }).first().click();
      await irAoPasso(page, 'Participantes');
      expect(await page.getByRole('toolbar', { name: 'Gabarito' }).first().isVisible()).toBe(true);
      await irAoPasso(page, 'Revisão');
      await page.getByText('Tudo pronto').first().waitFor({ timeout: 10_000 });
      expect(await page.locator('text=/escreve o gabarito/').first().isVisible()).toBe(true);
      expect(await page.locator('[data-pendente]').count()).toBe(0);
    } finally {
      await contexto.close();
    }
  }, 120_000);
});
