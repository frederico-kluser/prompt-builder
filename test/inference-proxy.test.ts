// Testes de CONTRATO do proxy de inferência local (IMPL-037 / R-15 REC-2):
// "rede do sandbox desligada + proxy que detém a key; a key nunca entra no sandbox".
//
// Camadas:
//   1. Puras: allowlist de rotas, token do cliente, reescrita de headers (a key
//      REAL substitui a credencial do cliente), diretório curto do socket,
//      redação por valor exato.
//   2. Proxy real no loopback contra um UPSTREAM FALSO (stream SSE sintético —
//      nunca o OpenRouter): token fictício obrigatório/revogável, a key só na
//      perna externa, pass-through byte a byte do SSE (e sem buffer), recusa de
//      rotas de gerência (`/keys`, `/credits`), aborto propaga ao upstream, 502
//      honesto, log JSONL redigido, ganchos p/ o proxy de custo (IMPL-035),
//      socket Unix 0600 + relay do sandbox, UM proxy por run e a LATÊNCIA
//      adicional (p95 de 100 requisições < 100 ms).
//   3. Executor `pi` e `runAgentStage` sem Docker: a key sai do ambiente do
//      agente, o `models.json` aponta o provider para o proxy, o modo container
//      monta o socket read-only e embrulha o pi no relay (docker FALSO), e um
//      `pi` REAL no host conclui uma tarefa passando SÓ pelo proxy.
//   4. Docker real (só com daemon + imagem do pi já presentes; nunca puxa/builda;
//      `PB_SKIP_DOCKER_TESTS=1` desliga): dentro do sandbox REAL de uma execução,
//      `printenv OPENROUTER_API_KEY` vazio, egress (DNS, IP direto, serviços do
//      host) bloqueado, a tarefa conclui pela rota do proxy com a key injetada
//      só nele (conferido no upstream e no log redigido) e a latência via relay
//      fica < 100 ms p95. (Falha do upstream → erro de INFRA: sandbox-hardening.)

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  acquireRunInferenceProxy,
  ALLOWED_ROUTES,
  clientResponseHeaders,
  clientToken,
  INFERENCE_PROXY_VERSION,
  isAllowedRoute,
  keyFingerprint,
  openRunInferenceProxies,
  pickSocketBaseDir,
  PROXY_HEALTH_PATH,
  PROXY_SOCKET_NAME,
  redactSecrets,
  RELAY_SCRIPT_NAME,
  relaySha256,
  SANDBOX_RELAY_SOURCE,
  startInferenceProxy,
  upstreamRequestHeaders,
  type InferenceProxy,
} from '../src/agent/inferenceProxy.js';
import {
  buildDockerArgv,
  buildSandboxRunArgv,
  CONTAINER_INFERENCE_BASE_URL,
  CONTAINER_PROXY_DIR,
  CONTAINER_PROXY_PORT,
  containerAuditRecord,
  hardeningProfile,
  inferenceProxyMount,
  inferenceRelayCommand,
  inferenceRouteHint,
  parseRouteProbe,
  probeSandboxInferenceRoute,
  resolveContainerNetwork,
  UNSAFE_NETWORK_ENV,
} from '../src/agent/container.js';
import { CLEAN_PATH, piExecutor, writePiInferenceConfig, type PiRunOptions, type PiRunOutcome } from '../src/agent/pi.js';
import type { AgentRunOpts, AgentRunOutcome, InferenceRoute } from '../src/agent/executor.js';
import { runAgentStage, type AgentGateway, type RunAgentStageParams } from '../src/agent/runAgentStage.js';
import { runPreflight } from '../src/agent/doctor.js';
import { createGateway, setDefaultGateway } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { bashThenDone, sseChunks, startFakeUpstream, type FakeUpstream } from './fakeInferenceUpstream.js';

const KEY = 'sk-or-v1-CHAVE-REAL-FALSA-impl037-0123456789abcdef';

// ----------------------------------------------------------------------------
// Infra de teste
// ----------------------------------------------------------------------------

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of closers.reverse()) await c().catch(() => undefined);
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

async function upstream(script?: Parameters<typeof startFakeUpstream>[0]): Promise<FakeUpstream> {
  const up = await startFakeUpstream(script);
  closers.push(() => up.close());
  return up;
}

async function proxyFor(up: FakeUpstream, over: Partial<Parameters<typeof startInferenceProxy>[0]> = {}): Promise<InferenceProxy> {
  const p = await startInferenceProxy({
    apiKey: KEY,
    upstreamBaseUrl: up.baseUrl,
    listen: { tcp: true },
    logFile: path.join(mkTmp('pb037-log-'), 'inference-proxy.jsonl'),
    ...over,
  });
  closers.push(() => p.close());
  return p;
}

interface Resp {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** ms (desde o envio) em que cada chunk chegou. */
  chunkTimes: number[];
}

/** Requisição HTTP crua (TCP ou socket Unix), com os instantes de cada chunk. */
function request(
  target: { url: string } | { socketPath: string; path: string },
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const common = { method: opts.method ?? 'POST', headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) } };
    const req =
      'url' in target
        ? http.request(target.url, common)
        : http.request({ socketPath: target.socketPath, path: target.path, ...common });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      const chunkTimes: number[] = [];
      res.on('data', (c: Buffer) => {
        chunks.push(c);
        chunkTimes.push(performance.now() - t0);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), chunkTimes }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(opts.body ?? (common.method === 'POST' ? JSON.stringify({ model: 'x/y', messages: [{ role: 'user', content: 'oi' }], stream: true }) : undefined));
  });
}

