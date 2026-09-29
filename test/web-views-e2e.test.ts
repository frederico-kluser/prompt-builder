// Telas de treino, relatório, biblioteca e CSP num browser REAL (onda
// web-views-b). Duas bancadas, mesma receita de browser de
// test/ux-nova-run-e2e.test.ts (PB_E2E_CHROMIUM → chromium do playwright-core
// → Chrome/Chromium/Brave do sistema; sem NENHUM browser o teste é PULADO COM
// AVISO, nunca verde mudo). Zero rede externa, zero OpenRouter pago.
//
// 1. HARNESS (esbuild): as páginas REAIS TrainingView / TrainingReport /
//    PromptsPage montadas em StrictMode sob a fronteira de erro por rota, com o
//    `web/src/api.ts` trocado pelo fake de test/support/trainingViewFakeApi.ts —
//    que devolve a referência VIVA da sessão, como o motor do navegador.
//    - web-live#0 (regressão do hotfix 1fb4184): sessão aberta ANTES de as runs
//      chegarem (encerrada e em andamento) não derruba a tela;
//    - web-live#1 / web-code#5: o estúdio "Melhor prompt" abre no campeão da
//      SESSÃO (última rodada), não no argmax de ouros (o original da rodada 1);
//    - web-live#2 / web-code#9: o `session.finished` (mesma referência mutada)
//      re-renderiza — sai o "em andamento" (antes "running"), o "— ao vivo" e o botão de cancelar;
//    - web-live#11: seleção < 20 cenários = "Sem holdout", não "Holdout pulado";
//    - IMPL-046: o veredito de recomendação aparece, com braços rotulados;
//    - web-live#17: tela de Treino e relatório mostram o MESMO p (bilateral);
//    - web-code#14 / web-live#15: salvar de novo vira VERSÃO (não duplicata),
//      a rodada é 1-based na biblioteca e "Editar texto" cria a próxima versão.
// 2. SPA REAL (`vite build` num diretório temporário) servida com os headers
//    EXATOS do vercel.json:
//    - IMPL-083 (ii): 0 violações de CSP nas rotas e nos 3 AnimatePresence
//      `popLayout` (MultiStateButton da key, CopyButton, chips do seletor);
//    - web-live#9: "Usar como base" na biblioteca chega à Nova Run (a transição
//      montava a Nova Run duas vezes e a cópia descartada consumia o rascunho).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { CHAMP, ORIG, OTHER } from './support/trainingViewFixture';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
    '[web-views-e2e] SEM BROWSER — TrainingView/relatório/biblioteca/CSP não foram verificados nesta máquina.\n' +
      '                Ligue com: npx playwright-core install chromium\n' +
      '                (ou instale Chrome/Chromium/Brave, ou exporte PB_E2E_CHROMIUM=<caminho>).',
  );
}

let navegador: Browser | null = null;
let tmp = '';
let harnessServer: Server | null = null;
let harnessUrl = '';
let spaServer: Server | null = null;
let spaUrl = '';

/* ------------------------------------------------- harness (esbuild + fake) */

const HARNESS_HTML = `<!doctype html><html lang="pt-br"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`;

/** As páginas REAIS empacotadas, com o `web/src/api` trocado pelo fake. */
async function buildHarness(dir: string): Promise<void> {
  const fake = join(ROOT, 'test/support/trainingViewFakeApi.ts');
  const api = join(ROOT, 'web/src/api');
  await build({
    entryPoints: [join(ROOT, 'test/support/trainingViewHarness.tsx')],
    outfile: join(dir, 'harness.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    // React/Router/Motion vêm do web/ (UMA cópia do React no bundle).
    nodePaths: [join(ROOT, 'web/node_modules')],
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [
      {
        name: 'fake-api',
        setup(b) {
          b.onResolve({ filter: /(^|\/)api(\.ts)?$/ }, (a) => {
            if (!a.resolveDir) return undefined;
            const abs = resolve(a.resolveDir, a.path).replace(/\.ts$/, '');
            return abs === api ? { path: fake } : undefined;
          });
        },
      },
    ],
  });
}

async function servir(handler: Parameters<typeof createServer>[1]): Promise<{ servidor: Server; url: string }> {
  const servidor = createServer(handler);
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const end = servidor.address();
  if (!end || typeof end === 'string') throw new Error('servidor E2E sem porta');
  return { servidor, url: `http://127.0.0.1:${end.port}/` };
}

interface HarnessPage {
  page: Page;
  contexto: BrowserContext;
  /** Exceções da página e erros de console (a fronteira loga o erro capturado). */
  erros: string[];
}

async function harnessPage(): Promise<HarnessPage> {
  const contexto = await navegador!.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await contexto.newPage();
  const erros: string[] = [];
  page.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') erros.push(`console.error: ${m.text()}`);
  });
  await page.goto(harnessUrl);
  await page.waitForFunction(() => (window as unknown as { __tvReady?: boolean }).__tvReady === true);
  return { page, contexto, erros };
}

