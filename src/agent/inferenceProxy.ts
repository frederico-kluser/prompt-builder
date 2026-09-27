// ----------------------------------------------------------------------------
// `inferenceProxy.ts` — o proxy de inferência LOCAL do modo agente (IMPL-037).
//
// POR QUE existe (R-15 DEC-2/REC-2): antes, a key REAL do OpenRouter entrava no
// sandbox (env-file do container / env do pi no host). Com rede plena, um agente
// hostil lia o próprio ambiente e exfiltrava a credencial (defeito B5). Agora:
//
//   agente ──HTTP──▶ base URL LOCAL (loopback) ──▶ ESTE proxy ──HTTPS──▶ OpenRouter
//            token FICTÍCIO                        troca pelo key REAL
//
// - A key real mora SÓ neste processo (o do produto). O agente recebe um token
//   fictício por EXECUÇÃO (`issueCredential`), válido só aqui e revogado no fim
//   da execução — vazá-lo não dá acesso a nada fora da run.
// - Modo container: o sandbox roda com `--network none` e fala com o proxy por
//   um SOCKET UNIX do host montado read-only em `/exec/proxy`; um relay dentro do
//   container (`SANDBOX_RELAY_SOURCE`, o `socat` do arranjo do Claude Code) expõe
//   o socket como `127.0.0.1:<porta>` no loopback do próprio container. Modo
//   host: TCP em `127.0.0.1:<porta efêmera>`.
// - HTTP na fronteira local, HTTPS só na perna externa (sem CA injetada no
//   sandbox — pergunta aberta da R-15 para clientes que exijam TLS ponta a ponta).
// - Pass-through: o corpo (inclusive o stream SSE) é repassado byte a byte, sem
//   buffer. Rotas fora da allowlist de inferência (`/keys`, `/credits`, `/auth`…)
//   são RECUSADAS: o token fictício não pode virar gerência da conta.
// - Log JSONL REDIGIDO (fora de qualquer mount do sandbox): método, rota, status,
//   bytes e tempos — nunca headers/corpos; a key e os tokens nunca aparecem (o
//   `keyFingerprint` = sha256 truncado prova QUAL key foi injetada sem revelá-la).
//
// Ganchos (`hooks`) são o ponto de extensão do proxy de CUSTO (IMPL-035,
// `costProxy.ts`): freio de orçamento ANTES de encaminhar (`beforeForward`),
// leitura do `usage.cost` do último chunk SSE (`onResponseStart`/
// `onResponseChunk`/`onExchangeEnd`, que devolve as anotações de custo gravadas
// na MESMA linha do log) e o limitador local das chamadas do agente. Este módulo
// não conta dinheiro: só roteia, autentica e registra. As chamadas do agente
// continuam fora do limitador AIMD do GATEWAY (têm o seu, no proxy de custo);
// 429 do provedor volta ao agente como veio (o pi tem retry próprio).
//
// ⚠️ Só Node (http/https/fs). Nunca importe do web — o modo agente não existe na SPA.
// ----------------------------------------------------------------------------
import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { InferenceRoute } from './executor.js';

export type { InferenceRoute };

// ----------------------------------------------------------------------------
// Constantes
// ----------------------------------------------------------------------------

/** Versão do protocolo do proxy (entra no `argv.json` e na chave do canário). */
export const INFERENCE_PROXY_VERSION = 1;
/** Prefixo de API exposto ao agente — o mesmo layout do OpenRouter (`/api/v1`). */
export const PROXY_API_PREFIX = '/api/v1';
/** Saúde LOCAL (exige token, nunca vai ao upstream) — usada pela sonda do doctor. */
export const PROXY_HEALTH_PATH = '/__pb/health';
/** Nome do socket Unix dentro do diretório do proxy. */
export const PROXY_SOCKET_NAME = 'inference.sock';
/** Nome do script do relay (lado de dentro do sandbox) no diretório do proxy. */
export const RELAY_SCRIPT_NAME = 'relay.cjs';
/** Prefixo dos tokens fictícios (só `[A-Za-z0-9-]`: o pi não interpola). */
export const PROXY_TOKEN_PREFIX = 'pbx-';
/** Teto do corpo de uma requisição do agente (contexto grande + imagens). */
export const PROXY_MAX_REQUEST_BYTES = 64 * 1024 * 1024;
/**
 * Ociosidade máxima do socket com o upstream. Longa DE PROPÓSITO: modelos de
 * raciocínio ficam minutos sem emitir o 1º byte; quem limita a execução é a
 * parede de tempo do `spawnAgent`, não o proxy.
 */