const bearer = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` });
const readLog = (p: InferenceProxy): string => readFileSync(p.logFile as string, 'utf8');
const logEntries = (p: InferenceProxy): Array<Record<string, unknown>> =>
  readLog(p)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

/**
 * Spawn ASSÍNCRONO. ⚠️ Nunca `spawnSync` com o proxy no mesmo processo: ele
 * bloqueia o event loop e o proxy não responde (deadlock até o timeout).
 */
function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 60_000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

// ----------------------------------------------------------------------------
// 1. Puras
// ----------------------------------------------------------------------------

describe('proxy de inferência — regras puras', () => {
  it('allowlist: só rotas de INFERÊNCIA; gerência da conta (keys/credits/key/auth) fica de fora', () => {
    expect(isAllowedRoute('POST', '/chat/completions')).toBe(true);
    expect(isAllowedRoute('post', '/responses')).toBe(true);
    expect(isAllowedRoute('GET', '/models')).toBe(true);
    for (const [m, p] of [
      ['GET', '/keys'],
      ['POST', '/keys'],
      ['GET', '/credits'],
      ['GET', '/key'],
      ['POST', '/auth/keys'],
      ['GET', '/chat/completions'],
      ['DELETE', '/chat/completions'],
      ['POST', '/chat/completions/../keys'],
    ]) {
      expect(isAllowedRoute(m, p), `${m} ${p}`).toBe(false);
    }
    expect(ALLOWED_ROUTES.every((r) => !/key|credit|auth/i.test(r.path))).toBe(true);
  });

  it('token do cliente: Bearer ou x-api-key; ausente = undefined', () => {
    expect(clientToken({ authorization: 'Bearer pbx-abc' })).toBe('pbx-abc');
    expect(clientToken({ authorization: 'bearer   pbx-abc  ' })).toBe('pbx-abc');
    expect(clientToken({ 'x-api-key': 'pbx-def' })).toBe('pbx-def');
    expect(clientToken({ authorization: 'Basic Zm9v' })).toBeUndefined();
    expect(clientToken({})).toBeUndefined();
  });

  it('headers para o upstream: key REAL no lugar da credencial do cliente, sem hop-by-hop, sem compressão', () => {
    const h = upstreamRequestHeaders(
      {
        host: '127.0.0.1:47100',
        authorization: 'Bearer pbx-token-ficticio',
        'x-api-key': 'pbx-token-ficticio',
        cookie: 'a=b',
        connection: 'keep-alive, x-hop',
        'x-hop': '1',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        'accept-encoding': 'gzip, br',
        'content-type': 'application/json',
        'user-agent': 'OpenAI/JS 6.40.0',
        'x-title': 'pi',
      },
      KEY,
      { appUrl: 'https://pb.local', appTitle: 'prompt-builder' },
    );
    expect(h.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(h)).not.toContain('pbx-token-ficticio');
    for (const k of ['host', 'x-api-key', 'cookie', 'connection', 'x-hop', 'keep-alive', 'transfer-encoding']) {
      expect(h[k], k).toBeUndefined();
    }
    expect(h['accept-encoding']).toBe('identity');
    expect(h['content-type']).toBe('application/json');
    expect(h['user-agent']).toBe('OpenAI/JS 6.40.0');
    // Atribuição: só completa o que o cliente não mandou.
    expect(h['x-title']).toBe('pi');
    expect(h['http-referer']).toBe('https://pb.local');
  });

  it('headers para o cliente: sem hop-by-hop e sem set-cookie do upstream', () => {
    const h = clientResponseHeaders({
      'content-type': 'text/event-stream',
      'set-cookie': ['cf=1'],
      connection: 'close',
      'transfer-encoding': 'chunked',
      'x-generation-id': 'gen-1',
    });
    expect(h).toEqual({ 'content-type': 'text/event-stream', 'x-generation-id': 'gen-1' });
  });

  it('socket Unix: base CURTA (sun_path ≤ 100 bytes); TMPDIR longo cai para a próxima candidata', () => {
    const longo = mkTmp(`pb037-${'x'.repeat(90)}-`);
    const curto = mkdtempSync('/tmp/pb037-');
    tmpDirs.push(curto);
    expect(pickSocketBaseDir([longo, curto])).toBe(curto);
    expect(() => pickSocketBaseDir([longo])).toThrow(/curto o bastante/);
    expect(pickSocketBaseDir(['', 'relativo', '/nao/existe/pb037', curto])).toBe(curto);
  });

  it('redação por valor exato (≥ 8 chars) e fingerprint que identifica sem revelar', () => {
    expect(redactSecrets(`a ${KEY} b ${KEY}`, [KEY])).toBe('a <redigido> b <redigido>');
    expect(redactSecrets('curto abc', ['abc'])).toBe('curto abc');
    const fp = keyFingerprint(KEY);
    expect(fp).toBe(`sha256:${createHash('sha256').update(KEY).digest('hex').slice(0, 8)}`);
    expect(fp).not.toContain(KEY.slice(10, 20));
    expect(keyFingerprint('')).toBe('sha256:ausente');
  });

  it('relay: CommonJS sem dependências, nunca escreve no stdout, sha256 estável', () => {
    expect(SANDBOX_RELAY_SOURCE).not.toMatch(/process\.stdout|console\.log/);
    expect(SANDBOX_RELAY_SOURCE).toMatch(/require\('node:net'\)/);
    expect(relaySha256()).toBe(createHash('sha256').update(SANDBOX_RELAY_SOURCE).digest('hex'));
  });
});

// ----------------------------------------------------------------------------
// 2. Proxy real (loopback) × upstream falso
// ----------------------------------------------------------------------------

describe('proxy de inferência — token fictício e key só na perna externa', () => {
  it('sem token, token forjado ou revogado: 401 e NADA chega ao upstream', async () => {
    const up = await upstream();
    const proxy = await proxyFor(up);
    const url = `${proxy.tcpBaseUrl}/chat/completions`;
    expect((await request({ url })).status).toBe(401);
    expect((await request({ url }, { headers: bearer('pbx-forjado-0000000000000000') })).status).toBe(401);
    expect((await request({ url }, { headers: bearer(KEY) })).status).toBe(401); // nem a key real serve de token
    const cred = proxy.issueCredential({ execId: 'e1' });
    cred.revoke();
    const r = await request({ url }, { headers: bearer(cred.token) });
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body).error.type).toBe('invalid_proxy_token');
    expect(up.requests).toHaveLength(0);
    expect(proxy.stats().rejected).toBe(4);
    const auths = logEntries(proxy).filter((e) => e.event === 'exchange').map((e) => e.auth);
    expect(auths).toEqual(['missing', 'invalid', 'invalid', 'revoked']);
  });

  it('token válido: o upstream recebe a key REAL (nunca o token) e o SSE volta byte a byte', async () => {
    const up = await upstream(() => ({ text: 'olá do upstream', cost: 0.04 }));
    const proxy = await proxyFor(up, { appUrl: 'https://pb.local', appTitle: 'prompt-builder' });
    const cred = proxy.issueCredential({ execId: 'e2', contestantId: 'ag' });
    const r = await request({ url: `${proxy.tcpBaseUrl}/chat/completions` }, { headers: { ...bearer(cred.token), 'accept-encoding': 'gzip' } });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/event-stream');
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.body).toBe(sseChunks({ text: 'olá do upstream', cost: 0.04 }).join(''));
    // O último chunk SSE carrega usage.cost (o que o proxy de custo — IMPL-035 — vai ler).
    expect(r.body).toContain('"cost":0.04');
    expect(up.requests).toHaveLength(1);
    const seen = up.requests[0];
    expect(seen.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(seen.headers)).not.toContain(cred.token);
    expect(seen.headers['accept-encoding']).toBe('identity');
    expect(seen.headers['http-referer']).toBe('https://pb.local');
    expect(seen.url).toBe('/api/v1/chat/completions');
    expect(JSON.parse(seen.body).messages[0].content).toBe('oi');
  });

  it('rotas de gerência da conta e fora de /api/v1 são recusadas SEM ir ao upstream; saúde é local', async () => {
    const up = await upstream();
    const proxy = await proxyFor(up);
    const t = proxy.issueCredential().token;
    const base = proxy.tcpBaseUrl as string;
    const root = base.replace('/api/v1', '');
    expect((await request({ url: `${base}/keys` }, { headers: bearer(t) })).status).toBe(403);
    expect((await request({ url: `${base}/credits` }, { method: 'GET', headers: bearer(t) })).status).toBe(403);
    expect((await request({ url: `${base}/key` }, { method: 'GET', headers: bearer(t) })).status).toBe(403);
    expect((await request({ url: `${root}/v1/chat/completions` }, { headers: bearer(t) })).status).toBe(404);
    const health = await request({ url: `${root}${PROXY_HEALTH_PATH}` }, { method: 'GET', headers: bearer(t) });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ ok: true, version: INFERENCE_PROXY_VERSION });
    expect((await request({ url: `${root}${PROXY_HEALTH_PATH}` }, { method: 'GET' })).status).toBe(401);
    // GET /models (público no OpenRouter) passa.
    expect((await request({ url: `${base}/models` }, { method: 'GET', headers: bearer(t) })).status).toBe(200);
    expect(up.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /api/v1/models']);
  });

  it('streaming SEM buffer: o 1º chunk chega ao cliente antes de o upstream terminar', async () => {
    const chunks = Array.from({ length: 6 }, (_, i) => `data: {"i":${i}}\n\n`);
    const up = await upstream(() => ({ rawChunks: chunks, gapMs: 120 }));
    const proxy = await proxyFor(up);
    const r = await request({ url: `${proxy.tcpBaseUrl}/chat/completions` }, { headers: bearer(proxy.issueCredential().token) });
    expect(r.body).toBe(chunks.join(''));
    expect(r.chunkTimes.length).toBeGreaterThanOrEqual(4);
    const primeiro = r.chunkTimes[0];
    const ultimo = r.chunkTimes[r.chunkTimes.length - 1];
    // 6 chunks × 120 ms: com buffer, tudo chegaria junto no fim.
    expect(ultimo - primeiro).toBeGreaterThan(400);
    expect(primeiro).toBeLessThan(ultimo / 2);
  });

  it('cliente aborta no meio do stream → o proxy cancela o upstream e registra `aborted`', async () => {
    const chunks = Array.from({ length: 20 }, (_, i) => `data: {"i":${i}}\n\n`);
    const up = await upstream(() => ({ rawChunks: chunks, gapMs: 100 }));
    const proxy = await proxyFor(up);
    await new Promise<void>((resolve, reject) => {
      const req = http.request(`${proxy.tcpBaseUrl}/chat/completions`, { method: 'POST', headers: bearer(proxy.issueCredential().token) });
      req.on('response', (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => undefined);
      req.end('{}');
      setTimeout(() => reject(new Error('sem 1º chunk')), 5000);
    });
    await vi.waitFor(() => expect(up.aborted()).toBe(1), { timeout: 3000 });
    const ex = logEntries(proxy).find((e) => e.event === 'exchange');
    expect(ex?.aborted).toBe(true);
  });

  it('upstream inalcançável → 502 JSON legível pelo SDK do agente; log sem a key', async () => {
    const port = await freePort(); // ninguém escuta
    const proxy = await startInferenceProxy({
      apiKey: KEY,
      upstreamBaseUrl: `http://127.0.0.1:${port}/api/v1`,
      listen: { tcp: true },
      logFile: path.join(mkTmp('pb037-log-'), 'p.jsonl'),
    });
    closers.push(() => proxy.close());
    const r = await request({ url: `${proxy.tcpBaseUrl}/chat/completions` }, { headers: bearer(proxy.issueCredential().token) });
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body).error).toMatchObject({ code: 502, type: 'upstream_unavailable' });
    expect(proxy.stats().upstreamErrors).toBe(1);
    const ex = logEntries(proxy).find((e) => e.event === 'exchange');
    expect(ex).toMatchObject({ status: 502, upstreamAuth: 'injected' });
    expect(String(ex?.error)).toMatch(/ECONNREFUSED/);
    expect(readLog(proxy)).not.toContain(KEY);
  });

  it('corpo acima do teto → 413 e o upstream não recebe a requisição inteira', async () => {
    const up = await upstream();
    const proxy = await proxyFor(up, { maxRequestBytes: 1024 });
    const r = await request(
      { url: `${proxy.tcpBaseUrl}/chat/completions` },
      { headers: bearer(proxy.issueCredential().token), body: JSON.stringify({ messages: [{ content: 'x'.repeat(50_000) }] }) },
    ).catch((e: Error) => ({ status: -1, body: e.message }) as Resp);
    // O proxy corta a perna externa ao passar do teto; o cliente vê 413 (ou o socket fechado).
    expect([413, -1]).toContain(r.status);
    expect(up.requests.every((q) => q.body.length < 50_000)).toBe(true);
  });
});

