// Modo JEV — E2E num Chromium REAL (chunk 2, D-13): o motor roda NA ABA e fala
// direto com o endpoint de decisões, SEM proxy. O que só um browser de verdade
// prova, e o fake de `fetch` dos testes unitários não:
//
//  (1) CORS aberto como o de produção (preflight 204, `Allow-Origin: *`,
//      `Authorization`/`HTTP-Referer`/`X-Title` permitidos, `X-Generation-Id`
//      EXPOSTO): a run de exemplo fecha na aba, o `generationId` vem do HEADER
//      (o corpo traz outro id: sem o expose, o browser esconderia o header) e o
//      custo do record = a fatura do servidor falso;
//  (2) CORS fechado no endpoint de decisões (o preflight volta sem
//      `Allow-Origin`): o fetch falha sem resposta HTTP, com a mensagem REAL do
//      Chromium, e `networkDiagnosis` a reconhece (é o banner que manda para o
//      caminho reserva — o terminal).
//
// Os servidores são DOIS, em portas diferentes (origens diferentes), para o
// CORS valer de verdade: a página (harness com os MÓDULOS REAIS empacotados)
// e a "OpenRouter" falsa. Zero rede externa, zero gasto.
//
// Browser: a mesma resolução de `lgpd-wipe-e2e` (PB_E2E_CHROMIUM → chromium do
// playwright-core → Chrome/Chromium/Brave do sistema). Sem browser: PULADO COM
// AVISO, nunca verde mudo.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { DECISION_CATALOG, oracleJev } from './fakeDecisions.js';
import type { FakeRequest } from './fakeOpenRouter.js';
import { jevExample, type JevRunRecord } from '../src/engine/jev/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'sk-or-v1-fake-key-para-teste-e2e-000000000';

function resolverBrowser(): { executablePath?: string } | null {
  const env = process.env.PB_E2E_CHROMIUM;
  if (env && existsSync(env)) return { executablePath: env };
  try {
    const proprio = chromium.executablePath();
    if (proprio && existsSync(proprio)) return {};
  } catch {
    // sem registry do playwright para esta plataforma — segue para o sistema
  }
  for (const bin of ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/brave', '/usr/bin/brave-browser']) {
    if (existsSync(bin)) return { executablePath: bin };
  }
  return null;
}

const alvo = resolverBrowser();
if (!alvo) {
  console.warn('[web-jev-browser-e2e] SEM BROWSER — o CORS do modo JEV na aba não foi verificado. Ligue com: npx playwright-core install chromium');
}

/** Config pequena (6 casos do exemplo de triagem): 6 decisões por run. */
const EX = jevExample('triagem', 'eval') as { cases: { id: string; state: unknown; expected: Record<string, unknown> }[] } & Record<string, unknown>;
const CFG = { ...EX, theme: 'E2E navegador', cases: EX.cases.slice(0, 6), budgetUsd: 0.05 };
const OURO = new Map(CFG.cases.map((c) => [JSON.stringify(c.state), c.expected]));
const oraculo = oracleJev({ goldOf: (state, qid) => OURO.get(JSON.stringify(state))?.[qid] });

/** Espelho dos headers de CORS que a OpenRouter devolve HOJE (sondado ao vivo em 2026-09-29). */
const CORS_PRODUCAO: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization,User-Agent,Accept,Content-Type,HTTP-Referer,X-Title,X-Openrouter-Title',
  'access-control-allow-methods': 'GET,OPTIONS,PATCH,DELETE,POST,PUT',
  'access-control-expose-headers': 'X-Generation-Id,X-Provider-Name,request-id,cf-ray',
};

let tmp: string;
let pagina: Server;
let api: Server;
let paginaUrl: string;
let apiBase: string;
let browser: Browser;
let page: Page;

/** Estado do servidor falso (por teste). */
const estado = {
  corsDecisoes: true,
  faturado: 0,
  posts: [] as { origin?: string; auth?: string }[],
  preflights: 0,
};

const HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>JEV e2e</title></head>
<body><script type="module">
  import * as h from './harness.js';
  window.__h = h;
  window.__pronto = true;