async function montar(page: Page, cenario: string, opts: { path?: string; keep?: boolean } = {}): Promise<string> {
  return page.evaluate(
    ([c, o]) => (window as unknown as { __tv: { mount(c: string, o: object): string } }).__tv.mount(c, o),
    [cenario, opts] as const,
  );
}

/** Estado da biblioteca do fake (o que a tela gravou). */
async function biblioteca(page: Page): Promise<
  { name: string; text: string; version: number; history: { version: number; text: string; note?: string }[]; origin?: Record<string, unknown> }[]
> {
  return page.evaluate(() =>
    JSON.parse(
      JSON.stringify((window as unknown as { __tvFake: { state: { prompts: unknown[] } } }).__tvFake.state.prompts),
    ),
  );
}

/** O <select> "Rodada" do estúdio "Melhor prompt" (o rótulo embrulha o select). */
function seletorDeRodada(page: Page) {
  return page.locator('label').filter({ has: page.locator('span', { hasText: /^Rodada$/ }) }).locator('select');
}

/* ------------------------------------------------ SPA real + vercel.json */

const TIPOS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

/** Os headers que a Vercel aplica a TODA rota (`source: "/(.*)"`), lidos do vercel.json. */
function cabecalhosVercel(): Record<string, string> {
  const v = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as {
    headers: { source: string; headers: { key: string; value: string }[] }[];
  };
  const bloco = v.headers.find((h) => h.source === '/(.*)');
  if (!bloco) throw new Error('vercel.json sem o bloco de headers /(.*)');
  return Object.fromEntries(bloco.headers.map((h) => [h.key, h.value]));
}

