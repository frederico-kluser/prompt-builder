import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import benchmarkRouter from './routes.js';
import agentRouter from './agentRoutes.js';
import { markOrphansAsAborted, setDataDir } from './storage.js';
import { configureGatewayFromEnv } from './gatewayEnv.js';
import { shutdownControlled } from './httpRunControl.js';
import { isUnsafePathError, publicErrorMessage, redactPaths } from './pathSafety.js';

// Servidor HTTP de dev/self-host (NÃO viaja no pacote: `!dist/server.*`).
//
// Linha de base de segurança (IMPL-024, R-09:REC-10 / DEC-8):
//   * bind 127.0.0.1 por DEFAULT (antes: todas as interfaces);
//   * Host em allowlist (localhost/127.0.0.1/::1 + PB_ALLOWED_HOSTS) — fecha
//     DNS rebinding: uma página de evil.com que resolve para 127.0.0.1 chega
//     aqui com `Host: evil.com` e leva 400;
//   * Origin, quando presente, também na allowlist — CSRF de outra origem = 403;
//   * erro nunca sai com caminho absoluto, e handler async que lança vira 500
//     tratado (o processo continua de pé).
// O `createApp` é exportado para os testes (test/security-baseline.test.ts);
// o `listen` só acontece quando este arquivo é o entrypoint.

/** Hosts sempre aceitos (a superfície é local por desenho). */
export const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1'];

export interface AppOptions {
  /** Monta /v1/agents (PROMPT_BUILDER_AGENTS=1). Default: false. */
  agentsEnabled?: boolean;
  /** Hosts extras além dos locais (ex.: PB_ALLOWED_HOSTS de um self-host atrás de proxy). */
  extraAllowedHosts?: readonly string[];
  /** Pasta do SPA buildado; `null` desliga o static. Default: ../web/dist. */
  webDist?: string | null;
  /**
   * Headers de segurança do SPA. Default: os do vercel.json (`loadSecurityHeaders`).
   * /v1 e /health recebem a mesma lista com a CSP trocada (`apiSecurityHeaders`).
   */
  securityHeaders?: readonly SecurityHeader[];
}

// ---------------------------------------------------------------------------
// Headers de segurança (http-api#7)
// ---------------------------------------------------------------------------

export interface SecurityHeader {
  key: string;
  value: string;
}

/** Raiz do repo: `dist/server.js` e `src/server.ts` ficam UM nível abaixo dela. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Mínimo que vale mesmo sem o vercel.json ao lado (ex.: imagem só com `dist/`
 * e `web/dist/`): anti-framing, nosniff, sem Referer e COOP. Sem `script-src`
 * aqui — uma CSP sem o hash do script de tema bloquearia o próprio SPA.
 */
export const BASELINE_SECURITY_HEADERS: readonly SecurityHeader[] = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

/**
 * Os MESMOS headers que o deploy da Vercel manda (grupo `/(.*)` do
 * vercel.json): o SPA guarda a key do OpenRouter no localStorage, e servido
 * por aqui ele saía sem CSP nem frame-ancestors — qualquer site podia
 * emoldurar `http://localhost:3001` (o Host da moldura É localhost). Lidos do
 * vercel.json, fonte única: o hash `sha256-…` do script de tema da CSP é
 * medido contra o HTML em test/storage-deploy-headers.test.ts e nunca diverge
 * entre os dois deploys. Arquivo ausente/ilegível => BASELINE_SECURITY_HEADERS.
 */
export function loadSecurityHeaders(vercelJsonPath = path.join(REPO_ROOT, 'vercel.json')): SecurityHeader[] {
  try {
    const cfg = JSON.parse(readFileSync(vercelJsonPath, 'utf-8')) as {
      headers?: Array<{ source?: unknown; headers?: unknown }>;
    };
    const grupo = cfg.headers?.find((h) => h.source === '/(.*)');
    const lista = Array.isArray(grupo?.headers)
      ? (grupo.headers as unknown[]).filter(
          (h): h is SecurityHeader =>
            typeof (h as SecurityHeader | null)?.key === 'string' &&
            typeof (h as SecurityHeader | null)?.value === 'string',
        )
      : [];
    if (lista.length > 0) return lista.map(({ key, value }) => ({ key, value }));
  } catch {
    // cai no mínimo abaixo
  }
  return BASELINE_SECURITY_HEADERS.map((h) => ({ ...h }));
}

/** CSP das respostas da API: só anti-framing. */
export const API_CSP = "frame-ancestors 'none'";