export const PROXY_UPSTREAM_IDLE_MS = 15 * 60_000;
/**
 * `sun_path` tem 108 bytes no Linux e 104 no macOS: um socket em
 * `$TMPDIR` longo (ex.: `/var/tmp/user-1000/claude-1000/...`) não abre. Margem.
 */
export const SOCKET_PATH_MAX_BYTES = 100;

/**
 * Rotas de INFERÊNCIA que o agente pode usar (relativas a `/api/v1`). Tudo o mais
 * é 403: com a key real do outro lado, `/keys` criaria chaves, `/credits` e
 * `/key` exporiam a conta. `GET /models` é público no OpenRouter.
 */
export const ALLOWED_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'POST', path: '/chat/completions' },
  { method: 'POST', path: '/completions' },
  { method: 'POST', path: '/responses' },
  { method: 'POST', path: '/messages' },
  { method: 'GET', path: '/models' },
];

/** Headers hop-by-hop (RFC 9110 §7.6.1) + os que o proxy reescreve. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
/** Credenciais do cliente que NUNCA seguem para o upstream (a key real as substitui). */
const CLIENT_CREDENTIAL_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'api-key']);

const REDACTED = '<redigido>';

// ----------------------------------------------------------------------------
// Tipos
// ----------------------------------------------------------------------------

/** Quem é a chamada — mapeamento conhecido SÓ do produto (o agente não o forja). */
export interface InferenceCredentialLabel {
  execId?: string;
  runId?: string;
  stageIndex?: number;
  contestantId?: string;
  repetition?: number;
  role?: string;
}

/** Token fictício emitido para UMA execução. */
export interface InferenceCredential {
  readonly token: string;
  readonly label: InferenceCredentialLabel;
  /** Invalida o token (idempotente). Chamadas seguintes com ele → 401. */
  revoke(): void;
}

/** Uma troca em andamento, vista pelos ganchos. */
export interface InferenceExchange {
  id: number;
  method: string;
  /** Rota relativa a `/api/v1` (ex.: `/chat/completions`). */
  path: string;
  label: InferenceCredentialLabel;
  /** `performance.now()` da chegada da requisição. */
  startedAt: number;
  /**
   * `content-length` da requisição (bytes), quando o cliente o mandou. O proxy de
   * custo estima o prompt por ele SEM ler o corpo (o corpo segue em streaming,
   * sem buffer, para o upstream).
   */
  contentLength?: number;
}

/** Decisão do gate (`beforeForward`) — IMPL-035 recusa com 429 `budget_exhausted`. */
export type InferenceGateDecision =
  | { allow: true }
  | {
      allow: false;
      status: number;
      code: string;
      message: string;
      /** Detalhes legíveis pelo agente, no `error.metadata` (formato do OpenRouter). */
      metadata?: Record<string, unknown>;
    };

/** Resumo de uma troca encerrada (o que vai ao log, sem conteúdo). */
export interface InferenceExchangeSummary {
  status: number;
  reqBytes: number;
  resBytes: number;
  /** chegada → headers do upstream. */
  ttfbMs?: number;
  /** chegada → fim da resposta ao cliente. */
  totalMs: number;
  /** chegada → requisição despachada ao upstream (custo do próprio proxy + gate). */
  preForwardMs?: number;
  /** O cliente abortou no meio (o upstream foi cancelado). */
  aborted?: boolean;
  error?: string;
}

export interface InferenceProxyHooks {
  /** Antes de encaminhar. Recusa → a chamada NÃO chega ao provedor. */
  beforeForward?(ex: InferenceExchange): InferenceGateDecision | void | Promise<InferenceGateDecision | void>;
  /** Headers do upstream chegaram (status + headers, antes do 1º byte do corpo). */
  onResponseStart?(ex: InferenceExchange, status: number, headers: IncomingHttpHeaders): void;
  /** Cada chunk devolvido ao cliente (o stream SSE, byte a byte). */
  onResponseChunk?(ex: InferenceExchange, chunk: Buffer): void;
  /**
   * Fim da troca (sucesso, erro, aborto ou recusa do gate). Chamado UMA vez por
   * troca, ANTES da linha do log: o que devolver entra NA MESMA linha (ex.: o
   * custo medido) — sem conteúdo, só números/ids (o log continua redigido).
   */
  onExchangeEnd?(ex: InferenceExchange, summary: InferenceExchangeSummary): Record<string, unknown> | void;
}