describe('proxy de inferência — log redigido (auditoria)', () => {
  it('JSONL 0600: prova a injeção (`upstreamAuth: injected` + fingerprint) sem key, token, headers nem corpo', async () => {
    const up = await upstream(() => ({ text: 'resposta-secreta-do-modelo' }));
    const proxy = await proxyFor(up);
    const cred = proxy.issueCredential({ runId: 'r1', execId: 'e9', contestantId: 'ag', stageIndex: 0, repetition: 0, role: 'agent' });
    await request(
      { url: `${proxy.tcpBaseUrl}/chat/completions` },
      { headers: bearer(cred.token), body: JSON.stringify({ messages: [{ role: 'user', content: 'prompt-com-dado-sensivel' }] }) },
    );
    cred.revoke();
    await proxy.close();
    const text = readLog(proxy);
    expect(statSync(proxy.logFile as string).mode & 0o777).toBe(0o600);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(cred.token);
    expect(text).not.toContain('prompt-com-dado-sensivel');
    expect(text).not.toContain('resposta-secreta-do-modelo');
    expect(text).not.toMatch(/authorization/i);
    const entries = logEntries(proxy);
    expect(entries.map((e) => e.event)).toEqual(['proxy.started', 'credential.issued', 'exchange', 'credential.revoked', 'proxy.closed']);
    expect(entries[0]).toMatchObject({ keyFingerprint: keyFingerprint(KEY), upstream: up.baseUrl, version: INFERENCE_PROXY_VERSION });
    expect(entries[2]).toMatchObject({
      method: 'POST',
      path: '/chat/completions',
      status: 200,
      auth: 'ok',
      upstreamAuth: 'injected',
      label: { execId: 'e9', contestantId: 'ag', role: 'agent' },
    });
    expect(typeof entries[2].ttfbMs).toBe('number');
    expect(typeof entries[2].preForwardMs).toBe('number');
  });
});

describe('proxy de inferência — ganchos para o proxy de custo (IMPL-035)', () => {
  it('beforeForward recusa ANTES do provedor; onResponseChunk vê todos os bytes; onExchangeEnd resume', async () => {
    const up = await upstream(() => ({ text: 'x', cost: 0.04 }));
    let n = 0;
    const bytes: number[] = [];
    const ends: Array<{ status: number; resBytes: number }> = [];
    const proxy = await proxyFor(up, {
      hooks: {
        beforeForward: async (ex) => {
          n++;
          expect(ex.label.execId).toBe('e-gate');
          return n <= 2 ? { allow: true } : { allow: false, status: 429, code: 'budget_exhausted', message: 'orçamento' };
        },
        onResponseChunk: (_ex, c) => bytes.push(c.length),
        onExchangeEnd: (_ex, s) => ends.push({ status: s.status, resBytes: s.resBytes }),
      },
    });
    const t = proxy.issueCredential({ execId: 'e-gate' }).token;
    const url = `${proxy.tcpBaseUrl}/chat/completions`;
    const a = await request({ url }, { headers: bearer(t) });
    await request({ url }, { headers: bearer(t) });
    const c = await request({ url }, { headers: bearer(t) });
    expect(a.status).toBe(200);
    expect(c.status).toBe(429);
    expect(JSON.parse(c.body).error.type).toBe('budget_exhausted');
    expect(up.requests).toHaveLength(2); // a 3ª NÃO foi ao provedor
    expect(bytes.reduce((x, y) => x + y, 0)).toBe(Buffer.byteLength(a.body) * 2);
    expect(ends.map((e) => e.status)).toEqual([200, 200, 429]);
  });

  it('gate que lança = fail-closed (500, nada ao provedor)', async () => {
    const up = await upstream();
    const proxy = await proxyFor(up, { hooks: { beforeForward: () => { throw new Error('ledger fora'); } } });
    const r = await request({ url: `${proxy.tcpBaseUrl}/chat/completions` }, { headers: bearer(proxy.issueCredential().token) });
    expect(r.status).toBe(500);
    expect(up.requests).toHaveLength(0);
  });
});

describe('proxy de inferência — socket Unix + relay do sandbox (no host, sem Docker)', () => {
  it('diretório 0700, socket 0600 e relay 0444; close() remove tudo', async () => {
    const up = await upstream();
    const proxy = await proxyFor(up, { listen: { unix: true } });
    const dir = proxy.socketDir as string;
    expect(Buffer.byteLength(proxy.socketPath as string)).toBeLessThanOrEqual(100);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, PROXY_SOCKET_NAME)).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, RELAY_SCRIPT_NAME)).mode & 0o777).toBe(0o444);
    expect(readFileSync(path.join(dir, RELAY_SCRIPT_NAME), 'utf8')).toBe(SANDBOX_RELAY_SOURCE);
    expect(proxy.tcpBaseUrl).toBeUndefined();
    const r = await request({ socketPath: proxy.socketPath as string, path: '/api/v1/chat/completions' }, { headers: bearer(proxy.issueCredential().token) });
    expect(r.status).toBe(200);
    expect(up.requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
    await proxy.close();
    expect(existsSync(dir)).toBe(false);
  });

  it('relay: 127.0.0.1:<porta> → socket do proxy; stdio do comando passa direto; sai com o código dele', async () => {
    const up = await upstream(() => ({ text: 'via-relay' }));
    const proxy = await proxyFor(up, { listen: { unix: true } });
    const relay = path.join(proxy.socketDir as string, RELAY_SCRIPT_NAME);
    const port = await freePort();
    const token = proxy.issueCredential().token;
    const script =
      `fetch('http://127.0.0.1:${port}/api/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer ${token}'},body:'{}'})` +
      `.then(r=>r.text()).then(t=>{process.stdout.write(t.includes('via-relay')?'PAYLOAD-OK':'PAYLOAD-RUIM');process.exit(7)})`;
    const r = await run(process.execPath, [relay, String(port), proxy.socketPath as string, '--', process.execPath, '-e', script], {
      timeoutMs: 20_000,
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(r.stdout).toBe('PAYLOAD-OK'); // nada do relay no stdout (é payload do agente)
    expect(r.status).toBe(7);
    // Uso errado: 125, mensagem só no stderr.
    const bad = spawnSync(process.execPath, [relay, 'x'], { encoding: 'utf8' });
    expect(bad.status).toBe(125);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toMatch(/uso: relay\.cjs/);
  });
});