function buildSpa(outDir: string): void {
  const viteBin = join(ROOT, 'web', 'node_modules', 'vite', 'bin', 'vite.js');
  // outDir PRÓPRIO: o web/dist é de outros testes (e do deploy) — build
  // concorrente no mesmo diretório corromperia os dois.
  // `NODE_ENV: 'production'` é obrigatório: o vitest põe NODE_ENV=test e o
  // build herdado sai com o bundle de DESENVOLVIMENTO do React (não é o
  // artefacto que a Vercel publica) — mesmo cuidado do buildWeb do
  // test/ux-nova-run-e2e.test.ts.
  const r = spawnSync(process.execPath, [viteBin, 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: join(ROOT, 'web'),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  if (r.status !== 0) throw new Error(`vite build falhou:\n${r.stdout}\n${r.stderr}`);
}

/** Catálogo mínimo do OpenRouter (o seletor de modelos precisa de opções). */
function catalogo() {
  return {
    data: Array.from({ length: 8 }, (_, i) => ({
      id: `provedor/modelo-${i}`,
      name: `Modelo ${i}`,
      created: 1_700_000_000 + i * 1_000,
      context_length: 64_000,
      supported_parameters: ['temperature'],
      architecture: { input_modalities: ['text'] },
      pricing: { prompt: String(0.000001 * (i + 1)), completion: String(0.000002 * (i + 1)) },
      expiration_date: null,
    })),
  };
}

interface SpaPage {
  page: Page;
  contexto: BrowserContext;
  /** Headers de cada chamada ao OpenRouter (`/key`, `/models`…), na ordem. */
  chamadas: { url: string; headers: Record<string, string> }[];
}

async function spaPage(): Promise<SpaPage> {
  const contexto = await navegador!.newContext({ viewport: { width: 1280, height: 900 } });
  await contexto.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: spaUrl.replace(/\/$/, '') });
  const page = await contexto.newPage();
  await page.addInitScript(() => {
    // Toda violação de CSP (script/style/connect…) cai aqui — a captura na
    // janela pega as que nascem em elemento, no documento e no global.
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    window.addEventListener(
      'securitypolicyviolation',
      (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI || ''} ${e.sample || ''}`.trim()),
      true,
    );
    localStorage.setItem('openrouter_api_key', 'sk-or-v1-e2e-nao-real-000000000000');
    localStorage.setItem('openrouter_api_key:remember', '1');
    localStorage.setItem('pb.onboarded', '1');
    localStorage.setItem('pb.formStyle', 'complete');
  });
  const chamadas: SpaPage['chamadas'] = [];
  await page.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.startsWith('https://openrouter.ai/')) chamadas.push({ url: u, headers: route.request().headers() });
    if (u.includes('/api/v1/models')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(catalogo()) });
    }
    if (/\/api\/v1\/key(\?|$)/.test(u)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { label: 'e2e', usage: 0, limit: null, is_free_tier: false } }),
      });
    }
    if (u.startsWith(spaUrl)) return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' }); // nada de rede externa
  });
  return { page, contexto, chamadas };
}

async function violacoes(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
}

/** Grava um prompt direto no IndexedDB da SPA (o banco já aberto pela própria app). */
async function semearPrompt(page: Page, p: { id: string; name: string; text: string }): Promise<void> {
  await page.evaluate(
    (prompt) =>
      new Promise<void>((ok, falha) => {
        const req = indexedDB.open('prompt-builder');
        req.onerror = () => falha(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('prompts', 'readwrite');
          const agora = '2026-09-28T12:00:00.000Z';
          tx.objectStore('prompts').put({
            ...prompt,
            version: 1,
            history: [{ version: 1, text: prompt.text, savedAt: agora }],
            origin: { kind: 'training', sessionId: 'sessao-e2e', iteration: 1 },
            createdAt: agora,
            updatedAt: agora,
          });
          tx.oncomplete = () => {
            db.close();
            ok();
          };
          tx.onerror = () => falha(tx.error);
        };
      }),
    p,
  );
}

/* ---------------------------------------------------------------- ciclo */

beforeAll(async () => {
  if (!alvo) return;
  tmp = mkdtempSync(join(tmpdir(), 'pb-web-views-e2e-'));
  await buildHarness(tmp);
  const h = await servir((req, res) => {
    const rota = (req.url ?? '/').split('?')[0];
    if (rota === '/harness.js') {
      res.writeHead(200, { 'content-type': TIPOS['.js'] });
      res.end(readFileSync(join(tmp, 'harness.js')));
      return;
    }
    res.writeHead(200, { 'content-type': TIPOS['.html'] });
    res.end(HARNESS_HTML);
  });
  harnessServer = h.servidor;
  harnessUrl = h.url;

  const dist = join(tmp, 'dist');
  buildSpa(dist);
  const headers = cabecalhosVercel();
  const s = await servir((req, res) => {
    const rota = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const arquivo = join(dist, rota === '/' ? 'index.html' : rota.replace(/^\/+/, ''));
    const existe = existsSync(arquivo) && !rota.endsWith('/');
    // rewrites do vercel.json: toda rota sem arquivo volta ao index.html.
    const alvoArquivo = existe ? arquivo : join(dist, 'index.html');
    res.writeHead(200, { ...headers, 'content-type': TIPOS[extname(alvoArquivo)] ?? 'application/octet-stream' });
    res.end(readFileSync(alvoArquivo));
  });
  spaServer = s.servidor;
  spaUrl = s.url;

  navegador = await chromium.launch({
    headless: true,
    ...(alvo.executablePath ? { executablePath: alvo.executablePath } : {}),
  });
}, 300_000);

afterAll(async () => {
  await navegador?.close();
  for (const srv of [harnessServer, spaServer]) {
    await new Promise<void>((ok) => (srv ? srv.close(() => ok()) : ok()));
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/* ============================================================ 1. HARNESS */

describe.skipIf(!alvo)('web-live#0 — TrainingView com a sessão carregada e as runs ainda não', () => {
  // web-live#16: a pílula mostra o rótulo PT-BR (STATUS_LABEL), não o enum gravado.
  const ROTULO = { finished: 'concluída', running: 'em andamento' } as const;
  for (const status of ['finished', 'running'] as const) {
    it(`sessão ${status}: renderiza o cockpit (sem fronteira de erro, sem exceção)`, async () => {
      const { page, contexto, erros } = await harnessPage();
      try {
        await montar(page, `sem-rodadas-${status}`);
        await page.getByRole('heading', { name: /Treino/ }).waitFor({ timeout: 10_000 });
        await page.getByText('Preparando a rodada…').waitFor();
        // O drawer da variante lia `undefined.contestants` e a fronteira (ou,
        // antes dela, a tela em branco) tomava a página inteira.
        expect(await page.getByText('Esta tela encontrou um erro').count()).toBe(0);
        expect(await page.getByText(ROTULO[status], { exact: true }).count()).toBeGreaterThan(0);
        expect(erros).toEqual([]);
      } finally {
        await contexto.close();
      }
    }, 60_000);
  }
});

describe.skipIf(!alvo)('sessão encerrada de 3 rodadas (a rodada 1 segurou o original com mais ouros)', () => {
  it('web-live#1 / web-code#5: "Melhor prompt" abre no campeão da sessão e salva o campeão', async () => {
    const { page, contexto, erros } = await harnessPage();
    try {
      await montar(page, 'tres-rodadas');
      await page.getByText('Melhor prompt', { exact: true }).waitFor({ timeout: 10_000 });
      const rodada = seletorDeRodada(page);
      // Todas as rodadas carregadas: o default é a ÚLTIMA (r2), não o argmax de
      // `score` (r0, ouros 20 — o ORIGINAL, que o argmax abria).
      await expect.poll(() => rodada.locator('option').count()).toBe(3);
      await expect.poll(() => rodada.inputValue()).toBe('r2');
      await page.getByRole('tab', { name: 'Prompt' }).click();
      await expect.poll(() => page.locator('pre').filter({ hasText: 'Pense passo a passo' }).count()).toBeGreaterThan(0);

      await page.getByRole('button', { name: 'Salvar na biblioteca' }).click();
      const nome = page.getByLabel('Nome na biblioteca');
      expect(await nome.inputValue()).toBe('Prompt Campeão atual · rodada 3');
      await page.getByRole('button', { name: 'Salvar', exact: true }).click();
      await page.getByRole('button', { name: 'Salvo', exact: true }).waitFor();
      const lib = await biblioteca(page);
      expect(lib).toHaveLength(1);
      expect(lib[0].text).toBe(CHAMP);
      expect(lib[0].origin).toMatchObject({ kind: 'training', sessionId: 'tres-rodadas', runId: 'r2', iteration: 2 });
      expect(erros).toEqual([]);
    } finally {
      await contexto.close();
    }
  }, 60_000);

  it('web-code#14 / web-live#15: salvar de novo vira versão; biblioteca 1-based; "Editar texto" cria a próxima', async () => {
    const { page, contexto, erros } = await harnessPage();
    try {
      await montar(page, 'tres-rodadas');
      const rodada = seletorDeRodada(page);
      await expect.poll(() => rodada.inputValue(), { timeout: 10_000 }).toBe('r2');
      await page.getByRole('button', { name: 'Salvar na biblioteca' }).click();
      await page.getByRole('button', { name: 'Salvar', exact: true }).click();
      await page.getByRole('button', { name: 'Salvo', exact: true }).waitFor();

      // Mesmo TEXTO (a variante promovida da rodada 2) → nada de duplicata nem versão falsa.
      await rodada.selectOption('r1');
      await page.getByRole('button', { name: 'Salvar na biblioteca' }).click();
      const salvarComo = page.getByLabel('Salvar como');
      await salvarComo.waitFor();
      expect(await salvarComo.locator('option:checked').textContent()).toContain('Nova versão de “Prompt Campeão atual · rodada 3” (hoje v1)');
      await page.getByRole('button', { name: 'Salvar', exact: true }).click();
      await page.getByRole('button', { name: 'Salvo', exact: true }).waitFor();
      let lib = await biblioteca(page);
      expect(lib).toHaveLength(1);
      expect(lib[0].version).toBe(1);

      // Texto NOVO (o "Formato enxuto" da rodada 1) → v2 do mesmo prompt, com nota.
      await rodada.selectOption('r0');
      await page.getByRole('button', { name: /Formato enxuto/ }).click();
      await page.getByRole('button', { name: 'Salvar na biblioteca' }).click();
      await page.getByLabel('Salvar como').waitFor();
      await page.getByRole('button', { name: 'Salvar', exact: true }).click();
      await page.getByRole('button', { name: 'Salvo', exact: true }).waitFor();
      lib = await biblioteca(page);
      expect(lib).toHaveLength(1);
      expect(lib[0].version).toBe(2);
      expect(lib[0].history.map((h) => h.text)).toEqual([CHAMP, OTHER]);
      expect(lib[0].history[1].note).toMatch(/rodada 1 · Formato enxuto$/);

      // A biblioteca: rodada 1-based (salvo da iteração 2 = "rodada 3"), v2 com
      // diff contra a v1 e a nota da versão.
      await montar(page, 'tres-rodadas', { path: '/prompts', keep: true });
      await page.getByRole('button', { name: /Prompt Campeão atual · rodada 3/ }).click();
      await page.getByText(/Origem: treino · rodada 3/).waitFor();
      expect(await page.getByText(/iteração \d/).count()).toBe(0);
      await page.getByText('diff de v2 vs. v1').waitFor();
      await page.getByText(/Nota da v2: treino tres-rod · rodada 1 · Formato enxuto/).waitFor();

      // "Editar texto" → v3.
      await page.getByRole('button', { name: 'Editar texto' }).click();
      const area = page.getByLabel('Novo texto (vira a v3)');
      await area.fill(`${OTHER}\nResponda em português.`);
      await page.getByLabel('Nota da versão (opcional)').fill('pedido do time');
      await page.getByRole('button', { name: 'Salvar nova versão' }).click();
      await page.getByText('Prompt atual (v3)').waitFor();
      await page.getByText('diff de v3 vs. v2').waitFor();
      lib = await biblioteca(page);
      expect(lib[0].version).toBe(3);
      expect(lib[0].history[2]).toMatchObject({ version: 3, text: `${OTHER}\nResponda em português.`, note: 'pedido do time' });
      expect(erros).toEqual([]);
    } finally {
      await contexto.close();
    }
  }, 90_000);

  it('web-live#11 + IMPL-046 + web-live#17: "Sem holdout", veredito rotulado e o MESMO p no relatório', async () => {
    const { page, contexto, erros } = await harnessPage();
    try {
      await montar(page, 'tres-rodadas');
      await page.getByRole('heading', { name: /Treino/ }).waitFor({ timeout: 10_000 });

      // web-live#11: seleção < 20 cenários nunca teve fatia reservada.
      await page.getByText('Sem holdout', { exact: true }).waitFor();
      expect(await page.getByText('Holdout pulado').count()).toBe(0);

      // IMPL-046: o veredito do `sessions show`, com os braços por nome.
      const rec = page.getByTestId('session-recommendation');
      await rec.waitFor();
      const texto = (await rec.textContent()) ?? '';
      expect(texto).toMatch(/^Recomendação (conclusiva|inconclusiva) \(judge-score\+ci\):/);
      expect(texto).toContain('P(campeão>original)=');
      expect(texto).not.toMatch(/holdout-|\bv2\b/);

      // web-live#17: a tela mostra o BILATERAL (0,002), não o unilateral do gate.
      await page.getByText(/p=0\.002 bilateral/).waitFor();
      expect(await page.getByText(/p=0\.001/).count()).toBe(0);

      await page.getByRole('button', { name: 'Relatório de ciclos' }).click();
      await page.getByText('p-valor bilateral', { exact: true }).waitFor({ timeout: 10_000 });
      await page.getByText('0,002', { exact: true }).waitFor();
      await page.getByText(/p 0,002 bilateral \(gate unilateral 0,001\)/).waitFor();
      // O unilateral sem rótulo (0,0010) não volta ao relatório.
      expect(await page.getByText(/p 0,0010/).count()).toBe(0);
      expect(erros).toEqual([]);
    } finally {
      await contexto.close();
    }
  }, 60_000);
});

describe.skipIf(!alvo)('web-live#2 / web-code#9 — o fim do treino re-renderiza a tela', () => {
  it('session.finished com a MESMA referência mutada: sai "running", "— ao vivo" e o cancelar', async () => {
    const { page, contexto, erros } = await harnessPage();
    try {
      const sid = await montar(page, 'ao-vivo');
      await page.getByRole('button', { name: 'Segure para cancelar' }).waitFor({ timeout: 10_000 });
      await page.getByText('em andamento', { exact: true }).waitFor();
      await page.getByText(/— ao vivo/).waitFor();
      // Sessão em andamento não tem veredito de recomendação ainda.
      expect(await page.getByTestId('session-recommendation').count()).toBe(0);

      // O trainer do navegador: muta o record vivo e emite session.finished com ele.
      await page.evaluate((id) => (window as unknown as { __tvFake: { finish(id: string): void } }).__tvFake.finish(id), sid);

      await page.getByText('concluída', { exact: true }).waitFor({ timeout: 5_000 });
      await expect
        .poll(() => page.getByRole('button', { name: 'Segure para cancelar' }).count(), { timeout: 5_000 })
        .toBe(0);
      await expect.poll(() => page.getByText(/— ao vivo/).count(), { timeout: 5_000 }).toBe(0);
      expect(await page.getByText('em andamento', { exact: true }).count()).toBe(0);
      expect(erros).toEqual([]);
    } finally {
      await contexto.close();
    }
  }, 60_000);
});

/* ============================================================ 2. SPA REAL */

describe.skipIf(!alvo)('IMPL-083 (ii) — 0 violações de CSP com os headers do vercel.json', () => {
  it('rotas: /new, /runs, /prompts, /settings, /welcome, treino e relatório inexistentes', async () => {
    const { page, contexto } = await spaPage();
    try {
      const vistas: Record<string, string[]> = {};
      for (const rota of ['new', 'runs', 'prompts', 'settings', 'welcome', 'training/nao-existe', 'training/nao-existe/report']) {
        await page.goto(`${spaUrl}${rota}`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(300);
        vistas[rota] = await violacoes(page);
      }
      // A sonda de eval do zod (sem `jitless`) aparecia em TODA rota.
      expect(vistas).toEqual(Object.fromEntries(Object.keys(vistas).map((r) => [r, []])));
    } finally {
      await contexto.close();
    }
  }, 90_000);

  it('os 3 AnimatePresence popLayout: botão da key, CopyButton e chips do seletor', async () => {
    const { page, contexto, chamadas } = await spaPage();
    try {
      // (1) MultiStateButton da key (Configurações): revalidar troca o rótulo 2×
      // (conectada → validando → conectada) — com o GET /key de verdade no fio.
      await page.goto(`${spaUrl}settings`);
      await page.getByRole('button', { name: /Key conectada|Validar e conectar/ }).click();
      await expect.poll(() => chamadas.some((c) => /\/api\/v1\/key(\?|$)/.test(c.url)), { timeout: 10_000 }).toBe(true);
      await page.getByRole('button', { name: /Key conectada/ }).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(600);
      expect(await violacoes(page), 'MultiStateButton').toEqual([]);

      // (2) CopyButton da biblioteca: o ícone troca por popLayout.
      await page.goto(`${spaUrl}prompts`);
      await page.waitForLoadState('networkidle');
      await semearPrompt(page, { id: 'e2e-copy', name: 'Prompt para copiar', text: ORIG });
      await page.reload();
      await page.getByRole('button', { name: /Prompt para copiar/ }).click();
      await page.getByRole('button', { name: 'Copiar prompt' }).click();
      await page.getByRole('button', { name: 'Prompt copiado' }).waitFor({ timeout: 5_000 });
      await page.waitForTimeout(600);
      expect(await violacoes(page), 'CopyButton').toEqual([]);

      // (3) Chips do seletor de modelos (Nova Run): adicionar e remover um chip.
      await page.goto(`${spaUrl}new`);
      await page.waitForSelector('[aria-label="Iniciar a run"]', { timeout: 30_000 });
      const sujeitos = page.locator('#sec-sujeitos');
      await sujeitos.getByRole('button', { name: 'adicionar', exact: true }).click();
      await page.locator('[role="option"]').first().click();
      await page.keyboard.press('Escape');
      const remover = sujeitos.getByRole('button', { name: /^Remover / }).first();
      await remover.waitFor({ timeout: 5_000 });
      await remover.click();
      await page.waitForTimeout(600);
      expect(await violacoes(page), 'chips do ModelSelector').toEqual([]);
    } finally {
      await contexto.close();
    }
  }, 120_000);
});

describe.skipIf(!alvo)('web-live#9 — "Usar como base" chega à Nova Run', () => {
  it('a Nova Run monta UMA vez (no wrapper que entra) e recebe o rascunho da biblioteca', async () => {
    const { page, contexto } = await spaPage();
    try {
      await page.goto(`${spaUrl}prompts`);
      await page.waitForLoadState('networkidle');
      const texto = 'Você é um assistente de testes.\nResponda só com fatos do contexto.';
      await semearPrompt(page, { id: 'e2e-base', name: 'Base da biblioteca', text: texto });
      await page.reload();
      await page.getByRole('button', { name: /Base da biblioteca/ }).click();
      // Marca o wrapper da transição que vai SAIR: o que conta é a Nova Run do
      // wrapper que ENTRA, depois de a transição assentar. (Antes, a Nova Run
      // montava também no wrapper que saía, consumia o rascunho e mostrava o
      // aviso por ~½ s — depois era descartada e a que ficava não tinha nada.)
      await page.evaluate(() => document.querySelector('main > div')?.setAttribute('data-e2e-saindo', ''));
      await page.getByRole('button', { name: 'Usar como base' }).click();
      await page.waitForURL(/\/new$/);
      const entrou = page.locator('main > div:not([data-e2e-saindo])');
      await entrou.waitFor({ timeout: 10_000 });
      await expect.poll(() => page.locator('main > div').count(), { timeout: 10_000 }).toBe(1);
      await expect.poll(() => entrou.evaluate((el) => getComputedStyle(el).opacity), { timeout: 10_000 }).toBe('1');
      await entrou.getByText("Prompt 'Base da biblioteca' carregado da biblioteca.").waitFor({ timeout: 5_000 });
      expect(await page.evaluate(() => localStorage.getItem('arena:prompt-draft'))).toBeNull();
      // E o texto está no campo "Prompt base" (a Nova Run troca para um modo de
      // prompts: em 'compare' o campo nem existe e o rascunho sumiria no envio).
      const valores = await entrou
        .locator('textarea')
        .evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value));
      expect(valores).toContain(texto);
      expect(await violacoes(page)).toEqual([]);
    } finally {
      await contexto.close();
    }
  }, 60_000);
});

describe.skipIf(!alvo)('IMPL-120 — atribuição (HTTP-Referer/X-Title) desligável nas Configurações', () => {
  it('desligar tira os DOIS headers do fio já na próxima chamada, e a escolha sobrevive ao reload', async () => {
    const { page, contexto, chamadas } = await spaPage();
    const eKey = (u: string) => /\/api\/v1\/key(\?|$)/.test(u);
    const ultimaKey = () => [...chamadas].reverse().find((c) => eKey(c.url))!;
    const revalidar = async () => {
      const antes = chamadas.length;
      await page.getByRole('button', { name: /Key conectada|Validar e conectar/ }).click();
      await expect.poll(() => chamadas.slice(antes).some((c) => eKey(c.url)), { timeout: 10_000 }).toBe(true);
      await page.getByRole('button', { name: /Key conectada/ }).waitFor({ timeout: 10_000 });
    };
    try {
      await page.goto(`${spaUrl}settings`);
      const chave = page.getByRole('switch', { name: 'Identificar o app para a OpenRouter' });
      await chave.waitFor();
      // Default: ligado — e declarado na tela como dado enviado à OpenRouter.
      expect(await chave.getAttribute('aria-checked')).toBe('true');
      await revalidar();
      expect(ultimaKey().headers['x-title']).toBe('Prompt Builder');
      expect(ultimaKey().headers['http-referer']).toBe(spaUrl.replace(/\/$/, ''));

      await chave.click();
      expect(await chave.getAttribute('aria-checked')).toBe('false');
      await revalidar();
      expect(ultimaKey().headers).not.toHaveProperty('x-title');
      expect(ultimaKey().headers).not.toHaveProperty('http-referer');
      // A autenticação não muda — só a atribuição sai do fio.
      expect(ultimaKey().headers.authorization).toBe('Bearer sk-or-v1-e2e-nao-real-000000000000');

      // Reload: a preferência vem do navegador e o gateway já nasce sem atribuição.
      await page.reload();
      await chave.waitFor();
      expect(await chave.getAttribute('aria-checked')).toBe('false');
      await revalidar();
      expect(ultimaKey().headers).not.toHaveProperty('x-title');

      // Religar devolve os dois.
      await chave.click();
      await revalidar();
      expect(ultimaKey().headers['x-title']).toBe('Prompt Builder');
      expect(await violacoes(page)).toEqual([]);
    } finally {
      await contexto.close();
    }
  }, 60_000);
});