export interface InferenceProxyOptions {
  /** A key REAL do OpenRouter. Só este processo a conhece. */
  apiKey: string;
  /** Base do upstream (ex.: `https://openrouter.ai/api/v1` — `GatewayConfig.baseUrl`). */
  upstreamBaseUrl: string;
  /** Onde escutar: TCP loopback (modo host) e/ou socket Unix (modo container). */
  listen: { tcp?: boolean; unix?: boolean };
  /** Log JSONL redigido (0600). Ausente = sem log em disco. */
  logFile?: string;
  /** Headers de atribuição (só quando o cliente não mandou os dele). */
  appUrl?: string;
  appTitle?: string;
  hooks?: InferenceProxyHooks;
  /** Teto do corpo da requisição (default `PROXY_MAX_REQUEST_BYTES`). */
  maxRequestBytes?: number;
  /** Ociosidade máxima com o upstream (default `PROXY_UPSTREAM_IDLE_MS`). */
  upstreamIdleMs?: number;
  /** Candidatos à base do diretório do socket (teste). Default: XDG_RUNTIME_DIR, tmpdir, /tmp. */
  socketBaseDirs?: string[];
  /** Metadados extras da linha `proxy.started` do log (ex.: versão do proxy de custo). */
  logMeta?: Record<string, unknown>;
}

export interface InferenceProxyStats {
  exchanges: number;
  forwarded: number;
  rejected: number;
  upstreamErrors: number;
}

export interface InferenceProxy {
  /** Base URL TCP no loopback do host (quando `listen.tcp`). */
  readonly tcpBaseUrl?: string;
  /** Diretório 0700 com `inference.sock` + `relay.cjs` (quando `listen.unix`). */
  readonly socketDir?: string;
  readonly socketPath?: string;
  readonly upstreamBaseUrl: string;
  /** `sha256:<8 hex>` da key real — identifica sem revelar. */
  readonly keyFingerprint: string;
  readonly logFile?: string;
  issueCredential(label?: InferenceCredentialLabel): InferenceCredential;
  /** A rota para o executor, com o token da credencial. */
  route(cred: InferenceCredential): InferenceRoute;
  stats(): InferenceProxyStats;
  close(): Promise<void>;
}

// ----------------------------------------------------------------------------
// Helpers puros
// ----------------------------------------------------------------------------

/** `sha256:<8 hex>` de um segredo (vazio → `null`). Prova de identidade sem revelar. */
export function keyFingerprint(secret: string): string {
  if (!secret) return 'sha256:ausente';
  return `sha256:${createHash('sha256').update(secret).digest('hex').slice(0, 8)}`;
}

/** Normaliza a base do upstream: sem barra final, só http/https. */
export function normalizeUpstreamBase(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`upstream do proxy de inferência precisa ser http(s): ${raw}`);
  }
  return url.toString().replace(/\/+$/, '');
}

/** A rota (relativa a `/api/v1`) está na allowlist de inferência? */
export function isAllowedRoute(method: string, subPath: string): boolean {
  return ALLOWED_ROUTES.some((r) => r.method === method.toUpperCase() && r.path === subPath);
}

/**
 * Extrai o token do cliente: `Authorization: Bearer <t>` (OpenAI/OpenRouter) ou
 * `x-api-key: <t>` (clientes estilo Anthropic). `undefined` = sem credencial.
 */
export function clientToken(headers: IncomingHttpHeaders): string | undefined {
  const auth = headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    if (m) return m[1];
  }
  const x = headers['x-api-key'];
  if (typeof x === 'string' && x.trim()) return x.trim();
  return undefined;
}

/**
 * Headers para o upstream: tira hop-by-hop, credenciais do cliente, `host` e
 * os nomeados em `Connection`; injeta a key REAL; pede corpo SEM compressão (o
 * proxy de custo precisa ler o SSE) e só ENTÃO completa a atribuição.
 */