/**
 * /v1 e /health servem DADOS (JSON, SSE, CSV) e documentos autocontidos como
 * o relatório `…/sessions/:id/report?format=html` (estilo inline). A CSP do SPA
 * (`style-src 'self'`, `script-src` com o hash do tema) quebraria esse
 * documento; ali vale o resto da lista com a CSP reduzida ao anti-framing.
 */
export function apiSecurityHeaders(list: readonly SecurityHeader[]): SecurityHeader[] {
  return [
    { key: 'Content-Security-Policy', value: API_CSP },
    ...list.filter((h) => h.key.toLowerCase() !== 'content-security-policy'),
  ];
}

const API_PATH = /^\/(?:v1|health)(?:\/|$)/u;

function securityHeaders(spa: readonly SecurityHeader[]) {
  const api = apiSecurityHeaders(spa);
  return (req: Request, res: Response, next: NextFunction): void => {
    for (const h of API_PATH.test(req.path) ? api : spa) res.setHeader(h.key, h.value);
    next();
  };
}

/** `PB_ALLOWED_HOSTS=a.com,b.local` → ['a.com','b.local'] (minúsculo, sem porta). */
export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((h) => hostnameOf(h.trim()))
    .filter((h): h is string => Boolean(h));
}

/**
 * Hostname normalizado de um valor de `Host` (ou de `Origin`, sem o esquema):
 * minúsculo, sem porta, IPv6 sem colchetes. `null` = malformado.
 */
function hostnameOf(value: string): string | null {
  if (!value) return null;
  try {
    const u = new URL(value.includes('://') ? value : `http://${value}`);
    if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '')) return null;
    return u.hostname.replace(/^\[(.*)\]$/u, '$1').toLowerCase();
  } catch {
    return null;
  }
}

function hostGuard(allowed: ReadonlySet<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = hostnameOf(req.headers.host ?? '');
    if (!host || !allowed.has(host)) {
      res.status(400).json({
        error:
          'Host não permitido. Este servidor só atende localhost; para outro nome, ' +
          'liste-o em PB_ALLOWED_HOSTS.',
      });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      // `Origin: null` (iframe sandbox, file://) e origem de outro host = 403.
      const o = origin === 'null' ? null : hostnameOf(origin);
      if (!o || !allowed.has(o)) {
        res.status(403).json({ error: 'Origin não permitida.' });
        return;
      }
    }
    next();
  };
}

/**
 * Rede de segurança para TODO router montado (inclusive /v1/agents): corpo de
 * erro JSON (`{ error }` com status >= 400) sai sem caminho absoluto.
 */
function redactErrorBodies(_req: Request, res: Response, next: NextFunction): void {
  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (
      res.statusCode >= 400 &&
      body !== null &&
      typeof body === 'object' &&
      typeof (body as { error?: unknown }).error === 'string'
    ) {
      const b = body as { error: string };
      return json({ ...b, error: redactPaths(b.error) });
    }
    return json(body);
  }) as Response['json'];
  next();
}

/** Error handler final: nada de stack trace (com caminhos) na resposta. */
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (isUnsafePathError(err)) {
    res.status(400).json({ error: publicErrorMessage(err) });
    return;
  }
  // Erros do body-parser (JSON malformado, corpo grande) trazem status 4xx.
  const status = (err as { status?: unknown; statusCode?: unknown } | null)?.status ??
    (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const type = (err as { type?: unknown }).type;
    res.status(status).json({
      error: type === 'entity.parse.failed' ? 'JSON inválido no corpo da requisição.' : publicErrorMessage(err),
    });
    return;
  }
  console.error('[bench] erro não tratado na rota:', publicErrorMessage(err));
  res.status(500).json({ error: `Falha interna: ${publicErrorMessage(err)}` });
}