describe('proxy de inferência — UM proxy por run', () => {
  it('etapas paralelas da mesma run compartilham o proxy; o último a devolver o fecha', async () => {
    const up = await upstream();
    const base = openRunInferenceProxies();
    const opts = { apiKey: KEY, upstreamBaseUrl: up.baseUrl, listen: { tcp: true } };
    const [a, b] = await Promise.all([acquireRunInferenceProxy('run-A', opts), acquireRunInferenceProxy('run-A', opts)]);
    const c = await acquireRunInferenceProxy('run-B', opts);
    expect(a.proxy).toBe(b.proxy);
    expect(c.proxy).not.toBe(a.proxy);
    expect(openRunInferenceProxies()).toBe(base + 2);
    const t = a.proxy.issueCredential().token;
    await a.release();
    await a.release(); // idempotente
    expect((await request({ url: `${b.proxy.tcpBaseUrl}/chat/completions` }, { headers: bearer(t) })).status).toBe(200);
    await b.release();
    await c.release();
    expect(openRunInferenceProxies()).toBe(base);
    // Fechado: conexão recusada (ou o socket keep-alive do cliente derrubado).
    await expect(request({ url: `${b.proxy.tcpBaseUrl}/chat/completions` }, { headers: bearer(t) })).rejects.toThrow(
      /ECONNREFUSED|socket hang up|ECONNRESET/,
    );
    expect(() => b.proxy.issueCredential()).toThrow(/encerrado/);
  });
});

describe('proxy de inferência — latência adicional < 100 ms p95 (100 requisições)', () => {
  it('TCP (modo host) e relay + socket Unix (modo container, no host): overhead pareado p95 < 100 ms', async () => {
    const up = await upstream(() => ({ text: 'x' }));
    const tcp = await proxyFor(up);
    const unix = await proxyFor(up, { listen: { unix: true } });
    const tTcp = tcp.issueCredential().token;
    const tUnix = unix.issueCredential().token;
    // Relay do sandbox rodando no host, segurando a porta enquanto medimos.
    const port = await freePort();
    const relay = spawn(
      process.execPath,
      [path.join(unix.socketDir as string, RELAY_SCRIPT_NAME), String(port), unix.socketPath as string, '--', process.execPath, '-e', 'setTimeout(()=>{},120000)'],
      { stdio: 'ignore' },
    );
    closers.push(async () => {
      relay.kill('SIGKILL');
    });
    await vi.waitFor(
      async () => {
        await new Promise<void>((resolve, reject) => {
          const s = net.connect(port, '127.0.0.1', () => {
            s.destroy();
            resolve();
          });
          s.on('error', reject);
        });
      },
      { timeout: 10_000, interval: 50 },
    );
    const time = async (url: string, headers: Record<string, string>): Promise<number> => {
      const t0 = performance.now();
      const r = await request({ url }, { headers });
      expect(r.status).toBe(200);
      return performance.now() - t0;
    };
    // Aquecimento (JIT, keep-alive).
    for (let i = 0; i < 5; i++) {
      await time(`${up.baseUrl}/chat/completions`, {});
      await time(`${tcp.tcpBaseUrl}/chat/completions`, bearer(tTcp));
      await time(`http://127.0.0.1:${port}/api/v1/chat/completions`, bearer(tUnix));
    }
    const overTcp: number[] = [];
    const overRelay: number[] = [];
    for (let i = 0; i < 100; i++) {
      const direto = await time(`${up.baseUrl}/chat/completions`, {});
      overTcp.push((await time(`${tcp.tcpBaseUrl}/chat/completions`, bearer(tTcp))) - direto);
      overRelay.push((await time(`http://127.0.0.1:${port}/api/v1/chat/completions`, bearer(tUnix))) - direto);
    }
    const pTcp = p95(overTcp);
    const pRelay = p95(overRelay);
    // Registro da medição (stderr não é payload).
    console.error(`[IMPL-037] overhead p95 (100 req): tcp=${pTcp.toFixed(2)} ms · relay+unix=${pRelay.toFixed(2)} ms`);
    expect(pTcp).toBeLessThan(100);
    expect(pRelay).toBeLessThan(100);
  }, 60_000);
});

// ----------------------------------------------------------------------------
// 3. Executor `pi` e `runAgentStage` (sem Docker)
// ----------------------------------------------------------------------------

/** `piExecutor.run` com o 2º argumento (opções internas). */
const runPi = (opts: AgentRunOpts, base?: PiRunOptions): Promise<PiRunOutcome> =>
  (piExecutor.run as (o: AgentRunOpts, b?: PiRunOptions) => Promise<AgentRunOutcome>).call(piExecutor, opts, base) as Promise<PiRunOutcome>;

function runOpts(over: Partial<AgentRunOpts> & { env: Record<string, string> }): AgentRunOpts {
  const base = mkTmp('pb037-run-');
  const workspaceDir = path.join(base, 'ws');
  const workDir = path.join(base, 'exec');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  return {
    execId: `t${Date.now()}${Math.floor(Math.random() * 1e6)}`,
    task: {},
    config: { executor: 'pi', executorVersion: '0.84.2' },
    workspaceDir,
    workDir,
    bin: 'pi',
    ...over,
  } as AgentRunOpts;
}

/** "pi" falso: despeja o próprio env e o models.json em `$PB_DUMP` e encerra. */
function dumpingPi(): { bin: string; dump: string } {
  const dir = mkTmp('pb037-fakepi-');
  const dump = path.join(dir, 'dump');
  mkdirSync(dump);
  const bin = path.join(dir, 'pi');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'cat >/dev/null',
      'env > "$PB_DUMP/env.txt"',
      'cat "$PI_CODING_AGENT_DIR/models.json" > "$PB_DUMP/models.json" 2>/dev/null',
      `printf '%s\\n' '{"type":"agent_settled"}'`,
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(bin, 0o755);
  return { bin, dump };
}

