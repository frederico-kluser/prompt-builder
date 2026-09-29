// Contratos da superfície HTTP do servidor de dev/self-host (cluster
// http-api, onda 1): #4 redação × rotas da API, #5 validate-key com corpo
// não-string, #6 404 JSON em /v1, #7 headers de segurança iguais aos da
// Vercel, #8 fallback de SPA só para navegação, #9 CSV sem injeção de fórmula
// e sem CR solto, #10 doctor sem lixo em tmp/.
//
// Pedidos por `http.request` CRU (Host/Accept exatamente como escritos).
// Zero rede externa: o gateway padrão é um OpenRouter falso.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_CSP,
  BASELINE_SECURITY_HEADERS,
  apiSecurityHeaders,
  createApp,
  loadSecurityHeaders,
  startServer,
} from '../src/server.js';
import { getDataDir, saveRun, setDataDir } from '../src/storage.js';
import { redactPaths } from '../src/pathSafety.js';
import { csvCell, csvRow } from '../src/engine/csv.js';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import type { RunRecord } from '../src/types.js';
import { fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'sk-or-v1-fake-key-para-teste-0000000000000000000000000000';

interface Resp {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function req(
  port: number,
  rota: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port,
        path: rota,
        method: opts.method ?? 'GET',
        headers: { host: `localhost:${port}`, ...opts.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    r.on('error', reject);
    r.end(opts.body);
  });
}

function vercelHeaders(): Array<{ key: string; value: string }> {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf-8')) as {
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };
  return cfg.headers.find((h) => h.source === '/(.*)')!.headers;
}

function runComTextoHostil(id: string): RunRecord {
  return {
    id,
    status: 'finished',
    mode: 'compare',
    config: {
      mode: 'compare',
      theme: 'csv',
      stages: 1,
      datagenModelId: 'a/gen',
      judgeModelIds: ['a/judge'],
      competitorModelIds: ['a/x', 'a/y'],
    },
    contestants: [{ id: 'a/x', label: 'a/x', modelId: 'a/x' }],
    stages: [
      {
        index: 0,
        status: 'judged',
        spec: { question: '=HYPERLINK("http://evil.example","clique")', productContext: '', maxTokens: 10, rubric: '' },
        responses: [
          {
            contestantId: 'a/x',
            modelId: 'a/x',
            status: 'ok',
            text: 'linha 1\rlinha 2',
            latencyMs: 12,
            tokensIn: 3,
            tokensOut: 4,
            costUsd: -0.5, // número negativo: NÃO pode virar texto
            errorMsg: '@SUM(1+1)',
          },
        ],
      },
    ],
    scoreboard: {},
    totalCostUsd: 0,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  } as unknown as RunRecord;
}

// ---------------------------------------------------------------------------

describe('http-api#9 — célula CSV (fonte única src/engine/csv.ts)', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+cmd', "'+cmd"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tTAB', "'\tTAB"],
  ])('string que começa como fórmula (%j) é neutralizada', (entrada, esperado) => {
    expect(csvCell(entrada)).toBe(esperado);
  });

  it('número negativo continua número; null/undefined viram vazio; texto comum intacto', () => {
    expect(csvCell(-0.5)).toBe('-0.5');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('resposta normal')).toBe('resposta normal');
  });

  it('CR solto, LF, vírgula e aspas são citados (RFC 4180)', () => {
    expect(csvCell('a\rb')).toBe('"a\rb"');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('diz "oi"')).toBe('"diz ""oi"""');
    // CR no início: neutralizado E citado
    expect(csvCell('\rx')).toBe(`"'\rx"`);
    expect(csvRow(['a', -1, '=x'])).toBe("a,-1,'=x");
  });

  it('o SPA usa a MESMA função (shim), não uma cópia', async () => {
    const web = await import('../web/src/engine/csv.js');
    expect(web.csvCell).toBe(csvCell);
    const runView = readFileSync(path.join(ROOT, 'web', 'src', 'pages', 'RunView.tsx'), 'utf-8');
    expect(runView).not.toMatch(/function csvEscape/u);
    for (const rota of ['routes.ts', 'agentRoutes.ts']) {
      expect(readFileSync(path.join(ROOT, 'src', rota), 'utf-8'), rota).not.toMatch(/function csvEscape/u);
    }
  });
});