export function upstreamRequestHeaders(
  incoming: IncomingHttpHeaders,
  apiKey: string,
  attribution: { appUrl?: string; appTitle?: string } = {},
): OutgoingHttpHeaders {
  const drop = new Set(HOP_BY_HOP);
  const conn = incoming.connection;
  if (typeof conn === 'string') for (const h of conn.split(',')) drop.add(h.trim().toLowerCase());
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(incoming)) {
    const key = k.toLowerCase();
    if (v === undefined || drop.has(key) || key === 'host' || CLIENT_CREDENTIAL_HEADERS.has(key)) continue;
    if (key === 'accept-encoding') continue;
    out[key] = v;
  }
  out.authorization = `Bearer ${apiKey}`;
  out['accept-encoding'] = 'identity';
  if (attribution.appUrl && out['http-referer'] === undefined) out['http-referer'] = attribution.appUrl;
  if (attribution.appTitle && out['x-title'] === undefined) out['x-title'] = attribution.appTitle;
  return out;
}

/** Headers da resposta para o cliente: sem hop-by-hop e sem `set-cookie`. */
export function clientResponseHeaders(incoming: IncomingHttpHeaders): OutgoingHttpHeaders {
  const drop = new Set(HOP_BY_HOP);
  const conn = incoming.connection;
  if (typeof conn === 'string') for (const h of conn.split(',')) drop.add(h.trim().toLowerCase());
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(incoming)) {
    const key = k.toLowerCase();
    if (v === undefined || drop.has(key) || key === 'set-cookie') continue;
    out[key] = v;
  }
  return out;
}

/**
 * Base do diretório do socket: a 1ª candidata EXISTENTE em que
 * `<base>/pb-proxy-XXXXXX/inference.sock` cabe no `sun_path`. `XDG_RUNTIME_DIR`
 * primeiro (tmpfs 0700 do usuário, feito para sockets), depois `os.tmpdir()`,
 * depois `/tmp`.
 */
export function pickSocketBaseDir(candidates?: string[]): string {
  const list = candidates ?? [process.env.XDG_RUNTIME_DIR ?? '', tmpdir(), '/tmp'];
  for (const base of list) {
    if (!base || !path.isAbsolute(base)) continue;
    try {
      if (!statSync(base).isDirectory()) continue;
    } catch {
      continue;
    }
    const probe = path.join(base, 'pb-proxy-XXXXXX', PROXY_SOCKET_NAME);
    if (Buffer.byteLength(probe) <= SOCKET_PATH_MAX_BYTES) return base;
  }
  throw new Error(
    `proxy de inferência: nenhum diretório curto o bastante para o socket Unix (limite ${SOCKET_PATH_MAX_BYTES} bytes; ` +
      `candidatos: ${list.filter(Boolean).join(', ')}).`,
  );
}

/** Troca por `<redigido>` toda ocorrência de cada segredo (≥ 8 chars) no texto. */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8 && out.includes(s)) out = out.split(s).join(REDACTED);
  }
  return out;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function round1(ms: number): number {
  return Math.round(ms * 10) / 10;
}

// ----------------------------------------------------------------------------
// Relay do lado de DENTRO do sandbox
// ----------------------------------------------------------------------------

/**
 * O relay que roda como PID 1 do container: escuta `127.0.0.1:<porta>` no
 * loopback do PRÓPRIO container (existe mesmo com `--network none`), encaminha
 * cada conexão para o socket Unix do proxy do host e então executa o comando do
 * agente com stdio herdado (o stdin da tarefa e o stdout JSONL passam direto).
 * Sai com o código do filho. Nunca escreve no stdout — é payload do agente.
 * CommonJS puro, zero dependência: roda no `node` de qualquer imagem do pi.
 */
export const SANDBOX_RELAY_SOURCE = `'use strict';
// prompt-builder: relay do proxy de inferência (IMPL-037). Gerado — não editar.
const net = require('node:net');
const { spawn } = require('node:child_process');
const { constants } = require('node:os');
const args = process.argv.slice(2);
if (args.length < 4 || args[2] !== '--') {
  process.stderr.write('pb-relay: uso: relay.cjs <porta> <socket> -- <comando...>\\n');
  process.exit(125);
}
const port = Number(args[0]);
const sock = args[1];
const cmd = args.slice(3);
const server = net.createServer((client) => {
  const upstream = net.connect(sock);
  client.setNoDelay(true);
  const kill = () => { client.destroy(); upstream.destroy(); };
  client.on('error', kill);
  upstream.on('error', kill);
  client.pipe(upstream);
  upstream.pipe(client);
});
server.on('error', (err) => {
  process.stderr.write('pb-relay: ' + err.message + '\\n');
  process.exit(125);
});
server.listen(port, '127.0.0.1', () => {
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(s, () => { try { child.kill(s); } catch (_) { /* já saiu */ } });
  }
  child.on('error', (err) => {
    process.stderr.write('pb-relay: ' + err.message + '\\n');
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    server.close();
    process.exit(code !== null ? code : 128 + ((signal && constants.signals[signal]) || 0));
  });
});
`;