describe('executor pi — a key nunca chega ao agente (modo host)', () => {
  it('com rota: models.json (0600) aponta o provider para o proxy com o token; sem OPENROUTER_API_KEY no env', async () => {
    const { bin, dump } = dumpingPi();
    const route: InferenceRoute = { token: 'pbx-token-de-teste-0123456789', baseUrl: 'http://127.0.0.1:65000/api/v1' };
    const opts = runOpts({
      bin,
      env: { PATH: '/usr/bin:/bin', PB_DUMP: dump, PI_MODEL_ID: 'x/y', PI_TASK: 'oi', OPENROUTER_API_KEY: KEY, PI_CODING_AGENT_DIR: '/nao/usar' },
      inference: route,
    });
    const out = await runPi(opts);
    expect(out.stopReason).toBe('completed');
    const env = readFileSync(path.join(dump, 'env.txt'), 'utf8');
    expect(env).not.toContain(KEY);
    expect(env).not.toMatch(/^OPENROUTER_API_KEY=/m);
    expect(env).not.toContain(route.token); // o token vai no arquivo, não no env
    const agentDir = path.join(opts.workDir, 'pi-home');
    expect(env).toContain(`PI_CODING_AGENT_DIR=${agentDir}`);
    expect(JSON.parse(readFileSync(path.join(dump, 'models.json'), 'utf8'))).toEqual({
      providers: { openrouter: { baseUrl: route.baseUrl, apiKey: route.token } },
    });
    expect(statSync(path.join(agentDir, 'models.json')).mode & 0o777).toBe(0o600);
  });

  it('sem rota mas com a key no env: proxy PRÓPRIO da execução (a key fica no host), fechado ao fim', async () => {
    const { bin, dump } = dumpingPi();
    const opts = runOpts({ bin, env: { PATH: '/usr/bin:/bin', PB_DUMP: dump, PI_MODEL_ID: 'x/y', PI_TASK: 'oi', OPENROUTER_API_KEY: KEY } });
    await runPi(opts);
    const env = readFileSync(path.join(dump, 'env.txt'), 'utf8');
    expect(env).not.toContain(KEY);
    const models = JSON.parse(readFileSync(path.join(dump, 'models.json'), 'utf8'));
    const base: string = models.providers.openrouter.baseUrl;
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/);
    expect(models.providers.openrouter.apiKey).toMatch(/^pbx-[0-9a-f]{48}$/);
    // O proxy próprio morreu com a execução (token inútil depois dela).
    await expect(request({ url: `${base}/chat/completions` }, { headers: bearer(models.providers.openrouter.apiKey) })).rejects.toThrow(
      /ECONNREFUSED/,
    );
    const log = readFileSync(path.join(opts.workDir, 'inference-proxy.jsonl'), 'utf8');
    expect(log).toContain('"event":"proxy.closed"');
    expect(log).not.toContain(KEY);
  });

  it('rota com provider ≠ openrouter é recusada (o proxy só detém a key do OpenRouter)', async () => {
    const { bin, dump } = dumpingPi();
    const opts = runOpts({
      bin,
      env: { PATH: '/usr/bin:/bin', PB_DUMP: dump, PI_MODEL_ID: 'x/y', PI_TASK: 'oi' },
      config: { executor: 'pi', executorVersion: '0.84.2', provider: 'anthropic' },
      inference: { token: 'pbx-token-de-teste-0123456789', baseUrl: 'http://127.0.0.1:65000/api/v1' },
    });
    await expect(runPi(opts)).rejects.toThrow(/só atende o provider "openrouter"/);
  });

  it('writePiInferenceConfig recusa token que o pi INTERPRETARIA ($VAR / !comando)', () => {
    const dir = mkTmp('pb037-cfg-');
    expect(() => writePiInferenceConfig(dir, 'openrouter', 'http://x', '$OPENROUTER_API_KEY')).toThrow(/caractere inválido/);
    expect(() => writePiInferenceConfig(dir, 'openrouter', 'http://x', '!cat /etc/passwd')).toThrow(/caractere inválido/);
    expect(existsSync(path.join(dir, 'models.json'))).toBe(false);
  });
});

/**
 * `docker` falso: registra argv, copia o env-file e o `models.json` da casa do pi
 * montada (copy-in do IMPL-038: o staging some depois do run) e responde como o pi.
 */
function fakeDocker(): { dir: string; log: string; envCopy: string; modelsCopy: string } {
  const dir = mkTmp('pb037-fakedocker-');
  const log = path.join(dir, 'calls.log');
  const envCopy = path.join(dir, 'env-file.copy');
  const modelsCopy = path.join(dir, 'models.json.copy');
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${log}'`,
    'case "$1" in',
    '  info)',
    '    case "$*" in',
    '      *NCPU*) echo 4 ;;',
    `      *Runtimes*) echo '{"runc":{}}' ;;`,
    '    esac ;;',
    '  run)',
    '    prev=""',
    '    for a in "$@"; do',
    `      if [ "$prev" = "--env-file" ]; then cp "$a" '${envCopy}'; fi`,
    '      case "$a" in',
    '        *target=/exec/pi-home*) src="${a#type=bind,source=}"; src="${src%%,target=*}";',
    `          cp "$src/models.json" '${modelsCopy}' 2>/dev/null ;;`,
    // O "agente" escreve na sessão montada: um transcript e um symlink hostil.
    '        *target=/exec/session*) src="${a#type=bind,source=}"; src="${src%%,target=*}";',
    `          printf '%s\\n' '{"type":"session"}' > "$src/2026-09-27_t.jsonl"; ln -s /etc/passwd "$src/zz-evil.jsonl" ;;`,
    '      esac',
    '      prev="$a"',
    '    done',
    '    cat >/dev/null',
    `    printf '%s\\n' '{"type":"agent_settled"}' ;;`,
    'esac',
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(path.join(dir, 'docker'), script, { mode: 0o755 });
  return { dir, log, envCopy, modelsCopy };
}

async function withFakeDocker<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const saved = { path: process.env.PATH, host: process.env.DOCKER_HOST };
  process.env.PATH = `${dir}:${saved.path ?? ''}`;
  process.env.DOCKER_HOST = `unix://${dir}/daemon-falso.sock`;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved.path;
    if (saved.host === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = saved.host;
  }
}

const DIGEST = `sha256:${'b'.repeat(64)}`;

