// IMPL-100 (R-16:REC-6) — critério (3): E2E num browser REAL com Playwright
// `launch_persistent_context` (perfil persistente = o caso do "limpar dados do
// site") a verificar que o wipe da SPA faz `indexedDB.deleteDatabase` do banco
// INTEIRO e que o `navigator.storage.estimate()` volta a ≈ 0.
//
// Por que browser de verdade: o apagamento LÓGICO (`idbDelete`) deixa tombstones
// recuperáveis no LevelDB (crbug 40418460) — o fake IndexedDB do teste unitário
// (`test/lgpd-retention.test.ts`) não reproduz isso; só o motor real prova que
// `deleteDatabase` tira o dado do disco.
//
// O que corre aqui (MÓDULO REAL, não uma reimplementação):
//   • `web/src/lgpd.ts` + `web/src/idb.ts` são empacotados como estão (esbuild,
//     sem cópia de código) e servidos a uma página em 127.0.0.1;
//   • o contexto é PERSISTENTE (`launchPersistentContext`, diretório de perfil
//     novo por execução) — o dado precisa sobreviver a reload antes do wipe;
//   • o teste mede `navigator.storage.estimate()` antes/depois por conta própria
//     (não confia só no retorno do módulo).
//
// Browser: PB_E2E_CHROMIUM (caminho explícito) → chromium do playwright-core
// (`~/.cache/ms-playwright`, `npx playwright-core install chromium`) → Chrome/
// Chromium/Brave do sistema. Sem NENHUM browser o teste é PULADO COM AVISO —
// nunca verde mudo; o aviso diz como ligar. No CI (ubuntu-latest) o Chrome do
// runner serve e o E2E corre mesmo.

import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * "≈ 0" do critério: folga residual REAL medida no Chromium após
 * `deleteDatabase` (manifest/WAL do LevelDB do banco derrubado) fica em
 * ~4.6 KB — o teto aceita isso e NUNCA um payload de run (que entra por
 * centenas de KB). A queda relativa (> 90%) é exigida à parte.
 */
const ZERO_TOLERANCE_BYTES = 8 * 1024;

interface BrowserAlvo {
  /** `undefined` = deixar o playwright-core resolver o chromium empacotado. */
  executablePath?: string;
  origem: string;
}

/** Onde está um browser para o E2E (ordem: env → playwright-core → sistema). */
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
    '[lgpd-wipe-e2e] SEM BROWSER — o critério (3) do IMPL-100 não foi verificado nesta máquina.\n' +
      '                 Ligue com: npx playwright-core install chromium\n' +
      '                 (ou instale Chrome/Chromium/Brave, ou exporte PB_E2E_CHROMIUM=<caminho>).',
  );
}

let tmp: string;
let servidor: Server;
let url: string;
let contexto: BrowserContext;
let page: Page;

const HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>wipe LGPD</title></head>
<body><script type="module">
  import * as h from './harness.js';
  window.__harness = h;
  // carga INCOMPRESSÍVEL (hex aleatório): 'xxxx…' comprime-se no LevelDB e o
  // estimate não contabilizaria o dado guardado. Em blocos de ≤ 65536 bytes —
  // teto do getRandomValues por chamada.
  window.cargaAleatoria = (n) => {
    let s = '';
    for (let off = 0; off < n; off += 65536) {
      const b = crypto.getRandomValues(new Uint8Array(Math.min(65536, n - off)));
      s += Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    }
    return s;
  };
  window.__pronto = true;
</script></body></html>`;

beforeAll(async () => {
  if (!alvo) return;
  tmp = mkdtempSync(join(tmpdir(), 'pb-lgpd-e2e-'));

  // Harness = os MÓDULOS REAIS empacotados (web/src/lgpd.ts = shim da SPA e
  // web/src/idb.ts = quem abre o banco). Nenhuma reimplementação de lógica.
  writeFileSync(
    join(tmp, 'entry.ts'),
    `export * as lgpd from ${JSON.stringify(join(ROOT, 'web/src/lgpd.ts'))};\n` +
      `export * as idb from ${JSON.stringify(join(ROOT, 'web/src/idb.ts'))};\n`,
    'utf-8',
  );
  await build({
    entryPoints: [join(tmp, 'entry.ts')],
    outfile: join(tmp, 'harness.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
  });
  writeFileSync(join(tmp, 'index.html'), HTML, 'utf-8');

  servidor = createServer((req, res) => {
    const alvoRota = (req.url ?? '/').split('?')[0];
    if (alvoRota === '/harness.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(readFileSync(join(tmp, 'harness.js')));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const end = servidor.address();
  if (!end || typeof end === 'string') throw new Error('servidor E2E sem porta');
  url = `http://127.0.0.1:${end.port}/`;

  // CONTEXTO PERSISTENTE (critério): perfil de disco real, como o "limpar dados
  // do site" do navegador exige. Perfil novo por execução ⇒ determinístico.
  contexto = await chromium.launchPersistentContext(join(tmp, 'perfil'), {
    headless: true,
    ...(alvo.executablePath ? { executablePath: alvo.executablePath } : {}),
  });
  page = contexto.pages()[0] ?? (await contexto.newPage());
  await page.goto(url);
  await page.waitForFunction(() => (window as unknown as { __pronto?: boolean }).__pronto === true);
}, 180_000);

