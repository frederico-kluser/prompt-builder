// Mede as paradas de Tab REAIS do formulário (superfície COMPLETA, modo
// variation) e imprime cada foco — diagnóstico do gate IMPL-106 (c).
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = join(ROOT, 'web', 'dist');
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

function browserBin() {
  const env = process.env.PB_E2E_CHROMIUM;
  if (env && existsSync(env)) return env;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {}
  for (const b of ['/usr/bin/chromium', '/usr/bin/google-chrome-stable', '/usr/bin/brave']) if (existsSync(b)) return b;
  return null;
}

const servidor = createServer((req, res) => {
  const rota = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const arquivo = join(DIST, rota === '/' ? 'index.html' : rota.replace(/^\/+/, ''));
  const alvo = existsSync(arquivo) && !rota.endsWith('/') ? arquivo : join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TIPOS[extname(alvo)] ?? 'application/octet-stream' });
  res.end(readFileSync(alvo));
});
await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${servidor.address().port}/`;

const navegador = await chromium.launch({ headless: true, ...(browserBin() ? { executablePath: browserBin() } : {}) });
const ctx = await navegador.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.addInitScript(() => {
  localStorage.setItem('openrouter_api_key', 'sk-or-e2e-nao-real');
  localStorage.setItem('openrouter_api_key:remember', '1');
  localStorage.setItem('pb.formStyle', 'complete');
});
await page.route('**/*', (route) => {
  const u = route.request().url();
  if (u.includes('/api/v1/models')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  }
  return u.startsWith(url) ? route.continue() : route.abort();
});
await page.goto(`${url}new`);
await page.waitForSelector('[aria-label="Iniciar a run"]', { timeout: 30000 });
await page.getByRole('button', { name: 'Testar prompts', exact: true }).click();
await page.waitForTimeout(300);

const descreve = () =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return '—';
    const grupo = el.closest('[role="toolbar"]')?.getAttribute('aria-label') ?? el.closest('section,div[id]')?.id ?? '';
    return `${el.tagName.toLowerCase()}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''}${el.textContent?.trim() ? ` «${el.textContent.trim().slice(0, 30)}»` : ''}${grupo ? ` {grupo: ${grupo}}` : ''}`;
  });

await page.evaluate(() => {
  const form = document.querySelector('form');
  const primeiro = form?.querySelector('button:not([tabindex="-1"]), input:not([type="hidden"]), select, textarea, a[href]');
  primeiro?.focus();
});
console.log(`0: ${await descreve()}`);
for (let i = 1; i <= 30; i++) {
  await page.keyboard.press('Tab');
  console.log(`${i}: ${await descreve()}`);
  const noIniciar = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Iniciar a run');
  if (noIniciar) break;
}
await page.waitForTimeout(2000);
console.log('--- toolbars no DOM (2 s depois) ---');
console.log(
  (await page.evaluate(() =>
    [...document.querySelectorAll('[role="toolbar"]')].map(
      (t) => `${t.getAttribute('aria-label')} -> ${[...t.querySelectorAll('button')].map((b) => `${b.getAttribute('aria-label') ?? b.textContent?.trim()}(${b.getAttribute('tabindex') ?? '0'})`).join(' | ')}`,
    ),
  )).join('\n'),
);
await navegador.close();
servidor.close();