describe('executor pi — modo container: socket read-only + relay, env-file SEM a key', () => {
  it('argv monta o proxy em /exec/proxy (readonly) e o pi vira filho do relay; env-file e argv.json sem a key', async () => {
    const fd = fakeDocker();
    const up = await upstream();
    const proxy = await proxyFor(up, { listen: { unix: true } });
    const cred = proxy.issueCredential({ execId: 'c1' });
    const saved = process.env[UNSAFE_NETWORK_ENV];
    delete process.env[UNSAFE_NETWORK_ENV];
    try {
      await withFakeDocker(fd.dir, async () => {
        const opts = runOpts({
          bin: 'docker',
          config: { executor: 'pi', executorVersion: '0.84.2', isolation: { kind: 'container' } },
          env: { OPENROUTER_API_KEY: KEY, PI_MODEL_ID: 'x/y', PI_TASK: 'oi', PI_CONTAINER_IMAGE: DIGEST },
          inference: proxy.route(cred),
        });
        const out = await runPi(opts);
        expect(out.stopReason).toBe('completed');
        const run = readFileSync(fd.log, 'utf8').split('\n').find((l) => l.startsWith('run ')) as string;
        expect(run).toContain(`--network none`);
        expect(run).toContain(`--mount type=bind,source=${proxy.socketDir},target=${CONTAINER_PROXY_DIR},readonly`);
        expect(run).toContain(
          `${DIGEST} node ${CONTAINER_PROXY_DIR}/relay.cjs ${CONTAINER_PROXY_PORT} ${CONTAINER_PROXY_DIR}/inference.sock -- pi --mode json`,
        );
        expect(run).not.toContain(KEY);
        expect(run).not.toContain(cred.token);
        const envFile = readFileSync(fd.envCopy, 'utf8');
        expect(envFile).not.toContain(KEY);
        expect(envFile).not.toMatch(/^OPENROUTER_API_KEY=/m);
        expect(envFile).not.toContain(cred.token);
        // O pi do container fala com o relay no loopback DELE, com o token no models.json.
        // IMPL-038: a casa do pi é um STAGING fora do dir de execução (copy-in),
        // apagado depois do run — o dir de auditoria não é montado nem em parte.
        expect(JSON.parse(readFileSync(fd.modelsCopy, 'utf8'))).toEqual({
          providers: { openrouter: { baseUrl: CONTAINER_INFERENCE_BASE_URL, apiKey: cred.token } },
        });
        const sources = [...run.matchAll(/type=bind,source=([^,]+),target=(\/[^ ,]+)/g)].map((m) => ({ src: m[1], dst: m[2] }));
        const writable = sources.filter((m) => m.dst === '/exec/pi-home' || m.dst === '/exec/session');
        expect(writable).toHaveLength(2);
        for (const m of writable) {
          expect(path.relative(opts.workDir, m.src).startsWith('..')).toBe(true);
          expect(existsSync(m.src)).toBe(false); // staging apagado
        }
        expect(existsSync(path.join(opts.workDir, 'pi-home'))).toBe(false);
        // copy-out: só o transcript REGULAR volta ao dir de auditoria; o symlink não.
        expect(readFileSync(path.join(opts.workDir, 'session', '2026-09-27_t.jsonl'), 'utf8')).toContain('"session"');
        expect(existsSync(path.join(opts.workDir, 'session', 'zz-evil.jsonl'))).toBe(false);
        expect(out.sessionFile).toBe('2026-09-27_t.jsonl');
        const audit = JSON.parse(readFileSync(path.join(opts.workDir, 'argv.json'), 'utf8'));
        expect(audit.inference).toMatchObject({
          route: 'unix-socket-relay',
          proxyVersion: INFERENCE_PROXY_VERSION,
          containerBaseUrl: CONTAINER_INFERENCE_BASE_URL,
          relaySha256: relaySha256(),
        });
        expect(audit.inference.envKeys).not.toContain('OPENROUTER_API_KEY');
        expect(audit.inference.envKeys).toContain('PI_MODEL');
        expect(audit.hardening.network).toBe('none');
        expect(JSON.stringify(audit)).not.toContain(KEY);
      });
    } finally {
      if (saved !== undefined) process.env[UNSAFE_NETWORK_ENV] = saved;
    }
  });

  it('sem rota e sem key: recusa ANTES de gravar env-file/argv.json (a key não tem como entrar no sandbox)', async () => {
    const fd = fakeDocker();
    await withFakeDocker(fd.dir, async () => {
      const opts = runOpts({
        bin: 'docker',
        config: { executor: 'pi', executorVersion: '0.84.2', isolation: { kind: 'container' } },
        env: { PI_MODEL_ID: 'x/y', PI_TASK: 'oi', PI_CONTAINER_IMAGE: DIGEST },
      });
      await expect(runPi(opts)).rejects.toThrow(/rota de inferência pelo proxy local/);
      expect(existsSync(path.join(opts.workDir, 'argv.json'))).toBe(false);
      expect(existsSync(fd.envCopy)).toBe(false);
    });
  });

  it('buildDockerArgv sem proxy mantém o comando cru (compatível); com proxy, bind read-only + relay', () => {
    const base = mkTmp('pb037-argv-');
    for (const d of ['ws', 'exec', 'sock']) mkdirSync(path.join(base, d));
    const spec = {
      image: DIGEST,
      containerName: 'pb-agent-x',
      envFile: '/tmp/x.env',
      workspaceDir: path.join(base, 'ws'),
      workDir: path.join(base, 'exec'),
      profile: hardeningProfile({ uid: 1000, gid: 1000, hostCpus: 4, env: {} }),
      piArgv: ['--mode', 'json'],
    };
    const cru = buildDockerArgv(spec);
    expect(cru.slice(-3)).toEqual(['pi', '--mode', 'json']);
    const comProxy = buildDockerArgv({ ...spec, inferenceSocketDir: path.join(base, 'sock') });
    const relayCmd = inferenceRelayCommand(['pi', '--mode', 'json']);
    expect(comProxy.slice(-relayCmd.length)).toEqual(relayCmd);
    expect(comProxy[comProxy.length - relayCmd.length - 1]).toBe(DIGEST); // o relay É o comando do container
    expect(comProxy).toContain(`type=bind,source=${path.join(base, 'sock')},target=${CONTAINER_PROXY_DIR},readonly`);
    expect(inferenceProxyMount('/x')).toEqual({ host: '/x', container: CONTAINER_PROXY_DIR, readOnly: true });
    const audit = containerAuditRecord({ imageDigest: DIGEST, profile: spec.profile, argv: ['docker', ...comProxy], inferenceEnvKeys: ['PI_MODEL'] });
    expect(audit.inference?.envKeys).toEqual(['PI_MODEL']);
    expect(containerAuditRecord({ imageDigest: DIGEST, profile: spec.profile, argv: [] }).inference).toBeUndefined();
  });

  it('válvula `bridge`: a key continua fora (o aviso diz o que ela abre de verdade); dica da rota aponta o log', () => {
    const { unsafe } = resolveContainerNetwork({ [UNSAFE_NETWORK_ENV]: 'bridge' });
    expect(unsafe.join(' ')).toMatch(/segue só no proxy de inferência/);
    expect(unsafe.join(' ')).toMatch(/exfiltrar o workspace/);
    expect(inferenceRouteHint('/r/inference-proxy.jsonl')).toContain('/r/inference-proxy.jsonl');
    expect(inferenceRouteHint()).toMatch(/socket Unix/);
  });

  it('parseRouteProbe: relay 200 + sem key + egress bloqueado = ok; qualquer desvio reprova com o motivo', () => {
    const ok = parseRouteProbe(JSON.stringify({ keyInSandbox: false, relayStatus: 200, egress: { dns: 'EAI_AGAIN', tcp: 'ENETUNREACH' } }), 'none');
    expect(ok).toMatchObject({ ok: true, relayStatus: 200, keyInSandbox: false, egressBlocked: true });
    const vazou = parseRouteProbe(JSON.stringify({ keyInSandbox: true, relayStatus: 200, egress: { dns: 'EAI_AGAIN', tcp: 'ENETUNREACH' } }), 'none');
    expect(vazou.ok).toBe(false);
    expect(vazou.errors.join(' ')).toMatch(/OPENROUTER_API_KEY apareceu/);
    const aberta = parseRouteProbe(JSON.stringify({ keyInSandbox: false, relayStatus: 200, egress: { dns: 'resolveu', tcp: 'conectou' } }), 'none');
    expect(aberta.ok).toBe(false);
    expect(aberta.errors.join(' ')).toMatch(/alcançou a rede externa/);
    const semRelay = parseRouteProbe(JSON.stringify({ keyInSandbox: false, relayStatus: 'ECONNREFUSED', egress: { dns: 'EAI_AGAIN', tcp: 'ENETUNREACH' } }), 'none');
    expect(semRelay.ok).toBe(false);
    expect(semRelay.errors.join(' ')).toMatch(/não alcança o proxy/);
    // bridge: egress não é medido (a válvula já é avisada como desvio).
    expect(parseRouteProbe(JSON.stringify({ keyInSandbox: false, relayStatus: 200 }), 'bridge')).toMatchObject({ ok: true, egressBlocked: null });
    expect(parseRouteProbe('lixo', 'none').ok).toBe(false);
  });
});

/** Outcome mínimo de um executor falso. */
function fakeOutcome(modelId: string): PiRunOutcome {
  const now = new Date().toISOString();
  return {
    stopReason: 'completed',
    turns: 1,
    toolCalls: 0,
    durationMs: 5,
    usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
    trajectory: {
      format: 'agent-trajectory@1',
      executor: { id: 'pi-fake', version: '0' },
      model: { provider: 'openrouter', id: modelId },
      startedAt: now,
      finishedAt: now,
      durationMs: 5,
      stopReason: 'completed',
      turns: [],
      usage: { tokensIn: 1, tokensOut: 1, tokensReasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, costSource: 'agent-derived' },
      parseErrors: 0,
      compactions: [],
    },
    parseErrors: 0,
    responseIds: [],
    stderrTail: '',
    exitCode: 0,
    signal: null,
  } as PiRunOutcome;
}