afterAll(async () => {
  await contexto?.close();
  await new Promise<void>((ok) => (servidor ? servidor.close(() => ok()) : ok()));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!alvo)('IMPL-100 (3) E2E browser: deleteDatabase + storage.estimate ≈ 0', () => {
  it('o dado escrito no perfil persistente SOBREVIVE a um reload (premissa do critério)', async () => {
    const r = await page.evaluate(async () => {
      const { idb } = (window as unknown as { __harness: { idb: typeof import('../web/src/idb.js') } }).__harness;
      const cargaAleatoria = (window as unknown as { cargaAleatoria: (n: number) => string }).cargaAleatoria;
      await idb.idbPut('runs', { id: 'e2e-run-1', carga: cargaAleatoria(60_000) });
      return { antes: (await idb.idbGetAll('runs')).length };
    });
    expect(r.antes).toBe(1);

    await page.reload();
    await page.waitForFunction(() => (window as unknown as { __pronto?: boolean }).__pronto === true);

    const depois = await page.evaluate(async () => {
      const { idb } = (window as unknown as { __harness: { idb: typeof import('../web/src/idb.js') } }).__harness;
      return (await idb.idbGetAll('runs')).length;
    });
    expect(depois).toBe(1); // persistente de verdade: reload não zera o banco
  }, 60_000);

  it('wipeLocalData: deleteDatabase do banco INTEIRO e estimate volta a ≈ 0', async () => {
    const r = await page.evaluate(async () => {
      const { lgpd, idb } = (window as unknown as {
        __harness: {
          lgpd: typeof import('../web/src/lgpd.js');
          idb: typeof import('../web/src/idb.js');
        };
      }).__harness;
      // carga INCOMPRESSÍVEL: o LevelDB comprime 'xxxx…' para bytes e o
      // estimate não refletiria o dado guardado (medido: 240 KB → 16 KB).
      const cargaAleatoria = (window as unknown as { cargaAleatoria: (n: number) => string }).cargaAleatoria;
      await idb.idbPut('runs', { id: 'e2e-run-2', carga: cargaAleatoria(120_000) });
      await idb.idbPut('prompts', { id: 'e2e-prompt-2', carga: cargaAleatoria(120_000) });
      // medida INDEPENDENTE do teste (não confia só no retorno do módulo):
      // o `usage` do QuotaManager só atualiza em lote, por isso se ASSENTA
      // antes de cada leitura (amostras iguais = contabilização parada).
      const assentar = async (): Promise<number> => {
        let anterior = -1;
        let atual = (await navigator.storage.estimate()).usage ?? 0;
        for (let i = 0; i < 8 && atual !== anterior; i++) {
          anterior = atual;
          await new Promise((res) => setTimeout(res, 100));
          atual = (await navigator.storage.estimate()).usage ?? 0;
        }
        return atual;
      };
      const estAntes = await assentar();
      const dbsAntes = (await indexedDB.databases()).map((d) => d.name ?? '');
      const res = await lgpd.wipeLocalData();
      const estDepois = await assentar();
      const dbsDepois = (await indexedDB.databases()).map((d) => d.name ?? '');
      const runsDepois = (await idb.idbGetAll('runs')).length;
      return {
        estAntes: { usage: estAntes },
        estDepois: { usage: estDepois },
        dbsAntes,
        dbsDepois,
        res,
        runsDepois,
      };
    });

    // apagamento TOTAL (não é o delete lógico que deixa tombstone)
    expect(r.res.deleted).toBe(true);
    expect(r.res.blocked).toBe(false);
    // deleteDatabase verificado: o banco que o idb.ts abriu SOME do catálogo
    expect(r.dbsAntes).toContain('prompt-builder');
    expect(r.dbsDepois).not.toContain('prompt-builder');
    // storage.estimate() ≈ 0 (critério). A folga residual medida do Chromium
    // (manifest/WAL do LevelDB após deleteDatabase) fica em ~4.6 KB; aceitamos
    // ZERO_TOLERANCE_BYTES e ainda exigimos queda > 90% do que foi guardado.
    expect(r.estAntes.usage).toBeGreaterThan(50_000); // o dado escrito conta
    expect(r.estDepois.usage).toBeLessThanOrEqual(ZERO_TOLERANCE_BYTES);
    expect(r.res.estimateAfter.usage).toBeLessThanOrEqual(ZERO_TOLERANCE_BYTES);
    expect(r.estDepois.usage).toBeLessThan(r.estAntes.usage / 10); // cai >90%
    expect(r.runsDepois).toBe(0);
  }, 60_000);

  it('wipe NÃO some com o que está fora do IndexedDB — daí as instruções de "limpar dados do site"', async () => {
    const r = await page.evaluate(async () => {
      const { lgpd, idb } = (window as unknown as {
        __harness: {
          lgpd: typeof import('../web/src/lgpd.js');
          idb: typeof import('../web/src/idb.js');
        };
      }).__harness;
      localStorage.setItem('pb.retentionDays', '30');
      await idb.idbPut('runs', { id: 'e2e-run-3' });
      const res = await lgpd.wipeLocalData();
      return {
        localStorageApos: localStorage.getItem('pb.retentionDays'),
        runsApos: (await idb.idbGetAll('runs')).length,
        instrucoes: lgpd.siteWipeInstructions().join('\n'),
        deleted: res.deleted,
      };
    });
    expect(r.deleted).toBe(true);
    expect(r.runsApos).toBe(0);
    // honestidade do produto: localStorage/caches ficam ⇒ a tela de apagar
    // TEM de mostrar o passo "limpar dados do site" (3 navegadores)
    expect(r.localStorageApos).toBe('30');
    expect(r.instrucoes).toMatch(/limpar dados do site/iu);
    expect(r.instrucoes).toMatch(/Chrome/u);
    expect(r.instrucoes).toMatch(/Firefox/u);
    expect(r.instrucoes).toMatch(/Safari/u);
  }, 60_000);
});