/** sha256 do relay (vai ao `argv.json`: prova QUAL código rodou como PID 1). */
export function relaySha256(): string {
  return sha256Hex(SANDBOX_RELAY_SOURCE);
}

// ----------------------------------------------------------------------------
// O proxy
// ----------------------------------------------------------------------------

/** Log JSONL redigido, append síncrono (linhas pequenas: atômicas em O_APPEND). */
class ProxyLog {
  constructor(
    private readonly file: string | undefined,
    private readonly secrets: () => Iterable<string>,
  ) {
    if (file) {
      mkdirSync(path.dirname(file), { recursive: true });
      if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
      try {
        chmodSync(file, 0o600);
      } catch {
        /* melhor esforço */
      }
    }
  }
  write(entry: Record<string, unknown>): void {
    if (!this.file) return;
    try {
      const line = redactSecrets(JSON.stringify({ ts: new Date().toISOString(), ...entry }), this.secrets());
      appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
    } catch {
      /* log é auditoria melhor-esforço: nunca derruba uma chamada do agente */
    }
  }
}

interface CredState {
  label: InferenceCredentialLabel;
  revoked: boolean;
}

type AuthOutcome =
  | { status: 'ok'; cred: CredState }
  | { status: 'missing' | 'invalid' | 'revoked' };

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Erro no formato do OpenRouter (`{ error: { code, message } }`) — o SDK do agente o entende. */
function errorBody(status: number, code: string, message: string, metadata?: Record<string, unknown>): unknown {
  return { error: { code: status, type: code, message, ...(metadata ? { metadata } : {}) } };
}