export function createApp(opts: AppOptions = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');

  const allowed = new Set<string>([...LOCAL_HOSTS, ...(opts.extraAllowedHosts ?? [])]);
  // Headers de segurança em TODA resposta — inclusive o 400/403 do hostGuard.
  app.use(securityHeaders(opts.securityHeaders ?? loadSecurityHeaders()));
  // Host/Origin ANTES de tudo (inclusive /health e o static do SPA).
  app.use(hostGuard(allowed));
  app.use(redactErrorBodies);
  app.use(express.json({ limit: '16mb' }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'prompt-builder' });
  });

  app.use('/v1/benchmark', benchmarkRouter);

  // Portão do modo agente (§21.5): o router /v1/agents só é montado com o env
  // explícito. AUSENTE => a rota simplesmente NÃO EXISTE (404), nunca "403" —
  // um 403 denunciaria que o endpoint está lá mas está vetado.
  if (opts.agentsEnabled) {
    app.use('/v1/agents', agentRouter);
  }

  // Qualquer /v1/* sem rota (inclusive /v1/agents com o modo agente desligado,
  // e método errado numa rota que existe) responde no contrato JSON {error} —
  // nunca o `<pre>Cannot GET …</pre>` do Express, que quebra o `res.json()` do
  // cliente. Mensagem IDÊNTICA para todo caminho: o /v1/agents desligado não
  // se distingue de uma rota inexistente (§21.5).
  app.use('/v1', (_req, res) => {
    res.status(404).json({ error: 'Rota não encontrada.' });
  });

  // Servir frontend buildado (web/dist) na raiz, se existir.
  const webDist = opts.webDist === undefined ? path.join(REPO_ROOT, 'web', 'dist') : opts.webDist;
  if (webDist) {
    app.use(express.static(webDist));
    // Fallback de SPA só para NAVEGAÇÃO: `/assets/*` e qualquer caminho cujo
    // último segmento tem extensão (`/favicon.ico`, chunk `x-abc123.js` de um
    // build anterior) que o static não achou é 404 — com index.html + 200, o
    // import dinâmico de uma aba aberta falhava com erro de MIME/módulo.
    app.get(/^\/(?!v1(?:\/|$)|health(?:\/|$)).*/, (req, res, next) => {
      if (req.path.startsWith('/assets/') || path.posix.extname(req.path) !== '' || !req.accepts('html')) {
        next();
        return;
      }
      res.sendFile(path.join(webDist, 'index.html'), (err) => {
        if (err) next();
      });
    });
  }

  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Bind
// ---------------------------------------------------------------------------

function hostFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host' && argv[i + 1]) return argv[i + 1];
    if (argv[i]?.startsWith('--host=')) return argv[i].slice('--host='.length);
  }
  return undefined;
}

/**
 * Host de bind pedido. Precedência: `--host`, depois PB_HOST. Sem nada:
 * 127.0.0.1 (IMPL-024 — antes o default era todas as interfaces).
 *
 * `HOST` NÃO entra no bind: é genérico demais — containers, CI e alguns shells
 * exportam `HOST=<hostname>`, e honrá-lo trocaria o bind para o IP da LAN em
 * silêncio (e `http://localhost:3001` deixaria de conectar). Ver
 * `ignoredHostEnv` (aviso) e `requestedBindHosts` (portão do modo agente).
 */
export function resolveBindHost(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return hostFromArgv(argv) || env.PB_HOST || '127.0.0.1';
}

/** `HOST` presente, fora de localhost e diferente do bind efetivo → avisar que foi ignorado. */
export function ignoredHostEnv(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const legado = env.HOST;
  if (!legado || isLocalhostHost(legado)) return undefined;
  return legado === resolveBindHost(argv, env) ? undefined : legado;
}

/**
 * Todo host que alguém PEDIU (`--host`, PB_HOST e o legado HOST). O portão do
 * modo agente recusa subir se QUALQUER um sair de localhost — mantém o
 * comportamento fail-closed de antes, em que HOST=0.0.0.0 também barrava.
 */
export function requestedBindHosts(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [hostFromArgv(argv), env.PB_HOST, env.HOST].filter((h): h is string => typeof h === 'string' && h !== '');
}

