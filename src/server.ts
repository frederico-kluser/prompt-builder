import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import benchmarkRouter from './routes.js';
import agentRouter from './agentRoutes.js';
import { markOrphansAsAborted } from './storage.js';
import { configureGatewayFromEnv } from './gatewayEnv.js';

// Gateway de LLM a partir do ambiente (ja com o .env carregado pelo
// `dotenv/config` acima): o gateway em si nao le o processo (IMPL-021).
configureGatewayFromEnv();

const app = express();
const port = Number(process.env.BENCHMARK_PORT ?? 3001);

// Portão do modo agente (§21.5): o router /v1/agents só é montado com o env
// explícito. AUSENTE => a rota simplesmente NÃO EXISTE (404), nunca "403" — um
// 403 denunciaria que o endpoint está lá mas está vetado, o oposto do desejado.
const agentsEnabled = process.env.PROMPT_BUILDER_AGENTS === '1';

app.use(express.json({ limit: '16mb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'prompt-builder' });
});

app.use('/v1/benchmark', benchmarkRouter);

if (agentsEnabled) {
  app.use('/v1/agents', agentRouter);
}

// Servir frontend buildado (web/dist) na raiz, se existir
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDist = path.resolve(__dirname, '..', 'web', 'dist');
app.use(express.static(webDist));

app.get(/^\/(?!v1|health).*/, (_req, res, next) => {
  res.sendFile(path.join(webDist, 'index.html'), (err) => {
    if (err) next();
  });
});

// ---------------------------------------------------------------------------
// Bind do modo agente (§21.5 — portão de segurança, NÃO negociável).
// ---------------------------------------------------------------------------
// Com o router de agentes montado, o processo DEVE ouvir em localhost: expô-lo
// na rede é entregar a máquina (o corpo de /v1/agents/runs é execução de
// código). Se HOST/PB_HOST/--host pedir algo fora de 127.0.0.1/localhost/::1,
// recusamos SUBIR (exit 1) com mensagem clara.
function requestedHost(): string {
  // Precedência: CLI arg `--host`, depois HOST, depois PB_HOST.
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host' && argv[i + 1]) return argv[i + 1];
    if (argv[i]?.startsWith('--host=')) return argv[i].slice('--host='.length);
  }
  return process.env.HOST ?? process.env.PB_HOST ?? '';
}

function isLocalhostHost(host: string): boolean {
  if (host === '' || host === '0.0.0.0') return false; // 0.0.0.0 = todas as interfaces
  const h = host.toLowerCase().replace(/^::ffff:/u, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

const intendedHost = requestedHost();
if (agentsEnabled && !isLocalhostHost(intendedHost)) {
  const who = intendedHost || '(0.0.0.0/todas as interfaces)';
  console.error(
    `[agents] REFUSING TO START: PROMPT_BUILDER_AGENTS=1 e o bind pedido ('${who}') ` +
      'não é localhost. O router /v1/agents é execução remota de código (§21.5): expô-lo na ' +
      'rede é entregar a máquina. Defina HOST=127.0.0.1 (ou remova HOST/PB_HOST) para subir.',
  );
  process.exit(1);
}

function onListen(): void {
  console.log(`Prompt Builder listening on http://localhost:${port}`);
  void markOrphansAsAborted().catch((err) => {
    console.warn('[bench] markOrphansAsAborted failed:', err);
  });
}

if (agentsEnabled) {
  // Bind EXPLÍCITO em 127.0.0.1 — e NUNCA o bind implícito completo.
  app.listen(port, '127.0.0.1', onListen);
} else {
  // Comportamento de hoje (sem o portão): todas as interfaces.
  app.listen(port, onListen);
}