describe('runAgentStage — proxy da run, token por execução e env sem a key', () => {
  it('cada execução recebe rota própria (token revogado ao fim); env sem a key MESMO se o prepare a estampar', async () => {
    const up = await upstream();
    const prev = setDefaultGateway(createGateway({ baseUrl: up.baseUrl }));
    const dataDir = mkTmp('pb037-stage-');
    const anterior = getDataDir();
    setDataDir(dataDir);
    const vistos: Array<{ route?: InferenceRoute; env: Record<string, string>; health: number; model: number }> = [];
    const gateway: AgentGateway = {
      id: 'pi-fake',
      prepare: async () => ({ bin: 'pi-fake', env: { OPENROUTER_API_KEY: KEY, PATH: '/usr/bin:/bin' } }),
      run: async (o) => {
        const route = o.inference;
        const root = (route?.baseUrl as string).replace('/api/v1', '');
        const health = (await request({ url: `${root}${PROXY_HEALTH_PATH}` }, { method: 'GET', headers: bearer(route?.token as string) })).status;
        const model = (await request({ url: `${route?.baseUrl}/chat/completions` }, { headers: bearer(route?.token as string) })).status;
        vistos.push({ route, env: o.env, health, model });
        return fakeOutcome(o.env.PI_MODEL_ID);
      },
    };
    const params = (stageIndex: number): RunAgentStageParams => ({
      runId: 'run-037-stage',
      stageIndex,
      contestant: { id: 'ag', label: 'ag', modelId: 'x/y', runner: 'agent' },
      stage: { question: 'q', productContext: 'c', maxTokens: 10, agentTask: {} },
      agentConfig: { executor: 'pi', executorVersion: '0', repetitions: 2 },
      apiKey: KEY,
      ctx: {},
      dataDir,
      catalog: [],
      judgeModelIds: [],
      gateway,
    });
    try {
      await Promise.all([runAgentStage(params(0)), runAgentStage(params(1))]);
    } finally {
      setDefaultGateway(prev);
      setDataDir(anterior);
    }
    expect(vistos).toHaveLength(4);
    for (const v of vistos) {
      expect(v.env.OPENROUTER_API_KEY).toBeUndefined();
      expect(JSON.stringify(v.env)).not.toContain(KEY);
      expect(v.route?.token).toMatch(/^pbx-/);
      expect(v.health).toBe(200);
      expect(v.model).toBe(200);
    }
    // UM proxy para a run (as 2 etapas paralelas) e um token por execução.
    expect(new Set(vistos.map((v) => v.route?.baseUrl)).size).toBe(1);
    expect(new Set(vistos.map((v) => v.route?.token)).size).toBe(4);
    expect(up.requests.every((r) => r.headers.authorization === `Bearer ${KEY}`)).toBe(true);
    const log = readFileSync(path.join(dataDir, 'agent-runs', 'run-037-stage', 'inference-proxy.jsonl'), 'utf8');
    expect(log).not.toContain(KEY);
    const events = log.trim().split('\n').map((l) => JSON.parse(l).event as string);
    expect(events.filter((e) => e === 'proxy.started')).toHaveLength(1);
    expect(events.filter((e) => e === 'credential.issued')).toHaveLength(4);
    expect(events.filter((e) => e === 'credential.revoked')).toHaveLength(4);
    expect(events[events.length - 1]).toBe('proxy.closed');
    // exec.json da execução: env registrado sem a key (nem redigida — ela não estava lá).
    const execJson = readFileSync(path.join(dataDir, 'agent-runs/run-037-stage/stages/0/ag/0/exec.json'), 'utf8');
    expect(execJson).not.toContain('OPENROUTER_API_KEY');
  });
});

// `pi` REAL no host (sem Docker): o binário da sala limpa, se instalado.
const piOnHost = spawnSync('pi', ['--version'], { encoding: 'utf8', env: { PATH: CLEAN_PATH }, timeout: 20_000 }).status === 0;

describe.runIf(piOnHost)('pi REAL no host — a tarefa conclui passando SÓ pelo proxy', () => {
  it('bash via tool call + oráculo verde; o upstream viu a key real; env do agente e log sem ela', async () => {
    const up = await upstream(bashThenDone('printenv OPENROUTER_API_KEY > key.txt; echo "rc=$?" >> key.txt; echo ok > done.txt'));
    const prev = setDefaultGateway(createGateway({ baseUrl: up.baseUrl }));
    const dataDir = mkTmp('pb037-host-e2e-');
    const anterior = getDataDir();
    setDataDir(dataDir);
    try {
      const res = await runAgentStage({
        runId: 'run-037-host',
        stageIndex: 0,
        contestant: { id: 'ag', label: 'ag', modelId: 'openai/gpt-4o-mini', runner: 'agent' },
        stage: {
          question: 'crie done.txt',
          productContext: 'repo vazio',
          maxTokens: 100,
          agentTask: {
            verify: [
              { cmd: 'test -f done.txt', label: 'done' },
              // printenv sai 1 quando a variável NÃO existe no ambiente do agente.
              { cmd: 'grep -qx "rc=1" key.txt', label: 'sem-key-no-env' },
            ],
          },
        },
        agentConfig: { executor: 'pi', executorVersion: '0.84.2', install: 'system', limits: { maxCostUsd: 0.05, timeoutMs: 120_000 } },
        apiKey: KEY,
        ctx: {},
        dataDir,
        catalog: [],
        judgeModelIds: [],
      });
      const r0 = res.repResults[0];
      expect(r0.stopReason).toBe('completed');
      expect(r0.execution.infraError).toBeUndefined();
      expect(r0.oracle?.score).toBe(1);
      expect(r0.verdict).toBe('resolve');
      expect(up.requests.length).toBeGreaterThanOrEqual(2);
      expect(up.requests.every((q) => q.headers.authorization === `Bearer ${KEY}`)).toBe(true);
      const log = readFileSync(path.join(dataDir, 'agent-runs/run-037-host/inference-proxy.jsonl'), 'utf8');
      expect(log).not.toContain(KEY);
      expect(log).toContain('"upstreamAuth":"injected"');
    } finally {
      setDefaultGateway(prev);
      setDataDir(anterior);
    }
  }, 150_000);
});

// ----------------------------------------------------------------------------
// 4. Docker real (nunca puxa/builda; key FALSA; upstream FALSO no loopback do host)
// ----------------------------------------------------------------------------

const PI_IMAGE = 'prompt-builder-pi:0.84.2';
const dockerReady =
  process.env.PB_SKIP_DOCKER_TESTS !== '1' &&
  spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 15_000 }).status === 0;
const piImageId = dockerReady
  ? (() => {
      const r = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', PI_IMAGE], { encoding: 'utf8', timeout: 15_000 });
      return r.status === 0 ? r.stdout.trim() : null;
    })()
  : null;

/** Roda `fn` com o gateway apontado para o upstream falso e rede `none` garantida. */
async function withUpstreamGateway<T>(up: FakeUpstream, fn: () => Promise<T>): Promise<T> {
  const prev = setDefaultGateway(createGateway({ baseUrl: up.baseUrl }));
  const savedNet = process.env[UNSAFE_NETWORK_ENV];
  delete process.env[UNSAFE_NETWORK_ENV];
  try {
    return await fn();
  } finally {
    setDefaultGateway(prev);
    if (savedNet !== undefined) process.env[UNSAFE_NETWORK_ENV] = savedNet;
  }
}

