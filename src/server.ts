import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import benchmarkRouter from './routes.js';
import agentRouter from './agentRoutes.js';
import { markOrphansAsAborted, setDataDir } from './storage.js';
import { configureGatewayFromEnv } from './gatewayEnv.js';
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

  // Servir frontend buildado (web/dist) na raiz, se existir.
  const webDist =
    opts.webDist === undefined
      ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist')
      : opts.webDist;
  if (webDist) {
    app.use(express.static(webDist));
    app.get(/^\/(?!v1|health).*/, (_req, res, next) => {
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

/**
 * Host de bind pedido. Precedência: `--host`, depois HOST, depois PB_HOST.
 * Sem nada: 127.0.0.1 (IMPL-024 — antes o default era todas as interfaces).
 */
export function resolveBindHost(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host' && argv[i + 1]) return argv[i + 1];
    if (argv[i]?.startsWith('--host=')) return argv[i].slice('--host='.length);
  }
  return env.HOST || env.PB_HOST || '127.0.0.1';
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
  // de código. Bind não-local pedido => recusa SUBIR (exit 1).
  if (agentsEnabled && !local) {
    console.error(
      `[agents] REFUSING TO START: PROMPT_BUILDER_AGENTS=1 e o bind pedido ('${host}') ` +
        'não é localhost. O router /v1/agents é execução remota de código (§21.5): expô-lo na ' +
        'rede é entregar a máquina. Defina HOST=127.0.0.1 (ou remova HOST/PB_HOST) para subir.',
    );
    process.exit(1);
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