function parseContentLength(raw: string | string[] | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Sobe o proxy. Escuta onde `opts.listen` pede e devolve o handle. `close()`
 * derruba os servidores, as conexões abertas e remove o diretório do socket.
 */
export async function startInferenceProxy(opts: InferenceProxyOptions): Promise<InferenceProxy> {
  if (!opts.listen.tcp && !opts.listen.unix) {
    throw new Error('proxy de inferência: escolha ao menos um meio (tcp e/ou unix).');
  }
  const upstreamBase = normalizeUpstreamBase(opts.upstreamBaseUrl);
  const upstreamUrl = new URL(upstreamBase);
  const upstreamIsHttps = upstreamUrl.protocol === 'https:';
  const maxRequestBytes = opts.maxRequestBytes ?? PROXY_MAX_REQUEST_BYTES;
  const idleMs = opts.upstreamIdleMs ?? PROXY_UPSTREAM_IDLE_MS;
  const apiKey = opts.apiKey;
  const fingerprint = keyFingerprint(apiKey);

  const creds = new Map<string, CredState>(); // sha256(token) → estado
  const issuedTokens: string[] = [];
  const secrets = (): Iterable<string> => [apiKey, ...issuedTokens];
  const log = new ProxyLog(opts.logFile, secrets);
  const stats: InferenceProxyStats = { exchanges: 0, forwarded: 0, rejected: 0, upstreamErrors: 0 };
  const agent = upstreamIsHttps
    ? new https.Agent({ keepAlive: true, maxSockets: 256 })
    : new http.Agent({ keepAlive: true, maxSockets: 256 });
  const openSockets = new Set<Socket>();
  const inflight = new Set<http.ClientRequest>();
  let seq = 0;

  const authenticate = (req: IncomingMessage): AuthOutcome => {
    const token = clientToken(req.headers);
    if (!token) return { status: 'missing' };
    const cred = creds.get(sha256Hex(token));
    if (!cred) return { status: 'invalid' };
    if (cred.revoked) return { status: 'revoked' };
    return { status: 'ok', cred };
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const startedAt = performance.now();
    const id = ++seq;
    stats.exchanges++;
    const method = (req.method ?? 'GET').toUpperCase();
    let pathname = '/';
    let search = '';
    try {
      const u = new URL(req.url ?? '/', 'http://proxy.local');
      pathname = u.pathname;
      search = u.search;
    } catch {
      /* URL ilegível → cai no 404 abaixo */
    }
    const auth = authenticate(req);
    const label = auth.status === 'ok' ? auth.cred.label : {};
    const subPath = pathname.startsWith(`${PROXY_API_PREFIX}/`) ? pathname.slice(PROXY_API_PREFIX.length) : pathname;
    const contentLength = parseContentLength(req.headers['content-length']);
    const ex: InferenceExchange = {
      id,
      method,
      path: subPath,
      label,
      startedAt,
      ...(contentLength !== undefined ? { contentLength } : {}),
    };

    const finish = (summary: Omit<InferenceExchangeSummary, 'totalMs'> & { totalMs?: number }, extra: Record<string, unknown> = {}): void => {
      const full: InferenceExchangeSummary = { ...summary, totalMs: round1(summary.totalMs ?? performance.now() - startedAt) };
      // O gancho roda ANTES do log: as anotações dele (custo medido, escopo da
      // recusa) saem na MESMA linha da troca — uma linha = uma chamada auditável.
      let annotations: Record<string, unknown> | void = undefined;
      try {
        annotations = opts.hooks?.onExchangeEnd?.(ex, full);
      } catch {
        /* gancho de observação nunca derruba a resposta */
      }
      log.write({
        event: 'exchange',
        id,
        method,
        path: subPath,
        label,
        auth: auth.status,
        ...extra,
        ...(annotations ?? {}),
        ...full,
      });
    };
    const reject = (status: number, code: string, message: string, metadata?: Record<string, unknown>): void => {
      stats.rejected++;
      req.resume(); // drena o corpo que não vai a lugar nenhum
      sendJson(res, status, errorBody(status, code, message, metadata));
      finish({ status, reqBytes: 0, resBytes: 0 }, { upstreamAuth: null, rejected: code });
    };

    // 1) Credencial: sem token válido não há rota (nem saúde).
    if (auth.status !== 'ok') {
      reject(401, 'invalid_proxy_token', 'proxy de inferência: token ausente, inválido ou revogado');
      return;
    }
    // 2) Saúde local — nunca vai ao upstream.
    if (pathname === PROXY_HEALTH_PATH && method === 'GET') {
      req.resume();
      sendJson(res, 200, { ok: true, proxy: 'prompt-builder-inference', version: INFERENCE_PROXY_VERSION });
      finish({ status: 200, reqBytes: 0, resBytes: 0 }, { upstreamAuth: null, health: true });
      return;
    }
    // 3) Allowlist de inferência.
    if (!pathname.startsWith(`${PROXY_API_PREFIX}/`)) {
      reject(404, 'not_found', `proxy de inferência: rota fora de ${PROXY_API_PREFIX}`);
      return;
    }
    if (!isAllowedRoute(method, subPath)) {
      reject(403, 'forbidden_route', `proxy de inferência: ${method} ${subPath} não é rota de inferência`);
      return;
    }

    // 5) Encaminhamento pass-through (definido antes do gate, que o chama).
    const forward = (): void => {
      const target = `${upstreamBase}${subPath}${search}`;
      const headers = upstreamRequestHeaders(req.headers, apiKey, { appUrl: opts.appUrl, appTitle: opts.appTitle });
      const mod = upstreamIsHttps ? https : http;
      let reqBytes = 0;
      let resBytes = 0;
      let ttfbMs: number | undefined;
      let done = false;
      let tooLarge = false;
      const upReq = mod.request(target, { method, headers, agent });
      inflight.add(upReq);
      const preForwardMs = round1(performance.now() - startedAt);
      stats.forwarded++;
      upReq.on('socket', (s: Socket) => s.setNoDelay(true));
      upReq.setTimeout(idleMs, () => upReq.destroy(new Error(`upstream ocioso por ${idleMs} ms`)));

      const end = (summary: Partial<InferenceExchangeSummary> & { status: number }): void => {
        if (done) return;
        done = true;
        inflight.delete(upReq);
        finish({ reqBytes, resBytes, ttfbMs, preForwardMs, ...summary }, { upstreamAuth: 'injected' });
      };

      upReq.on('response', (up) => {
        ttfbMs = round1(performance.now() - startedAt);
        const status = up.statusCode ?? 502;
        try {
          opts.hooks?.onResponseStart?.(ex, status, up.headers);
        } catch {
          /* observação */
        }
        res.writeHead(status, clientResponseHeaders(up.headers));
        up.on('data', (chunk: Buffer) => {
          resBytes += chunk.length;
          try {
            opts.hooks?.onResponseChunk?.(ex, chunk);
          } catch {
            /* observação */
          }
        });
        up.on('end', () => end({ status }));
        up.on('error', (err) => {
          end({ status, error: err.message });
          res.destroy();
        });
        up.pipe(res);
      });
      upReq.on('error', (err) => {
        if (done) return;
        if (tooLarge) {
          // Fecha a conexão depois do 413: o resto do corpo não é drenado (um
          // cliente não pode empurrar gigabytes para dentro do processo do produto).
          res.setHeader('connection', 'close');
          res.on('finish', () => req.destroy());
          sendJson(res, 413, errorBody(413, 'request_too_large', `proxy de inferência: corpo acima de ${maxRequestBytes} bytes`));
          end({ status: 413, error: 'request_too_large' });
          return;
        }
        stats.upstreamErrors++;
        const message = redactSecrets(err.message, secrets());
        if (!res.headersSent) {
          sendJson(res, 502, errorBody(502, 'upstream_unavailable', `proxy de inferência: upstream indisponível (${message})`));
        } else {
          res.destroy();
        }
        end({ status: res.headersSent ? res.statusCode : 502, error: message });
      });
      // Cliente abortou (agente morto, timeout, cancelamento): cancela o upstream.
      res.on('close', () => {
        if (!res.writableFinished && !done) {
          upReq.destroy();
          end({ status: res.statusCode || 499, aborted: true });
        }
      });

      req.on('data', (chunk: Buffer) => {
        reqBytes += chunk.length;
        if (reqBytes > maxRequestBytes && !tooLarge) {
          tooLarge = true;
          req.unpipe(upReq);
          upReq.destroy(new Error('request_too_large'));
        }
      });
      req.pipe(upReq);
    };

    // 4) Gate (IMPL-035: orçamento/rate limit ANTES de ir ao provedor). Sem gate,
    //    encaminha já (síncrono — nenhum tick extra no caminho quente).
    const gate = opts.hooks?.beforeForward;
    if (!gate) {
      forward();
      return;
    }
    void (async () => {
      let decision: InferenceGateDecision | void;
      try {
        decision = await gate(ex);
      } catch (err) {
        reject(500, 'gate_error', `proxy de inferência: gate falhou (${(err as Error).message})`);
        return;
      }
      if (decision && decision.allow === false) {
        reject(decision.status, decision.code, decision.message, decision.metadata);
        return;
      }
      // O cliente pode ter desistido enquanto o gate pensava: não abre uma
      // chamada (cobrada!) ao provedor para ninguém.
      if (res.destroyed || req.destroyed) {
        finish({ status: 499, reqBytes: 0, resBytes: 0, aborted: true }, { upstreamAuth: null });
        return;
      }
      forward();
    })();
  };

  const servers: http.Server[] = [];
  const makeServer = (): http.Server => {
    const s = http.createServer({ noDelay: true }, handler);
    s.on('connection', (sock: Socket) => {
      openSockets.add(sock);
      sock.on('close', () => openSockets.delete(sock));
    });
    servers.push(s);
    return s;
  };

  let tcpBaseUrl: string | undefined;
  let socketDir: string | undefined;
  let socketPath: string | undefined;
  try {
    if (opts.listen.tcp) {
      const s = makeServer();
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => resolve());
      });
      const addr = s.address();
      if (!addr || typeof addr === 'string') throw new Error('proxy de inferência: porta TCP não resolvida');
      tcpBaseUrl = `http://127.0.0.1:${addr.port}${PROXY_API_PREFIX}`;
    }
    if (opts.listen.unix) {
      // mkdtemp cria 0700: só o usuário do host (= `--user` do container) entra.
      socketDir = mkdtempSync(path.join(pickSocketBaseDir(opts.socketBaseDirs), 'pb-proxy-'));
      chmodSync(socketDir, 0o700);
      writeFileSync(path.join(socketDir, RELAY_SCRIPT_NAME), SANDBOX_RELAY_SOURCE, { mode: 0o444 });
      socketPath = path.join(socketDir, PROXY_SOCKET_NAME);
      const s = makeServer();
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(socketPath, () => resolve());
      });
      chmodSync(socketPath, 0o600);
    }
  } catch (err) {
    for (const s of servers) s.close();
    agent.destroy();
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
    throw err;
  }

  log.write({
    event: 'proxy.started',
    version: INFERENCE_PROXY_VERSION,
    upstream: upstreamBase,
    listen: { tcp: tcpBaseUrl ?? null, unix: socketPath ?? null },
    keyFingerprint: fingerprint,
    ...(opts.logMeta ?? {}),
  });

  let closed = false;
  const proxy: InferenceProxy = {
    tcpBaseUrl,
    socketDir,
    socketPath,
    upstreamBaseUrl: upstreamBase,
    keyFingerprint: fingerprint,
    logFile: opts.logFile,
    issueCredential(label: InferenceCredentialLabel = {}): InferenceCredential {
      if (closed) throw new Error('proxy de inferência encerrado: não emite credenciais');
      const token = `${PROXY_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
      const state: CredState = { label: { ...label }, revoked: false };
      creds.set(sha256Hex(token), state);
      issuedTokens.push(token);
      log.write({ event: 'credential.issued', label: state.label });
      return {
        token,
        label: state.label,
        revoke(): void {
          if (state.revoked) return;
          state.revoked = true;
          log.write({ event: 'credential.revoked', label: state.label });
        },
      };
    },
    route(cred: InferenceCredential): InferenceRoute {
      return {
        token: cred.token,
        ...(tcpBaseUrl ? { baseUrl: tcpBaseUrl } : {}),
        ...(socketDir ? { socketDir } : {}),
        ...(opts.logFile ? { logFile: opts.logFile } : {}),
      };
    },
    stats(): InferenceProxyStats {
      return { ...stats };
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const r of inflight) r.destroy();
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((resolve) => {
              s.close(() => resolve());
              for (const sock of openSockets) sock.destroy();
            }),
        ),
      );
      agent.destroy();
      if (socketDir) rmSync(socketDir, { recursive: true, force: true });
      log.write({ event: 'proxy.closed', ...stats });
    },
  };
  return proxy;
}

// ----------------------------------------------------------------------------
// UM proxy por run (contagem de referências)
// ----------------------------------------------------------------------------

interface RegistryEntry {
  proxy: Promise<InferenceProxy>;
  refs: number;
}
const registry = new Map<string, RegistryEntry>();

/** Um empréstimo do proxy da run: `release()` fecha quando o último sai. */
export interface InferenceProxyLease {
  proxy: InferenceProxy;
  release(): Promise<void>;
}

/**
 * O proxy da RUN (`runId`): as etapas rodam em paralelo e cada `runAgentStage`
 * pega um empréstimo — o primeiro sobe o proxy, o último a devolver o fecha. É
 * o que dá UM ponto por run para o gate de orçamento (IMPL-035) e UM log.
 * As opções do 1º empréstimo valem (a mesma run tem a mesma config).
 */
export async function acquireRunInferenceProxy(runId: string, opts: InferenceProxyOptions): Promise<InferenceProxyLease> {
  const key = `${runId}|tcp=${opts.listen.tcp === true}|unix=${opts.listen.unix === true}`;
  let entry = registry.get(key);
  if (!entry) {
    const created: RegistryEntry = { proxy: startInferenceProxy(opts), refs: 0 };
    registry.set(key, created);
    created.proxy.catch(() => {
      if (registry.get(key) === created) registry.delete(key);
    });
    entry = created;
  }
  entry.refs++;
  const current = entry;
  let proxy: InferenceProxy;
  try {
    proxy = await current.proxy;
  } catch (err) {
    current.refs--;
    throw err;
  }
  let released = false;
  return {
    proxy,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      current.refs--;
      if (current.refs <= 0) {
        if (registry.get(key) === current) registry.delete(key);
        await proxy.close();
      }
    },
  };
}

/** Quantos proxies de run estão abertos (teste/diagnóstico). */
export function openRunInferenceProxies(): number {
  return registry.size;
}