describe.runIf(dockerReady && piImageId !== null)('Docker real: sandbox sem rede e sem key, inferência só pelo proxy', () => {
  it('sonda do doctor no sandbox endurecido: relay → proxy 200, key ausente, DNS e IP direto bloqueados', async () => {
    const probe = await probeSandboxInferenceRoute({ imageDigest: piImageId as string, profile: hardeningProfile({ env: {} }) });
    expect(probe.errors).toEqual([]);
    expect(probe).toMatchObject({ ok: true, relayStatus: 200, keyInSandbox: false, egressBlocked: true, network: 'none' });
  }, 90_000);

  it('pré-voo `agents doctor --container` passa a rota (antes: "não alcança o provedor") e relata a sonda', async () => {
    const saved = process.env[UNSAFE_NETWORK_ENV];
    delete process.env[UNSAFE_NETWORK_ENV];
    try {
      const r = await runPreflight({
        expectedVersion: '0.84.2',
        runDir: mkTmp('pb037-doctor-'),
        apiKey: '', // sem canário: nada é cobrado
        model: 'x/y',
        isolation: { kind: 'container', image: PI_IMAGE },
      });
      expect(r.errors.join(' ')).not.toMatch(/não alcança o provedor|rota de inferência do sandbox reprovada/);
      expect(r.inferenceRoute).toMatchObject({ ok: true, keyInSandbox: false, egressBlocked: true });
    } finally {
      if (saved !== undefined) process.env[UNSAFE_NETWORK_ENV] = saved;
    }
  }, 120_000);

  it(
    'execução REAL: dentro do sandbox do agente `printenv OPENROUTER_API_KEY` é vazio, a rede externa e o host são inalcançáveis, e a tarefa conclui pelo proxy com a key injetada só nele',
    async () => {
      // O comando do agente cita a porta do upstream falso (que só existe depois
      // de subir): o roteiro lê `comando` na hora da chamada.
      let comando = '';
      const up = await upstream((req, n) => bashThenDone(comando)(req, n));
      comando = [
        'printenv OPENROUTER_API_KEY > key.txt; echo "rc=$?" >> key.txt; printf "rc=1\\n" > esperado.txt',
        // "curl a qualquer host fora do proxy falha" (a imagem não tem curl: node faz o papel).
        `node -e "require('dns').lookup('openrouter.ai',(e)=>require('fs').writeFileSync('dns.txt',e?'bloqueado:'+e.code:'ABERTO'))"`,
        `node -e "const s=require('net').connect(443,'1.1.1.1');s.on('connect',()=>{require('fs').writeFileSync('ip.txt','ABERTO');process.exit()});s.on('error',(e)=>require('fs').writeFileSync('ip.txt','bloqueado:'+e.code))"`,
        // O upstream falso escuta no loopback do HOST; do sandbox, 127.0.0.1 é o loopback DELE.
        `node -e "const s=require('net').connect(${up.port},'127.0.0.1');s.on('connect',()=>{require('fs').writeFileSync('host.txt','ABERTO');process.exit()});s.on('error',(e)=>require('fs').writeFileSync('host.txt','bloqueado:'+e.code))"`,
        'echo ok > done.txt',
      ].join('; ');
      const dataDir = mkTmp('pb037-docker-e2e-');
      const anterior = getDataDir();
      setDataDir(dataDir);
      try {
        const res = await withUpstreamGateway(up, () =>
          runAgentStage({
            runId: 'run-037-docker',
            stageIndex: 0,
            contestant: { id: 'ag', label: 'ag', modelId: 'openai/gpt-4o-mini', runner: 'agent' },
            stage: {
              question: 'crie done.txt',
              productContext: 'repo vazio',
              maxTokens: 100,
              agentTask: {
                verify: [
                  { cmd: 'test -f done.txt', label: 'done' },
                  { cmd: 'grep -qx "rc=1" key.txt', label: 'printenv-vazio' },
                  // O arquivo inteiro é só o `rc=1` — nenhum valor de key impresso.
                  { cmd: 'cmp -s key.txt esperado.txt', label: 'sem-valor-de-key' },
                  { cmd: 'grep -q "^bloqueado:" dns.txt', label: 'dns-bloqueado' },
                  { cmd: 'grep -q "^bloqueado:" ip.txt', label: 'ip-bloqueado' },
                  { cmd: 'grep -q "^bloqueado:" host.txt', label: 'host-inalcancavel' },
                ],
              },
            },
            agentConfig: {
              executor: 'pi',
              executorVersion: '0.84.2',
              install: 'system',
              isolation: { kind: 'container' },
              limits: { maxCostUsd: 0.05, timeoutMs: 120_000 },
            },
            apiKey: KEY,
            ctx: {},
            dataDir,
            catalog: [],
            judgeModelIds: [],
          }),
        );
        const r0 = res.repResults[0];
        expect(r0.oracle?.checks?.filter((c) => !c.ok).map((c) => `${c.label}: ${c.tail}`) ?? []).toEqual([]);
        expect(r0.stopReason).toBe('completed');
        expect(r0.oracle?.score).toBe(1);
        expect(r0.verdict).toBe('resolve');
        // A key chegou ao provedor — injetada pelo proxy, nunca pelo sandbox.
        expect(up.requests.filter((q) => q.url === '/api/v1/chat/completions').length).toBeGreaterThanOrEqual(2);
        expect(up.requests.every((q) => q.headers.authorization === `Bearer ${KEY}`)).toBe(true);
        // Log redigido do proxy: injeção provada, key ausente.
        const log = readFileSync(path.join(dataDir, 'agent-runs/run-037-docker/inference-proxy.jsonl'), 'utf8');
        expect(log).not.toContain(KEY);
        const trocas = log
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
          .filter((e) => e.event === 'exchange');
        expect(trocas.length).toBeGreaterThanOrEqual(2);
        expect(trocas.every((e) => e.upstreamAuth === 'injected' && e.status === 200 && e.auth === 'ok')).toBe(true);
        // Nenhum artefato da execução carrega a key.
        const execDir = path.join(dataDir, 'agent-runs/run-037-docker/stages/0/ag/0');
        for (const f of readdirSync(execDir)) {
          const p = path.join(execDir, f);
          if (statSync(p).isFile()) expect(readFileSync(p, 'utf8'), f).not.toContain(KEY);
        }
        const audit = JSON.parse(readFileSync(path.join(execDir, 'argv.json'), 'utf8'));
        expect(audit.hardening.network).toBe('none');
        expect(audit.inference.envKeys).not.toContain('OPENROUTER_API_KEY');
      } finally {
        setDataDir(anterior);
      }
    },
    180_000,
  );

  // Upstream fora do ar (502 do proxy → erro de INFRA, sem veredito) está em
  // test/sandbox-hardening.test.ts ("run REAL em container com --network none").

  it('latência via relay DENTRO do sandbox (--network none): overhead p95 de 100 requisições < 100 ms', async () => {
    const up = await upstream(() => ({ text: 'x' }));
    const proxy = await proxyFor(up, { listen: { unix: true } });
    const token = proxy.issueCredential().token;
    const bench = `
      (async () => {
        const url = 'http://127.0.0.1:${CONTAINER_PROXY_PORT}/api/v1/chat/completions';
        const one = async () => { const t = performance.now(); const r = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ${token}' }, body: '{}' }); await r.text(); if (r.status !== 200) throw new Error('status ' + r.status); return performance.now() - t; };
        for (let i = 0; i < 5; i++) await one();
        const xs = []; for (let i = 0; i < 100; i++) xs.push(await one());
        process.stdout.write(JSON.stringify(xs));
      })().catch((e) => { process.stderr.write(String(e)); process.exit(1); });`;
    const argv = buildSandboxRunArgv({
      image: piImageId as string,
      profile: hardeningProfile({ env: {} }),
      mounts: [inferenceProxyMount(proxy.socketDir as string)],
      workdir: '/tmp',
      command: inferenceRelayCommand(['node', '-e', bench]),
    });
    const r = await run('docker', argv, { timeoutMs: 90_000 });
    expect(r.status, r.stderr).toBe(0);
    const inside: number[] = JSON.parse(r.stdout);
    // Referência: as mesmas 100 requisições direto no upstream, do host.
    const direct: number[] = [];
    for (let i = 0; i < 5; i++) await request({ url: `${up.baseUrl}/chat/completions` });
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      await request({ url: `${up.baseUrl}/chat/completions` });
      direct.push(performance.now() - t0);
    }
    const overhead = p95(inside) - p95(direct);
    console.error(`[IMPL-037] sandbox→relay→proxy p95=${p95(inside).toFixed(2)} ms · direto p95=${p95(direct).toFixed(2)} ms · overhead=${overhead.toFixed(2)} ms`);
    expect(inside).toHaveLength(100);
    expect(overhead).toBeLessThan(100);
  }, 120_000);
});