describe('http-api#4 — redação de caminho não mutila rota da API', () => {
  it('rota /v1/... e /health sobrevivem; caminho de disco continua redigido', () => {
    expect(redactPaths('Modo treino usa POST /v1/benchmark/sessions.', [])).toBe(
      'Modo treino usa POST /v1/benchmark/sessions.',
    );
    expect(redactPaths("use '/v1/benchmark/runs/abc/cancel'", [])).toBe("use '/v1/benchmark/runs/abc/cancel'");
    expect(redactPaths('POST /v1/benchmark/runs/<id>/cancel', [])).toBe('POST /v1/benchmark/runs/<id>/cancel');
    expect(redactPaths('GET /health falhou', [])).toBe('GET /health falhou');
    // só o 1º segmento EXATO: parecido não passa
    expect(redactPaths('open /v1x/segredo/a.json', [])).toBe('open <caminho>/a.json');
    expect(redactPaths('open /healthz/a.json', [])).toBe('open <caminho>/a.json');
    expect(redactPaths("ENOENT: open '/srv/dados/v1/x.json'", [])).toBe("ENOENT: open '<caminho>/x.json'");
    // a home continua redigida mesmo depois de um marcador <x>
    expect(redactPaths('arquivo <x>/home/fulano/a.json', ['/home/fulano'])).toBe('arquivo <x><caminho>/a.json');
  });
});