</script></body></html>`;

function lerCorpo(req: IncomingMessage): Promise<string> {
  return new Promise((ok) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => ok(s));
  });
}

async function apiHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const decisoes = url.pathname === '/api/alpha/decisions';
  const cors = decisoes && !estado.corsDecisoes ? {} : CORS_PRODUCAO;
  if (req.method === 'OPTIONS') {
    if (decisoes) estado.preflights++;
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/models') {
    const data = url.searchParams.get('output_modalities') === 'decisions' ? DECISION_CATALOG : [];
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ data }));
    return;
  }
  if (req.method === 'POST' && decisoes) {
    const body = JSON.parse(await lerCorpo(req)) as { model: string; state: unknown; questions: Record<string, unknown> };
    estado.posts.push({ origin: req.headers.origin, auth: req.headers.authorization });
    const n = estado.posts.length;
    const reply = oraculo({ state: body.state, questions: body.questions } as unknown as FakeRequest);
    const cost = 0.0000175;
    estado.faturado += cost;
    res.writeHead(200, {
      ...cors,
      'content-type': 'application/json',
      // header ≠ corpo: só lendo o HEADER (exposto pelo CORS) o id sai "hdr"
      'x-generation-id': `gen-dec-hdr-${n}`,
      'x-provider-name': 'TypeSafe',
    });
    res.end(
      JSON.stringify({
        model: 'typesafe/jev-1.13-20260917',
        answers: reply.answers,
        usage: { input_tokens: 417, output_tokens: 0, cost },
        id: `gen-dec-body-${n}`,
        provider: 'TypeSafe',
      }),
    );
    return;
  }
  res.writeHead(404, cors);
  res.end('{}');
}

async function ouvir(s: Server): Promise<number> {
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  const end = s.address();
  if (!end || typeof end === 'string') throw new Error('servidor sem porta');
  return end.port;
}

beforeAll(async () => {
  if (!alvo) return;
  tmp = mkdtempSync(join(tmpdir(), 'pb-jev-e2e-'));
  // Harness = MÓDULOS REAIS da SPA empacotados (sem reimplementação): o
  // `startJev` da aba, o gateway (via o shim do navegador), o IndexedDB v3.
  writeFileSync(
    join(tmp, 'entry.ts'),
    [
      `export * as jev from ${JSON.stringify(join(ROOT, 'web/src/jev/api.ts'))};`,
      `export * as transfer from ${JSON.stringify(join(ROOT, 'web/src/jev/transfer.ts'))};`,
      `export { setStoredKey } from ${JSON.stringify(join(ROOT, 'web/src/api.ts'))};`,
      `export { configureGateway } from ${JSON.stringify(join(ROOT, 'src/openrouter.ts'))};`,
      '',
    ].join('\n'),
    'utf-8',
  );
  await build({ entryPoints: [join(tmp, 'entry.ts')], outfile: join(tmp, 'harness.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' });

  pagina = createServer((req, res) => {
    if ((req.url ?? '/').split('?')[0] === '/harness.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(readFileSync(join(tmp, 'harness.js')));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
  });
  api = createServer((req, res) => void apiHandler(req, res));
  paginaUrl = `http://127.0.0.1:${await ouvir(pagina)}/`;
  // Outra PORTA = outra ORIGEM: o browser aplica CORS de verdade.
  apiBase = `http://127.0.0.1:${await ouvir(api)}/api/v1`;

  browser = await chromium.launch({ headless: true, ...(alvo.executablePath ? { executablePath: alvo.executablePath } : {}) });
  page = await (await browser.newContext()).newPage();
  await page.goto(paginaUrl);
  await page.waitForFunction(() => (window as unknown as { __pronto?: boolean }).__pronto === true);
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((ok) => (pagina ? pagina.close(() => ok()) : ok()));
  await new Promise<void>((ok) => (api ? api.close(() => ok()) : ok()));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Roda a config NA ABA e devolve o record final (lido do IndexedDB real). */