export function isLocalhostHost(host: string): boolean {
  if (host === '' || host === '0.0.0.0' || host === '::') return false; // todas as interfaces
  const h = host.toLowerCase().replace(/^\[(.*)\]$/u, '$1').replace(/^::ffff:/u, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

export interface StartOptions extends AppOptions {
  port: number;
  host?: string;
}

/** Sobe o servidor e resolve com o `Server` já ouvindo. */
export function startServer(opts: StartOptions): Promise<Server> {
  const host = opts.host ?? '127.0.0.1';
  const app = createApp(opts);
  return new Promise((resolve, reject) => {
    const server = app.listen(opts.port, host, () => resolve(server));
    server.once('error', reject);
  });
}

async function main(): Promise<void> {
  // `.env` só no entrypoint (import de teste não herda o .env do repo). Como
  // o import dinâmico roda DEPOIS da avaliação de storage.ts, o
  // PROMPT_BUILDER_HOME vindo do .env é reaplicado aqui (antes era lido no topo).
  await import('dotenv/config');
  if (process.env.PROMPT_BUILDER_HOME) setDataDir(process.env.PROMPT_BUILDER_HOME);
  // Gateway de LLM a partir do ambiente (já com o .env carregado acima): o
  // gateway em si não lê o processo (IMPL-021).
  configureGatewayFromEnv();

  const port = Number(process.env.BENCHMARK_PORT ?? 3001);
  const agentsEnabled = process.env.PROMPT_BUILDER_AGENTS === '1';
  const host = resolveBindHost();
  const local = isLocalhostHost(host);

  // Portão do modo agente (§21.5 — NÃO negociável): com /v1/agents montado o
  // processo DEVE ouvir em localhost — o corpo de /v1/agents/runs é execução
  // de código. Bind não-local pedido (inclusive pelo HOST legado) => recusa
  // SUBIR (exit 1).
  const naoLocal = requestedBindHosts().find((h) => !isLocalhostHost(h));
  if (agentsEnabled && naoLocal !== undefined) {
    console.error(
      `[agents] REFUSING TO START: PROMPT_BUILDER_AGENTS=1 e o bind pedido ('${naoLocal}') ` +
        'não é localhost. O router /v1/agents é execução remota de código (§21.5): expô-lo na ' +
        'rede é entregar a máquina. Remova HOST/PB_HOST/--host (ou use 127.0.0.1) para subir.',
    );
    process.exit(1);
  }

  const hostIgnorado = ignoredHostEnv();
  if (hostIgnorado !== undefined) {
    console.warn(
      `[bench] aviso: HOST='${hostIgnorado}' ignorado para o bind (variável genérica demais — ` +
        `containers/CI exportam o hostname). Ouvindo em '${host}'; para outra interface use PB_HOST ou --host.`,
    );
  }

  const extraAllowedHosts = parseAllowedHosts(process.env.PB_ALLOWED_HOSTS);
  if (!local) {
    console.warn(
      `[bench] aviso: bind em '${host}' (fora de localhost) por pedido explícito. A API não tem ` +
        'autenticação própria; o Host continua restrito a localhost' +
        (extraAllowedHosts.length ? ` + ${extraAllowedHosts.join(', ')}` : ' (use PB_ALLOWED_HOSTS)') +
        '.',
    );
  }

  const server = await startServer({ port, host, agentsEnabled, extraAllowedHosts });
  // Porta REAL (BENCHMARK_PORT=0 = efêmera) e o bind efetivo no log: é o que o
  // teste de processo real lê para provar o 127.0.0.1.
  const addr = server.address();
  const realPort = addr && typeof addr === 'object' ? addr.port : port;
  const bound = addr && typeof addr === 'object' ? addr.address : host;
  console.log(`Prompt Builder listening on http://${local ? 'localhost' : host}:${realPort} (bind ${bound})`);
  void markOrphansAsAborted().catch((err) => {
    console.warn('[bench] markOrphansAsAborted failed:', publicErrorMessage(err));
  });
  installGracefulShutdown(server);
}

/** Graça do encerramento: runs abortadas têm até isto para gravar o terminal. */
const SERVER_SHUTDOWN_GRACE_MS = 5_000;

/**
 * SIGTERM/SIGINT (Ctrl-C, `docker stop`, `kill`): antes o processo morria na
 * hora, a run ficava 'running' em disco até o próximo boot e o SSE caía sem
 * evento terminal. Agora toda run/sessão deste servidor é abortada com
 * `RunCancelled` (fecha 'aborted' com o parcial; o SSE recebe run.finished) e
 * o processo sai quando as escritas terminais acabam — teto de
 * SERVER_SHUTDOWN_GRACE_MS. Segundo sinal = saída imediata.
 */
function installGracefulShutdown(server: Server): void {
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      console.error(`[bench] ${signal} de novo — saindo sem esperar.`);
      process.exit(130);
    }
    stopping = true;
    console.error(`[bench] ${signal}: abortando as runs deste servidor e encerrando…`);
    // Para de aceitar conexões; o SSE de cada run fecha sozinho no terminal.
    server.close();
    server.closeIdleConnections?.();
    void shutdownControlled(SERVER_SHUTDOWN_GRACE_MS)
      .then(({ aborted, forced }) => {
        const forcadas = forced.runs.length + forced.sessions.length;
        if (aborted > 0 || forcadas > 0) {
          console.error(
            `[bench] ${aborted} run(s)/sessão(ões) abortada(s)` +
              (forcadas > 0 ? `; ${forcadas} gravada(s) 'aborted' à força (graça esgotada)` : '') +
              '.',
          );
        }
      })
      .catch((err: unknown) => {
        console.error('[bench] falha no encerramento gracioso:', publicErrorMessage(err));
      })
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

/** Entrypoint real (`node dist/server.js` / `tsx src/server.ts`), não import de teste. */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((err) => {
    console.error('[bench] falha ao subir:', publicErrorMessage(err));
    process.exit(1);
  });
}