describe('http-api#5/#6/#7/#8/#9 — servidor', () => {
  let tmp: string;
  let web: string;
  let dirAnterior: string;
  let server: Server;
  let port: number;
  let gw: OpenRouterGateway;
  const fake = fakeOpenRouter();
  const csvRunId = randomUUID();
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pb-http-hard-'));
    web = path.join(tmp, 'web-dist');
    mkdirSync(path.join(web, 'assets'), { recursive: true });
    writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>SPA</title>');
    writeFileSync(path.join(web, 'assets', 'app-123.js'), 'console.log(1)');
    dirAnterior = getDataDir();
    setDataDir(path.join(tmp, 'data'));
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    gw = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    await saveRun(runComTextoHostil(csvRunId));
    server = await startServer({ port: 0, webDist: web, agentsEnabled: false });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    setDefaultGateway(gw);
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- #5
  it.each([
    ['número', 123],
    ['array', ['a', 'b']],
    ['objeto', { k: 'v' }],
    ['booleano', true],
    ['string só de espaços', '   '],
  ])('#5 POST /validate-key com body.apiKey %s → 400 "Key ausente." (nunca 500), sem chamar o OpenRouter', async (_n, apiKey) => {
    const antes = fake.requests.length;
    const r = await req(port, '/v1/benchmark/validate-key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ ok: false, error: 'Key ausente.' });
    expect(fake.requests.length).toBe(antes);
  });

  it('#5 body.apiKey string válida ainda é aceita (e aparada)', async () => {
    const r = await req(port, '/v1/benchmark/validate-key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: `  ${KEY}  ` }),
    });
    expect(r.status).toBe(200);
    expect(fake.requests.at(-1)?.headers.Authorization ?? fake.requests.at(-1)?.headers.authorization).toBe(
      `Bearer ${KEY}`,
    );
  });

  // ---------------------------------------------------------------- #4 (HTTP)
  it('#4 as dicas de rota dos 400 chegam inteiras ao cliente', async () => {
    const treinoEmRuns = await req(port, '/v1/benchmark/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openrouter-key': KEY },
      body: JSON.stringify({
        mode: 'training',
        theme: 't',
        stages: 2,
        datagenModelId: 'a/gen',
        judgeModelIds: ['a/judge'],
        referenceModelId: 'a/ref',
        contestantModelId: 'a/x',
        basePrompt: 'Voce e um atendente.',
        techniqueIds: ['persona'],
        iterations: 2,
      }),
    });
    expect(treinoEmRuns.status).toBe(400);
    expect(JSON.parse(treinoEmRuns.body).error).toContain('POST /v1/benchmark/sessions');

    const compareEmSessions = await req(port, '/v1/benchmark/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openrouter-key': KEY },
      body: JSON.stringify({
        mode: 'compare',
        theme: 't',
        stages: 1,
        datagenModelId: 'a/gen',
        judgeModelIds: ['a/judge'],
        competitorModelIds: ['a/x', 'a/y'],
      }),
    });
    expect(compareEmSessions.status).toBe(400);
    const erro = JSON.parse(compareEmSessions.body).error as string;
    expect(erro).toContain('POST /v1/benchmark/sessions');
    expect(erro).not.toContain('<caminho>');
  });

  // ---------------------------------------------------------------- #6
  it.each([
    ['GET rota inexistente', 'GET', '/v1/nope'],
    ['GET sub-rota inexistente', 'GET', '/v1/benchmark/estimate'],
    ['método errado numa rota que existe', 'DELETE', `/v1/benchmark/runs/${randomUUID()}`],
    ['/v1/agents com o modo agente DESLIGADO', 'GET', '/v1/agents/doctor'],
    ['/v1 puro', 'GET', '/v1'],
  ])('#6 %s → 404 JSON {error} (nunca o HTML do Express)', async (_n, method, rota) => {
    const r = await req(port, rota, { method });
    expect(r.status).toBe(404);
    expect(r.headers['content-type']).toMatch(/^application\/json/u);
    expect(JSON.parse(r.body)).toEqual({ error: 'Rota não encontrada.' });
  });

  // ---------------------------------------------------------------- #7
  it('#7 o SPA leva os MESMOS headers de segurança do vercel.json (inclusive o 400 do hostGuard)', async () => {
    const esperado = vercelHeaders();
    expect(esperado.length).toBeGreaterThan(0);
    const respostas = [
      await req(port, '/', { headers: { accept: 'text/html' } }),
      await req(port, '/runs/abc', { headers: { accept: 'text/html' } }),
      await req(port, '/assets/app-123.js'),
      await req(port, '/', { headers: { host: 'evil.com' } }), // 400 do hostGuard
    ];
    expect(respostas.at(-1)?.status).toBe(400);
    for (const r of respostas) {
      for (const h of esperado) expect(r.headers[h.key.toLowerCase()], h.key).toBe(h.value);
    }
    const csp = respostas[0].headers['content-security-policy'] as string;
    expect(csp).toContain("frame-ancestors 'none'");
    // o SPA self-host fala com /v1 e /health da mesma origem (http-api#3)
    expect(csp).toMatch(/connect-src 'self'/u);
    expect(respostas[0].headers['x-frame-options']).toBe('DENY');
    expect(respostas[0].headers['x-content-type-options']).toBe('nosniff');
  });

  it('#7 /v1 e /health: mesma lista, CSP só anti-framing (a do SPA quebraria documento com estilo inline)', async () => {
    const esperado = apiSecurityHeaders(vercelHeaders());
    expect(esperado.find((h) => h.key === 'Content-Security-Policy')?.value).toBe(API_CSP);
    const respostas = [
      await req(port, '/health'),
      await req(port, `/v1/benchmark/runs/${csvRunId}`),
      await req(port, `/v1/benchmark/runs/${csvRunId}/export.csv`),
      await req(port, '/v1/nope'),
      await req(port, '/health', { headers: { host: 'evil.com' } }), // 400 do hostGuard
    ];
    for (const r of respostas) {
      for (const h of esperado) expect(r.headers[h.key.toLowerCase()], h.key).toBe(h.value);
      expect(r.headers['content-security-policy']).toBe("frame-ancestors 'none'");
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('#7 sem vercel.json ao lado: cai no mínimo (anti-framing/nosniff), nunca em "nenhum header"', () => {
    const lista = loadSecurityHeaders(path.join(tmp, 'nao-existe', 'vercel.json'));
    expect(lista).toEqual(BASELINE_SECURITY_HEADERS);
    const csp = lista.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(lista.find((h) => h.key === 'X-Frame-Options')?.value).toBe('DENY');
    expect(loadSecurityHeaders()).toEqual(vercelHeaders());
  });

  it('#7 securityHeaders injetável (createApp) substitui a lista do vercel.json', async () => {
    const app = createApp({ webDist: null, securityHeaders: [{ key: 'X-Teste', value: '1' }] });
    const s = await new Promise<Server>((r) => {
      const srv = app.listen(0, '127.0.0.1', () => r(srv));
    });
    try {
      const porta = (s.address() as AddressInfo).port;
      // fora de /v1 (o 400 do hostGuard: o 404 padrão do Express põe a própria CSP)
      const spa = await req(porta, '/qualquer', { headers: { host: 'evil.com' } });
      expect(spa.status).toBe(400);
      expect(spa.headers['x-teste']).toBe('1');
      expect(spa.headers['content-security-policy']).toBeUndefined();
      const api = await req(porta, '/health');
      expect(api.headers['x-teste']).toBe('1');
      expect(api.headers['content-security-policy']).toBe(API_CSP); // anti-framing sempre na API
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  // ---------------------------------------------------------------- #8
  it('#8 asset ausente e arquivo com extensão → 404 (nunca index.html com 200)', async () => {
    for (const rota of ['/assets/nope-123.js', '/assets/sub/x.css', '/favicon.ico', '/robots.txt']) {
      const r = await req(port, rota, { headers: { accept: '*/*' } });
      expect(r.status, rota).toBe(404);
      expect(r.body, rota).not.toContain('<title>SPA</title>');
    }
  });

  it('#8 asset existente é servido; rota do cliente recebe o index.html', async () => {
    const js = await req(port, '/assets/app-123.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/u);
    for (const rota of ['/', '/runs', `/runs/${randomUUID()}`, '/training/abc', '/new']) {
      const r = await req(port, rota, { headers: { accept: 'text/html,application/xhtml+xml' } });
      expect(r.status, rota).toBe(200);
      expect(r.body, rota).toContain('<title>SPA</title>');
    }
    // pedido que não aceita HTML não é navegação
    const api = await req(port, '/runs/abc', { headers: { accept: 'application/json' } });
    expect(api.status).toBe(404);
  });

  // ---------------------------------------------------------------- #9 (HTTP)
  it('#9 export.csv: fórmula neutralizada, CR citado, número negativo intacto', async () => {
    const r = await req(port, `/v1/benchmark/runs/${csvRunId}/export.csv`);
    expect(r.status).toBe(200);
    const linha = r.body.split('\n')[1];
    expect(linha).toContain(`"'=HYPERLINK(""http://evil.example"",""clique"")"`);
    expect(linha).toContain(`'@SUM(1+1)`);
    expect(linha).toContain('"linha 1\rlinha 2"');
    expect(linha).toContain(',-0.5,');
  });
});

describe('http-api#10 — GET /v1/agents/doctor não deixa tmp/doctor-* para trás', () => {
  let tmp: string;
  let dirAnterior: string;
  let server: Server;
  let port: number;
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pb-http-doctor-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    server = await startServer({ port: 0, webDist: null, agentsEnabled: true });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('3 chamadas (sem deep) → nenhum doctor-* em <dataDir>/tmp', async () => {
    // 1ª chamada com token errado só para o arquivo do token nascer
    expect((await req(port, '/v1/agents/doctor', { headers: { 'x-agents-token': 'errado' } })).status).toBe(401);
    const token = readFileSync(path.join(tmp, 'agents-token'), 'utf-8').trim();
    for (let i = 0; i < 3; i++) {
      const r = await req(port, '/v1/agents/doctor', { headers: { 'x-agents-token': token } });
      expect([200, 500]).toContain(r.status); // o resultado depende do pi/git da máquina
    }
    const tmpDir = path.join(tmp, 'tmp');
    const sobras = existsSync(tmpDir) ? readdirSync(tmpDir).filter((n) => n.startsWith('doctor-')) : [];
    expect(sobras).toEqual([]);
  }, 30_000);
});