async function rodarNaAba(aba: Page = page): Promise<{ run: JevRunRecord; diagnostico: unknown }> {
  return aba.evaluate(
    async ({ cfg, key, base }) => {
      type H = {
        jev: typeof import('../web/src/jev/api.js');
        transfer: typeof import('../web/src/jev/transfer.js');
        setStoredKey: (k: string) => void;
        configureGateway: (c: { baseUrl: string }) => void;
      };
      const h = (window as unknown as { __h: H }).__h;
      h.setStoredKey(key);
      h.configureGateway({ baseUrl: base });
      const { id } = await h.jev.startJev(cfg as never);
      const t0 = Date.now();
      for (;;) {
        const r = await h.jev.getJevRun(id);
        if (r && r.status !== 'running' && !h.jev.canCancelJev(id)) {
          return { run: JSON.parse(JSON.stringify(r)) as JevRunRecord, diagnostico: h.transfer.networkDiagnosis(r) };
        }
        if (Date.now() - t0 > 30_000) throw new Error(`timeout: run ${id} ainda ${r?.status}`);
        await new Promise((ok) => setTimeout(ok, 50));
      }
    },
    { cfg: CFG, key: KEY, base: apiBase },
  );
}

describe.skipIf(!alvo)('JEV na aba — Chromium real, CORS de verdade', () => {
  it('(1) CORS aberto (como produção): run fecha na aba, id do HEADER exposto, custo = fatura', async () => {
    estado.corsDecisoes = true;
    estado.faturado = 0;
    estado.posts = [];
    estado.preflights = 0;
    const { run, diagnostico } = await rodarNaAba();

    expect(run.client).toBe('browser');
    expect(run.status).toBe('finished');
    expect(run.cells.filter((c) => c.status === 'ok')).toHaveLength(6);
    expect(estado.posts).toHaveLength(6);
    // Cross-origin de verdade: o browser mandou Origin (a página) e o Bearer.
    expect(estado.posts.every((p) => p.origin === paginaUrl.replace(/\/$/, '') && p.auth === `Bearer ${KEY}`)).toBe(true);
    // Authorization + Content-Type JSON = request "não simples": houve preflight.
    expect(estado.preflights).toBeGreaterThanOrEqual(1);
    // `x-generation-id` só é legível porque o CORS o EXPÕE; o corpo tem outro id.
    expect(run.cells.every((c) => /^gen-dec-hdr-\d+$/.test(c.generationId ?? ''))).toBe(true);
    expect(run.cells.every((c) => c.provider === 'TypeSafe' && c.resolvedModel === 'typesafe/jev-1.13-20260917')).toBe(true);
    // Dinheiro MEDIDO: o record soma o `usage.cost` que o servidor cobrou.
    expect(run.totalCostUsd).toBeCloseTo(estado.faturado, 12);
    expect(run.metrics[run.contestants[0].id].accuracy).toBe(1);
    expect(diagnostico).toBeNull();
  }, 60_000);

  it('(2) CORS fechado no endpoint de decisões: falha SEM resposta HTTP e o diagnóstico de rede reconhece a mensagem real do Chromium', async () => {
    estado.corsDecisoes = false;
    estado.faturado = 0;
    estado.posts = [];
    // Contexto NOVO: o Chromium guarda o preflight aprovado no (1) por alguns
    // segundos (cache de preflight por contexto de rede) e mandaria o POST.
    const aba = await (await browser.newContext()).newPage();
    await aba.goto(paginaUrl);
    await aba.waitForFunction(() => (window as unknown as { __pronto?: boolean }).__pronto === true);
    const { run, diagnostico } = await rodarNaAba(aba);

    // O preflight barra: o POST nem chega ao servidor.
    expect(estado.posts).toHaveLength(0);
    expect(run.cells.every((c) => c.status === 'error')).toBe(true);
    expect(run.cells[0].error?.message).toMatch(/failed to fetch/i);
    expect(run.status).not.toBe('finished');
    expect(diagnostico).toEqual({ failed: 6, attempted: 6, total: true });
    // Preflight barrado: o POST não saiu, então nada foi cobrado nem fica pendente.
    // (Limite conhecido: se o preflight passasse e só a RESPOSTA fosse barrada, o
    // servidor cobraria e a aba veria o mesmo "Failed to fetch" — o banner avisa.)
    expect(run.cost.totalUsd).toBe(0);
  }, 60_000);
});
